'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('methodologies');

// ── Template Validation ──

/**
 * Validate a methodology template has all required fields and correct structure.
 * @param {object} template - Template object to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTemplate(template) {
  const errors = [];

  if (!template || typeof template !== 'object') {
    return { valid: false, errors: ['Template must be a non-null object'] };
  }

  // Required top-level fields
  const required = ['id', 'name', 'description', 'type', 'version'];
  for (const field of required) {
    if (!template[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Type must be "methodology"
  if (template.type && template.type !== 'methodology') {
    errors.push(`type must be "methodology", got "${template.type}"`);
  }

  // Version must be semver-like
  if (template.version && !/^\d+\.\d+\.\d+/.test(template.version)) {
    errors.push(`version must be semver format (e.g. "1.0.0"), got "${template.version}"`);
  }

  // Phases validation
  if (template.phases !== undefined) {
    if (!Array.isArray(template.phases)) {
      errors.push('phases must be an array');
    } else {
      const validWeights = ['deep', 'normal', 'focused'];
      const phaseIds = new Set();
      for (let i = 0; i < template.phases.length; i++) {
        const phase = template.phases[i];
        if (!phase.id) errors.push(`phases[${i}].id is required`);
        if (!phase.name) errors.push(`phases[${i}].name is required`);
        if (phase.weight && !validWeights.includes(phase.weight)) {
          errors.push(`phases[${i}].weight must be one of: ${validWeights.join(', ')}`);
        }
        if (phase.id && phaseIds.has(phase.id)) {
          errors.push(`Duplicate phase id: "${phase.id}"`);
        }
        if (phase.id) phaseIds.add(phase.id);
      }
    }
  }

  // StatusContract validation
  if (template.statusContract !== undefined && template.statusContract !== null) {
    const sc = template.statusContract;
    if (typeof sc !== 'object') {
      errors.push('statusContract must be an object');
    } else {
      const validParseStrategies = ['yaml-field', 'json', 'regex', 'custom', null];
      if (sc.parse !== undefined && !validParseStrategies.includes(sc.parse)) {
        errors.push(`statusContract.parse must be one of: ${validParseStrategies.filter(Boolean).join(', ')}`);
      }
      if (sc.parse && (sc.parse === 'yaml-field' || sc.parse === 'json') && !sc.field) {
        errors.push(`statusContract.field is required when parse is "${sc.parse}"`);
      }
    }
  }

  // Detection validation
  if (template.detection !== undefined && template.detection !== null) {
    const det = template.detection;
    if (typeof det !== 'object') {
      errors.push('detection must be an object');
    } else {
      const validStrategies = ['directory', 'file', 'custom'];
      if (!det.strategy) {
        errors.push('detection.strategy is required');
      } else if (!validStrategies.includes(det.strategy)) {
        errors.push(`detection.strategy must be one of: ${validStrategies.join(', ')}`);
      }
      if (!det.target) {
        errors.push('detection.target is required');
      }
    }
  }

  // Init validation
  if (template.init !== undefined && template.init !== null) {
    const init = template.init;
    if (typeof init !== 'object') {
      errors.push('init must be an object');
    } else {
      if (init.directories !== undefined && !Array.isArray(init.directories)) {
        errors.push('init.directories must be an array');
      }
      if (init.files !== undefined && typeof init.files !== 'object') {
        errors.push('init.files must be an object');
      }
    }
  }

  // evalDimensions validation
  if (template.evalDimensions !== undefined && template.evalDimensions !== null) {
    const ed = template.evalDimensions;
    if (typeof ed !== 'object') {
      errors.push('evalDimensions must be an object');
    } else {
      if (!ed.schemaVersion) {
        errors.push('evalDimensions.schemaVersion is required');
      }
      if (ed.tier1 !== undefined) {
        if (!Array.isArray(ed.tier1)) {
          errors.push('evalDimensions.tier1 must be an array');
        } else {
          for (let i = 0; i < ed.tier1.length; i++) {
            const t = ed.tier1[i];
            if (!t.id) errors.push(`evalDimensions.tier1[${i}].id is required`);
            if (!t.description) errors.push(`evalDimensions.tier1[${i}].description is required`);
            if (t.check !== 'pattern') errors.push(`evalDimensions.tier1[${i}].check must be "pattern"`);
            if (!Array.isArray(t.patterns)) errors.push(`evalDimensions.tier1[${i}].patterns must be an array`);
          }
        }
      }
      if (ed.tier2 !== undefined) {
        if (!Array.isArray(ed.tier2)) {
          errors.push('evalDimensions.tier2 must be an array');
        } else {
          for (let i = 0; i < ed.tier2.length; i++) {
            if (!ed.tier2[i].id) errors.push(`evalDimensions.tier2[${i}].id is required`);
            if (!ed.tier2[i].description) errors.push(`evalDimensions.tier2[${i}].description is required`);
          }
        }
      }
      if (ed.tier3 !== undefined) {
        const validWhen = ['always', 'execution_task', 'disagreement', 'high_stakes', 'multi_user', 'implementation_task', 'code_change'];
        if (!Array.isArray(ed.tier3)) {
          errors.push('evalDimensions.tier3 must be an array');
        } else {
          for (let i = 0; i < ed.tier3.length; i++) {
            const t = ed.tier3[i];
            if (!t.id) errors.push(`evalDimensions.tier3[${i}].id is required`);
            if (!t.description) errors.push(`evalDimensions.tier3[${i}].description is required`);
            if (!t.when) {
              errors.push(`evalDimensions.tier3[${i}].when is required`);
            } else if (!validWhen.includes(t.when)) {
              errors.push(`evalDimensions.tier3[${i}].when must be one of: ${validWhen.join(', ')}`);
            }
          }
        }
      }
      if (ed.judgeContext !== undefined && typeof ed.judgeContext !== 'string') {
        errors.push('evalDimensions.judgeContext must be a string');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Methodology Detection ──

/**
 * Detect which methodology is active in a project directory.
 * Scans all known templates and checks their detection config.
 * @param {string} projectPath - Absolute path to project root
 * @returns {{ id: string, name: string }|null} - Detected methodology or null
 */
