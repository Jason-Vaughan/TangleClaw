'use strict';

/**
 * #996 — the Project Master as a Medusa switchboard participant.
 *
 * What is pinned, in the order it can fail:
 *   1. Lifecycle: the Master's listener exists exactly when the Master is LIVE
 *      and `master.medusaEnabled` is on — through ensure, kill, boot re-sync
 *      and the settings PATCH — and never for a Master tmux cannot confirm.
 *   2. Identity: the workspace id is pinned to the Master's home, so it
 *      survives kill → ensure (peers never have to re-fetch the roster).
 *   3. The access level gates the OUTBOUND half only: `read-only` receives,
 *      `suggest`/`write` send; the gate reads config per request, so a flip
 *      binds with no restart.
 *   4. The routes are the SAME family as a project's, mounted at
 *      `/api/master/medusa/*`, and the Master's instructions tell it so.
 *
 * tmux is an injected fake throughout — no real `tangleclaw-master` session is
 * ever probed, created, typed into or killed — and every home is a temp dir,
 * so the operator's real `~/.tangleclaw/master` is never read or written.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');
delete process.env.TANGLECLAW_PORT;

const store = require('../lib/store');
const medusa = require('../lib/medusa');
const master = require('../lib/master');
const { createServer } = require('../server');

const NO_FLEET = async () => ({ refreshed: false, count: 0 });
const OPEN = 1;

/** Minimal fake WebSocket, the same shape `test/api-medusa.test.js` drives. */
class FakeWS {
  /** @param {string} url - Requested URL. */
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this._h = Object.create(null);
  }

  /** @param {string} t @param {Function} h @returns {void} */
  addEventListener(t, h) { (this._h[t] || (this._h[t] = [])).push(h); }

  /** @param {string} d @returns {void} */
  send(d) { this.sent.push(d); }

  /** @returns {void} */
  close() { this.readyState = 3; }

  /** @param {string} t @param {object} e @returns {void} */
  _fire(t, e) { for (const h of this._h[t] || []) h(e); }

  /** Open the socket and complete the register handshake. @returns {void} */
  _openAndRegister() {
    this.readyState = OPEN;
    this._fire('open', {});
    const reg = JSON.parse(this.sent[0]);
    this._fire('message', { data: JSON.stringify({ type: 'registered', workspaceId: reg.workspaceId, connectionId: 'c1' }) });
  }

  /** @param {object} message @returns {void} */
  _deliver(message) {
    this._fire('message', { data: JSON.stringify({ type: 'new_message', messageId: message.id, message }) });
  }
}

/**
 * A tmux fake with programmable liveness, derived the way `lib/tmux.js`
 * derives it (`hasSession` from `probeSession`), recording what was typed.
 * @param {object} [opts]
 * @param {boolean} [opts.alive] - Session live.
 * @param {boolean} [opts.answered] - tmux replied at all.
 * @returns {object}
 */
function fakeTmux({ alive = true, answered = true } = {}) {
  const typed = [];
  const probeSession = () => ({ live: answered ? alive : false, answered, cause: answered ? null : 'read-timed-out' });
  return {
    typed,
    probeSession,
    hasSession: () => probeSession().live,
    createSession: () => true,
    killSession: () => true,
    sendKeys: (session, text, options) => { typed.push({ session, text, options }); }
  };
}

/** @returns {string} A fresh temp master home. */
function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-medusa-home-'));
}

/**
 * Persist a master settings block into the temp store.
 * @param {object} patch - Fields to set.
 * @returns {void}
 */
function setMaster(patch) {
  const config = store.config.load();
  config.master = { ...master.masterSettings(config), ...patch };
  store.config.save(config);
}

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-medusa-'));
  store._setBasePath(tmpDir);
  store.init();
});

after(() => {
  medusa.stopSession(master.MASTER_MEDUSA_KEY);
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  medusa.stopSession(master.MASTER_MEDUSA_KEY);
});

