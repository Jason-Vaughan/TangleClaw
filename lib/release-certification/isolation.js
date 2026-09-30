'use strict';

/**
 * Network-isolation attestations for a certifying run in a guest (#2020,
 * Architect rulings A43, A44 and A47).
 *
 * A soak in a guest is only a certification if the guest stayed isolated the
 * whole time. No single process can show that: the unprivileged workload the
 * soak runs as must be refused `pfctl`, so it cannot also read the packet
 * filter. Isolation is therefore attested in two planes, joined:
 *
 * - **admin**: the packet filter is enabled with an exact, normalized ruleset
 *   digest, the interfaces and addresses, the boot identity, and that the
 *   management path is `host-only`: inbound SSH admitted only from the
 *   configured host while all guest-initiated egress is denied (the exact pf
 *   profile proves it). A listening SSH is never called closed;
 * - **workload**: the dedicated uid and groups, `sudo` and `pfctl` refused, the
 *   loopback API reachable, and IPv4, IPv6 and DNS egress all denied.
 *
 * Both are produced for one sample (Chunk 1's `guest-setup.sh --verify-network`,
 * behind the `verifyNetwork` seam), echo that sample's binding, and must agree
 * on the boot identity. Anything missing, malformed, unbound or split reads as
 * unattested, which earns no time; an attestation that says isolation is
 * broken is a breach, which fails the run. The digests of both planes travel
 * with the sample, so a finalization can join them.
 *
 * @module lib/release-certification/isolation
 */

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { SHA_RE, DIGEST_RE, RUN_ID_RE, TEXT_RE, isCount } = require('./formats');

const ADMIN_SCHEMA = 'tc.release-certification.isolation-admin/v1';
const WORKLOAD_SCHEMA = 'tc.release-certification.isolation-workload/v1';
const BREACH_SCHEMA = 'tc.release-certification.isolation-breach/v1';

/**
 * The unsafe facts a measured-breach envelope may name. The producer emits a
 * breach only for a fact it positively measured; a failure to measure is
 * never a breach, it is unattested.
 */
const BREACH_FACTS = Object.freeze(['pf-disabled', 'pf-rules-changed', 'privileged-workload', 'sudo-permitted', 'pfctl-permitted', 'egress-permitted']);

/** Why a sample's isolation could not be attested. Recorded as the sample's isolation diagnostic. */
const DIAGNOSTIC = Object.freeze({
  MISSING: 'isolation-missing',
  INVALID: 'isolation-invalid',
  UNBOUND: 'isolation-unbound',
  SPLIT: 'isolation-split'
});

/** The binding every attestation must echo. */
const BINDING_KEYS = Object.freeze(['candidateSha', 'runId', 'manifestDigest', 'sampleSeq']);

/**
 * Canonical JSON: keys sorted at every level, so a digest does not depend on
 * how the producer ordered its fields.
 * @param {*} v - Value
 * @returns {string} Canonical text
 */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * The digest an attestation is known by.
 * @param {object} doc - Attestation
 * @returns {string} Hex sha256
 */
function digest(doc) {
  return crypto.createHash('sha256').update(canonical(doc)).digest('hex');
}

/**
 * Whether a value is a plain object with exactly these keys.
 * @param {*} o - Value
 * @param {string[]} keys - Keys
 * @returns {boolean} True when the shape matches
 */
function _shape(o, keys) {
  return Boolean(o) && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
}

/**
 * Whether an admin attestation is well formed (not whether it is healthy).
 * @param {*} a - Attestation
 * @returns {boolean} True when valid
 */
function _adminValid(a) {
  return _shape(a, ['schema', ...BINDING_KEYS, 'bootId', 'pfEnabled', 'rulesetSha256', 'interfaces', 'managementPath', 'observedAt'])
    && a.schema === ADMIN_SCHEMA && typeof a.bootId === 'string' && TEXT_RE.test(a.bootId)
    && typeof a.pfEnabled === 'boolean' && typeof a.rulesetSha256 === 'string' && DIGEST_RE.test(a.rulesetSha256)
    && Array.isArray(a.interfaces) && a.interfaces.length <= 32 && a.interfaces.every((i) => typeof i === 'string' && TEXT_RE.test(i))
    && ['host-only', 'open'].includes(a.managementPath) && isCount(a.observedAt);
}