function detect(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return null;
  }

  const templates = store.templates.list();

  for (const tmplSummary of templates) {
    const template = store.templates.get(tmplSummary.id);
    if (!template || !template.detection) continue;

    const detected = _checkDetection(projectPath, template.detection);
    if (detected) {
      log.debug('Methodology detected', { path: projectPath, id: template.id });
      return { id: template.id, name: template.name };
    }
  }

  return null;
}

/**
 * Check a single detection config against a project directory.
 * @param {string} projectPath - Absolute path to project root
 * @param {object} detection - Detection config { strategy, target }
 * @returns {boolean}
 */
function _checkDetection(projectPath, detection) {
  const { strategy, target } = detection;
  const targetPath = path.join(projectPath, target);

  switch (strategy) {
    case 'directory':
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    case 'file':
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
    case 'custom':
      return false; // Custom detection not implemented in v1
    default:
      log.warn('Unknown detection strategy', { strategy });
      return false;
  }
}

// ── Methodology Initialization ──

/**
 * Initialize a methodology in a project directory.
 * Creates directories, writes template files, runs postInit.
 * @param {string} projectPath - Absolute path to project root
 * @param {string} templateId - Methodology template id
 * @param {object} [options] - Optional settings
 * @param {string} [options.projectName] - Project name for template substitution
 * @returns {{ success: boolean, created: string[], errors: string[] }}
 */
function initialize(projectPath, templateId, options = {}) {
  const template = store.templates.get(templateId);
  if (!template) {
    return { success: false, created: [], errors: [`Methodology template "${templateId}" not found. Available templates: ${store.templates.list().map(t => t.id).join(', ') || 'none'}`] };
  }

  const created = [];
  const errors = [];

  // Create directories
  if (template.init && Array.isArray(template.init.directories)) {
    for (const dir of template.init.directories) {
      const dirPath = path.join(projectPath, dir);
      try {
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
          created.push(dir);
        }
      } catch (err) {
        errors.push(`Methodology init: failed to create directory "${dir}": ${err.message}`);
      }
    }
  }

  // Write template files
  if (template.init && template.init.files && typeof template.init.files === 'object') {
    for (const [filePath, content] of Object.entries(template.init.files)) {
      const fullPath = path.join(projectPath, filePath);
      try {
        // Ensure parent directory exists
        const parentDir = path.dirname(fullPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        // Template substitution
        let fileContent = content;
        if (options.projectName) {
          fileContent = fileContent.replace(/\{\{PROJECT_NAME\}\}/g, options.projectName);
        }

        if (!fs.existsSync(fullPath)) {
          fs.writeFileSync(fullPath, fileContent);
          created.push(filePath);
        }
      } catch (err) {
        errors.push(`Methodology init: failed to write file "${filePath}": ${err.message}`);
      }
    }
  }

  // Run postInit command
  if (template.init && template.init.postInit) {
    try {
      execSync(template.init.postInit, {
        cwd: projectPath,
        timeout: 10000,
        stdio: 'pipe'
      });
    } catch (err) {
      errors.push(`Methodology init: postInit command "${template.init.postInit}" failed: ${err.message}`);
    }
  }

  const success = errors.length === 0;
  if (success) {
    log.info('Methodology initialized', { path: projectPath, template: templateId });
  } else {
    log.warn('Methodology initialization had errors', { path: projectPath, template: templateId, errors });
  }

  return { success, created, errors };
}

// ── Methodology Switching ──

