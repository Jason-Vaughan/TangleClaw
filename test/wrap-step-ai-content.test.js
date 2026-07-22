'use strict';

// Regression tests for #287 — the `memory-update` wrap step blocked every
// wrap because `_parseFields` looked for literal `## Heading` lines in the
// tmux pane capture, but `capture-pane -p` returns TUI-RENDERED text with
// the `##` stripped, so headings never matched. The fix: a step may declare
// `captureFile`; the AI writes the structured block to that project-relative
// file (raw markdown, `##` preserved) and the handler parses the file instead
// of the pane. Steps without `captureFile` keep the original pane behavior.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const aic = require('../lib/wrap-steps/ai-content');

// What the AI writes to its captureFile — raw markdown, hashes intact.
const RAW_BLOCK = [
  '## Summary',
  'Tidy wrap cycle; no code changes.',
  '',
  '## NextSteps',
  '- Issue #85 highest priority',
  '',
  '## Learnings',
  '- none'
].join('\n');

// What `capture-pane -p` returns for the SAME response — the TUI rendered
// the `##` headings as styled text, so the literal hashes are gone. This is
// the exact condition that made #287 block every wrap.
const RENDERED_PANE = [
  'Summary',
  'Tidy wrap cycle; no code changes.',
  '',
  'NextSteps',
  '- Issue #85 highest priority',
  '',
  'Learnings',
  '- none'
].join('\n');

describe('wrap-step ai-content — #287 captureFile parsing', () => {
  describe('_parseFields', () => {
    it('parses raw markdown `## ` headings into fields', () => {
      const out = aic._parseFields(RAW_BLOCK, ['summary', 'nextSteps', 'learnings']);
      assert.equal(out.summary, 'Tidy wrap cycle; no code changes.');
      assert.ok(out.nextSteps.includes('Issue #85'));
      assert.equal(out.learnings, '- none');
    });

    it('CANNOT parse TUI-rendered headings (no literal `##`) — documents the #287 failure mode', () => {
      const out = aic._parseFields(RENDERED_PANE, ['summary', 'nextSteps', 'learnings']);
      assert.equal(out.summary, undefined);
      assert.equal(out.nextSteps, undefined);
      assert.equal(out.learnings, undefined);
    });
  });

  describe('run() with captureFile', () => {
    let saved;

    beforeEach(() => {
      saved = { ...aic._internal };
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true, lastOutputAge: 20000 });
      // Pane returns RENDERED text (no `##`) — i.e. the bug condition is live.
      aic._internal.capturePane = () => ({ lines: RENDERED_PANE.split('\n') });
    });

    afterEach(() => { Object.assign(aic._internal, saved); });

    const baseCtx = () => ({
      project: { name: 'proj', path: '/tmp/proj' },
      session: { tmuxSession: 'sess' },
      step: {
        id: 'memory-update',
        kind: 'ai-content',
        prompt: 'write the block',
        captureFields: ['summary', 'nextSteps', 'learnings'],
        captureFile: '.tangleclaw/.wrap-summary.md'
      },
      previousResults: [],
      staged: {}
    });

    it('parses fields from the captureFile even though the pane has no `##` (the fix)', async () => {
      let removed = null;
      aic._internal.readCaptureFile = (projectPath, rel) => {
        assert.equal(projectPath, '/tmp/proj');
        assert.equal(rel, '.tangleclaw/.wrap-summary.md');
        return RAW_BLOCK;
      };
      aic._internal.removeCaptureFile = (_projectPath, rel) => { removed = rel; };

      const ctx = baseCtx();
      const res = await aic.run(ctx);

      assert.equal(res.ok, true);
      assert.equal(res.status, 'done');
      assert.equal(res.output.parsedFields.summary, 'Tidy wrap cycle; no code changes.');
      assert.equal(res.output.parsedFields.learnings, '- none');
      assert.equal(ctx.staged['memory-update'].parsedFields.summary, 'Tidy wrap cycle; no code changes.');
      assert.equal(removed, '.tangleclaw/.wrap-summary.md', 'consume-once: file removed after a successful read');
    });

    it('blocks with a clear message when the captureFile is missing', async () => {
      aic._internal.readCaptureFile = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
      let removeCalled = false;
      aic._internal.removeCaptureFile = () => { removeCalled = true; };

      const res = await aic.run(baseCtx());

      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.match(res.blockers[0], /captureFile ".tangleclaw\/\.wrap-summary\.md" missing or unreadable/);
      assert.equal(removeCalled, false, 'do not attempt removal when the read itself failed');
    });

    it('backward-compat: captureFields WITHOUT captureFile still parses the pane', async () => {
      // An engine that emits raw markdown into the pane (hashes intact).
      aic._internal.capturePane = () => ({ lines: RAW_BLOCK.split('\n') });
      let readCalled = false;
      aic._internal.readCaptureFile = () => { readCalled = true; return ''; };

      const ctx = baseCtx();
      delete ctx.step.captureFile;
      const res = await aic.run(ctx);

      assert.equal(res.ok, true);
      assert.equal(res.output.parsedFields.summary, 'Tidy wrap cycle; no code changes.');
      assert.equal(readCalled, false, 'no captureFile → never reads a file, parses the pane as before');
    });
  });
});

