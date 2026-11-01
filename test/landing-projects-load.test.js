'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
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
    // Both fetches must have STARTED before either resolves — proves Promise.all,
    // not a sequential await where the second start would wait for the first.
    assert.deepEqual(order.sort(), ['start:/api/awareness', 'start:/api/projects?archived=true'].sort());
    projectsResolve({ projects: [], scan: null });
    awarenessResolve({ projects: [] });
    await pending;
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
