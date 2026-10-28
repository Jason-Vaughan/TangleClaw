'use strict';

/*
 * Tests for #251 — canonical-source engine profile sync.
 *
 * The pre-#251 behaviour was add-missing-only: top-level keys absent from
 * the live file got backfilled, but VALUE changes to existing keys never
 * propagated. PR #250 surfaced the gap when it flipped
 * `openclaw.json#launchModes.*.disabled` from `true` → `false` and the new
 * value never reached existing installs, leaving the launch-mode picker
 * inert despite a UI that suggested otherwise.
 *
 * This file pins the new contract: on every `store.init()`, bundled
 * `data/engines/*.json` wins over the on-disk copy at
 * `~/.tangleclaw/engines/*.json`, with a `log.warn` before overwrite for
 * any operator-visible breadcrumb.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');

const BUNDLED_ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-sync-test-'));
  store._setBasePath(tmpDir);
});

afterEach(() => {
  try { store.close(); } catch (_) { /* may already be closed */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('engine profile sync — drift propagation (#251)', () => {
  it('propagates a VALUE change to an existing nested key from bundled to runtime', () => {
    // Issue's canonical reproduction: simulate a pre-#250 openclaw runtime
    // profile with `launchModes.default.disabled === true` (the value
    // shipped at the time the file was first seeded onto this install).
    // Bundled file now has `disabled: false`. Pre-#251 the change never
    // reached runtime — silent miss across every install with a pre-#250
    // openclaw.json on disk.
    const enginesDir = path.join(tmpDir, 'engines');
    fs.mkdirSync(enginesDir, { recursive: true });

    const bundled = JSON.parse(
      fs.readFileSync(path.join(BUNDLED_ENGINES_DIR, 'openclaw.json'), 'utf8')
    );

    // Hand-build a stale runtime copy with disabled=true on every mode.
    const stale = JSON.parse(JSON.stringify(bundled));
    for (const modeKey of Object.keys(stale.launchModes)) {
      stale.launchModes[modeKey].disabled = true;
    }
    fs.writeFileSync(
      path.join(enginesDir, 'openclaw.json'),
      JSON.stringify(stale, null, 2)
    );

    store.init();

    const runtime = store.engines.get('openclaw');
    for (const modeKey of Object.keys(bundled.launchModes)) {
      assert.equal(
        runtime.launchModes[modeKey].disabled,
        bundled.launchModes[modeKey].disabled,
        `launchModes.${modeKey}.disabled must match bundled after canonical-source sync`
      );
    }
  });

  it('propagates a VALUE change at the top level (not just nested)', () => {
    // Edge: top-level field change. Pre-#251 add-missing-only would also
    // miss this if the key already existed in the runtime file.
    const enginesDir = path.join(tmpDir, 'engines');
    fs.mkdirSync(enginesDir, { recursive: true });

    const bundled = JSON.parse(
      fs.readFileSync(path.join(BUNDLED_ENGINES_DIR, 'claude.json'), 'utf8')
    );
    const stale = JSON.parse(JSON.stringify(bundled));
    stale.name = 'Claude Code (STALE LABEL)';
    fs.writeFileSync(
      path.join(enginesDir, 'claude.json'),
      JSON.stringify(stale, null, 2)
    );

    store.init();

    const runtime = store.engines.get('claude');
    assert.equal(runtime.name, bundled.name);
  });

  it('seeds a new engine file that did not previously exist on this install', () => {
    // Fresh install — engines dir empty, every bundled profile is seeded.
    const enginesDir = path.join(tmpDir, 'engines');
    fs.mkdirSync(enginesDir, { recursive: true });

    store.init();

    const bundledFiles = fs.readdirSync(BUNDLED_ENGINES_DIR).filter((f) => f.endsWith('.json'));
    const runtimeFiles = fs.readdirSync(enginesDir);
    for (const file of bundledFiles) {
      assert.ok(runtimeFiles.includes(file), `bundled engine ${file} must seed on fresh install`);
      const runtimeContent = fs.readFileSync(path.join(enginesDir, file), 'utf8');
      const bundledContent = fs.readFileSync(path.join(BUNDLED_ENGINES_DIR, file), 'utf8');
      assert.equal(runtimeContent, bundledContent, `${file} content must match bundled byte-for-byte on seed`);
    }
  });

  it('preserves operator-added engine files that have no bundled counterpart', () => {
    // Operator could write a custom engine profile to
    // `~/.tangleclaw/engines/` (the `store.engines.save` primitive
    // exists, though no UI currently calls it). Such files must NOT be
    // wiped by the canonical-source sync — the runtime dir is a union of
    // bundled + operator-added.
    const enginesDir = path.join(tmpDir, 'engines');
    fs.mkdirSync(enginesDir, { recursive: true });

    const customProfile = {
      id: 'my-custom',
      name: 'My Custom Engine',
      launch: { shellCommand: 'my-custom-cli', args: [] },
      capabilities: {}
    };
    fs.writeFileSync(
      path.join(enginesDir, 'my-custom.json'),
      JSON.stringify(customProfile, null, 2)
    );

    store.init();

    const stillThere = JSON.parse(fs.readFileSync(path.join(enginesDir, 'my-custom.json'), 'utf8'));
    assert.deepStrictEqual(stillThere, customProfile,
      'operator-added profile must survive store.init() unchanged');
    // Bundled profiles must also be present alongside.
    assert.ok(fs.existsSync(path.join(enginesDir, 'claude.json')),
      'bundled profiles seeded alongside operator-added');
  });

  it('tombstones retired engine profiles left behind by earlier installs (#457/#458)', () => {
    // Union semantics preserve operator-added files (test above), which
    // means deleting a BUNDLED profile would silently promote the stale
    // synced copy to an immortal "operator profile". Retired ids are
    // removed explicitly on every boot.
    const enginesDir = path.join(tmpDir, 'engines');
    fs.mkdirSync(enginesDir, { recursive: true });

    // Simulate a pre-retirement install that had synced gemini + genesis.
    fs.writeFileSync(path.join(enginesDir, 'gemini.json'), JSON.stringify({ id: 'gemini', name: 'Gemini CLI' }));
    fs.writeFileSync(path.join(enginesDir, 'genesis.json'), JSON.stringify({ id: 'genesis', name: 'Genesis' }));

    store.init();

    assert.ok(!fs.existsSync(path.join(enginesDir, 'gemini.json')),
      'stale gemini.json must be tombstoned on boot (#457)');
    assert.ok(!fs.existsSync(path.join(enginesDir, 'genesis.json')),
      'stale genesis.json must be tombstoned on boot (#458)');
    // Non-retired profiles are untouched by the tombstone pass.
    assert.ok(fs.existsSync(path.join(enginesDir, 'antigravity.json')),
      'live bundled profiles still seed alongside the tombstone pass');
    // And the store no longer serves the retired engines.
    assert.equal(store.engines.get('gemini'), null, 'gemini must not resolve from the store');
    assert.equal(store.engines.get('genesis'), null, 'genesis must not resolve from the store');
  });

  it('retired bundled profiles are actually gone from data/engines/ (#457/#458)', () => {
    assert.ok(!fs.existsSync(path.join(BUNDLED_ENGINES_DIR, 'gemini.json')),
      'data/engines/gemini.json must stay deleted');
    assert.ok(!fs.existsSync(path.join(BUNDLED_ENGINES_DIR, 'genesis.json')),
      'data/engines/genesis.json must stay deleted');
  });

  it('is idempotent — second init does not rewrite a profile that already matches bundled', () => {
    // After first init, on-disk content matches bundled. Structural
    // equivalence check via `_canonicalize` must short-circuit on second
    // init so mtime doesn't churn.
    store.init();
    const enginesDir = path.join(tmpDir, 'engines');
    const claudePath = path.join(enginesDir, 'claude.json');
    const mtimeFirst = fs.statSync(claudePath).mtimeMs;

    const start = Date.now();
    while (Date.now() - start < 15) { /* spin so mtime would diverge if rewritten */ }

    store.close();
    store.init();
    const mtimeSecond = fs.statSync(claudePath).mtimeMs;
    assert.equal(mtimeSecond, mtimeFirst, 'profile must not be rewritten on second init');
  });

  it('treats whitespace differences as equivalent (no spurious drift on reformat)', () => {
    // An older TC version may have serialized the JSON with different
    // formatting (extra trailing newline, compact spacing). Those are
    // NOT semantic drift and must not trigger an overwrite log.warn.
    const enginesDir = path.join(tmpDir, 'engines');
    fs.mkdirSync(enginesDir, { recursive: true });

    const bundled = JSON.parse(
      fs.readFileSync(path.join(BUNDLED_ENGINES_DIR, 'claude.json'), 'utf8')
    );
    const reformatted = JSON.stringify(bundled);
    const claudePath = path.join(enginesDir, 'claude.json');
    fs.writeFileSync(claudePath, reformatted);

    store.init();

    const afterInit = fs.readFileSync(claudePath, 'utf8');
    assert.equal(afterInit, reformatted,
      'structurally-equivalent on-disk content must not be rewritten');
  });

  it('treats key-order differences as equivalent (Critic #251 review — Finding 3)', () => {
    // PR-review caught that the original `_engineProfileEquivalent`
    // claimed key-order insensitivity but didn't actually deliver it
    // (`JSON.stringify(JSON.parse(...))` preserves V8 insertion order).
    // Fix added a real recursive sorted-keys canonicalization. This test
    // pins the contract: a runtime profile whose top-level keys are in
    // a different order from bundled must be treated as equivalent and
    // NOT rewritten on init.
    const enginesDir = path.join(tmpDir, 'engines');
    fs.mkdirSync(enginesDir, { recursive: true });

    const bundled = JSON.parse(
      fs.readFileSync(path.join(BUNDLED_ENGINES_DIR, 'claude.json'), 'utf8')
    );
    // Build a key-reordered runtime: reverse the top-level key order,
    // recursively reverse nested-object key orders too.
    const reorder = (v) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
      const out = {};
      for (const k of Object.keys(v).reverse()) out[k] = reorder(v[k]);
      return out;
    };
    const reordered = reorder(bundled);
    // Sanity-check the reorder actually changed serialization (otherwise
    // the test is vacuous).
    assert.notEqual(
      JSON.stringify(reordered),
      JSON.stringify(bundled),
      'precondition: reordered object must serialize differently from bundled'
    );

    const claudePath = path.join(enginesDir, 'claude.json');
    const originalBytes = JSON.stringify(reordered, null, 2);
    fs.writeFileSync(claudePath, originalBytes);
    const mtimeBefore = fs.statSync(claudePath).mtimeMs;

    const spinStart = Date.now();
    while (Date.now() - spinStart < 15) { /* mtime divergence guard */ }

    store.init();

    const afterInit = fs.readFileSync(claudePath, 'utf8');
    const mtimeAfter = fs.statSync(claudePath).mtimeMs;
    assert.equal(afterInit, originalBytes,
      'key-order-different but structurally-equivalent file must not be rewritten');
    assert.equal(mtimeAfter, mtimeBefore,
      'mtime must not advance when content is structurally equivalent');
  });

  it('overwrites a corrupted on-disk profile (malformed JSON)', () => {
    // A profile that won't parse can't be checked for equivalence. The
    // fail-open contract of `_engineProfileEquivalent` (returns false on
    // either side throwing) means corrupted files self-heal on next
    // startup — re-synced from bundled.
    const enginesDir = path.join(tmpDir, 'engines');
    fs.mkdirSync(enginesDir, { recursive: true });
    fs.writeFileSync(path.join(enginesDir, 'claude.json'), '{ this is not JSON');

    store.init();

    const runtime = store.engines.get('claude');
    assert.ok(runtime, 'corrupted profile should self-heal — runtime read succeeds');
    assert.equal(runtime.id, 'claude');
  });
});

