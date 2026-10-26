#!/usr/bin/env node
'use strict';

/**
 * The PR fragment gate (#1220 C05 / #2523): one pull request touching
 * `lib/`, `server.js`, `public/` or `scripts/` must add a changelog fragment,
 * or carry the `Changelog: none <reason>` escape — documented, word for
 * word, in `docs/release-process.md` "Proposed: PR fragment gate" before
 * this file existed.
 *
 * **Which pull requests.** One whose changed-file list touches `lib/`,
 * `server.js`, `public/` or `scripts/`. Anything else (docs, tests, records)
 * is not asked for a fragment.
 *
 * **What satisfies it.** At least one changed file directly under
 * `changelog.d/` whose name {@link parseFragmentName} accepts AND whose
 * GitHub file status is exactly `"added"`. An additions/deletions line
 * count was tried first and is not proof of added-file status: a PR that
 * only appends a line to a pre-existing, already-valid fragment shows
 * `additions: 1, deletions: 0` — identical to a genuinely new file — so a
 * real git status is required instead (`gh pr view --json files` carries no
 * such field; the REST `pulls/<pr>/files` endpoint's `status` does). Any
 * other status — `modified`, `removed`, `renamed`, or missing/unrecognized —
 * does not satisfy the gate by that file, and is also excluded from the
 * malformed-name check below: a cleanup that only deletes, renames or edits
 * an existing entry must not be refused for a naming problem it did not
 * introduce. The name is judged, as the wrap's coverage gate judges it; the
 * body is read at release preparation, not here.
 *
 * **The escape.** The PR body carries the exact line `Changelog: none`,
 * followed on the same line by the reason. The line with no reason refuses.
 *
 * **Fail closed, unconditionally.** A malformed name on an ADDED file under
 * `changelog.d/` refuses the run even when a valid fragment or the escape is
 * also present — the same "a stray file there is never waved through" rule
 * `lib/wrap-steps/changelog-coverage.js` enforces for the wrap's own gate.
 * An unreadable files list or PR body cannot be judged at all, which is a
 * different exit code (`4`) from a judged refusal (`1`).
 *
 * Usage: node scripts/changelog-fragment-gate.js --pr <number>
 *        node scripts/changelog-fragment-gate.js --files <path> --body-file <path>
 *   --pr <number>        read the PR's changed files (with real git status)
 *                         via `gh api repos/{owner}/{repo}/pulls/<number>/files
 *                         --paginate`, and the body via
 *                         `gh api repos/{owner}/{repo}/pulls/<number>`
 *   --files <path>        test seam: a JSON file holding an array of
 *                          `{path, status}` objects (`status` one of
 *                          `added`/`modified`/`removed`/`renamed`; a plain
 *                          string is shorthand for `{path, status: 'added'}`)
 *   --body-file <path>    test seam: a file holding the PR body text
 * Exit 0: a valid fragment was added, the PR touches no code path, or the
 *   escape line carries a reason.
 * Exit 1: refused, with the reason printed: no fragment on a code change, a
 *   malformed fragment name, or the escape line without a reason.
 * Exit 4: could not measure: the file list or the body could not be read.
 */

const fs = require('node:fs');
const path = require('node:path');

const { execFileArgs, describeFailure } = require('../lib/exec');
const { FRAGMENT_DIR, parseFragmentName } = require('../lib/changelog-fragments');

/** Path prefixes (or, for `server.js`, the exact root file) a PR must touch to be asked for a fragment. */
const CODE_PREFIXES = Object.freeze(['lib/', 'public/', 'scripts/']);

/** The escape line: `Changelog: none` at line start, the reason on the same line. */
const ESCAPE_LINE_RE = /^Changelog: none([^\n]*)$/m;

/** A failure that could not be judged at all — distinct from a judged refusal. */
class Unreadable extends Error {}

/**
 * Whether a changed path is one the gate asks a fragment for.
 *
 * @param {string} p - A repo-relative path as `gh pr view`/`git diff` names it
 * @returns {boolean}
 */
