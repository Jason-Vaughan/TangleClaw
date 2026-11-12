'use strict';

/**
 * v6.2 (#3004, V6-34 / R-MED-1, Car V62-W1-C): Medusa v2's opt-in compact
 * envelope, Merkle state-tree delta sync, priority-preserving cross-engine
 * wake coalescer, and their idempotent SQLite persistence.
 *
 * Four parts, each the TangleClaw-side core of a Medusa-PRR Part III
 * prototype (`prototypes/Medusa-PRR/v6-part3-*.md`):
 *
 * 1. **Compact envelope (`m2`)** — Phase 1's exact seven-field wire shape
 *    (`msg_type, task_id, state_delta, artifact_ref, blocker_code,
 *    next_action, digest`), its JSON Schema bounds, a content-addressed
 *    artifact reference, and a deterministic human card that round-trips
 *    losslessly (Phase 3's projection contract). Strictly opt-in:
 *    {@link negotiateWire} picks `m2` only when the peer advertises
 *    `medusa-compact-v1`, and prose stays the fallback. A digest proves the
 *    envelope was not altered, never that its content is true.
 * 2. **Merkle state tree and delta sync** — Phase 3's graph commitment and
 *    base discipline: a delta applies only on the exact base root it names,
 *    must land on the exact target root, and a missing intermediate delta is
 *    repaired only by a full frame whose own root matches the expected one.
 *    Nothing here advances state on a mismatch.
 * 3. **Wake coalescer** — Phase 5's contract: completions coalesce per
 *    (fleet, wave, recipient) into at most one wake per sealed wave; a late
 *    completion is refused (`WAVE_SEALED`) so the caller opens a new wave,
 *    never silently joining a sent wake; no completion is ever dropped; and
 *    a wake carries the highest priority of what it coalesced, so an urgent
 *    or blocking signal is never demoted by the routine events beside it.
 * 4. **Persistence** — Phase 6's tables under a `v6_medusa_v2_` prefix,
 *    created idempotently by {@link ensureSchema} (this car may not edit
 *    `lib/store/_schema.js`). Every write is one `BEGIN IMMEDIATE`
 *    transaction; a repeated message or wake ID is accepted only when it
 *    matches what was stored (`IDEMPOTENCY_CONFLICT` / `WAKE_CONFLICT`
 *    otherwise); bodies are stored once per SHA-256 with a reference count;
 *    every read re-verifies the body digest and envelope digest. A wake is
 *    marked drained only with a composer/transcript proof, which this module
 *    checks for shape but cannot verify against a real terminal — only a
 *    trusted pane adapter may supply it.
 *
 * Not here: the v2 HTTP/SSE router and scoped inter-fleet ACL (Phase 4),
 * which belong to the Medusa hub and need a verified principal resolver, and
 * any wiring into TangleClaw's routes or shell (a later car).
 *
 * @module lib/v6/medusa-v2-compact-sync
 */

const crypto = require('node:crypto');

/** The wire capability a peer advertises to opt in to `m2` envelopes. */
const CAPABILITY = 'medusa-compact-v1';

/** Envelope `msg_type` values (Phase 1 schema). */
const MSG_TYPES = Object.freeze(['dispatch', 'ack', 'gate', 'wake', 'update']);

/** Wake priorities, most urgent first. A wake takes the most urgent of its completions. */
const PRIORITIES = Object.freeze(['p0', 'blocker', 'urgent', 'normal']);

const SHA256_RE = /^[a-f0-9]{64}$/;
const ANCHOR_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NODE_ID_RE = /^[A-Za-z0-9._:#-]{1,128}$/;
const ENVELOPE_KEYS = ['msg_type', 'task_id', 'state_delta', 'artifact_ref', 'blocker_code', 'next_action', 'digest'];
const STATE_DELTA_KEYS = ['car', 'gate', 'check', 'transition', 'summary', 'edges_add', 'edges_remove'];
const CARD_HEADER = 'MEDUSA-M2-CARD v1';
const CARD_FIELDS = ['msg_type', 'task_id', 'blocker_code', 'next_action', 'state_delta', 'artifact_ref', 'digest', 'artifact_text'];

/** A refusal carrying a stable code. */
class MedusaV2Error extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function _fail(code, message) {
  throw new MedusaV2Error(code, message);
}

/**
 * SHA-256 hex of a string or buffer.
 * @param {string|Buffer|Uint8Array} data
 * @returns {string}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Canonical JSON: object keys sorted at every depth, no whitespace. Refuses
 * anything JSON cannot state exactly (`undefined`, functions, symbols,
 * bigints, non-finite numbers, non-plain objects), so two parties hashing
 * the same value always hash the same bytes.
 * @param {*} value
 * @returns {string}
 * @throws {MedusaV2Error} `NON_CANONICAL`
 */
function canonicalJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value)) _fail('NON_CANONICAL', 'non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) _fail('NON_CANONICAL', 'non-plain object');
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return _fail('NON_CANONICAL', `${t} is not JSON`);
}

// ── Opt-in negotiation ───────────────────────────────────────────────────

/**
 * The wire format to use with a peer: `m2` only when the peer advertises
 * {@link CAPABILITY}, otherwise `prose`. Opt-in by construction — an absent,
 * empty or malformed capability list means prose.
 * @param {*} peerCapabilities
 * @returns {'m2'|'prose'}
 */
function negotiateWire(peerCapabilities) {
  return Array.isArray(peerCapabilities) && peerCapabilities.includes(CAPABILITY) ? 'm2' : 'prose';
}

// ── Artifact references ──────────────────────────────────────────────────

