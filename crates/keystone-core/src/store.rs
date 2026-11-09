//! Non-secret profile data: hosts, folders, tunnels, known host keys, settings, workspace.
//!
//! None of these files contain secrets — hosts reference vault credentials by id.
//! Settings and workspace are stored as opaque JSON owned by the UI; the backend
//! reads only the few keys it needs (see `Settings`).

use crate::error::{Error, Result};
use crate::vault::atomic_write;
use chrono::{DateTime, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    #[default]
    Password,
    PublicKey,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub credential_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    Socks5,
    Http,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOverrides {
    pub font_family: Option<String>,
    pub font_size: Option<f32>,
    pub theme_id: Option<String>,
    pub scrollback: Option<u32>,
}

fn d_port() -> u16 { 22 }
fn d_timeout() -> u32 { 15 }
fn d_keepalive() -> u32 { 30 }
fn d_missed() -> u32 { 3 }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub hostname: String,
    #[serde(default = "d_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth: AuthMethod,
    #[serde(default)]
    pub credential_id: Option<String>,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub jump_chain: Vec<String>,
    #[serde(default)]
    pub is_bastion: bool,
    #[serde(default = "d_timeout")]
    pub connect_timeout_secs: u32,
    #[serde(default = "d_keepalive")]
    pub keep_alive_secs: u32,
    #[serde(default = "d_missed")]
    pub keep_alive_max_missed: u32,
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub startup_commands: Vec<String>,
    #[serde(default)]
    pub agent_forwarding: bool,
    #[serde(default)]
    pub terminal: Option<TerminalOverrides>,
    #[serde(default = "Utc::now")]
    pub created_at: DateTime<Utc>,
    #[serde(default = "Utc::now")]
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub last_connected_at: Option<DateTime<Utc>>,
}

impl Host {
    pub fn new(name: &str, hostname: &str) -> Self {
        let now = Utc::now();
        Host {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            hostname: hostname.into(),
            port: 22,
            username: String::new(),
            auth: AuthMethod::Agent,
            credential_id: None,
            identity_file: None,
            folder_id: None,
            environment: None,
            project: None,
            tags: vec![],
            description: String::new(),
            favorite: false,
            color: None,
            jump_chain: vec![],
            is_bastion: false,
            connect_timeout_secs: d_timeout(),
            keep_alive_secs: d_keepalive(),
            keep_alive_max_missed: d_missed(),
            proxy: None,
            env: BTreeMap::new(),
            startup_commands: vec![],
            agent_forwarding: false,
            terminal: None,
            created_at: now,
            updated_at: now,
            last_connected_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host_id: String,
    pub kind: TunnelKind,
    pub bind_address: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "yes")]
    pub auto_reconnect: bool,
}
fn yes() -> bool { true }

