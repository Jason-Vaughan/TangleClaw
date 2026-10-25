'use strict';

/*
 * Contract tests for FEATURES.md itself (backlog DOC-3K7Q).
 *
 * The index's old convention cited `file.js:line` pointers; nothing
 * re-verified them, and they rotted by hundreds of lines. The replacement
 * convention is greppable anchors — `file.js#symbolName` or literal route
 * strings — which these tests keep honest: no line pointers may re-enter,
 * every cited repo path must exist, and every `path#symbol` anchor must
 * actually grep in its file. The seed template in lib/projects.js must
 * prescribe the same convention so newly-seeded projects don't inherit
 * the rotting format.
 *
 * Also covers `scripts/verify-features-index.js` (#2597): a `Tests:`
 * clause newly added to FEATURES.md by a wave's diff must name a file
 * that same diff touches, so a records PR can't cite pre-existing
 * coverage as proof of the wave's own work.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const verifyFeaturesIndex = require('../scripts/verify-features-index');

const ROOT = path.join(__dirname, '..');
const FEATURES = fs.readFileSync(path.join(ROOT, 'FEATURES.md'), 'utf8');

/** A stdout sink that keeps what was written. */
function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, text: () => text };
}

// Only these first segments are guaranteed present on a fresh clone / CI
// checkout — local-only dirs (.prawduct/, .claude/, .tangleclaw/) are
// deliberately outside the existence contract.
const COMMITTED_ROOTS = new Set([
  'lib', 'public', 'test', 'data', 'deploy', 'scripts', 'docs', '.github'
]);

/**
 * Extract backticked citation tokens that look like committed repo paths,
 * split into `{filePath, symbol}` (symbol null when the token has no `#`).
 * Tokens with globs/placeholders (`*`, `<`, `{`) or non-committed roots
 * are out of contract and skipped.
 * @returns {Array<{token: string, filePath: string, symbol: string|null, rootLevel?: boolean}>}
 */
function citedPaths() {
  const out = [];
  const re = /`([^`\s]+)`/g;
  let m;
  while ((m = re.exec(FEATURES)) !== null) {
    const token = m[1];
    if (/[*<{]/.test(token)) continue;
    const [filePath, symbol = null] = token.split('#');
    if (!filePath.includes('/')) {
      // A root-level file (`server.js#handleUpgrade`) is a citation too, and the
      // busiest one: skipping every slash-less token let a symbol removed from
      // `server.js` stay cited here. Only a `file.ext#symbol` token counts — a
      // bare backticked word (`authEnabled`, `config.json`) is prose, not a
      // path claim, and would drown the contract in false positives.
      //
      // Held to the SYMBOL contract only, not the existence one: a slash-less
      // name cannot say which directory it means (`project.json#…` is a managed
      // project's file, `file.js#symbolName` is the convention's own example),
      // so a root-level name that is not at the repo root is skipped rather
      // than reported. The known cost: a DELETED root file is not caught here.
      if (!symbol || !/^[\w.-]+\.(?:js|json|md|sh|html|css)$/.test(filePath)) continue;
      out.push({ token, filePath, symbol, rootLevel: true });
      continue;
    }
    if (!COMMITTED_ROOTS.has(filePath.split('/')[0])) continue;
    out.push({ token, filePath, symbol });
  }
  return out;
}

