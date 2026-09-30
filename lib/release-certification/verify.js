'use strict';

/**
 * The rules the `metrics` branch must obey, judged one commit at a time.
 *
 * The publisher writes the branch, but nothing stops someone with push rights
 * writing it too. This verifier is how anyone (the scheduled GitHub check,
 * release promotion, or a person) confirms that the history is one the
 * publisher could have produced, and so that the admissions it holds still
 * bind their manifest digests (ADR 0021):
 *
 * - only published certification documents change, and none is ever deleted;
 * - every changed document validates, and names the candidate its path names;
 * - an admission, once written, never changes by a byte;
 * - a scorecard matches its candidate's admission (digest, version, the
 *   thresholds it is judged by, required-check source), its `publishSeq`
 *   rises, its time never goes back, a terminal state never changes, and any
 *   other state change is one the transition table can reach;
 * - review or a pass shows its targets met: the target time and the PTY-use
 *   target, as the scorecard reports them;
 * - the timeline is internally consistent: the run starts no earlier than its
 *   admission, qualified time fits inside the time that elapsed since then,
 *   `elapsedMs` is the span the scorecard's own times give, transition lines
 *   never go back and fall between admission and the scorecard's `updatedAt`,
 *   and an acceptance comes no earlier than the review it accepts;
 * - a transition log is only appended to, starts with admission, and every
 *   line is a transition the table allows, chained from the one before;
 * - every changed scorecard agrees with its transition log's last state;
 * - the index agrees with every scorecard changed in the same commit, whether
 *   or not the index itself changed.
 *
 * What this does NOT establish: that a soak happened. Every time it judges is
 * one the publisher wrote, so the rules catch a history that contradicts
 * itself (72 qualified hours claimed a minute after admission), not one that
 * is consistent and invented. How long a run really took is bounded only by
 * the commit history's own record and by who can push to the branch.
 *
 * `verifyChange` is pure: it reads files through the two readers it is given,
 * so the same rules serve a git history, a test, or anything else holding two
 * trees. `verifyHistory` is the one part that runs git (read-only) to feed it.
 *
 * @module lib/release-certification/verify
 */

const { execFile } = require('node:child_process');
const sc = require('./scorecard');
const { STATES, isTerminal, transitionAllowed, reachable } = require('./codes');

/** Rule codes a violation carries. */
const RULES = Object.freeze({
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  DELETED: 'DELETED',
  INVALID_DOCUMENT: 'INVALID_DOCUMENT',
  WRONG_CANDIDATE: 'WRONG_CANDIDATE',
  ADMISSION_REWRITTEN: 'ADMISSION_REWRITTEN',
  SCORECARD_WITHOUT_ADMISSION: 'SCORECARD_WITHOUT_ADMISSION',
  SCORECARD_MISMATCH: 'SCORECARD_MISMATCH',
  SEQ_NOT_INCREASING: 'SEQ_NOT_INCREASING',
  TIME_BACKWARDS: 'TIME_BACKWARDS',
  TERMINAL_CHANGED: 'TERMINAL_CHANGED',
  ILLEGAL_STATE_CHANGE: 'ILLEGAL_STATE_CHANGE',
  UNEARNED_REVIEW: 'UNEARNED_REVIEW',
  TIMELINE_INCONSISTENT: 'TIMELINE_INCONSISTENT',
  EVENTS_REWRITTEN: 'EVENTS_REWRITTEN',
  EVENTS_BROKEN_CHAIN: 'EVENTS_BROKEN_CHAIN',
  EVENTS_ILLEGAL_TRANSITION: 'EVENTS_ILLEGAL_TRANSITION',
  EVENTS_SCORECARD_MISMATCH: 'EVENTS_SCORECARD_MISMATCH',
  INDEX_MISMATCH: 'INDEX_MISMATCH',
  MERGE_COMMIT: 'MERGE_COMMIT',
  NOT_REGULAR_FILE: 'NOT_REGULAR_FILE',
  HISTORY_UNREADABLE: 'HISTORY_UNREADABLE'
});


