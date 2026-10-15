'use strict';

// #2403: at boot, the Master's bridge credential left by the previous server
// process is reconciled BEFORE any path can create a Master in this one. When
// the reconciliation ran after the auto-start, it revoked the auto-started
// Master's own credential while that credential was still being handed to the
// pane, and the Master ran with no bridge capability at all.
//
// These cases drive `master.bootMaster` itself, with the real store, the real
// credential FIFO and the real reader. Each test decides when the pane reads
// its FIFO, so a handoff that settles after boot has moved on is reproduced
// exactly rather than left to timing.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');
delete process.env.TANGLECLAW_PORT;

const store = require('../lib/store');
const handoff = require('../lib/bridge-handoff');
const principal = require('../lib/bridge-principal');
const bridgeStore = require('../lib/bridge-store');
const master = require('../lib/master');

const NO_FLEET = async () => ({ refreshed: false, count: 0 });
const availableEngines = {
  detectEngine: () => ({ available: true, path: '/usr/bin/true' }),
  resolveDefaultEngine: () => 'claude',
  reconcileLaunchMode: (_engine, mode) => mode
};
// Short enough that a FIFO nobody reads settles inside a test, long enough
// that a pane told to read straight after boot always gets there first.
const HANDOFF_TIMEOUT_MS = 3000;
const NEVER_READ_TIMEOUT_MS = 150;

let tmpDir;
let home;
// A launch settles its handoff in the background, which deliberately does not
// hold a process open. A test awaiting that outcome must, or it ends first.
let holdOpen = null;

/**
 * Fake tmux. Liveness is programmable and may change between calls; every
 * created session's credential FIFO is recorded so the test, not the clock,
 * decides when the pane reads it.
 * @param {object} [opts]
 * @param {boolean} [opts.alive=false] - Whether the Master reads as live.
 * @param {boolean} [opts.answered=true] - Whether tmux answers the probe.
 * @returns {object}
 */
function fakeTmux({ alive = false, answered = true } = {}) {
  const fake = {
    alive,
    answered,
    created: [],
    probeSession: () => (fake.answered
      ? { live: fake.alive, answered: true, cause: null }
      : { live: false, answered: false, cause: 'timeout' }),
    hasSession: () => fake.alive,
    createSession: () => {
      const known = new Set(fake.created);
      const fifo = fs.readdirSync(principal.handoffDir())
        .map((n) => path.join(principal.handoffDir(), n))
        .find((p) => !known.has(p));
      fake.created.push(fifo);
      return true;
    },
    killSession: () => true,
    readSessionEnv: () => ({ value: null, answered: true, cause: null })
  };
  return fake;
}

/**
 * Take the credential the way a pane does: run the reader its launch command names.
 * @param {string} fifoPath - FIFO path.
 * @returns {Promise<string>} What the reader printed.
 */
