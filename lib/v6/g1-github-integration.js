'use strict';

/**
 * v6 (#2990, V6-19 / G1, Car V60-T3-W1-A): the guided 3-tier scoped GitHub
 * integration writer — Tier 1 read/observe, Tier 2 role-lease branch/PR/
 * issue write, Tier 3 distinct-operator-approved milestone/merge/release —
 * plus its durable idempotent outbox.
 *
 * This is "INT's Phase 10 bundle", the G1 *writer* module
 * `lib/v6/authority-service.js`'s own header comment names as deferred:
 * that module already ships the Stage 1 *issuer* side of
 * `v6_g1_leases`/`v6_g1_approvals` (`mintLease`/`revokeLease`/
 * `mintApproval`/`revokeApproval`, #1149) — this module only ever
 * CONSUMES those rows, via plain `SELECT`, never mints or revokes them.
 * Those two tables are NOT recreated here; `lib/store/_schema.js`'s v83
 * migration adds only the 5 tables this module is the first reader/writer
 * of (`v6_bindings`, `v6_github_connections`, `v6_g1_outbox`,
 * `v6_g1_milestone_bindings`, `v6_webhook_receipts`).
 *
 * Design (tier gates, idempotent outbox with `BEGIN IMMEDIATE` lock-and-
 * recheck, distinct-operator approval consumption, probe-drift detection)
 * is carried over from the INT workspace's own real prototype
 * (`v6-phase10-g1-issue-writer-and-master-v6-turnkey-index.md`'s
 * `v6-g1-writer.js`), verified against this repo's real, already-shipped
 * `v6_g1_leases`/`v6_g1_approvals` schema before being adapted here —
 * never invented fresh, and never a blind copy either (GitHub-specific
 * probe/signature logic is delegated to `lib/providers/contract.js`'s G2a
 * adapter, which THIS module's envelope owns and the prototype's
 * `github-capabilities.js` did not need to separate out).
 *
 * `principal`/`admission` are NOT constructed here: this module trusts
 * them exactly as given, and verifying them against a real signed-in
 * session/launch-binding/CSRF proof is Wave 2's routes car's job (per the
 * Train 3 Wave 1 dispatch — "no server.js edits in Wave 1"). `admit`
 * fails closed on anything short of `principal.verified === true` plus
 * `admission.launchBindingVerified === true` and
 * `admission.csrfVerified === true`, so a route that never sets those
 * flags can never reach a real GitHub write through this module.
 *
 * NOT in this car's envelope: `lib/v6-secret-store.js` (the prototype's
 * own 0600-file secret helper) — `secretStore` is an injected dependency
 * here (`{get(ref): string|null}`), the same constructor-injection shape
 * the prototype itself uses, so this module never assumes one concrete
 * implementation.
 *
 * @module lib/v6/g1-github-integration
 */

const crypto = require('node:crypto');
const { createGithubProvider } = require('../providers/contract');

/** Action -> tier, mirrored from `lib/providers/contract.js#GITHUB_ACTIONS` for the 2 actions this writer actually executes (Tier 2 `createIssue`, Tier 3 `createMilestone`) -- the full capability map lives in the provider contract; this is only the subset `execute` dispatches to a REST path for. */
const WRITE_RULES = Object.freeze({
  createIssue: { tier: 2, path: 'issues' },
  createMilestone: { tier: 3, path: 'milestones' }
});

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** How long an outbox row's own outbound HTTP call may run before this module treats the outcome as unknown rather than waiting forever. */
const FETCH_TIMEOUT_MS = 15000;

const _hash = (x) => crypto.createHash('sha256').update(x).digest('hex');

/**
 * A deterministic digest binding one admission to exactly what it would
 * do -- the SAME (action, repo, normalized draft) always produces the
 * SAME digest, which is what makes idempotency-key replay detection exact
 * rather than a trust-the-caller check.
 * @param {string} action
 * @param {string} repo
 * @param {object} normalizedDraft
 * @returns {string}
 */
function _targetDigest(action, repo, normalizedDraft) {
  return _hash(JSON.stringify({ action, repo, draft: normalizedDraft }));
}

