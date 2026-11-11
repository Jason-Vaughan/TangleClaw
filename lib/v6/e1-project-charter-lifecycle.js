'use strict';

/**
 * v6 (#2126, V6-16 / E1, Car V60-T3-W1-D): Native Configurable Project
 * Charter lifecycle — draft/approve/activate/amend/supersede, immutable
 * version snapshots, role-scoped sign-off, and bounded exports.
 *
 * This car's envelope forbids `lib/store/_schema.js` (that file is sole-
 * owned by Car V60-T3-W1-A, which bumps `CURRENT_SCHEMA_VERSION` 82→83 and
 * lays down all 8 Train 3 tables, including the 3 this module reads/writes).
 * `ensureCharterTables` is this module's OWN idempotent `CREATE TABLE IF NOT
 * EXISTS` for exactly those 3 tables, so this module works standalone
 * against any db regardless of whether W1-A's migration has landed yet —
 * both are `IF NOT EXISTS`, so whichever runs first wins and the other is a
 * harmless no-op. Column/constraint shape here is this car's own design
 * (#2126 names table identities and field requirements, not a column list),
 * and is intentionally documented here so a future reconciliation can diff
 * it against `_schema.js`'s eventual DDL rather than guess.
 *
 * Charter CONTENT is one JSON blob per version (`content_json`), not one SQL
 * column per field — matching this schema's existing convention for
 * variable/structured content (`v6_g1_leases.actions_json`,
 * `reconciliation_findings.detail_json`), and matching #2126's own
 * requirement that section visibility/omission be per-project configurable
 * rather than a fixed table shape. `CHARTER_FIELDS` documents the expected
 * keys (#2126's "Charter field catalog"); nothing here enforces every key is
 * present — only `json_valid`, so a project can genuinely omit a section.
 *
 * NOT in this car's envelope (no `server.js`/`public/` files here): HTTP
 * routes, the human-readable editor/viewer, and SSOT-master-index linking on
 * the DOCUMENT side (`lib/v6/e1-doc-planes-context-compiler.js`'s own
 * `syncSsotIndex` already exists from a different "E1" — V6-13's 4-Plane
 * Documentation Model — and wiring this charter's identity into that index
 * is Wave 2's `V60-T3-W2-ROUTES` car, per the wave dispatch). `checkDrift`
 * here is deliberately narrow: it compares the charter's OWN declared
 * `coreTeam`/`requiredResources` fields against a caller-supplied snapshot
 * of actual state — collecting that snapshot from live sessions, role
 * leases, and worktrees is a later car's integration, not this module's.
 *
 * @module lib/v6/e1-project-charter-lifecycle
 */

const crypto = require('node:crypto');

/** #2126 "Charter field catalog" — the keys a charter's `content_json` is expected to carry. Enforcement is left to the caller/UI layer; this module only validates `json_valid`. */
const CHARTER_FIELDS = Object.freeze([
  'title', 'purposeAndBusinessCase', 'problemOrOpportunity', 'objectivesAndOutcomes',
  'successCriteria', 'scopeIncluded', 'scopeExcluded', 'majorDeliverables',
  'highLevelRequirements', 'stakeholders', 'sponsor', 'projectManagerOrOwner', 'coreTeam',
  'timelineAndMilestones', 'assumptionsAndConstraints', 'risksAndDependencies',
  'requiredResources', 'budget', 'governanceAndEscalation', 'approvalCriteria',
  'pmAuthorityAndReservedDecisions',
  // #2126 requirement 5: LINKS to other canonical records, never a duplicate copy.
  'links'
]);

/** A charter's lifecycle states (#2126 requirement 1), in the order a healthy charter normally moves through them -- 'amended' loops back toward 'active' via a fresh approval, 'superseded' is terminal. */
const STATUSES = Object.freeze(['draft', 'approved', 'active', 'amended', 'superseded']);

/** Who an approval's sign-off speaks for (#2126 requirement 4: "sponsor, PM, and other required authorities"). */
const APPROVER_ROLES = Object.freeze(['sponsor', 'pm', 'other']);

