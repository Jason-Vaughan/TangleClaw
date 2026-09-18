'use strict';

/**
 * `tc`'s require graph stays store-free (Train 21).
 *
 * `lib/tc-verbs.js` is loaded by every `tc` invocation. If anything it requires
 * reaches `lib/store.js`, node's `node:sqlite` ExperimentalWarning is printed on
 * every single `tc` call — a line the operator sees and nothing explains.
 *
 * That invariant used to be held by header prose in `lib/launch-page.js` alone,
 * and #1587 leaned on it harder by having that module require
 * `lib/launch-preflight.js` for the verdict vocabulary. Prose does not fail a
 * build, so this asserts the property directly: load `tc-verbs` in a FRESH
 * process and check what ended up in the module cache.
 *
 * The cache is what is checked, and not stderr, because a `require` of the
 * store prints nothing by itself — the warning fires when a database is opened.
 * A stderr assertion here would pass while the invariant was broken, which is
 * worse than no assertion: it would read as a guard.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

describe('the tc require graph (Train 21)', () => {
  it('loads lib/tc-verbs.js without pulling in the store or node:sqlite', () => {
    // A fresh process, because this test file's own requires have already
    // loaded the store — asking `require.cache` in-process would answer about
    // the test run rather than about `tc`.
    const probe = `
      require(${JSON.stringify(path.join(REPO, 'lib', 'tc-verbs.js'))});
      console.log(JSON.stringify({
        store: Object.keys(require.cache).some((f) => f === ${JSON.stringify(path.join(REPO, 'lib', 'store.js'))})
      }));
    `;
    const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
    const seen = JSON.parse(out.trim().split('\n').pop());
    assert.equal(seen.store, false,
      'lib/tc-verbs.js reached lib/store.js — every `tc` call now prints node:sqlite\'s ExperimentalWarning');
  });

});
