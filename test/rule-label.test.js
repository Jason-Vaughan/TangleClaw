'use strict';

// Rule labels (#2029): every surface names a rule by "Rule #<id>" taken from
// its database id, never from whatever number its author typed into it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { ruleLabel, displayRuleText, stripSameIdPrefix, authoredIdMismatch } = require('../lib/rule-label');

describe('rule labels (#2029)', () => {
  describe('ruleLabel', () => {
    it('renders the database id', () => {
      assert.equal(ruleLabel(117), 'Rule #117');
      assert.equal(ruleLabel(1), 'Rule #1');
    });

    it('accepts an id that arrived as a numeric string (a route param)', () => {
      assert.equal(ruleLabel('42'), 'Rule #42');
    });

    it('refuses to label a rule it cannot identify, so nothing renders unlabelled', () => {
      for (const bad of [undefined, null, '', 0, -3, 1.5, 'abc', NaN, '12abc']) {
        assert.throws(() => ruleLabel(bad), TypeError, `ruleLabel(${String(bad)}) should throw`);
      }
    });
  });

  describe('displayRuleText', () => {
    it('prefixes the content with the label', () => {
      assert.equal(displayRuleText({ id: 7, content: 'Keep plans local.' }), 'Rule #7 — Keep plans local.');
    });

    it('labels from the id even when the content carries no number at all', () => {
      assert.equal(displayRuleText({ id: 94, content: 'RM-LEASE TC-RM02 generation 1' }),
        'Rule #94 — RM-LEASE TC-RM02 generation 1');
    });

    it('drops an authored prefix naming the SAME id, so the label is not doubled', () => {
      assert.equal(displayRuleText({ id: 120, content: 'RULE #120 — RM-LEASE TC-RM02 generation 2\nmodule: TC-RM02' }),
        'Rule #120 — RM-LEASE TC-RM02 generation 2\nmodule: TC-RM02');
    });

    it('treats the same-id prefix case- and dash-insensitively', () => {
      for (const content of ['rule #5 - body', 'Rule #5 – body', 'RULE#5 — body', '  RULE #5—body']) {
        assert.equal(displayRuleText({ id: 5, content }), 'Rule #5 — body', content);
      }
    });

    it('keeps an authored prefix naming a DIFFERENT id visible, so the mismatch shows', () => {
      assert.equal(displayRuleText({ id: 117, content: 'RULE #94 — something' }),
        'Rule #117 — RULE #94 — something');
    });

    it('does not mistake a longer id for the same one', () => {
      assert.equal(displayRuleText({ id: 12, content: 'RULE #120 — body' }), 'Rule #12 — RULE #120 — body');
    });

    it('trims surrounding whitespace from the content', () => {
      assert.equal(displayRuleText({ id: 3, content: '\n  body  \n' }), 'Rule #3 — body');
    });

    it('still labels a rule whose content is empty', () => {
      assert.equal(displayRuleText({ id: 3, content: '' }), 'Rule #3');
      assert.equal(displayRuleText({ id: 3, content: 'RULE #3 — ' }), 'Rule #3');
    });

    it('refuses a rule with no usable id', () => {
      assert.throws(() => displayRuleText({ content: 'x' }), TypeError);
      assert.throws(() => displayRuleText(null), TypeError);
    });
  });

  describe('exactly one prefix', () => {
    it('elides only the first of two same-id prefixes', () => {
      assert.equal(displayRuleText({ id: 5, content: 'RULE #5 — RULE #5 — body' }), 'Rule #5 — RULE #5 — body');
    });
  });

  describe('authoredIdMismatch', () => {
    it('names the number a rule\'s text claims when it is not the rule\'s own', () => {
      assert.equal(authoredIdMismatch({ id: 117, content: 'RULE #94 — look-alike' }), 94);
    });

    it('is null for a same-id prefix, no prefix, or a number mentioned later', () => {
      assert.equal(authoredIdMismatch({ id: 120, content: 'RULE #120 — ok' }), null);
      assert.equal(authoredIdMismatch({ id: 120, content: 'plain' }), null);
      assert.equal(authoredIdMismatch({ id: 120, content: 'supersedes: RULE #97' }), null);
      assert.equal(authoredIdMismatch({ id: 120, content: '' }), null);
    });

    it('refuses a rule with no usable id', () => {
      assert.throws(() => authoredIdMismatch({ id: 0, content: 'RULE #1 — x' }), TypeError);
    });
  });

  describe('stripSameIdPrefix', () => {
    it('never alters content that does not start with the same id', () => {
      assert.equal(stripSameIdPrefix(9, 'Mentions RULE #9 — later'), 'Mentions RULE #9 — later');
    });
  });
});
