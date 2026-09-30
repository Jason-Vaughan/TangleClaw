'use strict';

/**
 * The evidence store for release-candidate certification.
 *
 * One run per candidate SHA, in a private directory:
 *
 *   <base>/<candidateSha>/
 *     manifest.json   written once; what is being certified and how
 *     state.json      the run's current state; the commit point
 *     samples.ndjson  every sample, append-only
 *     transitions.ndjson  every state transition, append-only, numbered
 *     snapshots/      one file per state transition, in order
 *     lock            held around every read-modify-write
 *     runner.lock     held by the one runner sampling this candidate
 *     publish.json    what has been published to the metrics branch (never certification state)
 *
 * `state.json` is the commit point. A sample record is appended before it is
 * written, so a committed state can always be traced to the sample that
 * produced it; a record numbered past the committed `sampleCount` is from a
 * write that never committed, and readers ignore it. A snapshot is written
 * after it, so a crash can lose a snapshot but never leave one describing a
 * transition that did not happen.
 *
 * The manifest's sha256 is kept in `state.json` and in every snapshot, and a
 * manifest whose bytes no longer match is refused on every read. That catches
 * a manifest edited out of band, by accident or by a tool, while a run is live.
 * It is not protection against the owning user, who can rewrite the digest
 * too: a digest recorded somewhere this user cannot rewrite is what makes it
 * binding. The candidate itself cannot be re-pointed, because the directory
 * name, the manifest and the state must all name the same SHA.
 *
 * Recovery never happens silently. Reclaiming a dead process's lock, cutting a
 * torn sample line and replacing a manifest left by a crashed start are each
 * reported through `opts.onRecover` as `{kind, ...facts}`, for the caller to log.
 *
 * @module lib/release-certification/store
 */

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const tangleclawHome = require('../tangleclaw-home');
const privateFs = require('./private-fs');
const lockfile = require('./lockfile');
const { SCHEMA, REFUSAL, CertificationError } = require('./codes');

const { SHA_RE } = require('./formats');

/**
 * Throw a store refusal.
 * @param {string} code - A REFUSAL code
 * @param {string} message - Why
 * @param {object} [details] - Bounded facts
 * @returns {never}
 */
function _refuse(code, message, details) {
  throw new CertificationError(code, message, details);
}

/**
 * The default evidence base: `<tangleclawHome>/release-certification/v1`.
 * @returns {string} Absolute path
 */
function defaultBase() {
  return path.join(tangleclawHome.baseDir(), 'release-certification', 'v1');
}

/**
 * The paths of one run.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {{dir: string, manifest: string, state: string, samples: string, transitions: string, snapshots: string, lock: string, runnerLock: string, publish: string}} Paths
 */
function runPaths(base, candidateSha) {
  if (typeof candidateSha !== 'string' || !SHA_RE.test(candidateSha)) {
    _refuse(REFUSAL.INVALID_MANIFEST, 'candidateSha must be 40 lowercase hex characters', { field: 'candidateSha' });
  }
  if (typeof base !== 'string' || !path.isAbsolute(base)) _refuse(REFUSAL.STORE_UNSAFE, 'the evidence base must be absolute');
  const dir = path.join(base, candidateSha);
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    state: path.join(dir, 'state.json'),
    samples: path.join(dir, 'samples.ndjson'),
    transitions: path.join(dir, 'transitions.ndjson'),
    snapshots: path.join(dir, 'snapshots'),
    lock: path.join(dir, 'lock'),
    runnerLock: path.join(dir, 'runner.lock'),
    publish: path.join(dir, 'publish.json')
  };
}

/**
 * Make the base and run directories, each private.
 * @param {string} base - Evidence base
 * @param {object} paths - From `runPaths`
 * @returns {void}
 */
function _ensureDirs(base, paths) {
  privateFs.ensurePrivateDir(base);
  privateFs.ensurePrivateDir(paths.dir);
  privateFs.ensurePrivateDir(paths.snapshots);
}

/**
 * sha256 of a manifest's exact bytes.
 * @param {string} text - Manifest file contents
 * @returns {string} Hex digest
 */
function _digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Parse an evidence document, refusing damage.
 * @param {string} text - File contents
 * @param {string} what - Which document, for the message
 * @returns {object} Parsed document
 */