describe('FEATURES.md citation contract (DOC-3K7Q)', () => {
  it('contains no :line pointers — they rot', () => {
    const lined = FEATURES.match(/[\w./-]+\.(?:js|jsx|ts|tsx|json|md|html|css|sh|ya?ml):\d+/g);
    assert.deepEqual(lined || [], [], `line pointers found: ${(lined || []).join(', ')}`);
  });

  it('every cited committed-repo path exists on disk', () => {
    const missing = citedPaths()
      .filter(({ rootLevel }) => !rootLevel)
      .filter(({ filePath }) => !fs.existsSync(path.join(ROOT, filePath)))
      .map(({ token }) => token);
    assert.deepEqual(missing, [], `dangling paths: ${missing.join(', ')}`);
  });

  it('every path#symbol anchor greps in its file', () => {
    const broken = [];
    for (const { token, filePath, symbol } of citedPaths()) {
      if (!symbol) continue;
      const target = path.join(ROOT, filePath);
      if (!fs.existsSync(target)) continue; // already reported above
      const source = fs.readFileSync(target, 'utf8');
      const name = symbol.replace(/[[\]()]/g, '');
      if (!source.includes(name)) broken.push(token);
    }
    assert.deepEqual(broken, [], `dangling symbol anchors: ${broken.join(', ')}`);
  });

  it('auto-stub TODO sections fold within 14 days — fresh wrap stubs pass, hoarded ones fail', () => {
    // The features-toc wrap step legitimately appends these sections at
    // wrap; forbidding them outright would turn the required CI check red
    // on every normal wrap commit. Only *stale* sections are the defect.
    const MAX_AGE_DAYS = 14;
    const stale = [];
    const re = /^## TODO \(auto-stubbed (\d{4}-\d{2}-\d{2})\)/gm;
    let m;
    while ((m = re.exec(FEATURES)) !== null) {
      const ageDays = (Date.now() - new Date(`${m[1]}T00:00:00`).getTime()) / 86400000;
      if (ageDays > MAX_AGE_DAYS) stale.push(m[1]);
    }
    assert.deepEqual(stale, [], `auto-stub sections older than ${MAX_AGE_DAYS} days: ${stale.join(', ')}`);
  });

  it('seed template prescribes the symbol convention, not :line pointers', () => {
    const { FEATURE_INDEX_TEMPLATE } = require('../lib/projects');
    assert.match(FEATURE_INDEX_TEMPLATE, /NO :line pointers/);
    assert.ok(!/file\.js:line/.test(FEATURE_INDEX_TEMPLATE), 'template still shows the old file.js:line format');
  });
});

describe('testsCitedOn: parsing a Tests: clause off one added line', () => {
  it('extracts every backtick-quoted path from one clause', () => {
    assert.deepEqual(
      verifyFeaturesIndex.testsCitedOn('Tests: `test/a.test.js`, `test/b.test.js`.'),
      ['test/a.test.js', 'test/b.test.js']
    );
  });

  it('extracts a single-file clause', () => {
    assert.deepEqual(verifyFeaturesIndex.testsCitedOn('Tests: `test/a.test.js`.'), ['test/a.test.js']);
  });

  it('returns nothing for a line with no Tests: clause', () => {
    assert.deepEqual(verifyFeaturesIndex.testsCitedOn('- Some feature line with no anchors.'), []);
  });

  it('does not treat other backticked prose as a Tests: citation', () => {
    assert.deepEqual(verifyFeaturesIndex.testsCitedOn('Some `code.js#fn` reference. Tests: `test/x.test.js`.'), ['test/x.test.js']);
  });
});

describe('newlyCitedTests and touchedFiles: reading the diff through the seam', () => {
  it('collects Tests: anchors only from + lines of FEATURES.md\'s own hunk', () => {
    const diff = [
      'diff --git a/FEATURES.md b/FEATURES.md',
      '--- a/FEATURES.md',
      '+++ b/FEATURES.md',
      '@@ -1,2 +1,3 @@',
      ' - unrelated context line',
      '-- Old entry. Tests: `test/old.test.js`.',
      '+- New entry. Tests: `test/new.test.js`, `test/new2.test.js`.'
    ].join('\n');
    const git = (args) => (args[0] === 'diff' && args.includes('FEATURES.md') ? diff : '');
    assert.deepEqual(verifyFeaturesIndex.newlyCitedTests('origin/main', { git }), ['test/new.test.js', 'test/new2.test.js']);
  });

  it('touchedFiles reads git diff --name-only into a Set', () => {
    const git = (args) => {
      assert.deepEqual(args, ['diff', '--name-only', 'origin/main...HEAD']);
      return 'test/new.test.js\nscripts/thing.js\n';
    };
    assert.deepEqual(verifyFeaturesIndex.touchedFiles('origin/main', { git }), new Set(['test/new.test.js', 'scripts/thing.js']));
  });
});

