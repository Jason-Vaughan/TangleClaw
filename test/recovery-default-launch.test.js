'use strict';

/**
 * The default recovery mode a launch freezes, on each kind of install (#1937).
 *
 * Advisory recovery lets a session clear its own recovery, so it is the
 * default only while TangleClaw's login is in force (the gate state `armed`),
 * where a signed-in operator can read back what the session wrote. Everywhere
 * else a project nobody decided for keeps operator-cleared recovery. These
 * cases drive the real launch path under each gate state and read what was
 * frozen, what the launch is served and what it is told.
 *
 * The gate states are read from `GATE_STATES`, so a state added later is
 * covered on the operator-cleared side without anyone adding a case.
 */

const { describe, it, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const authGate = require('../lib/auth-gate');
const recoveryDefault = require('../lib/recovery-default');
const launchSequence = require('../lib/launch-sequence');
const launchPage = require('../lib/launch-page');
const lockfile = require('../lib/handoff-lockfile');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');

const ARMED = authGate.GATE_STATES.ARMED;
const NOT_ARMED = Object.values(authGate.GATE_STATES).filter((state) => state !== ARMED);

describe('the default recovery mode a launch freezes (#1937)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;
  let counter = 0;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-recovery-default-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => { counter += 1; });
  afterEach(() => recoveryDefault.setGateStateProbe(null));

  /**
   * Put the install in a login gate state, as launches and status reads see it.
   * @param {string|null} state - A gate state, or null for a process that cannot ask
   * @returns {void}
   */
  function gate(state) {
    recoveryDefault.setGateStateProbe(state === null ? null : () => state);
  }

  /**
   * Create a project, optionally with a recovery mode written into its file
   * and optionally with a handoff state this build cannot read, which is the
   * real route to a launch that needs recovery.
   * @param {object} [opts]
   * @param {string} [opts.fileMode] - The value for `project.json`; omitted writes no file
   * @param {boolean} [opts.damaged=true] - Whether the handoff is unreadable
   * @returns {object} The project record
   */
  function makeProject({ fileMode, damaged = true } = {}) {
    const name = `default-${counter}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    if (fileMode !== undefined) {
      fs.mkdirSync(path.join(dir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'),
        JSON.stringify({ launchSequence: { recoveryMode: fileMode } }) + '\n');
    }
    if (damaged) {
      fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
      fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
    }
    return project;
  }

  /**
   * Launch with tmux and engine detection stubbed, so no pane is ever started.
   * @param {object} project - The project
   * @returns {{sequence: object, id: object, session: object}}
   */
  function launch(project) {
    const real = { create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    try {
      const result = sessions.launchSession(project.name, {});
      assert.ok(result.session, `the launch produced a session: ${JSON.stringify(result.error || null)}`);
      const sequence = store.launchSequences.getBySession(result.session.id);
      return { sequence, session: result.session, id: { launchId: sequence.launchId, projectId: project.id } };
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  /**
   * End a launch's session, so its project can launch again.
   * @param {{session: object}} launched - From `launch`
   * @returns {void}
   */
  function end(launched) {
    store.sessions.wrap(launched.session.id, 'done');
  }

  /**
   * Serve and acknowledge the first three steps, leaving the cursor on the
   * task step, which is the one the recovery gate guards.
   * @param {object} id - The pane's identity
   * @returns {void}
   */
  function ackThroughState(id) {
    for (let i = 0; i < 3; i++) {
      let body = launchSequence.next(id).body;
      while (!body.ack) body = launchSequence.next({ ...id, page: body.page.index + 1 }).body;
      launchSequence.next({ ...id, ack: { step: body.step.id, revision: body.revision, digest: body.ack.digest } });
    }
  }

  /**
   * The project's recovery state row's notice marker, or null.
   * @param {object} project - The project
   * @returns {string|null} The launch id that carried the notice
   */
  function noticeLaunch(project) {
    const row = store.projectRecoveryState.get(project.id);
    return row ? row.inheritedNoticeLaunchId : null;
  }

  describe('where the login is in force', () => {
    it('freezes advisory for a project nobody decided for, and serves the task step behind the warning', () => {
      gate(ARMED);
      for (const fileMode of [undefined, 'operator', 'advisory']) {
        const project = makeProject({ fileMode });
        const { sequence, id } = launch(project);
        assert.equal(sequence.recovery, 'required', 'precondition: this launch needs recovery');
        assert.equal(sequence.recoveryMode, 'advisory', `file ${JSON.stringify(fileMode)}`);
        ackThroughState(id);
        const task = launchSequence.next(id).body;
        assert.equal(task.withheld, undefined, 'the task step is served');
        assert.equal(task.step.id, 'task');
        assert.equal(task.recovery.verdict, 'handoff-corrupt', 'behind the recovery warning');
        assert.equal(task.status.taskWithheld, false);
        assert.equal('recoveryHint' in task.status, false, 'an advisory launch is not operator-held, so it carries no such sentence');
      }
    });

    it('says so once: on the first launch that takes the default, on every page of its task step, and on no later launch', () => {
      gate(ARMED);
      for (const fileMode of [undefined, 'operator']) {
        const project = makeProject({ fileMode, damaged: false });
        const first = launch(project);
        assert.equal(first.sequence.recovery, 'none', 'a healthy launch is the usual one to carry it');
        assert.equal(noticeLaunch(project), first.sequence.launchId);
        const early = launchSequence.next(first.id).body;
        assert.equal(early.step.id, 'identity');
        assert.equal('advisoryDefaultNotice' in early, false, 'only the task step carries it');
        ackThroughState(first.id);
        const task = launchSequence.next(first.id).body;
        assert.equal(task.step.id, 'task');
        assert.equal(task.advisoryDefaultNotice, true);
        assert.ok(launchPage.renderPage(task).includes(launchPage.ADVISORY_DEFAULT_NOTICE), 'and the pane is shown it');
        assert.equal(launchSequence.next(first.id).body.advisoryDefaultNotice, true, 're-serving that launch shows it again');
        end(first);

        const second = launch(project);
        assert.equal(second.sequence.recoveryMode, 'advisory');
        assert.equal(noticeLaunch(project), first.sequence.launchId, 'the marker still names the first launch');
        ackThroughState(second.id);
        const again = launchSequence.next(second.id).body;
        assert.equal(again.step.id, 'task');
        assert.equal('advisoryDefaultNotice' in again, false, 'a later launch does not repeat it');
        assert.ok(!launchPage.renderPage(again).includes(launchPage.ADVISORY_DEFAULT_NOTICE));
      }
    });

    it('carries no notice for a project whose file already asked for advisory, or whose operator decided', () => {
      gate(ARMED);
      const asked = makeProject({ fileMode: 'advisory', damaged: false });
      const chose = makeProject({ fileMode: 'operator', damaged: false });
      store.projectRecoveryState.recordDecision(chose.id, 'advisory', 'operator');
      const pinned = makeProject({ fileMode: 'operator', damaged: false });
      store.projectRecoveryState.recordDecision(pinned.id, 'operator', 'operator');
      for (const project of [asked, chose, pinned]) {
        const { id } = launch(project);
        assert.equal(noticeLaunch(project), null);
        ackThroughState(id);
        assert.equal('advisoryDefaultNotice' in launchSequence.next(id).body, false);
      }
    });

    it('keeps a pinned project operator-cleared', () => {
      gate(ARMED);
      const project = makeProject({ fileMode: 'advisory' });
      store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
      const { sequence, id } = launch(project);
      assert.equal(sequence.recoveryMode, 'operator');
      ackThroughState(id);
      const held = launchSequence.next(id).body;
      assert.equal(held.withheld, true);
      assert.match(held.status.recoveryHint, /^This project is pinned to operator-cleared recovery by the operator\. Ask the operator to sign in/);
    });
  });

  describe('where it is not', () => {
    for (const state of [...NOT_ARMED, null]) {
      it(`${state === null ? 'a process that cannot ask the gate' : state}: freezes operator, claims nothing and withholds the task step`, () => {
        gate(state);
        for (const fileMode of [undefined, 'operator', 'advisory']) {
          const project = makeProject({ fileMode });
          const { sequence, id } = launch(project);
          assert.equal(sequence.recoveryMode, 'operator', `file ${JSON.stringify(fileMode)}`);
          assert.equal(store.projectRecoveryState.get(project.id), null, 'no notice is claimed and no row is made');
          ackThroughState(id);
          const held = launchSequence.next(id).body;
          assert.equal(held.withheld, true);
          assert.equal(held.status.taskWithheld, true);
          assert.equal(held.status.recoveryHint, launchSequence.operatorHeldHint(
            { projectRecoveryMode: 'operator', projectRecoverySource: 'not-armed' }, state).text,
          'and is told why, with what can be done in this gate state');
          assert.ok(held.content.includes(held.status.recoveryHint), 'the withheld step carries the same sentence');
          const refused = launchSequence.ready({ ...id, artifact: { schema: 'tc.ready/1', preflightVerdict: 'handoff-corrupt', proposedFirstAction: 'start' } });
          assert.equal(refused.body.code, 'RECOVERY_UNCLEARED');
          assert.ok(refused.body.error.includes(held.status.recoveryHint), 'and so does the READY refusal');
        }
      });
    }

    it('still honours the operator\'s own choice of advisory, and their pin', () => {
      for (const state of [...NOT_ARMED, null]) {
        gate(state);
        const chose = makeProject({ fileMode: 'operator' });
        store.projectRecoveryState.recordDecision(chose.id, 'advisory', 'operator');
        assert.equal(launch(chose).sequence.recoveryMode, 'advisory', `chosen, ${state}`);
        const pinned = makeProject({ fileMode: 'advisory' });
        store.projectRecoveryState.recordDecision(pinned.id, 'operator', 'operator');
        assert.equal(launch(pinned).sequence.recoveryMode, 'operator', `pinned, ${state}`);
      }
    });
  });

  describe('one answer per launch', () => {
    /**
     * A gate probe that answers `first` once and `then` ever after, and counts.
     * @param {string} first - The first answer
     * @param {string} then - Every later answer
     * @returns {{calls: function(): number}}
     */
    function flipping(first, then) {
      let calls = 0;
      recoveryDefault.setGateStateProbe(() => { calls += 1; return calls === 1 ? first : then; });
      return { calls: () => calls };
    }

    it('reads the gate once, so a login that changes mid-launch cannot split the mode from the notice', () => {
      // Read a second time between resolving and freezing, either of these
      // would disagree with itself: a mode from one answer and a notice claim
      // from the other.
      const toOpen = makeProject({ fileMode: 'operator', damaged: false });
      let probe = flipping(ARMED, 'open');
      const first = launch(toOpen);
      assert.equal(probe.calls(), 1, 'the launch asked the gate exactly once');
      assert.equal(first.sequence.recoveryMode, 'advisory');
      assert.equal(noticeLaunch(toOpen), first.sequence.launchId, 'and the notice was claimed from the same answer');

      const toArmed = makeProject({ fileMode: 'operator', damaged: false });
      probe = flipping('open', ARMED);
      const second = launch(toArmed);
      assert.equal(probe.calls(), 1);
      assert.equal(second.sequence.recoveryMode, 'operator');
      assert.equal(store.projectRecoveryState.get(toArmed.id), null, 'nothing was claimed for a launch that froze operator');
    });

    it('reads the operator\'s decision once', () => {
      gate(ARMED);
      const project = makeProject({ fileMode: 'operator', damaged: false });
      const realGet = store.projectRecoveryState.get;
      let reads = 0;
      store.projectRecoveryState.get = (...args) => { reads += 1; return realGet(...args); };
      try {
        launch(project);
      } finally {
        store.projectRecoveryState.get = realGet;
      }
      assert.equal(reads, 1);
    });

    it('keeps the mode it froze when the login is later switched on or off', () => {
      gate(ARMED);
      const advisory = makeProject({ fileMode: 'operator' });
      const a = launch(advisory);
      assert.equal(a.sequence.recoveryMode, 'advisory');
      gate('open');
      ackThroughState(a.id);
      const served = launchSequence.next(a.id).body;
      assert.equal(served.step.id, 'task', 'an advisory launch is still served its task step');
      assert.equal(launchSequence.projectRecoveryNow(advisory.id).projectRecoveryMode, 'operator',
        'while the project\'s next launch would be operator-cleared');

      const operator = makeProject({ fileMode: 'operator' });
      const o = launch(operator);
      assert.equal(o.sequence.recoveryMode, 'operator');
      gate(ARMED);
      ackThroughState(o.id);
      const held = launchSequence.next(o.id).body;
      assert.equal(held.withheld, true, 'an operator-held launch is still held');
      assert.match(held.status.recoveryHint, /^This launch started in operator-cleared recovery and keeps it; the project's next launch lets a session reconcile its own recovery\. Ask the operator to sign in/,
        'and is told the login is now what clears it, not what it was at launch');
    });
  });

  describe('the sentence an operator-held launch is told', () => {
    const reasons = {
      pinned: { projectRecoveryMode: 'operator', projectRecoverySource: 'pinned' },
      'not-armed': { projectRecoveryMode: 'operator', projectRecoverySource: 'not-armed' },
      invalid: { projectRecoveryMode: 'operator', projectRecoverySource: 'invalid' },
      unreadable: { projectRecoveryMode: 'operator', projectRecoverySource: 'unreadable' },
      'frozen earlier': { projectRecoveryMode: 'advisory', projectRecoverySource: 'inherited' },
      'project unknown': { projectRecoveryMode: null, projectRecoverySource: null },
      'not read': null
    };
    const gates = [...Object.values(authGate.GATE_STATES), null];

    it('is one line for every reason in every gate state', () => {
      for (const [name, projectNow] of Object.entries(reasons)) {
        for (const state of gates) {
          const { text } = launchSequence.operatorHeldHint(projectNow, state);
          assert.ok(text.length > 0 && !/[\r\n]/.test(text), `${name} in ${state}`);
        }
      }
    });

    it('never calls a project pinned unless the operator pinned it', () => {
      for (const [name, projectNow] of Object.entries(reasons)) {
        for (const state of gates) {
          const { text } = launchSequence.operatorHeldHint(projectNow, state);
          assert.equal(/pinned/.test(text), name === 'pinned', `${name} in ${state}: ${text}`);
        }
      }
    });

    it('says what can be done from the gate state alone, whatever the reason', () => {
      const classes = { [ARMED]: 'signed-in-operator', open: 'unverified' };
      for (const state of gates) {
        const expected = state === null ? 'unknown' : (classes[state] || 'unavailable');
        for (const projectNow of Object.values(reasons)) {
          const hint = launchSequence.operatorHeldHint(projectNow, state);
          assert.equal(hint.clear, expected, String(state));
          assert.equal(/Launch readiness panel/.test(hint.text), expected === 'signed-in-operator' || expected === 'unverified',
            `${state}: the panel is named only where the clear is served`);
          assert.equal(/has no login/.test(hint.text), state === 'open', `${state}: only an open install has no login`);
        }
      }
    });

    it('points at the setting for future launches exactly where it points at the panel', () => {
      const pointer = /That panel also sets the recovery mode this project's future launches use\.$/;
      for (const state of gates) {
        for (const [name, projectNow] of Object.entries(reasons)) {
          const hint = launchSequence.operatorHeldHint(projectNow, state);
          assert.equal(pointer.test(hint.text), hint.clear === 'signed-in-operator' || hint.clear === 'unverified',
            `${name} in ${state}: a state whose action must not send anyone to the panel does not say what else it does`);
        }
      }
    });

    it('fits the withheld step, the smallest page budget and one line in every gate state', () => {
      for (const state of gates) {
        gate(state);
        const project = makeProject({ fileMode: 'operator' });
        store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
        const { id } = launch(project);
        ackThroughState(id);
        const held = launchSequence.next(id).body;
        assert.equal(held.withheld, true, String(state));
        assert.ok(held.content.includes(held.status.recoveryHint), String(state));
        assert.ok(held.content.length <= launchSequence.MIN_PAGE_BUDGET,
          `${state}: the withheld step is ${held.content.length} characters, within the smallest budget a page is given`);
      }
    });

    it('does not say the install has no login for the not-armed reason, which covers five states', () => {
      for (const state of gates.filter((s) => s !== 'open')) {
        assert.doesNotMatch(launchSequence.operatorHeldHint(reasons['not-armed'], state).text, /no login/, String(state));
      }
    });

    it('survives a project whose recovery state cannot be read', () => {
      gate('open');
      const project = makeProject({ fileMode: 'operator' });
      const { sequence } = launch(project);
      const realGet = store.projectRecoveryState.get;
      store.projectRecoveryState.get = () => { throw new Error('database is locked'); };
      try {
        const hint = launchSequence.operatorHeldHintFor(sequence);
        assert.match(hint.text, /^This launch is in operator-cleared recovery\. This install has no login/,
          'no reason is claimed, and the action still follows the gate');
        assert.equal(hint.clear, 'unverified');
      } finally {
        store.projectRecoveryState.get = realGet;
      }
    });
  });

  describe('the notice', () => {
    it('says which launch it belongs to, and does not claim to have been shown', () => {
      // It is claimed when the launch is recorded. A first launch that ends
      // before its task step is served has used it unread, so "shown once"
      // would be a claim about something nothing checks.
      const notice = launchPage.ADVISORY_DEFAULT_NOTICE;
      assert.match(notice, /belongs to this project's first launch under that default and is not repeated on a later one\]$/);
      assert.doesNotMatch(notice, /shown/);
      assert.doesNotMatch(notice, /moved/, 'true of a project that has never launched too');
      assert.ok(!/[\r\n]/.test(notice));

      gate(ARMED);
      const project = makeProject({ fileMode: 'operator', damaged: false });
      const first = launch(project);
      end(first);
      const second = launch(project);
      ackThroughState(second.id);
      assert.equal('advisoryDefaultNotice' in launchSequence.next(second.id).body, false,
        'the first launch ended with its task step unread, and the notice was still its own');
      assert.equal(noticeLaunch(project), first.sequence.launchId);
    });
  });

  describe('the page budget', () => {
    it('covers a task page carrying both notices', () => {
      const widest = {
        step: { index: 3, id: 'task', of: 4 },
        page: { index: 0, of: 1, continued: false },
        revision: 1,
        content: '',
        ack: { command: launchPage.ackCommand('task', 1, 'f'.repeat(16)) },
        recovery: { verdict: 'handoff-corrupt', recoveryRevision: 1 },
        advisoryDefaultNotice: true
      };
      const rendered = launchPage.renderPage(widest);
      assert.ok(rendered.includes(launchPage.ADVISORY_DEFAULT_NOTICE));
      assert.ok(rendered.length <= launchPage.pageOverhead(), 'a decorated page still fits the engine\'s tool-output limit');
      const bare = launchPage.renderPage({ ...widest, advisoryDefaultNotice: undefined });
      assert.equal(rendered.length - bare.length, launchPage.ADVISORY_DEFAULT_NOTICE.length + 2,
        'the notice is what the budget grew by, and nothing else');
    });
  });
});
