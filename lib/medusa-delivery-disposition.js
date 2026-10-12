'use strict';

/**
 * What a held Medusa wake means for the people waiting on it (#2086).
 *
 * The wake monitor explains every wake it withholds with a reason code. A
 * code says what was observed. It does not say whether waiting will fix it,
 * and that is the thing a sender, and anyone reading the fleet's undelivered
 * list, needs to know. This module is the one place that answers it.
 *
 * Three classes:
 *
 *   - `actionable`: the recipient is live and the monitor retries by itself.
 *     A busy pane, a wrap in progress, a listener reconnecting. Waiting fixes it.
 *   - `configuration`: the recipient is live and nothing changes until someone
 *     acts. Wake not opted in, an engine with no wake profile. Waiting does not
 *     fix it.
 *   - `historical`: the recipient session is not live. Its mail went with it.
 *     The one exception is a recipient that is the same identity when it runs
 *     again, the Project Master: stopped, it is `configuration`, to be started.
 *
 * And a fourth, `none`, for the codes that are not a held wake at all (nudged,
 * no mail), which only the sender-facing answer can carry.
 *
 * Two rules decide the doubtful cases, and both fail towards a person looking:
 *
 *   - A code this table does not know is `configuration`, to be investigated.
 *     Never `actionable`, which would promise a retry nobody has shown will
 *     happen, and never `historical`, which would write the mail off.
 *   - `historical` needs a positive answer that the session is not live. Not
 *     knowing is not that answer.
 *
 * Pure: no requires, no clock of its own, nothing written. The reason
 * vocabulary is `lib/medusa-wake.js#PEER_REASON_MEANINGS`; a test holds this
 * table against it, so a new code without a class turns red.
 */

/** The classes, in the order the fleet view lists them. */
const CLASSES = Object.freeze(['actionable', 'configuration', 'historical']);

/**
 * What can be done about a held wake: a closed vocabulary, each with the one
 * sentence a person is shown. Readers print the sentence from here and keep no
 * wording of their own.
 * @type {Readonly<Object<string, string>>}
 */
const NEXT_ACTIONS = Object.freeze({
  'wait': 'nothing to do: the wake monitor retries by itself when the recipient is at rest',
  'none': 'nothing to do: no wake is being held',
  'enable-wake': 'turn on wake-on-mail for the recipient\'s project, or have its mail read by hand',
  'read-by-hand': 'this recipient is never nudged, so its mail has to be read by hand',
  'relaunch-recipient': 'relaunch the recipient session, which restores the channel its engine is judged through',
  'start-listener': 'turn the recipient\'s switchboard listener on; its mail is not arriving while it is off',
  'start-recipient': 'start the recipient; its mail waits until it is running',
  'fix-project-config': 'repair the recipient project\'s settings, which could not be read',
  'review-folder-trust': 'the recipient\'s operator may set the engine\'s entry for this folder to trusted, which resumes automatic wakes, or leave it untrusted and read the mail by hand',
  'investigate': 'look at the recipient and the server log: this is not a state the monitor explains',
  'resend': 'the recipient session has ended; send again to the session that replaced it, if there is one'
});

/**
 * Reason code to class and next action.
 * @type {Readonly<Object<string, {class: string, nextAction: string}>>}
 */
const REASONS = Object.freeze({
  // Not a held wake.
  'nudged': { class: 'none', nextAction: 'none' },
  'no-mail': { class: 'none', nextAction: 'none' },

  // The monitor retries by itself.
  'pane-at-prompt': { class: 'actionable', nextAction: 'wait' },
  'pane-no-prompt': { class: 'actionable', nextAction: 'wait' },
  'pane-composer-has-input': { class: 'actionable', nextAction: 'wait' },
  'pane-turn-in-flight': { class: 'actionable', nextAction: 'wait' },
  'pane-agents-running': { class: 'actionable', nextAction: 'wait' },
  'pane-not-at-rest': { class: 'actionable', nextAction: 'wait' },
  'pane-writing': { class: 'actionable', nextAction: 'wait' },
  'pane-capture-failed': { class: 'actionable', nextAction: 'wait' },
  'pane-read-backoff': { class: 'actionable', nextAction: 'wait' },
  'pane-read-stale': { class: 'actionable', nextAction: 'wait' },
  'pane-read-started': { class: 'actionable', nextAction: 'wait' },
  'engine-thread-busy': { class: 'actionable', nextAction: 'wait' },
  'engine-thread-settling': { class: 'actionable', nextAction: 'wait' },
  'engine-thread-unknown': { class: 'actionable', nextAction: 'wait' },
  'inject-failed': { class: 'actionable', nextAction: 'wait' },
  'wrap-running': { class: 'actionable', nextAction: 'wait' },
  'coordinator-rotating': { class: 'actionable', nextAction: 'wait' },
  'not-observed': { class: 'actionable', nextAction: 'wait' },

  // Nothing changes until someone acts.
  'wake-not-opted-in': { class: 'configuration', nextAction: 'enable-wake' },
  'unprofiled-engine': { class: 'configuration', nextAction: 'read-by-hand' },
  'no-pane': { class: 'configuration', nextAction: 'read-by-hand' },
  'master-engine-unobserved': { class: 'configuration', nextAction: 'read-by-hand' },
  'engine-channel-absent': { class: 'configuration', nextAction: 'relaunch-recipient' },
  'engine-folder-untrusted': { class: 'configuration', nextAction: 'review-folder-trust' },
  'config-unreadable': { class: 'configuration', nextAction: 'fix-project-config' },
  'no-project': { class: 'configuration', nextAction: 'investigate' },
  'not-running': { class: 'configuration', nextAction: 'start-recipient' },
  'unclassified': { class: 'configuration', nextAction: 'investigate' },
  'listener-off': { class: 'configuration', nextAction: 'start-listener' }
});

