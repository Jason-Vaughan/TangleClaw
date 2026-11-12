'use strict';

// v6.2 (#3001, V6-31 / E3b, Car V62-W1-A): the multi-train what-if capacity
// and bottleneck simulator — deterministic scheduling across trains with
// dependencies, file locks, role pools and per-lane quotas; critical-path
// shift and scenario comparison; idempotent persistence against a real
// node:sqlite-backed store.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const e3b = require('../lib/v6/e3b-whatif-simulator');

/**
 * Shorthand car.
 * @param {string} id
 * @param {number} effort
 * @param {object} [extra]
 * @returns {object}
 */
const car = (id, effort, extra = {}) => ({ id, effort, ...extra });

describe('simulate — scheduling (#3001)', () => {
  it('runs independent file-disjoint cars in parallel up to the role pool, then queues', () => {
    const r = e3b.simulate({
      trains: [{ id: 't1', cars: [car('a', 2, { files: ['a.js'] }), car('b', 2, { files: ['b.js'] }), car('c', 2, { files: ['c.js'] })] }],
      rolePools: { Builder: 2 }
    });
    assert.equal(r.makespan, 4);
    assert.deepEqual(r.schedule.map((x) => [x.carId, x.start, x.end]), [['a', 0, 2], ['b', 0, 2], ['c', 2, 4]]);
    assert.equal(r.bottlenecks.Builder.laneWait, 2, 'c waited two units for a lane');
    assert.equal(r.utilization.Builder, 6 / 8);
  });

  it('never runs two cars that share a file at once, and charges the wait to fileWait', () => {
    const r = e3b.simulate({
      trains: [{ id: 't1', cars: [car('a', 3, { files: ['shared.js'] })] }, { id: 't2', cars: [car('b', 1, { files: ['shared.js'] })] }],
      rolePools: { Builder: 4 }
    });
    const [first, second] = r.schedule;
    assert.ok(second.start >= first.end, 'file-conflicting cars are serialized across trains');
    assert.equal(r.makespan, 4);
    assert.equal(r.bottlenecks.Builder.fileWait, 3);
  });

  it('respects dependencies across trains and reports each train\'s finish', () => {
    const r = e3b.simulate({
      trains: [{ id: 'core', cars: [car('schema', 3)] }, { id: 'ui', cars: [car('view', 2, { dependsOn: ['schema'] })] }],
      rolePools: { Builder: 2 }
    });
    const view = r.schedule.find((x) => x.carId === 'view');
    assert.equal(view.start, 3);
    assert.deepEqual(r.trainFinish, { core: 3, ui: 5 });
  });

  it('routes each car to a lane of its own role', () => {
    const r = e3b.simulate({
      trains: [{ id: 't', cars: [car('build', 2), car('review', 1, { role: 'Reviewer', dependsOn: ['build'] })] }],
      rolePools: { Builder: 1, Reviewer: 1 }
    });
    assert.deepEqual(r.schedule.map((x) => [x.carId, x.lane]), [['build', 'Builder-1'], ['review', 'Reviewer-1']]);
  });

  it('starts the longest remaining critical path first, deterministically', () => {
    const scenario = {
      trains: [{ id: 't', cars: [car('short', 1), car('long', 1), car('long2', 5, { dependsOn: ['long'] })] }],
      rolePools: { Builder: 1 }
    };
    const r = e3b.simulate(scenario);
    assert.equal(r.schedule[0].carId, 'long', 'the car heading the longer chain goes first');
    assert.deepEqual(e3b.simulate(scenario), r, 'the same scenario always gives the same answer');
  });
});

describe('simulate — quota and unschedulable reasons (#3001)', () => {
  it('a per-lane quota bounds total work: the longer chain is funded first and the car left over is QUOTA_EXHAUSTED', () => {
    const r = e3b.simulate({
      trains: [{ id: 't', cars: [car('a', 3), car('b', 3), car('c', 1, { dependsOn: ['b'] })] }],
      rolePools: { Builder: 1 },
      quotaUnits: { Builder: 4 }
    });
    assert.deepEqual(r.schedule.map((x) => x.carId), ['b', 'c'], 'b heads the longer chain (b->c = 4 units)');
    assert.deepEqual(r.unschedulable, [{ carId: 'a', reason: 'QUOTA_EXHAUSTED' }]);
    assert.equal(r.trainFinish.t, null, 'a train with an unschedulable car never finishes');
  });

  it('a car whose dependency the quota can never fund is QUOTA_EXHAUSTED too', () => {
    const r = e3b.simulate({
      trains: [{ id: 't', cars: [car('x', 4), car('y', 3), car('z', 1, { dependsOn: ['y'] })] }],
      rolePools: { Builder: 1 },
      quotaUnits: { Builder: 5 }
    });
    assert.deepEqual(r.schedule.map((x) => x.carId), ['x']);
    assert.deepEqual(r.unschedulable, [{ carId: 'y', reason: 'QUOTA_EXHAUSTED' }, { carId: 'z', reason: 'QUOTA_EXHAUSTED' }]);
  });

  it('names a cycle, an unknown dependency and a role with no lanes, and blocks their dependents', () => {
    const r = e3b.simulate({
      trains: [{ id: 't', cars: [
        car('x', 1, { dependsOn: ['y'] }), car('y', 1, { dependsOn: ['x'] }),
        car('orphan', 1, { dependsOn: ['ghost'] }),
        car('doc', 1, { role: 'Writer' }), car('after-doc', 1, { dependsOn: ['doc'] }),
        car('ok', 1)
      ] }],
      rolePools: { Builder: 1 }
    });
    assert.deepEqual(r.unschedulable, [
      { carId: 'after-doc', reason: 'NO_LANE_FOR_ROLE' }, { carId: 'doc', reason: 'NO_LANE_FOR_ROLE' },
      { carId: 'orphan', reason: 'UNKNOWN_DEPENDENCY' }, { carId: 'x', reason: 'CYCLE' }, { carId: 'y', reason: 'CYCLE' }
    ]);
    assert.deepEqual(r.schedule.map((x) => x.carId), ['ok']);
  });

  it('rejects malformed scenarios with a named TypeError rather than guessing', () => {
    assert.throws(() => e3b.simulate({ trains: [], rolePools: {} }), /trains/);
    assert.throws(() => e3b.simulate({ trains: [{ id: 't', cars: [car('a', 0)] }], rolePools: { Builder: 1 } }), /effort/);
    assert.throws(() => e3b.simulate({ trains: [{ id: 't', cars: [car('a', 1), car('a', 1)] }], rolePools: { Builder: 1 } }), /unique/);
    assert.throws(() => e3b.simulate({ trains: [{ id: 't', cars: [] }], rolePools: { Builder: 1 }, quotaUnits: { Reviewer: 5 } }), /quotaUnits/);
    assert.throws(() => e3b.simulate({ trains: [{ id: '__proto__ bad', cars: [] }], rolePools: { Builder: 1 } }), /unique id/);
  });
});

