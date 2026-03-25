'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');

setLevel('error');

describe('store.evalExchanges', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eval-exch-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insert and get an exchange', () => {
    const ex = store.evalExchanges.insert({
      sessionId: 'sess-1',
      connectionId: 'conn-1',
      project: 'TestProject',
      agentModel: 'claude-opus-4-6',
      timestamp: '2026-03-24T10:00:00Z',
      turnNumber: 1,
      userMessage: 'Hello',
      agentResponse: 'Hi there!',
      agentThinking: 'User is greeting me',
      usageInputTokens: 10,
      usageOutputTokens: 20
    });

    assert.ok(ex.id);
    assert.equal(ex.sessionId, 'sess-1');
    assert.equal(ex.project, 'TestProject');
    assert.equal(ex.userMessage, 'Hello');
    assert.equal(ex.agentResponse, 'Hi there!');
    assert.equal(ex.agentThinking, 'User is greeting me');
    assert.equal(ex.turnNumber, 1);
    assert.equal(ex.scored, 0);

    const fetched = store.evalExchanges.get(ex.id);
    assert.deepEqual(fetched, ex);
  });

  it('list with filters', () => {
    store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg1', agentResponse: 'resp1'
    });
    store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:01:00Z',
      userMessage: 'msg2', agentResponse: 'resp2'
    });
    store.evalExchanges.insert({
      sessionId: 'sess-2', project: 'B', timestamp: '2026-03-24T10:02:00Z',
      userMessage: 'msg3', agentResponse: 'resp3'
    });

    const allA = store.evalExchanges.list({ project: 'A' });
    assert.equal(allA.length, 2);

    const sess2 = store.evalExchanges.list({ sessionId: 'sess-2' });
    assert.equal(sess2.length, 1);
    assert.equal(sess2[0].project, 'B');

    const limited = store.evalExchanges.list({ project: 'A', limit: 1 });
    assert.equal(limited.length, 1);
  });

  it('updateScored changes the scored status', () => {
    const ex = store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg', agentResponse: 'resp'
    });

    assert.equal(ex.scored, 0);
    store.evalExchanges.updateScored(ex.id, 1);
    assert.equal(store.evalExchanges.get(ex.id).scored, 1);

    store.evalExchanges.updateScored(ex.id, 2);
    assert.equal(store.evalExchanges.get(ex.id).scored, 2);
  });

  it('count with filters', () => {
    store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg1', agentResponse: 'resp1'
    });
    store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:01:00Z',
      userMessage: 'msg2', agentResponse: 'resp2'
    });

    assert.equal(store.evalExchanges.count({ project: 'A' }), 2);
    assert.equal(store.evalExchanges.count({ project: 'B' }), 0);
    assert.equal(store.evalExchanges.count({ sessionId: 'sess-1' }), 2);
  });

  it('list with date range filters', () => {
    store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-20T10:00:00Z',
      userMessage: 'old', agentResponse: 'old'
    });
    store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'new', agentResponse: 'new'
    });

    const recent = store.evalExchanges.list({ project: 'A', from: '2026-03-23T00:00:00Z' });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].userMessage, 'new');
  });

  it('get returns null for nonexistent id', () => {
    assert.equal(store.evalExchanges.get('nonexistent'), null);
  });

  it('listSessions returns distinct sessions with counts', () => {
    store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg1', agentResponse: 'resp1'
    });
    store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:01:00Z',
      userMessage: 'msg2', agentResponse: 'resp2'
    });
    store.evalExchanges.insert({
      sessionId: 'sess-2', project: 'A', timestamp: '2026-03-24T11:00:00Z',
      userMessage: 'msg3', agentResponse: 'resp3'
    });
    store.evalExchanges.insert({
      sessionId: 'sess-3', project: 'B', timestamp: '2026-03-24T12:00:00Z',
      userMessage: 'msg4', agentResponse: 'resp4'
    });

    const sessions = store.evalExchanges.listSessions('A');
    assert.equal(sessions.length, 2);
    // Most recent session first
    assert.equal(sessions[0].sessionId, 'sess-2');
    assert.equal(sessions[0].exchangeCount, 1);
    assert.equal(sessions[1].sessionId, 'sess-1');
    assert.equal(sessions[1].exchangeCount, 2);
  });

  it('listSessions respects limit', () => {
    store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg1', agentResponse: 'resp1'
    });
    store.evalExchanges.insert({
      sessionId: 'sess-2', project: 'A', timestamp: '2026-03-24T11:00:00Z',
      userMessage: 'msg2', agentResponse: 'resp2'
    });

    const sessions = store.evalExchanges.listSessions('A', { limit: 1 });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 'sess-2');
  });
});

