'use strict';

/**
 * Project Master (chunk G, #331) — ONE persistent global AI assistant above
 * all projects: a read-only cross-project control plane.
 *
 * Architecture (ratified 2026-06-16, spec .prawduct/artifacts/g-project-master.md):
 * the master is HARNESS-SESSION-BACKED — a persistent Claude Code session in a
 * reserved tmux session, NOT a TC-owned LLM chat loop. It lives in a dedicated
 * home directory (`~/.tangleclaw/master/` — never a repo clone, which would
 * share git HEAD with dev sessions) and talks to TC through the HTTP API.
 *
 * Deliberately NOT a `sessions` table row and NOT a project: the wrap
 * pipeline, idle watchdog, dashboard cards, and ownership objects all key on
 * projects, and none of them apply — the master is a parallel singleton with
 * its own API routes. Its identity ships as a TC-generated CLAUDE.md in
 * the master home (Claude Code reads it natively — no prime/hook delivery
 * machinery), regenerated on every ensure so guide/token/rules changes
 * propagate.
 *
 * The Hard-rules boundary is stored as editable `session_rules` rows (kind
 * 'master', project_id NULL) with the full D1b version-history machinery;
 * `MASTER_BASELINE_RULES` is the shipped baseline they seed from and restore
 * to. On the Claude engine the read-only boundary is STRUCTURAL, not just
 * instructional: every ensure regenerates `.claude/settings.json` plus a
 * PreToolUse guard hook in the master home that hard-denies Edit/Write/
 * NotebookEdit outside `memory/` — the sole write carve-out (the master's
 * durable memory). The guard covers `.claude/` itself, so the master cannot
 * edit away its own guardrails. Other engines fall back to instructional
 * enforcement and the status API says so honestly.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tmux = require('./tmux');
const store = require('./store');
const engines = require('./engines');
const sessions = require('./sessions');
const { createLogger } = require('./logger');
const { effectiveServerProtocol, effectiveServerPort } = require('./https-setup');

const log = createLogger('master');

/** Reserved tmux session name for the Project Master. Never collides with
 *  project sessions: project tmux names come from project records, and the
 *  session machinery never sees this name (no `sessions` row). */
const MASTER_TMUX_SESSION = 'tangleclaw-master';

/**
 * The shipped Hard-rules baseline. Seeded into `session_rules` (kind 'master')
 * when no master rows exist, and re-derived verbatim by Restore defaults —
 * this constant IS the safety story: no matter how the editable rows are
 * edited or disabled, the boundary text can always be recovered from code,
 * and `buildMasterClaudeMd` falls back to it whenever zero enabled rules
 * remain (the boundary cannot be emptied from the UI).
 * @type {string[]}
 */
const MASTER_BASELINE_RULES = [
  '**Read-only.** Use only GET endpoints. Never call mutating endpoints' +
    ' (POST/PATCH/DELETE) — including session launch/kill/wrap, config changes,' +
    ' port leases, and shared-doc locks. When an action is needed, describe the' +
    ' exact step for the operator to take instead.',
  // Phrased so the RESTRICTIVE reading survives on its own. Rule [0] above
  // bounds the API and is unconditional; this one bounds the filesystem, which
  // the access level now governs — so it points at that section rather than
  // asserting an absolute the operator may have deliberately lifted. A reader
  // who never reaches the section still reads "do not edit outside this
  // directory", which is the safe default and the correct one at two of the
  // three tiers. Changing this constant does not rewrite an operator's edited
  // row: it seeds fresh installs and is what Restore defaults recovers.
  '**Do not edit files outside this directory unless your access level allows it**' +
    ' — see "Your current access level" above, which is regenerated and authoritative.' +
    ' Durable notes belong under `memory/`, which is writable at every level. You have' +
    ' no project working tree by design — do not go looking for one.',
  "For per-project code questions, direct the operator to that project's own" +
    ' session; you report status, you do not do project work.'
];

/** Access levels the settings surface knows about.
 *  @type {string[]} */
const MASTER_ACCESS_LEVELS = ['read-only', 'suggest', 'write'];

/**
 * Access levels actually selectable.
 *
 * All three now, because all three carry real enforcement: the write guard
 * reads the level per tool call and maps it to deny / ask / allow. The rule
 * this list exists to hold has NOT relaxed — a tier ships only WITH its
 * structural enforcement, never as a prose-only boundary — so keep the
 * `validateMasterPatch` gate that reads this even while the two lists are
 * equal. It is what refuses a fourth tier added to `MASTER_ACCESS_LEVELS`
 * before someone teaches the guard what it means.
 * @type {string[]}
 */
const MASTER_ENABLED_ACCESS_LEVELS = ['read-only', 'suggest', 'write'];

/**
 * Path to the master's access-level file — the ONE place the write guard
 * reads its posture from.
 *
 * A plain file in the master home rather than TangleClaw's config, and both the
 * writer and the generated guard resolve it through this function so they
 * cannot disagree about where it lives. Two reasons it is not TC's config:
 * the guard should not have to know TC's internals to stay correct, and a
 * format change in the config store must not be able to break the boundary.
 *
 * Deliberately a sibling of `memory/`, never inside it. `memory/` is the
 * master's own write carve-out, so a level file placed there would be a level
 * file the master could raise for itself.
 *
 * @param {string} home - Absolute master home path
 * @returns {string} Absolute path to the access-level file
 */
function masterAccessLevelPath(home) {
  return path.join(home, '.access-level');
}

/**
 * Write the master's current access level where the guard will read it.
 *
 * Called on every identity refresh AND whenever the level changes, because the
 * two answer different questions: the refresh keeps the file true across
 * restarts, while the change-path is what makes a flip bind on the master's
 * very next tool call with no restart and no re-ensure.
 *
 * Writes a single trimmed token and nothing else. The format is deliberately
 * not JSON: the guard's whole job is to be readable by a process that must
 * never crash, and a parser is a failure mode the boundary does not need. An
 * unrecognized token is not rejected here — the guard treats anything it does
 * not recognize as read-only, which is the restrictive direction.
 *
 * @param {string} home - Absolute master home path
 * @param {string} level - One of MASTER_ACCESS_LEVELS
 * @returns {void}
 */
function writeMasterAccessLevel(home, level) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(masterAccessLevelPath(home), `${level}\n`);
}

/**
 * Push a changed access level to the live master so it binds on the next tool
 * call — the change path, as opposed to `refreshMasterIdentity`'s restart path.
 *
 * A named entry point on this module rather than inline filesystem work at the
 * call site, for the reason the fleet refresher moved here: `home` then resolves
 * in ONE place, and a route test can stub this export instead of writing the
 * operator's real `~/.tangleclaw/master/`. That is not hypothetical — an earlier
 * shape of this let `PATCH /api/config` tests rewrite the live master's posture,
 * the same defect that once let a route test overwrite the real `FLEET.md`.
 *
 * Absent home is a no-op, not an error: an operator who has never opened the
 * master must not get master state created by saving unrelated settings, and
 * nothing is lost — the first ensure writes the level from config.
 *
 * @param {string} level - One of MASTER_ACCESS_LEVELS
 * @param {object} [options]
 * @param {string} [options.home] - Master home override (tests)
 * @param {object} [options.config] - Global config override (tests)
 * @param {object} [options.enginesLib] - engines module override (tests)
 * @returns {{applied: boolean, home: string, enforcement?: string}}
 *   `applied: false` when no master home exists yet.
 */
function applyMasterAccessLevel(level, options = {}) {
  const home = options.home || masterHome();
  if (!fs.existsSync(home)) return { applied: false, home };
  // Resolve BEFORE writing the level, so the two failure classes stay separable
  // for the caller's error message. A config-load or engine-resolution failure
  // now happens with the OLD level still on disk — so "still enforcing <old>" is
  // true. Once the level is written the guard reads it on its next call, and any
  // later failure has to say something different.
  // Regenerate the guard too, whenever this home has one.
  //
  // Not redundant with writing the level, and the reason is the `write` tier
  // itself: at `write` the guard permits edits to every path including its own
  // hook file, so a master that has been at `write` may have altered or deleted
  // the very script that is supposed to bind it again. Rewriting only
  // `.access-level` on the way back to `read-only` would then revoke nothing
  // until the next ensure — a toggle that reports a boundary it did not
  // restore, which is the failure this whole issue exists to remove.
  //
  // Keyed on ENFORCEMENT, never on the guard file being present. Keying on the
  // file was the obvious-looking version and it was wrong in the one direction
  // that matters: the artifact it tested is the exact artifact the threat
  // removes. A master at `write` may delete the hook outright, not merely blank
  // it — and under the bypassPermissions launch mode an `rm` is not confirmed
  // either — after which revocation would write only `.access-level`, report
  // success, and bind nothing until the next ensure. `enforcement` is derived
  // from the resolved engine, so it cannot be tampered with from inside the
  // master home, and it is the same predicate the ensure path uses.
  //
  // Instructional masters still get no guard: that is what `enforcement`
  // already means, so the change path cannot hand a non-Claude master a
  // structural boundary it never had. Regeneration is idempotent, so the common
  // case (nothing was touched) rewrites identical bytes.
  const { enforcement } = _masterRuntime(
    options.config || store.config.load(), options.enginesLib
  );

  writeMasterAccessLevel(home, level);

  if (enforcement === 'structural') {
    try {
      _writeMasterGuardrails(home);
    } catch (err) {
      // The level IS applied by this point — the guard reads it per call — so a
      // failure here is "the new level is in force but a tampered guard may not
      // have been restored", which is a different sentence from "nothing
      // changed". Flagged rather than described, so the route can say the true
      // one instead of guessing which failure it caught.
      err.levelApplied = true;
      throw err;
    }
  }
  return { applied: true, home, enforcement };
}