describe('critical path and scenario comparison (#3001)', () => {
  const base = {
    trains: [
      { id: 't1', cars: [car('a', 4), car('b', 2, { dependsOn: ['a'] })] },
      { id: 't2', cars: [car('c', 3), car('d', 4, { dependsOn: ['c'] })] }
    ],
    rolePools: { Builder: 1 }
  };

  it('reports the longest effort-weighted chain', () => {
    assert.deepEqual(e3b.simulate(base).criticalPath, { carIds: ['c', 'd'], effort: 7 });
  });

  it('ranks variants by makespan and reports deltas and a critical-path shift', () => {
    const moreLanes = { ...base, rolePools: { Builder: 2 } };
    const slowerA = { ...base, trains: [{ id: 't1', cars: [car('a', 9), car('b', 2, { dependsOn: ['a'] })] }, base.trains[1]] };
    const out = e3b.compareScenarios(base, [{ name: 'slower-a', scenario: slowerA }, { name: 'two-lanes', scenario: moreLanes }]);
    assert.equal(out.baseline.makespan, 13);
    assert.deepEqual(out.variants.map((v) => [v.name, v.makespan, v.makespanDelta]), [['two-lanes', 7, -6], ['slower-a', 18, 5]]);
    assert.equal(out.variants.find((v) => v.name === 'slower-a').criticalPathShifted, true);
    assert.deepEqual(out.variants.find((v) => v.name === 'slower-a').criticalPath.carIds, ['a', 'b']);
    assert.equal(out.variants.find((v) => v.name === 'two-lanes').criticalPathShifted, false);
    assert.throws(() => e3b.compareScenarios(base, [{ name: 'x', scenario: base }, { name: 'x', scenario: base }]), /unique name/);
  });
});

describe('persistence (#3001)', () => {
  let tmpDir;
  let db;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-e3b-'));
    store._setBasePath(tmpDir);
    store.init();
    db = store.getDb();
  });
  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ensureSchema is idempotent', () => {
    e3b.ensureSchema(db);
    e3b.ensureSchema(db);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'v6_e3b_simulations'").get());
  });

  it('scenarioDigest ignores key and car order but changes with any real difference', () => {
    const a = { trains: [{ id: 't', cars: [car('a', 1), car('b', 2)] }], rolePools: { Builder: 1 } };
    const reordered = { rolePools: { Builder: 1 }, trains: [{ id: 't', cars: [car('b', 2), car('a', 1)] }] };
    assert.equal(e3b.scenarioDigest(a), e3b.scenarioDigest(reordered));
    assert.notEqual(e3b.scenarioDigest(a), e3b.scenarioDigest({ ...a, rolePools: { Builder: 2 } }));
    assert.match(e3b.scenarioDigest(a), /^[0-9a-f]{64}$/);
  });

  it('saves once per scenario, whatever its key order, and reads it back', () => {
    const scenario = { trains: [{ id: 't', cars: [car('a', 1)] }], rolePools: { Builder: 1 } };
    const reordered = { rolePools: { Builder: 1 }, trains: [{ cars: [{ effort: 1, id: 'a' }], id: 't' }] };
    const first = e3b.saveSimulation(db, { scenario, label: 'baseline' });
    assert.deepEqual([first.ok, first.code], [true, 'CREATED']);
    const again = e3b.saveSimulation(db, { scenario: reordered });
    assert.deepEqual([again.code, again.id], ['EXISTING', first.id]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM v6_e3b_simulations').get().n, 1);
    const read = e3b.getSimulation(db, first.id);
    assert.deepEqual([read.label, read.result.makespan], ['baseline', 1]);
    assert.equal(e3b.getSimulation(db, 'missing'), null);
  });

  it('refuses an invalid scenario or label without writing', () => {
    assert.equal(e3b.saveSimulation(db, { scenario: { trains: [] } }).code, 'SCENARIO_INVALID');
    assert.equal(e3b.saveSimulation(db, { scenario: { trains: [{ id: 't', cars: [car('a', 1)] }], rolePools: { Builder: 1 } }, label: 'x'.repeat(161) }).code, 'LABEL_INVALID');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM v6_e3b_simulations').get().n, 0);
  });
});
