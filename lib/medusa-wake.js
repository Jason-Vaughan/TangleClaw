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
 * 5. **Profiled tmux engines only (#560 — engine-aware).** Each supported
 *    engine has an entry in `ENGINE_WAKE_PROFILES` carrying its live-probed
 *    idle/busy markers: Claude (`esc to interrupt` + bare `❯`) and antigravity/
 *    Gemini-CLI (`esc to cancel` + bare `>` + the `? for shortcuts` at-rest
 *    marker). webui/gateway sessions (no tmux pane — injection unsupported) and
 *    engines with no profile (e.g. codex, aider — no live idle signature
 *    captured yet) are skipped and logged once per session, never silent.
 *    Guessing an unprofiled engine's idle signature is exactly the false-idle
 *    hazard property 1 forbids, so an unknown engine stays off until probed.
 *
 * Lifecycle mirrors the other boot-time monitors (`wrap-sentinel`,
 * `tunnel-monitor`): `start()` arms a `setInterval` tick wired in `server.js`;
 * `stop()` clears it. All state is in-memory — a TC restart re-baselines (an
 * un-nudged backlog nudges again on the first post-restart idle tick, which is
 * at-most-once-late, never lost, because the inbox itself is the source).
 */

const { createLogger } = require('./logger');
const { createHash } = require('crypto');

const log = createLogger('medusa-wake');

const DEFAULT_INTERVAL_MS = 5000;
/** Consecutive idle ticks required before injecting (capture-race debounce). */
const IDLE_TICKS_REQUIRED = 2;
/** Pane tail depth — enough to see the input box + status line. */
const TMUX_TAIL_LINES = 15;

/**
 * Per-engine idle/busy detection profiles (#560 — engine-aware wake). Each
 * value's markers were derived from a LIVE pane capture, never guessed — a
 * false-idle read is the core injection hazard (header, safety property 1), so
 * an engine with no live signature stays absent here (→ skipped-and-logged).
 *
 * - `busyMarker` (string): substring present iff a turn is in flight; its
 *   presence blocks a nudge. Load-bearing when the prompt persists during a turn.
 * - `promptRe` (RegExp): matches a BARE input-prompt line (no dialog/menu row,
 *   no operator half-typed text). At least one line must match for idle.
 * - `idleMarker` (string|null): a POSITIVE at-rest signal that must be present
 *   for idle. Set only for engines whose bare prompt persists during a turn
 *   (antigravity keeps `>` while "Generating…"), so the busy-marker gate is
 *   never the sole guard; also excludes dialog/menu states that drop the hint.
 *   `null` for engines (Claude) where a busy turn already hides the bare prompt.
 *
 * @type {Object<string, {busyMarker: string, promptRe: RegExp, idleMarker: (string|null)}>}
 */
const ENGINE_WAKE_PROFILES = {
  // Claude Code. `busyMarker` is NOT sufficient and has not been since at least
  // 2.1.241: `esc to interrupt` survives only inside a `low_priority_waiting`
  // retry branch, so an ordinary busy turn never renders it (#1114). It is kept
  // because that retry state is real and worth catching, not because it gates a
  // normal turn — the transcript-movement check in `_tick` does that.
  //
  // Two claims that used to sit here were measured and are false. A busy turn
  // does NOT hide the bare `❯` (it is rendered throughout), and that was the
  // stated reason `idleMarker` could stay null (#1106). `idleMarker` is still
  // null, but for an honest reason: nothing was found that is present at rest
  // and absent mid-turn — the status and hint rows are identical in both.
  // `placeholderSgr` is how this engine renders text the operator did NOT type
  // (#1105): Claude Code dims its inline suggestion with SGR 2 (faint).
  claude: {
    busyMarker: 'esc to interrupt', promptRe: /^\s*❯[\u00a0 ]?$/, promptGlyph: '❯',
    // `promptPad` is the separator the engine itself draws between the glyph
    // and the first input column — measured from live panes, NOT assumed
    // (#1109). Claude Code uses NBSP, which is why `promptRe` accepts exactly
    // that and nothing else: a trailing ordinary space is the operator's.
    placeholderSgr: [2], promptPad: '\u00a0', idleMarker: null
  },
  // antigravity / Gemini CLI (#560 spike, 2026-07-14): status flips to
  // `esc to cancel` (from `? for shortcuts`) while a spinner shows "Generating…"
  // — but the bare `>` input line is STILL rendered mid-turn, so `? for
  // shortcuts` is required as the positive at-rest signal.
  // antigravity greys its mode banner ("Accept-edits mode: …") with SGR 90
  // (bright black) rather than dimming it — a different attribute for the same
  // idea, which is why `placeholderSgr` is declared per engine and not shared.
  antigravity: {
    // No `promptPad`: this engine's separator has never been measured from a
    // live pane, so the composer check keeps its older reading here rather
    // than inheriting Claude's. An unmeasured engine gets the honest laxer
    // gate, never a borrowed fact (#1109).
    busyMarker: 'esc to cancel', promptRe: /^\s*>\s*$/, promptGlyph: '>',
    placeholderSgr: [90], promptPad: null, idleMarker: '? for shortcuts'
  }
};

// CSI escape sequences + bare CR (same construction as wrap-sentinel.js:
// explicit unicode escapes, newlines preserved so line structure survives).
// eslint-disable-next-line no-control-regex
const ANSI_RE = new RegExp('\\u001b\\[[0-9;:?]*[ -/]*[@-~]|\\u001b[()][AB0-2]|\\r', 'g');

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/**
 * Per-session monitor state.
 * @type {Map<number, {idleTicks: number, lastNudgedKey: string|null, skipLogged: boolean, configWarnLogged: boolean, cursorWarnLogged: boolean}>}
 */
const _sessions = new Map();

/**
 * Strip ANSI escape sequences (and CR), preserving newlines.
 * @param {string} text - Raw pane text.
 * @returns {string} Plain text.
 */
function _strip(text) {
  return String(text == null ? '' : text).replace(ANSI_RE, '');
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
  const stripped = (lines || []).map((l) => _strip(l).replace(/\s+$/, ''));
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
  while (end > 0 && /^[\u2500\u2501\u2504\u2505\u2508\u2509-]+$/.test(stripped[end - 1].trim())) end -= 1;
  return createHash('sha1').update(stripped.slice(0, end).join('\n')).digest('hex');
}

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
  const padded = pad && (sep === pad || sep === ' ');
  const contentStart = padded ? glyph + 2 : glyph + 1;
  for (let i = contentStart; i < cursor.x && i < cells.length; i++) {
    // Engines with no measured `promptPad` keep the older, laxer reading: a
    // blank cell may be padding this module has never seen rendered, and
    // inventing a separator for an unmeasured engine would be a guess.
    if (pad || !_BLANK_RE.test(cells[i].ch)) return false;
  }
  // Anything to the right must be the suggestion (faint) or padding.
  for (let i = cursor.x; i < cells.length; i++) {
    if (!_isPlaceholder(cells[i], profile.placeholderSgr) && !_BLANK_RE.test(cells[i].ch)) return false;
  }
  return true;
}