/**
 * Codes with a variable tail, by prefix. An exact entry in `REASONS` wins, so
 * `listener-off` is configuration while every other listener state is a
 * reconnect the monitor waits out.
 * @type {Readonly<Object<string, {class: string, nextAction: string}>>}
 */
const REASON_PREFIXES = Object.freeze({
  // The session is in the roster with a status that is not active.
  'session-': { class: 'historical', nextAction: 'resend' },
  'listener-': { class: 'actionable', nextAction: 'wait' }
});

/** What an unknown code is given: someone has to look. */
const UNKNOWN = Object.freeze({ class: 'configuration', nextAction: 'investigate' });

/**
 * The code a stored skip reason stands for. A failed injection is stored with
 * tmux's error text after the code (`inject-failed: <error>`).
 * @param {*} reason - A reason as stored or returned
 * @returns {string} The bare code, or an empty string
 */
function reasonCode(reason) {
  if (typeof reason !== 'string') return '';
  const code = reason.trim();
  return code.startsWith('inject-failed') ? 'inject-failed' : code;
}

/**
 * The class and next action of one reason code.
 * @param {*} reason - A reason code, bare or as stored
 * @returns {{class: string, nextAction: string, nextActionMeaning: string, known: boolean}}
 *   `known` is false for a code this table does not declare, which is then
 *   classed `configuration` with `investigate`.
 */
function classifyReason(reason) {
  const code = reasonCode(reason);
  let hit = Object.prototype.hasOwnProperty.call(REASONS, code) ? REASONS[code] : null;
  if (!hit) {
    for (const [prefix, entry] of Object.entries(REASON_PREFIXES)) {
      if (code.startsWith(prefix) && code.length > prefix.length) { hit = entry; break; }
    }
  }
  const known = hit !== null;
  const entry = hit || UNKNOWN;
  return { class: entry.class, nextAction: entry.nextAction, nextActionMeaning: NEXT_ACTIONS[entry.nextAction], known };
}

/**
 * The class and next action a sender is given for a peer's reason.
 *
 * The reason's own class, with one exception: when the wake monitor is not
 * running, nothing is retrying anything and the verdict is not being
 * refreshed. Telling a sender to wait because "the monitor retries by itself"
 * would then be false, whatever the last reason was, so the answer is
 * `configuration`, to be investigated.
 *
 * @param {*} reason - A reason code
 * @param {object} facts
 * @param {boolean} facts.monitorRunning - Whether the wake monitor is running
 * @returns {{class: string, nextAction: string, nextActionMeaning: string, known: boolean}}
 */
function classifyForSender(reason, facts) {
  const byReason = classifyReason(reason);
  if (facts && facts.monitorRunning === true) return byReason;
  return { class: UNKNOWN.class, nextAction: UNKNOWN.nextAction, nextActionMeaning: NEXT_ACTIONS[UNKNOWN.nextAction], known: byReason.known };
}

