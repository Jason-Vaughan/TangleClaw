'use strict';

/**
 * Role-scoped TangleClaw operating primers (#2070 Slice 1, Architect Ruling
 * A2070).
 *
 * "Know everything about TangleClaw" does not mean pasting the whole manual
 * into every prompt. It means: a compact, role-appropriate subset of the
 * verb roster, composed from `lib/tc-verbs.js#VERB_ROSTER` itself rather than
 * hand-written prose that can drift from it -- the same "one structured
 * schema as executable truth" `docs/tc-cli-reference.md` (#2299) already
 * holds for the full roster. {@link buildOperatingPrimer} fails loudly if a
 * role names a verb the roster no longer has, so a renamed or removed verb
 * cannot leave a primer silently stale.
 *
 * Slice 2 (#2835) is the AI documentation router and the repo-wide Markdown
 * manifest; this file's own scope is the compact primer and the role subsets
 * it is built from, not the full reference (that is
 * `docs/tc-cli-reference.md`, already shipped).
 *
 * @module lib/operating-primer
 */

const {
  VERB_ROSTER, BRIDGE_SUBVERBS, CONTROL_SUBVERBS, MESSAGE_SUBVERBS, START_SUBVERBS, WORKLOAD_SUBVERBS,
  DECISION_SUBVERBS, ROTATION_SUBVERBS, BRANCH_SUBVERBS, USAGE_SUBVERBS, MODEL_SUBVERBS, QUEUE_SUBVERBS,
  CHECK_SUBVERBS
} = require('./tc-verbs');

/**
 * Every verb whose implementation exposes its OWN ground-truth subverb
 * list (a `lib/tc-verbs.js#*_SUBVERBS` export) -- what
 * {@link subverbManifestParity} checks `SUBVERB_MANIFEST` against at the
 * subverb grain, not just "this verb has some manifest entry." A verb not
 * listed here (`whoami`, `sessions`, `docs`, `candidate`, ...) dispatches
 * its own subverbs without a named ground-truth array to check against;
 * its `SUBVERB_MANIFEST` entry is still covered by the top-level
 * `missing`/`stale` check, just not at this finer grain.
 * @type {Readonly<Record<string, string[]>>}
 */
const IMPLEMENTATION_SUBVERBS = Object.freeze({
  control: CONTROL_SUBVERBS,
  message: MESSAGE_SUBVERBS,
  start: START_SUBVERBS,
  workload: WORKLOAD_SUBVERBS,
  decision: DECISION_SUBVERBS,
  rotation: ROTATION_SUBVERBS,
  branch: BRANCH_SUBVERBS,
  usage: USAGE_SUBVERBS,
  model: MODEL_SUBVERBS,
  bridge: BRIDGE_SUBVERBS,
  queue: QUEUE_SUBVERBS,
  check: CHECK_SUBVERBS
});

/**
 * One structured command/subcommand record (Architect Ruling A2070 bullet
 * 1): syntax, purpose, authority, state preconditions, and exit/refusal
 * notes, for one verb or one of its subverbs. Content here is drawn from
 * `docs/tc-cli-reference.md`'s own already-shipped, already-reviewed prose
 * (#2299) -- restated structurally, not re-derived or invented, so this
 * manifest and that page keep saying the same thing in two shapes.
 * @typedef {object} SubverbSpec
 * @property {string|null} id - The subverb id, or `null` for a verb with no
 *   subverbs (its one record covers the bare verb itself).
 * @property {string} syntax - Exact invocation syntax.
 * @property {string} purpose - What it does, one line.
 * @property {string} authority - Who/what may run it.
 * @property {string} statePreconditions - What must already be true.
 * @property {string} exitRefusal - Exit codes and refusal behavior specific
 *   to this record, beyond the generic 0/1/2 table every verb shares
 *   (`docs/tc-cli-reference.md`'s "Exit codes and failure posture").
 */

/** The authority/state/exit text every read-only, no-argument verb below shares, named once. */
const _ANY_LAUNCHED_SESSION = 'any session TangleClaw launched (reads its own launch identity from the environment)';
const _GENERIC_EXIT = '0 answered (including an honest empty list); 2 API unreachable, refused, or failed (`docs/tc-cli-reference.md`\'s exit-code table).';

