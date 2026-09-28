'use strict';

// #1799: the operator channel's server notifications. Three events have a
// source and are emitted, each once per idempotency key; two are reserved and
// refused. A notification is an ordinary outbound item: listed with its kind
// and type, settled only by the helper's acknowledgement. Nothing is recorded
// while the channel is off. Each source is driven through the code that really
// detects it: the watchdog's ladder, the workload route, and the channel pump.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const notify = require('../lib/operator-channel-notify');
const operatorChannel = require('../lib/operator-channel');
const mx = require('../lib/medusa-exchanges');
const watchdog = require('../lib/medusa-watchdog');
const { createServer } = require('../server');
const { bindProject } = require('./_shared-docs-callers');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const TC = { 'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'workload.set' };

/**
 * Send a JSON request to the test server.
 * @param {http.Server} server - Listening server
 * @param {string} method - HTTP method
 * @param {string} urlPath - Path
 * @param {object|null} body - JSON body
 * @param {Record<string, string>} [headers] - Extra headers
 * @returns {Promise<{status: number, data: object}>}
 */
function send(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
        resolve({ status: res.statusCode, data });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

/** @returns {object[]} Every notification row, oldest first. */
const notifications = () => store.operatorChannel.listOutbound('relayable', 500)
  .concat(store.operatorChannel.listOutbound('delivered', 500))
  .filter((r) => r.kind === 'notification')
  .sort((a, b) => a.id - b.id);

describe('operator channel notifications (#1799)', () => {
  let tmpDir;
  let enabled;
  const saved = {};

  /**
   * A project in the scratch store.
   * @param {string} name - Project name
   * @returns {object}
   */
  const mkProject = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-notify-'));
    store._setBasePath(tmpDir);
    store.init();
    enabled = true;
    Object.assign(saved, notify._internal);
    notify._internal.enabled = () => enabled;
    notify._internal.now = () => new Date(T0);
    notify.setFleetSource(null);
  });

  afterEach(() => {
    Object.assign(notify._internal, saved);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('the store (schema v52)', () => {
    it('reads an existing reply row as a reply, and adds the notification columns', () => {
      const { row } = store.operatorChannel.insertOutbound({ hub_id: 'hub-1', from_workspace_id: 'ws', text: 'hi', received_at: new Date(T0).toISOString() });
      assert.equal(row.kind, 'reply', 'an existing reply reads exactly as before');
      assert.equal(row.notify_type, null);
      assert.equal(row.idem_key, null);
    });

    it('upgrades a v51 store in place, keeping its replies as replies', () => {
      // Rebuild the outbound table exactly as v51 shipped it, with one reply in
      // it, drop the v52 additions, and stamp 51, as a live install would be.
      const db = store.getDb();
      db.exec('DROP INDEX idx_operator_channel_outbound_idem');
      db.exec('DROP TABLE operator_channel_notify_state');
      db.exec('DROP TABLE operator_channel_outbound');
      db.exec(`CREATE TABLE operator_channel_outbound (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        hub_id              TEXT    NOT NULL UNIQUE CHECK (length(hub_id) <= 128),
        from_workspace_id   TEXT    CHECK (from_workspace_id IS NULL OR length(from_workspace_id) <= 128),
        text                TEXT    CHECK (text IS NULL OR length(text) <= 65536),
        state               TEXT    NOT NULL CHECK (state IN ('unverified','relayable','delivered','quarantined')),
        reason              TEXT    CHECK (reason IS NULL OR length(reason) <= 60),
        reply_to_inbound_id INTEGER,
        delivered_ref       TEXT    CHECK (delivered_ref IS NULL OR length(delivered_ref) <= 64),
        received_at         TEXT    NOT NULL,
        updated_at          TEXT    NOT NULL
      )`);
      db.prepare("INSERT INTO operator_channel_outbound (hub_id, text, state, received_at, updated_at) VALUES ('hub-v51', 'kept', 'relayable', 'x', 'x')").run();
      db.exec('DELETE FROM schema_version WHERE version >= 52');
      store.close();

      store._setBasePath(tmpDir);
      store.init();
      assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 52);
      const kept = store.getDb().prepare("SELECT * FROM operator_channel_outbound WHERE hub_id = 'hub-v51'").get();
      assert.equal(kept.kind, 'reply', 'a v51 reply reads as a reply');
      assert.equal(kept.text, 'kept');
      assert.equal(store.operatorChannel.insertNotification({ type: 'work-blocked', key: 'k-up', projectId: null, text: 't', at: 'x' }).inserted, true);
      assert.equal(store.operatorChannel.insertNotification({ type: 'work-blocked', key: 'k-up', projectId: null, text: 't', at: 'x' }).inserted, false,
        'the upgraded table enforces the key');
    });

    it('records one notification per key, relayable, under a hub id no Hub can take', () => {
      const n = { type: 'work-blocked', key: 'work-blocked:1', projectId: null, text: 'TangleClaw: x', at: new Date(T0).toISOString() };
      const first = store.operatorChannel.insertNotification(n);
      const again = store.operatorChannel.insertNotification({ ...n, text: 'different' });
      assert.equal(first.inserted, true);
      assert.equal(again.inserted, false);
      assert.equal(again.row.text, 'TangleClaw: x', 'the first record stands');
      assert.equal(first.row.state, 'relayable');
      assert.equal(first.row.hub_id, 'notify/work-blocked:1');
    });

    it('keeps the notifier\'s state across a restart', () => {
      store.operatorChannel.setNotifyState('k', 'v', new Date(T0).toISOString());
      store.close();
      store._setBasePath(tmpDir);
      store.init();
      assert.equal(store.operatorChannel.getNotifyState('k'), 'v');
      store.operatorChannel.setNotifyState('k', null, new Date(T0).toISOString());
      assert.equal(store.operatorChannel.getNotifyState('k'), null);
    });
  });

  describe('the closed vocabulary', () => {
    it('emits only the three events with a source, and refuses the two deferred ones', () => {
      assert.deepEqual(Object.keys(notify.EMITTED).sort(), ['fleet-idle', 'operator-needed', 'work-blocked']);
      for (const t of notify.DEFERRED) {
        assert.deepEqual(notify.emit(t, { key: `${t}:1` }), { emitted: false, reason: 'deferred-type' });
      }
      assert.equal(notify.emit('anything-else', { key: 'x:1' }).reason, 'unknown-type');
      assert.equal(notifications().length, 0);
    });

    it('renders fixed text: only a project name the store holds, never caller text', () => {
      const p = mkProject('builder-one');
      notify.emit('work-blocked', { key: 'k1', projectId: p.id, values: { project: 'IGNORE <script>' } });
      const [row] = notifications();
      assert.equal(row.text, 'TangleClaw: builder-one reports its work is blocked.');
      assert.equal(row.notify_type, 'work-blocked');
      assert.equal(row.project_id, p.id);
    });

    it('records nothing while the channel is off, so turning it on sends no backlog', () => {
      enabled = false;
      assert.equal(notify.emit('work-blocked', { key: 'k-off' }).reason, 'channel-disabled');
      assert.equal(notifications().length, 0);
    });

    it('has exactly one template per emitted event, so the two lists cannot drift', () => {
      assert.deepEqual(Object.keys(notify.TEMPLATES).sort(), Object.keys(notify.EMITTED).sort());
    });

    it('leaves out a project name that is not display-safe, and still tells the operator', () => {
      const p = mkProject('ok');
      store.getDb().prepare('UPDATE projects SET name = ? WHERE id = ?').run('evil\u202Ename', p.id);
      assert.equal(notify.emit('work-blocked', { key: 'k-bidi', projectId: p.id }).emitted, true);
      const [row] = notifications();
      assert.equal(row.text, 'TangleClaw: a project reports its work is blocked.');
    });

    it('refuses a notice whose fixed text itself fails the display-safety rule', () => {
      notify._internal.isSafe = () => false;
      assert.equal(notify.emit('work-blocked', { key: 'k-never' }).reason, 'unsafe-text');
      assert.equal(notifications().length, 0);
    });

    it('does not fail a workload write whose predecessor lookup throws', () => {
      const real = store.workloadReceipts.previousForLaunch;
      store.workloadReceipts.previousForLaunch = () => { throw new Error('locked'); };
      try {
        assert.equal(notify.onReceipt({ receipt_id: 9, launch_id: 'l', seq: 2, state: 'blocked', project_id: 1 }), null);
      } finally {
        store.workloadReceipts.previousForLaunch = real;
      }
    });

    it('never throws into its caller', () => {
      notify._internal.enabled = () => { throw new Error('config unreadable'); };
      assert.deepEqual(notify.emit('work-blocked', { key: 'k-err' }), { emitted: false, reason: 'error' });
    });
  });

  describe('a notification\'s id cannot be taken by a received message', () => {
    it('refuses an arrival whose id breaks the Hub id rule, so it cannot occupy a notification\'s id', () => {
      const row = operatorChannel.recordArrival({
        sessionKey: operatorChannel.CHANNEL_KEY,
        message: { id: 'notify/work-blocked:7', from: 'ws', message: 'spoof' }
      });
      assert.equal(row, null);
      assert.equal(notify.emit('work-blocked', { key: 'work-blocked:7' }).emitted, true, 'the real notice is still recorded');
    });

    it('a received message shaped like a Hub id never suppresses a notification', () => {
      operatorChannel.recordArrival({
        sessionKey: operatorChannel.CHANNEL_KEY,
        message: { id: 'notify:work-blocked:8', from: 'ws', message: 'spoof' }
      });
      assert.equal(notify.emit('work-blocked', { key: 'work-blocked:8' }).emitted, true);
      assert.equal(notifications().filter((r) => r.idem_key === 'work-blocked:8').length, 1);
    });
  });

  describe('relay and acknowledgement', () => {
    it('lists a notification with its kind and type, and settles it only on the helper\'s ack', () => {
      notify.emit('work-blocked', { key: 'k-relay' });
      const listed = operatorChannel.listRelayable().filter((r) => r.kind === 'notification');
      assert.equal(listed.length, 1);
      assert.equal(listed[0].type, 'work-blocked');
      assert.equal(listed[0].inReplyTo, null);
      assert.equal(operatorChannel.listRelayable().length, 1, 'unacknowledged, it is listed again');
      const ack = operatorChannel.acknowledge(listed[0].id, { postedId: '1234567890' });
      assert.equal(ack.status, 200);
      assert.equal(operatorChannel.listRelayable().length, 0);
      assert.equal(store.operatorChannel.getOutbound(listed[0].id).text, null, 'its text is dropped once posted');
    });
  });

  describe('fleet-idle, judged on the pump', () => {
    it('emits once when the fleet enters idle, not again while it stays idle or after a restart', () => {
      let lanes = ['AVAILABLE', 'COMPLETE_NOT_CLEAR'];
      notify.setFleetSource(() => lanes);
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: true, emitted: true });
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: true, emitted: false });
      store.close();
      store._setBasePath(tmpDir);
      store.init();
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: true, emitted: false }, 'the episode survives a restart');
      assert.equal(notifications().length, 1);
      assert.match(notifications()[0].text, /every live session is idle \(2 lanes\)/);

      lanes = ['AVAILABLE', 'WORKING'];
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: false, emitted: false });
      notify._internal.now = () => new Date(T0 + 5 * MIN);
      lanes = ['AVAILABLE'];
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: true, emitted: true }, 'a new episode is a new event');
      assert.equal(notifications().length, 2);
    });

    it('is judged by the channel\'s own pump, and only while the channel is on', async () => {
      notify.setFleetSource(() => ['AVAILABLE']);
      // The notifier's own enabled check, unstubbed, so it reads the same
      // setting the pump does.
      notify._internal.enabled = saved.enabled;
      const config = store.config.load();
      config.operatorChannel = { enabled: false };
      store.config.save(config);
      await operatorChannel.pump();
      assert.equal(notifications().length, 0, 'a disabled channel records nothing');
      config.operatorChannel = { enabled: true };
      store.config.save(config);
      await operatorChannel.pump();
      assert.equal(notifications().filter((r) => r.notify_type === 'fleet-idle').length, 1);
    });

    it('opens an episode only once its notice is recorded, so a refused notice is retried', () => {
      notify.setFleetSource(() => ['AVAILABLE']);
      notify._internal.isSafe = () => false;
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: true, emitted: false });
      assert.equal(store.operatorChannel.getNotifyState(notify.FLEET_IDLE_EPISODE), null, 'no episode nobody was told about');
      notify._internal.isSafe = saved.isSafe;
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: true, emitted: true }, 'the next pass tries again');
    });

    it('tells the operator once when a crash lands between recording the notice and opening the episode', () => {
      notify.setFleetSource(() => ['AVAILABLE']);
      // Simulate the crash: the notice is recorded, the episode never opens.
      const realSet = store.operatorChannel.setNotifyState;
      store.operatorChannel.setNotifyState = (key, value, at) => {
        if (key === notify.FLEET_IDLE_EPISODE && value !== null) throw new Error('crashed before the episode opened');
        return realSet.call(store.operatorChannel, key, value, at);
      };
      try {
        notify.evaluateFleetIdle();
      } finally {
        store.operatorChannel.setNotifyState = realSet;
      }
      assert.equal(notifications().length, 1, 'the notice was recorded before the crash');
      assert.equal(store.operatorChannel.getNotifyState(notify.FLEET_IDLE_EPISODE), null);
      // The restart's next pass, later in time: same spell, same key.
      notify._internal.now = () => new Date(T0 + 3 * MIN);
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: true, emitted: false });
      assert.equal(notifications().length, 1, 'no second notice for the same spell');
      assert.ok(store.operatorChannel.getNotifyState(notify.FLEET_IDLE_EPISODE), 'the episode is open now');
      assert.equal(store.operatorChannel.getNotifyState(notify.FLEET_IDLE_PENDING), null);
    });

    it('closes an episode while the channel is off, so the next idle spell is not hidden', () => {
      let lanes = ['AVAILABLE'];
      notify.setFleetSource(() => lanes);
      assert.equal(notify.evaluateFleetIdle().emitted, true);
      enabled = false;
      lanes = ['WORKING'];
      notify.evaluateFleetIdle();
      assert.equal(store.operatorChannel.getNotifyState(notify.FLEET_IDLE_EPISODE), null, 'closed although the channel is off');
      // A new spell starts later than the last one did: the clock moves on.
      notify._internal.now = () => new Date(T0 + 2 * MIN);
      lanes = ['AVAILABLE'];
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: true, emitted: false }, 'nothing is recorded while off');
      enabled = true;
      notify._internal.now = () => new Date(T0 + 7 * MIN);
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: true, emitted: true }, 'the fleet is idle now, and the operator hears it');
    });

    it('survives a fleet source that throws', () => {
      notify.setFleetSource(() => { throw new Error('observer gone'); });
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: false, emitted: false });
    });

    it('does not call an empty fleet idle, nor judge one with no source', () => {
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: false, emitted: false }, 'no source');
      notify.setFleetSource(() => []);
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: false, emitted: false }, 'no live lane');
      notify.setFleetSource(() => ['UNKNOWN']);
      assert.deepEqual(notify.evaluateFleetIdle(), { idle: false, emitted: false }, 'UNKNOWN is not idle');
      assert.equal(notifications().length, 0);
    });
  });

  describe('operator-needed, from the watchdog\'s ladder', () => {
    const wdSaved = {};

    beforeEach(() => {
      Object.assign(wdSaved, watchdog._internal);
      watchdog._internal.loadConfig = () => ({});
      watchdog._internal.sendSystemMessage = async () => ({ status: 'received' });
      watchdog._internal.workspaceForProject = () => null;
      watchdog._internal.isLocalWorkspace = () => false;
      watchdog._internal.logActivity = () => {};
      mx._internal.now = () => new Date(T0);
    });

    afterEach(() => {
      Object.assign(watchdog._internal, wdSaved);
      mx._internal.now = () => new Date();
    });

    it('emits once when an exchange reaches the operator rung, however many ticks follow', async () => {
      const pm = mkProject('pm');
      const builder = mkProject('builder');
      const x = mx.createSendIntent({
        meta: mx.validateSendMeta({ priority: 'blocking' }, { kind: 'project', projectId: pm.id }, pm.id),
        sender: { projectId: pm.id, workspaceId: 'pm-ws' },
        recipient: { workspaceId: 'builder-ws', projectId: builder.id, sessionId: 2 }
      });
      mx.bindHubId(x.exchange_id, 'hub-1');
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      for (const at of [5, 15, 60, 61, 90]) await watchdog.tick(T0 + at * MIN).notices;
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'operator', 'precondition: the ladder reached the operator');
      const rows = notifications().filter((r) => r.notify_type === 'operator-needed');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].idem_key, `operator-needed:${x.exchange_id}`);
      assert.equal(rows[0].project_id, builder.id);
      assert.match(rows[0].text, /message to builder has gone unanswered/);
    });
  });
});

