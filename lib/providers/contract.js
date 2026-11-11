'use strict';

/**
 * v6 (#2990, V6-19 / G2a, Car V60-T3-W1-A): the canonical provider adapter
 * contract — the single interface shape `lib/v6/g1-github-integration.js`
 * (and any future non-GitHub integration) is written against, so the
 * writer never hardcodes a provider's own API shape into its own gating
 * logic.
 *
 * Six methods, every adapter must implement all of them:
 * - `validateConfig(config)` — is a stored connection config well-formed?
 * - `testConnection({connection, probe, now})` — does a fresh capability
 *   probe still match what the connection recorded (drift detection)?
 * - `mapOutboundEvent({action, repo, draft})` — turn an internal action +
 *   draft into the provider's own outbound HTTP request shape.
 * - `verifyWebhookSignature({secret, rawBody, signatureHeader})` — is an
 *   inbound webhook's signature genuine?
 * - `normalizeInboundEvent({headers, payload})` — extract this provider's
 *   own identity fields (repo, installation, delivery id, event type) from
 *   a raw inbound payload.
 * - `capabilities()` — this provider's action→tier/permission map.
 *
 * `createGithubProvider` is the one concrete adapter this car ships,
 * satisfying the contract against real GitHub REST/webhook shapes. Its
 * action tiers, HMAC verification shape (`sha256=` + `timingSafeEqual`),
 * and drift-detection fields are carried over from the INT workspace's own
 * real prototype design (`github-capabilities.js`,
 * `v6-phase9-durable-context-resolver-and-webhook-ingress-suite.md`), not
 * invented fresh for this car — a second provider later implements the
 * SAME contract shape, never a parallel one.
 *
 * NOT in this car's envelope (no `server.js` here): mounting the actual
 * `POST /api/integrations/github/webhook` route, or any other HTTP
 * surface — Wave 2's routes car, per the Train 3 Wave 1 dispatch. This
 * module is pure functions a route will eventually call into.
 *
 * @module lib/providers/contract
 */

const crypto = require('node:crypto');

/** Every method a provider adapter must implement. */
const CONTRACT_METHODS = Object.freeze([
  'validateConfig', 'testConnection', 'mapOutboundEvent', 'verifyWebhookSignature', 'normalizeInboundEvent', 'capabilities'
]);

/**
 * Does `adapter` implement the full contract?
 * @param {object} adapter
 * @returns {{ok: true}|{ok: false, code: string, missing?: string[]}}
 */
function validateProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') return { ok: false, code: 'INVALID_ADAPTER' };
  const missing = CONTRACT_METHODS.filter((m) => typeof adapter[m] !== 'function');
  if (missing.length) return { ok: false, code: 'ADAPTER_INCOMPLETE', missing };
  return { ok: true };
}