describe('store.evalScores', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eval-scores-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insert and get a score', () => {
    const ex = store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg', agentResponse: 'resp'
    });

    const score = store.evalScores.insert({
      exchangeId: ex.id,
      schemaVersion: 'genesis-v1',
      judgeModel: 'structural',
      scoredAt: '2026-03-24T10:00:05Z',
      methodology: 'genesis',
      tier1StructuralScore: 0.8,
      tier1Flags: ['constraint_disclosure'],
      tier2Skipped: true,
      tier2_5Skipped: true,
      tier3Skipped: true,
      anomalyFlag: true,
      anomalyReason: 'Structural: constraint_disclosure',
      costUsd: 0
    });

    assert.ok(score.id);
    assert.equal(score.exchangeId, ex.id);
    assert.equal(score.schemaVersion, 'genesis-v1');
    assert.equal(score.tier1StructuralScore, 0.8);
    assert.deepEqual(score.tier1Flags, ['constraint_disclosure']);
    assert.equal(score.tier2Skipped, true);
    assert.equal(score.anomalyFlag, true);

    const fetched = store.evalScores.get(score.id);
    assert.deepEqual(fetched, score);
  });

  it('getByExchange returns the score for an exchange', () => {
    const ex = store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg', agentResponse: 'resp'
    });

    store.evalScores.insert({
      exchangeId: ex.id, schemaVersion: 'v1', judgeModel: 'structural',
      scoredAt: '2026-03-24T10:00:05Z', tier1StructuralScore: 1.0,
      tier2Skipped: true, tier2_5Skipped: true, tier3Skipped: true, costUsd: 0
    });

    const score = store.evalScores.getByExchange(ex.id);
    assert.ok(score);
    assert.equal(score.exchangeId, ex.id);
  });

  it('listByProject joins exchange data', () => {
    const ex = store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'MyProject', timestamp: '2026-03-24T10:00:00Z',
      turnNumber: 3, userMessage: 'msg', agentResponse: 'resp'
    });

    store.evalScores.insert({
      exchangeId: ex.id, schemaVersion: 'v1', judgeModel: 'structural',
      scoredAt: '2026-03-24T10:00:05Z', methodology: 'prawduct',
      tier1StructuralScore: 1.0, tier2Skipped: true, tier2_5Skipped: true,
      tier3Skipped: true, costUsd: 0
    });

    const results = store.evalScores.listByProject('MyProject');
    assert.equal(results.length, 1);
    assert.equal(results[0].project, 'MyProject');
    assert.equal(results[0].sessionId, 'sess-1');
    assert.equal(results[0].turnNumber, 3);
  });

  it('list with anomaliesOnly filter', () => {
    const ex1 = store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg1', agentResponse: 'resp1'
    });
    const ex2 = store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:01:00Z',
      userMessage: 'msg2', agentResponse: 'resp2'
    });

    store.evalScores.insert({
      exchangeId: ex1.id, schemaVersion: 'v1', judgeModel: 'structural',
      scoredAt: '2026-03-24T10:00:05Z', tier1StructuralScore: 1.0,
      tier2Skipped: true, tier2_5Skipped: true, tier3Skipped: true,
      anomalyFlag: false, costUsd: 0
    });
    store.evalScores.insert({
      exchangeId: ex2.id, schemaVersion: 'v1', judgeModel: 'structural',
      scoredAt: '2026-03-24T10:01:05Z', tier1StructuralScore: 0.5,
      tier1Flags: ['silent_refusal'], tier2Skipped: true, tier2_5Skipped: true,
      tier3Skipped: true, anomalyFlag: true, anomalyReason: 'structural failure', costUsd: 0
    });

    const all = store.evalScores.list();
    assert.equal(all.length, 2);

    const anomalies = store.evalScores.list({ anomaliesOnly: true });
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].anomalyFlag, true);
  });

  it('update modifies Tier 2/3 fields on existing score', () => {
    const ex = store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg', agentResponse: 'resp'
    });

    const score = store.evalScores.insert({
      exchangeId: ex.id, schemaVersion: 'v1', judgeModel: 'structural',
      scoredAt: '2026-03-24T10:00:05Z', tier1StructuralScore: 1.0,
      tier2Skipped: true, tier2_5Skipped: true, tier3Skipped: true, costUsd: 0
    });

    const updated = store.evalScores.update(score.id, {
      judgeModel: 'claude-haiku-4-5-20251001',
      tier2SemanticScore: 0.85,
      tier2Reasoning: 'scope ok; info complete',
      tier2Skipped: false,
      tier3BehavioralScore: 4.2,
      tier3DimensionScores: { transparency: { score: 4, reasoning: 'good' }, tone: { score: 5, reasoning: 'great' } },
      tier3Skipped: false,
      anomalyFlag: false,
      anomalyReason: null,
      costUsd: 0.002
    });

    assert.equal(updated.judgeModel, 'claude-haiku-4-5-20251001');
    assert.equal(updated.tier2SemanticScore, 0.85);
    assert.equal(updated.tier2Reasoning, 'scope ok; info complete');
    assert.equal(updated.tier2Skipped, false);
    assert.equal(updated.tier3BehavioralScore, 4.2);
    assert.deepEqual(updated.tier3DimensionScores, { transparency: { score: 4, reasoning: 'good' }, tone: { score: 5, reasoning: 'great' } });
    assert.equal(updated.tier3Skipped, false);
    assert.equal(updated.costUsd, 0.002);

    // Verify persistence
    const fetched = store.evalScores.get(score.id);
    assert.equal(fetched.tier2SemanticScore, 0.85);
    assert.equal(fetched.tier3BehavioralScore, 4.2);
  });

  it('update with no fields returns unchanged record', () => {
    const ex = store.evalExchanges.insert({
      sessionId: 'sess-1', project: 'A', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'msg', agentResponse: 'resp'
    });

    const score = store.evalScores.insert({
      exchangeId: ex.id, schemaVersion: 'v1', judgeModel: 'structural',
      scoredAt: '2026-03-24T10:00:05Z', tier1StructuralScore: 1.0,
      tier2Skipped: true, tier2_5Skipped: true, tier3Skipped: true, costUsd: 0
    });

    const same = store.evalScores.update(score.id, {});
    assert.equal(same.id, score.id);
    assert.equal(same.tier2Skipped, true);
  });
});

