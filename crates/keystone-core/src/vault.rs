//! Encrypted credential vault.
//!
//! Key hierarchy (see docs/THREAT_MODEL.md):
//!
//! ```text
//! master password ──Argon2id(salt)──▶ KEK ──XChaCha20-Poly1305──▶ wraps VEK (random 256-bit)
//!                                                                 VEK ──XChaCha20-Poly1305──▶ payload
//! ```
//!
//! * The VEK is random and independent of the password, so changing the master
//!   password only re-wraps the VEK.
//! * The entire payload (names, hosts, tags AND secrets) is encrypted; a stolen
//!   vault file reveals only its size and KDF parameters.
//! * AAD binds each ciphertext to its role and the file header, so blobs cannot be
//!   swapped between files or roles.
//! * Writes are atomic (temp file + fsync + rename).

use crate::crypto::{self, KdfParams, Key, Sealed};
use crate::error::{Error, Result};
use crate::secret::SecretString;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroize::Zeroizing;

const FORMAT: &str = "keystone-vault";
const VERSION: u32 = 1;
const MAX_HISTORY: usize = 20;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    format: String,
    version: u32,
    /// Random per-file id, mixed into AAD.
    vault_id: String,
    kdf: KdfParams,
    wrapped_key: Sealed,
    payload: Sealed,
}

