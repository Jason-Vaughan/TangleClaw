'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const git = require('./git');
const engines = require('./engines');
const methodologies = require('./methodologies');
const porthub = require('./porthub');
const tmux = require('./tmux');
const { createLogger } = require('./logger');

const log = createLogger('projects');

const PROJECT_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

// ── Password Hashing ──

/**
 * Hash a password using scrypt with a random salt.
 * @param {string} password - Plaintext password
 * @returns {string} - Format: salt:hash (both hex-encoded)
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash.
 * @param {string} password - Plaintext password to verify
 * @param {string} stored - Stored hash in salt:hash format
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}

/**
 * Check the delete password. Returns true if allowed (no password set, or password matches).
 * @param {string|undefined} providedPassword - Password from request body
 * @returns {{ allowed: boolean, error: string|null }}
 */
function checkDeletePassword(providedPassword) {
  const config = store.config.load();
  if (!config.deletePassword) {
    return { allowed: true, error: null };
  }
  if (!providedPassword) {
    return { allowed: false, error: 'Password required for this operation' };
  }
  // Support both hashed and plain text passwords (migration path)
  if (config.deletePassword.includes(':')) {
    // Hashed format
    if (verifyPassword(providedPassword, config.deletePassword)) {
      return { allowed: true, error: null };
    }
  } else {
    // Legacy plaintext — verify then upgrade to hash
    if (providedPassword === config.deletePassword) {
      // Upgrade to hashed format
      config.deletePassword = hashPassword(providedPassword);
      store.config.save(config);
      log.info('Upgraded deletePassword to hashed format');
      return { allowed: true, error: null };
    }
  }
  log.warn('Delete password verification failed');
  return { allowed: false, error: 'Incorrect password' };
}

// ── Validation ──

/**
 * Validate a project name.
 * @param {string} name - Project name to validate
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Project name is required' };
  }
  if (name.length > 64) {
    return { valid: false, error: 'Project name must be 64 characters or fewer' };
  }
  if (!PROJECT_NAME_REGEX.test(name)) {
    return { valid: false, error: 'Project name must match [a-zA-Z0-9_-]+' };
  }
  return { valid: true, error: null };
}

// ── Project Creation ──

/**
 * Create a new project: validate → create directory → scaffold → init methodology →
 * register ports → generate engine config → persist to SQLite.
 * @param {object} data - Project creation data
 * @param {string} data.name - Project directory name
 * @param {string} [data.engine] - Engine profile id
 * @param {string} [data.methodology] - Methodology template id
 * @param {string[]} [data.tags] - Tags
 * @param {boolean} [data.gitInit] - Initialize git repo (default true)
 * @returns {{ project: object, errors: string[] }}
 */