describe('verify-features-index main: the pass/fail disposition', () => {
  it('passes with nothing to report when no Tests: anchor was newly added', () => {
    const git = (args) => (args[0] === 'diff' && args.includes('FEATURES.md') ? '' : '');
    const out = sink();
    assert.equal(verifyFeaturesIndex.main(['--base', 'origin/main'], { stdout: out, git }), 0);
    assert.match(out.text(), /no Tests: anchors were newly added/);
  });

  it('passes when every newly-cited file is in the diff\'s touched set', () => {
    const featuresDiff = '+- New entry. Tests: `test/new.test.js`.';
    const git = (args) => {
      if (args[0] === 'diff' && args.includes('FEATURES.md')) return featuresDiff;
      if (args[0] === 'diff' && args.includes('--name-only')) return 'FEATURES.md\ntest/new.test.js\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const out = sink();
    assert.equal(verifyFeaturesIndex.main(['--base', 'origin/main'], { stdout: out, git }), 0);
    assert.match(out.text(), /1 newly added Tests: anchor\(s\)/);
  });

  it('refuses when a newly-cited file is not in the diff\'s touched set', () => {
    const featuresDiff = '+- New entry. Tests: `test/uncovered.test.js`.';
    const git = (args) => {
      if (args[0] === 'diff' && args.includes('FEATURES.md')) return featuresDiff;
      if (args[0] === 'diff' && args.includes('--name-only')) return 'FEATURES.md\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const out = sink();
    assert.equal(verifyFeaturesIndex.main(['--base', 'origin/main'], { stdout: out, git }), 1);
    assert.match(out.text(), /REFUSED: Tests: anchor\(s\) newly added to FEATURES\.md cite a file this diff does not touch: test\/uncovered\.test\.js/);
  });

  it('passes --base through to both diffs', () => {
    const calls = [];
    const git = (args) => { calls.push(args); return args.includes('FEATURES.md') ? '' : ''; };
    verifyFeaturesIndex.main(['--base', 'main'], { stdout: sink(), git });
    assert.deepEqual(calls, [['diff', 'main...HEAD', '--', 'FEATURES.md']]);
  });

  it('refuses an unknown or incomplete argument', () => {
    const out = sink();
    assert.equal(verifyFeaturesIndex.main(['--nope'], { stdout: out }), 1);
    assert.match(out.text(), /unknown or incomplete argument: --nope/);
  });

  it('refuses with no default when --base is omitted (PR #2606 review, Finding C2)', () => {
    const out = sink();
    assert.equal(verifyFeaturesIndex.main([], { stdout: out }), 1);
    assert.match(out.text(), /--base is required/);
  });
});

describe('verify-features-index: W<N>-REC must diff against the wave\'s own start, not origin/main at check time (PR #2606 review, Finding C2)', () => {
  it('against the WRONG base (origin/main after the wave\'s PRs already merged), a true records PR is refused', () => {
    // Simulates a W<N>-REC records PR after its wave's own PRs (which added
    // test/a.test.js) already merged into main. The records PR's diff against
    // the NOW-current origin/main shows FEATURES.md changing but not
    // test/a.test.js -- that file merged earlier, through a different PR.
    const featuresDiff = '+- New entry. Tests: `test/a.test.js`.';
    const git = (args) => {
      if (args[0] === 'diff' && args.includes('FEATURES.md')) return featuresDiff;
      if (args[0] === 'diff' && args.includes('--name-only')) return 'FEATURES.md\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const out = sink();
    assert.equal(verifyFeaturesIndex.main(['--base', 'origin/main'], { stdout: out, git }), 1,
      'origin/main at check time is the wrong base for W<N>-REC and must not pass by accident');
  });

  it('against the CORRECT base (the wave\'s own starting commit), the same records PR passes', () => {
    // From the wave's start, the diff is the WHOLE wave: both the FEATURES.md
    // citation the records PR adds and the test file an earlier wave PR added.
    const featuresDiff = '+- New entry. Tests: `test/a.test.js`.';
    const git = (args) => {
      if (args[0] === 'diff' && args.includes('FEATURES.md')) return featuresDiff;
      if (args[0] === 'diff' && args.includes('--name-only')) return 'FEATURES.md\ntest/a.test.js\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const out = sink();
    assert.equal(verifyFeaturesIndex.main(['--base', '<wave-start-sha>'], { stdout: out, git }), 0);
  });
});
