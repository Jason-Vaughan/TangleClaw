'use strict';

/**
 * What a project's own directory says about itself, read in the forked scanner
 * child rather than on the server's event loop (#884).
 *
 * WHY THIS IS A MODULE AND NOT A HELPER INSIDE `projects.js`. Two callers need
 * it and they must not import each other: `projects.js` renders the dashboard's
 * project list, and `actions.js` gates whether an action may run. Before this
 * existed, the gate re-derived governance with a synchronous disk read while the
 * button was rendered from the scanner's answer — two sources of truth for one
 * predicate, which `actions.js`'s own header forbids (ADR 0001).
 *
 * THE POLL AND AN OPERATOR'S CLICK ARE NOT THE SAME REQUEST, and conflating them
 * is the mistake this file is shaped to prevent. `lib/dir-scanner.js` runs two
 * scanners for that reason: the polled one opts into a per-path failure backoff,
 * because nobody asked for a ten-second poll and a directory that just refused
 * to answer is not worth another process; the interactive one deliberately does
 * neither, because someone who has granted Full Disk Access and pressed the
 * button again is owed a real answer rather than a remembered one, and their
 * click must not be killed as collateral for a hung poll. `interactive` here
 * therefore defaults to TRUE: a caller that forgets pays an extra process, which
 * is recoverable, instead of silently inheriting a five-minute cached refusal,
 * which is not.
 */

const dirScanner = require('./dir-scanner');
const { createLogger } = require('./logger');

const log = createLogger('project-facts');

/**
 * How long one project's directory gets to answer before we give up on it.
 *
 * Sized against the work actually behind it, which is no longer a single
 * existence probe: the handler runs `git.getInfo` — roughly six `execSync`
 * spawns, each capped at five seconds by `lib/git.js` — plus a governance read,
 * a config parse, and the version chain's up-to-four file reads and occasional
 * cache write. 2000ms was right when this only had to cover an `fs.access`, and
 * a cold `git.getInfo` on a large repository can legitimately exceed it. A
 * deadline shorter than the honest work is not a safety margin; it manufactures
 * the failure it is meant to detect, and does so on the path where the answer is
 * "grant Full Disk Access".
 *
 * THE DEADLINE IS NEVERTHELESS SMALLER THAN THE WORST CASE IT BOUNDS, and saying
 * otherwise would make this comment agree with itself at the cost of agreeing
 * with the code. `git.getInfo` issues roughly seven `execSync` calls, each capped
 * at 5000ms by `lib/git.js` — an honest worst case near 35s against one deadline
 * of 5s. A large or cold repository that is answering perfectly well can
 * therefore be killed and reported as unresponsive, complete with a Full Disk
 * Access hint aimed at a permission that was never the problem. It then
 * self-sustains: the kill discards `git.getInfo`'s in-child cache, so the retry
 * after the backoff is equally cold.
 *
 * Raising this number is NOT the fix — it would trade a spurious timeout for a
 * genuinely wedged directory holding the poll open five times longer. The fix is
 * to bound git's total work inside the handler and derive this from that budget,
 * so the deadline can only expire on work that never answers. Tracked rather than
 * done here because it is a change to `lib/git.js`'s contract, not to this
 * constant. The version chain added by #884 chunk 02b is not a factor either way:
 * it reads small files at the project root.
 *
 * Matched to the projects-directory walk's deadline rather than derived
 * separately, because both now bound the same thing: one round trip to a child
 * doing real filesystem and subprocess work. Callers issue these ONE AT A TIME
 * (see `listProjects`), so this bounds the work itself, not the queue in front
 * of it.
 */
const PROJECT_FACTS_TIMEOUT_MS = 5000;

/**
 * What the degraded answer looks like. Identical in shape to a genuinely missing
 * directory, because from the renderer's point of view they are the same thing —
 * `unreadable` is the only field that distinguishes "not there" from "would not
 * say".
 *
 * @param {string|null} unreadable - Why the directory could not be read, or null.
 * @param {string|null} hint - Actionable remedy, when there is one.
 * @param {string|null} code - Machine-readable cause: `SCAN_TIMEOUT`, `SCAN_CACHED`,
 *   `SCAN_ABORTED`, `SCAN_FAILED`, or `EACCES` from the child.
 * @returns {{exists: boolean, governanceState: string, git: null, config: null,
 *   version: null, unreadable: string|null, unreadableHint: string|null,
 *   unreadableCode: string|null}}
 */
