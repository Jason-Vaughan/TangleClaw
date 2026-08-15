'use strict';

/*
 * #907 — an unreachable pane is not a busy pane.
 *
 * `getSessionStatus`'s ACTIVE branch returned `idle: false, lastOutputAge: 0`
 * when the liveness probe did not answer. Those two together are the reading
 * for a pane that just produced output, so a wedged tmux (#94/#144/#380) made
 * a session report as busy when the truth was that nobody could see it — and
 * the session page reads `idle` as its wrap-completion signal, so it is a wrong
 * answer to the exact question the page is asking.
 *
 * #908 already settled this on the WRAPPING branch, which returns nulls with
 * `incomplete: ['idle','lastOutputAge']`. These guards hold the active branch
 * (and the untracked branch below it, which no issue named) to the same rule.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const tmux = require('../lib/tmux');

let tmpDir;
let sessions;
let projectsDir;
let projectId;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-status-unknown-'));
  store._setBasePath(tmpDir);
  store.init();
  sessions = require('../lib/sessions');
  projectsDir = path.join(tmpDir, 'projects');
  const projDir = path.join(projectsDir, 'unknown-status');
  fs.mkdirSync(projDir, { recursive: true });
  projectId = store.projects.create({
    name: 'unknown-status', path: projDir, engine: 'claude'
  }).id;
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run `fn` with `tmux.probeSession` answering `verdict`.
 *
 * The verdict is injected because the subject is what the BRANCH does with it.
 * That a killed probe really does report `answered: false` is pinned in
 * `test/tmux.test.js` against a real stalling `tmux` — the one place a stub
 * would be free to lie.
 *
 * @param {object} verdict - `{live, answered, cause}`.
 * @param {Function} fn - Test body.
 * @returns {any}
 */
function withProbe(verdict, fn) {
  const real = tmux.probeSession;
  tmux.probeSession = () => verdict;
  try {
    return fn();
  } finally {
    tmux.probeSession = real;
  }
}

const UNREACHABLE = { live: false, answered: false, cause: 'read-timed-out' };
const ALIVE = { live: true, answered: true, cause: null };
const GONE = { live: false, answered: true, cause: null };

describe('an active session whose pane could not be reached (#907)', () => {
  it('reports idle and lastOutputAge as unknown, not as fresh output', () => {
    // THE MUTATION THIS CATCHES: `let idle = false; let lastOutputAge = 0;`
    // unconditionally — which is what shipped, and is the reading for a pane
    // that JUST produced output. It does not merely lose information, it points
    // the wrong way: it says busy when the truth is unseen.
    const session = store.sessions.start({
      projectId, engineId: 'claude', tmuxSession: 'tc-unknown-active'
    });
    try {
      const status = withProbe(UNREACHABLE,
        () => sessions.getSessionStatus('unknown-status'));

      assert.equal(status.active, true, 'the ROW still says active, and that much is known');
      assert.equal(status.idle, null, 'nothing was measured, so nothing may be reported');
      assert.equal(status.lastOutputAge, null);
      assert.deepEqual(status.incomplete, ['idle', 'lastOutputAge'],
        'and both have to be NAMED, or null is indistinguishable from a missing field');
      assert.equal(status.cause, 'read-timed-out');
    } finally {
      store.sessions.kill(session.id, 'test cleanup');
    }
  });

  it('carries an empty incomplete on the healthy path rather than omitting it', () => {
    // THE MUTATION THIS CATCHES: emitting `incomplete` only when something went
    // wrong. A field that appears only on failure makes every consumer probe
    // for its existence instead of reading its value.
    const session = store.sessions.start({
      projectId, engineId: 'claude', tmuxSession: 'tc-unknown-live'
    });
    try {
      const status = withProbe(ALIVE, () => sessions.getSessionStatus('unknown-status'));

      assert.deepEqual(status.incomplete, []);
      assert.equal(status.cause, null);
      assert.notEqual(status.idle, null,
        'a REACHED pane produces a real reading — this must not become "always unknown"');
    } finally {
      store.sessions.kill(session.id, 'test cleanup');
    }
  });

  it('still records a crash when tmux answered that the pane is gone', () => {
    // The half that keeps the fix from becoming a blanket "never conclude
    // anything": an observed death is still observed.
    const session = store.sessions.start({
      projectId, engineId: 'claude', tmuxSession: 'tc-unknown-dead'
    });
    try {
      withProbe(GONE, () => sessions.getSessionStatus('unknown-status'));
      assert.equal(store.sessions.get(session.id).status, 'crashed');
    } finally {
      if (store.sessions.get(session.id).status === 'active') {
        store.sessions.kill(session.id, 'test cleanup');
      }
    }
  });
});

