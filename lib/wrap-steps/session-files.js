'use strict';

/**
 * `session-files` wrap step (#1406) — before the wrap writes anything, find the
 * uncommitted files this session did not change and ask the operator what to do
 * with each.
 *
 * The commit step used to run `git add -A`, so the operator's own uncommitted
 * work, and a co-resident session's, went into the wrap commit. The commit now
 * stages only what `./_file-ownership` allows. This step exists so the question
 * arrives at the start of the wrap, before any AI step runs, rather than at the
 * commit after all of them. The commit step checks again, because it is the step
 * that would do the damage.
 *
 * **Outcomes.**
 * - `done` — every uncommitted file is this session's, or has a decision. The
 *   output names what will be included and what will be left.
 * - `blocked` (a blocker) — at least one file needs a decision. The output lists
 *   each with the reason it is not the session's, and the drawer renders an
 *   Include / Leave choice per file that rides back as `options.pathDecisions`.
 * - `needs-operator` — every file is settled, but TangleClaw state files are
 *   still tracked by git (#1512). The drawer offers Stop tracking / Keep tracking
 *   for exactly those paths, riding back as `options.untrackState`.
 * - `skipped` — the work tree is not a git repository.
 *
 * **Secrets (#1513).** Every file the wrap could commit, and every file it asks
 * about, is also scanned for credential patterns (`./_secret-check`). A match
 * the operator has not decided on joins the same Include / Leave list, naming
 * the rule that matched and never the matched text, and the outcome is written
 * to the activity log. The commit step scans again after the wrap's own writes.
 *
 * **File kinds (#1858).** A runtime database is withheld outright and named;
 * every other file asked about carries a recommendation (Include for a
 * TangleClaw plan, Keep local for scratch) that the drawer shows beside an
 * unchecked choice. The output carries a manifest of what the wrap would
 * commit, keep local and withhold, and exact ignore lines for what stays local.
 *
 * Also reports the tree being wrapped when it is a worktree the session moved
 * into (#1469), since this is the first row the operator reads.
 */

const { createLogger } = require('../logger');
const ownership = require('./_file-ownership');
const fileSafety = require('./_file-safety');
const untrack = require('./_untrack-offer');
const wrapState = require('../wrap-state');
const { configRootOf } = require('./_config-root');
const secretCheck = require('./_secret-check');
const upstream = require('./_upstream-provenance');
const governance = require('../governance-state');
const behindOrigin = require('../behind-origin');
const store = require('../store');
const { execFileArgs } = require('../exec');

const log = createLogger('wrap-step-session-files');

/** Bound on the status read; `git status` is normally instant. */
const EXEC_TIMEOUT_MS = 30 * 1000;

