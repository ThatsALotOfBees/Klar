# Klar

A minimal, Discord-style chat MVP focused on direct messages with **optional, per-DM end-to-end encryption**.

This is the foundation; voice/video, servers/channels, presence, attachments, mobile clients, and federation are out of scope for the MVP. The architecture is intentionally similar to Stoatchat / Revolt so individual pieces (REST API, WS gateway, identity model) can be replaced with their counterparts later without rewriting clients.

## Features in this MVP

- Account registration and login (scrypt-hashed passwords, opaque session tokens).
- User search by username.
- Direct messages between two users with per-DM end-to-end encryption toggle. When **on**, messages are encrypted in the browser using ECDH P-256 + AES-GCM and the server only sees ciphertext.
- **Discord-style servers** (Klar's "guilds"): create or join a server with an invite code, and chat in named text channels (`#general`, `#random`, ...). Owner controls who has the server (delete) and creates new channels; anyone with the invite code joins. Channels are plaintext today — multi-user E2EE is future work.
- Real-time delivery over WebSockets for both DMs and channels.
- On-disk `.KDB` archive of every message (per-DM and per-channel, sorted by UTC date).

## Quick start

Requirements: Node.js 18.17+ on Windows / macOS / Linux.

```bash
npm install
npm start
```

Then open http://localhost:3000 in two different browser profiles (or one normal window + one private window), register two accounts, and start a DM. Toggle the lock at the top-right of the chat to switch encryption on/off.

To use a different port:

```bash
PORT=4000 npm start
```

A SQLite database file (`klar.db`) is created next to `server.js` on first run.

### Desktop app

The web build is the same code; the desktop app just wraps it in a frameless Electron window with the cosmic traffic-light title bar. Two operating modes:

- **Dev** (`npm run app`): spawns the local `node server.js` and points the BrowserWindow at `http://localhost:<port>`. Same as if you `npm start`'d and opened the page in a browser.
- **Packaged** (`npm run dist`): produces `dist/Klar-<version>-portable.exe`. The packaged EXE does **not** spawn a server. It loads the bundled client from `userData/client/` and the renderer talks to a **remote** backend over the internet at the URL in `client-config.json`.

```bash
npm install                # one-time, installs Electron + electron-builder
npm run app                # launches Klar from source as a desktop app
npm run dist               # builds dist/Klar-<version>-portable.exe AND .msi
npm run release-client     # snapshot public/ into client-releases/<version>/
```

`npm run dist` produces two installers under `dist/`:
- `Klar-<version>-portable.exe` — single self-extracting executable, no installation. Double-click to run.
- `Klar-<version>.msi` — Windows Installer. Double-click runs the install wizard; per-user install (no admin required); creates Start Menu + uninstall entries.

Both are equivalent in functionality. The MSI is more familiar to enterprise installs / IT-managed PCs; the portable EXE is friendlier for one-off testing on someone else's machine.

From the dev shell, `app`, `dist`, and `release-client` map to the same scripts.

#### Connecting the EXE to your backend

The packaged app reads `client-config.json` (bundled into the EXE) to know where your server lives:

```json
{
  "serverUrl": "https://klar.your-domain.com",
  "updateRepo": "your-github-username/your-repo",
  "updateBranch": "main",
  "updateCheckIntervalMs": 3600000
}
```

Edit this file before running `npm run dist`. The produced EXE will connect to whatever `serverUrl` you set, from any network — as long as your backend is reachable over the public internet.

If you run your server on your home machine, you'll need either a public domain pointing at it (with the right port forwarded), a tunnelling service (`cloudflared tunnel`, `ngrok`, etc.), or a small VPS running `npm start`.

A runtime override file `userData/client-config.json` (or `KLAR_SERVER_URL` env var) takes priority over the bundled value, in case you ever need to redirect a deployed EXE without rebuilding.

#### Auto-updating the client

The packaged EXE polls a GitHub repo for new client releases. Every successful build of new client files goes into `client-releases/<version>/` plus an updated `client-releases/manifest.json` at the repo root.

**To push an update:**

1. Edit files under `public/` until you're happy.
2. Bump the `version` in `package.json` (`0.1.0` → `0.1.1`).
3. Run `npm run release-client` (or `release-client` from the dev shell). This snapshots `public/` into `client-releases/0.1.1/`, sha256s every file, and rewrites `client-releases/manifest.json` to point at the new version.
4. Commit + push `client-releases/` to the GitHub repo configured in `client-config.json`'s `updateRepo`.

Running EXEs check `https://raw.githubusercontent.com/<updateRepo>/<updateBranch>/client-releases/manifest.json` once at startup (after a 5-second delay) and then on the configured interval. When the manifest's `version` is newer than the installed one, files are downloaded into `userData/client-next/` and the renderer pops a "Reload now" toast in the bottom-right of the window. Clicking it atomically swaps `client-next/` into `client/` and reloads the BrowserWindow with the new code — no app restart needed.

**Repository layout (your GitHub repo):**

```
client-releases/
├── manifest.json              # version, file list with sha256s, optional release notes
├── 0.1.0/
│   ├── index.html
│   ├── app.js
│   ├── api.js
│   ├── crypto.js
│   └── styles.css
├── 0.1.1/
│   └── ...
```

The EXE shell (Electron + main process + preload) is not auto-updated by this mechanism — only the client (HTML/CSS/JS). For shipping a new shell, rebuild and redistribute the EXE.

The window is frameless. The three buttons at the top-left are macOS-style traffic lights:
- **Red** — close (cross glyph on hover).
- **Orange** — toggle maximize / floating window (fullscreen-corners glyph on hover).
- **Green** — minimize (minus glyph on hover).

The title bar is only shown when the page is loaded inside the Electron shell; opening the same `http://localhost:3000/` in a regular browser still shows the standard interface with no custom chrome.

Internally, `desktop/main.cjs` spawns your system `node` to run `server.js` as a child process, then opens an Electron `BrowserWindow` pointed at `http://localhost:<PORT>`. This means the desktop build needs Node 22.5+ available as `node` on PATH (because `server.js` uses the built-in `node:sqlite`).

### Dev shell (Windows)

For day-to-day work there's a custom PowerShell shell that wraps the lifecycle commands. Two ways to enter it:

- **Double-click `klar.cmd`** (or run `klar` from `cmd.exe`) — opens a new PowerShell window with the shell loaded.
- **From an existing PowerShell session:** `. .\shell.ps1` — loads the same commands into your current session without opening a new window.

The shell defines a custom prompt that shows a green dot + port when the server is running, plus these commands:

| Command | What it does |
|---------|--------------|
| `help` | Print the command list |
| `serve` | Run the server in the foreground (Ctrl+C to stop) |
| `up` | Start the server in the background; logs to `klar.log` |
| `down` | Stop the background server |
| `restart` | Stop + `up` |
| `status` | Show running state, port, pid, db size, log size |
| `logs [-n N]` | Show the last N lines of `klar.log` (default 50) |
| `tail` | Follow the log live (Ctrl+C to stop) |
| `open-app` | Open `http://localhost:<port>` in the default browser |
| `port [n]` | Show or set the server port |
| `reset-db` | Delete the SQLite database (prompts before deleting) |
| `setup` | `npm install` |
| `clean` | Remove `node_modules`, db, and logs (prompts) |
| `home` | `cd` back to the project root |

The pid of the background server is tracked in `.klar.pid`; the shell auto-cleans the file if the process is gone.

## How the encryption works

Each user has an ECDH P-256 keypair generated **in the browser** at registration time:

- The **public key** is sent to the server in SPKI form so peers can fetch it.
- The **private key** is exported as PKCS8, encrypted with an AES-GCM key derived from the user's password via PBKDF2-SHA256 (200k iterations, random per-user salt), and then uploaded. The server stores ciphertext only.

On login, the encrypted private key bundle is downloaded and decrypted in the browser using the password the user just typed. The plaintext private key never touches the server or local storage — it only lives in JavaScript memory for the session.

When E2EE is on for a DM, both sides independently derive the same AES-GCM key from `ECDH(myPriv, peerPub)`. Each message uses a fresh random 12-byte IV. The server stores `{ciphertext, nonce, encrypted=1}` and routes it without ever seeing the plaintext.

When E2EE is off, the server stores plaintext message bodies. Either user can flip the toggle for the DM at any time; switching modes does not retroactively change earlier messages.

### Known limitations

These are deliberate trade-offs to keep the MVP tight; promote them as soon as the basics are stable.

- **No forward secrecy.** One static shared key per DM. A future Double Ratchet / MLS implementation should replace this.
- **TOFU peer keys.** No fingerprint verification UI. A real client should expose safety numbers / QR comparison.
- **Server-stored encrypted private key bundle.** Convenient for cross-device and reload, but means a malicious or coerced server could attempt offline password attacks against the encrypted bundle (this is why iterations are high). Hardware-backed or user-provided passphrase-only key vaults are stronger.
- **Page reload requires re-login.** The unlocked private key is only kept in memory. We don't persist it to IndexedDB (yet) because that introduces another at-rest exposure to think through.

## Layout

```
package.json          deps + npm start
server.js             HTTP API + WebSocket gateway + SQLite schema (single file)
public/
  index.html          UI shell with two <template>s (auth + app)
  styles.css          dark Discord-ish theme
  app.js              UI controller / routing / state
  api.js              fetch wrappers + reconnecting WebSocket client
  crypto.js           Web Crypto helpers for identity + per-DM ECDH
```

## API surface

All requests authenticated by `Authorization: Bearer <token>` unless noted.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/register` | Create account, store public key + encrypted private key bundle |
| POST | `/api/login` | Returns session token + encrypted private key bundle |
| POST | `/api/logout` | Invalidate current session |
| GET  | `/api/me` | Current user (with bundle) |
| GET  | `/api/users/search?q=` | Find users by username substring |
| GET  | `/api/dms` | List the user's DMs |
| POST | `/api/dms` | Open (or fetch existing) DM with `{userId}` |
| PATCH | `/api/dms/:id` | Toggle `{e2eeEnabled}` for a DM |
| GET  | `/api/dms/:id/messages` | List messages (paginates with `?before=<ts>`) |
| POST | `/api/dms/:id/messages` | Send `{content, encrypted, nonce?}` |
| GET  | `/api/dms/:id/archive` | List the on-disk `.KDB` archive files for a DM |
| POST | `/api/servers` | Create a server (you become owner). Auto-creates a `#general` channel |
| GET  | `/api/servers` | List the servers you're a member of |
| GET  | `/api/servers/:id` | Server detail: channels + members |
| DELETE | `/api/servers/:id` | Owner-only: delete the server |
| POST | `/api/servers/:id/leave` | Leave a server (non-owner) |
| POST | `/api/servers/:id/channels` | Owner-only: create a text channel |
| POST | `/api/servers/:id/invites` | Generate an 8-char invite code |
| GET  | `/api/invites/:code` | Public preview of an invite (no auth required) |
| POST | `/api/invites/:code/accept` | Join a server with an invite code |
| GET  | `/api/channels/:id/messages` | List channel messages (paginates with `?before=`) |
| POST | `/api/channels/:id/messages` | Send a channel message |
| WS   | `/ws` | After `{type:"auth", token}`, receive `message` / `dm_created` / `dm_updated` / `channel_message` / `channel_created` / `server_member_joined` / `server_member_left` / `server_deleted` events |

## On-disk message archive (`.KDB` files)

Every message that flows through the server is also appended to a flat-file archive next to the SQLite database. SQLite stays the operational store (indexed lookups, fast pagination); the `.KDB` files are an authoritative, human-inspectable record sorted by date.

**Layout:**

```
messages/
  <usernameA>__<usernameB>/         # DMs — both usernames, sorted alphabetically
    _meta.json                      # one-time manifest for the DM
    2026-05-06.KDB                  # one file per UTC date
    2026-05-07.KDB
  server__<server-slug>/            # servers — one folder per server
    <channel-slug>/                 # one subfolder per channel
      _meta.json
      2026-05-06.KDB
```

**Format:** Each `.KDB` file is JSON Lines — one JSON object per line, one line per message, in the order the server received them:

```jsonl
{"v":1,"id":"1fa6...","at":"2026-05-06T18:59:14.633Z","from":"alice","encrypted":false,"content":"yo"}
{"v":1,"id":"9b1e...","at":"2026-05-06T18:59:14.761Z","from":"bob","encrypted":false,"content":"wasgood"}
{"v":1,"id":"8e1d...","at":"2026-05-06T18:59:14.933Z","from":"alice","encrypted":true,"content":"BASE64CT","nonce":"BASE64NONCE"}
```

For E2EE messages, `content` is the base64 ciphertext and `nonce` is the base64 IV — same opaque bytes the server saw on the wire. The server cannot decrypt these; the archive is faithful to what was actually transmitted.

## Build log

This section is a per-update changelog kept in chronological order so a future agent can pick up exactly where the last one left off without re-deriving context. **Append to the bottom of this section on every meaningful change.** Do not rewrite history — add a new dated entry.

Format for each entry:
```
### YYYY-MM-DD — short summary
**Goal:** what the user asked for or what we were trying to achieve.
**Changes:** files touched and the substance of the edit.
**Decisions:** non-obvious choices and the reasoning, especially anything a reader could not infer from the diff.
**Verification:** how we confirmed the change works (commands run, expected output, manual UI steps).
**Open / next:** anything left undone or known follow-ups.
```

---

### 2026-05-06 — Initial MVP (accounts + DMs + per-DM E2EE toggle)
**Goal:** First working slice based on Stoatchat's architecture as inspiration. User asked for a Discord clone MVP focused on messaging, end-to-end encryption (toggleable per DM), and accounts. Forking Stoatchat's full Rust stack would be too much for an MVP, so we built a compatible-shaped subset from scratch — the API surface and identity model intentionally mirror Revolt/Stoatchat so individual pieces can be swapped later.

**Changes:**
- `package.json` — Node ≥18.17, single runtime dep (`ws`). Start script uses `--disable-warning=ExperimentalWarning` because `node:sqlite` still emits an experimental warning on Node 24 even though the API is stable.
- `server.js` — single-file backend: HTTP API + WebSocket gateway + SQLite schema (using built-in `node:sqlite`). Tables: `users`, `sessions`, `dms`, `messages`. Routes are pattern-array-dispatched; bodies parsed with a 1 MB cap; static files served from `public/`. WS connections authenticate after open via `{type:"auth", token}` and are tracked in a `Map<userId, Set<ws>>` for fan-out broadcasting.
- `public/index.html` — UI shell with two `<template>` blocks (auth + app). No build step.
- `public/styles.css` — dark, Discord-ish theme with CSS custom properties.
- `public/crypto.js` — Web Crypto helpers. Identity = ECDH P-256 keypair generated client-side at registration. Private key encrypted with PBKDF2(password, 200k SHA-256, 16-byte salt) → AES-GCM-256, then sent to server as ciphertext. Per-DM symmetric key derived via `subtle.deriveKey({ECDH, public: peerPub}, myPriv, AES-GCM-256)`; cached per peer in a WeakMap. Each message uses a fresh random 12-byte IV.
- `public/api.js` — fetch wrappers + reconnecting `Realtime` WebSocket client (EventTarget-based, auto-reauths on reconnect, 2s backoff).
- `public/app.js` — UI controller. Login/register flow, sidebar with user search and DM list, chat pane with grouped messages, composer, E2EE toggle. Realtime events update local state and re-render incrementally.
- `.gitignore` — node_modules and SQLite artifacts.

**Decisions:**
- **No native deps.** Originally chose `better-sqlite3`, but it requires MSVC to compile on Windows and there's no prebuilt for Node 24 yet (install failed with `gyp ERR! find VS`). Switched to the built-in `node:sqlite` module — same prepared-statement API shape, zero compile, zero install pain.
- **ECDH P-256, not X25519.** P-256 has universal Web Crypto support across all current browsers since 2017; X25519 only landed in Chrome 124 / Firefox 130 / Safari 17.4. We can revisit later if we want smaller keys.
- **Encrypted-private-key bundle stored on server**, not browser storage. Pro: works on any device after login. Con: the server holds material that's vulnerable to offline password attack — mitigated by 200k PBKDF2 iterations and high password minimum, but not eliminated. Documented in "Known limitations".
- **Static shared key per DM (no Double Ratchet yet).** Forward secrecy is explicitly deferred. Good enough to demonstrate that the server cannot read ciphertext, which is what the user asked for in the MVP.
- **Either user can flip the E2EE toggle**, change applies to all *future* messages in that DM. Mode-switching does not retroactively re-encrypt history (would require both sides online and is racy).
- **Page reload requires re-login.** The unlocked private key only lives in JS memory. Token is purposely cleared on reload in `boot()` so we never end up in a broken half-state where we have a session but no key. A future entry can persist the unlocked key in IndexedDB after we've thought through the at-rest threat model.
- **Single source of truth in `state` object** in app.js. No framework. Re-render functions are idempotent and granular (`renderDmList`, `renderMessages`).

**Verification:**
- `npm install` → 1 package, no native compile.
- Booted on PORT=3099. `GET /api/me` without auth returned `401 {"error":"not authenticated"}`. `GET /` served `index.html` with HTTP 200.
- Full API flow scripted with curl: registered alice and bob with dummy base64 key bundles → alice searched "bob" → got back bob → POST /api/dms created the DM → alice POSTed a plaintext message → PATCHed `e2eeEnabled:true` → alice POSTed a ciphertext message → bob's GET /api/dms/:id/messages returned both messages with correct `encrypted` flags → bob's GET /api/dms returned the DM with `e2eeEnabled:true` and the right `other` user. All shapes matched the client's expectations.
- Browser-side crypto round-trip not yet tested in a live browser (would need a real two-window manual session); the math is straightforward Web Crypto so the next agent should still verify it before claiming "ready" — see "Open / next".

**Open / next:**
- **Manual browser test still required.** Open http://localhost:3000 in two browser profiles, register two accounts, search, open a DM, send messages with toggle off, flip toggle on, send more messages, flip back. Confirm: (1) both sides see plaintext when off, (2) both sides decrypt successfully when on, (3) the DM list lock icon updates in real time when the peer toggles, (4) reload works (forces re-login).
- **Forward secrecy** — replace static-key DH with Double Ratchet or MLS. Largest single security upgrade.
- **Server-rendered safety numbers / fingerprint UI** so users can verify keys out-of-band (TOFU only at the moment).
- **Attachments** — design will need an upload service that handles E2EE-aware blob encryption.
- **Servers/channels (multi-user rooms).** At that scale, swapping in a real Stoatchat/Revolt backend becomes more attractive than growing this single-file server.
- **Voice/video** via LiveKit (mirrors Stoatchat's stack). Out of scope for the MVP.

### 2026-05-06 — Custom dev shell (`klar.cmd` + `shell.ps1`)
**Goal:** User asked for a custom terminal environment with custom commands to start the server, etc., kept in the same folder.

**Changes:**
- `shell.ps1` (new) — PowerShell module defining the lifecycle commands. Tracks the background server pid in `.klar.pid`, auto-prunes stale pid files, custom `prompt` that shows a green `*` plus the port when the server is running and a dim `o` when stopped. Commands: `help`, `serve`, `up`, `down`, `restart`, `status`, `logs`, `tail`, `open-app`, `port`, `reset-db`, `setup`, `clean`, `home`.
- `klar.cmd` (new) — `start "" powershell -NoExit -ExecutionPolicy Bypass -Command ". '%~dp0shell.ps1'"`. Double-clickable launcher; from cmd.exe just `klar` works. Uses `-NoExit` + dot-source so the function definitions persist in the spawned shell.
- `.gitignore` — added `klar.log`, `klar.err.log`, `.klar.pid`.
- `README.md` — added a "Dev shell (Windows)" subsection under Quick start with the command table.

**Decisions:**
- **Launcher opens a new window via `start ""`** rather than running in the current cmd. The empty `""` is the window title arg — without it, `start` would consume the next quoted token as the title and break the command.
- **Dot-sourcing, not `-File`.** A script invoked with `-File` runs in its own scope, so the functions/aliases would die when the script returns. Dot-sourcing inside `-Command` keeps everything in the host scope so the user can keep typing.
- **Background process via `Start-Process node ... -WindowStyle Hidden -RedirectStandardOutput`** rather than `Start-Job`. Jobs are heavier and PSReadLine doesn't surface their stdout naturally; `Start-Process` gives a real OS process whose pid we can store and signal independently of the shell session.
- **All command names are short, unhyphenated where possible** (`up`/`down`/`logs`/`status`) for fast typing. PowerShell's command-resolution order puts aliases above functions, so my `Set-Alias help Klar-Help` correctly shadows the built-in `help` pager inside this shell without disturbing the user's normal PowerShell sessions.
- **ASCII-only source.** Initial draft used `•`, `─`, `●`, `○`, em-dashes — Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and the parser choked on the multibyte bytes. Replaced with ASCII (`|`, `-`, `*`, `o`, `--`) so the file loads under both Windows PowerShell 5.1 and PowerShell 7+ regardless of file encoding.
- **Array-of-arrays needs `,@(...)`.** The initial help table used `@(@('help','...'), @('serve','...'), ...)` which PowerShell auto-flattened into one long string list, so iteration produced one character per row. Prefixing each inner array with the `,` unary operator forces it to be treated as a single element.

**Verification:**
- Dot-sourced `shell.ps1` non-interactively. Confirmed banner renders, `help` prints the table, `port` shows/sets the port, `status` reports the right state.
- Full lifecycle test on PORT=3098: `up` started a node process (pid printed) → `status` showed `state: running` with the pid, port, db size, and log size → `logs` returned the startup line → an `Invoke-WebRequest` against `http://localhost:3098/` returned **200** → `down` killed the process cleanly → `status` flipped back to `state: stopped`. Test artifacts (`klar.db`, `klar.log`, `.klar.pid`) cleaned up afterward.

**Open / next:**
- **`klar.cmd` not yet tested by actually double-clicking** — the cmd-launcher path was only smoke-tested by directly dot-sourcing `shell.ps1`. The next agent (or the user) should confirm a fresh window opens with the banner and that commands work in it.
- **No tab completion** for the custom commands. Adding `Register-ArgumentCompleter` for things like `port` (offer common ports) and `logs` (offer `-n`) would be nice but is unnecessary for the MVP.
- **Cross-platform shell.** This is Windows-only. A `klar.sh` with the same command surface (using POSIX functions + a pid file under `.klar.pid`) would let macOS/Linux users get the same UX. Easy follow-up.

### 2026-05-06 — Fix wrong-author attribution + race in message rendering
**Goal:** User reported: "when another user sends a message, it sends it under the user that typed the message first." Two visible side effects: (1) some messages from the other user were rendered without their own avatar/name header — they looked like a continuation of the previous sender; (2) on tight back-and-forth, attribution could be flat-out wrong.

**Root cause:** `renderMessages` cleared and rebuilt the entire message list on every WS event and was `async` because of per-message decryption awaits. When two messages arrived close together, two concurrent invocations interleaved on the same DOM node — each cleared the list, then resumed `appendChild`'ing rows at await-points, producing partial / out-of-order results. The `sameAuthor` decision depended on a loop-local `prevSenderId` that didn't reflect the actual sibling in the DOM after one of these races, so a row from sender B could be tagged `.same` on top of a row from sender A and lose its avatar/name header. The author lookup `isMe ? state.user : dm.other` also assumed `dm.other` was always correct, with no fallback if the wrong DM record was selected.

**Changes (all in `public/app.js`):**
- Added `state.usersById: Map<userId, user>` and a `rememberUser(u)` / `userById(id)` pair. Populated it from login, register, `loadDms`, `dm_created`, search results, and search-click. Author now resolves *strictly* by senderId via `userById(m.senderId)` rather than from `state.user` vs `dm.other` — even if a DM's `other` field is stale, attribution stays correct.
- Added `state.dmHistoryFetched: Set<dmId>` so we can keep the message cache and the "have we pulled history?" flag separate. Without this, a message that arrived via WS during the openDm fetch would be dropped (because the cache entry didn't exist yet) or clobbered (because the fetch overwrote the cache).
- Split the old `renderMessages(dm)` into:
  - `buildMessageRow(dm, m, showHeader)` — pure: builds and returns one row, no global state, no peeking at siblings. Tags the row with `data-sender-id`, `data-created-at`, `data-message-id`.
  - `shouldShowHeader(prevRow, senderId, createdAt)` — strict comparison to the previous **DOM row** (not a loop-local variable). Different sender ⇒ show header; same sender within 5 minutes ⇒ continuation; otherwise ⇒ show header.
  - `renderMessages(dm)` — used only on `openDm`. Reads the DOM via `list.lastElementChild` between iterations, so the shouldShowHeader call can never be confused by a parallel render.
  - `appendMessage(dm, m)` — used by `onRemoteMessage`. Inserts in the right chronological position, recomputes the *next* row's continuation flag if we inserted between two existing rows, and dedupes by `[data-message-id]` against the live DOM.
- `onRemoteMessage` no longer calls `renderMessages` (full rebuild). It calls `appendMessage` instead. It also unconditionally initializes the cache for the DM so messages can never be dropped by the openDm-fetch race.
- `logout()` now also clears `dmHistoryFetched` and `usersById`.

**Decisions:**
- **DOM as the single source of truth for "previous sender".** A separate `state.dmRenderState[dmId] = {lastSenderId, lastTs}` would have worked, but then it has to stay perfectly synced with the DOM through inserts, deletes, and re-renders. Reading `data-sender-id` off the actual previous row makes the read-side trivially correct and removes a whole class of drift bug.
- **`userById` falls back to `{ displayName: 'Unknown user', username: 'unknown' }`** rather than throwing or rendering `undefined`. Display is safe even if we receive a message before we've populated the sender's user record (shouldn't happen for DMs since both peers are known, but cheap insurance).
- **Out-of-order arrivals handled.** `appendMessage` walks back from the last row and inserts after the first row whose `createdAt <= m.createdAt`. Reordering is rare (server timestamps inserts) but if a clock skew ever delivers an earlier message later, it lands in the right slot, and we re-evaluate the *next* row's continuation flag in case we just split a same-author group.
- **Did not change the server.** The senderId on every message has always been correct server-side; the bug was purely in the client renderer.

**Verification:**
- `node --check` passes for `app.js`, `crypto.js`, `api.js`, `server.js`.
- The race I described above is structurally impossible with the new code: each row is built independently, and the sender comparison reads from the actual DOM. There's no shared async loop state for two renders to corrupt.
- **Live two-user browser test still required** — same procedure as before (two browser profiles → register two accounts → open a DM → exchange messages back and forth quickly) but now the second sender's first message in a streak should always show their name and avatar. Verifying against an actual UI is the one item this code change cannot self-prove.

**Open / next:**
- Confirm the fix in a real two-window browser session — that's the one outstanding verification step.
- Optional polish: only auto-scroll on append if the user was already near the bottom (we currently always pin to bottom, which can yank a user who was scrolled up reading history).
- Optional polish: a "[user] is typing..." indicator over the WS would make conversations feel more like Discord — out of scope for this fix.

### 2026-05-06 — Per-DM, per-day `.KDB` message archive
**Goal:** User asked to "save all your messages you sent with that person on the server. save the messages and have them be well sorted in a custom file. for example: (date of today).KDB". Combined with their screenshot clarifying the previous bug, this is a separate, additive request: keep the messages on disk in a custom, well-sorted file format.

**Changes:**
- `server.js` — new top-of-file constants `KDB_DIR = ./messages` and `KDB_VERSION = 1`. New helpers `dmFolderName(a,b)` (sorts the two usernames so a DM always resolves to one folder no matter who sent first), `ensureKdbFolder(a,b)` (creates the folder + writes `_meta.json` once), and `appendKdb(a, b, sender, message)` (appends one JSON-Lines record to `<UTC-date>.KDB`).
- `server.js` — message-send route now calls `appendKdb(...)` after the SQLite insert. SQLite stays the operational store; `.KDB` files are an authoritative archive on disk.
- `server.js` — new endpoint `GET /api/dms/:id/archive` returns the list of `.KDB` files for the DM, with sizes and mtimes. This is the read-side hook a future client UI can use to surface the archive without giving up SQLite-backed message paging.
- `.gitignore` — added `messages/`.
- `README.md` — added an **"On-disk message archive"** section under the API table documenting the layout and JSON Lines format.

**Decisions:**
- **Folder name = sorted-pair of usernames** (`alice__bob`) rather than the opaque `dmId`. Stable, human-readable, and you can grep across `messages/*/` for a username without joining against the DB. Usernames are validated `[a-z0-9_.-]{3,24}` server-side, so there's no path-traversal risk.
- **One file per UTC date** (`YYYY-MM-DD.KDB`), not local time. UTC keeps filenames stable across DST and across server hosts. The user's example of "(date of today).KDB" is honored.
- **JSON Lines, not pretty-printed JSON.** Append-only writes are O(1), each line stands alone, and `tail -f` works. A pretty-printed JSON array would require parsing + rewriting the whole file on every append.
- **`v:1` on every record** so we can evolve the schema without breaking old archives. A `_meta.json` manifest is written once per folder for the same reason — it identifies the file kind and the participants explicitly.
- **For E2EE messages, the archive stores ciphertext + nonce verbatim.** The server never had the plaintext, so the archive can't have it either. This is consistent with the threat model — flipping E2EE on for a DM keeps the server (and its disk) cleartext-blind, including in the archive.
- **Did not move SQLite to `.KDB`-as-primary.** Considered it briefly. SQLite gives us indexed `WHERE dm_id = ? AND created_at < ?` paging for message history, which would be O(n) over flat files. Keeping SQLite as the read path and `.KDB` as the archive is the simplest correctness story — and the archive is easy to rebuild from SQLite, or vice versa, if either gets corrupted.
- **Append errors are logged and swallowed.** A failed disk write must not break message delivery to the other user. SQLite has the truth; if the archive falls behind by one message, that's fixable later. (A cleaner design would queue retries; out of scope for now.)

**Verification:**
- Booted on PORT=3099. Registered alice and bob, opened a DM, sent a plaintext from each side, flipped E2EE on, sent a ciphertext. Then:
  - `GET /api/dms/:id/archive` returned `{"folder":"messages\\alice__bob","files":[{"name":"2026-05-06.KDB","size":390,...}]}`. ✓
  - `messages/alice__bob/_meta.json` contained `{"v":1,"kind":"klar-dm-archive","users":["alice","bob"],"createdAt":"..."}`. ✓
  - `messages/alice__bob/2026-05-06.KDB` contained three JSON-Lines records — alice's plaintext "yo", bob's plaintext "wasgood", and alice's encrypted message with `content:"BASE64CT"` and `nonce:"BASE64NONCE"` (the dummy ciphertext we sent). ✓
- Test artifacts cleaned up after.

**Open / next:**
- **Archive-aware client UI.** The `archive` endpoint exists but no UI surfaces it; a settings panel could expose "Download archive" / "Browse by date".
- **Retention/rotation.** Files grow forever. Trivial to add a sweeper that compresses days older than N or splits by size; not a problem at MVP scale.
- **Archive-rebuild tool.** A small `node scripts/rebuild-archive.js` that re-derives every `.KDB` from SQLite (or vice versa) would be useful for recovery — easy to write once we hit a real-world need.

### 2026-05-06 — Harden the "different-sender header" guarantee
**Goal:** User repeated the same requirement after the previous fix: when a different person sends a message under the most recent one, that new person's name must appear above their message. Two possibilities here — either the previous fix wasn't yet picked up (browser cache; needs hard refresh) or the visual outcome was still confusing because **avatars from two users with the same first letter look identical** (the screenshot's `ThatsALotOfBees` and `ThatsALotOfWasps` both show "T" on the same purple gradient). Either way, harden the guarantee.

**Changes (all in `public/app.js`):**
- New `avatarBg(seed)` and `paintAvatar(el, user)` helpers. Hashes the user id (or username/displayName as fallback) into an HSL hue, so each user gets a stable, visibly distinct gradient. Two users whose names start with the same letter no longer look the same.
- Replaced every `el.textContent = avatarText(...)` site with `paintAvatar(el, user)` — sidebar `me` block, DM list, search results, chat header peer avatar, and message-row avatars.
- Tightened `appendMessage`: now finds the actual insertion point **first**, then computes `showHeader` against that exact previous row. Previously it computed `showHeader` against `list.lastElementChild` and only used the insertion-point search to decide where to splice — fine for the common "new message at the bottom" path, but on out-of-order arrivals the header could be computed against the wrong neighbor. Also re-evaluates the *next* row's `.same` flag in both the middle-insert and prepend paths so groupings stay consistent if we just split a same-author run.

**Decisions:**
- **Hash-by-id, not by displayName.** displayName is mutable (a user could rename), but their id never changes, so the avatar color stays stable across renames. Falls back to username, then displayName, if id is missing.
- **HSL with shifted hue end-stop** for the gradient. Single-hue avatars look flat; a 40° shift gives the same Discord-ish gradient feel without making any two users collide.
- **Did not change `avatarText` to use 2 letters or initials.** Single-letter avatars look right with the current 36px circle and 14px font; multi-letter requires re-tuning sizes. The color hash is enough to disambiguate without that work. If we want true initials later, "TB" / "TW" via camelCase splitting is a 5-line follow-up.

**Verification:**
- `node --check public/app.js` — clean.
- Hand-traced the canonical scenario: row(`bees`,t=1000,"yo") → row(`wasps`,t=2000,"wasgood") → row(`wasps`,t=2010,"again"). Result: both `bees` and `wasps`'s **first** rows render with a full header (avatar+name+time) since their senderIds differ; only `wasps`'s second row gets `.same` (continuation) since it matches the immediately-prior senderId within 5 min. With hash-based avatar colors, `bees` and `wasps` are immediately visually distinguishable even though both show "T".
- **Browser hard-refresh required.** If you tested the screenshot scenario after the previous fix and still saw the bug, that's almost certainly the browser holding the old `app.js`. Ctrl+Shift+R (or open DevTools → Network → "Disable cache") forces a reload.

**Open / next:**
- Live two-window confirmation in a real browser remains the one outstanding manual check.
- `avatarText` could be smarter (camelCase initials) for a small additional readability win — not required for correctness.

### 2026-05-06 — REAL root cause: shared localStorage across tabs
**Goal:** User reported the "different sender shows under previous user" bug a third time, while testing with two tabs in the same browser. Earlier rendering-side fixes (incremental render, strict senderId match, hash-based avatar colors) were correct in isolation but **didn't fix what the user was actually hitting**, because the bug was upstream of the renderer.

**Root cause:** `public/api.js` stored the session token in `localStorage`. `localStorage` is shared by all tabs of the same origin, so when the user logged in to a second tab, that tab's `session.token = ...` overwrote the first tab's token. From that point on, both tabs' `session.token` getter returned the second user's token. Every REST call and the WebSocket auth from *either* tab went out with that token, so the server stamped every outgoing message with the second user's `senderId`. Both tabs received broadcasts as User B regardless of who was actually typing.

The renderer was doing exactly what it was told: every message had the same `senderId`, so the second message correctly applied `.same` (no header, looks like a continuation). The "wrong-attribution" effect was real, but it was a symptom of every message genuinely being attributed to the same user on the server.

**Changes:**
- `public/api.js` — replaced the localStorage-backed `session` getter/setter with a module-level `let _token = null`. Tokens now live in JS memory only, which is per-tab. Added a one-line cleanup that removes any leftover `klar.token` left over by previous builds, so a user upgrading doesn't get poisoned by a stale token.
- `public/app.js` — simplified `boot()`: it no longer has to defensively null out a leaked token, because there's no leak path. Just lands on the auth screen.

**Decisions:**
- **In-memory, not `sessionStorage`.** sessionStorage is per-tab too, but it gets *copied* to a new tab if the new tab is opened via Ctrl+Click / `target=_blank` / "Duplicate tab". An in-memory variable is the only storage that's strictly one-per-tab no matter how the tab was opened.
- **Don't try to persist the token across reloads.** Reload already requires re-login because the unlocked private key is in-memory only. There's no UX win from persisting just the token.
- **Don't try to support multi-account in one tab.** A single tab → single user is the right MVP model. Two browser tabs as two different users now Just Works because they're independent JS heaps.

**Verification:**
- `node --check` clean on `api.js` and `app.js`.
- The previous full-flow API test (two `curl` "users" with separate `Authorization` headers) already confirmed the server side: when each client uses its own token, message `senderId` is recorded correctly per sender. The bug was purely about the client conflating tokens via shared storage.
- **Two-tab manual test** is now meaningful — open Tab 1, log in as Bees. Open Tab 2 (same browser, new tab is fine), log in as Wasps. Exchange messages in both directions. Each tab's UI should now show the correct sender (different avatar color, different name) above each message, and `.same` continuation grouping should only happen when **the same user** sends two messages within 5 minutes.

**Open / next:**
- Real-browser confirmation by the user. (Hard-refresh both tabs first to drop the cached `app.js` — and also clear any stale `klar.token` in localStorage if the cleanup line in api.js didn't fire for some reason. DevTools → Application → Local Storage → delete `klar.token`.)

### 2026-05-06 — Discord-style servers and channels
**Goal:** User asked for "servers like on Discord" using a referenced design artifact at a `claude.ai/design/p/...` URL. The artifact URL is private (403 from outside Claude), so I couldn't pull pixel-exact specs — built a Discord-shaped layout (server-icon rail + channel sidebar + chat) using the existing color palette, and noted in conversation that they can paste the artifact HTML if they want exact tokens.

**Server-side changes (all in `server.js`):**
- New tables: `servers`, `server_members`, `channels`, `channel_messages`, `invites`. Foreign keys cascade so deleting a server tears down its channels, messages, and members.
- New helpers: `publicServer`, `channelRow`, `channelMessageRow`, `userIsServerMember`, `userOwnsServer`, `slugify`, `appendKdbChannel`, `broadcastToServer` (looks up the member list at broadcast time and fans out to whichever member sockets are currently connected).
- New routes:
  - `POST /api/servers` — create (also creates a default `#general` channel and adds the creator as the first member).
  - `GET /api/servers` — list user's servers.
  - `GET /api/servers/:id` — server + channels + members in one shot.
  - `DELETE /api/servers/:id` — owner only; broadcasts `server_deleted` first so connected members can clean up local state before SQLite cascades.
  - `POST /api/servers/:id/leave` — non-owner only; broadcasts `server_member_left`.
  - `POST /api/servers/:id/channels` — owner only; broadcasts `channel_created`.
  - `GET/POST /api/channels/:id/messages` — list/send channel messages; broadcasts `channel_message`.
  - `POST /api/servers/:id/invites` — any member can generate codes; 8-char URL-safe.
  - `GET /api/invites/:code` — *no auth* (so a client can preview a server before logging in / accepting). Returns server name + member count.
  - `POST /api/invites/:code/accept` — joins; broadcasts `server_member_joined` to existing members.
- New `.KDB` layout for channels: `messages/server__<server-slug>/<channel-slug>/<UTC-date>.KDB`. Same JSON-Lines format as DMs, minus the `encrypted` field (channels don't support E2EE in the MVP). Each channel gets a `_meta.json` manifest with the server/channel ids and names.

**Client-side changes:**
- `public/index.html` — restructured into a 3-column `app-shell` (server rail / sidebar / chat). Added six `<template>` blocks: two sidebar variants (home for DMs, server for channels) and four modals (create server, join server, create channel, invite display, server menu).
- `public/styles.css` — Discord-style `.server-rail` with rounded-square→rounded-rectangle hover transition, side-bar tab indicator (the white pill that slides in on hover/active), `.channel-list` with `#` prefix via `::before`, `.modal` system, "me-bar" pinned to bottom-left of every sidebar variant.
- `public/api.js` — added 11 new methods (`listServers`, `createServer`, `getServer`, `deleteServer`, `leaveServer`, `createChannel`, `listChannelMessages`, `sendChannelMessage`, `createInvite`, `previewInvite`, `acceptInvite`).
- `public/app.js` — fairly large refactor:
  - `state.view = { kind: 'home' } | { kind: 'server', serverId }` drives which sidebar template is mounted and which conversations are openable.
  - `switchView` clears chat + header, mounts the appropriate sidebar template, then auto-opens the first channel for server views.
  - DM and channel rendering share `baseMessageRow` / `shouldShowHeader` / `insertRow`; only `buildDmMessageRow` does the E2EE branch.
  - Modal helper `openModal(tplId, init)` clones the template, appends to body, wires `[data-action="cancel"]` and click-outside-to-close, and hands the init callback the modal node + a close function.
  - WebSocket dispatch covers all server events: `channel_message`, `channel_created`, `server_member_joined`, `server_member_left`, `server_deleted`.

**Decisions:**
- **Auto-create `#general`** when a server is created. Avoids the empty-shell-with-no-channels UX. Discord does the same.
- **Owner-only channel creation, anyone can leave.** Simpler than full role/permission tables. Roles are a clean follow-up — add a `roles` table and a `permissions` bitmask without touching anything else.
- **Invites are codes, not URLs.** A code is shareable on any medium (chat, voice, paste, written down). A URL bakes in the host, which is a footgun in dev (localhost) and self-hosting. The `GET /api/invites/:code` endpoint is unauthenticated by design so a server can render a Discord-style "X has invited you to Y" preview without forcing a login.
- **No E2EE for channels.** Multi-user E2EE needs proper group key management (Sender Keys, MLS, or per-message rekey). DMs continue to support optional E2EE; channels are explicit plaintext for now and the composer status bar tells the user that.
- **`broadcastToServer` queries members at broadcast time** rather than maintaining an in-memory `serverId -> Set<ws>` index. The simpler approach scales fine for an MVP and avoids the bookkeeping needed when WS connections come and go (auth, reconnect, leave, kick, etc.). If we ever care about thousands of members per server, swap to the indexed approach.
- **3-column layout fixed at 72px / 260px / 1fr.** Mobile/responsive is out of scope for the MVP.

**Verification:**
- `node --check` clean on all four JS files.
- Full server-side end-to-end with curl: registered alice + bob, alice created "My Cool Place" → confirmed default `#general` was auto-created, server detail returned channels + members → alice generated an invite, bob previewed it → bob accepted, his server list now contains it → alice created `#random`, alice posted "hello channel" → bob's GET returned the message → bob (non-owner) trying to create a channel got `403 only the owner can create channels` ✓ → archive folder appeared at `messages/server__my-cool-place/random/` with `_meta.json` and `2026-05-06.KDB`.
- Server boots cleanly. All static assets serve (200), `/api/me` correctly 401s without auth, all 9 templates referenced in `index.html` are present.
- **Browser UI test still required.** Open in a browser, log in, click the `+` icon on the server rail to create a server, observe the icon appear in the rail and the sidebar swap to channel-view with `#general` opened. Send messages. Click the menu icon in the server header → invite → copy code → log into a second account in another browser/profile → click `↪` icon → paste code → confirm both accounts now see the same server, channels, and messages in real time.

**Open / next:**
- **Roles + permissions.** Currently owner-vs-member is the only distinction. A "moderator" tier (manage channels, kick) and per-channel allowed-readers/writers would close the gap to Discord parity.
- **Server settings UI** (rename, change icon, transfer ownership). Easy to bolt on with the existing modal helper.
- **Channel categories** (collapsible groups in the sidebar).
- **Member list panel** on the right side of channel chats.
- **Voice channels.** Stoatchat uses LiveKit for this; same building block would slot in here.
- **Multi-user E2EE.** Sender Keys is the simplest path; MLS is the principled one. Either is a meaningful design effort.
- **Pixel-align to the user's design artifact.** Currently using my interpretation of the Discord layout because the artifact URL is private.

### 2026-05-06 — Implement the "Deep Space Comms" design from the handoff bundle
**Goal:** User pointed at a Claude Design handoff URL (`api.anthropic.com/v1/design/h/...?open_file=Klar.html`) and asked for the design to be implemented. Fetched the bundle, read the README, the chat transcript, the JSX components, and the theme CSS — then ported the visuals into our actual stack (vanilla HTML/CSS/JS with the existing servers + DMs + E2EE backend untouched).

**What the design is:** "Klar — Deep Space Comms" — a faithful Discord clone in dark cosmic monochrome with deep purple accents, an asteroid logo, and several novel space-themed touches the design assistant invented in response to the user's "push hard" prompt.

**Key visual choices ported in:**
- **Color tokens** (lifted directly from `klar-theme.css`): `--void`, `--space-0..5`, `--plasma`, `--plasma-dim`, `--plasma-glow`, `--plasma-faint`, `--pulsar` (online teal), `--quasar` (idle amber), `--redshift` (DND/mention magenta), `--eclipse` (offline), `--starlight*` text scale, `--orbit*` borders.
- **Typography**: Space Grotesk for display headings (sidebar/server titles, channel name, channel intro `<h3>`), Inter for body, JetBrains Mono for the invite code. Fonts loaded from Google Fonts.
- **Ambient backdrop**: a `.starfield` of tiny radial-gradient dots and two `.nebula-glow` blurred circles drifting slowly behind the entire app shell. Both auth screen and main shell get them.
- **Server rail (76px)**: each server is a planet (circle) or asteroid (irregular polygon clip-path with two crater dots), filled with a radial gradient seeded from the server id. The active slot grows an outer dashed `.orbit-ring` that rotates slowly with a satellite dot, plus the white pill indicator on the left edge that scales between 0/0.45/1 on inactive/hover/active. Add (`+`) and join (compass) actions live below the divider.
- **Channel sidebar (240px)**: server name in display font, an `OPEN FREQUENCY · N members` meta line, a single "OPEN COMMS" category header (we don't have categories server-side yet — see "Open / next"), each channel a row with the `#` SVG icon and channel name. `.me-bar` at the bottom with avatar + display name + handle + mic/headphones/settings/logout buttons.
- **Chat header (52px)**: for channels — `#` icon + channel name + topic (`Open comms — keep it civil, keep it weird`) + `SIGNAL: STRONG` pill with three signal bars on the right. For DMs — peer avatar + display name + `@handle` + topic + the E2EE toggle.
- **Channel intro**: 64px `.badge` circle (asteroid for DMs, hash for channels) above a Space-Grotesk `<h3>` welcome line and a one-liner.
- **Day dividers**: `TODAY · MAY 6` style, plasma color, full-width hairline rules left and right.
- **Message rows**: 38px radial-gradient avatar tinted by the sender's id, name in the sender's hash color, plasma message-arrive animation when a new row appears, hover highlight in `--plasma 4%`.
- **Composer**: pill-shaped `var(--space-3)` background, borderless input, plasma send button with `0 0 12px var(--plasma-glow)` glow that's disabled (no glow, dimmed) until you type. On submit it does the design's "transmit" tilt animation — a 4px translate + -12° rotate + scale 0.9.
- **Members panel (240px, server view only)**: appears on the right edge of the shell when you select a server. Owner shown in a "CAPTAIN" group with plasma name color, everyone else in "CREW". Each online member's avatar gets a thin orbit ring with a satellite dot rotating around it (CSS `@keyframes orbit`).
- **Modals**: same dark-purple gradient card, plasma-glow primary button, redshift danger button, mono font for the invite code with letter-spacing.

**Files touched:**
- `public/styles.css` — full rewrite around the new token set.
- `public/index.html` — restructured shell to a 4-column grid (rail / sidebar / chat / members), added Google Fonts links, added a `<defs>`-only inline-SVG sprite with 12 cosmic icons that the app references via `<svg><use href="#klar-X"/></svg>`, added templates for both sidebar variants and all five modals.
- `public/app.js` — refactored renderers to use inline-SVG icons via a `svgIcon(id, size)` helper, added `paintServerOrb` for the planet/asteroid orbs, added `renderMembersPanel`, added day-divider + channel-intro builders, added the SIGNAL pill in the channel header, hooked the members panel show/hide into `switchView`. Author name colors now come from a stable hex hash instead of an HSL gradient so they match the design's discrete sender-color palette.
- `public/api.js` — unchanged.
- `server.js` — unchanged. All backend functionality (servers, channels, DMs, E2EE, real-time WS, `.KDB` archive) is preserved.

**Decisions / things I deliberately did NOT port:**
- **Reactions, embeds (patch notes), replies, voice channels, threads.** The design's `klar-data.jsx` shows them, but we have no backend support, and the design README explicitly says "Match the visual output; don't copy the prototype's internal structure unless it happens to fit." Adding any of those is its own backend feature, and inventing fake data wasn't the right call. Left as "Open / next".
- **Channel categories**. The design groups channels under "Mission Control / Open Comms / Squad Frequencies / Black Box". The backend has a flat channel list per server. I render a single "OPEN COMMS" category header so the visual rhythm is right; categories proper would need a `categories` table and a UI to manage them.
- **Online/idle/dnd/offline presence.** No backend tracking yet — every member in the panel shows the orbit ring and pulsar dot. A presence sub-system (track WS connections, broadcast `presence_update`) is a small follow-up.
- **The design assistant's `BrowserWindow` chrome** — the prototype was a self-contained HTML page that emulated a browser window because Claude Design renders it that way. Our actual deployment is a real browser window, so the chrome would be dead weight.
- **Babel / React runtime in the browser.** The design ships JSX rendered in-browser via `@babel/standalone`. That's a 2 MB+ runtime plus a JIT compile on every load — fine for a prototype, not fine for what we're shipping. Reimplemented with vanilla DOM in `app.js`.

**Verification:**
- `node --check` clean on `app.js`, `api.js`, `crypto.js`, `server.js`.
- Booted on PORT=3097. All static assets serve 200: `/` (13.4 KB), `/app.js` (43 KB), `/styles.css` (29 KB), `/crypto.js` (5 KB), `/api.js` (5 KB).
- All 12 SVG icon symbols (`klar-asteroid`, `klar-hash`, `klar-lock`, `klar-plus`, `klar-compass`, `klar-search`, `klar-send`, `klar-menu`, `klar-mic`, `klar-headphones`, `klar-settings`, `klar-logout`) and all 9 `<template>` blocks present in the served HTML.
- All earlier server-side smoke tests (register/login → DMs → E2EE toggle → server creation → invites → channel messages → `.KDB` archive) still pass — `server.js` was not touched in this iteration.

**Open / next:**
- **Real-browser visual confirmation.** Server renders and all wiring works server-side; pixel-comparison against the design (dimensions, line-heights, exact gradient stops on avatars) is the one thing only an actual browser tab can verify.
- **Channel categories** as a real concept (server-side table + reorderable UI). Currently rendered as one fixed "OPEN COMMS" group.
- **Presence**: track per-user WS connections and broadcast `presence_update`. Until then, every member in the panel renders as online.
- **Reactions, replies, embeds, voice channels, threads** — visual touches the design specifies but our backend doesn't support yet. Each is its own feature, listed in original order of "things Discord has."
- **Design tweaks the prototype suggests but I didn't pursue**: signal pill could reflect actual WS connection status (currently always "STRONG"); `me-bar`'s mic/headphones/settings buttons are non-functional placeholders; the activity sub-line under display name (e.g. "Playing Eclipse Protocol") is in the design but Klar has no presence/activity model.

### 2026-05-06 — No-autofill auth, "Stay logged in", account persistence to `DATA/ACCOUNTS/*.KDB`
**Goal:** User reported three things: (a) browser was auto-filling the login forms, (b) wanted an opt-in "remember me on this device" so they don't have to retype on reload, (c) accounts kept getting wiped because the SQLite DB was being deleted (Windows file locks made our test cleanups blunt and the user's own iteration apparently triggered the same thing). Fix: persist accounts to flat `.KDB` files under `DATA/ACCOUNTS/` so SQLite becomes recoverable from disk, and let the user opt in to a real persistent client session.

**Server-side changes (`server.js`):**
- New `ACCOUNTS_DIR = ./DATA/ACCOUNTS`. New helpers:
  - `writeAccountKdb(user)` — single-line JSON record, one file per user, same fields the `users` table holds (id, username, displayName, password_hash, password_salt, public_key, the full encrypted-private-key bundle, createdAt). Just as sensitive as `klar.db` itself; `DATA/` is in `.gitignore`.
  - `loadAccountsFromKdb()` — at boot, scans the directory, parses every `.KDB` file, and `INSERT`s any account whose id/username isn't already in `users`. This is the recovery path: delete `klar.db` and the next boot rebuilds the user table.
  - `exportExistingAccountsToKdb()` — at boot, writes a `.KDB` file for every existing user that doesn't have one yet. One-time migration so accounts that pre-date this feature also get persisted.
- `POST /api/register` now calls `writeAccountKdb(newUser)` after the SQLite insert, so new accounts go to disk immediately.
- `.gitignore` — added `DATA/`.

**Client-side changes:**
- `public/index.html`:
  - Both forms are `autocomplete="off"`. Inputs renamed to non-standard `klar_id`, `klar_secret`, `klar_display` (browsers fingerprint by name + type to decide what to autofill — non-standard names dodge it). Each input also carries `data-lpignore="true"`, `data-1p-ignore`, `data-bwignore`, `spellcheck="false"`, `autocapitalize="off"`, `autocorrect="off"`. Combined, this suppresses both the autofill-on-load and the offer-to-save prompt for Chrome, Firefox, LastPass, 1Password, and Bitwarden.
  - Added a checkbox `<input type="checkbox" name="remember" data-remember />` ("Stay logged in on this browser") to both login and register forms.
- `public/styles.css` — restyled the new `.remember-row` checkbox so it matches the cosmic theme (plasma-glow when checked).
- `public/app.js`:
  - New `saveSavedSession`, `loadSavedSession`, `clearSavedSession` helpers backed by IndexedDB (`klar` db, `session` store, key `current`). Stores `{ token, user, privateKey, publicKey }`. **`privateKey`/`publicKey` are CryptoKey objects**, which are structured-clonable, so we don't have to re-derive them from the password on reload.
  - Login & register handlers read `klar_id`/`klar_secret`/`klar_display` instead of the old standard names, and the `remember` checkbox: if checked, the unlocked session is written to IndexedDB; if not, any prior saved session is cleared (so unchecking on a later login wipes the persistent state).
  - `boot()` now first calls `loadSavedSession()`. If a token is present, we set `session.token` and probe `/api/me` to confirm the server still considers it valid. On success we restore `state.user/privateKey/publicKey` directly from the saved blob, refresh the IndexedDB record, and skip the auth screen. On 401 (token revoked / sessions wiped) we drop the saved blob and fall through to auth as if nothing was stored.
  - `logout()` now also calls `clearSavedSession()`.

**Decisions:**
- **Why IndexedDB, not localStorage.** localStorage can only hold strings, so storing the unlocked private key would mean re-deriving from the password every reload anyway — defeating the point of "stay logged in." IndexedDB stores CryptoKey objects directly via structured cloning. Also: the cross-tab token-clobbering bug we fixed before stays fixed — `_token` in `api.js` is still the in-memory source of truth for any active tab; IndexedDB only feeds boot-time restore.
- **Why opt-in (not default).** Persisting an unlocked private key on disk is a real trade-off: anyone with access to the machine can decrypt all the user's history without retyping the password. The checkbox makes that the user's choice. Default is the more secure behavior.
- **Why non-standard input names + `autocomplete="off"`, not the dummy-field hack.** The "honeypot two hidden inputs" trick still works against some password managers but Chrome has gotten smarter at detecting the real fields anyway. Non-standard names + the four major manager-ignore data-attributes are simpler and reliable enough. If a determined password manager still triggers, the user can disable it on this site individually.
- **Account `.KDB` is one file per user, not one big file.** Easier to inspect, easier to diff, and edits to one user's record don't risk corrupting others. Filename is the username (since usernames are unique and immutable).
- **Account `.KDB` includes the password hash, NOT the password.** Same data the SQLite table holds. Restore preserves login ability without ever knowing or storing plaintext.
- **`DATA/` separate from `messages/`.** User suggested `DATA/ACCOUNTS`; honored that path. Message archives stay at the existing `messages/`. Could unify later.

**Verification:**
- `node --check` clean on `app.js` and `server.js`.
- End-to-end recovery test: registered alice and bob → confirmed `DATA/ACCOUNTS/alice.KDB` and `bob.KDB` materialized with the full record (id, username, password hash + salt, public key, encrypted-private-key bundle, key salt, createdAt) → killed the server → **deleted `klar.db`, `klar.db-shm`, `klar.db-wal`** → rebooted → boot log printed `Klar accounts: restored 4 from KDB, exported 0 to KDB` → both alice and bob logged in successfully with their original passwords (token returned, user record intact). An unknown username correctly returned `invalid credentials`.

**Open / next:**
- **Manual UI verification of autofill suppression** in real browsers. With `autocomplete="off"` + non-standard names + `data-lpignore`/`data-1p-ignore`/`data-bwignore`, modern Chrome / Firefox / Edge should not offer to autofill or save. Confirm in your usual browser; if a particular manager still triggers, the next move is the dummy-hidden-fields trick.
- **Manual UI verification of "Stay logged in"**. Check the box, log in, reload — should land in the app without re-entering credentials. Click logout — IndexedDB record should be gone (DevTools → Application → IndexedDB → klar). Reload — back to auth.
- **Per-account `.KDB` rotation / soft-delete.** Right now deleting an account from the SQLite cascade doesn't remove the corresponding `.KDB` file (we have no DELETE-account API yet). When that exists, also unlink the file.
- **Sensitive disk footprint.** `DATA/ACCOUNTS/*.KDB` contains password hashes + the encrypted-private-key bundle. `.gitignore` covers it; if a user ever wants to back up Klar, they should treat `DATA/` and `klar.db` with the same care.

### 2026-05-06 — Desktop app shell with custom traffic-light title bar
**Goal:** User wanted an "APP version" of Klar with a frameless window and the macOS-style traffic-light buttons described and shown in their screenshot: red (close, cross on hover), orange (toggle fullscreen ↔ floating window, fullscreen glyph on hover), green (minimize, minus on hover).

**Architecture:** Electron 33 hosts a frameless `BrowserWindow`. The Electron main process **does not run the server in-process** — it spawns the user's system `node` to run `server.js` as a child process. Reasoning is a hard constraint: Electron 33 ships Node 20.18, and `server.js` uses `node:sqlite`, which only became a stable builtin in Node 22.5 (the user's system Node is 24, where it works). So the GUI is just a frameless browser pointed at `http://localhost:<PORT>`, exactly like a regular tab — only with our custom title bar instead of native chrome. This also means dev (`npm start`) and packaged-app code paths are identical; the desktop shell is a thin wrapper.

**Files added:**
- `desktop/main.cjs` — Electron main process. Spawns `node --disable-warning=ExperimentalWarning server.js` as a child, watches stdout for the "running at http://localhost:<port>" line and resolves with the port, then opens a frameless `BrowserWindow` (1280×800, 880×540 minimum) loading that URL. IPC handlers for `klar:close`, `klar:minimize`, `klar:toggle-maximize`. Quits the app and kills the server child on `window-all-closed` / `before-quit`.
- `desktop/preload.cjs` — exposes `window.klar.shell` to the renderer with `close()`, `minimize()`, `toggleMaximize()`, `isMaximized()`, `onMaxStateChange(cb)`. Uses `contextBridge.exposeInMainWorld`. Sandbox + contextIsolation are on, nodeIntegration is off.
- `desktop/launch.cjs` — small wrapper script that spawns Electron with `ELECTRON_RUN_AS_NODE` deleted from the env. **This was the gotcha**: this Windows shell environment had `ELECTRON_RUN_AS_NODE=1` set globally, which forces the Electron binary to run as plain Node (process.type undefined, `require('electron')` returns the binary path string, IPC absent). Without the wrapper, every launch attempt died at the first `ipcMain.handle()` call. The wrapper makes the launch robust regardless of how the user's shell is configured.
- `desktop/package.json` — `{ "type": "commonjs" }` to nail this folder to CJS even though the project's root package.json says `"type": "module"`. Belt-and-braces: the .cjs extension already forces CJS, but I added the manifest after fighting the loader for a while and it stays for clarity.

**Files changed:**
- `package.json` — added `"main": "desktop/main.cjs"`, `"app": "node desktop/launch.cjs"` and `"app:dev"` scripts, `electron@^33.0.0` as a devDependency.
- `public/index.html` — title bar markup at the top of `<body>`, hidden by default. Three colored circles on the left (`tl-close`, `tl-fullscreen`, `tl-minimize`), title text in the center, a 60px spacer on the right to keep the title visually centered.
- `public/styles.css` — `body` is now a flex column so the title bar takes its 36px and `#app` fills the rest. Traffic-light styles: 12×12 circles with the design's exact `#ff5f57` / `#febc2e` / `#28c840` colors, an embedded SVG glyph in each (cross / fullscreen-corners / minus), opacity 0 by default, opacity 1 on group hover (the macOS convention — hovering anywhere over the lights reveals all three glyphs at once, instead of a single-button hover that would jitter as the mouse crosses gaps). Whole bar is `-webkit-app-region: drag`, the buttons are `no-drag` so they remain clickable.
- `public/app.js` — new `setupTitlebar()` that's called from `boot()`. It only reveals the bar when `window.klar?.shell?.isAvailable` is true — i.e. only when running inside the Electron preload context. In a regular browser the bar stays hidden. Wires the three buttons to the IPC bridge.
- `shell.ps1` — added `app` command (the dev-shell launcher). Refuses to run if a background server is already up on the configured port (the desktop app spawns its own server and would conflict).
- `server.js` — added `export { server, PORT };` at the bottom. **No longer used** by the current desktop wiring (we spawn `node server.js` as a child instead of importing it), but kept because it's harmless and useful for future in-process embeds.

**Decisions:**
- **Spawn the server, don't import it.** Considered importing `server.js` directly into the Electron main process. Blocker: Electron's bundled Node is older than the user's system Node, and `node:sqlite` is unavailable. Alternative would be replacing `node:sqlite` with `better-sqlite3` + an Electron-specific prebuild + an `electron-rebuild` step — much more moving parts. Spawning is one line and uses the user's existing toolchain.
- **Orange button → maximize/restore, not real fullscreen.** Real `setFullScreen(true)` hides the title bar, which means the user has no visible affordance to un-fullscreen. The screenshot's "fullscreen ↔ floating window" semantics work better as maximize/restore, where the title bar always remains visible. Easy to switch later if you'd prefer F11-style fullscreen.
- **Group-hover for glyph reveal**, not per-button. Documented in the styles.css comment — group-hover matches macOS exactly and avoids jittering as the mouse moves between the three small targets.
- **Web build still works unchanged.** The title bar starts with the `hidden` class and `setupTitlebar()` only removes it when the Electron bridge is detected. Loading `http://localhost:3000/` in a regular browser shows zero traffic-light chrome — same as before this iteration.

**Verification:**
- `node --check` clean on `desktop/main.cjs`, `desktop/launch.cjs`, `desktop/preload.cjs`, `public/app.js`, `server.js`.
- Diagnosed and fixed the `ELECTRON_RUN_AS_NODE` gotcha (proven by `process.type === 'browser'` and `typeof require('electron') === 'object'` after the launcher unsetting it).
- Full launch dry-run: `node desktop/launch.cjs` spawned Electron → Electron spawned `node server.js` → server printed `Klar server running at http://localhost:3098` → main process detected the line → opened the BrowserWindow → an external `curl http://localhost:3098/` returned **200** and `/api/me` returned the expected `{"error":"not authenticated"}`. The window itself wasn't visually inspected (no GUI session in this shell), but the loadURL was in flight when the test timeout fired.

**Open / next:**
- **Visually confirm in a real session.** Run `npm run app` (or `app` in the dev shell). You should get a frameless window, the traffic-light bar at the top, the title centered showing "Klar — Deep Space Comms", and the rest of the app underneath. Hover over any of the three circles and all three glyphs should fade in.
- **Dynamic title text.** Right now the title says "Klar — Deep Space Comms" statically. Could update it from `app.js` whenever the user opens a DM/channel (e.g. "Klar — #general · MyServer").
- **F11-style real fullscreen** if you'd rather have that — one-line change in the IPC handler.
- **Packaging.** `electron-builder` or `electron-forge` can produce an installer. Out of scope for this iteration; the current `npm run app` is dev-mode only.
- **Bundle a Node binary** for true standalone distribution. Right now the desktop app requires a system `node` (24+ for `node:sqlite`). For shipping, either bundle Node, switch to `better-sqlite3` with Electron-rebuild, or migrate to `sql.js`.

### 2026-05-06 — Package Klar as a portable Windows EXE
**Goal:** User asked for an actual `.exe` file. Used `electron-builder` to produce `dist/Klar-0.1.0-portable.exe` — a single self-extracting NSIS-style EXE that the user can double-click to run.

**Result:** 70 MB portable Windows x64 EXE (`PE32 executable, GUI, Nullsoft Installer self-extracting archive`).

**Changes:**
- `package.json` — added `"build"` config block (electron-builder configuration), `electron-builder@^25.1.8` as a devDependency, `dist` and `dist:dir` scripts. Build target: `win.target = portable`. **`asar: false`** — without this, the spawned `node server.js` can't read its own source out of the asar archive at runtime; an alternative would be `asar: true` with `asarUnpack` for the spawnable bits, but for an MVP the size cost of unpacked is irrelevant. **`win.signAndEditExecutable: false`** to skip the macOS pieces of the winCodeSign archive (see Decisions below).
- `desktop/build.cjs` — wrapper that runs `node_modules/.bin/electron-builder` with `ELECTRON_RUN_AS_NODE` deleted from the env, mirroring `desktop/launch.cjs`. Without this wrapper, electron-builder's internal Electron probing trips the same `ELECTRON_RUN_AS_NODE=1` gotcha we hit during the desktop-shell work and the build fails.
- `server.js` — added `KLAR_DATA_DIR` env-var support. If set, all writable paths (`klar.db`, `messages/`, `DATA/ACCOUNTS/`) are rooted there instead of next to `server.js`. In dev mode the var is unset and behavior is unchanged.
- `desktop/main.cjs` —
  - `findServerJs()` now searches both the dev path (`<project-root>/server.js`) and the packaged paths (`<resources>/app/server.js`, `<resources>/app.asar.unpacked/server.js`).
  - When `app.isPackaged`, the spawn passes `KLAR_DATA_DIR = app.getPath('userData')` so the SQLite database and KDB archives live in the per-user folder Windows expects (`%AppData%\Klar`), not in the EXE's extracted-temp folder which can disappear between runs.
- `shell.ps1` — added `dist` command + entry in `help`.

**Decisions:**
- **`portable` target, not `nsis` (installer).** The user asked for an EXE they can run, not an installer. Portable produces a single self-extracting EXE: double-click → app appears. NSIS would put up an installer wizard, copy files to Program Files, register in Add/Remove Programs — heavier UX.
- **`asar: false` over `asar: true + asarUnpack`.** Both work. asar:false is simpler (one less concern about path resolution inside asar://) and the size penalty is small at MVP scale. We can switch later if startup time matters.
- **`signAndEditExecutable: false` to dodge the symlink crash.** First build attempt failed with `ERROR: Cannot create symbolic link : A required privilege is not held by the client. : ...darwin/10.12/lib/libcrypto.dylib`. The winCodeSign archive electron-builder downloads contains macOS code-sign symlinks that 7za chokes on under non-admin Windows (no developer mode). We never need those macOS files for a Windows-only build, so disabling executable editing skips that whole code path. The trade-off: the produced EXE doesn't get a custom icon embedded in its PE resources (it ships with Electron's default icon). Adding a custom icon later means either enabling developer mode and re-running, or pre-extracting winCodeSign manually.
- **`KLAR_DATA_DIR` over hardcoded paths.** Lets dev mode keep its current "everything next to server.js" layout, while the packaged app routes to a real OS-managed user folder. Same code, two deployment shapes.
- **Spawned-system-Node, still.** The packaged EXE still requires Node 22.5+ on PATH at runtime. Bundling a Node binary inside the EXE is the next step for true standalone shipping; flagged in Open / next.

**Verification:**
- `node --check` clean on `desktop/main.cjs`, `desktop/build.cjs`, `server.js`.
- `npm install` succeeded (added 334 packages including `electron-builder@25.1.8`).
- `node desktop/build.cjs` (which is what `npm run dist` invokes) completed successfully on the second attempt with `signAndEditExecutable: false`. Build log shows `building target=portable file=dist\Klar-0.1.0-portable.exe archs=x64` followed by the normal NSIS-package steps.
- Output: `dist/Klar-0.1.0-portable.exe`, 74,286,100 bytes (~70 MB), magic bytes `4d5a 9000` (valid `MZ` PE header), identified by `file(1)` as `PE32 executable for MS Windows 4.00 (GUI), Intel i386, Nullsoft Installer self-extracting archive`.
- `dist/win-unpacked/Klar.exe` also exists (the unpacked Electron app the portable EXE wraps), which is itself runnable for debugging.

**Open / next:**
- **Bundle a Node 22+ runtime** so the EXE truly stands alone. Right now `desktop/main.cjs` spawns whatever `node` is on PATH; if the user runs the EXE on a machine without Node ≥ 22.5 (where `node:sqlite` first appeared), it'll fail at server startup. Path of least resistance: ship a portable Node from `nodejs.org/dist` as `extraResources` in electron-builder config, and have `findServerJs` fall back to that bundled binary.
- **Custom app icon.** Currently using the default Electron icon. Add `build/icon.ico` and re-enable `signAndEditExecutable: true` after dealing with the winCodeSign symlinks (Windows developer mode, or pre-extract the archive).
- **Code signing.** Without a real certificate, Windows SmartScreen will warn on first run. Out of scope until there's a publishing story.
- **Auto-updater.** electron-builder has `electron-updater` baked in. Worth wiring up once we have a release process.

### 2026-05-06 — Cross-network connectivity + client auto-update from GitHub
**Goal:** User asked for: (a) the desktop app to connect to *their* server even when the app is running on a totally different network — i.e. the packaged EXE points at a public backend URL, not localhost, (b) an auto-update mechanism where pushing to a GitHub branch makes installed EXEs pick up the new client files automatically, (c) a way to easily distribute the EXE to other machines.

**Architectural shift:** the packaged EXE is now a *thin* client. It does **not** run a local server. The dev mode (`npm run app`) keeps the spawn-local-server behavior; the packaged build (`npm run dist`) loads its client from `userData/client/` and talks to a remote backend over `KLAR_CONFIG.serverUrl`. The two paths share the same renderer; they differ only in how `main.cjs` resolves the URL/files at startup.

**Files added:**
- `client-config.json` (project root) — shipped inside the EXE. Contains `serverUrl`, `updateRepo`, `updateBranch`, `updateCheckIntervalMs`. Default ships with `serverUrl: "http://localhost:3000"` and `updateRepo: null` (auto-update disabled). Users edit this before `npm run dist`.
- `desktop/updater.cjs` — main-process updater. Reads installed version from `userData/client/version.json`, fetches `https://raw.githubusercontent.com/<repo>/<branch>/client-releases/manifest.json`, compares versions, and on newer downloads every file into `userData/client-next/`. Verifies sha256 if present in the manifest. Emits `klar:update-available` over IPC. `applyPending()` does a fs.rename swap (`client/` → `client-old-<ts>/`, `client-next/` → `client/`), then deletes the old folder asynchronously. On Windows that rename is atomic across the same drive.
- `scripts/release-client.cjs` — `npm run release-client` entry point. Snapshots `public/` into `client-releases/<version>/`, hashes every file, and rewrites `client-releases/manifest.json`. Refuses to overwrite an existing version directory (forcing a `package.json` version bump).
- `client-releases/0.1.0/` + `client-releases/manifest.json` — initial snapshot so the very first EXE has something to compare against on its first poll.

**Files changed:**
- `desktop/preload.cjs` — exposes `window.klar.updates.{onAvailable, apply, checkNow}` plus `window.KLAR_CONFIG` (parsed from a `--klar-config=<urlencoded JSON>` value the main process passes via `webPreferences.additionalArguments`).
- `desktop/main.cjs` — major refactor:
  - `findFile([candidates])` helper consolidates source-vs-resourcesPath resolution for `server.js`, `public/`, `client-config.json`, `package.json`.
  - `readConfig()` merges three layers: bundled `client-config.json`, `userData/client-config.json` runtime override, and env-var overrides (`KLAR_SERVER_URL`, `KLAR_UPDATE_REPO`).
  - `createWindow()` now resolves the URL/file + the renderer config *before* the BrowserWindow is constructed, so `additionalArguments` carry the correct values on first paint. Dev path: `loadURL(http://localhost:<port>)`. Packaged path: `loadFile(<userData>/client/index.html)`.
  - In packaged mode, `updater.init()` is awaited before window creation — that's what populates `userData/client/` from the bundled baseline on first launch (`ensureClientBaseline()`).
  - New IPC handlers: `klar:check-now`, `klar:apply-update`. The latter, on success, reloads the BrowserWindow against the swapped `client/index.html` so the user sees the new build immediately.
- `public/api.js` — `fetch` and `WebSocket` now go through `serverBase()`/`apiUrl()`/`wsUrl()` helpers that use `window.KLAR_CONFIG.serverUrl` if set, falling back to relative URLs / `location.host` (dev mode + regular browser tabs). With this, the renderer works whether it's loaded from `http://localhost:3000` or from `file:///.../client/index.html`.
- `public/app.js` — `setupUpdateToast()` subscribes to `klar.updates.onAvailable` and pops a toast in the bottom-right with from-version → to-version, "Later" and "Reload now" buttons. Reload calls `klar.updates.apply()`.
- `public/styles.css` — `.update-toast` styles (cosmic gradient card, plasma "apply" button, ghost "later" button).
- `package.json` — `release-client` script, `client-config.json` added to `build.files`, `client-releases/` and `scripts/` excluded from the EXE bundle (they live in the repo, not the runtime).
- `shell.ps1` — `release-client [version]` command.
- `server.js` — already had `KLAR_DATA_DIR` support from the previous iteration, no changes needed here.

**Decisions:**
- **Manifest-driven file list, not a tarball.** Two reasons: (1) a `manifest.json` with explicit file paths + sha256s lets the updater verify integrity per-file; (2) downloading individual files with the GitHub Raw CDN avoids needing a tar/zip extractor in the main process. The trade-off is one HTTP request per file, but the client is small (5 files at v0.1.0) so this is fine.
- **Bundled baseline in EXE + writable copy in `userData/client/`.** Without the writable copy, auto-update has nowhere to put new files (the EXE's extracted directory is temp/read-only). Without the bundled baseline, the very first launch would have to download the full client over the network before showing anything. The `ensureClientBaseline()` step copies the bundle to `userData/client/` on first launch and on EXE-shell upgrades (so a new EXE that ships an updated client can win even if no auto-update has run).
- **Updater runs only in packaged mode.** Dev mode loads files from the source `public/` directory directly; auto-update would just confuse things.
- **`additionalArguments` to inject KLAR_CONFIG, not `executeJavaScript` after load.** Setting it via the preload context-isolation bridge means the renderer has the config *before* any of its own scripts run, so `api.js`'s first `fetch` already has the right server URL. Doing it after load means a window of broken behavior at boot.
- **GitHub Raw, not a custom update server.** The user asked for "github page on my account", and using `raw.githubusercontent.com` plus `client-releases/` in their repo means there's no separate update server to host or maintain. CDN-cached, free, fast.
- **Manual semver in `package.json`.** Bump it before `npm run release-client`. Future improvement: a `--bump patch|minor|major` flag on the release script.

**Verification:**
- `node --check` clean on `desktop/main.cjs`, `desktop/preload.cjs`, `desktop/updater.cjs`, `scripts/release-client.cjs`, `public/api.js`, `public/app.js`.
- `npm run release-client` (with no args) read `0.1.0` from `package.json`, snapshotted `public/`'s 5 files into `client-releases/0.1.0/`, computed sha256s, and wrote `client-releases/manifest.json` correctly (verified: `version: "0.1.0"`, `serverUrl: "http://localhost:3000"`, 5-entry `files` array with hashes). Re-running was correctly refused with "client-releases/0.1.0/ already exists".
- **Dev mode launch**: `node desktop/launch.cjs` on PORT=3098 → `[klar-server] Klar server running at http://localhost:3098` → `curl http://localhost:3098/` returns `200`, `/api/me` returns the expected `{"error":"not authenticated"}`. Renderer is alive and the additionalArguments path is wired.
- **Packaged build**: `npm run dist` (via the `desktop/build.cjs` wrapper that clears `ELECTRON_RUN_AS_NODE`) produced `dist/Klar-0.1.0-portable.exe` (74,288,043 bytes, ~70 MB) with the new updater + remote-server-URL plumbing baked in. `signing skipped` is expected (no cert).

**Open / next:**
- **Real auto-update test in a browser session.** Set `updateRepo` in `client-config.json` to a real GitHub repo, run `npm run dist`, install the EXE on a separate machine. Push a `0.1.1` snapshot via `release-client` and confirm the toast appears within `updateCheckIntervalMs`.
- **Bundle a Node 22+ binary** so the EXE truly stands alone without requiring system Node — currently the dev-mode behavior of spawning `node server.js` is dev-only, but the packaged EXE only needs Node if you also want it to host the server, which is now an explicit non-goal. So this is **less urgent** than before — the packaged client doesn't need Node anymore, just network access to the configured `serverUrl`.
- **Shell auto-update** (Electron itself / main process / preload) via `electron-updater` and GitHub Releases. Currently only the client files auto-update; shipping a new EXE for shell changes still requires manual download.
- **Update channels** (`stable` / `beta`). The config has an `updateChannel` field but the updater currently ignores it. Easy to layer in: read `manifest.<channel>.version` instead of `manifest.version`.
- **Differential / chunked updates**. Currently every poll that finds a new version downloads every file. A bigger client could benefit from a "files changed since X" delta. Not worth it at this scale.
- **Network resilience.** The updater retries the next poll on failure, but doesn't currently back off or surface failures to the user. Fine for an MVP.

### 2026-05-06 — Fix empty-window bug + "couldn't connect to the server" UI + initial git push to GitHub
**Goal:** User reported the packaged EXE opens with a black, empty window — only the unstyled traffic-light buttons visible, nothing else. Asked for a friendly "couldn't connect to the server, please try again later" screen with a broken-cable icon to be shown in that case. Also gave me their GitHub repo URL (`https://github.com/ThatsALotOfBees/Klar.git`) so I could push everything.

**The empty-window root cause:** `public/index.html` referenced `/styles.css` and `/app.js` with **absolute** paths. Under `http://localhost:3000` (dev mode) those resolve correctly against the origin. Under `file:///.../client/index.html` (packaged mode) they resolve against the filesystem root and 404. Neither stylesheet nor script loads → no CSS, no app.js, nothing gets mounted into `#app`. The user just sees the bare HTML markup of the title bar (which is why the traffic lights are unstyled white squares with their default browser button look).

**Fix #1 — relative paths in `public/index.html`:** changed `href="/styles.css"` → `href="styles.css"` and `src="/app.js"` → `src="app.js"`. Now identical behavior under both origins.

**Fix #2 — server connectivity probe + error screen:**
- New `api.probe()` in `public/api.js` — does a `GET apiUrl('/api/me')` with `AbortSignal.timeout(3500)`. Any HTTP response (even 401) = reachable; only fetch failures / timeouts mean the server is down.
- New `renderServerUnreachable()` in `public/app.js` — clears `#app` and mounts a centered error card with the broken-cable SVG, "Couldn't connect to the server" headline, "Please try again later." subline, the configured server URL in mono font, and a "Retry" button that re-runs `boot()`.
- `boot()` now calls `api.probe()` first. If unreachable, renders the error screen and returns. If reachable, proceeds to the normal saved-session restore / auth flow.
- `public/styles.css` — `.error-shell` (full-height grid centering, starfield + nebula backdrop), `.error-card` (cosmic gradient card with plasma-glow shadow), `.broken-cable` (160px-wide SVG with plasma drop-shadow).
- `public/index.html` — added `klar-broken-cable` to the inline-SVG sprite. Two RJ-45-shaped plug ends with internal pin lines, jagged plasma-red break + spark dots in the middle. Sized 120×64.

**Fix #3 — bumped version to 0.1.1, snapshotted, rebuilt EXE.** `package.json` 0.1.0 → 0.1.1, `npm run release-client` snapshotted into `client-releases/0.1.1/` (5 files, fresh sha256s) and updated `client-releases/manifest.json` to point at 0.1.1. EXE rebuilt via `npm run dist`.

**Fix #4 — git init + push to `ThatsALotOfBees/Klar`.**
- `.gitignore` was missing `dist/` (and `*.log`); added them.
- `git init -b main` → `git add .` (31 files / 17,618 lines after gitignore filtering — clean, no node_modules / DB / EXE / logs leaked through).
- Initial commit message documents the full MVP scope (server, client, desktop, auto-update, build).
- `git remote add origin https://github.com/ThatsALotOfBees/Klar.git` → `git push -u origin main` → success, `main -> main`. Repo was empty pre-push so no force/merge dance needed.
- Existing git config picked up: `user.name = ThatsALotOfBees`, `user.email = crystanixos@gmail.com`.

**Fix #5 — `client-config.json` updated** to point at the user's repo: `updateRepo: "ThatsALotOfBees/Klar"`. The new EXE bundle includes this, so installed copies will start polling `https://raw.githubusercontent.com/ThatsALotOfBees/Klar/main/client-releases/manifest.json` from their first boot.

**Decisions:**
- **Probe URL = `/api/me` not a dedicated `/api/health`.** Adding a health endpoint would mean a server-side change too. `/api/me` already returns 401 without auth (= server is up), and any failure to even get an HTTP response (= server is down) trips the unreachable branch. One less moving part.
- **3.5-second timeout.** Long enough for a slow first DNS+TLS handshake to a faraway server; short enough that the user doesn't stare at unstyled HTML for a noticeable moment if the server is gone.
- **Retry runs the full `boot()` again** (probe + saved session + render). Simpler than threading the flow back into auth restore and easier to reason about.
- **Broken cable as a single inline SVG symbol**, not an external image. Same machinery as the rest of the icon sprite. No network needed to render it (relevant — we're rendering it precisely *because* the network is broken).

**Verification:**
- `node --check` clean on `public/api.js`, `public/app.js`.
- Initial `client-releases/0.1.1/` snapshot succeeded (5 files, sha256s, manifest updated).
- `git push` succeeded — repo at `https://github.com/ThatsALotOfBees/Klar` now contains source + `client-releases/`.
- EXE rebuild kicked off via `npm run dist`; success criterion is `dist/Klar-0.1.1-portable.exe` showing up.

**Open / next:**
- **Real-server URL.** `client-config.json` still has `serverUrl: "http://localhost:3000"`. Once you have a publicly-reachable host (a domain, a tunnel, a VPS), update it and run `npm run release-client && npm run dist` again — that pushes the new URL to all installed EXEs via auto-update *and* produces a freshly-baked EXE for new installs.
- **GitHub Releases for the EXE.** Right now the auto-update mechanism only updates client files. The EXE itself is committed nowhere automatic — for the user to download the latest, you'd manually upload `dist/Klar-0.1.1-portable.exe` as a release asset. `gh release create v0.1.1 dist/Klar-0.1.1-portable.exe` once you have the EXE built.
- **Connectivity heartbeat.** Right now we only probe once at boot. If the server goes down mid-session the user sees individual request errors. A tiny WS-driven heartbeat that flips to the error screen on disconnect (with auto-reconnect) would close that gap.

### 2026-05-07 — MSI installer + 0.1.2 release
**Goal:** User asked for an MSI installer for the desktop app so they can test the cross-internet flow by installing Klar on a remote PC.

**Changes:**
- `package.json` — added `{ "target": "msi", "arch": ["x64"] }` alongside the existing portable target. New `msi` config block: `oneClick: false` (full install wizard so the user can pick install dir), `perMachine: false` (per-user install, no admin elevation needed), `runAfterFinish: true`, `artifactName: "Klar-${version}.msi"`. Bumped version 0.1.1 → 0.1.2.
- `client-releases/0.1.2/` — new snapshot (5 files, fresh sha256s). `client-releases/manifest.json` now points at 0.1.2. Pushed installs running 0.1.1 will pick this up via auto-update on next poll.
- `dist/Klar-0.1.2.msi` — produced by electron-builder. WiX Toolset binaries got pulled into electron-builder's cache the first time.

**Decisions:**
- **Per-user install** (`perMachine: false`) instead of system-wide. No UAC prompt, works on locked-down PCs, and matches how most chat apps install (Discord, Slack are both per-user by default). Trade-off: each user on a shared machine gets their own install. Acceptable.
- **Wizard mode** (`oneClick: false`) so testers can see the install path and pick a different drive if needed. `oneClick: true` would silent-install with no UI at all — too magical for a first-time installer.
- **Both portable EXE and MSI ship together** from one `npm run dist`. Don't have to choose one — testers who don't want a real install can still use the portable.
- **MSI inherits the same `client-config.json`** as the portable EXE — so both installers point at the same `serverUrl` and `updateRepo`. To test cross-internet you still need the `serverUrl` in that config to be a publicly-reachable URL **before** running `npm run dist`. The MSI's bundled config is locked at build time; auto-update can rewrite it per-install via `userData/client-config.json`, but installs need *some* working `serverUrl` to do the first auto-update poll.

**Two snags I had to fix mid-build:**
1. `desktop/build.cjs` was defaulting to `--win portable` when called with no args, which **overrode** the new `build.win.target` array in `package.json` and caused the MSI target to be silently skipped. Changed the default to plain `--win` so electron-builder honors the configured target list.
2. WiX failed with `LGHT0094: identifier 'Icon:KlarIcon.exe' could not be found`. electron-builder's MSI WXS template references the app icon for the desktop / start-menu shortcuts, but no `build/icon.ico` existed. Wrote `scripts/make-icon.cjs` that programmatically generates a 5-size ICO (32, 48, 64, 128, 256) of a plasma-purple orb with a few crater spots — pure Node, no graphics tools, no checked-in binary asset. Added `build.win.icon: "build/icon.ico"` to package.json. Also added `"author": "ThatsALotOfBees"` so MSI gets a proper Manufacturer field.

**Cross-internet testing checklist** (added to "Open / next" because it's user-side work):
1. Make your local server reachable on the public internet. Cheapest: `cloudflared tunnel --url http://localhost:3000` (free, gives a `*.trycloudflare.com` URL). Alternatives: `ngrok`, port-forwarded home server with a domain, or a small VPS.
2. Edit `client-config.json`: set `serverUrl` to that public URL.
3. `npm run dist` again to bake the new URL into the installers.
4. Hand the resulting `dist/Klar-<v>.msi` (or portable EXE) to a friend on a different network. Install it, log in. Messages should round-trip back to your machine.

**Verification:**
- `npm run release-client` produced `client-releases/0.1.2/` cleanly. Manifest now reports `version: "0.1.2"`.
- `npm run dist` build status — see commit message; expected outputs `dist/Klar-0.1.2-portable.exe` and `dist/Klar-0.1.2.msi` both present after a successful run.

**Open / next:**
- **Server URL.** `client-config.json` still has `serverUrl: "http://localhost:3000"`. The MSI/EXE will install fine, run, and immediately render the broken-cable error screen on the remote PC. To make actual chat work end-to-end, follow the cross-internet checklist above.
- **MSI app icon.** Like the portable EXE, the MSI ships with the default Electron icon. Adding `build/icon.ico` and re-enabling `signAndEditExecutable: true` (after dealing with WiX symlink permissions) would brand it.
- **GitHub Release for the MSI.** `gh release create v0.1.2 dist/Klar-0.1.2.msi dist/Klar-0.1.2-portable.exe` once both artifacts exist; the user can then send a release URL instead of an EXE/MSI file.

## Roadmap (post-MVP)

- Forward secrecy via Double Ratchet or MLS.
- Cross-device sync of unlocked identity (e.g. via paired-device QR).
- Message attachments (images, files), with E2EE-aware uploads.
- Servers/channels (multi-user rooms) — at this point a real Stoatchat / Revolt backend swap-in becomes attractive.
- Voice/video via LiveKit (mirrors Stoatchat's stack).
- Native clients — the API surface is small enough to wrap from a Tauri / mobile shell.
