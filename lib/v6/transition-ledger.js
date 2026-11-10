'use strict';

/**
 * v6 Stage 1 (#2977, V6-03 / A1b): a replay-safe runtime transition ledger
 * and a cross-plane state reconciler.
 *
 * Ported near-verbatim from PRR-A's tested Phase 6 bundle
 * (`v6-phase6-stage1-pr-ready-bundles-and-migration-verifier.md`,
 * `runtime-transitions.js` + `runtime-reconciler.js`, 80+4 `node:test` cases
 * passing against a real v80 clone). The DDL lives in
 * `lib/store/_schema.js#_v6Stage1AuthorityLedgerIncidentDdl`, not here.
 *
 * `request` records intent and scoped idempotency (`operation_idempotency`,
 * keyed on principal+project+resource+action+caller key) before any effect,
 * and increments a resource's generation only through SQLite CAS once a
 * caller reports `committed`. `settle` requires evidence for every terminal
 * outcome, and a failed-after-`unknown` transition additionally requires
 * `evidence.absenceProven` — an unconfirmed effect is never silently treated
 * as having not happened. Each launch, governed wrap, handoff, model-switch
 * and hold is a future caller of `request`/`settle` with a durable effect
 * correlation ID; wiring those call sites is a later production integration
 * bridge, not this car's file envelope.
 *
 * `reconcile` probes five surfaces (SQLite, tmux, Git, PortHub, Medusa)
 * read-only and never mutates state; `persistFindings` is the only writer,
 * and it only ever appends `reconciliation_findings` rows in `state: 'open'`
 * — nothing here closes a finding. The five probe functions themselves are
 * production integration adapters this car does not provide; a caller
 * injects them.
 *
 * @module lib/v6/transition-ledger
 */

const crypto = require('node:crypto');

const _digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Run `fn` inside an immediate transaction, rolling back on throw.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Function} fn
 * @returns {*}
 */
function _tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Build the replay-safe transition request/settle pair.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{authorize: Function}} auth
 * @param {{now?: Function, newId?: Function}} [opts]
 * @returns {{request: Function, settle: Function}}
 */
