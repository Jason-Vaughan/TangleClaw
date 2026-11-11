'use strict';

/**
 * v6 (#2995, V6-25 / B3, Car V61-W1-B): the scoped settings catalog, the
 * override inspector, and the Settings Assistant's preview/commit core.
 *
 * Three pieces, all server-side and pure apart from the injected store:
 *
 * - **Catalog** ({@link CATALOG}): the only settings the assistant may
 *   touch. Each key names the scopes that may set it, whether a narrower
 *   scope's value overrides a wider one (`inherits`), a validator, and the
 *   plain-language description {@link explainSetting} returns. Credentials,
 *   deletions, `auto` fleet launch, engine failover grants, host settings
 *   and attribution defaults are deliberately absent: each needs its own
 *   authority design (Phase 4 spike).
 * - **Override inspector** ({@link inspectOverrides}): given a key and the
 *   stored values along a scope chain (resource → fleet → project →
 *   global), reports which scope supplies the effective value and which
 *   values it shadows.
 * - **Assistant** ({@link createSettingsAssistant}): AI text is a
 *   suggestion, never a credential. A verified principal previews a typed
 *   patch, which yields a revision-pinned diff; the same principal then
 *   commits that exact preview, once, before it expires. A changed
 *   principal, scope denial, revision change or expiry refuses. The write
 *   is the store's compare-and-swap, and the result carries the store's
 *   readback, never an assumed value.
 *
 * Adapted from the PRR-B Phase 4 spike (`lib/settings-assistant.js`), with
 * these departures, each covered by a test: the catalog is keyed by
 * setting (with its allowed scopes) instead of one key per scope, so the
 * inspector has something to resolve; pending previews are bounded
 * ({@link MAX_PENDING_PREVIEWS}) and expired ones pruned, where the spike's
 * Map grew without limit; a preview whose store CAS loses a race is marked
 * spent so it cannot be retried into a later revision.
 *
 * Wave 1 scope (Charter A624): no `server.js` route, no `public/**` page,
 * no `lib/store/_schema.js` table. Previews live in the assistant instance;
 * the spike's production note — persist previews and consume one in the
 * same transaction as the setting's CAS — is Wave 2's, together with the
 * adapter onto each existing settings endpoint.
 *
 * @module lib/v6/b3-settings-assistant
 */

const crypto = require('node:crypto');

/** Scope kinds, most specific first: the order an override chain resolves in. */
const SCOPE_KINDS = Object.freeze(['resource', 'fleet', 'project', 'global']);

/** How long a preview may wait for its commit. */
const PREVIEW_TTL_MS = 5 * 60 * 1000;

/** Most previews an assistant instance holds pending at once. */
const MAX_PENDING_PREVIEWS = 256;

/** Most keys one patch may change. */
const MAX_PATCH_KEYS = 8;

/**
 * Every setting the assistant may read, explain, preview or commit.
 * `scopes` lists where it may be stored; `inherits` says whether a narrower
 * scope's value overrides a wider one's (false: each scope stands alone).
 */
const CATALOG = Object.freeze({
  telemetryVisible: Object.freeze({
    scopes: Object.freeze(['global', 'project', 'fleet', 'resource']),
    inherits: true,
    validate: (v) => typeof v === 'boolean',
    description: 'Whether the telemetry header is shown. Hiding it never stops collection.'
  }),
  defaultEngine: Object.freeze({
    scopes: Object.freeze(['global', 'project', 'fleet']),
    inherits: true,
    validate: (v) => typeof v === 'string' && /^[a-z0-9-]{1,60}$/.test(v),
    description: 'The engine a new session launches with when none is chosen. Takes effect at the next launch.'
  }),
  launchMode: Object.freeze({
    scopes: Object.freeze(['project', 'fleet']),
    inherits: true,
    validate: (v) => v === 'manual' || v === 'offer',
    description: 'How the scheduler starts work: manual waits for the operator; offer proposes and waits for acceptance. Auto is not settable here.'
  }),
  displayName: Object.freeze({
    scopes: Object.freeze(['fleet', 'resource']),
    inherits: false,
    validate: (v) => typeof v === 'string' && v.trim().length >= 1 && v.length <= 160,
    description: 'The name shown for this fleet or resource. Each scope names itself; nothing inherits it.'
  })
});

/** A typed refusal: `code` is stable for callers and routes. */
class SettingsAssistantError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = 'SettingsAssistantError';
    this.code = code;
  }
}

/**
 * @param {string} code
 * @returns {never}
 */
function refuse(code) {
  throw new SettingsAssistantError(code);
}

/**
 * Deep-copy a JSON value.
 * @param {*} value
 * @returns {*}
 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * The catalog entry for `key`, or null for a key the assistant may not touch.
 * @param {string} key
 * @returns {object|null}
 */
function catalogEntry(key) {
  return typeof key === 'string' && Object.hasOwn(CATALOG, key) ? CATALOG[key] : null;
}

/**
 * Explain one setting in plain language, for the assistant to quote rather
 * than generate.
 * @param {string} key
 * @returns {{key: string, description: string, scopes: string[], inherits: boolean}}
 * @throws {SettingsAssistantError} `UNKNOWN_SETTING`.
 */
