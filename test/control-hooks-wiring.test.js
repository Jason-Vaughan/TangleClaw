'use strict';

/**
 * Car 65-B Slice 2 wiring (#2866).
 *
 * `lib/workload-nudge.js` — #2826 half: a mid-session `AskUserQuestion`
 * widget gets its own verdict (`'mid-session-question'`), distinct from the
 * generic `'startup-dialog'` boot-dialog bucket, so a reader (a log, the
 * escalation message sent to the lane's coordinator) is told the pane needs
 * a human to answer Claude Code's own menu directly, not that TangleClaw is
 * withholding something of its own. The verdict still escalates on the same
 * timer every non-deliberate verdict does.
 *
 * `lib/merge-role-guard.js` wiring into a real `gh pr merge` interception
 * point (#2601) is NOT covered here: `lib/control-hooks.js`'s own docstring
 * says `gh pr merge`/`gh release` trigger no local git hook at all, and the
 * guard's own module header names the real wiring points as a launch-env
 * `PATH` wrapper, a `tc` verb, or an engine shell hook — none of which exist
 * in this car's authorized file envelope (no `bin/`, no launch-env wrapper
 * script). Flagged to the dispatcher; this file covers only what this car's
 * envelope reaches.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const workloadFleet = require('../lib/workload-fleet');
const nudge = require('../lib/workload-nudge');
const startupDialog = require('../lib/startup-dialog');
const { bindProject } = require('./_shared-docs-callers');

const MIN = 60_000;
const T0 = Date.parse('2026-11-05T12:00:00.000Z');

describe('workload-nudge: mid-session AskUserQuestion is its own verdict (#2826 Slice 2, #2866)', () => {
  let tmpDir;
  const realInternal = { ...nudge._internal };
  let typed;
  let injectResult;
  let engineBySession;
  let mine;
  let seq = 0;

  const lane = (workloadNudgeSetting) => {
    seq += 1;
    const dir = path.join(tmpDir, `p${seq}`);
    fs.mkdirSync(dir);
    const project = store.projects.create({ name: `chw-lane-${seq}`, path: dir, engine: 'claude' });
    const cfg = store.projectConfig.load(dir);
    cfg.workloadNudge = { enabled: true, ...workloadNudgeSetting };
    store.projectConfig.save(dir, cfg);
    const bound = bindProject(project);
    engineBySession.set(bound.sessionId, { activity: 'at-rest', reason: 'at-rest' });
    mine.add(bound.sessionId);
    return { project, sessionId: bound.sessionId, launchId: bound.launchId };
  };

  const reports = (l, atMs) => store.workloadReceipts.append({
    project_id: l.project.id, session_id: l.sessionId, launch_id: l.launchId, assignment_id: null,
    state: 'working', clearance: 'do-not-clear', summary: 'x', wait_kind: null, wait_detail: null,
    refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null, source: 'tc-cli',
    received_at: new Date(atMs).toISOString()
  }, { minIntervalMs: 0, nowMs: atMs }).row;

  const expiredLane = () => {
    const l = lane({});
    return { ...l, receipt: reports(l, T0) };
  };

  const verdict = (l, atMs = T0 + 31 * MIN) => nudge.tick(atMs)[l.sessionId];

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-hooks-wiring-'));
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
    mine = new Set();
    nudge._internal.workspaceForProject = () => null;
    nudge._internal.sendMessage = (m) => Promise.resolve({ status: 'delivered', id: 'm', to: m.to });
    const observer = {
      get: (sessionId) => ({
        ...(engineBySession.get(sessionId) || { activity: 'unknown', reason: 'not-observed' }),
        observedAt: null, ageSeconds: 0, provenance: 'engine-observed'
      })
    };
    nudge._internal.listSessions = () => store.sessions.listLiveAll()
      .filter((s) => mine.has(s.id)).map((s) => ({ ...s, tmuxSession: `tc-test-${s.id}` }));
    nudge._internal.laneContext = (session, projectName, nowMs) => workloadFleet
      .laneContext(session, { observer, projectName, nowMs });
    nudge._internal.wrapRunning = () => false;
    nudge._internal.inject = (projectName, command, options) => {
      typed.push({ projectName, command, options });
      return injectResult;
    };
  });

  it('declares a non-empty meaning for mid-session-question, same as every other verdict', () => {
    assert.equal(typeof nudge.VERDICT_MEANINGS['mid-session-question'], 'string');
    assert.ok(nudge.VERDICT_MEANINGS['mid-session-question'].length > 20);
  });

  it('reads as mid-session-question, not the generic startup-dialog bucket, for Claude Code\'s own menu', () => {
    const l = expiredLane();
    injectResult = {
      ok: false, error: 'a mid-session menu is up',
      startupDialog: { code: startupDialog.ASK_USER_QUESTION, label: null, meaning: 'Claude Code\'s own menu' }
    };
    assert.equal(verdict(l), 'mid-session-question');
    assert.deepEqual(typed.length, 1, 'the send was attempted; the refusal is the pane writer\'s, not a gate before it');
  });

  it('still reads as the generic startup-dialog verdict for a boot-time dialog, unaffected', () => {
    const l = expiredLane();
    injectResult = { ok: false, error: 'a trust dialog is up', startupDialog: { code: 'trust', label: 'Trust', meaning: 'm' } };
    assert.equal(verdict(l), 'startup-dialog');
  });

  it('records no fact for either verdict: nothing was typed into the pane', () => {
    const l = expiredLane();
    injectResult = { ok: false, error: 'x', startupDialog: { code: startupDialog.ASK_USER_QUESTION } };
    verdict(l);
    assert.deepEqual(store.workloadNudgeFacts.listForReceipt(l.receipt.receipt_id), []);
  });

  it('is not in the deliberate set: it escalates on the same timer as startup-dialog, not silently forever', () => {
    assert.equal(nudge._coordinator !== undefined, true, 'sanity: the coordinator seam exists for escalation tests');
    // DELIBERATE is not exported, but its effect is observable: a lane recovers to
    // 'nudged' the instant the condition clears, the same as every escalating verdict
    // and unlike 'wrap-running'/'lane-held', which this module leaves alone on purpose.
    const l = expiredLane();
    injectResult = { ok: false, error: 'x', startupDialog: { code: startupDialog.ASK_USER_QUESTION } };
    assert.equal(verdict(l), 'mid-session-question');
    injectResult = { ok: true, error: null };
    assert.equal(verdict(l), 'nudged', 'the lane is nudged the moment the pane clears, so the next tick is not permanently withheld');
  });

  it('every verdict in VERDICT_MEANINGS still declares a real sentence (no regression to the shared table)', () => {
    for (const [code, meaning] of Object.entries(nudge.VERDICT_MEANINGS)) {
      assert.equal(typeof meaning, 'string', code);
      assert.ok(meaning.length > 20, code);
    }
  });
});