function createRuntimeTransitions(db, auth, { now = () => new Date().toISOString(), newId = crypto.randomUUID } = {}) {
  /**
   * Request a new transition, replaying an identical in-flight request and
   * refusing a conflicting one under the same idempotency scope.
   * @param {{principalId: string, projectId: number, resourceId: string, action: string,
   *   expectedGeneration: number, key: string, detail?: object}} args
   * @returns {{ok: boolean, code: string, id?: string}}
   */
  function request({ principalId, projectId, resourceId, action, expectedGeneration, key, detail = {} }) {
    if (!key || !resourceId || !action || !Number.isSafeInteger(expectedGeneration)) return { ok: false, code: 'INVALID_REQUEST' };
    const verdict = auth.authorize(principalId, 'runtime.createTransition', { type: 'project', id: projectId });
    if (!verdict.allowed) return { ok: false, code: verdict.code };
    const scope = JSON.stringify([principalId, projectId, resourceId, action, key]);
    const fingerprint = _digest({ expectedGeneration, detail });
    return _tx(db, () => {
      const prior = db.prepare('SELECT * FROM operation_idempotency WHERE scope_key = ?').get(scope);
      if (prior) {
        return prior.fingerprint === fingerprint ? { ok: true, code: 'DEDUP', id: prior.transition_id } : { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      }
      const resource = db.prepare('SELECT * FROM runtime_resources WHERE id = ? AND project_id = ?').get(resourceId, projectId);
      if (!resource || resource.generation !== expectedGeneration) return { ok: false, code: 'STALE_GENERATION' };
      const open = db.prepare("SELECT 1 FROM runtime_transitions WHERE resource_id = ? AND state IN ('pending','unknown')").get(resourceId);
      if (open) return { ok: false, code: 'IN_FLIGHT' };
      const id = newId();
      db.prepare(
        'INSERT INTO runtime_transitions (id, project_id, resource_id, action, state, expected_generation, target_generation, fingerprint, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(id, projectId, resourceId, action, 'pending', expectedGeneration, expectedGeneration + 1, fingerprint, now(), now());
      db.prepare('INSERT INTO operation_idempotency (scope_key, transition_id, fingerprint) VALUES (?,?,?)').run(scope, id, fingerprint);
      return { ok: true, code: 'PENDING', id };
    });
  }

  /**
   * Settle a pending or unknown transition with observed evidence.
   * @param {{principalId: string, projectId: number, id: string, state: ('unknown'|'committed'|'failed'),
   *   evidence: {source: string, observedAt: string, absenceProven?: boolean}}} args
   * @returns {{ok: boolean, code: string}}
   */
  function settle({ principalId, projectId, id, state, evidence }) {
    const verdict = auth.authorize(principalId, 'runtime.reconcile', { type: 'project', id: projectId });
    if (!verdict.allowed) return { ok: false, code: verdict.code };
    if (!['unknown', 'committed', 'failed'].includes(state) || !evidence?.source || !evidence?.observedAt) return { ok: false, code: 'EVIDENCE_REQUIRED' };
    return _tx(db, () => {
      const row = db.prepare('SELECT * FROM runtime_transitions WHERE id = ? AND project_id = ?').get(id, projectId);
      if (!row) return { ok: false, code: 'NOT_FOUND' };
      if (!['pending', 'unknown'].includes(row.state)) return { ok: false, code: 'TERMINAL' };
      if (row.state === 'unknown' && state === 'failed' && !evidence.absenceProven) return { ok: false, code: 'ABSENCE_REQUIRED' };
      if (state === 'committed') {
        const changed = db.prepare('UPDATE runtime_resources SET generation = ? WHERE id = ? AND generation = ?')
          .run(row.target_generation, row.resource_id, row.expected_generation).changes;
        if (changed !== 1) return { ok: false, code: 'STALE_GENERATION' };
      }
      db.prepare('UPDATE runtime_transitions SET state = ?, updated_at = ? WHERE id = ?').run(state, now(), id);
      db.prepare('INSERT INTO runtime_observations (id, transition_id, source, state, observed_at, evidence_json) VALUES (?,?,?,?,?,?)')
        .run(newId(), id, evidence.source, state, evidence.observedAt, JSON.stringify(evidence));
      return { ok: true, code: state.toUpperCase() };
    });
  }

  return { request, settle };
}

/** Every surface `reconcile` probes, in the order the probe map must supply them. */
const SURFACES = ['sqlite', 'tmux', 'git', 'ports', 'medusa'];

/**
 * Read-only cross-plane reconciliation across SQLite, tmux, Git, PortHub and
 * Medusa. Never mutates state.
 * @param {{id: string}} resource
 * @param {Object<string, Function>} probes - One async probe per {@link SURFACES} entry; each
 *   must resolve `{status: ('ok'|'missing'|'unknown'), ...}` or is treated as `unknown`.
 * @returns {Promise<{safe: boolean, findings: object[], seen: object}>}
 */
async function reconcile(resource, probes) {
  const seen = {};
  for (const name of SURFACES) {
    try {
      const result = await probes[name](resource);
      seen[name] = result && ['ok', 'missing', 'unknown'].includes(result.status) ? result : { status: 'unknown' };
    } catch (error) {
      seen[name] = { status: 'unknown', reason: error.message };
    }
  }
  const findings = [];
  const add = (code, surface) => findings.push({ code, surface });
  if (seen.sqlite.status !== 'ok') add('SQLITE_UNVERIFIED', 'sqlite');
  for (const name of SURFACES.slice(1)) if (seen[name].status === 'unknown') add('PROBE_UNKNOWN', name);
  if (seen.sqlite.status === 'ok') {
    if (seen.sqlite.active && seen.tmux.status === 'missing') add('ACTIVE_TMUX_MISSING', 'tmux');
    if (!seen.sqlite.active && seen.tmux.status === 'ok') add('ORPHAN_TMUX', 'tmux');
    if (seen.sqlite.active && seen.git.status === 'missing') add('WORKTREE_MISSING', 'git');
    if (seen.git.status === 'ok' && seen.git.head !== seen.sqlite.head) add('HEAD_DIVERGED', 'git');
    if (seen.sqlite.active && seen.ports.status === 'missing') add('LEASE_MISSING', 'ports');
    if (seen.ports.status === 'ok' && seen.ports.owner !== resource.id) add('LEASE_OWNER_MISMATCH', 'ports');
    if (seen.medusa.status === 'ok' && seen.medusa.pending > 0) add('MEDUSA_PENDING', 'medusa');
  }
  return { safe: findings.length === 0 && SURFACES.every((name) => seen[name].status === 'ok'), findings, seen };
}

/**
 * Persist a reconciliation's findings, each as its own open row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @param {string} resourceId
 * @param {{findings: object[]}} result - As {@link reconcile} returns.
 * @param {{now?: Function}} [opts]
 * @returns {number} How many findings were written.
 */
function persistFindings(db, projectId, resourceId, result, { now = () => new Date().toISOString() } = {}) {
  for (const finding of result.findings) {
    db.prepare('INSERT INTO reconciliation_findings (id, project_id, resource_id, code, state, observed_at, detail_json) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), projectId, resourceId, finding.code, 'open', now(), JSON.stringify(finding));
  }
  return result.findings.length;
}

module.exports = { createRuntimeTransitions, reconcile, persistFindings, SURFACES };
