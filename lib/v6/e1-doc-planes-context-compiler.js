'use strict';

/**
 * v6 (#1151, V6-13 / E1 & E3, Car V60-T2-W1-C): the 4-Plane Documentation
 * Model and its deterministic, budgeted context-assembly compiler, plus the
 * Project SSOT Index generator/validator and two small Sprint/Wave Tracker
 * helpers.
 *
 * Issue #1151 is a vision document — "the exact module layout is not
 * binding... specific numeric thresholds should be established during the
 * inventory rather than invented before baseline measurements exist." This
 * module implements the four CONCRETE deliverables Ruling
 * A555-V60-T2-CHARTER-WAVE-DECOMPOSITION / A555-SUPPLEMENT-COSIGN carved out
 * of that vision for this car:
 *
 * 1. {@link classifyPlane} — a deterministic, path-only classifier into one
 *    of four planes (never mtime/content-based, so the same path always
 *    classifies the same way regardless of when or where it is asked).
 * 2. {@link checkWriteBoundary} — the canonical write-boundary guard: an
 *    automated agent session may not write Plane 1 (product) or Plane 2
 *    (maintainer) documentation without an explicit doc-authoring grant.
 * 3. {@link compileContextBundle} — the budgeted context-assembly compiler:
 *    given an ordered list of candidate paths and a token budget, returns
 *    which ones made it into the bundle, which were excluded and why, and a
 *    sha256 provenance manifest over exactly what was included. Plane 4
 *    (historical-archive) is excluded by default.
 * 4. {@link syncSsotIndex} / {@link validateSsotIndex} — the Project SSOT
 *    Index: an inventory of every canonical (Plane 1 + Plane 2) document,
 *    its plane, and a content hash, so drift between the index and the
 *    documents it describes is mechanically detectable.
 *
 * Plus two native Sprint/Wave Tracker helpers named in the same ruling:
 * {@link checkCarDependencyAdmission} and {@link evaluateWebhookStateAdvance}
 * — both pure functions over caller-supplied state, since this car commits
 * to zero `lib/store/_schema.js` or `server.js` edits and therefore owns no
 * persistence of its own.
 *
 * house style: no `{ok, code}` returns here (unlike
 * `lib/v6/c1-logical-projects.js`'s family) — nothing in this module mutates
 * a database, so there is no CAS/uniqueness conflict class to report; each
 * function instead returns a plain descriptive result object, documented at
 * its own JSDoc.
 *
 * KNOWN GAP (flagged, not silently resolved): `.tangleclaw/ssot-index.json`
 * is this car's named deliverable path, but this repo's own `.gitignore`
 * fail-closes `.tangleclaw/*` as "internal working documents... never in
 * this public repo" (only `.tangleclaw/priming/` is negated back in), and
 * this car's allowed file envelope does not include `.gitignore`. Escalated
 * to PM/Architect; `syncSsotIndex`/`validateSsotIndex` below are fully
 * implemented and tested against an injectable root so the decision doesn't
 * block the rest of the car, but no index file is committed under that path
 * by this PR pending that answer.
 *
 * @module lib/v6/e1-doc-planes-context-compiler
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** The four documentation planes, in authority order (Product principle: "Generated operational memory must not silently become canonical documentation"). */
const PLANES = Object.freeze(['product', 'maintainer', 'operational-memory', 'historical-archive']);

/**
 * Ordered, deterministic plane rules — first match wins. Order matters: more
 * specific archive/product rules sit above the broader `docs/` catch-all so
 * an archived ADR or a product page under `docs/` is not swallowed by the
 * generic maintainer rule below it.
 * @type {Array<{test: (p: string) => boolean, plane: string}>}
 */
