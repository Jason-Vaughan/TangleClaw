'use strict';

/**
 * What a certification publishes, and when: the policy between the private
 * run and the public `metrics` branch (ADR 0021).
 *
 * - **Admission is fail-closed.** `admit` publishes the admission record and
 *   then reads it back from the remote. A record already there with different
 *   bytes refuses (`ADMISSION_CONFLICT`); a read-back that does not match
 *   refuses (`ADMISSION_UNPUBLISHED`). The runner commits a run only after
 *   `admit` returns.
 * - **Updates never touch certification.** `update` publishes the scorecard,
 *   the transitions not yet published and the index. A failure is recorded
 *   in `publish.json` with an exponential backoff and changes no qualified
 *   time. Publishing is a view of the evidence, not evidence.
 * - **Sequence and history only move forward.** Each scorecard carries a
 *   `publishSeq` above both the remote's and our own last one, and the
 *   remote's transition log must be a prefix of ours (`EVENTS_DIVERGED`
 *   otherwise), so a publish never rewrites history.
 *
 * `publish.json` is private and records only publishing: what was verified,
 * the last sequence published, and the last failure. It is never read as
 * certification state.
 *
 * @module lib/release-certification/publication
 */

const sc = require('./scorecard');
const verify = require('./verify');
const store = require('./store');
const privateFs = require('./private-fs');
const { REFUSAL, CertificationError, isTerminal } = require('./codes');

const STATUS_SCHEMA = 'tc.release-certification.publish/v1';
/** A live run republishes at least this often, so readers can see it is alive. */
const HEARTBEAT_MS = 60 * 60 * 1000;
/**
 * A live run publishes at most this often: a run flapping between running and
 * extended would otherwise push a public commit on every tick. A terminal
 * state is exempt, so the final standing is never held back.
 */
const MIN_INTERVAL_MS = 60 * 1000;
/** Backoff after a failed publish: 1 min, doubling, capped at 30 min. */
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

/**
 * Throw a refusal.
 * @param {string} code - A REFUSAL code
 * @param {string} message - Why
 * @param {object} [details] - Bounded facts
 * @returns {never}
 */
function _refuse(code, message, details) {
  throw new CertificationError(code, message, details);
}

/**
 * The delay before the next attempt after `failures` consecutive failures.
 * @param {number} failures - Consecutive failures, at least 1
 * @returns {number} Milliseconds
 */
function backoffMs(failures) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * Read a candidate's `publish.json`, or a fresh status when none exists. An
 * unreadable file reads as fresh with `lastError: STATUS_UNREADABLE`, because
 * publishing bookkeeping must never stop certification.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - Candidate SHA
 * @returns {object} Status
 */
function readStatus(base, candidateSha) {
  const fresh = { schema: STATUS_SCHEMA, admission: null, lastPublishedSeq: 0, lastPublishedAt: null, failures: 0, lastError: null, lastMessage: null, nextAttemptAt: null };
  const text = privateFs.readPrivate(store.runPaths(base, candidateSha).publish);
  if (text === null) return fresh;
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.schema === STATUS_SCHEMA) return parsed;
  } catch {
    // Falls through to the unreadable status.
  }
  return { ...fresh, lastError: 'STATUS_UNREADABLE' };
}

/**
 * Record a publish failure for a candidate without a publication object: the
 * path a caller takes when it could not even build one (no git identity, no
 * origin), which ADR 0021 still requires to be recorded.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - Candidate SHA
 * @param {Error} err - The failure
 * @param {number} [at] - Epoch ms
 * @returns {object} The new status
 */
