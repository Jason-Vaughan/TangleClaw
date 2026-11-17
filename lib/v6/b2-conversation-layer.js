'use strict';

/**
 * v6 (#2982, V6-09 / B2, Car V60-T2-W1-A, BRIDGE-1c): the Native
 * Conversation Layer's ledger — append/read/soft-delete over
 * `conversation_events` (DDL in `lib/store/_schema.js#_v6B2ConversationLayerDdl`,
 * not here), the Tier-A/B adapter classifier, and the interrupt-support
 * decision #2982 deliverable 2 names.
 *
 * Issue #2982 is large (4 deliverables: the ledger itself; queue-priority
 * vs. engine-verified interrupt; pre-persistence redaction and SQLite
 * secure-overwrite deletion; lazy Open Hood/ttyd). This car's envelope is
 * `lib/store/_schema.js` (additive only) + `lib/v6/b2-conversation-layer.js`
 * + tests — zero `server.js`, zero `lib/secret-redactor.js`, zero
 * `lib/tmux.js` edits. So this module ships:
 *
 * - {@link appendEvent} / {@link getEvents} / {@link softDeleteEvent} — the
 *   ledger's own read/write/soft-delete, decoupled from any route. Redaction
 *   is the CALLER's job (`lib/secret-redactor.js`, out of this car's
 *   envelope) before it ever calls `appendEvent`; this module only records
 *   whether that happened (`redacted`).
 * - {@link classifyAdapterTier} — the Tier-A (`claude`, `codex`,
 *   `antigravity`) / Tier-B (`aider`) mapping #2982 names.
 * - {@link checkInterruptSupport} — the exact decision #2982 deliverable 2
 *   describes (fail closed with `INTERRUPT_UNSUPPORTED_BY_ENGINE` absent an
 *   `interruptContract`), decoupled from the HTTP route that will call it.
 *
 * NOT in this car: the `.../messages/:id/prioritize` and `.../conversation/
 * interrupt` HTTP routes, the real Tier-A/B adapter implementations wired to
 * live engines, the secure-overwrite `DELETE` route (`PRAGMA secure_delete`,
 * `tmux clear-history`, `residual_locations[]`), and Open Hood/ttyd — all
 * named in #2982 as `BRIDGE-1`/`BRIDGE-2`/`BRIDGE-4`/`BRIDGE-5` work.
 *
 * `{ok, code}` returns, injectable `now`, same house style
 * `lib/v6/c1-logical-projects.js`/`lib/v6/e5-kaizen-ledger.js` already share
 * — this is the first module in this wave that actually mutates a database.
 *
 * #3107 (Car V650-W1-A, pipelined via Guardrail 06 onto this otherwise-idle
 * lane): a second, unrelated section below — rich link unfurling & inline
 * media/artifact previews for v6 chat. Classification and parsing only:
 * - {@link classifyMediaOrArtifactLink} / {@link extractRichPreviewsFromMessage} —
 *   local (zero-external-leak-risk) image/video/artifact/code-line-range
 *   card models from a message's text.
 * - {@link parseGitHubEntityUrl} / {@link parseOpenGraphHtml} — structured
 *   GitHub PR/Issue/Release and Open Graph metadata parsing.
 * - {@link evaluateUnfurlTargetSafety} — the SSRF guard a server-side
 *   unfurl fetch must consult before dereferencing an external URL.
 *
 * NOT in this car either: the server-side unfurl HTTP route that actually
 * fetches a URL (and so is the one place that must ALSO re-validate the
 * resolved IP at connect time — see {@link evaluateUnfurlTargetSafety}'s own
 * scope note), and the `public/v6-shell.js` rendering these card models
 * feed. Ruling A752 (external media needs a viewer opt-in before it is
 * ever auto-rendered, not just SSRF-safe to fetch) is the renderer's
 * responsibility to enforce; this module only carries the data it needs to.
 *
 * @module lib/v6/b2-conversation-layer
 */

/** Structured, engine-native adapters (#2982 deliverable 1). */
const TIER_A_ADAPTERS = Object.freeze(['claude', 'codex', 'antigravity']);
/** Pane-derived fallback adapters, "Terminal-Derived (Degraded Fidelity)" (#2982 deliverable 1). */
const TIER_B_ADAPTERS = Object.freeze(['aider']);

const ROLES = Object.freeze(['user', 'assistant', 'system', 'tool']);

/**
 * Which tier an adapter belongs to.
 * @param {string} adapter
 * @returns {'A'|'B'|null} `null` for an adapter neither list names — the
 *   caller decides whether that is a refusal or a to-be-classified gap, not
 *   this function silently guessing.
 */
function classifyAdapterTier(adapter) {
  if (TIER_A_ADAPTERS.includes(adapter)) return 'A';
  if (TIER_B_ADAPTERS.includes(adapter)) return 'B';
  return null;
}

/**
 * Append one conversation event, deduplicating Tier-B pane-derived rows by
 * the exact `(launch_id, pane_cursor_watermark, rolling_line_sha256)` key
 * #2982 names — a replay of the same pane line across a `SIGWINCH`/
 * reconnect is reported `DEDUPED` (not an error) rather than inserted
 * twice. `degraded_fidelity` is derived from `tier`, never caller-supplied,
 * so a record can't claim Tier A while also being marked degraded.
 *
 * PRR-A R1 HOLD (Ruling A567-PR3014-R1-HOLD-RECONCILED): `tier` must agree
 * with {@link classifyAdapterTier}`(adapter)` whenever that function
 * recognizes the adapter — `aider` cannot claim Tier A, nor `claude` Tier
 * B. And because Tier B's whole reason to exist is the dedup key above,
 * a Tier-B event is refused outright unless it carries BOTH a real
 * `paneCursorWatermark` and a real 64-hex `rollingLineSha256` — a Tier-B
 * row with either missing would never be deduplicated by the UNIQUE index
 * at all (NULL is distinct from NULL in SQLite), silently defeating the
 * one property Tier B needs.
 *
 * PRR-A R2 HOLD (Ruling A573-PR3014-R2-HOLD-RECONCILED): `paneCursorWatermark`
 * defaults to `null`, not `0` — defaulting to `0` meant OMITTING it for a
 * Tier-B event silently passed the "a real watermark is present" check,
 * since `0` is itself a valid safe non-negative integer. `rollingLineSha256`
 * is lower-cased before it is ever compared or stored — SQLite's `UNIQUE`
 * index is case-sensitive, so `"b".repeat(64)` and `"B".repeat(64)`
 * described the exact same pane line but would not have deduplicated
 * against each other.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, sessionId: number, launchId: string, seq: number,
 *   tier: ('A'|'B'), adapter: string, role: ('user'|'assistant'|'system'|'tool'),
 *   content: string, paneCursorWatermark?: number|null, rollingLineSha256?: string|null,
 *   redacted?: boolean, now?: Function}} args
 * @returns {{ok: boolean, code: string, id?: number, message?: string}}
 */