/**
 * Classify one row of the undelivered list.
 *
 * `live` is the caller's answer about the row's session, and it is three
 * valued on purpose: `true`, `false` only when something positively said the
 * session is not live, and `null` when that could not be established. A row
 * is `historical` only on `false`.
 *
 * @param {object} row - A `sessionsWithUndeliveredMail` row
 * @param {object} facts
 * @param {boolean|null} facts.live - Whether the row's session is live
 * @param {boolean} [facts.restartable=false] - Whether a recipient that is not live is the
 *   same identity when it runs again. True only for the Project Master; a project session
 *   that ended is replaced by a different one.
 * @param {string|null} [facts.lastAssessedAt] - When the monitor last looked at a live session
 * @param {boolean} [facts.monitorRunning=false] - Whether the wake monitor is running. Unless it
 *   positively is, no row is `actionable`.
 * @param {number} facts.now - Epoch milliseconds
 * @returns {object} The row, with `class`, `live`, `reason`, `since`,
 *   `lastAssessedAt`, `ageMs`, `nextAction` and `nextActionMeaning` added
 */
function classifyDelivery(row, facts) {
  const reason = reasonCode(row.skipReason);
  const byReason = classifyReason(reason);
  let verdict;
  if (facts.live === false && facts.restartable === true) {
    // Not running, and the same identity can be started again: the Project
    // Master. Its mail waits for it, so this is something to act on, not a
    // record of a session that is gone.
    verdict = { class: 'configuration', nextAction: 'start-recipient' };
  } else if (facts.live === false) {
    verdict = { class: 'historical', nextAction: 'resend' };
  } else if (facts.live !== true) {
    // Liveness unknown: not historical, and not a promise of a retry either.
    verdict = UNKNOWN;
  } else if (byReason.class === 'none' || byReason.class === 'historical') {
    // A live session listed for a code that means "not held" or "not live"
    // contradicts itself. Someone has to look.
    verdict = UNKNOWN;
  } else {
    verdict = byReason;
  }
  // `actionable` is a promise that the monitor retries by itself. A monitor
  // that is not positively running retries nothing, so the row is something
  // to look into, in the same words the sender-facing answer uses.
  if (verdict.class === 'actionable' && facts.monitorRunning !== true) verdict = UNKNOWN;
  const since = typeof row.createdAt === 'string' ? row.createdAt : null;
  const sinceMs = since === null ? NaN : Date.parse(since.includes('T') ? since : `${since.replace(' ', 'T')}Z`);
  return {
    ...row,
    class: verdict.class,
    live: facts.live === true ? true : facts.live === false ? false : null,
    reason,
    reasonKnown: byReason.known,
    since,
    lastAssessedAt: facts.live === true && typeof facts.lastAssessedAt === 'string' ? facts.lastAssessedAt : null,
    ageMs: Number.isFinite(sinceMs) && Number.isFinite(facts.now) ? Math.max(0, facts.now - sinceMs) : null,
    nextAction: verdict.nextAction,
    nextActionMeaning: NEXT_ACTIONS[verdict.nextAction]
  };
}

/**
 * The fleet view: every undelivered row classified, the same items partitioned
 * by class, and a summary.
 *
 * `undelivered` keeps the order and the membership it was given. The three
 * partitions hold the same objects, and their lengths sum to its length.
 *
 * @param {object[]} rows - Undelivered rows, in the order to return them
 * @param {object} opts
 * @param {(row: object) => {live: (boolean|null), restartable?: boolean, lastAssessedAt?: (string|null)}} opts.factsFor -
 *   What is known about a row's session. A throw is taken as liveness unknown.
 * @param {boolean} [opts.monitorRunning=false] - Whether the wake monitor is running
 * @param {number} opts.now - Epoch milliseconds
 * @returns {{undelivered: object[], actionable: object[], configuration: object[], historical: object[], summary: object}}
 */
function buildView(rows, opts) {
  const undelivered = rows.map((row) => {
    let facts;
    try {
      facts = opts.factsFor(row) || { live: null };
    } catch {
      facts = { live: null };
    }
    return classifyDelivery(row, {
      live: facts.live,
      restartable: facts.restartable === true,
      lastAssessedAt: facts.lastAssessedAt,
      monitorRunning: opts.monitorRunning === true,
      now: opts.now
    });
  });
  const view = { undelivered, actionable: [], configuration: [], historical: [] };
  for (const item of undelivered) view[item.class].push(item);
  const ages = view.actionable.map((i) => i.ageMs).filter((v) => v !== null);
  view.summary = {
    total: undelivered.length,
    actionable: view.actionable.length,
    configuration: view.configuration.length,
    historical: view.historical.length,
    oldestActionableAgeMs: ages.length ? Math.max(...ages) : null,
    unknownReasons: [...new Set(undelivered.filter((i) => !i.reasonKnown).map((i) => i.reason))].sort()
  };
  return view;
}

module.exports = {
  CLASSES, NEXT_ACTIONS, REASONS, REASON_PREFIXES,
  reasonCode, classifyReason, classifyForSender, classifyDelivery, buildView
};