/**
 * Whether a workload attestation is well formed (not whether it is healthy).
 * @param {*} w - Attestation
 * @returns {boolean} True when valid
 */
function _workloadValid(w) {
  return _shape(w, ['schema', ...BINDING_KEYS, 'bootId', 'uid', 'groups', 'sudoRefused', 'pfctlRefused', 'loopbackApi', 'egressDenied', 'observedAt'])
    && w.schema === WORKLOAD_SCHEMA && typeof w.bootId === 'string' && TEXT_RE.test(w.bootId)
    && Number.isSafeInteger(w.uid) && w.uid >= 0 && Array.isArray(w.groups) && w.groups.length <= 64 && w.groups.every((g) => Number.isSafeInteger(g) && g >= 0)
    && ['sudoRefused', 'pfctlRefused', 'loopbackApi'].every((k) => typeof w[k] === 'boolean')
    && _shape(w.egressDenied, ['ipv4', 'ipv6', 'dns']) && Object.values(w.egressDenied).every((b) => typeof b === 'boolean')
    && isCount(w.observedAt);
}

/**
 * Whether the two planes say the guest is isolated.
 * @param {object} a - Valid admin attestation
 * @param {object} w - Valid workload attestation
 * @returns {boolean} True when every condition holds
 */
function _isolated(a, w) {
  // A root workload (uid 0) or one in the admin group (80 on macOS) is not the
  // dedicated non-admin identity the soak runs as.
  const nonAdmin = w.uid !== 0 && !w.groups.includes(0) && !w.groups.includes(80);
  return a.pfEnabled && a.managementPath === 'host-only'
    && nonAdmin && w.sudoRefused && w.pfctlRefused && w.loopbackApi
    && w.egressDenied.ipv4 && w.egressDenied.ipv6 && w.egressDenied.dns;
}

/**
 * Whether a measured-breach envelope has exactly the closed shape.
 * @param {*} b - Envelope
 * @returns {boolean} True when valid
 */
function _breachValid(b) {
  return _shape(b, ['schema', ...BINDING_KEYS, 'bootId', 'facts', 'observedAt'])
    && b.schema === BREACH_SCHEMA && typeof b.bootId === 'string' && TEXT_RE.test(b.bootId) && isCount(b.observedAt)
    && Array.isArray(b.facts) && b.facts.length >= 1 && b.facts.length <= 2
    && b.facts.every((f) => _shape(f, ['plane', 'fact']) && ['admin', 'workload'].includes(f.plane) && BREACH_FACTS.includes(f.fact))
    && new Set(b.facts.map((f) => f.plane)).size === b.facts.length;
}

/**
 * Judge one sample's producer result against the sample's binding: the
 * healthy pair `{admin, workload}`, or a measured-breach envelope `{breach}`.
 * @param {*} pair - The producer's result
 * @param {{candidateSha: string, runId: string, manifestDigest: string, sampleSeq: number}} binding - The sample
 * @returns {{observation: object, error: string|null}} The isolation observation, and why it is unattested if it is
 */
function judgeIsolation(pair, binding) {
  const unattested = (error) => ({ observation: { state: 'unavailable' }, error });
  if (pair && typeof pair === 'object' && !Array.isArray(pair) && 'breach' in pair) {
    // A breach the guest measured, bound to this sample: it fails the run.
    if (Object.keys(pair).length !== 1 || !_breachValid(pair.breach)) return unattested(DIAGNOSTIC.INVALID);
    if (!BINDING_KEYS.every((k) => pair.breach[k] === binding[k])) return unattested(DIAGNOSTIC.UNBOUND);
    return { observation: { state: 'breached', bootId: pair.breach.bootId, facts: pair.breach.facts.map((f) => `${f.plane}:${f.fact}`), breachDigest: digest(pair.breach) }, error: null };
  }
  if (!pair || typeof pair !== 'object' || !pair.admin || !pair.workload) return unattested(DIAGNOSTIC.MISSING);
  const { admin, workload } = pair;
  if (!_adminValid(admin) || !_workloadValid(workload)) return unattested(DIAGNOSTIC.INVALID);
  if (!BINDING_KEYS.every((k) => admin[k] === binding[k] && workload[k] === binding[k])) return unattested(DIAGNOSTIC.UNBOUND);
  if (admin.bootId !== workload.bootId) return unattested(DIAGNOSTIC.SPLIT);
  const facts = { bootId: admin.bootId, rulesetSha256: admin.rulesetSha256, adminDigest: digest(admin), workloadDigest: digest(workload) };
  return { observation: { state: _isolated(admin, workload) ? 'ok' : 'breached', ...facts }, error: null };
}