/** Fails on any malformed UTF-8, so a range that splits a multi-byte character cannot decode to U+FFFD. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode `bytes[start, end)` as UTF-8, refusing a range that starts or ends
 * inside a multi-byte character instead of silently substituting U+FFFD.
 * @param {Buffer} bytes
 * @param {number} start
 * @param {number} end
 * @returns {string}
 * @throws {MedusaV2Error} `REF_INVALID`
 */
function _decodeRange(bytes, start, end) {
  try {
    return STRICT_UTF8.decode(bytes.subarray(start, end));
  } catch (err) {
    if (err instanceof TypeError) _fail('REF_INVALID', 'byteRange splits a multi-byte UTF-8 character');
    throw err;
  }
}

/**
 * A content-addressed reference to a byte range of an artifact (Phase 1):
 * `uri` and `sha256` name the WHOLE artifact; `byteRange` is a half-open
 * UTF-8 interval within it; `sectionAnchor` is a stable UI label.
 * @param {string|Buffer} artifact
 * @param {{start?: number, end?: number, anchor: string}} where
 * @returns {{uri: string, sha256: string, byteRange: [number, number], sectionAnchor: string}}
 * @throws {MedusaV2Error} `REF_INVALID`
 */
function artifactRef(artifact, { start = 0, end, anchor } = {}) {
  const bytes = Buffer.isBuffer(artifact) ? artifact : Buffer.from(String(artifact), 'utf8');
  const stop = end === undefined ? bytes.length : end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || start < 0 || stop < start || stop > bytes.length) {
    _fail('REF_INVALID', 'byteRange must be a half-open interval within the artifact');
  }
  if (typeof anchor !== 'string' || !ANCHOR_RE.test(anchor)) _fail('REF_INVALID', 'sectionAnchor must be 1-128 of A-Z a-z 0-9 . _ -');
  _decodeRange(bytes, start, stop);
  const hash = sha256(bytes);
  return { uri: `artifact://sha256/${hash}`, sha256: hash, byteRange: [start, stop], sectionAnchor: anchor };
}

/**
 * Resolve a reference to the exact text it names. The fetched artifact's
 * full digest must match before the range is sliced; a missing or corrupt
 * artifact is a visible error, never a substituted summary.
 * @param {object} ref
 * @param {(sha256: string) => (string|Buffer|null|undefined)} fetchArtifact
 * @returns {string}
 * @throws {MedusaV2Error} `REF_INVALID`, `ARTIFACT_MISSING`, `ARTIFACT_CORRUPT`
 */
function resolveArtifact(ref, fetchArtifact) {
  _checkRef(ref);
  const got = fetchArtifact(ref.sha256);
  if (got === null || got === undefined) _fail('ARTIFACT_MISSING', `artifact ${ref.sha256} is not available`);
  const bytes = Buffer.isBuffer(got) ? got : Buffer.from(String(got), 'utf8');
  if (sha256(bytes) !== ref.sha256) _fail('ARTIFACT_CORRUPT', `artifact ${ref.sha256} does not match its digest`);
  if (ref.byteRange[1] > bytes.length) _fail('REF_INVALID', 'byteRange lies outside the artifact');
  return _decodeRange(bytes, ref.byteRange[0], ref.byteRange[1]);
}

/**
 * @param {*} ref
 * @returns {void}
 * @throws {MedusaV2Error} `REF_INVALID`
 */
function _checkRef(ref) {
  const ok = ref && typeof ref === 'object' && !Array.isArray(ref)
    && Object.keys(ref).sort().join(',') === 'byteRange,sectionAnchor,sha256,uri'
    && typeof ref.sha256 === 'string' && SHA256_RE.test(ref.sha256)
    && ref.uri === `artifact://sha256/${ref.sha256}`
    && Array.isArray(ref.byteRange) && ref.byteRange.length === 2
    && ref.byteRange.every((n) => Number.isSafeInteger(n) && n >= 0) && ref.byteRange[0] <= ref.byteRange[1]
    && typeof ref.sectionAnchor === 'string' && ANCHOR_RE.test(ref.sectionAnchor);
  if (!ok) _fail('REF_INVALID', 'artifact_ref does not match the artifact reference schema');
}

// ── Compact envelope (m2) ────────────────────────────────────────────────

/**
 * @param {*} v
 * @param {number} max
 * @returns {boolean}
 */
function _nullableString(v, max) {
  return v === null || (typeof v === 'string' && v.length <= max);
}

/**
 * Validate a `state_delta` against the Phase 1 schema bounds.
 * @param {*} d
 * @returns {void}
 * @throws {MedusaV2Error} `ENVELOPE_INVALID`
 */
function _checkStateDelta(d) {
  const bad = (why) => _fail('ENVELOPE_INVALID', `state_delta: ${why}`);
  if (!d || typeof d !== 'object' || Array.isArray(d)) bad('must be an object');
  for (const k of Object.keys(d)) if (!STATE_DELTA_KEYS.includes(k)) bad(`unknown field ${k}`);
  for (const k of ['car', 'gate', 'check']) if (k in d && !_nullableString(d[k], 128)) bad(`${k} must be a string of at most 128 or null`);
  if ('summary' in d && !(typeof d.summary === 'string' && d.summary.length <= 256)) bad('summary must be a string of at most 256');
  if ('transition' in d) {
    const tr = d.transition;
    if (!tr || typeof tr !== 'object' || Array.isArray(tr) || Object.keys(tr).sort().join(',') !== 'from,to'
      || !(tr.from === null || typeof tr.from === 'string') || typeof tr.to !== 'string' || tr.to.length === 0) {
      bad('transition must be {from: string|null, to: non-empty string}');
    }
  }
  for (const k of ['edges_add', 'edges_remove']) {
    if (!(k in d)) continue;
    const edges = d[k];
    if (!Array.isArray(edges) || edges.length > 256) bad(`${k} must be an array of at most 256 edges`);
    const seen = new Set();
    for (const e of edges) {
      const okEdge = e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).sort().join(',') === 'from,rel,to'
        && typeof e.from === 'string' && e.from.length >= 1 && e.from.length <= 128
        && typeof e.rel === 'string' && e.rel.length >= 1 && e.rel.length <= 64
        && typeof e.to === 'string' && e.to.length >= 1 && e.to.length <= 128;
      if (!okEdge) bad(`${k} holds an edge that is not {from, rel, to} within bounds`);
      const key = canonicalJson(e);
      if (seen.has(key)) bad(`${k} repeats an edge`);
      seen.add(key);
    }
  }
}