describe('engine profile sync — snapshot (#251 issue: pin bundled value reaches runtime)', () => {
  it('store.engines.get returns exactly the bundled openclaw.json content after init', () => {
    // This is the snapshot the issue specifically called out: an
    // assertion that every key/value in `data/engines/openclaw.json`
    // (including nested `launchModes.*.disabled`) is exposed by the
    // store-layer reader after `store.init()`. If `_syncBundledEngines`
    // ever regresses to seed-once / add-missing semantics, this test
    // fails loud rather than silently stranding the change in the repo.
    store.init();
    const runtime = store.engines.get('openclaw');
    const bundled = JSON.parse(
      fs.readFileSync(path.join(BUNDLED_ENGINES_DIR, 'openclaw.json'), 'utf8')
    );
    assert.deepStrictEqual(runtime, bundled);
  });

  it('store.engines.list includes every bundled profile, each matching its bundled content', () => {
    store.init();
    const runtime = store.engines.list();
    const bundledFiles = fs.readdirSync(BUNDLED_ENGINES_DIR).filter((f) => f.endsWith('.json'));

    for (const file of bundledFiles) {
      const id = path.basename(file, '.json');
      const runtimeProfile = runtime.find((p) => p.id === id);
      assert.ok(runtimeProfile, `runtime engines list must include id="${id}"`);
      const bundledProfile = JSON.parse(
        fs.readFileSync(path.join(BUNDLED_ENGINES_DIR, file), 'utf8')
      );
      assert.deepStrictEqual(runtimeProfile, bundledProfile,
        `runtime profile for "${id}" must match bundled content byte-for-byte`);
    }
  });
});