// #627 — every ai-content prompt sent to a session is prefixed with a
// self-identifying header, so three near-identical wrap prompts read as
// distinct pipeline steps rather than a re-fire.
describe('wrap-step ai-content — #627 self-identifying prompt header', () => {
  describe('_wrapStepHeader', () => {
    it('numbers a fixed content step from its runner-supplied position', () => {
      const h = aic._wrapStepHeader(
        { id: 'learnings-capture' },
        { aiContentProgress: { ordinal: 2, total: 3 } }
      );
      assert.equal(h, '[TangleClaw wrap — step 2 of 3: learnings-capture]');
    });

    it('falls back to a numberless header when no progress is supplied (index-describe delegation)', () => {
      assert.equal(aic._wrapStepHeader({ id: 'index-describe' }, {}), '[TangleClaw wrap — index-describe]');
      assert.equal(aic._wrapStepHeader({ id: 'index-describe' }, undefined), '[TangleClaw wrap — index-describe]');
    });

    it('is plain text — no markdown heading that a rich TUI would restyle away (#287 class)', () => {
      const h = aic._wrapStepHeader({ id: 'changelog-update' }, { aiContentProgress: { ordinal: 1, total: 3 } });
      assert.ok(!h.includes('#'), 'header must not contain a markdown hash');
    });

    it('ignores a malformed progress object rather than printing NaN', () => {
      assert.equal(
        aic._wrapStepHeader({ id: 'x' }, { aiContentProgress: { ordinal: 'a', total: 3 } }),
        '[TangleClaw wrap — x]'
      );
    });
  });

  describe('run() prepends the header to the sent prompt', () => {
    let saved;
    let sentPrompt;

    beforeEach(() => {
      saved = { ...aic._internal };
      sentPrompt = null;
      aic._internal.sendKeys = (_sess, prompt) => { sentPrompt = prompt; };
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true, lastOutputAge: 20000 });
      // ≥20 chars so the no-captureFields step clears the min-response gate.
      aic._internal.capturePane = () => ({ lines: ['the AI did the work and replied here'] });
      // No wrap rules — keep the header at the very front of the string.
      aic._internal.listWrapRules = () => [];
    });

    afterEach(() => { Object.assign(aic._internal, saved); });

    it('numbers a fixed content step (step 2 of 3: learnings-capture)', async () => {
      const ctx = {
        project: { name: 'proj', path: '/tmp/proj' },
        session: { tmuxSession: 'sess' },
        step: { id: 'learnings-capture', kind: 'ai-content', prompt: 'capture the learnings' },
        previousResults: [],
        staged: {},
        aiContentProgress: { ordinal: 2, total: 3 }
      };
      const res = await aic.run(ctx);
      assert.equal(res.status, 'done');
      assert.ok(
        sentPrompt.startsWith('[TangleClaw wrap — step 2 of 3: learnings-capture]\n\n'),
        `sent prompt should open with the numbered header, got: ${JSON.stringify(sentPrompt.slice(0, 60))}`
      );
      assert.ok(sentPrompt.includes('capture the learnings'), 'the original prompt body is preserved after the header');
    });

    it('uses a numberless header when the step carries no progress (index-describe delegation shape)', async () => {
      const ctx = {
        project: { name: 'proj', path: '/tmp/proj' },
        session: { tmuxSession: 'sess' },
        step: { id: 'index-describe', kind: 'ai-content', prompt: 'describe the stubs' },
        previousResults: [],
        staged: {}
      };
      const res = await aic.run(ctx);
      assert.equal(res.status, 'done');
      assert.ok(
        sentPrompt.startsWith('[TangleClaw wrap — index-describe]\n\n'),
        `sent prompt should open with the numberless header, got: ${JSON.stringify(sentPrompt.slice(0, 60))}`
      );
    });
  });
});

// #328 — content ai-content steps (changelog-update / learnings-capture /
// memory-update) became blockers; the handler gained a per-step Skip & note
// override, and the timeout message stopped hardcoding "wrap pipeline blocked".
describe('wrap-step ai-content — #328 blocker override + timeout message', () => {
  let saved;
  beforeEach(() => { saved = { ...aic._internal }; });
  afterEach(() => { Object.assign(aic._internal, saved); });

  const ctxWith = (overrides = {}) => ({
    project: { name: 'proj', path: '/tmp/proj' },
    session: { tmuxSession: 'sess' },
    step: { id: 'memory-update', kind: 'ai-content', prompt: 'write the block', allowOverride: true },
    previousResults: [],
    staged: {},
    options: {},
    ...overrides
  });

  describe('Skip & note override', () => {
    it('skips (ok:true) and stages an audit marker when allowOverride + skipAiContent[id]', async () => {
      // No tmux interaction should happen on the override path.
      let sent = false;
      aic._internal.sendKeys = () => { sent = true; };

      const ctx = ctxWith({ options: { skipAiContent: { 'memory-update': true } } });
      const res = await aic.run(ctx);

      assert.equal(res.ok, true);
      assert.equal(res.status, 'skipped');
      assert.equal(res.output.override, true);
      assert.equal(sent, false, 'override short-circuits before any tmux send');
      assert.deepEqual(ctx.staged['memory-update'], { aiContentSkipped: true, stepId: 'memory-update' });
    });

    it('does NOT skip when allowOverride is absent (override is opt-in per step)', async () => {
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true });
      aic._internal.capturePane = () => ({ lines: ['plenty of words here to clear the min-chars gate'] });

      const ctx = ctxWith({
        step: { id: 'memory-update', kind: 'ai-content', prompt: 'go' }, // no allowOverride
        options: { skipAiContent: { 'memory-update': true } }
      });
      const res = await aic.run(ctx);

      assert.equal(res.status, 'done', 'without allowOverride the skip option is ignored');
      assert.equal(ctx.staged['memory-update'] && ctx.staged['memory-update'].aiContentSkipped, undefined);
    });

    it('does NOT skip a different step than the one named in skipAiContent', async () => {
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true });
      aic._internal.capturePane = () => ({ lines: ['plenty of words here to clear the min-chars gate'] });

      const ctx = ctxWith({ options: { skipAiContent: { 'changelog-update': true } } });
      const res = await aic.run(ctx); // step is memory-update
      assert.equal(res.status, 'done', 'skip is scoped to the named step id');
    });
  });

  describe('timeout message', () => {
    it('names the step + "no idle", carries remediation, and never claims "wrap pipeline blocked"', async () => {
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: false }); // never idles
      // Fast-forward the clock: startedAt=0, first while-check=0 (enter),
      // second while-check past the cap (exit as timed-out).
      const ticks = [0, 0, 6 * 60 * 1000];
      let i = 0;
      aic._internal.now = () => ticks[Math.min(i++, ticks.length - 1)];

      const res = await aic.run(ctxWith());

      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.equal(res.blockers.length, 1);
      assert.doesNotMatch(res.blockers[0], /wrap pipeline blocked/, 'must not assert the pipeline blocked');
      assert.match(res.blockers[0], /memory-update/, 'names the step id');
      assert.match(res.blockers[0], /no idle detected/);
      assert.match(res.output.remediation, /Skip & note/);
    });
  });
});

