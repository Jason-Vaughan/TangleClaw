'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const store = require('../lib/store');
const projects = require('../lib/projects');
const { liftDeclaration } = require('./helpers/lift');

// #2771 — the dashboard's project-list poll was slow/unbounded because every
// poll re-ran the per-project scanner-child read, serially, for the whole
// fleet, and `/api/awareness` was awaited only after `/api/projects`
// resolved. Server side: `lib/projects.js#listProjects` now caches each
// project's facts for `FACTS_CACHE_TTL_MS`. Client side: `public/landing.js`
// `loadProjects` now fetches both endpoints in parallel and shows something
// when the fetch fails, rather than returning silently.

describe('listProjects facts cache (#2771, server side)', () => {
  let tmpDir;
  let projectsDir;
  let originalReadProjectFacts;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-projects-cache-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    projects._resetFactsCache();
    originalReadProjectFacts = projects._internal.readProjectFacts;
  });

  function afterEachRestore() {
    projects._internal.readProjectFacts = originalReadProjectFacts;
  }

  /** Count calls and delegate to the real implementation. */
  function countingFacts() {
    const calls = [];
    projects._internal.readProjectFacts = async (project, opts) => {
      calls.push(project.name);
      return originalReadProjectFacts(project, opts);
    };
    return calls;
  }

  it('serves cached facts on a second call within the TTL — no second scanner read', async () => {
    const result = projects.createProject({ name: 'cache-hit-project' });
    assert.ok(result.project);
    const calls = countingFacts();
    try {
      await projects.listProjects();
      assert.equal(calls.filter((n) => n === 'cache-hit-project').length, 1, 'first call reads fresh facts');
      await projects.listProjects();
      assert.equal(calls.filter((n) => n === 'cache-hit-project').length, 1,
        'second call within the TTL must not read the scanner again');
    } finally {
      afterEachRestore();
    }
  });

  it('reads fresh facts again once the cache entry is older than FACTS_CACHE_TTL_MS', async () => {
    const result = projects.createProject({ name: 'cache-expiry-project' });
    assert.ok(result.project);
    const calls = countingFacts();
    try {
      await projects.listProjects();
      // Filtered by name, not a raw count: earlier tests in this describe
      // block leave their own projects registered in the same store.
      assert.equal(calls.filter((n) => n === 'cache-expiry-project').length, 1);
      // Fast-forward past the TTL rather than waiting it out for real.
      const realNow = Date.now;
      Date.now = () => realNow() + projects.FACTS_CACHE_TTL_MS + 1000;
      try {
        await projects.listProjects();
      } finally {
        Date.now = realNow;
      }
      assert.equal(calls.filter((n) => n === 'cache-expiry-project').length, 2,
        'a stale cache entry must be refreshed, not served forever');
    } finally {
      afterEachRestore();
    }
  });

  it('a project with no cache entry yet still gets fresh facts even while a SIBLING project is warm', async () => {
    const a = projects.createProject({ name: 'already-cached-project' });
    assert.ok(a.project);
    await projects.listProjects(); // warms the cache for 'already-cached-project'

    const calls = countingFacts();
    try {
      const b = projects.createProject({ name: 'brand-new-project' });
      assert.ok(b.project);
      await projects.listProjects();
      assert.equal(calls.filter((n) => n === 'already-cached-project').length, 0,
        'the warm project must not be re-read');
      assert.equal(calls.filter((n) => n === 'brand-new-project').length, 1,
        'the new project has no cache entry and must be read');
    } finally {
      afterEachRestore();
    }
  });

  it('coalesces concurrent listProjects() calls into one in-flight read per project (#2948)', async () => {
    const result = projects.createProject({ name: 'concurrent-facts-project' });
    assert.ok(result.project);
    const calls = [];
    const releasers = [];
    projects._internal.readProjectFacts = async (p, opts) => {
      calls.push(p.name);
      if (p.name === 'concurrent-facts-project') {
        await new Promise((resolve) => { releasers.push(resolve); });
      }
      return originalReadProjectFacts(p, opts);
    };
    try {
      const p1 = projects.listProjects();
      const p2 = projects.listProjects();
      // Earlier tests in this describe left their own projects registered
      // (the file's own comment on this pattern applies here too), so this
      // project's turn in each call's sequential per-project loop may be
      // several real reads away — poll instead of assuming one tick reaches it.
      for (let tick = 0; tick < 100 && releasers.length === 0; tick += 1) {
        await new Promise((resolve) => { setImmediate(resolve); });
      }
      assert.equal(releasers.length, 1, 'only one read must actually be pending for the held project');
      assert.equal(calls.filter((n) => n === 'concurrent-facts-project').length, 1,
        'two concurrent listProjects() calls must share one in-flight read for the same project');
      releasers[0]();
      const [facts1, facts2] = await Promise.all([p1, p2]);
      assert.ok(Array.isArray(facts1) && Array.isArray(facts2));
    } finally {
      afterEachRestore();
    }
  });
});