/**
 * Every launch-mode id any installed engine defines, plus `'default'`.
 *
 * The union rather than one engine's set, because the stored mode is
 * deliberately allowed to outlive an engine switch: an operator who picks
 * `acceptEdits` on Claude, switches the Master to Aider, and switches back must
 * find their choice intact rather than flattened to `default` on the way past.
 * `_masterRuntime` reconciles at launch, so validation here only has to refuse
 * a mode NO engine has ever heard of — which is a typo, not a preference.
 *
 * `'default'` is included unconditionally: every engine defines it, and it must
 * stay valid on a machine with no engines installed at all.
 *
 * @returns {string[]} Sorted mode ids.
 */
function knownLaunchModes() {
  const seen = new Set(['default']);
  for (const profile of store.engines.list()) {
    const modes = profile && profile.launchModes;
    if (!modes || typeof modes !== 'object') continue;
    for (const mode of Object.keys(modes)) seen.add(mode);
  }
  return [...seen].sort();
}

/**
 * Resolve the master's home directory (its session cwd and identity root).
 * @returns {string} Absolute path to the master home
 */
function masterHome() {
  return path.join(os.homedir(), '.tangleclaw', 'master');
}

/**
 * Normalize the master settings block out of global config, applying the
 * shipped defaults for anything missing (config-file merge is shallow, so a
 * hand-edited partial object must not surface as undefined fields).
 * @param {object} config - Global config (store.config.load())
 * @returns {{accessLevel: string, engine: string|null, launchMode: string,
 *            scope: (string|{type: string, groupId: string}), autoStart: boolean}}
 */
function masterSettings(config) {
  const raw = (config && typeof config.master === 'object' && config.master) || {};
  return {
    accessLevel: MASTER_ACCESS_LEVELS.includes(raw.accessLevel) ? raw.accessLevel : 'read-only',
    engine: typeof raw.engine === 'string' && raw.engine ? raw.engine : null,
    // The STORED mode, unreconciled — what the operator picked, which may be a
    // mode the currently-resolved engine cannot honor (they switched engines
    // afterwards). `_masterRuntime` reconciles; keeping the raw choice here
    // means switching back to an engine that honors it restores it rather than
    // silently flattening the setting to 'default' on the way past (#756).
    launchMode: typeof raw.launchMode === 'string' && raw.launchMode ? raw.launchMode : 'default',
    scope: raw.scope && raw.scope !== 'all' ? raw.scope : 'all',
    autoStart: raw.autoStart === true
  };
}

/**
 * Resolve the master's effective runtime facts from config in ONE place —
 * `ensureMasterSession` and `getMasterStatus` must never derive engine or
 * enforcement independently (a lockstep hazard once a second enforced tier
 * ships).
 * @param {object} config - Global config (store.config.load())
 * @param {object} [enginesLib] - engines module override (tests); must be the
 *   same lib the caller uses for detection, or resolution and availability could
 *   disagree — that split is what made two of these tests depend on which CLIs
 *   the host machine happened to have installed.
 * @returns {{settings: object, engineId: string|null, enforcement: string, launchMode: string}}
 *   `launchMode` is the RECONCILED mode (what will actually run); the stored
 *   choice stays on `settings.launchMode`.
 */
function _masterRuntime(config, enginesLib) {
  const settings = masterSettings(config);
  // Resolve against what is actually installed rather than falling back to a
  // hardcoded 'claude': on a machine without Claude Code the master refused to
  // launch with "binary not found" even though another engine was available and
  // the operator had chosen it in the wizard. `null` here means nothing is
  // installed at all, which `ensureMasterSession` reports as itself.
  // A partial stub (detection only) must not crash here — fall back to the real
  // module when the injected lib doesn't answer resolution.
  const resolver = (enginesLib && typeof enginesLib.resolveDefaultEngine === 'function')
    ? enginesLib : engines;
  // A pinned master engine goes through the SAME resolution as an unpinned one,
  // by standing in for `defaultEngine`. Honoring `settings.engine` directly was
  // the original bug wearing a different hat: an operator who pinned Claude in
  // Master settings, on a machine without Claude, got "binary not found" again —
  // the exact failure this resolver exists to prevent, reachable through a
  // second door. Precedence is therefore identical everywhere: the chosen engine
  // when installed, an unrecognized id passed through so the caller can name it,
  // otherwise the first installed engine, otherwise null.
  const engineId = settings.engine
    ? resolver.resolveDefaultEngine({ ...config, defaultEngine: settings.engine })
    : resolver.resolveDefaultEngine(config);
  // Structural enforcement is a Claude-engine capability (settings.json +
  // PreToolUse hooks); other engines run the same instructional identity and
  // the API reports the difference instead of pretending.
  const enforcement = engineId === 'claude' ? 'structural' : 'instructional';
  // Reconciled HERE, for the same reason engine and enforcement are: `ensure`
  // and `getMasterStatus` must not derive it independently, or the settings
  // modal shows one mode while the session launches under another. A mode the
  // effective engine cannot honor becomes 'default' — the universally-valid
  // interactive mode every engine defines — rather than being passed through to
  // a flag the CLI would reject (#756, and the honest-degradation bar #741 set).
  const profile = engineId ? store.engines.get(engineId) : null;
  const reconciler = (enginesLib && typeof enginesLib.reconcileLaunchMode === 'function')
    ? enginesLib : engines;
  const launchMode = reconciler.reconcileLaunchMode(settings.launchMode, profile);
  if (launchMode !== settings.launchMode) {
    // Debug, not warn: `getMasterStatus` runs on every poll, so a warn here
    // would report a stable condition at the poll's cadence rather than the
    // condition's — the defect #906 exists to prevent. The status payload
    // carries both values, so the operator-facing surface is the modal.
    log.debug('Master launch mode not honored by the resolved engine — using default', {
      stored: settings.launchMode, resolved: launchMode, engine: engineId
    });
  }
  return { settings, engineId, enforcement, launchMode };
}

/**
 * Resolve the master's scope into render-ready facts. Group scope resolves the
 * group and its member projects; a scope pointing at a deleted group fails
 * safe to 'all' with a warning (never a crash at identity-generation time).
 * @param {string|{type: string, groupId: string}} scope - Normalized scope value
 * @returns {{kind: string, groupName?: string, projects?: object[], warning?: string}}
 */
function _resolveScope(scope) {
  if (!scope || scope === 'all') return { kind: 'all' };
  if (scope.type === 'group' && scope.groupId) {
    const group = store.projectGroups.get(scope.groupId);
    if (!group) {
      log.warn('Master scope group not found — falling back to all projects', { groupId: scope.groupId });
      return { kind: 'all', warning: 'The configured scope group no longer exists; scope fell back to all projects.' };
    }
    // listMembers returns project ids; resolve to project records (deleted
    // projects drop out — membership rows cascade, but stay defensive).
    const projects = store.projectGroups.listMembers(scope.groupId)
      .map((id) => store.projects.get(id))
      .filter(Boolean);
    return { kind: 'group', groupName: group.name, projects };
  }
  return { kind: 'all' };
}

/**
 * Baseline rule texts this build has SUPERSEDED, keyed to the rule that
 * replaced them.
 *
 * Seeding only ever runs on an empty table, so a shipped baseline that changes
 * later reaches exactly nobody: every install that has opened the Master once
 * keeps the original row forever. That was tolerable while the baseline only
 * ever got clearer. It stopped being tolerable when a rule became FALSE at a
 * newly-selectable tier — an existing install would render "Never edit files
 * outside this directory" and "you may create and edit files anywhere" into the
 * same generated file, and on a non-Claude master that contradiction is the
 * whole boundary.
 *
 * Only rows still byte-identical to a superseded text are migrated. A row the
 * operator has touched is theirs, and silently rewriting it would be the
 * destroy-an-edit failure this design exists to avoid — those are left alone and
 * reported, so the contradiction surfaces as a log line rather than as a master
 * acting on stale instructions.
 * @type {Array<{was: string, now: string}>}
 */
