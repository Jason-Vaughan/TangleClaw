'use strict';

/**
 * Per-project configuration: the defaults, and the pure-filesystem reader for
 * `<projectPath>/.tangleclaw/project.json`.
 *
 * WHY THIS IS ITS OWN MODULE. The reader is called for every registered project
 * on the dashboard's ten-second poll, so it belongs in the forked scanner child
 * that a deadline can kill (#884) — and the child must never import
 * `lib/store.js`, which opens the server's SQLite database at require time. It
 * lived there because that is where project state lives, not because it needs
 * anything from it: the reader touches only `node:fs` and `node:path`.
 *
 * `lib/store.js` re-exports both of these unchanged, so `store.projectConfig.load`
 * and the defaults remain that module's public surface for every existing caller.
 * The WRITER deliberately stays in `lib/store.js`: nothing on the poll path writes
 * config, and a process that gets SIGKILLed mid-syscall has no business owning a
 * write the operator's settings depend on.
 *
 * Nothing here may acquire a dependency that touches the database, the network,
 * or a subprocess. `node:fs` and `node:path` only.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PROJECT_CONFIG = {
  engine: null,
  // Silent prime is the cleaner-scrollback default (#129). Projects that
  // explicitly persist `silentPrime: false` continue to get the typed-prime
  // path; non-Claude engines fall through via the capability gate
  // (`engineProfile.capabilities.supportsSilentPrime`) regardless of this default.
  silentPrime: true,
  // Feature Index (#207, chunk 1) — opt-in per-project. When true, a
  // FEATURES.md is seeded at project root on first toggle-on (idempotent;
  // never overwrites an existing file). Chunk 2 injects the contents into
  // the SessionStart prime prompt (gated additionally by silentPrime + the
  // engine's `supportsSilentPrime` capability). Chunk 3 adds a
  // `features-toc` wrap-step handler that auto-appends stubs for PR-touched
  // files not represented in FEATURES.md.
  //
  // The toggle is not engine-gated because its wrap half is engine-agnostic —
  // but only that half is. The SessionStart pointer rides the hidden prime, so
  // on an engine that delivers none this maintains a file no session is told
  // to read. That is a CAVEAT on the setting, not a gate: it is why the
  // `featureIndexEnabled` row in `ENGINE_CONDITIONAL_SETTINGS` declares one
  // and no `applies`, and why the settings modal says so where the toggle is
  // offered (ADR 0013).
  featureIndexEnabled: false,
  // PIDX (#360, #356): opt-in for the PROJECT-MAP.md structural "where things
  // live" index. On toggle-on, `_seedProjectMapFile` seeds PROJECT-MAP.md at the
  // project root with an auto-generated top-level-directory skeleton; the
  // SessionStart prime POINTS the agent at the file (reference, not inline —
  // unlike FEATURES.md) gated additionally by silentPrime + supportsSilentPrime.
  // Not engine-gated, for the same half-and-half reason as
  // `featureIndexEnabled` above: the wrap half runs everywhere, the pointer
  // half does not, and the difference is carried as a caveat.
  projectMapEnabled: false,
  // Whether the wrap's `version-bump` step may cut a release (#1492):
  //   'off'  — never; the project versions itself.
  //   'auto' — only when the release readiness verdict is `ready`.
  //   'ask'  — never on its own; the operator decides.
  // null means "derive it" (see `resolveReleaseMode`), and is the default on
  // purpose: a literal 'auto' here would be merged into every loaded config and
  // hide a legacy `versionBumpEnabled: false`, silently cutting releases for
  // projects that had opted out.
  releaseMode: null,
  // #318: the legacy opt-out `releaseMode` replaces. Still read, so a project
  // that set it false keeps `off` without its file being rewritten. A settings
  // save carrying either key writes both, with this one true only for `auto`,
  // so a TangleClaw rolled back to a version that reads only this key holds
  // rather than cuts.
  versionBumpEnabled: true,
  // Explicit path to the file holding the project's version, relative to the
  // project root (e.g. `VERSION.json`). null = the built-in probe order
  // (`version.json`, then `package.json`). Set this when the file isn't
  // lowercase `version.json`: the probe only ever tests the lowercase name, so
  // on a case-sensitive filesystem a `VERSION.json` project resolved nothing,
  // fell through, and bumped its unrelated `package.json` version — writing a
  // bogus release heading above the real one. A configured path is the only
  // candidate considered; it resolves or the step skips, never falls back.
  versionFilePath: null,
  // #467: opt-out for the commit step's auto-PR close-loop. When a wrap
  // auto-branches off a protected branch (#264), the commit step pushes the
  // wrap branch, opens a PR back to the original branch, and arms auto-merge
  // so the wrap's artifacts actually land. Default true — the pre-#467
  // default (silently dangling wrap branches) was the bug. Set false for
  // projects that must never have automated pushes/PRs.
  wrapAutoPrEnabled: true,
  // #1708: whether a finished wrap leaves the session running. The request's
  // own `keepSessionRunning` wins; this is what a wrap inherits when the request
  // says nothing, which is every wrap not started from the modal (a peer's or
  // the PM's POST, a script). null means "not set", and resolves to false, which
  // keeps #1558's "a wrap ends the session" (see `resolveKeepSessionRunning`).
  // Null rather than a literal false for the reason `releaseMode` is null: this
  // default is merged into every loaded config, and a literal would make "the
  // project chose false" and "the project never chose" indistinguishable.
  wrapKeepSessionRunning: null,
  // CC-6 (#381): which of continuity's 8 wrap-summary sections render for this
  // project. null = the deep default (all 8). An override is an array of enabled
  // section names (subset of continuity.WRAP_SECTIONS); `Next action` always
  // renders regardless (the keystone). Per-project-shape depth presets
  // (software=8, grant-proposal=3) are CC-8; CC-6 ships the override only.
  wrapSections: null,
  // Per-step wrap overrides, keyed by the step ids in
  // `lib/wrap-default-pipeline.js` — the only way a project turns off or
  // reconfigures an individual wrap step. The pipeline itself is code-owned
  // (order and membership are framework policy); this file is the whole
  // per-project customization surface.
  //
  // `{}` is load-bearing as the default, not just a placeholder: the merge in
  // `projectConfig.load` replaces non-`rules` keys wholesale, so a project's
  // on-disk map is taken verbatim with no framework keys folded in — which is
  // exactly right for a map the project alone owns, and would be a bug if the
  // default carried entries a project could then never delete.
  //
  // Only an allow-listed subset of step fields may be overridden, and order
  // and membership stay framework-owned; `lib/wrap-step-overrides.js` carries
  // the allow-list and the reasoning behind each exclusion.
  wrapStepOverrides: {},
  // Provenance line on the private files TangleClaw generates whole (ADR 0019):
  // `{ enabled, template }`, read through `lib/provenance.js`
  // `resolveProvenance`. null is off with the default template, and is null
  // rather than a literal object for the reason `releaseMode` is: this default
  // is merged into every loaded config and saved back on any settings save, so
  // a literal would write an opinion into every project that never chose one.
  provenanceWatermark: null,
  // Per-project launch-mode posture (Phase A settings retask — replaces the
  // retired free-text 'mode' rule kind with structured settings).
  // `defaultLaunchMode` is an engine launch-mode KEY ('default' = the
  // "Interactive" mode every bundled engine defines — the safest posture).
  // Validated against the intended engine's launchModes at PATCH time; at
  // launch it applies only when the engine actually defines the key.
  defaultLaunchMode: 'default',
  // When false, the landing page skips the Launch Mode picker and launches
  // directly in `defaultLaunchMode`. Guard: hiding the picker while the
  // default is a warning-carrying mode (bypassPermissions/fullAuto/yesAlways)
  // removes the red warning from the flow entirely, so that combination
  // requires an explicit confirm (`confirmBypassHidden`) at PATCH time.
  showLaunchModePicker: true,
  // TB-1 (#357): optional per-(project,profile) key-ref override. NULL = use
  // the bound profile's default keyRef from orchestration-profiles.json. Set
  // to `file:<path>` or `env:<NAME>` when a project needs isolated metering /
  // budget / revocation with its own key. The binding itself (which profile)
  // lives in the projects.orchestration_profile column, not here.
  orchestrationKeyRef: null,
  rules: {
    core: {
      changelogPerChange: true,
      jsdocAllFunctions: true,
      unitTestRequirements: true,
      sessionWrapProtocol: true,
      porthubRegistration: true
    },
    extensions: {
      identitySentry: false,
      docsParity: false,
      decisionFramework: false,
      loggingLevel: 'info',
      zeroDebtProtocol: false,
      independentCritic: false,
      adversarialTesting: false
    }
  },
  ports: {},
  quickCommands: [],
  tags: [],
  evalAuditMode: {
    enabled: false,
    judgeModel: 'claude-haiku-4-5',
    gateCascade: true,
    sampling: {
      enabled: true,
      routineInterval: 3,
      alwaysScoreFirst: 5,
      alwaysScoreLast: 3,
      alwaysScoreDisagreement: true,
      alwaysScoreLongResponses: true,
      longResponseThreshold: 500
    },
    thinkingBlockAnalysis: true,
    bidirectionalScoring: false,
    wrapQualityScoring: true,
    costCapPerSession: 1.00,
    heartbeatInterval: 300000,
    baselineWindowDays: 14,
    retentionDays: 90
  },
  // No wrap opt-out key is seeded here: the wrap pipeline
  // (`lib/sessions.js:triggerWrap` → `lib/wrap-pipeline.js:runWrapPipeline`)
  // is the only wrap path, so any such key left on an older project's
  // config on disk is ignored by every reader.

  // Test/lint commands the wrap pipeline shells out to.
  // Explicit declaration avoids auto-detection's monorepo / multi-stack
  // failure modes (Notse-class projects with `cd helper && pytest && cd
  // ../app && npm test`). `null` means "this project has no command to
  // run"; the relevant step kind logs and skips when the command is null.
  testCommand: null,
  lintCommand: null,
  // Train 21 (#1584, #1583): how a launch sequence behaves for this project.
  //
  // `pasteRules` — where a PASTE-ONLY engine's project rules come from. On an
  // engine that delivers a hidden prime the rules ride their own startup hook
  // and this setting changes nothing; on the others the prime used to carry the
  // whole rule text, pasted into the terminal. `pull` drops that paste because
  // the launch sequence's governance step serves the same rules in full and
  // records that they were read, which a paste cannot. The default is `pull`
  // per the operator's ratification of the prime-delivery §3 amendment
  // (2026-09-17); `paste` is the opt-out, and it is also what a launch with no
  // sequence gets regardless of this value — a pointer to a channel the session
  // does not have would deliver nothing at all.
  //
  // `unreadyWindowMinutes` — how long a launched session has to attest READY
  // before TangleClaw stamps it unready and nudges it once. It is an
  // observation, not a gate: it never blocks a launch and never invalidates a
  // later attestation.
  //
  // `recoveryMode` — what a launch does when its preflight says the project's
  // handoff state needs recovering. `operator` withholds the task step until a
  // person clears it from the dashboard; `advisory` serves the task step behind
  // a warning and lets the session clear its own recovery by attesting with a
  // written reconciliation. The value here is what a save writes into a
  // project's file, so it records nobody's decision, and it is the mode a
  // project with no decision runs in unless TangleClaw's login is in force.
  // Where it is, the default is `advisory` (ADR 0017 R3). That is decided when
  // the mode is resolved and not by this constant. A file saying `advisory` is
  // a request, refused with a warning where the login is not in force, so
  // seeding it would make every saved project there warn at every launch about
  // a request nobody made.
  launchSequence: {
    pasteRules: 'pull',
    unreadyWindowMinutes: 10,
    recoveryMode: 'operator'
  },
  // #1502: a shell command the `commit` step runs when this wrap cuts a release,
  // after the bump and CHANGELOG promotion are on disk and before the commit.
  // It updates whatever else the project's release needs (README install pins,
  // a lockfile) and the files it changes go into the wrap commit. It gets the
  // release in TANGLECLAW_RELEASE_VERSION / TANGLECLAW_RELEASE_PREVIOUS. A
  // non-zero exit stops the commit and puts the bump back. null = nothing to run.
  releasePrepareCommand: null,
  // #2262: whether a session of this project whose workload receipt has expired
  // is nudged, and who is told when the nudge goes unanswered:
  // `{ enabled, text, coordinatorProject, escalateAfterMinutes }`, read through
  // `resolveWorkloadNudge`. null is off, and is null rather than a literal
  // object for the reason `provenanceWatermark` is: this default is merged into
  // every loaded config and saved back on any settings save.
  workloadNudge: null
  // The last wrap boundary is NOT here: it is per-checkout state that changes on
  // every wrap, kept in the untracked `.tangleclaw/state.json` (`lib/wrap-state.js`).
};

/**
 * Load per-project config from <projectPath>/.tangleclaw/project.json.
 * Merges with defaults. Returns defaults if file doesn't exist.
 * @param {string} projectPath - Absolute path to project root
 * @param {object} [options] - Reader options.
 * @param {(err: Error, configPath: string) => void} [options.onError] - Called when
 *   the file exists but cannot be read or parsed. Defaults are returned either way;
 *   this exists so a caller with a logger can report it without this module owning one.
 * @returns {object}
 */