function explainSetting(key) {
  const entry = catalogEntry(key);
  if (!entry) refuse('UNKNOWN_SETTING');
  return { key, description: entry.description, scopes: [...entry.scopes], inherits: entry.inherits };
}

/**
 * Validate a patch for one scope kind: a plain object of 1–{@link MAX_PATCH_KEYS}
 * catalog keys, each allowed at that kind and passing its validator.
 * @param {string} kind - One of {@link SCOPE_KINDS}.
 * @param {object} patch
 * @returns {string[]} The patch's keys.
 * @throws {SettingsAssistantError} `BAD_PATCH`.
 */
function validatePatch(kind, patch) {
  if (!SCOPE_KINDS.includes(kind) || !patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.getPrototypeOf(patch) !== Object.prototype) refuse('BAD_PATCH');
  const keys = Object.keys(patch);
  if (!keys.length || keys.length > MAX_PATCH_KEYS) refuse('BAD_PATCH');
  for (const key of keys) {
    const entry = catalogEntry(key);
    if (!entry || !entry.scopes.includes(kind) || !entry.validate(patch[key])) refuse('BAD_PATCH');
  }
  return keys;
}

/**
 * Resolve a setting along a scope chain and say where its effective value
 * comes from. `chain` lists the scopes from most specific to global; a
 * scope with no stored value (`value === undefined`) is skipped. For a
 * non-inheriting key only the first scope in the chain counts.
 * @param {string} key
 * @param {Array<{kind: string, scopeId?: string|null, value?: *}>} chain
 * @returns {{key: string, effective: *, source: {kind: string, scopeId: string|null}|null,
 *   layers: Array<{kind: string, scopeId: string|null, set: boolean, value: *, state: 'effective'|'shadowed'|'unset'|'not-inherited'}>}}
 * @throws {SettingsAssistantError} `UNKNOWN_SETTING`, `BAD_CHAIN`.
 */
function inspectOverrides(key, chain) {
  const entry = catalogEntry(key);
  if (!entry) refuse('UNKNOWN_SETTING');
  if (!Array.isArray(chain) || !chain.length) refuse('BAD_CHAIN');
  let lastRank = -1;
  for (const layer of chain) {
    const rank = layer ? SCOPE_KINDS.indexOf(layer.kind) : -1;
    if (rank <= lastRank) refuse('BAD_CHAIN');
    lastRank = rank;
  }
  let source = null;
  let effective;
  const layers = chain.map((layer, index) => {
    const set = layer.value !== undefined && entry.scopes.includes(layer.kind);
    const out = { kind: layer.kind, scopeId: layer.scopeId == null ? null : String(layer.scopeId), set, value: set ? clone(layer.value) : null };
    if (!entry.inherits && index > 0) return { ...out, state: 'not-inherited' };
    if (!set) return { ...out, state: 'unset' };
    if (source) return { ...out, state: 'shadowed' };
    source = { kind: out.kind, scopeId: out.scopeId };
    effective = clone(layer.value);
    return { ...out, state: 'effective' };
  });
  return { key, effective: source ? effective : null, source, layers };
}

/**
 * An in-memory settings store with the CAS interface the assistant needs.
 * Production supplies the same `read`/`cas` over each settings endpoint's
 * own write transaction.
 * @param {Array<{scope: string, revision: number, value: object}>} seed
 * @returns {{read: (scope: string) => {revision: number, value: object}|null,
 *   cas: (scope: string, revision: number, next: object) => {revision: number, value: object}|null}}
 */
function createMemorySettingsStore(seed) {
  const rows = new Map((seed || []).map((r) => [r.scope, { revision: r.revision, value: clone(r.value) }]));
  return {
    read(scope) {
      const row = rows.get(scope);
      return row ? clone(row) : null;
    },
    cas(scope, revision, next) {
      const row = rows.get(scope);
      if (!row || row.revision !== revision) return null;
      const updated = { revision: revision + 1, value: clone(next) };
      rows.set(scope, updated);
      return clone(updated);
    }
  };
}

/**
 * Create a Settings Assistant over a CAS store.
 * @param {ReturnType<typeof createMemorySettingsStore>} store
 * @param {{authenticate: (context: object) => {id: string, verified: boolean}|null,
 *   authorize: (principal: object, scope: string, operation: 'settings.preview'|'settings.commit') => boolean,
 *   now?: () => number, id?: () => string}} deps
 * @returns {{preview: (req: object) => object, commit: (req: object) => object, pendingCount: () => number}}
 * @throws {TypeError} When a dependency is missing.
 */