// #334 — WebUI/OpenClaw sessions have no tmux pane (sessionMode:'webui',
// tmuxSession:null). This step's send→poll→capture mechanism can't run, and
// the content ai-content steps are blocker:true, so returning `blocked` would
// halt every webui wrap before commit. The handler must SKIP (ok:true) for a
// webui-mode session — but still BLOCK for the genuine anomaly (a non-webui
// session that lost its tmux).
describe('wrap-step ai-content — #334 webui sessions skip (no tmux pane)', () => {
  let saved;
  beforeEach(() => { saved = { ...aic._internal }; });
  afterEach(() => { Object.assign(aic._internal, saved); });

  // NON-EMPTY prompt on purpose: the empty-prompt skip lives just below the
  // webui guard, so an empty prompt would mask a reverted webui guard. A
  // non-empty prompt isolates the variable under test (project learning).
  const ctx = (session) => ({
    project: { name: 'proj', path: '/tmp/proj' },
    session,
    step: { id: 'memory-update', kind: 'ai-content', prompt: 'write the block' },
    previousResults: [],
    staged: {},
    options: {}
  });

  it('webui-mode session (no tmux) → ok:true, status "skipped", never touches tmux', async () => {
    let sent = false;
    aic._internal.sendKeys = () => { sent = true; };

    const res = await aic.run(ctx({ sessionMode: 'webui', tmuxSession: null }));

    assert.equal(res.ok, true);
    assert.equal(res.status, 'skipped');
    assert.equal(res.output && res.output.webui, true);
    assert.equal(sent, false, 'no prompt sent to a non-existent tmux pane');
  });

  it('non-webui session that lost its tmux still BLOCKS (the genuine anomaly is preserved)', async () => {
    const res = await aic.run(ctx({ sessionMode: 'tmux', tmuxSession: null }));

    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /requires an active tmux session/);
  });

  it('no session at all → blocked', async () => {
    const res = await aic.run(ctx(null));

    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /requires an active session/);
  });
});

