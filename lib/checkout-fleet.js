'use strict';

/**
 * The fleet's checkouts in one answer (#1678, #993): one row per project with
 * a live session, each carrying the `checkout` block
 * `checkout-freshness.projectCheckout` builds — the same function the project
 * route, the launch prime and the session chip read — so the PM, the Project
 * Master, a Builder and the operator cannot compute different answers for the
 * same clone.
 *
 * **Who sees which rows.** The caller is resolved by `lib/shared-docs-access.js`.
 * The operator and the verified Master see every live row. A bound project sees
 * its own row and the rows of the members of its project groups: the explicit
 * relation, never one inferred from a name or a directory. An unbound or
 * invalid caller sees no rows, and the answer says why.
 *
 * **Which fields.** A row's checkout is an allowlist of the block, so a field
 * added to the block later stays out of the fleet view until someone decides
 * it belongs. No row carries a workspace path. For a project caller, the two
 * fields that can name something outside what it sees — the project an
 * upstream observation was made from, and the group a relation runs through —
 * are withheld unless the caller already sees that project or group, and the
 * summary is re-rendered from the shaped block so the words never say what the
 * fields withhold.
 *
 * Read-only and cached: nothing here waits on git, and every read may start the
 * background refreshes `projectCheckout` starts.
 *
 * @module lib/checkout-fleet
 */

const store = require('./store');
const { KINDS } = require('./shared-docs-access');
const checkoutFreshness = require('./checkout-freshness');
const { describe } = require('./checkout-summary');

/** Seam for tests. */
const _internal = {
  now: () => Date.now(),
  projectCheckout: (project, options) => checkoutFreshness.projectCheckout(project, options)
};

/** The `scope` values of an answer. */
const SCOPES = Object.freeze({ FLEET: 'fleet', RELATED: 'related', NONE: 'none' });

/**
 * The projects a caller may see rows for.
 * @param {{kind: string, projectId: (number|null), groupIds: string[]}} access - From `sharedDocsAccess.resolveAccess`
 * @returns {Set<number>|null} `null` for every project; otherwise the visible ids (empty for none)
 */
function visibleProjectIds(access) {
  if (access.kind === KINDS.OPERATOR || access.kind === KINDS.MASTER) return null;
  const ids = new Set();
  if (access.kind !== KINDS.PROJECT || access.projectId === null || access.projectId === undefined) return ids;
  ids.add(access.projectId);
  for (const groupId of access.groupIds || []) {
    for (const pid of store.projectGroups.listMembers(groupId)) ids.add(pid);
  }
  return ids;
}

/**
 * Pick the named keys of an object, as a new object; null for a non-object.
 * @param {object|null|undefined} obj
 * @param {string[]} keys
 * @returns {object|null}
 */
function _pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of keys) out[k] = obj[k] === undefined ? null : obj[k];
  return out;
}

/**
 * Copy an array of strings, or give an empty one.
 * @param {*} value
 * @returns {string[]}
 */
function _strings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

/**
 * The fleet-view shape of one checkout block.
 *
 * @param {object} block - From `checkoutFreshness.projectCheckout`.
 * @param {object} [opts]
 * @param {(name: string) => boolean} [opts.seesProject] - Whether the caller already sees a project, by name.
 *   Absent: the caller sees every project.
 * @param {(name: string) => boolean} [opts.seesGroup] - Whether the caller is in a group, by name.
 *   Absent: the caller sees every group.
 * @returns {object}
 */
