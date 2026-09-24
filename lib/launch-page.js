'use strict';

/**
 * How one page of a launch step is printed in a pane (Train 21).
 *
 * Shared by `bin/tc` (which prints pages) and the server (which sizes pages so
 * that a printed page fits the engine's tool-output limit). The server measures
 * the footer this module renders instead of estimating it, so the two cannot
 * drift apart.
 *
 * Store-free on purpose: `lib/tc-verbs.js` requires it, and anything that loads
 * the store would print node:sqlite's ExperimentalWarning on every `tc` call.
 * `lib/launch-preflight.js` is a pure evaluator with no requires of its own, so
 * taking the verdict vocabulary from it costs nothing and keeps the widest
 * recovery notice measured against the real words rather than a copied bound.
 *
 * @module lib/launch-page
 */

const { VERDICTS } = require('./launch-preflight');

/**
 * The line printed above a page that starts part-way through a paragraph.
 * @type {string}
 */
const CONTINUED_MARKER = '(continued)';

/**
 * Why a snapshot was re-rendered at a new revision, as the pane is told.
 *
 * The vocabulary lives here, with the renderer that prints it, because
 * `pageOverhead` has to size a page against the LONGEST of these: a page is
 * paginated to a budget frozen at creation, so a notice added at serve time
 * must already be inside that budget or the page it decorates can overflow the
 * engine's tool-output limit. A reason added without this constant is a reason
 * nothing budgeted for.
 * @type {{RULES_CHANGED: string}}
 */
const REVISION_REASONS = Object.freeze({ RULES_CHANGED: 'rules changed' });

/**
 * The notice printed above the task step when a launch is in ADVISORY recovery.
 *
 * It names the verdict and nothing else of the preflight's: the full reason is
 * step 3's, which this session has already been served, and reprinting it here
 * would put a free-form string inside a page whose budget was frozen at launch.
 * The verdict is a word from a closed set, so `pageOverhead` can measure the
 * widest one this can ever be — which is what keeps a decorated page inside the
 * engine's tool-output limit.
 * @param {string} verdict - The preflight verdict that demanded recovery
 * @param {number} recoveryRevision - The recovery revision this notice describes
 * @returns {string}
 */
function recoveryNotice(verdict, recoveryRevision) {
  return `[recovery required — the launch preflight returned \`${verdict}\`, which means this project's `
    + 'handoff state needs reconciling before this session builds on it. This project clears recovery in '
    + 'ADVISORY mode, so the task step is served, but `tc start ready` will refuse this launch until you '
    + `attest with a written reconciliation (recovery revision ${recoveryRevision})]`;
}

/**
 * Render one `tc.launch/1` envelope as pane text.
 *
 * The content is printed as served. The footer says where the page sits and
 * what to run next: the acknowledgement command on a step's last page, the
 * next-page command otherwise.
 * @param {object} envelope - A `tc.launch/1` envelope from `POST /api/tc/start/next`
 * @returns {string}
 */
function renderPage(envelope) {
  if (!envelope.step) {
    return `${envelope.content}\n`;
  }
  const { step, page, revision, ack, revised, recovery } = envelope;
  const parts = [];
  // Above the content, not in the footer: an agent that read a page and stopped
  // at the ack line must not be able to miss that its earlier digests are dead.
  if (revised) {
    parts.push(`[snapshot revised to revision ${revised.revision} — ${revised.reason}; acknowledgements and digests from earlier revisions are void]\n\n`);
  }
  // Above the content for the same reason, and on every page of the step rather
  // than only the first: a paginated task step read from page 1 onwards would
  // otherwise carry no sign that the launch is in recovery at all.
  if (recovery) {
    parts.push(`${recoveryNotice(recovery.verdict, recovery.recoveryRevision)}\n\n`);
  }
  if (page.continued) parts.push(`${CONTINUED_MARKER}\n`);
  parts.push(envelope.content);
  if (!envelope.content.endsWith('\n')) parts.push('\n');
  parts.push('---\n');
  parts.push(`[tc start · step ${step.index + 1}/${step.of} ${step.id} · page ${page.index + 1}/${page.of} · revision ${revision}]\n`);
  if (ack) {
    parts.push(`When you have read this step, acknowledge it: ${ack.command}\n`);
  } else {
    parts.push('Next page: tc start next\n');
  }
  return parts.join('');
}

/**
 * The acknowledgement command for a step.
 * @param {string} stepId - The step's id
 * @param {number} revision - The snapshot revision
 * @param {string} digest - The step's digest
 * @returns {string}
 */
