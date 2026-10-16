'use strict';

/**
 * The shared-document revision record (#2389).
 *
 * Every distinct content digest TangleClaw observes of a registered shared doc
 * becomes one revision: the file watcher, the notify route, a writer's base
 * capture and an attestation all observe through one serializer per doc, so
 * the read, the diff against the persisted baseline, the seq and the record
 * are one step per revision.
 *
 * A revision's author is `unknown` unless a session ATTESTS it: the session
 * holds the doc's lock, saved the digest its edit was prepared from (`tc docs
 * base`), edited the file as it always has, and then names the resulting
 * digest (`tc docs attest`). That is authenticated attestation in a
 * cooperative-writer model: it proves the attester held the lock and that the
 * bytes it names followed its saved base with nothing observed in between. It
 * is not forensic proof of who wrote the bytes, and nothing here claims it is.
 * TangleClaw only ever READS the registered path.
 *
 * Who would be told is computed per revision as a shadow (`shadowWouldSelect`)
 * and is never acted on here: delivery is still the broadcast in `server.js`.
 * A shadow selection is not a measured wake reduction and is never reported
 * as one.
 *
 * @module lib/shared-docs
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const store = require('./store');

/**
 * Bounds of the record. Mutable only so a test can exercise the over-cap path
 * without writing 8 MB.
 * @type {{baselineCapBytes: number, excerptBytes: number}}
 */
const limits = {
  // The largest doc whose full content is kept as the baseline. Over it only
  // the digest is kept, and every comparison with it is digest-only.
  baselineCapBytes: 8 * 1024 * 1024,
  excerptBytes: 4096
};

/**
 * @param {Buffer|string} bytes - Content
 * @returns {string} Its sha256, hex.
 */
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * A table cell, or a prose line, with formatting that carries no meaning
 * removed: bold and underline-emphasis markers, and runs of whitespace.
 * @param {string} text - Raw text
 * @returns {string}
 */
function normalizeText(text) {
  return text.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The cells of one markdown table line, split on unescaped pipes, with the
 * outer pipes dropped.
 * @param {string} line - A line starting with `|`
 * @returns {string[]}
 */
function splitCells(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/);
}

/**
 * Whether a line is a table's header separator (`|---|:--:|`).
 * @param {string} line - Line
 * @returns {boolean}
 */
function isSeparator(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.includes('-')) return false;
  return splitCells(trimmed).every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

/**
 * Member project names a row key may resolve to. A name two members share
 * resolves to nobody: an ambiguous key is unknown, never a guess.
 * @param {Array<{id: number, name: string}>} members - Current group members
 * @returns {Map<string, number>} name → project id
 */
function memberKeys(members) {
  const byName = new Map();
  const ambiguous = new Set();
  for (const m of members) {
    if (!m || typeof m.name !== 'string') continue;
    if (byName.has(m.name)) ambiguous.add(m.name);
    byName.set(m.name, m.id);
  }
  for (const name of ambiguous) byName.delete(name);
  return byName;
}

/**
 * Parse a doc into keyed table rows and everything else.
 *
 * A keyed row is a table row whose first cell, emphasis and backticks
 * removed, is exactly one member's project name. Keyed rows are grouped per
 * table (the digest of its normalized header) and per project id as a
 * multiset of normalized rows, so moving a row, or several rows sharing one
 * key, is not a change. Every other line — prose, headings, table headers and
 * separators, unkeyed rows — is kept in order, normalized, blank lines dropped.
 * @param {string} content - Doc text
 * @param {Map<string, number>} keys - From {@link memberKeys}
 * @returns {{keyed: Map<string, {projectId: number, rows: string[]}>, other: string[]}}
 */
