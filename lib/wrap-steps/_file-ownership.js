'use strict';

/**
 * Which uncommitted files a wrap may commit (#1406).
 *
 * The commit step used to run `git add -A`, which commits every uncommitted file
 * in the tree. The operator's own half-finished work, and a co-resident session's
 * work, went into a commit whose subject says "Session wrap", where nobody looks
 * for it. This module sorts the tree's uncommitted paths into three kinds:
 *
 * - **owned** — changed since this session launched, or written by the wrap
 *   itself to a file that was not already uncommitted at launch. Committed
 *   without asking.
 * - **foreign** — already uncommitted when the session launched, or not provably
 *   this session's. Committed only when the operator says `include`, and left
 *   uncommitted when they say `leave`. A foreign path with no decision blocks the
 *   wrap until the operator decides; see the `session-files` step.
 *
 * **How "since launch" is judged.** When the session's launch baseline has a
 * complete dirty set for this same tree, a path is foreign exactly when it was in
 * that set. Otherwise (a worktree the session moved into, a session launched
 * before baselines existed, or a dirty set too large to record in full) a path is
 * owned when its modification time is at or after the session's start. A
 * deletion has no file time to read, so without a snapshot it is foreign.
 *
 * **TangleClaw's own paths are judged first** (#1508, #1509), by
 * `_tc-owned-paths.js`, and never reach the rules above: machine state is
 * neither committed nor asked about, and a tracked file whose change is provably
 * TangleClaw's is committed as maintenance. Without this, one TangleClaw write
 * that missed a commit made its file "already uncommitted at launch" in every
 * later session, and the wrap asked about it on every wrap.
 *
 * Known limit: a co-resident session's edit made AFTER this session launched
 * looks like this session's change. The drawer says "changed since this session
 * launched", never "yours", for that reason.
 */

const fs = require('node:fs');
const path = require('node:path');
const tcOwned = require('./_tc-owned-paths');

/** Why a path is foreign, in words the drawer shows the operator. */
const FOREIGN_REASONS = Object.freeze({
  'dirty-at-launch': 'already uncommitted when this session launched',
  'predates-launch': 'last changed before this session launched',
  'unknown-deletion': 'deleted, and there is no launch record to show when',
  'unknown-start': 'no record of when this session started',
  'unreadable-time': 'its change time could not be read'
});

/** The two decisions an operator can make about a foreign path. */
const DECISIONS = Object.freeze({ INCLUDE: 'include', LEAVE: 'leave' });

/**
 * The argv that lists uncommitted paths the way the launch baseline recorded
 * them: repo-root-relative, every untracked file listed on its own.
 *
 * @returns {string[]} Argv after `git`.
 */
function statusArgs() {
  return ['status', '--porcelain', '-z', '--untracked-files=all'];
}

/**
 * Parse porcelain `-z` output into entries that remember whether the path is gone.
 *
 * @param {string} stdout - Raw `-z` output.
 * @returns {Array<{path:string, deleted:boolean}>} One entry per path; a rename
 *   contributes its new name and its old name (the old one deleted).
 */
function parseStatus(stdout) {
  const fields = String(stdout || '').split('\0');
  const out = [];
  const seen = new Set();
  const add = (p, deleted) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push({ path: p, deleted });
  };
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    add(entry.slice(3), xy.includes('D'));
    if (xy[0] === 'R' || xy[0] === 'C') {
      i += 1;
      add(fields[i], xy[0] === 'R');
    }
  }
  return out;
}

/**
 * Sort uncommitted paths into owned and foreign, and apply the operator's decisions.
 *
 * @param {object} scope - The wrap run's scope (`lib/wrap-scope.js`): reads
 *   `snapshotApplies`, `baseline.dirty.paths`, `startedAtMs`, `workToplevel`.
 * @param {Array<{path:string, deleted:boolean}>} dirty - From {@link parseStatus}.
 * @param {object} [options]
 * @param {Iterable<string>} [options.wrapWritten] - Repo-root-relative paths the
 *   wrap itself wrote this run. Owned unless the launch snapshot shows the file
 *   was already uncommitted, which the operator decides.
 * @param {Object<string, string>} [options.decisions] - `{[path]: 'include'|'leave'}`.
 *   Only entries for paths this classification calls foreign are honored.
 * @param {(abs: string) => number|null} [options.mtimeMs] - Test seam.
 * @returns {{owned:string[], foreign:Array<{path:string, reason:string, why:string, deleted:boolean}>,
 *   included:string[], left:string[], undecided:Array<{path:string, reason:string, why:string, deleted:boolean}>,
 *   tangleclawMaintenance:string[], tangleclawState:string[], stageable:string[]}}
 *   `stageable` is `owned`, `included` and `tangleclawMaintenance` — exactly what
 *   the commit may stage. `tangleclawState` is never staged.
 */
