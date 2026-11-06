'use strict';

/**
 * Governed coordinator context rotation (#2032).
 *
 * A coordinator (Architect, ProjectManager) that clears its context must not
 * come back as a live-but-unoriented authority, and its control channel must
 * not stay bound to a thread that no longer exists. A rotation is an explicit
 * transition with one durable record:
 *
 *   fenced → rebinding → reconciling → active      (abandoned: operator exit,
 *                                                    from any open state OR from active —
 *                                                    see abandon()'s own doc comment)
 *
 * - **prepare** (the coordinator itself): validates and digests a structured
 *   checkpoint, records the inbox interval it leaves behind, assigns the next
 *   coordinator generation and fences the project's new outbound dispatch —
 *   all in one insert, so there is no window where the checkpoint exists and
 *   the fence does not.
 * - **advance** (the server): once the coordinator's thread is idle, injects
 *   `/clear`, then binds the ONE replacement thread the clear produced and
 *   delivers a re-entry turn through the control channel. Zero, several, or
 *   unprovable candidates bind nothing and leave a typed failure on the row.
 * - **resume** (the replacement context): submits a receipt for this
 *   generation and checkpoint digest. The server cross-checks what it can
 *   observe — the inbox interval is drained, the control generation, a fresh
 *   workload receipt — and re-observes what must not have moved at all while
 *   the coordinator was absent: its operator-granted coordinator role, and the
 *   content of its checkout. A change there is integrity drift, which no
 *   receipt can accept; it keeps the fence up for the operator. Only when all
 *   of it holds is the rotation marked active, which is what lifts the fence.
 *
 * Every step is a compare-and-set on the record and is safe to repeat: a
 * retried prepare returns the same row, a retried rebind converges on the same
 * thread, and the re-entry turn is read back before it is ever sent again.
 * Ordinary wake observation is untouched and still never replaces a recorded
 * thread; only this module's rebind, under an open rotation, may.
 *
 * Only engines with a startup-control channel that can name threads (Codex)
 * can be rebound. Other engines are refused at prepare with the reason, and
 * keep their own re-entry path (#1761 for Claude).
 *
 * @module lib/coordinator-rotation
 */

const crypto = require('node:crypto');
const store = require('./store');
const checkoutFingerprint = require('./checkout-fingerprint');
const githubFacts = require('./github-facts');
const { EXPIRY_MS: WORKLOAD_EXPIRY_MS, parseTime: parseStoreTime, receiptCurrency } = require('./workload-compose');
const { toView: workloadReceiptView } = require('./workload');
const { createLogger } = require('./logger');

const log = createLogger('coordinator-rotation');

/** Checkpoint schema this module validates. */
const CHECKPOINT_SCHEMA = 1;

/** Receipt schema this module validates. */
const RECEIPT_SCHEMA = 1;

/** Largest checkpoint or receipt accepted, in bytes of canonical JSON. */
const MAX_DOCUMENT_BYTES = 60000;

/** Most inbox ids a prepare records; more is refused rather than truncated. */
const MAX_INBOX_IDS = 300;

/** How many ADMITTED `/clear`s may be typed before the rotation says it did not take. */
const MAX_CLEAR_ATTEMPTS = 3;

/**
 * The least time between two attempts to type `/clear`, admitted or refused,
 * so a HOLD, a missing pane or a busy engine is retried at a bounded pace
 * rather than on every pass.
 */
const CLEAR_RETRY_MS = 15000;

/**
 * How long an admitted `/clear` is given to unload the old thread before the
 * rotation concludes it did not take. An engine that is slow to unload is not
 * typed at again inside this window.
 */
const CLEAR_SETTLE_MS = 20000;

/**
 * How long after an admitted `/clear` the replacement is given to settle
 * before an ambiguous picture is final. Real Codex (the live check at
 * 394aaab4) keeps the old thread loaded for a few seconds beside the new one,
 * and opens a short-lived auxiliary thread beside a thread's first turn: both
 * resolve on their own, so inside this window they are waits, not failures.
 */
const REBIND_WINDOW_MS = 120000;

/** Deepest nesting a checkpoint or receipt may have. */
const MAX_JSON_DEPTH = 32;

/** States in which a rotation holds the fence. */
const OPEN_STATES = new Set(['fenced', 'rebinding', 'reconciling']);

/**
 * How a receipt disposes of a trusted drift item (ruling A10): the change is
 * accepted as the new baseline, it supersedes the checkpoint's plan, or it is
 * handed on as follow-up work.
 */
const DRIFT_DISPOSITIONS = ['accepted', 'superseded', 'follow-up'];

/** Workload states a reconciling coordinator may resume from (ruling A8). */
const READY_STATES = new Set(['working', 'waiting-external']);

/** Adapters whose channel can name and rebind threads. */
const REBINDABLE_ADAPTERS = new Set(['codex']);

/**
 * Seams for tests. `adapter` is the Codex startup-control adapter; `inject`
 * types a command into the session's pane; `messages` reads its in-memory
 * Medusa inbox; `fingerprint` observes a checkout's content; `github` reads
 * the checkpoint's GitHub facts; `sleep` paces the driver.
 */
const _seams = {
  adapter: () => require('./startup-control-codex'),
  inject: (projectName, command, opts) => require('./sessions').injectCommand(projectName, command, opts),
  messages: (sessionId) => require('./medusa').getMessages(sessionId),
  listening: (sessionId) => require('./medusa').getStatus(sessionId).state !== 'off',
  // A project whose config cannot be read counts as switchboard-enabled, so
  // an unreadable config never excuses a dead listener.
  medusaEnabled: (projectPath) => {
    let unreadable = false;
    const cfg = store.projectConfig.load(projectPath, { onError: () => { unreadable = true; } });
    return unreadable || !cfg || cfg.medusaEnabled === true;
  },
  fingerprint: (dir, opts) => checkoutFingerprint.fingerprint(dir, opts),
  github: (facts) => githubFacts.observeAll(facts),
  launch: (projectName) => require('./sessions').launchSession(projectName, { primePrompt: true }),
  sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); }),
  // #2086: the wake monitor types nothing into a coordinator in rotation. When
  // a rotation closes it is asked to look at the session, which may hold mail.
  // Never throws: a look that cannot be requested is one its timer still makes.
  wake: (sessionId, reason) => {
    try {
      require('./medusa-wake').requestScan(sessionId, reason);
    } catch (err) {
      log.warn('Could not ask the wake monitor for a scan', { sessionId, reason, error: err.message });
    }
  },
  now: () => new Date().toISOString(),
  // #2351 — lazy-required for the same reason `wake`/`messages`/`listening`
  // above are: this file is a dependency of session-startup code, and a
  // top-level require risks a cycle through it.
  medusaStatus: (sessionId) => require('./medusa').getStatus(sessionId),
  wakeVerdict: (sessionId) => require('./medusa-wake').verdictFor(sessionId),
  unreadExchanges: (workspaceId) => store.medusaExchanges.listOpenForRecipient(workspaceId),
  createDecision: (input) => require('./decision-routing').createDecisionRequest(input),
  supersedeDecision: (decisionId, input) => require('./decision-routing').supersedeDecisionRequest(decisionId, input),
  deciderOutageEscalation: (status) => require('./model-switch').checkDeciderOutageEscalation(status),
  // #2353 — same lazy-capture shape as `lib/usage-windows.js#_defaultCapturePaneOutput`,
  // not a call into that module's own composite reading: Architect Ruling
  // A2353 wants ONLY the live pane-sourced reading (`parseSessionTerminalUsage`
  // directly), never that module's calibration-blended one.
  capturePane: async (tmuxSession) => {
    try {
      const { cap } = await require('./tmux').readPaneAsync(tmuxSession, { lines: 10 });
      return (cap && Array.isArray(cap.lines)) ? cap.lines.join('\n') : null;
    } catch {
      return null;
    }
  },
  // #2351 PRR-A I-Gate Round 2/3: a sender blocked on an unreachable decider
  // is told the fallback route, not left silently waiting. Deliberately NOT
  // caught here (unlike `wake` above): the caller tracks which senders were
  // actually notified (PRR-A Round 3 -- a transient failure must retry on
  // the next tick, not be marked done), so it needs this promise's own
  // rejection, not one already swallowed into a log line.
  notifySender: (workspaceId, message) => require('./medusa').sendSystemMessage({ to: workspaceId, message })
};

/**
 * A refusal in the route shape.
 * @param {number} status - HTTP status.
 * @param {string} code - Machine code.
 * @param {string} message - What happened, for a person.
 * @param {object} [details] - Extra fields.
 * @returns {{status: number, body: object}}
 */
function _refuse(status, code, message, details = {}) {
  return { status, body: { error: message, code, ...details } };
}

/**
 * A failed fingerprint's reason, with its cause appended when the fingerprint
 * seam captured one (#2034 item 4 — a git/fs failure's stderr or error code,
 * instead of just the bare reason the five-way branch in
 * `lib/checkout-fingerprint.js` reduces to).
 * @param {{reason: string, cause?: string}} seen - A failed `fingerprint()` result.
 * @returns {string}
 */
function _fingerprintFailureDetail(seen) {
  return seen.cause ? `${seen.reason}: ${seen.cause}` : seen.reason;
}

/**
 * JSON with object keys sorted at every level, so the same content always has
 * the same digest whatever order the caller wrote it in. Refuses nesting
 * deeper than {@link MAX_JSON_DEPTH}, so a hostile document cannot exhaust the
 * stack.
 * @param {*} value - Any JSON value.
 * @param {number} [depth=0] - Current depth (internal).
 * @returns {string}
 * @throws {RangeError} When nested too deeply.
 */
function canonicalJson(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new RangeError(`nested deeper than ${MAX_JSON_DEPTH} levels`);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 of a string, hex.
 * @param {string} text - Input.
 * @returns {string}
 */
function _sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Is `v` a plain object?
 * @param {*} v - Anything.
 * @returns {boolean}
 */
function _isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Is `v` a list of non-empty strings?
 * @param {*} v - Anything.
 * @returns {boolean}
 */
function _stringList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 1024);
}

/**
 * Check a checkpoint against the minimum the replacement context needs to
 * reconcile: who it was, what the lanes were doing, what was undecided, which
 * exchanges were open, where the checkout stood, what to do next, and a note.
 * Every section must be present, even when empty, so an omitted one reads as
 * a gap rather than as "nothing there".
 * @param {*} checkpoint - The caller's document.
 * @returns {{ok: true, digest: string, canonical: string}|{ok: false, missing: string[], message: string}}
 */
function validateCheckpoint(checkpoint) {
  if (!_isObject(checkpoint)) return { ok: false, missing: ['checkpoint'], message: 'The checkpoint must be a JSON object.' };
  const missing = [];
  if (checkpoint.schema !== CHECKPOINT_SCHEMA) missing.push(`schema (must be ${CHECKPOINT_SCHEMA})`);
  if (typeof checkpoint.role !== 'string' || !checkpoint.role.trim() || checkpoint.role.length > 64) missing.push('role');
  for (const key of ['assignments', 'decisions', 'exchanges', 'nextActions']) {
    if (!Array.isArray(checkpoint[key])) missing.push(key);
  }
  const branch = checkpoint.branch;
  if (!_isObject(branch)) {
    missing.push('branch');
  } else {
    if (typeof branch.head !== 'string' || !branch.head) missing.push('branch.head');
    if (typeof branch.ref !== 'string' || !branch.ref) missing.push('branch.ref');
    if (!_stringList(branch.ownedDirt)) missing.push('branch.ownedDirt (every dirty path, [] when clean)');
    if (branch.importantIgnored !== undefined && (!_stringList(branch.importantIgnored) || branch.importantIgnored.length > checkoutFingerprint.MAX_IMPORTANT_IGNORED)) {
      missing.push(`branch.importantIgnored (at most ${checkoutFingerprint.MAX_IMPORTANT_IGNORED} paths)`);
    }
  }
  if (typeof checkpoint.note !== 'string' || !checkpoint.note.trim()) missing.push('note');
  const gh = githubFacts.validateFacts(checkpoint.github);
  if (!gh.ok) missing.push(`github (${gh.message})`);
  if (missing.length) return { ok: false, missing, message: `The checkpoint is incomplete: ${missing.join(', ')}.` };
  let canonical;
  try {
    canonical = canonicalJson(checkpoint);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return { ok: false, missing: [], message: `The checkpoint is ${err.message}.` };
  }
  if (Buffer.byteLength(canonical, 'utf8') > MAX_DOCUMENT_BYTES) {
    return { ok: false, missing: [], message: `The checkpoint is larger than ${MAX_DOCUMENT_BYTES} bytes.` };
  }
  return { ok: true, digest: _sha256(canonical), canonical };
}

/**
 * Check a resume receipt's shape. The facts it asserts are cross-checked
 * separately, against what the server can observe.
 * @param {*} receipt - The caller's document.
 * @returns {{ok: true}|{ok: false, missing: string[], message: string}}
 */
