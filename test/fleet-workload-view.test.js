'use strict';

// #349, #1923 (Architect Rulings A349, A1923): passive per-session
// idle/wedged classification and the fleet-wide/project-level workload
// view model built on top of it. Also covers #1046 (Ruling A1046,
// lib/version-cache-diagnostic.js) per that ruling's own "tests...
// co-located in the authorized Car 60-C test files" -- this file and
// test/switchboard-swarm-stats.test.js are the two files Car 60-C's
// envelope authorizes for #1046's tests.
//
// Every module under test is a pure library: no store, no route, no
// probing a real pane. Every assertion here drives the real exported
// function.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const fwv = require('../lib/fleet-workload-view');
const vcd = require('../lib/version-cache-diagnostic');

const NOW = '2026-11-03T12:00:00.000Z';
const MINUTE = 60 * 1000;
/** @param {number} ms @returns {string} */
const before = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

describe('fleet-workload-view: exported vocabulary', () => {
  it('exposes its own passive-state vocabulary and default thresholds', () => {
    assert.deepEqual(fwv.SESSION_STATES, ['active', 'idle', 'wedged', 'offline']);
    assert.deepEqual(fwv.DEFAULT_STALE_THRESHOLDS, { workingMs: 30 * MINUTE, owedMs: 30 * MINUTE });
  });
});

