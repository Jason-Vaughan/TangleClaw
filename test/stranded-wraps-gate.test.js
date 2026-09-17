'use strict';

/*
 * The stranded-wrap gates (#1539, #1540): a launch is refused while a stranded
 * wrap blocks, unless the same request acknowledges every blocking item, and a
 * new wrap is refused unless the request says to proceed past each one.
 *
 * "Blocking" is `isBlocking`: unacknowledged and fully recorded. Grandfathered
 * items are shown elsewhere but never stop anything. Every case runs on a temp
 * store, and launches run with tmux and engine detection stubbed.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const stranded = require('../lib/stranded-wraps');

const REMOTE = 'https://github.com/example/sandbox.git';
const OTHER_REMOTE = 'https://github.com/example/fork.git';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * Write a legacy `wrap.auto_pr` stranded row, which lists as grandfathered.
 * @param {number} projectId
 * @param {string} branch
 */
function legacyStranded(projectId, branch) {
  store.activity.log({
    projectId,
    eventType: 'wrap.auto_pr',
    detail: { branch, pushed: true, prUrl: null, autoMergeArmed: false, stranded: true, skippedReason: null, error: null }
  });
}

/**
 * The acknowledgement key a client sends back for a listed item.
 * @param {object} item
 * @returns {{remote: string|null, branch: string, headSha: string|null}}
 */
function keyOf(item) {
  return { remote: item.remote, branch: item.branch, headSha: item.headSha };
}