function load(projectPath, options = {}) {
  const onError = options.onError;
  const configPath = path.join(projectPath, '.tangleclaw', 'project.json');
  try {
    if (!fs.existsSync(configPath)) {
      return JSON.parse(JSON.stringify(DEFAULT_PROJECT_CONFIG));
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Migrate legacy engine ID
    if (parsed.engine === 'claude-code') {
      parsed.engine = 'claude';
    }

    // Deep merge with defaults
    const merged = JSON.parse(JSON.stringify(DEFAULT_PROJECT_CONFIG));
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'rules' && typeof value === 'object') {
        if (value.core) {
          // Core rules are always true — ignore any attempt to disable
          merged.rules.core = { ...merged.rules.core };
        }
        if (value.extensions) {
          merged.rules.extensions = { ...merged.rules.extensions, ...value.extensions };
        }
      } else {
        merged[key] = value;
      }
    }
    return merged;
  } catch (err) {
    // Reported through the caller's sink rather than a logger of this module's
    // own. This module is required by the scanner child, whose whole justification
    // is a minimal dependency graph — it should not acquire `lib/logger.js` to
    // report a condition its return value already carries. `store.js` passes its
    // logger so its callers keep the exact warning they had before this moved;
    // the child passes one that logs at DEBUG, because this runs per project on a
    // ten-second poll and a warn per project per poll would bury the real ones.
    // prawduct:allow prawduct/broad-except -- returns the documented defaults for
    // any unreadable or malformed config, and hands the cause to `onError`; the
    // failure is carried by the value, not swallowed.
    if (typeof onError === 'function') onError(err, configPath);
    return JSON.parse(JSON.stringify(DEFAULT_PROJECT_CONFIG));
  }
}

