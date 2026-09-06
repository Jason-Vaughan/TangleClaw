'use strict';

/*
 * #910 — the session page finalizes a finished wrap; the status read does not.
 *
 * `getSessionStatus` is a read, and this page polls it every two seconds
 * throughout a wrap. Its dead-tmux branch used to call `autoCompleteWrap`, which
 * writes the wrap complete, tears down the Medusa listener, and runs a real
 * `git commit` in the operator's repository — so reading a status wrote to the
 * operator's git history, and nothing about the request said mutate.
 *
 * The server now reports `wrapFinished` and changes nothing, which moves the
 * finalizing to this page: the same explicit POST the wrap-idle modal already
 * uses. That makes the CLIENT half load-bearing — it is the replacement for a
 * server-side action that was deleted — so it is tested here rather than left to
 * the server tests, which can no longer see it.
 *
 * The real functions are lifted out of `public/session.js` and run in a sandbox,
 * so these exercise the shipped code rather than a copy of it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSION_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'session.js'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text by
 * brace-matching, so the sandbox runs the REAL code rather than a copy.
 *
 * @param {string} decl - Declaration to find.
 * @returns {string} The declaration plus its balanced body.
 */
function lift(decl) {
  const start = SESSION_SRC.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = SESSION_SRC.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < SESSION_SRC.length; i++) {
    if (SESSION_SRC[i] === '{') depth++;
    else if (SESSION_SRC[i] === '}' && --depth === 0) return SESSION_SRC.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/** A DOM stub that records nothing but never throws — `handleWrapCompleted` touches many nodes. */
function stubElement() {
  const el = {
    classList: { add() {}, remove() {}, contains: () => false },
    style: {},
    disabled: false,
    textContent: '',
    className: '',
    appendChild() {},
    addEventListener() {}
  };
  return el;
}

/**
 * Build a sandbox holding the REAL `finalizeFinishedWrap` and a recording
 * `apiMutate`.
 *
 * @param {{post?: *, lastError?: string}} [replies] - What the POST returns.
 * @returns {object} The sandbox, with `calls` attached.
 */
function loadFinalizer(replies) {
  const r = replies || {};
  const calls = { posts: [], completed: [], toasts: [] };

  const api = {};
  api.lastError = r.lastError || null;

  const toast = stubElement();
  const sandbox = {
    console,
    setTimeout: () => 0,
    projectName: 'proj',
    api,
    apiMutate: async (url, method, body) => {
      calls.posts.push({ url, method, body });
      return Object.prototype.hasOwnProperty.call(r, 'post') ? r.post : { ok: true, session: { id: 7 } };
    },
    // Stubbed rather than lifted: it is a DOM painter, and what this file is
    // about is whether the finalize is REQUESTED and its outcome honoured.
    // Takes no argument by design — it paints a fixed terminal state — so what is
    // recorded is THAT it was called, which is the property under test.
    handleWrapCompleted: () => { calls.completed.push(true); },
    document: {
      getElementById: (id) => (id === 'toast' ? toast : stubElement())
    }
  };
  sandbox.sessionState = { ended: false, wrapping: true, wrapCompleting: false };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    lift('async function finalizeFinishedWrap(sessionId)'),
    'globalThis.finalizeFinishedWrap = finalizeFinishedWrap;'
  ].join('\n'), sandbox);
  sandbox.calls = calls;
  sandbox.toast = toast;
  return sandbox;
}

describe('#910 — the page asks for the finalize the status read no longer performs', () => {
  it('POSTs wrap/complete and hands the result to the completion painter', async () => {
    const s = loadFinalizer();

    await s.finalizeFinishedWrap(42);

    assert.equal(s.calls.posts.length, 1, 'exactly one finalize request');
    assert.equal(s.calls.posts[0].url, '/api/sessions/proj/wrap/complete');
    assert.equal(s.calls.posts[0].method, 'POST');
    // Property-wise, not `deepEqual`: the body is constructed inside the vm
    // sandbox, so it carries that realm's Object.prototype and compares unequal
    // to a literal built out here regardless of its contents.
    assert.equal(s.calls.posts[0].body.sessionId, 42,
      'the observed session is named, so a relaunch between poll and POST cannot receive this finalize');
    assert.equal(s.calls.completed.length, 1, 'the wrap is painted as completed');
  });

  it('sets wrapCompleting BEFORE awaiting, so a second poll cannot fire a second POST', async () => {
    // The poll runs every two seconds and the POST is not instant. Setting the
    // flag after the await would leave a window in which two finalizes race for
    // the same session — each of which kills tmux and commits the repository.
    const s = loadFinalizer();
    let flagDuringRequest = null;
    s.apiMutate = async () => {
      flagDuringRequest = s.sessionState.wrapCompleting;
      return { ok: true };
    };

    await s.finalizeFinishedWrap();

    assert.equal(flagDuringRequest, true, 'the guard must be set before the request is issued');
  });

  it('reports a failed finalize and does NOT paint the wrap as completed', async () => {
    // Painting completion on a finalize that did not land would tell the
    // operator their session was recorded when it was not — the same
    // report-success-while-broken shape this whole train is about.
    const s = loadFinalizer({ post: null, lastError: 'server said no' });

    await s.finalizeFinishedWrap();

    assert.equal(s.calls.completed.length, 0, 'nothing is painted as completed');
    assert.match(s.toast.textContent, /server said no/);
    assert.match(s.toast.className, /toast-warn/);
  });

  it('omits the session id when the server did not report one', async () => {
    // An older server that sends `wrapFinished` without `sessionId` must still be
    // finalizable; the identity check is an improvement for callers that CAN name
    // the session, never a new way for the others to fail.
    const s = loadFinalizer();

    await s.finalizeFinishedWrap(undefined);

    assert.deepEqual(Object.keys(s.calls.posts[0].body), [],
      'an empty body, exactly as before the identity check existed');
  });

  it('does not retry in a loop after a failure — the launch path recovers the row', async () => {
    // `wrapCompleting` stays set on the failure path, so the next poll's
    // `!sessionState.wrapCompleting` guard declines to fire again. Nothing is
    // lost by stopping: the session stays `active`, so Kill still reaches it.
    //
    // This whole file guards a client path the server can no longer trigger —
    // `GET /status` stopped sending `wrapFinished` with #1034. Kept until the
    // branches it covers are removed together (#1302); retiring it first would
    // leave that code unguarded while it is still shipped.
    const s = loadFinalizer({ post: null });

    await s.finalizeFinishedWrap();

    assert.equal(s.sessionState.wrapCompleting, true,
      'the guard stays set, so the two-second poll does not retry forever');
  });
});

describe('#910 — the poll branch that reaches the finalizer', () => {
  // Asserted against the source rather than by running `pollStatus`, which
  // touches far more of the page than this property needs. The point is that
  // the branch exists, is guarded, and precedes nothing that would swallow it.
  it('fires only when not already ended and not already finalizing', () => {
    assert.match(SESSION_SRC,
      /if \(data\.wrapFinished && !sessionState\.ended && !sessionState\.wrapCompleting\) \{\s*finalizeFinishedWrap\(data\.sessionId\);/,
      'the wrapFinished branch must guard on both flags before calling the finalizer');
  });

  it('still honours wrapCompleted, so a server that has not been restarted keeps working', () => {
    // The old field is what a server still running pre-#910 code sends. Both
    // mean the same thing to this page; only who finalizes differs.
    assert.match(SESSION_SRC, /if \(data\.wrapCompleted && !sessionState\.ended\) \{/);
  });
});
