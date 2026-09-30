'use strict';

/**
 * Required checks judged by the host, for a runner that has no route to
 * GitHub (#2020, Architect rulings Q1, A31 and A32).
 *
 * The certifying soak runs in a guest with no egress and no credentials, yet
 * a certification still has to know, at admission and at every sample, that
 * the candidate's required checks are green. So the host reads GitHub and the
 * guest asks it: for each sample the guest writes a request into an exchange
 * directory, and the host answers with a verdict bound to that exact sample.
 *
 * - **Every verdict is bound** to the candidate SHA, the run id the host
 *   minted, the sample's sequence number and the manifest digest, and carries
 *   a digest of its own content. The guest accepts a verdict only when every
 *   binding matches the sample it is taking; anything else (missing, late,
 *   unparsable, mismatched, stale) reads as GitHub unavailable, which earns no
 *   time. Nothing here decides a pass; it only stops a sample vouching for
 *   checks nobody verified.
 * - **The host answers only for runs it minted.** `mintRun` records a run id
 *   together with the repository and checks it will judge; a request naming
 *   any other run id is never answered, so the guest's wait fails closed.
 * - **The host keeps its own record.** Every verdict it issues is appended to
 *   a host-private ledger. `finalize` joins the run's exported samples against
 *   that ledger: the admission sample and every sample that earned time must
 *   carry a verdict the host really issued, green for every required check,
 *   and the checks must still be green when read once more at the end.
 * - **The soak must have passed too.** A finalization is `ok` only with a
 *   soak judgement (`lib/soak/judge`) that passed and is bound to this exact
 *   run: its candidate SHA, run id and manifest digest. The judgement is
 *   recorded in the finalization, so the host's relay record, which binds
 *   the finalization's bytes, binds the soak evidence with it.
 *
 * The exchange directory is plain files, `requests/<seq>.json` and
 * `verdicts/<seq>.json`, so whatever transport carries files between host and
 * guest can mirror it. The host side takes GitHub's observer as a parameter
 * (`probes.observeGithub`), which keeps this module free of GitHub and of any
 * dependency on the probes that call it.
 *
 * @module lib/release-certification/host-checks
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const privateFs = require('./private-fs');
const lockfile = require('./lockfile');
const isolationLib = require('./isolation');
const { SHA_RE, DIGEST_RE, RUN_ID_RE, REPO_RE, isCount, validRequiredChecks } = require('./formats');
const { REFUSAL, CertificationError } = require('./codes');

const REQUEST_SCHEMA = 'tc.release-certification.checks-request/v1';
const VERDICT_SCHEMA = 'tc.release-certification.checks-verdict/v1';
const MINT_SCHEMA = 'tc.release-certification.checks-run/v1';
const FINALIZATION_SCHEMA = 'tc.release-certification.checks-finalization/v1';
/** The soak judge's schema (`lib/soak/judge`), named here so this module does not depend on the soak. */
const SOAK_JUDGEMENT_SCHEMA = 'tc.soak-judgement/v1';

/** How long a sample waits for its verdict by default: well inside the shortest sampling interval. */
const DEFAULT_WAIT_MS = 10 * 1000;
const POLL_MS = 250;

/** Why a sample's checks could not be vouched for. Recorded as the sample's GitHub diagnostic. */
const DIAGNOSTIC = Object.freeze({
  UNBOUND: 'host-verdict-unbound',
  MISSING: 'host-verdict-missing',
  INVALID: 'host-verdict-invalid',
  MISMATCH: 'host-verdict-mismatch',
  REQUEST_FAILED: 'host-request-failed',
  // A verdict bound to a sample number another commit took first.
  SEQ_MOVED: 'host-verdict-seq-moved'
});