const RELEASE_MODES = Object.freeze(['off', 'auto', 'ask']);

/**
 * Resolve a loaded project config's effective release mode.
 *
 * Migration happens here, on read, rather than by rewriting files:
 * `.tangleclaw/project.json` is tracked in many managed repos, and a bulk
 * rewrite would leave an unexplained diff in every one of them.
 *
 * An explicit valid `releaseMode` wins. Without one, a legacy
 * `versionBumpEnabled: false` reads as `off`, and anything else as `auto`. An
 * explicit value that isn't a known mode (a hand-typed `"Auto"`, say) reads as
 * `ask`: it must not cut a release on a guess, and it must not quietly switch
 * the step off either, which is what `off` would do.
 *
 * @param {object|null|undefined} projConfig - A config as returned by `load`
 * @returns {{mode:'off'|'auto'|'ask', source:'releaseMode'|'versionBumpEnabled'|'default'|'invalid', warning?:string}}
 */
function resolveReleaseMode(projConfig) {
  const cfg = projConfig || {};
  const explicit = cfg.releaseMode;
  if (explicit !== null && explicit !== undefined) {
    if (RELEASE_MODES.includes(explicit)) return { mode: explicit, source: 'releaseMode' };
    return {
      mode: 'ask',
      source: 'invalid',
      warning: `releaseMode ${JSON.stringify(explicit)} is not one of ${RELEASE_MODES.join(', ')}; treating it as ask`
    };
  }
  if (cfg.versionBumpEnabled === false) return { mode: 'off', source: 'versionBumpEnabled' };
  return { mode: 'auto', source: 'default' };
}