/**
 * Validate an envelope's six content fields (everything but `digest`).
 * @param {object} f
 * @returns {void}
 * @throws {MedusaV2Error} `ENVELOPE_INVALID`, `REF_INVALID`
 */
function _checkContent(f) {
  if (!MSG_TYPES.includes(f.msg_type)) _fail('ENVELOPE_INVALID', `msg_type must be one of ${MSG_TYPES.join(', ')}`);
  if (!_nullableString(f.task_id, 128)) _fail('ENVELOPE_INVALID', 'task_id must be a string of at most 128 or null');
  if (!_nullableString(f.blocker_code, 40)) _fail('ENVELOPE_INVALID', 'blocker_code must be a string of at most 40 or null');
  if (!_nullableString(f.next_action, 256)) _fail('ENVELOPE_INVALID', 'next_action must be a string of at most 256 or null');
  _checkStateDelta(f.state_delta);
  if (f.artifact_ref !== null) _checkRef(f.artifact_ref);
}

/**
 * The digest of an envelope: SHA-256 of the canonical JSON of its six
 * content fields.
 * @param {object} f
 * @returns {string}
 */
function _envelopeDigest(f) {
  const { msg_type, task_id, state_delta, artifact_ref, blocker_code, next_action } = f;
  return sha256(canonicalJson({ msg_type, task_id, state_delta, artifact_ref, blocker_code, next_action }));
}

/**
 * Build a compact `m2` envelope. Optional fields default to `null` (and
 * `state_delta` to `{}`), so a state-only notice needs no artifact.
 * @param {{msg_type: string, task_id?: string|null, state_delta?: object, artifact_ref?: object|null,
 *   blocker_code?: string|null, next_action?: string|null}} fields
 * @returns {object} The seven-field envelope, digest included.
 * @throws {MedusaV2Error}
 */
function createEnvelope(fields) {
  const f = {
    msg_type: fields && fields.msg_type,
    task_id: fields && fields.task_id !== undefined ? fields.task_id : null,
    state_delta: fields && fields.state_delta !== undefined ? fields.state_delta : {},
    artifact_ref: fields && fields.artifact_ref !== undefined ? fields.artifact_ref : null,
    blocker_code: fields && fields.blocker_code !== undefined ? fields.blocker_code : null,
    next_action: fields && fields.next_action !== undefined ? fields.next_action : null
  };
  _checkContent(f);
  return { ...f, digest: _envelopeDigest(f) };
}

/**
 * Verify an envelope's shape and digest. A valid digest proves the
 * envelope is unaltered, not that its content is correct.
 * @param {*} env
 * @returns {object} The envelope, unchanged.
 * @throws {MedusaV2Error} `ENVELOPE_INVALID`, `REF_INVALID`, `DIGEST_MISMATCH`
 */
function verifyEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).sort().join(',') !== [...ENVELOPE_KEYS].sort().join(',')) {
    _fail('ENVELOPE_INVALID', `an envelope has exactly ${ENVELOPE_KEYS.join(', ')}`);
  }
  _checkContent(env);
  if (typeof env.digest !== 'string' || !SHA256_RE.test(env.digest)) _fail('ENVELOPE_INVALID', 'digest must be SHA-256 hex');
  if (_envelopeDigest(env) !== env.digest) _fail('DIGEST_MISMATCH', 'the envelope does not match its digest');
  return env;
}

// ── Human-readable projection (lossless) ─────────────────────────────────

/**
 * Project an envelope into a deterministic human card: a fixed header, then
 * one `field: <canonical JSON>` line per field in fixed order. When the
 * envelope references an artifact, the card carries the exact referenced
 * text, resolved and digest-checked; a missing or corrupt artifact refuses,
 * so a card never shows text that was not verified.
 * @param {object} env
 * @param {(sha256: string) => (string|Buffer|null|undefined)} [fetchArtifact]
 * @returns {string}
 * @throws {MedusaV2Error}
 */
function projectCard(env, fetchArtifact) {
  verifyEnvelope(env);
  let text = null;
  if (env.artifact_ref !== null) {
    if (typeof fetchArtifact !== 'function') _fail('ARTIFACT_MISSING', 'a card for a referencing envelope needs the artifact');
    text = resolveArtifact(env.artifact_ref, fetchArtifact);
  }
  const values = { ...env, artifact_text: text };
  return [CARD_HEADER, ...CARD_FIELDS.map((k) => `${k}: ${canonicalJson(values[k])}`)].join('\n');
}

/**
 * Parse a card back into its envelope and artifact text. Strict: the header,
 * field set and order, and the canonical form of every value must be
 * exactly what {@link projectCard} writes, and the parsed envelope must
 * verify. JSON-escaped values mean a newline in source text cannot forge a
 * field line.
 *
 * `artifact_text` lies outside the envelope digest, so a card that carries
 * one is trusted only after it is re-resolved from the artifact itself:
 * a referencing card needs `fetchArtifact` (`ARTIFACT_MISSING` without it),
 * and text that differs from the verified range is `CARD_TAMPERED`.
 * @param {string} card
 * @param {(sha256: string) => (string|Buffer|null|undefined)} [fetchArtifact]
 * @returns {{envelope: object, artifactText: string|null}}
 * @throws {MedusaV2Error} `CARD_INVALID`, `CARD_TAMPERED`, `ARTIFACT_MISSING`, or an envelope error
 */
