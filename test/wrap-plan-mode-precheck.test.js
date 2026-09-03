'use strict';

/*
 * #429 — a wrap triggered while the session sits in a read-only mode (Claude
 * Code's plan mode) used to spend MAX_WAIT_MS discovering that the AI would
 * never write anything, then report `blocked`: five minutes to learn a fact the
 * pane states on its footer before a byte is sent.
 *
 * These tests drive the real `run()` against the real shipped engine profiles.
 * The marker is read out of `data/engines/claude.json` through `store.engines`
 * — not restated here — so deleting or renaming the profile field turns these
 * red rather than leaving a guard that passes against its own fixture.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');

setLevel('error');

const aic = require('../lib/wrap-steps/ai-content');
const store = require('../lib/store');

// The production path reads the profile through `store.engines`, which serves
// the user-local engines dir. Point it at a temp base and `init()`, which syncs
// the tracked `data/engines/` profiles in — so these tests read the SHIPPED
// marker (deleting it turns them red) without depending on what this machine
// happens to have in `~/.tangleclaw`.
let tempBase;
let CLAUDE_MARKER;
// Built in `before` from the shipped marker, so it cannot drift from it.
let PLAN_FOOTER;
const BYPASS_FOOTER = '⏵⏵ bypass permissions on (shift+tab to cycle) · ⇥ 2 agents';
before(() => {
  tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-429-'));
  store._setBasePath(tempBase);
  store.init();
  CLAUDE_MARKER = store.engines.get('claude').capabilities.readOnlyModeMarker;
  PLAN_FOOTER = `⏸ ${CLAUDE_MARKER.marker} · ← 2 agents`;
});
after(() => {
  store.close();
  fs.rmSync(tempBase, { recursive: true, force: true });
});

/**
 * A pane capture whose LAST lines are the engine footer. Everything passed in
 * `above` sits in the scrolled-back conversation, where the check must not
 * look.
 * @param {string[]} above - Transcript lines above the footer.
 * @param {string} footer - The mode line the TUI draws under the input box.
 * @returns {{lines: string[]}}
 */
function pane(above, footer) {
  return {
    lines: [
      ...above,
      '─'.repeat(40),
      '> ',
      '─'.repeat(40),
      `  ${footer}`
    ]
  };
}