describe('listAllProjects listUnregistered cache + single-flight (#2948, server side)', () => {
  const dirScanner = require('../lib/dir-scanner');
  let tmpDir;
  let projectsDir;
  let realRequest;
  let seq = 0;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-unreg-cache-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seq += 1;
    projects._resetFactsCache();
    realRequest = dirScanner.request;
  });

  afterEach(() => {
    dirScanner.request = realRequest;
    projects._resetFactsCache();
  });

  /**
   * Stub `dirScanner.request` so only the `listUnregistered` op is counted/faked;
   * any other op (`project-facts.js`'s own per-project POLLED read uses the same
   * function) passes through to the real implementation untouched.
   * @param {(payload: object) => {unregistered: object[], truncated: boolean}|Promise<object>} onListUnregistered
   * @returns {{calls: () => number}}
   */
  function stubListUnregistered(onListUnregistered) {
    let count = 0;
    dirScanner.request = (op, payload, opts) => {
      if (op !== 'listUnregistered') return realRequest(op, payload, opts);
      count += 1;
      return Promise.resolve(onListUnregistered(payload));
    };
    return { calls: () => count };
  }

  it('serves a cached scan on a second call within UNREGISTERED_CACHE_TTL_MS — no second scanner request', async () => {
    const result = projects.createProject({ name: `unreg-cache-${seq}` });
    assert.ok(result.project);
    const scanner = stubListUnregistered(() => ({ unregistered: [], truncated: false }));
    await projects.listAllProjects();
    assert.equal(scanner.calls(), 1, 'first call reads the scanner');
    await projects.listAllProjects();
    assert.equal(scanner.calls(), 1, 'second call within the TTL must not read the scanner again');
  });

  it('reads a fresh scan again once the cache entry is older than UNREGISTERED_CACHE_TTL_MS', async () => {
    const result = projects.createProject({ name: `unreg-expiry-${seq}` });
    assert.ok(result.project);
    const scanner = stubListUnregistered(() => ({ unregistered: [], truncated: false }));
    await projects.listAllProjects();
    assert.equal(scanner.calls(), 1);
    const realNow = Date.now;
    Date.now = () => realNow() + projects.UNREGISTERED_CACHE_TTL_MS + 1000;
    try {
      await projects.listAllProjects();
    } finally {
      Date.now = realNow;
    }
    assert.equal(scanner.calls(), 2, 'a stale unregistered-scan cache entry must be refreshed, not served forever');
  });

  it('invalidates automatically when a new project is registered, since the cache key includes the registered-name set', async () => {
    const a = projects.createProject({ name: `unreg-before-${seq}` });
    assert.ok(a.project);
    const seenSkipNames = [];
    const scanner = stubListUnregistered((payload) => {
      seenSkipNames.push([...payload.skipNames].sort());
      return { unregistered: [], truncated: false };
    });
    await projects.listAllProjects();
    assert.equal(scanner.calls(), 1);

    const b = projects.createProject({ name: `unreg-after-${seq}` });
    assert.ok(b.project);
    await projects.listAllProjects();
    assert.equal(scanner.calls(), 2, 'a newly-registered project must trigger a fresh scan, not reuse the pre-create cache entry');
    assert.ok(seenSkipNames[1].includes(`unreg-after-${seq}`),
      'the fresh scan must skip the newly-registered name so it is not reported as unregistered');
  });

  it('_resetFactsCache also clears the unregistered-scan cache', async () => {
    const result = projects.createProject({ name: `unreg-reset-${seq}` });
    assert.ok(result.project);
    const scanner = stubListUnregistered(() => ({ unregistered: [], truncated: false }));
    await projects.listAllProjects();
    assert.equal(scanner.calls(), 1);
    projects._resetFactsCache();
    await projects.listAllProjects();
    assert.equal(scanner.calls(), 2, '_resetFactsCache must force a fresh scan, not leave the old one cached');
  });

  it('bypasses a stale cache entry when dirScanner.request is reassigned to a different function, even within the TTL', async () => {
    const result = projects.createProject({ name: `unreg-stub-swap-${seq}` });
    assert.ok(result.project);
    const first = stubListUnregistered(() => ({ unregistered: [], truncated: false }));
    await projects.listAllProjects();
    assert.equal(first.calls(), 1);

    // A DIFFERENT stub, same op, same key: Architect Ruling A506-W3C-SCOPE-R2's
    // identity-keying must treat this as a miss regardless of the TTL, which is
    // exactly what every dirScanner-stubbing test elsewhere in this repo relies on.
    const second = stubListUnregistered(() => ({ unregistered: [], truncated: false }));
    await projects.listAllProjects();
    assert.equal(second.calls(), 1, 'a new dirScanner.request reference must not be served the prior reference\'s cached result');
  });

  it('coalesces concurrent listAllProjects() calls into one in-flight scanner request', async () => {
    // Deliberately no registered project here: this isolates the coalescing
    // under test (the `listUnregistered` scanner request) from a concurrent
    // enrichProject() pass over any registered project, which is a separate
    // concern this test is not about.
    let release;
    const scanner = stubListUnregistered(() => new Promise((resolve) => { release = resolve; })
      .then(() => ({ unregistered: [], truncated: false })));
    const p1 = projects.listAllProjects();
    const p2 = projects.listAllProjects();
    for (let tick = 0; tick < 100 && !release; tick += 1) {
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    assert.equal(scanner.calls(), 1, 'two concurrent calls must share one in-flight scanner request');
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(Array.isArray(r1.projects) && Array.isArray(r2.projects));
  });
});

