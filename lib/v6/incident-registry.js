'use strict';

/**
 * v6 Stage 1 (#2978, V6-04 / A2a): unified runtime failure taxonomy,
 * secret-redacted incident evidence capture, and a bounded recovery circuit.
 *
 * Ported near-verbatim from PRR-A's tested Phase 6 bundle
 * (`v6-phase6-stage1-pr-ready-bundles-and-migration-verifier.md`,
 * `runtime-incidents.js`, 80+4 `node:test` cases passing against a real v80
 * clone). The DDL lives in
 * `lib/store/_schema.js#_v6Stage1AuthorityLedgerIncidentDdl`, not here.
 *
 * One incident per `(project_id, fingerprint)`: a step against an existing
 * open incident whose generation no longer matches refuses as
 * `STALE_INCIDENT`, rather than silently reopening a resolved one under
 * stale state. A `healthy` step only records evidence; recovery is never
 * attempted when nothing is actually wrong. `RESERVED` actions
 * (`kill`, `delete-worktree`, `rotate-secret`, `merge`, `release`,
 * `cross-engine-takeover`) are refused outright — this module never executes
 * a destructive action itself, only records the decision to attempt or
 * refuse one. The two-attempt budget and the open-circuit backoff
 * (`recovery_circuit_state`) are the A2 policy this bundle encodes; a
 * production controller supplies `verification` from a real, fresh
 * observation, never a synthetic one.
 *
 * @module lib/v6/incident-registry
 */

const crypto = require('node:crypto');

/** Actions this module always refuses, whatever the caller's authorization. */
const RESERVED = new Set(['kill', 'delete-worktree', 'rotate-secret', 'merge', 'release', 'cross-engine-takeover']);

/**
 * Value-shaped secret patterns a bare string can carry even when no nearby
 * key name says "secret"/"token" — the same credential families
 * `lib/tc-verbs.js#CAPTURE_REDACT_PATTERNS` and `lib/bridge-api.js`'s
 * `SENSITIVE_TEXT_PATTERNS` already redact/detect elsewhere in this repo
 * (PRR-A R1/R2 findings on PR #3008: a narrower, bundle-inherited regex here
 * missed a bare `Bearer ghp_...` value with no adjacent "token"/"secret"
 * keyword (R1), then missed the `X-TangleClaw-Launch-Id:` header and the
 * generic `tc_[a-z]+_...` family beyond just `tc_master_` — `tc_launch_`,
 * `tc_hb_`, `tc_bridge_`, etc. (R2)).
 * @type {RegExp[]}
 */
