'use strict';

/**
 * A durable, action-scoped merge constraint / hold engine (#1717 Slice 1).
 *
 * The Architect's direction on #1717 (2026-09-20) rejected an unread Medusa
 * inbox as the source of merge authority: workspace ids rotate across a
 * relaunch and strand messages, a ruling addressed to one session is
 * invisible to a different session that holds the merge, and server-side
 * auto-merge fires with no agent reading any inbox at all. "A durable
 * action-scoped constraint record must carry the authority" instead
 * (Ruling A500-W1B-R1, `#issuecomment-5751848965` / `#issuecomment-6646387670`).
 *
 * This module is that record and the gate over it: a **hold** is persisted
 * against a stable action identity (`repo` + `pr`, with `branch` and `issue`
 * as aliases of the same action) independent of which session wrote or
 * reads it. `checkActionGate`/`evaluateMergeGate` are read-only evaluations
 * any caller runs before an irreversible shared action; `issueHold`,
 * `acknowledgeHold` and `overrideHold` are the only ways a hold's state
 * changes, and each one is itself recorded, never inferred from a counter.
 *
 * Deliberately self-contained: no database, no HTTP, no GitHub call. It
 * takes the file it persists to as an explicit argument rather than reading
 * a global location, so it needs nothing initialized to be tested, and so
 * Slice 2 (`#2878`: wiring this into the live merge routes, the `tc` CLI,
 * and a GitHub required status check) decides where that file actually
 * lives in production.
 *
 * @module lib/merge-inbox-gate
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const stagedWrite = require('./staged-write');

/** Staging-name prefix for `stagedWrite.writeAtomic`, distinct per caller. */
const STAGING_PREFIX = '.merge-inbox-gate.';

/** Lock directory suffix for the store's own read-modify-write. */
const LOCK_SUFFIX = '.lock';

/** A lock older than this is presumed abandoned by a holder that crashed. */
const LOCK_STALE_MS = 30 * 1000;

/** Give up acquiring the lock after this long, rather than block forever. */
const LOCK_MAX_WAIT_MS = 2000;

/**
 * Every action this gate knows about. `commit` is local and amendable, so it
 * gets a soft advisory; the rest are irreversible shared actions and get a
 * hard gate (Architect direction: "commits get a soft advisory... merges,
 * releases, restarts and similar shared irreversible actions require
 * acknowledgement").
 */
const ACTIONS = Object.freeze(['commit', 'merge', 'auto-merge', 'release', 'restart']);

/** Actions a matching active hold blocks outright, pending ack/supersession/override. */
const HARD_GATE_ACTIONS = Object.freeze(['merge', 'auto-merge', 'release', 'restart']);

/** Actions a matching active hold only advises about. */
const SOFT_ACTIONS = Object.freeze(['commit']);

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
const MAX_TEXT = 1000;

/** Seams for tests: the clock and the id source. */
const _internal = {
  now: () => new Date().toISOString(),
  id: () => `hold_${crypto.randomBytes(8).toString('hex')}`
};

/**
 * A refusal, in the one shape every write and every gate answers with when
 * it cannot proceed.
 * @param {string} code - A short, stable code.
 * @param {string} message - What was refused and why, for a person.
 * @param {object} [extra] - Further fields for the caller.
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

/**
 * A trimmed, non-empty string no longer than `max`, or null.
 * @param {*} value - Candidate text.
 * @param {number} [max] - Longest length allowed.
 * @returns {string|null}
 */
function _text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/**
 * A positive integer, or null.
 * @param {*} value - Candidate.
 * @returns {number|null}
 */
function _posInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Validate and normalize an action identity: `repo` plus at least one of
 * `pr`, `branch` or `issue` as an alias of the same action.
 * @param {*} identity - Candidate `{repo, pr?, branch?, issue?}`.
 * @returns {{repo: string, pr: number|null, branch: string|null, issue: number|null}|null}
 */