describe('store.evalBaselines', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eval-baselines-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insert and get a baseline', () => {
    const bl = store.evalBaselines.insert({
      project: 'MyProject',
      methodology: 'genesis',
      computedAt: '2026-03-24T10:00:00Z',
      windowStart: '2026-03-10T00:00:00Z',
      windowEnd: '2026-03-24T00:00:00Z',
      dimensionAverages: { transparency: 4.2, tone_alignment: 3.8 },
      exchangeCount: 150,
      schemaVersion: 'genesis-v1'
    });

    assert.ok(bl.id);
    assert.equal(bl.project, 'MyProject');
    assert.deepEqual(bl.dimensionAverages, { transparency: 4.2, tone_alignment: 3.8 });

    const fetched = store.evalBaselines.get(bl.id);
    assert.deepEqual(fetched, bl);
  });

  it('getLatest returns the most recent baseline', () => {
    store.evalBaselines.insert({
      project: 'A', computedAt: '2026-03-10T10:00:00Z', windowStart: '2026-02-24T00:00:00Z',
      windowEnd: '2026-03-10T00:00:00Z', dimensionAverages: { x: 3 }, exchangeCount: 50,
      schemaVersion: 'v1'
    });
    store.evalBaselines.insert({
      project: 'A', computedAt: '2026-03-24T10:00:00Z', windowStart: '2026-03-10T00:00:00Z',
      windowEnd: '2026-03-24T00:00:00Z', dimensionAverages: { x: 4 }, exchangeCount: 100,
      schemaVersion: 'v1'
    });

    const latest = store.evalBaselines.getLatest('A');
    assert.equal(latest.exchangeCount, 100);
    assert.deepEqual(latest.dimensionAverages, { x: 4 });
  });

  it('getLatest returns null when no baselines exist', () => {
    assert.equal(store.evalBaselines.getLatest('nonexistent'), null);
  });

  it('list returns all baselines for a project', () => {
    store.evalBaselines.insert({
      project: 'A', computedAt: '2026-03-10T10:00:00Z', windowStart: '2026-02-24T00:00:00Z',
      windowEnd: '2026-03-10T00:00:00Z', dimensionAverages: {}, exchangeCount: 50,
      schemaVersion: 'v1'
    });
    store.evalBaselines.insert({
      project: 'A', computedAt: '2026-03-24T10:00:00Z', windowStart: '2026-03-10T00:00:00Z',
      windowEnd: '2026-03-24T00:00:00Z', dimensionAverages: {}, exchangeCount: 100,
      schemaVersion: 'v1'
    });

    const list = store.evalBaselines.list('A');
    assert.equal(list.length, 2);
    // Most recent first
    assert.equal(list[0].exchangeCount, 100);
  });
});