/**
 * The release mode a validated settings update leaves a project in.
 *
 * An explicit `releaseMode` is taken as sent. The legacy `versionBumpEnabled`
 * boolean is an alias with one asymmetry: `false` means `off`, but `true` only
 * turns an `off` project back to `auto` and otherwise leaves the mode alone. The
 * settings modal sends that checkbox on every save, and reading `true` as `auto`
 * would quietly undo an operator's `ask` whenever they saved anything else.
 *
 * @param {'off'|'auto'|'ask'} currentMode - The project's resolved mode before the update
 * @param {{releaseMode?:string, versionBumpEnabled?:boolean}} updates - Already validated
 * @returns {'off'|'auto'|'ask'}
 */
function nextReleaseMode(currentMode, updates) {
  if (updates.releaseMode !== undefined) return updates.releaseMode;
  if (updates.versionBumpEnabled === false) return 'off';
  if (updates.versionBumpEnabled === true && currentMode === 'off') return 'auto';
  return currentMode;
}

const PASTE_RULES_MODES = Object.freeze(['paste', 'pull']);

const RECOVERY_MODES = Object.freeze(['operator', 'advisory']);

/**
 * The smallest and largest unready window a project may configure.
 *
 * A floor because a window shorter than a launch takes to finish would nudge
 * every session before it could possibly have attested; a ceiling because a
 * window measured in weeks is a setting that silently means "never", which the
 * operator should express by saying so rather than by a number nobody reads.
 */
const UNREADY_WINDOW_MIN_MINUTES = 1;
const UNREADY_WINDOW_MAX_MINUTES = 1440;

/**
 * Where a paste-only engine's project rules come from for this project.
 *
 * An unrecognised value reads as `paste`, the delivering answer: this setting
 * decides whether rule TEXT is dropped from the prime, so a typo must fall back
 * to the side that still delivers the rules rather than to the side that trusts
 * a channel the operator may not have meant.
 * @param {object|null|undefined} projConfig - A config as returned by `load`
 * @returns {{mode: 'paste'|'pull', source: 'launchSequence'|'default'|'invalid', warning?: string}}
 */
