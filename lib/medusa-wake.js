'use strict';

/**
 * Medusa wake-nudge monitor (MED-2K9P v2 Slice 1, chunk T2) — the idle-gated
 * inbox-watcher.
 *
 * An idle LLM session is free but not self-triggering: it won't *notice* an
 * inbound Medusa message on its own (switchboard-v2-design.md §4). This
 * monitor supplies the one mechanical primitive the plumbing must add — when a
 * session with a live listener has fresh inbound mail, it types a minimal,
 * fixed nudge line into the session's tmux pane so the agent spends a turn
 * reading its inbox via TC's existing API. Everything else (drain, act, reply)
 * is the agent + the consumer contract; the boundary stays crisp.
 *
 * Safety properties (each one is load-bearing):
 *
 * 1. **Idle-gated — a busy turn is never interrupted.** The T2 spike
 *    (2026-07-11, live probe over 4 sessions) found Claude Code's status line
 *    carries a deterministic busy marker: `esc to interrupt` is present iff a
 *    turn is in flight — strictly more truthful than the 3-line output-age
 *    heuristic in `sessions.detectIdle` (a long quiet tool call reads
 *    false-idle under output-age alone). A pane is judged idle only when the
 *    engine's `busyMarker` is absent AND a bare input-prompt line matching the
 *    engine's `promptRe` is present (a pending permission dialog replaces the
 *    bare prompt with option rows — Claude's `❯ 1. Yes` — so requiring a BARE
 *    prompt line also refuses to type into a dialog, where injected text could
 *    answer it, or over an operator's half-typed input). An engine whose bare
 *    prompt PERSISTS during a turn (antigravity/Gemini-CLI keeps `>` while
 *    "Generating…", #560 live spike) also carries a positive `idleMarker` that
 *    must be present — its at-rest status hint (`? for shortcuts`), absent
 *    during both generation and any dialog/menu — so the busy-marker gate is
 *    never the only thing standing between a nudge and a busy pane. Two
 *    consecutive idle ticks are required (debounce against capture races at
 *    turn boundaries).
 * 2. **Zero attacker-controlled bytes.** The nudge is a fixed template — the
 *    inbound message text is NEVER typed into the pane (cross-session text
 *    typed into a terminal is an injection surface; the agent fetches it over
 *    HTTP instead, where it's data, not keystrokes).
 * 3. **One nudge per fresh-mail edge.** A per-session watermark (the newest
 *    inbox message key at last nudge) re-arms only on a genuinely new arrival,
 *    so an unhandled backlog never re-fires a nudge loop; a burst that piled
 *    up while busy drains FIFO on the single wake (the agent GETs the whole
 *    inbox). When the inbox goes read (`unread === 0`), the watermark advances
 *    silently so only future arrivals nudge.
 * 4. **Opt-in, per project.** Gated on the `medusaWake` project preference
 *    (default OFF): a wake spends a real turn (tokens/money), which v1's
 *    passive badge never did — upgrading TC must not change what an inbound
 *    message costs without the operator choosing it. Requires the listener
 *    already `listening` (i.e. `medusaEnabled`/banner opt-in) on top.
 * 5. **Profiled tmux engines only (#560 — engine-aware).** A supported engine
 *    declares its live-probed idle/busy markers as a `capabilities.wake` block
 *    in its own profile (#1255), and `ENGINE_WAKE_PROFILES` is derived from
 *    those: Claude (`esc to interrupt` + bare `❯`) and antigravity/Gemini-CLI
 *    (`esc to cancel` + bare `>` + the `? for shortcuts` at-rest marker).
 *    webui/gateway sessions (no tmux pane — injection unsupported) and engines
 *    with no block (e.g. codex, aider — no live idle signature captured yet)
 *    are skipped and logged once per session, never silent. Guessing an
 *    unprofiled engine's idle signature is exactly the false-idle hazard
 *    property 1 forbids, so an unknown engine stays off until probed — which is
 *    also why a MALFORMED block leaves its engine unprofiled rather than
 *    half-loaded.
 *
 * Lifecycle mirrors the other boot-time monitors (`engine-error-monitor`,
 * `tunnel-monitor`): `start()` arms a `setInterval` tick wired in `server.js`;
 * `stop()` clears it. The monitor's own state is in-memory — a TC restart
 * re-baselines (an un-nudged backlog nudges again on the first post-restart
 * idle tick, which is at-most-once-late, never lost, because the inbox itself
 * is the source). Mail tracked as a Medusa exchange (#1839) is the exception:
 * its wake attempts are durable, and a restart consults them before nudging
 * again, so a restart never sends a wake outside the watchdog's re-arm budget.
 */

const { createLogger } = require('./logger');
const { createHash } = require('crypto');
const wakeTransports = require('./wake-transports');
const { createTickMeter } = require('./tick-meter');
const { classifyForSender } = require('./medusa-delivery-disposition');

const log = createLogger('medusa-wake');

const DEFAULT_INTERVAL_MS = 5000;
/** Consecutive idle ticks required before injecting (capture-race debounce). */
const IDLE_TICKS_REQUIRED = 2;
/** Pane tail depth — enough to see the input box + status line. */
const TMUX_TAIL_LINES = 15;

/**
 * How old an engine activity observation may be and still decide a tick. Two
 * default intervals: the read is started on one tick and answers before the
 * next, so anything older was taken before the pane the tick is judging.
 */
const ENGINE_ACTIVITY_MAX_AGE_MS = 2 * DEFAULT_INTERVAL_MS;

/**
 * How long a session may hold its wake as `engine-thread-unknown`, with mail
 * waiting, before the operator is told (#1978). The code means the engine's
 * channel exists but could not prove the session idle; when that never
 * resolves, every message waits unseen, and without this the only signal was
 * an unread badge somebody had to notice.
 */
const WAKE_STALL_ALERT_MS = 10 * 60 * 1000;

/** The wake verdict a stall alert watches. */
const WAKE_STALL_CODE = 'engine-thread-unknown';

// How long one pane read may take before it is abandoned (#2086). Shorter than
// the tick interval, so a read is always settled before the next tick looks at
// the same session.
const PANE_READ_TIMEOUT_MS = 0.8 * DEFAULT_INTERVAL_MS;

// A pane read this long is slow, and so is one that timed out. An ordinary
// read takes about a tenth of a second, and about a second when thirty are
// in flight at once on a busy machine.
const SLOW_PANE_READ_MS = 0.75 * PANE_READ_TIMEOUT_MS;

// The least time between two at-rest observations of one pane for the second
// to count (#2086). On the blocking path two observations are a tick apart by
// construction. A non-blocking read can answer late in one tick and early in
// the next, and a pane that only paused for a second is not at rest.
const MIN_OBSERVATION_GAP_MS = 0.8 * DEFAULT_INTERVAL_MS;

// What `_judgeSession` returns when it has started a pane read and will finish
// judging when the read answers. Never stamped as a verdict: the session keeps
// the last one it earned until the read has been judged.
const PANE_READ_STARTED = 'pane-read-started';

// How long a pane whose read was slow is left alone, by how many slow reads in
// a row it has had, so a pane that stays hung is not asked again every tick.
// One ordinary read clears it.
const PANE_BACKOFF_MS = Object.freeze([10 * 1000, 30 * 1000, 60 * 1000]);

/**
 * The shape a profile's `capabilities.wake` block must satisfy, field by field.
 *
 * Every entry is a signature read off a LIVE pane, never guessed — a false-idle
 * read is the core injection hazard (header, safety property 1), so an engine
 * with no live signature declares no `wake` block at all and is
 * skipped-and-logged. That is why each field is REQUIRED rather than defaulted:
 * an author who has not measured a value writes `null` and says so in
 * `evidence`, which is a recorded gap; an omitted field would be the same gap
 * with nobody able to tell it from an oversight.
 *
 * - `busyMarker` (string): substring present iff a turn is in flight; its
 *   presence blocks a nudge. Load-bearing when the prompt persists during a turn.
 * - `promptPattern` (string): source of a regex matching a BARE input-prompt
 *   line (no dialog/menu row, no operator half-typed text). At least one line
 *   must match for idle. Compiled once, here, so a pattern that will not
 *   compile is refused as a broken profile rather than read as "no profile".
 * - `promptGlyph` (string): the composer's own glyph — how the composer line is
 *   located, since a pane with a running subagent fleet draws rows below it.
 * - `promptPad` (string|null): the separator the prompt itself draws between
 *   glyph and first input column. `null` for an engine whose separator has
 *   never been measured, which keeps the older laxer composer reading.
 * - `placeholderSgr` (number[]): the SGR attributes this engine renders text
 *   the operator did NOT type in.
 * - `idleMarker` (string|null): a POSITIVE at-rest signal that must be present
 *   for idle. Set only for engines whose bare prompt persists during a turn
 *   (antigravity keeps `>` while "Generating…"), so the busy-marker gate is
 *   never the sole guard; also excludes dialog/menu states that drop the hint.
 * - `pasteRejectedMarker` (string, optional): the engine's own words when it
 *   discards a submission. Optional because it is declared only where a
 *   discarding state was actually observed; the reasoning for watching a
 *   rejection rather than a landing lives with the code that acts on it
 *   (`sessions._observePasteRejected`).
 *
 * @type {Object<string, {required: boolean, check: (value: *) => boolean, expects: string}>}
 */
const WAKE_FIELDS = {
  busyMarker: { required: true, check: _isText, expects: 'a non-empty string' },
  promptPattern: { required: true, check: _compiles, expects: 'a string that compiles as a regex' },
  // Both are compared against a SINGLE terminal cell (`_composerEmpty`), so a
  // multi-character value is not a lenient declaration, it is one that can
  // never match: the composer then reads non-empty on every capture and the
  // engine is never idle, never nudged, never chimed, with nothing logged. The
  // realistic way to write one is copying ` ` out of a document as six
  // literal characters, which is why the check is here and not a sentence in
  // the guide.
  promptGlyph: { required: true, check: _isOneCell, expects: 'exactly one character' },
  promptPad: { required: true, check: (v) => v === null || _isOneCell(v), expects: 'exactly one character or null' },
  placeholderSgr: {
    required: true,
    check: (v) => Array.isArray(v) && v.every((n) => Number.isFinite(n)),
    expects: 'an array of SGR attribute numbers'
  },
  idleMarker: { required: true, check: (v) => v === null || _isText(v), expects: 'a non-empty string or null' },
  pasteRejectedMarker: { required: false, check: _isText, expects: 'a non-empty string' },
  // Optional because most engines draw nothing like this. Declared where an
  // engine ANIMATES decoration the operator did not type — codex paints a
  // braille shimmer across and above its composer, continuously, at rest
  // (#1344). Without it that engine is unwakeable twice over: the transcript
  // digest never repeats, so the movement gate reports `pane-writing` forever,
  // and a decorative cell landing between glyph and cursor reads as typed
  // input. Both were measured on a live pane, not predicted.
  decorativePattern: {
    required: false,
    // Not just 'compiles', and not a blacklist of the obvious offenders
    // either. A pattern that matches anything an operator can TYPE turns both
    // gates off silently: `_paneDigest` blanks every line so the pane always
    // looks settled, and `_composerEmpty` discounts every cell so typed input
    // reads as empty — the engine is then nudged mid-turn, over the operator's
    // own half-written text. Enumerating known-bad patterns is the wrong
    // shape, because `\S`, `\w` and `[a-z]` are as broad as `.`.
    //
    // The rule instead: decoration must not match any character an operator
    // types — all of printable ASCII, plus a sample of common non-ASCII letters. Decoration lives outside it —
    // codex's shimmer is U+2800-U+28FF. Same fail-closed spirit as
    // `_isOneCell`: refuse the declaration rather than ship a gate that passes
    // everything.
    check: (v) => _compiles(v) && _matchesNoTypedText(v),
    expects: 'a regex matching decoration only — it must not match the empty string, any printable ASCII character, or a common non-ASCII letter'
  }
};

/**
 * Letters outside ASCII that an operator plausibly types: accented Latin,
 * Greek, Cyrillic, CJK, kana, Hangul, Arabic, Hebrew and Devanagari. A sample,
 * not the whole of Unicode — enough to refuse "everything but ASCII" (`[^ -~]`)
 * and similar, which would otherwise pass the ASCII check.
 */
const _TYPED_NON_ASCII = 'éñüßçøåÉÑΩλДжЯ中文字あアカ한글عبשאहि';

/**
 * Would this decorative pattern also match text the operator could type?
 *
 * The question is what the regex ACCEPTS, so it is asked of the characters
 * themselves rather than read off the pattern's source. Every use of the
 * pattern tests exactly one cell (`_isDecorative`, and `_paneDigest` blanks
 * cell by cell), so testing single characters is the whole question: a
 * multi-cell pattern such as `ab` can never match a single cell, and so can
 * never discount anything.
 *
 * @param {string} source - Regex source from `capabilities.wake.decorativePattern`.
 * @returns {boolean} True when it matches no typed character.
 */
function _matchesNoTypedText(source) {
  const re = new RegExp(source);
  if (re.test('')) return false;
  for (let code = 0x20; code <= 0x7e; code++) {
    if (re.test(String.fromCharCode(code))) return false;
  }
  for (const ch of _TYPED_NON_ASCII) if (re.test(ch)) return false;
  return true;
}

/**
 * Does this profile declare decoration to discount?
 * @param {{decorativeRe?: RegExp}|undefined} profile
 * @returns {boolean}
 */
function _hasDecoration(profile) {
  return Boolean(profile && profile.decorativeRe);
}

/**
 * Is this a non-empty string?
 * @param {*} value - Candidate.
 * @returns {boolean}
 */