/**
 * The structured command/subcommand manifest (Architect Ruling A2070 bullet
 * 1): every current top-level `tc` verb, and every one of its subverbs,
 * keyed by verb id. {@link subverbManifest} validates this against the live
 * `VERB_ROSTER` at call time -- a verb id here with no `VERB_ROSTER` entry,
 * or a `VERB_ROSTER` verb missing from here, is a build-time failure, not a
 * silently incomplete manifest.
 * @type {Readonly<Record<string, SubverbSpec[]>>}
 */
const SUBVERB_MANIFEST = Object.freeze({
  help: [
    { id: null, syntax: 'tc help --json', purpose: 'the whole verb roster as structured JSON', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none -- answers before the environment is even checked', exitRefusal: '0 valid JSON; 1 a malformed call (e.g. missing --json), before any request' }
  ],
  whoami: [
    { id: null, syntax: 'tc whoami', purpose: "this pane's resolved identity, TangleClaw location and capabilities", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  capabilities: [
    { id: null, syntax: 'tc capabilities', purpose: 'enabled and disabled capabilities, each with its reason', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  sessions: [
    { id: null, syntax: 'tc sessions', purpose: 'every live session visible across projects, with composed workload state', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'isolation', syntax: 'tc sessions isolation [--replaced <session-id,...>]', purpose: 'whether each live session started independently of its engine\'s shared background process; with --replaced, checks that named older sessions were ended and relaunched with isolation', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  message: [
    { id: 'send', syntax: 'tc message send [--priority blocking --reason <code> --reply-required] [--in-reply-to <id>] [--escalate-after <min>] [--request-id <id>] <workspace-id> <text...>', purpose: 'sends a message to an exact workspace id, normal or a blocking reply-required exchange', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'exact workspace id, not a display name', exitRefusal: _GENERIC_EXIT },
    { id: 'read', syntax: 'tc message read', purpose: "reads this session's inbox, verifying its listener is actually listening first", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'ack', syntax: 'tc message ack <message-id...>', purpose: 'marks received messages handled; does not close an exchange this session initiated', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'the message id(s) must exist in this inbox', exitRefusal: _GENERIC_EXIT },
    { id: 'status', syntax: 'tc message status <workspace-id>', purpose: 'whether a peer is reachable and why a message may not have been picked up', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'close', syntax: 'tc message close <exchange-id>', purpose: 'closes an exchange this session initiated, after its reply arrived', authority: 'the session that initiated the exchange', statePreconditions: 'a reply must have arrived', exitRefusal: _GENERIC_EXIT },
    { id: 'sent', syntax: 'tc message sent', purpose: 'lists open exchanges this session initiated', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'owed', syntax: 'tc message owed', purpose: "lists this session's outstanding replies, then unhandled messages", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'retract', syntax: 'tc message retract [--reason <text>] [--replacement <id>] <message-id>', purpose: 'retracts an unread message this session sent', authority: 'the session that sent the message', statePreconditions: 'the message must still be unread', exitRefusal: _GENERIC_EXIT }
  ],
  control: [
    { id: 'status', syntax: 'tc control status', purpose: 'whether this lane is governed by an assignment, HOLD or STOP, with its generation', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'ack', syntax: 'tc control ack <generation>', purpose: 'acknowledges the HOLD/STOP generation status showed; does not lift it', authority: 'the assignment\'s target, through its currently bound launch only -- a stale or replaced launch of the same project is refused', statePreconditions: 'the generation must match the current one', exitRefusal: _GENERIC_EXIT },
    { id: 'hold', syntax: 'tc control hold <assignment-id> <reason-code>', purpose: 'places a durable hold on an assignment', authority: 'the Operator, the assignment\'s own target (self-hold), or a principal named in that assignment\'s authority.hold list', statePreconditions: 'the assignment must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'pause', syntax: 'tc control pause <project>', purpose: "requests a safe-boundary HOLD on another project's open assignment (#2109) -- the reason code is always the fixed peer-pause-request, and there is no --timeout: this places the same durable HOLD tc control hold does, under a request shape scoped to one target project", authority: 'the Operator, the target\'s own session (self-pause), or a principal named in the target\'s open assignment\'s authority.hold list', statePreconditions: 'the named project must have an open control assignment', exitRefusal: _GENERIC_EXIT },
    { id: 'release', syntax: 'tc control release <assignment-id> <generation> <reason-code> <hold-id...>', purpose: 'releases named holds using the generation just observed', authority: 'authority over the assignment', statePreconditions: 'the generation must be the one just read, or the release is refused', exitRefusal: _GENERIC_EXIT },
    { id: 'stop', syntax: 'tc control stop <assignment-id> <reason-code>', purpose: 'permanently stops the assignment; a new assignment is required to work again', authority: 'authority over the assignment', statePreconditions: 'the assignment must exist', exitRefusal: _GENERIC_EXIT }
  ],
  queue: [
    { id: 'status', syntax: 'tc queue status', purpose: 'each queue entry in order, its state, its gates and whose word each one is', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'submit', syntax: 'tc queue submit <pr> --head <sha> --review <ref> --test <ref> --base <ref> [--operator-gate required|none] [--queue <id>]', purpose: "as the queue's owner project, submits a PR head with its gates", authority: "the queue's owner project", statePreconditions: 'the head/review/test/base refs must be exact', exitRefusal: '2 if the answer did not arrive in time, which may still mean running or finished -- read tc queue status before repeating' },
    { id: 'show', syntax: 'tc queue show <entry>', purpose: 'shows one entry', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'the entry must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'withdraw', syntax: 'tc queue withdraw <entry> --reason <text>', purpose: 'as the owner project, withdraws an entry', authority: "the queue's owner project", statePreconditions: 'the entry must exist and be open', exitRefusal: _GENERIC_EXIT },
    { id: 'advance', syntax: 'tc queue advance [--queue <id>]', purpose: "as the owner project, moves the front entry one step (makes its candidate, or lands it once every gate holds)", authority: "the queue's owner project", statePreconditions: 'an entry must be at the front', exitRefusal: '2 if uncertain -- read tc queue status before repeating' }
  ],
  check: [
    { id: 'watch', syntax: 'tc check watch <pr> --sha <sha> --name <check> --due <minutes>', purpose: "registers a watch on a named check of an exact commit, for this session's own project", authority: _ANY_LAUNCHED_SESSION, statePreconditions: '--due must be a whole number of minutes from now', exitRefusal: _GENERIC_EXIT },
    { id: 'list', syntax: 'tc check list [--project <id>]', purpose: "lists this project's watches, or a group-sharing project's", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'show', syntax: 'tc check show <watch>', purpose: "shows one watch's state, last GitHub read, message history", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'the watch must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'cancel', syntax: 'tc check cancel <watch>', purpose: 'cancels a watch of this project', authority: 'the watch\'s own project', statePreconditions: 'the watch must exist', exitRefusal: _GENERIC_EXIT }
  ],
  start: [
    { id: 'next', syntax: 'tc start next [--ack <step>:<revision>:<digest>] [--page <n>]', purpose: 'serves (or acknowledges and advances) the next step of a NEW launch sequence', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'a fresh or unattested launch -- never use as a shortcut after /clear or compaction', exitRefusal: _GENERIC_EXIT },
    { id: 'ready', syntax: 'tc start ready --verdict <preflight-verdict> --first-action <text> [--reconciliation <text>]', purpose: 'attests the launch READY after every step is acknowledged', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'every step must already be acknowledged', exitRefusal: _GENERIC_EXIT },
    { id: 'status', syntax: 'tc start status', purpose: 'shows the launch cursor, acknowledgements and READY state', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'review', syntax: 'tc start review [--step <n|id>] [--page <n>]', purpose: 'read-only re-read of the frozen launch context after /clear or compaction', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'the launch must already be attested READY, or this refuses NOT_READY -- the fix is tc start next through every step, not this', exitRefusal: _GENERIC_EXIT }
  ],
  workload: [
    { id: 'set', syntax: 'tc workload set <working|waiting-external|blocked|complete> --clearance <safe-to-clear|do-not-clear|unknown> --summary "<line>" [--wait <kind>] [--issue n]... [--pr n]...', purpose: "records this lane's current work and clearability", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'show', syntax: 'tc workload show', purpose: "this launch's latest receipt and the composed availability/clearance verdict coordinators see", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  decision: [
    { id: 'ask', syntax: 'tc decision ask --prompt "<text>" --choice <c>... --gate <gate> --authority <human|architect|pm|role-based|autonomous-within-lease> --ttl <ms>', purpose: 'records a durable decision this lane is blocked on, bound to a prompt digest', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'at least two choices', exitRefusal: _GENERIC_EXIT },
    { id: 'list', syntax: 'tc decision list [--state <s>]', purpose: "lists this session's decision requests, newest first", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'show', syntax: 'tc decision show <decision-id>', purpose: 'shows one decision, its choices, prompt digest and (once answered) its answer', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'the decision must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'answer', syntax: 'tc decision answer <decision-id> --answer "<text>" --digest <prompt-digest>', purpose: 'answers a decision bound to its exact prompt digest', authority: 'the Operator alone, for every authority class -- no self-answer path exists', statePreconditions: 'the digest must match the decision\'s own exactly', exitRefusal: _GENERIC_EXIT }
  ],
  rotation: [
    { id: 'prepare', syntax: 'tc rotation prepare --checkpoint <file> [--key <attempt-key>]', purpose: 'starts a managed context rotation, records the checkpoint, fences new dispatch', authority: 'the appointed coordinator (Architect/PM)', statePreconditions: 'the checkpoint file must be outside the checkout', exitRefusal: _GENERIC_EXIT },
    { id: 'show', syntax: 'tc rotation show', purpose: 'shows the active rotation, checkpoint, drift, blockers and exact next action', authority: 'the appointed coordinator', statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'advance', syntax: 'tc rotation advance', purpose: 'advances the server-managed rotation once a replacement context is available', authority: 'the appointed coordinator', statePreconditions: 'the old context must have ended', exitRefusal: _GENERIC_EXIT },
    { id: 'resume', syntax: 'tc rotation resume --receipt <file>', purpose: "submits the replacement context's reconciliation receipt and lifts the dispatch fence", authority: 'the appointed coordinator', statePreconditions: 'the receipt file must be outside the checkout', exitRefusal: _GENERIC_EXIT }
  ],
  finalize: [
    { id: null, syntax: 'tc finalize --reason "<why>" [--session <id>] [--project <name> --session <id>]', purpose: 'retires a finished session (this one, a named one in this project, or -- with authority -- one in another project)', authority: "this session for itself; lifecycle authority, or the project's own workloadNudge.coordinatorProject, for another project's session", statePreconditions: 'the receipt must read complete + safe-to-clear, drained, with no unfinished work', exitRefusal: '3 refused or incomplete -- read the exact facts; FINALIZE_INCOMPLETE means repeat the same command to finish' }
  ],
  freshness: [
    { id: null, syntax: 'tc freshness', purpose: "the commit of each visible live checkout and its relationship to origin/main", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  branch: [
    { id: 'check', syntax: 'tc branch check <name> [--json] [--repo <path>]', purpose: 'assesses whether deleting, resetting or removing the branch\'s worktree would lose work; mutates nothing', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'needs a TangleClaw-launched pane', exitRefusal: '0 safe (the only exit permitting deletion); 3 preserve; 4 could not prove safety -- neither 3 nor 4 is permission to delete or reset anything' }
  ],
  candidate: [
    { id: 'submit', syntax: 'tc candidate submit --kind <milestone|operator-action-required> --receipt workload:<seq> --text "<text>" [--request-id <id>]', purpose: 'offers a milestone or operator action to the Project Master, backed by a workload receipt; posts nothing itself', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'the cited workload:<seq> receipt must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'status', syntax: 'tc candidate status [<id>]', purpose: 'reads what became of a submitted candidate', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  // `bridge`'s own ~20 subverbs are Project-Master-only and already fully
  // enumerated, including their --version/--request-id requirements, in
  // docs/tc-cli-reference.md's "Operator bridge" table -- restated here at
  // the same per-subverb grain rather than duplicated verbatim a second
  // time in this file.
  bridge: [
    { id: 'status', syntax: 'tc bridge status', purpose: 'whether the bridge is enabled and its current state', authority: "the live Project Master's bridge credential", statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'destinations', syntax: 'tc bridge destinations', purpose: 'reachable project destinations and whether they are running', authority: "the Master's bridge credential", statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'nicknames', syntax: 'tc bridge nicknames', purpose: 'lists saved destination nicknames', authority: "the Master's bridge credential", statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'nickname', syntax: 'tc bridge nickname <name>', purpose: "explains one nickname, its target and provenance", authority: "the Master's bridge credential", statePreconditions: 'the nickname must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'nickname set', syntax: 'tc bridge nickname set <name> --to <dest> --answered-by <id>', purpose: 'saves a nickname requested by the operator', authority: "the Master's bridge credential; --answered-by names the operator's correlated reply", statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'nickname rename', syntax: 'tc bridge nickname rename <name> <new-name> --answered-by <id>', purpose: 'renames a nickname without changing its target', authority: "the Master's bridge credential; --answered-by names the operator's correlated reply", statePreconditions: 'the nickname must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'nickname forget', syntax: 'tc bridge nickname forget <name> --answered-by <id>', purpose: 'removes a nickname', authority: "the Master's bridge credential; --answered-by names the operator's correlated reply", statePreconditions: 'the nickname must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'routes', syntax: 'tc bridge routes [--state <state>]', purpose: 'lists routes, oldest first, without message bodies', authority: "the Master's bridge credential", statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'read', syntax: 'tc bridge read <route-id>', purpose: 'reads one route, its held text, state and version', authority: "the Master's bridge credential", statePreconditions: 'the route must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'route', syntax: 'tc bridge route <route-id> --version <n> --to <dest> [--answered-by <id>]', purpose: 'sends a held message to the chosen destination', authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'ask', syntax: 'tc bridge ask <route-id> --version <n> (--text <q>|--text-file <f>)', purpose: 'asks the operator a clarification while keeping the original message held', authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'ask-launch', syntax: 'tc bridge ask-launch <route-id> --version <n> --project <project>', purpose: "asks whether to launch a stopped project's session; does not launch it", authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'launch', syntax: 'tc bridge launch <route-id> --version <n> --answered-by <id>', purpose: 'records correlated operator consent, launches the session, delivers the held message when ready', authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'decline', syntax: 'tc bridge decline <route-id> --version <n> --answered-by <id>', purpose: "closes a held message on the operator's no/cancel, without launching or delivering", authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'answer', syntax: 'tc bridge answer <route-id> --version <n> (--text <t>|--text-file <f>)', purpose: "sends the Master's answer to the operator", authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'release', syntax: 'tc bridge release <route-id> --version <n>', purpose: 'releases an unchanged operator reply the gateway is holding', authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'pin', syntax: 'tc bridge pin <route-id> --version <n> --to <dest>', purpose: "pins the conversation's destination", authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'close', syntax: 'tc bridge close <route-id> --version <n>', purpose: 'closes a route, clears its text, withdraws any unposted item', authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'candidates', syntax: 'tc bridge candidates', purpose: 'lists submitted notice candidates awaiting a decision', authority: "the Master's bridge credential", statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'candidate', syntax: 'tc bridge candidate <candidate-id>', purpose: 'reads a candidate, its text, receipts and version', authority: "the Master's bridge credential", statePreconditions: 'the candidate must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'approve', syntax: 'tc bridge approve <candidate-id> --version <n> [--text <t>|--text-file <f>]', purpose: 'rechecks receipts and releases a verified notice to the operator', authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read; receipts must still verify', exitRefusal: _GENERIC_EXIT },
    { id: 'reject', syntax: 'tc bridge reject <candidate-id> --version <n>', purpose: 'rejects a candidate; nothing is posted', authority: "the Master's bridge credential", statePreconditions: '--version must be the one last read', exitRefusal: _GENERIC_EXIT },
    { id: 'merge', syntax: 'tc bridge merge <candidate-id> --version <n> --into <candidate-id>', purpose: 'folds a duplicate candidate and its receipts into another', authority: "the Master's bridge credential", statePreconditions: 'both candidates must exist', exitRefusal: _GENERIC_EXIT },
    { id: 'blocked', syntax: 'tc bridge blocked', purpose: 'lists outbound items the helper could not post', authority: "the Master's bridge credential", statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'requeue', syntax: 'tc bridge requeue <item-id>', purpose: "returns a set-aside item to the helper's mailbox", authority: "the Master's bridge credential", statePreconditions: 'the item must be set aside', exitRefusal: _GENERIC_EXIT },
    { id: 'withdraw', syntax: 'tc bridge withdraw <item-id>', purpose: 'permanently withdraws an unposted item', authority: "the Master's bridge credential", statePreconditions: 'the item must not already be posted', exitRefusal: _GENERIC_EXIT },
    { id: 'circuit ack', syntax: 'tc bridge circuit ack <episode>', purpose: 'acknowledges an open bridge configuration episode; it remains open', authority: "the Master's bridge credential", statePreconditions: 'the episode must be open', exitRefusal: _GENERIC_EXIT },
    { id: 'reset', syntax: 'tc bridge reset (--requeue|--withdraw)', purpose: "closes the configuration episode and either retries or withdraws its set-aside items", authority: "the Master's bridge credential", statePreconditions: 'an open configuration episode', exitRefusal: _GENERIC_EXIT }
  ],
  ports: [
    { id: null, syntax: 'tc ports', purpose: 'PortHub leases -- check before binding a port', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  docs: [
    { id: null, syntax: 'tc docs', purpose: "shared documents in this pane's project groups, with its notice setting for each", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'lock', syntax: 'tc docs lock <doc> [--ttl <minutes>]', purpose: "takes the document's lock in this launch's own name, 30 minutes unless --ttl (1-120) says otherwise", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'no other session may already hold the lock', exitRefusal: '3 LOCK_CONFLICT when another session holds it' },
    { id: 'unlock', syntax: 'tc docs unlock <doc>', purpose: 'releases the lock this session holds', authority: 'the session holding the lock', statePreconditions: 'this session must hold the lock', exitRefusal: '3 NOT_LOCK_HOLDER otherwise' },
    { id: 'base', syntax: 'tc docs base <doc>', purpose: 'observes the document and prints a digest to save before an edit; attests nothing yet', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'attest', syntax: 'tc docs attest <doc> --base <saved-digest>', purpose: 'attests the edit made from the saved base', authority: 'the session holding the lock', statePreconditions: 'the digest must be the exact one tc docs base printed before the edit', exitRefusal: _GENERIC_EXIT },
    { id: 'mute', syntax: 'tc docs mute <doc> | tc docs mute --group <group>', purpose: "sets this project's notice setting for one document, or for a whole group -- never both in the same call", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none; a document setting overrides its group\'s', exitRefusal: _GENERIC_EXIT },
    { id: 'unmute', syntax: 'tc docs unmute <doc> | tc docs unmute --group <group>', purpose: 'clears the notice setting, same as default', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'subscribe', syntax: 'tc docs subscribe <doc> | tc docs subscribe --group <group>', purpose: 'sets the notice setting to subscribe', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'default', syntax: 'tc docs default <doc> | tc docs default --group <group>', purpose: 'clears the notice setting, same as unmute', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  rules: [
    { id: null, syntax: 'tc rules', purpose: "this project's durable session rules and their review state", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  learnings: [
    { id: null, syntax: 'tc learnings', purpose: "this project's recorded cross-session learnings", authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  usage: [
    { id: 'windows', syntax: 'tc usage windows [--provider <id>] [--sprint-start <iso-date-or-epoch-ms>]', purpose: '5h/weekly/monthly usage & quota window telemetry per provider/model, parsed from each engine\'s own local transcript log', authority: _ANY_LAUNCHED_SESSION, statePreconditions: 'none', exitRefusal: _GENERIC_EXIT },
    { id: 'calibrate', syntax: 'tc usage calibrate --provider <id> [--weekly-pct <n>] [--five-hour-pct <n>]', purpose: "records an operator's percentage correction against a provider's own reported headroom", authority: 'the operator', statePreconditions: 'none', exitRefusal: _GENERIC_EXIT }
  ],
  model: [
    { id: 'switch', syntax: 'tc model switch <project> --engine <id> --model <id> [--effort <level>] [--mode boundary|outage-takeover] [--reason <text>]', purpose: 'a governed model/engine switch for a live session', authority: 'governed -- boundary mode only at a clean chunk boundary; outage-takeover for a session that has stopped answering', statePreconditions: '`boundary` mode requires the session provably at a clean chunk boundary; `outage-takeover` snapshots the worktree before terminating it', exitRefusal: _GENERIC_EXIT }
  ]
});

/**
 * Every record in {@link SUBVERB_MANIFEST} for one verb, validated against
 * the live `VERB_ROSTER` -- fails loudly rather than returning a silently
 * stale manifest for a verb that has since been renamed or removed.
 * @param {string} verbId
 * @returns {SubverbSpec[]}
 * @throws {Error} When `verbId` is not in `VERB_ROSTER`, or `SUBVERB_MANIFEST`
 *   has no entry for a verb `VERB_ROSTER` does have.
 */
function subverbsFor(verbId) {
  if (!VERB_ROSTER.some((v) => v.id === verbId)) {
    throw new Error(`subverbsFor: "${verbId}" is not in VERB_ROSTER`);
  }
  const specs = SUBVERB_MANIFEST[verbId];
  if (!specs) {
    throw new Error(`subverbsFor: VERB_ROSTER has "${verbId}" but SUBVERB_MANIFEST does not -- update SUBVERB_MANIFEST`);
  }
  return specs;
}

/**
 * Parity check (Architect Ruling A2070 bullet 1 / the issue's own
 * acceptance criterion): every `VERB_ROSTER` verb has a `SUBVERB_MANIFEST`
 * entry, every `SUBVERB_MANIFEST` key is a real `VERB_ROSTER` verb, and --
 * PRR-B I-Gate Round 2/4 on PR #2841 -- for EVERY verb whose implementation
 * exposes its own ground-truth subverb list ({@link IMPLEMENTATION_SUBVERBS}),
 * every IMPLEMENTED subverb id has its OWN manifest record. The top-level
 * `missing`/`stale` check alone passed with three of `bridge nickname`'s
 * writes folded into one `id: 'nickname'` record and `circuit ack` recorded
 * as `circuit` -- both wrong ids that nonetheless satisfied "bridge is a
 * VERB_ROSTER key with a manifest entry." Checking the verb-level and
 * subverb-level questions separately, across every verb with a real ground
 * truth to check against (not only `bridge`), is what catches both kinds
 * of drift wherever they occur.
 * @returns {{missing: string[], stale: string[], subverbMismatches: Record<string, {missingFromManifest: string[], staleInManifest: string[]}>}}
 *   `missing`/`stale`: top-level VERB_ROSTER vs SUBVERB_MANIFEST keys.
 *   `subverbMismatches`: keyed by verb id, present only for a verb in
 *   {@link IMPLEMENTATION_SUBVERBS} with an actual mismatch --
 *   `missingFromManifest` ids the implementation has with no manifest
 *   record; `staleInManifest` manifest records for an id the
 *   implementation does not have.
 */
function subverbManifestParity() {
  const rosterIds = new Set(VERB_ROSTER.map((v) => v.id));
  const manifestIds = new Set(Object.keys(SUBVERB_MANIFEST));
  const subverbMismatches = {};
  for (const [verbId, implementedIds] of Object.entries(IMPLEMENTATION_SUBVERBS)) {
    const manifestSubIds = new Set((SUBVERB_MANIFEST[verbId] || []).map((s) => s.id));
    const implementedSet = new Set(implementedIds);
    const missingFromManifest = [...implementedSet].filter((id) => !manifestSubIds.has(id));
    const staleInManifest = [...manifestSubIds].filter((id) => !implementedSet.has(id));
    if (missingFromManifest.length > 0 || staleInManifest.length > 0) {
      subverbMismatches[verbId] = { missingFromManifest, staleInManifest };
    }
  }
  return {
    missing: [...rosterIds].filter((id) => !manifestIds.has(id)),
    stale: [...manifestIds].filter((id) => !rosterIds.has(id)),
    subverbMismatches
  };
}

/**
 * Which verb ids each role's primer carries, in the order they are printed.
 * Every id here must exist in `VERB_ROSTER` -- {@link buildOperatingPrimer}
 * checks this at build time, not silently.
 * @type {Readonly<Record<string, string[]>>}
 */
const ROLE_VERB_IDS = Object.freeze({
  // A Builder lane: identity, launch onboarding, switchboard, workload
  // reporting, HOLD/STOP, branch safety, and retiring itself when done.
  // Never `rotation` -- a worker is never the coordinator role that runs it.
  worker: ['help', 'whoami', 'capabilities', 'start', 'message', 'workload', 'control', 'branch', 'finalize'],
  // A reviewer lane: the same identity/launch/switchboard/workload/control
  // surfaces as a worker, minus branch safety and finalize -- a reviewer
  // does not retire sessions or judge its own branch.
  reviewer: ['help', 'whoami', 'capabilities', 'start', 'message', 'workload', 'control'],
  // An appointed Architect/PM coordinator: everything a worker has, plus
  // managed rotation -- the one verb this role alone is expected to run.
  coordinator: ['help', 'whoami', 'capabilities', 'start', 'message', 'workload', 'control', 'rotation', 'branch', 'finalize'],
  // The Project Master: fleet-wide session visibility and the operator
  // bridge, not a single lane's own onboarding/workload verbs.
  master: ['help', 'whoami', 'capabilities', 'sessions', 'message', 'bridge', 'control', 'ports']
});

/**
 * The one fact every role's primer states the same way, in the roster's own
 * words (`docs/tc-cli-reference.md`'s "Keeping this page true" section is
 * the fuller, generated-from-the-same-roster reference).
 * @type {string}
 */
const START_NEXT_VS_REVIEW_NOTE = 'New or unattested launch: `tc start next`. '
  + 'Already-attested session after `/clear` or compaction: `tc start review`.';

/**
 * The sandbox note the issue's own acceptance criteria names explicitly,
 * matching `bin/tc`'s real `API_UNREACHABLE_FROM_CONTEXT` error text so the
 * primer never carries a paraphrase the real error can drift away from.
 * @type {string}
 */
const SANDBOX_UNREACHABLE_NOTE = 'An API-unreachable result (exit 2, `API_UNREACHABLE_FROM_CONTEXT`) is not proof '
  + 'the TangleClaw server is down -- a managed sandbox can block localhost even while the host service is '
  + 'healthy. Say so and stop; do not report an outage from this alone.';

/**
 * Build one role's compact operating primer, composed from `VERB_ROSTER`.
 * @param {'worker'|'reviewer'|'coordinator'|'master'} role
 * @returns {string} Markdown text, one trailing newline
 * @throws {Error} When `role` is not one {@link ROLE_VERB_IDS} names, or that
 *   role names a verb id `VERB_ROSTER` no longer has -- a stale role list is
 *   a build-time failure, never a silently thinner primer.
 */
function buildOperatingPrimer(role) {
  const ids = ROLE_VERB_IDS[role];
  if (!ids) {
    throw new Error(`buildOperatingPrimer: unknown role "${role}" (expected one of: ${Object.keys(ROLE_VERB_IDS).join(', ')})`);
  }
  const lines = [`# TangleClaw operating primer -- ${role}`, ''];
  lines.push(START_NEXT_VS_REVIEW_NOTE, '');
  lines.push(SANDBOX_UNREACHABLE_NOTE, '');
  lines.push('## Verbs', '');
  for (const id of ids) {
    const entry = VERB_ROSTER.find((v) => v.id === id);
    if (!entry) {
      throw new Error(`buildOperatingPrimer: role "${role}" names "${id}", which is no longer in VERB_ROSTER -- update ROLE_VERB_IDS`);
    }
    lines.push(`- \`${entry.usage}\` -- ${entry.summary}`);
  }
  lines.push('', 'Full reference: `docs/tc-cli-reference.md`. Machine-readable manifest: `tc help --json`.');
  return lines.join('\n') + '\n';
}

module.exports = {
  ROLE_VERB_IDS,
  START_NEXT_VS_REVIEW_NOTE,
  SANDBOX_UNREACHABLE_NOTE,
  SUBVERB_MANIFEST,
  IMPLEMENTATION_SUBVERBS,
  subverbsFor,
  subverbManifestParity,
  buildOperatingPrimer
};