function _degraded(unreadable = null, hint = null, code = null) {
  return {
    exists: false,
    governanceState: 'not-applicable',
    git: null,
    config: null,
    // Null, never a fallback string. A project whose directory would not answer
    // has no known version, and `0.0.0-dev` here would render as a fact the
    // server never established.
    version: null,
    unreadable,
    unreadableHint: hint,
    // A machine-readable cause alongside the prose. `boundary-patterns.md`
    // records that a failure crossing a contract surface carries a code so the
    // consumer never pattern-matches on message text; #885 renders this, and
    // "did not answer" and "was cancelled for a sibling" want different words.
    unreadableCode: code
  };
}

/**
 * Read whether a project's directory exists and what governs it.
 *
 * Never rejects. Every failure degrades to `_degraded()` carrying a reason, so a
 * caller renders a project it could not inspect rather than failing the request.
 *
 * The scanner's rejection vocabulary is preserved rather than flattened, because
 * the three cases mean different things to the person reading the result:
 *
 * - `tcTimedOut` — this path did not answer. On macOS that is what a protected
 *   folder does, so this is the only case that earns the Full Disk Access
 *   remedy.
 * - `tcCached` — it did not answer recently and the backoff is still open. Same
 *   remedy, but it is not new evidence, so it is logged at debug: warning again
 *   per poll would bury the real warning under six identical lines a minute.
 * - `tcAborted` — this request died because a SIBLING forced the child to be
 *   killed. It says nothing about this path, which may be perfectly healthy.
 *   Telling the operator to grant Full Disk Access here would be the exact
 *   misdiagnosis the scanner exists to remove.
 *
 * @param {object} project - Project DB row; `path`, `name` and `engineId` are read.
 * @param {object} [options] - Read options.
 * @param {boolean} [options.interactive=true] - False only for the dashboard poll.
 * @returns {Promise<{exists: boolean, governanceState: string, git: object|null,
 *   config: object|null, version: string|null, unreadable: string|null,
 *   unreadableHint: string|null, unreadableCode: string|null}>}
 */
async function readProjectFacts(project, options = {}) {
  const interactive = options.interactive !== false;
  if (!project || !project.path) return _degraded();

  const send = interactive ? dirScanner.interactiveRequest : dirScanner.request;
  const opts = {
    timeoutMs: PROJECT_FACTS_TIMEOUT_MS,
    what: `reading ${project.path}`
  };
  // Opt into the backoff ONLY for the poll. See the module header: an operator
  // who has just fixed a permission must not be answered from the cache.
  if (!interactive) opts.pathKey = project.path;

  try {
    const facts = await send('projectFacts', { dir: project.path, engineId: project.engineId }, opts);
    // The child reports its own refusals — a directory it may not read — so its
    // reason wins where present. Its raw `code` is translated here rather than
    // forwarded, so exactly one vocabulary crosses to the caller.
    const { code, ...rest } = facts;
    return {
      unreadable: null,
      unreadableHint: null,
      ...rest,
      unreadableCode: code || rest.unreadableCode || null
    };
  } catch (err) {
    if (err && err.tcAborted) {
      // Collateral, not a verdict on this directory. No hint, and no warning:
      // the kill that caused it is already logged, with the path that actually
      // hung.
      log.debug('A project directory read was cancelled when the scanner was restarted '
        + 'for another path', { project: project.name, path: project.path });
      return _degraded('the read was cancelled while another directory was being given up on',
        null, 'SCAN_ABORTED');
    }

    const hint = (err && (err.tcTimedOut || err.tcCached))
      ? 'the directory did not respond. On macOS that is what a protected folder does when '
        + 'node has no Full Disk Access. Grant it, or move the project outside ~/Documents, '
        + '~/Desktop and ~/Downloads'
      : null;

    const say = (err && err.tcCached) ? log.debug : log.warn;
    say('Could not read a project directory — the project is listed without its git and '
      + 'governance detail', {
      project: project.name,
      path: project.path,
      error: err && err.message,
      hint
    });
    let code = 'SCAN_FAILED';
    if (err && err.tcCached) code = 'SCAN_CACHED';
    else if (err && err.tcTimedOut) code = 'SCAN_TIMEOUT';
    return _degraded((err && err.message) || 'the directory did not answer', hint, code);
  }
}

module.exports = { readProjectFacts, PROJECT_FACTS_TIMEOUT_MS };
