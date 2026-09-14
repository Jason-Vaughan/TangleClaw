'use strict';

/*
 * UI-3B8N — the dashboard (landing.js) wrap trigger must be single-flight,
 * mirroring the session.js fix (#519 / VRF-wrap-single-flight).
 *
 * Regression: landing.js `confirmWrap` awaited `POST /wrap` without disabling
 * the confirm button, so a double-click fired two concurrent wraps (double
 * commit / pipeline race), and Cancel or a backdrop click could dismiss the
 * modal mid-wrap. This pins the guard structurally — landing.js is a browser
 * global script, not a require()-able module, so we assert against source the
 * same way test/session-wrapper.test.js pins the session-page fix and
 * test/auth-status-warning.test.js pins its landing surface.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 * @param {string} src full source text
 * @param {string} decl the function declaration to find (e.g. `async function confirmWrap()`)
 * @returns {string} the function body including its braces
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  assert.fail(`${decl} body must close`);
}

describe('UI-3B8N dashboard wrap trigger is single-flight', () => {
  let landing;

  before(() => {
    const root = path.resolve(__dirname, '..');
    landing = fs.readFileSync(path.join(root, 'public/landing.js'), 'utf8');
  });

  it('tracks an in-flight flag', () => {
    assert.ok(landing.includes('let wrapInFlight = false'),
      'landing.js must track an in-flight flag');
  });

  it('confirmWrap guards re-entrancy, locks both buttons, and resets in finally', () => {
    const body = functionBody(landing, 'async function confirmWrap()');
    assert.ok(body.includes('if (wrapInFlight) return'),
      'confirmWrap must bail when a wrap is already in flight');
    assert.ok(body.includes('wrapInFlight = true'),
      'must set the flag before the POST');
    assert.ok(/confirmBtn\.disabled = true/.test(body) && /cancelBtn\.disabled = true/.test(body),
      'must disable both Confirm and Cancel while wrapping');
    assert.ok(/Wrapping/.test(body),
      'must show a Wrapping… label');
    assert.ok(body.includes('} finally {') && /wrapInFlight = false/.test(body),
      'must reset the in-flight flag in finally (so a failed/hung wrap re-enables)');
  });

  it('closeWrapModal blocks user closes while a wrap is in flight (strict force check)', () => {
    assert.ok(landing.includes('if (wrapInFlight && force !== true) return'),
      'closeWrapModal must block Cancel/backdrop closes mid-wrap via a strict force check');
    // The success path must force-close past that guard.
    const body = functionBody(landing, 'async function confirmWrap()');
    assert.ok(body.includes('closeWrapModal(true)'),
      'confirmWrap must force-close the modal on success');
  });

  it('has no timer-driven lifecycle (state tracks the request, not a clock)', () => {
    const body = functionBody(landing, 'async function confirmWrap()');
    assert.ok(!/setTimeout|setInterval/.test(body),
      'confirmWrap must not use timers (no timer-driven UI lifecycle)');
  });
});

describe('dashboard wrap waits for the run it started and names a failure (POST answers 202)', () => {
  const vm = require('node:vm');
  const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
  const decl = 'async function awaitDashboardWrapFailure(name, runId)';
  const fnSrc = `${decl} ${functionBody(landing, decl)}`;

  /**
   * Run the real function against scripted status payloads, one per poll.
   * @param {Array<object|null>} statuses - `null` is a poll that could not run
   * @returns {Promise<{answer: string|null, polls: number}>}
   */
  async function drive(statuses) {
    let polls = 0;
    const ctx = vm.createContext({
      DASHBOARD_WRAP_POLL_MS: 0,
      setTimeout: (fn) => fn(),
      encodeURIComponent,
      tcFetch: async () => {
        const s = statuses[Math.min(polls, statuses.length - 1)];
        polls += 1;
        if (s === null) throw new Error('offline');
        return { ok: true, json: async () => s };
      }
    });
    vm.runInContext(`${fnSrc}\nthis.f = awaitDashboardWrapFailure;`, ctx);
    const answer = await ctx.f('demo', 'r1');
    return { answer, polls };
  }

  it('the confirm handler waits on the run the 202 names before closing', () => {
    const body = functionBody(landing, 'async function confirmWrap()');
    assert.ok(body.indexOf('awaitDashboardWrapFailure(') < body.indexOf('closeWrapModal(true)'));
  });

  it('polls through a running run and a failed poll, and closes on a report', async () => {
    const out = await drive([
      { runId: 'r1', running: true },
      null,
      { runId: 'r1', running: false, result: { ok: false, pipelineResult: { blockedAt: 'test' } } }
    ]);
    assert.equal(out.answer, null, 'a blocked report lives on the session page; the modal closes');
    assert.equal(out.polls, 3);
  });

  it('names the error of a run that failed without a report', async () => {
    const out = await drive([{ runId: 'r1', running: false, result: { ok: false, error: 'wrap pipeline threw: boom' } }]);
    assert.equal(out.answer, 'wrap pipeline threw: boom');
  });

  it('a stalled run is unknown, not dead; a run the server no longer holds is a restart', async () => {
    assert.match((await drive([{ runId: 'r1', running: false, stale: true, result: null }])).answer, /stopped reporting/);
    assert.match((await drive([{ runId: null, running: false, result: null }])).answer, /server restart/);
    assert.match((await drive([{ runId: 'other', running: true, result: null }])).answer, /server restart/);
  });
});
