'use strict';

/**
 * v6.5.0 Wave 1 (#3115, Car V650-W1-B): the Portable Fleet Template JSON
 * Spec (`.fleet.json`) schema, validator, and sanitized export/import/
 * preview engine.
 *
 * Backend slice only, same deferral this tree's own sibling modules already
 * document for themselves (`lib/v6/c2-fleet-templates.js`'s own header,
 * `lib/v6/c1-logical-projects.js`'s own header): pure functions over plain
 * objects, zero `server.js` routes, zero `public/**` edits, zero
 * `lib/store/_schema.js` DDL. `exportFleetSpec` takes an already-assembled
 * plain `fleetState` object rather than a live `db` — reading the real
 * logical-project/fleet hierarchy (`lib/v6/c1-logical-projects.js`) into
 * that shape, and actually PROVISIONING the plan `applyFleetSpecImport`
 * returns, are both a later integration-bridge car's job (issue #3115's own
 * Deliverable 2 "Fleet Export & Import API" and Deliverable 4 "Wizard UI
 * Integration" — Wave 2, `public/v6-shell.js` and `server.js`, not this
 * car's file envelope per Ruling A796/PM's corrected scope).
 *
 * Distinct from `lib/v6/c2-fleet-templates.js` (#2984, already shipped,
 * route-wired): that module is an IN-APP starter-template catalog for
 * launching a brand-new fleet from one of 3 fixed presets. This module is a
 * PORTABLE, inter-project/inter-operator SPEC FORMAT — self-contained JSON
 * a fleet can be exported TO or imported FROM, covering roles, recommended
 * engines, rules, a charter template, and shared documents, independent of
 * any one TangleClaw install. The two share vocabulary ("fleet", "seat",
 * "role") because they describe adjacent concepts, not because either
 * wraps or extends the other — no code or schema is shared between them.
 *
 * @module lib/v6/fleet-template-spec
 */

/** This module's own schema version. Written into every spec `exportFleetSpec` produces; `validateFleetSpec` accepts only this exact string today, so a future `"2.0"` spec is a defined migration, not a silent reinterpretation. */
const SCHEMA_VERSION = '1.0';

/** The six roles this fleet's own live vocabulary uses (matching `lib/v6/c2-fleet-templates.js#ROLES`). A spec's `seats[].role` is NOT restricted to this list — issue #3115 explicitly allows a custom role string — this is exposed only as a convenience/reference set for a caller building a spec by hand. */
const BUILTIN_ROLES = Object.freeze(['PM', 'Architect', 'Builder', 'PRR', 'Integrator', 'Observer']);

/** The only engines a spec may recommend or fall back to (issue #3115's own closed list). */
const ENGINES = Object.freeze(['claude', 'codex', 'antigravity', 'aider']);

/** The only two launch policies a seat may declare. */
const LAUNCH_POLICIES = Object.freeze(['immediate', 'on-demand']);

const _isNonBlankString = (v) => typeof v === 'string' && v.trim().length > 0;
const _isString = (v) => typeof v === 'string';
const _isBool = (v) => typeof v === 'boolean';
const _isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const _isArray = (v) => Array.isArray(v);

/**
 * A safe BARE filename for `sharedDocuments[].filename` (PRR-A R1 BLOCKING
 * 1, #3115): a `.fleet.json` is an untrusted artifact a community
 * marketplace can serve, and this field is scaffolded directly onto disk by
 * a later integration-bridge car — an unconstrained string lets a malicious
 * spec name `../../.ssh/authorized_keys` or `/etc/passwd`. No `/` or `\`,
 * no leading dot, 1-128 of `A-Za-z0-9._-`; the `..`-segment check right
 * below this is redundant against this pattern alone (a lone `.` is
 * already the only dot character the charset permits next to another dot)
 * but kept explicit, since "no path separator" is the property that
 * actually matters and is worth stating as its own check rather than
 * leaning on a character class alone.
 * @type {RegExp}
 */
const _SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `metadata.homepageUrl` must be a renderable web link, never `javascript:`/`data:`/any other scheme (PRR-A R1 BLOCKING 1). */
const _HTTP_URL_RE = /^https?:\/\/\S+$/i;

/**
 * Deep-freeze `value` in place and return it: every plain object and array
 * reachable from it, not just the top level (PRR-A R1 BLOCKING 2 — a bare
 * `Object.freeze(value)` leaves every nested object/array mutable, which is
 * exactly how `BUNDLED_FLEET_SPECS['...'].seats.push(...)` could silently
 * corrupt the one shared singleton every caller reads from).
 * @param {*} value
 * @returns {*} `value`, frozen
 */
