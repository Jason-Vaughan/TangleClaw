'use strict';

// v6.2 (#3004, V6-34 / R-MED-1, Car V62-W1-C): Medusa v2's opt-in compact
// envelope, Merkle delta sync, wake coalescer and SQLite persistence. Pure
// functions over fixtures, plus the persistence half against a real
// node:sqlite-backed store.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const m2 = require('../lib/v6/medusa-v2-compact-sync');

const ARTIFACT = 'Car V62-W1-C passed its R-Gate.\nNext: open the PR against main.';

/** @returns {object} A referencing envelope over ARTIFACT's first line. */
function refEnvelope() {
  const first = Buffer.byteLength('Car V62-W1-C passed its R-Gate.');
  return m2.createEnvelope({
    msg_type: 'gate',
    task_id: '3004',
    state_delta: { car: 'V62-W1-C', gate: 'R', transition: { from: 'review', to: 'passed' }, edges_add: [{ from: 'V62-W1-C', rel: 'blocks', to: 'W2' }] },
    artifact_ref: m2.artifactRef(ARTIFACT, { start: 0, end: first, anchor: 'gate-result' }),
    next_action: 'merge'
  });
}

const fetchArtifact = (hash) => (hash === m2.sha256(ARTIFACT) ? ARTIFACT : null);

/** @param {string} code */
const code = (c) => (err) => err instanceof m2.MedusaV2Error && err.code === c;