function touchesCode(p) {
  return p === 'server.js' || CODE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Whether a changed path sits directly under `changelog.d/` (no deeper nesting).
 *
 * @param {string} p
 * @returns {string|null} The basename, or null when `p` is not a direct entry
 */
function fragmentDirEntry(p) {
  const prefix = `${FRAGMENT_DIR}/`;
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/') ? rest : null;
}

/**
 * Judge a PR's changed files and body against the gate.
 *
 * @param {Array<string|{path:string, status?:string}>} files - Changed entries. A plain string
 *   is shorthand for `{path, status: 'added'}`; the richer shape carries GitHub's real file
 *   status (`added`/`modified`/`removed`/`renamed`), the only way to tell a genuinely new
 *   fragment from an append-only edit of an existing one.
 * @param {string} body - The PR body text
 * @returns {{ok:boolean, code:number, reason:string}}
 */
function evaluate(files, body) {
  const changed = (Array.isArray(files) ? files : [])
    .map((f) => (typeof f === 'string' ? { path: f, status: 'added' } : f))
    .filter((f) => f && typeof f.path === 'string' && f.path.length > 0)
    .map((f) => ({ path: f.path, status: typeof f.status === 'string' ? f.status : null }));
  if (!changed.some((f) => touchesCode(f.path))) {
    return { ok: true, code: 0, reason: 'touches no `lib/`, `server.js`, `public/` or `scripts/` path; no fragment asked' };
  }

  // Only a file GitHub reports as `added` can be an ADDED fragment. Anything else — modified,
  // removed, renamed, or a status this gate doesn't recognize — is excluded before the
  // malformed-name check too: a PR that only deletes, renames or edits an existing entry must
  // not be refused for a naming problem it did not introduce.
  const fragmentEntries = changed
    .filter((f) => f.status === 'added')
    .map((f) => ({ path: f.path, name: fragmentDirEntry(f.path) }))
    .filter((e) => e.name !== null);

  for (const entry of fragmentEntries) {
    const parsed = parseFragmentName(entry.name);
    if (!parsed.ok) {
      return { ok: false, code: 1, reason: `${entry.path}: ${parsed.reason}` };
    }
  }
  if (fragmentEntries.length > 0) {
    return { ok: true, code: 0, reason: `fragment added: ${fragmentEntries.map((e) => e.path).join(', ')}` };
  }

  const escape = ESCAPE_LINE_RE.exec(typeof body === 'string' ? body : '');
  if (escape) {
    const why = escape[1].trim();
    if (why.length > 0) return { ok: true, code: 0, reason: `escaped: Changelog: none${escape[1]}` };
    return { ok: false, code: 1, reason: '`Changelog: none` carries no reason on its line' };
  }

  return {
    ok: false,
    code: 1,
    reason: 'no changelog.d/<issue>.<slug>.<type>.md fragment, and no `Changelog: none <reason>` escape line'
  };
}

/**
 * Read one JSON document from `gh api`.
 *
 * @param {string[]} apiArgs - Arguments after `gh api`
 * @returns {Promise<*>} The parsed JSON
 * @throws {Unreadable} When `gh` fails or answers with something unparseable
 */
async function _ghApi(apiArgs) {
  const r = await execFileArgs('gh', ['api', ...apiArgs], { timeoutMs: 15000, maxBufferBytes: 8 * 1024 * 1024 });
  if (r.exitCode !== 0) throw new Unreadable(describeFailure(r, `gh api ${apiArgs[0]}`));
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    throw new Unreadable(`gh answered with something that is not JSON: ${err.message}`);
  }
}

/**
 * Read the PR's changed files (with real git status) and body through `gh api`.
 *
 * `gh pr view --json files` carries no change-status field, only a line count — not proof of
 * added-file status (see the module header). The REST `pulls/<pr>/files` endpoint's `status`
 * is; `--paginate` covers a PR with more files than one page, merged by `gh` into one JSON array.
 *
 * @param {string} prNumber
 * @returns {Promise<{files:Array<{path:string, status:string}>, body:string}>}
 * @throws {Unreadable} When `gh` fails or answers with something unparseable
 */
