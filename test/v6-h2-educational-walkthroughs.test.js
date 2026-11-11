'use strict';

/*
 * v6 (#3000, V6-30 / H2, Car V61-W1-D): the five educational walkthroughs,
 * the architecture glossary and the publication gate
 * (`lib/v6/h2-educational-walkthroughs.js`). Small tier: pure data checks.
 *
 * Two kinds of check: shape (every walkthrough is complete and consistent)
 * and truth (every `tc` command it cites is a real verb and subverb in
 * lib/tc-verbs.js, and its template claims match lib/v6/c2-fleet-templates.js),
 * because learner-facing copy that names a command that does not exist is
 * the defect this module exists to prevent.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  VERIFICATION_STATUSES, SURFACE_STATES, GLOSSARY, WALKTHROUGHS,
  listWalkthroughs, getWalkthrough, tcCommandsIn, glossaryTerm, publicationGate
} = require('../lib/v6/h2-educational-walkthroughs');
const tcVerbs = require('../lib/tc-verbs');
const c2 = require('../lib/v6/c2-fleet-templates');

/** Subverb lists lib/tc-verbs.js exports, keyed by their verb. */
const SUBVERBS = {
  start: tcVerbs.START_SUBVERBS,
  control: tcVerbs.CONTROL_SUBVERBS,
  message: tcVerbs.MESSAGE_SUBVERBS,
  workload: tcVerbs.WORKLOAD_SUBVERBS,
  branch: tcVerbs.BRANCH_SUBVERBS,
  rotation: tcVerbs.ROTATION_SUBVERBS
};

/**
 * A walkthrough's verification record marked verified on `build` for every step.
 * @param {object} w
 * @param {string} build
 * @returns {object}
 */
function verifiedCopy(w, build) {
  return { ...w, verification: { status: 'verified', buildVersion: build, verifiedAt: '2026-11-11', verifiedSteps: w.steps.map((s) => s.id) } };
}

describe('the five walkthroughs #3000 names', () => {
  it('ships exactly the five titles, in learning order', () => {
    assert.deepEqual(WALKTHROUGHS.map((w) => w.title), [
      'Install to First Chat',
      '4-Seat & 10-Role Fleet Setup',
      'Charter to Wave Execution',
      'Multi-Engine Failover',
      'Open Hood Inspection'
    ]);
  });

  it('every walkthrough is complete: unique ids, prerequisites, steps with expectations, success criteria', () => {
    const ids = WALKTHROUGHS.map((w) => w.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const w of WALKTHROUGHS) {
      assert.ok(w.summary.length > 20, w.id);
      assert.ok(w.prerequisites.length > 0, w.id);
      assert.ok(w.steps.length >= 4, w.id);
      assert.ok(w.successCriteria.length > 0, w.id);
      const stepIds = w.steps.map((s) => s.id);
      assert.equal(new Set(stepIds).size, stepIds.length, `${w.id} step ids`);
      for (const s of w.steps) {
        assert.ok(s.instruction && s.expect, `${w.id}/${s.id}`);
        if (s.surface) assert.ok(Object.hasOwn(w.surfaces, s.surface), `${w.id}/${s.id} names an undeclared surface ${s.surface}`);
      }
      assert.ok(Object.values(w.surfaces).every((v) => SURFACE_STATES.includes(v)), w.id);
    }
  });

  it('every walkthrough ships unverified: none has been run against a release build yet', () => {
    assert.deepEqual([...VERIFICATION_STATUSES], ['unverified', 'verified']);
    for (const w of WALKTHROUGHS) {
      assert.equal(w.verification.status, 'unverified', w.id);
      assert.equal(w.verification.buildVersion, null, w.id);
    }
  });

  it('the content is frozen', () => {
    assert.ok(Object.isFrozen(WALKTHROUGHS));
    assert.ok(Object.isFrozen(WALKTHROUGHS[0].steps[0]));
    assert.ok(Object.isFrozen(GLOSSARY));
  });
});

describe('truth checks against the real product', () => {
  it('every cited tc verb exists in lib/tc-verbs.js VERB_ROSTER', () => {
    const verbs = new Set(tcVerbs.VERB_ROSTER.map((v) => v.id));
    const cited = WALKTHROUGHS.flatMap(tcCommandsIn);
    assert.ok(cited.length >= 5, 'the kit cites real commands');
    for (const cmd of cited) {
      const [tc, verb] = cmd.split(' ');
      assert.equal(tc, 'tc', cmd);
      assert.ok(verbs.has(verb), `${cmd}: no such tc verb`);
    }
  });

  it('every cited subverb exists in that verb\'s exported subverb list', () => {
    for (const cmd of WALKTHROUGHS.flatMap(tcCommandsIn)) {
      const [, verb, sub] = cmd.split(' ');
      if (!sub || !SUBVERBS[verb]) continue;
      assert.ok(SUBVERBS[verb].includes(sub), `${cmd}: ${verb} has no subverb ${sub}`);
    }
  });

  it('the fleet walkthrough\'s template claims match the C2 catalog\'s actual plans', () => {
    const fleet = getWalkthrough('fleet-setup');
    const text = JSON.stringify(fleet);
    for (const templateId of ['small-4-seat', 'recommended-10-role']) {
      assert.ok(text.includes(templateId), templateId);
      const plan = c2.planFleetApply(templateId, {});
      assert.equal(plan.immediateSeats.length, 1, `${templateId}: one seat starts immediately`);
    }
    assert.equal(c2.planFleetApply('small-4-seat', {}).deferredSeats.length, 3, 'small-4-seat defers the other three');
    assert.equal(c2.getFleetTemplate('recommended-10-role').seats.length, 10);
  });

  it('a reply is always taught before its acknowledgement', () => {
    const steps = getWalkthrough('charter-to-wave-execution').steps.map((s) => s.command).filter(Boolean);
    assert.ok(steps.indexOf('tc message send') < steps.indexOf('tc message ack'));
  });
});