function validateReceipt(receipt) {
  if (!_isObject(receipt)) return { ok: false, missing: ['receipt'], message: 'The receipt must be a JSON object.' };
  const missing = [];
  if (receipt.schema !== RECEIPT_SCHEMA) missing.push(`schema (must be ${RECEIPT_SCHEMA})`);
  if (typeof receipt.checkpointDigest !== 'string') missing.push('checkpointDigest');
  if (!Array.isArray(receipt.restored) || receipt.restored.length === 0) missing.push('restored (what was restored, non-empty)');
  if (!Array.isArray(receipt.drift) || !receipt.drift.every((x) => _isObject(x) && typeof x.key === 'string' && DRIFT_DISPOSITIONS.includes(x.disposition))) {
    missing.push(`drift (a list of {key, disposition: ${DRIFT_DISPOSITIONS.join('|')}}, [] when none)`);
  }
  const r = receipt.reconciled;
  if (!_isObject(r)) {
    missing.push('reconciled');
  } else {
    if (!_isObject(r.control) || !('stateGeneration' in r.control)) missing.push('reconciled.control.stateGeneration');
    if (!_isObject(r.medusa) || !Array.isArray(r.medusa.handled)) missing.push('reconciled.medusa.handled');
  }
  if (typeof receipt.nextAction !== 'string' || !receipt.nextAction.trim()) missing.push('nextAction');
  if (missing.length) return { ok: false, missing, message: `The receipt is incomplete: ${missing.join(', ')}.` };
  let canonical;
  try {
    canonical = canonicalJson(receipt);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return { ok: false, missing: [], message: `The receipt is ${err.message}.` };
  }
  if (Buffer.byteLength(canonical, 'utf8') > MAX_DOCUMENT_BYTES) {
    return { ok: false, missing: [], message: `The receipt is larger than ${MAX_DOCUMENT_BYTES} bytes.` };
  }
  return { ok: true };
}

/**
 * The digest a rotation's re-entry turn carries as its client id, so its
 * delivery can be read back and never sent twice.
 * @param {object} rotation - The rotation.
 * @returns {string}
 */
function reentryDigest(rotation) {
  return _sha256(`tc-rotation:${rotation.rotationId}:${rotation.generation}`);
}

/**
 * The re-entry instruction the replacement thread receives. It directs
 * reconciliation; it does not replay the launch handoff as current work. It
 * carries the one-time resume nonce, which exists nowhere else in plaintext.
 * @param {object} rotation - The rotation.
 * @param {object} project - The project (its `name`).
 * @param {string} nonce - The one-time resume nonce.
 * @returns {string}
 */
function renderReentry(rotation, project, nonce) {
  const name = project && project.name ? project.name : 'this project';
  return [
    `# Coordinator context rotation — ${name}`,
    '',
    rotation.mode === 'relaunch'
      ? `This session is the relaunched successor claimed by managed rotation \`${rotation.rotationId}\` (generation ${rotation.generation}). `
        + 'Finish your own launch sequence as usual (`tc start next`, then READY), and then resume the rotation below before any coordination.'
      : `Your context was just rotated under managed rotation \`${rotation.rotationId}\` (generation ${rotation.generation}). `
        + 'This is a re-entry into a running session, not a new launch: do not restart the launch sequence or re-attest READY.',
    '',
    '**New dispatch from this project is FENCED** until your resume receipt is accepted. Until then you may only reply to, acknowledge '
      + 'or close the messages and exchanges your checkpoint recorded, publish `tc workload set`, and acknowledge your control generation.',
    '',
    'Use `tc` for every TangleClaw call (`tc message read|ack|send|close`, `tc control`, `tc workload`, `tc rotation`): it sends the '
      + 'thread header your actions are checked against, and a raw HTTP call without it is refused. Keep checkpoint and receipt files '
      + 'OUTSIDE your checkout (for example in $TMPDIR): the checkout must be unchanged when you resume.',
    '',
    rotation.mode === 'relaunch'
      ? '1. Complete your launch sequence with `tc start next` if you have not already.'
      : '1. `tc start review` — re-read the launch context you attested (read-only).',
    '2. `tc rotation show` — read the checkpoint your previous context left, and the inbox messages it left unhandled.',
    '3. Reconcile every checkpoint fact against live state: `git` in your checkout, GitHub (`gh`), `tc sessions`, '
      + '`tc control status`, and your Medusa inbox. Handle each message the rotation lists (`tc message read`, act, reply, then '
      + '`tc message ack <id>`). '
      + 'Publish a current receipt with `tc workload set`.',
    '4. Write the receipt JSON the show output describes, with this one-time nonce as its `resumeNonce` field, and run '
      + '`tc rotation resume --receipt <file>`. If it is refused, it names the missing evidence: fix that and resubmit.',
    '',
    `Resume nonce (valid once, for this rotation only): \`${nonce}\``,
    '',
    'Every coordinator action you take from now on is accepted only from this thread and this launch.',
    '',
    'Do not dispatch new work, and do not treat a narrative summary as proof, until the receipt is accepted.',
    ''
  ].join('\n');
}

/**
 * The rotation as a caller sees it. The checkpoint rides along only when asked
 * for (the replacement context reads it; status polls do not need it).
 * @param {object|null} rotation - The stored rotation.
 * @param {{checkpoint?: boolean}} [opts]
 * @returns {object|null}
 */
function view(rotation, opts = {}) {
  if (!rotation) return null;
  const out = {
    rotationId: rotation.rotationId,
    attemptKey: rotation.attemptKey,
    projectId: rotation.projectId,
    sessionId: rotation.sessionId,
    state: rotation.state,
    fenced: OPEN_STATES.has(rotation.state),
    generation: rotation.generation,
    priorThreadId: rotation.priorThreadId,
    replacementThreadId: rotation.replacementThreadId,
    clearAttempts: rotation.clearAttempts,
    reentryDelivered: !!rotation.reentryDigest,
    checkpointDigest: rotation.checkpointDigest,
    inboxIds: rotation.inboxIds,
    failure: rotation.failureCode ? { code: rotation.failureCode, detail: rotation.failureDetail } : null,
    receipt: rotation.receipt,
    role: { roleId: rotation.roleId, authorityVersion: rotation.authorityVersion },
    drift: rotation.drift,
    readiness: rotation.readiness,
    receiptVerdict: rotation.state === 'active' ? 'accepted' : (rotation.readiness ? rotation.readiness.verdict : null),
    github: rotation.github,
    mode: rotation.mode,
    // What the epoch is bound to, for the read surfaces. The launch id is
    // deliberately absent: a launch id is what a caller presents to be that
    // launch, so no view carries one.
    binding: { sessionId: rotation.sessionId, threadId: rotation.replacementThreadId || null, generation: rotation.generation },
    ...nextStep(rotation),
    createdAt: rotation.createdAt,
    updatedAt: rotation.updatedAt,
    completedAt: rotation.completedAt
  };
  if (opts.checkpoint) out.checkpoint = rotation.checkpoint;
  return out;
}

/**
 * The project's open rotation — the fence — or null.
 * @param {number|null} projectId - Project id.
 * @returns {object|null}
 */
function openRotation(projectId) {
  if (projectId == null) return null;
  return store.coordinatorRotations.getOpenForProject(projectId);
}

/** Session statuses that are persisted proof a session has ended. */
const ENDED_STATUSES = new Set([store.SESSION_STATUS.WRAPPED, store.SESSION_STATUS.KILLED, store.SESSION_STATUS.CRASHED]);

/**
 * Whether the session a rotation bound has ENDED, on persisted evidence only
 * (Architect ruling on the epoch lapse): its row records a terminal status. A
 * missing or unreadable row, or any other status, is uncertainty, and
 * uncertainty keeps the epoch's fence — it never lapses it.
 * @param {object} rotation - A rotation.
 * @returns {boolean}
 */
function _boundSessionEnded(rotation) {
  let s;
  try {
    s = store.sessions.get(rotation.sessionId);
  } catch {
    return false;
  }
  return !!s && ENDED_STATUSES.has(s.status);
}

/** Coordinator-authority mutations the epoch gate judges (ruling A12). */
const GATED_ACTIONS = new Set([
  'medusa-send', 'medusa-ack', 'exchange-close', 'medusa-retract', 'medusa-loop', 'medusa-listener',
  'workload-set', 'wrap', 'session-rule-write', 'control-mutate', 'merge-queue-mutate', 'control-ack', 'session-command'
]);

/**
 * The epoch gate (#2032, rulings A2/A11/A12): whether a coordinator-authority
 * mutation for `projectId` may proceed, or the refusal.
 *
 * - A project that never rotated, or whose latest rotation the operator
 *   abandoned, is not judged: legacy behaviour.
 * - While the rotation has no replacement yet (`fenced`, `rebinding`), every
 *   gated mutation is refused.
 * - Once a replacement is bound, a mutation is accepted only from that exact
 *   thread (the `x-tangleclaw-engine-thread` header `tc` forwards), session
 *   and launch — for the rest of that epoch, until a governed next rotation
 *   replaces it. A stale thread, another pane or an unbound caller is refused.
 *   An active epoch lapses when its bound session has ended: no context of
 *   it can act any more, so the next ordinary launch is judged as never rotated.
 * - While `reconciling`, the bound replacement may only publish workload,
 *   acknowledge its control generation, turn its Medusa listener on, and
 *   reply to, acknowledge or close what the checkpoint's interval named. New
 *   dispatch — a send, or opening, continuing or closing a loop — waits for
 *   resume.
 * - A change to a merge queue the project owns (`merge-queue-mutate`) is
 *   judged as a control command is (`control-mutate`): it is on no list of
 *   what a reconciling replacement may do, so it too waits for the resume.
 *
 * The operator is never gated: recovery stays theirs.
 * @param {object} input
 * @param {number|null} input.projectId - The coordinator project the mutation acts for.
 * @param {object|null} input.access - The caller, from `shared-docs-access#resolveAccess`.
 * @param {string|null} input.threadId - The forwarded engine thread id.
 * @param {string} input.action - One of {@link GATED_ACTIONS}.
 * @param {string} [input.inReplyTo] - For `medusa-send`, the message answered.
 * @param {string[]} [input.messageIds] - For `medusa-ack`, the messages acknowledged.
 * @param {string} [input.exchangeId] - For `exchange-close`, the exchange.
 * @param {boolean} [input.enable] - For `medusa-listener`, whether the request turns the listener on.
 * @returns {{status: number, body: object}|null} A refusal, or null to proceed.
 */
function gate({ projectId, access, threadId, action, inReplyTo, messageIds, exchangeId, enable }) {
  if (!GATED_ACTIONS.has(action)) throw new Error(`coordinator-rotation: ${action} is not a gated action`);
  if (projectId == null) return null;
  if (access && access.kind === 'operator') return null;
  const latest = store.coordinatorRotations.latestForProject(projectId);
  if (!latest || latest.state === 'abandoned') return null;
  const fenced = (why) => _refuse(409, 'COORDINATOR_FENCED',
    `This project is in managed context rotation ${latest.rotationId} (${latest.state}); ${why}.`,
    { rotationId: latest.rotationId, state: latest.state, action });
  if (latest.mode === 'relaunch' && latest.state === 'fenced' && action === 'wrap' && access && access.kind === 'project'
    && access.projectId === projectId && access.sessionId === latest.sessionId && access.launchId === latest.launchId
    && threadId === latest.priorThreadId) {
    // A relaunch rotation's own session may end itself: that is the relaunch.
    return null;
  }
  if (latest.state === 'fenced' || latest.state === 'rebinding') return fenced('no replacement context is bound yet, so no coordinator action is accepted');
  const bound = !!access && access.kind === 'project' && access.projectId === projectId
    && access.sessionId === latest.sessionId && access.launchId === latest.launchId
    && typeof threadId === 'string' && threadId !== '' && threadId === latest.replacementThreadId;
  if (!bound) {
    // An active epoch lapses when the session it bound has ended: no context
    // of that epoch can act any more, so the next ordinary launch of the
    // coordinator is judged like one that never rotated, and needs no
    // operator. While the bound session lives, everything else is refused.
    if (latest.state === 'active' && _boundSessionEnded(latest)) return null;
    return _refuse(409, 'COORDINATOR_EPOCH_MISMATCH',
      `Coordinator actions for this project are accepted only from the thread and launch bound at generation ${latest.generation}; `
        + 'this request is not from them (a stale or other thread, another pane, or no launch binding).'
        + (threadId ? '' : ' It carried no engine-thread header: make the call through `tc`, which sends it.'),
      { rotationId: latest.rotationId, generation: latest.generation, action });
  }
  if (latest.state === 'active') return null;
  if (action === 'workload-set' || action === 'control-ack') return null;
  // Resuming needs a running listener, so the replacement may turn it ON;
  // turning it off waits for the resume like any other authority change.
  if (action === 'medusa-listener' && enable === true) return null;
  const interval = new Set(latest.inboxIds || []);
  if (action === 'medusa-send' && typeof inReplyTo === 'string' && interval.has(inReplyTo)) return null;
  if (action === 'medusa-ack' && Array.isArray(messageIds) && messageIds.length && messageIds.every((id) => interval.has(id))) return null;
  const exchanges = new Set(((latest.checkpoint && latest.checkpoint.exchanges) || []).map((e) => e && e.id).filter((id) => typeof id === 'string'));
  if (action === 'exchange-close' && exchanges.has(exchangeId)) return null;
  return fenced('while reconciling, only workload, the control acknowledgement, and replies to, acknowledgements or closes of the '
    + 'checkpoint\'s own messages and exchanges are accepted; new dispatch waits for the resume');
}

/**
 * Begin a rotation for the calling coordinator's own session.
 * @param {object} input
 * @param {object} input.access - Verified launch: `{projectId, sessionId, launchId}`.
 * @param {*} input.body - `{attemptKey, checkpoint}`.
 * @param {object} [deps] - Seams.
 * @returns {Promise<{status: number, body: object}>}
 */
