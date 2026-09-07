#!/usr/bin/env node
'use strict';

/**
 * Fail a run when a cache-first `public/*` asset changed without a
 * `CACHE_NAME` bump in `public/sw.js`.
 *
 * The service worker's fetch handler has two branches. Network-first covers
 * `/api/*`, navigations, and every path in `NETWORK_FIRST_PATHS`; those files
 * reach the operator on the next reload with no worker action. Everything else
 * falls to the cache-first branch, which answers from the cache whenever the
 * cache has an entry and never revalidates. The only thing that empties that
 * cache is the `activate` handler, which deletes every key that is not the
 * CURRENT `CACHE_NAME` — so for a cache-first asset, a `CACHE_NAME` bump is the
 * one mechanism that gets a new version to a browser with an active worker.
 * Ship a change to one without a bump and it is invisible: the operator is
 * remote on iOS and * has no hard-reload. It has recurred at #246, #271, #427 and #623 — and each
 * was closed by moving that one file into `NETWORK_FIRST_PATHS`, the other valid
 * remedy, which is why not one of those four is in this guard's scope today.
 * That is the argument FOR the guard rather than against it: the carve-out fixes
 * the file someone already noticed, and this checks the ones nobody has. The
 * gated set is computed from `sw.js` on every run precisely so it keeps covering
 * whatever is cache-first now, including files added after this was written.
 *
 * The property is relational — *if a cache-first asset changed in this diff,
 * `CACHE_NAME` must also have changed* — so no read of a single tree can
 * express it. The unit tests that tried each pinned a floor (`>= 54`) against
 * the bump that shipped with them, which cannot fail for the NEXT miss, and an
 * equality pin would fail every legitimate future bump instead. A diff is the
 * one context that holds "changed relative to what", so the check lives here
 * and runs in CI.
 *
 * Two arms, because the guard has two ways to be wrong:
 *
 *   1. **The miss.** A cache-first asset changed and `CACHE_NAME` did not.
 *   2. **The regression.** `CACHE_NAME` changed but did not increase, or lost
 *      the `tangleclaw-v3-N` form. The form is what this script parses, so a
 *      change to it would disarm arm 1 silently — the guard has to defend the
 *      shape it depends on. Monotonicity also subsumes the floor assertions
 *      the unit tests used to carry: a generation that never decreases can
 *      never fall below one.
 *
 * **The roster comes from `sw.js` itself**, never from a list copied into this
 * file or the workflow. A hand-maintained second roster goes stale exactly when
 * someone adds a precached or network-first file — which is this bug one layer
 * up.
 *
 * **The roster is the fetch handler's cache-first branch, not `STATIC_ASSETS`.**
 * Precaching decides what is in the cache at install time; it does not decide
 * which branch serves a request. `install` re-runs `cache.addAll(STATIC_ASSETS)`
 * on any `sw.js` change, so a precached asset is refreshed even without a bump —
 * and that refresh really reaches the network, because `server.js` sends
 * `Cache-Control: no-cache` on every static asset, leaving the HTTP cache no
 * copy to answer `addAll` with. A cache-first asset that is NOT precached
 * (`logo.png`, `icons/*`) has neither remedy: it is populated by `_cachePut` on
 * first fetch and evicted by nothing but a bump.
 * Keying on `STATIC_ASSETS` would gate the files that need it least and miss
 * every file for which the bump is the only remedy.
 *
 * Reads committed history on both sides, so it answers about what is COMMITTED
 * — an uncommitted edit to a cache-first asset is invisible to it. Right for the
 * CI use (a pull request is commits) and worth knowing locally: commit, then ask.
 *
 * Usage: node scripts/cache-bump-guard.js --base <ref> [--head <ref>] [--repo <path>]
 * Exit 0 when the diff is clean or there is no comparison base (the reason is
 * printed), 1 when an arm fires or git cannot answer.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

/** Where the served assets live, relative to the repository root. */
const PUBLIC_DIR = 'public';

/** The service worker, relative to the repository root. */
const SW_PATH = `${PUBLIC_DIR}/sw.js`;

/**
 * The generation string `sw.js` must keep. `activate` compares cache keys by
 * equality, so any changing string would work for eviction — but this script
 * needs an ORDER to tell a bump from a regression, and `tangleclaw-v3-N` is the
 * form every generation since v3-1 has used.
 */
