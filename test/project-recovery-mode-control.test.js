'use strict';

/**
 * The Launch readiness panel's recovery-mode control, against the real routes
 * (#1937).
 *
 * The panel decides three things from what the server tells it: whether to
 * offer the control at all, what a save is told, and what a held launch row
 * says once the project's mode has changed under it. Each is held here against
 * `server.js#handleRequest`, with the panel's own functions lifted from
 * `public/ui.js`, so the page and the routes cannot drift apart unnoticed.
 *
 * The login gate states come from `GATE_STATES`: a state added later fails
 * here until it has a row.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const authGate = require('../lib/auth-gate');
const gateFallback = require('../lib/gate-fallback');
const launchSequence = require('../lib/launch-sequence');
const projects = require('../lib/projects');
const { handleRequest } = require('../server');
const fixture = require('./_recovery-fixture');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

/**
 * Slice a top-level declaration out of source text by brace-matching, so the
 * sandbox runs the real code and not a copy.
 * @param {string} src - File source text
 * @param {string} decl - Declaration to find
 * @returns {string} The declaration plus its balanced body
 */
function lift(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return assert.fail(`${decl} body must close`);
}

/**
 * The panel's decision functions, run as shipped.
 * @returns {{recoveryModeControlOffer: Function, recoveryModeSaveOutcome: Function}}
 */