/**
 * Judge a captured pane tail against an engine profile: is the session safe to
 * type into right now?
 *
 * Pure — the whole idle policy lives here so tests can pin it byte-for-byte.
 * Gate order (each blocks alone): busy marker present → `turn-in-flight`;
 * a running subagent fleet → `agents-running`;
 * a positive `idleMarker` required-but-absent → `not-at-rest` (covers an
 * engine whose prompt persists mid-turn, and any dialog/menu that drops the
 * at-rest hint); no bare `promptRe` line → `no-bare-prompt`; else idle.
 * @param {string[]} lines - Pane tail lines (raw, may carry ANSI).
 * @param {{busyMarker: string, promptRe: RegExp, promptGlyph: string, idleMarker: (string|null)}} profile
 *   - The engine's detection profile (from `ENGINE_WAKE_PROFILES`).
 * @param {{x: number, line: string}} [cursor] - Cursor column and its raw line
 *   (`tmux.cursorInfo`). Omit it and the prompt check falls back to reading the
 *   rendered line, which cannot distinguish an inline suggestion from typed
 *   input (#1103).
 * @returns {{idle: boolean, reason: string}} `idle` true only when the busy
 *   marker is absent, any required idle marker is present, AND a bare prompt
 *   line is present; `reason` is one of
 *   `turn-in-flight` | `not-at-rest` | `no-bare-prompt` | `at-prompt`.
 */