describe('an UNTRACKED session is not erased by a tmux that would not answer', () => {
  // No issue named this branch. `getSessionStatus` falls back to asking tmux
  // directly when there is no DB row, and it asked with `hasSession` — whose
  // false means both "no such pane" and "tmux is wedged". The code below it
  // states an absence, so a wedge made an untracked-but-running session vanish
  // from this route entirely. Found while fixing #905/#907, which is the same
  // defect one branch up.

  it('says the liveness is unknown rather than reporting no session', () => {
    // THE MUTATION THIS CATCHES: leaving this branch on `tmux.hasSession`.
    // The route then answers `active: false` — a definite absence — for a
    // machine whose tmux never replied.
    const status = withProbe(UNREACHABLE,
      () => sessions.getSessionStatus('unknown-status'));

    assert.equal(status.active, null,
      'neither "a session is running" nor "there is none" was established');
    assert.deepEqual(status.incomplete, ['active']);
    assert.equal(status.cause, 'read-timed-out');
  });

  it('does not claim a measured idle for a pane it never measured', () => {
    // THE MUTATION THIS CATCHES: the `idle: false, lastOutputAge: 0` this
    // branch used to return unconditionally. It has no DB row to date from and
    // never calls `detectIdle`, so those were the fresh-output reading asserted
    // on the strength of nothing at all — the same defect as the active branch,
    // reached even when tmux answers perfectly.
    const status = withProbe(ALIVE, () => sessions.getSessionStatus('unknown-status'));

    assert.equal(status.untracked, true, 'precondition: this is the untracked branch');
    assert.equal(status.active, true);
    assert.equal(status.idle, null);
    assert.equal(status.lastOutputAge, null);
    assert.deepEqual(status.incomplete, ['idle', 'lastOutputAge']);
  });

  it('still reports a plain absence when tmux answered that nothing is there', () => {
    const status = withProbe(GONE, () => sessions.getSessionStatus('unknown-status'));
    assert.equal(status.active, false, 'an ANSWERED absence is a real false');
    assert.equal(status.untracked, undefined);
  });
});

describe('every answer this route gives carries the incomplete contract', () => {
  // `api-contract.md` states that `incomplete` is present on EVERY answer, `[]`
  // on the healthy ones — the whole point being that a consumer reads its value
  // instead of probing for the field. A sentence in an artifact does not make
  // that true; three branches had no `incomplete` at all when the sentence was
  // first written. This walks every reachable shape so the artifact and the code
  // cannot drift apart silently.

  /**
   * Drive one branch and return its payload.
   * @param {Function} setup - Arranges DB state; returns a cleanup function.
   * @param {object|null} verdict - Probe verdict, or null to leave the real one.
   * @returns {object} The status payload.
   */
  function branch(setup, verdict) {
    const cleanup = setup();
    try {
      return verdict
        ? withProbe(verdict, () => sessions.getSessionStatus('unknown-status'))
        : sessions.getSessionStatus('unknown-status');
    } finally {
      cleanup();
    }
  }

  /**
   * Start a tmux-backed session and return its cleanup.
   * @param {string} name - tmux session name.
   * @returns {Function} Cleanup.
   */
  const withSession = (name) => () => {
    const s = store.sessions.start({ projectId, engineId: 'claude', tmuxSession: name });
    return () => {
      if (store.sessions.get(s.id).status === 'active') {
        store.sessions.kill(s.id, 'test cleanup');
      }
    };
  };

  const cases = [
    ['active + reachable', withSession('tc-contract-live'), ALIVE],
    ['active + unreachable', withSession('tc-contract-wedge'), UNREACHABLE],
    ['untracked + reachable', () => () => {}, ALIVE],
    ['untracked + unreachable', () => () => {}, UNREACHABLE],
    ['no session at all', () => () => {}, GONE]
  ];

  for (const [label, setup, verdict] of cases) {
    it(`carries incomplete and cause on: ${label}`, () => {
      const status = branch(setup, verdict);
      assert.ok(Array.isArray(status.incomplete),
        `${label}: incomplete must be an array, never absent — a field that appears only on `
        + 'failure makes every consumer probe for its existence');
      assert.ok('cause' in status, `${label}: cause must be present`);
    });
  }

  it('covers the webui branch, which has no pane and so nothing that went short', () => {
    // Deliberately `incomplete: []` with `idle: false` left standing. A webui
    // session has no terminal, so terminal-idle is not a reading this branch
    // failed to take — it is a question that does not apply, and `false` is the
    // webui subsystem's own answer rather than a wedged tmux's. Widening
    // `incomplete` to mean "not applicable" as well as "could not establish"
    // would blur the one distinction this whole family exists to draw.
    const s = store.sessions.start({
      projectId, engineId: 'openclaw:x', tmuxSession: null, sessionMode: 'webui'
    });
    try {
      const status = sessions.getSessionStatus('unknown-status');
      assert.equal(status.sessionMode, 'webui', 'precondition: this is the webui branch');
      assert.deepEqual(status.incomplete, [],
        'nothing was attempted and failed here, so nothing is incomplete');
      assert.ok('cause' in status, 'the field is still present, so consumers read rather than probe');
    } finally {
      if (store.sessions.get(s.id).status === 'active') {
        store.sessions.kill(s.id, 'test cleanup');
      }
    }
  });
});

