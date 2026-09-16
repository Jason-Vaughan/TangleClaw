'use strict';

/**
 * Content-based secret check for the files a wrap would commit (#1513).
 *
 * `./_file-ownership` decides WHO a change belongs to; nothing looked at WHAT a
 * file holds, so a credential pasted into a session file, or sitting in a file
 * the operator chose to include, went into the wrap commit and out with the
 * auto-PR push. This module reads each candidate file and runs `lib/secret-scan.js`
 * over it.
 *
 * **Flag only.** Nothing is edited, masked or discarded. A file that matches a
 * secret rule is held out of the commit until the operator decides, through the
 * same Include / Leave choice (`options.pathDecisions`) the drawer already
 * renders for uncommitted files the session did not change:
 * - **Include** commits the file as it is (a test fixture, an example key);
 * - **Leave** keeps it out of the commit and leaves it on disk untouched.
 *
 * **What is scanned.** Every uncommitted file the wrap could commit — the
 * session's own files, TangleClaw maintenance, files the operator included —
 * and every file the wrap will ask about or has been told to leave, so a secret
 * sitting in the tree is named even when nobody picks Include. TangleClaw
 * machine state is never committed and is not scanned. A deleted file has no
 * content to commit.
 *
 * **Never the value.** `scanText` returns rule names only, so the step output,
 * the drawer, the log line and the activity row carry a path and a rule name
 * and cannot carry the matched text.
 *
 * **Skipped with a reason:** a file over {@link SCAN_SIZE_CAP}, one that looks
 * binary, a symbolic link (git commits the link text, not the target), anything
 * that is not a regular file, and a file that could not be read.
 *
 * Known limit: a decision is keyed by path, like every Include / Leave. An
 * Include given for a file before it matched a rule still stands if a secret is
 * written into it later in the same wrap.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');
const secretScan = require('../secret-scan');
const store = require('../store');
const ownership = require('./_file-ownership');

const log = createLogger('wrap-secret-check');

/**
 * Largest file scanned. Re-exported from `lib/secret-scan.js`, which owns it,
 * so this scanner and uploads cannot drift apart: a multi-megabyte file in a
 * working tree is almost always generated or binary, and reading it costs
 * memory for no signal.
 */
const SCAN_SIZE_CAP = secretScan.SCAN_SIZE_CAP;

/**
 * Most files read in one check, and the most bytes read across them.
 *
 * `SCAN_SIZE_CAP` bounds a single file; nothing bounded the count. This runs
 * synchronously on the server's event loop, and the evidence behind this
 * sprint is that dirty trees are the norm — `--untracked-files=all` enumerates
 * every untracked file, so a tree with thousands of them would stall every
 * other session's traffic while one wrap reads them all. Past either budget
 * the remaining candidates are skipped with a stated reason, the same as a
 * binary or oversized file: a skip is visible and honest, a stalled server is
 * neither. Both are deliberately far above any hand-maintained tree.
 */
const MAX_SCAN_FILES = 2000;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * Bytes read to decide whether a file is text. Exactly what
 * `secretScan.looksLikeText` samples, so sniffing a prefix gives the same
 * verdict as sniffing the whole file at a fraction of the read.
 */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Most skipped files named in one activity row. A tree full of images would
 * otherwise write a row the size of the tree on every wrap; the count is kept.
 */
const MAX_SKIPPED_IN_ACTIVITY = 50;

/** Activity event type for a wrap's secret-check outcome. */
const EVENT_TYPE = 'wrap.secret_scan';

/**
 * Scan one repo-relative path.
 *
 * @param {string} root - Absolute repo toplevel the path is relative to.
 * @param {string} rel - Repo-root-relative path.
 * @returns {{state:'clean', bytes:number}|{state:'gone'}|{state:'flagged', rules:string[], bytes:number}|{state:'skipped', reason:string, bytes?:number}}
 *   `bytes` is what was read, so a caller can hold a total-bytes budget. A
 *   skip carries it too when the read had already happened (a binary sniffed,
 *   or a body that failed after its head was read); a skip decided from lstat
 *   alone omits it.
 */
