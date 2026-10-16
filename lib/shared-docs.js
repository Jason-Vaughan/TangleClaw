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
 * Delivery is derived from the record. A revision is recorded first, and in
 * the same transaction its recipients are resolved by the delivery rule
 * ({@link selectRecipients}) and persisted as one intent per (project, live
 * session), with the author binding when an attestation makes one. Only after
 * that commits, and outside the doc's serializer, is each intent this call
 * inserted sent, after a recheck of the registration, the membership and the
 * project's setting. A revision that cannot be recorded notifies nobody:
 * there is no fallback to telling everyone. A delivery the server stopped
 * during is `interrupted` and is never resent or extended; a recipient it
 * missed catches up through the revision record.
 *
 * `shadowWouldSelect` is still recorded per revision, as a shadow of R2 alone.
 * Neither it nor a delivery count is a measured wake reduction, and neither
 * is reported as one.
 *
 * @module lib/shared-docs
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const store = require('./store');
const medusa = require('./medusa');
const { createLogger } = require('./logger');

const log = createLogger('shared-docs');

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
 * table and per project id as a multiset of normalized rows, so moving a row
 * within its table, or several rows sharing one key, is not a change. A table
 * is identified by its nearest preceding heading (ATX or setext), its
 * normalized header, and its position among the tables that share both:
 * sections often hold tables with the same header (`Active` and `Done`), and
 * a row moving between any two of them is a change to that row's project.
 * Renaming a heading, or adding a table before others that share its heading
 * and header, therefore reports the keyed rows it shifts as changed, which
 * over-reports rather than hiding a move. Every other line — prose, headings, table headers and
 * separators, unkeyed rows — is kept in order, normalized, blank lines dropped.
 * @param {string} content - Doc text
 * @param {Map<string, number>} keys - From {@link memberKeys}
 * @returns {{keyed: Map<string, {projectId: number, rows: string[]}>, other: string[]}}
 */