const SUPERSEDED_BASELINE_RULES = [
  {
    was: '**Never edit files outside this directory.** Your home is your only writable'
      + ' surface, and durable notes belong under `memory/`. You have no project'
      + ' working tree by design — do not go looking for one.',
    now: MASTER_BASELINE_RULES[1]
  }
];

/**
 * Bring unedited baseline rows up to the current shipped text.
 *
 * @returns {number} How many rows were migrated.
 */
function _migrateSupersededMasterRules() {
  let migrated = 0;
  const existing = store.sessionRules.list({ kind: 'master' });
  for (const { was, now } of SUPERSEDED_BASELINE_RULES) {
    if (now === undefined || was === now) continue;
    for (const rule of existing) {
      if (rule.content !== was) continue;
      store.sessionRules.update(rule.id, {
        content: now,
        changedBy: 'system',
        changeReason: 'shipped baseline superseded — access level now governs the file boundary (#755)'
      });
      migrated += 1;
    }
  }
  if (migrated > 0) log.info('Migrated superseded master baseline rules', { migrated });
  // The other half of the promise in this function's doc, and the one that
  // actually needs saying: a row the operator edited from a superseded baseline
  // is left alone BY DESIGN, which means their text may now contradict the live
  // access level. Silence there would leave the master acting on stale
  // instructions with nothing anywhere to notice it.
  for (const { was } of SUPERSEDED_BASELINE_RULES) {
    for (const rule of existing) {
      if (rule.content === was || !rule.content.startsWith(was.slice(0, 60))) continue;
      log.warn('Master Hard rule looks edited from a superseded baseline — it may contradict the current access level', {
        ruleId: rule.id, hint: 'Restore defaults recovers the shipped text'
      });
    }
  }
  return migrated;
}

/**
 * Seed the shipped Hard-rules baseline into `session_rules` when NO master
 * rows exist (enabled or not) — idempotent, so an operator who deleted or
 * disabled individual rules is never overridden by a later ensure. Seeded
 * rows carry created_by 'system' (provenance: shipped baseline, and the UI's
 * eyes-open-confirm marker) and critic_gate 'not-required'.
 *
 * When rows DO exist it still runs {@link _migrateSupersededMasterRules}: a
 * shipped text that changed later would otherwise reach nobody who has already
 * opened the Master.
 * @returns {number} Rows seeded (0 when rows already existed, migration or not)
 */
function seedBaselineMasterRules() {
  const existing = store.sessionRules.list({ kind: 'master' });
  if (existing.length > 0) {
    // Rows exist, so seeding is done — but a shipped text may have been
    // superseded since they were written, and nothing else would ever reconcile
    // them. Returns 0 either way: the contract of this function is "how many
    // rules were SEEDED", and a migration is not a seed.
    _migrateSupersededMasterRules();
    return 0;
  }
  for (const content of MASTER_BASELINE_RULES) {
    store.sessionRules.create({
      content,
      kind: 'master',
      createdBy: 'system',
      criticGate: 'not-required',
      changeReason: 'seeded from shipped baseline'
    });
  }
  log.info('Master Hard-rules baseline seeded', { rules: MASTER_BASELINE_RULES.length });
  return MASTER_BASELINE_RULES.length;
}

/**
 * Restore defaults: snapshot-delete every master rule row (history survives in
 * `session_rule_versions` — provenance outlives the rule) and re-seed the
 * shipped baseline. This is the recovery path if an edit ever weakens the
 * boundary rules.
 * @param {object} [opts]
 * @param {string} [opts.changedBy] - Who triggered it ('operator' default)
 * @returns {object[]} The freshly seeded baseline rules
 */
function restoreDefaultMasterRules(opts = {}) {
  const existing = store.sessionRules.list({ kind: 'master' });
  for (const rule of existing) {
    store.sessionRules.delete(rule.id, {
      changedBy: opts.changedBy || 'operator',
      changeReason: 'restore defaults — replaced by shipped baseline'
    });
  }
  seedBaselineMasterRules();
  return store.sessionRules.list({ kind: 'master' });
}

/**
 * Render rule contents as markdown bullets. Single-line rules become one
 * bullet; continuation lines are indented under theirs.
 * @param {string[]} contents - Rule content strings
 * @returns {string[]} Markdown lines
 */
function _renderRuleBullets(contents) {
  const out = [];
  for (const content of contents) {
    const lines = String(content).split('\n');
    out.push(`- ${lines[0]}`);
    for (const cont of lines.slice(1)) out.push(`  ${cont}`);
  }
  return out;
}

/**
 * The generated, non-editable statement of what the master may write right now.
 *
 * Separate from the Hard rules on purpose. The rules are the OPERATOR's text —
 * editable, versioned, restorable — and rewriting them to track a setting would
 * either destroy an operator's edit or leave their edit contradicting the live
 * posture. This block is derived at generation time instead, so the two never
 * fight: the rules say what the master should not do, this says what it
 * currently CAN do.
 *
 * It also carries the honest degradation. On the Claude engine the boundary is
 * structural and a level change binds on the next tool call; everywhere else
 * this prose IS the boundary, and it only reaches the master when the identity
 * is regenerated — which is the next ensure, not the next tool call. Saying so
 * is the difference between a degraded capability and a silently false one.
 *
 * @param {string} level - One of MASTER_ACCESS_LEVELS
 * @param {string} enforcement - 'structural' | 'instructional'
 * @returns {string[]} Markdown lines
 */
function _renderAccessLevelSection(level, enforcement) {
  const structural = enforcement === 'structural';
  const body = {
    'read-only': [
      'You may **not** create or edit files outside `memory/`. Attempts are refused.',
      'When a change is needed, describe the exact step for the operator to take.'
    ],
    suggest: [
      'You may **attempt** writes anywhere, and each one outside `memory/` stops for',
      'the operator to confirm or decline in this terminal. Propose freely; nothing',
      'lands without their answer. Do not treat a refusal as an error to work around.'
    ],
    write: [
      'You may create and edit files anywhere you can reach, across every project,',
      'without asking first. This is a deliberate grant and it is revocable at any',
      'moment. Prefer the smallest change that does the job, say what you changed,',
      'and record it in `memory/CHANGELOG.md`.'
    ]
  }[level] || [
    'Your access level could not be determined, so you are read-only: you may not',
    'create or edit files outside `memory/`.'
  ];

  return [
    '## Your current access level',
    '',
    `**${level}** — ${structural ? 'structurally enforced' : 'instructional only'}.`,
    '',
    ...body,
    '',
    // Named to the master, because the gap is real and it is the one place a
    // well-meaning agent would walk straight through: the hook matches the
    // file-editing tools, so a shell redirect is not covered by it. Saying
    // "structurally enforced" without this would overstate what ships.
    ...(structural
      ? [
        'Your level is checked by a write guard on every attempt, so a change the',
        'operator makes takes effect on your very next tool call. That guard covers',
        'the file-editing tools; shell commands are not hooked, so reaching for one to',
        'do what it refused is working around the boundary, not around a bug.'
      ]
      : [
        'On this engine there is no write guard at all — not for the file-editing',
        'tools and not for shell commands. Nothing mechanically stops a write, so this',
        'boundary holds only because you honor it, including when a shell command',
        'would be the easy way past it. A change the operator makes reaches you when',
        'this file is regenerated, not immediately.'
      ]),
    ''
  ];
}

/**
 * Build the master's CLAUDE.md identity file content.
 *
 * Pure given its inputs. Mirrors the per-project generated-config conventions:
 * a marker header (so hand-edits are visibly futile), the TC API base URL,
 * and — when the AUTH-4 M2M gate is on — the bearer-token Authentication
 * block for the gated PortHub/shared-docs surfaces (same contract as
 * engines._serviceTokenAuthLines).
 *
 * @param {object} config - Global config (store.config.load())
 * @param {object} [extras] - Pre-resolved dynamic content
 * @param {object[]} [extras.rules] - Active master rules ({content}); zero
 *   enabled rules → the shipped baseline renders instead (fail-safe: the
 *   boundary cannot be emptied)
 * @param {object} [extras.scope] - Resolved scope from _resolveScope();
 *   omitted → 'all'
 * @param {string} [extras.accessLevel] - Current access level; omitted → read
 *   from config, so callers that already resolved it do not resolve it twice
 *   and callers that did not still get the true value rather than a default.
 * @param {string} [extras.enforcement] - 'structural' | 'instructional';
 *   omitted → derived from config for the same reason.
 * @returns {string} CLAUDE.md content
 */