describe('listWalkthroughs / getWalkthrough / tcCommandsIn', () => {
  it('lists a summary row per walkthrough', () => {
    const rows = listWalkthroughs();
    assert.equal(rows.length, 5);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'stepCount', 'summary', 'title', 'verification']);
    assert.equal(rows[0].stepCount, WALKTHROUGHS[0].steps.length);
  });

  it('finds by id and returns null otherwise', () => {
    assert.equal(getWalkthrough('open-hood-inspection').title, 'Open Hood Inspection');
    assert.equal(getWalkthrough('nope'), null);
  });

  it('extracts commands as verb plus subverb, and tolerates a missing walkthrough', () => {
    assert.deepEqual(tcCommandsIn({ steps: [{ command: 'tc message send --in-reply-to x y z' }, { instruction: 'no command' }] }), ['tc message send']);
    assert.deepEqual(tcCommandsIn(null), []);
  });
});

describe('glossary', () => {
  it('defines the core v6 terms, each in a sentence', () => {
    for (const term of ['Logical Project', 'Fleet', 'Lane', 'Car', 'Wave', 'Charter', 'R-Gate', 'Open Hood', 'Medusa', 'Failover']) {
      assert.ok(Object.hasOwn(GLOSSARY, term), term);
      assert.ok(GLOSSARY[term].length > 20, term);
    }
  });

  it('looks terms up ignoring case and whitespace', () => {
    assert.equal(glossaryTerm('  open hood ').term, 'Open Hood');
    assert.equal(glossaryTerm('nothing'), null);
    assert.equal(glossaryTerm(null), null);
  });
});

describe('publicationGate', () => {
  const w = getWalkthrough('install-to-first-chat');
  const allSurfaces = Object.keys(w.surfaces);

  it('refuses every shipped walkthrough as it stands', () => {
    for (const each of WALKTHROUGHS) {
      const r = publicationGate(each, { buildVersion: '6.1.0' });
      assert.equal(r.publishable, false, each.id);
      assert.ok(r.reasons.includes('NOT_VERIFIED'), each.id);
    }
  });

  it('names every blocker: no build, unverified, unverified steps, unshipped surfaces', () => {
    const r = publicationGate(w, {});
    assert.ok(r.reasons.includes('BUILD_VERSION_REQUIRED'));
    assert.ok(r.reasons.includes('NOT_VERIFIED'));
    assert.ok(r.reasons.some((x) => x.startsWith('STEPS_UNVERIFIED:fixture,')));
    assert.ok(r.reasons.includes('SURFACES_UNSHIPPED:conversationTimeline'));
  });

  it('publishes only when verified on exactly this build, every step, every surface confirmed', () => {
    const ok = publicationGate(verifiedCopy(w, '6.1.0'), { buildVersion: '6.1.0', confirmedSurfaces: allSurfaces });
    assert.deepEqual(ok, { publishable: true, reasons: [] });
  });

  it('verification on another build does not carry over', () => {
    const r = publicationGate(verifiedCopy(w, '6.0.1'), { buildVersion: '6.1.0', confirmedSurfaces: allSurfaces });
    assert.deepEqual(r.reasons, ['VERIFIED_ON_OTHER_BUILD']);
  });

  it('one unverified step, or one unconfirmed proposed surface, blocks publication', () => {
    const partial = verifiedCopy(w, '6.1.0');
    partial.verification = { ...partial.verification, verifiedSteps: partial.verification.verifiedSteps.slice(1) };
    assert.deepEqual(publicationGate(partial, { buildVersion: '6.1.0', confirmedSurfaces: allSurfaces }).reasons, ['STEPS_UNVERIFIED:fixture']);
    assert.deepEqual(publicationGate(verifiedCopy(w, '6.1.0'), { buildVersion: '6.1.0' }).reasons, ['SURFACES_UNSHIPPED:conversationTimeline']);
  });

  it('refuses something that is not a walkthrough', () => {
    assert.deepEqual(publicationGate(null, { buildVersion: '6.1.0' }), { publishable: false, reasons: ['UNKNOWN_WALKTHROUGH'] });
  });
});