/** Why a host finalization failed. Closed codes, each naming a sample where one applies. */
const FINALIZATION = Object.freeze({
  NOT_HOST_ATTESTED: 'NOT_HOST_ATTESTED',
  RUN_NOT_MINTED: 'RUN_NOT_MINTED',
  CHECKS_LIST_DRIFT: 'CHECKS_LIST_DRIFT',
  NOT_REVIEWABLE: 'NOT_REVIEWABLE',
  VERDICT_MISSING: 'VERDICT_MISSING',
  VERDICT_MISMATCH: 'VERDICT_MISMATCH',
  VERDICT_NOT_GREEN: 'VERDICT_NOT_GREEN',
  VERDICT_NOT_FRESH: 'VERDICT_NOT_FRESH',
  ISOLATION_MISSING: 'ISOLATION_MISSING',
  ISOLATION_MISMATCH: 'ISOLATION_MISMATCH',
  SAMPLES_INCOMPLETE: 'SAMPLES_INCOMPLETE',
  FINAL_CHECKS_UNAVAILABLE: 'FINAL_CHECKS_UNAVAILABLE',
  FINAL_CHECKS_NOT_GREEN: 'FINAL_CHECKS_NOT_GREEN',
  SOAK_JUDGEMENT_MISSING: 'SOAK_JUDGEMENT_MISSING',
  SOAK_JUDGEMENT_FAILED: 'SOAK_JUDGEMENT_FAILED',
  SOAK_JUDGEMENT_UNBOUND: 'SOAK_JUDGEMENT_UNBOUND'
});

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
 * The exchange directory's two halves.
 * @param {string} dir - Exchange directory
 * @returns {{requests: string, verdicts: string}} Paths
 */
function exchangePaths(dir) {
  return { requests: path.join(dir, 'requests'), verdicts: path.join(dir, 'verdicts') };
}

/**
 * The host's private files for one candidate.
 * @param {string} hostBase - Host state directory
 * @param {string} candidateSha - Candidate SHA
 * @returns {{dir: string, runs: string, ledger: string, rejected: string, finalization: function(string): string, recordPrefix: function(string): string, record: function(string, string): string, runLock: function(string): string}} Paths; a finalization, relay records and a lock are kept per run
 */
function hostPaths(hostBase, candidateSha) {
  if (typeof hostBase !== 'string' || !path.isAbsolute(hostBase)) _refuse(REFUSAL.STORE_UNSAFE, 'the host state directory must be absolute');
  if (typeof candidateSha !== 'string' || !SHA_RE.test(candidateSha)) _refuse(REFUSAL.INVALID_MANIFEST, 'candidateSha must be 40 lowercase hex characters', { field: 'candidateSha' });
  const dir = path.join(hostBase, candidateSha);
  const finalization = (runId) => {
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) _refuse(REFUSAL.INVALID_MANIFEST, 'a run id is 32 lowercase hex characters', { field: 'runId' });
    return path.join(dir, `finalization-${runId}.json`);
  };
  const runIdOk = (runId) => {
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) _refuse(REFUSAL.INVALID_MANIFEST, 'a run id is 32 lowercase hex characters', { field: 'runId' });
  };
  // The one place relay records are named: the relay writes them and a
  // finalization's seal looks for them, and both must agree.
  const recordPrefix = (runId) => { runIdOk(runId); return `record-${runId}-`; };
  const record = (runId, oid) => {
    if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) _refuse(REFUSAL.INVALID_MANIFEST, 'a record is named by a commit', { field: 'oid' });
    return path.join(dir, `${recordPrefix(runId)}${oid}.json`);
  };
  // Held by finalize and by the relay, so a run is never finalized while it
  // is being relayed.
  const runLock = (runId) => { runIdOk(runId); return path.join(dir, `run-${runId}.lock`); };
  return { dir, runs: path.join(dir, 'runs.ndjson'), ledger: path.join(dir, 'verdicts.ndjson'), rejected: path.join(dir, 'rejected'), finalization, recordPrefix, record, runLock };
}

/**
 * The digest a verdict is known by: sha256 over its fields in a fixed order,
 * excluding the digest itself.
 * @param {object} v - Verdict
 * @returns {string} Hex sha256
 */
