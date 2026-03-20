'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createLogger } = require('./logger');

const log = createLogger('update-checker');

let _cache = null;
let _timer = null;

/**
 * Read the current version from version.json.
 * @returns {string|null}
 */
function _getCurrentVersion() {
  try {
    const versionFile = path.join(__dirname, '..', 'version.json');
    const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    return data.version || null;
  } catch {
    return null;
  }
}

/**
 * Parse a semver string into { major, minor, patch } numbers.
 * Strips leading 'v' and ignores pre-release suffixes.
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }|null}
 */
function parseSemver(version) {
  if (!version || typeof version !== 'string') return null;
  const cleaned = version.replace(/^v/, '').split('-')[0];
  const parts = cleaned.split('.');
  if (parts.length < 3) return null;
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  const patch = parseInt(parts[2], 10);
  if (isNaN(major) || isNaN(minor) || isNaN(patch)) return null;
  return { major, minor, patch };
}

/**
 * Compare two semver objects. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 * @returns {number}
 */
function compareSemver(a, b) {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

/**
 * Parse git ls-remote --tags output into an array of version strings.
 * @param {string} output - Raw git ls-remote output
 * @returns {string[]}
 */
function parseTagsOutput(output) {
  if (!output || typeof output !== 'string') return [];
  const versions = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: <sha>\trefs/tags/<tagname>
    const match = trimmed.match(/refs\/tags\/(v?\d+\.\d+\.\d+[^\s^]*)$/);
    if (match) {
      // Skip annotated tag derefs (^{})
      const tag = match[1];
      if (tag.includes('^')) continue;
      versions.push(tag);
    }
  }
  return versions;
}

/**
 * Find the latest semver version from a list of version strings.
 * @param {string[]} versions
 * @returns {string|null}
 */
function findLatestVersion(versions) {
  let latest = null;
  let latestParsed = null;
  for (const v of versions) {
    const parsed = parseSemver(v);
    if (!parsed) continue;
    if (!latestParsed || compareSemver(parsed, latestParsed) > 0) {
      latestParsed = parsed;
      latest = v;
    }
  }
  return latest;
}

/**
 * Check for updates by fetching git remote tags.
 * @returns {{ updateAvailable: boolean, currentVersion: string|null, latestVersion: string|null, checkedAt: string }}
 */
function checkForUpdate() {
  const currentVersion = _getCurrentVersion();
  const checkedAt = new Date().toISOString();

  if (!currentVersion) {
    log.warn('Could not read current version');
    _cache = { updateAvailable: false, currentVersion: null, latestVersion: null, checkedAt };
    return _cache;
  }

  try {
    const repoDir = path.join(__dirname, '..');
    const output = execSync('git ls-remote --tags origin', {
      cwd: repoDir,
      timeout: 15000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const versions = parseTagsOutput(output);
    const latestTag = findLatestVersion(versions);

    if (!latestTag) {
      log.debug('No remote tags found');
      _cache = { updateAvailable: false, currentVersion, latestVersion: null, checkedAt };
      return _cache;
    }

    const currentParsed = parseSemver(currentVersion);
    const latestParsed = parseSemver(latestTag);

    const updateAvailable = currentParsed && latestParsed
      ? compareSemver(latestParsed, currentParsed) > 0
      : false;

    // Normalize latestVersion without leading 'v'
    const latestVersion = latestTag.replace(/^v/, '');

    _cache = { updateAvailable, currentVersion, latestVersion, checkedAt };

    if (updateAvailable) {
      log.info(`Update available: v${currentVersion} → v${latestVersion}`);
    } else {
      log.debug(`Up to date: v${currentVersion}`);
    }

    return _cache;
  } catch (err) {
    log.debug('Update check failed (likely offline)', { error: err.message });
    _cache = { updateAvailable: false, currentVersion, latestVersion: null, checkedAt };
    return _cache;
  }
}

/**
 * Get the cached update status.
 * @returns {{ updateAvailable: boolean, currentVersion: string|null, latestVersion: string|null, checkedAt: string|null }}
 */
function getCachedStatus() {
  if (_cache) return _cache;
  return { updateAvailable: false, currentVersion: _getCurrentVersion(), latestVersion: null, checkedAt: null };
}

/**
 * Start the periodic update checker.
 * First check runs after initialDelayMs (default 60s), then every intervalMs (default 24h).
 * @param {number} [intervalMs=86400000] - Check interval in milliseconds
 * @param {number} [initialDelayMs=60000] - Delay before first check
 */
function startChecker(intervalMs, initialDelayMs) {
  stopChecker();
  const interval = intervalMs || 24 * 60 * 60 * 1000;
  const delay = typeof initialDelayMs === 'number' ? initialDelayMs : 60000;

  log.debug('Starting update checker', { intervalMs: interval, initialDelayMs: delay });

  // First check after delay
  _timer = setTimeout(() => {
    checkForUpdate();
    // Then periodic checks
    _timer = setInterval(() => {
      checkForUpdate();
    }, interval);
  }, delay);
}

/**
 * Stop the periodic update checker.
 */
function stopChecker() {
  if (_timer) {
    clearTimeout(_timer);
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Reset internal state (for testing).
 */
function _reset() {
  stopChecker();
  _cache = null;
}

module.exports = {
  checkForUpdate,
  getCachedStatus,
  startChecker,
  stopChecker,
  _reset,
  // Exposed for testing
  parseSemver,
  compareSemver,
  parseTagsOutput,
  findLatestVersion
};
