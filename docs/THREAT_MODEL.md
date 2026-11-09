# Keystone threat model

This document states what Keystone protects against, how, and — just as importantly —
what it **cannot** protect against. If a claim is not in the "Protected" column, assume
Keystone does not defend against it.

## 1. Assets

| Asset | Where it lives |
|---|---|
| Vault secrets (SSH keys, passwords, DB creds, tokens, notes) | `vault.ksv` (encrypted), process memory while unlocked |
| Master password | Typed by the user; never stored |
| Host profiles, folders, tunnels | `profiles.json` (plaintext, **no secrets**) |
| Trusted host keys | `known_hosts.json` (plaintext, integrity-relevant) |
| Terminal output | Renderer memory; on disk **only** if session logging is enabled |

Data directory: `%APPDATA%\app.keystone.desktop` (Windows), `~/.local/share/app.keystone.desktop` (Linux).

## 2. Three separate authentication domains

They share nothing, by design:

1. **Vault encryption** — master password → Argon2id → KEK, which unwraps a random 256-bit
   vault key (VEK). This is the only thing that gates access to secrets.
2. **Application authentication** — there is none beyond the vault. Keystone does not
   pretend that an "app login screen" adds security: anyone who can run code as your OS user
   can read the app's files directly. Non-secret data (host list) is therefore visible
   without unlocking.
3. **SSH authentication** — per hop, using credentials pulled from the vault at connect time
   (or ssh-agent / a key file on disk). SSH auth material is never derived from the master
   password.

## 3. Cryptography

| Purpose | Primitive | Parameters |
|---|---|---|
| Password → KEK | Argon2id v1.3 | 64 MiB, t=3, p=1, 16-byte random salt |
| Wrap VEK / encrypt payload | XChaCha20-Poly1305 | 256-bit key, 192-bit random nonce per write |
| Randomness | OS CSPRNG (`getrandom`) | — |
| Host key identity | SHA-256 fingerprint | — |

* The **entire** vault payload — names, host links, tags and secrets — is a single AEAD
  ciphertext. A stolen vault file reveals its size, KDF parameters and a random vault id.
* AAD binds every ciphertext to `format/version/vault-id/role`, so blobs can't be swapped
  between vaults or between the key-wrap and payload roles. Tampering with the header fails
  authentication.
* KDF parameters read from the file are checked against a floor, so a tampered file
  can't downgrade Argon2 to trivial cost.
* Writes are atomic (temp file + fsync + rename, mode 0600 on Unix), so a crash cannot leave
  a half-written vault.
* Changing the master password re-wraps the VEK with a fresh salt; the old password stops
  working on the live file. **Old copies of the file (backups, sync history) still open with
  the old password.**

## 4. Threats

| # | Threat | Protected? | How / why not |
|---|---|---|---|
| T1 | **Stolen vault file** (laptop theft, leaked backup, cloud sync) | **Yes**, to the strength of the master password | Argon2id makes offline guessing costly; nothing readable without the password. A weak master password is still guessable — the UI shows a zxcvbn strength meter and requires ≥ 8 chars. |
| T2 | **Stolen profiles / known_hosts** | Partially | Contains hostnames, usernames, network layout — **not** secrets. Treat as sensitive metadata. |
| T3 | **Accidental exposure via logs** | Yes | Secrets use a `SecretString` type with a redacted `Debug` and no `Display`, so they can't be formatted into logs by accident. Commands never log arguments. Errors never contain secret values. |
| T4 | **Accidental exposure via UI** | Yes | The renderer receives credential *summaries* with secret values set to `null`. Secrets reach JS only via `credential_reveal`, which the UI calls on an explicit click and re-masks after 20 s. Copy happens in Rust and never passes through JS. |
| T5 | **Clipboard leakage** | Partially | Copied secrets are cleared after a configurable delay, only if the clipboard still holds the same value (hash compare). **Clipboard history managers (Windows Win+V, KDE Klipper, etc.) may already have saved a copy** — Keystone cannot prevent that. |
| T6 | **Terminal output containing secrets** | Yes, by default | Session logging is off by default and the setting explains the risk. Workspace restore saves layout only, never scrollback. |
| T7 | **MITM on SSH** | Yes | Host keys are checked on every hop. Unknown keys require explicit user approval (trust on first use); a *changed* key raises a prominent warning and is rejected unless the user overrides. Prompts left unanswered for 180 s count as **rejected**. |
| T8 | **Malicious / compromised bastion** | Partially | Jump chains use `direct-tcpip` + an inner SSH handshake, so the bastion only sees ciphertext to the target and cannot impersonate it (T7 applies per hop). A compromised bastion *can* see traffic metadata and refuse service. **Agent forwarding to a compromised host lets it use (not steal) your agent keys while you are connected** — hence it is off by default and needs consent on every connection. |
| T9 | **Local malware running as your user, vault locked** | Limited | It can't decrypt the vault without the password. It **can** install a keylogger and capture the password next time you type it, or modify the Keystone binary. Not defendable at the application level. |
| T10 | **Local malware running as your user, vault unlocked** | **No** | It can read Keystone's process memory (ptrace / ReadProcessMemory) and extract the VEK and secrets. Auto-lock reduces the time window but cannot close it. |
| T11 | **Compromised renderer (XSS in the webview)** | Partially | Strict CSP (no remote scripts, no inline scripts, no `eval`) and no fs/shell plugin permissions are granted. But a compromised renderer can call any app command the UI can — including `credential_reveal` while unlocked. The Rust side is the trust boundary for *integrity* (crypto, host-key checks), not against a fully hostile UI. |
| T12 | **Memory remnants after lock** | Best effort | The VEK and `SecretString`s are zeroized on drop. Copies made by serde_json, the allocator, the OS (swap, hibernation, crash dumps) or the webview (revealed values) are outside our control. |
| T13 | **SOCKS / -L listener exposure** | User-controlled | Tunnels default to `127.0.0.1`. Binding to `0.0.0.0` exposes your SSH connection as a proxy to your network; the UI warns. |
| T14 | **Malicious import files** | Yes | Profile imports are parsed as typed JSON; `ForwardAgent` from `~/.ssh/config` is deliberately **not** imported. Vault backups are authenticated before anything is merged. |

## 5. Explicit non-goals

* Defending against an attacker with code execution as your OS user while the vault is unlocked.
* Defending against kernel/root-level compromise.
* Hardware-backed key storage (TPM / secure enclave), or FIDO keys for vault unlock.
* Multi-user or shared vaults, or sync (there is no server component).

## 6. Not yet implemented (honest status)

* **OS keychain "quick unlock"** (Windows Credential Manager / Linux Secret Service). Planned
  design: opt-in, store the VEK in the OS keychain so unlock doesn't require the master
  password. This *trades security for convenience*: any process running as your user can
  usually read the keychain item on Linux. `vault_status` reports `osKeychainAvailable: false`
  until this exists.
* **Biometric unlock** (Windows Hello). Would build on the keychain item above.
* **`mlock` / `VirtualLock`** of secret pages to keep them out of swap.
* **Host-key certificate authorities** (`@cert-authority`). CA-signed host certs are currently
  fingerprinted like plain keys.