function verdictDigest(v) {
  const canonical = JSON.stringify([
    v.schema, v.candidateSha, v.runId, v.manifestDigest, v.sampleSeq, v.requestedAt, v.observedAt,
    v.observation && v.observation.state,
    v.observation && v.observation.checks ? Object.keys(v.observation.checks).sort().map((k) => [k, v.observation.checks[k]]) : null,
    v.reason ?? null
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Why the host could not read GitHub for a verdict: a closed code, such as the probes' `gh-failed`. */
const REASON_RE = /^[a-z0-9-]{1,40}$/;

/**
 * Whether a GitHub observation is well formed: `ok` with a state per check,
 * or `unavailable` with none.
 * @param {*} o - Observation
 * @returns {boolean} True when usable
 */
function _observationValid(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.state === 'unavailable') return o.checks === null;
  if (o.state !== 'ok' || !o.checks || typeof o.checks !== 'object' || Array.isArray(o.checks)) return false;
  return Object.values(o.checks).every((c) => ['success', 'failure', 'pending', 'missing'].includes(c));
}

/**
 * Judge a verdict's text against the sample it must vouch for.
 *
 * Freshness is decided by the guest's clock alone, never by comparing it with
 * the host's: the verdict must echo the `requestedAt` this request carried
 * (the guest's own time, unique to the request, whose earlier verdict file was
 * removed before asking), and it must arrive within the guest's bounded wait.
 * The host's `observedAt` is kept for the audit trail only.
 * @param {string|null} text - The verdict file, or null when absent
 * @param {{candidateSha: string, runId: string, manifestDigest: string, sampleSeq: number, requestedAt: number}} expected - The sample's binding
 * @returns {{observation: object, binding: {sampleSeq: number, verdictDigest: string}}|{diagnostic: string}} The observation and binding, or why not
 */
function judgeVerdict(text, expected) {
  if (text === null) return { diagnostic: DIAGNOSTIC.MISSING };
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { diagnostic: DIAGNOSTIC.INVALID };
  }
  if (!v || v.schema !== VERDICT_SCHEMA || !_observationValid(v.observation) || !isCount(v.observedAt) || typeof v.verdictDigest !== 'string'
    || !(v.reason === null || (typeof v.reason === 'string' && REASON_RE.test(v.reason)))) {
    return { diagnostic: DIAGNOSTIC.INVALID };
  }
  const bound = ['candidateSha', 'runId', 'manifestDigest', 'sampleSeq', 'requestedAt'].every((k) => v[k] === expected[k]);
  if (!bound || verdictDigest(v) !== v.verdictDigest) return { diagnostic: DIAGNOSTIC.MISMATCH };
  return { observation: { state: v.observation.state, checks: v.observation.checks }, reason: v.reason, binding: { sampleSeq: v.sampleSeq, verdictDigest: v.verdictDigest } };
}

/**
 * Guest side: ask the host for this sample's checks and wait, bounded, for a
 * verdict bound to it. Never throws: anything short of a verified verdict is
 * GitHub unavailable, with the reason as the diagnostic.
 * @param {object} ctx - Probe context: `{candidateSha, runId, exchangeDir, hostVerdictWaitMs}`
 * @param {{seq: number, manifestDigest: string}|undefined} binding - The sample being taken
 * @param {object} [deps] - `{now, sleep}` seams
 * @returns {Promise<{observation: object, error: string|null, binding?: object}>} What the probe reports
 */
async function attest(ctx, binding, deps = {}) {
  const unavailable = (error) => ({ observation: { state: 'unavailable', checks: null }, error });
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!binding || !Number.isSafeInteger(binding.seq) || binding.seq < 1 || typeof binding.manifestDigest !== 'string' || !RUN_ID_RE.test(ctx.runId || '')) {
    return unavailable(DIAGNOSTIC.UNBOUND);
  }
  const expected = { candidateSha: ctx.candidateSha, runId: ctx.runId, manifestDigest: binding.manifestDigest, sampleSeq: binding.seq, requestedAt: now() };
  const paths = exchangePaths(ctx.exchangeDir);
  const verdictPath = path.join(paths.verdicts, `${binding.seq}.json`);
  try {
    privateFs.ensurePrivateDir(paths.requests);
    // A verdict left from an earlier attempt at the same seq is for another
    // request time, so it is removed before asking; it could never match.
    fs.rmSync(verdictPath, { force: true });
    privateFs.replaceAtomic(path.join(paths.requests, `${binding.seq}.json`), `${JSON.stringify({ schema: REQUEST_SCHEMA, ...expected })}\n`);
  } catch (err) { // prawduct:allow prawduct/broad-except -- probe boundary: a request that cannot be written is a sample without checks, never a crash of the runner
    return unavailable(DIAGNOSTIC.REQUEST_FAILED);
  }
  const deadline = expected.requestedAt + (ctx.hostVerdictWaitMs ?? DEFAULT_WAIT_MS);
  const result = await _awaitVerdict(verdictPath, expected, deadline, now, sleep);
  // The exchange holds only what is in flight: once this sample has its
  // answer, or has given up on one, its request and verdict are removed, so
  // neither side re-reads a whole run's worth of files on every pass.
  for (const f of [path.join(paths.requests, `${binding.seq}.json`), verdictPath]) {
    try {
      fs.rmSync(f, { force: true });
    } catch (err) { // prawduct:allow prawduct/broad-except -- cleanup is best effort; a file left behind is re-judged against its own binding and can never vouch for another sample
      void err;
    }
  }
  if (result.diagnostic) return unavailable(result.diagnostic);
  // A verified verdict that the host could not read GitHub for still binds
  // the sample, and says why, so a host whose GitHub access lapsed during a
  // soak shows up in every sample it could not vouch for.
  return { observation: result.observation, error: result.reason ? `host-${result.reason}` : null, binding: result.binding };
}

