'use strict';

/**
 * The cache-bump guard (#625).
 *
 * `scripts/cache-bump-guard.js` asserts a property of a DIFF — if a cache-first
 * `public/*` asset changed, `CACHE_NAME` must have changed too — which is why it
 * is a CI step rather than one of these tests. What these tests owe is the thing
 * the floor assertions it replaces never had: a demonstration that it goes RED.
 * Every arm is driven in both directions, and the end-to-end pair runs the real
 * CLI over a real git repository so the git plumbing is covered too, not just
 * the predicate.
 *
 * The fixtures are built from the REAL `public/sw.js` wherever the shape is what
 * is under test — a hand-written miniature would pass a parser that the annotated
 * production file defeats, which is exactly how the first draft of the roster
 * parser broke.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const guard = require('../scripts/cache-bump-guard.js');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'cache-bump-guard.js');
const REAL_SW = fs.readFileSync(path.join(REPO_ROOT, 'public', 'sw.js'), 'utf8');

/**
 * Rewrite the `CACHE_NAME` generation in a `sw.js` source.
 *
 * @param {string} src - A `sw.js` source.
 * @param {number|string} generation - The new suffix.
 * @returns {string} The source with its generation replaced.
 */
function withGeneration(src, generation) {
  return src.replace(/const CACHE_NAME = '[^']*';/, `const CACHE_NAME = 'tangleclaw-v3-${generation}';`);
}

describe('cache-bump-guard: reading the roster out of the real sw.js', () => {
  it('parses the production CACHE_NAME and its generation', () => {
    const state = guard.parseSwState(REAL_SW);
    assert.match(state.cacheName, /^tangleclaw-v3-\d+$/,
      'the CI guard parses this form to tell a bump from a regression');
    assert.ok(Number.isInteger(state.generation) && state.generation > 0);
  });

  it('reads NETWORK_FIRST_PATHS without being fooled by apostrophes in its comments', () => {
    // The list is annotated with possessives ("sw.js's", "worker's"). A parser
    // that picks quoted runs out of the raw source reads those apostrophes as
    // delimiters: it drops real entries and invents fragments of prose as paths.
    assert.ok(REAL_SW.includes("sw.js's") || /\w's/.test(REAL_SW),
      'this test is only meaningful while the source still contains an apostrophe');
    const { networkFirst } = guard.parseSwState(REAL_SW);
    for (const entry of networkFirst) {
      assert.match(entry, /^\/[\w./-]+$/, `parsed a non-path entry: ${JSON.stringify(entry)}`);
    }
    assert.ok(networkFirst.has('/ui.js'), '/ui.js is network-first in production');
    assert.ok(networkFirst.has('/session.js'), '/session.js is network-first in production');
    assert.ok(!networkFirst.has('/history-drawer.js'),
      '/history-drawer.js is cache-first in production — the guard exists for files like it');
  });

  it('a raw-source parse really would be wrong, so stripping comments is load-bearing', () => {
    const stripped = guard.stripComments(REAL_SW);
    assert.ok(stripped.length < REAL_SW.length, 'the production file is annotated');
    const naive = new Set(
      [...guard.bracketedLiteral(REAL_SW, 'const NETWORK_FIRST_PATHS').matchAll(/'([^']*)'/g)]
        .map((m) => m[1])
    );
    const correct = guard.parseSwState(REAL_SW).networkFirst;
    assert.notDeepStrictEqual(naive, correct,
      'if these ever agree, the apostrophe hazard is gone and this test can go');
  });
});

describe('cache-bump-guard: which paths the bump gates', () => {
  const netFirst = new Set(['/ui.js', '/session.js']);

  it('gates a cache-first asset that is precached', () => {
    assert.equal(guard.isCacheFirstAsset('public/history-drawer.js', netFirst), true);
  });

  it('gates a cache-first asset that is NOT precached', () => {
    // logo.png and icons/* are absent from STATIC_ASSETS, so `install`'s
    // addAll never refreshes them. They enter the cache through _cachePut on
    // first fetch and nothing but a generation change evicts them — the files
    // for which the bump is the ONLY remedy, and the ones a STATIC_ASSETS-keyed
    // roster would have missed entirely.
    assert.equal(guard.isCacheFirstAsset('public/logo.png', netFirst), true);
    assert.equal(guard.isCacheFirstAsset('public/icons/apple-touch-icon.png', netFirst), true);
  });

  it('does not gate a network-first path', () => {
    assert.equal(guard.isCacheFirstAsset('public/ui.js', netFirst), false);
  });

  it('does not gate HTML, which is fetched as a navigation', () => {
    assert.equal(guard.isCacheFirstAsset('public/index.html', netFirst), false);
    assert.equal(guard.isCacheFirstAsset('public/session.html', netFirst), false);
  });

  it('does not gate sw.js itself or anything outside public/', () => {
    assert.equal(guard.isCacheFirstAsset('public/sw.js', netFirst), false);
    assert.equal(guard.isCacheFirstAsset('lib/store.js', netFirst), false);
    assert.equal(guard.isCacheFirstAsset('public-notes/readme.md', netFirst), false);
  });
});

