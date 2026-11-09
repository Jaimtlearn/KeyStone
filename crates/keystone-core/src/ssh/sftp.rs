//! SFTP file browsing and transfers over an existing connection.

use super::Connection;
use crate::error::{Error, Result};
use chrono::{DateTime, Utc};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<DateTime<Utc>>,
    pub permissions: Option<String>,
}

pub fn perm_string(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    for shift in [6, 3, 0] {
        let b = (mode >> shift) & 7;
        s.push(if b & 4 != 0 { 'r' } else { '-' });
        s.push(if b & 2 != 0 { 'w' } else { '-' });
        s.push(if b & 1 != 0 { 'x' } else { '-' });
    }
    s
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

pub struct Sftp {
    pub session: SftpSession,
    pub conn: Connection,
}

impl Sftp {
    pub async fn open(conn: Connection) -> Result<Self> {
        let ch = conn.target().channel_open_session().await?;
        ch.request_subsystem(true, "sftp").await?;
        let session = SftpSession::new(ch.into_stream()).await?;
        Ok(Sftp { session, conn })
    }

    pub async fn home(&self) -> Result<String> {
        Ok(self.session.canonicalize(".").await?)
    }

    pub async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        let mut out = vec![];
        for e in self.session.read_dir(path).await? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let m = e.metadata();
            let ft = e.file_type();
            out.push(FileEntry {
                path: join(path, &name),
                name,
                is_dir: ft.is_dir(),
                is_symlink: ft.is_symlink(),
                size: m.size.unwrap_or(0),
                modified: m.mtime.and_then(|t| DateTime::from_timestamp(t as i64, 0)),
                permissions: m.permissions.map(perm_string),
            });
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    pub async fn mkdir(&self, path: &str) -> Result<()> {
        Ok(self.session.create_dir(path).await?)
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        Ok(self.session.rename(from, to).await?)
    }

    /// Removes a file, or a directory recursively.
    pub async fn remove(&self, path: &str, is_dir: bool) -> Result<()> {
        if !is_dir {
            return Ok(self.session.remove_file(path).await?);
        }
        if path.trim_end_matches('/').is_empty() {
            return Err(Error::Invalid("refusing to delete /".into()));
        }
        let mut stack = vec![(path.to_owned(), false)];
        while let Some((p, visited)) = stack.pop() {
            if visited {
                self.session.remove_dir(&p).await?;
                continue;
            }
            stack.push((p.clone(), true));
            for e in self.list(&p).await? {
                if e.is_dir && !e.is_symlink {
                    stack.push((e.path, false));
                } else {
                    self.session.remove_file(&e.path).await?;
                }
            }
        }
        Ok(())
    }

    pub async fn download(&self, remote: &str, local: &Path, progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<()> {
        let total = self.session.metadata(remote).await.ok().and_then(|m| m.size);
        let mut src = self.session.open(remote).await?;
        let tmp = local.with_extension("kspart");
        let mut dst = tokio::fs::File::create(&tmp).await?;
        let n = copy_with_progress(&mut src, &mut dst, total, progress).await;
        drop(dst);
        match n {
            Ok(_) => Ok(tokio::fs::rename(&tmp, local).await?),
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    pub async fn upload(&self, local: &Path, remote: &str, progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<()> {
        let total = tokio::fs::metadata(local).await.ok().map(|m| m.len());
        let mut src = tokio::fs::File::open(local).await?;
        let mut dst = self.session.create(remote).await?;
        copy_with_progress(&mut src, &mut dst, total, progress).await?;
        dst.shutdown().await?;
        Ok(())
    }
}

async fn copy_with_progress<R, W>(r: &mut R, w: &mut W, total: Option<u64>, progress: &(dyn Fn(u64, Option<u64>) + Send + Sync)) -> Result<u64>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n]).await?;
        done += n as u64;
        if last.elapsed().as_millis() > 150 {
            progress(done, total);
            last = std::time::Instant::now();
        }
    }
    w.flush().await?;
    progress(done, total);
    Ok(done)
}

/// Local directory listing for the left pane of the file browser.
pub fn local_list(path: &Path) -> Result<Vec<FileEntry>> {
    let mut out = vec![];
    for e in std::fs::read_dir(path)? {
        let e = e?;
        let Ok(meta) = e.metadata() else { continue };
        let ft = e.file_type()?;
        #[cfg(unix)]
        let perms = {
            use std::os::unix::fs::PermissionsExt;
            Some(perm_string(meta.permissions().mode()))
        };
        #[cfg(not(unix))]
        let perms = None;
        out.push(FileEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            is_symlink: ft.is_symlink(),
            size: meta.len(),
            modified: meta.modified().ok().map(DateTime::<Utc>::from),
            permissions: perms,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}