/**
 * Wait, bounded, for this request's verdict and judge it.
 * @param {string} verdictPath - Where the host writes it
 * @param {object} expected - The request's binding
 * @param {number} deadline - Guest-clock time to give up
 * @param {function(): number} now - Guest clock
 * @param {function(number): Promise<void>} sleep - Sleep seam
 * @returns {Promise<object>} `judgeVerdict`'s result
 */
async function _awaitVerdict(verdictPath, expected, deadline, now, sleep) {
  for (;;) {
    let text = null;
    try {
      text = privateFs.readPrivate(verdictPath);
    } catch (err) {
      if (!(err instanceof CertificationError)) throw err;
      return { diagnostic: DIAGNOSTIC.INVALID };
    }
    if (text !== null) return judgeVerdict(text, expected);
    if (now() >= deadline) return { diagnostic: DIAGNOSTIC.MISSING };
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
  }
}

/**
 * Read an append-only ndjson file of the host's, keeping only complete records.
 * @param {string} file - Path
 * @returns {object[]} Records
 */
function _records(file) {
  return privateFs.readLines(file).records;
}

/**
 * Host side: mint a run id for a candidate and record what the host will
 * judge for it. The id is 128 random bits and is minted once per run: a
 * crash-retry reuses the run whose admission is public, and a genuinely new
 * start mints a new one.
 * @param {string} hostBase - Host state directory
 * @param {{candidateSha: string, repository: string, requiredChecks: string[]}} run - What the run is judged by
 * @param {object} [deps] - `{now, random}` seams
 * @returns {{runId: string}} The minted id
 */
function mintRun(hostBase, run, deps = {}) {
  const paths = hostPaths(hostBase, run.candidateSha);
  if (typeof run.repository !== 'string' || !REPO_RE.test(run.repository)) _refuse(REFUSAL.INVALID_MANIFEST, 'repository must be owner/name', { field: 'repository' });
  if (!validRequiredChecks(run.requiredChecks)) _refuse(REFUSAL.INVALID_MANIFEST, 'requiredChecks must name 1 to 64 unique checks', { field: 'requiredChecks' });
  const runId = (deps.random || (() => crypto.randomBytes(16).toString('hex')))();
  if (!RUN_ID_RE.test(runId)) _refuse(REFUSAL.INVALID_MANIFEST, 'a minted run id must be 32 lowercase hex characters', { field: 'runId' });
  privateFs.ensurePrivateDir(paths.dir);
  const record = { schema: MINT_SCHEMA, candidateSha: run.candidateSha, runId, repository: run.repository, requiredChecks: [...run.requiredChecks].sort(), mintedAt: (deps.now || Date.now)() };
  privateFs.appendLine(paths.runs, JSON.stringify(record));
  return { runId };
}

/**
 * The runs the host minted for a candidate, by run id.
 * @param {string} hostBase - Host state directory
 * @param {string} candidateSha - Candidate SHA
 * @returns {Map<string, object>} Run id to its mint record
 */
function mintedRuns(hostBase, candidateSha) {
  const out = new Map();
  for (const r of _records(hostPaths(hostBase, candidateSha).runs)) {
    if (r && r.schema === MINT_SCHEMA && r.candidateSha === candidateSha && RUN_ID_RE.test(r.runId || '')) out.set(r.runId, r);
  }
  return out;
}

/**
 * Parse a request, or null when it is not one this host can answer.
 * @param {string|null} text - Request file
 * @param {string} candidateSha - The candidate this host is answering for
 * @param {string} seqName - The file's sequence number, from its name
 * @returns {object|null} The request
 */
function _parseRequest(text, candidateSha, seqName) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  const ok = r && r.schema === REQUEST_SCHEMA && r.candidateSha === candidateSha && RUN_ID_RE.test(r.runId || '')
    && typeof r.manifestDigest === 'string' && DIGEST_RE.test(r.manifestDigest)
    && Number.isSafeInteger(r.sampleSeq) && r.sampleSeq >= 1 && String(r.sampleSeq) === seqName && isCount(r.requestedAt);
  return ok ? r : null;
}

