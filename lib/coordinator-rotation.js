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
 *   observe — the inbox interval is drained, the git head, the control
 *   generation, a fresh workload receipt — and only then marks the rotation
 *   active, which is what lifts the fence.
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
const childProcess = require('node:child_process');
const store = require('./store');
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

/** Adapters whose channel can name and rebind threads. */
const REBINDABLE_ADAPTERS = new Set(['codex']);

/**
 * Seams for tests. `adapter` is the Codex startup-control adapter; `inject`
 * types a command into the session's pane; `messages` reads its in-memory
 * Medusa inbox; `gitHead` reads a checkout's HEAD; `sleep` paces the driver.
 */
const _seams = {
  adapter: () => require('./startup-control-codex'),
  inject: (projectName, command, opts) => require('./sessions').injectCommand(projectName, command, opts),
  messages: (sessionId) => require('./medusa').getMessages(sessionId),
  gitHead: (dir) => {
    try {
      return childProcess.execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  },
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
  if (!_isObject(checkpoint.branch) || typeof checkpoint.branch.head !== 'string' || !checkpoint.branch.head) missing.push('branch.head');
  if (typeof checkpoint.note !== 'string' || !checkpoint.note.trim()) missing.push('note');
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
  if (!Array.isArray(receipt.drift)) missing.push('drift (an empty list when none was found)');
  const r = receipt.reconciled;
  if (!_isObject(r)) {
    missing.push('reconciled');
  } else {
    if (!_isObject(r.git) || !('head' in r.git)) missing.push('reconciled.git.head');
    if (!_isObject(r.github) || typeof r.github.checkedAt !== 'string') missing.push('reconciled.github.checkedAt');
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
 * reconciliation; it does not replay the launch handoff as current work.
 * @param {object} rotation - The rotation.
 * @param {object} project - The project (its `name`).
 * @returns {string}
 */
function renderReentry(rotation, project) {
  const name = project && project.name ? project.name : 'this project';
  return [
    `# Coordinator context rotation — ${name}`,
    '',
    `Your context was just rotated under managed rotation \`${rotation.rotationId}\` (generation ${rotation.generation}). `
      + 'This is a re-entry into a running session, not a new launch: do not restart the launch sequence or re-attest READY.',
    '',
    '**New dispatch from this project is FENCED** until your resume receipt is accepted. Replies to open exchanges still go through.',
    '',
    '1. `tc start review` — re-read the launch context you attested (read-only).',
    '2. `tc rotation show` — read the checkpoint your previous context left, and the inbox messages it left unhandled.',
    '3. Reconcile every checkpoint fact against live state: `git` in your checkout, GitHub (`gh`), `tc sessions`, '
      + '`tc control status`, and your Medusa inbox. Handle each message the rotation lists (read it, act, reply, mark it handled). '
      + 'Publish a current receipt with `tc workload set`.',
    '4. Write the receipt JSON the show output describes and run `tc rotation resume --receipt <file>`. '
      + 'If it is refused, it names the missing evidence: fix that and resubmit.',
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

/**
 * Whether a Medusa send from `projectId` is new dispatch the fence holds.
 * A reply (`inReplyTo`) is not new dispatch: the replacement context may have
 * to answer a question to finish reconciling.
 * @param {number|null} projectId - The sending project.
 * @param {object} body - The send body.
 * @returns {{status: number, body: object}|null} A refusal, or null to proceed.
 */
function sendFenceRefusal(projectId, body) {
  const rotation = openRotation(projectId);
  if (!rotation) return null;
  if (body && typeof body.inReplyTo === 'string' && body.inReplyTo) return null;
  return _refuse(409, 'COORDINATOR_FENCED',
    `This project is in managed context rotation ${rotation.rotationId} (${rotation.state}); new dispatch is held until `
      + 'its resume receipt is accepted. Replies to an open exchange are allowed.',
    { rotationId: rotation.rotationId, state: rotation.state });
}

/**
 * Begin a rotation for the calling coordinator's own session.
 * @param {object} input
 * @param {object} input.access - Verified launch: `{projectId, sessionId, launchId}`.
 * @param {*} input.body - `{attemptKey, checkpoint}`.
 * @param {object} [deps] - Seams.
 * @returns {{status: number, body: object}}
 */
function prepare({ access, body }, deps = {}) {
  const d = { ..._seams, ...deps };
  const b = _isObject(body) ? body : {};
  const attemptKey = b.attemptKey;
  if (typeof attemptKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(attemptKey)) {
    return _refuse(400, 'ROTATION_BAD_ATTEMPT_KEY', 'attemptKey must be 8–128 characters of letters, digits, ".", "_", ":" or "-".');
  }
  const checked = validateCheckpoint(b.checkpoint);
  if (!checked.ok) return _refuse(400, 'ROTATION_CHECKPOINT_INCOMPLETE', checked.message, { missing: checked.missing });

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
  const r = store.coordinatorRotations.updateIf(rotation.rotationId, rotation.state,
    { failureCode: code, failureDetail: detail.slice(0, 500) }, { now: d.now() });
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
  const subject = _subject(rotation);
  if (subject.blocker) return _fail(rotation, subject.blocker, 'The session, project or control channel changed under the rotation.', d);
  const adapter = d.adapter();
  const seen = await adapter.rotationThreads(subject.channel, subject.project, d.adapterDeps || {});
  if (seen.blocker) return _fail(rotation, seen.blocker, 'The control channel could not list the project\'s threads.', d);
  return rotation.state === 'fenced'
    ? _clearStep(rotation, subject, seen.threads, d)
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
 * must be gone: if it is still loaded beside a new one, which is the
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

  const replacementThread = threads.find((t) => t.id === replacement);
  if (!replacementThread || replacementThread.status !== 'idle') {
    return _fail(current, 'replacement-busy', 'Waiting for the replacement thread to be idle before sending the re-entry turn.', d);
  }
  const digest = reentryDigest(current);
  const delivered = await adapter.deliverTurn(bound.channel, subject.project,
    { threadId: replacement, text: renderReentry(current, subject.project), clientId: digest }, d.adapterDeps || {});
  if (delivered.blocker) return _fail(current, `reentry-${delivered.blocker}`, 'The re-entry turn could not be delivered.', d);
  const done = store.coordinatorRotations.updateIf(current.rotationId, 'rebinding',
    { state: 'reconciling', reentryDigest: digest, failureCode: null, failureDetail: null }, { now: d.now() });
  if (done.written) log.info('Coordinator rotation delivered its re-entry turn', { rotationId: current.rotationId, status: delivered.status });
  return done.rotation;
}

/** Rotations whose driver is running in this process. */
const _driving = new Map();

/**
 * Repeat {@link advance} until the rotation leaves the server's hands
 * (`reconciling`, `active`, `abandoned`) or the attempts run out. One driver
 * per rotation per process; a second call joins the first.
 * @param {string} rotationId - Rotation id.
 * @param {object} [opts]
 * @param {number} [opts.attempts=180] - Passes before giving up (a later `advance` call resumes).
 * @param {number} [opts.intervalMs=1000] - Pause between passes.
 * @param {object} [opts.deps] - Seams.
 * @returns {Promise<object|null>}
 */
function drive(rotationId, { attempts = 180, intervalMs = 1000, deps = {} } = {}) {
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
 * @param {*} input.body - `{rotationId, attemptKey, generation, receipt}`.
 * @param {object} [deps] - Seams.
 * @returns {{status: number, body: object}}
 */
function resume({ access, body }, deps = {}) {
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
  if (rotation.state === 'active') {
    const same = rotation.receipt && canonicalJson(rotation.receipt) === canonicalJson(b.receipt);
    return same
      ? { status: 200, body: { rotation: view(rotation), replayed: true } }
      : _refuse(409, 'ROTATION_ALREADY_ACTIVE', 'This rotation already resumed with a different receipt.');
  }
  if (rotation.state !== 'reconciling') {
    return _refuse(409, 'ROTATION_NOT_RECONCILING',
      `The rotation is ${rotation.state}; the server has not yet delivered the re-entry turn, so there is nothing to resume.`,
      { rotation: view(rotation) });
  }

  const shape = validateReceipt(b.receipt);
  if (!shape.ok) return _refuse(400, 'ROTATION_RECEIPT_INCOMPLETE', shape.message, { missing: shape.missing });
  const evidence = _crossCheck(rotation, b.receipt, access, d);
  if (evidence.length) {
    return _refuse(409, 'ROTATION_EVIDENCE_MISSING',
      `The fence stays up: ${evidence.map((e) => e.detail).join(' ')}`, { missing: evidence });
  }

  const now = d.now();
  const done = store.coordinatorRotations.updateIf(rotation.rotationId, 'reconciling',
    { state: 'active', receipt: b.receipt, completedAt: now, failureCode: null, failureDetail: null },
    { now, test: (r) => r.generation === b.generation });
  if (!done.written) return _refuse(409, 'ROTATION_CHANGED', 'The rotation changed while the receipt was checked; read it and retry.');
  log.info('Coordinator rotation resumed; fence lifted', { rotationId: rotation.rotationId, generation: rotation.generation });
  return { status: 200, body: { rotation: view(done.rotation) } };
}

/**
 * The receipt's claims the server can check for itself, and each that fails.
 * @param {object} rotation - The rotation.
 * @param {object} receipt - A shape-valid receipt.
 * @param {object} access - The caller.
 * @param {object} d - Seams.
 * @returns {Array<{fact: string, detail: string}>}
 */
function _crossCheck(rotation, receipt, access, d) {
  const out = [];
  if (receipt.checkpointDigest !== rotation.checkpointDigest) {
    out.push({ fact: 'checkpoint', detail: 'The receipt names a different checkpoint than the one this rotation recorded.' });
  }
  const inbox = new Set((d.messages(rotation.sessionId) || []).map((m) => m && m.id));
  const left = (rotation.inboxIds || []).filter((id) => inbox.has(id));
  if (left.length) out.push({ fact: 'medusa', detail: `${left.length} message(s) from before the rotation are still unhandled: ${left.join(', ')}.` });
  const project = store.projects.get(rotation.projectId);
  const head = project && project.path ? d.gitHead(project.path) : null;
  if (head !== null && receipt.reconciled.git.head !== head) {
    out.push({ fact: 'git', detail: `The receipt's git head is ${receipt.reconciled.git.head}; the checkout is at ${head}.` });
  }
  const assignment = store.control.getOpenForProject(rotation.projectId);
  const generation = assignment ? assignment.state_generation : null;
  if (receipt.reconciled.control.stateGeneration !== generation) {
    out.push({ fact: 'control', detail: `The receipt's control generation is ${receipt.reconciled.control.stateGeneration}; the lane is at ${generation}.` });
  }
  const latest = store.workloadReceipts.latestForLaunch(access.launchId);
  if (!latest || !(latest.received_at > rotation.createdAt)) {
    out.push({ fact: 'workload', detail: 'No workload receipt was published after the rotation began (`tc workload set`).' });
  }
  return out;
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
  if (!caller || caller.kind !== 'operator') {
    return _refuse(403, 'OPERATOR_ONLY', 'Only the operator can abandon a coordinator rotation.');
  }
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
  sendFenceRefusal,
  prepare,
  advance,
  drive,
  resume,
  abandon,
  recover,
  _seams
};
