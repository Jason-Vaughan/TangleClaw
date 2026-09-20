'use strict';

/**
 * The unready-launch monitor (Train 21, car 21.5).
 *
 * The store half is real — the stamp and the nudge count are the durable facts
 * this monitor exists to write — and only the pane is stubbed: capturing tmux
 * and typing into it are the two things a test must not do for real.
 *
 * The cases that matter are the ones where the nudge must NOT go out: a pane
 * that is working or holds the operator's half-typed input, a session with no
 * pane at all, an engine with no probed signature, and a launch that has
 * already had its one nudge.
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchUnready = require('../lib/launch-unready');
const launchSequence = require('../lib/launch-sequence');
const projectConfig = require('../lib/project-config');

const MINUTE = 60_000;

describe('unready-launch monitor (Train 21, car 21.5)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;
  let realSeams;
  let injected;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-unready-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
    realSeams = { ...launchUnready._internal };
  });

  after(() => {
    Object.assign(launchUnready._internal, realSeams);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    Object.assign(launchUnready._internal, realSeams);
    injected = [];
    // A pane that is at rest and safe to type into, without touching tmux.
    launchUnready._internal.wakeProfiles = () => ({ claude: { busyMarker: 'esc to interrupt', promptRe: /^> / } });
    launchUnready._internal.capturePane = () => ({ lines: ['> '], alternateScreen: false });
    launchUnready._internal.cursorInfo = () => null;
    launchUnready._internal.assessIdle = () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 2 });
    launchUnready._internal.inject = (projectName, command, options) => {
      injected.push({ projectName, command, options });
      return { ok: true, error: null };
    };
  });

  /**
   * Create a project and bind a launch sequence to a session of it, without
   * starting a pane.
   * @param {string} name - Project name
   * @param {object} [opts]
   * @param {string} [opts.engine] - Engine id for the session row
   * @param {string} [opts.sessionMode] - 'tmux' (default) or 'webui'
   * @param {object} [opts.config] - Project config to save
   * @returns {{project: object, session: object, sequence: object}}
   */
  /**
   * An explicitly evaluated, benign preflight.
   *
   * Every fixture here means "a launch with nothing wrong", and that is a
   * POSITIVE verdict the evaluator reached — not the absence of one. Leaving
   * `preflight` out states the opposite (no evidence arrived), which owes
   * recovery.
   */
  const HEALTHY_PREFLIGHT = Object.freeze({
    verdict: 'ok',
    reason: 'nothing was left behind',
    requiresRecovery: false,
    requiresReconciliation: false,
    worktreeDirty: false,
    evaluationFailed: false,
    evaluationMissing: false
  });

  function bindSequence(name, opts = {}) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    if (opts.config) store.projectConfig.save(dir, opts.config);
    const engine = store.engines.get('claude');
    const launchId = launchSequence.mintLaunchId();
    const rendered = sessions.renderLaunchSteps(project, engine, {});
    const snapshot = launchSequence.buildSnapshot({
      launchId,
      project,
      engineProfile: engine,
      applicability: { applicable: true, reason: null },
      rendered,
      rules: [],
      // These sequences intend a HEALTHY launch, so they must supply an explicit
      // successfully-evaluated preflight. Omitting it is missing evidence, which
      // owes recovery — the task step would be withheld and this fixture would be
      // testing the recovery gate rather than the monitor. A healthy launch is
      // stated, never inherited from a default.
      preflight: opts.preflight || HEALTHY_PREFLIGHT
    });
    const session = store.sessions.start({
      projectId: project.id,
      engineId: opts.engine || 'claude',
      tmuxSession: opts.sessionMode === 'webui' ? null : `tc-${name}`,
      sessionMode: opts.sessionMode || undefined,
      launchSequence: snapshot
    });
    return { project, session, sequence: store.launchSequences.getBySession(session.id) };
  }

  /**
   * What this tick typed into one session's pane. Scoped by session on purpose:
   * `tick` judges every unready sequence of every live session, so a test that
   * counted the whole list would be counting the other tests' projects.
   * @param {number} sessionId - The session to look at
   * @returns {object[]} The injections addressed to it
   */
  function injectedFor(sessionId) {
    return injected.filter((i) => i.options && i.options.sessionId === sessionId);
  }

  /**
   * The verdict a tick returns for one sequence.
   * @param {object} sequence - The sequence
   * @param {number} elapsedMs - How long after its creation the tick runs
   * @returns {string}
   */
  function verdictFor(sequence, elapsedMs) {
    const created = sessions._parseSqliteUtcMs(store.launchSequences.getByLaunchId(sequence.launchId).createdAt);
    return launchUnready.tick(created + elapsedMs)[sequence.id];
  }

  it('does nothing while the launch is still inside its window', () => {
    const { session, sequence } = bindSequence('unready-inside');
    assert.equal(verdictFor(sequence, 5 * MINUTE), 'within-window');
    const row = store.launchSequences.getByLaunchId(sequence.launchId);
    assert.equal(row.unreadyAt, null);
    assert.equal(row.nudgeCount, 0);
    assert.deepEqual(injectedFor(session.id), []);
  });

  it('stamps the window and nudges once, in that session\'s own pane', () => {
    const { project, session, sequence } = bindSequence('unready-nudged');
    assert.equal(verdictFor(sequence, 11 * MINUTE), 'nudged');
    const row = store.launchSequences.getByLaunchId(sequence.launchId);
    assert.ok(row.unreadyAt);
    assert.equal(row.nudgeCount, 1);
    assert.ok(row.lastNudgedAt);
    const mine = injectedFor(session.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].projectName, project.name,
      'addressed to the session it judged, never to whatever session is active now');
    assert.ok(!mine[0].command.includes('\n'), 'one line: sendKeys sends a single Enter');

    // The budget is one. A later tick says so and types nothing.
    injected = [];
    assert.equal(verdictFor(sequence, 30 * MINUTE), 'already-nudged');
    assert.deepEqual(injectedFor(session.id), []);
    assert.equal(store.launchSequences.getByLaunchId(sequence.launchId).nudgeCount, 1);
  });

  it('stamps the window even when the pane can never be nudged', () => {
    // The observation must not depend on a typeable pane: a session whose pane
    // cannot be typed into is exactly the one the operator needs to see.
    const { session, sequence } = bindSequence('unready-webui', { sessionMode: 'webui' });
    assert.equal(verdictFor(sequence, 11 * MINUTE), 'no-pane');
    assert.ok(store.launchSequences.getByLaunchId(sequence.launchId).unreadyAt);
    assert.deepEqual(injectedFor(session.id), []);
  });

  it('holds the nudge while the pane is working or holds unsent input', () => {
    const { session, sequence } = bindSequence('unready-busy');
    launchUnready._internal.assessIdle = () => ({ idle: false, reason: 'composer-has-input', digest: 'd', idleTicks: 0 });
    assert.equal(verdictFor(sequence, 11 * MINUTE), 'pane-busy');
    assert.ok(store.launchSequences.getByLaunchId(sequence.launchId).unreadyAt, 'the window is still recorded');
    assert.equal(store.launchSequences.getByLaunchId(sequence.launchId).nudgeCount, 0);
    assert.deepEqual(injectedFor(session.id), []);

    // The next tick tries again, and this one lands.
    launchUnready._internal.assessIdle = () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 2 });
    assert.equal(verdictFor(sequence, 12 * MINUTE), 'nudged');
    assert.equal(injectedFor(session.id).length, 1);
  });

  it('counts a nudge only when the pane actually took it', () => {
    const { sequence } = bindSequence('unready-inject-failed');
    launchUnready._internal.inject = () => ({ ok: false, error: 'tmux session not found' });
    assert.equal(verdictFor(sequence, 11 * MINUTE), 'inject-failed');
    assert.equal(store.launchSequences.getByLaunchId(sequence.launchId).nudgeCount, 0,
      'a failed paste told the session nothing, so nothing is counted');
  });

  it('refuses to type into an engine with no probed pane signature', () => {
    const { session, sequence } = bindSequence('unready-unprofiled');
    launchUnready._internal.wakeProfiles = () => ({});
    assert.equal(verdictFor(sequence, 11 * MINUTE), 'unprofiled-engine');
    assert.deepEqual(injectedFor(session.id), []);
  });

  it('survives a pane that cannot be read, and retries next tick', () => {
    const { sequence } = bindSequence('unready-capture-failed');
    launchUnready._internal.capturePane = () => { throw new Error('pane vanished'); };
    assert.equal(verdictFor(sequence, 11 * MINUTE), 'pane-capture-failed');
    assert.equal(store.launchSequences.getByLaunchId(sequence.launchId).nudgeCount, 0);
  });

  it('honours each project\'s own window', () => {
    const { sequence } = bindSequence('unready-short-window', {
      config: { launchSequence: { unreadyWindowMinutes: 2 } }
    });
    assert.equal(verdictFor(sequence, 1 * MINUTE), 'within-window');
    assert.equal(verdictFor(sequence, 3 * MINUTE), 'nudged');
  });

  it('stops watching a sequence once it attests', () => {
    const { sequence } = bindSequence('unready-attested');
    const id = { launchId: sequence.launchId, projectId: sequence.projectId };
    for (let i = 0; i < store.LAUNCH_STEP_IDS.length; i++) {
      let body = launchSequence.next(id).body;
      while (!body.ack) body = launchSequence.next({ ...id, page: body.page.index + 1 }).body;
      launchSequence.next({ ...id, ack: { step: body.step.id, revision: body.revision, digest: body.ack.digest } });
    }
    const current = store.launchSequences.getByLaunchId(sequence.launchId);
    assert.equal(launchSequence.ready({
      ...id,
      artifact: {
        schema: 'tc.ready/1',
        preflightVerdict: current.preflight.verdict,
        proposedFirstAction: 'confirm the next chunk with the operator'
      }
    }).status, 200);
    assert.equal(verdictFor(sequence, 60 * MINUTE), undefined, 'an attested launch is not judged at all');
  });

  describe('the verdict vocabulary', () => {
    it('explains every code the monitor can return, and returns every code it explains', () => {
      // Derived from the source, not from a list written here: a new branch
      // returning a code nobody documented, or a documented code no branch can
      // produce, is exactly the drift this asserts against — the second is how
      // a guard that cannot fire reads as a state that can.
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'launch-unready.js'), 'utf8');
      const returned = new Set();
      for (const m of src.matchAll(/return '([a-z-]+)';/g)) returned.add(m[1]);
      // The catch-all in `tick` names an existing code rather than a new one.
      for (const m of src.matchAll(/verdicts\[sequence\.id\] = '([a-z-]+)'/g)) returned.add(m[1]);
      assert.deepEqual([...returned].sort(), Object.keys(launchUnready.VERDICT_MEANINGS).sort());
      for (const [code, meaning] of Object.entries(launchUnready.VERDICT_MEANINGS)) {
        assert.ok(meaning.length > 10, `${code} owes a reader a sentence`);
      }
    });
  });

  describe('the nudge line', () => {
    it('is one line of TangleClaw bytes that names both commands and claims no authority', () => {
      const line = launchUnready.nudgeLine({ cursor: 1 }, 4);
      assert.ok(!line.includes('\n'));
      assert.match(line, /1 of 4 step/);
      assert.match(line, /tc start next/);
      assert.match(line, /tc start ready/);
      assert.match(line, /authorizes nothing/);
      assert.match(line, /say so rather than working from context you never received/);
    });

    // #1599: the cursor-at-the-end case had no test, so the line could
    // contradict its own number ("not acknowledged: 4 of 4") and send a session
    // back to re-read steps it had already acknowledged.
    it('does not claim the steps are unacknowledged when only the attestation is missing', () => {
      const line = launchUnready.nudgeLine({ cursor: 4 }, 4);
      assert.ok(!line.includes('\n'));
      assert.doesNotMatch(line, /not acknowledged/,
        'every step IS acknowledged; only the attestation is outstanding');
      assert.doesNotMatch(line, /tc start next/,
        'there is nothing left to read, so it must not send the session back');
      assert.match(line, /Every step of your launch context is acknowledged \(4 of 4\)/);
      assert.match(line, /tc start ready/);
      assert.match(line, /authorizes nothing/);
    });

    it('still asks for the remaining steps when some are genuinely outstanding', () => {
      const line = launchUnready.nudgeLine({ cursor: 0 }, 4);
      assert.match(line, /not acknowledged: 0 of 4 step/);
      assert.match(line, /tc start next/);
    });
  });

  describe('the monitor\'s lifecycle', () => {
    it('starts once and stops cleanly', () => {
      launchUnready._internal.listUnready = () => [];
      launchUnready.start({ intervalMs: 50 });
      launchUnready.start({ intervalMs: 50 });
      launchUnready.stop();
      launchUnready.stop();
      assert.equal(launchUnready.DEFAULT_INTERVAL_MS, 15_000);
    });

    it('never nudges more often than the window it reads', () => {
      // The cadence has to be shorter than the shortest configurable window, or
      // the monitor could not observe the streak it needs before nudging.
      assert.ok(launchUnready.DEFAULT_INTERVAL_MS < projectConfig.UNREADY_WINDOW_MIN_MINUTES * MINUTE);
    });
  });
});