/**
 * Host side: answer every pending request in the exchange directory. Each
 * answer reads GitHub afresh, is appended to the host's ledger, and is then
 * written for the guest. A request for a run this host never minted, or one
 * that does not parse, is skipped and reported, never answered.
 * @param {object} opts
 * @param {string} opts.hostBase - Host state directory
 * @param {string} opts.exchangeDir - Exchange directory
 * @param {string} opts.candidateSha - Candidate SHA
 * @param {function({repo: string, candidateSha: string, requiredChecks: string[]}): Promise<{observation: object, error: string|null}>} opts.observe - GitHub observer (`probes.observeGithub`)
 * @param {function(): number} [opts.now] - Clock
 * @param {function(string, string): void} [opts.rename] - `fs.renameSync` seam, for tests
 * @returns {Promise<{answered: number[], unavailable: {sampleSeq: number, reason: string}[], skipped: {file: string, reason: string}[]}>} What was done; `unavailable` lists the answers GitHub could not be read for
 */
async function answerRequests(opts) {
  const now = opts.now || (() => Date.now());
  const paths = exchangePaths(opts.exchangeDir);
  const ledgerPath = hostPaths(opts.hostBase, opts.candidateSha).ledger;
  const minted = mintedRuns(opts.hostBase, opts.candidateSha);
  const answered = [];
  const unavailable = [];
  const skipped = [];
  let names = [];
  try {
    names = fs.readdirSync(paths.requests).filter((n) => /^[1-9][0-9]{0,15}\.json$/.test(n));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  privateFs.ensurePrivateDir(paths.verdicts);
  // A request this host will never answer is moved aside once, into the
  // host's own directory, so a bad file neither stops the rest nor is
  // re-read and re-reported on every pass.
  const reject = (name, reason) => {
    skipped.push({ file: name, reason });
    privateFs.ensurePrivateDir(hostPaths(opts.hostBase, opts.candidateSha).rejected);
    const from = path.join(paths.requests, name);
    try {
      (opts.rename || fs.renameSync)(from, path.join(hostPaths(opts.hostBase, opts.candidateSha).rejected, `${name}.${now()}.${crypto.randomBytes(3).toString('hex')}`));
    } catch (err) {
      if (err.code === 'ENOENT') return;
      // Moving it can fail (across volumes, for one). Removing it keeps the
      // exchange clear all the same; if even that fails, it is left and
      // reported, and never stops the requests after it.
      try {
        fs.rmSync(from, { recursive: true, force: true });
      } catch (rmErr) { // prawduct:allow prawduct/broad-except -- a request that can be neither moved nor removed is reported and skipped; it must not stall the host's answers for the rest of the run
        skipped.push({ file: name, reason: 'not-removable', code: (rmErr && rmErr.code) || null });
      }
    }
  };
  for (const name of names.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))) {
    const seqName = name.slice(0, -'.json'.length);
    let text = null;
    try {
      const st = fs.lstatSync(path.join(paths.requests, name));
      if (!st.isFile()) {
        reject(name, 'not-a-regular-file');
        continue;
      }
      text = privateFs.readPrivate(path.join(paths.requests, name));
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      if (!(err instanceof CertificationError)) throw err;
      reject(name, 'unreadable-request');
      continue;
    }
    const request = text === null ? null : _parseRequest(text, opts.candidateSha, seqName);
    if (!request) {
      if (text !== null) reject(name, 'invalid-request');
      continue;
    }
    const run = minted.get(request.runId);
    if (!run) {
      reject(name, 'run-not-minted');
      continue;
    }
    const verdictPath = path.join(paths.verdicts, name);
    let existing = null;
    try {
      existing = privateFs.readPrivate(verdictPath);
    } catch (err) {
      // A verdict slot that is not a plain file cannot hold this host's
      // answer; it is replaced below, since the answer is written by rename.
      if (!(err instanceof CertificationError)) throw err;
    }
    if (existing !== null && judgeVerdict(existing, request).binding) continue;
    const { observation, error } = await opts.observe({ repo: run.repository, candidateSha: opts.candidateSha, requiredChecks: run.requiredChecks });
    const readable = _observationValid(observation) && observation.state === 'ok';
    const reason = readable ? null : (typeof error === 'string' && REASON_RE.test(error) ? error : 'github-unavailable');
    const verdict = {
      schema: VERDICT_SCHEMA,
      candidateSha: request.candidateSha,
      runId: request.runId,
      manifestDigest: request.manifestDigest,
      sampleSeq: request.sampleSeq,
      requestedAt: request.requestedAt,
      observedAt: now(),
      observation: _observationValid(observation) ? observation : { state: 'unavailable', checks: null },
      reason
    };
    verdict.verdictDigest = verdictDigest(verdict);
    // The ledger first: a verdict the guest can see is always one the host
    // has on record, so finalization can never meet a verdict it did not issue.
    privateFs.appendLine(ledgerPath, JSON.stringify(verdict));
    privateFs.replaceAtomic(verdictPath, `${JSON.stringify(verdict)}\n`);
    answered.push(request.sampleSeq);
    if (reason) unavailable.push({ sampleSeq: request.sampleSeq, reason });
  }
  return { answered, unavailable, skipped };
}