/**
 * Parse JSON, or null.
 * @param {string|null} text - Text
 * @returns {object|null} Parsed value
 */
function _json(text) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse a transition log into lines, or null when a line is not JSON.
 * @param {string|null} text - Log text
 * @returns {object[]|null} Parsed lines
 */
function _lines(text) {
  if (text === null) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const doc = _json(line);
    if (doc === null) return null;
    out.push(doc);
  }
  return out;
}

/**
 * Judge a changed admission.
 * @param {string} sha - Candidate named by the path
 * @param {object} ctx - `{prev, next, violation}`
 * @param {string} p - Path
 * @returns {void}
 */
function _admission(sha, ctx, p) {
  const before = ctx.prev(p);
  if (before !== null) {
    ctx.violation(RULES.ADMISSION_REWRITTEN, p);
    return;
  }
  const doc = _json(ctx.next(p));
  if (!doc || sc.validateAdmission(doc).length > 0) ctx.violation(RULES.INVALID_DOCUMENT, p);
  else if (doc.candidateSha !== sha) ctx.violation(RULES.WRONG_CANDIDATE, p);
}

/**
 * Judge a changed scorecard against its admission and its previous version.
 * @param {string} sha - Candidate named by the path
 * @param {object} ctx - `{prev, next, violation}`
 * @param {string} p - Path
 * @returns {void}
 */
function _scorecard(sha, ctx, p) {
  const doc = _json(ctx.next(p));
  if (!doc || sc.validateScorecard(doc).length > 0) return ctx.violation(RULES.INVALID_DOCUMENT, p);
  if (doc.candidateSha !== sha) return ctx.violation(RULES.WRONG_CANDIDATE, p);
  const admission = _json(ctx.next(sc.paths(sha).admission));
  if (!admission || sc.validateAdmission(admission).length > 0) return ctx.violation(RULES.SCORECARD_WITHOUT_ADMISSION, p);
  const t = admission.thresholds;
  if (doc.manifestDigest !== admission.manifestDigest || doc.version !== admission.version
    || doc.canonicalThresholds !== admission.canonicalThresholds || doc.requiredChecksSource !== admission.requiredChecksSource
    || doc.checksSource !== admission.checksSource
    || doc.targetMs !== t.targetQualifiedMs || doc.pty.target.attaches !== t.ptyMinAttaches
    || doc.pty.target.detaches !== t.ptyMinDetaches || doc.pty.target.spanMs !== t.ptyMinSpanMs) {
    ctx.violation(RULES.SCORECARD_MISMATCH, p);
  }
  if (!_earned(doc) && (doc.state === STATES.AWAITING_REVIEW || doc.state === STATES.PASSED)) ctx.violation(RULES.UNEARNED_REVIEW, p);
  const lines = _lines(ctx.next(sc.paths(sha).events));
  if (!_consistentTimeline(admission, doc, lines || [])) ctx.violation(RULES.TIMELINE_INCONSISTENT, p);
  if (!lines || lines.length === 0 || lines[lines.length - 1].to !== doc.state) ctx.violation(RULES.EVENTS_SCORECARD_MISMATCH, p);
  const before = _json(ctx.prev(p));
  if (!before) return undefined;
  if (!(doc.publishSeq > before.publishSeq)) ctx.violation(RULES.SEQ_NOT_INCREASING, p);
  if (doc.updatedAt < before.updatedAt) ctx.violation(RULES.TIME_BACKWARDS, p);
  if (isTerminal(before.state) && doc.state !== before.state) ctx.violation(RULES.TERMINAL_CHANGED, p);
  else if (!reachable(before.state, doc.state)) ctx.violation(RULES.ILLEGAL_STATE_CHANGE, p);
  return undefined;
}

