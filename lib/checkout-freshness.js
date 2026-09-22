'use strict';

/**
 * One project's checkout, compared against the upstream every related session
 * shares (#1678).
 *
 * Composes three caches — the clone's own facts (`checkout-state`), one
 * observation of `origin/main` per repository (`upstream-observer`), and the
 * clone's comparison against that observed SHA (`checkout-state.compareSnapshot`)
 * — into the `checkout` block the project route, the session page and the
 * launch prime all read. Composing in one place is what keeps them from
 * computing different answers for the same clone.
 *
 * Every read here is synchronous and cached; a read starts at most one
 * background refresh of each cache and never waits on git. The launch route,
 * which may wait a little, calls {@link refreshForLaunch} first, bounded.
 *
 * **Relation without a remote.** A project with no origin remote (an advisory
 * workspace beside a repository, say) is related to a repository only through
 * an explicit relation: a project group whose other members share exactly one
 * repository identity. It then shows that repository's upstream, labeled as a
 * related repository with no checkout comparison. Never by name or directory.
 *
 * @module lib/checkout-freshness
 */

const path = require('node:path');
const checkoutState = require('./checkout-state');
const upstreamObserver = require('./upstream-observer');
const behindOrigin = require('./behind-origin');
const serverInfo = require('./server-info');
const store = require('./store');

/** Longest the launch route waits for the checkout and upstream to be read. */
const LAUNCH_WAIT_MS = 5000;

/** Seam for tests. */
const _internal = {
  now: () => Date.now(),
  installRoot: () => path.resolve(serverInfo._internal.repoRoot),
  startupSha: () => serverInfo.getStartupSha(),
  activeSession: (projectId) => store.sessions.getActive(projectId)
};

/**
 * Whether a project's directory is the running install's own repository. A
 * string comparison of resolved paths: nothing here touches a project's
 * directory from the server process.
 *
 * @param {{path?: string}} project
 * @returns {boolean}
 */
function _isInstall(project) {
  return !!(project && typeof project.path === 'string' && path.resolve(project.path) === _internal.installRoot());
}

/**
 * @param {{path: string, name: string}} project
 * @returns {{dir: string, name: string}}
 */
function _member(project) {
  return { dir: project.path, name: project.name };
}

/**
 * An `upstream` block with nothing observed.
 * @param {string} state
 * @param {string} reason
 * @returns {object}
 */
function _noUpstream(state, reason) {
  return { identity: null, via: null, state, sha: null, observedAt: null, reason, observedFrom: null, lastKnown: null };
}

/**
 * Whether a measured checkout has, as a fact, no origin to observe — the
 * only case a group relation may stand in for one.
 * @param {object} cs - Checkout snapshot.
 * @returns {boolean}
 */
function _hasNoRemote(cs) {
  if (cs.state === 'no-git') return true;
  return cs.state === 'measured' && !!cs.repository && cs.repository.identity === null
    && cs.repository.reason === 'no origin remote';
}

/**
 * The upstream of a project with no remote, through its groups: the one
 * repository identity the other members of its groups share.
 *
 * @param {object} project - Store row.
 * @param {{enabled: boolean}} opts
 * @returns {object} The `upstream` block.
 */
function _groupUpstream(project, opts) {
  const none = _noUpstream;
  const groups = store.projectGroups.getByProject(project.id);
  if (!groups.length) return none('none', 'no origin remote and no project group relating it to a repository');
  const found = new Map(); // identity -> { member, groupName }
  let undetermined = null; // 'pending' or 'unknown' when a member could not be read
  for (const g of groups) {
    const ids = new Map();
    let groupUndetermined = null;
    for (const pid of store.projectGroups.listMembers(g.id)) {
      if (pid === project.id) continue;
      const row = store.projects.get(pid);
      if (!row || !row.path) continue;
      const cs = checkoutState.snapshot(row.path);
      // A member not read yet could name a second repository, so "exactly
      // one" is unproven until every member is read.
      if (cs.state === 'pending') { groupUndetermined = groupUndetermined || 'pending'; continue; }
      if (cs.state === 'unknown') { groupUndetermined = 'unknown'; continue; }
      const id = cs.repository && cs.repository.identity;
      if (id && !ids.has(id)) ids.set(id, _member(row));
    }
    if (groupUndetermined) {
      if (undetermined !== 'unknown') undetermined = groupUndetermined;
      continue;
    }
    if (ids.size === 1) {
      const [[id, member]] = [...ids];
      if (!found.has(id)) found.set(id, { member, groupName: g.name });
    }
  }
  if (found.size > 1) return none('none', 'its groups relate it to more than one repository');
  if (undetermined) return none(undetermined, 'group members not all read yet');
  if (found.size === 1) {
    const [[identity, { member, groupName }]] = [...found];
    return { identity, via: 'group', groupName, ...upstreamObserver.snapshot(identity, member, opts) };
  }
  return none('none', 'no group relates it to exactly one repository');
}

