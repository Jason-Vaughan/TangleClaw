'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger, setLevel, initFileLogging } = require('./lib/logger');
const store = require('./lib/store');
const system = require('./lib/system');
const engines = require('./lib/engines');
const tmux = require('./lib/tmux');
const methodologies = require('./lib/methodologies');
const projects = require('./lib/projects');
const sessions = require('./lib/sessions');
const porthub = require('./lib/porthub');
const uploads = require('./lib/uploads');

const log = createLogger('server');

const MAX_BODY_SIZE = 10 * 1024; // 10 KB
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const PUBLIC_DIR = path.join(__dirname, 'public');

// ── Route Table ──

const routes = [];

/**
 * Register a route handler.
 * @param {string} method - HTTP method
 * @param {string} pattern - URL pattern (supports :param segments)
 * @param {Function} handler - (req, res, params, body) => void
 * @param {object} [options] - Optional route config
 * @param {number} [options.maxBodySize] - Override MAX_BODY_SIZE for this route
 */
function route(method, pattern, handler, options) {
  const paramNames = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({
    method: method.toUpperCase(),
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
    handler,
    options: options || {}
  });
}

/**
 * Match a request to a route.
 * @param {string} method - HTTP method
 * @param {string} pathname - URL path
 * @returns {{ handler: Function, params: object, options: object }|null}
 */
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = pathname.match(r.regex);
    if (match) {
      const params = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { handler: r.handler, params, options: r.options || {} };
    }
  }
  return null;
}

// ── Response Helpers ──

/**
 * Send a JSON response.
 * @param {http.ServerResponse} res
 * @param {number} status - HTTP status code
 * @param {object} data - Response body
 */
function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Send a standard error response.
 * @param {http.ServerResponse} res
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @param {string} code - Machine-readable error code
 */
function errorResponse(res, status, message, code) {
  jsonResponse(res, status, { error: message, code });
}

// ── Body Parser ──

/**
 * Parse JSON request body with size limit.
 * @param {http.IncomingMessage} req
 * @param {number} [maxSize] - Override default max body size
 * @returns {Promise<object|null>}
 */
function parseBody(req, maxSize) {
  const limit = maxSize || MAX_BODY_SIZE;
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return resolve(null);
    }

    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit && !rejected) {
        rejected = true;
        // Resume and discard remaining data so the response can be sent
        req.resume();
        reject({ status: 413, message: 'Request body too large', code: 'BODY_TOO_LARGE' });
        return;
      }
      if (!rejected) {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (err) {
        reject({ status: 400, message: 'Invalid JSON in request body', code: 'BAD_REQUEST' });
      }
    });

    req.on('error', (err) => {
      reject({ status: 500, message: err.message, code: 'INTERNAL_ERROR' });
    });
  });
}

// ── Static File Serving ──

/**
 * Serve a static file from the public directory.
 * @param {http.ServerResponse} res
 * @param {string} pathname - URL path
 * @returns {boolean} - Whether a file was served
 */
function serveStatic(res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname);

  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    errorResponse(res, 403, 'Forbidden', 'FORBIDDEN');
    return true;
  }

  // Default to index.html
  if (pathname === '/' || pathname === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.length,
    'Cache-Control': 'no-cache'
  });
  res.end(content);
  return true;
}

// ── Parse Query String ──

/**
 * Parse URL query parameters.
 * @param {string} search - Query string (e.g. '?key=value')
 * @returns {object}
 */
function parseQuery(search) {
  const params = {};
  if (!search) return params;
  const stripped = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of stripped.split('&')) {
    const [key, ...rest] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(rest.join('=') || '');
    }
  }
  return params;
}

// ── API Route Handlers ──