/**
 * Validate and normalize a caller-supplied draft for `action`, stripping
 * anything not in its known shape -- never passes an arbitrary caller
 * object through to the outbound request unchanged.
 * @param {string} action
 * @param {object} draft
 * @returns {object|null} `null` on anything malformed.
 */
function normalizeDraft(action, draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)
    || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 256
    || /[\x00-\x1f\x7f]/.test(draft.title)) return null;
  const title = draft.title.trim();
  if (action === 'createIssue') {
    if (typeof draft.body !== 'string' || draft.body.length > 65536 || draft.body.includes('\0')) return null;
    const labels = draft.labels === undefined ? [] : draft.labels;
    if (!Array.isArray(labels) || labels.length > 20 || labels.some((l) => typeof l !== 'string' || !/^[-\w. ]{1,64}$/.test(l))) return null;
    if (draft.milestone !== undefined && (!Number.isSafeInteger(draft.milestone) || draft.milestone < 1)) return null;
    return { title, body: draft.body, labels: [...new Set(labels)], ...(draft.milestone ? { milestone: draft.milestone } : {}) };
  }
  if (action === 'createMilestone') {
    if (draft.description !== undefined && (typeof draft.description !== 'string' || draft.description.length > 10000 || draft.description.includes('\0'))) return null;
    if (draft.due_on !== undefined && (!Number.isFinite(Date.parse(draft.due_on)) || !/^\d{4}-\d\d-\d\dT/.test(draft.due_on))) return null;
    return { title, description: draft.description || '', state: 'open', ...(draft.due_on ? { due_on: draft.due_on } : {}) };
  }
  return null;
}

const _deny = (code, status = 403) => ({ ok: false, code, status });

/**
 * Create the G1 writer. `fetchImpl`/`now` are injectable for tests; `db`
 * and `secretStore` are required.
 * @param {{db: import('node:sqlite').DatabaseSync, secretStore: {get(ref: string): string|null},
 *   fetchImpl?: Function, now?: Function, apiBase?: string, provider?: object}} deps
 * @returns {{admit: Function, execute: Function}}
 */
