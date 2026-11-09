use thiserror::Error;

/// Errors surfaced to the UI. Messages must never contain secret material.
#[derive(Debug, Error)]
pub enum Error {
    #[error("vault is locked")]
    VaultLocked,
    #[error("vault does not exist")]
    VaultMissing,
    #[error("vault already exists")]
    VaultExists,
    #[error("incorrect password or corrupted vault")]
    BadPassword,
    #[error("vault file is corrupted or was tampered with")]
    Corrupted,
    #[error("unsupported vault format version {0}")]
    UnsupportedVersion(u32),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("crypto error")]
    Crypto,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("ssh error: {0}")]
    Ssh(String),
    #[error("authentication failed for {0}")]
    AuthFailed(String),
    #[error("host key rejected for {0}")]
    HostKeyRejected(String),
    #[error("timed out: {0}")]
    Timeout(String),
    #[error("sftp error: {0}")]
    Sftp(String),
}

impl From<russh::Error> for Error {
    fn from(e: russh::Error) -> Self {
        Error::Ssh(e.to_string())
    }
}

impl From<russh::keys::Error> for Error {
    fn from(e: russh::keys::Error) -> Self {
        Error::Ssh(format!("key error: {e}"))
    }
}

impl From<russh_sftp::client::error::Error> for Error {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        Error::Sftp(e.to_string())
    }
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