function _parse(text, what) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    _refuse(REFUSAL.EVIDENCE_CORRUPT, `${what} is not valid JSON`, { document: what });
  }
  if (!doc || doc.schema !== SCHEMA) _refuse(REFUSAL.EVIDENCE_CORRUPT, `${what} has an unknown schema`, { document: what });
  return doc;
}

/**
 * The sample record appended to `samples.ndjson`: the sample exactly as
 * observed, plus what the state machine made of it.
 * @param {number} seq - Sample sequence number
 * @param {object} sample - The sample
 * @param {object|null} verdict - `classify` result
 * @param {object|null} interval - `assessInterval` result (null at admission)
 * @returns {object} Record
 */
function sampleRecord(seq, sample, verdict, interval) {
  return { schema: SCHEMA, seq, ...sample, verdict, interval };
}

/**
 * Write snapshots for transition events, after the state that contains them
 * committed. Names lead with a running index, under the lock, so listing
 * order is transition order even when an operator's event shares a sample
 * number with the transition before it.
 * @param {object} paths - Run paths
 * @param {object} state - Committed state
 * @param {object[]} events - Transition events
 * @returns {void}
 */
function _writeSnapshots(paths, state, events) {
  let index = fs.readdirSync(paths.snapshots).filter((n) => n.endsWith('.json')).length;
  for (const event of events) {
    index += 1;
    const seq = String(event.sampleSeq ?? state.sampleCount).padStart(8, '0');
    const file = path.join(paths.snapshots, `${String(index).padStart(6, '0')}-${seq}-${event.code}-${event.to}.json`);
    const doc = { schema: SCHEMA, manifestDigest: state.manifestDigest, event, state };
    privateFs.replaceAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

/**
 * Report a recovery to the caller, if it asked.
 * @param {object} opts - Store options
 * @param {object} fact - `{kind, ...}`
 * @returns {void}
 */
function _recovered(opts, fact) {
  if (typeof opts.onRecover === 'function') opts.onRecover(fact);
}

/**
 * Persist one committed change under a held lock: sample record, then state,
 * then snapshots.
 * @param {object} paths - Run paths
 * @param {string} token - Lock token
 * @param {{state: object, events: object[], record?: object}} change - What to persist
 * @param {object} opts - Store options
 * @returns {void}
 */
function _persist(paths, token, change, opts) {
  lockfile.assertHeld(paths.lock, token);
  if (change.record) {
    const { truncatedBytes } = privateFs.appendLine(paths.samples, JSON.stringify(change.record));
    if (truncatedBytes > 0) _recovered(opts, { kind: 'torn-sample-truncated', bytes: truncatedBytes });
  }
  // Transitions are appended before the state that counts them, like samples,
  // so the transition log and the state can never disagree after a crash: a
  // line numbered past the committed count is from a write that never committed.
  const before = change.state.transitionCount || 0;
  change.events.forEach((event, i) => {
    const { truncatedBytes } = privateFs.appendLine(paths.transitions, JSON.stringify({ n: before + i + 1, event }));
    if (truncatedBytes > 0) _recovered(opts, { kind: 'torn-transition-truncated', bytes: truncatedBytes });
  });
  change.state.transitionCount = before + change.events.length;
  lockfile.assertHeld(paths.lock, token);
  privateFs.replaceAtomic(paths.state, `${JSON.stringify(change.state, null, 2)}\n`);
  _writeSnapshots(paths, change.state, change.events);
}

/**
 * Run a function while holding a run's lock.
 * @param {object} paths - Run paths
 * @param {object} opts - `{lockTimeoutMs, lockDeps, onRecover}`
 * @param {function(string): *} fn - Receives the token
 * @returns {*} What `fn` returns
 */
function _withLock(paths, opts, fn) {
  const token = lockfile.acquire(paths.lock, {
    timeoutMs: opts.lockTimeoutMs,
    deps: opts.lockDeps,
    onReclaim: (holder) => _recovered(opts, { kind: 'lock-reclaimed', holder })
  });
  try {
    return fn(token);
  } finally {
    lockfile.release(paths.lock, token);
  }
}

/**
 * The exact bytes a manifest is stored as. Its digest is computed over these
 * bytes, so every writer must use this one serialization.
 * @param {object} manifest - Manifest
 * @returns {string} JSON text with a trailing newline
 */
function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Stage a manifest before its run exists, so its admission can be published
 * and read back before anything commits.
 *
 * What the metrics branch already holds decides which manifest is staged:
 * - no published admission: the fresh manifest, replacing anything a failed
 *   start left behind, whose settings nobody ever made public;
 * - a published admission whose digest matches the staged manifest: that
 *   manifest, reused, because the write-once record accepts only its bytes;
 * - a published admission matching nothing staged: refused. This candidate
 *   was admitted elsewhere, or its staged manifest was lost, and a public
 *   record cannot be replaced.
 *
 * @param {string} base - Evidence base
 * @param {object} manifest - A freshly built manifest
 * @param {string|null} publishedDigest - Digest of the admission on the metrics branch, or null
 * @param {object} [opts] - `{lockTimeoutMs, lockDeps, onRecover}`
 * @returns {{manifest: object, digest: string, reused: boolean}} The staged manifest
 */
function stageManifest(base, manifest, publishedDigest, opts = {}) {
  const paths = runPaths(base, manifest.candidateSha);
  _ensureDirs(base, paths);
  return _withLock(paths, opts, () => {
    if (privateFs.readPrivate(paths.state) !== null) _refuse(REFUSAL.RUN_EXISTS, 'a run already exists for this candidate');
    const staged = privateFs.readPrivate(paths.manifest);
    if (publishedDigest !== null) {
      if (staged === null || _digest(staged) !== publishedDigest) {
        _refuse(REFUSAL.ADMISSION_CONFLICT, 'this candidate\'s admission is already public and no staged manifest matches it', { publishedDigest });
      }
      _recovered(opts, { kind: 'staged-manifest-reused' });
      return { manifest: _parse(staged, 'manifest'), digest: publishedDigest, reused: true };
    }
    if (staged !== null) _recovered(opts, { kind: 'unpublished-staged-manifest-replaced' });
    const text = manifestText(manifest);
    privateFs.replaceAtomic(paths.manifest, text);
    return { manifest, digest: _digest(text), reused: false };
  });
}

/**
 * A run and its committed transitions from one read of its state, so the two
 * always agree: the transitions are the ones that state counts.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {{manifest: object, state: object, transitions: object[]}} The run
 */
function readRunWithTransitions(base, candidateSha) {
  const { paths, manifest, state } = readRun(base, candidateSha);
  return { manifest, state, transitions: _transitionsCounted(paths, state) };
}

/**
 * The transition lines a state counts, oldest first.
 * @param {object} paths - Run paths
 * @param {object} state - Committed state
 * @returns {object[]} Transition events
 */
function _transitionsCounted(paths, state) {
  const count = state.transitionCount || 0;
  const byN = new Map();
  for (const line of privateFs.readLines(paths.transitions).records) {
    if (Number.isSafeInteger(line.n) && line.n >= 1 && line.n <= count) byN.set(line.n, line.event);
  }
  return [...byN.keys()].sort((x, y) => x - y).map((n) => byN.get(n));
}

/**
 * The committed transitions of a run, oldest first. A line numbered past the
 * committed count is from a write that never committed and is left out.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {object[]} Transition events
 */
function readTransitions(base, candidateSha) {
  return readRunWithTransitions(base, candidateSha).transitions;
}

/**
 * Create a run from an admitted candidate. A run exists once its state is
 * committed. A manifest staged for it with identical bytes is kept as it is;
 * a different one left by a crash during an earlier attempt is replaced. Once
 * a state exists the run is refused, and its manifest is never rewritten.
 * @param {string} base - Evidence base
 * @param {object} manifest - From `buildManifest`
 * @param {{state: object, events: object[]}} admission - From `admit`
 * @param {object} sample - The admission sample
 * @param {object} [opts] - `{lockTimeoutMs, lockDeps, onRecover}`
 * @returns {object} The committed state
 */
function createRun(base, manifest, admission, sample, opts = {}) {
  const paths = runPaths(base, manifest.candidateSha);
  _ensureDirs(base, paths);
  return _withLock(paths, opts, (token) => {
    if (privateFs.readPrivate(paths.state) !== null) _refuse(REFUSAL.RUN_EXISTS, 'a run already exists for this candidate');
    const text = manifestText(manifest);
    if (!privateFs.writeOnce(paths.manifest, text) && privateFs.readPrivate(paths.manifest) !== text) {
      privateFs.replaceAtomic(paths.manifest, text);
      _recovered(opts, { kind: 'orphan-manifest-replaced' });
    }
    const state = { ...admission.state, manifestDigest: _digest(text) };
    _persist(paths, token, { state, events: admission.events, record: sampleRecord(1, sample, null, null) }, opts);
    return state;
  });
}

/**
 * Read a run, verifying its manifest has not changed since the run began.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {{paths: object, manifest: object, state: object}} The run
 */
function readRun(base, candidateSha) {
  const paths = runPaths(base, candidateSha);
  const manifestText = privateFs.readPrivate(paths.manifest);
  const stateText = privateFs.readPrivate(paths.state);
  if (manifestText === null || stateText === null) _refuse(REFUSAL.RUN_NOT_FOUND, 'no run exists for this candidate');
  const state = _parse(stateText, 'state');
  if (_digest(manifestText) !== state.manifestDigest) _refuse(REFUSAL.MANIFEST_TAMPERED, 'the manifest changed after the run began');
  const manifest = _parse(manifestText, 'manifest');
  if (manifest.candidateSha !== candidateSha || state.candidateSha !== candidateSha) {
    _refuse(REFUSAL.EVIDENCE_CORRUPT, 'the evidence names a different candidate', { document: 'manifest' });
  }
  return { paths, manifest, state };
}

/**
 * Apply a change to a run under its lock: read the current state, let `fn`
 * decide, persist what it returns. `fn` sees the state as committed, so a
 * runner tick and an operator's accept never overwrite each other.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @param {function(object, object): ({state: object, events: object[], record?: object}|null)} fn - `(state, manifest)`; null changes nothing
 * @param {object} [opts] - `{lockTimeoutMs, lockDeps, onRecover}`
 * @returns {object} The state after the change
 */
function updateRun(base, candidateSha, fn, opts = {}) {
  const { paths } = readRun(base, candidateSha);
  _ensureDirs(base, paths);
  return _withLock(paths, opts, (token) => {
    const { manifest, state } = readRun(base, candidateSha);
    const change = fn(state, manifest);
    if (!change) return state;
    _persist(paths, token, change, opts);
    return change.state;
  });
}

/**
 * The committed sample records of a run, oldest first. Records past the
 * committed count, and all but the last record for a sequence number, come
 * from writes that did not commit and are left out.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {object[]} Sample records
 */
function readSamples(base, candidateSha) {
  const { paths, state } = readRun(base, candidateSha);
  const bySeq = new Map();
  for (const record of privateFs.readLines(paths.samples).records) {
    if (Number.isSafeInteger(record.seq) && record.seq >= 1 && record.seq <= state.sampleCount) bySeq.set(record.seq, record);
  }
  return [...bySeq.keys()].sort((a, b) => a - b).map((seq) => bySeq.get(seq));
}

/**
 * The transition snapshots of a run, oldest first.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {object[]} Snapshot documents
 */
function readSnapshots(base, candidateSha) {
  const { paths } = readRun(base, candidateSha);
  let names;
  try {
    names = fs.readdirSync(paths.snapshots).filter((n) => n.endsWith('.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.map((n) => _parse(privateFs.readPrivate(path.join(paths.snapshots, n)), 'snapshot'));
}

/**
 * The candidate SHAs that have runs under a base. A directory with no
 * committed state (a start that crashed before committing) is not a run.
 * @param {string} base - Evidence base
 * @returns {string[]} SHAs, sorted
 */
function listRuns(base) {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((n) => SHA_RE.test(n) && fs.existsSync(path.join(base, n, 'state.json'))).sort();
}

module.exports = {
  defaultBase,
  runPaths,
  manifestText,
  manifestDigest: _digest,
  stageManifest,
  readTransitions,
  readRunWithTransitions,
  sampleRecord,
  createRun,
  readRun,
  updateRun,
  readSamples,
  readSnapshots,
  listRuns
};
