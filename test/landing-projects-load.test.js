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
  let originalReadProjectFacts;

  // A fresh store PER TEST (#2948 Round 4), not once for the whole describe:
  // Round 3's global serial facts-refresh queue (MAX_CONCURRENT_FACTS_REFRESHES)
  // means every project any sibling test left registered now competes for the
  // SAME one admission slot, so a test asserting "my project's read starts
  // promptly" could be stuck behind however many sibling projects preceded it
  // in iteration order — exactly what broke two of these tests on a slower CI
  // runner even with a generous poll budget. A fresh store removes the
  // variable entirely rather than tuning tick counts against it.
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-projects-cache-'));
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);
    projects._resetFactsCache();
    originalReadProjectFacts = projects._internal.readProjectFacts;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
      // Filtered by name, not a raw count, defensively — this store is fresh
      // per test (#2948 Round 4), but the pattern costs nothing to keep.
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

describe('listProjects facts stale-while-revalidate + serial background refresh (#2948, isolated)', () => {
  // A fresh store PER TEST, not per describe or the shared one above: these
  // tests reason about an EXACT count of in-flight/queued background
  // refreshes among a KNOWN set of projects, which only holds if no SIBLING
  // test's own registered project is also competing for
  // MAX_CONCURRENT_FACTS_REFRESHES' one slot — `_resetFactsCache()` alone
  // clears the cache but not the store's registered projects, so a fresh
  // store per test is what actually isolates them from each other.
  let tmpDir;
  let originalReadProjectFacts;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-projects-swr-'));
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);
    projects._resetFactsCache();
    originalReadProjectFacts = projects._internal.readProjectFacts;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function afterEachRestore() {
    projects._internal.readProjectFacts = originalReadProjectFacts;
  }

  it('stale-while-revalidate: answers with the stale snapshot immediately, before a held background refresh completes (PRR-B R-Gate Round 1, #2948)', async () => {
    const result = projects.createProject({ name: 'swr-facts-project' });
    assert.ok(result.project);
    await projects.listProjects(); // warms the cache with the real facts

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const calls = [];
    projects._internal.readProjectFacts = async (p, opts) => {
      calls.push(p.name);
      if (p.name !== 'swr-facts-project') return originalReadProjectFacts(p, opts);
      await held;
      return originalReadProjectFacts(p, opts);
    };

    const realNow = Date.now;
    Date.now = () => realNow() + projects.FACTS_CACHE_TTL_MS + 1000;
    try {
      const started = Date.now();
      // Must resolve immediately — the stale snapshot — rather than hang on
      // the held background refresh it starts (a bare `await` on the stub
      // without this fix would never return, since `held` isn't released yet).
      await projects.listProjects();
      assert.ok(Date.now() - started < 50,
        'a stale entry must answer immediately, not wait on the background refresh');
      assert.equal(calls.filter((n) => n === 'swr-facts-project').length, 1,
        'the stale-serving call still STARTS exactly one background refresh');

      release();
      // Poll until the background refresh's own chain (held -> readProjectFacts
      // -> cache write -> inflight cleanup) has actually landed: once it has,
      // a further call reads the now-fresh cache rather than starting another
      // refresh, so the call count stops climbing. Each iteration's own call
      // may itself join the still-in-flight single-flighted refresh (another
      // harmless, uncounted join) rather than start a second one, so a flat
      // count across two consecutive polls is the real signal, not a fixed
      // tick budget.
      let countAfter;
      for (let tick = 0; tick < 200; tick += 1) {
        await new Promise((r) => setImmediate(r));
        await projects.listProjects();
        const countNow = calls.filter((n) => n === 'swr-facts-project').length;
        if (countNow === countAfter) break;
        countAfter = countNow;
      }
      assert.equal(countAfter, 1,
        'once the background refresh lands, further calls read the now-fresh cache rather than starting another');
    } finally {
      Date.now = realNow;
      afterEachRestore();
    }
  });

  it('stale-while-revalidate: a rejecting background refresh neither breaks the stale response nor wedges the cache (#2948)', async () => {
    const result = projects.createProject({ name: 'swr-facts-error-project' });
    assert.ok(result.project);
    await projects.listProjects(); // warms the cache

    let shouldFail = true;
    let attempts = 0;
    projects._internal.readProjectFacts = async (p, opts) => {
      if (p.name !== 'swr-facts-error-project') return originalReadProjectFacts(p, opts);
      attempts += 1;
      if (shouldFail) throw new Error('simulated refresh failure');
      return originalReadProjectFacts(p, opts);
    };

    const realNow = Date.now;
    Date.now = () => realNow() + projects.FACTS_CACHE_TTL_MS + 1000;
    try {
      // The failing background refresh must not reject/throw into this call.
      const facts = await projects.listProjects();
      assert.ok(facts.find((f) => f.name === 'swr-facts-error-project'),
        'the stale snapshot still answers even though its background refresh is about to fail');

      for (let tick = 0; tick < 200 && attempts < 1; tick += 1) {
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(attempts, 1, 'the failing refresh must actually have run once');

      // The cache entry is unchanged (still stale, same age) — the next call
      // retries the refresh rather than being stuck forever.
      shouldFail = false;
      await projects.listProjects();
      for (let tick = 0; tick < 200 && attempts < 2; tick += 1) {
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(attempts, 2, 'the next call retries the refresh');

      // `attempts` only proves the stub was INVOKED a second time, not that
      // its promise chain (cache write, inflight/queue release) fully
      // settled — a sibling test later in this file that checks an exact
      // in-flight count would otherwise race a straggling .finally() from
      // here. Poll until `attempts` stays flat across several consecutive
      // calls: a THIRD attempt firing means the second one's cache write
      // had not landed yet, so a call still saw stale state.
      let stableRounds = 0;
      for (let tick = 0; tick < 200 && stableRounds < 10; tick += 1) {
        await new Promise((r) => setImmediate(r));
        await projects.listProjects();
        stableRounds = attempts === 2 ? stableRounds + 1 : 0;
      }
      assert.equal(attempts, 2, 'the second refresh\'s own chain settled — further calls read the now-fresh cache');
    } finally {
      Date.now = realNow;
      afterEachRestore();
    }
  });

  it('serial background-refresh scheduling: many stale projects at once never exceed MAX_CONCURRENT_FACTS_REFRESHES in flight, in issue order, while every call still answers immediately (PRR-B R-Gate Round 2, #2948)', async () => {
    const names = [];
    for (let i = 0; i < 5; i += 1) {
      const name = `swr-many-stale-${i}`;
      const created = projects.createProject({ name });
      assert.ok(created.project);
      names.push(name);
    }
    await projects.listProjects(); // warms all five

    const releasers = new Map(); // name -> resolve
    const order = [];
    let active = 0;
    let maxActive = 0;
    projects._internal.readProjectFacts = async (p, opts) => {
      if (!names.includes(p.name)) return originalReadProjectFacts(p, opts);
      order.push(p.name);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => { releasers.set(p.name, resolve); });
      active -= 1;
      return originalReadProjectFacts(p, opts);
    };

    const realNow = Date.now;
    Date.now = () => realNow() + projects.FACTS_CACHE_TTL_MS + 1000;
    try {
      const started = Date.now();
      await projects.listProjects(); // all five are stale; each queues a refresh
      assert.ok(Date.now() - started < 50,
        'every stale project still answers immediately, even with many queued background refreshes');

      // Only the queue's own cap may actually be running the stub right now —
      // the rest are queued, not yet invoked at all.
      assert.equal(order.length, projects.MAX_CONCURRENT_FACTS_REFRESHES,
        `exactly ${projects.MAX_CONCURRENT_FACTS_REFRESHES} refresh(es) may have started; the rest must still be queued`);

      // Drain the queue one release at a time, confirming the cap holds
      // throughout and that issue order matches queue (FIFO) order.
      let guard = 0;
      while (order.length < names.length && guard < 1000) {
        guard += 1;
        if (releasers.size > 0) {
          const next = [...releasers.keys()][0];
          releasers.get(next)();
          releasers.delete(next);
        }
        await new Promise((r) => setImmediate(r));
      }
      assert.ok(guard < 1000, 'the queue must drain in a bounded number of ticks');
      // Release whatever is still held so nothing leaks past this test.
      for (const resolve of releasers.values()) resolve();
      await new Promise((r) => setImmediate(r));

      assert.equal(order.length, names.length, 'every stale project was eventually refreshed');
      assert.deepEqual(order, names, 'issued in FIFO order, matching the stale-serving loop\'s own iteration order');
      assert.ok(maxActive <= projects.MAX_CONCURRENT_FACTS_REFRESHES,
        `saw ${maxActive} concurrent background refreshes, cap is ${projects.MAX_CONCURRENT_FACTS_REFRESHES}`);
    } finally {
      Date.now = realNow;
      afterEachRestore();
    }
  });
});