describe('engine profile sync — live propagation without a restart (#737)', () => {
  // Redirects BUNDLED_ENGINES_DIR to a tmp dir (`_setBundledEnginesDirForTesting`,
  // same seam as `globalRules._setBundledGlobalRulesPath`) so these tests can
  // simulate a release/`git pull` changing `data/engines/*.json` after
  // store.init() has already run, without touching the real, git-tracked
  // directory.
  let tmpBundledDir;

  function writeFixture(name, overrides) {
    fs.writeFileSync(
      path.join(tmpBundledDir, `${name}.json`),
      JSON.stringify({
        id: name,
        name: 'Fixture Engine',
        launch: { shellCommand: `${name}-cli`, args: [] },
        capabilities: {},
        ...overrides
      }, null, 2)
    );
  }

  beforeEach(() => {
    tmpBundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bundled-engines-test-'));
    writeFixture('fixture-engine', { name: 'Fixture Engine v1' });
    store.engines._setBundledEnginesDirForTesting(tmpBundledDir);
    store.init();
  });

  afterEach(() => {
    store.engines._resetBundledEnginesDirForTesting();
    fs.rmSync(tmpBundledDir, { recursive: true, force: true });
  });

  it('store.engines.list() picks up a bundled profile added after store.init(), with no restart', () => {
    assert.equal(store.engines.get('fixture-engine').name, 'Fixture Engine v1');

    writeFixture('new-engine', { name: 'New Engine' });

    const list = store.engines.list();
    assert.ok(list.some((p) => p.id === 'new-engine'),
      'a bundled profile added after store.init() must appear in list() without a restart');
  });

  it('store.engines.get() picks up a VALUE change to an existing bundled profile, with no restart', () => {
    writeFixture('fixture-engine', { name: 'Fixture Engine v2' });

    const updated = store.engines.get('fixture-engine');
    assert.equal(updated.name, 'Fixture Engine v2',
      'a value change to a bundled profile must propagate on the next get() without a restart');
  });

  it('store.engines.syncBundled() forces an immediate sync pass', () => {
    writeFixture('fixture-engine', { name: 'Fixture Engine v3' });

    store.engines.syncBundled();

    // Read the runtime file directly rather than through `.get()`, which
    // would also trigger `_syncBundledEnginesIfChanged` and mask whether
    // `syncBundled()` itself did the work.
    const runtimePath = path.join(tmpDir, 'engines', 'fixture-engine.json');
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    assert.equal(runtime.name, 'Fixture Engine v3');
  });

  it('re-tombstones a retired engine id that reappeared in the runtime dir, even with the bundled dir unchanged (#457/#458)', () => {
    const runtimeEnginesDir = path.join(tmpDir, 'engines');
    fs.writeFileSync(
      path.join(runtimeEnginesDir, 'gemini.json'),
      JSON.stringify({ id: 'gemini', name: 'Resurrected Gemini' })
    );

    // Nothing in tmpBundledDir changed since store.init() — only the
    // retired-id reappearance should trigger the re-sync here.
    assert.equal(store.engines.get('gemini'), null,
      'a resurrected retired-engine file must be re-tombstoned on the next read');
  });

  it('does not disturb an operator-added profile when the bundled dir is unchanged', () => {
    const customProfile = {
      id: 'my-custom-737',
      name: 'Custom',
      launch: { shellCommand: 'custom-cli', args: [] },
      capabilities: {}
    };
    store.engines.save(customProfile);

    // list() re-checks the bundled fingerprint on every call; since
    // tmpBundledDir hasn't changed, the custom profile saved directly via
    // `store.engines.save()` must survive untouched — pins the dispatch's
    // "unit tests that mutate ~/.tangleclaw/engines/*.json ... remain
    // untouched" requirement through the auto-resync path itself, not just
    // through `_syncBundledEngines`'s pre-existing union semantics.
    const list = store.engines.list();
    assert.deepStrictEqual(list.find((p) => p.id === 'my-custom-737'), customProfile);
  });

  it('retries the sync on the next read after a transient write failure, instead of caching a false "nothing changed" (PRR-B R-Gate R1)', () => {
    // THE BUG THIS CATCHES: recording `_bundledEnginesFingerprint` at the
    // START of `_syncBundledEngines` (before the write that actually
    // catches destDir up to srcDir) would stamp this bundled change as
    // "already synced" the moment the attempt BEGAN, even though the
    // write below fails and destDir never catches up — so a later read,
    // after the transient failure clears, would silently keep serving the
    // stale pre-change content forever.
    const runtimePath = path.join(tmpDir, 'engines', 'fixture-engine.json');

    writeFixture('fixture-engine', { name: 'Fixture Engine v2' });

    // Make the runtime copy temporarily unwritable so the drift-overwrite
    // write inside `_syncBundledEngines` throws partway through the sync.
    fs.chmodSync(runtimePath, 0o444);
    try {
      assert.throws(() => store.engines.get('fixture-engine'),
        'a write failure mid-sync must surface, not be swallowed');
    } finally {
      fs.chmodSync(runtimePath, 0o600);
    }

    const recovered = store.engines.get('fixture-engine');
    assert.equal(recovered.name, 'Fixture Engine v2',
      'once the transient failure clears, the next read must retry the sync and succeed — '
      + 'not serve stale content because the failed attempt was already marked "synced"');
  });
});