function recordFailureFor(base, candidateSha, err, at = Date.now()) {
  const current = readStatus(base, candidateSha);
  const failures = (current.failures || 0) + 1;
  const next = { ...current, failures, lastError: err.code || 'PUBLISH_FAILED', lastMessage: String(err.message || '').slice(0, 300), nextAttemptAt: at + backoffMs(failures) };
  privateFs.replaceAtomic(store.runPaths(base, candidateSha).publish, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Record a failed publish and report it, without ever throwing. Every path
 * that publishes goes through here, so a publish that fails, or one whose
 * publisher could not even be built, is recorded with its backoff and
 * reported the same way. A status file that cannot be written is reported
 * too, never thrown: publishing must not stop or crash certification
 * (ADR 0021 point 4).
 * @param {string} base - Evidence base
 * @param {string} candidateSha - Candidate SHA
 * @param {*} err - The failure
 * @param {function(object): void} log - Structured event sink
 * @param {number} [at] - Epoch ms
 * @returns {{published: false, code: string}} The outcome to hand back
 */
function reportFailure(base, candidateSha, err, log, at = Date.now()) {
  const e = err instanceof Error ? err : new Error(String(err));
  const code = e.code || 'PUBLISH_FAILED';
  let nextAttemptAt = null;
  try {
    nextAttemptAt = recordFailureFor(base, candidateSha, e, at).nextAttemptAt;
  } catch (writeErr) { // prawduct:allow prawduct/broad-except -- a status write that fails must be reported, never thrown out of a never-throws path
    log({ event: 'publish-status-unwritable', code: (writeErr && writeErr.code) || null });
  }
  log({
    event: 'publish-failed', code, message: String(e.message || '').slice(0, 300), nextAttemptAt,
    stderr: (e.details && e.details.stderr) || null, violations: (e.details && e.details.violations) || null
  });
  return { published: false, code };
}

/**
 * Refuse a publish whose commit the branch verifier would reject: better a
 * failed publish, retried later, than a violation on a branch whose history
 * can never be rewritten.
 * @param {function(string): (string|null)} read - Remote file reader
 * @param {Object<string, string>} files - Files about to be written
 * @returns {void}
 */
function _preflight(read, files) {
  const changed = Object.keys(files).filter((p) => files[p] !== read(p));
  const violations = verify.verifyChange({ changed, deleted: [], prev: read, next: (p) => (p in files ? files[p] : read(p)) });
  if (violations.length > 0) _refuse(REFUSAL.WOULD_VIOLATE, 'this publish would break the metrics branch rules', { violations });
}

/**
 * Create the publication policy for one candidate.
 * @param {object} ctx
 * @param {string} ctx.base - Evidence base
 * @param {string} ctx.candidateSha - Candidate SHA
 * @param {{publish: Function, read: Function}} ctx.publisher - From `createPublisher`
 * @param {function(): number} [ctx.now] - Clock
 * @returns {object} `{admit, update, due, recordFailure, readStatus}`
 */
function createPublication(ctx) {
  const now = ctx.now || (() => Date.now());
  const docPaths = sc.paths(ctx.candidateSha);
  const sha7 = ctx.candidateSha.slice(0, 7);
  const runPaths = store.runPaths(ctx.base, ctx.candidateSha);

  /**
   * Read `publish.json`, or a fresh status when none exists.
   * @returns {object} Status
   */
  function _status() {
    return readStatus(ctx.base, ctx.candidateSha);
  }

  /**
   * The digest of the admission this candidate already has on the metrics
   * branch, or null when it has none. `start` stages by this.
   * @returns {Promise<string|null>} Published manifest digest
   */
  async function publishedDigest() {
    const text = await ctx.publisher.read(docPaths.admission);
    if (text === null) return null;
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    if (!doc || sc.validateAdmission(doc).length > 0) _refuse(REFUSAL.EVIDENCE_CORRUPT, 'the published admission does not validate', { document: 'admission' });
    return doc.manifestDigest;
  }

  /**
   * Merge fields into `publish.json`.
   * @param {object} fields - Fields to set
   * @returns {object} The new status
   */
  function writeStatus(fields) {
    const next = { ..._status(), ...fields };
    privateFs.replaceAtomic(runPaths.publish, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /**
   * Publish the admission record and prove it landed. Called before the run
   * commits: when this throws, no run begins.
   * @param {object} manifest - The staged manifest
   * @param {string} digest - Its digest
   * @returns {Promise<{verifiedAt: number}>} When the read-back matched
   */
  async function admit(manifest, digest) {
    const record = sc.admissionRecord(manifest, digest);
    const problems = sc.validateAdmission(record);
    if (problems.length > 0) _refuse(REFUSAL.INVALID_MANIFEST, 'the admission record does not validate', { problems });
    const expected = sc.serialize(record);
    await ctx.publisher.publish((read) => {
      const current = read(docPaths.admission);
      if (current === expected) return {};
      if (current !== null) _refuse(REFUSAL.ADMISSION_CONFLICT, 'a different admission for this candidate is already published', { path: docPaths.admission });
      const files = { [docPaths.admission]: expected };
      _preflight(read, files);
      return files;
    }, `admission: ${sha7} ${manifest.version}`);
    const back = await ctx.publisher.read(docPaths.admission);
    if (back !== expected) _refuse(REFUSAL.ADMISSION_UNPUBLISHED, 'the admission record could not be read back from the metrics branch', { path: docPaths.admission });
    const verifiedAt = now();
    writeStatus({ admission: { digest, verifiedAt }, failures: 0, lastError: null, lastMessage: null, nextAttemptAt: null });
    return { verifiedAt };
  }

  /**
   * The files an update writes, computed against the remote's current tip.
   * @param {function(string): (string|null)} read - Remote file reader
   * @param {object} run - `{state, manifest, events}`
   * @param {object} status - `publish.json`
   * @param {number} at - Publish time
   * @returns {{files: Object<string, string>, seq: number}} Files and the sequence used
   */
  function _updateFiles(read, run, status, at) {
    if (read(docPaths.admission) === null) _refuse(REFUSAL.ADMISSION_UNPUBLISHED, 'the admission is not on the metrics branch', { path: docPaths.admission });
    const prevText = read(docPaths.scorecard);
    const prevSeq = prevText === null ? 0 : (JSON.parse(prevText).publishSeq || 0);
    const seq = Math.max(prevSeq, status.lastPublishedSeq || 0) + 1;
    const card = sc.scorecard(run.state, run.manifest, at, seq);
    const problems = sc.validateScorecard(card);
    if (problems.length > 0) _refuse(REFUSAL.INVALID_SAMPLE, 'the scorecard does not validate', { problems });
    const files = { [docPaths.scorecard]: sc.serialize(card) };
    const ours = run.events.map((e) => JSON.stringify(sc.eventLine(e)));
    const theirs = (read(docPaths.events) || '').split('\n').filter(Boolean);
    if (theirs.length > ours.length || theirs.some((line, i) => line !== ours[i])) {
      _refuse(REFUSAL.EVENTS_DIVERGED, 'the published transition log is not a prefix of this run\'s', { path: docPaths.events });
    }
    if (ours.length > theirs.length) files[docPaths.events] = `${ours.join('\n')}\n`;
    const indexText = read(sc.INDEX_PATH);
    const others = indexText === null ? [] : JSON.parse(indexText).candidates.filter((c) => c.candidateSha !== ctx.candidateSha);
    files[sc.INDEX_PATH] = sc.serialize(sc.indexDoc([...others, card]));
    _preflight(read, files);
    return { files, seq };
  }

  /**
   * Publish a run's standing. The publisher's clone lock keeps a manual
   * publish and the runner's from interleaving.
   * @param {object} run - `{state, manifest, events}`
   * @returns {Promise<{seq: number, changed: boolean}>} What was published
   */
  async function update(run) {
    const status = _status();
    const at = now();
    let seq = null;
    const result = await ctx.publisher.publish((read) => {
      const out = _updateFiles(read, run, status, at);
      seq = out.seq;
      return out.files;
    }, `scorecard: ${sha7} ${run.state.state}`);
    writeStatus({ lastPublishedSeq: seq, lastPublishedAt: at, failures: 0, lastError: null, lastMessage: null, nextAttemptAt: null });
    return { seq, changed: result.changed };
  }

  /**
   * Publish the committed run as it stands now. Never throws: a failure is
   * recorded with its backoff and reported, because publishing must never
   * stop or crash certification.
   * @param {function(object): void} [log] - Structured event sink
   * @returns {Promise<{published: boolean, seq?: number, code?: string}>} Outcome
   */
  async function publishCurrent(log = () => {}) {
    try {
      const { manifest, state, transitions } = store.readRunWithTransitions(ctx.base, ctx.candidateSha);
      const { seq, changed } = await update({ state, manifest, events: transitions });
      log({ event: 'published', seq, changed, state: state.state });
      return { published: true, seq };
    } catch (err) { // prawduct:allow prawduct/broad-except -- publishing boundary: every failure is recorded and reported, never thrown (ADR 0021 point 4)
      return reportFailure(ctx.base, ctx.candidateSha, err, log, now());
    }
  }

  /**
   * Record a failed publish and schedule the next attempt.
   * @param {Error} err - The failure
   * @returns {object} The new status
   */
  function recordFailure(err) {
    return recordFailureFor(ctx.base, ctx.candidateSha, err, now());
  }

  /**
   * Whether an update is due: at a terminal state or when nothing has been
   * published; otherwise after a transition or once the heartbeat has passed,
   * but no sooner than a minute after the last publish, and never inside a
   * failure backoff.
   * @param {{transitioned: boolean, state: string}} hint - What just happened
   * @returns {boolean} True when the runner should publish now
   */
  function due(hint) {
    const status = _status();
    const t = now();
    if (status.nextAttemptAt !== null && t < status.nextAttemptAt) return false;
    if (isTerminal(hint.state) || status.lastPublishedAt === null) return true;
    if (t - status.lastPublishedAt < MIN_INTERVAL_MS) return false;
    return hint.transitioned || t - status.lastPublishedAt >= HEARTBEAT_MS;
  }

  return { admit, update, publishCurrent, publishedDigest, due, recordFailure, readStatus: _status };
}

/**
 * A publication whose publisher is built on first use. Building one needs
 * the operator's git identity and the worktree's origin, which a runner under
 * launchd or cron may not have; a failure to build is recorded and backed off
 * like any other publishing failure, so it never stops sampling (ADR 0021
 * point 4). This is the only way a committed run should be published, and
 * whatever host runs one gets that guarantee from here rather than
 * re-implementing it.
 * @param {object} ctx
 * @param {string} ctx.base - Evidence base
 * @param {string} ctx.candidateSha - Candidate SHA
 * @param {function(): Promise<object>} ctx.build - Resolves to a publication from `createPublication`
 * @param {function(): number} [ctx.now] - Clock
 * @returns {object} `{publishCurrent, due, recordFailure, readStatus}`
 */
function createDeferredPublication(ctx) {
  const now = ctx.now || (() => Date.now());
  const statusOnly = createPublication({ base: ctx.base, candidateSha: ctx.candidateSha, publisher: null, now });
  let built = null;

  /**
   * Publish the committed run now, building the publisher first if needed.
   * Never throws.
   * @param {function(object): void} [log] - Structured event sink
   * @returns {Promise<{published: boolean, seq?: number, code?: string}>} Outcome
   */
  async function publishCurrent(log = () => {}) {
    if (!built) {
      try {
        built = await ctx.build();
      } catch (err) { // prawduct:allow prawduct/broad-except -- building reads git config and origin; every failure is recorded and reported like a failed publish
        return reportFailure(ctx.base, ctx.candidateSha, err, log, now());
      }
    }
    return built.publishCurrent(log);
  }

  return { publishCurrent, due: statusOnly.due, recordFailure: statusOnly.recordFailure, readStatus: statusOnly.readStatus };
}

module.exports = { HEARTBEAT_MS, MIN_INTERVAL_MS, backoffMs, readStatus, recordFailureFor, reportFailure, createPublication, createDeferredPublication };
