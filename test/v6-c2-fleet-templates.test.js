'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const c2 = require('../lib/v6/c2-fleet-templates');

// v6 (#2984, V6-11 / C2, Car V60-T2-W1-B): the starter fleet template
// catalog and its guided apply-wizard planner.

describe('listFleetTemplates / getFleetTemplate (#2984)', () => {
  it('lists exactly the three versioned templates #2984 names', () => {
    const templates = c2.listFleetTemplates();
    assert.deepEqual(templates.map((t) => t.id).sort(), ['large-configurable', 'recommended-10-role', 'small-4-seat']);
  });

  it('getFleetTemplate returns null for an unknown id', () => {
    assert.equal(c2.getFleetTemplate('not-a-real-template'), null);
  });

  it('every template is read-only (frozen)', () => {
    for (const template of c2.listFleetTemplates()) {
      assert.ok(Object.isFrozen(template), template.id);
    }
  });

  it('returns null for "__proto__" rather than Object.prototype (PRR-B R1 HOLD)', () => {
    assert.equal(c2.getFleetTemplate('__proto__'), null);
    assert.equal(c2.getFleetTemplate('constructor'), null);
    assert.equal(c2.getFleetTemplate('toString'), null);
  });

  it('mutating a seat object returned from getFleetTemplate throws (frozen), never silently corrupting the shared template (PRR-B R1 HOLD)', () => {
    const template = c2.getFleetTemplate('small-4-seat');
    assert.ok(Object.isFrozen(template.seats[0]), 'each seat object must itself be frozen');
    // This file is already 'use strict' (line 1), so assigning to a frozen
    // object's property throws here rather than silently no-opping.
    assert.throws(() => { template.seats[0].supervisory = false; }, TypeError);
    const stillSupervisory = c2.getFleetTemplate('small-4-seat').seats[0];
    assert.equal(stillSupervisory.role, 'PM');
    assert.equal(stillSupervisory.supervisory, true);
  });

  it('mutating a seat object does not corrupt a LATER planFleetApply call for the same template (PRR-B R1 HOLD regression)', () => {
    const template = c2.getFleetTemplate('small-4-seat');
    try {
      template.seats[0].supervisory = false;
    } catch {
      // frozen -- the throw itself is the protection; ignore and verify below.
    }
    const plan = c2.planFleetApply('small-4-seat');
    assert.equal(plan.immediateSeats.length, 1);
    assert.equal(plan.immediateSeats[0].role, 'PM');
  });
});

describe('instantiateFleetTemplate (#2984)', () => {
  it('small-4-seat has exactly 4 seats with one supervisory PM', () => {
    const { seats } = c2.instantiateFleetTemplate('small-4-seat');
    assert.equal(seats.length, 4);
    assert.deepEqual(seats.filter((s) => s.supervisory).map((s) => s.role), ['PM']);
  });

  it('recommended-10-role has exactly the 10 roles #2984 names', () => {
    const { seats } = c2.instantiateFleetTemplate('recommended-10-role');
    assert.equal(seats.length, 10);
    const byRole = {};
    for (const s of seats) byRole[s.role] = (byRole[s.role] || 0) + 1;
    assert.deepEqual(byRole, { PM: 1, Architect: 1, Builder: 4, PRR: 2, Integrator: 1, Observer: 1 });
    assert.deepEqual(seats.filter((s) => s.supervisory).map((s) => s.role), ['PM']);
  });

  it('large-configurable defaults to 1 PM + 1 Architect + 4 Builders + 2 PRR + 1 Integrator + 1 Observer', () => {
    const { seats } = c2.instantiateFleetTemplate('large-configurable');
    const byRole = {};
    for (const s of seats) byRole[s.role] = (byRole[s.role] || 0) + 1;
    assert.deepEqual(byRole, { PM: 1, Architect: 1, Builder: 4, PRR: 2, Integrator: 1, Observer: 1 });
  });

  it('large-configurable honors a caller-supplied count per role, clamped to its declared min/max', () => {
    const { seats } = c2.instantiateFleetTemplate('large-configurable', { Builder: 8, PRR: 0, Architect: 999 });
    const byRole = {};
    for (const s of seats) byRole[s.role] = (byRole[s.role] || 0) + 1;
    assert.equal(byRole.Builder, 8);
    assert.equal(byRole.PRR, undefined);
    assert.equal(byRole.Architect, 8, 'clamped to the declared max');
  });

  it('large-configurable letters seats within a role group in order (builder-a, builder-b, ...)', () => {
    const { seats } = c2.instantiateFleetTemplate('large-configurable', { Builder: 3 });
    const builderIds = seats.filter((s) => s.role === 'Builder').map((s) => s.seatId);
    assert.deepEqual(builderIds, ['builder-a', 'builder-b', 'builder-c']);
  });

  it('a fixed template ignores a config argument harmlessly', () => {
    const { seats } = c2.instantiateFleetTemplate('small-4-seat', { Builder: 50 });
    assert.equal(seats.length, 4);
  });

  it('returns null for an unknown template id', () => {
    assert.equal(c2.instantiateFleetTemplate('not-a-real-template'), null);
  });

  it('returns null for "__proto__" rather than throwing (PRR-B R1 HOLD)', () => {
    assert.equal(c2.instantiateFleetTemplate('__proto__'), null);
  });
});