function appendEvent(db, {
  projectId, sessionId, launchId, seq, tier, adapter, role, content,
  paneCursorWatermark = null, rollingLineSha256 = null, redacted = false,
  now = () => new Date().toISOString()
}) {
  if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(sessionId) ||
    typeof launchId !== 'string' || !launchId || launchId.length > 128 ||
    !Number.isSafeInteger(seq) || seq < 1 || !['A', 'B'].includes(tier) ||
    typeof adapter !== 'string' || !adapter || adapter.length > 40 ||
    !ROLES.includes(role) || typeof content !== 'string') {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const watermarkShapeOk = paneCursorWatermark === null
    || (Number.isSafeInteger(paneCursorWatermark) && paneCursorWatermark >= 0);
  if (!watermarkShapeOk) return { ok: false, code: 'INVALID_REQUEST' };
  const hashShapeOk = rollingLineSha256 === null
    || (typeof rollingLineSha256 === 'string' && /^[0-9a-f]{64}$/i.test(rollingLineSha256));
  if (!hashShapeOk) return { ok: false, code: 'INVALID_REQUEST' };
  const normalizedSha256 = typeof rollingLineSha256 === 'string' ? rollingLineSha256.toLowerCase() : null;

  const declaredTier = classifyAdapterTier(adapter);
  if (declaredTier && tier !== declaredTier) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'tier does not match adapter classification' };
  }
  if (tier === 'B') {
    const watermarkPresent = Number.isSafeInteger(paneCursorWatermark) && paneCursorWatermark >= 0;
    const hashPresent = normalizedSha256 !== null;
    if (!watermarkPresent || !hashPresent) {
      return { ok: false, code: 'INVALID_REQUEST', message: 'Tier B pane events require paneCursorWatermark and 64-hex rollingLineSha256' };
    }
  }
  const effectiveWatermark = paneCursorWatermark === null ? 0 : paneCursorWatermark;

  if (normalizedSha256 !== null) {
    const dup = db.prepare(
      'SELECT id FROM conversation_events WHERE launch_id = ? AND pane_cursor_watermark = ? AND rolling_line_sha256 = ?'
    ).get(launchId, effectiveWatermark, normalizedSha256);
    if (dup) return { ok: true, code: 'DEDUPED', id: dup.id };
  }
  const seqTaken = db.prepare('SELECT id FROM conversation_events WHERE session_id = ? AND seq = ?').get(sessionId, seq);
  if (seqTaken) return { ok: false, code: 'SEQ_CONFLICT' };
  const degradedFidelity = tier === 'B' ? 1 : 0;
  const info = db.prepare(
    'INSERT INTO conversation_events (project_id, session_id, launch_id, seq, tier, adapter, role, content, '
    + 'degraded_fidelity, pane_cursor_watermark, rolling_line_sha256, redacted, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(projectId, sessionId, launchId, seq, tier, adapter, role, content, degradedFidelity,
    effectiveWatermark, normalizedSha256, redacted ? 1 : 0, now());
  return { ok: true, code: 'APPENDED', id: Number(info.lastInsertRowid) };
}

/**
 * Replay a session's events in seq order.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionId: number, sinceSeq?: number, includeDeleted?: boolean}} args
 * @returns {Array<object>}
 */
function getEvents(db, { sessionId, sinceSeq = 0, includeDeleted = false }) {
  const clause = includeDeleted ? '' : 'AND deleted_at IS NULL';
  return db.prepare(
    `SELECT * FROM conversation_events WHERE session_id = ? AND seq > ? ${clause} ORDER BY seq ASC`
  ).all(sessionId, sinceSeq);
}

/**
 * Soft-delete one event by stamping `deleted_at` — the schema-level marker
 * a future secure-overwrite DELETE route (`PRAGMA secure_delete = ON` +
 * `wal_checkpoint(TRUNCATE)` + `tmux clear-history`, out of this car's
 * envelope) would act on. This function does not itself overwrite or purge
 * row content.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: number, sessionId: number, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function softDeleteEvent(db, { id, sessionId, now = () => new Date().toISOString() }) {
  const changed = db.prepare(
    'UPDATE conversation_events SET deleted_at = ? WHERE id = ? AND session_id = ? AND deleted_at IS NULL'
  ).run(now(), id, sessionId).changes;
  return changed === 1 ? { ok: true, code: 'DELETED' } : { ok: false, code: 'NOT_FOUND_OR_ALREADY_DELETED' };
}

/**
 * The interrupt-support decision (#2982 deliverable 2): engine-verified
 * interruption requires the engine's own `interruptContract`; absent one,
 * fail closed with the exact code #2982 names, rather than attempting a
 * signal an engine never promised to honor.
 * @param {{interruptContract?: *}|null|undefined} engineProfile
 * @returns {{allowed: boolean, code?: string}}
 */
function checkInterruptSupport(engineProfile) {
  if (engineProfile && engineProfile.interruptContract) return { allowed: true };
  return { allowed: false, code: 'INTERRUPT_UNSUPPORTED_BY_ENGINE' };
}

// ─────────────────────────────────────────────────────────────────────────
// #3107 (Car V650-W1-A): rich link unfurling & inline media/artifact
// previews — classification and parsing only. No fetch, no route, no
// `public/v6-shell.js` rendering: this module decides WHAT a reference in a
// message's text is and whether an external target is even safe to ask the
// real network for later; the server-side unfurl route that actually fetches
// a URL's HTML (and the chat UI that renders these card models) are other
// cars' envelopes.
// ─────────────────────────────────────────────────────────────────────────

const net = require('node:net');
const path = require('node:path');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

