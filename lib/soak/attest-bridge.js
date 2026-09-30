'use strict';

/**
 * The provider side of the soak guest's isolation attestation (#2020,
 * Architect ruling 2baeac0d on the Chunk 1 / B7 interface).
 *
 * `guest-setup.sh --verify-network` obtains one fresh `--verify-admin` line
 * and one fresh `--verify-workload` line (the guest's own raw
 * `tc.soak-guest-attest/v1` evidence) and hands both here with the sample's
 * binding. This turns them into exactly one `{admin, workload}` pair in the
 * release-certification isolation schemas, with the binding copied into both
 * planes, or refuses. The judge (`lib/release-certification/isolation.js`)
 * never parses the raw lines itself.
 *
 * The result is one of three. Both planes `ok` gives the pair. A MEASURED
 * breach from either plane (the verifier exited 3 with code BREACH, a known
 * `breach.fact`, and its boot and artifact identity) gives a bound breach
 * envelope, `{breach: {...}}`, which the judge reads as breached; no healthy
 * plane is ever fabricated for it. Anything else gives nothing.
 *
 * It refuses, and so yields nothing, on anything it cannot convert without
 * guessing: a missing or malformed binding, anything but exactly one JSON line
 * per plane, a plane that is not `ok`, a field it needs that is missing or
 * mistyped, a boot or artifact identity the two planes disagree on, or a value
 * outside what it maps. A refusal is recorded by the runner as unattested,
 * which earns no time. Only healthy (`ok`) lines are ever converted, so a
 * pair it produces describes a guest both planes found isolated.
 *
 * @module lib/soak/attest-bridge
 */

const RAW_SCHEMA = 'tc.soak-guest-attest/v1';
const ADMIN_SCHEMA = 'tc.release-certification.isolation-admin/v1';
const WORKLOAD_SCHEMA = 'tc.release-certification.isolation-workload/v1';
const BREACH_SCHEMA = 'tc.release-certification.isolation-breach/v1';

/**
 * The unsafe facts a raw verifier reports as measured (code BREACH). The
 * guest emits one only after positively observing it; this closed set is
 * what the bridge will bind, and anything else is unavailable. The schema
 * names and this set are the judge's (`lib/release-certification/isolation.js`)
 * and must stay identical to it; they are copied rather than required because
 * this module runs as the guest admin, and guest-setup.sh's checkout-trust
 * check covers `lib/soak/*.js` but not the release-certification library.
 */
const BREACH_FACTS = Object.freeze(['pf-disabled', 'pf-rules-changed', 'privileged-workload', 'sudo-permitted', 'pfctl-permitted', 'egress-permitted']);

const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[0-9a-f]{32}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SEQ_RE = /^[1-9][0-9]{0,15}$/;
const TEXT_RE = /^[^\u0000-\u001f]{1,256}$/;