function ackCommand(stepId, revision, digest) {
  return `tc start next --ack ${stepId}:${revision}:${digest}`;
}

/**
 * The command that re-reads one page of an attested launch.
 *
 * Page 0 is left off the command: it is the default, and the shorter form is
 * the one an agent is likelier to type correctly from memory.
 * @param {string} stepId - The step's id
 * @param {number} page - The page, from 0
 * @returns {string}
 */
function reviewCommand(stepId, page) {
  return page > 0 ? `tc start review --step ${stepId} --page ${page}` : `tc start review --step ${stepId}`;
}

/**
 * The banner printed above every page `tc start review` serves.
 *
 * On every page rather than the first: a session that jumps straight to
 * `--step task` is the one most likely to read the resume instructions there
 * as a fresh order to propose, and it must meet the "this is not a new launch"
 * line before that text.
 * @param {string} readyAt - When the launch attested READY
 * @returns {string}
 */
function reviewBanner(readyAt) {
  return `[read-only re-read of the launch context this session attested READY at ${readyAt}. This is not a `
    + 'new launch: do not re-attest and do not re-emit the resume proposal. Every rule and confirmation gate '
    + 'below is still binding. The state step reflects launch time; check freshness again before acting on it.]';
}

/**
 * Render one `tc.launch-review/1` envelope as pane text.
 *
 * Nothing here offers an acknowledgement: a review takes none, and printing an
 * ack command would invite the agent to advance a sequence that has already
 * finished.
 * @param {object} envelope - A `tc.launch-review/1` envelope from `GET /api/tc/start/review`
 * @returns {string}
 */
function renderReviewPage(envelope) {
  const { step, page, revision, review, nextRef } = envelope;
  const parts = [`${reviewBanner(review.readyAt)}\n\n`];
  if (page.continued) parts.push(`${CONTINUED_MARKER}\n`);
  parts.push(envelope.content);
  if (!envelope.content.endsWith('\n')) parts.push('\n');
  parts.push('---\n');
  parts.push(`[tc start review · step ${step.index + 1}/${step.of} ${step.id} · page ${page.index + 1}/${page.of} · revision ${revision} · read-only]\n`);
  parts.push(nextRef
    ? `Next page: ${nextRef.command}\n`
    : 'End of the attested launch context. Nothing was acknowledged or changed.\n');
  return parts.join('');
}

/**
 * The most characters `renderPage` adds around a page's content.
 *
 * Measured by rendering the widest page the protocol can produce: a continued
 * page with an acknowledgement, the longest step id, page numbers and a
 * revision far beyond any real sequence, and a full-length digest.
 * @returns {number}
 */
function pageOverhead() {
  const longestReason = Object.values(REVISION_REASONS)
    .reduce((longest, reason) => (reason.length > longest.length ? reason : longest), '');
  // Read from the verdict vocabulary rather than written down here: a verdict
  // added to the preflight widens this by construction, where a copied bound
  // would keep measuring the set that existed when someone last looked.
  const longestVerdict = Object.values(VERDICTS)
    .reduce((longest, verdict) => (verdict.length > longest.length ? verdict : longest), '');
  const widest = {
    step: { index: 3, id: 'governance', of: 4 },
    page: { index: 998, of: 999, continued: true },
    revision: 999999,
    content: '',
    ack: { command: ackCommand('governance', 999999, 'f'.repeat(16)) },
    revised: { code: 'SNAPSHOT_REVISED', reason: longestReason, revision: 999999 },
    recovery: { verdict: longestVerdict, recoveryRevision: 999999 }
  };
  // A review re-serves the same frozen pages under its own banner, so the
  // budget those pages were cut to must cover whichever decoration is wider.
  const widestReview = {
    step: { index: 3, id: 'governance', of: 4 },
    page: { index: 998, of: 999, continued: true },
    revision: 999999,
    content: '',
    review: { readyAt: '9999-12-31 23:59:59' },
    nextRef: { command: reviewCommand('governance', 998) }
  };
  // The empty content already draws the newline a content without a trailing
  // one gets, so each length is the whole addition.
  return Math.max(renderPage(widest).length, renderReviewPage(widestReview).length);
}

module.exports = {
  renderPage,
  renderReviewPage,
  reviewBanner,
  ackCommand,
  reviewCommand,
  pageOverhead,
  recoveryNotice,
  CONTINUED_MARKER,
  REVISION_REASONS
};