/** Extensions {@link classifyMediaOrArtifactLink} renders as an image card. */
const IMAGE_EXTENSIONS = Object.freeze(new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']));
/** Extensions {@link classifyMediaOrArtifactLink} renders as a video card, mapped to the HTML5 `<video>` `type`. */
const VIDEO_MIME_TYPES = Object.freeze({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' });
/**
 * Extensions {@link classifyMediaOrArtifactLink} renders as an artifact card
 * even with no `#L<n>-L<n>` line range (a `.md` plan or `.html` sprint
 * report is "the artifact itself", not a line inside a larger source file).
 */
const ARTIFACT_EXTENSIONS = Object.freeze(new Set(['md', 'html']));

/**
 * `secrets/<file>`, with or without the whole-line `Attached: ` prefix
 * `public/v6-shell.js`'s `ATTACHED_LINE` convention uses (#3082) — the
 * prefix is optional so a BARE `secrets/<file>` TOKEN found mid-sentence
 * still matches too (PRR-B R1: without it, a whole `Attached: secrets/x`
 * LINE never matched here at all, only ever classifying by accident via
 * the token-scan fallback on its second word).
 */
const SECRETS_REF = /^(?:Attached:\s*)?(?:\.tangleclaw\/)?secrets\/([A-Za-z0-9._-]{1,128})$/;
/** A reference rooted at the workspace: `/abs/path`, `./rel/path`, `../rel/path`, or `~/path`. Requires a path-like prefix so ordinary prose ("version 2.1 shipped") is never misread as a file reference. */
const WORKSPACE_PATH = /^(?:\.{1,2}\/|\/|~\/)\S+$/;
/** A `#L<start>` or `#L<start>-L<end>` code line-range suffix on a path or `file://` URL. */
const LINE_RANGE_SUFFIX = /#L(\d+)(?:-L(\d+))?$/;

/**
 * Split a trailing `#L<n>-L<n>` code line-range off a reference, so the base
 * path can be classified by extension independently of whether a range was
 * named. A line is 1-indexed and a range's end cannot precede its start —
 * `#L0` or an inverted `#L20-L10` is not a valid range at all (PRR-B R1), so
 * it is left attached to `base` rather than split off: the base string then
 * almost certainly fails extension classification too, which is the
 * intended "reject the whole reference" outcome.
 * @param {string} ref
 * @returns {{base: string, lineRange: ({start: number, end: number}|null)}}
 */
function _splitLineRange(ref) {
  const m = LINE_RANGE_SUFFIX.exec(ref);
  if (!m) return { base: ref, lineRange: null };
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  if (start < 1 || end < start) return { base: ref, lineRange: null };
  return { base: ref.slice(0, m.index), lineRange: { start, end } };
}

/**
 * A `file://` URL's filesystem path, or `null` if `url` is not one. Uses the
 * WHATWG `URL` parser rather than hand-rolled regex surgery, so percent-
 * encoding in the path is decoded correctly.
 * @param {string} url
 * @returns {string|null}
 */
function _fileUrlToPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? decodeURIComponent(parsed.pathname) : null;
  } catch {
    return null;
  }
}

/**
 * The lowercased extension (no dot) of a POSIX-style path, or `null` for a
 * path with none. `path.posix`, not the platform `path`, so a Windows CI
 * runner classifies the same workspace-style forward-slash paths this
 * module's own callers use identically to a Mac/Linux one.
 * @param {string} filePath
 * @returns {string|null}
 */
function _extensionOf(filePath) {
  const ext = path.posix.extname(filePath);
  return ext.length > 1 ? ext.slice(1).toLowerCase() : null;
}

/**
 * Classify one LOCAL media/artifact reference — a secrets-store filename,
 * a `file://` URL, or a workspace-rooted path, optionally with a `#L<n>-
 * L<n>` code line range — into a rich preview card model. Zero external
 * leak risk (#3107 scope note 1): every source this recognizes is local to
 * this machine, so unlike an external link, building this card never
 * dereferences a remote host.
 *
 * Deliberately returns `null`, not a guess, for anything this cannot place:
 * an unrecognized source form, an unrecognized extension with no line
 * range, or a line range on an image/video (a frame range makes no sense
 * for either).
 * @param {string} ref - One reference, already extracted from message text.
 * @returns {({kind: 'image', path: string, source: string, zoomable: true}|
 *   {kind: 'video', path: string, source: string, mimeType: string, preload: 'metadata', controls: true}|
 *   {kind: 'artifact', path: string, source: string, fileExtension: (string|null), title: string, lineRange: ({start:number,end:number}|null)}|
 *   null)}
 */
function classifyMediaOrArtifactLink(ref) {
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;

  const { base, lineRange } = _splitLineRange(trimmed);

  let source;
  let filePath;
  const secretsMatch = SECRETS_REF.exec(base);
  if (secretsMatch) {
    source = 'secrets';
    filePath = secretsMatch[1];
  } else if (/^file:\/\//i.test(base)) {
    filePath = _fileUrlToPath(base);
    if (filePath == null) return null;
    source = 'file-url';
  } else if (WORKSPACE_PATH.test(base)) {
    source = 'workspace';
    filePath = base;
  } else {
    return null;
  }

  const ext = _extensionOf(filePath);

  if (ext && IMAGE_EXTENSIONS.has(ext)) {
    if (lineRange) return null;
    return { kind: 'image', path: filePath, source, zoomable: true };
  }
  if (ext && VIDEO_MIME_TYPES[ext]) {
    if (lineRange) return null;
    return { kind: 'video', path: filePath, source, mimeType: VIDEO_MIME_TYPES[ext], preload: 'metadata', controls: true };
  }
  if ((ext && ARTIFACT_EXTENSIONS.has(ext)) || lineRange) {
    return { kind: 'artifact', path: filePath, source, fileExtension: ext, title: path.posix.basename(filePath), lineRange };
  }
  return null;
}

/** `github.com/<owner>/<repo>/(pull|issues|releases/tag)/<id>`, with or without a trailing slash or further path/query/fragment. */
const GITHUB_ENTITY_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})\/(pull|issues|releases\/tag)\/([^/?#\s]+)/i;

/**
 * Parse a GitHub PR, Issue, or Release URL into a structured card model, or
 * `null` for anything else (including a well-formed `github.com` URL this
 * repo-level PR/issue/release shape does not match — a profile, a repo
 * root, a commit, a file blob).
 * @param {string} url
 * @returns {({owner: string, repo: string, entityKind: 'pull', number: number}|
 *   {owner: string, repo: string, entityKind: 'issue', number: number}|
 *   {owner: string, repo: string, entityKind: 'release', tag: string}|
 *   null)}
 */
function parseGitHubEntityUrl(url) {
  if (typeof url !== 'string') return null;
  const m = GITHUB_ENTITY_URL.exec(url.trim());
  if (!m) return null;
  const [, owner, repo, kindRaw, idRaw] = m;
  const kind = kindRaw.toLowerCase();
  if (kind === 'pull' || kind === 'issues') {
    const number = Number(idRaw);
    if (!Number.isInteger(number) || number < 1) return null;
    return { owner, repo, entityKind: kind === 'pull' ? 'pull' : 'issue', number };
  }
  try {
    return { owner, repo, entityKind: 'release', tag: decodeURIComponent(idRaw) };
  } catch {
    return null; // a malformed percent-encoding in the tag
  }
}

/** The 4 octets of an IPv4 dotted-quad, packed into one unsigned 32-bit integer. */
function _ipv4ToInt(parts) {
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/**
 * Whether `ipInt` falls inside `{base, bits}` (a CIDR block given as a
 * dotted-quad base and prefix length).
 * @param {number} ipInt - Packed via {@link _ipv4ToInt}.
 * @param {{base: number[], bits: number}} range
 * @returns {boolean}
 */
function _ipv4InRange(ipInt, range) {
  const baseInt = _ipv4ToInt(range.base);
  const mask = range.bits === 0 ? 0 : ((0xFFFFFFFF << (32 - range.bits)) >>> 0);
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
}

const IPV4_LOOPBACK = Object.freeze({ base: [127, 0, 0, 0], bits: 8 });
const IPV4_LINK_LOCAL = Object.freeze({ base: [169, 254, 0, 0], bits: 16 });
/**
 * RFC1918 private ranges, `0.0.0.0/8` ("this network"), and RFC6598's
 * shared/CGNAT space `100.64.0.0/10` — the range Tailscale's own mesh
 * addresses (`*.ts.net`, as this very deployment uses) live in, so an
 * SSRF guard that omitted it would treat a tailnet-internal target as a
 * public one (PRR-B R1). None of these should a public unfurl target ever
 * resolve to.
 */
const IPV4_PRIVATE_RANGES = Object.freeze([
  Object.freeze({ base: [10, 0, 0, 0], bits: 8 }),
  Object.freeze({ base: [172, 16, 0, 0], bits: 12 }),
  Object.freeze({ base: [192, 168, 0, 0], bits: 16 }),
  Object.freeze({ base: [0, 0, 0, 0], bits: 8 }),
  Object.freeze({ base: [100, 64, 0, 0], bits: 10 })
]);

/**
 * Why `ip` (a literal IPv4 dotted-quad, already confirmed by `net.isIPv4`)
 * is unsafe to let this server fetch, or `null` if it is not loopback,
 * link-local, or a private range.
 * @param {string} ip
 * @returns {('LOOPBACK'|'LINK_LOCAL'|'PRIVATE_RANGE'|null)}
 */
function _ipv4UnsafeReason(ip) {
  const parts = ip.split('.').map(Number);
  const ipInt = _ipv4ToInt(parts);
  if (_ipv4InRange(ipInt, IPV4_LOOPBACK)) return 'LOOPBACK';
  if (_ipv4InRange(ipInt, IPV4_LINK_LOCAL)) return 'LINK_LOCAL';
  if (IPV4_PRIVATE_RANGES.some((range) => _ipv4InRange(ipInt, range))) return 'PRIVATE_RANGE';
  return null;
}

/**
 * Expand a literal IPv6 address (already confirmed by `net.isIPv6`) into
 * its 8 16-bit groups as integers, resolving a single `::` run, or `null`
 * if it does not parse into exactly 8. `URL`'s own `hostname` normalizes an
 * IPv4-mapped literal into pure hex groups (`::ffff:10.0.0.1` becomes
 * `::ffff:a00:1`, never the dotted form) — this is what lets
 * {@link _ipv6UnsafeReason} recover the embedded IPv4 from THAT shape, not
 * a dotted-quad suffix that normalized input will not actually contain.
 * @param {string} ip
 * @returns {(number[]|null)}
 */
function _expandIpv6Groups(ip) {
  const sides = ip.split('::');
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  let groups;
  if (sides.length === 1) {
    groups = ip.split(':');
    if (groups.length !== 8) return null;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  const parsed = groups.map((g) => (g === '' ? 0 : parseInt(g, 16)));
  return parsed.length === 8 && parsed.every((n) => Number.isInteger(n)) ? parsed : null;
}

/**
 * Why `ip` (a literal IPv6 address, already confirmed by `net.isIPv6`) is
 * unsafe to let this server fetch, or `null` otherwise. An IPv4-mapped
 * address (`::ffff:0:0/96`) is checked as its embedded IPv4 — the whole
 * point of that form is to BE that address on a dual-stack socket, so
 * hiding behind the IPv6 spelling must not bypass the IPv4 ranges above.
 * @param {string} ip
 * @returns {('LOOPBACK'|'LINK_LOCAL'|'PRIVATE_RANGE'|null)}
 */
function _ipv6UnsafeReason(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return 'LOOPBACK';
  const groups = _expandIpv6Groups(normalized);
  if (groups && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const ipv4 = [(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff].join('.');
    return _ipv4UnsafeReason(ipv4);
  }
  const firstGroup = groups ? groups[0] : parseInt(normalized.split(':')[0] || '0', 16);
  if (Number.isNaN(firstGroup)) return null;
  if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return 'LINK_LOCAL'; // fe80::/10
  if (firstGroup >= 0xfc00 && firstGroup <= 0xfdff) return 'PRIVATE_RANGE'; // fc00::/7 (unique local)
  return null;
}

/**
 * The first line of this server's SSRF defense for a link-unfurl target
 * (#3107): refuse a non-`http(s)` scheme outright, and refuse a literal
 * loopback, link-local, or private-range IP (IPv4 or IPv6, `localhost`
 * included) before this server ever opens a connection to it.
 *
 * This checks the URL's LITERAL host; it does not resolve DNS. A bare
 * hostname (not already a literal IP) is reported safe here because this
 * function has no resolver to check it with — the caller that performs the
 * real fetch MUST independently validate the IP it actually connects to
 * (not just the one this synchronous, resolver-free check could see), or a
 * DNS-rebinding target (a public name that later resolves to `127.0.0.1`)
 * passes this gate and still reaches an internal address at fetch time.
 * @param {string} url
 * @returns {{safe: boolean, reason: ('LOOPBACK'|'LINK_LOCAL'|'PRIVATE_RANGE'|'UNSUPPORTED_SCHEME'|'INVALID_URL'|null)}}
 */
/**
 * Hosts #3139 names as always previewable in-pane, since links to them are
 * self-published or tailnet-scoped rather than arbitrary public targets: a
 * suffix match admits every subdomain (`cursatory.tail123678.ts.net` under
 * `ts.net`; any GitHub Pages site under `github.io`), and `tangleclaw.com`
 * is matched as itself or any of its own subdomains.
 *
 * Deliberately NOT `localhost`/`127.0.0.1`/PortHub ports, even though
 * #3139's own LANE_QUEUE row names them too (flagged to the Architect,
 * 2026-11-17, before building this): those name THIS SERVER's other local
 * services, not a chat message's own target, so admitting them here would
 * let an arbitrary chat link reach whatever else runs on this host's
 * loopback — a materially larger SSRF relaxation than the three domains
 * below, which this synchronous classifier is not the place to decide
 * (a PortHub-port allowlist needs a live, async lease lookup).
 * @type {string[]}
 */
const UNFURL_ALLOWLISTED_HOSTS = Object.freeze(['ts.net', 'github.io', 'tangleclaw.com']);

/**
 * Whether `hostname` is one of {@link UNFURL_ALLOWLISTED_HOSTS} or a
 * subdomain of one.
 *
 * Not yet consulted by {@link evaluateUnfurlTargetSafety}'s own literal
 * check below — a bare hostname that is not already an IP literal passes
 * that check regardless (see its own doc comment), so every host this
 * function admits already passes it today, and wiring this in there would
 * be a no-op. The real refusal for a Tailscale link happens one layer up,
 * in `server.js#_v6SafeUnfurlFetch`'s per-RESOLVED-ADDRESS recheck, which
 * rebuilds a synthetic URL from the raw resolved IP and so has no hostname
 * left to check this against — exported for THAT caller to consult with
 * the ORIGINAL hostname once it is wired to do so (flagged to TC-Lane-PM,
 * 2026-11-17: `server.js` is outside this car's file scope).
 * @param {string} hostname - Already lower-cased/trimmed by the caller, or
 *   raw — this function normalizes it itself either way.
 * @returns {boolean}
 */
function isAllowlistedUnfurlHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  const h = hostname.toLowerCase().replace(/\.+$/, '');
  return UNFURL_ALLOWLISTED_HOSTS.some((base) => h === base || h.endsWith(`.${base}`));
}

/**
 * Ports Ruling A827 (#3139, 2026-11-17) treats as this server's own
 * self-published preview surface: a loopback address, or this host's own
 * Tailscale CGNAT/ULA address with no `originalHostname` given, is safe to
 * unfurl ONLY when the URL names one of these — never the server's real
 * API port (`:3102`) or Medusa's ports (`:3009`/`:3010`), and never with no
 * port at all. A caller on any other port gets the same `LOOPBACK` refusal
 * it always has.
 * @type {Set<string>}
 */
const SELF_PUBLISHED_PREVIEW_PORTS = Object.freeze(new Set(['3410', '3425', '3426', '3430', '5080', '8443']));

/** Tailscale's own CGNAT block — a NAMED subset of {@link IPV4_PRIVATE_RANGES}'s `100.64.0.0/10` entry, so {@link evaluateUnfurlTargetSafety} can recognize it specifically rather than granting a blanket private-range pass. */
const IPV4_TAILSCALE_CGNAT = Object.freeze({ base: [100, 64, 0, 0], bits: 10 });

/** Tailscale's own IPv6 ULA prefix (`fd7a:115c:a1e0::/48`), as its first 3 16-bit groups. */
const IPV6_TAILSCALE_ULA_PREFIX = Object.freeze([0xfd7a, 0x115c, 0xa1e0]);

/** @param {string} ip - Already confirmed IPv4. @returns {boolean} */
function _isTailscaleCgnatIpv4(ip) {
  return _ipv4InRange(_ipv4ToInt(ip.split('.').map(Number)), IPV4_TAILSCALE_CGNAT);
}

/** @param {string} ip - Already confirmed IPv6. @returns {boolean} */
function _isTailscaleUlaIpv6(ip) {
  const groups = _expandIpv6Groups(ip.toLowerCase());
  return !!groups && IPV6_TAILSCALE_ULA_PREFIX.every((g, i) => groups[i] === g);
}

/** @param {string|null} hostname - Already lower-cased/dot-trimmed, or `null`. @returns {boolean} */
function _isTailnetHostname(hostname) {
  return hostname !== null && (hostname === 'ts.net' || hostname.endsWith('.ts.net'));
}

/**
 * The first line of this server's SSRF defense for a link-unfurl target
 * (#3107, widened by Ruling A827 / #3139): refuse a non-`http(s)` scheme
 * outright, and refuse a loopback, link-local, or private-range address
 * (IPv4 or IPv6, `localhost` included) — with two named, narrow exceptions,
 * neither a blanket relaxation of the guard:
 *
 * 1. **This server's own self-published preview surface**: a loopback
 *    address (`localhost`/`127.0.0.1`/`[::1]`), or its own Tailscale
 *    CGNAT/ULA address named with no `opts.originalHostname` at all, is
 *    safe ONLY on one of {@link SELF_PUBLISHED_PREVIEW_PORTS} — never on
 *    this server's real API port, Medusa's ports, or any other.
 * 2. **A `*.ts.net` hostname's own resolved address**: when the CALLER
 *    (the one place that resolves DNS — see this function's own original
 *    doc note below) has already resolved `opts.originalHostname` to a
 *    literal address and asks THIS function to validate that address, a
 *    `*.ts.net` origin's own Tailscale CGNAT/ULA resolution is safe
 *    regardless of port — but a `*.ts.net` name resolving to any OTHER
 *    private range (RFC1918, link-local) is still refused: the exception is
 *    for Tailscale's own address space specifically, never a free pass for
 *    every private range once a hostname happens to look right.
 *
 * This checks the URL's LITERAL host; it does not resolve DNS itself. A
 * bare hostname (not already a literal IP) is reported safe here because
 * this function has no resolver to check it with — the caller that
 * performs the real fetch MUST independently validate the IP it actually
 * connects to (not just the one this synchronous, resolver-free check could
 * see), or a DNS-rebinding target (a public name that later resolves to
 * `127.0.0.1`) passes this gate and still reaches an internal address at
 * fetch time. {@link safeUnfurlFetch} is that caller for this module's own
 * fetches, and passes `opts.originalHostname` for exactly this reason.
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.originalHostname] - The hostname `url`'s address
 *   was resolved FROM, when `url` itself already names a literal resolved
 *   address (the caller's own re-check after DNS resolution) rather than
 *   the original request's own hostname. Omit when `url` IS the original,
 *   unresolved request.
 * @returns {{safe: boolean, reason: ('LOOPBACK'|'LINK_LOCAL'|'PRIVATE_RANGE'|'UNSUPPORTED_SCHEME'|'INVALID_URL'|null)}}
 */
function evaluateUnfurlTargetSafety(url, opts = {}) {
  if (typeof url !== 'string' || !url.trim()) return { safe: false, reason: 'INVALID_URL' };
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { safe: false, reason: 'INVALID_URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'UNSUPPORTED_SCHEME' };
  }
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  // A trailing DNS root dot ("localhost.") names the exact same host as
  // "localhost" and must not bypass this check (PRR-B R1); RFC 6761
  // reserves the whole `.localhost` TLD as loopback too, not just the bare
  // name, so `foo.localhost` is refused the same way.
  const cleanHost = hostname.replace(/\.+$/, '');
  const onPreviewPort = SELF_PUBLISHED_PREVIEW_PORTS.has(parsed.port);
  const originalHostname = typeof opts.originalHostname === 'string'
    ? opts.originalHostname.toLowerCase().replace(/\.+$/, '')
    : null;
  const originalIsTailnet = _isTailnetHostname(originalHostname);

  if (cleanHost === 'localhost' || cleanHost.endsWith('.localhost')) {
    return onPreviewPort ? { safe: true, reason: null } : { safe: false, reason: 'LOOPBACK' };
  }

  if (net.isIPv4(cleanHost)) {
    const reason = _ipv4UnsafeReason(cleanHost);
    if (reason === 'LOOPBACK') return onPreviewPort ? { safe: true, reason: null } : { safe: false, reason: 'LOOPBACK' };
    if (reason === 'PRIVATE_RANGE' && _isTailscaleCgnatIpv4(cleanHost) && (originalIsTailnet || (originalHostname === null && onPreviewPort))) {
      return { safe: true, reason: null };
    }
    return reason ? { safe: false, reason } : { safe: true, reason: null };
  }
  if (net.isIPv6(cleanHost)) {
    const reason = _ipv6UnsafeReason(cleanHost);
    if (reason === 'LOOPBACK') return onPreviewPort ? { safe: true, reason: null } : { safe: false, reason: 'LOOPBACK' };
    if (reason === 'PRIVATE_RANGE' && _isTailscaleUlaIpv6(cleanHost) && (originalIsTailnet || (originalHostname === null && onPreviewPort))) {
      return { safe: true, reason: null };
    }
    return reason ? { safe: false, reason } : { safe: true, reason: null };
  }
  return { safe: true, reason: null };
}

/** A Markdown link's target: `[label](target)`, label never containing `]`, target never containing `)`. */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * Classify one already-extracted reference as a GitHub URL, a generic
 * `http(s)` link-unfurl candidate, or a local media/artifact reference, and
 * push whichever card model it resolves to onto `cards`. Shared by both
 * tokenization paths in {@link extractRichPreviewsFromMessage} so a
 * Markdown link's target and a plain-prose token are classified identically.
 * @param {object[]} cards
 * @param {string} ref
 * @returns {void}
 */
function _pushReferenceCard(cards, ref) {
  if (!ref) return;
  if (/^https?:\/\//i.test(ref)) {
    const gh = parseGitHubEntityUrl(ref);
    if (gh) {
      cards.push({ kind: 'github', url: ref, ...gh });
      return;
    }
    const video = _classifyRemoteVideoUrl(ref);
    if (video) {
      cards.push(video);
      return;
    }
    const safety = evaluateUnfurlTargetSafety(ref);
    cards.push({
      kind: 'link-unfurl-candidate', url: ref, safe: safety.safe, unsafeReason: safety.reason,
      alwaysPreview: _isAllowlistedRefHost(ref)
    });
    return;
  }
  const local = classifyMediaOrArtifactLink(ref);
  if (local) cards.push(local);
}

/**
 * Whether `ref`'s own hostname is one of {@link isAllowlistedUnfurlHost}'s
 * self-published domains (#3139 requirement 2: "always allow & preview
 * self-published / own-host / Tailscale links in-pane") — carried on a
 * card as `alwaysPreview` so the renderer (Wave 2, `public/v6-shell.js`)
 * can show these even with the global "Show preview by default" setting
 * off, without this module knowing anything about that setting itself.
 * @param {string} ref - Already confirmed `http(s)://`.
 * @returns {boolean}
 */
function _isAllowlistedRefHost(ref) {
  try {
    return isAllowlistedUnfurlHost(new URL(ref).hostname);
  } catch {
    return false;
  }
}

/**
 * Classify a remote `http(s)` URL whose PATH (never its query string or
 * fragment) ends in a known video extension as a video-preview card,
 * rather than the generic `'link-unfurl-candidate'` every other `http(s)`
 * reference gets (#3139 root cause 2: sending a multi-megabyte video file
 * to the 512KB HTML-scraping unfurl route hangs it until its own fetch
 * timeout, because the route's own early-termination path destroys the
 * request without ever resolving). Still carries the same SSRF safety
 * verdict {@link evaluateUnfurlTargetSafety} would give any other `http(s)`
 * reference — a video URL is not exempt from that check, only routed to a
 * different renderer (an inline `<video>`, never the HTML scraper) once it
 * is known to be one.
 * @param {string} ref
 * @returns {({kind: 'remote-video', url: string, mimeType: string, safe: boolean, unsafeReason: (string|null)}|null)}
 *   `null` when `ref` does not parse as a URL, or its path names no
 *   recognized video extension.
 */
function _classifyRemoteVideoUrl(ref) {
  let parsed;
  try {
    parsed = new URL(ref);
  } catch {
    return null;
  }
  const ext = path.posix.extname(parsed.pathname);
  const mimeType = ext.length > 1 ? VIDEO_MIME_TYPES[ext.slice(1).toLowerCase()] : undefined;
  if (!mimeType) return null;
  const safety = evaluateUnfurlTargetSafety(ref);
  return { kind: 'remote-video', url: ref, mimeType, safe: safety.safe, unsafeReason: safety.reason, alwaysPreview: isAllowlistedUnfurlHost(parsed.hostname) };
}

/**
 * Strip wrapping punctuation a plain whitespace split leaves on a token:
 * a leading backtick/paren/quote (`` ` ``, `(`, `'`, `"`) a Markdown code
 * span or parenthetical left behind, and the same trailing sentence
 * punctuation as before (`.`, `,`, `)`, `"`, …, now including `` ` ``).
 * @param {string} raw
 * @returns {string}
 */
function _unwrapToken(raw) {
  return raw.replace(/^[(`'"]+/, '').replace(/[),.;:!?'"`]+$/, '');
}

/**
 * Extract every rich preview card this message's text names: a whole line
 * that is itself a local media/artifact reference (the `Attached:` secrets
 * convention), a Markdown link's target (`[label](target)` — read whole, so
 * neither the label nor the wrapping wrecks classification), a `file://`
 * URL/workspace path/GitHub URL embedded in plain prose (optionally
 * backtick- or paren-wrapped), or — for any other `http(s)` URL — a
 * link-unfurl candidate already SSRF-evaluated (never fetched here; see
 * {@link evaluateUnfurlTargetSafety}'s own scope note).
 * @param {string} text - One message's full text (user or assistant turn).
 * @returns {Array<object>} Card models, in the order their references appear.
 */
function extractRichPreviewsFromMessage(text) {
  if (typeof text !== 'string' || !text) return [];
  const cards = [];
  for (const rawLine of text.split('\n')) {
    const wholeLineCard = classifyMediaOrArtifactLink(rawLine.trim());
    if (wholeLineCard) {
      cards.push(wholeLineCard);
      continue; // the whole line IS the reference — don't also token-scan it
    }
    // Markdown links first: a `[label](target)` is read whole and removed
    // from the line, so the label's own words are never separately
    // token-scanned and the target is never broken by the space inside its
    // own brackets (PRR-B R1).
    const line = rawLine.replace(MARKDOWN_LINK, (whole, target) => {
      _pushReferenceCard(cards, target);
      return ' ';
    });
    for (const raw of line.split(/\s+/)) {
      const token = _unwrapToken(raw);
      if (token) _pushReferenceCard(cards, token);
    }
  }
  return cards;
}

/** `og:` meta property → this module's field name. */
const OG_FIELD_MAP = Object.freeze({ title: 'title', description: 'description', image: 'image', video: 'video', site_name: 'siteName' });
const OG_META_TAG = /<meta\s+[^>]*?(?:property|name)\s*=\s*["']og:([a-z_:]+)["'][^>]*?>/gi;
const OG_CONTENT_ATTR = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i;
const HTML_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

/**
 * Decode the handful of HTML entities an `og:` meta tag's `content` commonly
 * carries (`&amp;`, numeric `&#39;`/`&#x27;`, …) — not a full HTML entity
 * table, which this module has no need of beyond attribute text.
 *
 * `html` is fetched from an EXTERNAL host by this module's caller (see the
 * file header) — a numeric entity outside `String.fromCodePoint`'s valid
 * range (`&#9999999;`, beyond `0x10FFFF`) throws `RangeError` uncaught if
 * passed straight through (PRR-B R1: a crash this server's caller would
 * have to catch, triggered by nothing more than malformed/hostile page
 * content), so that range — and the lone-surrogate range `0xD800`-`0xDFFF`,
 * never a valid standalone Unicode scalar value — is rejected the same way
 * an unknown named entity already is: the original `&#…;` text, unchanged.
 * @param {string} str
 * @returns {string}
 */
function _decodeHtmlEntities(str) {
  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ent) => {
    if (ent[0] === '#') {
      const isHex = ent[1].toLowerCase() === 'x';
      const codePoint = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      const validScalar = Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        && !(codePoint >= 0xD800 && codePoint <= 0xDFFF);
      return validScalar ? String.fromCodePoint(codePoint) : whole;
    }
    const named = HTML_ENTITIES[ent.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

/**
 * Parse `og:title`/`og:description`/`og:image`/`og:video`/`og:site_name`
 * out of a page's raw HTML (already fetched by this module's caller — see
 * the file header for what is and is not in this car's envelope). Returns
 * `null` when no recognized `og:` tag is present, rather than an object
 * with every field `undefined`.
 *
 * `image`/`video`, if present, name an EXTERNAL host's media: Ruling A752
 * (the same rule `public/v6-shell.js#messageMarkup` already enforces for a
 * plain external image link) means the caller must render these as a link
 * card, never an auto-fetched `<img>`/`<video>`, unless the viewer has
 * explicitly opted in to external media — this module only extracts the
 * metadata; it does not decide how it is shown.
 * @param {string} html
 * @returns {({title?: string, description?: string, image?: string, video?: string, siteName?: string}|null)}
 */
function parseOpenGraphHtml(html) {
  if (typeof html !== 'string' || !html) return null;
  const result = {};
  OG_META_TAG.lastIndex = 0;
  let match;
  while ((match = OG_META_TAG.exec(html)) !== null) {
    const field = OG_FIELD_MAP[match[1].toLowerCase()];
    if (!field || result[field] !== undefined) continue; // first occurrence of each field wins
    const contentMatch = OG_CONTENT_ATTR.exec(match[0]);
    if (!contentMatch) continue;
    const raw = contentMatch[1] !== undefined ? contentMatch[1] : contentMatch[2];
    result[field] = _decodeHtmlEntities(raw);
  }
  _applyPlainHtmlFallback(result, html);
  return Object.keys(result).length > 0 ? result : null;
}

/** `<title>…</title>`, first occurrence, tag body only (no nested markup expected or handled). */
const HTML_TITLE_TAG = /<title[^>]*>([^<]*)<\/title>/i;
/** `<meta name="description" content="…">`, either quote style, name/content in either attribute order. */
const META_DESCRIPTION_TAG = /<meta\s+(?=[^>]*\bname\s*=\s*["']description["'])[^>]*?content\s*=\s*["']([^"']*)["'][^>]*>/i;
/** First `<h1>…</h1>`, tag body only. */
const HTML_FIRST_H1_TAG = /<h1[^>]*>([^<]*)<\/h1>/i;
/** First `<p>…</p>`, tag body only. */
const HTML_FIRST_P_TAG = /<p[^>]*>([^<]*)<\/p>/i;

/**
 * #3139's own fallback: a self-published or otherwise `og:`-less page (seen
 * live: this fleet's own `:3430/` and `:5080/pitch-video/cut/` pages) still
 * gets a meaningful preview card built from ordinary `<title>`/`<meta
 * name="description">`/`<h1>`/`<p>` tags, mutating `result` in place only
 * for whichever fields the `og:` pass above left unset — an `og:title` a
 * page DID supply is never overwritten by a plainer `<title>` fallback.
 * @param {object} result - {@link parseOpenGraphHtml}'s own accumulator.
 * @param {string} html
 * @returns {void}
 */
function _applyPlainHtmlFallback(result, html) {
  if (result.title === undefined) {
    const titleMatch = HTML_TITLE_TAG.exec(html);
    const h1Match = HTML_FIRST_H1_TAG.exec(html);
    const raw = titleMatch ? titleMatch[1] : (h1Match ? h1Match[1] : null);
    const trimmed = raw === null ? null : _decodeHtmlEntities(raw).trim();
    if (trimmed) result.title = trimmed;
  }
  if (result.description === undefined) {
    const metaMatch = META_DESCRIPTION_TAG.exec(html);
    const pMatch = HTML_FIRST_P_TAG.exec(html);
    const raw = metaMatch ? metaMatch[1] : (pMatch ? pMatch[1] : null);
    const trimmed = raw === null ? null : _decodeHtmlEntities(raw).trim();
    if (trimmed) result.description = trimmed;
  }
}

// ── #3139 root causes 3/4: the real fetch (Ruling A827 point 3) ──
//
// NOT in this car's original envelope (server.js owns `_v6SafeUnfurlFetch`
// today, outside W1-B's file scope) — the Architect's ruling asked this
// exact logic to be rebuilt here, exported, and unit-tested, so Wave 2
// (Car V651-W2-B, after W1-C merges server.js's own touches this wave) can
// wire `server.js`'s route to call it instead of maintaining its own
// now-superseded copy. See this file's commit history / the PR for the
// Architect's ruling text in full.

/** Caps how much of a fetched page's bytes {@link safeUnfurlFetch} buffers before resolving with what it has — `og:`/`<title>` tags live in `<head>`, always well inside this. */
const UNFURL_MAX_BYTES = 512 * 1024;

/** How many redirects {@link safeUnfurlFetch} follows before giving up, each one re-validated by {@link evaluateUnfurlTargetSafety} before being fetched. */
const UNFURL_MAX_REDIRECTS = 3;

/**
 * A `http.request`/`https.request` custom `lookup` option that always
 * answers with one already-validated, pinned address, so the real
 * connection can never re-resolve to something {@link
 * _resolveAndVerifyUnfurlTarget} never saw (DNS rebinding). Node 20+'s
 * `net.autoSelectFamily` defaults to `true` and calls a custom `lookup`
 * with `{all: true}`, which requires the array-callback form.
 * @param {{address: string, family: number}} pinned
 * @returns {(hostname: string, opts: object, cb: Function) => void}
 */
function _unfurlPinnedLookup(pinned) {
  return (_hostname, opts, cb) => (opts && opts.all
    ? cb(null, [{ address: pinned.address, family: pinned.family }])
    : cb(null, pinned.address, pinned.family));
}

/**
 * Resolve `hostname`'s DNS and verify EVERY candidate address against
 * {@link evaluateUnfurlTargetSafety}, passing `hostname` itself as
 * `opts.originalHostname` — the fix Ruling A827 exists for: a `*.ts.net`
 * name's own Tailscale CGNAT/ULA resolution is admitted, while any OTHER
 * private-range resolution (for ANY hostname, `*.ts.net` included) is
 * still refused.
 * @param {string} hostname
 * @param {string} protocol
 * @param {string} port
 * @param {object} deps - Seam: `lookup` (defaults to `dns.promises.lookup`).
 * @returns {Promise<{ok: true, pinned: {address: string, family: number}}|{ok: false, reason: string}>}
 */
async function _resolveAndVerifyUnfurlTarget(hostname, protocol, port, deps) {
  const lookup = deps.lookup || ((h, opts) => dns.promises.lookup(h, opts));
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'DNS_LOOKUP_FAILED' };
  }
  if (!addresses || !addresses.length) return { ok: false, reason: 'DNS_LOOKUP_FAILED' };
  for (const { address, family } of addresses) {
    const hostForUrl = family === 6 ? `[${address}]` : address;
    const probe = evaluateUnfurlTargetSafety(`${protocol}//${hostForUrl}${port ? `:${port}` : ''}/`, { originalHostname: hostname });
    if (!probe.safe) return { ok: false, reason: `RESOLVED_${probe.reason}` };
  }
  return { ok: true, pinned: addresses[0] };
}

/**
 * Fetch exactly one hop of `url` — no redirect following (the caller,
 * {@link safeUnfurlFetch}, owns that), and no safety check of `url`
 * ITSELF (the caller already did that too); only the RESOLVED address is
 * (re-)verified here, pinned so the real connection cannot land anywhere
 * this check never saw.
 * @param {string} url
 * @param {object} deps - Seams: `lookup`, `request` (a `(options, cb) =>
 *   http.ClientRequest`-shaped function; defaults to the real
 *   `http`/`https` picked by `url`'s own protocol), `timeoutMs`.
 * @returns {Promise<{ok: true, kind: 'html', html: string, finalUrl: string, truncated: boolean}|
 *   {ok: true, kind: 'video', mimeType: string, finalUrl: string}|
 *   {ok: false, reason: string, redirectTo?: string}>}
 */
async function _fetchOneUnfurlHop(url, deps) {
  const parsed = new URL(url);
  const verified = await _resolveAndVerifyUnfurlTarget(parsed.hostname, parsed.protocol, parsed.port, deps);
  if (!verified.ok) return verified;
  const client = deps.request || ((options, cb) => (parsed.protocol === 'https:' ? https : http).request(options, cb));
  return new Promise((resolve) => {
    const req = client({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: { Host: parsed.host, 'User-Agent': 'TangleClaw-LinkUnfurl/1.0', Accept: 'text/html,application/xhtml+xml' },
      lookup: _unfurlPinnedLookup(verified.pinned),
      timeout: deps.timeoutMs || 8000
    }, (fres) => {
      const status = fres.statusCode;
      // #3139 requirement 4: follow redirects (the caller re-validates the
      // target's own safety before fetching it — this function never
      // fetches an unvalidated redirect itself).
      if (status != null && status >= 300 && status < 400 && fres.headers.location) {
        fres.resume();
        resolve({ ok: false, reason: 'REDIRECT', redirectTo: fres.headers.location });
        return;
      }
      if (status == null || status < 200 || status >= 400) {
        fres.resume();
        resolve({ ok: false, reason: `HTTP_${status}` });
        return;
      }
      // #3139 requirement 3: a response whose Content-Type is itself a
      // video — not just a URL whose PATH looked like one — is classified
      // the same way, without ever buffering the body as "HTML".
      const contentType = String(fres.headers['content-type'] || '').toLowerCase();
      if (contentType.startsWith('video/')) {
        fres.destroy();
        resolve({ ok: true, kind: 'video', mimeType: contentType.split(';')[0].trim(), finalUrl: url });
        return;
      }
      let total = 0;
      const chunks = [];
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      fres.on('data', (chunk) => {
        total += chunk.length;
        chunks.push(chunk);
        if (total > UNFURL_MAX_BYTES) {
          // #3139 root cause 3: resolve with exactly the first
          // UNFURL_MAX_BYTES — <head>, where every tag this module parses
          // lives, is always well inside this cap — instead of
          // `req.destroy()` with nothing ever resolved, which previously
          // left the CALLER hanging until its own unrelated timeout. The
          // chunk that crossed the cap is trimmed, not kept whole: without
          // this slice, the result could run over by up to one chunk's
          // size, silently breaking the "first UNFURL_MAX_BYTES" contract
          // this constant's own name promises.
          req.destroy();
          finish({ ok: true, kind: 'html', html: Buffer.concat(chunks).subarray(0, UNFURL_MAX_BYTES).toString('utf8'), finalUrl: url, truncated: true });
        }
      });
      fres.on('end', () => finish({ ok: true, kind: 'html', html: Buffer.concat(chunks).toString('utf8'), finalUrl: url, truncated: false }));
      fres.on('error', () => finish({ ok: false, reason: 'RESPONSE_ERROR' }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, reason: 'FETCH_ERROR' }));
    req.end();
  });
}

/**
 * Fetch `url` for link unfurling, following up to {@link
 * UNFURL_MAX_REDIRECTS} redirects (each target independently re-validated
 * by {@link evaluateUnfurlTargetSafety} before being fetched — never
 * trusting a server's own `Location` header), resolving a video response
 * (by Content-Type) as `{kind: 'video'}` instead of buffering it as HTML,
 * and resolving a large HTML page with its first {@link UNFURL_MAX_BYTES}
 * rather than hanging until a caller's own timeout (#3139 root causes 2-4).
 * @param {string} url - The caller's own already-safety-checked request —
 *   re-checked again here regardless, since a redirect target never was.
 * @param {object} [opts]
 * @param {object} [opts.deps] - Seams forwarded to {@link _fetchOneUnfurlHop}: `lookup`, `request`, `timeoutMs`.
 * @returns {Promise<{ok: true, kind: 'html', html: string, finalUrl: string, truncated: boolean}|
 *   {ok: true, kind: 'video', mimeType: string, finalUrl: string}|
 *   {ok: false, reason: string}>}
 */
async function safeUnfurlFetch(url, opts = {}) {
  const deps = opts.deps || {};
  let current = url;
  for (let hop = 0; hop <= UNFURL_MAX_REDIRECTS; hop++) {
    const safety = evaluateUnfurlTargetSafety(current);
    if (!safety.safe) return { ok: false, reason: safety.reason };
    const result = await _fetchOneUnfurlHop(current, deps);
    if (result.reason !== 'REDIRECT') return result;
    if (hop === UNFURL_MAX_REDIRECTS) return { ok: false, reason: 'TOO_MANY_REDIRECTS' };
    try {
      current = new URL(result.redirectTo, current).toString();
    } catch {
      return { ok: false, reason: 'INVALID_REDIRECT_TARGET' };
    }
  }
  // Unreachable: the loop above always returns before its counter exhausts
  // (the `hop === UNFURL_MAX_REDIRECTS` check fires one iteration early).
  return { ok: false, reason: 'TOO_MANY_REDIRECTS' };
}

module.exports = {
  TIER_A_ADAPTERS,
  TIER_B_ADAPTERS,
  ROLES,
  classifyAdapterTier,
  appendEvent,
  getEvents,
  softDeleteEvent,
  checkInterruptSupport,
  IMAGE_EXTENSIONS,
  VIDEO_MIME_TYPES,
  ARTIFACT_EXTENSIONS,
  classifyMediaOrArtifactLink,
  parseGitHubEntityUrl,
  evaluateUnfurlTargetSafety,
  extractRichPreviewsFromMessage,
  parseOpenGraphHtml,
  // #3139 backend.
  isAllowlistedUnfurlHost,
  UNFURL_ALLOWLISTED_HOSTS,
  SELF_PUBLISHED_PREVIEW_PORTS,
  safeUnfurlFetch,
  UNFURL_MAX_BYTES,
  UNFURL_MAX_REDIRECTS
};
