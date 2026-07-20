'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const store = require('./store');
const { createLogger } = require('./logger');
const { effectiveServerProtocol } = require('./https-setup');

const log = createLogger('engines');

/**
 * Detect which engines are available on the system.
 * Checks each engine profile's detection config.
 * @returns {{ id: string, available: boolean, path: string|null }[]}
 */
function detect() {
  const profiles = store.engines.list();
  const results = [];

  for (const profile of profiles) {
    const result = detectEngine(profile);
    results.push(result);
    if (result.available) {
      log.debug('Engine detected', { id: profile.id, path: result.path });
    }
  }

  return results;
}

/**
 * Detect availability of a single engine.
 * @param {object} profile - Engine profile object
 * @returns {{ id: string, available: boolean, path: string|null }}
 */
function detectEngine(profile) {
  if (!profile || !profile.detection) {
    return { id: profile ? profile.id : 'unknown', available: false, path: null };
  }

  const { strategy, target } = profile.detection;

  switch (strategy) {
    case 'which':
      return _detectWhich(profile.id, target);
    case 'path':
      return _detectPath(profile.id, target);
    default:
      log.warn('Unknown detection strategy', { id: profile.id, strategy });
      return { id: profile.id, available: false, path: null };
  }
}

/**
 * Detect engine using `which` command.
 * @param {string} id - Engine id
 * @param {string} target - Binary name
 * @returns {{ id: string, available: boolean, path: string|null }}
 */
function _detectWhich(id, target) {
  try {
    const binPath = execSync(`which ${target} 2>/dev/null`, {
      timeout: 2000,
      encoding: 'utf8'
    }).trim();
    return { id, available: !!binPath, path: binPath || null };
  } catch {
    return { id, available: false, path: null };
  }
}

/**
 * Detect engine by checking if a path exists.
 * @param {string} id - Engine id
 * @param {string} target - File path to check
 * @returns {{ id: string, available: boolean, path: string|null }}
 */
