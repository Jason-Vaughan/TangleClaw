'use strict';

/*
 * #183 — the self-update prompt must never hardcode the install path.
 *
 * Source-level structural assertions over public/session.js, same pattern as
 * test/ub-self-update-pill.test.js. The backend contract (repoRoot on the
 * /api/update-status payload) is behaviorally tested in update-checker.test.js;
 * these lock the client side: buildUpdatePrompt derives its `cd` step from
 * data.repoRoot, and no public script regresses to a hardcoded checkout path.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('update prompt install path (#183)', () => {
  let js;

  before(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
  });

  it('buildUpdatePrompt derives the cd step from data.repoRoot', () => {
    assert.match(js, /const repoRoot = data\.repoRoot \|\|/);
    assert.match(js, /`1\. cd \$\{repoRoot\}`/);
  });

  it('degrades honestly when repoRoot is absent — asks the operator, no invented path', () => {
    assert.match(js, /ask the operator for the path/);
  });

  it('no public script hardcodes a checkout path (regression guard)', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    for (const file of fs.readdirSync(publicDir)) {
      if (!file.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(publicDir, file), 'utf8');
      assert.doesNotMatch(
        src,
        /Documents\/Projects\/TangleClaw/,
        `${file} hardcodes an install path`
      );
    }
  });
});