describe('listAllProjects listUnregistered cache + single-flight (#2948, server side)', () => {
  const dirScanner = require('../lib/dir-scanner');
  let tmpDir;
  let realRequest;
  let seq = 0;

  // A fresh store PER TEST (#2948 Round 4), not once for the whole describe —
  // same reason as the facts-cache describe above: Round 3's global serial
  // facts-refresh queue means listAllProjects()'s own facts phase (every
  // registered project, including whatever sibling tests left behind) now
  // serializes before it ever reaches the unregistered-scan call under test,
  // which is exactly what broke 'coalesces concurrent listAllProjects()
  // calls' on CI even with no project of its own.
  beforeEach(() => {
    seq += 1;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-unreg-cache-'));
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);
    projects._resetFactsCache();
    realRequest = dirScanner.request;
  });

  afterEach(() => {
    dirScanner.request = realRequest;
    projects._resetFactsCache();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('stale-while-revalidate: answers with the stale scan immediately, before a held background refresh completes (PRR-B R-Gate Round 1, #2948)', async () => {
    const result = projects.createProject({ name: `unreg-swr-${seq}` });
    assert.ok(result.project);

    // ONE stub for the whole test — reassigning dirScanner.request again
    // partway through would itself force a hard (identity) miss, which is
    // not what this test is isolating; only the TTL governs staleness here.
    let mode = 'warm';
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const scanner = stubListUnregistered(() => (mode === 'held'
      ? held.then(() => ({ unregistered: [], truncated: false }))
      : Promise.resolve({ unregistered: [], truncated: false })));

    await projects.listAllProjects(); // warms the cache
    assert.equal(scanner.calls(), 1);

    mode = 'held';
    const realNow = Date.now;
    Date.now = () => realNow() + projects.UNREGISTERED_CACHE_TTL_MS + 1000;
    try {
      const started = Date.now();
      await projects.listAllProjects();
      assert.ok(Date.now() - started < 50,
        'a stale unregistered-scan entry must answer immediately, not wait on the background refresh');
      assert.equal(scanner.calls(), 2, 'the stale-serving call STARTS exactly one more background refresh');

      release();
      let countAfter;
      for (let tick = 0; tick < 200; tick += 1) {
        await new Promise((r) => setImmediate(r));
        await projects.listAllProjects();
        const countNow = scanner.calls();
        if (countNow === countAfter) break;
        countAfter = countNow;
      }
      assert.equal(countAfter, 2,
        'once the background refresh lands, further calls read the now-fresh cache rather than starting another');
    } finally {
      Date.now = realNow;
    }
  });

  it('stale-while-revalidate: a rejecting background scan neither breaks the stale response nor wedges the cache (#2948)', async () => {
    const result = projects.createProject({ name: `unreg-swr-error-${seq}` });
    assert.ok(result.project);

    let shouldFail = false;
    const scanner = stubListUnregistered(() => (shouldFail
      ? Promise.reject(new Error('simulated scan failure'))
      : Promise.resolve({ unregistered: [], truncated: false })));

    await projects.listAllProjects(); // warms the cache
    assert.equal(scanner.calls(), 1);

    shouldFail = true;
    const realNow = Date.now;
    Date.now = () => realNow() + projects.UNREGISTERED_CACHE_TTL_MS + 1000;
    try {
      const result2 = await projects.listAllProjects();
      assert.ok(Array.isArray(result2.projects),
        'the stale scan still answers even though its background refresh is about to fail');
      await new Promise((r) => setImmediate(r)); // let the rejection settle (no unhandledRejection)

      shouldFail = false;
      await projects.listAllProjects();
      assert.ok(scanner.calls() >= 3, 'the next call retries the refresh rather than being stuck forever');
    } finally {
      Date.now = realNow;
    }
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
