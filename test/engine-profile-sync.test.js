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

  it('is idempotent — second init does not rewrite a profile that already matches bundled', () => {
    // After first init, on-disk content matches bundled. Structural
    // equivalence check (`JSON.stringify(JSON.parse(...))`) must short-
    // circuit on second init so mtime doesn't churn.
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
