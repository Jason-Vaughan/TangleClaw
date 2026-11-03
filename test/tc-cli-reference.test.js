'use strict';

/*
 * #2299 — `docs/tc-cli-reference.md` keeps up with the `tc` roster.
 *
 * The page is prose a person edits; the roster is what `tc --help` prints from
 * `lib/tc-verbs.js#VERB_ROSTER`. Nothing else fails when a verb is added and
 * the page is not touched, so this reads the verbs from the help of the head
 * under test and asks the page for a table row for each one.
 *
 * `tc --help` answers before it reads any environment, so it runs here with an
 * empty one: no API, no launch identity, no pane, and nothing to stub.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { VERB_ROSTER } = require('../lib/tc-verbs');
const { IMPLEMENTATION_SUBVERBS } = require('../lib/operating-primer');

const ROOT = path.join(__dirname, '..');
const TC_BIN = path.join(ROOT, 'bin', 'tc');
const PAGE = fs.readFileSync(path.join(ROOT, 'docs', 'tc-cli-reference.md'), 'utf8');

/**
 * The top-level verbs `tc --help` lists, in its order. Each usage line in the
 * help is indented two spaces and starts with `tc <verb>`; its summary line is
 * indented further and is not read.
 * @returns {string[]}
 */
function helpVerbs() {
  const r = spawnSync(process.execPath, [TC_BIN, '--help'], { env: {}, encoding: 'utf8' });
  assert.equal(r.status, 0, `tc --help exited ${r.status}: ${r.stderr}`);
  const verbs = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^ {2}tc ([a-z][a-z-]*)\b/.exec(line);
    if (m && !verbs.includes(m[1])) verbs.push(m[1]);
  }
  return verbs;
}

/**
 * The verbs the page gives a table row of their own: a row whose first cell
 * starts with a backticked `tc <verb>` command.
 * @param {string} page - The page's markdown
 * @returns {Set<string>}
 */
function pageRowVerbs(page) {
  const verbs = new Set();
  for (const m of page.matchAll(/^\| `tc ([a-z][a-z-]*)[ `]/gm)) verbs.add(m[1]);
  return verbs;
}

describe('docs/tc-cli-reference.md names every verb tc --help lists (#2299)', () => {
  const verbs = helpVerbs();
  const onPage = pageRowVerbs(PAGE);

  it('reads every verb from the help, so a parse that misses some cannot pass', () => {
    assert.deepEqual(verbs, VERB_ROSTER.map((v) => v.id));
  });

  for (const verb of verbs) {
    it(`has a table row for tc ${verb}`, () => {
      assert.ok(onPage.has(verb), `docs/tc-cli-reference.md has no table row starting \`tc ${verb}\`; describe the verb there`);
    });
  }

  it('gives no row to a verb tc does not have', () => {
    const unknown = [...onPage].filter((v) => !verbs.includes(v));
    assert.deepEqual(unknown, [], `rows for verbs tc --help does not list: ${unknown.join(', ')}`);
  });

  it('finds no row for a verb the page does not mention, so the check is not vacuous', () => {
    const without = PAGE.replace(/^\| `tc learnings`.*\n/gm, '');
    assert.equal(pageRowVerbs(without).has('learnings'), false);
  });
});

/**
 * Whether the page gives one specific subverb its own table row: a row
 * whose command cell starts with the exact `tc <verb> <subverbId>` prefix
 * (a space or closing backtick immediately after, so `tc bridge nickname`
 * does not satisfy `tc bridge nickname set`'s own, more specific check).
 * @param {string} page
 * @param {string} verb
 * @param {string} subverbId - May itself contain a space (e.g. `nickname set`).
 * @returns {boolean}
 */
function pageHasSubverbRow(page, verb, subverbId) {
  const escaped = `tc ${verb} ${subverbId}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\| \`${escaped}[ \`]`, 'm').test(page);
}

describe('docs/tc-cli-reference.md names every IMPLEMENTED subverb too, not just the top-level verb (Architect Ruling A2070, PRR-B I-Gate Round 4 on PR #2841)', () => {
  // The top-level check above passed while the page had no row at all for
  // `tc message retract` or `tc candidate status`, because it only ever
  // asked "does this VERB have a row" -- never "does this SUBVERB". Checked
  // against lib/tc-verbs.js's own `*_SUBVERBS` ground truth (the same
  // source lib/operating-primer.js#subverbManifestParity checks
  // SUBVERB_MANIFEST against), not the manifest, so a manifest that already
  // agrees with itself cannot mask a gap in the page.
  for (const [verb, subverbIds] of Object.entries(IMPLEMENTATION_SUBVERBS)) {
    for (const subverbId of subverbIds) {
      it(`has a table row for tc ${verb} ${subverbId}`, () => {
        assert.ok(pageHasSubverbRow(PAGE, verb, subverbId),
          `docs/tc-cli-reference.md has no row starting \`tc ${verb} ${subverbId}\`; describe the subverb there`);
      });
    }
  }
});