// CC-7 Slice B1 — webui sessions now capture structured ai-content over the
// ClawBridge gateway: send → poll status until inputReady → read the raw
// captureFile back over the bridge (consume-once) → parse with `_parseFields`.
// Steps with no captureFile (or no bridge sidecar) stay an honest skip so
// Slice A flags the judgment empty with a reason — never a fabricated capture.
describe('wrap-step ai-content — CC-7 B1 gateway capture (webui)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...aic._internal };
    aic._internal.sleep = async () => {};
    aic._internal.now = () => 0; // never advances → MAX_WAIT_MS is never hit by the clock
    // A bridge-backed webui session by default; individual tests override.
    aic._internal.getBridgeContext = () => ({ localPort: 4567, token: 'tok', project: 'proj' });
    // No wrap rules by default so prompt assertions stay exact (the real
    // listWrapRules would hit an uninitialized store and degrade anyway).
    aic._internal.listWrapRules = () => [];
  });
  afterEach(() => { Object.assign(aic._internal, saved); });

  const webuiSession = { sessionMode: 'webui', tmuxSession: null, engineId: 'openclaw:abc' };
  const ctx = (step) => ({
    project: { name: 'proj', path: '/tmp/proj' },
    session: webuiSession,
    step: { id: 'summary-derive', kind: 'ai-content', prompt: 'wrap please', ...step },
    previousResults: [],
    staged: {},
    options: {}
  });

  const structuredStep = {
    captureFields: ['Summary', 'NextSteps', 'Learnings'],
    captureFile: '.tangleclaw/.wrap-summary.md'
  };

  it('happy path: sends prompt, waits for inputReady, reads + parses the captureFile, stages fields', async () => {
    const calls = { sent: null, fileArgs: null };
    aic._internal.bridgeSend = async (a) => { calls.sent = a; return { ok: true, accepted: true, state: 'running' }; };
    aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: true, state: 'running' });
    aic._internal.bridgeGetFile = async (a) => { calls.fileArgs = a; return { ok: true, content: RAW_BLOCK, consumed: true }; };

    const context = ctx(structuredStep);
    const res = await aic._runGatewayCapture(context);

    assert.equal(res.ok, true);
    assert.equal(res.status, 'done');
    assert.equal(res.output.parsedFields.Summary, 'Tidy wrap cycle; no code changes.');
    assert.match(res.output.parsedFields.NextSteps, /Issue #85/);
    // Staged for the commit step, same shape the tmux path produces.
    assert.deepEqual(context.staged['summary-derive'].parsedFields, res.output.parsedFields);
    // Sent the interpolated prompt over the bridge addressed by project name.
    // #627 — prefixed with the self-identifying header (numberless: a direct
    // _runGatewayCapture call carries no aiContentProgress).
    assert.equal(calls.sent.message, '[TangleClaw wrap — summary-derive]\n\nwrap please');
    assert.equal(calls.sent.project, 'proj');
    assert.equal(calls.sent.localPort, 4567);
    // Read consume-once from the SAME captureFile path the tmux path uses.
    assert.equal(calls.fileArgs.path, '.tangleclaw/.wrap-summary.md');
    assert.equal(calls.fileArgs.consume, true);
  });

  it('no bridge sidecar (getBridgeContext null) → honest skip, never calls send', async () => {
    let sent = false;
    aic._internal.getBridgeContext = () => null;
    aic._internal.bridgeSend = async () => { sent = true; return { ok: true }; };

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, true);
    assert.equal(res.status, 'skipped');
    assert.match(res.output.reason, /no ClawBridge sidecar/);
    assert.equal(sent, false);
  });

  it('step without a captureFile → honest skip (gateway cannot reconstruct unstructured text)', async () => {
    let sent = false;
    aic._internal.bridgeSend = async () => { sent = true; return { ok: true }; };

    const res = await aic._runGatewayCapture(ctx({ prompt: 'write memory block' }));

    assert.equal(res.ok, true);
    assert.equal(res.status, 'skipped');
    assert.match(res.output.reason, /without a captureFile/);
    assert.equal(sent, false, 'no gateway round-trip for an uncapturable step');
  });

  it('captureFile read OK but a required field is missing → blocked', async () => {
    aic._internal.bridgeSend = async () => ({ ok: true });
    aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: true });
    aic._internal.bridgeGetFile = async () => ({ ok: true, content: '## Summary\nonly this one\n', consumed: true });

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.ok(res.blockers.some((b) => /NextSteps/.test(b)));
  });

  it('captureFile unreadable over the gateway → blocked with a clear remediation', async () => {
    aic._internal.bridgeSend = async () => ({ ok: true });
    aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: true });
    aic._internal.bridgeGetFile = async () => ({ ok: false, error: 'file not found' });

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /captureFile ".tangleclaw\/\.wrap-summary\.md" missing or unreadable over the gateway/);
  });

  it('waiting_for_permission → blocked (surfaced honestly, never hangs)', async () => {
    aic._internal.bridgeSend = async () => ({ ok: true });
    aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: false, state: 'waiting_for_permission' });
    let readFile = false;
    aic._internal.bridgeGetFile = async () => { readFile = true; return { ok: true, content: RAW_BLOCK }; };

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /waiting on a permission prompt/);
    assert.equal(readFile, false, 'never reads the file while blocked on a permission');
  });

  it('remote session reported dead (active:false) → fast-fail blocked, never waits out the timeout', async () => {
    let statusCalls = 0;
    aic._internal.bridgeSend = async () => ({ ok: true });
    aic._internal.bridgeGetStatus = async () => { statusCalls++; return { ok: true, active: false, inputReady: false }; };
    let readFile = false;
    aic._internal.bridgeGetFile = async () => { readFile = true; return { ok: true, content: RAW_BLOCK }; };

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /no longer active/);
    assert.equal(statusCalls, 1, 'fast-fails on the first poll, not after MAX_WAIT_MS');
    assert.equal(readFile, false);
  });

  it('terminal session state (ended/failed/timed_out) → fast-fail blocked', async () => {
    for (const state of ['ended', 'failed', 'timed_out']) {
      aic._internal.bridgeSend = async () => ({ ok: true });
      aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: false, state });

      const res = await aic._runGatewayCapture(ctx(structuredStep));

      assert.equal(res.ok, false, `${state} → blocked`);
      assert.equal(res.status, 'blocked');
      assert.match(res.blockers[0], new RegExp(`session ${state}`));
    }
  });

  it('AI never becomes input-ready before MAX_WAIT_MS → blocked timeout', async () => {
    // Advance the clock past MAX_WAIT_MS on the second read so the loop exits.
    const ticks = [0, 10 * 60 * 1000];
    let i = 0;
    aic._internal.now = () => ticks[Math.min(i++, ticks.length - 1)];
    aic._internal.bridgeSend = async () => ({ ok: true });
    aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: false, state: 'running' });

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /never became input-ready/);
  });

  it('send failure → blocked', async () => {
    aic._internal.bridgeSend = async () => ({ ok: false, error: 'no session (404)' });

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /Failed to send prompt to ClawBridge: no session/);
  });

  it('empty prompt → skipped (parity with the tmux path)', async () => {
    let sent = false;
    aic._internal.bridgeSend = async () => { sent = true; return { ok: true }; };

    const res = await aic._runGatewayCapture(ctx({ prompt: '   ', ...structuredStep }));

    assert.equal(res.ok, true);
    assert.equal(res.status, 'skipped');
    assert.equal(sent, false);
  });
});

// CC-7 B1 — `defaultGetBridgeContext` resolves the bridge sidecar from the
// session's engineId via the store. Exercised through `run()` with a stubbed
// store require is overkill; instead verify the non-bridge fast-paths return
// null deterministically (the store-backed happy path is covered by the
// gateway tests above via the injected `getBridgeContext`).
describe('wrap-step ai-content — CC-7 B1 getBridgeContext guards', () => {
  let saved;
  beforeEach(() => {
    saved = { ...aic._internal };
    aic._internal.sleep = async () => {};
    aic._internal.now = () => 0;
  });
  afterEach(() => { Object.assign(aic._internal, saved); });

  const ctx = (session) => ({
    project: { name: 'proj', path: '/tmp/proj' },
    session,
    step: { id: 'summary-derive', kind: 'ai-content', prompt: 'wrap', captureFields: ['Summary'], captureFile: '.cap.md' },
    previousResults: [],
    staged: {},
    options: {}
  });

  it('a non-openclaw engine resolves no bridge → honest skip', async () => {
    let sent = false;
    aic._internal.bridgeSend = async () => { sent = true; return { ok: true }; };
    // Use the REAL getBridgeContext (not the injected mock) — a tmux-engine
    // session id has no `openclaw:` prefix, so it must short-circuit to null.
    const res = await aic._runGatewayCapture(ctx({ sessionMode: 'webui', engineId: 'claude' }));

    assert.equal(res.ok, true);
    assert.equal(res.status, 'skipped');
    assert.match(res.output.reason, /no ClawBridge sidecar/);
    assert.equal(sent, false);
  });
});

