'use strict';

/**
 * Engine API error detection (#261).
 *
 * An engine that gets a 4xx/5xx from its provider prints the error into its
 * own terminal and carries on; from the dashboard the session looks healthy.
 * Codex is the concrete case: under the wrong auth mode every prompt answered
 * `{"type":"error","status":400,"error":{"type":"invalid_request_error",…}}`
 * as gray terminal text, and nothing on the card or the session page said so.
 *
 * Detection is declared, not hard-coded: an engine profile carries
 * `errorPatterns: [{ regex, parser }]`, where `regex` selects a pane line and
 * `parser` NAMES one of the strategies in `PARSERS` — a name, never code, so a
 * profile JSON can never execute anything. `lib/engines.js#validateProfile`
 * rejects a regex that will not compile and a parser this module does not know.
 *
 * The capture is the wrap sentinel's: `lib/wrap-sentinel.js` already reads
 * every live tmux session's tail on a timer, and this module is called with
 * those lines — there is no second capture loop. State is in-memory, keyed by
 * session id, exactly like the sentinel's own; a server restart re-reads the
 * pane on the first tick and re-detects an error that is still on screen.
 *
 * THE CLEAR RULE, stated honestly: TangleClaw cannot see an API call succeed.
 * What it can see is the pane's captured tail. An error is reported for as
 * long as a matching line is inside that tail, and clears the first time a
 * capture no longer contains one — which is what "a later successful
 * interaction" looks like from outside: the engine produced enough new output
 * to push the error line out of the captured rows (the tail of the
 * scrollback, or the visible viewport for an alternate-screen TUI). An error
 * still on screen stays reported even if the operator has since done other
 * work, and a repeat error re-arms with a fresh timestamp once the previous
 * one has scrolled away. An EMPTY capture is no reading at all — `capturePane`
 * answers `{ lines: [] }` when tmux failed or timed out (#894) — and leaves
 * the record exactly as it was; clearing on it would flash the card healthy
 * for a tick and re-stamp the same error as new on the next.
 */

const { createLogger } = require('./logger');

const log = createLogger('engine-errors');

/** Longest message carried into the UI; provider messages can run to paragraphs. */
const MESSAGE_MAX_CHARS = 400;
/**
 * tmux `capture-pane -p` (no `-J`) splits a long line at the pane width, so a
 * JSON error line with a real message arrives as several rows. Reassembly
 * joins the matched row with the ones after it until the JSON parses, up to
 * this many rows — enough for a 400-char message on an 80-column pane.
 */
const MAX_JOIN_ROWS = 12;
/**
 * Longest row a profile regex is ever run against. Patterns are operator
 * authored and run per row, per live session, per tick on the event loop; a
 * pane row is bounded by the terminal width, but a gateway-fed or `-J`-joined
 * line is not, and the cap keeps a pathological input from becoming a
 * pathological match time.
 */
const MAX_ROW_CHARS = 2000;
/**
 * A quantified group that is itself quantified — `(a+)+`, `(a*)*`, `(a+)*`,
 * `(a*)+` and the `{n,}` forms — is the classic catastrophic-backtracking
 * shape, and it runs against every row on the server's event loop.
 * `validatePatterns` rejects it with the reason; `compilePatterns` skips it.
 */
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})\)(?:[+*]|\{\d+,\d*\})/;
// CSI escape sequences + bare CR, same shape as the wrap sentinel's strip —
// `capturePane` omits `-e` so SGR is normally absent, but a gateway-fed line
// or a future `-e` capture must not defeat the anchor.
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp('\\u001b\\[[0-9;:?]*[ -/]*[@-~]|\\u001b[()][AB0-2]|\\r', 'g');

/**
 * Trim a provider message to what a banner can carry.
 * @param {*} value - Candidate message.
 * @returns {string}
 */
