# Klar — pick up tomorrow

## TL;DR — what to do first

1. Finish installing Tailscale (already downloaded from https://tailscale.com/download/windows).
2. Three admin-console clicks (see "Tailscale one-time setup" below).
3. In an ordinary (non-admin) PowerShell:
   ```powershell
   cd C:\Users\miko\Downloads\Klar
   . .\shell.ps1
   funnel
   ```
4. Test from a friend's installed Klar EXE/MSI. Done.

---

## Where we left off

- **Chosen path: Tailscale Funnel** (free, stable HTTPS URL, no router access needed).
- **Domain `thatsalotofbees.online` is parked.** Path A (home + port forward + Caddy + Let's Encrypt) is blocked because you don't have access to the router. The DNS records at mijndomein.nl currently point at `87.215.222.184` — that public IP may already be stale (Odido rotates dynamic IPs). Don't rely on the domain until you pick a real hosting story.
- **Klar 0.1.11 is shipped to GitHub.** The bundled `serverUrl` in EXEs is `https://thatsalotofbees.online` *but* the discovery flow (`api.discoverServerUrl()` in `public/api.js`) overrides that with whatever is in `client-releases/server.json` on GitHub. The `funnel` command auto-rewrites that file, so when you run it tomorrow, every installed client switches to your `*.ts.net` URL within ~30s.
- **localtunnel is still running as a stopgap.** When you run `funnel`, the new URL gets pushed and clients migrate. You can `down` localtunnel afterwards.

---

## Tailscale one-time setup (do these BEFORE running `funnel`)

1. **Sign in** when the Tailscale tray icon prompts. Use Google / GitHub / Microsoft — whichever. Free for personal use.

2. **Enable HTTPS certs** for your tailnet:
   - https://login.tailscale.com/admin/dns
   - Confirm **MagicDNS** is on (toggle at the top).
   - Scroll to **HTTPS Certificates** → click **Enable HTTPS**.

3. **Grant Funnel ACL** to your devices:
   - https://login.tailscale.com/admin/acls
   - In the JSON editor, add this block (or merge into the existing one):
     ```json
     "nodeAttrs": [
       { "target": ["*"], "attr": ["funnel"] }
     ]
     ```
   - Click **Save**.

If any step fails, the `funnel` command will print exactly which admin-console URL to fix.

---

## What `funnel` does (so you know what to expect)

The new shell command in `shell.ps1` (`Invoke-KlarFunnel`):
- Locates `tailscale.exe` (PATH or `Program Files\Tailscale\`).
- If Tailscale isn't installed: prints clear install + admin instructions.
- Starts the local Klar Node server on :3000 if it isn't already (without the legacy localtunnel).
- Reads your machine's MagicDNS name from `tailscale status --json` (e.g. `your-pc.tail-scale.ts.net`).
- Runs `tailscale funnel --bg 3000` — backgrounded, persists across shell exits.
- Calls `Publish-KlarServerUrl` which writes the new URL to `client-releases/server.json` and `git commit` + `git push`s automatically. Existing installed clients pick it up via `api.discoverServerUrl()` within ~30s.

To take it down later: `funnel -Off` (runs `tailscale funnel reset`).

---

## State of the code at session end

- **Version:** 0.1.11 (committed + pushed; latest commit `d20717e`).
- **New shell commands** (in `shell.ps1`):
  - `funnel`, `funnel -Off` — Tailscale Funnel
  - `caddy-up`, `caddy-down`, `caddy-tail` — Caddy reverse proxy (unused for now; needs admin shell to bind 80+443)
- **New file: `Caddyfile`** (unused for now; ready if you ever get the domain path working).
- **Caddy 2.11.2 is installed** (via winget) at `C:\Users\miko\AppData\Local\Microsoft\WinGet\Packages\CaddyServer.Caddy_*\caddy.exe`.
- **No uncommitted changes** in the working tree (HANDOFF.md will be untracked unless you `git add` it).

Recent renderer/UX changes also shipped in 0.1.10/0.1.11:
- Optimistic chat open (cached messages render instantly, history fetches in background).
- DM header now has a profile-icon button; channel header has a userlist toggle (replaces the old "SIGNAL: STRONG" pill).
- localhost short-circuit + jsDelivr CDN in `discoverServerUrl()` for fast cold starts.
- Removed remaining E2EE remnants (CSS, taglines, intro copy).

---

## Useful commands cheat sheet

```powershell
. .\shell.ps1     # load the dev shell

# Common
status            # show server + tunnel/funnel state, public URL, db size
up                # start server + localtunnel in background
down              # stop server + tunnel
logs              # last 50 lines of klar.log + tunnel log
tail              # follow klar.log live
app               # launch the Electron desktop app

# The new tunnel paths
funnel            # Tailscale Funnel — recommended path now
funnel -Off       # take Funnel down
tunnel            # legacy localtunnel (flaky, only as fallback)
caddy-up          # Caddy reverse proxy (needs admin shell + domain DNS working)
caddy-down        # stop Caddy

# Releases
release-client    # snapshot public/ as a new client-releases/<version>/
dist              # build the portable EXE / MSI installer
```

---

## If Tailscale Funnel turns out to not be enough

- **Find the router admin password.** Most Odido routers have it printed on a sticker on the bottom or back of the unit. If you can log in, path A becomes available again — we can wire up Caddy + Let's Encrypt + your custom domain. The `Caddyfile` and `caddy-up` command are already prepared. You'd just need to set up DDNS too because Odido's residential IP rotates.
- **VPS (~€5/mo).** Hetzner CX22 (€4.51/mo) or Contabo VPS-S (€4.50/mo). Run `node server.js` + Caddy on it. Point `thatsalotofbees.online` A-record at the VPS IP. Never deal with home networking again. About 15 minutes of setup once you decide.

---

## Networking facts captured this session

| Thing | Value |
|---|---|
| Public IP at session end | `87.215.222.184` (likely rotates) |
| ISP | Odido Netherlands (AS13127), The Hague |
| CGNAT | No — clean public IPv4 (good for path A *if* you get router access) |
| LAN IP | `192.168.0.194` |
| Router admin URL | `http://192.168.0.1` |
| MAC of this PC | `D8-43-AE-8C-DD-93` (Realtek 2.5GbE) |
| Domain | `thatsalotofbees.online` (mijndomein.nl) |
| DNS records currently set | A `@` and A `*` → `87.215.222.184` (TLD delegation was still propagating last check — RDAP returned 404) |
| AAAA records | deleted in mijndomein panel; verify if you go back to path A |
| GitHub repo | `ThatsALotOfBees/Klar` (public, used for auto-update + server.json discovery) |
| Email used for Caddy/Let's Encrypt account | albertinosilva65@gmail.com |

---

## Outstanding TODOs (post-funnel)

- Once `funnel` works: kill localtunnel cleanly with `down` (or just leave it; doesn't hurt anything).
- Decide on long-term hosting (Tailscale forever, or VPS, or unlock router for path A).
- If you keep the domain dormant, that's fine — DNS records can sit unused. Just don't pay extra for "DNS hosting" packages on mijndomein you don't need.
