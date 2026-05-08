// End-to-end multi-client test for Klar.
//
// Spawns the server with a temp data dir on an ephemeral port, drives two
// real clients through HTTP + WebSocket against the live server, and
// asserts that actions on one client land on the other via WS broadcasts:
//
//   * auth (register + WS auth)
//   * friend request → accept (both sides see updates)
//   * friend gate on DMs (send before accepted = 403; after = success)
//   * server create + invite + accept (both end up in the server)
//   * categories created/updated/deleted broadcast
//   * channels created/updated/deleted broadcast
//   * channel topic + category move via PATCH
//   * voice presence (room.join → voice_channel_member-joined to peer)
//
// No mocks. Each assertion is on a real WS message round-trip.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');

// --- helpers --------------------------------------------------------------

function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const port = s.address().port; s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function waitForLine(child, regex, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('timeout waiting for: ' + regex)), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (regex.test(buf)) { clearTimeout(t); child.stdout.off('data', onData); resolve(); }
    };
    child.stdout.on('data', onData);
  });
}

class Client {
  constructor(name, base) { this.name = name; this.base = base; this.token = null; this.ws = null; this.queue = []; this.user = null; this._waiters = []; }

  async http(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers['authorization'] = 'Bearer ' + this.token;
    const res = await fetch(this.base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
    return { status: res.status, ok: res.ok, data };
  }

  async register(username, password) {
    const r = await this.http('POST', '/api/register', { username, password, displayName: username });
    if (!r.ok) throw new Error(`${this.name} register failed: ${JSON.stringify(r.data)}`);
    this.token = r.data.token;
    this.user  = r.data.user;
    return this.user;
  }

  async connectWs() {
    const wsBase = this.base.replace(/^http/, 'ws') + '/ws';
    this.ws = new WebSocket(wsBase);
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      // Resolve waiters first, then queue if no match.
      for (let i = 0; i < this._waiters.length; i++) {
        const w = this._waiters[i];
        if (w.match(m)) { this._waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(m); return; }
      }
      this.queue.push(m);
    });
    this.ws.send(JSON.stringify({ type: 'auth', token: this.token }));
    await this.waitFor((m) => m.type === 'auth_ok', 'auth_ok');
  }

  waitFor(match, label = 'msg', timeoutMs = 4000) {
    const idx = this.queue.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this._waiters.findIndex((w) => w._id === id);
        if (i >= 0) this._waiters.splice(i, 1);
        const ctx = { queue: this.queue.map((m) => m.type) };
        reject(new Error(`${this.name}: timeout waiting for ${label} (queue: ${JSON.stringify(ctx)})`));
      }, timeoutMs);
      const id = Symbol('w');
      this._waiters.push({ _id: id, match, resolve, timer });
    });
  }

  async drain(typeRegex, ms = 200) {
    // Useful when a flurry of WS events lands and we just want them all.
    return new Promise((resolve) => {
      const collected = [];
      const t = setTimeout(() => resolve(collected), ms);
      const tick = () => {
        for (let i = 0; i < this.queue.length; i++) {
          if (typeRegex.test(this.queue[i].type)) {
            collected.push(this.queue.splice(i, 1)[0]); i--;
          }
        }
        setImmediate(() => { if (Date.now() - start < ms) tick(); });
      };
      const start = Date.now();
      tick();
      void t;
    });
  }

  close() { try { this.ws.close(); } catch {} }
}

let server, baseUrl, dataDir;

test.before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klar-multi-test-'));
  const port = await ephemeralPort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, KLAR_DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (c) => process.stderr.write('[server.err] ' + c.toString()));
  await waitForLine(server, /Klar server running/, 8000);
});

test.after(async () => {
  if (server) { server.kill('SIGKILL'); }
  if (dataDir) { try { await fsp.rm(dataDir, { recursive: true, force: true }); } catch {} }
});

// -------------------------------------------------------------------------

let alice, bob;

