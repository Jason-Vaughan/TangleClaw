'use strict';

// #296 — read an OpenClaw instance's version (its pinned image tag) for
// per-connection display. The version isn't exposed by the gateway
// (no HTTP endpoint/header/JS-bundle marker) and `docker`/`podman` aren't on
// the SSH user's PATH, so the viable source is the instance's `.env` on the
// host: `OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:<tag>`. We read it over SSH
// (reusing the connection's credentials) and cache per connection.

const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('openclaw-version');

const TTL_MS = 5 * 60 * 1000; // 5 min — version changes only on an instance update
const _cache = new Map(); // connId -> { version, fetchedAt }

// instanceDir is operator config interpolated into an SSH remote command.
// Restrict to a safe path shape (no spaces or shell metacharacters) so it
// can't inject — and so `~` still expands on the remote shell. Anything else
// is rejected before any ssh runs.
const SAFE_INSTANCE_DIR = /^~?[A-Za-z0-9_./-]+$/;

/**
 * Parse the OpenClaw image tag from an instance `.env`'s `OPENCLAW_IMAGE` line.
 * @param {string} envText - Contents (or grepped line) of the instance `.env`
 * @returns {string|null} The tag (e.g. "2026.5.28"), or null if not found
 */
function parseVersion(envText) {
  if (!envText || typeof envText !== 'string') return null;
  // OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:<tag>  (tolerate quotes/whitespace)
  const m = envText.match(/^\s*OPENCLAW_IMAGE\s*=\s*["']?\S*openclaw\/openclaw:([^\s"']+)/m);
  return m ? m[1] : null;
}

/**
 * Whether an instanceDir value is shape-safe to interpolate into the SSH command.
 * @param {string} dir
 * @returns {boolean}
 */
function isSafeInstanceDir(dir) {
  return typeof dir === 'string' && dir.length > 0 && dir.length <= 256 && SAFE_INSTANCE_DIR.test(dir);
}

/**
 * Fetch a connection's OpenClaw version over SSH (cached per connection).
 * @param {object} conn - Connection record (needs host, sshUser, sshKeyPath, instanceDir, id)
 * @param {object} [opts]
 * @param {boolean} [opts.force] - Bypass the cache
 * @returns {{ version: string|null, cached: boolean, error: string|null }}
 */
function fetchVersion(conn, opts = {}) {
  if (!conn || !conn.instanceDir) {
    return { version: null, cached: false, error: 'no instanceDir configured for this connection' };
  }
  if (!isSafeInstanceDir(conn.instanceDir)) {
    return { version: null, cached: false, error: 'instanceDir contains unsafe characters' };
  }

  const cached = _cache.get(conn.id);
  if (!opts.force && cached && (Date.now() - cached.fetchedAt) < TTL_MS) {
    return { version: cached.version, cached: true, error: null };
  }

  const keyPath = String(conn.sshKeyPath || '').replace(/^~/, process.env.HOME || '');
  // Remote command: grep the image line out of the instance .env. instanceDir
  // is left unquoted so the remote shell expands a leading `~`; it's already
  // validated to a metacharacter-free shape above.
  const remote = `grep -m1 '^OPENCLAW_IMAGE=' ${conn.instanceDir}/.env`;
  const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new -i "${keyPath}" ${conn.sshUser}@${conn.host} "${remote}"`;

  let out;
  try {
    out = _internal.exec(cmd, { timeout: 12000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    log.warn('OpenClaw version fetch failed', { connId: conn.id, error: err.message });
    return { version: null, cached: false, error: `ssh read failed: ${(err.stderr || err.message || '').toString().slice(0, 200)}` };
  }

  const version = parseVersion(out);
  _cache.set(conn.id, { version, fetchedAt: Date.now() });
  return { version, cached: false, error: version ? null : 'OPENCLAW_IMAGE not found in instance .env' };
}

/**
 * Drop a connection's cached version (call on connection update/delete).
 * @param {string} connId
 */
function invalidate(connId) {
  _cache.delete(connId);
}

// Overridable for tests.
const _internal = { exec: execSync };

module.exports = { fetchVersion, parseVersion, isSafeInstanceDir, invalidate, _internal, _cache, TTL_MS };