// GET /api/health
route('GET', '/api/health', (_req, res) => {
  const db = store.getDb();
  let dbStatus = 'unavailable';
  if (db) {
    try {
      db.prepare('SELECT 1').get();
      dbStatus = 'ok';
    } catch {
      dbStatus = 'unavailable';
    }
  }

  // tmux check (synchronous)
  let tmuxStatus = 'unavailable';
  try {
    require('node:child_process').execSync('tmux list-sessions 2>/dev/null', { timeout: 2000 });
    tmuxStatus = 'ok';
  } catch {
    try {
      require('node:child_process').execSync('which tmux', { timeout: 1000 });
      tmuxStatus = 'ok';
    } catch {
      tmuxStatus = 'unavailable';
    }
  }

  // ttyd check — TCP connect to configured port
  const config = store.config.load();
  const net = require('node:net');
  const socket = new net.Socket();
  socket.setTimeout(500);

  return new Promise((resolve) => {
    const respond = (ttyd) => {
      const version = _getVersion();
      const allOk = dbStatus === 'ok' && ttyd === 'ok';
      const status = dbStatus !== 'ok' ? 'degraded' : (allOk ? 'ok' : 'degraded');
      const httpStatus = dbStatus !== 'ok' ? 503 : 200;

      jsonResponse(res, httpStatus, {
        status,
        version,
        uptime: Math.floor(process.uptime()),
        services: {
          database: dbStatus,
          ttyd: ttyd,
          tmux: tmuxStatus
        }
      });
      resolve();
    };

    socket.connect(config.ttydPort, '127.0.0.1', () => {
      socket.destroy();
      respond('ok');
    });
    socket.on('error', () => {
      socket.destroy();
      respond('unavailable');
    });
    socket.on('timeout', () => {
      socket.destroy();
      respond('unavailable');
    });
  });
});

// GET /api/version
route('GET', '/api/version', (_req, res) => {
  jsonResponse(res, 200, { version: _getVersion() });
});

// GET /api/config
route('GET', '/api/config', (_req, res) => {
  const config = store.config.load();
  const redacted = { ...config };
  const hasPassword = !!redacted.deletePassword;
  delete redacted.deletePassword;
  redacted.deleteProtected = hasPassword;
  jsonResponse(res, 200, redacted);
});

// PATCH /api/config
route('PATCH', '/api/config', async (_req, res, _params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  const config = store.config.load();
  const allowedFields = [
    'serverPort', 'ttydPort', 'defaultEngine', 'defaultMethodology',
    'projectsDir', 'deletePassword', 'quickCommands', 'theme',
    'chimeEnabled', 'peekMode', 'setupComplete'
  ];

  const validThemes = ['dark', 'light', 'high-contrast'];
  const validPeekModes = ['drawer', 'modal', 'alert'];

  let requiresRestart = false;

  for (const [key, value] of Object.entries(body)) {
    if (!allowedFields.includes(key)) continue;

    // Validate specific fields
    if ((key === 'serverPort' || key === 'ttydPort') && typeof value !== 'number') {
      return errorResponse(res, 400, `${key} must be a number`, 'BAD_REQUEST');
    }
    if (key === 'theme' && !validThemes.includes(value)) {
      return errorResponse(res, 400, `theme must be one of: ${validThemes.join(', ')}`, 'BAD_REQUEST');
    }
    if (key === 'peekMode' && !validPeekModes.includes(value)) {
      return errorResponse(res, 400, `peekMode must be one of: ${validPeekModes.join(', ')}`, 'BAD_REQUEST');
    }
    if (key === 'setupComplete' && typeof value !== 'boolean') {
      return errorResponse(res, 400, 'setupComplete must be a boolean', 'BAD_REQUEST');
    }

    if (key === 'serverPort' || key === 'ttydPort') {
      if (config[key] !== value) requiresRestart = true;
    }

    // Hash deletePassword before persisting
    if (key === 'deletePassword' && value !== null) {
      config[key] = projects.hashPassword(value);
    } else {
      config[key] = value;
    }
  }

  store.config.save(config);

  // Build redacted response
  const redacted = { ...config };
  const hasPassword = !!redacted.deletePassword;
  delete redacted.deletePassword;
  redacted.deleteProtected = hasPassword;

  jsonResponse(res, 200, { ok: true, config: redacted, requiresRestart });
});

