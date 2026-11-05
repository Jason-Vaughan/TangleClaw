'use strict';

/**
 * The AI documentation router (#2835, Slice 2 of #2070): a repo-wide,
 * versioned Markdown documentation manifest mapping stable topic ids to
 * roles, commands/features, a canonical path + anchor, audience, and
 * lifecycle state — the discovery layer #2070 Slice 1
 * (`lib/operating-primer.js`, `docs/tc-cli-reference.md`) scoped to the
 * `tc` command reference alone; this module broadens it to the whole
 * repo's documentation.
 *
 * `docs/ai-doc-manifest.json` (`tc.ai-doc-manifest/v1`) is the manifest.
 * This module is pure resolution logic over it — one topic id, one role,
 * or one command/feature name resolves to the doc location that answers
 * it, with an explicit fallback when a version-pinned entry doesn't exist.
 * Exposing this through `tc docs` (or any CLI/HTTP surface) is Architect
 * Ruling A501-W1A-R1's Slice 2 (#2887); this module never touches `bin/
 * tc.js`, `lib/tc-verbs.js`, `server.js`, or `public/`.
 *
 * "Resolved against the installed version/commit with explicit fallback"
 * (#2835's own wording): a topic entry MAY declare `validFrom`/
 * `validUntil` (semver strings) to pin it to a version range; {@link
 * resolveTopic} picks the entry matching the caller-supplied version when
 * one is given, and otherwise — or when no versioned entry matches —
 * falls back to the topic's `lifecycleState: "current"` entry, reporting
 * `usedFallback: true` so a caller can tell a version-exact answer from a
 * fallback one. Nothing here reads an installed version itself; a future
 * caller (`tc docs`, #2887) supplies it.
 *
 * @module lib/doc-router
 */

const fs = require('node:fs');

/** Error for AI-doc-manifest input that does not match this module's contract. */
class DocRouterError extends Error {}

function _need(cond, msg) {
  if (!cond) throw new DocRouterError(msg);
}

/** Schema tag of the AI doc manifest. */
const SCHEMA = 'tc.ai-doc-manifest/v1';

/** The two readers a topic may declare it serves — same vocabulary as `lib/product-manual.js`. */
const AUDIENCES = Object.freeze(['human', 'nhe']);

/** A topic's place in its own lifecycle. */
const LIFECYCLE_STATES = Object.freeze(['draft', 'current', 'deprecated']);

