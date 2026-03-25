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
