'use strict';

/**
 * Idempotent Fleet Group, shared `LANE_QUEUE` doc & Merge Queue bootstrap
 * (#2825, Architect Ruling A2825, `v5.61.0` Car 61-B Slice 1).
 *
 * Unlike this wave's other Slice 1 modules, {@link provisionFleetResources}
 * is a real orchestration function, not a pure classifier: standing up a
 * fleet's shared infrastructure necessarily means creating/reusing a real
 * Project Group, a real `sharedDir` on disk, a real registered shared
 * document, and (authority permitting) a real Merge Queue row -- there is
 * no caller-supplied-data shape that would make this pure. It calls
 * `store.projectGroups`/`store.sharedDocs` directly, reuses
 * `lib/shared-docs.js#ensureGroupSharedDir` for the filesystem half of
 * {@link module:lib/shared-docs}'s own #1305 fix rather than duplicating
 * it, and is idempotent throughout: re-running it on an already-provisioned
 * fleet reuses what exists and never clobbers `LANE_QUEUE.md`'s own
 * content or an existing queue.
 *
 * @module lib/fleet-provisioning
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const sharedDocs = require('./shared-docs');

/** `LANE_QUEUE.md`'s own filename when the caller names none. */
const DEFAULT_LANE_QUEUE_FILENAME = 'LANE_QUEUE.md';

/**
 * The scaffold `LANE_QUEUE.md` starts as, when nothing exists yet (#2825).
 * Deliberately minimal: a header and an empty table, never a presumed car
 * list -- the fleet that gets provisioned names its own cars afterward.
 * @type {string}
 */
const LANE_QUEUE_SCAFFOLD = `# Lane Queue

| Car | Builder | Reviewer | Issues | Envelope | Status |
| :-- | :-- | :-- | :-- | :-- | :-- |

_Scaffolded by TangleClaw's fleet provisioning (#2825). Replace this row as cars are assigned._
`;

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * Whether `filename` is a plain, single-component filename that
 * `path.join(sharedDir, filename)` can only ever resolve to a direct
 * child of `sharedDir` -- never a traversal out of it (PRR-B I-Gate Round
 * 1 #1 on PR #2869: `laneQueueFilename: '../outside.md'` reached
 * `path.join` unvalidated and wrote+registered a file beside `sharedDir`,
 * not inside it). No path separators of either kind, no null byte, and
 * never the bare current/parent-directory names (`path.basename('..')`
 * is `'..'` unchanged, so a separator check alone would not catch it).
 * @param {string} filename
 * @returns {boolean}
 */
function _isSafeFilename(filename) {
  return typeof filename === 'string' && filename.length > 0
    && !filename.includes('/') && !filename.includes('\\') && !filename.includes('\0')
    && filename !== '.' && filename !== '..';
}

/**
 * The group named `name`, or `null`. `store.projectGroups` has no
 * `getByName`; its own `create` enforces the same uniqueness via a UNIQUE
 * index, so a linear scan of `list()` (fleets are few; this is never a hot
 * path) is the one place that needs to know the name at all.
 * @param {string} name
 * @returns {object|null}
 */
function _findGroupByName(name) {
  return store.projectGroups.list().find((g) => g.name === name) || null;
}

/**
 * Create or reuse the fleet's Project Group (#2825 step 1), reconciling its
 * `sharedDir` to the caller's own value when an existing group's differs.
 * @param {string} groupName
 * @param {string} sharedDir
 * @returns {{group: object, created: boolean}}
 */
function _ensureGroup(groupName, sharedDir) {
  const existing = _findGroupByName(groupName);
  if (existing) {
    if (sharedDir && existing.sharedDir !== sharedDir) {
      const updated = store.projectGroups.update(existing.id, { sharedDir });
      return { group: updated, created: false };
    }
    return { group: existing, created: false };
  }
  const group = store.projectGroups.create({ name: groupName, sharedDir });
  return { group, created: true };
}

/**
 * Bind every member (and the coordinator, if given and not already named)
 * into the group (#2825 step 2). `addMember` is already idempotent at the
 * store layer (a repeat call is a silent no-op), so this never needs its
 * own membership check first.
 * @param {string} groupId
 * @param {number[]} memberProjectIds
 * @param {number|null} coordinatorProjectId
 * @returns {number[]} Every project id bound, deduplicated
 */
