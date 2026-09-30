'use strict';

/**
 * The host relay for a guest's certification (#2020, Architect rulings Q2,
 * A31 constraint 4 and A32).
 *
 * A host-attested run publishes only to a local bare `metrics` repository
 * inside its guest, which has no credentials and no route to GitHub. This is
 * the one place that publishes what it produced, and the only place a
 * host-attested pass becomes a certification of record:
 *
 * 1. The host's own finalization of that exact run must exist and be `ok`,
 *    for the same manifest digest the guest's admission publishes.
 * 2. The guest's whole `metrics` history must pass the branch verifier.
 * 3. The guest's tip is pushed to the public remote as that exact commit,
 *    fast-forward only and never forced, so history already public can never
 *    be rewritten.
 * 4. The remote is read back: it must name exactly that commit, and the
 *    candidate's admission and scorecard must be byte-for-byte the guest's.
 * 5. Only then is the host's record written, and it says a run is certified
 *    only for a `passed` scorecard judged by canonical thresholds.
 *
 * Every step fails closed with a refusal and writes nothing. Only this host
 * process ever names the public remote, so no credential crosses into the
 * guest.
 *
 * @module lib/release-certification/host-publish
 */

const path = require('node:path');
const crypto = require('node:crypto');
const privateFs = require('./private-fs');
const lockfile = require('./lockfile');
const publisherLib = require('./publisher');
const verify = require('./verify');
const sc = require('./scorecard');
const hostChecks = require('./host-checks');
const { REFUSAL, STATES, CertificationError } = require('./codes');

const RECORD_SCHEMA = 'tc.release-certification.record/v1';
const BRANCH = publisherLib.DEFAULT_BRANCH;

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
 * Whether a relayed run is a certification of record: a `passed` scorecard,
 * judged by canonical thresholds, of a run whose host finalization is `ok`.
 * @param {object} scorecard - The published scorecard
 * @param {object|null} finalization - The host's finalization of the run
 * @returns {boolean} True only when all three hold
 */
function certifiedFrom(scorecard, finalization) {
  return Boolean(scorecard && scorecard.state === STATES.PASSED && scorecard.canonicalThresholds === true && finalization && finalization.ok === true);
}

/**
 * The host's record of one relay: one run, one exact commit. Written once and
 * never overwritten (A54), so a record can only ever describe the commit it
 * names.
 * @param {string} hostBase - Host state directory
 * @param {string} candidateSha - Candidate SHA
 * @param {string} runId - The run
 * @param {string} oid - The relayed commit
 * @returns {string} Path
 */
function recordPath(hostBase, candidateSha, runId, oid) {
  return hostChecks.hostPaths(hostBase, candidateSha).record(runId, oid);
}

/**
 * The sha256 of some bytes.
 * @param {string} text - Content
 * @returns {string} Hex digest
 */
function _sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** The record's fields, in the order its own digest covers them. */
const RECORD_FIELDS = Object.freeze(['schema', 'candidateSha', 'runId', 'manifestDigest', 'checksSource', 'oid', 'treeOid', 'admissionSha256', 'scorecardSha256',
  'finalizationSha256', 'bootId', 'sampleSetDigest', 'state', 'canonicalThresholds', 'certified', 'verifiedAt']);

/**
 * The digest a record is known by, over every field it binds.
 * @param {object} record - Record
 * @returns {string} Hex sha256
 */
function recordDigest(record) {
  return _sha(JSON.stringify(RECORD_FIELDS.map((f) => (record[f] === undefined ? null : record[f]))));
}

/**
 * Relay a guest's `metrics` branch to the public remote and, when every check
 * holds, record the result.
 * @param {object} opts
 * @param {string} opts.hostBase - Host state directory
 * @param {string} opts.candidateSha - Candidate SHA
 * @param {string} opts.guestMetrics - The guest's bare `metrics` repository, as the transport brought it to the host
 * @param {string} opts.remoteUrl - The public remote (the host's own credentials)
 * @param {function} [opts.git] - `publisher.runGit` seam
 * @param {function(object): Promise<object>} [opts.verifyHistory] - `verify.verifyHistory` seam
 * @param {function(): number} [opts.now] - Clock
 * @returns {Promise<object>} The record written
 * @throws {CertificationError} `LOCK_HELD` when another relay to the same remote is running, or the run is being finalized
 */