describe('stranded-wrap gate helpers (#1539, #1540)', () => {
  let storeDir;
  let prevBase;
  let project;
  let seq = 0;

  before(() => {
    prevBase = store._getBasePath();
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stranded-gate-'));
    store.close();
    store._setBasePath(storeDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seq += 1;
    const dir = fs.mkdtempSync(path.join(storeDir, 'proj-'));
    project = store.projects.create({ name: `gate-${seq}`, path: dir, engine: 'claude' });
  });

  describe('gateAppliesTo()', () => {
    it('exempts the Master session', () => {
      assert.equal(stranded.gateAppliesTo({ role: 'master' }), false);
    });
    it('gates a project session, which has no role today', () => {
      assert.equal(stranded.gateAppliesTo({}), true);
      assert.equal(stranded.gateAppliesTo(), true);
    });
    it('gates any other role unless the policy names it, so a new role is gated by default', () => {
      assert.equal(stranded.gateAppliesTo({ role: 'reviewer' }), true);
    });
  });

  describe('blockingItems()', () => {
    it('returns only unacknowledged, fully recorded items', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-open', headSha: SHA_A });
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/2-acked', headSha: SHA_B });
      legacyStranded(project.id, 'wrap/0-old');
      stranded.acknowledge(project, { branch: 'wrap/2-acked', headSha: SHA_B }, 'op');
      const items = stranded.blockingItems(project);
      assert.deepEqual(items.map((i) => i.branch), ['wrap/1-open']);
    });
  });

  describe('uncovered()', () => {
    const item = { remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A };
    it('treats an item as covered only by an exact (remote, branch, headSha) key', () => {
      assert.deepEqual(stranded.uncovered([item], [{ remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A }]), []);
    });
    it('does not cover a same-named branch on another remote', () => {
      assert.equal(stranded.uncovered([item], [{ remote: OTHER_REMOTE, branch: 'wrap/1-x', headSha: SHA_A }]).length, 1);
    });
    it('does not cover the same branch at another head', () => {
      assert.equal(stranded.uncovered([item], [{ remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_B }]).length, 1);
    });
    it('compares remotes with credentials removed, as the list stores them', () => {
      const withCreds = 'https://x-access-token:ghp_secret@github.com/example/sandbox.git';
      assert.deepEqual(stranded.uncovered([item], [{ remote: withCreds, branch: 'wrap/1-x', headSha: SHA_A }]), []);
    });
    it('ignores keys that are not objects', () => {
      assert.equal(stranded.uncovered([item], [null, 'wrap/1-x', 7]).length, 1);
    });
  });

  describe('launchGate()', () => {
    it('lets a project with nothing recorded launch', () => {
      assert.deepEqual(stranded.launchGate(project, {}), { ok: true, acknowledged: 0 });
    });

    it('lets a project whose only stranded items are grandfathered launch', () => {
      legacyStranded(project.id, 'wrap/0-old');
      assert.equal(stranded.launchGate(project, {}).ok, true);
    });

    it('refuses with STRANDED_WRAPS and the blocking items', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      legacyStranded(project.id, 'wrap/0-old');
      const gate = stranded.launchGate(project, {});
      assert.equal(gate.ok, false);
      assert.equal(gate.code, 'STRANDED_WRAPS');
      assert.deepEqual(gate.items.map((i) => i.branch), ['wrap/1-x'], 'grandfathered items are not listed as blockers');
      assert.match(gate.error, /wrap\/1-x|stranded/i);
      assert.doesNotMatch(gate.error, /acknowledgeStranded|headSha/, 'the sentence is shown to the operator as it is');
    });

    it('acknowledges every listed key, as the signed-in user, and then lets the launch through', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/2-y', headSha: SHA_B });
      const keys = stranded.launchGate(project, {}).items.map(keyOf);
      const gate = stranded.launchGate(project, { acknowledge: keys, by: 'operator' });
      assert.deepEqual(gate, { ok: true, acknowledged: 2 });
      const acks = store.activity.query({ projectId: project.id, eventType: stranded.EVENT_ACK });
      assert.equal(acks.length, 2);
      assert.ok(acks.every((r) => r.detail.by === 'operator'));
    });

    it('still refuses when the keys cover only some items, listing what remains, and keeps the acknowledgements made', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/2-y', headSha: SHA_B });
      const gate = stranded.launchGate(project, {
        acknowledge: [{ remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A }], by: null
      });
      assert.equal(gate.code, 'STRANDED_WRAPS');
      assert.deepEqual(gate.items.map((i) => i.branch), ['wrap/2-y']);
      const acks = store.activity.query({ projectId: project.id, eventType: stranded.EVENT_ACK });
      assert.equal(acks.length, 1, 'the acknowledgement that was given is a real decision and stays');
      assert.equal(acks[0].detail.by, null, 'nobody signed in is recorded as unknown, not invented');
    });

    it('refuses an unknown key with NOT_FOUND and writes nothing', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const gate = stranded.launchGate(project, {
        acknowledge: [{ remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_B }], by: 'op'
      });
      assert.equal(gate.ok, false);
      assert.equal(gate.code, 'NOT_FOUND');
      assert.equal(store.activity.query({ projectId: project.id, eventType: stranded.EVENT_ACK }).length, 0);
    });

    it('refuses a malformed acknowledge list with BAD_REQUEST', () => {
      assert.equal(stranded.launchGate(project, { acknowledge: 'wrap/1-x' }).code, 'BAD_REQUEST');
      assert.equal(stranded.launchGate(project, { acknowledge: [null] }).code, 'BAD_REQUEST');
    });

    it('does not gate the Master', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      assert.equal(stranded.launchGate(project, { role: 'master' }).ok, true);
    });

    it('accepts the key of an item listed with no remote, as the pages send it', () => {
      stranded.record({ projectId: project.id, remote: null, branch: 'wrap/1-x', headSha: SHA_A });
      const keys = stranded.launchGate(project, {}).items.map(keyOf);
      assert.equal(keys[0].remote, null);
      assert.deepEqual(stranded.launchGate(project, { acknowledge: keys, by: 'op' }), { ok: true, acknowledged: 1 });
    });

    it('lets the launch through, and says why, when the records cannot be read to acknowledge them', () => {
      const realQuery = stranded._internal.query;
      stranded._internal.query = () => { throw new Error('database is locked'); };
      try {
        const gate = stranded.launchGate(project, { acknowledge: [{ remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A }] });
        assert.equal(gate.ok, true);
        assert.match(gate.unchecked, /database is locked/);
      } finally {
        stranded._internal.query = realQuery;
      }
    });

    it('lets the launch through, and says why, when the records cannot be read', () => {
      const realQuery = stranded._internal.query;
      stranded._internal.query = () => { throw new Error('database is locked'); };
      try {
        const gate = stranded.launchGate(project, {});
        assert.equal(gate.ok, true);
        assert.match(gate.unchecked, /database is locked/);
      } finally {
        stranded._internal.query = realQuery;
      }
    });
  });

  describe('wrapGate()', () => {
    it('lets a wrap start when nothing blocks', () => {
      legacyStranded(project.id, 'wrap/0-old');
      assert.equal(stranded.wrapGate(project, undefined).ok, true);
    });

    it('refuses with STRANDED_WRAPS and every blocking item', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const gate = stranded.wrapGate(project, undefined);
      assert.equal(gate.code, 'STRANDED_WRAPS');
      assert.deepEqual(gate.items.map((i) => i.branch), ['wrap/1-x']);
      assert.match(gate.error, /it stays unacknowledged/);
      assert.doesNotMatch(gate.error, /proceedPastStranded|headSha/, 'the sentence is shown to the operator as it is');
    });

    it('lets the wrap start past the listed items without acknowledging them', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const keys = stranded.wrapGate(project, undefined).items.map(keyOf);
      const gate = stranded.wrapGate(project, keys);
      assert.deepEqual(gate, { ok: true, proceededPast: 1 });
      assert.equal(store.activity.query({ projectId: project.id, eventType: stranded.EVENT_ACK }).length, 0,
        'wrapping anyway is not an acknowledgement');
      assert.equal(stranded.blockingItems(project).length, 1, 'so the item still blocks the next launch');
    });

    it('lists every blocking item when one is not covered, so the client can resend them all', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const keys = stranded.wrapGate(project, undefined).items.map(keyOf);
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/2-y', headSha: SHA_B });
      const gate = stranded.wrapGate(project, keys);
      assert.equal(gate.code, 'STRANDED_WRAPS');
      assert.deepEqual(gate.items.map((i) => i.branch).sort(), ['wrap/1-x', 'wrap/2-y']);
    });

    it('does not let an override for an older head cover the branch stranded again', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const keys = stranded.wrapGate(project, undefined).items.map(keyOf);
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_B });
      assert.equal(stranded.wrapGate(project, keys).code, 'STRANDED_WRAPS');
    });

    it('refuses a proceed list that is not an array with BAD_REQUEST', () => {
      assert.equal(stranded.wrapGate(project, { branch: 'wrap/1-x' }).code, 'BAD_REQUEST');
    });

    it('does not gate the Master', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      assert.equal(stranded.wrapGate(project, undefined, { role: 'master' }).ok, true);
    });

    it('lets the wrap start, and says why, when the records cannot be read', () => {
      const realQuery = stranded._internal.query;
      stranded._internal.query = () => { throw new Error('disk I/O error'); };
      try {
        const gate = stranded.wrapGate(project, undefined);
        assert.equal(gate.ok, true);
        assert.match(gate.unchecked, /disk I\/O error/);
      } finally {
        stranded._internal.query = realQuery;
      }
    });
  });

  describe('counts()', () => {
    it('counts blocking, unacknowledged and grandfathered items', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/2-y', headSha: SHA_B });
      legacyStranded(project.id, 'wrap/0-old');
      stranded.acknowledge(project, { branch: 'wrap/2-y', headSha: SHA_B }, 'op');
      assert.deepEqual(stranded.counts(stranded.list(project).items),
        { total: 3, unacknowledged: 2, grandfathered: 1, blocking: 1 });
    });
  });
});

