'use strict';

/**
 * The store's schema in one ordered place: the schema version, the vocabulary
 * lists its CHECK constraints are built from, the fresh-install DDL
 * (`_createTables`) and the migration chain (`_runMigrations`) with every
 * migration, postcondition and per-area DDL helper the chain calls.
 *
 * The facade (`lib/store.js`) binds this module in `init()` before it runs
 * the chain: `_bind({ db, dbFile, projectConfigApi, SESSION_STATUS })`. The
 * two domain values are injected rather than required because this module must
 * never require the facade: that cycle would evaluate the chain against a
 * half-built export object, and `_migrateDropMethodology` would call
 * `projectConfigApi.load` on `undefined`. Everything else it needs is a leaf
 * module (`../bridge-schema`, `../merge-queue-state`, `../check-watch-state`)
 * or the shared handle (`./_db`).
 *
 * Everything below is moved from `lib/store.js` unchanged (#2248) except the
 * three lazy `require` paths that now climb one directory; what this file adds
 * is `_bind` and the export list. The vocabulary constants the domains also
 * read are re-exported by the facade under the names they always had.
 *
 * @module lib/store/_schema
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('../logger');
const bridgeSchema = require('../bridge-schema');
const mergeQueueState = require('../merge-queue-state');
const checkWatchState = require('../check-watch-state');
const { _startupControlTransaction } = require('./_db');

// The logger keeps the facade's name so every log line the chain writes reads
// exactly as it did before the move.
const log = createLogger('store');

let _db = null;
/** The database file's path, for the backup `_migrateDropMethodology` writes beside it. */
let _dbFile = null;
/** The facade's project-config api, injected so this module never requires the facade. */
let projectConfigApi = null;
/** The facade's session-status vocabulary, injected for the same reason. */
let SESSION_STATUS = null;

/**
 * Bind what the chain reads, or unbind all of it with `null`.
 * @param {{db: import('node:sqlite').DatabaseSync, dbFile: string, projectConfigApi: object, SESSION_STATUS: object}|null} deps
 *   The open database, its file path, and the two facade values the chain calls into.
 * @returns {void}
 */
function _bind(deps) {
  _db = deps ? deps.db : null;
  _dbFile = deps ? deps.dbFile : null;
  projectConfigApi = deps ? deps.projectConfigApi : null;
  SESSION_STATUS = deps ? deps.SESSION_STATUS : null;
}

const CURRENT_SCHEMA_VERSION = 76;

/**
 * Every verdict the workload nudge monitor's unready-window check can reach,
 * frozen onto `launch_sequences.last_unready_verdict` (#1596). Provisioned in
 * v71 so W2-B, the car that writes it, makes no further edits to this file.
 * @type {string[]}
 */
const UNREADY_VERDICTS = Object.freeze([
  'within-window', 'nudged', 'already-nudged', 'no-project', 'unreadable-created-at',
  'session-gone', 'no-pane', 'native-startup', 'unprofiled-engine', 'pane-capture-failed',
  'pane-busy', 'inject-failed', 'control-held'
]);

// The two launch-isolation overrides (#2229): the install-wide one, and a
// project's. The table's CHECK and the accessor read the same list.
const LAUNCH_ISOLATION_OVERRIDE_SCOPES = Object.freeze(['install', 'project']);

/**
 * Revision 1 of the startup prompt (#1825). It only asks the engine to read its
 * launch context and never dispatches project work, which is the one thing an
 * automatic bootstrap may do.
 * @type {string}
 */
const STARTUP_PROMPT_SEED = 'read your launch context: run tc start next';

/**
 * Content digest of a startup prompt revision: sha256 hex of its text. Stored
 * with the revision so a fire can record exactly which bytes it named.
 * @param {string} text - Prompt text.
 * @returns {string} 64-char hex digest.
 */
function _startupPromptDigest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Canonical digest of a firer policy: sha256 hex of `{"firerProjectIds":[...]}`
 * with the ids sorted ascending, so the same list always digests the same.
 * @param {number[]} ids - Project ids.
 * @returns {string} 64-char hex digest.
 */