/**
 * Whether a scorecard shows its targets met: the qualified time, and every
 * PTY-use minimum. Review, and so a pass, must be earned this way.
 * @param {object} doc - A valid scorecard
 * @returns {boolean} True when earned
 */
function _earned(doc) {
  const p = doc.pty;
  return doc.qualifiedMs >= doc.targetMs && p.met === true && p.attaches >= p.target.attaches
    && p.detaches >= p.target.detaches && p.spanMs >= p.target.spanMs;
}

/**
 * Whether a scorecard's times, and its transition log's, are consistent with
 * each other and with the admission. These are relations between published
 * numbers: they refuse a history that contradicts itself, and cannot tell a
 * consistent history from a real run.
 * @param {object} admission - A valid admission
 * @param {object|null} card - A valid scorecard, or null when none is published
 * @param {object[]} lines - Parsed transition lines (valid ones)
 * @returns {boolean} True when consistent
 */
function _consistentTimeline(admission, card, lines) {
  const from = admission.admittedAt;
  const until = card ? card.updatedAt : Infinity;
  const ordered = lines.every((l, i) => l.at >= from && l.at <= until && (i === 0 || l.at >= lines[i - 1].at));
  if (!ordered || !card) return ordered;
  const live = !isTerminal(card.state);
  const within = (rec) => rec === null || (rec.at >= card.startedAt && rec.at <= card.updatedAt);
  const review = [...lines].reverse().find((l) => l.to === STATES.AWAITING_REVIEW);
  return card.startedAt >= from
    && card.updatedAt >= card.startedAt
    && card.publishedAt >= card.updatedAt
    && card.elapsedMs === (live ? card.publishedAt : card.updatedAt) - card.startedAt
    && card.qualifiedMs <= card.elapsedMs
    && card.updatedAt - from >= card.qualifiedMs
    && (lines.length === 0 || lines[0].at === card.startedAt)
    && within(card.failure) && within(card.acceptance) && within(card.cancellation)
    && (card.acceptance === null || (review !== undefined && card.acceptance.at >= review.at));
}

/**
 * Judge a changed transition log.
 * @param {string} sha - Candidate named by the path
 * @param {object} ctx - `{prev, next, violation}`
 * @param {string} p - Path
 * @returns {void}
 */
function _events(sha, ctx, p) {
  const before = ctx.prev(p) || '';
  const after = ctx.next(p);
  if (!after.startsWith(before)) return ctx.violation(RULES.EVENTS_REWRITTEN, p);
  const lines = _lines(after);
  if (lines === null || lines.some((l) => sc.validateEvent(l).length > 0)) return ctx.violation(RULES.INVALID_DOCUMENT, p);
  const chained = lines.length > 0 && lines[0].from === STATES.NOT_STARTED
    && lines.every((l, i) => i === 0 || l.from === lines[i - 1].to);
  if (!chained) return ctx.violation(RULES.EVENTS_BROKEN_CHAIN, p);
  if (!lines.every((l) => transitionAllowed(l.from, l.to, l.code))) return ctx.violation(RULES.EVENTS_ILLEGAL_TRANSITION, p);
  const card = _json(ctx.next(sc.paths(sha).scorecard));
  if (card && card.state !== lines[lines.length - 1].to) ctx.violation(RULES.EVENTS_SCORECARD_MISMATCH, p);
  const admission = _json(ctx.next(sc.paths(sha).admission));
  if (admission && sc.validateAdmission(admission).length === 0) {
    const validCard = card && sc.validateScorecard(card).length === 0 ? card : null;
    if (!_consistentTimeline(admission, validCard, lines)) ctx.violation(RULES.TIMELINE_INCONSISTENT, p);
  }
  return undefined;
}

/**
 * Judge a changed index against the scorecards changed alongside it.
 * @param {string[]} changedShas - Candidates whose scorecard changed in this commit
 * @param {object} ctx - `{next, violation}`
 * @param {string} p - Path
 * @returns {void}
 */
