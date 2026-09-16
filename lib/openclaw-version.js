'use strict';

// #296 — read an OpenClaw instance's version (its pinned image tag) for
// per-connection display. The version isn't exposed by the gateway
// (no HTTP endpoint/header/JS-bundle marker) and `docker`/`podman` aren't on
// the SSH user's PATH, so the viable source is the instance's `.env` on the
// host: `OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:<tag>`. We read it over SSH
// (reusing the connection's credentials) and cache per connection.

const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execAsync = promisify(exec);
const { createLogger } = require('./logger');
// #314: host/sshUser/sshKeyPath are also interpolated into the ssh command, so
// validate their shapes with the shared guard (one source of truth).
const { unsafeReason } = require('./ssh-target-safety');

const log = createLogger('openclaw-version');

const TTL_MS = 5 * 60 * 1000; // 5 min — version changes only on an instance update
const _cache = new Map(); // connId -> { version, fetchedAt }
// connId -> the ssh read in flight. The read is async so an unreachable host
// can't stall the event loop, which also means nothing serialises callers any
// more: without this, every panel render during a 6 s connect timeout spawns
// another ssh. Concurrent callers share the one read.
const _inflight = new Map();

// instanceDir is operator config interpolated into an SSH remote command.
// Restrict to a safe path shape (no spaces or shell metacharacters) so it
// can't inject — and so `~` still expands on the remote shell. Anything else
// is rejected before any ssh runs.
const SAFE_INSTANCE_DIR = /^~?[A-Za-z0-9_./-]+$/;

/**
 * Parse the OpenClaw image tag from an instance `.env`'s `OPENCLAW_IMAGE` line.
 *
 * Works for any image reference, not just the canonical
 * `ghcr.io/openclaw/openclaw:<tag>` registry path (#308): a locally-built or
 * custom-tagged image like `openclaw:qmd` is just as valid. We extract the
 * reference value, then take the substring after its *last* `:` — but only
 * when that substring has no `/`, so a registry host:port (e.g.
 * `registry:5000/openclaw`) isn't mistaken for a tag. An untagged reference
 * returns null.
 *
 * @param {string} envText - Contents (or grepped line) of the instance `.env`
 * @returns {string|null} The tag (e.g. "2026.5.28", "qmd", "latest"), or null
 */
function parseVersion(envText) {
  if (!envText || typeof envText !== 'string') return null;
  // Capture the image reference value (tolerate quotes/whitespace around `=`).
  const m = envText.match(/^\s*OPENCLAW_IMAGE\s*=\s*["']?([^\s"']+)/m);
  if (!m) return null;
  const ref = m[1];
  const lastColon = ref.lastIndexOf(':');
  if (lastColon === -1) return null; // no tag at all
  const tag = ref.slice(lastColon + 1);
  // A `/` after the last colon means the colon was a registry host:port
  // separator (e.g. `registry:5000/img`), not a tag delimiter.
  if (tag === '' || tag.includes('/')) return null;
  return tag;
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
 * @returns {Promise<{ version: string|null, cached: boolean, error: string|null }>}
 */
async function fetchVersion(conn, opts = {}) {
  if (!conn || !conn.instanceDir) {
    return { version: null, cached: false, error: 'no instanceDir configured for this connection' };
  }
  if (!isSafeInstanceDir(conn.instanceDir)) {
    return { version: null, cached: false, error: 'instanceDir contains unsafe characters' };
  }
  // #314: the connection's host/sshUser/sshKeyPath are interpolated into the
  // ssh command below. Connection records aren't shape-validated at write time,
  // so guard here too — no ssh runs for an unsafe-shaped target.
  const unsafe = unsafeReason(conn);
  if (unsafe) {
    return { version: null, cached: false, error: unsafe };
  }

  const cached = _cache.get(conn.id);
  if (!opts.force && cached && (Date.now() - cached.fetchedAt) < TTL_MS) {
    return { version: cached.version, cached: true, error: null };
  }

  const pending = _inflight.get(conn.id);
  if (pending) return pending;
  const read = readVersion(conn).then((result) => {
    // A connection edited or deleted mid-read has been invalidated, which
    // drops this entry; its result describes the old target, so don't cache it.
    if (_inflight.get(conn.id) === read && result.cacheable) {
      _cache.set(conn.id, { version: result.version, fetchedAt: Date.now() });
    }
    return { version: result.version, cached: false, error: result.error };
  }).finally(() => {
    if (_inflight.get(conn.id) === read) _inflight.delete(conn.id);
  });
  _inflight.set(conn.id, read);
  return read;
}

/**
 * Run the ssh read of a connection's `.env` image line. Never rejects.
 * @param {object} conn - Connection record, already shape-validated
 * @returns {Promise<{ version: string|null, error: string|null, cacheable: boolean }>}
 */
async function readVersion(conn) {
  const keyPath = String(conn.sshKeyPath || '').replace(/^~/, process.env.HOME || '');
  // Remote command: grep the image line out of the instance .env. instanceDir
  // is left unquoted so the remote shell expands a leading `~`; it's already
  // validated to a metacharacter-free shape by fetchVersion.
  const remote = `grep -m1 '^OPENCLAW_IMAGE=' ${conn.instanceDir}/.env`;
  const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new -i "${keyPath}" ${conn.sshUser}@${conn.host} "${remote}"`;

  let out;
  try {
    const res = await _internal.execAsync(cmd, { timeout: 12000, encoding: 'utf8' });
    out = res.stdout;
  } catch (err) {
    log.warn('OpenClaw version fetch failed', { connId: conn.id, error: err.message });
    return { version: null, error: `ssh read failed: ${(err.stderr || err.message || '').toString().slice(0, 200)}`, cacheable: false };
  }

  const version = parseVersion(out);
  return { version, error: version ? null : 'OPENCLAW_IMAGE not found in instance .env', cacheable: true };
}

/**
 * Drop a connection's cached version (call on connection update/delete).
 * @param {string} connId
 */
function invalidate(connId) {
  _cache.delete(connId);
  _inflight.delete(connId);
}

// Overridable for tests.
const _internal = { execAsync };

module.exports = { fetchVersion, parseVersion, isSafeInstanceDir, invalidate, _internal, _cache, _inflight, TTL_MS };