describe('cache-bump-guard: arm 1 — the missed bump', () => {
  const base = REAL_SW;

  it('FAILS when a cache-first asset changed and CACHE_NAME did not', () => {
    const verdict = guard.evaluate({
      baseSw: base,
      headSw: base,
      changedPaths: ['public/history-drawer.js', 'lib/store.js']
    });
    assert.equal(verdict.ok, false);
    assert.deepStrictEqual(verdict.offenders, ['public/history-drawer.js']);
    assert.match(verdict.message, /public\/history-drawer\.js/,
      'the failure must name the offending asset, not just report a violation');
    assert.doesNotMatch(verdict.message, /lib\/store\.js/,
      'a file the worker never serves is not an offender');
  });

  it('PASSES when the same change bumps CACHE_NAME', () => {
    const state = guard.parseSwState(base);
    const verdict = guard.evaluate({
      baseSw: base,
      headSw: withGeneration(base, state.generation + 1),
      changedPaths: ['public/history-drawer.js', 'public/sw.js']
    });
    assert.equal(verdict.ok, true, verdict.message);
  });

  it('PASSES when only a network-first-only file changed', () => {
    // A guard that demanded a bump for every public/* change would fire on
    // files the bump does not gate, and a guard that cries wolf gets bypassed.
    const verdict = guard.evaluate({
      baseSw: base,
      headSw: base,
      changedPaths: ['public/session.js', 'public/update-beacon.js', 'public/index.html']
    });
    assert.equal(verdict.ok, true, verdict.message);
  });

  it('names every offender, not the first one', () => {
    const verdict = guard.evaluate({
      baseSw: base,
      headSw: base,
      changedPaths: ['public/manifest.json', 'public/history-drawer.js', 'public/logo.png']
    });
    assert.deepStrictEqual(verdict.offenders,
      ['public/history-drawer.js', 'public/logo.png', 'public/manifest.json']);
  });
});

