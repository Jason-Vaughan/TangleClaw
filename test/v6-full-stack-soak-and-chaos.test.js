'use strict';

// v6.2.1 (#3037, Car V621-W1-C): Stage 1-5 full-stack soak and chaos suite.
// The reference prototype (Builders-A-D/v6-stage1-to-5-full-stack-soak-and-chaos-suite.md)
// models a standalone stand-in server it says is "not a production server";
// this suite instead drives the REAL lib/v6 modules on ONE real node:sqlite
// store, under volume, repeated contention and injected faults, against the
// same invariants: migration is idempotent, a hard cap holds under repeated
// contention, waves are dependency-aware, Medusa is lossless and fails
// closed, chaos is recoverable, and hostile probes never widen authority.
//
// Scope, stated rather than implied: node:sqlite is synchronous, so writes in
// one process run back to back and never truly overlap. Contention here is
// sequential and verifies each operation's own transaction (BEGIN IMMEDIATE)
// and rollback; it does not exercise multi-process or multi-thread writers.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/v6/medusa-v2-compact-sync');
const c3 = require('../lib/v6/c3-wave-scheduler');
const e3b = require('../lib/v6/e3b-whatif-simulator');
const g4 = require('../lib/v6/g4-external-advisor');
const a1 = require('../lib/v6/a1-iso-host-sandboxing');
const f3 = require('../lib/v6/f3-support-diagnostic-scrubber');
const f1 = require('../lib/v6/f1-knowledge-base');
const e6a = require('../lib/v6/e6a-report-search-indexer');
const e6b = require('../lib/v6/e6b-report-narrative-synthesizer');
const { CANONICAL_SECTIONS } = require('../lib/v6/sprint-report-validator-v3');

/** Every v6 module that owns tables through its own ensureSchema(db). */
const SCHEMA_OWNERS = ['a1-iso-host-sandboxing', 'a2b-self-healing-remediator', 'c3-wave-scheduler', 'c4-d2-failover-and-quota-placement',
  'e3b-whatif-simulator', 'g4-external-advisor', 'medusa-v2-compact-sync'];

const code = (c) => (err) => err && err.code === c;

let tmpDir;
let db;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-soak-'));
  store._setBasePath(tmpDir);
  store.init();
  db = store.getDb();
  for (const m of SCHEMA_OWNERS) require(`../lib/v6/${m}`).ensureSchema(db);
});

/** @returns {number} The store's recorded core schema version. */
function schemaVersion() {
  return db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
}

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Stage 1: migration and bootstrap', () => {
  it('reaches the current schema and every v6 ensureSchema is idempotent under repetition', () => {
    const version = schemaVersion();
    assert.equal(version, store.CURRENT_SCHEMA_VERSION, `schema at v${version}`);
    for (let round = 0; round < 12; round++) {
      for (const m of SCHEMA_OWNERS) require(`../lib/v6/${m}`).ensureSchema(db);
    }
    assert.equal(schemaVersion(), version, 'ensureSchema never moves the core schema version');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });

  it('survives close and reopen with v6 data intact', () => {
    medusa.recordMessage(db, { id: 'boot-1', sender: 'pm', recipient: 'lane-a', envelope: medusa.createEnvelope({ msg_type: 'dispatch' }) });
    store.close();
    store.init();
    db = store.getDb();
    for (const m of SCHEMA_OWNERS) require(`../lib/v6/${m}`).ensureSchema(db);
    assert.deepEqual(medusa.inbox(db, 'lane-a'), ['boot-1']);
  });
});

