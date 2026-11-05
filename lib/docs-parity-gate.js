'use strict';

/**
 * Docs/screenshot parity signal (#533): gate user-facing doc drift the way
 * `lib/changelog-fragments.js` + `scripts/changelog-fragment-gate.js` gate a
 * missing changelog entry — same shape (changed-file classification, a PR-
 * body escape line), different posture. The CHANGELOG gate fails CI; this
 * one never does. #533's acceptance is explicit: "non-blocking /
 * dismissible-with-reason (don't recreate the wrap-nagging failure mode)."
 * `scripts/docs-parity-gate.js` is the CLI entry point; this module holds
 * the pure judgment so it can be unit-tested without `gh`.
 *
 * A signal fires when a pull request touches a user-facing surface — a
 * route (`server.js`, `lib/routes/**`), a UI file (`public/**`), or a
 * changelog fragment whose type is user-visible (`added`/`changed`, the
 * same two CLAUDE.md's version-bump table calls minor-tier) — with no
 * matching touch to `README.md` or `docs/**`, and no `Docs: none <reason>`
 * escape line in the PR body. `dismissSignal` is the explicit, reasoned
 * acknowledgement a human (or, once wired, the wrap drawer — Slice 2,
 * `#2886`) records; this module does not persist it.
 *
 * @module lib/docs-parity-gate
 */

const { parseFragmentName } = require('./changelog-fragments');

/** Path prefixes that mean "a route" or "a UI file" for this gate's purposes. */
const USER_FACING_PREFIXES = Object.freeze(['public/', 'lib/routes/']);

/** Path prefixes/files that count as "docs were touched". */
const DOCS_PREFIXES = Object.freeze(['docs/']);
const DOCS_FILES = Object.freeze(['README.md']);

/** Changelog fragment types CLAUDE.md's version-bump table treats as user-visible. */
const USER_FACING_FRAGMENT_TYPES = Object.freeze(['added', 'changed']);

/** The escape line: `Docs: none` at line start, the reason on the same line. Mirrors `Changelog: none`. */
const ESCAPE_LINE_RE = /^Docs: none([^\n]*)$/m;

/**
 * Whether a changed path is a route or a UI file.
 * @param {string} p - Repo-relative path.
 * @returns {boolean}
 */
