'use strict';

// #777 — cross-project version dependency registry, semver evaluator, and
// release-notification payload builder. Pure logic; no filesystem, no
// network, and (deliberately) no write path to any project's checkout.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const deps = require('../lib/project-version-deps');

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    assert.ok(deps.compareSemver('1.2.3', '1.2.4') < 0);
    assert.ok(deps.compareSemver('1.3.0', '1.2.9') > 0);
    assert.ok(deps.compareSemver('2.0.0', '1.9.9') > 0);
    assert.equal(deps.compareSemver('1.2.3', '1.2.3'), 0);
  });
});

describe('isValidRange / satisfiesRange', () => {
  it('accepts an exact version, a caret range, and the wildcard', () => {
    assert.equal(deps.isValidRange('5.64.0'), true);
    assert.equal(deps.isValidRange('^5.64.0'), true);
    assert.equal(deps.isValidRange('*'), true);
  });

  it('rejects anything else', () => {
    assert.equal(deps.isValidRange('>=5.64.0'), false);
    assert.equal(deps.isValidRange('5.x'), false);
    assert.equal(deps.isValidRange(''), false);
  });

  it('"*" is satisfied by any version', () => {
    assert.equal(deps.satisfiesRange('0.0.1', '*'), true);
    assert.equal(deps.satisfiesRange('99.0.0', '*'), true);
  });

  it('an exact range is satisfied only by that exact version', () => {
    assert.equal(deps.satisfiesRange('5.64.0', '5.64.0'), true);
    assert.equal(deps.satisfiesRange('5.64.1', '5.64.0'), false);
    assert.equal(deps.satisfiesRange('5.63.0', '5.64.0'), false);
  });

  it('a caret range is satisfied by the same major at or above the pinned minor.patch', () => {
    assert.equal(deps.satisfiesRange('5.64.0', '^5.64.0'), true);
    assert.equal(deps.satisfiesRange('5.70.2', '^5.64.0'), true);
    assert.equal(deps.satisfiesRange('5.63.9', '^5.64.0'), false, 'below the pinned minor.patch');
    assert.equal(deps.satisfiesRange('6.0.0', '^5.64.0'), false, 'a different major is never satisfied by a caret range');
  });

  it('refuses an unrecognized range', () => {
    assert.throws(() => deps.satisfiesRange('5.64.0', '>=5.0.0'), deps.ProjectVersionDepsError);
  });
});

describe('validateEdge / validateRegistry', () => {
  function edge(overrides = {}) {
    return { dependent: 'TiLT-Claw', dependency: 'TangleClaw', requiredRange: '^5.64.0', ...overrides };
  }

  it('accepts a well-formed edge', () => {
    assert.doesNotThrow(() => deps.validateEdge(edge()));
  });

  it('refuses a self-dependency', () => {
    assert.throws(() => deps.validateEdge(edge({ dependent: 'X', dependency: 'X' })), deps.ProjectVersionDepsError);
  });

  it('refuses a malformed requiredRange', () => {
    assert.throws(() => deps.validateEdge(edge({ requiredRange: '>=5.0.0' })), deps.ProjectVersionDepsError);
  });

  it('refuses an unknown key', () => {
    const bad = edge();
    bad.extra = 'nope';
    assert.throws(() => deps.validateEdge(bad), deps.ProjectVersionDepsError);
  });

  it('validateRegistry accepts a list of distinct edges', () => {
    assert.doesNotThrow(() => deps.validateRegistry([edge(), edge({ dependent: 'Other' })]));
  });

  it('validateRegistry refuses two edges for the same (dependent, dependency) pair', () => {
    assert.throws(() => deps.validateRegistry([edge(), edge()]), deps.ProjectVersionDepsError);
  });
});