function buildMasterClaudeMd(config, extras = {}) {
  // Both halves of the base URL must match what the server actually serves, not
  // what config intends: the plist's TANGLECLAW_PORT overrides config.serverPort,
  // and caddy mode / no-cert installs bind plain HTTP even with httpsEnabled
  // (ENG-5R2W).
  const serverPort = effectiveServerPort(config);
  const serverProtocol = effectiveServerProtocol(config);
  const baseUrl = `${serverProtocol}://localhost:${serverPort}`;
  const tokenActive = !!(config.serviceTokenEnabled && config.serviceToken);

  const ruleContents = (extras.rules && extras.rules.length > 0)
    ? extras.rules.map((r) => r.content)
    : MASTER_BASELINE_RULES;
  const scope = extras.scope || { kind: 'all' };

  // Derived here when the caller did not resolve it, rather than defaulted to
  // 'read-only'. A default would be the safe-looking choice and the wrong one:
  // it would render "you are read-only" into the identity of a master the
  // operator had set to `write`, which is a boundary claim that disagrees with
  // the guard — and on an instructional engine that prose IS the boundary.
  const resolved = (extras.accessLevel && extras.enforcement)
    ? { level: extras.accessLevel, enforcement: extras.enforcement }
    : (() => {
      const rt = _masterRuntime(config);
      return { level: rt.settings.accessLevel, enforcement: rt.enforcement };
    })();

  const lines = [
    '<!-- Generated by TangleClaw — Project Master identity. Regenerated on every',
    '     master ensure; hand-edits will be overwritten. -->',
    '',
    '# CLAUDE.md — TangleClaw Project Master',
    '',
    // "administrator" without "read-only": what the master may WRITE is now a
    // setting, and stating it here as a fixed trait would contradict the access
    // level section below at two of the three tiers. What has NOT changed is the
    // API posture — the master still only reads the API at every tier — so that
    // half stays asserted flatly.
    'You are the **TangleClaw Project Master**: the administrator of this whole',
    'TangleClaw instance, above all projects. You answer cross-project questions',
    '("which projects have open PRs?", "what is stale?", "what sessions are live?")',
    'by querying the TangleClaw HTTP API, which you use read-only. You are NOT a',
    'project session: you have no project checkout, you own no code, and you never',
    'wrap.',
    '',
    ..._renderAccessLevelSection(resolved.level, resolved.enforcement),
    '## Hard rules',
    '',
    ..._renderRuleBullets(ruleContents),
    '',
    `**TangleClaw API base URL**: \`${baseUrl}\``,
    ''
  ];

  lines.push('## Scope', '');
  if (scope.kind === 'group') {
    lines.push(
      `You are scoped to the **${scope.groupName}** project group. In-scope projects:`,
      '',
      ...(scope.projects || []).map((p) => `- ${p.name}`),
      '',
      'Report on these projects only; if asked about others, say they are outside',
      'your configured scope. This is a focus setting, not a security boundary.',
      ''
    );
  } else {
    lines.push('All projects on this TangleClaw instance are in scope.', '');
    if (scope.warning) lines.push(`⚠ ${scope.warning}`, '');
  }

  lines.push(
    '## Memory',
    '',
    'Your durable memory lives at `memory/` inside your home — the ONE writable',
    'surface at every access level. No wrap pipeline runs for you; this directory',
    'is your only continuity across restarts.',
    '',
    '- `memory/MEMORY.md` — your index; keep it current.',
    '- `memory/FLEET.md` and `memory/HOWTO.md` — maintained by TangleClaw and',
    '  refreshed on every ensure; read them, never edit them (overwritten).',
    '- `memory/CHANGELOG.md` — YOUR activity log: record what you did, which',
    '  projects it touched, and when.',
    '- `memory/NOTES.md` — learned notes worth keeping.',
    ''
  );

  if (tokenActive) {
    lines.push(
      '## Authentication',
      '',
      'The PortHub (`/api/ports*`) and shared-docs (`/api/shared-docs*`) surfaces',
      'require a bearer token. Send this header on those requests:',
      '',
      '```',
      `Authorization: Bearer ${config.serviceToken}`,
      '```',
      ''
    );
  }

  lines.push(
    '## Read API quick reference',
    '',
    `- \`GET /api/projects\` — all projects (engine, archived, groups).`,
    `- \`GET /api/sessions/:project/status\` — a project's live-session state.`,
    `- \`GET /api/activity\` — recent cross-project activity feed.`,
    `- \`GET /api/server-info\` — server sha/uptime/staleness.`,
    `- \`GET /api/system\` — host/system snapshot.`,
    `- \`GET /api/engines\` — configured engines.`,
    `- \`GET /api/ports\` — the PortHub port registry${tokenActive ? ' (bearer token)' : ''}.`,
    `- \`GET /api/shared-docs?groupId=<id>\` — a group's shared docs${tokenActive ? ' (bearer token)' : ''}.`,
    `- \`GET /api/continuity/:project/search?q=\` — search a project's session history.`,
    '',
    'Prefer `curl -s` + `jq`-style summaries; report concisely with project names.',
    ''
  );

  return lines.join('\n');
}

/**
 * Build the PreToolUse write-guard script content (Claude engine). Node, not
 * bash+jq — TC's only runtime guarantee is node.
 *
 * DEFAULT-DENY by construction: the harness treats hook crashes as fail-open,
 * so every failure path inside the script itself must end in an explicit deny.
 *
 * The access level is read from disk **per invocation**, not generated into the
 * script. That is what lets the operator flip READ/WRITE and have it bind on the
 * master's very next tool call — no restart, no re-ensure. It also means the
 * guard gains a new failure mode (missing / malformed / unreadable level), and
 * every one of those paths degrades to `read-only`. That direction is the whole
 * safety argument: a level-aware guard that fails OPEN would be strictly worse
 * than the baked-in one it replaces.
 *
 * The level maps to the three PreToolUse outcomes:
 *   read-only → deny outside memory/
 *   suggest   → ask outside memory/ (the operator confirms in the master's
 *               own terminal, which is what "propose, don't execute" means)
 *   write     → allow
 *
 * `write` makes the guard PERMIT; it never makes the guard absent. Skipping
 * generation for a permissive level would leave a stale read-only guard from an
 * earlier ensure silently in force, which is the same defect class as a control
 * that looks like it did something.
 *
 * @param {string} home - Absolute master home path
 * @returns {string} Script source
 */