function _deepFreeze(value) {
  if (_isArray(value) || _isPlainObject(value)) {
    for (const v of _isArray(value) ? value : Object.values(value)) _deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Push one validation failure, in the `{path, message}` shape every
 * `validateFleetSpec` caller reads — `path` is a dotted/bracketed pointer
 * into `spec` (e.g. `seats[2].role`), not a human sentence alone, so a UI
 * can highlight the exact offending field rather than just display text.
 * @param {Array<{path: string, message: string}>} errors
 * @param {string} path
 * @param {string} message
 * @returns {void}
 */
function _fail(errors, path, message) {
  errors.push({ path, message });
}

/**
 * Validate one `seats[]` entry against issue #3115's own field list.
 * `fallbackEngines` and `primingPrompt` are optional; everything else
 * (including `displayNameSuffix`, which may legitimately be an empty
 * string — "no suffix" — so it is checked with `_isString`, not
 * `_isNonBlankString`) is required.
 * @param {*} seat
 * @param {string} path
 * @param {Array<{path: string, message: string}>} errors
 * @returns {void}
 */
function _validateSeat(seat, path, errors) {
  if (!_isPlainObject(seat)) { _fail(errors, path, 'must be an object'); return; }
  if (!_isNonBlankString(seat.seatId)) _fail(errors, `${path}.seatId`, 'must be a non-blank string');
  if (!_isString(seat.displayNameSuffix)) _fail(errors, `${path}.displayNameSuffix`, 'must be a string');
  if (!_isNonBlankString(seat.role)) _fail(errors, `${path}.role`, 'must be a non-blank string (a built-in role or a custom one)');
  if (!_isBool(seat.supervisory)) _fail(errors, `${path}.supervisory`, 'must be a boolean');
  if (!LAUNCH_POLICIES.includes(seat.launchPolicy)) _fail(errors, `${path}.launchPolicy`, `must be one of ${LAUNCH_POLICIES.join(', ')}`);
  if (!ENGINES.includes(seat.recommendedEngine)) _fail(errors, `${path}.recommendedEngine`, `must be one of ${ENGINES.join(', ')}`);
  if (seat.fallbackEngines !== undefined) {
    if (!_isArray(seat.fallbackEngines) || !seat.fallbackEngines.every((e) => ENGINES.includes(e))) {
      _fail(errors, `${path}.fallbackEngines`, `when present, must be an array drawn from ${ENGINES.join(', ')}`);
    }
  }
  if (seat.primingPrompt !== undefined && !_isString(seat.primingPrompt)) {
    _fail(errors, `${path}.primingPrompt`, 'when present, must be a string');
  }
}

/**
 * Validate one `seatGroups` entry (issue #3115's optional "configurable
 * scaling" field, the same `{min, max, default}` shape
 * `lib/v6/c2-fleet-templates.js`'s `large-configurable` template uses for
 * its own groups).
 * @param {*} group
 * @param {string} path
 * @param {Array<{path: string, message: string}>} errors
 * @returns {void}
 */
function _validateSeatGroup(group, path, errors) {
  if (!_isPlainObject(group)) { _fail(errors, path, 'must be an object'); return; }
  for (const key of ['min', 'max', 'default']) {
    if (!Number.isInteger(group[key]) || group[key] < 0) _fail(errors, `${path}.${key}`, 'must be a non-negative integer');
  }
  if (Number.isInteger(group.min) && Number.isInteger(group.max) && group.min > group.max) {
    _fail(errors, path, `min (${group.min}) must not exceed max (${group.max})`);
  }
  if (Number.isInteger(group.min) && Number.isInteger(group.max) && Number.isInteger(group.default)
    && (group.default < group.min || group.default > group.max)) {
    _fail(errors, `${path}.default`, `must be between min (${group.min}) and max (${group.max})`);
  }
}

/**
 * Validate one `rules[]` entry (issue #3115's `session_rules` bundle — the
 * fields named, verbatim, in the issue and this car's dispatch).
 * `severity`'s vocabulary is deliberately open (a non-blank string, not a
 * closed enum): neither the issue nor this repo's own rule-authoring
 * conventions name a fixed set, and inventing one here would be a
 * requirement nobody asked for.
 * @param {*} rule
 * @param {string} path
 * @param {Array<{path: string, message: string}>} errors
 * @returns {void}
 */
function _validateRule(rule, path, errors) {
  if (!_isPlainObject(rule)) { _fail(errors, path, 'must be an object'); return; }
  if (!_isNonBlankString(rule.title)) _fail(errors, `${path}.title`, 'must be a non-blank string');
  if (!_isNonBlankString(rule.category)) _fail(errors, `${path}.category`, 'must be a non-blank string');
  if (!_isNonBlankString(rule.severity)) _fail(errors, `${path}.severity`, 'must be a non-blank string');
  if (!_isNonBlankString(rule.body)) _fail(errors, `${path}.body`, 'must be a non-blank string');
  if (!_isBool(rule.enforcedByHook)) _fail(errors, `${path}.enforcedByHook`, 'must be a boolean');
}

/**
 * Validate `charterTemplate` (issue #3115's exact field list). The whole
 * object is optional on a spec (`null` is accepted — not every template
 * ships a pre-populated charter) but, when present, every one of its own
 * fields is required.
 * @param {*} charter
 * @param {Array<{path: string, message: string}>} errors
 * @returns {void}
 */
function _validateCharterTemplate(charter, errors) {
  if (charter === null || charter === undefined) return;
  const path = 'charterTemplate';
  if (!_isPlainObject(charter)) { _fail(errors, path, 'when present, must be an object (or null)'); return; }
  if (!_isNonBlankString(charter.title)) _fail(errors, `${path}.title`, 'must be a non-blank string');
  if (!_isNonBlankString(charter.mission)) _fail(errors, `${path}.mission`, 'must be a non-blank string');
  if (!_isNonBlankString(charter.scope)) _fail(errors, `${path}.scope`, 'must be a non-blank string');
  if (!_isArray(charter.successCriteria) || !charter.successCriteria.every(_isNonBlankString) || charter.successCriteria.length === 0) {
    _fail(errors, `${path}.successCriteria`, 'must be a non-empty array of non-blank strings');
  }
  if (!_isArray(charter.requiredSignOffRoles) || !charter.requiredSignOffRoles.every(_isNonBlankString) || charter.requiredSignOffRoles.length === 0) {
    _fail(errors, `${path}.requiredSignOffRoles`, 'must be a non-empty array of non-blank strings');
  }
  if (!_isPlainObject(charter.waveTopologyDefaults)) _fail(errors, `${path}.waveTopologyDefaults`, 'must be an object');
}

/**
 * Validate one `sharedDocuments[]` entry: the initial shared markdown
 * artifacts issue #3115 names (a `LANE_QUEUE.md` template, an
 * `ARCHITECTURE.md` template, a role playbook, a review checklist, ...).
 * @param {*} doc
 * @param {string} path
 * @param {Array<{path: string, message: string}>} errors
 * @returns {void}
 */
function _validateSharedDocument(doc, path, errors) {
  if (!_isPlainObject(doc)) { _fail(errors, path, 'must be an object'); return; }
  if (!_isNonBlankString(doc.name)) _fail(errors, `${path}.name`, 'must be a non-blank string');
  if (!_isNonBlankString(doc.filename) || !_SAFE_FILENAME_RE.test(doc.filename) || doc.filename.includes('..')) {
    _fail(errors, `${path}.filename`, 'must be a safe bare filename — no path separators, no ".." segment, no leading dot');
  }
  if (!_isString(doc.content)) _fail(errors, `${path}.content`, 'must be a string (may be empty)');
}

/**
 * Validate `metadata` (issue #3115's exact field list). `tags` is the one
 * array field; every other field is a required non-blank string.
 * @param {*} metadata
 * @param {Array<{path: string, message: string}>} errors
 * @returns {void}
 */
function _validateMetadata(metadata, errors) {
  const path = 'metadata';
  if (!_isPlainObject(metadata)) { _fail(errors, path, 'must be an object'); return; }
  for (const field of ['id', 'name', 'version', 'author', 'description', 'category', 'license']) {
    if (!_isNonBlankString(metadata[field])) _fail(errors, `${path}.${field}`, 'must be a non-blank string');
  }
  if (!_isNonBlankString(metadata.homepageUrl) || !_HTTP_URL_RE.test(metadata.homepageUrl)) {
    _fail(errors, `${path}.homepageUrl`, 'must be an http(s) URL');
  }
  if (!_isArray(metadata.tags) || !metadata.tags.every(_isNonBlankString)) {
    _fail(errors, `${path}.tags`, 'must be an array of non-blank strings');
  }
}

/**
 * Validate a `.fleet.json` spec against this module's schema (#3115
 * Deliverable 1). Never throws — every caller (`previewFleetSpecImport`,
 * `applyFleetSpecImport`, `exportFleetSpec`, and a future route handler)
 * reads a plain `{ok, errors}` result instead, since the one thing this
 * function's every caller needs is the FULL list of problems, not just the
 * first one — a human fixing a hand-written `.fleet.json` (or a UI
 * rendering upload feedback) should see every field that is wrong in one
 * pass, not one error per re-submission.
 * @param {*} spec
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
function validateFleetSpec(spec) {
  const errors = [];
  if (!_isPlainObject(spec)) {
    return { ok: false, errors: [{ path: '', message: 'spec must be an object' }] };
  }
  if (spec.schemaVersion !== SCHEMA_VERSION) {
    _fail(errors, 'schemaVersion', `must be exactly "${SCHEMA_VERSION}"`);
  }
  _validateMetadata(spec.metadata, errors);
  if (!_isArray(spec.seats) || spec.seats.length === 0) {
    _fail(errors, 'seats', 'must be a non-empty array');
  } else {
    spec.seats.forEach((seat, i) => _validateSeat(seat, `seats[${i}]`, errors));
    const seatIds = spec.seats.filter((s) => _isPlainObject(s) && _isNonBlankString(s.seatId)).map((s) => s.seatId);
    if (new Set(seatIds).size !== seatIds.length) _fail(errors, 'seats', 'seatId must be unique across every seat');
    const supervisoryCount = spec.seats.filter((s) => _isPlainObject(s) && s.supervisory === true).length;
    if (supervisoryCount === 0) _fail(errors, 'seats', 'at least one seat must be supervisory (there must be a seat the fleet launches with)');
  }
  if (spec.seatGroups !== undefined) {
    if (!_isPlainObject(spec.seatGroups)) {
      _fail(errors, 'seatGroups', 'when present, must be an object');
    } else {
      for (const [key, group] of Object.entries(spec.seatGroups)) _validateSeatGroup(group, `seatGroups.${key}`, errors);
    }
  }
  if (!_isArray(spec.rules)) {
    _fail(errors, 'rules', 'must be an array (may be empty)');
  } else {
    spec.rules.forEach((rule, i) => _validateRule(rule, `rules[${i}]`, errors));
  }
  _validateCharterTemplate(spec.charterTemplate, errors);
  if (!_isArray(spec.sharedDocuments)) {
    _fail(errors, 'sharedDocuments', 'must be an array (may be empty)');
  } else {
    spec.sharedDocuments.forEach((doc, i) => _validateSharedDocument(doc, `sharedDocuments[${i}]`, errors));
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Absolute filesystem paths to redact from an exported spec's free-text
 * fields (#3115: export must strip "all local filesystem paths, secrets,
 * and session tokens"). Matches a macOS/Linux home-relative absolute path
 * (`/Users/<name>/...`, `/home/<name>/...`) or a Windows one
 * (`C:\Users\<name>\...`) — the two shapes this fleet's own checkouts
 * actually produce — not every conceivable `/`-rooted string, which would
 * also eat ordinary prose mentioning a URL path or a package name.
 * @type {RegExp}
 */
const _PATH_RE = /(?:\/(?:Users|home)\/[^\s"'<>]+|[A-Za-z]:\\Users\\[^\s"'<>]+)/g;

/**
 * Inline secret/token VALUES found inside a string, as opposed to a whole
 * field {@link _SECRET_KEY_RE} drops by its key name (PRR-A R1 WARNING 1):
 * an operator can paste a real credential straight into a free-text field
 * (`primingPrompt`, `rules[].body`, `sharedDocuments[].content`) with no
 * key name at all to catch it by. Covers this fleet's own Anthropic key
 * shape (`sk-ant-...`), the generic OpenAI-style `sk-...` shape, GitHub's
 * `ghp_`/`ghs_` personal/server token prefixes and its `github_pat_`
 * fine-grained one, and a bare `Bearer <token>` HTTP auth header value.
 * Not exhaustive — no fixed pattern list can be — but covers the shapes an
 * operator's own tooling in this ecosystem actually produces.
 * @type {RegExp}
 */
const _INLINE_TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|gh[ps]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|[Bb]earer\s+[A-Za-z0-9._-]{10,}/g;

/**
 * Object keys whose VALUE is dropped entirely on export, never merely
 * redacted — a secret/token is not safe to leave even partially visible.
 * Case-insensitive, matched against the key name alone.
 * @type {RegExp}
 */
const _SECRET_KEY_RE = /token|secret|password|credential|apikey|api_key/i;

/**
 * Redact an absolute filesystem path or an inline secret/token VALUE found
 * inside a string value.
 * @param {string} value
 * @returns {string}
 */
function _redactPaths(value) {
  return value.replace(_PATH_RE, '<path-redacted>').replace(_INLINE_TOKEN_RE, '<token-redacted>');
}

/**
 * Recursively sanitize `value` for export: drop any object key matching
 * {@link _SECRET_KEY_RE} outright, and redact an absolute filesystem path
 * or an inline secret/token value found inside any remaining string
 * (`primingPrompt`, `description`, `body`, `content`, ...) via
 * {@link _redactPaths}. Pure — never mutates `value`; always returns a
 * fresh structure.
 * @param {*} value
 * @returns {*}
 */
function _sanitize(value) {
  if (typeof value === 'string') return _redactPaths(value);
  if (Array.isArray(value)) return value.map(_sanitize);
  if (_isPlainObject(value)) {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (_SECRET_KEY_RE.test(key)) continue;
      out[key] = _sanitize(v);
    }
    return out;
  }
  return value;
}

/**
 * Export an existing fleet/project as a sanitized, portable `.fleet.json`
 * object (#3115 Deliverable 2's export half — the sanitization and schema
 * assembly only; reading the real fleet into `fleetState` and serving the
 * result over HTTP is the later route-handler car's job, not this
 * module's).
 *
 * `fleetState` is a plain object already shaped like a `.fleet.json` body
 * MINUS `schemaVersion` (this function stamps the current one) — the
 * caller assembles `metadata`/`seats`/`rules`/`charterTemplate`/
 * `sharedDocuments` from whatever live source it reads (the real fleet's
 * seats, rules, charter, shared docs), in whatever shape it has them in,
 * BEFORE this function sanitizes and validates. A `fleetState` missing a
 * field entirely is treated the same as that field being absent on any
 * other spec: `validateFleetSpec` names it.
 * @param {object} fleetState
 * @param {object} [options] - Reserved for a future car; unused today.
 * @returns {{ok: boolean, spec?: object, errors?: Array<{path: string, message: string}>}}
 */
function exportFleetSpec(fleetState, options = {}) {
  const sanitized = _sanitize(_isPlainObject(fleetState) ? fleetState : {});
  const spec = {
    schemaVersion: SCHEMA_VERSION,
    metadata: sanitized.metadata,
    seats: sanitized.seats,
    seatGroups: sanitized.seatGroups,
    rules: sanitized.rules,
    charterTemplate: sanitized.charterTemplate === undefined ? null : sanitized.charterTemplate,
    sharedDocuments: sanitized.sharedDocuments
  };
  if (spec.seatGroups === undefined) delete spec.seatGroups;
  const validation = validateFleetSpec(spec);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, spec };
}

/**
 * Validate a `.fleet.json` spec and return a dry-run preview — what
 * importing it would create, without creating anything (#3115 Deliverable
 * 2's "Validate & Preview" half).
 * @param {*} spec
 * @returns {{ok: boolean, errors?: Array<{path: string, message: string}>, preview?: object}}
 */
function previewFleetSpecImport(spec) {
  const validation = validateFleetSpec(spec);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const seats = spec.seats;
  const immediateSeatCount = seats.filter((s) => s.launchPolicy === 'immediate').length;
  const onDemandSeatCount = seats.length - immediateSeatCount;
  const recommendedEngineCounts = {};
  for (const seat of seats) recommendedEngineCounts[seat.recommendedEngine] = (recommendedEngineCounts[seat.recommendedEngine] || 0) + 1;
  return {
    ok: true,
    preview: {
      metadata: structuredClone(spec.metadata),
      seatCount: seats.length,
      immediateSeatCount,
      onDemandSeatCount,
      recommendedEngineCounts,
      rulesCount: spec.rules.length,
      charterSummary: spec.charterTemplate ? { title: spec.charterTemplate.title, mission: spec.charterTemplate.mission } : null,
      sharedDocumentNames: spec.sharedDocuments.map((d) => d.name)
    }
  };
}

/**
 * Validate a `.fleet.json` spec and return the complete provisioning PLAN
 * — the seats to create, engines to assign, rules to seed, charter to
 * apply, and shared documents to scaffold (#3115 Deliverable 2's "Import &
 * Provision" half). Returns a plan as plain data; it does not create a
 * session, write a file, or touch a database — the same deferral
 * `lib/v6/c2-fleet-templates.js#planFleetApply` already documents for its
 * own, unrelated plan shape.
 * @param {*} spec
 * @param {object} [options] - Reserved for a future car; unused today.
 * @returns {{ok: boolean, errors?: Array<{path: string, message: string}>, plan?: object}}
 */
function applyFleetSpecImport(spec, options = {}) {
  const validation = validateFleetSpec(spec);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return {
    ok: true,
    // structuredClone, not a per-field shallow `{...spec.field}` copy (PRR-A
    // R1 BLOCKING 2): a shallow copy still shares every NESTED array/object
    // (a seat's `fallbackEngines`, a seat group's `{min,max,default}`, a
    // charter's `successCriteria`) with `spec` by reference, so mutating the
    // plan silently mutated the caller's own input spec — and, for a
    // BUNDLED_FLEET_SPECS entry passed straight through, the one shared
    // module singleton every other caller reads from.
    plan: {
      metadata: structuredClone(spec.metadata),
      seats: structuredClone(spec.seats),
      seatGroups: spec.seatGroups ? structuredClone(spec.seatGroups) : undefined,
      rules: structuredClone(spec.rules),
      charterTemplate: spec.charterTemplate ? structuredClone(spec.charterTemplate) : null,
      sharedDocuments: structuredClone(spec.sharedDocuments)
    }
  };
}

/**
 * The two flagship reference `.fleet.json` specs this module ships out of
 * the box (#3115 Deliverable 3), each a complete, `validateFleetSpec`-passing
 * example an operator can import verbatim or fork.
 *
 * `software-factory-10-role` is modeled on this very fleet's own live
 * `TC-Lane-*` roster (PM, Architect, 4 Builders, 2 PR Reviewers, Integrator,
 * Observer — the same roles `lib/v6/c2-fleet-templates.js`'s
 * `recommended-10-role` template seats, in the portable spec SHAPE this
 * module defines instead of that module's in-app template shape) and its
 * Gate 0 / O-Gate / R-Gate / M-Gate review rules.
 *
 * `ai-design-agency` is modeled on the `TangleVision` (`TV-*`) roster
 * observed on this same host (a PM, an Art Director, three parallel design
 * lanes, a Critic, an Integrator, and an Observer) — deliberately using two
 * CUSTOM role strings (`ArtDir`, `Critic`) rather than only
 * {@link BUILTIN_ROLES}, since issue #3115 explicitly allows a custom role
 * and a bundled example that never exercised that path would be a weaker
 * reference than one that does.
 * @type {Readonly<Record<string, object>>}
 */
const BUNDLED_FLEET_SPECS = _deepFreeze({
  'software-factory-10-role': Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    metadata: {
      id: 'software-factory-10-role',
      name: 'Autonomous Software Factory',
      version: '1.0.0',
      author: 'TangleClaw',
      description: 'A 10-seat software engineering fleet: one Project Manager, one Architect, four parallel Builders, two independent PR Reviewers, one Integrator who is the sole merge executor, and one Observer running release gates.',
      category: 'Software Engineering',
      tags: ['software-engineering', 'builder-fleet', 'code-review', 'release-gates'],
      homepageUrl: 'https://tangleclaw.com/marketplace/software-factory-10-role',
      license: 'MIT'
    },
    seats: [
      { seatId: 'pm', displayNameSuffix: 'PM', role: 'PM', supervisory: true, launchPolicy: 'immediate', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are the Project Manager. Plan and dispatch work to Builder lanes under the active sprint charter; you never edit code or merge yourself.' },
      { seatId: 'architect', displayNameSuffix: 'Architect', role: 'Architect', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are the Architect. Review and co-sign scope/design decisions and sensitive-gate PRs before they merge.' },
      { seatId: 'builder-a', displayNameSuffix: 'Builder A', role: 'Builder', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex', 'antigravity'], primingPrompt: 'You are a Builder. Execute your assigned issues inside your authorized file scope, and open a PR when your branch is green.' },
      { seatId: 'builder-b', displayNameSuffix: 'Builder B', role: 'Builder', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex', 'antigravity'], primingPrompt: 'You are a Builder. Execute your assigned issues inside your authorized file scope, and open a PR when your branch is green.' },
      { seatId: 'builder-c', displayNameSuffix: 'Builder C', role: 'Builder', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex', 'antigravity'], primingPrompt: 'You are a Builder. Execute your assigned issues inside your authorized file scope, and open a PR when your branch is green.' },
      { seatId: 'builder-d', displayNameSuffix: 'Builder D', role: 'Builder', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex', 'antigravity'], primingPrompt: 'You are a Builder. Execute your assigned issues inside your authorized file scope, and open a PR when your branch is green.' },
      { seatId: 'prr-a', displayNameSuffix: 'PR Reviewer A', role: 'PRR', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are an independent PR reviewer. Assess whether a changeset is ready to merge; you never fix the code yourself.' },
      { seatId: 'prr-b', displayNameSuffix: 'PR Reviewer B', role: 'PRR', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are an independent PR reviewer. Assess whether a changeset is ready to merge; you never fix the code yourself.' },
      { seatId: 'integrator', displayNameSuffix: 'Integrator', role: 'Integrator', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are the Integrator, the sole merge/deploy executor. Merge an approved PR once every required gate has passed.' },
      { seatId: 'observer', displayNameSuffix: 'Observer', role: 'Observer', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are the Observer. Independently verify scope, test evidence, and gate state before a car is certified ready to merge.' }
    ],
    rules: [
      { title: 'Gate 0: every car needs an Architect-cosigned charter before building', category: 'governance', severity: 'blocking', body: 'A Builder may not start a car until the Architect has co-signed its scope and file allowlist.', enforcedByHook: false },
      { title: 'O-Gate: the Observer certifies scope and evidence before merge', category: 'release', severity: 'blocking', body: "A PR's file scope, issue closure, and test evidence must be independently verified by the Observer before it may merge.", enforcedByHook: false },
      { title: 'R-Gate: an independent PR Reviewer must approve before merge', category: 'review', severity: 'blocking', body: 'Every PR needs an explicit APPROVE verdict from a PR Reviewer who did not author it.', enforcedByHook: false },
      { title: 'Only the Integrator merges', category: 'process', severity: 'blocking', body: 'A Builder never runs the merge itself, even once its PR is approved; only the Integrator seat executes merges.', enforcedByHook: true }
    ],
    charterTemplate: {
      title: 'Software Factory Sprint Charter',
      mission: 'Ship a bounded set of GitHub issues as disjoint, independently reviewable Builder cars within one sprint.',
      scope: 'Named issues only; anything discovered mid-build that is out of scope is filed as a new issue, not silently folded in.',
      successCriteria: ['Every chartered issue is closed by a merged PR', 'Every merge passed Gate 0, R-Gate, and O-Gate', 'No sprint-charter file was edited by a Builder lane'],
      requiredSignOffRoles: ['PM', 'Architect'],
      waveTopologyDefaults: { maxParallelCars: 4, maxIssuesPerCar: 3 }
    },
    sharedDocuments: [
      { name: 'LANE_QUEUE', filename: 'LANE_QUEUE.md', content: '# Active Lane Queue\n\n- **Sprint State:** _(fill in when the sprint charter is drafted)_\n\n## Wave 1\n\n| Car ID | Lane | Reviewer | Issues | Allowed File Scope | Status |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n' },
      { name: 'ARCHITECTURE', filename: 'ARCHITECTURE.md', content: '# Architecture\n\n_(fill in this fleet\'s own system design once the first car lands)_\n' }
    ]
  }),
  'ai-design-agency': Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    metadata: {
      id: 'ai-design-agency',
      name: 'AI Design & Creative Agency',
      version: '1.0.0',
      author: 'TangleClaw',
      description: 'A design-studio fleet: one Project Manager, one Art Director setting the visual direction, three parallel design lanes, a design Critic, an Integrator, and an Observer.',
      category: 'Design & Creative',
      tags: ['design', 'creative', 'visual-direction', 'review-gates'],
      homepageUrl: 'https://tangleclaw.com/marketplace/ai-design-agency',
      license: 'MIT'
    },
    seats: [
      { seatId: 'pm', displayNameSuffix: 'PM', role: 'PM', supervisory: true, launchPolicy: 'immediate', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are the Project Manager. Plan and dispatch design work to the lanes under the active brief; you never produce deliverables yourself.' },
      { seatId: 'art-director', displayNameSuffix: 'Art Director', role: 'ArtDir', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are the Art Director. Set and co-sign the visual direction every lane\'s work must follow before it is reviewed.' },
      { seatId: 'lane-a', displayNameSuffix: 'Lane A', role: 'Builder', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex', 'antigravity'], primingPrompt: 'You are a design lane. Produce your assigned deliverable to the Art Director\'s brief, then submit it for Critic review.' },
      { seatId: 'lane-b', displayNameSuffix: 'Lane B', role: 'Builder', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex', 'antigravity'], primingPrompt: 'You are a design lane. Produce your assigned deliverable to the Art Director\'s brief, then submit it for Critic review.' },
      { seatId: 'lane-c', displayNameSuffix: 'Lane C', role: 'Builder', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex', 'antigravity'], primingPrompt: 'You are a design lane. Produce your assigned deliverable to the Art Director\'s brief, then submit it for Critic review.' },
      { seatId: 'critic', displayNameSuffix: 'Critic', role: 'Critic', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are the design Critic, an independent reviewer. Assess a lane\'s deliverable against the brief and the Art Director\'s direction; you never produce the deliverable yourself.' },
      { seatId: 'integrator', displayNameSuffix: 'Integrator', role: 'Integrator', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are the Integrator, the sole merge/publish executor for approved deliverables.' },
      { seatId: 'observer', displayNameSuffix: 'Observer', role: 'Observer', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'claude', fallbackEngines: ['codex'], primingPrompt: 'You are the Observer. Independently verify brief conformance and review evidence before a deliverable is certified ready to publish.' }
    ],
    rules: [
      { title: 'Every deliverable needs the Art Director\'s co-signed brief before work starts', category: 'governance', severity: 'blocking', body: 'A lane may not begin a deliverable until the Art Director has co-signed its brief and visual direction.', enforcedByHook: false },
      { title: 'The Critic reviews every deliverable independently', category: 'review', severity: 'blocking', body: 'A deliverable needs an explicit APPROVE from the Critic, who did not produce it, before it may be marked ready.', enforcedByHook: false },
      { title: 'Only the Integrator publishes', category: 'process', severity: 'blocking', body: 'A lane never publishes its own deliverable, even once approved; only the Integrator seat executes a publish.', enforcedByHook: true }
    ],
    charterTemplate: {
      title: 'Design Agency Engagement Charter',
      mission: 'Deliver a bounded set of design assets against one brief within one engagement.',
      scope: 'The named brief only; a scope change mid-engagement is a new, separately chartered brief, not a silent addition.',
      successCriteria: ['Every chartered deliverable is Critic-approved and published', 'Every deliverable matches the Art Director\'s co-signed direction'],
      requiredSignOffRoles: ['PM', 'ArtDir'],
      waveTopologyDefaults: { maxParallelCars: 3, maxIssuesPerCar: 1 }
    },
    sharedDocuments: [
      { name: 'LANE_QUEUE', filename: 'LANE_QUEUE.md', content: '# Active Lane Queue\n\n- **Engagement State:** _(fill in when the brief is drafted)_\n\n| Lane | Reviewer | Deliverable | Status |\n| :--- | :--- | :--- | :--- |\n' },
      { name: 'BRAND_DIRECTION', filename: 'BRAND_DIRECTION.md', content: '# Brand & Visual Direction\n\n_(fill in the Art Director\'s own direction once the first brief lands)_\n' }
    ]
  })
});

/**
 * Metadata for the `tangleclaw.com` ecosystem directory link (#3115
 * Deliverable 3's "plus `tangleclaw.com` ecosystem marketplace directory
 * link metadata"). Plain data, not a live fetch — `public/v6-shell.js`'s
 * own Wizard banner (a later, Wave 2 car) is what actually renders a link
 * from this.
 * @returns {{marketplaceUrl: string, description: string}}
 */
function getEcosystemDirectoryInfo() {
  return {
    marketplaceUrl: 'https://tangleclaw.com/marketplace',
    description: 'Browse, download, or share community and creator .fleet.json templates on the tangleclaw.com ecosystem directory.'
  };
}

module.exports = {
  SCHEMA_VERSION,
  BUILTIN_ROLES,
  ENGINES,
  LAUNCH_POLICIES,
  validateFleetSpec,
  exportFleetSpec,
  previewFleetSpecImport,
  applyFleetSpecImport,
  BUNDLED_FLEET_SPECS,
  getEcosystemDirectoryInfo,
  _sanitize
};
