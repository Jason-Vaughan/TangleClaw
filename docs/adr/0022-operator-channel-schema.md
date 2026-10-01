# ADR 0022: The operator channel's storage is one migration, and a notification has no Hub id

**Status:** Accepted (2026-09-30) by Architect ruling for #2031 (Medusa dispatch `92b79e63`), after
independent Critic review of the fold. The scope was authorized by Architect ruling A6.
**Source issue:** #2031, the operator-channel v51/v52 schema blocker on the Discord stack (#1966,
#2001, #2003).
**Builds on:** `docs/operator-channel.md`; Architect ruling A17 (open PRs do not reserve migration
numbers); the Hub id rule `HUB_ID_RE` in `lib/medusa-exchanges.js`.

---

## Context

The operator channel (#1956) and its server notifications (#1799) were built as two stacked
branches, and each added its own migration:

- the channel's mail tables, numbered v51;
- the notification columns, key index and notifier state table, numbered v52.

Neither shipped. In the meantime `main` took v51 for the coordinator rotation tables (#2032), so both
of the stack's numbers now collide with main's.

The notification migration also had to fit a table whose `hub_id` was `NOT NULL UNIQUE`. It did so
by storing each notification under a synthetic id, `notify/<key>`. The `/` put that id outside the
Hub's id rule, and the channel refused arrivals that broke the rule. That made one column carry two
meanings, and every Hub-id path had to remember the exception. A fix on the branch (`1d027b97`) was
already a consequence of that exception.

## Decision

1. **One migration creates the channel's storage in its final shape.** It creates
   `operator_channel_inbound`, `operator_channel_outbound` with the notification columns (`kind`,
   `notify_type`, `idem_key`, `project_id`), the partial unique index on `idem_key`, and
   `operator_channel_notify_state`. It is purely additive over the version before it.
2. **`hub_id` is a nullable UNIQUE column.** SQLite admits any number of NULLs under UNIQUE.
3. **Each kind has its own key, enforced by a row CHECK.**
   - A `reply` has a `hub_id`, and no `idem_key` or `notify_type`.
   - A `notification` has an `idem_key` and a `notify_type`, and no `hub_id`.
   - A received message is therefore never stored under a notification's key, whatever its id, and
     cannot suppress one.
4. **Every channel insert names its conflict target** (`ON CONFLICT(external_id)` inbound,
   `ON CONFLICT(hub_id)` / `ON CONFLICT(idem_key) WHERE idem_key IS NOT NULL` outbound, then
   `DO NOTHING`). `INSERT OR IGNORE` is not used, because it also swallows CHECK and NOT NULL
   failures, and a nullable key would turn those into silent drops.
   - A value the columns would refuse from outside TangleClaw's own validation is handled before
     the insert, not left to throw. The Medusa Bridge accepts any `from`, so an arrival whose
     sender id exceeds the column bound is kept quarantined without it; a throw there would leave
     the Hub copy un-acked and redelivered forever.
5. **The postcondition is the shape, and it is checked in full at every startup as well as at
   migration.**
   `IF NOT EXISTS` leaves an existing table alone, so without this check a table in another shape
   would survive under the new code. The postcondition requires:
   - the unique keys;
   - a nullable `hub_id`;
   - the notification columns;
   - the row CHECK;
   - the notifier state table;
   - the partial unique key index.
   Anything else is refused, and the refusal names what is wrong.
6. **The Hub-id refusal on arrival stays**, as a general rule. An id outside `HUB_ID_RE` did not
   come from the Hub. The rule no longer protects a reserved id space, because none exists.
7. **Databases that ran the abandoned branch migrations get no migration path.**
   - A read-only audit found no such database among the local installs (ruling A6).
   - The stack's two versions are treated as never shipped.
   - TangleClaw does not try to identify or repair such a database. Its old-shaped outbound table
     fails the startup postcondition.
   - The operator guide says to recreate it, or restore it from a backup.
8. **The migration is v52, after `main`'s v51** (A17, ruling A6). The function names carry no
   version number. The number is written where the code needs it: `CURRENT_SCHEMA_VERSION`, the
   dispatch line with its log message, and this migration's own test, which rewinds a store to the
   version before it. The CHANGELOG and docs state it too. No other feature's test pins it. A
   renumber searches the tree for the old number rather than trusting a list of sites.

## Consequences

- One schema version, not two, is consumed on `main`.
- Every Hub-id path is plain again. A notification is found by `idem_key`, never by `hub_id`.
- The HTTP API is unchanged. `GET /api/operator-channel/outbound` still lists `{id, kind, type,
  text, inReplyTo, receivedAt}`, and the Discord helper (#2003) needs no change beyond its restack.
- A developer database that ran the abandoned branches must be recreated or restored. This is
  documented, not automated.
- The startup postcondition costs a few `sqlite_master` and `PRAGMA` reads per boot.
- A later notification about one operator message (`message-undelivered`) reuses the existing
  `reply_to_inbound_id` column, so `inReplyTo` names that message. No column was added for it.

## Forward extension boundary (not built)

Architect rulings A1–A5 describe later routing work for the channel. This ADR adds **no** column,
table or behavior for it. They are recorded here so that the later work extends this schema
instead of rewriting it:

- **Routing identity (A2).** The addressable principal is a registered project, keyed by its
  numeric `projectId`. Tags confer no routing, and a group never collapses its members into one
  destination. A live-session route is `projectId` plus an optional selector, resolved at delivery
  time by `liveTargetWorkspace`.
- **Direct delivery (A3).** An explicitly addressed message goes straight to its target's live
  workspace, not through the Architect session. The Architect stays the default destination, the
  policy owner and the fallback.
- **Mobile addressing (A4, A5).**
  - Aliases resolve exactly to stable ids. Nothing is fuzzy-matched.
  - An `alias: msg` prefix routes only on an exact alias match.
  - `to alias` pins a destination. A pin is kept per operator and Discord conversation. It lasts
    until the thread closes, or for 60 idle minutes in the base channel.
  - A Discord reply always inherits the original message's target.
  - Every outbound answer shows a compact source label.
- **What that work will add, additively.** An inbound destination envelope: a closed
  `target_kind`, the existing `target_project_id`, and a nullable selector. It will also add the
  inbound reply and thread references, an outbound `source_project_id`, and a pin table. Each is a
  new nullable column or a new table, so none of them needs this migration reopened.

## Amendment (2026-10-01): a `discarded` state, in a second migration

**Status:** Accepted by Architect ruling for #1799 (Medusa `c666e145`).

### Context

The Discord helper holds an item Discord refuses outright (HTTP 400) as `rejected`. Such an item was
not posted and would be refused again, so it needs an exit that is true. The outbound table's `state`
CHECK admitted `unverified`, `relayable`, `delivered` and `quarantined`. Acknowledging the item would
record it `delivered` under a Discord id that is not its own.

### Decision

1. **`operator_channel_outbound.state` gains `discarded`.** It is the operator's disposition for an
   item TangleClaw was willing to hand on and the chat refused. The `reason` column carries one of two
   closed values, `rejected-by-chat` or `rejected-by-chat-partly-posted`. The row's text is cleared and
   `delivered_ref` stays NULL.
2. **`quarantined` is not reused.** It means TangleClaw itself judged a received message unfit to
   hand on: a provenance and security isolation. An operator's intentional disposition is a
   different fact, and the status counts keep the two apart.
3. **A second migration, v53, rebuilds the table.** SQLite cannot alter a CHECK in place. Inside one
   `BEGIN IMMEDIATE` the migration:
   - creates the table in its final shape under a temporary name;
   - copies every row by column name, and refuses to go on unless the counts match;
   - carries the AUTOINCREMENT high-water mark over, so an id is never reused. The helper's durable
     record and its Discord nonces are keyed by outbound id;
   - drops the old table, renames the new one, and recreates the state index and the notification
     key index;
   - proves the whole postcondition before the version advances.
4. **The shape v52 creates is the final shape too.** The table DDL is shared, so a fresh install and
   a store migrating from v51 get `discarded` at once, and the v53 step finds nothing to rebuild.
   Only a store already stamped v52 is rebuilt.
5. **Every startup checks the new state as well,** after the migrations have run, so a store one
   version back is rebuilt and not refused, and a store stamped current that cannot hold a
   `discarded` row is refused at start.
6. **One helper route is added:** `POST /api/operator-channel/outbound/:id/discard`. The channel
   token's scope is the four helper routes.

### Why a second version, when Decision 8 and the first alternative below kept the fold to one

The fold's reason for one version was that both of the stack's migrations were unshipped and no
database held their shape. That no longer holds for v52: the folded shape was accepted and pushed as
a candidate, so a store stamped v52 can exist. Changing v52's DDL in place would leave such a store
at the current version with a CHECK that refuses `discarded`.

### Consequences

- A rollback of one version needs no step. The rebuilt table has the same columns and keys, the
  older server's storage check passes, and it never lists or moves a `discarded` row.
- The HTTP API gains one route and one refusal code set. `GET /api/operator-channel/outbound` is
  unchanged.
- The numbering rule of Decision 8 applies to v53 as it does to v52.

## Alternatives considered

- **Keep two migrations, renumbered to v52 and v53.** Rejected. It spends two versions on unshipped
  work and keeps the synthetic-id exception.
- **Keep `hub_id NOT NULL` with a different synthetic prefix.** Rejected. The column would still
  mean two things, which is the defect #2031 names.
- **Detect a stray database and migrate it in place.** Rejected by ruling A6. No such database was
  found, so guessing at its shape would add code with no user.