describe('Stage 2/3: fleet waves at scale', () => {
  it('orders a 100-car dependency graph into waves that respect every dependency', () => {
    const cars = Array.from({ length: 100 }, (_, i) => ({ id: `car-${i}`, dependsOn: i === 0 ? [] : [`car-${Math.floor((i - 1) / 2)}`] }));
    const waves = c3.topologicalWaves(cars);
    const waveOf = new Map();
    waves.forEach((w, n) => w.forEach((id) => waveOf.set(id, n)));
    assert.equal(waveOf.size, 100, 'every car is scheduled exactly once');
    for (const car of cars) for (const dep of car.dependsOn) assert.ok(waveOf.get(dep) < waveOf.get(car.id), `${dep} before ${car.id}`);
  });

  it('refuses unknown and cyclic dependencies before any dispatch', () => {
    assert.throws(() => c3.topologicalWaves([{ id: 'a', dependsOn: ['ghost'] }]), code('DEPENDENCY_UNKNOWN'));
    assert.throws(() => c3.topologicalWaves([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), code('DEPENDENCY_CYCLE'));
  });

  it('simulates 3 trains x 20 cars within the lane pool and names every unschedulable car', () => {
    const trains = Array.from({ length: 3 }, (_, t) => ({
      id: `t${t}`,
      cars: Array.from({ length: 20 }, (_, i) => ({ id: `t${t}-c${i}`, effort: 1 + (i % 3), role: 'builder', dependsOn: i ? [`t${t}-c${i - 1}`] : [] }))
    }));
    trains[2].cars.push({ id: 't2-orphan', effort: 1, role: 'nobody' });
    const r = e3b.simulate({ trains, rolePools: { builder: 4 } });
    assert.equal(r.complete, false);
    assert.deepEqual(r.unschedulable, [{ carId: 't2-orphan', reason: 'NO_LANE_FOR_ROLE' }]);
    assert.ok(r.makespan > 0);
    assert.deepEqual(e3b.simulate({ trains, rolePools: { builder: 4 } }), r, 'deterministic');
  });
});

describe('Stage 3: Medusa v2 compact wire under load', () => {
  it('stores 105 messages losslessly with one body blob and replays the whole inbox in order', () => {
    const artifact = 'Shared wave note: hold the merge until the R-Gate passes.';
    const env = medusa.createEnvelope({ msg_type: 'update', artifact_ref: medusa.artifactRef(artifact, { anchor: 'note' }) });
    for (let i = 0; i < 105; i++) {
      medusa.recordMessage(db, { id: `soak-${String(i).padStart(3, '0')}`, sender: 'pm', recipient: 'lane-soak', envelope: env, artifact, now: () => `2026-11-12T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` });
    }
    const ids = medusa.inbox(db, 'lane-soak');
    assert.equal(ids.length, 105);
    assert.equal(new Set(ids).size, 105);
    assert.equal(db.prepare('SELECT ref_count FROM v6_medusa_v2_blobs WHERE hash = ?').get(env.artifact_ref.sha256).ref_count, 105);
    for (const id of ids.slice(0, 5)) assert.equal(medusa.readMessage(db, id).artifactText, artifact);
  });

  it('coalesces 1000 completions across 10 lanes into 10 wakes without dropping or demoting any', () => {
    const c = medusa.createWakeCoalescer();
    for (let i = 0; i < 1000; i++) {
      c.ingest({ completionId: `k${i}`, fleetId: 'f1', waveId: 'w-soak', recipient: `lane-${i % 10}`, priority: i === 777 ? 'p0' : 'normal' });
    }
    c.seal('f1', 'w-soak');
    const wakes = c.flush('f1', 'w-soak');
    assert.equal(wakes.length, 10);
    assert.equal(wakes.reduce((n, w) => n + w.completionIds.length, 0), 1000);
    assert.equal(wakes[0].priority, 'p0', 'the one urgent completion leads');
    assert.equal(wakes[0].recipient, 'lane-7');
  });

  it('chains 50 deltas, then recovers a missed one only from a matching full frame', () => {
    let graph = { nodes: { root: { label: 'v0', edges: [] } }, roots: ['root'] };
    const history = [graph];
    for (let i = 1; i <= 50; i++) {
      const next = JSON.parse(JSON.stringify(graph));
      next.nodes.root.label = `v${i}`;
      graph = medusa.applyDelta(graph, medusa.diffGraphs(graph, next));
      history.push(graph);
    }
    assert.equal(graph.nodes.root.label, 'v50');
    const skip = medusa.diffGraphs(history[49], history[50]);
    assert.throws(() => medusa.applyDelta(history[47], skip), code('BASE_MISMATCH'));
    const recovered = medusa.recoverFromFullFrame({ graph: history[49] }, skip.baseHash);
    assert.equal(medusa.merkleRoot(medusa.applyDelta(recovered, skip)), skip.targetHash);
  });
});

describe('Stage 4: reports and knowledge base stay derived and grounded', () => {
  it('answers 50 questions over a report with only grounded or verbatim output', async () => {
    let html = '<html><body>';
    CANONICAL_SECTIONS.forEach((id, i) => { html += `<section id="${id}">Section ${i} shipped PR #${3000 + i} and tracks KR-${i}.</section>`; });
    const index = e6a.buildSearchIndex(`${html}</body></html>`, { version: 'v6.2.0', now: () => '2026-11-12T00:00:00Z' });
    for (let i = 0; i < 50; i++) {
      const out = await e6b.askReport({
        reports: [{ version: 'v6.2.0', index }], question: `PR #${3000 + (i % CANONICAL_SECTIONS.length)}`,
        selection: null, synthesize: null
      });
      assert.equal(out.ok, true);
      assert.equal(out.code, 'SYNTHESIS_UNAVAILABLE', 'no model bound: verbatim Stage 1 answer only');
      assert.match(out.answer, new RegExp(`PR #${3000 + (i % CANONICAL_SECTIONS.length)}`));
    }
  });

  it('serves 200 budgeted KB searches over the shipped manual, never over budget', () => {
    const productManual = require('../lib/product-manual');
    const manifest = productManual.readManualManifest(path.join(__dirname, '..', 'docs/manual-manifest.json'));
    const contents = {};
    for (const p of manifest.pages) contents[p.path] = fs.readFileSync(path.join(__dirname, '..', p.path), 'utf8');
    const kb = f1.createKnowledgeBase([f1.buildSnapshot(manifest, contents, '6.2.0')]);
    const terms = ['engine', 'session', 'wrap', 'port', 'project', 'release', 'model', 'medusa'];
    for (let i = 0; i < 200; i++) {
      const budget = 50 + (i % 10) * 40;
      const out = f1.search(kb, terms[i % terms.length], { audience: i % 2 ? 'human' : 'nhe', budgetTokens: budget });
      assert.equal(out.ok, true);
      assert.ok(out.usedTokens <= budget, `search ${i} used ${out.usedTokens} > ${budget}`);
    }
  });
});

describe('Stage 5: adversarial probes fail closed', () => {
  let repo;
  let outside;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-soak-repo-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-soak-outside-'));
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'link.txt'));
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('50 path-escape probes against the advisor read nothing outside the repository', () => {
    const probes = ['../x', '/etc/passwd', 'a/../../x', 'link.txt', 'nul\0x', 'back\\slash', '', '.', 'README.md/..', '../../../../etc/hosts'];
    let refused = 0;
    for (let i = 0; i < 50; i++) {
      const rel = probes[i % probes.length];
      try {
        const out = g4.readRepoFile({ repoRoot: repo, relativePath: rel, protectedRoots: [outside] });
        assert.ok(!out.text.includes('top secret'));
      } catch (err) {
        assert.ok(err instanceof g4.AdvisorError, `probe ${JSON.stringify(rel)} threw ${err && err.name}`);
        refused++;
      }
    }
    assert.equal(refused, 50, 'every probe is refused');
    assert.equal(g4.readRepoFile({ repoRoot: repo, relativePath: 'README.md', protectedRoots: [outside] }).text, 'hello');
  });

  it('isolation probes cannot self-grant mounts, run as root, or share the host uid', () => {
    const host = { uid: 501, gid: 20, groups: [20], canSwitchUid: true, runtimes: { docker: true }, realpath: (p) => p, env: {}, home: '/Users/op', mountRoots: ['/'], writableRoots: ['/'] };
    const base = { mode: 'container', runtime: 'docker', image: 'alpine:3', command: ['sh'], uid: 1500, gid: 1500, requireIsolation: true };
    const refusals = [
      [{ ...base, mountRoots: ['/'], mounts: [{ source: '/', target: '/h' }] }, 'MOUNT_POLICY_FROM_PROFILE'],
      [{ ...base, mounts: [{ source: '/', target: '/h' }] }, 'MOUNT_SOURCE_SENSITIVE'],
      [{ ...base, mounts: [{ source: '/Users/op/.ssh', target: '/s' }] }, 'MOUNT_SOURCE_SENSITIVE'],
      [{ ...base, uid: 0 }, 'TARGET_ID_INVALID'],
      [{ ...base, uid: 501 }, 'SAME_UID'],
      [{ ...base, network: 'host' }, 'NETWORK_INVALID']
    ];
    for (const [profile, want] of refusals) {
      const r = a1.planIsolation(profile, host);
      assert.equal(r.ok, false, want);
      assert.equal(r.code, want);
    }
    assert.equal(a1.planIsolation({ ...base, mode: 'shared_uid' }, host).code, 'ISOLATION_REQUIRED', 'never downgraded');
  });

  it('scrubs every seeded secret from 100 diagnostic lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} token ghp_${'A'.repeat(36)} key AKIA${'B'.repeat(16)} user${i}@example.com`);
    for (const line of lines) {
      assert.ok(f3.findSecrets(line).length > 0);
      assert.deepEqual(f3.findSecrets(f3.scrub(line)), []);
    }
  });
});