function createProject(data) {
  const errors = [];

  // Validate name
  const nameCheck = validateName(data.name);
  if (!nameCheck.valid) {
    return { project: null, errors: [nameCheck.error] };
  }

  // Check for duplicate
  const existing = store.projects.getByName(data.name);
  if (existing) {
    return { project: null, errors: [`Project "${data.name}" already exists`] };
  }

  // Resolve project path
  const config = store.config.load();
  const projectsDir = _resolveProjectsDir(config.projectsDir);
  const projectPath = path.join(projectsDir, data.name);

  // Check if directory already exists
  if (fs.existsSync(projectPath)) {
    return { project: null, errors: [`Directory "${data.name}" already exists in ${projectsDir}`] };
  }

  // Validate engine exists
  const engineId = data.engine || config.defaultEngine || 'claude-code';
  const engineProfile = store.engines.get(engineId);
  if (!engineProfile) {
    return { project: null, errors: [`Engine "${engineId}" not found`] };
  }

  // Validate methodology exists
  const methodologyId = data.methodology || config.defaultMethodology || 'minimal';
  const methodologyTemplate = store.templates.get(methodologyId);
  if (!methodologyTemplate) {
    return { project: null, errors: [`Methodology "${methodologyId}" not found`] };
  }

  // Create directory
  try {
    fs.mkdirSync(projectPath, { recursive: true });
  } catch (err) {
    return { project: null, errors: [`Failed to create directory: ${err.message}`] };
  }

  // Git init
  if (data.gitInit !== false) {
    try {
      require('node:child_process').execSync('git init', {
        cwd: projectPath,
        timeout: 5000,
        stdio: 'pipe'
      });
    } catch (err) {
      errors.push(`Git init failed: ${err.message}`);
    }
  }

  // Initialize methodology
  const initResult = methodologies.initialize(projectPath, methodologyId, {
    projectName: data.name
  });
  if (!initResult.success) {
    errors.push(...initResult.errors);
  }

  // Write per-project config
  const projectConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
  projectConfig.engine = engineId;
  projectConfig.methodology = methodologyId;
  if (data.tags) projectConfig.tags = data.tags;

  // Apply methodology default rules
  if (methodologyTemplate.defaultRules) {
    for (const [rule, value] of Object.entries(methodologyTemplate.defaultRules)) {
      if (projectConfig.rules.extensions.hasOwnProperty(rule)) {
        projectConfig.rules.extensions[rule] = value;
      }
    }
  }

  store.projectConfig.save(projectPath, projectConfig);

  // Generate engine config
  const configContent = engines.generateConfig(engineId, projectConfig, methodologyTemplate);
  if (configContent && engineProfile.configFormat) {
    try {
      const configFilePath = path.join(projectPath, engineProfile.configFormat.filename);
      fs.writeFileSync(configFilePath, configContent);
    } catch (err) {
      errors.push(`Failed to write engine config: ${err.message}`);
    }
  }

  // Register with PortHub (best-effort)
  const portResult = porthub.registerPort(config.ttydPort, data.name, 'ttyd', { permanent: true });
  const ports = {};
  if (portResult.success) {
    ports.ttyd = config.ttydPort;
    store.activity.log({ eventType: 'port.registered', detail: { port: config.ttydPort, purpose: 'ttyd' } });
  }

  // Persist to SQLite
  const project = store.projects.create({
    name: data.name,
    path: projectPath,
    engine: engineId,
    methodology: methodologyId,
    tags: data.tags || [],
    ports
  });

  log.info('Project created', { name: data.name, path: projectPath, engine: engineId, methodology: methodologyId });
  return { project, errors };
}

// ── Project Enrichment ──

/**
 * Enrich a project record with git info, session status, methodology status, engine info.
 * @param {object} project - Project record from store
 * @returns {object} - Enriched project
 */
function enrichProject(project) {
  // Engine info
  let engine = null;
  const engineProfile = store.engines.get(project.engineId);
  if (engineProfile) {
    const det = engines.detectEngine(engineProfile);
    engine = {
      id: project.engineId,
      name: engineProfile.name,
      available: det.available
    };
  }

  // Methodology info
  let methodology = null;
  const methodologyTemplate = store.templates.get(project.methodology);
  if (methodologyTemplate) {
    const projConfig = store.projectConfig.load(project.path);
    methodology = {
      id: project.methodology,
      name: methodologyTemplate.name,
      phase: projConfig.methodologyPhase || null
    };
  }

  // Session info
  let session = null;
  const activeSession = store.sessions.getActive(project.id);
  if (activeSession) {
    session = {
      active: true,
      status: activeSession.status,
      startedAt: activeSession.startedAt,
      tmuxSession: activeSession.tmuxSession
    };
  }

  // Git info
  let gitInfo = null;
  if (fs.existsSync(project.path)) {
    gitInfo = git.getInfo(project.path);
  }

  // Methodology status (badge/color/detail)
  let status = null;
  if (methodologyTemplate && methodologyTemplate.statusContract && fs.existsSync(project.path)) {
    status = methodologies.executeStatusContract(project.path, methodologyTemplate.statusContract);
  }

  return {
    id: project.id,
    name: project.name,
    path: project.path,
    engine,
    methodology,
    tags: project.tags,
    ports: project.ports,
    session,
    git: gitInfo,
    status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archived: project.archived
  };
}