impl Tunnel {
    pub fn validate(&self) -> Result<()> {
        match self.kind {
            TunnelKind::Local | TunnelKind::Remote => {
                if self.target_host.as_deref().unwrap_or("").is_empty() || self.target_port.is_none() {
                    return Err(Error::Invalid("target host and port are required".into()));
                }
            }
            TunnelKind::Dynamic => {}
        }
        if self.bind_address.trim().is_empty() {
            return Err(Error::Invalid("bind address is required".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Profiles {
    #[serde(default)]
    pub hosts: Vec<Host>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub tunnels: Vec<Tunnel>,
}

/// A trusted host key: `host:port` -> (algorithm, SHA256 fingerprint).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub key_type: String,
    pub fingerprint: String,
    pub added_at: DateTime<Utc>,
}

/// Backend-relevant subset of the UI's AppSettings, with safe defaults.
#[derive(Debug, Clone)]
pub struct Settings {
    pub auto_lock_secs: u64,
    pub clipboard_clear_secs: u64,
    pub auto_reconnect: bool,
    pub logging_enabled: bool,
    pub log_dir: Option<PathBuf>,
}

impl Settings {
    pub fn from_json(v: &serde_json::Value) -> Self {
        let num = |a: &str, b: &str, d: u64| v.get(a).and_then(|x| x.get(b)).and_then(|x| x.as_u64()).unwrap_or(d);
        let flag = |a: &str, b: &str, d: bool| v.get(a).and_then(|x| x.get(b)).and_then(|x| x.as_bool()).unwrap_or(d);
        Settings {
            auto_lock_secs: num("vault", "autoLockSecs", 600),
            clipboard_clear_secs: num("vault", "clipboardClearSecs", 20).max(1),
            auto_reconnect: flag("sessions", "autoReconnect", true),
            logging_enabled: flag("sessions", "loggingEnabled", false),
            log_dir: v
                .get("sessions")
                .and_then(|s| s.get("logDir"))
                .and_then(|d| d.as_str())
                .map(PathBuf::from),
        }
    }
}

pub struct Store {
    dir: PathBuf,
    pub profiles: Profiles,
    pub known_hosts: BTreeMap<String, KnownHost>,
}

fn load_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match std::fs::read(path) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

fn save_json<T: Serialize>(path: &Path, v: &T) -> Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(v)?)
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Store {
            dir: dir.to_owned(),
            profiles: load_json(&dir.join("profiles.json"))?,
            known_hosts: load_json(&dir.join("known_hosts.json"))?,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
    pub fn vault_path(&self) -> PathBuf {
        self.dir.join("vault.ksv")
    }

    fn save_profiles(&self) -> Result<()> {
        save_json(&self.dir.join("profiles.json"), &self.profiles)
    }

    // ── settings / workspace (opaque JSON) ──
    pub fn settings_json(&self) -> Result<serde_json::Value> {
        load_json::<Option<serde_json::Value>>(&self.dir.join("settings.json")).map(|v| v.unwrap_or(serde_json::Value::Null))
    }
    pub fn set_settings_json(&self, v: &serde_json::Value) -> Result<()> {
        save_json(&self.dir.join("settings.json"), v)
    }
    pub fn settings(&self) -> Settings {
        Settings::from_json(&self.settings_json().unwrap_or_default())
    }
    pub fn workspace_json(&self) -> Result<Option<serde_json::Value>> {
        load_json(&self.dir.join("workspace.json"))
    }
    pub fn set_workspace_json(&self, v: &serde_json::Value) -> Result<()> {
        save_json(&self.dir.join("workspace.json"), v)
    }

    // ── hosts ──
    pub fn host(&self, id: &str) -> Result<&Host> {
        self.profiles.hosts.iter().find(|h| h.id == id).ok_or_else(|| Error::NotFound(format!("host {id}")))
    }

    /// Resolves the full hop list for a host: jump chain (in order) followed by the host itself.
    /// Each jump host's *own* jump chain is expanded recursively, so a bastion that itself sits
    /// behind another bastion works. Cycles are rejected.
    pub fn resolve_chain(&self, id: &str) -> Result<Vec<Host>> {
        fn walk(s: &Store, id: &str, stack: &mut Vec<String>, out: &mut Vec<Host>) -> Result<()> {
            if stack.iter().any(|x| x == id) {
                return Err(Error::Invalid("jump chain contains a cycle".into()));
            }
            if stack.len() > 8 {
                return Err(Error::Invalid("jump chain is too deep (max 8 hops)".into()));
            }
            stack.push(id.to_owned());
            let h = s.host(id)?.clone();
            for j in &h.jump_chain {
                walk(s, j, stack, out)?;
            }
            stack.pop();
            if !out.iter().any(|x| x.id == h.id) {
                out.push(h);
            }
            Ok(())
        }
        let mut out = vec![];
        walk(self, id, &mut vec![], &mut out)?;
        Ok(out)
    }

    pub fn save_host(&mut self, mut h: Host) -> Result<Host> {
        if h.hostname.trim().is_empty() {
            return Err(Error::Invalid("hostname is required".into()));
        }
        if h.name.trim().is_empty() {
            h.name = h.hostname.clone();
        }
        if h.id.is_empty() {
            h.id = Uuid::new_v4().to_string();
            h.created_at = Utc::now();
        }
        h.updated_at = Utc::now();
        let id = h.id.clone();
        match self.profiles.hosts.iter_mut().find(|x| x.id == id) {
            Some(x) => *x = h.clone(),
            None => self.profiles.hosts.push(h.clone()),
        }
        if let Err(e) = self.resolve_chain(&id) {
            // Roll back an edit that introduces a cycle.
            self.profiles = load_json(&self.dir.join("profiles.json"))?;
            return Err(e);
        }
        self.save_profiles()?;
        Ok(h)
    }

    pub fn touch_host(&mut self, id: &str) -> Result<()> {
        if let Some(h) = self.profiles.hosts.iter_mut().find(|h| h.id == id) {
            h.last_connected_at = Some(Utc::now());
            self.save_profiles()?;
        }
        Ok(())
    }

    pub fn delete_host(&mut self, id: &str) -> Result<()> {
        self.profiles.hosts.retain(|h| h.id != id);
        for h in &mut self.profiles.hosts {
            h.jump_chain.retain(|j| j != id);
        }
        self.profiles.tunnels.retain(|t| t.host_id != id);
        self.save_profiles()
    }

    pub fn duplicate_host(&mut self, id: &str) -> Result<Host> {
        let mut h = self.host(id)?.clone();
        h.id = String::new();
        h.name = format!("{} (copy)", h.name);
        h.favorite = false;
        h.last_connected_at = None;
        self.save_host(h)
    }

    // ── folders ──
    pub fn save_folder(&mut self, mut f: Folder) -> Result<Folder> {
        if f.name.trim().is_empty() {
            return Err(Error::Invalid("folder name is required".into()));
        }
        if f.id.is_empty() {
            f.id = Uuid::new_v4().to_string();
        }
        // Reject moving a folder under its own descendant.
        let mut cur = f.parent_id.clone();
        while let Some(p) = cur {
            if p == f.id {
                return Err(Error::Invalid("a folder cannot be nested inside itself".into()));
            }
            cur = self.profiles.folders.iter().find(|x| x.id == p).and_then(|x| x.parent_id.clone());
        }
        match self.profiles.folders.iter_mut().find(|x| x.id == f.id) {
            Some(x) => *x = f.clone(),
            None => self.profiles.folders.push(f.clone()),
        }
        self.save_profiles()?;
        Ok(f)
    }

    /// Deleting a folder moves its hosts and subfolders up to its parent (nothing is lost).
    pub fn delete_folder(&mut self, id: &str) -> Result<()> {
        let parent = self.profiles.folders.iter().find(|f| f.id == id).map(|f| f.parent_id.clone());
        let Some(parent) = parent else { return Err(Error::NotFound(format!("folder {id}"))) };
        for f in &mut self.profiles.folders {
            if f.parent_id.as_deref() == Some(id) {
                f.parent_id = parent.clone();
            }
        }
        for h in &mut self.profiles.hosts {
            if h.folder_id.as_deref() == Some(id) {
                h.folder_id = parent.clone();
            }
        }
        self.profiles.folders.retain(|f| f.id != id);
        self.save_profiles()
    }

    // ── tunnels ──
    pub fn tunnel(&self, id: &str) -> Result<&Tunnel> {
        self.profiles.tunnels.iter().find(|t| t.id == id).ok_or_else(|| Error::NotFound(format!("tunnel {id}")))
    }

    pub fn save_tunnel(&mut self, mut t: Tunnel) -> Result<Tunnel> {
        t.validate()?;
        self.host(&t.host_id)?;
        if t.id.is_empty() {
            t.id = Uuid::new_v4().to_string();
        }
        match self.profiles.tunnels.iter_mut().find(|x| x.id == t.id) {
            Some(x) => *x = t.clone(),
            None => self.profiles.tunnels.push(t.clone()),
        }
        self.save_profiles()?;
        Ok(t)
    }

    pub fn delete_tunnel(&mut self, id: &str) -> Result<()> {
        self.profiles.tunnels.retain(|t| t.id != id);
        self.save_profiles()
    }

    // ── known hosts ──
    pub fn known_host(&self, host: &str, port: u16) -> Option<&KnownHost> {
        self.known_hosts.get(&format!("{host}:{port}"))
    }

    pub fn trust_host_key(&mut self, host: &str, port: u16, key_type: &str, fingerprint: &str) -> Result<()> {
        self.known_hosts.insert(
            format!("{host}:{port}"),
            KnownHost { key_type: key_type.into(), fingerprint: fingerprint.into(), added_at: Utc::now() },
        );
        save_json(&self.dir.join("known_hosts.json"), &self.known_hosts)
    }

    // ── import / export ──

    /// Exports hosts (and the folders/tunnels they need). Never contains secrets;
    /// credential ids are kept so they re-link when imported alongside a vault backup.
    pub fn export_profiles(&self, path: &Path, host_ids: Option<&[String]>) -> Result<usize> {
        let hosts: Vec<Host> = self
            .profiles
            .hosts
            .iter()
            .filter(|h| host_ids.is_none_or(|ids| ids.contains(&h.id)))
            .cloned()
            .collect();
        let tunnels = self.profiles.tunnels.iter().filter(|t| hosts.iter().any(|h| h.id == t.host_id)).cloned().collect();
        let n = hosts.len();
        let doc = serde_json::json!({
            "format": "keystone-profiles",
            "version": 1,
            "profiles": Profiles { hosts, folders: self.profiles.folders.clone(), tunnels },
        });
        atomic_write(path, &serde_json::to_vec_pretty(&doc)?)?;
        Ok(n)
    }

    /// Imports a profiles export. Existing ids are overwritten, new ones added.
    pub fn import_profiles(&mut self, path: &Path) -> Result<usize> {
        let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
        if doc.get("format").and_then(|f| f.as_str()) != Some("keystone-profiles") {
            return Err(Error::Invalid("not a Keystone profiles export".into()));
        }
        let p: Profiles = serde_json::from_value(doc["profiles"].clone())?;
        let n = p.hosts.len();
        fn upsert<T: Clone>(v: &mut Vec<T>, items: Vec<T>, id: impl Fn(&T) -> &str) {
            for it in items {
                match v.iter().position(|x| id(x) == id(&it)) {
                    Some(i) => v[i] = it,
                    None => v.push(it),
                }
            }
        }
        upsert(&mut self.profiles.folders, p.folders, |f| &f.id);
        upsert(&mut self.profiles.hosts, p.hosts, |h| &h.id);
        upsert(&mut self.profiles.tunnels, p.tunnels, |t| &t.id);
        self.save_profiles()?;
        Ok(n)
    }

    /// Imports Host blocks from an OpenSSH client config (default ~/.ssh/config).
    /// Hosts already imported (same name + hostname) are skipped.
    pub fn import_ssh_config(&mut self, path: Option<&Path>) -> Result<usize> {
        let default = dirs::home_dir().map(|h| h.join(".ssh").join("config"));
        let path = path.map(Path::to_path_buf).or(default).ok_or_else(|| Error::NotFound("~/.ssh/config".into()))?;
        let text = std::fs::read_to_string(&path)?;
        let entries = crate::sshconfig::parse(&text);
        let folder_id = match self.profiles.folders.iter().find(|f| f.name == "Imported" && f.parent_id.is_none()) {
            Some(f) => f.id.clone(),
            None => self.save_folder(Folder { id: String::new(), name: "Imported".into(), parent_id: None, color: None, icon: None, sort_order: 999 })?.id,
        };
        let mut by_alias: BTreeMap<String, String> = BTreeMap::new();
        let mut pending_jumps: Vec<(String, Vec<String>)> = vec![];
        let mut n = 0;
        for e in entries {
            let hostname = e.hostname.clone().unwrap_or_else(|| e.alias.clone());
            if let Some(existing) = self.profiles.hosts.iter().find(|h| h.name == e.alias && h.hostname == hostname) {
                by_alias.insert(e.alias.clone(), existing.id.clone());
                continue;
            }
            let mut h = Host::new(&e.alias, &hostname);
            h.port = e.port.unwrap_or(22);
            h.username = e.user.clone().unwrap_or_default();
            h.folder_id = Some(folder_id.clone());
            if let Some(idf) = e.identity_file.clone() {
                h.auth = AuthMethod::PublicKey;
                h.identity_file = Some(idf);
            }
            h.agent_forwarding = false; // never import ForwardAgent silently; requires consent in-app
            let h = self.save_host(h)?;
            by_alias.insert(e.alias.clone(), h.id.clone());
            if !e.proxy_jump.is_empty() {
                pending_jumps.push((h.id.clone(), e.proxy_jump.clone()));
            }
            n += 1;
        }
        for (hid, jumps) in pending_jumps {
            let chain: Vec<String> = jumps.iter().filter_map(|a| by_alias.get(a).cloned()).collect();
            if let Some(h) = self.profiles.hosts.iter_mut().find(|h| h.id == hid) {
                h.jump_chain = chain.clone();
            }
            for j in &chain {
                if let Some(b) = self.profiles.hosts.iter_mut().find(|h| &h.id == j) {
                    b.is_bastion = true;
                }
            }
        }
        self.save_profiles()?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_resolution_and_cycles() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let outer = s.save_host(Host::new("outer", "1.1.1.1")).unwrap();
        let mut b = Host::new("bastion", "10.0.0.1");
        b.jump_chain = vec![outer.id.clone()];
        let b = s.save_host(b).unwrap();
        let mut t = Host::new("db", "10.0.1.10");
        t.jump_chain = vec![b.id.clone()];
        let t = s.save_host(t).unwrap();
        let names: Vec<_> = s.resolve_chain(&t.id).unwrap().into_iter().map(|h| h.name).collect();
        assert_eq!(names, ["outer", "bastion", "db"]);

        let mut cyc = s.host(&outer.id).unwrap().clone();
        cyc.jump_chain = vec![t.id.clone()];
        assert!(s.save_host(cyc).is_err());
        assert!(s.host(&outer.id).unwrap().jump_chain.is_empty(), "cycle edit must roll back");
    }

    #[test]
    fn folder_delete_reparents() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::open(dir.path()).unwrap();
        let root = s.save_folder(Folder { id: "".into(), name: "Infra".into(), parent_id: None, color: None, icon: None, sort_order: 0 }).unwrap();
        let prod = s.save_folder(Folder { id: "".into(), name: "Prod".into(), parent_id: Some(root.id.clone()), color: None, icon: None, sort_order: 0 }).unwrap();
        let mut h = Host::new("web", "w");
        h.folder_id = Some(prod.id.clone());
        let h = s.save_host(h).unwrap();
        let mut bad = root.clone();
        bad.parent_id = Some(prod.id.clone());
        assert!(s.save_folder(bad).is_err());
        s.delete_folder(&prod.id).unwrap();
        assert_eq!(s.host(&h.id).unwrap().folder_id.as_deref(), Some(root.id.as_str()));
    }

    #[test]
    fn ssh_config_import() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config");
        std::fs::write(&cfg, "Host bastion\n  HostName 3.3.3.3\n  User ec2-user\n\nHost db\n  HostName 10.0.1.10\n  ProxyJump bastion\n  Port 2222\nHost *\n  ServerAliveInterval 30\n").unwrap();
        let mut s = Store::open(&dir.path().join("data")).unwrap();
        assert_eq!(s.import_ssh_config(Some(&cfg)).unwrap(), 2);
        let db = s.profiles.hosts.iter().find(|h| h.name == "db").unwrap();
        assert_eq!(db.port, 2222);
        assert_eq!(s.resolve_chain(&db.id).unwrap().len(), 2);
        assert_eq!(s.import_ssh_config(Some(&cfg)).unwrap(), 0, "re-import must be idempotent");
    }
}
