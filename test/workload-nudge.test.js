'use strict';

/**
 * The workload nudge monitor (#2262): which lanes get one line typed into
 * their pane, and which are left alone and why.
 *
 * The store is real: the receipts, the composition that says a receipt expired
 * and the record of a nudge are the ones the server uses. What the host would
 * have to supply is stubbed at the module's seams: the pane (nothing here runs
 * tmux), the activity observer's reading, the wrap registry, and the
 * switchboard (no message leaves the process).
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
  /** @type {Array<{to: string, message: string}>} Every switchboard send the monitor attempted. */
  let sent;
  /** A test's own send, or null for one the Hub accepts. */
  let sendMessage;
  /** Project id to the switchboard workspace of its live session. */
  let workspaces;
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
    sent = [];
    sendMessage = null;
    workspaces = new Map();
    // No test reaches the Hub or the workspace registry: both are the host's.
    nudge._internal.workspaceForProject = (project) => workspaces.get(project.id) || null;
    nudge._internal.sendMessage = (m) => {
      sent.push(m);
      return sendMessage ? sendMessage(m) : Promise.resolve({ status: 'delivered', id: `m${sent.length}`, to: m.to });
    };
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
      // Hours later the silence has been escalated (this lane names no
      // coordinator), and the pane has still had its one line.
      assert.equal(verdict(l, T0 + 300 * MIN), 'escalated-operator');
      assert.equal(verdict(l, T0 + 301 * MIN), 'already-escalated');
      assert.equal(typed.length, 1);
      assert.deepEqual(facts(l).map((f) => f.kind), ['nudged', 'escalated']);
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

  describe('the escalation', () => {
    /**
     * An enabled lane whose report expired, naming a coordinator project that
     * has a live switchboard workspace.
     * @param {object} [setting] - Extra `workloadNudge` keys for the silent lane
     * @returns {{l: object, c: object}} The silent lane and its coordinator
     */
    const coordinated = (setting = {}) => {
      const c = lane(undefined);
      workspaces.set(c.project.id, `ws-${c.project.name}`);
      return { l: expiredLane({ coordinatorProject: c.project.name, ...setting }), c };
    };
    const kinds = (l) => facts(l).map((f) => `${f.kind}/${f.route || '-'}`);

    it('declares a meaning for every code an escalation fact can carry', () => {
      for (const [code, meaning] of Object.entries(nudge.ESCALATION_MEANINGS)) {
        assert.equal(typeof meaning, 'string', code);
        assert.ok(meaning.length > 20, code);
      }
    });

    it('is not due until the set time after the nudge, then is one message to the coordinator workspace', async () => {
      const { l, c } = coordinated();
      assert.equal(verdict(l), 'nudged');
      assert.equal(verdict(l, T0 + 40 * MIN), 'already-nudged', 'nine minutes after the nudge');
      await nudge.settled();
      assert.deepEqual(sent, []);

      assert.equal(verdict(l, T0 + 41 * MIN), 'escalation-sending');
      await nudge.settled();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, `ws-${c.project.name}`);
      assert.deepEqual(kinds(l), ['nudged/-', 'escalated/coordinator']);
      const fact = facts(l)[1];
      assert.equal(fact.target_project_id, c.project.id);
      assert.equal(fact.code, 'escalated');
      assert.equal(fact.created_at, new Date(T0 + 41 * MIN).toISOString());
      assert.equal(fact.engine_activity, 'at-rest');
      assert.deepEqual(JSON.parse(fact.detail_json), { receiptSeq: l.receipt.seq, silentSeconds: 41 * 60, nudged: true, hubStatus: 'delivered' });
    });

    it('a second tick sends nothing, and neither does a restart', async () => {
      const { l } = coordinated();
      verdict(l);
      verdict(l, T0 + 41 * MIN);
      await nudge.settled();
      assert.equal(verdict(l, T0 + 42 * MIN), 'already-escalated');
      nudge.stop();
      assert.equal(verdict(l, T0 + 300 * MIN), 'already-escalated');
      await nudge.settled();
      assert.equal(sent.length, 1);
      assert.equal(typed.length, 1);
    });

    it('waits the minutes the project set', async () => {
      const { l } = coordinated({ escalateAfterMinutes: 2 });
      verdict(l);
      assert.equal(verdict(l, T0 + 32 * MIN), 'already-nudged');
      assert.equal(verdict(l, T0 + 33 * MIN), 'escalation-sending');
      await nudge.settled();
      assert.equal(sent.length, 1);
    });

    it('a fresh report before the deadline means no escalation for that expiry, ever', async () => {
      const { l } = coordinated();
      verdict(l);
      reports(l, T0 + 35 * MIN);
      for (const minute of [41, 50, 64]) assert.equal(verdict(l, T0 + minute * MIN), 'receipt-current');
      await nudge.settled();
      assert.deepEqual(sent, []);
      // The answer's own expiry is a new silence, with its own nudge and its own deadline.
      assert.equal(verdict(l, T0 + 66 * MIN), 'nudged');
      assert.equal(verdict(l, T0 + 75 * MIN), 'already-nudged');
      assert.equal(verdict(l, T0 + 76 * MIN), 'escalation-sending');
      await nudge.settled();
      assert.equal(sent.length, 1);
      assert.deepEqual(kinds(l), ['nudged/-'], 'the first receipt was answered and is never escalated');
    });

    it('the coordinator is whoever the config names, whatever the projects are called', async () => {
      const { l, c } = coordinated();
      const decoy = lane(undefined);
      workspaces.set(decoy.project.id, 'ws-decoy');
      verdict(l);
      verdict(l, T0 + 41 * MIN);
      await nudge.settled();
      assert.deepEqual(sent.map((m) => m.to), [`ws-${c.project.name}`]);
    });

    it('a coordinator with no live session: recorded as unreachable, and escalated on the operator route', async () => {
      const { l, c } = coordinated();
      workspaces.delete(c.project.id);
      verdict(l);
      assert.equal(verdict(l, T0 + 41 * MIN), 'escalated-operator');
      await nudge.settled();
      assert.deepEqual(sent, []);
      assert.deepEqual(kinds(l), ['nudged/-', 'escalation-undeliverable/coordinator', 'escalated/operator']);
      const [, unreachable, operator] = facts(l);
      assert.equal(unreachable.code, 'coordinator-no-live-session');
      assert.equal(unreachable.target_project_id, c.project.id);
      assert.equal(operator.code, 'coordinator-no-live-session');
      assert.equal(operator.target_project_id, null);
      // The coordinator coming back does not reopen an escalation already made.
      workspaces.set(c.project.id, 'ws-late');
      assert.equal(verdict(l, T0 + 42 * MIN), 'already-escalated');
      await nudge.settled();
      assert.deepEqual(sent, []);
    });

    it('a coordinator name that matches no project is recorded, never dropped', async () => {
      const l = expiredLane({ coordinatorProject: 'no-such-project-anywhere' });
      verdict(l);
      assert.equal(verdict(l, T0 + 41 * MIN), 'escalated-operator');
      assert.deepEqual(kinds(l), ['nudged/-', 'escalation-undeliverable/coordinator', 'escalated/operator']);
      const unreachable = facts(l)[1];
      assert.equal(unreachable.code, 'coordinator-unknown-project');
      assert.equal(unreachable.target_project_id, null);
      assert.equal(JSON.parse(unreachable.detail_json).coordinator, 'no-such-project-anywhere');
      assert.deepEqual(sent, []);
    });

    it('a lane that names itself, or nobody, goes to the operator route with no message to any project', async () => {
      const nobody = expiredLane();
      const selfNamed = lane(undefined);
      const cfg = store.projectConfig.load(selfNamed.project.path);
      cfg.workloadNudge = { enabled: true, coordinatorProject: selfNamed.project.name };
      store.projectConfig.save(selfNamed.project.path, cfg);
      selfNamed.receipt = reports(selfNamed, T0);
      workspaces.set(selfNamed.project.id, 'ws-self');
      nudge.tick(T0 + 31 * MIN);
      const verdicts = nudge.tick(T0 + 41 * MIN);
      await nudge.settled();
      assert.equal(verdicts[nobody.sessionId], 'escalated-operator');
      assert.equal(verdicts[selfNamed.sessionId], 'escalated-operator');
      assert.deepEqual(kinds(nobody), ['nudged/-', 'escalated/operator']);
      assert.equal(facts(nobody)[1].code, 'no-coordinator');
      assert.deepEqual(kinds(selfNamed), ['nudged/-', 'escalated/operator']);
      assert.equal(facts(selfNamed)[1].code, 'coordinator-is-self');
      assert.deepEqual(sent, []);
    });

    it('a send that throws is not counted as sent, and the next tick tries again', async () => {
      const { l } = coordinated();
      verdict(l);
      sendMessage = async () => { throw new Error('Message bridge unreachable'); };
      assert.equal(verdict(l, T0 + 41 * MIN), 'escalation-sending');
      await nudge.settled();
      assert.deepEqual(kinds(l), ['nudged/-'], 'nothing says the coordinator was told');
      sendMessage = null;
      assert.equal(verdict(l, T0 + 42 * MIN), 'escalation-sending');
      await nudge.settled();
      assert.equal(sent.length, 2, 'both attempts reached the send');
      assert.deepEqual(kinds(l), ['nudged/-', 'escalated/coordinator']);
      assert.equal(verdict(l, T0 + 43 * MIN), 'already-escalated');
    });

    it('a Hub that never takes the message: after the last attempt the coordinator is recorded as unreachable', async () => {
      const { l, c } = coordinated();
      verdict(l);
      sendMessage = async () => { throw new Error('Message bridge unreachable'); };
      for (let attempt = 0; attempt < nudge.MAX_SEND_ATTEMPTS; attempt += 1) {
        assert.equal(verdict(l, T0 + (41 + attempt) * MIN), 'escalation-sending', `attempt ${attempt + 1}`);
        await nudge.settled();
      }
      assert.equal(sent.length, nudge.MAX_SEND_ATTEMPTS);
      assert.equal(verdict(l, T0 + 50 * MIN), 'escalated-operator');
      await nudge.settled();
      assert.equal(sent.length, nudge.MAX_SEND_ATTEMPTS, 'no further attempt');
      assert.deepEqual(kinds(l), ['nudged/-', 'escalation-undeliverable/coordinator', 'escalated/operator']);
      assert.equal(facts(l)[1].code, 'coordinator-send-failed');
      assert.equal(facts(l)[1].target_project_id, c.project.id);
    });

    it('a send the Hub has not answered is not sent again by the next tick', async () => {
      const { l } = coordinated();
      verdict(l);
      let answer;
      sendMessage = () => new Promise((resolve) => { answer = resolve; });
      assert.equal(verdict(l, T0 + 41 * MIN), 'escalation-sending');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(verdict(l, T0 + 42 * MIN), 'escalation-sending');
      assert.equal(verdict(l, T0 + 43 * MIN), 'escalation-sending');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sent.length, 1);
      answer({ status: 'queued', id: 'm1' });
      await nudge.settled();
      assert.deepEqual(kinds(l), ['nudged/-', 'escalated/coordinator']);
      assert.equal(JSON.parse(facts(l)[1].detail_json).hubStatus, 'queued');
    });

    it('a message accepted whose record cannot be written is never sent twice', async () => {
      const { l } = coordinated();
      verdict(l);
      let refuse = true;
      nudge._internal.recordFact = (row) => {
        if (refuse && row.kind === 'escalated') throw new Error('database is locked');
        return realInternal.recordFact(row);
      };
      assert.equal(verdict(l, T0 + 41 * MIN), 'escalation-sending');
      await nudge.settled();
      assert.deepEqual(kinds(l), ['nudged/-']);
      assert.equal(verdict(l, T0 + 42 * MIN), 'escalated-unrecorded');
      assert.equal(verdict(l, T0 + 43 * MIN), 'escalated-unrecorded');
      await nudge.settled();
      assert.equal(sent.length, 1);
      refuse = false;
      assert.equal(verdict(l, T0 + 44 * MIN), 'already-escalated');
      assert.deepEqual(kinds(l), ['nudged/-', 'escalated/coordinator']);
      assert.equal(facts(l)[1].created_at, new Date(T0 + 41 * MIN).toISOString(), 'recorded with the time it was sent');
      assert.equal(sent.length, 1);
    });

    it('an operator-route record the store refuses is written on a later tick, once', async () => {
      const { l, c } = coordinated();
      workspaces.delete(c.project.id);
      verdict(l);
      let refuse = true;
      nudge._internal.recordFact = (row) => {
        if (refuse && row.kind === 'escalated') throw new Error('database is locked');
        return realInternal.recordFact(row);
      };
      assert.equal(verdict(l, T0 + 41 * MIN), 'check-failed');
      assert.deepEqual(kinds(l), ['nudged/-', 'escalation-undeliverable/coordinator']);
      refuse = false;
      assert.equal(verdict(l, T0 + 42 * MIN), 'escalated-operator');
      assert.deepEqual(kinds(l), ['nudged/-', 'escalation-undeliverable/coordinator', 'escalated/operator']);
      assert.equal(facts(l)[2].code, 'coordinator-no-live-session');
    });

    describe('a lane that could not be nudged', () => {
      /** Each way a pane cannot be typed into that nobody chose, and how a test brings it about. */
      const cannot = {
        'engine-busy': (l) => engineBySession.set(l.sessionId, { activity: 'busy', reason: 'spinner' }),
        'engine-not-at-rest': (l) => engineBySession.set(l.sessionId, { activity: 'not-at-rest', reason: 'no-prompt' }),
        'engine-unknown': (l) => engineBySession.delete(l.sessionId),
        'no-pane': (l) => paneless.add(l.sessionId),
        'unprofiled-engine': () => { nudge._internal.wakeProfiles = () => ({}); },
        'startup-dialog': () => { injectResult = { ok: false, error: 'a startup dialog is up', startupDialog: { code: 'trust' } }; },
        'send-failed': () => { injectResult = { ok: false, error: 'tmux session "x" not found' }; }
      };
      for (const [code, arrange] of Object.entries(cannot)) {
        it(`${code}: escalated with that reason once the time has passed since the report expired`, async () => {
          const { l, c } = coordinated();
          arrange(l);
          assert.equal(verdict(l), code);
          assert.equal(verdict(l, T0 + 39 * MIN), code, 'nine minutes after the expiry');
          await nudge.settled();
          assert.deepEqual(sent, []);
          assert.deepEqual(facts(l), []);

          assert.equal(verdict(l, T0 + 40 * MIN), 'escalation-sending');
          await nudge.settled();
          assert.equal(sent.length, 1);
          assert.equal(sent[0].to, `ws-${c.project.name}`);
          assert.match(sent[0].message, /It was not nudged: /);
          assert.ok(sent[0].message.includes(nudge.VERDICT_MEANINGS[code].split(';')[0]));
          assert.deepEqual(kinds(l), ['not-nudged/-', 'escalated/coordinator']);
          assert.equal(facts(l)[0].code, code);
          assert.equal(JSON.parse(facts(l)[1].detail_json).nudged, false);
          assert.equal(verdict(l, T0 + 41 * MIN), 'already-escalated');
          assert.deepEqual(kinds(l), ['not-nudged/-', 'escalated/coordinator'], 'one reason row, not one per tick');
        });
      }

      it('is not nudged afterwards, when its pane comes to rest: the coordinator was told it was not', async () => {
        const { l } = coordinated();
        engineBySession.set(l.sessionId, { activity: 'busy', reason: 'spinner' });
        verdict(l);
        assert.equal(verdict(l, T0 + 40 * MIN), 'escalation-sending');
        await nudge.settled();
        engineBySession.set(l.sessionId, { activity: 'at-rest', reason: 'at-rest' });
        assert.equal(verdict(l, T0 + 41 * MIN), 'already-escalated');
        nudge.stop();
        assert.equal(verdict(l, T0 + 60 * MIN), 'already-escalated', 'nor after a restart');
        assert.deepEqual(typed, []);
        assert.deepEqual(kinds(l), ['not-nudged/-', 'escalated/coordinator']);
      });

      it('a report that lasts 120 minutes is measured from its own expiry', async () => {
        const c = lane(undefined);
        workspaces.set(c.project.id, 'ws-c');
        const l = lane({ enabled: true, coordinatorProject: c.project.name });
        l.receipt = reports(l, T0, 'waiting-external');
        paneless.add(l.sessionId);
        assert.equal(verdict(l, T0 + 129 * MIN), 'no-pane');
        assert.equal(verdict(l, T0 + 130 * MIN), 'escalation-sending');
        await nudge.settled();
        assert.equal(sent.length, 1);
      });

      it('a pane that comes to rest before the deadline is nudged, and the deadline then runs from the nudge', async () => {
        const { l } = coordinated();
        engineBySession.set(l.sessionId, { activity: 'not-at-rest', reason: 'no-prompt' });
        assert.equal(verdict(l), 'engine-not-at-rest');
        engineBySession.set(l.sessionId, { activity: 'at-rest', reason: 'at-rest' });
        assert.equal(verdict(l, T0 + 38 * MIN), 'nudged');
        assert.equal(verdict(l, T0 + 47 * MIN), 'already-nudged');
        assert.equal(verdict(l, T0 + 48 * MIN), 'escalation-sending');
        await nudge.settled();
        assert.match(sent[0].message, /It was nudged in its pane 10 minute\(s\) ago/);
        assert.deepEqual(kinds(l), ['nudged/-', 'escalated/coordinator']);
      });

      it('a pane first typeable after the deadline is nudged on that tick, not escalated on it', async () => {
        const { l } = coordinated();
        engineBySession.set(l.sessionId, { activity: 'busy', reason: 'spinner' });
        assert.equal(verdict(l, T0 + 35 * MIN), 'engine-busy');
        engineBySession.set(l.sessionId, { activity: 'at-rest', reason: 'at-rest' });
        nudge.stop(); // a restart: nothing in memory says how long the lane waited
        assert.equal(verdict(l, T0 + 60 * MIN), 'nudged');
        await nudge.settled();
        assert.deepEqual(sent, []);
        assert.equal(verdict(l, T0 + 70 * MIN), 'escalation-sending');
        await nudge.settled();
        assert.equal(sent.length, 1);
      });
    });

    describe('a lane left alone on purpose is not escalated', () => {
      it('wrap-running: never nudged, never escalated, however long', async () => {
        const { l } = coordinated();
        wrapRunning.add(l.project.name);
        assert.equal(verdict(l), 'wrap-running');
        assert.equal(verdict(l, T0 + 300 * MIN), 'wrap-running');
        await nudge.settled();
        assert.deepEqual(sent, []);
        assert.deepEqual(facts(l), []);
      });

      it('lane-held: a lane the pane writer refuses as held is not escalated', async () => {
        const { l } = coordinated();
        injectResult = { ok: false, error: 'CONTROL_HELD: held', controlRefusal: { code: 'CONTROL_HELD' } };
        assert.equal(verdict(l), 'lane-held');
        assert.equal(verdict(l, T0 + 300 * MIN), 'lane-held');
        await nudge.settled();
        assert.deepEqual(sent, []);
        assert.deepEqual(facts(l), []);
      });

      it('a lane nudged and then held, stopped or wrapped is not escalated until that ends', async () => {
        const { l } = coordinated();
        verdict(l);
        wrapRunning.add(l.project.name);
        assert.equal(verdict(l, T0 + 41 * MIN), 'wrap-running');
        wrapRunning.clear();
        const composed = nudge._internal.laneContext;
        for (const availability of ['HELD', 'STOPPED']) {
          nudge._internal.laneContext = (...args) => {
            const ctx = composed(...args);
            return { ...ctx, lane: { ...ctx.lane, composed: { ...ctx.lane.composed, availability } } };
          };
          assert.equal(verdict(l, T0 + 42 * MIN), 'lane-held', availability);
        }
        await nudge.settled();
        assert.deepEqual(sent, []);
        assert.deepEqual(kinds(l), ['nudged/-']);
        nudge._internal.laneContext = composed;
        assert.equal(verdict(l, T0 + 43 * MIN), 'escalation-sending');
        await nudge.settled();
        assert.equal(sent.length, 1);
      });

      it('a web UI lane running a wrap is not escalated for having no pane', async () => {
        const { l } = coordinated();
        paneless.add(l.sessionId);
        wrapRunning.add(l.project.name);
        assert.equal(verdict(l, T0 + 60 * MIN), 'wrap-running');
        await nudge.settled();
        assert.deepEqual(sent, []);
        assert.deepEqual(facts(l), []);
      });
    });

    describe('the message', () => {
      it('names the lane, how long it has been silent and what the engine was observed doing', async () => {
        const secret = 'A project line nobody should find in a message.';
        const { l } = coordinated({ text: secret });
        verdict(l);
        engineBySession.set(l.sessionId, { activity: 'not-at-rest', reason: 'no-prompt' });
        verdict(l, T0 + 41 * MIN);
        await nudge.settled();
        const { message } = sent[0];
        assert.ok(message.includes(`"${l.project.name}"`));
        assert.match(message, /has not reported its workload for 41 minute\(s\)/);
        assert.match(message, /It was nudged in its pane 10 minute\(s\) ago and has not answered\./);
        assert.match(message, /Its engine was last observed not-at-rest \(no-prompt\)\./);
        assert.match(message, /restarted, cleared and ended nothing/);
        assert.equal(message.includes('\n'), false);
        assert.equal(message.includes(SUMMARY), false, 'nothing from the receipt summary');
        assert.equal(message.includes(secret), false, 'nothing from the nudge text');
        assert.equal(facts(l)[1].engine_activity, 'not-at-rest', 'the record keeps the same reading');
      });

      it('is a fixed template over the values it is given', () => {
        const body = nudge.escalationBody({
          projectName: 'lane-x', silentMinutes: 44, activity: 'unknown', reason: null, nudgedMinutesAgo: null, notNudgedCode: 'no-pane'
        });
        assert.equal(body, '[TangleClaw] Lane "lane-x" has not reported its workload for 44 minute(s): its last report expired and '
          + 'no new one has arrived. It was not nudged: the session has no tmux pane to type into (a web UI session). '
          + 'Its engine was last observed unknown. TangleClaw has restarted, cleared and ended nothing. `tc sessions` shows the lane. '
          + 'This notice is sent once for this report and needs no reply.');
      });
    });

    it('logs name the lane and its coordinator, and never the message, the nudge line or the receipt summary', async () => {
      const secret = 'A project line nobody should find in a log.';
      const ok = coordinated({ text: secret });
      const failing = coordinated({ text: secret });
      const alone = expiredLane({ text: secret });
      sendMessage = async (m) => {
        if (m.to === `ws-${failing.c.project.name}`) throw new Error('Message bridge unreachable');
        return { status: 'delivered', id: 'm' };
      };
      const lines = [];
      const level = getLevel();
      setConsoleStream({ write: (text) => lines.push(text) });
      setLevel('debug');
      try {
        nudge.tick(T0 + 31 * MIN);
        nudge.tick(T0 + 41 * MIN);
        await nudge.settled();
      } finally {
        setConsoleStream(null);
        setLevel(level);
      }
      const logged = lines.join('\n');
      assert.match(logged, /Escalated a silent lane to its coordinator/);
      assert.ok(logged.includes(`coordinator=${ok.c.project.name}`));
      assert.match(logged, /Could not send a silent lane's escalation to its coordinator/);
      assert.match(logged, /no coordinator that can be told/);
      assert.ok(logged.includes(nudge.ESCALATION_MEANINGS['no-coordinator']));
      assert.ok(logged.includes(alone.project.name));
      assert.ok(sent.length >= 2);
      for (const m of sent) assert.equal(logged.includes(m.message), false, 'the message body is not logged');
      assert.equal(logged.includes(secret), false);
      assert.equal(logged.includes(SUMMARY), false);
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
