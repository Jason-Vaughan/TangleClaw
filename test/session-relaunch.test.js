'use strict';

/*
 * #1637 — Restart Session on the ended bar. These pin the contract of the pure
 * module (`public/session-relaunch.js`): when the action is offered, what one
 * press sends, and what each kind of answer does to the button. The launch
 * itself is the canonical route's, so what is tested here is that this page
 * never adds a second request, never guesses, and never routes around a gate.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../public/session-relaunch.js');

/**
 * A status body for an established absence whose newest session has `status`.
 * @param {string} status - The last session's lifecycle status.
 * @returns {object}
 */
function ended(status) {
  return {
    active: false,
    project: 'proj',
    incomplete: [],
    cause: null,
    lastSession: { sessionId: 9, status, endedAt: '2026-09-26T00:00:00Z', durationSeconds: 60, wrapSummary: null }
  };
}

/**
 * A controller wired to recording fakes.
 * @param {object} [opts]
 * @param {(body: object) => Promise<object>} [opts.launch] - The launch fake; defaults to a 201.
 * @param {() => Promise<(object|null)>} [opts.readStatus] - The status fake.
 * @param {string} [opts.project]
 * @returns {{c: object, calls: {launches: object[], reads: number, navigations: string[], views: object[]}}}
 */
function harness(opts) {
  const o = opts || {};
  const calls = { launches: [], reads: 0, navigations: [], views: [] };
  const c = R.createRelaunchController({
    project: o.project || 'proj',
    launch: async (body) => {
      calls.launches.push(body);
      return o.launch ? o.launch(body) : { ok: true, data: { sessionId: 10 } };
    },
    readStatus: async () => {
      calls.reads++;
      return o.readStatus ? o.readStatus() : null;
    },
    navigate: (url) => { calls.navigations.push(url); },
    render: (view) => { calls.views.push(view); }
  });
  return { c, calls };
}

/** @returns {object} The last view painted. */
function lastView(calls) {
  return calls.views[calls.views.length - 1];
}

/**
 * A refusal as `launchResultFromApi` reports it.
 * @param {string|null} code
 * @param {string|null} error
 * @returns {object}
 */
function refused(code, error) {
  return { ok: false, code, error };
}

describe('#1637 relaunchEligibility — offered only for a wrapped, ended session', () => {
  it('is eligible when tmux confirmed absence and the newest session wrapped', () => {
    assert.deepEqual(R.relaunchEligibility(ended('wrapped')), { eligible: true, reason: 'wrapped' });
  });

  for (const status of ['killed', 'crashed', 'active']) {
    it(`is not eligible when the newest session is ${status}`, () => {
      const v = R.relaunchEligibility(ended(status));
      assert.equal(v.eligible, false);
      assert.equal(v.reason, `last-session-${status}`);
    });
  }

  it('is not eligible while a session is active', () => {
    assert.equal(R.relaunchEligibility({ active: true, lastSession: { status: 'wrapped' } }).eligible, false);
  });

  it('is not eligible on unknown liveness, even when the last row says wrapped', () => {
    // The status route answers `active: null` when tmux would not say, and still
    // includes lastSession. A wrapped row there is history, not proof of absence.
    const s = { ...ended('wrapped'), active: null, incomplete: ['active'] };
    assert.deepEqual(R.relaunchEligibility(s), { eligible: false, reason: 'liveness-unknown' });
  });

  it('is not eligible when liveness is missing entirely', () => {
    const s = ended('wrapped');
    delete s.active;
    assert.equal(R.relaunchEligibility(s).eligible, false);
  });

  it('is not eligible while a wrap is still running', () => {
    assert.equal(R.relaunchEligibility({ ...ended('wrapped'), wrapping: true }).reason, 'wrapping');
  });

  it('is not eligible for an untracked live pane', () => {
    assert.equal(R.relaunchEligibility({ ...ended('wrapped'), untracked: true }).reason, 'untracked');
  });

  it('is not eligible without a last session, or without a status read', () => {
    assert.equal(R.relaunchEligibility({ ...ended('wrapped'), lastSession: null }).reason, 'no-last-session');
    assert.equal(R.relaunchEligibility(null).reason, 'no-status');
    assert.equal(R.relaunchEligibility(undefined).reason, 'no-status');
  });
});

describe('#1637 the request — continue, with the project defaults', () => {
  it('sends continuityMode "continue" and nothing that overrides the project defaults', () => {
    const body = R.relaunchRequestBody();
    assert.deepEqual(Object.keys(body), ['continuityMode']);
    assert.equal(body.continuityMode, 'continue');
    for (const k of ['launchMode', 'engineOverride', 'mode', 'acknowledgeStranded', 'force']) {
      assert.equal(k in body, false, `${k} must not be sent`);
    }
  });

  it('builds the canonical session URL, encoded, with the launch grace only when asked', () => {
    assert.equal(R.sessionUrl('My Proj'), '/session/My%20Proj');
    assert.equal(R.sessionUrl('My Proj', { launched: true }), '/session/My%20Proj?launched=1');
  });
});

