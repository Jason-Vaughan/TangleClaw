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
  // #318: opt-out for the `version-bump` wrap step. Default true (existing
  // behavior). Projects that manage their own versioning (e.g. a non-semver
  // scheme via their own tooling) set this false so TC doesn't try to bump.
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
  // The `wrapV2` flag is retired: the wrap pipeline is the only wrap path
  // (`lib/sessions.js:triggerWrap` → `lib/wrap-pipeline.js:runWrapPipeline`),
  // so the flag is no longer seeded into project configs and any stale
  // `wrapV2` key still on disk is ignored by every reader.
  // Test/lint commands the wrap pipeline shells out to in Chunks 4–5.
  // Explicit declaration avoids auto-detection's monorepo / multi-stack
  // failure modes (Notse-class projects with `cd helper && pytest && cd
  // ../app && npm test`). `null` means "this project has no command to
  // run"; the relevant step kind logs and skips when the command is null.
  testCommand: null,
  lintCommand: null,
  // #139 Chunk 9 — last successful wrap commit SHA. Stamped by the
  // `commit` step (`lib/wrap-steps/commit.js`) after a successful
  // single-transaction commit. Lets a step that needs "what changed this
  // session" (e.g. lint scoping) replace a `HEAD~10..HEAD` guess with a
  // true `<lastWrapSha>..HEAD` range. `null` means "this project has never been wrapped" — the
  // fallback path is still authoritative for that case.
  lastWrapSha: null
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

module.exports = { load, DEFAULT_PROJECT_CONFIG };
