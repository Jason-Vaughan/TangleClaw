'use strict';

/*
 * #569 — the rule-proposal review widget in the wrap drawer.
 *
 * The wrap proposes rules from recurring learnings; this widget is where the
 * operator answers. The load-bearing properties pinned here:
 *
 *   1. The drawer actually renders it — a proposal the operator never sees is
 *      the silent loop #569 was filed about, one layer up.
 *   2. Decisions are API writes, not pipeline retries — approving a rule must
 *      never re-run the wrap (double commit).
 *   3. An edit is saved BEFORE approval flips status — approving un-saved text
 *      would activate a rule the operator never saw.
 *   4. Approval replays the wrap's cached operator password, and a 403 surfaces
 *      the password input instead of failing opaquely.
 *
 * session.js render functions are browser DOM code (not require()-able), so —
 * per the test/wrap-drawer-select-a11y.test.js convention — these are
 * source-level pins over the function bodies.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 * @param {string} src full source text
 * @param {string} decl the function declaration to find
 * @returns {string} the function body including its braces
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  assert.fail(`${decl} body must close`);
}

describe('#569 rule-proposal review widget (wrap drawer)', () => {
  let session, sessionCss;

  before(() => {
    const pub = path.resolve(__dirname, '..', 'public');
    session = fs.readFileSync(path.join(pub, 'session.js'), 'utf8');
    sessionCss = fs.readFileSync(path.join(pub, 'session.css'), 'utf8');
  });

  describe('the drawer renders the widget', () => {
    it('renderWrapDrawer wires ruleProposalWidget into the decision area', () => {
      const body = functionBody(session, 'function renderWrapDrawer(');
      assert.ok(/H\.ruleProposalWidget\(row, raw\.output\)/.test(body),
        'renderWrapDrawer must derive the widget from the step row');
      assert.ok(/renderRuleProposalWidget\(/.test(body),
        'renderWrapDrawer must render the derived widget');
    });

    it('proposal decisions are not a pipeline retry — the branch must not set warningOnly', () => {
      const body = functionBody(session, 'function renderWrapDrawer(');
      const branch = body.slice(body.indexOf("row.kind === 'rule-proposal'"));
      const branchEnd = branch.indexOf("decisionEl.classList.toggle");
      assert.ok(!/warningOnly = true/.test(branch.slice(0, branchEnd)),
        'rule-proposal must not enable the Retry path — a retry re-runs the wrap and double-commits');
    });
  });

  describe('the widget itself', () => {
    it('renders an editable textarea plus Approve and Reject per proposal', () => {
      const body = functionBody(session, 'function renderRuleProposalWidget(');
      assert.ok(/ta\.value = p\.content/.test(body), 'proposal text must be editable, prefilled');
      assert.ok(/wrap-proposal-approve/.test(body), 'approve button must render');
      assert.ok(/wrap-proposal-reject/.test(body), 'reject button must render');
    });

    it('is a labelled group with per-proposal accessible names (a11y)', () => {
      const body = functionBody(session, 'function renderRuleProposalWidget(');
      assert.ok(/list\.setAttribute\('role',\s*'group'\)/.test(body));
      assert.ok(/list\.setAttribute\('aria-labelledby',\s*groupLabelId\)/.test(body));
      assert.ok(/ta\.setAttribute\('aria-label'/.test(body),
        'each textarea needs its own accessible name');
    });

    it('carries a hidden password input for the 403 recovery path', () => {
      const body = functionBody(session, 'function renderRuleProposalWidget(');
      assert.ok(/wrap-proposal-password hidden/.test(body),
        'password group must start hidden — it only appears when the server refuses');
    });
  });

  describe('resolving a proposal', () => {
    it('approve saves a text edit BEFORE flipping status', () => {
      const body = functionBody(session, 'async function resolveRuleProposal(');
      const contentPut = body.indexOf("'PUT', { content: edited }");
      const statusPut = body.indexOf('/status`');
      assert.ok(contentPut !== -1, 'approve must PUT the edited content');
      assert.ok(statusPut !== -1, 'approve must PUT the status');
      assert.ok(contentPut < statusPut,
        'the edit must be saved before approval — approving un-saved text activates a rule the operator never saw');
    });

    it('a failed edit-save aborts the approval', () => {
      const body = functionBody(session, 'async function resolveRuleProposal(');
      const failBranch = body.slice(body.indexOf('Couldn’t save your edit'));
      assert.ok(/Nothing was approved/.test(failBranch.slice(0, 200)),
        'the operator must be told the approval did not proceed');
      assert.ok(/return;/.test(failBranch.slice(0, 300)),
        'the approve flow must stop when the edit could not be saved');
    });

    it('approve replays the cached wrap password, preferring a freshly typed one', () => {
      const body = functionBody(session, 'async function resolveRuleProposal(');
      assert.ok(/passwordInput && passwordInput\.value\) \|\| currentWrapPassword/.test(body));
    });

    it('a 403 reveals the password input instead of failing opaquely', () => {
      const body = functionBody(session, 'async function resolveRuleProposal(');
      assert.ok(/lastErrorCode === 'FORBIDDEN'/.test(body));
      assert.ok(/passwordGroup\.classList\.remove\('hidden'\)/.test(body));
    });

    it('reject needs no password and is recorded, not deleted', () => {
      const body = functionBody(session, 'async function resolveRuleProposal(');
      const rejectCall = body.match(/\{ status: 'rejected' \}/);
      assert.ok(rejectCall, 'reject must PUT status rejected — the record is what prevents re-proposal');
    });

    it('an empty edited rule cannot be approved', () => {
      const body = functionBody(session, 'async function resolveRuleProposal(');
      assert.ok(/Rule text can’t be empty/.test(body));
    });
  });

  describe('session.css', () => {
    it('styles the widget with 44px touch targets (mobile-first)', () => {
      assert.match(sessionCss, /\.wrap-proposal-row\s*\{/);
      assert.match(sessionCss, /\.wrap-proposal-actions \.btn\s*\{[^}]*min-height:\s*44px/);
      assert.match(sessionCss, /\.wrap-proposal-password-input\s*\{[^}]*min-height:\s*44px/);
    });

    it('a decided row hides its actions — the decision is one-shot in this render', () => {
      assert.match(sessionCss, /\.wrap-proposal-row--decided \.wrap-proposal-actions\s*\{\s*display:\s*none/);
    });
  });
});
