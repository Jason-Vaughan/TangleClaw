'use strict';

/*
 * #796 — detecting disagreement between rule sources in general means
 * comparing prose, which is unbounded and unreliable. What IS checkable is
 * the boundary ADR 0011 draws: methodology belongs to the plugin, and
 * TangleClaw's global rules must not legislate on it. The topic list lives in
 * lib/methodology-topics.js and is the same list the prime tells sessions
 * the plugin owns, so the guard enforces exactly what the prime claims.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RULES = fs.readFileSync(path.join(__dirname, '..', 'data', 'global-rules.md'), 'utf8');

const { METHODOLOGY_OWNED_TOPICS } = require('../lib/methodology-topics');

describe('#796 the global rules do not legislate in the methodology layer\'s domain', () => {
  for (const { topic, tells } of METHODOLOGY_OWNED_TOPICS) {
    it(`does not prescribe ${topic}`, () => {
      for (const tell of tells) {
        const hit = tell.exec(RULES);
        assert.equal(hit, null,
          `data/global-rules.md prescribes ${topic} ("${hit && hit[0]}") — that is the plugin methodology's to set (the ADR 0011 seam, enumerated in lib/methodology-topics.js); two authorities on one topic is how #796 happened`);
      }
    });
  }

  it('still pairs gh pr create with auto-merge — the part TangleClaw does own', () => {
    // The reconciliation removed the strategy flag, not the rule.
    assert.match(RULES, /gh pr merge --auto --delete-branch/);
    assert.match(RULES, /methodology layer's call/, 'and says out loud whose call the strategy is');
  });
});