function _detectPath(id, target) {
  const fs = require('node:fs');
  const exists = fs.existsSync(target);
  return { id, available: exists, path: exists ? target : null };
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
 * @returns {object[]} - Engine profiles enriched with `available` and `detectedPath` fields
 */
function listWithAvailability() {
  const profiles = store.engines.list().filter((p) => !p.pickerHidden);
  const detection = detect();
  const detectionMap = new Map(detection.map((d) => [d.id, d]));

  return profiles.map((profile) => {
    const det = detectionMap.get(profile.id) || { available: false, path: null };
    return {
      id: profile.id,
      name: profile.name,
      interactionModel: profile.interactionModel,
      available: det.available,
      command: profile.command,
      capabilities: profile.capabilities || {},
      commands: profile.commands || [],
      launchModes: profile.launchModes || null,
      defaultLaunchMode: profile.defaultLaunchMode || null
    };
  });
}

/**
 * Get a single engine profile with availability.
 * @param {string} id - Engine profile id
 * @returns {object|null}
 */
function getWithAvailability(id) {
  // Handle virtual OpenClaw engine IDs (openclaw:<connectionId>)
  if (id.startsWith('openclaw:')) {
    const connId = id.slice('openclaw:'.length);
    const conn = store.openclawConnections.get(connId);
    if (!conn) return null;

    const baseProfile = store.engines.get('openclaw') || {};
    return {
      ...baseProfile,
      id: `openclaw:${conn.id}`,
      name: `${conn.name} (OpenClaw)`,
      available: true,
      detectedPath: null,
      category: 'OpenClaw',
      connectionId: conn.id
    };
  }

  const profile = store.engines.get(id);
  if (!profile) return null;

  const det = detectEngine(profile);

  return {
    ...profile,
    available: det.available,
    detectedPath: det.path
  };
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

  return { valid: errors.length === 0, errors };
}

/**
 * Generate engine-specific config content for a project.
 * Translates the project's rules into the engine's config format.
 * @param {string} engineId - Engine profile id
 * @param {object} projectConfig - Per-project config
 * @returns {string|null} - Generated config content, or null if engine doesn't support config files
 */
function generateConfig(engineId, projectConfig) {
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
      return _generateClaudeMd(projectConfig);
    case 'codex-yaml':
      return _generateCodexYaml(projectConfig);
    case 'aider-conf':
      return _generateAiderConf(projectConfig);
    case 'gemini-md':
      return _generateGeminiMd(projectConfig, '# GEMINI.md — Generated by TangleClaw');
    case 'antigravity-md':
      return _generateGeminiMd(projectConfig, '# .antigravity.md — Generated by TangleClaw');
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
function _getRulesContent(projectConfig) {
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
  // any more. Config generation is skipped wholesale for plugin-governed
  // projects (see writeEngineConfig's early return), so this path delivered the
  // rules tier to nothing on every governed project. Startup rules now ship in
  // the session prime instead — `sessions.buildStartupRulesSection` — which
  // runs per-engine at launch and is not gated on file ownership. Do not
  // re-add injection here: two delivery paths for one tier is what made the
  // broken one invisible.

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
  const serverPort = config.serverPort || 3101;
  // ENG-5R2W: must match what the server actually serves (caddy mode / no-cert
  // installs bind plain HTTP even with httpsEnabled), not the raw flag.
  const serverProtocol = effectiveServerProtocol(config);

  // AUTH-4b — when the M2M service-token gate is on, the PortHub + shared-docs
  // surfaces require a bearer token; surface the raw token so the config
  // generators can inject the required Authorization header (see
  // _serviceTokenAuthLines). When off, leave it null → nothing is injected →
  // the generated config is byte-for-byte what it was before AUTH-4 (the
  // reversibility contract).
  const serviceTokenEnabled = !!config.serviceTokenEnabled;
  const serviceToken = serviceTokenEnabled ? (config.serviceToken || null) : null;

  return { coreRulesLines, extensionRulesLines, porthubGuide, sharedDocsGuide, sessionMemoryGuide, globalRules, sharedDocsContent, serverPort, serverProtocol, serviceTokenEnabled, serviceToken };
}

/**
 * Build the service-token Authentication block injected after the API base URL
 * when the M2M gate is enabled (AUTH-4b). Returns `[]` when the gate is off or no
 * token is set, so the surrounding config is unchanged. The token applies to the
 * PortHub (`/api/ports*`) and shared-docs (`/api/shared-docs*`) surfaces.
 *
 * @param {{serviceTokenEnabled: boolean, serviceToken: string|null}} rules
 * @param {'md'|'comment'} [format='md'] - `md` for markdown configs (CLAUDE.md,
 *   Gemini, Codex YAML block scalar); `comment` for `#`-prefixed configs (aider).
 * @returns {string[]} Lines to push into the config (no trailing blank for `comment`).
 */
function _serviceTokenAuthLines(rules, format = 'md') {
  if (!rules || !rules.serviceTokenEnabled || !rules.serviceToken) return [];
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
function _generateClaudeMd(projectConfig) {
  const lines = ['# CLAUDE.md — Generated by TangleClaw', ''];
  const rules = _getRulesContent(projectConfig);

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
 * Generate .codex.yaml content for Codex.
 * Includes full rules in the `instructions` multiline field.
 * @param {object} projectConfig - Per-project config
 * @returns {string}
 */
function _generateCodexYaml(projectConfig) {
  const lines = ['# Generated by TangleClaw'];
  const rules = _getRulesContent(projectConfig);

  const extensions = projectConfig.rules && projectConfig.rules.extensions ? projectConfig.rules.extensions : {};
  if (extensions.loggingLevel) {
    lines.push(`logging_level: ${extensions.loggingLevel}`);
  }

  // Build instructions content with all rules
  const instrParts = [];
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
function _generateAiderConf(projectConfig) {
  const rules = _getRulesContent(projectConfig);

  // Rules as YAML comments (human-readable in config file)
  const lines = ['# Generated by TangleClaw'];

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
 * Generate GEMINI.md content for Gemini CLI (and, via the `header` param,
 * `.antigravity.md` for Antigravity — the body format is identical markdown).
 * Nearly identical to CLAUDE.md — markdown format with rules and the PortHub guide.
 * Written to .gemini/GEMINI.md (Gemini) or .antigravity.md (Antigravity) in the project root.
 * @param {object} projectConfig - Per-project config
 * @param {string} [header] - First heading line of the generated file
 * @returns {string}
 */
function _generateGeminiMd(projectConfig, header = '# GEMINI.md — Generated by TangleClaw') {
  const lines = [header, ''];
  const rules = _getRulesContent(projectConfig);

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
            lines.push(`> ⚠️ File not found: \`${doc.filePath}\``, '');
          }
        } catch (err) {
          lines.push(`> ⚠️ Failed to read: \`${doc.filePath}\` (${err.message})`, '');
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
        lines.push(`- **${doc.name}**: \`${doc.filePath}\`${doc.description ? ` — ${doc.description}` : ''}${fileStatus}${lockWarning}`);
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

/**
 * Build engine-level baseline hooks based on per-project config and engine
 * capability. syncEngineHooks writes these as the project's hooks block.
 * Currently only emits a SessionStart entry for silent prime delivery (#103)
 * when the project has opted in AND the engine advertises support. Both gates
 * must be true — keeping them symmetric with launchSession's silentPrime
 * derivation prevents an orphaned hook from being written for an engine that
 * cannot actually use it (Critic M1).
 * @param {object} projConfig - Per-project config (loaded by store.projectConfig.load)
 * @param {object|null} [engineProfile] - Engine profile for capability gating; when omitted, no engine-gated entries are emitted
 * @returns {object} Hooks object shaped like { SessionStart: [ ... ] }
 */
function _buildBaselineHooks(projConfig, engineProfile) {
  const hooks = {};
  const supportsSilentPrime = !!(engineProfile
    && engineProfile.capabilities
    && engineProfile.capabilities.supportsSilentPrime === true);
  if (projConfig && projConfig.silentPrime === true && supportsSilentPrime) {
    hooks.SessionStart = [
      {
        matcher: 'startup',
        hooks: [
          {
            type: 'command',
            command: '{{TANGLECLAW_DIR}}/data/hooks/sessionstart-prime.sh',
            statusMessage: 'Loading session prime...'
          }
        ]
      }
    ];
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
 *     write failure (permissions, ENOSPC, etc.). Callers should surface.
 *
 * @returns {{written: boolean, skipped: boolean, skipReason: string|null, drifted: boolean, configFilePath: string|null, error: string|null}}
 */
function writeEngineConfig(engineId, projectPath, projectConfig, engineProfile) {
  // Defer to the Prawduct V2 Claude Code plugin when it governs this project
  // (#330 hybrid). The plugin owns CLAUDE.md (a thin PRAWDUCT:ANCHOR file);
  // regenerating here would destructively clobber it on every launch/boot/PATCH.
  // Detection keys off the committed plugin install reference, which survives
  // TC's own regeneration — see isPluginGoverned.
  if (isPluginGoverned(projectPath)) {
    return { written: false, skipped: true, skipReason: 'project governed by the Prawduct V2 plugin — config generation deferred to the plugin', drifted: false, configFilePath: null, error: null };
  }
  // Deliberate no-op: engine has no config file (openclaw).
  // Per #240 PR Critic — silently skip so callers don't surface a
  // spurious "failed to write engine config" error/warning every time
  // a non-Claude/Codex/Aider/Gemini project is created or launched.
  if (!engineProfile || !engineProfile.configFormat || !engineProfile.configFormat.filename) {
    return { written: false, skipped: true, skipReason: 'engine has no config file (configFormat.filename is null)', drifted: false, configFilePath: null, error: null };
  }
  const content = generateConfig(engineId, projectConfig);
  if (!content) {
    return { written: false, skipped: true, skipReason: 'generateConfig returned empty (engine does not support config files for this project shape)', drifted: false, configFilePath: null, error: null };
  }
  const configFilePath = path.join(projectPath, engineProfile.configFormat.filename);
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
      if (normalizedExisting !== normalizedContent) {
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
          delete existing.hooks;
          fs.writeFileSync(settingsFile, JSON.stringify(existing, null, 2) + '\n');
          log.info('Cleared stale .claude/settings.json hooks for non-claude engine', {
            projectPath,
            engine: engineId
          });
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
  const baselineHooks = _buildBaselineHooks(projConfig, engineProfile);

  if (Object.keys(baselineHooks).length > 0) {
    settings.hooks = _resolveHooksObject(baselineHooks);
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
    hasBaselineHooks: Object.keys(baselineHooks).length > 0
  });
}

/**
 * Detect whether a project's dev-time governance is owned by the Prawduct V2
 * Claude Code plugin. When true, TangleClaw must NOT generate or overwrite that
 * project's governance config — `writeEngineConfig` (CLAUDE.md) and
 * `syncEngineHooks` (.claude/settings.json hooks) both defer to the plugin,
 * which is the source of truth (#330 hybrid).
 *
 * Signal: the committed plugin install reference — a truthy
 * `enabledPlugins["prawduct@<marketplace>"]` in the project's
 * `.claude/settings.json`. This is the same reference `/prawduct:onboard` writes
 * and `/prawduct:doctor` validates. It is a STABLE detection anchor because
 * `syncEngineHooks` only ever mutates the `.hooks` key and preserves all other
 * keys — so the reference survives TC's own regeneration even though CLAUDE.md
 * does not. Fails closed (returns false) on a missing/unreadable/malformed file
 * so a parse error can never accidentally suppress normal config generation.
 *
 * @param {string} projectPath - Absolute path to the project root.
 * @returns {boolean} True iff the Prawduct V2 plugin governs this project.
 */
function isPluginGoverned(projectPath) {
  try {
    const settingsFile = path.join(projectPath, '.claude', 'settings.json');
    if (!fs.existsSync(settingsFile)) return false;
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const enabled = settings && settings.enabledPlugins;
    if (!enabled || typeof enabled !== 'object') return false;
    return Object.keys(enabled).some((k) => k.startsWith('prawduct@') && enabled[k] === true);
  } catch {
    return false;
  }
}

/**
 * Classify a project's Prawduct governance state (#353). Reports what is
 * actually installed on disk — the V2 plugin, a legacy vendored governance
 * hook, or neither. Pure read: no DB, no writes, no mutation.
 *
 * The engine comes from the caller (the DB row is canonical — `.tangleclaw/
 * project.json` can be stale per #320) rather than this function re-reading
 * project config.
 *
 * There is deliberately no "drift" state. While projects carried a methodology
 * label, a Claude project labeled `prawduct` with no enforcement installed was a
 * detectable contradiction — it *claimed* governance it did not have. With the
 * label gone (#538), governance is simply a fact about the filesystem and
 * nothing can contradict it: `ungoverned` is a neutral answer, not a fault.
 * An alarming state here would flag every ordinary un-onboarded project.
 *
 * @param {string} projectPath - Absolute path to the project root.
 * @param {{engineId?: string}} [meta] - Engine id from the canonical projects DB row.
 * @returns {'governed-plugin'|'governed-vendored'|'ungoverned'|'not-applicable'}
 *   `governed-plugin` (on the V2 plugin), `governed-vendored` (legacy in-repo
 *   hook present), `ungoverned` (a Claude project with neither — neutral), or
 *   `not-applicable` (non-Claude engine, where governance via the Claude
 *   plugin/hook cannot apply at all).
 */
function governanceState(projectPath, meta) {
  const engineId = meta && meta.engineId;
  // Prawduct governance is a Claude-plugin / Claude-hook concept; on any other
  // engine the question doesn't apply.
  if (engineId !== 'claude') return 'not-applicable';
  if (isPluginGoverned(projectPath)) return 'governed-plugin';
  // A vendored `tools/product-hook` means the project carries its own pre-plugin
  // copy of the governance runtime (Cohort A).
  if (fs.existsSync(path.join(projectPath, 'tools', 'product-hook'))) return 'governed-vendored';
  return 'ungoverned';
}

// #262 (C1) — test seam for the two foreign reads the migration action makes:
// TangleClaw's OWN plugin reference (the canonical pin) and the machine-scope
// plugin-install check. Overridable in tests so they don't depend on live state.
const _internal = {
  selfSettingsPath: () => path.join(__dirname, '..', '.claude', 'settings.json'),
  pluginsHome: () => path.join(os.homedir(), '.claude', 'plugins')
};

/**
 * Read TangleClaw's OWN plugin reference so a migration writes whatever version
 * TC itself currently references — single source of truth that survives a pin
 * bump (no hardcoded `v2.1.5`). Returns `{ enabledPlugins, extraKnownMarketplaces }`
 * limited to the prawduct entries, or null if TC is not itself plugin-governed
 * (you cannot migrate a project onto a plugin TC doesn't reference). Fails
 * closed (null) on a missing/unreadable/malformed self settings file.
 *
 * @returns {{enabledPlugins: object, extraKnownMarketplaces: object}|null}
 */
function _readSelfPluginRef() {
  try {
    const s = JSON.parse(fs.readFileSync(_internal.selfSettingsPath(), 'utf8'));
    const enabled = s && s.enabledPlugins;
    if (!enabled || typeof enabled !== 'object') return null;
    const prawductKeys = Object.keys(enabled).filter((k) => k.startsWith('prawduct@') && enabled[k] === true);
    if (prawductKeys.length === 0) return null;
    const enabledPlugins = {};
    for (const k of prawductKeys) enabledPlugins[k] = true;
    const markets = s.extraKnownMarketplaces;
    const extraKnownMarketplaces = {};
    if (markets && typeof markets === 'object' && markets.prawduct) {
      extraKnownMarketplaces.prawduct = markets.prawduct;
    }
    return { enabledPlugins, extraKnownMarketplaces };
  } catch {
    return null;
  }
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
 * @param {object} [options.pluginRef] - Override the reference (tests); defaults to TC's own
 * @returns {{written: boolean, alreadyGoverned: boolean, error?: string}}
 */
function migrateToPlugin(projectPath, options = {}) {
  if (isPluginGoverned(projectPath)) {
    return { written: false, alreadyGoverned: true };
  }
  const ref = options.pluginRef || _readSelfPluginRef();
  if (!ref) {
    return {
      written: false,
      alreadyGoverned: false,
      error: 'no plugin reference available (TangleClaw is not itself plugin-governed)'
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

  // Non-destructive merge: preserve every existing key; add/merge the plugin ref.
  settings.enabledPlugins = { ...(settings.enabledPlugins || {}), ...ref.enabledPlugins };
  if (ref.extraKnownMarketplaces && Object.keys(ref.extraKnownMarketplaces).length > 0) {
    settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces || {}), ...ref.extraKnownMarketplaces };
  }

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
  detect,
  detectEngine,
  isPluginGoverned,
  governanceState,
  migrateToPlugin,
  pluginInstalledAtMachineScope,
  _readSelfPluginRef,
  _internal,
  listWithAvailability,
  getWithAvailability,
  validateProfile,
  generateConfig,
  writeEngineConfig,
  validateParity,
  validateStatusParity,
  _getRulesContent,
  _serviceTokenAuthLines,
  _generateClaudeMd,
  _generateCodexYaml,
  _generateAiderConf,
  _generateGeminiMd,
  syncEngineHooks,
  _resolveHookPlaceholders,
  _buildSharedDocsSection,
  _buildBaselineHooks
};
