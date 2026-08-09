'use strict';

/*
 * #707 — the wired call sites for `engines.resolveDefaultEngine`.
 *
 * The resolver itself is unit-tested in test/engines.test.js. What went untested
 * was every place that CALLS it, which is where the bug actually lived: a
 * machine with Codex but no Claude got projects registered against `claude`
 * because the fallback literal was hardcoded at each site. A correct resolver
 * wired in at five sites and not at the sixth is still the original bug.
 *
 * These drive the real functions against a temp store with a stubbed engine
 * list, so "what is installed" is controlled rather than inherited from the
 * developer's machine — the tests must mean the same thing on a box with every
 * engine and on CI with none.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const engines = require('../lib/engines');

let projects;
let tmpDir;
let projectsDir;

/** Pretend only `ids` are installed, for every resolver call. */
function installOnly(ids) {
  engines._internal.listWithAvailability = () => [
    { id: 'claude', name: 'Claude Code', available: ids.includes('claude') },
    { id: 'codex', name: 'Codex', available: ids.includes('codex') },
    { id: 'aider', name: 'Aider', available: ids.includes('aider') }
  ];
}

describe('resolveDefaultEngine call-site wiring (#707)', () => {
  let originalList;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-defeng-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    config.defaultEngine = 'claude';
    store.config.save(config);
    projects = require('../lib/projects');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => { originalList = engines._internal.listWithAvailability; });
  afterEach(() => { engines._internal.listWithAvailability = originalList; });

  describe('createProject', () => {
    it('records an installed engine when the configured default is missing', () => {
      installOnly(['codex']);
      const { project, errors } = projects.createProject({ name: 'de-create-1' });
      assert.deepEqual(errors, []);
      assert.equal(project.engineId, 'codex', 'a project must not be bound to an uninstalled engine');
    });

    it('keeps the configured default when it IS installed', () => {
      installOnly(['claude', 'codex']);
      const { project, errors } = projects.createProject({ name: 'de-create-2' });
      assert.deepEqual(errors, []);
      assert.equal(project.engineId, 'claude');
    });

    it('honors an explicit engine over the resolver', () => {
      installOnly(['claude', 'codex']);
      const { project, errors } = projects.createProject({ name: 'de-create-3', engine: 'codex' });
      assert.deepEqual(errors, []);
      assert.equal(project.engineId, 'codex');
    });

    it('still registers the project when nothing is installed', () => {
      // Creating a project is bookkeeping — it does not run an engine, so it
      // must not require a binary to be present. The configured intent is
      // recorded and launch-time detection reports the truth.
      installOnly([]);
      const { project, errors } = projects.createProject({ name: 'de-create-4' });
      assert.deepEqual(errors, []);
      assert.equal(project.engineId, 'claude');
    });
  });

  describe('attachProject', () => {
    // NOTE: attachProject returns an ENRICHED project (engine is an object),
    // where createProject returns the raw store row (engineId is a string).
    // Asserting the wrong one silently reads `undefined`, which is why these
    // read `project.engine.id`.

    /** Make a directory the attach path will accept. */
    function mkdir(name, projectJson) {
      const p = path.join(projectsDir, name);
      fs.mkdirSync(p, { recursive: true });
      if (projectJson) {
        fs.mkdirSync(path.join(p, '.tangleclaw'), { recursive: true });
        fs.writeFileSync(path.join(p, '.tangleclaw', 'project.json'), JSON.stringify(projectJson));
      }
      return p;
    }

    it('attaches against an installed engine, not the uninstalled default', async () => {
      installOnly(['codex']);
      mkdir('de-attach-1');
      const { project, errors } = await projects.attachProject('de-attach-1');
      assert.deepEqual(errors, []);
      assert.equal(project.engine.id, 'codex');
    });

    it("an existing project.json engine wins over the resolver", async () => {
      installOnly(['codex']);
      mkdir('de-attach-2', { engine: 'aider' });
      const { project, errors } = await projects.attachProject('de-attach-2');
      assert.deepEqual(errors, []);
      assert.equal(project.engine.id, 'aider', 'the directory already declared its engine');
    });

    it('does not run engine detection at all when project.json answers', async () => {
      // Detection shells out per engine profile; resolving and then discarding
      // the result made every attach pay for it.
      let called = 0;
      engines._internal.listWithAvailability = () => { called++; return [{ id: 'codex', available: true }]; };
      mkdir('de-attach-3', { engine: 'aider' });
      const { project } = await projects.attachProject('de-attach-3');
      assert.equal(project.engine.id, 'aider');
      assert.equal(called, 0, 'detection must not run when the answer was already on disk');
    });
  });

  describe('syncAllProjects', () => {
    it('syncs git hooks for every project even when no engine resolves', () => {
      // Regression: `if (!engineId) continue` skipped the rest of the loop —
      // including the #247 git-hooks sync, whose own comment says it is
      // deliberately NOT gated on engine state — and skipped the synced counter.
      installOnly([]);
      const p = path.join(projectsDir, 'de-sync-1');
      fs.mkdirSync(p, { recursive: true });
      const baseline = projects.syncAllProjects().synced;
      const row = store.projects.create({ name: 'de-sync-1', path: p });
      // `create` coalesces a falsy engine to 'claude', so it cannot produce the
      // state this branch guards. `update` writes `engine_id` through without
      // coalescing, which is the path that actually reaches it — and is why the
      // fallback stays in the code rather than being deleted as unreachable.
      store.projects.update(row.id, { engine_id: '' });
      assert.equal(store.projects.get(row.id).engineId, '', 'fixture must really have no engine');

      // Compare against a baseline taken WITHOUT this project: other tests in
      // this file leave projects behind, so `synced >= 1` would hold whether or
      // not the engineless one was processed — the first version of this
      // assertion passed against the bug it was written to catch.
      const after = projects.syncAllProjects().synced;
      assert.equal(
        after, baseline + 1,
        'a project with no resolvable engine must still be counted and have its git hooks synced'
      );
    });
  });
});
