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
      // #1404 — a Retry re-stages this step from its OUTPUT. The shape it
      // rebuilds must be the shape the handler staged, or downstream steps
      // read a reused capture differently from a fresh one.
      assert.deepEqual(aic.stagedFromOutput(res.output), ctx.staged['memory-update']);
      assert.equal(typeof res.output.capturedAt, 'number', 'the capture time is recorded for the resume window');
    });

    it('blocks with a clear message when the captureFile is missing', async () => {
      aic._internal.readCaptureFile = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
      let removeCalled = false;
      aic._internal.removeCaptureFile = () => { removeCalled = true; };

      const res = await aic.run(baseCtx());

      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      // #1404 — ENOENT after the arm means nothing wrote the file during this
      // step. That is what it says, and it must not name the step prompt as
      // the cause: the old wording did, and sent readers after an AI that had
      // followed its instructions one pass earlier.
      assert.match(res.blockers[0], /captureFile ".tangleclaw\/\.wrap-summary\.md" was not written during this step/);
      assert.match(res.blockers[0], /\(ENOENT\)$/);
      assert.doesNotMatch(res.blockers[0], /prompt must instruct/);
      assert.equal(removeCalled, false, 'do not attempt removal when the read itself failed');
    });

    it('says READ FAILURE, not "not written", when the file exists but cannot be read (#1404)', async () => {
      for (const code of ['EACCES', 'EISDIR']) {
        aic._internal.readCaptureFile = () => { const e = new Error('nope'); e.code = code; throw e; };
        aic._internal.removeCaptureFile = () => {};
        const res = await aic.run(baseCtx());
        assert.equal(res.status, 'blocked');
        assert.match(res.blockers[0], /could not be read after the AI went idle — this is a read failure/, code);
        assert.doesNotMatch(res.blockers[0], /not written/, code);
        assert.ok(res.blockers[0].endsWith(`(${code})`), code);
      }
    });

    it('clears a captureFile left by a PREVIOUS run before asking the AI to write one (#840)', async () => {
      // The file is a hand-off between the memory-update step and this one, at a
      // well-known path, with nothing binding it to the run that should have
      // produced it. On the 2026-08-01 wrap it was already present carrying the
      // previous session's content — three well-formed blocks, correct markdown,
      // real issue numbers — so no validation could catch it, and `## Summary`
      // becomes the wrap commit subject.
      //
      // Removing it BEFORE the prompt is what makes its later existence proof
      // that THIS run wrote it, without asking the AI to stamp anything (which
      // `wrap-direction.md` commitment 2 forbids: no step may need a capability
      // only some engines have).
      let existsCalls = 0;
      const removedAt = [];
      aic._internal.captureFileExists = () => { existsCalls += 1; return existsCalls === 1; };
      aic._internal.removeCaptureFile = (_p, rel) => { removedAt.push(rel); };
      aic._internal.readCaptureFile = () => RAW_BLOCK;
      let sentAfter = null;
      aic._internal.sendKeys = () => { sentAfter = removedAt.length; };

      const res = await aic.run(baseCtx());

      assert.equal(res.ok, true);
      assert.equal(removedAt[0], '.tangleclaw/.wrap-summary.md');
      assert.equal(sentAfter, 1,
        'the stale file must be gone BEFORE the prompt — clearing it afterwards proves nothing');
    });

    it('REFUSES rather than parsing when a stale captureFile cannot be removed (#840)', async () => {
      // The case the delete does not cover. A capture step that proceeds on a
      // payload it cannot attribute is the same defect one level up, so this is a
      // hard refusal: `wrap-direction.md` commitment 3 reserves blocking for a
      // failure that is silent or destructive regardless of preference, and a
      // wrap reporting success while attributing another session's work to this
      // one is exactly that.
      let readCalled = false;
      aic._internal.captureFileExists = () => true;   // never goes away
      aic._internal.removeCaptureFile = () => { throw new Error('EACCES'); };
      aic._internal.readCaptureFile = () => { readCalled = true; return RAW_BLOCK; };
      let sent = false;
      aic._internal.sendKeys = () => { sent = true; };

      const res = await aic.run(baseCtx());

      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.match(res.blockers[0], /belongs to no current run/);
      assert.equal(sent, false, 'the prompt is not even sent — there is nothing safe to capture into');
      assert.equal(readCalled, false, 'and the stale content is never parsed');
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
    // Armed by default — 404, "there was nothing to clear" — so tests about the
    // LATER stages are not blocked by the arm. Unstubbed, the real bridge client
    // would run and return `status: 0`, which correctly blocks (#840); the arm's
    // own behaviour is exercised by the tests that stub this deliberately.
    aic._internal.bridgeClearCaptureFile = async () => (
      { ok: false, content: null, bytes: null, consumed: false, path: null, status: 404, error: 'not found' });
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

  it('arms the capture over the bridge BEFORE sending the prompt (#840, the other half of the family)', async () => {
    // The tmux path unlinks the captureFile before the prompt so its later
    // existence proves this run wrote it. That reasoning is about the FILE, so
    // it holds here identically — and this file lives on a remote filesystem a
    // local unlink cannot reach, which is precisely why guarding only the tmux
    // side would have left half the family uncovered.
    const order = [];
    aic._internal.bridgeClearCaptureFile = async (a) => {
      order.push(`clear:${a.path}:${a.consume}`);
      // The real `clawbridge.getFile` shape for a successful consuming read.
      return {
        ok: true, content: '## Summary\nsomeone else\'s session\n', bytes: 34,
        consumed: true, path: a.path, status: 200, error: null
      };
    };
    aic._internal.bridgeSend = async () => { order.push('send'); return { ok: true, accepted: true, state: 'running' }; };
    aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: true, state: 'running' });
    aic._internal.bridgeGetFile = async () => { order.push('read'); return { ok: true, content: RAW_BLOCK, consumed: true }; };

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, true);
    assert.deepEqual(order, ['clear:.tangleclaw/.wrap-summary.md:true', 'send', 'read'],
      'the stale file must be consumed BEFORE the prompt — clearing it afterwards proves nothing');
    assert.equal(res.output.parsedFields.Summary, 'Tidy wrap cycle; no code changes.',
      "and the discarded stale content must never reach the parsed fields");
  });

  it('REFUSES every answer that leaves the file unarmed, in the shapes getFile really returns', async () => {
    // Built from `clawbridge.getFile`'s own return values, not from an invented
    // one. That client RESOLVES for every outcome — `{ok:false, status}` for any
    // non-2xx, `status: 0` for a network failure or timeout — so a guard written
    // against a thrown error refuses nothing and lets an unarmed run proceed,
    // which is #840's exact end state on this runner.
    const unarmed = [
      ['bridge down / timeout', { ok: false, content: null, bytes: null, consumed: false, path: null, status: 0, error: 'ClawBridge unreachable' }],
      ['forbidden', { ok: false, content: null, bytes: null, consumed: false, path: null, status: 403, error: 'forbidden' }],
      ['waiting for permission', { ok: false, content: null, bytes: null, consumed: false, path: null, status: 409, error: 'busy' }],
      ['server error', { ok: false, content: null, bytes: null, consumed: false, path: null, status: 500, error: 'boom' }],
      // Answered, but the file is STILL THERE — read, not removed. As unarmed as
      // a failed read, and the shape a guard keyed only on `ok` would wave past.
      ['read but not consumed', { ok: true, content: 'stale', bytes: 5, consumed: false, path: 'p', status: 200, error: null }]
    ];

    for (const [label, reply] of unarmed) {
      let sent = false;
      aic._internal.bridgeClearCaptureFile = async () => reply;
      aic._internal.bridgeSend = async () => { sent = true; return { ok: true, accepted: true, state: 'running' }; };

      const res = await aic._runGatewayCapture(ctx(structuredStep));

      assert.equal(res.ok, false, label);
      assert.equal(res.status, 'blocked', label);
      assert.match(res.blockers[0], /stale captureFile/, label);
      assert.equal(sent, false, `${label}: the prompt is not sent — there is nothing safe to capture into`);
    }
  });

  it('treats a 404 as armed — there was nothing to clear', async () => {
    // The ordinary case, and the one a blanket "any non-ok blocks" rule would
    // break: no previous run left a file. Mirrors the tmux path, which refuses
    // only when the file EXISTS and the unlink does not take.
    let sent = false;
    aic._internal.bridgeClearCaptureFile = async () => (
      { ok: false, content: null, bytes: null, consumed: false, path: null, status: 404, error: 'not found' });
    aic._internal.bridgeSend = async () => { sent = true; return { ok: true, accepted: true, state: 'running' }; };
    aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: true, state: 'running' });
    aic._internal.bridgeGetFile = async () => ({ ok: true, content: RAW_BLOCK, consumed: true });

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, true);
    assert.equal(sent, true, 'a clean slate must not block the step');
  });

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
    aic._internal.bridgeGetFile = async () => ({ ok: false, status: 404, error: 'file not found' });

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.ok, false);
    assert.equal(res.status, 'blocked');
    // #1404 — the bridge 404s for a missing file AND an unknown project, so the
    // message names both instead of claiming the AI did not write it.
    assert.match(res.blockers[0], /captureFile ".tangleclaw\/\.wrap-summary\.md" was not found over the gateway — either nothing wrote it during this step .*or the bridge does not know this project/);
    assert.doesNotMatch(res.blockers[0], /prompt must instruct/);
  });

  it('a bridge failure over the gateway reads as a read failure, not a missing file (#1404)', async () => {
    aic._internal.bridgeSend = async () => ({ ok: true });
    aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: true });
    aic._internal.bridgeGetFile = async () => ({ ok: false, status: 502, error: 'bridge unreachable' });

    const res = await aic._runGatewayCapture(ctx(structuredStep));

    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /could not be read over the gateway — this is a read failure/);
    assert.doesNotMatch(res.blockers[0], /not written/);
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
    // Armed: nothing to clear. This test is about the prompt's content, and an
    // unstubbed arm reaches the real bridge client and correctly blocks (#840).
    aic._internal.bridgeClearCaptureFile = async () => (
      { ok: false, consumed: false, status: 404, error: 'not found' });
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

    it('BLOCKS with the uncommitted-work message when dirty work will ship unlogged (#659)', async () => {
      // The uncovered verdict here carries `uncommittedWork` (paths), not commits.
      // The rows have no sha, so the commit renderer's `c.sha.slice(0,7)` would
      // throw — a clean blocker string proves the dedicated branch handled it.
      aic._internal.readForVerify = () => 'identical content';
      aic._internal.changelogCoverage = () => ({
        verdict: 'uncovered',
        uncovered: [],
        uncommittedWork: ['lib/foo.js', 'test/foo.test.js'],
        checkedCount: 0,
        range: 'abc..HEAD',
        reason: null
      });
      const res = await aic.run(coverageCtx());
      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.match(res.blockers[0], /2 uncommitted work file\(s\) will ship in this wrap's commit with no entry/);
      assert.match(res.blockers[0], /CHANGELOG\.md/);
      assert.match(res.output.remediation, /lib\/foo\.js/, 'names the offending files');
      assert.match(res.output.remediation, /test\/foo\.test\.js/);
      assert.doesNotMatch(res.blockers[0], /undefined/, 'the null-sha commit renderer never ran');
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

// #1379 / #1389 — `optionalCaptureFields`: a step may WANT a field without
// REQUIRING it. Four wrap-summary sections (Delta / Open threads / Decisions /
// Pointers) rendered `_⚠ not captured_` on every wrap because nothing asked
// the AI for them. The first fix asked, but by adding all four to
// `captureFields` — the blocking list — so a model that omitted one block
// failed the whole wrap. `wrap-direction.md` § Direction (2) forbids exactly
// that ("never hard-fails the wrap for lacking a single engine's feature") and
// (3) lets a gate block only where failure is silent or destructive. A missing
// judgment section is neither: it renders a visible flag and loses nothing.
describe('wrap-step ai-content — optionalCaptureFields (#1379)', () => {
  // All seven blocks, as a cooperating AI writes them.
  const FULL_BLOCK = [
    '## Summary', 'Split the capture contract.', '',
    '## NextSteps', '- ship it', '',
    '## Learnings', '- none', '',
    '## Delta', '- decided to split required from wanted', '',
    '## OpenThreads', '- none', '',
    '## Decisions', '- optional fields never gate', '',
    '## Pointers', '- lib/wrap-steps/ai-content.js'
  ].join('\n');

  // The same session from a model that answered only what it was required to.
  const CORE_ONLY_BLOCK = [
    '## Summary', 'Split the capture contract.', '',
    '## NextSteps', '- ship it', '',
    '## Learnings', '- none'
  ].join('\n');

  describe('_resolveCaptureContract', () => {
    it('unions both lists for parsing while gating on captureFields alone', () => {
      const { required, all } = aic._resolveCaptureContract({
        captureFields: ['summary'],
        optionalCaptureFields: ['delta']
      });
      assert.deepEqual(required, ['summary']);
      assert.deepEqual(all, ['summary', 'delta']);
    });

    it('deduplicates a field named in both lists, keeping it required', () => {
      // A field in both lists is a declaration bug. `_parseFields` matches with
      // `.find()`, so a duplicate would not actually double-parse — the reason
      // to collapse it is that `all` is handed onward as a set of names: it
      // feeds `wrapShape()`'s union (a repeated name there is published to the
      // wrap payload) and `_uncapturedOptional`, which would otherwise report
      // the same field twice.
      const { required, all } = aic._resolveCaptureContract({
        captureFields: ['summary'],
        optionalCaptureFields: ['summary', 'delta']
      });
      assert.deepEqual(required, ['summary']);
      assert.deepEqual(all, ['summary', 'delta']);
    });

    it('tolerates either list being absent or malformed', () => {
      assert.deepEqual(aic._resolveCaptureContract({}), { required: [], all: [] });
      assert.deepEqual(aic._resolveCaptureContract({ captureFields: ['a'] }), { required: ['a'], all: ['a'] });
      assert.deepEqual(aic._resolveCaptureContract({ optionalCaptureFields: ['b'] }), { required: [], all: ['b'] });
      assert.deepEqual(aic._resolveCaptureContract({ captureFields: 'nope' }), { required: [], all: [] });
    });
  });

  describe('tmux path', () => {
    let saved;
    beforeEach(() => {
      saved = { ...aic._internal };
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true, lastOutputAge: 20000 });
      aic._internal.capturePane = () => ({ lines: ['rendered, no hashes'] });
      aic._internal.captureFileExists = () => false;
      aic._internal.removeCaptureFile = () => {};
    });
    afterEach(() => { Object.assign(aic._internal, saved); });

    const ctx = (overrides = {}) => ({
      project: { name: 'proj', path: '/tmp/proj' },
      session: { tmuxSession: 'sess' },
      step: {
        id: 'memory-update',
        kind: 'ai-content',
        prompt: 'write the block',
        captureFields: ['summary', 'nextSteps', 'learnings'],
        optionalCaptureFields: ['delta', 'openThreads', 'decisions', 'pointers'],
        captureFile: '.tangleclaw/.wrap-summary.md',
        ...overrides
      },
      previousResults: [],
      staged: {}
    });

    it('captures the optional fields when the AI writes them', async () => {
      aic._internal.readCaptureFile = () => FULL_BLOCK;
      const c = ctx();
      const res = await aic.run(c);

      assert.equal(res.ok, true);
      assert.equal(res.status, 'done');
      assert.equal(res.output.parsedFields.delta, '- decided to split required from wanted');
      assert.equal(res.output.parsedFields.decisions, '- optional fields never gate');
      assert.equal(res.output.parsedFields.pointers, '- lib/wrap-steps/ai-content.js');
      assert.equal(c.staged['memory-update'].parsedFields.openThreads, '- none');
    });

    it('COMPLETES when the AI writes only the three required blocks', async () => {
      // The regression this whole change exists for: before the split this
      // returned ok:false with four blockers and halted the wrap at a step
      // marked `blocker: true`, so nothing after it ran — including `commit`.
      aic._internal.readCaptureFile = () => CORE_ONLY_BLOCK;
      const res = await aic.run(ctx());

      assert.equal(res.ok, true, 'a missing judgment section must never halt the wrap');
      assert.equal(res.status, 'done');
      assert.deepEqual(res.blockers, []);
      assert.equal(res.output.parsedFields.summary, 'Split the capture contract.');
      // Absent, not empty-string: the renderer flags a section it has no key for.
      assert.equal(res.output.parsedFields.delta, undefined);
      assert.equal(res.output.parsedFields.pointers, undefined);
    });

    it('still BLOCKS when a required field is missing, naming only that field', async () => {
      // The guard that must not soften. `## Learnings` omitted, all four
      // optional blocks present — so a wrong fix that gated on the union, or
      // on nothing, both fail here.
      aic._internal.readCaptureFile = () => FULL_BLOCK.replace('## Learnings\n- none\n\n', '');
      const res = await aic.run(ctx());

      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.deepEqual(res.blockers, ['Required captureField "learnings" missing or empty in AI response']);
    });

    it('blocks on a required field that is present but EMPTY', async () => {
      aic._internal.readCaptureFile = () => FULL_BLOCK.replace('Split the capture contract.', '');
      const res = await aic.run(ctx());
      assert.equal(res.ok, false);
      assert.match(res.blockers[0], /"summary" missing or empty/);
    });

    it('a field in NEITHER list is unparseable AND contaminates the section before it', async () => {
      // Why the union is load-bearing rather than cosmetic, and why "just
      // shorten captureFields" — the obvious smaller fix — is worse than
      // leaving #1379 alone. `_parseFields` matches a heading only against
      // names it was handed; an unmatched `## Heading` line is not skipped, it
      // is appended to whichever section is open. So dropping a field from
      // both lists does not merely lose it: its heading and body get swallowed
      // into the preceding declared section, which then renders that garbage
      // into the wrap summary as if the AI had written it there.
      aic._internal.readCaptureFile = () => FULL_BLOCK;
      const res = await aic.run(ctx({ optionalCaptureFields: ['delta'] }));

      assert.equal(res.ok, true);
      assert.equal(res.output.parsedFields.decisions, undefined,
        'undeclared heading is invisible to the parser');
      assert.match(res.output.parsedFields.delta, /^- decided to split required from wanted/);
      assert.match(res.output.parsedFields.delta, /## Decisions/,
        'and its content bleeds into the last declared section rather than being dropped');
    });

    it('clears a stale captureFile for a step whose contract is ENTIRELY optional (#840)', async () => {
      // The arm gate asks "does this step have a capture contract?". Keyed to
      // `captureFields` alone it answers no here, and the run would inherit the
      // previous session's file.
      let existsCalls = 0;
      const removed = [];
      aic._internal.captureFileExists = () => { existsCalls += 1; return existsCalls === 1; };
      aic._internal.removeCaptureFile = (_p, rel) => { removed.push(rel); };
      aic._internal.readCaptureFile = () => '## Delta\n- something\n';

      let removedBeforeSend = null;
      aic._internal.sendKeys = () => { removedBeforeSend = removed.length; };

      const res = await aic.run(ctx({ captureFields: [], optionalCaptureFields: ['delta'] }));

      assert.equal(res.ok, true);
      assert.equal(removedBeforeSend, 1, 'the stale file must be gone before the prompt goes out');
    });
  });

  describe('gateway path — the same contract over ClawBridge', () => {
    let saved;
    beforeEach(() => {
      saved = { ...aic._internal };
      aic._internal.sleep = async () => {};
      aic._internal.now = () => 0;
      aic._internal.getBridgeContext = () => ({ localPort: 4567, token: 'tok', project: 'proj' });
      aic._internal.listWrapRules = () => [];
      aic._internal.bridgeClearCaptureFile = async () => (
        { ok: false, content: null, bytes: null, consumed: false, path: null, status: 404, error: 'not found' });
      aic._internal.bridgeSend = async () => ({ ok: true, accepted: true, state: 'running' });
      aic._internal.bridgeGetStatus = async () => ({ ok: true, inputReady: true, state: 'running' });
    });
    afterEach(() => { Object.assign(aic._internal, saved); });

    const ctx = (overrides = {}) => ({
      project: { name: 'proj', path: '/tmp/proj' },
      session: { sessionMode: 'webui', tmuxSession: null, engineId: 'openclaw:abc' },
      step: {
        id: 'memory-update',
        kind: 'ai-content',
        prompt: 'wrap please',
        captureFields: ['summary', 'nextSteps', 'learnings'],
        optionalCaptureFields: ['delta', 'openThreads', 'decisions', 'pointers'],
        captureFile: '.tangleclaw/.wrap-summary.md',
        ...overrides
      },
      previousResults: [],
      staged: {},
      options: {}
    });

    it('captures the optional fields when the AI writes them', async () => {
      aic._internal.bridgeGetFile = async () => ({ ok: true, content: FULL_BLOCK, consumed: true });
      const res = await aic._runGatewayCapture(ctx());

      assert.equal(res.ok, true);
      assert.equal(res.output.parsedFields.delta, '- decided to split required from wanted');
      assert.equal(res.output.parsedFields.pointers, '- lib/wrap-steps/ai-content.js');
    });

    it('COMPLETES when the AI writes only the three required blocks', async () => {
      // Same assertion as the tmux case on purpose. The two transports gate in
      // separate functions, and a guard fixed on one side only is this repo's
      // recurring shape — so each side is pinned against its own runner.
      aic._internal.bridgeGetFile = async () => ({ ok: true, content: CORE_ONLY_BLOCK, consumed: true });
      const res = await aic._runGatewayCapture(ctx());

      assert.equal(res.ok, true);
      assert.deepEqual(res.blockers, []);
      assert.equal(res.output.parsedFields.delta, undefined);
    });

    it('still BLOCKS when a required field is missing', async () => {
      aic._internal.bridgeGetFile = async () => (
        { ok: true, content: FULL_BLOCK.replace('## NextSteps\n- ship it\n\n', ''), consumed: true });
      const res = await aic._runGatewayCapture(ctx());

      assert.equal(res.ok, false);
      assert.equal(res.status, 'blocked');
      assert.deepEqual(res.blockers, ['Required captureField "nextSteps" missing or empty in AI response']);
    });

    it('does NOT skip a step whose capture contract is entirely optional', async () => {
      // The gateway's "no structured-capture contract → honest skip" branch is
      // union-keyed now. Keyed on `captureFields` alone it would skip an
      // optional-only step outright — the step would never prompt over the
      // bridge, and Slice A would flag its sections with a reason that was not
      // the real one.
      aic._internal.bridgeGetFile = async () => (
        { ok: true, content: '## Delta\n- something moved\n', consumed: true });
      const res = await aic._runGatewayCapture(ctx({ captureFields: [], optionalCaptureFields: ['delta'] }));

      assert.equal(res.ok, true);
      assert.equal(res.status, 'done', 'an all-optional contract is a real contract over the bridge');
      assert.equal(res.output.parsedFields.delta, '- something moved');
    });

    it('still honestly skips a step with NO capture contract at all', async () => {
      // The branch's real purpose, pinned so widening it did not delete it.
      const res = await aic._runGatewayCapture(ctx({ captureFields: [], optionalCaptureFields: [] }));
      assert.equal(res.ok, true);
      assert.equal(res.status, 'skipped');
    });

    it('names the uncaptured optional fields on output, like the tmux path', async () => {
      aic._internal.bridgeGetFile = async () => ({ ok: true, content: CORE_ONLY_BLOCK, consumed: true });
      const res = await aic._runGatewayCapture(ctx());
      assert.deepEqual(res.output.uncapturedOptional, ['delta', 'openThreads', 'decisions', 'pointers']);
    });
  });

  describe('reporting the gap', () => {
    // An absent optional section is now a NORMAL outcome, which removes the
    // only thing that distinguished it from a broken one. #1379 ran on every
    // wrap and every engine unnoticed; the server has to say when a wanted
    // block did not arrive, or the next wiring break looks identical to a
    // model exercising judgment.
    let saved;
    beforeEach(() => {
      saved = { ...aic._internal };
      aic._internal.sendKeys = () => {};
      aic._internal.sleep = async () => {};
      aic._internal.detectIdle = () => ({ idle: true, lastOutputAge: 20000 });
      aic._internal.capturePane = () => ({ lines: ['rendered'] });
      aic._internal.captureFileExists = () => false;
      aic._internal.removeCaptureFile = () => {};
    });
    afterEach(() => { Object.assign(aic._internal, saved); });

    const ctx = () => ({
      project: { name: 'proj', path: '/tmp/proj' },
      session: { tmuxSession: 'sess' },
      step: {
        id: 'memory-update',
        kind: 'ai-content',
        prompt: 'write the block',
        captureFields: ['summary', 'nextSteps', 'learnings'],
        optionalCaptureFields: ['delta', 'openThreads', 'decisions', 'pointers'],
        captureFile: '.tangleclaw/.wrap-summary.md'
      },
      previousResults: [],
      staged: {}
    });

    it('names every optional field that did not arrive', async () => {
      aic._internal.readCaptureFile = () => CORE_ONLY_BLOCK;
      const res = await aic.run(ctx());
      assert.deepEqual(res.output.uncapturedOptional, ['delta', 'openThreads', 'decisions', 'pointers']);
    });

    it('names only the ones missing when the AI supplied some', async () => {
      // The partial case is the one a count cannot express — "captured 5
      // fields" says nothing about WHICH two are absent.
      const partial = CORE_ONLY_BLOCK + '\n\n## Delta\n- something moved\n\n## Pointers\n- a file';
      aic._internal.readCaptureFile = () => partial;
      const res = await aic.run(ctx());
      assert.deepEqual(res.output.uncapturedOptional, ['openThreads', 'decisions']);
    });

    it('reports an empty list when everything was captured', async () => {
      aic._internal.readCaptureFile = () => FULL_BLOCK;
      const res = await aic.run(ctx());
      assert.deepEqual(res.output.uncapturedOptional, []);
    });

    it('an optional field present but WHITESPACE-ONLY counts as uncaptured', async () => {
      // `_parseFields` trims, so a heading with a blank body yields '' — which
      // must read as absent, not as content, or the renderer prints an empty
      // section instead of the honest flag.
      aic._internal.readCaptureFile = () => FULL_BLOCK.replace('- decided to split required from wanted', '   ');
      const res = await aic.run(ctx());
      assert.deepEqual(res.output.uncapturedOptional, ['delta']);
    });
  });
});