describe('canonicalJson and negotiation', () => {
  it('sorts keys at every depth and refuses values JSON cannot state', () => {
    assert.equal(m2.canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":0,"z":1}]},"b":1}');
    for (const v of [undefined, () => 1, NaN, Infinity, 1n, new Date(0), { a: undefined }]) {
      assert.throws(() => m2.canonicalJson(v), code('NON_CANONICAL'));
    }
  });

  it('opts in to m2 only when the peer advertises the capability', () => {
    assert.equal(m2.negotiateWire([m2.CAPABILITY, 'other']), 'm2');
    for (const caps of [[], ['other'], undefined, 'medusa-compact-v1', null]) assert.equal(m2.negotiateWire(caps), 'prose');
  });
});

describe('artifact references', () => {
  it('names the whole artifact and resolves only the verified byte range', () => {
    const ref = m2.artifactRef(ARTIFACT, { start: 4, end: 12, anchor: 'car' });
    assert.equal(ref.uri, `artifact://sha256/${ref.sha256}`);
    assert.equal(m2.resolveArtifact(ref, fetchArtifact), 'V62-W1-C');
  });

  it('surfaces a missing or corrupt artifact instead of substituting text', () => {
    const ref = m2.artifactRef(ARTIFACT, { anchor: 'all' });
    assert.throws(() => m2.resolveArtifact(ref, () => null), code('ARTIFACT_MISSING'));
    assert.throws(() => m2.resolveArtifact(ref, () => `${ARTIFACT}!`), code('ARTIFACT_CORRUPT'));
  });

  it('refuses a byte range that splits a multi-byte UTF-8 character (PRR-A B3)', () => {
    const text = 'café ☕';
    assert.throws(() => m2.artifactRef(text, { start: 0, end: 4, anchor: 'a' }), code('REF_INVALID'));
    assert.throws(() => m2.artifactRef(text, { start: 7, end: Buffer.byteLength(text), anchor: 'a' }), code('REF_INVALID'));
    const whole = m2.artifactRef(text, { start: 0, end: 5, anchor: 'a' });
    assert.equal(m2.resolveArtifact(whole, () => text), 'café');
    const split = { ...whole, byteRange: [0, 4] };
    assert.throws(() => m2.resolveArtifact(split, () => text), code('REF_INVALID'), 'never decodes to U+FFFD');
  });

  it('refuses malformed ranges, anchors and references', () => {
    assert.throws(() => m2.artifactRef(ARTIFACT, { start: 5, end: 2, anchor: 'a' }), code('REF_INVALID'));
    assert.throws(() => m2.artifactRef(ARTIFACT, { end: 10_000, anchor: 'a' }), code('REF_INVALID'));
    assert.throws(() => m2.artifactRef(ARTIFACT, { anchor: 'has space' }), code('REF_INVALID'));
    const ref = m2.artifactRef(ARTIFACT, { anchor: 'a' });
    assert.throws(() => m2.resolveArtifact({ ...ref, uri: 'artifact://sha256/' + '0'.repeat(64) }, fetchArtifact), code('REF_INVALID'));
    assert.throws(() => m2.resolveArtifact({ ...ref, extra: 1 }, fetchArtifact), code('REF_INVALID'));
  });
});

describe('compact envelope (m2)', () => {
  it('carries exactly the seven Phase 1 fields and a digest of the other six', () => {
    const env = m2.createEnvelope({ msg_type: 'update' });
    assert.deepEqual(Object.keys(env).sort(), ['artifact_ref', 'blocker_code', 'digest', 'msg_type', 'next_action', 'state_delta', 'task_id']);
    assert.equal(env.artifact_ref, null, 'a state-only notice needs no artifact');
    assert.equal(m2.verifyEnvelope(env), env);
  });

  it('detects any altered field through the digest', () => {
    const env = refEnvelope();
    assert.throws(() => m2.verifyEnvelope({ ...env, next_action: 'hold' }), code('DIGEST_MISMATCH'));
    assert.throws(() => m2.verifyEnvelope({ ...env, extra: 1 }), code('ENVELOPE_INVALID'));
  });

  it('enforces the Phase 1 schema bounds', () => {
    const bad = [
      { msg_type: 'chat' },
      { msg_type: 'update', task_id: 'x'.repeat(129) },
      { msg_type: 'update', blocker_code: 'x'.repeat(41) },
      { msg_type: 'update', next_action: 'x'.repeat(257) },
      { msg_type: 'update', state_delta: { unknown: 1 } },
      { msg_type: 'update', state_delta: { summary: 'x'.repeat(257) } },
      { msg_type: 'update', state_delta: { transition: { from: 'a', to: '' } } },
      { msg_type: 'update', state_delta: { edges_add: [{ from: 'a', rel: 'r', to: 'b' }, { from: 'a', rel: 'r', to: 'b' }] } },
      { msg_type: 'update', state_delta: { edges_remove: [{ from: 'a', to: 'b' }] } }
    ];
    for (const f of bad) assert.throws(() => m2.createEnvelope(f), code('ENVELOPE_INVALID'), JSON.stringify(f));
    assert.equal(m2.MSG_TYPES.length, 5);
  });
});

describe('human card (lossless projection)', () => {
  it('round-trips an envelope and its exact referenced text', () => {
    const env = refEnvelope();
    const card = m2.projectCard(env, fetchArtifact);
    assert.equal(card, m2.projectCard(env, fetchArtifact), 'deterministic');
    const parsed = m2.parseCard(card, fetchArtifact);
    assert.deepEqual(parsed.envelope, env);
    assert.equal(parsed.artifactText, 'Car V62-W1-C passed its R-Gate.');
  });

  it('refuses to project a referencing envelope without its verified artifact', () => {
    assert.throws(() => m2.projectCard(refEnvelope()), code('ARTIFACT_MISSING'));
    assert.throws(() => m2.projectCard(refEnvelope(), () => 'tampered'), code('ARTIFACT_CORRUPT'));
  });

  it('keeps a newline in source text from forging a card line', () => {
    const env = m2.createEnvelope({ msg_type: 'update', next_action: 'ok\ndigest: "forged"' });
    const card = m2.projectCard(env);
    assert.equal(card.split('\n').length, 9);
    assert.equal(m2.parseCard(card).envelope.next_action, 'ok\ndigest: "forged"');
  });

  it('rejects reordered, missing, duplicated, non-canonical or tampered cards', () => {
    const card = m2.projectCard(refEnvelope(), fetchArtifact);
    const lines = card.split('\n');
    const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n');
    assert.throws(() => m2.parseCard(swapped), code('CARD_INVALID'));
    assert.throws(() => m2.parseCard(lines.slice(0, -1).join('\n')), code('CARD_INVALID'));
    assert.throws(() => m2.parseCard([...lines, lines[8]].join('\n')), code('CARD_INVALID'));
    assert.throws(() => m2.parseCard(card.replace('task_id: "3004"', 'task_id:  "3004"')), code('CARD_INVALID'));
    assert.throws(() => m2.parseCard(card.replace('"merge"', '"hold"'), fetchArtifact), code('DIGEST_MISMATCH'));
    assert.throws(() => m2.parseCard(card.replace(/^artifact_text: .*$/m, 'artifact_text: null'), fetchArtifact), code('CARD_INVALID'));
  });

  it('fails closed on forged artifact text, which sits outside the digest (PRR-A B1)', () => {
    const card = m2.projectCard(refEnvelope(), fetchArtifact);
    const forged = card.replace(/^artifact_text: .*$/m, `artifact_text: ${JSON.stringify('Car V62-W1-C FAILED its R-Gate.')}`);
    assert.throws(() => m2.parseCard(forged, fetchArtifact), code('CARD_TAMPERED'));
    assert.throws(() => m2.parseCard(card), code('ARTIFACT_MISSING'), 'a referencing card is never trusted unverified');
    assert.throws(() => m2.parseCard(card, () => 'swapped artifact'), code('ARTIFACT_CORRUPT'));
    const stateOnly = m2.projectCard(m2.createEnvelope({ msg_type: 'ack' }));
    assert.equal(m2.parseCard(stateOnly).artifactText, null, 'a state-only card needs no artifact');
  });
});

/** @returns {object} A small valid graph. */
function graphA() {
  return { nodes: { car: { label: 'V62-W1-C', edges: ['gate'] }, gate: { label: 'review', edges: [] } }, roots: ['car'] };
}

describe('Merkle state tree and delta sync', () => {
  it('commits to labels, edge order, unreachable nodes and roots', () => {
    const a = graphA();
    const h = m2.merkleRoot(a);
    assert.equal(h, m2.merkleRoot(JSON.parse(JSON.stringify(a))));
    const relabel = graphA(); relabel.nodes.gate.label = 'passed';
    const orphan = graphA(); orphan.nodes.extra = { label: 'x', edges: [] };
    const reorder = { nodes: { r: { label: 'r', edges: ['a', 'b'] }, a: { label: 'a', edges: [] }, b: { label: 'b', edges: [] } }, roots: ['r'] };
    const reordered = { ...reorder, nodes: { ...reorder.nodes, r: { label: 'r', edges: ['b', 'a'] } } };
    assert.notEqual(m2.merkleRoot(relabel), h);
    assert.notEqual(m2.merkleRoot(orphan), h);
    assert.notEqual(m2.merkleRoot(reorder), m2.merkleRoot(reordered));
  });

  it('refuses invalid graphs', () => {
    const bad = [
      { nodes: { a: { label: 'a', edges: ['missing'] } }, roots: [] },
      { nodes: { a: { label: 'a', edges: ['b'] }, b: { label: 'b', edges: ['a'] } }, roots: ['a'] },
      { nodes: { a: { label: 'a', edges: [] } }, roots: ['a', 'a'] },
      { nodes: { 'bad id': { label: 'x', edges: [] } }, roots: [] },
      { nodes: { a: { label: 'a', edges: [], extra: 1 } }, roots: [] },
      { nodes: {}, roots: [], extra: 1 }
    ];
    for (const g of bad) assert.throws(() => m2.validateGraph(g), code('GRAPH_INVALID'), JSON.stringify(g));
  });

  it('applies a delta only on its exact base and only to its exact target', () => {
    const a = graphA();
    const b = graphA(); b.nodes.gate.label = 'passed'; b.nodes.pr = { label: '#3030', edges: [] }; b.roots = ['car', 'pr'];
    const delta = m2.diffGraphs(a, b);
    const applied = m2.applyDelta(a, delta);
    assert.equal(m2.merkleRoot(applied), delta.targetHash);
    assert.deepEqual(a, graphA(), 'the input graph is never mutated');
    assert.throws(() => m2.applyDelta(b, delta), code('BASE_MISMATCH'));
    assert.throws(() => m2.applyDelta(a, { ...delta, targetHash: m2.merkleRoot(a) }), code('TARGET_MISMATCH'));
    assert.throws(() => m2.applyDelta(a, { ...delta, ops: [{ op: 'del', id: 'nope' }] }), code('DELTA_INVALID'));
  });

  it('recovers a missed intermediate delta only from a matching full frame', () => {
    const a = graphA();
    const b = graphA(); b.nodes.gate.label = 'passed';
    const c = graphA(); c.nodes.gate.label = 'merged';
    const bToC = m2.diffGraphs(b, c);
    assert.throws(() => m2.applyDelta(a, bToC), code('BASE_MISMATCH'), 'a missed a→b delta is detected');
    assert.throws(() => m2.recoverFromFullFrame({ graph: a }, bToC.baseHash), code('FULL_FRAME_MISMATCH'));
    const recovered = m2.recoverFromFullFrame({ graph: b }, bToC.baseHash);
    assert.equal(m2.merkleRoot(m2.applyDelta(recovered, bToC)), bToC.targetHash, 'later deltas continue from the recovered state');
  });
});

describe('wake coalescer', () => {
  const completion = (id, recipient, priority) => ({ completionId: id, fleetId: 'fleet-1', waveId: 'w1', recipient, priority });

  it('emits one wake per recipient per sealed wave, keeping every completion ID', () => {
    const c = m2.createWakeCoalescer();
    for (let i = 0; i < 50; i++) c.ingest(completion(`c${i}`, `lane-${i % 10}`));
    c.seal('fleet-1', 'w1');
    const wakes = c.flush('fleet-1', 'w1');
    assert.equal(wakes.length, 10);
    assert.equal(wakes.reduce((n, w) => n + w.completionIds.length, 0), 50, 'no completion is dropped');
    assert.equal(new Set(wakes.map((w) => w.wakeId)).size, 10);
    assert.equal(wakes[0].wakeId, m2.wakeIdFor('fleet-1', 'w1', wakes[0].recipient), 'stable wake IDs');
  });

  it('never demotes an urgent signal: a wake takes its most urgent completion and urgent wakes go first', () => {
    const c = m2.createWakeCoalescer();
    c.ingest(completion('a1', 'lane-a', 'normal'));
    c.ingest(completion('b1', 'lane-b', 'normal'));
    c.ingest(completion('b2', 'lane-b', 'p0'));
    c.ingest(completion('z1', 'lane-z', 'blocker'));
    c.seal('fleet-1', 'w1');
    const wakes = c.flush('fleet-1', 'w1');
    assert.deepEqual(wakes.map((w) => `${w.recipient}:${w.priority}`), ['lane-b:p0', 'lane-z:blocker', 'lane-a:normal']);
    assert.deepEqual(m2.PRIORITIES, ['p0', 'blocker', 'urgent', 'normal']);
  });

  it('refuses a late completion for a sealed wave instead of silently joining a sent wake', () => {
    const c = m2.createWakeCoalescer();
    c.ingest(completion('a1', 'lane-a'));
    c.seal('fleet-1', 'w1');
    assert.throws(() => c.ingest(completion('a2', 'lane-a', 'p0')), code('WAVE_SEALED'));
    c.ingest({ ...completion('a2', 'lane-a', 'p0'), waveId: 'w2' });
    assert.deepEqual(c.flush('fleet-1', 'w1')[0].completionIds, ['a1']);
  });

  it('is idempotent on a repeated completion and refuses a conflicting one', () => {
    const c = m2.createWakeCoalescer();
    assert.equal(c.ingest(completion('a1', 'lane-a')).duplicate, false);
    assert.equal(c.ingest(completion('a1', 'lane-a')).duplicate, true);
    assert.throws(() => c.ingest(completion('a1', 'lane-b')), code('IDEMPOTENCY_CONFLICT'));
  });

  it('flushes only a sealed wave, and only once', () => {
    const c = m2.createWakeCoalescer();
    c.ingest(completion('a1', 'lane-a'));
    assert.throws(() => c.flush('fleet-1', 'w1'), code('WAVE_NOT_SEALED'));
    c.seal('fleet-1', 'w1');
    c.flush('fleet-1', 'w1');
    assert.throws(() => c.flush('fleet-1', 'w1'), code('WAVE_FLUSHED'));
    assert.throws(() => c.ingest(completion('bad id', 'lane-a')), code('WAKE_INVALID'));
    assert.throws(() => c.ingest(completion('a9', 'lane-a', 'critical')), code('WAKE_INVALID'));
  });
});

describe('SQLite persistence (real store)', () => {
  let tmpDir;
  let db;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-medusa-v2-'));
    store._setBasePath(tmpDir);
    store.init();
    db = store.getDb();
    m2.ensureSchema(db);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates its tables idempotently', () => {
    m2.ensureSchema(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'v6_medusa_v2_%' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(names, ['v6_medusa_v2_blobs', 'v6_medusa_v2_deltas', 'v6_medusa_v2_messages', 'v6_medusa_v2_snapshots', 'v6_medusa_v2_wakes']);
  });

  it('stores a body once per digest across many messages and reads each back verified', () => {
    const env = refEnvelope();
    for (let i = 0; i < 20; i++) m2.recordMessage(db, { id: `msg-${i}`, sender: 'lane-c', recipient: 'lane-int', envelope: env, artifact: ARTIFACT });
    const blob = db.prepare('SELECT COUNT(*) AS n, MAX(ref_count) AS refs FROM v6_medusa_v2_blobs').get();
    assert.equal(blob.n, 1);
    assert.equal(blob.refs, 20);
    const read = m2.readMessage(db, 'msg-7');
    assert.deepEqual(read.envelope, env);
    assert.equal(read.artifactText, 'Car V62-W1-C passed its R-Gate.');
    assert.equal(m2.readMessage(db, 'absent'), null);
  });

  it('is idempotent on a repeated message ID and refuses a conflicting one, leaving nothing half-written', () => {
    const env = m2.createEnvelope({ msg_type: 'ack' });
    assert.equal(m2.recordMessage(db, { id: 'dup', sender: 'a', recipient: 'b', envelope: env }).duplicate, false);
    assert.equal(m2.recordMessage(db, { id: 'dup', sender: 'a', recipient: 'b', envelope: env }).duplicate, true);
    assert.throws(() => m2.recordMessage(db, { id: 'dup', sender: 'a', recipient: 'c', envelope: env }), code('IDEMPOTENCY_CONFLICT'));
    const refsBefore = db.prepare('SELECT ref_count FROM v6_medusa_v2_blobs').get().ref_count;
    assert.throws(() => m2.recordMessage(db, { id: 'msg-0', sender: 'x', recipient: 'y', envelope: refEnvelope(), artifact: ARTIFACT }), code('IDEMPOTENCY_CONFLICT'));
    assert.equal(db.prepare('SELECT ref_count FROM v6_medusa_v2_blobs').get().ref_count, refsBefore, 'a refused write rolls back');
    assert.throws(() => m2.recordMessage(db, { id: 'n1', sender: 'a', recipient: 'b', envelope: refEnvelope(), artifact: 'other' }), code('ARTIFACT_CORRUPT'));
  });

  it('treats a repeated message ID with a different state hash as a conflict (PRR-A B2)', () => {
    const env = m2.createEnvelope({ msg_type: 'update' });
    const s1 = 'a'.repeat(64);
    m2.recordMessage(db, { id: 'state-1', sender: 'a', recipient: 'b', envelope: env, stateHash: s1 });
    assert.equal(m2.recordMessage(db, { id: 'state-1', sender: 'a', recipient: 'b', envelope: env, stateHash: s1 }).duplicate, true);
    assert.throws(() => m2.recordMessage(db, { id: 'state-1', sender: 'a', recipient: 'b', envelope: env, stateHash: 'b'.repeat(64) }), code('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => m2.recordMessage(db, { id: 'state-1', sender: 'a', recipient: 'b', envelope: env }), code('IDEMPOTENCY_CONFLICT'));
  });

  it('detects stored corruption on read', () => {
    m2.recordMessage(db, { id: 'corrupt-me', sender: 'a', recipient: 'b', envelope: m2.createEnvelope({ msg_type: 'update', next_action: 'x' }) });
    const row = db.prepare('SELECT envelope FROM v6_medusa_v2_messages WHERE id = ?').get('corrupt-me');
    db.prepare('UPDATE v6_medusa_v2_messages SET envelope = ? WHERE id = ?').run(row.envelope.replace('"x"', '"y"'), 'corrupt-me');
    assert.throws(() => m2.readMessage(db, 'corrupt-me'), code('DIGEST_MISMATCH'));
  });

  it('replays the unacknowledged inbox and acks only for the recipient', () => {
    const env = m2.createEnvelope({ msg_type: 'dispatch' });
    m2.recordMessage(db, { id: 'in-1', sender: 'pm', recipient: 'lane-d', envelope: env, now: () => '2026-11-12T00:00:01Z' });
    m2.recordMessage(db, { id: 'in-2', sender: 'pm', recipient: 'lane-d', envelope: env, now: () => '2026-11-12T00:00:02Z' });
    assert.deepEqual(m2.inbox(db, 'lane-d'), ['in-1', 'in-2']);
    assert.equal(m2.ackMessage(db, 'in-1', 'lane-x').code, 'NOT_RECIPIENT');
    assert.equal(m2.ackMessage(db, 'in-1', 'lane-d').code, 'ACKED');
    assert.equal(m2.ackMessage(db, 'in-1', 'lane-d').code, 'ALREADY_ACKED');
    assert.equal(m2.ackMessage(db, 'nope', 'lane-d').code, 'NOT_FOUND');
    assert.deepEqual(m2.inbox(db, 'lane-d'), ['in-2']);
  });

  it('stores snapshots by root and keeps a delta only when it is proven against its stored base', () => {
    const a = graphA();
    const b = graphA(); b.nodes.gate.label = 'passed';
    const delta = m2.diffGraphs(a, b);
    assert.throws(() => m2.saveDelta(db, delta), code('BASE_UNKNOWN'));
    assert.equal(m2.saveSnapshot(db, a), delta.baseHash);
    assert.equal(m2.saveDelta(db, delta).targetHash, delta.targetHash);
    assert.deepEqual(m2.loadSnapshot(db, delta.targetHash), b);
    assert.throws(() => m2.saveDelta(db, { ...delta, targetHash: delta.baseHash }), code('TARGET_MISMATCH'));
    assert.equal(m2.loadSnapshot(db, '0'.repeat(64)), null);
    db.prepare('UPDATE v6_medusa_v2_snapshots SET graph = ? WHERE hash = ?').run(m2.canonicalJson(b), delta.baseHash);
    assert.throws(() => m2.loadSnapshot(db, delta.baseHash), code('SNAPSHOT_CORRUPT'));
  });

  it('persists wakes before delivery and drains them only with full proof', () => {
    const c = m2.createWakeCoalescer();
    c.ingest({ completionId: 'k1', fleetId: 'f', waveId: 'w', recipient: 'lane-a', priority: 'normal' });
    c.ingest({ completionId: 'k2', fleetId: 'f', waveId: 'w', recipient: 'lane-b', priority: 'urgent' });
    c.seal('f', 'w');
    const [urgent, normal] = c.flush('f', 'w');
    for (const w of [urgent, normal]) assert.equal(m2.queueWake(db, w).duplicate, false);
    assert.equal(m2.queueWake(db, urgent).duplicate, true);
    assert.throws(() => m2.queueWake(db, { ...urgent, completionIds: ['k1', 'k2'] }), code('WAKE_CONFLICT'));
    for (const changed of [{ fleetId: 'f2' }, { waveId: 'w2' }, { priority: 'normal' }, { recipient: 'lane-z' }]) {
      assert.throws(() => m2.queueWake(db, { ...urgent, ...changed }), code('WAKE_CONFLICT'), JSON.stringify(changed));
    }
    assert.deepEqual(m2.pendingWakes(db).map((w) => w.priority), ['urgent', 'normal']);

    assert.equal(m2.drainWake(db, urgent.wakeId, { composerDrained: true, transcriptCommitted: false, marker: 'm' }).code, 'PROOF_REQUIRED');
    assert.equal(m2.drainWake(db, urgent.wakeId, { composerDrained: true, transcriptCommitted: true, marker: 'wake-marker' }).code, 'DRAINED');
    assert.equal(m2.drainWake(db, urgent.wakeId, { composerDrained: true, transcriptCommitted: true, marker: 'wake-marker' }).code, 'ALREADY_DRAINED');
    assert.equal(m2.markWakeUncertain(db, normal.wakeId, '').code, 'REASON_REQUIRED');
    assert.equal(m2.markWakeUncertain(db, normal.wakeId, 'Enter accepted, no transcript entry by deadline').code, 'UNCERTAIN');
    assert.equal(m2.drainWake(db, normal.wakeId, { composerDrained: true, transcriptCommitted: true, marker: 'm' }).code, 'NOT_PENDING');
    assert.deepEqual(m2.pendingWakes(db), [], 'an uncertain wake waits for review, not replay');
    assert.deepEqual(m2.pendingWakes(db, 'lane-a'), []);
    assert.equal(m2.drainWake(db, 'wake-none', { composerDrained: true, transcriptCommitted: true, marker: 'm' }).code, 'NOT_FOUND');
  });

  it('keeps queued wakes and the unacked inbox across a restart', () => {
    m2.queueWake(db, { wakeId: 'wake-restart', fleetId: 'f', waveId: 'w9', recipient: 'lane-r', priority: 'blocker', completionIds: ['r1'] });
    store.close();
    store.init();
    db = store.getDb();
    m2.ensureSchema(db);
    assert.deepEqual(m2.pendingWakes(db, 'lane-r').map((w) => w.wakeId), ['wake-restart']);
    assert.deepEqual(m2.inbox(db, 'lane-d'), ['in-2']);
  });
});
