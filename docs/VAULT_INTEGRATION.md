# Vault integration: using credentials, not just storing them

**Status:** proposal, not yet implemented · **Date:** 2026-11-09

## 1. Problem

Today the vault only **stores** non-SSH credentials (MySQL, Postgres, ClickHouse, Redis, AWS,
Kubernetes, API tokens, passwords). Only SSH credentials are used automatically, when connecting
to a host. For everything else the workflow is:

1. start a tunnel by hand,
2. open an external client (DBeaver, `clickhouse-client`, …),
3. copy the password from the vault and paste it.

That is a password manager next to a terminal, not an integrated tool. The goal is to let
credentials be **used** directly in terminal sessions and to connect to databases, without
weakening the rules in [THREAT_MODEL.md](THREAT_MODEL.md):

- secrets never on a command line (visible to every process via `ps` / `/proc`),
- secrets never pass through the webview unless the user clicks "reveal",
- secrets never written to logs or left on disk.

## 2. Features

| # | Feature | Value | Effort | Phase |
|---|---|---|---|---|
| F1 | Send a secret into a terminal | sudo, `mysql -p`, any password prompt | Small | 1 |
| F2 | "Connect" on a database credential (CLI client) | One click to a logged-in `clickhouse-client` / `mysql` / `psql` / `redis-cli`, through a bastion | Medium | 1 |
| F3 | Credential environments for terminals (AWS, Kubernetes, tokens) | `aws`, `kubectl`, `curl` work in one tab, no credential files on disk | Small–medium | 2 |
| F4 | Copy connection string / DSN | Paste into apps that take a URL | Small | 2 |
| F5 | Built-in query console | Query editor and results grid; no external client needed | Large | 3 |

### F1: Send a secret into a terminal

- In any terminal tab (SSH or local), `Ctrl+Shift+V` (or the command palette) opens a picker
  of vault entries and their secret fields.
- The chosen value is written to the session **by the Rust backend**:
  new command `session_send_secret(session_id, credential_id, field_key)`, which reads the
  vault and calls the same path as `session_write`. The secret never reaches JavaScript
  or the clipboard.
- No trailing newline by default; an option sends `Enter` after it.
- Credentials linked to the session's host (`host_ids`) are listed first.
- **Optional, later:** detect common prompts in the output stream (`[sudo] password for <user>:`,
  `Enter password:`, `Password:`) and show a small "Fill from vault" chip. The prompt
  text is matched in the backend; nothing is filled without a click.

### F2: "Connect" on a database credential

A **Connect** button on MySQL, Postgres, ClickHouse and Redis entries opens a terminal tab
running that database's CLI client, already authenticated.

**Network path**

- If the credential is linked to a host (`host_ids`), Keystone opens an **ephemeral local
  tunnel** through that host's jump chain: `127.0.0.1:<random free port>` → `host:port` from the
  entry. The tunnel lives exactly as long as the tab, and is not saved to `profiles.json`.
- Otherwise it connects directly to `host:port`.

**Where the client runs** (setting per credential, default *Local*)

| Mode | How | Requires |
|---|---|---|
| Local | Spawn the client in a local PTY (`LocalPty`) against the ephemeral tunnel port | Client installed on this PC |
| Remote | Open an SSH session to the linked host and run the client there | Client installed on the server |

**Passing the password: never as an argument**

| Client | Local mode | Notes |
|---|---|---|
| `clickhouse-client` | env `CLICKHOUSE_PASSWORD` (with `CLICKHOUSE_USER`) | Supported by recent ClickHouse; fall back to a temp `--config-file` with `<password>` |
| `psql` | env `PGPASSWORD` | Or a temp `PGPASSFILE` (0600) |
| `mysql` / `mariadb` | temp `--defaults-extra-file` (0600) with `[client] password=…` | `MYSQL_PWD` is deprecated; avoid |
| `redis-cli` | env `REDISCLI_AUTH` | |

- Environment variables are set **only on the child process**, never on Keystone itself.
- Temp files go in a private directory (0700 on Unix, user-only ACL on Windows) and are
  deleted as soon as the client has read them (after a short delay or when the process exits,
  whichever comes first). Deleted on app exit as a backstop.
- **Remote mode:** SSH `setenv` is usually rejected by `AcceptEnv`, so the client is started
  with an interactive password prompt and the secret is sent through the session (same
  mechanism as F1). It is never placed on the remote command line or in the remote
  shell history.

