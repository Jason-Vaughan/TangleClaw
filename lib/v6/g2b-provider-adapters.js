'use strict';

/**
 * v6.2 (#3002, V6-32 / G2b, Car V62-W1-A): GitLab, Jira, Linear and Dolt
 * provider adapters behind the SAME six-method G2a contract
 * `lib/providers/contract.js` defines (`validateConfig`, `testConnection`,
 * `mapOutboundEvent`, `verifyWebhookSignature`, `normalizeInboundEvent`,
 * `capabilities`) — never a parallel interface. Every adapter passes
 * `validateProviderAdapter`, exactly like `createGithubProvider`.
 *
 * The canonical prototype (P25, `v6-phase6-e2-sprint-mount-e4b-retro-g2-
 * provider-g4-advisor-suite.md`) wrote its conformance mocks against an
 * older interface (`describeConnection`/`listIssues`/...) that G1 never
 * calls; what is carried over from it is the rule, not the shape: a
 * capability a provider does not have is refused with
 * `CAPABILITY_UNSUPPORTED`, never answered with an empty success.
 *
 * Every provider-specific wire fact below is taken from that provider's
 * own documentation, as of 2026-11-11, and named where it is used:
 * - GitLab (docs.gitlab.com/user/project/integrations/webhooks): the
 *   secret token arrives verbatim in `X-Gitlab-Token`; a signing token
 *   (GitLab 19.0+, `whsec_` + base64) instead signs
 *   `{webhook-id}.{webhook-timestamp}.{body}` with HMAC-SHA256 into
 *   `webhook-signature` as space-separated `v1,{base64}`. The event type
 *   is `X-Gitlab-Event`; a delivery is identified by `Idempotency-Key`,
 *   stable across retries.
 * - Jira Cloud (developer.atlassian.com/cloud/jira/platform/webhooks): a
 *   webhook registered with a secret carries `X-Hub-Signature:
 *   sha256=<hex>` over the raw body; `X-Atlassian-Webhook-Identifier` is
 *   stable across retries; the event name is the payload's `webhookEvent`.
 * - Linear (linear.app/developers/webhooks): `Linear-Signature` is a bare
 *   hex HMAC-SHA256 of the raw body; `Linear-Delivery`/`Linear-Event`
 *   identify the delivery and entity; the payload's `webhookTimestamp`
 *   (ms) must be within a minute of receipt.
 * - DoltHub (dolthub.com/docs/products/dolthub/api/hooks): webhooks exist
 *   for push, pull request and branch events, but the documentation names
 *   NO way to authenticate a delivery and NO issue-creation API. The Dolt
 *   adapter therefore refuses every inbound delivery
 *   (`SIGNATURE_UNSUPPORTED`) and every write (`CAPABILITY_UNSUPPORTED`)
 *   rather than guessing at a scheme.
 *
 * Pure functions, like the GitHub adapter: no network, no database. A
 * route or the G1 outbox calls `mapOutboundEvent` and performs the request
 * itself; mounting any of this is Wave 2.
 *
 * @module lib/v6/g2b-provider-adapters
 */

const crypto = require('node:crypto');
const { validateProviderAdapter } = require('../providers/contract');

/** The providers this module adapts. */
const PROVIDERS = Object.freeze(['gitlab', 'jira', 'linear', 'dolt']);

const TOKEN_REF = /^vault:[A-Za-z0-9_-]+$/;
/** A GitLab project path: one or more namespace segments, then the project. */
const GITLAB_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
/** A Jira project key (uppercase, starts with a letter). */
const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A DoltHub database: `owner/database`. */
const DOLT_REPO = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
/** How far GitLab's `webhook-timestamp` may be from now (Standard Webhooks' usual 5 minutes). */
const GITLAB_TIMESTAMP_TOLERANCE_S = 300;
/** Linear's documented replay window. */
const LINEAR_TIMESTAMP_TOLERANCE_MS = 60_000;