function _bindMembers(groupId, memberProjectIds, coordinatorProjectId) {
  const ids = new Set(memberProjectIds);
  if (Number.isInteger(coordinatorProjectId)) ids.add(coordinatorProjectId);
  for (const projectId of ids) store.projectGroups.addMember(groupId, projectId);
  return [...ids];
}

/**
 * Scaffold `LANE_QUEUE.md` inside `sharedDir` if nothing is there yet, and
 * register it as a lock-governed shared document (#2825 steps 3). Never
 * overwrites an existing file's content, whatever its own text is --
 * "never clobbering existing content on re-run" is the whole point of
 * calling this idempotent.
 *
 * Never follows a symlink at `filePath` (PRR-B I-Gate Round 2 on PR #2869:
 * with a dangling symlink there pointing outside `sharedDir`,
 * `fs.existsSync` reports it as absent and a plain `fs.writeFileSync`
 * follows the link, creating the scaffold OUTSIDE `sharedDir`). `lstat`
 * (never `exists`/`stat`) decides whether anything is already there without
 * following a link, and any existing symlink -- dangling or live -- is
 * refused outright rather than written through or silently treated as
 * "already there". The create-write itself uses `flag: 'wx'`
 * (`O_CREAT|O_EXCL`), which POSIX guarantees fails `EEXIST` on a symlink
 * path regardless of the link's own target, closing the TOCTOU window
 * between the `lstat` check and the write.
 * @param {string} sharedDirPath
 * @param {string} groupId
 * @param {string} filename
 * @returns {{path: string, scaffolded: boolean, registered: boolean}|{ok: false, code: string, message: string}}
 */
function _ensureLaneQueueDoc(sharedDirPath, groupId, filename) {
  const filePath = path.join(sharedDirPath, filename);

  let lstat = null;
  try {
    lstat = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (lstat && lstat.isSymbolicLink()) {
    return _refuse('FLEET_PROVISIONING_UNSAFE_PATH',
      `Refusing to use "${filePath}" as the lane queue: it is a symlink, which is never followed for writing.`);
  }

  let scaffolded = false;
  if (!lstat) {
    try {
      fs.writeFileSync(filePath, LANE_QUEUE_SCAFFOLD, { encoding: 'utf8', flag: 'wx' });
      scaffolded = true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        return _refuse('FLEET_PROVISIONING_UNSAFE_PATH',
          `Refusing to use "${filePath}" as the lane queue: it appeared unexpectedly during creation (possibly a symlink race).`);
      }
      throw err;
    }
  }

  let registered = false;
  try {
    store.sharedDocs.create({ groupId, name: 'LANE_QUEUE', filePath });
    registered = true;
  } catch (err) {
    // Already registered (CONFLICT, from a prior run) is success, not a
    // failure: idempotent re-provisioning must not error on its own earlier work.
    if (err.code !== 'CONFLICT') throw err;
  }
  return { path: filePath, scaffolded, registered };
}

/**
 * Initialize or reconcile the group's Merge Queue for `repoSlug` (#2825
 * step 4), when the caller supplies real operator authority. `createQueue`
 * is "Only the Operator may" by its own design -- a scoping decision this
 * module cannot route around, since the ruling's own input field list
 * names no `operatorProof`. Rather than failing the whole provisioning
 * call for want of it, the queue step is skipped and reported as such; a
 * caller with operator authority supplies `operatorProof` to actually
 * create one. An existing active queue for the same `repo`/`baseBranch`
 * is reused, not recreated (idempotent, mirroring every other step here).
 * @param {string} repoSlug
 * @param {number} ownerProjectId
 * @param {string} [operatorProof]
 * @returns {{skipped: true, reason: string}|{skipped: false, queue: (object|null), reused: boolean}}
 */