describe('planFleetApply (#2984 deliverable 2 — guided apply wizard)', () => {
  it('starts ONLY the supervisory PM seat immediately, deferring every other seat', () => {
    const plan = c2.planFleetApply('recommended-10-role');
    assert.equal(plan.immediateSeats.length, 1);
    assert.equal(plan.immediateSeats[0].role, 'PM');
    assert.equal(plan.deferredSeats.length, 9);
    assert.ok(plan.deferredSeats.every((s) => s.trigger === 'on-demand'));
  });

  it('plans small-4-seat the same way: PM immediate, the other 3 deferred', () => {
    const plan = c2.planFleetApply('small-4-seat');
    assert.equal(plan.immediateSeats.length, 1);
    assert.equal(plan.deferredSeats.length, 3);
  });

  it('plans large-configurable against a caller-supplied config', () => {
    const plan = c2.planFleetApply('large-configurable', { Builder: 2, Architect: 0, PRR: 0, Integrator: 0, Observer: 0 });
    assert.equal(plan.immediateSeats.length, 1);
    assert.equal(plan.deferredSeats.length, 2);
  });

  it('returns null for an unknown template id', () => {
    assert.equal(c2.planFleetApply('not-a-real-template'), null);
  });
});

describe('admitDeferredSeat (#2984 deliverable 2 — wake on demand)', () => {
  it('moves one deferred seat into immediateSeats, leaving the plan otherwise untouched', () => {
    const plan = c2.planFleetApply('small-4-seat');
    const { plan: next, admitted } = c2.admitDeferredSeat(plan, 'architect');
    assert.equal(admitted, true);
    assert.ok(next.immediateSeats.some((s) => s.seatId === 'architect'));
    assert.ok(!next.deferredSeats.some((s) => s.seatId === 'architect'));
    assert.equal(next.deferredSeats.length, plan.deferredSeats.length - 1);
  });

  it('does not mutate the original plan (pure)', () => {
    const plan = c2.planFleetApply('small-4-seat');
    const before = JSON.stringify(plan);
    c2.admitDeferredSeat(plan, 'architect');
    assert.equal(JSON.stringify(plan), before);
  });

  it('returns admitted: false and the same plan for a seatId that is not deferred', () => {
    const plan = c2.planFleetApply('small-4-seat');
    const { plan: next, admitted } = c2.admitDeferredSeat(plan, 'not-a-real-seat');
    assert.equal(admitted, false);
    assert.equal(next, plan);
  });

  it('admitting an already-immediate seat (pm) also reports not admitted', () => {
    const plan = c2.planFleetApply('small-4-seat');
    const { admitted } = c2.admitDeferredSeat(plan, 'pm');
    assert.equal(admitted, false);
  });

  it('admitting the same seat twice the second call reports not admitted', () => {
    const plan = c2.planFleetApply('small-4-seat');
    const { plan: once } = c2.admitDeferredSeat(plan, 'architect');
    const { admitted } = c2.admitDeferredSeat(once, 'architect');
    assert.equal(admitted, false);
  });
});

describe('ROLES (#2984)', () => {
  it('names every role used across all three templates', () => {
    for (const template of c2.listFleetTemplates()) {
      const instantiated = c2.instantiateFleetTemplate(template.id);
      for (const seat of instantiated.seats) {
        assert.ok(c2.ROLES.includes(seat.role), `${template.id}: ${seat.role}`);
      }
    }
  });
});