async function relay(opts) {
  const git = opts.git || publisherLib.runGit;
  const now = opts.now || (() => Date.now());
  const docs = sc.paths(opts.candidateSha);
  const must = async (args, step, code = REFUSAL.PUBLISH_FAILED) => {
    const r = await git(args, { env: { GIT_TERMINAL_PROMPT: '0' } });
    if (r.code !== 0) _refuse(code, `git ${step} failed`, { step, stderr: r.stderr.trim().slice(-300) });
    return r.stdout;
  };
  const show = async (gitDir, rev, rel) => {
    const r = await git(['--git-dir', gitDir, 'show', `${rev}:${rel}`], { env: {} });
    return r.code === 0 ? r.stdout : null;
  };
  const parse = (text) => {
    try {
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };

  // One private relay repository per public remote, held under a lock for
  // the whole relay, so two relays can never move each other's refs.
  const remoteKey = crypto.createHash('sha256').update(opts.remoteUrl).digest('hex').slice(0, 32);
  const relayRoot = path.join(opts.hostBase, '_relay');
  privateFs.ensurePrivateDir(relayRoot);
  const relayDir = path.join(relayRoot, `${remoteKey}.git`);
  const lockPath = path.join(relayRoot, `${remoteKey}.lock`);
  const token = lockfile.acquire(lockPath, { timeoutMs: 0 });
  let runLockPath = null;
  let runToken = null;
  try {
    privateFs.ensurePrivateDir(relayDir);
    if ((await git(['--git-dir', relayDir, 'rev-parse', '--git-dir'], { env: {} })).code !== 0) await must(['init', '-q', '--bare', relayDir], 'init');

    // The guest is the untrusted side and can move its branch at any moment,
    // so it is read exactly once: fetched into the relay and pinned by OID.
    // Every check below, the push and the comparison use that one commit.
    const guestRef = `refs/guest/${opts.candidateSha}`;
    await must(['--git-dir', relayDir, 'fetch', '-q', '--no-tags', opts.guestMetrics, `+refs/heads/${BRANCH}:${guestRef}`], 'fetch guest', REFUSAL.PUBLICATION_MISMATCH);
    const oid = (await must(['--git-dir', relayDir, 'rev-parse', '--verify', `${guestRef}^{commit}`], 'rev-parse', REFUSAL.PUBLICATION_MISMATCH)).trim();
    if (!/^[0-9a-f]{40}$/.test(oid)) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'the guest\'s metrics tip cannot be read');

    const admission = parse(await show(relayDir, oid, docs.admission));
    if (!admission || sc.validateAdmission(admission).length > 0) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'the guest has published no valid admission for this candidate', { path: docs.admission });
    if (admission.checksSource !== 'host-attested') _refuse(REFUSAL.NOT_HOST_ATTESTED, 'only a host-attested run is relayed; a gh run publishes to its remote itself');
    const scorecard = parse(await show(relayDir, oid, docs.scorecard));
    if (!scorecard || sc.validateScorecard(scorecard).length > 0) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'the guest has published no valid scorecard for this candidate', { path: docs.scorecard });

    // 1. The host's own finalization of exactly this run and manifest, held
    // under the run's lock until the record is written, so no finalize can
    // land in between. Its bytes are read ONCE: the verdict, the check and the
    // digest the record binds all come from that one buffer.
    const hostPaths = hostChecks.hostPaths(opts.hostBase, opts.candidateSha);
    privateFs.ensurePrivateDir(hostPaths.dir);
    runLockPath = hostPaths.runLock(admission.runId);
    runToken = lockfile.acquire(runLockPath, { timeoutMs: 0 });
    const finalizationText = privateFs.readPrivate(hostPaths.finalization(admission.runId));
    const finalization = parse(finalizationText);
    if (!finalization || finalization.schema !== hostChecks.FINALIZATION_SCHEMA || finalization.candidateSha !== opts.candidateSha
      || finalization.runId !== admission.runId || finalization.ok !== true || finalization.manifestDigest !== admission.manifestDigest) {
      _refuse(REFUSAL.NOT_FINALIZED, 'the host has no ok finalization of this run and manifest', { runId: admission.runId, reasons: finalization ? finalization.reasons : null });
    }

    // 2. The pinned commit's whole history, by the rules the public branch is held to.
    const history = await (opts.verifyHistory || verify.verifyHistory)({ repoDir: relayDir, ref: oid });
    if (!history.exists || history.violations.length > 0) _refuse(REFUSAL.HISTORY_INVALID, 'the guest\'s metrics history does not verify', { violations: history.violations.slice(0, 10) });

    // 3. Fast-forward only, never forced.
    const remoteRef = 'refs/public/metrics';
    const fetchedRemote = await git(['--git-dir', relayDir, 'fetch', '-q', '--no-tags', opts.remoteUrl, `+refs/heads/${BRANCH}:${remoteRef}`], { env: { GIT_TERMINAL_PROMPT: '0' } });
    if (fetchedRemote.code !== 0) {
      // Only a remote with no metrics branch yet may be missing it; any other
      // failure to read it is not evidence that it is empty.
      const probe = await git(['ls-remote', '--exit-code', '--heads', opts.remoteUrl, BRANCH], { env: { GIT_TERMINAL_PROMPT: '0' } });
      if (probe.code !== 2) _refuse(REFUSAL.PUBLISH_FAILED, 'could not read the public metrics branch', { stderr: fetchedRemote.stderr.trim().slice(-300) });
    } else if ((await git(['--git-dir', relayDir, 'merge-base', '--is-ancestor', remoteRef, oid], { env: {} })).code !== 0) {
      _refuse(REFUSAL.NOT_FAST_FORWARD, 'the public metrics branch holds history the guest\'s does not; it is never overwritten');
    }
    await must(['--git-dir', relayDir, 'push', '-q', opts.remoteUrl, `${oid}:refs/heads/${BRANCH}`], 'push');

    // 4. Read it back from the remote itself, against the pinned commit.
    const listed = await must(['ls-remote', opts.remoteUrl, `refs/heads/${BRANCH}`], 'ls-remote', REFUSAL.PUBLICATION_MISMATCH);
    const remoteOid = (listed.split('\t')[0] || '').trim();
    if (remoteOid !== oid) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'the public metrics branch does not name the relayed commit', { expected: oid, found: remoteOid || null });
    await must(['--git-dir', relayDir, 'fetch', '-q', '--no-tags', opts.remoteUrl, `+refs/heads/${BRANCH}:${remoteRef}`], 'fetch back', REFUSAL.PUBLICATION_MISMATCH);
    for (const rel of [docs.admission, docs.scorecard]) {
      const theirs = await show(relayDir, remoteRef, rel);
      if (theirs === null || theirs !== await show(relayDir, oid, rel)) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'a document read back from the public branch differs from the relayed commit', { path: rel });
    }

    // 5. The record: certification of record exists only here. It binds the
    // exact read-back commit and the bytes of everything it vouches for, and
    // it is created once: a relay re-run after an interruption finds its own
    // identical record, and anything else under that name is a conflict.
    const record = {
      schema: RECORD_SCHEMA,
      candidateSha: opts.candidateSha,
      runId: admission.runId,
      manifestDigest: admission.manifestDigest,
      checksSource: admission.checksSource,
      oid,
      treeOid: (await must(['--git-dir', relayDir, 'rev-parse', `${oid}^{tree}`], 'rev-parse tree', REFUSAL.PUBLICATION_MISMATCH)).trim(),
      admissionSha256: _sha(await show(relayDir, remoteRef, docs.admission)),
      scorecardSha256: _sha(await show(relayDir, remoteRef, docs.scorecard)),
      finalizationSha256: _sha(finalizationText),
      bootId: finalization.bootId ?? null,
      sampleSetDigest: finalization.sampleSetDigest ?? null,
      state: scorecard.state,
      canonicalThresholds: scorecard.canonicalThresholds,
      certified: certifiedFrom(scorecard, finalization),
      verifiedAt: now()
    };
    record.recordDigest = recordDigest(record);
    const target = recordPath(opts.hostBase, opts.candidateSha, admission.runId, oid);
    if (!privateFs.createOnceAtomic(target, `${JSON.stringify(record, null, 2)}\n`)) {
      let existing = null;
      try {
        existing = JSON.parse(privateFs.readPrivate(target));
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
      const same = existing !== null && RECORD_FIELDS.filter((f) => f !== 'verifiedAt').every((f) => existing[f] === record[f]) && existing.recordDigest === recordDigest(existing);
      if (!same) _refuse(REFUSAL.RECORD_CONFLICT, 'a different record already exists for this run and commit', { path: target });
      return existing;
    }
    return record;
  } finally {
    if (runToken !== null) lockfile.release(runLockPath, runToken);
    lockfile.release(lockPath, token);
  }
}

