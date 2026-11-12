'use strict';

/**
 * v6 (#3003, V6-33 / G4, Car V62-W1-B): the hardened external project
 * advisor — a projectless, read-only, rate- and spend-capped entrypoint for
 * advising on a repository TangleClaw does not manage.
 *
 * What it guarantees, each covered by a test:
 *
 * - **Read-only on the target.** {@link readRepoFile} opens files
 *   `O_RDONLY | O_NOFOLLOW` and has no write path at all. Nothing here
 *   writes into a target repository.
 * - **No escape from the target.** A relative path is canonicalized and
 *   refused if absolute, backslashed, or carrying `..`; every component is
 *   `lstat`ed from the target's real root and a symlink anywhere on the
 *   way — including the file itself — is refused (`SYMLINK_DENIED`); the
 *   opened descriptor must be the same inode the walk checked, so a swap
 *   between check and open is caught (`FILE_CHANGED`).
 * - **Isolated from internal checkouts and the switchboard.** A target root
 *   that equals, contains, or sits inside a protected root (TangleClaw's
 *   projects directory, its home) is refused (`PROTECTED_ROOT`), and a
 *   request naming a project, workspace, session or Medusa identity is
 *   refused before anything else (`PROJECT_SCOPE_DENIED`).
 * - **Scrubbed output.** File text passes through the F3 scrubber
 *   (`lib/v6/f3-support-diagnostic-scrubber.js`) before it is returned.
 * - **Capped.** A per-tenant sliding request window and a per-tenant UTC
 *   daily token and USD budget, persisted in SQLite and checked inside one
 *   `BEGIN IMMEDIATE`, so concurrent requests cannot both pass a limit. A
 *   refused request spends nothing; spend is stored as integer micro-USD.
 * - **Isolated workspace.** {@link resolveWorkspace} gives each tenant and
 *   repository its own directory under the advisor root (default
 *   `~/.tangleclaw/advisor/<tenantId>/<repoSlug>`), created `0700`, with
 *   ids restricted to a slug alphabet and no symlinked component.
 *
 * Adapted from the INT Phase 6 advisor-broker prototype, whose caps were an
 * in-memory per-process Map over a curated KB catalog; this keeps its cap
 * model (window, daily tokens, daily USD, refusals spend nothing) and
 * persists it, and adds the repository reader the issue describes.
 *
 * @module lib/v6/g4-external-advisor
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scrub } = require('./f3-support-diagnostic-scrubber');

/** The advisor's default storage root. */
const DEFAULT_ADVISOR_ROOT = path.join(os.homedir(), '.tangleclaw', 'advisor');

/** What a tenant id or repository slug must look like. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Largest file the advisor will read. */
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

/** Default caps: requests per window, window length, daily tokens, daily USD. */
const DEFAULT_LIMITS = Object.freeze({ maxRequests: 30, windowMs: 60_000, dailyTokens: 200_000, dailyUsd: 5 });

/** Request fields that name an internal identity; any of them refuses the request. */
const INTERNAL_SCOPE_FIELDS = Object.freeze(['projectId', 'projectName', 'workspaceId', 'sessionId', 'launchId', 'medusaWorkspaceId']);

/** A typed refusal with a stable `code`. */
class AdvisorError extends Error {
  /** @param {string} code @param {string} [message] */
  constructor(code, message) {
    super(message || code);
    this.name = 'AdvisorError';
    this.code = code;
  }
}

/**
 * @param {string} code
 * @param {string} [message]
 * @returns {never}
 */
function refuse(code, message) {
  throw new AdvisorError(code, message);
}

/**
 * Whether `child` is `parent` or inside it (both already real, absolute paths).
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Canonicalize a repository-relative path into its segments. Refuses
 * absolute paths, backslashes, NUL, `..`, and an empty result; drops `.`
 * and empty segments.
 * @param {string} relativePath
 * @returns {string[]}
 * @throws {AdvisorError} `PATH_DENIED`.
 */
function pathSegments(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/')
      || relativePath.includes('\\') || relativePath.includes('\0')) refuse('PATH_DENIED', 'path must be repository-relative');
  const segments = relativePath.split('/').filter((s) => s !== '' && s !== '.');
  if (!segments.length || segments.includes('..')) refuse('PATH_DENIED', 'path must not leave the repository');
  return segments;
}

/**
 * Resolve a target repository root, refusing anything that is not an
 * existing directory or that overlaps a protected root.
 * @param {string} repoRoot - Absolute.
 * @param {string[]} protectedRoots - Absolute; TangleClaw's projects directory, its home, the advisor root.
 * @returns {string} The root's real path.
 * @throws {AdvisorError} `REPO_ROOT_INVALID`, `PROTECTED_ROOT`.
 */
