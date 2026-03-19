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

const PROJECT_NAME_REGEX = /^[a-zA-Z0-9 _-]+$/;

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
    return { valid: false, error: 'Project name may only contain letters, numbers, spaces, hyphens, and underscores' };
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
  const projectsDir = resolveProjectsDir(config.projectsDir);
  const projectPath = path.join(projectsDir, data.name);

  // Check if directory already exists
  if (fs.existsSync(projectPath)) {
    return { project: null, errors: [`Directory "${data.name}" already exists in ${projectsDir}`] };
  }

  // Validate engine exists
  const engineId = data.engine || config.defaultEngine || 'claude';
  const engineProfile = store.engines.get(engineId);
  if (!engineProfile) {
    return { project: null, errors: [`Engine "${engineId}" not found`] };
  }

  // Validate methodology exists (null = no methodology)
  const methodologyId = data.methodology === null ? null : (data.methodology || config.defaultMethodology || null);
  let methodologyTemplate = null;
  if (methodologyId) {
    methodologyTemplate = store.templates.get(methodologyId);
    if (!methodologyTemplate) {
      return { project: null, errors: [`Methodology "${methodologyId}" not found`] };
    }
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

  // Initialize methodology (skip if none selected)
  if (methodologyId) {
    log.debug('Initializing methodology', { template: methodologyId, project: data.name, path: projectPath });
    const initResult = methodologies.initialize(projectPath, methodologyId, {
      projectName: data.name
    });
    log.debug('Methodology init result', { success: initResult.success, created: initResult.created, errors: initResult.errors });
    if (!initResult.success) {
      errors.push(...initResult.errors);
    }
  }

  // Write per-project config
  const projectConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
  projectConfig.engine = engineId;
  projectConfig.methodology = methodologyId;
  if (data.tags) projectConfig.tags = data.tags;

  // Apply methodology default rules
  if (methodologyTemplate && methodologyTemplate.defaultRules) {
    for (const [rule, value] of Object.entries(methodologyTemplate.defaultRules)) {
      if (projectConfig.rules.extensions.hasOwnProperty(rule)) {
        projectConfig.rules.extensions[rule] = value;
      }
    }
  }

  store.projectConfig.save(projectPath, projectConfig);

  // Generate engine config (pass null template if no methodology)
  const configContent = engines.generateConfig(engineId, projectConfig, methodologyTemplate || {});
  if (configContent && engineProfile.configFormat) {
    try {
      const configFilePath = path.join(projectPath, engineProfile.configFormat.filename);
      fs.writeFileSync(configFilePath, configContent);
    } catch (err) {
      errors.push(`Failed to write engine config: ${err.message}`);
    }
  }

  // Sync engine hooks to match methodology
  try {
    engines.syncEngineHooks(projectPath, methodologyTemplate);
  } catch (err) {
    log.warn('Failed to sync engine hooks during project creation', { error: err.message });
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

  // Session info — include both active and wrapping sessions
  let session = null;
  const activeSession = store.sessions.getActive(project.id);
  if (activeSession) {
    session = {
      active: true,
      status: activeSession.status,
      startedAt: activeSession.startedAt,
      tmuxSession: activeSession.tmuxSession
    };
  } else {
    const wrappingSession = store.sessions.getWrapping(project.id);
    if (wrappingSession) {
      session = {
        active: true,
        status: 'wrapping',
        startedAt: wrappingSession.startedAt,
        tmuxSession: wrappingSession.tmuxSession
      };
    }
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
 * List all projects: merge SQLite-registered projects with ALL filesystem directories.
 * Unregistered dirs get { registered: false } entries with basic git info.
 * @param {object} [options] - Filter options passed to store.projects.list for registered projects
 * @returns {object[]}
 */
function listAllProjects(options = {}) {
  const registered = listProjects(options);
  const registeredNames = new Set(registered.map(p => p.name));

  const config = store.config.load();
  const projectsDir = resolveProjectsDir(config.projectsDir);

  if (!fs.existsSync(projectsDir)) {
    return registered.map(p => ({ ...p, registered: true }));
  }

  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return registered.map(p => ({ ...p, registered: true }));
  }

  const unregistered = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (registeredNames.has(entry.name)) continue;

    const dirPath = path.join(projectsDir, entry.name);

    // Basic git info
    let gitInfo = null;
    try {
      gitInfo = git.getInfo(dirPath);
    } catch {
      // Not a git repo or git not available
    }

    // Detect methodology
    const detectedMethodology = methodologies.detect(dirPath);

    // Check for TangleClaw config
    const hasTangleclawConfig = fs.existsSync(path.join(dirPath, '.tangleclaw', 'project.json'));

    unregistered.push({
      id: null,
      name: entry.name,
      path: dirPath,
      registered: false,
      engine: null,
      methodology: detectedMethodology ? { id: detectedMethodology.id, name: detectedMethodology.name, phase: null } : null,
      tags: [],
      ports: {},
      session: null,
      git: gitInfo,
      status: null,
      hasTangleclawConfig,
      createdAt: null,
      updatedAt: null,
      archived: false
    });
  }

  const result = registered.map(p => ({ ...p, registered: true }));
  return [...result, ...unregistered].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

/**
 * Attach an existing filesystem directory as a registered project.
 * Detects methodology, reads existing .tangleclaw/project.json if present.
 * @param {string} name - Directory name in projectsDir
 * @returns {{ project: object|null, errors: string[] }}
 */
function attachProject(name) {
  const errors = [];

  const nameCheck = validateName(name);
  if (!nameCheck.valid) {
    return { project: null, errors: [nameCheck.error] };
  }

  const existing = store.projects.getByName(name);
  if (existing) {
    return { project: null, errors: [`Project "${name}" already registered`] };
  }

  const config = store.config.load();
  const projectsDir = resolveProjectsDir(config.projectsDir);
  const projPath = path.join(projectsDir, name);

  if (!fs.existsSync(projPath) || !fs.statSync(projPath).isDirectory()) {
    return { project: null, errors: [`Directory "${name}" not found in ${projectsDir}`] };
  }

  // Read existing project config if present
  const projConfigPath = path.join(projPath, '.tangleclaw', 'project.json');
  let engineId = config.defaultEngine || 'claude';
  let methodologyId = null;

  if (fs.existsSync(projConfigPath)) {
    try {
      const existingConfig = JSON.parse(fs.readFileSync(projConfigPath, 'utf8'));
      if (existingConfig.engine) engineId = existingConfig.engine;
      if (existingConfig.methodology) methodologyId = existingConfig.methodology;
    } catch (err) {
      errors.push(`Failed to read existing project.json: ${err.message}`);
    }
  }

  // Detect methodology if not set
  if (!methodologyId) {
    const detected = methodologies.detect(projPath);
    if (detected) methodologyId = detected.id;
  }

  if (!methodologyId) {
    methodologyId = config.defaultMethodology || null;
  }

  // Register in SQLite
  const project = store.projects.create({
    name,
    path: projPath,
    engine: engineId,
    methodology: methodologyId,
    tags: [],
    ports: {}
  });

  // Write per-project config if none exists
  if (!fs.existsSync(projConfigPath)) {
    const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
    projConfig.engine = engineId;
    projConfig.methodology = methodologyId;
    store.projectConfig.save(projPath, projConfig);
  }

  // Sync engine hooks to match methodology
  if (methodologyId) {
    const methTemplate = store.templates.get(methodologyId);
    try {
      engines.syncEngineHooks(projPath, methTemplate);
    } catch (err) {
      log.warn('Failed to sync engine hooks during project attach', { error: err.message });
    }
  }

  log.info('Project attached', { name, path: projPath, engine: engineId, methodology: methodologyId });
  return { project: enrichProject(project), errors };
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

  // Name change — update port leases to match
  if (updates.name && updates.name !== name) {
    const existing = store.projects.getByName(updates.name);
    if (existing) {
      return { project: null, methodologySwitch: null, errors: [`Project "${updates.name}" already exists`] };
    }
    storeUpdates.name = updates.name;
    const renamed = store.portLeases.renameProject(name, updates.name);
    if (renamed > 0) {
      log.info('Port leases renamed with project', { from: name, to: updates.name, count: renamed });
    }
  }

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

  // Methodology change (archive-and-init, or remove)
  if (updates.hasOwnProperty('methodology') && updates.methodology !== project.methodology) {
    if (updates.methodology === null) {
      // Removing methodology — archive current state if any
      if (project.methodology) {
        const currentTemplate = store.templates.get(project.methodology);
        if (currentTemplate && currentTemplate.detection) {
          const archiveResult = methodologies._archiveMethodology(project.path, currentTemplate);
          if (archiveResult.archivePath) {
            methodologySwitch = { from: project.methodology, to: null, archivePath: archiveResult.archivePath };
          }
        }
      }
      storeUpdates.methodology = null;
      const projConfig = store.projectConfig.load(project.path);
      projConfig.methodology = null;
      projConfig.methodologyPhase = null;

      // Track archive in project config
      if (methodologySwitch && methodologySwitch.archivePath) {
        if (!projConfig.methodologyArchives) projConfig.methodologyArchives = [];
        projConfig.methodologyArchives.push({
          methodology: project.methodology,
          archivePath: methodologySwitch.archivePath,
          archivedAt: new Date().toISOString()
        });
      }

      store.projectConfig.save(project.path, projConfig);

      // Clear hooks (no methodology = no hooks)
      try {
        engines.syncEngineHooks(project.path, null);
      } catch (err) {
        log.warn('Failed to clear engine hooks after methodology removal', { error: err.message });
      }
    } else {
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

        // Track archive in project config
        if (switchResult.archivePath) {
          if (!projConfig.methodologyArchives) projConfig.methodologyArchives = [];
          projConfig.methodologyArchives.push({
            methodology: project.methodology,
            archivePath: switchResult.archivePath,
            archivedAt: new Date().toISOString()
          });
        }

        store.projectConfig.save(project.path, projConfig);

        // Sync hooks to match new methodology
        try {
          engines.syncEngineHooks(project.path, newTemplate);
        } catch (err) {
          log.warn('Failed to sync engine hooks after methodology switch', { error: err.message });
        }
      }
    }
  }

  // Phase update
  if (updates.phase !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    const methTemplate = store.templates.get(projConfig.methodology || project.methodology);
    if (updates.phase === null) {
      projConfig.methodologyPhase = null;
      store.projectConfig.save(project.path, projConfig);
    } else if (methTemplate) {
      const result = methodologies.setPhase(project.path, updates.phase, methTemplate.id);
      if (!result.success) {
        errors.push(result.error);
      }
    } else {
      errors.push('Cannot set phase: no methodology assigned');
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

  const finalName = storeUpdates.name || name;
  const updated = enrichProject(store.projects.getByName(finalName));
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
  const tmuxName = tmux.toSessionName(name);
  if (tmux.hasSession(tmuxName)) {
    try {
      tmux.killSession(tmuxName);
    } catch (err) {
      errors.push(`Failed to kill tmux session: ${err.message}`);
    }
  }

  // Release ALL ports registered to this project (not just project.ports)
  try {
    const released = store.portLeases.releaseByProject(name);
    if (released > 0) {
      log.info('Released ports on project delete', { project: name, count: released });
    }
  } catch (err) {
    errors.push(`Failed to release ports: ${err.message}`);
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
  const projectsDir = resolveProjectsDir(config.projectsDir);

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
function resolveProjectsDir(dir) {
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
  listAllProjects,
  attachProject,
  getProject,
  updateProject,
  deleteProject,
  detectExistingProjects,
  resolveProjectsDir
};
