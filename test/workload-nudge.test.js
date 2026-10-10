'use strict';

/**
 * The workload nudge monitor (#2262): which lanes get one line typed into
 * their pane, and which are left alone and why.
 *
 * The store is real: the receipts, the composition that says a receipt expired
 * and the record of a nudge are the ones the server uses. What the host would
 * have to supply is stubbed at the module's seams: the pane (nothing here runs
 * tmux), the activity observer's reading, and the wrap registry.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel, getLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const workloadFleet = require('../lib/workload-fleet');
const nudge = require('../lib/workload-nudge');
const { bindProject } = require('./_shared-docs-callers');

const MIN = 60_000;
/** A fixed clock: every receipt and every tick is placed relative to it. */
const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const SUMMARY = 'refactoring the frobnicator quietly';

describe('workload nudge monitor (#2262)', () => {
  let tmpDir;
  const realInternal = { ...nudge._internal };
  /** @type {Array<{projectName: string, command: string, options: object}>} */
  let typed;
  let injectResult;
  let engineBySession;
  let wrapRunning;
  let paneless;
  /** The sessions this test made: the store is shared, and a tick must not judge an earlier test's lanes. */
  let mine;
  let seq = 0;

  /**
   * A project with a live, launch-bound session, and optionally the setting.
   * @param {object|undefined} workloadNudge - The project's `workloadNudge` block, or undefined for none
   * @returns {{project: object, sessionId: number, launchId: string}}
   */
  const lane = (workloadNudge) => {
    seq += 1;
    const dir = path.join(tmpDir, `p${seq}`);
    fs.mkdirSync(dir);
    const project = store.projects.create({ name: `lane-${seq}`, path: dir, engine: 'claude' });
    if (workloadNudge !== undefined) {
      const cfg = store.projectConfig.load(dir);
      cfg.workloadNudge = workloadNudge;
      store.projectConfig.save(dir, cfg);
    }
    const bound = bindProject(project);
    engineBySession.set(bound.sessionId, { activity: 'at-rest', reason: 'at-rest' });
    mine.add(bound.sessionId);
    return { project, sessionId: bound.sessionId, launchId: bound.launchId };
  };

  /**
   * The session reports its workload at a given time.
   * @param {object} l - What {@link lane} returned
   * @param {number} atMs - When the receipt was received
   * @param {string} [state] - The asserted state
   * @returns {object} The stored receipt row
   */
  const reports = (l, atMs, state = 'working') => store.workloadReceipts.append({
    project_id: l.project.id, session_id: l.sessionId, launch_id: l.launchId, assignment_id: null,
    state, clearance: 'do-not-clear', summary: SUMMARY, wait_kind: null, wait_detail: null,
    refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null, source: 'tc-cli',
    received_at: new Date(atMs).toISOString()
  }, { minIntervalMs: 0, nowMs: atMs }).row;

  /**
   * An enabled lane whose `working` receipt, written at T0, has expired.
   * @param {object} [setting] - Extra `workloadNudge` keys
   * @returns {{project: object, sessionId: number, launchId: string, receipt: object}}
   */
  const expiredLane = (setting = {}) => {
    const l = lane({ enabled: true, ...setting });
    return { ...l, receipt: reports(l, T0) };
  };

  const facts = (l) => store.workloadNudgeFacts.listForReceipt(l.receipt.receipt_id);
  /** One tick, 31 minutes after T0 unless told otherwise; returns this lane's verdict. */
  const verdict = (l, atMs = T0 + 31 * MIN) => nudge.tick(atMs)[l.sessionId];

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-workload-nudge-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    Object.assign(nudge._internal, realInternal);
    nudge.stop();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    nudge.stop();
    Object.assign(nudge._internal, realInternal);
    typed = [];
    injectResult = { ok: true, error: null };
    engineBySession = new Map();
    wrapRunning = new Set();
    paneless = new Set();
    mine = new Set();
    const observer = {
      get: (sessionId) => ({
        ...(engineBySession.get(sessionId) || { activity: 'unknown', reason: 'not-observed' }),
        observedAt: null, ageSeconds: 0, provenance: 'engine-observed'
      })
    };
    // Sessions bound by the test helper have no pane; give each a name so the
    // judge reaches the gates behind "has a pane", except where a test asks.
    nudge._internal.listSessions = () => store.sessions.listLiveAll()
      .filter((s) => mine.has(s.id))
      .map((s) => (paneless.has(s.id) ? s : { ...s, tmuxSession: `tc-test-${s.id}` }));
    nudge._internal.laneContext = (session, projectName, nowMs) => workloadFleet
      .laneContext(session, { observer, projectName, nowMs });
    nudge._internal.wrapRunning = (projectName) => wrapRunning.has(projectName);
    nudge._internal.inject = (projectName, command, options) => {
      typed.push({ projectName, command, options });
      return injectResult;
    };
  });

  describe('every verdict has a declared meaning', () => {
    it('declares a non-empty sentence for each code', () => {
      for (const [code, meaning] of Object.entries(nudge.VERDICT_MEANINGS)) {
        assert.equal(typeof meaning, 'string', code);
        assert.ok(meaning.length > 20, code);
      }
    });
  });

  describe('a lane that is not nudged, and why', () => {
    it('monitor-off: a project with no setting is never typed into, whatever its receipts say', () => {
      const l = lane(undefined);
      l.receipt = reports(l, T0);
      assert.equal(verdict(l), 'monitor-off');
      assert.equal(verdict(l, T0 + 600 * MIN), 'monitor-off');
      assert.deepEqual(typed, []);
      assert.deepEqual(facts(l), []);
    });

    it('monitor-off: enabled must be exactly true', () => {
      for (const enabled of [false, 'true', 1, null]) {
        const l = lane({ enabled });
        l.receipt = reports(l, T0);
        assert.equal(verdict(l), 'monitor-off', `enabled: ${JSON.stringify(enabled)}`);
      }
      assert.deepEqual(typed, []);
    });

    it('no-project: the session names a project that is gone', () => {
      const l = expiredLane();
      nudge._internal.getProject = () => null;
      assert.equal(verdict(l), 'no-project');
      assert.deepEqual(typed, []);
    });

    it('session-not-active: a session that is no longer active', () => {
      const l = expiredLane();
      const list = nudge._internal.listSessions;
      nudge._internal.listSessions = () => list().map((s) => ({ ...s, status: 'wrapped' }));
      assert.equal(verdict(l), 'session-not-active');
      assert.deepEqual(typed, []);
    });

    it('unsupported-lane: a lane the composition calls a Project Master lane', () => {
      const l = expiredLane();
      const real = nudge._internal.laneContext;
      nudge._internal.laneContext = (...args) => {
        const ctx = real(...args);
        ctx.lane.composed = { availability: 'UNKNOWN', clearance: 'unknown', reasons: ['unsupported-master-lane'] };
        return ctx;
      };
      assert.equal(verdict(l), 'unsupported-lane');
      assert.deepEqual(typed, []);
    });

    it('no-receipt: a session that never reported in this launch', () => {
      const l = lane({ enabled: true });
      assert.equal(verdict(l), 'no-receipt');
      assert.deepEqual(typed, []);
    });

    it('receipt-current: a report inside its expiry', () => {
      const l = expiredLane();
      assert.equal(verdict(l, T0 + 29 * MIN), 'receipt-current');
      assert.deepEqual(typed, []);
    });

    it('receipt-current: a waiting report lasts 120 minutes, not 30', () => {
      const l = lane({ enabled: true });
      l.receipt = reports(l, T0, 'waiting-external');
      assert.equal(verdict(l, T0 + 119 * MIN), 'receipt-current');
      assert.equal(verdict(l, T0 + 121 * MIN), 'nudged');
    });

    it('stale-not-expired: a report a wrap superseded is not an expiry', () => {
      const l = expiredLane();
      const observer = { get: () => ({ activity: 'at-rest', reason: 'at-rest' }) };
      nudge._internal.laneContext = (session, projectName, nowMs) => workloadFleet.laneContext(session, {
        observer, projectName, nowMs,
        wrap: { wrapRun: () => ({ sessionId: l.sessionId, startedAt: T0 + MIN }) }
      });
      assert.equal(verdict(l), 'stale-not-expired');
      assert.deepEqual(typed, []);
      assert.deepEqual(facts(l), []);
    });

    it('stale-not-expired: a control event or another launch is not an expiry either', () => {
      const l = expiredLane();
      const real = nudge._internal.laneContext;
      for (const staleReason of ['control-hold', 'other-launch', 'session-ended', 'malformed']) {
        nudge._internal.laneContext = (...args) => {
          const ctx = real(...args);
          ctx.lane.workload.staleReason = staleReason;
          return ctx;
        };
        assert.equal(verdict(l), 'stale-not-expired', staleReason);
      }
      assert.deepEqual(typed, []);
    });

    it('no-pane: a web UI session, and a session with no tmux pane', () => {
      const web = expiredLane();
      const list = nudge._internal.listSessions;
      nudge._internal.listSessions = () => list().map((s) => (s.id === web.sessionId ? { ...s, sessionMode: 'webui' } : s));
      const bare = expiredLane();
      paneless.add(bare.sessionId);
      const verdicts = nudge.tick(T0 + 31 * MIN);
      assert.equal(verdicts[web.sessionId], 'no-pane');
      assert.equal(verdicts[bare.sessionId], 'no-pane');
      assert.deepEqual(typed, []);
    });

    it('unprofiled-engine: an engine with no probed pane signature', () => {
      const l = expiredLane();
      nudge._internal.wakeProfiles = () => ({});
      assert.equal(verdict(l), 'unprofiled-engine');
      assert.deepEqual(typed, []);
    });

    it('wrap-running: nothing is typed while a wrap runs in the session', () => {
      const l = expiredLane();
      wrapRunning.add(l.project.name);
      assert.equal(verdict(l), 'wrap-running');
      assert.deepEqual(typed, []);
      wrapRunning.clear();
      assert.equal(verdict(l), 'nudged', 'and it is nudged once the wrap is over');
    });

    for (const [activity, code] of [['busy', 'engine-busy'], ['not-at-rest', 'engine-not-at-rest'], ['unknown', 'engine-unknown']]) {
      it(`${code}: nothing is typed while the engine is observed ${activity}`, () => {
        const l = expiredLane();
        engineBySession.set(l.sessionId, { activity, reason: 'test' });
        assert.equal(verdict(l), code);
        assert.deepEqual(typed, []);
        assert.deepEqual(facts(l), []);
      });
    }

    it('engine-unknown: a monitor with no observer types into nothing', () => {
      const l = expiredLane();
      nudge._internal.laneContext = realInternal.laneContext;
      assert.equal(verdict(l), 'engine-unknown');
      assert.deepEqual(typed, []);
    });

    it('lane-held: the pane writer refused a held lane, and nothing is recorded', () => {
      const l = expiredLane();
      injectResult = { ok: false, error: 'CONTROL_HELD: held', controlRefusal: { code: 'CONTROL_HELD' } };
      assert.equal(verdict(l), 'lane-held');
      assert.deepEqual(facts(l), []);
      injectResult = { ok: true, error: null };
      assert.equal(verdict(l), 'nudged', 'and it is nudged once the hold is released');
    });

    it('startup-dialog: the pane writer refused a pane showing a startup dialog, and nothing is recorded', () => {
      const l = expiredLane();
      injectResult = { ok: false, error: 'a startup dialog is up', startupDialog: { code: 'trust', label: 'Trust', meaning: 'm' } };
      assert.equal(verdict(l), 'startup-dialog');
      assert.deepEqual(facts(l), []);
    });

    it('send-failed: a pane that could not be typed into is tried again, and nothing is recorded', () => {
      const l = expiredLane();
      injectResult = { ok: false, error: 'tmux session "x" not found' };
      assert.equal(verdict(l), 'send-failed');
      assert.deepEqual(facts(l), []);
      injectResult = { ok: true, error: null };
      assert.equal(verdict(l), 'nudged');
      assert.equal(facts(l).length, 1);
    });
  });

  describe('the nudge', () => {
    it('nudged: one line into the session that expired, and one fact', () => {
      const l = expiredLane();
      assert.equal(verdict(l), 'nudged');
      assert.equal(typed.length, 1);
      assert.equal(typed[0].projectName, l.project.name);
      assert.deepEqual(typed[0].options, { sessionId: l.sessionId }, 'addressed to the session that was judged');
      const recorded = facts(l);
      assert.equal(recorded.length, 1);
      const f = recorded[0];
      assert.equal(f.kind, 'nudged');
      assert.equal(f.code, 'nudged');
      assert.equal(f.route, null);
      assert.equal(f.project_id, l.project.id);
      assert.equal(f.session_id, l.sessionId);
      assert.equal(f.launch_id, l.launchId);
      assert.equal(f.engine_activity, 'at-rest');
      assert.equal(f.engine_reason, 'at-rest');
      assert.equal(f.created_at, new Date(T0 + 31 * MIN).toISOString());
      assert.deepEqual(JSON.parse(f.detail_json), { receiptSeq: l.receipt.seq, silentSeconds: 31 * 60 });
    });

    it('an observer reading longer than the record allows is cut, never refused', () => {
      const l = expiredLane();
      engineBySession.set(l.sessionId, { activity: 'at-rest', reason: 'r'.repeat(200) });
      assert.equal(verdict(l), 'nudged');
      assert.equal(facts(l)[0].engine_reason.length, 64);
    });

    it('already-nudged: a second tick types nothing', () => {
      const l = expiredLane();
      assert.equal(verdict(l), 'nudged');
      assert.equal(verdict(l, T0 + 32 * MIN), 'already-nudged');
      assert.equal(verdict(l, T0 + 300 * MIN), 'already-nudged');
      assert.equal(typed.length, 1);
      assert.equal(facts(l).length, 1);
    });

    it('already-nudged: a restart, which forgets everything in memory, types nothing', () => {
      const l = expiredLane();
      assert.equal(verdict(l), 'nudged');
      nudge.stop();
      assert.equal(verdict(l, T0 + 40 * MIN), 'already-nudged');
      assert.equal(typed.length, 1);
    });

    it('answered: a fresh report is left alone, and its own expiry is nudged once', () => {
      const l = expiredLane();
      assert.equal(verdict(l), 'nudged');
      const second = reports(l, T0 + 35 * MIN);
      assert.equal(verdict(l, T0 + 36 * MIN), 'receipt-current');
      assert.equal(verdict(l, T0 + 64 * MIN), 'receipt-current');
      assert.equal(typed.length, 1);
      assert.equal(verdict(l, T0 + 66 * MIN), 'nudged');
      assert.equal(verdict(l, T0 + 67 * MIN), 'already-nudged');
      assert.equal(typed.length, 2);
      assert.equal(facts(l).length, 1, 'the first receipt keeps its one fact');
      assert.equal(store.workloadNudgeFacts.listForReceipt(second.receipt_id).length, 1);
    });

    it('one lane throwing does not stop the pass', () => {
      const broken = expiredLane();
      const fine = expiredLane();
      const real = nudge._internal.laneContext;
      nudge._internal.laneContext = (session, ...rest) => {
        if (session.id === broken.sessionId) throw new Error('store read failed');
        return real(session, ...rest);
      };
      const verdicts = nudge.tick(T0 + 31 * MIN);
      assert.equal(verdicts[broken.sessionId], 'check-failed');
      assert.equal(verdicts[fine.sessionId], 'nudged');
    });
  });

  describe('a nudge is never typed twice for one expiry when its record cannot be written', () => {
    it('remembers the nudge, does not type again, and writes the fact when the store takes it', () => {
      const l = expiredLane();
      let refuse = true;
      const attempts = [];
      nudge._internal.recordFact = (row) => {
        attempts.push(row);
        if (refuse) throw new Error('database is locked');
        return realInternal.recordFact(row);
      };
      assert.equal(verdict(l), 'nudged-unrecorded');
      assert.equal(typed.length, 1);
      assert.deepEqual(facts(l), []);

      assert.equal(verdict(l, T0 + 32 * MIN), 'nudged-unrecorded', 'the write is retried, the pane is not');
      assert.equal(verdict(l, T0 + 33 * MIN), 'nudged-unrecorded');
      assert.equal(typed.length, 1, 'never typed into a second time');
      assert.equal(attempts.length, 3);

      refuse = false;
      assert.equal(verdict(l, T0 + 34 * MIN), 'already-nudged');
      assert.equal(typed.length, 1);
      const recorded = facts(l);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].created_at, new Date(T0 + 31 * MIN).toISOString(), 'recorded with the time it was typed');
      assert.equal(verdict(l, T0 + 35 * MIN), 'already-nudged');
      assert.equal(attempts.length, 4, 'and the write is not attempted again once it landed');
    });

    it('still writes the fact when the session reported again before the store took it', () => {
      const l = expiredLane();
      let refuse = true;
      nudge._internal.recordFact = (row) => {
        if (refuse) throw new Error('database is locked');
        return realInternal.recordFact(row);
      };
      assert.equal(verdict(l), 'nudged-unrecorded');
      reports(l, T0 + 32 * MIN);
      refuse = false;
      assert.equal(verdict(l, T0 + 33 * MIN), 'receipt-current');
      assert.equal(facts(l).length, 1, 'the nudge that was typed is on record');
      assert.equal(typed.length, 1);
    });

    it('a fact another process already wrote is not an error and not a second line', () => {
      const l = expiredLane();
      const listFacts = nudge._internal.listFacts;
      // The other process records between this one's read and its send.
      let raced = false;
      nudge._internal.listFacts = (receiptId) => {
        const seen = listFacts(receiptId);
        if (!raced) {
          raced = true;
          store.workloadNudgeFacts.record({
            project_id: l.project.id, session_id: l.sessionId, launch_id: l.launchId, receipt_id: receiptId,
            kind: 'nudged', code: 'nudged', created_at: new Date(T0 + 31 * MIN).toISOString()
          });
        }
        return seen;
      };
      assert.equal(verdict(l), 'nudged');
      assert.equal(facts(l).length, 1);
      assert.equal(verdict(l, T0 + 32 * MIN), 'already-nudged');
      assert.equal(typed.length, 1);
    });
  });

  describe('the line', () => {
    it('the default is one line with no newline, and says how to report', () => {
      assert.equal(/[\r\n]/.test(nudge.DEFAULT_NUDGE_TEXT), false);
      assert.match(nudge.DEFAULT_NUDGE_TEXT, /tc workload set/);
      assert.ok(nudge.DEFAULT_NUDGE_TEXT.length <= 2000);
      const l = expiredLane();
      verdict(l);
      assert.equal(typed[0].command, nudge.DEFAULT_NUDGE_TEXT);
    });

    it('a project text replaces the default whole', () => {
      const l = expiredLane({ text: 'Report your workload now, please.' });
      verdict(l);
      assert.equal(typed[0].command, 'Report your workload now, please.');
    });

    it('a text over the limit, or one with a newline, never reaches the pane: the default is typed', () => {
      for (const text of ['x'.repeat(2001), 'two\nlines']) {
        const l = expiredLane({ text });
        assert.equal(verdict(l), 'nudged');
        assert.equal(typed.at(-1).command, nudge.DEFAULT_NUDGE_TEXT);
      }
    });
  });

  describe('what is logged', () => {
    /**
     * Run a function and return everything the logger emitted meanwhile.
     * @param {Function} fn - What to run
     * @returns {string}
     */
    const captureLogs = (fn) => {
      const lines = [];
      const level = getLevel();
      setConsoleStream({ write: (text) => lines.push(text) });
      setLevel('debug');
      try {
        fn();
      } finally {
        setConsoleStream(null);
        setLevel(level);
      }
      return lines.join('\n');
    };

    it('names the project and session, and never the nudge line or the receipt summary', () => {
      const secret = 'A project line nobody should find in a log.';
      const ok = expiredLane({ text: secret });
      const failing = expiredLane({ text: secret });
      const unwritten = expiredLane({ text: secret });
      nudge._internal.inject = (projectName, command, options) => {
        typed.push({ projectName, command, options });
        return projectName === failing.project.name ? { ok: false, error: 'pane gone' } : { ok: true, error: null };
      };
      nudge._internal.recordFact = (row) => {
        if (row.session_id === unwritten.sessionId) throw new Error('database is locked');
        return realInternal.recordFact(row);
      };
      const logged = captureLogs(() => {
        nudge.tick(T0 + 31 * MIN);
        nudge.tick(T0 + 32 * MIN);
      });
      assert.match(logged, new RegExp(ok.project.name));
      assert.match(logged, /Nudged a session whose workload report expired/);
      assert.match(logged, /Could not type the workload nudge/);
      assert.match(logged, /its record could not be written/);
      assert.equal(logged.includes(secret), false, 'the nudge line is not logged');
      assert.equal(logged.includes(nudge.DEFAULT_NUDGE_TEXT), false);
      assert.equal(logged.includes(SUMMARY), false, 'a receipt summary is not logged');
    });

    it('says which gate held a lane, once per change, and nothing for a project that never turned it on', () => {
      const held = expiredLane();
      engineBySession.set(held.sessionId, { activity: 'not-at-rest', reason: 'no-prompt' });
      const web = expiredLane();
      paneless.add(web.sessionId);
      const off = lane(undefined);
      const lineFor = (logged, l) => logged.split('\n')
        .filter((line) => line.includes('Workload nudge verdict for a session') && line.includes(`session=${l.sessionId} `));
      const waiting = captureLogs(() => {
        nudge.tick(T0 + 31 * MIN);
        nudge.tick(T0 + 32 * MIN);
        nudge.tick(T0 + 33 * MIN);
      });
      assert.equal(lineFor(waiting, held).length, 1, 'three ticks at one gate are one line');
      assert.match(lineFor(waiting, held)[0], /verdict=engine-not-at-rest/);
      assert.ok(lineFor(waiting, held)[0].includes(nudge.VERDICT_MEANINGS['engine-not-at-rest']));
      assert.match(lineFor(waiting, web)[0], /verdict=no-pane/);
      assert.deepEqual(lineFor(waiting, off), []);

      engineBySession.set(held.sessionId, { activity: 'at-rest', reason: 'at-rest' });
      const moved = captureLogs(() => {
        nudge.tick(T0 + 34 * MIN);
        nudge.tick(T0 + 35 * MIN);
      });
      assert.deepEqual(lineFor(moved, held).map((line) => /verdict=([a-z-]+)/.exec(line)[1]), ['nudged', 'already-nudged']);
    });

    it('logs a config that falls back once per session, describing the bad value without quoting it', () => {
      const bad = 'line one\nline two of a bad text';
      const l = expiredLane({ text: bad, escalateAfterMinutes: 9999 });
      const logged = captureLogs(() => {
        nudge.tick(T0 + 31 * MIN);
        nudge.tick(T0 + 32 * MIN);
      });
      assert.equal(logged.split('Project config falls back for the workload nudge').length - 1, 1);
      assert.match(logged, /workloadNudge\.text/);
      assert.match(logged, /workloadNudge\.escalateAfterMinutes/);
      assert.equal(logged.includes('line two of a bad text'), false);
      assert.ok(l);
    });
  });

  describe('the timer and its state', () => {
    it('drops the state of a session that is no longer listed', () => {
      const l = expiredLane();
      let refuse = true;
      nudge._internal.recordFact = (row) => {
        if (refuse) throw new Error('database is locked');
        return realInternal.recordFact(row);
      };
      assert.equal(verdict(l), 'nudged-unrecorded');
      const list = nudge._internal.listSessions;
      nudge._internal.listSessions = () => list().filter((s) => s.id !== l.sessionId);
      assert.equal(nudge.tick(T0 + 32 * MIN)[l.sessionId], undefined);
      // Listed again with the store working: nothing was kept to retry, so the
      // fact on record is the only thing that could stop a second line.
      nudge._internal.listSessions = list;
      refuse = false;
      assert.equal(verdict(l, T0 + 33 * MIN), 'nudged');
    });

    it('start is idempotent, takes the observer, and stop clears the timer', () => {
      const l = expiredLane();
      nudge._internal.laneContext = realInternal.laneContext;
      nudge.start({ observer: { get: () => ({ activity: 'at-rest', reason: 'at-rest' }) }, intervalMs: 3_600_000 });
      nudge.start({ observer: { get: () => ({ activity: 'busy', reason: 'second start is ignored' }) } });
      assert.equal(verdict(l), 'nudged', 'the first start\'s observer is the one read');
      nudge.stop();
      const again = expiredLane();
      assert.equal(verdict(again), 'engine-unknown', 'after stop there is no observer');
    });
  });
});
