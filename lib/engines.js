'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync, execFile } = require('node:child_process');
const store = require('./store');
const { createLogger } = require('./logger');
const { wasTimedOut } = require('./exec-timeout');
const rulesChannel = require('./session-rules-channel');
const { effectiveServerProtocol, effectiveServerPort } = require('./https-setup');
const { tildeHomePath } = require('./project-paths');
const { tcBootstrapLines, planDocsLine } = require('./ecosystem-primer');
const engineErrors = require('./engine-errors');
const { DEFAULT_PROJECT_CONFIG } = require('./project-config');

const log = createLogger('engines');

// Delimiters for the region TangleClaw owns inside a config file it shares with
// another writer. The pair must survive round-tripping through the host format,
// so each syntax uses its own comment form rather than one universal string.
//
// The name is deliberately specific: a generic marker would collide with the
// other writers this mechanism exists to coexist with. `next dev` already writes
// `<!-- BEGIN:nextjs-agent-rules -->` into the same AGENTS.md files, which is
// both the precedent for the pattern and the reason ours has to be namespaced.
const MANAGED_BLOCK_NAME = 'tangleclaw';

// Carrier filenames that belong to a shared, multi-vendor convention: files an
// operator commits and other tools also write. For these the write strategy is
// NOT a free choice — owning the whole file destroys whatever else lives in it —
// so an absent or whole-file strategy is refused at the write, not merely
// asserted about bundled profiles in a test. An operator profile in
// `~/.tangleclaw/engines/` never passes through those tests.
const SHARED_CONVENTION_CARRIERS = ['AGENTS.md', 'GEMINI.md', 'CONVENTIONS.md'];
const MANAGED_BLOCK_COMMENT_FORMS = {
  markdown: (text) => `<!-- ${text} -->`,
  yaml: (text) => `# ${text}`,
  toml: (text) => `# ${text}`
};

/**
 * Resolve the begin/end markers delimiting TangleClaw's managed region for a
 * config syntax.
 *
 * @param {string} syntax - `configFormat.syntax` (markdown, yaml, toml)
 * @returns {{begin: string, end: string}|null} Markers, or null when the syntax
 *   has no comment form this mechanism knows how to write. Null is a refusal,
 *   not a default: guessing a comment form would corrupt the host file.
 */
function _managedBlockMarkers(syntax) {
  const comment = MANAGED_BLOCK_COMMENT_FORMS[syntax];
  if (!comment) return null;
  return {
    begin: comment(`BEGIN:${MANAGED_BLOCK_NAME}`),
    end: comment(`END:${MANAGED_BLOCK_NAME}`)
  };
}

/**
 * Demote every top-level markdown heading to `##`, leaving fenced code blocks
 * untouched.
 *
 * The block lands inside a document whose other sections belong to the operator
 * and to tools like `next dev`, so it must not introduce a second H1 — but a
 * `#` inside a fence is a shell comment, not a heading.
 *
 * @param {string} body - Composed markdown body
 * @returns {string} The body with prose-level H1s demoted
 */
function _demoteTopLevelHeadings(body) {
  let inFence = false;
  return body.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line.replace(/^# (?!#)/, '## ');
  }).join('\n');
}

/**
 * Read back the body currently inside the managed markers.
 *
 * @param {string} text - File contents
 * @param {string} syntax - `configFormat.syntax`
 * @returns {string|null} The body between the markers, or null when the file
 *   carries no usable pair (no block yet, or a malformed one).
 */
function _extractManagedBlock(text, syntax) {
  const markers = _managedBlockMarkers(syntax);
  if (!markers) return null;
  const start = text.indexOf(markers.begin);
  const stop = text.indexOf(markers.end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return text.slice(start + markers.begin.length, stop);
}

/**
 * Splice TangleClaw's generated content into a file another writer also owns,
 * touching only the region between our markers.
 *
 * Replaces an existing block in place (preserving everything around it) or
 * appends one when absent. Everything outside the markers is returned byte for
 * byte — that is the whole contract, and the reason this exists: the previous
 * whole-file write destroyed a hand-written `AGENTS.md` and would have fought
 * `next dev`, which re-adds its own block to the same file on every run.
 *
 * A malformed marker pair is REFUSED rather than repaired. An end before a
 * begin, or a begin with no end, describes a file we cannot edit without
 * guessing where someone else's content starts — and a wrong guess deletes it.
 * Reporting the refusal leaves the file intact and names why.
 *
 * @param {string} existing - Current file contents
 * @param {string} blockBody - Generated content to place inside the markers
 * @param {string} syntax - `configFormat.syntax`, selecting the comment form
 * @returns {{merged: string|null, error: string|null}} `merged` is the full new
 *   file contents; `error` is set instead when the existing markers are
 *   unusable, and then nothing should be written.
 */
function _mergeManagedBlock(existing, blockBody, syntax) {
  const markers = _managedBlockMarkers(syntax);
  if (!markers) {
    return { merged: null, error: `no managed-block comment form for syntax '${syntax}'` };
  }

  // The body is not ours alone: `_generateGeminiMd` embeds `global-rules.md` and
  // whole shared-document bodies verbatim, so a marker literal can arrive from
  // operator-authored content. Splicing it would write a file with two begins
  // and two ends — which the malformed check below then refuses forever, turning
  // one bad shared doc into a permanently unwritable config. Refuse at the door
  // instead, where the file is still intact and the cause is still nameable.
  if (blockBody.includes(markers.begin) || blockBody.includes(markers.end)) {
    return {
      merged: null,
      error: 'generated content contains a managed-block marker literal — '
        + 'splicing it would produce a file that can never be written again '
        + '(check global-rules.md and any injected shared document)'
    };
  }

  // The block lands inside a document whose other sections belong to the
  // operator and to tools like `next dev`, so it must not introduce a second
  // H1. The generator's own header is already demoted, but the injected
  // global-rules body opens with its own `# Global Rules`, so demote every
  // top-level heading in the composed body rather than trusting the header
  // alone — the previous fix addressed the one site it could see.
  // Demote only real headings. The composed body splices porthub-guide.md and
  // shared-docs-guide.md verbatim, and those carry `# …` SHELL COMMENTS inside
  // fenced code blocks; a blanket regex rewrote them to `## …` in every
  // generated file. Track fence state so the pass edits prose, not code.
  const demoted = syntax === 'markdown' ? _demoteTopLevelHeadings(blockBody) : blockBody;

  const block = `${markers.begin}\n${demoted.replace(/\s+$/, '')}\n${markers.end}`;

  // Count before locating: two blocks mean an earlier bug or a hand-duplicated
  // file, and splicing "the first one" would silently strand the second as dead
  // content that still reads as ours.
  const beginCount = existing.split(markers.begin).length - 1;
  const endCount = existing.split(markers.end).length - 1;

  if (beginCount === 0 && endCount === 0) {
    const base = existing.replace(/\s+$/, '');
    return { merged: base ? `${base}\n\n${block}\n` : `${block}\n`, error: null };
  }
  if (beginCount !== 1 || endCount !== 1) {
    return {
      merged: null,
      error: `managed-block markers are malformed (${beginCount} begin, ${endCount} end — expected 1 each)`
    };
  }

  const start = existing.indexOf(markers.begin);
  const stop = existing.indexOf(markers.end);
  if (stop < start) {
    return { merged: null, error: 'managed-block end marker precedes its begin marker' };
  }

  const before = existing.slice(0, start);
  const after = existing.slice(stop + markers.end.length);
  return { merged: `${before}${block}${after}`, error: null };
}

/** The header sentence every whole-file generator writes; the retire path detects it (#858). */
const GENERATED_HEADER_MARK = 'Generated by TangleClaw';

/** The sentence that marks a config file as no longer regenerated (#858). */
const INACTIVE_CONFIG_MARK = 'TangleClaw: INACTIVE engine config';

/**
 * Today's date from LOCAL components — a UTC timestamp read after ~17:00
 * Pacific is already tomorrow, and a notice dated tomorrow mis-correlates
 * against git log and the session ledger.
 * @returns {string} YYYY-MM-DD
 */
function _localDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The inactive notice for a retired config file, in the file's own comment
 * form (the same forms the managed-block markers use) so it parses wherever
 * the engine would have read it.
 * @param {string} previousEngineId - The engine this file belonged to.
 * @param {string} activeEngineId - The engine now live.
 * @param {string|null} activeFile - The live engine's config filename.
 * @param {string} syntax - `configFormat.syntax` of the retired file.
 * @returns {string|null} Notice text, or null when the syntax has no comment form.
 */
function _inactiveNotice(previousEngineId, activeEngineId, activeFile, syntax) {
  const comment = MANAGED_BLOCK_COMMENT_FORMS[syntax];
  if (!comment) return null;
  const sentences = [
    `${INACTIVE_CONFIG_MARK} — this project's engine switched from ${previousEngineId} to ${activeEngineId} on ${_localDate()}.`,
    activeFile ? `The live config is ${activeFile}.` : `The ${activeEngineId} engine has no config file.`,
    'TangleClaw no longer regenerates this file; nothing here governs sessions.',
    `Switching back to ${previousEngineId} regenerates it.`
  ];
  if (syntax === 'markdown') {
    return [comment(INACTIVE_CONFIG_MARK), `# ${sentences[0]}`, '', ...sentences.slice(1)].join('\n');
  }
  return sentences.map((line) => comment(line)).join('\n');
}

/**
 * Retire the previous engine's config file after an engine switch (#858).
 *
 * `generateConfig` writes only the ACTIVE engine's file, so after a switch the
 * previous engine's file stayed on disk unmarked — indistinguishable from a
 * live one, read by convention (`CLAUDE.md` especially), and steadily wrong as
 * the rules moved on. Same failure shape `syncEngineHooks` already clears for
 * a stale hooks block; same answer: what is no longer authoritative says so.
 *
 * Marks, never deletes, and only what TangleClaw wrote: a managed block is
 * replaced by the notice (content outside the markers is the operator's and
 * stays), a whole-file config that carries `GENERATED_HEADER_MARK` is replaced
 * by the notice, and anything else — a hand-written file, a plugin-owned
 * `CLAUDE.md` — is left alone with the reason stated. Switching back
 * regenerates through `writeEngineConfig`, which treats the notice as its own
 * content, not as operator drift.
 *
 * Two shapes of `retired: false`: a deliberate skip carries `reason` only; a
 * FAILURE (unreadable, unwritable, a refused merge) also carries `error`, so
 * the caller can log it at warn — a file left as live canon by accident is
 * the #858 defect, not a choice.
 *
 * @param {string} projectPath - Absolute project root.
 * @param {string} previousEngineId - The engine being switched away from.
 * @param {string} activeEngineId - The engine being switched to.
 * @returns {{retired: boolean, file: (string|null), reason: string, error: (string|null)}}
 */
function retireInactiveEngineConfig(projectPath, previousEngineId, activeEngineId) {
  const skip = (file, reason) => ({ retired: false, file, reason, error: null });
  const failed = (file, reason, error) => ({ retired: false, file, reason, error });
  const prev = store.engines.get(previousEngineId);
  const next = store.engines.get(activeEngineId);
  if (!prev || !prev.configFormat || !prev.configFormat.filename) {
    return skip(null, `engine ${previousEngineId} has no config file`);
  }
  const filename = prev.configFormat.filename;
  const file = path.join(projectPath, filename);
  const activeFile = next && next.configFormat && next.configFormat.filename ? next.configFormat.filename : null;
  if (activeFile === filename) return skip(file, 'both engines share one config file — the active engine regenerates it');
  if (!fs.existsSync(file)) return skip(file, 'no config file on disk');
  if (previousEngineId === 'claude' && isPluginGoverned(projectPath)) {
    return skip(file, 'plugin-governed: the file is the plugin\'s; TangleClaw writes only an operational block there (#1021)');
  }
  let existing;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return failed(file, 'could not read it', err.message);
  }
  if (existing.includes(INACTIVE_CONFIG_MARK)) return skip(file, 'already marked inactive');
  const syntax = prev.configFormat.syntax;
  const notice = _inactiveNotice(previousEngineId, activeEngineId, activeFile, syntax);
  if (!notice) return skip(file, `no comment form for syntax '${syntax}' — left alone`);
  const markers = _managedBlockMarkers(syntax);
  if (markers && existing.includes(markers.begin) && existing.includes(markers.end)) {
    const { merged, error } = _mergeManagedBlock(existing, notice, syntax);
    if (error) return failed(file, 'managed-block merge refused', error);
    try {
      fs.writeFileSync(file, merged);
    } catch (err) {
      return failed(file, 'could not write it', err.message);
    }
    return { retired: true, file, reason: 'managed block replaced by the inactive notice; content outside the markers kept', error: null };
  }
  if (existing.split('\n').slice(0, 3).some((line) => line.includes(GENERATED_HEADER_MARK))) {
    try {
      fs.writeFileSync(file, `${notice}\n`);
    } catch (err) {
      return failed(file, 'could not write it', err.message);
    }
    return { retired: true, file, reason: 'generated file replaced by the inactive notice', error: null };
  }
  return skip(file, 'not TangleClaw-written (no generated header, no managed markers) — left alone');
}


/**
 * Detect which engines are available on the system.
 * Checks each engine profile's detection config.
 * Uses whatever PATH `refreshDetectionPath` last resolved; it does not resolve
 * one itself, so calling this never spawns a login shell.
 * @param {object} [options] - Options, forwarded to each `detectEngine`.
 * @param {boolean} [options.fresh] - Probe now rather than trusting the cache.
 * @returns {{ id: string, available: boolean, path: string|null }[]}
 */
function detect(options = {}) {
  const profiles = store.engines.list();
  const results = [];
  for (const profile of profiles) {
    const result = detectEngine(profile, options);
    results.push(result);
    if (result.available) {
      log.debug('Engine detected', { id: profile.id, path: result.path });
    }
  }

  return results;
}

/**
 * Detect availability of a single engine.
 *
 * Answers from a short-lived cache by default (see `DETECTION_TTL_MS`), because
 * the expensive caller is a poll asking the same question about the same machine
 * once per project. `{ fresh: true }` is for the callers where a stale answer
 * has a cost the poll does not have: a LAUNCH GATE refusing to start a session
 * because a minute-old probe said the binary was missing tells an operator who
 * just installed it that it is not there. A button press can afford a probe; a
 * ten-second poll across a fleet cannot.
 *
 * @param {object} profile - Engine profile object
 * @param {object} [options] - Options.
 * @param {boolean} [options.fresh] - Probe now rather than trusting the cache.
 *   The answer is still cached for everyone else.
 * @returns {{ id: string, available: boolean, path: string|null }}
 */
function detectEngine(profile, options = {}) {
  if (!profile || !profile.detection) {
    return { id: profile ? profile.id : 'unknown', available: false, path: null };
  }

  const { strategy, target } = profile.detection;

  switch (strategy) {
    case 'which':
      return _detectWhich(profile.id, target, options);
    case 'path':
      return _detectPath(profile.id, target, options);
    default:
      log.warn('Unknown detection strategy', { id: profile.id, strategy });
      return { id: profile.id, available: false, path: null };
  }
}

/**
 * Detect availability of a single engine without blocking the event loop.
 *
 * The form `enrichProject` uses: it runs per project on the ten-second poll, so
 * a probe there stops every other route for as long as it takes. Shares one
 * cache with `detectEngine`, so whichever asks first pays and the other does not.
 *
 * The `path` strategy has no async form — see `_detectPath` for why making it
 * one would move a hang rather than remove it. It still honours `fresh`; only
 * `execFn` and `timeout`, which describe a subprocess, mean nothing to it.
 *
 * @param {object} profile - Engine profile object
 * @param {object} [options] - Options, forwarded to whichever probe runs.
 * @param {boolean} [options.fresh] - Probe now rather than trusting the cache.
 *   For gates; see `detectEngine` for why a gate must not remember.
 * @param {Function} [options.execFn] - Injected `execFile` (tests).
 * @param {number} [options.timeout] - Milliseconds before the probe is killed.
 * @returns {Promise<{ id: string, available: boolean, path: string|null }>}
 */
async function detectEngineAsync(profile, options = {}) {
  if (!profile || !profile.detection) {
    return { id: profile ? profile.id : 'unknown', available: false, path: null };
  }

  const { strategy, target } = profile.detection;

  switch (strategy) {
    case 'which':
      return _detectWhichAsync(profile.id, target, options);
    case 'path':
      // `options` forwarded here too, even though this arm has no async form and
      // ignores `execFn`/`timeout`: `fresh` is meaningful for it, and an option
      // a function accepts and silently drops on ONE branch is worse than one it
      // never took — the call site reads as asking for a fresh probe and gets a
      // cached answer.
      return _detectPath(profile.id, target, options);
    default:
      log.warn('Unknown detection strategy', { id: profile.id, strategy });
      return { id: profile.id, available: false, path: null };
  }
}