describe('store schema v9 migration', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eval-migration-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('openclaw_connections has audit_secret column', () => {
    const conn = store.openclawConnections.create({
      name: 'test-conn',
      host: '192.168.1.1',
      sshUser: 'user',
      sshKeyPath: '/tmp/key',
      auditSecret: 'secret-token-123'
    });

    assert.equal(conn.auditSecret, 'secret-token-123');

    const updated = store.openclawConnections.update(conn.id, { auditSecret: 'new-secret' });
    assert.equal(updated.auditSecret, 'new-secret');
  });

  it('eval tables exist and are functional', () => {
    // Verify we can insert into all three tables
    const ex = store.evalExchanges.insert({
      sessionId: 's1', project: 'P', timestamp: '2026-03-24T10:00:00Z',
      userMessage: 'hello', agentResponse: 'hi'
    });
    assert.ok(ex.id);

    const score = store.evalScores.insert({
      exchangeId: ex.id, schemaVersion: 'v1', judgeModel: 'test',
      scoredAt: '2026-03-24T10:00:05Z', tier1StructuralScore: 1.0,
      tier2Skipped: true, tier2_5Skipped: true, tier3Skipped: true, costUsd: 0
    });
    assert.ok(score.id);

    const bl = store.evalBaselines.insert({
      project: 'P', computedAt: '2026-03-24T10:00:00Z',
      windowStart: '2026-03-10T00:00:00Z', windowEnd: '2026-03-24T00:00:00Z',
      dimensionAverages: {}, exchangeCount: 1, schemaVersion: 'v1'
    });
    assert.ok(bl.id);
  });
});

// ── Eval Incidents ──