impl VaultFile {
    fn aad(&self, role: &str) -> Vec<u8> {
        format!("{FORMAT}/v{}/{}/{role}", self.version, self.vault_id).into_bytes()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialKind {
    SshKey,
    SshPassword,
    Password,
    Mysql,
    Postgres,
    Clickhouse,
    Redis,
    ApiToken,
    Aws,
    Kubernetes,
    SecureNote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    pub label: String,
    pub secret: bool,
    pub value: SecretString,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub version: u32,
    pub created_at: DateTime<Utc>,
    pub changed_fields: Vec<String>,
    /// Full snapshot of the fields as they were *before* this change.
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub name: String,
    pub kind: CredentialKind,
    pub fields: Vec<Field>,
    pub host_ids: Vec<String>,
    pub tags: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub version: u32,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
}

impl Credential {
    pub fn field(&self, key: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.key == key)
    }
    pub fn secret(&self, key: &str) -> Option<&SecretString> {
        self.field(key).map(|f| &f.value).filter(|v| !v.is_empty())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultData {
    pub credentials: Vec<Credential>,
}

// ───────────── UI-facing views (no secret values) ─────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialFieldView {
    pub key: String,
    pub label: String,
    pub secret: bool,
    pub value: Option<String>,
    pub has_value: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub name: String,
    pub kind: CredentialKind,
    pub fields: Vec<CredentialFieldView>,
    pub host_ids: Vec<String>,
    pub tags: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub version_count: u32,
    pub strength: Option<u8>,
}

impl From<&Credential> for CredentialSummary {
    fn from(c: &Credential) -> Self {
        let strength = ["password", "passphrase"]
            .iter()
            .find_map(|k| c.secret(k))
            .map(|s| crate::password::strength(s.expose()).score);
        CredentialSummary {
            id: c.id.clone(),
            name: c.name.clone(),
            kind: c.kind,
            fields: c
                .fields
                .iter()
                .map(|f| CredentialFieldView {
                    key: f.key.clone(),
                    label: f.label.clone(),
                    secret: f.secret,
                    value: if f.secret { None } else { Some(f.value.expose().to_owned()) },
                    has_value: !f.value.is_empty(),
                })
                .collect(),
            host_ids: c.host_ids.clone(),
            tags: c.tags.clone(),
            expires_at: c.expires_at,
            created_at: c.created_at,
            updated_at: c.updated_at,
            version_count: c.version,
            strength,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialFieldInput {
    pub key: String,
    pub label: String,
    pub secret: bool,
    /// For updates: `None` on a secret field means "keep the existing value".
    pub value: Option<SecretString>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub name: String,
    pub kind: CredentialKind,
    pub fields: Vec<CredentialFieldInput>,
    pub host_ids: Vec<String>,
    pub tags: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialVersion {
    pub version: u32,
    pub created_at: DateTime<Utc>,
    pub changed_fields: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportMode {
    Merge,
    Replace,
}

// ───────────── Vault ─────────────

pub fn exists(path: &Path) -> bool {
    path.is_file()
}

/// An unlocked vault. Dropping it zeroizes the VEK and all secret strings.
pub struct UnlockedVault {
    path: PathBuf,
    vault_id: String,
    kdf: KdfParams,
    kek_wrapped: Sealed,
    vek: Key,
    data: VaultData,
}

impl std::fmt::Debug for UnlockedVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnlockedVault").field("path", &self.path).finish_non_exhaustive()
    }
}

fn wrap_aad(vault_id: &str) -> Vec<u8> {
    format!("{FORMAT}/v{VERSION}/{vault_id}/vek").into_bytes()
}
fn payload_aad(vault_id: &str) -> Vec<u8> {
    format!("{FORMAT}/v{VERSION}/{vault_id}/payload").into_bytes()
}

fn read_file(path: &Path) -> Result<VaultFile> {
    let raw = std::fs::read(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { Error::VaultMissing } else { Error::Io(e) }
    })?;
    let f: VaultFile = serde_json::from_slice(&raw).map_err(|_| Error::Corrupted)?;
    if f.format != FORMAT {
        return Err(Error::Corrupted);
    }
    if f.version != VERSION {
        return Err(Error::UnsupportedVersion(f.version));
    }
    Ok(f)
}

fn open_file(f: &VaultFile, password: &str) -> Result<(Key, VaultData)> {
    let kek = f.kdf.derive(password.as_bytes())?;
    let vek_bytes = crypto::open(&kek, &f.wrapped_key, &f.aad("vek")).map_err(|_| Error::BadPassword)?;
    let vek_arr: [u8; crypto::KEY_LEN] = vek_bytes.as_slice().try_into().map_err(|_| Error::Corrupted)?;
    let vek = Zeroizing::new(vek_arr);
    let pt = crypto::open(&vek, &f.payload, &f.aad("payload"))?;
    let data: VaultData = serde_json::from_slice(&pt).map_err(|_| Error::Corrupted)?;
    Ok((vek, data))
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut fh = opts.open(&tmp)?;
        fh.write_all(bytes)?;
        fh.sync_all()?;
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

impl UnlockedVault {
    pub fn create(path: &Path, password: &str) -> Result<Self> {
        if exists(path) {
            return Err(Error::VaultExists);
        }
        Self::create_with_kdf(path, password, KdfParams::new_default(), VaultData::default())
    }

    fn create_with_kdf(path: &Path, password: &str, kdf: KdfParams, data: VaultData) -> Result<Self> {
        if password.chars().count() < 8 {
            return Err(Error::Invalid("master password must be at least 8 characters".into()));
        }
        let vault_id = Uuid::new_v4().to_string();
        let kek = kdf.derive(password.as_bytes())?;
        let vek = crypto::random_key();
        let kek_wrapped = crypto::seal(&kek, vek.as_ref(), &wrap_aad(&vault_id))?;
        let v = Self { path: path.to_owned(), vault_id, kdf, kek_wrapped, vek, data };
        v.save()?;
        Ok(v)
    }

    pub fn unlock(path: &Path, password: &str) -> Result<Self> {
        let f = read_file(path)?;
        let (vek, data) = open_file(&f, password)?;
        Ok(Self { path: path.to_owned(), vault_id: f.vault_id, kdf: f.kdf, kek_wrapped: f.wrapped_key, vek, data })
    }

    fn to_file(&self) -> Result<VaultFile> {
        let pt = Zeroizing::new(serde_json::to_vec(&self.data)?);
        Ok(VaultFile {
            format: FORMAT.into(),
            version: VERSION,
            vault_id: self.vault_id.clone(),
            kdf: self.kdf.clone(),
            wrapped_key: self.kek_wrapped.clone(),
            payload: crypto::seal(&self.vek, &pt, &payload_aad(&self.vault_id))?,
        })
    }

    pub fn save(&self) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(&self.to_file()?)?;
        atomic_write(&self.path, &bytes)
    }

    pub fn change_password(&mut self, old: &str, new: &str) -> Result<()> {
        // Re-verify the old password against the file rather than trusting UI state.
        let f = read_file(&self.path)?;
        open_file(&f, old)?;
        if new.chars().count() < 8 {
            return Err(Error::Invalid("master password must be at least 8 characters".into()));
        }
        let kdf = KdfParams::new_default();
        let kek = kdf.derive(new.as_bytes())?;
        self.kek_wrapped = crypto::seal(&kek, self.vek.as_ref(), &wrap_aad(&self.vault_id))?;
        self.kdf = kdf;
        self.save()
    }

    /// Writes a standalone encrypted backup protected by `export_password`
    /// (fresh salt, fresh VEK, fresh vault id — independent of the live vault).
    pub fn export_backup(&self, dest: &Path, export_password: &str) -> Result<()> {
        if dest == self.path {
            return Err(Error::Invalid("backup path must differ from the vault path".into()));
        }
        let pt = Zeroizing::new(serde_json::to_vec(&self.data)?);
        let data: VaultData = serde_json::from_slice(&pt)?;
        let _ = std::fs::remove_file(dest);
        Self::create_with_kdf(dest, export_password, KdfParams::new_default(), data).map(|_| ())
    }

    pub fn import_backup(&mut self, src: &Path, password: &str, mode: ImportMode) -> Result<usize> {
        let other = Self::unlock(src, password)?;
        let incoming = other.data.credentials.clone();
        let n = incoming.len();
        match mode {
            ImportMode::Replace => self.data.credentials = incoming,
            ImportMode::Merge => {
                for c in incoming {
                    match self.data.credentials.iter_mut().find(|x| x.id == c.id) {
                        Some(existing) if c.updated_at > existing.updated_at => *existing = c,
                        Some(_) => {}
                        None => self.data.credentials.push(c),
                    }
                }
            }
        }
        self.save()?;
        Ok(n)
    }

    // ───── credentials ─────

    pub fn list(&self) -> Vec<CredentialSummary> {
        let mut v: Vec<_> = self.data.credentials.iter().map(CredentialSummary::from).collect();
        v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        v
    }

    pub fn get(&self, id: &str) -> Result<&Credential> {
        self.data
            .credentials
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| Error::NotFound(format!("credential {id}")))
    }

    fn get_mut(&mut self, id: &str) -> Result<&mut Credential> {
        self.data
            .credentials
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| Error::NotFound(format!("credential {id}")))
    }

    pub fn reveal(&self, id: &str, field_key: &str) -> Result<SecretString> {
        let c = self.get(id)?;
        c.field(field_key)
            .map(|f| f.value.clone())
            .ok_or_else(|| Error::NotFound(format!("field {field_key}")))
    }

    fn validate(input: &CredentialInput) -> Result<()> {
        if input.name.trim().is_empty() {
            return Err(Error::Invalid("name is required".into()));
        }
        let mut seen = std::collections::HashSet::new();
        for f in &input.fields {
            if !seen.insert(&f.key) {
                return Err(Error::Invalid(format!("duplicate field {}", f.key)));
            }
        }
        Ok(())
    }

    pub fn create_credential(&mut self, input: CredentialInput) -> Result<CredentialSummary> {
        Self::validate(&input)?;
        let now = Utc::now();
        let c = Credential {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_owned(),
            kind: input.kind,
            fields: input
                .fields
                .into_iter()
                .map(|f| Field { key: f.key, label: f.label, secret: f.secret, value: f.value.unwrap_or_default() })
                .collect(),
            host_ids: input.host_ids,
            tags: input.tags,
            expires_at: input.expires_at,
            created_at: now,
            updated_at: now,
            version: 1,
            history: vec![],
        };
        let summary = CredentialSummary::from(&c);
        self.data.credentials.push(c);
        self.save()?;
        Ok(summary)
    }

    pub fn update_credential(&mut self, id: &str, input: CredentialInput) -> Result<CredentialSummary> {
        Self::validate(&input)?;
        let c = self.get_mut(id)?;
        let old_fields = c.fields.clone();
        let new_fields: Vec<Field> = input
            .fields
            .into_iter()
            .map(|f| {
                let value = match f.value {
                    Some(v) => v,
                    None => old_fields.iter().find(|o| o.key == f.key).map(|o| o.value.clone()).unwrap_or_default(),
                };
                Field { key: f.key, label: f.label, secret: f.secret, value }
            })
            .collect();
        let mut changed: Vec<String> = new_fields
            .iter()
            .filter(|n| old_fields.iter().find(|o| o.key == n.key).map(|o| o.value != n.value).unwrap_or(true))
            .map(|n| n.key.clone())
            .collect();
        changed.extend(old_fields.iter().filter(|o| !new_fields.iter().any(|n| n.key == o.key)).map(|o| o.key.clone()));

        if !changed.is_empty() {
            c.history.push(HistoryEntry {
                version: c.version,
                created_at: c.updated_at,
                changed_fields: changed,
                fields: old_fields,
            });
            if c.history.len() > MAX_HISTORY {
                let drop = c.history.len() - MAX_HISTORY;
                c.history.drain(0..drop);
            }
            c.version += 1;
        }
        c.name = input.name.trim().to_owned();
        c.kind = input.kind;
        c.fields = new_fields;
        c.host_ids = input.host_ids;
        c.tags = input.tags;
        c.expires_at = input.expires_at;
        c.updated_at = Utc::now();
        let summary = CredentialSummary::from(&*c);
        self.save()?;
        Ok(summary)
    }

    pub fn delete_credential(&mut self, id: &str) -> Result<()> {
        let before = self.data.credentials.len();
        self.data.credentials.retain(|c| c.id != id);
        if self.data.credentials.len() == before {
            return Err(Error::NotFound(format!("credential {id}")));
        }
        self.save()
    }

    pub fn history(&self, id: &str) -> Result<Vec<CredentialVersion>> {
        let c = self.get(id)?;
        Ok(c.history
            .iter()
            .rev()
            .map(|h| CredentialVersion { version: h.version, created_at: h.created_at, changed_fields: h.changed_fields.clone() })
            .collect())
    }

    /// Restoring is itself recorded as a new version, so it can be undone.
    pub fn restore_version(&mut self, id: &str, version: u32) -> Result<CredentialSummary> {
        let c = self.get(id)?;
        let h = c
            .history
            .iter()
            .find(|h| h.version == version)
            .ok_or_else(|| Error::NotFound(format!("version {version}")))?;
        let input = CredentialInput {
            name: c.name.clone(),
            kind: c.kind,
            fields: h
                .fields
                .iter()
                .map(|f| CredentialFieldInput { key: f.key.clone(), label: f.label.clone(), secret: f.secret, value: Some(f.value.clone()) })
                .collect(),
            host_ids: c.host_ids.clone(),
            tags: c.tags.clone(),
            expires_at: c.expires_at,
        };
        self.update_credential(id, input)
    }

    /// Remove a host id from all credential associations (called when a host is deleted).
    pub fn unlink_host(&mut self, host_id: &str) -> Result<()> {
        let mut dirty = false;
        for c in &mut self.data.credentials {
            let n = c.host_ids.len();
            c.host_ids.retain(|h| h != host_id);
            dirty |= n != c.host_ids.len();
        }
        if dirty { self.save() } else { Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_create(path: &Path, pw: &str) -> UnlockedVault {
        UnlockedVault::create_with_kdf(path, pw, KdfParams::fast(), VaultData::default()).unwrap()
    }

    fn input(pw: &str) -> CredentialInput {
        CredentialInput {
            name: "prod-db mysql".into(),
            kind: CredentialKind::Mysql,
            fields: vec![
                CredentialFieldInput { key: "username".into(), label: "Username".into(), secret: false, value: Some("app".into()) },
                CredentialFieldInput { key: "password".into(), label: "Password".into(), secret: true, value: Some(pw.into()) },
            ],
            host_ids: vec!["h1".into()],
            tags: vec![],
            expires_at: None,
        }
    }

    #[test]
    fn create_unlock_and_wrong_password() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("v.ksv");
        let mut v = fast_create(&p, "correct horse");
        let s = v.create_credential(input("s3cret-pw")).unwrap();
        assert!(s.fields.iter().find(|f| f.key == "password").unwrap().value.is_none(), "secret leaked into summary");
        drop(v);

        assert!(matches!(UnlockedVault::unlock(&p, "wrong pass"), Err(Error::BadPassword)));
        let v = UnlockedVault::unlock(&p, "correct horse").unwrap();
        assert_eq!(v.reveal(&s.id, "password").unwrap().expose(), "s3cret-pw");

        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(!raw.contains("s3cret-pw") && !raw.contains("prod-db"), "plaintext on disk");
    }

    #[test]
    fn history_keep_and_restore() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = fast_create(&dir.path().join("v.ksv"), "password1");
        let s = v.create_credential(input("one")).unwrap();
        // value None on a secret = keep
        let mut keep = input("x");
        keep.fields[1].value = None;
        keep.name = "renamed".into();
        let s2 = v.update_credential(&s.id, keep).unwrap();
        assert_eq!(s2.version_count, 1, "rename only must not bump secret version");
        assert_eq!(v.reveal(&s.id, "password").unwrap().expose(), "one");

        v.update_credential(&s.id, input("two")).unwrap();
        let h = v.history(&s.id).unwrap();
        assert_eq!(h[0].changed_fields, vec!["password".to_string()]);
        v.restore_version(&s.id, h[0].version).unwrap();
        assert_eq!(v.reveal(&s.id, "password").unwrap().expose(), "one");
    }

    #[test]
    fn tampered_header_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("v.ksv");
        fast_create(&p, "password1");
        let mut f: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        f["vaultId"] = serde_json::json!("00000000-0000-0000-0000-000000000000");
        std::fs::write(&p, serde_json::to_vec(&f).unwrap()).unwrap();
        assert!(UnlockedVault::unlock(&p, "password1").is_err());
    }

    #[test]
    fn change_password_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("v.ksv");
        let mut v = fast_create(&p, "password1");
        v.create_credential(input("pw")).unwrap();
        assert!(v.change_password("nope-nope", "password2").is_err());
        v.change_password("password1", "password2").unwrap();
        assert!(UnlockedVault::unlock(&p, "password1").is_err());
        UnlockedVault::unlock(&p, "password2").unwrap();

        let b = dir.path().join("backup.ksv");
        v.export_backup(&b, "backup-pass").unwrap();
        let mut v2 = fast_create(&dir.path().join("v2.ksv"), "password3");
        assert_eq!(v2.import_backup(&b, "backup-pass", ImportMode::Merge).unwrap(), 1);
        assert_eq!(v2.list().len(), 1);
    }
}