describe('#429 read-only pre-check — the engine profile', () => {
  it('the shipped claude profile declares a dated read-only-mode marker', () => {
    assert.equal(typeof CLAUDE_MARKER.marker, 'string');
    assert.ok(CLAUDE_MARKER.marker.trim().length > 0);
    assert.equal(CLAUDE_MARKER.label, 'plan mode');
    assert.ok(CLAUDE_MARKER.evidence && CLAUDE_MARKER.evidence.verifiedOn,
      'a marker is a claim about another product\'s UI — it carries the date it was measured');
    assert.match(CLAUDE_MARKER.evidence.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('the marker names the MODE, so it cannot match a session in another mode', () => {
    // The same footer line renders for every permission mode; only the mode
    // words differ. A marker of just the parenthetical would refuse every wrap.
    assert.ok(!BYPASS_FOOTER.includes(CLAUDE_MARKER.marker),
      'the bypass-mode footer must not contain the plan-mode marker');
    assert.ok(PLAN_FOOTER.includes(CLAUDE_MARKER.marker));
  });

  it('engines with no read-only mode declare no marker', () => {
    for (const id of ['codex', 'aider', 'antigravity']) {
      const profile = store.engines.get(id);
      const caps = (profile && profile.capabilities) || {};
      assert.equal(caps.readOnlyModeMarker, undefined,
        `${id} declares a marker but none has been measured for it`);
    }
  });

  it('_readOnlyModeMarker reads the profile, and is null for an engine without one', () => {
    assert.equal(aic._readOnlyModeMarker({ engineId: 'claude' }).marker, CLAUDE_MARKER.marker);
    assert.equal(aic._readOnlyModeMarker({ engineId: 'codex' }), null);
    assert.equal(aic._readOnlyModeMarker({ engineId: 'nonexistent-engine' }), null);
    assert.equal(aic._readOnlyModeMarker({}), null);
    assert.equal(aic._readOnlyModeMarker(null), null);
  });
});

describe('#429 read-only pre-check — _readOnlyPrecheck states', () => {
  let saved;
  beforeEach(() => {
    saved = { ...aic._internal };
  });
  afterEach(() => { Object.assign(aic._internal, saved); });

  it('read-only: the marker is on the footer', () => {
    aic._internal.capturePane = () => pane(['working on it'], PLAN_FOOTER);
    const res = aic._readOnlyPrecheck({ engineId: 'claude' }, 'sess');
    assert.equal(res.state, 'read-only');
    assert.equal(res.label, 'plan mode');
    assert.equal(res.exit, 'shift+tab');
    assert.match(res.reason, /footer reads/);
  });

  it('clear: a marker is declared and the footer shows a different mode', () => {
    aic._internal.capturePane = () => pane(['working on it'], BYPASS_FOOTER);
    const res = aic._readOnlyPrecheck({ engineId: 'claude' }, 'sess');
    assert.equal(res.state, 'clear');
  });

  it('no-marker: the engine declares none — nothing was measured, and it says which engine', () => {
    let captured = false;
    aic._internal.capturePane = () => { captured = true; return pane([], PLAN_FOOTER); };
    const res = aic._readOnlyPrecheck({ engineId: 'codex' }, 'sess');
    assert.equal(res.state, 'no-marker');
    assert.match(res.reason, /codex/);
    assert.equal(captured, false, 'no marker to look for → do not pay for a pane capture');
  });

  it('unmeasured: the pane could not be read — NOT reported as clear', () => {
    aic._internal.capturePane = () => { throw new Error('no server running'); };
    const res = aic._readOnlyPrecheck({ engineId: 'claude' }, 'sess');
    assert.equal(res.state, 'unmeasured');
    assert.match(res.reason, /no server running/);
  });

  it('unmeasured: an empty capture is an unknown, not an absence', () => {
    aic._internal.capturePane = () => ({ lines: [] });
    assert.equal(aic._readOnlyPrecheck({ engineId: 'claude' }, 'sess').state, 'unmeasured');
    aic._internal.capturePane = () => ({});
    assert.equal(aic._readOnlyPrecheck({ engineId: 'claude' }, 'sess').state, 'unmeasured');
  });

  it('the marker is looked for ONLY in the footer window, not the whole pane', () => {
    // Not hypothetical: the session that built this check had the marker string
    // in its own transcript while discussing it. A whole-pane search refuses a
    // session that is perfectly able to write.
    const chatter = [];
    for (let i = 0; i < 40; i++) chatter.push(`transcript line ${i}`);
    chatter.push(`the marker we look for is "${CLAUDE_MARKER.marker}"`);
    for (let i = 0; i < aic.READ_ONLY_FOOTER_LINES; i++) chatter.push(`more output ${i}`);

    aic._internal.capturePane = () => pane(chatter, BYPASS_FOOTER);
    assert.equal(aic._readOnlyPrecheck({ engineId: 'claude' }, 'sess').state, 'clear',
      'the marker quoted in the conversation above the footer must not refuse the wrap');
  });
});

describe('#429 read-only pre-check — run()', () => {
  let saved;
  let sent;
  let slept;

  beforeEach(() => {
    saved = { ...aic._internal };
    sent = [];
    slept = 0;
    aic._internal.sendKeys = (session, prompt) => { sent.push({ session, prompt }); };
    aic._internal.sleep = async () => { slept += 1; };
    aic._internal.detectIdle = () => ({ idle: true, lastOutputAge: 20000 });
    aic._internal.listWrapRules = () => [];
    aic._internal.readForVerify = () => null;
  });
  afterEach(() => { Object.assign(aic._internal, saved); });

  const ctx = (overrides = {}) => ({
    project: { id: 1, name: 'proj', path: '/tmp/proj', engineId: 'claude', ...(overrides.project || {}) },
    session: { tmuxSession: 'sess' },
    step: { id: 'changelog-update', kind: 'ai-content', prompt: 'update the changelog' },
    previousResults: [],
    staged: {}
  });

  it('a plan-mode pane fails the step immediately, with the actionable message', async () => {
    aic._internal.capturePane = () => pane(['I have written a plan.'], PLAN_FOOTER);

    const c = ctx();
    const res = await aic.run(c);

    assert.equal(res.ok, false);
    assert.equal(res.status, 'needs-operator', 'not `blocked` — the recovery is the operator\'s, not a retry');
    assert.equal(res.blockers.length, 1);
    assert.equal(res.blockers[0], 'Exit plan mode to wrap — content steps need write access');
    assert.match(res.output.remediation, /plan mode/);
    assert.match(res.output.remediation, /shift\+tab/);
    assert.equal(res.output.readOnlyPrecheck.state, 'read-only');

    assert.deepEqual(sent, [], 'the prompt is never sent into a pane that cannot act on it');
    assert.equal(slept, 0, 'and nothing is waited out — this is the five minutes the fix buys back');
    assert.deepEqual(c.staged, {}, 'a refused step stages nothing for the commit');
  });

  it('a pane in a writable mode is unaffected — the prompt goes out as before', async () => {
    aic._internal.capturePane = (session, opts) => (opts && opts.full)
      ? { lines: ['Updated CHANGELOG.md with the entry for this session.'] }
      : pane(['ready'], BYPASS_FOOTER);

    const res = await aic.run(ctx());

    assert.equal(res.ok, true);
    assert.equal(res.status, 'done');
    assert.equal(sent.length, 1);
    assert.equal(res.output.readOnlyPrecheck.state, 'clear');
  });

  it('an engine with no marker proceeds, and the step record says nothing was measured', async () => {
    aic._internal.capturePane = () => ({ lines: ['Updated CHANGELOG.md with the entry for this session.'] });

    const res = await aic.run(ctx({ project: { engineId: 'codex' } }));

    assert.equal(res.ok, true);
    assert.equal(res.status, 'done');
    assert.equal(sent.length, 1);
    assert.equal(res.output.readOnlyPrecheck.state, 'no-marker');
    assert.match(res.output.readOnlyPrecheck.reason, /codex/);
  });

  it('a pane that could not be sampled proceeds, recorded as unmeasured rather than clear', async () => {
    let first = true;
    aic._internal.capturePane = () => {
      if (first) { first = false; throw new Error('session vanished'); }
      return { lines: ['Updated CHANGELOG.md with the entry for this session.'] };
    };

    const res = await aic.run(ctx());

    assert.equal(res.ok, true);
    assert.equal(sent.length, 1, 'an unreadable pane must not gate the wrap');
    assert.equal(res.output.readOnlyPrecheck.state, 'unmeasured');
  });
});

describe('#429 read-only pre-check — every tmux-path outcome carries the pre-check', () => {
  let saved;
  beforeEach(() => {
    saved = { ...aic._internal };
    aic._internal.sleep = async () => {};
    aic._internal.listWrapRules = () => [];
    aic._internal.readForVerify = () => null;
    aic._internal.sendKeys = () => {};
    aic._internal.detectIdle = () => ({ idle: true, lastOutputAge: 20000 });
  });
  afterEach(() => { Object.assign(aic._internal, saved); });

  const ctx = (step = {}) => ({
    project: { id: 1, name: 'proj', path: '/tmp/proj', engineId: 'claude' },
    session: { tmuxSession: 'sess' },
    step: { id: 'changelog-update', kind: 'ai-content', prompt: 'update the changelog', ...step },
    previousResults: [],
    staged: {}
  });

  // Each entry drives `run()` to a DIFFERENT terminal return inside the tmux
  // path. The property under test is the same for all of them: the step record
  // says what was measured about the pane. One hand-stamped return site is how
  // half of them end up unstamped, so the family is enumerated here.
  const shapes = {
    'done': () => {
      aic._internal.capturePane = (s, o) => (o && o.full)
        ? { lines: ['Updated CHANGELOG.md with the entry for this session.'] }
        : pane([], BYPASS_FOOTER);
    },
    'send failure': () => {
      aic._internal.capturePane = () => pane([], BYPASS_FOOTER);
      aic._internal.sendKeys = () => { throw new Error('tmux gone'); };
    },
    'response too short': () => {
      aic._internal.capturePane = (s, o) => (o && o.full)
        ? { lines: ['ok'] }
        : pane([], BYPASS_FOOTER);
    },
    'capture failure after idle': () => {
      let first = true;
      aic._internal.capturePane = (s, o) => {
        if (!o || !o.full) { first = false; return pane([], BYPASS_FOOTER); }
        throw new Error('capture died');
      };
      void first;
    },
    'idle probe failure': () => {
      aic._internal.capturePane = () => pane([], BYPASS_FOOTER);
      aic._internal.detectIdle = () => { throw new Error('idle probe died'); };
    },
    'missing captureFile': () => {
      aic._internal.capturePane = (s, o) => (o && o.full)
        ? { lines: ['Wrote the block.'] }
        : pane([], BYPASS_FOOTER);
      aic._internal.readCaptureFile = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
      aic._internal.removeCaptureFile = () => {};
    }
  };

  for (const [name, arrange] of Object.entries(shapes)) {
    it(`${name} carries output.readOnlyPrecheck`, async () => {
      arrange();
      const step = name === 'missing captureFile'
        ? { captureFields: ['summary'], captureFile: '.tangleclaw/.wrap-summary.md' }
        : {};
      const res = await aic.run(ctx(step));
      assert.ok(res.output && typeof res.output === 'object',
        `${name}: output must be an object so the pre-check has somewhere to live`);
      assert.equal(res.output.readOnlyPrecheck.state, 'clear', `${name}: the measured state is recorded`);
    });
  }

  it('the refused case carries it too — driven through the same run()', async () => {
    aic._internal.capturePane = () => pane([], PLAN_FOOTER);
    const res = await aic.run(ctx());
    assert.equal(res.output.readOnlyPrecheck.state, 'read-only');
  });

  it('_withPrecheck turns a null output into one carrying the pre-check, keeping the rest', () => {
    const pc = { state: 'clear', reason: 'r' };
    assert.deepEqual(aic._withPrecheck({ ok: false, status: 'blocked', output: null, blockers: ['b'] }, pc), {
      ok: false, status: 'blocked', output: { readOnlyPrecheck: pc }, blockers: ['b']
    });
    const kept = aic._withPrecheck({ ok: true, status: 'done', output: { capturedText: 'x' }, blockers: [] }, pc);
    assert.equal(kept.output.capturedText, 'x');
    assert.equal(kept.output.readOnlyPrecheck, pc);
  });
});

describe('#429 read-only pre-check — the drawer speaks the status', () => {
  const HELPER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'wrap-drawer.js'), 'utf8');

  /** @returns {object} the wrap-drawer helper namespace */
  function loadHelpers() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(HELPER_SRC, sandbox);
    return sandbox.window.tcWrapDrawerHelpers;
  }

  const row = (extra = {}) => ({
    stepId: 'changelog-update',
    kind: 'ai-content',
    status: 'needs-operator',
    output: { remediation: 'Exit plan mode (shift+tab), then click Retry.' },
    blockers: ['Exit plan mode to wrap — content steps need write access'],
    ...extra
  });

  it('renders as its own status, not as an unknown one', () => {
    const H = loadHelpers();
    const built = H.buildStepRow(row(), { blockedAt: 'changelog-update' });
    assert.equal(built.statusLabel, 'Needs you');
    assert.equal(built.statusTone, 'needs-operator');
    assert.ok(built.statusTooltip.length > 0, 'an unmapped status falls back to a blank tooltip');
    assert.equal(built.remediation, 'Exit plan mode (shift+tab), then click Retry.');
  });

  it('the tone has a stylesheet rule, so the badge is not unstyled', () => {
    const H = loadHelpers();
    const tone = H.buildStepRow(row(), { blockedAt: 'changelog-update' }).statusTone;
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.css'), 'utf8');
    assert.ok(css.includes(`.wrap-step-status--${tone} {`), `no CSS rule for tone "${tone}"`);
  });

  it('does NOT offer "Ask the session to fix this" — the session is the thing that cannot act', () => {
    const H = loadHelpers();
    const built = H.buildStepRow(row(), { blockedAt: 'changelog-update' });
    assert.equal(built.agentResolvable, false);
    // The control: the same ai-content step blocked for any other reason still
    // offers it, so this is a needs-operator carve-out and not a dead feature.
    const other = H.buildStepRow(row({ status: 'blocked' }), { blockedAt: 'changelog-update' });
    assert.equal(other.agentResolvable, true);
  });

  it('the operator can still skip the step and wrap without it', () => {
    const H = loadHelpers();
    const built = H.buildStepRow(row(), { blockedAt: 'changelog-update' });
    const widget = H.decisionWidgetForBlockedStep(built);
    assert.ok(widget, 'a refused content step is still skippable');
    assert.equal(widget.optionsKey, 'skipAiContent');
  });

  it('the skip rollup counts it — a status in no bucket makes the digest under-report', () => {
    const H = loadHelpers();
    const roll = H.summarizeSkips({
      results: [
        { stepId: 'a', kind: 'test', status: 'done' },
        { stepId: 'changelog-update', kind: 'ai-content', status: 'needs-operator' },
        { stepId: 'c', kind: 'commit', status: 'pending' }
      ]
    });
    assert.equal(roll.total, 3);
    assert.equal(roll.done + roll.blocked + roll.pending + roll.skipped, roll.total,
      'every result lands in exactly one bucket');
    assert.equal(roll.blocked, 1);
  });
});