/** A refusal: the bridge yields no pair. */
class BridgeError extends Error {
  /**
   * @param {string} code - Closed code
   * @param {string} message - Why
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Throw a refusal.
 * @param {string} code - Closed code
 * @param {string} message - Why
 * @returns {never}
 */
function _refuse(code, message) {
  throw new BridgeError(code, message);
}

/**
 * Validate the sample's binding, as the four command-line values.
 * @param {{candidateSha: string, runId: string, manifestDigest: string, sampleSeq: string}} raw - The values as given
 * @returns {{candidateSha: string, runId: string, manifestDigest: string, sampleSeq: number}} The binding
 */
function parseBinding(raw) {
  if (!raw || !SHA_RE.test(raw.candidateSha || '')) _refuse('BINDING', 'candidate must be 40 lowercase hex characters');
  if (!RUN_ID_RE.test(raw.runId || '')) _refuse('BINDING', 'run id must be 32 lowercase hex characters');
  if (!DIGEST_RE.test(raw.manifestDigest || '')) _refuse('BINDING', 'manifest digest must be 64 lowercase hex characters');
  if (!SEQ_RE.test(raw.sampleSeq || '')) _refuse('BINDING', 'sample sequence must be a positive integer');
  const sampleSeq = Number(raw.sampleSeq);
  if (!Number.isSafeInteger(sampleSeq)) _refuse('BINDING', 'sample sequence is out of range');
  return { candidateSha: raw.candidateSha, runId: raw.runId, manifestDigest: raw.manifestDigest, sampleSeq };
}

/**
 * Parse one plane's output: exactly one JSON line, of the raw schema and mode,
 * reporting `ok`.
 * @param {*} text - The verifier's stdout
 * @param {'admin'|'workload'} mode - The plane
 * @returns {object} The parsed line
 */
function _line(text, mode) {
  if (typeof text !== 'string') _refuse('OUTPUT', `no ${mode} output`);
  const trimmed = text.replace(/\n$/, '');
  if (trimmed.length === 0 || trimmed.includes('\n') || trimmed.includes('\r')) _refuse('OUTPUT', `the ${mode} verifier must print exactly one line`);
  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    _refuse('OUTPUT', `the ${mode} line is not JSON`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) _refuse('OUTPUT', `the ${mode} line is not a JSON object`);
  if (doc.schema !== RAW_SCHEMA || doc.mode !== mode) _refuse('OUTPUT', `the ${mode} line is not a ${RAW_SCHEMA} ${mode} attestation`);
  return doc;
}

/**
 * Whether a parsed line, with its verifier's exit status, is a measured
 * breach: exit 3, `ok: false`, code BREACH and a known fact. Only that shape
 * is; a refusal for anything the verifier could not measure is not.
 * @param {object} doc - Parsed line
 * @param {number} rc - The verifier's exit status
 * @returns {boolean} True for a measured breach
 */
function _isBreach(doc, rc) {
  return rc === 3 && doc.ok === false && doc.code === 'BREACH' && doc.breach && typeof doc.breach === 'object'
    && BREACH_FACTS.includes(doc.breach.fact);
}

/**
 * Read a nested field, refusing when it is missing or fails `check`.
 * @param {object} doc - Parsed line
 * @param {string} dotted - Path such as `boot.session`
 * @param {function(*): boolean} check - Validity test
 * @param {string} mode - The plane, for the message
 * @returns {*} The value
 */
function _field(doc, dotted, check, mode) {
  let v = doc;
  for (const k of dotted.split('.')) v = v && typeof v === 'object' && !Array.isArray(v) ? v[k] : undefined;
  if (v === undefined || !check(v)) _refuse('FIELD', `the ${mode} line's ${dotted} is missing or malformed`);
  return v;
}

const isText = (v) => typeof v === 'string' && TEXT_RE.test(v);
const isDigest = (v) => typeof v === 'string' && DIGEST_RE.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isTrue = (v) => v === true;

/**
 * The epoch milliseconds of an attestation's own ISO time.
 * @param {object} doc - Parsed line
 * @param {string} mode - The plane
 * @returns {number} Epoch ms
 */
function _time(doc, mode) {
  const iso = _field(doc, 'time', (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v), mode);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) _refuse('FIELD', `the ${mode} line's time does not parse`);
  return ms;
}

/**
 * The boot and artifact identity a line carries: what both planes must agree on.
 * @param {object} doc - Parsed line
 * @param {string} mode - The plane
 * @returns {{bootId: string, artifacts: string}} Identity
 */
function _identity(doc, mode) {
  const session = _field(doc, 'boot.session', isText, mode);
  const time = _field(doc, 'boot.time', isCount, mode);
  const artifacts = ['scriptSha256', 'profileSha256', 'guestConfSha256'].map((k) => _field(doc, `artifact.${k}`, isDigest, mode));
  return { bootId: `${session}@${time}`, artifacts: artifacts.join(',') };
}

