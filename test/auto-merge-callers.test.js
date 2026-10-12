'use strict';

// #2320: every place that can arm GitHub auto-merge is known, and each asks
// `lib/merge-authority.js` first. Arming auto-merge is a merge decision taken
// ahead of time, so a new caller that does not ask would let incidental
// automation land a pull request in a project whose merges are someone else's
// to decide.
//
// This reads source text, which proves two things only: no file outside the
// list holds an arming command, and each listed file holds the question. That
// the question is asked BEFORE the arming call, and obeyed, is proved by
// behaviour in `test/wrap-step-commit-autopr.test.js` and
// `test/wrap-step-pr-merge.test.js`.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Everything a process of this product runs: the server, its libraries and its commands. */
const SCANNED = ['server.js', 'lib', 'bin', 'scripts', 'hooks'];

/**
 * The files that may arm auto-merge. Adding one here is a decision, not a
 * chore: the new caller must ask `mergeAuthority.forProject` and arm only when
 * `mayArmAutoMerge` says so, with a test that drives a project naming a
 * coordinator through it and sees nothing armed.
 */
const KNOWN_CALLERS = ['lib/wrap-steps/commit.js', 'lib/wrap-steps/pr-merge.js'];

/**
 * How auto-merge is armed: the `gh pr merge` flag, GitHub's GraphQL mutation
 * and its REST field. `--auto` is matched as a whole flag, so `--auto-approve`
 * and the like are not it.
 */
const ARMING = /--auto(?![\w-])|enablePullRequestAutoMerge|\bauto_merge\b/;

/**
 * Every file under a path, as paths relative to the repository root.
 * @param {string} relative - A file or directory, relative to the root
 * @returns {string[]}
 */
function filesUnder(relative) {
  const absolute = path.join(ROOT, relative);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules')
    .flatMap((entry) => {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) return filesUnder(child);
      return entry.isFile() ? [child] : [];
    });
}

/**
 * The lines of a text that hold an arming command.
 * @param {string} text - A file's content
 * @returns {Array<{line: number, text: string}>}
 */
function armingLines(text) {
  return text.split('\n')
    .map((lineText, index) => ({ line: index + 1, text: lineText.trim() }))
    .filter((entry) => ARMING.test(entry.text));
}

describe('auto-merge callers: every one is known and asks who merges (#2320)', () => {
  const files = SCANNED.flatMap(filesUnder).map((file) => file.split(path.sep).join('/'));

  it('scans the server, its libraries, its commands, its scripts and its hooks', () => {
    for (const relative of SCANNED) {
      assert.ok(files.some((file) => file === relative || file.startsWith(`${relative}/`)), `${relative} was not scanned`);
    }
    for (const caller of KNOWN_CALLERS) assert.ok(files.includes(caller), `${caller} is not among the scanned files`);
  });

  it('recognises each way of arming, and nothing that only resembles one', () => {
    for (const arming of [
      'gh pr merge 12 --auto --squash --delete-branch',
      '\'pr\', \'merge\', target, \'--auto\', \'--squash\'',
      'gh pr merge 12 --squash --auto',
      'mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }',
      'body: JSON.stringify({ auto_merge: true })'
    ]) {
      assert.equal(armingLines(arming).length, 1, arming);
    }
    for (const harmless of ['git gc --auto-detach', 'terraform apply --auto-approve', 'const autoMergeArmed = false;', 'an autoMergeRequest field']) {
      assert.equal(armingLines(harmless).length, 0, harmless);
    }
  });

  it('no file but the known callers holds an arming command', () => {
    const strays = files
      .filter((file) => !KNOWN_CALLERS.includes(file))
      .flatMap((file) => armingLines(fs.readFileSync(path.join(ROOT, file), 'utf8')).map((hit) => `${file}:${hit.line}: ${hit.text}`));
    assert.deepEqual(strays, [],
      'a file that is not a known auto-merge caller holds an arming command. If it really arms auto-merge, it must ask '
      + 'lib/merge-authority.js first and be added to KNOWN_CALLERS in this test, with a test of its own that shows a project '
      + 'naming a coordinator arms nothing.');
  });

  it('each known caller still arms, and asks merge-authority whether it may', () => {
    for (const caller of KNOWN_CALLERS) {
      const text = fs.readFileSync(path.join(ROOT, caller), 'utf8');
      assert.ok(armingLines(text).length > 0, `${caller} no longer arms auto-merge: take it off KNOWN_CALLERS`);
      assert.match(text, /require\('\.\.\/merge-authority'\)/, `${caller} does not load lib/merge-authority.js`);
      assert.match(text, /mergeAuthority\.forProject\(|authority\.forProject\(/, `${caller} does not ask who merges for the project`);
      assert.match(text, /mayArmAutoMerge\(/, `${caller} does not ask whether it may arm auto-merge`);
    }
  });
});