/**
 * Step handler.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Scoped project record (`path` is the work tree)
 * @param {object} [context.scope] - The wrap run's scope (`lib/wrap-scope.js`)
 * @param {object} [context.options] - Reads `pathDecisions` and `untrackState`
 * @returns {Promise<{ok:boolean, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project, scope } = context;
  const workTree = scope && scope.worktreeTarget ? scope.workTree : null;
  if (scope && !scope.workToplevel && scope.workTreeProblem) {
    // Git failed rather than answering "not a repository": the wrap cannot tell
    // which files are the session's, and saying "not a git repository" would send
    // the operator to the wrong fix.
    return {
      ok: false,
      status: 'blocked',
      output: {
        workTree,
        remediation: `The wrap could not read this project's git repository, so it cannot tell which uncommitted files are this session's: ${scope.workTreeProblem}. Fix what git reports, then Retry.`
      },
      blockers: [`git could not be read: ${scope.workTreeProblem}`]
    };
  }
  if (!project || !project.path || !scope || !scope.workToplevel) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'not a git repository, so there are no uncommitted files to sort', workTree },
      blockers: []
    };
  }

  const res = await _internal.exec('git', ownership.statusArgs(), { cwd: project.path });
  if (res.exitCode !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim();
    return {
      ok: false,
      status: 'blocked',
      output: {
        workTree,
        remediation: res.timedOut
          ? '`git status` was stopped before it answered, so the wrap cannot tell which uncommitted files are this session\'s. An index lock left by another git process, or a very large untracked tree, is the usual cause. Check the repo, then Retry.'
          : 'The wrap could not read the uncommitted files, so it cannot tell which are this session\'s. Run `git status` in the project to see why, then Retry.'
      },
      blockers: [res.timedOut
        ? `git status did not finish and was stopped (${res.error || 'timed out'})`
        : `git status failed (exit ${res.exitCode})${detail ? `: ${detail}` : ''}`]
    };
  }

  const decisions = ownership.sanitizeDecisions(context.options && context.options.pathDecisions);
  const decisionBasis = ownership.sanitizeDecisionBasis(context.options && context.options.pathDecisionBasis);
  const dirty = ownership.parseStatus(res.stdout);
  // #1868 — this wrap run's one look at upstream. Later steps compare against
  // the commit recorded here and never fetch.
  const provenance = await _internal.captureProvenance(scope.workToplevel, dirty);
  const secrets = secretCheck.check(scope.workToplevel, ownership.classify(scope, dirty, {
    decisions,
    decisionBasis,
    provenance,
    // #1738 — the same prefixes the commit step withholds, from the same
    // run-resolved capability, so this row never asks about a path the commit
    // would refuse whatever the answer.
    withheldPrefixes: governance.withheldPrefixesFor(context.methodology)
  }), decisions);
  const classified = secrets.classified;
  const summary = {
    workTree,
    // #1469: a session with a pane that is NOT being wrapped in a worktree says
    // why, so a failed pane read cannot silently put the wrap back on the checkout.
    checkoutReason: !workTree && scope.workTreeReason
      && !/^(no pane to read|pane is inside the registered checkout)$/.test(scope.workTreeReason)
      ? scope.workTreeReason : null,
    ownedCount: classified.owned.length,
    included: classified.included,
    left: classified.left,
    // #1508/#1509 — TangleClaw's own files, sorted out before anyone is asked.
    tangleclawMaintenance: classified.tangleclawMaintenance,
    tangleclawState: classified.tangleclawState,
    methodologyWithheld: classified.methodologyWithheld,
    secretScan: secrets.report,
    // #1858 — runtime databases withheld whatever was answered, the Includes
    // that were ignored for them, the whole picture by path, and ignore lines.
    safetyWithheld: classified.safetyWithheld,
    refusedIncludes: classified.refusedIncludes,
    // #1868 — where this checkout stands against upstream, what upstream
    // already holds, and the Includes that were not honored because of it.
    provenance: upstream.summaryOf(provenance),
    provenanceHeadline: upstream.headline(upstream.summaryOf(provenance)),
    provenanceVerdicts: upstream.verdictsOf(provenance),
    alreadyUpstream: classified.alreadyUpstream,
    provenanceRefusedIncludes: classified.provenanceRefusedIncludes,
    provenanceChanged: classified.provenanceChanged,
    manifest: ownership.manifestOf(classified, secrets.undecided, secrets.report.left),
    ignoreSuggestions: await _ignoreSuggestions(scope.workToplevel, dirty, classified, secrets.undecided)
  };
  if (classified.provenanceRefusedIncludes.length > 0) {
    log.info('ignored an Include for a file upstream already holds; it stays out of the wrap commit', {
      project: project.name, paths: classified.provenanceRefusedIncludes
    });
  }
  if (classified.refusedIncludes.length > 0) {
    log.warn('ignored an Include for a protected file; it stays out of the wrap commit', {
      project: project.name, paths: classified.refusedIncludes
    });
  }
  // Recorded on a skip as well as a match, the same condition the commit step
  // uses: "scanned everything, nothing matched" and "could not read three of
  // them" must not look alike in the log (#1513).
  if (secrets.report.flagged.length > 0 || secrets.report.skipped.length > 0) {
    secretCheck.record({
      project, session: context.session, stepId: (context.step && context.step.id) || 'session-files',
      blocked: secrets.undecided.length > 0, report: secrets.report
    });
  }

  if (secrets.undecided.length > 0) {
    log.info('wrap waiting on the operator for uncommitted files', {
      project: project.name, notThisSession: secrets.foreignUndecided.length, secretMatches: secrets.secretUndecided.length
    });
    return {
      ok: false,
      status: 'blocked',
      output: {
        ...summary,
        foreignPaths: secrets.undecided,
        remediation: _provenancePrefix(summary) + secretCheck.remediation(secrets) + _protectedNote(classified) + _upstreamNote(classified)
      },
      blockers: secretCheck.blockerLines(secrets)
    };
  }

  // #1512 — asked only once the Include / Leave choices are settled, so one Retry
  // never carries two unrelated kinds of question.
  const offer = await _untrackOffer(context, scope.workToplevel);
  if (offer.error) {
    // Reading which state files are tracked failed. The offer is a convenience,
    // so the wrap goes on; the row says why nothing was offered.
    log.warn('could not list tracked TangleClaw state files; no un-track offer this wrap', { project: project.name, error: offer.error });
    summary.untrackProblem = offer.error;
  } else if (offer.ask) {
    return {
      ok: false,
      status: 'needs-operator',
      output: { ...summary, untrackOffer: { paths: offer.pending }, remediation: untrack.remediation(offer.pending) },
      blockers: [untrack.blockerLine(offer.pending)]
    };
  } else {
    summary.untrackState = offer.untrack;
    summary.untrackDeclined = offer.recordDecline ? offer.pending : [];
  }

  return { ok: true, status: 'done', output: { ...summary, detail: _detail(summary) }, blockers: [] };
}

/**
 * Exact, anchored ignore lines for the files this wrap keeps local or recommends
 * keeping local. A root-level local directory is offered only when git tracks
 * nothing under it (`./_file-safety` owns the rest of that rule).
 *
 * @param {string} toplevel - Repository root.
 * @param {Array<{path:string}>} dirty - From `ownership.parseStatus`.
 * @param {object} classified - The narrowed classification.
 * @param {Array<{path:string, recommendation?:(string|null)}>} undecided - Files still asked about.
 * @returns {Promise<string[]>}
 */