/**
 * Convert one fresh admin line and one fresh workload line into the bound pair.
 * @param {string} adminText - `--verify-admin` stdout
 * @param {string} workloadText - `--verify-workload` stdout
 * @param {object} rawBinding - The four binding values as given on the command line
 * @param {{admin?: number, workload?: number}} [status] - Each verifier's exit status (default 0)
 * @returns {{admin: object, workload: object}|{breach: object}} The pair, or a bound breach envelope, in the release-certification isolation schemas
 * @throws {BridgeError} When neither can be produced without guessing (the sample is unattested)
 */
function bridge(adminText, workloadText, rawBinding, status = {}) {
  const binding = parseBinding(rawBinding);
  const adminRc = status.admin ?? 0;
  const workloadRc = status.workload ?? 0;
  // A plane with no parsable line cannot be a measured breach; the other
  // plane may still be one, so each is read on its own first.
  const read = (text, mode) => {
    try {
      return _line(text, mode);
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err;
      return err;
    }
  };
  const aDoc = read(adminText, 'admin');
  const wDoc = read(workloadText, 'workload');
  const breaches = [['admin', aDoc, adminRc], ['workload', wDoc, workloadRc]]
    .filter(([, doc, rc]) => !(doc instanceof BridgeError) && _isBreach(doc, rc));
  if (breaches.length > 0) return { breach: _breachEnvelope(breaches, binding) };
  if (aDoc instanceof BridgeError) throw aDoc;
  if (wDoc instanceof BridgeError) throw wDoc;
  for (const [mode, doc, rc] of [['admin', aDoc, adminRc], ['workload', wDoc, workloadRc]]) {
    if (rc !== 0 || doc.ok !== true) _refuse('NOT_OK', `the ${mode} verifier did not attest: ${String(doc.code || '')} ${String(doc.reason || '').slice(0, 200)}`);
  }
  const a = aDoc;
  const w = wDoc;
  const ai = _identity(a, 'admin');
  const wi = _identity(w, 'workload');
  if (ai.bootId !== wi.bootId) _refuse('SPLIT', 'the two planes report different boots');
  if (ai.artifacts !== wi.artifacts) _refuse('SPLIT', 'the two planes ran different guest-setup, profile or guest.conf artifacts');

  // The admin plane. An `ok` line has already proven the loaded ruleset is
  // exactly the profile, and that profile admits inbound SSH from the
  // configured host only while denying all guest-initiated egress: that is
  // what `host-only` asserts. A listening SSH is never read as closed.
  const expected = _field(a, 'pf.expectedRulesSha256', isDigest, 'admin');
  const active = _field(a, 'pf.activeRulesSha256', isDigest, 'admin');
  if (expected !== active) _refuse('FIELD', 'the admin line reports a ruleset that is not the profile');
  _field(a, 'pf.enabled', isTrue, 'admin');
  _field(a, 'pf.rulesMatch', isTrue, 'admin');
  const ssh = _field(a, 'management.ssh', isText, 'admin');
  if (ssh !== 'listening') _refuse('FIELD', `the admin line reports management.ssh '${ssh.slice(0, 40)}', which has no mapping`);
  const ifName = _field(a, 'interface.name', (v) => typeof v === 'string' && /^[a-z]+[0-9]+$/.test(v), 'admin');
  const ifAddr = _field(a, 'interface.address', (v) => typeof v === 'string' && /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(v), 'admin');
  const admin = {
    schema: ADMIN_SCHEMA,
    ...binding,
    bootId: ai.bootId,
    pfEnabled: true,
    rulesetSha256: active,
    interfaces: [`${ifName}=${ifAddr}`],
    managementPath: 'host-only',
    observedAt: _time(a, 'admin')
  };

  // The workload plane. Group ids come from the verifier's own numeric
  // evidence, never from resolving names.
  const uid = _field(w, 'identity.uid', (v) => Number.isSafeInteger(v) && v >= 501, 'workload');
  const gidsText = _field(w, 'identity.gids', (v) => typeof v === 'string' && /^[0-9]{1,10}( [0-9]{1,10}){0,63}$/.test(v), 'workload');
  const groups = gidsText.split(' ').map(Number);
  if (!groups.every((g) => Number.isSafeInteger(g))) _refuse('FIELD', 'the workload line\'s identity.gids is malformed');
  for (const k of ['refused.sudo', 'refused.pfctl', 'loopback.ipv4', 'loopback.ipv6', 'loopback.api']) _field(w, k, isTrue, 'workload');
  for (const k of ['egress.tcp4', 'egress.tcp6', 'egress.udpDns']) _field(w, k, (v) => v === 'denied', 'workload');
  const workload = {
    schema: WORKLOAD_SCHEMA,
    ...binding,
    bootId: wi.bootId,
    uid,
    groups,
    sudoRefused: true,
    pfctlRefused: true,
    loopbackApi: true,
    egressDenied: { ipv4: true, ipv6: true, dns: true },
    observedAt: _time(w, 'workload')
  };
  return { admin, workload };
}