function isUserFacingPath(p) {
  return p === 'server.js' || USER_FACING_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Whether a changed path counts as a docs touch.
 * @param {string} p - Repo-relative path.
 * @returns {boolean}
 */
function isDocsPath(p) {
  return DOCS_FILES.includes(p) || DOCS_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * The fragment type of a changed `changelog.d/` path, when it both parses
 * and is one this gate treats as user-visible — null otherwise, including
 * for a malformed name: this gate signals on user-facing drift, it does not
 * duplicate `scripts/changelog-fragment-gate.js`'s naming judgment.
 * @param {string} p - Repo-relative path.
 * @returns {string|null}
 */
function userFacingFragmentType(p) {
  const prefix = 'changelog.d/';
  if (!p.startsWith(prefix)) return null;
  const parsed = parseFragmentName(p.slice(prefix.length));
  return parsed.ok && USER_FACING_FRAGMENT_TYPES.includes(parsed.type) ? parsed.type : null;
}

/**
 * Judge a pull request's changed files and body against the parity signal.
 * Never refuses outright on content — always `ok: true` — because the
 * signal itself is non-blocking; only a genuinely unreadable input (the
 * caller's problem, not the PR's) is the CLI's concern, not this function's.
 *
 * @param {string[]} files - Changed paths, repo-relative.
 * @param {string} body - The PR body text.
 * @returns {{ok: true, signal: boolean, reason: string, userFacingFiles: string[],
 *   docsFiles: string[], userFacingFragments: Array<{path: string, type: string}>}}
 */
function evaluate(files, body) {
  const changed = (Array.isArray(files) ? files : []).filter((p) => typeof p === 'string' && p.length > 0);
  const userFacingFiles = changed.filter(isUserFacingPath);
  const docsFiles = changed.filter(isDocsPath);
  const userFacingFragments = changed
    .map((p) => ({ path: p, type: userFacingFragmentType(p) }))
    .filter((f) => f.type !== null);

  if (userFacingFiles.length === 0 && userFacingFragments.length === 0) {
    return {
      ok: true, signal: false, reason: 'touches no route, UI file, or user-visible changelog fragment; no docs touch asked for',
      userFacingFiles, docsFiles, userFacingFragments
    };
  }
  if (docsFiles.length > 0) {
    return {
      ok: true, signal: false, reason: `docs touched alongside the user-facing change: ${docsFiles.join(', ')}`,
      userFacingFiles, docsFiles, userFacingFragments
    };
  }
  const escape = ESCAPE_LINE_RE.exec(typeof body === 'string' ? body : '');
  if (escape) {
    const why = escape[1].trim();
    if (why.length > 0) {
      return {
        ok: true, signal: false, reason: `escaped: Docs: none${escape[1]}`,
        userFacingFiles, docsFiles, userFacingFragments
      };
    }
  }
  return {
    ok: true, signal: true,
    reason: 'user-facing surface changed with no README.md/docs/ touch and no `Docs: none <reason>` escape line',
    userFacingFiles, docsFiles, userFacingFragments
  };
}

/**
 * Record an explicit, reasoned dismissal of a fired signal. Not persisted
 * here — this is the shape a caller (today: a human reading the CLI's
 * output; later: the wrap drawer, `#2886`) records the dismissal in,
 * mirroring the fleet's standing convention that a deferral is recorded
 * with its owner and reason, never self-approved by omission.
 * @param {object} verdict - A result from `evaluate` whose `signal` is `true`.
 * @param {object} input - `{by, reason}`. Both required, non-blank.
 * @returns {{ok: true, dismissed: true, dismissedBy: string, dismissedReason: string, dismissedAt: string}
 *   |{ok: false, code: string, message: string}}
 */
function dismissSignal(verdict, input) {
  if (!verdict || verdict.signal !== true) {
    return { ok: false, code: 'NOT_SIGNALED', message: 'There is no fired signal to dismiss.' };
  }
  const i = input || {};
  const by = typeof i.by === 'string' ? i.by.trim() : '';
  const reason = typeof i.reason === 'string' ? i.reason.trim() : '';
  if (!by) return { ok: false, code: 'INVALID_INPUT', message: 'by is required: who is dismissing this signal.' };
  if (!reason) return { ok: false, code: 'INVALID_INPUT', message: 'reason is required: why the docs touch is not needed.' };
  return { ok: true, ...verdict, dismissed: true, dismissedBy: by, dismissedReason: reason, dismissedAt: new Date().toISOString() };
}

/**
 * Screenshot staleness (#533 option 3): whether the screenshots on hand
 * predate the last commit that shipped a visual rebrand or new UI, so a
 * reader could be looking at a screenshot of a UI that no longer exists.
 * Pure comparison — the caller resolves both timestamps (a tag's date, a
 * tracked marker's date, `git log` output); this function talks to nothing.
 * @param {object} input - `{screenshotsAsOf, lastUiShipAt}`, each an ISO-8601
 *   timestamp or anything `Date.parse` accepts.
 * @returns {{stale: boolean, reason: string}}
 */
function checkScreenshotStaleness(input) {
  const i = input || {};
  const screenshotsAsOf = Date.parse(i.screenshotsAsOf);
  const lastUiShipAt = Date.parse(i.lastUiShipAt);
  if (!Number.isFinite(screenshotsAsOf) || !Number.isFinite(lastUiShipAt)) {
    return { stale: false, reason: 'screenshotsAsOf or lastUiShipAt is not a readable timestamp; nothing to compare' };
  }
  if (screenshotsAsOf >= lastUiShipAt) {
    return { stale: false, reason: `screenshots are as of ${i.screenshotsAsOf}, at or after the last UI ship (${i.lastUiShipAt})` };
  }
  return { stale: true, reason: `screenshots are as of ${i.screenshotsAsOf}, before the last UI ship (${i.lastUiShipAt})` };
}

module.exports = {
  USER_FACING_PREFIXES,
  DOCS_PREFIXES,
  DOCS_FILES,
  USER_FACING_FRAGMENT_TYPES,
  ESCAPE_LINE_RE,
  isUserFacingPath,
  isDocsPath,
  userFacingFragmentType,
  evaluate,
  dismissSignal,
  checkScreenshotStaleness
};