describe('store.evalIncidents', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eval-inc-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insert and get an incident', () => {
    const inc = store.evalIncidents.insert({
      project: 'TestProject',
      type: 'drift',
      severity: 'warning',
      title: 'Tier 2 drift detected',
      description: 'Tier 2 scores drifting down',
      metadata: { tierAffected: 'tier2', direction: 'down' },
      detectedAt: '2026-03-24T10:00:00Z'
    });
    assert.ok(inc.id);
    assert.equal(inc.project, 'TestProject');
    assert.equal(inc.type, 'drift');
    assert.equal(inc.status, 'open');
    assert.equal(inc.severity, 'warning');
    assert.deepEqual(inc.metadata, { tierAffected: 'tier2', direction: 'down' });

    const fetched = store.evalIncidents.get(inc.id);
    assert.deepEqual(fetched, inc);
  });

  it('list incidents with filtering', () => {
    store.evalIncidents.insert({ project: 'P', type: 'drift', title: 'D1', description: 'd', detectedAt: '2026-03-24T10:00:00Z' });
    store.evalIncidents.insert({ project: 'P', type: 'anomaly_spike', title: 'A1', description: 'a', detectedAt: '2026-03-24T11:00:00Z' });
    store.evalIncidents.insert({ project: 'P', type: 'drift', status: 'dismissed', title: 'D2', description: 'd', detectedAt: '2026-03-24T09:00:00Z' });
    store.evalIncidents.insert({ project: 'Other', type: 'drift', title: 'D3', description: 'd', detectedAt: '2026-03-24T10:00:00Z' });

    const all = store.evalIncidents.list('P');
    assert.equal(all.length, 3);

    const openOnly = store.evalIncidents.list('P', { status: 'open' });
    assert.equal(openOnly.length, 2);

    const driftOnly = store.evalIncidents.list('P', { type: 'drift' });
    assert.equal(driftOnly.length, 2);

    const limited = store.evalIncidents.list('P', { limit: 1 });
    assert.equal(limited.length, 1);
  });

  it('update incident status', () => {
    const inc = store.evalIncidents.insert({ project: 'P', type: 'drift', title: 'D1', description: 'd', detectedAt: '2026-03-24T10:00:00Z' });
    assert.equal(inc.status, 'open');

    const updated = store.evalIncidents.update(inc.id, {
      status: 'accepted',
      resolvedAt: '2026-03-24T12:00:00Z',
      resolvedBy: 'admin'
    });
    assert.equal(updated.status, 'accepted');
    assert.equal(updated.resolvedAt, '2026-03-24T12:00:00Z');
    assert.equal(updated.resolvedBy, 'admin');
  });

  it('countByStatus returns correct counts', () => {
    store.evalIncidents.insert({ project: 'P', type: 'drift', title: 'D1', description: 'd', detectedAt: '2026-03-24T10:00:00Z' });
    store.evalIncidents.insert({ project: 'P', type: 'drift', title: 'D2', description: 'd', detectedAt: '2026-03-24T10:00:00Z' });
    store.evalIncidents.insert({ project: 'P', type: 'drift', status: 'accepted', title: 'D3', description: 'd', detectedAt: '2026-03-24T10:00:00Z' });
    store.evalIncidents.insert({ project: 'P', type: 'drift', status: 'dismissed', title: 'D4', description: 'd', detectedAt: '2026-03-24T10:00:00Z' });

    const counts = store.evalIncidents.countByStatus('P');
    assert.equal(counts.open, 2);
    assert.equal(counts.accepted, 1);
    assert.equal(counts.dismissed, 1);
  });

  it('countByStatus returns zeros for empty project', () => {
    const counts = store.evalIncidents.countByStatus('empty');
    assert.deepEqual(counts, { open: 0, accepted: 0, dismissed: 0 });
  });

  it('get returns null for nonexistent incident', () => {
    assert.equal(store.evalIncidents.get('nope'), null);
  });

  it('insert defaults to open status and warning severity', () => {
    const inc = store.evalIncidents.insert({ project: 'P', type: 'drift', title: 'T', description: 'd', detectedAt: '2026-03-24T10:00:00Z' });
    assert.equal(inc.status, 'open');
    assert.equal(inc.severity, 'warning');
  });

  it('list returns newest first', () => {
    store.evalIncidents.insert({ project: 'P', type: 'drift', title: 'Old', description: 'd', detectedAt: '2026-03-20T10:00:00Z' });
    store.evalIncidents.insert({ project: 'P', type: 'drift', title: 'New', description: 'd', detectedAt: '2026-03-24T10:00:00Z' });

    const list = store.evalIncidents.list('P');
    assert.equal(list[0].title, 'New');
    assert.equal(list[1].title, 'Old');
  });
});

// ── Human Scoring ──

