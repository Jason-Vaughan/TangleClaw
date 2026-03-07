'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const tmux = require('./tmux');
const git = require('./git');

const PROJECTS_DIR = path.join(process.env.HOME, 'Documents', 'Projects');
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

function getAll() {
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function getPrawductPhase(projectPath) {
  const statePath = path.join(projectPath, '.prawduct', 'project-state.yaml');
  if (!fs.existsSync(statePath)) return null;
  try {
    const content = fs.readFileSync(statePath, 'utf8');
    const match = content.match(/^current_phase:\s*(\S+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getEnriched() {
  const projects = getAll();
  const sessions = tmux.getSessions();

  const rootSession = sessions['Projects'];
  const rootEntry = {
    name: 'Projects Directory',
    sessionName: 'Projects',
    hasSession: !!rootSession,
    windows: rootSession ? rootSession.windows : 0,
    attached: rootSession ? rootSession.attached : false,
    lastActivity: rootSession ? rootSession.lastActivity : null,
    created: rootSession ? rootSession.created : null,
    isRoot: true,
    git: null,
    prawduct: null,
  };

  const data = projects.map(name => {
    const sessionName = tmux.toSessionName(name);
    const session = sessions[sessionName];
    const projectPath = path.join(PROJECTS_DIR, name);
    const gitInfo = git.getGitInfo(projectPath);
    const prawductPhase = getPrawductPhase(projectPath);

    return {
      name,
      sessionName,
      hasSession: !!session,
      windows: session ? session.windows : 0,
      attached: session ? session.attached : false,
      lastActivity: session ? session.lastActivity : null,
      created: session ? session.created : null,
      isRoot: false,
      git: gitInfo.isGitRepo ? gitInfo : null,
      prawduct: prawductPhase,
    };
  });

  data.unshift(rootEntry);
  return data;
}

// ── Templates ──

function getTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];

  const entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => {
      const metaPath = path.join(TEMPLATES_DIR, e.name, 'template.json');
      if (!fs.existsSync(metaPath)) return null;

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return {
          id: e.name,
          name: meta.name || e.name,
          description: meta.description || '',
          icon: meta.icon || 'folder',
          tags: meta.tags || [],
          builtin: meta.builtin === true,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Blank always first
      if (a.id === 'blank') return -1;
      if (b.id === 'blank') return 1;
      return a.name.localeCompare(b.name);
    });
}

function getTemplateFiles(templateId) {
  const templateDir = path.join(TEMPLATES_DIR, templateId);
  if (!fs.existsSync(templateDir)) return null;

  const metaPath = path.join(templateDir, 'template.json');
  if (!fs.existsSync(metaPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const files = collectFiles(templateDir, templateDir)
    .filter(f => f !== 'template.json');

  return {
    id: templateId,
    name: meta.name || templateId,
    description: meta.description || '',
    icon: meta.icon || 'folder',
    tags: meta.tags || [],
    files,
  };
}

function collectFiles(dir, baseDir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir));
    } else {
      results.push(relPath);
    }
  }
  return results;
}

// ── Project Creation ──

function create(name, options = {}) {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Invalid project name. Use only letters, numbers, hyphens, and underscores.');
  }

  const projectPath = path.join(PROJECTS_DIR, name);
  if (fs.existsSync(projectPath)) {
    throw new Error('Project already exists.');
  }

  fs.mkdirSync(projectPath, { recursive: true });

  if (options.gitInit) {
    execSync('git init', { cwd: projectPath, timeout: 5000 });
  }

  if (options.claudeMd && typeof options.claudeMd === 'string') {
    fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), options.claudeMd);
  }

  if (options.template && options.template !== 'blank') {
    applyTemplate(projectPath, name, options.template);
  }

  return { name, path: projectPath };
}

function applyTemplate(projectPath, projectName, templateId) {
  const templateDir = path.join(TEMPLATES_DIR, templateId);
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Template "${templateId}" not found.`);
  }

  const metaPath = path.join(templateDir, 'template.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error(`Template "${templateId}" is missing template.json.`);
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

  // If template has an init command, try that first
  if (meta.init) {
    const cmd = meta.init
      .replace(/\{\{PROJECT_PATH\}\}/g, projectPath)
      .replace(/\{\{PROJECT_NAME\}\}/g, projectName);
    try {
      execSync(cmd, { timeout: 30000, stdio: 'pipe' });
      return; // init command succeeded, skip file copy
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : '';
      const stdout = err.stdout ? err.stdout.toString() : '';
      console.error(`Template init failed for "${templateId}": ${err.message}`);
      if (stderr) console.error(`  stderr: ${stderr}`);
      if (stdout) console.error(`  stdout: ${stdout}`);
      // Fall through to file copy
    }
  }

  // Copy template files (skip template.json)
  copyTemplateDir(templateDir, projectPath, projectName);
}

function copyTemplateDir(srcDir, destDir, projectName) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'template.json') continue;

    const srcPath = path.join(srcDir, entry.name);
    const destName = entry.name.replace(/\.tmpl$/, '');
    const destPath = path.join(destDir, destName);

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyTemplateDir(srcPath, destPath, projectName);
    } else {
      let content = fs.readFileSync(srcPath, 'utf8');
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
      fs.writeFileSync(destPath, content);
    }
  }
}

// ── Project Deletion ──

function remove(name) {
  if (!name || !/^[a-zA-Z0-9_. -]+$/.test(name)) {
    throw new Error('Invalid project name.');
  }

  const projectPath = path.join(PROJECTS_DIR, name);
  if (!fs.existsSync(projectPath)) {
    throw new Error('Project not found.');
  }

  // Kill any active tmux session first
  const sessionName = tmux.toSessionName(name);
  try { tmux.killSession(sessionName); } catch {}

  fs.rmSync(projectPath, { recursive: true, force: true });
  return { name, deleted: true };
}

// ── Project Rename ──

function rename(oldName, newName) {
  if (!oldName || !newName) {
    throw new Error('Both old and new names are required.');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
    throw new Error('Invalid new name. Use only letters, numbers, hyphens, and underscores.');
  }

  const oldPath = path.join(PROJECTS_DIR, oldName);
  const newPath = path.join(PROJECTS_DIR, newName);

  if (!fs.existsSync(oldPath)) {
    throw new Error('Project not found.');
  }
  if (fs.existsSync(newPath)) {
    throw new Error('A project with that name already exists.');
  }

  // Kill any active tmux session (will need to reopen with new name)
  const sessionName = tmux.toSessionName(oldName);
  try { tmux.killSession(sessionName); } catch {}

  fs.renameSync(oldPath, newPath);
  return { oldName, newName, path: newPath };
}

module.exports = { getAll, getEnriched, getTemplates, getTemplateFiles, create, remove, rename, PROJECTS_DIR };