/** A bare `MAJOR.MINOR.PATCH` semver string — this module compares versions lexically-by-part, not via a semver library (no npm dependency; see CONTRIBUTING.md). */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function _needShape(obj, where, required, optional = []) {
  _need(obj !== null && typeof obj === 'object' && !Array.isArray(obj), `${where} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) _need(allowed.has(key), `${where} has unknown key "${key.slice(0, 40)}"`);
  for (const key of required) _need(obj[key] !== undefined, `${where}.${key} is missing`);
}

function _needSemver(v, where) {
  _need(typeof v === 'string' && SEMVER_RE.test(v), `${where} must be a MAJOR.MINOR.PATCH version string`);
}

/**
 * Parse a `MAJOR.MINOR.PATCH` string into comparable parts.
 * @param {string} v
 * @returns {[number, number, number]}
 */
function _parseSemver(v) {
  return v.split('.').map(Number);
}

/**
 * Three-way compare two semver strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative if `a < b`, positive if `a > b`, 0 if equal.
 */
function compareSemver(a, b) {
  const pa = _parseSemver(a);
  const pb = _parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Validate one manifest topic.
 * @param {*} topic
 * @param {string} where
 * @returns {void}
 */
function _validateTopic(topic, where) {
  _needShape(topic, where, ['id', 'path', 'anchor', 'audience', 'lifecycleState'], ['roles', 'commands', 'validFrom', 'validUntil']);
  _need(typeof topic.id === 'string' && topic.id.length > 0, `${where}.id must be a non-empty string`);
  _need(typeof topic.path === 'string' && topic.path.length > 0, `${where}.path must be a non-empty string`);
  _need(typeof topic.anchor === 'string' && topic.anchor.length > 0, `${where}.anchor must be a non-empty string`);
  _need(Array.isArray(topic.audience) && topic.audience.length > 0 && topic.audience.every((a) => AUDIENCES.includes(a)),
    `${where}.audience must be a non-empty array drawn from ${AUDIENCES.join(', ')}`);
  _need(LIFECYCLE_STATES.includes(topic.lifecycleState), `${where}.lifecycleState must be one of ${LIFECYCLE_STATES.join(', ')}`);
  if (topic.roles !== undefined) {
    _need(Array.isArray(topic.roles) && topic.roles.every((r) => typeof r === 'string' && r.length > 0), `${where}.roles must be an array of non-empty strings`);
  }
  if (topic.commands !== undefined) {
    _need(Array.isArray(topic.commands) && topic.commands.every((c) => typeof c === 'string' && c.length > 0), `${where}.commands must be an array of non-empty strings`);
  }
  if (topic.validFrom !== undefined) _needSemver(topic.validFrom, `${where}.validFrom`);
  if (topic.validUntil !== undefined) _needSemver(topic.validUntil, `${where}.validUntil`);
  if (topic.validFrom !== undefined && topic.validUntil !== undefined) {
    _need(compareSemver(topic.validFrom, topic.validUntil) <= 0, `${where}.validFrom must not be after ${where}.validUntil`);
  }
}

/**
 * Validate an AI doc manifest document. Topic ids may repeat — a version-
 * pinned topic has one entry per version range sharing the same id — but
 * `(id, validFrom, validUntil)` must be unique, and at most one entry per
 * id may be `lifecycleState: "current"` (the fallback target must be
 * unambiguous).
 * @param {*} doc
 * @returns {void}
 * @throws {DocRouterError}
 */
function validateAiDocManifest(doc) {
  _needShape(doc, 'manifest', ['schema', 'topics']);
  _need(doc.schema === SCHEMA, `manifest.schema must be ${SCHEMA}`);
  _need(Array.isArray(doc.topics), 'manifest.topics must be an array');
  const seenRanges = new Set();
  const currentCountById = new Map();
  doc.topics.forEach((t, i) => {
    _validateTopic(t, `manifest.topics[${i}]`);
    const rangeKey = `${t.id}\u0000${t.validFrom || ''}\u0000${t.validUntil || ''}`;
    _need(!seenRanges.has(rangeKey), `manifest.topics[${i}] repeats id "${t.id}" with the same version range`);
    seenRanges.add(rangeKey);
    if (t.lifecycleState === 'current') currentCountById.set(t.id, (currentCountById.get(t.id) || 0) + 1);
  });
  for (const [id, count] of currentCountById) {
    _need(count <= 1, `topic "${id}" has ${count} entries marked lifecycleState "current" — the fallback target must be unambiguous`);
  }
}

/**
 * Read and validate an AI doc manifest from disk.
 * @param {string} file
 * @returns {object}
 * @throws {DocRouterError}
 */
function readAiDocManifest(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new DocRouterError(`could not read AI doc manifest ${file} (${err.code || 'error'})`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new DocRouterError(`AI doc manifest ${file} is not valid JSON`);
  }
  validateAiDocManifest(doc);
  return doc;
}

/**
 * Every entry sharing a topic id, in manifest order.
 * @param {object} manifest
 * @param {string} topicId
 * @returns {object[]}
 */
function _entriesForTopic(manifest, topicId) {
  return manifest.topics.filter((t) => t.id === topicId);
}

/**
 * Resolve a topic id to the doc location that answers it for a given
 * installed version — explicit about whether the answer was exact or a
 * fallback.
 * @param {object} manifest - A validated AI doc manifest.
 * @param {string} topicId
 * @param {object} [opts]
 * @param {string} [opts.version] - The installed `MAJOR.MINOR.PATCH`. Omitted means "always use the current entry."
 * @returns {{found: true, entry: object, usedFallback: boolean} | {found: false, reason: string}}
 */
function resolveTopic(manifest, topicId, opts = {}) {
  const entries = _entriesForTopic(manifest, topicId);
  if (entries.length === 0) return { found: false, reason: `no topic with id "${topicId}"` };

  if (typeof opts.version === 'string') {
    _needSemver(opts.version, 'opts.version');
    const exact = entries.find((t) =>
      (t.validFrom === undefined || compareSemver(opts.version, t.validFrom) >= 0) &&
      (t.validUntil === undefined || compareSemver(opts.version, t.validUntil) <= 0)
    );
    if (exact) return { found: true, entry: exact, usedFallback: false };
  }

  const current = entries.find((t) => t.lifecycleState === 'current');
  if (current) return { found: true, entry: current, usedFallback: true };
  return { found: false, reason: `topic "${topicId}" has no entry valid for the given version and no "current" fallback` };
}

/**
 * Every topic entry naming a role (its own `lifecycleState: "current"`
 * entry, one per topic id, falling back to the only entry when a topic has
 * no "current" one — e.g. a topic that is only ever "draft").
 * @param {object} manifest
 * @param {string} role
 * @returns {object[]}
 */
function resolveByRole(manifest, role) {
  const byId = new Map();
  for (const t of manifest.topics) {
    if (!Array.isArray(t.roles) || !t.roles.includes(role)) continue;
    const existing = byId.get(t.id);
    if (!existing || t.lifecycleState === 'current') byId.set(t.id, t);
  }
  return [...byId.values()];
}

/**
 * Every topic entry naming a command or feature, same one-per-id
 * preference as {@link resolveByRole}.
 * @param {object} manifest
 * @param {string} command
 * @returns {object[]}
 */
function resolveByCommand(manifest, command) {
  const byId = new Map();
  for (const t of manifest.topics) {
    if (!Array.isArray(t.commands) || !t.commands.includes(command)) continue;
    const existing = byId.get(t.id);
    if (!existing || t.lifecycleState === 'current') byId.set(t.id, t);
  }
  return [...byId.values()];
}

module.exports = {
  DocRouterError,
  SCHEMA,
  AUDIENCES,
  LIFECYCLE_STATES,
  compareSemver,
  validateAiDocManifest,
  readAiDocManifest,
  resolveTopic,
  resolveByRole,
  resolveByCommand
};