async function _ignoreSuggestions(toplevel, dirty, classified, undecided) {
  const keptLocal = [
    ...classified.safetyWithheld,
    ...classified.foreign.filter((f) => f.recommendation === 'leave' && !classified.included.includes(f.path)).map((f) => f.path)
  ];
  const seenDirs = new Map();
  for (const p of keptLocal) {
    const first = p.split('/')[0];
    if (p.includes('/') && !seenDirs.has(first)) {
      const r = await _internal.exec('git', ['ls-files', '-z', '--', `${first}/`], { cwd: toplevel });
      // An unreadable answer counts as "tracked": the exact path is always safe.
      seenDirs.set(first, r.exitCode !== 0 || String(r.stdout || '').length > 0);
    }
  }
  const dirtyPaths = dirty.map((f) => f.path);
  const kinds = new Map();
  for (const f of classified.foreign) kinds.set(f.path, f.kind);
  for (const p of classified.safetyWithheld) kinds.set(p, fileSafety.CLASSES.PROTECTED);
  // `undecided` is listed so a secret-flagged file still awaiting an answer is
  // counted as something a directory line could hide.
  for (const f of undecided) if (!kinds.has(f.path)) kinds.set(f.path, fileSafety.CLASSES.AMBIGUOUS);
  return fileSafety.ignoreSuggestions(keptLocal, {
    dirty: dirtyPaths,
    hasTracked: (dir) => seenDirs.get(dir) !== false,
    // A path this wrap would commit or has not classed (the session's own edits)
    // is not local, so it keeps a directory line from being offered.
    classOf: (p) => kinds.get(p) || fileSafety.CLASSES.AMBIGUOUS
  });
}