function resolvePasteRules(projConfig) {
  const value = projConfig && projConfig.launchSequence ? projConfig.launchSequence.pasteRules : undefined;
  if (value === undefined || value === null) {
    return { mode: DEFAULT_PROJECT_CONFIG.launchSequence.pasteRules, source: 'default' };
  }
  if (PASTE_RULES_MODES.includes(value)) return { mode: value, source: 'launchSequence' };
  return {
    mode: 'paste',
    source: 'invalid',
    warning: `launchSequence.pasteRules ${JSON.stringify(value)} is not one of ${PASTE_RULES_MODES.join(', ')}; the rules stay pasted`
  };
}

/**
 * How long this project's sessions have to attest READY, in milliseconds.
 *
 * An out-of-range or non-numeric value reads as the shipped default: the window
 * only decides when an observation is recorded and one nudge is sent, so
 * falling back keeps the observation happening rather than turning it off on a
 * bad value.
 * @param {object|null|undefined} projConfig - A config as returned by `load`
 * @returns {{ms: number, minutes: number, source: 'launchSequence'|'default'|'invalid', warning?: string}}
 */
function resolveUnreadyWindow(projConfig) {
  const fallback = DEFAULT_PROJECT_CONFIG.launchSequence.unreadyWindowMinutes;
  const value = projConfig && projConfig.launchSequence ? projConfig.launchSequence.unreadyWindowMinutes : undefined;
  if (value === undefined || value === null) {
    return { ms: fallback * 60_000, minutes: fallback, source: 'default' };
  }
  const inRange = typeof value === 'number' && Number.isFinite(value)
    && value >= UNREADY_WINDOW_MIN_MINUTES && value <= UNREADY_WINDOW_MAX_MINUTES;
  if (inRange) return { ms: value * 60_000, minutes: value, source: 'launchSequence' };
  return {
    ms: fallback * 60_000,
    minutes: fallback,
    source: 'invalid',
    warning: `launchSequence.unreadyWindowMinutes ${JSON.stringify(value)} is not a number of minutes between `
      + `${UNREADY_WINDOW_MIN_MINUTES} and ${UNREADY_WINDOW_MAX_MINUTES}; using ${fallback}`
  };
}

/**
 * What `workloadNudge` resolves to for a project that sets nothing (#2262).
 * Off: the monitor types into a pane, so it acts only where a project asked.
 */
const WORKLOAD_NUDGE_DEFAULTS = Object.freeze({
  enabled: false,
  text: null,
  coordinatorProject: null,
  escalateAfterMinutes: 10
});

/** The settings a `workloadNudge` block may carry. */
const WORKLOAD_NUDGE_KEYS = Object.freeze(Object.keys(WORKLOAD_NUDGE_DEFAULTS));

/** The longest nudge line a project may set, in characters. */
const WORKLOAD_NUDGE_TEXT_MAX = 2000;

/** The longest project name `coordinatorProject` may carry, in characters. */
const WORKLOAD_NUDGE_COORDINATOR_MAX = 255;

/**
 * The shortest and longest wait between a nudge and its escalation.
 *
 * A floor because a session needs time to read the line and write a receipt,
 * and an escalation sent before it could have answered tells the coordinator
 * nothing. A ceiling because a wait of many hours means "never" without saying
 * so, and turning the setting off is how to say that.
 */
const WORKLOAD_NUDGE_ESCALATE_MIN_MINUTES = 2;
const WORKLOAD_NUDGE_ESCALATE_MAX_MINUTES = 120;

/**
 * A character that must not appear in a line typed into a pane or written to a
 * log: a control or format character, a line or paragraph separator, or one
 * that renders as nothing. A tab or a newline typed into a terminal is a
 * keypress, not text.
 *
 * `lib/workload.js` judges a workload summary by the same two classes. This
 * module cannot import it (that file opens the database, and this one runs in
 * the scanner child), so the classes are stated here and
 * `test/workload-nudge-settings.test.js` holds the two to the same answers.
 */
const UNSAFE_LINE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** A character a reader can see: a letter, number, punctuation mark or symbol. */
const VISIBLE_LINE_TEXT = /[\p{L}\p{N}\p{P}\p{S}]/u;

/**
 * Whether a value is one safe line of plain text: a string with no
 * {@link UNSAFE_LINE_TEXT} character and at least one visible one.
 * @param {unknown} text - Candidate text
 * @returns {boolean}
 */
function isSafeLineText(text) {
  return typeof text === 'string' && !UNSAFE_LINE_TEXT.test(text) && VISIBLE_LINE_TEXT.test(text);
}

/**
 * Why one `workloadNudge` setting cannot be used, or null when it can.
 *
 * The one judgement of a value, shared by the save path and the reader, so a
 * value that saves cleanly is never one the reader then discards. `null` is
 * accepted for `text` (the default line) and `coordinatorProject` (nobody
 * named), and for nothing else.
 * @param {string} key - One of {@link WORKLOAD_NUDGE_KEYS}
 * @param {unknown} value - The value offered for it
 * @returns {string|null} The reason, phrased to follow the setting's name
 */
