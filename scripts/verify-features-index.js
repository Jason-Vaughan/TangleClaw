#!/usr/bin/env node
'use strict';

/**
 * Wave-diff `Tests:` anchor check (#2597 deliverable 2).
 *
 * A `W<N>-REC` records PR adds entries to `FEATURES.md` citing the wave's
 * new tests via a trailing `Tests: \`a.test.js\`, \`b.test.js\`.` clause.
 * `test/features-index.test.js` already holds every such anchor to
 * existing on disk and grepping its symbol, unconditionally — but nothing
 * before this held it to being the WAVE'S OWN test: a records PR could
 * cite pre-existing coverage as if it proved the wave's new work. This
 * script adds that one check: every `Tests:` anchor newly ADDED to
 * `FEATURES.md` by the diff against `--base` must name a file the SAME
 * diff touches.
 *
 * Only `+` lines of `FEATURES.md`'s own diff hunk count as "newly added" —
 * a context line or a line the diff removes is not a new claim, so a PR is
 * never held to re-touching every test file `FEATURES.md` has ever cited,
 * only the ones its own new entries claim.
 *
 * `--base` has no default and is not optional (PR #2606 review, Finding
 * C2). `origin/main` at check time is the WRONG base for a real
 * `W<N>-REC` records PR: by the time that PR runs, the wave's own PRs
 * (which added the test files) have already merged into `main`, so a
 * diff against the current tip shows `FEATURES.md` changing but no test
 * file touched — a true records PR would always fail. The base a
 * `W<N>-REC` caller must pass is the WAVE'S OWN STARTING COMMIT (the
 * `Base main Head` `LANE_QUEUE` records for that wave, from before any of
 * its PRs merged): diffed from there, the wave's accumulated changes
 * include both the new `FEATURES.md` citation and the test file it
 * cites. `.github/workflows/test.yml`'s Records Gate already invokes
 * this script with the ordinary PR base (`github.event.pull_request.base.sha`),
 * which is correct for a single-wave records PR but is exactly the WRONG
 * base above for a consolidated multi-wave one — nothing wires that
 * wave-start lookup yet (same posture as `scripts/suite-evidence.js`'s ci
 * mode: it exists and is correct to invoke, but computing the right
 * argument for that specific case is the caller's job to build). Refusing
 * a missing `--base` rather than defaulting to `origin/main` keeps a
 * future wrong-base caller loud instead of silently passing bad records.
 *
 * A consolidated records PR has no single `--base` that makes every cited
 * test file "touched" even with the right base above — those files landed
 * through each wave's own code PRs, which merged before the records PR
 * even branched. For that case, when the WHOLE diff classifies as
 * docs/records-only (`scripts/docs-records-only-diff.js`'s roster — no
 * executable/test file touched), an otherwise-unproven citation is
 * accepted when the file is real: a path under `test/` ending in
 * `.test.js`, present on disk at `HEAD`, and containing an actual test
 * registration once comments and string/template literals are stripped
 * out — a citation to `lib/foo.js` or `docs/foo.md`, or to a test file
 * whose only `it(`/`test(` text is commented out, is not evidence of
 * coverage no matter how the raw bytes read. Any diff that also touches
 * an executable or test file keeps the original strict "must be touched"
 * requirement, unchanged. This is the fallback the Records Gate's
 * existing invocation benefits from directly.
 *
 * Usage: node scripts/verify-features-index.js --base <ref>
 *   --base <ref>  REQUIRED. For `W<N>-REC`, the wave's starting commit —
 *                 never `origin/main` at check time.
 * Exit 0 when every newly-added `Tests:` anchor names a touched file (or,
 * on a docs-only diff, a real file on disk), or none were added; 1
 * otherwise, naming each violation.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { evaluate: evaluateDocsOnly } = require('./docs-records-only-diff');

const ROOT = path.join(__dirname, '..');

/**
 * A test registration call whose first argument is a string/template literal
 * -- `it(`/`test(`, this repo's node:test convention, including the
 * `.only`/`.skip`/`.todo` variants and an optional `await`. Matched against
 * content where {@link stripCommentsAndStrings} has already turned every
 * string/template literal into a literal `""`, so this can require that
 * `""` right after the call -- `it(foo)` or a (correctly stripped) regex
 * literal never produces that shape, only a real `it('name', fn)`/
 * `test(\`name\`, fn)` does. The call must also follow a statement/block
 * boundary (start of file, `;{()` or a line break) -- never a bare `/`,
 * which would mean a regex literal survived stripping unstripped: belt and
 * suspenders alongside the scanner below, not a substitute for it.
 */