function parseDoc(content, keys) {
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const keyed = new Map();
  const other = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('|') && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = splitCells(line).map(normalizeText).join(' | ');
      const tableKey = sha256(header);
      other.push(`table: ${header}`);
      // Alignment colons and dash counts are presentation: only the column
      // count of a separator is kept.
      other.push(`separator: ${splitCells(lines[i + 1]).length}`);
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitCells(lines[i]).map(normalizeText);
        const key = (cells[0] || '').replace(/`/g, '').trim();
        // The key cell is compared as the key it resolves to, so quoting it
        // in backticks is formatting, not a change to the row.
        const row = [key, ...cells.slice(1)].join(' | ');
        if (keys.has(key)) {
          const projectId = keys.get(key);
          const slot = `${tableKey}\u0000${projectId}`;
          if (!keyed.has(slot)) keyed.set(slot, { projectId, rows: [] });
          keyed.get(slot).rows.push(row);
        } else {
          other.push(`row: ${row}`);
        }
        i++;
      }
      continue;
    }
    const text = normalizeText(line);
    if (text !== '') other.push(text);
    i++;
  }
  for (const entry of keyed.values()) entry.rows.sort();
  return { keyed, other };
}

/**
 * How many rows are in one sorted multiset and not the other, both ways.
 * @param {string[]} a - Sorted rows
 * @param {string[]} b - Sorted rows
 * @returns {number}
 */
function symmetricDifferenceSize(a, b) {
  const counts = new Map();
  for (const r of a) counts.set(r, (counts.get(r) || 0) + 1);
  for (const r of b) counts.set(r, (counts.get(r) || 0) - 1);
  let n = 0;
  for (const c of counts.values()) n += Math.abs(c);
  return n;
}

/**
 * A bounded excerpt of what changed: lines added (`+ `) and removed (`- `),
 * compared as trimmed text. Cut to {@link limits}.excerptBytes.
 * @param {string} prior - Prior content
 * @param {string} next - New content
 * @returns {{excerpt: string, truncated: boolean}}
 */
function diffExcerpt(prior, next) {
  const before = prior.split('\n').map((l) => l.trim()).filter(Boolean);
  const after = next.split('\n').map((l) => l.trim()).filter(Boolean);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const lines = [
    ...after.filter((l) => !beforeSet.has(l)).map((l) => `+ ${l}`),
    ...before.filter((l) => !afterSet.has(l)).map((l) => `- ${l}`)
  ];
  let excerpt = lines.join('\n');
  let truncated = false;
  if (Buffer.byteLength(excerpt) > limits.excerptBytes) {
    excerpt = Buffer.from(excerpt).subarray(0, limits.excerptBytes).toString('utf8').replace(/�$/, '');
    truncated = true;
  }
  return { excerpt, truncated };
}

/**
 * Classify one revision against its baseline.
 *
 * `row`: keyed rows changed, carrying every changed project id (the set is
 * bounded by the group's size and never truncated). `unknown`: anything
 * outside keyed rows changed. `formatting`: the bytes changed and nothing
 * survives normalization. `first-seen`: there is no baseline. A comparison
 * where EITHER side lacks its full content is digest-only: `unknown`, with
 * `attribution: 'incomplete'` and an empty changed set, because an incomplete
 * baseline never supports a claim about which rows changed.
 * @param {{content: (string|null)}|null} prior - The baseline, or null
 * @param {string|null} next - The new content, or null when over the cap
 * @param {Map<string, number>} keys - From {@link memberKeys}
 * @returns {{classes: string[], attribution: string, baseline: string, changedProjectIds: number[], changedRowCount: number, excerpt: (string|null), excerptTruncated: boolean}}
 */
function classify(prior, next, keys) {
  if (!prior) {
    return {
      classes: ['first-seen'], attribution: 'incomplete', baseline: next == null ? 'digest-only' : 'full',
      changedProjectIds: [], changedRowCount: 0, excerpt: null, excerptTruncated: false
    };
  }
  if (prior.content == null || next == null) {
    return {
      classes: ['unknown'], attribution: 'incomplete', baseline: 'digest-only',
      changedProjectIds: [], changedRowCount: 0, excerpt: null, excerptTruncated: false
    };
  }
  const before = parseDoc(prior.content, keys);
  const after = parseDoc(next, keys);
  const changed = new Set();
  let changedRowCount = 0;
  for (const slot of new Set([...before.keyed.keys(), ...after.keyed.keys()])) {
    const a = before.keyed.get(slot);
    const b = after.keyed.get(slot);
    const diff = symmetricDifferenceSize(a ? a.rows : [], b ? b.rows : []);
    if (diff > 0) {
      changed.add((a || b).projectId);
      changedRowCount += diff;
    }
  }
  const otherChanged = before.other.length !== after.other.length
    || before.other.some((line, idx) => line !== after.other[idx]);
  const classes = [];
  if (changed.size > 0) classes.push('row');
  if (otherChanged) classes.push('unknown');
  if (classes.length === 0) classes.push('formatting');
  const { excerpt, truncated } = diffExcerpt(prior.content, next);
  return {
    classes, attribution: 'complete', baseline: 'full',
    changedProjectIds: [...changed].sort((x, y) => x - y), changedRowCount,
    excerpt, excerptTruncated: truncated
  };
}

/**
 * Who the row-aware rule would tell of a revision, as a shadow only: the
 * owners of the changed rows other than the author, when the author is known
 * and the changed set is complete. An unknown author, an incomplete
 * comparison, or a revision with no changed rows selects no one.
 * Preferences do not exist yet, so none is applied.
 * @param {{classes: string[], attribution: string, changedProjectIds: number[]}} revision
 * @param {number|null} authorProjectId - The attested author, or null
 * @returns {number[]}
 */
function wouldSelect(revision, authorProjectId) {
  if (authorProjectId == null) return [];
  if (revision.attribution !== 'complete' || !revision.classes.includes('row')) return [];
  return revision.changedProjectIds.filter((id) => id !== authorProjectId);
}

/** @type {Map<string, Promise<*>>} The tail of each doc's queue. */
const tails = new Map();

/**
 * Run `task` after every task already queued for the same doc, so a doc's
 * observations, base captures and attestations never interleave. A failed
 * task does not stop the queue.
 * @template T
 * @param {string} docId - Shared doc id
 * @param {() => Promise<T>} task - The work
 * @returns {Promise<T>}
 */
function serialize(docId, task) {
  const prev = tails.get(docId) || Promise.resolve();
  const next = prev.then(() => {}, () => {}).then(task);
  tails.set(docId, next);
  const clear = () => { if (tails.get(docId) === next) tails.delete(docId); };
  next.then(clear, clear);
  return next;
}

/**
 * Read a doc's registered file, read-only, as the watcher does.
 * @param {{filePath: string}} doc - Shared doc
 * @returns {Promise<Buffer>}
 * @throws {Error} With `code: 'UNREADABLE'` when it is missing or unreadable.
 */
async function readRegistered(doc) {
  try {
    return await fs.promises.readFile(doc.filePath);
  } catch (err) {
    const e = new Error(`Shared document file cannot be read: ${err.code || err.message}`);
    e.code = 'UNREADABLE';
    throw e;
  }
}

/**
 * The lock holder at observation time, as a labelled hint. It names who held
 * the lock, not who wrote: nothing routes on it.
 * @param {string} docId - Shared doc id
 * @param {Date} now - Observation time
 * @returns {{sessionId: number, project: string}|null}
 */
function lockHolderHint(docId, now) {
  const lock = store.documentLocks.check(docId);
  if (!lock) return null;
  if (lock.expiresAt && new Date(lock.expiresAt) <= now) return null;
  return { sessionId: lock.lockedBySession, project: lock.lockedByProject };
}

/**
 * Record what was just read of a doc, synchronously: a duplicate of the
 * newest revision, or a new revision classified against the baseline.
 * Called only from inside the doc's serializer, after its read completed.
 * @param {object} doc - Shared doc
 * @param {Buffer} bytes - The content read
 * @param {string} source - One of `store.SHARED_DOC_EVENT_SOURCES`
 * @param {Date} [now] - Observation time
 * @returns {{revision: object, duplicate: boolean}}
 */
function recordObservation(doc, bytes, source, now = new Date()) {
  const digest = sha256(bytes);
  const baseline = store.sharedDocEvents.getBaseline(doc.id);
  if (baseline && baseline.sha256 === digest) {
    const latest = store.sharedDocEvents.latest(doc.id);
    if (latest && latest.sha256 === digest) {
      store.sharedDocEvents.recordDuplicate(latest.id);
      return { revision: store.sharedDocEvents.latest(doc.id), duplicate: true };
    }
  }
  const members = store.projectGroups.listMembers(doc.groupId)
    .map((id) => store.projects.get(id)).filter(Boolean);
  const overCap = bytes.length > limits.baselineCapBytes;
  const next = overCap ? null : bytes.toString('utf8');
  const result = classify(baseline, next, memberKeys(members));
  const revision = store.sharedDocEvents.recordRevision({
    docId: doc.id,
    observedAt: now.toISOString(),
    sha256: digest,
    priorSha256: baseline ? baseline.sha256 : null,
    lockHolderHint: lockHolderHint(doc.id, now),
    ...result,
    source,
    // No author is known at observation, so the rule selects no one.
    shadowWouldSelect: []
  }, { content: next, byteLength: bytes.length });
  return { revision, duplicate: false };
}

/**
 * Observe a doc through its serializer and record what was read.
 * @param {string} docId - Shared doc id
 * @param {{source: string, read?: function(object): Promise<Buffer>}} opts -
 *   `read` stands in for the registered-file read, in tests
 * @returns {Promise<{revision: object, duplicate: boolean}|null>} null when the doc is gone.
 */
function observe(docId, opts) {
  return serialize(docId, async () => {
    const doc = store.sharedDocs.get(docId);
    if (!doc) return null;
    const bytes = await (opts.read || readRegistered)(doc);
    // The doc may have been unregistered while the read was in flight.
    if (!store.sharedDocs.get(docId)) return null;
    return recordObservation(doc, bytes, opts.source);
  });
}

/**
 * A writer's base capture: observe the file into the serialized record and
 * return the digest of the revision it now holds. The digest a writer saves
 * is therefore one the record has, so the attestation of its edit can match
 * `priorSha256`. A base capture attests nothing.
 * @param {string} docId - Shared doc id
 * @param {{read?: function(object): Promise<Buffer>}} [opts]
 * @returns {Promise<{seq: number, sha256: string}|null>} null when the doc is gone.
 */
async function captureBase(docId, opts = {}) {
  const observed = await observe(docId, { source: 'base', read: opts.read });
  if (!observed) return null;
  return { seq: observed.revision.seq, sha256: observed.revision.sha256 };
}

/**
 * A refusal or answer from {@link attest}.
 * @typedef {object} AttestOutcome
 * @property {number} status - HTTP status
 * @property {string} [code] - Refusal code
 * @property {string} [message] - Refusal text
 * @property {object} [revision] - The revision, on success
 * @property {boolean} [already] - The same session had already attested it
 */

/**
 * Attest that the newest revision of a doc is the caller's edit.
 *
 * Inside the doc's serializer: read the file, then — synchronously, with no
 * await between them — re-run `recheck` (the caller's access and its lock,
 * which may have expired or changed during the read), record the read as its
 * own revision when the bytes are new (an intervening write that was observed
 * is therefore recorded as `unknown` before anything is compared), and bind.
 * Bytes overwritten before any observation cannot be reconstructed, so they
 * are neither recorded nor refused. A refusal leaves every binding unchanged,
 * although its read may have recorded a new `unknown` revision.
 *
 * Binds only when the newest revision's digest is `sha256` and its prior
 * digest is `baseSha256`. A no-op (`sha256` equal to `baseSha256`) never
 * claims an earlier revision. The same session re-attesting the same
 * revision is answered `already`; any other caller is refused.
 * @param {string} docId - Shared doc id
 * @param {{baseSha256: string, sha256: string, projectId: number, sessionId: number,
 *   recheck: function(): (AttestOutcome|null), read?: function(object): Promise<Buffer>}} req
 * @returns {Promise<AttestOutcome>}
 */
function attest(docId, req) {
  if (req.sha256 === req.baseSha256) {
    return Promise.resolve({
      status: 409, code: 'NO_CHANGE',
      message: 'The digest named is the base digest: there is no edit to attest, and an earlier revision is never claimed'
    });
  }
  return serialize(docId, async () => {
    const doc = store.sharedDocs.get(docId);
    if (!doc) return { status: 404, code: 'NOT_FOUND', message: `Shared document "${docId}" not found` };
    let bytes;
    try {
      bytes = await (req.read || readRegistered)(doc);
    } catch (err) {
      if (err.code !== 'UNREADABLE') throw err;
      return { status: 409, code: 'UNREADABLE', message: err.message };
    }
    // From here to the bind nothing awaits: the checks and the binding are one step.
    const refusal = req.recheck();
    if (refusal) return refusal;
    if (!store.sharedDocs.get(docId)) return { status: 404, code: 'NOT_FOUND', message: `Shared document "${docId}" not found` };
    const { revision } = recordObservation(doc, bytes, 'attest');
    if (revision.sha256 !== req.sha256) {
      return {
        status: 409, code: 'DIGEST_MISMATCH',
        message: `The file now reads ${revision.sha256}, not the digest named`
      };
    }
    if (revision.authorSource === 'attested') {
      if (revision.authorSessionId === req.sessionId && revision.authorProjectId === req.projectId) {
        return { status: 200, already: true, revision };
      }
      return { status: 409, code: 'ALREADY_ATTESTED', message: 'This revision is already attested by another session' };
    }
    if (revision.priorSha256 !== req.baseSha256) {
      return {
        status: 409, code: 'BASE_MISMATCH',
        message: 'A revision was observed between the base and this edit, or the base was never recorded: the edit is not attested'
      };
    }
    const bound = store.sharedDocEvents.attest(revision.id, {
      projectId: req.projectId,
      sessionId: req.sessionId,
      attestedAt: new Date().toISOString(),
      shadowWouldSelect: wouldSelect(revision, req.projectId)
    });
    if (!bound) return { status: 409, code: 'ALREADY_ATTESTED', message: 'This revision is already attested' };
    return { status: 200, already: false, revision: store.sharedDocEvents.latest(docId) };
  });
}

module.exports = {
  limits,
  sha256,
  normalizeText,
  memberKeys,
  parseDoc,
  classify,
  wouldSelect,
  serialize,
  recordObservation,
  observe,
  captureBase,
  attest
};