function panel() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${lift(UI_SRC, 'const RECOVERY_MODE_READOUT')};\n`
    + `${lift(UI_SRC, 'function recoveryModeControlOffer')}\n${lift(UI_SRC, 'function recoveryModeSaveOutcome')}`, ctx);
  return ctx;
}

describe('the recovery-mode control against the real routes (#1937)', () => {
  const states = authGate.GATE_STATES;
  const client = fixture.makeClient(handleRequest);
  const { send, json } = client;
  let env;
  let configBytes = null;

  before(() => { env = fixture.openTempStore('tc-recovery-mode-control-'); });
  after(() => env.restore());
  beforeEach(() => fixture.resetLogin());
  afterEach(() => {
    if (configBytes !== null) {
      fs.writeFileSync(store._getConfigPath(), configBytes);
      configBytes = null;
    }
  });

  /**
   * A project with no launch.
   * @returns {object} The project record
   */
  function makeProject() {
    const name = `mode-${Math.random().toString(36).slice(2, 10)}`;
    const dir = path.join(env.projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return store.projects.create({ name, path: dir, engine: 'claude' });
  }

  /**
   * The save the panel sends: the recovery mode and nothing else.
   * @param {object} project - The project
   * @param {string} mode - The chosen mode
   * @param {object} [headers] - What the page's fetch wrapper adds for a signed-in session
   * @returns {Promise<object>} The response
   */
  function save(project, mode, headers = {}) {
    return send('PATCH', `/api/projects/${encodeURIComponent(project.name)}`,
      { body: { launchSequence: { recoveryMode: mode } }, headers });
  }

  /**
   * The project-level fields the panel reads.
   * @param {object} project - The project
   * @param {object} [headers] - Session headers, when signed in
   * @returns {Promise<object>} The body of `GET /api/launch-sequences`
   */
  async function readPanel(project, headers = {}) {
    const res = await send('GET', `/api/launch-sequences?projectId=${project.id}`, { headers });
    assert.equal(res.statusCode, 200, res.body);
    return json(res);
  }

  /**
   * How each gate state is reached from the open install every case starts on,
   * and the headers the dashboard would then carry. A page can hold a session
   * only where one can be made, so the others carry none.
   */
  const reach = {
    [states.OPEN]: async () => ({}),
    [states.ARMED]: async () => {
      client.arm();
      const { cookie, csrf } = await client.signIn();
      return { cookie, 'x-csrf-token': csrf };
    },
    [states.FALLBACK]: async () => {
      client.arm();
      const { cookie, csrf } = await client.signIn();
      gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
      return { cookie, 'x-csrf-token': csrf };
    },
    [states.ACCOUNT_REQUIRED]: async () => {
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      return {};
    },
    [states.LOCKED]: async () => {
      client.arm();
      const { cookie, csrf } = await client.signIn();
      store.getDb().prepare("UPDATE users SET disabled_at = datetime('now')").run();
      return { cookie, 'x-csrf-token': csrf };
    },
    [states.UNREADABLE]: async () => {
      configBytes = fs.readFileSync(store._getConfigPath());
      fs.writeFileSync(store._getConfigPath(), '{ this is not json');
      return {};
    }
  };

  describe('whether the control is offered, in every login gate state', () => {
    it('has a row for every login gate state', () => {
      assert.deepEqual(Object.keys(reach).sort(), Object.values(states).sort());
    });

    for (const state of Object.values(states)) {
      it(`${state}: the control is offered exactly when the route takes the page's save`, async () => {
        const project = makeProject();
        const headers = await reach[state]();
        const me = json(await send('GET', '/api/auth/me', { headers }));
        assert.equal(me.gateState, state, 'the fixture must reach the state it is named for');
        const offer = panel().recoveryModeControlOffer(me);
        const res = await save(project, 'advisory', headers);
        assert.equal(offer.offered, res.statusCode === 200,
          `${state}: offered ${offer.offered}, and the route answered ${res.statusCode} ${res.body.slice(0, 120)}`);
        const decision = store.projectRecoveryState.get(project.id);
        assert.equal(Boolean(decision && decision.pinnedAt), offer.offered,
          'a decision is on record exactly where the control was offered');
        if (!offer.offered) assert.match(offer.why, /only from a signed-in operator/);
      });
    }

    it('armed and signed out: no control, and the route refuses the same page', async () => {
      const project = makeProject();
      client.arm();
      const me = json(await send('GET', '/api/auth/me'));
      assert.equal(me.gateState, states.ARMED);
      assert.equal(panel().recoveryModeControlOffer(me).offered, false);
      const res = await save(project, 'advisory');
      assert.equal(res.statusCode, 401);
      assert.equal(store.projectRecoveryState.get(project.id), null);
    });

    it('says nobody can read a reconciliation back exactly where the readback route refuses this page', async () => {
      for (const state of Object.values(states)) {
        fixture.resetLogin();
        const { project, binding } = fixture.launchInRecovery(env, 'operator');
        const headers = await reach[state]();
        const me = json(await send('GET', '/api/auth/me', { headers }));
        const offer = panel().recoveryModeControlOffer(me);
        // The page sends everything it could hold, the open install's page
        // token included, so a refusal is about who is asking and nothing else.
        const read = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}/launch/reconciliation`, {
          body: { sessionId: binding.sessionId, sequenceId: binding.sequenceId },
          headers: { ...headers, ...(me.openInstallToken ? { 'x-tc-open-token': me.openInstallToken } : {}) }
        });
        // A caller the route accepts is told this launch has not attested,
        // which is the answer about the launch. Every other answer here is
        // about the caller or the gate.
        const acceptedAsReader = read.statusCode === 200 || json(read).code === 'NOT_ATTESTED';
        assert.equal(offer.readback === true, acceptedAsReader,
          `${state}: readback ${offer.readback}, and the read answered ${read.statusCode} ${read.body.slice(0, 120)}`);
        if (configBytes !== null) {
          fs.writeFileSync(store._getConfigPath(), configBytes);
          configBytes = null;
        }
      }
    });
  });

  // #2244. The decision used to be recorded with the caller KIND the operator
  // guard resolved, and that guard takes any request with the dashboard's shape
  // as the operator wherever the login stands down. So the record read
  // "operator" for a request that identified nobody. It now holds the proof,
  // in the words a recovery clear is recorded with.
  describe('the proof a decision is recorded with, in every login gate state (#2244)', () => {
    /**
     * What a save from the page is answered in each state, and the proof word
     * recorded where it is taken. `null` is a state whose save is refused.
     * Who is admitted is not this change's to move: the statuses here are the
     * ones the route answered before the proof word was kept.
     */
    const expected = {
      [states.OPEN]: { status: 200, proof: 'open-install-unverified' },
      [states.ARMED]: { status: 200, proof: 'operator-verified' },
      [states.FALLBACK]: { status: 200, proof: 'open-install-unverified' },
      [states.ACCOUNT_REQUIRED]: { status: 401, proof: null },
      [states.LOCKED]: { status: 401, proof: null },
      [states.UNREADABLE]: { status: 403, proof: null }
    };

    /**
     * The decision events recorded for a project.
     * @param {object} project - The project
     * @returns {object[]} Each event's detail
     */
    const decisionEvents = (project) => store.activity
      .query({ projectId: project.id, eventType: 'project.recovery-mode-decided' }).map((e) => e.detail);

    it('has a row for every login gate state', () => {
      assert.deepEqual(Object.keys(expected).sort(), Object.values(states).sort());
    });

    for (const state of Object.values(states)) {
      it(`${state}: the save is answered as before, and a decision taken is recorded with its proof`, async () => {
        const project = makeProject();
        const headers = await reach[state]();
        assert.equal(json(await send('GET', '/api/auth/me', { headers })).gateState, state,
          'the fixture must reach the state it is named for');
        const res = await save(project, 'operator', headers);
        assert.equal(res.statusCode, expected[state].status, `${state}: ${res.body.slice(0, 160)}`);
        const row = store.projectRecoveryState.get(project.id);
        if (expected[state].proof === null) {
          assert.equal(row, null, 'a refused save records no decision');
          assert.deepEqual(decisionEvents(project), []);
          return;
        }
        assert.equal(json(res).recoveryMode.decidedBy, expected[state].proof, 'the answer carries the proof word');
        assert.equal(row.pinnedBy, expected[state].proof, 'and so does the record');
        assert.notEqual(row.pinnedBy, 'operator', 'which is never the caller kind');
        assert.deepEqual(decisionEvents(project).map((d) => d.decidedBy), [expected[state].proof],
          'and the activity event');
      });
    }

    it('the read the panel renders from carries the word', async () => {
      const project = makeProject();
      assert.equal((await save(project, 'advisory')).statusCode, 200);
      assert.equal((await readPanel(project)).projectRecoveryDecision.decidedBy, 'open-install-unverified');
    });

    it('the server log line carries the word', async () => {
      const project = makeProject();
      const lines = [];
      setLevel('info');
      setConsoleStream({ write: (line) => { lines.push(String(line)); return true; } });
      try {
        assert.equal((await save(project, 'advisory')).statusCode, 200);
      } finally {
        setConsoleStream(null);
        setLevel('error');
      }
      const decided = lines.filter((line) => line.includes('Launch recovery mode decided'));
      assert.equal(decided.length, 1, lines.join(''));
      assert.match(decided[0], new RegExp(`project=${project.name} mode=advisory decidedBy=open-install-unverified`));
    });

    it('a decision made with the login off still reads unverified after the login is turned on', async () => {
      const project = makeProject();
      assert.equal((await save(project, 'advisory')).statusCode, 200);
      const headers = await reach[states.ARMED]();
      assert.equal(json(await send('GET', '/api/auth/me', { headers })).gateState, states.ARMED,
        'the login is in force now');
      assert.equal((await readPanel(project, headers)).projectRecoveryDecision.decidedBy, 'open-install-unverified',
        'and the record still says what the decision was taken on');
      // A signed-in operator deciding again replaces it, with their own proof.
      assert.equal((await save(project, 'operator', headers)).statusCode, 200);
      assert.equal((await readPanel(project, headers)).projectRecoveryDecision.decidedBy, 'operator-verified');
      assert.deepEqual(decisionEvents(project).map((d) => d.decidedBy).sort(),
        ['open-install-unverified', 'operator-verified'], 'and the activity log keeps both');
    });

    it('armed, a session with no CSRF token: refused as before, and nothing is recorded', async () => {
      const project = makeProject();
      const { cookie } = await reach[states.ARMED]();
      const res = await save(project, 'operator', { cookie });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(store.projectRecoveryState.get(project.id), null);
    });
  });

  describe('what a save changes, and what it leaves alone', () => {
    it('answers with the recorded mode, and the panel\'s next read shows the decision', async () => {
      const project = makeProject();
      const res = await save(project, 'operator');
      assert.equal(res.statusCode, 200, res.body);
      const told = panel().recoveryModeSaveOutcome('operator', json(res), { error: null, code: null });
      assert.equal(told.ok, true);
      assert.match(told.text, /^Recovery mode saved: operator-cleared\./);
      const now = await readPanel(project);
      assert.equal(now.projectRecoveryMode, 'operator');
      assert.equal(now.projectRecoverySource, 'pinned');
      assert.equal(now.projectRecoveryDecision.pinnedMode, 'operator');
      assert.equal(now.projectRecoveryDiscrepancy, null);
    });

    it('never changes a launch that already froze a mode: a held launch stays held, and the next one uses the choice', async () => {
      const { project, sequence } = fixture.launchInRecovery(env, 'operator');
      assert.equal(sequence.recoveryMode, 'operator');
      assert.equal((await save(project, 'advisory')).statusCode, 200);

      const after = store.launchSequences.getBySession(sequence.sessionId);
      assert.equal(after.recovery, 'required', 'the launch is still held');
      assert.equal(after.recoveryMode, 'operator', 'and still in the mode it froze');
      const now = await readPanel(project);
      assert.equal(now.projectRecoveryMode, 'advisory', 'while the project reads advisory now');
      assert.equal(now.sequences[0].recoveryMode, 'operator', 'beside a row that still reports what its launch froze');
      const refused = launchSequence.ready({
        launchId: sequence.launchId,
        projectId: project.id,
        artifact: { schema: 'tc.ready/1', preflightVerdict: 'handoff-corrupt', proposedFirstAction: 'start', reconciliation: 'x'.repeat(80) }
      });
      assert.equal(refused.body.code, 'RECOVERY_UNCLEARED', 'a reconciliation still cannot stand in for the clear');

      store.sessions.wrap(sequence.sessionId, 'done');
      const next = store.launchSequences.getBySession(fixture.launchStubbed(env.sessions, project.name).session.id);
      assert.equal(next.recoveryMode, 'advisory', 'the project\'s next launch freezes the chosen mode');
    });

    it('a save rewrites a file value TangleClaw did not recognise', async () => {
      const project = makeProject();
      const conf = store.projectConfig.load(project.path) || {};
      conf.launchSequence = { ...(conf.launchSequence || {}), recoveryMode: 'bogus' };
      store.projectConfig.save(project.path, conf);
      assert.equal((await readPanel(project)).projectRecoverySource, 'invalid');
      assert.equal((await save(project, 'advisory')).statusCode, 200);
      const now = await readPanel(project);
      assert.equal(now.projectRecoverySource, 'chosen', 'the readout\'s promise that a save rewrites the value holds');
      assert.equal(now.projectRecoveryDiscrepancy, null);
    });

    it('a decision the store could not take is told as nothing changed, in the route\'s own code', async () => {
      const project = makeProject();
      const real = store.projectRecoveryState.recordDecision;
      store.projectRecoveryState.recordDecision = () => { throw new Error('database is locked'); };
      let res;
      try {
        res = await save(project, 'advisory');
      } finally {
        store.projectRecoveryState.recordDecision = real;
      }
      assert.equal(res.statusCode, 500);
      const body = json(res);
      assert.equal(body.code, projects.RECOVERY_DECISION_NOT_SAVED);
      const told = panel().recoveryModeSaveOutcome('advisory', null, { error: body.error, code: body.code });
      assert.match(told.text, /^The recovery mode was not saved, and nothing changed\./);
      assert.equal(store.projectRecoveryState.get(project.id), null, 'which is true');
    });

    it('a decision saved before the file write failed is told as saved, with the half that did not land', async () => {
      const project = makeProject();
      const real = store.projectConfig.save;
      store.projectConfig.save = () => { throw new Error('disk full'); };
      let res;
      try {
        res = await save(project, 'operator');
      } finally {
        store.projectConfig.save = real;
      }
      const body = json(res);
      const told = panel().recoveryModeSaveOutcome('operator', res.statusCode === 200 ? body : null,
        { error: body.error || null, code: body.code || null });
      assert.match(told.text, /saved/);
      assert.doesNotMatch(told.text, /not saved/);
      assert.equal(store.projectRecoveryState.get(project.id).pinnedMode, 'operator', 'the decision is on record either way');
      if (res.statusCode === 200) assert.match(told.text, /file could not be updated to match/);
      else assert.equal(body.code, projects.RECOVERY_DECISION_SAVED_UPDATE_FAILED);
    });
  });
});