const _SECRET_VALUE_PATTERNS = [
  /X-TangleClaw-Launch-Id:\s*\S+/gi,
  // Not drawn from an existing canonical pattern elsewhere in the repo (checked:
  // no hit for "TANGLECLAW_LAUNCH_ID=" in lib/*.js) -- a shell-env-assignment
  // analog of the header above that PRR-A/PM asked to also cover.
  /TANGLECLAW_LAUNCH_ID=\S+/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\btc_[a-z]+_[A-Za-z0-9_-]{8,}/g,
  /(?:token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi
];

/**
 * Redact anything that looks like a secret, token, password or API key —
 * both by key name and by value shape — before it is ever persisted.
 * @param {*} value
 * @returns {string} The JSON-stringified, redacted value.
 */
function _redacted(value) {
  return JSON.stringify(value, (key, v) => {
    if (/(?:secret|token|password|api[_-]?key)/i.test(key)) return '[REDACTED]';
    if (typeof v !== 'string') return v;
    let out = v;
    for (const pattern of _SECRET_VALUE_PATTERNS) out = out.replace(pattern, '[REDACTED]');
    return out;
  });
}

/**
 * Build the incident step function.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{authorize: Function}} auth
 * @param {{clock?: Function}} [opts]
 * @returns {{step: Function}}
 */
function createRuntimeIncidents(db, auth, { clock = () => Date.now() } = {}) {
  /**
   * Record evidence for a project's incident, identified by a stable
   * fingerprint, and attempt bounded recovery if unhealthy.
   * @param {{principalId: string, projectId: number, fingerprint: string, generation: number,
   *   action: string, health: ('healthy'|'unhealthy'), evidence?: object,
   *   verification?: {generation: number, observedAt: number, healthy: boolean, source: string}}} args
   * @returns {{ok: boolean, code: string, id?: (string|null)}} `id` is `null` only for
   *   `HEALTHY_NO_ACTION` against a fingerprint with no prior incident — nothing was created.
   */
  function step({ principalId, projectId, fingerprint, generation, action, health, evidence = {}, verification }) {
    const verdict = auth.authorize(principalId, 'runtime.recover', { type: 'project', id: projectId });
    if (!verdict.allowed) return { ok: false, code: verdict.code };
    if (RESERVED.has(action)) return { ok: false, code: 'RESERVED_ACTION' };
    const t = clock();
    const stamp = new Date(t).toISOString();
    let incident = db.prepare('SELECT * FROM runtime_incidents WHERE project_id = ? AND fingerprint = ?').get(projectId, fingerprint);
    // Evaluate health BEFORE ever inserting a row (PRR-A R1 finding on PR
    // #3008): a healthy first-ever report for a fingerprint with no prior
    // incident creates zero runtime_incidents rows, open or otherwise — a
    // report that nothing is wrong is not itself an incident. A healthy
    // report against an EXISTING incident (a recovery signal) still records
    // evidence against it below, unchanged.
    if (!incident && health === 'healthy') return { ok: true, code: 'HEALTHY_NO_ACTION', id: null };
    if (!incident) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO runtime_incidents (id, project_id, fingerprint, state, generation, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, projectId, fingerprint, 'open', generation, stamp);
      incident = { id, generation };
    }
    if (incident.generation !== generation) return { ok: false, code: 'STALE_INCIDENT' };
    db.prepare('INSERT INTO incident_evidence (id, incident_id, payload_json, observed_at) VALUES (?,?,?,?)')
      .run(crypto.randomUUID(), incident.id, _redacted({ health, evidence }), stamp);
    if (health === 'healthy') return { ok: true, code: 'HEALTHY_NO_ACTION', id: incident.id };
    const circuit = db.prepare('SELECT * FROM recovery_circuit_state WHERE project_id = ?').get(projectId);
    if (circuit?.state === 'open' && t < circuit.next_probe_at) return { ok: false, code: 'BACKOFF', id: incident.id };
    const attempts = db.prepare('SELECT COUNT(*) n FROM remediation_attempts WHERE incident_id = ?').get(incident.id).n;
    if (attempts >= 2) return { ok: false, code: 'MAX_ATTEMPTS', id: incident.id };
    const verified = verification?.generation === generation && verification?.observedAt > t && verification?.healthy === true && !!verification?.source;
    const outcome = verified ? 'verified' : 'failed';
    db.prepare('INSERT INTO remediation_attempts (id, incident_id, action, outcome, attempted_at) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), incident.id, action, outcome, stamp);
    const failures = verified ? 0 : attempts + 1;
    const state = verified ? 'closed' : failures >= 2 ? 'open' : 'closed';
    db.prepare(
      'INSERT INTO recovery_circuit_state (project_id, state, failures, next_probe_at) VALUES (?,?,?,?) '
      + 'ON CONFLICT(project_id) DO UPDATE SET state = excluded.state, failures = excluded.failures, next_probe_at = excluded.next_probe_at'
    ).run(projectId, state, failures, state === 'open' ? t + 1000 : 0);
    if (verified) db.prepare('UPDATE runtime_incidents SET state = ? WHERE id = ?').run('resolved', incident.id);
    return { ok: verified, code: verified ? 'VERIFIED' : state === 'open' ? 'CIRCUIT_OPEN' : 'ATTEMPT_FAILED', id: incident.id };
  }

  return { step };
}

module.exports = { createRuntimeIncidents, RESERVED };
