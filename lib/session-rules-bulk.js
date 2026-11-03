'use strict';

/**
 * Delegated & bulk session-rule approvals (#2016, Architect Ruling A2016)
 * and in-place rule editing (#2396, Architect Ruling A2396) — core engine,
 * `v5.60.0` Car 60-B Slice 1, co-hosted in one file per both rulings'
 * own "Authorized Files" envelope.
 *
 * A pure authorization/decision library: every function takes the caller's
 * already-fetched proposal/rule records and the caller's own identity as
 * plain data, and returns the computed decision or edit result — nothing
 * here reads a database, verifies a session token, or touches a route.
 * Wiring this into `server.js`/`lib/routes/*.js` (which would resolve the
 * REAL caller identity and REAL stored rules) is Slice 2, deliberately
 * deferred so Car 60-B stays 100% file-disjoint from this wave's other
 * `v5.60.0` cars. This module trusts its caller to have already resolved
 * `caller.principal`/`caller.role`/`caller.id` honestly — the same
 * trust-boundary split `lib/permission-requests.js#decidePermissionRequest`
 * and `lib/bridge-confirmation.js#verifyAndConsumeConfirmation` document for
 * their own callers: proving identity is each trust boundary's own job.
 *
 * @module lib/session-rules-bulk
 */

const crypto = require('node:crypto');

/** Every `ruleApprovalMode` this module recognizes (#2016). */
const APPROVAL_MODES = Object.freeze(['operator-only', 'delegated-architect', 'delegated-pm', 'custom-delegate']);

/** The two decisions a proposal can receive. */
const DECISIONS = Object.freeze(['approve', 'reject']);

/** Fields {@link editRuleInPlace} may change; everything else about a rule
 *  (its `ruleId`/`number`, its version history) is preserved through an edit. */
const EDITABLE_FIELDS = Object.freeze(['title', 'body', 'category', 'scope', 'enabled']);

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * Whether `caller` is authorized to decide or edit a rule under
 * `approvalMode`. The operator may always act, in every mode — the modes
 * below only ever WIDEN who else may act beyond the operator, never narrow
 * the operator's own standing authority.
 * @param {string} approvalMode - One of {@link APPROVAL_MODES}
 * @param {{principal?: string, role?: string, id: string}} caller
 * @param {string[]} [delegateAllowlist] - Session identities allowlisted
 *   for `custom-delegate` mode, by `caller.id`
 * @returns {boolean}
 */
function _authorizedApprover(approvalMode, caller, delegateAllowlist) {
  if (!caller || typeof caller !== 'object') return false;
  if (caller.principal === 'operator') return true;
  switch (approvalMode) {
    case 'operator-only': return false;
    case 'delegated-architect': return caller.role === 'architect';
    case 'delegated-pm': return caller.role === 'pm';
    case 'custom-delegate': return Array.isArray(delegateAllowlist) && delegateAllowlist.includes(caller.id);
    default: return false;
  }
}

/**
 * Validate the common shape every function below needs: a recognized
 * `approvalMode` and a `caller` carrying at least an `id`.
 * @param {object} input
 * @returns {{ok: true}|{ok: false, code: string, message: string}}
 */
function _validateCallerShape(input) {
  if (!input || typeof input !== 'object') return _refuse('RULE_APPROVAL_INVALID', 'input must be an object.');
  if (!APPROVAL_MODES.includes(input.approvalMode)) {
    return _refuse('RULE_APPROVAL_INVALID', `"${input.approvalMode}" is not a recognized approval mode.`);
  }
  if (!input.caller || typeof input.caller !== 'object' || typeof input.caller.id !== 'string' || !input.caller.id) {
    return _refuse('RULE_APPROVAL_INVALID', 'input.caller must carry at least an "id".');
  }
  return { ok: true };
}