function paneReads(fifoPath) {
  const reader = path.join(__dirname, '..', 'bin', 'tc-bridge-receive');
  const child = spawn(process.execPath, [reader, fifoPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  return new Promise((resolve) => child.on('close', () => resolve(out)));
}

/**
 * Every credential row, oldest first, without its hash.
 * @returns {Array<{generation: number, status: string, reason: (string|null)}>}
 */
function rows() {
  return store.getDb().prepare(
    'SELECT generation, status, revoke_reason AS reason FROM bridge_master_credentials ORDER BY generation'
  ).all().map((r) => ({ ...r }));
}

/**
 * Leave a credential row the way a previous server process would have: minted
 * by that process, so nothing in this one is settling it.
 * @param {'pending'|'active'} status - The state the previous process left it in.
 * @returns {{generation: number, credential: string}}
 */
function leftByPreviousProcess(status) {
  const { credential, hash } = handoff.mintCredential();
  const generation = bridgeStore.masterCredentials.mint(hash);
  if (status === 'active') assert.ok(bridgeStore.masterCredentials.activate(generation, hash));
  return { generation, credential };
}

/**
 * The options every boot in these tests shares.
 * @param {object} tmuxLib - The fake tmux.
 * @param {boolean} autoStart - Whether the operator turned auto-start on.
 * @param {object} [extra] - More options.
 * @returns {object}
 */
function bootOptions(tmuxLib, autoStart, extra = {}) {
  return {
    config: { master: { autoStart } },
    home,
    tmuxLib,
    enginesLib: availableEngines,
    refreshFleet: NO_FLEET,
    bridgeHandoffTimeoutMs: HANDOFF_TIMEOUT_MS,
    ...extra
  };
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-boot-order-'));
  store._setBasePath(tmpDir);
  store.init();
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Master boot order (#2403)', () => {
  beforeEach(async () => {
    await principal.settled();
    store.getDb().prepare('DELETE FROM bridge_master_credentials').run();
    fs.rmSync(principal.handoffDir(), { recursive: true, force: true });
    home = path.join(tmpDir, `master-home-${Math.random().toString(36).slice(2)}`);
    holdOpen = setInterval(() => {}, 1000);
  });

  afterEach(async () => {
    await principal.settled();
    clearInterval(holdOpen);
  });

  it('an auto-started Master keeps the credential it is handed after boot has moved on', async () => {
    const t = fakeTmux();
    const boot = master.bootMaster(bootOptions(t, true));
    assert.equal(boot.autoStart.attempted, true);
    assert.equal(boot.autoStart.created, true);
    assert.equal(t.created.length, 1);
    assert.deepEqual(rows().map((r) => r.status), ['pending'], 'boot returns with the handoff still in flight');

    // The pane's shell starts only now, after boot returned: the real timing.
    t.alive = true;
    const credential = await paneReads(t.created[0]);
    const settled = await principal.settled();

    assert.equal(settled.delivered, true);
    assert.ok(principal.verify(credential), 'the Master holds a credential the bridge accepts');
    assert.deepEqual(rows(), [{ generation: settled.generation, status: 'active', reason: null }]);
  });

  it('the order this replaces loses that same credential', async () => {
    // A negative control, kept runnable so the case above provably exercises
    // the race: auto-start first, reconciliation after, as boot used to run.
    const t = fakeTmux();
    const ensured = master.ensureMasterSession(bootOptions(t, true));
    assert.equal(ensured.created, true);
    master.reconcileBridgeCredential({ tmuxLib: t });
    t.alive = true;
    const credential = await paneReads(t.created[0]);
    const settled = await principal.settled();

    assert.equal(principal.verify(credential), null);
    assert.equal(settled.code, 'superseded');
    assert.equal(bridgeStore.masterCredentials.live(), null);
    assert.deepEqual(rows().map((r) => r.reason), ['handoff-interrupted']);
  });

  it('revokes a handoff the previous process left pending, then launches with a new one', async () => {
    const prior = leftByPreviousProcess('pending');
    const t = fakeTmux();
    const boot = master.bootMaster(bootOptions(t, true));
    assert.equal(boot.reconciled.pendingRevoked, 1);

    t.alive = true;
    const credential = await paneReads(t.created[0]);
    await principal.settled();

    assert.equal(principal.verify(prior.credential), null);
    assert.ok(principal.verify(credential));
    assert.deepEqual(rows().map((r) => [r.status, r.reason]), [['revoked', 'handoff-interrupted'], ['active', null]]);
  });

  it('keeps the credential of a Master that survived the restart, and mints none', () => {
    const survivor = leftByPreviousProcess('active');
    const t = fakeTmux({ alive: true });
    const boot = master.bootMaster(bootOptions(t, true));

    assert.deepEqual(boot.reconciled, { pendingRevoked: 0, activeRevoked: 0, live: true });
    assert.equal(boot.autoStart.created, false);
    assert.equal(t.created.length, 0);
    assert.ok(principal.verify(survivor.credential));
    assert.deepEqual(rows(), [{ generation: survivor.generation, status: 'active', reason: null }]);
  });

  it('keeps the survivor\'s credential when tmux does not answer, and starts nothing', () => {
    const survivor = leftByPreviousProcess('active');
    const t = fakeTmux({ answered: false });
    const boot = master.bootMaster(bootOptions(t, true));

    assert.equal(boot.reconciled.live, null);
    assert.equal(boot.autoStart.created, false);
    assert.match(boot.autoStart.error, /tmux did not answer/);
    assert.equal(t.created.length, 0);
    assert.ok(principal.verify(survivor.credential));
  });

  it('revokes the credential of a Master that did not survive, and auto-start replaces it', async () => {
    const gone = leftByPreviousProcess('active');
    const t = fakeTmux({ alive: false });
    const boot = master.bootMaster(bootOptions(t, true));
    assert.equal(boot.reconciled.activeRevoked, 1);

    t.alive = true;
    const credential = await paneReads(t.created[0]);
    await principal.settled();

    assert.equal(principal.verify(gone.credential), null);
    assert.ok(principal.verify(credential));
    assert.deepEqual(rows().map((r) => [r.status, r.reason]), [['revoked', 'master-absent'], ['active', null]]);
  });

  it('reconciles with auto-start off, and launches nothing', () => {
    leftByPreviousProcess('pending');
    const gone = leftByPreviousProcess('active');
    const t = fakeTmux({ alive: false });
    const boot = master.bootMaster(bootOptions(t, false));

    assert.equal(boot.autoStart.attempted, false);
    assert.equal(t.created.length, 0);
    assert.equal(principal.verify(gone.credential), null);
    assert.equal(bridgeStore.masterCredentials.live(), null);
    // Minting the second row superseded the first, as a relaunch would.
    assert.deepEqual(rows().map((r) => r.reason), ['superseded', 'master-absent']);
  });

  it('reports a handoff the pane never took as its eventual outcome, not as boot\'s', async () => {
    const t = fakeTmux();
    const boot = master.bootMaster(bootOptions(t, true, { bridgeHandoffTimeoutMs: NEVER_READ_TIMEOUT_MS }));
    // Boot cannot know yet: the delivery is still being attempted.
    assert.equal(boot.autoStart.created, true);
    assert.equal(boot.autoStart.error, null);
    assert.deepEqual(rows().map((r) => r.status), ['pending']);

    const settled = await principal.settled();
    assert.deepEqual({ delivered: settled.delivered, code: settled.code }, { delivered: false, code: 'no-reader' });
    assert.equal(bridgeStore.masterCredentials.live(), null);
    assert.deepEqual(rows().map((r) => [r.status, r.reason]), [['revoked', 'handoff-failed']]);
  });

  it('a handoff a later launch superseded ends undelivered, leaving only the later one live', async () => {
    const t = fakeTmux();
    master.bootMaster(bootOptions(t, true));
    const first = principal.settled();

    // A second launch before the first pane read (the Master died and was
    // ensured again): it mints the next generation, superseding the first, and
    // clears the first launch's FIFO, so that handoff can no longer land.
    master.ensureMasterSession(bootOptions(t, true));
    assert.equal(t.created.length, 2);
    assert.ok(!fs.existsSync(t.created[0]));

    t.alive = true;
    const second = await paneReads(t.created[1]);
    const [firstSettled] = await Promise.all([first, principal.settled()]);

    assert.equal(firstSettled.delivered, false);
    assert.ok(principal.verify(second));
    assert.deepEqual(rows().map((r) => [r.status, r.reason]), [['revoked', 'superseded'], ['active', null]]);
  });

  it('a reconciliation that fails is reported, and auto-start still runs', async () => {
    const t = fakeTmux();
    const probe = t.probeSession;
    let calls = 0;
    t.probeSession = () => {
      calls += 1;
      if (calls === 1) throw new Error('probe exploded');
      return probe();
    };
    const boot = master.bootMaster(bootOptions(t, true));

    assert.match(boot.reconciled.error, /probe exploded/);
    assert.equal(boot.autoStart.created, true);
    t.alive = true;
    const credential = await paneReads(t.created[0]);
    await principal.settled();
    assert.ok(principal.verify(credential));
  });

  it('a Master launch that throws is logged, never fatal to boot', () => {
    const t = fakeTmux();
    const boot = master.bootMaster(bootOptions(t, true, { ensureMasterSession: () => { throw new Error('home unwritable'); } }));
    assert.equal(boot.autoStart.attempted, true);
    assert.equal(boot.autoStart.created, false);
    assert.match(boot.autoStart.error, /home unwritable/);
  });
});

// Run-time order is proven above, by driving `bootMaster`. These two checks
// are structural: they keep every Master creation path where those cases
// assume it is. Source positions are not proof of run-time order, and are not
// offered as such.
describe('where a Master can be created at boot (#2403)', () => {
  const repo = path.join(__dirname, '..');

  /**
   * Every file a server process loads code from.
   * @returns {string[]} Repo-relative paths.
   */
  function sourceFiles() {
    const list = (dir, ext) => fs.readdirSync(path.join(repo, dir))
      .filter((n) => !ext || n.endsWith(ext))
      .map((n) => path.join(dir, n))
      .filter((p) => fs.statSync(path.join(repo, p)).isFile());
    return ['server.js', ...list('lib', '.js'), ...list('scripts', '.js'), ...list('bin')];
  }

  /**
   * Count each file's calls of a function, comments excluded.
   * @param {RegExp} call - The call to count.
   * @returns {Object<string, number>} File → count, for files that have one.
   */
  function callers(call) {
    const out = {};
    for (const file of sourceFiles()) {
      const code = fs.readFileSync(path.join(repo, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      const n = (code.match(call) || []).length;
      if (n) out[file] = n;
    }
    return out;
  }

  it('names every caller that can create a Master or mint its credential', () => {
    // A new entry here is a new way to create a Master. Place it after
    // `bootMaster` has run (a request route or a pass started once the server
    // listens), then add it to this list.
    assert.deepEqual(callers(/\bensureMasterSession\(/g), {
      'lib/bridge-gateway.js': 1, // _summonMaster: the gateway's pass, started in onListening
      // Its definition. bootMaster's auto-start reaches it by name through a
      // test seam, so it is not a call here; a new direct call would be.
      'lib/master.js': 1,
      'server.js': 1 // POST /api/master/ensure: a request, so after listen
    });
    assert.deepEqual(callers(/\bbridgePrincipal\.begin\(/g), { 'lib/master.js': 1 });
  });

  it('server.js boots the Master before it listens, and reconciles nowhere else', () => {
    const src = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');
    const main = src.slice(src.indexOf('if (require.main === module) {'));
    const boot = main.indexOf('master.bootMaster(');
    const onListening = main.indexOf('const onListening = () => {');
    const listen = main.indexOf('server.listen(');

    assert.ok(boot > -1 && listen > -1 && onListening > -1);
    assert.ok(boot < onListening && boot < listen, 'bootMaster runs before the server can take a request');
    assert.equal(src.indexOf('reconcileBridgeCredential'), -1, 'the late reconciliation is gone');
    for (const pass of ['bridgeGateway.syncListener(', 'bridgeGateway.tick(']) {
      assert.ok(main.indexOf(pass) > onListening, `${pass} starts only once the server listens`);
    }
  });
});