function createG1Writer({ db, secretStore, fetchImpl = fetch, now = () => Date.now(), apiBase = 'https://api.github.com', provider = createGithubProvider() }) {
  if (!db || !secretStore || typeof secretStore.get !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('createG1Writer requires db, secretStore, and fetchImpl');
  }
  const origin = new URL(apiBase);
  const trustedOrigin = (origin.protocol === 'https:' && origin.hostname === 'api.github.com')
    || (origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname));
  if (!trustedOrigin) throw new TypeError('untrusted GitHub API origin');

  /**
   * The synchronous, no-side-effect admission check (ADR-level P08: a
   * distinct signed-in operator must mint the Tier 3 approval, never the
   * same actor executing the action). Called once outside the write
   * transaction (fast fail for an obviously-bad request) and once again
   * inside it (lock-and-recheck, so nothing mutable can have changed
   * between the two calls without this one seeing it).
   * @param {object} input
   * @returns {{ok: true, existing: boolean, [key: string]: *}|{ok: false, code: string, status: number}}
   */
  function admit(input) {
    const { projectId, principal, admission, action, idempotencyKey, leaseId, approvalId } = input || {};
    const rule = WRITE_RULES[action];
    if (!Number.isSafeInteger(projectId) || !principal || principal.verified !== true || principal.projectId !== projectId
      || !['project', 'operator'].includes(principal.role) || !principal.actor
      || !admission || admission.launchBindingVerified !== true || admission.csrfVerified !== true) {
      return _deny('CALLER_NOT_ADMITTED');
    }
    if (!rule) return _deny('ACTION_NOT_ALLOWED', 400);
    if (!KEY_PATTERN.test(idempotencyKey || '')) return _deny('BAD_IDEMPOTENCY_KEY', 400);
    const draft = normalizeDraft(action, input.draft);
    if (!draft) return _deny('BAD_DRAFT', 400);

    const binding = db.prepare('SELECT * FROM v6_bindings WHERE project_id = ?').get(projectId);
    if (!binding || !REPO_PATTERN.test(binding.repo)) return _deny('REPO_NOT_BOUND');

    const digest = _targetDigest(action, binding.repo, draft);
    const previous = db.prepare('SELECT * FROM v6_g1_outbox WHERE project_id = ? AND idempotency_key = ?').get(projectId, idempotencyKey);
    if (previous) {
      if (previous.target_digest !== digest || previous.action !== action || previous.actor !== principal.actor) {
        return _deny('IDEMPOTENCY_CONFLICT', 409);
      }
      return { ok: true, existing: true, row: previous };
    }

    const connectionRow = db.prepare('SELECT * FROM v6_github_connections WHERE project_id = ?').get(projectId);
    if (!connectionRow) return _deny('CONNECTION_MISSING');
    let connection, probe;
    try {
      connection = JSON.parse(connectionRow.connection_json);
      probe = JSON.parse(connectionRow.probe_json);
    } catch {
      return _deny('CONNECTION_INVALID');
    }
    if (connection.repo !== binding.repo || connection.revokedAt || !connection.tokenRef) return _deny('CONNECTION_REVOKED');

    const drift = provider.testConnection({ connection, probe, now: now() });
    if (drift) return _deny(drift);
    if (!Array.isArray(connection.approvedTiers) || !connection.approvedTiers.includes(rule.tier)) return _deny('TIER_NOT_APPROVED');

    const lease = db.prepare('SELECT * FROM v6_g1_leases WHERE id = ? AND project_id = ?').get(leaseId || null, projectId);
    if (!lease || lease.actor !== principal.actor || lease.repo !== binding.repo || lease.connection_epoch !== connection.epoch
      || lease.revoked_at !== null || lease.expires_at <= now()) return _deny('ROLE_LEASE_REQUIRED');
    let actions;
    try {
      actions = JSON.parse(lease.actions_json);
    } catch {
      return _deny('ROLE_LEASE_REQUIRED');
    }
    if (!Array.isArray(actions) || !actions.includes(action)) return _deny('ROLE_LEASE_REQUIRED');

    if (draft.milestone && !db.prepare('SELECT 1 AS ok FROM v6_g1_milestone_bindings WHERE project_id = ? AND number = ?').get(projectId, draft.milestone)) {
      return _deny('MILESTONE_NOT_BOUND');
    }

    let approval = null;
    if (rule.tier === 3) {
      approval = db.prepare('SELECT * FROM v6_g1_approvals WHERE id = ? AND project_id = ?').get(approvalId || null, projectId);
      // P08: the approval's own operator must be a DIFFERENT actor than
      // the one executing the action -- an actor cannot self-approve its
      // own Tier 3 request.
      if (!approval || approval.action !== action || approval.repo !== binding.repo || approval.target_digest !== digest
        || approval.operator_actor === principal.actor || approval.revoked_at !== null || approval.consumed_at !== null
        || approval.expires_at <= now()) {
        return _deny('OPERATOR_APPROVAL_REQUIRED');
      }
    }

    let token;
    try {
      token = secretStore.get(connection.tokenRef);
    } catch {
      return _deny('CREDENTIAL_UNAVAILABLE', 503);
    }
    if (typeof token !== 'string' || token.length < 16) return _deny('CREDENTIAL_UNAVAILABLE', 503);

    return {
      ok: true, existing: false, projectId, repo: binding.repo, action, draft, digest, idempotencyKey,
      actor: principal.actor, approvalId: approval ? approval.id : undefined, token
    };
  }

  /**
   * Admit, durably record intent, then perform the outbound GitHub write.
   * Same-key replay returns the ORIGINAL outcome without ever touching
   * the network again; a changed payload/actor under the same key is a
   * conflict, never a silent overwrite.
   * @param {object} input - Same shape as {@link admit}'s, plus `draft`.
   * @returns {Promise<{ok: true, code: string, result: {number: number, url: string}}|{ok: false, code: string, status: number}>}
   */
  async function execute(input) {
    let permit = admit(input);
    if (!permit.ok) return permit;
    if (permit.existing) {
      const row = permit.row;
      if (row.state === 'succeeded') return { ok: true, code: 'REPLAY', result: JSON.parse(row.result_json) };
      return _deny(row.state === 'failed' ? 'PREVIOUSLY_FAILED' : 'OUTCOME_UNKNOWN', 409);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      // Lock-and-recheck: nothing admitted above is trusted past this
      // point without seeing it again under the write lock.
      const locked = admit(input);
      if (!locked.ok) {
        db.exec('ROLLBACK');
        return locked;
      }
      if (locked.existing) {
        db.exec('ROLLBACK');
        const row = locked.row;
        if (row.state === 'succeeded') return { ok: true, code: 'REPLAY', result: JSON.parse(row.result_json) };
        return _deny(row.state === 'failed' ? 'PREVIOUSLY_FAILED' : 'OUTCOME_UNKNOWN', 409);
      }
      permit = locked;
      if (permit.approvalId) {
        const used = db.prepare('UPDATE v6_g1_approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now(), permit.approvalId);
        if (used.changes !== 1) throw Object.assign(new Error('approval already consumed'), { code: 'OPERATOR_APPROVAL_REQUIRED', status: 403 });
      }
      db.prepare(
        `INSERT INTO v6_g1_outbox (project_id, idempotency_key, action, repo, target_digest, actor, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(permit.projectId, permit.idempotencyKey, permit.action, permit.repo, permit.digest, permit.actor, now(), now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (e.code === 'OPERATOR_APPROVAL_REQUIRED') return _deny(e.code, e.status);
      throw e;
    }

    const mapped = provider.mapOutboundEvent({ action: permit.action, repo: permit.repo, draft: permit.draft });
    let response;
    try {
      response = await fetchImpl(mapped.url, {
        method: mapped.method,
        headers: {
          Authorization: `Bearer ${permit.token}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TangleClaw-v6'
        },
        body: JSON.stringify(mapped.body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'error'
      });
    } catch {
      db.prepare("UPDATE v6_g1_outbox SET state = 'unknown', updated_at = ? WHERE project_id = ? AND idempotency_key = ?")
        .run(now(), permit.projectId, permit.idempotencyKey);
      return _deny('OUTCOME_UNKNOWN', 503);
    }

    if (response.status !== 201) {
      const uncertain = response.status < 400 || response.status === 408 || response.status === 429 || response.status >= 500;
      db.prepare('UPDATE v6_g1_outbox SET state = ?, status = ?, updated_at = ? WHERE project_id = ? AND idempotency_key = ?')
        .run(uncertain ? 'unknown' : 'failed', response.status, now(), permit.projectId, permit.idempotencyKey);
      return _deny(uncertain ? 'OUTCOME_UNKNOWN' : 'GITHUB_REJECTED', uncertain ? 503 : 422);
    }

    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const expected = permit.action === 'createIssue' ? `https://github.com/${permit.repo}/issues/` : `https://github.com/${permit.repo}/milestone/`;
    if (!body || !Number.isSafeInteger(body.number) || body.number < 1 || typeof body.html_url !== 'string'
      || !body.html_url.startsWith(expected) || !/^\d+$/.test(body.html_url.slice(expected.length))) {
      db.prepare("UPDATE v6_g1_outbox SET state = 'unknown', status = 201, updated_at = ? WHERE project_id = ? AND idempotency_key = ?")
        .run(now(), permit.projectId, permit.idempotencyKey);
      return _deny('OUTCOME_UNKNOWN', 503);
    }

    const result = { number: body.number, url: body.html_url };
    db.exec('BEGIN IMMEDIATE');
    try {
      if (permit.action === 'createMilestone') {
        db.prepare('INSERT OR IGNORE INTO v6_g1_milestone_bindings VALUES (?, ?, ?)').run(permit.projectId, body.number, permit.draft.title);
      }
      db.prepare("UPDATE v6_g1_outbox SET state = 'succeeded', status = 201, result_json = ?, updated_at = ? WHERE project_id = ? AND idempotency_key = ?")
        .run(JSON.stringify(result), now(), permit.projectId, permit.idempotencyKey);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true, code: 'CREATED', result };
  }

  return { admit, execute };
}

module.exports = {
  WRITE_RULES,
  normalizeDraft,
  createG1Writer
};