/**
 * Decide one pending session-rule proposal: authorize the caller under the
 * given approval mode, refuse self-approval outright, optionally check the
 * proposal has not drifted since the caller fetched it, and return the
 * decision record (#2016).
 * @param {object} input
 * @param {string} input.approvalMode - One of {@link APPROVAL_MODES}
 * @param {{principal?: string, role?: string, id: string}} input.caller
 * @param {object} input.proposal - `{id, authoredBy, status?, version?, digestSha256?}`
 * @param {string} input.decision - `'approve'` or `'reject'`
 * @param {string[]} [input.delegateAllowlist] - For `custom-delegate` mode
 * @param {number} [input.expectedVersion] - Reject with `RULE_APPROVAL_STALE`
 *   if `proposal.version` does not match
 * @param {string} [input.expectedDigestSha256] - Reject with
 *   `RULE_APPROVAL_STALE` if `proposal.digestSha256` does not match
 * @returns {{ok: true, result: object}|{ok: false, code: string, message: string}}
 */
function decideSessionRuleProposal(input) {
  const shape = _validateCallerShape(input);
  if (!shape.ok) return shape;
  if (!DECISIONS.includes(input.decision)) {
    return _refuse('RULE_APPROVAL_INVALID', `"${input.decision}" is not "approve" or "reject".`);
  }
  if (!input.proposal || typeof input.proposal !== 'object' || typeof input.proposal.id !== 'string' || !input.proposal.id) {
    return _refuse('RULE_APPROVAL_INVALID', 'input.proposal must carry at least an "id".');
  }
  // A2016 forbids self-approval, which this module can only enforce when it
  // knows who authored the proposal -- a missing/blank authoredBy is not "no
  // conflict found", it is "provenance unavailable", and fails closed rather
  // than silently letting a self-authored proposal through unchecked.
  if (typeof input.proposal.authoredBy !== 'string' || !input.proposal.authoredBy.trim()) {
    return _refuse('RULE_APPROVAL_INVALID', 'input.proposal.authoredBy must be a non-empty string.');
  }

  if (!_authorizedApprover(input.approvalMode, input.caller, input.delegateAllowlist)) {
    return _refuse('RULE_APPROVAL_UNAUTHORIZED',
      `Caller "${input.caller.id}" may not decide a rule proposal under approval mode "${input.approvalMode}".`);
  }
  // Checked AFTER authorization, never before: an unauthorized caller is
  // refused for that reason even if it also happens to be the author --
  // RULE_APPROVAL_UNAUTHORIZED is the more specific, actionable refusal.
  if (input.proposal.authoredBy && input.proposal.authoredBy === input.caller.id) {
    return _refuse('RULE_SELF_APPROVAL_FORBIDDEN',
      'A caller may never approve or reject its own proposal, even as a delegated approver.');
  }
  if (input.expectedVersion !== undefined && input.proposal.version !== input.expectedVersion) {
    return _refuse('RULE_APPROVAL_STALE',
      `Proposal "${input.proposal.id}" version drifted: expected ${input.expectedVersion}, found ${input.proposal.version}.`);
  }
  if (input.expectedDigestSha256 !== undefined && input.proposal.digestSha256 !== input.expectedDigestSha256) {
    return _refuse('RULE_APPROVAL_STALE', `Proposal "${input.proposal.id}" content digest drifted since it was fetched.`);
  }

  return {
    ok: true,
    result: {
      proposalId: input.proposal.id,
      decision: input.decision,
      approverPrincipal: input.caller.id,
      approvalMode: input.approvalMode,
      decidedAt: new Date().toISOString()
    }
  };
}