function parseCard(card, fetchArtifact) {
  const lines = String(card).split('\n');
  if (lines[0] !== CARD_HEADER || lines.length !== CARD_FIELDS.length + 1) _fail('CARD_INVALID', 'not a v1 card');
  const values = {};
  CARD_FIELDS.forEach((k, i) => {
    const line = lines[i + 1];
    const prefix = `${k}: `;
    if (!line.startsWith(prefix)) _fail('CARD_INVALID', `line ${i + 2} must be ${k}`);
    const raw = line.slice(prefix.length);
    let v;
    try {
      v = JSON.parse(raw);
    } catch (err) {
      _fail('CARD_INVALID', `${k} is not JSON: ${err.message}`);
    }
    if (canonicalJson(v) !== raw) _fail('CARD_INVALID', `${k} is not in canonical form`);
    values[k] = v;
  });
  const envelope = {};
  for (const k of ENVELOPE_KEYS) envelope[k] = values[k];
  verifyEnvelope(envelope);
  if (envelope.artifact_ref === null ? values.artifact_text !== null : typeof values.artifact_text !== 'string') {
    _fail('CARD_INVALID', 'artifact_text must be present exactly when artifact_ref is');
  }
  if (envelope.artifact_ref !== null) {
    if (typeof fetchArtifact !== 'function') _fail('ARTIFACT_MISSING', 'verifying a referencing card needs the artifact');
    if (resolveArtifact(envelope.artifact_ref, fetchArtifact) !== values.artifact_text) {
      _fail('CARD_TAMPERED', 'artifact_text does not match the referenced artifact');
    }
  }
  return { envelope, artifactText: values.artifact_text };
}

// ── Merkle state tree and delta sync ─────────────────────────────────────

/**
 * Validate a state graph: `{nodes: {id: {label, edges: [childId…]}}, roots: [id…]}`.
 * Node IDs are restricted, edges and roots must resolve, duplicates and
 * cycles are refused. Edge order is meaningful and is committed to.
 * @param {*} graph
 * @returns {void}
 * @throws {MedusaV2Error} `GRAPH_INVALID`
 */
function validateGraph(graph) {
  const bad = (why) => _fail('GRAPH_INVALID', why);
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || Object.keys(graph).sort().join(',') !== 'nodes,roots') {
    bad('a graph is exactly {nodes, roots}');
  }
  const { nodes, roots } = graph;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) bad('nodes must be an object');
  const ids = Object.keys(nodes);
  for (const id of ids) {
    if (!NODE_ID_RE.test(id)) bad(`node id ${JSON.stringify(id)} is not allowed`);
    const n = nodes[id];
    if (!n || typeof n !== 'object' || Array.isArray(n) || Object.keys(n).sort().join(',') !== 'edges,label') bad(`node ${id} is exactly {label, edges}`);
    if (typeof n.label !== 'string' || n.label.length > 1024) bad(`node ${id} label must be a string of at most 1024`);
    if (!Array.isArray(n.edges)) bad(`node ${id} edges must be an array`);
    if (new Set(n.edges).size !== n.edges.length) bad(`node ${id} repeats an edge`);
    for (const to of n.edges) if (typeof to !== 'string' || !(to in nodes)) bad(`node ${id} has an edge to unknown node ${JSON.stringify(to)}`);
  }
  if (!Array.isArray(roots) || new Set(roots).size !== roots.length) bad('roots must be an array without repeats');
  for (const r of roots) if (typeof r !== 'string' || !(r in nodes)) bad(`root ${JSON.stringify(r)} is not a node`);
  // Cycle check: iterative three-colour DFS.
  const colour = new Map();
  for (const start of ids) {
    if (colour.get(start)) continue;
    const stack = [[start, 0]];
    colour.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = nodes[top[0]].edges;
      if (top[1] >= edges.length) {
        colour.set(top[0], 2);
        stack.pop();
        continue;
      }
      const next = edges[top[1]++];
      const c = colour.get(next);
      if (c === 1) bad(`cycle through ${next}`);
      if (!c) {
        colour.set(next, 1);
        stack.push([next, 0]);
      }
    }
  }
}

/**
 * The Merkle root of a graph. Each node's hash commits to its ID, label and
 * its children's hashes in edge order; the root commits to every node's hash
 * (unreachable ones included) and the ordered roots.
 * @param {object} graph
 * @returns {string}
 * @throws {MedusaV2Error} `GRAPH_INVALID`
 */
function merkleRoot(graph) {
  validateGraph(graph);
  const memo = new Map();
  const hashOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    const n = graph.nodes[id];
    const h = sha256(canonicalJson({ id, label: n.label, children: n.edges.map(hashOf) }));
    memo.set(id, h);
    return h;
  };
  const nodeHashes = {};
  for (const id of Object.keys(graph.nodes).sort()) nodeHashes[id] = hashOf(id);
  return sha256(canonicalJson({ nodes: nodeHashes, roots: graph.roots }));
}

/**
 * The delta that turns `base` into `target`: `put` for every added or
 * changed node, `del` for every removed one, and the target's roots, bound
 * to both Merkle roots.
 * @param {object} base
 * @param {object} target
 * @returns {{baseHash: string, targetHash: string, ops: Array<object>, roots: string[]}}
 */
function diffGraphs(base, target) {
  const baseHash = merkleRoot(base);
  const targetHash = merkleRoot(target);
  const ops = [];
  for (const id of Object.keys(target.nodes).sort()) {
    const t = target.nodes[id];
    const b = base.nodes[id];
    if (!b || canonicalJson(b) !== canonicalJson(t)) ops.push({ op: 'put', id, label: t.label, edges: [...t.edges] });
  }
  for (const id of Object.keys(base.nodes).sort()) if (!(id in target.nodes)) ops.push({ op: 'del', id });
  return { baseHash, targetHash, ops, roots: [...target.roots] };
}