/** GitHub's own action→tier/permission map (INT's `github-capabilities.js`, verified real design). Tier 1 = read/observe, Tier 2 = role-lease write, Tier 3 = distinct-operator-approved milestone/merge/release. */
const GITHUB_ACTIONS = Object.freeze({
  inspect: { tier: 1, permission: 'contents:read' },
  checks: { tier: 1, permission: 'checks:read' },
  createIssue: { tier: 2, permission: 'issues:write' },
  createBranch: { tier: 2, permission: 'contents:write' },
  pushBranch: { tier: 2, permission: 'contents:write' },
  openPullRequest: { tier: 2, permission: 'pull_requests:write' },
  createMilestone: { tier: 3, permission: 'issues:write' },
  mergePullRequest: { tier: 3, permission: 'pull_requests:write' },
  publishRelease: { tier: 3, permission: 'contents:write' },
  administerRepo: { tier: 3, permission: 'administration:write' }
});

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * A stable fingerprint of a capability probe's identity/kind/permissions/
 * repositories, so two probes can be compared for drift without a deep
 * object comparison (INT's `github-capabilities.js#fingerprint`).
 * @param {{identity?: string, kind?: string, permissions?: string[], repositories?: string[]}} probe
 * @returns {string|null}
 */
function _githubFingerprint(probe) {
  if (!probe || !Array.isArray(probe.permissions) || !Array.isArray(probe.repositories)) return null;
  return JSON.stringify({
    identity: probe.identity, kind: probe.kind,
    permissions: [...probe.permissions].sort(), repositories: [...probe.repositories].sort()
  });
}

/**
 * Create the one concrete provider adapter this car ships, satisfying
 * {@link CONTRACT_METHODS} against real GitHub REST/webhook shapes.
 * @returns {object}
 */
function createGithubProvider() {
  return {
    /**
     * @param {object} config - `{repo, installationId, tokenRef}`.
     * @returns {{ok: boolean, code?: string}}
     */
    validateConfig(config) {
      if (!config || typeof config !== 'object') return { ok: false, code: 'CONFIG_INVALID' };
      if (typeof config.repo !== 'string' || !REPO_PATTERN.test(config.repo)) return { ok: false, code: 'REPO_INVALID' };
      if (!Number.isSafeInteger(config.installationId) || config.installationId < 1) return { ok: false, code: 'INSTALLATION_ID_INVALID' };
      if (typeof config.tokenRef !== 'string' || !/^vault:[A-Za-z0-9_-]+$/.test(config.tokenRef)) return { ok: false, code: 'TOKEN_REF_INVALID' };
      return { ok: true };
    },

    /**
     * Does a fresh capability probe still match what `connection` recorded?
     * `null` means no drift; otherwise the specific drift code.
     * @param {{connection: object, probe: object, now?: number}} args
     * @returns {string|null}
     */
    testConnection({ connection, probe, now = Date.now() }) {
      if (!probe || !_githubFingerprint(probe) || !probe.identity || !['app', 'fine-grained', 'classic'].includes(probe.kind)) {
        return 'PROBE_UNAVAILABLE';
      }
      if (!Number.isFinite(probe.expiresAt) || probe.expiresAt <= now) return 'PROBE_EXPIRED';
      if (!connection || probe.identity !== connection.identity) return 'IDENTITY_CHANGED';
      if (!probe.repositories.includes(connection.repo)) return 'REPOSITORY_ACCESS_LOST';
      if (_githubFingerprint(probe) !== connection.expectedFingerprint) return 'SCOPE_DRIFT';
      return null;
    },

    /**
     * @param {{action: string, repo: string, draft: object, apiBase?: string}} args
     *   `apiBase` defaults to the real GitHub origin; a caller that
     *   configured a loopback origin (the verifier only) must thread it
     *   through here too, or every outbound request silently targets the
     *   real GitHub API regardless of what the writer was constructed with.
     * @returns {{ok: true, method: string, url: string, body: object}|{ok: false, code: string}}
     */
    mapOutboundEvent({ action, repo, draft, apiBase = 'https://api.github.com' }) {
      if (!REPO_PATTERN.test(repo || '')) return { ok: false, code: 'REPO_INVALID' };
      const pathByAction = { createIssue: 'issues', createMilestone: 'milestones' };
      const path = pathByAction[action];
      if (!path) return { ok: false, code: 'ACTION_NOT_ALLOWED' };
      return { ok: true, method: 'POST', url: `${apiBase}/repos/${repo}/${path}`, body: draft };
    },

    /**
     * `X-Hub-Signature-256`: `sha256=` + HMAC-SHA256 hex over the exact raw
     * body, timing-safe compared (never a plain `===`, which leaks timing
     * information about how many leading bytes matched).
     * @param {{secret: string, rawBody: string|Buffer, signatureHeader: string}} args
     * @returns {{ok: boolean, code?: string}}
     */
    verifyWebhookSignature({ secret, rawBody, signatureHeader }) {
      if (typeof secret !== 'string' || secret.length < 16) return { ok: false, code: 'SECRET_UNAVAILABLE' };
      if (typeof signatureHeader !== 'string' || !signatureHeader) return { ok: false, code: 'BAD_SIGNATURE' };
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
      const expectedBuf = Buffer.from(expected);
      const suppliedBuf = Buffer.from(signatureHeader);
      if (expectedBuf.length !== suppliedBuf.length || !crypto.timingSafeEqual(expectedBuf, suppliedBuf)) {
        return { ok: false, code: 'BAD_SIGNATURE' };
      }
      return { ok: true };
    },

    /**
     * @param {{headers: Record<string, string>, payload: object}} args
     * @returns {{ok: true, repo: string, installationId: number, deliveryId: string, eventType: string}|{ok: false, code: string}}
     */
    normalizeInboundEvent({ headers, payload }) {
      const deliveryId = headers && headers['x-github-delivery'];
      const eventType = headers && headers['x-github-event'];
      if (typeof deliveryId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(deliveryId)) return { ok: false, code: 'BAD_DELIVERY_ID' };
      const repo = payload && payload.repository && payload.repository.full_name;
      const installationId = payload && payload.installation && payload.installation.id;
      if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || !Number.isSafeInteger(installationId)) {
        return { ok: false, code: 'BAD_IDENTITY' };
      }
      return { ok: true, repo, installationId, deliveryId, eventType: eventType || null };
    },

    /** @returns {{provider: string, actions: object}} */
    capabilities() {
      return { provider: 'github', actions: GITHUB_ACTIONS };
    }
  };
}

module.exports = {
  CONTRACT_METHODS,
  GITHUB_ACTIONS,
  validateProviderAdapter,
  createGithubProvider
};