async function prepare({ access, body }, deps = {}) {
  const d = { ..._seams, ...deps };
  const b = _isObject(body) ? body : {};
  const attemptKey = b.attemptKey;
  if (typeof attemptKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(attemptKey)) {
    return _refuse(400, 'ROTATION_BAD_ATTEMPT_KEY', 'attemptKey must be 8–128 characters of letters, digits, ".", "_", ":" or "-".');
  }
  const checked = validateCheckpoint(b.checkpoint);
  if (!checked.ok) return _refuse(400, 'ROTATION_CHECKPOINT_INCOMPLETE', checked.message, { missing: checked.missing });
  const mode = b.mode === undefined ? 'clear' : b.mode;
  if (mode !== 'clear' && mode !== 'relaunch') return _refuse(400, 'ROTATION_BAD_MODE', 'mode must be clear or relaunch.');

  const existing = store.coordinatorRotations.getByAttemptKey(attemptKey);
  if (existing) return _replayedPrepare(existing, access, checked.digest);

  const open = store.coordinatorRotations.getOpenForProject(access.projectId);
  if (open) {
    return _refuse(409, 'ROTATION_IN_PROGRESS', `Rotation ${open.rotationId} is already ${open.state} for this project.`,
      { rotation: view(open) });
  }

  const channel = store.startupControlChannels.getOpenBySession(access.sessionId);
  if (!channel || !REBINDABLE_ADAPTERS.has(channel.adapter)) {
    return _refuse(409, 'ROTATION_ENGINE_UNSUPPORTED',
      'This session has no startup-control channel that can rebind a thread, so a managed rotation cannot prove its '
        + 'replacement. Engines with their own re-entry path (Claude\'s SessionStart hook) clear without one.');
  }
  const priorThreadId = channel.adapterState && channel.adapterState.threadId;
  if (!priorThreadId) {
    return _refuse(409, 'ROTATION_THREAD_UNBOUND',
      'The channel has no recorded thread yet, so there is no prior thread for a replacement to be proven against.');
  }

  const role = store.coordinatorRoles.getActiveForProject(access.projectId);
  if (!role) {
    return _refuse(403, 'ROTATION_NOT_COORDINATOR',
      'This project holds no active coordinator role. The operator grants one (POST /api/coordinator-roles); '
        + 'a role named in a checkpoint is not authority.');
  }
  const project = store.projects.get(access.projectId);
  const branch = b.checkpoint.branch;
  const seen = await d.fingerprint(project && project.path, { importantIgnored: branch.importantIgnored || [] });
  if (!seen.ok) return _refuse(409, 'ROTATION_CHECKOUT_UNAVAILABLE', `The checkout could not be fingerprinted (${_fingerprintFailureDetail(seen)}).`);
  const fp = seen.fingerprint;
  const checkoutRefusal = _checkoutMismatch(fp, branch);
  if (checkoutRefusal) return checkoutRefusal;
  const gh = await d.github(b.checkpoint.github);
  if (gh.unavailable.length) {
    return _refuse(409, 'ROTATION_EVIDENCE_UNAVAILABLE', `GitHub facts could not be read, so there is no baseline: ${gh.unavailable.join('; ')}.`);
  }
  const staleFacts = githubFacts.staleDeclarations(b.checkpoint.github, gh.observations);
  if (staleFacts.length) {
    return _refuse(409, 'ROTATION_CHECKPOINT_STALE', `The checkpoint's GitHub facts disagree with GitHub: ${staleFacts.join(', ')}.`, { stale: staleFacts });
  }

  // A switchboard coordinator must be listening when it prepares: a dead
  // listener reads as an empty inbox, and the interval recorded here is what
  // resume will hold the replacement to.
  if (d.medusaEnabled(project && project.path) && !d.listening(access.sessionId)) {
    return _refuse(409, 'ROTATION_LISTENER_DOWN',
      'This project has the Medusa switchboard enabled but its listener is not running, so its inbox cannot be recorded. Turn it on first.');
  }
  const inboxIds = (d.messages(access.sessionId) || []).map((m) => m && m.id).filter((id) => typeof id === 'string');
  if (inboxIds.length > MAX_INBOX_IDS) {
    return _refuse(409, 'ROTATION_INBOX_TOO_LARGE', `The inbox holds ${inboxIds.length} messages; handle some before rotating.`);
  }

  const now = d.now();
  let rotation;
  try {
    rotation = store.coordinatorRotations.transaction(() => store.coordinatorRotations.insert({
      rotationId: `rot_${crypto.randomBytes(9).toString('base64url')}`,
      attemptKey,
      projectId: access.projectId,
      sessionId: access.sessionId,
      launchId: access.launchId,
      engineId: channel.engineId,
      channelId: channel.id,
      sequenceId: channel.sequenceId,
      generation: store.coordinatorRotations.maxGeneration(access.projectId) + 1,
      priorThreadId,
      checkpointSchema: CHECKPOINT_SCHEMA,
      checkpointDigest: checked.digest,
      checkpoint: JSON.parse(checked.canonical),
      inboxIds,
      roleId: role.roleId,
      authorityVersion: role.authorityVersion,
      checkout: fp,
      github: gh.observations,
      mode,
      now
    }));
  } catch (err) {
    // A concurrent prepare won the attempt key or the project's one open slot.
    if (!/UNIQUE/i.test(err.message)) throw err;
    const raced = store.coordinatorRotations.getByAttemptKey(attemptKey);
    if (raced) return _replayedPrepare(raced, access, checked.digest);
    const winner = store.coordinatorRotations.getOpenForProject(access.projectId);
    return _refuse(409, 'ROTATION_IN_PROGRESS', 'Another rotation began for this project first.', { rotation: view(winner) });
  }
  log.info('Coordinator rotation prepared', { rotationId: rotation.rotationId, projectId: access.projectId, generation: rotation.generation });
  return { status: 201, body: { rotation: view(rotation) } };
}

/**
 * Whether the checkpoint's account of the checkout disagrees with what the
 * server observed — a stale head or ref, dirt it did not declare, or a
 * declared important ignored file that is missing or not ignored — as a
 * refusal, or null when it agrees.
 * @param {object} fp - The observed fingerprint.
 * @param {object} branch - The checkpoint's `branch`.
 * @returns {{status: number, body: object}|null}
 */
function _checkoutMismatch(fp, branch) {
  const shortRef = fp.ref.replace(/^refs\/heads\//, '');
  if (branch.head !== fp.head || (branch.ref !== fp.ref && branch.ref !== shortRef)) {
    return _refuse(409, 'ROTATION_CHECKPOINT_STALE',
      `The checkpoint says ${branch.ref} @ ${branch.head}; the checkout is ${shortRef} @ ${fp.head}.`);
  }
  const declared = new Set(branch.ownedDirt);
  const undeclared = fp.dirty.filter((p) => !declared.has(p));
  if (undeclared.length) {
    return _refuse(409, 'ROTATION_UNDECLARED_DIRT',
      `The checkout has changes the checkpoint does not declare as owned: ${undeclared.slice(0, 20).join(', ')}${undeclared.length > 20 ? ', …' : ''}.`,
      { undeclared });
  }
  // A file that cannot be hashed would be recorded as a constant, and a
  // change to it would never show as drift: refuse rather than record it.
  const unhashable = Object.entries(fp.untracked).filter(([, h]) => h.startsWith('unavailable:'));
  if (unhashable.length) {
    return _refuse(409, 'ROTATION_CHECKOUT_UNAVAILABLE',
      `Untracked files could not be hashed: ${unhashable.slice(0, 20).map(([p, h]) => `${p} (${h.slice(12)})`).join(', ')}.`);
  }
  const bad = Object.entries(fp.importantIgnored).filter(([, h]) => h.startsWith('unavailable:'));
  if (bad.length) {
    return _refuse(409, 'ROTATION_IGNORED_FILE_UNAVAILABLE',
      `Declared important ignored files could not be hashed: ${bad.map(([p, h]) => `${p} (${h.slice(12)})`).join(', ')}.`);
  }
  return null;
}

/**
 * A prepare whose attempt key already has a row: the same request replayed
 * returns it, REPLAY-ONLY — nothing is re-fenced, no generation is assigned
 * and a finished rotation stays finished; the answer says so, so a caller who
 * meant to start a new rotation learns it must use a new key. The key reused
 * for different content or another project is refused, never merged.
 * @param {object} existing - The stored rotation.
 * @param {object} access - The caller.
 * @param {string} digest - The replayed checkpoint's digest.
 * @returns {{status: number, body: object}}
 */
function _replayedPrepare(existing, access, digest) {
  if (existing.projectId !== access.projectId || existing.checkpointDigest !== digest) {
    return _refuse(409, 'ROTATION_ATTEMPT_KEY_REUSED', 'That attemptKey already names a different rotation.');
  }
  const open = OPEN_STATES.has(existing.state);
  return {
    status: 200,
    body: {
      rotation: view(existing),
      replayed: true,
      replayOnly: true,
      note: open
        ? 'This attempt key already names this open rotation; it is returned as it stands.'
        : `This attempt key already names a finished rotation (${existing.state}); nothing was reopened. A new rotation needs a new attempt key.`
    }
  };
}

/**
 * Record a step's failure on the rotation without moving its state, so the
 * next attempt resumes where this one stopped.
 * @param {object} rotation - The rotation as read.
 * @param {string} code - Typed reason.
 * @param {string} detail - For a person.
 * @param {object} d - Seams.
 * @returns {object} The rotation after the write (or as it now stands).
 */
function _fail(rotation, code, detail, d) {
  // A step still waiting on the same thing writes nothing: the driver polls
  // every second, and a row rewritten each pass would bury real transitions.
  const text = detail.slice(0, 500);
  if (rotation.failureCode === code && rotation.failureDetail === text) return rotation;
  const level = OPERATOR_FAILURES.has(code) ? 'warn' : 'info';
  log[level](OPERATOR_FAILURES.has(code) ? 'Coordinator rotation needs the operator' : 'Coordinator rotation step is waiting',
    { rotationId: rotation.rotationId, state: rotation.state, code });
  const r = store.coordinatorRotations.updateIf(rotation.rotationId, rotation.state,
    { failureCode: code, failureDetail: text }, { now: d.now() });
  return r.rotation || rotation;
}

/**
 * The session, project and channel the rotation was prepared against, or why
 * they no longer stand. A different channel, sequence or session means the
 * launch changed under the rotation, and nothing is bound across that.
 * @param {object} rotation - The rotation.
 * @returns {{session: object, project: object, channel: object}|{blocker: string}}
 */
function _subject(rotation) {
  const session = store.sessions.get(rotation.sessionId);
  if (!session || session.status !== store.SESSION_STATUS.ACTIVE) return { blocker: 'session-not-active' };
  const project = store.projects.get(rotation.projectId);
  if (!project) return { blocker: 'project-unknown' };
  const channel = store.startupControlChannels.getOpenBySession(rotation.sessionId);
  if (!channel || channel.id !== rotation.channelId || channel.sequenceId !== rotation.sequenceId) return { blocker: 'channel-changed' };
  return { session, project, channel };
}

/**
 * Run one pass of the server's side of a rotation: clear, rebind, re-enter.
 * Each pass does at most one step and is safe to repeat; the driver repeats it
 * until the rotation reaches `reconciling` or a step cannot proceed. Passes of
 * one rotation are serialized in this process, whoever calls: the driver, the
 * advance route, recovery.
 * @param {string} rotationId - Rotation id.
 * @param {object} [deps] - Seams.
 * @returns {Promise<object|null>} The rotation after the pass.
 */
function advance(rotationId, deps = {}) {
  const prior = _passes.get(rotationId) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => _advanceOnce(rotationId, deps));
  _passes.set(rotationId, next);
  next.catch(() => {}).finally(() => { if (_passes.get(rotationId) === next) _passes.delete(rotationId); });
  return next;
}

/** The pass in progress (or queued last) per rotation in this process. */
const _passes = new Map();

/**
 * One pass, run only through {@link advance}, which queues passes of one
 * rotation behind each other: two passes never read the same state and both
 * act on it — one `/clear`, one re-entry turn and one live nonce at a time.
 * @param {string} rotationId - Rotation id.
 * @param {object} deps - Seams.
 * @returns {Promise<object|null>}
 */
async function _advanceOnce(rotationId, deps) {
  const d = { ..._seams, ...deps };
  const rotation = store.coordinatorRotations.get(rotationId);
  if (!rotation || !OPEN_STATES.has(rotation.state) || rotation.state === 'reconciling') return rotation;
  // A relaunch rotation waits in `fenced` for its explicit claim; nothing is
  // typed into the ending session.
  if (rotation.mode === 'relaunch' && rotation.state === 'fenced') return rotation;
  const subject = _subject(rotation);
  if (subject.blocker) return _fail(rotation, subject.blocker, 'The session, project or control channel changed under the rotation.', d);
  const adapter = d.adapter();
  const seen = await adapter.rotationThreads(subject.channel, subject.project, d.adapterDeps || {});
  if (seen.blocker) return _fail(rotation, seen.blocker, 'The control channel could not list the project\'s threads.', d);
  if (rotation.state === 'fenced') return _clearStep(rotation, subject, seen.threads, d);
  return rotation.mode === 'relaunch'
    ? _relaunchRebindStep(rotation, subject, seen.threads, adapter, d)
    : _rebindStep(rotation, subject, seen.threads, adapter, d);
}

/**
 * Type `/clear` into the pane, once the prior thread is idle, recording the
 * threads loaded just before it so the replacement can be told from them.
 * @param {object} rotation - A `fenced` rotation.
 * @param {object} subject - From {@link _subject}.
 * @param {object[]} threads - The project's loaded threads.
 * @param {object} d - Seams.
 * @returns {object} The rotation after the step.
 */
function _clearStep(rotation, subject, threads, d) {
  const prior = threads.find((t) => t.id === rotation.priorThreadId);
  if (!prior) return _fail(rotation, 'prior-thread-not-loaded', 'The coordinator\'s recorded thread is not loaded, so a clear cannot be attributed to it.', d);
  if (prior.status !== 'idle') return _fail(rotation, 'prior-thread-busy', 'Waiting for the coordinator\'s turn to finish before clearing.', d);
  const moved = store.coordinatorRotations.updateIf(rotation.rotationId, 'fenced',
    { state: 'rebinding', priorThreads: threads.map((t) => t.id), failureCode: null, failureDetail: null },
    { now: d.now() });
  if (!moved.written) return moved.rotation;
  return _attemptClear(moved.rotation, subject, d);
}

