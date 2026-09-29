'use strict';

/**
 * Governed coordinator context rotation (#2032).
 *
 * A coordinator (Architect, ProjectManager) that clears its context must not
 * come back as a live-but-unoriented authority, and its control channel must
 * not stay bound to a thread that no longer exists. A rotation is an explicit
 * transition with one durable record:
 *
 *   fenced → rebinding → reconciling → active      (abandoned: operator exit)
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
const { EXPIRY_MS: WORKLOAD_EXPIRY_MS } = require('./workload-compose');
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

/** How many times `/clear` is typed before the rotation says it did not take. */
const MAX_CLEAR_ATTEMPTS = 3;

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
  fingerprint: (dir, opts) => checkoutFingerprint.fingerprint(dir, opts),
  github: (facts) => githubFacts.observeAll(facts),
  launch: (projectName) => require('./sessions').launchSession(projectName, { primePrompt: true }),
  sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); }),
  now: () => new Date().toISOString()
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
 * JSON with object keys sorted at every level, so the same content always has
 * the same digest whatever order the caller wrote it in.
 * @param {*} value - Any JSON value.
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
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
    if (branch.importantIgnored !== undefined && !_stringList(branch.importantIgnored)) missing.push('branch.importantIgnored');
  }
  if (typeof checkpoint.note !== 'string' || !checkpoint.note.trim()) missing.push('note');
  const gh = githubFacts.validateFacts(checkpoint.github);
  if (!gh.ok) missing.push(`github (${gh.message})`);
  if (missing.length) return { ok: false, missing, message: `The checkpoint is incomplete: ${missing.join(', ')}.` };
  const canonical = canonicalJson(checkpoint);
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
  if (Buffer.byteLength(canonicalJson(receipt), 'utf8') > MAX_DOCUMENT_BYTES) {
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
    '**New dispatch from this project is FENCED** until your resume receipt is accepted. Replies to open exchanges still go through.',
    '',
    rotation.mode === 'relaunch'
      ? '1. Complete your launch sequence with `tc start next` if you have not already.'
      : '1. `tc start review` — re-read the launch context you attested (read-only).',
    '2. `tc rotation show` — read the checkpoint your previous context left, and the inbox messages it left unhandled.',
    '3. Reconcile every checkpoint fact against live state: `git` in your checkout, GitHub (`gh`), `tc sessions`, '
      + '`tc control status`, and your Medusa inbox. Handle each message the rotation lists (read it, act, reply, mark it handled). '
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

/** Coordinator-authority mutations the epoch gate judges (ruling A12). */
const GATED_ACTIONS = new Set([
  'medusa-send', 'medusa-ack', 'exchange-close', 'workload-set', 'wrap', 'session-rule-write', 'control-mutate', 'control-ack'
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
 * - While `reconciling`, the bound replacement may only publish workload,
 *   acknowledge its control generation, and reply to, acknowledge or close
 *   what the checkpoint's interval named. New dispatch waits for resume.
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
 * @returns {{status: number, body: object}|null} A refusal, or null to proceed.
 */
function gate({ projectId, access, threadId, action, inReplyTo, messageIds, exchangeId }) {
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
    return _refuse(409, 'COORDINATOR_EPOCH_MISMATCH',
      `Coordinator actions for this project are accepted only from the thread and launch bound at generation ${latest.generation}; `
        + 'this request is not from them (a stale or other thread, another pane, or no launch binding).',
      { rotationId: latest.rotationId, generation: latest.generation, action });
  }
  if (latest.state === 'active') return null;
  if (action === 'workload-set' || action === 'control-ack') return null;
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
  const seen = d.fingerprint(project && project.path, { importantIgnored: branch.importantIgnored || [] });
  if (!seen.ok) return _refuse(409, 'ROTATION_CHECKOUT_UNAVAILABLE', `The checkout could not be fingerprinted (${seen.reason}).`);
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
  const bad = Object.entries(fp.importantIgnored).filter(([, h]) => h.startsWith('unavailable:'));
  if (bad.length) {
    return _refuse(409, 'ROTATION_IGNORED_FILE_UNAVAILABLE',
      `Declared important ignored files could not be hashed: ${bad.map(([p, h]) => `${p} (${h.slice(12)})`).join(', ')}.`);
  }
  return null;
}

/**
 * A prepare whose attempt key already has a row: the same request replayed
 * returns it; the key reused for different content or another project is
 * refused, never merged.
 * @param {object} existing - The stored rotation.
 * @param {object} access - The caller.
 * @param {string} digest - The replayed checkpoint's digest.
 * @returns {{status: number, body: object}}
 */
function _replayedPrepare(existing, access, digest) {
  if (existing.projectId !== access.projectId || existing.checkpointDigest !== digest) {
    return _refuse(409, 'ROTATION_ATTEMPT_KEY_REUSED', 'That attemptKey already names a different rotation.');
  }
  return { status: 200, body: { rotation: view(existing), replayed: true } };
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
 * until the rotation reaches `reconciling` or a step cannot proceed.
 * @param {string} rotationId - Rotation id.
 * @param {object} [deps] - Seams.
 * @returns {Promise<object|null>} The rotation after the pass.
 */
async function advance(rotationId, deps = {}) {
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
    { state: 'rebinding', priorThreads: threads.map((t) => t.id), clearAttempts: rotation.clearAttempts + 1, failureCode: null, failureDetail: null },
    { now: d.now() });
  if (!moved.written) return moved.rotation;
  return _typeClear(moved.rotation, subject, d);
}

/**
 * Type `/clear` into the rotation's session pane. The attempt was counted
 * before this call, so a crash after it can only under-report success, never
 * send an uncounted one.
 * @param {object} rotation - The rotation, attempt already counted.
 * @param {object} subject - From {@link _subject}.
 * @param {object} d - Seams.
 * @returns {object}
 */
function _typeClear(rotation, subject, d) {
  const sent = d.inject(subject.project.name, '/clear', { sessionId: rotation.sessionId });
  if (!sent || !sent.ok) return _fail(rotation, 'clear-refused', `The /clear could not be typed: ${(sent && sent.error) || 'no answer'}.`, d);
  log.info('Coordinator rotation typed /clear', { rotationId: rotation.rotationId, attempt: rotation.clearAttempts });
  return rotation;
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
      if (prior.status !== 'idle') return _fail(rotation, 'prior-thread-busy', 'The prior thread is working again; the clear did not take.', d);
      if (rotation.clearAttempts >= MAX_CLEAR_ATTEMPTS) {
        return _fail(rotation, 'clear-not-applied', `The prior thread is still loaded after ${rotation.clearAttempts} /clear attempts.`, d);
      }
      const counted = store.coordinatorRotations.updateIf(rotation.rotationId, 'rebinding',
        { clearAttempts: rotation.clearAttempts + 1 },
        { now: d.now(), test: (r) => r.clearAttempts === rotation.clearAttempts && !r.replacementThreadId });
      return counted.written ? _typeClear(counted.rotation, subject, d) : counted.rotation;
    }
    if (prior) return _fail(rotation, 'prior-thread-still-loaded', 'The prior thread is still loaded beside a new one, so the replacement is not provable.', d);
    if (fresh.length === 0) return _fail(rotation, 'replacement-not-loaded', 'No new thread has appeared in the project directory yet.', d);
    if (fresh.length > 1) {
      return _fail(rotation, 'replacement-ambiguous', `${fresh.length} new threads appeared (${fresh.map((t) => t.id).join(', ')}); binding none.`, d);
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
 * and bound by {@link claimRelaunch}, so its channel is the rotation's; the
 * replacement is the thread that channel records, or — when the launch's
 * startup fire has not recorded one yet — the sole root thread its own
 * app-server has loaded, bound by compare-and-set exactly as an ordinary
 * observation would. Several root threads bind nothing.
 * @param {object} rotation - A `rebinding` relaunch rotation.
 * @param {object} subject - From {@link _subject}.
 * @param {object[]} threads - The successor's loaded project threads.
 * @param {object} adapter - The Codex adapter.
 * @param {object} d - Seams.
 * @returns {Promise<object>}
 */
async function _relaunchRebindStep(rotation, subject, threads, adapter, d) {
  let channel = subject.channel;
  let replacement = channel.adapterState && channel.adapterState.threadId;
  if (!replacement) {
    const roots = threads.filter((t) => !t.subagent);
    if (roots.length === 0) return _fail(rotation, 'replacement-not-loaded', 'The successor launch has not opened a thread yet.', d);
    if (roots.length > 1) return _fail(rotation, 'replacement-ambiguous', `The successor has ${roots.length} root threads; binding none.`, d);
    const bound = adapter.bindUnrecordedThread(channel, roots[0].id);
    if (!bound.bound) return _fail(rotation, 'channel-changed', 'The successor channel recorded another thread first; nothing was bound.', d);
    channel = bound.channel;
    replacement = roots[0].id;
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
      } catch (err) { // prawduct:allow prawduct/broad-except -- a background driver must not crash the server; the row keeps its state and a later advance resumes
        log.warn('Coordinator rotation pass failed', { rotationId, error: err.message });
      }
      if (!rotation || rotation.state !== 'fenced' && rotation.state !== 'rebinding') return rotation;
      if (rotation.mode === 'relaunch' && rotation.state === 'fenced') return rotation;
      await d.sleep(intervalMs);
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
  const integrity = _integrityDrift(rotation, d);
  const gh = await d.github((rotation.checkpoint && rotation.checkpoint.github) || []);
  const trusted = githubFacts.drift(rotation.github || [], gh.observations);
  const readiness = _readiness(rotation, access, d);
  const drift = {
    observedAt,
    integrity: integrity.items,
    unavailable: [...integrity.unavailable, ...gh.unavailable],
    trusted,
    dispositions: b.receipt.drift
  };
  const refuse = (status, code, message, details) => {
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
 * @returns {{items: Array<{class: string, key: string, before: string, after: string}>, unavailable: string[]}}
 */
function _integrityDrift(rotation, d) {
  const items = [];
  const unavailable = [];
  const role = store.coordinatorRoles.getActiveForProject(rotation.projectId);
  const now = role ? `${role.roleId}@${role.authorityVersion}` : 'none';
  const then = `${rotation.roleId}@${rotation.authorityVersion}`;
  if (now !== then) items.push({ class: 'authority', key: 'authority.coordinator-role', before: then, after: now });
  const project = store.projects.get(rotation.projectId);
  const importantIgnored = Object.keys((rotation.checkout && rotation.checkout.importantIgnored) || {});
  const seen = d.fingerprint(project && project.path, { importantIgnored });
  if (!seen.ok) {
    unavailable.push(`checkout: ${seen.reason}`);
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
  const inbox = new Set((d.messages(rotation.sessionId) || []).map((m) => m && m.id));
  const left = (rotation.inboxIds || []).filter((id) => inbox.has(id));
  if (left.length) out.push({ fact: 'medusa', detail: `${left.length} message(s) from before the rotation are still unhandled: ${left.join(', ')}.` });
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
 * channel is left as it stands. Operator only.
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
  if (!OPEN_STATES.has(rotation.state)) return _refuse(409, 'ROTATION_NOT_OPEN', `The rotation is already ${rotation.state}.`);
  const now = d.now();
  const done = store.coordinatorRotations.updateIf(rotation.rotationId, rotation.state,
    { state: 'abandoned', completedAt: now, failureCode: 'abandoned', failureDetail: reason.slice(0, 500) }, { now });
  if (!done.written) return _refuse(409, 'ROTATION_CHANGED', 'The rotation changed; read it and retry.');
  log.warn('Coordinator rotation abandoned by the operator', { rotationId: rotation.rotationId, reason });
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
 * @returns {{status: number, body: object}}
 */
function claimRelaunch({ caller, body }, deps = {}) {
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
  const bound = store.coordinatorRotations.updateIf(rotation.rotationId, 'fenced',
    { state: 'rebinding', sessionId: session.id, launchId: sequence.launchId, channelId: channel.id, sequenceId: channel.sequenceId,
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
  CHECKPOINT_SCHEMA,
  RECEIPT_SCHEMA,
  MAX_CLEAR_ATTEMPTS,
  canonicalJson,
  validateCheckpoint,
  validateReceipt,
  reentryDigest,
  renderReentry,
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
  COORDINATOR_ROLES,
  DRIFT_DISPOSITIONS,
  _seams
};
