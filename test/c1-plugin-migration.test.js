'use strict';

const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const engines = require('../lib/engines');
const projects = require('../lib/projects');
const sessionOwnership = require('../lib/session-ownership');

// The reference TC actually writes. Not a local fixture: migrations are
// expected to write exactly this, so the tests assert against the constant the
// production code uses. The shape itself is pinned separately below.
const SELF_REF = engines.PRAWDUCT_INSTALL_REFERENCE;

describe('C1 — per-project plugin migration (#262)', () => {
  let tmpDir;
  let pluginsHomeInstalled; // installed_plugins.json names prawduct
  let pluginsHomeEmpty; // no install marker
  const origHome = engines._internal.pluginsHome;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-c1-'));
    store._setBasePath(tmpDir);
    store.init();

    pluginsHomeInstalled = path.join(tmpDir, 'plugins-installed');
    fs.mkdirSync(pluginsHomeInstalled, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsHomeInstalled, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'prawduct@prawduct': [{ scope: 'user' }] } }, null, 2)
    );
    pluginsHomeEmpty = path.join(tmpDir, 'plugins-empty');
    fs.mkdirSync(pluginsHomeEmpty, { recursive: true });

    // Default seam: the plugin is installed on this machine.
    engines._internal.pluginsHome = () => pluginsHomeInstalled;
  });

  after(() => {
    engines._internal.pluginsHome = origHome;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fresh project dir, optionally seeding .claude/settings.json. */
  function mkProjectDir(label, settings) {
    const p = fs.mkdtempSync(path.join(tmpDir, `${label}-`));
    if (settings) {
      fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(p, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
    }
    return p;
  }

  function readSettings(projectPath) {
    return JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf8'));
  }

  describe('store — migration_status round-trip', () => {
    it('a fresh project has migrationStatus null and it persists when set', () => {
      const p = mkProjectDir('store');
      const proj = store.projects.create({ name: 'c1-store-rt', path: p });
      assert.equal(proj.migrationStatus, null);

      store.projects.update(proj.id, { migration_status: 'migrated' });
      assert.equal(store.projects.get(proj.id).migrationStatus, 'migrated');
    });
  });

  describe('engines.PRAWDUCT_INSTALL_REFERENCE', () => {
    // The literal is duplicated here on purpose. This is the tripwire: prawduct
    // publishes INSTALL_REFERENCE in its plugin's lib/migrate_plugin.py, and if
    // either side moves, this test fails loudly instead of the divergence
    // reaching every project TangleClaw migrates. Upstream currently marks
    // autoUpdate provisional, so a future change here is legitimate — but it
    // must be a deliberate edit to this assertion, never a silent drift.
    it('matches prawduct’s published install reference verbatim', () => {
      assert.deepEqual(engines.PRAWDUCT_INSTALL_REFERENCE, {
        enabledPlugins: { 'prawduct@prawduct': true },
        extraKnownMarketplaces: {
          prawduct: {
            source: { source: 'github', repo: 'brookstalley/prawduct', ref: 'main' },
            autoUpdate: true
          }
        }
      });
    });

    it('pins ref to a branch, never a version tag', () => {
      // A version-pinned ref stranded 11 repos on a months-old release; the
      // whole point of `main` is that consumers track the current one.
      const { ref } = engines.PRAWDUCT_INSTALL_REFERENCE.extraKnownMarketplaces.prawduct.source;
      assert.equal(ref, 'main');
      assert.doesNotMatch(ref, /^v?\d+\.\d+\.\d+$/);
    });
  });

  describe('engines._isCompletePluginRef', () => {
    it('accepts a reference carrying both halves', () => {
      assert.equal(engines._isCompletePluginRef(engines.PRAWDUCT_INSTALL_REFERENCE), true);
    });

    it('rejects enabledPlugins with no marketplace to resolve it', () => {
      assert.equal(engines._isCompletePluginRef({ enabledPlugins: { 'prawduct@prawduct': true } }), false);
      assert.equal(
        engines._isCompletePluginRef({ enabledPlugins: { 'prawduct@prawduct': true }, extraKnownMarketplaces: {} }),
        false
      );
    });

    it('rejects a marketplace with no enabled plugin, and junk input', () => {
      assert.equal(
        engines._isCompletePluginRef({ extraKnownMarketplaces: { prawduct: { source: {} } } }),
        false
      );
      assert.equal(engines._isCompletePluginRef(null), false);
      assert.equal(engines._isCompletePluginRef({}), false);
      assert.equal(engines._isCompletePluginRef({ enabledPlugins: { 'other@x': true } }), false);
    });
  });

  describe('engines.pluginInstalledAtMachineScope', () => {
    it('is true when installed_plugins.json names a prawduct plugin', () => {
      assert.equal(engines.pluginInstalledAtMachineScope(), true);
    });

    it('is false (fails closed) when no install marker exists', () => {
      engines._internal.pluginsHome = () => pluginsHomeEmpty;
      assert.equal(engines.pluginInstalledAtMachineScope(), false);
      engines._internal.pluginsHome = () => pluginsHomeInstalled;
    });
  });

  describe('engines.migrateToPlugin', () => {
    it('writes the plugin ref into a fresh project and reads as governed', () => {
      const p = mkProjectDir('fresh');
      const r = engines.migrateToPlugin(p);
      assert.equal(r.written, true);
      assert.equal(r.alreadyGoverned, false);
      assert.equal(engines.isPluginGoverned(p), true);
      assert.deepEqual(readSettings(p).enabledPlugins, { 'prawduct@prawduct': true });
    });

    it('is non-destructive — preserves pre-existing settings keys', () => {
      const p = mkProjectDir('preserve', { permissions: { allow: ['Bash'] }, env: { FOO: '1' } });
      engines.migrateToPlugin(p);
      const s = readSettings(p);
      assert.deepEqual(s.permissions, { allow: ['Bash'] });
      assert.deepEqual(s.env, { FOO: '1' });
      assert.equal(s.enabledPlugins['prawduct@prawduct'], true);
    });

    it('is idempotent — an already-governed project is a no-op', () => {
      const p = mkProjectDir('idem', { enabledPlugins: { 'prawduct@prawduct': true }, marker: 'keep' });
      const r = engines.migrateToPlugin(p);
      assert.equal(r.alreadyGoverned, true);
      assert.equal(r.written, false);
      assert.equal(readSettings(p).marker, 'keep');
    });

    it('refuses to clobber a malformed settings.json', () => {
      const p = fs.mkdtempSync(path.join(tmpDir, 'malformed-'));
      fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
      const bad = path.join(p, '.claude', 'settings.json');
      fs.writeFileSync(bad, '{ not valid json');
      const r = engines.migrateToPlugin(p);
      assert.equal(r.written, false);
      assert.match(r.error, /unparseable/);
      assert.equal(fs.readFileSync(bad, 'utf8'), '{ not valid json'); // untouched
    });

    it('always writes the marketplace entry alongside enabledPlugins', () => {
      // The defect this guards: a project told to enable a plugin it has no
      // way to resolve loads nothing, silently, on any machine where prawduct
      // is not already registered — and looks fine on one where it is.
      const p = mkProjectDir('resolvable');
      engines.migrateToPlugin(p);
      const s = readSettings(p);
      assert.equal(s.enabledPlugins['prawduct@prawduct'], true);
      assert.equal(s.extraKnownMarketplaces.prawduct.source.ref, 'main');
      assert.equal(s.extraKnownMarketplaces.prawduct.autoUpdate, true);
    });

    it('refuses an incomplete reference and writes nothing at all', () => {
      const p = mkProjectDir('halfref');
      const r = engines.migrateToPlugin(p, {
        pluginRef: { enabledPlugins: { 'prawduct@prawduct': true } } // no marketplace
      });
      assert.equal(r.written, false);
      assert.match(r.error, /incomplete plugin reference/);
      // Nothing half-written: the project must not read as governed afterwards.
      assert.equal(engines.isPluginGoverned(p), false);
      assert.equal(fs.existsSync(path.join(p, '.claude', 'settings.json')), false);
    });

    it('neutralizes the vendored governance hook — no product-hook command survives in settings', () => {
      const p = mkProjectDir('neutralize');
      engines.migrateToPlugin(p);
      const hooks = readSettings(p).hooks || {};
      const all = JSON.stringify(hooks);
      assert.ok(!all.includes('product-hook'), 'governed project must not retain the vendored product-hook reference');
    });
  });

  describe('projects.migrateProjectToPlugin (orchestrator)', () => {
    beforeEach(() => {
      // Default: no live session. Individual tests override.
      mock.method(sessionOwnership, 'resolveByProject', () => null);
    });

    it('Cohort C (non-Claude) — not-applicable, no settings mutation', () => {
      const p = mkProjectDir('cohortC');
      store.projects.create({ name: 'c1-gemini', path: p, engine: 'gemini' });
      const r = projects.migrateProjectToPlugin('c1-gemini');
      assert.equal(r.status, 'not-applicable');
      assert.equal(r.migrated, false);
      assert.ok(!fs.existsSync(path.join(p, '.claude', 'settings.json')), 'no settings written for a non-Claude project');
      assert.equal(store.projects.getByName('c1-gemini').migrationStatus, 'not-applicable');
    });

    it('defers on a CONFIRMED-live session — no mutation, status unchanged', () => {
      const p = mkProjectDir('live');
      store.projects.create({ name: 'c1-live', path: p, engine: 'claude' });
      mock.method(sessionOwnership, 'resolveByProject', () => ({ sessionId: 1, project: 'c1-live', live: true }));
      const r = projects.migrateProjectToPlugin('c1-live');
      assert.equal(r.deferred, true);
      assert.equal(r.migrated, false);
      assert.ok(!fs.existsSync(path.join(p, '.claude', 'settings.json')), 'no settings written while a session is live');
      assert.equal(store.projects.getByName('c1-live').migrationStatus, null);
    });

    it('does NOT defer on a stale ownership row whose pane is gone (live:false) — isolates the .live gate', () => {
      const p = mkProjectDir('stalerow');
      store.projects.create({ name: 'c1-stale', path: p, engine: 'claude' });
      // resolveByProject returns an object for any active/wrapping DB row; a
      // dead pane has live:false and must migrate, not falsely defer.
      mock.method(sessionOwnership, 'resolveByProject', () => ({ sessionId: 2, project: 'c1-stale', live: false }));
      const r = projects.migrateProjectToPlugin('c1-stale');
      assert.equal(r.deferred || false, false, 'a stale (dead-pane) row must not defer');
      assert.equal(r.migrated, true);
      assert.equal(engines.isPluginGoverned(p), true);
    });

    it('happy path — migrates a Claude project, status migrated, ref written', () => {
      const p = mkProjectDir('happy');
      store.projects.create({ name: 'c1-happy', path: p, engine: 'claude' });
      const r = projects.migrateProjectToPlugin('c1-happy');
      assert.equal(r.migrated, true);
      assert.equal(r.status, 'migrated');
      assert.equal(engines.isPluginGoverned(p), true);
      assert.equal(store.projects.getByName('c1-happy').migrationStatus, 'migrated');
    });

    it('records pending-activation when the plugin is not installed on this machine', () => {
      engines._internal.pluginsHome = () => pluginsHomeEmpty;
      const p = mkProjectDir('pending');
      store.projects.create({ name: 'c1-pending', path: p, engine: 'claude' });
      const r = projects.migrateProjectToPlugin('c1-pending');
      assert.equal(r.migrated, true);
      assert.equal(r.status, 'pending-activation');
      assert.equal(store.projects.getByName('c1-pending').migrationStatus, 'pending-activation');
      engines._internal.pluginsHome = () => pluginsHomeInstalled;
    });

    it('is idempotent — an already-governed project reports migrated, alreadyGoverned', () => {
      const p = mkProjectDir('already', { enabledPlugins: { 'prawduct@prawduct': true } });
      store.projects.create({ name: 'c1-already', path: p, engine: 'claude' });
      const r = projects.migrateProjectToPlugin('c1-already');
      assert.equal(r.alreadyGoverned, true);
      assert.equal(r.migrated, false);
      assert.equal(r.status, 'migrated');
    });

    it('returns an error for an unknown project', () => {
      const r = projects.migrateProjectToPlugin('c1-does-not-exist');
      assert.match(r.error, /not found/);
      assert.equal(r.migrated, false);
    });

    it('surfaces migrationStatus through the enriched project object', () => {
      const p = mkProjectDir('enrich');
      store.projects.create({ name: 'c1-enrich', path: p, engine: 'claude' });
      projects.migrateProjectToPlugin('c1-enrich');
      const enriched = projects.getProject('c1-enrich');
      assert.equal(enriched.migrationStatus, 'migrated');
    });

    it('migration flips governanceState ungoverned → governed-plugin (C2 #353 badge self-clears)', () => {
      const p = mkProjectDir('govflip');
      store.projects.create({ name: 'c1-govflip', path: p, engine: 'claude' });
      // Before: Claude, no plugin, no vendored hook → ungoverned.
      assert.equal(projects.getProject('c1-govflip').governanceState, 'ungoverned');
      projects.migrateProjectToPlugin('c1-govflip');
      // After: the migration wrote the plugin ref, so the derived state clears.
      assert.equal(projects.getProject('c1-govflip').governanceState, 'governed-plugin');
    });
  });
});