const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

/**
 * Lift `loadProjects` in isolation and drive it against stubbed globals.
 * @param {(url: string) => Promise<object|null>} apiImpl
 * @returns {{run: () => Promise<void>, state: object, calls: object}}
 */
function liftLoadProjects(apiImpl) {
  const state = { orphanHooksRepairInFlight: false };
  const calls = {
    collectTags: 0, collectEngines: 0, renderProjects: 0, renderSessionCount: 0,
    updateUnregisteredToggle: 0, sendBootBeacon: 0, loadOrphanHooksInventory: 0,
    showToast: [], hideToast: 0
  };
  const ctx = vm.createContext({
    state,
    api: apiImpl,
    collectTags: () => { calls.collectTags += 1; },
    collectEngines: () => { calls.collectEngines += 1; },
    renderProjects: () => { calls.renderProjects += 1; },
    renderSessionCount: () => { calls.renderSessionCount += 1; },
    updateUnregisteredToggle: () => { calls.updateUnregisteredToggle += 1; },
    sendBootBeacon: () => { calls.sendBootBeacon += 1; },
    showToast: (text, kind) => { calls.showToast.push({ text, kind }); },
    hideToast: () => { calls.hideToast += 1; },
    loadOrphanHooksInventory: () => { calls.loadOrphanHooksInventory += 1; return Promise.resolve(); },
    document: { getElementById: () => null }
  });
  vm.runInContext(
    `${liftDeclaration(LANDING_SRC, 'async function loadProjects(')}\n`
    + 'this.__run = loadProjects;',
    ctx
  );
  return { run: () => vm.runInContext('__run()', ctx), state, calls };
}

