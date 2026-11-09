# Keystone architecture

```
┌──────────────────────────── ui/ (React + TS, Vite) ─────────────────────────────┐
│ views · components · zustand stores · theme engine · xterm.js                   │
│ lib/api.ts  ── the ONLY place that talks to the backend (invoke + Channels)     │
│ lib/types.ts ── IPC contract, mirrored by serde types in Rust                   │
└───────────────────────────────▲─────────────────────────────────────────────────┘
                                │ Tauri IPC (commands, events, per-session Channels)
┌───────────────────────────────┴──── src-tauri/ (thin adapter) ──────────────────┐
│ commands.rs  one #[tauri::command] per api.ts call                              │
│ state.rs     AppState (store, vault, sessions, tunnels, sftp, prompts),         │
│              AppInteraction (host-key / agent prompts ⇄ UI), hop_provider,      │
│              auto-lock timer                                                     │
└───────────────────────────────▲─────────────────────────────────────────────────┘
                                │ plain Rust API, no Tauri types
┌───────────────────────────────┴──── crates/keystone-core/ ──────────────────────┐
│ crypto   Argon2id + XChaCha20-Poly1305      vault    encrypted credential store │
│ secret   zeroizing, log-safe SecretString   password generator + zxcvbn         │
│ store    hosts/folders/tunnels/known_hosts   sshconfig  ~/.ssh/config import     │
│ ssh/     mod (jump chains, auth, host keys) · session (shell, reconnect, exec)  │
│          tunnel (-L/-R/-D, SOCKS5, supervisor) · sftp · proxy (SOCKS5/HTTP)     │
│ pty      local terminals (ConPTY / openpty)                                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Why this split

* **Security boundary.** Everything that touches secrets, crypto or the network is in
  `keystone-core`, which has no UI dependency and is unit- and end-to-end-tested headlessly.
  The webview only gets what it needs to render (see THREAT_MODEL.md T4).
* **macOS later.** Nothing in core is platform-specific except `pty.rs` (portable-pty covers
  macOS) and the agent socket (`#[cfg(unix)]` already covers macOS). Adding macOS means
  adding `dmg`/`app` bundle targets and signing, not restructuring.
* **Testability.** `tests/ssh_e2e.rs` spins up real in-process SSH servers (bastion +
  private target) and exercises chains, auth, host-key trust, shells and tunnels.

## Key flows

### Connect through bastions
1. UI calls `ssh_open(hostId, cols, rows, channel)`.
2. `hop_provider` resolves the chain via `Store::resolve_chain` (recursive: a bastion can
   itself have a jump chain; cycles are rejected) and pulls each hop's secret from the vault.
3. `connect_chain` connects hop 0 over TCP (optionally via SOCKS5/HTTP proxy), then for each
   following hop opens `direct-tcpip` on the previous one and runs a full SSH handshake
   through it. Each hop: host-key check → per-hop auth.
4. Secrets are dropped (zeroized) as soon as auth completes. On reconnect, the provider
   re-reads the vault — if it's locked, reconnect fails with "vault is locked" rather than
   keeping secrets in memory.

### Host-key prompt
`ClientHandler::check_server_key` → `AppInteraction::confirm_host_key` emits
`hostkey://prompt` and parks on a oneshot keyed by `requestId`. The UI answers with
`hostkey_respond`. 180 s timeout = reject.

### Terminal data
Each session gets a Tauri `Channel<TermEvent>`; output is base64 bytes so binary/partial
UTF-8 sequences survive. Input is `session_write`. The session task owns the SSH channel and
reconnects with exponential backoff (500 ms → 30 s) when the connection drops (not when the
remote shell exits).

### Tunnels
`tunnel::start` binds the local listener **once** (so the port is stable across reconnects
and conflicts are reported immediately), then supervises: connect → serve → on drop,
reconnect with backoff. `-R` registers the server-side port in a per-connection
`ForwardRegistry` consulted by `server_channel_open_forwarded_tcpip`.

## Data files

| File | Content | Secret? |
|---|---|---|
| `vault.ksv` | Encrypted vault (JSON envelope) | Encrypted |
| `profiles.json` | Hosts, folders, tunnels | No |
| `known_hosts.json` | Trusted host-key fingerprints | No (integrity-relevant) |
| `settings.json` | UI-owned settings blob | No |
| `workspace.json` | Tabs / split layout for restore | No (no scrollback) |
| `logs/*.log` | Only if session logging is enabled | **May contain secrets** |