describe('evaluateEdge / evaluateRegistry', () => {
  const edge = { dependent: 'TiLT-Claw', dependency: 'TangleClaw', requiredRange: '^5.64.0' };

  it('is satisfied when the actual version meets the range', () => {
    assert.deepEqual(deps.evaluateEdge(edge, { TangleClaw: '5.64.0' }), { ...edge, state: deps.DEPENDENCY_STATES.SATISFIED, dependencyVersion: '5.64.0' });
  });

  it('is unknown when the dependency\'s version is not known at all, never a guess', () => {
    const r = deps.evaluateEdge(edge, {});
    assert.equal(r.state, deps.DEPENDENCY_STATES.UNKNOWN);
    assert.equal(r.dependencyVersion, null);
    assert.ok(r.reason.includes('TangleClaw'));
  });

  it('is outdated when the actual version is behind the required range', () => {
    const r = deps.evaluateEdge(edge, { TangleClaw: '5.63.0' });
    assert.equal(r.state, deps.DEPENDENCY_STATES.OUTDATED);
    assert.equal(r.dependencyVersion, '5.63.0');
  });

  it('is breaking when the actual version has moved to a new major the range never pinned', () => {
    const r = deps.evaluateEdge(edge, { TangleClaw: '6.0.0' });
    assert.equal(r.state, deps.DEPENDENCY_STATES.BREAKING);
    assert.equal(r.dependencyVersion, '6.0.0');
  });

  it('evaluateRegistry evaluates every edge', () => {
    const edges = [edge, { dependent: 'Other', dependency: 'Medusa', requiredRange: '*' }];
    const results = deps.evaluateRegistry(edges, { TangleClaw: '5.64.0', Medusa: '1.0.0' });
    assert.equal(results.length, 2);
    assert.equal(results[0].state, deps.DEPENDENCY_STATES.SATISFIED);
    assert.equal(results[1].state, deps.DEPENDENCY_STATES.SATISFIED);
  });
});

describe('dependentsOf', () => {
  const edges = [
    { dependent: 'A', dependency: 'TangleClaw', requiredRange: '*' },
    { dependent: 'B', dependency: 'TangleClaw', requiredRange: '*' },
    { dependent: 'C', dependency: 'Medusa', requiredRange: '*' }
  ];

  it('returns every edge naming the project as its dependency', () => {
    assert.deepEqual(dependentsOfIds(deps.dependentsOf(edges, 'TangleClaw')), ['A', 'B']);
  });

  it('returns nothing for a project with no dependents', () => {
    assert.deepEqual(deps.dependentsOf(edges, 'Nobody Depends On Me'), []);
  });

  function dependentsOfIds(list) {
    return list.map((e) => e.dependent);
  }
});

describe('buildReleaseNotificationPayloads', () => {
  const edges = [
    { dependent: 'TiLT-Claw', dependency: 'TangleClaw', requiredRange: '^5.64.0' },
    { dependent: 'Medusa-Client', dependency: 'Medusa', requiredRange: '*' }
  ];

  it('builds one payload per affected dependent, never touching unrelated edges', () => {
    const payloads = deps.buildReleaseNotificationPayloads(edges, { project: 'TangleClaw', previousVersion: '5.63.0', newVersion: '5.64.0' });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].dependent, 'TiLT-Claw');
    assert.equal(payloads[0].stateBefore, deps.DEPENDENCY_STATES.OUTDATED);
    assert.equal(payloads[0].stateAfter, deps.DEPENDENCY_STATES.SATISFIED);
    assert.equal(payloads[0].changed, true);
    assert.ok(payloads[0].message.includes('TangleClaw released 5.64.0'));
  });

  it('reports changed:false when the release does not alter the dependent\'s state', () => {
    const payloads = deps.buildReleaseNotificationPayloads(edges, { project: 'TangleClaw', previousVersion: '5.64.0', newVersion: '5.64.5' });
    assert.equal(payloads[0].stateBefore, deps.DEPENDENCY_STATES.SATISFIED);
    assert.equal(payloads[0].stateAfter, deps.DEPENDENCY_STATES.SATISFIED);
    assert.equal(payloads[0].changed, false);
  });

  it('a breaking major release is reported as breaking, not outdated', () => {
    const payloads = deps.buildReleaseNotificationPayloads(edges, { project: 'TangleClaw', previousVersion: '5.64.0', newVersion: '6.0.0' });
    assert.equal(payloads[0].stateAfter, deps.DEPENDENCY_STATES.BREAKING);
  });

  it('never generates a payload for a project nothing depends on', () => {
    const payloads = deps.buildReleaseNotificationPayloads(edges, { project: 'Nobody Depends On Me', previousVersion: '1.0.0', newVersion: '1.0.1' });
    assert.deepEqual(payloads, []);
  });
});