function _isText(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Is this exactly one code point — the width of a terminal cell the composer
 * check compares it against?
 * @param {*} value - Candidate.
 * @returns {boolean}
 */
function _isOneCell(value) {
  return _isText(value) && [...value].length === 1;
}

/**
 * Does this string compile as a regex?
 * @param {*} value - Candidate pattern source.
 * @returns {boolean}
 */
function _compiles(value) {
  if (!_isText(value)) return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * What is wrong with one engine's declared `wake` block, if anything.
 *
 * **The guard runs at the READ, not only over the bundled files.** The runtime
 * reads profiles from the user-local engines directory, and an operator profile
 * dropped in there never passes through this repo's tests — `lib/engines.js`
 * records the same asymmetry and refuses a bad write strategy at the write for
 * it. A half-loaded wake profile is worse than none: a `promptPattern` that
 * will not compile, or a field the schema does not know, would reach the gate
 * that decides whether to type into a live pane.
 *
 * The `evidence` map is checked in BOTH directions on purpose. A field added
 * without provenance is a measurement nobody made, and a stale entry for a
 * field since removed is provenance for nothing — both read as "this was
 * verified" to the next author, which is the claim this migration exists to
 * keep true.
 *
 * @param {*} block - The profile's `capabilities.wake` value.
 * @returns {string[]} Problems, empty when the block is well-formed.
 */
function _wakeBlockErrors(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return ['wake must be an object'];
  const errors = [];
  const declared = Object.keys(block).filter((k) => k !== 'evidence');

  for (const [field, spec] of Object.entries(WAKE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(block, field)) {
      if (spec.required) errors.push(`wake.${field} is required (${spec.expects})`);
      continue;
    }
    if (!spec.check(block[field])) errors.push(`wake.${field} must be ${spec.expects}`);
  }
  for (const field of declared) {
    if (!Object.prototype.hasOwnProperty.call(WAKE_FIELDS, field)) {
      errors.push(`wake.${field} is not a field this gate reads`);
    }
  }

  const evidence = block.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.push('wake.evidence is required — every declared field names where it was measured');
    return errors;
  }
  for (const field of declared) {
    const entry = evidence[field];
    if (!entry || typeof entry !== 'object') {
      errors.push(`wake.evidence.${field} is missing — a value with no provenance reads as measured`);
      continue;
    }
    // `verifiedOn: null` is the honest form for a value nobody has measured
    // (antigravity's separator). A date that does not parse is not.
    if (entry.verifiedOn !== null
      && !(/^\d{4}-\d{2}-\d{2}$/.test(entry.verifiedOn) && !Number.isNaN(Date.parse(entry.verifiedOn)))) {
      errors.push(`wake.evidence.${field}.verifiedOn must be an ISO date or null`);
    }
    if (!_isText(entry.source)) errors.push(`wake.evidence.${field}.source must name where this was measured`);
  }
  for (const field of Object.keys(evidence)) {
    if (!declared.includes(field)) {
      errors.push(`wake.evidence.${field} has no field to vouch for`);
    }
  }
  return errors;
}

/**
 * The wake signature this engine can actually be gated on, or null.
 *
 * **One decision, three readers.** The monitor asks whether an engine can be
 * nudged; `engines.engineClientPayload` decides what the browser is allowed to
 * see; and the `medusaWake` disposition row decides whether the settings
 * control is live. If any of them answered from the raw declaration instead,
 * an operator profile with a *present but malformed* block would render a live
 * checkbox for a session the monitor then refuses to nudge — the ADR 0013
 * silence, produced by the guard built to end it. Declaring badly and
 * declaring nothing are the same answer here on purpose.
 *
 * @param {object|null} profile - An engine profile.
 * @returns {object|null} The declared block, or null when there is none or it
 *   is malformed.
 */
function wakeSignature(profile) {
  const block = profile && profile.capabilities && profile.capabilities.wake;
  if (block === undefined) return null;
  return _wakeBlockErrors(block).length === 0 ? block : null;
}

/**
 * Build the runtime wake table from a list of engine profiles.
 *
 * A malformed block is refused and logged, leaving that engine unprofiled —
 * the existing honest skip — rather than half-loaded into the injection gate.
 *
 * @param {object[]} profiles - Engine profiles as the store holds them.
 * @returns {Object<string, object>} Wake profiles keyed by engine id.
 */
function _buildWakeProfiles(profiles) {
  const table = {};
  for (const profile of profiles) {
    const declared = profile && profile.capabilities && profile.capabilities.wake;
    if (declared === undefined) continue;
    // Through `wakeSignature`, not a second `_wakeBlockErrors` call standing in
    // for it: the whole point is that this table, the browser projection and
    // the disposition row cannot answer differently. The errors are recomputed
    // for the log payload only, once per malformed engine per table build.
    const block = wakeSignature(profile);
    if (!block) {
      log.warn('medusa-wake: engine declares a malformed wake block — it stays unprofiled and is never nudged', {
        engineId: profile.id, errors: _wakeBlockErrors(declared)
      });
      continue;
    }
    table[profile.id] = {
      busyMarker: block.busyMarker,
      // The compiled form is what every consumer reads; the pattern is the
      // injection gate, so it is compiled here once rather than per capture.
      promptRe: new RegExp(block.promptPattern),
      promptGlyph: block.promptGlyph,
      promptPad: block.promptPad,
      placeholderSgr: block.placeholderSgr,
      idleMarker: block.idleMarker,
      ...(block.pasteRejectedMarker === undefined
        ? {}
        : { pasteRejectedMarker: block.pasteRejectedMarker }),
      // Compiled once, like `promptRe`, and deliberately NOT global: both
      // gates test ONE cell at a time with it, so there is no `lastIndex` to
      // carry between calls, and a pattern can never mean more than one cell.
      ...(block.decorativePattern === undefined
        ? {}
        : { decorativeRe: new RegExp(block.decorativePattern) })
    };
  }
  return table;
}

/** @type {Object<string, object>|null} The built table, once the store has one. */
let _wakeProfiles = null;
/**
 * Whether the unreadable-store condition has been reported.
 *
 * Latched per process, the way `_scanSession` latches `skipLogged`: the read is
 * retried on every access so the table recovers the moment the file is fixed,
 * but every one of those retries would otherwise re-log — once per session per
 * five-second tick, plus every dashboard poll through `detectAtPrompt` — and
 * bury the one line naming what broke.
 * @type {boolean}
 */
let _unreadableLogged = false;

/**
 * The wake table, derived from the engine profiles on first use (#1255).
 *
 * **Derived lazily, and that is load-bearing.** The runtime reads engine
 * profiles from the user-local engines directory, which `store.init()`
 * canonical-source-overwrites from the bundle on every boot — that sync is what
 * carries a new `wake` block to an existing install with no migration. But
 * `server.js` requires every module BEFORE it calls `store.init()`, so a table
 * built at module load would read that directory in its pre-sync state: empty
 * on a fresh install, and stale on any other. Zero wake profiles, silently, is
 * the exact failure this migration exists to end.
 *
 * An empty directory is therefore treated as "not initialised yet" rather than
 * as an answer, and is not cached — the next access after `init()` builds the
 * real table. Once built it is memoised: a profile added to the directory while
 * TangleClaw runs takes effect on the next restart, which is the same contract
 * the canonical-source sync already has.
 *
 * @returns {Object<string, object>} Wake profiles keyed by engine id.
 */
function _resolveWakeProfiles() {
  if (_wakeProfiles) return _wakeProfiles;
  let profiles;
  try {
    profiles = require('./store').engines.list();
  } catch (err) {
    // The store parses every profile in one pass, so ONE unreadable file
    // answers for all of them — the per-engine isolation below it cannot help
    // here. Say the whole set of gates that just went dark rather than the one
    // this module owns: the same table decides the wake nudge, the session
    // chime's at-prompt read, and whether a prime paste is readiness-gated (it
    // degrades to the blind timed paste, recorded `unverified`).
    if (!_unreadableLogged) {
      _unreadableLogged = true;
      log.warn('medusa-wake: engine profiles unreadable — no session can be nudged, the chime falls '
        + 'back to staleness, and every prime paste degrades to the blind timed one', {
        error: err.message,
        howToInvestigate: 'One unparsable file in the engines directory throws for all of them. '
          + 'The parse error carries a byte offset rather than a filename — run '
          + '`for f in ~/.tangleclaw/engines/*.json; do node -e "require(process.argv[1])" "$f" || echo "$f"; done` '
          + 'to find it. Reported once per process; the read is retried on every access, so fixing '
          + 'the file restores the table with no restart.'
      });
    }
    return {};
  }
  if (!profiles.length) return {};
  _wakeProfiles = _buildWakeProfiles(profiles);
  return _wakeProfiles;
}

// CSI escape sequences + bare CR, built from explicit unicode escapes so no raw
// ESC byte sits in source; newlines are preserved so line structure survives.
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp('\\u001b\\[[0-9;:?]*[ -/]*[@-~]|\\u001b[()][AB0-2]|\\r', 'g');

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/**
 * Per-session monitor state.
 * @type {Map<number, {idleTicks: number, lastNudgedKey: string|null, skipLogged: boolean, configWarnLogged: boolean, cursorWarnLogged: boolean}>}
 */
const _sessions = new Map();

// What each tick cost (#2086): how late it started, how long it took, and where
// each session sat in the scan. It observes the pass and decides nothing.
const _meter = createTickMeter({ clock: () => _internal.clock() });

// Sessions something has asked the monitor to look at now (#2086), keyed by
// session id, with the reason last given. They are looked at together on the
// next turn of the event loop, so any number of requests for one session
// before then cost one look.
const _requested = new Map();
let _requestsScheduled = false;

// Bumped by `stop()`. A pane read carries the value it started under, and a
// read that answers under a different one is dropped, so nothing that began
// before a stop can type into a pane after it.
let _generation = 0;

/**
 * Whether the last tick found the Project Master running, or null before any
 * tick has asked (#918 — what `peerReachability` reports for a stopped Master).
 * @type {{live: boolean, since: string, observedAt: string}|null}
 */
let _masterPresence = null;

/**
 * Strip ANSI escape sequences (and CR), preserving newlines.
 * @param {string} text - Raw pane text.
 * @returns {string} Plain text.
 */
function _strip(text) {
  return String(text == null ? '' : text).replace(ANSI_RE, '');
}

/** The box-drawing characters an engine draws a composer border with. */
const _DIVIDER_RE = /^[\u2500\u2501\u2504\u2505\u2508\u2509-]+$/;

/**
 * Is this row a composer border: nothing but box-drawing characters?
 *
 * One definition for every reader of the composer's edges — the transcript
 * digest trims it, and the draft reader bounds a draft with it.
 *
 * @param {string} row - A captured row, ANSI already stripped.
 * @returns {boolean}
 */
function _isDivider(row) {
  return _DIVIDER_RE.test(String(row).trim());
}

/**
 * Fingerprint of the pane ABOVE the composer, for detecting a turn in flight.
 *
 * Every gate in this module used to ask a lexical question — does the capture
 * contain this engine's marker string? That question has now been wrong four
 * times (#1101, #1103, #1105, #1114), because a marker is a rendering an engine
 * is free to change, and Claude Code changed this one between builds. Worse,
 * measurement showed there is NO string that separates the states: while a
 * session streams output, the spinner is absent, the bare prompt is present,
 * and the status rows are byte-identical to a session at rest.
 *
 * So this asks a behavioural question instead: did the transcript move? A
 * working session writes — streaming output changes the pane on every tick, and
 * a thinking one animates its spinner glyph and elapsed clock. A session at
 * rest writes nothing. That holds for every engine without naming any of them,
 * which is why it is preferred over a per-engine marker.
 *
 * Everything from the composer down is excluded deliberately: the input line
 * carries an inline suggestion the engine rotates on its own, and the status
 * row carries a context-remaining percentage that ticks down as the session
 * fills — both change while the session is idle and would fake liveness.
 *
 * Measured on a live pane: the region changed on every tick across a streaming
 * turn, then held byte-identical for 21 consecutive ticks (63s) at rest.
 *
 * @param {string[]} lines - Pane tail lines (raw, may carry ANSI).
 * @param {{promptGlyph: string}} profile - The engine's detection profile.
 * @returns {string} A stable digest of the transcript region, or the digest of
 *   the whole capture when no composer line can be located (in which case the
 *   caller still gets a usable liveness signal rather than a constant).
 */
function _paneDigest(lines, profile) {
  // Decorative cells are removed BEFORE hashing: an engine that animates
  // decoration in the transcript region would otherwise change the digest on
  // every tick while completely idle, and the movement gate would read a
  // session at rest as one that is still writing — forever, not occasionally
  // (#1344, measured: 8 distinct digests over 8 idle samples).
  // Each decorative cell becomes ONE space, tested one cell at a time — the
  // same reading `_isDecorative` uses. Deleting a cell, or collapsing a run
  // into one space, shortens the line by however many cells the animation is
  // drawing, so two frames of the same idle pane would hash differently and
  // the permanent `pane-writing` failure this exists to fix would come back.
  // Cell by cell also means a pattern can only ever discount single cells,
  // which is exactly what `_matchesNoTypedText` checks. The trailing trim
  // below absorbs a decorative tail.
  const stripped = (lines || []).map((l) => {
    const text = _strip(l);
    const kept = _hasDecoration(profile)
      ? Array.from(text, (ch) => (_isDecorative(ch, profile) ? ' ' : ch)).join('')
      : text;
    return kept.replace(/\s+$/, '');
  });
  const glyph = profile && profile.promptGlyph;
  let composer = -1;
  if (glyph) {
    for (let i = stripped.length - 1; i >= 0; i--) {
      if (stripped[i].trimStart().startsWith(glyph)) { composer = i; break; }
    }
  }
  // Drop the box divider directly above the composer along with it — but only
  // when it IS one. Chopping a fixed line would discard real transcript on a
  // short pane, which silently costs the signal this function exists to give.
  let end = composer >= 0 ? composer : stripped.length;
  while (end > 0 && _isDivider(stripped[end - 1])) end -= 1;
  return createHash('sha1').update(stripped.slice(0, end).join('\n')).digest('hex');
}

/**
 * The activity reasons the pane assessment returns when an engine is doing
 * something, for a reader outside this module (the fleet activity observer,
 * #1912). The returns below keep their string literals, because the peer
 * reason vocabulary test derives emitted codes from them; the observer's
 * tests pin each name here to what the real assessment returns, so a rename
 * on one side fails a test rather than drifting.
 */
const ACTIVITY_REASONS = Object.freeze({
  TURN_IN_FLIGHT: 'turn-in-flight',
  AGENTS_RUNNING: 'agents-running',
  NOT_AT_REST: 'not-at-rest',
  PANE_WRITING: 'pane-writing'
});

/**
 * @type {RegExp} The running-subagent-fleet indicator: an unfocused row of
 * Claude Code's agent block, rendered directly above the composer while a fleet
 * is live. The block appears when the fleet starts and clears when the last
 * agent finishes, so a block row is present iff agents are actually running.
 *
 * The glyphs mark FOCUS, not liveness — `⏺` is the focused entry and `◯` the
 * unfocused one, which is why the two live captures disagree about which name
 * carries which:
 *
 *   #783 (agent focused):   `◯ main` / `⏺ prawduct-critic  Composing …  7m 20s`
 *   2026-08-21 (main focused): `⏺ main` / `◯ general-purpose  Find lib …  4s`
 *
 * Keying on `◯` therefore works from either side: the block lists `main` plus
 * every agent, so whenever it renders at least one row is unfocused. Matching
 * `⏺` instead would be wrong — Claude Code uses it for ordinary transcript
 * lines too (`⏺ Agent "…" finished`, `⏺ Running 1 shell command…`).
 *
 * Anchored at line start, because an unanchored scan matches the glyph anywhere
 * in ordinary terminal output — the pane tail is 15 lines of arbitrary content,
 * not a status line.
 *
 * NOT the `← N agents` text in the status line, which this gate used until it
 * was measured. That is the "press ← to view agents" affordance on the
 * empty-composer hint row: it renders because the input box is EMPTY, which is
 * the at-rest state this monitor exists to act on, and it clears the instant any
 * character is typed. Keying the gate on it inverted the gate — idle sessions
 * read busy, and never recovered, because an idle composer never fills on its
 * own. Measured across four live states (at rest / at rest with the hint cleared
 * / agent running / agent finished): the hint is present in three of them and
 * the count does not track live agents in either direction.
 *
 * The hazard #783 identified is real and this still guards it: with a subagent
 * focused the busy marker MOVES into the agent block, so `esc to interrupt` is
 * absent and a bare prompt IS rendered — a session minutes into a turn reads
 * `at-prompt`, and the two-tick debounce confirms the false read rather than
 * rejecting it, because the state is stable. Second, the paste buffer targets
 * whichever view holds focus, so the nudge would land in the subagent's
 * composer — telling a reviewer mid-review to act on someone else's mail.
 */
const _FLEET_RE = /^[ \t]*◯[ \t]+\S/m;

/**
 * Split a raw pane line into visible cells, carrying each cell's faint flag.
 *
 * Faintness is the whole point: a TUI draws an inline suggestion faint and real
 * input at normal intensity, so it is the only thing in the rendered line that
 * separates "the operator typed this" from "the editor is offering this".
 * SGR 2 sets faint; SGR 22 clears it specifically and SGR 0 clears everything,
 * and a bare `ESC[m` is an alias for `ESC[0m`.
 *
 * Cell indices line up with tmux's `cursor_x` because both count visible
 * columns, so a cursor column can be used to index the returned array.
 *
 * @param {string} line - One raw pane line, escape sequences retained.
 * @returns {Array<{ch: string, faint: boolean}>} One entry per visible column.
 */
function _cells(line) {
  const out = [];
  /** @type {Set<number>} SGR attributes in force at the current column. */
  const active = new Set();
  const src = String(line == null ? '' : line);

  /**
   * Apply one SGR parameter to `active`. Only the resets that actually end a
   * placeholder span are modelled; every other attribute is simply recorded, so
   * a profile can name whichever one its engine uses.
   * @param {number} n - The SGR parameter.
   * @returns {void}
   */
  const apply = (n) => {
    if (n === 0) { active.clear(); return; }                       // reset all
    if (n === 22) { active.delete(1); active.delete(2); return; }  // normal intensity
    const isFg = (a) => (a >= 30 && a <= 37) || (a >= 90 && a <= 97);
    // 39 restores the default foreground; a new colour replaces the old one
    // rather than stacking, so both clear whatever colour was in force.
    if (n === 39 || isFg(n)) {
      for (const a of [...active]) if (isFg(a)) active.delete(a);
      if (n === 39) return;
    }
    active.add(n);
  };
  // eslint-disable-next-line no-control-regex
  const sgr = /\[([0-9;:]*)m/y;
  // eslint-disable-next-line no-control-regex
  const other = /\[[0-9;:?]*[ -/]*[@-~]|[()][AB0-2]|\r/y;

  for (let i = 0; i < src.length;) {
    sgr.lastIndex = i;
    const m = sgr.exec(src);
    if (m) {
      // An empty parameter list (`ESC[m`) means reset, same as `ESC[0m`.
      const params = m[1] === '' ? ['0'] : m[1].split(';');
      for (const p of params) {
        const n = Number.parseInt(p, 10);
        if (Number.isInteger(n)) apply(n);
      }
      i = sgr.lastIndex;
      continue;
    }
    other.lastIndex = i;
    if (other.exec(src)) { i = other.lastIndex; continue; }
    out.push({ ch: src[i], sgr: new Set(active) });
    i += 1;
  }
  return out;
}

/**
 * Is this cell styled the way its engine styles a prompt placeholder?
 *
 * Per-engine rather than one shared rule, because the two engines express the
 * same idea with different attributes and neither should inherit the other's
 * assumption (#1105): Claude Code dims its inline suggestion with SGR 2, while
 * antigravity greys its mode banner with SGR 90. Verified against live captures
 * of both — and, importantly, of genuinely typed input in both, which carries no
 * styling at all. That last check is what makes this safe: treating a colour as
 * "not real input" would be reckless without evidence that real input is never
 * rendered in it.
 *
 * @param {{sgr: Set<number>}} cell - One cell from `_cells`.
 * @param {number[]} codes - The engine's `placeholderSgr` attributes.
 * @returns {boolean} True when any of the engine's attributes is in force.
 */
function _isPlaceholder(cell, codes) {
  if (!cell || !codes) return false;
  for (const c of codes) if (cell.sgr.has(c)) return true;
  return false;
}

/** @type {RegExp} Blank cell: ordinary space, or the NBSP a prompt pads with. */
const _BLANK_RE = /[\s ]/;

/**
 * Is this cell decoration the ENGINE drew, rather than something typed?
 *
 * Only true for an engine that declares `decorativePattern` — the field exists
 * because codex animates a braille shimmer at rest (#1344). Scoped that way on
 * purpose: for every other engine this returns false, so a character an
 * operator actually types is never discounted as decoration.
 *
 * @param {string|undefined} ch - The cell's character.
 * @param {{decorativeRe?: RegExp}} profile - The engine's detection profile.
 * @returns {boolean}
 */
function _isDecorative(ch, profile) {
  if (!ch || !profile || !profile.decorativeRe) return false;
  // `decorativeRe` is deliberately NOT global, so there is no `lastIndex` to
  // carry between calls and nothing here to remember to reset.
  return profile.decorativeRe.test(ch);
}

/**
 * Has the operator typed anything into the composer?
 *
 * Answered from the cursor rather than from the rendered text, because the two
 * disagree exactly when it matters (#1103): a pending inline suggestion draws
 * a full sentence on the prompt line while the composer is still empty, so any
 * check that reads the line as characters concludes the operator is mid-input
 * and refuses to nudge a session that is in fact at rest.
 *
 * Both sides of the cursor are checked, and each catches a case the other
 * cannot:
 *
 *   - **Before the cursor** must be blank. Typed text pushes the cursor to its
 *     right, so anything non-blank there is real input.
 *   - **After the cursor** must be blank or placeholder-styled. Without this, an
 *     operator who typed and then pressed Home would sit at the first input
 *     column with their text intact to the right, and the cursor check alone
 *     would read the pane as empty and paste over it.
 *
 * @param {{x: number, line: string}} cursor - Cursor column and its raw line.
 * @param {{promptGlyph: string, placeholderSgr: number[]}} profile - The
 *   engine's detection profile.
 * @returns {boolean|null} `true` if the composer is empty, `false` if it holds
 *   typed input, `null` if the cursor is not on a prompt line at all — a
 *   dialog, a menu, or a scrolled pane, where the caller must not infer rest.
 */
function _composerEmpty(cursor, profile) {
  if (!cursor || !profile || !profile.promptGlyph) return null;
  const cells = _cells(cursor.line);
  const glyph = cells.findIndex((c) => c.ch === profile.promptGlyph);
  // No prompt glyph on the cursor's line: not the composer. Undecidable here,
  // never "empty" — guessing rest is the failure this module exists to avoid.
  if (glyph === -1) return null;
  if (!Number.isInteger(cursor.x) || cursor.x <= glyph) return null;
  // Anything typed sits between the glyph and the cursor — but the prompt
  // draws its OWN separator there, so the scan must start after it or every
  // at-rest pane reads as holding input. An engine that declares `promptPad`
  // has been measured: Claude Code renders the empty composer as the glyph
  // plus one NBSP, with the cursor at the first input column. Past that
  // separator every cell is the operator's, whitespace included — a typed
  // space is input, and treating it as blank let a nudge paste over a
  // half-typed line (#1109).
  // Exactly ONE cell after the glyph is the separator, and either character
  // is accepted as one: the measured NBSP, or an ordinary space, in case a
  // build renders it differently. Accepting one cell rather than a run is
  // what keeps the hole closed — a typed space lands at the first input
  // column, past the separator, and is still read as input.
  const pad = profile.promptPad;
  const sep = cells[glyph + 1] && cells[glyph + 1].ch;
  // A decorative separator needs no special case here: an engine that animates
  // decoration can OVERWRITE its own pad (measured live on codex as
  // `›⠁Ask Codex to do anything`), but the scan below skips decorative cells
  // wherever they land, so the only effect of accepting one here would be to
  // shift `contentStart` past a cell that is skipped anyway. Adding that
  // condition left no mutation visible, which is the tell that it was dead.
  const padded = pad && (sep === pad || sep === ' ');
  const contentStart = padded ? glyph + 2 : glyph + 1;
  for (let i = contentStart; i < cursor.x && i < cells.length; i++) {
    // The engine drew it, not the operator, so it is not input. Scoped to
    // engines that declare the range, so nothing changes for the rest.
    if (_isDecorative(cells[i].ch, profile)) continue;
    // Engines with no measured `promptPad` keep the older, laxer reading: a
    // blank cell may be padding this module has never seen rendered, and
    // inventing a separator for an unmeasured engine would be a guess.
    if (pad || !_BLANK_RE.test(cells[i].ch)) return false;
  }
  // Anything to the right must be the suggestion (faint) or padding.
  for (let i = cursor.x; i < cells.length; i++) {
    // A decorative cell counts as blank: the engine drew it, not the operator,
    // so treating it as typed input refuses to wake a session that is at rest
    // (#1344 — codex's shimmer lands between glyph and cursor about a third of
    // the time).
    if (_isDecorative(cells[i].ch, profile)) continue;
    if (!_isPlaceholder(cells[i], profile.placeholderSgr) && !_BLANK_RE.test(cells[i].ch)) return false;
  }
  return true;
}

/**
 * Locate the composer region in a capture, and say whether it was found at all.
 *
 * Returns the composer's text only. The transcript above it is deliberately NOT
 * returned — nothing reads it, and the checks that once did are gone.
 *
 * Two readers need the same boundary: the wrap's delivery receipt, which looks
 * for its own unsubmitted paste there, and the prompt clear before an
 * injection (`tmux._clearPromptLine`), which records the operator's draft from
 * it before `C-u` destroys it (#1507). One definition, so the two cannot
 * disagree about where the box is.
 *
 * The composer is where an unsubmitted paste renders, which is what makes it
 * the evidence: finding THIS SEND'S nonce there means the text was pasted and
 * never submitted. Getting the boundary wrong is how a reader of the pane
 * mistakes the box for the transcript, and three earlier attempts at it were
 * wrong — each is recorded because the fourth
 * has to survive all of them:
 *
 * 1. **By row index** (`lines[cursor.y]`) — `capturePane` issues `-S -N` off the
 *    alternate screen, so row 0 is N rows ABOVE the pane top while `cursor_y` is
 *    pane-relative. No shared origin.
 * 2. **By matching the cursor's ONE row** — a wrap prompt renders across many
 *    composer rows, and the nonce is not last in it (`_completionInstruction`
 *    puts ~110 characters after it), so the nonce lands on a non-cursor composer
 *    row and survives a one-row filter.
 * 3. **By region, but FALLING BACK to one row when no glyph row was found.**
 *    That is this function's own previous version. The tail is bounded
 *    (`RECEIPT_TAIL_LINES`), and a composer taller than the visible pane scrolls
 *    internally, so for a multi-thousand-character prompt the glyph row is
 *    routinely absent — and the fallback silently restored defect 2.
 *
 * So a boundary that cannot be found is reported as NOT FOUND. Both halves then
 * mean nothing and the caller must not read either: no echo may be trusted, and
 * no composer claim may be made. Returning an empty string for that case is what
 * let the previous version conflate "the composer starts at row 0" with "I could
 * not find it".
 *
 * @param {Array<string>} lines - Captured pane lines.
 * @param {{line: string}|null} cursor - `cursorInfo` result.
 * @param {object} profile - Engine wake profile, for `promptGlyph`.
 * @returns {{located: boolean, composer: string, rows?: string[], cursorIndex?: number}}
 *   `rows` is the composer region as captured, and `cursorIndex` the cursor's row
 *   within it; both are present only when located. The transcript half is NOT
 *   returned: nothing reads it since the accept inference was removed, and an
 *   unread field is an invitation to rebuild the inference this module's
 *   history argues against.
 */
function locateComposer(lines, cursor, profile) {
  const NOT_LOCATED = { located: false, composer: '' };
  const rows = lines || [];
  if (!cursor || typeof cursor.line !== 'string' || !profile || !profile.promptGlyph) return NOT_LOCATED;
  const composerLine = _strip(cursor.line).trim();
  if (!composerLine) return NOT_LOCATED;

  // The cursor's row, located by CONTENT because the index cannot be trusted.
  // Last match wins: the composer is at the bottom, so a coincidental earlier
  // match in scrollback must not take the boundary with it.
  let cursorRow = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (_strip(String(rows[i])).trim() === composerLine) { cursorRow = i; break; }
  }
  if (cursorRow === -1) return NOT_LOCATED;

  // The composer's first row is the nearest glyph-led row at or above the
  // cursor. `trimStart().startsWith(glyph)` rather than `includes`, matching
  // `medusa-wake._paneDigest`: a glyph appearing mid-line is transcript text
  // that happens to contain the character, not a prompt.
  let start = -1;
  for (let i = cursorRow; i >= 0; i--) {
    if (_strip(String(rows[i])).trimStart().startsWith(profile.promptGlyph)) { start = i; break; }
  }
  // NO FALLBACK. An absent glyph row means the composer's head scrolled out of
  // the bounded tail, and guessing the boundary is how defect 2 came back.
  if (start === -1) return NOT_LOCATED;

  // `rows` and `cursorIndex` let a reader stop at the cursor: the rows below it
  // are the engine's own chrome (dividers, the status footer), never input.
  const region = rows.slice(start);
  return { located: true, composer: region.join('\n'), rows: region, cursorIndex: cursorRow - start };
}

/**
 * What the operator has typed into the composer, read from a captured pane.
 *
 * The draft half of the composer reading that `_composerEmpty` does for the wake
 * gate, built from the same rules so the two cannot disagree: the engine's own
 * glyph and separator, its decorative cells, and the composer region
 * `locateComposer` finds. Its reader is the prompt clear before an injection
 * (`tmux._clearPromptLine`), which must record a draft it is about to destroy
 * (#1507) and must never record something else as one.
 *
 * - The cursor on the glyph row, with input: the draft.
 * - The cursor on a row WITHOUT the glyph: where it rests after a draft wraps
 *   onto more rows, and also in a dialog, a menu or a scrolled pane. Only a
 *   composer box tells those apart — the glyph row directly under a border and
 *   no border between it and the cursor — so without one this answers "not
 *   located", never a guess.
 * - The draft runs from the glyph row to the composer's lower border. With no
 *   lower border in view it stops at the cursor's row and says it may be
 *   incomplete (`complete: false`), because below the cursor is where an
 *   unboxed engine draws its footer.
 *
 * @param {string[]} lines - Captured pane rows.
 * @param {{x: number, line: string}|null} cursor - `tmux.cursorInfo` result.
 * @param {object|null} profile - The engine's wake profile.
 * @returns {{state: 'empty'|'draft'|'not-located', text: string, reason: (string|null),
 *   draftPresent: (boolean|null), rows: number, complete: boolean}}
 */
function readComposerDraft(lines, cursor, profile) {
  const notLocated = (reason, draftPresent = null) => ({ state: 'not-located', text: '', reason, draftPresent, rows: 0, complete: false });
  if (!profile || !profile.promptGlyph) return notLocated('no composer profile');
  if (!cursor) return notLocated('the cursor position was unavailable');
  const empty = _composerEmpty(cursor, profile);
  if (empty === true) return { state: 'empty', text: '', reason: null, draftPresent: false, rows: 0, complete: true };

  const rows = (lines || []).map((r) => _strip(String(r)));
  const located = locateComposer(rows, cursor, profile);
  if (empty === false && !located.located) {
    return notLocated('the composer holds input, but its first row is not in the captured tail', true);
  }
  if (empty === null) {
    const start = located.located ? rows.length - located.rows.length : -1;
    const boxed = start >= 1 && _isDivider(rows[start - 1])
      && !located.rows.slice(1, located.cursorIndex + 1).some(_isDivider);
    if (!boxed) {
      return notLocated('the cursor is not on a composer row this engine\'s profile can identify (a dialog, a menu, a scrolled pane, or a wrapped draft with no composer border)');
    }
  }
  return _draftFromRegion(located, profile);
}

/**
 * The operator's text from a located composer region.
 *
 * @param {{rows: string[], cursorIndex: number}} located - From `locateComposer`, stripped rows.
 * @param {object} profile - The engine's wake profile.
 * @returns {{state: 'draft', text: string, reason: null, draftPresent: true, rows: number, complete: boolean}}
 */
function _draftFromRegion(located, profile) {
  const border = located.rows.findIndex((r, i) => i > 0 && _isDivider(r));
  const complete = border !== -1;
  const region = located.rows.slice(0, complete ? border : located.cursorIndex + 1);
  const cells = (row) => [...row].filter((ch) => !_isDecorative(ch, profile)).join('');
  const first = cells(region[0]);
  const glyphAt = first.indexOf(profile.promptGlyph);
  let body = first.slice(glyphAt + profile.promptGlyph.length);
  // The separator rule `_composerEmpty` applies: an engine with a measured pad
  // draws exactly one separator cell (its pad, or a plain space); an engine
  // with none measured keeps the laxer reading, where leading blanks may be
  // padding this module has never seen rendered.
  let column = glyphAt + profile.promptGlyph.length;
  if (profile.promptPad) {
    if (body[0] === profile.promptPad || body[0] === ' ') { body = body.slice(1); column += 1; }
  } else {
    const blanks = body.length - body.replace(/^[\s\u00a0]+/, '').length;
    body = body.slice(blanks);
    column += blanks;
  }
  // A wrapped row is indented to the first row's text column; that indent is
  // layout, not something the operator typed.
  const unindent = (row) => row.slice(Math.min(column, row.length - row.replace(/^[\s\u00a0]+/, '').length));
  const text = [body, ...region.slice(1).map((r) => unindent(cells(r)))]
    .map((r) => r.replace(/[\s\u00a0]+$/, '')).join('\n').trim();
  return { state: 'draft', text, reason: null, draftPresent: true, rows: region.length, complete };
}

/**
 * The full at-rest judgement for a pane: markers, movement, and a streak.
 *
 * `_assessPane` alone is NOT this decision — it is one third of it, and using
 * it by itself is the mistake #1114 measured and rejected. For Claude the
 * busy marker does not render on an ordinary turn and the bare prompt is drawn
 * throughout, so the marker gates call a mid-stream pane `at-prompt`
 * (`test/medusa-wake.test.js` asserts exactly that as a precondition). What
 * separates working from resting is the transcript MOVING, plus a streak so a
 * single quiet sample cannot decide.
 *
 * Pure and state-passing: the caller owns `prevDigest` and `idleTicks` and
 * feeds back what this returns. That is what lets two different consumers —
 * the Medusa wake monitor and the session status the chime reads — share one
 * gate instead of growing two that drift.
 *
 * **What it does not do.** A tool call that prints nothing looks, to any pane
 * reader, exactly like a session waiting at its prompt. This composition is
 * strictly more conservative than a staleness timer (it additionally requires
 * the pane to LOOK at rest and to hold still across ticks) but it cannot see
 * work that produces no output.
 *
 * @param {object} opts
 * @param {string[]} opts.lines - Captured pane lines.
 * @param {object} opts.profile - Engine wake profile.
 * @param {object|null} [opts.cursor] - `cursorInfo` result, or null when unavailable.
 * @param {string} [opts.prevDigest] - Digest from the previous tick; undefined on the first.
 * @param {number} [opts.idleTicks] - Consecutive idle ticks so far.
 * @param {number} [opts.ticksRequired] - Streak needed; defaults to IDLE_TICKS_REQUIRED.
 * @param {boolean} [opts.mustBeTypeable=true] - Require the pane be safe to type into
 *   (an injector must; a notifier must not, or it goes silent on a permission
 *   dialog and on a composer holding the operator's half-typed text).
 * @param {boolean} [opts.engineIdle=false] - The engine's own protocol says its
 *   thread is idle; see `_assessActivity` for the one gate that lifts.
 * @returns {{idle: boolean, reason: string, digest: string, idleTicks: number}}
 */
function assessSessionIdle(opts) {
  const o = opts || {};
  const lines = o.lines || [];
  const profile = o.profile;
  const required = typeof o.ticksRequired === 'number' ? o.ticksRequired : IDLE_TICKS_REQUIRED;
  const digest = _paneDigest(lines, profile);
  const moved = o.prevDigest !== undefined && o.prevDigest !== digest;

  // `mustBeTypeable` picks the question. The wake monitor TYPES into the pane,
  // so it needs paste safety and must refuse a dialog or a filled composer.
  // A notifier only reports, and those two states are the ones it most needs
  // to fire on: a session blocked on a permission prompt is exactly what the
  // operator is waiting to hear about.
  const typeable = o.mustBeTypeable !== false;
  const verdict = typeable
    ? _assessPane(lines, profile, o.cursor === undefined ? null : o.cursor, o.engineIdle === true)
    : (() => {
      const a = _assessActivity(_strip(lines.join('\n')), profile, o.engineIdle === true);
      return { idle: !a.working, reason: a.working ? a.reason : 'at-rest' };
    })();
  if (!verdict.idle) {
    return { idle: false, reason: verdict.reason, digest, idleTicks: 0 };
  }
  // Sits BELOW the marker gates so their reasons stay reportable, and above the
  // streak so a pane that is still writing can never accumulate one.
  if (moved) {
    return { idle: false, reason: 'pane-writing', digest, idleTicks: 0 };
  }
  const idleTicks = (o.idleTicks || 0) + 1;
  return { idle: idleTicks >= required, reason: verdict.reason, digest, idleTicks };
}

/**
 * Is a turn in flight in this pane?
 *
 * The activity half of the old combined check: the engine's busy marker, a
 * running subagent fleet (#783 — the agent block is the signal, not the
 * status-line hint), and, where a profile declares one, an at-rest marker
 * whose ABSENCE means the engine is doing something.
 *
 * Deliberately says nothing about whether the pane is safe to type into. A
 * notifier wants exactly this question; an injector wants `_assessPane`, which
 * adds the composer and bare-prompt checks on top.
 *
 * An engine whose own protocol has said its thread is idle (`engineIdle`) is
 * excused the at-rest marker, and only that. The marker is a rendering the
 * operator's status-line layout can omit, which held Codex mail for hours
 * (#1628); the protocol answer is the thing the marker was standing in for.
 * The busy marker and the fleet block still refuse: a pane that SHOWS work
 * outranks a protocol that says there is none.
 *
 * @param {string} text - The pane's ANSI-stripped text (already joined).
 * @param {object} profile - Engine wake profile.
 * @param {boolean} [engineIdle=false] - The engine's protocol reports its thread idle.
 * @returns {{working: boolean, reason: string|null}} `reason` names the gate that fired.
 */
function _assessActivity(text, profile, engineIdle = false) {
  if (text.includes(profile.busyMarker)) return { working: true, reason: 'turn-in-flight' };
  // A running subagent fleet makes the pane unsafe to type into, so this gate
  // sits above the prompt checks rather than beside them (#783) — see
  // `_FLEET_RE` for why the agent block is the signal and the status-line
  // `← N agents` hint is not.
  if (_FLEET_RE.test(text)) return { working: true, reason: 'agents-running' };
  if (profile.idleMarker && !engineIdle && !text.includes(profile.idleMarker)) {
    return { working: true, reason: 'not-at-rest' };
  }
  return { working: false, reason: null };
}

/**
 * Is this pane at rest AND safe to type into?
 *
 * Two questions in one answer, which is exactly what an INJECTOR needs: it
 * must not paste over a dialog or over text the operator has half-typed. A
 * consumer that only wants to know whether the engine has stopped — a
 * notifier — should ask `_assessActivity` instead, because a permission dialog
 * (`no-prompt`) and a filled composer (`composer-has-input`) are both refusals
 * here while being precisely the moments a notifier exists for.
 *
 * The two refusal codes replaced a single `no-bare-prompt`. Delivery-ledger
 * rows written before the split still carry `pane-no-bare-prompt`; they are
 * read verbatim and mean "one of the two, undistinguished" — rewriting them
 * would require knowing which, and nothing recorded that.
 *
 * @param {string[]} lines - Captured pane lines.
 * @param {object} profile - Engine wake profile.
 * @param {object|null} cursor - `cursorInfo` result, or null.
 * @param {boolean} [engineIdle=false] - The engine's protocol reports its thread idle.
 * @returns {{idle: boolean, reason: string}}
 */
function _assessPane(lines, profile, cursor, engineIdle = false) {
  const text = _strip((lines || []).join('\n'));
  const activity = _assessActivity(text, profile, engineIdle);
  if (activity.working) return { idle: false, reason: activity.reason };
  // Cursor first when it is available, because it answers the question the
  // rendered text only approximates (#1103): a pending inline suggestion draws
  // a sentence on the prompt line that the text check cannot tell from typed
  // input. `null` means the cursor is not on a prompt line at all, which is not
  // evidence of rest — fall through to the text check rather than assume.
  const composerEmpty = _composerEmpty(cursor, profile);
  if (composerEmpty === true) return { idle: true, reason: 'at-prompt' };
  // The switchboard's own nudge, stranded by a lost Enter, is not the
  // operator's input: the injector's prompt clear removes it and the fresh
  // nudge replaces it (#1621). Checked before both refusals below, because a
  // wrapped nudge leaves the cursor on a continuation row, where the cursor
  // check is undecidable and the text check alone would say `no-prompt`. Only a
  // composer seen to its lower border qualifies: without the border, operator
  // text after the nudge could sit below the capture.
  if (cursor) {
    const draft = readComposerDraft(lines, cursor, profile);
    if (draft.state === 'draft' && draft.complete && isOwnNudge(draft.text)) {
      return { idle: true, reason: 'at-prompt' };
    }
  }
  // Only the cursor can say the operator typed something: it sits on the
  // composer line with input before or after it. That is the one refusal a
  // sender can act on differently ("they are mid-sentence"), so it gets its
  // own code. Its limit is the cursor check's own: text on a glyph-led line
  // under the cursor is read as input, so a selector row drawn with the prompt
  // glyph AND holding the cursor would also land here. No per-engine dialog
  // pattern is added to tell them apart — a mislabelled refusal is still a
  // refusal, and a guessed dialog signature is the hazard this module avoids.
  if (composerEmpty === false) return { idle: false, reason: 'composer-has-input' };

  // Everything else the text check refuses is `no-prompt`: a dialog, a menu, a
  // scrolled pane — and also typed text seen WITHOUT a cursor, because the
  // rendered line alone cannot tell typed input from option rows or a pending
  // suggestion. Naming it `composer-has-input` there would claim an
  // observation this path never made.
  const hasBarePrompt = text.split('\n').some((l) => profile.promptRe.test(l));
  if (!hasBarePrompt) return { idle: false, reason: 'no-prompt' };
  return { idle: true, reason: 'at-prompt' };
}

/**
 * The id the exchange record knows an inbox message by, or null when it
 * carries none. The record is keyed on the body's `id` alone: that is what an
 * arrival and a read are recorded under. Not the watermark's key, which may
 * prefer another field: see `_newestKey`.
 * @param {object} message - An inbox message
 * @returns {string|null}
 */
function _recordId(message) {
  return message && message.id != null ? String(message.id) : null;
}

/**
 * Identity key of the newest inbox message, for the nudge watermark. Prefers
 * the Bridge's `messageId`/`id`; falls back to a length-stamped key so a
 * missing id still advances the watermark on new arrivals.
 * @param {Array<object>} inbox - The session's inbox (oldest first).
 * @returns {string|null} Key of the newest message, or null when empty.
 */
function _newestKey(inbox) {
  if (!inbox || inbox.length === 0) return null;
  const last = inbox[inbox.length - 1];
  const id = last && (last.messageId != null ? last.messageId : last.id);
  return id != null ? String(id) : `len:${inbox.length}`;
}

/**
 * Build the fixed nudge line for a project. Contains ONLY TC-controlled bytes
 * (safety property 2) — never message content; single line (no embedded
 * newlines — `tmux.sendKeys` sends one Enter, after the full line).
 * @param {string} projectName - The receiving session's project.
 * @param {number} unread - Unread count (informational only).
 * @returns {string} The nudge line.
 */
function _nudgeLine(projectName, unread) {
  return _nudgeLineFor(`/api/sessions/${encodeURIComponent(projectName)}/medusa`, unread);
}

/**
 * The origin a woken session should call.
 *
 * The nudge used to say the base URL was "in your project guide". It is not —
 * and for a plugin-governed project TangleClaw does not write that guide at
 * all, so the pointer dangled and the session's only option was to guess the
 * port (#1020). Worse, the one concrete base URL anywhere in the prime is
 * MEDUSA's own `:3009` from the embedded consumer contract, so a session
 * following the instruction faithfully lands on the wrong server.
 *
 * Read from what the server ACTUALLY serves, not from config intent: the
 * plist's `TANGLECLAW_PORT` overrides `config.serverPort`, and caddy / no-cert
 * installs bind plain HTTP even with `httpsEnabled` set.
 *
 * Loopback rather than a hostname because the reader is an agent in a tmux pane
 * on this host — the same reason the generated engine configs state
 * `localhost`. That is not the operator's front door, which is a different
 * question with a different helper.
 * @returns {string} e.g. `http://localhost:3102`
 */
function _apiOrigin() {
  try {
    const https = require('./https-setup');
    const config = require('./store').config.load();
    return `${https.effectiveServerProtocol(config)}://localhost:${https.effectiveServerPort(config)}`;
  } catch (err) {
    log.warn('Could not resolve the API origin for the wake nudge', { error: err.message });
    return 'the TangleClaw API';
  }
}

/** The Project Master's switchboard API base: the one base that is not a project's. */
const MASTER_API_BASE = '/api/master/medusa';

/**
 * The longest paste the Claude Code composer shows verbatim. One character
 * more and it shows `[Pasted text #N]` instead (measured on 2.1.283, at 80 and
 * at 160 columns). A nudge is pasted, and one whose Enter is lost is recognised
 * only by reading the composer back, so a nudge that collapses to a placeholder
 * can never be recognised as ours: every nudge must stay under this, wake
 * reference included.
 */
const COMPOSER_VERBATIM_MAX = 800;

/**
 * The nudge text in one of its two forms. A project session is told to reply
 * through `tc message`, which sends its launch headers. The Project Master is
 * not: `tc message` resolves a project name and the Master has none, so every
 * `tc message` command refuses in its pane. Its line names only the raw routes
 * mounted for it.
 *
 * The project form names the API base once and its three routes relative to
 * it. The base carries the URL-encoded project name, which can reach 192
 * characters, so each further mention costs that much again against
 * `COMPOSER_VERBATIM_MAX`.
 * @param {string} apiBase - The recipient's switchboard API base path.
 * @param {number|string} unread - Unread count (informational only).
 * @param {string} origin - The API origin to state.
 * @param {boolean} forMaster - Build the Master's form.
 * @returns {string} The nudge line.
 */
function _nudgeText(apiBase, unread, origin, forMaster) {
  if (forMaster) {
    return `[TangleClaw Switchboard] You have ${unread} unread Medusa message(s). ` +
      `Fetch them from the TangleClaw API at ${origin}: ` +
      `GET ${apiBase}/messages — act on them as appropriate. ` +
      `Reply to each one that needs an answer BEFORE marking it handled: ` +
      `POST ${apiBase}/send {"to":"<sender-workspace-id>","message":"<reply>"}; ` +
      `then mark it handled: POST ${apiBase}/read {"ids":[...]}. ` +
      `The initiator closes the exchange, so a message you do not answer leaves them blocked. ` +
      `Never use /clear as an acknowledgement.`;
  }
  // Reply BEFORE the ack, through `tc` (#1976). A raw send carrying inReplyTo
  // without the launch headers is refused, and one sent without inReplyTo
  // records no reply, so the order and the carrier are both named: the nudge
  // is what is in front of the model when it acts.
  return `[TangleClaw Switchboard] You have ${unread} unread Medusa message(s): tc message read. ` +
    `Reply where an answer is needed, BEFORE marking it handled: ` +
    `tc message send --in-reply-to <message-id> <sender-workspace-id> "<reply>"; ` +
    `then tc message ack <message-id>. ` +
    `The initiator closes the exchange, so no answer leaves them blocked; ` +
    `tc message owed lists what you owe. Never use /clear as an acknowledgement. ` +
    `Without tc: API at ${origin}${apiBase}: ` +
    `GET /messages, POST /send (inReplyTo + launch headers), POST /read.`;
}

/**
 * The nudge line for any switchboard API base — a project session's
 * `/api/sessions/:project/medusa` or the Master's `/api/master/medusa`. The
 * base decides the form (see `_nudgeText`), so no caller can hand the Master
 * the project wording; the bytes are fixed TC-controlled text either way
 * (safety property 2).
 * @param {string} apiBase - The recipient's switchboard API base path.
 * @param {number} unread - Unread count (informational only).
 * @param {string} [origin] - The API origin to state; resolved when omitted.
 * @returns {string} The nudge line.
 */
function _nudgeLineFor(apiBase, unread, origin) {
  return _nudgeText(apiBase, unread, origin || _internal.apiOrigin(), apiBase === MASTER_API_BASE);
}

/**
 * Compile the stranded-nudge pattern for one form of the nudge.
 * @param {boolean} forMaster - Which form of `_nudgeText` to derive from.
 * @returns {RegExp} Anchored pattern over whitespace-stripped composer text.
 */
function _ownNudgePattern(forMaster) {
  const S = { unread: '\u0000UNREAD\u0000', base: '\u0000BASE\u0000', origin: '\u0000ORIGIN\u0000', nonce: '\u0000NONCE\u0000' };
  const template = wakeTransports.withNonce(_nudgeText(S.base, S.unread, S.origin, forMaster), S.nonce);
  const escaped = template.replace(/[\s ]+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const firstBase = forMaster ? '(/api/master/medusa)' : '(/api/sessions/[^/\\s]+/medusa)';
  let seenBase = false;
  const body = escaped
    .replace(S.unread, '\\d+')
    .replace(S.origin, '(?:https?://[^/\\s]+|theTangleClawAPI)')
    .replace(S.nonce, '[0-9a-f]{12}')
    .split(S.base)
    .reduce((acc, part, i) => {
      if (i === 0) return part;
      const slot = seenBase ? '\\1' : firstBase;
      seenBase = true;
      return acc + slot + part;
    }, '');
  return new RegExp(`^${body}$`);
}

/** Built on first use: one pattern per form of the nudge, from `_nudgeText` and `withNonce`. */
let _ownNudgeRes = null;

/**
 * Does this composer text consist of one switchboard nudge and nothing else?
 *
 * A nudge whose Enter is lost stays in the composer unsubmitted (#1621). The
 * receipt check sees its nonce there and the watchdog re-arms the wake, but the
 * re-arm passes the same draft gate as any wake. Without this, that gate reads
 * the stranded nudge as the operator's half-typed text and refuses the re-arm
 * it earned, and every later wake too, until the exchange escalates.
 *
 * The patterns are derived from `_nudgeText` and `withNonce` rather than
 * restated, one for the project form and one for the Master's, so a change to
 * either wording cannot leave this behind. Every
 * variable slot is pinned to what those functions can produce: a count, an
 * `http(s)://host` origin or the unresolved-origin fallback, one switchboard
 * base of that form's kind repeated in every path, and a 12-hex nonce.
 * Whitespace is removed from both sides before comparing, because the composer
 * wraps the line wherever its width falls, words included. Text before or after the nudge,
 * however little, fails the match; a line that only happens to resemble the
 * nudge is refused unless every slot fits.
 *
 * @param {string} text - The composer's text, as `readComposerDraft` returns it.
 * @returns {boolean}
 */
function isOwnNudge(text) {
  if (typeof text !== 'string' || !text) return false;
  if (!_ownNudgeRes) _ownNudgeRes = [_ownNudgePattern(false), _ownNudgePattern(true)];
  const flat = text.replace(/[\s ]+/g, '');
  return _ownNudgeRes.some((re) => re.test(flat));
}

/**
 * Scan one live session and keep its latest verdict for senders to read.
 *
 * The verdict is written HERE, around the judgement, rather than at each of its
 * exits: every path through `_judgeSession` must return the code for what it
 * observed, so a new gate that forgets to name itself is recorded as
 * `unclassified` and logged (once, on entering that state — see `_noteVerdict`)
 * instead of leaving the previous tick's verdict standing as if it were
 * current. The test that derives the monitor's codes from this file's return
 * sites is what catches it before it ships.
 * @param {object} session - A `store.sessions.listLiveAll()` record.
 * @param {object} [opts]
 * @param {boolean} [opts.async=false] - Read the pane without blocking, and
 *   finish the judgment when the read answers.
 * @param {boolean} [opts.prompt=false] - A look something asked for, not the
 *   timer's: if it finds the pane at rest, one follow-up look is booked.
 * @param {boolean} [opts.followUp=false] - That booked follow-up look.
 * @returns {string} The verdict this scan stamped on the session, or
 *   `pane-read-started` when the judgment is waiting on a pane read.
 */
function _scanSession(session, opts = {}) {
  const sessionId = session.id;
  let st = _sessions.get(sessionId);
  if (!st) {
    st = { idleTicks: 0, lastNudgedKey: null, skipLogged: false, configWarnLogged: false, cursorWarnLogged: false, lastRecorded: null, verdict: null };
    _sessions.set(sessionId, st);
  }
  st.projectId = session.projectId ?? null;
  // What the monitor has observed belongs to one pane of one launch. If this
  // id now names another, none of it carries over: the streak, the digest, the
  // backoff and any booked follow-up were all about a pane that is not this one.
  const identity = `${session.tmuxSession ?? ''}|${session.startedAt ?? ''}|${session.projectId ?? ''}`;
  if (st.identity !== undefined && st.identity !== identity) {
    _cancelFollowUp(st);
    st.idleTicks = 0;
    st.paneDigest = undefined;
    st.lastPaneAnswerAt = null;
    st.slowPaneReads = 0;
    st.paneBackoffUntil = null;
  }
  st.identity = identity;
  // A second look is booked for this session, at the first moment it can count
  // as a second observation. The timer leaves the session to it: a tick landing
  // in between would be too close to the first observation and would restart
  // the streak the follow-up exists to complete. Only while the booking is
  // still due: one that is overdue has been lost, and holding the session for
  // it would mean never looking at it again.
  if (st.followUp && !opts.followUp) {
    if (_followUpPending(st)) return PANE_READ_STARTED;
    _cancelFollowUp(st);
  }
  // One pane read per session at a time. A read still in flight when the next
  // tick comes round means that tick does not look at the pane, so the idle
  // streak ends: the read's answer, when it lands, is a first observation.
  if (st.readInFlight) {
    st.idleTicks = 0;
    return PANE_READ_STARTED;
  }
  const reason = _judgeSession(session, st, opts.async ? { async: true, prompt: opts.prompt === true } : null);
  if (reason === PANE_READ_STARTED) return reason;
  _noteVerdict(st, reason, sessionId);
  _noteStall(st, sessionId);
  return st.verdict.reason;
}

/**
 * Say once, per episode, that a session's wake has been held as
 * `engine-thread-unknown` past `WAKE_STALL_ALERT_MS`. An episode is one
 * unbroken run of that verdict — the verdict's own `since` — so any other
 * verdict (an idle or busy answer, the mail read, the session gone) ends it,
 * and the next one is said again.
 * @param {object} st - Per-session monitor state, its verdict just stamped.
 * @param {string|number} sessionId - The session.
 * @returns {void}
 */
function _noteStall(st, sessionId) {
  const v = st.verdict;
  if (!v || v.reason !== WAKE_STALL_CODE) {
    st.stallAlerted = false;
    return;
  }
  if (st.stallAlerted || _internal.now() - Date.parse(v.since) < WAKE_STALL_ALERT_MS) return;
  st.stallAlerted = true;
  log.warn('medusa-wake: wakes to this session have been held for want of an engine answer — its mail is waiting unseen', {
    sessionId, projectId: st.projectId, engineReason: st.engineReason || null, since: v.since
  });
}

/**
 * The stall evidence `/api/server-info` reports (#1978): live sessions whose wake has been held
 * as `engine-thread-unknown`, with mail waiting, for at least
 * `WAKE_STALL_ALERT_MS`, and the oldest of them. Derived from the verdicts
 * the monitor already keeps, so it stands exactly as long as the condition
 * does, with no timer of its own, and it never injects,
 * sends or asks anything.
 * @param {number} [now] - Server time.
 * @returns {{count: number, oldest: {sessionId: number, project: (string|null), engineReason: (string|null), ageMinutes: number, since: string, meaning: string}}|null}
 */
function wakeStallSummary(now = _internal.now()) {
  const stalled = [];
  for (const [sessionId, st] of _sessions) {
    const v = st.verdict;
    if (!v || v.reason !== WAKE_STALL_CODE) continue;
    const age = now - Date.parse(v.since);
    if (!(age >= WAKE_STALL_ALERT_MS)) continue;
    stalled.push({ sessionId, st, age, since: v.since });
  }
  if (stalled.length === 0) return null;
  stalled.sort((a, b) => b.age - a.age);
  const o = stalled[0];
  let project = null;
  try {
    const p = o.st.projectId != null ? _internal.getProject(o.st.projectId) : null;
    project = p ? p.name : null;
  } catch (err) {
    log.warn('medusa-wake: could not name the stalled session\'s project', { sessionId: o.sessionId, error: err.message });
  }
  return {
    count: stalled.length,
    oldest: {
      sessionId: o.sessionId, project, engineReason: o.st.engineReason || null,
      ageMinutes: Math.floor(o.age / 60000), since: o.since, meaning: peerReasonMeaning(WAKE_STALL_CODE)
    }
  };
}

/**
 * Stamp a session's verdict. `since` marks when this reason began and survives
 * repeat observations of it; `observedAt` moves on every tick, so a reader can
 * tell a verdict the monitor re-confirmed a moment ago from one it has not
 * looked at since.
 *
 * A gate that returned no code is a defect in this file, and it is said out
 * loud: one warning when a session ENTERS `unclassified`, never one per tick
 * while it stays there (the monitor runs every five seconds, and a line per
 * tick would bury the one that names the session).
 * @param {object} st - Per-session monitor state.
 * @param {string} reason - The code `_judgeSession` returned.
 * @param {string|number} [sessionId] - The session judged, for the log line.
 * @returns {void}
 */
function _noteVerdict(st, reason, sessionId) {
  const now = new Date(_internal.now()).toISOString();
  const code = typeof reason === 'string' && reason ? reason : 'unclassified';
  const previous = st.verdict ? st.verdict.reason : null;
  if (code === 'unclassified' && previous !== 'unclassified') {
    log.warn('medusa-wake: a gate returned no reason code — senders see `unclassified` for this session', {
      sessionId, returned: reason === undefined ? String(reason) : JSON.stringify(reason)
    });
  }
  const since = previous === code ? st.verdict.since : now;
  st.verdict = { reason: code, since, observedAt: now };
}

/**
 * Gate one session (transport → engine → pref → listener → fresh mail → idle
 * debounce), then inject the nudge and advance the watermark.
 * @param {object} session - A `store.sessions.listLiveAll()` record.
 * @param {object} st - Per-session monitor state.
 * @param {object|null} [read] - How the pane is read (#2086). Absent, it is
 *   read synchronously through the `capturePane` and `cursorInfo` seams.
 *   `{async: true}` starts a non-blocking read and returns
 *   `pane-read-started`. `{prefetched}` is that read's answer: the whole gate
 *   chain runs again from the top, so whatever changed while tmux was being
 *   asked is judged as it is now, and only the pane read itself is reused.
 * @returns {string} The reason code for what this tick observed — the vocabulary
 *   `peerReachability` hands a sender.
 */
function _judgeSession(session, st, read = null) {
  const sessionId = session.id;

  /**
   * Record what became of the nudge for the session's current inbox edge (#792).
   *
   * Two rules keep this a ledger of EVENTS rather than of polling. First, it
   * records a transition: the monitor runs on a timer, so a row per tick would
   * bury the one moment that matters and blow through retention within an hour.
   * Second, it records only when there is mail to miss — a session with an empty
   * inbox has not been failed by anything, and rows saying so would drown the
   * ones that mean something.
   *
   * Non-throwing by design, for the same reason the rules ledger is: an audit
   * write must never be the reason a nudge does not happen.
   *
   * @param {string} outcome - One of `nudged` | `skipped` | `failed`.
   * @param {string} channel - Delivery channel, or `none` when never attempted.
   * @param {string|null} reason - Why not; required unless nudged.
   * @returns {void}
   */
  function record(outcome, channel, reason) {
    let status;
    try {
      status = _internal.getStatus(sessionId);
    } catch {
      return; // no identity, nothing to say about its mail
    }
    if (!status || status.unread === 0) return;

    let key;
    try {
      key = _newestKey(_internal.getMessages(sessionId));
    } catch {
      key = null;
    }
    if (key === null) return;

    const stamp = `${key}|${outcome}|${reason || ''}`;
    if (st.lastRecorded === stamp) return;
    st.lastRecorded = stamp;

    try {
      _internal.recordDelivery({
        sessionId,
        projectId: session.projectId ?? null,
        workspaceId: status.workspaceId || null,
        messageKey: key,
        unread: status.unread,
        channel,
        outcome,
        skipReason: reason || undefined
      });
    } catch (err) {
      log.warn('medusa-wake: failed to record a delivery outcome', {
        sessionId, outcome, error: err.message
      });
    }
    // #1839: the same verdict on each exchange the wake is about. A nudge is
    // recorded where it is made, with its nonce.
    if (outcome !== 'nudged') _wakeFact(sessionId, status.workspaceId, 'wake_blocked', outcome === 'failed' ? 'inject-failed' : reason);
  }


  // Transport + engine gates (#560 — engine-aware): a live tmux pane and a
  // known wake profile for the session's engine. webui has no pane; an
  // unprofiled engine has no live-captured idle signature to type against
  // safely. Logged once per session so an unsupported-but-opted-in session is
  // never a silent no-op.
  //
  // The level is fixed at info rather than derived from `settingDisposition`
  // the way `engines.reportMissingConfigCarrier` derives its own, and that is
  // deliberate: this gate runs BEFORE the opt-in read below, so the provenance
  // the level would come from — whether the operator actually set
  // `medusaWake` — is not known here, and loading every unprofiled session's
  // project config on every five-second tick to find out is a cost this gate
  // exists to avoid. ADR 0013's operator-facing half is met by the settings
  // modal, which reads the same disposition; the log is for after the fact.
  const profile = _resolveWakeProfiles()[session.engineId];
  if (session.sessionMode === 'webui' || !session.tmuxSession || !profile) {
    if (!st.skipLogged) {
      st.skipLogged = true;
      log.info('medusa-wake: session skipped (unsupported transport or unprofiled engine)', {
        sessionId, sessionMode: session.sessionMode, engineId: session.engineId
      });
    }
    const why = session.sessionMode === 'webui' ? 'no-pane' : 'unprofiled-engine';
    record('skipped', 'none', why);
    return why;
  }

  // A session that has ended — never nudge it. This fires on the race where a
  // session ends between the roster read and this scan; `listLiveAll` returns
  // only live rows, so it is not the ordinary path.
  //
  // It is NOT the mid-wrap guard. It used to be one, back when a wrapping
  // session held its own status; a session now holds `active` for the whole of
  // its wrap, and the wrap gate below is what keeps this monitor from typing
  // into a pane the pipeline is driving.
  // Lazily required like every other store reference in this file — the
  // module-level requires are deliberately absent to keep the store graph
  // out of anyone who requires the wake monitor.
  if (session.status && session.status !== require('./store').SESSION_STATUS.ACTIVE) {
    st.idleTicks = 0;
    record('skipped', 'none', `session-${session.status}`);
    return `session-${session.status}`;
  }

  // Who is being scanned decides two things and nothing else: where the opt-in
  // is read from, and how the nudge is delivered. Every gate between — listener
  // state, fresh mail, the idle verdict, the debounce — is identical, because
  // the safety property those gates protect (never type into a busy pane) does
  // not care whose pane it is.
  //
  // The Master carries its opt-in ON the record (`lib/master.js#masterWakeRecord`
  // reads it from global config) because it has no project config to load; a
  // project session's lives in its project config, read here.
  let project = null;
  let optedIn;
  if (session.isMaster) {
    optedIn = session.medusaWake === true;
  } else {
    project = _internal.getProject(session.projectId);
    if (!project) { st.idleTicks = 0; record('skipped', 'none', 'no-project'); return 'no-project'; }

    // Never type into a pane while the registry reports a wrap live over it.
    // The at-prompt and debounce gates below make a collision unlikely, not
    // impossible: a wrap pauses between steps, and a pane that looks at rest
    // there is exactly the shape this monitor acts on. The registry is the only
    // thing that knows a wrap is running — it is process-local module state in
    // this same process, and it is what replaced the session status that used
    // to carry this.
    //
    // A registry read that throws must not cost the tick: the gate's job is to
    // withhold a nudge, and an unreadable registry is a reason to withhold it,
    // not a reason to send one.
    let wrapRunning;
    try {
      wrapRunning = _internal.wrapRunning(project.name);
    } catch (err) {
      log.warn('medusa-wake: wrap-run registry unreadable — holding the nudge', {
        sessionId, project: project.name, error: err.message
      });
      wrapRunning = true;
    }
    if (wrapRunning) {
      st.idleTicks = 0;
      record('skipped', 'none', 'wrap-running');
      return 'wrap-running';
    }
    // Never type into a coordinator in managed context rotation (#2032): the
    // rotation types its own /clear and delivers its own re-entry turn, and
    // mail that arrives meanwhile is the replacement context's to reconcile.
    // Once its resume receipt is accepted the rotation closes and this gate
    // opens; a newer inbox edge is then nudged once like any other. An
    // unreadable rotation record withholds the nudge, as the wrap gate does.
    let rotating;
    try {
      rotating = _internal.rotationOpen(project.id);
    } catch (err) {
      log.warn('medusa-wake: rotation record unreadable — holding the nudge', {
        sessionId, project: project.name, error: err.message
      });
      rotating = true;
    }
    if (rotating) {
      st.idleTicks = 0;
      record('skipped', 'none', 'coordinator-rotating');
      return 'coordinator-rotating';
    }
    // Inside the project branch, so the Master gets no wrap gate. Correct while
    // the Master has no wrap of its own to run; if it ever gains one, this gate
    // has to move above the Master/project split with a key the registry knows.

    // Opt-in gate: the wake spends a turn — explicit `medusaWake: true` only.
    let projConfig;
    try {
      projConfig = _internal.loadProjectConfig(project.path);
    } catch (err) {
      // Unreadable config — treat as opted out this tick, but never silently:
      // log once per session (the module's no-silent-skip discipline).
      if (!st.configWarnLogged) {
        st.configWarnLogged = true;
        log.warn('medusa-wake: project config unreadable — treating as opted out', {
          sessionId, project: project.name, error: err.message
        });
      }
      st.idleTicks = 0;
      record('skipped', 'none', 'config-unreadable');
      return 'config-unreadable';
    }
    optedIn = Boolean(projConfig) && projConfig.medusaWake === true;
  }
  // The most consequential skip in the file: a session sitting on unread mail
  // that nothing will ever tell it about, because the wake is off. Silent until
  // #792, and indistinguishable from an empty inbox from anywhere outside.
  if (!optedIn) { st.idleTicks = 0; record('skipped', 'none', 'wake-not-opted-in'); return 'wake-not-opted-in'; }

  // Listener + fresh-mail gates. The two non-nudge outcomes are distinct:
  // HOLD (listener not `listening`) vs CONSUME (inbox read). The listener
  // preserves inbox/unread across a reconnect, so a tick landing in a
  // `connecting`/`error` backoff window must NOT advance the watermark — the
  // pending wake fires once the listener is back (Critic cumulative WARNING,
  // 2026-07-11). Only a genuinely-read inbox (`unread === 0`) consumes the edge.
  const status = _internal.getStatus(sessionId);
  if (status.state !== 'listening') {
    st.idleTicks = 0;
    record('skipped', 'none', `listener-${status.state}`);
    return `listener-${status.state}`; // hold — watermark untouched, wake survives the reconnect window
  }
  if (status.unread === 0) {
    // Nothing pending: keep the watermark at the inbox edge so only a FUTURE
    // arrival nudges (a backlog the operator/agent already read never fires).
    st.lastNudgedKey = _newestKey(_internal.getMessages(sessionId));
    st.idleTicks = 0;
    return 'no-mail';
  }
  const inbox = _internal.getMessages(sessionId);
  const newest = _newestKey(inbox);
  if (newest === null) {
    // An unread count with nothing in the inbox to read: the listener's own
    // view is that there is no mail here, so that is what is reported.
    st.idleTicks = 0;
    return 'no-mail';
  }
  // #1839: the watermark is in memory and a restart loses it. When the durable
  // record shows every message in the inbox already read or already nudged,
  // the edge is the recipient's, whatever this process remembers. Asked by
  // each message's own id (#2086): the Hub redelivers mail that was fetched
  // and never marked handled, and a restart is not a reason to nudge for it.
  if (newest !== st.lastNudgedKey) {
    try {
      if (_internal.alreadyAttempted(status.workspaceId, inbox.map(_recordId))) st.lastNudgedKey = newest;
    } catch (err) {
      log.warn('medusa-wake: could not read durable wake attempts; judging from memory', { sessionId, error: err.message });
    }
  }

  // #1839: an owned edge in observe-only mode runs the gates below to record
  // what they find, and never injects.
  let observeOnly = false;
  if (newest === st.lastNudgedKey) {
    // #1839: already nudged for this edge, so the agent owns it now, unless
    // the watchdog has re-armed it on a durable trigger (a negative receipt,
    // or a readiness change recorded after the attempt). A re-armed edge goes
    // back through every gate below; nothing here injects directly.
    let rearmed = false;
    let watching = false;
    try {
      rearmed = _internal.rearmDue(status.workspaceId);
      watching = !rearmed && _internal.awaitingReadiness(status.workspaceId);
    } catch (err) {
      log.warn('medusa-wake: could not read re-arm state; treating the edge as owned', { sessionId, error: err.message });
    }
    if (rearmed) {
      st.lastNudgedKey = null;
    } else if (watching) {
      // The attempt is unsettled: keep judging the pane so an ineligible to
      // eligible change after the nudge is recorded durably.
      observeOnly = true;
    } else {
      st.idleTicks = 0;
      _noteAwaitingRead(sessionId, status.workspaceId);
      return 'nudged';
    }
  }

  // What the engine's own protocol says (#1628), for an engine MEANT to be
  // judged that way — its profile names an adapter that can observe it. For
  // such an engine the pane's at-rest marker is not trusted on its own: it has
  // been measured reading at rest on transcript prose that merely quotes it.
  // Only a fresh, identity-bound `idle` goes on to the pane gate below, where
  // it excuses the at-rest marker and nothing else; every other answer holds.
  // Asked only here — a live, opted-in session with fresh mail — so a quiet
  // fleet costs no socket traffic. Every other engine skips this block and
  // keeps the pane gate exactly as it was.
  let engineIdle = false;
  if (_declaresObserver(session.engineId)) {
    // The Master has no project and so no launch channel: nothing it can do
    // restores one, and its code says so rather than advising a relaunch.
    const engine = session.isMaster ? { channel: 'none-possible' } : _engineActivity(session, project, st);
    const engineCode = engine.channel === 'none-possible' ? 'master-engine-unobserved'
      : engine.channel === 'absent' ? 'engine-channel-absent'
        : engine.state === 'busy' ? 'engine-thread-busy'
          : engine.state !== 'idle' ? 'engine-thread-unknown'
            : null;
    _noteEngineReason(st, sessionId, engine.reasonCode || null);
    if (engineCode) {
      st.idleTicks = 0;
      if (observeOnly) {
        _wakeFact(sessionId, status.workspaceId, 'wake_blocked', engineCode);
        return 'nudged';
      }
      record('skipped', 'none', engineCode);
      return engineCode;
    }
    engineIdle = true;
  }

  // A pane whose last read was slow is left alone until its backoff passes
  // (#2086). The hold comes before the read and judges nothing, so it can only
  // delay a nudge: the session passes every gate below on the tick that reads
  // it. The idle streak ends here, because a tick that did not look at the
  // pane is not an observation of it.
  if (st.paneBackoffUntil && _internal.now() < st.paneBackoffUntil) {
    st.idleTicks = 0;
    if (observeOnly) {
      _wakeFact(sessionId, status.workspaceId, 'wake_blocked', 'pane-read-backoff');
      return 'nudged';
    }
    record('skipped', 'none', 'pane-read-backoff');
    return 'pane-read-backoff';
  }

  // Idle gate + debounce.
  let cap;
  let cursor = null;
  let captureFailed = false;
  let slowRead = false;
  if (read && read.prefetched) {
    // The answer to a non-blocking read this session started. It was read for
    // the session and workspace named on it; a different workspace now means
    // the pane belongs to someone else's mail, and the read is discarded.
    const got = read.prefetched;
    slowRead = _notePaneRead(st, got.ms, got.timedOut);
    if (got.workspaceId !== (status.workspaceId || null)) {
      st.idleTicks = 0;
      return 'pane-read-stale';
    }
    captureFailed = Boolean(got.error);
    cap = got.cap;
    cursor = got.cursor || null;
    // An answer that follows the last one too closely does not extend the
    // streak: it becomes the first observation of a new one.
    if (!captureFailed && got.answeredAt != null) {
      if (st.lastPaneAnswerAt != null && got.answeredAt - st.lastPaneAnswerAt < MIN_OBSERVATION_GAP_MS) st.idleTicks = 0;
      st.lastPaneAnswerAt = got.answeredAt;
    }
  } else if (read && read.async) {
    _beginPaneRead(session, st, status.workspaceId || null, read.prompt === true);
    // The literal, so the vocabulary guard can read this site. It is the value of PANE_READ_STARTED.
    return 'pane-read-started';
  } else {
    const readStartedAt = _clockMs();
    try {
      cap = _internal.capturePane(session.tmuxSession, { lines: TMUX_TAIL_LINES });
    } catch {
      captureFailed = true;
    }
    if (!captureFailed) {
      // Best-effort: a pane that cannot report a cursor still gets judged, just by
      // the weaker text check. Never fatal — a nudge must not be lost to a tmux
      // query that failed while the pane itself captured fine.
      try {
        cursor = _internal.cursorInfo(session.tmuxSession);
      } catch (err) {
        if (!st.cursorWarnLogged) {
          st.cursorWarnLogged = true;
          log.warn('medusa-wake: cursor probe failed — falling back to the text prompt check', {
            sessionId, error: err.message
          });
        }
      }
    }
    const endedAt = _clockMs();
    slowRead = _notePaneRead(st, readStartedAt === null || endedAt === null ? null : endedAt - readStartedAt, false);
  }
  if (captureFailed) {
    st.idleTicks = 0; // pane vanished mid-poll (session dying) — prune pass drops it
    if (observeOnly) {
      _wakeFact(sessionId, status.workspaceId, 'wake_blocked', 'pane-capture-failed');
      return 'nudged';
    }
    record('skipped', 'none', 'pane-capture-failed');
    return 'pane-capture-failed';
  }
  // A read that answered, slowly. What it returned is seconds old, so it is no
  // observation of the pane: nothing is assessed, the idle streak ends, and
  // the backoff `_notePaneRead` just set is what the session reports.
  if (slowRead) {
    st.idleTicks = 0;
    if (observeOnly) {
      _wakeFact(sessionId, status.workspaceId, 'wake_blocked', 'pane-read-backoff');
      return 'nudged';
    }
    record('skipped', 'none', 'pane-read-backoff');
    return 'pane-read-backoff';
  }
  // Whether a turn is in flight is answered by the transcript MOVING, not by a
  // marker string (#1114). Claude's `busyMarker` stopped rendering on an
  // ordinary turn, and measurement found no string that separates the states:
  // mid-stream the spinner is absent, the bare prompt is present and the status
  // rows match a resting pane exactly. A working session writes; a resting one
  // does not. The digest excludes the composer and status rows, which the
  // engine rotates on its own while idle.
  const assessed = assessSessionIdle({
    lines: cap.lines || [], profile, cursor,
    prevDigest: st.paneDigest, idleTicks: st.idleTicks,
    engineIdle
  });
  st.paneDigest = assessed.digest;
  st.idleTicks = assessed.idleTicks;
  if (!assessed.idle) {
    // `at-prompt` here means the gates passed but the streak is short — that is
    // a hold, not a skip, and recording it would spam the ledger every tick.
    const code = assessed.reason === 'pane-writing' ? 'pane-writing' : `pane-${assessed.reason}`;
    if (observeOnly) {
      // The owned edge's ledger row stays `nudged`; the verdict goes on the exchanges.
      if (assessed.reason !== 'at-prompt') _wakeFact(sessionId, status.workspaceId, 'wake_blocked', code);
      return 'nudged';
    }
    if (assessed.reason !== 'at-prompt') {
      record('skipped', 'none', code);
    } else {
      // #1839: waiting only on the streak is pending, not blocked.
      _wakeFact(sessionId, status.workspaceId, 'wake_pending', code);
    }
    // `pane-at-prompt` is reported to a sender, though never ledgered: every
    // gate passed and the nudge is waiting only on the debounce streak.
    return code;
  }

  // Inject into the session we just JUDGED (MED-7Q4C). Addressing by project
  // name alone would let injectCommand re-resolve `getActive` independently, so
  // the nudge could land in a pane this scan never assessed once a project holds
  // more than one live session. The explicit handle keeps judgment and delivery
  // on one session; injectCommand re-checks it is still an active session of
  // this project, so a session that ended mid-tick fails closed rather than
  // misrouting.
  //
  // Watermark advances only on a successful injection so a transient tmux
  // failure retries next tick instead of silently dropping the wake.
  //
  // The Master goes through its own injector rather than `injectCommand`,
  // because that function's ownership check — the addressed session must be an
  // active session OF the named project — is exactly the property the Master
  // cannot satisfy: it belongs to no project. `injectMasterCommand` applies the
  // checks that do transfer (length cap, confirmed-live pane) itself.
  //
  // #1839: the transport is chosen per session (`lib/wake-transports.js`), and
  // each attempt carries its own nonce so a later look at the composer can tell
  // this attempt's text from any other.
  if (observeOnly) {
    // Eligible again after being found ineligible since the nudge: that change
    // is the durable readiness observation a re-arm needs. Nothing is typed.
    try {
      _internal.noteReadiness(status.workspaceId);
    } catch (err) {
      log.warn('medusa-wake: failed to record a readiness change', { sessionId, error: err.message });
    }
    return 'nudged';
  }
  const label = session.isMaster ? session.name : project.name;
  const transport = _internal.transportFor(session);
  const nonce = _internal.newNonce();
  const line = session.isMaster ? _nudgeLineFor(session.apiBase, status.unread) : _nudgeLine(project.name, status.unread);
  const result = transport.deliver({ project, sessionId, line: wakeTransports.withNonce(line, nonce) }, {
    injectCommand: _internal.injectCommand, injectMaster: _internal.injectMaster
  });
  const channel = transport.channel;
  st.idleTicks = 0;
  if (!result.ok) {
    log.warn('medusa-wake: nudge injection failed', { project: label, sessionId, error: result.error });
    // #791: an injection that reached the pane and did not land used to leave
    // no trace anywhere, so a broken channel read exactly like a quiet peer.
    record('failed', channel, `inject-failed: ${result.error || 'unknown'}`);
    // The code alone: the error text is tmux's, and a sender needs to know the
    // channel failed, not the local diagnostics of how.
    return 'inject-failed';
  }
  st.lastNudgedKey = newest;
  record('nudged', channel, null);
  _wakeFact(sessionId, status.workspaceId, 'wake_attempted', transport.id, { nonce, transport: transport.id });
  _verifyWake(session, transport, nonce, status.workspaceId);
  log.info('medusa-wake: nudged idle session about fresh inbox mail', {
    project: label, sessionId, unread: status.unread
  });
  return 'nudged';
}

/**
 * Monotonic milliseconds for timing a pane read, or null when the clock cannot
 * be read. A scan is never failed by its own measurement.
 * @returns {number|null}
 */
function _clockMs() {
  try {
    const t = _internal.clock();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Account for one session's pane read (#2086): back the session off when the
 * read was slow or timed out, and clear its backoff when it was ordinary.
 * @param {object} st - Per-session monitor state.
 * @param {number|null} ms - How long the read took, or null when unmeasured.
 * @param {boolean} timedOut - Whether tmux did not answer in time.
 * @returns {boolean} Whether the read was slow.
 */
function _notePaneRead(st, ms, timedOut) {
  const slow = timedOut || (Number.isFinite(ms) && ms >= SLOW_PANE_READ_MS);
  if (!slow) {
    st.slowPaneReads = 0;
    st.paneBackoffUntil = null;
    return false;
  }
  st.slowPaneReads = (st.slowPaneReads || 0) + 1;
  const step = PANE_BACKOFF_MS[Math.min(st.slowPaneReads, PANE_BACKOFF_MS.length) - 1];
  st.paneBackoffUntil = _internal.now() + step;
  return true;
}

/**
 * Start a non-blocking read of one session's pane (#2086). The tick returns at
 * once; `_onPaneRead` finishes the judgment when tmux answers or the read
 * times out. Every session holding mail is read at the same time, so a pane
 * that hangs holds up nobody else, and the server is never held at all.
 * @param {object} session - The session record being judged.
 * @param {object} st - Per-session monitor state.
 * @param {string|null} workspaceId - The workspace the read is for.
 * @param {boolean} [prompt=false] - Whether a request, not the timer, asked for this look.
 * @returns {void}
 */
function _beginPaneRead(session, st, workspaceId, prompt = false) {
  const token = {
    generation: _generation,
    prompt,
    sessionId: session.id,
    isMaster: session.isMaster === true,
    projectId: session.projectId ?? null,
    tmuxSession: session.tmuxSession,
    sessionStartedAt: session.startedAt ?? null,
    workspaceId,
    startedAt: _clockMs()
  };
  st.readInFlight = token;
  let reading;
  try {
    reading = Promise.resolve(_internal.readPaneAsync(session.tmuxSession, { lines: TMUX_TAIL_LINES, timeout: PANE_READ_TIMEOUT_MS }));
  } catch (err) {
    reading = Promise.reject(err);
  }
  reading.then(
    (got) => _onPaneRead(token, { cap: got && got.cap, cursor: got && got.cursor, error: got && got.cap ? null : new Error('pane read returned nothing') }),
    (err) => _onPaneRead(token, { cap: null, cursor: null, error: err || new Error('pane read failed') })
  ).catch((err) => {
    // `_onPaneRead` contains its own failures. This is for the one it cannot:
    // a rejection nobody handles would take the server down with it.
    log.warn('medusa-wake: judging a pane read failed', { sessionId: token.sessionId, error: err && err.message });
  });
}

/**
 * The session a pane read was for, as it is now, without asking tmux (#2086).
 *
 * This runs once per answered read, so it must not block. A project session is
 * re-read from the store. The Master has no store row: its record is rebuilt
 * from configuration, and its liveness is not probed again. The read that just
 * answered probed that exact pane itself, without blocking. When the read
 * failed there is no such proof, and none is needed, because a failed read
 * cannot lead to a nudge: it is judged only so the failure is recorded.
 *
 * @param {object} token - What `_beginPaneRead` stamped on the read.
 * @returns {object|null} The live session record, or null when it is gone.
 */
function _sessionNow(token) {
  if (token.isMaster) return _internal.masterWakeRecord({ tmuxLib: _ASSUMED_LIVE }) || null;
  return _internal.listLiveAll().find((s) => s.id === token.sessionId) || null;
}

// Stands in for the tmux module where `masterWakeRecord` would probe the
// Master's pane, on the one path that has just had the answer another way.
const _ASSUMED_LIVE = Object.freeze({ probeSession: () => ({ live: true, answered: true, cause: null }) });

/**
 * Finish judging a session whose pane read has answered (#2086).
 *
 * Time passed while tmux was being asked, so nothing the tick decided is
 * trusted. The read is dropped when the monitor was stopped since, when the
 * session's state was pruned or it has a newer read, or when the session is
 * no longer live in the same pane. Otherwise the whole gate chain runs again
 * on the session as it is now, with the read standing in for the pane
 * capture: a wrap that began, a rotation, mail already read, a listener that
 * dropped or a wake another path recorded all refuse the nudge as they would
 * on a tick. Assessment and injection then happen in this same turn, so the
 * pane is as fresh when it is typed into as it is on the synchronous path.
 *
 * @param {object} token - What `_beginPaneRead` stamped on the read.
 * @param {{cap: (object|null), cursor: (object|null), error: (Error|null)}} result - The read's answer.
 * @returns {void}
 */
function _onPaneRead(token, result) {
  if (token.generation !== _generation) return;
  const st = _sessions.get(token.sessionId);
  if (!st || st.readInFlight !== token) return;
  st.readInFlight = null;
  let session = null;
  try {
    session = _sessionNow(token);
  } catch (err) {
    log.warn('medusa-wake: could not re-read the roster after a pane read', { sessionId: token.sessionId, error: err.message });
  }
  // Gone, or the id now names a different project, pane or launch: the pane
  // that was read is not this session's, and there is nobody to judge.
  if (!session
    || session.tmuxSession !== token.tmuxSession
    || (session.projectId ?? null) !== token.projectId
    || (session.startedAt ?? null) !== token.sessionStartedAt) {
    st.idleTicks = 0;
    return;
  }
  const endedAt = _clockMs();
  const prefetched = {
    cap: result.cap,
    cursor: result.cursor,
    error: result.error,
    timedOut: Boolean(result.error && result.error.tcTimedOut),
    ms: token.startedAt === null || endedAt === null ? null : Math.max(0, endedAt - token.startedAt),
    answeredAt: endedAt,
    workspaceId: token.workspaceId
  };
  try {
    st.projectId = session.projectId ?? null;
    const reason = _judgeSession(session, st, { prefetched });
    _noteVerdict(st, reason, token.sessionId);
    _noteStall(st, token.sessionId);
    // A look that was asked for found the pane at rest, once. Book the second
    // look for the first moment it can count, so the wake does not wait for
    // wherever the timer happens to be.
    if (token.prompt && reason === 'pane-at-prompt' && st.idleTicks === 1) _bookFollowUp(token.sessionId, st);
  } catch (err) {
    log.warn('medusa-wake: scan failed', { sessionId: token.sessionId, error: err.message });
  }
}

/**
 * Ask the monitor to look at one session now (#2086).
 *
 * A request, not a command. It runs the scan the timer runs, on the timer's
 * non-blocking path, through every gate, and it can type nothing a tick would
 * not have typed. What it changes is when the monitor looks: at the moment
 * something happened that could make a nudge due, not up to an interval later.
 *
 * Callers pass a recorded transition and nothing inferred: mail arrived for
 * the session, its listener came back, its project's wrap finished, its
 * coordinator rotation closed.
 *
 * Bounded so that a storm of requests costs one look: requests for a session
 * are coalesced until the next turn of the event loop, and a request is
 * dropped when the monitor is stopped, when the session's pane is being read,
 * has a follow-up look booked, is backed off, or was observed too recently
 * for another observation to count.
 *
 * Requests and follow-ups live in memory. A restart loses them, which costs
 * the prompt look and nothing else: the timer still finds the mail.
 *
 * @param {string|number} sessionId - The TangleClaw session, or the Master's key.
 * @param {string} [reason] - What happened, for the log.
 * @returns {boolean} Whether the request was queued. False means the monitor
 *   is stopped or the id is unusable; the timer still covers the session.
 */
function requestScan(sessionId, reason = 'requested') {
  if (!_timer || sessionId == null || sessionId === '') return false;
  // Session ids arrive as numbers from the store and as strings from a listener's key.
  const key = typeof sessionId === 'string' && /^\d+$/.test(sessionId) ? Number(sessionId) : sessionId;
  _requested.set(key, String(reason));
  if (!_requestsScheduled) {
    _requestsScheduled = true;
    const generation = _generation;
    _internal.defer(() => {
      _requestsScheduled = false;
      if (generation !== _generation) { _requested.clear(); return; }
      const batch = [..._requested.entries()];
      _requested.clear();
      for (const [id, why] of batch) {
        try {
          _promptLook(id, why);
        } catch (err) {
          log.warn('medusa-wake: a requested scan failed', { sessionId: id, reason: why, error: err.message });
        }
      }
    });
  }
  return true;
}

/**
 * Whether a session may be looked at outside the timer right now. Each refusal
 * is a case where another look would be wasted or would harm: a read is out,
 * a follow-up is booked, the pane is backed off, or the last observation is
 * too recent for this one to count beside it (it would restart the streak).
 * @param {object|undefined} st - Per-session monitor state, if any yet.
 * @returns {boolean}
 */
function _mayLookNow(st) {
  if (!st) return true;
  if (st.readInFlight || st.followUp) return false;
  if (st.paneBackoffUntil && _internal.now() < st.paneBackoffUntil) return false;
  const nowMs = _clockMs();
  if (st.lastPaneAnswerAt != null && nowMs !== null && nowMs - st.lastPaneAnswerAt < MIN_OBSERVATION_GAP_MS) return false;
  return true;
}

/**
 * The session a request names, as it is now, without asking tmux.
 * @param {string|number} sessionId - Session id, or the Master's key.
 * @returns {object|null}
 */
function _sessionById(sessionId) {
  if (sessionId === _internal.masterKey()) return _internal.masterWakeRecord({ tmuxLib: _ASSUMED_LIVE }) || null;
  return _internal.listLiveAll().find((s) => s.id === sessionId) || null;
}

/**
 * Look at one session because something asked.
 * @param {string|number} sessionId - Session id, or the Master's key.
 * @param {string} reason - What happened.
 * @returns {void}
 */
function _promptLook(sessionId, reason) {
  if (!_mayLookNow(_sessions.get(sessionId))) return;
  const session = _sessionById(sessionId);
  if (!session) return;
  log.debug('medusa-wake: looking at a session on request', { sessionId, reason });
  _scanSession(session, { async: true, prompt: true });
}

/**
 * Book the one follow-up look that completes a streak a requested look began.
 * It runs `MIN_OBSERVATION_GAP_MS` after the first observation, which is the
 * earliest a second one can count, and it is a look like any other: every
 * gate, and no nudge unless the pane is still at rest and unchanged.
 * @param {string|number} sessionId - The session.
 * @param {object} st - Per-session monitor state.
 * @returns {void}
 */
function _bookFollowUp(sessionId, st) {
  if (st.followUp) return;
  const generation = _generation;
  const bookedAt = _clockMs();
  const booked = { timer: null, dueAt: bookedAt === null ? null : bookedAt + MIN_OBSERVATION_GAP_MS };
  booked.timer = _internal.setTimer(() => {
    if (st.followUp === booked) st.followUp = null;
    if (generation !== _generation || _sessions.get(sessionId) !== st) return;
    try {
      const session = _sessionById(sessionId);
      if (session) _scanSession(session, { async: true, followUp: true });
    } catch (err) {
      log.warn('medusa-wake: a follow-up scan failed', { sessionId, error: err.message });
    }
  }, MIN_OBSERVATION_GAP_MS);
  st.followUp = booked;
}

/**
 * Whether a session's booked follow-up is still to come. One that is more than
 * a gap overdue has been lost, and one whose due time is unknown cannot be
 * waited for.
 * @param {object} st - Per-session monitor state, with a follow-up booked.
 * @returns {boolean}
 */
function _followUpPending(st) {
  const nowMs = _clockMs();
  if (nowMs === null || st.followUp.dueAt === null) return false;
  return nowMs < st.followUp.dueAt + MIN_OBSERVATION_GAP_MS;
}

/**
 * Cancel a session's booked follow-up look, if it has one.
 * @param {object} st - Per-session monitor state.
 * @returns {void}
 */
function _cancelFollowUp(st) {
  if (!st || !st.followUp) return;
  _internal.clearTimer(st.followUp.timer);
  st.followUp = null;
}

/**
 * Record a wake verdict on the exchanges addressed to a session (#1839).
 * Non-throwing for the same reason the delivery ledger write is: an audit
 * write must never be the reason a nudge does not happen.
 * @param {string|number} sessionId - The session judged
 * @param {string|null} workspaceId - The session's workspace
 * @param {string} fact - Wake fact
 * @param {string|null} code - Reason code
 * @param {object|null} [detail] - Bounded detail (nonce, transport)
 * @returns {void}
 */
function _wakeFact(sessionId, workspaceId, fact, code, detail = null) {
  if (!workspaceId) return;
  try {
    _internal.recordWakeFacts(workspaceId, fact, { code, detail });
  } catch (err) {
    log.warn('medusa-wake: failed to record a wake fact', { sessionId, fact, error: err.message });
  }
}

/**
 * Refresh a stale wake verdict once the monitor considers the newest mail
 * nudged and owned by the agent (#1839). Non-throwing.
 * @param {string|number} sessionId - The session judged
 * @param {string|null} workspaceId - The session's workspace
 * @returns {void}
 */
function _noteAwaitingRead(sessionId, workspaceId) {
  if (!workspaceId) return;
  try {
    _internal.noteAwaitingRead(workspaceId);
  } catch (err) {
    log.warn('medusa-wake: failed to refresh a wake verdict', { sessionId, error: err.message });
  }
}

/**
 * After a nudge, ask the transport whether it can prove the nudge was NOT
 * accepted, and record that on the exchanges it concerned (#1839). Runs off the
 * tick, never blocks it, and never re-sends: a `not-accepted` only lets the
 * watchdog re-arm the wake through every gate. Skipped when no exchange is
 * waiting on this wake, since there would be nothing to record.
 * @param {object} session - The woken session
 * @param {object} transport - The transport that delivered the nudge
 * @param {string} nonce - This attempt's nonce
 * @param {string|null} workspaceId - The session's workspace
 * @returns {void}
 */
function _verifyWake(session, transport, nonce, workspaceId) {
  if (transport.receipts === 'none' || !workspaceId) return;
  let pending = 0;
  try {
    pending = _internal.pendingWakeCount(workspaceId);
  } catch (err) {
    log.warn('medusa-wake: could not read pending exchanges; this attempt goes unverified', { sessionId: session.id, error: err.message });
    return;
  }
  if (pending === 0) return;
  // A receipt is about this attempt only, so it is recorded only on the
  // exchanges whose newest attempt carried this nonce.
  Promise.resolve()
    .then(() => transport.verify({ session, nonce }, { verifySubmission: _internal.verifySubmission }))
    .then((receipt) => {
      if (receipt && receipt.outcome === 'not-accepted') {
        _internal.recordWakeFacts(workspaceId, 'wake_not_accepted', { code: 'nonce-in-composer', detail: { nonce }, attemptNonce: nonce });
      } else if (receipt && receipt.outcome === 'accepted' && transport.receipts === 'positive') {
        _internal.recordWakeFacts(workspaceId, 'wake_accepted', { code: transport.id, detail: { nonce }, attemptNonce: nonce });
      }
    })
    .catch((err) => {
      log.warn('medusa-wake: wake receipt check failed; the attempt stays unconfirmed', { sessionId: session.id, error: err.message });
    });
}

/**
 * Log the adapter's own reason for an engine answer when it changes. The
 * ledger and the peer route carry only the bounded wake code
 * (`engine-thread-unknown` covers a version mismatch and a thread nobody can
 * pick alike), so this line is where an operator finds which one it was —
 * some, like a version mismatch after an upgrade, last until a relaunch.
 * Logged on change only; the monitor ticks every five seconds.
 * @param {object} st - Per-session monitor state.
 * @param {string|number} sessionId - The session.
 * @param {string|null} reasonCode - The adapter's code, or null.
 * @returns {void}
 */
function _noteEngineReason(st, sessionId, reasonCode) {
  if (st.engineReason === reasonCode) return;
  st.engineReason = reasonCode;
  if (reasonCode) log.info('medusa-wake: engine activity', { sessionId, reasonCode });
}

/**
 * Whether an engine is expected to be judged by its native channel. A lookup
 * that fails says yes: for an engine that might be one, holding is the safe
 * answer, and the one-per-session log keeps it from being silent.
 * @param {string} engineId - Engine id.
 * @returns {boolean}
 */
function _declaresObserver(engineId) {
  try {
    return _internal.declaresObserver(engineId) === true;
  } catch (err) {
    log.warn('medusa-wake: could not tell whether the engine is observed through its channel — holding', { engineId, error: err.message });
    return true;
  }
}

/**
 * The engine's latest activity observation for a session, and a refresh of it.
 *
 * The tick is synchronous and the engine's protocol is not, so the answer a
 * tick uses is one an EARLIER tick asked for: this starts at most one read at
 * a time per session and stores what comes back on the session's monitor
 * state. Nothing is ever injected from the read's callback; it only records.
 *
 * Every answer is keyed to the exact session, channel and launch it was asked
 * about. One that lands after the channel was replaced, or after the session
 * left the scan, is discarded, and a stored one is used only while it has the
 * current key and is younger than `ENGINE_ACTIVITY_MAX_AGE_MS`.
 *
 * With a channel present, no usable answer yet — none, stale, failed — is
 * reported as `unknown`, never as absent: the caller holds on it.
 *
 * @param {object} session - The live session record.
 * @param {object} project - Its project.
 * @param {object} st - Per-session monitor state (holds the cache).
 * @returns {{channel: 'absent'|'present', state?: string, reasonCode?: string}}
 */
function _engineActivity(session, project, st) {
  let channel;
  let sequence;
  try {
    channel = _internal.openChannel(session.id);
    sequence = channel ? _internal.launchSequence(session.id) : null;
  } catch (err) {
    // Whether a channel exists is itself unknown, so this cannot claim absence.
    log.warn('medusa-wake: startup-control channel lookup failed', { sessionId: session.id, error: err.message });
    return { channel: 'present', state: 'unknown', reasonCode: 'channel-unreadable' };
  }
  if (!channel) {
    st.engineActivity = null;
    st.engineKey = null;
    return { channel: 'absent' };
  }
  const key = `${session.id}|${channel.id}|${channel.sequenceId}`;
  st.engineKey = key;
  if (st.engineActivityInFlight !== key) {
    st.engineActivityInFlight = key;
    let pending;
    try {
      pending = Promise.resolve(_internal.observeActivity({ session, project, channel, sequence }));
    } catch (err) {
      pending = Promise.reject(err);
    }
    const current = () => _sessions.get(session.id) === st && st.engineKey === key;
    pending.then((seen) => {
      if (!current()) return;
      st.engineActivity = seen && seen.channel === 'present'
        ? { key, state: seen.state, reasonCode: seen.reasonCode, observedAt: _internal.now() }
        : { key, state: 'unknown', reasonCode: seen && seen.channel === 'absent' ? 'channel-closed' : 'observation-malformed', observedAt: _internal.now() };
    }, (err) => {
      if (!current()) return;
      st.engineActivity = { key, state: 'unknown', reasonCode: 'observation-failed', observedAt: _internal.now() };
      log.warn('medusa-wake: engine activity read failed', { sessionId: session.id, error: err.message });
    }).finally(() => {
      if (st.engineActivityInFlight === key) st.engineActivityInFlight = null;
    });
  }
  const seen = st.engineActivity;
  if (!seen || seen.key !== key) return { channel: 'present', state: 'unknown', reasonCode: 'not-yet-observed' };
  if (_internal.now() - seen.observedAt > ENGINE_ACTIVITY_MAX_AGE_MS) {
    return { channel: 'present', state: 'unknown', reasonCode: 'observation-stale' };
  }
  return { channel: 'present', state: seen.state, reasonCode: seen.reasonCode };
}

/**
 * One monitor tick: prune state for ended sessions, then scan every live one.
 * Exposed via `_internal.tick` so tests drive it deterministically.
 * @param {object} [opts]
 * @param {boolean} [opts.scheduled=false] - Whether the timer fired this tick,
 *   which is the only kind that can be measured as late.
 * @returns {void}
 */
function _tick(opts = {}) {
  const pass = _meter.begin({ scheduled: opts.scheduled === true });
  let roster;
  try {
    roster = _liveRoster();
  } catch (err) {
    log.warn('medusa-wake: listLiveAll failed', { error: err.message });
    pass.end();
    return;
  }
  if (roster.master !== undefined) _noteMasterPresence(roster.master);
  const live = roster.live;
  const liveIds = new Set(live.map((s) => s.id));
  for (const [sid, st] of _sessions) {
    if (liveIds.has(sid)) continue;
    _cancelFollowUp(st);
    _sessions.delete(sid);
  }
  for (const session of live) {
    try {
      pass.item(session.id, () => _scanSession(session, { async: opts.async === true }));
    } catch (err) {
      log.warn('medusa-wake: scan failed', { sessionId: session.id, error: err.message });
    }
  }
  pass.end();
}

/**
 * The sessions the monitor scans: every live one, and the Project Master as
 * one more session-shaped record, so it is pruned, gated and debounced by the
 * same code as everyone else.
 *
 * The Master's own failure is contained. A broken Master probe must not cost
 * the projects their tick, and its presence is then left as last observed
 * (`master` undefined): a probe that threw saw nothing, and recording "not
 * running" from it would be the guess `not-running` must not be.
 *
 * @returns {{live: object[], master: (boolean|undefined)}}
 * @throws {Error} When the live roster itself cannot be read
 */
function _liveRoster() {
  let live = _internal.listLiveAll();
  let master;
  try {
    const masterRecord = _internal.masterWakeRecord();
    if (masterRecord) live = live.concat([masterRecord]);
    master = Boolean(masterRecord);
  } catch (err) {
    log.warn('medusa-wake: master record failed', { error: err.message });
  }
  return { live, master };
}

/**
 * What the monitor's recent ticks cost (#2086): interval, tick count,
 * overruns, duration and start-lag percentiles over the kept window, and the
 * last tick's scan order with each session's position, duration and verdict.
 * Read-only, in memory, and empty until a tick has run.
 * @returns {object} A `lib/tick-meter.js` snapshot
 */
function tickMetrics() {
  return _meter.snapshot();
}

/**
 * Record whether the last tick found the Project Master running. `since` marks
 * when the current answer began and survives repeat observations; `observedAt`
 * moves every tick — the same stamping as a session verdict.
 * @param {boolean} live - Whether `masterWakeRecord` returned a record.
 * @returns {void}
 */
function _noteMasterPresence(live) {
  const now = new Date(_internal.now()).toISOString();
  const since = _masterPresence && _masterPresence.live === live ? _masterPresence.since : now;
  _masterPresence = { live, since, observedAt: now };
}

/**
 * What each code a sender can receive from `peerReachability` means — what
 * the peer is doing as far as the monitor observed, and so what waiting will
 * or will not fix. The ONE declaration of the vocabulary: the peers route
 * returns `meaning` beside `reason` from it, and `tc message status` prints
 * that field rather than keeping a copy (`lib/tc-verbs.js` stays free of this
 * module). Its producers are the return sites of `_judgeSession`, the
 * `pane-`-prefixed reasons of `_assessPane`/`_assessActivity`, and the answers
 * `peerReachability`/`_noteVerdict` build themselves;
 * `test/medusa-wake.test.js` derives the emitted codes from those sites and
 * requires each to be declared here.
 * @type {Readonly<Object<string, string>>}
 */
const PEER_REASON_MEANINGS = Object.freeze({
  'nudged': 'the session was told about its mail and has not marked it handled yet',
  'no-mail': 'the session has no unread mail — anything you sent has been read or has not arrived',
  'wake-not-opted-in': 'the session has not opted into wake nudges, so nothing will tell it about your message; it finds it only when it checks its inbox',
  'pane-at-prompt': 'the session is at rest and a nudge is about to be typed',
  'pane-no-prompt': 'the pane shows no input prompt (a dialog, a menu, or a scrolled pane); the nudge waits until it returns to its prompt',
  'pane-composer-has-input': 'someone is typing in the session\'s input box; the nudge waits so it does not paste over their text',
  'pane-turn-in-flight': 'the session is mid-turn; the nudge waits for it to finish',
  'pane-agents-running': 'the session has subagents running; the nudge waits for them to finish',
  'pane-not-at-rest': 'the engine is not showing its at-rest marker (busy, or in a dialog or menu); the nudge waits',
  'engine-thread-busy': 'the engine reports, through its own protocol, that the session is mid-turn; the nudge waits for it to finish',
  'engine-channel-absent': 'the session\'s engine is judged through its native channel and this session has none (it was launched without one, or it closed), so the nudge is held rather than read from the pane; relaunching the session restores wakes',
  'master-engine-unobserved': 'the Project Master runs an engine that is judged through a native channel, and the Master never has one, so its nudge is held rather than read from the pane; a relaunch does not change this',
  'engine-thread-unknown': 'the session has a native engine channel but it has not confirmed the session is idle (not asked yet, no answer, or an answer it could not prove); the nudge waits rather than guessing from the pane',
  'pane-writing': 'the session\'s transcript is still moving; the nudge waits for it to settle',
  'pane-capture-failed': 'the session\'s pane could not be read, which usually means it is ending',
  'pane-read-backoff': 'reading the session\'s pane was slow, so the monitor is leaving it alone for a while before it tries again; the nudge waits',
  'pane-read-started': 'the monitor is reading the session\'s pane and will judge it when tmux answers',
  'pane-read-stale': 'the session\'s workspace changed while its pane was being read, so that read was discarded; the next scan reads it again',
  'inject-failed': 'typing the nudge into the session failed; the monitor retries on its next tick',
  'wrap-running': 'the session is wrapping up; no nudge is typed while a wrap runs',
  'coordinator-rotating': 'the session is a coordinator in managed context rotation; no nudge is typed until its replacement context\'s resume receipt is accepted, and mail waits for it',
  'no-pane': 'the session has no terminal pane to nudge (a web UI session)',
  'unprofiled-engine': 'the session\'s engine has no wake profile, so it is never nudged',
  'no-project': 'the session\'s project could not be found',
  'config-unreadable': 'the session\'s project settings could not be read, so it is treated as not opted in',
  'not-observed': 'the wake monitor has not assessed this session yet',
  'not-running': 'the wake monitor did not find this session running on its last scan (its pane is gone, or tmux did not answer), so nothing will nudge it until it runs again',
  'unclassified': 'the wake monitor reached a verdict it has no code for — a TangleClaw defect, logged on the server'
});

/**
 * Codes with a variable tail, declared by prefix. `{tail}` is replaced with the
 * part after the prefix (a session status, a listener state).
 * @type {Readonly<Object<string, string>>}
 */
const PEER_REASON_PREFIX_MEANINGS = Object.freeze({
  'session-': 'the session is in state {tail}, not active',
  'listener-': 'the session\'s switchboard listener is in state {tail}, not listening, so its mail is not arriving'
});

/**
 * The declared meaning of a reason code, or null for a code nothing declares
 * (an unknown code is relayed as-is by its readers, never given a guessed meaning).
 * @param {string} code - A reason code.
 * @returns {string|null}
 */
function peerReasonMeaning(code) {
  if (typeof code !== 'string' || !code) return null;
  if (Object.prototype.hasOwnProperty.call(PEER_REASON_MEANINGS, code)) return PEER_REASON_MEANINGS[code];
  for (const [prefix, template] of Object.entries(PEER_REASON_PREFIX_MEANINGS)) {
    if (code.startsWith(prefix) && code.length > prefix.length) {
      return template.replace('{tail}', code.slice(prefix.length));
    }
  }
  return null;
}

/**
 * The monitor's latest verdict on a peer, addressed by workspace id — the
 * sender-side answer to "why has this session not picked up my message?".
 *
 * **A reason code, never pane content.** The verdict names which gate fired
 * (`pane-no-prompt`, `wake-not-opted-in`, `no-mail`, …); nothing captured from
 * the pane is kept in the monitor's state, so nothing captured can leak here.
 *
 * **Observed, never inferred.** The answer is whatever the monitor last
 * decided on its own tick. A local session it has not scanned yet reads
 * `not-observed` rather than a guessed state, and a workspace id no live
 * TangleClaw session holds reads `local: false` — this host cannot see that
 * peer's pane, and saying anything more would be the guess this read exists to
 * replace. `observedAt` travels with every verdict so a stale one is visible
 * as stale, and `monitorRunning` says whether anything is still refreshing it.
 *
 * Resolution runs over the same session list the monitor scans, plus the
 * Project Master, matching the id first against each running listener and then
 * against the persisted registry — a session whose listener is toggled off
 * still holds its id, and is still this host's to report on.
 *
 * **The Master is the one candidate that can be matched while not running.**
 * Project candidates come from the live session list, so an ended one drops
 * out and reads `local: false`. The Master is always a candidate — matched by
 * its listener key or its home-pinned registry id, never by probing tmux here —
 * so it would otherwise read `not-observed` forever once it stopped. Instead
 * its answer follows what the monitor itself last observed, in the same
 * observed-with-timestamps shape as every verdict: when the latest tick found
 * no Master to scan, it reads `not-running` with that tick's `observedAt`, and
 * `monitorRunning` says whether that observation is still being refreshed.
 * It stays `local: true` — it is still this host's Master, only stopped.
 *
 * Every local answer carries `meaning`, the declared description of its
 * `reason` (`PEER_REASON_MEANINGS`), or null for a code nothing declares.
 *
 * @param {string} workspaceId - The peer's switchboard workspace id.
 * @returns {{workspaceId: string, local: false}|{workspaceId: string, local: true,
 *   reason: string, meaning: (string|null), class: string, nextAction: string,
 *   nextActionMeaning: string, since: (string|null), observedAt: (string|null),
 *   monitorRunning: boolean}}
 */
function peerReachability(workspaceId) {
  const id = String(workspaceId == null ? '' : workspaceId);
  const candidates = _internal.listLiveAll().map((s) => ({ key: s.id, record: s }));
  // The Master is matched by its listener key without probing tmux: a silent
  // tmux would otherwise read the Master's own id as "not a TangleClaw peer".
  candidates.push({ key: _internal.masterKey(), record: null });

  const registered = _registryLookup();
  const match = candidates.find((c) => _internal.getStatus(c.key).workspaceId === id)
    || candidates.find((c) => registered(c) === id);
  if (!id || !match) return { workspaceId: id, local: false };

  const st = _sessions.get(match.key);
  let verdict = st && st.verdict;
  if (match.record === null && _masterPresence && !_masterPresence.live) {
    verdict = { reason: 'not-running', since: _masterPresence.since, observedAt: _masterPresence.observedAt };
  }
  const reason = verdict ? verdict.reason : 'not-observed';
  // What the reason means for the sender (#2086): whether waiting fixes it,
  // someone has to act, or the recipient is gone. From the one classifier the
  // fleet's undelivered view uses, so the two cannot disagree. A stopped
  // monitor retries nothing, so its answer never tells a sender to wait.
  const monitorRunning = _timer !== null;
  const disposition = classifyForSender(reason, { monitorRunning });
  return {
    workspaceId: id,
    local: true,
    reason,
    meaning: peerReasonMeaning(reason),
    class: disposition.class,
    nextAction: disposition.nextAction,
    nextActionMeaning: disposition.nextActionMeaning,
    since: verdict ? verdict.since : null,
    observedAt: verdict ? verdict.observedAt : null,
    monitorRunning
  };
}

/**
 * The monitor's latest verdict on a session it scans, by session id (#2086).
 * Read-only: what was last stamped, and when. Null for a session the monitor
 * has not assessed.
 * @param {string|number} sessionId - Session id, or the Master's key.
 * @returns {{reason: string, since: string, observedAt: string}|null}
 */
function verdictFor(sessionId) {
  const st = _sessions.get(sessionId);
  return st && st.verdict ? { ...st.verdict } : null;
}

/**
 * Whether the monitor's timer is armed. A stopped monitor retries nothing, so
 * nothing may be described as "the monitor retries by itself" while this is false.
 * @returns {boolean}
 */
function isRunning() {
  return _timer !== null;
}

/**
 * Whether the monitor's last tick found the Project Master running. Null
 * before any tick has asked, which is not knowing, not "not running".
 * @returns {boolean|null}
 */
function masterIsLive() {
  return _masterPresence ? _masterPresence.live : null;
}

/**
 * The live session on this host that holds a workspace id, if any (#1839).
 * The same match `peerReachability` makes, returned as identity rather than a
 * verdict: a message to a workspace some live session here holds can be
 * supervised by this host; any other workspace cannot.
 * @param {string} workspaceId - The workspace id to look up.
 * @returns {{sessionKey: string, sessionId: (string|null), projectId: (number|null)}|null}
 */
function localParticipant(workspaceId) {
  const id = String(workspaceId == null ? '' : workspaceId);
  if (!id) return null;
  const candidates = _internal.listLiveAll().map((s) => ({ key: s.id, record: s }));
  candidates.push({ key: _internal.masterKey(), record: null });
  const registered = _registryLookup();
  const match = candidates.find((c) => _internal.getStatus(c.key).workspaceId === id)
    || candidates.find((c) => registered(c) === id);
  if (!match) return null;
  return {
    sessionKey: String(match.key),
    sessionId: match.record ? String(match.record.id) : null,
    projectId: match.record && Number.isInteger(match.record.projectId) ? match.record.projectId : null
  };
}

/**
 * A registry matcher for ONE peer lookup. Each project's registry file is read
 * at most once however many of its sessions are candidates, and a lookup that
 * fails logs one line however many candidates it fails for — so a sender
 * polling `tc message status` against an unreadable registry costs one warning
 * per request, not one per live session.
 * @returns {function({key: (string|number), record: (object|null)}): (string|null)}
 *   Maps a candidate to its registered workspace id, or null.
 */
function _registryLookup() {
  const files = new Map();
  let warned = false;
  /**
   * Read a project's registry map through the per-lookup cache.
   * @param {string} projectPath - The project directory.
   * @returns {Object<string, string>} Session id → workspace id.
   */
  const read = (projectPath) => {
    if (!files.has(projectPath)) files.set(projectPath, _internal.readRegistry(projectPath));
    return files.get(projectPath);
  };
  /**
   * @param {{key: (string|number), record: (object|null)}} candidate
   * @returns {string|null}
   */
  const match = (candidate) => {
    try {
      return _internal.registeredWorkspaceId(candidate, read);
    } catch (err) {
      if (!warned) {
        warned = true;
        log.warn('medusa-wake: registry read failed while resolving a peer (reported once per lookup)', {
          error: err.message
        });
      }
      return null;
    }
  };
  return match;
}

/**
 * The workspace id the registry holds for a scan candidate, or null. Throws on
 * a failed read; `_registryLookup` catches it, so an unreadable registry is
 * "no match here", which leaves the id `local: false` unless a running
 * listener claimed it first.
 * @param {{key: (string|number), record: (object|null)}} candidate - A live
 *   session record, or the Master (null record).
 * @param {function(string): Object<string, string>} read - The lookup's cached
 *   registry reader.
 * @returns {string|null}
 */
function _registeredWorkspaceId(candidate, read) {
  if (candidate.record === null) {
    const target = require('./master').masterMedusaTarget();
    return read(target.projectPath)[String(target.sessionId)] || null;
  }
  const project = _internal.getProject(candidate.record.projectId);
  return project ? read(project.path)[String(candidate.key)] || null : null;
}

/**
 * Start the monitor. Idempotent — a second call while running is a no-op.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=5000] - Tick cadence.
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  _meter.schedule(intervalMs);
  _timer = setInterval(() => {
    try {
      _tick({ scheduled: true, async: true });
    } catch (err) {
      log.warn('medusa-wake: tick error', { error: err.message });
    }
  }, intervalMs);
  if (_timer.unref) _timer.unref(); // never hold the event loop open
  log.info('medusa-wake monitor started', { intervalMs });
}

/**
 * Stop the monitor and clear all in-memory state.
 * @returns {void}
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _meter.unschedule();
  _meter.reset();
  // Any pane read still in flight answers to a monitor that no longer exists,
  // and so does any look that was requested or booked.
  _generation += 1;
  _requested.clear();
  for (const st of _sessions.values()) _cancelFollowUp(st);
  _sessions.clear();
  _masterPresence = null;
}

/** Injectable seams (lazy requires, so no require cycles). */
const _internal = {
  listLiveAll: () => require('./store').sessions.listLiveAll(),
  transportFor: (session) => wakeTransports.forSession(session),
  newNonce: () => wakeTransports.newNonce(),
  recordWakeFacts: (workspaceId, fact, opts) => require('./medusa-exchanges').recordWakeForRecipient(workspaceId, fact, opts),
  rearmDue: (workspaceId) => (workspaceId ? require('./medusa-exchanges').rearmDue(workspaceId) : false),
  pendingWakeCount: (workspaceId) => require('./medusa-exchanges').pendingWakeCount(workspaceId),
  noteAwaitingRead: (workspaceId) => require('./medusa-exchanges').noteAwaitingRead(workspaceId),
  alreadyAttempted: (workspaceId, hubIds) => (workspaceId ? require('./medusa-exchanges').alreadyAttempted(workspaceId, hubIds) : false),
  awaitingReadiness: (workspaceId) => (workspaceId ? require('./medusa-exchanges').awaitingReadiness(workspaceId) : false),
  noteReadiness: (workspaceId) => require('./medusa-exchanges').noteReadiness(workspaceId),
  verifySubmission: (tmuxName, engineId, nonce) => require('./wrap-delivery-receipt').verifySubmission(tmuxName, engineId, nonce),
  getProject: (projectId) => require('./store').projects.get(projectId),
  loadProjectConfig: (projectPath) => require('./store').projectConfig.load(projectPath),
  wrapRunning: (projectName) => require('./wrap-run-registry').get(projectName).running,
  getStatus: (sessionId) => require('./medusa').getStatus(sessionId),
  getMessages: (sessionId) => require('./medusa').getMessages(sessionId),
  capturePane: (session, options) => require('./tmux').capturePane(session, options),
  // The non-blocking read the timer-driven tick uses (#2086). `capturePane`
  // and `cursorInfo` stay as the synchronous seams a hand-driven tick reads.
  readPaneAsync: (session, options) => require('./tmux').readPaneAsync(session, options),
  cursorInfo: (session) => require('./tmux').cursorInfo(session),
  injectCommand: (projectName, command, options) => require('./sessions').injectCommand(projectName, command, options),
  // The Master's two seams, lazy like the rest so requiring this module never
  // pulls `lib/master.js` (and its store/engine graph) in behind it.
  masterWakeRecord: (options) => require('./master').masterWakeRecord(options),
  injectMaster: (command) => require('./master').injectMasterCommand(command),
  apiOrigin: _apiOrigin,
  openChannel: (sessionId) => require('./store').startupControlChannels.getOpenBySession(sessionId),
  launchSequence: (sessionId) => require('./store').launchSequences.getBySession(sessionId),
  declaresObserver: (engineId) => require('./startup-control').declaresObserver(engineId, (id) => require('./engines').resolveProfile(id)),
  observeActivity: (target) => require('./startup-control').observeActivity(target),
  rotationOpen: (projectId) => !!require('./coordinator-rotation').openRotation(projectId),
  recordDelivery: (entry) => require('./store').medusaDeliveries.record(entry),
  // Peer resolution (#918). The Master's listener key, read lazily for the same
  // reason as its other seams.
  masterKey: () => require('./master').MASTER_MEDUSA_KEY,
  registeredWorkspaceId: _registeredWorkspaceId,
  readRegistry: (projectPath) => require('./medusa-registry').readWorkspaceIds(projectPath),
  // Run something on the next turn of the event loop, and a timer that must
  // not hold the process open: seams so a test can drive both.
  defer: (fn) => { setImmediate(fn); },
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
  clearTimer: (t) => { clearTimeout(t); },
  now: () => Date.now(),
  // Monotonic milliseconds for the tick meter. Separate from `now`, which
  // tests pin to a wall-clock instant.
  clock: () => require('node:perf_hooks').performance.now(),
  tick: _tick
};

module.exports = {
  start,
  stop,
  wakeStallSummary,
  tickMetrics,
  requestScan,
  WAKE_STALL_ALERT_MS,
  peerReachability,
  verdictFor,
  masterIsLive,
  isRunning,
  localParticipant,
  peerReasonMeaning,
  PEER_REASON_MEANINGS,
  PEER_REASON_PREFIX_MEANINGS,
  _noteVerdict,
  assessSessionIdle,
  ACTIVITY_REASONS,
  _assessActivity,
  TMUX_TAIL_LINES,
  IDLE_TICKS_REQUIRED,
  PANE_READ_TIMEOUT_MS,
  MIN_OBSERVATION_GAP_MS,
  SLOW_PANE_READ_MS,
  PANE_BACKOFF_MS,
  ENGINE_ACTIVITY_MAX_AGE_MS,
  _assessPane,
  _cells,
  _composerEmpty,
  wakeSignature,
  // Exported so a guard can hold the engine guide's wake table against the real
  // field set: the guide said every field but one was required for as long as
  // that was true, and nothing failed when it stopped being (#1344).
  WAKE_FIELDS,
  _wakeBlockErrors,
  _buildWakeProfiles,
  // `_paneDigest` and `_strip` are PRODUCTION dependencies of the prime-paste
  // readiness gate (`lib/sessions.js#_awaitPaneReady`), not only test seams —
  // a change to the digest's composer/divider trimming or the ANSI stripping
  // changes when a prime is pasted. `test/prime-readiness-gate.test.js`
  // exercises the real digest against that gate.
  _paneDigest,
  _strip,
  locateComposer,
  readComposerDraft,
  isOwnNudge,
  COMPOSER_VERBATIM_MAX,
  _isDivider,
  _nudgeLine,
  _nudgeLineFor,
  _internal
};

// A getter, not a value: the table is derived from the engine profiles the
// store holds, and the store is not populated until `store.init()` — which
// `server.js` runs AFTER requiring this module. Exposed as a property so every
// consumer keeps writing `medusaWake.ENGINE_WAKE_PROFILES[engineId]` and pays
// the ordering no attention. The one thing that does NOT work is
// destructuring it at require time (`const { ENGINE_WAKE_PROFILES } = ...`):
// that reads the getter once, at exactly the moment the answer is still empty.
Object.defineProperty(module.exports, 'ENGINE_WAKE_PROFILES', {
  get: _resolveWakeProfiles,
  enumerable: true
});
