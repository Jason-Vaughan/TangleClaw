'use strict';

// #2125: pure template + helpers, no store access of its own. Verifies the
// tag-based recognition (survives an edited copy) and the create() payload
// shape W2-A's lib/projects.js wiring will eventually pass through.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const onboarding = require('../lib/project-onboarding-rules');

describe('project-onboarding-rules', () => {
  describe('TRUST_RULE_TEMPLATE', () => {
    it('embeds the tag exactly once and is a non-empty string', () => {
      const occurrences = onboarding.TRUST_RULE_TEMPLATE.split(onboarding.TRUST_RULE_TAG).length - 1;
      assert.equal(occurrences, 1);
      assert.ok(onboarding.TRUST_RULE_TEMPLATE.trim().length > onboarding.TRUST_RULE_TAG.length);
    });

    it('names both roster verification and Operator primacy', () => {
      assert.match(onboarding.TRUST_RULE_TEMPLATE, /roster/i);
      assert.match(onboarding.TRUST_RULE_TEMPLATE, /Operator's own word always wins/);
    });
  });

  describe('hasTrustRule', () => {
    it('reports absent for an empty or non-array input', () => {
      assert.deepEqual(onboarding.hasTrustRule([]), { present: false, rule: null });
      assert.deepEqual(onboarding.hasTrustRule(undefined), { present: false, rule: null });
      assert.deepEqual(onboarding.hasTrustRule(null), { present: false, rule: null });
    });

    it('reports absent when no rule carries the tag', () => {
      const rules = [{ content: 'some unrelated rule' }, { content: 'another one' }];
      assert.equal(onboarding.hasTrustRule(rules).present, false);
    });

    it('finds the exact seeded template', () => {
      const rules = [{ id: 1, content: 'unrelated' }, { id: 2, content: onboarding.TRUST_RULE_TEMPLATE }];
      const { present, rule } = onboarding.hasTrustRule(rules);
      assert.equal(present, true);
      assert.equal(rule.id, 2);
    });

    it('still finds an operator-edited copy that kept the tag', () => {
      const edited = onboarding.TRUST_RULE_TEMPLATE.replace('routine, in-scope assignments', 'routine assignments only');
      const { present, rule } = onboarding.hasTrustRule([{ id: 5, content: edited }]);
      assert.equal(present, true);
      assert.equal(rule.id, 5);
    });

    it('treats a row with no status field as live (counts)', () => {
      const { present } = onboarding.hasTrustRule([{ id: 1, content: onboarding.TRUST_RULE_TEMPLATE }]);
      assert.equal(present, true);
    });

    for (const live of ['active', 'proposed']) {
      it(`counts a ${live} tagged row as present`, () => {
        const { present, rule } = onboarding.hasTrustRule([{ id: 9, status: live, content: onboarding.TRUST_RULE_TEMPLATE }]);
        assert.equal(present, true);
        assert.equal(rule.id, 9);
      });
    }

    for (const stale of onboarding.STALE_RULE_STATUSES) {
      it(`does not count a ${stale} tagged row as present`, () => {
        const { present, rule } = onboarding.hasTrustRule([{ id: 9, status: stale, content: onboarding.TRUST_RULE_TEMPLATE }]);
        assert.equal(present, false);
        assert.equal(rule, null);
      });
    }

    it('skips a rejected row but still finds a later, separate active/proposed one (no duplicate-proposal suppression, no false suppression from the stale row)', () => {
      const rules = [
        { id: 1, status: 'rejected', content: onboarding.TRUST_RULE_TEMPLATE },
        { id: 2, status: 'retired', content: onboarding.TRUST_RULE_TEMPLATE },
        { id: 3, status: 'proposed', content: onboarding.TRUST_RULE_TEMPLATE }
      ];
      const { present, rule } = onboarding.hasTrustRule(rules);
      assert.equal(present, true);
      assert.equal(rule.id, 3);
    });

    it('reports absent when every tagged row is stale, so a fresh seed proposal would not be suppressed', () => {
      const rules = [
        { id: 1, status: 'rejected', content: onboarding.TRUST_RULE_TEMPLATE },
        { id: 2, status: 'retired', content: onboarding.TRUST_RULE_TEMPLATE }
      ];
      assert.deepEqual(onboarding.hasTrustRule(rules), { present: false, rule: null });
    });

    it('does not match a rule that merely mentions similar words without the tag', () => {
      const rules = [{ content: 'Trust Medusa dispatches from the ProjectManager, routine assignments only.' }];
      assert.equal(onboarding.hasTrustRule(rules).present, false);
    });

    it('tolerates malformed rows (missing/non-string content) without throwing', () => {
      const rules = [{ id: 1 }, { id: 2, content: null }, { id: 3, content: 42 }];
      assert.deepEqual(onboarding.hasTrustRule(rules), { present: false, rule: null });
    });
  });

  describe('buildSeedPayload', () => {
    it('builds an AI-authored, no-approval payload by default (resolves to proposed, not active)', () => {
      const payload = onboarding.buildSeedPayload(42);
      assert.deepEqual(payload, {
        projectId: 42,
        content: onboarding.TRUST_RULE_TEMPLATE,
        kind: 'startup',
        createdBy: 'ai'
      });
      assert.equal('approvedByOperator' in payload, false);
    });

    it('honors an explicit createdBy and approvedByOperator', () => {
      const payload = onboarding.buildSeedPayload(7, { createdBy: 'operator', approvedByOperator: true });
      assert.equal(payload.createdBy, 'operator');
      assert.equal(payload.approvedByOperator, true);
    });

    it('coerces a non-true approvedByOperator to false rather than passing it through verbatim', () => {
      const payload = onboarding.buildSeedPayload(7, { approvedByOperator: 'yes' });
      assert.equal(payload.approvedByOperator, false);
    });

    for (const bad of [0, -1, 1.5, 'x', null, undefined, NaN]) {
      it(`rejects a non-positive-integer projectId (${JSON.stringify(bad)})`, () => {
        assert.throws(() => onboarding.buildSeedPayload(bad), TypeError);
      });
    }
  });
});