describe('masterSettings — the two switchboard opt-ins', () => {
  it('default OFF, and only a real boolean true turns them on', () => {
    assert.equal(master.masterSettings({}).medusaEnabled, false);
    assert.equal(master.masterSettings({}).medusaWake, false);
    assert.equal(master.masterSettings({ master: { medusaEnabled: 'true' } }).medusaEnabled, false);
    assert.equal(master.masterSettings({ master: { medusaEnabled: true, medusaWake: true } }).medusaEnabled, true);
    assert.equal(master.masterSettings({ master: { medusaEnabled: true, medusaWake: true } }).medusaWake, true);
  });
});

describe('masterMedusaOutbound — the access level gates sending, never receiving', () => {
  it('read-only cannot send, and the reason names the level and the remedy', () => {
    const v = master.masterMedusaOutbound('read-only');
    assert.equal(v.allowed, false);
    assert.match(v.reason, /"read-only"/);
    assert.match(v.reason, /suggest|write/);
  });
  it('suggest and write can send', () => {
    assert.deepEqual(master.masterMedusaOutbound('suggest'), { allowed: true, reason: null });
    assert.deepEqual(master.masterMedusaOutbound('write'), { allowed: true, reason: null });
  });
  it('an unrecognised level fails closed', () => {
    assert.equal(master.masterMedusaOutbound('god-mode').allowed, false);
    assert.equal(master.masterMedusaOutbound(undefined).allowed, false);
  });
});

describe('ensureMasterSession — the listener follows live ∧ enabled', () => {
  let home;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('starts the listener for a live Master when medusaEnabled is on, and reports it', () => {
    setMaster({ medusaEnabled: true });
    let ws;
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux({ alive: true }), wsFactory: (u) => (ws = new FakeWS(u)) });
    assert.equal(r.error, undefined);
    assert.ok(ws, 'a socket was opened for the Master');
    assert.equal(r.medusa.state, 'connecting');
    assert.match(r.medusa.workspaceId, /^project-master-[0-9a-f]{8}$/, 'minted from the Master name');
    assert.equal(master.getMasterMedusaStatus().workspaceId, r.medusa.workspaceId);
  });

  it('does NOT start a listener when medusaEnabled is off — and stops one that was running', () => {
    setMaster({ medusaEnabled: true });
    master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux(), wsFactory: (u) => new FakeWS(u) });
    assert.notEqual(master.getMasterMedusaStatus().state, 'off');
    setMaster({ medusaEnabled: false });
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux(), wsFactory: (u) => new FakeWS(u) });
    assert.equal(r.medusa.state, 'off');
    assert.equal(master.getMasterMedusaStatus().state, 'off');
  });

  it('an unanswered tmux probe starts nothing — no listener for a Master that may not exist', () => {
    setMaster({ medusaEnabled: true });
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux({ answered: false }), wsFactory: (u) => new FakeWS(u) });
    assert.ok(r.error);
    assert.equal(master.getMasterMedusaStatus().state, 'off');
  });

  it('the workspace id is pinned to the home — kill → ensure yields the SAME id', () => {
    setMaster({ medusaEnabled: true });
    const a = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux(), wsFactory: (u) => new FakeWS(u) });
    const killed = master.killMasterSession({ tmuxLib: fakeTmux({ alive: true }) });
    assert.equal(killed.killed, true);
    assert.equal(master.getMasterMedusaStatus().state, 'off', 'a confirmed kill tears the listener down');
    const b = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux(), wsFactory: (u) => new FakeWS(u) });
    assert.equal(b.medusa.workspaceId, a.medusa.workspaceId);
    assert.ok(fs.existsSync(path.join(home, '.tangleclaw', 'medusa', 'registry.json')), 'persisted under the Master home');
  });

  it('the identity carries the workspace id, the routes, and the initiator-closes rule', () => {
    setMaster({ medusaEnabled: true, accessLevel: 'write' });
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux(), wsFactory: (u) => new FakeWS(u) });
    const identity = fs.readFileSync(master.masterIdentityPath(home), 'utf8');
    assert.match(identity, /## Medusa Switchboard/);
    assert.ok(identity.includes(r.medusa.workspaceId), 'the id the listener registered under');
    assert.match(identity, /GET \/api\/master\/medusa\/messages/);
    assert.match(identity, /POST \/api\/master\/medusa\/send/);
    assert.match(identity, /you close the loop/i);
    assert.match(identity, /Sending is enabled/);
    const howto = fs.readFileSync(path.join(home, 'memory', 'HOWTO.md'), 'utf8');
    assert.match(howto, /you are a participant/);
    assert.doesNotMatch(howto, /you are not a participant/);
  });

  it('a read-only Master is told its sends are refused, and why', () => {
    setMaster({ medusaEnabled: true, accessLevel: 'read-only' });
    master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux(), wsFactory: (u) => new FakeWS(u) });
    const identity = fs.readFileSync(master.masterIdentityPath(home), 'utf8');
    assert.match(identity, /Sending is disabled/);
    assert.match(identity, /403 `ACCESS_LEVEL`/);
  });

  it('with the setting off the identity has no switchboard section and HOWTO says so honestly', () => {
    setMaster({ medusaEnabled: false });
    master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux(), wsFactory: (u) => new FakeWS(u) });
    const identity = fs.readFileSync(master.masterIdentityPath(home), 'utf8');
    assert.doesNotMatch(identity, /## Medusa Switchboard/);
    const howto = fs.readFileSync(path.join(home, 'memory', 'HOWTO.md'), 'utf8');
    assert.match(howto, /you are not a participant/);
    assert.match(howto, /control bar/, 'names where to turn it on');
  });
});