const TEST_CALL_RE = /(?:^|[;{()\r\n])\s*(?:await\s+)?(?:it|test)(?:\s*\.\s*(?:only|skip|todo))?\s*\(\s*""/;

/**
 * A docs-only fallback citation must itself look like a test file -- `lib/foo.js`
 * or `docs/foo.md` mentioning `it(`/`test(` in prose is not evidence of coverage,
 * however real that text reads after comment/string stripping below. This
 * shape check alone does NOT rule out `test/../x.test.js` -- `.` and `/` are
 * both in the allowed character class -- {@link isRealTestPath} combines it
 * with an explicit `..` rejection and a resolved-path containment check.
 */
const TEST_PATH_RE = /^test\/[A-Za-z0-9_./-]+\.test\.js$/;

/** One `Tests:` clause's backtick-quoted file list. */
const TESTS_CLAUSE_RE = /Tests:\s*((?:`[^`]+`,?\s*)+)\.?/g;
const QUOTED_PATH_RE = /`([^`]+)`/g;

/**
 * The test files a `Tests:` clause on one added line cites.
 *
 * @param {string} addedLine - A line from the diff's `+` side, leading `+` already stripped
 * @returns {string[]} The cited paths, possibly empty
 */
function testsCitedOn(addedLine) {
  const out = [];
  TESTS_CLAUSE_RE.lastIndex = 0;
  let clauseMatch;
  while ((clauseMatch = TESTS_CLAUSE_RE.exec(addedLine)) !== null) {
    QUOTED_PATH_RE.lastIndex = 0;
    let pathMatch;
    while ((pathMatch = QUOTED_PATH_RE.exec(clauseMatch[1])) !== null) out.push(pathMatch[1]);
  }
  return out;
}

/**
 * Run git in the repository.
 *
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/**
 * Every file the diff against `base` touches, repo-relative.
 *
 * @param {string} base - The ref to diff against
 * @param {{git?: function(string[]): string}} [io] - Injection seam
 * @returns {Set<string>}
 */
function touchedFiles(base, io = {}) {
  const run = io.git || git;
  return new Set(run(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean));
}

/**
 * Whether `relPath` exists on disk at `HEAD`, repo-relative.
 *
 * @param {string} relPath
 * @param {{existsSync?: function(string): boolean}} [io] - Injection seam
 * @returns {boolean}
 */
function existsOnDisk(relPath, io = {}) {
  const exists = io.existsSync || fs.existsSync;
  return exists(path.join(ROOT, relPath));
}

/** A char that can legally precede the `/` that OPENS a regex literal (never divides). */
const REGEX_PRECEDES_RE = /[=([{,;:!&|?~^%+\-*/<>]/;

/**
 * Keywords after which a bare `/` is unambiguously a regex literal, never
 * division -- `return /x/`, `typeof /x/`, etc. Checked against the most
 * recent identifier token, not the last character, because the token itself
 * (`n`, `w`, ...) is not an operator/punctuation character and so would
 * otherwise read as an ordinary expression continuing (the exact round-4
 * bug: `return /;it("fake")/` left `return`'s `/` unrecognized because
 * `prevNonWs` was `'n'`).
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'case', 'throw', 'typeof', 'void', 'delete', 'in', 'instanceof', 'new', 'yield', 'await', 'of', 'else', 'do'
]);

/** Identifier/keyword token characters. */
const ID_START_RE = /[A-Za-z_$]/;
const ID_PART_RE = /[A-Za-z0-9_$]/;

/**
 * Blank out comments and regex literals, and collapse every string/template
 * literal down to a bare `""` -- so a real call's string first argument can
 * be matched by shape (`it("", ...)`) regardless of what the argument text
 * said, while `it(`/`test(` appearing in prose, inside a comment, inside a
 * `/regex/` literal (including one whose body itself contains quote
 * characters, e.g. `/it("fake")/`, or follows a regex-preceding keyword like
 * `return`), or followed by a non-string argument never produces a `""`
 * right after the call.
 *
 * A single left-to-right scan, not independent regex passes: a regex
 * literal can contain quote characters and a string can contain `/`
 * characters, so each construct must be recognized in the context of what
 * has already been consumed, not pattern-matched against the raw source in
 * isolation (that was the exact bug an earlier round of review caught --
 * the standalone string regex read the quotes inside `/it("fake")/` as a
 * string literal before anything recognized the surrounding `/.../` as a
 * regex). A `/` opens a regex literal when the last non-whitespace
 * character emitted could not have ended an expression (start of source,
 * or an operator/punctuation character per {@link REGEX_PRECEDES_RE}), OR
 * when the most recent identifier token is a {@link REGEX_PRECEDING_KEYWORDS}
 * entry that is itself not a property access (`obj.return /2` divides;
 * `return /x/` does not) -- the same heuristics real tokenizers use to
 * disambiguate regex-literal start from division.
 *
 * @param {string} src - JavaScript source
 * @returns {string} The same source with comments and regex literals
 *   replaced by spaces, and every string/template literal replaced by the
 *   two characters `""`
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let prevNonWs = '';
  let prevWord = '';
  let prevWordIsProperty = false;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';

    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        j += src[j] === '\\' && j + 1 < n ? 2 : 1;
      }
      out += '""';
      i = j < n ? j + 1 : j;
      prevNonWs = ')'; // a completed string behaves like an expression, never regex-preceding
      prevWord = '';
      prevWordIsProperty = false;
      continue;
    }

    if (ch === '/' && next !== '/' && next !== '*'
        && (prevNonWs === '' || REGEX_PRECEDES_RE.test(prevNonWs)
          || (!prevWordIsProperty && REGEX_PRECEDING_KEYWORDS.has(prevWord)))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') { inClass = true; j += 1; continue; }
        if (src[j] === ']') { inClass = false; j += 1; continue; }
        if (src[j] === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        for (let k = i; k <= j; k += 1) out += ' ';
        i = j + 1;
        prevNonWs = ')'; // a completed regex literal behaves like an expression too
        prevWord = '';
        prevWordIsProperty = false;
        continue;
      }
      // No closing `/` on this line: not a regex literal after all, fall through below.
    }

    if (ID_START_RE.test(ch)) {
      let j = i + 1;
      while (j < n && ID_PART_RE.test(src[j])) j += 1;
      const word = src.slice(i, j);
      out += word;
      prevWordIsProperty = prevNonWs === '.';
      prevWord = word;
      prevNonWs = word[word.length - 1];
      i = j;
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) {
      prevNonWs = ch;
      prevWord = '';
      prevWordIsProperty = false;
    }
    i += 1;
  }
  return out;
}

/**
 * Whether `relPath` is a real test file path: no `..` segment or backslash,
 * already normalized (`path.posix.normalize` changes nothing), matches the
 * `test/*.test.js` shape, AND resolves (relative to {@link ROOT}) inside the
 * `test/` directory -- the shape check alone cannot see `test/../x.test.js`
 * escaping `test/` by surviving character-class matching (`.` and `/` are
 * both allowed characters), so this adds the resolved-path containment
 * check the shape check cannot perform on its own.
 *
 * @param {string} relPath - A repo-relative path, as cited in `FEATURES.md`
 * @returns {boolean}
 */
function isRealTestPath(relPath) {
  if (relPath.includes('..') || relPath.includes('\\')) return false;
  if (path.posix.normalize(relPath) !== relPath) return false;
  if (!TEST_PATH_RE.test(relPath)) return false;
  const testDir = path.resolve(ROOT, 'test') + path.sep;
  return path.resolve(ROOT, relPath).startsWith(testDir);
}

/**
 * Whether `relPath` looks like a real test file: a genuine path under
 * `test/` (see {@link isRealTestPath}), existing on disk, whose content
 * (comments and string/template literals stripped first) contains a real
 * test registration — a lightweight sanity check, not a test run.
 *
 * @param {string} relPath
 * @param {{existsSync?: function(string): boolean, readFileSync?: function(string, string): string}} [io] - Injection seams
 * @returns {boolean}
 */
function hasRealTests(relPath, io = {}) {
  if (!isRealTestPath(relPath)) return false;
  if (!existsOnDisk(relPath, io)) return false;
  const read = io.readFileSync || fs.readFileSync;
  let content;
  try {
    content = read(path.join(ROOT, relPath), 'utf8');
  } catch {
    return false;
  }
  return TEST_CALL_RE.test(stripCommentsAndStrings(content));
}

/**
 * Every test file newly cited by a `Tests:` clause added to `FEATURES.md`
 * in the diff against `base`.
 *
 * @param {string} base - The ref to diff against
 * @param {{git?: function(string[]): string}} [io] - Injection seam
 * @returns {string[]}
 */
function newlyCitedTests(base, io = {}) {
  const run = io.git || git;
  const diff = run(['diff', `${base}...HEAD`, '--', 'FEATURES.md']);
  const out = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    out.push(...testsCitedOn(line.slice(1)));
  }
  return out;
}

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{base: string}}
 * @throws {Error} When `--base` is missing or unrecognized argv is given — there is no safe
 *   default (see the module docstring: `origin/main` at check time is wrong for `W<N>-REC`)
 */
function parseArgs(argv) {
  const parsed = { base: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--base' && argv[i + 1]) { parsed.base = argv[++i]; continue; }
    throw new Error(`unknown or incomplete argument: ${flag}\nusage: verify-features-index.js --base <ref>`);
  }
  if (!parsed.base) {
    throw new Error('--base is required: there is no safe default. For W<N>-REC, pass the wave\'s own '
      + 'starting commit, never origin/main at check time (see the module docstring).\n'
      + 'usage: verify-features-index.js --base <ref>');
  }
  return parsed;
}

/**
 * Run the check end to end and return the process exit code.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, git?: function(string[]): string,
 *   existsSync?: function(string): boolean, readFileSync?: function(string, string): string}} [io] - Injection seams
 * @returns {number} The exit code
 */
function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    out.write(`${err.message}\n`);
    return 1;
  }
  const cited = newlyCitedTests(parsed.base, io);
  if (cited.length === 0) {
    out.write('no Tests: anchors were newly added to FEATURES.md in this diff\n');
    return 0;
  }
  const touched = touchedFiles(parsed.base, io);
  let unproven = [...new Set(cited)].filter((f) => !touched.has(f));

  // A docs/records-only diff never touches the test files its citations
  // name (see module docstring) -- for that case only, fall back to an
  // on-disk reality check instead of diff membership. A diff that also
  // touches an executable/test file keeps the strict check below unchanged.
  if (unproven.length > 0 && evaluateDocsOnly([...touched]).ok) {
    unproven = unproven.filter((f) => !hasRealTests(f, io));
  }

  if (unproven.length > 0) {
    out.write(`REFUSED: Tests: anchor(s) newly added to FEATURES.md cite a file this diff does not touch: ${unproven.join(', ')}\n`);
    return 1;
  }
  out.write(`${cited.length} newly added Tests: anchor(s), each naming a file this diff touches\n`);
  return 0;
}

module.exports = {
  testsCitedOn, touchedFiles, newlyCitedTests, existsOnDisk, isRealTestPath, hasRealTests,
  stripCommentsAndStrings, parseArgs, main
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