describe('cache-bump-guard: arm 2 — the guard defends its own shape', () => {
  it('FAILS when CACHE_NAME goes backwards', () => {
    // This is what the deleted `>= 12` / `>= 49` / `>= 54` floors were reaching
    // for. Monotonicity subsumes all of them: a generation that never decreases
    // can never fall below one.
    const state = guard.parseSwState(REAL_SW);
    const verdict = guard.evaluate({
      baseSw: REAL_SW,
      headSw: withGeneration(REAL_SW, state.generation - 1),
      changedPaths: ['public/sw.js']
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /backwards/);
  });

  it('FAILS when CACHE_NAME abandons the tangleclaw-v3-N form', () => {
    const headSw = REAL_SW.replace(/const CACHE_NAME = '[^']*';/, "const CACHE_NAME = 'tc-2026-09-07';");
    const verdict = guard.evaluate({ baseSw: REAL_SW, headSw, changedPaths: ['public/sw.js'] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /tangleclaw-v3-N form/,
      'the form is what the guard parses — losing it would disarm arm 1 silently');
  });

  it('FAILS when NETWORK_FIRST_PATHS disappears', () => {
    const headSw = REAL_SW.replace('const NETWORK_FIRST_PATHS', 'const RENAMED_PATHS');
    const verdict = guard.evaluate({ baseSw: REAL_SW, headSw, changedPaths: ['public/sw.js'] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /NETWORK_FIRST_PATHS/);
  });

  it('PASSES a legitimate bump of any size', () => {
    const state = guard.parseSwState(REAL_SW);
    const verdict = guard.evaluate({
      baseSw: REAL_SW,
      headSw: withGeneration(REAL_SW, state.generation + 7),
      changedPaths: ['public/sw.js', 'public/history-drawer.js']
    });
    assert.equal(verdict.ok, true, verdict.message);
  });
});

describe('cache-bump-guard: the CLI over a real git repository', () => {
  /**
   * Build a throwaway repository with the production `sw.js` on `main`, then a
   * branch carrying one edit.
   *
   * @param {(dir: string) => void} edit - Mutates the working tree for the branch commit.
   * @returns {{dir: string, cleanup: () => void}}
   */
  function makeRepo(edit) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-bump-guard-'));
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'guard@test.invalid');
    run('config', 'user.name', 'guard');
    // A contributor with `commit.gpgsign` on globally would otherwise fail
    // every commit here on a key this throwaway repo has no business holding.
    run('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public', 'sw.js'), REAL_SW);
    fs.writeFileSync(path.join(dir, 'public', 'history-drawer.js'), 'const drawer = 1;\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'base');
    run('checkout', '-q', '-b', 'topic');
    edit(dir);
    run('add', '-A');
    // --allow-empty so the two cases that exercise the git plumbing rather than
    // the predicate (no base, unresolvable base) need not invent a file change.
    run('commit', '-q', '--allow-empty', '-m', 'topic');
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  /**
   * Run the CLI and capture its verdict.
   *
   * @param {string} dir - Repository path.
   * @param {string[]} args - Extra arguments.
   * @returns {{status: number, out: string}}
   */
  function runGuard(dir, args) {
    const res = require('node:child_process').spawnSync(
      process.execPath, [SCRIPT, '--repo', dir, ...args], { encoding: 'utf8' }
    );
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
  }

  it('exits 1 and names the asset when the branch forgot the bump', () => {
    const repo = makeRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'public', 'history-drawer.js'), 'const drawer = 2;\n');
    });
    try {
      const { status, out } = runGuard(repo.dir, ['--base', 'main', '--head', 'topic']);
      assert.equal(status, 1, out);
      assert.match(out, /public\/history-drawer\.js/);
    } finally {
      repo.cleanup();
    }
  });

  it('exits 0 when the same branch bumps CACHE_NAME', () => {
    const generation = guard.parseSwState(REAL_SW).generation;
    const repo = makeRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'public', 'history-drawer.js'), 'const drawer = 2;\n');
      fs.writeFileSync(path.join(dir, 'public', 'sw.js'), withGeneration(REAL_SW, generation + 1));
    });
    try {
      const { status, out } = runGuard(repo.dir, ['--base', 'main', '--head', 'topic']);
      assert.equal(status, 0, out);
    } finally {
      repo.cleanup();
    }
  });

  it('skips loudly, not silently, when there is no comparison base', () => {
    const repo = makeRepo(() => {});
    try {
      const { status, out } = runGuard(repo.dir, []);
      assert.equal(status, 0, out);
      assert.match(out, /skipped/, 'a check that goes quiet is indistinguishable from one that passed');
    } finally {
      repo.cleanup();
    }
  });

  it('exits 1 on an EMPTY --base, rather than reporting a skip', () => {
    // The workflow passes the base through $BASE_SHA. An expression that
    // resolved to nothing must not reach the skip branch: that would report
    // caution while checking nothing, on the one event the guard exists for.
    const repo = makeRepo(() => {});
    try {
      const { status, out } = runGuard(repo.dir, ['--base', '']);
      assert.equal(status, 1, out);
      assert.match(out, /non-empty value/);
      assert.doesNotMatch(out, /skipped/);
    } finally {
      repo.cleanup();
    }
  });

  it('exits 1 when git cannot answer, rather than reporting a pass', () => {
    const repo = makeRepo(() => {});
    try {
      const { status, out } = runGuard(repo.dir, ['--base', 'no-such-ref']);
      assert.equal(status, 1, out);
      assert.match(out, /failed/);
    } finally {
      repo.cleanup();
    }
  });
});

describe('cache-bump-guard: the workflow actually runs it', () => {
  it('the Tests workflow invokes the guard with a base and full history', () => {
    // A guard nothing calls is a file. `merge-base` needs both sides in the
    // clone, which the default shallow checkout does not provide.
    const wf = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
    assert.match(wf, /node scripts\/cache-bump-guard\.js --base/,
      'the workflow must run the guard with a comparison base');
    assert.match(wf, /fetch-depth: 0/,
      'merge-base cannot answer in a depth-1 clone');
  });
});
