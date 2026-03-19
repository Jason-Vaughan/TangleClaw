'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const store = require('./store');
const { createLogger } = require('./logger');

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
 * @returns {object[]} - Engine profiles enriched with `available` and `detectedPath` fields
 */
function listWithAvailability() {
  const profiles = store.engines.list();
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
      commands: profile.commands || []
    };
  });
}

/**
 * Get a single engine profile with availability.
 * @param {string} id - Engine profile id
 * @returns {object|null}
 */
function getWithAvailability(id) {
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
 * Translates methodology rules into the engine's config format.
 * @param {string} engineId - Engine profile id
 * @param {object} projectConfig - Per-project config
 * @param {object} [methodologyTemplate] - Methodology template
 * @returns {string|null} - Generated config content, or null if engine doesn't support config files
 */
function generateConfig(engineId, projectConfig, methodologyTemplate) {
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
      return _generateClaudeMd(projectConfig, methodologyTemplate);
    case 'codex-yaml':
      return _generateCodexYaml(projectConfig, methodologyTemplate);
    case 'aider-conf':
      return _generateAiderConf(projectConfig, methodologyTemplate);
    case 'gemini-md':
      return _generateGeminiMd(projectConfig, methodologyTemplate);
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
 * @returns {{ coreRulesLines: string[], extensionRulesLines: string[], porthubGuide: string|null, globalRules: string|null, serverPort: number }}
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

  const config = store.config.load();
  const serverPort = config.serverPort || 3101;

  return { coreRulesLines, extensionRulesLines, porthubGuide, globalRules, serverPort };
}

/**
 * Generate CLAUDE.md content for Claude Code.
 * @param {object} projectConfig - Per-project config
 * @param {object} [methodologyTemplate] - Methodology template
 * @returns {string}
 */
function _generateClaudeMd(projectConfig, methodologyTemplate) {
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
    lines.push(`**TangleClaw API base URL**: \`http://localhost:${rules.serverPort}\``, '');
  }

  // Methodology info
  if (methodologyTemplate) {
    lines.push(`## Methodology: ${methodologyTemplate.name}`, '');
    if (methodologyTemplate.description) {
      lines.push(methodologyTemplate.description, '');
    }
  }

  // Previous methodology archives
  if (projectConfig.methodologyArchives && projectConfig.methodologyArchives.length > 0) {
    lines.push('## Previous Methodology Archives', '');
    lines.push('Archived methodology state is available for reference. Review learnings and reflections for context on prior work:', '');
    for (const archive of projectConfig.methodologyArchives) {
      lines.push(`- \`${archive.archivePath}/\` (${archive.methodology}, archived ${archive.archivedAt})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate .codex.yaml content for Codex.
 * Includes full rules in the `instructions` multiline field.
 * @param {object} projectConfig - Per-project config
 * @param {object} [methodologyTemplate] - Methodology template
 * @returns {string}
 */
function _generateCodexYaml(projectConfig, methodologyTemplate) {
  const lines = ['# Generated by TangleClaw'];
  const rules = _getRulesContent(projectConfig);

  if (methodologyTemplate) {
    lines.push(`methodology: ${methodologyTemplate.id}`);
  }

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
    instrParts.push(`**TangleClaw API base URL**: \`http://localhost:${rules.serverPort}\``);
    instrParts.push('');
  }
  if (methodologyTemplate && methodologyTemplate.description) {
    instrParts.push(`## Methodology: ${methodologyTemplate.name}`);
    instrParts.push(methodologyTemplate.description);
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
 * @param {object} [methodologyTemplate] - Methodology template
 * @returns {string}
 */
function _generateAiderConf(projectConfig, methodologyTemplate) {
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
    lines.push(`# TangleClaw API: http://localhost:${rules.serverPort}`);
  }

  if (methodologyTemplate) {
    lines.push('#');
    lines.push(`# Methodology: ${methodologyTemplate.name}`);
    if (methodologyTemplate.description) {
      lines.push(`# ${methodologyTemplate.description}`);
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
 * Generate GEMINI.md content for Gemini CLI.
 * Nearly identical to CLAUDE.md — markdown format with rules, PortHub guide, methodology.
 * Written to .gemini/GEMINI.md in the project root.
 * @param {object} projectConfig - Per-project config
 * @param {object} [methodologyTemplate] - Methodology template
 * @returns {string}
 */
function _generateGeminiMd(projectConfig, methodologyTemplate) {
  const lines = ['# GEMINI.md — Generated by TangleClaw', ''];
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
    lines.push(`**TangleClaw API base URL**: \`http://localhost:${rules.serverPort}\``, '');
  }

  // Methodology info
  if (methodologyTemplate) {
    lines.push(`## Methodology: ${methodologyTemplate.name}`, '');
    if (methodologyTemplate.description) {
      lines.push(methodologyTemplate.description, '');
    }
  }

  // Previous methodology archives
  if (projectConfig.methodologyArchives && projectConfig.methodologyArchives.length > 0) {
    lines.push('## Previous Methodology Archives', '');
    lines.push('Archived methodology state is available for reference. Review learnings and reflections for context on prior work:', '');
    for (const archive of projectConfig.methodologyArchives) {
      lines.push(`- \`${archive.archivePath}/\` (${archive.methodology}, archived ${archive.archivedAt})`);
    }
    lines.push('');
  }

  return lines.join('\n');
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
 * core rules, PortHub guide, global rules, and methodology info are present.
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
  const template = { id: 'parity-check', name: 'ParityCheck', description: 'Parity validation' };

  const results = [];
  let allValid = true;

  for (const profile of profiles) {
    const errors = [];
    const content = generateConfig(profile.id, projectConfig, template);

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

    // Methodology check
    if (!content.includes('ParityCheck')) {
      errors.push('Missing methodology name');
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
 * Sync Claude Code session hooks in a project's .claude/settings.json
 * to match the methodology template's hook declarations.
 * Replaces only the hooks section — preserves permissions and other settings.
 * @param {string} projectPath - Absolute path to the project directory
 * @param {object|null} methodologyTemplate - Methodology template (null to clear hooks)
 */
function syncEngineHooks(projectPath, methodologyTemplate) {
  const settingsDir = path.join(projectPath, '.claude');
  const settingsFile = path.join(settingsDir, 'settings.json');

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

  // Determine hook declarations from template
  const claudeHooks = methodologyTemplate && methodologyTemplate.hooks && methodologyTemplate.hooks.claude
    ? methodologyTemplate.hooks.claude
    : null;

  if (claudeHooks && Object.keys(claudeHooks).length > 0) {
    // Resolve placeholders and set hooks
    settings.hooks = _resolveHooksObject(claudeHooks);
  } else {
    // No hooks for this methodology — remove the key entirely
    delete settings.hooks;
  }

  // Ensure .claude directory exists
  fs.mkdirSync(settingsDir, { recursive: true });

  // Write back
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  log.info('Synced engine hooks', {
    projectPath,
    methodology: methodologyTemplate ? methodologyTemplate.id : 'none',
    hasHooks: !!claudeHooks && Object.keys(claudeHooks).length > 0
  });
}

module.exports = {
  detect,
  detectEngine,
  listWithAvailability,
  getWithAvailability,
  validateProfile,
  generateConfig,
  validateParity,
  validateStatusParity,
  _getRulesContent,
  _generateClaudeMd,
  _generateCodexYaml,
  _generateAiderConf,
  _generateGeminiMd,
  syncEngineHooks,
  _resolveHookPlaceholders
};