describe('launchSession honours the stranded-wrap gate (#1539)', () => {
  let tmpDir;
  let prevBase;
  let sessions;
  let tmux;
  let engines;
  const saved = {};
  const { installTmuxGuard, removeTmuxGuard, reapFixtureSessions } = require('./_tmux-guard');

  before(() => {
    installTmuxGuard();
    prevBase = store._getBasePath();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stranded-launch-'));
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    sessions = require('../lib/sessions');
    tmux = require('../lib/tmux');
    engines = require('../lib/engines');
    saved.createSession = tmux.createSession;
    saved.probeSession = tmux.probeSession;
    saved.sendKeys = tmux.sendKeys;
    saved.detectEngine = engines.detectEngine;
    tmux.createSession = () => true;
    tmux.probeSession = () => ({ live: false, answered: true, cause: null });
    tmux.sendKeys = () => true;
    engines.detectEngine = () => ({ available: true, path: '/usr/bin/engine' });
  });

  after(() => {
    tmux.createSession = saved.createSession;
    tmux.probeSession = saved.probeSession;
    tmux.sendKeys = saved.sendKeys;
    engines.detectEngine = saved.detectEngine;
    store.close();
    store._setBasePath(prevBase);
    removeTmuxGuard();
    const leaked = reapFixtureSessions(['slg-']);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.deepEqual(leaked, [], `leaked tmux sessions: ${leaked.join(', ')}`);
  });

  /**
   * A project in its own temp directory.
   * @param {string} name
   * @returns {object} The project row
   */
  function makeProject(name) {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    return store.projects.create({ name, path: dir, engine: 'claude' });
  }

  it('refuses before the launch writes anything to the project', () => {
    const project = makeProject('slg-refused');
    stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
    const result = sessions.launchSession('slg-refused');
    assert.equal(result.session, null);
    assert.equal(result.code, 'STRANDED_WRAPS');
    assert.deepEqual(result.items.map((i) => i.branch), ['wrap/1-x']);
    assert.deepEqual(fs.readdirSync(project.path), [],
      'no engine config, prime file or version record: a refused launch leaves the project untouched');
    assert.equal(store.sessions.getActive(project.id), null);
  });

  it('launches when the same request acknowledges every blocking item, recording the owner', () => {
    const project = makeProject('slg-acked');
    stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
    const refused = sessions.launchSession('slg-acked');
    const result = sessions.launchSession('slg-acked', {
      acknowledgeStranded: refused.items.map(keyOf), owner: 'operator'
    });
    assert.ok(result.session, `launch must succeed: ${result.error}`);
    const [ack] = store.activity.query({ projectId: project.id, eventType: stranded.EVENT_ACK });
    assert.equal(ack.detail.by, 'operator');
    store.sessions.kill(result.session.id, 'test cleanup');
  });

  it('launches a project whose only stranded items are grandfathered', () => {
    const project = makeProject('slg-legacy');
    legacyStranded(project.id, 'wrap/0-old');
    const result = sessions.launchSession('slg-legacy');
    assert.ok(result.session, `launch must succeed: ${result.error}`);
    store.sessions.kill(result.session.id, 'test cleanup');
  });

  it('says the stranded-wrap check ran, and says why when it was skipped', () => {
    makeProject('slg-checked');
    const checked = sessions.launchSession('slg-checked');
    assert.ok(checked.session, `launch must succeed: ${checked.error}`);
    assert.equal(checked.strandedUnchecked, null);
    store.sessions.kill(checked.session.id, 'test cleanup');

    makeProject('slg-unread');
    const realQuery = stranded._internal.query;
    stranded._internal.query = () => { throw new Error('database is locked'); };
    let skipped;
    try {
      skipped = sessions.launchSession('slg-unread');
    } finally {
      stranded._internal.query = realQuery;
    }
    assert.ok(skipped.session, `a skipped check lets the launch through: ${skipped.error}`);
    assert.match(skipped.strandedUnchecked, /database is locked/);
    store.sessions.kill(skipped.session.id, 'test cleanup');
  });

  it('hands the web-UI launch path the same skipped-check reason', () => {
    makeProject('slg-webui');
    const conn = store.openclawConnections.create({ name: 'slg-webui-conn', host: '10.0.0.9', sshUser: 'u', sshKeyPath: '~/.ssh/k', defaultMode: 'webui' });
    const realQuery = stranded._internal.query;
    stranded._internal.query = () => { throw new Error('database is locked'); };
    let result;
    try {
      result = sessions.launchSession('slg-webui', { engineOverride: `openclaw:${conn.id}`, mode: 'webui' });
    } finally {
      stranded._internal.query = realQuery;
    }
    assert.equal(result.webui, true, `the web-UI branch must be reached: ${result.error}`);
    assert.match(result.strandedUnchecked, /database is locked/);
    const checked = sessions.launchSession('slg-webui', { engineOverride: `openclaw:${conn.id}`, mode: 'webui' });
    assert.equal(checked.webui, true);
    assert.equal(checked.strandedUnchecked, null);
  });

  it('passes an acknowledgement failure through as its own code', () => {
    const project = makeProject('slg-badkey');
    stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
    const result = sessions.launchSession('slg-badkey', {
      acknowledgeStranded: [{ remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_B }]
    });
    assert.equal(result.session, null);
    assert.equal(result.code, 'NOT_FOUND');
  });

  it('reports "already active" ahead of stranded wraps, so Open on a running session is never blocked', () => {
    const project = makeProject('slg-active');
    const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'slg-active' });
    stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
    const realProbe = tmux.probeSession;
    tmux.probeSession = () => ({ live: true, answered: true, cause: null });
    try {
      const result = sessions.launchSession('slg-active');
      assert.match(result.error, /already active/);
      assert.notEqual(result.code, 'STRANDED_WRAPS');
    } finally {
      tmux.probeSession = realProbe;
      store.sessions.kill(session.id, 'test cleanup');
    }
  });
});