/**
 * Host side: decide whether a finished run's checks were really vouched for,
 * and record the answer. The run is read from its exported evidence; the host
 * trusts nothing in it that its own ledger does not confirm.
 * @param {object} opts
 * @param {string} opts.hostBase - Host state directory
 * @param {object} opts.manifest - The run's manifest
 * @param {string} opts.manifestDigest - The digest of the manifest as stored
 * @param {object} opts.state - The run's committed state
 * @param {object[]} opts.samples - The run's sample records (`store.readSamples`)
 * @param {function(object): Promise<{observation: object, error: string|null}>} opts.observe - GitHub observer, for the final read
 * @param {object|null} [opts.soakJudgement] - The soak judge's verdict on this run's evidence bundle; none is `SOAK_JUDGEMENT_MISSING`
 * @param {function(): number} [opts.now] - Clock
 * @returns {Promise<{ok: boolean, reasons: {code: string, sampleSeq?: number}[]}>} The outcome, also written to the run's `finalization-<runId>.json`
 * @throws {CertificationError} `FINALIZATION_SEALED` when the run has already been relayed, `LOCK_HELD` while it is being relayed
 */
async function finalize(opts) {
  const now = opts.now || (() => Date.now());
  const { manifest } = opts;
  const reasons = [];
  const add = (code, extra = {}) => reasons.push({ code, ...extra });
  const paths = hostPaths(opts.hostBase, manifest.candidateSha);
  const run = mintedRuns(opts.hostBase, manifest.candidateSha).get(manifest.runId);
  if (manifest.checksSource !== 'host-attested') add(FINALIZATION.NOT_HOST_ATTESTED);
  if (!run) add(FINALIZATION.RUN_NOT_MINTED);
  else if (JSON.stringify([...manifest.requiredChecks].sort()) !== JSON.stringify(run.requiredChecks) || manifest.repository !== run.repository) {
    add(FINALIZATION.CHECKS_LIST_DRIFT);
  }
  if (!['awaiting-review', 'passed'].includes(opts.state.state)) add(FINALIZATION.NOT_REVIEWABLE);
  const ledger = new Map();
  for (const v of _records(paths.ledger)) {
    if (v && v.schema === VERDICT_SCHEMA && v.candidateSha === manifest.candidateSha && v.runId === manifest.runId && v.manifestDigest === opts.manifestDigest) {
      ledger.set(`${v.sampleSeq}:${v.verdictDigest}`, v);
    }
  }
  const green = (o) => o && o.state === 'ok' && manifest.requiredChecks.every((c) => o.checks[c] === 'success');
  // Every sample the run committed must be in the evidence: a record that is
  // missing could be the one whose checks were never vouched for.
  const seqs = opts.samples.map((r) => r.seq);
  if (seqs.length !== opts.state.sampleCount || seqs.some((seq, i) => seq !== i + 1)) add(FINALIZATION.SAMPLES_INCOMPLETE);
  // A verdict speaks for its sample only if the sample was taken after it was
  // asked for and within one sampling interval of that request. Both times
  // are the guest's own clock, so no host/guest skew enters this check.
  const maxAge = manifest.thresholds.maxIntervalMs;
  // In a guest, every vouched sample must also carry its own isolation
  // attestations, from the boot the run was admitted in (A43, A44, A47).
  const attested = manifest.isolation === 'attested';
  const bootId = opts.state.baseline && typeof opts.state.baseline.bootId === 'string' ? opts.state.baseline.bootId : null;
  if (attested && bootId === null) add(FINALIZATION.ISOLATION_MISSING, { sampleSeq: 1 });
  const DIGEST = /^[0-9a-f]{64}$/;
  for (const record of opts.samples) {
    // Admission (seq 1) and every sample that earned time must be vouched for.
    const mustVouch = record.seq === 1 || (record.interval && record.interval.qualifies === true);
    if (!mustVouch) continue;
    if (attested && bootId !== null) {
      const iso = record.isolation;
      if (!iso) add(FINALIZATION.ISOLATION_MISSING, { sampleSeq: record.seq });
      else if (iso.sampleSeq !== record.seq || iso.bootId !== bootId || !DIGEST.test(iso.adminDigest || '') || !DIGEST.test(iso.workloadDigest || '')
        || !record.observations || !record.observations.isolation || record.observations.isolation.state !== 'ok') {
        add(FINALIZATION.ISOLATION_MISMATCH, { sampleSeq: record.seq });
      }
    }
    const b = record.checks;
    if (!b || b.sampleSeq !== record.seq || typeof b.verdictDigest !== 'string') {
      add(FINALIZATION.VERDICT_MISSING, { sampleSeq: record.seq });
      continue;
    }
    const issued = ledger.get(`${record.seq}:${b.verdictDigest}`);
    if (!issued || verdictDigest(issued) !== b.verdictDigest) add(FINALIZATION.VERDICT_MISMATCH, { sampleSeq: record.seq });
    else if (!green(issued.observation)) add(FINALIZATION.VERDICT_NOT_GREEN, { sampleSeq: record.seq });
    else if (!isCount(record.wallAt) || record.wallAt < issued.requestedAt || record.wallAt - issued.requestedAt > maxAge) {
      add(FINALIZATION.VERDICT_NOT_FRESH, { sampleSeq: record.seq });
    }
  }
  if (run) {
    const final = await opts.observe({ repo: run.repository, candidateSha: manifest.candidateSha, requiredChecks: run.requiredChecks });
    if (!final.observation || final.observation.state !== 'ok') add(FINALIZATION.FINAL_CHECKS_UNAVAILABLE);
    else if (!green(final.observation)) add(FINALIZATION.FINAL_CHECKS_NOT_GREEN);
  }
  _judgeSoak(opts.soakJudgement, { candidateSha: manifest.candidateSha, runId: manifest.runId, manifestDigest: opts.manifestDigest }, add);
  const outcome = { ok: reasons.length === 0, reasons };
  // What this finalization vouched for, as one digest over every committed
  // sample, so the host's record can bind the exact set and sequence (A51).
  const sampleSetDigest = crypto.createHash('sha256').update(isolationLib.canonical(opts.samples.map((r) => [
    r.seq, r.checks ? r.checks.verdictDigest : null, r.isolation ? r.isolation.adminDigest : null, r.isolation ? r.isolation.workloadDigest : null,
    r.interval ? r.interval.qualifies === true : null
  ]))).digest('hex');
  privateFs.ensurePrivateDir(paths.dir);
  // Kept per run: a later run of the same candidate must never overwrite, or
  // be mistaken for, this one's outcome. A manifest with no valid run id has
  // nothing to record against.
  if (typeof manifest.runId !== 'string' || !RUN_ID_RE.test(manifest.runId)) return outcome;
  // Once the host has relayed this run, its record binds these exact bytes,
  // so the finalization is sealed: rewriting it (if only with a fresh
  // finalizedAt) would make that record fail its own re-derivation forever.
  // Before any relay, a re-finalize is allowed, e.g. after a failed one.
  // The seal check and the write happen under the run's lock, which the relay
  // also holds from reading the finalization to writing its record, so a
  // finalize can never land in the middle of a relay (LOCK_HELD instead).
  const lockPath = paths.runLock(manifest.runId);
  const token = lockfile.acquire(lockPath, { timeoutMs: 0 });
  try {
    if (_relayedRecords(paths, manifest.runId).length > 0) {
      _refuse(REFUSAL.FINALIZATION_SEALED, 'this run has already been relayed, so its finalization is sealed', { runId: manifest.runId });
    }
    privateFs.replaceAtomic(paths.finalization(manifest.runId), `${JSON.stringify({
      schema: FINALIZATION_SCHEMA, candidateSha: manifest.candidateSha, runId: manifest.runId ?? null,
      manifestDigest: opts.manifestDigest, state: opts.state.state, bootId, sampleSetDigest, ...outcome,
      soak: opts.soakJudgement === undefined ? null : opts.soakJudgement, finalizedAt: now()
    }, null, 2)}\n`);
  } finally {
    lockfile.release(lockPath, token);
  }
  return outcome;
}