/**
 * Try to type `/clear` into the rotation's session pane, at a bounded pace.
 *
 * The attempt's time is claimed first, by compare-and-set, so two passes can
 * never both type. Only an attempt the pane ADMITTED counts toward
 * {@link MAX_CLEAR_ATTEMPTS}: a refusal — a HOLD, a missing pane — is recorded
 * as `clear-refused` and retried no sooner than {@link CLEAR_RETRY_MS}.
 * @param {object} rotation - A `rebinding` rotation with no replacement yet.
 * @param {object} subject - From {@link _subject}.
 * @param {object} d - Seams.
 * @returns {object}
 */
function _attemptClear(rotation, subject, d) {
  const nowIso = d.now();
  if (rotation.lastClearAttemptAt && Date.parse(nowIso) - Date.parse(rotation.lastClearAttemptAt) < CLEAR_RETRY_MS) {
    return rotation;
  }
  const claimed = store.coordinatorRotations.updateIf(rotation.rotationId, 'rebinding', { lastClearAttemptAt: nowIso },
    { now: nowIso, test: (r) => r.lastClearAttemptAt === rotation.lastClearAttemptAt && !r.replacementThreadId });
  if (!claimed.written) return claimed.rotation;
  const sent = d.inject(subject.project.name, '/clear', { sessionId: rotation.sessionId });
  if (!sent || !sent.ok) {
    return _fail(claimed.rotation, 'clear-refused', `The /clear was not admitted (not counted; retried after a pause): ${(sent && sent.error) || 'no answer'}.`, d);
  }
  const counted = store.coordinatorRotations.updateIf(rotation.rotationId, 'rebinding',
    { clearAttempts: claimed.rotation.clearAttempts + 1, failureCode: null, failureDetail: null },
    { now: d.now(), test: (r) => r.clearAttempts === claimed.rotation.clearAttempts });
  log.info('Coordinator rotation typed /clear', { rotationId: rotation.rotationId, attempt: claimed.rotation.clearAttempts + 1 });
  return counted.rotation || claimed.rotation;
}

/**
 * Find and bind the replacement thread, then deliver the re-entry turn.
 *
 * The replacement is the one root (non-subagent) thread in the project
 * directory that was not loaded when the clear was typed. The prior thread
 * must be gone: if it is still loaded beside a new one, which of them is the
 * coordinator is not provable, so nothing is bound. If it is still loaded and
 * nothing new appeared, the clear has not taken effect; it is typed again, a
 * bounded number of times.
 * @param {object} rotation - A `rebinding` rotation.
 * @param {object} subject - From {@link _subject}.
 * @param {object[]} threads - The project's loaded threads.
 * @param {object} adapter - The Codex adapter.
 * @param {object} d - Seams.
 * @returns {Promise<object>}
 */
async function _rebindStep(rotation, subject, threads, adapter, d) {
  let replacement = rotation.replacementThreadId;
  if (!replacement) {
    const before = new Set(rotation.priorThreads || []);
    const prior = threads.find((t) => t.id === rotation.priorThreadId);
    const fresh = threads.filter((t) => !t.subagent && t.id !== rotation.priorThreadId && !before.has(t.id));
    if (prior && fresh.length === 0) {
      if (prior.status !== 'idle') return _fail(rotation, 'prior-thread-busy', 'The prior thread is working; waiting before clearing.', d);
      const sinceLast = rotation.lastClearAttemptAt ? Date.parse(d.now()) - Date.parse(rotation.lastClearAttemptAt) : Infinity;
      // An admitted clear may still be unloading the old thread: never type
      // over it inside the settle window.
      if (rotation.clearAttempts > 0 && sinceLast < CLEAR_SETTLE_MS) {
        return _fail(rotation, 'clear-settling', 'Waiting for the last admitted /clear to take effect.', d);
      }
      if (rotation.clearAttempts >= MAX_CLEAR_ATTEMPTS) {
        return _fail(rotation, 'clear-not-applied', `The prior thread is still loaded after ${rotation.clearAttempts} admitted /clear attempts.`, d);
      }
      return _attemptClear(rotation, subject, d);
    }
    // The window runs only after an ADMITTED clear: a thread that appears with
    // no clear behind it has nothing to settle from, and goes to the operator.
    const settling = rotation.clearAttempts > 0 && !!rotation.lastClearAttemptAt
      && Date.parse(d.now()) - Date.parse(rotation.lastClearAttemptAt) < REBIND_WINDOW_MS;
    if (prior) {
      return settling
        ? _fail(rotation, 'prior-thread-unloading', 'The old thread is still loaded beside a new one; waiting for it to unload.', d)
        : _fail(rotation, 'prior-thread-still-loaded', 'The prior thread is still loaded beside a new one, so the replacement is not provable.', d);
    }
    if (fresh.length === 0) return _fail(rotation, 'replacement-not-loaded', 'No new thread has appeared in the project directory yet.', d);
    if (fresh.length > 1) {
      return settling
        ? _fail(rotation, 'replacement-settling', `${fresh.length} new threads are loaded; waiting for the picture to settle before binding one.`, d)
        : _fail(rotation, 'replacement-ambiguous', `${fresh.length} new threads appeared (${fresh.map((t) => t.id).join(', ')}); binding none.`, d);
    }
    replacement = fresh[0].id;
  } else if (!threads.some((t) => t.id === replacement)) {
    return _fail(rotation, 'replacement-not-loaded', 'The bound replacement thread is no longer loaded.', d);
  }

  const bound = adapter.rebindThread(subject.channel, { priorThreadId: rotation.priorThreadId, replacementThreadId: replacement });
  if (!bound.bound) return _fail(rotation, 'channel-changed', 'The channel\'s recorded thread changed under the rotation; nothing was rebound.', d);
  let current = rotation;
  if (!rotation.replacementThreadId) {
    const recorded = store.coordinatorRotations.updateIf(rotation.rotationId, 'rebinding', { replacementThreadId: replacement },
      { now: d.now(), test: (r) => !r.replacementThreadId });
    if (!recorded.written) return recorded.rotation;
    current = recorded.rotation;
    log.info('Coordinator rotation rebound the channel', { rotationId: rotation.rotationId, from: rotation.priorThreadId, to: replacement });
  }

  return _deliverReentry(current, subject, threads, bound.channel, replacement, adapter, d);
}

/**
 * Deliver the re-entry turn to the bound replacement, once it is idle, and
 * move the rotation to `reconciling`. The turn carries a one-time resume
 * nonce minted only when the turn is really sent.
 * @param {object} current - The `rebinding` rotation, replacement recorded.
 * @param {object} subject - From {@link _subject}.
 * @param {object[]} threads - The project's loaded threads.
 * @param {object} channel - The channel row naming the replacement.
 * @param {string} replacement - The replacement thread id.
 * @param {object} adapter - The Codex adapter.
 * @param {object} d - Seams.
 * @returns {Promise<object>}
 */
async function _deliverReentry(current, subject, threads, channel, replacement, adapter, d) {
  const replacementThread = threads.find((t) => t.id === replacement);
  if (!replacementThread || replacementThread.status !== 'idle') {
    return _fail(current, 'replacement-busy', 'Waiting for the replacement thread to be idle before sending the re-entry turn.', d);
  }
  const digest = reentryDigest(current);
  const text = () => {
    // Minted only when a turn is really sent; only its hash is stored. A send
    // that fails leaves a hash no text carries, and the next send replaces it.
    const nonce = crypto.randomBytes(32).toString('base64url');
    const minted = store.coordinatorRotations.updateIf(current.rotationId, 'rebinding', { resumeNonceHash: _sha256(nonce) },
      { now: d.now(), test: (r) => !r.reentryDigest });
    if (!minted.written) throw new Error('the rotation moved on before its re-entry turn was sent');
    return renderReentry(current, subject.project, nonce);
  };
  const delivered = await adapter.deliverTurn(channel, subject.project,
    { threadId: replacement, text, clientId: digest }, d.adapterDeps || {});
  if (delivered.blocker) return _fail(current, `reentry-${delivered.blocker}`, 'The re-entry turn could not be delivered.', d);
  const done = store.coordinatorRotations.updateIf(current.rotationId, 'rebinding',
    { state: 'reconciling', reentryDigest: digest, reconcilingAt: d.now(), failureCode: null, failureDetail: null }, { now: d.now() });
  if (done.written) log.info('Coordinator rotation delivered its re-entry turn', { rotationId: current.rotationId, status: delivered.status });
  return done.rotation;
}

/**
 * The rebind step of a relaunch rotation. The successor launch was claimed
 * and bound by {@link claimRelaunch}, so its channel is the rotation's, and
 * the replacement is the thread that channel records — recorded by the
 * successor launch's own startup path. It is never inferred from a thread
 * that has merely become visible: until the channel records one, the step
 * waits with `successor-thread-unrecorded`.
 * @param {object} rotation - A `rebinding` relaunch rotation.
 * @param {object} subject - From {@link _subject}.
 * @param {object[]} threads - The successor's loaded project threads.
 * @param {object} adapter - The Codex adapter.
 * @param {object} d - Seams.
 * @returns {Promise<object>}
 */
async function _relaunchRebindStep(rotation, subject, threads, adapter, d) {
  const channel = subject.channel;
  const replacement = channel.adapterState && channel.adapterState.threadId;
  if (!replacement) {
    return _fail(rotation, 'successor-thread-unrecorded',
      'The successor launch\'s control channel has not recorded its thread yet; nothing is inferred from visible threads.', d);
  }
  if (!threads.some((t) => t.id === replacement)) return _fail(rotation, 'replacement-not-loaded', 'The successor\'s thread is not loaded.', d);
  let current = rotation;
  if (rotation.replacementThreadId !== replacement) {
    const recorded = store.coordinatorRotations.updateIf(rotation.rotationId, 'rebinding', { replacementThreadId: replacement },
      { now: d.now(), test: (r) => !r.replacementThreadId });
    if (!recorded.written) return recorded.rotation;
    current = recorded.rotation;
    log.info('Coordinator rotation bound the relaunched thread', { rotationId: rotation.rotationId, thread: replacement });
  }
  return _deliverReentry(current, subject, threads, channel, replacement, adapter, d);
}

/** Rotations whose driver is running in this process. */
const _driving = new Map();

/**
 * Repeat {@link advance} until the rotation leaves the server's hands
 * (`reconciling`, `active`, `abandoned`) or the attempts run out. One driver
 * per rotation per process; a second call joins the first.
 * @param {string} rotationId - Rotation id.
 * @param {object} [opts]
 * @param {number} [opts.attempts=900] - Passes before giving up — at the default interval, fifteen
 *   minutes for the coordinator's last turn to end. A later `advance` call resumes.
 * @param {number} [opts.intervalMs=1000] - Pause between passes.
 * @param {object} [opts.deps] - Seams.
 * @returns {Promise<object|null>}
 */
function drive(rotationId, { attempts = 900, intervalMs = 1000, deps = {} } = {}) {
  if (_driving.has(rotationId)) return _driving.get(rotationId);
  const d = { ..._seams, ...deps };
  const run = (async () => {
    let rotation = null;
    for (let i = 0; i < attempts; i++) {
      try {
        rotation = await advance(rotationId, deps);
      } catch (err) { // prawduct:allow prawduct/broad-except -- a background driver must not crash the server; the failure is recorded on the row and a later pass resumes
        log.warn('Coordinator rotation pass failed', { rotationId, error: err.message });
        const current = store.coordinatorRotations.get(rotationId);
        rotation = current && (current.state === 'fenced' || current.state === 'rebinding')
          ? _fail(current, 'driver-error', `A server pass failed: ${err.message}`, d)
          : current;
      }
      if (!rotation || rotation.state !== 'fenced' && rotation.state !== 'rebinding') return rotation;
      if (rotation.mode === 'relaunch' && rotation.state === 'fenced') return rotation;
      // A failure only the operator can get past will not clear by polling.
      if (rotation.failureCode && OPERATOR_FAILURES.has(rotation.failureCode)) return rotation;
      await d.sleep(intervalMs);
    }
    // Out of passes: say so on the record, so no surface keeps reading as
    // "the server is rebinding" when nothing is.
    log.warn('Coordinator rotation driver stopped without finishing', { rotationId, attempts });
    // A failure already recorded says more than this does, and already maps to
    // its next command; only a silent stop needs its own.
    if (rotation && !rotation.failureCode) {
      rotation = _fail(rotation, 'driver-stopped', `The server stopped after ${attempts} passes; run \`tc rotation advance\` to resume.`, d);
    }
    return rotation;
  })().finally(() => _driving.delete(rotationId));
  _driving.set(rotationId, run);
  return run;
}

/**
 * Accept the replacement context's resume receipt, or say what evidence is
 * missing. Acceptance marks the rotation active in the same compare-and-set
 * that stores the receipt, which is what lifts the fence.
 * @param {object} input
 * @param {object} input.access - Verified launch.
 * @param {*} input.body - `{rotationId, attemptKey, generation, resumeNonce, receipt}`.
 * @param {string|null} input.threadId - The engine thread the request came from.
 * @param {object} [deps] - Seams.
 * @returns {Promise<{status: number, body: object}>}
 */