describe('startWrap honours the stranded-wrap soft block (#1540)', () => {
  let tmpDir;
  let prevBase;
  let sessions;
  let wrapPipeline;
  let wrapRunRegistry;
  let realRun;

  before(() => {
    prevBase = store._getBasePath();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stranded-wrap-'));
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    sessions = require('../lib/sessions');
    wrapPipeline = require('../lib/wrap-pipeline');
    wrapRunRegistry = require('../lib/wrap-run-registry');
    realRun = wrapPipeline.runWrapPipeline;
    wrapPipeline.runWrapPipeline = async () => (
      { ok: false, blockedAt: 'test', results: [], commitSha: null, summary: null, error: null }
    );
  });

  after(() => {
    wrapPipeline.runWrapPipeline = realRun;
    wrapRunRegistry._resetForTests();
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => wrapRunRegistry._resetForTests());

  /**
   * A project with an active session and one blocking stranded wrap.
   * @param {string} name
   * @returns {object} The project row
   */
  function strandedProject(name) {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `${name}-tmux` });
    stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
    return project;
  }

  it('refuses before a run is claimed', () => {
    strandedProject('swg-refused');
    const started = sessions.startWrap('swg-refused');
    assert.equal(started.ok, false);
    assert.equal(started.code, 'STRANDED_WRAPS');
    assert.deepEqual(started.items.map((i) => i.branch), ['wrap/1-x']);
    assert.equal(wrapRunRegistry.get('swg-refused').runId, null, 'a refused wrap claims nothing');
  });

  it('starts past the listed items, records the choice with the run, and acknowledges nothing', async () => {
    const project = strandedProject('swg-proceed');
    const keys = sessions.startWrap('swg-proceed').items.map(keyOf);
    const started = sessions.startWrap('swg-proceed', { proceedPastStranded: keys });
    assert.equal(started.ok, true);
    assert.deepEqual(wrapRunRegistry.get('swg-proceed').options, { proceedPastStranded: keys },
      'the run keeps the choice, so a Retry replays it');
    await started.done;
    assert.equal(store.activity.query({ projectId: project.id, eventType: stranded.EVENT_ACK }).length, 0);
  });

  it('reports a wrap already in progress rather than the soft block', async () => {
    strandedProject('swg-running');
    const keys = sessions.startWrap('swg-running').items.map(keyOf);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    wrapPipeline.runWrapPipeline = async () => {
      await gate;
      return { ok: false, blockedAt: 'test', results: [], commitSha: null, summary: null, error: null };
    };
    try {
      const first = sessions.startWrap('swg-running', { proceedPastStranded: keys });
      assert.equal(first.ok, true);
      const second = sessions.startWrap('swg-running');
      assert.equal(second.code, 'WRAP_IN_PROGRESS', 'the drawer follows a running run; it must not be shown a stranded prompt instead');
      release();
      await first.done;
    } finally {
      release();
      wrapPipeline.runWrapPipeline = async () => (
        { ok: false, blockedAt: 'test', results: [], commitSha: null, summary: null, error: null }
      );
    }
  });
});

