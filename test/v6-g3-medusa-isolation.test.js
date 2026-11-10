'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const g3 = require('../lib/v6/g3-medusa-isolation');

// v6 (#2986, V6-14 / G3, Car V60-T2-W1-D): default-on Medusa communication
// and the mandatory Project/Fleet switchboard isolation ACL.

describe('defaultMedusaSettings (#2986 deliverable 1)', () => {
  it('defaults both medusaEnabled and medusaWake to true', () => {
    assert.deepEqual(g3.defaultMedusaSettings(), { medusaEnabled: true, medusaWake: true });
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = g3.defaultMedusaSettings();
    const b = g3.defaultMedusaSettings();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });
});

describe('checkMedusaCrossProjectAccess (#2986 deliverable 2)', () => {
  it('always allows a project to reach its own switchboard', () => {
    assert.deepEqual(g3.checkMedusaCrossProjectAccess('p1', 'p1'), { allowed: true });
  });

  it('refuses a different project with MEDUSA_CROSS_PROJECT_DENIED when no link exists', () => {
    const res = g3.checkMedusaCrossProjectAccess('p1', 'p2');
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'MEDUSA_CROSS_PROJECT_DENIED');
  });

  it('refuses when crossProjectLinks is omitted entirely', () => {
    const res = g3.checkMedusaCrossProjectAccess('p1', 'p2', {});
    assert.equal(res.allowed, false);
  });

  it('allows a different project when an explicit directional link covers it', () => {
    const res = g3.checkMedusaCrossProjectAccess('p1', 'p2', {
      crossProjectLinks: [{ fromProjectId: 'p1', toProjectId: 'p2' }]
    });
    assert.equal(res.allowed, true);
  });

  it('a directional link does NOT admit the reverse direction by default', () => {
    const res = g3.checkMedusaCrossProjectAccess('p2', 'p1', {
      crossProjectLinks: [{ fromProjectId: 'p1', toProjectId: 'p2' }]
    });
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'MEDUSA_CROSS_PROJECT_DENIED');
  });

  it('a bidirectional link admits both directions', () => {
    const links = [{ fromProjectId: 'p1', toProjectId: 'p2', bidirectional: true }];
    assert.equal(g3.checkMedusaCrossProjectAccess('p1', 'p2', { crossProjectLinks: links }).allowed, true);
    assert.equal(g3.checkMedusaCrossProjectAccess('p2', 'p1', { crossProjectLinks: links }).allowed, true);
  });

  it('an unrelated link does not admit an uncovered pair', () => {
    const res = g3.checkMedusaCrossProjectAccess('p1', 'p2', {
      crossProjectLinks: [{ fromProjectId: 'p3', toProjectId: 'p4', bidirectional: true }]
    });
    assert.equal(res.allowed, false);
  });

  it('matches project ids by value regardless of string/number type', () => {
    const res = g3.checkMedusaCrossProjectAccess(1, 2, {
      crossProjectLinks: [{ fromProjectId: '1', toProjectId: '2' }]
    });
    assert.equal(res.allowed, true);
  });

  it('a project always reaches itself even when crossProjectLinks lists unrelated links', () => {
    const res = g3.checkMedusaCrossProjectAccess('p1', 'p1', {
      crossProjectLinks: [{ fromProjectId: 'p9', toProjectId: 'p8' }]
    });
    assert.equal(res.allowed, true);
  });
});