describe('loadProjects (#2771, client side)', () => {
  it('fetches /api/projects and /api/awareness in PARALLEL, not sequentially', async () => {
    const order = [];
    let projectsResolve;
    let awarenessResolve;
    const { run } = liftLoadProjects((url) => {
      order.push(`start:${url}`);
      if (url.startsWith('/api/projects')) {
        return new Promise((resolve) => { projectsResolve = resolve; });
      }
      return new Promise((resolve) => { awarenessResolve = resolve; });
    });
    const pending = run();
    // Both fetches must have STARTED before either resolves — a sequential
    // await would not start the second until the first settled.
    assert.deepEqual(order.sort(), ['start:/api/awareness', 'start:/api/projects?archived=true'].sort());
    projectsResolve({ projects: [], scan: null });
    awarenessResolve({ projects: [] });
    await pending;
  });

  it('renders the project list as soon as it resolves, WITHOUT waiting for a stalled /api/awareness (PRR-A, PR #2782 round 1)', async () => {
    // The exact regression a bare Promise.all reintroduced: awaiting both
    // together means a slow/hung awareness call keeps the list from
    // appearing even though projects already answered — the "never loads"
    // complaint #2771 itself is about, just relocated.
    let awarenessResolve;
    const { run, state, calls } = liftLoadProjects((url) => {
      if (url.startsWith('/api/projects')) {
        return Promise.resolve({ projects: [{ name: 'a' }], scan: null });
      }
      return new Promise((resolve) => { awarenessResolve = resolve; }); // never resolves during this test
    });
    await run();
    assert.deepEqual(state.projects.map((p) => p.name), ['a'], 'the list rendered without awareness ever answering');
    assert.equal(calls.renderProjects, 1);
    assert.equal(awarenessResolve !== undefined, true, 'sanity: the awareness fetch really is still pending');
  });

  it('re-renders once a LATE awareness answer finally arrives, to pick up its badges', async () => {
    let awarenessResolve;
    const { run, state, calls } = liftLoadProjects((url) => {
      if (url.startsWith('/api/projects')) {
        return Promise.resolve({ projects: [{ name: 'a' }], scan: null });
      }
      return new Promise((resolve) => { awarenessResolve = resolve; });
    });
    await run();
    assert.equal(calls.renderProjects, 1, 'one render already happened without awareness');
    awarenessResolve({ projects: [{ projectId: 'p1', aware: true }] });
    await new Promise((r) => setImmediate(r)); // let the pending .then() settle
    assert.deepEqual(JSON.parse(JSON.stringify(state.awareness)), { p1: { projectId: 'p1', aware: true } });
    assert.equal(calls.renderProjects, 2, 'a second render reflects the late answer');
  });

  it('does not re-render when awareness resolves BEFORE the first render — nothing to patch yet', async () => {
    const { run, calls } = liftLoadProjects((url) => {
      if (url.startsWith('/api/projects')) {
        // Projects resolves LAST this time, after awareness already settled.
        return new Promise((resolve) => setTimeout(() => resolve({ projects: [], scan: null }), 5));
      }
      return Promise.resolve({ projects: [{ projectId: 'p1', aware: true }] });
    });
    await run();
    assert.equal(calls.renderProjects, 1, 'exactly one render — awareness landing early does not add a second');
  });

  it('a stale, out-of-order awareness answer from an OLDER poll does not clobber a NEWER one (PRR-A, PR #2782 round 2)', async () => {
    let awarenessCallNum = 0;
    let staleAwarenessResolve;
    const { run, state } = liftLoadProjects((url) => {
      if (url.startsWith('/api/projects')) return Promise.resolve({ projects: [], scan: null });
      awarenessCallNum += 1;
      if (awarenessCallNum === 1) {
        // Poll 1's awareness fetch stalls indefinitely, until released below.
        return new Promise((resolve) => { staleAwarenessResolve = resolve; });
      }
      // Poll 2's awareness fetch answers immediately, with NEWER data.
      return Promise.resolve({ projects: [{ projectId: 'p1', aware: 'new' }] });
    });

    const firstPoll = run(); // poll 1 starts; its awareness fetch is now pending
    await run(); // poll 2 runs to completion, including its own awareness update
    assert.deepEqual(JSON.parse(JSON.stringify(state.awareness)), { p1: { projectId: 'p1', aware: 'new' } },
      'precondition: the newer poll already applied its answer');

    // NOW poll 1's stale answer finally arrives.
    staleAwarenessResolve({ projects: [{ projectId: 'p1', aware: 'stale' }] });
    await new Promise((r) => setImmediate(r));
    await firstPoll;
    assert.deepEqual(JSON.parse(JSON.stringify(state.awareness)), { p1: { projectId: 'p1', aware: 'new' } },
      'a stale, out-of-order answer must not overwrite the newer one');
  });

  it('renders normally and clears a failing-streak toast once the fetch succeeds', async () => {
    const { run, state, calls } = liftLoadProjects((url) => {
      if (url.startsWith('/api/projects')) {
        return Promise.resolve({ projects: [{ name: 'z' }, { name: 'a' }], scan: { ok: true } });
      }
      return Promise.resolve({ projects: [{ projectId: 'p1', aware: true }] });
    });
    state._projectsLoadFailing = true; // simulate a prior failing streak
    await run();
    assert.deepEqual(state.projects.map((p) => p.name), ['a', 'z'], 'sorted case-insensitively');
    // `state.awareness` is built by `Object.fromEntries` INSIDE the lifted vm
    // script, so it is an object of the vm's own realm, not this file's — a
    // JSON round trip normalizes it to a plain object this file's assert can
    // compare structurally (same reasoning as the #1415 apiMutate-call capture
    // in test/caddy-drift.test.js).
    assert.deepEqual(JSON.parse(JSON.stringify(state.awareness)), { p1: { projectId: 'p1', aware: true } });
    assert.equal(state.projectsScan.ok, true);
    assert.equal(state._projectsLoadFailing, false);
    assert.equal(calls.hideToast, 1, 'the recovery toast-clear fires exactly once');
    assert.equal(calls.renderProjects, 1);
    assert.equal(calls.loadOrphanHooksInventory, 1);
  });

  it('shows a toast on a failed fetch instead of returning silently with no sign of it', async () => {
    const { run, state, calls } = liftLoadProjects(() => Promise.resolve(null));
    await run();
    assert.equal(calls.showToast.length, 1);
    assert.equal(calls.showToast[0].kind, 'warn');
    assert.equal(state._projectsLoadFailing, true);
    assert.equal(calls.renderProjects, 0, 'nothing downstream runs on a failed fetch');
  });

  it('does not re-toast every poll during a SUSTAINED failure — only on the transition into it', async () => {
    const { run, calls } = liftLoadProjects(() => Promise.resolve(null));
    await run();
    await run();
    await run();
    assert.equal(calls.showToast.length, 1, 'one toast for the whole failing streak, not one per poll');
  });
});