// Phase A wrap-rules bridge — the project's enabled `kind='wrap'` session
// rules are appended to every non-empty ai-content prompt as a
// `## Project wrap rules` block, on both the tmux and gateway paths. This is
// what makes the Wrap-rules settings field real: before the bridge, wrap
// rules were stored with no consumer.
describe('wrap-step ai-content — wrap-rules bridge', () => {
  let saved;
  beforeEach(() => { saved = { ...aic._internal }; });
  afterEach(() => { Object.assign(aic._internal, saved); });

  const PROJECT = { id: 7, name: 'proj', path: '/tmp/proj' };

  describe('_appendWrapRules', () => {
    it('appends enabled wrap rules as a ## Project wrap rules block', () => {
      aic._internal.listWrapRules = (projectId) => {
        assert.equal(projectId, 7);
        return [{ content: 'Always update the roadmap' }, { content: '  Note open threads  ' }];
      };
      const out = aic._appendWrapRules('base prompt', PROJECT);
      assert.match(out, /^base prompt\n\n## Project wrap rules\n/);
      assert.match(out, /- Always update the roadmap\n- Note open threads$/);
    });

    it('returns the bare prompt when the project has no wrap rules', () => {
      aic._internal.listWrapRules = () => [];
      assert.equal(aic._appendWrapRules('base prompt', PROJECT), 'base prompt');
    });

    it('skips blank-content rules and degrades to the bare prompt on a store failure', () => {
      aic._internal.listWrapRules = () => [{ content: '   ' }];
      assert.equal(aic._appendWrapRules('base prompt', PROJECT), 'base prompt');

      aic._internal.listWrapRules = () => { throw new Error('db unavailable'); };
      assert.equal(aic._appendWrapRules('base prompt', PROJECT), 'base prompt');
    });
  });

  describe('run() sends the rules-bearing prompt (tmux path)', () => {
    it('the tmux send carries the appended wrap-rules block', async () => {
      let sentPrompt = null;
      aic._internal.sendKeys = (_sess, prompt) => { sentPrompt = prompt; };
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true });
      aic._internal.capturePane = () => ({ lines: ['plenty of words here to clear the min-chars gate'] });
      aic._internal.listWrapRules = () => [{ content: 'Close every open loop' }];

      const res = await aic.run({
        project: PROJECT,
        session: { tmuxSession: 'sess' },
        step: { id: 'memory-update', kind: 'ai-content', prompt: 'write the block' },
        previousResults: [],
        staged: {},
        options: {}
      });

      assert.equal(res.status, 'done');
      // #627 — the self-identifying header leads, then the body, then the rules.
      assert.match(sentPrompt, /^\[TangleClaw wrap — memory-update\]\n\nwrite the block\n\n## Project wrap rules\n/);
      assert.match(sentPrompt, /- Close every open loop/);
    });

    it('an empty step prompt still skips — rules never turn a no-op step into a send', async () => {
      let sent = false;
      aic._internal.sendKeys = () => { sent = true; };
      aic._internal.listWrapRules = () => [{ content: 'Close every open loop' }];

      const res = await aic.run({
        project: PROJECT,
        session: { tmuxSession: 'sess' },
        step: { id: 'placeholder', kind: 'ai-content', prompt: '' },
        previousResults: [],
        staged: {},
        options: {}
      });

      assert.equal(res.status, 'skipped');
      assert.equal(sent, false);
    });
  });
});