/**
 * List all projects, enriched with metadata.
 * @param {object} [options] - Filter options passed to store.projects.list
 * @returns {object[]}
 */
function listProjects(options = {}) {
  const projects = store.projects.list(options);
  return projects.map(enrichProject);
}

/**
 * Get a single project by name, enriched.
 * @param {string} name - Project directory name
 * @returns {object|null}
 */
function getProject(name) {
  const project = store.projects.getByName(name);
  if (!project) return null;
  return enrichProject(project);
}

// ── Project Update ──

/**
 * Update project configuration (engine, methodology, tags, rules).
 * @param {string} name - Project name
 * @param {object} updates - Fields to update
 * @returns {{ project: object|null, methodologySwitch: object|null, errors: string[] }}
 */
function updateProject(name, updates) {
  const project = store.projects.getByName(name);
  if (!project) {
    return { project: null, methodologySwitch: null, errors: [`Project "${name}" not found`] };
  }

  const errors = [];
  let methodologySwitch = null;
  const storeUpdates = {};

  // Engine change
  if (updates.engine && updates.engine !== project.engineId) {
    const engineProfile = store.engines.get(updates.engine);
    if (!engineProfile) {
      return { project: null, methodologySwitch: null, errors: [`Engine "${updates.engine}" not found`] };
    }
    storeUpdates.engine_id = updates.engine;

    // Regenerate engine config
    const projConfig = store.projectConfig.load(project.path);
    projConfig.engine = updates.engine;
    store.projectConfig.save(project.path, projConfig);

    const methodologyTemplate = store.templates.get(project.methodology);
    const configContent = engines.generateConfig(updates.engine, projConfig, methodologyTemplate);
    if (configContent && engineProfile.configFormat) {
      try {
        fs.writeFileSync(path.join(project.path, engineProfile.configFormat.filename), configContent);
      } catch (err) {
        errors.push(`Failed to write engine config: ${err.message}`);
      }
    }
  }

  // Methodology change (archive-and-init)
  if (updates.methodology && updates.methodology !== project.methodology) {
    const newTemplate = store.templates.get(updates.methodology);
    if (!newTemplate) {
      return { project: null, methodologySwitch: null, errors: [`Methodology "${updates.methodology}" not found`] };
    }

    const switchResult = methodologies.switchMethodology(
      project.path,
      project.methodology,
      updates.methodology,
      { projectName: project.name }
    );

    if (!switchResult.success) {
      errors.push(...switchResult.errors);
    } else {
      storeUpdates.methodology = updates.methodology;
      methodologySwitch = {
        from: project.methodology,
        to: updates.methodology,
        archivePath: switchResult.archivePath
      };

      // Update project config
      const projConfig = store.projectConfig.load(project.path);
      projConfig.methodology = updates.methodology;
      projConfig.methodologyPhase = null;

      // Apply new methodology default rules
      if (newTemplate.defaultRules) {
        for (const [rule, value] of Object.entries(newTemplate.defaultRules)) {
          if (projConfig.rules.extensions.hasOwnProperty(rule)) {
            projConfig.rules.extensions[rule] = value;
          }
        }
      }

      store.projectConfig.save(project.path, projConfig);
    }
  }

  // Tags
  if (updates.tags !== undefined) {
    storeUpdates.tags = updates.tags;
  }

  // Rules update (extensions only — core cannot be disabled)
  if (updates.rules) {
    if (updates.rules.core) {
      // Reject attempt to modify core rules
      const coreDisabled = Object.entries(updates.rules.core).some(([, v]) => v === false);
      if (coreDisabled) {
        return { project: null, methodologySwitch: null, errors: ['Core rules cannot be disabled'] };
      }
    }

    const projConfig = store.projectConfig.load(project.path);
    if (updates.rules.extensions) {
      for (const [rule, value] of Object.entries(updates.rules.extensions)) {
        if (projConfig.rules.extensions.hasOwnProperty(rule)) {
          projConfig.rules.extensions[rule] = value;
        }
      }
    }
    store.projectConfig.save(project.path, projConfig);
  }

  // Quick commands
  if (updates.quickCommands !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.quickCommands = updates.quickCommands;
    store.projectConfig.save(project.path, projConfig);
  }

  // Actions
  if (updates.actions !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.actions = updates.actions;
    store.projectConfig.save(project.path, projConfig);
  }

  // Persist store updates
  if (Object.keys(storeUpdates).length > 0) {
    store.projects.update(project.id, storeUpdates);
  }

  const updated = enrichProject(store.projects.getByName(name));
  return { project: updated, methodologySwitch, errors };
}