function _index(changedShas, ctx, p) {
  const doc = _json(ctx.next(p));
  if (!doc || sc.validateIndex(doc).length > 0) return ctx.violation(RULES.INVALID_DOCUMENT, p);
  for (const sha of changedShas) {
    const card = _json(ctx.next(sc.paths(sha).scorecard));
    const entry = doc.candidates.find((c) => c.candidateSha === sha);
    if (!card || !entry || entry.state !== card.state || entry.updatedAt !== card.updatedAt || entry.version !== card.version) {
      ctx.violation(RULES.INDEX_MISMATCH, p);
    }
  }
  return undefined;
}

/**
 * Judge one commit: the change from one tree to the next.
 * @param {object} change
 * @param {string[]} change.changed - Paths added or modified
 * @param {string[]} change.deleted - Paths removed
 * @param {function(string): (string|null)} change.prev - Reads a file from the tree before
 * @param {function(string): (string|null)} change.next - Reads a file from the tree after
 * @returns {{rule: string, path: string}[]} Violations; empty when the commit is one the publisher could have made
 */
function verifyChange(change) {
  const violations = [];
  const ctx = { prev: change.prev, next: change.next, violation: (rule, p) => violations.push({ rule, path: p }) };
  for (const p of change.deleted) ctx.violation(RULES.DELETED, p);
  const allowed = change.changed.filter((p) => {
    if (sc.PUBLISHED_PATH.test(p)) return true;
    ctx.violation(RULES.PATH_NOT_ALLOWED, p);
    return false;
  });
  const cardShas = [];
  for (const p of allowed) {
    const doc = sc.parsePublishedPath(p);
    if (doc.kind === 'admission') _admission(doc.sha, ctx, p);
    else if (doc.kind === 'scorecard') {
      _scorecard(doc.sha, ctx, p);
      cardShas.push(doc.sha);
    } else if (doc.kind === 'events') _events(doc.sha, ctx, p);
  }
  // Checked whenever a scorecard changed, not only when the index did: a
  // scorecard updated under a stale index is exactly the drift to catch.
  if (allowed.includes(sc.INDEX_PATH) || cardShas.length > 0) _index(cardShas, ctx, sc.INDEX_PATH);
  return violations;
}

/**
 * Run git in a repository for the verifier: read-only, never prompting.
 * @param {string} repoDir - Repository
 * @param {string[]} args - Arguments
 * @returns {Promise<{code: number, stdout: string}>} Result; never rejects
 */
function _git(repoDir, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoDir, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr || '') });
    });
  });
}

/** Thrown inside a commit's judgement when git cannot read what it needs. */
class Unreadable extends Error {}

/**
 * Verify every commit on a branch, oldest first. A branch the publisher wrote
 * is linear, so a merge commit is itself a violation; the first commit is
 * judged against an empty tree.
 * @param {object} opts
 * @param {string} opts.repoDir - Repository holding the branch
 * @param {string} opts.ref - Branch or ref to verify (e.g. `origin/metrics`)
 * @param {function} [opts.git] - `(repoDir, args) => {code, stdout}` seam
 * @returns {Promise<{exists: boolean, commits: number, violations: {commit: string|null, rule: string, path: string|null, detail?: string|null}[]}>} Outcome; `detail` carries git's own error for an unreadable history
 */