function scanFile(root, rel) {
  const abs = path.join(root, rel);
  let st;
  try {
    st = _internal.lstat(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'gone' };
    return { state: 'skipped', reason: `could not be read (${(err && err.code) || 'error'}), so it was not scanned` };
  }
  if (st.isSymbolicLink()) {
    return { state: 'skipped', reason: 'a symbolic link: git commits the link, not the file it points to, so it was not scanned' };
  }
  if (!st.isFile()) return { state: 'skipped', reason: 'not a regular file, so it was not scanned' };
  if (st.size > SCAN_SIZE_CAP) {
    return { state: 'skipped', reason: `larger than ${SCAN_SIZE_CAP / (1024 * 1024)} MB (${st.size} bytes), so it was not scanned` };
  }
  if (st.size === 0) return { state: 'clean', bytes: 0 };
  // Decide binary from a prefix, not the whole file. `looksLikeText` never
  // samples past BINARY_SNIFF_BYTES, so the verdict is identical — but reading
  // the file first meant a tree full of images was read end to end before
  // being skipped, which is the stall the budgets exist to prevent.
  let head;
  try {
    head = _internal.readPrefix(abs, Math.min(st.size, BINARY_SNIFF_BYTES));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'gone' };
    return { state: 'skipped', reason: `could not be read (${(err && err.code) || 'error'}), so it was not scanned`, bytes: 0 };
  }
  if (head.length === 0) return { state: 'clean', bytes: 0 };
  if (!secretScan.looksLikeText(head)) {
    // The prefix was still read, so it counts against the byte budget.
    return { state: 'skipped', reason: 'looks binary, so it was not scanned', bytes: head.length };
  }
  let buffer = head;
  if (st.size > head.length) {
    try {
      buffer = _internal.readFile(abs);
    } catch (err) {
      if (err && err.code === 'ENOENT') return { state: 'gone' };
      return { state: 'skipped', reason: `could not be read (${(err && err.code) || 'error'}), so it was not scanned`, bytes: head.length };
    }
  }
  if (buffer.length === 0) return { state: 'clean', bytes: 0 };
  const result = secretScan.scanText(buffer.toString('utf8'));
  return result.flagged
    ? { state: 'flagged', rules: result.types, bytes: buffer.length }
    : { state: 'clean', bytes: buffer.length };
}

/**
 * Words naming the matched rules, for the drawer.
 *
 * @param {string[]} rules - Rule types from `scanText`.
 * @returns {string}
 */
function _rulesPhrase(rules) {
  return `matches the secret rule${rules.length === 1 ? '' : 's'} ${rules.join(', ')} (the matched text is not shown)`;
}

/**
 * Scan the files a classification would commit or ask about, and apply the
 * operator's decisions to the files that match.
 *
 * @param {string|null} root - Absolute repo toplevel; null means nothing can be read.
 * @param {ReturnType<import('./_file-ownership').classify>} classified - From `ownership.classify`.
 * @param {Object<string, string>} decisions - Sanitized `{[path]: 'include'|'leave'}`.
 * @param {{maxFiles?: number, maxBytes?: number}} [budget] - Overrides the read
 *   budget; the defaults are {@link MAX_SCAN_FILES} and {@link MAX_SCAN_BYTES}.
 *   Tests use it to reach the limit without writing thousands of files.
 * @returns {{
 *   classified: object,
 *   undecided: Array<{path:string, reason:string, why:string, deleted:boolean, secretRules?:string[]}>,
 *   foreignUndecided: Array<object>,
 *   secretUndecided: Array<object>,
 *   report: {scannedCount:number, flagged:Array<{path:string, rules:string[], decision:string}>,
 *     skipped:Array<{path:string, reason:string}>, left:string[]}
 * }} `classified` is a copy with every flagged-and-left path removed from what
 *   may be staged. `undecided` is the whole list the drawer should ask about:
 *   foreign files still without a decision (with the rules named where one
 *   matched) followed by flagged files the wrap would otherwise commit.
 */
