'use strict';

/*
 * TB-1 (#357) — store-side support for the launch-binder:
 *  - the orchestration_profile column (schema v21→v22) on projects,
 *  - seed-if-missing of orchestration-profiles.json (operator-owned, NOT
 *    canonical-overwrite — unlike engine profiles),
 *  - store.orchestrationProfiles.load() parsing + graceful degradation.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');

const BUNDLED_ORCH_PROFILES = path.join(__dirname, '..', 'data', 'orchestration-profiles.json');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-orch-test-'));
  store._setBasePath(tmpDir);
});

afterEach(() => {
  try { store.close(); } catch (_) { /* may already be closed */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('orchestration-profiles seed (TB-1/#357)', () => {
  it('seeds the bundled profiles into the runtime file on first init', () => {
    store.init();
    const runtimeFile = path.join(tmpDir, 'orchestration-profiles.json');
    assert.ok(fs.existsSync(runtimeFile), 'runtime profiles file should be seeded');
    const seeded = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    const bundled = JSON.parse(fs.readFileSync(BUNDLED_ORCH_PROFILES, 'utf8'));
    assert.deepEqual(seeded.profiles, bundled.profiles);
    assert.ok(seeded.profiles.direct, 'bundled ships a `direct` profile');
  });

  it('does NOT overwrite operator edits on a later init (seed-if-missing, not canonical)', () => {
    store.init();
    store.close();
    const runtimeFile = path.join(tmpDir, 'orchestration-profiles.json');
    // Operator edits the seeded file.
    const edited = {
      profiles: {
        direct: { baseUrl: 'http://my-host.ts.net:4000/v1', model: 'openai/custom', keyRef: 'env:MY_KEY' }
      }
    };
    fs.writeFileSync(runtimeFile, JSON.stringify(edited, null, 2));
    // Re-init must leave the operator's edits intact.
    store.init();
    const after = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    assert.deepEqual(after, edited);
  });
});

describe('orchestrationProfiles.load() (TB-1/#357)', () => {
  it('loads the seeded profiles', () => {
    store.init();
    const cfg = store.orchestrationProfiles.load();
    assert.ok(cfg.profiles.direct);
    assert.equal(cfg.profiles.direct.model, 'openai/qwen2.5-coder-32b-fp16');
  });

  it('returns an empty profiles map when the file is missing', () => {
    // Don't init (no seed); point the loader at a base path with no file.
    store.orchestrationProfiles._clearCache();
    const cfg = store.orchestrationProfiles.load();
    assert.deepEqual(cfg, { profiles: {} });
  });

  it('degrades to empty profiles on malformed JSON (no throw)', () => {
    store.init();
    const runtimeFile = path.join(tmpDir, 'orchestration-profiles.json');
    fs.writeFileSync(runtimeFile, '{ not valid json');
    store.orchestrationProfiles._clearCache();
    const cfg = store.orchestrationProfiles.load();
    assert.deepEqual(cfg, { profiles: {} });
  });

  it('caches the parse and re-reads after _clearCache', () => {
    store.init();
    const runtimeFile = path.join(tmpDir, 'orchestration-profiles.json');
    const first = store.orchestrationProfiles.load();
    // Mutate the file; cached load should NOT see it yet.
    fs.writeFileSync(runtimeFile, JSON.stringify({ profiles: { only: { baseUrl: 'x', model: 'y', keyRef: 'env:Z' } } }));
    assert.equal(store.orchestrationProfiles.load(), first, 'cache hit returns same object');
    store.orchestrationProfiles._clearCache();
    assert.ok(store.orchestrationProfiles.load().profiles.only, 'cleared cache re-reads');
  });
});

describe('orchestration_profile column (schema v21→v22)', () => {
  it('new projects default to a NULL binding', () => {
    store.init();
    const p = store.projects.create({ name: 'tb1-default', path: path.join(tmpDir, 'tb1-default') });
    assert.equal(p.orchestrationProfile, null);
  });

  it('persists and reads back an orchestration_profile binding', () => {
    store.init();
    const p = store.projects.create({ name: 'tb1-bind', path: path.join(tmpDir, 'tb1-bind') });
    store.projects.update(p.id, { orchestration_profile: 'direct' });
    assert.equal(store.projects.get(p.id).orchestrationProfile, 'direct');
  });

  it('can clear a binding back to NULL', () => {
    store.init();
    const p = store.projects.create({ name: 'tb1-clear', path: path.join(tmpDir, 'tb1-clear') });
    store.projects.update(p.id, { orchestration_profile: 'direct' });
    store.projects.update(p.id, { orchestration_profile: null });
    assert.equal(store.projects.get(p.id).orchestrationProfile, null);
  });

  it('DEFAULT_PROJECT_CONFIG carries a null orchestrationKeyRef override slot', () => {
    assert.equal(store.DEFAULT_PROJECT_CONFIG.orchestrationKeyRef, null);
  });

  it('v21→v22 migration is idempotent — a second init keeps the column + binding (no error)', () => {
    store.init();
    const p = store.projects.create({ name: 'tb1-idem', path: path.join(tmpDir, 'tb1-idem') });
    store.projects.update(p.id, { orchestration_profile: 'direct' });
    store.close();

    // Re-open the same DB: the schema is already v22, so migrations are a
    // no-op; the column + value must survive and nothing throws.
    store._setBasePath(tmpDir);
    store.init();
    const db = store.getDb();
    assert.equal(db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get().version, 22);
    assert.equal(store.projects.getByName('tb1-idem').orchestrationProfile, 'direct');
  });
});
