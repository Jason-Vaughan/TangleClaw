'use strict';

/*
 * Storage shape for the Master-mediated operator bridge (ADR 0023, #2031).
 *
 * Kept apart from lib/store.js so the DDL and the proof of its shape are one
 * readable unit: `_createTables` and the migration both execute
 * `bridgeTablesDdl()`, and every startup runs `verifyBridgeSchema()`, so a
 * fresh install, an upgraded store and a store somebody edited by hand are all
 * held to the same shape.
 *
 * Nothing here touches `medusa_exchanges`. A message the bridge sends is an
 * ordinary tracked exchange; what makes it the bridge's is the proof row in
 * `bridge_route_proofs`, keyed to the exact route and Hub id.
 */

/** Closed state vocabulary of a route: one inbound operator message. */
const ROUTE_STATES = Object.freeze([
  'accepted', 'awaiting-master', 'queued-master-unavailable', 'routed',
  'reply-held', 'released', 'replied', 'closed'
]);

/** How a route's destination was resolved. */
const ROUTE_RESOLUTIONS = Object.freeze(['reply-inheritance', 'outbound-correlation', 'pin', 'alias', 'default', 'master']);

/**
 * Why the helper could not post an item, as it reports it. Closed: a report
 * with any other reason is refused.
 *
 * - `retryable`: the item stays waiting.
 * - `blocking`: this item alone is set aside until Master or the operator
 *   decides.
 * - `circuit`: the chat itself will not take posts (the channel or server is
 *   gone, the bot may not post, its token is refused). The item is set aside
 *   and the configuration circuit opens: nothing more is handed over until
 *   Master or the operator resets it.
 */
const FAILURE_REASONS = Object.freeze({
  retryable: Object.freeze(['transient', 'outcome-unknown']),
  blocking: Object.freeze(['rejected-by-chat', 'outcome-unverifiable', 'part-conflict']),
  circuit: Object.freeze(['chat-channel-missing', 'chat-guild-missing', 'chat-permission-denied', 'chat-auth-refused'])
});

/** Every reason an item may be set aside for. */
const BLOCK_CODES = Object.freeze([...FAILURE_REASONS.blocking, ...FAILURE_REASONS.circuit]);

/**
 * What may reach the chat: the four kinds of ADR 0023 Decision 8, and
 * `status`, the one fixed server-written notice Decision 17 allows for a route
 * that is still waiting. A `status` item is transport control, not content: it
 * carries no prose anybody wrote.
 *
 * `question` is what the Project Master asks the operator about a held
 * inbound, before anything is routed (Decision 9a). It is its own kind so that
 * nothing that reasons about a route's answer ever has to tell the two apart:
 * a delivered question closes no route and releases nothing.
 */
const OUTBOUND_KINDS = Object.freeze(['reply', 'notification', 'failure', 'candidate', 'status', 'question']);

/** Why a question is asked: to clear up where a message goes, or for consent to launch a stopped session. */
const QUESTION_PURPOSES = Object.freeze(['clarify', 'launch']);

/** How a question stands. Only `open` can be adopted; every other state is final and grants nothing more. */
const QUESTION_STATES = Object.freeze(['open', 'adopted', 'declined', 'cancelled', 'expired']);

/**
 * How a consented launch stands. `queued` waits its turn; `waiting-ready` is
 * the one launch in flight on the install; the rest are final.
 */
const LAUNCH_STATES = Object.freeze(['queued', 'waiting-ready', 'dispatched', 'failed', 'abandoned']);

/**
 * The typed server notifications (Decision 9). `lane-silent` is the one the
 * operator ruling of 2026-10-10 added: a lane whose expired workload report
 * drew no answer and has no coordinator to be told instead. `gateway-down` and
 * `gateway-recovered` are about the chat helper itself (#2272): it has had no
 * connection to Discord's Gateway for some minutes, so it posts and does not
 * hear, and later that it has one again.
 */
const NOTIFICATION_TYPES = Object.freeze(['operator-needed', 'work-blocked', 'fleet-idle', 'lane-silent', 'gateway-down', 'gateway-recovered']);

/**
 * Which Discord ingress surface a route or outbound item belongs to (#2433).
 * `guild-channel` is the original, single pinned channel; `bot-dm` is the
 * second, independently-enabled pinned DM channel from the same verified
 * author. A row predating this column's existence is `guild-channel`: that
 * was the only surface there was.
 */
const SURFACE_KINDS = Object.freeze(['guild-channel', 'bot-dm']);

/** What a verified session may submit to Master for consideration. */
const CANDIDATE_KINDS = Object.freeze(['milestone', 'operator-action-required']);

/** Longest operator message the gateway stores. */
const MAX_INBOUND_LENGTH = 8000;

/** Longest held reply or rendered outbound item. */
const MAX_OUTBOUND_LENGTH = 8000;

/**
 * Render a vocabulary as the body of a SQL `IN (...)` list.
 * @param {readonly string[]} values - Closed vocabulary.
 * @returns {string}
 */
function _inList(values) {
  return values.map((v) => `'${v}'`).join(',');
}

/**
 * DDL for every bridge table, in its final shape.
 *
 * Tables only; {@link bridgeIndexDdl} holds the indexes and triggers and
 * {@link createBridgeSchema} runs both in order. Idempotent (`IF NOT EXISTS`
 * throughout). Purely additive: a server that
 * predates the bridge ignores these tables, so the rows survive a rollback and
 * a re-upgrade.
 *
 * - `bridge_settings`: the operator's local switches. Absent `enabled` means off.
 * - `bridge_master_credentials`: verification material for the Master
 *   principal, one row per generation. The credential itself is never stored.
 * - `bridge_helper_tokens`: verification material for the chat helper's scoped
 *   token, hash only.
 * - `bridge_nonces`: request nonces already seen from the helper.
 * - `bridge_routes`: one row per inbound operator message, unique on the
 *   chat's own message id so a replay can never become a second message.
 *   `surface_kind` (#2433) names which pinned ingress surface it arrived on
 *   (`guild-channel` or `bot-dm`); fixed at acceptance, never changed by a
 *   later write.
 * - `bridge_route_bodies`: the text of a route, held apart so it can be
 *   cleared after delivery or close while the route record stays.
 * - `bridge_route_proofs`: which Hub message belongs to which route, and under
 *   what proof. A reply is the bridge's only if this table says so.
 * - `bridge_outbound`: what waits for the helper. Every row has its own
 *   idempotency key; `hub_id` is nullable because most kinds never had one.
 *   `surface_kind` (#2433) is the destination surface a route-bound item
 *   inherits from its route at enqueue time; a routeless item (a
 *   notification or candidate with no `route_id`) keeps the original
 *   `guild-channel` policy.
 * - `bridge_outbound_claims`, `bridge_outbound_leases`: each time the helper
 *   collected, and the lease each item was handed over under. An
 *   acknowledgement names its lease, so the store knows what a helper held
 *   and until when.
 * - `bridge_config_circuit`: each time the chat itself stopped taking posts.
 *   While an episode is open nothing is handed to the helper.
 * - `bridge_outbound_parts`: every message the chat confirmed, by the chat's
 *   own id, with the item it is a part of and what that item was. Kept after
 *   the item is removed, so a reply to any posted message can still be told
 *   apart from a message that answers nothing.
 * - `bridge_route_reply_context`: for an inbound message that answers a posted
 *   message, which one, fixed when the message is accepted.
 * - `bridge_candidates`, `bridge_candidate_receipts`: facts a session offers
 *   Master, each bound to the receipts it rests on by id and digest.
 * - `bridge_aliases`, `bridge_pins`: routing policy. Global entries are the
 *   operator's; Master may hold a conversation-scoped pin only.
 * - `bridge_audit`, `bridge_audit_anchor`: every bridge write. A row is never
 *   updated, and leaves only when a compaction moves the single anchor row
 *   past it; the anchor keeps a count and a chained digest of everything that
 *   has left, so what retention removes stays bounded and accounted for. A request id is unique per operation, which is what
 *   makes a repeated write return its first result.
 * @returns {string}
 */
function bridgeTablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS bridge_settings (
      key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 60),
      value      TEXT CHECK (value IS NULL OR length(value) <= 200),
      updated_by TEXT NOT NULL CHECK (updated_by IN ('operator')),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_master_credentials (
      generation      INTEGER PRIMARY KEY CHECK (generation >= 1),
      credential_hash TEXT    NOT NULL UNIQUE CHECK (length(credential_hash) = 64),
      status          TEXT    NOT NULL CHECK (status IN ('pending','active','revoked')),
      minted_at       TEXT    NOT NULL,
      delivered_at    TEXT,
      revoked_at      TEXT,
      revoke_reason   TEXT    CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 40),
      -- Retention works from these timestamps, so a terminal row always has one.
      CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_helper_tokens (
      token_id    TEXT PRIMARY KEY CHECK (length(token_id) BETWEEN 1 AND 64),
      token_hash  TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
      status      TEXT NOT NULL CHECK (status IN ('active','revoked')),
      created_by  TEXT NOT NULL CHECK (created_by IN ('operator')),
      created_at  TEXT NOT NULL,
      revoked_at  TEXT,
      -- A revoked token records when; an active one has no such time.
      CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_nonces (
      nonce   TEXT PRIMARY KEY CHECK (length(nonce) BETWEEN 16 AND 128),
      seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_routes (
      route_id                 TEXT    PRIMARY KEY CHECK (length(route_id) BETWEEN 1 AND 64),
      external_id              TEXT    NOT NULL UNIQUE CHECK (length(external_id) BETWEEN 1 AND 64),
      author_id                TEXT    NOT NULL CHECK (length(author_id) <= 64),
      space_id                 TEXT    NOT NULL CHECK (length(space_id) <= 64),
      channel_id               TEXT    NOT NULL CHECK (length(channel_id) <= 64),
      thread_id                TEXT    CHECK (thread_id IS NULL OR length(thread_id) <= 64),
      reply_to_external_id     TEXT    CHECK (reply_to_external_id IS NULL OR length(reply_to_external_id) <= 64),
      body_digest              TEXT    NOT NULL CHECK (length(body_digest) = 64),
      surface_kind             TEXT    NOT NULL DEFAULT 'guild-channel' CHECK (surface_kind IN (${_inList(SURFACE_KINDS)})),
      state                    TEXT    NOT NULL CHECK (state IN (${_inList(ROUTE_STATES)})),
      version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      resolved_by              TEXT    CHECK (resolved_by IS NULL OR resolved_by IN (${_inList(ROUTE_RESOLUTIONS)})),
      destination_kind         TEXT    CHECK (destination_kind IS NULL OR destination_kind IN ('master','project')),
      destination_project_id   INTEGER,
      destination_workspace_id TEXT    CHECK (destination_workspace_id IS NULL OR length(destination_workspace_id) <= 128),
      resolved_generation      INTEGER CHECK (resolved_generation IS NULL OR resolved_generation >= 1),
      pending_notice_at        TEXT,
      master_wake_at           TEXT,
      failure_code             TEXT    CHECK (failure_code IS NULL OR length(failure_code) <= 40),
      closed_by                TEXT    CHECK (closed_by IS NULL OR closed_by IN ('gateway','master','operator')),
      created_at               TEXT    NOT NULL,
      updated_at               TEXT    NOT NULL,
      closed_at                TEXT,
      CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
      -- A destination is either wholly absent, workspace and generation
      -- included, or wholly named, and a project destination names its project.
      CHECK (
        (resolved_by IS NULL AND destination_kind IS NULL AND destination_project_id IS NULL
          AND destination_workspace_id IS NULL AND resolved_generation IS NULL)
        OR (resolved_by IS NOT NULL AND destination_kind = 'master' AND destination_project_id IS NULL)
        OR (resolved_by IS NOT NULL AND destination_kind = 'project' AND destination_project_id IS NOT NULL)
      ),
      -- A decision by the Master session names the generation that made it; a
      -- mechanical resolution was made by no generation and names none.
      CHECK (resolved_by IS NULL OR (resolved_by = 'master') = (resolved_generation IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_route_bodies (
      body_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id   TEXT    NOT NULL CHECK (length(route_id) <= 64),
      role       TEXT    NOT NULL CHECK (role IN ('inbound','reply','answer')),
      text       TEXT    CHECK (text IS NULL OR length(text) <= ${Math.max(MAX_INBOUND_LENGTH, MAX_OUTBOUND_LENGTH)}),
      digest     TEXT    NOT NULL CHECK (length(digest) = 64),
      created_at TEXT    NOT NULL,
      cleared_at TEXT,
      -- Cleared means the text is gone and the time it went is recorded.
      CHECK ((text IS NULL) = (cleared_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_route_proofs (
      proof_id            INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id            TEXT    NOT NULL CHECK (length(route_id) <= 64),
      direction           TEXT    NOT NULL CHECK (direction IN ('to-target','from-target')),
      hub_id              TEXT    NOT NULL CHECK (length(hub_id) BETWEEN 1 AND 128),
      exchange_id         TEXT    CHECK (exchange_id IS NULL OR length(exchange_id) <= 64),
      in_reply_to_hub_id  TEXT    CHECK (in_reply_to_hub_id IS NULL OR length(in_reply_to_hub_id) <= 128),
      sender_proof        TEXT    NOT NULL CHECK (sender_proof IN ('master-launch','gateway','launch')),
      master_generation   INTEGER CHECK (master_generation IS NULL OR master_generation >= 1),
      sender_project_id   INTEGER,
      sender_launch_id    TEXT    CHECK (sender_launch_id IS NULL OR length(sender_launch_id) <= 128),
      target_project_id   INTEGER,
      target_workspace_id TEXT    CHECK (target_workspace_id IS NULL OR length(target_workspace_id) <= 128),
      target_session_id   INTEGER,
      target_launch_id    TEXT    CHECK (target_launch_id IS NULL OR length(target_launch_id) <= 128),
      recorded_at         TEXT    NOT NULL,
      -- A message the bridge sent names exactly who it was sent to: the
      -- project, the workspace, the session and that session's launch. Only
      -- that one may answer it.
      CHECK (direction <> 'to-target'
        OR (target_project_id IS NOT NULL AND target_workspace_id IS NOT NULL
            AND target_session_id IS NOT NULL AND target_launch_id IS NOT NULL)),
      -- Master's proof always names the generation it was given under; a
      -- target's reply always names the launch and project that sent it and
      -- the bridge message it answers.
      CHECK (sender_proof <> 'master-launch' OR master_generation IS NOT NULL),
      CHECK (direction <> 'from-target'
        OR (sender_proof = 'launch' AND sender_project_id IS NOT NULL
            AND sender_launch_id IS NOT NULL AND in_reply_to_hub_id IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_outbound (
      outbound_id         INTEGER PRIMARY KEY AUTOINCREMENT,
      idem_key            TEXT    NOT NULL UNIQUE CHECK (length(idem_key) BETWEEN 1 AND 160),
      kind                TEXT    NOT NULL CHECK (kind IN (${_inList(OUTBOUND_KINDS)})),
      notify_type         TEXT    CHECK (notify_type IS NULL OR notify_type IN (${_inList(NOTIFICATION_TYPES)})),
      route_id            TEXT    CHECK (route_id IS NULL OR length(route_id) <= 64),
      candidate_id        TEXT    CHECK (candidate_id IS NULL OR length(candidate_id) <= 64),
      question_id         TEXT    CHECK (question_id IS NULL OR length(question_id) <= 64),
      hub_id              TEXT    CHECK (hub_id IS NULL OR length(hub_id) <= 128),
      surface_kind        TEXT    NOT NULL DEFAULT 'guild-channel' CHECK (surface_kind IN (${_inList(SURFACE_KINDS)})),
      source_label        TEXT    NOT NULL CHECK (length(source_label) BETWEEN 1 AND 80),
      text                TEXT    CHECK (text IS NULL OR length(text) <= ${MAX_OUTBOUND_LENGTH}),
      digest              TEXT    NOT NULL CHECK (length(digest) = 64),
      state               TEXT    NOT NULL CHECK (state IN ('ready','blocked','delivered','dropped')),
      drop_code           TEXT    CHECK (drop_code IS NULL OR length(drop_code) <= 40),
      block_code          TEXT    CHECK (block_code IS NULL OR block_code IN (${_inList(BLOCK_CODES)})),
      attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      delivered_ref       TEXT    CHECK (delivered_ref IS NULL OR length(delivered_ref) <= 64),
      released_generation INTEGER CHECK (released_generation IS NULL OR released_generation >= 1),
      created_at          TEXT    NOT NULL,
      updated_at          TEXT    NOT NULL,
      delivered_at        TEXT,
      CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
      -- An item set aside says why; no other item carries a reason.
      CHECK ((state = 'blocked') = (block_code IS NOT NULL)),
      -- Each kind carries exactly the references that make it that kind.
      CHECK (
        (kind = 'reply' AND route_id IS NOT NULL AND released_generation IS NOT NULL
          AND notify_type IS NULL AND candidate_id IS NULL)
        OR (kind = 'notification' AND notify_type IS NOT NULL AND candidate_id IS NULL)
        OR (kind = 'failure' AND route_id IS NOT NULL AND notify_type IS NULL AND candidate_id IS NULL)
        OR (kind = 'status' AND route_id IS NOT NULL AND notify_type IS NULL AND candidate_id IS NULL
          AND released_generation IS NULL)
        OR (kind = 'candidate' AND candidate_id IS NOT NULL AND released_generation IS NOT NULL
          AND notify_type IS NULL)
        OR (kind = 'question' AND route_id IS NOT NULL AND released_generation IS NOT NULL
          AND notify_type IS NULL AND candidate_id IS NULL)
      ),
      -- A question names the question it asks, and nothing else names one.
      CHECK ((kind = 'question') = (question_id IS NOT NULL))
    );

    -- One row each time the helper is handed an item: who it was handed to,
    -- when, and until when an acknowledgement for it will be believed.
    CREATE TABLE IF NOT EXISTS bridge_outbound_claims (
      claim_nonce    TEXT PRIMARY KEY CHECK (length(claim_nonce) BETWEEN 16 AND 128),
      token_id       TEXT NOT NULL CHECK (length(token_id) BETWEEN 1 AND 64),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      claimed_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_outbound_leases (
      lease_id     TEXT    PRIMARY KEY CHECK (length(lease_id) BETWEEN 16 AND 64),
      claim_nonce  TEXT    NOT NULL CHECK (length(claim_nonce) BETWEEN 16 AND 128),
      outbound_id  INTEGER NOT NULL,
      item_digest  TEXT    NOT NULL CHECK (length(item_digest) = 64),
      token_id     TEXT    NOT NULL CHECK (length(token_id) BETWEEN 1 AND 64),
      state        TEXT    NOT NULL CHECK (state IN ('live','used','lapsed')),
      issued_at    TEXT    NOT NULL,
      expires_at   TEXT    NOT NULL,
      settled_at   TEXT,
      CHECK (expires_at > issued_at),
      CHECK ((state = 'live') = (settled_at IS NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_config_circuit (
      episode_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      reason       TEXT    NOT NULL CHECK (reason IN (${_inList(FAILURE_REASONS.circuit)})),
      outbound_id  INTEGER NOT NULL,
      opened_at    TEXT    NOT NULL,
      closed_at    TEXT,
      closed_by    TEXT    CHECK (closed_by IS NULL OR closed_by IN ('master','operator')),
      decision     TEXT    CHECK (decision IS NULL OR decision IN ('requeue','withdraw')),
      -- When the Project Master was last told of the episode and which of its
      -- generations was live then, and when it said it had taken it up, under
      -- which generation. What a Master was told or knows leaves with it: a
      -- later generation is told afresh and acknowledges for itself, and only
      -- a later one can replace an acknowledgement.
      master_told_at          TEXT,
      master_told_generation  INTEGER,
      master_acked_at         TEXT,
      master_acked_generation INTEGER,
      CHECK ((master_acked_at IS NULL) = (master_acked_generation IS NULL)),
      -- An episode is open, or it records who closed it and what they decided.
      CHECK ((closed_at IS NULL) = (closed_by IS NULL) AND (closed_at IS NULL) = (decision IS NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_outbound_parts (
      part_external_id TEXT    PRIMARY KEY CHECK (length(part_external_id) BETWEEN 1 AND 64),
      outbound_id      INTEGER NOT NULL,
      part_index       INTEGER NOT NULL CHECK (part_index >= 0),
      part_count       INTEGER NOT NULL CHECK (part_count >= 1 AND part_index < part_count),
      kind             TEXT    NOT NULL CHECK (kind IN (${_inList(OUTBOUND_KINDS)})),
      notify_type      TEXT    CHECK (notify_type IS NULL OR length(notify_type) <= 64),
      route_id         TEXT    CHECK (route_id IS NULL OR length(route_id) <= 64),
      candidate_id     TEXT    CHECK (candidate_id IS NULL OR length(candidate_id) <= 64),
      candidate_kind   TEXT    CHECK (candidate_kind IS NULL OR length(candidate_kind) <= 64),
      question_id      TEXT    CHECK (question_id IS NULL OR length(question_id) <= 64),
      delivered_at     TEXT    NOT NULL,
      UNIQUE (outbound_id, part_index)
    );

    CREATE TABLE IF NOT EXISTS bridge_route_reply_context (
      route_id              TEXT    PRIMARY KEY CHECK (length(route_id) BETWEEN 1 AND 64),
      replied_external_id   TEXT    NOT NULL CHECK (length(replied_external_id) BETWEEN 1 AND 64),
      canonical_external_id TEXT    NOT NULL CHECK (length(canonical_external_id) BETWEEN 1 AND 64),
      outbound_id           INTEGER NOT NULL,
      part_index            INTEGER NOT NULL CHECK (part_index >= 0),
      part_count            INTEGER NOT NULL CHECK (part_count >= 1 AND part_index < part_count),
      kind                  TEXT    NOT NULL CHECK (kind IN (${_inList(OUTBOUND_KINDS)})),
      notify_type           TEXT,
      replied_route_id      TEXT,
      candidate_id          TEXT,
      candidate_kind        TEXT,
      question_id           TEXT,
      created_at            TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_candidates (
      candidate_id      TEXT    PRIMARY KEY CHECK (length(candidate_id) BETWEEN 1 AND 64),
      idem_key          TEXT    NOT NULL UNIQUE CHECK (length(idem_key) BETWEEN 1 AND 160),
      kind              TEXT    NOT NULL CHECK (kind IN (${_inList(CANDIDATE_KINDS)})),
      source_project_id INTEGER NOT NULL,
      source_launch_id  TEXT    NOT NULL CHECK (length(source_launch_id) <= 128),
      text              TEXT    CHECK (text IS NULL OR length(text) <= ${MAX_OUTBOUND_LENGTH}),
      digest            TEXT    NOT NULL CHECK (length(digest) = 64),
      state             TEXT    NOT NULL CHECK (state IN ('submitted','approved','rejected','merged')),
      version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      decided_generation INTEGER CHECK (decided_generation IS NULL OR decided_generation >= 1),
      created_at        TEXT    NOT NULL,
      decided_at        TEXT,
      CHECK ((state = 'submitted') = (decided_at IS NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_candidate_receipts (
      candidate_id   TEXT NOT NULL CHECK (length(candidate_id) BETWEEN 1 AND 64),
      receipt_kind   TEXT NOT NULL CHECK (length(receipt_kind) BETWEEN 1 AND 40),
      receipt_id     TEXT NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 128),
      receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
      PRIMARY KEY (candidate_id, receipt_kind, receipt_id)
    );

    CREATE TABLE IF NOT EXISTS bridge_aliases (
      alias                  TEXT    PRIMARY KEY CHECK (length(alias) BETWEEN 1 AND 64),
      destination_kind       TEXT    NOT NULL CHECK (destination_kind IN ('master','project')),
      destination_project_id INTEGER,
      created_by             TEXT    NOT NULL CHECK (created_by IN ('operator','master')),
      created_at             TEXT    NOT NULL,
      -- Who last wrote the nickname and when, the operator message that
      -- authorised it when the Project Master wrote it, and the nickname as
      -- the operator typed it. A row from before these existed has none.
      changed_by             TEXT    CHECK (changed_by IS NULL OR changed_by IN ('operator','master')),
      changed_at             TEXT,
      confirmed_route_id     TEXT    CHECK (confirmed_route_id IS NULL OR length(confirmed_route_id) <= 64),
      display                TEXT    CHECK (display IS NULL OR length(display) BETWEEN 1 AND 64),
      CHECK ((destination_kind = 'project') = (destination_project_id IS NOT NULL)),
      CHECK ((changed_by IS NULL) = (changed_at IS NULL)),
      -- The Master stores a nickname only with an operator message behind it.
      CHECK (changed_by IS NOT 'master' OR confirmed_route_id IS NOT NULL)
    );

    -- What the Project Master asked the operator about a held inbound. The
    -- posted text is an outbound item of kind 'question'; this row is the
    -- question's standing. A reply is usable for it only while it is open.
    CREATE TABLE IF NOT EXISTS bridge_questions (
      question_id       TEXT    PRIMARY KEY CHECK (length(question_id) BETWEEN 1 AND 64),
      route_id          TEXT    NOT NULL CHECK (length(route_id) BETWEEN 1 AND 64),
      purpose           TEXT    NOT NULL CHECK (purpose IN (${_inList(QUESTION_PURPOSES)})),
      target_project_id INTEGER,
      state             TEXT    NOT NULL CHECK (state IN (${_inList(QUESTION_STATES)})),
      asked_generation  INTEGER NOT NULL CHECK (asked_generation >= 1),
      asked_at          TEXT    NOT NULL,
      expires_at        TEXT    NOT NULL,
      adopted_route_id  TEXT    CHECK (adopted_route_id IS NULL OR length(adopted_route_id) <= 64),
      adopted_for       TEXT    CHECK (adopted_for IS NULL OR adopted_for IN ('route','launch','decline','nickname')),
      settled_at        TEXT,
      CHECK (expires_at > asked_at),
      -- Consent to launch names the project; a clarifying question names none.
      CHECK ((purpose = 'launch') = (target_project_id IS NOT NULL)),
      CHECK ((state = 'open') = (settled_at IS NULL)),
      -- Adopted or declined on exactly one operator reply; no other ending has one.
      CHECK ((state IN ('adopted','declined')) = (adopted_route_id IS NOT NULL)),
      CHECK ((adopted_route_id IS NULL) = (adopted_for IS NULL)),
      CHECK (state <> 'declined' OR adopted_for = 'decline')
    );

    -- A launch the operator consented to, for one held inbound. The server
    -- starts the session; this row is the durable record that makes it happen
    -- at most once, in the order consent was adopted.
    CREATE TABLE IF NOT EXISTS bridge_launches (
      launch_seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id          TEXT    NOT NULL CHECK (length(route_id) BETWEEN 1 AND 64),
      question_id       TEXT    NOT NULL UNIQUE CHECK (length(question_id) BETWEEN 1 AND 64),
      consent_route_id  TEXT    NOT NULL UNIQUE CHECK (length(consent_route_id) BETWEEN 1 AND 64),
      project_id        INTEGER NOT NULL,
      master_generation INTEGER NOT NULL CHECK (master_generation >= 1),
      state             TEXT    NOT NULL CHECK (state IN (${_inList(LAUNCH_STATES)})),
      session_id        INTEGER,
      launch_id         TEXT    CHECK (launch_id IS NULL OR length(launch_id) <= 128),
      started_session   INTEGER CHECK (started_session IS NULL OR started_session IN (0, 1)),
      failure_code      TEXT    CHECK (failure_code IS NULL OR length(failure_code) <= 64),
      requested_at      TEXT    NOT NULL,
      started_at        TEXT,
      settled_at        TEXT,
      CHECK ((state IN ('dispatched','failed','abandoned')) = (settled_at IS NOT NULL)),
      CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
      -- Queued, it has no session yet. Past that it names the one it waits for.
      CHECK ((state = 'queued') = (started_at IS NULL) OR state IN ('failed','abandoned')),
      CHECK (state NOT IN ('waiting-ready','dispatched')
        OR (session_id IS NOT NULL AND launch_id IS NOT NULL AND started_session IS NOT NULL))
    );

    -- Projects the operator has taken out of reach of the bridge. Policy: the
    -- signed-in operator's alone.
    CREATE TABLE IF NOT EXISTS bridge_project_optouts (
      project_id INTEGER PRIMARY KEY,
      set_by     TEXT    NOT NULL CHECK (set_by IN ('operator')),
      set_at     TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_pins (
      pin_id                 TEXT    PRIMARY KEY CHECK (length(pin_id) BETWEEN 1 AND 64),
      scope                  TEXT    NOT NULL CHECK (scope IN ('global','conversation')),
      conversation_key       TEXT    CHECK (conversation_key IS NULL OR length(conversation_key) <= 160),
      destination_kind       TEXT    NOT NULL CHECK (destination_kind IN ('master','project')),
      destination_project_id INTEGER,
      created_by             TEXT    NOT NULL CHECK (created_by IN ('operator','master')),
      master_generation      INTEGER CHECK (master_generation IS NULL OR master_generation >= 1),
      created_at             TEXT    NOT NULL,
      revoked_at             TEXT,
      CHECK ((destination_kind = 'project') = (destination_project_id IS NOT NULL)),
      -- A conversation pin always names its conversation. A global pin may
      -- name one, or none, which means every conversation.
      CHECK (scope <> 'conversation' OR conversation_key IS NOT NULL),
      -- A global pin is the operator's alone; Master's pin names its generation.
      CHECK (scope <> 'global' OR created_by = 'operator'),
      CHECK ((created_by = 'master') = (master_generation IS NOT NULL))
    );

    -- One row, always. It is everything that remains of the audit rows
    -- retention has removed: how far the removal reached, how many rows have
    -- left in total, and a digest chained across every removal.
    CREATE TABLE IF NOT EXISTS bridge_audit_anchor (
      anchor_id     INTEGER PRIMARY KEY CHECK (anchor_id = 1),
      through_seq   INTEGER NOT NULL CHECK (through_seq >= 0),
      removed_count INTEGER NOT NULL CHECK (removed_count >= 0),
      compactions   INTEGER NOT NULL CHECK (compactions >= 0),
      chain_digest  TEXT    CHECK (chain_digest IS NULL OR length(chain_digest) = 64),
      updated_at    TEXT    NOT NULL,
      CHECK ((compactions = 0) = (chain_digest IS NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_audit (
      -- AUTOINCREMENT, so a sequence a compaction removed is never issued again.
      audit_seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      op                TEXT    NOT NULL CHECK (length(op) BETWEEN 1 AND 40),
      request_id        TEXT    CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 128),
      actor             TEXT    NOT NULL CHECK (actor IN ('master','operator','helper','gateway','session')),
      proof             TEXT    NOT NULL CHECK (length(proof) BETWEEN 1 AND 40),
      master_generation INTEGER CHECK (master_generation IS NULL OR master_generation >= 1),
      route_id          TEXT    CHECK (route_id IS NULL OR length(route_id) <= 64),
      expected_version  INTEGER,
      outcome           TEXT    NOT NULL CHECK (length(outcome) BETWEEN 1 AND 40),
      detail_json       TEXT    CHECK (detail_json IS NULL OR length(detail_json) <= 2048),
      at                TEXT    NOT NULL,
      CHECK (actor <> 'master' OR master_generation IS NOT NULL)
    );
  `;
}

/**
 * DDL for the bridge's indexes and triggers. Separate from the tables because
 * each names columns a table of the wrong shape lacks: created only once the
 * tables' shapes are proven, so a misshapen table is refused by name rather
 * than by whichever column SQLite trips on first.
 * @returns {string}
 */
function bridgeIndexDdl() {
  return `
    CREATE INDEX IF NOT EXISTS idx_bridge_route_proofs_route ON bridge_route_proofs(route_id, proof_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_pins_conversation
      ON bridge_pins(conversation_key) WHERE scope = 'conversation' AND revoked_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_bridge_audit_route ON bridge_audit(route_id, audit_seq);

    -- One slot, not one per status: a pending and an active generation at
    -- once would be two live credentials.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_master_credentials_live
      ON bridge_master_credentials((1)) WHERE status IN ('pending','active');

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_helper_tokens_active
      ON bridge_helper_tokens(status) WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_bridge_nonces_seen ON bridge_nonces(seen_at);

    CREATE INDEX IF NOT EXISTS idx_bridge_routes_state ON bridge_routes(state, created_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_route_bodies_role ON bridge_route_bodies(route_id, role);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_route_proofs_hub ON bridge_route_proofs(hub_id);

    CREATE INDEX IF NOT EXISTS idx_bridge_outbound_state ON bridge_outbound(state, outbound_id);

    CREATE INDEX IF NOT EXISTS idx_bridge_candidates_state ON bridge_candidates(state, created_at);

    -- One active pin per scope and conversation; the operator may hold many
    -- global pins, one for each conversation and one for all of them.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_pins_global
      ON bridge_pins(COALESCE(conversation_key, '*')) WHERE scope = 'global' AND revoked_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_audit_request
      ON bridge_audit(op, request_id) WHERE request_id IS NOT NULL;

    -- A row can leave only once the anchor has been moved past it, which the
    -- compaction does in the same transaction, digest included.
    CREATE TRIGGER IF NOT EXISTS bridge_audit_append_only_delete
      BEFORE DELETE ON bridge_audit
      WHEN NOT EXISTS (SELECT 1 FROM bridge_audit_anchor WHERE through_seq >= OLD.audit_seq)
      BEGIN SELECT RAISE(ABORT, 'bridge_audit is append-only'); END;

    -- The anchor only moves forward, and is never removed.
    CREATE TRIGGER IF NOT EXISTS bridge_audit_anchor_forward_only
      BEFORE UPDATE ON bridge_audit_anchor
      WHEN NEW.anchor_id <> OLD.anchor_id OR NEW.through_seq <= OLD.through_seq
        OR NEW.removed_count <= OLD.removed_count OR NEW.compactions <> OLD.compactions + 1
      BEGIN SELECT RAISE(ABORT, 'bridge_audit_anchor only moves forward'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_audit_anchor_permanent
      BEFORE DELETE ON bridge_audit_anchor
      BEGIN SELECT RAISE(ABORT, 'bridge_audit_anchor is permanent'); END;

    -- Integrity the store enforces without foreign keys, which this database
    -- does not run with: a child row needs its parent, and a route that is
    -- removed takes its bodies, proofs and outbound items with it.
    CREATE TRIGGER IF NOT EXISTS bridge_route_bodies_need_route
      BEFORE INSERT ON bridge_route_bodies
      WHEN NOT EXISTS (SELECT 1 FROM bridge_routes WHERE route_id = NEW.route_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_route_bodies needs its route'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_route_proofs_need_route
      BEFORE INSERT ON bridge_route_proofs
      WHEN NOT EXISTS (SELECT 1 FROM bridge_routes WHERE route_id = NEW.route_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_route_proofs needs its route'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_outbound_needs_parents
      BEFORE INSERT ON bridge_outbound
      WHEN (NEW.route_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bridge_routes WHERE route_id = NEW.route_id))
        OR (NEW.candidate_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bridge_candidates WHERE candidate_id = NEW.candidate_id))
      BEGIN SELECT RAISE(ABORT, 'bridge_outbound needs its route or candidate'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_candidates_need_project
      BEFORE INSERT ON bridge_candidates
      WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.source_project_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_candidates needs its source project'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_candidate_receipts_need_candidate
      BEFORE INSERT ON bridge_candidate_receipts
      WHEN NOT EXISTS (SELECT 1 FROM bridge_candidates WHERE candidate_id = NEW.candidate_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_candidate_receipts needs its candidate'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_candidate_receipts_immutable
      BEFORE UPDATE ON bridge_candidate_receipts
      BEGIN SELECT RAISE(ABORT, 'bridge_candidate_receipts is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_routes_delete_children
      AFTER DELETE ON bridge_routes
      BEGIN
        DELETE FROM bridge_route_bodies WHERE route_id = OLD.route_id;
        DELETE FROM bridge_route_proofs WHERE route_id = OLD.route_id;
        DELETE FROM bridge_outbound WHERE route_id = OLD.route_id;
      END;

    CREATE TRIGGER IF NOT EXISTS bridge_candidates_delete_children
      AFTER DELETE ON bridge_candidates
      BEGIN
        DELETE FROM bridge_candidate_receipts WHERE candidate_id = OLD.candidate_id;
        DELETE FROM bridge_outbound WHERE candidate_id = OLD.candidate_id;
      END;

    CREATE TRIGGER IF NOT EXISTS bridge_questions_need_route
      BEFORE INSERT ON bridge_questions
      WHEN NOT EXISTS (SELECT 1 FROM bridge_routes WHERE route_id = NEW.route_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_questions needs its route'); END;

    -- A question is settled once. What it asked, of whom, and until when never
    -- change, and a settled question is never opened or re-settled.
    CREATE TRIGGER IF NOT EXISTS bridge_questions_fixed
      BEFORE UPDATE ON bridge_questions
      WHEN OLD.state <> 'open' OR NEW.question_id <> OLD.question_id OR NEW.route_id <> OLD.route_id
        OR NEW.purpose <> OLD.purpose OR NEW.target_project_id IS NOT OLD.target_project_id
        OR NEW.asked_generation <> OLD.asked_generation OR NEW.asked_at <> OLD.asked_at
        OR NEW.expires_at <> OLD.expires_at
      BEGIN SELECT RAISE(ABORT, 'bridge_questions: a question is settled once and is otherwise fixed'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_launches_need_consent
      BEFORE INSERT ON bridge_launches
      WHEN NOT EXISTS (
        SELECT 1 FROM bridge_questions
         WHERE question_id = NEW.question_id AND route_id = NEW.route_id AND purpose = 'launch'
           AND target_project_id = NEW.project_id AND state = 'adopted' AND adopted_for = 'launch'
           AND adopted_route_id = NEW.consent_route_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_launches needs an adopted launch consent for this route and project'); END;

    -- What was consented to never changes, and a settled launch is final.
    CREATE TRIGGER IF NOT EXISTS bridge_launches_fixed
      BEFORE UPDATE ON bridge_launches
      WHEN OLD.settled_at IS NOT NULL OR NEW.launch_seq <> OLD.launch_seq OR NEW.route_id <> OLD.route_id
        OR NEW.question_id <> OLD.question_id OR NEW.consent_route_id <> OLD.consent_route_id
        OR NEW.project_id <> OLD.project_id OR NEW.master_generation <> OLD.master_generation
        OR NEW.requested_at <> OLD.requested_at
      BEGIN SELECT RAISE(ABORT, 'bridge_launches: a consent is fixed and a settled launch is final'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_routes_delete_questions
      AFTER DELETE ON bridge_routes
      BEGIN DELETE FROM bridge_questions WHERE route_id = OLD.route_id; END;

    CREATE TRIGGER IF NOT EXISTS bridge_routes_delete_launches
      AFTER DELETE ON bridge_routes
      BEGIN DELETE FROM bridge_launches WHERE route_id = OLD.route_id; END;

    -- One open question per held inbound, and one use of an operator reply.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_questions_open
      ON bridge_questions(route_id) WHERE state = 'open';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_questions_adopted
      ON bridge_questions(adopted_route_id) WHERE adopted_route_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_bridge_questions_expiry ON bridge_questions(state, expires_at);

    -- One unsettled launch per held inbound, and one launch in flight on the install.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_launches_route
      ON bridge_launches(route_id) WHERE settled_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_launches_in_flight
      ON bridge_launches((1)) WHERE state = 'waiting-ready';

    -- One status item per route, ever: the single still-waiting notice.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_outbound_status
      ON bridge_outbound(route_id) WHERE kind = 'status';

    -- A proof is a record of what was sent and by whom. It is never changed;
    -- it leaves only with its route.
    CREATE TRIGGER IF NOT EXISTS bridge_route_proofs_immutable
      BEFORE UPDATE ON bridge_route_proofs
      BEGIN SELECT RAISE(ABORT, 'bridge_route_proofs is immutable'); END;

    -- One live lease per item: an item is in one helper's hands at a time.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_outbound_leases_live
      ON bridge_outbound_leases(outbound_id) WHERE state = 'live';

    CREATE INDEX IF NOT EXISTS idx_bridge_outbound_leases_settled ON bridge_outbound_leases(state, settled_at);

    CREATE INDEX IF NOT EXISTS idx_bridge_outbound_leases_claim ON bridge_outbound_leases(claim_nonce);

    CREATE TRIGGER IF NOT EXISTS bridge_outbound_leases_need_claim
      BEFORE INSERT ON bridge_outbound_leases
      WHEN NOT EXISTS (SELECT 1 FROM bridge_outbound_claims WHERE claim_nonce = NEW.claim_nonce AND token_id = NEW.token_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_outbound_leases needs the claim it was issued under'); END;

    -- A claim is a record of what was asked and by which token; it never changes.
    CREATE TRIGGER IF NOT EXISTS bridge_outbound_claims_fixed
      BEFORE UPDATE ON bridge_outbound_claims
      BEGIN SELECT RAISE(ABORT, 'bridge_outbound_claims is fixed once recorded'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_outbound_leases_need_item
      BEFORE INSERT ON bridge_outbound_leases
      WHEN NOT EXISTS (SELECT 1 FROM bridge_outbound WHERE outbound_id = NEW.outbound_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_outbound_leases needs its item'); END;

    -- What a lease was issued for never changes; only its state settles.
    CREATE TRIGGER IF NOT EXISTS bridge_outbound_leases_fixed
      BEFORE UPDATE ON bridge_outbound_leases
      WHEN NEW.lease_id <> OLD.lease_id OR NEW.claim_nonce <> OLD.claim_nonce OR NEW.outbound_id <> OLD.outbound_id
        OR NEW.item_digest <> OLD.item_digest
        OR NEW.token_id <> OLD.token_id OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at
        OR OLD.state <> 'live'
      BEGIN SELECT RAISE(ABORT, 'bridge_outbound_leases is fixed once issued, and final once settled'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_outbound_delete_leases
      AFTER DELETE ON bridge_outbound
      BEGIN DELETE FROM bridge_outbound_leases WHERE outbound_id = OLD.outbound_id; END;

    -- At most one episode is open. Two reports of the same broken channel
    -- cannot open two, whatever order they arrive in.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_config_circuit_open
      ON bridge_config_circuit((closed_at IS NULL)) WHERE closed_at IS NULL;

    -- An episode's facts are fixed; it changes once, when it is closed.
    CREATE TRIGGER IF NOT EXISTS bridge_config_circuit_fixed
      BEFORE UPDATE ON bridge_config_circuit
      WHEN NEW.episode_id <> OLD.episode_id OR NEW.reason <> OLD.reason OR NEW.outbound_id <> OLD.outbound_id
        OR NEW.opened_at <> OLD.opened_at OR OLD.closed_at IS NOT NULL
        OR (OLD.master_acked_generation IS NOT NULL
            AND (NEW.master_acked_generation IS NULL OR NEW.master_acked_generation < OLD.master_acked_generation
                 OR (NEW.master_acked_generation = OLD.master_acked_generation AND NEW.master_acked_at IS NOT OLD.master_acked_at)))
      BEGIN SELECT RAISE(ABORT, 'bridge_config_circuit is fixed once opened, and final once closed'); END;

    CREATE INDEX IF NOT EXISTS idx_bridge_outbound_parts_item ON bridge_outbound_parts(outbound_id, part_index);

    CREATE TRIGGER IF NOT EXISTS bridge_outbound_parts_need_item
      BEFORE INSERT ON bridge_outbound_parts
      WHEN NOT EXISTS (SELECT 1 FROM bridge_outbound WHERE outbound_id = NEW.outbound_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_outbound_parts needs its item'); END;

    -- Which posted message belongs to which item is a fact; it is never
    -- rewritten. The rows outlive their item: a reply to a posted message can
    -- arrive long after the item itself has been removed.
    CREATE TRIGGER IF NOT EXISTS bridge_outbound_parts_immutable
      BEFORE UPDATE ON bridge_outbound_parts
      BEGIN SELECT RAISE(ABORT, 'bridge_outbound_parts is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_route_reply_context_need_route
      BEFORE INSERT ON bridge_route_reply_context
      WHEN NOT EXISTS (SELECT 1 FROM bridge_routes WHERE route_id = NEW.route_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_route_reply_context needs its route'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_route_reply_context_immutable
      BEFORE UPDATE ON bridge_route_reply_context
      BEGIN SELECT RAISE(ABORT, 'bridge_route_reply_context is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS bridge_routes_delete_reply_context
      AFTER DELETE ON bridge_routes
      BEGIN DELETE FROM bridge_route_reply_context WHERE route_id = OLD.route_id; END;

    CREATE TRIGGER IF NOT EXISTS bridge_audit_append_only_update
      BEFORE UPDATE ON bridge_audit
      BEGIN SELECT RAISE(ABORT, 'bridge_audit is append-only'); END;
  `;
}

/**
 * Every object the bridge needs, with the fragments its SQL must contain. A
 * name alone is not proof: a table of the right name and the wrong shape is
 * exactly what a half-applied or hand-edited store looks like.
 *
 * `needs` is what schema v52 required and still requires. `needsSince53`,
 * `needsSince54`, `needsSince62`, `needsSince63` and `since: N` mark what each
 * later version added. The numbers are the store's schema versions: the store
 * moved from 55 to 61 without touching the bridge, so the bridge's own run skips them. Keeping
 * them apart is what lets each migration prove it was handed a sound store of
 * the version before, and lets a test prove that a server from before a
 * version still accepts that version's store: each later shape is a superset
 * of the earlier ones.
 */
const BRIDGE_SCHEMA_OBJECTS = Object.freeze([
  { type: 'table', name: 'bridge_settings', needs: [/updated_by/] },
  { type: 'table', name: 'bridge_master_credentials', needs: [/credential_hash[^,]*UNIQUE/, /'pending','active','revoked'/, /\(status = 'revoked'\) = \(revoked_at IS NOT NULL\)/] },
  { type: 'index', name: 'idx_bridge_master_credentials_live', needs: [/UNIQUE/i, /\(\(1\)\)/, /WHERE/i] },
  { type: 'table', name: 'bridge_helper_tokens', needs: [/token_hash[^,]*UNIQUE/], needsSince54: [/\(status = 'revoked'\) = \(revoked_at IS NOT NULL\)/] },
  { type: 'table', name: 'bridge_outbound_claims', since: 54, needs: [/claim_nonce\s+TEXT PRIMARY KEY/, /request_digest/, /token_id/] },
  { type: 'trigger', name: 'bridge_outbound_claims_fixed', since: 54, needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_outbound_leases_need_claim', since: 54, needs: [/RAISE\(ABORT/, /token_id = NEW\.token_id/] },
  { type: 'table', name: 'bridge_outbound_leases', since: 54, needs: [/claim_nonce/, /token_id/, /item_digest/, /expires_at > issued_at/, /\(state = 'live'\) = \(settled_at IS NULL\)/] },
  { type: 'index', name: 'idx_bridge_outbound_leases_live', since: 54, needs: [/UNIQUE/i, /state = 'live'/] },
  { type: 'trigger', name: 'bridge_outbound_leases_need_item', since: 54, needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_outbound_leases_fixed', since: 54, needs: [/RAISE\(ABORT/, /OLD\.state <> 'live'/] },
  { type: 'trigger', name: 'bridge_outbound_delete_leases', since: 54, needs: [/bridge_outbound_leases/] },
  { type: 'table', name: 'bridge_config_circuit', since: 54, needs: [/episode_id\s+INTEGER PRIMARY KEY AUTOINCREMENT/, /'chat-channel-missing'/, /closed_by/, /decision/, /master_told_at/, /master_told_generation/, /master_acked_generation/] },
  { type: 'index', name: 'idx_bridge_config_circuit_open', since: 54, needs: [/UNIQUE/i, /closed_at IS NULL/] },
  { type: 'trigger', name: 'bridge_config_circuit_fixed', since: 54, needs: [/RAISE\(ABORT/, /OLD\.closed_at IS NOT NULL/, /OLD\.master_acked_generation IS NOT NULL/, /NEW\.master_acked_generation < OLD\.master_acked_generation/] },
  { type: 'table', name: 'bridge_outbound_parts', since: 54, needs: [/part_external_id\s+TEXT\s+PRIMARY KEY/, /part_index < part_count/, /UNIQUE \(outbound_id, part_index\)/, /candidate_kind/, /question_id/, /'question'/] },
  { type: 'trigger', name: 'bridge_outbound_parts_need_item', since: 54, needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_outbound_parts_immutable', since: 54, needs: [/RAISE\(ABORT/] },
  { type: 'table', name: 'bridge_route_reply_context', since: 54, needs: [/route_id\s+TEXT\s+PRIMARY KEY/, /canonical_external_id/, /replied_route_id/, /candidate_kind/, /question_id/, /'question'/] },
  { type: 'trigger', name: 'bridge_route_reply_context_need_route', since: 54, needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_route_reply_context_immutable', since: 54, needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_routes_delete_reply_context', since: 54, needs: [/bridge_route_reply_context/] },
  { type: 'index', name: 'idx_bridge_helper_tokens_active', needs: [/UNIQUE/i, /WHERE/i] },
  { type: 'table', name: 'bridge_nonces', needs: [/nonce\s+TEXT PRIMARY KEY/] },
  { type: 'table', name: 'bridge_routes', needs: [/external_id[^,]*UNIQUE/, /version\s+INTEGER NOT NULL/, /'awaiting-master'/, /'reply-held'/, /\(resolved_by = 'master'\) = \(resolved_generation IS NOT NULL\)/], needsSince54: [/'outbound-correlation'/], needsSince64: [/surface_kind[^,]*NOT NULL DEFAULT 'guild-channel'/, /'bot-dm'/] },
  { type: 'table', name: 'bridge_route_bodies', needs: [/cleared_at/, /\(text IS NULL\) = \(cleared_at IS NOT NULL\)/] },
  { type: 'index', name: 'idx_bridge_route_bodies_role', needs: [/UNIQUE/i] },
  { type: 'table', name: 'bridge_route_proofs', needs: [/'master-launch'/, /master_generation/, /in_reply_to_hub_id/], needsSince53: [/target_project_id IS NOT NULL/, /target_launch_id IS NOT NULL/] },
  { type: 'trigger', name: 'bridge_route_proofs_immutable', since: 53, needs: [/RAISE\(ABORT/] },
  { type: 'index', name: 'idx_bridge_route_proofs_hub', needs: [/UNIQUE/i] },
  { type: 'table', name: 'bridge_outbound', needs: [/idem_key[^,]*NOT NULL UNIQUE/, /kind\s+TEXT\s+NOT NULL/, /hub_id\s+TEXT\s+CHECK \(hub_id IS NULL/], needsSince53: [/kind = 'status'/], needsSince54: [/'blocked'/, /block_code/, /\(state = 'blocked'\) = \(block_code IS NOT NULL\)/, /\(kind = 'question'\) = \(question_id IS NOT NULL\)/], needsSince62: [/'lane-silent'/], needsSince63: [/'gateway-down'/, /'gateway-recovered'/], needsSince64: [/surface_kind[^,]*NOT NULL DEFAULT 'guild-channel'/, /'bot-dm'/] },
  { type: 'index', name: 'idx_bridge_outbound_status', since: 53, needs: [/UNIQUE/i, /kind = 'status'/] },
  { type: 'table', name: 'bridge_candidates', needs: [/idem_key[^,]*NOT NULL UNIQUE/, /source_launch_id/] },
  { type: 'table', name: 'bridge_candidate_receipts', needs: [/receipt_digest/, /PRIMARY KEY \(candidate_id, receipt_kind, receipt_id\)/] },
  { type: 'table', name: 'bridge_aliases', needs: [/created_by[^,]*'operator'/], needsSince54: [/changed_by IS NOT 'master' OR confirmed_route_id IS NOT NULL/, /changed_at/, /display/] },
  { type: 'table', name: 'bridge_questions', since: 54, needs: [/question_id\s+TEXT\s+PRIMARY KEY/, /'clarify','launch'/, /'open','adopted','declined','cancelled','expired'/, /\(purpose = 'launch'\) = \(target_project_id IS NOT NULL\)/, /\(state = 'open'\) = \(settled_at IS NULL\)/, /\(state IN \('adopted','declined'\)\) = \(adopted_route_id IS NOT NULL\)/, /expires_at > asked_at/] },
  { type: 'index', name: 'idx_bridge_questions_open', since: 54, needs: [/UNIQUE/i, /state = 'open'/] },
  { type: 'index', name: 'idx_bridge_questions_adopted', since: 54, needs: [/UNIQUE/i, /adopted_route_id IS NOT NULL/] },
  { type: 'trigger', name: 'bridge_questions_need_route', since: 54, needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_questions_fixed', since: 54, needs: [/RAISE\(ABORT/, /OLD\.state <> 'open'/] },
  { type: 'table', name: 'bridge_launches', since: 54, needs: [/launch_seq\s+INTEGER PRIMARY KEY AUTOINCREMENT/, /question_id[^,]*NOT NULL UNIQUE/, /consent_route_id[^,]*NOT NULL UNIQUE/, /'queued','waiting-ready','dispatched','failed','abandoned'/, /\(state = 'failed'\) = \(failure_code IS NOT NULL\)/, /session_id IS NOT NULL AND launch_id IS NOT NULL/] },
  { type: 'index', name: 'idx_bridge_launches_route', since: 54, needs: [/UNIQUE/i, /settled_at IS NULL/] },
  { type: 'index', name: 'idx_bridge_launches_in_flight', since: 54, needs: [/UNIQUE/i, /\(\(1\)\)/, /state = 'waiting-ready'/] },
  { type: 'trigger', name: 'bridge_launches_need_consent', since: 54, needs: [/RAISE\(ABORT/, /state = 'adopted' AND adopted_for = 'launch'/, /adopted_route_id = NEW\.consent_route_id/] },
  { type: 'trigger', name: 'bridge_launches_fixed', since: 54, needs: [/RAISE\(ABORT/, /OLD\.settled_at IS NOT NULL/] },
  { type: 'trigger', name: 'bridge_routes_delete_questions', since: 54, needs: [/bridge_questions/] },
  { type: 'trigger', name: 'bridge_routes_delete_launches', since: 54, needs: [/bridge_launches/] },
  { type: 'table', name: 'bridge_project_optouts', since: 54, needs: [/project_id\s+INTEGER PRIMARY KEY/, /set_by[^,]*'operator'/] },
  { type: 'table', name: 'bridge_pins', needs: [/scope <> 'global' OR created_by = 'operator'/] },
  { type: 'index', name: 'idx_bridge_pins_global', needs: [/UNIQUE/i, /COALESCE\(conversation_key/, /WHERE/i] },
  { type: 'index', name: 'idx_bridge_pins_conversation', needs: [/UNIQUE/i, /WHERE/i] },
  { type: 'table', name: 'bridge_audit', needs: [/audit_seq\s+INTEGER PRIMARY KEY AUTOINCREMENT/, /master_generation/, /expected_version/] },
  { type: 'index', name: 'idx_bridge_audit_request', needs: [/UNIQUE/i, /WHERE/i] },
  { type: 'trigger', name: 'bridge_audit_append_only_update', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_audit_append_only_delete', needs: [/RAISE\(ABORT/, /bridge_audit_anchor/] },
  { type: 'table', name: 'bridge_audit_anchor', needs: [/CHECK \(anchor_id = 1\)/, /through_seq/, /removed_count/, /chain_digest/] },
  { type: 'trigger', name: 'bridge_audit_anchor_forward_only', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_audit_anchor_permanent', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_route_bodies_need_route', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_route_proofs_need_route', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_outbound_needs_parents', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_candidates_need_project', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_candidate_receipts_need_candidate', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_candidate_receipts_immutable', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_routes_delete_children', needs: [/bridge_route_proofs/, /bridge_outbound/] },
  { type: 'trigger', name: 'bridge_candidates_delete_children', needs: [/bridge_candidate_receipts/] }
]);

/** The schema version whose shape `bridgeTablesDdl` and `bridgeIndexDdl` create. */
const BRIDGE_SCHEMA_VERSION = 64;

/**
 * Objects an earlier version created and a later one takes away. The version
 * that made each is history and is not edited: the object is dropped by the
 * upgrade into `retiredAt` and again at every boot from then on, is absent
 * from a fresh store, and its presence after that is a shape problem like any
 * other. The drop at boot is for a store an earlier build has touched since:
 * that build re-creates what it knows, and must not lock this one out.
 *
 * `idx_bridge_routes_conversation` shipped in v52 for a lookup of routes by
 * conversation that was never written: routing reads the pin and the reply's
 * own record, and nothing reads the index. v54 is the first version that can
 * retire it cleanly, since it rebuilds `bridge_routes` anyway.
 * `madeBy` is the statement the earlier version ran, kept so that a store of
 * that version can be reproduced exactly.
 */
const RETIRED_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({
    type: 'index', name: 'idx_bridge_routes_conversation', madeAt: 52, retiredAt: 54,
    madeBy: 'CREATE INDEX IF NOT EXISTS idx_bridge_routes_conversation ON bridge_routes(channel_id, thread_id, created_at)'
  })
]);

/** The versions after v52 that changed the bridge's storage. */
const LATER_VERSIONS = Object.freeze([53, 54, 62, 63, 64]);

/**
 * What an object's SQL must contain as of a schema version.
 * @param {object} object - A {@link BRIDGE_SCHEMA_OBJECTS} entry.
 * @param {number} version - Schema version.
 * @returns {RegExp[]}
 */
function _needsAt(object, version) {
  return LATER_VERSIONS.filter((v) => v <= version).reduce((needs, v) => needs.concat(object[`needsSince${v}`] || []), object.needs);
}

/**
 * What is wrong with the bridge's storage, as a list of plain statements.
 * Empty when every object exists in the shape the gateway rests on.
 * @param {object} db - An open `node:sqlite` database.
 * @param {string[]|null} [types=null] - Limit the check to these object types.
 * @param {number} [version] - Check against what this schema version required; the current one by default.
 * @returns {string[]}
 */
function bridgeSchemaProblems(db, types = null, version = BRIDGE_SCHEMA_VERSION) {
  const problems = [];
  const lookup = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?');
  for (const object of BRIDGE_SCHEMA_OBJECTS) {
    if (types && !types.includes(object.type)) continue;
    if ((object.since || 52) > version) continue;
    const row = lookup.get(object.type, object.name);
    if (!row) {
      problems.push(`no ${object.type} ${object.name}`);
      continue;
    }
    const needs = _needsAt(object, version);
    if (needs.some((fragment) => !fragment.test(row.sql || ''))) problems.push(`${object.type} ${object.name} in an unexpected shape`);
  }
  for (const object of RETIRED_SCHEMA_OBJECTS) {
    if (types && !types.includes(object.type)) continue;
    if (version >= object.retiredAt && lookup.get(object.type, object.name)) {
      problems.push(`${object.type} ${object.name} was retired in v${object.retiredAt} and is still present`);
    }
  }
  return problems;
}

/**
 * Refuse a store whose bridge tables are missing or misshapen.
 * @param {object} db - An open `node:sqlite` database.
 * @param {string} [context='startup'] - Where the check ran, for the message.
 * @returns {void}
 * @throws {Error} Naming every problem found.
 */
function verifyBridgeSchema(db, context = 'startup') {
  const problems = bridgeSchemaProblems(db);
  if (problems.length) {
    throw new Error(`Operator bridge storage failed its shape check at ${context}: ${problems.join('; ')}.`);
  }
}

/**
 * Create the bridge's storage and prove it: tables, then their shape, then
 * the indexes and triggers that depend on that shape, then the whole. Runs on
 * every boot and inside the migration; a no-op on a store already correct.
 * @param {object} db - An open `node:sqlite` database.
 * @param {string} [context='startup'] - Where it ran, for the message.
 * @returns {void}
 * @throws {Error} Naming every problem found.
 */
function createBridgeSchema(db, context = 'startup') {
  db.exec(bridgeTablesDdl());
  // What this version retired is taken away here too, not only by the upgrade
  // that first retired it. A build from before the retirement re-creates such
  // an object every time it boots; if that build ever ran against this store,
  // the next boot of this one puts the store right instead of refusing it.
  for (const object of RETIRED_SCHEMA_OBJECTS.filter((o) => o.type === 'index')) {
    db.exec(`DROP INDEX IF EXISTS ${object.name}`);
  }
  const tableProblems = bridgeSchemaProblems(db, ['table']);
  if (tableProblems.length) {
    throw new Error(`Operator bridge storage failed its shape check at ${context}: ${tableProblems.join('; ')}.`);
  }
  db.exec(bridgeIndexDdl());
  // The anchor's one row. A no-op once it exists.
  db.prepare(
    'INSERT OR IGNORE INTO bridge_audit_anchor (anchor_id, through_seq, removed_count, compactions, chain_digest, updated_at) '
    + 'VALUES (1, 0, 0, 0, NULL, ?)'
  ).run(new Date().toISOString());
  verifyBridgeSchema(db, context);
}

/**
 * Whether the store holds any of the bridge's tables. A store with none has
 * never had bridge storage; one with some and not others is damaged, which
 * {@link upgradeBridgeTables} refuses and this does not judge.
 * @param {object} db - An open `node:sqlite` database.
 * @returns {boolean}
 */
function hasBridgeTables(db) {
  const lookup = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  return BRIDGE_SCHEMA_OBJECTS.some((object) => object.type === 'table' && Boolean(lookup.get(object.name)));
}

/**
 * Bring an earlier store's bridge tables to the current shape.
 *
 * First the store must be a sound store of the version it claims: every
 * object that version had, in that version's shape. A store that is missing
 * one, or has one misshapen, is refused here, before anything is touched.
 * Then each table that lacks what a later version requires is rebuilt: set
 * aside, created afresh from {@link bridgeTablesDdl}, given back every row
 * with every column the two have in common (row ids included), its row count
 * compared and its id sequence carried over, and the old one dropped. A
 * store already in the current shape is left alone.
 *
 * Call inside a transaction, and before {@link createBridgeSchema}: every
 * bridge trigger is dropped here so that none is left pointing at a table set
 * aside, and that call restores all of them, the indexes, and any table a
 * later version added.
 * @param {object} db - An open `node:sqlite` database.
 * @param {number} from - The schema version the store is at.
 * @returns {string[]} The tables that were rebuilt.
 * @throws {Error} When the store is not a sound store of `from`, or a copy loses rows.
 */
function upgradeBridgeTables(db, from) {
  const unsound = bridgeSchemaProblems(db, null, from);
  if (unsound.length) {
    throw new Error(`Operator bridge storage is not a sound v${from} store, so it cannot be upgraded: ${unsound.join('; ')}.`);
  }
  // What a version between `from` and the current one retired goes first, by
  // name: it does not depend on whether its table is rebuilt below.
  for (const object of RETIRED_SCHEMA_OBJECTS.filter((o) => o.retiredAt > from && o.type === 'index')) {
    db.exec(`DROP INDEX IF EXISTS ${object.name}`);
  }
  const stale = BRIDGE_SCHEMA_OBJECTS.filter((object) => {
    if (object.type !== 'table' || (object.since || 52) > from) return false;
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(object.name);
    return _needsAt(object, BRIDGE_SCHEMA_VERSION).some((fragment) => !fragment.test(row.sql || ''));
  }).map((object) => object.name);
  if (!stale.length) return [];

  for (const object of BRIDGE_SCHEMA_OBJECTS.filter((o) => o.type === 'trigger')) {
    db.exec(`DROP TRIGGER IF EXISTS ${object.name}`);
  }
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const sequence = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?');
  const carried = new Map(stale.map((name) => [name, sequence.get(name)]));
  for (const name of stale) db.exec(`ALTER TABLE ${name} RENAME TO ${name}_superseded`);
  db.exec(bridgeTablesDdl());
  for (const name of stale) {
    const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const now = new Set(columnsOf(name));
    const shared = columnsOf(`${name}_superseded`).filter((c) => now.has(c));
    db.exec(`INSERT INTO ${name} (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM ${name}_superseded`);
    if (count(name) !== count(`${name}_superseded`)) {
      throw new Error(`Rebuilding ${name} for schema v${BRIDGE_SCHEMA_VERSION} did not carry over every row.`);
    }
    // An id a deleted row once had is never issued again.
    const was = carried.get(name);
    if (was) {
      db.prepare('INSERT OR IGNORE INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, was.seq);
      db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(was.seq, name);
    }
    db.exec(`DROP TABLE ${name}_superseded`);
  }
  return stale;
}

module.exports = {
  ROUTE_STATES,
  FAILURE_REASONS,
  OUTBOUND_KINDS,
  NOTIFICATION_TYPES,
  SURFACE_KINDS,
  CANDIDATE_KINDS,
  MAX_INBOUND_LENGTH,
  MAX_OUTBOUND_LENGTH,
  BRIDGE_SCHEMA_OBJECTS,
  bridgeIndexDdl,
  RETIRED_SCHEMA_OBJECTS,
  hasBridgeTables,
  upgradeBridgeTables,
  BRIDGE_SCHEMA_VERSION,
  createBridgeSchema,
  bridgeSchemaProblems,
  verifyBridgeSchema
};