async function resume({ access, body, threadId }, deps = {}) {
  const d = { ..._seams, ...deps };
  const b = _isObject(body) ? body : {};
  const rotation = typeof b.rotationId === 'string' ? store.coordinatorRotations.get(b.rotationId) : null;
  if (!rotation || rotation.projectId !== access.projectId) return _refuse(404, 'ROTATION_NOT_FOUND', 'No rotation of this project has that id.');
  if (rotation.sessionId !== access.sessionId || rotation.launchId !== access.launchId) {
    return _refuse(403, 'ROTATION_NOT_YOURS', 'Only the launch that prepared this rotation may resume it.');
  }
  if (b.attemptKey !== rotation.attemptKey || b.generation !== rotation.generation) {
    return _refuse(409, 'ROTATION_STALE_GENERATION',
      `This receipt is for another attempt or generation; the rotation is generation ${rotation.generation}.`);
  }
  if (rotation.state !== 'reconciling' && rotation.state !== 'active') {
    return _refuse(409, 'ROTATION_NOT_RECONCILING',
      `The rotation is ${rotation.state}; the server has not yet delivered the re-entry turn, so there is nothing to resume.`,
      { rotation: view(rotation) });
  }
  if (!rotation.replacementThreadId || threadId !== rotation.replacementThreadId) {
    return _refuse(403, 'COORDINATOR_EPOCH_MISMATCH',
      'Only the replacement thread this rotation bound may resume it; this request did not come from it.');
  }
  if (rotation.state === 'active') {
    const same = rotation.receipt && canonicalJson(rotation.receipt) === canonicalJson(b.receipt);
    return same
      ? { status: 200, body: { rotation: view(rotation), replayed: true } }
      : _refuse(409, 'ROTATION_ALREADY_ACTIVE', 'This rotation already resumed with a different receipt.');
  }

  if (typeof b.resumeNonce !== 'string' || !rotation.resumeNonceHash || _sha256(b.resumeNonce) !== rotation.resumeNonceHash) {
    return _refuse(403, 'ROTATION_NONCE_INVALID', 'The resume nonce is missing or is not the one this rotation\'s re-entry turn carried.');
  }
  const shape = validateReceipt(b.receipt);
  if (!shape.ok) return _refuse(400, 'ROTATION_RECEIPT_INCOMPLETE', shape.message, { missing: shape.missing });
  const observedAt = d.now();
  const integrity = await _integrityDrift(rotation, d);
  const gh = await d.github((rotation.checkpoint && rotation.checkpoint.github) || []);
  const trusted = githubFacts.drift(rotation.github || [], gh.observations);
  const readiness = _readiness(rotation, access, d);
  const drift = {
    observedAt,
    // What a relaunch's claim observed stays on the record across attempts.
    ...(rotation.drift && rotation.drift.relaunch ? { relaunch: rotation.drift.relaunch } : {}),
    ...(rotation.drift && Array.isArray(rotation.drift.unhandledAtRelaunch)
      ? { unhandledAtRelaunch: rotation.drift.unhandledAtRelaunch } : {}),
    integrity: integrity.items,
    unavailable: [...integrity.unavailable, ...gh.unavailable],
    trusted,
    dispositions: b.receipt.drift
  };
  const refuse = (status, code, message, details) => {
    log.info('Coordinator rotation resume refused', { rotationId: rotation.rotationId, code });
    store.coordinatorRotations.updateIf(rotation.rotationId, 'reconciling', { drift, readiness }, { now: observedAt });
    return _refuse(status, code, message, { drift, readiness, ...details });
  };
  if (drift.integrity.length) {
    return refuse(409, 'ROTATION_OPERATOR_RECOVERY_REQUIRED',
      'Something that must not change while a coordinator is absent did change. No receipt can accept it; the fence stays '
        + `up until the operator recovers the rotation: ${drift.integrity.map((i) => i.key).join(', ')}.`);
  }
  if (drift.unavailable.length) {
    return refuse(409, 'ROTATION_EVIDENCE_UNAVAILABLE', `The fence stays up: evidence could not be observed (${drift.unavailable.join('; ')}).`);
  }
  const acknowledged = new Set(b.receipt.drift.map((x) => x.key));
  const unacknowledged = trusted.filter((t) => !acknowledged.has(t.key)).map((t) => t.key);
  if (unacknowledged.length) {
    return refuse(409, 'ROTATION_DRIFT_UNACKNOWLEDGED',
      `GitHub changed while the coordinator was absent, and the receipt does not dispose of it: ${unacknowledged.join(', ')}. `
        + `Give each a disposition (${DRIFT_DISPOSITIONS.join(', ')}) and an updated nextAction.`, { unacknowledged });
  }
  const evidence = _crossCheck(rotation, b.receipt, d);
  if (readiness.verdict !== 'ready') evidence.push({ fact: 'readiness', detail: readiness.reason });
  if (evidence.length) {
    return refuse(409, 'ROTATION_EVIDENCE_MISSING', `The fence stays up: ${evidence.map((e) => e.detail).join(' ')}`, { missing: evidence });
  }

  const now = d.now();
  const done = store.coordinatorRotations.updateIf(rotation.rotationId, 'reconciling',
    { state: 'active', receipt: b.receipt, drift, readiness, completedAt: now, failureCode: null, failureDetail: null, resumeNonceHash: null },
    { now, test: (r) => r.generation === b.generation && r.resumeNonceHash === rotation.resumeNonceHash });
  if (!done.written) return _refuse(409, 'ROTATION_CHANGED', 'The rotation changed while the receipt was checked; read it and retry.');
  log.info('Coordinator rotation resumed; fence lifted', { rotationId: rotation.rotationId, generation: rotation.generation });
  if (done.rotation.sessionId != null) d.wake(done.rotation.sessionId, 'rotation-closed');
  return { status: 200, body: { rotation: view(done.rotation) } };
}

/**
 * Re-observe what must not move while a coordinator is absent: its role and
 * authority version, and its checkout's content. Each difference is an
 * integrity drift item (a stable key with before and after digests); anything
 * that could not be observed is named as unavailable. Neither is something a
 * receipt can acknowledge.
 * @param {object} rotation - The rotation.
 * @param {object} d - Seams.
 * @returns {Promise<{items: Array<{class: string, key: string, before: string, after: string}>, unavailable: string[]}>}
 */
async function _integrityDrift(rotation, d) {
  const items = [];
  const unavailable = [];
  const role = store.coordinatorRoles.getActiveForProject(rotation.projectId);
  const now = role ? `${role.roleId}@${role.authorityVersion}` : 'none';
  const then = `${rotation.roleId}@${rotation.authorityVersion}`;
  if (now !== then) items.push({ class: 'authority', key: 'authority.coordinator-role', before: then, after: now });
  const project = store.projects.get(rotation.projectId);
  const importantIgnored = Object.keys((rotation.checkout && rotation.checkout.importantIgnored) || {});
  const seen = await d.fingerprint(project && project.path, { importantIgnored });
  if (!seen.ok) {
    unavailable.push(`checkout: ${_fingerprintFailureDetail(seen)}`);
  } else {
    for (const item of checkoutFingerprint.compare(rotation.checkout, seen.fingerprint)) items.push({ class: 'checkout-integrity', ...item });
  }
  return { items, unavailable };
}

/**
 * The receipt's claims the server can check for itself, and each that fails.
 * @param {object} rotation - The rotation.
 * @param {object} receipt - A shape-valid receipt.
 * @param {object} d - Seams.
 * @returns {Array<{fact: string, detail: string}>}
 */
function _crossCheck(rotation, receipt, d) {
  const out = [];
  if (receipt.checkpointDigest !== rotation.checkpointDigest) {
    out.push({ fact: 'checkpoint', detail: 'The receipt names a different checkpoint than the one this rotation recorded.' });
  }
  // With no listener the inbox reads as empty, which would pass for drained —
  // so a listener is required whenever the project has the switchboard
  // enabled, or the prepare recorded messages to drain. Only a coordinator
  // that runs without the switchboard, with nothing recorded, is not held.
  const project = store.projects.get(rotation.projectId);
  const needsListener = (rotation.inboxIds || []).length > 0 || d.medusaEnabled(project && project.path);
  if (needsListener && !d.listening(rotation.sessionId)) {
    out.push({ fact: 'medusa', detail: 'This session has no Medusa listener, so its inbox cannot be checked; it must be listening to resume.' });
    return out;
  }
  const inbox = new Set((d.messages(rotation.sessionId) || []).map((m) => m && m.id));
  // #2821 (Architect Ruling A505-R1.3) — in relaunch mode, a prepare-time id
  // can be unhandled two ways: still sitting in the successor's OWN inbox
  // (normally via #1806's carry-forward, landed under the same id), or
  // recorded as owed at claimRelaunch (`drift.unhandledAtRelaunch`,
  // `claimRelaunch`'s own doc explains why that is the branch doing the
  // real work) and never explicitly cleared by the receipt. Either counts.
  const handledByReceipt = new Set(
    (receipt.reconciled && receipt.reconciled.medusa && Array.isArray(receipt.reconciled.medusa.handled)
      ? receipt.reconciled.medusa.handled : [])
  );
  const unhandledAtRelaunch = rotation.mode === 'relaunch' && rotation.drift && Array.isArray(rotation.drift.unhandledAtRelaunch)
    ? new Set(rotation.drift.unhandledAtRelaunch.filter((id) => !handledByReceipt.has(id)))
    : new Set();
  const left = (rotation.inboxIds || []).filter((id) => inbox.has(id) || unhandledAtRelaunch.has(id));
  if (left.length) out.push({ fact: 'medusa', detail: `${left.length} message(s) from before the rotation are still unhandled: ${left.join(', ')}.` });
  // A relaunched successor holds no coordinator authority until its own launch
  // sequence is attested READY (Architect ruling): the fence lifts only after.
  if (rotation.mode === 'relaunch') {
    const sequence = store.launchSequences.getByLaunchId(rotation.launchId);
    if (!sequence || !sequence.readyAt) {
      out.push({ fact: 'launch-ready', detail: 'The relaunched session has not attested its launch sequence READY (`tc start next`, then `tc start ready`).' });
    }
  }
  const assignment = store.control.getOpenForProject(rotation.projectId);
  const generation = assignment ? assignment.state_generation : null;
  if (receipt.reconciled.control.stateGeneration !== generation) {
    out.push({ fact: 'control', detail: `The receipt's control generation is ${receipt.reconciled.control.stateGeneration}; the lane is at ${generation}.` });
  }
  return out;
}

/**
 * The readiness verdict (ruling A8): the replacement's newest workload
 * receipt must have been published after the re-entry turn was delivered,
 * still be current, and say it is working or waiting on something external
 * with `do-not-clear` — a coordinator resuming authority is neither done nor
 * safe to clear. The verdict is persisted with the rotation either way.
 * @param {object} rotation - The rotation.
 * @param {object} access - The caller.
 * @param {object} d - Seams.
 * @returns {{verdict: ('ready'|'not-ready'), reason: (string|null), receiptSeq: (number|null), state: (string|null),
 *   clearance: (string|null), receivedAt: (string|null), observedAt: string}}
 */
function _readiness(rotation, access, d) {
  const observedAt = d.now();
  const latest = store.workloadReceipts.latestForLaunch(access.launchId);
  const base = {
    receiptSeq: latest ? latest.seq : null, state: latest ? latest.state : null,
    clearance: latest ? latest.clearance : null, receivedAt: latest ? latest.received_at : null, observedAt
  };
  const not = (reason) => ({ verdict: 'not-ready', reason, ...base });
  if (!latest) return not('No workload receipt has been published (`tc workload set`).');
  if (!rotation.reconcilingAt || !(latest.received_at > rotation.reconcilingAt)) {
    return not('The newest workload receipt predates the re-entry turn; publish a current one (`tc workload set`).');
  }
  if (Date.parse(observedAt) - Date.parse(latest.received_at) > (WORKLOAD_EXPIRY_MS[latest.state] || 0)) {
    return not('The newest workload receipt has expired; publish a current one.');
  }
  if (!READY_STATES.has(latest.state)) return not(`A resuming coordinator reports working or waiting-external, not ${latest.state}.`);
  if (latest.clearance !== 'do-not-clear') return not(`A resuming coordinator is do-not-clear, not ${latest.clearance}.`);
  return { verdict: 'ready', reason: null, ...base };
}

/**
 * The operator ends a rotation that cannot finish — the fence lifts and the
 * channel is left as it stands — or releases an active rotation's epoch
 * binding, after which the project is judged as one that never rotated.
 * Operator only.
 * @param {object} input
 * @param {object} input.caller - From `control-auth#resolveControlCaller`.
 * @param {*} input.body - `{rotationId, reason}`.
 * @param {object} [deps] - Seams.
 * @returns {{status: number, body: object}}
 */
function abandon({ caller, body }, deps = {}) {
  const d = { ..._seams, ...deps };
  const refusal = _operatorOnly(caller, 'abandon a coordinator rotation');
  if (refusal) return refusal;
  const b = _isObject(body) ? body : {};
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) return _refuse(400, 'ROTATION_REASON_REQUIRED', 'Say why the rotation is being abandoned.');
  const rotation = typeof b.rotationId === 'string' ? store.coordinatorRotations.get(b.rotationId) : null;
  if (!rotation) return _refuse(404, 'ROTATION_NOT_FOUND', 'No rotation has that id.');
  // An active rotation is abandoned to release its epoch binding — the
  // operator's way out when the bound session is gone and the coordinator was
  // relaunched without a governed rotation.
  if (!OPEN_STATES.has(rotation.state) && rotation.state !== 'active') return _refuse(409, 'ROTATION_NOT_OPEN', `The rotation is already ${rotation.state}.`);
  const now = d.now();
  const done = store.coordinatorRotations.updateIf(rotation.rotationId, rotation.state,
    { state: 'abandoned', completedAt: now, failureCode: 'abandoned', failureDetail: reason.slice(0, 500) }, { now });
  if (!done.written) return _refuse(409, 'ROTATION_CHANGED', 'The rotation changed; read it and retry.');
  log.warn('Coordinator rotation abandoned by the operator', { rotationId: rotation.rotationId, reason });
  // Only a rotation that was open held the wake monitor back.
  if (OPEN_STATES.has(rotation.state) && done.rotation.sessionId != null) d.wake(done.rotation.sessionId, 'rotation-closed');
  return { status: 200, body: { rotation: view(done.rotation) } };
}