function buildMasterGuardScript(home) {
  return `#!/usr/bin/env node
'use strict';
// Generated by TangleClaw — Project Master write guard. Regenerated on every
// master ensure; hand-edits will be overwritten.
//
// PreToolUse hook for Edit|Write|NotebookEdit. Emits the documented
// permissionDecision JSON on stdout (exit 0). The access level is read fresh
// from LEVEL_FILE on every call, so a level change binds on the next tool use
// with no restart. Any internal failure denies: the harness fails OPEN on hook
// crashes, so this script must never crash its way past the boundary, and it
// must never read its way past it either — an unreadable level is read-only.
const fs = require('fs');
const path = require('path');

const HOME = ${JSON.stringify(home)};
const LEVEL_FILE = ${JSON.stringify(masterAccessLevelPath(home))};

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

function deny(reason) { return decide('deny', reason); }

// Anything that is not recognizably 'suggest' or 'write' is read-only. That
// covers the file being absent, empty, a directory, unreadable, or holding a
// token from a newer TangleClaw this guard predates — all of which resolve in
// the restrictive direction rather than falling through to a write.
// The "degraded" flag marks a read-only reached by FAILING rather than by choice. The
// outcome is identical on purpose — that is the fail-closed property — but the
// operator debugging a master that will not write needs to tell "this is the
// posture I set" from "this guard cannot read its posture", and those two
// produced the same sentence.
function readLevel() {
  try {
    const token = String(fs.readFileSync(LEVEL_FILE, 'utf8')).trim();
    if (token === 'write' || token === 'suggest' || token === 'read-only') {
      return { level: token, degraded: false };
    }
    return { level: 'read-only', degraded: true };
  } catch (err) {
    return { level: 'read-only', degraded: true };
  }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const { level, degraded } = readLevel();
  const why = degraded
    ? ' The access level could not be read from ' + LEVEL_FILE +
      ', so the guard fell back to read-only — fix or recreate that file to restore the intended level.'
    : '';
  if (level === 'write') {
    return decide('allow', 'Project Master access level is "write".');
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    return deny('Write guard could not parse the tool input — refusing by default (Project Master is read-only outside memory/).');
  }
  const ti = (input && input.tool_input) || {};
  const target = ti.file_path || ti.notebook_path;
  if (!target || typeof target !== 'string') {
    return deny('No target path in the tool input — write refused (Project Master is read-only outside memory/).');
  }
  // BOTH sides go through realpath or neither works: on macOS /var is itself a
  // symlink to /private/var, so resolving only the target moves it out from
  // under a carve-out computed lexically, and every write into memory/ is
  // refused. Falls back to the lexical home if it cannot be resolved.
  let realHome = HOME;
  try { realHome = fs.realpathSync(HOME); } catch (err) { realHome = HOME; }
  const memoryDir = path.join(realHome, 'memory') + path.sep;
  // realpath, not just resolve. path.resolve normalises ".." lexically but does
  // NOT follow symlinks, so a link created inside the carve-out and pointing
  // anywhere else would pass the prefix test below and write outside it. The
  // target itself usually does not exist yet (it is about to be created), so
  // resolve the deepest EXISTING ancestor and re-attach the rest — that is the
  // part a link could redirect. Any failure here falls back to the lexical
  // path, which is the restrictive direction: an unresolvable path is not
  // inside memory/ and gets refused.
  const lexical = path.resolve(HOME, target);
  // UNRESOLVED means "this guard could not establish where the write lands", and
  // it is denied outright rather than handed to the prefix test below. Both ways
  // of getting there used to be PERMISSIVE, which is the failure this guard
  // exists to make impossible:
  //   - the hop counter running out left leaf still a symlink, whose parent is
  //     memory/, so the prefix test passed and a long chain wrote outside;
  //   - the catch fell back to the lexical path, which for anything under
  //     memory/ starts with memoryDir and therefore ALLOWS. "Fall back to
  //     lexical" only reads as restrictive for targets already outside.
  // The kernel follows far more links than this cap (MAXSYMLINKS is 32 on macOS,
  // 40 on Linux), so the cap must never be the thing that decides a write is
  // fine.
  let resolved = null;
  try {
    let leaf = lexical;
    let hops = 0;
    for (;;) {
      if (hops++ >= 16) { leaf = null; break; } // exhausted — unresolved
      let st;
      try {
        st = fs.lstatSync(leaf);
      } catch (err) {
        break; // nothing there — not a link; the ancestor pass handles it
      }
      if (!st.isSymbolicLink()) break;
      leaf = path.resolve(path.dirname(leaf), fs.readlinkSync(leaf));
    }
    if (leaf !== null) {
      // Then the ancestor pass, for ".." and for a linked DIRECTORY above a
      // target that does not exist yet.
      let dir = path.dirname(leaf);
      const tail = [path.basename(leaf)];
      while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
        tail.unshift(path.basename(dir));
        dir = path.dirname(dir);
      }
      resolved = path.join(fs.realpathSync(dir), ...tail);
    }
  } catch (err) {
    resolved = null;
  }
  if (resolved === null) {
    return deny('Project Master write refused: the guard could not establish where ' +
      lexical + ' actually lands (unresolvable or deeply nested symlinks).' + why);
  }
  if (resolved.startsWith(memoryDir)) {
    process.exit(0); // inside the carve-out — fall through to permission rules
  }
  // The guard's own control surface is never merely "ask" below the write tier.
  // Otherwise suggest contains its own escalation: one confirmation to edit
  // .access-level grants permanent write, and one to edit the hook or its
  // settings removes the boundary entirely — a tier whose whole point is that
  // each action is individually approved would be handing over ALL future
  // actions on a single click. At the write tier this is moot: full access
  // already. (No backticks in this comment: the script is built inside a
  // template literal, so one would end the string.)
  const control = [LEVEL_FILE, path.join(realHome, '.access-level'), path.join(realHome, '.claude')];
  if (control.some((c) => resolved === c || resolved.startsWith(c + path.sep))) {
    return deny('Project Master cannot modify its own access controls (' + resolved +
      '). Change the access level from TangleClaw settings instead.');
  }

  if (level === 'suggest') {
    return decide('ask', 'Project Master access level is "suggest": confirm this write to ' +
      resolved + ', or decline it.');
  }
  return deny('Project Master is read-only: writes are allowed only under ' +
    path.join(HOME, 'memory') + '. Refused: ' + resolved + why);
});
`;
}

/**
 * Write the structural guardrails into the master home (Claude engine only —
 * settings.json/hooks are Claude Code semantics). Regenerated on every ensure,
 * and on every level change, so posture changes propagate.
 *
 * `.claude/settings.json` auto-allows Edit/Write inside `memory/` and wires the
 * PreToolUse hook. What that hook DOES outside `memory/` is not fixed here — it
 * depends on the access level the hook reads at invocation: refuse at
 * `read-only`, ask at `suggest`, permit at `write`. At `read-only` the refusal
 * covers `.claude/` itself, so the guard protects its own config; at `write`, by
 * definition, it does not, which is why a level change regenerates this rather
 * than only rewriting the level file.
 *
 * Everything the hook does not decide falls to the harness ask-gate (operator
 * approval in the master terminal). Bash is deliberately NOT pattern-allowlisted:
 * command-pattern matching cannot reliably separate GET curls from mutating ones,
 * so Bash stays ask-gated rather than pretending.
 * @param {string} home - Absolute master home path
 */