function _ensureMergeQueue(repoSlug, ownerProjectId, operatorProof) {
  if (typeof operatorProof !== 'string' || !operatorProof) {
    return { skipped: true, reason: 'no operator authority (operatorProof) was provided; the Merge Queue was not touched' };
  }
  const mergeQueueStore = require('./merge-queue-store');
  const { REFUSALS } = require('./merge-queue-state');
  const result = mergeQueueStore.createQueue({
    repo: repoSlug, baseBranch: 'main', ownerProjectId, actor: { kind: 'operator', operatorProof }
  });
  if (result.ok) return { skipped: false, queue: result.queue, reused: false };
  if (result.code === REFUSALS.QUEUE_EXISTS) {
    return { skipped: false, queue: null, reused: true };
  }
  throw new Error(`Could not initialize the Merge Queue for "${repoSlug}": ${result.message}`);
}

/**
 * Idempotently provision a fleet/strike team's shared infrastructure
 * (#2825): a Project Group, its `sharedDir`, a scaffolded and registered
 * `LANE_QUEUE.md`, and (authority permitting) its Merge Queue -- so `tc
 * docs`, `tc freshness` and `tc queue` work for a newly stood-up fleet with
 * no further manual setup. Re-running this on an already-provisioned
 * fleet reuses every existing piece and never clobbers `LANE_QUEUE.md`'s
 * own content or an existing active queue.
 * @param {object} input
 * @param {string} input.groupName
 * @param {string} input.sharedDir - Absolute path; created if missing (#1305)
 * @param {number[]} input.memberProjectIds
 * @param {number} [input.coordinatorProjectId]
 * @param {string} [input.repoSlug] - `"owner/name"`; required only to also
 *   provision the Merge Queue
 * @param {string} [input.laneQueueFilename] - Defaults to `LANE_QUEUE.md`
 * @param {string} [input.operatorProof] - Forwarded to `createQueue`'s own
 *   operator-only gate; see {@link _ensureMergeQueue}
 * @returns {{ok: true, result: {group: object, groupCreated: boolean,
 *   sharedDir: {path: string, created: boolean}, memberProjectIds: number[],
 *   laneQueue: {path: string, scaffolded: boolean, registered: boolean},
 *   mergeQueue: object}}|{ok: false, code: string, message: string}}
 */
function provisionFleetResources(input) {
  if (!input || typeof input !== 'object' || typeof input.groupName !== 'string' || !input.groupName) {
    return _refuse('FLEET_PROVISIONING_INVALID', 'input.groupName is required.');
  }
  if (typeof input.sharedDir !== 'string' || !input.sharedDir) {
    return _refuse('FLEET_PROVISIONING_INVALID', 'input.sharedDir is required.');
  }
  if (!Array.isArray(input.memberProjectIds) || input.memberProjectIds.some((id) => !Number.isInteger(id))) {
    return _refuse('FLEET_PROVISIONING_INVALID', 'input.memberProjectIds must be an array of project ids.');
  }
  if (input.laneQueueFilename !== undefined && !_isSafeFilename(input.laneQueueFilename)) {
    return _refuse('FLEET_PROVISIONING_INVALID',
      `input.laneQueueFilename must be a plain filename with no path separators: "${input.laneQueueFilename}"`);
  }

  const dirResult = sharedDocs.ensureGroupSharedDir(input.sharedDir);
  if (!dirResult.ok) return dirResult;

  const { group, created: groupCreated } = _ensureGroup(input.groupName, dirResult.path);
  const boundMemberIds = _bindMembers(group.id, input.memberProjectIds, input.coordinatorProjectId);
  const laneQueue = _ensureLaneQueueDoc(dirResult.path, group.id, input.laneQueueFilename || DEFAULT_LANE_QUEUE_FILENAME);
  if (laneQueue.ok === false) return laneQueue;

  let mergeQueue = { skipped: true, reason: 'input.repoSlug was not given' };
  if (typeof input.repoSlug === 'string' && input.repoSlug) {
    const ownerProjectId = Number.isInteger(input.coordinatorProjectId) ? input.coordinatorProjectId : boundMemberIds[0];
    mergeQueue = _ensureMergeQueue(input.repoSlug, ownerProjectId, input.operatorProof);
  }

  return {
    ok: true,
    result: {
      group, groupCreated, sharedDir: { path: dirResult.path, created: dirResult.created },
      memberProjectIds: boundMemberIds, laneQueue, mergeQueue
    }
  };
}

module.exports = {
  DEFAULT_LANE_QUEUE_FILENAME,
  LANE_QUEUE_SCAFFOLD,
  provisionFleetResources
};
