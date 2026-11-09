//! Cryptographic primitives. Deliberately small and boring:
//! * KDF: Argon2id (RFC 9106) — master password -> key-encryption key (KEK)
//! * AEAD: XChaCha20-Poly1305 — 192-bit random nonces, so random nonce reuse is not a concern
//! * RNG: OS CSPRNG via `getrandom`

use crate::error::{Error, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;
pub const SALT_LEN: usize = 16;

pub type Key = Zeroizing<[u8; KEY_LEN]>;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS random number generator unavailable");
    b
}

pub fn random_key() -> Key {
    Zeroizing::new(random_bytes::<KEY_LEN>())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub alg: String, // always "argon2id"
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: String, // base64
}

impl KdfParams {
    /// OWASP-recommended baseline is m=19 MiB,t=2; we use 64 MiB / t=3 since this
    /// runs once per unlock on a desktop. Tests use `fast()`.
    pub fn new_default() -> Self {
        Self {
            alg: "argon2id".into(),
            memory_kib: 64 * 1024,
            iterations: 3,
            parallelism: 1,
            salt: B64.encode(random_bytes::<SALT_LEN>()),
        }
    }

    #[cfg(test)]
    pub fn fast() -> Self {
        Self { memory_kib: 1024, iterations: 1, ..Self::new_default() }
    }

    pub fn derive(&self, password: &[u8]) -> Result<Key> {
        if self.alg != "argon2id" {
            return Err(Error::Invalid(format!("unsupported kdf {}", self.alg)));
        }
        // Refuse absurdly weak params from a tampered file (downgrade protection).
        if self.memory_kib < 1024 || self.iterations < 1 {
            return Err(Error::Corrupted);
        }
        let salt = B64.decode(&self.salt).map_err(|_| Error::Corrupted)?;
        let params = Params::new(self.memory_kib, self.iterations, self.parallelism, Some(KEY_LEN))
            .map_err(|_| Error::Corrupted)?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        argon
            .hash_password_into(password, &salt, out.as_mut())
            .map_err(|_| Error::Crypto)?;
        Ok(out)
    }
}

/// Nonce + ciphertext (ciphertext includes the Poly1305 tag).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sealed {
    pub nonce: String,
    pub ct: String,
}

pub fn seal(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &[u8]) -> Result<Sealed> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| Error::Crypto)?;
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let nonce = XNonce::from(nonce_bytes);
    let ct = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad })
        .map_err(|_| Error::Crypto)?;
    Ok(Sealed { nonce: B64.encode(nonce_bytes), ct: B64.encode(ct) })
}

/// Fails with `Error::Corrupted` on any authentication failure; callers map that to
/// `BadPassword` where the key came from a password.
pub fn open(key: &[u8; KEY_LEN], sealed: &Sealed, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| Error::Crypto)?;
    let nonce_vec = B64.decode(&sealed.nonce).map_err(|_| Error::Corrupted)?;
    let nonce_arr: [u8; NONCE_LEN] = nonce_vec.try_into().map_err(|_| Error::Corrupted)?;
    let ct = B64.decode(&sealed.ct).map_err(|_| Error::Corrupted)?;
    let pt = cipher
        .decrypt(&XNonce::from(nonce_arr), Payload { msg: &ct, aad })
        .map_err(|_| Error::Corrupted)?;
    Ok(Zeroizing::new(pt))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_tamper() {
        let k = random_key();
        let s = seal(&k, b"hello", b"aad").unwrap();
        assert_eq!(&open(&k, &s, b"aad").unwrap()[..], b"hello");
        assert!(open(&k, &s, b"other-aad").is_err());
        let mut bad = s.clone();
        let mut ct = B64.decode(&bad.ct).unwrap();
        ct[0] ^= 1;
        bad.ct = B64.encode(ct);
        assert!(open(&k, &bad, b"aad").is_err());
    }

    #[test]
    fn kdf_deterministic_per_salt() {
        let p = KdfParams::fast();
        assert_eq!(*p.derive(b"pw").unwrap(), *p.derive(b"pw").unwrap());
        assert_ne!(*p.derive(b"pw").unwrap(), *p.derive(b"pw2").unwrap());
        let p2 = KdfParams::fast();
        assert_ne!(*p.derive(b"pw").unwrap(), *p2.derive(b"pw").unwrap());
    }
}
