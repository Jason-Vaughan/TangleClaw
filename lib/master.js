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
const { effectiveServerProtocol } = require('./https-setup');

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
  '**Never edit files outside this directory.** Your home is your only writable' +
    ' surface, and durable notes belong under `memory/`. You have no project' +
    ' working tree by design — do not go looking for one.',
  "For per-project code questions, direct the operator to that project's own" +
    ' session; you report status, you do not do project work.'
];

/** Access levels the settings surface knows about. Only 'read-only' is
 *  enabled in v1 — the others are rejected server-side until each ships with
 *  real structural enforcement (never prose-only boundaries).
 *  @type {string[]} */
const MASTER_ACCESS_LEVELS = ['read-only', 'suggest', 'write'];

/** Access levels actually selectable today. @type {string[]} */
const MASTER_ENABLED_ACCESS_LEVELS = ['read-only'];

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
 * @returns {{accessLevel: string, engine: string|null, scope: (string|{type: string, groupId: string}), autoStart: boolean}}
 */
function masterSettings(config) {
  const raw = (config && typeof config.master === 'object' && config.master) || {};
  return {
    accessLevel: MASTER_ACCESS_LEVELS.includes(raw.accessLevel) ? raw.accessLevel : 'read-only',
    engine: typeof raw.engine === 'string' && raw.engine ? raw.engine : null,
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
 * @returns {{settings: object, engineId: string, enforcement: string}}
 */
function _masterRuntime(config) {
  const settings = masterSettings(config);
  const engineId = settings.engine || config.defaultEngine || 'claude';
  // Structural enforcement is a Claude-engine capability (settings.json +
  // PreToolUse hooks); other engines run the same instructional identity and
  // the API reports the difference instead of pretending.
  const enforcement = engineId === 'claude' ? 'structural' : 'instructional';
  return { settings, engineId, enforcement };
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
 * Seed the shipped Hard-rules baseline into `session_rules` when NO master
 * rows exist (enabled or not) — idempotent, so an operator who deleted or
 * disabled individual rules is never overridden by a later ensure. Seeded
 * rows carry created_by 'system' (provenance: shipped baseline, and the UI's
 * eyes-open-confirm marker) and critic_gate 'not-required'.
 * @returns {number} Rows seeded (0 when rows already existed)
 */
function seedBaselineMasterRules() {
  const existing = store.sessionRules.list({ kind: 'master' });
  if (existing.length > 0) return 0;
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
 * @returns {string} CLAUDE.md content
 */
function buildMasterClaudeMd(config, extras = {}) {
  const serverPort = config.serverPort || 3101;
  // ENG-5R2W: must match what the server actually serves (caddy mode / no-cert
  // installs bind plain HTTP even with httpsEnabled), not the raw flag.
  const serverProtocol = effectiveServerProtocol(config);
  const baseUrl = `${serverProtocol}://localhost:${serverPort}`;
  const tokenActive = !!(config.serviceTokenEnabled && config.serviceToken);

  const ruleContents = (extras.rules && extras.rules.length > 0)
    ? extras.rules.map((r) => r.content)
    : MASTER_BASELINE_RULES;
  const scope = extras.scope || { kind: 'all' };

  const lines = [
    '<!-- Generated by TangleClaw — Project Master identity. Regenerated on every',
    '     master ensure; hand-edits will be overwritten. -->',
    '',
    '# CLAUDE.md — TangleClaw Project Master',
    '',
    'You are the **TangleClaw Project Master**: the read-only administrator of this',
    'whole TangleClaw instance, above all projects. You answer cross-project',
    'questions ("which projects have open PRs?", "what is stale?", "what sessions',
    'are live?") by querying the TangleClaw HTTP API. You are NOT a project',
    'session: you have no project checkout, you own no code, and you never wrap.',
    '',
    '## Hard rules (v1 boundary)',
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
 * bash+jq — TC's only runtime guarantee is node. DEFAULT-DENY by construction:
 * the harness treats hook crashes as fail-open, so every failure path inside
 * the script itself must end in an explicit deny — the only allow path is a
 * successfully parsed target that resolves strictly inside `memory/`.
 * @param {string} home - Absolute master home path
 * @returns {string} Script source
 */
function buildMasterGuardScript(home) {
  return `#!/usr/bin/env node
'use strict';
// Generated by TangleClaw — Project Master write guard. Regenerated on every
// master ensure; hand-edits will be overwritten.
//
// PreToolUse hook for Edit|Write|NotebookEdit: the Project Master is
// read-only everywhere except its memory/ carve-out. Emits the documented
// permissionDecision JSON on stdout (exit 0) — a deny here is a hard block,
// and any internal failure also denies (the harness fails OPEN on hook
// crashes, so the guard must never crash its way past the boundary).
const path = require('path');

const HOME = ${JSON.stringify(home)};

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
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
  const memoryDir = path.join(HOME, 'memory') + path.sep;
  const resolved = path.resolve(HOME, target);
  if (resolved.startsWith(memoryDir)) {
    process.exit(0); // inside the carve-out — fall through to permission rules
  }
  return deny('Project Master is read-only: writes are allowed only under ' +
    path.join(HOME, 'memory') + '. Refused: ' + resolved);
});
`;
}

/**
 * Write the structural guardrails for the read-only access level into the
 * master home (Claude engine only — settings.json/hooks are Claude Code
 * semantics). Regenerated on every ensure so posture changes propagate:
 * `.claude/settings.json` auto-allows Edit/Write inside `memory/` and wires a
 * PreToolUse hook that hard-denies every write tool elsewhere — including
 * `.claude/` itself, so the guard protects its own config. Everything not
 * matched falls to the harness ask-gate (operator approval in the master
 * terminal). Bash is deliberately NOT pattern-allowlisted: command-pattern
 * matching cannot reliably separate GET curls from mutating ones, so Bash
 * stays ask-gated rather than pretending.
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

/**
 * Scaffold and refresh the master's memory directory. TC-maintained files
 * (`FLEET.md` fleet map, `HOWTO.md` operational how-tos) are overwritten on
 * every ensure — same contract as the CLAUDE.md identity. Master-maintained
 * files (`MEMORY.md` index, `CHANGELOG.md` activity log, `NOTES.md`) are
 * seeded once when absent and never touched again.
 * @param {string} home - Absolute master home path
 */
function _refreshMasterMemory(home) {
  const memDir = path.join(home, 'memory');
  fs.mkdirSync(memDir, { recursive: true });

  const projects = store.projects.list({ archived: true });
  const fleetLines = [
    '<!-- Generated by TangleClaw — refreshed on every master ensure; do not edit. -->',
    '',
    '# Fleet map',
    '',
    'Every project registered on this TangleClaw instance.',
    ''
  ];
  for (const p of projects) {
    const bits = [p.engineId || 'no engine', p.path];
    if (p.archived) bits.push('ARCHIVED');
    fleetLines.push(`- **${p.name}** — ${bits.join(' · ')}`);
  }
  if (projects.length === 0) fleetLines.push('*(no projects registered)*');
  fleetLines.push('');
  fs.writeFileSync(path.join(memDir, 'FLEET.md'), fleetLines.join('\n'));

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
 * @param {object} [options.enginesLib] - engines module override (tests)
 * @returns {{created: boolean, tmuxSession: string, home: string, engine?: string, accessLevel?: string, enforcement?: string, error?: string}}
 */
function ensureMasterSession(options = {}) {
  const t = options.tmuxLib || tmux;
  const eng = options.enginesLib || engines;
  const home = options.home || masterHome();
  fs.mkdirSync(home, { recursive: true });

  const config = store.config.load();
  const { settings, engineId, enforcement } = _masterRuntime(config);

  seedBaselineMasterRules();
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), buildMasterClaudeMd(config, {
    rules: store.sessionRules.listActiveForMaster(),
    scope: _resolveScope(settings.scope)
  }));
  _refreshMasterMemory(home);

  if (enforcement === 'structural') _writeMasterGuardrails(home);

  const base = { tmuxSession: MASTER_TMUX_SESSION, home, engine: engineId, accessLevel: settings.accessLevel, enforcement };

  if (t.hasSession(MASTER_TMUX_SESSION)) {
    return { created: false, ...base };
  }

  const engineProfile = store.engines.get(engineId);
  if (!engineProfile) {
    return { created: false, ...base, error: `Engine "${engineId}" not found` };
  }
  const det = eng.detectEngine(engineProfile);
  if (!det.available) {
    return { created: false, ...base, error: `Engine "${engineId}" not available (binary not found)` };
  }

  // Generic engine launch command (shellCommand + args). No project → the
  // OpenClaw branch and orchestration overlays never apply; no launch mode →
  // the engine's interactive default, so every action ask-gates in the master
  // terminal (part of the read-only posture — never a warning mode). An
  // available engine with no launch profile would otherwise start a bare
  // shell while reporting created:true — refuse instead (honest degradation).
  const launchCmd = sessions._buildLaunchCommand(engineProfile, null, null);
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

  log.info('Project Master session launched', { tmuxSession: MASTER_TMUX_SESSION, home, engine: engineId, accessLevel: settings.accessLevel, enforcement });
  return { created: true, ...base };
}

/**
 * Report whether the Project Master session is alive, plus its effective
 * settings for the panel/settings UI. Liveness truth comes from tmux — there
 * is no DB row to drift from reality.
 * @param {object} [options]
 * @param {object} [options.tmuxLib] - tmux module override (tests)
 * @returns {{exists: boolean, tmuxSession: string, home: string, settings: object}}
 */
function getMasterStatus(options = {}) {
  const t = options.tmuxLib || tmux;
  const { settings, engineId, enforcement } = _masterRuntime(store.config.load());
  return {
    exists: t.hasSession(MASTER_TMUX_SESSION),
    tmuxSession: MASTER_TMUX_SESSION,
    home: masterHome(),
    settings: {
      accessLevel: settings.accessLevel,
      accessLevels: MASTER_ACCESS_LEVELS,
      enabledAccessLevels: MASTER_ENABLED_ACCESS_LEVELS,
      engine: settings.engine,
      resolvedEngine: engineId,
      scope: settings.scope,
      autoStart: settings.autoStart,
      enforcement
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
  buildMasterClaudeMd,
  buildMasterGuardScript,
  seedBaselineMasterRules,
  restoreDefaultMasterRules,
  ensureMasterSession,
  getMasterStatus,
  _resolveScope,
  _refreshMasterMemory,
  _writeMasterGuardrails
};