function classify(scope, dirty, options = {}) {
  const wrapWritten = new Set(options.wrapWritten || []);
  const decisions = options.decisions && typeof options.decisions === 'object' ? options.decisions : {};
  const mtimeMs = options.mtimeMs || _mtimeMs;
  const launchDirty = scope && scope.snapshotApplies && scope.baseline && scope.baseline.dirty
    ? new Set(scope.baseline.dirty.paths)
    : null;
  const startedAtMs = scope && Number.isFinite(scope.startedAtMs) ? scope.startedAtMs : null;
  const root = scope && scope.workToplevel ? scope.workToplevel : null;

  const tcVerdicts = tcOwned.judge(root, dirty);
  const tangleclawMaintenance = [];
  const tangleclawState = [];
  const owned = [];
  const foreign = [];
  for (const entry of dirty) {
    const p = entry.path;
    const tcKind = tcVerdicts.get(p);
    if (tcKind === tcOwned.KINDS.STATE) { tangleclawState.push(p); continue; }
    if (tcKind === tcOwned.KINDS.MAINTENANCE) { tangleclawMaintenance.push(p); continue; }
    let reason = null;
    if (launchDirty) {
      // Checked BEFORE the wrap's own writes. A file that already held someone's
      // uncommitted edits stays theirs to decide even when a wrap step then
      // rewrites it (version-bump on CHANGELOG.md, features-toc on FEATURES.md):
      // committing it would commit those edits too, which is the sweep this
      // module exists to stop. A Leave therefore also leaves the wrap's change.
      if (launchDirty.has(p)) reason = 'dirty-at-launch';
    } else if (wrapWritten.has(p)) {
      // With no snapshot, the file time of a file the wrap just wrote is the
      // wrap's own, so it says nothing about who changed it before. It is the
      // session's — unless the operator was already asked about it (it predated
      // the session when `session-files` read the tree) and answered. An answer
      // wins: a Left file stays out even after a wrap step rewrites it.
      reason = Object.prototype.hasOwnProperty.call(decisions, p) ? 'predates-launch' : null;
    } else if (entry.deleted) {
      reason = 'unknown-deletion';
    } else if (startedAtMs === null || !root) {
      reason = 'unknown-start';
    } else {
      const m = mtimeMs(path.join(root, p));
      // SQLite records the start to the second, rounded down, so a file written in
      // the launch's own second counts as this session's — the launch itself
      // writes files in that second.
      if (m === null) reason = 'unreadable-time';
      else if (m < startedAtMs) reason = 'predates-launch';
    }
    if (reason) {
      foreign.push({ path: p, reason, why: FOREIGN_REASONS[reason], deleted: entry.deleted });
    } else {
      owned.push(p);
    }
  }

  const included = [];
  const left = [];
  const undecided = [];
  for (const f of foreign) {
    const d = Object.prototype.hasOwnProperty.call(decisions, f.path) ? decisions[f.path] : null;
    if (d === DECISIONS.INCLUDE) included.push(f.path);
    else if (d === DECISIONS.LEAVE) left.push(f.path);
    else undecided.push(f);
  }
  return {
    owned,
    foreign,
    included,
    left,
    undecided,
    tangleclawMaintenance,
    tangleclawState,
    stageable: [...owned, ...included, ...tangleclawMaintenance]
  };
}

/**
 * A file's modification time, or null when it cannot be read.
 *
 * @param {string} abs - Absolute path.
 * @returns {number|null}
 */
function _mtimeMs(abs) {
  try {
    return fs.lstatSync(abs).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The one-line blocker for paths awaiting a decision.
 *
 * @param {Array<{path:string}>} undecided - From {@link classify}.
 * @returns {string}
 */
function blockerLine(undecided) {
  const n = undecided.length;
  return `${n} uncommitted file${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} not changed by this session — choose Include or Leave for each before the wrap commits`;
}

/**
 * The remediation text for paths awaiting a decision, naming each and why.
 *
 * @param {Array<{path:string, why:string}>} undecided - From {@link classify}.
 * @returns {string}
 */
function remediation(undecided) {
  const listed = undecided.map((f) => `  - ${f.path} (${f.why})`).join('\n');
  return 'These files have uncommitted changes that this session did not make, so the wrap will not commit them without asking:\n'
    + `${listed}\n`
    + 'Choose Include to commit a file in this wrap, or Leave to keep it uncommitted where it is, then Retry. '
    + 'Leave never discards anything. A file you leave stays out of the commit even if a wrap step also changes it (for example the changelog or the Feature Index), and that change stays uncommitted with it. '
    + 'If another session is still working on a file, leave it.';
}

/**
 * Keep only well-formed decisions from an options bag that arrived over HTTP.
 *
 * @param {*} raw - `options.pathDecisions` as received.
 * @returns {Object<string, string>} `{[path]: 'include'|'leave'}`.
 */
function sanitizeDecisions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [p, d] of Object.entries(raw)) {
    if (typeof p === 'string' && p && (d === DECISIONS.INCLUDE || d === DECISIONS.LEAVE)) out[p] = d;
  }
  return out;
}

module.exports = {
  classify,
  parseStatus,
  statusArgs,
  sanitizeDecisions,
  blockerLine,
  remediation,
  FOREIGN_REASONS,
  DECISIONS
};
