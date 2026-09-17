'use strict';

/**
 * How one page of a launch step is printed in a pane (Train 21).
 *
 * Shared by `bin/tc` (which prints pages) and the server (which sizes pages so
 * that a printed page fits the engine's tool-output limit). The server measures
 * the footer this module renders instead of estimating it, so the two cannot
 * drift apart.
 *
 * Dependency-free on purpose: `lib/tc-verbs.js` requires it, and anything that
 * loads the store would print node:sqlite's ExperimentalWarning on every `tc`
 * call.
 *
 * @module lib/launch-page
 */

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
  const { step, page, revision, ack, revised } = envelope;
  const parts = [];
  // Above the content, not in the footer: an agent that read a page and stopped
  // at the ack line must not be able to miss that its earlier digests are dead.
  if (revised) {
    parts.push(`[snapshot revised to revision ${revised.revision} — ${revised.reason}; acknowledgements and digests from earlier revisions are void]\n\n`);
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
  const widest = {
    step: { index: 3, id: 'governance', of: 4 },
    page: { index: 998, of: 999, continued: true },
    revision: 999999,
    content: '',
    ack: { command: ackCommand('governance', 999999, 'f'.repeat(16)) },
    revised: { code: 'SNAPSHOT_REVISED', reason: longestReason, revision: 999999 }
  };
  // The empty content already draws the newline a content without a trailing
  // one gets, so this length is the whole addition.
  return renderPage(widest).length;
}

module.exports = { renderPage, ackCommand, pageOverhead, CONTINUED_MARKER, REVISION_REASONS };