function _startupPolicyDigest(ids) {
  const canonical = JSON.stringify({ firerProjectIds: [...ids].sort((a, b) => a - b) });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Every state a startup prompt fire can be in (#1825). `pending`,
 * `dispatching`, `indeterminate` and `accepted` are ACTIVE: a launch holds at
 * most one of those at a time. `indeterminate` means a send may have happened
 * with no receipt; it is never retried automatically. `denied` records an
 * out-of-scope attempt, which the caller was told was not found.
 * @type {string[]}
 */
const STARTUP_FIRE_OUTCOMES = Object.freeze([
  'pending', 'dispatching', 'indeterminate', 'accepted',
  'applied', 'blocked', 'failed', 'interrupted', 'unsupported', 'denied'
]);

/** The outcomes that occupy a launch's single active slot. @type {string[]} */
const STARTUP_FIRE_ACTIVE = Object.freeze(['pending', 'dispatching', 'indeterminate', 'accepted']);

/**
 * Bounded, typed reasons a fire records. Free text rides beside the code,
 * capped at 500 characters, but readers key on the code.
 * @type {string[]}
 */
const STARTUP_FIRE_REASON_CODES = Object.freeze([
  'engine_declares_none', 'engine_profile_unreadable', 'profile_block_malformed', 'adapter_not_registered',
  'version_unverified', 'dispatch_unavailable', 'fire_scope_denied',
  // The Codex adapter's codes: what stopped a fire before a send, what an
  // engine reported about the turn, and what the channel itself did.
  'trust_required', 'auth_required', 'quota_exhausted', 'engine_not_ready', 'version_mismatch',
  'readiness_unknown', 'approval_pending', 'user_input_pending', 'turn_failed', 'turn_rejected',
  'turn_interrupted', 'send_unconfirmed', 'restart_before_dispatch', 'channel_lost', 'channel_unavailable',
  // The automatic bootstrap's own pre-send gate (B3): the pane never became
  // ready within the launch window, so the adapter was never asked. A fact
  // about the pane as TangleClaw observed it, never a claim about the engine.
  'pane_not_ready'
]);

/**
 * Who asked for a fire. `operator` and `project` are HTTP callers the routes
 * prove; `launch` is TangleClaw's own automatic bootstrap at launch (#1825 B3),
 * an internal caller no request can produce.
 * @type {string[]}
 */
const STARTUP_FIRE_CALLER_KINDS = Object.freeze(['operator', 'project', 'launch']);

/**
 * How well a fire's caller was proven. `launch-automatic` is the bootstrap's:
 * the launch that fires is the launch being fired at, proven inside the fire
 * transaction rather than by any credential.
 * @type {string[]}
 */
const STARTUP_FIRE_CLEARANCES = Object.freeze(['operator-verified', 'open-install-unverified', 'project-binding', 'launch-automatic']);

/** How a launch's startup context is first put in front of the engine. @type {string[]} */
const STARTUP_DELIVERIES = Object.freeze(['legacy', 'native']);

/**
 * A string list as a SQL `IN (...)` body, for CHECK constraints built from the
 * same constants readers use.
 * @param {string[]} list - Values.
 * @returns {string}
 */
function _sqlList(list) {
  return list.map((v) => `'${v}'`).join(',');
}

const STARTUP_FIRE_OUTCOMES_SQL = _sqlList(STARTUP_FIRE_OUTCOMES);
const STARTUP_FIRE_ACTIVE_SQL = _sqlList(STARTUP_FIRE_ACTIVE);
const STARTUP_FIRE_REASON_CODES_SQL = _sqlList(STARTUP_FIRE_REASON_CODES);
const STARTUP_FIRE_CALLER_KINDS_SQL = _sqlList(STARTUP_FIRE_CALLER_KINDS);
const STARTUP_FIRE_CLEARANCES_SQL = _sqlList(STARTUP_FIRE_CLEARANCES);
const STARTUP_DELIVERIES_SQL = _sqlList(STARTUP_DELIVERIES);

/**
 * What a batch recovery clear can record for one of its items. `cleared` is the
 * only word that wrote a clearance; every other word is a refusal or a failure,
 * and the launch it names was left as it was.
 */
const RECOVERY_BATCH_OUTCOMES = Object.freeze([
  'cleared', 'already-clear', 'stale', 'advisory', 'session-ended', 'not-found', 'archived', 'failed'
]);
const RECOVERY_BATCH_OUTCOMES_SQL = _sqlList(RECOVERY_BATCH_OUTCOMES);

/**
 * What the workload nudge monitor can record about one expired receipt (#2262).
 * `nudged` is a line typed into the lane's pane. `not-nudged` is the reason no
 * line was typed. `escalated` is a message about the lane that was accepted for
 * its route, and `escalation-undeliverable` is one that could not be sent.
 */
const WORKLOAD_NUDGE_FACT_KINDS = Object.freeze(['nudged', 'not-nudged', 'escalated', 'escalation-undeliverable']);
const WORKLOAD_NUDGE_FACT_KINDS_SQL = _sqlList(WORKLOAD_NUDGE_FACT_KINDS);

/**
 * Where an escalation about a silent lane goes: to the project its config names
 * as coordinator, or to the operator when there is no coordinator to tell.
 */
const WORKLOAD_NUDGE_ROUTES = Object.freeze(['coordinator', 'operator']);
const WORKLOAD_NUDGE_ROUTES_SQL = _sqlList(WORKLOAD_NUDGE_ROUTES);

/**
 * The baseline a project's history was classified as at the handoff-epoch
 * boundary. Only `clean` earns the legacy exception in `lib/launch-preflight.js`;
 * the other two reach recovery. Exported so a caller matches on a constant
 * rather than a spelling, and so the CHECK constraint below is written from
 * this one list instead of a second copy of it.
 * @type {Readonly<{CLEAN: string, UNCLEAN: string, EMPTY: string}>}
 */
const HANDOFF_BASELINES = Object.freeze({
  CLEAN: 'clean',
  UNCLEAN: 'unclean',
  EMPTY: 'empty'
});

/** Every allowed `project_handoff_epoch.baseline` value. @type {readonly string[]} */
const HANDOFF_BASELINE_VALUES = Object.freeze(Object.values(HANDOFF_BASELINES));

/**
 * Why a cutoff recorded on a store that had already taken v41 cannot be trusted
 * as the real boundary. v41 shipped handoff publication without recording where
 * handoffs began, so on such a store the instant is simply not knowable — and a
 * cutoff taken later sweeps post-epoch sessions into the legacy window, turning
 * a lost handoff into "this project predates handoffs". The reason travels with
 * the row so an operator is told the boundary is unknown rather than that a
 * failure was proven.
 */
const EPOCH_UNKNOWN_FROM_V41 = 'epoch-boundary-unknown-from-v41';

// How far a leased service is MEANT to be reachable (#1394). One owner for the
// vocabulary, stated precisely because a comment that overclaims is worse than
// none — it is what stops the next reader from checking. Three surfaces read
// THIS array: the CHECK constraint (via REACH_CHECK_SQL below), the lease
// validator, and `lib/caddy-drift.js`, which imports it as its reach ordering
// rather than restating it. The HTTP route reads it only indirectly, by
// surfacing the validator's error text verbatim instead of listing the values
// again. So widening the set is a single-line change here that cannot leave a
// surface still answering for the old vocabulary.
// Order is widening — index 0 is the weakest claim and the default.
const LEASE_REACHES = ['loopback', 'tailnet', 'lan'];

// The CHECK clause built from that one array, so the fresh-install DDL, the
// v34→v35 migration and its postcondition cannot drift apart. Built from
// module-local literals; nothing caller-supplied reaches it.
const REACH_CHECK_SQL = `reach IN (${LEASE_REACHES.map((r) => `'${r}'`).join(',')})`;

// Who owns a leased port (#1381). `project` is a TangleClaw project (or
// TangleClaw itself); `external` is a process no project started — a
// `brew services` database, a system daemon. Every reader that decides a lease
// is an orphan (the boot sweep, the dashboard's import banner) asks this field
// instead of inferring "not a project" from a missing directory, which is what
// deleted correct leases before. `project` is first because it is the default
// and what every row written before the field existed meant.
const LEASE_OWNER_KINDS = ['project', 'external'];

// The CHECK clause from that one array, shared by the fresh-install DDL, the
// v43→v44 migration and its postcondition. Module-local literals only.
const OWNER_KIND_CHECK_SQL = `owner_kind IN (${LEASE_OWNER_KINDS.map((k) => `'${k}'`).join(',')})`;

/**
 * Create all SQLite tables.
 */
function _createTables() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL UNIQUE,
      path          TEXT    NOT NULL UNIQUE,
      engine_id     TEXT    NOT NULL DEFAULT 'claude',
      tags          TEXT    DEFAULT '[]',
      ports         TEXT    DEFAULT '{}',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      archived      INTEGER NOT NULL DEFAULT 0,
      orchestration_profile TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_projects_engine ON projects(engine_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      engine_id       TEXT    NOT NULL,
      tmux_session    TEXT,
      started_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      ended_at        TEXT,
      status          TEXT    NOT NULL DEFAULT 'active',
      wrap_summary    TEXT,
      prime_prompt    TEXT,
      duration_seconds INTEGER,
      session_mode     TEXT NOT NULL DEFAULT 'tmux',
      launch_mode      TEXT,
      wrap_started_at  TEXT,                                                -- historical: written by no current code path (#1034)
      owner            TEXT,                                                 -- signed-in TangleClaw user who launched it (NULL = no one signed in)
      launch_sha       TEXT,                                                 -- HEAD when the session launched (NULL = not a repo, or launched before v39)
      launch_toplevel  TEXT,                                                 -- repo toplevel that sha and launch_dirty describe
      launch_dirty     TEXT,                                                 -- JSON {paths, truncated}: paths already dirty at launch (NULL = not captured)
      launch_blocker   TEXT                                                  -- JSON {code, label, meaning, engineId, observedAt}: what is keeping this launch from being typed into (NULL = nothing)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

    CREATE TABLE IF NOT EXISTS learnings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      content         TEXT    NOT NULL,
      tier            TEXT    NOT NULL DEFAULT 'provisional',
      source_session  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      confirmed_count INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project_id);
    CREATE INDEX IF NOT EXISTS idx_learnings_tier ON learnings(tier);

    CREATE TABLE IF NOT EXISTS session_rules (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global (all projects)
      content           TEXT    NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_by        TEXT    NOT NULL DEFAULT 'operator',                -- 'operator' | 'ai'
      kind              TEXT    NOT NULL DEFAULT 'startup',                 -- CC-6: 'startup' (launch-injected) | 'wrap' (wrap-prompt-injected)
      owner             TEXT,                                               -- nullable auth-ready seam (AUTH/#347)
      source_learning_id INTEGER REFERENCES learnings(id) ON DELETE SET NULL, -- provenance for promoted rules (D1b)
      -- Review state, orthogonal to enabled. enabled is the operator's on/off
      -- switch for a rule they own; status is how far a rule has got through
      -- review. Keeping them separate is what lets a rule the operator REJECTED
      -- stay distinguishable from one never reviewed, and a RETIRED rule stay
      -- distinguishable from one merely switched off (#1696/#1709) — collapse
      -- either pair and the wrap re-proposes rejected rules forever, or
      -- re-enabling a retired one reads as a restoration. Only 'active' is
      -- ever injected.
      status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','rejected','retired')),
      -- #1696: set when this rule was created to replace another, fixed at
      -- creation, never changed afterwards. replacement_origin says how the
      -- replacement arose, because the two kinds answer a stale approval
      -- differently — see setStatus's doc comment. superseded_by records the
      -- rule whose approval retired THIS one (set on the retired row, not the
      -- replacement). Neither is a foreign key: a rule can be deleted, and a
      -- pointer to a deleted rule is honest history, not an error.
      replaces_rule_id  INTEGER,
      superseded_by     INTEGER,
      retired_at        TEXT,
      replacement_origin TEXT CHECK (replacement_origin IS NULL OR replacement_origin IN ('amendment','edit','restore')),
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_rules_project ON session_rules(project_id);
    CREATE INDEX IF NOT EXISTS idx_session_rules_enabled ON session_rules(enabled);

    -- D1b: version history for session_rules. Snapshots the full rule state after
    -- every mutation (create/update/delete/restore) so any autonomous edit is
    -- reversible. rule_id is a LOGICAL reference (no FK cascade) so history
    -- survives a rule's deletion for audit.
    CREATE TABLE IF NOT EXISTS session_rule_versions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id       INTEGER NOT NULL,
      version_no    INTEGER NOT NULL,                                    -- monotonic per rule_id (1,2,3…)
      op            TEXT    NOT NULL CHECK (op IN ('create','update','delete','restore')),  -- SR-3MW8: enum-pinned
      content       TEXT    NOT NULL,
      enabled       INTEGER NOT NULL,
      created_by    TEXT    NOT NULL,
      owner         TEXT,
      changed_by    TEXT    NOT NULL DEFAULT 'operator',                -- who made THIS change ('operator' | 'ai')
      change_reason TEXT,
      critic_gate   TEXT    NOT NULL DEFAULT 'unknown' CHECK (critic_gate IN ('passed','not-required','unknown')),  -- SR-7K2P: attested Critic-gate provenance
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_rule_versions_rule ON session_rule_versions(rule_id);

    -- Delivery ledger for session rules (#595). Answers "did session X receive
    -- rule set Y at version Z" — previously unanswerable, and in fact untrue on
    -- every plugin-governed project, because the only injection path ran inside
    -- config-file generation, which those projects skip entirely.
    --
    -- Rows record a delivery ATTEMPT, not only a success. The outcome column is
    -- the single source of truth for what happened, deliberately an enum
    -- rather than a delivered boolean: with a boolean, a project that has no
    -- rules and a project whose rules were delivered both read as "true", which
    -- is the exact conflation this ledger exists to end.
    --
    --   delivered  — the rule block reached the engine, and the writer OBSERVED
    --                the channel ready to receive it (a marker-confirmed pane,
    --                or a channel whose consumption is otherwise evidenced)
    --   no-rules   — the launch path ran and the project had no active rules
    --   skipped    — rules existed and did NOT arrive; skip_reason says why
    --   unverified — the block was SENT and nothing observed the far side;
    --                skip_reason says what made it unobservable. A blind paste
    --                is this row, never 'delivered': a channel that is 100%
    --                broken must not produce a clean ledger.
    --
    -- "Which projects never received their rules" is then a real query
    -- (no row with outcome='delivered'), and a severed channel is
    -- distinguishable from an empty one.
    --
    -- digest is a sha256 over the rule CONTENT (id:text per rule) and is the
    -- version identity of a rule SET; session_rule_versions.version_no is
    -- per-rule and cannot identify a set. Hashing the rendered block instead
    -- would make the digest change when the wording around the rules changed,
    -- which is not a change to the rules.
    --
    -- session_id / project_id are LOGICAL references (no FK, no cascade), same
    -- rationale as session_rule_versions.rule_id above: the audit trail must
    -- outlive the session or project it describes.
    CREATE TABLE IF NOT EXISTS session_rule_deliveries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER,
      project_id   INTEGER,
      engine_id    TEXT    NOT NULL,
      kind         TEXT    NOT NULL DEFAULT 'startup',
      -- 'rules-hook' is the dedicated startup channel rules ride since #749.
      -- 'prime-file' remains for the prime itself and for pre-#749 rows.
      channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
      outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped','unverified','written')),
      skip_reason  TEXT,
      rule_ids     TEXT    NOT NULL DEFAULT '[]',
      rule_count   INTEGER NOT NULL DEFAULT 0,
      digest       TEXT    NOT NULL,
      -- #1063 — when the engine's hook confirmed it, NULL until then. The
      -- ratified direction refused to let a later observation destroy the
      -- record of what was known when; this is the column that keeps both
      -- facts on one row (see the amendment in prime-delivery-direction.md).
      confirmed_at TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      -- Structurally impossible states, rejected by the database rather than
      -- only by the writer: nothing can be sent through no channel, and a
      -- skip or an unverified send with no reason records a failure while
      -- discarding what it was.
      CHECK (outcome NOT IN ('delivered','unverified','written') OR channel != 'none'),
      CHECK (outcome NOT IN ('skipped','unverified')   OR skip_reason IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);

    -- Launch sequences (Train 21). A session's context is served in four
    -- acknowledged steps over 'tc start'; these two tables are the whole
    -- record of that exchange. The step content is FROZEN at creation and
    -- served verbatim, so a restart or a rule edit can never change what an
    -- advertised digest covers. session_id / project_id are LOGICAL
    -- references (no FK), like session_rule_deliveries: the record outlives
    -- the session or project it describes.
    CREATE TABLE IF NOT EXISTS launch_sequences (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      launch_id       TEXT    NOT NULL UNIQUE,
      session_id      INTEGER NOT NULL,
      project_id      INTEGER NOT NULL,
      engine_id       TEXT    NOT NULL,
      revision        INTEGER NOT NULL DEFAULT 1,
      cursor          INTEGER NOT NULL DEFAULT 0,
      page_budget     INTEGER NOT NULL,
      applicability   TEXT    NOT NULL CHECK (applicability IN ('applicable','not-applicable')),
      not_applicable_reason TEXT,
      preflight       TEXT    NOT NULL,
      source_manifest TEXT    NOT NULL,
      ready_at        TEXT,
      ready_artifact  TEXT,
      ready_digest    TEXT,
      unready_at      TEXT,
      nudge_count     INTEGER NOT NULL DEFAULT 0,
      last_nudged_at  TEXT,
      -- Recovery (Train 21, #1587). recovery is decided at launch from the
      -- preflight's requiresRecovery and gates step 4 and READY; recovery_mode
      -- is the project's setting frozen with the launch, so a setting edited
      -- mid-launch cannot change the rules the pane is already playing by.
      -- recovery_revision is what a clear is bound to: a snapshot revision
      -- re-renders the verdict the operator read before deciding, so a clear
      -- granted against the old one must not apply to the new one.
      recovery        TEXT    NOT NULL DEFAULT 'none' CHECK (recovery IN ('none','required','cleared')),
      recovery_mode   TEXT    NOT NULL DEFAULT 'operator' CHECK (recovery_mode IN ('operator','advisory')),
      recovery_revision INTEGER NOT NULL DEFAULT 1,
      recovery_cleared_at TEXT,
      recovery_cleared_by TEXT,
      recovery_clearance  TEXT CHECK (recovery_clearance IN ('operator-verified','open-install-unverified','agent-reconciled')),
      -- How this launch's startup context is first put in front of the engine
      -- (#1825 B3). 'native' means the launch selected its engine's
      -- startupControl channel: no prime paste, no kickoff, no unready nudge —
      -- nothing is ever typed into that pane by TangleClaw. Decided at launch
      -- and frozen here so a restart cannot turn a native launch back into a
      -- keystroke path.
      startup_delivery TEXT NOT NULL DEFAULT 'legacy' CHECK (startup_delivery IN (${STARTUP_DELIVERIES_SQL})),
      -- The workload nudge monitor's own verdict on this launch's unready
      -- window, and when it was recorded (#1596, provisioned in schema v71 so
      -- W2-B, the car that writes it, touches no other part of this file).
      -- Both null until the monitor's first evaluation of a given launch.
      last_unready_verdict    TEXT CHECK (last_unready_verdict IS NULL OR last_unready_verdict IN (${_sqlList(UNREADY_VERDICTS)})),
      last_unready_verdict_at TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      CHECK (applicability = 'applicable' OR not_applicable_reason IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_sequences_session ON launch_sequences(session_id);

    ${_projectRecoveryStateDdl()}

    ${_launchRecoveryClearancesDdl()}

    ${_launchRecoveryClearBatchesDdl()}

    ${_launchReconciliationsDdl()}

    ${_launchReadinessReceiptsDdl()}

    CREATE TABLE IF NOT EXISTS launch_sequence_steps (
      sequence_id   INTEGER NOT NULL,
      revision      INTEGER NOT NULL,
      step_index    INTEGER NOT NULL CHECK (step_index BETWEEN 0 AND 3),
      step_id       TEXT    NOT NULL CHECK (step_id IN ('identity','governance','state','task')),
      content       TEXT    NOT NULL,
      digest        TEXT    NOT NULL,
      page_count    INTEGER NOT NULL,
      page_offsets  TEXT    NOT NULL,
      carried_from_revision INTEGER,
      pages_served  TEXT    NOT NULL DEFAULT '[]',
      served_at     TEXT,
      acked_at      TEXT,
      PRIMARY KEY (sequence_id, revision, step_index)
    );

    -- Handoff publications (Train 21, #1585). One row per wrap ATTEMPT, never
    -- per session: a kept session publishes checkpoint → checkpoint → final,
    -- and each is its own immutable publication. project_id / session_id are
    -- LOGICAL references (no FK), like launch_sequences above — the record
    -- outlives the session or project it describes, which is the whole point
    -- of a forensic handoff trail.
    --
    -- eligible_at is the attempt-exact proof that this attempt COMPLETED. It is
    -- written only by the lifecycle-wrap transaction or by
    -- markCheckpointComplete, never inferred from session status: a failed
    -- attempt must never borrow a later attempt's success.
    CREATE TABLE IF NOT EXISTS handoff_publications (
      publication_id  TEXT    PRIMARY KEY,
      seq             INTEGER NOT NULL UNIQUE,
      project_id      INTEGER NOT NULL,
      session_id      INTEGER NOT NULL,
      wrap_run_id     TEXT    NOT NULL,
      kind            TEXT    NOT NULL CHECK (kind IN ('final','checkpoint')),
      state           TEXT    NOT NULL CHECK (state IN ('staged','published','superseded','abandoned')),
      file_digest     TEXT    NOT NULL,
      eligible_at     TEXT,
      eligible_via    TEXT    CHECK (eligible_via IN ('lifecycle-wrap','checkpoint-complete')),
      staged_at       TEXT    NOT NULL,
      published_at    TEXT,
      superseded_at   TEXT,
      superseded_by   TEXT,
      abandoned_at    TEXT,
      abandoned_reason TEXT,
      UNIQUE (session_id, wrap_run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_handoff_pub_project ON handoff_publications(project_id, seq);
    -- At most one FINAL attempt per session can ever be eligible: the one that
    -- completed the lifecycle transition.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_pub_final_eligible
      ON handoff_publications(session_id) WHERE kind = 'final' AND eligible_at IS NOT NULL;

    -- Where handoffs began, per project (Train 21, #1586). One row per project,
    -- written once and never recomputed.
    --
    -- The launch preflight needs to tell a project whose whole history predates
    -- handoffs (nothing was lost) from one that ran a session after handoffs
    -- existed and published nothing (something was). Session ids are the only
    -- recorded ordering that answers that: epoch_session_id is MAX(sessions.id)
    -- at the instant the project crossed into handoff support, so "every session
    -- id <= the epoch" IS "this project predates handoffs".
    --
    -- Which is exactly why it is never recomputed. Taking today's maximum later
    -- draws the line too late and sweeps post-epoch sessions into the legacy
    -- window, downgrading a lost handoff to "predates handoffs" — in the unsafe
    -- direction. A boundary that was never recorded stays unknown: see
    -- baseline_reason.
    --
    -- project_id is a LOGICAL reference, matching handoff_publications above.
    CREATE TABLE IF NOT EXISTS project_handoff_epoch (
      project_id       INTEGER PRIMARY KEY,
      epoch_session_id INTEGER NOT NULL,
      baseline         TEXT    NOT NULL CHECK (baseline IN (${HANDOFF_BASELINE_VALUES.map((b) => "'" + b + "'").join(',')})),
      baseline_reason  TEXT,
      recorded_at      TEXT    NOT NULL
    );

    -- Switchboard nudge ledger (#792), the same shape and for the same reason as
    -- session_rule_deliveries above: a session that was never told about its mail
    -- and a session with no mail are indistinguishable from outside, so the
    -- operator becomes the transport. message_key is the inbox edge the nudge
    -- was about, so a row answers "was anyone told about THIS mail", not merely
    -- "did the monitor run".
    --
    -- session_id / project_id are LOGICAL references, same rationale as above.
    CREATE TABLE IF NOT EXISTS medusa_deliveries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      -- TEXT, not INTEGER: the Project Master is a participant too and its
      -- session key is the literal string 'master', so an integer column would
      -- either coerce it or push it into a null bucket where every Master row
      -- collapses together.
      session_id   TEXT,
      project_id   INTEGER,
      workspace_id TEXT,
      message_key  TEXT    NOT NULL,
      unread       INTEGER NOT NULL DEFAULT 0,
      channel      TEXT    NOT NULL CHECK (channel IN ('tmux-inject','master-inject','none')),
      outcome      TEXT    NOT NULL CHECK (outcome IN ('nudged','skipped','failed')),
      skip_reason  TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      -- The same impossible states the rules ledger rejects: nothing is nudged
      -- through no channel, and a non-delivery with no reason records that
      -- something went wrong while discarding what it was.
      CHECK (outcome != 'nudged' OR channel != 'none'),
      CHECK (outcome  = 'nudged' OR skip_reason IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_medusa_deliveries_session ON medusa_deliveries(session_id);
    CREATE INDEX IF NOT EXISTS idx_medusa_deliveries_project ON medusa_deliveries(project_id);

    -- Awareness receipts (ambient-awareness Chunk 02). One row per tc-CLI
    -- invocation the server observed. A session that invokes the CLI proved it
    -- discovered the capability TangleClaw put on its PATH; a session that
    -- never does is a DETECTABLE state instead of a silent one — the missing
    -- signal that let the prime channel stay severed for 12 days in August.
    -- project_id/session_id are LOGICAL references and nullable ON PURPOSE: an
    -- invocation with a wrong or missing id still proves the CLI was invoked,
    -- which is the fact this ledger measures.
    CREATE TABLE IF NOT EXISTS awareness_receipts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER,
      session_id   INTEGER,
      workspace_id TEXT,
      verb         TEXT    NOT NULL,
      -- Provenance: 'tc-cli' when the tc client identified itself, 'http' for
      -- any other GET (browser preview, health check). Without it, an operator
      -- opening the endpoint in a browser would fabricate the "this session
      -- became aware" fact the awareness view keys on.
      source       TEXT    NOT NULL DEFAULT 'http' CHECK (source IN ('tc-cli','http')),
      -- Non-project actor attribution (#1141): 'master' for the Project
      -- Master's invocations, NULL for every project session. A dedicated
      -- column, not workspace-id reuse — a medusa-disabled Master has no
      -- workspace id, and attribution must not couple to messaging opt-in.
      role         TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_awareness_receipts_project ON awareness_receipts(project_id);
    CREATE INDEX IF NOT EXISTS idx_awareness_receipts_session ON awareness_receipts(session_id);

    CREATE TABLE IF NOT EXISTS activity_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      event_type  TEXT    NOT NULL,
      detail      TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

    CREATE TABLE IF NOT EXISTS port_leases (
      host        TEXT NOT NULL DEFAULT 'localhost',
      port        INTEGER NOT NULL,
      project     TEXT NOT NULL,
      service     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active','expired','permanent')),
      permanent   INTEGER NOT NULL DEFAULT 0,
      ttl_ms      INTEGER,
      expires_at  TEXT,
      last_heartbeat TEXT,
      description TEXT,
      auto_renew  INTEGER NOT NULL DEFAULT 0,
      reach       TEXT NOT NULL DEFAULT 'loopback'
                  CHECK(${REACH_CHECK_SQL}),
      owner_kind  TEXT NOT NULL DEFAULT 'project'
                  CHECK(${OWNER_KIND_CHECK_SQL}),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (host, port)
    );

    CREATE INDEX IF NOT EXISTS idx_port_leases_project ON port_leases(project);
    CREATE INDEX IF NOT EXISTS idx_port_leases_status ON port_leases(status);

    CREATE TABLE IF NOT EXISTS project_groups (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      shared_dir  TEXT,
      release_owner_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_group_members (
      group_id    TEXT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      added_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, project_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pgm_project ON project_group_members(project_id);

    CREATE TABLE IF NOT EXISTS shared_documents (
      id                TEXT PRIMARY KEY,
      group_id          TEXT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      file_path         TEXT NOT NULL,
      inject_into_config INTEGER NOT NULL DEFAULT 0,
      inject_mode       TEXT NOT NULL DEFAULT 'reference'
                        CHECK(inject_mode IN ('reference','inline')),
      description       TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(group_id, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_shared_docs_group ON shared_documents(group_id);

    CREATE TABLE IF NOT EXISTS document_locks (
      document_id       TEXT PRIMARY KEY REFERENCES shared_documents(id) ON DELETE CASCADE,
      locked_by_session INTEGER NOT NULL,
      locked_by_project TEXT NOT NULL,
      locked_at         TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS openclaw_connections (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL UNIQUE,
      host              TEXT NOT NULL,
      port              INTEGER NOT NULL DEFAULT 18789,
      ssh_user          TEXT NOT NULL,
      ssh_key_path      TEXT NOT NULL,
      gateway_token     TEXT,
      cli_command       TEXT DEFAULT 'openclaw-cli',
      local_port        INTEGER NOT NULL DEFAULT 18789,
      available_as_engine INTEGER NOT NULL DEFAULT 0,
      default_mode      TEXT NOT NULL DEFAULT 'ssh',
      audit_secret      TEXT,
      bridge_port       INTEGER,
      bridge_token      TEXT,
      instance_dir      TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_openclaw_conn_name ON openclaw_connections(name);

    CREATE TABLE IF NOT EXISTS eval_exchanges (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      connection_id     TEXT,
      project           TEXT NOT NULL,
      agent_model       TEXT,
      timestamp         TEXT NOT NULL,
      turn_number       INTEGER,
      user_message      TEXT NOT NULL,
      agent_response    TEXT NOT NULL,
      agent_thinking    TEXT,
      usage_input_tokens  INTEGER,
      usage_output_tokens INTEGER,
      scored            INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_eval_exchanges_session ON eval_exchanges(session_id);
    CREATE INDEX IF NOT EXISTS idx_eval_exchanges_project ON eval_exchanges(project, timestamp);
    CREATE INDEX IF NOT EXISTS idx_eval_exchanges_scored ON eval_exchanges(scored);

    CREATE TABLE IF NOT EXISTS eval_scores (
      id                    TEXT PRIMARY KEY,
      exchange_id           TEXT NOT NULL REFERENCES eval_exchanges(id),
      schema_version        TEXT NOT NULL,
      judge_model           TEXT NOT NULL,
      scored_at             TEXT NOT NULL,
      tier_1_structural_score REAL,
      tier_1_flags          TEXT,
      tier_2_semantic_score REAL,
      tier_2_reasoning      TEXT,
      tier_2_skipped        INTEGER NOT NULL DEFAULT 0,
      tier_2_5_alignment_score REAL,
      tier_2_5_reasoning    TEXT,
      tier_2_5_skipped      INTEGER NOT NULL DEFAULT 0,
      tier_3_behavioral_score REAL,
      tier_3_dimension_scores TEXT,
      tier_3_skipped        INTEGER NOT NULL DEFAULT 0,
      anomaly_flag          INTEGER NOT NULL DEFAULT 0,
      anomaly_reason        TEXT,
      cost_usd              REAL,
      human_score           REAL,
      human_comment         TEXT,
      human_scored_at       TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_eval_scores_exchange ON eval_scores(exchange_id);
    CREATE INDEX IF NOT EXISTS idx_eval_scores_project_time ON eval_scores(scored_at);

    CREATE TABLE IF NOT EXISTS eval_baselines (
      id                  TEXT PRIMARY KEY,
      project             TEXT NOT NULL,
      computed_at         TEXT NOT NULL,
      window_start        TEXT NOT NULL,
      window_end          TEXT NOT NULL,
      dimension_averages  TEXT NOT NULL,
      exchange_count      INTEGER NOT NULL,
      schema_version      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_incidents (
      id            TEXT PRIMARY KEY,
      project       TEXT NOT NULL,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      severity      TEXT NOT NULL DEFAULT 'warning',
      title         TEXT NOT NULL,
      description   TEXT NOT NULL,
      metadata      TEXT,
      detected_at   TEXT NOT NULL,
      resolved_at   TEXT,
      resolved_by   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_eval_incidents_project ON eval_incidents(project, status);

    -- TangleClaw's own front door (ADR 0015). The principal a session
    -- authenticates AS, and the thing basic_auth structurally cannot provide:
    -- one shared credential in a generated Caddyfile has no per-person account
    -- to revoke, expire, or attribute a request to.
    --
    -- password_hash holds the scrypt salt:hash that lib/password.js produces.
    -- The salt lives inside that value, so there is no separate column; the
    -- format is the one already persisted for the delete guard.
    --
    -- disabled_at NULL means active. Revocation is a timestamp rather than a
    -- row delete so an account that once existed stays explicable.
    --
    -- username is CASE-SENSITIVE, deliberately: Rosie and rosie are two
    -- accounts. That matches the Caddy basic_auth credential this replaces, so
    -- the cutover changes no operator's login. COLLATE NOCASE was the
    -- alternative and was declined because SQLite folds ASCII only, which would
    -- make the rule silently different for a non-ASCII name.
    --
    -- Deliberately no role column. ADR 0015 is explicit that the only genuine
    -- tier-1 distinction is authenticated or not, and that admin is the
    -- operator's word for a tier-2 preferences concept. A role column added
    -- before anything reads it would be a security-shaped field that gates
    -- nothing, which is the drift the tier split exists to prevent.
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at   TEXT
    );

    -- Logged-in browser sessions for TangleClaw's own front door (#1418).
    --
    -- NAMED auth_sessions, not sessions, because sessions above is already
    -- TangleClaw's core domain table — the tmux/AI sessions the whole product
    -- is about. Two unrelated concepts under one word in one schema is how a
    -- later reader deletes the wrong rows.
    --
    -- token_hash stores a SHA-256 of the cookie token and the token itself is
    -- never written down. A session token is a bearer credential while it
    -- lives, so a database read — a backup, a .dump pasted into an issue — must
    -- not hand anyone a live session. UNIQUE because it is the lookup key.
    --
    -- csrf_token IS stored in the clear, and that asymmetry is deliberate: it
    -- is not a credential. It is a value the client must echo back to prove the
    -- request came from our own page, and it is useless to anyone who cannot
    -- already present the session cookie.
    --
    -- expires_at is epoch MILLISECONDS as an INTEGER, not a datetime() string
    -- like the columns above it. Expiry is compared on every gated request, and
    -- an integer comparison in the index beats parsing a string; the surrounding
    -- tables use datetime() because they are read by people, and this one is
    -- read by the gate.
    --
    -- username is denormalised onto the session ON PURPOSE. ADR 0016 records
    -- that users.getByName returns the password hash, so GET /api/auth/me
    -- must build its answer from the session and never from the user row; that
    -- is only possible if the session carries the name. Tier 1 has no rename,
    -- so there is nothing for the copy to drift from.
    --
    -- The REFERENCES clause states intent and is NOT relied on: SQLite disables
    -- foreign-key enforcement by default and this store never turns it on at
    -- open time, so ON DELETE CASCADE may or may not fire depending on which
    -- migrations a given install has run. Revocation is therefore enforced
    -- twice in code instead — users.disable deletes the account's sessions,
    -- and authSessions.resolve joins users and refuses a disabled one. A
    -- guarantee that rests on a pragma nobody sets is not a guarantee.
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash   TEXT NOT NULL UNIQUE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username     TEXT NOT NULL,
      csrf_token   TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

    -- One-time recovery codes (#1420): each resets one account's password once,
    -- from off the machine, for whoever holds it.
    --
    -- code_hash is a SHA-256 of the canonical code and the code itself is never
    -- written down, for the reason token_hash above gives. UNIQUE because it is
    -- the lookup key, and a lookup that could match two rows could consume the
    -- wrong one.
    --
    -- A used code is KEPT, with used_at and used_from, rather than deleted: the
    -- dashboard tells the account a code was used, and from where, until the
    -- account acknowledges it (notice_cleared_at). Regeneration deletes the
    -- account's whole set, used rows included, because it is the remedy the
    -- notice asks for.
    --
    -- Times are epoch milliseconds, like auth_sessions.expires_at.
    --
    -- The REFERENCES clause is intent only, as on auth_sessions. Nothing relies
    -- on the cascade: redemption joins users and refuses a disabled account, and
    -- no code path deletes a user row.
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash         TEXT NOT NULL UNIQUE,
      created_at        INTEGER NOT NULL,
      used_at           INTEGER,
      used_from         TEXT,
      notice_cleared_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);

    -- The startup prompt (#1825): the instruction a launch fires through an
    -- engine's native channel. Append-only, so every revision a fire named
    -- stays readable; the current prompt is the highest revision. A write is
    -- a compare-and-set on that revision (startupPromptsApi.update).
    -- firer_project_ids is the operator's list of projects whose sessions may
    -- fire the prompt. It lives HERE, not in config.json, because PATCH
    -- /api/config is reachable by agent sessions on loopback: a list stored
    -- there would let an agent authorize itself. Here it is written only with
    -- the prompt, by the strict operator write, as a new revision.
    --
    -- Two digests, because they vouch for different things: text_digest is
    -- the exact prompt bytes a fire delivers; policy_digest is the canonical
    -- firer list, which is authorization evidence for who could fire it.
    -- created_by_kind records how well the author was proven, never merely
    -- that "an operator" wrote it.
    CREATE TABLE IF NOT EXISTS startup_prompt_revisions (
      revision          INTEGER PRIMARY KEY CHECK (revision >= 1),
      text              TEXT    NOT NULL,
      text_digest       TEXT    NOT NULL,
      firer_project_ids TEXT    NOT NULL DEFAULT '[]',
      policy_digest     TEXT    NOT NULL,
      created_by_kind   TEXT    NOT NULL CHECK (created_by_kind IN ('seed','operator-verified','open-install-unverified')),
      created_by        TEXT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Every fire of the startup prompt, and what came of it. A durable table
    -- rather than activity_log, which is pruned. The row is written as an
    -- INTENT before any external effect, so a crash between a send and its
    -- receipt leaves a row in 'dispatching' or 'indeterminate', which is
    -- never retried automatically and never reads as unsent. It names the
    -- target by session and launch-sequence ROW id, never by launch id: a
    -- launch id is a bearer credential.
    ${_startupPromptFiresDdl('startup_prompt_fires')}
    ${_startupPromptFiresIndexesSql()}

    -- The native channel a launch's engine was given: the
    -- per-launch server TangleClaw started for it, so a restarted TangleClaw
    -- can find it again and a session's end can end it. The header is
    -- generic: which session and launch, which engine and adapter, and its
    -- lifecycle. Everything engine-specific (a socket, a pid, an engine
    -- thread) is adapter_state, a bounded JSON blob only the named adapter
    -- reads or writes, so neither this table nor any generic reader carries a
    -- Codex contract. One open channel per session; sequence_id names
    -- the launch generation it belongs to.
    CREATE TABLE IF NOT EXISTS startup_control_channels (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     INTEGER NOT NULL,
      sequence_id    INTEGER NOT NULL,
      engine_id      TEXT    NOT NULL,
      adapter        TEXT    NOT NULL,
      state          TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
      adapter_state  TEXT    NOT NULL DEFAULT '{}' CHECK (length(adapter_state) <= 8192),
      opened_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      closed_at      TEXT,
      close_reason   TEXT    CHECK (close_reason IS NULL OR length(close_reason) <= 200),
      -- How the teardown went: 'ok', 'skipped' (nothing to signal), or the
      -- error, recorded rather than hidden.
      teardown       TEXT    CHECK (teardown IS NULL OR length(teardown) <= 200)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_startup_control_channels_open
      ON startup_control_channels(session_id) WHERE state = 'open';

    ${_controlTablesDdl()}

    ${_medusaExchangeTablesDdl()}

    ${_workloadTablesDdl()}

    ${_workloadNudgeFactsDdl()}

    ${_coordinatorRotationTablesDdl()}

    ${_mergeQueueTablesDdl()}

    ${_checkWatchTablesDdl()}

    ${_launchIsolationOverridesDdl()}

    ${_sharedDocEventsDdl()}

    ${_sharedDocNoticeDdl()}

    ${_usageCalibrationTableDdl()}

    ${_usageWindowAggregatesTableDdl()}
  `);

  // The operator bridge's storage is created after the migrations, in `init`:
  // a store from an earlier version has to be brought to the current shape
  // before that shape can be demanded of it.

  // Seed revision 1 of the startup prompt, with an EMPTY firer list: until the
  // operator says otherwise, only the operator may fire it. Here rather than in
  // the v45 migration because a fresh install stamps the current schema
  // version below without running any migration, and would otherwise start
  // with no prompt. A no-op on every later boot.
  _db.prepare(
    'INSERT INTO startup_prompt_revisions (revision, text, text_digest, firer_project_ids, policy_digest, created_by_kind) '
    + "SELECT 1, ?, ?, '[]', ?, 'seed' WHERE NOT EXISTS (SELECT 1 FROM startup_prompt_revisions)"
  ).run(STARTUP_PROMPT_SEED, _startupPromptDigest(STARTUP_PROMPT_SEED), _startupPolicyDigest([]));

  // Seed schema version if empty
  const row = _db.prepare('SELECT COUNT(*) as count FROM schema_version').get();
  if (row.count === 0) {
    _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
  }
}

/**
 * Run any pending migrations.
 */
function _runMigrations() {
  const row = _db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
  const currentVersion = row ? row.version : 0;

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    log.info('Running migrations', { from: currentVersion, to: CURRENT_SCHEMA_VERSION });

    if (currentVersion < 2) {
      // v1→v2: add port_leases table (CREATE IF NOT EXISTS in _createTables handles the DDL)
      log.info('Migration v1→v2: port_leases table added');
    }

    if (currentVersion < 3) {
      // v2→v3: add project_groups, project_group_members, shared_documents, document_locks
      // (CREATE IF NOT EXISTS in _createTables handles the DDL)
      log.info('Migration v2→v3: shared documents tables added');
    }

    if (currentVersion < 4) {
      // v3→v4: add shared_dir column to project_groups
      try {
        _db.exec('ALTER TABLE project_groups ADD COLUMN shared_dir TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v3→v4: shared_dir column added to project_groups');
    }

    if (currentVersion < 5) {
      // v4→v5: add openclaw_connections table
      // (CREATE IF NOT EXISTS in _createTables handles the DDL)
      log.info('Migration v4→v5: openclaw_connections table added');
    }

    if (currentVersion < 6) {
      // v5→v6: add session_mode column to sessions table
      try {
        _db.exec("ALTER TABLE sessions ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'tmux'");
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v5→v6: session_mode column added to sessions');
    }

    if (currentVersion < 7) {
      // v6→v7: add default_mode column to openclaw_connections table
      try {
        _db.exec("ALTER TABLE openclaw_connections ADD COLUMN default_mode TEXT NOT NULL DEFAULT 'ssh'");
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v6→v7: default_mode column added to openclaw_connections');
    }

    if (currentVersion < 8) {
      // v7→v8: add host column to port_leases, change PK from port to (host, port)
      // SQLite doesn't support ALTER TABLE to change PK, so we recreate the table.
      try {
        _db.exec(`
          ALTER TABLE port_leases RENAME TO port_leases_old;
          CREATE TABLE port_leases (
            host        TEXT NOT NULL DEFAULT 'localhost',
            port        INTEGER NOT NULL,
            project     TEXT NOT NULL,
            service     TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','expired','permanent')),
            permanent   INTEGER NOT NULL DEFAULT 0,
            ttl_ms      INTEGER,
            expires_at  TEXT,
            last_heartbeat TEXT,
            description TEXT,
            auto_renew  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (host, port)
          );
          INSERT INTO port_leases (host, port, project, service, status, permanent, ttl_ms, expires_at, last_heartbeat, description, auto_renew, created_at, updated_at)
            SELECT 'localhost', port, project, service, status, permanent, ttl_ms, expires_at, last_heartbeat, description, auto_renew, created_at, updated_at
            FROM port_leases_old;
          DROP TABLE port_leases_old;
          CREATE INDEX IF NOT EXISTS idx_port_leases_project ON port_leases(project);
          CREATE INDEX IF NOT EXISTS idx_port_leases_status ON port_leases(status);
          CREATE INDEX IF NOT EXISTS idx_port_leases_host ON port_leases(host);
        `);
      } catch (err) {
        // Table may already have the new schema from a fresh _createTables
        log.debug('Migration v7→v8 skipped (table may already have host column)', { error: err.message });
      }
      log.info('Migration v7→v8: host column added to port_leases, PK is now (host, port)');
    }

    if (currentVersion < 9) {
      // v8→v9: add eval audit tables (CREATE IF NOT EXISTS in _createTables handles DDL)
      // Add audit_secret column to openclaw_connections
      try {
        _db.exec('ALTER TABLE openclaw_connections ADD COLUMN audit_secret TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v8→v9: eval audit tables + audit_secret column added');
    }

    if (currentVersion < 10) {
      // v9→v10: add human scoring columns to eval_scores, retention support
      const alterCols = [
        'ALTER TABLE eval_scores ADD COLUMN human_score REAL',
        'ALTER TABLE eval_scores ADD COLUMN human_comment TEXT',
        'ALTER TABLE eval_scores ADD COLUMN human_scored_at TEXT'
      ];
      for (const sql of alterCols) {
        try { _db.exec(sql); } catch { /* column may already exist */ }
      }
      log.info('Migration v9→v10: human scoring columns added to eval_scores');
    }

    if (currentVersion < 11) {
      // v10→v11: add bridge_port column to openclaw_connections (ClawBridge direct port)
      try {
        _db.exec("ALTER TABLE openclaw_connections ADD COLUMN bridge_port INTEGER NOT NULL DEFAULT 3201");
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v10→v11: bridge_port column added to openclaw_connections');
    }

    if (currentVersion < 12) {
      // v11→v12: add bridge_token column to openclaw_connections (ClawBridge auth token)
      try {
        _db.exec('ALTER TABLE openclaw_connections ADD COLUMN bridge_token TEXT');
      } catch {
        // Column may already exist
      }
      log.info('Migration v11→v12: bridge_token column added to openclaw_connections');
    }

    if (currentVersion < 13) {
      // v12→v13: add launch_mode column to sessions
      try {
        _db.exec('ALTER TABLE sessions ADD COLUMN launch_mode TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v12→v13: launch_mode column added to sessions');
    }

    if (currentVersion < 14) {
      // v13→v14: add wrap_started_at column so the launch-guard could tell a
      // long-lived session that just wrapped from a stale wrapping row (#105).
      // The status it timed no longer exists (#1034); the column is historical.
      try {
        _db.exec('ALTER TABLE sessions ADD COLUMN wrap_started_at TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v13→v14: wrap_started_at column added to sessions');
    }

    if (currentVersion < 15) {
      // v14→v15: drop the NOT NULL constraint on openclaw_connections.bridge_port
      // and remove its `DEFAULT 3201` (#160). Pre-#160 the column was
      // `INTEGER NOT NULL DEFAULT 3201`, which silently filled in 3201 for every
      // non-ClawBridge connection — that bogus value then drove a stray local
      // `-L 3201:127.0.0.1:3201` SSH forward and killed the entire tunnel via
      // `ExitOnForwardFailure=yes`. SQLite can't ALTER COLUMN to drop NOT NULL,
      // so we recreate the table preserving every existing row's data verbatim
      // (rows that already have 3201 keep 3201 — that's intentional; the
      // migration only changes the column constraint, not the existing data).
      try {
        // node:sqlite's DatabaseSync does not expose a `.transaction()`
        // wrapper the way better-sqlite3 does, so wrap the recreate sequence
        // with explicit BEGIN/COMMIT inside the SQL itself — if any
        // intermediate statement fails, the surrounding catch sees the throw
        // and the postcondition check rejects schema_version advancement.
        _db.exec(`
          BEGIN;
          CREATE TABLE openclaw_connections_new (
            id                TEXT PRIMARY KEY,
            name              TEXT NOT NULL UNIQUE,
            host              TEXT NOT NULL,
            port              INTEGER NOT NULL DEFAULT 18789,
            ssh_user          TEXT NOT NULL,
            ssh_key_path      TEXT NOT NULL,
            gateway_token     TEXT,
            cli_command       TEXT DEFAULT 'openclaw-cli',
            local_port        INTEGER NOT NULL DEFAULT 18789,
            available_as_engine INTEGER NOT NULL DEFAULT 0,
            default_mode      TEXT NOT NULL DEFAULT 'ssh',
            audit_secret      TEXT,
            bridge_port       INTEGER,
            bridge_token      TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO openclaw_connections_new
            (id, name, host, port, ssh_user, ssh_key_path, gateway_token,
             cli_command, local_port, available_as_engine, default_mode,
             audit_secret, bridge_port, bridge_token, created_at)
            SELECT id, name, host, port, ssh_user, ssh_key_path, gateway_token,
                   cli_command, local_port, available_as_engine, default_mode,
                   audit_secret, bridge_port, bridge_token, created_at
            FROM openclaw_connections;
          DROP TABLE openclaw_connections;
          ALTER TABLE openclaw_connections_new RENAME TO openclaw_connections;
          CREATE INDEX IF NOT EXISTS idx_openclaw_conn_name ON openclaw_connections(name);
          COMMIT;
        `);
      } catch (err) {
        // Attempt to roll back if a BEGIN landed but COMMIT didn't. Best-effort:
        // if no transaction is open this throws and we ignore.
        try { _db.exec('ROLLBACK'); } catch { /* no transaction in progress */ }
        // Table may already have the post-#160 nullable schema on a fresh
        // install (the `CREATE TABLE IF NOT EXISTS openclaw_connections` block
        // above declares `bridge_port INTEGER` without NOT NULL, so a brand-new
        // DB created by this version doesn't need the recreate step). Defer
        // the decision to the postcondition check below.
        log.debug('Migration v14→v15 recreate skipped (table may already match target schema)', { error: err.message });
      }

      // Postcondition: verify bridge_port is actually nullable before advancing
      // schema_version (Critic MAJOR-3). Pre-#160 the silent-skip pattern from
      // older migrations would mark the DB v15 with a v14 schema still in
      // place — subsequent `bridgePort: null` inserts would then fail with
      // SQLITE_CONSTRAINT_NOTNULL. Fail loudly so the user sees the breakage
      // at boot rather than at first save.
      const colInfo = _db.prepare("PRAGMA table_info(openclaw_connections)").all();
      const bridgeCol = colInfo.find((c) => c.name === 'bridge_port');
      if (!bridgeCol || bridgeCol.notnull !== 0) {
        throw new Error(
          `v14→v15 migration did not produce a nullable bridge_port column ` +
          `(notnull=${bridgeCol ? bridgeCol.notnull : 'column missing'}, dflt_value=${bridgeCol ? bridgeCol.dflt_value : 'n/a'}). ` +
          `Aborting — schema_version will NOT advance to 15 until this is resolved. See #160.`
        );
      }
      log.info('Migration v14→v15: bridge_port is now nullable on openclaw_connections (#160)');
    }

    if (currentVersion < 16) {
      // v15→v16: add instance_dir to openclaw_connections (#296). The host path
      // of the instance's compose/.env dir, used to read the OpenClaw image-tag
      // version (`OPENCLAW_IMAGE=...:<tag>`) over SSH for per-connection display.
      try {
        _db.exec('ALTER TABLE openclaw_connections ADD COLUMN instance_dir TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v15→v16: instance_dir column added to openclaw_connections (#296)');
    }

    if (currentVersion < 17) {
      // v16→v17: add migration_status to projects (#262/#354, C1). Tracks a
      // project's V2-plugin migration state for operator follow-up + the C2
      // drift indicator: NULL (untouched) | 'migrated' | 'pending-activation'
      // (ref written, plugin not yet installed on this machine) | 'declined' |
      // 'not-applicable' (non-Claude — the Claude-only plugin can't serve it).
      try {
        _db.exec('ALTER TABLE projects ADD COLUMN migration_status TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v16→v17: migration_status column added to projects (#262)');
    }

    if (currentVersion < 18) {
      // v17→v18: add session_rules table (#347/D1a). Durable operator-authored
      // behavioral directives injected cross-model at session launch, alongside
      // global-rules. NULL project_id = global; the nullable owner column is an
      // auth-ready seam for AUTH/#347. CREATE IF NOT EXISTS in _createTables
      // handles the DDL; this step is a no-op on a fresh schema.
      try {
        _db.exec(`
          CREATE TABLE IF NOT EXISTS session_rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
            content     TEXT    NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_by  TEXT    NOT NULL DEFAULT 'operator',
            owner       TEXT,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_session_rules_project ON session_rules(project_id);
          CREATE INDEX IF NOT EXISTS idx_session_rules_enabled ON session_rules(enabled);
        `);
      } catch (err) {
        // Table may already exist if _createTables ran with the new schema
        log.debug('Migration v17→v18 skipped (session_rules may already exist)', { error: err.message });
      }
      log.info('Migration v17→v18: session_rules table added (#347/D1a)');
    }

    if (currentVersion < 19) {
      // v18→v19: D1b self-improvement. (1) session_rule_versions table —
      // version history so any autonomous rule edit is reversible (rollback).
      // (2) source_learning_id column on session_rules — provenance for rules
      // promoted from a learning. CREATE IF NOT EXISTS handles a fresh schema;
      // the ALTER backfills an existing v18 session_rules table.
      try {
        _db.exec(`
          CREATE TABLE IF NOT EXISTS session_rule_versions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id       INTEGER NOT NULL,
            version_no    INTEGER NOT NULL,
            op            TEXT    NOT NULL,
            content       TEXT    NOT NULL,
            enabled       INTEGER NOT NULL,
            created_by    TEXT    NOT NULL,
            owner         TEXT,
            changed_by    TEXT    NOT NULL DEFAULT 'operator',
            change_reason TEXT,
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_session_rule_versions_rule ON session_rule_versions(rule_id);
        `);
      } catch (err) {
        log.debug('Migration v18→v19 versions table skipped (may already exist)', { error: err.message });
      }
      try {
        _db.exec('ALTER TABLE session_rules ADD COLUMN source_learning_id INTEGER REFERENCES learnings(id) ON DELETE SET NULL');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v18→v19: session_rule_versions table + source_learning_id column added (D1b)');
    }

    if (currentVersion < 20) {
      // v19→v20: CC-6 (#381). Add a `kind` discriminator to session_rules so the
      // per-project Project Rules modal can host three rule kinds — 'startup'
      // (launch-injected, the existing behavior), 'wrap' (read at wrap time / the
      // self-learning sink), and 'mode' (harness posture; runtime = A3). Existing
      // rows backfill to 'startup' so the launch-injection query (which now filters
      // to kind='startup') keeps injecting every pre-existing rule — no regression.
      // CREATE IF NOT EXISTS handles a fresh schema; the ALTER backfills a v19 table.
      try {
        _db.exec("ALTER TABLE session_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'startup'");
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v19→v20: kind column added to session_rules (CC-6/#381)');
    }

    if (currentVersion < 21) {
      // v20→v21: AUTH-3 (#1). Add a nullable `owner` column to sessions: the
      // user a session was launched by. It is stamped from the signed-in
      // TangleClaw session (it was first filled from Caddy's X-Auth-User header,
      // which is no longer read). NULL for a session launched with no login
      // required, so existing rows need no backfill — unauthenticated == NULL.
      try {
        _db.exec('ALTER TABLE sessions ADD COLUMN owner TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v20→v21: owner column added to sessions (AUTH-3/#1)');
    }

    if (currentVersion < 22) {
      // v21→v22: TB-1 (#357). Add a nullable `orchestration_profile` column to
      // projects — the launch-binder binding. NULL = unbound = today's behavior
      // (zero injection at launch), so existing rows need no backfill. When set,
      // it names a profile in ~/.tangleclaw/orchestration-profiles.json and TC
      // injects that profile's (base_url, key, model) at session launch.
      try {
        _db.exec('ALTER TABLE projects ADD COLUMN orchestration_profile TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v21→v22: orchestration_profile column added to projects (TB-1/#357)');
    }

    if (currentVersion < 23) {
      // v22→v23: SR-3MW8. Pin session_rule_versions.op to the enum its writer
      // already uses ('create'|'update'|'delete'|'restore'). Every insert goes
      // through `_snapshotSessionRule`, whose only four callers pass exactly those
      // literals — so no existing row can violate the constraint — but nothing
      // enforced it at the storage layer. Without it, a future writer bug or a
      // manual edit could land a garbage op and silently corrupt the reversible
      // audit history the table exists to guarantee. SQLite cannot add a CHECK via
      // ALTER TABLE, so recreate the table with the constraint, preserving every
      // existing row (id, version_no, and all columns) verbatim. A fresh DB gets
      // the CHECK directly from the _createTables DDL above and stamps v23 without
      // entering this block, so this only fires for a pre-v23 DB whose table
      // already exists without the constraint. Mirrors the v14→v15 rebuild pattern.
      let recreateErr = null;
      try {
        // node:sqlite's DatabaseSync has no `.transaction()` wrapper, so bracket
        // the recreate with explicit BEGIN/COMMIT in the SQL — any intermediate
        // failure throws, the catch rolls back, and the postcondition below blocks
        // schema_version from advancing.
        _db.exec(`
          BEGIN;
          CREATE TABLE session_rule_versions_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id       INTEGER NOT NULL,
            version_no    INTEGER NOT NULL,
            op            TEXT    NOT NULL CHECK (op IN ('create','update','delete','restore')),
            content       TEXT    NOT NULL,
            enabled       INTEGER NOT NULL,
            created_by    TEXT    NOT NULL,
            owner         TEXT,
            changed_by    TEXT    NOT NULL DEFAULT 'operator',
            change_reason TEXT,
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO session_rule_versions_new
            (id, rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, created_at)
            SELECT id, rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, created_at
            FROM session_rule_versions;
          DROP TABLE session_rule_versions;
          ALTER TABLE session_rule_versions_new RENAME TO session_rule_versions;
          CREATE INDEX IF NOT EXISTS idx_session_rule_versions_rule ON session_rule_versions(rule_id);
          COMMIT;
        `);
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* no transaction in progress */ }
        // This block only runs for a pre-v23 DB whose table exists WITHOUT the
        // CHECK, so the rebuild should succeed — a failure is a genuine problem,
        // most likely a pre-existing out-of-enum `op` value that the new CHECK
        // (correctly) rejects during the INSERT...SELECT copy. Preserve the real
        // error and surface it at warn level so the postcondition below can
        // attribute the root cause instead of misreporting "CHECK not produced".
        recreateErr = err;
        log.warn('Migration v22→v23 recreate failed — see postcondition', { error: err.message });
      }

      // Postcondition: verify the CHECK is actually present before advancing
      // schema_version. PRAGMA table_info does not surface CHECK clauses, so read
      // the table's DDL from sqlite_master and assert the enum guard is there.
      // Fail loudly (as v14→v15 does) so a botched rebuild surfaces at boot rather
      // than as a silent no-op that marks the DB v23 with a v22 schema in place.
      const ddl = _db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_versions'"
      ).get();
      if (!ddl || !/CHECK\s*\(\s*op\s+IN/i.test(ddl.sql)) {
        // Attribute the root cause: if the rebuild threw (e.g. a pre-existing
        // out-of-enum op that the copy rejected), name that; otherwise report the
        // constraint-absent state directly.
        const cause = recreateErr
          ? `the table rebuild failed — likely a pre-existing out-of-enum op value: ${recreateErr.message}`
          : `found: ${ddl ? ddl.sql : 'table missing'}`;
        throw new Error(
          `v22→v23 migration did not produce a CHECK constraint on session_rule_versions.op ` +
          `(${cause}). Aborting — schema_version will NOT advance to 23 until this is resolved. See SR-3MW8.`
        );
      }
      log.info('Migration v22→v23: CHECK constraint added to session_rule_versions.op (SR-3MW8)');
    }

    if (currentVersion < 24) {
      // v23→v24: SR-7K2P. Add `critic_gate` to session_rule_versions — a
      // per-mutation attestation of whether the edit passed the in-session Critic
      // gate ('passed' | 'not-required' | 'unknown'). The server can neither
      // summon nor verify the Critic, so this RECORDS the AI's apply-time
      // attestation; it does not enforce it. Existing rows predate the column and
      // carry no attestation, so they default to 'unknown' (an honest "we don't
      // know", never a presumed 'passed'). SQLite cannot add a CHECK via ALTER
      // TABLE, so recreate the table with both the op CHECK (from v23) and the new
      // critic_gate CHECK, preserving every existing row verbatim. A fresh DB gets
      // both CHECKs directly from the _createTables DDL above and stamps v24
      // without entering this block. Mirrors SR-3MW8's v22→v23 rebuild.
      let recreateErr = null;
      try {
        // node:sqlite's DatabaseSync has no `.transaction()` wrapper, so bracket
        // the recreate with explicit BEGIN/COMMIT — any intermediate failure
        // throws, the catch rolls back, and the postcondition blocks the version
        // bump.
        _db.exec(`
          BEGIN;
          CREATE TABLE session_rule_versions_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id       INTEGER NOT NULL,
            version_no    INTEGER NOT NULL,
            op            TEXT    NOT NULL CHECK (op IN ('create','update','delete','restore')),
            content       TEXT    NOT NULL,
            enabled       INTEGER NOT NULL,
            created_by    TEXT    NOT NULL,
            owner         TEXT,
            changed_by    TEXT    NOT NULL DEFAULT 'operator',
            change_reason TEXT,
            critic_gate   TEXT    NOT NULL DEFAULT 'unknown' CHECK (critic_gate IN ('passed','not-required','unknown')),
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO session_rule_versions_new
            (id, rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, created_at)
            SELECT id, rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, created_at
            FROM session_rule_versions;
          DROP TABLE session_rule_versions;
          ALTER TABLE session_rule_versions_new RENAME TO session_rule_versions;
          CREATE INDEX IF NOT EXISTS idx_session_rule_versions_rule ON session_rule_versions(rule_id);
          COMMIT;
        `);
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* no transaction in progress */ }
        // critic_gate is a NEW column with no pre-existing values to violate the
        // CHECK, so the INSERT...SELECT (which omits critic_gate → takes DEFAULT
        // 'unknown') should never be rejected. A failure is therefore a genuine
        // problem; preserve the real error so the postcondition can attribute it
        // rather than misreporting "CHECK not produced".
        recreateErr = err;
        log.warn('Migration v23→v24 recreate failed — see postcondition', { error: err.message });
      }

      // Postcondition: verify the critic_gate CHECK is actually present before
      // advancing schema_version. PRAGMA table_info does not surface CHECK clauses,
      // so read the table's DDL from sqlite_master. Fail loudly (as v22→v23 does)
      // so a botched rebuild surfaces at boot rather than as a silent no-op that
      // marks the DB v24 with a v23 schema in place.
      const ddl = _db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_versions'"
      ).get();
      if (!ddl || !/CHECK\s*\(\s*critic_gate\s+IN/i.test(ddl.sql)) {
        const cause = recreateErr
          ? `the table rebuild failed: ${recreateErr.message}`
          : `found: ${ddl ? ddl.sql : 'table missing'}`;
        throw new Error(
          `v23→v24 migration did not produce a CHECK constraint on session_rule_versions.critic_gate ` +
          `(${cause}). Aborting — schema_version will NOT advance to 24 until this is resolved. See SR-7K2P.`
        );
      }
      log.info('Migration v23→v24: critic_gate provenance column added to session_rule_versions (SR-7K2P)');
    }

    if (currentVersion < 25) {
      // v24→v25: two session-rules tiers retired. `kind='mode'` rules (harness
      // posture became the structured `defaultLaunchMode`/`showLaunchModePicker`
      // project settings, never had a runtime consumer) and the hidden global
      // tier (project_id IS NULL rows — cross-project directives belong in the
      // Global rules document). The 2026-07-17 fleet audit found ZERO rows in
      // either tier, so this is defensive cleanup: any row that slipped in
      // since would be invisible dead weight (no list surface, no injection
      // path) if left behind. Version-history rows are kept — provenance
      // outlives the rule, matching soft-delete semantics elsewhere.
      const purged = _db.prepare(
        "DELETE FROM session_rules WHERE kind = 'mode' OR project_id IS NULL"
      ).run();
      log.info('Migration v24→v25: retired mode-kind and global-tier session rules purged', { rows: purged.changes });
    }

    if (currentVersion < 26) {
      // v25→v26: session_rule_deliveries (#595). Startup rules were structurally
      // undeliverable on every plugin-governed project and nothing recorded that
      // fact, so the severed channel looked identical to "no rules configured".
      // This ledger makes delivery answerable. CREATE IF NOT EXISTS handles a
      // fresh schema built by _createTables; this backfills an existing db.
      //
      // Deliberately NOT wrapped in a try/catch. Every statement here is
      // IF NOT EXISTS, so "already exists" cannot throw — the only thing a
      // catch could swallow is a genuine failure, and swallowing it would stamp
      // the schema as v26 over a database with no such table. The ledger would
      // then fail every write, and `_recordRuleDelivery` logs and continues, so
      // the failure would surface as a permanently empty ledger: the same
      // silent-severance shape as the bug this table exists to detect.
      _db.exec(`
        CREATE TABLE IF NOT EXISTS session_rule_deliveries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome != 'delivered' OR channel != 'none'),
          CHECK (outcome != 'skipped'   OR skip_reason IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);
      `);
      log.info('Migration v25→v26: session_rule_deliveries ledger added (#595)');
    }

    if (currentVersion < 27) {
      // v26→v27: `status` on session_rules (#569). The wrap can now PROPOSE a
      // rule, which needs a state between "does not exist" and "governs every
      // future session". `enabled` could not carry it: that flag means "the
      // operator switched this rule off", so storing proposals as enabled=0 makes
      // a REJECTED rule indistinguishable from an unreviewed one, and the wrap
      // would re-propose everything the operator already declined, forever.
      //
      // Every pre-existing row is a rule that already governs sessions, so they
      // backfill to 'active' — the column default. That is the honest reading:
      // they were never proposals, and back-dating them into review would
      // silently switch off working rules on upgrade.
      //
      // SQLite cannot add a CHECK via ALTER TABLE, so recreate the table
      // preserving every row verbatim. Mirrors the v23→v24 rebuild.
      let statusRecreateErr = null;
      try {
        // SQLite's documented procedure for a table rebuild: foreign-key
        // enforcement OFF around it, and it must be set OUTSIDE the transaction
        // (the pragma is a no-op inside one). This matters beyond ceremony here
        // — `session_rules` references `projects` and `learnings`, and a
        // database can legitimately contain a row whose referent is already
        // gone. Re-inserting under enforcement would abort the whole migration
        // on such a row, so a pre-existing orphan would block the upgrade
        // instead of surviving it. A migration preserves what it finds; it is
        // not the place to start deleting the operator's data.
        _db.exec('PRAGMA foreign_keys = OFF');
        _db.exec(`
          BEGIN;
          CREATE TABLE session_rules_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,
            content           TEXT    NOT NULL,
            enabled           INTEGER NOT NULL DEFAULT 1,
            created_by        TEXT    NOT NULL DEFAULT 'operator',
            kind              TEXT    NOT NULL DEFAULT 'startup',
            owner             TEXT,
            source_learning_id INTEGER REFERENCES learnings(id) ON DELETE SET NULL,
            status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','rejected')),
            created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO session_rules_new
            (id, project_id, content, enabled, created_by, kind, owner, source_learning_id, created_at, updated_at)
            SELECT id, project_id, content, enabled, created_by, kind, owner, source_learning_id, created_at, updated_at
            FROM session_rules;
          DROP TABLE session_rules;
          ALTER TABLE session_rules_new RENAME TO session_rules;
          CREATE INDEX IF NOT EXISTS idx_session_rules_project ON session_rules(project_id);
          CREATE INDEX IF NOT EXISTS idx_session_rules_enabled ON session_rules(enabled);
          CREATE INDEX IF NOT EXISTS idx_session_rules_status ON session_rules(status);
          COMMIT;
        `);
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* no transaction in progress */ }
        // `status` is a new column taking its DEFAULT on the INSERT...SELECT, so
        // no pre-existing value can violate the CHECK. A failure here is real.
        statusRecreateErr = err;
        log.warn('Migration v26→v27 recreate failed — see postcondition', { error: err.message });
      } finally {
        // Restore enforcement whatever happened, including on the rollback path
        // — leaving it off would silently disable FK checking for the rest of
        // the process's life, long after this migration is forgotten.
        try { _db.exec('PRAGMA foreign_keys = ON'); } catch { /* connection already gone */ }
      }

      // Postcondition: refuse to advance the version unless the CHECK is really
      // present. A silent no-op here would stamp the DB v27 with a v26 schema, and
      // every proposal would then be written as an ordinary active rule — the
      // exact silent self-modification this chunk exists to prevent.
      const srDdl = _db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rules'"
      ).get();
      if (!srDdl || !/CHECK\s*\(\s*status\s+IN/i.test(srDdl.sql)) {
        const cause = statusRecreateErr
          ? `the table rebuild failed: ${statusRecreateErr.message}`
          : `found: ${srDdl ? srDdl.sql : 'table missing'}`;
        throw new Error(
          `v26→v27 migration did not produce a CHECK constraint on session_rules.status ` +
          `(${cause}). Aborting — schema_version will NOT advance to 27 until this is resolved. See #569.`
        );
      }
      log.info('Migration v26→v27: status column added to session_rules (#569)');
    }

    if (currentVersion < 28) {
      _migrateDropMethodology();
    }

    if (currentVersion < 29) {
      // v28→v29 (#749): rules moved off the prime file onto their own startup
      // hook, so the ledger needs a channel value that names where they
      // actually went. Without it the only representable answer was
      // 'prime-file' — a row asserting delivery through a file that now carries
      // a manifest, not the rules. SQLite cannot alter a CHECK in place, so the
      // table is rebuilt; existing rows are preserved verbatim because the
      // audit trail's whole value is outliving what it describes.
      // Transactional, like every sibling table rebuild here. Without it a
      // failure between DROP and RENAME leaves schema_version at 28, so the
      // next boot re-enters this branch and dies on "table already exists" —
      // an unbootable server, from a migration whose whole promise is that the
      // audit trail survives.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(`
        CREATE TABLE session_rule_deliveries_v29 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome != 'delivered' OR channel != 'none'),
          CHECK (outcome != 'skipped'   OR skip_reason IS NOT NULL)
        );
        INSERT INTO session_rule_deliveries_v29
          SELECT id, session_id, project_id, engine_id, kind, channel, outcome,
                 skip_reason, rule_ids, rule_count, digest, created_at
          FROM session_rule_deliveries;
        DROP TABLE session_rule_deliveries;
        ALTER TABLE session_rule_deliveries_v29 RENAME TO session_rule_deliveries;
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);
        `);
        // Postcondition: the rebuilt table must accept the value the rebuild
        // exists to allow. PRAGMA table_info does not surface CHECK clauses —
        // it would report `channel` present on the v28 table too — so read the
        // DDL from sqlite_master, exactly as the v22→v23 rebuild above does.
        // Probing the column instead would pass against a rebuild that copied
        // the OLD constraint forward, which is the only failure this guard
        // exists to catch.
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_deliveries'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes('rules-hook')) {
          throw new Error(
            'v28→v29 rebuild did not widen the channel CHECK — session_rule_deliveries '
            + 'still rejects rules-hook. Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v28→v29: rules-hook delivery channel added (#749)');
    }

    if (currentVersion < 30) {
      // v29→v30: medusa_deliveries (#792). A Switchboard message could land in
      // the inbox with the session never told, and nothing anywhere recorded the
      // miss — so an unread inbox and a severed nudge channel looked identical,
      // and a human relaying badges by hand was the only thing keeping an
      // exchange alive. This is the same ledger #595 built for startup rules,
      // for the same reason: an empty-looking session and a severed channel must
      // be distinguishable.
      //
      // Deliberately NOT wrapped in a try/catch, for the reason spelled out at
      // v25→v26: every statement is IF NOT EXISTS, so the only thing a catch
      // could swallow is a real failure — and swallowing it would stamp the
      // schema as v30 over a database with no such table, leaving a permanently
      // empty ledger. That is the same silent-severance shape this table exists
      // to detect.
      _db.exec(`
        CREATE TABLE IF NOT EXISTS medusa_deliveries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   TEXT,
          project_id   INTEGER,
          workspace_id TEXT,
          message_key  TEXT    NOT NULL,
          unread       INTEGER NOT NULL DEFAULT 0,
          channel      TEXT    NOT NULL CHECK (channel IN ('tmux-inject','master-inject','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('nudged','skipped','failed')),
          skip_reason  TEXT,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome != 'nudged' OR channel != 'none'),
          CHECK (outcome  = 'nudged' OR skip_reason IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS idx_medusa_deliveries_session ON medusa_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_medusa_deliveries_project ON medusa_deliveries(project_id);
      `);
      log.info('Migration v29→v30: medusa_deliveries ledger added (#792)');
    }

    if (currentVersion < 31) {
      // v30→v31 (#1063): the outcome enum gains 'unverified'. Until now the
      // paste path recorded 'delivered' on the strength of tmux send-keys not
      // throwing — a fact about the local tmux server, not about what any
      // engine received — so a channel that was 100% broken produced a clean
      // ledger. 'unverified' is the honest row for a send nobody observed
      // landing. SQLite cannot alter a CHECK in place, so the table is rebuilt
      // exactly as v28→v29 did; rows are preserved verbatim because the audit
      // trail's whole value is outliving what it describes.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(`
        CREATE TABLE session_rule_deliveries_v31 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped','unverified')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome NOT IN ('delivered','unverified') OR channel != 'none'),
          CHECK (outcome NOT IN ('skipped','unverified')   OR skip_reason IS NOT NULL)
        );
        INSERT INTO session_rule_deliveries_v31
          SELECT id, session_id, project_id, engine_id, kind, channel, outcome,
                 skip_reason, rule_ids, rule_count, digest, created_at
          FROM session_rule_deliveries;
        DROP TABLE session_rule_deliveries;
        ALTER TABLE session_rule_deliveries_v31 RENAME TO session_rule_deliveries;
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);
        `);
        // Postcondition, same rationale and mechanism as v28→v29 above: PRAGMA
        // table_info cannot surface CHECK clauses, so read the DDL and confirm
        // the rebuilt table actually accepts the value the rebuild exists to
        // allow.
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_deliveries'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes('unverified')) {
          throw new Error(
            'v30→v31 rebuild did not widen the outcome CHECK — session_rule_deliveries '
            + 'still rejects unverified. Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v30→v31: unverified delivery outcome added (#1063)');
    }

    if (currentVersion < 32) {
      // v31→v32: awareness_receipts (ambient-awareness Chunk 02). A session
      // that invokes `tc` proves it discovered the CLI TangleClaw put on its
      // PATH; a session that never does is a DETECTABLE state — the signal
      // that was missing when the prime channel regressed on 2026-08-18 and
      // nothing noticed for 12 days. Same additive shape and same no-catch
      // rationale as v29→v30: every statement is IF NOT EXISTS, and swallowing
      // a real failure would stamp v32 over a database with no table — a
      // permanently empty ledger is the exact silent state this table exists
      // to end.
      _db.exec(`
        CREATE TABLE IF NOT EXISTS awareness_receipts (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id   INTEGER,
          session_id   INTEGER,
          workspace_id TEXT,
          verb         TEXT    NOT NULL,
          -- Provenance: 'tc-cli' when the tc client identified itself,
          -- 'http' for any other GET (browser preview, health check). Without
          -- it, an operator opening the endpoint in a browser would fabricate
          -- the "this session became aware" fact the awareness view keys on.
          source       TEXT    NOT NULL DEFAULT 'http' CHECK (source IN ('tc-cli','http')),
          created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_awareness_receipts_project ON awareness_receipts(project_id);
        CREATE INDEX IF NOT EXISTS idx_awareness_receipts_session ON awareness_receipts(session_id);
      `);
      log.info('Migration v31→v32: awareness_receipts ledger added (ambient-awareness Chunk 02)');
    }

    if (currentVersion < 33) {
      // v32→v33: role column on awareness_receipts (#1141). The Project
      // Master joins the awareness system; its receipts attribute by role
      // because it has no project id and (when medusa is off) no workspace id.
      try {
        _db.exec('ALTER TABLE awareness_receipts ADD COLUMN role TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v32→v33: role column added to awareness_receipts (#1141)');
    }

    if (currentVersion < 34) {
      // v33→v34 (#1063): the outcome enum gains 'written'. The `rules-hook`
      // channel recorded 'delivered' the moment the shards hit disk — a fact
      // about the filesystem, not about any engine reading them — so the #759
      // outage, in which every Claude SessionStart hook failed and sessions
      // booted with no rules at all, produced a clean ledger across multiple
      // sessions and two projects for as long as it lasted. 'written' is the
      // honest write-time row; the hook upgrades it to 'delivered' when it
      // actually runs, so a hook that never runs leaves 'written' standing and
      // the outage becomes visible on every surface that reads the ledger.
      //
      // Existing 'delivered' rows on the rules-hook channel are NOT rewritten:
      // they attest what the writer of the day believed, and rewriting history
      // to match a new semantic is how an audit trail stops being evidence.
      // They age out under the existing retention cap.
      //
      // SQLite cannot alter a CHECK in place, so the table is rebuilt exactly
      // as v28→v29 and v30→v31 did.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(`
        CREATE TABLE session_rule_deliveries_v34 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped','unverified','written')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          confirmed_at TEXT,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome NOT IN ('delivered','unverified','written') OR channel != 'none'),
          CHECK (outcome NOT IN ('skipped','unverified')   OR skip_reason IS NOT NULL)
        );
        INSERT INTO session_rule_deliveries_v34
          SELECT id, session_id, project_id, engine_id, kind, channel, outcome,
                 skip_reason, rule_ids, rule_count, digest, NULL, created_at
          FROM session_rule_deliveries;
        DROP TABLE session_rule_deliveries;
        ALTER TABLE session_rule_deliveries_v34 RENAME TO session_rule_deliveries;
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);
        `);
        // Postcondition, same rationale and mechanism as the two rebuilds
        // above: PRAGMA table_info cannot surface CHECK clauses, so read the
        // DDL back and confirm the rebuilt table accepts the value the rebuild
        // exists to allow.
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_deliveries'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes('written')) {
          throw new Error(
            'v33→v34 rebuild did not widen the outcome CHECK — session_rule_deliveries '
            + 'still rejects written. Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v33→v34: written delivery outcome added (#1063)');
    }

    if (currentVersion < 35) {
      // v34→v35 (#1394): a lease records the reach its service INTENDS.
      //
      // A service that binds 127.0.0.1 is already stating that intent; nothing
      // wrote it down anywhere another process could read. The Caddyfile
      // divergence check needs exactly that fact to answer its fourth
      // property — a site fronting a port whose owner meant it to stay on
      // loopback is an exposure, and no amount of reading the Caddyfile alone
      // can tell the two apart.
      //
      // 'loopback' is the default because it is the weakest claim: a lease
      // that never said otherwise must not be read as permission to expose it.
      // Existing rows backfill to it for the same reason.
      //
      // Plain ADD COLUMN, not the rename-and-copy the CHECK-widening
      // migrations above needed: SQLite allows a CHECK on an added column, and
      // a constant NOT NULL default backfills every existing row in place.
      //
      // The ALTER is conditional because `_createTables` runs BEFORE migrations
      // and its CREATE TABLE IF NOT EXISTS already carries `reach`. An install
      // old enough to predate the port_leases table itself therefore arrives
      // here with the column already present, and an unconditional ALTER fails
      // the whole upgrade with "duplicate column name". The postcondition below
      // runs on BOTH paths, so the skip can never mean the constraint is
      // missing — which is the only reason skipping is safe.
      _db.exec('BEGIN IMMEDIATE');
      try {
        const hasReach = _db.prepare('PRAGMA table_info(port_leases)')
          .all().some((c) => c.name === 'reach');
        if (!hasReach) {
          _db.exec(
            "ALTER TABLE port_leases ADD COLUMN reach TEXT NOT NULL DEFAULT 'loopback' "
            + `CHECK(${REACH_CHECK_SQL})`
          );
        }
        // Postcondition, same rationale as the rebuilds above: PRAGMA
        // table_info cannot surface a CHECK clause, so read the DDL back and
        // confirm the constraint this migration exists to add is really there.
        // Without it a column added with no CHECK would accept any string and
        // the check would silently trust a value it cannot interpret.
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='port_leases'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes(REACH_CHECK_SQL)) {
          throw new Error(
            'v34→v35 did not add the reach CHECK to port_leases. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v34→v35: reach column added to port_leases (#1394)');
    }

    if (currentVersion < 36) {
      // v35→36 (#1417): the users table — TangleClaw's own front door (ADR 0015).
      //
      // Read this before assuming the CREATE below is what makes the table
      // appear: it is not, on any path. `_createTables` runs BEFORE migrations
      // and its DDL already carries this table, so by the time this block is
      // reached the table exists whether the install is fresh or upgrading.
      // That is exactly why a NEW table needs no ALTER-style migration at all
      // — unlike v34→35 above, which added a column to a table older installs
      // already had.
      //
      // So what this block is FOR is the postcondition, and its reach is
      // narrower than it looks: `_createTables` seeds schema_version at CURRENT
      // on a fresh DB, so this never runs on a new install, and it never runs
      // again once an install is at 36. It protects exactly one population —
      // installs still below v36, which is where an already-present users table
      // of the wrong shape can actually be found. A fresh install's DDL is
      // guarded instead by the duplicate-username test, which reds if the
      // CREATE ever loses its UNIQUE. The CREATE stays, idempotent, so the
      // block is still correct in isolation if `_createTables` ever stops
      // carrying it.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(
          'CREATE TABLE IF NOT EXISTS users ('
          + '  id            INTEGER PRIMARY KEY AUTOINCREMENT,'
          + '  username      TEXT NOT NULL UNIQUE,'
          + '  password_hash TEXT NOT NULL,'
          + "  created_at    TEXT NOT NULL DEFAULT (datetime('now')),"
          + '  disabled_at   TEXT'
          + ')'
        );
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
        ).get();
        // The UNIQUE on username is the part worth reading back. Without it two
        // rows can share a name and every lookup answers with whichever one
        // SQLite reaches first — on the login path that is an authentication
        // bug, not a data-tidiness one.
        //
        // Both spellings count. SQLite accepts the constraint on the column
        // (`username TEXT NOT NULL UNIQUE`) or on the table (`UNIQUE(username)`),
        // and a check that saw only the first would refuse a table that is
        // actually correct — failing safe, but failing a legitimate upgrade.
        const ddlSql = ddl && ddl.sql ? ddl.sql : '';
        const hasUnique = /username[^,]*UNIQUE/i.test(ddlSql)
          || /UNIQUE\s*\(\s*username\s*\)/i.test(ddlSql);
        if (!hasUnique) {
          throw new Error(
            'v35→36 did not create the users table with a UNIQUE username. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v35→36: users table added (#1417)');
    }

    if (currentVersion < 37) {
      // v36→37 (#1418): auth_sessions — logged-in browser sessions for
      // TangleClaw's own gate.
      //
      // Same shape and same reasoning as v35→36 above: `_createTables` runs
      // first and already carries this DDL, so on every path the table exists
      // before this block is reached, and a fresh install never enters here at
      // all (its schema_version is seeded at CURRENT). What this block is for is
      // the postcondition — and the population it protects is installs still
      // below v37, the only place a wrongly-shaped auth_sessions can be found.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(
          'CREATE TABLE IF NOT EXISTS auth_sessions ('
          + '  id         INTEGER PRIMARY KEY AUTOINCREMENT,'
          + '  token_hash TEXT NOT NULL UNIQUE,'
          + '  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,'
          + '  username   TEXT NOT NULL,'
          + '  csrf_token TEXT NOT NULL,'
          + "  created_at TEXT NOT NULL DEFAULT (datetime('now')),"
          + '  expires_at INTEGER NOT NULL'
          + ')'
        );
        _db.exec(
          'CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)'
        );
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='auth_sessions'"
        ).get();
        // The UNIQUE on token_hash is what is read back, for the same reason
        // v35→36 reads back the UNIQUE on username: without it two rows can
        // share a token and a lookup answers with whichever SQLite reaches
        // first. On the session path that is an authentication bug.
        //
        // Both spellings count — SQLite accepts the constraint on the column or
        // on the table — so a check that saw only one would refuse a table that
        // is in fact correct.
        const ddlSql = ddl && ddl.sql ? ddl.sql : '';
        const hasUnique = /token_hash[^,]*UNIQUE/i.test(ddlSql)
          || /UNIQUE\s*\(\s*token_hash\s*\)/i.test(ddlSql);
        if (!hasUnique) {
          throw new Error(
            'v36→37 did not create the auth_sessions table with a UNIQUE token_hash. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v36→37: auth_sessions table added (#1418)');
    }

    if (currentVersion < 38) {
      // v37→38 (#1420): recovery_codes. Same shape as v36→37: `_createTables`
      // already created it, so this block is the postcondition — refuse to
      // advance over a table whose code_hash is not UNIQUE, because a lookup
      // that can match two rows can consume the wrong account's code.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(
          'CREATE TABLE IF NOT EXISTS recovery_codes ('
          + '  id                INTEGER PRIMARY KEY AUTOINCREMENT,'
          + '  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,'
          + '  code_hash         TEXT NOT NULL UNIQUE,'
          + '  created_at        INTEGER NOT NULL,'
          + '  used_at           INTEGER,'
          + '  used_from         TEXT,'
          + '  notice_cleared_at INTEGER'
          + ')'
        );
        _db.exec('CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id)');
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='recovery_codes'"
        ).get();
        const ddlSql = ddl && ddl.sql ? ddl.sql : '';
        const hasUnique = /code_hash[^,]*UNIQUE/i.test(ddlSql)
          || /UNIQUE\s*\(\s*code_hash\s*\)/i.test(ddlSql);
        if (!hasUnique) {
          throw new Error(
            'v37→38 did not create the recovery_codes table with a UNIQUE code_hash. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v37→38: recovery_codes table added (#1420)');
    }

    if (currentVersion < 39) {
      // v38→39 (#1309, #1406): the launch baseline. A wrap needs to know where its
      // session started — the commit it measures "this session" from, and the files
      // that were already dirty and so belong to someone else. `_createTables` runs
      // first and already builds a fresh `sessions` at today's shape, so each column
      // is added only when table_info says it is missing; a try/catch around ALTER
      // would also swallow a real failure. Existing rows stay NULL: a session
      // launched before this has no baseline, and the wrap falls back for it.
      const have = new Set(_db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
      for (const col of ['launch_sha', 'launch_toplevel', 'launch_dirty']) {
        if (!have.has(col)) _db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
      }
      const after = new Set(_db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
      for (const col of ['launch_sha', 'launch_toplevel', 'launch_dirty']) {
        if (!after.has(col)) {
          throw new Error(`v38→39 did not add sessions.${col}. Refusing to advance schema_version.`);
        }
      }
      log.info('Migration v38→39: launch baseline columns added to sessions (#1309, #1406)');
    }

    if (currentVersion < 40) {
      // v39→40 (Train 21, #1579): the launch-sequence tables. `_createTables`
      // already built them, so this block is the postcondition, in the shape of
      // v36→37: refuse to advance over a launch_sequences table whose launch_id
      // is not UNIQUE, because the launch-id lookup must never answer with
      // another session's sequence.
      _db.exec('BEGIN IMMEDIATE');
      try {
        const ddlSql = (name) => {
          const row = _db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
          return row && row.sql ? row.sql : '';
        };
        const seqSql = ddlSql('launch_sequences');
        if (!/launch_id[^,]*UNIQUE/i.test(seqSql) && !/UNIQUE\s*\(\s*launch_id\s*\)/i.test(seqSql)) {
          throw new Error('v39→40 did not create launch_sequences with a UNIQUE launch_id. Refusing to advance schema_version.');
        }
        if (!/PRIMARY KEY\s*\(\s*sequence_id\s*,\s*revision\s*,\s*step_index\s*\)/i.test(ddlSql('launch_sequence_steps'))) {
          throw new Error('v39→40 did not create launch_sequence_steps keyed by (sequence_id, revision, step_index). Refusing to advance schema_version.');
        }
        const idx = _db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_launch_sequences_session'").get();
        if (!idx || !/UNIQUE/i.test(idx.sql || '')) {
          throw new Error('v39→40 did not create the unique session index on launch_sequences. Refusing to advance schema_version.');
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v39→40: launch sequence tables added (#1579)');
    }

    if (currentVersion < 41) {
      // v40→41 (Train 21, #1585): handoff_publications. `_createTables` already
      // built it, so this block is the postcondition, in the shape of v39→40:
      // refuse to advance over a table that cannot enforce attempt-exact
      // eligibility, because every guarantee the handoff makes rests on it.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _assertHandoffPublicationSchema('v40→41');
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v40→41: handoff publication table added (#1585)');
    }

    if (currentVersion < 42) {
      _migrateHandoffEpoch(currentVersion);
    }

    if (currentVersion < 43) {
      _migrateLaunchRecovery();
    }

    if (currentVersion < 44) {
      // v43→v44 (#1381): a lease records whether its owner is a TangleClaw
      // project at all. Same shape and reasoning as v34→v35: a plain ADD
      // COLUMN (SQLite allows a CHECK on an added column, and the constant
      // default backfills in place), conditional because `_createTables` has
      // already created a missing table at the current shape, and a
      // postcondition that runs on both paths so the skip can never mean the
      // constraint is absent. Existing rows become 'project', which is what
      // every reader assumed of them before the field existed.
      _db.exec('BEGIN IMMEDIATE');
      try {
        const hasOwnerKind = _db.prepare('PRAGMA table_info(port_leases)')
          .all().some((c) => c.name === 'owner_kind');
        if (!hasOwnerKind) {
          _db.exec(
            "ALTER TABLE port_leases ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'project' "
            + `CHECK(${OWNER_KIND_CHECK_SQL})`
          );
        }
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='port_leases'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes(OWNER_KIND_CHECK_SQL)) {
          throw new Error(
            'v43→v44 did not add the owner_kind CHECK to port_leases. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v43→v44: owner_kind column added to port_leases (#1381)');
    }

    if (currentVersion < 45) {
      _verifyStartupPromptTables();
      log.info('Migration v44→v45: startup prompt revisions and fires tables added (#1825)');
    }

    if (currentVersion < 46) {
      _migrateStartupControlV46();
      log.info('Migration v45→v46: fire receipts and the startupControl channels table (#1825 B2)');
    }

    if (currentVersion < 47) {
      _migrateStartupControlV47();
      log.info('Migration v46→v47: the automatic bootstrap\'s actor on fires and launch_sequences.startup_delivery (#1825 B3)');
    }

    if (currentVersion < 48) {
      _migrateControlStateV48();
      log.info('Migration v47→v48: durable HOLD/STOP control state (#1861)');
    }

    if (currentVersion < 49) {
      _migrateMedusaExchangesV49();
      log.info('Migration v48→v49: Medusa exchange state and facts for the delivery watchdog (#1839)');
    }

    if (currentVersion < 50) {
      _migrateWorkloadReceiptsV50();
      log.info('Migration v49→v50: launch-bound session workload receipts (#1912, ADR 0020)');
    }

    if (currentVersion < 51) {
      _migrateCoordinatorRotationsV51();
      log.info('Migration v50→v51: governed coordinator context rotations (#2032)');
    }

    if (currentVersion < 52) {
      _migrateOperatorBridgeV52();
      log.info('Migration v51→v52: Master-mediated operator bridge storage (#2031, ADR 0023)');
    }

    if (currentVersion < 53) {
      _migrateOperatorBridgeV53();
      log.info('Migration v52→v53: operator bridge route-status items and exact reply targets (#2031)');
    }

    if (currentVersion < 54) {
      _migrateOperatorBridgeV54();
      log.info('Migration v53→v54: operator bridge fetch leases and helper-token integrity (#2031)');
    }

    if (currentVersion < 55) {
      _migrateProjectRecoveryStateV55();
      log.info('Migration v54→v55: per-project recovery state, the recovery-mode decision and the inherited-notice marker (#1937)');
    }

    if (currentVersion < 56) {
      _migrateSessionRuleLifecycleV56();
      log.info('Migration v55→v56: session rules gain a retired state and replacement/supersession provenance (#1696, #1709)');
    }

    if (currentVersion < 57) {
      _migrateFireDispatchNote();
      log.info('Migration v56→v57: startup prompt fires gain a durable dispatch note (#2186)');
    }

    if (currentVersion < 58) {
      _migrateLaunchBlockerV58();
      log.info('Migration v57→v58: sessions.launch_blocker, the named reason a launch is not being typed into (#2128)');
    }

    if (currentVersion < 59) {
      _migrateLaunchRecoveryClearancesV59();
      log.info('Migration v58→v59: launch_recovery_clearances, the append-only record of each operator recovery clearance (#2049)');
    }

    if (currentVersion < 60) {
      _migrateLaunchRecoveryClearBatchesV60();
      log.info('Migration v59→v60: launch_recovery_clear_batches and their items, the append-only record of each batch recovery clear and every outcome in it (#2049)');
    }

    if (currentVersion < 61) {
      _migrateWorkloadNudgeFactsV61();
      log.info('Migration v60→v61: workload_nudge_facts, the append-only record of each nudge and escalation of a lane whose workload receipt expired (#2262)');
    }

    if (currentVersion < 62) {
      _migrateOperatorBridgeV62();
      log.info('Migration v61→v62: the operator bridge admits a fourth typed notification, lane-silent (#2262, ADR 0023)');
    }

    if (currentVersion < 63) {
      _migrateOperatorBridgeV63();
      log.info('Migration v62→v63: the operator bridge admits two typed notifications about the chat helper\'s own connection, gateway-down and gateway-recovered (#2272, ADR 0023)');
    }

    if (currentVersion < 64) {
      _migrateMergeQueueV64();
      log.info('Migration v63→v64: merge_queues, merge_queue_entries and merge_queue_events, the records of an Integrator-owned merge queue (#2322)');
    }

    if (currentVersion < 65) {
      _migrateCheckWatchV65();
      log.info('Migration v64→v65: check_watches and check_watch_facts, the records of a watch on a named check of an exact commit (#2323)');
    }

    if (currentVersion < 66) {
      _migrateLaunchIsolationOverridesV66();
      log.info('Migration v65→v66: launch_isolation_overrides, the operator\'s install-wide and per-project allowance to launch an engine that cannot be shown isolated (#2229)');
    }

    if (currentVersion < 67) {
      _migrateSharedDocEventsV67();
      log.info('Migration v66→v67: shared_doc_events and shared_doc_baselines, the record of every observed revision of a shared document and the baseline it is classified against (#2389)');
    }

    if (currentVersion < 68) {
      _migrateSharedDocNoticesV68();
      log.info('Migration v67→v68: shared_doc_notice_prefs and shared_doc_deliveries, each project\'s mute or subscribe setting and the outcome of every notice a revision intended (#2389)');
    }

    if (currentVersion < 69) {
      _migrateBridgeSurfaceKindV69();
      log.info('Migration v68→v69: the operator bridge admits a second pinned ingress surface; surface_kind on bridge_routes and bridge_outbound (#2433)');
    }

    if (currentVersion < 70) {
      _migrateBridgeCircuitSurfaceV70();
      log.info('Migration v69→v70: the configuration circuit opens per ingress surface, not globally, so a DM outage cannot block guild delivery (#2433)');
    }

    if (currentVersion < 71) {
      _migrateLaunchReadinessV71();
      log.info('Migration v70→v71: launch_reconciliations (post-READY additive reconciliation against live drift, #2191) and '
        + 'launch_readiness_receipts (idempotent durable READY receipt, #1877); last_unready_verdict/_at provisioned on '
        + 'launch_sequences for #1596 (Architect ruling A477-COSIGN-20261027T2307Z)');
    }

    if (currentVersion < 72) {
      // v71→v72: release_owner_project_id column added to project_groups — which
      // member project (if any) currently holds release authority for the group
      // (#1697). Nullable; null means no owner has claimed it yet. Mirrors the
      // v3→v4 shared_dir precedent: a plain nullable column add, no rebuild.
      try {
        _db.exec('ALTER TABLE project_groups ADD COLUMN release_owner_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL');
      } catch (err) {
        // Column may already exist if _createTables ran with the new schema
        // — but only that specific case is expected; any other DB error
        // (disk full, locked file, corruption) must not be swallowed as if
        // the migration had already run (PRR-A W2).
        if (!/duplicate column name/i.test(err.message || '')) throw err;
      }
      log.info('Migration v71→v72: release_owner_project_id column added to project_groups (#1697)');
    }

    if (currentVersion < 73) {
      // v72→v73: drop projects.migration_status (#776, Architect Ruling A485-776
      // as amended/A485-R3). 0 of 87 live projects carried a non-null value when
      // this was measured, and nothing persisted reads it back — but
      // POST /api/projects/:name/migrate-to-plugin stays fully live: its
      // `migrationStatus` response field is computed transiently in-memory by
      // migrateProjectToPlugin() on every call, never read from this column.
      _migrateDropProjectsMigrationStatus();
      log.info('Migration v72→v73: migration_status column dropped from projects (#776)');
    }

    if (currentVersion < 74) {
      // v73→v74: medusa_exchange_facts_append_only_delete admits deleting a
      // terminal or untracked exchange's facts, so retention
      // (lib/medusa-exchanges.js) can prune them (#1879, Architect Ruling
      // A485-1879). An open exchange's facts stay fully append-only.
      _migrateMedusaExchangeFactsRetentionTrigger();
      log.info('Migration v73→v74: medusa_exchange_facts deletable for terminal/untracked exchanges (#1879)');
    }

    if (currentVersion < 75) {
      // v74→v75: add usage_calibration table (CREATE IF NOT EXISTS in
      // _createTables handles the DDL) — a plain additive table, no change
      // to any existing one.
      log.info('Migration v74→v75: usage_calibration table added (#2599)');
    }

    if (currentVersion < 76) {
      // v75→v76: add usage_window_aggregates table (CREATE IF NOT EXISTS in
      // _createTables handles the DDL) — another plain additive table.
      log.info('Migration v75→v76: usage_window_aggregates table added (#2599)');
    }

    // The version stamp, once. `_migrateHandoffEpoch` writes its own 42 inside
    // the transaction that initializes the epoch rows, because the marker and
    // the rows have to land or not land together — so this asks what is already
    // recorded rather than stamping unconditionally, which would put a second
    // row down for a version already stamped. A migration that only adds columns
    // has no such pairing and leaves the stamp to this line.
    const stamped = _db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    if (!stamped || !(stamped.v >= CURRENT_SCHEMA_VERSION)) {
      _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    }
  }

  log.debug('Schema version', { version: CURRENT_SCHEMA_VERSION });
}

/**
 * Assert the handoff-publication table can still enforce attempt-exact
 * eligibility, and throw naming `label` if it cannot.
 *
 * Two migrations need this and neither may assume the other ran. v40→41 added
 * the table, so it checks what it just created; v41→42 depends on it but runs
 * on stores that entered ALREADY at 41 and therefore never passed through the
 * v40→41 gate at all. Sharing one function is what keeps the second check from
 * drifting into a weaker copy of the first — and it adds no new work to the old
 * gate, which runs exactly the assertions it always ran.
 *
 * @param {string} label - The migration saying so, for the error text
 * @returns {void}
 */
function _assertHandoffPublicationSchema(label) {
  const pubRow = _db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='handoff_publications'").get();
  const pubSql = (pubRow && pubRow.sql) || '';
  if (!pubSql) {
    throw new Error(`${label} did not create handoff_publications. Refusing to advance schema_version.`);
  }
  // A replayed stage within ONE run must collide rather than mint a second
  // publication for the same attempt.
  if (!/UNIQUE\s*\(\s*session_id\s*,\s*wrap_run_id\s*\)/i.test(pubSql)) {
    throw new Error(`${label} did not create handoff_publications with UNIQUE (session_id, wrap_run_id). Refusing to advance schema_version.`);
  }
  // seq orders attempts across the install; a duplicate would make
  // "no higher seq is published" unanswerable at finalize.
  if (!/seq[^,]*UNIQUE/i.test(pubSql)) {
    throw new Error(`${label} did not create handoff_publications with a UNIQUE seq. Refusing to advance schema_version.`);
  }
  const finalIdx = _db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_handoff_pub_final_eligible'").get();
  const finalSql = (finalIdx && finalIdx.sql) || '';
  if (!/UNIQUE/i.test(finalSql) || !/eligible_at IS NOT NULL/i.test(finalSql)) {
    throw new Error(`${label} did not create the partial unique index that keeps one eligible final per session. Refusing to advance schema_version.`);
  }
}

/**
 * Assert `project_handoff_epoch` carries the constraints the boundary rests on.
 *
 * The primary key is the load-bearing one: without it a project can hold two
 * boundaries, and "every session predates the epoch" has two answers. The CHECK
 * is read back because a baseline outside the vocabulary would be read by the
 * preflight as "not clean, not unclean" and fall out of both branches silently.
 *
 * @returns {void}
 */
function _assertHandoffEpochSchema() {
  const row = _db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_handoff_epoch'").get();
  const sql = (row && row.sql) || '';
  if (!sql) {
    throw new Error('v41→42 did not create project_handoff_epoch. Refusing to advance schema_version.');
  }
  // SQLite accepts the key on the column or on the table; a check that saw only
  // one spelling would refuse a table that is in fact correct.
  if (!/project_id[^,]*PRIMARY KEY/i.test(sql) && !/PRIMARY KEY\s*\(\s*project_id\s*\)/i.test(sql)) {
    throw new Error('v41→42 did not create project_handoff_epoch keyed by project_id. Refusing to advance schema_version.');
  }
  if (!/epoch_session_id[^,]*NOT NULL/i.test(sql)) {
    throw new Error('v41→42 did not create project_handoff_epoch with a NOT NULL epoch_session_id. Refusing to advance schema_version.');
  }
  if (!/recorded_at[^,]*NOT NULL/i.test(sql)) {
    throw new Error('v41→42 did not create project_handoff_epoch with a NOT NULL recorded_at. Refusing to advance schema_version.');
  }
  const check = /baseline\s+TEXT[^,]*CHECK\s*\(([^)]*)\)/i.exec(sql);
  const checkBody = check ? check[1] : '';
  for (const value of HANDOFF_BASELINE_VALUES) {
    if (!checkBody.includes(`'${value}'`)) {
      throw new Error(`v41→42 did not constrain project_handoff_epoch.baseline to include '${value}'. Refusing to advance schema_version.`);
    }
  }
}

/**
 * Assert one persisted epoch row is usable, and throw if it is not.
 *
 * A row that fails here is never quietly replaced. Replacing it would recompute
 * the boundary from today's sessions, which is the one thing the epoch exists to
 * prevent; refusing leaves the install visibly broken instead of silently
 * misclassified.
 *
 * @param {object} row - A `project_handoff_epoch` row, snake_case as stored
 * @returns {void}
 */
function _assertEpochRowValid(row) {
  const where = `project_handoff_epoch row for project ${row.project_id}`;
  if (!Number.isInteger(row.project_id)) {
    throw new Error(`Invalid ${where}: project_id is not an integer. Refusing to advance schema_version.`);
  }
  if (!Number.isInteger(row.epoch_session_id) || row.epoch_session_id < 0) {
    throw new Error(`Invalid ${where}: epoch_session_id is ${row.epoch_session_id}. Refusing to advance schema_version.`);
  }
  if (!HANDOFF_BASELINE_VALUES.includes(row.baseline)) {
    throw new Error(`Invalid ${where}: baseline is "${row.baseline}". Refusing to advance schema_version.`);
  }
  if (typeof row.recorded_at !== 'string' || row.recorded_at.length === 0) {
    throw new Error(`Invalid ${where}: recorded_at is empty. Refusing to advance schema_version.`);
  }
}

/**
 * Classify one project's handoff boundary, for a project that has none yet.
 *
 * @param {{id: number, path: string}} project - The project row
 * @param {boolean} boundaryIsReal - Whether THIS startup is the one crossing
 *   into handoff support. False for a store that was already at v41, where the
 *   instant handoffs began is simply not recorded anywhere.
 * @param {object} continuity - `lib/continuity`, passed in so the migration
 *   resolves it once rather than per project
 * @returns {{epochSessionId: number, baseline: string, baselineReason: string|null}}
 */
function _classifyHandoffBaseline(project, boundaryIsReal, continuity) {
  const history = _db.prepare(
    'SELECT COUNT(*) AS n, MAX(id) AS maxId FROM sessions WHERE project_id = ?'
  ).get(project.id);

  // No history: there is nothing to misclassify and nothing to be uncertain
  // about, on either entry version. Cutoff 0 means no session can ever be
  // "pre-epoch", which is what makes the legacy exception unreachable here.
  if (!history || history.n === 0) {
    return { epochSessionId: 0, baseline: HANDOFF_BASELINES.EMPTY, baselineReason: null };
  }

  const epochSessionId = history.maxId;

  // Already at v41: the cutoff below is TODAY's maximum, not the instant
  // handoffs began, and nothing on disk can recover that instant — session
  // timestamps, `schema_version.applied_at` and the absence of publication rows
  // are all consistent with several different boundaries. So it is recorded as
  // an observation and marked untrustworthy, which withholds the clean-legacy
  // exception without touching any other verdict.
  if (!boundaryIsReal) {
    return {
      epochSessionId,
      baseline: HANDOFF_BASELINES.UNCLEAN,
      baselineReason: EPOCH_UNKNOWN_FROM_V41
    };
  }

  const newest = _db.prepare(
    'SELECT status FROM sessions WHERE project_id = ? ORDER BY id DESC LIMIT 1'
  ).get(project.id);
  const indexPresent = Boolean(project.path)
    && fs.existsSync(continuity.indexPath(project.path));

  // Both conditions are named when they fail, because "unclean" on its own tells
  // an operator nothing about which half of the baseline was missing.
  const failures = [];
  if (!newest || newest.status !== SESSION_STATUS.WRAPPED) {
    failures.push(`newest pre-epoch session ended '${newest ? newest.status : 'unknown'}'`);
  }
  if (!indexPresent) failures.push('no continuity index on disk');

  if (failures.length > 0) {
    return {
      epochSessionId,
      baseline: HANDOFF_BASELINES.UNCLEAN,
      baselineReason: failures.join('; ')
    };
  }
  return { epochSessionId, baseline: HANDOFF_BASELINES.CLEAN, baselineReason: null };
}

/**
 * v41→42 (Train 21, #1586): record where handoffs began, per project.
 *
 * This is its own version rather than part of v40→41 because v41 has shipped.
 * The v40→41 gate runs only for `currentVersion < 41`, so initialization added
 * inside it would never reach a store that already took 41 — which is every
 * install that has run the shipped build. A new version fixes that reachability.
 * What it cannot do is reconstruct the boundary such a store never recorded;
 * `_classifyHandoffBaseline` handles that by recording uncertainty instead of
 * inventing a cutoff.
 *
 * **Everything here is one transaction, including the version stamp.** A store
 * that advertised 42 with the rows half-written would admit sessions against a
 * boundary that does not exist, and the launch path would read a missing row as
 * a project with no history. Rows, validation and marker land together or not at
 * all; on failure nothing is stamped and startup stops.
 *
 * `_createTables` runs before this and stamps a FRESH database at the current
 * version, so a new install never enters here. Its projects get their epoch from
 * `projects.create` instead, which is also the path every project created after
 * this migration takes.
 *
 * @param {number} currentVersion - The version the store entered this startup at
 * @returns {void}
 */
function _migrateHandoffEpoch(currentVersion) {
  const continuity = require('../continuity');
  const recordedAt = new Date().toISOString();
  // Below 41, THIS startup is the one crossing into handoff support, so the
  // maximum session id taken right now really is the boundary.
  const boundaryIsReal = currentVersion < 41;

  _db.exec('BEGIN IMMEDIATE');
  try {
    // The epoch draws a line in front of the publication table, so a store whose
    // publication schema cannot enforce attempt-exact eligibility has nothing
    // worth drawing a line in front of. A store that entered at 41 skipped the
    // gate that checked this, which is exactly why it is re-checked here.
    _assertHandoffPublicationSchema('v41→42');
    _assertHandoffEpochSchema();

    // A partial or retried upgrade may have left rows behind. They are preserved
    // exactly — cutoff, baseline and recorded_at — and validated rather than
    // recomputed.
    const existing = _db.prepare('SELECT * FROM project_handoff_epoch').all();
    for (const row of existing) _assertEpochRowValid(row);
    const haveEpoch = new Set(existing.map((r) => r.project_id));

    const insert = _db.prepare(
      'INSERT INTO project_handoff_epoch '
      + '(project_id, epoch_session_id, baseline, baseline_reason, recorded_at) VALUES (?, ?, ?, ?, ?)'
    );
    let initialized = 0;
    for (const project of _db.prepare('SELECT id, path FROM projects').all()) {
      if (haveEpoch.has(project.id)) continue;
      const boundary = _classifyHandoffBaseline(project, boundaryIsReal, continuity);
      insert.run(project.id, boundary.epochSessionId, boundary.baseline, boundary.baselineReason, recordedAt);
      initialized++;
    }

    // Coverage, read back from the database rather than counted in the loop: a
    // project the launch path finds without an epoch is the case this migration
    // exists to make impossible.
    const uncovered = _db.prepare(
      'SELECT COUNT(*) AS n FROM projects p '
      + 'WHERE NOT EXISTS (SELECT 1 FROM project_handoff_epoch e WHERE e.project_id = p.id)'
    ).get();
    if (uncovered.n > 0) {
      throw new Error(
        `v41→42 left ${uncovered.n} project(s) without a handoff epoch. Refusing to advance schema_version.`
      );
    }
    for (const row of _db.prepare('SELECT * FROM project_handoff_epoch').all()) _assertEpochRowValid(row);

    _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(42);
    _db.exec('COMMIT');
    log.info('Migration v41→42: handoff epoch recorded (#1586)', {
      initialized,
      preserved: existing.length,
      boundaryIsReal
    });
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
}

/**
 * The recovery columns a launch sequence must carry for the step-4 and READY
 * gates to have anything to read.
 *
 * Kept as data rather than written twice, because the fresh-database path
 * (`_createTables`) and the upgrade path below have to agree exactly: a store
 * created today and a store upgraded today differ in nothing a later reader can
 * see, and a column added to one and forgotten in the other is a difference no
 * test of either path alone can find.
 */
const LAUNCH_RECOVERY_COLUMNS = Object.freeze([
  ['recovery', "TEXT NOT NULL DEFAULT 'none' CHECK (recovery IN ('none','required','cleared'))"],
  // `operator` here is not the product's default recovery mode, which depends
  // on the login gate (`lib/recovery-default.js`). It answers a different
  // question: what mode did a launch run in when none was recorded. Every such
  // launch predates the column or the setting and ran operator-cleared. The
  // same holds for the column in the fresh-create DDL above.
  ['recovery_mode', "TEXT NOT NULL DEFAULT 'operator' CHECK (recovery_mode IN ('operator','advisory'))"],
  ['recovery_revision', 'INTEGER NOT NULL DEFAULT 1'],
  ['recovery_cleared_at', 'TEXT'],
  ['recovery_cleared_by', 'TEXT'],
  ['recovery_clearance',
    "TEXT CHECK (recovery_clearance IN ('operator-verified','open-install-unverified','agent-reconciled'))"]
]);

/**
 * The `startup_prompt_fires` DDL, for the boot-time create and for the v46
 * rebuild, so the two cannot drift. `payload` is the launch-start payload a
 * fire was bound to, WITHOUT the launch bearer; `payload_digest` is what the
 * engine echoes back as the receipt's binding.
 * @param {string} table - Table name to create.
 * @returns {string} A CREATE TABLE statement.
 */
function _startupPromptFiresDdl(table) {
  return `CREATE TABLE IF NOT EXISTS ${table} (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Transport idempotency: a repeat of the same key returns this row.
      idempotency_key    TEXT    NOT NULL UNIQUE,
      project_id         INTEGER NOT NULL,
      session_id         INTEGER NOT NULL,
      sequence_id        INTEGER NOT NULL,
      prompt_revision    INTEGER NOT NULL,
      prompt_text_digest TEXT    NOT NULL,
      policy_digest      TEXT    NOT NULL,
      caller_kind        TEXT    NOT NULL CHECK (caller_kind IN (${STARTUP_FIRE_CALLER_KINDS_SQL})),
      caller_clearance   TEXT    NOT NULL CHECK (caller_clearance IN (${STARTUP_FIRE_CLEARANCES_SQL})),
      caller_project_id  INTEGER,
      outcome            TEXT    NOT NULL CHECK (outcome IN (${STARTUP_FIRE_OUTCOMES_SQL})),
      reason_code        TEXT    CHECK (reason_code IS NULL OR reason_code IN (${STARTUP_FIRE_REASON_CODES_SQL})),
      reason             TEXT    CHECK (reason IS NULL OR length(reason) <= 500),
      payload            TEXT,
      payload_digest     TEXT,
      engine_thread_id   TEXT,
      engine_turn_id     TEXT,
      dispatched_at      TEXT,
      accepted_at        TEXT,
      settled_at         TEXT,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      dispatch_note      TEXT    CHECK (dispatch_note IS NULL OR length(dispatch_note) <= ${STARTUP_FIRE_DISPATCH_NOTE_MAX})
    );`;
}

/**
 * Longest `dispatch_note` a fire row stores. The note is what a fire was sent
 * DESPITE, said once at dispatch and kept for the row's life; it is not a
 * reason, which every transition rewrites. (Said here and not as a comment in
 * the DDL: SQLite keeps a table's CREATE text, comments included, and edits
 * that text on a later ALTER.)
 * @type {number}
 */
const STARTUP_FIRE_DISPATCH_NOTE_MAX = 500;

/**
 * Add `dispatch_note` to `startup_prompt_fires` (#2186).
 *
 * A fire can be sent although something a blocker would normally name is
 * missing: Codex's config holds no trust entry for the folder. That has to
 * stay readable on the row after the turn is accepted, applied or failed, and
 * `reason` cannot hold it, because every transition rewrites `reason`. So the
 * note gets its own nullable column, set once and never cleared.
 *
 * A column add, so existing rows read NULL and nothing is copied. A database
 * whose table was built from the current DDL already has the column, which is
 * why this asks before it adds.
 * @returns {void}
 */
function _migrateFireDispatchNote() {
  const have = new Set(_db.prepare('PRAGMA table_info(startup_prompt_fires)').all().map((c) => c.name));
  if (have.size === 0 || have.has('dispatch_note')) return;
  _db.exec('ALTER TABLE startup_prompt_fires ADD COLUMN dispatch_note TEXT '
    + `CHECK (dispatch_note IS NULL OR length(dispatch_note) <= ${STARTUP_FIRE_DISPATCH_NOTE_MAX})`);
}

/**
 * The indexes on `startup_prompt_fires`, shared by the boot-time create and
 * the v46 rebuild.
 * @returns {string} CREATE INDEX statements.
 */
function _startupPromptFiresIndexesSql() {
  return `CREATE INDEX IF NOT EXISTS idx_startup_prompt_fires_session ON startup_prompt_fires(session_id);
    -- At most one fire ACTIVE per launch, whatever revision it carries.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_startup_prompt_fires_active
      ON startup_prompt_fires(sequence_id) WHERE outcome IN (${STARTUP_FIRE_ACTIVE_SQL});
    -- A revision APPLIED to a launch is never injected into it again. Other
    -- outcomes (unsupported, failed, ...) do not hold this key: whether they
    -- may be retried is an explicit decision the dispatching adapter makes.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_startup_prompt_fires_applied
      ON startup_prompt_fires(sequence_id, prompt_revision) WHERE outcome = 'applied';`;
}

/** The columns v45 gave `startup_prompt_fires`, copied verbatim by the v46 rebuild. */
const _STARTUP_FIRES_V45_COLUMNS = 'id, idempotency_key, project_id, session_id, sequence_id, prompt_revision, '
  + 'prompt_text_digest, policy_digest, caller_kind, caller_clearance, caller_project_id, outcome, reason_code, reason, '
  + 'created_at, updated_at';

/**
 * The CREATE statement SQLite holds for a table or index, or '' when there is
 * none. The migrations and their postconditions read shapes from this rather
 * than from what they believe they wrote.
 * @param {string} name - Table or index name.
 * @returns {string}
 */
function _tableDdl(name) {
  const row = _db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
  return row && row.sql ? row.sql : '';
}

/**
 * DDL for the durable HOLD/STOP control state (#1861).
 *
 * Two mutable caches and two append-only logs. `control_assignments` and
 * `control_holds` are rewritten only inside the transaction that appends the
 * `control_events` row changing them, so replaying the events in `seq` order
 * rebuilds both. `control_events` is the state history and `control_receipts`
 * the delivery/acknowledgement history; triggers make both refuse UPDATE and
 * DELETE, because an audit row that can be edited after the fact audits
 * nothing. Receipts never move `state_generation`: delivery is a fact about a
 * state, not a change to it.
 *
 * Idempotent (`IF NOT EXISTS` throughout), so `_createTables` and the v48
 * migration share it.
 * @returns {string}
 */
function _controlTablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS control_assignments (
      assignment_id     TEXT    PRIMARY KEY,
      project_id        INTEGER NOT NULL,
      issue_ref         TEXT    CHECK (issue_ref IS NULL OR length(issue_ref) <= 64),
      authority_json    TEXT    NOT NULL CHECK (length(authority_json) <= 4096),
      bound_session_id  INTEGER,
      bound_launch_id   TEXT,
      state             TEXT    NOT NULL CHECK (state IN ('active','held','stopped','closed')),
      state_generation  INTEGER NOT NULL CHECK (state_generation >= 1),
      created_by_kind   TEXT    NOT NULL,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      stopped_at        TEXT,
      closed_at         TEXT,
      superseded_by     TEXT,
      CHECK ((state = 'closed') = (closed_at IS NOT NULL))
    );
    -- One open assignment per project: a stopped one stays open (it still
    -- governs) until an operator successor supersedes it.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_assignments_open
      ON control_assignments(project_id) WHERE closed_at IS NULL;

    CREATE TABLE IF NOT EXISTS control_holds (
      hold_id               TEXT    PRIMARY KEY,
      assignment_id         TEXT    NOT NULL,
      issuer_principal      TEXT    NOT NULL,
      opened_generation     INTEGER NOT NULL,
      released_generation   INTEGER,
      released_by_event_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_control_holds_assignment ON control_holds(assignment_id);

    CREATE TABLE IF NOT EXISTS control_events (
      seq                   INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id              TEXT    NOT NULL UNIQUE,
      assignment_id         TEXT    NOT NULL,
      kind                  TEXT    NOT NULL CHECK (kind IN ('create','hold','release','stop','close','rebind')),
      state_generation      INTEGER NOT NULL,
      issuer_principal      TEXT    NOT NULL,
      operator_proof        TEXT    CHECK (operator_proof IS NULL OR operator_proof IN ('verified-session','ambient-open')),
      reason_code           TEXT    NOT NULL CHECK (length(reason_code) <= 40),
      request_id            TEXT    NOT NULL CHECK (length(request_id) <= 128),
      expected_generation   INTEGER,
      target_hold_ids_json  TEXT    CHECK (target_hold_ids_json IS NULL OR length(target_hold_ids_json) <= 4096),
      created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (assignment_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_control_events_assignment ON control_events(assignment_id, seq);
    -- A create's request id has no assignment yet to scope it, so it is unique
    -- across creates: a replayed create returns the assignment it made.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_events_create_request
      ON control_events(request_id) WHERE kind = 'create';

    CREATE TABLE IF NOT EXISTS control_receipts (
      receipt_seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT    NOT NULL,
      fact             TEXT    NOT NULL CHECK (fact IN ('notify_pending','notify_attempted','observed','acknowledged','exchange_closed')),
      outcome_code     TEXT    CHECK (outcome_code IS NULL OR length(outcome_code) <= 40),
      actor_principal  TEXT,
      -- The Medusa message id of the notice a notify_attempted receipt sent,
      -- so the target marking that message handled can be recorded as the
      -- target having observed the state.
      notice_ref       TEXT    CHECK (notice_ref IS NULL OR length(notice_ref) <= 128),
      at               TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_control_receipts_event ON control_receipts(event_id, receipt_seq);
    CREATE INDEX IF NOT EXISTS idx_control_receipts_notice ON control_receipts(notice_ref) WHERE notice_ref IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS control_events_append_only_update
      BEFORE UPDATE ON control_events
      BEGIN SELECT RAISE(ABORT, 'control_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS control_events_append_only_delete
      BEFORE DELETE ON control_events
      BEGIN SELECT RAISE(ABORT, 'control_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS control_receipts_append_only_update
      BEFORE UPDATE ON control_receipts
      BEGIN SELECT RAISE(ABORT, 'control_receipts is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS control_receipts_append_only_delete
      BEFORE DELETE ON control_receipts
      BEGIN SELECT RAISE(ABORT, 'control_receipts is append-only'); END;
  `;
}

/**
 * v47→v48: add the control-state tables (#1861), then prove they carry the
 * constraints the control plane rests on before the version advances.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateControlStateV48() {
  _startupControlTransaction(() => _db.exec(_controlTablesDdl()));
  _verifyControlTablesV48();
}

/**
 * The v48 postcondition: all four tables, the one-open-per-project index, the
 * create idempotency index and the four append-only triggers exist.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyControlTablesV48() {
  const refuse = (what) => {
    throw new Error(`v47→v48 left ${what}. Refusing to advance schema_version.`);
  };
  for (const table of ['control_assignments', 'control_holds', 'control_events', 'control_receipts']) {
    if (!_tableDdl(table)) refuse(`no ${table} table`);
  }
  if (!/UNIQUE/i.test(_tableDdl('idx_control_assignments_open'))) refuse('no one-open-assignment-per-project index');
  if (!/UNIQUE/i.test(_tableDdl('idx_control_events_create_request'))) refuse('no create idempotency index');
  for (const trigger of [
    'control_events_append_only_update', 'control_events_append_only_delete',
    'control_receipts_append_only_update', 'control_receipts_append_only_delete'
  ]) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
}

/**
 * An operator's percentage calibration of usage-window headroom, one row per
 * provider (#2599): unlike a receipt, a calibration is replaced in place —
 * the newest number an operator gave is the only one that means anything, so
 * this is a plain mutable row, not an append-only ledger.
 * @returns {string} DDL
 */
function _usageCalibrationTableDdl() {
  return `
    CREATE TABLE IF NOT EXISTS usage_calibration (
      provider      TEXT    PRIMARY KEY CHECK (provider IN ('claude','codex')),
      weekly_pct    REAL    CHECK (weekly_pct IS NULL OR (weekly_pct >= 0 AND weekly_pct <= 100)),
      five_hour_pct REAL    CHECK (five_hour_pct IS NULL OR (five_hour_pct >= 0 AND five_hour_pct <= 100)),
      calibrated_at INTEGER NOT NULL
    );
  `;
}

/**
 * A cached snapshot of each (session, provider, model, window) aggregate
 * `getUsageWindows` last computed (#2599, schema v76): a plain upsert-on-
 * recompute cache, not a durable ledger — the source of truth is always
 * the transcript logs on disk, which this exists to spare a caller from
 * reparsing when it only needs the LAST computed numbers (e.g. a stored-
 * aggregates read fallback for when live parsing is unavailable or
 * undesired). Not provider-constrained the way `usage_calibration` is:
 * a provider this repo later adds transcript parsing for (Antigravity, at
 * the time this table was added) needs no schema change to be cached here.
 *
 * `session_id = ''` is the fleet-wide, per-model row (every session rolled
 * up together); a non-empty `session_id` is one session's own row for that
 * (provider, model, window) — both upserted by the same call. This table
 * has not shipped in any release yet (schema v76 is still unmerged on this
 * very PR), so its DDL is corrected in place rather than adding a v77
 * migration for a version nothing has ever run.
 * @returns {string} DDL
 */
function _usageWindowAggregatesTableDdl() {
  return `
    CREATE TABLE IF NOT EXISTS usage_window_aggregates (
      session_id            TEXT    NOT NULL DEFAULT '',
      provider              TEXT    NOT NULL,
      model                 TEXT    NOT NULL,
      window_kind           TEXT    NOT NULL CHECK (window_kind IN ('fiveHour','weekly','monthly','sprint')),
      input_tokens          INTEGER NOT NULL,
      output_tokens         INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      cache_read_tokens     INTEGER NOT NULL,
      total_tokens          INTEGER NOT NULL,
      window_start          TEXT    NOT NULL,
      window_end            TEXT    NOT NULL,
      computed_at           INTEGER NOT NULL,
      PRIMARY KEY (session_id, provider, model, window_kind)
    );
  `;
}

/**
 * The workload receipt table (#1912, ADR 0020): what a session asserts about
 * its own work, one append-only row per `tc workload set`. Every identity and
 * time column is stamped by the server from the verified launch; the caller
 * supplies only the asserted columns. `(launch_id, seq)` is unique so a
 * lane's receipts have one order that no concurrent write can duplicate.
 * Shared by fresh installs and the v50 migration so the two cannot drift.
 * @returns {string} DDL
 */
function _workloadTablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS workload_receipts (
      receipt_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL,
      session_id    INTEGER NOT NULL,
      launch_id     TEXT    NOT NULL CHECK (length(launch_id) <= 128),
      assignment_id TEXT    CHECK (assignment_id IS NULL OR length(assignment_id) <= 128),
      seq           INTEGER NOT NULL CHECK (seq >= 1),
      state         TEXT    NOT NULL CHECK (state IN ('working','waiting-external','blocked','complete')),
      clearance     TEXT    NOT NULL CHECK (clearance IN ('safe-to-clear','do-not-clear','unknown')),
      summary       TEXT    NOT NULL CHECK (length(summary) BETWEEN 1 AND 200),
      wait_kind     TEXT    CHECK (wait_kind IS NULL OR wait_kind IN ('ci','review','operator','peer','merge','other')),
      wait_detail   TEXT    CHECK (wait_detail IS NULL OR length(wait_detail) <= 200),
      refs_json     TEXT    NOT NULL CHECK (length(refs_json) <= 4096),
      branch        TEXT    CHECK (branch IS NULL OR length(branch) <= 255),
      head_sha      TEXT    CHECK (head_sha IS NULL OR length(head_sha) = 40),
      source        TEXT    NOT NULL CHECK (source IN ('tc-cli')),
      received_at   TEXT    NOT NULL,
      UNIQUE (launch_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_workload_receipts_session ON workload_receipts(session_id);

    CREATE TRIGGER IF NOT EXISTS workload_receipts_append_only_update
      BEFORE UPDATE ON workload_receipts
      BEGIN SELECT RAISE(ABORT, 'workload_receipts is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workload_receipts_append_only_delete
      BEFORE DELETE ON workload_receipts
      BEGIN SELECT RAISE(ABORT, 'workload_receipts is append-only'); END;

    -- Operator narrowings of a lane's composed verdict (ADR 0020 §7): only
    -- ever lower it. A row is either a narrowing or a clear; the newest row
    -- for a launch decides, and a new launch starts with none.
    CREATE TABLE IF NOT EXISTS workload_narrowings (
      narrowing_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id     INTEGER NOT NULL,
      session_id     INTEGER NOT NULL,
      launch_id      TEXT    NOT NULL CHECK (length(launch_id) <= 128),
      action         TEXT    NOT NULL CHECK (action IN ('narrow','clear')),
      cap_clearance  INTEGER NOT NULL DEFAULT 0 CHECK (cap_clearance IN (0,1)),
      force_unknown  INTEGER NOT NULL DEFAULT 0 CHECK (force_unknown IN (0,1)),
      reason         TEXT    NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
      operator_proof TEXT    NOT NULL CHECK (operator_proof IN ('verified-session','ambient-open')),
      created_at     TEXT    NOT NULL,
      CHECK (action = 'clear' OR cap_clearance = 1 OR force_unknown = 1)
    );
    CREATE INDEX IF NOT EXISTS idx_workload_narrowings_launch ON workload_narrowings(launch_id, narrowing_id);

    CREATE TRIGGER IF NOT EXISTS workload_narrowings_append_only_update
      BEFORE UPDATE ON workload_narrowings
      BEGIN SELECT RAISE(ABORT, 'workload_narrowings is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workload_narrowings_append_only_delete
      BEFORE DELETE ON workload_narrowings
      BEGIN SELECT RAISE(ABORT, 'workload_narrowings is append-only'); END;
  `;
}

/**
 * v49→v50: add the workload receipt table (#1912), then prove it carries the
 * uniqueness and append-only guarantees the composition rests on before the
 * version advances. Purely additive: a v49 server ignores the table.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateWorkloadReceiptsV50() {
  _startupControlTransaction(() => _db.exec(_workloadTablesDdl()));
  _verifyWorkloadReceiptsV50();
}

/**
 * The v50 postcondition: both tables, the receipts' `(launch_id, seq)`
 * uniqueness and every append-only trigger exist.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyWorkloadReceiptsV50() {
  const refuse = (what) => {
    throw new Error(`v49→v50 left ${what}. Refusing to advance schema_version.`);
  };
  const table = _db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workload_receipts'").get();
  if (!table) refuse('no workload_receipts table');
  if (!/UNIQUE\s*\(\s*launch_id\s*,\s*seq\s*\)/.test(table.sql)) refuse('workload_receipts without UNIQUE (launch_id, seq)');
  if (!_db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workload_narrowings'").get()) {
    refuse('no workload_narrowings table');
  }
  for (const trigger of ['workload_receipts_append_only_update', 'workload_receipts_append_only_delete',
    'workload_narrowings_append_only_update', 'workload_narrowings_append_only_delete']) {
    const row = _db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger);
    if (!row) refuse(`no ${trigger} trigger`);
  }
}

/**
 * The record of what the workload nudge monitor did about an expired receipt
 * (#2262): one row per fact, never changed afterwards.
 *
 * `activity_log` is pruned per event type, so it cannot be what stops a lane
 * being nudged twice for one expiry after a restart, and it cannot answer how
 * a stall was noticed for as long as the question can be asked.
 *
 * - `receipt_id` is the receipt that expired. One expiry is one receipt, so
 *   the receipt is what a fact is counted against.
 * - A fact is recorded once per `(receipt_id, kind, route)`. The unique index
 *   reads a missing route as `''` because SQLite treats two NULLs as different
 *   values, and a plain index would let a second `nudged` row in.
 * - `route` is NULL for `nudged`, which goes to the lane itself, and names
 *   where the message was bound for on `escalated` and
 *   `escalation-undeliverable`. `not-nudged` may carry either.
 * - `target_project_id` is the coordinator the escalation named, where it
 *   named one that exists. An operator-route fact has none, and neither has
 *   a fact with no route: that CHECK reads a missing route as `''`, because
 *   a comparison with NULL is NULL and SQLite fails a CHECK only on false.
 * - `code` is the monitor's verdict code. `engine_activity` and
 *   `engine_reason` are what the activity observer said at that moment.
 * - `detail_json` is bounded and holds no receipt summary and no nudge text.
 * - When a lane answered is not stored: it is the next receipt of that launch,
 *   which `workload_receipts` already holds.
 * - No foreign keys: a row must outlive the project, session and launch it
 *   names, and must never stand in the way of deleting one.
 *
 * Append-only by trigger, and nothing prunes these rows: retention needs its
 * own admitted policy. Idempotent (`IF NOT EXISTS` throughout), so
 * `_createTables` and the v61 migration share it.
 * @returns {string} DDL
 */
function _workloadNudgeFactsDdl() {
  return `
    CREATE TABLE IF NOT EXISTS workload_nudge_facts (
      fact_id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id        INTEGER NOT NULL,
      session_id        INTEGER NOT NULL,
      launch_id         TEXT    NOT NULL CHECK (length(launch_id) BETWEEN 1 AND 128),
      receipt_id        INTEGER NOT NULL,
      kind              TEXT    NOT NULL CHECK (kind IN (${WORKLOAD_NUDGE_FACT_KINDS_SQL})),
      route             TEXT    CHECK (route IS NULL OR route IN (${WORKLOAD_NUDGE_ROUTES_SQL})),
      target_project_id INTEGER,
      code              TEXT    NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
      engine_activity   TEXT    CHECK (engine_activity IS NULL OR length(engine_activity) <= 32),
      engine_reason     TEXT    CHECK (engine_reason IS NULL OR length(engine_reason) <= 64),
      detail_json       TEXT    CHECK (detail_json IS NULL OR length(detail_json) <= 2048),
      created_at        TEXT    NOT NULL,
      CHECK (kind <> 'nudged' OR route IS NULL),
      CHECK (kind NOT IN ('escalated','escalation-undeliverable') OR route IS NOT NULL),
      CHECK (target_project_id IS NULL OR COALESCE(route, '') = 'coordinator')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workload_nudge_facts_once
      ON workload_nudge_facts(receipt_id, kind, COALESCE(route, ''));
    CREATE INDEX IF NOT EXISTS idx_workload_nudge_facts_created
      ON workload_nudge_facts(created_at, fact_id);

    CREATE TRIGGER IF NOT EXISTS workload_nudge_facts_append_only_update
      BEFORE UPDATE ON workload_nudge_facts
      BEGIN SELECT RAISE(ABORT, 'workload_nudge_facts is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workload_nudge_facts_append_only_delete
      BEFORE DELETE ON workload_nudge_facts
      BEGIN SELECT RAISE(ABORT, 'workload_nudge_facts is append-only'); END;
  `;
}

/**
 * v60→v61: add the workload nudge record (#2262), then prove it can keep an
 * append-only record with one row per fact before the version advances. Purely
 * additive: an older server ignores the table.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateWorkloadNudgeFactsV61() {
  _startupControlTransaction(() => _db.exec(_workloadNudgeFactsDdl()));
  _verifyWorkloadNudgeFactsV61();
}

/**
 * The v61 postcondition: the table with every kind and route in its CHECKs,
 * the index that keeps a fact to one row and both append-only triggers exist.
 * Read from the stored DDL, because a table left behind by an interrupted or
 * hand-made attempt passes `IF NOT EXISTS` whatever its shape.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyWorkloadNudgeFactsV61() {
  const refuse = (what) => {
    throw new Error(`v60→v61 left ${what}. Refusing to advance schema_version.`);
  };
  const table = _tableDdl('workload_nudge_facts');
  if (!table) refuse('no workload_nudge_facts table');
  for (const word of [...WORKLOAD_NUDGE_FACT_KINDS, ...WORKLOAD_NUDGE_ROUTES]) {
    if (!table.includes(`'${word}'`)) refuse(`workload_nudge_facts without "${word}" in its CHECKs`);
  }
  if (!/CHECK\s*\(\s*target_project_id\s+IS\s+NULL\s+OR\s+COALESCE\s*\(\s*route\s*,\s*''\s*\)\s*=\s*'coordinator'\s*\)/i.test(table)) {
    refuse('workload_nudge_facts without the CHECK that only a coordinator-route fact names a coordinator');
  }
  const once = _tableDdl('idx_workload_nudge_facts_once');
  if (!/UNIQUE/i.test(once) || !/receipt_id\s*,\s*kind\s*,\s*COALESCE\s*\(\s*route\s*,\s*''\s*\)/i.test(once)) {
    refuse('no index keeping a fact to one row per receipt, kind and route');
  }
  for (const trigger of ['workload_nudge_facts_append_only_update', 'workload_nudge_facts_append_only_delete']) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
}

/**
 * The merge queue's records (#2322): which project owns a repository's queue,
 * what is in it and in what order, what each entry's gates said, what its
 * candidate was, what landed, and the ordered history of all of it.
 *
 * - `merge_queues`: one row per queue. A queue belongs to one repository and
 *   base branch and has one owner project. Only the Operator makes one, so
 *   `created_by_kind` admits nothing else and `created_by_proof` keeps how the
 *   Operator was known. At most one queue per repository and base is `active`:
 *   the partial unique index makes a second one impossible rather than
 *   refused by convention. A repository name compares without case, as GitHub
 *   compares it. `halted_at` set means the queue has stopped itself (a landed
 *   tree that is not the tested one) and nothing advances until the Operator
 *   clears it.
 * - `merge_queue_entries`: one row per submission of one pull request at one
 *   exact head commit. `position` is submission order and is never reused or
 *   renumbered, so a withdrawal leaves the others where they were. The three
 *   owner gates are the owner's statement, each with a reference; the Operator
 *   gate is `required` until the Operator records it. `head_check_*` is what
 *   the queue itself read of the head's check when the entry was submitted,
 *   kept apart from the owner's statement. `candidate_*` is the commit the
 *   queue made by merging the head into the base, and `landed_*` the merge
 *   that reached the base, with whether its tree was the candidate's.
 *   Two partial unique indexes carry the queue's two promises: one unfinished
 *   entry per pull request, and one entry at a time between assembling and
 *   landing.
 * - `merge_queue_events`: append-only by trigger. Every write to the two
 *   tables above appends one row in the same transaction, numbered per queue,
 *   so the events in `sequence` order are the whole history. `entry_id` is
 *   NULL for an event no entry caused; a halt names the entry whose landing
 *   caused it.
 *
 * States, statuses and event names come from `lib/merge-queue-state.js`, the
 * same lists the code checks against. No foreign keys: a history row must
 * outlive the project and launch it names. Idempotent (`IF NOT EXISTS`
 * throughout), so `_createTables` and the v64 migration share it.
 * @returns {string} DDL
 */
function _mergeQueueTablesDdl() {
  const sha = (col) => `(length(${col}) = 40 AND ${col} NOT GLOB '*[^0-9a-f]*')`;
  const optionalSha = (col) => `CHECK (${col} IS NULL OR ${sha(col)})`;
  const ownerGate = (name) => `
      ${name}_gate_status      TEXT    NOT NULL CHECK (${name}_gate_status IN (${_sqlList(mergeQueueState.OWNER_GATE_STATUSES)})),
      ${name}_gate_ref         TEXT    CHECK (${name}_gate_ref IS NULL OR length(${name}_gate_ref) BETWEEN 1 AND 300),
      ${name}_gate_recorded_at TEXT,`;
  return `
    CREATE TABLE IF NOT EXISTS merge_queues (
      queue_id          TEXT    PRIMARY KEY CHECK (length(queue_id) BETWEEN 1 AND 64),
      repo              TEXT    NOT NULL COLLATE NOCASE CHECK (length(repo) BETWEEN 3 AND 140),
      base_branch       TEXT    NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 255),
      owner_project_id  INTEGER NOT NULL,
      status            TEXT    NOT NULL CHECK (status IN (${_sqlList(mergeQueueState.QUEUE_STATUSES)})),
      created_by_kind   TEXT    NOT NULL CHECK (created_by_kind = 'operator'),
      created_by_proof  TEXT    NOT NULL CHECK (length(created_by_proof) BETWEEN 1 AND 64),
      created_at        TEXT    NOT NULL,
      retired_at        TEXT,
      halted_at         TEXT,
      halt_code         TEXT    CHECK (halt_code IS NULL OR length(halt_code) BETWEEN 1 AND 64),
      halt_detail       TEXT    CHECK (halt_detail IS NULL OR length(halt_detail) <= 1000),
      CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
      CHECK ((halted_at IS NULL) = (halt_code IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_queues_one_active
      ON merge_queues(repo, base_branch) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS merge_queue_entries (
      entry_id                 TEXT    PRIMARY KEY CHECK (length(entry_id) BETWEEN 1 AND 64),
      queue_id                 TEXT    NOT NULL,
      pr_number                INTEGER NOT NULL CHECK (pr_number > 0),
      head_sha                 TEXT    NOT NULL CHECK ${sha('head_sha')},
      position                 INTEGER NOT NULL CHECK (position >= 1),
      state                    TEXT    NOT NULL CHECK (state IN (${_sqlList(mergeQueueState.STATES)})),
      ${ownerGate('review')}
      ${ownerGate('test')}
      ${ownerGate('base')}
      operator_gate_status      TEXT    NOT NULL CHECK (operator_gate_status IN (${_sqlList(mergeQueueState.OPERATOR_GATE_STATUSES)})),
      operator_gate_ref         TEXT    CHECK (operator_gate_ref IS NULL OR length(operator_gate_ref) BETWEEN 1 AND 300),
      operator_gate_proof       TEXT    CHECK (operator_gate_proof IS NULL OR length(operator_gate_proof) BETWEEN 1 AND 64),
      operator_gate_recorded_at TEXT,
      head_check_run_id        TEXT    CHECK (head_check_run_id IS NULL OR length(head_check_run_id) BETWEEN 1 AND 64),
      head_check_conclusion    TEXT    CHECK (head_check_conclusion IS NULL OR length(head_check_conclusion) BETWEEN 1 AND 32),
      head_check_read_at       TEXT,
      submitted_by_project_id  INTEGER NOT NULL,
      submitted_by_launch_id   TEXT    NOT NULL CHECK (length(submitted_by_launch_id) BETWEEN 1 AND 128),
      candidate_ref            TEXT    CHECK (candidate_ref IS NULL OR length(candidate_ref) BETWEEN 1 AND 255),
      candidate_base_sha       TEXT    ${optionalSha('candidate_base_sha')},
      candidate_sha            TEXT    ${optionalSha('candidate_sha')},
      candidate_tree           TEXT    ${optionalSha('candidate_tree')},
      candidate_check_run_id   TEXT    CHECK (candidate_check_run_id IS NULL OR length(candidate_check_run_id) BETWEEN 1 AND 64),
      candidate_check_conclusion TEXT  CHECK (candidate_check_conclusion IS NULL OR length(candidate_check_conclusion) BETWEEN 1 AND 32),
      landed_sha               TEXT    ${optionalSha('landed_sha')},
      landed_tree              TEXT    ${optionalSha('landed_tree')},
      landed_tree_matches      INTEGER CHECK (landed_tree_matches IS NULL OR landed_tree_matches IN (0, 1)),
      landed_at                TEXT,
      failure_code             TEXT    CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64),
      failure_detail           TEXT    CHECK (failure_detail IS NULL OR length(failure_detail) <= 1000),
      withdrawn_reason         TEXT    CHECK (withdrawn_reason IS NULL OR length(withdrawn_reason) BETWEEN 1 AND 1000),
      created_at               TEXT    NOT NULL,
      updated_at               TEXT    NOT NULL,
      finished_at              TEXT,
      CHECK ((state IN (${_sqlList(mergeQueueState.FINISHED_STATES)})) = (finished_at IS NOT NULL)),
      CHECK ((state = 'landed') = (landed_sha IS NOT NULL)),
      CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
      CHECK ((state = 'withdrawn') = (withdrawn_reason IS NOT NULL)),
      CHECK (state NOT IN ('testing', 'landing', 'landed') OR (candidate_sha IS NOT NULL AND candidate_tree IS NOT NULL AND candidate_base_sha IS NOT NULL AND candidate_ref IS NOT NULL)),
      CHECK (landed_sha IS NULL OR (landed_tree IS NOT NULL AND landed_tree_matches IS NOT NULL AND landed_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_queue_entries_position
      ON merge_queue_entries(queue_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_queue_entries_one_per_pr
      ON merge_queue_entries(queue_id, pr_number)
      WHERE state NOT IN (${_sqlList(mergeQueueState.FINISHED_STATES)});
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_queue_entries_one_active
      ON merge_queue_entries(queue_id)
      WHERE state IN (${_sqlList(mergeQueueState.ACTIVE_STATES)});

    CREATE TABLE IF NOT EXISTS merge_queue_events (
      event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id          TEXT    NOT NULL,
      entry_id          TEXT,
      sequence          INTEGER NOT NULL CHECK (sequence >= 1),
      event             TEXT    NOT NULL CHECK (event IN (${_sqlList(mergeQueueState.EVENTS)})),
      from_state        TEXT    CHECK (from_state IS NULL OR from_state IN (${_sqlList(mergeQueueState.STATES)})),
      to_state          TEXT    CHECK (to_state IS NULL OR to_state IN (${_sqlList(mergeQueueState.STATES)})),
      actor_kind        TEXT    NOT NULL CHECK (actor_kind IN (${_sqlList(mergeQueueState.ACTOR_KINDS)})),
      actor_project_id  INTEGER,
      actor_launch_id   TEXT    CHECK (actor_launch_id IS NULL OR length(actor_launch_id) BETWEEN 1 AND 128),
      actor_proof       TEXT    CHECK (actor_proof IS NULL OR length(actor_proof) BETWEEN 1 AND 64),
      detail_json       TEXT    CHECK (detail_json IS NULL OR length(detail_json) <= 4096),
      created_at        TEXT    NOT NULL,
      CHECK ((actor_kind = 'project') = (actor_project_id IS NOT NULL)),
      CHECK ((actor_kind = 'project') = (actor_launch_id IS NOT NULL)),
      CHECK ((actor_kind = 'operator') = (actor_proof IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_queue_events_sequence
      ON merge_queue_events(queue_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_merge_queue_events_entry
      ON merge_queue_events(entry_id, sequence);

    CREATE TRIGGER IF NOT EXISTS merge_queue_events_append_only_update
      BEFORE UPDATE ON merge_queue_events
      BEGIN SELECT RAISE(ABORT, 'merge_queue_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS merge_queue_events_append_only_delete
      BEFORE DELETE ON merge_queue_events
      BEGIN SELECT RAISE(ABORT, 'merge_queue_events is append-only'); END;
  `;
}

/**
 * v63→v64: add the merge queue's tables (#2322), then prove they carry the
 * constraints the queue rests on before the version advances. Purely additive:
 * an older server ignores the tables.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateMergeQueueV64() {
  _startupControlTransaction(() => _db.exec(_mergeQueueTablesDdl()));
  _verifyMergeQueueV64();
}

/**
 * The v64 postcondition: the three tables with every state, status and event
 * in their CHECKs, the three indexes that make one active queue, one
 * unfinished entry per pull request and one active entry properties of the
 * database, and both append-only triggers. Read from the stored DDL, because a
 * table left behind by an interrupted or hand-made attempt passes
 * `IF NOT EXISTS` whatever its shape.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyMergeQueueV64() {
  const refuse = (what) => {
    throw new Error(`v63→v64 left ${what}. Refusing to advance schema_version.`);
  };
  const expected = {
    merge_queues: mergeQueueState.QUEUE_STATUSES,
    merge_queue_entries: [...mergeQueueState.STATES, ...mergeQueueState.OWNER_GATE_STATUSES, ...mergeQueueState.OPERATOR_GATE_STATUSES],
    merge_queue_events: [...mergeQueueState.EVENTS, ...mergeQueueState.ACTOR_KINDS]
  };
  for (const [name, words] of Object.entries(expected)) {
    const table = _tableDdl(name);
    if (!table) refuse(`no ${name} table`);
    for (const word of words) {
      if (!table.includes(`'${word}'`)) refuse(`${name} without "${word}" in its CHECKs`);
    }
  }
  const uniqueIndexes = {
    idx_merge_queues_one_active: /\(\s*repo\s*,\s*base_branch\s*\)\s*WHERE\s+status\s*=\s*'active'/i,
    idx_merge_queue_entries_one_per_pr: /\(\s*queue_id\s*,\s*pr_number\s*\)\s*WHERE\s+state\s+NOT\s+IN/i,
    idx_merge_queue_entries_one_active: /\(\s*queue_id\s*\)\s*WHERE\s+state\s+IN/i,
    idx_merge_queue_entries_position: /\(\s*queue_id\s*,\s*position\s*\)/i,
    idx_merge_queue_events_sequence: /\(\s*queue_id\s*,\s*sequence\s*\)/i
  };
  for (const [name, shape] of Object.entries(uniqueIndexes)) {
    const index = _tableDdl(name);
    if (!/UNIQUE/i.test(index) || !shape.test(index)) refuse(`no ${name} unique index of the expected shape`);
  }
  for (const trigger of ['merge_queue_events_append_only_update', 'merge_queue_events_append_only_delete']) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
}

/**
 * The check watch's records (#2323): which session asked to be told when a
 * named check finishes on an exact commit, what the server read of that check,
 * and what it sent because of it.
 *
 * - `check_watches`: one row per watch. `watch_id` is random text and is never
 *   reused, because each of a watch's two messages is sent under a request id
 *   made from it, and a reused id would be taken for a message already sent.
 *   `registered_*` is who asked; the wake goes to whichever session of
 *   `project_id` is live when the result lands, so it is not the recipient.
 *   The four `result_*` columns are written together, once, from a terminal
 *   conclusion read from GitHub, and are NULL until then. `last_read_*` is the
 *   newest read only: when it was and whether GitHub could be read. The three
 *   `cancelled_*` columns are written together. `expired_at` set means the
 *   watch ended by itself, unresolved, and is not read again; a watch with a
 *   result never expires. A watch is open while it has no result, is not
 *   cancelled and has not expired, and the partial unique index allows one
 *   open watch per project, repository, commit and check name: a check that
 *   was re-run can be watched again once its first result is recorded, and a
 *   check whose watch expired can be watched afresh. A repository name
 *   compares without case, as GitHub compares it.
 * - `check_watch_facts`: append-only by trigger. Every write to a watch
 *   appends one row in the same transaction, so the facts in `fact_id` order
 *   are the watch's whole history. The partial unique index makes the
 *   once-only kinds once-only in the database: a result is recorded once, and
 *   a wake or an alarm is recorded as sent once, whatever code writes. A
 *   `woke` or `alarmed` fact names the request id the message was sent under,
 *   the switchboard exchange that carries its delivery receipt, and the
 *   workspace it went to; no other kind names an exchange.
 *
 * Fact kinds and read outcomes come from `lib/check-watch-state.js`, the same
 * lists the code checks against. No foreign keys: a history row must outlive
 * the project and launch it names. Idempotent (`IF NOT EXISTS` throughout), so
 * `_createTables` and the v65 migration share it.
 * @returns {string} DDL
 */
function _checkWatchTablesDdl() {
  const sent = _sqlList(checkWatchState.SENT_KINDS);
  return `
    CREATE TABLE IF NOT EXISTS check_watches (
      watch_id                 TEXT    PRIMARY KEY CHECK (length(watch_id) BETWEEN 1 AND 64),
      project_id               INTEGER NOT NULL,
      registered_session_id    INTEGER,
      registered_launch_id     TEXT    NOT NULL CHECK (length(registered_launch_id) BETWEEN 1 AND 128),
      repo                     TEXT    NOT NULL COLLATE NOCASE CHECK (length(repo) BETWEEN 3 AND 140),
      pr_number                INTEGER NOT NULL CHECK (pr_number > 0),
      head_sha                 TEXT    NOT NULL CHECK (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*'),
      check_name               TEXT    NOT NULL CHECK (length(check_name) BETWEEN 1 AND ${checkWatchState.MAX_CHECK_NAME}),
      due_at                   TEXT    NOT NULL,
      registered_at            TEXT    NOT NULL,
      result_conclusion        TEXT    CHECK (result_conclusion IS NULL OR length(result_conclusion) BETWEEN 1 AND 32),
      result_run_id            TEXT    CHECK (result_run_id IS NULL OR length(result_run_id) BETWEEN 1 AND 64),
      result_completed_at      TEXT,
      result_read_at           TEXT,
      last_read_at             TEXT,
      last_read_outcome        TEXT    CHECK (last_read_outcome IS NULL OR last_read_outcome IN (${_sqlList(checkWatchState.READ_OUTCOMES)})),
      last_read_detail         TEXT    CHECK (last_read_detail IS NULL OR length(last_read_detail) <= 500),
      cancelled_at             TEXT,
      cancelled_by_project_id  INTEGER,
      cancelled_by_launch_id   TEXT    CHECK (cancelled_by_launch_id IS NULL OR length(cancelled_by_launch_id) BETWEEN 1 AND 128),
      expired_at               TEXT,
      CHECK ((result_conclusion IS NULL) = (result_read_at IS NULL)),
      CHECK ((result_run_id IS NULL) = (result_read_at IS NULL)),
      CHECK ((result_completed_at IS NULL) = (result_read_at IS NULL)),
      CHECK ((last_read_at IS NULL) = (last_read_outcome IS NULL)),
      CHECK (last_read_detail IS NULL OR COALESCE(last_read_outcome, '') = 'failed'),
      CHECK ((cancelled_by_project_id IS NULL) = (cancelled_at IS NULL)),
      CHECK ((cancelled_by_launch_id IS NULL) = (cancelled_at IS NULL)),
      CHECK (expired_at IS NULL OR result_read_at IS NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_check_watches_one_open
      ON check_watches(project_id, repo, head_sha, check_name)
      WHERE result_read_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_check_watches_project
      ON check_watches(project_id, registered_at);

    CREATE TABLE IF NOT EXISTS check_watch_facts (
      fact_id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id                TEXT    NOT NULL,
      kind                    TEXT    NOT NULL CHECK (kind IN (${_sqlList(checkWatchState.FACT_KINDS)})),
      code                    TEXT    CHECK (code IS NULL OR length(code) BETWEEN 1 AND 64),
      request_id              TEXT    CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
      exchange_id             TEXT    CHECK (exchange_id IS NULL OR length(exchange_id) BETWEEN 1 AND 64),
      recipient_workspace_id  TEXT    CHECK (recipient_workspace_id IS NULL OR length(recipient_workspace_id) BETWEEN 1 AND 128),
      detail_json             TEXT    CHECK (detail_json IS NULL OR length(detail_json) <= 4096),
      created_at              TEXT    NOT NULL,
      CHECK ((kind IN (${sent})) = (exchange_id IS NOT NULL)),
      CHECK ((kind IN (${sent})) = (request_id IS NOT NULL)),
      CHECK (kind NOT IN (${sent}) OR recipient_workspace_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_check_watch_facts_once
      ON check_watch_facts(watch_id, kind)
      WHERE kind IN (${_sqlList(checkWatchState.ONCE_ONLY_KINDS)});
    CREATE INDEX IF NOT EXISTS idx_check_watch_facts_watch
      ON check_watch_facts(watch_id, fact_id);

    CREATE TRIGGER IF NOT EXISTS check_watch_facts_append_only_update
      BEFORE UPDATE ON check_watch_facts
      BEGIN SELECT RAISE(ABORT, 'check_watch_facts is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS check_watch_facts_append_only_delete
      BEFORE DELETE ON check_watch_facts
      BEGIN SELECT RAISE(ABORT, 'check_watch_facts is append-only'); END;
  `;
}

/**
 * v64→v65: add the check watch's tables (#2323), then prove they carry the
 * constraints a watch rests on before the version advances. Purely additive:
 * an older server ignores the tables.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateCheckWatchV65() {
  _startupControlTransaction(() => _db.exec(_checkWatchTablesDdl()));
  _verifyCheckWatchV65();
}

/**
 * The v65 postcondition: both tables with every fact kind and read outcome in
 * their CHECKs, the two indexes that make one open watch and the once-only
 * facts properties of the database, and both append-only triggers. Read from
 * the stored DDL, because a table left behind by an interrupted or hand-made
 * attempt passes `IF NOT EXISTS` whatever its shape.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyCheckWatchV65() {
  const refuse = (what) => {
    throw new Error(`v64→v65 left ${what}. Refusing to advance schema_version.`);
  };
  const expected = {
    check_watches: checkWatchState.READ_OUTCOMES,
    check_watch_facts: checkWatchState.FACT_KINDS
  };
  for (const [name, words] of Object.entries(expected)) {
    const table = _tableDdl(name);
    if (!table) refuse(`no ${name} table`);
    for (const word of words) {
      if (!table.includes(`'${word}'`)) refuse(`${name} without "${word}" in its CHECKs`);
    }
  }
  const uniqueIndexes = {
    idx_check_watches_one_open: /\(\s*project_id\s*,\s*repo\s*,\s*head_sha\s*,\s*check_name\s*\)\s*WHERE\s+result_read_at\s+IS\s+NULL\s+AND\s+cancelled_at\s+IS\s+NULL\s+AND\s+expired_at\s+IS\s+NULL/i,
    idx_check_watch_facts_once: /\(\s*watch_id\s*,\s*kind\s*\)\s*WHERE\s+kind\s+IN/i
  };
  for (const [name, shape] of Object.entries(uniqueIndexes)) {
    const index = _tableDdl(name);
    if (!/UNIQUE/i.test(index) || !shape.test(index)) refuse(`no ${name} unique index of the expected shape`);
  }
  const once = _tableDdl('idx_check_watch_facts_once');
  for (const kind of checkWatchState.ONCE_ONLY_KINDS) {
    if (!once.includes(`'${kind}'`)) refuse(`idx_check_watch_facts_once without "${kind}"`);
  }
  for (const trigger of ['check_watch_facts_append_only_update', 'check_watch_facts_append_only_delete']) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
}

/**
 * DDL for the operator's launch-isolation overrides (#2229): the allowance to
 * start an engine that could not be shown to be kept off its shared background
 * process. A row is an override that is on; no row is off, which is the
 * default.
 *
 * `scope` is `install` for the one install-wide override and `project` for a
 * project's. The install row has no project, and SQLite counts NULLs as
 * distinct in a UNIQUE constraint, so "exactly one install row" is its own
 * partial unique index on the non-null `scope`, not a property of
 * `project_id`. `set_by` is the operator's account name, and NULL on an
 * install with no login gate, where the operator has no name.
 *
 * No foreign key: deleting a project removes its row explicitly, in
 * `projects.delete`. Idempotent (`IF NOT EXISTS` throughout), so
 * `_createTables` and the v66 migration share it.
 * @returns {string} DDL
 */
function _launchIsolationOverridesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS launch_isolation_overrides (
      override_id  INTEGER PRIMARY KEY AUTOINCREMENT,
      scope        TEXT    NOT NULL CHECK (scope IN (${_sqlList(LAUNCH_ISOLATION_OVERRIDE_SCOPES)})),
      project_id   INTEGER CHECK (project_id IS NULL OR project_id > 0),
      set_at       TEXT    NOT NULL CHECK (length(set_at) BETWEEN 1 AND 64),
      set_by       TEXT    CHECK (set_by IS NULL OR length(set_by) BETWEEN 1 AND 128),
      CHECK ((scope = 'install') = (project_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_isolation_overrides_install
      ON launch_isolation_overrides(scope)
      WHERE scope = 'install';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_isolation_overrides_project
      ON launch_isolation_overrides(project_id)
      WHERE scope = 'project';
  `;
}

/**
 * v65→v66: add the launch-isolation overrides' table (#2229), then prove it
 * carries the constraints the override rests on before the version advances.
 * Purely additive: an older server ignores the table, so every override stops
 * applying and a launch is refused as it was before.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateLaunchIsolationOverridesV66() {
  _startupControlTransaction(() => _db.exec(_launchIsolationOverridesDdl()));
  _verifyLaunchIsolationOverridesV66();
}

/**
 * The v66 postcondition: the table with both scopes in its CHECK, the CHECK
 * that ties the install scope to having no project, the CHECK that a project
 * id is positive, and the two unique
 * indexes that make one install row and one row per project properties of the
 * database. Read from the stored DDL, because a table left behind by an
 * interrupted or hand-made attempt passes `IF NOT EXISTS` whatever its shape.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyLaunchIsolationOverridesV66() {
  const refuse = (what) => {
    throw new Error(`v65→v66 left ${what}. Refusing to advance schema_version.`);
  };
  const table = _tableDdl('launch_isolation_overrides');
  if (!table) refuse('no launch_isolation_overrides table');
  for (const scope of LAUNCH_ISOLATION_OVERRIDE_SCOPES) {
    if (!table.includes(`'${scope}'`)) refuse(`launch_isolation_overrides without "${scope}" in its CHECKs`);
  }
  if (!/\(\s*scope\s*=\s*'install'\s*\)\s*=\s*\(\s*project_id\s+IS\s+NULL\s*\)/i.test(table)) {
    refuse('launch_isolation_overrides without the CHECK that an install row has no project');
  }
  if (!/project_id\s+IS\s+NULL\s+OR\s+project_id\s*>\s*0/i.test(table)) {
    refuse('launch_isolation_overrides without the CHECK that a project id is positive');
  }
  const uniqueIndexes = {
    idx_launch_isolation_overrides_install: /\(\s*scope\s*\)\s*WHERE\s+scope\s*=\s*'install'/i,
    idx_launch_isolation_overrides_project: /\(\s*project_id\s*\)\s*WHERE\s+scope\s*=\s*'project'/i
  };
  for (const [name, shape] of Object.entries(uniqueIndexes)) {
    const index = _tableDdl(name);
    if (!/UNIQUE/i.test(index) || !shape.test(index)) refuse(`no ${name} unique index of the expected shape`);
  }
}

/**
 * Where a shared-doc revision was observed from (#2389): the file watcher, the
 * notify route, an attestation, or a writer's base capture before an edit.
 * @type {string[]}
 */
const SHARED_DOC_EVENT_SOURCES = Object.freeze(['watch', 'notify', 'attest', 'base']);

/**
 * Who a shared-doc revision is attributed to. `attested` is authenticated
 * attestation by a lock-holding session in a cooperative-writer model, not
 * forensic proof of who wrote the bytes; everything else is `unknown`.
 * @type {string[]}
 */
const SHARED_DOC_AUTHOR_SOURCES = Object.freeze(['attested', 'unknown']);

/**
 * Delivery routing state of a revision: `none` (nobody was intended),
 * `pending` (recipients persisted, sends under way), `done`, or `interrupted`
 * (the server stopped while it was `pending`; never resent).
 * @type {string[]}
 */
const SHARED_DOC_ROUTING_STATES = Object.freeze(['none', 'pending', 'done', 'interrupted']);

/**
 * DDL for the shared-document revision record (#2389): one row per observed
 * distinct content digest of a doc, and one baseline row per doc holding the
 * latest observed content so a change is classified across a restart.
 *
 * Both reference `shared_documents` with `ON DELETE CASCADE`: unregistering a
 * doc removes its record and baseline with it. Idempotent (`IF NOT EXISTS`
 * throughout), so `_createTables` and the v67 migration share it.
 * @returns {string} DDL
 */
function _sharedDocEventsDdl() {
  return `
    CREATE TABLE IF NOT EXISTS shared_doc_events (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id                 TEXT    NOT NULL REFERENCES shared_documents(id) ON DELETE CASCADE,
      seq                    INTEGER NOT NULL CHECK (seq > 0),
      observed_at            TEXT    NOT NULL,
      sha256                 TEXT    NOT NULL CHECK (length(sha256) = 64),
      prior_sha256           TEXT    CHECK (prior_sha256 IS NULL OR length(prior_sha256) = 64),
      author_project_id      INTEGER,
      author_session_id      INTEGER,
      author_source          TEXT    NOT NULL DEFAULT 'unknown' CHECK (author_source IN (${_sqlList(SHARED_DOC_AUTHOR_SOURCES)})),
      attested_at            TEXT,
      lock_holder_hint       TEXT,
      classes                TEXT    NOT NULL,
      attribution            TEXT    NOT NULL CHECK (attribution IN ('complete','incomplete')),
      baseline               TEXT    NOT NULL CHECK (baseline IN ('full','digest-only')),
      changed_project_ids    TEXT    NOT NULL,
      changed_row_count      INTEGER NOT NULL DEFAULT 0,
      excerpt                TEXT,
      excerpt_truncated      INTEGER NOT NULL DEFAULT 0,
      source                 TEXT    NOT NULL CHECK (source IN (${_sqlList(SHARED_DOC_EVENT_SOURCES)})),
      routing                TEXT    NOT NULL DEFAULT 'none' CHECK (routing IN (${_sqlList(SHARED_DOC_ROUTING_STATES)})),
      duplicate_observations INTEGER NOT NULL DEFAULT 0,
      shadow_would_select    TEXT    NOT NULL DEFAULT '[]',
      CHECK ((author_source = 'attested') = (author_project_id IS NOT NULL AND author_session_id IS NOT NULL AND attested_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_doc_events_doc_seq ON shared_doc_events(doc_id, seq);

    CREATE TABLE IF NOT EXISTS shared_doc_baselines (
      doc_id       TEXT    PRIMARY KEY REFERENCES shared_documents(id) ON DELETE CASCADE,
      sha256       TEXT    NOT NULL CHECK (length(sha256) = 64),
      content      TEXT,
      byte_length  INTEGER NOT NULL CHECK (byte_length >= 0),
      complete     INTEGER NOT NULL CHECK (complete IN (0, 1)),
      observed_at  TEXT    NOT NULL,
      last_seq     INTEGER NOT NULL CHECK (last_seq > 0),
      CHECK ((complete = 1) = (content IS NOT NULL))
    );
  `;
}

/**
 * v66→v67: add the shared-document revision record and baselines (#2389),
 * then prove their shape before the version advances. Purely additive: an
 * older server ignores both tables and broadcasts as it always did.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateSharedDocEventsV67() {
  _startupControlTransaction(() => _db.exec(_sharedDocEventsDdl()));
  _verifySharedDocEventsV67();
}

/**
 * The v67 postcondition: both tables cascade from `shared_documents`, the
 * author CHECK ties `attested` to a project, a session and a time, every
 * source and routing value is in its CHECK, and (doc, seq) is unique. Read
 * from the stored DDL, because a table left by an interrupted or hand-made
 * attempt passes `IF NOT EXISTS` whatever its shape.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifySharedDocEventsV67() {
  const refuse = (what) => {
    throw new Error(`v66→v67 left ${what}. Refusing to advance schema_version.`);
  };
  const events = _tableDdl('shared_doc_events');
  if (!events) refuse('no shared_doc_events table');
  const baselines = _tableDdl('shared_doc_baselines');
  if (!baselines) refuse('no shared_doc_baselines table');
  const cascades = /REFERENCES\s+shared_documents\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i;
  if (!cascades.test(events)) refuse('shared_doc_events without ON DELETE CASCADE from shared_documents');
  if (!cascades.test(baselines)) refuse('shared_doc_baselines without ON DELETE CASCADE from shared_documents');
  for (const value of [...SHARED_DOC_EVENT_SOURCES, ...SHARED_DOC_ROUTING_STATES, ...SHARED_DOC_AUTHOR_SOURCES]) {
    if (!events.includes(`'${value}'`)) refuse(`shared_doc_events without "${value}" in its CHECKs`);
  }
  if (!/author_session_id\s+IS\s+NOT\s+NULL/i.test(events)) {
    refuse('shared_doc_events without the CHECK that an attested revision names its session');
  }
  if (!/last_seq\s+INTEGER\s+NOT\s+NULL/i.test(baselines)) refuse('shared_doc_baselines without its last_seq');
  const index = _tableDdl('idx_shared_doc_events_doc_seq');
  if (!/UNIQUE/i.test(index) || !/\(\s*doc_id\s*,\s*seq\s*\)/i.test(index)) {
    refuse('no idx_shared_doc_events_doc_seq unique index on (doc_id, seq)');
  }
}

/**
 * A project's notice setting for a shared doc or a whole group (#2389). No
 * row is the default: told only as the delivery rule selects.
 * @type {string[]}
 */
const SHARED_DOC_NOTICE_SETTINGS = Object.freeze(['mute', 'subscribe']);

/**
 * Why a project was intended for a revision's notice: it owns a changed row
 * (`owner`), or it subscribed (`subscriber`).
 * @type {string[]}
 */
const SHARED_DOC_DELIVERY_REASONS = Object.freeze(['owner', 'subscriber']);

/**
 * What happened to one intended notice. `pending` is persisted before the
 * send and replaced by its outcome; `unknown` is a `pending` the server
 * stopped on, which is never resent because a partial send cannot be told
 * apart from none. `muted` is the project's own setting, at resolution or at
 * dispatch. `withdrawn` is an intent the dispatch-time check found no longer
 * holds, for exactly three reasons: the project is no longer a member of the
 * doc's group, a `subscriber` intent's project no longer subscribes, or the doc
 * was re-registered (its path or group changed). A deleted doc or revision
 * takes its intents with it (cascade), so nothing of it is sent and no row is
 * left to mark. None of these is a
 * wake: a wake is the wake monitor's, recorded in `medusa_deliveries`.
 * @type {string[]}
 */
const SHARED_DOC_DELIVERY_OUTCOMES = Object.freeze(['pending', 'sent', 'coalesced', 'offline', 'failed', 'muted', 'withdrawn', 'unknown']);

/**
 * DDL for shared-doc notice settings and deliveries (#2389).
 *
 * A setting is scoped to exactly one of a doc or a group; a doc-scope setting
 * overrides a group-scope one. Settings cascade from the project, the group
 * and the doc. A delivery row is one intended (revision, project, session):
 * `session_id` is 0 for a row about the project as a whole (`muted`, or
 * `offline` when it had no live session), so the uniqueness holds without
 * NULLs. Deliveries cascade from their revision. Idempotent, so
 * `_createTables` and the v68 migration share it.
 * @returns {string} DDL
 */
function _sharedDocNoticeDdl() {
  return `
    CREATE TABLE IF NOT EXISTS shared_doc_notice_prefs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      group_id    TEXT    REFERENCES project_groups(id) ON DELETE CASCADE,
      doc_id      TEXT    REFERENCES shared_documents(id) ON DELETE CASCADE,
      setting     TEXT    NOT NULL CHECK (setting IN (${_sqlList(SHARED_DOC_NOTICE_SETTINGS)})),
      set_at      TEXT    NOT NULL,
      set_by      TEXT,
      CHECK ((group_id IS NULL) != (doc_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_doc_notice_prefs_group ON shared_doc_notice_prefs(project_id, group_id) WHERE doc_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_doc_notice_prefs_doc ON shared_doc_notice_prefs(project_id, doc_id) WHERE group_id IS NULL;

    CREATE TABLE IF NOT EXISTS shared_doc_deliveries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    INTEGER NOT NULL REFERENCES shared_doc_events(id) ON DELETE CASCADE,
      project_id  INTEGER NOT NULL,
      session_id  INTEGER NOT NULL DEFAULT 0,
      reason      TEXT    NOT NULL CHECK (reason IN (${_sqlList(SHARED_DOC_DELIVERY_REASONS)})),
      outcome     TEXT    NOT NULL CHECK (outcome IN (${_sqlList(SHARED_DOC_DELIVERY_OUTCOMES)})),
      error       TEXT,
      resolved_at TEXT    NOT NULL,
      outcome_at  TEXT,
      UNIQUE (event_id, project_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_doc_deliveries_pending ON shared_doc_deliveries(outcome) WHERE outcome = 'pending';
  `;
}

/**
 * v67→v68: add notice settings and per-recipient deliveries (#2389), then
 * prove their shape before the version advances. Purely additive.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateSharedDocNoticesV68() {
  _startupControlTransaction(() => _db.exec(_sharedDocNoticeDdl()));
  _verifySharedDocNoticesV68();
}

/**
 * The v68 postcondition, read from the stored DDL: settings cascade from the
 * project, group and doc and name exactly one scope; deliveries cascade from
 * their revision and are unique per (revision, project, session); every
 * setting, reason and outcome is in its CHECK.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifySharedDocNoticesV68() {
  const refuse = (what) => {
    throw new Error(`v67→v68 left ${what}. Refusing to advance schema_version.`);
  };
  const prefs = _tableDdl('shared_doc_notice_prefs');
  if (!prefs) refuse('no shared_doc_notice_prefs table');
  const deliveries = _tableDdl('shared_doc_deliveries');
  if (!deliveries) refuse('no shared_doc_deliveries table');
  for (const [table, ddl] of [['projects', prefs], ['project_groups', prefs], ['shared_documents', prefs], ['shared_doc_events', deliveries]]) {
    const cascade = new RegExp(`REFERENCES\\s+${table}\\s*\\(\\s*id\\s*\\)\\s+ON\\s+DELETE\\s+CASCADE`, 'i');
    if (!cascade.test(ddl)) refuse(`a table without ON DELETE CASCADE from ${table}`);
  }
  if (!/\(group_id IS NULL\)\s*!=\s*\(doc_id IS NULL\)/i.test(prefs)) refuse('shared_doc_notice_prefs without its one-scope CHECK');
  for (const value of SHARED_DOC_NOTICE_SETTINGS) {
    if (!prefs.includes(`'${value}'`)) refuse(`shared_doc_notice_prefs without "${value}" in its CHECK`);
  }
  for (const value of [...SHARED_DOC_DELIVERY_REASONS, ...SHARED_DOC_DELIVERY_OUTCOMES]) {
    if (!deliveries.includes(`'${value}'`)) refuse(`shared_doc_deliveries without "${value}" in its CHECKs`);
  }
  if (!/UNIQUE\s*\(\s*event_id\s*,\s*project_id\s*,\s*session_id\s*\)/i.test(deliveries)) {
    refuse('shared_doc_deliveries without UNIQUE (event_id, project_id, session_id)');
  }
  for (const index of ['idx_shared_doc_notice_prefs_group', 'idx_shared_doc_notice_prefs_doc']) {
    if (!/UNIQUE/i.test(_tableDdl(index) || '')) refuse(`no ${index} unique index`);
  }
}

/**
 * The governed coordinator context rotation record (#2032). One row per
 * rotation attempt, keyed by the caller's attempt key so a retried prepare
 * converges on the same row. `state` walks fenced → rebinding → reconciling →
 * active; `abandoned` is the operator's exit. While a project has a row in a
 * non-terminal state its new outbound dispatch is fenced — the partial unique
 * index is what makes "one rotation, one authority" a property of the table
 * rather than of every caller. A failed step never moves the state: it records
 * `failure_code` on the row it failed in, so a retry resumes the same attempt.
 * Shared by fresh installs and the v51 migration so the two cannot drift.
 * @returns {string} DDL
 */
function _coordinatorRotationTablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS coordinator_rotations (
      rotation_id           TEXT    PRIMARY KEY CHECK (length(rotation_id) BETWEEN 1 AND 64),
      attempt_key           TEXT    NOT NULL UNIQUE CHECK (length(attempt_key) BETWEEN 8 AND 128),
      project_id            INTEGER NOT NULL,
      session_id            INTEGER NOT NULL,
      launch_id             TEXT    NOT NULL CHECK (length(launch_id) <= 128),
      engine_id             TEXT    NOT NULL CHECK (length(engine_id) <= 64),
      channel_id            INTEGER NOT NULL,
      sequence_id           INTEGER NOT NULL,
      state                 TEXT    NOT NULL CHECK (state IN ('fenced','rebinding','reconciling','active','abandoned')),
      mode                  TEXT    NOT NULL DEFAULT 'clear' CHECK (mode IN ('clear','relaunch')),
      generation            INTEGER NOT NULL CHECK (generation >= 1),
      prior_thread_id       TEXT    NOT NULL CHECK (length(prior_thread_id) <= 128),
      prior_threads_json    TEXT    CHECK (prior_threads_json IS NULL OR length(prior_threads_json) <= 8192),
      clear_attempts        INTEGER NOT NULL DEFAULT 0 CHECK (clear_attempts >= 0),
      last_clear_attempt_at TEXT,
      replacement_thread_id TEXT    CHECK (replacement_thread_id IS NULL OR length(replacement_thread_id) <= 128),
      reentry_digest        TEXT    CHECK (reentry_digest IS NULL OR length(reentry_digest) = 64),
      resume_nonce_hash     TEXT    CHECK (resume_nonce_hash IS NULL OR length(resume_nonce_hash) = 64),
      checkpoint_schema     INTEGER NOT NULL,
      checkpoint_digest     TEXT    NOT NULL CHECK (length(checkpoint_digest) = 64),
      checkpoint_json       TEXT    NOT NULL CHECK (length(checkpoint_json) <= 65536),
      inbox_ids_json        TEXT    NOT NULL CHECK (length(inbox_ids_json) <= 16384),
      role_id               TEXT    NOT NULL CHECK (length(role_id) <= 64),
      authority_version     INTEGER NOT NULL CHECK (authority_version >= 1),
      checkout_json         TEXT    NOT NULL CHECK (length(checkout_json) <= 1048576),
      github_json           TEXT    NOT NULL CHECK (length(github_json) <= 65536),
      reconciling_at        TEXT,
      drift_json            TEXT    CHECK (drift_json IS NULL OR length(drift_json) <= 1048576),
      readiness_json        TEXT    CHECK (readiness_json IS NULL OR length(readiness_json) <= 8192),
      receipt_json          TEXT    CHECK (receipt_json IS NULL OR length(receipt_json) <= 65536),
      failure_code          TEXT    CHECK (failure_code IS NULL OR length(failure_code) <= 64),
      failure_detail        TEXT    CHECK (failure_detail IS NULL OR length(failure_detail) <= 500),
      created_at            TEXT    NOT NULL,
      updated_at            TEXT    NOT NULL,
      completed_at          TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_rotations_open
      ON coordinator_rotations(project_id) WHERE state IN ('fenced','rebinding','reconciling');

    -- The operator's durable statement that a project is a coordinator
    -- (Architect ruling A6a). A rotation may be prepared only under an active
    -- role, and records the role and authority version it was prepared under;
    -- a change to either while the rotation is open is authority drift, which
    -- no receipt can accept. One active role per project; a replacement bumps
    -- the authority version so the change is observable.
    CREATE TABLE IF NOT EXISTS coordinator_roles (
      role_id            TEXT    PRIMARY KEY CHECK (length(role_id) BETWEEN 1 AND 64),
      project_id         INTEGER NOT NULL,
      role               TEXT    NOT NULL CHECK (role IN ('architect','project-manager')),
      status             TEXT    NOT NULL CHECK (status IN ('active','revoked')),
      authority_version  INTEGER NOT NULL CHECK (authority_version >= 1),
      note               TEXT    CHECK (note IS NULL OR length(note) <= 500),
      created_by         TEXT    NOT NULL CHECK (created_by IN ('operator')),
      created_at         TEXT    NOT NULL,
      revoked_at         TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_roles_active
      ON coordinator_roles(project_id) WHERE status = 'active';
  `;
}

/**
 * The per-project recovery state table (#1937).
 *
 * One row per project, and the row outlives any pin: the pin columns and the
 * notice marker sit together so that neither write can erase the other. That
 * is why a reader must test `pinned_mode` and `pinned_at`, never whether a row
 * exists. A row with both NULL was created by the notice claim alone and
 * records no operator decision.
 *
 * `pinned_at` and `pinned_by` record the operator's last decision EITHER way:
 * `pinned_mode = 'operator'` with them set is a pin, `pinned_mode` NULL with
 * them set is the operator choosing advisory. The table CHECK refuses a pin
 * nobody is recorded as having made.
 *
 * This table has a real foreign key, unlike the launch tables: its rows are
 * settings of the project and are meant to go when the project does.
 * @returns {string} Idempotent DDL
 */
function _projectRecoveryStateDdl() {
  return `
    CREATE TABLE IF NOT EXISTS project_recovery_state (
      project_id                 INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      pinned_mode                TEXT    CHECK (pinned_mode IS NULL OR pinned_mode = 'operator'),
      pinned_at                  TEXT,
      pinned_by                  TEXT,
      inherited_notice_at        TEXT,
      inherited_notice_launch_id TEXT,
      CHECK (pinned_mode IS NULL OR pinned_at IS NOT NULL),
      CHECK ((pinned_at IS NULL) = (pinned_by IS NULL)),
      CHECK ((inherited_notice_at IS NULL) = (inherited_notice_launch_id IS NULL))
    );
  `;
}

/**
 * The durable record of an operator clearing a launch's required recovery
 * (#2049): one row per clearance, written in the transaction that clears the
 * launch, and never changed afterwards.
 *
 * `activity_log` also gets a `launch.recovery-cleared` row, but that table is
 * pruned per event type, so it cannot answer "who cleared this launch, and on
 * what evidence" for as long as the question can be asked.
 *
 * - `preflight` is the launch's preflight record as stored when it was
 *   cleared, copied as text. The clearance was a decision about that evidence,
 *   so the record keeps it even if the launch row is later rewritten.
 * - `batch_id` is NULL for a clearance made on its own. A batch is a larger
 *   grant than one clear and is never made on an install that proved no
 *   operator, which the table refuses for itself.
 * - `cleared_by` names the operator exactly when one authenticated.
 * - A launch's recovery never returns to `required` once cleared, so a launch
 *   has at most one row.
 * - No foreign keys: a row must outlive the project, session and launch it
 *   names, and must never stand in the way of deleting one.
 *
 * A session's own advisory reconciliation is not an operator clearance and
 * gets no row here. Idempotent (`IF NOT EXISTS` throughout), so
 * `_createTables` and the v59 migration share it. Nothing prunes these rows:
 * retention needs its own admitted policy.
 * @returns {string}
 */
function _launchRecoveryClearancesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS launch_recovery_clearances (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id          TEXT    CHECK (batch_id IS NULL OR length(batch_id) BETWEEN 1 AND 64),
      project_id        INTEGER NOT NULL,
      session_id        INTEGER NOT NULL,
      sequence_id       INTEGER NOT NULL,
      recovery_revision INTEGER NOT NULL,
      clearance         TEXT    NOT NULL CHECK (clearance IN ('operator-verified','open-install-unverified')),
      cleared_by        TEXT,
      preflight         TEXT    NOT NULL,
      cleared_at        TEXT    NOT NULL,
      CHECK ((clearance = 'operator-verified') = (cleared_by IS NOT NULL)),
      CHECK (batch_id IS NULL OR clearance = 'operator-verified')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_recovery_clearances_sequence
      ON launch_recovery_clearances(sequence_id);
    CREATE INDEX IF NOT EXISTS idx_launch_recovery_clearances_batch
      ON launch_recovery_clearances(batch_id) WHERE batch_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS launch_recovery_clearances_append_only_update
      BEFORE UPDATE ON launch_recovery_clearances
      BEGIN SELECT RAISE(ABORT, 'launch_recovery_clearances is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS launch_recovery_clearances_append_only_delete
      BEFORE DELETE ON launch_recovery_clearances
      BEGIN SELECT RAISE(ABORT, 'launch_recovery_clearances is append-only'); END;
  `;
}

/**
 * v58→v59: add the operator clearance record (#2049), then prove it can keep
 * an append-only record before the version advances. Purely additive: an older
 * server ignores the table, and its clears write no row here.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateLaunchRecoveryClearancesV59() {
  _startupControlTransaction(() => _db.exec(_launchRecoveryClearancesDdl()));
  _verifyLaunchRecoveryClearancesV59();
}

/**
 * The v59 postcondition: the table with its two CHECKs, the one-row-per-launch
 * index and both append-only triggers exist.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyLaunchRecoveryClearancesV59() {
  const refuse = (what) => {
    throw new Error(`v58→v59 left ${what}. Refusing to advance schema_version.`);
  };
  const table = _tableDdl('launch_recovery_clearances');
  if (!table) refuse('no launch_recovery_clearances table');
  if (!/CHECK\s*\(\s*\(\s*clearance\s*=\s*'operator-verified'\s*\)\s*=\s*\(\s*cleared_by\s+IS\s+NOT\s+NULL\s*\)\s*\)/i.test(table)) {
    refuse('launch_recovery_clearances without the CHECK that a verified clearance names its operator');
  }
  if (!/CHECK\s*\(\s*batch_id\s+IS\s+NULL\s+OR\s+clearance\s*=\s*'operator-verified'\s*\)/i.test(table)) {
    refuse('launch_recovery_clearances without the CHECK that a batch is operator-verified');
  }
  if (!/UNIQUE/i.test(_tableDdl('idx_launch_recovery_clearances_sequence'))) {
    refuse('no one-clearance-per-launch index');
  }
  for (const trigger of [
    'launch_recovery_clearances_append_only_update', 'launch_recovery_clearances_append_only_delete'
  ]) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
}

/**
 * DDL for the post-READY additive reconciliation record (#2191, Architect
 * ruling A477-COSIGN-20261027T2307Z).
 *
 * An attested launch (`ready_at IS NOT NULL`) that still shows live
 * governing-rule/shared-doc drift can append one of these instead of being
 * refused `READY_CONFLICT` — the original attestation (`ready_at`,
 * `ready_artifact`, `ready_digest`) is never rewritten. Idempotent on
 * (sequence_id, revision, drift_digest), so a retried append for the same
 * drift records nothing twice, which is what lets `tc start status` clear
 * the line for a digest it recognizes.
 *
 * Append-only by trigger, like `launch_recovery_clearances`: a reconciliation
 * is evidence of what was told to whom, and editing or deleting it after the
 * fact would rewrite that history. Idempotent (`IF NOT EXISTS` throughout),
 * so `_createTables` and the v71 migration share it.
 * @returns {string}
 */
function _launchReconciliationsDdl() {
  return `
    CREATE TABLE IF NOT EXISTS launch_reconciliations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence_id    INTEGER NOT NULL,
      session_id     INTEGER NOT NULL,
      project_id     INTEGER NOT NULL,
      revision       INTEGER NOT NULL,
      drift_digest   TEXT    NOT NULL,
      reconciliation TEXT    NOT NULL CHECK (length(reconciliation) >= 40),
      provenance     TEXT    NOT NULL DEFAULT 'agent-authored-unverified' CHECK (provenance = 'agent-authored-unverified'),
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (sequence_id, revision, drift_digest)
    );
    CREATE INDEX IF NOT EXISTS idx_launch_reconciliations_sequence ON launch_reconciliations(sequence_id);

    CREATE TRIGGER IF NOT EXISTS launch_reconciliations_append_only_update
      BEFORE UPDATE ON launch_reconciliations
      BEGIN SELECT RAISE(ABORT, 'launch_reconciliations is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS launch_reconciliations_append_only_delete
      BEFORE DELETE ON launch_reconciliations
      BEGIN SELECT RAISE(ABORT, 'launch_reconciliations is append-only'); END;
  `;
}

/**
 * DDL for the idempotent durable readiness receipt (#1877, same ruling).
 *
 * One row per (sequence, revision, assignment), emitted atomically inside the
 * `markReady` transaction. The UNIQUE constraint is the idempotency: a
 * repeated READY resolves the same key and finds its own row rather than
 * writing a second one. `recipient_project_id` is resolved strictly from
 * durable `control_assignments`/`coordinator_roles` principal data — never a
 * nickname or a workspace prefix. Any Medusa projection of this row is
 * recorded ON it (`projection_*`), never on a second table, so "did this
 * receipt reach anyone" has one answer; a projection failure never undoes the
 * READY it reports on, which is why `projection_state` can move independently
 * of the row's other columns after it is first written.
 *
 * Idempotent (`IF NOT EXISTS` throughout), so `_createTables` and the v71
 * migration share it.
 * @returns {string}
 */
function _launchReadinessReceiptsDdl() {
  return `
    CREATE TABLE IF NOT EXISTS launch_readiness_receipts (
      receipt_id              TEXT    PRIMARY KEY CHECK (length(receipt_id) BETWEEN 1 AND 64),
      sequence_id             INTEGER NOT NULL,
      launch_id               TEXT    NOT NULL,
      session_id              INTEGER NOT NULL,
      project_id              INTEGER NOT NULL,
      assignment_id           TEXT,
      revision                INTEGER NOT NULL,
      ready_digest            TEXT    NOT NULL,
      recipient_project_id    INTEGER,
      recipient_workspace_id  TEXT,
      projection_state        TEXT    NOT NULL DEFAULT 'none' CHECK (projection_state IN ('none','pending','sent','failed','skipped')),
      projection_exchange_id  TEXT,
      projection_error        TEXT,
      created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    -- A table-level UNIQUE constraint cannot hold an expression like
    -- COALESCE — SQLite only allows that in an INDEX, so the idempotency key
    -- the architect's ruling specifies lives here instead of inline above.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_readiness_receipts_idempotency
      ON launch_readiness_receipts(sequence_id, revision, COALESCE(assignment_id, ''));
    CREATE INDEX IF NOT EXISTS idx_launch_readiness_receipts_project ON launch_readiness_receipts(project_id);
  `;
}

/**
 * v70→v71: the two new tables above, plus the two unready-verdict columns
 * `_createTables` already carries for a fresh install (#1596, provisioned
 * here so W2-B makes 0 edits to this file). Purely additive: an older server
 * ignores all of it.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateLaunchReadinessV71() {
  _startupControlTransaction(() => {
    _db.exec(_launchReconciliationsDdl());
    _db.exec(_launchReadinessReceiptsDdl());
    // Each column's own guard, independently — not one check gating both.
    // A database that already has one of the two (a divergent build, a hand
    // repair) must not cause the other to be silently skipped.
    const existingCols = new Set(_db.prepare('PRAGMA table_info(launch_sequences)').all().map((c) => c.name));
    if (!existingCols.has('last_unready_verdict')) {
      _db.exec(
        'ALTER TABLE launch_sequences ADD COLUMN last_unready_verdict TEXT '
        + `CHECK (last_unready_verdict IS NULL OR last_unready_verdict IN (${_sqlList(UNREADY_VERDICTS)}))`
      );
    }
    if (!existingCols.has('last_unready_verdict_at')) {
      _db.exec('ALTER TABLE launch_sequences ADD COLUMN last_unready_verdict_at TEXT');
    }
  });
  _verifyLaunchReadinessV71();
}

/**
 * The v71 postcondition: both new tables with their idempotency constraints
 * and append-only triggers, and both new launch_sequences columns.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyLaunchReadinessV71() {
  const refuse = (what) => {
    throw new Error(`v70→v71 left ${what}. Refusing to advance schema_version.`);
  };
  const reconciliations = _tableDdl('launch_reconciliations');
  if (!reconciliations) refuse('no launch_reconciliations table');
  if (!/UNIQUE\s*\(\s*sequence_id\s*,\s*revision\s*,\s*drift_digest\s*\)/i.test(reconciliations)) {
    refuse('launch_reconciliations without its (sequence_id, revision, drift_digest) UNIQUE constraint');
  }
  if (!/CHECK\s*\(\s*length\s*\(\s*reconciliation\s*\)\s*>=\s*40\s*\)/i.test(reconciliations)) {
    refuse('launch_reconciliations without its minimum-length CHECK');
  }
  for (const trigger of ['launch_reconciliations_append_only_update', 'launch_reconciliations_append_only_delete']) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
  const receipts = _tableDdl('launch_readiness_receipts');
  if (!receipts) refuse('no launch_readiness_receipts table');
  if (!/projection_state[\s\S]*?CHECK\s*\(\s*projection_state\s+IN/i.test(receipts)) {
    refuse('launch_readiness_receipts without its projection_state CHECK');
  }
  const idempotencyIndex = _tableDdl('idx_launch_readiness_receipts_idempotency');
  if (!/UNIQUE/i.test(idempotencyIndex) || !/COALESCE\s*\(\s*assignment_id/i.test(idempotencyIndex)) {
    refuse('launch_readiness_receipts without its (sequence_id, revision, COALESCE(assignment_id, \'\')) idempotency index');
  }
  const launchSequencesDdl = _tableDdl('launch_sequences');
  if (!/last_unready_verdict_at/i.test(launchSequencesDdl)) refuse('launch_sequences without last_unready_verdict_at');
  // The CHECK is what `PRAGMA table_info` cannot see, so it is what this
  // postcondition has to look at: a column added without it looks identical
  // to one added with it, right up until a row records a verdict word that
  // means nothing.
  if (!new RegExp(`last_unready_verdict\\s+TEXT\\s+CHECK\\s*\\(\\s*last_unready_verdict\\s+IS\\s+NULL\\s+OR\\s+last_unready_verdict\\s+IN`, 'i')
    .test(launchSequencesDdl.replace(/\s+/g, ' '))) {
    refuse('launch_sequences\' last_unready_verdict without its CHECK');
  }
}

/**
 * DDL for the record of a batch recovery clear (#2049): one header row per
 * batch an operator sent, and one row per item in it saying what happened to
 * that item.
 *
 * `launch_recovery_clearances` records the clears that were made. These two
 * tables record the request around them, so a refusal is as durable as a
 * clear: without them nothing would say that an operator asked for a launch
 * to be cleared and was told it was stale.
 *
 * - The header is written before any item is decided and is never updated, so
 *   a batch that stopped part-way reads as a header naming more items than
 *   have rows. That shortfall is the record that it did not finish.
 * - `requested_by` is the signed-in operator. A batch is never accepted from
 *   an install that proved nobody, so it is never NULL.
 * - An item's four ids are the ones the request named, kept as sent. For any
 *   outcome but `cleared` they may name a launch that does not exist.
 * - An item cannot be written for a batch with no header, and a batch holds
 *   one row per item index. Both are refused by the table.
 * - No foreign keys, for the reason the clearance record has none.
 *
 * Append-only by trigger, and nothing prunes these rows: retention needs its
 * own admitted policy. Idempotent (`IF NOT EXISTS` throughout), so
 * `_createTables` and the v60 migration share it.
 * @returns {string}
 */
function _launchRecoveryClearBatchesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS launch_recovery_clear_batches (
      batch_id     TEXT    PRIMARY KEY CHECK (length(batch_id) BETWEEN 1 AND 64),
      requested_by TEXT    NOT NULL CHECK (length(requested_by) > 0),
      item_count   INTEGER NOT NULL CHECK (item_count >= 1),
      requested_at TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS launch_recovery_clear_batch_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id          TEXT    NOT NULL,
      item_index        INTEGER NOT NULL CHECK (item_index >= 0),
      project_id        INTEGER NOT NULL,
      session_id        INTEGER NOT NULL,
      sequence_id       INTEGER NOT NULL,
      recovery_revision INTEGER NOT NULL,
      outcome           TEXT    NOT NULL CHECK (outcome IN (${RECOVERY_BATCH_OUTCOMES_SQL})),
      recorded_at       TEXT    NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_recovery_clear_batch_items_item
      ON launch_recovery_clear_batch_items(batch_id, item_index);

    CREATE TRIGGER IF NOT EXISTS launch_recovery_clear_batch_items_need_batch
      BEFORE INSERT ON launch_recovery_clear_batch_items
      WHEN NOT EXISTS (SELECT 1 FROM launch_recovery_clear_batches WHERE batch_id = NEW.batch_id)
      BEGIN SELECT RAISE(ABORT, 'launch_recovery_clear_batch_items needs its batch header first'); END;

    CREATE TRIGGER IF NOT EXISTS launch_recovery_clear_batches_append_only_update
      BEFORE UPDATE ON launch_recovery_clear_batches
      BEGIN SELECT RAISE(ABORT, 'launch_recovery_clear_batches is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS launch_recovery_clear_batches_append_only_delete
      BEFORE DELETE ON launch_recovery_clear_batches
      BEGIN SELECT RAISE(ABORT, 'launch_recovery_clear_batches is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS launch_recovery_clear_batch_items_append_only_update
      BEFORE UPDATE ON launch_recovery_clear_batch_items
      BEGIN SELECT RAISE(ABORT, 'launch_recovery_clear_batch_items is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS launch_recovery_clear_batch_items_append_only_delete
      BEFORE DELETE ON launch_recovery_clear_batch_items
      BEGIN SELECT RAISE(ABORT, 'launch_recovery_clear_batch_items is append-only'); END;
  `;
}

/**
 * v59→v60: add the batch recovery clear record (#2049), then prove it can keep
 * an append-only record before the version advances. Purely additive: an older
 * server ignores both tables.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateLaunchRecoveryClearBatchesV60() {
  _startupControlTransaction(() => _db.exec(_launchRecoveryClearBatchesDdl()));
  _verifyLaunchRecoveryClearBatchesV60();
}

/**
 * The v60 postcondition: both tables, the one-row-per-item index, the trigger
 * that refuses an item with no header and the four append-only triggers exist.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyLaunchRecoveryClearBatchesV60() {
  const refuse = (what) => {
    throw new Error(`v59→v60 left ${what}. Refusing to advance schema_version.`);
  };
  if (!_tableDdl('launch_recovery_clear_batches')) refuse('no launch_recovery_clear_batches table');
  const items = _tableDdl('launch_recovery_clear_batch_items');
  if (!items) refuse('no launch_recovery_clear_batch_items table');
  for (const outcome of RECOVERY_BATCH_OUTCOMES) {
    if (!items.includes(`'${outcome}'`)) {
      refuse(`launch_recovery_clear_batch_items without the outcome "${outcome}" in its CHECK`);
    }
  }
  if (!/UNIQUE/i.test(_tableDdl('idx_launch_recovery_clear_batch_items_item'))) {
    refuse('no one-row-per-item index');
  }
  for (const trigger of [
    'launch_recovery_clear_batch_items_need_batch',
    'launch_recovery_clear_batches_append_only_update', 'launch_recovery_clear_batches_append_only_delete',
    'launch_recovery_clear_batch_items_append_only_update', 'launch_recovery_clear_batch_items_append_only_delete'
  ]) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
}

/**
 * v57→v58: add `sessions.launch_blocker` (#2128), then prove it is there before
 * the version advances. `_createTables` runs first and already builds a fresh
 * `sessions` with the column, so it is added only when `table_info` says it is
 * missing. Existing rows stay NULL: no session launched before this recorded a
 * blocker. Purely additive: an older server ignores the column.
 * @returns {void}
 * @throws {Error} When the column is still missing afterwards.
 */
function _migrateLaunchBlockerV58() {
  const columns = () => new Set(_db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  if (!columns().has('launch_blocker')) _db.exec('ALTER TABLE sessions ADD COLUMN launch_blocker TEXT');
  if (!columns().has('launch_blocker')) {
    throw new Error('v57→v58 left sessions without launch_blocker. Refusing to advance schema_version.');
  }
}

/**
 * v54→v55: add the per-project recovery state table (#1937), then prove its
 * key, its cascade and its pin CHECKs before the version advances. Purely
 * additive: an older server ignores the table and reads the mode from
 * `project.json` alone.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateProjectRecoveryStateV55() {
  _startupControlTransaction(() => _db.exec(_projectRecoveryStateDdl()));
  _verifyProjectRecoveryStateV55();
}

/**
 * The v55 postcondition, read from the stored DDL because `PRAGMA table_info`
 * does not surface CHECK or REFERENCES clauses.
 * @returns {void}
 * @throws {Error} When the table, its key, its cascade or a pin CHECK is missing.
 */
function _verifyProjectRecoveryStateV55() {
  const refuse = (what) => {
    throw new Error(`v54→v55 left ${what}. Refusing to advance schema_version.`);
  };
  const table = _db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_recovery_state'").get();
  if (!table) refuse('no project_recovery_state table');
  if (!/project_id\s+INTEGER\s+PRIMARY\s+KEY\s+REFERENCES\s+projects\(id\)\s+ON\s+DELETE\s+CASCADE/i.test(table.sql)) {
    refuse('project_recovery_state without a project_id key that cascades from projects');
  }
  if (!/CHECK\s*\(\s*pinned_mode\s+IS\s+NULL\s+OR\s+pinned_mode\s*=\s*'operator'\s*\)/i.test(table.sql)) {
    refuse('project_recovery_state without the pinned_mode CHECK');
  }
  if (!/CHECK\s*\(\s*pinned_mode\s+IS\s+NULL\s+OR\s+pinned_at\s+IS\s+NOT\s+NULL\s*\)/i.test(table.sql)) {
    refuse('project_recovery_state without the CHECK that a pin names its decision');
  }
  for (const column of ['pinned_by', 'inherited_notice_at', 'inherited_notice_launch_id']) {
    if (!new RegExp(`\\b${column}\\b`).test(table.sql)) refuse(`project_recovery_state without ${column}`);
  }
}

/**
 * v55→v56 (#1696, #1709): give session rules a place to die. Widens the
 * `status` CHECK to add `'retired'` (never delivered, distinct from a rule
 * merely switched off) and adds `replaces_rule_id` / `superseded_by` /
 * `retired_at` / `replacement_origin`, so an approved replacement can retire
 * the rule it replaces and both sides of that decision are recorded.
 *
 * SQLite cannot `ALTER` a `CHECK` constraint in place, so the table is
 * rebuilt — every existing row preserved verbatim, the four new columns
 * starting `NULL` (no rule was retired or replaced through this mechanism
 * before it existed; which pre-existing disabled rules are "really" retired
 * is the operator's Retire action, never a migration's guess). Mirrors the
 * v26→v27 rebuild: foreign-key enforcement is switched off OUTSIDE the
 * transaction (the pragma is a no-op inside one) so a pre-existing orphaned
 * row survives the rebuild rather than aborting it.
 * @returns {void}
 * @throws {Error} When the postcondition fails.
 */
function _migrateSessionRuleLifecycleV56() {
  let recreateErr = null;
  try {
    _db.exec('PRAGMA foreign_keys = OFF');
    _db.exec(`
      BEGIN;
      CREATE TABLE session_rules_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        content           TEXT    NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 1,
        created_by        TEXT    NOT NULL DEFAULT 'operator',
        kind              TEXT    NOT NULL DEFAULT 'startup',
        owner             TEXT,
        source_learning_id INTEGER REFERENCES learnings(id) ON DELETE SET NULL,
        status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','rejected','retired')),
        replaces_rule_id  INTEGER,
        superseded_by     INTEGER,
        retired_at        TEXT,
        replacement_origin TEXT CHECK (replacement_origin IS NULL OR replacement_origin IN ('amendment','edit','restore')),
        created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO session_rules_new
        (id, project_id, content, enabled, created_by, kind, owner, source_learning_id, status, created_at, updated_at)
        SELECT id, project_id, content, enabled, created_by, kind, owner, source_learning_id, status, created_at, updated_at
        FROM session_rules;
      DROP TABLE session_rules;
      ALTER TABLE session_rules_new RENAME TO session_rules;
      CREATE INDEX IF NOT EXISTS idx_session_rules_project ON session_rules(project_id);
      CREATE INDEX IF NOT EXISTS idx_session_rules_enabled ON session_rules(enabled);
      CREATE INDEX IF NOT EXISTS idx_session_rules_status ON session_rules(status);
      COMMIT;
    `);
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* no transaction in progress */ }
    recreateErr = err;
    log.warn('Migration v55→v56 recreate failed — see postcondition', { error: err.message });
  } finally {
    try { _db.exec('PRAGMA foreign_keys = ON'); } catch { /* connection already gone */ }
  }
  _verifySessionRuleLifecycleV56(recreateErr);
}

/**
 * The v56 postcondition: the widened CHECK and all four new columns are
 * really present, read from the stored DDL (`PRAGMA table_info` does not
 * surface CHECK clauses). A silent no-op here would stamp the DB v56 with a
 * v55 shape, and the first retire attempt would fail the CHECK instead of
 * ever reaching the application-level refusal this feature exists to add.
 * @param {Error|null} recreateErr - The rebuild's own failure, if it threw.
 * @returns {void}
 * @throws {Error} When the table, its CHECK or a new column is missing.
 */
function _verifySessionRuleLifecycleV56(recreateErr) {
  const srDdl = _db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_rules'"
  ).get();
  const refuse = (what) => {
    const cause = recreateErr ? `the table rebuild failed: ${recreateErr.message}` : `found: ${srDdl ? srDdl.sql : 'table missing'}`;
    throw new Error(`v55→v56 left ${what} (${cause}). Refusing to advance schema_version. See #1696/#1709.`);
  };
  if (!srDdl) refuse('no session_rules table');
  if (!/CHECK\s*\(\s*status\s+IN\s*\([^)]*'retired'/i.test(srDdl.sql)) {
    refuse("session_rules.status CHECK without 'retired'");
  }
  for (const column of ['replaces_rule_id', 'superseded_by', 'retired_at', 'replacement_origin']) {
    if (!new RegExp(`\\b${column}\\b`).test(srDdl.sql)) refuse(`session_rules without ${column}`);
  }
}

/**
 * v50→v51: add the coordinator rotation tables (#2032), then prove the
 * one-open-rotation-per-project index exists before the version advances.
 * Purely additive: an older server ignores the tables.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateCoordinatorRotationsV51() {
  _startupControlTransaction(() => _db.exec(_coordinatorRotationTablesDdl()));
  _verifyCoordinatorRotationsV51();
}

/**
 * The v51 postcondition: the table, its attempt-key uniqueness and the partial
 * unique index that allows one open rotation per project.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyCoordinatorRotationsV51() {
  const refuse = (what) => {
    throw new Error(`v50→v51 left ${what}. Refusing to advance schema_version.`);
  };
  const table = _db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_rotations'").get();
  if (!table) refuse('no coordinator_rotations table');
  if (!/attempt_key[^,]*UNIQUE/.test(table.sql)) refuse('coordinator_rotations without a unique attempt_key');
  const index = _db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_coordinator_rotations_open'").get();
  if (!index || !/UNIQUE/i.test(index.sql) || !/WHERE/i.test(index.sql)) refuse('no partial unique index on open rotations');
  const roles = _db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_coordinator_roles_active'").get();
  if (!roles || !/UNIQUE/i.test(roles.sql) || !/WHERE/i.test(roles.sql)) refuse('no partial unique index on active coordinator roles');
}

/**
 * v51→v52: add the operator bridge's tables (#2031, ADR 0023), then prove
 * their shape before the version advances. Purely additive: an older server
 * ignores the tables, and `medusa_exchanges` is not touched.
 * @returns {void}
 * @throws {Error} When the shape check fails.
 */
function _migrateOperatorBridgeV52() {
  _startupControlTransaction(() => bridgeSchema.createBridgeSchema(_db, 'the v51→v52 migration'));
}

/**
 * v52→v53: two bridge tables change shape (#2031). An outbound item may be a
 * `status` notice, and a message the bridge sent records exactly which
 * workspace, session and launch it went to. A CHECK cannot be altered in
 * place, so each of the two is rebuilt with its rows carried over. A store
 * that is not a sound v52 store is refused before anything is touched; one
 * already in the v53 shape has nothing rebuilt.
 * @returns {void}
 * @throws {Error} When the shape check fails.
 */
function _migrateOperatorBridgeV53() {
  _startupControlTransaction(() => {
    const rebuilt = bridgeSchema.upgradeBridgeTables(_db, 52);
    bridgeSchema.createBridgeSchema(_db, 'the v52→v53 migration');
    if (rebuilt.length) log.info('Rebuilt operator bridge tables for v53', { tables: rebuilt });
  });
}

/**
 * v53→v54: the helper's fetch leases (#2031). A new table records each time
 * an item is handed to the helper, and the helper-token table gains a CHECK
 * tying a revoked token to the time it was revoked, which means rebuilding
 * that one table with its rows carried over. A store that is not a sound v53
 * store is refused before anything is touched.
 * @returns {void}
 * @throws {Error} When the shape check fails.
 */
function _migrateOperatorBridgeV54() {
  _startupControlTransaction(() => {
    const rebuilt = bridgeSchema.upgradeBridgeTables(_db, 53);
    bridgeSchema.createBridgeSchema(_db, 'the v53→v54 migration');
    if (rebuilt.length) log.info('Rebuilt operator bridge tables for v54', { tables: rebuilt });
  });
}

/**
 * v61→v62: the outbound queue admits a fourth typed notification,
 * `lane-silent` (#2262, ADR 0023 Decision 9 as amended 2026-10-10). The types
 * are a CHECK on `bridge_outbound.notify_type`, which cannot be altered in
 * place, so that one table is rebuilt with every row, id and column carried
 * over. A store that is not a sound v61 store is refused before anything is
 * touched; one already in the v62 shape has nothing rebuilt.
 *
 * A store with no bridge table at all has no queue to carry over, and no
 * half of one to be suspicious of: its bridge storage is created whole, as
 * every boot would create it. One that holds some bridge tables and not
 * others is still refused.
 * @returns {void}
 * @throws {Error} When the shape check fails.
 */
function _migrateOperatorBridgeV62() {
  _startupControlTransaction(() => {
    const had = bridgeSchema.hasBridgeTables(_db);
    const rebuilt = had ? bridgeSchema.upgradeBridgeTables(_db, 61) : [];
    bridgeSchema.createBridgeSchema(_db, 'the v61→v62 migration');
    if (rebuilt.length) log.info('Rebuilt operator bridge tables for v62', { tables: rebuilt });
    if (!had) log.info('Created operator bridge tables for v62: this store had none');
  });
}

/**
 * v62→v63: the outbound queue admits two more typed notifications,
 * `gateway-down` and `gateway-recovered` (#2272, ADR 0023 Decision 9 as
 * amended 2026-10-11). As in v62, the types are a CHECK on
 * `bridge_outbound.notify_type`, so that one table is rebuilt with every row,
 * id and column carried over. A store that is not a sound v62 store is refused
 * before anything is touched; one already in the v63 shape has nothing rebuilt.
 *
 * Unlike v62, a store with no bridge table is refused too. Every start since
 * v52 creates the bridge's storage, so a v62 store without it has lost it.
 * @returns {void}
 * @throws {Error} When the shape check fails.
 */
function _migrateOperatorBridgeV63() {
  _startupControlTransaction(() => {
    const rebuilt = bridgeSchema.upgradeBridgeTables(_db, 62);
    bridgeSchema.createBridgeSchema(_db, 'the v62→v63 migration');
    if (rebuilt.length) log.info('Rebuilt operator bridge tables for v63', { tables: rebuilt });
  });
}

/**
 * v68→v69 (#2433): the operator bridge admits a second pinned ingress
 * surface, a bot DM channel beside the one pinned guild channel. `surface_kind`
 * is a CHECK on both `bridge_routes` and `bridge_outbound`, so both tables are
 * rebuilt with every row, id and column carried over; a row predating this
 * column reads `guild-channel`, the only surface there was. A store that is
 * not a sound v63-bridge store is refused before anything is touched; one
 * already in the v64-bridge shape has nothing rebuilt.
 * @returns {void}
 * @throws {Error} When the shape check fails.
 */
function _migrateBridgeSurfaceKindV69() {
  _startupControlTransaction(() => {
    const rebuilt = bridgeSchema.upgradeBridgeTables(_db, 63);
    bridgeSchema.createBridgeSchema(_db, 'the v68→v69 migration');
    if (rebuilt.length) log.info('Rebuilt operator bridge tables for v69 (bridge schema v64)', { tables: rebuilt });
  });
}

/**
 * v69→v70 (#2433): the configuration circuit opens per ingress surface, not
 * globally -- `surface_kind` is a CHECK on `bridge_config_circuit`, and its
 * one-open-episode index is now scoped to it, so a DM channel's outage opens
 * its own episode without the guild channel's circuit (or the reverse) being
 * open at the same time. The table is rebuilt with every row, id and column
 * carried over; a row predating this column reads `guild-channel`, the only
 * surface a circuit could open for before this version.
 * @returns {void}
 * @throws {Error} When the shape check fails.
 */
function _migrateBridgeCircuitSurfaceV70() {
  _startupControlTransaction(() => {
    const rebuilt = bridgeSchema.upgradeBridgeTables(_db, 64);
    bridgeSchema.createBridgeSchema(_db, 'the v69→v70 migration');
    if (rebuilt.length) log.info('Rebuilt operator bridge tables for v70 (bridge schema v65)', { tables: rebuilt });
  });
}

/**
 * DDL for the Medusa delivery watchdog's durable exchange state (#1839).
 *
 * An exchange is one ordinary Medusa message to one recipient, tracked from
 * the sender's intent to its terminal outcome. The Hub keeps the body; these
 * tables keep what happened to it, keyed by the Hub's message id once the Hub
 * has returned one.
 *
 * `medusa_exchange_facts` is the truth; `medusa_exchanges` is a projection of
 * those facts plus the fixed send-time metadata: arrival, wake, read, ack and
 * reply facts can race or land out of order, so the projection is recomputed
 * from the facts rather than stepped through a fixed sequence, and `replay`
 * must reproduce it exactly. Only terminal outcomes (closed, retracted,
 * undeliverable, recipient_retired) are guarded transitions with a single
 * winner.
 *
 * Control notices and escalation notices never get a row here. That is what
 * keeps HOLD/STOP/RELEASE out of reach of anything that acts on exchanges,
 * retraction included.
 *
 * `medusa_exchange_facts` is append-only while its exchange is open: the
 * UPDATE trigger refuses unconditionally, and the DELETE trigger (#1879,
 * v73→v74) refuses unless the parent `medusa_exchanges` row is terminal
 * (`terminal_at IS NOT NULL`) or `untracked` — the shape retention needs to
 * prune a closed exchange's facts before the exchange row itself, inside one
 * transaction, without opening deletion to a conversation still in flight.
 *
 * Idempotent (`IF NOT EXISTS` throughout), so `_createTables` and the v49
 * migration share it. Retention policy for the rows themselves lives in
 * `lib/medusa-exchanges.js`.
 * @returns {string}
 */
function _medusaExchangeTablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS medusa_exchanges (
      exchange_id            TEXT    PRIMARY KEY,
      request_id             TEXT    NOT NULL UNIQUE CHECK (length(request_id) <= 128),
      hub_id                 TEXT    CHECK (hub_id IS NULL OR length(hub_id) <= 128),
      origin                 TEXT    NOT NULL CHECK (origin IN ('send','arrival')),
      tracking               TEXT    NOT NULL CHECK (tracking IN ('tracked','untracked')),
      sender_project_id      INTEGER,
      sender_session_id      TEXT,
      sender_workspace_id    TEXT    CHECK (sender_workspace_id IS NULL OR length(sender_workspace_id) <= 128),
      sender_verified        INTEGER NOT NULL DEFAULT 0 CHECK (sender_verified IN (0,1)),
      sender_proof           TEXT    CHECK (sender_proof IS NULL OR sender_proof IN ('launch','verified-session','ambient-open','system')),
      recipient_workspace_id TEXT    NOT NULL CHECK (length(recipient_workspace_id) <= 128),
      recipient_project_id   INTEGER,
      recipient_session_id   TEXT,
      priority               TEXT    NOT NULL CHECK (priority IN ('normal','blocking','critical')),
      reply_required         INTEGER NOT NULL CHECK (reply_required IN (0,1)),
      escalate_after_ms      INTEGER CHECK (escalate_after_ms IS NULL OR escalate_after_ms > 0),
      reason_code            TEXT    CHECK (reason_code IS NULL OR length(reason_code) <= 40),
      in_reply_to            TEXT    CHECK (in_reply_to IS NULL OR length(in_reply_to) <= 64),
      created_at             TEXT    NOT NULL,
      -- The projection: every column below is recomputed from the facts.
      state                  TEXT    NOT NULL CHECK (state IN (
                               'send_pending','send_unknown','stored','delivered',
                               'wake_pending','wake_blocked','wake_attempted','wake_not_accepted','wake_accepted',
                               'read','acknowledged','replied',
                               'closed','retracted','undeliverable','recipient_retired','untracked')),
      wake_code              TEXT    CHECK (wake_code IS NULL OR length(wake_code) <= 40),
      esc_level              TEXT    NOT NULL DEFAULT 'none'
                               CHECK (esc_level IN ('none','aged','escalated','operator')),
      rearm_count            INTEGER NOT NULL DEFAULT 0 CHECK (rearm_count >= 0),
      next_eligible_at       TEXT,
      terminal_at            TEXT,
      terminal_by            TEXT    CHECK (terminal_by IS NULL OR length(terminal_by) <= 64),
      terminal_code          TEXT    CHECK (terminal_code IS NULL OR length(terminal_code) <= 40),
      replacement_hub_id     TEXT    CHECK (replacement_hub_id IS NULL OR length(replacement_hub_id) <= 128),
      updated_at             TEXT    NOT NULL
    );
    -- A Hub id names one message. A send learns it only after the Hub
    -- answers, and the Hub can push the message to a recipient on this host
    -- before that answer returns, so one send row and one arrival row may
    -- share it until the send adopts the arrival.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_medusa_exchanges_hub
      ON medusa_exchanges(hub_id, origin) WHERE hub_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_recipient ON medusa_exchanges(recipient_workspace_id, state);
    CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_sender ON medusa_exchanges(sender_project_id, state);
    CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_open
      ON medusa_exchanges(created_at) WHERE terminal_at IS NULL AND tracking = 'tracked';
    -- Retention's own three bucket queries (#1879, lib/medusa-exchanges.js
    -- pruneExchangeHistory): one partial index per shape they actually scan,
    -- so a terminal transition or an untracked arrival doesn't rank every
    -- row in the table to find its own bucket's newest-first order.
    CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_untracked_retention
      ON medusa_exchanges(created_at, exchange_id) WHERE state = 'untracked';
    CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_terminal_retention
      ON medusa_exchanges(recipient_project_id, terminal_at, exchange_id) WHERE terminal_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS medusa_exchange_facts (
      fact_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange_id  TEXT    NOT NULL,
      fact         TEXT    NOT NULL CHECK (fact IN (
                     'send_pending','hub_accepted','send_unknown','send_refused','arrived',
                     'wake_pending','wake_blocked','wake_attempted','wake_not_accepted','wake_accepted','rearmed',
                     'readiness_changed',
                     'read','acknowledged','replied',
                     'closed','retracted','undeliverable','recipient_retired',
                     'aged','escalated','escalation_queued','escalation_accepted','escalation_failed','escalation_undeliverable',
                     'operator_alerted')),
      code         TEXT    CHECK (code IS NULL OR length(code) <= 40),
      actor        TEXT    CHECK (actor IS NULL OR length(actor) <= 64),
      proof        TEXT    CHECK (proof IS NULL OR length(proof) <= 40),
      detail_json  TEXT    CHECK (detail_json IS NULL OR length(detail_json) <= 1024),
      at           TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_medusa_exchange_facts_exchange ON medusa_exchange_facts(exchange_id, fact_seq);

    CREATE TRIGGER IF NOT EXISTS medusa_exchange_facts_append_only_update
      BEFORE UPDATE ON medusa_exchange_facts
      BEGIN SELECT RAISE(ABORT, 'medusa_exchange_facts is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS medusa_exchange_facts_append_only_delete
      BEFORE DELETE ON medusa_exchange_facts
      WHEN NOT EXISTS (
        SELECT 1 FROM medusa_exchanges x
         WHERE x.exchange_id = OLD.exchange_id
           AND (x.terminal_at IS NOT NULL OR x.state = 'untracked')
      )
      BEGIN SELECT RAISE(ABORT, 'medusa_exchange_facts is append-only while its exchange is open'); END;
  `;
}

/**
 * v48→v49: add the Medusa exchange tables (#1839), then prove they carry the
 * constraints the watchdog rests on before the version advances. Purely
 * additive, so a v48 server that meets a v49 store ignores the new tables and
 * the rows survive a rollback and re-upgrade.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateMedusaExchangesV49() {
  _startupControlTransaction(() => _db.exec(_medusaExchangeTablesDdl()));
  _verifyMedusaExchangeTablesV49();
}

/**
 * The v49 postcondition: both tables, the Hub-id uniqueness index and both
 * append-only triggers exist.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyMedusaExchangeTablesV49() {
  const refuse = (what) => {
    throw new Error(`v48→v49 left ${what}. Refusing to advance schema_version.`);
  };
  for (const table of ['medusa_exchanges', 'medusa_exchange_facts']) {
    if (!_tableDdl(table)) refuse(`no ${table} table`);
  }
  if (!/UNIQUE/i.test(_tableDdl('idx_medusa_exchanges_hub'))) refuse('no Hub-id uniqueness index');
  for (const trigger of ['medusa_exchange_facts_append_only_update', 'medusa_exchange_facts_append_only_delete']) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
}

/** Every column v46 gave `startup_prompt_fires`, copied verbatim by the v47 rebuild. */
const _STARTUP_FIRES_V46_COLUMNS = `${_STARTUP_FIRES_V45_COLUMNS}, payload, payload_digest, engine_thread_id, engine_turn_id, `
  + 'dispatched_at, accepted_at, settled_at';

/**
 * v46→v47 (#1825 B3): the automatic bootstrap's actor on `startup_prompt_fires`
 * (`caller_kind` gains `launch`, `caller_clearance` gains `launch-automatic`),
 * and `launch_sequences.startup_delivery`, the durable record of which path a
 * launch selected.
 *
 * The fires table is rebuilt the way v46 rebuilt it — a CHECK cannot be
 * altered in place — inside one `BEGIN IMMEDIATE`, every row copied by name
 * and counted, the indexes recreated. The sequence column is additive with a
 * default of `legacy`, which is the truth for every launch made before it
 * existed. Idempotent; the postcondition refuses to advance over a half-built
 * result.
 * @returns {void}
 */
function _migrateStartupControlV47() {
  const ddl = _tableDdl;
  _db.exec('BEGIN IMMEDIATE');
  try {
    const fires = ddl('startup_prompt_fires');
    if (!fires.includes("'launch'") || !fires.includes("'launch-automatic'") || !fires.includes("'pane_not_ready'")) {
      _db.exec(_startupPromptFiresDdl('startup_prompt_fires_v47'));
      _db.exec(
        `INSERT INTO startup_prompt_fires_v47 (${_STARTUP_FIRES_V46_COLUMNS}) `
        + `SELECT ${_STARTUP_FIRES_V46_COLUMNS} FROM startup_prompt_fires`
      );
      const before = _db.prepare('SELECT COUNT(*) AS n FROM startup_prompt_fires').get().n;
      const after = _db.prepare('SELECT COUNT(*) AS n FROM startup_prompt_fires_v47').get().n;
      if (before !== after) throw new Error(`v46→v47 copied ${after} of ${before} fire rows. Refusing to advance schema_version.`);
      _db.exec('DROP TABLE startup_prompt_fires');
      _db.exec('ALTER TABLE startup_prompt_fires_v47 RENAME TO startup_prompt_fires');
      _db.exec(_startupPromptFiresIndexesSql());
    }
    if (!/startup_delivery/i.test(ddl('launch_sequences'))) {
      _db.exec(`ALTER TABLE launch_sequences ADD COLUMN startup_delivery TEXT NOT NULL DEFAULT 'legacy' `
        + `CHECK (startup_delivery IN (${STARTUP_DELIVERIES_SQL}))`);
    }
    _db.exec('COMMIT');
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
  _verifyStartupControlTables('v46→v47');
  _verifyStartupControlTablesV47();
}

/**
 * The v47 postcondition: the fires table's actor CHECKs name the launch caller
 * and the sequence table carries `startup_delivery` with its CHECK.
 * @returns {void}
 * @throws {Error} When either is missing.
 */
function _verifyStartupControlTablesV47() {
  const ddl = _tableDdl;
  const refuse = (what) => {
    throw new Error(`v46→v47 left ${what}. Refusing to advance schema_version.`);
  };
  const fires = ddl('startup_prompt_fires');
  for (const kind of STARTUP_FIRE_CALLER_KINDS) {
    if (!fires.includes(`'${kind}'`)) refuse(`startup_prompt_fires whose caller_kind CHECK lacks ${kind}`);
  }
  for (const clearance of STARTUP_FIRE_CLEARANCES) {
    if (!fires.includes(`'${clearance}'`)) refuse(`startup_prompt_fires whose caller_clearance CHECK lacks ${clearance}`);
  }
  if (!ddl('idx_startup_prompt_fires_active')) refuse('no one-active-fire-per-launch index');
  if (!ddl('idx_startup_prompt_fires_applied')) refuse('no applied-is-never-reinjected index');
  if (!ddl('idx_startup_prompt_fires_session')) refuse('no fires-by-session index');
  if (!/startup_delivery[^,]*CHECK\s*\(\s*startup_delivery\s+IN/i.test(ddl('launch_sequences'))) refuse('launch_sequences without startup_delivery and its CHECK');
}

/**
 * v45→v46 (#1825): the receipt columns on `startup_prompt_fires`
 * and the wider `reason_code` CHECK the Codex adapter needs, plus the
 * `startup_control_channels` table (created by the boot-time block).
 *
 * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt:
 * a new table with the v46 DDL, every row copied by name, the old table
 * dropped, the new one renamed, the indexes recreated — one `BEGIN
 * IMMEDIATE`, so a crash leaves either the old table or the new one, never
 * both or neither. Idempotent: a table already carrying the v46 shape is
 * left alone. The postcondition refuses to let the version advance over a
 * half-built result.
 * @returns {void}
 */
function _migrateStartupControlV46() {
  const ddl = _tableDdl;
  const current = ddl('startup_prompt_fires');
  const hasShape = /payload_digest/i.test(current) && current.includes("'trust_required'");
  if (!hasShape) {
    _db.exec('BEGIN IMMEDIATE');
    try {
      _db.exec(_startupPromptFiresDdl('startup_prompt_fires_v46'));
      _db.exec(
        `INSERT INTO startup_prompt_fires_v46 (${_STARTUP_FIRES_V45_COLUMNS}) `
        + `SELECT ${_STARTUP_FIRES_V45_COLUMNS} FROM startup_prompt_fires`
      );
      const before = _db.prepare('SELECT COUNT(*) AS n FROM startup_prompt_fires').get().n;
      const after = _db.prepare('SELECT COUNT(*) AS n FROM startup_prompt_fires_v46').get().n;
      if (before !== after) throw new Error(`v45→v46 copied ${after} of ${before} fire rows. Refusing to advance schema_version.`);
      _db.exec('DROP TABLE startup_prompt_fires');
      _db.exec('ALTER TABLE startup_prompt_fires_v46 RENAME TO startup_prompt_fires');
      _db.exec(_startupPromptFiresIndexesSql());
      _db.exec('COMMIT');
    } catch (err) {
      try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
  }
  _verifyStartupControlTables();
}

/**
 * The v46 postcondition: refuse to advance the schema version unless the
 * fires table carries the receipt columns and the widened CHECK, its indexes
 * survived the rebuild, and the channels table exists with its one-open rule.
 * The v47 rebuild re-runs it under its own label, because it rebuilds the same
 * table and owes the same shape.
 * @param {string} [migration='v45→v46'] - Which migration the refusal names.
 * @returns {void}
 * @throws {Error} When any of those is missing.
 */
function _verifyStartupControlTables(migration = 'v45→v46') {
  const ddl = _tableDdl;
  const refuse = (what) => {
    throw new Error(`${migration} left ${what}. Refusing to advance schema_version.`);
  };
  const fires = ddl('startup_prompt_fires');
  for (const col of ['payload', 'payload_digest', 'engine_thread_id', 'engine_turn_id', 'dispatched_at', 'accepted_at', 'settled_at']) {
    if (!new RegExp(`\\b${col}\\b`).test(fires)) refuse(`startup_prompt_fires without ${col}`);
  }
  for (const code of STARTUP_FIRE_REASON_CODES) {
    if (!fires.includes(`'${code}'`)) refuse(`startup_prompt_fires whose reason_code CHECK lacks ${code}`);
  }
  if (!/idempotency_key\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(fires)) refuse('startup_prompt_fires without its idempotency key');
  if (!ddl('idx_startup_prompt_fires_active')) refuse('no one-active-fire-per-launch index');
  if (!ddl('idx_startup_prompt_fires_applied')) refuse('no applied-is-never-reinjected index');
  if (!ddl('idx_startup_prompt_fires_session')) refuse('no fires-by-session index');
  const channels = ddl('startup_control_channels');
  if (!/state[^,]*CHECK\s*\(\s*state\s+IN/i.test(channels)) refuse('startup_control_channels without its state CHECK');
  if (!/adapter_state/i.test(channels)) refuse('startup_control_channels without adapter_state');
  if (!ddl('idx_startup_control_channels_open')) refuse('no one-open-channel-per-session index');
}

/**
 * v44→45 (#1825): verify the startup prompt tables.
 *
 * `_createTables` has already created both tables and seeded revision 1 by the
 * time this runs, so the migration's work is to refuse to advance the schema
 * version if either table lacks a constraint its readers rely on: the
 * provenance and outcome CHECKs, the idempotency key, the active-fire and
 * applied-fire indexes, and the seed.
 *
 * @throws {Error} When any of those is missing.
 */
function _verifyStartupPromptTables() {
  const ddl = _tableDdl;
  const refuse = (what) => {
    throw new Error(`v44→v45 left ${what}. Refusing to advance schema_version.`);
  };
  const revisions = ddl('startup_prompt_revisions');
  if (!/created_by_kind[^,]*CHECK\s*\(\s*created_by_kind\s+IN/i.test(revisions)) {
    refuse('startup_prompt_revisions without its created_by_kind CHECK');
  }
  if (!/policy_digest/i.test(revisions)) refuse('startup_prompt_revisions without policy_digest');
  const fires = ddl('startup_prompt_fires');
  if (!/outcome[^,]*CHECK\s*\(\s*outcome\s+IN/i.test(fires)) refuse('startup_prompt_fires without its outcome CHECK');
  if (!/idempotency_key\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(fires)) refuse('startup_prompt_fires without its idempotency key');
  if (!ddl('idx_startup_prompt_fires_active')) refuse('no one-active-fire-per-launch index');
  if (!ddl('idx_startup_prompt_fires_applied')) refuse('no applied-is-never-reinjected index');
  const seeded = _db.prepare('SELECT 1 FROM startup_prompt_revisions WHERE revision = 1').get();
  if (!seeded) {
    throw new Error('v44→v45 found no revision 1 of the startup prompt. Refusing to advance schema_version.');
  }
}

/**
 * Current revision, write and fire-audit access to the startup prompt (#1825).
 * The service in `lib/startup-prompt.js` is the only caller; routes go through
 * it so the dashboard and the API share one path.
 */

/**
 * v42→43 (Train 21, #1587): the recovery columns on `launch_sequences`.
 *
 * Additive, and deliberately so. Every existing row takes `recovery = 'none'`,
 * `recovery_mode = 'operator'` and `recovery_revision = 1`: a launch that
 * happened before the gate existed was never told it owed a recovery, and
 * defaulting live panes to `required` would strand every session mid-launch
 * behind a clear nobody knew to give. The gate applies from the next launch on,
 * where a preflight verdict actually decided it.
 *
 * `_createTables` runs first and builds a fresh table already carrying these
 * columns, so each one is added only when `table_info` says it is missing —
 * which also makes a retried or half-applied upgrade a no-op rather than an
 * error. The postcondition then reads the DDL back, because `PRAGMA table_info`
 * cannot surface a CHECK clause and a column without its CHECK would accept the
 * clearance values this car exists to keep apart.
 */
function _migrateLaunchRecovery() {
  _db.exec('BEGIN IMMEDIATE');
  try {
    const have = new Set(_db.prepare('PRAGMA table_info(launch_sequences)').all().map((c) => c.name));
    for (const [name, decl] of LAUNCH_RECOVERY_COLUMNS) {
      if (!have.has(name)) _db.exec(`ALTER TABLE launch_sequences ADD COLUMN ${name} ${decl}`);
    }
    const after = new Set(_db.prepare('PRAGMA table_info(launch_sequences)').all().map((c) => c.name));
    for (const [name] of LAUNCH_RECOVERY_COLUMNS) {
      if (!after.has(name)) {
        throw new Error(`v42→43 did not add launch_sequences.${name}. Refusing to advance schema_version.`);
      }
    }
    const ddl = _db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='launch_sequences'").get();
    const sql = ddl && ddl.sql ? ddl.sql : '';
    for (const [name, decl] of LAUNCH_RECOVERY_COLUMNS) {
      if (!decl.includes('CHECK')) continue;
      // The column's own CHECK, not merely the words somewhere in the table: a
      // regex anchored to the column name is what tells "this column is
      // constrained" from "some column is".
      const constrained = new RegExp(`${name}[^,]*CHECK\\s*\\(\\s*${name}\\s+IN`, 'i').test(sql);
      if (!constrained) {
        throw new Error(
          `v42→43 left launch_sequences.${name} without its CHECK constraint. Refusing to advance schema_version.`
        );
      }
    }
    _db.exec('COMMIT');
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
  log.info('Migration v42→43: launch recovery columns added (#1587)');
}

/**
 * v27→v28: retire the methodology layer.
 *
 * Two steps that MUST stay in this order, in this one function: a terminal
 * wrap-config seed, then the column drops. Before this migration a project
 * labeled `minimal` ran an effectively commit-only wrap (its template's only
 * non-commit steps shipped empty prompts, which self-skip). The wrap pipeline
 * is now code-owned and full-featured, so the label was the last thing that
 * could identify those projects — once the column is gone, an unseeded one
 * silently flips from a commit-only wrap to the full pipeline, running
 * changelog/memory/PR steps it was never configured for.
 *
 * So every `minimal` row gets `wrapStepOverrides` disabling every disableable
 * step, plus the one-shot `wrapOverridesSeeded` marker, and only then does the
 * column drop. Coupling them here (rather than in a boot sweep) means no
 * install can reach the post-drop schema without having been seeded first —
 * including installs that never ran the version that introduced the sweep.
 *
 * Rows already carrying the marker are left untouched (the operator may have
 * since opted into the full pipeline by clearing the map). Rows whose path is
 * gone cannot be written and are logged individually: nothing on disk can be
 * seeded, so the warning is the record, and the project will adopt the default
 * pipeline if its directory ever returns.
 *
 * @returns {void}
 */
function _migrateDropMethodology() {
  const wrapDefaultPipeline = require('../wrap-default-pipeline');
  const wrapStepOverrides = require('../wrap-step-overrides');

  let seeded = 0;
  let unreachable = 0;
  // An old DB always has the column, but a partially-applied run of this
  // migration would not — re-querying it unguarded would abort the whole
  // ladder on retry.
  const hasColumn = _db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'methodology');
  const minimalRows = hasColumn
    ? _db.prepare("SELECT name, path FROM projects WHERE methodology = 'minimal'").all()
    : [];

  for (const row of minimalRows) {
    if (!row.path || !fs.existsSync(row.path)) {
      unreachable++;
      log.warn('Cannot seed commit-only wrap overrides — project path is gone', {
        project: row.name,
        path: row.path,
        howToInvestigate: 'This project ran a commit-only wrap. Its directory no longer exists, so nothing could be written. If it returns, it will run the full default wrap pipeline; disable the steps it should not run in Project Settings → Wrap steps.'
      });
      continue;
    }

    const configPath = path.join(row.path, '.tangleclaw', 'project.json');
    // Raw read, NOT fs.existsSync + projectConfigApi.load: that pairing treats
    // a present-but-unreadable file the same as an absent one (the lax loader
    // falls back to defaults either way), which would read as "not yet
    // seeded" and let this migration overwrite a config it could not actually
    // parse (#2232). ENOENT/ENOTDIR are the only read failures that genuinely
    // mean "no config yet"; anything else (permission denied, a directory
    // where the file should be) is this project's own unreadable state.
    let onDisk;
    try {
      onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        onDisk = {};
      } else {
        unreachable++;
        log.warn('Cannot seed commit-only wrap overrides — project.json is unreadable', {
          project: row.name,
          path: configPath,
          error: err.message,
          howToInvestigate: 'Fix the JSON syntax, then disable the unwanted wrap steps in Project Settings → Wrap steps. Left as-is, this project will run the full default wrap pipeline.'
        });
        continue;
      }
    }
    // A JSON value that parsed fine but isn't a plain object ([], 42, "str")
    // is just as unusable as a parse failure — `onDisk.wrapOverridesSeeded`
    // below would read undefined either way, which is indistinguishable from
    // "not yet seeded" and would fall through to the save that clobbers it.
    if (onDisk === null || typeof onDisk !== 'object' || Array.isArray(onDisk)) {
      unreachable++;
      log.warn('Cannot seed commit-only wrap overrides — project.json is not a JSON object', {
        project: row.name,
        path: configPath,
        howToInvestigate: 'project.json must hold a JSON object. Fix it, then disable the unwanted wrap steps in Project Settings → Wrap steps. Left as-is, this project will run the full default wrap pipeline.'
      });
      continue;
    }
    if (onDisk.wrapOverridesSeeded) continue;

    // The root-object guard above only proves the TOP-LEVEL shape. `load`'s own
    // merge can still throw deeper — `{"rules":null,...}` passes the guard but
    // fails merging `rules.core` — and the lax loader catches that and returns
    // silent defaults, which this migration would then save over the very file
    // it came from. `onError` is the only way to tell "absent, defaults are
    // fine" apart from "present and unusable, defaults would clobber it."
    let loadErr = null;
    const config = projectConfigApi.load(row.path, { onError: (err) => { loadErr = err; } });
    if (loadErr) {
      unreachable++;
      log.warn('Cannot seed commit-only wrap overrides — project.json is unreadable', {
        project: row.name,
        path: configPath,
        error: loadErr.message,
        howToInvestigate: 'Fix the file, then disable the unwanted wrap steps in Project Settings → Wrap steps. Left as-is, this project will run the full default wrap pipeline.'
      });
      continue;
    }
    const existing = config.wrapStepOverrides || {};
    if (Object.keys(existing).length === 0) {
      const overrides = {};
      for (const step of wrapDefaultPipeline.steps()) {
        if (wrapStepOverrides.UNDISABLEABLE_KINDS.has(step.kind)) continue;
        overrides[step.id] = { enabled: false };
      }
      config.wrapStepOverrides = overrides;
    }
    config.wrapOverridesSeeded = true;
    try {
      projectConfigApi.save(row.path, config);
      seeded++;
    } catch (err) {
      // Match the two skip paths above: an unwritable project.json is that
      // project's problem, not a reason to abort startup for every project.
      // Throwing here would leave the server dead on every restart with no
      // indication of which project caused it.
      unreachable++;
      log.warn('Cannot seed commit-only wrap overrides — project.json is unwritable', {
        project: row.name,
        path: configPath,
        error: err.message,
        howToInvestigate: 'Fix the file permissions, then disable the unwanted wrap steps in Project Settings → Wrap steps. Left as-is, this project will run the full default wrap pipeline.'
      });
    }
  }

  // Snapshot before the first destructive migration TangleClaw has shipped.
  // Every prior migration added; this one DROPs four columns, so a downgrade to
  // an older TangleClaw cannot read the result and the dropped values are
  // unrecoverable from the live file. Same seed-once shape as the #240 legacy
  // rules backup: never overwrite an existing snapshot, and never fail the
  // migration over it — a missing backup is worse than no backup only if it
  // stops the upgrade.
  const backupPath = _dbFile + '.pre-v28-backup';
  try {
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(_dbFile, backupPath);
      log.info('Backed up the database before dropping methodology columns (#538)', {
        path: backupPath,
        howToInvestigate: 'This is a one-time snapshot of the pre-v28 schema. Delete it once you are satisfied with the upgrade; TangleClaw never reads it.'
      });
    }
  } catch (err) {
    log.warn('Could not back up the database before the v27→v28 column drops', {
      path: backupPath,
      error: err.message
    });
  }

  // Indexes must go before the columns they cover — SQLite refuses to drop an
  // indexed column.
  _db.exec('DROP INDEX IF EXISTS idx_projects_methodology');
  _db.exec('DROP INDEX IF EXISTS idx_eval_scores_project_time');
  for (const [table, column] of [
    ['projects', 'methodology'],
    ['sessions', 'methodology_phase'],
    ['eval_scores', 'methodology'],
    ['eval_baselines', 'methodology']
  ]) {
    try {
      _db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch (err) {
      // A fresh DB created by _createTables never had the column.
      log.debug('Migration v27→v28: column already absent', { table, column, error: err.message });
    }
  }
  _db.exec('CREATE INDEX IF NOT EXISTS idx_eval_scores_project_time ON eval_scores(scored_at)');

  // Postcondition: refuse to advance the version while the column survives.
  // Stamping v28 over a live `methodology` column would leave the codebase
  // reading a field the schema still enforces NOT NULL on, and every
  // subsequent project insert would fail.
  const cols = _db.prepare('PRAGMA table_info(projects)').all();
  if (cols.some((c) => c.name === 'methodology')) {
    throw new Error(
      'v27→v28 migration did not drop projects.methodology. Aborting — schema_version '
      + 'will NOT advance to 28 until this is resolved. See #538.'
    );
  }

  log.info('Migration v27→v28: methodology layer retired (#538)', {
    seeded,
    unreachable,
    minimalProjects: minimalRows.length
  });
}

/**
 * v72→v73: drop the dead `projects.migration_status` column (#776, Architect
 * Ruling A485-776, Option 1 — Retire). Idempotent: only runs the `ALTER TABLE
 * ... DROP COLUMN` when the column is actually present, so a retry after a
 * partially-applied run (or a DB that already has no column because
 * `_createTables()` shipped without it) is a no-op. Refuses to let the
 * version advance if the column somehow survives, matching the postcondition
 * check `_migrateDropMethodology` uses for its own column drops.
 * @returns {void}
 */
function _migrateDropProjectsMigrationStatus() {
  const hasColumn = _db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'migration_status');
  if (hasColumn) {
    _db.exec('ALTER TABLE projects DROP COLUMN migration_status');
  }

  const cols = _db.prepare('PRAGMA table_info(projects)').all();
  if (cols.some((c) => c.name === 'migration_status')) {
    throw new Error(
      'v72→v73 migration did not drop projects.migration_status. Aborting — schema_version '
      + 'will NOT advance to 73 until this is resolved. See #776.'
    );
  }
}

/**
 * v73→v74: replace `medusa_exchange_facts_append_only_delete` so a store that
 * created the table before this version (always via the pre-#1879 shape of
 * {@link _medusaExchangeTablesDdl}) gets the conditional trigger too — a
 * fresh store already has it, since `_createTables()` runs the current DDL.
 * Drop-then-create rather than `IF NOT EXISTS`, because the old trigger
 * already exists under that name and `IF NOT EXISTS` would leave it alone.
 * Also adds retention's two partial indexes (`IF NOT EXISTS` is correct for
 * these — a pre-v74 store never had them under any name).
 * @returns {void}
 * @throws {Error} When the postcondition fails.
 */
function _migrateMedusaExchangeFactsRetentionTrigger() {
  _startupControlTransaction(() => {
    _db.exec(`
      DROP TRIGGER IF EXISTS medusa_exchange_facts_append_only_delete;
      CREATE TRIGGER medusa_exchange_facts_append_only_delete
        BEFORE DELETE ON medusa_exchange_facts
        WHEN NOT EXISTS (
          SELECT 1 FROM medusa_exchanges x
           WHERE x.exchange_id = OLD.exchange_id
             AND (x.terminal_at IS NOT NULL OR x.state = 'untracked')
        )
        BEGIN SELECT RAISE(ABORT, 'medusa_exchange_facts is append-only while its exchange is open'); END;

      CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_untracked_retention
        ON medusa_exchanges(created_at, exchange_id) WHERE state = 'untracked';
      CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_terminal_retention
        ON medusa_exchanges(recipient_project_id, terminal_at, exchange_id) WHERE terminal_at IS NOT NULL;
    `);
  });
  _verifyMedusaExchangeFactsRetentionTriggerV74();
}

/**
 * The v74 postcondition: the delete trigger exists, still raises ABORT, and
 * is conditioned on the parent exchange's terminal/untracked state — not the
 * unconditional pre-#1879 shape — and both retention indexes exist.
 * @returns {void}
 * @throws {Error} When the trigger is missing or still unconditional, or an index is missing.
 */
function _verifyMedusaExchangeFactsRetentionTriggerV74() {
  const refuse = (what) => {
    throw new Error(`v73→v74 left ${what}. Refusing to advance schema_version. See #1879.`);
  };
  const ddl = _tableDdl('medusa_exchange_facts_append_only_delete');
  if (!ddl) refuse('no medusa_exchange_facts_append_only_delete trigger');
  if (!/RAISE\s*\(\s*ABORT/i.test(ddl)) refuse('a delete trigger that does not raise ABORT');
  if (!/WHEN\s+NOT\s+EXISTS/i.test(ddl) || !/terminal_at/i.test(ddl)) {
    refuse('a delete trigger still unconditional (no terminal_at/untracked gate)');
  }
  for (const index of ['idx_medusa_exchanges_untracked_retention', 'idx_medusa_exchanges_terminal_retention']) {
    if (!_tableDdl(index)) refuse(`no ${index} index`);
  }
}

module.exports = {
  _bind,
  _createTables,
  _runMigrations,
  CURRENT_SCHEMA_VERSION,
  LAUNCH_ISOLATION_OVERRIDE_SCOPES,
  STARTUP_PROMPT_SEED,
  _startupPromptDigest,
  _startupPolicyDigest,
  STARTUP_FIRE_OUTCOMES,
  STARTUP_FIRE_ACTIVE,
  STARTUP_FIRE_REASON_CODES,
  STARTUP_FIRE_CALLER_KINDS,
  STARTUP_FIRE_CLEARANCES,
  STARTUP_DELIVERIES,
  STARTUP_FIRE_ACTIVE_SQL,
  STARTUP_FIRE_DISPATCH_NOTE_MAX,
  RECOVERY_BATCH_OUTCOMES,
  WORKLOAD_NUDGE_FACT_KINDS,
  WORKLOAD_NUDGE_ROUTES,
  HANDOFF_BASELINES,
  HANDOFF_BASELINE_VALUES,
  EPOCH_UNKNOWN_FROM_V41,
  LEASE_REACHES,
  LEASE_OWNER_KINDS,
  SHARED_DOC_EVENT_SOURCES,
  SHARED_DOC_NOTICE_SETTINGS,
  SHARED_DOC_DELIVERY_OUTCOMES
};