// POST /api/setup/scan — Scan a directory for existing projects
route('POST', '/api/setup/scan', (_req, res, _params, body) => {
  if (!body || typeof body.directory !== 'string') {
    return errorResponse(res, 400, 'directory is required', 'BAD_REQUEST');
  }

  const dir = projects.resolveProjectsDir(body.directory);

  if (!fs.existsSync(dir)) {
    return errorResponse(res, 400, `Directory does not exist: ${body.directory}`, 'BAD_REQUEST');
  }

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    return errorResponse(res, 400, `Cannot access directory: ${err.message}`, 'BAD_REQUEST');
  }
  if (!stat.isDirectory()) {
    return errorResponse(res, 400, `Path is not a directory: ${body.directory}`, 'BAD_REQUEST');
  }

  // Scan for projects in the specified directory
  const detected = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return errorResponse(res, 400, `Failed to read directory: ${err.message}`, 'BAD_REQUEST');
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const dirPath = path.join(dir, entry.name);

    // Detect methodology
    const detectedMethodology = methodologies.detect(dirPath);

    // Check for git
    let gitInfo = null;
    try {
      const git = require('./lib/git');
      gitInfo = git.getInfo(dirPath);
    } catch {
      // Not a git repo or git not available
    }

    // Check for TangleClaw config
    const hasTangleclawConfig = fs.existsSync(path.join(dirPath, '.tangleclaw', 'project.json'));

    // Include if it has any project markers (methodology, git, or tangleclaw config)
    if (detectedMethodology || (gitInfo && gitInfo.branch) || hasTangleclawConfig) {
      detected.push({
        name: entry.name,
        path: dirPath,
        methodology: detectedMethodology ? detectedMethodology.id : null,
        hasTangleclawConfig,
        git: gitInfo ? { branch: gitInfo.branch, dirty: gitInfo.dirty } : null
      });
    }
  }

  jsonResponse(res, 200, { projects: detected });
});

// POST /api/setup/complete — Batch setup: update config + attach projects
route('POST', '/api/setup/complete', (_req, res, _params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  const config = store.config.load();
  const warnings = [];

  // Update config fields
  if (body.projectsDir && typeof body.projectsDir === 'string') {
    config.projectsDir = body.projectsDir;
  }
  if (body.defaultEngine && typeof body.defaultEngine === 'string') {
    config.defaultEngine = body.defaultEngine;
  }
  if (body.defaultMethodology && typeof body.defaultMethodology === 'string') {
    config.defaultMethodology = body.defaultMethodology;
  }
  if (body.deletePassword !== undefined) {
    if (body.deletePassword && typeof body.deletePassword === 'string') {
      config.deletePassword = projects.hashPassword(body.deletePassword);
    } else {
      config.deletePassword = null;
    }
  }
  if (typeof body.chimeEnabled === 'boolean') {
    config.chimeEnabled = body.chimeEnabled;
  }

  // Mark setup as complete
  config.setupComplete = true;
  store.config.save(config);

  // Attach selected projects
  const attached = [];
  if (Array.isArray(body.projects)) {
    for (const proj of body.projects) {
      if (!proj || !proj.name || !proj.path) continue;

      // Validate path exists and is a directory before registering
      if (!fs.existsSync(proj.path) || !fs.statSync(proj.path).isDirectory()) {
        warnings.push(`Skipped "${proj.name}": path does not exist or is not a directory`);
        continue;
      }

      // Skip if already registered
      const existing = store.projects.getByName(proj.name);
      if (existing) {
        warnings.push(`Project "${proj.name}" already registered, skipped`);
        continue;
      }

      // Register in SQLite
      try {
        const engineId = config.defaultEngine || 'claude';
        const methodologyId = proj.methodology || config.defaultMethodology || 'minimal';

        store.projects.create({
          name: proj.name,
          path: proj.path,
          engine: engineId,
          methodology: methodologyId,
          tags: [],
          ports: {}
        });

        // Write per-project config if none exists
        const projConfigPath = path.join(proj.path, '.tangleclaw', 'project.json');
        if (!fs.existsSync(projConfigPath)) {
          const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
          projConfig.engine = engineId;
          projConfig.methodology = methodologyId;
          store.projectConfig.save(proj.path, projConfig);
        }

        attached.push(proj.name);
      } catch (err) {
        warnings.push(`Failed to attach "${proj.name}": ${err.message}`);
      }
    }
  }

  jsonResponse(res, 200, {
    ok: true,
    setupComplete: true,
    attached,
    warnings
  });
});

// GET /api/system
route('GET', '/api/system', (_req, res) => {
  const stats = system.getStats();
  jsonResponse(res, 200, stats);
});

// GET /api/engines
route('GET', '/api/engines', (_req, res) => {
  const list = engines.listWithAvailability();
  jsonResponse(res, 200, { engines: list });
});

