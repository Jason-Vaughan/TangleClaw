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
const { expandHomePath } = require('./project-paths');
// #1531: every SSH consumer resolves the reachable address rather than
// reading conn.host directly, so a connection with ordered fallback hosts
// keeps working when its primary address stops answering.
const openclawRemote = require('./openclaw-remote');

const log = createLogger('openclaw-version');

const TTL_MS = 5 * 60 * 1000; // 5 min — version changes only on an instance update
// A failed read is remembered for a short while. The panel re-renders every few
// seconds, and an unreachable host would otherwise get a fresh ssh (and a 6 s
// connect wait) on each render, indefinitely. `force` still retries at once.
const FAILURE_TTL_MS = 60 * 1000;
const _cache = new Map(); // connId -> { version, error, fetchedAt }
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
  const ttl = cached && cached.failed ? FAILURE_TTL_MS : TTL_MS;
  if (!opts.force && cached && (Date.now() - cached.fetchedAt) < ttl) {
    return { version: cached.version, cached: true, error: cached.error };
  }

  const pending = _inflight.get(conn.id);
  if (pending) return pending;
  const read = readVersion(conn).then((result) => {
    // A connection edited or deleted mid-read has been invalidated, which
    // drops this entry; its result describes the old target, so don't cache it.
    if (_inflight.get(conn.id) === read) {
      _cache.set(conn.id, { version: result.version, error: result.error, failed: result.failed, fetchedAt: Date.now() });
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
 * @returns {Promise<{ version: string|null, error: string|null, failed: boolean }>}
 */
async function readVersion(conn) {
  const keyPath = expandHomePath(String(conn.sshKeyPath || ''));
  // #1531: resolve the reachable address (conn.host, or a fallback if the
  // primary doesn't answer) before building the ssh command. Deliberately
  // NOT awaited when there are no fallbackHosts at all: an `await` defers at
  // least one microtask even for an already-resolved value, which would
  // move the `_internal.execAsync` call off the SAME synchronous tick as the
  // `fetchVersion()` call that triggers it — exactly the zero-overhead
  // property `test/openclaw-version.test.js`'s concurrency tests depend on
  // (three synchronous `fetchVersion()` calls expect three synchronous
  // `execAsync` calls) and the one #1531's own dispatch explicitly asked
  // this resolver to preserve for the common, no-fallback case.
  const route = (Array.isArray(conn.fallbackHosts) && conn.fallbackHosts.length > 0)
    ? await openclawRemote.resolveReachableHost(conn)
    : { host: conn.host, fallbackUsed: false };
  // Remote command: grep the image line out of the instance .env. instanceDir
  // is left unquoted so the remote shell expands a leading `~`; it's already
  // validated to a metacharacter-free shape by fetchVersion.
  const remote = `grep -m1 '^OPENCLAW_IMAGE=' ${conn.instanceDir}/.env`;
  const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new -i "${keyPath}" ${conn.sshUser}@${route.host} "${remote}"`;

  let out;
  try {
    const res = await _internal.execAsync(cmd, { timeout: 12000, encoding: 'utf8' });
    out = res.stdout;
  } catch (err) {
    // #1531: the resolved route just failed over SSH — forget it so the
    // NEXT call re-probes rather than retrying the same dead address.
    openclawRemote.invalidateResolvedHost(conn.id);
    log.warn('OpenClaw version fetch failed', { connId: conn.id, host: route.host, error: err.message });
    return { version: null, error: `ssh read failed: ${(err.stderr || err.message || '').toString().slice(0, 200)}`, failed: true };
  }

  const version = parseVersion(out);
  return { version, error: version ? null : 'OPENCLAW_IMAGE not found in instance .env', failed: false };
}

// ── #297: update-available tag comparison + .env tag rewrite ──

// Both CalVer (`2026.5.28`) and semver (`v5.71.0` / `5.71.0`) tags are three
// dot-separated integers, with semver's leading `v` optional — one pattern
// covers both, so "which scheme is this" never has to be decided.
const VERSION_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a tag into a 3-integer tuple, or null for anything that isn't one
 * (`latest`, `qmd`, a branch name, ...).
 * @param {string} tag
 * @returns {[number, number, number]|null}
 */
function _parseVersionTag(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().match(VERSION_TAG_RE);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}

/**
 * Compare two OpenClaw image tags. Honest about non-version tags (#297): a
 * tag like `latest` or `qmd` carries no ordering, so `comparable: false` —
 * never guessed at as "no update" dressed up as a real answer.
 * @param {string} currentTag
 * @param {string} latestTag
 * @returns {{comparable: boolean, updateAvailable: boolean, currentTag: string|null, latestTag: string|null}}
 */
function compareOpenclawTags(currentTag, latestTag) {
  const cur = _parseVersionTag(currentTag);
  const lat = _parseVersionTag(latestTag);
  if (!cur || !lat) {
    return { comparable: false, updateAvailable: false, currentTag: currentTag || null, latestTag: latestTag || null };
  }
  let updateAvailable = false;
  for (let i = 0; i < 3; i++) {
    if (lat[i] > cur[i]) { updateAvailable = true; break; }
    if (lat[i] < cur[i]) break;
  }
  return { comparable: true, updateAvailable, currentTag, latestTag };
}

// GHCR's token-then-list dance for an unauthenticated public image (#297):
// an anonymous pull token, then the tags list under it. No credentials
// involved — the same two-call sequence `docker pull` itself makes against
// any public GHCR image.
const GHCR_TOKEN_URL = 'https://ghcr.io/token?scope=repository:openclaw/openclaw:pull';
const GHCR_TAGS_URL = 'https://ghcr.io/v2/openclaw/openclaw/tags/list';
const GHCR_FETCH_TIMEOUT_MS = 5000;

/**
 * The real default `fetchLatestTagImpl`: the highest CalVer/semver tag GHCR
 * currently lists for `openclaw/openclaw`, chosen via `compareOpenclawTags`
 * so a non-version tag (`latest`, `qmd`, `edge`) is never mistaken for the
 * newest release. Never throws — a network failure, a non-2xx response, or
 * a malformed body all resolve to `null`, the same "fail gracefully, let
 * the caller's own `!latestVersion` branch handle it honestly" posture
 * `fetchVersion`/`readVersion` already use elsewhere in this module.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Overall request budget (default `GHCR_FETCH_TIMEOUT_MS`).
 * @returns {Promise<string|null>}
 */
async function _fetchLatestGhcrTag(opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : GHCR_FETCH_TIMEOUT_MS;
  try {
    const tokenRes = await _internal.fetchImpl(GHCR_TOKEN_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!tokenRes.ok) return null;
    const tokenBody = await tokenRes.json();
    if (!tokenBody || typeof tokenBody.token !== 'string') return null;

    const tagsRes = await _internal.fetchImpl(GHCR_TAGS_URL, {
      headers: { Authorization: `Bearer ${tokenBody.token}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!tagsRes.ok) return null;
    const tagsBody = await tagsRes.json();
    const tags = Array.isArray(tagsBody && tagsBody.tags) ? tagsBody.tags : [];

    // I-Gate Round 3: a non-version tag (`latest`, `edge`, `main`) must never
    // become `best` just because it happened to be first — GHCR's tag order
    // is not version order, and `latest` sorting ahead of a real version tag
    // would otherwise make every later comparison incomparable, silently
    // suppressing the update badge.
    let best = null;
    for (const tag of tags) {
      if (!_parseVersionTag(tag)) continue;
      if (!best) { best = tag; continue; }
      const cmp = compareOpenclawTags(best, tag);
      if (cmp.comparable && cmp.updateAvailable) best = tag;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Whether a connection has a newer OpenClaw image available, combining its
 * current (SSH-read) version with a latest tag — given directly
 * (`opts.latestTag`), fetched via an injected `opts.fetchLatestTagImpl`
 * (tests), or by default querying GHCR for real (`_fetchLatestGhcrTag`).
 * @param {object} conn - Connection record.
 * @param {object} [opts]
 * @param {boolean} [opts.force] - Bypass `fetchVersion`'s cache.
 * @param {string} [opts.latestTag] - The latest tag, if already known.
 * @param {() => Promise<string|null>} [opts.fetchLatestTagImpl] - Overrides the default GHCR fetch, for tests.
 * @returns {Promise<{currentVersion: string|null, latestVersion: string|null, updateAvailable: boolean,
 *   comparable: boolean, canRewriteEnv: boolean, error?: string}>}
 */
async function checkUpdateAvailable(conn, opts = {}) {
  const { version: currentVersion } = await fetchVersion(conn, { force: opts.force });
  const canRewriteEnv = isSafeInstanceDir(conn && conn.instanceDir);

  let latestVersion = opts.latestTag || null;
  if (!latestVersion) {
    const fetchLatest = typeof opts.fetchLatestTagImpl === 'function' ? opts.fetchLatestTagImpl : _fetchLatestGhcrTag;
    try {
      latestVersion = await fetchLatest();
    } catch (err) {
      // A custom, injected fetchLatestTagImpl may still throw (tests); the
      // real default (_fetchLatestGhcrTag) never does.
      return {
        currentVersion, latestVersion: null, updateAvailable: false, comparable: false, canRewriteEnv,
        error: `failed to fetch the latest tag: ${err.message}`
      };
    }
  }
  if (!currentVersion || !latestVersion) {
    return { currentVersion, latestVersion, updateAvailable: false, comparable: false, canRewriteEnv };
  }
  const cmp = compareOpenclawTags(currentVersion, latestVersion);
  return { currentVersion, latestVersion, updateAvailable: cmp.updateAvailable, comparable: cmp.comparable, canRewriteEnv };
}

// Docker tag shape: alnum, dot, underscore, hyphen (Docker's own grammar is
// `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`; this is deliberately a little
// stricter — leading `.`/`-` is rare in practice and not worth the extra
// edge case — rather than more permissive, since this interpolates into a
// shell command below).
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Whether a tag is shape-safe to interpolate into a shell command.
 * @param {string} tag
 * @returns {boolean}
 */
function isSafeTag(tag) {
  return typeof tag === 'string' && SAFE_TAG.test(tag);
}

/**
 * Build the shell command that rewrites `OPENCLAW_IMAGE`'s tag in an
 * instance's `.env` to `newTag`, preserving the registry/image path
 * verbatim — the same "last colon, nothing after it but the tag" rule
 * `parseVersion` already uses, kept consistent so the two never disagree
 * about where the tag starts (#297).
 *
 * Never builds a command from an unsafe `instanceDir`/`newTag` — both are
 * shape-validated first, same posture as `fetchVersion`'s own guard.
 *
 * @param {string} instanceDir - The instance's host directory (its `.env` lives at `<instanceDir>/.env`).
 * @param {string} newTag - The tag to rewrite to.
 * @returns {{ok: boolean, script: string|null, error: string|null}}
 */
function buildEnvTagUpdateScript(instanceDir, newTag) {
  if (!isSafeInstanceDir(instanceDir)) {
    return { ok: false, script: null, error: 'instanceDir contains unsafe characters' };
  }
  if (!isSafeTag(newTag)) {
    return { ok: false, script: null, error: 'newTag contains unsafe characters' };
  }
  const script = `sed -i.bak -E 's#^(OPENCLAW_IMAGE=.*):([^:/]*)$#\\1:${newTag}#' ${instanceDir}/.env`;
  return { ok: true, script, error: null };
}

/**
 * Drop a connection's cached version (call on connection update/delete).
 * @param {string} connId
 */
function invalidate(connId) {
  _cache.delete(connId);
  _inflight.delete(connId);
  // #1531: host/fallbackHosts may have changed along with everything else
  // on an update — a stale resolved route must not survive it.
  openclawRemote.invalidateResolvedHost(connId);
}

// Overridable for tests.
const _internal = { execAsync, fetchImpl: fetch };

module.exports = {
  fetchVersion, parseVersion, isSafeInstanceDir, invalidate, _internal, _cache, _inflight, TTL_MS, FAILURE_TTL_MS,
  // #297
  compareOpenclawTags, checkUpdateAvailable, buildEnvTagUpdateScript, isSafeTag, _fetchLatestGhcrTag
};