/**
 * The explicit, server-managed relaunch transition (ruling A13): the operator
 * starts the successor session of a `relaunch` rotation, and the rotation is
 * bound to exactly that new session, launch and channel in one
 * compare-and-set. A launch made any other way is never claimed: the gate
 * compares against the rotation's own session and launch, so it stays fenced.
 * @param {object} input
 * @param {object} input.caller - From `control-auth#resolveControlCaller`.
 * @param {*} input.body - `{rotationId}`.
 * @param {object} [deps] - Seams: `launch(projectName)` starts a session.
 * @returns {Promise<{status: number, body: object}>}
 */
async function claimRelaunch({ caller, body }, deps = {}) {
  const d = { ..._seams, ...deps };
  const refusal = _operatorOnly(caller, 'claim a coordinator relaunch');
  if (refusal) return refusal;
  const b = _isObject(body) ? body : {};
  const rotation = typeof b.rotationId === 'string' ? store.coordinatorRotations.get(b.rotationId) : null;
  if (!rotation) return _refuse(404, 'ROTATION_NOT_FOUND', 'No rotation has that id.');
  if (rotation.mode !== 'relaunch') return _refuse(409, 'ROTATION_NOT_RELAUNCH', 'This rotation clears in place; it is not claimed by a relaunch.');
  if (rotation.state !== 'fenced') return _refuse(409, 'ROTATION_NOT_FENCED', `The rotation is ${rotation.state}; only a fenced relaunch rotation is claimed.`);
  const project = store.projects.get(rotation.projectId);
  if (!project) return _refuse(404, 'PROJECT_NOT_FOUND', 'The rotation\'s project no longer exists.');
  // The old session must be PROVEN ended — its own row records a terminal
  // status — before anything is launched or re-baselined. A missing or
  // unreadable row is not proof, and the rotation stays fenced.
  if (!_boundSessionEnded(rotation)) {
    return _refuse(409, 'ROTATION_PRIOR_SESSION_NOT_ENDED',
      `The coordinator's session ${rotation.sessionId} is not recorded as ended (wrapped, killed or crashed); `
        + 'the relaunch is claimed only after that is on the record.');
  }
  const active = store.sessions.getActive(rotation.projectId);
  if (active) {
    return _refuse(409, 'ROTATION_SESSION_STILL_ACTIVE',
      `Session ${active.id} is still active for this project. The coordinator's session ends first (its own wrap, or the operator's), `
        + 'and an ordinary launch made meanwhile is not claimed: end it too.');
  }
  const launched = d.launch(project.name);
  if (!launched || launched.error || !launched.session) {
    return _refuse(502, 'ROTATION_RELAUNCH_FAILED', `The successor session could not be launched: ${(launched && launched.error) || 'no answer'}.`);
  }
  const session = launched.session;
  const sequence = store.launchSequences.getBySession(session.id);
  const channel = store.startupControlChannels.getOpenBySession(session.id);
  if (!sequence || !sequence.launchId || !channel || !REBINDABLE_ADAPTERS.has(channel.adapter)) {
    _fail(rotation, 'relaunch-unbindable', `Successor session ${session.id} has no launch sequence or rebindable channel; it stays unclaimed.`, d);
    return _refuse(409, 'ROTATION_RELAUNCH_UNBINDABLE',
      `Successor session ${session.id} was launched but has no launch id or rebindable control channel, so it cannot be bound; `
        + 'the fence stays up. The operator can abandon the rotation.');
  }
  // The old session's governed wrap may have committed, and the successor's
  // launch rewrites its generated config: both are part of the relaunch, not
  // drift. The checkout baseline for the resume is therefore taken HERE, with
  // the successor launched and before it holds any authority; the difference
  // from prepare is kept as an observation.
  const importantIgnored = Object.keys((rotation.checkout && rotation.checkout.importantIgnored) || {});
  const seen = await d.fingerprint(project.path, { importantIgnored });
  if (!seen.ok) {
    _fail(rotation, 'relaunch-unbindable', `The checkout could not be fingerprinted after the relaunch (${_fingerprintFailureDetail(seen)}).`, d);
    return _refuse(409, 'ROTATION_CHECKOUT_UNAVAILABLE', `The checkout could not be fingerprinted after the relaunch (${_fingerprintFailureDetail(seen)}); the fence stays up.`);
  }
  const relaunchChanges = checkoutFingerprint.compare(rotation.checkout, seen.fingerprint);
  // #2821 (Architect Ruling A505-R1.3) — snapshot which prepare-time
  // inboxIds are still owed, while `rotation.sessionId` still names the OLD
  // session, right before the rebind below overwrites it.
  //
  // `_boundSessionEnded` above already proved the old session ended, and
  // EVERY ending path (wrap, kill, and all three crash-detection sites —
  // `lib/sessions.js`, closing the same gap #1000 already closed for
  // crashes) tears its Medusa listener down synchronously as part of that
  // same transition. So `d.messages(rotation.sessionId)` here reads a
  // listener that is already gone and is never live at this point — this
  // is not a live check, it is a (deliberately honest) attempt that always
  // falls through to the conservative branch below.
  //
  // That fallback is what actually does the work: treat every prepare-time
  // id as presumptively still owed, rather than silently clearing them for
  // lack of a live signal. It is cleared later only by #1806 landing the
  // same id under the successor's own inbox (`_crossCheck`'s `inbox.has`
  // branch) or by the receipt explicitly naming it handled
  // (`receipt.reconciled.medusa.handled`) — never by this snapshot alone.
  const oldInboxIds = new Set((d.messages(rotation.sessionId) || []).map((m) => m && m.id));
  const unhandledAtRelaunch = oldInboxIds.size > 0
    ? (rotation.inboxIds || []).filter((id) => oldInboxIds.has(id))
    : (rotation.inboxIds || []).slice();
  const bound = store.coordinatorRotations.updateIf(rotation.rotationId, 'fenced',
    { state: 'rebinding', sessionId: session.id, launchId: sequence.launchId, channelId: channel.id, sequenceId: channel.sequenceId,
      checkout: seen.fingerprint,
      drift: { observedAt: d.now(), relaunch: relaunchChanges, unhandledAtRelaunch, integrity: [], unavailable: [], trusted: [] },
      failureCode: null, failureDetail: null },
    { now: d.now(), test: (r) => r.sessionId === rotation.sessionId });
  if (!bound.written) return _refuse(409, 'ROTATION_CHANGED', 'The rotation changed while the successor launched; read it and retry.');
  log.info('Coordinator relaunch claimed', { rotationId: rotation.rotationId, sessionId: session.id });
  drive(rotation.rotationId, d.driveOpts || {});
  return { status: 200, body: { rotation: view(bound.rotation) } };
}

/** Failures the server's driver cannot get past: they need the operator. */
const OPERATOR_FAILURES = new Set([
  'clear-not-applied', 'prior-thread-still-loaded', 'replacement-ambiguous', 'channel-changed', 'session-not-active',
  'project-unknown', 'prior-thread-not-loaded', 'relaunch-unbindable'
]);

/**
 * What a rotation is waiting on, and the one command that moves it (ruling
 * A13): the blocker in words, and exactly one next command for whoever holds
 * it. Terminal rotations have neither.
 * @param {object} r - A rotation.
 * @returns {{blocker: (string|null), nextCommand: (string|null)}}
 */
function nextStep(r) {
  const abandon = `POST /api/tc/rotation/abandon {"rotationId":"${r.rotationId}","reason":"<why>"}  (operator)`;
  if (!OPEN_STATES.has(r.state)) return { blocker: null, nextCommand: null };
  const d = r.drift;
  if (d && d.integrity && d.integrity.length) {
    return { blocker: `integrity drift: ${d.integrity.map((i) => i.key).join(', ')}`, nextCommand: abandon };
  }
  if (r.failureCode && OPERATOR_FAILURES.has(r.failureCode)) return { blocker: `${r.failureCode}: ${r.failureDetail}`, nextCommand: abandon };
  if (r.state === 'fenced' && r.mode === 'relaunch') {
    return {
      blocker: r.failureCode ? `${r.failureCode}: ${r.failureDetail}` : 'waiting for the coordinator session to end and the relaunch to be claimed',
      nextCommand: `POST /api/tc/rotation/relaunch {"rotationId":"${r.rotationId}"}  (operator, once the old session has ended)`
    };
  }
  if (r.state === 'fenced' || r.state === 'rebinding') {
    return { blocker: r.failureCode ? `${r.failureCode}: ${r.failureDetail}` : 'the server is clearing and rebinding the coordinator', nextCommand: 'tc rotation advance' };
  }
  const why = [];
  if (d && d.unavailable && d.unavailable.length) why.push(`evidence unavailable: ${d.unavailable.join('; ')}`);
  if (d && d.trusted && d.trusted.length) why.push(`drift to dispose of: ${d.trusted.map((t) => t.key).join(', ')}`);
  if (r.readiness && r.readiness.verdict !== 'ready') why.push(`readiness: ${r.readiness.reason}`);
  return { blocker: why.length ? why.join(' | ') : 'waiting for the replacement context\'s receipt', nextCommand: 'tc rotation resume --receipt <file>' };
}

/** Coordinator roles the operator may grant. */
const COORDINATOR_ROLES = ['architect', 'project-manager'];

/**
 * The refusal for a caller who is not the operator, or null.
 * @param {object} caller - From `control-auth#resolveControlCaller`.
 * @param {string} what - What was attempted, for the message.
 * @returns {{status: number, body: object}|null}
 */
function _operatorOnly(caller, what) {
  if (caller && caller.kind === 'operator-unverifiable') {
    return _refuse(503, 'OPERATOR_UNVERIFIABLE', `The operator cannot be verified: ${caller.reason}.`);
  }
  if (!caller || caller.kind !== 'operator') return _refuse(403, 'OPERATOR_ONLY', `Only the operator can ${what}.`);
  return null;
}

/**
 * The operator grants a project a coordinator role (ruling A6a), replacing
 * its active one; the replacement carries the next authority version.
 * @param {object} input
 * @param {object} input.caller - From `control-auth#resolveControlCaller`.
 * @param {*} input.body - `{projectId, role, note?}`.
 * @param {object} [deps] - Seams.
 * @returns {{status: number, body: object}}
 */
function grantRole({ caller, body }, deps = {}) {
  const d = { ..._seams, ...deps };
  const refusal = _operatorOnly(caller, 'grant a coordinator role');
  if (refusal) return refusal;
  const b = _isObject(body) ? body : {};
  if (!Number.isSafeInteger(b.projectId) || !store.projects.get(b.projectId)) return _refuse(404, 'PROJECT_NOT_FOUND', 'No project has that id.');
  if (!COORDINATOR_ROLES.includes(b.role)) return _refuse(400, 'ROLE_INVALID', `role must be one of: ${COORDINATOR_ROLES.join(', ')}.`);
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 500)) return _refuse(400, 'ROLE_NOTE_INVALID', 'note must be text of at most 500 characters.');
  const role = store.coordinatorRoles.grant({
    roleId: `role_${crypto.randomBytes(9).toString('base64url')}`, projectId: b.projectId, role: b.role, note: b.note || null, now: d.now()
  });
  log.info('Coordinator role granted', { projectId: b.projectId, role: b.role, authorityVersion: role.authorityVersion });
  return { status: 201, body: { role } };
}

/**
 * The operator revokes a project's coordinator role. An open rotation
 * prepared under it can then no longer resume: that is authority drift.
 * @param {object} input
 * @param {object} input.caller - From `control-auth#resolveControlCaller`.
 * @param {*} input.body - `{projectId}`.
 * @param {object} [deps] - Seams.
 * @returns {{status: number, body: object}}
 */
function revokeRole({ caller, body }, deps = {}) {
  const d = { ..._seams, ...deps };
  const refusal = _operatorOnly(caller, 'revoke a coordinator role');
  if (refusal) return refusal;
  const b = _isObject(body) ? body : {};
  const role = Number.isSafeInteger(b.projectId) ? store.coordinatorRoles.revoke(b.projectId, d.now()) : null;
  if (!role) return _refuse(404, 'ROLE_NOT_FOUND', 'That project holds no active coordinator role.');
  log.warn('Coordinator role revoked', { projectId: b.projectId, roleId: role.roleId });
  return { status: 200, body: { role } };
}

// ---------------------------------------------------------------------------
// #2351 — Unreachable appointed decider detection & fallback (Architect
// Ruling A2351). The "appointed decider" IS an active `coordinator_roles`
// grant (`architect` or `project-manager`) — confirmed with the Architect
// against `prepare()`'s own `store.coordinatorRoles.getActiveForProject`
// check above: the grant means "this project is RECOGNIZED as a coordinator
// and may run governed rotation on its own session," not "this project
// rotates other projects." No new durable-alert table: the alert itself is a
// `lib/decision-routing.js` `decision_requests` row (`gate:
// 'decider-unreachable'`, `requiredAuthority: 'human'`), composing signals
// #2262 (`lib/workload-compose.js#receiptCurrency`) and #1978
// (`lib/medusa-wake.js#verdictFor`'s `engine-thread-unknown`) already ship —
// never re-detecting either.
// ---------------------------------------------------------------------------

/** How long unread mail may sit before #2351 treats a decider's silence as meaningful on its own. */
const DECIDER_SILENCE_MS = 20 * 60 * 1000;

/**
 * Which blocked senders have already been told the fallback route for an
 * OPEN outage decision (PRR-A I-Gate Round 3), keyed by `decision_requests.decision_id`.
 * Cleared when that decision's alert is superseded (recovery). A decision
 * the Operator answers directly, bypassing this module's own recovery path,
 * leaves one entry behind rather than a correctness problem -- bounded by
 * how many distinct outage episodes a project's whole lifetime can produce,
 * not by tick count.
 * @type {Map<string, Set<string>>}
 */