describe('fleet-workload-view: classifySessionState (#349)', () => {
  it('refuses a missing paneAlive or now', () => {
    assert.equal(fwv.classifySessionState({ now: NOW }).code, 'FLEET_WORKLOAD_VIEW_INVALID');
    assert.equal(fwv.classifySessionState({ paneAlive: true }).code, 'FLEET_WORKLOAD_VIEW_INVALID');
  });

  it('refuses an unrecognized workloadState or workloadClearance', () => {
    assert.equal(fwv.classifySessionState({ paneAlive: true, now: NOW, workloadState: 'bogus' }).code, 'FLEET_WORKLOAD_VIEW_INVALID');
    assert.equal(fwv.classifySessionState({ paneAlive: true, now: NOW, workloadClearance: 'bogus' }).code, 'FLEET_WORKLOAD_VIEW_INVALID');
  });

  it('a dead pane is offline regardless of its last asserted workload state', () => {
    const r = fwv.classifySessionState({ paneAlive: false, workloadState: 'working', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.result.state, 'offline');
  });

  it('workload complete with zero owed messages is idle', () => {
    const r = fwv.classifySessionState({ paneAlive: true, workloadState: 'complete', owedMessageCount: 0, now: NOW });
    assert.equal(r.result.state, 'idle');
  });

  it('a stale "working" declaration with no recent activity is wedged', () => {
    const r = fwv.classifySessionState({
      paneAlive: true, workloadState: 'working', lastActivityAt: before(60 * MINUTE), owedMessageCount: 0, now: NOW
    });
    assert.equal(r.result.state, 'wedged');
    assert.match(r.result.reasons[0], /declared "working"/);
  });

  it('a fresh "working" declaration is active, not wedged', () => {
    const r = fwv.classifySessionState({
      paneAlive: true, workloadState: 'working', lastActivityAt: before(5 * MINUTE), owedMessageCount: 0, now: NOW
    });
    assert.equal(r.result.state, 'active');
  });

  it('owed messages held stale with no recent activity is wedged, even if workloadState is complete', () => {
    const r = fwv.classifySessionState({
      paneAlive: true, workloadState: 'complete', owedMessageCount: 2, lastActivityAt: before(60 * MINUTE), now: NOW
    });
    assert.equal(r.result.state, 'wedged');
    assert.match(r.result.reasons[0], /owes 2 switchboard message/);
  });

  it('owed messages still fresh are not wedged', () => {
    const r = fwv.classifySessionState({
      paneAlive: true, workloadState: 'complete', owedMessageCount: 2, lastActivityAt: before(5 * MINUTE), now: NOW
    });
    assert.notEqual(r.result.state, 'wedged');
  });

  it('a session with no workload receipt at all and nothing owed is active, not idle or wedged', () => {
    const r = fwv.classifySessionState({ paneAlive: true, owedMessageCount: 0, now: NOW });
    assert.equal(r.result.state, 'active');
  });

  it('custom staleThresholds override the defaults', () => {
    const r = fwv.classifySessionState({
      paneAlive: true, workloadState: 'working', lastActivityAt: before(10 * MINUTE), owedMessageCount: 0, now: NOW,
      staleThresholds: { workingMs: 5 * MINUTE }
    });
    assert.equal(r.result.state, 'wedged');
  });
});

describe('fleet-workload-view: buildFleetWorkloadView (#1923)', () => {
  it('refuses a non-array sessions', () => {
    assert.equal(fwv.buildFleetWorkloadView('nope').code, 'FLEET_WORKLOAD_VIEW_INVALID');
  });

  it('refuses a session with no sessionId or no project', () => {
    assert.equal(fwv.buildFleetWorkloadView([{ project: 'p1' }]).code, 'FLEET_WORKLOAD_VIEW_INVALID');
    assert.equal(fwv.buildFleetWorkloadView([{ sessionId: 's1' }]).code, 'FLEET_WORKLOAD_VIEW_INVALID');
  });

  it('builds fleet-wide counts and a per-project breakdown over a mixed batch', () => {
    const r = fwv.buildFleetWorkloadView([
      { sessionId: 's1', project: 'p1', workloadState: 'complete', workloadClearance: 'safe-to-clear', owedMessageCount: 0, paneAlive: true },
      { sessionId: 's2', project: 'p1', workloadState: 'working', workloadClearance: 'do-not-clear', lastActivityAt: before(60 * MINUTE), paneAlive: true },
      { sessionId: 's3', project: 'p2', paneAlive: false }
    ], { now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.view.sessions.length, 3);
    assert.equal(r.view.countsByState.idle, 1);
    assert.equal(r.view.countsByState.wedged, 1);
    assert.equal(r.view.countsByState.offline, 1);
    assert.equal(r.view.safeToClearCount, 1);
    assert.equal(r.view.doNotClearCount, 1);
    assert.equal(r.view.wedgedCount, 1);
    assert.deepEqual(Object.keys(r.view.projects).sort(), ['p1', 'p2']);
    assert.equal(r.view.projects.p1.sessions.length, 2);
    assert.equal(r.view.projects.p1.wedgedCount, 1);
    assert.equal(r.view.projects.p2.sessions.length, 1);
    assert.equal(r.view.projects.p2.countsByState.offline, 1);
  });

  it('every SESSION_STATES / CLEARANCES key is present even at zero -- never a sparse count object', () => {
    const r = fwv.buildFleetWorkloadView([
      { sessionId: 's1', project: 'p1', workloadState: 'complete', owedMessageCount: 0, paneAlive: true }
    ], { now: NOW });
    assert.deepEqual(Object.keys(r.view.countsByState).sort(), ['active', 'idle', 'offline', 'wedged']);
    assert.deepEqual(Object.keys(r.view.countsByClearance).sort(), ['do-not-clear', 'safe-to-clear', 'unknown']);
  });

  it('defaults paneAlive to true when the field is omitted entirely', () => {
    const r = fwv.buildFleetWorkloadView([
      { sessionId: 's1', project: 'p1', workloadState: 'complete', owedMessageCount: 0 }
    ], { now: NOW });
    assert.equal(r.view.sessions[0].passiveState, 'idle');
  });

  it('propagates a classification failure (e.g. a bad workloadState) as the whole call\'s refusal', () => {
    const r = fwv.buildFleetWorkloadView([
      { sessionId: 's1', project: 'p1', workloadState: 'nonsense', paneAlive: true }
    ], { now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FLEET_WORKLOAD_VIEW_INVALID');
  });

  it('carries through refs/branch/headSha/summary/updatedAt unchanged when present', () => {
    const r = fwv.buildFleetWorkloadView([
      {
        sessionId: 's1', project: 'p1', paneAlive: true, owedMessageCount: 0,
        summary: 'doing a thing', refs: ['#1'], branch: 'feat/x', headSha: 'abc123', updatedAt: NOW
      }
    ], { now: NOW });
    const row = r.view.sessions[0];
    assert.equal(row.summary, 'doing a thing');
    assert.deepEqual(row.refs, ['#1']);
    assert.equal(row.branch, 'feat/x');
    assert.equal(row.headSha, 'abc123');
    assert.equal(row.updatedAt, NOW);
  });
});

describe('version-cache-diagnostic: exported vocabulary (#1046)', () => {
  it('exposes its own persistent-failure threshold', () => {
    assert.equal(vcd.PERSISTENT_FAILURE_THRESHOLD, 3);
  });
});

describe('version-cache-diagnostic: recordCacheWriteFailure (#1046)', () => {
  it('refuses a missing projectId, cachePath, now, or errorCode', () => {
    assert.equal(vcd.recordCacheWriteFailure({ cachePath: '/x', now: NOW, errorCode: 'EACCES' }).code, 'VERSION_CACHE_DIAGNOSTIC_INVALID');
    assert.equal(vcd.recordCacheWriteFailure({ projectId: 'p1', now: NOW, errorCode: 'EACCES' }).code, 'VERSION_CACHE_DIAGNOSTIC_INVALID');
    assert.equal(vcd.recordCacheWriteFailure({ projectId: 'p1', cachePath: '/x', errorCode: 'EACCES' }).code, 'VERSION_CACHE_DIAGNOSTIC_INVALID');
    assert.equal(vcd.recordCacheWriteFailure({ projectId: 'p1', cachePath: '/x', now: NOW }).code, 'VERSION_CACHE_DIAGNOSTIC_INVALID');
  });

  it('starts a fresh tracking record at consecutiveFailures 1 with no previousState', () => {
    const r = vcd.recordCacheWriteFailure({ projectId: 'p1', cachePath: '/x', errorCode: 'EACCES', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.state.consecutiveFailures, 1);
    assert.equal(r.state.firstFailureAt, NOW);
    assert.equal(r.banner, null);
  });

  it('increments consecutiveFailures and preserves firstFailureAt across repeated failures', () => {
    const first = vcd.recordCacheWriteFailure({ projectId: 'p1', cachePath: '/x', errorCode: 'EACCES', now: NOW });
    const second = vcd.recordCacheWriteFailure({
      projectId: 'p1', cachePath: '/x', errorCode: 'ENOSPC', now: before(-MINUTE), previousState: first.state
    });
    assert.equal(second.state.consecutiveFailures, 2);
    assert.equal(second.state.firstFailureAt, NOW);
    assert.equal(second.state.lastErrorCode, 'ENOSPC');
  });

  it('escalates to a banner exactly at the persistent-failure threshold, not before', () => {
    let state = null;
    let r;
    for (let i = 0; i < vcd.PERSISTENT_FAILURE_THRESHOLD - 1; i++) {
      r = vcd.recordCacheWriteFailure({ projectId: 'p1', cachePath: '/x', errorCode: 'EACCES', now: NOW, previousState: state });
      assert.equal(r.banner, null, `no banner before the threshold (failure ${i + 1})`);
      state = r.state;
    }
    r = vcd.recordCacheWriteFailure({ projectId: 'p1', cachePath: '/x', errorCode: 'EACCES', now: NOW, previousState: state });
    assert.ok(r.banner, 'banner fires at the threshold');
    assert.equal(r.banner.consecutiveFailures, vcd.PERSISTENT_FAILURE_THRESHOLD);
    assert.equal(r.banner.severity, 'persistent-write-failure');
  });

  it('a previousState belonging to a different project/cachePath does not carry its streak forward', () => {
    const otherProject = vcd.recordCacheWriteFailure({ projectId: 'p-other', cachePath: '/x', errorCode: 'EACCES', now: NOW });
    const r = vcd.recordCacheWriteFailure({
      projectId: 'p1', cachePath: '/x', errorCode: 'EACCES', now: NOW, previousState: otherProject.state
    });
    assert.equal(r.state.consecutiveFailures, 1);
  });
});

describe('version-cache-diagnostic: recordCacheWriteSuccess (#1046)', () => {
  it('refuses a missing projectId, cachePath, or now', () => {
    assert.equal(vcd.recordCacheWriteSuccess({ cachePath: '/x', now: NOW }).code, 'VERSION_CACHE_DIAGNOSTIC_INVALID');
  });

  it('clears an escalated failure streak back to zero with no banner', () => {
    let state = null;
    for (let i = 0; i < vcd.PERSISTENT_FAILURE_THRESHOLD; i++) {
      state = vcd.recordCacheWriteFailure({ projectId: 'p1', cachePath: '/x', errorCode: 'EACCES', now: NOW, previousState: state }).state;
    }
    const recovered = vcd.recordCacheWriteSuccess({ projectId: 'p1', cachePath: '/x', now: NOW });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.state.consecutiveFailures, 0);
    assert.equal(recovered.state.lastErrorCode, null);
    assert.equal(recovered.banner, null);
  });

  it('a subsequent failure after a recovery starts a fresh streak at 1, not a continuation', () => {
    const recovered = vcd.recordCacheWriteSuccess({ projectId: 'p1', cachePath: '/x', now: NOW });
    const r = vcd.recordCacheWriteFailure({
      projectId: 'p1', cachePath: '/x', errorCode: 'EROFS', now: NOW, previousState: recovered.state
    });
    assert.equal(r.state.consecutiveFailures, 1);
  });
});
