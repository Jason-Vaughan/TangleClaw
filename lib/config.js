'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(process.env.HOME, '.tangleclaw');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  ttydPort: parseInt(process.env.TANGLECLAW_TTYD_PORT, 10) || 3100,
  defaultEngine: 'claude',
  engines: {
    claude: { command: 'claude', label: 'Claude Code' },
    codex: { command: 'codex', label: 'Codex CLI', comingSoon: true },
    aider: { command: 'aider', label: 'Aider', comingSoon: true },
  },
  projectEngines: {},
  quickCommands: [
    { label: 'git status', command: 'git status' },
    { label: 'git log', command: 'git log --oneline -5' },
    { label: 'ls', command: 'ls -la' },
  ],
};

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function load() {
  ensureDir();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const user = JSON.parse(raw);
    return { ...DEFAULTS, ...user };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function getEngineForProject(projectName) {
  const config = load();
  return config.projectEngines[projectName] || config.defaultEngine;
}

module.exports = { load, save, getEngineForProject, CONFIG_DIR, CONFIG_PATH };
