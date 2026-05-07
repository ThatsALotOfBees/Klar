# Klar — feature backlog

Things the user has asked for that are scoped for a future iteration. Order
is loose — prioritize by how often the user re-asks or how much value a
single feature unlocks.

## Activities (Discord-style "Watch Together")

Discord lets call participants launch shared "activities" inside the call
view — synced video players, mini-games, etc. We have most of the
infrastructure already (1:1 calls, perfect-negotiation renegotiation,
WS signaling, screen-share UI). Adding activities is mostly product work
on top.

### Watch party (synced video)

Two concrete options:

1. **Embed-based, synced state via WS.** One participant launches the
   activity → loads a video URL into an `<iframe>` (YouTube IFrame API,
   Vimeo, etc.) inside the call view. Player state (play / pause / seek
   time) gets broadcast through the existing `call.state` message
   channel — extend it with `activity: { kind, url, time, paused }`.
   Pros: cheap; no media bandwidth on our side. Cons: each viewer's
   browser independently loads the video (and the ads).

2. **One participant streams via screen share.** Already supported
   today — just needs a UX wrapper that says "watch together" and
   opens YouTube/etc. in a new browser window pre-shared via the
   screen-share tile. Cleaner ad-free experience because only the host
   sees ads. Cons: bandwidth scales with resolution; framerate isn't
   perfect.

Probably do **(1)** first — lower bandwidth, and the sync feels more
like Discord's experience. Add `(2)` as an explicit "share my browser"
button if needed.

### Group call invites (UI + flow)

Mesh signaling works in 0.1.32 for voice CHANNELS (clicking joins the
persistent room). For group DM voice calls we still need a "Call this
group" button that:
1. Generates a roomId UUID.
2. Server fans out `call.invite` to all chat members with that roomId.
3. Each accepter triggers `room.join` with the same roomId.
4. Mesh handles the rest.

This is mostly UI — the WS plumbing and MeshSession already work.

### YouTube with adblock

Not trivial. YouTube serves ads as part of the same stream now (no
separate ad domain to block). Options that work:

- **SponsorBlock**-style segment skipping via the YouTube IFrame API
  + a community segment database. Works for sponsor reads and intros,
  but not pre-roll ads.
- Route through **invidious / piped / NewPipe-extractor** instances.
  These fetch raw video URLs from YouTube and re-stream them to the
  client without ads. Needs a server-side proxy (similar to our
  /api/embed/resolve).
- Use **yt-dlp** server-side to extract the direct CDN URL, render it
  in our custom video player. No iframe at all → no ads possible.
  Best UX but heaviest server load (yt-dlp is ~30MB of Python).

Likely path: ship piped/invidious resolver as `/api/embed/youtube`
that returns the same shape as the current Catbox/medal.tv resolver.
Renderer treats `youtube.com/watch?v=...` URLs like medal.tv links.

### streamex.sh integration

Same shape as the YouTube path: server resolves a streamex URL to the
direct video URL via their JSON endpoints (or scrapes the page),
renderer plays it through the custom video player. May need
referrer-spoofing on the proxy fetch. Add the host to the
EMBED_ALLOWED_HOSTS allowlist in server.js.

### Other activity ideas (further out)

- Shared whiteboard (canvas + WS state diffs)
- Mini-games (pool, chess) — heavy product work, maybe iframes from
  jackbox-style hosts
- Music listening parties (Spotify/SoundCloud sync)

## Existing tech to reuse

- `/api/embed/resolve` already follows an allowlist + parses HTML for
  metadata. Extend it for YouTube / streamex by adding hosts.
- `call.state` WS broadcast is the right channel for activity state
  sync — already encrypted via WSS, already auth'd.
- The custom video player (kvp) already supports any direct MP4 URL,
  so resolver-based playback drops in.
- Screen share is the simplest fallback for any unsupported source —
  just have the host share their browser tab.