/** A capability this provider does not offer. */
const UNSUPPORTED = Object.freeze({ ok: false, code: 'CAPABILITY_UNSUPPORTED' });

/**
 * Timing-safe string equality (a plain `===` leaks how many leading bytes
 * matched).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * An `https:` origin with no path, query or credentials, else null.
 * @param {*} value
 * @returns {string|null}
 */
function _httpsOrigin(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  return url.origin;
}

/**
 * The shared shape of a create-issue/milestone draft, mirroring G1's own
 * `normalizeDraft` limits so a draft G1 admits is one these adapters accept.
 * @param {*} draft
 * @returns {{title: string, body: string, labels: string[]}|null}
 */
function _draft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
  if (typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 256 || /[\x00-\x1f\x7f]/.test(draft.title)) return null;
  const body = draft.body === undefined ? '' : draft.body;
  if (typeof body !== 'string' || body.length > 65536 || body.includes('\0')) return null;
  const labels = draft.labels === undefined ? [] : draft.labels;
  if (!Array.isArray(labels) || labels.length > 20 || labels.some((l) => typeof l !== 'string' || !/^[-\w. ]{1,64}$/.test(l))) return null;
  return { title: draft.title.trim(), body, labels: [...new Set(labels)] };
}

/**
 * The drift check every adapter's `testConnection` shares with the GitHub
 * adapter: a fresh probe must still name the same identity, still reach
 * the connected resource, and still hold the same scopes.
 * @param {{connection: object, probe: object, now: number, resourceField: string}} args
 * @returns {string|null} `null` for no drift, else the drift code.
 */
function _drift({ connection, probe, now, resourceField }) {
  if (!probe || typeof probe.identity !== 'string' || !probe.identity
    || !Array.isArray(probe.scopes) || !Array.isArray(probe[resourceField])) return 'PROBE_UNAVAILABLE';
  if (!Number.isFinite(probe.expiresAt) || probe.expiresAt <= now) return 'PROBE_EXPIRED';
  if (!connection || probe.identity !== connection.identity) return 'IDENTITY_CHANGED';
  if (!probe[resourceField].includes(connection.repo)) return 'REPOSITORY_ACCESS_LOST';
  const scopes = JSON.stringify([...probe.scopes].sort());
  if (!Array.isArray(connection.scopes) || scopes !== JSON.stringify([...connection.scopes].sort())) return 'SCOPE_DRIFT';
  return null;
}

/**
 * The lower-cased view of a header map (Node lower-cases incoming header
 * names; a test or a proxy may not).
 * @param {*} headers
 * @returns {Record<string, string>}
 */
function _lower(headers) {
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}

// ── GitLab ──────────────────────────────────────────────────────────────

const GITLAB_ACTIONS = Object.freeze({
  inspect: { tier: 1, permission: 'read_api' },
  createIssue: { tier: 2, permission: 'api' },
  createMilestone: { tier: 3, permission: 'api' }
});

/**
 * GitLab (gitlab.com or a self-managed instance).
 * @returns {object} A G2a-conforming adapter.
 */