function _assessPane(lines, profile, cursor) {
  const text = _strip((lines || []).join('\n'));
  if (text.includes(profile.busyMarker)) return { idle: false, reason: 'turn-in-flight' };
  // A running subagent fleet makes the pane unsafe to type into, so this gate
  // sits above the prompt checks rather than beside them (#783) — see
  // `_FLEET_RE` for why the agent block is the signal and the status-line
  // `← N agents` hint is not.
  if (_FLEET_RE.test(text)) return { idle: false, reason: 'agents-running' };
  if (profile.idleMarker && !text.includes(profile.idleMarker)) {
    return { idle: false, reason: 'not-at-rest' };
  }
  // Cursor first when it is available, because it answers the question the
  // rendered text only approximates (#1103): a pending inline suggestion draws
  // a sentence on the prompt line that the text check cannot tell from typed
  // input. `null` means the cursor is not on a prompt line at all, which is not
  // evidence of rest — fall through to the text check rather than assume.
  const composerEmpty = _composerEmpty(cursor, profile);
  if (composerEmpty === true) return { idle: true, reason: 'at-prompt' };
  if (composerEmpty === false) return { idle: false, reason: 'no-bare-prompt' };

  const hasBarePrompt = text.split('\n').some((l) => profile.promptRe.test(l));
  if (!hasBarePrompt) return { idle: false, reason: 'no-bare-prompt' };
  return { idle: true, reason: 'at-prompt' };
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

/**
 * The nudge line for any switchboard API base — a project session's
 * `/api/sessions/:project/medusa` or the Master's `/api/master/medusa`. The
 * Master has no project name to encode, so the base is the parameter; the
 * bytes are otherwise the same fixed TC-controlled text (safety property 2).
 * @param {string} apiBase - The recipient's switchboard API base path.
 * @param {number} unread - Unread count (informational only).
 * @returns {string} The nudge line.
 */
function _nudgeLineFor(apiBase, unread, origin) {
  const base = origin || _internal.apiOrigin();
  return `[TangleClaw Switchboard] You have ${unread} unread Medusa message(s). ` +
    `Fetch them from the TangleClaw API at ${base}: ` +
    `GET ${apiBase}/messages — act on them as appropriate, ` +
    `then mark them handled: POST ${apiBase}/read {"ids":[...]}, ` +
    `then reply to the sender: POST ${apiBase}/send — the initiator closes the ` +
    `exchange, so a message you do not answer leaves them blocked.`;
}

/**
 * Scan one live session: gate (transport → engine → pref → listener → fresh
 * mail → idle debounce), then inject the nudge and advance the watermark.
 * @param {object} session - A `store.sessions.listLiveAll()` record.
 * @returns {void}
 */
function _scanSession(session) {
  const sessionId = session.id;
  let st = _sessions.get(sessionId);
  if (!st) {
    st = { idleTicks: 0, lastNudgedKey: null, skipLogged: false, configWarnLogged: false, cursorWarnLogged: false, lastRecorded: null };
    _sessions.set(sessionId, st);
  }

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
  }

  // Transport + engine gates (#560 — engine-aware): a live tmux pane and a
  // known wake profile for the session's engine. webui has no pane; an
  // unprofiled engine has no live-captured idle signature to type against
  // safely. Logged once per session so an unsupported-but-opted-in session is
  // never a silent no-op.
  const profile = ENGINE_WAKE_PROFILES[session.engineId];
  if (session.sessionMode === 'webui' || !session.tmuxSession || !profile) {
    if (!st.skipLogged) {
      st.skipLogged = true;
      log.info('medusa-wake: session skipped (unsupported transport or unprofiled engine)', {
        sessionId, sessionMode: session.sessionMode, engineId: session.engineId
      });
    }
    record('skipped', 'none', session.sessionMode === 'webui' ? 'no-pane' : 'unprofiled-engine');
    return;
  }

  // A wrapping (or otherwise non-active) session is ending — never nudge it.
  if (session.status && session.status !== 'active') {
    st.idleTicks = 0;
    record('skipped', 'none', `session-${session.status}`);
    return;
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
    if (!project) { st.idleTicks = 0; record('skipped', 'none', 'no-project'); return; }

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
      return;
    }
    optedIn = Boolean(projConfig) && projConfig.medusaWake === true;
  }
  // The most consequential skip in the file: a session sitting on unread mail
  // that nothing will ever tell it about, because the wake is off. Silent until
  // #792, and indistinguishable from an empty inbox from anywhere outside.
  if (!optedIn) { st.idleTicks = 0; record('skipped', 'none', 'wake-not-opted-in'); return; }

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
    return; // hold — watermark untouched, wake survives the reconnect window
  }
  if (status.unread === 0) {
    // Nothing pending: keep the watermark at the inbox edge so only a FUTURE
    // arrival nudges (a backlog the operator/agent already read never fires).
    st.lastNudgedKey = _newestKey(_internal.getMessages(sessionId));
    st.idleTicks = 0;
    return;
  }
  const inbox = _internal.getMessages(sessionId);
  const newest = _newestKey(inbox);
  if (newest === null || newest === st.lastNudgedKey) {
    st.idleTicks = 0; // already nudged for this edge — the agent owns it now
    return;
  }

  // Idle gate + debounce.
  let cap;
  try {
    cap = _internal.capturePane(session.tmuxSession, { lines: TMUX_TAIL_LINES });
  } catch {
    st.idleTicks = 0; // pane vanished mid-poll (session dying) — prune pass drops it
    record('skipped', 'none', 'pane-capture-failed');
    return;
  }
  // Best-effort: a pane that cannot report a cursor still gets judged, just by
  // the weaker text check. Never fatal — a nudge must not be lost to a tmux
  // query that failed while the pane itself captured fine.
  let cursor = null;
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
  // Whether a turn is in flight is answered by the transcript MOVING, not by a
  // marker string (#1114). Claude's `busyMarker` stopped rendering on an
  // ordinary turn, and measurement found no string that separates the states:
  // mid-stream the spinner is absent, the bare prompt is present and the status
  // rows match a resting pane exactly. A working session writes; a resting one
  // does not. The digest excludes the composer and status rows, which the
  // engine rotates on its own while idle.
  const digest = _paneDigest(cap.lines || [], profile);
  const moved = st.paneDigest !== undefined && st.paneDigest !== digest;
  st.paneDigest = digest;

  const verdict = _assessPane(cap.lines || [], profile, cursor);
  if (!verdict.idle) {
    st.idleTicks = 0;
    record('skipped', 'none', `pane-${verdict.reason}`);
    return;
  }
  // Sits BELOW the marker gates so their reasons stay reportable, and above the
  // streak so a pane that is still writing can never accumulate one.
  if (moved) {
    st.idleTicks = 0;
    record('skipped', 'none', 'pane-writing');
    return;
  }
  st.idleTicks += 1;
  if (st.idleTicks < IDLE_TICKS_REQUIRED) return;

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
  const label = session.isMaster ? session.name : project.name;
  const result = session.isMaster
    ? _internal.injectMaster(_nudgeLineFor(session.apiBase, status.unread))
    : _internal.injectCommand(project.name, _nudgeLine(project.name, status.unread), { sessionId });
  const channel = session.isMaster ? 'master-inject' : 'tmux-inject';
  st.idleTicks = 0;
  if (!result.ok) {
    log.warn('medusa-wake: nudge injection failed', { project: label, sessionId, error: result.error });
    // #791: an injection that reached the pane and did not land used to leave
    // no trace anywhere, so a broken channel read exactly like a quiet peer.
    record('failed', channel, `inject-failed: ${result.error || 'unknown'}`);
    return;
  }
  st.lastNudgedKey = newest;
  record('nudged', channel, null);
  log.info('medusa-wake: nudged idle session about fresh inbox mail', {
    project: label, sessionId, unread: status.unread
  });
}

