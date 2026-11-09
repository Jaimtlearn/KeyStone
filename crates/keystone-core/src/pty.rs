//! Local terminal (PTY) sessions: ConPTY on Windows, openpty on Unix.

use crate::error::{Error, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub struct LocalPty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        // Prefer PowerShell 7, then Windows PowerShell.
        if which("pwsh.exe") { "pwsh.exe".into() } else { "powershell.exe".into() }
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[cfg(windows)]
fn which(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
        .unwrap_or(false)
}

impl LocalPty {
    /// Spawns the shell. `on_data` is called from a dedicated reader thread;
    /// `on_exit` once the PTY closes.
    pub fn spawn(
        shell: Option<String>,
        cols: u16,
        rows: u16,
        on_data: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Arc<Self>> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| Error::Invalid(format!("cannot open pty: {e}")))?;
        let shell = shell.filter(|s| !s.trim().is_empty()).unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        let child = pair.slave.spawn_command(cmd).map_err(|e| Error::Invalid(format!("cannot start {shell}: {e}")))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| Error::Invalid(e.to_string()))?;
        let writer = pair.master.take_writer().map_err(|e| Error::Invalid(e.to_string()))?;
        std::thread::Builder::new()
            .name("keystone-pty-reader".into())
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => on_data(buf[..n].to_vec()),
                    }
                }
                on_exit();
            })?;
        Ok(Arc::new(LocalPty { master: Mutex::new(pair.master), writer: Mutex::new(writer), child: Mutex::new(child) }))
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| Error::Invalid(e.to_string()))
    }

    pub fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }
}

impl Drop for LocalPty {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn echo_roundtrip() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let tx = Mutex::new(tx);
        let p = LocalPty::spawn(Some("/bin/sh".into()), 80, 24, Arc::new(move |d| { let _ = tx.lock().unwrap().send(d); }), Arc::new(|| {})).unwrap();
        p.write(b"echo keystone-$((40+2))\n").unwrap();
        let mut acc = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !acc.contains("keystone-42") {
            if let Ok(d) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                acc.push_str(&String::from_utf8_lossy(&d));
            }
        }
        assert!(acc.contains("keystone-42"), "got: {acc}");
        p.resize(100, 30).unwrap();
    }
}
