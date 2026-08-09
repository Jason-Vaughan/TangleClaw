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
 * Shorter than the projects-directory walk's deadline because this probes a
 * single known path rather than walking an unknown number of them: nothing here
 * is legitimately slow, so a longer wait only delays the degraded answer.
 */
const PROJECT_FACTS_TIMEOUT_MS = 2000;

/**
 * What the degraded answer looks like. Identical in shape to a genuinely missing
 * directory, because from the renderer's point of view they are the same thing —
 * `unreadable` is the only field that distinguishes "not there" from "would not
 * say".
 *
 * @param {string|null} unreadable - Why the directory could not be read, or null.
 * @param {string|null} hint - Actionable remedy, when there is one.
 * @returns {{exists: boolean, governanceState: string, unreadable: string|null, unreadableHint: string|null}}
 */
function _degraded(unreadable = null, hint = null) {
  return {
    exists: false,
    governanceState: 'not-applicable',
    unreadable,
    unreadableHint: hint
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
 * @returns {Promise<{exists: boolean, governanceState: string, unreadable: string|null, unreadableHint: string|null}>}
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
    return { ...facts, unreadable: null, unreadableHint: null };
  } catch (err) {
    if (err && err.tcAborted) {
      // Collateral, not a verdict on this directory. No hint, and no warning:
      // the kill that caused it is already logged, with the path that actually
      // hung.
      log.debug('A project directory read was cancelled when the scanner was restarted '
        + 'for another path', { project: project.name, path: project.path });
      return _degraded('the read was cancelled while another directory was being given up on');
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
    return _degraded((err && err.message) || 'the directory did not answer', hint);
  }
}

module.exports = { readProjectFacts, PROJECT_FACTS_TIMEOUT_MS };
