'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(process.env.HOME, '.tangleclaw');
const LOG_PATH = path.join(CONFIG_DIR, 'activity.log');
const MAX_ENTRIES = 200;

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function log(type, data) {
  ensureDir();
  const entry = JSON.stringify({
    ts: Date.now(),
    type,
    ...data,
  }) + '\n';
  fs.appendFileSync(LOG_PATH, entry);
}

function getRecent(count = 50) {
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines
      .slice(-count)
      .reverse()
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getProjectActivity(projectName) {
  const recent = getRecent(MAX_ENTRIES);
  return recent.filter(e => e.project === projectName);
}

module.exports = { log, getRecent, getProjectActivity };