/**
 * The bound envelope for one or two measured breaches. Each breaching line's
 * boot and artifact identity must be readable, and two must agree, or the
 * result is unavailable rather than a guess.
 * @param {Array<[string, object, number]>} breaches - `[plane, doc, rc]` for each breaching plane
 * @param {object} binding - The sample's binding
 * @returns {object} `{schema, candidateSha, runId, manifestDigest, sampleSeq, bootId, facts, observedAt}`
 */
function _breachEnvelope(breaches, binding) {
  const ids = breaches.map(([plane, doc]) => ({ plane, fact: doc.breach.fact, ..._identity(doc, plane), at: _time(doc, plane) }));
  if (new Set(ids.map((i) => i.bootId)).size !== 1 || new Set(ids.map((i) => i.artifacts)).size !== 1) {
    _refuse('SPLIT', 'the two breaching planes report different boots or artifacts');
  }
  return {
    schema: BREACH_SCHEMA,
    ...binding,
    bootId: ids[0].bootId,
    facts: ids.map(({ plane, fact }) => ({ plane, fact })),
    observedAt: Math.min(...ids.map((i) => i.at))
  };
}

/**
 * The command-line entry `guest-setup.sh --verify-network` calls: the two
 * raw lines and the four binding values, in that order. Prints exactly one
 * JSON line and exits 0, or prints the refusal to stderr and exits 3 with
 * nothing on stdout.
 * @param {string[]} args - `[adminText, adminStatus, workloadText, workloadStatus, candidateSha, runId, manifestDigest, sampleSeq]`
 * @param {{stdout: {write: Function}, stderr: {write: Function}}} io - Streams
 * @returns {number} Exit code
 */
function main(args, io) {
  if (!Array.isArray(args) || args.length !== 8) {
    io.stderr.write('attest-bridge: expected exactly eight arguments\n');
    return 3;
  }
  try {
    const [adminText, adminStatus, workloadText, workloadStatus, candidateSha, runId, manifestDigest, sampleSeq] = args;
    const rc = (v) => (/^[0-9]{1,3}$/.test(v) ? Number(v) : -1);
    const pair = bridge(adminText, workloadText, { candidateSha, runId, manifestDigest, sampleSeq }, { admin: rc(adminStatus), workload: rc(workloadStatus) });
    io.stdout.write(`${JSON.stringify(pair)}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof BridgeError)) throw err;
    io.stderr.write(`attest-bridge refused (${err.code}): ${err.message}\n`);
    return 3;
  }
}

module.exports = { RAW_SCHEMA, ADMIN_SCHEMA, WORKLOAD_SCHEMA, BREACH_SCHEMA, BREACH_FACTS, BridgeError, parseBinding, bridge, main };