function check(root, classified, decisions, budget) {
  const d = decisions && typeof decisions === 'object' ? decisions : {};
  const maxFiles = budget && Number.isFinite(budget.maxFiles) ? budget.maxFiles : MAX_SCAN_FILES;
  const maxBytes = budget && Number.isFinite(budget.maxBytes) ? budget.maxBytes : MAX_SCAN_BYTES;
  const candidates = [];
  const seen = new Set();
  for (const p of [...classified.stageable, ...classified.foreign.map((f) => f.path)]) {
    if (!seen.has(p)) { seen.add(p); candidates.push(p); }
  }

  const flagged = [];
  const skipped = [];
  const rulesByPath = new Map();
  let scannedCount = 0;
  // Candidates the loop reached, whatever the outcome — the budget measures
  // work done, not files that turned out to be scannable. A skip decided from
  // lstat alone (symlink, over-cap, not a regular file) opens nothing and
  // still counts; that overcounts, which only stops the loop sooner.
  let filesRead = 0;
  let bytesRead = 0;
  if (root) {
    for (const p of candidates) {
      if (filesRead >= maxFiles || bytesRead >= maxBytes) {
        skipped.push({
          path: p,
          reason: `the wrap stopped scanning after ${filesRead} files (${bytesRead} bytes), so it was not scanned`
        });
        continue;
      }
      const r = scanFile(root, p);
      // Every read counts against the budget, including one that ended in a
      // skip: sniffing a binary still costs a read, and a tree full of them
      // was the case the budget exists for.
      bytesRead += r.bytes || 0;
      if (r.state === 'gone') continue;
      if (r.state === 'skipped') {
        skipped.push({ path: p, reason: r.reason });
        filesRead += 1;
        continue;
      }
      scannedCount += 1;
      filesRead += 1;
      if (r.state === 'flagged') rulesByPath.set(p, r.rules);
    }
  }

  const decisionOf = (p) => (Object.prototype.hasOwnProperty.call(d, p) ? d[p] : null);
  const foreignUndecidedSet = new Set(classified.undecided.map((f) => f.path));
  const withheld = new Set();
  const commitCandidatesAsked = [];
  for (const [p, rules] of rulesByPath) {
    const decision = decisionOf(p);
    flagged.push({ path: p, rules, decision: decision || 'undecided' });
    if (decision === ownership.DECISIONS.LEAVE) withheld.add(p);
    else if (decision !== ownership.DECISIONS.INCLUDE && !foreignUndecidedSet.has(p)) {
      withheld.add(p);
      commitCandidatesAsked.push({
        path: p,
        reason: 'secret-flagged',
        why: `the wrap would commit it, and it ${_rulesPhrase(rules)}`,
        deleted: false,
        secretRules: rules
      });
    }
  }

  const foreignUndecided = classified.undecided.map((f) => {
    const rules = rulesByPath.get(f.path);
    return rules ? { ...f, why: `${f.why}; it also ${_rulesPhrase(rules)}`, secretRules: rules } : f;
  });
  const secretUndecided = [...foreignUndecided.filter((f) => f.secretRules), ...commitCandidatesAsked];

  const keep = (p) => !withheld.has(p);
  const owned = classified.owned.filter(keep);
  const included = classified.included.filter(keep);
  const tangleclawMaintenance = classified.tangleclawMaintenance.filter(keep);
  return {
    classified: {
      ...classified,
      owned,
      included,
      tangleclawMaintenance,
      stageable: ownership.stageableOf({ owned, included, tangleclawMaintenance })
    },
    undecided: [...foreignUndecided, ...commitCandidatesAsked],
    foreignUndecided,
    secretUndecided,
    report: {
      scannedCount,
      flagged,
      skipped,
      left: flagged.filter((f) => f.decision === ownership.DECISIONS.LEAVE).map((f) => f.path)
    }
  };
}

/**
 * The blocker lines for a check that still needs decisions.
 *
 * @param {ReturnType<typeof check>} result - From {@link check}.
 * @returns {string[]}
 */
function blockerLines(result) {
  const lines = [];
  if (result.foreignUndecided.length > 0) lines.push(ownership.blockerLine(result.foreignUndecided));
  const n = result.secretUndecided.length;
  if (n > 0) {
    lines.push(`${n} file${n === 1 ? '' : 's'} the wrap would commit ${n === 1 ? 'matches' : 'match'} a secret pattern — choose Include or Leave for each before the wrap commits`);
  }
  return lines;
}