/**
 * The checkout's position against upstream, as the remediation's first line.
 *
 * @param {{provenanceHeadline?:string}} summary
 * @returns {string}
 */
function _provenancePrefix(summary) {
  return summary.provenanceHeadline ? `${summary.provenanceHeadline}\n` : '';
}

/**
 * Sentences for the remediation about files upstream already holds and
 * Includes that upstream's newer facts overrode (#1868).
 *
 * @param {{alreadyUpstream:string[], provenanceRefusedIncludes:string[], provenanceChanged:string[]}} classified
 * @returns {string}
 */
function _upstreamNote(classified) {
  let out = '';
  if (classified.alreadyUpstream.length) {
    out += `\nAlready upstream, not committed and kept on disk as they are: ${classified.alreadyUpstream.join(', ')}.`;
  }
  if (classified.provenanceRefusedIncludes.length) {
    out += ` Include was ignored for ${classified.provenanceRefusedIncludes.join(', ')}: upstream already has that exact content.`;
  }
  if (classified.provenanceChanged.length) {
    out += `\nUpstream changed after you answered, so choose again for: ${classified.provenanceChanged.join(', ')}.`;
  }
  return out;
}

/**
 * A sentence for the remediation when protected files were withheld.
 *
 * @param {{safetyWithheld:string[], refusedIncludes:string[]}} classified
 * @returns {string}
 */
function _protectedNote(classified) {
  if (!classified.safetyWithheld.length) return '';
  const refused = classified.refusedIncludes.length
    ? ` Include was ignored for ${classified.refusedIncludes.join(', ')}.`
    : '';
  return `\nWithheld, with no choice to make: ${classified.safetyWithheld.join(', ')} (${fileSafety.WHY.protected}).${refused}`;
}

/**
 * Resolve the un-track offer for this wrap, and remember a decline.
 *
 * @param {object} context - Pipeline runner context.
 * @param {string} toplevel - The work tree's repository root.
 * @returns {Promise<{pending:string[], ask:boolean, untrack:string[], recordDecline:boolean, error:(string|null)}>}
 */
async function _untrackOffer(context, toplevel) {
  const listed = await untrack.listTrackedState(_internal.exec, toplevel);
  if (listed.error) return { pending: [], ask: false, untrack: [], recordDecline: false, error: listed.error };
  const configRoot = configRootOf(context.project);
  const offer = untrack.resolve({
    tracked: listed.paths,
    declined: wrapState.readUntrackDeclined(configRoot),
    answer: untrack.sanitizeAnswer(context.options && context.options.untrackState)
  });
  if (offer.recordDecline) {
    try {
      const remembered = wrapState.recordUntrackDeclined(configRoot, offer.pending);
      if (!remembered.recorded) log.warn('the declined un-track offer was not remembered; the next wrap asks again', { reason: remembered.reason });
    } catch (err) {
      // Not remembering costs one repeat question next wrap; it must not stop this one.
      log.warn('could not remember the declined un-track offer; the next wrap asks again', { error: err.message });
    }
  }
  return { ...offer, error: null };
}

/**
 * One line for the drawer row.
 *
 * @param {{workTree:(string|null), checkoutReason:(string|null), ownedCount:number, included:string[], left:string[],
 *   tangleclawMaintenance?:string[], tangleclawState?:string[], untrackState?:string[], untrackDeclined?:string[],
 *   untrackProblem?:string, secretScan?:object, methodologyWithheld?:string[],
 *   safetyWithheld?:string[], refusedIncludes?:string[], alreadyUpstream?:string[], provenance?:object}} s
 * @returns {string}
 */