/**
 * One monitor tick: prune state for ended sessions, then scan every live one.
 * Exposed via `_internal.tick` so tests drive it deterministically.
 * @returns {void}
 */
function _tick() {
  let live;
  try {
    live = _internal.listLiveAll();
  } catch (err) {
    log.warn('medusa-wake: listLiveAll failed', { error: err.message });
    return;
  }
  // The Master joins the scan as one more session-shaped record, so it is
  // pruned, gated and debounced by the same code as everyone else. Its own
  // failure is contained: a broken Master probe must not cost the projects
  // their tick, and `null` (absent, or tmux silent) simply means nothing to scan.
  try {
    const masterRecord = _internal.masterWakeRecord();
    if (masterRecord) live = live.concat([masterRecord]);
  } catch (err) {
    log.warn('medusa-wake: master record failed', { error: err.message });
  }
  const liveIds = new Set(live.map((s) => s.id));
  for (const sid of _sessions.keys()) {
    if (!liveIds.has(sid)) _sessions.delete(sid);
  }
  for (const session of live) {
    try {
      _scanSession(session);
    } catch (err) {
      log.warn('medusa-wake: scan failed', { sessionId: session.id, error: err.message });
    }
  }
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
  _timer = setInterval(() => {
    try {
      _tick();
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
  _sessions.clear();
}

/** Injectable seams (lazy requires mirror wrap-sentinel — no require cycles). */
const _internal = {
  listLiveAll: () => require('./store').sessions.listLiveAll(),
  getProject: (projectId) => require('./store').projects.get(projectId),
  loadProjectConfig: (projectPath) => require('./store').projectConfig.load(projectPath),
  getStatus: (sessionId) => require('./medusa').getStatus(sessionId),
  getMessages: (sessionId) => require('./medusa').getMessages(sessionId),
  capturePane: (session, options) => require('./tmux').capturePane(session, options),
  cursorInfo: (session) => require('./tmux').cursorInfo(session),
  injectCommand: (projectName, command, options) => require('./sessions').injectCommand(projectName, command, options),
  // The Master's two seams, lazy like the rest so requiring this module never
  // pulls `lib/master.js` (and its store/engine graph) in behind it.
  masterWakeRecord: () => require('./master').masterWakeRecord(),
  injectMaster: (command) => require('./master').injectMasterCommand(command),
  apiOrigin: _apiOrigin,
  recordDelivery: (entry) => require('./store').medusaDeliveries.record(entry),
  tick: _tick
};

module.exports = {
  start,
  stop,
  ENGINE_WAKE_PROFILES,
  IDLE_TICKS_REQUIRED,
  _assessPane,
  _cells,
  _composerEmpty,
  // `_paneDigest` and `_strip` are PRODUCTION dependencies of the prime-paste
  // readiness gate (`lib/sessions.js#_awaitPaneReady`), not only test seams —
  // a change to the digest's composer/divider trimming or the ANSI stripping
  // changes when a prime is pasted. `test/prime-readiness-gate.test.js`
  // exercises the real digest against that gate.
  _paneDigest,
  _strip,
  _nudgeLine,
  _nudgeLineFor,
  _internal
};