async function verifyHistory(opts) {
  const git = opts.git || _git;
  const unreadable = (commit, err) => ({ commit, rule: RULES.HISTORY_UNREADABLE, path: null, detail: err.message || null });
  // A directory that is not a repository has not shown that the branch is
  // missing: it has shown nothing at all.

  const repo = await git(opts.repoDir, ['rev-parse', '--git-dir']);
  if (repo.code !== 0) return { exists: true, commits: 0, violations: [unreadable(null, new Error((repo.stderr || '').trim().slice(-300)))] };
  const listed = await git(opts.repoDir, ['rev-list', '--reverse', '--parents', opts.ref, '--']);
  if (listed.code !== 0) {
    // Missing is not the same as unreadable: only a ref git says does not
    // exist passes as "nothing published yet".
    const probe = await git(opts.repoDir, ['rev-parse', '--verify', '--quiet', `${opts.ref}^{commit}`]);
    if (probe.code !== 0) return { exists: false, commits: 0, violations: [] };
    return { exists: true, commits: 0, violations: [unreadable(null, new Error((listed.stderr || '').trim().slice(-300)))] };
  }
  const commits = listed.stdout.split('\n').filter(Boolean).map((l) => l.split(' '));
  const violations = [];
  // Absent and unreadable are different answers: a previous admission that
  // could not be read must not be judged as if it never existed.
  // An entry that is not a regular file (a symlink, a submodule, an
  // executable) is never something the publisher writes, and a clone that
  // checked one out could be pointed outside itself. It reads as absent, and
  // is a violation in the commit that adds or changes it.
  let irregular = [];
  const show = async (rev, p) => {
    const listed = await git(opts.repoDir, ['ls-tree', '--format=%(objectmode) %(objecttype)', rev, '--', p]);
    if (listed.code !== 0) throw new Unreadable((listed.stderr || '').trim().slice(-300));
    const kind = listed.stdout.trim();
    if (kind === '') return null;
    if (kind !== '100644 blob') {
      irregular.push({ rev, path: p });
      return null;
    }
    const r = await git(opts.repoDir, ['show', `${rev}:${p}`]);
    if (r.code !== 0) throw new Unreadable((r.stderr || '').trim().slice(-300));
    return r.stdout;
  };
  for (const [commit, ...parents] of commits) {
    if (parents.length > 1) {
      violations.push({ commit, rule: RULES.MERGE_COMMIT, path: null });
      continue;
    }
    const diffArgs = parents.length === 0
      ? ['diff-tree', '--root', '--no-renames', '--no-commit-id', '-r', '--name-status', '-z', commit]
      : ['diff-tree', '--no-renames', '--no-commit-id', '-r', '--name-status', '-z', parents[0], commit];
    const diff = await git(opts.repoDir, diffArgs);
    if (diff.code !== 0) {
      violations.push(unreadable(commit, new Error((diff.stderr || '').trim().slice(-300))));
      continue;
    }
    const fields = diff.stdout.split('\0').filter((f) => f !== '');
    const changed = [];
    const deleted = [];
    for (let i = 0; i + 1 < fields.length; i += 2) (fields[i] === 'D' ? deleted : changed).push(fields[i + 1]);
    irregular = [];
    const prevFiles = new Map();
    const nextFiles = new Map();
    const needed = new Set([...changed, sc.INDEX_PATH]);
    for (const p of changed) {
      const doc = sc.parsePublishedPath(p);
      if (doc && doc.sha) {
        const docs = sc.paths(doc.sha);
        needed.add(docs.admission);
        needed.add(docs.scorecard);
        needed.add(docs.events);
      }
    }
    try {
      for (const p of needed) {
        prevFiles.set(p, parents.length === 0 ? null : await show(parents[0], p));
        nextFiles.set(p, await show(commit, p));
      }
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err;
      violations.push(unreadable(commit, err));
      continue;
    }
    const found = verifyChange({
      changed, deleted,
      prev: (p) => (prevFiles.has(p) ? prevFiles.get(p) : null),
      next: (p) => (nextFiles.has(p) ? nextFiles.get(p) : null)
    });
    for (const v of found) violations.push({ commit, ...v });
    for (const p of new Set(irregular.filter((e) => e.rev === commit && changed.includes(e.path)).map((e) => e.path))) {
      violations.push({ commit, rule: RULES.NOT_REGULAR_FILE, path: p });
    }
  }
  return { exists: true, commits: commits.length, violations };
}

module.exports = { RULES, verifyChange, verifyHistory };