const PLANE_RULES = Object.freeze([
  // Plane 4 — historical-archive. Checked first: an archived ADR or plan
  // must never be classified as the canonical maintainer/product doc it
  // once was.
  { test: (p) => /(^|\/)archive\//.test(p), plane: 'historical-archive' },

  // Plane 1 — product documentation (human-first, task-oriented).
  { test: (p) => p === 'README.md', plane: 'product' },
  { test: (p) => p === 'LICENSE' || p === 'LICENSE.md', plane: 'product' },
  { test: (p) => /^docs\/product\//.test(p), plane: 'product' },
  { test: (p) => /^docs\/(getting-started|concepts|security|operations|installation|troubleshooting)\.md$/.test(p), plane: 'product' },

  // Plane 2 — maintainer documentation (canonical technical truth).
  { test: (p) => p === 'CLAUDE.md', plane: 'maintainer' },
  { test: (p) => /^docs\/adr\//.test(p), plane: 'maintainer' },
  { test: (p) => /^docs\/architecture\//.test(p), plane: 'maintainer' },
  { test: (p) => /^docs\//.test(p), plane: 'maintainer' },

  // Plane 3 — operational memory (agent-first, lifecycle-managed). Explicit
  // rules rather than a bare default so the reason a path landed here is
  // legible from the rule table, not merely "matched nothing else."
  { test: (p) => /^\.tangleclaw\/(memories|handoff|continuity|plans)\//.test(p), plane: 'operational-memory' },
  { test: (p) => /^\.prawduct\//.test(p), plane: 'operational-memory' },
  { test: (p) => /^changelog\.d\//.test(p), plane: 'operational-memory' },
  { test: (p) => p === 'CHANGELOG.md' || p === 'FEATURES.md', plane: 'operational-memory' }
]);

/**
 * Classify a repo-relative path into one of {@link PLANES}, deterministically
 * and by path alone — never by reading the file, its mtime, or any other
 * run-time state, so the same path always classifies the same way.
 *
 * The product principle this exists to serve ("generated operational memory
 * must not silently become canonical documentation") means an unmatched path
 * defaults to `operational-memory` — the LEAST authoritative plane — rather
 * than to `maintainer`/`product`: a path nothing here recognizes must never
 * be silently treated as canonical.
 * @param {string} filePath - A path, repo-relative or absolute (normalized
 *   to forward slashes and made repo-relative if it begins with `root`).
 * @param {{root?: string}} [opts] - `root` to strip from an absolute path.
 * @returns {string} One of {@link PLANES}.
 */
function classifyPlane(filePath, opts = {}) {
  const rel = _toRepoRelative(filePath, opts.root);
  for (const rule of PLANE_RULES) {
    if (rule.test(rel)) return rule.plane;
  }
  return 'operational-memory';
}

/**
 * Normalize a path to forward-slash, repo-relative form for rule matching.
 * @param {string} filePath
 * @param {string} [root]
 * @returns {string}
 */
function _toRepoRelative(filePath, root) {
  let p = String(filePath);
  if (root && path.isAbsolute(p)) {
    const rel = path.relative(root, p);
    if (!rel.startsWith('..')) p = rel;
  }
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

/**
 * The canonical write-boundary guard (Ruling A555-SUPPLEMENT-COSIGN): an
 * automated agent session may not write a Plane 1 (product) or Plane 2
 * (maintainer) document without an explicit doc-authoring grant naming that
 * exact path. Planes 3 and 4 are never protected by this guard — operational
 * memory and historical archive are exactly the planes agents are expected
 * to write routinely.
 * @param {string} filePath - The path the caller wants to write.
 * @param {{grant?: {path: string, grantedBy?: string, reason?: string}, root?: string}} [opts] -
 *   `grant`, when present and its `path` matches `filePath` exactly (after
 *   the same repo-relative normalization), authorizes the write.
 * @returns {{allowed: boolean, plane: string, code?: string}} `code` is
 *   `DOC_AUTHORING_GRANT_REQUIRED` on refusal.
 */
function checkWriteBoundary(filePath, opts = {}) {
  const plane = classifyPlane(filePath, opts);
  const protectedPlane = plane === 'product' || plane === 'maintainer';
  if (!protectedPlane) return { allowed: true, plane };
  const grant = opts.grant;
  if (grant && grant.path && _toRepoRelative(grant.path, opts.root) === _toRepoRelative(filePath, opts.root)) {
    return { allowed: true, plane };
  }
  return { allowed: false, plane, code: 'DOC_AUTHORING_GRANT_REQUIRED' };
}

/** A deterministic, dependency-free token estimate (~4 chars/token), used only for budgeting — never billed, never exact. */
function _estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/**
 * Assemble a token-budgeted context bundle from an ordered list of candidate
 * paths, deterministically: given the same paths, budget, and file contents,
 * this always returns the same `included`/`excluded` split and the same
 * manifest hash.
 *
 * Plane 4 (historical-archive) is excluded by default — the one place this
 * module enforces issue #1151's "large files must not be loaded merely
 * because they exist at a conventional path" for the archive plane
 * specifically; pass `includeHistoricalArchive: true` to override per call.
 *
 * Processes `paths` in the given order; a path that would push the running
 * total over `tokenBudget` is excluded (not a hard stop), so a later,
 * smaller candidate can still be included — the caller's own ordering is
 * the only priority signal this function uses.
 * @param {string[]} paths - Candidate paths, in priority order.
 * @param {{tokenBudget?: number, includeHistoricalArchive?: boolean,
 *   root?: string, readFile?: (p: string) => string}} [opts] - `readFile`
 *   defaults to `fs.readFileSync(p, 'utf8')`; injectable for tests.
 * @returns {{included: Array<{path: string, plane: string, tokens: number}>,
 *   excluded: Array<{path: string, plane: string, reason: string}>,
 *   manifest: {sha256: string, generatedAt: string, tokenBudget: number,
 *   usedTokens: number, includedCount: number, excludedCount: number}}}
 */
function compileContextBundle(paths, opts = {}) {
  const tokenBudget = Number.isFinite(opts.tokenBudget) ? opts.tokenBudget : Infinity;
  const includeHistoricalArchive = opts.includeHistoricalArchive === true;
  const readFile = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const included = [];
  const excluded = [];
  let usedTokens = 0;
  const hash = crypto.createHash('sha256');

  for (const p of paths || []) {
    const plane = classifyPlane(p, opts);
    if (plane === 'historical-archive' && !includeHistoricalArchive) {
      excluded.push({ path: p, plane, reason: 'historical-archive excluded by default' });
      continue;
    }
    let content;
    try {
      content = String(readFile(p));
    } catch (err) {
      excluded.push({ path: p, plane, reason: `unreadable: ${err.code || err.message}` });
      continue;
    }
    const tokens = _estimateTokens(content);
    if (usedTokens + tokens > tokenBudget) {
      excluded.push({ path: p, plane, reason: 'token budget exceeded' });
      continue;
    }
    included.push({ path: p, plane, tokens });
    usedTokens += tokens;
    hash.update(p).update('\0').update(content).update('\0');
  }

  return {
    included,
    excluded,
    manifest: {
      sha256: hash.digest('hex'),
      generatedAt: new Date().toISOString(),
      tokenBudget,
      usedTokens,
      includedCount: included.length,
      excludedCount: excluded.length
    }
  };
}

const SSOT_INDEX_VERSION = 1;

/**
 * Recursively list every file under `root` + `dir`, repo-relative,
 * forward-slash, skipping the usual noise (`node_modules`, `.git`) and
 * anything a plane-4 archive rule would already exclude from canonical
 * consideration — the SSOT index only ever inventories canonical docs, and
 * an archived one is by definition no longer canonical.
 * @param {string} root
 * @param {string} dir - repo-relative
 * @returns {string[]}
 */
function _listFilesRepoRelative(root, dir) {
  const abs = path.join(root, dir);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) {
      out.push(..._listFilesRepoRelative(root, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Scan `root` for every canonical (Plane 1 + Plane 2) document and return
 * the SSOT index object `syncSsotIndex`/`validateSsotIndex` share — sorted
 * by path for determinism.
 * @param {string} root
 * @returns {{version: number, generatedAt: string, entries: Array<{path: string, plane: string, sha256: string, bytes: number}>}}
 */
function _buildSsotIndex(root) {
  const candidates = ['README.md', 'LICENSE', 'LICENSE.md', 'CLAUDE.md', ..._listFilesRepoRelative(root, 'docs')];
  const entries = [];
  const seen = new Set();
  for (const rel of candidates) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const plane = classifyPlane(rel);
    if (plane !== 'product' && plane !== 'maintainer') continue;
    const abs = path.join(root, rel);
    let content;
    try {
      content = fs.readFileSync(abs);
    } catch {
      continue;
    }
    entries.push({
      path: rel,
      plane,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      bytes: content.length
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: SSOT_INDEX_VERSION, generatedAt: new Date().toISOString(), entries };
}

/**
 * Generate the Project SSOT Index for `root` and write it to
 * `<root>/<indexPath>`. Deterministic modulo `generatedAt`: the same set of
 * canonical documents with the same content always produces the same
 * `entries` array (sorted, content-hashed).
 * @param {string} root - Project root to scan.
 * @param {{indexPath?: string}} [opts] - `indexPath` defaults to
 *   `.tangleclaw/ssot-index.json`, repo-relative to `root`.
 * @returns {{index: object, writtenTo: string}}
 */
function syncSsotIndex(root, opts = {}) {
  const indexPath = opts.indexPath || '.tangleclaw/ssot-index.json';
  const index = _buildSsotIndex(root);
  const abs = path.join(root, indexPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(index, null, 2)}\n`);
  return { index, writtenTo: indexPath };
}

/**
 * Validate an existing SSOT index against the live documents it describes:
 * every listed path still exists with a matching sha256 (no drift), and no
 * canonical document on disk is missing from the index (no gap).
 * @param {string} root - Project root the index should describe.
 * @param {{indexPath?: string}} [opts] - Same default as {@link syncSsotIndex}.
 * @returns {{ok: boolean, issues: Array<{code: string, path: string}>}}
 *   `code` is one of `INDEX_MISSING`, `INDEX_MALFORMED`, `ENTRY_STALE`
 *   (content drifted), `ENTRY_GONE` (listed path no longer exists), or
 *   `ENTRY_UNINDEXED` (a canonical document on disk the index doesn't list).
 */
function validateSsotIndex(root, opts = {}) {
  const indexPath = opts.indexPath || '.tangleclaw/ssot-index.json';
  const abs = path.join(root, indexPath);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return { ok: false, issues: [{ code: 'INDEX_MISSING', path: indexPath }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, issues: [{ code: 'INDEX_MALFORMED', path: indexPath }] };
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    return { ok: false, issues: [{ code: 'INDEX_MALFORMED', path: indexPath }] };
  }

  const issues = [];
  const indexedPaths = new Set();
  for (const entry of parsed.entries) {
    indexedPaths.add(entry.path);
    const entryAbs = path.join(root, entry.path);
    let content;
    try {
      content = fs.readFileSync(entryAbs);
    } catch {
      issues.push({ code: 'ENTRY_GONE', path: entry.path });
      continue;
    }
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    if (sha256 !== entry.sha256) issues.push({ code: 'ENTRY_STALE', path: entry.path });
  }

  const live = _buildSsotIndex(root);
  for (const entry of live.entries) {
    if (!indexedPaths.has(entry.path)) issues.push({ code: 'ENTRY_UNINDEXED', path: entry.path });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Sprint/Wave Tracker helper 1 of 2: a car is admitted for dispatch only
 * once every car it declares a dependency on has completed. Pure function
 * over caller-supplied state — this module persists nothing of its own.
 * @param {{id: string, dependsOn?: string[]}} car
 * @param {{completedCarIds?: Iterable<string>}} [ctx]
 * @returns {{admitted: boolean, blockedBy: string[]}}
 */
function checkCarDependencyAdmission(car, ctx = {}) {
  const completed = ctx.completedCarIds instanceof Set ? ctx.completedCarIds : new Set(ctx.completedCarIds || []);
  const deps = Array.isArray(car && car.dependsOn) ? car.dependsOn : [];
  const blockedBy = deps.filter((dep) => !completed.has(dep));
  return { admitted: blockedBy.length === 0, blockedBy };
}

/** The webhook-driven sprint/wave tracker's state vocabulary, in lifecycle order. */
const WEBHOOK_TRACKER_STATES = Object.freeze(['queued', 'dispatched', 'in-review', 'merged', 'failed']);

/**
 * `currentState -> eventType -> nextState` — only the forward-progress and
 * failure edges a real CI/review webhook stream can produce; any event not
 * listed for the current state is a no-op (the tracker holds).
 */
const WEBHOOK_TRANSITIONS = Object.freeze({
  queued: { 'car.dispatched': 'dispatched' },
  dispatched: { 'review.requested': 'in-review', 'ci.failure': 'failed' },
  'in-review': { 'review.approved': 'merged', 'review.changes-requested': 'dispatched', 'ci.failure': 'failed' },
  failed: { 'car.dispatched': 'dispatched' }
});

/**
 * Sprint/Wave Tracker helper 2 of 2: given an inbound webhook event and the
 * tracker's current state, decide the next state. Deterministic and
 * side-effect-free — the caller owns persisting the result.
 * @param {{type: string}} event
 * @param {string} currentState - One of {@link WEBHOOK_TRACKER_STATES}.
 * @returns {{nextState: string, advanced: boolean}} `advanced` is false when
 *   the event produced no transition (unrecognized state, or no edge for
 *   this event from the current state) — `nextState` then equals
 *   `currentState`.
 */
function evaluateWebhookStateAdvance(event, currentState) {
  const edges = WEBHOOK_TRANSITIONS[currentState];
  const next = edges && event ? edges[event.type] : undefined;
  if (!next) return { nextState: currentState, advanced: false };
  return { nextState: next, advanced: true };
}

module.exports = {
  PLANES,
  classifyPlane,
  checkWriteBoundary,
  compileContextBundle,
  syncSsotIndex,
  validateSsotIndex,
  checkCarDependencyAdmission,
  evaluateWebhookStateAdvance,
  WEBHOOK_TRACKER_STATES
};