/** Per-section visibility a template/per-project config can set (#2126 requirement 3). An 'omitted' section is expected to carry a `reason` alongside it in the caller's own sectionConfig value; this module does not itself require one. */
const SECTION_DISPOSITIONS = Object.freeze(['required', 'optional', 'hidden', 'omitted']);

/**
 * Idempotent DDL for this car's 3 tables (see module doc for why this lives
 * here rather than in `lib/store/_schema.js`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureCharterTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v6_project_charters (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id           INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','active','amended','superseded')),
      template_id          TEXT,
      section_config_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(section_config_json)),
      active_version_id    INTEGER REFERENCES v6_project_charter_versions(id),
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS v6_project_charter_versions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      charter_id      INTEGER NOT NULL REFERENCES v6_project_charters(id) ON DELETE CASCADE,
      version_number  INTEGER NOT NULL CHECK (version_number >= 1),
      content_json    TEXT NOT NULL CHECK (json_valid(content_json)),
      content_digest  TEXT NOT NULL CHECK (length(content_digest) = 64),
      created_by      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS v6_project_charter_versions_number
      ON v6_project_charter_versions(charter_id, version_number);
    CREATE TABLE IF NOT EXISTS v6_project_charter_approvals (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      charter_id     INTEGER NOT NULL REFERENCES v6_project_charters(id) ON DELETE CASCADE,
      version_id     INTEGER NOT NULL REFERENCES v6_project_charter_versions(id) ON DELETE CASCADE,
      approver_role  TEXT NOT NULL CHECK (approver_role IN ('sponsor','pm','other')),
      approver_actor TEXT NOT NULL,
      approved_at    TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at     TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS v6_project_charter_approvals_active_unique
      ON v6_project_charter_approvals(version_id, approver_role, approver_actor) WHERE revoked_at IS NULL;
  `);
}

/**
 * sha256 hex digest of a version's content, so an approval can bind itself
 * to exactly what it approved (#2126 requirement 4) and a later read can
 * detect "this approval's digest no longer matches the version's own
 * content" as a tamper/corruption signal, not just trust the FK.
 * @param {string} contentJsonText
 * @returns {string}
 */
function _digest(contentJsonText) {
  return crypto.createHash('sha256').update(contentJsonText, 'utf8').digest('hex');
}

/**
 * Create a project's first charter (draft, version 1). Refuses if the
 * project already has a charter row of any status — #2126 scopes one
 * charter identity per project moving through states over its life, not
 * multiple concurrent identities.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, content: object, templateId?: string|null,
 *   sectionConfig?: object, actor?: string|null, now?: Function}} args
 * @returns {{ok: boolean, code: string, charterId?: number, versionId?: number}}
 */