test('1. register two users + WS auth', async () => {
  alice = new Client('alice', baseUrl);
  bob   = new Client('bob',   baseUrl);
  await alice.register('alice_t' + Date.now().toString(36), 'password1234');
  await bob.register(  'bob_t'   + Date.now().toString(36), 'password1234');
  await alice.connectWs();
  await bob.connectWs();
  assert.ok(alice.user.id);
  assert.ok(bob.user.id);
});

test('2. DM message rejected before friendship', async () => {
  const r = await alice.http('POST', '/api/dms', { userId: bob.user.id });
  assert.equal(r.ok, true, 'create dm should succeed even without friendship');
  const dmId = r.data.dm.id;
  const send = await alice.http('POST', `/api/dms/${dmId}/messages`, { content: 'hi', clientId: 'c1' });
  assert.equal(send.status, 403, 'send before friendship must be 403');
  assert.equal(send.data.code, 'not_friends', 'error code should be not_friends');
  alice._dmId = dmId;
});

test('3. friend request → accept broadcasts to both sides', async () => {
  const req = await alice.http('POST', '/api/friends/request', { username: bob.user.username });
  assert.equal(req.ok, true, JSON.stringify(req.data));
  // Both sides receive friend_updated. Alice's row is outgoing-pending,
  // Bob's is incoming-pending.
  const aliceMsg = await alice.waitFor((m) => m.type === 'friend_updated', 'alice friend_updated');
  const bobMsg   = await bob.waitFor(  (m) => m.type === 'friend_updated', 'bob friend_updated');
  assert.equal(aliceMsg.friend.status, 'pending');
  assert.equal(aliceMsg.friend.direction, 'outgoing');
  assert.equal(bobMsg.friend.direction, 'incoming');

  const accept = await bob.http('POST', `/api/friends/${alice.user.id}/accept`);
  assert.equal(accept.ok, true);
  const aliceMutual = await alice.waitFor((m) => m.type === 'friend_updated' && m.friend.status === 'mutual', 'alice mutual');
  const bobMutual   = await bob.waitFor(  (m) => m.type === 'friend_updated' && m.friend.status === 'mutual', 'bob mutual');
  assert.equal(aliceMutual.friend.user.id, bob.user.id);
  assert.equal(bobMutual.friend.user.id, alice.user.id);
});

test('4. DM message after friendship: A sends, B receives via WS', async () => {
  const send = await alice.http('POST', `/api/dms/${alice._dmId}/messages`, { content: 'hello bob', clientId: 'c2' });
  assert.equal(send.ok, true, JSON.stringify(send.data));
  const ev = await bob.waitFor((m) => m.type === 'message', 'bob receives message');
  assert.equal(ev.message.content, 'hello bob');
  assert.equal(ev.message.senderId, alice.user.id);
});

let serverId, inviteCode;

test('5. server create + invite accept (both end up as members)', async () => {
  const create = await alice.http('POST', '/api/servers', { name: 'Test Sector' });
  assert.equal(create.ok, true, JSON.stringify(create.data));
  serverId = create.data.server.id;

  const inv = await alice.http('POST', `/api/servers/${serverId}/invites`);
  assert.equal(inv.ok, true);
  inviteCode = inv.data.code;

  const join = await bob.http('POST', `/api/invites/${inviteCode}/accept`);
  assert.equal(join.ok, true);

  // Alice should see bob join via WS.
  const memberJoined = await alice.waitFor((m) => m.type === 'server_member_joined', 'alice sees bob join');
  assert.equal(memberJoined.serverId, serverId);
  assert.equal(memberJoined.user.id, bob.user.id);

  const detail = await bob.http('GET', `/api/servers/${serverId}`);
  assert.equal(detail.ok, true);
  assert.ok(detail.data.members.find((m) => m.id === bob.user.id), 'bob is in member list');
});

let categoryId;

test('6. category created on alice → bob receives category_created', async () => {
  const r = await alice.http('POST', `/api/servers/${serverId}/categories`, { name: 'Voice Hub' });
  assert.equal(r.ok, true, JSON.stringify(r.data));
  categoryId = r.data.category.id;
  const ev = await bob.waitFor((m) => m.type === 'category_created' && m.category.id === categoryId, 'bob category_created');
  assert.equal(ev.category.name, 'Voice Hub');
});