function resolveRepoRoot(repoRoot, protectedRoots) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) refuse('REPO_ROOT_INVALID', 'repoRoot must be absolute');
  if (!Array.isArray(protectedRoots)) throw new TypeError('protectedRoots required');
  let real;
  try {
    real = fs.realpathSync(repoRoot);
  } catch {
    refuse('REPO_ROOT_INVALID', 'repoRoot does not exist');
  }
  if (!fs.statSync(real).isDirectory()) refuse('REPO_ROOT_INVALID', 'repoRoot is not a directory');
  for (const root of protectedRoots) {
    let protectedReal;
    try {
      protectedReal = fs.realpathSync(root);
    } catch {
      protectedReal = path.resolve(root);
    }
    if (isWithin(real, protectedReal) || isWithin(protectedReal, real)) refuse('PROTECTED_ROOT', 'target overlaps a protected root');
  }
  return real;
}

/**
 * Read one file from an external repository, read-only, with no symlink
 * on its path, scrubbed before it is returned.
 * @param {{repoRoot: string, relativePath: string, protectedRoots: string[], maxBytes?: number}} args
 * @returns {{relativePath: string, bytes: number, sha256: string, text: string}} `sha256` is of the raw bytes.
 * @throws {AdvisorError} `PATH_DENIED`, `REPO_ROOT_INVALID`, `PROTECTED_ROOT`, `NOT_FOUND`,
 *   `SYMLINK_DENIED`, `NOT_A_FILE`, `FILE_TOO_LARGE`, `BINARY_DENIED`, `FILE_CHANGED`.
 */
function readRepoFile({ repoRoot, relativePath, protectedRoots, maxBytes = DEFAULT_MAX_FILE_BYTES }) {
  const segments = pathSegments(relativePath);
  const root = resolveRepoRoot(repoRoot, protectedRoots);
  let current = root;
  let st = null;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      st = fs.lstatSync(current);
    } catch {
      refuse('NOT_FOUND', 'no such file');
    }
    if (st.isSymbolicLink()) refuse('SYMLINK_DENIED', 'a symlink is on the path');
  }
  if (!st.isFile()) refuse('NOT_A_FILE', 'not a regular file');
  if (st.size > maxBytes) refuse('FILE_TOO_LARGE', `file exceeds ${maxBytes} bytes`);
  let fd;
  try {
    fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP') refuse('SYMLINK_DENIED', 'the file became a symlink');
    refuse('NOT_FOUND', 'file could not be opened');
  }
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== st.ino || opened.dev !== st.dev || !opened.isFile()) refuse('FILE_CHANGED', 'the file changed between check and open');
    if (opened.size > maxBytes) refuse('FILE_TOO_LARGE', `file exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(opened.size);
    const read = opened.size ? fs.readSync(fd, buffer, 0, opened.size, 0) : 0;
    const raw = buffer.subarray(0, read);
    if (raw.includes(0)) refuse('BINARY_DENIED', 'binary files are not read');
    return {
      relativePath: segments.join('/'),
      bytes: raw.length,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      text: scrub(raw.toString('utf8'))
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The advisor's own working directory for one tenant and repository,
 * created `0700` if asked. Refuses a non-slug id and any symlinked
 * component below the root.
 * @param {{tenantId: string, repoSlug: string, root?: string, create?: boolean}} args
 * @returns {string} The absolute workspace path.
 * @throws {AdvisorError} `TENANT_INVALID`, `REPO_SLUG_INVALID`, `ROOT_INVALID`, `SYMLINK_DENIED`.
 */
function resolveWorkspace({ tenantId, repoSlug, root = DEFAULT_ADVISOR_ROOT, create = false }) {
  if (typeof tenantId !== 'string' || !SLUG_PATTERN.test(tenantId)) refuse('TENANT_INVALID', 'tenantId must be a lowercase slug');
  if (typeof repoSlug !== 'string' || !SLUG_PATTERN.test(repoSlug)) refuse('REPO_SLUG_INVALID', 'repoSlug must be a lowercase slug');
  if (typeof root !== 'string' || !path.isAbsolute(root)) refuse('ROOT_INVALID', 'advisor root must be absolute');
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let current = root;
  for (const segment of [tenantId, repoSlug]) {
    current = path.join(current, segment);
    let st = null;
    try {
      st = fs.lstatSync(current);
    } catch {
      if (!create) continue;
      fs.mkdirSync(current, { mode: 0o700 });
      st = fs.lstatSync(current);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) refuse('SYMLINK_DENIED', 'workspace path is not a plain directory');
  }
  return current;
}

/**
 * Create the advisor's request ledger table if it does not exist. Idempotent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v6_advisor_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT    NOT NULL,
      at_ms       INTEGER NOT NULL,
      day         TEXT    NOT NULL,
      tokens      INTEGER NOT NULL CHECK (tokens >= 0),
      usd_micros  INTEGER NOT NULL CHECK (usd_micros >= 0),
      repo_slug   TEXT,
      rel_path    TEXT
    );
    CREATE INDEX IF NOT EXISTS v6_advisor_requests_tenant_time ON v6_advisor_requests (tenant_id, at_ms);
    CREATE INDEX IF NOT EXISTS v6_advisor_requests_tenant_day ON v6_advisor_requests (tenant_id, day);
  `);
}