function workloadNudgeProblem(key, value) {
  if (key === 'enabled') {
    return typeof value === 'boolean' ? null : 'must be true or false';
  }
  if (key === 'text') {
    if (value === null) return null;
    return isSafeLineText(value) && value.length <= WORKLOAD_NUDGE_TEXT_MAX
      ? null
      : `must be null or one line of at most ${WORKLOAD_NUDGE_TEXT_MAX} characters with no control, format, invisible or `
        + 'line-separator characters, and at least one visible character';
  }
  if (key === 'coordinatorProject') {
    if (value === null) return null;
    return isSafeLineText(value) && value.length <= WORKLOAD_NUDGE_COORDINATOR_MAX && value === value.trim()
      ? null
      : `must be null or a project name: one line of at most ${WORKLOAD_NUDGE_COORDINATOR_MAX} characters with no `
        + 'control, format, invisible or line-separator characters and no space at either end';
  }
  if (key === 'escalateAfterMinutes') {
    return typeof value === 'number' && Number.isFinite(value)
      && value >= WORKLOAD_NUDGE_ESCALATE_MIN_MINUTES && value <= WORKLOAD_NUDGE_ESCALATE_MAX_MINUTES
      ? null
      : `must be a number of minutes between ${WORKLOAD_NUDGE_ESCALATE_MIN_MINUTES} and ${WORKLOAD_NUDGE_ESCALATE_MAX_MINUTES}`;
  }
  return 'is not a workloadNudge setting';
}

/**
 * Whether this project's expired workload receipts are nudged, with what line,
 * and who is told when a nudge goes unanswered (#2262).
 *
 * A project that sets nothing is off. A value that cannot be used reads as the
 * default for that one setting and is named in `warnings`; the others keep
 * what they said. For `enabled` the default is off, so a typo can never be why
 * a pane was typed into. A block that is not an object is ignored whole.
 * @param {object|null|undefined} projConfig - A config as returned by `load`
 * @returns {{enabled: boolean, text: string|null, coordinatorProject: string|null, escalateAfterMinutes: number,
 *   escalateAfterMs: number, sources: Object<string, 'workloadNudge'|'default'|'invalid'>, warnings: string[]}}
 */
function resolveWorkloadNudge(projConfig) {
  const raw = projConfig ? projConfig.workloadNudge : undefined;
  const warnings = [];
  let block = {};
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      block = raw;
    } else {
      warnings.push(`workloadNudge ${JSON.stringify(raw)} is not an object; the nudge stays off`);
    }
  }
  const out = { sources: {}, warnings };
  for (const key of WORKLOAD_NUDGE_KEYS) {
    const value = block[key];
    if (value === undefined) {
      out[key] = WORKLOAD_NUDGE_DEFAULTS[key];
      out.sources[key] = 'default';
      continue;
    }
    const problem = workloadNudgeProblem(key, value);
    if (problem) {
      out[key] = WORKLOAD_NUDGE_DEFAULTS[key];
      out.sources[key] = 'invalid';
      // The value is described, never quoted: a line that failed for carrying
      // a control character must not be written into a log.
      warnings.push(`workloadNudge.${key} (${_describeForWarning(value)}) ${problem}; using ${JSON.stringify(WORKLOAD_NUDGE_DEFAULTS[key])}`);
      continue;
    }
    out[key] = value;
    out.sources[key] = 'workloadNudge';
  }
  for (const key of Object.keys(block)) {
    if (!WORKLOAD_NUDGE_KEYS.includes(key)) {
      warnings.push(`workloadNudge has a key that is not a setting and is ignored; it takes ${WORKLOAD_NUDGE_KEYS.join(', ')}`);
      break;
    }
  }
  out.escalateAfterMs = out.escalateAfterMinutes * 60_000;
  return out;
}

/**
 * A value named for a warning without repeating it: its type, and for a string
 * its length. A bad nudge line may be bad because of what it contains.
 * @param {unknown} value - The value that was refused
 * @returns {string}
 */
