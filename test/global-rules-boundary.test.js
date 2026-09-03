'use strict';

/*
 * #796 — two binding rule sources contradicted each other for two months
 * (`data/global-rules.md` prescribed `--squash`; the plugin methodology says
 * merge commits) and nothing detected it. Detecting disagreement in general
 * means comparing prose, which is unbounded and unreliable. What IS checkable
 * is the boundary ADR 0011 draws: methodology topics belong to the plugin,
 * and TangleClaw's global rules must not legislate on them. A pinned overlap
 * list turns an open-ended semantic problem into a checklist that fails at CI
 * time rather than in someone's session two months later.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RULES = fs.readFileSync(path.join(__dirname, '..', 'data', 'global-rules.md'), 'utf8');

/**
 * The topics both layers plausibly speak on, and the tells that mean the
 * global rules are prescribing rather than deferring. Each entry names the
 * topic so a red run says which boundary was crossed.
 */
const METHODOLOGY_OWNED = [
  {
    topic: 'merge strategy',
    tells: [/--squash\b/, /--rebase\b/, /\bsquash[- ]merg/i, /\brebase[- ]merg/i, /gh pr merge[^\n]*--merge\b/]
  },
  {
    topic: 'commit attribution trailers',
    tells: [/Co-Authored-By/i, /Signed-off-by/i, /Generated with \[?Claude/i]
  }
];

describe('#796 the global rules do not legislate in the methodology layer\'s domain', () => {
  for (const { topic, tells } of METHODOLOGY_OWNED) {
    it(`does not prescribe ${topic}`, () => {
      for (const tell of tells) {
        const hit = tell.exec(RULES);
        assert.equal(hit, null,
          `data/global-rules.md prescribes ${topic} ("${hit && hit[0]}") — that is the plugin methodology's to set (ADR 0011); a project's governance decides, and two authorities on one topic is how #796 happened`);
      }
    });
  }

  it('still pairs gh pr create with auto-merge — the part TangleClaw does own', () => {
    // The reconciliation removed the strategy flag, not the rule.
    assert.match(RULES, /gh pr merge --auto --delete-branch/);
    assert.match(RULES, /methodology layer's call/, 'and says out loud whose call the strategy is');
  });
});