function _identity(identity) {
  const i = identity || {};
  const repo = _text(i.repo, 200);
  if (!repo || !REPO_RE.test(repo)) return null;
  const pr = i.pr === undefined || i.pr === null ? null : _posInt(i.pr);
  const branch = i.branch === undefined || i.branch === null ? null : _text(i.branch, 255);
  const issue = i.issue === undefined || i.issue === null ? null : _posInt(i.issue);
  if (i.pr != null && pr === null) return null;
  if (i.branch != null && (branch === null || !BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/'))) return null;
  if (i.issue != null && issue === null) return null;
  if (pr === null && branch === null && issue === null) return null;
  return { repo, pr, branch, issue };
}

/**
 * Whether two action identities name the same action: same repo, and at
 * least one of `pr`/`branch`/`issue` given on both sides and equal. This is
 * the alias matching the Architect direction asks for — a hold issued
 * against a pull request number still matches a later check that only knows
 * the branch, as long as the hold or the check itself recorded both.
 * @param {object} a - A normalized identity.
 * @param {object} b - A normalized identity.
 * @returns {boolean}
 */
function _sameAction(a, b) {
  if (a.repo !== b.repo) return false;
  return (a.pr != null && a.pr === b.pr)
    || (a.branch != null && a.branch === b.branch)
    || (a.issue != null && a.issue === b.issue);
}

/**
 * A short-lived exclusive lock for one read-modify-write of the store: an
 * atomic directory create as the mutex, a stale lock broken rather than
 * honoured forever, and giving up after a bounded wait rather than blocking
 * a caller indefinitely. Same posture as `lib/branch-ownership.js#_acquireLock`.
 * @param {string} file - The store file this lock protects.
 * @returns {string|null} The lock path to pass to `_releaseLock`, or `null`
 *   if it could not be acquired within the wait budget.
 */
function _acquireLock(file) {
  const lockPath = `${file}${LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      let stale;
      try {
        stale = (Date.now() - fs.statSync(lockPath).mtimeMs) > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* another holder cleared it first */ }
        continue;
      }
      if (Date.now() >= deadline) return null;
      const spinUntil = Date.now() + 25;
      while (Date.now() < spinUntil) { /* short, local, synchronous — no async primitive to await here */ }
    }
  }
}

/**
 * Release a lock from `_acquireLock`. Idempotent and silent if already gone.
 * @param {string|null} lockPath - What `_acquireLock` returned.
 * @returns {void}
 */
function _releaseLock(lockPath) {
  if (!lockPath) return;
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* already gone */ }
}

/**
 * Whether `value` is a hold this module's own write paths could have
 * produced — checked on every read so a corrupt or foreign file is refused
 * outright rather than silently treated as empty (which would let a write on
 * top of it discard every other hold already recorded).
 * @param {*} value - Candidate hold.
 * @returns {boolean}
 */
function _isValidHold(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.holdId !== 'string' || !value.holdId) return false;
  if (!Number.isInteger(value.sequence) || value.sequence < 1) return false;
  if (!_identity(value)) return false;
  if (!['active', 'acknowledged', 'superseded'].includes(value.status)) return false;
  if (!Array.isArray(value.overrides)) return false;
  return true;
}

/**
 * Read the store, distinguishing a genuinely absent file (`{}`, `ok:true`)
 * from one that exists but is not readable or not a valid holds map.
 * @param {string} file - Absolute path to the store.
 * @returns {{ok: true, holds: Object<string, object>}|{ok: false}}
 */
function _readStoreStrict(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, holds: {} };
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    for (const [key, hold] of Object.entries(parsed)) {
      if (key !== hold.holdId || !_isValidHold(hold)) return { ok: false };
    }
    return { ok: true, holds: parsed };
  } catch {
    return { ok: false };
  }
}

/**
 * Write the store atomically via the repo's shared staged-write helper.
 * `_acquireLock` already ensured the directory exists.
 * @param {string} file - Absolute path to the store.
 * @param {Object<string, object>} holds - The full holdId → hold map.
 * @returns {void}
 */
function _writeStoreAtomic(file, holds) {
  stagedWrite.writeAtomic(file, `${JSON.stringify(holds, null, 2)}\n`, STAGING_PREFIX);
}

/**
 * Read-modify-write the store under the lock, in one step. Refuses outright
 * — never falls back to an empty store — when the file exists but is
 * corrupt, and skips the update (never applies it unlocked) when the lock
 * could not be acquired in time.
 * @param {string} file - Absolute path to the store.
 * @param {function(Object<string, object>): *} mutate - Mutates the holds map in place.
 * @returns {*} Whatever `mutate` returned; `{ok:false, code:'LOCK_TIMEOUT', ...}` if the
 *   lock could not be acquired; `{ok:false, code:'CORRUPT_STORE', ...}` if the file is unreadable.
 */
function _withStore(file, mutate) {
  const lockPath = _acquireLock(file);
  if (!lockPath) {
    return _refuse('LOCK_TIMEOUT', `Could not acquire the merge-inbox-gate store's lock within ${LOCK_MAX_WAIT_MS}ms.`);
  }
  try {
    const read = _readStoreStrict(file);
    if (!read.ok) {
      return _refuse('CORRUPT_STORE', `${file} exists but is not a valid merge-inbox-gate store; refusing to write over it.`);
    }
    const holds = read.holds;
    const result = mutate(holds);
    _writeStoreAtomic(file, holds);
    return result;
  } finally {
    _releaseLock(lockPath);
  }
}

/**
 * Read the store for a plain DISPLAY accessor only (`getHold`, `listHolds`,
 * `matchingHolds`): an absent or corrupt file reads as empty, because there
 * is nothing a read-only listing can do about corruption beyond showing
 * none. Never used by `checkActionGate` — a gate reads the store strictly
 * itself and fails closed on exactly the corruption this function hides.
 * @param {string} file - Absolute path to the store.
 * @returns {Object<string, object>}
 */
function _readStore(file) {
  const read = _readStoreStrict(file);
  return read.ok ? read.holds : {};
}

/**
 * A hold as callers see it: the stored shape, unchanged. Exposed as its own
 * function so every reader goes through one place if the shape ever grows.
 * @param {object} hold - A stored hold.
 * @returns {object}
 */
function _view(hold) {
  return { ...hold, overrides: hold.overrides.map((o) => ({ ...o })) };
}

/**
 * Issue a hold against an action identity: a ruling, in force, that an
 * irreversible shared action matching this identity (or any of its pr/
 * branch/issue aliases) must be acknowledged, superseded or scoped-overridden
 * before it proceeds. Persisted independent of who issues it and who later
 * checks it — the whole point of making the inbox not the authority.
 *
 * `supersedes`, when given, atomically marks that earlier hold `superseded`
 * in the same write: "supersession of the named hold" is a newer hold
 * explicitly saying which one it replaces, not a bare state flip with no
 * record of what superseded it.
 *
 * @param {string} file - Absolute path to the store.
 * @param {object} input - `{repo, pr?, branch?, issue?, reason, issuedBy, supersedes?}`.
 *   `reason` and `issuedBy` are free text, at most 1000 characters each.
 * @returns {{ok: true, hold: object}|{ok: false, code: string, message: string}}
 */
function issueHold(file, input) {
  const i = input || {};
  const identity = _identity(i);
  if (!identity) return _refuse('INVALID_IDENTITY', 'A hold needs repo plus at least one of pr, branch or issue.');
  const reason = _text(i.reason);
  if (!reason) return _refuse('INVALID_INPUT', `reason is required, at most ${MAX_TEXT} characters.`);
  const issuedBy = _text(i.issuedBy, 200);
  if (!issuedBy) return _refuse('INVALID_INPUT', 'issuedBy is required: who or what is issuing this hold.');
  const supersedes = i.supersedes === undefined || i.supersedes === null ? null : _text(i.supersedes, 200);
  if (i.supersedes != null && !supersedes) return _refuse('INVALID_INPUT', 'supersedes must be a hold id.');

  return _withStore(file, (holds) => {
    if (supersedes) {
      const prior = holds[supersedes];
      if (!prior) return _refuse('HOLD_NOT_FOUND', `No such hold ${supersedes} to supersede.`);
      if (prior.status !== 'active') return _refuse('HOLD_NOT_ACTIVE', `Hold ${supersedes} is already ${prior.status}; nothing to supersede.`);
    }
    const holdId = _internal.id();
    const at = _internal.now();
    // A monotonic counter, not issuedAt, orders holds: the lock serializes writes to one at a
    // time, but two issued back-to-back can still land on the same millisecond, and "newest
    // first" must stay well-defined even then.
    const sequence = 1 + Object.values(holds).reduce((max, h) => Math.max(max, h.sequence || 0), 0);
    const hold = {
      holdId, repo: identity.repo, pr: identity.pr, branch: identity.branch, issue: identity.issue,
      reason, issuedBy, issuedAt: at, sequence, status: 'active', resolution: null, overrides: []
    };
    if (supersedes) {
      holds[supersedes].status = 'superseded';
      holds[supersedes].resolution = { kind: 'superseded', by: issuedBy, at, supersededBy: holdId };
    }
    holds[holdId] = hold;
    return { ok: true, hold: _view(hold) };
  });
}

/**
 * Acknowledge an active hold: the explicit, recorded act that clears it for
 * every action, by someone who read it — never inferred from silence or
 * from an unread-message counter reaching zero.
 * @param {string} file - Absolute path to the store.
 * @param {string} holdId - The hold to acknowledge.
 * @param {object} input - `{by, note?}`. `by` is who acknowledged it.
 * @returns {{ok: true, hold: object}|{ok: false, code: string, message: string}}
 */
function acknowledgeHold(file, holdId, input) {
  const i = input || {};
  const by = _text(i.by, 200);
  if (!by) return _refuse('INVALID_INPUT', 'by is required: who is acknowledging this hold.');
  const note = i.note === undefined || i.note === null ? null : _text(i.note);
  if (i.note != null && !note) return _refuse('INVALID_INPUT', `note, when given, must be 1 to ${MAX_TEXT} characters.`);

  return _withStore(file, (holds) => {
    const hold = holds[holdId];
    if (!hold) return _refuse('HOLD_NOT_FOUND', `No such hold ${holdId}.`);
    if (hold.status !== 'active') return _refuse('HOLD_NOT_ACTIVE', `Hold ${holdId} is already ${hold.status}.`);
    hold.status = 'acknowledged';
    hold.resolution = { kind: 'acknowledged', by, at: _internal.now(), note };
    return { ok: true, hold: _view(hold) };
  });
}

/**
 * Override a hold for one named action only: possible, but scoped to the
 * one action it names, reasoned, and itself recorded on the hold — never a
 * blanket release, and never inferred from anything but this explicit call.
 * The hold stays `active` for every other action and for a later check of
 * the same action that wants its own override.
 * @param {string} file - Absolute path to the store.
 * @param {string} holdId - The hold to override.
 * @param {object} input - `{by, reason, action}`. `action` is one of `ACTIONS`.
 * @returns {{ok: true, hold: object}|{ok: false, code: string, message: string}}
 */
function overrideHold(file, holdId, input) {
  const i = input || {};
  const by = _text(i.by, 200);
  if (!by) return _refuse('INVALID_INPUT', 'by is required: who is overriding this hold.');
  const reason = _text(i.reason);
  if (!reason) return _refuse('INVALID_INPUT', `reason is required, at most ${MAX_TEXT} characters.`);
  if (!ACTIONS.includes(i.action)) return _refuse('INVALID_INPUT', `action must be one of ${ACTIONS.join(', ')}.`);

  return _withStore(file, (holds) => {
    const hold = holds[holdId];
    if (!hold) return _refuse('HOLD_NOT_FOUND', `No such hold ${holdId}.`);
    if (hold.status !== 'active') return _refuse('HOLD_NOT_ACTIVE', `Hold ${holdId} is already ${hold.status}; there is nothing left to override.`);
    const at = _internal.now();
    hold.overrides.push({ by, reason, action: i.action, at });
    return { ok: true, hold: _view(hold) };
  });
}

/**
 * One hold.
 * @param {string} file - Absolute path to the store.
 * @param {string} holdId - Hold id.
 * @returns {object|null}
 */
function getHold(file, holdId) {
  const hold = _readStore(file)[holdId];
  return hold ? _view(hold) : null;
}

/**
 * The matching logic `matchingHolds` and `checkActionGate` share: every
 * active hold in `holdsMap` matching `identity` by repo and at least one
 * alias. Takes the holds map directly (not a file) so the strict,
 * fail-closed read `checkActionGate` needs and the lenient display read
 * `matchingHolds` offers can both feed it without duplicating the filter.
 * @param {Object<string, object>} holdsMap - A holds map, as `_readStore`/`_readStoreStrict` give it.
 * @param {object} norm - A normalized identity from `_identity`.
 * @returns {object[]}
 */
function _matchFromHoldsMap(holdsMap, norm) {
  return Object.values(holdsMap)
    .filter((hold) => hold.status === 'active' && _sameAction(hold, norm))
    .map(_view);
}

/**
 * Every active hold matching an action identity by repo and at least one
 * alias (`pr`, `branch` or `issue`) — regardless of which alias the hold was
 * originally issued under.
 *
 * Lenient on a corrupt store, like every other plain read accessor
 * (`getHold`, `listHolds`): reads as no matches rather than throwing. A
 * caller that must fail closed on corruption — `checkActionGate` and, through
 * it, `buildStatusCheckPayload`/`autoMergeAllowed` — does not call this; it
 * reads the store strictly itself.
 * @param {string} file - Absolute path to the store.
 * @param {object} identity - `{repo, pr?, branch?, issue?}`.
 * @returns {object[]}
 */
function matchingHolds(file, identity) {
  const norm = _identity(identity);
  if (!norm) return [];
  return _matchFromHoldsMap(_readStore(file), norm);
}

/**
 * Every hold recorded for one repository, newest first; optionally only
 * those still `active`.
 * @param {string} file - Absolute path to the store.
 * @param {object} [options] - `{repo, activeOnly}`.
 * @returns {object[]}
 */
function listHolds(file, options = {}) {
  const repo = options.repo ? _text(options.repo, 200) : null;
  return Object.values(_readStore(file))
    .filter((hold) => (!repo || hold.repo === repo) && (!options.activeOnly || hold.status === 'active'))
    .sort((a, b) => b.sequence - a.sequence)
    .map(_view);
}

/**
 * Evaluate whether `action` may proceed against `identity`: the one check
 * every merge, auto-merge, release, restart or commit path runs before
 * arming or executing. A hold already overridden for this exact action does
 * not block it; one overridden for a different action still does.
 *
 * Hard-gated actions (`merge`, `auto-merge`, `release`, `restart`) are
 * refused outright while an un-overridden active hold matches — not a
 * polite advisory, because these are the irreversible actions the inbox
 * design could not actually stop. `commit` never blocks on a READABLE
 * store: it reports what matched as `advisory: true` and leaves
 * `allowed: true`, because a commit is local and cheap to amend.
 *
 * Fails closed, for every action including `commit`, when the durable
 * store itself cannot be read as a valid holds map — a damaged or replaced
 * authority record is exactly the case this engine must never silently read
 * as "no holds." (I-Gate Round 1, `#2882`: a corrupt store previously fell
 * through the lenient `matchingHolds` read and came back `allowed: true`.)
 *
 * @param {object} input - `{file, action, identity}`.
 * @returns {{allowed: true, status: 'clear', action: string, holds: []}
 *   |{allowed: true, advisory: boolean, action: string, holds: object[]}
 *   |{allowed: false, status: 'hold-active', action: string, holds: object[], message: string}
 *   |{ok: false, code: string, message: string}}
 */
function checkActionGate(input) {
  const i = input || {};
  if (!ACTIONS.includes(i.action)) return _refuse('INVALID_INPUT', `action must be one of ${ACTIONS.join(', ')}.`);
  const identity = _identity(i.identity);
  if (!identity) return _refuse('INVALID_IDENTITY', 'identity needs repo plus at least one of pr, branch or issue.');

  const read = _readStoreStrict(i.file);
  if (!read.ok) {
    return _refuse('CORRUPT_STORE', `${i.file} exists but is not a valid merge-inbox-gate store; the gate fails closed rather than read it as "no holds".`);
  }
  const holds = _matchFromHoldsMap(read.holds, identity);
  const blocking = holds.filter((hold) => !hold.overrides.some((o) => o.action === i.action));

  if (SOFT_ACTIONS.includes(i.action)) {
    return { allowed: true, advisory: blocking.length > 0, action: i.action, holds: blocking };
  }
  if (blocking.length === 0) return { allowed: true, status: 'clear', action: i.action, holds: [] };
  return {
    allowed: false, status: 'hold-active', action: i.action, holds: blocking,
    message: `${blocking.length} active hold(s) block "${i.action}". Acknowledge, supersede, or scoped-override each one, then re-check.`
  };
}

/**
 * The deterministic status-check projection of an identity's holds: whether
 * a required GitHub status check reporting this would read `success` or
 * `failure`. This module computes the two states it can derive locally and
 * instantly; it never returns `pending` — Slice 2's live publisher, which
 * actually talks to GitHub, is where a `pending` projection (e.g. while a
 * check run is still being created) would belong.
 * @param {object} input - `{file, identity}`.
 * @returns {{state: 'success'|'failure', description: string, holds: object[]}
 *   |{ok: false, code: string, message: string}}
 */
function buildStatusCheckPayload(input) {
  const i = input || {};
  const gate = checkActionGate({ file: i.file, action: 'auto-merge', identity: i.identity });
  if (gate.ok === false) return gate;
  if (gate.allowed) return { state: 'success', description: 'No active merge holds.', holds: [] };
  return {
    state: 'failure',
    description: `${gate.holds.length} active hold(s) block auto-merge: ${gate.holds.map((h) => h.holdId).join(', ')}.`,
    holds: gate.holds
  };
}

/**
 * Whether server-side auto-merge may be armed or left armed for an action
 * identity right now: true exactly when the status-check projection reads
 * `success`. A hold arriving after auto-merge was armed turns this false on
 * the next read, which is the one thing a mailbox check at arm time alone
 * could never do.
 * @param {object} input - `{file, identity}`.
 * @returns {boolean}
 */
function autoMergeAllowed(input) {
  const payload = buildStatusCheckPayload(input);
  return payload.ok !== false && payload.state === 'success';
}

/**
 * The merge-specific entry point: `checkActionGate` for `merge` or
 * `auto-merge`, with the status-check projection attached, so a caller
 * arming or executing a merge reads both the gate's verdict and what a
 * required status check would say in one call.
 * @param {object} input - `{file, identity, autoMerge?}`. `autoMerge: true` evaluates the `auto-merge` action; otherwise `merge`.
 * @returns {object} `checkActionGate`'s result, plus `statusCheck`.
 */
function evaluateMergeGate(input) {
  const i = input || {};
  const action = i.autoMerge ? 'auto-merge' : 'merge';
  const gate = checkActionGate({ file: i.file, action, identity: i.identity });
  if (gate.ok === false) return gate;
  return { ...gate, statusCheck: buildStatusCheckPayload({ file: i.file, identity: i.identity }) };
}

module.exports = {
  ACTIONS,
  HARD_GATE_ACTIONS,
  SOFT_ACTIONS,
  LOCK_SUFFIX,
  LOCK_STALE_MS,
  LOCK_MAX_WAIT_MS,
  issueHold,
  acknowledgeHold,
  overrideHold,
  getHold,
  matchingHolds,
  listHolds,
  checkActionGate,
  evaluateMergeGate,
  buildStatusCheckPayload,
  autoMergeAllowed,
  _internal
};