function _detail(s) {
  const parts = [];
  if (s.workTree) parts.push(`Wrapping worktree ${s.workTree}`);
  else if (s.checkoutReason) parts.push(`Wrapping the registered checkout (${s.checkoutReason})`);
  parts.push(`${s.ownedCount} changed since launch`);
  if (s.included.length) parts.push(`${s.included.length} included by you`);
  if (s.left.length) parts.push(`${s.left.length} left uncommitted`);
  const maintenance = (s.tangleclawMaintenance || []).length;
  const state = (s.tangleclawState || []).length;
  if (maintenance) parts.push(`${maintenance} TangleClaw update${maintenance === 1 ? '' : 's'} to commit`);
  if (state) parts.push(`${state} TangleClaw state file${state === 1 ? '' : 's'} not committed`);
  const untracking = (s.untrackState || []).length;
  if (untracking) parts.push(`${untracking} TangleClaw state file${untracking === 1 ? '' : 's'} to stop tracking`);
  const declined = (s.untrackDeclined || []).length;
  if (declined) parts.push(`kept ${declined} TangleClaw state file${declined === 1 ? '' : 's'} tracked, as you chose`);
  if (s.untrackProblem) parts.push(`could not check for tracked TangleClaw state (${s.untrackProblem})`);
  // #1738 — said on the row that lists the session's files, so a Prawduct edit
  // made on an engine that cannot run Prawduct is visibly held back, not lost.
  const withheld = (s.methodologyWithheld || []).length;
  if (withheld) parts.push(`${withheld} Prawduct file${withheld === 1 ? '' : 's'} not committed: this engine cannot run Prawduct`);
  const upstreamCount = (s.alreadyUpstream || []).length;
  if (s.provenance && s.provenance.ref && Number.isInteger(s.provenance.behind) && s.provenance.behind > 0) {
    parts.push(`${s.provenance.behind} behind ${s.provenance.ref}`);
  }
  if (upstreamCount) parts.push(`${upstreamCount} already on ${(s.provenance && s.provenance.ref) || 'upstream'}, not committed`);
  const safety = (s.safetyWithheld || []).length;
  if (safety) parts.push(`${safety} database file${safety === 1 ? '' : 's'} withheld: a wrap never commits one`);
  const refused = (s.refusedIncludes || []).length;
  if (refused) parts.push(`Include ignored for ${refused} database file${refused === 1 ? '' : 's'}`);
  const secretPhrase = s.secretScan ? secretCheck.detailPhrase(s.secretScan) : null;
  if (secretPhrase) parts.push(secretPhrase);
  return parts.join(' · ');
}

const _internal = {
  exec: (file, args, options) => execFileArgs(file, args, {
    cwd: options.cwd, timeoutMs: EXEC_TIMEOUT_MS, maxBufferBytes: 5 * 1024 * 1024
  }),
  /**
   * Whether the one upstream refresh may reach the network. It follows the
   * same switches as the behind-origin check (`behindOriginCheckEnabled`,
   * `TC_BEHIND_ORIGIN_DISABLED`), so an install that turned network checks off
   * gets none from a wrap either.
   *
   * @returns {boolean}
   */
  refreshEnabled: () => {
    let config = null;
    try {
      config = store.config.load();
    } catch (err) {
      // An unreadable config leaves the default in force (on), as behind-origin does.
      log.debug('could not load config for the upstream refresh switch; default applies', { error: err.message });
    }
    return behindOrigin.isCheckEnabled(config);
  },
  /**
   * Capture this run's upstream provenance.
   *
   * @param {string} toplevel
   * @param {Array<object>} dirty
   * @returns {Promise<object>}
   */
  captureProvenance: (toplevel, dirty) => upstream.capture(toplevel, dirty, { refresh: _internal.refreshEnabled() })
};

module.exports = { run, _internal, _detail };