/**
 * Attest one sample's isolation. Never throws: a producer that fails reads as
 * unattested.
 * @param {function(object): Promise<object>} verifyNetwork - The producer (Chunk 1)
 * @param {object} binding - `{candidateSha, runId, manifestDigest, sampleSeq}`
 * @returns {Promise<{observation: object, error: string|null, detail?: string}>} The observation; when unattested, `detail` may carry the producer's bounded failure class and sanitized stderr (private evidence, never published)
 */
async function attest(verifyNetwork, binding) {
  const ok = binding && SHA_RE.test(binding.candidateSha || '') && RUN_ID_RE.test(binding.runId || '')
    && DIGEST_RE.test(binding.manifestDigest || '') && Number.isSafeInteger(binding.sampleSeq) && binding.sampleSeq >= 1;
  if (!ok || typeof verifyNetwork !== 'function') return { observation: { state: 'unavailable' }, error: DIAGNOSTIC.MISSING };
  let pair;
  try {
    pair = await verifyNetwork(binding);
  } catch (err) { // prawduct:allow prawduct/broad-except -- probe boundary: a producer that fails is an unattested sample, never a crash of the runner
    return { observation: { state: 'unavailable' }, error: DIAGNOSTIC.MISSING };
  }
  if (pair && typeof pair === 'object' && pair.failure && typeof pair.failure === 'object') {
    const f = pair.failure;
    return { observation: { state: 'unavailable' }, error: DIAGNOSTIC.MISSING, detail: sanitize(`${String(f.class)}: ${String(f.detail)}`) };
  }
  return judgeIsolation(pair, binding);
}

/**
 * Keep a producer's stderr as bounded, printable evidence: control
 * characters become spaces, runs of whitespace collapse, and only the last
 * 300 characters (where a refusal's reason is) are kept.
 * @param {*} text - stderr
 * @returns {string} Sanitized text
 */
function sanitize(text) {
  return String(text || '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(-300);
}

/** How long one attestation may take: well inside the shortest sampling interval. */
const PRODUCER_TIMEOUT_MS = 30 * 1000;

/**
 * The producer interface to Chunk 1's attestation program: it is run as
 * `<program> --verify-network --candidate <sha> --run-id <id>
 * --manifest-digest <hex> --sample-seq <n>` and prints one JSON object on
 * stdout: the pair `{admin, workload}` or a measured-breach envelope
 * `{breach}`. A non-zero exit, a timeout, no output or output that does not
 * parse resolves to `{failure: {class, detail}}`: a stable class and the
 * sanitized tail of stderr, which reads as unattested and is kept as private
 * evidence.
 * @param {string} program - Absolute path, pinned in the manifest
 * @param {function} [run] - `execFile` seam
 * @returns {function(object): Promise<object|null>} `verifyNetwork`
 */
function producer(program, run = execFile) {
  return (binding) => new Promise((resolve) => {
    const args = ['--verify-network', '--candidate', binding.candidateSha, '--run-id', binding.runId, '--manifest-digest', binding.manifestDigest, '--sample-seq', String(binding.sampleSeq)];
    run(program, args, { timeout: PRODUCER_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const fail = (klass) => resolve({ failure: { class: klass, detail: sanitize(stderr) } });
      if (err) {
        if (err.killed || err.signal === 'SIGTERM') return fail('timeout');
        if (typeof err.code === 'number') return fail(`exit-${err.code}`);
        return fail('spawn-failed');
      }
      const out = String(stdout || '');
      if (out.trim() === '') return fail('no-output');
      try {
        resolve(JSON.parse(out));
      } catch {
        fail('bad-json');
      }
    });
  });
}

module.exports = { ADMIN_SCHEMA, WORKLOAD_SCHEMA, BREACH_SCHEMA, BREACH_FACTS, DIAGNOSTIC, canonical, digest, sanitize, judgeIsolation, attest, producer };