async function readFromGh(prNumber) {
  const filesJson = await _ghApi(['repos/{owner}/{repo}/pulls/' + prNumber + '/files', '--paginate']);
  const files = Array.isArray(filesJson)
    ? filesJson
      .filter((f) => f && typeof f.filename === 'string')
      .map((f) => ({ path: f.filename, status: typeof f.status === 'string' ? f.status : null }))
    : null;
  if (files === null) throw new Unreadable('gh\'s answer carried no readable files list');

  // GitHub's REST API reports `body: null` for a pull request with no description — an empty
  // body to judge, not an unreadable one, so it is not refused with exit 4.
  const pr = await _ghApi(['repos/{owner}/{repo}/pulls/' + prNumber]);
  if (pr.body !== null && typeof pr.body !== 'string') throw new Unreadable('gh\'s answer carried no readable `body`');
  return { files, body: pr.body === null ? '' : pr.body };
}

/**
 * Read the files list and body from the test seam's two files.
 *
 * @param {string} filesPath - A JSON file holding an array of `{path, status}` objects
 *   (`status` one of `added`/`modified`/`removed`/`renamed`; a plain string entry is shorthand
 *   for `{path, status: 'added'}`)
 * @param {string} bodyFilePath - A file holding the PR body text
 * @returns {{files:Array<string|{path:string, status?:string}>, body:string}}
 * @throws {Unreadable} When either file is unreadable or the files JSON is not an array of strings/objects
 */
function readFromFiles(filesPath, bodyFilePath) {
  let files;
  try {
    files = JSON.parse(fs.readFileSync(filesPath, 'utf8'));
  } catch (err) {
    throw new Unreadable(`could not read --files ${filesPath}: ${err.message}`);
  }
  const validEntry = (f) => typeof f === 'string' || (f && typeof f.path === 'string');
  if (!Array.isArray(files) || !files.every(validEntry)) {
    throw new Unreadable(`--files ${filesPath} must hold a JSON array of strings or {path, status} objects`);
  }
  let body;
  try {
    body = fs.readFileSync(bodyFilePath, 'utf8');
  } catch (err) {
    throw new Unreadable(`could not read --body-file ${bodyFilePath}: ${err.message}`);
  }
  return { files, body };
}

/**
 * Parse argv into options.
 *
 * @param {string[]} argv
 * @returns {{pr: string|null, filesPath: string|null, bodyFilePath: string|null}}
 * @throws {Error} On an unrecognized flag, a missing value, or an incomplete combination
 */
function parseArgs(argv) {
  const opts = { pr: null, filesPath: null, bodyFilePath: null };
  const takesValue = { '--pr': 'pr', '--files': 'filesPath', '--body-file': 'bodyFilePath' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = takesValue[flag];
    if (!key) throw new Error(`unrecognized argument '${flag}'`);
    const value = argv[i + 1];
    if (!value) throw new Error(`${flag} needs a non-empty value`);
    opts[key] = value;
    i += 1;
  }
  const hasPr = opts.pr !== null;
  const hasFiles = opts.filesPath !== null || opts.bodyFilePath !== null;
  if (hasPr === hasFiles || (hasFiles && (opts.filesPath === null || opts.bodyFilePath === null))) {
    throw new Error('pass exactly one of --pr <number>, or both --files <path> and --body-file <path>');
  }
  return opts;
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {Promise<number>} Exit code
 */
async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`changelog-fragment-gate: ${err.message}\n`);
    return 4;
  }
  let input;
  try {
    input = opts.pr !== null ? await readFromGh(opts.pr) : readFromFiles(opts.filesPath, opts.bodyFilePath);
  } catch (err) {
    if (!(err instanceof Unreadable)) throw err;
    process.stderr.write(`changelog-fragment-gate: could not measure — ${err.message}\n`);
    return 4;
  }
  const verdict = evaluate(input.files, input.body);
  process.stdout.write(`changelog-fragment-gate: ${verdict.ok ? 'pass' : 'refused'} — ${verdict.reason}\n`);
  return verdict.code;
}

module.exports = { touchesCode, fragmentDirEntry, evaluate, parseArgs, main, CODE_PREFIXES, ESCAPE_LINE_RE };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