describe('the project list carries stranded-wrap counts (#1541)', () => {
  let tmpDir;
  let prevBase;
  let projects;
  const noSessions = { get: async () => ({ answered: true, names: new Set(), cause: null }) };

  before(() => {
    prevBase = store._getBasePath();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stranded-list-'));
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    projects = require('../lib/projects');
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('counts blocking items separately from grandfathered ones', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    const project = store.projects.create({ name: 'slc-counts', path: dir, engine: 'claude' });
    stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
    legacyStranded(project.id, 'wrap/0-old');
    const enriched = await projects.enrichProject(project, {}, { tmuxSessionNames: noSessions });
    assert.deepEqual(enriched.stranded, {
      total: 2, unacknowledged: 2, grandfathered: 1, blocking: 1,
      github: { state: 'never', lastOkAt: null, lastAttemptAt: null, reason: null, redCi: 0, noPr: 0, unchecked: 0 }
    });
    assert.equal(enriched.strandedError, null);
  });

  it('carries the latest GitHub check as counts, with its times and reason (#1542, #1543)', async () => {
    const strandedCheck = require('../lib/stranded-check');
    const dir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    const project = store.projects.create({ name: 'slc-github', path: dir, engine: 'claude' });
    const at = '2026-09-16T10:00:00.000Z';
    const log = (detail) => store.activity.log({ projectId: project.id, eventType: 'wrap.strand_check', detail });
    log({
      remote: REMOTE, outcome: 'ok', ok: true, reason: null, at, durationMs: 5, checked: 0, cleared: 0,
      findings: [{ kind: 'red-ci', branch: 'wrap/2-y' }, { kind: 'no-pr', branch: 'wrap/3-z' }],
      findingsTotal: 25, redCiTotal: 1, noPrTotal: 24, unchecked: 3
    });
    log({ remote: REMOTE, outcome: 'failed', ok: false, reason: 'gh is not installed', at: '2026-09-16T11:00:00.000Z' });
    const enriched = await projects.enrichProject(project, {}, { tmuxSessionNames: noSessions });
    assert.deepEqual(enriched.stranded.github, {
      state: 'failed', lastOkAt: at, lastAttemptAt: '2026-09-16T11:00:00.000Z', reason: 'gh is not installed',
      redCi: 1, noPr: 24, unchecked: 3
    });
    assert.deepEqual(enriched.stranded.github, strandedCheck.summary(strandedCheck.status(project)));
  });

  it('reports a failed read as unknown with its reason, never as zero, and still lists the project', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    const project = store.projects.create({ name: 'slc-broken', path: dir, engine: 'claude' });
    const realQuery = stranded._internal.query;
    stranded._internal.query = () => { throw new Error('database is locked'); };
    try {
      const enriched = await projects.enrichProject(project, {}, { tmuxSessionNames: noSessions });
      assert.equal(enriched.name, 'slc-broken');
      assert.equal(enriched.stranded, null);
      assert.match(enriched.strandedError, /database is locked/);
    } finally {
      stranded._internal.query = realQuery;
    }
  });
});
