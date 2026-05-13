'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const engines = require('../lib/engines');

/**
 * End-to-end integration test for #158: the chunk-1 `requires` filter must
 * actually filter orphan hooks for projects whose runtime methodology template
 * predates the `requires` field (the pre-#146 shape).
 *
 * Chain under test:
 *   1. `_mergeBundledHookEntries` backfills missing `requires` from bundled
 *      into the reconciled live template.
 *   2. `engines.syncEngineHooks` runs the reconciled template through
 *      `_filterHookEntriesByRequires`.
 *   3. For a project missing `tools/product-hook`, the orphan entry is
 *      filtered out and `.claude/settings.json` contains no orphan injection.
 *
 * Without #158, step 1 is a no-op (live entries have no `requires`), step 2's
 * filter passes them through unchanged, and the orphan Stop hook lands in
 * `.claude/settings.json` → infinite synthetic-user-message loop (the #145
 * incident class).
 */

describe('Issue #158: chunk-1 protection works on pre-#146 runtime templates after reconcile', () => {
  // Isolate the store module's _basePath against an ephemeral tempDir so
  // `engines.syncEngineHooks` → `store.engines.get('claude')` doesn't read
  // the host's real ~/.tangleclaw/engines/ at test time (Critic MAJOR-1).
  // Mirrors test/engines.test.js:13-25 scaffolding.
  let storeBaseDir;
  let projectDir;

  before(() => {
    storeBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-issue-158-store-'));
    store._setBasePath(storeBaseDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(storeBaseDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-issue-158-'));
    // Same projConfig scaffold as the existing #145 tests — explicit
    // silentPrime:false so this test focuses on the methodology hook filter.
    const tcDir = path.join(projectDir, '.tangleclaw');
    fs.mkdirSync(tcDir, { recursive: true });
    fs.writeFileSync(path.join(tcDir, 'project.json'), JSON.stringify({
      engine: 'claude',
      methodology: 'prawduct',
      silentPrime: false
    }));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  /**
   * Builds the bundled prawduct shape for the e2e test.
   * Mirrors the actual bundled template in `data/templates/prawduct/template.json`
   * at the entries-and-requires level; only what this test exercises is
   * specified so a future bundled-template addition doesn't break us.
   */
  function bundledPrawductTemplate() {
    return {
      id: 'prawduct',
      hooks: {
        claude: {
          SessionStart: [{
            matcher: 'startup|clear|resume',
            requires: ['tools/product-hook'],
            hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
          }],
          Stop: [{
            matcher: '',
            requires: ['tools/product-hook'],
            hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
          }]
        }
      }
    };
  }

  /** Pre-#146 runtime shape: same entries as bundled but missing `requires`. */
  function pre146RuntimePrawductTemplate() {
    return {
      id: 'prawduct',
      hooks: {
        claude: {
          SessionStart: [{
            matcher: 'startup|clear|resume',
            hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
          }],
          Stop: [{
            matcher: '',
            hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
          }]
        }
      }
    };
  }

  it('without reconcile: pre-#146 template injects orphan hooks (negative-control regression)', () => {
    // This locks in the BUG that #158 closes. If chunk-1's filter ever starts
    // rejecting entries without `requires`, this test will fail and the
    // backwards-compat behavior is broken (a separate decision worth flagging).
    const liveTemplate = pre146RuntimePrawductTemplate();
    engines.syncEngineHooks(projectDir, liveTemplate);

    const settings = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.hooks, 'pre-reconcile, hooks block is written');
    assert.ok(settings.hooks.Stop, 'pre-reconcile, orphan Stop entry leaks through (the #158 bug)');
    assert.equal(
      settings.hooks.Stop[0].hooks[0].command,
      'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop',
      'pre-reconcile, orphan Stop command leaks through'
    );
  });

  it('after reconcile: pre-#146 template + _mergeBundledHookEntries → no orphan injection', () => {
    const bundled = bundledPrawductTemplate();
    const live = pre146RuntimePrawductTemplate();

    // Step 1: reconcile. This is what `_copyBundledTemplates` calls on next
    // server start for every runtime template that exists on disk.
    const changed = store._mergeBundledHookEntries(bundled, live);
    assert.equal(changed, true, 'reconcile should report changes');
    assert.deepStrictEqual(live.hooks.claude.Stop[0].requires, ['tools/product-hook'],
      'requires backfilled into live before sync');

    // Step 2: sync. The chunk-1 filter now has a `requires` to gate on, and
    // the project does NOT have `tools/product-hook` on disk → filter strips.
    engines.syncEngineHooks(projectDir, live);

    // Step 3: assert no orphan injection in .claude/settings.json.
    const settingsFile = path.join(projectDir, '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsFile), '.claude/settings.json should be written');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    // The whole hooks block should be absent (no kept entries, no silent-prime
    // baseline because projConfig.silentPrime=false). Asserting the absolute
    // structural absence locks in the incident-recovery shape.
    assert.ok(!settings.hooks,
      'reconciled template + missing runtime → no hooks block written (the #145 incident class is suppressed)');
  });

  it('after reconcile + runtime installed: hooks ARE injected', () => {
    // Counterpart to the suppression test — confirms #158's reconcile does
    // not OVER-filter; once the runtime is installed, chunk-1's filter passes
    // the entries through and they reach .claude/settings.json.
    const bundled = bundledPrawductTemplate();
    const live = pre146RuntimePrawductTemplate();
    store._mergeBundledHookEntries(bundled, live);

    // Materialize the runtime that requires expects.
    fs.mkdirSync(path.join(projectDir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'tools', 'product-hook'), '#!/usr/bin/env python3\n');

    engines.syncEngineHooks(projectDir, live);

    const settings = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.hooks && settings.hooks.Stop, 'Stop hook injected once runtime exists');
    assert.equal(settings.hooks.Stop[0].hooks[0].command,
      'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop');
    assert.ok(!('requires' in settings.hooks.Stop[0]),
      'chunk-1 strips the `requires` field from .claude/settings.json output');
  });
});