function createSettingsAssistant(store, { authenticate, authorize, now = () => Date.now(), id = () => crypto.randomUUID() } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.cas !== 'function'
      || typeof authenticate !== 'function' || typeof authorize !== 'function') {
    throw new TypeError('settings assistant needs a store, authenticate and authorize');
  }
  const previews = new Map();

  function principal(context) {
    const p = authenticate(context);
    if (!p || typeof p.id !== 'string' || !p.id || p.verified !== true) refuse('PRINCIPAL_UNVERIFIED');
    return p;
  }

  function scopeKey(kind, scopeId) {
    if (!SCOPE_KINDS.includes(kind)) refuse('BAD_SCOPE');
    if (kind === 'global') return 'global:global';
    if (typeof scopeId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(scopeId)) refuse('BAD_SCOPE');
    return `${kind}:${scopeId}`;
  }

  function prune() {
    const t = now();
    for (const [key, item] of previews) {
      if (item.status !== 'pending' || t >= item.expiresAt) previews.delete(key);
    }
  }

  /**
   * Preview a patch: validate it against the catalog, read the scope's
   * current revision, and return the diff a commit would apply.
   * @param {{kind: string, scopeId?: string, patch: object, context: object, source?: string}} req
   * @returns {{previewId: string, kind: string, scopeId: string|null, expectedRevision: number,
   *   expiresAt: number, diff: Array<{op: string, path: string, before: *, after: *}>, source: string}}
   * @throws {SettingsAssistantError} `PRINCIPAL_UNVERIFIED`, `BAD_SCOPE`, `SCOPE_DENIED`, `BAD_PATCH`,
   *   `SETTING_NOT_FOUND`, `NO_CHANGE`, `PREVIEW_LIMIT`.
   */
  function preview({ kind, scopeId, patch, context, source = 'assistant-suggestion' } = {}) {
    const p = principal(context);
    const scope = scopeKey(kind, scopeId);
    if (!authorize(p, scope, 'settings.preview')) refuse('SCOPE_DENIED');
    const keys = validatePatch(kind, patch);
    const old = store.read(scope);
    if (!old || !Number.isSafeInteger(old.revision) || !old.value || typeof old.value !== 'object') refuse('SETTING_NOT_FOUND');
    const next = { ...old.value, ...clone(patch) };
    const diff = keys
      .filter((key) => JSON.stringify(old.value[key]) !== JSON.stringify(next[key]))
      .map((key) => ({
        op: Object.hasOwn(old.value, key) ? 'replace' : 'add',
        path: `/${key}`,
        before: old.value[key] === undefined ? null : clone(old.value[key]),
        after: clone(next[key])
      }));
    if (!diff.length) refuse('NO_CHANGE');
    prune();
    if (previews.size >= MAX_PENDING_PREVIEWS) refuse('PREVIEW_LIMIT');
    const item = {
      id: id(), principalId: p.id, kind, scopeId: kind === 'global' ? null : scopeId, scope,
      expectedRevision: old.revision, next, diff, source: String(source),
      expiresAt: now() + PREVIEW_TTL_MS, status: 'pending'
    };
    previews.set(item.id, item);
    return {
      previewId: item.id, kind, scopeId: item.scopeId, expectedRevision: item.expectedRevision,
      expiresAt: item.expiresAt, diff: clone(diff), source: item.source
    };
  }

  /**
   * Commit a pending preview exactly as previewed, once.
   * @param {{previewId: string, context: object}} req
   * @returns {{previewId: string, actor: string, scope: string, oldRevision: number, newRevision: number,
   *   diff: object[], effective: object, accepted: true}}
   * @throws {SettingsAssistantError} `PRINCIPAL_UNVERIFIED`, `PREVIEW_NOT_FOUND`, `PRINCIPAL_CHANGED`,
   *   `PREVIEW_ALREADY_USED`, `PREVIEW_EXPIRED`, `SCOPE_DENIED`, `STALE_REVISION`.
   */
  function commit({ previewId, context } = {}) {
    const p = principal(context);
    const item = previews.get(previewId);
    if (!item) refuse('PREVIEW_NOT_FOUND');
    if (item.principalId !== p.id) refuse('PRINCIPAL_CHANGED');
    if (item.status !== 'pending') refuse('PREVIEW_ALREADY_USED');
    if (now() >= item.expiresAt) {
      item.status = 'expired';
      refuse('PREVIEW_EXPIRED');
    }
    if (!authorize(p, item.scope, 'settings.commit')) refuse('SCOPE_DENIED');
    const current = store.read(item.scope);
    if (!current || current.revision !== item.expectedRevision) {
      item.status = 'stale';
      refuse('STALE_REVISION');
    }
    const updated = store.cas(item.scope, item.expectedRevision, item.next);
    if (!updated) {
      item.status = 'stale';
      refuse('STALE_REVISION');
    }
    item.status = 'committed';
    return {
      previewId, actor: p.id, scope: item.scope, oldRevision: item.expectedRevision,
      newRevision: updated.revision, diff: clone(item.diff), effective: clone(updated.value), accepted: true
    };
  }

  return { preview, commit, pendingCount() { prune(); return previews.size; } };
}

module.exports = {
  SCOPE_KINDS,
  PREVIEW_TTL_MS,
  MAX_PENDING_PREVIEWS,
  MAX_PATCH_KEYS,
  CATALOG,
  SettingsAssistantError,
  explainSetting,
  validatePatch,
  inspectOverrides,
  createMemorySettingsStore,
  createSettingsAssistant
};