function _clampMessage(value) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS - 1)}…` : text;
}

/**
 * Whether a value is an HTTP failure status — the only statuses this module
 * reports. A `{"type":"error"}` object with a 2xx or no status is not an API
 * failure and is left alone rather than guessed at.
 * @param {*} value - Candidate status.
 * @returns {boolean}
 */
function _isFailureStatus(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 400 && n <= 599;
}

/**
 * Parse the structured error object Codex prints for a failed API call.
 *
 * Shape (OpenAI Responses API, as Codex echoes it to the terminal):
 * `{"type":"error","status":400,"error":{"type":"invalid_request_error",
 * "code":"unsupported_model","message":"…","param":"model"}}`. The outer
 * `type` is the event kind; the inner `error.type` is the classification the
 * operator wants to read. Both `status` placements seen in the wild are read.
 *
 * Strict mode requires the text to parse as JSON, so the wrapped-row
 * reassembly can tell "not whole yet" from "not an error". Lenient mode is
 * the fallback once reassembly has given up: it pulls `status` and `message`
 * out of the raw text by regex, so a line the terminal mangled still yields
 * the status code, which is the part the operator needs first.
 *
 * @param {string} text - One (reassembled) pane line.
 * @param {{lenient?: boolean}} [opts]
 * @returns {{type: string, status: number, message: string}|null} Null when
 *   the text is not a failure the operator should hear about.
 */
function parseCodexJson(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let obj = null;
  try {
    obj = JSON.parse(raw.slice(start));
  } catch {
    obj = null;
  }
  if (obj && typeof obj === 'object') {
    if (obj.type !== 'error') return null;
    const inner = obj.error && typeof obj.error === 'object' ? obj.error : {};
    const status = obj.status != null ? obj.status : inner.status;
    if (!_isFailureStatus(status)) return null;
    const message = inner.message || obj.message || inner.code || `HTTP ${Number(status)}`;
    return {
      type: String(inner.type || inner.code || obj.type),
      status: Number(status),
      message: _clampMessage(message)
    };
  }
  if (!opts.lenient) return null;
  if (!/"type"\s*:\s*"error"/.test(raw)) return null;
  const statusMatch = raw.match(/"status"\s*:\s*(\d{3})/);
  if (!statusMatch || !_isFailureStatus(statusMatch[1])) return null;
  const typeMatch = raw.match(/"error"\s*:\s*\{[^}]*?"type"\s*:\s*"([^"]+)"/);
  const messageMatch = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/);
  return {
    type: typeMatch ? typeMatch[1] : 'error',
    status: Number(statusMatch[1]),
    message: _clampMessage(messageMatch ? messageMatch[1].replace(/\\"/g, '"') : `HTTP ${statusMatch[1]}`)
  };
}

/**
 * The named parser strategies a profile may reference. Names, not code: the
 * profile picks one, and only this table decides what runs.
 * @type {Object<string, function(string, {lenient?: boolean}=): ({type: string, status: number, message: string}|null)>}
 */
const PARSERS = Object.freeze({
  'codex-json': parseCodexJson
});

/** @type {string[]} The parser names a profile may declare. */
const PARSER_NAMES = Object.freeze(Object.keys(PARSERS));

/**
 * Why a pattern's regex source is unacceptable, or null when it is fine.
 * One owner for both the validator (which reports it) and the compiler
 * (which skips it), so the two cannot disagree about what runs.
 * @param {*} source - The declared `regex` string.
 * @returns {string|null} The reason, phrased for the profile author.
 */
function _regexRejection(source) {
  if (typeof source !== 'string' || source.length === 0) return 'regex must be a non-empty string';
  try {
    new RegExp(source);
  } catch (err) {
    return `regex does not compile: ${err.message}`;
  }
  if (NESTED_QUANTIFIER_RE.test(source)) {
    return 'regex nests a quantifier inside a quantified group (e.g. `(a+)+`), which can backtrack catastrophically — rewrite it without the nesting';
  }
  return null;
}

/**
 * Validate a profile's `errorPatterns` declaration. Called from
 * `lib/engines.js#validateProfile`; returns the reasons it is unacceptable.
 * The field is optional — `undefined` is fine — but once present it must be
 * an array of `{ regex, parser }` where the regex compiles and the parser is
 * a name this module knows.
 *
 * @param {*} patterns - The profile's `errorPatterns` value.
 * @returns {string[]} Validation errors, empty when acceptable.
 */
function validatePatterns(patterns) {
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns)) return ['errorPatterns must be an array of { regex, parser }'];
  const errors = [];
  patterns.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`errorPatterns[${i}] must be an object with regex and parser`);
      return;
    }
    const rejection = _regexRejection(entry.regex);
    if (rejection) errors.push(`errorPatterns[${i}].${rejection}`);
    if (typeof entry.parser !== 'string' || !Object.prototype.hasOwnProperty.call(PARSERS, entry.parser)) {
      errors.push(`errorPatterns[${i}].parser must be one of: ${PARSER_NAMES.join(', ')}`);
    }
  });
  return errors;
}

/**
 * Compiled patterns per engine id, keyed by the declaration text so an edited
 * profile (operator-local copies are re-synced on boot) recompiles rather
 * than serving the old regex.
 * @type {Map<string, {key: string, compiled: Array<{regex: RegExp, parser: function, parserName: string}>}>}
 */
const _compiled = new Map();

/**
 * Compile a profile's patterns, skipping entries validation would reject —
 * a bad entry in an operator-local profile must not take the whole engine's
 * detection down, and `validateProfile` is where it is reported.
 *
 * @param {object|null|undefined} profile - Engine profile (needs `id` and `errorPatterns`).
 * @returns {Array<{regex: RegExp, parser: function, parserName: string}>}
 */
function compilePatterns(profile) {
  if (!profile || !Array.isArray(profile.errorPatterns) || profile.errorPatterns.length === 0) return [];
  const key = JSON.stringify(profile.errorPatterns);
  const cached = _compiled.get(profile.id);
  if (cached && cached.key === key) return cached.compiled;
  const compiled = [];
  for (const entry of profile.errorPatterns) {
    if (!entry || !Object.prototype.hasOwnProperty.call(PARSERS, entry.parser)) continue;
    const rejection = _regexRejection(entry.regex);
    if (rejection) {
      log.warn('errorPatterns entry skipped', { engine: profile.id, regex: entry.regex, reason: rejection });
      continue;
    }
    compiled.push({ regex: new RegExp(entry.regex), parser: PARSERS[entry.parser], parserName: entry.parser });
  }
  _compiled.set(profile.id, { key, compiled });
  return compiled;
}