**Client discovery:** look for the binary on `PATH`, then common install locations. If it's
missing, show which client is needed and how to install it, instead of failing silently.
An optional per-credential "client path" overrides discovery.

**Extra fields on DB credentials (non-secret):** `client` (override binary), `runMode`
(`local` | `remote`), `tls` (on/off/verify), `extraArgs` (non-secret flags such as
`--multiline`).

### F3: Credential environments for terminals

"Open terminal with…" on an AWS, Kubernetes or API-token entry (or a host default):

| Kind | What the tab gets |
|---|---|
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` |
| Kubernetes | `KUBECONFIG` pointing to a temp 0600 file holding the kubeconfig from the vault |
| API token | `<NAME>=<token>`, variable name chosen on the entry |

The variables are scoped to that one local tab; nothing is written to `~/.aws` or `~/.kube`.
The temp kubeconfig is deleted when the tab closes.

### F4: Copy connection string

"Copy as URL" on database credentials, for example `clickhouse://user:pass@127.0.0.1:9000/db`.
It is built in Rust and goes through the existing `credential_copy` path, so it gets the same
clipboard auto-clear. A "Copy without password" variant is safe to paste into tickets.

### F5: Built-in query console (later)

- A new **Databases** view, with a query editor, results grid, query history (queries only,
  never credentials) and CSV export.
- Rust drivers: ClickHouse over HTTP (`clickhouse` crate), MySQL and Postgres (`sqlx`),
  Redis (`redis` crate).
- Traffic goes through an ephemeral tunnel, as in F2. The password stays in the backend.
- **Strongest option**, because no external process ever sees the secret, but also the
  largest: a new UI area plus four driver integrations.

## 3. Backend changes

New Tauri commands (all `async`; see the note in `commands.rs` about Tokio):

```text
session_send_secret(session_id, credential_id, field_key, press_enter) -> ()
db_connect(credential_id, cols, rows, on_event) -> session_id          // F2
local_open_with_env(credential_id, shell?, cols, rows, on_event) -> session_id  // F3
credential_copy_url(credential_id, include_password) -> clear_after_ms // F4
```

Core (`keystone-core`):

- `ssh::tunnel::ephemeral(chain, target) -> (port, handle)`: a `-L` on port 0 owned by
  the session and not persisted.
- `LocalPty::spawn_with(program, args, env, cwd)`: extends `pty.rs` to take an
  explicit environment for the child.
- `dbclient` module: per-kind launch recipes (binary names, env/temp-file strategy,
  argument building for host/port/user/db). This is the only place that knows the CLI
  conventions.
- `TempSecretFile`: creates a file only the user can read, overwrites the contents before
  deleting, and deletes on `Drop`.

Session bookkeeping: a DB session owns its ephemeral tunnel and temp files, and closing
the tab tears down all three.

## 4. Security notes (to add to THREAT_MODEL.md when shipped)

| Risk | Status |
|---|---|
| Secret visible in process list | **Prevented**: never passed as an argument |
| Secret in shell history | **Prevented**: never typed as part of a command |
| Environment variable read by another process | **Not prevented**: other processes running as your user can read it. Same class as T10 (malware as your user while the vault is unlocked) |
| Temp file read by another user | **Prevented** by 0600 / user-only ACL; deleted right after use |
| Temp file read by malware as your user | **Not prevented** during its short lifetime (T10) |
| Client or server logging the password | **Outside Keystone's control** once the secret is handed over |
| Remote mode: compromised server captures the password | **Not prevented**, as when typing it yourself |
| F1 sending a secret into the wrong tab | Mitigated: the picker shows the target tab and host, and nothing is sent automatically |

## 5. Plan

1. **Phase 1:** F1 (send secret) and F2 (DB connect, local mode, with ephemeral tunnel).
2. **Phase 2:** F2 remote mode, F3 (AWS/Kubernetes/token environments), F4 (copy URL), and
   prompt detection for F1.
3. **Phase 3:** F5 (query console), only if replacing DBeaver/Workbench is wanted.

Each phase ships with e2e tests in `crates/keystone-core/tests/`, using the existing in-process
SSH server for tunnels and a fake client binary that reports the arguments, environment and
temp files it receives. These tests assert that the secret never appears in the arguments.

## 6. Open questions

- Is the ClickHouse client installed on the PC or only on the servers? This decides the default
  for `runMode`.
- Should F2 reuse a running saved tunnel to the same target if one exists, instead of creating
  an ephemeral one?
- Should prompt detection (F1) be on by default, or opt-in?
- F5: is a built-in console wanted at all, or are external clients preferred?