/**
 * Apply a delta. Refuses unless the current root is exactly the delta's
 * base (`BASE_MISMATCH`, e.g. a missed intermediate delta), and unless the
 * result is a valid graph whose root is exactly the delta's target
 * (`TARGET_MISMATCH`). Never mutates `graph`.
 * @param {object} graph
 * @param {*} delta
 * @returns {object} The new graph.
 * @throws {MedusaV2Error} `DELTA_INVALID`, `BASE_MISMATCH`, `TARGET_MISMATCH`, `GRAPH_INVALID`
 */
function applyDelta(graph, delta) {
  if (!delta || typeof delta !== 'object' || !SHA256_RE.test(delta.baseHash || '') || !SHA256_RE.test(delta.targetHash || '')
    || !Array.isArray(delta.ops) || !Array.isArray(delta.roots)) {
    _fail('DELTA_INVALID', 'a delta is {baseHash, targetHash, ops, roots}');
  }
  if (merkleRoot(graph) !== delta.baseHash) _fail('BASE_MISMATCH', 'the current state is not this delta\'s base');
  const nodes = JSON.parse(JSON.stringify(graph.nodes));
  for (const op of delta.ops) {
    if (op && op.op === 'put' && typeof op.id === 'string') nodes[op.id] = { label: op.label, edges: Array.isArray(op.edges) ? [...op.edges] : op.edges };
    else if (op && op.op === 'del' && typeof op.id === 'string' && op.id in nodes) delete nodes[op.id];
    else _fail('DELTA_INVALID', `unreadable op ${JSON.stringify(op)}`);
  }
  const next = { nodes, roots: [...delta.roots] };
  if (merkleRoot(next) !== delta.targetHash) _fail('TARGET_MISMATCH', 'the delta does not produce its stated target');
  return next;
}

/**
 * Recover from a refused delta with a full frame: the frame's own graph must
 * hash to the root the recipient expects, else nothing changes.
 * @param {{graph: object}} frame
 * @param {string} expectedHash
 * @returns {object} The recovered graph.
 * @throws {MedusaV2Error} `FULL_FRAME_MISMATCH`, `GRAPH_INVALID`
 */
function recoverFromFullFrame(frame, expectedHash) {
  const graph = frame && frame.graph;
  if (merkleRoot(graph) !== expectedHash) _fail('FULL_FRAME_MISMATCH', 'the full frame does not match the expected root');
  return JSON.parse(JSON.stringify(graph));
}

// ── Wake coalescer ───────────────────────────────────────────────────────

/**
 * @param {string} label
 * @param {*} v
 * @returns {string}
 * @throws {MedusaV2Error} `WAKE_INVALID`
 */
function _id(label, v) {
  if (typeof v !== 'string' || !NODE_ID_RE.test(v)) _fail('WAKE_INVALID', `${label} must be 1-128 of A-Z a-z 0-9 . _ : # -`);
  return v;
}

/**
 * The stable wake ID for one recipient in one sealed wave.
 * @param {string} fleetId
 * @param {string} waveId
 * @param {string} recipient
 * @returns {string}
 */
function wakeIdFor(fleetId, waveId, recipient) {
  return `wake-${sha256(canonicalJson([fleetId, waveId, recipient])).slice(0, 32)}`;
}

/**
 * Create an in-memory wake coalescer. Completions are grouped per
 * (fleet, wave, recipient); a wave must be sealed before it flushes; a
 * completion for a sealed wave is refused so the caller retries in a new
 * wave. The same completion ID twice is idempotent; the same ID with
 * different content is `IDEMPOTENCY_CONFLICT`.
 * @returns {{ingest: Function, seal: Function, flush: Function}}
 */
function createWakeCoalescer() {
  const waves = new Map(); // `${fleet}\u0000${wave}` -> {sealed, flushed, byRecipient: Map<recipient, Map<completionId, priority>>}
  const seen = new Map(); // completionId -> canonical content

  const waveOf = (fleetId, waveId) => {
    const key = `${fleetId}\u0000${waveId}`;
    if (!waves.has(key)) waves.set(key, { sealed: false, flushed: false, byRecipient: new Map() });
    return waves.get(key);
  };

  return {
    /**
     * Add one completion.
     * @param {{completionId: string, fleetId: string, waveId: string, recipient: string, priority?: string}} c
     * @returns {{ok: true, duplicate: boolean}}
     * @throws {MedusaV2Error} `WAKE_INVALID`, `WAVE_SEALED`, `IDEMPOTENCY_CONFLICT`
     */
    ingest(c) {
      const completionId = _id('completionId', c && c.completionId);
      const fleetId = _id('fleetId', c.fleetId);
      const waveId = _id('waveId', c.waveId);
      const recipient = _id('recipient', c.recipient);
      const priority = c.priority === undefined ? 'normal' : c.priority;
      if (!PRIORITIES.includes(priority)) _fail('WAKE_INVALID', `priority must be one of ${PRIORITIES.join(', ')}`);
      const content = canonicalJson({ fleetId, waveId, recipient, priority });
      if (seen.has(completionId)) {
        if (seen.get(completionId) !== content) _fail('IDEMPOTENCY_CONFLICT', `completion ${completionId} was already ingested with different content`);
        return { ok: true, duplicate: true };
      }
      const wave = waveOf(fleetId, waveId);
      if (wave.sealed) _fail('WAVE_SEALED', `wave ${waveId} is sealed; open a new wave for ${completionId}`);
      if (!wave.byRecipient.has(recipient)) wave.byRecipient.set(recipient, new Map());
      wave.byRecipient.get(recipient).set(completionId, priority);
      seen.set(completionId, content);
      return { ok: true, duplicate: false };
    },

    /**
     * Seal a wave: no completion may join it afterwards.
     * @param {string} fleetId
     * @param {string} waveId
     * @returns {void}
     */
    seal(fleetId, waveId) {
      waveOf(_id('fleetId', fleetId), _id('waveId', waveId)).sealed = true;
    },

    /**
     * Emit the sealed wave's wakes, once: one per recipient, carrying every
     * completion ID it coalesced and the most urgent of their priorities,
     * ordered most urgent first, then by recipient.
     * @param {string} fleetId
     * @param {string} waveId
     * @returns {Array<{wakeId: string, fleetId: string, waveId: string, recipient: string, priority: string, completionIds: string[]}>}
     * @throws {MedusaV2Error} `WAVE_NOT_SEALED`, `WAVE_FLUSHED`
     */
    flush(fleetId, waveId) {
      const wave = waveOf(_id('fleetId', fleetId), _id('waveId', waveId));
      if (!wave.sealed) _fail('WAVE_NOT_SEALED', `seal wave ${waveId} before flushing it`);
      if (wave.flushed) _fail('WAVE_FLUSHED', `wave ${waveId} was already flushed`);
      wave.flushed = true;
      const wakes = [...wave.byRecipient.entries()].map(([recipient, completions]) => {
        const priority = PRIORITIES.find((p) => [...completions.values()].includes(p));
        return { wakeId: wakeIdFor(fleetId, waveId, recipient), fleetId, waveId, recipient, priority, completionIds: [...completions.keys()].sort() };
      });
      return wakes.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.recipient.localeCompare(b.recipient));
    }
  };
}