describe('#1637 classifyLaunchFailure', () => {
  it('sorts every refusal the launch route can give', () => {
    const table = {
      CONTROL_STOPPED: 'retryable',
      CONTROL_HELD: 'retryable',
      CONTROL_STATE_UNAVAILABLE: 'retryable',
      NOT_FOUND: 'retryable',
      BAD_REQUEST: 'retryable',
      UNAUTHENTICATED: 'retryable',
      ACCOUNT_REQUIRED: 'retryable',
      CSRF_TOKEN_INVALID: 'retryable',
      STRANDED_WRAPS: 'needs-landing',
      TUNNEL_CONFLICT: 'needs-landing',
      LIVENESS_UNKNOWN: 'liveness-unknown',
      CONFLICT: 'uncertain',
      ORPHANED_LAUNCH: 'uncertain',
      LAUNCH_BIND_FAILED: 'uncertain',
      INTERNAL_ERROR: 'uncertain'
    };
    for (const [code, kind] of Object.entries(table)) {
      assert.equal(R.classifyLaunchFailure(code), kind, code);
    }
  });

  it('treats no answer, and any code it does not know, as uncertain', () => {
    assert.equal(R.classifyLaunchFailure(null), 'uncertain');
    assert.equal(R.classifyLaunchFailure(undefined), 'uncertain');
    assert.equal(R.classifyLaunchFailure('SOMETHING_NEW'), 'uncertain');
  });
});

describe('#1637 launchResultFromApi', () => {
  it('reads a body as success', () => {
    assert.deepEqual(R.launchResultFromApi({ sessionId: 3 }, { lastErrorCode: 'STALE' }), { ok: true, data: { sessionId: 3 } });
  });

  it('reads a structured refusal from the api side channel', () => {
    assert.deepEqual(R.launchResultFromApi(null, { lastErrorCode: 'CONTROL_STOPPED', lastError: 'Stopped by PM' }),
      { ok: false, code: 'CONTROL_STOPPED', error: 'Stopped by PM' });
  });

  it('reads a lost connection as no code', () => {
    assert.deepEqual(R.launchResultFromApi(null, { lastErrorCode: null, lastError: 'Connection lost.' }),
      { ok: false, code: null, error: 'Connection lost.' });
  });
});

describe('#1637 controller — one press, at most one launch', () => {
  it('sends exactly one request with continuityMode "continue" under rapid repeated presses', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { c, calls } = harness({ launch: async () => { await gate; return { ok: true, data: {} }; } });

    const first = c.activate();
    // Double click, then Enter, while the first request is in flight.
    assert.equal(await c.activate(), 'ignored');
    assert.equal(await c.activate(), 'ignored');
    release();
    await first;

    assert.equal(calls.launches.length, 1);
    assert.deepEqual(calls.launches[0], { continuityMode: 'continue' });
  });

  it('latches and paints Restarting… before the request resolves', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { c, calls } = harness({ launch: async () => { await gate; return { ok: true, data: {} }; } });

    const p = c.activate();
    assert.equal(c.phase(), 'launching');
    assert.equal(calls.views[0].label, 'Restarting…');
    assert.equal(calls.views[0].disabled, true);
    release();
    await p;
  });

  it('navigates to the session with the launch grace on success, and ignores presses after', async () => {
    const { c, calls } = harness({ project: 'My Proj' });

    assert.equal(await c.activate(), 'navigating');
    assert.deepEqual(calls.navigations, ['/session/My%20Proj?launched=1']);
    assert.equal(await c.activate(), 'ignored');
    assert.equal(calls.launches.length, 1);
  });
});