// Wrap-rules bridge parity: the gateway path appends the same block the tmux
// path does, and the default listWrapRules feeds rules oldest-first (matching
// startup injection order, not the UI's newest-first list()).
describe('wrap-step ai-content — wrap-rules bridge (gateway path + ordering)', () => {
  let saved;
  beforeEach(() => { saved = { ...aic._internal }; });
  afterEach(() => { Object.assign(aic._internal, saved); });

  it('the gateway send carries the appended wrap-rules block', async () => {
    aic._internal.sleep = async () => {};
    aic._internal.now = () => 0;
    aic._internal.getBridgeContext = () => ({ localPort: 4567, token: 'tok', project: 'proj' });
    aic._internal.listWrapRules = () => [{ content: 'Close every open loop' }];
    let sentMessage = null;
    aic._internal.bridgeSend = async (a) => { sentMessage = a.message; return { ok: true }; };
    aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: true });
    aic._internal.bridgeGetFile = async () => ({ ok: true, content: RAW_BLOCK });

    const res = await aic._runGatewayCapture({
      project: { id: 7, name: 'proj', path: '/tmp/proj' },
      session: { sessionMode: 'webui', tmuxSession: null },
      step: {
        id: 'summary-derive', kind: 'ai-content', prompt: 'wrap please',
        captureFields: ['Summary', 'NextSteps', 'Learnings'],
        captureFile: '.tangleclaw/.wrap-summary.md'
      },
      previousResults: [],
      staged: {},
      options: {}
    });

    assert.equal(res.status, 'done');
    // #627 — header leads on the gateway path too, matching the tmux path.
    assert.match(sentMessage, /^\[TangleClaw wrap — summary-derive\]\n\nwrap please\n\n## Project wrap rules\n/);
    assert.match(sentMessage, /- Close every open loop/);
  });

  it('default listWrapRules returns enabled wrap rules oldest-first (store-backed)', () => {
    const fs2 = require('node:fs');
    const os2 = require('node:os');
    const path2 = require('node:path');
    const store = require('../lib/store');
    const tmpDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'tc-wrap-rules-order-'));
    try {
      store._setBasePath(tmpDir);
      store.init();
      const projPath = path2.join(tmpDir, 'order-proj');
      fs2.mkdirSync(projPath, { recursive: true });
      const pid = store.projects.create({ name: 'order-proj', path: projPath, engine: 'claude' }).id;
      store.sessionRules.create({ content: 'first rule', projectId: pid, kind: 'wrap' });
      store.sessionRules.create({ content: 'second rule', projectId: pid, kind: 'wrap' });
      const disabled = store.sessionRules.create({ content: 'disabled rule', projectId: pid, kind: 'wrap' });
      store.sessionRules.update(disabled.id, { enabled: false });
      store.sessionRules.create({ content: 'a startup rule', projectId: pid, kind: 'startup' });

      const rules = aic._internal.listWrapRules(pid).map((r) => r.content);
      assert.deepEqual(rules, ['first rule', 'second rule']);
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs2.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// D6 (#571 items 4-5, #638) — fail-closed verification for content steps whose
// job is a FILE EDIT. `changelog-update`/`learnings-capture` carry no
// captureFields, so before D6 the only gate was the ≥20-char no-op check: the
// AI could answer "done" without touching CHANGELOG.md and the step reported
// done. A `verifyChanged` step field snapshots the named paths before the AI
// runs and blocks if none changed.
describe('wrap-step ai-content — D6 verifyChanged file-edit gate', () => {
  let saved;
  beforeEach(() => {
    saved = { ...aic._internal };
    aic._internal.sendKeys = () => {};
    aic._internal.sleep = async () => {};
    aic._internal.detectIdle = () => ({ idle: true, lastOutputAge: 20000 });
    aic._internal.capturePane = () => ({ lines: ['## Result', 'Added an entry for the session work.'] });
  });
  afterEach(() => { Object.assign(aic._internal, saved); });

  const ctxWith = (overrides = {}) => ({
    project: { name: 'proj', path: '/tmp/proj' },
    session: { tmuxSession: 'sess' },
    step: { id: 'changelog-update', kind: 'ai-content', prompt: 'edit CHANGELOG.md', verifyChanged: ['CHANGELOG.md'] },
    previousResults: [],
    staged: {},
    options: {},
    ...overrides
  });

  it('DONE when a declared verifyChanged path actually changed', async () => {
    let call = 0;
    // First read = before-snapshot, second = after: content differs.
    aic._internal.readForVerify = () => (call++ === 0 ? 'old changelog' : 'new changelog entry');
    const ctx = ctxWith();
    const res = await aic.run(ctx);
    assert.equal(res.ok, true);
    assert.equal(res.status, 'done');
    assert.ok(ctx.staged['changelog-update'], 'staged on success');
  });

  it('BLOCKS when the AI reported done but the file is byte-identical (the honor-system hole)', async () => {
    aic._internal.readForVerify = () => 'identical content'; // before === after
    const res = await aic.run(ctxWith());
    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /no change detected in CHANGELOG\.md/);
    assert.match(res.output.remediation, /Skip & note/);
  });

  it('counts file CREATION (null → content) as a change', async () => {
    let call = 0;
    aic._internal.readForVerify = () => (call++ === 0 ? null : '# Cross-Session Learnings');
    const ctx = ctxWith({ step: { id: 'learnings-capture', kind: 'ai-content', prompt: 'write learnings', verifyChanged: ['.tangleclaw/memories/learnings.md'] } });
    const res = await aic.run(ctx);
    assert.equal(res.ok, true);
    assert.equal(res.status, 'done');
  });

  it('fails closed when a path is unreadable both before and after (null === null → unchanged)', async () => {
    aic._internal.readForVerify = () => null; // never readable → cannot confirm a change
    const res = await aic.run(ctxWith());
    assert.equal(res.ok, false, 'unverifiable change must block, not pass');
    assert.equal(res.status, 'blocked');
  });

  it('is a no-op when the step declares no verifyChanged (back-compat)', async () => {
    let reads = 0;
    aic._internal.readForVerify = () => { reads++; return null; };
    const ctx = ctxWith({ step: { id: 'summary-derive', kind: 'ai-content', prompt: 'say something long enough to clear the min-chars gate' } });
    const res = await aic.run(ctx);
    assert.equal(res.status, 'done');
    assert.equal(reads, 0, 'no verifyChanged → never snapshots');
  });

  it('gate also applies to a captureFields step that ALSO declares verifyChanged', async () => {
    // captureFile path: fields parse fine, but the declared file did not change.
    aic._internal.capturePane = () => ({ lines: [] });
    aic._internal.readCaptureFile = () => ['## Summary', 'x', '## NextSteps', '- y', '## Learnings', '- none'].join('\n');
    aic._internal.removeCaptureFile = () => {};
    aic._internal.readForVerify = () => 'unchanged'; // MEMORY.md never moved
    const ctx = ctxWith({
      step: {
        id: 'memory-update', kind: 'ai-content', prompt: 'go',
        captureFields: ['summary', 'nextSteps', 'learnings'],
        captureFile: '.tangleclaw/.wrap-summary.md',
        verifyChanged: ['.tangleclaw/memories/MEMORY.md']
      }
    });
    const res = await aic.run(ctx);
    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /no change detected in \.tangleclaw\/memories\/MEMORY\.md/);
  });

  // #645 — the mutation check asks the wrong question of a file the session was
  // required to keep current as it worked, so a compliant session arrives with
  // nothing left to write and gets blocked. A step may declare a second
  // satisfaction route; the gate consults it only when the mutation check fails.
  describe('verifySatisfiedBy — the second satisfaction route', () => {
    const COVERED = { verdict: 'covered', uncovered: [], checkedCount: 3, range: 'abc..HEAD', reason: null };
    const UNAVAILABLE = { verdict: 'unavailable', uncovered: [], checkedCount: 0, range: 'abc..HEAD', reason: 'no refs' };
    const uncovered = () => ({
      verdict: 'uncovered',
      uncovered: [{ sha: 'bbb2222abcdef', subject: 'Unlogged work (#999)' }],
      checkedCount: 2,
      range: 'abc..HEAD',
      reason: null
    });

    const coverageCtx = (overrides = {}) => ctxWith({
      step: {
        id: 'changelog-update',
        kind: 'ai-content',
        prompt: 'edit CHANGELOG.md',
        verifyChanged: ['CHANGELOG.md'],
        verifySatisfiedBy: 'changelog-coverage'
      },
      ...overrides
    });

    it('DONE on an unchanged file when the predicate says the session is covered', async () => {
      aic._internal.readForVerify = () => 'identical content'; // the compliant-session case
      aic._internal.changelogCoverage = () => COVERED;
      const ctx = coverageCtx();
      const res = await aic.run(ctx);
      assert.equal(res.ok, true, 'a complete changelog must satisfy the step without an edit');
      assert.equal(res.status, 'done');
      assert.ok(ctx.staged['changelog-update'], 'staged on success like any other pass');
    });

    it('BLOCKS with the coverage message when commits are unaccounted for', async () => {
      aic._internal.readForVerify = () => 'identical content';
      aic._internal.changelogCoverage = uncovered;
      const res = await aic.run(coverageCtx());
      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.match(res.blockers[0], /1 of 2 commit\(s\) in this session never touched it/);
      assert.match(res.blockers[0], /CHANGELOG\.md/);
      assert.match(res.output.remediation, /bbb2222 Unlogged work/, 'names the offending commit');
      assert.doesNotMatch(res.blockers[0], /byte-identical/, 'must not report the mutation cause');
    });

    it('tells the operator that WRITING THE ENTRY clears the block', async () => {
      // The remediation must name the action that actually clears it. Writing the
      // entry works through either route — during the retry turn it trips the
      // mutation check, and before the retry it leaves the file dirty, which the
      // predicate accepts. Text that instead prescribed a bare Retry, or that told
      // the operator not to pre-edit, would send them in a circle.
      aic._internal.readForVerify = () => 'identical content';
      aic._internal.changelogCoverage = uncovered;
      const res = await aic.run(coverageCtx());
      assert.match(res.output.remediation, /Write the missing entries/i);
      assert.match(res.output.remediation, /uncommitted entry counts/i,
        'the operator must know a pre-retry edit is honored, or they will not make one');
      assert.match(res.output.remediation, /Skip & note/, 'the escape hatch stays named');
    });

    it('hands the step\'s declared paths to the predicate, so both look at the same file', async () => {
      let seenPaths = null;
      aic._internal.readForVerify = () => 'identical content';
      aic._internal.changelogCoverage = (_p, paths) => { seenPaths = paths; return COVERED; };
      await aic.run(coverageCtx());
      assert.deepEqual(seenPaths, ['CHANGELOG.md']);
    });

    it('hands the step\'s coveragePaths to the predicate so a monorepo can widen coverage', async () => {
      let seenCoverage;
      aic._internal.readForVerify = () => 'identical content';
      aic._internal.changelogCoverage = (_p, _paths, coveragePaths) => { seenCoverage = coveragePaths; return COVERED; };
      await aic.run(coverageCtx({
        step: {
          id: 'changelog-update', kind: 'ai-content', prompt: 'edit CHANGELOG.md',
          verifyChanged: ['CHANGELOG.md'], verifySatisfiedBy: 'changelog-coverage',
          coveragePaths: ['skills/*/CHANGELOG.md']
        }
      }));
      assert.deepEqual(seenCoverage, ['skills/*/CHANGELOG.md']);
    });

    it('falls back to the mutation block when the predicate cannot judge', async () => {
      // The no-new-hole pin: `unavailable` must never read as success.
      aic._internal.readForVerify = () => 'identical content';
      aic._internal.changelogCoverage = () => UNAVAILABLE;
      const res = await aic.run(coverageCtx());
      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.match(res.blockers[0], /no change detected in CHANGELOG\.md/);
    });

    it('falls back to the mutation block when the predicate throws', async () => {
      aic._internal.readForVerify = () => 'identical content';
      aic._internal.changelogCoverage = () => { throw new Error('git exploded'); };
      const res = await aic.run(coverageCtx());
      assert.equal(res.ok, false);
      assert.match(res.blockers[0], /no change detected/);
    });

    it('falls back to the mutation block on an unrecognized predicate name', async () => {
      aic._internal.readForVerify = () => 'identical content';
      let consulted = false;
      aic._internal.changelogCoverage = () => { consulted = true; return COVERED; };
      const res = await aic.run(coverageCtx({
        step: {
          id: 'changelog-update', kind: 'ai-content', prompt: 'go',
          verifyChanged: ['CHANGELOG.md'], verifySatisfiedBy: 'no-such-predicate'
        }
      }));
      assert.equal(res.ok, false, 'a spec typo must not silently satisfy the gate');
      assert.equal(consulted, false, 'the changelog predicate is not a catch-all for other names');
    });

    it('does NOT consult the predicate when the file actually changed (cheap route wins)', async () => {
      let consulted = 0;
      let call = 0;
      aic._internal.readForVerify = () => (call++ === 0 ? 'old' : 'new');
      aic._internal.changelogCoverage = () => { consulted++; return COVERED; };
      const res = await aic.run(coverageCtx());
      assert.equal(res.status, 'done');
      assert.equal(consulted, 0, 'a changed file short-circuits before any git work');
    });

    it('never consults the predicate for a step that declares none (back-compat)', async () => {
      let consulted = 0;
      aic._internal.readForVerify = () => 'identical content';
      aic._internal.changelogCoverage = () => { consulted++; return COVERED; };
      const res = await aic.run(ctxWith()); // no verifySatisfiedBy
      assert.equal(res.ok, false, 'behaves byte-for-byte as before the predicate existed');
      assert.match(res.blockers[0], /no change detected/);
      assert.equal(consulted, 0);
    });

    it('applies on the captureFields path too', async () => {
      aic._internal.capturePane = () => ({ lines: [] });
      aic._internal.readCaptureFile = () => ['## Summary', 'x', '## NextSteps', '- y', '## Learnings', '- none'].join('\n');
      aic._internal.removeCaptureFile = () => {};
      aic._internal.readForVerify = () => 'unchanged';
      aic._internal.changelogCoverage = () => COVERED;
      const ctx = ctxWith({
        step: {
          id: 'changelog-update', kind: 'ai-content', prompt: 'go',
          captureFields: ['summary', 'nextSteps', 'learnings'],
          captureFile: '.tangleclaw/.wrap-summary.md',
          verifyChanged: ['CHANGELOG.md'],
          verifySatisfiedBy: 'changelog-coverage'
        }
      });
      const res = await aic.run(ctx);
      assert.equal(res.ok, true, 'both gate call sites honor the predicate');
      assert.equal(res.status, 'done');
    });
  });

  describe('_verifyChangedGate (unit)', () => {
    it('returns null when no snapshot was taken', () => {
      assert.equal(aic._verifyChangedGate('/p', { id: 's' }, null), null);
    });
    it('returns a blocker fragment naming every declared path when nothing changed', () => {
      const savedRead = aic._internal.readForVerify;
      aic._internal.readForVerify = () => 'same';
      try {
        const out = aic._verifyChangedGate('/p', { id: 's' }, { 'A.md': 'same', 'B.md': 'same' });
        assert.match(out.blocker, /A\.md, B\.md/);
      } finally { aic._internal.readForVerify = savedRead; }
    });
  });
});