// The operator's real PATH, resolved once and reused for every engine probe.
// Null until asked for; see `_detectionPath`.
let _loginPathCache = null;
// Did a login shell actually answer for the cached PATH? False means detection
// looked only where launchd could see, which is the difference between "not
// installed" and "we could not look" — and that difference now decides whether
// an operator can finish setup at all.
let _loginProbeSucceeded = false;
// Whether a probe has been ATTEMPTED for the current cache generation, which is
// not the same as whether one succeeded. Without the distinction, "re-probe when
// nothing was found and no shell has answered" re-probes on EVERY request for
// any operator whose shell cannot answer — the people most likely to be sitting
// on the engine step pressing buttons.
let _loginProbeAttempted = false;

// Markers around the PATH the probe shell prints. An interactive rc file is
// someone else's code and routinely writes to stdout — a version notice, a
// prompt framework, a "you have mail" — so taking the whole of stdout as the
// answer yields a PATH with a banner glued to it. Only what sits between these
// counts.
const SHELL_PATH_START = '__TC_PATH_START__';
const SHELL_PATH_END = '__TC_PATH_END__';

/**
 * Ask one shell, invoked with `flags`, what the operator's PATH is.
 *
 * @param {string} shell - Absolute path to the shell binary.
 * @param {string} flags - Invocation flags, e.g. `-lic`.
 * @returns {Promise<string>} The PATH it reported, or `''` if it did not answer usably.
 */
function _probeShellPath(shell, flags) {
  return new Promise((resolve) => {
    // ASYNC, because this is the expensive half: it runs the operator's own
    // profile, which is unbounded work someone else wrote and may block. Run
    // synchronously inside a request handler it would be this branch's own
    // defect — a route that stops the event loop for as long as somebody's
    // shell takes to start.
    execFile(
      shell,
      [flags, `printf "${SHELL_PATH_START}%s${SHELL_PATH_END}" "$PATH"`],
      { timeout: 6000, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) return resolve('');
        const out = String(stdout || '');
        const start = out.indexOf(SHELL_PATH_START);
        const end = out.indexOf(SHELL_PATH_END);
        if (start === -1 || end === -1 || end < start) return resolve('');
        resolve(out.slice(start + SHELL_PATH_START.length, end).trim());
      }
    );
  });
}

/**
 * The PATH to look for engine binaries on: the operator's login PATH merged
 * with this process's own.
 *
 * The server runs under launchd, whose PATH is `/usr/bin:/bin:/usr/sbin:/sbin`
 * and nothing else. Every common way to install an engine CLI puts it somewhere
 * else — npm-global, nvm, volta, Homebrew's `/opt/homebrew/bin`, `~/.local/bin`
 * — so `which` in this process answers "not installed" about binaries the
 * operator can run by name in their own terminal (#346). Setup now REFUSES to
 * finish with no engine, which turns that wrong answer from a cosmetic label
 * into a door the operator cannot open, so the probe has to look where they
 * actually installed it.
 *
 * MERGED, never replaced. Anything findable today must stay findable: a login
 * shell that returns a narrower PATH than launchd's — or nothing at all — may
 * only ADD candidates, never remove them.
 *
 * One login shell per cycle, not one per engine: a login shell sources the
 * operator's profile, which is unbounded work someone else wrote, and doing it
 * per profile multiplies whatever that costs by the number of engines.
 *
 * @returns {string} A PATH value; never empty, since it always contains this
 *   process's own.
 */
function _detectionPath() {
  if (_loginPathCache !== null) return _loginPathCache;
  // Nobody has resolved it yet. Answer with what this process can see rather
  // than spawning a shell from a synchronous accessor — detection then behaves
  // exactly as it did before any of this existed, which is a worse answer but
  // never a slower request.
  return process.env.PATH || '';
}

/**
 * Resolve the operator's login PATH and cache it. ASYNC and awaited off the
 * request path — at boot, and by the wizard's explicit "Check again".
 *
 * @returns {Promise<{path: string, probed: boolean}>} `probed` is false when no
 *   shell answered: the caller then knows its detection results mean "we could
 *   not look properly", not "it is not installed".
 */
async function refreshDetectionPath() {
  const ownPath = process.env.PATH || '';
  const shell = process.env.SHELL || '/bin/zsh';
  // Interactive-login FIRST. `-l` alone sources the login profile
  // (`.zprofile`/`.profile`), but zsh reads `.zshrc` only for INTERACTIVE
  // shells — and `.zshrc` is where most people's PATH edits actually live.
  // Measured on this machine: `-lc` found the engines under ~/.local/bin and
  // missed the one under ~/.npm-global/bin; the difference was entirely
  // `.zshrc`. `-lc` stays as the fallback for a setup where the interactive rc
  // fails or hangs.
  const loginPath = (await _probeShellPath(shell, '-lic')) || (await _probeShellPath(shell, '-lc'));

  const seen = new Set();
  const merged = [];
  for (const entry of `${loginPath}:${ownPath}`.split(':')) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  _loginPathCache = merged.join(':');
  _loginProbeSucceeded = loginPath !== '';
  _loginProbeAttempted = true;
  // A newly resolved PATH changes what is findable, and this is the path the
  // wizard's "Check again" takes — so results probed against the OLD PATH must
  // not survive it. See `_clearDetectionResults`.
  _clearDetectionResults();
  if (!_loginProbeSucceeded) {
    log.warn('Could not read the login shell PATH — engine detection can only see the '
      + 'server\'s own PATH, so an installed engine may be reported as missing', {
      shell,
      howToInvestigate: 'Run `' + shell + ' -lic \'echo $PATH\'` yourself. A shell that '
        + 'blocks on a prompt, or a profile that fails, produces this.'
    });
  }
  return { path: _loginPathCache, probed: _loginProbeSucceeded };
}

/**
 * Did a login shell actually answer for the PATH detection is using?
 *
 * False means detection looked only where launchd can see, so a "not installed"
 * result is a guess rather than a finding.
 * @returns {boolean}
 */
function detectionWasProbed() {
  return _loginProbeSucceeded;
}

/**
 * Has a login-PATH probe been attempted since the cache was last cleared?
 *
 * Distinct from `detectionWasProbed`, which asks whether one SUCCEEDED. A
 * caller deciding "should I probe before answering?" wants this one: keyed on
 * success it would re-probe on every request for exactly the operators whose
 * shell cannot answer.
 * @returns {boolean}
 */
function detectionProbeAttempted() {
  return _loginProbeAttempted;
}

/**
 * Forget the resolved login PATH so the next probe re-reads it.
 * @returns {void}
 */
function resetDetectionCache() {
  _loginPathCache = null;
  _loginProbeSucceeded = false;
  _loginProbeAttempted = false;
  _clearDetectionResults();
}

// An engine profile's detection target is a command NAME, and it is interpolated
// into a shell command below. Profiles are operator-authored and can be added
// through the API, so the shape is enforced rather than trusted: anything with a
// space, quote, slash or shell metacharacter is not a command name.
const DETECTION_TARGET_RE = /^[A-Za-z0-9._-]+$/;

/**
 * How long a detection result stands before the target is probed again.
 *
 * Detection used to run once per project per poll: enriching a fleet asked
 * `command -v claude` separately for every project using Claude, on the event
 * loop, ten seconds apart, forever. The answer is a property of the MACHINE, not
 * of the project asking.
 *
 * 60s rather than "until something clears it". A permanent cache is cheaper and
 * would be correct for a machine nobody touches, but it makes an engine the
 * operator installs mid-session invisible until they either restart the server
 * or find the wizard's "Check again" button — and the operator most likely to
 * have just installed one is the operator least likely to know that button
 * exists. A minute bounds the staleness a person would notice while still
 * collapsing six polls into one probe.
 */
const DETECTION_TTL_MS = 60000;

/** Longest a single availability probe may run before it is killed. */
const DETECTION_PROBE_TIMEOUT_MS = 2000;

// Settled detection results, keyed on WHAT was probed rather than on which
// engine asked: two profiles pointing at the same binary are one question, and
// keying on the engine id would probe once per profile to learn the same fact.
const _detectionResults = new Map();
// Probes currently running, so concurrent askers share one. Enrichment runs
// under `Promise.all`, so without this a cold cache still spawns once per
// project — the exact multiplication the cache exists to remove, hidden behind a
// cache that looks like it works when called sequentially.
const _detectionInflight = new Map();

/**
 * The cache key for one detection question.
 * @param {string} strategy - Detection strategy (`which` / `path`).
 * @param {string} target - Command name or filesystem path probed.
 * @returns {string}
 */
function _detectionKey(strategy, target) {
  return `${strategy} ${target}`;
}

/**
 * A detection result still within its TTL, or null.
 * @param {string} key - Cache key from `_detectionKey`.
 * @returns {{ available: boolean, path: string|null }|null}
 */
function _cachedDetection(key) {
  const hit = _detectionResults.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= DETECTION_TTL_MS) {
    _detectionResults.delete(key);
    return null;
  }
  return hit.result;
}

// Bumped every time the cache is dropped, so an answer can be checked against
// the world it was probed in. See `_rememberDetection`.
let _detectionGeneration = 0;

/**
 * Remember a detection result, and return it.
 *
 * Only ever called with an ANSWER. A probe our own timeout killed is not one:
 * it says we could not look, and storing it would publish "not installed" as a
 * finding for the next full minute — for an engine that may well be installed.
 *
 * An answer probed BEFORE the cache was last dropped is not one either, and that
 * is the subtle case: an async probe that started under the old PATH can settle
 * after "Check again" has cleared everything, and would then repopulate the
 * fresh cache with the stale finding the operator pressed the button to be rid
 * of. Clearing a map cannot reach a probe already in flight; the generation can.
 *
 * @param {string} key - Cache key from `_detectionKey`.
 * @param {{ available: boolean, path: string|null }} result - The answer.
 * @param {number} generation - `_detectionGeneration` when the probe STARTED.
 * @returns {{ available: boolean, path: string|null }} The same result, stored
 *   or not. The caller still gets the answer it just probed for — it is only
 *   unfit to be reused by anyone else.
 */
function _rememberDetection(key, result, generation) {
  if (generation !== _detectionGeneration) return result;
  _detectionResults.set(key, { at: Date.now(), result });
  return result;
}

/**
 * Drop every cached detection result.
 *
 * Called both by `resetDetectionCache` and by `refreshDetectionPath`. The second
 * is the load-bearing one: `GET /api/engines?refresh=1` — the wizard's "Check
 * again" — routes through `refreshDetectionPath` and does NOT call
 * `resetDetectionCache`, so hooking only the latter would leave the one button
 * whose entire purpose is "my engine IS installed" answering out of the stale
 * cache that hid it. A newly resolved PATH also changes what is findable, which
 * is the same reason stated a second way.
 *
 * @returns {void}
 */
function _clearDetectionResults() {
  _detectionGeneration += 1;
  _detectionResults.clear();
  _detectionInflight.clear();
}

/**
 * Did the probe process actually run, or did it never start?
 *
 * The difference decides whether "not found" is a finding or a gap, and the two
 * arrive looking almost identical. A shell that ran and exited non-zero reports
 * a NUMERIC exit status — `status` from `execSync`, `code` from `execFile`. A
 * spawn that never happened reports a STRING errno in `code` (`EMFILE`,
 * `EAGAIN`, `ENOMEM`) and no status at all, because there was no process to have
 * one.
 *
 * This matters more here than it looks: this install's known failure mode is
 * process exhaustion (#94/#144/#380 — leaked `tmux attach` children filling the
 * PTY pool). Under it, every spawn fails at once. Treating that as an answer
 * would cache "not installed" for EVERY engine simultaneously, for a full
 * minute, on the machine least able to recover — reporting a resource shortage
 * as a fleet-wide software absence.
 *
 * @param {Error} err - Error thrown by, or handed to, a `child_process` call.
 * @returns {boolean} True when a process ran and exited on its own.
 */
function _probeRan(err) {
  return typeof err.status === 'number' || typeof err.code === 'number';
}

/**
 * Turn one `command -v` outcome into an answer, and decide whether to keep it.
 *
 * Shared by both probe forms so the cache POLICY exists once. The synchronous
 * and asynchronous paths differ only in how they get their result; when the
 * policy lived in both, the two spellings of "is this worth remembering" were
 * free to drift, and the one nobody re-read would be the one that was wrong.
 *
 * @param {string} key - Cache key from `_detectionKey`.
 * @param {number} generation - `_detectionGeneration` when the probe started.
 * @param {Error|null} err - Failure, if the probe failed.
 * @param {string} stdout - Probe output, when it succeeded.
 * @param {object} context - `{ id, target, timeout }`, for the log lines.
 * @returns {{ available: boolean, path: string|null }}
 */
function _settleWhichProbe(key, generation, err, stdout, context) {
  if (!err) {
    const binPath = String(stdout || '').trim();
    return _rememberDetection(key, { available: !!binPath, path: binPath || null }, generation);
  }
  // Our own cap killed it. Said out loud, because a probe that never finishes is
  // invisible otherwise — the sibling `tmux` listing in this same change logs its
  // timeout for the same reason, and #894 is what happens when it does not.
  if (wasTimedOut(err)) {
    log.warn('Engine detection probe timed out — availability not established, not remembered',
      { id: context.id, target: context.target, timeout: context.timeout });
    return { available: false, path: null };
  }
  // The process never started. Not an answer either, and NOT remembered.
  if (!_probeRan(err)) {
    log.warn('Engine detection probe could not be started — availability not established, '
      + 'not remembered', { id: context.id, target: context.target, code: err.code });
    return { available: false, path: null };
  }
  // A shell that ran and exited non-zero: the command is not on the PATH. That
  // IS the answer, and it is worth keeping for the TTL.
  return _rememberDetection(key, { available: false, path: null }, generation);
}

/**
 * Detect engine using `command -v`, on the operator's PATH rather than the
 * server's.
 * @param {string} id - Engine id
 * @param {string} target - Binary name
 * @param {object} [options] - Options.
 * @param {boolean} [options.fresh] - Probe even if a cached answer is in date.
 * @returns {{ id: string, available: boolean, path: string|null }}
 */