// ── Project Deletion ──

/**
 * Delete or archive a project.
 * @param {string} name - Project name
 * @param {object} [options]
 * @param {boolean} [options.deleteFiles] - Delete project directory (default false, archive only)
 * @returns {{ success: boolean, filesDeleted: boolean, errors: string[] }}
 */
function deleteProject(name, options = {}) {
  const project = store.projects.getByName(name);
  if (!project) {
    return { success: false, filesDeleted: false, errors: [`Project "${name}" not found`] };
  }

  const errors = [];

  // Kill any active tmux session
  if (tmux.hasSession(name)) {
    try {
      tmux.killSession(name);
    } catch (err) {
      errors.push(`Failed to kill tmux session: ${err.message}`);
    }
  }

  // Release ports from PortHub
  if (project.ports && Object.keys(project.ports).length > 0) {
    const releaseResult = porthub.releasePorts(project.ports);
    if (releaseResult.errors.length > 0) {
      errors.push(...releaseResult.errors);
    }
    for (const port of releaseResult.released) {
      store.activity.log({ projectId: project.id, eventType: 'port.released', detail: { port } });
    }
  }

  let filesDeleted = false;
  if (options.deleteFiles && fs.existsSync(project.path)) {
    try {
      fs.rmSync(project.path, { recursive: true, force: true });
      filesDeleted = true;
    } catch (err) {
      errors.push(`Failed to delete project files: ${err.message}`);
    }
  }

  // Remove from SQLite (cascades sessions, learnings)
  store.projects.delete(project.id);

  log.info('Project deleted', { name, filesDeleted });
  return { success: true, filesDeleted, errors };
}

// ── Auto-Detection ──

/**
 * Scan the projects directory for existing projects that aren't registered.
 * Detects methodology markers and auto-registers discovered projects.
 * @returns {{ detected: object[], errors: string[] }}
 */
function detectExistingProjects() {
  const config = store.config.load();
  const projectsDir = _resolveProjectsDir(config.projectsDir);

  if (!fs.existsSync(projectsDir)) {
    return { detected: [], errors: [] };
  }

  const detected = [];
  const errors = [];

  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (err) {
    return { detected: [], errors: [`Failed to read projects directory: ${err.message}`] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const dirPath = path.join(projectsDir, entry.name);

    // Skip if already registered
    const existing = store.projects.getByName(entry.name);
    if (existing) continue;

    // Check for TangleClaw config
    const hasTangleclawConfig = fs.existsSync(path.join(dirPath, '.tangleclaw', 'project.json'));

    // Detect methodology
    const detectedMethodology = methodologies.detect(dirPath);

    if (hasTangleclawConfig || detectedMethodology) {
      detected.push({
        name: entry.name,
        path: dirPath,
        methodology: detectedMethodology ? detectedMethodology.id : null,
        hasTangleclawConfig
      });
    }
  }

  return { detected, errors };
}

// ── Helpers ──

/**
 * Resolve the projects directory path, expanding ~ to home dir.
 * @param {string} dir - Projects directory (may start with ~)
 * @returns {string}
 */
function _resolveProjectsDir(dir) {
  if (dir.startsWith('~')) {
    return path.join(process.env.HOME || '', dir.slice(1));
  }
  return path.resolve(dir);
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkDeletePassword,
  validateName,
  createProject,
  enrichProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  detectExistingProjects,
  _resolveProjectsDir
};