describe('killMasterSession — the listener dies with a CONFIRMED kill only', () => {
  let home;
  beforeEach(() => {
    home = tempHome();
    setMaster({ medusaEnabled: true });
    master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux(), wsFactory: (u) => new FakeWS(u) });
    assert.notEqual(master.getMasterMedusaStatus().state, 'off');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('an already-absent Master also drops its listener (#836 shape)', () => {
    master.killMasterSession({ tmuxLib: fakeTmux({ alive: false }) });
    assert.equal(master.getMasterMedusaStatus().state, 'off');
  });

  it('an UNCONFIRMED kill keeps the listener — the Master may still be running', () => {
    const t = fakeTmux({ alive: true });
    t.killSession = () => false;
    const r = master.killMasterSession({ tmuxLib: t });
    assert.equal(r.killed, false);
    assert.notEqual(master.getMasterMedusaStatus().state, 'off');
  });

  it('a silent tmux keeps the listener too', () => {
    master.killMasterSession({ tmuxLib: fakeTmux({ answered: false }) });
    assert.notEqual(master.getMasterMedusaStatus().state, 'off');
  });
});

describe('resyncMasterMedusa — the boot half', () => {
  let home;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('starts the listener for a live Master with the setting on', () => {
    setMaster({ medusaEnabled: true });
    const r = master.resyncMasterMedusa({ home, tmuxLib: fakeTmux({ alive: true }), wsFactory: (u) => new FakeWS(u) });
    assert.deepEqual(r, { resynced: true, live: true });
    assert.notEqual(master.getMasterMedusaStatus().state, 'off');
  });

  it('does nothing with the setting off, even for a live Master', () => {
    setMaster({ medusaEnabled: false });
    const r = master.resyncMasterMedusa({ home, tmuxLib: fakeTmux({ alive: true }), wsFactory: (u) => new FakeWS(u) });
    assert.equal(r.resynced, false);
    assert.equal(master.getMasterMedusaStatus().state, 'off');
  });

  it('does nothing for an absent Master, and reports unknown for a silent tmux', () => {
    setMaster({ medusaEnabled: true });
    assert.deepEqual(master.resyncMasterMedusa({ home, tmuxLib: fakeTmux({ alive: false }), wsFactory: (u) => new FakeWS(u) }), { resynced: false, live: false });
    assert.equal(master.getMasterMedusaStatus().state, 'off');
    assert.deepEqual(master.resyncMasterMedusa({ home, tmuxLib: fakeTmux({ answered: false }), wsFactory: (u) => new FakeWS(u) }), { resynced: false, live: null });
    assert.equal(master.getMasterMedusaStatus().state, 'off');
  });
});