function createDraftCharter(db, { projectId, content, templateId = null, sectionConfig = {}, actor = null, now = () => new Date().toISOString() }) {
  if (!Number.isSafeInteger(projectId) || !content || typeof content !== 'object') {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const existing = db.prepare('SELECT id FROM v6_project_charters WHERE project_id = ?').get(projectId);
  if (existing) return { ok: false, code: 'ALREADY_EXISTS' };

  const ts = now();
  const charterId = db.prepare(
    'INSERT INTO v6_project_charters (project_id, status, template_id, section_config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(projectId, 'draft', templateId, JSON.stringify(sectionConfig), ts, ts).lastInsertRowid;

  const contentText = JSON.stringify(content);
  const versionId = db.prepare(
    'INSERT INTO v6_project_charter_versions (charter_id, version_number, content_json, content_digest, created_by, created_at) VALUES (?, 1, ?, ?, ?, ?)'
  ).run(Number(charterId), contentText, _digest(contentText), actor, ts).lastInsertRowid;

  return { ok: true, code: 'CREATED', charterId: Number(charterId), versionId: Number(versionId) };
}

/**
 * Read a project's charter row plus every version (oldest first), or `null`
 * if the project has none yet (#2126 requirement 10: existing projects
 * without a charter keep working — this is the read a caller checks first).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number}} args
 * @returns {{charter: object, versions: Array<object>}|null}
 */
function getCharter(db, { projectId }) {
  const charter = db.prepare('SELECT * FROM v6_project_charters WHERE project_id = ?').get(projectId);
  if (!charter) return null;
  const versions = db.prepare(
    'SELECT * FROM v6_project_charter_versions WHERE charter_id = ? ORDER BY version_number ASC'
  ).all(charter.id);
  return { charter, versions };
}

/**
 * The charter's currently active version's content, or `null` if the
 * project has no charter, or has one that has never been activated.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number}} args
 * @returns {{charter: object, version: object, content: object}|null}
 */
function getActiveCharter(db, { projectId }) {
  const charter = db.prepare('SELECT * FROM v6_project_charters WHERE project_id = ?').get(projectId);
  // PRR-A R1, Ruling A592-PR3017-R1-HOLD-RECONCILED item 2: a superseded
  // charter must never read as active, even if active_version_id were
  // somehow still set -- checked explicitly, not only inferred from
  // supersedeCharter having cleared the pointer.
  if (!charter || charter.status === 'superseded' || charter.active_version_id == null) return null;
  const version = db.prepare('SELECT * FROM v6_project_charter_versions WHERE id = ?').get(charter.active_version_id);
  if (!version) return null;
  return { charter, version, content: JSON.parse(version.content_json) };
}

/**
 * Bounded charter summary for session startup (#2126 requirement 7):
 * identity, mission, current scope, authority, and active constraints only
 * -- never the full charter. `null` when there is no active charter (a
 * project without one, or one still in draft/approved, keeps working per
 * requirement 10 -- a bounded summary is an enhancement, never a gate).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number}} args
 * @returns {{title: string, mission: string, currentScope: {included: *, excluded: *},
 *   authority: *, activeConstraints: *, versionNumber: number}|null}
 */
function getStartupSummary(db, { projectId }) {
  const active = getActiveCharter(db, { projectId });
  if (!active) return null;
  const c = active.content;
  return {
    title: c.title ?? null,
    mission: c.purposeAndBusinessCase ?? c.objectivesAndOutcomes ?? null,
    currentScope: { included: c.scopeIncluded ?? null, excluded: c.scopeExcluded ?? null },
    authority: c.pmAuthorityAndReservedDecisions ?? null,
    activeConstraints: c.assumptionsAndConstraints ?? null,
    versionNumber: active.version.version_number
  };
}

/**
 * Save a new immutable version onto an existing charter. If the charter was
 * `active`, this starts an amendment (status moves to `amended`, pending
 * fresh approval + `activateCharter`) rather than silently changing what
 * "active" means out from under anyone already reading it; a `draft` or
 * `approved` charter's status is left as-is (still being drafted/awaiting
 * its first activation).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, content: object, sectionConfig?: object,
 *   actor?: string|null, now?: Function}} args
 * @returns {{ok: boolean, code: string, versionId?: number, versionNumber?: number}}
 */
function saveDraftVersion(db, { projectId, content, sectionConfig, actor = null, now = () => new Date().toISOString() }) {
  if (!content || typeof content !== 'object') return { ok: false, code: 'INVALID_REQUEST' };
  const charter = db.prepare('SELECT * FROM v6_project_charters WHERE project_id = ?').get(projectId);
  if (!charter) return { ok: false, code: 'NOT_FOUND' };
  if (charter.status === 'superseded') return { ok: false, code: 'CHARTER_SUPERSEDED' };

  const latest = db.prepare(
    'SELECT MAX(version_number) AS n FROM v6_project_charter_versions WHERE charter_id = ?'
  ).get(charter.id);
  const nextVersionNumber = (latest && latest.n ? latest.n : 0) + 1;
  const ts = now();
  const contentText = JSON.stringify(content);
  const versionId = db.prepare(
    'INSERT INTO v6_project_charter_versions (charter_id, version_number, content_json, content_digest, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(charter.id, nextVersionNumber, contentText, _digest(contentText), actor, ts).lastInsertRowid;

  // PRR-A R2, Ruling A596-PR3017-R2-HOLD-RECONCILED item 1: a brand-new,
  // unsigned version can never leave 'approved' standing -- that status
  // means the CURRENT latest version cleared its sign-offs, which is no
  // longer true the instant a fresh, zero-approval version lands. 'active'
  // behaves the same way; both fall back to 'amended' when there is
  // already an active version this new one would eventually supersede, or
  // 'draft' when the charter has never been activated at all.
  const nextStatus = (charter.status === 'active' || charter.status === 'approved')
    ? (charter.active_version_id ? 'amended' : 'draft')
    : charter.status;
  const sectionConfigText = sectionConfig !== undefined ? JSON.stringify(sectionConfig) : charter.section_config_json;
  db.prepare('UPDATE v6_project_charters SET status = ?, section_config_json = ?, updated_at = ? WHERE id = ?')
    .run(nextStatus, sectionConfigText, ts, charter.id);

  return { ok: true, code: 'SAVED', versionId: Number(versionId), versionNumber: nextVersionNumber };
}

/**
 * Record one authority's sign-off on an exact version (#2126 requirement 4).
 * Idempotent against the active-approval unique index: re-approving the
 * same (version, role, actor) that is not currently revoked is a no-op
 * success, never a thrown constraint error.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, versionId: number, approverRole: string,
 *   approverActor: string, now?: Function}} args
 * @returns {{ok: boolean, code: string, approvalId?: number}}
 */
function recordApproval(db, { projectId, versionId, approverRole, approverActor, now = () => new Date().toISOString() }) {
  if (!APPROVER_ROLES.includes(approverRole) || typeof approverActor !== 'string' || !approverActor) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const charter = db.prepare('SELECT * FROM v6_project_charters WHERE project_id = ?').get(projectId);
  if (!charter) return { ok: false, code: 'NOT_FOUND' };
  const version = db.prepare('SELECT * FROM v6_project_charter_versions WHERE id = ? AND charter_id = ?').get(versionId, charter.id);
  if (!version) return { ok: false, code: 'VERSION_NOT_FOUND' };

  const existing = db.prepare(
    'SELECT id FROM v6_project_charter_approvals WHERE version_id = ? AND approver_role = ? AND approver_actor = ? AND revoked_at IS NULL'
  ).get(versionId, approverRole, approverActor);
  if (existing) return { ok: true, code: 'ALREADY_APPROVED', approvalId: existing.id };

  const approvalId = db.prepare(
    'INSERT INTO v6_project_charter_approvals (charter_id, version_id, approver_role, approver_actor, approved_at) VALUES (?, ?, ?, ?, ?)'
  ).run(charter.id, versionId, approverRole, approverActor, now()).lastInsertRowid;

  // PRR-A R1, Ruling A592-PR3017-R1-HOLD-RECONCILED item 3 (narrowed by R2,
  // Ruling A596 item 1): a draft (or an amendment) that now clears the
  // minimum sponsor+pm bar moves to 'approved' -- but ONLY when the
  // version just signed is the charter's CURRENT latest one. Approving an
  // OLDER, already-superseded-by-a-later-draft version must never move
  // the charter's overall status forward; that older version's own
  // completeness is no longer what the charter is waiting on.
  if (charter.status === 'draft' || charter.status === 'amended') {
    const latest = db.prepare('SELECT id FROM v6_project_charter_versions WHERE charter_id = ? ORDER BY version_number DESC LIMIT 1').get(charter.id);
    if (latest && latest.id === versionId) {
      const check = checkApprovalComplete(db, { versionId, requiredRoles: [] });
      if (check.complete) {
        db.prepare('UPDATE v6_project_charters SET status = ?, updated_at = ? WHERE id = ?').run('approved', now(), charter.id);
      }
    }
  }

  return { ok: true, code: 'APPROVED', approvalId: Number(approvalId) };
}

/**
 * Revoke one authority's sign-off on a version.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, versionId: number, approverRole: string,
 *   approverActor: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function revokeApproval(db, { projectId, versionId, approverRole, approverActor, now = () => new Date().toISOString() }) {
  const charter = db.prepare('SELECT * FROM v6_project_charters WHERE project_id = ?').get(projectId);
  if (!charter) return { ok: false, code: 'NOT_FOUND' };
  const ts = now();
  const changed = db.prepare(
    'UPDATE v6_project_charter_approvals SET revoked_at = ? WHERE version_id = ? AND approver_role = ? AND approver_actor = ? AND charter_id = ? AND revoked_at IS NULL'
  ).run(ts, versionId, approverRole, approverActor, charter.id).changes;
  if (changed !== 1) return { ok: false, code: 'NOT_FOUND' };

  const version = db.prepare('SELECT version_number FROM v6_project_charter_versions WHERE id = ?').get(versionId);
  const check = checkApprovalComplete(db, { versionId, requiredRoles: [] });

  if (!check.complete && charter.active_version_id === versionId) {
    // PRR-A R2, Ruling A596-PR3017-R2-HOLD-RECONCILED item 2: the
    // charter's OWN active version just lost a required sign-off --
    // getActiveCharter/getStartupSummary must stop exposing it as
    // governing immediately, not wait for some other call to notice.
    const revertStatus = version && version.version_number > 1 ? 'amended' : 'draft';
    db.prepare('UPDATE v6_project_charters SET status = ?, active_version_id = NULL, updated_at = ? WHERE id = ?')
      .run(revertStatus, ts, charter.id);
  } else if (!check.complete && charter.status === 'approved') {
    // PRR-A R3, Ruling A603-PR3017-R3-HOLD-RECONCILED: guarded by
    // "versionId is the charter's current LATEST version", symmetric with
    // recordApproval's own guard before transitioning TO 'approved'.
    // 'approved' reflects the LATEST version's completeness, not every
    // version's -- revoking a sign-off on an OLDER version (already
    // superseded by a later, still-fully-approved draft) must never
    // revert a status that version no longer governs.
    const latest = db.prepare('SELECT id FROM v6_project_charter_versions WHERE charter_id = ? ORDER BY version_number DESC LIMIT 1').get(charter.id);
    if (latest && latest.id === versionId) {
      // PRR-A R1, Ruling A592-PR3017-R1-HOLD-RECONCILED item 3's mirror: a
      // revocation that drops an 'approved' (not-yet-activated) charter
      // below the minimum bar reverts it the same way saveDraftVersion's
      // own fallback does.
      const revertStatus = version && version.version_number === 1 ? 'draft' : 'amended';
      db.prepare('UPDATE v6_project_charters SET status = ?, updated_at = ? WHERE id = ?').run(revertStatus, ts, charter.id);
    }
  }

  return { ok: true, code: 'REVOKED' };
}

/** #2126 requirement 4/6's non-negotiable floor: a version can never activate on fewer than these two sign-offs, however the caller sizes its OWN `requiredRoles`. */
const MINIMUM_REQUIRED_ROLES = Object.freeze(['sponsor', 'pm']);

/**
 * `requiredRoles` unioned with `MINIMUM_REQUIRED_ROLES`, so an empty or
 * under-specified caller array can never shrink the effective floor below
 * sponsor+pm (PRR-A R1, Ruling A592-PR3017-R1-HOLD-RECONCILED item 1).
 * @param {string[]} requiredRoles
 * @returns {{ok: true, roles: string[]}|{ok: false, code: string}} `INVALID_REQUIRED_ROLES` when any entry is not one of `APPROVER_ROLES`.
 */
function _normalizeRequiredRoles(requiredRoles) {
  const roles = Array.isArray(requiredRoles) ? requiredRoles : [];
  if (roles.some((r) => !APPROVER_ROLES.includes(r))) return { ok: false, code: 'INVALID_REQUIRED_ROLES' };
  return { ok: true, roles: Array.from(new Set([...MINIMUM_REQUIRED_ROLES, ...roles])) };
}

/**
 * Which of `requiredRoles` currently hold an active (non-revoked) approval
 * on `versionId` -- `requiredRoles` is always widened to include at least
 * `MINIMUM_REQUIRED_ROLES` first, so `requiredRoles: []` can never report
 * `complete: true` on zero approval rows.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{versionId: number, requiredRoles: string[]}} args
 * @returns {{ok?: boolean, code?: string, complete: boolean, approvedRoles: string[], missingRoles: string[]}}
 *   `ok`/`code` are present only on an `INVALID_REQUIRED_ROLES` refusal.
 */
function checkApprovalComplete(db, { versionId, requiredRoles }) {
  const normalized = _normalizeRequiredRoles(requiredRoles);
  if (!normalized.ok) return { ok: false, code: normalized.code, complete: false, approvedRoles: [], missingRoles: [] };
  const rows = db.prepare(
    'SELECT DISTINCT approver_role FROM v6_project_charter_approvals WHERE version_id = ? AND revoked_at IS NULL'
  ).all(versionId);
  const approvedRoles = rows.map((r) => r.approver_role);
  const missingRoles = normalized.roles.filter((r) => !approvedRoles.includes(r));
  return { complete: missingRoles.length === 0, approvedRoles, missingRoles };
}

/**
 * Activate a version once every required authority has signed off
 * (#2126 requirement 4/6). Fails closed with `APPROVALS_INCOMPLETE` rather
 * than activating a partially-approved version.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, versionId: number, requiredRoles: string[], now?: Function}} args
 * @returns {{ok: boolean, code: string, missingRoles?: string[]}}
 */
function activateCharter(db, { projectId, versionId, requiredRoles, now = () => new Date().toISOString() }) {
  const charter = db.prepare('SELECT * FROM v6_project_charters WHERE project_id = ?').get(projectId);
  if (!charter) return { ok: false, code: 'NOT_FOUND' };
  const version = db.prepare('SELECT id FROM v6_project_charter_versions WHERE id = ? AND charter_id = ?').get(versionId, charter.id);
  if (!version) return { ok: false, code: 'VERSION_NOT_FOUND' };
  if (charter.status === 'superseded') return { ok: false, code: 'CHARTER_SUPERSEDED' };

  const approval = checkApprovalComplete(db, { versionId, requiredRoles });
  if (approval.ok === false) return { ok: false, code: approval.code };
  if (!approval.complete) return { ok: false, code: 'APPROVALS_INCOMPLETE', missingRoles: approval.missingRoles };

  db.prepare('UPDATE v6_project_charters SET status = ?, active_version_id = ?, updated_at = ? WHERE id = ?')
    .run('active', versionId, now(), charter.id);
  return { ok: true, code: 'ACTIVATED' };
}

/**
 * Retire a charter permanently (#2126 requirement 1's terminal state).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function supersedeCharter(db, { projectId, now = () => new Date().toISOString() }) {
  // PRR-A R1, Ruling A592-PR3017-R1-HOLD-RECONCILED item 2: clear the
  // active pointer too -- a superseded charter has nothing active, by
  // definition, regardless of what it pointed to a moment ago.
  const changed = db.prepare(
    "UPDATE v6_project_charters SET status = 'superseded', active_version_id = NULL, updated_at = ? WHERE project_id = ? AND status != 'superseded'"
  ).run(now(), projectId).changes;
  return changed === 1 ? { ok: true, code: 'SUPERSEDED' } : { ok: false, code: 'NOT_FOUND' };
}

/**
 * Machine-readable export (#2126 requirement 8): the active version's
 * content plus enough lifecycle metadata to audit it, or the latest DRAFT
 * version when nothing has been activated yet -- an editor/CLI reading this
 * for a brand-new charter should see the draft, not `null`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number}} args
 * @returns {{status: string, versionNumber: number, content: object,
 *   approvedRoles: string[]}|null}
 */
function exportCharterJson(db, { projectId }) {
  const found = getCharter(db, { projectId });
  if (!found || found.versions.length === 0) return null;
  const { charter, versions } = found;
  const version = charter.active_version_id != null
    ? versions.find((v) => v.id === charter.active_version_id)
    : versions[versions.length - 1];
  const approvedRoles = db.prepare(
    'SELECT DISTINCT approver_role FROM v6_project_charter_approvals WHERE version_id = ? AND revoked_at IS NULL'
  ).all(version.id).map((r) => r.approver_role);
  return {
    status: charter.status,
    versionNumber: version.version_number,
    content: JSON.parse(version.content_json),
    approvedRoles
  };
}

/**
 * Human-readable Markdown export (#2126 requirement 8), one heading per
 * populated field (an omitted/absent field is skipped, not rendered empty).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number}} args
 * @returns {string|null}
 */
function exportCharterMarkdown(db, { projectId }) {
  const exported = exportCharterJson(db, { projectId });
  if (!exported) return null;
  const { content } = exported;
  const title = content.title || 'Project Charter';
  const lines = [`# ${title}`, '', `_Status: ${exported.status} · Version ${exported.versionNumber}_`, ''];
  for (const field of CHARTER_FIELDS) {
    if (field === 'title' || content[field] == null || content[field] === '') continue;
    const heading = field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    const value = content[field];
    lines.push(`## ${heading}`, '', typeof value === 'string' ? value : '```json\n' + JSON.stringify(value, null, 2) + '\n```', '');
  }
  return lines.join('\n');
}

/**
 * Compare the charter's own declared team/resource topology against a
 * caller-supplied snapshot of actual state (#2126 requirement 9). Narrow by
 * design (see module doc): this never reaches into live sessions, leases,
 * or worktrees itself.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, actual: {coreTeam?: string[], requiredResources?: string[]}}} args
 * @returns {{drift: boolean, missing: string[], unexpected: string[]}|null} `null` when there is no active charter to compare against.
 */
function checkResourceDrift(db, { projectId, actual = {} }) {
  const active = getActiveCharter(db, { projectId });
  if (!active) return null;
  // PRR-A R1, Ruling A592-PR3017-R1-HOLD-RECONCILED item 4: coreTeam and
  // requiredResources are compared WITHIN their own category, never pooled
  // -- pooling both into one set would miss a team member swapped into the
  // resources list (and vice versa) landing in the SAME pooled set as the
  // thing it replaced, reading as "no drift" when the categories plainly
  // disagree.
  const _diff = (declaredList, actualList) => ({
    missing: declaredList.filter((d) => !actualList.includes(d)),
    unexpected: actualList.filter((o) => !declaredList.includes(o))
  });
  const team = _diff(
    Array.isArray(active.content.coreTeam) ? active.content.coreTeam : [],
    Array.isArray(actual.coreTeam) ? actual.coreTeam : []
  );
  const resources = _diff(
    Array.isArray(active.content.requiredResources) ? active.content.requiredResources : [],
    Array.isArray(actual.requiredResources) ? actual.requiredResources : []
  );
  const missing = [...team.missing, ...resources.missing];
  const unexpected = [...team.unexpected, ...resources.unexpected];
  return { drift: missing.length > 0 || unexpected.length > 0, missing, unexpected };
}

module.exports = {
  CHARTER_FIELDS,
  STATUSES,
  APPROVER_ROLES,
  MINIMUM_REQUIRED_ROLES,
  SECTION_DISPOSITIONS,
  ensureCharterTables,
  createDraftCharter,
  getCharter,
  getActiveCharter,
  getStartupSummary,
  saveDraftVersion,
  recordApproval,
  revokeApproval,
  checkApprovalComplete,
  activateCharter,
  supersedeCharter,
  exportCharterJson,
  exportCharterMarkdown,
  checkResourceDrift
};