function _writeMasterGuardrails(home) {
  const claudeDir = path.join(home, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'guard-writes.js'), buildMasterGuardScript(home), { mode: 0o755 });
  const settings = {
    permissions: {
      allow: ['Edit(./memory/**)', 'Write(./memory/**)']
    },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Edit|Write|NotebookEdit',
          hooks: [
            { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-writes.js"' }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
}

// ── The fleet map ──
// FLEET.md is the master's whole picture of what it coordinates. It used to
// carry name, engine and path — enough to say a project EXISTS, and nothing
// about what it is DOING, which is not a basis for coordinating anything.
//
// It now renders whatever state the caller managed to gather, and says plainly
// where it gathered none. Two callers, deliberately different:
//
//   - `_refreshMasterMemory` runs inside `refreshMasterIdentity`, which is
//     SYNCHRONOUS and runs at server boot. It passes the raw store rows. It
//     must never grow per-project git or tmux work: `git.getInfo` is several
//     `execSync` spawns per repository on a cold cache, and doing that across
//     the fleet on the event loop is the hazard the forked scanner exists to
//     prevent (#883/#884).
//   - `refreshFleetMap` is async and rides the enriched list the dashboard poll
//     already computes, so full state costs no new scanning at all.
//
// Which one wrote the file is derived from the records themselves rather than
// passed as a flag, because a flag can disagree with its data.

/**
 * Does this record carry the enriched state fields, or is it a raw store row?
 *
 * Tests for the KEY, not its value: an enriched record whose read failed
 * carries `git: null` / `session: null`, and that is a different fact from a
 * raw row where nobody looked. Collapsing the two is how a map starts claiming
 * a project has no session when nothing ever asked.
 *
 * @param {object} p - A project record.
 * @returns {boolean} True when state was gathered for this record.
 */
function _hasStateFields(p) {
  return Object.prototype.hasOwnProperty.call(p, 'session')
    || Object.prototype.hasOwnProperty.call(p, 'git');
}

/**
 * The git half of a project's line.
 *
 * `incomplete` names the fields the read could not establish and is present
 * (empty) on the healthy object too, so this reads its contents rather than
 * probing for its existence — the contract `lib/git.js` and `lib/projects.js`
 * both state.
 *
 * @param {object|null} git - The record's `git` payload.
 * @returns {string[]} Zero or more display segments.
 */
function _fleetGitBits(git) {
  // A null `git` is NOT a failed read. `lib/dir-scanner-child.js#_gitInfo`
  // returns null when the directory is not a repository (or git is absent) and
  // returns an OBJECT carrying `incomplete`/`cause` when a read genuinely fell
  // short. Reporting "could not be read" here would manufacture a failure for
  // every non-repo project on the fleet — the same invention this whole change
  // exists to remove, one level down.
  if (!git) return ['not a git repository'];
  const incomplete = Array.isArray(git.incomplete) ? git.incomplete : [];
  const bits = [];

  if (incomplete.includes('branch') || !git.branch) {
    bits.push(`branch not established${git.cause ? ` (${git.cause})` : ''}`);
  } else {
    bits.push(git.branch);
  }

  // `dirty` is a tri-state: true, false, or null for "the read did not get
  // there". Rendering null as clean is the exact substitution #920's family is
  // about — it would tell the master a tree is safe to act on when nobody knows.
  if (incomplete.includes('dirty') || git.dirty === null || git.dirty === undefined) {
    bits.push('dirty-state unknown');
  } else {
    bits.push(git.dirty ? 'DIRTY' : 'clean');
  }

  if (git.lastCommitAge) bits.push(`last commit ${git.lastCommitAge}`);
  return bits;
}

/**
 * The session half of a project's line.
 *
 * @param {object|null} session - The record's `session` payload.
 * @returns {string} One display segment.
 */
function _fleetSessionBit(session) {
  if (!session) return 'no live session';
  // `active: null` with `incomplete: ['active']` means the read did not happen.
  // It is falsy, so a consumer testing truthiness behaves as it always did;
  // this consumer wants the distinction, so it reads `incomplete`.
  const incomplete = Array.isArray(session.incomplete) ? session.incomplete : [];
  if (incomplete.includes('active') || session.active === null) {
    return `session liveness could not be established${session.cause ? ` (${session.cause})` : ''}`;
  }
  if (!session.active) return 'no live session';
  return session.startedAt
    ? `session LIVE since ${session.startedAt}`
    : 'session LIVE';
}

/**
 * Render the fleet map.
 *
 * PURE — no filesystem, no tmux, no git, no clock. Everything it reports comes
 * from the records it is handed, which is what lets the guards drive it with
 * fixtures shaped like `listProjects` output instead of standing up a fleet.
 *
 * @param {object[]} projects - Raw store rows or enriched records; the two may
 *   be mixed, and each line reports only what its own record established.
 * @param {object} [options] - Render options.
 * @param {string} [options.generatedAt] - ISO stamp for the header. The master's
 *   drift check compares this against its own `observed-at` notes, so it is an
 *   input rather than read from the clock here.
 * @returns {string} The complete file body.
 */
function buildFleetMap(projects, options = {}) {
  const list = Array.isArray(projects) ? projects : [];
  const anyState = list.some(_hasStateFields);
  const lines = [
    '<!-- Generated by TangleClaw — refreshed on every master ensure; do not edit. -->',
    ''
  ];
  if (options.generatedAt) lines.push(`<!-- generated-at: ${options.generatedAt} -->`, '');
  lines.push('# Fleet map', '', 'Every project registered on this TangleClaw instance.', '');

  if (!anyState && list.length > 0) {
    lines.push(
      '**Identity only in this pass.** Branch, working-tree state, session liveness and version',
      'were not gathered — this refresh ran on the synchronous path, which deliberately does no',
      'per-project git or tmux work. Absence of a state line below means nobody looked, NOT that',
      'there is nothing to report.',
      '',
      'A state pass is started whenever the master is refreshed — at server boot and when the master',
      'session is opened — and rewrites this file when it completes. **If you are reading this banner',
      'in a running install, that pass has either not finished yet or it failed**; the two are not',
      'distinguishable from here, and a failure is logged server-side rather than written here.',
      'Re-open the master to start another.',
      ''
    );
  }

  for (const p of list) {
    const bits = [];
    // An enriched record names its engine object; a raw row names only the id.
    bits.push((p.engine && p.engine.id) || p.engineId || 'no engine');

    if (_hasStateFields(p)) {
      if (p.exists === false && !p.unreadable) {
        // The directory is not there. Before this, a deleted project rendered as
        // "not a git repository · no live session" — indistinguishable from an
        // ordinary idle one, which for a coordinator is the difference between
        // "nothing to do here" and "this is gone".
        bits.push('DIRECTORY MISSING — the registered path is not there');
        // Session liveness does NOT depend on the directory: a tmux session can
        // outlive a deleted checkout, and a coordinator told only "directory
        // missing" would not know a pane is still attached to it. Reported
        // alongside rather than suppressed.
        bits.push(_fleetSessionBit(p.session));
      } else if (p.unreadable) {
        // The directory itself did not answer, so every field below it is
        // unknown rather than absent. Say that once instead of repeating it.
        bits.push(`state unknown — could not read the project directory (${p.unreadable})`);
        if (p.unreadableCode) bits.push(p.unreadableCode);
        // Same reasoning as the missing-directory branch above, applied to the
        // sibling case: liveness is no more dependent on a READABLE directory
        // than on an existing one. A pane can be attached to a project whose
        // folder is permission-blocked, and that is worth surfacing next to the
        // reason its other state is unknown.
        bits.push(_fleetSessionBit(p.session));
      } else {
        // A null version on a directory that is THERE and readable is a plain
        // absence — the project has no version file. The two paths that null it
        // for a reason are both caught above: a failed scan sets `unreadable`,
        // and a missing directory sets `exists: false`. (An earlier version of
        // this comment claimed the degraded path "always sets unreadable" — it
        // does not; `lib/dir-scanner-child.js` returns `exists: false` with no
        // `unreadable` for a directory that is simply gone, which is why that
        // branch exists.) Saying "not established" here would manufacture an
        // unknown out of a nothing.
        if (p.version) bits.push(`v${p.version}`);
        bits.push(..._fleetGitBits(p.git));
        bits.push(_fleetSessionBit(p.session));
      }
    }

    bits.push(p.path);
    if (p.archived) bits.push('ARCHIVED');
    lines.push(`- **${p.name}** — ${bits.join(' · ')}`);
  }

  if (list.length === 0) lines.push('*(no projects registered)*');
  lines.push('');
  return lines.join('\n');
}

/**
 * Scaffold and refresh the master's memory directory. TC-maintained files
 * (`FLEET.md` fleet map, `HOWTO.md` operational how-tos) are overwritten on
 * every ensure — same contract as the CLAUDE.md identity. Master-maintained
 * files (`MEMORY.md` index, `CHANGELOG.md` activity log, `NOTES.md`) are
 * seeded once when absent and never touched again.
 *
 * @param {string} home - Absolute master home path
 * @param {object} [options] - Options.
 * @param {object[]} [options.projects] - Records to render the fleet map from.
 *   Defaults to the raw store rows, which carry no state — see the fleet-map
 *   header comment for why this path must stay free of git and tmux work.
 * @param {string} [options.generatedAt] - ISO stamp for the map header.
 */
function _refreshMasterMemory(home, options = {}) {
  const memDir = path.join(home, 'memory');
  fs.mkdirSync(memDir, { recursive: true });

  const projects = options.projects || store.projects.list({ archived: true });
  fs.writeFileSync(
    path.join(memDir, 'FLEET.md'),
    buildFleetMap(projects, { generatedAt: options.generatedAt })
  );

  fs.writeFileSync(path.join(memDir, 'HOWTO.md'), [
    '<!-- Generated by TangleClaw — refreshed on every master ensure; do not edit. -->',
    '',
    '# Operational how-tos',
    '',
    '- **Query TangleClaw**: `curl -s` against the API base URL in CLAUDE.md;',
    '  the Read API quick reference there lists the useful GET endpoints.',
    '- **Session liveness**: `GET /api/sessions/:project/status` per project;',
    '  `GET /api/activity` for the cross-project feed.',
    '- **Medusa switchboard**: sessions message each other via the switchboard;',
    '  you observe through the activity feed — you are not a participant.',
    '- **Record your work**: append what you did to `CHANGELOG.md` here, and',
    '  keep `MEMORY.md` pointing at anything durable you learn (`NOTES.md`).',
    ''
  ].join('\n'));

  const seedOnce = {
    'MEMORY.md': [
      '# Master memory index',
      '',
      'Maintained by the Project Master. One line per durable fact or file.',
      '',
      '- [FLEET.md](FLEET.md) — TC-refreshed fleet map (read-only).',
      '- [HOWTO.md](HOWTO.md) — TC-refreshed operational how-tos (read-only).',
      '- [CHANGELOG.md](CHANGELOG.md) — my activity log.',
      '- [NOTES.md](NOTES.md) — learned notes.',
      ''
    ].join('\n'),
    'CHANGELOG.md': [
      '# Master activity log',
      '',
      'Newest first: what I did, which projects it touched, when.',
      ''
    ].join('\n'),
    'NOTES.md': [
      '# Notes',
      '',
      'Things worth keeping.',
      ''
    ].join('\n')
  };
  for (const [name, content] of Object.entries(seedOnce)) {
    const file = path.join(memDir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content);
  }
}

/**
 * Regenerate the master's on-disk identity — `CLAUDE.md`, the memory scaffold,
 * and (Claude engine) the write guardrails — from live config and rules.
 *
 * Split out of {@link ensureMasterSession} so the identity can be refreshed
 * without starting or touching a tmux session. That matters because the identity
 * embeds the TangleClaw API base URL: an install whose effective port changes
 * (the launchd plist sets `TANGLECLAW_PORT`, which `config.serverPort` does not
 * know about) otherwise keeps telling the master to call a port nothing is
 * listening on, and every PortHub / shared-docs call fails silently. Managed
 * projects heal on boot via `projects.syncAllProjects()`; before this split the
 * master had no equivalent, so the stale value survived restarts and upgrades
 * indefinitely unless the operator happened to open the master (#726).
 *
 * Purely file writes — no tmux, no engine launch — so it is safe to call on
 * every boot.
 *
 * @param {object} [options]
 * @param {string} [options.home] - Master home override (tests)
 * @param {object} [options.enginesLib] - engines module override (tests)
 * @param {boolean} [options.fleetState] - Also start the async pass that fills
 *   `FLEET.md` with per-project state. Opt-in: most callers here are tests that
 *   want the file writes and nothing else, and an always-on read would make
 *   every one of them enumerate the real fleet.
 * @param {Function} [options.refreshFleet] - Fleet refresher override (tests).
 * @param {boolean} [options.skipIfAbsent] - Do nothing if the master home does
 *   not exist. Boot uses this so an operator who has never opened the master
 *   does not get master state created as a side effect of starting the server.
 * @returns {{ home: string, refreshed: boolean }} `refreshed: false` when
 *   `skipIfAbsent` was set and no master home exists yet.
 */
function refreshMasterIdentity(options = {}) {
  const home = options.home || masterHome();
  if (options.skipIfAbsent && !fs.existsSync(home)) {
    return { home, refreshed: false };
  }
  fs.mkdirSync(home, { recursive: true });

  const config = store.config.load();
  const { settings, enforcement } = _masterRuntime(config, options.enginesLib);

  seedBaselineMasterRules();
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), buildMasterClaudeMd(config, {
    rules: store.sessionRules.listActiveForMaster(),
    scope: _resolveScope(settings.scope),
    // Passed rather than re-derived, so the identity, the guard and the level
    // file all come from the ONE `_masterRuntime` call this function made —
    // the same lockstep rule that put engine and enforcement there.
    accessLevel: settings.accessLevel,
    enforcement
  }));
  _refreshMasterMemory(home, { generatedAt: new Date().toISOString() });

  // Written on EVERY refresh and regardless of engine, unlike the guard itself.
  // The guard is a Claude capability; the level is a fact about the master, and
  // keeping it true here means an operator who switches the master onto Claude
  // finds a correct posture already on disk rather than one ensure behind.
  // `PATCH /api/config` writes it too — that path is what makes a flip bind
  // without a restart, while this one keeps the file honest across restarts.
  writeMasterAccessLevel(home, settings.accessLevel);

  if (enforcement === 'structural') _writeMasterGuardrails(home);

  // The state half, opt-in and deliberately not awaited.
  //
  // It lives HERE rather than at the server's call sites so it resolves `home`
  // from the same place everything else in this function does. A caller that
  // passes a test home gets the fleet map written into that test home; a route
  // test that stubs this module's entry points gets no fleet read at all. The
  // earlier shape called it directly from `server.js`, where it resolved
  // `os.homedir()` regardless — which let a route test overwrite the operator's
  // real `~/.tangleclaw/master/memory/FLEET.md`.
  //
  // Opt-in because most callers of this function are tests that want file
  // writes and nothing else; only the two production entry points ask for it.
  if (options.fleetState) {
    // Injectable like `enginesLib`/`tmuxLib` above, and for the same reason: the
    // internal call cannot be reached by reassigning the export, so without a
    // seam the wiring is untestable and would ship on the strength of a comment.
    const refresh = options.refreshFleet || refreshFleetMap;
    refresh({ home })
      .then((r) => { if (r.refreshed) log.debug('Fleet map refreshed with state', { count: r.count }); })
      .catch((err) => log.warn('Fleet map state refresh failed', { error: err.message }));
  }

  return { home, refreshed: true };
}

