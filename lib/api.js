'use strict';

const tmux = require('./tmux');
const system = require('./system');
const config = require('./config');
const activity = require('./activity');
const projects = require('./projects');
const uploads = require('./uploads');
const fs = require('fs');
const path = require('path');

const VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')
).version;

// Route table: [method, pattern, handler]
// Pattern params like :name become req.params.name
const routes = [
  ['GET',  '/api/projects',              handleGetProjects],
  ['POST', '/api/projects',              handleCreateProject],
  ['GET',  '/api/templates',             handleGetTemplates],
  ['GET',  '/api/templates/:id',         handleGetTemplate],
  ['GET',  '/api/config',                handleGetConfig],
  ['GET',  '/api/system',                handleGetSystem],
  ['GET',  '/api/activity',              handleGetActivity],
  ['POST', '/api/sessions/:name/kill',   handleKillSession],
  ['GET',  '/api/sessions/:name/peek',   handlePeekSession],
  ['POST', '/api/sessions/:name/send',   handleSendToSession],
  ['POST', '/api/upload',                handleUpload],
  ['GET',  '/api/uploads',               handleGetUploads],
  ['GET',  '/api/version',              handleGetVersion],
];

function matchRoute(method, url) {
  // Strip query string
  const path = url.split('?')[0];

  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;

    const patternParts = pattern.split('/');
    const urlParts = path.split('/');

    if (patternParts.length !== urlParts.length) continue;

    const params = {};
    let match = true;

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
      } else if (patternParts[i] !== urlParts[i]) {
        match = false;
        break;
      }
    }

    if (match) return { handler, params };
  }

  return null;
}

function dispatch(req, res) {
  const result = matchRoute(req.method, req.url);
  if (!result) return false;

  req.params = result.params;
  result.handler(req, res);
  return true;
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10000) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function readLargeBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// --- Handlers ---

function handleGetProjects(req, res) {
  try {
    const data = projects.getEnriched();
    json(res, data);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

async function handleCreateProject(req, res) {
  try {
    const body = await readBody(req);
    const result = projects.create(body.name, {
      gitInit: body.gitInit,
      claudeMd: body.claudeMd,
      template: body.template,
    });
    activity.log('project_created', { project: body.name });
    json(res, result, 201);
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
}

function handleGetTemplates(req, res) {
  try {
    const templates = projects.getTemplates();
    json(res, templates);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

function handleGetTemplate(req, res) {
  try {
    const template = projects.getTemplateFiles(req.params.id);
    if (!template) {
      json(res, { error: 'Template not found' }, 404);
      return;
    }
    json(res, template);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

function handleGetConfig(req, res) {
  const cfg = config.load();
  json(res, cfg);
}

function handleGetSystem(req, res) {
  try {
    const stats = system.getStats();
    json(res, stats);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

function handleGetActivity(req, res) {
  const recent = activity.getRecent();
  json(res, recent);
}

function handleKillSession(req, res) {
  try {
    const name = req.params.name;
    tmux.killSession(name);
    activity.log('session_killed', { session: name });
    json(res, { ok: true });
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
}

function handlePeekSession(req, res) {
  try {
    const name = req.params.name;
    const lines = tmux.peek(name);
    json(res, { lines });
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
}

async function handleSendToSession(req, res) {
  try {
    const name = req.params.name;
    const body = await readBody(req);
    if (!body.command) {
      json(res, { error: 'Missing command' }, 400);
      return;
    }
    tmux.sendKeys(name, body.command);
    json(res, { ok: true });
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
}

async function handleUpload(req, res) {
  try {
    const body = await readLargeBody(req);
    if (!body.name || !body.data) {
      json(res, { error: 'Missing name or data' }, 400);
      return;
    }
    const result = uploads.save(body.name, body.data, body.project || null);
    activity.log('file_uploaded', { name: result.name, size: result.size, project: result.project });
    json(res, result, 201);
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
}

function handleGetUploads(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const project = url.searchParams.get('project') || null;
    const files = uploads.list(project);
    json(res, files);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

function handleGetVersion(req, res) {
  json(res, { version: VERSION });
}

module.exports = { dispatch, VERSION };
