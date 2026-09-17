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
  launchSequence: {
    pasteRules: 'pull',
    unreadyWindowMinutes: 10
  },
  // #1502: a shell command the `commit` step runs when this wrap cuts a release,
  // after the bump and CHANGELOG promotion are on disk and before the commit.
  // It updates whatever else the project's release needs (README install pins,
  // a lockfile) and the files it changes go into the wrap commit. It gets the
  // release in TANGLECLAW_RELEASE_VERSION / TANGLECLAW_RELEASE_PREVIOUS. A
  // non-zero exit stops the commit and puts the bump back. null = nothing to run.
  releasePrepareCommand: null
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

module.exports = {
  load,
  DEFAULT_PROJECT_CONFIG,
  RELEASE_MODES,
  resolveReleaseMode,
  nextReleaseMode,
  PASTE_RULES_MODES,
  UNREADY_WINDOW_MIN_MINUTES,
  UNREADY_WINDOW_MAX_MINUTES,
  resolvePasteRules,
  resolveUnreadyWindow
};