/**
 * The remediation text for a check that still needs decisions.
 *
 * @param {ReturnType<typeof check>} result - From {@link check}.
 * @returns {string}
 */
function remediation(result) {
  const parts = [];
  const plainForeign = result.foreignUndecided;
  if (plainForeign.length > 0) parts.push(ownership.remediation(plainForeign));
  if (result.secretUndecided.length > 0) {
    const listed = result.secretUndecided.map((f) => `  - ${f.path} (${(f.secretRules || []).join(', ')})`).join('\n');
    parts.push('These files match a pattern that looks like a credential, so the wrap will not commit them without asking. Only the rule that matched is shown, never the matched text:\n'
      + `${listed}\n`
      + 'Open each file and look. If it holds a real credential, remove it from the file, rotate the credential, then Retry: a file that no longer matches is committed as usual. '
      + 'Choose Include only when the match is not a real secret (a test fixture or a documented example). Leave keeps the file out of this commit and never discards anything.');
  }
  return parts.join('\n\n');
}

/**
 * A short phrase for a step's done-row detail, or null when there is nothing to say.
 *
 * @param {{flagged:Array<{decision:string}>, skipped:Array<object>}} report - `check(...).report`.
 * @returns {string|null}
 */
function detailPhrase(report) {
  const parts = [];
  const included = report.flagged.filter((f) => f.decision === ownership.DECISIONS.INCLUDE).length;
  const left = report.flagged.filter((f) => f.decision === ownership.DECISIONS.LEAVE).length;
  if (included) parts.push(`${included} secret match${included === 1 ? '' : 'es'} included by you`);
  if (left) parts.push(`${left} secret match${left === 1 ? '' : 'es'} left uncommitted`);
  const s = report.skipped.length;
  if (s) parts.push(`${s} file${s === 1 ? '' : 's'} not scanned for secrets (binary, too large or unreadable)`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Record a secret-check outcome: a log line and an activity row. Called only
 * when there is something to record. Carries paths and rule names, never text.
 *
 * @param {object} args
 * @param {object} [args.project] - Project record (`id`, `name`).
 * @param {object} [args.session] - Session record (`id`).
 * @param {string} args.stepId - The step that ran the check.
 * @param {boolean} args.blocked - Whether the step stopped for a decision.
 * @param {{flagged:Array<object>, skipped:Array<object>, scannedCount:number}} args.report - `check(...).report`.
 * @returns {void}
 */
function record({ project, session, stepId, blocked, report }) {
  const detail = {
    step: stepId,
    blocked,
    scannedCount: report.scannedCount,
    flagged: report.flagged.map((f) => ({ path: f.path, rules: f.rules, decision: f.decision })),
    skippedCount: report.skipped.length,
    skipped: report.skipped.slice(0, MAX_SKIPPED_IN_ACTIVITY)
  };
  if (report.flagged.length > 0) {
    log.warn('wrap found files matching a secret pattern', {
      project: project && project.name, step: stepId, blocked, flagged: detail.flagged
    });
  }
  _internal.logActivity({
    projectId: project ? project.id : null,
    sessionId: session ? session.id : null,
    eventType: EVENT_TYPE,
    detail
  });
}

const _internal = {
  lstat: (abs) => fs.lstatSync(abs),
  readFile: (abs) => fs.readFileSync(abs),
  /**
   * The first `n` bytes of a file, without reading the rest.
   * @param {string} abs - Absolute path.
   * @param {number} n - Bytes wanted.
   * @returns {Buffer} What was actually read, which may be shorter.
   */
  readPrefix: (abs, n) => {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(n);
      const read = fs.readSync(fd, buf, 0, n, 0);
      return buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  },
  // Never throws: `store.activity.log` swallows and no-ops without a database.
  logActivity: (event) => store.activity.log(event)
};

module.exports = {
  check,
  scanFile,
  blockerLines,
  remediation,
  detailPhrase,
  record,
  SCAN_SIZE_CAP,
  MAX_SCAN_FILES,
  MAX_SCAN_BYTES,
  EVENT_TYPE,
  _internal
};