/**
 * The comparison of HEAD against the observed upstream SHA.
 *
 * @param {object} project
 * @param {object} cs - Checkout snapshot.
 * @param {object} upstream - The `upstream` block.
 * @returns {{ahead: number|null, behind: number|null, relation: string, reason: string|null}}
 */
function _vsUpstream(project, cs, upstream) {
  const unknown = (reason) => ({ ahead: null, behind: null, relation: 'unknown', reason });
  if (upstream.via === 'group') {
    return { ahead: null, behind: null, relation: 'not-compared', reason: 'related repo, no checkout comparison' };
  }
  if (cs.state !== 'measured') return unknown(cs.reason || 'checkout not measured');
  if (!upstream.sha) return unknown(upstream.reason || 'upstream not observed');
  if (!cs.headSha) return unknown('HEAD commit unreadable');
  return checkoutState.compareSnapshot(project.path, cs.headSha, upstream.sha);
}

/**
 * What the running server loaded against what is on disk — only for the
 * project whose directory is the running install.
 *
 * @param {object} cs - Checkout snapshot of the install.
 * @returns {object|null}
 */
function _runtime(cs) {
  const startupSha = _internal.startupSha();
  const currentDiskSha = cs.state === 'measured' ? cs.headSha : null;
  const known = !!(startupSha && currentDiskSha);
  const isStale = known ? startupSha !== currentDiskSha : null;
  return {
    startupSha: startupSha || null,
    currentDiskSha,
    isStale,
    restartImpact: isStale === true
      ? checkoutState.impactSnapshot(_internal.installRoot(), startupSha, currentDiskSha)
      : null
  };
}

/**
 * The `checkout` block for one project, synchronously, from the caches. Starts
 * background refreshes of any cache that has expired.
 *
 * @param {object} project - Store row (`id`, `name`, `path`).
 * @param {object} [options]
 * @param {object|null} [options.config] - Loaded global config, for the network opt-out.
 * @returns {object}
 */
function projectCheckout(project, options = {}) {
  const opts = { enabled: behindOrigin.isCheckEnabled(options.config) };
  const cs = checkoutState.snapshot(project.path);
  const identity = cs.repository ? cs.repository.identity : null;
  let upstream;
  if (identity) {
    upstream = { identity, via: 'origin', ...upstreamObserver.snapshot(identity, _member(project), opts) };
  } else if (_hasNoRemote(cs)) {
    upstream = _groupUpstream(project, opts);
  } else {
    // Not measured yet, or unreadable: the clone may well have a remote, so
    // relating it through a group would claim a relation nobody established.
    upstream = _noUpstream(cs.state === 'pending' ? 'pending' : 'unknown',
      cs.state === 'pending' ? 'checkout not measured yet' : ((cs.repository && cs.repository.reason) || 'repository unknown'));
  }
  const active = project.id !== undefined && project.id !== null ? _internal.activeSession(project.id) : null;
  return {
    ...cs,
    upstream,
    vsUpstream: _vsUpstream(project, cs, upstream),
    owner: { project: project.name, sessionId: active ? active.id : null },
    runtime: _isInstall(project) ? _runtime(cs) : null
  };
}

/**
 * Warm the caches for a launch, so the prime reads a measured checkout rather
 * than `pending`. Waits at most `timeoutMs`; past that the prime says what is
 * still unmeasured. Resolves — never rejects.
 *
 * @param {object} project - Store row.
 * @param {object|null} config
 * @param {number} [timeoutMs=LAUNCH_WAIT_MS]
 * @returns {Promise<void>}
 */