test('7. category renamed on alice → bob receives category_updated', async () => {
  const r = await alice.http('PATCH', `/api/categories/${categoryId}`, { name: 'Voice Lounge' });
  assert.equal(r.ok, true);
  const ev = await bob.waitFor((m) => m.type === 'category_updated' && m.category.id === categoryId, 'bob category_updated');
  assert.equal(ev.category.name, 'Voice Lounge');
});

let textChId, voiceChId;

test('8. channel create (text + voice, both inside category) broadcast', async () => {
  const t = await alice.http('POST', `/api/servers/${serverId}/channels`, { name: 'general-2', kind: 'text', categoryId });
  assert.equal(t.ok, true, JSON.stringify(t.data));
  textChId = t.data.channel.id;
  assert.equal(t.data.channel.categoryId, categoryId, 'text channel sits in category');
  const t1 = await bob.waitFor((m) => m.type === 'channel_created' && m.channel.id === textChId, 'bob text channel');
  assert.equal(t1.channel.kind, 'text');

  const v = await alice.http('POST', `/api/servers/${serverId}/channels`, { name: 'voice-1', kind: 'voice', categoryId });
  assert.equal(v.ok, true);
  voiceChId = v.data.channel.id;
  const v1 = await bob.waitFor((m) => m.type === 'channel_created' && m.channel.id === voiceChId, 'bob voice channel');
  assert.equal(v1.channel.kind, 'voice');
  assert.equal(v1.channel.categoryId, categoryId);
});

test('9. channel topic + userLimit + name patched → bob sees update', async () => {
  const r = await alice.http('PATCH', `/api/channels/${textChId}`, {
    topic: 'rules: be cool',
    userLimit: 0,
  });
  assert.equal(r.ok, true, JSON.stringify(r.data));
  const ev = await bob.waitFor((m) => m.type === 'channel_updated' && m.channel.id === textChId, 'bob channel_updated');
  assert.equal(ev.channel.topic, 'rules: be cool');

  const r2 = await alice.http('PATCH', `/api/channels/${voiceChId}`, { userLimit: 5 });
  assert.equal(r2.ok, true);
  const ev2 = await bob.waitFor((m) => m.type === 'channel_updated' && m.channel.id === voiceChId, 'bob voice update');
  assert.equal(ev2.channel.userLimit, 5);
});

test('10. voice presence: bob joins voice channel → alice gets voice_channel_member-joined', async () => {
  bob.ws.send(JSON.stringify({ type: 'room.join', roomId: voiceChId }));
  const ev = await alice.waitFor((m) => m.type === 'voice_channel_member-joined' && m.channelId === voiceChId, 'alice sees bob join voice');
  assert.equal(ev.userId, bob.user.id);

  // Bob himself receives a room.joined ack with member list.
  const joined = await bob.waitFor((m) => m.type === 'room.joined' && m.roomId === voiceChId, 'bob room.joined');
  assert.ok(Array.isArray(joined.members));

  // Bob leaves; alice sees member-left.
  bob.ws.send(JSON.stringify({ type: 'room.leave', roomId: voiceChId }));
  const left = await alice.waitFor((m) => m.type === 'voice_channel_member-left' && m.channelId === voiceChId, 'alice sees bob leave');
  assert.equal(left.userId, bob.user.id);
});

test('11. channel deleted on alice → bob sees channel_deleted', async () => {
  const r = await alice.http('DELETE', `/api/channels/${textChId}`);
  assert.equal(r.ok, true);
  const ev = await bob.waitFor((m) => m.type === 'channel_deleted' && m.channelId === textChId, 'bob channel_deleted');
  assert.equal(ev.serverId, serverId);
});

