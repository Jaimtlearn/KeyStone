//! First-hop TCP connection, optionally through a SOCKS5 or HTTP CONNECT proxy.

use crate::error::{Error, Result};
use crate::secret::SecretString;
use crate::store::{Host, ProxyKind};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub async fn connect_tcp(host: &Host, proxy_password: Option<&SecretString>) -> Result<TcpStream> {
    let Some(p) = &host.proxy else {
        let s = TcpStream::connect((host.hostname.as_str(), host.port)).await?;
        s.set_nodelay(true)?;
        return Ok(s);
    };
    let mut s = TcpStream::connect((p.host.as_str(), p.port))
        .await
        .map_err(|e| Error::Ssh(format!("proxy {}:{} unreachable: {e}", p.host, p.port)))?;
    s.set_nodelay(true)?;
    match p.kind {
        ProxyKind::Socks5 => socks5_connect(&mut s, &host.hostname, host.port, p.username.as_deref(), proxy_password).await?,
        ProxyKind::Http => http_connect(&mut s, &host.hostname, host.port, p.username.as_deref(), proxy_password).await?,
    }
    Ok(s)
}

pub async fn socks5_connect(s: &mut TcpStream, host: &str, port: u16, user: Option<&str>, pass: Option<&SecretString>) -> Result<()> {
    let use_auth = user.is_some() && pass.is_some();
    s.write_all(if use_auth { &[5, 2, 0, 2] } else { &[5, 1, 0] }).await?;
    let mut r = [0u8; 2];
    s.read_exact(&mut r).await?;
    match r {
        [5, 0] => {}
        [5, 2] if use_auth => {
            let (u, p) = (user.unwrap().as_bytes(), pass.unwrap().expose().as_bytes());
            if u.len() > 255 || p.len() > 255 {
                return Err(Error::Invalid("proxy credentials too long".into()));
            }
            let mut m = vec![1, u.len() as u8];
            m.extend_from_slice(u);
            m.push(p.len() as u8);
            m.extend_from_slice(p);
            s.write_all(&m).await?;
            zeroize::Zeroize::zeroize(&mut m);
            s.read_exact(&mut r).await?;
            if r[1] != 0 {
                return Err(Error::AuthFailed("SOCKS5 proxy".into()));
            }
        }
        _ => return Err(Error::Ssh("SOCKS5 proxy refused all auth methods".into())),
    }
    if host.len() > 255 {
        return Err(Error::Invalid("hostname too long".into()));
    }
    let mut req = vec![5, 1, 0, 3, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await?;
    if head[1] != 0 {
        return Err(Error::Ssh(format!("SOCKS5 proxy connect failed (code {})", head[1])));
    }
    let skip = match head[3] {
        1 => 4,
        4 => 16,
        3 => s.read_u8().await? as usize,
        _ => return Err(Error::Ssh("SOCKS5: bad reply".into())),
    };
    let mut rest = vec![0u8; skip + 2];
    s.read_exact(&mut rest).await?;
    Ok(())
}

async fn http_connect(s: &mut TcpStream, host: &str, port: u16, user: Option<&str>, pass: Option<&SecretString>) -> Result<()> {
    use base64::Engine;
    let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if let (Some(u), Some(p)) = (user, pass) {
        let token = zeroize::Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(format!("{u}:{}", p.expose())));
        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", token.as_str()));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await?;
    zeroize::Zeroize::zeroize(&mut req);
    // Read headers byte-wise up to the blank line so no SSH bytes are consumed.
    let mut buf = Vec::with_capacity(256);
    while !buf.ends_with(b"\r\n\r\n") {
        if buf.len() > 16 * 1024 {
            return Err(Error::Ssh("HTTP proxy: response too large".into()));
        }
        buf.push(s.read_u8().await?);
    }
    let status = String::from_utf8_lossy(&buf);
    let code = status.split_whitespace().nth(1).unwrap_or("");
    if code != "200" {
        return Err(Error::Ssh(format!("HTTP proxy CONNECT failed: {}", status.lines().next().unwrap_or(""))));
    }
    Ok(())
}