describe('store.evalScores.updateHumanScore', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eval-human-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves human score', () => {
    const ex = store.evalExchanges.insert({
      sessionId: 's1', project: 'P', timestamp: new Date().toISOString(),
      userMessage: 'hi', agentResponse: 'hello'
    });
    const score = store.evalScores.insert({
      exchangeId: ex.id, schemaVersion: 'v1', judgeModel: 'structural',
      scoredAt: new Date().toISOString(), tier1StructuralScore: 1.0, tier1Flags: []
    });

    const updated = store.evalScores.updateHumanScore(score.id, { score: 4, comment: 'Good response' });
    assert.equal(updated.humanScore, 4);
    assert.equal(updated.humanComment, 'Good response');
    assert.ok(updated.humanScoredAt);
  });

  it('human score fields default to null', () => {
    const ex = store.evalExchanges.insert({
      sessionId: 's1', project: 'P', timestamp: new Date().toISOString(),
      userMessage: 'hi', agentResponse: 'hello'
    });
    const score = store.evalScores.insert({
      exchangeId: ex.id, schemaVersion: 'v1', judgeModel: 'structural',
      scoredAt: new Date().toISOString(), tier1StructuralScore: 1.0, tier1Flags: []
    });
    assert.equal(score.humanScore, null);
    assert.equal(score.humanComment, null);
    assert.equal(score.humanScoredAt, null);
  });
});

// ── Session Cost Aggregation ──

describe('store.evalScores.getSessionCost', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eval-cost-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('aggregates cost across session exchanges', () => {
    const ts = new Date().toISOString();
    const ex1 = store.evalExchanges.insert({ sessionId: 'sess-A', project: 'P', timestamp: ts, userMessage: 'a', agentResponse: 'b' });
    const ex2 = store.evalExchanges.insert({ sessionId: 'sess-A', project: 'P', timestamp: ts, userMessage: 'c', agentResponse: 'd' });
    store.evalScores.insert({ exchangeId: ex1.id, schemaVersion: 'v1', judgeModel: 'haiku', scoredAt: ts, costUsd: 0.003 });
    store.evalScores.insert({ exchangeId: ex2.id, schemaVersion: 'v1', judgeModel: 'haiku', scoredAt: ts, costUsd: 0.007 });

    const total = store.evalScores.getSessionCost('sess-A');
    assert.ok(Math.abs(total - 0.01) < 0.0001);
  });

  it('returns 0 for session with no scores', () => {
    assert.equal(store.evalScores.getSessionCost('nonexistent'), 0);
  });
});

// ── Retention Purge ──

describe('store.evalExchanges.purgeOlderThan', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eval-purge-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('purges old exchanges and their scores', () => {
    const old = '2025-01-01T00:00:00Z';
    const recent = '2026-03-24T00:00:00Z';
    const exOld = store.evalExchanges.insert({ sessionId: 's', project: 'P', timestamp: old, userMessage: 'old', agentResponse: 'old' });
    const exNew = store.evalExchanges.insert({ sessionId: 's', project: 'P', timestamp: recent, userMessage: 'new', agentResponse: 'new' });
    store.evalScores.insert({ exchangeId: exOld.id, schemaVersion: 'v1', judgeModel: 'structural', scoredAt: old, costUsd: 0 });
    store.evalScores.insert({ exchangeId: exNew.id, schemaVersion: 'v1', judgeModel: 'structural', scoredAt: recent, costUsd: 0 });

    const result = store.evalExchanges.purgeOlderThan('2026-01-01T00:00:00Z');
    assert.equal(result.exchangesPurged, 1);
    assert.equal(result.scoresPurged, 1);

    // New exchange still exists
    assert.ok(store.evalExchanges.get(exNew.id));
    assert.ok(store.evalScores.getByExchange(exNew.id));

    // Old exchange gone
    assert.equal(store.evalExchanges.get(exOld.id), null);
    assert.equal(store.evalScores.getByExchange(exOld.id), null);
  });

  it('returns zeros when nothing to purge', () => {
    const result = store.evalExchanges.purgeOlderThan('2020-01-01T00:00:00Z');
    assert.equal(result.exchangesPurged, 0);
    assert.equal(result.scoresPurged, 0);
  });
});