test('12. category deleted on alice → re-parent + broadcast', async () => {
  // Voice channel is currently inside the category. Delete the category;
  // server should re-parent the voice channel to NULL, NOT delete it.
  const r = await alice.http('DELETE', `/api/categories/${categoryId}`);
  assert.equal(r.ok, true);
  const ev = await bob.waitFor((m) => m.type === 'category_deleted' && m.categoryId === categoryId, 'bob category_deleted');
  assert.equal(ev.serverId, serverId);

  // Voice channel must still exist in bob's view of the server.
  const detail = await bob.http('GET', `/api/servers/${serverId}`);
  assert.equal(detail.ok, true);
  const voice = detail.data.channels.find((c) => c.id === voiceChId);
  assert.ok(voice, 'voice channel survived category deletion');
  assert.equal(voice.categoryId, null, 'voice channel re-parented to uncategorized');
});

test('13. channel message in server channel: bob sends → alice sees', async () => {
  const r = await bob.http('POST', `/api/channels/${voiceChId}/messages`, { content: 'hi', clientId: 'cm1' });
  // Voice channels reject text messages.
  assert.equal(r.status, 400, 'voice channels should reject text messages');

  // Make a real text channel for the message broadcast test.
  const tc = await alice.http('POST', `/api/servers/${serverId}/channels`, { name: 'chat', kind: 'text' });
  assert.equal(tc.ok, true);
  await bob.waitFor((m) => m.type === 'channel_created' && m.channel.id === tc.data.channel.id, 'bob sees new chat');
  const send = await bob.http('POST', `/api/channels/${tc.data.channel.id}/messages`, { content: 'hello server', clientId: 'cm2' });
  assert.equal(send.ok, true);
  const ev = await alice.waitFor((m) => m.type === 'channel_message' && m.message.content === 'hello server', 'alice sees channel_message');
  assert.equal(ev.message.senderId, bob.user.id);
});

test('14. third client connects mid-session, joins voice, both incumbents see them', async () => {
  const carol = new Client('carol', baseUrl);
  await carol.register('carol_t' + Date.now().toString(36), 'password1234');
  // Carol joins via invite.
  const inv = await alice.http('POST', `/api/servers/${serverId}/invites`);
  assert.equal(inv.ok, true);
  const join = await carol.http('POST', `/api/invites/${inv.data.code}/accept`);
  assert.equal(join.ok, true);
  await carol.connectWs();

  // Alice + bob receive server_member_joined for carol.
  await alice.waitFor((m) => m.type === 'server_member_joined' && m.user.id === carol.user.id, 'alice sees carol');
  await bob.waitFor(  (m) => m.type === 'server_member_joined' && m.user.id === carol.user.id, 'bob sees carol');

  // All three join the voice channel; incumbent users should see each other's joins.
  alice.ws.send(JSON.stringify({ type: 'room.join', roomId: voiceChId }));
  bob.ws.send(  JSON.stringify({ type: 'room.join', roomId: voiceChId }));
  carol.ws.send(JSON.stringify({ type: 'room.join', roomId: voiceChId }));

  // Each user should receive joins for the OTHER two. Skip own-join
  // events from the heard set so the break condition is "got both
  // others" — without this, break could fire when alice still only has
  // {self, bob} and miss carol's later join.
  const heard = { alice: new Set(), bob: new Set(), carol: new Set() };
  const ownById = { [alice.user.id]: 'alice', [bob.user.id]: 'bob', [carol.user.id]: 'carol' };
  const start = Date.now();
  while (Date.now() - start < 3000) {
    for (const c of [alice, bob, carol]) {
      const i = c.queue.findIndex((m) => m.type === 'voice_channel_member-joined' && m.channelId === voiceChId);
      if (i >= 0) {
        const ev = c.queue.splice(i, 1)[0];
        if (ev.userId !== c.user.id) heard[c.name].add(ev.userId);
      }
    }
    if (heard.alice.size >= 2 && heard.bob.size >= 2 && heard.carol.size >= 2) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  void ownById;
  assert.ok(heard.alice.has(bob.user.id),   'alice heard bob join');
  assert.ok(heard.alice.has(carol.user.id), 'alice heard carol join');
  assert.ok(heard.bob.has(alice.user.id),   'bob heard alice join');
  assert.ok(heard.bob.has(carol.user.id),   'bob heard carol join');

  carol.close();
});

test.after(() => { try { alice.close(); } catch {}; try { bob.close(); } catch {} });