function shapeCheckout(block, opts = {}) {
  const seesProject = opts.seesProject || (() => true);
  const seesGroup = opts.seesGroup || (() => true);
  const up = block.upstream || {};
  const upstream = {
    identity: up.identity === undefined ? null : up.identity,
    via: up.via === undefined ? null : up.via,
    groupName: typeof up.groupName === 'string' && seesGroup(up.groupName) ? up.groupName : null,
    state: up.state === undefined ? null : up.state,
    sha: up.sha === undefined ? null : up.sha,
    observedAt: up.observedAt === undefined ? null : up.observedAt,
    reason: up.reason === undefined ? null : up.reason,
    observedFrom: typeof up.observedFrom === 'string' && seesProject(up.observedFrom) ? up.observedFrom : null,
    lastKnown: _pick(up.lastKnown, ['sha', 'observedAt'])
  };
  const rt = block.runtime;
  const shaped = {
    state: block.state,
    reason: block.reason === undefined ? null : block.reason,
    measuredAt: block.measuredAt === undefined ? null : block.measuredAt,
    branch: block.branch === undefined ? null : block.branch,
    detached: block.detached === undefined ? null : block.detached,
    tag: block.tag === undefined ? null : block.tag,
    onDefaultBranch: block.onDefaultBranch === undefined ? null : block.onDefaultBranch,
    headSha: block.headSha === undefined ? null : block.headSha,
    unpushed: _pick(block.unpushed, ['count', 'against']),
    dirtyTracked: block.dirtyTracked === undefined ? null : block.dirtyTracked,
    untracked: block.untracked === undefined ? null : block.untracked,
    incomplete: _strings(block.incomplete),
    repository: _pick(block.repository, ['identity', 'reason']),
    localRef: block.localRef
      ? { ..._pick(block.localRef, ['ref', 'sha', 'ahead', 'behind', 'relation']), incomplete: _strings(block.localRef.incomplete) }
      : null,
    upstream,
    vsUpstream: _pick(block.vsUpstream, ['ahead', 'behind', 'relation', 'reason']),
    owner: _pick(block.owner, ['project', 'sessionId']),
    // The deciding path list stays on /api/server-info: the fleet needs the verdict.
    runtime: rt && typeof rt === 'object'
      ? {
        ..._pick(rt, ['startupSha', 'currentDiskSha', 'isStale']),
        restartImpact: rt.restartImpact ? { impact: rt.restartImpact.impact || 'unknown' } : null
      }
      : null
  };
  shaped.summary = describe(shaped);
  return shaped;
}

/**
 * The live sessions, newest first, one per project.
 * @returns {object[]}
 */
function _liveSessionPerProject() {
  const seen = new Set();
  const out = [];
  for (const s of store.sessions.listLiveAll()) {
    if (seen.has(s.projectId)) continue;
    seen.add(s.projectId);
    out.push(s);
  }
  return out;
}

/**
 * The fleet view for one caller.
 *
 * @param {{kind: string, projectId: (number|null), groupIds: string[], reason?: (string|null)}} access -
 *   From `sharedDocsAccess.resolveAccess`.
 * @param {object} [options]
 * @param {object|null} [options.config] - Loaded global config, for the network opt-out.
 * @returns {{scope: string, reason: (string|null), observedAt: string, rows: object[]}}
 */
function fleetView(access, options = {}) {
  const observedAt = new Date(_internal.now()).toISOString();
  const visible = visibleProjectIds(access);
  if (visible !== null && visible.size === 0) {
    const reason = access.kind === KINDS.INVALID
      ? `the launch binding this request presented was not honoured (${access.reason || 'no reason given'}), so it sees no checkouts`
      : 'this request carries no launch binding, so it sees no checkouts; a TangleClaw pane sends x-tangleclaw-project-id and x-tangleclaw-launch-id';
    return { scope: SCOPES.NONE, reason, observedAt, rows: [] };
  }

  let seesProject;
  let seesGroup;
  if (visible !== null) {
    const visibleNames = new Set();
    for (const pid of visible) {
      const row = store.projects.get(pid);
      if (row) visibleNames.add(row.name);
    }
    const groupNames = new Set();
    for (const g of store.projectGroups.getByProject(access.projectId)) groupNames.add(g.name);
    seesProject = (name) => visibleNames.has(name);
    seesGroup = (name) => groupNames.has(name);
  }

  const rows = [];
  for (const session of _liveSessionPerProject()) {
    if (visible !== null && !visible.has(session.projectId)) continue;
    const project = store.projects.get(session.projectId);
    if (!project || !project.path) continue;
    const block = _internal.projectCheckout(project, { config: options.config || null });
    rows.push({
      project: { id: project.id, name: project.name },
      sessionId: session.id,
      checkout: shapeCheckout(block, { seesProject, seesGroup })
    });
  }
  rows.sort((a, b) => a.project.name.localeCompare(b.project.name));
  return {
    scope: visible === null ? SCOPES.FLEET : SCOPES.RELATED,
    reason: null,
    observedAt,
    rows
  };
}

module.exports = {
  fleetView,
  shapeCheckout,
  visibleProjectIds,
  SCOPES,
  _internal
};
