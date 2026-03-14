'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');
const { createLogger } = require('./logger');

const log = createLogger('git');

const CACHE_TTL = 10000; // 10 seconds
const _cache = new Map();

/**
 * Execute a git command in a directory with timeout.
 * @param {string} command - Git command to run
 * @param {string} cwd - Working directory
 * @param {number} [timeout=5000] - Timeout in ms
 * @returns {string} - stdout output
 */
function _exec(command, cwd, timeout = 5000) {
  return execSync(command, { cwd, timeout, encoding: 'utf8' }).trim();
}

/**
 * Check if a directory is a git repository.
 * @param {string} dir - Directory path
 * @returns {boolean}
 */
function isGitRepo(dir) {
  try {
    _exec('git rev-parse --is-inside-work-tree', dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get git info for a project directory. Results are cached with a 10s TTL.
 * @param {string} dir - Project directory path
 * @returns {{ branch: string, dirty: boolean, lastCommit: string, lastCommitAge: string }|null}
 */
function getInfo(dir) {
  const cacheKey = path.resolve(dir);
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.data;
  }

  const data = _fetchInfo(dir);
  _cache.set(cacheKey, { data, time: Date.now() });
  return data;
}

/**
 * Fetch git info without caching.
 * @param {string} dir - Project directory path
 * @returns {{ branch: string, dirty: boolean, lastCommit: string, lastCommitAge: string }|null}
 */
function _fetchInfo(dir) {
  if (!isGitRepo(dir)) return null;

  try {
    const branch = _getBranch(dir);
    const dirty = _isDirty(dir);
    const lastCommit = _getLastCommitMessage(dir);
    const lastCommitAge = _getLastCommitAge(dir);

    return { branch, dirty, lastCommit, lastCommitAge };
  } catch (err) {
    log.warn('Failed to get git info', { dir, error: err.message });
    return null;
  }
}

/**
 * Get the current branch name.
 * @param {string} dir - Repository directory
 * @returns {string}
 */
function _getBranch(dir) {
  try {
    return _exec('git rev-parse --abbrev-ref HEAD', dir);
  } catch {
    return 'unknown';
  }
}

/**
 * Check if the working directory has uncommitted changes.
 * @param {string} dir - Repository directory
 * @returns {boolean}
 */
function _isDirty(dir) {
  try {
    const output = _exec('git status --porcelain', dir);
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the last commit message (first line).
 * @param {string} dir - Repository directory
 * @returns {string}
 */
function _getLastCommitMessage(dir) {
  try {
    return _exec('git log -1 --format=%s', dir);
  } catch {
    return '';
  }
}

/**
 * Get the relative age of the last commit.
 * @param {string} dir - Repository directory
 * @returns {string}
 */
function _getLastCommitAge(dir) {
  try {
    return _exec('git log -1 --format=%cr', dir);
  } catch {
    return '';
  }
}

/**
 * Clear the git info cache. Useful for testing or forcing refresh.
 */
function clearCache() {
  _cache.clear();
}

/**
 * Clear cache for a specific directory.
 * @param {string} dir - Directory path to clear
 */
function clearCacheFor(dir) {
  _cache.delete(path.resolve(dir));
}

module.exports = {
  isGitRepo,
  getInfo,
  clearCache,
  clearCacheFor,
  _exec,
  _fetchInfo
};