function _detectWhich(id, target, options = {}) {
  if (!DETECTION_TARGET_RE.test(String(target || ''))) {
    log.warn('Engine detection target is not a plain command name — refusing to probe it', { id });
    return { id, available: false, path: null };
  }
  const key = _detectionKey('which', target);
  const cached = options.fresh ? null : _cachedDetection(key);
  if (cached) return { id, ...cached };
  const generation = _detectionGeneration;
  const context = { id, target, timeout: DETECTION_PROBE_TIMEOUT_MS };
  try {
    // `command -v` rather than `which`: it is a POSIX shell builtin, so it needs
    // nothing on the PATH it is searching — `which` is itself a binary, and on a
    // PATH that does not contain it the probe fails for the wrong reason.
    const stdout = execSync(`command -v ${target}`, {
      timeout: DETECTION_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      env: { ...process.env, PATH: _detectionPath() },
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return { id, ..._settleWhichProbe(key, generation, null, stdout, context) };
  } catch (err) {
    // `wasTimedOut`, never `err.killed`: `execSync` sets that flag on
    // `spawnSync`'s result and not on the error it throws, which is how three
    // hand-written versions of this check ended up dead (#891, #894).
    return { id, ..._settleWhichProbe(key, generation, err, '', context) };
  }
}

/**
 * `_detectWhich` without blocking the event loop, and shared between callers.
 *
 * Exists for `enrichProject`, which runs this once per project on the route the
 * dashboard polls every ten seconds. Same cache as the synchronous form, so a
 * warm cache answers either with no subprocess and there is only one cache
 * policy to keep right.
 *
 * @param {string} id - Engine id
 * @param {string} target - Binary name
 * @param {object} [options] - Options.
 * @param {boolean} [options.fresh] - Probe even if a cached answer is in date.
 * @param {Function} [options.execFn] - Injected `execFile` (tests).
 * @param {number} [options.timeout] - Milliseconds before the probe is killed.
 * @returns {Promise<{ id: string, available: boolean, path: string|null }>}
 */
async function _detectWhichAsync(id, target, options = {}) {
  if (!DETECTION_TARGET_RE.test(String(target || ''))) {
    log.warn('Engine detection target is not a plain command name — refusing to probe it', { id });
    return { id, available: false, path: null };
  }
  const key = _detectionKey('which', target);
  const cached = options.fresh ? null : _cachedDetection(key);
  if (cached) return { id, ...cached };

  // A fresh ask still joins a probe already running: that probe is looking right
  // now, which is what `fresh` asked for, and starting a second one would spawn
  // a duplicate to learn the same thing a few milliseconds later.
  const running = _detectionInflight.get(key);
  if (running) return { id, ...(await running) };

  const execFn = options.execFn || execFile;
  const generation = _detectionGeneration;
  const timeout = options.timeout || DETECTION_PROBE_TIMEOUT_MS;
  const context = { id, target, timeout };
  const probe = new Promise((resolve) => {
    execFn('/bin/sh', ['-c', `command -v ${target}`], {
      timeout,
      encoding: 'utf8',
      env: { ...process.env, PATH: _detectionPath() }
    }, (err, stdout) => {
      resolve(_settleWhichProbe(key, generation, err, stdout, context));
    });
  });
  _detectionInflight.set(key, probe);
  try {
    return { id, ...(await probe) };
  } finally {
    // Only if it is still OURS. A `_clearDetectionResults()` during the probe
    // empties the map, and the next caller then installs its own promise under
    // the same key — an unconditional delete here would evict that newer probe,
    // leaving a caller awaiting a promise nothing tracks and the one after it
    // spawning a third. Delete what you put there, not whatever is at the key.
    if (_detectionInflight.get(key) === probe) _detectionInflight.delete(key);
  }
}

/**
 * Detect engine by checking if a path exists.
 * @param {string} id - Engine id
 * @param {string} target - File path to check
 * @param {object} [options] - Options.
 * @param {boolean} [options.fresh] - Check now rather than trusting the cache.
 * @returns {{ id: string, available: boolean, path: string|null }}
 */
function _detectPath(id, target, options = {}) {
  const key = _detectionKey('path', target);
  const cached = options.fresh ? null : _cachedDetection(key);
  if (cached) return { id, ...cached };
  const fs = require('node:fs');
  // Still synchronous, and deliberately so. Making it `fs.promises` would not
  // make it safe: an `open()` the kernel never returns from — what a
  // TCC-protected path does on macOS — holds a libuv threadpool slot instead of
  // the event loop, which is a different way to lose the process rather than a
  // fix (#883, #884; only a killable child process bounds that). What actually
  // protects this path is the cache above, which turns a per-project-per-poll
  // call into at most one a minute, plus the fact that no shipped engine profile
  // uses the `path` strategy — all four use `which`.
  const exists = fs.existsSync(target);
  return { id, ..._rememberDetection(key, { available: exists, path: exists ? target : null },
    _detectionGeneration) };
}

/**
 * List all engine profiles with availability status.
 *
 * Profiles carrying `pickerHidden: true` are excluded (#459): connection-backed
 * harnesses like OpenClaw are never a local project's LLM engine — the agent
 * runs in the REMOTE workspace, so offering them as a peer of "Claude Code"
 * in the engine picker misleads (and rendered as "(not installed)" noise,
 * since `detection: null` can never succeed). Access to registered OpenClaw
 * instances lives in the dedicated top-bar panel instead. Per-connection
 * virtual engines (`openclaw:<connId>`, the old `availableAsEngine` append)
 * were removed for the same reason; `getWithAvailability('openclaw:<id>')`
 * still resolves for launch paths.
 *
 * Reads the PATH already resolved by `refreshDetectionPath` — it never probes
 * for it, so this stays cheap enough to call from a request handler. Callers who
 * need a fresh answer await that function first.
 *
 * @param {object} [options] - Options, forwarded to each engine's probe.
 * @param {boolean} [options.fresh] - Probe now rather than trusting the detection
 *   cache. For gates — `engineReadiness` is the caller that needs it, and
 *   `detectEngine` explains why a gate must not remember.
 * @returns {object[]} - Engine profiles enriched with `available` and `detectedPath` fields
 */
function listWithAvailability(options = {}) {
  const profiles = store.engines.list().filter((p) => !p.pickerHidden);
  const detection = detect(options);
  const detectionMap = new Map(detection.map((d) => [d.id, d]));

  return profiles.map((profile) => {
    const det = detectionMap.get(profile.id) || { available: false, path: null };
    return {
      id: profile.id,
      name: profile.name,
      interactionModel: profile.interactionModel,
      available: det.available,
      command: profile.command,
      // How to get it, for an operator who has none. Null on a profile that
      // does not carry one — an operator-added engine is not required to, and
      // an honest "we don't know how you install this" beats a guess.
      install: profile.install || null,
      capabilities: profile.capabilities || {},
      commands: profile.commands || [],
      launchModes: profile.launchModes || null,
      defaultLaunchMode: profile.defaultLaunchMode || null
    };
  });
}

/**
 * Whether an engine is installed, AND whether we could tell.
 *
 * The single source behind the setup gate and the wizard's engine step. One
 * function rather than each spelling out its own test: the last time two
 * surfaces coordinated around one condition here, one kept the old rule and
 * became a door beside the gate (#710).
 *
 * Cheap first, thorough before refusing. The cached PATH answers the common
 * case with no subprocess at all; only a "no" is worth the cost of re-running
 * the operator's shell profile — and a "no" is exactly the answer that must not
 * be stale, because it is the one that stops them.
 *
 * @returns {Promise<{installed: boolean, certain: boolean}>} `certain` is false
 *   when no login shell answered, so detection could not look where engines are
 *   actually installed.
 */
async function engineReadiness() {
  // `fresh`: this is the third gate, and gates do not remember — the same rule
  // the session and Project Master launches follow. The detection cache exists
  // for a poll asking once per project every ten seconds; nothing about that
  // economics applies to a wizard step a person is standing in front of. A
  // remembered "yes" would let the setup gate open for up to a minute after the
  // engine was removed, and a remembered "no" would spend a login-shell probe
  // recovering from an answer it should not have trusted.
  if (listWithAvailability({ fresh: true }).some((e) => e && e.available)) {
    return { installed: true, certain: true };
  }

  // Nothing found — and that is the answer that stops the operator, so it is
  // the one that must not be stale or uninformed. Re-read the login PATH (off
  // the main thread) and look again.
  const probe = await refreshDetectionPath();
  if (listWithAvailability().some((e) => e && e.available)) {
    return { installed: true, certain: true };
  }

  // Still nothing — but if no shell answered, we did not look where engines
  // actually get installed, we only looked where launchd can see. That is not
  // "no engine installed", and #346 is a standing report of precisely this
  // wrong answer on an ordinary machine.
  //
  // Reported as UNCERTAIN rather than silently decided either way. Answering
  // "installed" here would drop a stated requirement; answering "not installed"
  // would wall an operator into a wizard whose Check again button keeps saying
  // no because the check is broken, not the machine. The caller — the wizard —
  // is the only place that can put that choice in front of the person who knows
  // the truth.
  if (!probe.probed) {
    log.warn('Cannot confirm whether an engine is installed: the login shell PATH could not be '
      + 'read, so detection saw only the PATH launchd gives this service', {
      howToInvestigate: 'Run `$SHELL -lic \'echo $PATH\'` as this user. A shell that blocks on '
        + 'a prompt, or a profile that fails, produces this.'
    });
    return { installed: false, certain: false };
  }
  return { installed: false, certain: true };
}

/**
 * Is at least one engine installed, as far as anyone can tell?
 *
 * The gate's own predicate. Uncertainty counts as installed HERE — the server
 * refuses only what it is sure about, because the alternative is refusing an
 * operator whose engine is present and whose shell merely would not answer. The
 * wizard shows the uncertainty and lets them decide; see `engineReadiness`.
 *
 * @returns {Promise<boolean>}
 */
async function anyEngineInstalled() {
  const readiness = await engineReadiness();
  return readiness.installed || !readiness.certain;
}

/**
 * Resolve the engine to use when nothing more specific was chosen — the single
 * answer behind every "default engine" fallback (new projects, the Project
 * Master session, setup-wizard attachment).
 *
 * Precedence:
 *   1. `config.defaultEngine`, if that engine is actually installed.
 *   2. `config.defaultEngine` unchanged when it names no known engine profile at
 *      all — an unrecognized id is a misconfiguration, not an availability
 *      problem, so it is handed back for the caller to reject by name. Quietly
 *      substituting an installed engine would hide a typo in the config file.
 *   3. The first installed engine, when the configured one is a real profile that
 *      simply isn't installed here. This is the case #707 exists for.
 *   4. `null` when nothing is installed — the caller must surface that, not
 *      substitute a guess.
 *
 * A hardcoded `'claude'` fallback was the previous answer at every call site,
 * which on a machine without Claude Code produced a configured default naming a
 * binary that does not exist. The Project Master then refused to launch
 * (`Engine "claude" not available (binary not found)`) and new projects were
 * created pointing at the same missing engine — surfacing much later than the
 * choice that caused it.
 *
 * Returning `null` rather than a guess is deliberate: with no engine installed
 * there is no correct answer, and inventing one moves the failure away from its
 * cause. Callers that must name something should report the empty case.
 *
 * @param {object} config - Global config (`store.config.load()`).
 * @param {object[]} [engineList] - Pre-resolved `listWithAvailability()` output;
 *   pass to avoid re-running binary detection when the caller already has it.
 * @returns {string|null} Engine id, or null when no engine is installed.
 */
function resolveDefaultEngine(config, engineList) {
  const list = Array.isArray(engineList) ? engineList : _internal.listWithAvailability();
  const available = list.filter((e) => e && e.available);
  const configured = config && config.defaultEngine;
  if (configured) {
    if (available.some((e) => e.id === configured)) return configured;
    // Unknown id → pass through so the caller can name it in the error.
    if (!list.some((e) => e && e.id === configured)) return configured;
  }
  // Sorted by id, not left in `listWithAvailability()` order — that order comes
  // from `readdirSync` over the engine-profile directory, so "the first
  // installed engine" would be filesystem-dependent: the same machine could
  // pick a different engine after a profile file is added, removed, or the
  // directory is recreated by a reinstall. An arbitrary-but-stable choice is
  // fine here; an arbitrary-and-shifting one is not, because this value gets
  // persisted onto projects.
  const picked = available.map((e) => e.id).sort()[0];
  if (picked === undefined) return null;
  if (configured && picked !== configured) {
    // The substitution is the whole point of #707, but it is invisible at every
    // call site — a project quietly recorded against an engine the operator
    // never chose. Say it once, where it is decided.
    log.info('Configured default engine is not installed — falling back', {
      configured, picked, installed: available.map((e) => e.id).sort().join(',')
    });
  }
  return picked;
}

/**
 * Whether an engine will actually honor a launch mode.
 *
 * "Honored" means the profile declares the key as its own AND has not disabled
 * it. `hasOwnProperty` rather than a bare index because the mode string reaches
 * here from request bodies and stored config: `constructor`, `__proto__`, and
 * `toString` all resolve to truthy prototype members, which a naive lookup
 * treats as a valid mode — it then appends no args and reports no problem,
 * which is exactly the silent mismatch this predicate exists to detect.
 *
 * One definition on purpose. Session launch, launch-command assembly, and
 * project reconciliation each answer this question, and they had drifted into
 * three predicates — two checking `disabled`, one not — so the same mode could
 * be honored by one caller and stranded by another.
 *
 * One definition *server-side*. The browser asks the same question — the launch
 * picker, the gate that opens it, the settings modal's default-mode dropdown
 * and the create flow's Launch Posture — and cannot reach this file: `public/`
 * is plain scripts and there is no build step. That copy is
 * `tcHonoredLaunchModes` in `public/api-helper.js`. Changing the rule here
 * without changing it there ships a browser that offers a mode this predicate
 * refuses; `test/launch-mode-picker.test.js` asserts the two agree over every
 * bundled profile, so the drift fails rather than shipping.
 *
 * @param {object|null} engineProfile - Engine profile
 * @param {string} mode - Launch mode key
 * @returns {boolean}
 */
function honorsLaunchMode(engineProfile, mode) {
  if (typeof mode !== 'string' || !mode) return false;
  const modes = engineProfile && engineProfile.launchModes;
  return Boolean(
    modes
    && Object.prototype.hasOwnProperty.call(modes, mode)
    && modes[mode]
    && modes[mode].disabled !== true
  );
}

/**
 * What a project's `silentPrime` setting means on THIS engine (#741).
 *
 * `'on'` / `'off'` are the operator's choice on an engine that can honor it.
 * `'not-applicable'` is an engine without `capabilities.supportsSilentPrime`:
 * the setting is neither honored nor offered there. The settings modal renders
 * the row inert with the reason rather than hiding it, and how loudly the
 * launch path records the drop is `settingDisposition`'s to decide — see its
 * docblock for the provenance rule, which is stated there once.
 *
 * One definition on purpose: the launch path, the settings modal and the
 * delivery ledger all answer this question, and a predicate restated at each
 * site is how one of them ends up warning about a default (Train 11 car 6,
 * Critic R-5). The gate itself now lives in `settingDisposition`, which this
 * calls — the tri-state answer is this function's own, but "can this engine
 * honor it, and what do we tell the operator" is asked of every
 * engine-conditional setting and has one owner.
 *
 * @param {object|null} projConfig - The project's config (defaults merged).
 * @param {object|null} engineProfile - Engine profile.
 * @returns {'on'|'off'|'not-applicable'}
 */
function silentPrimeDisposition(projConfig, engineProfile) {
  if (!settingDisposition('silentPrime', projConfig, engineProfile).applies) return 'not-applicable';
  return projConfig && projConfig.silentPrime === true ? 'on' : 'off';
}

/**
 * The launch mode an engine will actually keep — the requested mode when it is
 * honored, otherwise `'default'`, the universally-valid warning-free mode every
 * engine defines.
 * @param {string} mode - Requested or stored mode
 * @param {object|null} engineProfile - Engine whose modes gate validity
 * @returns {string}
 */
function reconcileLaunchMode(mode, engineProfile) {
  if (mode === 'default') return 'default';
  return honorsLaunchMode(engineProfile, mode) ? mode : 'default';
}

/**
 * The settings whose effect depends on the project's engine, and how each one
 * answers "does this apply here, and if not, why".
 *
 * ADR 0013 binds: a setting TangleClaw offers must take effect, or say — in
 * words the operator reads, where it is offered — that it does not apply and
 * why. Each entry declares the gate, the sentence, and the profile fact behind
 * the sentence, so a call site renders a reason rather than composing one.
 *
 * `applies` is expressed in terms of the existing predicates, never a restated
 * copy of them. `honorsLaunchMode` still owns "will this engine run that mode"
 * because the launch picker asks it about a mode nobody has stored, which is a
 * different question from the one this table answers.
 *
 * `reason` is operator-facing and reaches the settings modal, so it is also
 * restated in `public/api-helper.js` (`tcSettingDisposition`) — `public/` runs
 * in a browser and cannot require this file. A reason that drifts tells the
 * operator something the server does not believe, so
 * `test/setting-disposition.test.js` asserts the two agree over every bundled
 * profile. `evidence` names the profile field instead and is for the log.
 */
const ENGINE_CONDITIONAL_SETTINGS = {
  silentPrime: {
    shippedDefault: () => DEFAULT_PROJECT_CONFIG.silentPrime,
    applies: (value, engineProfile) => Boolean(
      engineProfile && engineProfile.capabilities
      && engineProfile.capabilities.supportsSilentPrime === true
    ),
    reason: (value, engineProfile) =>
      `${engineDisplayName(engineProfile)} does not deliver a hidden prime, so this setting has no effect on this project.`,
    evidence: () => 'capabilities.supportsSilentPrime is not true'
  },
  evalAuditMode: {
    read: (projConfig) => (projConfig && projConfig.evalAuditMode
      ? projConfig.evalAuditMode.enabled
      : undefined),
    shippedDefault: () => DEFAULT_PROJECT_CONFIG.evalAuditMode.enabled,
    // Scores reach a project through `POST /api/audit/ingest`, which
    // authenticates a bearer token against `openclaw_connections.auditSecret`
    // and resolves the project as the one whose engine is `openclaw:<conn.id>`.
    // That is the only write path into `evalExchanges`, and every score,
    // anomaly and incident is downstream of an exchange — so on any other
    // engine the setting stores a value no row can ever follow. C1's design
    // called this universal from "the route is server-side"; the route is, the
    // feed is not.
    applies: (value, engineProfile) => Boolean(engineProfile
      && typeof engineProfile.id === 'string'
      && engineProfile.id.startsWith('openclaw:')),
    reason: (value, engineProfile) =>
      `${engineDisplayName(engineProfile)} does not feed Eval Audit — scored exchanges arrive over an OpenClaw connection bound to this project, so nothing would be scored here.`,
    evidence: () => 'audit ingestion authenticates an OpenClaw connection and resolves the project by openclaw:<connectionId>'
  },
  defaultLaunchMode: {
    shippedDefault: () => DEFAULT_PROJECT_CONFIG.defaultLaunchMode,
    // `'default'` is the absence of a mode, not a mode an engine must declare:
    // it adds no CLI args downstream, and `reconcileLaunchMode` short-circuits
    // it for the same reason. Asking `honorsLaunchMode` about it would let a
    // profile that declares no modes produce "does not offer the launch mode
    // "default", so this project launches in its engine default instead" — a
    // sentence that contradicts itself in front of the operator.
    applies: (value, engineProfile) => value === 'default'
      || honorsLaunchMode(engineProfile, value),
    reason: (value, engineProfile) => {
      const name = engineDisplayName(engineProfile);
      const mode = typeof value === 'string' && value ? `"${value}"` : 'that launch mode';
      return _modeDisabledHere(engineProfile, value)
        ? `${name} has disabled the launch mode ${mode}, so this project launches in its engine default instead.`
        : `${name} does not offer the launch mode ${mode}, so this project launches in its engine default instead.`;
    },
    evidence: (value, engineProfile) => _modeDisabledHere(engineProfile, value)
      ? 'mode is disabled'
      : 'engine does not define this mode'
  }
};

/**
 * Whether a profile declares a launch-mode key and has switched it off — the
 * difference between "disabled here" and "never offered here", which is the
 * whole content of the reason the operator reads.
 *
 * A key present but holding nothing usable (`null`, a bare `true`) is not
 * "disabled": nothing was ever offered to disable, and telling the operator
 * their engine turned a mode off would send them looking for a switch that
 * does not exist.
 * @param {object|null} engineProfile - Engine profile.
 * @param {*} mode - Launch mode key.
 * @returns {boolean}
 */
function _modeDisabledHere(engineProfile, mode) {
  const modes = engineProfile && engineProfile.launchModes;
  return Boolean(modes && typeof mode === 'string'
    && Object.prototype.hasOwnProperty.call(modes, mode)
    && modes[mode] && modes[mode].disabled === true);
}

/**
 * How an engine is named to the operator. The profile's own `name` where it has
 * one, so the modal says "Codex" rather than "codex".
 * @param {object|null} engineProfile - Engine profile.
 * @returns {string}
 */
function engineDisplayName(engineProfile) {
  if (!engineProfile) return 'This engine';
  return engineProfile.name || engineProfile.id || 'This engine';
}

/**
 * Whether one engine-conditional setting applies to a project, and what to say
 * when it does not (ADR 0013).
 *
 * The generic form of `honorsLaunchMode` / `silentPrimeDisposition`. Two was
 * never the rework signal; what makes this a mechanism rather than a third
 * instance is that the norm is retroactive — every setting whose effect is
 * engine-conditional owes a disposition and a rendered reason, and settings
 * built one at a time is how the shape stopped being a shape.
 *
 * **`level` is derived from provenance, not from the setting's importance, and
 * that is the part most likely to be "cleaned up".** A stored value that
 * differs from what the product ships is a choice the operator made, and
 * dropping it loses real intent, so it warns. A value indistinguishable from
 * the shipped default was never set by anyone, so warning about it would fire
 * an alarm on every launch about a preference nobody expressed — that records
 * at info. `silentPrime` ships `true`, so a stored `true` records; a stored
 * `false` is a choice and warns. Deriving the level is why this takes the
 * shipped default as an input: a signature without it forces every call site
 * to pick a level by hand, and the asymmetry then survives only as long as
 * each author remembers it.
 *
 * @param {string} setting - Key in `ENGINE_CONDITIONAL_SETTINGS`.
 * @param {object|null} projConfig - The project's config (defaults merged).
 * @param {object|null} engineProfile - The engine the project runs on.
 * @returns {{setting: string, value: *, applies: boolean, chosen: boolean,
 *   reason: string|null, evidence: string|null, level: 'warn'|'info'|null}}
 *   `reason`, `evidence` and `level` are null when the setting applies.
 */
function settingDisposition(setting, projConfig, engineProfile) {
  const spec = Object.prototype.hasOwnProperty.call(ENGINE_CONDITIONAL_SETTINGS, setting)
    ? ENGINE_CONDITIONAL_SETTINGS[setting]
    : null;
  // A key with no entry is a caller asking about a setting nobody declared a
  // gate for. Answering "it applies" would be the silent no-op this exists to
  // end, so it is a programming error and says so.
  if (!spec) throw new TypeError(`settingDisposition: no engine gate declared for "${setting}"`);

  // `read` where a row's value is not `projConfig[setting]` — `evalAuditMode`
  // holds its flag inside an object of tunables. Scalar comparison is the
  // point: `chosen` asks whether the operator moved a value off what ships, and
  // an object is never `!==`-equal to its own default, so a row must hand back
  // the scalar it actually gates on.
  const stored = spec.read
    ? spec.read(projConfig)
    : (projConfig && Object.prototype.hasOwnProperty.call(projConfig, setting)
      ? projConfig[setting]
      : undefined);
  // An absent key is the shipped default, not a choice: `projectConfig.load`
  // merges defaults in, so a config that reaches here without the key came from
  // a caller holding a partial object, and neither form was set by the operator.
  const chosen = stored !== undefined && stored !== spec.shippedDefault();
  const value = stored === undefined ? spec.shippedDefault() : stored;

  // No profile is not evidence that a capability is absent. Saying "Codex does
  // not deliver a hidden prime" for an engine TangleClaw holds no profile for
  // states a fact nobody read — the same dishonesty this mechanism exists to
  // end, pointed at the engine instead of the setting. Reachable for a
  // connection-backed id and for an engine retired out of the roster.
  if (!engineProfile) {
    return {
      setting,
      value,
      applies: false,
      chosen,
      reason: 'TangleClaw has no profile for this engine, so it cannot say whether this setting applies here.',
      evidence: 'no engine profile',
      level: chosen ? 'warn' : 'info'
    };
  }

  if (spec.applies(value, engineProfile)) {
    return { setting, value, applies: true, chosen, reason: null, evidence: null, level: null };
  }
  return {
    setting,
    value,
    applies: false,
    chosen,
    reason: spec.reason(value, engineProfile),
    evidence: spec.evidence(value, engineProfile),
    level: chosen ? 'warn' : 'info'
  };
}

/**
 * Get a single engine profile with availability.
 * @param {string} id - Engine profile id
 * @returns {object|null}
 */
function getWithAvailability(id) {
  const profile = resolveProfile(id);
  if (!profile) return null;

  // Connection-backed engines are reachable by definition — there is no local
  // binary to probe — so they carry availability without a detection pass.
  if (profile.connectionId) {
    return { ...profile, available: true, detectedPath: null, category: 'OpenClaw' };
  }

  const det = detectEngine(profile);
  return { ...profile, available: det.available, detectedPath: det.path };
}

/**
 * An engine id resolved to its profile — identity and capabilities, with no
 * detection pass.
 *
 * Split out from `getWithAvailability` because a caller that needs to know what
 * an engine CAN DO should not pay a `command -v` to find out, and more
 * importantly because `store.engines.get()` returns null for a virtual
 * `openclaw:<connectionId>` id. Three sites resolved engines three ways —
 * `store.engines.get` (null for a connection-backed project), a synthesized
 * `{ id }` stub (no `name`, no capabilities), and this function — so the same
 * project could be refused by the API in different words from the ones the
 * settings modal renders, and a disposition row that later reads
 * `capabilities` would silently answer from an empty object.
 *
 * @param {string} id - Engine id, plain or `openclaw:<connectionId>`.
 * @returns {object|null} The profile, or null when nothing claims that id.
 */
function resolveProfile(id) {
  if (typeof id !== 'string' || !id) return null;
  if (id.startsWith('openclaw:')) {
    const conn = store.openclawConnections.get(id.slice('openclaw:'.length));
    if (!conn) return null;
    const baseProfile = store.engines.get('openclaw') || {};
    return {
      ...baseProfile,
      id: `openclaw:${conn.id}`,
      name: `${conn.name} (OpenClaw)`,
      connectionId: conn.id
    };
  }
  return store.engines.get(id) || null;
}

/**
 * Validate an engine profile object has required fields.
 * @param {object} profile - Engine profile to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateProfile(profile) {
  const errors = [];
  const required = ['id', 'name', 'command', 'interactionModel', 'configFormat', 'detection'];

  for (const field of required) {
    if (!profile[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (profile.interactionModel && !['session', 'persistent'].includes(profile.interactionModel)) {
    errors.push(`interactionModel must be "session" or "persistent", got "${profile.interactionModel}"`);
  }

  if (profile.configFormat) {
    if (!profile.configFormat.filename) errors.push('configFormat.filename is required');
    if (!profile.configFormat.syntax) errors.push('configFormat.syntax is required');
    if (!profile.configFormat.generator) errors.push('configFormat.generator is required');
  }

  if (profile.detection) {
    if (!profile.detection.strategy) errors.push('detection.strategy is required');
    if (!profile.detection.target) errors.push('detection.target is required');
  }

  if (profile.interactionModel === 'session' && !profile.launch) {
    errors.push('launch is required for session-based engines');
  }

  // Optional `errorPatterns` (#261): the regex must compile and the parser
  // must be a strategy `lib/engine-errors.js` names — a profile JSON selects
  // a parser, it never supplies one.
  errors.push(...engineErrors.validatePatterns(profile.errorPatterns));

  return { valid: errors.length === 0, errors };
}

/**
 * Generate engine-specific config content for a project.
 * Translates the project's rules into the engine's config format.
 * @param {string} engineId - Engine profile id
 * @param {object} projectConfig - Per-project config
 * @param {string} [projectPath] - Absolute project directory. Only used to resolve
 *   the project's NAME for the switchboard section (#904), which is route-scoped;
 *   omitting it drops that section rather than guessing a name from the folder.
 * @returns {string|null} - Generated config content, or null if engine doesn't support config files
 */
function generateConfig(engineId, projectConfig, projectPath) {
  const profile = store.engines.get(engineId);
  if (!profile) {
    log.warn('Engine not found for config generation', { engineId });
    return null;
  }

  if (!profile.capabilities || !profile.capabilities.supportsConfigFile) {
    return null;
  }

  const generator = profile.configFormat.generator;

  switch (generator) {
    case 'claude-md':
      return _generateClaudeMd(projectConfig, projectPath);
    case 'codex-yaml':
      return _generateCodexYaml(projectConfig, projectPath);
    case 'aider-conf':
      return _generateAiderConf(projectConfig, projectPath);
    case 'gemini-md':
      return _generateGeminiMd(projectConfig, `# GEMINI.md — ${GENERATED_HEADER_MARK}`, projectPath);
    case 'antigravity-md':
      // A heading, not a title: this content is spliced into a file whose other
      // sections belong to the operator and to `next dev`, so it starts one
      // level down rather than claiming the document's `#`.
      return _generateGeminiMd(projectConfig, '## TangleClaw — generated; edits inside the markers are overwritten', projectPath);
    default:
      log.warn('Unknown config generator', { engineId, generator });
      return null;
  }
}

/**
 * Get structured rules content for any engine.
 * Returns the text blocks that every engine config should include:
 * core rules, extension rules, global rules, and PortHub guide.
 * @param {object} projectConfig - Per-project config
 * @returns {{ coreRulesLines: string[], extensionRulesLines: string[], porthubGuide: string|null, sharedDocsGuide: string|null, globalRules: string|null, sharedDocsContent: string|null, serverPort: number, serverProtocol: string }}
 */
function _getRulesContent(projectConfig, projectPath) {
  const coreRules = projectConfig.rules && projectConfig.rules.core ? projectConfig.rules.core : {};

  // Core rules
  const coreRulesLines = [];
  if (coreRules.changelogPerChange !== false) coreRulesLines.push('Update CHANGELOG.md with every change');
  if (coreRules.jsdocAllFunctions !== false) coreRulesLines.push('All functions must have JSDoc comments');
  if (coreRules.unitTestRequirements !== false) coreRulesLines.push('Write tests alongside implementation');
  if (coreRules.sessionWrapProtocol !== false) coreRulesLines.push('Follow session wrap protocol before ending');
  if (coreRules.porthubRegistration !== false) coreRulesLines.push('All port assignments go through PortHub');

  // Extension rules
  const extensions = projectConfig.rules && projectConfig.rules.extensions ? projectConfig.rules.extensions : {};
  const activeExtensions = Object.entries(extensions).filter(([, v]) => v === true);
  const extensionRulesLines = activeExtensions.map(([rule]) => _ruleLabel(rule));

  // PortHub guide
  let porthubGuide = null;
  if (coreRules.porthubRegistration !== false) {
    const guidePath = path.join(__dirname, '..', 'data', 'porthub-guide.md');
    try {
      if (fs.existsSync(guidePath)) {
        porthubGuide = fs.readFileSync(guidePath, 'utf8').trim();
      }
    } catch (err) {
      log.warn('Failed to read PortHub guide', { guidePath, error: err.message });
    }
  }

  // Shared docs guide
  let sharedDocsGuide = null;
  {
    const guidePath = path.join(__dirname, '..', 'data', 'shared-docs-guide.md');
    try {
      if (fs.existsSync(guidePath)) {
        sharedDocsGuide = fs.readFileSync(guidePath, 'utf8').trim();
      }
    } catch (err) {
      log.warn('Failed to read shared docs guide', { guidePath, error: err.message });
    }
  }

  // Session memory guide
  let sessionMemoryGuide = null;
  {
    const guidePath = path.join(__dirname, '..', 'data', 'session-memory-guide.md');
    try {
      if (fs.existsSync(guidePath)) {
        sessionMemoryGuide = fs.readFileSync(guidePath, 'utf8').trim();
      }
    } catch (err) {
      log.warn('Failed to read session memory guide', { guidePath, error: err.message });
    }
  }

  // Global rules
  let globalRules = null;
  try {
    const content = store.globalRules.load();
    if (content && content.trim()) {
      globalRules = content.trim();
    }
  } catch (err) {
    log.warn('Failed to load global rules', { error: err.message });
  }

  // NOTE (#595): per-project session rules are deliberately NOT assembled here
  // any more. Config generation used to be skipped wholesale for plugin-governed
  // projects, so this path delivered the rules tier to nothing on every
  // governed project. Startup rules now ship in the session prime instead —
  // `sessions.buildStartupRulesSection` — which runs per-engine at launch and
  // is not gated on file ownership. #1021 later narrowed the governed skip to
  // an OPERATIONAL block, but rules stay out of it on purpose: do not re-add
  // injection here — two delivery paths for one tier is what made the broken
  // one invisible.

  // Shared documents (via group membership)
  let sharedDocsContent = null;
  if (projectConfig.id) {
    try {
      const injectableDocs = store.sharedDocs.getInjectableForProject(projectConfig.id);
      if (injectableDocs.length > 0) {
        sharedDocsContent = _buildSharedDocsSection(injectableDocs);
      }
    } catch (err) {
      log.warn('Failed to load shared docs for config injection', { error: err.message });
    }
  }

  const config = store.config.load();
  // Both halves of the injected base URL must match what the server actually
  // serves, not what config intends: the plist's TANGLECLAW_PORT overrides
  // config.serverPort, and caddy mode / no-cert installs bind plain HTTP even
  // with httpsEnabled (ENG-5R2W).
  const serverPort = effectiveServerPort(config);
  const serverProtocol = effectiveServerProtocol(config);

  // AUTH-4b — when the M2M service-token gate is on, the PortHub + shared-docs
  // surfaces require a bearer token; surface the raw token so the config
  // generators can inject the required Authorization header (see
  // _serviceTokenAuthLines). When off, leave it null → nothing is injected →
  // the generated config is byte-for-byte what it was before AUTH-4 (the
  // reversibility contract).
  const serviceTokenEnabled = !!config.serviceTokenEnabled;
  const serviceToken = serviceTokenEnabled ? (config.serviceToken || null) : null;

  // Switchboard facts (#904). Only told to a project that has actually opted in
  // (#820 made the same flag gate the UI surface) — teaching a session to use a
  // channel its project has turned off is an instruction it cannot follow.
  // The name comes from the STORE rather than the directory basename: a project
  // may be named differently from its folder, and the routes are name-scoped, so
  // guessing would hand the session a 404 it has no way to diagnose.
  const medusaEnabled = projectConfig.medusaEnabled === true;
  let medusaProjectName = null;
  if (medusaEnabled && projectPath) {
    try {
      const row = store.projects.getByPath(projectPath);
      medusaProjectName = row ? row.name : null;
    } catch (err) {
      log.warn('Could not resolve the project name for the switchboard guide', { projectPath, error: err.message });
    }
  }
  return { coreRulesLines, extensionRulesLines, porthubGuide, sharedDocsGuide, sessionMemoryGuide, globalRules, sharedDocsContent, serverPort, serverProtocol, serviceTokenEnabled, serviceToken, medusaEnabled, medusaProjectName };
}

/**
 * Build the service-token Authentication block injected after the API base URL
 * when the M2M gate is enabled (AUTH-4b). Returns `[]` when the gate is off or no
 * token is set, so the surrounding config is unchanged. The token applies to the
 * PortHub (`/api/ports*`) and shared-docs (`/api/shared-docs*`) surfaces.
 *
 * @param {{serviceTokenEnabled: boolean, serviceToken: string|null,
 *   serverProtocol: string, serverPort: number}} rules - The committed-carrier
 *   branch also reads `serverProtocol`/`serverPort` to build the fetch pointer.
 * @param {'md'|'comment'} [format='md'] - `md` for markdown configs (CLAUDE.md,
 *   Gemini, Codex YAML block scalar); `comment` for `#`-prefixed configs (aider).
 * @param {{committedCarrier?: boolean}} [options] - When the target file is tracked
 *   in git, emit a fetch pointer instead of the live token.
 * @returns {string[]} Lines to push into the config (no trailing blank for `comment`).
 */
function _serviceTokenAuthLines(rules, format = 'md', options = {}) {
  if (!rules || !rules.serviceTokenEnabled || !rules.serviceToken) return [];

  // A carrier the operator COMMITS must never receive the live token. The
  // engine config used to be a gitignored, engine-private file; `AGENTS.md` is
  // a shared convention that every project here tracks in git, so inlining the
  // bearer would publish it to the repo — and to anywhere that repo is pushed.
  // Name where to fetch it instead: a pointer costs one call, a committed
  // secret costs a rotation.
  if (options.committedCarrier) {
    const lead = format === 'comment' ? '# ' : '';
    return [
      `${lead}**TangleClaw API authentication**: PortHub (\`/api/ports*\`) and shared-docs `
        + '(`/api/shared-docs*`) require a bearer token when the M2M gate (AUTH-4) is on.',
      `${lead}The token is deliberately NOT written here — this file is tracked in git. `
        + `Fetch it from \`${rules.serverProtocol}://localhost:${rules.serverPort}/api/service-token\` `
        + 'and send it as `Authorization: Bearer <token>`.',
      ''
    ];
  }

  if (format === 'comment') {
    return [
      '#',
      '# API authentication: PortHub (/api/ports*) and shared-docs (/api/shared-docs*)',
      '# require a bearer token. Send this header on every request:',
      `#   Authorization: Bearer ${rules.serviceToken}`
    ];
  }
  return [
    '**TangleClaw API authentication**: PortHub (`/api/ports*`) and shared-docs '
      + '(`/api/shared-docs*`) require a bearer token. Send this header on every request:',
    '',
    `\`Authorization: Bearer ${rules.serviceToken}\``,
    ''
  ];
}

/**
 * The Medusa switchboard section for a generated engine config (#904).
 *
 * Sessions are expected to message each other through the switchboard and
 * nothing at startup told them it exists — PortHub gets ~30 lines with runnable
 * examples in this same file and Medusa got none, so a real, documented
 * capability was unreachable in practice. Teaching it session-to-session does
 * not persist and does not reach the next session; the generated config does.
 *
 * Built once and rendered per format for the same reason `_serviceTokenAuthLines`
 * is: four generators emit this file and a section added to one of them is an
 * engine-specific capability, which this project does not ship.
 *
 * States the base URL outright rather than pointing at a guide (#1020): the
 * guide it used to point at never carried one, and for a plugin-governed project
 * TangleClaw does not write that guide at all — so the pointer dangled and the
 * session's only option was to guess the port.
 *
 * @param {object} rules - The rules content bundle from `_getRulesContent`.
 * @param {'md'|'comment'} [format='md'] - `md` for markdown configs; `comment` for aider.
 * @returns {string[]} Lines to push into the config (empty when not opted in).
 */
function _medusaSwitchboardLines(rules, format = 'md') {
  if (!rules || !rules.medusaEnabled || !rules.medusaProjectName) return [];
  const base = `${rules.serverProtocol}://localhost:${rules.serverPort}`;
  const api = `${base}/api/sessions/${encodeURIComponent(rules.medusaProjectName)}/medusa`;

  if (format === 'comment') {
    return [
      '#',
      '# Medusa Switchboard: you can exchange messages with other TangleClaw',
      '# sessions. TangleClaw runs your listener — do NOT open your own.',
      '# Context, not a task: participate when a message arrives or when asked.',
      `#   inbox     GET  ${api}/messages`,
      `#   handled   POST ${api}/read           {"ids": ["<id>", ...]}`,
      `#   send      POST ${api}/send           {"to": "<workspace-id>", "message": "..."} (initiate or respond)`,
      `#   peers     GET  ${api}/roster`,
      '# The INITIATOR closes an exchange, so a message you do not answer',
      '# leaves the sender blocked.'
    ];
  }
  return [
    '## Medusa Switchboard',
    '',
    'You can exchange messages with other TangleClaw sessions. TangleClaw already '
      + 'runs your WebSocket listener — do NOT register your own for this workspace '
      + '(two consumers on one id fight over the queue).',
    '',
    '**This is context, not a task.** Do not check the inbox or explore the '
      + 'switchboard unprompted — participate when a message actually arrives '
      + '(TangleClaw nudges you), or when the operator asks.',
    '',
    '| | |',
    '|---|---|',
    `| inbox | \`GET ${api}/messages\` |`,
    `| mark handled | \`POST ${api}/read\` — \`{"ids": ["<id>", ...]}\`; they leave the inbox |`,
    `| send (initiate or respond) | \`POST ${api}/send\` — \`{"to": "<workspace-id>", "message": "..."}\` |`,
    `| peers | \`GET ${api}/roster\` |`,
    '',
    '**The initiator closes an exchange**, so a message you do not answer leaves '
      + 'the sender blocked. Reply over the same channel rather than printing into '
      + 'your own pane — the sender cannot see your pane.',
    ''
  ];
}

/**
 * Generate CLAUDE.md content for Claude Code.
 *
 * **⚠ Regeneration is destructive (#240).** This function is the sole
 * authority for `CLAUDE.md` content. It runs on every session launch
 * (`lib/sessions.js#launchSession`), on engine PATCH
 * (`lib/projects.js#updateProject`), and on startup sync
 * (`lib/projects.js#syncAllProjects`). The resulting file is
 * **overwritten in place** — there is no merge with any on-disk
 * edits. Manual edits to `CLAUDE.md` (or PR-driven raw-file edits
 * via `git`) are silently discarded the next time TC regenerates.
 *
 * To add or change global rules durably:
 *   - Edit via the landing-page gear icon → Global Rules editor
 *   - Or `PUT /api/rules/global` (10 KB body cap)
 *   - Or call `store.globalRules.save(content)` from a node script
 *     (no body-size limit; bypasses the API parser)
 *
 * Both PR-driven approaches land the content in the DB-stored global
 * rules file (`store.globalRules.load() / .save()`), which this
 * function reads via `_getRulesContent`. Bypassing the DB and
 * committing directly to `CLAUDE.md` makes the change visible in
 * `git log` but functionally absent — see #240 for the diagnosis +
 * recovery procedure.
 *
 * The same regeneration pattern applies to `_generateCodexYaml`,
 * `_generateAiderConf`, and `_generateGeminiMd` below.
 *
 * @param {object} projectConfig - Per-project config
 * @param {string} [engineId] - Engine id the config is generated for
 *   (defaults to the builder's canonical engine for direct callers)
 * @returns {string}
 */
function _generateClaudeMd(projectConfig, projectPath) {
  const lines = [`# CLAUDE.md — ${GENERATED_HEADER_MARK}`, ''];
  const rules = _getRulesContent(projectConfig, projectPath);

  // The tc bootstrap line rides every carrier unconditionally — the live
  // probe showed PATH presence alone creates no discovery intent, so the
  // instruction must be in the channel the engine actually reads.
  lines.push(...tcBootstrapLines('md'), '');
  lines.push(...planDocsLine('md'), '');

  // Core rules
  lines.push('## Core Rules (Enforced)', '');
  for (const rule of rules.coreRulesLines) {
    lines.push(`- ${rule}`);
  }
  lines.push('');

  // Extension rules
  if (rules.extensionRulesLines.length > 0) {
    lines.push('## Extension Rules', '');
    for (const rule of rules.extensionRulesLines) {
      lines.push(`- ${rule}`);
    }
    lines.push('');
  }

  // Global rules
  if (rules.globalRules) {
    lines.push(rules.globalRules, '');
  }

  // PortHub guide
  if (rules.porthubGuide) {
    lines.push(rules.porthubGuide, '');
    lines.push(`**TangleClaw API base URL**: \`${rules.serverProtocol}://localhost:${rules.serverPort}\``, '');
    for (const authLine of _serviceTokenAuthLines(rules)) lines.push(authLine);
    for (const line of _medusaSwitchboardLines(rules)) lines.push(line);
  }

  // Shared documents
  if (rules.sharedDocsContent) {
    lines.push(rules.sharedDocsContent, '');
  }

  // Shared docs guide
  if (rules.sharedDocsGuide) {
    lines.push(rules.sharedDocsGuide, '');
  }

  // Session memory guide
  if (rules.sessionMemoryGuide) {
    lines.push(rules.sessionMemoryGuide, '');
  }

  return lines.join('\n');
}

/**
 * Build the OPERATIONAL block spliced into a plugin-governed project's
 * CLAUDE.md (#1021). Deliberately carries only how-to-reach-TangleClaw content
 * — the API base URL, the tc bootstrap line, PortHub guide, service-token
 * pointer, switchboard section, shared docs, session-memory guide — and none of the rules tiers:
 * core/extension/global rules are governance, the plugin's side of the line,
 * and this block lands inside a file the plugin owns.
 *
 * The base URL is unconditional: it is the one fact a session cannot cheaply
 * rediscover, and its absence on governed projects is the #1020 dangling
 * pointer. The switchboard and auth helpers already return `[]` when their
 * feature is off, so gating them here would only duplicate their own gates.
 *
 * The header is an H2 on purpose — the H1 belongs to the plugin's anchor
 * document — and the token is never inlined: a governed CLAUDE.md is a
 * committed anchor file by construction, so `committedCarrier: true` emits
 * the fetch pointer (the same decision the AGENTS.md carrier records).
 *
 * @param {object} projectConfig - Per-project config
 * @param {string} projectPath - Absolute project root
 * @returns {string} Markdown body for the managed block
 */
function _generateOperationalBlock(projectConfig, projectPath) {
  const rules = _getRulesContent(projectConfig, projectPath);
  const lines = ['## TangleClaw Operational Guide — generated; edits inside the markers are overwritten', ''];

  lines.push(`**TangleClaw API base URL**: \`${rules.serverProtocol}://localhost:${rules.serverPort}\``, '');
  // Same unconditional footing as the base URL above: how-to-reach content a
  // governed session cannot rediscover, and the carrier its engine reads.
  lines.push(...tcBootstrapLines('md'), '');
  lines.push(...planDocsLine('md'), '');
  for (const authLine of _serviceTokenAuthLines(rules, 'md', { committedCarrier: true })) lines.push(authLine);
  for (const line of _medusaSwitchboardLines(rules)) lines.push(line);

  if (rules.porthubGuide) {
    lines.push(rules.porthubGuide, '');
  }
  if (rules.sharedDocsContent) {
    lines.push(rules.sharedDocsContent, '');
  }
  if (rules.sharedDocsGuide) {
    lines.push(rules.sharedDocsGuide, '');
  }
  if (rules.sessionMemoryGuide) {
    lines.push(rules.sessionMemoryGuide, '');
  }
  return lines.join('\n');
}

/**
 * Generate .codex.yaml content for Codex.
 * Includes full rules in the `instructions` multiline field.
 * @param {object} projectConfig - Per-project config
 * @returns {string}
 */
function _generateCodexYaml(projectConfig, projectPath) {
  const lines = [`# ${GENERATED_HEADER_MARK}`];
  const rules = _getRulesContent(projectConfig, projectPath);

  const extensions = projectConfig.rules && projectConfig.rules.extensions ? projectConfig.rules.extensions : {};
  if (extensions.loggingLevel) {
    lines.push(`logging_level: ${extensions.loggingLevel}`);
  }

  // Build instructions content with all rules
  const instrParts = [];
  // Unconditional tc bootstrap — see _generateClaudeMd for why every carrier
  // ships it.
  instrParts.push(...tcBootstrapLines('md'), '');
  instrParts.push(...planDocsLine('md'), '');
  if (rules.coreRulesLines.length > 0) {
    instrParts.push('## Core Rules (Enforced)');
    for (const rule of rules.coreRulesLines) {
      instrParts.push(`- ${rule}`);
    }
    instrParts.push('');
  }
  if (rules.extensionRulesLines.length > 0) {
    instrParts.push('## Extension Rules');
    for (const rule of rules.extensionRulesLines) {
      instrParts.push(`- ${rule}`);
    }
    instrParts.push('');
  }
  if (rules.globalRules) {
    for (const line of rules.globalRules.split('\n')) {
      instrParts.push(line);
    }
    instrParts.push('');
  }
  if (rules.porthubGuide) {
    // Split multiline guide into individual lines for proper YAML block scalar indentation
    for (const guideLine of rules.porthubGuide.split('\n')) {
      instrParts.push(guideLine);
    }
    instrParts.push('');
    instrParts.push(`**TangleClaw API base URL**: \`${rules.serverProtocol}://localhost:${rules.serverPort}\``);
    instrParts.push('');
    for (const line of _medusaSwitchboardLines(rules)) instrParts.push(line);
    for (const authLine of _serviceTokenAuthLines(rules)) instrParts.push(authLine);
  }
  if (rules.sharedDocsContent) {
    for (const line of rules.sharedDocsContent.split('\n')) {
      instrParts.push(line);
    }
    instrParts.push('');
  }
  if (rules.sharedDocsGuide) {
    for (const line of rules.sharedDocsGuide.split('\n')) {
      instrParts.push(line);
    }
    instrParts.push('');
  }
  if (rules.sessionMemoryGuide) {
    for (const line of rules.sessionMemoryGuide.split('\n')) {
      instrParts.push(line);
    }
    instrParts.push('');
  }
  if (instrParts.length > 0) {
    lines.push('instructions: |');
    for (const part of instrParts) {
      lines.push(`  ${part}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate .aider.conf.yml content for Aider.
 * Includes rules as YAML comments and functional config settings.
 * Aider's config format maps to CLI flags and has no `instructions` field,
 * so rules are embedded as comments for human visibility. The prime prompt
 * mechanism handles AI-side injection separately.
 * @param {object} projectConfig - Per-project config
 * @returns {string}
 */
function _generateAiderConf(projectConfig, projectPath) {
  const rules = _getRulesContent(projectConfig, projectPath);

  // Rules as YAML comments (human-readable in config file)
  const lines = [`# ${GENERATED_HEADER_MARK}`];

  // Unconditional tc bootstrap in comment form — see _generateClaudeMd for
  // why every carrier ships it.
  lines.push('#');
  lines.push(...tcBootstrapLines('comment'));
  lines.push(...planDocsLine('comment'));

  if (rules.coreRulesLines.length > 0) {
    lines.push('#');
    lines.push('# Core Rules (Enforced):');
    for (const rule of rules.coreRulesLines) {
      lines.push(`#   - ${rule}`);
    }
  }

  if (rules.extensionRulesLines.length > 0) {
    lines.push('#');
    lines.push('# Extension Rules:');
    for (const rule of rules.extensionRulesLines) {
      lines.push(`#   - ${rule}`);
    }
  }

  if (rules.globalRules) {
    lines.push('#');
    lines.push('# Global Rules:');
    for (const line of rules.globalRules.split('\n')) {
      const trimmed = line.replace(/^#+\s*/, '').trim();
      if (trimmed) lines.push(`#   ${trimmed}`);
    }
  }

  if (rules.porthubGuide) {
    lines.push('#');
    lines.push('# PortHub: All port assignments go through TangleClaw.');
    lines.push(`# TangleClaw API: ${rules.serverProtocol}://localhost:${rules.serverPort}`);
    for (const authLine of _serviceTokenAuthLines(rules, 'comment')) lines.push(authLine);
    for (const line of _medusaSwitchboardLines(rules, 'comment')) lines.push(line);
  }

  if (rules.sharedDocsContent) {
    lines.push('#');
    lines.push('# Shared Documents:');
    for (const line of rules.sharedDocsContent.split('\n')) {
      const trimmed = line.replace(/^#+\s*/, '').trim();
      if (trimmed) lines.push(`#   ${trimmed}`);
    }
  }

  if (rules.sharedDocsGuide) {
    lines.push('#');
    lines.push('# Shared Docs Guide:');
    for (const line of rules.sharedDocsGuide.split('\n')) {
      const trimmed = line.replace(/^#+\s*/, '').trim();
      if (trimmed) lines.push(`#   ${trimmed}`);
    }
  }

  if (rules.sessionMemoryGuide) {
    lines.push('#');
    lines.push('# Session Memory:');
    for (const line of rules.sessionMemoryGuide.split('\n')) {
      const trimmed = line.replace(/^#+\s*/, '').trim();
      if (trimmed) lines.push(`#   ${trimmed}`);
    }
  }



  lines.push('');

  // Functional config settings
  const extensions = projectConfig.rules && projectConfig.rules.extensions ? projectConfig.rules.extensions : {};
  if (extensions.loggingLevel) {
    lines.push(`verbose: ${extensions.loggingLevel === 'debug'}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate GEMINI.md content for Gemini CLI (and, via the `header` param, the
 * Antigravity block — the body format is identical markdown).
 * Nearly identical to CLAUDE.md — markdown format with rules and the PortHub guide.
 * For Antigravity this is spliced into the project's `AGENTS.md` as a managed
 * block; Antigravity discovers `GEMINI.md` / `AGENTS.md` only, so the
 * `.antigravity.md` this used to be written to was never read by anything.
 * @param {object} projectConfig - Per-project config
 * @param {string} [header] - First heading line of the generated file
 * @returns {string}
 */
function _generateGeminiMd(projectConfig, header = `# GEMINI.md — ${GENERATED_HEADER_MARK}`, projectPath) {
  const lines = [header, ''];
  const rules = _getRulesContent(projectConfig, projectPath);

  // Unconditional tc bootstrap — see _generateClaudeMd for why every carrier
  // ships it.
  lines.push(...tcBootstrapLines('md'), '');
  lines.push(...planDocsLine('md'), '');

  // Core rules
  lines.push('## Core Rules (Enforced)', '');
  for (const rule of rules.coreRulesLines) {
    lines.push(`- ${rule}`);
  }
  lines.push('');

  // Extension rules
  if (rules.extensionRulesLines.length > 0) {
    lines.push('## Extension Rules', '');
    for (const rule of rules.extensionRulesLines) {
      lines.push(`- ${rule}`);
    }
    lines.push('');
  }

  // Global rules
  if (rules.globalRules) {
    lines.push(rules.globalRules, '');
  }

  // PortHub guide
  if (rules.porthubGuide) {
    lines.push(rules.porthubGuide, '');
    lines.push(`**TangleClaw API base URL**: \`${rules.serverProtocol}://localhost:${rules.serverPort}\``, '');
    for (const authLine of _serviceTokenAuthLines(rules, 'md', { committedCarrier: true })) lines.push(authLine);
    for (const line of _medusaSwitchboardLines(rules)) lines.push(line);
  }

  // Shared documents
  if (rules.sharedDocsContent) {
    lines.push(rules.sharedDocsContent, '');
  }

  // Shared docs guide
  if (rules.sharedDocsGuide) {
    lines.push(rules.sharedDocsGuide, '');
  }

  // Session memory guide
  if (rules.sessionMemoryGuide) {
    lines.push(rules.sessionMemoryGuide, '');
  }

  return lines.join('\n');
}

/**
 * Build a shared documents section for engine config injection.
 * Groups docs by their group name. For reference mode, lists file paths.
 * For inline mode, reads and embeds file content.
 * Adds lock warnings for locked documents.
 *
 * The generated config is committed by managed projects and often pushed to
 * public remotes, so **every rendered path goes through `tildeHomePath`** — the
 * inline error branches included, since a "file not found" warning discloses the
 * path just as completely as a success. The `fs` calls keep the real path.
 *
 * Doc and group **names** are deliberately kept: a doc reaches this section only
 * because its group opted in per-doc via `injectIntoConfig`, and an agent cannot
 * use a doc it cannot name. That is the opposite call from
 * `projects._buildSharedDirsSection`, which withholds them — see
 * `tildeHomePath` in `lib/project-paths.js` for why the two differ.
 *
 * @param {object[]} docs - Injectable shared docs (with groupName field)
 * @returns {string}
 */
function _buildSharedDocsSection(docs) {
  // Group docs by groupName
  const byGroup = new Map();
  for (const doc of docs) {
    const groupName = doc.groupName || 'Unknown Group';
    if (!byGroup.has(groupName)) byGroup.set(groupName, []);
    byGroup.get(groupName).push(doc);
  }

  const lines = ['## Shared Documents', ''];

  for (const [groupName, groupDocs] of byGroup) {
    lines.push(`### ${groupName}`, '');

    for (const doc of groupDocs) {
      // Check lock status
      let lockWarning = '';
      try {
        const lock = store.documentLocks.check(doc.id);
        if (lock) {
          lockWarning = ` ⚠️ LOCKED by ${lock.lockedByProject} (expires ${lock.expiresAt})`;
        }
      } catch {
        // Ignore lock check errors
      }

      if (doc.injectMode === 'inline') {
        // Inline mode: read and embed file content
        lines.push(`**${doc.name}**${doc.description ? ` — ${doc.description}` : ''}${lockWarning}`, '');
        try {
          if (fs.existsSync(doc.filePath)) {
            const content = fs.readFileSync(doc.filePath, 'utf8').trim();
            lines.push('```', content, '```', '');
          } else {
            lines.push(`> ⚠️ File not found: \`${tildeHomePath(doc.filePath)}\``, '');
          }
        } catch (err) {
          lines.push(`> ⚠️ Failed to read: \`${tildeHomePath(doc.filePath)}\` (${err.message})`, '');
        }
      } else {
        // Reference mode: just list file path
        let fileStatus = '';
        try {
          if (!fs.existsSync(doc.filePath)) {
            fileStatus = ' (⚠️ file not found)';
          }
        } catch {
          // Ignore
        }
        lines.push(`- **${doc.name}**: \`${tildeHomePath(doc.filePath)}\`${doc.description ? ` — ${doc.description}` : ''}${fileStatus}${lockWarning}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Convert a rule key to a human-readable label.
 * @param {string} rule - Rule key
 * @returns {string}
 */
function _ruleLabel(rule) {
  const labels = {
    identitySentry: 'Verify identity with sentry checks',
    docsParity: 'Update docs in same commit as code changes',
    decisionFramework: 'Use decision framework before adding code',
    zeroDebtProtocol: 'Zero tech debt protocol',
    independentCritic: 'Independent Critic review after medium+ work',
    adversarialTesting: 'Adversarial stress testing'
  };
  return labels[rule] || rule;
}

/**
 * Validate rule injection parity across all engines with config file support.
 * Generates config for each engine using a full rule set and checks that
 * core rules, PortHub guide, and global rules are present.
 * Callable from tests and the Independent Critic.
 * @returns {{ valid: boolean, engines: { id: string, valid: boolean, errors: string[] }[] }}
 */
function validateParity() {
  const profiles = store.engines.list().filter(p =>
    p.capabilities && p.capabilities.supportsConfigFile
  );

  const projectConfig = {
    rules: {
      core: {
        changelogPerChange: true,
        jsdocAllFunctions: true,
        unitTestRequirements: true,
        sessionWrapProtocol: true,
        porthubRegistration: true
      },
      extensions: { identitySentry: true }
    }
  };

  const results = [];
  let allValid = true;

  for (const profile of profiles) {
    const errors = [];
    const content = generateConfig(profile.id, projectConfig);

    if (content === null) {
      errors.push('generateConfig returned null — generator may be missing or mismatched');
      results.push({ id: profile.id, valid: false, errors });
      allValid = false;
      continue;
    }

    // Core rules check
    if (!content.includes('CHANGELOG') && !content.includes('changelog')) {
      errors.push('Missing CHANGELOG rule');
    }
    if (!content.includes('JSDoc') && !content.includes('jsdoc') && !content.includes('JSdoc')) {
      errors.push('Missing JSDoc rule');
    }
    if (!content.includes('test') && !content.includes('Test')) {
      errors.push('Missing test/unit-test rule');
    }
    if (!content.includes('session wrap') && !content.includes('session') && !content.includes('Session')) {
      errors.push('Missing session wrap protocol rule');
    }

    // PortHub reference check
    if (!content.includes('Port Management') && !content.includes('TangleClaw API') && !content.includes('PortHub')) {
      errors.push('Missing PortHub guide or API reference');
    }

    // Global rules check
    if (!content.includes('Global Rules') && !content.includes('global') && !content.includes('Global')) {
      errors.push('Missing global rules');
    }

    // Shared docs guide check
    if (!content.includes('Shared Documents') && !content.includes('Shared Docs Guide') && !content.includes('shared-docs')) {
      errors.push('Missing shared docs guide');
    }

    const engineValid = errors.length === 0;
    if (!engineValid) allValid = false;
    results.push({ id: profile.id, valid: engineValid, errors });
  }

  return { valid: allValid, engines: results };
}

/**
 * Validate that all engine profiles have the statusPage field defined.
 * Engines with known upstream providers must have adapter and url.
 * Returns parity result with per-engine details.
 * @returns {{ valid: boolean, engines: { id: string, valid: boolean, errors: string[] }[] }}
 */
function validateStatusParity() {
  const profiles = store.engines.list();
  const results = [];
  let allValid = true;

  for (const profile of profiles) {
    const errors = [];

    if (!('statusPage' in profile)) {
      errors.push('Missing statusPage field — must be an object or null');
    } else if (profile.statusPage !== null) {
      if (!profile.statusPage.adapter) {
        errors.push('statusPage.adapter is required');
      }
      if (!profile.statusPage.url) {
        errors.push('statusPage.url is required');
      }
    }

    const valid = errors.length === 0;
    if (!valid) allValid = false;
    results.push({ id: profile.id, valid, errors });
  }

  return { valid: allValid, engines: results };
}

/**
 * Resolve {{TANGLECLAW_DIR}} placeholders in hook command strings.
 * @param {string} str - Command string with placeholders
 * @returns {string}
 */
function _resolveHookPlaceholders(str) {
  const tangleClawDir = path.join(__dirname, '..');
  return str.replace(/\{\{TANGLECLAW_DIR\}\}/g, tangleClawDir);
}

/**
 * Deep-clone a hooks object and resolve all {{TANGLECLAW_DIR}} placeholders.
 * @param {object} hooks - Raw hooks declaration from template
 * @returns {object}
 */
function _resolveHooksObject(hooks) {
  const resolved = JSON.parse(JSON.stringify(hooks));
  for (const eventName of Object.keys(resolved)) {
    const entries = resolved[eventName];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.hooks && Array.isArray(entry.hooks)) {
        for (const hook of entry.hooks) {
          if (hook.command && typeof hook.command === 'string') {
            hook.command = _resolveHookPlaceholders(hook.command);
          }
        }
      }
    }
  }
  return resolved;
}

// Basenames of every hook script TangleClaw emits into a project's
// .claude/settings.json. Ownership is decided by these rather than by the resolved
// install path, so an install the operator has since MOVED still recognises its own
// old entries and reconciles them instead of orphaning a duplicate beside them.
//
// The basename IS the identity, so a MOVE is survivable but a RENAME is not:
// renaming an entry here makes every already-written settings.json entry read as
// operator-authored, and `_mergeBaselineHooks` then preserves the dead path forever
// (#1007). RENAMING ANYTHING IN THIS LIST REQUIRES ADDING THE OLD BASENAME TO
// `TC_LEGACY_HOOK_MARKERS` BELOW — the retirement list is what carries a rename
// across installs that were configured before it.
const TC_HOOK_SCRIPTS = ['sessionstart-prime-claude.sh', 'sessionstart-rules-claude.sh', 'sessionstart-prime-codex.sh', 'sessionstart-rules-codex.sh'];

// Hooks TangleClaw wrote in the PRE-PLUGIN era and is still responsible for
// removing. The V1 methodology layer emitted `python3 "$CLAUDE_PROJECT_DIR/tools/
// product-hook" <phase>` entries; #538/#570 deleted that layer, and a leftover Stop
// entry must be cleared or it fires the retired vendored gate alongside the plugin's.
//
// Scoped to the vendored script by NAME, which is the same marker `governanceState`
// already uses for `governed-vendored` (see `tools/product-hook` below). The old code
// achieved this cleanup by clearing the ENTIRE hooks block, which is what made it
// destroy operator hooks (#752) — an unconditional "drop any Stop hook" rule cannot
// tell a retired gate from a formatter the operator wrote.
//
// The SessionStart pair joined this list when Train 5 (#982) split the scripts per
// engine — `sessionstart-prime.sh` → `sessionstart-prime-claude.sh`, same for rules.
// That rename changed the ownership identity, so 25 already-written entries across 24
// projects went unrecognised and were preserved as foreign on every regen, each firing
// a "No such file or directory" hook error at every session start (#1007). The same
// markers also retire the older orphans still naming a pre-move install path, which
// are unrecognised for both reasons at once.
//
// Each marker carries its `data/hooks/` directory so it cannot substring-match the
// very variants that replaced it: `data/hooks/sessionstart-prime.sh` is not a
// substring of `data/hooks/sessionstart-prime-claude.sh`.
const TC_LEGACY_HOOK_MARKERS = [
  'tools/product-hook',
  'data/hooks/sessionstart-prime.sh',
  'data/hooks/sessionstart-rules.sh'
];

/**
 * Whether a hooks-array entry is one TangleClaw emitted.
 *
 * `.claude/settings.json` is the SHAREABLE, committable hooks location — where the
 * Claude Code docs tell an operator to put a project-wide hook. TangleClaw owns only
 * the entries it writes and must be able to name them exactly, because the
 * alternative (replacing the whole block) silently discarded every hook the operator
 * put there, on every session launch (#752).
 * @param {*} entry - One element of a `hooks[<Event>]` array.
 * @returns {boolean}
 */
function _isTangleClawHookEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => {
    if (!h || typeof h.command !== 'string') return false;
    if (TC_HOOK_SCRIPTS.some((script) => h.command.includes(`data/hooks/${script}`))) return true;
    // Ours historically, and still ours to retire.
    return TC_LEGACY_HOOK_MARKERS.some((marker) => h.command.includes(marker));
  });
}

/**
 * Reconcile TangleClaw's baseline hooks into an existing hooks object.
 *
 * Merges rather than replaces: TangleClaw's own previous entries are dropped and its
 * current ones added, while every foreign event and every foreign entry within a
 * shared event survives verbatim — including shapes this function does not
 * understand, which are passed through untouched rather than normalized away.
 *
 * An event left with no entries is removed, so TangleClaw retiring a hook does not
 * leave an empty array behind; an event that still holds foreign entries is kept even
 * when TangleClaw no longer emits into it.
 * @param {object|undefined} existingHooks - The on-disk `hooks` object, if any.
 * @param {object} baselineHooks - TangleClaw's current emission (already resolved).
 * @returns {{ hooks: object, preservedForeign: number, replacedOwn: number }}
 */
function _mergeBaselineHooks(existingHooks, baselineHooks) {
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const existing = isPlainObject(existingHooks) ? existingHooks : {};
  const merged = {};
  let preservedForeign = 0;
  let replacedOwn = 0;

  for (const [event, entries] of Object.entries(existing)) {
    if (!Array.isArray(entries)) {
      // Not a shape this function models. Preserving it verbatim is strictly safer
      // than dropping something an operator or a future Claude Code version wrote.
      merged[event] = entries;
      continue;
    }
    const foreign = entries.filter((entry) => {
      if (_isTangleClawHookEntry(entry)) { replacedOwn += 1; return false; }
      return true;
    });
    preservedForeign += foreign.length;
    if (foreign.length > 0) merged[event] = foreign;
  }

  for (const [event, entries] of Object.entries(baselineHooks || {})) {
    if (!Array.isArray(entries)) continue;
    merged[event] = Array.isArray(merged[event]) ? merged[event].concat(entries) : entries.slice();
  }

  return { hooks: merged, preservedForeign, replacedOwn };
}

/**
 * Build engine-level baseline hooks based on per-project config and engine
 * capability. syncEngineHooks writes these as the project's hooks block.
 * Currently only emits a SessionStart entry for silent prime delivery (#103)
 * when the project has opted in AND the engine advertises support. Both gates
 * must be true — keeping them symmetric with launchSession's silentPrime
 * derivation prevents an orphaned hook from being written for an engine that
 * cannot actually use it (Critic M1).
 * Rules ride a SEPARATE entry from the prime (#749), one per shard. They are
 * two channels, not two sections of one: the engine enforces its output cap by
 * replacing a payload with a preview rather than shortening it, so anything
 * sharing a channel with a large payload can be dropped whole and silently —
 * which is precisely how operator rules stopped arriving. Separate entries mean
 * the prime's growth and the rule set's growth can no longer harm each other.
 *
 * @param {object} projConfig - Per-project config (loaded by store.projectConfig.load)
 * @param {object|null} [engineProfile] - Engine profile for capability gating; when omitted, no engine-gated entries are emitted
 * @param {number} [ruleShardCount=0] - Number of rule shards to register. The
 *   caller computes it, because this function is reached from a module that
 *   must not require `sessions` (it would close a require cycle).
 * @returns {object} Hooks object shaped like { SessionStart: [ ... ] }
 */
function _buildBaselineHooks(projConfig, engineProfile, ruleShardCount = 0) {
  const hooks = {};
  // The same question the modal and the launch record ask, so the same owner
  // answers it. Spelled by hand here, this site would keep the old rule the day
  // the gate grows a second condition — and the operator would then read a live
  // toggle, a green save, and get no startup hook.
  if (silentPrimeDisposition(projConfig, engineProfile) === 'on') {
    const primeScript = engineProfile && engineProfile.silentPrimeScript ? engineProfile.silentPrimeScript : 'sessionstart-prime-claude.sh';
    const rulesScript = engineProfile && engineProfile.silentRulesScript ? engineProfile.silentRulesScript : 'sessionstart-rules-claude.sh';
    const entries = [
      {
        matcher: 'startup',
        hooks: [
          {
            type: 'command',
            command: `"{{TANGLECLAW_DIR}}/data/hooks/${primeScript}"`,
            statusMessage: 'Loading session prime...'
          }
        ]
      }
    ];
    for (let i = 1; i <= ruleShardCount; i += 1) {
      entries.push({
        matcher: 'startup',
        hooks: [
          {
            type: 'command',
            command: `"{{TANGLECLAW_DIR}}/data/hooks/${rulesScript}" ${i}`,
            statusMessage: ruleShardCount === 1
              ? 'Loading project rules...'
              : `Loading project rules (${i}/${ruleShardCount})...`
          }
        ]
      });
    }
    hooks.SessionStart = entries;
  }
  return hooks;
}

/**
 * Sync Claude Code session hooks in a project's .claude/settings.json. Writes
 * the engine-level baseline hooks (e.g. silent prime per #103). Replaces only
 * the hooks section — preserves permissions and other settings.
 *
 * Non-claude branch is write-active (was a no-op pre-#140): when the project's
 * current engine is not claude, any stale hooks block in .claude/settings.json
 * is deleted to prevent orphan canon. All other settings keys are preserved.
 * Callers (createProject, attachProject, silentPrime PATCH, engine PATCH) all
 * benefit from the cleanup.
 *
 * @param {string} projectPath - Absolute path to the project directory
 */

/**
 * Generate engine config AND write it to disk at the conventional path,
 * with drift detection (#240).
 *
 * Before overwriting, compares the existing on-disk file against the
 * would-be-generated content. When they differ in non-whitespace ways,
 * logs a warning naming the file and byte deltas. This surfaces the
 * silent-clobber bug class where someone (a contributor PR, a manual
 * `vim CLAUDE.md`, an autoformatter) edits the file directly and their
 * edit is about to be overwritten by regeneration. The warning lets the
 * operator notice before the loss; without it, the overwrite is silent.
 *
 * The four pre-existing write sites (`launchSession`, `createProject`,
 * `updateProject` engine-switch) all funnel through
 * this helper so the warning fires uniformly regardless of which code
 * path triggers the regeneration.
 *
 * **Whitespace tolerance.** `.trim()` on both sides ignores trailing-
 * newline differences (auto-formatters, editors). Drift is reported
 * only when there's a real semantic change.
 *
 * **Permissive on read failure.** If the existing file is unreadable
 * (permissions, transient FS error), the helper falls through and
 * overwrites without warning. The write is the operation that matters;
 * the warning is best-effort.
 *
 * @param {string} engineId - Engine identifier (claude / codex / aider / etc.)
 * @param {string} projectPath - Absolute path to the project directory
 * @param {object} projectConfig - Per-project config
 * @param {object} engineProfile - Engine profile (needed for `configFormat.filename`)
 * **Return shape.** Distinguishes three outcomes the caller may need to
 * react to differently:
 *   - `{written: true, ...}` — wrote successfully (with `drifted: true|false`
 *     indicating whether the on-disk version differed first).
 *   - `{written: false, skipped: true, skipReason: '<why>', error: null}` —
 *     deliberate no-op (engine has no config file by design, e.g. `openclaw`;
 *     or `generateConfig` returned empty). Callers should
 *     NOT treat this as an error. Pre-refactor this was a silent
 *     `if (configContent && engineProfile.configFormat)` guard; the
 *     explicit field makes the contract visible.
 *   - `{written: false, skipped: false, error: '<message>'}` — real
 *     write failure (permissions, ENOSPC, etc.), OR a managed-block merge
 *     REFUSED because the existing markers are malformed or the generated body
 *     contains a marker literal, OR an unrecognized `mergeStrategy`. All three
 *     leave the target file byte-identical; callers should surface, because a
 *     refusal means this project now has no generated config at all.
 *
 * `drifted` is scoped to what the strategy owns: the whole file under
 * `whole-file`, the region between the markers under `managed-block`. Content
 * the operator keeps outside the markers is never drift.
 *
 * @returns {{written: boolean, skipped: boolean, skipReason: string|null, drifted: boolean, configFilePath: string|null, error: string|null}}
 */
function writeEngineConfig(engineId, projectPath, projectConfig, engineProfile) {
  // Always declare UI wrap availability for the platform before returning.
  const uiWrapAdvisoryPath = path.join(projectPath, '.tangleclaw', 'ui-wrap-advisory.md');
  const advisoryContent = `**Platform Capability: UI Wrap**
TangleClaw provides a "Session Wrap" UI button. At a chunk-close or stopping place, intelligently decide whether to recommend \`/clear\` or "UI Wrap":
- Recommend **UI Wrap** if the work represents a completed milestone, requires a version bump, needs changelog entries, or needs a continuity record.
- Recommend **\`/clear\`** if you just need to drop context mid-task (e.g., memory is getting full) but aren't ready to run the full wrap protocol.
When signaling the stopping place, explicitly state which one the operator should use and why.`;
  try {
    if (!fs.existsSync(path.join(projectPath, '.tangleclaw'))) {
      fs.mkdirSync(path.join(projectPath, '.tangleclaw'), { recursive: true });
    }
    fs.writeFileSync(uiWrapAdvisoryPath, advisoryContent, 'utf8');
  } catch (err) { /* ignore */ }

  // Defer GOVERNANCE to the Prawduct V2 Claude Code plugin when it governs
  // this project (#330 hybrid, narrowed by #1021). The plugin owns CLAUDE.md's
  // governance content (a PRAWDUCT:ANCHOR file); regenerating the whole file
  // here would destructively clobber it on every launch/boot/PATCH. But the
  // generated file also carried OPERATIONAL content with no other delivery
  // path — the API base URL, PortHub, shared docs, the switchboard, the M2M
  // auth pointer — and the wholesale skip silently cost every governed project
  // that guide (#1021; live symptoms #1020 and #904's reach gap). So the
  // deferral narrows: governance stays the plugin's, and TC splices only its
  // operational block between managed-block markers — CLAUDE.md becomes a
  // co-owned file exactly like AGENTS.md, plugin outside the markers, TC
  // inside them. Detection keys off the committed plugin install reference,
  // which survives TC's own regeneration — see isPluginGoverned.
  //
  // Scoped to the claude-md carrier: the plugin owns nothing in other engines'
  // files, but writing them on governed projects would whole-file-overwrite
  // files TC has never owned there (a hand-authored .codex.yaml would be
  // destroyed) — so those keep the skip as a recorded bounded decision
  // (`.tangleclaw/plans/ambient-awareness.md` Chunk 01b).
  const governed = isPluginGoverned(projectPath);
  if (governed && (!engineProfile || !engineProfile.configFormat
      || engineProfile.configFormat.generator !== 'claude-md')) {
    return { written: false, skipped: true, skipReason: 'project governed by the Prawduct V2 plugin — config generation deferred to the plugin (no operational block for a non-claude-md carrier)', drifted: false, configFilePath: null, error: null };
  }
  // Deliberate no-op: engine has no config file (openclaw).
  // Per #240 PR Critic — silently skip so callers don't surface a
  // spurious "failed to write engine config" error/warning every time
  // a non-Claude/Codex/Aider/Gemini project is created or launched.
  if (!engineProfile || !engineProfile.configFormat || !engineProfile.configFormat.filename) {
    return { written: false, skipped: true, skipReason: 'engine has no config file (configFormat.filename is null)', drifted: false, configFilePath: null, error: null };
  }
  const content = governed
    ? _generateOperationalBlock(projectConfig, projectPath)
    : generateConfig(engineId, projectConfig, projectPath);
  if (!content) {
    return { written: false, skipped: true, skipReason: 'generateConfig returned empty (engine does not support config files for this project shape)', drifted: false, configFilePath: null, error: null };
  }
  const configFilePath = path.join(projectPath, engineProfile.configFormat.filename);

  // Managed-block engines share their config file with another writer, so
  // TangleClaw owns a delimited region instead of the whole file. Declared per
  // profile, because whether a file is shared is a fact about the engine's
  // ecosystem — EXCEPT where the filename itself settles it: a carrier on the
  // shared-convention list is co-owned by definition, and there the declaration
  // is checked rather than trusted. Absent elsewhere, the value is 'whole-file',
  // so every engine that has not opted in keeps byte-identical behavior.
  // Governance settles it the same way the filename does (#1021): a governed
  // CLAUDE.md is co-owned with the plugin by definition, so the strategy is
  // forced to managed-block regardless of what the profile declares —
  // whole-file here IS the clobber the deferral existed to prevent.
  const mergeStrategy = governed ? 'managed-block' : (engineProfile.configFormat.mergeStrategy || 'whole-file');

  // An unrecognized value must not fall through to the destructive default.
  // Operator-added profiles never pass through the bundled-profile guards, so a
  // typo like 'managed_block' would silently select whole-file and overwrite a
  // file the author believed was being spliced.
  if (SHARED_CONVENTION_CARRIERS.includes(engineProfile.configFormat.filename)
      && mergeStrategy !== 'managed-block') {
    // Absent is not unknown: a profile that simply omits the field lands here,
    // which is the destructive default the check below cannot catch.
    log.warn('engine config write refused — shared-convention carrier needs managed-block', { configFilePath, engineId, mergeStrategy });
    return { written: false, skipped: false, skipReason: null, drifted: false, configFilePath, error: `${engineProfile.configFormat.filename} is a shared-convention agent file that other tools and the operator also write; configFormat.mergeStrategy must be 'managed-block' (got '${mergeStrategy}') or TangleClaw would destroy their content` };
  }

  if (mergeStrategy !== 'whole-file' && mergeStrategy !== 'managed-block') {
    log.warn('engine config write refused — unknown mergeStrategy', { configFilePath, engineId, mergeStrategy });
    return { written: false, skipped: false, skipReason: null, drifted: false, configFilePath, error: `unknown configFormat.mergeStrategy '${mergeStrategy}' (expected 'whole-file' or 'managed-block')` };
  }

  if (mergeStrategy === 'managed-block') {
    let existing = '';
    if (fs.existsSync(configFilePath)) {
      try {
        existing = fs.readFileSync(configFilePath, 'utf8');
      } catch (err) {
        return { written: false, skipped: false, skipReason: null, drifted: false, configFilePath, error: `could not read existing config to merge: ${err.message}` };
      }
    }
    const { merged, error } = _mergeManagedBlock(existing, content, engineProfile.configFormat.syntax);
    if (error) {
      // Refusing leaves the operator's file exactly as it was. Surfaced as an
      // error rather than a skip: a skip reads as "nothing to do here", and
      // there is something to do — a human has to look at the markers.
      log.warn('engine config managed-block merge refused — file left untouched', { configFilePath, engineId, reason: error });
      return { written: false, skipped: false, skipReason: null, drifted: false, configFilePath, error: `managed-block merge refused: ${error}` };
    }
    // `drifted` means the same thing here as on the whole-file path: the
    // on-disk content we are about to replace was not what we last generated.
    // Scoped to OUR region, because a change outside the markers is the
    // operator using their own file, which is the whole point and not drift.
    const priorBlock = _extractManagedBlock(existing, engineProfile.configFormat.syntax);
    // A block holding the #858 inactive notice is ours, not an operator edit.
    const priorIsNotice = typeof priorBlock === 'string' && priorBlock.includes(INACTIVE_CONFIG_MARK);
    const nextBlock = _extractManagedBlock(merged, engineProfile.configFormat.syntax);
    const blockDrifted = priorBlock !== null && !priorIsNotice && priorBlock.trim() !== nextBlock.trim();
    if (blockDrifted) {
      log.warn('engine config drift detected inside the managed block — overwriting hand-edits (#240)', {
        configFilePath,
        engineId,
        howToInvestigate: 'edits BETWEEN the BEGIN:tangleclaw / END:tangleclaw markers are regenerated on every '
          + 'launch, boot and engine PATCH; move anything you want to keep OUTSIDE the markers, or edit the '
          + 'source (data/global-rules.md or the landing-page Global Rules editor)'
      });
    }
    try {
      fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
      fs.writeFileSync(configFilePath, merged);
      return { written: true, skipped: false, skipReason: null, drifted: blockDrifted, configFilePath, error: null };
    } catch (err) {
      return { written: false, skipped: false, skipReason: null, drifted: blockDrifted, configFilePath, error: err.message };
    }
  }

  let drifted = false;
  if (fs.existsSync(configFilePath)) {
    try {
      const existing = fs.readFileSync(configFilePath, 'utf8');
      // Normalize line endings before comparing — Windows editors save
      // CRLF, the regenerator emits LF. Without this normalization a
      // Windows operator who never touched the file would see drift
      // warnings on every session launch. Per #240 PR Critic.
      const normalizedExisting = existing.replace(/\r\n/g, '\n').trim();
      const normalizedContent = content.replace(/\r\n/g, '\n').trim();
      // The #858 inactive notice is ours (a switch back regenerates over it);
      // it is not an operator edit and must not be reported as drift.
      if (normalizedExisting !== normalizedContent && !existing.includes(INACTIVE_CONFIG_MARK)) {
        drifted = true;
        log.warn(
          'engine config drift detected — overwriting on-disk hand-edits (#240)',
          {
            configFilePath,
            engineId,
            existingBytes: existing.length,
            regeneratedBytes: content.length,
            howToInvestigate: 'diff the file against `git show HEAD:' + path.basename(configFilePath) + '`; if the on-disk content has rule additions you want to keep, save them via the landing-page Global Rules editor or edit data/global-rules.md and commit before next regeneration'
          }
        );
      }
    } catch { /* unreadable existing file — fall through to overwrite */ }
  }
  try {
    fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
    fs.writeFileSync(configFilePath, content);
    return { written: true, skipped: false, skipReason: null, drifted, configFilePath, error: null };
  } catch (err) {
    return { written: false, skipped: false, skipReason: null, drifted, configFilePath, error: err.message };
  }
}

/**
 * Sync the project's .claude/settings.json hooks block to match its engine.
 * @param {string} projectPath - Absolute path to project root
 * @param {string} [engineIdOverride] - Engine id when the caller holds state
 *   fresher than the DB (an engine PATCH syncs hooks before its batched DB
 *   write lands, so the DB read below would see the pre-PATCH engine)
 */
function syncEngineHooks(projectPath, engineIdOverride) {
  const projConfig = store.projectConfig.load(projectPath);
  const settingsDir = path.join(projectPath, '.claude');
  const settingsFile = path.join(settingsDir, 'settings.json');

  // DB is the single source of truth for the engine (same rule as boot-sync
  // and the session-launch path), unless the caller passed a fresher value.
  // The projConfig fallback covers unregistered paths only (fixtures,
  // pre-registration scaffolding) — without the DB-first read, a registered
  // non-claude project whose legacy project.json lacks the `engine` key would
  // silently resolve as claude here and get baseline hooks written into
  // .claude/settings.json.
  const dbProject = engineIdOverride ? null : store.projects.getByPath(projectPath);
  const engineId = engineIdOverride || (dbProject && dbProject.engineId) || projConfig.engine || 'claude';

  // When the project's current engine is not claude, .claude/settings.json is
  // not consulted at runtime — but a stale hooks block left over from a prior
  // claude+silentPrime state is still orphan canon. Clear it so a future engine
  // flip back to claude (or any cross-engine audit) doesn't see a phantom entry
  // (#140). Symmetric-capability-gates: the engine PATCH branch must clean up
  // engine-specific state for the same reason silentPrime PATCH does (#137).
  if (engineId !== 'claude') {
    if (fs.existsSync(settingsFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        if (existing && existing.hooks) {
          // Same rule as the claude branch, and the same defect it had: clearing
          // TangleClaw's stale entries must not clear the operator's. `delete
          // existing.hooks` took every hook in the file with it.
          const { hooks: kept, preservedForeign, replacedOwn } = _mergeBaselineHooks(existing.hooks, {});
          if (replacedOwn > 0 || Object.keys(kept).length !== Object.keys(existing.hooks).length) {
            if (Object.keys(kept).length > 0) existing.hooks = kept;
            else delete existing.hooks;
            fs.writeFileSync(settingsFile, JSON.stringify(existing, null, 2) + '\n');
            log.info('Cleared stale TangleClaw hooks for non-claude engine', {
              projectPath,
              engine: engineId,
              preservedForeign,
              replacedOwn
            });
          }
        }
      } catch (err) {
        log.warn('Failed to clear stale .claude/settings.json hooks', { projectPath, error: err.message });
      }
    }
    return;
  }

  // Read existing settings (preserve non-hook keys)
  let settings = {};
  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch (err) {
      log.warn('Failed to parse existing .claude/settings.json, starting fresh', { projectPath, error: err.message });
      settings = {};
    }
  }

  // TC emits only its own L1 baseline (silent-prime) hooks. Governance hooks —
  // the Stop gate and Critic enforcement — belong to the Prawduct V2 Claude Code
  // plugin, which reads its own configuration; TC writing them too would fire the
  // legacy vendored Stop hook alongside the plugin's. The write below overwrites
  // any stale governance hooks block a pre-V2 install left behind, while
  // preserving every non-hook key (enabledPlugins, extraKnownMarketplaces, …).
  //
  // Resolve the engine profile so baseline hooks gate on capability, not just
  // projConfig (Critic M1) — keeps this in lockstep with launchSession's
  // silentPrime derivation.
  const engineProfile = store.engines.get(engineId);
  // Shard count is computed here rather than inside `_buildBaselineHooks`
  // because it needs the project's rules from the store, and this module must
  // not require `sessions` — `sessions` already requires this one.
  let ruleShardCount = 0;
  try {
    const project = dbProject || store.projects.getByPath(projectPath);
    if (project) {
      const rules = store.sessionRules.listActiveForProject(project.id);
      ruleShardCount = rulesChannel.shardCount(rules, rulesChannel.resolveChannelBudget(engineProfile));
    }
  } catch (err) {
    // A rules-query failure must not block hook sync; the session still gets
    // its prime, and the delivery ledger records the miss at launch.
    log.warn('Could not determine rule shard count for hook sync', {
      projectPath, error: err.message
    });
  }
  const baselineHooks = _buildBaselineHooks(projConfig, engineProfile, ruleShardCount);

  // Merge, never replace. `settings.hooks` may hold hooks the OPERATOR wrote —
  // .claude/settings.json is the committable, shareable location the Claude Code
  // docs point them at — and this function runs on every session launch, so a
  // wholesale assignment discarded them silently and repeatedly (#752). Only the
  // entries TangleClaw itself emits are reconciled.
  const { hooks: mergedHooks, preservedForeign, replacedOwn } = _mergeBaselineHooks(
    settings.hooks,
    _resolveHooksObject(baselineHooks)
  );
  if (Object.keys(mergedHooks).length > 0) {
    settings.hooks = mergedHooks;
  } else {
    delete settings.hooks;
  }

  // Ensure .claude directory exists
  fs.mkdirSync(settingsDir, { recursive: true });

  // Write back
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  log.info('Synced engine hooks', {
    projectPath,
    engine: engineId,
    hasBaselineHooks: Object.keys(baselineHooks).length > 0,
    // Counted so a regression shows up in the log rather than only in a lost hook.
    preservedForeign,
    replacedOwn
  });
}

// Governance detection lives in `governance-state.js` and is re-exported here
// unchanged, so `engines.isPluginGoverned` / `engines.governanceState` remain
// this module's public surface for every existing caller. The split exists
// because the forked directory scanner reads these too, and that process is
// designed to be SIGKILLed — it must never import this module, which opens the
// server's SQLite database via `store.js` at require time. See
// `lib/governance-state.js`.
const { isPluginGoverned, governanceState } = require('./governance-state');

// #262 (C1) — test seam for the machine-scope plugin-install check the
// migration action makes. Overridable in tests so they don't depend on live
// state. (There is deliberately no seam for reading TangleClaw's own settings
// file: the install reference is a reviewed constant, not a runtime read.)
const _internal = {
  pluginsHome: () => path.join(os.homedir(), '.claude', 'plugins'),
  // Injection seam for "what is installed on this machine". `resolveDefaultEngine`
  // reads it through here so the CALL SITES are testable: engine availability
  // otherwise comes from probing the host's PATH, which makes a test mean
  // different things on a developer box with four engines and on CI with none.
  // The five wired call sites went untested for exactly this reason, and an
  // untested call site is where #707 actually lived — the resolver was never
  // the hard part.
  listWithAvailability: (...args) => listWithAvailability(...args),
  // The settled detection cache, exposed so a test can age an entry and watch
  // the real TTL comparison decide — rather than assert against a helper written
  // to make the test pass.
  detectionResults: _detectionResults,
  // The in-flight probes. A test proves single-flight by firing concurrent asks
  // and reading this before any of them settles; there is no way to observe "how
  // many subprocesses were spawned" from outside, and the count is the claim.
  detectionInflight: _detectionInflight,
  // So a test can look an entry up the way the code does, rather than
  // hand-writing the key format and passing while the real one drifts.
  detectionKeyFor: (strategy, target) => _detectionKey(strategy, target)
};

/**
 * Recursively freeze an object literal and every plain-object value it holds.
 *
 * @param {object} o - Object to freeze in place.
 * @returns {object} The same object, frozen throughout.
 */
function _deepFreeze(o) {
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') _deepFreeze(v);
  }
  return Object.freeze(o);
}

/**
 * The prawduct plugin install reference TangleClaw writes into a migrated
 * project's `.claude/settings.json`.
 *
 * Mirrors prawduct's own published contract — `INSTALL_REFERENCE` in the
 * installed plugin's `lib/migrate_plugin.py` — which is `ref: "main"` (the
 * release surface) with `autoUpdate: true`, so a migrated project tracks
 * prawduct's current release instead of a frozen point in time.
 *
 * This is deliberately a reviewed literal and NOT a value read from a file at
 * run time. It used to be copied verbatim out of TangleClaw's own
 * `.claude/settings.json` — an untracked, machine-local, freely-mutable file —
 * so whatever that file happened to hold was stamped into every project
 * migrated on that machine, unreviewed and invisible in any diff. Two failures
 * followed. A stale `ref: "v2.1.5"` pin reached eleven repositories and left
 * them months behind upstream. Then the marketplace half of that file was
 * removed, after which migrations wrote `enabledPlugins` with no marketplace
 * to resolve it from — a plugin that silently never loads on any machine where
 * prawduct is not already registered. Sourcing this reference from any file
 * that can be absent, stale, or edited without review reproduces that defect
 * class, so it lives here where it is reviewable and diffable.
 *
 * Upstream currently marks `autoUpdate` provisional pending an empirical
 * check, so this value can legitimately change. Compare against
 * `INSTALL_REFERENCE` in the installed plugin's `lib/migrate_plugin.py` before
 * assuming it is still current; `test/c1-plugin-migration.test.js` pins the
 * expected shape so a divergence fails loudly instead of propagating silently.
 *
 * Both halves are ONE atomic reference: `enabledPlugins` without its
 * `extraKnownMarketplaces` entry is unresolvable, so neither is ever written
 * without the other.
 */
// Frozen all the way down, not just at the top level. This object is exported
// and its nested members are spread by reference into every project TangleClaw
// migrates, so a shallow freeze would leave `…prawduct.source.ref` writable —
// one mutation silently riding into every subsequent migration. That is the
// same unreviewed-mutation failure this constant exists to prevent, so the
// guarantee has to be real rather than nominal.
const PRAWDUCT_INSTALL_REFERENCE = _deepFreeze({
  enabledPlugins: { 'prawduct@prawduct': true },
  extraKnownMarketplaces: {
    prawduct: {
      source: { source: 'github', repo: 'brookstalley/prawduct', ref: 'main' },
      autoUpdate: true
    }
  }
});

/**
 * Whether a plugin reference is complete enough to write — it must name at
 * least one enabled prawduct plugin, and EVERY such plugin must carry the
 * marketplace entry that resolves it. A reference missing either half must
 * never reach a project's settings file: `enabledPlugins` alone installs an
 * unresolvable plugin, which fails silently on any machine where prawduct is
 * not already registered (and is therefore invisible on the machine that
 * wrote it).
 *
 * @param {object} ref - Candidate `{ enabledPlugins, extraKnownMarketplaces }`
 * @returns {boolean} True iff both halves are present and non-empty.
 */
function _isCompletePluginRef(ref) {
  if (!ref || typeof ref !== 'object') return false;
  const enabled = ref.enabledPlugins;
  if (!enabled || typeof enabled !== 'object') return false;
  const enabledKeys = Object.keys(enabled).filter((k) => k.startsWith('prawduct@') && enabled[k] === true);
  if (enabledKeys.length === 0) return false;
  const markets = ref.extraKnownMarketplaces;
  if (!markets || typeof markets !== 'object') return false;
  // Resolve each enabled plugin against ITS OWN marketplace, taken from the
  // `plugin@marketplace` key rather than assumed to be "prawduct". Only
  // `prawduct@prawduct` ships today, so hardcoding the name would pass for the
  // wrong reason and quietly wave through a reference it cannot actually
  // resolve the day a second marketplace exists.
  return enabledKeys.every((k) => {
    const marketplace = k.slice(k.indexOf('@') + 1);
    return Boolean(marketplace && markets[marketplace]);
  });
}

/**
 * Whether the prawduct plugin is installed at machine scope — i.e. writing the
 * reference will actually activate it on this machine's next session (vs. a
 * fresh machine that still needs `/plugin install`). Reads
 * `~/.claude/plugins/installed_plugins.json`. Fails closed (false) on any error:
 * a false negative only yields a `pending-activation` status, never a silent
 * governance gap or a false "migrated" claim.
 *
 * @returns {boolean}
 */
function pluginInstalledAtMachineScope() {
  try {
    const file = path.join(_internal.pluginsHome(), 'installed_plugins.json');
    if (!fs.existsSync(file)) return false;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const plugins = data && data.plugins;
    if (!plugins || typeof plugins !== 'object') return false;
    return Object.keys(plugins).some((k) => k.startsWith('prawduct@'));
  } catch {
    return false;
  }
}

/**
 * Migrate a project to V2-plugin governance (#262, C1). Writes TC's own plugin
 * reference into the project's `.claude/settings.json` — **non-destructive**:
 * every other key is preserved — then re-syncs engine hooks. Because
 * `isPluginGoverned` now returns true, the project reads as governed everywhere
 * TC gates on it; the hook re-sync rewrites settings.json with TC's L1 prime
 * alone, dropping any stale vendored governance hook reference (no destructive
 * delete of the project's vendored file). Idempotent: a no-op when
 * the project is already governed. **Pure config layer** — the caller owns
 * cohort gating (non-Claude) and session-safety.
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} [options]
 * @param {object} [options.pluginRef] - Override the reference (tests); defaults to
 *   `PRAWDUCT_INSTALL_REFERENCE`. Rejected unless complete (both halves).
 * @returns {{written: boolean, alreadyGoverned: boolean, error?: string}}
 */
function migrateToPlugin(projectPath, options = {}) {
  if (isPluginGoverned(projectPath)) {
    return { written: false, alreadyGoverned: true };
  }
  const ref = options.pluginRef || PRAWDUCT_INSTALL_REFERENCE;
  if (!_isCompletePluginRef(ref)) {
    return {
      written: false,
      alreadyGoverned: false,
      error: 'refusing to write an incomplete plugin reference: enabledPlugins without a resolving '
        + 'extraKnownMarketplaces entry yields a plugin that silently never loads'
    };
  }

  const settingsDir = path.join(projectPath, '.claude');
  const settingsFile = path.join(settingsDir, 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch (err) {
      // Never clobber a malformed settings.json — surface it for the operator.
      return {
        written: false,
        alreadyGoverned: false,
        error: `existing .claude/settings.json is unparseable, refusing to overwrite: ${err.message}`
      };
    }
  }

  // Non-destructive merge: every unrelated key in the project's settings
  // survives. The prawduct entries themselves are deliberately overwritten, not
  // preserved — a project carrying a stale pin is precisely what needs
  // correcting, so deferring to whatever it already had would defeat the point.
  // Both halves are written unconditionally. The completeness check above — not
  // this merge — is what guarantees a resolvable reference; an earlier version
  // guarded the marketplace merge on the ref carrying one, which silently
  // degraded to writing enabledPlugins alone whenever the ref lacked it. With
  // the ref validated, that branch could never be false, so it is gone: a dead
  // conditional here would read as a safeguard it is not.
  settings.enabledPlugins = { ...(settings.enabledPlugins || {}), ...ref.enabledPlugins };
  settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces || {}), ...ref.extraKnownMarketplaces };

  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

  // Now that the project reads as governed, re-sync hooks: syncEngineHooks
  // rewrites the hooks block with TC's L1 prime alone, dropping any vendored
  // governance-hook reference. This is the "neutralize the vendored hook" step —
  // by reference-drop, not destructive file delete.
  // A re-sync failure here is non-fatal and self-healing: the reference IS
  // written (the durable effect), and because the project now reads as governed,
  // the NEXT syncEngineHooks — next session launch or boot-sync — drops the
  // vendored governance hook. So a transient throw leaves at worst a brief
  // dual-governance window, never an un-migrated project; returning written:true
  // is correct. We warn rather than fail the write.
  try {
    syncEngineHooks(projectPath);
  } catch (err) {
    log.warn('migrateToPlugin: hook re-sync failed (plugin reference written; self-heals on next sync)', { projectPath, error: err.message });
  }

  log.info('Migrated project to V2 plugin governance (#262)', { projectPath });
  return { written: true, alreadyGoverned: false };
}

module.exports = {
  _mergeBaselineHooks,
  _isTangleClawHookEntry,
  TC_HOOK_SCRIPTS,
  TC_LEGACY_HOOK_MARKERS,
  detect,
  detectEngine,
  detectEngineAsync,
  anyEngineInstalled,
  engineReadiness,
  // Exported so "Check again" can drop the cached login PATH, and so the merge
  // rule (never lose a path the server could already see) can be pinned.
  resetDetectionCache,
  refreshDetectionPath,
  detectionWasProbed,
  detectionProbeAttempted,
  _detectionPath,
  resolveDefaultEngine,
  honorsLaunchMode,
  silentPrimeDisposition,
  settingDisposition,
  resolveProfile,
  ENGINE_CONDITIONAL_SETTINGS,
  reconcileLaunchMode,
  isPluginGoverned,
  governanceState,
  migrateToPlugin,
  pluginInstalledAtMachineScope,
  PRAWDUCT_INSTALL_REFERENCE,
  _isCompletePluginRef,
  _internal,
  listWithAvailability,
  getWithAvailability,
  validateProfile,
  generateConfig,
  writeEngineConfig,
  retireInactiveEngineConfig,
  INACTIVE_CONFIG_MARK,
  GENERATED_HEADER_MARK,
  validateParity,
  validateStatusParity,
  _getRulesContent,
  _serviceTokenAuthLines,
  _medusaSwitchboardLines,
  _generateClaudeMd,
  _generateCodexYaml,
  _generateAiderConf,
  _generateGeminiMd,
  _mergeManagedBlock,
  _managedBlockMarkers,
  _extractManagedBlock,
  _demoteTopLevelHeadings,
  SHARED_CONVENTION_CARRIERS,
  syncEngineHooks,
  _resolveHookPlaceholders,
  _buildSharedDocsSection,
  _buildBaselineHooks,
  // Exported as a pair so a guard can pin BOTH halves of the rename contract: the
  // names TangleClaw has ever emitted must stay retired, and no retirement marker may
  // match a name it currently emits (#1007).
  _TC_LEGACY_HOOK_MARKERS: TC_LEGACY_HOOK_MARKERS,
  _TC_HOOK_SCRIPTS: TC_HOOK_SCRIPTS
};