describe('#1637 controller — refusals are shown, never routed around', () => {
  it('shows a STOP by name and restores the button; nothing is retried on its own', async () => {
    const { c, calls } = harness({ launch: async () => refused('CONTROL_STOPPED', 'Lane is STOPPED by the PM') });

    assert.equal(await c.activate(), 'ready');
    const v = lastView(calls);
    assert.equal(v.label, 'Restart Session');
    assert.equal(v.disabled, false);
    assert.match(v.message, /STOPPED by the PM/);
    assert.equal(v.tone, 'error');
    assert.equal(calls.launches.length, 1);
    assert.equal(calls.reads, 0, 'a refusal is an answer; there is nothing to reconcile');
    assert.deepEqual(calls.navigations, []);
  });

  it('lets the operator retry explicitly after a retryable refusal — one request per press', async () => {
    let n = 0;
    const { c, calls } = harness({
      launch: async () => (++n === 1 ? refused('CONTROL_STATE_UNAVAILABLE', 'Control state unreadable') : { ok: true, data: {} })
    });

    await c.activate();
    await c.activate();
    assert.equal(calls.launches.length, 2);
    assert.deepEqual(calls.navigations, ['/session/proj?launched=1']);
  });

  it('never acknowledges stranded wraps: it points to Back to Projects and stays disabled', async () => {
    const { c, calls } = harness({ launch: async () => refused('STRANDED_WRAPS', '2 stranded wraps need a decision') });

    assert.equal(await c.activate(), 'blocked');
    const v = lastView(calls);
    assert.equal(v.disabled, true);
    assert.equal(v.pointToLanding, true);
    assert.match(v.message, /2 stranded wraps/);
    assert.match(v.message, /Back to Projects/);
    assert.equal(await c.activate(), 'ignored');
    assert.equal(calls.launches.length, 1);
    assert.equal('acknowledgeStranded' in calls.launches[0], false);
  });

  it('holds on unknown liveness instead of guessing', async () => {
    const { c, calls } = harness({ launch: async () => refused('LIVENESS_UNKNOWN', 'tmux did not answer') });

    assert.equal(await c.activate(), 'blocked');
    assert.equal(lastView(calls).disabled, true);
    assert.match(lastView(calls).message, /tmux did not answer/);
    assert.equal(calls.reads, 0);
    assert.equal(await c.activate(), 'ignored');
    assert.equal(calls.launches.length, 1);
  });
});

describe('#1637 controller — an ambiguous outcome is read, never re-sent', () => {
  it('opens the session when a lost response turns out to have launched one', async () => {
    const { c, calls } = harness({
      launch: async () => refused(null, 'Connection lost.'),
      readStatus: async () => ({ active: true, sessionId: 11 })
    });

    assert.equal(await c.activate(), 'navigating');
    assert.equal(calls.launches.length, 1);
    assert.equal(calls.reads, 1);
    // Already running, so no launch grace is claimed for it.
    assert.deepEqual(calls.navigations, ['/session/proj']);
  });

  it('opens, and never replaces, a session that was already active (409 CONFLICT)', async () => {
    const { c, calls } = harness({
      launch: async () => refused('CONFLICT', 'Session already active'),
      readStatus: async () => ({ active: true })
    });

    await c.activate();
    assert.equal(calls.launches.length, 1);
    assert.deepEqual(calls.navigations, ['/session/proj']);
  });

  it('permits an explicit retry when absence is established after an orphaned launch', async () => {
    const { c, calls } = harness({
      launch: async () => refused('ORPHANED_LAUNCH', 'The pane started but the session was not recorded'),
      readStatus: async () => ended('wrapped')
    });

    assert.equal(await c.activate(), 'ready');
    assert.equal(calls.launches.length, 1, 'no automatic second POST');
    const v = lastView(calls);
    assert.equal(v.disabled, false);
    assert.match(v.message, /not recorded/);
    assert.match(v.message, /try again/);
  });

  it('stays disabled when the reconcile read cannot establish liveness', async () => {
    const { c, calls } = harness({
      launch: async () => refused(null, 'Connection lost.'),
      readStatus: async () => ({ active: null, incomplete: ['active'] })
    });

    assert.equal(await c.activate(), 'blocked');
    assert.equal(lastView(calls).disabled, true);
    assert.match(lastView(calls).message, /Could not confirm/);
    assert.equal(await c.activate(), 'ignored');
    assert.equal(calls.launches.length, 1);
  });

  it('stays disabled when the reconcile read itself fails or throws', async () => {
    for (const readStatus of [async () => null, async () => { throw new Error('boom'); }]) {
      const { c, calls } = harness({ launch: async () => refused('INTERNAL_ERROR', 'Internal error'), readStatus });
      assert.equal(await c.activate(), 'blocked');
      assert.equal(calls.launches.length, 1);
      assert.deepEqual(calls.navigations, []);
    }
  });

  it('treats a thrown launch as an unanswered one and reconciles', async () => {
    const { c, calls } = harness({
      launch: async () => { throw new Error('network'); },
      readStatus: async () => ended('wrapped')
    });

    assert.equal(await c.activate(), 'ready');
    assert.equal(calls.launches.length, 1);
    assert.equal(calls.reads, 1);
  });

  it('paints Checking… while it reads', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { c, calls } = harness({
      launch: async () => refused(null, null),
      readStatus: async () => { await gate; return ended('wrapped'); }
    });

    const p = c.activate();
    await new Promise((r) => setImmediate(r));
    assert.equal(c.phase(), 'reconciling');
    assert.equal(lastView(calls).label, 'Checking…');
    assert.equal(lastView(calls).disabled, true);
    assert.equal(await c.activate(), 'ignored');
    release();
    await p;
    assert.equal(calls.launches.length, 1);
  });
});
