'use strict';

const { execSync } = require('child_process');
const path = require('path');

let _cache = {};
const CACHE_TTL = 10000; // 10 seconds

function getGitInfo(projectPath) {
  const now = Date.now();
  const key = projectPath;
  if (_cache[key] && (now - _cache[key]._time) < CACHE_TTL) return _cache[key];

  const result = {
    isGitRepo: false,
    branch: null,
    dirty: 0,
    lastCommitAge: null,
  };

  try {
    // Check if it's a git repo
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    result.isGitRepo = true;
  } catch {
    _cache[key] = result;
    return result;
  }

  try {
    result.branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {}

  try {
    const status = execSync('git status --porcelain', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    result.dirty = status.trim().split('\n').filter(Boolean).length;
  } catch {}

  try {
    const ts = execSync('git log -1 --format=%ct', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const ageSec = Math.floor(Date.now() / 1000) - parseInt(ts, 10);
    result.lastCommitAge = formatAge(ageSec);
  } catch {}

  result._time = now;
  _cache[key] = result;
  return result;
}

function clearCache() {
  _cache = {};
}

function formatAge(seconds) {
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

module.exports = { getGitInfo, clearCache };