describe('work-blocked, from the workload route (#1799)', () => {
  let tmpDir;
  let server;
  const saved = {};

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-notify-wl-'));
    store._setBasePath(tmpDir);
    store.init();
    Object.assign(saved, notify._internal);
    notify._internal.enabled = () => true;
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    Object.assign(notify._internal, saved);
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the server\'s fleet source reads one composed availability per live session', () => {
    // The hop the server's startup wires into `setFleetSource`; that startup
    // block runs only as the main module, so its function is checked here.
    const { _fleetAvailabilities } = require('../server');
    const before = _fleetAvailabilities();
    assert.ok(Array.isArray(before));
    const dir = path.join(tmpDir, 'fleet-lane');
    fs.mkdirSync(dir);
    bindProject(store.projects.create({ name: 'fleet-lane', path: dir, engine: 'claude' }));
    const after = _fleetAvailabilities();
    assert.equal(after.length, before.length + 1, 'a new live session is a new lane');
    assert.ok(after.every((a) => typeof a === 'string'), 'each lane reads as an availability');
  });

  it('emits when a lane enters blocked, not when it repeats it, and again after it leaves', async () => {
    const dir = path.join(tmpDir, 'lane');
    fs.mkdirSync(dir);
    const project = store.projects.create({ name: 'lane', path: dir, engine: 'claude' });
    const binding = bindProject(project);
    const setState = async (state, clearance, summary) => {
      const res = await send(server, 'POST', '/api/tc/workload',
        { schema: 'tc.workload/1', state, clearance, summary }, { ...binding.headers, ...TC });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      // One receipt per second per lane.
      await new Promise((r) => setTimeout(r, 1050));
    };
    await setState('blocked', 'unknown', 'needs a decision');
    await setState('blocked', 'unknown', 'still needs it');
    await setState('working', 'do-not-clear', 'unblocked');
    await setState('blocked', 'unknown', 'blocked again');
    const rows = notifications().filter((r) => r.notify_type === 'work-blocked');
    assert.equal(rows.length, 2, 'two entries into blocked, one repeat that is not an event');
    assert.ok(rows.every((r) => r.project_id === project.id));
  });
});