describe('wrap-step ai-content — #672 file-settle completion (busy pane cannot starve the step)', () => {
  let saved;
  beforeEach(() => { saved = { ...aic._internal }; });
  afterEach(() => { Object.assign(aic._internal, saved); });

  const POLL = 2000;
  const settleStep = {
    id: 'learnings-capture', kind: 'ai-content', prompt: 'go',
    verifyChanged: ['.tangleclaw/memories/learnings.md']
  };
  const ctx = (step) => ({
    project: { name: 'proj', path: '/tmp/proj' },
    session: { tmuxSession: 'sess' },
    step, previousResults: [], staged: {}, options: {}
  });

  it('_watchedOutputPaths merges verifyChanged and captureFile, deduped', () => {
    assert.deepEqual(aic._watchedOutputPaths({ verifyChanged: ['a.md'], captureFile: 'b.md' }), ['a.md', 'b.md']);
    assert.deepEqual(aic._watchedOutputPaths({ verifyChanged: ['a.md', 'a.md'] }), ['a.md']);
    assert.deepEqual(aic._watchedOutputPaths({ captureFile: 'b.md' }), ['b.md']);
    assert.deepEqual(aic._watchedOutputPaths({}), []);
  });

  it('completes when a watched file changes and settles, even though the pane NEVER idles', async () => {
    // The #672 scenario: the operator interacts with the session mid-wrap, so the
    // pane never goes idle — but the AI wrote its learnings entry and stopped.
    let clock = 0;
    aic._internal.sendKeys = () => {};
    aic._internal.sleep = async () => { clock += POLL; };
    aic._internal.now = () => clock;
    aic._internal.detectIdle = () => ({ idle: false });
    aic._internal.capturePane = () => ({ lines: ['operator chatter in the pane, unrelated to the wrap answer'] });
    aic._internal.readForVerify = () => (clock === 0 ? 'old learnings' : 'new learnings entry');

    const res = await aic.run(ctx(settleStep));
    assert.equal(res.ok, true);
    assert.equal(res.status, 'done', 'file changed + held still → done despite a never-idle pane');
  });

  it('does NOT complete via files when no watched file ever changes — falls through to the timeout', async () => {
    let clock = 0;
    aic._internal.sendKeys = () => {};
    aic._internal.sleep = async () => { clock += 6 * 60 * 1000; }; // jump past MAX_WAIT
    aic._internal.now = () => clock;
    aic._internal.detectIdle = () => ({ idle: false });
    aic._internal.readForVerify = () => 'unchanged';

    const res = await aic.run(ctx(settleStep));
    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /no idle detected/);
  });

  it('does NOT settle while the file keeps changing (AI still writing) — only after it holds', async () => {
    let clock = 0;
    aic._internal.sendKeys = () => {};
    aic._internal.sleep = async () => { clock += 30000; };
    aic._internal.now = () => clock;
    aic._internal.detectIdle = () => ({ idle: false });
    // Content differs every poll (keyed on the ever-advancing clock) → the
    // stability window never elapses → the step times out instead of settling.
    aic._internal.readForVerify = () => (clock === 0 ? 'v0' : 'v' + clock);

    const res = await aic.run(ctx(settleStep));
    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked', 'a still-writing file must not be read as settled');
  });

  it('skips the min-response-chars pane check on the file-settle path (pane may be short chatter)', async () => {
    // The load-bearing half of the fix: file-settle completion must NOT be
    // re-blocked by the ≥20-char pane check. The pane here is far under the
    // threshold — file evidence (a changed, settled learnings.md) carries it.
    let clock = 0;
    aic._internal.sendKeys = () => {};
    aic._internal.sleep = async () => { clock += POLL; };
    aic._internal.now = () => clock;
    aic._internal.detectIdle = () => ({ idle: false });
    aic._internal.capturePane = () => ({ lines: ['ok'] }); // 2 chars, below MIN_RESPONSE_CHARS
    aic._internal.readForVerify = () => (clock === 0 ? 'old' : 'new entry written');

    const res = await aic.run(ctx(settleStep));
    assert.equal(res.status, 'done', 'a short pane must not re-block a file-settled step');
  });
});