// ── SQLite persistence ───────────────────────────────────────────────────

/**
 * Create this module's tables if they do not exist. Idempotent; safe on
 * every start.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v6_medusa_v2_blobs (
      hash      TEXT PRIMARY KEY CHECK (length(hash) = 64),
      bytes     BLOB NOT NULL,
      ref_count INTEGER NOT NULL CHECK (ref_count >= 0)
    );
    CREATE TABLE IF NOT EXISTS v6_medusa_v2_messages (
      id         TEXT PRIMARY KEY,
      sender     TEXT NOT NULL,
      recipient  TEXT NOT NULL,
      envelope   TEXT NOT NULL,
      blob_hash  TEXT REFERENCES v6_medusa_v2_blobs(hash),
      state_hash TEXT,
      created_at TEXT NOT NULL,
      acked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS v6_medusa_v2_messages_inbox ON v6_medusa_v2_messages (recipient, acked_at, created_at);
    CREATE TABLE IF NOT EXISTS v6_medusa_v2_snapshots (
      hash  TEXT PRIMARY KEY CHECK (length(hash) = 64),
      graph TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v6_medusa_v2_deltas (
      base_hash   TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      delta       TEXT NOT NULL,
      PRIMARY KEY (base_hash, target_hash)
    );
    CREATE TABLE IF NOT EXISTS v6_medusa_v2_wakes (
      id             TEXT PRIMARY KEY,
      fleet_id       TEXT NOT NULL,
      wave_id        TEXT NOT NULL,
      recipient      TEXT NOT NULL,
      priority       TEXT NOT NULL CHECK (priority IN ('p0','blocker','urgent','normal')),
      completion_ids TEXT NOT NULL,
      state          TEXT NOT NULL CHECK (state IN ('pending','drained','uncertain')),
      proof          TEXT,
      note           TEXT,
      created_at     TEXT NOT NULL,
      settled_at     TEXT
    );
  `);
}

/**
 * Run `fn` inside one `BEGIN IMMEDIATE` transaction, rolling back on a throw.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
function _tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) { // prawduct:allow prawduct/broad-except -- rethrown after rollback; nothing is swallowed
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Store one message: its verified envelope and, when it references an
 * artifact, the artifact bytes once per digest (reference-counted). A
 * repeated ID is accepted only when sender, recipient, envelope and state
 * hash all match; any difference is `IDEMPOTENCY_CONFLICT` (Phase 6's code).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, sender: string, recipient: string, envelope: object, artifact?: string|Buffer,
 *   stateHash?: string|null, now?: () => string}} msg
 * @returns {{ok: true, duplicate: boolean}}
 * @throws {MedusaV2Error} `MESSAGE_INVALID`, `IDEMPOTENCY_CONFLICT`, `ARTIFACT_CORRUPT`, or an envelope error
 */