// GET /api/engines/:id
route('GET', '/api/engines/:id', (_req, res, params) => {
  const profile = engines.getWithAvailability(params.id);
  if (!profile) {
    return errorResponse(res, 404, `Engine "${params.id}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, profile);
});

// POST /api/tmux/mouse
route('POST', '/api/tmux/mouse', (_req, res, _params, body) => {
  if (!body || typeof body.session !== 'string') {
    return errorResponse(res, 400, 'session is required', 'BAD_REQUEST');
  }
  if (typeof body.on !== 'boolean') {
    return errorResponse(res, 400, 'on must be a boolean', 'BAD_REQUEST');
  }

  try {
    tmux.setMouse(body.session, body.on, { hooks: !!body.hooks });
    jsonResponse(res, 200, { mouse: body.on, session: body.session });
  } catch (err) {
    return errorResponse(res, 404, err.message, 'NOT_FOUND');
  }
});

// GET /api/ports — List all port leases
route('GET', '/api/ports', (_req, res) => {
  const leases = porthub.getLeases();
  const grouped = {};
  for (const lease of leases) {
    if (!grouped[lease.project]) grouped[lease.project] = [];
    grouped[lease.project].push(lease);
  }
  jsonResponse(res, 200, {
    totalLeases: leases.length,
    leases,
    grouped
  });
});

// POST /api/ports/lease — Create or renew a lease
route('POST', '/api/ports/lease', (_req, res, _params, body) => {
  if (!body || !body.port || !body.project || !body.service) {
    return errorResponse(res, 400, 'port, project, and service are required', 'BAD_REQUEST');
  }
  try {
    const lease = store.portLeases.lease({
      port: body.port,
      project: body.project,
      service: body.service,
      permanent: body.permanent || false,
      ttlMs: body.ttl || null,
      description: body.description || null,
      autoRenew: body.autoRenew || false
    });
    jsonResponse(res, 201, lease);
  } catch (err) {
    return errorResponse(res, 400, err.message, 'BAD_REQUEST');
  }
});

// POST /api/ports/sync — Sync leases from old PortHub daemon
route('POST', '/api/ports/sync', (_req, res) => {
  const result = porthub.syncFromDaemon();
  jsonResponse(res, 200, { ok: true, imported: result.imported });
});

// POST /api/ports/release — Release a lease
route('POST', '/api/ports/release', (_req, res, _params, body) => {
  if (!body || !body.port) {
    return errorResponse(res, 400, 'port is required', 'BAD_REQUEST');
  }
  store.portLeases.release(body.port);
  jsonResponse(res, 200, { ok: true, port: body.port });
});

// POST /api/ports/heartbeat — Heartbeat a lease
route('POST', '/api/ports/heartbeat', (_req, res, _params, body) => {
  if (!body || !body.port) {
    return errorResponse(res, 400, 'port is required', 'BAD_REQUEST');
  }
  const lease = store.portLeases.heartbeat(body.port);
  if (!lease) {
    return errorResponse(res, 404, `No lease found for port ${body.port}`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, lease);
});

// GET /api/projects
route('GET', '/api/projects', (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = parseQuery(urlObj.search);
  const options = {};
  if (query.archived === 'true') options.archived = true;
  if (query.tag) options.tag = query.tag;
  if (query.methodology) options.methodology = query.methodology;
  if (query.engine) options.engine = query.engine;

  const list = projects.listAllProjects(options);
  jsonResponse(res, 200, { projects: list });
});

// POST /api/projects/attach — Attach an existing filesystem directory as a project
route('POST', '/api/projects/attach', (_req, res, _params, body) => {
  if (!body || !body.name) {
    return errorResponse(res, 400, 'name is required', 'BAD_REQUEST');
  }

  const result = projects.attachProject(body.name);
  if (!result.project) {
    const firstError = result.errors[0] || 'Attach failed';
    const code = firstError.includes('already registered') ? 'CONFLICT' : 'BAD_REQUEST';
    return errorResponse(res, code === 'CONFLICT' ? 409 : 400, firstError, code);
  }

  const response = {
    id: result.project.id,
    name: result.project.name,
    path: result.project.path,
    engine: result.project.engine,
    methodology: result.project.methodology,
    tags: result.project.tags,
    registered: true,
    createdAt: result.project.createdAt
  };

  if (result.errors.length > 0) {
    response.warnings = result.errors;
  }

  jsonResponse(res, 201, response);
});

// GET /api/projects/:name
route('GET', '/api/projects/:name', (_req, res, params) => {
  const project = projects.getProject(params.name);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.name}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, project);
});

// POST /api/projects
route('POST', '/api/projects', (_req, res, _params, body) => {
  if (!body || !body.name) {
    return errorResponse(res, 400, 'name is required', 'BAD_REQUEST');
  }

  const result = projects.createProject(body);
  if (!result.project) {
    const code = result.errors[0] && result.errors[0].includes('already exists') ? 'CONFLICT' : 'BAD_REQUEST';
    return errorResponse(res, code === 'CONFLICT' ? 409 : 400, result.errors[0], code);
  }

  const response = {
    id: result.project.id,
    name: result.project.name,
    path: result.project.path,
    engine: result.project.engineId,
    methodology: result.project.methodology,
    tags: result.project.tags,
    ports: result.project.ports,
    createdAt: result.project.createdAt
  };

  if (result.errors.length > 0) {
    response.warnings = result.errors;
  }

  jsonResponse(res, 201, response);
});

// POST /api/projects/import — Register existing project directories
route('POST', '/api/projects/import', (_req, res, _params, body) => {
  if (!body || !Array.isArray(body.names) || body.names.length === 0) {
    return errorResponse(res, 400, 'names array is required', 'BAD_REQUEST');
  }

  const config = store.config.load();
  const projectsDir = projects.resolveProjectsDir(config.projectsDir);
  const imported = [];
  const warnings = [];

  for (const name of body.names) {
    const existing = store.projects.getByName(name);
    if (existing) {
      warnings.push(`"${name}" already registered`);
      continue;
    }

    const projPath = path.join(projectsDir, name);
    if (!fs.existsSync(projPath) || !fs.statSync(projPath).isDirectory()) {
      warnings.push(`"${name}" directory not found in ${projectsDir}`);
      continue;
    }

    const detectedMethodology = methodologies.detect(projPath);
    const engineId = config.defaultEngine || 'claude';
    const methodologyId = detectedMethodology ? detectedMethodology.id : (config.defaultMethodology || null);

    try {
      store.projects.create({
        name,
        path: projPath,
        engine: engineId,
        methodology: methodologyId,
        tags: [],
        ports: {}
      });

      // Write per-project config if none exists
      const projConfigPath = path.join(projPath, '.tangleclaw', 'project.json');
      if (!fs.existsSync(projConfigPath)) {
        const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
        projConfig.engine = engineId;
        projConfig.methodology = methodologyId;
        store.projectConfig.save(projPath, projConfig);
      }

      imported.push(name);
    } catch (err) {
      warnings.push(`Failed to import "${name}": ${err.message}`);
    }
  }

  jsonResponse(res, 200, { imported, warnings });
});

// DELETE /api/projects/:name
route('DELETE', '/api/projects/:name', (_req, res, params, body) => {
  const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
  if (!passwordCheck.allowed) {
    return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
  }

  const project = projects.getProject(params.name);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.name}" not found`, 'NOT_FOUND');
  }

  const deleteFiles = body && body.deleteFiles === true;
  const result = projects.deleteProject(params.name, { deleteFiles });

  if (!result.success) {
    return errorResponse(res, 500, result.errors[0] || 'Delete failed', 'INTERNAL_ERROR');
  }

  jsonResponse(res, 200, {
    ok: true,
    name: params.name,
    filesDeleted: result.filesDeleted
  });
});

