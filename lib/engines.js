'use strict';

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
    default:
      log.warn('Unknown config generator', { engineId, generator });
      return null;
  }
}

/**
 * Generate CLAUDE.md content for Claude Code.
 * @param {object} projectConfig - Per-project config
 * @param {object} [methodologyTemplate] - Methodology template
 * @returns {string}
 */
function _generateClaudeMd(projectConfig, methodologyTemplate) {
  const lines = ['# CLAUDE.md — Generated by TangleClaw', ''];

  // Core rules
  lines.push('## Core Rules (Enforced)', '');
  const coreRules = projectConfig.rules && projectConfig.rules.core ? projectConfig.rules.core : {};
  if (coreRules.changelogPerChange !== false) lines.push('- Update CHANGELOG.md with every change');
  if (coreRules.jsdocAllFunctions !== false) lines.push('- All functions must have JSDoc comments');
  if (coreRules.unitTestRequirements !== false) lines.push('- Write tests alongside implementation');
  if (coreRules.sessionWrapProtocol !== false) lines.push('- Follow session wrap protocol before ending');
  if (coreRules.porthubRegistration !== false) lines.push('- All port assignments go through PortHub');
  lines.push('');

  // Extension rules
  const extensions = projectConfig.rules && projectConfig.rules.extensions ? projectConfig.rules.extensions : {};
  const activeExtensions = Object.entries(extensions).filter(([, v]) => v === true);
  if (activeExtensions.length > 0) {
    lines.push('## Extension Rules', '');
    for (const [rule] of activeExtensions) {
      lines.push(`- ${_ruleLabel(rule)}`);
    }
    lines.push('');
  }

  // Methodology info
  if (methodologyTemplate) {
    lines.push(`## Methodology: ${methodologyTemplate.name}`, '');
    if (methodologyTemplate.description) {
      lines.push(methodologyTemplate.description, '');
    }
  }

  return lines.join('\n');
}

/**
 * Generate .codex.yaml content for Codex.
 * @param {object} projectConfig - Per-project config
 * @param {object} [methodologyTemplate] - Methodology template
 * @returns {string}
 */
function _generateCodexYaml(projectConfig, methodologyTemplate) {
  const lines = ['# Generated by TangleClaw'];

  if (methodologyTemplate) {
    lines.push(`methodology: ${methodologyTemplate.id}`);
  }

  const extensions = projectConfig.rules && projectConfig.rules.extensions ? projectConfig.rules.extensions : {};
  if (extensions.loggingLevel) {
    lines.push(`logging_level: ${extensions.loggingLevel}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate .aider.conf.yml content for Aider.
 * @param {object} projectConfig - Per-project config
 * @param {object} [_methodologyTemplate] - Methodology template
 * @returns {string}
 */
function _generateAiderConf(projectConfig, _methodologyTemplate) {
  const lines = ['# Generated by TangleClaw'];

  const extensions = projectConfig.rules && projectConfig.rules.extensions ? projectConfig.rules.extensions : {};
  if (extensions.loggingLevel) {
    lines.push(`verbose: ${extensions.loggingLevel === 'debug'}`);
  }

  return lines.join('\n') + '\n';
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

module.exports = {
  detect,
  detectEngine,
  listWithAvailability,
  getWithAvailability,
  validateProfile,
  generateConfig,
  _generateClaudeMd,
  _generateCodexYaml,
  _generateAiderConf
};