/**
 * Decide a batch of pending session-rule proposals under one approval mode
 * and one decision, atomically per item (#2016). A proposal already past
 * `pending` (an explicit `status` field naming anything else) is skipped,
 * not errored — it is not a failure, just nothing left to decide. Every
 * other refusal from {@link decideSessionRuleProposal} (unauthorized,
 * self-approval, stale) lands in `errors`, naming its own proposal id and
 * code, so a caller can retry only what actually failed.
 * @param {object} input
 * @param {string} input.approvalMode
 * @param {{principal?: string, role?: string, id: string}} input.caller
 * @param {object[]} input.proposals - Each optionally carrying its own
 *   `expectedVersion`/`expectedDigestSha256` for its own drift check
 * @param {string} input.decision - Applied to every item in the batch
 * @param {string[]} [input.delegateAllowlist]
 * @returns {{ok: true, summary: object}|{ok: false, code: string, message: string}}
 */
function bulkDecideSessionRuleProposals(input) {
  const shape = _validateCallerShape(input);
  if (!shape.ok) return shape;
  if (!Array.isArray(input.proposals)) {
    return _refuse('RULE_APPROVAL_INVALID', 'input.proposals must be an array.');
  }
  if (!DECISIONS.includes(input.decision)) {
    return _refuse('RULE_APPROVAL_INVALID', `"${input.decision}" is not "approve" or "reject".`);
  }

  const approved = [];
  const rejected = [];
  const skipped = [];
  const errors = [];
  for (const proposal of input.proposals) {
    const id = proposal && typeof proposal.id === 'string' ? proposal.id : null;
    if (proposal && proposal.status !== undefined && proposal.status !== 'pending') {
      skipped.push({ proposalId: id, reason: `status is "${proposal.status}", not "pending"` });
      continue;
    }
    const decided = decideSessionRuleProposal({
      approvalMode: input.approvalMode, caller: input.caller, decision: input.decision, proposal,
      delegateAllowlist: input.delegateAllowlist,
      expectedVersion: proposal && proposal.expectedVersion,
      expectedDigestSha256: proposal && proposal.expectedDigestSha256
    });
    if (!decided.ok) {
      errors.push({ proposalId: id, code: decided.code, message: decided.message });
      continue;
    }
    (input.decision === 'approve' ? approved : rejected).push(decided.result);
  }

  return {
    ok: true,
    summary: {
      approved, rejected, skipped, errors,
      approverPrincipal: input.caller.id,
      approvalMode: input.approvalMode,
      decidedAt: new Date().toISOString()
    }
  };
}

/**
 * Compute a SHA-256 content digest over a rule's editable fields, in a
 * fixed key order — the canonical form both {@link editRuleInPlace} and
 * whatever Slice 2 caller fetched the rule must agree on.
 * @param {{title: string, body: string, category: (string|null), scope: (string|null), enabled: boolean}} content
 * @returns {string}
 */