describe('masterWakeRecord / injectMasterCommand — what medusa-wake sees and types', () => {
  it('a live Master is a session-shaped record carrying its opt-in and API base', () => {
    setMaster({ medusaWake: true });
    const rec = master.masterWakeRecord({ tmuxLib: fakeTmux({ alive: true }) });
    assert.equal(rec.id, master.MASTER_MEDUSA_KEY);
    assert.equal(rec.isMaster, true);
    assert.equal(rec.tmuxSession, master.MASTER_TMUX_SESSION);
    assert.equal(rec.sessionMode, 'tmux');
    assert.equal(rec.status, 'active');
    assert.equal(rec.medusaWake, true);
    assert.equal(rec.apiBase, '/api/master/medusa');
  });

  it('an absent Master, or a silent tmux, is null — nothing to type into', () => {
    assert.equal(master.masterWakeRecord({ tmuxLib: fakeTmux({ alive: false }) }), null);
    assert.equal(master.masterWakeRecord({ tmuxLib: fakeTmux({ answered: false }) }), null);
  });

  it('injects into the reserved tmux session, Enter included, when live', () => {
    const t = fakeTmux({ alive: true });
    const r = master.injectMasterCommand('[TangleClaw Switchboard] nudge', { tmuxLib: t });
    assert.deepEqual(r, { ok: true, error: null });
    assert.equal(t.typed.length, 1);
    assert.equal(t.typed[0].session, master.MASTER_TMUX_SESSION);
    assert.equal(t.typed[0].options.enter, true);
  });

  it('refuses when the Master is not running, when tmux is silent, and over the length cap', () => {
    const absent = fakeTmux({ alive: false });
    assert.equal(master.injectMasterCommand('x', { tmuxLib: absent }).ok, false);
    assert.equal(absent.typed.length, 0);
    const silent = fakeTmux({ answered: false });
    assert.equal(master.injectMasterCommand('x', { tmuxLib: silent }).ok, false);
    assert.equal(silent.typed.length, 0);
    const live = fakeTmux({ alive: true });
    assert.match(master.injectMasterCommand('x'.repeat(4097), { tmuxLib: live }).error, /4096/);
    assert.equal(live.typed.length, 0);
  });
});

/**
 * A fake Bridge HTTP server: roster + direct send + loop open, the subset the
 * Master routes under test reach.
 * @returns {{server: import('node:http').Server, received: object[], loops: object[]}}
 */
function makeFakeBridge() {
  const received = [];
  const loops = [];
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (req.method === 'GET' && req.url === '/workspaces') {
        return json(res, 200, {
          count: 2,
          workspaces: [
            { id: 'live-ws', name: 'Live', listener: { active: true }, connected: true },
            { id: master.getMasterMedusaStatus().workspaceId, name: 'Project Master', listener: { active: true }, connected: true }
          ]
        });
      }
      if (req.method === 'POST' && req.url === '/messages/direct') {
        received.push(body);
        return json(res, 200, { success: true, status: 'received', id: 'r-1', message: 'Delivered over WebSocket.' });
      }
      if (req.method === 'POST' && req.url === '/loops') {
        loops.push(body);
        return json(res, 201, { id: `loop-${loops.length}`, initiator: body.initiator, target: body.target, state: 'initiated', round: 0 });
      }
      if (req.method === 'GET' && req.url.startsWith('/loops/')) return json(res, 404, { error: 'not found' });
      return json(res, 404, { error: 'unmatched' });
    });
  });
  return { server, received, loops };
}