/**
 * Rewrite `FLEET.md` with full per-project state.
 *
 * The state half of {@link refreshMasterIdentity}, kept separate because it
 * cannot live on that function's synchronous path. It rides the enriched list
 * `lib/projects.js#listProjects` already builds for the dashboard poll — one
 * `tmux list-sessions` snapshot for the whole fleet and a `git.getInfo` per
 * project inside the forked scanner — so full state costs no scanning this
 * module would not otherwise have caused.
 *
 * Writes only `FLEET.md`. It never touches the master-owned files, and it does
 * nothing at all when no master home exists, so calling it on boot cannot
 * create master state for an operator who has never opened the master.
 *
 * `projects` is required lazily so importing this module does not pull the
 * project subsystem in behind it, and so a test can drive the whole function
 * without one.
 *
 * @param {object} [options] - Options.
 * @param {string} [options.home] - Master home override (tests).
 * @param {Function} [options.listProjects] - Async lister override (tests).
 * @param {string} [options.generatedAt] - ISO stamp for the map header.
 * @returns {Promise<{home: string, refreshed: boolean, count: number}>}
 *   `refreshed: false` when there is no master home to write into.
 */
let _fleetRefreshInFlight = null;

async function refreshFleetMap(options = {}) {
  const home = options.home || masterHome();
  const memDir = path.join(home, 'memory');
  if (!fs.existsSync(memDir)) return { home, refreshed: false, count: 0 };

  // SINGLE-FLIGHT, and not merely for tidiness. `listProjects` is the same path
  // the ten-second dashboard poll drives, and `lib/dir-scanner.js` starts each
  // request's deadline at ISSUE time against a SERIAL child — so a second
  // caller's reads queue behind the first while their clocks run, and a
  // perfectly healthy project can burn its deadline waiting its turn, get
  // killed, and earn the Full Disk Access hint it did not deserve (the
  // #884/#891 family). Coalescing keeps this module to one outstanding fleet
  // read no matter how many times the master is opened.
  //
  // Callers awaiting a coalesced run get the in-flight result, which is a
  // slightly older map rather than a second scan — the right trade for a file
  // that is regenerated rather than accumulated.
  if (_fleetRefreshInFlight) return _fleetRefreshInFlight;

  const lister = options.listProjects
    || ((opts) => require('./projects').listProjects(opts));

  _fleetRefreshInFlight = (async () => {
    const projects = await lister({ archived: true });
    fs.writeFileSync(
      path.join(memDir, 'FLEET.md'),
      buildFleetMap(projects, { generatedAt: options.generatedAt || new Date().toISOString() })
    );
    return { home, refreshed: true, count: projects.length };
  })();

  try {
    return await _fleetRefreshInFlight;
  } finally {
    _fleetRefreshInFlight = null;
  }
}

/**
 * Ensure the Project Master session exists — idempotent.
 *
 * Always: creates the master home, seeds the Hard-rules baseline when no
 * master rules exist, (re)generates the CLAUDE.md identity from the live
 * rules + scope, refreshes the memory scaffold, and (Claude engine)
 * regenerates the structural write guardrails. When the reserved tmux
 * session is absent: creates it (cwd = master home) and starts the
 * configured engine's launch command in it. Never touches an already-running
 * master (no kill/adopt semantics in v1 — the operator owns restarts via
 * tmux).
 *
 * @param {object} [options]
 * @param {string} [options.home] - Master home override (tests)
 * @param {object} [options.tmuxLib] - tmux module override (tests)
 * @param {Function} [options.refreshFleet] - Fleet refresher override (tests); see
 *   {@link refreshMasterIdentity}. Without it a test fires a real fleet read.
 * @param {object} [options.enginesLib] - engines module override (tests)
 * @returns {{created: boolean, tmuxSession: string, home: string, engine?: string, accessLevel?: string, enforcement?: string, error?: string}}
 */