function parseDoc(content, keys) {
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const keyed = new Map();
  const other = [];
  let heading = '';
  const seen = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('|') && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = splitCells(line).map(normalizeText).join(' | ');
      const identity = `${heading}\u0000${header}`;
      const ordinal = (seen.get(identity) || 0) + 1;
      seen.set(identity, ordinal);
      const tableKey = sha256(`${identity}\u0000${ordinal}`);
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
    if (/^#{1,6}\s/.test(text)) heading = text;
    // A setext heading: a text line underlined with `===` or `---`.
    else if (text !== '' && i + 1 < lines.length && /^\s*(=+|-{2,})\s*$/.test(lines[i + 1])) heading = `setext: ${text}`;
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

/**
 * Each current group member's notice settings at both scopes, and the one in
 * effect: the doc-scope setting when it has one, else the group-scope one,
 * else null (the default). With no doc, the group scope alone. Settings of
 * projects no longer in the group are ignored. The one place precedence is
 * decided: routing and every view of a setting read it here.
 * @param {string} groupId - Group id
 * @param {string|null} docId - Doc id, or null for the group scope
 * @returns {Map<number, {doc: (string|null), group: (string|null), effective: (string|null)}>} by member project id
 */
function memberSettings(groupId, docId) {
  const members = store.projectGroups.listMembers(groupId);
  const byScope = new Map(members.map((id) => [id, { doc: null, group: null }]));
  for (const pref of store.sharedDocNoticePrefs.listForGroup(groupId)) {
    const slot = byScope.get(pref.projectId);
    if (!slot) continue;
    if (pref.scope === 'group' && pref.groupId === groupId) slot.group = pref.setting;
    else if (pref.scope === 'doc' && docId && pref.docId === docId) slot.doc = pref.setting;
  }
  for (const slot of byScope.values()) slot.effective = slot.doc || slot.group || null;
  return byScope;
}

/**
 * Each current group member's effective notice setting for one doc
 * ({@link memberSettings}).
 * @param {{id: string, groupId: string}} doc - Shared doc
 * @returns {Map<number, ('mute'|'subscribe'|null)>} member project id → setting
 */
function effectiveSettings(doc) {
  const out = new Map();
  for (const [id, s] of memberSettings(doc.groupId, doc.id)) out.set(id, s.effective);
  return out;
}

/**
 * The projects the delivery rule intends for a revision, and why.
 *
 * R1: a known author is never intended. R2: with a known author and a
 * complete comparison, the owners of the changed rows are intended, as
 * `owner`, unless muted (then `muted`). R3: a subscriber is intended, as
 * `subscriber`, for every revision that changed rows or anything outside them,
 * whoever wrote it; with the author unknown that may include the writer, who
 * asked for every change. R4: nothing else selects anyone, so an unknown
 * author, an incomplete comparison, `formatting` and `first-seen` reach
 * subscribers at most. A project in `exclude` (already resolved for this
 * revision) is left out, so nobody is resolved twice.
 * @param {{classes: string[], attribution: string, changedProjectIds: number[]}} revision
 * @param {{authorProjectId: (number|null), settings: Map<number, (string|null)>, exclude?: Set<number>}} opts
 * @returns {Array<{projectId: number, reason: ('owner'|'subscriber'), muted: boolean}>} by project id
 */
function selectRecipients(revision, { authorProjectId, settings, exclude = new Set() }) {
  const out = new Map();
  const eligible = (id) => settings.has(id) && id !== authorProjectId && !exclude.has(id);
  if (authorProjectId != null && revision.attribution === 'complete' && revision.classes.includes('row')) {
    for (const id of revision.changedProjectIds) {
      if (eligible(id)) out.set(id, { projectId: id, reason: 'owner', muted: settings.get(id) === 'mute' });
    }
  }
  if (revision.classes.includes('row') || revision.classes.includes('unknown')) {
    for (const [id, setting] of settings) {
      if (setting === 'subscribe' && eligible(id) && !out.has(id)) {
        out.set(id, { projectId: id, reason: 'subscriber', muted: false });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.projectId - b.projectId);
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
 * The shared doc a Medusa inbox entry is an un-handled "this doc changed"
 * notice for, or `null` if it is anything else.
 *
 * Only a message whose envelope `from` is `system` qualifies. A peer could type
 * the same JSON into its own body, and a peer message has a sender waiting on
 * it: treating one as a redundant notice would let this suppress a message
 * somebody is blocked on. `/medusa/send` derives `from` from the sending
 * listener's own workspace id, so no caller going through TangleClaw can label
 * itself `system`; the guarantee is exactly as strong as "every sender goes
 * through TangleClaw".
 *
 * Reads `docId`, not the display name: two groups may each register a doc
 * called `ROADMAP`. A notice with no `docId` matches nothing and costs one
 * duplicate.
 * @param {object} entry - A message body from `medusa.getMessages`.
 * @returns {string|null} The doc id the notice is about, or null.
 */
function noticeDocId(entry) {
  if (!entry || entry.from !== 'system') return null;
  let payload = entry.message;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.event !== 'shared_doc_updated') return null;
  return payload.docId != null ? String(payload.docId) : null;
}

/**
 * The intents for a selection: one `muted` row for a muted project, one
 * `offline` row (session 0) for a project with no live session, otherwise
 * one `pending` row per live session. Every intended project is recorded,
 * never dropped.
 * @param {Array<{projectId: number, reason: string, muted: boolean}>} selection - From {@link selectRecipients}
 * @returns {Array<{projectId: number, sessionId: number, reason: string, outcome: string}>}
 */
function intentRows(selection) {
  const live = store.sessions.listLiveAll();
  const rows = [];
  for (const sel of selection) {
    if (sel.muted) {
      rows.push({ projectId: sel.projectId, sessionId: 0, reason: sel.reason, outcome: 'muted' });
      continue;
    }
    const sessions = live.filter((s) => s.projectId === sel.projectId);
    if (sessions.length === 0) {
      rows.push({ projectId: sel.projectId, sessionId: 0, reason: sel.reason, outcome: 'offline' });
      continue;
    }
    for (const session of sessions) {
      rows.push({ projectId: sel.projectId, sessionId: session.id, reason: sel.reason, outcome: 'pending' });
    }
  }
  return rows;
}

/**
 * The routing step for one revision, run inside the transaction that records
 * or binds it: the rule applied with the author as known at that moment, minus
 * every project already resolved for the revision, whatever its outcome. An
 * `interrupted` revision resolves no one: its delivery is never extended.
 * @param {object} doc - Shared doc, as registered when the bytes were read
 * @param {number|null} authorProjectId - The attested author, or null
 * @returns {function(object): Array<object>}
 */
function routeFor(doc, authorProjectId) {
  return (revision) => {
    if (revision.routing === 'interrupted') return [];
    return intentRows(selectRecipients(revision, {
      authorProjectId,
      settings: effectiveSettings(doc),
      exclude: store.sharedDocDeliveries.resolvedProjectIds(revision.id)
    }));
  };
}

/**
 * What this call's sends did. `notified` and `coalesced` count only this
 * call's intents, never another call's sends of the same revision.
 * @typedef {object} DeliveryCounts
 * @property {number} notified - Sent
 * @property {number} coalesced - Skipped: an un-handled notice for the doc was already in that inbox
 * @property {number} offline - The session was not listening
 * @property {number} muted - The project muted the doc since it was resolved
 * @property {number} withdrawn - The intent no longer held at dispatch
 * @property {string[]} errors - One per failed send
 */

/** @type {Set<Promise<DeliveryCounts>>} Sends in flight, for {@link drain}. */
const inFlight = new Set();

/**
 * Why a stored intent must not be sent now, or null when it still holds.
 * `withdrawn`: the doc is gone or was re-registered (its path or group
 * changed), the project is no longer a member of its group, or a subscriber
 * no longer subscribes. `muted`: the project has muted the doc. Separate from
 * whether the session is listening.
 * @param {object} intent - A pending delivery
 * @param {{id: string, groupId: string, filePath: string}} resolvedFor - The doc as registered at resolution
 * @returns {('muted'|'withdrawn'|null)}
 */
function suppression(intent, resolvedFor) {
  const doc = store.sharedDocs.get(resolvedFor.id);
  if (!doc || doc.groupId !== resolvedFor.groupId || doc.filePath !== resolvedFor.filePath) return 'withdrawn';
  if (!store.projectGroups.listMembers(doc.groupId).includes(intent.projectId)) return 'withdrawn';
  const setting = effectiveSettings(doc).get(intent.projectId) || null;
  if (setting === 'mute') return 'muted';
  if (intent.reason === 'subscriber' && setting !== 'subscribe') return 'withdrawn';
  return null;
}

/**
 * Settle one stored intent: re-read it (gone or already settled → nothing),
 * the dispatch-time check, the session's listening state, coalescing, then
 * the send. A failed send is settled `failed` with its error.
 * @param {number} id - Delivery row id
 * @param {{id: string, groupId: string, filePath: string}} doc - The doc as registered at resolution
 * @param {string} payload - The notice text
 * @param {DeliveryCounts} counts - Tallied in place
 * @returns {Promise<void>}
 */
async function sendOne(id, doc, payload, counts) {
  const intent = store.sharedDocDeliveries.get(id);
  if (!intent || intent.outcome !== 'pending') return;
  const suppressed = suppression(intent, doc);
  if (suppressed) {
    if (store.sharedDocDeliveries.settle(id, suppressed)) counts[suppressed]++;
    return;
  }
  const status = medusa.getStatus(intent.sessionId);
  if (!status || status.state !== 'listening' || !status.workspaceId) {
    if (store.sharedDocDeliveries.settle(id, 'offline')) counts.offline++;
    return;
  }
  // One notice per reader per quiet period, where the READER defines the
  // period: while an un-handled notice for this doc is in their inbox, a
  // second carries nothing the first did not. Fail-open: a burst that
  // outruns the Bridge's round trip sends a duplicate, never suppresses a
  // change.
  const pending = medusa.getMessages(intent.sessionId).some((m) => noticeDocId(m) === String(doc.id));
  if (pending) {
    if (store.sharedDocDeliveries.settle(id, 'coalesced')) counts.coalesced++;
    return;
  }
  try {
    await medusa.sendSystemMessage({ to: status.workspaceId, message: payload });
  } catch (err) {
    store.sharedDocDeliveries.settle(id, 'failed', err.message);
    counts.errors.push(`Failed for session ${intent.sessionId}: ${err.message}`);
    log.warn('Shared-doc notice not sent', { docId: doc.id, sessionId: intent.sessionId, error: err.message });
    return;
  }
  store.sharedDocDeliveries.settle(id, 'sent');
  counts.notified++;
}

/**
 * Send the intents ONE call inserted, and settle each. Each is re-read first:
 * an intent whose revision or doc was deleted is gone and is not sent, and
 * one the startup sweep settled stays settled. Then the dispatch-time check,
 * then the session's listening state, then coalescing on an un-handled
 * notice for the same doc. The revision is marked `done` only when none of its
 * intents, from any call, is still pending. Never rejects.
 * @param {number} eventId - Revision row id
 * @param {number[]} intentIds - The pending delivery ids this call inserted
 * @param {{id: string, name: string, groupId: string, filePath: string}} doc - The doc as registered at resolution
 * @returns {Promise<DeliveryCounts>}
 */
function sendIntents(eventId, intentIds, doc) {
  const counts = { notified: 0, coalesced: 0, offline: 0, muted: 0, withdrawn: 0, errors: [] };
  if (intentIds.length === 0) return Promise.resolve(counts);
  // `docId` rides alongside the display name so a reader, and the coalescing
  // check, can tell two same-named docs apart.
  const payload = JSON.stringify({ type: 'system', event: 'shared_doc_updated', doc: doc.name, docId: doc.id });
  const run = (async () => {
    for (const id of intentIds) {
      try {
        await sendOne(id, doc, payload, counts);
      } catch (err) { // prawduct:allow prawduct/broad-except -- per-intent supervisor: any failure settles that intent failed so the batch never strands pending rows
        // Anything unexpected settles this intent `failed` and moves on, so
        // one bad read never strands the rest of the batch as pending.
        store.sharedDocDeliveries.settle(id, 'failed', err.message);
        counts.errors.push(`Failed for delivery ${id}: ${err.message}`);
        log.warn('Shared-doc notice not sent', { docId: doc.id, deliveryId: id, error: err.message });
      }
    }
    store.sharedDocDeliveries.finish(eventId);
    if (counts.notified > 0 || counts.coalesced > 0) {
      log.info('Shared-doc notices delivered', { docId: doc.id, eventId, notified: counts.notified, coalesced: counts.coalesced });
    }
    return counts;
  })().catch((err) => { // prawduct:allow prawduct/broad-except -- the delivery promise never rejects: its callers do not await it
    // A store failure mid-loop: the intents not settled stay pending, and the
    // startup sweep marks them unknown. Reported, never rethrown.
    log.error('Shared-doc delivery failed', { docId: doc.id, eventId, error: err.stack });
    counts.errors.push(err.message);
    return counts;
  });
  inFlight.add(run);
  run.finally(() => inFlight.delete(run));
  return run;
}

/**
 * Settle every send in flight: for tests, and for shutdown, which bounds the
 * wait.
 * @param {number} [timeoutMs] - Give up after this long; unbounded when omitted
 * @returns {Promise<boolean>} Whether everything settled in time.
 */
async function drain(timeoutMs) {
  const settle = (async () => {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
    return true;
  })();
  if (timeoutMs === undefined) return settle;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([settle, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record what was just read of a doc, synchronously: a duplicate of the
 * newest revision, or a new revision classified against the baseline and,
 * in the same transaction, bound (when `bind` approves it) and routed.
 * Called only from inside the doc's serializer, after its read completed.
 * @param {object} doc - Shared doc
 * @param {Buffer} bytes - The content read
 * @param {string} source - One of `store.SHARED_DOC_EVENT_SOURCES`
 * @param {Date} [now] - Observation time
 * @param {{bind?: function({sha256: string, priorSha256: (string|null)}): ({projectId: number, sessionId: number}|null)}} [opts] -
 *   `bind` decides, before anything is written, whether the new revision is
 *   the caller's attested edit; a refusal records it `unknown`
 * @returns {{revision: object, duplicate: boolean, bound: boolean, intentIds: number[]}}
 */
function recordObservation(doc, bytes, source, now = new Date(), opts = {}) {
  const digest = sha256(bytes);
  const baseline = store.sharedDocEvents.getBaseline(doc.id);
  if (baseline && baseline.sha256 === digest) {
    const latest = store.sharedDocEvents.latest(doc.id);
    if (latest && latest.sha256 === digest) {
      store.sharedDocEvents.recordDuplicate(latest.id);
      return { revision: store.sharedDocEvents.latest(doc.id), duplicate: true, bound: false, intentIds: [] };
    }
  }
  const members = store.projectGroups.listMembers(doc.groupId)
    .map((id) => store.projects.get(id)).filter(Boolean);
  const overCap = bytes.length > limits.baselineCapBytes;
  const next = overCap ? null : bytes.toString('utf8');
  const result = classify(baseline, next, memberKeys(members));
  const priorSha256 = baseline ? baseline.sha256 : null;
  const author = opts.bind ? opts.bind({ sha256: digest, priorSha256 }) : null;
  let intentIds = [];
  const revision = store.sharedDocEvents.recordRevision({
    docId: doc.id,
    observedAt: now.toISOString(),
    sha256: digest,
    priorSha256,
    lockHolderHint: lockHolderHint(doc.id, now),
    ...result,
    source,
    shadowWouldSelect: [],
    binding: author ? {
      projectId: author.projectId,
      sessionId: author.sessionId,
      attestedAt: now.toISOString(),
      shadowWouldSelect: wouldSelect(result, author.projectId)
    } : null
  }, { content: next, byteLength: bytes.length }, {
    // With the author already known, both resolution points are this one, so
    // the author is never told of its own edit.
    route: routeFor(doc, author ? author.projectId : null),
    onRouted: (ids) => { intentIds = ids; }
  });
  return { revision, duplicate: false, bound: !!author, intentIds };
}

/**
 * The registration a read was made for, as it stands after the read: the
 * operator may change a doc's path or group, or unregister it, while a read is
 * in flight, and bytes read from the old path must never become the new
 * registration's baseline, revision or attested content.
 * @param {{id: string, filePath: string, groupId: string}} before - The doc as loaded before the read
 * @returns {{doc: (object|null), refusal: (AttestOutcome|null)}} The current doc, or why the read is void.
 */
function currentRegistration(before) {
  const doc = store.sharedDocs.get(before.id);
  if (!doc) {
    return { doc: null, refusal: { status: 404, code: 'NOT_FOUND', message: `Shared document "${before.id}" not found` } };
  }
  if (doc.filePath !== before.filePath || doc.groupId !== before.groupId) {
    return {
      doc: null,
      refusal: { status: 409, code: 'DOC_CHANGED', message: 'The document was re-registered while its file was read: nothing was recorded' }
    };
  }
  return { doc, refusal: null };
}

/**
 * Start the sends of what a call recorded, without waiting for them.
 * @param {{revision: object, intentIds: number[]}} recorded - From {@link recordObservation}
 * @param {object} doc - The doc as registered at resolution
 * @returns {Promise<DeliveryCounts>}
 */
function dispatch(recorded, doc) {
  return sendIntents(recorded.revision.id, recorded.intentIds, doc);
}

/**
 * Observe a doc through its serializer, record what was read, and send the
 * notices its routing step intended. A read whose registration changed or
 * vanished while it was in flight records and sends nothing.
 * @param {string} docId - Shared doc id
 * @param {{source: string, read?: function(object): Promise<Buffer>}} opts -
 *   `read` stands in for the registered-file read, in tests
 * @returns {Promise<{revision: object, duplicate: boolean, delivery: Promise<DeliveryCounts>}|null>}
 *   null when the doc is gone or changed. `delivery` never rejects.
 */
async function observe(docId, opts) {
  let doc = null;
  const recorded = await serialize(docId, async () => {
    doc = store.sharedDocs.get(docId);
    if (!doc) return null;
    const bytes = await (opts.read || readRegistered)(doc);
    const { doc: current } = currentRegistration(doc);
    if (!current) return null;
    doc = current;
    return recordObservation(current, bytes, opts.source);
  });
  if (!recorded) return null;
  return { revision: recorded.revision, duplicate: recorded.duplicate, delivery: dispatch(recorded, doc) };
}

/**
 * A writer's base capture: observe the file into the serialized record and
 * return the digest of the revision it now holds. The digest a writer saves
 * is therefore one the record has, so the attestation of its edit can match
 * `priorSha256`. A base capture attests nothing; new bytes it finds are an
 * unknown-author revision, routed as any observation is.
 *
 * After the read, and before anything is recorded, the registration is read
 * again and `recheck` re-authorizes the caller against it, as an attestation
 * does: a capture queued behind other work must not succeed for a caller whose
 * binding or membership was revoked meanwhile.
 * @param {string} docId - Shared doc id
 * @param {{recheck?: function(object): (AttestOutcome|null), read?: function(object): Promise<Buffer>}} [opts]
 * @returns {Promise<AttestOutcome & {seq?: number, sha256?: string}>}
 */
async function captureBase(docId, opts = {}) {
  let doc = null;
  const out = await serialize(docId, async () => {
    doc = store.sharedDocs.get(docId);
    if (!doc) return { status: 404, code: 'NOT_FOUND', message: `Shared document "${docId}" not found` };
    const bytes = await (opts.read || readRegistered)(doc);
    const { doc: current, refusal } = currentRegistration(doc);
    if (refusal) return refusal;
    const denied = opts.recheck ? opts.recheck(current) : null;
    if (denied) return denied;
    doc = current;
    const recorded = recordObservation(current, bytes, 'base');
    return { status: 200, seq: recorded.revision.seq, sha256: recorded.revision.sha256, recorded };
  });
  if (out.recorded) {
    dispatch(out.recorded, doc);
    delete out.recorded;
  }
  return out;
}

/**
 * Why bytes are not the caller's attestable edit, or null when they are: the
 * digest read must be the one the caller named, and the revision before it
 * must be the caller's saved base. The one statement of the binding rule,
 * for new bytes and for bytes the record already holds alike.
 * @param {{sha256: string, priorSha256: (string|null)}} observed - What was read, and what preceded it
 * @param {{sha256: string, baseSha256: string}} req - What the caller named
 * @returns {AttestOutcome|null}
 */
function editRefusal(observed, req) {
  if (observed.sha256 !== req.sha256) {
    return { status: 409, code: 'DIGEST_MISMATCH', message: `The file now reads ${observed.sha256}, not the digest named` };
  }
  if (observed.priorSha256 !== req.baseSha256) {
    return {
      status: 409, code: 'BASE_MISMATCH',
      message: 'A revision was observed between the base and this edit, or the base was never recorded: the edit is not attested'
    };
  }
  return null;
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
 * await between them — read the registration again (a path or group changed,
 * or the doc unregistered, during the read voids it), re-run `recheck` against
 * that current registration (the caller's access and its lock, which may have
 * expired or changed during the read), decide whether the bytes are the
 * caller's edit, and record. New bytes that are the caller's edit are recorded,
 * bound and routed with the author known, in one transaction. New bytes that
 * are not (an intervening write, a digest the caller did not name) are
 * recorded `unknown` and routed as any observation, to subscribers at most, and
 * the attestation is refused. Bytes the record already holds are bound only if
 * they still qualify, and their binding and routing commit together. Bytes
 * overwritten before any observation cannot be reconstructed, so they are
 * neither recorded nor refused.
 *
 * Binds only when the newest revision's digest is `sha256` and its prior
 * digest is `baseSha256`. A no-op (`sha256` equal to `baseSha256`) never
 * claims an earlier revision. The same session re-attesting the same
 * revision is answered `already` and sends nothing; any other caller is
 * refused. A revision whose delivery was interrupted may still be bound, and
 * sends nothing.
 * @param {string} docId - Shared doc id
 * @param {{baseSha256: string, sha256: string, projectId: number, sessionId: number,
 *   recheck: function(object): (AttestOutcome|null), read?: function(object): Promise<Buffer>}} req -
 *   `recheck` is given the doc as registered after the read
 * @returns {Promise<AttestOutcome & {delivery?: Promise<DeliveryCounts>}>} `delivery` never rejects
 */
async function attest(docId, req) {
  if (req.sha256 === req.baseSha256) {
    return {
      status: 409, code: 'NO_CHANGE',
      message: 'The digest named is the base digest: there is no edit to attest, and an earlier revision is never claimed'
    };
  }
  let doc = null;
  let toSend = null;
  const outcome = await serialize(docId, async () => {
    doc = store.sharedDocs.get(docId);
    if (!doc) return { status: 404, code: 'NOT_FOUND', message: `Shared document "${docId}" not found` };
    let bytes;
    try {
      bytes = await (req.read || readRegistered)(doc);
    } catch (err) {
      if (err.code !== 'UNREADABLE') throw err;
      return { status: 409, code: 'UNREADABLE', message: err.message };
    }
    // From here to the bind nothing awaits: the checks, the record, the
    // binding and the routing are one step, made against the registration as
    // it stands after the read.
    const { doc: current, refusal: changed } = currentRegistration(doc);
    if (changed) return changed;
    const refusal = req.recheck(current);
    if (refusal) return refusal;
    doc = current;
    const author = { projectId: req.projectId, sessionId: req.sessionId };
    let refused = null;
    const recorded = recordObservation(current, bytes, 'attest', new Date(), {
      bind: (observed) => {
        refused = editRefusal(observed, req);
        return refused ? null : author;
      }
    });
    const revision = recorded.revision;
    if (!recorded.duplicate) {
      toSend = recorded;
      return refused || { status: 200, already: false, revision };
    }
    if (revision.sha256 !== req.sha256) return editRefusal(revision, req);
    if (revision.authorSource === 'attested') {
      if (revision.authorSessionId === req.sessionId && revision.authorProjectId === req.projectId) {
        return { status: 200, already: true, revision };
      }
      return { status: 409, code: 'ALREADY_ATTESTED', message: 'This revision is already attested by another session' };
    }
    const notMine = editRefusal(revision, req);
    if (notMine) return notMine;
    let intentIds = [];
    const bound = store.sharedDocEvents.attest(revision.id, {
      ...author,
      attestedAt: new Date().toISOString(),
      shadowWouldSelect: wouldSelect(revision, req.projectId)
    }, { route: routeFor(current, req.projectId), onRouted: (ids) => { intentIds = ids; } });
    if (!bound) return { status: 409, code: 'ALREADY_ATTESTED', message: 'This revision is already attested' };
    const latest = store.sharedDocEvents.latest(docId);
    toSend = { revision: latest, intentIds };
    return { status: 200, already: false, revision: latest };
  });
  if (toSend) outcome.delivery = dispatch(toSend, doc);
  return outcome;
}

module.exports = {
  limits,
  noticeDocId,
  sha256,
  normalizeText,
  memberKeys,
  parseDoc,
  classify,
  wouldSelect,
  memberSettings,
  effectiveSettings,
  selectRecipients,
  serialize,
  recordObservation,
  observe,
  captureBase,
  attest,
  sendIntents,
  drain
};