/**
 * Whether a soak judgement passed and is bound to exactly one run: the
 * candidate SHA the bundle names and the one it was judged for are both the
 * run's, and so are the run id and the manifest digest. It must also name
 * the digests it vouches for. Anything else vouches for nothing.
 * @param {*} judgement - A recorded `tc.soak-judgement/v1` judgement
 * @param {{candidateSha: string, runId: string, manifestDigest: string}} run - The run it must be bound to
 * @returns {boolean} True only for a passed judgement bound to that run
 */
function soakJudgementBound(judgement, run) {
  if (!_soakJudgementPassed(judgement) || !run) return false;
  const b = judgement.binding;
  return SHA_RE.test(run.candidateSha || '') && b.candidateSha === run.candidateSha && b.bundleCandidateSha === run.candidateSha
    && b.runId === run.runId && b.manifestDigest === run.manifestDigest
    && DIGEST_RE.test(b.bundleManifestSha256 || '') && DIGEST_RE.test(b.logSha256 || '') && typeof b.scheduleDigest === 'string' && b.scheduleDigest !== '';
}

/**
 * Whether a soak judgement says it passed, with no reasons, in its own schema.
 * @param {*} judgement - Candidate judgement
 * @returns {boolean} True when it passed
 */
function _soakJudgementPassed(judgement) {
  return Boolean(judgement && typeof judgement === 'object' && judgement.schema === SOAK_JUDGEMENT_SCHEMA && judgement.passed === true
    && Array.isArray(judgement.reasons) && judgement.reasons.length === 0 && judgement.binding && typeof judgement.binding === 'object');
}