/**
 * Re-derive a record from the public remote and the host's own finalization,
 * so a reader (C04 promotion) trusts nothing the record merely says. Its own
 * digest proves only that it was not edited without recomputing it, which
 * anyone can do, so every field is re-derived: the commit, its tree and the
 * document digests from the public branch; the run, manifest, boot identity
 * and sample set from the host's finalization; and the verdict itself
 * (`state`, `canonicalThresholds`, `certified`) from the published scorecard
 * and that finalization. A forged record, one replayed from another commit or
 * run, or malformed input fails; nothing here throws on bad content.
 * @param {object} record - A record, e.g. read from disk
 * @param {object} opts - `{hostBase, remoteUrl, git?}`
 * @returns {Promise<{ok: boolean, reasons: string[]}>} Outcome
 */
async function verifyRecord(record, opts) {
  const git = opts.git || publisherLib.runGit;
  const reasons = [];
  const parse = (text) => {
    try {
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };
  if (!record || typeof record !== 'object' || record.schema !== RECORD_SCHEMA || record.recordDigest !== recordDigest(record)
    || !/^[0-9a-f]{40}$/.test(record.candidateSha || '') || !/^[0-9a-f]{32}$/.test(record.runId || '') || !/^[0-9a-f]{40}$/.test(record.oid || '')) {
    return { ok: false, reasons: ['RECORD_DIGEST'] };
  }
  const docs = sc.paths(record.candidateSha);
  let finalizationText = null;
  try {
    finalizationText = privateFs.readPrivate(hostChecks.hostPaths(opts.hostBase, record.candidateSha).finalization(record.runId));
  } catch (err) {
    if (!(err instanceof CertificationError)) throw err;
  }
  const finalization = parse(finalizationText);
  if (!finalization || _sha(finalizationText) !== record.finalizationSha256 || finalization.ok !== true
    || finalization.runId !== record.runId || finalization.manifestDigest !== record.manifestDigest
    || (finalization.bootId ?? null) !== record.bootId || (finalization.sampleSetDigest ?? null) !== record.sampleSetDigest) reasons.push('FINALIZATION');
  const scratch = path.join(opts.hostBase, '_verify', `${crypto.randomBytes(6).toString('hex')}.git`);
  privateFs.ensurePrivateDir(path.dirname(scratch));
  try {
    const run = (args) => git(args, { env: { GIT_TERMINAL_PROMPT: '0' } });
    await run(['init', '-q', '--bare', scratch]);
    const fetched = await run(['--git-dir', scratch, 'fetch', '-q', '--no-tags', opts.remoteUrl, `+refs/heads/${BRANCH}:refs/public`]);
    if (fetched.code !== 0) return { ok: false, reasons: [...reasons, 'REMOTE_UNREADABLE'] };
    // The recorded commit must be on the public branch's history.
    if ((await run(['--git-dir', scratch, 'merge-base', '--is-ancestor', record.oid, 'refs/public'])).code !== 0) reasons.push('OID_NOT_PUBLIC');
    else {
      const tree = await run(['--git-dir', scratch, 'rev-parse', `${record.oid}^{tree}`]);
      if (tree.stdout.trim() !== record.treeOid) reasons.push('TREE');
      const show = async (rel) => {
        const r = await run(['--git-dir', scratch, 'show', `${record.oid}:${rel}`]);
        return r.code === 0 ? r.stdout : null;
      };
      const admission = await show(docs.admission);
      const scorecard = await show(docs.scorecard);
      if (admission === null || _sha(admission) !== record.admissionSha256) reasons.push('ADMISSION');
      if (scorecard === null || _sha(scorecard) !== record.scorecardSha256) reasons.push('SCORECARD');
      const a = parse(admission);
      if (!a || a.runId !== record.runId || a.manifestDigest !== record.manifestDigest || a.checksSource !== record.checksSource) reasons.push('RUN_BINDING');
      // The verdict is re-derived, never read from the record.
      const card = parse(scorecard);
      if (!card || card.state !== record.state || card.canonicalThresholds !== record.canonicalThresholds
        || certifiedFrom(card, finalization) !== record.certified) reasons.push('VERDICT');
    }
  } finally {
    require('node:fs').rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: reasons.length === 0, reasons };
}

module.exports = { RECORD_SCHEMA, RECORD_FIELDS, certifiedFrom, recordPath, recordDigest, relay, verifyRecord };
