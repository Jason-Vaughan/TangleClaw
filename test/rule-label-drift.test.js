'use strict';

// Drift guard (#2029): the browser has no bundler, so the rule-label rule is
// written twice — lib/rule-label.js for the server and CLI, api-helper.js for
// the pages. Both run here on the same inputs and must agree exactly,
// including on which inputs they refuse.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const server = require('../lib/rule-label');
const browser = require('./_api-helper-globals')();

const IDS = [1, 7, 120, '42', ' 9 ', 0, -1, 1.5, '', 'abc', '12abc', null, undefined, NaN];
const CONTENTS = [
  'plain text',
  '',
  '   ',
  'RULE #120 — RM-LEASE gen 2',
  'rule #120 - lower case and hyphen',
  'Rule #120 – en dash',
  'RULE#120—no spaces',
  'RULE #94 — another rule’s number',
  'RULE #1200 — a longer id',
  '\n  RULE #7 — leading whitespace\nsecond line',
  'Mentions RULE #7 — not at the start',
  undefined
];

/**
 * Call fn and capture either its value or the class of what it threw.
 * @param {Function} fn - The call
 * @returns {{value?: string, threw?: string}}
 */
function outcome(fn) {
  try {
    return { value: fn() };
  } catch (err) {
    return { threw: err.constructor.name };
  }
}

describe('rule label drift guard — server and browser agree (#2029)', () => {
  it('ruleLabel', () => {
    for (const id of IDS) {
      assert.deepEqual(outcome(() => browser.tcRuleLabel(id)), outcome(() => server.ruleLabel(id)), `id ${String(id)}`);
    }
  });

  it('stripSameIdPrefix', () => {
    for (const id of IDS) {
      for (const content of CONTENTS) {
        assert.deepEqual(
          outcome(() => browser.tcStripSameIdPrefix(id, content)),
          outcome(() => server.stripSameIdPrefix(id, content)),
          `id ${String(id)} / ${JSON.stringify(content)}`
        );
      }
    }
  });

  it('displayRuleText', () => {
    for (const id of IDS) {
      for (const content of CONTENTS) {
        assert.deepEqual(
          outcome(() => browser.tcDisplayRuleText({ id, content })),
          outcome(() => server.displayRuleText({ id, content })),
          `id ${String(id)} / ${JSON.stringify(content)}`
        );
      }
    }
    assert.deepEqual(outcome(() => browser.tcDisplayRuleText(null)), outcome(() => server.displayRuleText(null)));
  });

  it('authoredIdMismatch', () => {
    for (const id of IDS) {
      for (const content of CONTENTS) {
        assert.deepEqual(
          outcome(() => browser.tcAuthoredIdMismatch({ id, content })),
          outcome(() => server.authoredIdMismatch({ id, content })),
          `id ${String(id)} / ${JSON.stringify(content)}`
        );
      }
    }
  });
});