function _ruleContentDigest(content) {
  const canonical = JSON.stringify({
    title: content.title, body: content.body, category: content.category || null,
    scope: content.scope || null, enabled: content.enabled !== false
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Edit a rule in place: preserves its stable `ruleId`/`number` while
 * updating any of {@link EDITABLE_FIELDS}, under an optimistic concurrency
 * check and the same caller-authorization model {@link decideSessionRuleProposal}
 * uses (#2396).
 * @param {object} input
 * @param {string} input.approvalMode - One of {@link APPROVAL_MODES}
 * @param {{principal?: string, role?: string, id: string}} input.caller
 * @param {object} input.rule - The rule's current state: `{ruleId, number?,
 *   title, body, category, scope, enabled, version, digestSha256}`
 * @param {object} input.patch - One or more of {@link EDITABLE_FIELDS}
 * @param {number} [input.expectedVersion] - At least one of this or
 *   `expectedDigestSha256` is required
 * @param {string} [input.expectedDigestSha256]
 * @param {string} [input.reason] - Why, for the revision record
 * @returns {{ok: true, rule: object, revision: object}|{ok: false, code: string, message: string}}
 */
function editRuleInPlace(input) {
  const shape = _validateCallerShape(input);
  if (!shape.ok) return shape;
  if (!input.rule || typeof input.rule !== 'object'
    || (typeof input.rule.ruleId !== 'string' && typeof input.rule.number !== 'number')) {
    return _refuse('RULE_EDIT_INVALID', 'input.rule must carry a stable "ruleId" or "number".');
  }
  if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
    return _refuse('RULE_EDIT_INVALID', 'input.patch must be an object.');
  }
  const patchKeys = Object.keys(input.patch);
  if (patchKeys.length === 0 || !patchKeys.every((k) => EDITABLE_FIELDS.includes(k))) {
    return _refuse('RULE_EDIT_INVALID',
      `input.patch may only set ${EDITABLE_FIELDS.join(', ')}, and must set at least one.`);
  }
  if (input.patch.title !== undefined && (typeof input.patch.title !== 'string' || !input.patch.title.trim())) {
    return _refuse('RULE_EDIT_INVALID', 'patch.title must be a non-empty string.');
  }
  if (input.patch.body !== undefined && (typeof input.patch.body !== 'string' || !input.patch.body.trim())) {
    return _refuse('RULE_EDIT_INVALID', 'patch.body must be a non-empty string.');
  }
  if (input.patch.category !== undefined && input.patch.category !== null && typeof input.patch.category !== 'string') {
    return _refuse('RULE_EDIT_INVALID', 'patch.category must be a string or null.');
  }
  if (input.patch.scope !== undefined && input.patch.scope !== null && typeof input.patch.scope !== 'string') {
    return _refuse('RULE_EDIT_INVALID', 'patch.scope must be a string or null.');
  }
  if (input.patch.enabled !== undefined && typeof input.patch.enabled !== 'boolean') {
    return _refuse('RULE_EDIT_INVALID', 'patch.enabled must be a boolean.');
  }
  if (input.expectedVersion === undefined && input.expectedDigestSha256 === undefined) {
    return _refuse('RULE_EDIT_INVALID', 'At least one of expectedVersion or expectedDigestSha256 is required.');
  }

  if (!_authorizedApprover(input.approvalMode, input.caller, input.delegateAllowlist)) {
    return _refuse('RULE_APPROVAL_UNAUTHORIZED',
      `Caller "${input.caller.id}" may not edit a rule under approval mode "${input.approvalMode}".`);
  }
  if (input.expectedVersion !== undefined && input.rule.version !== input.expectedVersion) {
    return _refuse('RULE_EDIT_CONFLICT',
      `Rule version drifted: expected ${input.expectedVersion}, found ${input.rule.version}.`);
  }
  if (input.expectedDigestSha256 !== undefined && input.rule.digestSha256 !== input.expectedDigestSha256) {
    return _refuse('RULE_EDIT_CONFLICT', 'Rule content digest drifted since it was fetched.');
  }

  const previousContent = {
    title: input.rule.title, body: input.rule.body, category: input.rule.category,
    scope: input.rule.scope, enabled: input.rule.enabled
  };
  const nextContent = { ...previousContent, ...input.patch };
  const editedAt = new Date().toISOString();
  const nextVersion = (typeof input.rule.version === 'number' ? input.rule.version : 0) + 1;
  const nextDigest = _ruleContentDigest(nextContent);

  return {
    ok: true,
    rule: {
      ruleId: input.rule.ruleId || null,
      number: typeof input.rule.number === 'number' ? input.rule.number : null,
      ...nextContent,
      version: nextVersion,
      digestSha256: nextDigest
    },
    revision: {
      previousText: JSON.stringify(previousContent),
      newText: JSON.stringify(nextContent),
      editedBy: input.caller.id,
      editedAt,
      reason: typeof input.reason === 'string' ? input.reason : null
    }
  };
}

module.exports = {
  APPROVAL_MODES,
  DECISIONS,
  EDITABLE_FIELDS,
  decideSessionRuleProposal,
  bulkDecideSessionRuleProposals,
  editRuleInPlace
};