/**
 * A persisted per-tenant cap ledger.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{maxRequests?: number, windowMs?: number, dailyTokens?: number, dailyUsd?: number}} [limits]
 * @returns {{reserve: (req: {tenantId: string, tokens: number, usd: number, now: number, repoSlug?: string, relativePath?: string}) => object,
 *   usage: (tenantId: string, now: number) => {tokens: number, usd: number, requestsInWindow: number}}}
 * @throws {TypeError} On a non-positive limit.
 */
function createAdvisorLedger(db, limits = {}) {
  const l = { ...DEFAULT_LIMITS, ...limits };
  if (![l.maxRequests, l.windowMs, l.dailyTokens, l.dailyUsd].every((x) => Number.isFinite(x) && x > 0)) throw new TypeError('invalid limits');
  ensureSchema(db);
  const dailyUsdMicros = Math.round(l.dailyUsd * 1e6);
  const counts = (tenantId, now) => {
    const day = new Date(now).toISOString().slice(0, 10);
    const inWindow = db.prepare('SELECT COUNT(*) AS n FROM v6_advisor_requests WHERE tenant_id = ? AND at_ms > ? AND at_ms <= ?')
      .get(tenantId, now - l.windowMs, now).n;
    const spent = db.prepare('SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(usd_micros), 0) AS usd FROM v6_advisor_requests WHERE tenant_id = ? AND day = ?')
      .get(tenantId, day);
    return { day, inWindow: Number(inWindow), tokens: Number(spent.tokens), usdMicros: Number(spent.usd) };
  };
  return {
    reserve({ tenantId, tokens, usd, now, repoSlug = null, relativePath = null }) {
      if (typeof tenantId !== 'string' || !SLUG_PATTERN.test(tenantId)) return { ok: false, code: 'TENANT_INVALID' };
      if (!Number.isSafeInteger(tokens) || tokens < 1 || !Number.isFinite(usd) || usd < 0 || !Number.isFinite(now)) {
        return { ok: false, code: 'BAD_REQUEST' };
      }
      const usdMicros = Math.round(usd * 1e6);
      db.exec('BEGIN IMMEDIATE');
      try {
        const c = counts(tenantId, now);
        let result;
        if (c.inWindow >= l.maxRequests) result = { ok: false, code: 'RATE_LIMIT' };
        else if (c.tokens + tokens > l.dailyTokens || c.usdMicros + usdMicros > dailyUsdMicros) result = { ok: false, code: 'DAILY_BUDGET' };
        else {
          db.prepare('INSERT INTO v6_advisor_requests (tenant_id, at_ms, day, tokens, usd_micros, repo_slug, rel_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(tenantId, now, c.day, tokens, usdMicros, repoSlug, relativePath);
          result = { ok: true, day: c.day, charged: { tokens, usd: usdMicros / 1e6 } };
        }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* the failed statement already ended the transaction */ }
        throw error;
      }
    },
    usage(tenantId, now) {
      const c = counts(tenantId, now);
      return { tokens: c.tokens, usd: c.usdMicros / 1e6, requestsInWindow: c.inWindow };
    }
  };
}

/**
 * Serve one advisor read: refuse any internal identity, read the file
 * (refusing before any spend if it cannot be read), then reserve the
 * estimated cost; only a reserved read returns its text.
 * @param {{tenantId: string, repoSlug: string, repoRoot: string, relativePath: string,
 *   estimate: {tokens: number, usd: number}}} request
 * @param {{ledger: ReturnType<typeof createAdvisorLedger>, protectedRoots: string[], now: number, maxBytes?: number}} deps
 *   - `now` is trusted server time, never a client value.
 * @returns {{ok: true, file: object, charged: object}|{ok: false, code: string}}
 */
function advise(request, { ledger, protectedRoots, now, maxBytes }) {
  const req = request && typeof request === 'object' ? request : {};
  if (INTERNAL_SCOPE_FIELDS.some((f) => req[f] !== undefined)) return { ok: false, code: 'PROJECT_SCOPE_DENIED' };
  if (typeof req.repoSlug !== 'string' || !SLUG_PATTERN.test(req.repoSlug)) return { ok: false, code: 'REPO_SLUG_INVALID' };
  const estimate = req.estimate || {};
  let file;
  try {
    file = readRepoFile({ repoRoot: req.repoRoot, relativePath: req.relativePath, protectedRoots, maxBytes });
  } catch (error) {
    if (error instanceof AdvisorError) return { ok: false, code: error.code };
    throw error;
  }
  const reservation = ledger.reserve({
    tenantId: req.tenantId, tokens: estimate.tokens, usd: estimate.usd, now,
    repoSlug: req.repoSlug, relativePath: file.relativePath
  });
  if (!reservation.ok) return { ok: false, code: reservation.code };
  return { ok: true, file, charged: reservation.charged };
}

module.exports = {
  DEFAULT_ADVISOR_ROOT,
  SLUG_PATTERN,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_LIMITS,
  INTERNAL_SCOPE_FIELDS,
  AdvisorError,
  ensureSchema,
  readRepoFile,
  resolveRepoRoot,
  resolveWorkspace,
  createAdvisorLedger,
  advise
};
