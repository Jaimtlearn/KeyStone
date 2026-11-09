//! Keystone core: everything security- and network-sensitive lives here, in Rust,
//! with no dependency on the UI toolkit. The Tauri shell is a thin adapter.

pub mod crypto;
pub mod error;
pub mod password;
pub mod pty;
pub mod secret;
pub mod ssh;
pub mod sshconfig;
pub mod store;
pub mod vault;

pub use error::{Error, Result};