/**
 * Switch methodology for a project. Archives old state and initializes new methodology.
 * @param {string} projectPath - Absolute path to project root
 * @param {string} currentMethodology - Current methodology template id
 * @param {string} newMethodology - New methodology template id
 * @param {object} [options] - Optional settings
 * @param {string} [options.projectName] - Project name for template substitution
 * @returns {{ success: boolean, archivePath: string|null, initResult: object|null, errors: string[] }}
 */
function switchMethodology(projectPath, currentMethodology, newMethodology, options = {}) {
  const errors = [];

  // Validate new methodology exists
  const newTemplate = store.templates.get(newMethodology);
  if (!newTemplate) {
    return { success: false, archivePath: null, initResult: null, errors: [`Template "${newMethodology}" not found`] };
  }

  const currentTemplate = store.templates.get(currentMethodology);
  let archivePath = null;

  // Archive current methodology state
  if (currentTemplate && currentTemplate.detection) {
    const archiveResult = _archiveMethodology(projectPath, currentTemplate);
    if (archiveResult.error) {
      errors.push(archiveResult.error);
    } else {
      archivePath = archiveResult.archivePath;
    }
  }

  // Initialize new methodology
  const initResult = initialize(projectPath, newMethodology, options);
  if (!initResult.success) {
    errors.push(...initResult.errors);
  }

  const success = errors.length === 0;
  if (success) {
    log.info('Methodology switched', {
      path: projectPath,
      from: currentMethodology,
      to: newMethodology,
      archivePath
    });
  }

  return { success, archivePath, initResult, errors };
}

/**
 * Archive existing methodology state by renaming its directory.
 * @param {string} projectPath - Absolute path to project root
 * @param {object} template - Current methodology template
 * @returns {{ archivePath: string|null, error: string|null }}
 */
function _archiveMethodology(projectPath, template) {
  const { strategy, target } = template.detection;

  if (strategy !== 'directory' && strategy !== 'file') {
    return { archivePath: null, error: null }; // Nothing to archive
  }

  const sourcePath = path.join(projectPath, target);
  if (!fs.existsSync(sourcePath)) {
    return { archivePath: null, error: null }; // Nothing to archive
  }

  const archiveName = `${target}.archived`;
  const archiveFull = path.join(projectPath, archiveName);

  // Handle existing archive (add timestamp suffix)
  let finalArchivePath = archiveFull;
  if (fs.existsSync(archiveFull)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    finalArchivePath = `${archiveFull}-${timestamp}`;
  }

  try {
    fs.renameSync(sourcePath, finalArchivePath);
    return { archivePath: path.relative(projectPath, finalArchivePath), error: null };
  } catch (err) {
    return { archivePath: null, error: `Failed to archive "${target}": ${err.message}` };
  }
}

// ── Status Contract Execution ──

/**
 * Execute a methodology's status contract to get project status for dashboard display.
 * @param {string} projectPath - Absolute path to project root
 * @param {object} statusContract - Status contract config from template
 * @returns {{ badge: string|null, color: string|null, detail: string|null }}
 */
