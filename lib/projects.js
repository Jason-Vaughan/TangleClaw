'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const tmux = require('./tmux');
const git = require('./git');

const PROJECTS_DIR = path.join(process.env.HOME, 'Documents', 'Projects');

function getAll() {
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
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
  };

  const data = projects.map(name => {
    const sessionName = tmux.toSessionName(name);
    const session = sessions[sessionName];
    const projectPath = path.join(PROJECTS_DIR, name);
    const gitInfo = git.getGitInfo(projectPath);

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
    };
  });

  data.unshift(rootEntry);
  return data;
}

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
    applyTemplate(projectPath, options.template);
  }

  return { name, path: projectPath };
}

function applyTemplate(projectPath, template) {
  switch (template) {
    case 'node':
      fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({
        name: path.basename(projectPath),
        version: '1.0.0',
        private: true,
        scripts: { start: 'node index.js' },
      }, null, 2) + '\n');
      fs.writeFileSync(path.join(projectPath, 'index.js'), '// Entry point\n');
      break;
    case 'python':
      fs.writeFileSync(path.join(projectPath, 'main.py'), '# Entry point\n');
      fs.writeFileSync(path.join(projectPath, 'requirements.txt'), '');
      break;
    case 'rust':
      try {
        execSync(`cargo init "${projectPath}"`, { timeout: 10000, stdio: 'pipe' });
      } catch {
        fs.writeFileSync(path.join(projectPath, 'main.rs'), 'fn main() {\n    println!("Hello, world!");\n}\n');
      }
      break;
  }
}

module.exports = { getAll, getEnriched, create, PROJECTS_DIR };
