#!/usr/bin/env node
'use strict';

/**
 * The test tier ledger: which of `test/*.test.js` is Small, Medium or Large,
 * and the static classifier that proposes and checks it.
 *
 * A tier is a promise about what a test file DOES at run time, not what it
 * loads: a product module may require `child_process` at its top and still
 * be fine in a Small test that never asks it to spawn.
 *
 *   small   starts no subprocess, opens no database, listens on no socket —
 *           pure in-process JavaScript
 *   medium  starts no subprocess; a temp SQLite database or an in-process
 *           HTTP server is fine
 *   large   anything, including subprocesses, tmux, git worktrees and CLIs
 *
 * The ledger (`test/tiers.json`) is the declaration; the runtime guards
 * (`test/helpers/preload-small.js`, `test/helpers/preload-medium.js`) are the
 * enforcement. This script sits between them: `--propose` reads a file's text
 * and names the fastest tier its visible requires allow, `--write` regenerates
 * the ledger from that scan, and `--check` refuses a ledger that is not total
 * (a test file missing or listed twice, or a listed file that no longer
 * exists) or that declares a file FASTER than its text allows. Declaring a
 * file slower than the scan says is always allowed: the guarded run is what
 * finds the subprocess a product module reaches, and demoting the file is the
 * honest answer, so `--write` keeps an existing slower declaration.
 *
 * The scan is deliberately shallow on the product side. It walks requires of
 * other files under `test/` (helpers and fixtures), because a helper that
 * spawns makes every test that loads it Large, but it does not walk into
 * `lib/`: that is the guard's job at run time, and a text scan of the product
 * would turn into a second require graph nobody maintains.
 *
 * Usage: node scripts/test-tiers.js --check
 *        node scripts/test-tiers.js --list <small|medium|large>
 *        node scripts/test-tiers.js --propose [<file> ...]
 *        node scripts/test-tiers.js --write
 * Exit 0 on success; `--check` exits 1 naming every failure.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');

/** The ledger's path. Tracked, so the declaration is reviewed like code. */
const DEFAULT_LEDGER = path.join(TEST_DIR, 'tiers.json');

/** The tiers, fastest first. The index is the order `--check` compares by. */
const TIERS = Object.freeze(['small', 'medium', 'large']);

/**
 * What marks a file Large: it binds `child_process` AND calls a spawner. The
 * require alone is not a signal, because the guard refuses the call and not
 * the load. The call alone is not one either: `re.exec(` and SQLite's
 * `db.exec(` are not spawns, and a file that never binds `child_process`
 * cannot be calling one of its functions except through a product module,
 * which is the guard's to catch. Both together catch the destructured
 * `const { spawn } = require(...)` whose require line is far from the call.
 */
