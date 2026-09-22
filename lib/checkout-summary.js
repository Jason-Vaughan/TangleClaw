'use strict';

/**
 * The words for one project's checkout (#1678): the one wording the launch
 * prime and the session page's chip both show, so the two cannot describe the
 * same state two ways. Pure rendering over the block
 * `checkout-freshness.projectCheckout` builds; it reads no cache and runs no
 * git. Unknown is said as unknown, never omitted and never as clean or level.
 *
 * @module lib/checkout-summary
 */

/** Seam for tests. */
const _internal = {
  now: () => Date.now()
};

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
    mixed: 'code changed, a restart loads it',
    pending: 'restart impact not classified yet'
  }[impact] || 'restart impact unknown';
  return `Server: running ${_short(runtime.startupSha)}, disk ${_short(runtime.currentDiskSha)} — ${words}.`;
}

/**
 * The checkout in sentences — the one wording the prime and the session
 * page's chip both show, so they cannot drift. Always at least one sentence,
 * so an unmeasured checkout is said rather than omitted.
 *
 * @param {object|null} c - The checkout block from {@link projectCheckout}, without `summary`.
 * @returns {string[]}
 */
function describe(c) {
  if (!c) return ['Checkout: unknown — not read.'];
  if (c.state === 'no-git') {
    const up = c.upstream || {};
    if (up.via === 'group' && up.identity) return [`Checkout: not a git checkout; ${_relationText(c)}.`];
    if (up.state === 'pending') return ['Checkout: not a git checkout; related repository not determined yet.'];
    return ['Checkout: not a git checkout.'];
  }
  if (c.state === 'pending') return ['Checkout: not measured yet — unknown, not clean.'];
  if (c.state !== 'measured') return [`Checkout: unknown — ${c.reason || 'the probe could not answer'}. Not clean: TangleClaw could not look.`];
  const lines = [`Checkout: ${_where(c)}, ${_relationText(c)}; ${_treeText(c)}.`];
  if (c.runtime) lines.push(_runtimeText(c.runtime));
  return lines;
}

/**
 * Prime lines for the `state` step: {@link describe}, in the prime's
 * italic aside style. Informational: it describes, and authorizes nothing.
 *
 * @param {object|null} c - The checkout block from {@link projectCheckout}.
 * @returns {string[]}
 */
function primeLines(c) {
  return [...describe(c).map((l) => `_${l}_`), ''];
}

module.exports = {
  describe,
  primeLines,
  _internal
};