describe('API — /api/master/medusa/* is the project route family, mounted for the Master', () => {
  let server;
  let port;
  let bridge;
  let home;
  const real = {};
  let liveness = { live: true, answered: true, cause: null };
  const identityRefreshes = [];

  before(async () => {
    home = tempHome();
    bridge = makeFakeBridge();
    await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
    medusa._setBridgeHttpUrl(`http://127.0.0.1:${bridge.server.address().port}`);

    // The routes reach tmux and the real master home through these two
    // exports; standing in for them is how `api-config.test.js` keeps
    // `applyMasterAccessLevel` off the operator's real home (#755).
    real.masterLiveness = master.masterLiveness;
    real.masterMedusaTarget = master.masterMedusaTarget;
    real.syncMasterMedusa = master.syncMasterMedusa;
    // The PATCH route regenerates the identity when medusaEnabled changes, and
    // the real refresher resolves `masterHome()` — the operator's own home.
    // Recorded, never run: the first version of this suite ran it, and
    // `api-config.test.js`'s live-home fingerprint caught it from another
    // process.
    real.refreshMasterIdentity = master.refreshMasterIdentity;
    master.refreshMasterIdentity = (opts) => { identityRefreshes.push(opts); return { home: '/stub', refreshed: true }; };
    master.masterLiveness = () => liveness;
    master.masterMedusaTarget = () => ({ projectPath: home, sessionId: master.MASTER_MEDUSA_KEY, name: master.MASTER_MEDUSA_NAME });
    master.syncMasterMedusa = (opts) => real.syncMasterMedusa({ ...opts, home, wsFactory: (u) => new FakeWS(u) });

    server = createServer();
    await new Promise((resolve) => server.listen(0, () => { port = server.address().port; resolve(); }));
  });

  beforeEach(() => {
    liveness = { live: true, answered: true, cause: null };
    setMaster({ medusaEnabled: false, accessLevel: 'write' });
    identityRefreshes.length = 0;
  });

  after(async () => {
    Object.assign(master, real);
    medusa._setBridgeHttpUrl();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => bridge.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath - Path.
   * @param {string} [method] - Method.
   * @param {object|null} [body] - JSON body.
   * @returns {Promise<{status: number, data: object}>}
   */
  function req(urlPath, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
      const r = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  /** Start the Master's listener (through the real service) and register it. @returns {FakeWS} */
  function startListening() {
    let ws;
    medusa.startSession({ projectPath: home, sessionId: master.MASTER_MEDUSA_KEY, name: master.MASTER_MEDUSA_NAME, wsFactory: (u) => (ws = new FakeWS(u)) });
    ws._openAndRegister();
    return ws;
  }

  it('status is `off` for a live Master with no listener, and carries the outbound verdict', async () => {
    const { status, data } = await req('/api/master/medusa/status');
    assert.equal(status, 200);
    assert.equal(data.state, 'off');
    assert.deepEqual(data.outbound, { allowed: true, reason: null });
  });

  it('status for a Master that is not running is still 200/off — a read never 409s', async () => {
    liveness = { live: false, answered: true, cause: null };
    const { status, data } = await req('/api/master/medusa/status');
    assert.equal(status, 200);
    assert.equal(data.state, 'off');
  });

  it('toggle 409s when the Master is not running, naming the Master rather than "no active session"', async () => {
    liveness = { live: false, answered: true, cause: null };
    const { status, data } = await req('/api/master/medusa/toggle', 'POST', { enabled: true });
    assert.equal(status, 409);
    assert.equal(data.code, 'NO_SESSION');
    assert.match(data.error, /Project Master is not running/);
  });

  it('toggle refuses on a silent tmux as UNKNOWN, never as "not running"', async () => {
    liveness = { live: false, answered: false, cause: 'read-timed-out' };
    const { status, data } = await req('/api/master/medusa/toggle', 'POST', { enabled: true });
    assert.equal(status, 409);
    assert.match(data.error, /did not answer/);
    assert.doesNotMatch(data.error, /is not running/);
  });

  it('toggle on starts the listener AND persists medusaEnabled — the setting outlives the session', async () => {
    const on = await req('/api/master/medusa/toggle', 'POST', { enabled: true });
    assert.equal(on.status, 200);
    assert.notEqual(on.data.state, 'off');
    assert.equal(master.masterSettings(store.config.load()).medusaEnabled, true);
    const off = await req('/api/master/medusa/toggle', 'POST', { enabled: false });
    assert.equal(off.data.state, 'off');
    assert.equal(master.masterSettings(store.config.load()).medusaEnabled, false);
  });

  it('messages + read work for the Master inbox', async () => {
    const ws = startListening();
    ws._deliver({ id: 'm1', from: 'live-ws', message: 'Master, a shared doc changed' });
    const inbox = await req('/api/master/medusa/messages');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.data.messages.length, 1);
    assert.equal(inbox.data.messages[0].message, 'Master, a shared doc changed');
    assert.equal((await req('/api/master/medusa/status')).data.unread, 1);
    const read = await req('/api/master/medusa/read', 'POST', {});
    assert.equal(read.status, 200);
    assert.equal(read.data.unread, 0);
  });

  it('roster lists the peers with the Master itself excluded', async () => {
    startListening();
    const { status, data } = await req('/api/master/medusa/roster');
    assert.equal(status, 200);
    assert.deepEqual(data.workspaces.map((w) => w.id), ['live-ws']);
  });

  it('send works at write, and the Bridge sees the Master as the sender', async () => {
    const ws = startListening();
    const from = JSON.parse(ws.sent[0]).workspaceId;
    const { status, data } = await req('/api/master/medusa/send', 'POST', { to: 'live-ws', message: 'please wrap' });
    assert.equal(status, 200);
    assert.equal(data.status, 'received');
    assert.equal(bridge.received.at(-1).from, from);
  });

  it('send is 403 ACCESS_LEVEL at read-only, and the Bridge never hears about it', async () => {
    startListening();
    setMaster({ accessLevel: 'read-only' });
    const before = bridge.received.length;
    const { status, data } = await req('/api/master/medusa/send', 'POST', { to: 'live-ws', message: 'do X' });
    assert.equal(status, 403);
    assert.equal(data.code, 'ACCESS_LEVEL');
    assert.match(data.error, /read-only/);
    assert.equal(bridge.received.length, before);
  });

  it('the gate reads config per request — a flip binds with no restart, both ways', async () => {
    startListening();
    setMaster({ accessLevel: 'read-only' });
    assert.equal((await req('/api/master/medusa/send', 'POST', { to: 'live-ws', message: 'a' })).status, 403);
    setMaster({ accessLevel: 'suggest' });
    assert.equal((await req('/api/master/medusa/send', 'POST', { to: 'live-ws', message: 'b' })).status, 200);
    setMaster({ accessLevel: 'read-only' });
    assert.equal((await req('/api/master/medusa/send', 'POST', { to: 'live-ws', message: 'c' })).status, 403);
  });

  it('status reports the refusal so a control can render a disabled send with its reason', async () => {
    setMaster({ accessLevel: 'read-only' });
    const { data } = await req('/api/master/medusa/status');
    assert.equal(data.outbound.allowed, false);
    assert.match(data.outbound.reason, /read-only/);
  });

  it('receiving is NOT gated at read-only — inbox and roster still answer', async () => {
    const ws = startListening();
    setMaster({ accessLevel: 'read-only' });
    ws._deliver({ id: 'm2', from: 'live-ws', message: 'fyi' });
    assert.equal((await req('/api/master/medusa/messages')).data.messages.length, 1);
    assert.equal((await req('/api/master/medusa/roster')).status, 200);
  });

  it('loop open is gated the same way: 403 at read-only, 200 at write', async () => {
    startListening();
    setMaster({ accessLevel: 'read-only' });
    const denied = await req('/api/master/medusa/loop', 'POST', { target: 'live-ws', task: 't', doneCriteria: 'd', mode: 'supervised' });
    assert.equal(denied.status, 403);
    assert.equal(bridge.loops.length, 0);
    setMaster({ accessLevel: 'write' });
    const ok = await req('/api/master/medusa/loop', 'POST', { target: 'live-ws', task: 't', doneCriteria: 'd', mode: 'supervised' });
    assert.equal(ok.status, 200);
    assert.equal(bridge.loops.length, 1);
  });

  it('the loop control verbs refuse at read-only before reaching the Bridge', async () => {
    startListening();
    setMaster({ accessLevel: 'read-only' });
    for (const verb of ['force-done', 'closeout']) {
      const r = await req(`/api/master/medusa/loops/loop-1/${verb}`, 'POST', {});
      assert.equal(r.status, 403, verb);
      assert.equal(r.data.code, 'ACCESS_LEVEL', verb);
    }
    const cont = await req('/api/master/medusa/loops/loop-1/continue', 'POST', { message: 'go on' });
    assert.equal(cont.status, 403);
  });

  it('the project mount still answers its own 409 wording — the family did not change shape', async () => {
    const projPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-medusa-proj-'));
    store.projects.create({ name: 'idle-proj', path: projPath, engine: 'claude' });
    const { status, data } = await req('/api/sessions/idle-proj/medusa/toggle', 'POST', {});
    assert.equal(status, 409);
    assert.equal(data.code, 'NO_SESSION');
    assert.equal(data.error, 'No active session to toggle Medusa for');
    fs.rmSync(projPath, { recursive: true, force: true });
  });

  it('PATCH /api/config { master: { medusaEnabled } } validates a boolean and syncs the listener at once', async () => {
    const bad = await req('/api/config', 'PATCH', { master: { medusaEnabled: 'yes' } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /medusaEnabled must be a boolean/);

    const on = await req('/api/config', 'PATCH', { master: { medusaEnabled: true } });
    assert.equal(on.status, 200);
    assert.equal(master.masterSettings(store.config.load()).medusaEnabled, true);
    assert.notEqual(master.getMasterMedusaStatus().state, 'off', 'listener started on save, not on the next ensure');

    const off = await req('/api/config', 'PATCH', { master: { medusaEnabled: false } });
    assert.equal(off.status, 200);
    assert.equal(master.getMasterMedusaStatus().state, 'off', 'and stopped on save');

    const wakeBad = await req('/api/config', 'PATCH', { master: { medusaWake: 1 } });
    assert.equal(wakeBad.status, 400);
  });

  it('PATCH with a silent tmux leaves the listener untouched', async () => {
    liveness = { live: false, answered: false, cause: 'read-timed-out' };
    const on = await req('/api/config', 'PATCH', { master: { medusaEnabled: true } });
    assert.equal(on.status, 200, 'the save itself stands');
    assert.equal(master.getMasterMedusaStatus().state, 'off');
  });

  it('GET /api/master/status carries the Medusa status, the outbound verdict, and both settings', async () => {
    setMaster({ medusaEnabled: true, medusaWake: true });
    startListening();
    const { status, data } = await req('/api/master/status');
    assert.equal(status, 200);
    assert.equal(data.settings.medusaEnabled, true);
    assert.equal(data.settings.medusaWake, true);
    assert.equal(data.medusa.state, 'listening');
    // The bar paints its control from THIS payload, so the verdict rides here
    // rather than costing a second request to /api/master/medusa/status.
    assert.deepEqual(data.medusa.outbound, { allowed: true, reason: null });
    setMaster({ accessLevel: 'read-only' });
    const ro = await req('/api/master/status');
    assert.equal(ro.data.medusa.outbound.allowed, false);
    assert.match(ro.data.medusa.outbound.reason, /read-only/);
  });

  it('PATCH regenerates the identity when medusaEnabled CHANGES — and only then', async () => {
    // The gap found the first time this was flipped live: the listener joined
    // the bus on save while the identity still told the Master it was not a
    // participant, until an unrelated ensure happened to run.
    await req('/api/config', 'PATCH', { master: { medusaEnabled: true } });
    assert.equal(identityRefreshes.length, 1, 'one refresh for the flip');
    assert.equal(identityRefreshes[0].skipIfAbsent, true, 'never creates master state on an install that has none');
    await req('/api/config', 'PATCH', { master: { medusaWake: true } });
    assert.equal(identityRefreshes.length, 1, 'an unrelated master save does not regenerate');
    await req('/api/config', 'PATCH', { master: { medusaEnabled: false } });
    assert.equal(identityRefreshes.length, 2, 'turning it off regenerates too — the section must leave the identity');
  });
});