// PATCH /api/projects/:name
route('PATCH', '/api/projects/:name', (_req, res, params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  const result = projects.updateProject(params.name, body);

  if (result.errors.length > 0 && !result.project) {
    const firstError = result.errors[0];
    if (firstError.includes('not found')) {
      return errorResponse(res, 404, firstError, 'NOT_FOUND');
    }
    if (firstError.includes('Core rules')) {
      return errorResponse(res, 400, firstError, 'BAD_REQUEST');
    }
    return errorResponse(res, 400, firstError, 'BAD_REQUEST');
  }

  const response = {
    id: result.project.id,
    name: result.project.name,
    engine: result.project.engine.id,
    methodology: result.project.methodology.id,
    tags: result.project.tags,
    updatedAt: result.project.updatedAt
  };

  if (result.methodologySwitch) {
    response.methodologySwitch = result.methodologySwitch;
  }

  if (result.errors.length > 0) {
    response.warnings = result.errors;
  }

  jsonResponse(res, 200, response);
});

// GET /api/methodologies
route('GET', '/api/methodologies', (_req, res) => {
  const list = methodologies.listTemplates();
  jsonResponse(res, 200, { methodologies: list });
});

// GET /api/methodologies/:id
route('GET', '/api/methodologies/:id', (_req, res, params) => {
  const template = methodologies.getTemplate(params.id);
  if (!template) {
    return errorResponse(res, 404, `Methodology "${params.id}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, template);
});

// POST /api/sessions/:project — Launch session
route('POST', '/api/sessions/:project', (_req, res, params, body) => {
  const project = projects.getProject(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }

  const result = sessions.launchSession(params.project, {
    primePrompt: body ? body.primePrompt : true,
    engineOverride: body ? body.engineOverride : null
  });

  if (result.error) {
    if (result.error.includes('already active')) {
      return errorResponse(res, 409, result.error, 'CONFLICT');
    }
    if (result.error.includes('not available')) {
      return errorResponse(res, 400, result.error, 'BAD_REQUEST');
    }
    return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
  }

  jsonResponse(res, 201, {
    sessionId: result.session.id,
    project: params.project,
    engine: result.session.engineId,
    tmuxSession: result.session.tmuxSession,
    primePrompt: result.primePrompt,
    startedAt: result.session.startedAt,
    ttydUrl: result.ttydUrl
  });
});

// DELETE /api/sessions/:project — Kill session
route('DELETE', '/api/sessions/:project', (_req, res, params, body) => {
  const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
  if (!passwordCheck.allowed) {
    return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
  }

  const result = sessions.killSession(params.project, body ? body.reason : undefined);
  if (result.error) {
    if (result.error.includes('not found') || result.error.includes('No active')) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
  }

  jsonResponse(res, 200, {
    ok: true,
    sessionId: result.session.id,
    project: params.project,
    durationSeconds: result.session.durationSeconds,
    status: result.session.status
  });
});

// GET /api/sessions/:project/status — Session status + idle detection
route('GET', '/api/sessions/:project/status', (_req, res, params) => {
  const status = sessions.getSessionStatus(params.project);
  if (!status) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, status);
});

// POST /api/sessions/:project/command — Inject command
route('POST', '/api/sessions/:project/command', (_req, res, params, body) => {
  if (!body || !body.command) {
    return errorResponse(res, 400, 'command is required', 'BAD_REQUEST');
  }
  if (body.command.length > 4096) {
    return errorResponse(res, 400, 'Command exceeds maximum length of 4096 characters', 'BAD_REQUEST');
  }

  const result = sessions.injectCommand(params.project, body.command, {
    enter: body.enter !== false
  });

  if (!result.ok) {
    if (result.error.includes('not found') || result.error.includes('No active')) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
  }

  jsonResponse(res, 200, {
    ok: true,
    project: params.project,
    command: body.command
  });
});

// POST /api/sessions/:project/wrap — Trigger wrap skill
route('POST', '/api/sessions/:project/wrap', (_req, res, params, body) => {
  const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
  if (!passwordCheck.allowed) {
    return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
  }

  const result = sessions.triggerWrap(params.project);
  if (!result.ok) {
    if (result.error.includes('not found') || result.error.includes('No active')) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
  }

  jsonResponse(res, 200, {
    ok: true,
    sessionId: result.sessionId,
    project: params.project,
    status: 'wrapping',
    wrapCommand: result.wrapCommand
  });
});

// GET /api/sessions/:project/peek — Peek at terminal output
route('GET', '/api/sessions/:project/peek', (req, res, params) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = parseQuery(urlObj.search);
  const lines = query.lines ? parseInt(query.lines, 10) : 5;

  const result = sessions.peek(params.project, lines);
  if (result.error) {
    return errorResponse(res, 404, result.error, 'NOT_FOUND');
  }

  jsonResponse(res, 200, {
    lines: result.lines,
    project: params.project,
    tmuxSession: result.tmuxSession
  });
});

// GET /api/sessions/:project/history — Session history
route('GET', '/api/sessions/:project/history', (req, res, params) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = parseQuery(urlObj.search);

  const result = sessions.getSessionHistory(params.project, {
    limit: query.limit ? parseInt(query.limit, 10) : 20,
    status: query.status || undefined
  });

  if (result.error) {
    return errorResponse(res, 404, result.error, 'NOT_FOUND');
  }

  jsonResponse(res, 200, {
    sessions: result.sessions,
    total: result.total
  });
});

// GET /api/activity — Activity log query
route('GET', '/api/activity', (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = parseQuery(urlObj.search);

  const options = {};
  if (query.project) {
    const project = store.projects.getByName(query.project);
    if (project) options.projectId = project.id;
  }
  if (query.type) options.eventType = query.type;
  if (query.limit) options.limit = parseInt(query.limit, 10);
  if (query.since) options.since = query.since;

  const entries = store.activity.query(options);

  // Enrich with project names
  const projectCache = new Map();
  const enriched = entries.map((entry) => {
    let projectName = null;
    if (entry.projectId) {
      if (!projectCache.has(entry.projectId)) {
        const p = store.projects.get(entry.projectId);
        projectCache.set(entry.projectId, p ? p.name : null);
      }
      projectName = projectCache.get(entry.projectId);
    }
    return {
      id: entry.id,
      projectId: entry.projectId,
      projectName,
      sessionId: entry.sessionId,
      eventType: entry.eventType,
      detail: entry.detail,
      createdAt: entry.createdAt
    };
  });

  jsonResponse(res, 200, { entries: enriched });
});

// POST /api/upload — Upload a file to a project's .uploads/ directory
route('POST', '/api/upload', (_req, res, _params, body) => {
  if (!body || !body.project || !body.filename || !body.data) {
    return errorResponse(res, 400, 'project, filename, and data are required', 'BAD_REQUEST');
  }

  const project = projects.getProject(body.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${body.project}" not found`, 'NOT_FOUND');
  }

  if (!fs.existsSync(project.path)) {
    return errorResponse(res, 400, 'Project directory not found on disk', 'BAD_REQUEST');
  }

  try {
    const result = uploads.saveUpload(project.path, body.filename, body.data);
    jsonResponse(res, 201, result);
  } catch (err) {
    if (err.message.includes('not allowed')) {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    log.error('Upload failed', { error: err.message });
    return errorResponse(res, 500, err.message, 'INTERNAL_ERROR');
  }
}, { maxBodySize: 15 * 1024 * 1024 });

// GET /api/uploads — List uploads for a project
route('GET', '/api/uploads', (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = parseQuery(urlObj.search);

  if (!query.project) {
    return errorResponse(res, 400, 'project query parameter is required', 'BAD_REQUEST');
  }

  const project = projects.getProject(query.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${query.project}" not found`, 'NOT_FOUND');
  }

  const list = uploads.listUploads(project.path);
  jsonResponse(res, 200, { uploads: list });
});

// GET /api/tmux/mouse/:session
route('GET', '/api/tmux/mouse/:session', (_req, res, params) => {
  try {
    const mouse = tmux.getMouse(params.session);
    jsonResponse(res, 200, { mouse, session: params.session });
  } catch (err) {
    return errorResponse(res, 404, err.message, 'NOT_FOUND');
  }
});

// ── Terminal Proxy ──

/**
 * Proxy an HTTP request to the ttyd backend.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname
 */
function proxyToTtyd(req, res, pathname) {
  const config = store.config.load();
  const ttydPort = config.ttydPort || 3100;
  const targetPath = pathname.replace(/^\/terminal/, '') || '/';

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: ttydPort,
    path: targetPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''),
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${ttydPort}`
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    log.warn('ttyd proxy error', { error: err.message });
    errorResponse(res, 502, 'Terminal service unavailable', 'BAD_GATEWAY');
  });

  req.pipe(proxyReq);
}

/**
 * Handle WebSocket upgrade for terminal proxy.
 * @param {http.IncomingMessage} req
 * @param {import('net').Socket} socket
 * @param {Buffer} head
 */
function handleUpgrade(req, socket, head) {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!urlObj.pathname.startsWith('/terminal')) {
    socket.destroy();
    return;
  }

  const config = store.config.load();
  const ttydPort = config.ttydPort || 3100;
  const targetPath = urlObj.pathname.replace(/^\/terminal/, '') || '/';
  const targetUrl = targetPath + (urlObj.search || '');

  const net = require('node:net');
  const proxySocket = net.connect(ttydPort, '127.0.0.1', () => {
    // Build the upgrade request to forward to ttyd
    const reqHeaders = [];
    reqHeaders.push(`GET ${targetUrl} HTTP/1.1`);
    reqHeaders.push(`Host: 127.0.0.1:${ttydPort}`);
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === 'host') continue;
      reqHeaders.push(`${key}: ${value}`);
    }
    reqHeaders.push('', '');

    proxySocket.write(reqHeaders.join('\r\n'));
    if (head.length > 0) {
      proxySocket.write(head);
    }

    // Pipe data bidirectionally
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxySocket.on('error', () => {
    socket.destroy();
  });

  socket.on('error', () => {
    proxySocket.destroy();
  });

  socket.on('close', () => {
    proxySocket.destroy();
  });

  proxySocket.on('close', () => {
    socket.destroy();
  });
}

// ── Version Helper ──

let _cachedVersion = null;

/**
 * Read the version from version.json.
 * @returns {string}
 */
function _getVersion() {
  if (_cachedVersion) return _cachedVersion;
  try {
    const versionFile = path.join(__dirname, 'version.json');
    const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    _cachedVersion = data.version;
    return _cachedVersion;
  } catch {
    return 'unknown';
  }
}

// ── Request Handler ──

/**
 * Main HTTP request handler.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleRequest(req, res) {
  const startTime = Date.now();
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

  // API routes
  if (pathname.startsWith('/api/')) {
    const matched = matchRoute(method, pathname);
    if (!matched) {
      log.debug('Route not found', { method, path: pathname });
      return errorResponse(res, 404, `${method} ${pathname} not found`, 'NOT_FOUND');
    }

    try {
      const body = await parseBody(req, matched.options.maxBodySize);
      await matched.handler(req, res, matched.params, body);
    } catch (err) {
      if (err.status) {
        return errorResponse(res, err.status, err.message, err.code);
      }
      log.error('Unhandled error in route handler', {
        method, path: pathname, error: err.message, stack: err.stack
      });
      return errorResponse(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }

    const duration = Date.now() - startTime;
    log.info(`${method} ${pathname}`, { status: res.statusCode, duration: `${duration}ms` });
    return;
  }

  // Terminal reverse proxy — forward /terminal/* to ttyd
  if (pathname.startsWith('/terminal/') || pathname === '/terminal') {
    if (method === 'GET' || method === 'POST') {
      return proxyToTtyd(req, res, pathname);
    }
  }

  // Static files
  if (method === 'GET') {
    if (serveStatic(res, pathname)) {
      const duration = Date.now() - startTime;
      log.debug(`${method} ${pathname}`, { status: 200, duration: `${duration}ms` });
      return;
    }
  }

  // Session wrapper page — /session/:name serves session.html
  if (method === 'GET' && pathname.startsWith('/session/') && pathname.split('/').length === 3) {
    const sessionName = pathname.split('/')[2];
    if (sessionName && serveStatic(res, '/session.html')) {
      return;
    }
  }

  // Fallback: serve index.html for SPA routing
  if (method === 'GET' && !pathname.includes('.')) {
    if (serveStatic(res, '/')) {
      return;
    }
  }

  errorResponse(res, 404, 'Not found', 'NOT_FOUND');
}

// ── Server Creation ──

/**
 * Create and configure the HTTP server (does not start listening).
 * @returns {http.Server}
 */
function createServer() {
  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);
  return server;
}

// ── Main ──

if (require.main === module) {
  // Configure log level from env or config
  const envLogLevel = process.env.TANGLECLAW_LOG_LEVEL;
  if (envLogLevel) {
    setLevel(envLogLevel);
  }

  // Initialize store
  store.init();
  const config = store.config.load();

  // Initialize file logging
  initFileLogging(path.join(store._getBasePath(), 'logs'));

  if (!envLogLevel && config.logLevel) {
    setLevel(config.logLevel);
  }

  // Bootstrap port management
  porthub.bootstrap({ ttydPort: config.ttydPort || 3100, serverPort: config.serverPort || 3101 });
  porthub.startExpirationTimer();

  const port = process.env.TANGLECLAW_PORT || config.serverPort || 3101;
  const server = createServer();

  server.listen(port, () => {
    log.info(`TangleClaw v${_getVersion()} listening on :${port}`, {
      node: process.version,
      pid: process.pid
    });
  });

  // Graceful shutdown
  const shutdown = () => {
    log.info('Shutting down');
    porthub.shutdown({ ttydPort: config.ttydPort || 3100, serverPort: config.serverPort || 3101 });
    porthub.stopExpirationTimer();
    server.close();
    store.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { error: String(reason) });
  });
}

module.exports = { createServer, handleRequest, handleUpgrade, route, matchRoute, jsonResponse, errorResponse, parseBody, parseQuery, MAX_BODY_SIZE };