function executeStatusContract(projectPath, statusContract) {
  const defaultResult = { badge: null, color: null, detail: null };

  if (!statusContract || !statusContract.command) {
    return defaultResult;
  }

  let output;
  try {
    output = execSync(statusContract.command, {
      cwd: projectPath,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    log.debug('Status contract command failed', { path: projectPath });
    return defaultResult;
  }

  if (!output) return defaultResult;

  const detail = _parseStatusOutput(output, statusContract);
  const badge = statusContract.badge === 'phase' ? detail : (statusContract.badge || null);
  const color = _resolveColor(detail, statusContract.colorMap);

  return { badge: badge || detail, color, detail };
}

/**
 * Parse status contract output according to the configured parse strategy.
 * @param {string} output - Raw command output
 * @param {object} statusContract - Status contract config
 * @returns {string|null}
 */
function _parseStatusOutput(output, statusContract) {
  const { parse, field } = statusContract;

  switch (parse) {
    case 'yaml-field':
      return _parseYamlField(output, field);
    case 'json':
      return _parseJsonField(output, field);
    case 'regex':
      return _parseRegex(output, field);
    default:
      return output.split('\n')[0] || null;
  }
}

/**
 * Extract a field value from YAML-like output using simple line parsing.
 * Not a full YAML parser — handles simple key: value lines.
 * @param {string} output - YAML text
 * @param {string} fieldPath - Dot-separated field path
 * @returns {string|null}
 */
function _parseYamlField(output, fieldPath) {
  if (!fieldPath) return null;

  const parts = fieldPath.split('.');
  const lines = output.split('\n');

  // Simple YAML field extraction — look for the leaf key
  // Handles nested structures by tracking indentation context
  let currentDepth = 0;
  const pathStack = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - trimmed.length;
    const match = trimmed.match(/^([^:]+):\s*(.*)/);
    if (!match) continue;

    const key = match[1].trim();
    const value = match[2].trim();

    // Adjust path stack based on indentation
    while (pathStack.length > 0 && indent <= currentDepth - 2) {
      pathStack.pop();
      currentDepth -= 2;
    }

    pathStack.push(key);
    currentDepth = indent + 2;

    const currentPath = pathStack.join('.');
    if (currentPath === fieldPath && value) {
      // Remove surrounding quotes if present
      return value.replace(/^["']|["']$/g, '');
    }
  }

  return null;
}

/**
 * Extract a field value from JSON output.
 * @param {string} output - JSON text
 * @param {string} fieldPath - Dot-separated field path
 * @returns {string|null}
 */
function _parseJsonField(output, fieldPath) {
  try {
    const data = JSON.parse(output);
    const parts = fieldPath.split('.');
    let current = data;
    for (const part of parts) {
      if (current == null) return null;
      current = current[part];
    }
    return current != null ? String(current) : null;
  } catch {
    return null;
  }
}

/**
 * Extract a value from output using a regex pattern.
 * The field is used as the regex pattern, first capture group is returned.
 * @param {string} output - Text to search
 * @param {string} pattern - Regex pattern
 * @returns {string|null}
 */
function _parseRegex(output, pattern) {
  if (!pattern) return null;
  try {
    const match = output.match(new RegExp(pattern));
    return match ? (match[1] || match[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a status value to a color using the colorMap.
 * @param {string|null} value - Status value
 * @param {object} [colorMap] - Map of values to colors
 * @returns {string|null}
 */
function _resolveColor(value, colorMap) {
  if (!value || !colorMap) return null;
  return colorMap[value] || null;
}

// ── Phase Management ──

/**
 * Get the current methodology phase for a project.
 * @param {string} projectPath - Absolute path to project root
 * @returns {string|null} - Current phase id or null
 */
function getPhase(projectPath) {
  const projectConfig = store.projectConfig.load(projectPath);
  return projectConfig.methodologyPhase || null;
}

/**
 * Set the current methodology phase for a project.
 * Returns context reset offer if the phase transition warrants it.
 * @param {string} projectPath - Absolute path to project root
 * @param {string} phaseId - Phase id to set
 * @param {string} [templateId] - Methodology template id (for phase validation)
 * @returns {{ success: boolean, offerContextReset: boolean, error: string|null }}
 */
function setPhase(projectPath, phaseId, templateId) {
  // Validate phase exists in template
  if (templateId) {
    const template = store.templates.get(templateId);
    if (!template) {
      return { success: false, offerContextReset: false, error: `Template "${templateId}" not found` };
    }

    if (template.phases && template.phases.length > 0) {
      const phase = template.phases.find((p) => p.id === phaseId);
      if (!phase) {
        const validPhases = template.phases.map((p) => p.id).join(', ');
        return { success: false, offerContextReset: false, error: `Phase "${phaseId}" not found. Valid phases: ${validPhases}` };
      }

      // Check if this phase offers context reset
      const offerContextReset = !!phase.offerContextReset;

      const projectConfig = store.projectConfig.load(projectPath);
      projectConfig.methodologyPhase = phaseId;
      store.projectConfig.save(projectPath, projectConfig);

      log.info('Phase set', { path: projectPath, phase: phaseId });
      return { success: true, offerContextReset, error: null };
    }
  }

  // No template or no phases — just set it
  const projectConfig = store.projectConfig.load(projectPath);
  projectConfig.methodologyPhase = phaseId;
  store.projectConfig.save(projectPath, projectConfig);

  log.info('Phase set', { path: projectPath, phase: phaseId });
  return { success: true, offerContextReset: false, error: null };
}

// ── List/Get with Enrichment ──

/**
 * List methodology templates with summary info suitable for API response.
 * @returns {object[]}
 */
function listTemplates() {
  const templates = store.templates.list();
  return templates.map((t) => {
    const full = store.templates.get(t.id);
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      type: t.type,
      version: t.version,
      phases: full && full.phases ? full.phases.map((p) => p.id) : [],
      defaultRules: full ? (full.defaultRules || {}) : {}
    };
  });
}

/**
 * Get full methodology template details suitable for API response.
 * @param {string} id - Template id
 * @returns {object|null}
 */
function getTemplate(id) {
  return store.templates.get(id);
}

module.exports = {
  validateTemplate,
  detect,
  initialize,
  switchMethodology,
  executeStatusContract,
  getPhase,
  setPhase,
  listTemplates,
  getTemplate,
  _checkDetection,
  _parseStatusOutput,
  _parseYamlField,
  _parseJsonField,
  _parseRegex,
  _resolveColor,
  _archiveMethodology
};