function createGitlabProvider() {
  return {
    /**
     * @param {{repo: string, baseUrl?: string, tokenRef: string}} config - `repo` is the project path.
     * @returns {{ok: boolean, code?: string}}
     */
    validateConfig(config) {
      if (!config || typeof config !== 'object') return { ok: false, code: 'CONFIG_INVALID' };
      if (typeof config.repo !== 'string' || !GITLAB_PATH.test(config.repo)) return { ok: false, code: 'REPO_INVALID' };
      if (config.baseUrl !== undefined && !_httpsOrigin(config.baseUrl)) return { ok: false, code: 'BASE_URL_INVALID' };
      if (typeof config.tokenRef !== 'string' || !TOKEN_REF.test(config.tokenRef)) return { ok: false, code: 'TOKEN_REF_INVALID' };
      return { ok: true };
    },

    /**
     * @param {{connection: object, probe: {identity: string, scopes: string[], projects: string[], expiresAt: number}, now?: number}} args
     * @returns {string|null}
     */
    testConnection({ connection, probe, now = Date.now() }) {
      return _drift({ connection, probe, now, resourceField: 'projects' });
    },

    /**
     * `POST /api/v4/projects/:id/issues` and `.../milestones`, with the
     * project path URL-encoded as the `:id` (GitLab's documented form).
     * @param {{action: string, repo: string, draft: object, apiBase?: string}} args
     * @returns {{ok: true, method: string, url: string, body: object}|{ok: false, code: string}}
     */
    mapOutboundEvent({ action, repo, draft, apiBase = 'https://gitlab.com' }) {
      if (!GITLAB_PATH.test(repo || '')) return { ok: false, code: 'REPO_INVALID' };
      const origin = _httpsOrigin(apiBase);
      if (!origin) return { ok: false, code: 'BASE_URL_INVALID' };
      if (!Object.hasOwn(GITLAB_ACTIONS, action) || action === 'inspect') return { ok: false, code: 'ACTION_NOT_ALLOWED' };
      const d = _draft(draft);
      if (!d) return { ok: false, code: 'BAD_DRAFT' };
      const base = `${origin}/api/v4/projects/${encodeURIComponent(repo)}`;
      if (action === 'createIssue') {
        return { ok: true, method: 'POST', url: `${base}/issues`, body: { title: d.title, description: d.body, ...(d.labels.length ? { labels: d.labels.join(',') } : {}) } };
      }
      return { ok: true, method: 'POST', url: `${base}/milestones`, body: { title: d.title, description: d.body } };
    },

    /**
     * Two documented modes, chosen by the configured secret: a `whsec_`
     * signing token verifies `webhook-signature` (`v1,{base64}`, any of a
     * space-separated list) over `{webhook-id}.{webhook-timestamp}.{body}`
     * within a 5-minute window; any other secret is a plain token compared
     * timing-safe against `X-Gitlab-Token` (passed as `signatureHeader`).
     * @param {{secret: string, rawBody: string|Buffer, signatureHeader?: string, headers?: object, now?: number}} args
     * @returns {{ok: boolean, code?: string}}
     */
    verifyWebhookSignature({ secret, rawBody, signatureHeader, headers, now = Date.now() }) {
      if (typeof secret !== 'string' || secret.length < 16) return { ok: false, code: 'SECRET_UNAVAILABLE' };
      if (!secret.startsWith('whsec_')) {
        return typeof signatureHeader === 'string' && signatureHeader && _safeEqual(signatureHeader, secret)
          ? { ok: true } : { ok: false, code: 'BAD_SIGNATURE' };
      }
      const h = _lower(headers);
      const id = h['webhook-id'];
      const ts = h['webhook-timestamp'];
      const sigs = h['webhook-signature'];
      if (!id || !/^\d{1,12}$/.test(ts || '') || !sigs) return { ok: false, code: 'BAD_SIGNATURE' };
      if (Math.abs(Math.floor(now / 1000) - Number(ts)) > GITLAB_TIMESTAMP_TOLERANCE_S) return { ok: false, code: 'STALE_DELIVERY' };
      let key;
      try {
        key = Buffer.from(secret.slice('whsec_'.length), 'base64');
      } catch {
        return { ok: false, code: 'SECRET_UNAVAILABLE' };
      }
      if (!key.length) return { ok: false, code: 'SECRET_UNAVAILABLE' };
      const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.`).update(rawBody).digest('base64');
      const matched = sigs.split(' ').some((entry) => {
        const [version, sig] = entry.split(',');
        return version === 'v1' && typeof sig === 'string' && _safeEqual(sig, expected);
      });
      return matched ? { ok: true } : { ok: false, code: 'BAD_SIGNATURE' };
    },

    /**
     * @param {{headers: object, payload: object}} args
     * @returns {{ok: true, repo: string, providerProjectId: number, deliveryId: string, eventType: string|null}|{ok: false, code: string}}
     */
    normalizeInboundEvent({ headers, payload }) {
      const h = _lower(headers);
      const deliveryId = h['idempotency-key'] || h['x-gitlab-event-uuid'];
      if (typeof deliveryId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(deliveryId)) return { ok: false, code: 'BAD_DELIVERY_ID' };
      const project = payload && payload.project;
      const repo = project && project.path_with_namespace;
      if (typeof repo !== 'string' || !GITLAB_PATH.test(repo) || !Number.isSafeInteger(project.id)) return { ok: false, code: 'BAD_IDENTITY' };
      return { ok: true, repo, providerProjectId: project.id, deliveryId, eventType: h['x-gitlab-event'] || null };
    },

    /** @returns {{provider: string, actions: object}} */
    capabilities() {
      return { provider: 'gitlab', actions: GITLAB_ACTIONS };
    }
  };
}

// ── Jira Cloud ──────────────────────────────────────────────────────────

const JIRA_ACTIONS = Object.freeze({
  inspect: { tier: 1, permission: 'read:jira-work' },
  createIssue: { tier: 2, permission: 'write:jira-work' }
});

/**
 * Wrap plain text as an Atlassian Document Format document — the format
 * Jira's v3 issue API requires for `description` — one paragraph per line.
 * @param {string} text
 * @returns {object}
 */
function _adf(text) {
  const lines = String(text).split(/\r?\n/);
  return {
    type: 'doc', version: 1,
    content: lines.map((line) => (line
      ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
      : { type: 'paragraph', content: [] }))
  };
}

/**
 * Jira Cloud. Milestones have no direct Jira equivalent here and are
 * refused as unsupported rather than mapped onto versions by guesswork.
 * @returns {object} A G2a-conforming adapter.
 */
function createJiraProvider() {
  return {
    /**
     * @param {{repo: string, site: string, tokenRef: string, issueType?: string}} config - `repo` is the project key.
     * @returns {{ok: boolean, code?: string}}
     */
    validateConfig(config) {
      if (!config || typeof config !== 'object') return { ok: false, code: 'CONFIG_INVALID' };
      if (typeof config.repo !== 'string' || !JIRA_KEY.test(config.repo)) return { ok: false, code: 'REPO_INVALID' };
      if (!_httpsOrigin(config.site)) return { ok: false, code: 'BASE_URL_INVALID' };
      if (typeof config.tokenRef !== 'string' || !TOKEN_REF.test(config.tokenRef)) return { ok: false, code: 'TOKEN_REF_INVALID' };
      if (config.issueType !== undefined && (typeof config.issueType !== 'string' || !/^[A-Za-z][\w -]{0,40}$/.test(config.issueType))) {
        return { ok: false, code: 'ISSUE_TYPE_INVALID' };
      }
      return { ok: true };
    },

    /**
     * @param {{connection: object, probe: {identity: string, scopes: string[], projects: string[], expiresAt: number}, now?: number}} args
     * @returns {string|null}
     */
    testConnection({ connection, probe, now = Date.now() }) {
      return _drift({ connection, probe, now, resourceField: 'projects' });
    },

    /**
     * `POST /rest/api/3/issue` with `fields.project.key`, `summary`,
     * `issuetype.name` and an ADF `description`. Jira labels cannot contain
     * spaces, so a label with one is refused, not rewritten.
     * @param {{action: string, repo: string, draft: object, apiBase: string, issueType?: string}} args
     * @returns {{ok: true, method: string, url: string, body: object}|{ok: false, code: string}}
     */
    mapOutboundEvent({ action, repo, draft, apiBase, issueType = 'Task' }) {
      if (!JIRA_KEY.test(repo || '')) return { ok: false, code: 'REPO_INVALID' };
      const origin = _httpsOrigin(apiBase);
      if (!origin) return { ok: false, code: 'BASE_URL_INVALID' };
      if (action === 'createMilestone') return { ...UNSUPPORTED };
      if (action !== 'createIssue') return { ok: false, code: 'ACTION_NOT_ALLOWED' };
      const d = _draft(draft);
      if (!d) return { ok: false, code: 'BAD_DRAFT' };
      if (d.labels.some((l) => /\s/.test(l))) return { ok: false, code: 'LABEL_INVALID' };
      return {
        ok: true, method: 'POST', url: `${origin}/rest/api/3/issue`,
        body: { fields: { project: { key: repo }, summary: d.title, issuetype: { name: issueType }, description: _adf(d.body), ...(d.labels.length ? { labels: d.labels } : {}) } }
      };
    },

    /**
     * `X-Hub-Signature: sha256=<hex>` over the exact raw body.
     * @param {{secret: string, rawBody: string|Buffer, signatureHeader: string}} args
     * @returns {{ok: boolean, code?: string}}
     */
    verifyWebhookSignature({ secret, rawBody, signatureHeader }) {
      if (typeof secret !== 'string' || secret.length < 16) return { ok: false, code: 'SECRET_UNAVAILABLE' };
      if (typeof signatureHeader !== 'string' || !signatureHeader) return { ok: false, code: 'BAD_SIGNATURE' };
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
      return _safeEqual(signatureHeader, expected) ? { ok: true } : { ok: false, code: 'BAD_SIGNATURE' };
    },

    /**
     * @param {{headers: object, payload: object}} args
     * @returns {{ok: true, repo: string, deliveryId: string, eventType: string|null}|{ok: false, code: string}}
     */
    normalizeInboundEvent({ headers, payload }) {
      const h = _lower(headers);
      const deliveryId = h['x-atlassian-webhook-identifier'];
      if (typeof deliveryId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(deliveryId)) return { ok: false, code: 'BAD_DELIVERY_ID' };
      const repo = payload && payload.issue && payload.issue.fields && payload.issue.fields.project && payload.issue.fields.project.key;
      if (typeof repo !== 'string' || !JIRA_KEY.test(repo)) return { ok: false, code: 'BAD_IDENTITY' };
      return { ok: true, repo, deliveryId, eventType: typeof payload.webhookEvent === 'string' ? payload.webhookEvent : null };
    },

    /** @returns {{provider: string, actions: object, unsupported: string[]}} */
    capabilities() {
      return { provider: 'jira', actions: JIRA_ACTIONS, unsupported: ['createMilestone'] };
    }
  };
}

// ── Linear ──────────────────────────────────────────────────────────────

const LINEAR_ACTIONS = Object.freeze({
  inspect: { tier: 1, permission: 'read' },
  createIssue: { tier: 2, permission: 'issues:create' }
});

const LINEAR_ISSUE_CREATE = 'mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }';

/**
 * Linear. Its API is GraphQL at one endpoint; labels are ids, not names,
 * so a draft carrying label names is refused rather than silently
 * filed without them.
 * @returns {object} A G2a-conforming adapter.
 */
function createLinearProvider() {
  return {
    /**
     * @param {{repo: string, tokenRef: string}} config - `repo` is the team id (a UUID).
     * @returns {{ok: boolean, code?: string}}
     */
    validateConfig(config) {
      if (!config || typeof config !== 'object') return { ok: false, code: 'CONFIG_INVALID' };
      if (typeof config.repo !== 'string' || !UUID.test(config.repo)) return { ok: false, code: 'REPO_INVALID' };
      if (typeof config.tokenRef !== 'string' || !TOKEN_REF.test(config.tokenRef)) return { ok: false, code: 'TOKEN_REF_INVALID' };
      return { ok: true };
    },

    /**
     * @param {{connection: object, probe: {identity: string, scopes: string[], teams: string[], expiresAt: number}, now?: number}} args
     * @returns {string|null}
     */
    testConnection({ connection, probe, now = Date.now() }) {
      return _drift({ connection, probe, now, resourceField: 'teams' });
    },

    /**
     * @param {{action: string, repo: string, draft: object, apiBase?: string}} args
     * @returns {{ok: true, method: string, url: string, body: object}|{ok: false, code: string}}
     */
    mapOutboundEvent({ action, repo, draft, apiBase = 'https://api.linear.app' }) {
      if (!UUID.test(repo || '')) return { ok: false, code: 'REPO_INVALID' };
      const origin = _httpsOrigin(apiBase);
      if (!origin) return { ok: false, code: 'BASE_URL_INVALID' };
      if (action === 'createMilestone') return { ...UNSUPPORTED };
      if (action !== 'createIssue') return { ok: false, code: 'ACTION_NOT_ALLOWED' };
      const d = _draft(draft);
      if (!d) return { ok: false, code: 'BAD_DRAFT' };
      if (d.labels.length) return { ok: false, code: 'LABELS_UNSUPPORTED' };
      return {
        ok: true, method: 'POST', url: `${origin}/graphql`,
        body: { query: LINEAR_ISSUE_CREATE, variables: { input: { teamId: repo, title: d.title, description: d.body } } }
      };
    },

    /**
     * `Linear-Signature`: bare hex HMAC-SHA256 of the raw body; then the
     * signed body's `webhookTimestamp` must be within a minute of `now`.
     * @param {{secret: string, rawBody: string|Buffer, signatureHeader: string, now?: number}} args
     * @returns {{ok: boolean, code?: string}}
     */
    verifyWebhookSignature({ secret, rawBody, signatureHeader, now = Date.now() }) {
      if (typeof secret !== 'string' || secret.length < 16) return { ok: false, code: 'SECRET_UNAVAILABLE' };
      if (typeof signatureHeader !== 'string' || !signatureHeader) return { ok: false, code: 'BAD_SIGNATURE' };
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      if (!_safeEqual(signatureHeader, expected)) return { ok: false, code: 'BAD_SIGNATURE' };
      let stamp;
      try {
        stamp = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)).webhookTimestamp;
      } catch {
        return { ok: false, code: 'BAD_PAYLOAD' };
      }
      if (!Number.isFinite(stamp) || Math.abs(now - stamp) > LINEAR_TIMESTAMP_TOLERANCE_MS) return { ok: false, code: 'STALE_DELIVERY' };
      return { ok: true };
    },

    /**
     * @param {{headers: object, payload: object}} args
     * @returns {{ok: true, repo: string, deliveryId: string, eventType: string|null}|{ok: false, code: string}}
     */
    normalizeInboundEvent({ headers, payload }) {
      const h = _lower(headers);
      const deliveryId = h['linear-delivery'];
      if (typeof deliveryId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(deliveryId)) return { ok: false, code: 'BAD_DELIVERY_ID' };
      const repo = payload && payload.data && payload.data.teamId;
      if (typeof repo !== 'string' || !UUID.test(repo)) return { ok: false, code: 'BAD_IDENTITY' };
      return { ok: true, repo, deliveryId, eventType: h['linear-event'] || null };
    },

    /** @returns {{provider: string, actions: object, unsupported: string[]}} */
    capabilities() {
      return { provider: 'linear', actions: LINEAR_ACTIONS, unsupported: ['createMilestone'] };
    }
  };
}

// ── Dolt (DoltHub) ──────────────────────────────────────────────────────

/**
 * DoltHub. Config and drift checks work like the others; everything the
 * documentation gives no way to do safely is refused.
 * @returns {object} A G2a-conforming adapter.
 */
function createDoltProvider() {
  return {
    /**
     * @param {{repo: string, tokenRef: string}} config - `repo` is `owner/database`.
     * @returns {{ok: boolean, code?: string}}
     */
    validateConfig(config) {
      if (!config || typeof config !== 'object') return { ok: false, code: 'CONFIG_INVALID' };
      if (typeof config.repo !== 'string' || !DOLT_REPO.test(config.repo)) return { ok: false, code: 'REPO_INVALID' };
      if (typeof config.tokenRef !== 'string' || !TOKEN_REF.test(config.tokenRef)) return { ok: false, code: 'TOKEN_REF_INVALID' };
      return { ok: true };
    },

    /**
     * @param {{connection: object, probe: {identity: string, scopes: string[], databases: string[], expiresAt: number}, now?: number}} args
     * @returns {string|null}
     */
    testConnection({ connection, probe, now = Date.now() }) {
      return _drift({ connection, probe, now, resourceField: 'databases' });
    },

    /** @returns {{ok: false, code: string}} No documented issue/milestone write exists. */
    mapOutboundEvent() {
      return { ...UNSUPPORTED };
    },

    /** @returns {{ok: false, code: string}} DoltHub documents no delivery authentication: fail closed. */
    verifyWebhookSignature() {
      return { ok: false, code: 'SIGNATURE_UNSUPPORTED' };
    },

    /** @returns {{ok: false, code: string}} An unauthenticatable delivery is never normalized into trusted identity. */
    normalizeInboundEvent() {
      return { ok: false, code: 'SIGNATURE_UNSUPPORTED' };
    },

    /** @returns {{provider: string, actions: object, unsupported: string[]}} */
    capabilities() {
      return { provider: 'dolt', actions: {}, unsupported: ['createIssue', 'createMilestone', 'inboundWebhooks'] };
    }
  };
}

const FACTORIES = Object.freeze({
  gitlab: createGitlabProvider,
  jira: createJiraProvider,
  linear: createLinearProvider,
  dolt: createDoltProvider
});

/**
 * The adapter for `provider`, or null for a provider this module does not
 * adapt (`github` lives in `lib/providers/contract.js`).
 * @param {string} provider
 * @returns {object|null}
 */
function createProviderAdapter(provider) {
  return Object.hasOwn(FACTORIES, provider) ? FACTORIES[provider]() : null;
}

/**
 * Contract verification across every provider here: each adapter passes
 * `validateProviderAdapter`, and its `capabilities()` names itself.
 * @returns {{ok: boolean, results: Array<{provider: string, ok: boolean, code?: string, missing?: string[]}>}}
 */
function verifyContract() {
  const results = PROVIDERS.map((provider) => {
    const adapter = createProviderAdapter(provider);
    const check = validateProviderAdapter(adapter);
    if (!check.ok) return { provider, ...check };
    const caps = adapter.capabilities();
    return caps && caps.provider === provider ? { provider, ok: true } : { provider, ok: false, code: 'CAPABILITIES_MISMATCH' };
  });
  return { ok: results.every((r) => r.ok), results };
}

/**
 * Negotiate one action against a provider: whether it can be done at all,
 * and at what tier/permission — so a caller asks before mapping, and an
 * unsupported action is a named refusal rather than an empty success.
 * @param {string} provider
 * @param {string} action
 * @returns {{ok: true, tier: number, permission: string}|{ok: false, code: string}}
 */
function negotiateCapability(provider, action) {
  const adapter = createProviderAdapter(provider);
  if (!adapter) return { ok: false, code: 'UNKNOWN_PROVIDER' };
  const caps = adapter.capabilities();
  if (Object.hasOwn(caps.actions, action)) return { ok: true, ...caps.actions[action] };
  return { ok: false, code: (caps.unsupported || []).includes(action) ? 'CAPABILITY_UNSUPPORTED' : 'ACTION_NOT_ALLOWED' };
}

module.exports = {
  PROVIDERS,
  createGitlabProvider,
  createJiraProvider,
  createLinearProvider,
  createDoltProvider,
  createProviderAdapter,
  verifyContract,
  negotiateCapability
};