async function refreshForLaunch(project, config, timeoutMs = LAUNCH_WAIT_MS) {
  const opts = { enabled: behindOrigin.isCheckEnabled(config) };
  const work = (async () => {
    const cs = await checkoutState.refresh(project.path);
    const identity = cs.repository ? cs.repository.identity : null;
    if (!identity) return;
    const up = await upstreamObserver.refreshIfStale(identity, _member(project), opts);
    if (cs.headSha && up.sha) await checkoutState.compareRefresh(project.path, cs.headSha, up.sha);
  })();
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([work.catch(() => {}), bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minutes or seconds since an ISO time, for prose.
 *
 * @param {string|null} iso
 * @returns {string|null}
 */
function _age(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((_internal.now() - t) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** @param {string|null} sha @returns {string} */
function _short(sha) {
  return sha ? sha.slice(0, 7) : '?';
}

/**
 * Where HEAD is, in words.
 * @param {object} c - The checkout block.
 * @returns {string}
 */
function _where(c) {
  if (c.detached) return `detached${c.tag ? ` at tag ${c.tag}` : ' (no tag)'} @${_short(c.headSha)}`;
  return `${c.branch || '(unknown branch)'} @${_short(c.headSha)}`;
}

/**
 * The comparison against upstream, in words.
 * @param {object} c - The checkout block.
 * @returns {string}
 */
function _relationText(c) {
  const up = c.upstream;
  const target = `origin/main${up.sha ? ` @${_short(up.sha)}` : ''}`;
  const seen = up.sha
    ? ` (observed ${_age(up.observedAt) || 'at an unknown time'}${up.observedFrom ? ` via ${up.observedFrom}` : ''})`
    : '';
  const v = c.vsUpstream;
  switch (v.relation) {
    case 'equal': return `level with ${target}${seen}`;
    case 'ahead': return `${v.ahead} ahead of ${target}${seen}`;
    case 'behind': return `${v.behind} behind ${target}${seen}`;
    case 'diverged': return `${v.ahead} ahead / ${v.behind} behind ${target}${seen}`;
    case 'pending': return `comparison with ${target}${seen} in progress`;
    case 'behind-unknown': return `behind ${target}${seen}, count unknown: ${v.reason}`;
    case 'not-compared': return `related repo ${up.identity} (via group ${up.groupName}) at ${target}${seen}, no checkout comparison`;
    default: {
      if (up.state === 'disabled') return 'upstream not observed: the behind-origin check is turned off';
      if (up.state === 'pending') return 'upstream not observed yet';
      return `vs ${target}: unknown (${v.reason || up.reason || 'no reason given'})`;
    }
  }
}

/**
 * Uncommitted and untracked counts, in words; unknown when unread.
 * @param {object} c
 * @returns {string}
 */
function _treeText(c) {
  if (c.dirtyTracked === null || c.untracked === null) return 'working tree unknown';
  if (c.dirtyTracked === 0 && c.untracked === 0) return 'clean';
  const parts = [];
  if (c.dirtyTracked) parts.push(`${c.dirtyTracked} uncommitted`);
  if (c.untracked) parts.push(`${c.untracked} untracked`);
  return parts.join(', ');
}

/**
 * The running-versus-disk line for the install's own project.
 * @param {object} runtime
 * @returns {string}
 */
function _runtimeText(runtime) {
  if (runtime.isStale === null) {
    if (!runtime.startupSha) return 'Server: the commit it started on is unknown — restart impact unknown.';
    return `Server: running ${_short(runtime.startupSha)}, on-disk commit unknown — restart impact unknown.`;
  }
  if (runtime.isStale === false) return `Server: running the on-disk commit ${_short(runtime.startupSha)}.`;
  const impact = runtime.restartImpact ? runtime.restartImpact.impact : 'unknown';
  const words = {
    'records-only': 'records-only, no restart needed',
    executable: 'code changed, a restart loads it',
    mixed: 'code and records changed, a restart loads the code',
    pending: 'restart impact being classified'
  }[impact] || 'restart impact unknown';
  return `Server: running ${_short(runtime.startupSha)}, disk ${_short(runtime.currentDiskSha)} — ${words}.`;
}

/**
 * Prime lines for the `state` step. Always at least one line, so an
 * unmeasured checkout is said rather than omitted. Informational: it
 * describes, and authorizes nothing.
 *
 * @param {object|null} c - The checkout block from {@link projectCheckout}.
 * @returns {string[]}
 */
function primeLines(c) {
  if (!c) return ['_Checkout: unknown — not read for this launch._', ''];
  if (c.state === 'no-git') {
    const up = c.upstream || {};
    if (up.via === 'group' && up.identity) return [`_Checkout: not a git checkout; ${_relationText(c)}._`, ''];
    return ['_Checkout: not a git checkout._', ''];
  }
  if (c.state === 'pending') return ['_Checkout: not measured yet — unknown, not clean._', ''];
  if (c.state !== 'measured') return [`_Checkout: **unknown** — ${c.reason || 'the probe could not answer'}. Not clean: TangleClaw could not look._`, ''];
  const lines = [`_Checkout: ${_where(c)}, ${_relationText(c)}; ${_treeText(c)}._`];
  if (c.runtime) lines.push(`_${_runtimeText(c.runtime)}_`);
  lines.push('');
  return lines;
}

module.exports = {
  projectCheckout,
  refreshForLaunch,
  primeLines,
  LAUNCH_WAIT_MS,
  _internal
};
