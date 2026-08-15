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