describe('Full-stack soak and chaos', () => {
  it('injected write conflicts roll back completely, then healthy writes still succeed', () => {
    const env = medusa.createEnvelope({ msg_type: 'ack' });
    medusa.recordMessage(db, { id: 'chaos-base', sender: 'a', recipient: 'b', envelope: env });
    const before = db.prepare('SELECT COUNT(*) AS n FROM v6_medusa_v2_messages').get().n;
    for (let i = 0; i < 20; i++) {
      assert.throws(() => medusa.recordMessage(db, { id: 'chaos-base', sender: 'a', recipient: `z${i}`, envelope: env }), code('IDEMPOTENCY_CONFLICT'));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v6_medusa_v2_messages').get().n, before, 'no partial writes');
    assert.equal(db.isTransaction, false, 'no transaction left open');
    medusa.recordMessage(db, { id: 'chaos-after', sender: 'a', recipient: 'b', envelope: env });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v6_medusa_v2_messages').get().n, before + 1);
  });

  it('an advisor ledger admits exactly its cap across 50 back-to-back reservations (sequential)', () => {
    const ledger = g4.createAdvisorLedger(db, { maxRequests: 7, windowMs: 60_000, dailyTokens: 1_000_000, dailyUsd: 100 });
    const now = Date.UTC(2026, 10, 12, 1);
    const results = Array.from({ length: 50 }, () => ledger.reserve({ tenantId: 'soak-tenant', tokens: 1, usd: 0, now }));
    assert.equal(results.filter((r) => r.ok).length, 7);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'RATE_LIMIT'));
    assert.equal(ledger.usage('soak-tenant', now).requestsInWindow, 7);
  });

  it('wakes persist through a restart and drain only with proof', () => {
    const c = medusa.createWakeCoalescer();
    for (let i = 0; i < 30; i++) c.ingest({ completionId: `r${i}`, fleetId: 'f2', waveId: 'w-restart', recipient: `lane-${i % 3}`, priority: i === 4 ? 'blocker' : 'normal' });
    c.seal('f2', 'w-restart');
    for (const w of c.flush('f2', 'w-restart')) medusa.queueWake(db, w);
    store.close();
    store.init();
    db = store.getDb();
    for (const m of SCHEMA_OWNERS) require(`../lib/v6/${m}`).ensureSchema(db);
    const pending = medusa.pendingWakes(db).filter((w) => w.waveId === 'w-restart');
    assert.equal(pending.length, 3);
    assert.equal(pending[0].priority, 'blocker');
    for (const w of pending) {
      assert.equal(medusa.drainWake(db, w.wakeId, { composerDrained: false, transcriptCommitted: true, marker: 'm' }).code, 'PROOF_REQUIRED');
      assert.equal(medusa.drainWake(db, w.wakeId, { composerDrained: true, transcriptCommitted: true, marker: 'm' }).code, 'DRAINED');
    }
    assert.equal(medusa.pendingWakes(db).filter((w) => w.waveId === 'w-restart').length, 0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });
});