const CACHE_NAME_PATTERN = /CACHE_NAME\s*=\s*['"](tangleclaw-v3-(\d+))['"]/;

/**
 * A looser match, used only to report a `CACHE_NAME` that abandoned the form.
 *
 * It must differ from `CACHE_NAME_PATTERN` in the VALUE it accepts and nothing
 * else. When the two disagreed on whitespace and quote style as well, a
 * reformatted-but-valid declaration failed the strict parse, passed this one,
 * and produced "CACHE_NAME is 'tangleclaw-v3-63', which is not the
 * tangleclaw-v3-N form" — a message contradicting the value it had just
 * printed, sending a maintainer after a problem that did not exist.
 */
const CACHE_NAME_LOOSE = /CACHE_NAME\s*=\s*['"]([^'"]*)['"]/;

/** How long a git invocation may take before it is treated as unanswered. */
const GIT_TIMEOUT_MS = 60 * 1000;

/**
 * Extensions served as navigations. `event.request.mode === 'navigate'` takes
 * the network-first branch regardless of `NETWORK_FIRST_PATHS`, so an HTML
 * change reaches the operator without a bump.
 */
const NAVIGATION_EXTENSIONS = new Set(['.html']);

/**
 * The fetch-handler condition `NAVIGATION_EXTENSIONS` stands in for.
 *
 * This script derives `CACHE_NAME` and `NETWORK_FIRST_PATHS` from `sw.js`, but
 * three premises about the fetch handler are written here rather than read from
 * there. Two of them — that `/api/*` is network-first and that everything else
 * is cache-first — can only make the guard report MORE, which is safe. The
 * navigate premise is the one that can make it report LESS: if the handler ever
 * stops treating navigations as network-first, the three `.html` files become
 * cache-first and this script would keep exempting them forever with nothing
 * going red. So the premise is checked rather than assumed, in the same shape as
 * the `NETWORK_FIRST_PATHS` arm.
 */
const NAVIGATION_CONDITION = /event\.request\.mode === 'navigate'/;

/**
 * Strip comments so a prose apostrophe cannot be read as a string delimiter.
 *
 * Not cosmetic: `sw.js`'s asset lists are heavily annotated, and its comments
 * contain possessives (`sw.js's`, `worker's`). Picking `'...'` runs out of the
 * raw source silently swallows real entries between two apostrophes and invents
 * others out of comment fragments — a roster that is wrong in both directions
 * while looking plausible.
 *
 * @param {string} src - JavaScript source.
 * @returns {string} The source with block comments and whole-line `//`
 *   comments removed. Trailing `//` comments are left alone; the lists this
 *   parses put every comment on its own line, and removing them by pattern
 *   would corrupt any string containing `//`.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/**
 * Extract the bracketed literal that follows a declaration.
 *
 * @param {string} src - Comment-stripped source.
 * @param {string} decl - The declaration text to find (e.g. `const STATIC_ASSETS`).
 * @returns {string|null} The text between the opening `[` and its matching `]`,
 *   or null when the declaration is absent.
 */
function bracketedLiteral(src, decl) {
  const declAt = src.indexOf(decl);
  if (declAt === -1) return null;
  const open = src.indexOf('[', declAt);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Read the state this guard reasons about out of a `sw.js` source.
 *
 * @param {string} src - The contents of `public/sw.js`.
 * @returns {{cacheName: string|null, generation: number|null, networkFirst: Set<string>|null}}
 *   `cacheName` is the literal as written (null when no declaration is found at
 *   all); `generation` is its numeric suffix, null when the string abandoned the
 *   `tangleclaw-v3-N` form; `networkFirst` is null when the declaration is
 *   missing, which is distinct from an empty set.
 */
function parseSwState(src) {
  const strict = src.match(CACHE_NAME_PATTERN);
  const loose = src.match(CACHE_NAME_LOOSE);
  const stripped = stripComments(src);
  const literal = bracketedLiteral(stripped, 'const NETWORK_FIRST_PATHS');
  return {
    cacheName: strict ? strict[1] : (loose ? loose[1] : null),
    generation: strict ? Number(strict[2]) : null,
    networkFirst: literal === null
      ? null
      : new Set([...literal.matchAll(/'([^']*)'/g)].map((m) => m[1]))
  };
}

/**
 * Decide whether a changed repository path is served cache-first.
 *
 * @param {string} repoPath - Path relative to the repository root, as `git diff
 *   --name-only` prints it.
 * @param {Set<string>} networkFirst - `NETWORK_FIRST_PATHS` from the HEAD
 *   `sw.js` — the worker that will be installed, so the set that will govern.
 * @returns {boolean} True when a stale copy of this file can be served
 *   indefinitely and only a `CACHE_NAME` bump evicts it.
 */
function isCacheFirstAsset(repoPath, networkFirst) {
  if (!repoPath.startsWith(`${PUBLIC_DIR}/`)) return false;
  const served = repoPath.slice(PUBLIC_DIR.length);
  // The worker script itself is fetched by the browser, not through its own
  // fetch handler, and `sw-register.js` registers it with `updateViaCache:
  // 'none'` so the HTTP cache cannot hold it either.
  if (served === '/sw.js') return false;
  if (NAVIGATION_EXTENSIONS.has(path.extname(served))) return false;
  return !networkFirst.has(served);
}

/**
 * Evaluate the guard against a diff.
 *
 * Pure: it takes the two `sw.js` revisions and the changed-path list rather
 * than reaching for git, so both arms can be driven from constructed inputs.
 *
 * @param {object} input
 * @param {string} input.baseSw - `public/sw.js` at the merge base.
 * @param {string} input.headSw - `public/sw.js` at HEAD.
 * @param {string[]} input.changedPaths - Repository-relative paths that differ
 *   between the two.
 * @returns {{ok: boolean, message: string, offenders: string[]}} `offenders` is
 *   the cache-first assets that changed, empty unless arm 1 fired.
 */
function evaluate({ baseSw, headSw, changedPaths }) {
  const head = parseSwState(headSw);
  const base = parseSwState(baseSw);

  if (!NAVIGATION_CONDITION.test(headSw)) {
    return {
      ok: false,
      offenders: [],
      message: `${SW_PATH} no longer treats navigations as network-first, so this guard's HTML `
        + 'exemption no longer follows from the worker: index.html, session.html and '
        + 'openclaw-view.html would be served cache-first and silently exempted. Change this '
        + 'script in the same commit.'
    };
  }

  if (head.networkFirst === null) {
    return {
      ok: false,
      offenders: [],
      message: `${SW_PATH} declares no NETWORK_FIRST_PATHS. This guard reads that set to tell a `
        + 'cache-first asset from a network-first one; without it every answer it could give '
        + 'would be a guess.'
    };
  }
  if (head.generation === null) {
    return {
      ok: false,
      offenders: [],
      message: `CACHE_NAME is ${head.cacheName === null ? 'absent' : `'${head.cacheName}'`}, which `
        + "is not the tangleclaw-v3-N form. This guard parses that form to tell a bump from a "
        + 'regression, so abandoning it disarms the check silently. Keep the form, or change this '
        + 'script in the same commit.'
    };
  }

  if (base.generation !== null && head.generation < base.generation) {
    return {
      ok: false,
      offenders: [],
      message: `CACHE_NAME went backwards: v3-${base.generation} -> v3-${head.generation}. A `
        + 'generation that already shipped can still be in a browser, and reusing its key means '
        + "the `activate` handler keeps that browser's cache instead of evicting it."
    };
  }

  if (base.cacheName !== head.cacheName) return { ok: true, offenders: [], message: 'CACHE_NAME was bumped.' };

  const offenders = changedPaths.filter((p) => isCacheFirstAsset(p, head.networkFirst)).sort();
  if (offenders.length === 0) {
    return { ok: true, offenders: [], message: 'No cache-first asset changed in this diff.' };
  }

  return {
    ok: false,
    offenders,
    message: `CACHE_NAME is still '${head.cacheName}', but these files are served cache-first and `
      + 'changed in this diff:\n'
      + offenders.map((p) => `  ${p}`).join('\n')
      + `\n\nA browser with an active service worker will keep serving the old copy of each until `
      + `the generation changes, so the change is invisible to the operator. Either bump CACHE_NAME `
      + `in ${SW_PATH}, or add the path to NETWORK_FIRST_PATHS if it should never be served from `
      + 'cache at all.'
  };
}

/**
 * Run git, refusing to answer when it cannot.
 *
 * @param {string[]} args - Arguments after `git`.
 * @param {string} repo - Repository working directory.
 * @param {{tolerate?: boolean}} [opts] - When `tolerate`, a non-zero exit
 *   returns null instead of throwing; used where absence is a legitimate answer.
 * @returns {string|null} stdout with trailing newline removed.
 * @throws {Error} When git cannot answer and `tolerate` is not set.
 */
function git(args, repo, opts = {}) {
  const run = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024
  });
  if (run.error || run.status !== 0) {
    if (opts.tolerate) return null;
    const detail = (run.error && run.error.message) || run.stderr || `exit ${run.status}`;
    throw new Error(`git ${args.join(' ')} failed: ${detail.trim()}`);
  }
  return run.stdout.replace(/\n$/, '');
}

/**
 * Parse argv into options.
 *
 * A flag present but EMPTY is an error, never a skip. The workflow passes the
 * base through `$BASE_SHA`, so an expression that resolved to nothing would
 * otherwise reach the "no base given" branch and report a clean skip — a guard
 * that reads as caution while doing nothing, on the one event it exists for.
 * Absent and empty are different states and only the first is legitimate.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{base: string|null, head: string, repo: string}}
 * @throws {Error} On an unrecognized flag, or one whose value is missing or empty.
 */
function parseArgs(argv) {
  const opts = { base: null, head: 'HEAD', repo: process.cwd() };
  const takesValue = { '--base': 'base', '--head': 'head', '--repo': 'repo' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = takesValue[flag];
    if (!key) throw new Error(`unrecognized argument '${flag}'`);
    const value = argv[i + 1];
    if (!value) throw new Error(`${flag} needs a non-empty value`);
    // A ref beginning with `-` reaches `git merge-base` as an OPTION. git either
    // rejects it with a usage dump attributed to this guard, or accepts one that
    // silently changes what is being compared.
    if (value.startsWith('-')) {
      throw new Error(`${flag} value '${value}' looks like an option, not a ref`);
    }
    opts[key] = value;
    i += 1;
  }
  return opts;
}

/**
 * Resolve the diff from git and report the verdict.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {number} Process exit code.
 */
function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`cache-bump-guard: ${err.message}\n`);
    return 1;
  }
  const { base, head, repo } = opts;

  // No base is a legitimate state, not a failure: a push to a branch with no
  // pull request has nothing to be a diff against. Say so — a check that goes
  // quiet is indistinguishable from a check that passed.
  if (!base) {
    process.stdout.write(
      'cache-bump-guard: skipped — no --base given, so there is no diff to evaluate. The '
      + 'cache-bump property is relational and cannot be decided from one tree.\n'
    );
    return 0;
  }

  let verdict;
  let report;
  try {
    const mergeBase = git(['merge-base', base, head], repo);
    const changedPaths = git(['diff', '--name-only', mergeBase, head], repo)
      .split('\n')
      .filter(Boolean);
    // A deleted or not-yet-added sw.js reads as empty, which `evaluate` rejects
    // through its parse arms rather than treating as "no network-first paths".
    const baseSw = git(['show', `${mergeBase}:${SW_PATH}`], repo, { tolerate: true }) || '';
    const headSw = git(['show', `${head}:${SW_PATH}`], repo, { tolerate: true }) || '';
    verdict = evaluate({ baseSw, headSw, changedPaths });

    // What the run READ, printed on success as well as failure. A guard that
    // only speaks when it fails is indistinguishable from one whose roster came
    // back wrong: a network-first set parsed empty exempts nothing and one
    // parsed short exempts too little, and from outside both look exactly like a
    // clean pass. Naming the generation and the roster size puts a bad parse in
    // the log of the run nobody was worried about.
    const state = parseSwState(headSw);
    report = `cache-bump-guard: read ${SW_PATH} at ${head} — CACHE_NAME `
      + `${state.cacheName || '(unparsed)'}, ${state.networkFirst ? state.networkFirst.size : 0} `
      + `network-first path(s), ${changedPaths.length} file(s) changed since ${mergeBase.slice(0, 8)}`;
  } catch (err) {
    process.stderr.write(`cache-bump-guard: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`${report}\n`);
  const stream = verdict.ok ? process.stdout : process.stderr;
  stream.write(`cache-bump-guard: ${verdict.ok ? 'ok' : 'FAILED'} — ${verdict.message}\n`);
  return verdict.ok ? 0 : 1;
}

module.exports = { parseSwState, isCacheFirstAsset, evaluate, stripComments, bracketedLiteral, main };

// `process.exitCode` rather than `process.exit()`. Writes to a piped stdout are
// asynchronous, and `process.exit()` tears the process down without waiting for
// them — under a CI runner, where stdout is always a pipe, that can drop the
// very message naming the offending files. Setting the code and letting the
// event loop drain is the only version that always says why it failed.
if (require.main === module) process.exitCode = main(process.argv.slice(2));