const _notifiedSenders = new Map();

/** The `decision_requests.gate` this car's alert is recorded under. */
const DECIDER_UNREACHABLE_GATE = 'decider-unreachable';

/** A dead-man's-switch backstop only — recovery (superseding on healthy signals) is the primary closure path, not this TTL. */
const DECIDER_ALERT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The states `lib/medusa-exchanges.js`'s own private `_awaitingRead` treats as
 * still waiting to be read — mirrored here rather than imported because that
 * function (and the state list) are not exported. `d.unreadExchanges`'s
 * default seam (`store.medusaExchanges.listOpenForRecipient`) returns every
 * open exchange, including ones already read/acknowledged but still owed a
 * reply — correct for {@link checkGovernedRefreshDue}'s owed-reply check,
 * wrong for "has this coordinator gone silent": a message the coordinator
 * already read is not evidence of silence (PRR-A I-Gate Round 2, PR #2839).
 * @type {ReadonlySet<string>}
 */
const _AWAITING_READ_STATES = Object.freeze(new Set(['stored', 'delivered', 'wake_pending', 'wake_blocked', 'wake_attempted', 'wake_not_accepted']));

/**
 * Of a workspace's open exchanges, only the ones genuinely never read —
 * same filter `lib/medusa-exchanges.js#_awaitingRead` applies, computed
 * independently here since that function is private.
 * @param {object[]} rows - From `d.unreadExchanges(workspaceId)`
 * @returns {object[]} Oldest first, same order as the input
 */
function _genuinelyUnread(rows) {
  return rows.filter((x) => _AWAITING_READ_STATES.has(x.state)
    && !store.medusaExchanges.facts(x.exchange_id).some((f) => f.fact === 'read' || f.fact === 'acknowledged'));
}

/**
 * The distinct sender workspaces among a set of exchange rows, in the order
 * their first row appears. A row with no sender workspace (an untracked or
 * system-origin send) is skipped — there is nobody there to notify.
 * @param {object[]} rows
 * @returns {string[]}
 */
function _distinctSenderWorkspaces(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const w = row.sender_workspace_id;
    if (w && !seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/**
 * The `request` from a decision-routing write result, logging and
 * returning `null` on a refusal instead of reading `.request` off it
 * unchecked. Every call site here builds `createDecision`/`supersedeDecision`'s
 * input from this module's own literals (a fixed gate, a validated prompt
 * string, an already-resolved project/session/launch id), so a refusal is
 * not a normal outcome this caller distinguishes — but `answerDecisionRequest`'s
 * route handler checks `.ok` before trusting `.request` (`_respondDecisionResult`),
 * and a composer calling the same module should fail the same way, not
 * silently crash on `undefined.request` instead (PRR Critic
 * `rev-20261103T100918Z-83fa358d`).
 * @param {{ok: boolean, request?: object, code?: string, message?: string}} result
 * @param {string} what - What was being written, for the log line
 * @returns {object|null}
 */
function _requestOrNull(result, what) {
  if (result.ok) return result.request;
  log.warn(`${what} was refused`, { code: result.code, message: result.message });
  return null;
}

/**
 * The active `coordinator_roles` grant of the given type, or `null`.
 * `store.coordinatorRoles.list()` returns every row (active and revoked);
 * this is the one filter every caller here needs, so it lives once.
 * @param {string} roleType - `'architect'` or `'project-manager'`
 * @returns {object|null}
 */
function _activeRoleOfType(roleType) {
  return store.coordinatorRoles.list().find((r) => r.status === 'active' && r.role === roleType) || null;
}

/**
 * Architect Ruling A2351's fallback matrix: a `project-manager` decider's
 * fallback is the active `architect` role (or the Operator, when none is
 * granted); an `architect` decider's fallback is always the Operator.
 * @param {string} role - The unreachable decider's own `coordinator_roles.role`
 * @returns {{role: string, projectId: (number|null)}}
 */
function _fallbackRoute(role) {
  if (role === 'project-manager') {
    const architect = _activeRoleOfType('architect');
    return architect ? { role: 'architect', projectId: architect.projectId } : { role: 'operator', projectId: null };
  }
  return { role: 'operator', projectId: null };
}

/**
 * Whether this project's active coordinator role is an unreachable decider
 * right now, recording (or replaying into) the one open alert for the
 * outage episode, or closing one whose episode has resolved (#2351).
 *
 * Fires when unread switchboard mail for the coordinator's live Medusa
 * workspace has persisted past {@link DECIDER_SILENCE_MS} AND EITHER the
 * wake verdict is `engine-thread-unknown` OR the workload receipt is
 * expired — composed from already-durable-or-live signals, never an
 * unproven engine root cause. The idempotency key is the project id plus
 * the OLDEST currently-unread exchange's own id, so repeated ticks during
 * the same outage replay into the single open row, and a later, genuinely
 * distinct outage (a different oldest-unread exchange) opens a fresh one.
 *
 * Recovery (Acceptance Bullet 4): when a project with an open alert on its
 * CURRENT session no longer meets the firing condition, that alert is
 * superseded with a recovery rationale. A relaunch's own supersession (a
 * NEW session/launch) is already covered by `answerDecisionRequest`'s own
 * lazy launch-currency check — this only handles "same session, situation
 * improved."
 * @param {number} projectId
 * @param {object} [deps] - Injected seams, test-overridable
 * @returns {{checked: boolean, fired: boolean, recovered: boolean, request: (object|null), reason: (string|null)}}
 */
function checkDeciderReachability(projectId, deps = {}) {
  const d = { ..._seams, ...deps };
  const decisionRouting = require('./decision-routing');

  const role = store.coordinatorRoles.getActiveForProject(projectId);
  if (!role) return { checked: false, fired: false, recovered: false, request: null, reason: 'not an appointed coordinator' };

  const session = store.sessions.getActive(projectId);
  if (!session) return { checked: false, fired: false, recovered: false, request: null, reason: 'no active session' };

  const sequence = store.launchSequences.getBySession(session.id);
  const launchId = sequence ? sequence.launchId : null;
  if (!launchId) return { checked: false, fired: false, recovered: false, request: null, reason: 'no launch sequence for this session' };

  const nowMs = Date.parse(d.now());

  const status = d.medusaStatus(session.id);
  const workspaceId = status && status.workspaceId;
  // Genuinely unread only (PRR-A I-Gate Round 2): a message this coordinator
  // already read, but has not yet replied to or closed, is not evidence of
  // silence — `d.unreadExchanges`'s own default seam returns every open
  // exchange, read or not, which {@link checkGovernedRefreshDue}'s owed-reply
  // check needs; this function does not, so it filters further.
  const unread = workspaceId ? _genuinelyUnread(d.unreadExchanges(workspaceId)) : [];
  const oldestUnread = unread[0] || null;
  const unreadAgeMs = oldestUnread ? nowMs - parseStoreTime(oldestUnread.created_at) : 0;

  const wakeVerdict = d.wakeVerdict(session.id);
  const wakeUnknown = Boolean(wakeVerdict && wakeVerdict.reason === 'engine-thread-unknown');

  const receiptRow = store.workloadReceipts.latestForLaunch(launchId);
  const receipt = workloadReceiptView(receiptRow);
  const currency = receiptCurrency(receipt, {
    sessionActive: true,
    launchLive: Boolean(receiptRow && receiptRow.launch_id === launchId),
    nowMs
  });
  const workloadExpired = !currency.current && currency.staleReason === 'expired';

  const silenceBoundMet = Boolean(oldestUnread) && unreadAgeMs >= DECIDER_SILENCE_MS;
  const shouldFire = silenceBoundMet && (wakeUnknown || workloadExpired);

  // Scoped by PROJECT, not the current session (PRR-A I-Gate Round 3's own
  // root cause, found adjacent to the fix below while testing it): the alert
  // may have opened under a PRIOR session that has since ended -- a session-
  // scoped query would silently see no open alert to recover, exactly the
  // same blind spot `sameBaseEpisodes` below has to avoid.
  const openAlerts = decisionRouting
    .listDecisionRequestsForProject(projectId, { state: decisionRouting.STATES.WAITING_DECISION })
    .filter((r) => r.gate === DECIDER_UNREACHABLE_GATE);

  if (!shouldFire) {
    if (openAlerts.length === 0) return { checked: true, fired: false, recovered: false, request: null, reason: 'healthy' };
    const reason = !oldestUnread ? 'recovered: unread mail drained' : 'recovered: wake and workload both healthy again';
    let closed = null;
    for (const alert of openAlerts) {
      closed = d.supersedeDecision(alert.decisionId, { reason });
      _notifiedSenders.delete(alert.decisionId);
    }
    return { checked: true, fired: false, recovered: true, request: closed ? _requestOrNull(closed, 'Superseding the decider-unreachable alert') : null, reason };
  }

  const deciderLabel = role.role === 'architect' ? 'Architect' : 'PM';
  const fallback = _fallbackRoute(role.role);
  const escalation = d.deciderOutageEscalation({
    deciderRole: deciderLabel,
    deciderName: `project #${projectId}`,
    lastDeliveryAt: nowMs - unreadAgeMs,
    timeoutMs: DECIDER_SILENCE_MS,
    health: 'degraded'
  });
  // PRR-A I-Gate Round 2: `escalation.payload.text` is generic (it never
  // mentions wake/workload) and used to win outright via `||`, silently
  // dropping the one concrete diagnostic this check actually has. Both
  // signals that can be true are named, not just whichever branch of a
  // ternary happened to be checked first.
  const diagnostics = [
    wakeUnknown ? 'wake status: engine-thread-unknown (not confirmed idle)' : null,
    workloadExpired ? 'workload receipt: expired' : null
  ].filter(Boolean).join('; ');
  const escalationText = escalation && escalation.payload && escalation.payload.text;
  const prompt = escalationText
    ? `${escalationText} Diagnostic signals -- ${diagnostics}.`
    : `${deciderLabel} coordinator (project #${projectId}) has been silent for ${Math.round(unreadAgeMs / 60000)}m. `
      + `Diagnostic signals -- ${diagnostics}.`;
  const fallbackChoice = fallback.role === 'operator'
    ? 'Escalate directly to the Operator'
    : `Fail over to the active ${fallback.role} (project #${fallback.projectId})`;

  // PRR-A I-Gate Round 3: a renewed outage on the SAME oldest-unread
  // exchange (recovery superseded the alert while that mail stayed
  // unread, then the decider went silent again before it was read) used
  // this same base idemKey -- createDecision's own replay logic then
  // handed back the superseded row as if it were live (`fired: true`,
  // `request.state === 'superseded'`, no open alert anywhere). A terminal
  // episode for this exact base never gets replayed into again; a fresh
  // one is minted instead, numbered by how many terminal episodes already
  // exist for it, so the FIRST outage on a given exchange still matches
  // the plain base idemKey every existing test/caller expects. Scoped by
  // PROJECT, not the current session: the coordinator's own session can
  // itself be a new one between episodes (the earlier outage may be exactly
  // what caused the relaunch), so a session-scoped query would silently miss
  // the prior episode and repeat the same bug this is fixing.
  const baseIdemKey = `decider-outage:${projectId}:${oldestUnread.exchange_id}`;
  const sameBaseEpisodes = decisionRouting.listDecisionRequestsForProject(projectId)
    .filter((r) => r.gate === DECIDER_UNREACHABLE_GATE && r.idemKey.startsWith(baseIdemKey));
  const liveEpisode = sameBaseEpisodes.find((r) => r.state === decisionRouting.STATES.WAITING_DECISION);
  const idemKey = liveEpisode ? liveEpisode.idemKey
    : sameBaseEpisodes.length === 0 ? baseIdemKey
      : `${baseIdemKey}:ep${sameBaseEpisodes.length + 1}`;

  const result = d.createDecision({
    idemKey,
    projectId,
    sessionId: session.id,
    launchId,
    prompt,
    choices: [`Operator takes over as ${deciderLabel}`, fallbackChoice],
    recommendation: fallback.role === 'operator' ? null : `Fallback route: ${fallback.role} (project #${fallback.projectId})`,
    requiredAuthority: 'human',
    gate: DECIDER_UNREACHABLE_GATE,
    reversible: false,
    ttlMs: DECIDER_ALERT_TTL_MS
  });

  // PRR-A I-Gate Round 2/3 (acceptance gap): every sender blocked on this
  // outage is told the fallback route, once each -- not only on the
  // episode's first firing: a SECOND sender's mail can age into
  // "genuinely unread" after the alert already opened, and Round 2's
  // `!result.replay` gate never notified them at all. Tracked per decision
  // id in `_notifiedSenders`, not per-tick, so a replay tick never re-sends
  // to a sender already told; a send that fails (network, a stale
  // workspace) is simply never added, so the next tick retries it rather
  // than marking a failed send as done.
  if (result.ok) {
    const decisionId = result.request.decisionId;
    let notified = _notifiedSenders.get(decisionId);
    if (!notified) {
      notified = new Set();
      _notifiedSenders.set(decisionId, notified);
    }
    const fallbackSentence = fallback.role === 'operator'
      ? 'This has been escalated to the Operator.'
      : `Failing over to the active ${fallback.role} (project #${fallback.projectId}).`;
    for (const senderWorkspace of _distinctSenderWorkspaces(unread)) {
      if (notified.has(senderWorkspace)) continue;
      Promise.resolve(d.notifySender(
        senderWorkspace,
        `[TangleClaw] Your message to the ${deciderLabel} coordinator (project #${projectId}) is unanswered -- `
          + `that coordinator may be unreachable. ${fallbackSentence} No action is required from you.`
      )).then(() => {
        notified.add(senderWorkspace);
      }, (err) => {
        log.warn('Could not notify a blocked sender of the decider fallback route; retrying next tick', {
          workspaceId: senderWorkspace, decisionId, error: err.message
        });
      });
    }
  }

  return {
    checked: true,
    fired: true,
    recovered: false,
    request: _requestOrNull(result, 'Recording the decider-unreachable alert'),
    reason: wakeUnknown ? 'engine-thread-unknown' : 'workload-expired'
  };
}

// ---------------------------------------------------------------------------
// #2353 — Governed refresh for long-running decider & Architect sessions
// (Architect Ruling A2353). Never forces a rotation itself: `prepare()`
// stays self/operator-initiated only (Ruling Bullet 1, already the existing
// behavior above — `store.coordinatorRoles.getActiveForProject` gates it).
// This notifies that a refresh is due, the same shape #2351 uses: a durable
// `decision_requests` alert, never a second table, never an autonomous
// rotation.
// ---------------------------------------------------------------------------

/** A decider/architect role's own session may run this long before a scheduled refresh is due, absent a low-context signal — matches the issue's own observed precedent for the Integrator/Observer roles (8h). */
const ROLE_REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000;

/** Context-remaining percentage at or below which a refresh is due regardless of runtime — matches #2787's own `DEFAULT_LOW_USAGE_HANDOFF_THRESHOLD_PCT` (`lib/usage-windows.js`), restated rather than imported to avoid coupling this car to that one's own file envelope. */
const LOW_CONTEXT_REMAINING_PCT = 12;

/** The `decision_requests.gate` this car's refresh-due alert is recorded under. */
const GOVERNED_REFRESH_GATE = 'governed-refresh-due';

/**
 * Whether this project's coordinator role is due a governed refresh right
 * now — role runtime past {@link ROLE_REFRESH_INTERVAL_MS}, or context
 * remaining at or below {@link LOW_CONTEXT_REMAINING_PCT} when the engine's
 * own pane statusline exposes that metric (never derived from session
 * age — an engine that exposes nothing reads `unknown` and cannot trigger
 * this branch). When due, records (or replays into) ONE durable alert
 * naming the owner, never forcing a rotation: the coordinator's own session
 * (or the Operator) decides to actually run `tc rotation prepare`.
 *
 * **Busy/active-ruling hold (Ruling Bullet 2):** defers (`held: true`,
 * no alert written yet) while the coordinator's workload is `working` or
 * it has an open owed Medusa reply — rotating only at a clean boundary. An
 * unresponsive (not merely busy) coordinator is {@link checkDeciderReachability}'s
 * path, not this one's.
 *
 * Recovery: an open alert on a project no longer due (a fresh session
 * landed, or runtime/context moved back under threshold) is superseded,
 * same shape as #2351's recovery closure.
 * @param {number} projectId
 * @param {object} [deps] - Injected seams, test-overridable
 * @returns {Promise<{checked: boolean, due: boolean, held: boolean, request: (object|null), reason: (string|null)}>}
 */
async function checkGovernedRefreshDue(projectId, deps = {}) {
  const d = { ..._seams, ...deps };
  const decisionRouting = require('./decision-routing');

  const role = store.coordinatorRoles.getActiveForProject(projectId);
  if (!role) return { checked: false, due: false, held: false, request: null, reason: 'not an appointed coordinator' };

  const session = store.sessions.getActive(projectId);
  if (!session) return { checked: false, due: false, held: false, request: null, reason: 'no active session' };

  const sequence = store.launchSequences.getBySession(session.id);
  const launchId = sequence ? sequence.launchId : null;
  if (!launchId) return { checked: false, due: false, held: false, request: null, reason: 'no launch sequence for this session' };

  const nowMs = Date.parse(d.now());
  const startedMs = parseStoreTime(session.startedAt);
  const runtimeMs = Number.isFinite(startedMs) ? nowMs - startedMs : NaN;
  const roleRuntimeDue = Number.isFinite(runtimeMs) && runtimeMs >= ROLE_REFRESH_INTERVAL_MS;

  const paneText = session.tmuxSession ? await d.capturePane(session.tmuxSession) : null;
  const usage = require('./usage-windows').parseSessionTerminalUsage(paneText, session.engineId);
  const contextKnown = usage.source === 'terminal-statusline' && Number.isFinite(usage.contextRemainingPct);
  const lowContextDue = contextKnown && usage.contextRemainingPct <= LOW_CONTEXT_REMAINING_PCT;

  const due = roleRuntimeDue || lowContextDue;
  const deciderLabel = role.role === 'architect' ? 'Architect' : 'PM';

  // Scoped by PROJECT, not the current session -- same adjacent fix as
  // checkDeciderReachability's own openAlerts above (PRR-A I-Gate Round 3):
  // the refresh alert may have opened under a session that has since ended
  // (a rotation, or an unrelated relaunch), and a session-scoped query would
  // silently never find it to recover.
  const openAlerts = decisionRouting
    .listDecisionRequestsForProject(projectId, { state: decisionRouting.STATES.WAITING_DECISION })
    .filter((r) => r.gate === GOVERNED_REFRESH_GATE);

  if (!due) {
    if (openAlerts.length === 0) return { checked: true, due: false, held: false, request: null, reason: 'not due' };
    let closed = null;
    for (const alert of openAlerts) {
      closed = d.supersedeDecision(alert.decisionId, { reason: 'recovered: refresh no longer due (runtime/context back under threshold, or a fresh session landed)' });
    }
    return { checked: true, due: false, held: false, request: closed ? _requestOrNull(closed, 'Superseding the governed-refresh alert') : null, reason: 'no-longer-due' };
  }

  const receiptRow = store.workloadReceipts.latestForLaunch(launchId);
  const receipt = workloadReceiptView(receiptRow);
  // PRR-A I-Gate Round 2: an EXPIRED 'working' receipt held the refresh
  // forever -- checking only receipt.state ignored that the receipt itself
  // can go stale, the same currency check checkDeciderReachability already
  // applies to the same receipt shape.
  const currency = receiptCurrency(receipt, {
    sessionActive: true,
    launchLive: Boolean(receiptRow && receiptRow.launch_id === launchId),
    nowMs
  });
  const isWorking = Boolean(receipt) && receipt.state === 'working' && currency.current;
  const status = d.medusaStatus(session.id);
  const workspaceId = status && status.workspaceId;
  const unread = workspaceId ? d.unreadExchanges(workspaceId) : [];
  const hasOpenOwedReply = unread.some((x) => require('./medusa-exchanges').isOwedReply(x));
  if (isWorking || hasOpenOwedReply) {
    return { checked: true, due: true, held: true, request: openAlerts[0] || null, reason: isWorking ? 'deferred-busy' : 'ruling-in-flight' };
  }

  const reasonText = roleRuntimeDue
    ? `This ${deciderLabel} session has run ${Math.round(runtimeMs / 3600000)}h, past its ${Math.round(ROLE_REFRESH_INTERVAL_MS / 3600000)}h governed-refresh interval.`
    : `This ${deciderLabel} session's context remaining is ${usage.contextRemainingPct}%, at or below the ${LOW_CONTEXT_REMAINING_PCT}% governed-refresh threshold.`;

  // PRR-A I-Gate Round 4: the same renewed-outage bug Round 3 fixed in
  // checkDeciderReachability, here too -- context/runtime can recover
  // (superseding the open alert), then go due again in the SAME launch
  // (same base idemKey), and createDecision's own replay logic would hand
  // back the dead superseded row as live. Mints a fresh :ep<N> idemKey once
  // every existing episode for this base is terminal, scoped by PROJECT
  // (not session) for the same reason Round 3's fix was.
  const baseGovernedRefreshKey = `governed-refresh:${projectId}:${launchId}`;
  const sameBaseGovernedEpisodes = decisionRouting.listDecisionRequestsForProject(projectId)
    .filter((r) => r.gate === GOVERNED_REFRESH_GATE && r.idemKey.startsWith(baseGovernedRefreshKey));
  const liveGovernedEpisode = sameBaseGovernedEpisodes.find((r) => r.state === decisionRouting.STATES.WAITING_DECISION);
  const governedRefreshIdemKey = liveGovernedEpisode ? liveGovernedEpisode.idemKey
    : sameBaseGovernedEpisodes.length === 0 ? baseGovernedRefreshKey
      : `${baseGovernedRefreshKey}:ep${sameBaseGovernedEpisodes.length + 1}`;

  const result = d.createDecision({
    idemKey: governedRefreshIdemKey,
    projectId,
    sessionId: session.id,
    launchId,
    prompt: `${reasonText} Run 'tc rotation prepare' to begin a governed handoff at a clean boundary.`,
    choices: ['Operator schedules the refresh now', 'Defer — not yet at a clean boundary'],
    recommendation: null,
    requiredAuthority: 'human',
    gate: GOVERNED_REFRESH_GATE,
    reversible: true,
    ttlMs: DECIDER_ALERT_TTL_MS
  });

  return { checked: true, due: true, held: false, request: _requestOrNull(result, 'Recording the governed-refresh alert'), reason: roleRuntimeDue ? 'role-runtime' : 'low-context' };
}

// ---------------------------------------------------------------------------
// The recurring tick (#2351, #2353 Critic BLOCKING: both checks above are
// built but, without this, have no caller anywhere — neither issue's
// acceptance criterion, a bound automatic detection or a routine interval
// producing an alert, can be met by a function nothing ever calls). Mirrors
// `lib/workload-nudge.js`'s own start/stop/tick shape: a self-contained
// module-owned `setInterval`, unref'd so it never holds the process open,
// idempotent start, and a tick that catches per-project so one project's
// throw never stops the pass.
// ---------------------------------------------------------------------------

/** Tick cadence. Both checks below are already keyed to minute/hour-scale thresholds, so sub-minute precision buys nothing. */
const REFRESH_MONITOR_INTERVAL_MS = 60 * 1000;

/** @type {NodeJS.Timeout|null} */
let _refreshMonitorTimer = null;

/**
 * One pass: for every project with an active `coordinator_roles` grant (the
 * monitor's own opt-in — a project never appointed a decider is never
 * checked), run #2351's reachability check and #2353's governed-refresh
 * check. A project's own check never runs concurrently with itself within
 * one tick; nothing here awaits across ticks.
 * @param {object} [deps] - Threaded into both checks, test-overridable; the real monitor passes none, so each check uses its own real `_seams`.
 * @returns {Promise<Record<number, {reachability: object, refresh: object}|{error: string}>>}
 *   Keyed by project id, for the tests and for a caller driving the monitor by hand.
 */
async function refreshMonitorTick(deps = {}) {
  const results = {};
  const roles = store.coordinatorRoles.list().filter((r) => r.status === 'active');
  for (const role of roles) {
    try {
      const reachability = checkDeciderReachability(role.projectId, deps);
      const refresh = await checkGovernedRefreshDue(role.projectId, deps);
      results[role.projectId] = { reachability, refresh };
    // prawduct:allow prawduct/broad-except -- one project's check must not stop the pass over the rest; the next tick retries it
    } catch (err) {
      log.warn('Decider-reachability/governed-refresh check failed for one project', { projectId: role.projectId, error: err.message });
      results[role.projectId] = { error: err.message };
    }
  }
  return results;
}

/**
 * Start the monitor. Idempotent: a second call while running is a no-op.
 * @param {{intervalMs?: number}} [opts]
 * @returns {void}
 */
function startRefreshMonitor(opts = {}) {
  if (_refreshMonitorTimer) return;
  const intervalMs = opts.intervalMs || REFRESH_MONITOR_INTERVAL_MS;
  _refreshMonitorTimer = setInterval(() => {
    refreshMonitorTick().catch((err) => log.warn('coordinator-rotation refresh monitor: tick error', { error: err.message }));
  }, intervalMs);
  if (_refreshMonitorTimer.unref) _refreshMonitorTimer.unref(); // never hold the event loop open
  log.info('Decider-reachability/governed-refresh monitor started', { intervalMs });
}

/**
 * Stop the monitor.
 * @returns {void}
 */
function stopRefreshMonitor() {
  if (_refreshMonitorTimer) {
    clearInterval(_refreshMonitorTimer);
    _refreshMonitorTimer = null;
  }
}

/**
 * Restart the driver for every rotation the server still owns a step of,
 * after a restart. Rotations waiting on their context (`reconciling`) need no
 * driver.
 * @param {object} [opts] - Passed to {@link drive}.
 * @returns {number} How many drivers started.
 */
function recover(opts = {}) {
  let n = 0;
  for (const r of store.coordinatorRotations.listOpen()) {
    if (r.state === 'fenced' || r.state === 'rebinding') {
      drive(r.rotationId, opts);
      n += 1;
    }
  }
  return n;
}

module.exports = {
  MAX_CLEAR_ATTEMPTS,
  CLEAR_RETRY_MS,
  CLEAR_SETTLE_MS,
  MAX_JSON_DEPTH,
  REBIND_WINDOW_MS,
  canonicalJson,
  validateCheckpoint,
  reentryDigest,
  view,
  openRotation,
  gate,
  GATED_ACTIONS,
  prepare,
  advance,
  drive,
  resume,
  abandon,
  recover,
  grantRole,
  revokeRole,
  claimRelaunch,
  nextStep,
  checkDeciderReachability,
  DECIDER_SILENCE_MS,
  DECIDER_UNREACHABLE_GATE,
  DECIDER_ALERT_TTL_MS,
  checkGovernedRefreshDue,
  ROLE_REFRESH_INTERVAL_MS,
  LOW_CONTEXT_REMAINING_PCT,
  GOVERNED_REFRESH_GATE,
  refreshMonitorTick,
  startRefreshMonitor,
  stopRefreshMonitor,
  REFRESH_MONITOR_INTERVAL_MS,
  _seams
};
