'use strict';

/*
 * v6.6.2 Wave 1 (Car V664-W1-C, #3277 / V6-042, V6-043).
 *
 * Covers public/v6-lifecycle-stage-progress.js — pure startup/wrap stage
 * rendering, isolated from public/v6-shell.js to stay zero-overlap with
 * concurrent Wave 1 cars already touching that file (#3261/#3287/#3291)
 * and public/style.css (#3260). See that file's own top comment for the
 * #3277 AC1 scope note: the backend telemetry it asks for already flows
 * through lib/sessions.js's startupReadiness()/lib/projects.js's
 * wrapping field; the one real gap (wrap step ids have no human label)
 * is closed here, client-side, cross-checked against the real pipeline
 * below rather than trusted on sight.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-lifecycle-stage-progress.js'), 'utf8');
const WRAP_PIPELINE_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wrap-default-pipeline.js'), 'utf8');

/**
 * Loads the real public/v6-lifecycle-stage-progress.js into a fresh vm
 * sandbox, the same pattern test/v6-b1-ui-shell.test.js uses for
 * public/v6-shell.js.
 * @returns {object}
 */
function loadLifecycleStageProgress() {
  const sandbox = { console, Date };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

/**
 * Every real wrap pipeline step id, in `lib/wrap-default-pipeline.js`'s
 * own declared order — parsed from its real source, never hand-copied.
 * @returns {string[]}
 */
function realWrapStepIds() {
  return [...WRAP_PIPELINE_SRC.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe('WRAP_STEP_LABELS covers every real wrap pipeline step id (#3277 AC1 scope note)', () => {
  const G = loadLifecycleStageProgress();

  it('has no stale id — everything it labels is a real step in lib/wrap-default-pipeline.js today', () => {
    const real = new Set(realWrapStepIds());
    const stale = Object.keys(G.tcV6WrapStepLabels).filter((id) => !real.has(id));
    assert.deepEqual(stale, [], `labeled ids no longer in the real pipeline: ${stale.join(', ')}`);
  });

  it('labels every real step id with real, non-empty, human-readable text', () => {
    for (const id of realWrapStepIds()) {
      const label = G.tcV6WrapStepLabels[id] || '';
      assert.ok(label.length > 0, `${id} has no label`);
      assert.doesNotMatch(label, /-/, `${id}'s label "${label}" still looks like a raw step id`);
    }
  });
});

describe('tcV6StartupStageInfo (#3277 AC1/AC2, V6-042)', () => {
  const G = loadLifecycleStageProgress();

  it('reads inactive ("Ready") for a ready session, or a missing/null startupReadiness', () => {
    for (const r of [{ state: 'ready', step: null }, null, undefined, {}]) {
      const info = G.tcV6StartupStageInfo(r);
      assert.equal(info.active, false);
      assert.equal(info.needsAttention, false);
    }
  });

  it('uses the real human step sentence lib/sessions.js already produces, with a parsed progress fraction', () => {
    const info = G.tcV6StartupStageInfo({ state: 'starting', step: 'Starting — step 2 of 4', blocker: null });
    assert.equal(info.active, true);
    assert.equal(info.label, 'Starting — step 2 of 4');
    assert.equal(info.progressFraction, 0.5);
    assert.equal(info.needsAttention, false);
  });

  it('never fabricates a progress fraction when the step text does not carry a real count', () => {
    const info = G.tcV6StartupStageInfo({ state: 'starting', step: 'Verifying launch model' });
    assert.equal(info.progressFraction, null);
  });

  it('marks needs-attention, and falls back to a plain label when step is null', () => {
    const info = G.tcV6StartupStageInfo({ state: 'needs-attention', step: null, blocker: 'model-unverified' });
    assert.equal(info.needsAttention, true);
    assert.equal(info.label, 'Needs attention');
  });
});

describe('tcV6WrapStageInfo (#3277 AC1/AC2, V6-043)', () => {
  const G = loadLifecycleStageProgress();

  it('reads inactive for false/null/non-object wrapping', () => {
    for (const w of [false, null, undefined, 'nope']) {
      assert.equal(G.tcV6WrapStageInfo(w).active, false);
    }
  });

  it('labels a known real step id', () => {
    const info = G.tcV6WrapStageInfo({ step: 'changelog-update', since: 1000, stale: false });
    assert.equal(info.active, true);
    assert.equal(info.label, 'Writing changelog entry');
    assert.equal(info.stale, false);
  });

  it('title-cases an unrecognized step id instead of leaving it blank (forward-compatible with a future pipeline step)', () => {
    const info = G.tcV6WrapStageInfo({ step: 'draining-inbox', since: null, stale: false });
    assert.equal(info.label, 'Draining Inbox');
  });

  it('falls back to a generic label when step is null, and reports staleness', () => {
    const info = G.tcV6WrapStageInfo({ step: null, since: null, stale: true });
    assert.equal(info.label, 'Wrapping up');
    assert.equal(info.stale, true);
  });
});

describe('tcV6RenderLifecycleSidebarMarkup (#3277 AC2)', () => {
  const G = loadLifecycleStageProgress();

  it('renders nothing when neither startup nor wrap is active', () => {
    assert.equal(G.tcV6RenderLifecycleSidebarMarkup({ startupReadiness: { state: 'ready' }, wrapping: false }), '');
    assert.equal(G.tcV6RenderLifecycleSidebarMarkup({}), '');
    assert.equal(G.tcV6RenderLifecycleSidebarMarkup(null), '');
  });

  it('renders a progress bar with a real percentage when the startup step carries one', () => {
    const html = G.tcV6RenderLifecycleSidebarMarkup({ startupReadiness: { state: 'starting', step: 'Starting — step 1 of 4' } });
    assert.match(html, /v6-lifecycle-bar-fill" style="width: 25%"/);
    assert.match(html, /aria-valuenow="25"/);
  });

  it('renders a spinner (no bar) when no fraction is known', () => {
    const html = G.tcV6RenderLifecycleSidebarMarkup({ startupReadiness: { state: 'starting', step: 'Verifying launch model' } });
    assert.match(html, /v6-lifecycle-spinner/);
    assert.doesNotMatch(html, /v6-lifecycle-bar-fill/);
  });

  it('prefers the startup stage over wrap when (hypothetically) both are active', () => {
    const html = G.tcV6RenderLifecycleSidebarMarkup({
      startupReadiness: { state: 'starting', step: 'Starting — step 1 of 4' },
      wrapping: { step: 'commit', since: 1, stale: false }
    });
    assert.match(html, /Starting — step 1 of 4/);
  });

  it('marks a stale wrap distinctly', () => {
    const html = G.tcV6RenderLifecycleSidebarMarkup({ startupReadiness: { state: 'ready' }, wrapping: { step: 'commit', since: 1, stale: true } });
    assert.match(html, /is-stale/);
  });

  it('escapes the stage label (defense in depth — a step sentence is server-derived, not literally user-authored, but never trusted raw)', () => {
    const html = G.tcV6RenderLifecycleSidebarMarkup({ startupReadiness: { state: 'needs-attention', step: '<img onerror=alert(1)>' } });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  });
});

describe('tcV6RenderLifecycleCentralPaneMarkup (#3277 AC2)', () => {
  const G = loadLifecycleStageProgress();

  it('shows the idle empty state when neither stage is active', () => {
    assert.match(G.tcV6RenderLifecycleCentralPaneMarkup({ startupReadiness: { state: 'ready' }, wrapping: false }), /is-idle/);
  });

  it('shows the startup section with its blocker when needs-attention', () => {
    const html = G.tcV6RenderLifecycleCentralPaneMarkup({ startupReadiness: { state: 'needs-attention', step: null, blocker: 'model-unverified' } });
    assert.match(html, /is-startup is-attention/);
    assert.match(html, /Blocker: model-unverified/);
  });

  it('shows the wrap section with elapsed minutes computed from a fixed nowMs, and a stuck-wrap alert when stale', () => {
    const html = G.tcV6RenderLifecycleCentralPaneMarkup(
      { wrapping: { step: 'commit', since: 0, stale: true } },
      { nowMs: 5 * 60000 }
    );
    assert.match(html, /is-wrap is-stale/);
    assert.match(html, /Running 5m/);
    assert.match(html, /This wrap looks stuck\./);
  });

  it('renders both sections when both are active', () => {
    const html = G.tcV6RenderLifecycleCentralPaneMarkup({
      startupReadiness: { state: 'starting', step: 'Starting — step 3 of 4' },
      wrapping: { step: 'version-bump', since: null, stale: false }
    });
    assert.match(html, /is-startup/);
    assert.match(html, /is-wrap/);
    assert.match(html, /Bumping version/);
  });
});