const CHILD_PROCESS_REQUIRE = /require\(\s*['"](?:node:)?child_process['"]\s*\)/;
const SPAWNER_CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/;

/**
 * What marks a file at least Medium: it opens a database, listens, serves or
 * fetches. A require of the store facade or the server counts because a
 * test that loads either nearly always opens one, and a text scan cannot
 * tell the exception; such a test is declared medium and loses nothing.
 */
const MEDIUM_PATTERNS = Object.freeze([
  /\bnew\s+DatabaseSync\b/,
  /require\(\s*['"]\.\.\/lib\/store(?:\/[^'"]*)?['"]\s*\)/,
  /require\(\s*['"]\.\.\/server['"]\s*\)/,
  /require\(\s*['"](?:node:)?(?:net|http|https|http2|dgram)['"]\s*\)/,
  /\.listen\s*\(/,
  /\bcreateServer\s*\(/,
  /\bfetch\s*\(/,
  /\bhttp\.request\s*\(/
]);

/** A require of another file under `test/`: the scan follows these. */
const LOCAL_REQUIRE = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

/**
 * Comment text contributes nothing to a classification: a sentence like
 * "no child_process here" must not make a file Large. Block and line comments
 * are blanked before the patterns run; string contents are kept, because a
 * test that builds a `require` from pieces is rare and the guard catches it.
 *
 * @param {string} text - A JavaScript source
 * @returns {string} The same text with comments replaced by spaces
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/**
 * Resolve a local require the way node does for a file under `test/`.
 *
 * @param {string} fromFile - The requiring file's absolute path
 * @param {string} request - The require argument
 * @param {string} [testDir] - The directory the scan stays inside; `test/` by default
 * @returns {string|null} The absolute path of a file under `testDir`, or null
 *   when the request leaves it or names nothing that exists
 */
function resolveLocal(fromFile, request, testDir = TEST_DIR) {
  const base = path.resolve(path.dirname(fromFile), request);
  if (!base.startsWith(testDir + path.sep)) return null;
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The fastest tier one text allows, from its own lines alone.
 *
 * @param {string} text - A JavaScript source
 * @returns {string} `small`, `medium` or `large`
 */
function classifyText(text) {
  const code = stripComments(text);
  if (CHILD_PROCESS_REQUIRE.test(code) && SPAWNER_CALL.test(code)) return 'large';
  if (MEDIUM_PATTERNS.some((re) => re.test(code))) return 'medium';
  return 'small';
}

/**
 * The fastest tier a file allows, following its requires of other files
 * under `test/` so a helper's subprocess counts against every test that
 * loads it.
 *
 * @param {string} file - Absolute path of a test file
 * @param {{readFile?: function(string): string, testDir?: string}} [io] - Injection seam:
 *   `testDir` is the directory the scan stays inside, `test/` by default
 * @returns {string} `small`, `medium` or `large`
 */
function classifyFile(file, io = {}) {
  const readFile = io.readFile || ((f) => fs.readFileSync(f, 'utf8'));
  const testDir = io.testDir || TEST_DIR;
  const seen = new Set();
  let slowest = 0;
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const text = readFile(f);
    slowest = Math.max(slowest, TIERS.indexOf(classifyText(text)));
    if (slowest === TIERS.length - 1) return;
    const code = stripComments(text);
    for (const m of code.matchAll(LOCAL_REQUIRE)) {
      const target = resolveLocal(f, m[1], testDir);
      if (target) visit(target);
    }
  };
  visit(file);
  return TIERS[slowest];
}

/**
 * Every test file the suite runs, as paths relative to the repository root,
 * sorted. This is the same set `node --test 'test/*.test.js'` sees.
 *
 * @returns {string[]}
 */
function suiteFiles() {
  return fs.readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `test/${name}`)
    .sort();
}

/**
 * Read and shape-check the ledger.
 *
 * @param {string} [ledgerPath] - Defaults to `test/tiers.json`
 * @returns {{small: string[], medium: string[], large: string[]}}
 */
function loadLedger(ledgerPath = DEFAULT_LEDGER) {
  const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const ledger = {};
  for (const tier of TIERS) {
    if (!Array.isArray(raw[tier]) || raw[tier].some((f) => typeof f !== 'string')) {
      throw new Error(`tiers ledger: "${tier}" must be an array of file paths`);
    }
    ledger[tier] = raw[tier];
  }
  return ledger;
}

/**
 * Check a ledger against the files on disk and the scan.
 *
 * @param {{small: string[], medium: string[], large: string[]}} ledger
 * @param {{files?: string[], classify?: function(string): string}} [io] - Injection seam:
 *   `files` the suite's files, `classify` the scan, both relative-path based
 * @returns {{ok: boolean, failures: string[]}} Every failure named, in a stable order
 */
function checkLedger(ledger, io = {}) {
  const files = io.files || suiteFiles();
  const classify = io.classify || ((rel) => classifyFile(path.join(ROOT, rel)));
  const failures = [];
  const declared = new Map();
  for (const tier of TIERS) {
    for (const rel of ledger[tier]) {
      if (declared.has(rel)) failures.push(`listed twice: ${rel} (${declared.get(rel)} and ${tier})`);
      declared.set(rel, tier);
    }
  }
  const onDisk = new Set(files);
  for (const rel of files) {
    if (!declared.has(rel)) failures.push(`not in the ledger: ${rel}`);
  }
  for (const [rel, tier] of declared) {
    if (!onDisk.has(rel)) {
      failures.push(`in the ledger but not in the suite: ${rel} (${tier})`);
      continue;
    }
    const allowed = classify(rel);
    if (TIERS.indexOf(tier) < TIERS.indexOf(allowed)) {
      failures.push(`declared ${tier} but its text allows no faster than ${allowed}: ${rel}`);
    }
  }
  for (const tier of TIERS) {
    const sorted = [...ledger[tier]].sort();
    if (sorted.some((f, i) => f !== ledger[tier][i])) failures.push(`"${tier}" is not sorted`);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Build a ledger from the scan, keeping any existing declaration that is
 * slower than the scan allows (a demotion the guarded run earned).
 *
 * @param {{small: string[], medium: string[], large: string[]}|null} existing - The current ledger, or null
 * @param {{files?: string[], classify?: function(string): string}} [io] - Injection seam
 * @returns {{small: string[], medium: string[], large: string[]}}
 */
function buildLedger(existing, io = {}) {
  const files = io.files || suiteFiles();
  const classify = io.classify || ((rel) => classifyFile(path.join(ROOT, rel)));
  const current = new Map();
  if (existing) for (const tier of TIERS) for (const rel of existing[tier]) current.set(rel, tier);
  const ledger = { small: [], medium: [], large: [] };
  for (const rel of files) {
    const scanned = classify(rel);
    const kept = current.get(rel);
    const tier = kept && TIERS.indexOf(kept) > TIERS.indexOf(scanned) ? kept : scanned;
    ledger[tier].push(rel);
  }
  for (const tier of TIERS) ledger[tier].sort();
  return ledger;
}

/** The text at the top of the written ledger: what each tier promises. */
const LEDGER_COMMENT = Object.freeze([
  'Which tier each test file is in (#2498). The tier is a promise about what the file DOES',
  'at run time (not what it loads), and test/helpers/preload-<tier>.js enforces it when the',
  'tier runs:',
  '  small   starts no subprocess, opens no node:sqlite database, listens on no socket',
  '  medium  starts no subprocess',
  '  large   anything',
  'Every test/*.test.js is listed exactly once. `node scripts/test-tiers.js --check` refuses a',
  'file that is missing, listed twice, gone, or declared faster than its text allows; declaring',
  'a file slower than the scan says is always allowed, and is how a file is demoted when the',
  'guarded run shows product code it calls starting a process or opening a database.',
  '`--write` regenerates this file from the scan and keeps those demotions.'
]);

/**
 * Serialize a ledger the way the tracked file is written.
 *
 * @param {{small: string[], medium: string[], large: string[]}} ledger
 * @returns {string}
 */
function formatLedger(ledger) {
  return `${JSON.stringify({ _comment: LEDGER_COMMENT, ...ledger }, null, 2)}\n`;
}

/**
 * Parse argv into one command.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{command: string, tier?: string, files?: string[]}}
 */
function parseArgs(argv) {
  const [flag, ...rest] = argv;
  if (flag === '--check' && rest.length === 0) return { command: 'check' };
  if (flag === '--write' && rest.length === 0) return { command: 'write' };
  if (flag === '--propose') return { command: 'propose', files: rest };
  if (flag === '--list' && rest.length === 1 && TIERS.includes(rest[0])) return { command: 'list', tier: rest[0] };
  throw new Error('usage: test-tiers.js --check | --list <small|medium|large> | --propose [<file> ...] | --write');
}

/**
 * Run one command and return the process exit code.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, ledgerPath?: string}} [io] - Injection seam
 * @returns {number} 0 on success, 1 on a failed check or a usage error
 */
function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const ledgerPath = io.ledgerPath || DEFAULT_LEDGER;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    out.write(`${err.message}\n`);
    return 1;
  }
  if (parsed.command === 'propose') {
    const files = parsed.files.length > 0 ? parsed.files : suiteFiles();
    for (const rel of files) out.write(`${classifyFile(path.resolve(ROOT, rel))}\t${rel}\n`);
    return 0;
  }
  if (parsed.command === 'write') {
    const existing = fs.existsSync(ledgerPath) ? loadLedger(ledgerPath) : null;
    const ledger = buildLedger(existing);
    fs.writeFileSync(ledgerPath, formatLedger(ledger));
    out.write(`wrote ${path.relative(ROOT, ledgerPath)}: ${TIERS.map((t) => `${t} ${ledger[t].length}`).join(', ')}\n`);
    return 0;
  }
  const ledger = loadLedger(ledgerPath);
  if (parsed.command === 'list') {
    for (const rel of ledger[parsed.tier]) out.write(`${rel}\n`);
    return 0;
  }
  const result = checkLedger(ledger);
  if (result.ok) {
    out.write(`tiers ledger ok: ${TIERS.map((t) => `${t} ${ledger[t].length}`).join(', ')}\n`);
    return 0;
  }
  for (const line of result.failures) out.write(`${line}\n`);
  out.write(`tiers ledger: ${result.failures.length} failure(s)\n`);
  return 1;
}

module.exports = {
  TIERS, DEFAULT_LEDGER, LEDGER_COMMENT, stripComments, classifyText, classifyFile, suiteFiles,
  loadLedger, checkLedger, buildLedger, formatLedger, parseArgs, main
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