function _describeForWarning(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string of ${value.length} characters`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `a value of type ${typeof value}`;
}

/**
 * How this project's launches handle a preflight that demands recovery.
 *
 * Three inputs decide it: the operator's decision, held by the server store;
 * the value in `project.json`; and whether advisory is the default on this
 * install right now. The store outranks the file. This module reads no store
 * and no login gate (the scanner child requires it and must stay light), so
 * the caller reads the decision and the gate and hands both over.
 *
 * | Operator decision       | File value            | Advisory is the default | Mode     | Source           |
 * |-------------------------|-----------------------|-------------------------|----------|------------------|
 * | pinned to operator      | anything              | either                  | operator | `pinned`         |
 * | none, or chose advisory | unrecognised          | either                  | operator | `invalid`        |
 * | chose advisory          | recognised, or absent | either                  | advisory | `chosen`         |
 * | none                    | absent                | yes                     | advisory | `default`        |
 * | none                    | `operator`            | yes                     | advisory | `inherited`      |
 * | none                    | `advisory`            | yes                     | advisory | `launchSequence` |
 * | none                    | recognised, or absent | no                      | operator | `not-armed`      |
 *
 * What the file can do follows from the table. It cannot loosen a pin and it
 * cannot create one: a hand-written `operator` records nobody's decision. It
 * can tighten, by one route, because an unrecognised value reads as `operator`,
 * the BLOCKING side. That is the mirror of `resolvePasteRules`, which falls
 * back to `paste` for the same reason and not to the same word: a typo falls
 * back to whichever side fails safe for the question that setting asks. Here
 * the question is whether a launch with a bad handoff can walk through
 * unattended, so the safe side is the one that stops and asks a person.
 *
 * `advisoryDefault` is the caller's answer to "is TangleClaw's login in force",
 * from `lib/recovery-default.js`. Only the boolean `true` counts: advisory lets
 * a session clear its own recovery, which is acceptable only where a signed-in
 * operator can read back what it wrote. Without it every project with no
 * decision resolves `operator`, including one whose file says `advisory`: the
 * file sits in the project's own checkout, where its session can write it, so
 * honouring it there would let a session choose advisory for itself. That row
 * carries a `warning`, because the file asked for something it did not get.
 *
 * `not-armed` says only that the answer was not `true`. It does not say the
 * install has no login: a login stood down behind Caddy's, an account not yet
 * created and an unreadable config all land here too. A reader that needs to
 * say which takes the gate state from `lib/recovery-default.js`.
 *
 * `inherited` is a project holding the seeded `operator`, read as never
 * chosen: every save wrote the default block into the file, and `load` hands
 * the same block to a project with no file at all. So a project saved long
 * ago and one that has never launched both resolve here, and the first launch
 * that does claims the once-only notice. `default` is left for a file whose
 * `launchSequence` block is present without the key.
 *
 * A `discrepancy` is the file disagreeing with a decision on record. It is
 * reported and never obeyed. Where nobody decided anything there is none:
 * not for `inherited`, and not for an unrecognised value with no decision
 * behind it, which carries its `warning` alone.
 *
 * A decision is on record when `pinnedAt` is set, and by nothing else. A row
 * that exists with `pinnedAt` null was created by the notice claim and reads
 * exactly like no row.
 * @param {object|null|undefined} projConfig - A config as returned by `load`
 * @param {{pinnedMode: ('operator'|null), pinnedAt: (string|null)}|null} [pin] - The project's recovery
 *   state row from the store, or null when it has none
 * @param {object} [options]
 * @param {boolean} [options.advisoryDefault=false] - Whether advisory is the default for a project with no
 *   decision on record. Anything but exactly `true` means it is not.
 * @returns {{mode: 'operator'|'advisory', source: 'pinned'|'chosen'|'inherited'|'launchSequence'|'default'|'not-armed'|'invalid', warning?: string, discrepancy?: string}}
 */
function resolveRecoveryMode(projConfig, pin, options) {
  const raw = projConfig && projConfig.launchSequence ? projConfig.launchSequence.recoveryMode : undefined;
  const value = raw === null ? undefined : raw;
  const fileSays = value === undefined ? 'no recoveryMode' : `recoveryMode ${JSON.stringify(value)}`;
  const decided = Boolean(pin && pin.pinnedAt);
  if (decided && pin.pinnedMode === 'operator') {
    if (value === 'operator') return { mode: 'operator', source: 'pinned' };
    return {
      mode: 'operator',
      source: 'pinned',
      discrepancy: `the operator pinned this project to operator-cleared recovery, and project.json holds ${fileSays}; the pin decides`
    };
  }
  if (value !== undefined && !RECOVERY_MODES.includes(value)) {
    const warning = `launchSequence.recoveryMode ${JSON.stringify(value)} is not one of ${RECOVERY_MODES.join(', ')}; `
      + 'recovery stays operator-cleared';
    // With no decision on record there is nothing for the file to disagree
    // with: it is a bad value, and the warning says so. Only against a
    // recorded choice of advisory is it also a discrepancy.
    if (!decided) return { mode: 'operator', source: 'invalid', warning };
    return {
      mode: 'operator',
      source: 'invalid',
      warning,
      discrepancy: `the operator chose advisory recovery, and project.json holds an unrecognised ${fileSays}; recovery stays operator-cleared until the file is corrected`
    };
  }
  if (decided) {
    if (value !== 'operator') return { mode: 'advisory', source: 'chosen' };
    return {
      mode: 'advisory',
      source: 'chosen',
      discrepancy: `the operator chose advisory recovery, and project.json still holds ${fileSays}; the operator's choice decides`
    };
  }
  if (!options || options.advisoryDefault !== true) {
    if (value !== 'advisory') return { mode: 'operator', source: 'not-armed' };
    return {
      mode: 'operator',
      source: 'not-armed',
      warning: 'launchSequence.recoveryMode is "advisory" with no operator decision on record, and a project file '
        + "chooses advisory recovery only while TangleClaw's login is in force; recovery stays operator-cleared. "
        + 'The operator can choose advisory for this project with PATCH /api/projects/:name'
    };
  }
  if (value === undefined) return { mode: 'advisory', source: 'default' };
  if (value === 'operator') return { mode: 'advisory', source: 'inherited' };
  return { mode: 'advisory', source: 'launchSequence' };
}