/**
 * Add the finalization reason a soak judgement earns, if any.
 * @param {*} judgement - The soak judgement given to `finalize`
 * @param {{candidateSha: string, runId: string, manifestDigest: string}} run - The run being finalized
 * @param {function(string, object=): void} add - Reason sink
 * @returns {void}
 */
function _judgeSoak(judgement, run, add) {
  if (judgement === undefined || judgement === null) add(FINALIZATION.SOAK_JUDGEMENT_MISSING);
  else if (!_soakJudgementPassed(judgement)) add(FINALIZATION.SOAK_JUDGEMENT_FAILED);
  else if (!soakJudgementBound(judgement, run)) add(FINALIZATION.SOAK_JUDGEMENT_UNBOUND);
}

/**
 * The relay records (named by `hostPaths#record`) the host holds for a run.
 * @param {object} paths - `hostPaths` for the candidate
 * @param {string} runId - The run
 * @returns {string[]} File names
 */
function _relayedRecords(paths, runId) {
  const prefix = paths.recordPrefix(runId);
  try {
    return fs.readdirSync(paths.dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * The host's recorded finalization for one run, or null when none exists.
 * Its reader is the host relay (`rc-cert host-publish`), which makes a
 * host-attested pass certification of record only on an `ok` finalization of
 * that exact run (ADR 0021 point 10).
 * @param {string} hostBase - Host state directory
 * @param {string} candidateSha - Candidate SHA
 * @param {string} runId - The run
 * @returns {object|null} The record
 */
function readFinalization(hostBase, candidateSha, runId) {
  const text = privateFs.readPrivate(hostPaths(hostBase, candidateSha).finalization(runId));
  if (text === null) return null;
  try {
    const doc = JSON.parse(text);
    return doc && doc.schema === FINALIZATION_SCHEMA && doc.runId === runId && doc.candidateSha === candidateSha ? doc : null;
  } catch {
    return null;
  }
}

module.exports = {
  FINALIZATION_SCHEMA,
  SOAK_JUDGEMENT_SCHEMA,
  soakJudgementBound,
  REQUEST_SCHEMA,
  VERDICT_SCHEMA,
  DEFAULT_WAIT_MS,
  DIAGNOSTIC,
  FINALIZATION,
  exchangePaths,
  hostPaths,
  verdictDigest,
  judgeVerdict,
  attest,
  mintRun,
  mintedRuns,
  answerRequests,
  finalize,
  readFinalization
};