function recordMessage(db, { id, sender, recipient, envelope, artifact, stateHash = null, now = () => new Date().toISOString() }) {
  for (const [k, v] of [['id', id], ['sender', sender], ['recipient', recipient]]) {
    if (typeof v !== 'string' || !NODE_ID_RE.test(v)) _fail('MESSAGE_INVALID', `${k} must be 1-128 of A-Z a-z 0-9 . _ : # -`);
  }
  if (stateHash !== null && !SHA256_RE.test(String(stateHash))) _fail('MESSAGE_INVALID', 'stateHash must be SHA-256 hex or null');
  verifyEnvelope(envelope);
  const ref = envelope.artifact_ref;
  let bytes = null;
  if (ref !== null) {
    if (artifact === undefined || artifact === null) _fail('MESSAGE_INVALID', 'a referencing envelope needs its artifact');
    bytes = Buffer.isBuffer(artifact) ? artifact : Buffer.from(String(artifact), 'utf8');
    if (sha256(bytes) !== ref.sha256) _fail('ARTIFACT_CORRUPT', 'the artifact does not match the envelope reference');
  }
  const envelopeJson = canonicalJson(envelope);
  return _tx(db, () => {
    const existing = db.prepare('SELECT sender, recipient, envelope, state_hash FROM v6_medusa_v2_messages WHERE id = ?').get(id);
    if (existing) {
      if (existing.sender !== sender || existing.recipient !== recipient || existing.envelope !== envelopeJson
        || existing.state_hash !== stateHash) {
        _fail('IDEMPOTENCY_CONFLICT', `message ${id} already exists with different content`);
      }
      return { ok: true, duplicate: true };
    }
    if (bytes) {
      const blob = db.prepare('SELECT ref_count FROM v6_medusa_v2_blobs WHERE hash = ?').get(ref.sha256);
      if (blob) db.prepare('UPDATE v6_medusa_v2_blobs SET ref_count = ref_count + 1 WHERE hash = ?').run(ref.sha256);
      else db.prepare('INSERT INTO v6_medusa_v2_blobs (hash, bytes, ref_count) VALUES (?, ?, 1)').run(ref.sha256, bytes);
    }
    db.prepare(`INSERT INTO v6_medusa_v2_messages (id, sender, recipient, envelope, blob_hash, state_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, sender, recipient, envelopeJson, ref ? ref.sha256 : null, stateHash, now());
    return { ok: true, duplicate: false };
  });
}

/**
 * Read one message back, re-verifying its envelope digest and, when it
 * references an artifact, the stored bytes' digest before returning the
 * exact referenced text.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {{id: string, sender: string, recipient: string, envelope: object, artifactText: string|null,
 *   stateHash: string|null, createdAt: string, ackedAt: string|null}|null} Null when absent.
 * @throws {MedusaV2Error} `DIGEST_MISMATCH`, `ARTIFACT_CORRUPT`, `ARTIFACT_MISSING`
 */
function readMessage(db, id) {
  const row = db.prepare('SELECT * FROM v6_medusa_v2_messages WHERE id = ?').get(id);
  if (!row) return null;
  const envelope = verifyEnvelope(JSON.parse(row.envelope));
  let artifactText = null;
  if (envelope.artifact_ref !== null) {
    artifactText = resolveArtifact(envelope.artifact_ref, (hash) => {
      const blob = db.prepare('SELECT bytes FROM v6_medusa_v2_blobs WHERE hash = ?').get(hash);
      return blob ? Buffer.from(blob.bytes) : null;
    });
  }
  return {
    id: row.id, sender: row.sender, recipient: row.recipient, envelope, artifactText,
    stateHash: row.state_hash, createdAt: row.created_at, ackedAt: row.acked_at
  };
}

/**
 * A recipient's unacknowledged message IDs, oldest first — the replay list
 * after a reconnect or restart.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} recipient
 * @returns {string[]}
 */
function inbox(db, recipient) {
  return db.prepare('SELECT id FROM v6_medusa_v2_messages WHERE recipient = ? AND acked_at IS NULL ORDER BY created_at, id')
    .all(recipient).map((r) => r.id);
}

/**
 * Acknowledge a message, only by its own recipient. Acknowledging twice is
 * idempotent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @param {string} recipient
 * @param {{now?: () => string}} [opts]
 * @returns {{ok: boolean, code: string}}
 */
function ackMessage(db, id, recipient, { now = () => new Date().toISOString() } = {}) {
  return _tx(db, () => {
    const row = db.prepare('SELECT recipient, acked_at FROM v6_medusa_v2_messages WHERE id = ?').get(id);
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    if (row.recipient !== recipient) return { ok: false, code: 'NOT_RECIPIENT' };
    if (row.acked_at) return { ok: true, code: 'ALREADY_ACKED' };
    db.prepare('UPDATE v6_medusa_v2_messages SET acked_at = ? WHERE id = ?').run(now(), id);
    return { ok: true, code: 'ACKED' };
  });
}

/**
 * Store a graph snapshot under its Merkle root. Idempotent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} graph
 * @returns {string} The root.
 */
function saveSnapshot(db, graph) {
  const hash = merkleRoot(graph);
  db.prepare('INSERT OR IGNORE INTO v6_medusa_v2_snapshots (hash, graph) VALUES (?, ?)').run(hash, canonicalJson(graph));
  return hash;
}

/**
 * Load a snapshot, re-verifying that it still hashes to its key.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} hash
 * @returns {object|null}
 * @throws {MedusaV2Error} `SNAPSHOT_CORRUPT`
 */
function loadSnapshot(db, hash) {
  const row = db.prepare('SELECT graph FROM v6_medusa_v2_snapshots WHERE hash = ?').get(hash);
  if (!row) return null;
  const graph = JSON.parse(row.graph);
  if (merkleRoot(graph) !== hash) _fail('SNAPSHOT_CORRUPT', `snapshot ${hash} no longer matches its root`);
  return graph;
}

/**
 * Store a delta once it is proven against the stored base: it must apply to
 * that base snapshot and produce its target, which is stored too. A delta
 * whose base is not stored is refused rather than kept unverifiable.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} delta
 * @returns {{ok: true, targetHash: string}}
 * @throws {MedusaV2Error} `BASE_UNKNOWN`, or an {@link applyDelta} error
 */
function saveDelta(db, delta) {
  return _tx(db, () => {
    const base = loadSnapshot(db, delta && delta.baseHash);
    if (!base) _fail('BASE_UNKNOWN', 'the delta\'s base snapshot is not stored');
    const target = applyDelta(base, delta);
    saveSnapshot(db, target);
    db.prepare('INSERT OR IGNORE INTO v6_medusa_v2_deltas (base_hash, target_hash, delta) VALUES (?, ?, ?)')
      .run(delta.baseHash, delta.targetHash, canonicalJson(delta));
    return { ok: true, targetHash: delta.targetHash };
  });
}

/**
 * Persist a coalesced wake as `pending` BEFORE any pane delivery is
 * attempted. Re-queuing the same wake ID is idempotent only when fleet,
 * wave, recipient, priority and completion IDs all match (`WAKE_CONFLICT`
 * otherwise).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{wakeId: string, fleetId: string, waveId: string, recipient: string, priority: string, completionIds: string[]}} wake
 * @param {{now?: () => string}} [opts]
 * @returns {{ok: true, duplicate: boolean}}
 * @throws {MedusaV2Error} `WAKE_INVALID`, `WAKE_CONFLICT`
 */
function queueWake(db, wake, { now = () => new Date().toISOString() } = {}) {
  const w = wake || {};
  for (const k of ['wakeId', 'fleetId', 'waveId', 'recipient']) _id(k, w[k]);
  if (!PRIORITIES.includes(w.priority)) _fail('WAKE_INVALID', `priority must be one of ${PRIORITIES.join(', ')}`);
  if (!Array.isArray(w.completionIds) || w.completionIds.length === 0) _fail('WAKE_INVALID', 'a wake carries at least one completion');
  w.completionIds.forEach((c) => _id('completionId', c));
  const ids = canonicalJson([...w.completionIds].sort());
  return _tx(db, () => {
    const row = db.prepare('SELECT fleet_id, wave_id, recipient, priority, completion_ids FROM v6_medusa_v2_wakes WHERE id = ?').get(w.wakeId);
    if (row) {
      if (row.fleet_id !== w.fleetId || row.wave_id !== w.waveId || row.recipient !== w.recipient
        || row.priority !== w.priority || row.completion_ids !== ids) {
        _fail('WAKE_CONFLICT', `wake ${w.wakeId} already exists with different content`);
      }
      return { ok: true, duplicate: true };
    }
    db.prepare(`INSERT INTO v6_medusa_v2_wakes (id, fleet_id, wave_id, recipient, priority, completion_ids, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(w.wakeId, w.fleetId, w.waveId, w.recipient, w.priority, ids, now());
    return { ok: true, duplicate: false };
  });
}

/**
 * Mark a pending wake drained, with the pane adapter's proof that the
 * composer emptied AND the wake appeared in the transcript. Without both
 * flags the wake stays pending (`PROOF_REQUIRED`). This module checks the
 * proof's shape only; the caller is the trusted pane adapter that observed it.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} wakeId
 * @param {{composerDrained: boolean, transcriptCommitted: boolean, marker: string}} proof
 * @param {{now?: () => string}} [opts]
 * @returns {{ok: boolean, code: string}}
 */
function drainWake(db, wakeId, proof, { now = () => new Date().toISOString() } = {}) {
  const ok = proof && proof.composerDrained === true && proof.transcriptCommitted === true
    && typeof proof.marker === 'string' && proof.marker.length > 0 && proof.marker.length <= 256;
  if (!ok) return { ok: false, code: 'PROOF_REQUIRED' };
  return _settleWake(db, wakeId, 'drained', canonicalJson(proof), null, now());
}

/**
 * Hold a wake as `uncertain` (e.g. Enter accepted but no transcript entry by
 * the poll deadline) for operator review; it is never retried automatically.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} wakeId
 * @param {string} reason
 * @param {{now?: () => string}} [opts]
 * @returns {{ok: boolean, code: string}}
 */
function markWakeUncertain(db, wakeId, reason, { now = () => new Date().toISOString() } = {}) {
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 512) return { ok: false, code: 'REASON_REQUIRED' };
  return _settleWake(db, wakeId, 'uncertain', null, reason, now());
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} wakeId
 * @param {'drained'|'uncertain'} state
 * @param {string|null} proof
 * @param {string|null} note
 * @param {string} at
 * @returns {{ok: boolean, code: string}}
 */
function _settleWake(db, wakeId, state, proof, note, at) {
  return _tx(db, () => {
    const row = db.prepare('SELECT state FROM v6_medusa_v2_wakes WHERE id = ?').get(wakeId);
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    if (row.state !== 'pending') return { ok: false, code: row.state === state ? `ALREADY_${state.toUpperCase()}` : 'NOT_PENDING' };
    db.prepare('UPDATE v6_medusa_v2_wakes SET state = ?, proof = ?, note = ?, settled_at = ? WHERE id = ?').run(state, proof, note, at, wakeId);
    return { ok: true, code: state.toUpperCase() };
  });
}

/**
 * Pending wakes to deliver or replay after a restart, most urgent first,
 * then oldest first. Uncertain wakes are not included: they await review.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [recipient]
 * @returns {Array<{wakeId: string, fleetId: string, waveId: string, recipient: string, priority: string, completionIds: string[]}>}
 */
function pendingWakes(db, recipient) {
  const rows = recipient === undefined
    ? db.prepare("SELECT * FROM v6_medusa_v2_wakes WHERE state = 'pending'").all()
    : db.prepare("SELECT * FROM v6_medusa_v2_wakes WHERE state = 'pending' AND recipient = ?").all(recipient);
  return rows
    .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((r) => ({ wakeId: r.id, fleetId: r.fleet_id, waveId: r.wave_id, recipient: r.recipient, priority: r.priority, completionIds: JSON.parse(r.completion_ids) }));
}

module.exports = {
  CAPABILITY,
  MSG_TYPES,
  PRIORITIES,
  MedusaV2Error,
  sha256,
  canonicalJson,
  negotiateWire,
  artifactRef,
  resolveArtifact,
  createEnvelope,
  verifyEnvelope,
  projectCard,
  parseCard,
  validateGraph,
  merkleRoot,
  diffGraphs,
  applyDelta,
  recoverFromFullFrame,
  wakeIdFor,
  createWakeCoalescer,
  ensureSchema,
  recordMessage,
  readMessage,
  inbox,
  ackMessage,
  saveSnapshot,
  loadSnapshot,
  saveDelta,
  queueWake,
  drainWake,
  markWakeUncertain,
  pendingWakes
};