describe('the session page must not declare an end the server refused to declare', () => {
  // Critic R-2/R-20, reached independently by two reviewers. `handleSessionEnded`
  // is terminal — it stops polling, disables Wrap/Kill/Command, shows the ended
  // bar and starts a redirect — and the page reached it through `!data.active`.
  // With the untracked branch now answering `active: null` during a wedge, the
  // page would assert the session had ended and, because it stops polling, could
  // never recover when tmux came back.
  //
  // This is the one place "null is falsy, so consumers behave as before"
  // INVERTS. For `idle`, behaving as before is inertia. For `active`, it is a
  // definite, irreversible, operator-visible action on a read that established
  // nothing — which is the defect this whole bundle removes, reached through
  // the consumer instead of the payload.
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'session.js'), 'utf8');

  it('ends the session only on an ANSWERED absence', () => {
    // THE MUTATION THIS CATCHES: `if (!data.active && ...)`, which is what
    // shipped before this fix and what every earlier version of the page did.
    assert.match(SRC, /if \(data\.active === false && !data\.wrapping && !sessionState\.ended\)/,
      'a falsy check here turns an unestablished liveness into a terminal end');
    assert.doesNotMatch(SRC, /if \(!data\.active && !data\.wrapping/,
      'the falsy form must be gone, not merely shadowed by a second branch');
  });

  it('and the server really does emit the null this guards against', () => {
    // The pairing that makes the guard above mean something: a pin on the page
    // proves nothing if the payload can never carry the value it pins. This is
    // the caller-shape check the plan names — the branch is reached the way the
    // route reaches it, not through a hand-built fixture.
    const status = withProbe(UNREACHABLE,
      () => sessions.getSessionStatus('unknown-status'));
    assert.equal(status.active, null,
      'the page guard is dead code unless this branch really answers null');
  });

  it('keeps the last-session summary, which tmux could not have affected', () => {
    // Critic R-18. `lastSession` is a database read; a wedged tmux cannot touch
    // it, and the fall-through this branch replaced did return it. A branch
    // whose purpose is "report only what was established" must not discard
    // something that WAS — that is the same error pointing the other way.
    const s = store.sessions.start({
      projectId, engineId: 'claude', tmuxSession: 'tc-lastsession-probe'
    });
    store.sessions.kill(s.id, 'ended for this fixture');

    const status = withProbe(UNREACHABLE,
      () => sessions.getSessionStatus('unknown-status'));

    assert.equal(status.active, null, 'precondition: the unknown-untracked branch');
    // Compared against what the store itself answers rather than against the
    // row this test happened to create: `getLatest` picks by its own ordering,
    // and the claim being made here is "the database read survives", not "this
    // fixture's id comes back".
    const expected = store.sessions.getLatest(projectId);
    assert.ok(expected, 'precondition: the store has an ended session to report');
    assert.ok(status.lastSession,
      'the database answered, so its answer must survive a tmux that did not');
    assert.equal(status.lastSession.sessionId, expected.id);
  });
});

describe('the invariant the session page depends on', () => {
  // The chime and the wrap-idle modal both branch on `data.idle` being truthy,
  // and both are consequential — one dings, the other opens the modal that
  // finalizes a wrap. They are safe on an unknown because `null` is falsy, and
  // that is only safe as long as the SERVER never emits a truthy `idle`
  // alongside an `incomplete` that names it. That is the real contract, so it
  // is what gets pinned; asserting the page's source text instead would pin the
  // spelling of a branch rather than the property that makes it correct.
  it('never reports a truthy idle for a reading it declined to make', () => {
    const session = store.sessions.start({
      projectId, engineId: 'claude', tmuxSession: 'tc-unknown-invariant'
    });
    try {
      for (const verdict of [UNREACHABLE, ALIVE, GONE]) {
        const status = withProbe(verdict, () => sessions.getSessionStatus('unknown-status'));
        if (status && Array.isArray(status.incomplete) && status.incomplete.includes('idle')) {
          assert.ok(!status.idle,
            'a payload that names idle as unestablished must not also carry a truthy idle — '
            + 'the page would ding, or open the wrap modal, on a reading nobody made');
        }
      }
    } finally {
      if (store.sessions.get(session.id).status === 'active') {
        store.sessions.kill(session.id, 'test cleanup');
      }
    }
  });

  // Structural pin, and labelled as one: `poll()` is a long inline function in
  // a 4k-line file with no seam to lift it through, so this is a floor rather
  // than proof of execution. It catches the specific regression that would slip
  // past the invariant above — a consumer rewriting the guard into something
  // null passes, e.g. `data.idle !== false`.
  it('pins the page to reading the tri-state directly (structural)', () => {
    const SRC = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    assert.match(SRC, /if \(data\.active && data\.idle\)/,
      'the chime must read the value, so null cannot ding');
    assert.match(SRC, /if \(data\.wrapping && data\.idle && !sessionState\.ended\)/,
      'an unmeasured idle must not open the modal that finalizes a wrap');
  });
});
