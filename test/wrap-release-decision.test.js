'use strict';

/*
 * #1492 L3 — the operator's release decision in the wrap UI.
 *
 * Three surfaces carry it, and each is exercised where it lives:
 *  - the pure drawer helpers (`public/wrap-drawer.js`): how Cut / Hold rides the
 *    options, the widget descriptor for a version-bump halt, and the row detail;
 *  - the wrap modal and the drawer widget (`public/session.js`), whose functions
 *    are lifted out and RUN against the mini DOM, because a source match can't
 *    say whether a hidden control still sends its value;
 *  - the settings modal (`public/ui.js`), pinned at the source level where a
 *    render would need the whole modal's globals.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const PUB = path.join(__dirname, '..', 'public');
const SESSION_SRC = fs.readFileSync(path.join(PUB, 'session.js'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(PUB, 'session.html'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');

/**
 * Load the drawer helpers the way the page does, in a sandbox.
 *
 * @returns {object} The exported helpers.
 */
function loadHelpers() {
  const src = fs.readFileSync(path.join(PUB, 'wrap-drawer.js'), 'utf8');
  const sandbox = { module: { exports: {} }, window: null };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

/**
 * Slice a top-level function out of source text by brace-matching, so the test
 * runs the real code rather than a copy.
 *
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find.
 * @returns {string} The declaration plus its balanced body.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
  return '';
}

const H = loadHelpers();

/** A version-bump halted on a release decision, as the runner records it. */
const haltedBump = () => ({
  stepId: 'version-bump',
  kind: 'version-bump',
  status: 'needs-operator',
  blockers: ['release decision needed: releaseMode is ask'],
  output: {
    releaseMode: 'ask',
    held: true,
    needsOperator: true,
    readiness: {
      verdict: 'ready',
      reason: 'unreleased-entries: [Unreleased] has entries',
      signals: [
        { id: 'unreleased-entries', state: 'pass', detail: '[Unreleased] has entries' },
        { id: 'build-plan-status', state: 'n/a', detail: 'no active build plan' }
      ]
    },
    wouldBump: { from: '1.2.3', to: '1.3.0', bumpLevel: 'minor' },
    reason: 'release decision needed: releaseMode is ask',
    detail: 'release decision needed: releaseMode is ask',
    remediation: 'Choose Cut or Hold below, then Retry.'
  }
});

describe('collectOptionsFromAccessors — release', () => {
  it('sends cut and hold', () => {
    assert.equal(H.collectOptionsFromAccessors({ release: () => 'cut' }).release, 'cut');
    assert.equal(H.collectOptionsFromAccessors({ release: () => 'hold' }).release, 'hold');
  });

  it('sends nothing for Auto, or for any value the step would refuse', () => {
    for (const v of ['', null, undefined, 'Cut', 'auto', 42]) {
      assert.equal('release' in H.collectOptionsFromAccessors({ release: () => v }), false, `${String(v)} is not sent`);
    }
  });

  it('keeps a level with Cut, and drops it with Hold so the pair cannot contradict', () => {
    const cut = H.collectOptionsFromAccessors({ release: () => 'cut', bumpLevel: () => 'major' });
    assert.equal(cut.bumpLevel, 'major');
    const hold = H.collectOptionsFromAccessors({ release: () => 'hold', bumpLevel: () => 'major' });
    assert.equal('bumpLevel' in hold, false);
    assert.equal(hold.release, 'hold');
  });
});

describe('replayChoicesFromOptions', () => {
  it('takes back every choice a Retry replays', () => {
    const stranded = [{ remote: 'https://github.com/example/r.git', branch: 'wrap/1-x', headSha: 'e'.repeat(40) }];
    const c = H.replayChoicesFromOptions({
      release: 'cut', bumpLevel: 'major', skipPreflight: true,
      pathDecisions: { 'a.js': 'include', 'b.js': 'leave' }, skipAiContent: { 'memory-update': true }, untrackState: 'decline',
      proceedPastStranded: stranded, keepSessionRunning: true
    });
    assert.deepEqual(JSON.parse(JSON.stringify(c)), {
      release: 'cut', bumpLevel: 'major', skipPreflight: true,
      pathDecisions: { 'a.js': 'include', 'b.js': 'leave' }, skipAiContent: { 'memory-update': true }, untrackState: 'decline',
      proceedPastStranded: stranded, keepSessionRunning: true
    });
  });

  it('reads anything the server would refuse as not chosen', () => {
    const c = H.replayChoicesFromOptions({
      release: 'Hold', bumpLevel: 'huge', skipPreflight: 'yes',
      pathDecisions: { 'a.js': 'discard' }, skipAiContent: { x: 1 }, untrackState: 'yes'
    });
    assert.equal(c.untrackState, '');
    assert.equal(c.release, '');
    assert.equal(c.bumpLevel, '');
    assert.equal(c.skipPreflight, false);
    assert.equal(Object.keys(c.pathDecisions).length, 0);
    assert.equal(Object.keys(c.skipAiContent).length, 0);
    assert.equal(H.replayChoicesFromOptions({ proceedPastStranded: 'wrap/1-x' }).proceedPastStranded.length, 0);
  });

  it('drops a level recorded beside a Hold, and treats no options as none chosen', () => {
    assert.equal(H.replayChoicesFromOptions({ release: 'hold', bumpLevel: 'minor' }).bumpLevel, '');
    for (const o of [null, undefined, 'x']) {
      const c = H.replayChoicesFromOptions(o);
      assert.equal(c.release, '');
      assert.equal(c.skipPreflight, false);
    }
  });
});

describe('releaseDecisionWidget', () => {
  const rowOf = (result, blockedAt = 'version-bump') => H.buildStepRow(result, { blockedAt });

  it('describes a version-bump halt with what would be cut and why', () => {
    const raw = haltedBump();
    const w = H.releaseDecisionWidget(rowOf(raw), raw.output);
    assert.equal(w.kind, 'release-decision');
    assert.equal(w.optionsKey, 'release');
    assert.equal(w.from, '1.2.3');
    assert.equal(w.to, '1.3.0');
    assert.equal(w.bumpLevel, 'minor');
    assert.equal(w.releaseMode, 'ask');
    assert.equal(w.verdict, 'ready');
    assert.equal(w.signals.length, 2);
    assert.equal(w.signals[1].state, 'n/a');
  });

  it('is absent for a plain hold, a done cut, another kind, or a row that is not the blocker', () => {
    const skipped = { ...haltedBump(), status: 'skipped' };
    assert.equal(H.releaseDecisionWidget(rowOf(skipped, null), skipped.output), null);
    const other = { ...haltedBump(), kind: 'ai-content', stepId: 'changelog-update' };
    assert.equal(H.releaseDecisionWidget(rowOf(other, 'changelog-update'), other.output), null);
    const notBlocker = haltedBump();
    assert.equal(H.releaseDecisionWidget(rowOf(notBlocker, 'commit'), notBlocker.output), null);
    const noWould = haltedBump();
    delete noWould.output.wouldBump;
    assert.equal(H.releaseDecisionWidget(rowOf(noWould), noWould.output), null);
  });

  it('carries the AI recommendation and a disagreement, or says why there is none', () => {
    const raw = haltedBump();
    raw.output.recommendation = { state: 'given', value: 'hold', operatorIntent: '"saving state"', reason: 'mid-feature' };
    raw.output.disagreement = true;
    const w = H.releaseDecisionWidget(rowOf(raw), raw.output);
    assert.deepEqual({ ...w.recommendation }, { value: 'hold', operatorIntent: '"saving state"', reason: 'mid-feature' });
    assert.equal(w.recommendationNote, '');
    assert.equal(w.disagreement, true);

    const absent = haltedBump();
    absent.output.recommendation = { state: 'absent', reason: 'the release-recommendation step did not finish (blocked)' };
    const a = H.releaseDecisionWidget(rowOf(absent), absent.output);
    assert.equal(a.recommendation, null);
    assert.equal(a.recommendationNote, 'the release-recommendation step did not finish (blocked)');
    assert.equal(a.disagreement, false);

    const legacy = H.releaseDecisionWidget(rowOf(haltedBump()), haltedBump().output);
    assert.equal(legacy.recommendation, null, 'an output recorded before the recommendation existed still renders');
    assert.equal(legacy.recommendationNote, '');
  });

  it('is not handed to the session to fix: only the operator decides a release', () => {
    assert.equal(rowOf(haltedBump()).agentResolvable, false);
  });
});

describe('the version-bump row detail', () => {
  it('names what is at stake on a halt', () => {
    assert.equal(H.buildStepRow(haltedBump(), { blockedAt: 'version-bump' }).detail,
      'release decision needed: would cut 1.2.3 → 1.3.0');
  });

  it('says when the halt is a disagreement between the checks and the AI', () => {
    const raw = haltedBump();
    raw.output.disagreement = true;
    assert.equal(H.buildStepRow(raw, { blockedAt: 'version-bump' }).detail,
      'release decision needed: would cut 1.2.3 → 1.3.0 · the release checks and the AI disagree');
  });

  it('names the AI recommendation beside a cut', () => {
    const cut = { stepId: 'version-bump', kind: 'version-bump', status: 'done', blockers: [],
      output: { from: '1.2.3', to: '1.3.0', decidedBy: 'operator', recommendation: { state: 'given', value: 'hold' } } };
    assert.equal(H.buildStepRow(cut, {}).detail, '1.2.3 → 1.3.0 (your call) · AI recommended hold');
  });

  it('marks a cut the operator decided, and leaves a gate-decided cut plain', () => {
    const cut = (decidedBy) => ({ stepId: 'version-bump', kind: 'version-bump', status: 'done', blockers: [],
      output: { from: '1.2.3', to: '1.3.0', decidedBy } });
    assert.equal(H.buildStepRow(cut('operator'), {}).detail, '1.2.3 → 1.3.0 (your call)');
    assert.equal(H.buildStepRow(cut('readiness'), {}).detail, '1.2.3 → 1.3.0');
  });
});

describe('the wrap modal release controls (run)', () => {
  /**
   * Build the modal's release elements and run `syncWrapReleaseControls` for a
   * project in `mode` with Release set to `release`.
   *
   * @param {string} mode - The project's resolved releaseMode.
   * @param {string} release - The Release select's value.
   * @param {string} [level] - The bump select's value before the sync.
   * @returns {object} The elements, after the sync.
   */
  function sync(mode, release, level = 'minor') {
    const ids = ['wrapReleaseGroup', 'wrapReleaseOff', 'wrapBumpGroup', 'wrapRelease', 'wrapBumpLevel', 'wrapReleaseHint'];
    const { doc, ids: el } = makeDocument(ids);
    el.wrapRelease.value = release;
    el.wrapBumpLevel.value = level;
    el.wrapReleaseOff.classList.add('hidden');
    el.wrapBumpGroup.classList.add('hidden');
    const ctx = { document: doc, sessionState: { project: { releaseMode: mode } } };
    vm.createContext(ctx);
    vm.runInContext(`${liftFunction(SESSION_SRC, 'function syncWrapReleaseControls()')}; syncWrapReleaseControls();`, ctx);
    return el;
  }

  it('offers the level only while Release is Cut', () => {
    const cut = sync('auto', 'cut');
    assert.equal(cut.wrapBumpGroup.classList.contains('hidden'), false);
    assert.equal(cut.wrapBumpLevel.value, 'minor');
    for (const release of ['', 'hold']) {
      const el = sync('auto', release);
      assert.equal(el.wrapBumpGroup.classList.contains('hidden'), true, `hidden with ${release || 'Auto'}`);
      assert.equal(el.wrapBumpLevel.value, '', 'and cleared, so a level picked under Cut does not survive a switch to Hold');
    }
  });

  it('hides the whole control for an off project, and says why', () => {
    const el = sync('off', 'cut');
    assert.equal(el.wrapReleaseGroup.classList.contains('hidden'), true);
    assert.equal(el.wrapReleaseOff.classList.contains('hidden'), false);
    assert.equal(el.wrapBumpGroup.classList.contains('hidden'), true);
  });

  it('says what Auto will do in each mode', () => {
    assert.match(sync('ask', '').wrapReleaseHint.textContent, /stops at the version bump/);
    assert.match(sync('auto', '').wrapReleaseHint.textContent, /cuts when the release checks pass/);
  });

  it('the markup has the three choices, labelled, with the level group starting hidden', () => {
    assert.match(SESSION_HTML, /<label[^>]*for="wrapRelease"/);
    for (const v of ['', 'cut', 'hold']) assert.match(SESSION_HTML, new RegExp(`<option value="${v}"`));
    assert.match(SESSION_HTML, /class="form-group hidden" id="wrapBumpGroup"/);
  });
});

describe('refreshWrapReleaseMode (run)', () => {
  /**
   * Run the real refresh against a stubbed project read.
   *
   * @param {string} pageMode - The mode the page loaded with.
   * @param {object|Error} answer - The project JSON the server returns, or an Error to throw.
   * @returns {Promise<{changed: boolean, el: object, ctx: object}>}
   */
  async function refresh(pageMode, answer) {
    const ids = ['wrapReleaseGroup', 'wrapReleaseOff', 'wrapBumpGroup', 'wrapRelease', 'wrapBumpLevel', 'wrapReleaseHint'];
    const { doc, ids: el } = makeDocument(ids);
    el.wrapRelease.value = '';
    el.wrapBumpLevel.value = '';
    const ctx = {
      document: doc,
      projectName: 'demo',
      encodeURIComponent,
      sessionState: { project: { releaseMode: pageMode } },
      tcFetch: async () => {
        if (answer instanceof Error) throw answer;
        return { ok: true, json: async () => answer };
      }
    };
    vm.createContext(ctx);
    vm.runInContext(`${liftFunction(SESSION_SRC, 'function syncWrapReleaseControls()')}
${liftFunction(SESSION_SRC, 'async function refreshWrapReleaseMode()')}`, ctx);
    const changed = await ctx.refreshWrapReleaseMode();
    return { changed, el, ctx };
  }

  it('a mode switched from off in another tab brings the Release control back', async () => {
    const { changed, el, ctx } = await refresh('off', { releaseMode: 'auto' });
    assert.equal(changed, true);
    assert.equal(ctx.sessionState.project.releaseMode, 'auto');
    assert.equal(el.wrapReleaseGroup.classList.contains('hidden'), false, 'Hold is offered again');
    assert.equal(el.wrapReleaseOff.classList.contains('hidden'), true);
  });

  it('reports no change when the mode is the same, or the read fails', async () => {
    assert.equal((await refresh('ask', { releaseMode: 'ask' })).changed, false);
    const failed = await refresh('ask', new Error('offline'));
    assert.equal(failed.changed, false);
    assert.equal(failed.ctx.sessionState.project.releaseMode, 'ask');
    assert.equal((await refresh('ask', { name: 'no mode here' })).changed, false);
  });

  it('confirmWrap refreshes before reading the choice, and stops when the mode moved', () => {
    const body = liftFunction(SESSION_SRC, 'async function confirmWrap()');
    const refreshAt = body.indexOf('await refreshWrapReleaseMode()');
    assert.ok(refreshAt !== -1, 'confirmWrap re-reads the mode');
    assert.ok(refreshAt < body.indexOf("getElementById('wrapRelease')"), 'before the Release choice is read');
    assert.match(body.slice(refreshAt, refreshAt + 400), /return;/, 'and returns without sending when it changed');
  });
});

describe('the wrap modal and retry thread the decision (source pins)', () => {
  it('confirmWrap reads Release only while it is shown, and a level only with Cut', () => {
    const body = liftFunction(SESSION_SRC, 'async function confirmWrap()');
    assert.match(body, /classList\.contains\('hidden'\)\s*\?\s*releaseEl\.value\s*:\s*''/);
    assert.match(body, /wrapReleaseChoice === 'cut' \? bumpEl\.value : ''/);
    assert.match(body, /release:\s*\(\)\s*=>\s*wrapReleaseChoice/);
  });

  it('openWrapModal resets Release to Auto and re-syncs the controls', () => {
    const body = liftFunction(SESSION_SRC, 'function openWrapModal()');
    assert.match(body, /releaseEl\.value\s*=\s*''/);
    assert.match(body, /syncWrapReleaseControls\(\)/);
  });

  it('the Release select re-syncs on change', () => {
    assert.match(SESSION_SRC, /\$\('wrapRelease'\)\.addEventListener\('change', syncWrapReleaseControls\)/);
  });

  it('retryWrap prefers a drawer answer, and keeps it for the rest of the wrap', () => {
    const body = liftFunction(SESSION_SRC, 'async function retryWrap()');
    assert.match(body, /\.wrap-decision--release input\[type="radio"\]:checked/);
    assert.match(body, /picked \? picked\.value : wrapReleaseChoice/);
    assert.match(body, /if \(options\.release\) wrapReleaseChoice = options\.release/);
  });

  it('the drawer renders the widget for a blocked row', () => {
    assert.match(SESSION_SRC, /const releaseWidget = H\.releaseDecisionWidget\(row, raw\.output\);/);
  });
});

describe('renderReleaseDecisionWidget (run)', () => {
  /**
   * Render the widget for the halted fixture.
   *
   * @returns {object} The widget's root element.
   */
  function render(adjust = () => {}) {
    const { doc } = makeDocument([]);
    const ctx = { document: doc };
    vm.createContext(ctx);
    vm.runInContext(liftFunction(SESSION_SRC, 'function renderReleaseDecisionWidget(widget)'), ctx);
    const raw = haltedBump();
    adjust(raw.output);
    const widget = H.releaseDecisionWidget(H.buildStepRow(raw, { blockedAt: 'version-bump' }), raw.output);
    return ctx.renderReleaseDecisionWidget(widget);
  }

  /**
   * Every descendant of an element, depth first.
   *
   * @param {object} el - Root.
   * @returns {object[]} Descendants.
   */
  const all = (el) => el.childNodes.flatMap((c) => [c, ...all(c)]);

  it('asks with the versions, the checks and each signal', () => {
    const root = render();
    assert.equal(root.className, 'wrap-decision wrap-decision--release');
    assert.equal(root.dataset.optionsKey, 'release');
    const text = all(root).map((n) => n.textContent || '').join('\n');
    assert.match(text, /It would be 1\.2\.3 → 1\.3\.0 \(minor\)/);
    assert.match(text, /Release mode ask\. Release checks: ready/);
    assert.match(text, /build-plan-status: n\/a — no active build plan/);
  });

  it('shows the AI recommendation with the operator\'s words, and flags a disagreement', () => {
    const text = all(render((o) => {
      o.recommendation = { state: 'given', value: 'hold', operatorIntent: '"saving state"', reason: 'Mid-feature save.' };
      o.disagreement = true;
    })).map((n) => n.textContent || '').join('\n');
    assert.match(text, /The release checks and the AI disagree\. AI recommends hold\. You said "saving state"\. Mid-feature save\./);
  });

  it('says why there is no AI recommendation', () => {
    const text = all(render((o) => {
      o.recommendation = { state: 'absent', reason: 'releaseMode is ask' };
    })).map((n) => n.textContent || '').join('\n');
    assert.match(text, /No AI recommendation: releaseMode is ask/);
    assert.match(all(render()).map((n) => n.textContent || '').join('\n'), /No AI recommendation\./);
  });

  it('offers Cut and Hold with neither preselected', () => {
    const radios = all(render()).filter((n) => n.tagName === 'INPUT');
    assert.deepEqual(radios.map((r) => r.value), ['cut', 'hold']);
    assert.ok(radios.every((r) => r.type === 'radio' && r.name === 'wrapReleaseDecision'));
    assert.ok(radios.every((r) => r.checked !== true), 'the halt hands the decision over; a default would take it back');
  });
});

describe('the settings modal Release mode (source pins)', () => {
  it('renders Off / Auto / Ask, selected from the resolved mode', () => {
    assert.match(UI_SRC, /<select class="form-select" id="settingsReleaseMode">\$\{releaseModeOpts\}<\/select>/);
    assert.match(UI_SRC, /<label class="form-label" for="settingsReleaseMode">Release mode<\/label>/);
    for (const v of ['auto', 'ask', 'off']) assert.match(UI_SRC, new RegExp(`\\['${v}', '`));
    assert.match(UI_SRC, /\['off', 'auto', 'ask'\]\.includes\(project\.releaseMode\) \? project\.releaseMode : 'auto'/);
  });

  it('saves releaseMode alone, and the legacy checkbox is gone', () => {
    const body = liftFunction(UI_SRC, 'async function doSaveSettings()');
    assert.match(body, /body\.releaseMode = releaseModeEl\.value/);
    assert.doesNotMatch(body, /body\.versionBumpEnabled/);
    assert.doesNotMatch(UI_SRC, /settingsVersionBump/);
  });
});