/**
 * Strip ANSI escapes and CR from a captured row, and cap its length before
 * any operator-authored regex sees it.
 * @param {*} line - Raw row.
 * @returns {string}
 */
function _clean(line) {
  return String(line == null ? '' : line).replace(ANSI_RE, '').slice(0, MAX_ROW_CHARS);
}

/**
 * Find the most recent engine error in a captured tail.
 *
 * Rows are scanned newest-first so a pane holding two errors reports the
 * later one. A matched row is reassembled with the rows after it (tmux wraps
 * long lines) until the parser accepts it strictly; when no prefix parses,
 * the parser gets the whole reassembly leniently.
 *
 * @param {string[]} lines - Captured pane rows, oldest first.
 * @param {Array<{regex: RegExp, parser: function}>} compiled - From `compilePatterns`.
 * @returns {{type: string, status: number, message: string, line: string}|null}
 *   The parsed error plus the raw matched row (`line`), or null.
 */
function scanLines(lines, compiled) {
  if (!Array.isArray(lines) || compiled.length === 0) return null;
  const rows = lines.map(_clean);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) continue;
    for (const { regex, parser } of compiled) {
      if (!regex.test(row)) continue;
      let text = row;
      let parsed = parser(text);
      for (let k = 1; !parsed && k < MAX_JOIN_ROWS && i + k < rows.length; k++) {
        text += rows[i + k];
        parsed = parser(text);
      }
      if (!parsed) parsed = parser(text, { lenient: true });
      if (parsed) return { ...parsed, line: row };
    }
  }
  return null;
}

/**
 * Last detected error per live session.
 * @type {Map<number, {type: string, status: number, message: string, timestamp: string, line: string}>}
 */
const _errors = new Map();

/**
 * Feed one capture of a session's pane through its engine's patterns and
 * update the session's recorded error. Called by the wrap sentinel on every
 * tick, for every live tmux session.
 *
 * - A matching row records `{ type, status, message, timestamp }`; the same
 *   row seen again on the next tick keeps its original timestamp (the error is
 *   still on screen, not new).
 * - No matching row clears whatever was recorded — see the module header for
 *   why that is the honest reading of "a later successful interaction".
 * - An EMPTY capture (`capturePane`'s answer for a failed or timed-out tmux
 *   read, #894) is no reading and changes nothing.
 * - An engine with no patterns records nothing and clears nothing.
 *
 * @param {{id: number}} session - A `store.sessions` record.
 * @param {string[]} lines - Captured pane rows, oldest first.
 * @param {object|null|undefined} profile - The session's engine profile.
 * @returns {{type: string, status: number, message: string, timestamp: string}|null}
 *   The error now recorded for the session, or null.
 */
function observe(session, lines, profile) {
  if (!session || session.id == null) return null;
  const compiled = compilePatterns(profile);
  if (compiled.length === 0) return get(session.id);
  // Nothing captured is nothing measured — the same rule the idle gate applies
  // to this shape. Clearing here would read "tmux did not answer" as "the
  // error is gone".
  if (!Array.isArray(lines) || lines.length === 0) return get(session.id);
  const hit = scanLines(lines, compiled);
  const prev = _errors.get(session.id);
  if (!hit) {
    if (prev) {
      _errors.delete(session.id);
      log.info('engine error cleared — pane moved past it', { session: session.id, status: prev.status });
    }
    return null;
  }
  if (prev && prev.line === hit.line) return get(session.id);
  const record = {
    type: hit.type,
    status: hit.status,
    message: hit.message,
    timestamp: new Date(_internal.now()).toISOString(),
    line: hit.line
  };
  _errors.set(session.id, record);
  log.warn('engine API error detected in session output', {
    session: session.id, engine: profile && profile.id, status: hit.status, type: hit.type
  });
  return get(session.id);
}

/**
 * The error currently recorded for a session, shaped for the status API —
 * the raw matched row stays internal.
 * @param {number} sessionId - Session id.
 * @returns {{type: string, status: number, message: string, timestamp: string}|null}
 */
function get(sessionId) {
  const rec = _errors.get(sessionId);
  if (!rec) return null;
  return { type: rec.type, status: rec.status, message: rec.message, timestamp: rec.timestamp };
}

/**
 * Drop a session's record — the session ended.
 * @param {number} sessionId - Session id.
 * @returns {void}
 */
function forget(sessionId) {
  _errors.delete(sessionId);
}

/**
 * Reset all state (tests, and the sentinel's `stop()`).
 * @returns {void}
 */
function _reset() {
  _errors.clear();
  _compiled.clear();
}

const _internal = {
  now: () => Date.now()
};

module.exports = {
  observe,
  get,
  forget,
  scanLines,
  compilePatterns,
  validatePatterns,
  parseCodexJson,
  PARSERS,
  PARSER_NAMES,
  MAX_JOIN_ROWS,
  MAX_ROW_CHARS,
  _internal,
  _reset
};