/**
 * Whether a wrap keeps its session running, and where that answer came from.
 *
 * Only a boolean the request explicitly carries overrides; nothing is coerced.
 * Without one, the project's `wrapKeepSessionRunning` decides, and a config or
 * key that is simply absent means `false`, a wrap's long-standing default
 * (#1558). A config that could not be read, or a value that is not a boolean,
 * answers neither way: ending the session is irreversible and keeping it
 * contradicts #1558, so the wrap is refused before it claims anything and the
 * operator fixes the setting.
 *
 * @param {*} requested - The request's `keepSessionRunning`, as sent
 * @param {object|null|undefined} projConfig - A config as returned by `load`
 * @param {{readFailed?: boolean}} [read] - Whether `load` reported the file unreadable
 * @returns {{ok: true, keep: boolean, source: 'request'|'project'|'default'} | {ok: false, error: string}}
 */
function resolveKeepSessionRunning(requested, projConfig, read = {}) {
  if (typeof requested === 'boolean') return { ok: true, keep: requested, source: 'request' };
  if (read.readFailed === true) {
    return {
      ok: false,
      error: '.tangleclaw/project.json could not be read, so whether this wrap should end the session is unknown. '
        + 'Fix the file, or send options.keepSessionRunning explicitly.'
    };
  }
  const value = projConfig ? projConfig.wrapKeepSessionRunning : undefined;
  if (value === undefined || value === null) {
    return { ok: true, keep: false, source: 'default' };
  }
  if (typeof value === 'boolean') return { ok: true, keep: value, source: 'project' };
  return {
    ok: false,
    error: `wrapKeepSessionRunning in .tangleclaw/project.json is ${JSON.stringify(value)}, not true or false, `
      + 'so whether this wrap should end the session is unknown. Fix the setting, or send options.keepSessionRunning explicitly.'
  };
}

/**
 * What a wrap run will do to its session if it completes, read from the
 * options `startWrap` resolved (#1708). The one derivation the 202, the stream's
 * `run-start` and `GET /wrap/status` share, so they cannot disagree: a run whose
 * options carry no resolved boolean answers null everywhere, never a guessed `end`.
 *
 * @param {object|null|undefined} options - A run's options
 * @returns {{sessionOutcomePlanned: ('end'|'keep'|null), keepSource: (string|null)}}
 */
function plannedSessionOutcome(options) {
  const keep = options ? options.keepSessionRunning : undefined;
  if (typeof keep !== 'boolean') return { sessionOutcomePlanned: null, keepSource: null };
  return {
    sessionOutcomePlanned: keep ? 'keep' : 'end',
    keepSource: typeof options.keepSource === 'string' ? options.keepSource : null
  };
}

module.exports = {
  load,
  resolveKeepSessionRunning,
  plannedSessionOutcome,
  DEFAULT_PROJECT_CONFIG,
  RELEASE_MODES,
  resolveReleaseMode,
  nextReleaseMode,
  PASTE_RULES_MODES,
  RECOVERY_MODES,
  UNREADY_WINDOW_MIN_MINUTES,
  UNREADY_WINDOW_MAX_MINUTES,
  resolvePasteRules,
  resolveUnreadyWindow,
  resolveRecoveryMode,
  WORKLOAD_NUDGE_DEFAULTS,
  WORKLOAD_NUDGE_KEYS,
  WORKLOAD_NUDGE_TEXT_MAX,
  WORKLOAD_NUDGE_COORDINATOR_MAX,
  WORKLOAD_NUDGE_ESCALATE_MIN_MINUTES,
  WORKLOAD_NUDGE_ESCALATE_MAX_MINUTES,
  isSafeLineText,
  workloadNudgeProblem,
  resolveWorkloadNudge
};