function ensureMasterSession(options = {}) {
  const t = options.tmuxLib || tmux;
  const eng = options.enginesLib || engines;
  const home = options.home || masterHome();

  const config = store.config.load();
  const { settings, engineId, enforcement, launchMode } = _masterRuntime(config, eng);

  // Opening the master is exactly when its fleet map most needs to be current.
  // `refreshFleet` is forwarded so a test can neutralise the fleet pass; without
  // it every ensureMasterSession test fires an unawaited real fleet read that
  // spawns `tmux list-sessions` and races its own temp-dir teardown.
  refreshMasterIdentity({
    home, enginesLib: eng, fleetState: true, refreshFleet: options.refreshFleet
  });

  const base = { tmuxSession: MASTER_TMUX_SESSION, home, engine: engineId, accessLevel: settings.accessLevel, enforcement, launchMode };

  // Probe, not the boolean. `hasSession` answers false both for a master that
  // is not running and for a tmux server too wedged to reply, and THIS CALLER
  // ACTS ON THE ANSWER — false means "start one". So a wedge turned a running
  // master into a second `tmux new-session` aimed at it. `lib/sessions.js`
  // already refuses to launch over a session it cannot see, for the same reason
  // and with the same shape; this is that rule on the master's own path.
  const probe = t.probeSession(MASTER_TMUX_SESSION);
  if (probe.live) {
    return { created: false, ...base };
  }
  if (!probe.answered) {
    // Named as what it is. Reporting a generic start failure here sends the
    // operator to look at the master's configuration, when the thing that is
    // broken is tmux — and starting a second master over a live one is the
    // outcome a retry would produce if the probe ever came back wrong.
    //
    // `incomplete` rather than only a message, because the surface has to
    // render this differently from a failed start: a refusal on an unestablished
    // liveness is an UNKNOWN, and painting it as "down" would re-commit the
    // defect this function was just fixed for, one layer along. The route turns
    // it into its own error code so the client branches on a code rather than
    // on the wording of a sentence.
    return {
      created: false,
      ...base,
      incomplete: ['exists'],
      cause: probe.cause,
      error: 'Could not determine whether the Project Master is already running — tmux did not answer. '
        + 'Refusing to start a second one over it.'
    };
  }

  if (!engineId) {
    // Name the real problem. Reporting `Engine "null" not found` would send the
    // operator looking for a misconfiguration when the machine simply has no
    // engine installed.
    return { created: false, ...base, error: 'No AI engine is installed — install one (Claude Code, Codex, Antigravity, or Aider) before starting the Project Master' };
  }
  const engineProfile = store.engines.get(engineId);
  if (!engineProfile) {
    return { created: false, ...base, error: `Engine "${engineId}" not found` };
  }
  // `fresh`: a gate, not a display — see the same call in `lib/sessions.js`.
  const det = eng.detectEngine(engineProfile, { fresh: true });
  if (!det.available) {
    return { created: false, ...base, error: `Engine "${engineId}" not available (binary not found)` };
  }

  if (launchMode !== settings.launchMode) {
    // Warn HERE rather than in `_masterRuntime`: this runs once per launch, so
    // it reports the condition at the condition's cadence. The debug line in
    // `_masterRuntime` covers the polled status path, and on a default install
    // (`logger` defaults to `info`) it writes nothing — which is why the honest
    // record has to live on this path.
    log.warn('Master launch mode not honored by the resolved engine — launching with the interactive default', {
      stored: settings.launchMode, using: launchMode, engine: engineId
    });
  }

  // Generic engine launch command (shellCommand + args). No project → the
  // OpenClaw branch and orchestration overlays never apply.
  //
  // The launch mode was hardcoded `null` here, on the reasoning that ask-gating
  // every action was part of the read-only posture. That conflated two
  // independent axes (#756): this one governs whether the agent prompts inside
  // ITS OWN session and is enforced by the engine, while the access level
  // governs what the Master may do to the fleet and is enforced by TangleClaw.
  // A read-only Master in `bypassPermissions` is coherent — it edits its own
  // `memory/` without nagging and still cannot touch the fleet — so the mode is
  // now the operator's, already reconciled against the effective engine.
  //
  // An available engine with no launch profile would otherwise start a bare
  // shell while reporting created:true — refuse instead (honest degradation).
  const launchCmd = sessions._buildLaunchCommand(engineProfile, null, launchMode);
  if (!launchCmd) {
    return { created: false, ...base, error: `Engine "${engineId}" has no launch command` };
  }

  try {
    const created = t.createSession(MASTER_TMUX_SESSION, {
      cwd: home,
      command: launchCmd,
      env: engineProfile.launch ? engineProfile.launch.env : {}
    });
    if (!created) {
      return { created: false, ...base, error: `Failed to create tmux session "${MASTER_TMUX_SESSION}"` };
    }
  } catch (err) {
    return { created: false, ...base, error: `tmux error: ${err.message}` };
  }

  log.info('Project Master session launched', { tmuxSession: MASTER_TMUX_SESSION, home, engine: engineId, accessLevel: settings.accessLevel, enforcement, launchMode });
  return { created: true, ...base };
}

/**
 * Report whether the Project Master session is alive, plus its effective
 * settings for the panel/settings UI. Liveness truth comes from tmux — there
 * is no DB row to drift from reality.
 * @param {object} [options]
 * @param {object} [options.tmuxLib] - tmux module override (tests)
 * @param {object} [options.enginesLib] - engines module override (tests); the
 *   reported engine is resolved against what is installed, so a stub that does
 *   not answer resolution makes this depend on the host's CLIs.
 * `exists` HAS THREE VALUES, not two. `hasSession` answers `false` both for a
 * master that is not running and for a tmux server too wedged to reply, so this
 * used to report a running master as absent during precisely the condition this
 * install reaches (#94/#144/#380 — PTY exhaustion). That is the unknown-wearing-
 * a-fact's-clothes defect #900 removed from the fleet view and #891 from
 * `git.dirty`, on the one surface those left alone. `null` means tmux did not
 * answer; `incomplete` names it, and `cause` says why, following the convention
 * `session.active` and `git.dirty` already set.
 *
 * `incomplete` is `[]` on the healthy path rather than absent — a field that
 * appears only on failure makes every consumer probe for its existence instead
 * of reading its value.
 *
 * @returns {{exists: boolean|null, incomplete: string[], cause: string|null,
 *            tmuxSession: string, home: string, settings: object}}
 */
function getMasterStatus(options = {}) {
  const t = options.tmuxLib || tmux;
  const { settings, engineId, enforcement, launchMode } = _masterRuntime(store.config.load(), options.enginesLib);
  // The modes the EFFECTIVE engine actually offers, resolved here so the UI
  // renders from one answer instead of re-deriving which flags exist — the
  // third-source-of-truth #768 warns about. An engine that is gone or not yet
  // installed yields an empty list, which the surface must render as "no modes
  // to choose from", never as a silently empty picker.
  const profile = engineId ? store.engines.get(engineId) : null;
  // `{id, label}`, not bare ids: the project-settings picker renders
  // `m.label || key` ("Accept Edits"), and a Master picker showing `acceptEdits`
  // would be the visibly poorer of two controls doing the same job. The label
  // lives in the engine profile, so shipping it here keeps the frontend from
  // needing the profile at all.
  const offered = (profile && profile.launchModes && typeof profile.launchModes === 'object')
    ? Object.keys(profile.launchModes)
      .filter((m) => engines.honorsLaunchMode(profile, m))
      .map((id) => {
        const m = profile.launchModes[id] || {};
        // `warning` and `description` travel too: the sibling picker renders a
        // ⚠ for a warned mode, and `bypassPermissions` carries "Only use in
        // isolated environments". A Master picker that dropped them would be
        // silently the less safe of two controls choosing the same thing.
        return { id, label: m.label || id, warning: m.warning || null, description: m.description || null };
      })
    : [];
  const probe = t.probeSession(MASTER_TMUX_SESSION);
  return {
    exists: probe.answered ? probe.live : null,
    incomplete: probe.answered ? [] : ['exists'],
    cause: probe.cause,
    tmuxSession: MASTER_TMUX_SESSION,
    home: masterHome(),
    settings: {
      accessLevel: settings.accessLevel,
      accessLevels: MASTER_ACCESS_LEVELS,
      enabledAccessLevels: MASTER_ENABLED_ACCESS_LEVELS,
      engine: settings.engine,
      resolvedEngine: engineId,
      // Both halves travel: `launchMode` is what the operator chose and
      // `resolvedLaunchMode` is what will actually run. They differ exactly
      // when the stored mode is stranded by an engine switch, and the settings
      // modal has to be able to say so rather than quietly showing one of them.
      launchMode: settings.launchMode,
      resolvedLaunchMode: launchMode,
      launchModes: offered,
      scope: settings.scope,
      autoStart: settings.autoStart,
      enforcement,
      // WHEN a level change starts binding, as its own fact rather than
      // something each surface re-derives from `enforcement`. The two are
      // correlated today, but they answer different questions, and the settings
      // copy needs this one: a structural master honors a flip on its very next
      // tool call, while on an instructional master the level travels in the
      // regenerated identity and so arrives with the next ensure. Both hints
      // used to promise the structural answer unconditionally.
      levelAppliesAt: enforcement === 'structural' ? 'next-tool-call' : 'next-ensure'
    }
  };
}

module.exports = {
  MASTER_TMUX_SESSION,
  MASTER_BASELINE_RULES,
  MASTER_ACCESS_LEVELS,
  MASTER_ENABLED_ACCESS_LEVELS,
  masterHome,
  masterSettings,
  masterAccessLevelPath,
  writeMasterAccessLevel,
  applyMasterAccessLevel,
  knownLaunchModes,
  buildMasterClaudeMd,
  buildMasterGuardScript,
  seedBaselineMasterRules,
  restoreDefaultMasterRules,
  ensureMasterSession,
  refreshMasterIdentity,
  refreshFleetMap,
  buildFleetMap,
  getMasterStatus,
  _resolveScope,
  _refreshMasterMemory,
  _writeMasterGuardrails
};
