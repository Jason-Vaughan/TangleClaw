'use strict';

/**
 * v6 (#3005, V6-35 / A1-Iso, Car V62-W1-B): isolated-mode admission for
 * fleet sessions — #1149 Phase 6, ADR 0026 Rev 5.
 *
 * Trusted Team Mode (#1149) is APPLICATION authorization: every shell still
 * runs as the host's own OS user, so it is not isolation from hostile code
 * (PRR-A Phase 2: "do not claim OS isolation"). This module is the step
 * past that. Given a session's requested isolation profile and the host's
 * facts, {@link planIsolation} either admits it — returning the exact
 * container argv or spawn options a launcher would use — or refuses with a
 * stable code. It runs nothing itself.
 *
 * Three modes:
 *
 * - `shared_uid` — the existing behavior, admitted only when the profile
 *   does not require isolation. Its attestation says `isolated: false`.
 * - `container` — Docker or Podman, with a read-only root filesystem, all
 *   capabilities dropped, `no-new-privileges`, a pids limit, a non-root
 *   user, network `none` (or one named, pre-provisioned allowlist network),
 *   and only bind mounts whose sources sit inside the profile's mount
 *   roots, read-only unless inside a writable root. Apple Containerization
 *   is a recognized runtime but refused (`RUNTIME_UNSUPPORTED`) until its
 *   CLI flags are verified, rather than guessed at.
 * - `separate_unix_uid` — spawn as an unprivileged uid/gid that is neither
 *   root nor the host's own uid, with a minimal allowlisted environment.
 *   Its attestation records that only process and filesystem-permission
 *   separation is provided: network is still shared.
 *
 * FAIL CLOSED: a profile that requires isolation is never downgraded. An
 * unavailable runtime, a host that cannot switch uid, root as the target, or
 * a target uid or gid that is the host's own (including any host
 * supplementary group) all refuse — none falls back to `shared_uid`.
 *
 * Every decision, admitted or refused, can be recorded as an attestation
 * receipt ({@link recordAttestation}), idempotent per session, profile
 * digest and decision, in a table {@link ensureSchema} creates.
 *
 * @module lib/v6/a1-iso-host-sandboxing
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** The isolation modes a profile may request. */
const ISOLATION_MODES = Object.freeze(['shared_uid', 'container', 'separate_unix_uid']);

/** Container runtimes the planner recognizes. */
const CONTAINER_RUNTIMES = Object.freeze(['docker', 'podman', 'apple-container']);

/** Runtimes whose argv this module knows how to build. */
const ARGV_RUNTIMES = Object.freeze(['docker', 'podman']);

/** Environment variables passed through to a separate-uid session; everything else is dropped. */
const ENV_ALLOWLIST = Object.freeze(['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM']);

/** Container paths a bind mount may never target. */
const FORBIDDEN_MOUNT_TARGETS = Object.freeze(['/', '/etc', '/bin', '/sbin', '/usr', '/lib', '/proc', '/sys', '/dev', '/var/run', '/run']);

/** Host directories no mount may expose, whatever the host policy lists: refused as a source, inside a source, or containing one. */
// macOS resolves /etc and /var under /private, so their real paths are listed
// too (Ruling A658 addendum); /private itself is not, so legitimate sources
// elsewhere under it stay admissible when host policy allows them.
const SENSITIVE_SYSTEM_DIRS = Object.freeze(['/etc', '/var', '/private/etc', '/private/var', '/proc', '/sys', '/dev', '/root', '/boot', '/bin', '/sbin', '/usr', '/lib', '/System', '/Library']);

/** Dot-directories under the host home that hold credentials or TangleClaw state. */
const SENSITIVE_HOME_DIRS = Object.freeze(['.ssh', '.gnupg', '.aws', '.config', '.docker', '.kube', '.tangleclaw']);

/** Default process limit inside a container. */
const DEFAULT_PIDS_LIMIT = 256;

/** What an image reference must look like (no spaces or shell syntax). */
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;

/** What a named allowlist network must look like. */
const NETWORK_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/**
 * @param {string} code
 * @param {string} reason
 * @returns {{ok: false, code: string, reason: string}}
 */
function refused(code, reason) {
  return { ok: false, code, reason };
}

/**
 * A stable digest of a profile: canonical JSON (keys sorted at every level).
 * @param {object} profile
 * @returns {string}
 */
function profileDigest(profile) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = canonical(v[k]); return o; }, {});
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(profile || {}))).digest('hex');
}

/**
 * Whether absolute `child` is `parent` or inside it.
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Refuse a target uid/gid that would keep the host user's or group's
 * access: the host uid, the host primary gid, or any host supplementary
 * group. An unreadable host gid fails closed. Applies to both isolated
 * modes — a container running as a host id owns the host's files on any
 * writable mount just as a spawned process would (PRR-B R1 HOLD on #3033).
 * @param {{uid: number, gid: number}} p
 * @param {{uid: number|null, gid?: number|null, groups?: number[]}} h
 * @returns {{ok: false, code: string, reason: string}|null}
 */
function hostIdentityConflict(p, h) {
  if (!Number.isSafeInteger(h.uid)) return refused('HOST_UID_UNKNOWN', 'the host uid could not be read');
  if (!Number.isSafeInteger(h.gid)) return refused('HOST_GID_UNKNOWN', 'the host gid could not be read');
  if (p.uid === h.uid) return refused('SAME_UID', 'the target uid equals the host uid, which isolates nothing');
  const hostGroups = [h.gid, ...(Array.isArray(h.groups) ? h.groups : [])];
  if (hostGroups.includes(p.gid)) return refused('SAME_GID', 'the target gid is one of the host user\'s groups, which keeps host group access');
  return null;
}

/**
 * Whether `value` is an unprivileged id: a positive safe integer.
 * @param {*} value
 * @returns {boolean}
 */
function isUnprivilegedId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Why a real host path may not be a mount source, or null when it may.
 * Refused: the filesystem root (exact match only, so it does not contain
 * every path); any system directory, anything inside one,
 * or anything containing one; the host home itself or anything containing
 * it (subdirectories of home stay mountable); a sensitive home dot-directory
 * or anything inside it; and any protected root, inside or containing.
 * Applied whatever the host allowlist says (TC-Lane-C B1, Ruling A658).
 * @param {string} real - Absolute real path of the source.
 * @param {{home?: string|null, protectedRoots?: string[]}} host
 * @returns {string|null}
 */
function sensitiveSource(real, { home, protectedRoots } = {}) {
  if (real === path.parse(real).root) return 'the filesystem root';
  for (const dir of SENSITIVE_SYSTEM_DIRS) {
    if (isWithin(real, dir) || isWithin(dir, real)) return `system directory ${dir}`;
  }
  if (typeof home === 'string' && path.isAbsolute(home)) {
    if (isWithin(home, real)) return 'the host home directory';
    for (const dot of SENSITIVE_HOME_DIRS) {
      const sensitive = path.join(home, dot);
      if (isWithin(real, sensitive) || isWithin(sensitive, real)) return `credential directory ${sensitive}`;
    }
  }
  for (const root of Array.isArray(protectedRoots) ? protectedRoots : []) {
    if (typeof root === 'string' && path.isAbsolute(root) && (isWithin(real, root) || isWithin(root, real))) return `protected root ${root}`;
  }
  return null;
}

/**
 * Validate a container's bind mounts against the HOST's mount policy — never
 * the session profile's (TC-Lane-C B1, Ruling A658: a profile could
 * otherwise grant itself `/` read-write). `realpath` is injected so the
 * caller resolves symlinks on the real host; a source whose real path
 * differs from its literal path is refused, so a symlink cannot redirect a
 * mount outside the allowed roots. Sensitive sources are refused even when
 * the policy lists them.
 * @param {Array<{source: string, target: string, readOnly?: boolean}>} mounts
 * @param {{mountRoots: string[], writableRoots: string[], realpath: (p: string) => string,
 *   home?: string|null, protectedRoots?: string[]}} policy - From trusted host facts.
 * @returns {{ok: true, mounts: Array<{source: string, target: string, readOnly: boolean}>}|{ok: false, code: string, reason: string}}
 */
function validateMounts(mounts, { mountRoots, writableRoots, realpath, home = null, protectedRoots = [] }) {
  const out = [];
  for (const m of Array.isArray(mounts) ? mounts : []) {
    if (!m || typeof m.source !== 'string' || typeof m.target !== 'string'
        || !path.isAbsolute(m.source) || !path.isAbsolute(m.target)) return refused('MOUNT_INVALID', 'mount source and target must be absolute');
    if ([m.source, m.target].some((p) => p.includes(',') || p.includes('\0'))) return refused('MOUNT_INVALID', 'mount paths may not contain commas or NUL');
    const target = path.posix.normalize(m.target);
    if (FORBIDDEN_MOUNT_TARGETS.some((t) => target === t || (t !== '/' && isWithin(target, t)))) return refused('MOUNT_TARGET_FORBIDDEN', `cannot mount over ${target}`);
    let real;
    try {
      real = realpath(m.source);
    } catch {
      return refused('MOUNT_INVALID', `mount source does not exist: ${m.source}`);
    }
    if (real !== path.resolve(m.source)) return refused('MOUNT_SYMLINK_DENIED', `mount source resolves elsewhere: ${m.source}`);
    const why = sensitiveSource(real, { home, protectedRoots });
    if (why) return refused('MOUNT_SOURCE_SENSITIVE', `cannot mount ${why}: ${m.source}`);
    if (!mountRoots.some((root) => isWithin(real, root))) return refused('MOUNT_NOT_ALLOWED', `mount source outside the allowed roots: ${m.source}`);
    const wantsWrite = m.readOnly === false;
    if (wantsWrite && !writableRoots.some((root) => isWithin(real, root))) return refused('MOUNT_WRITE_DENIED', `writable mount outside the writable roots: ${m.source}`);
    out.push({ source: real, target, readOnly: !wantsWrite });
  }
  return { ok: true, mounts: out };
}

/**
 * Plan (admit or refuse) one session's isolation.
 * @param {{mode: string, requireIsolation?: boolean, runtime?: string, image?: string, command?: string[],
 *   uid?: number, gid?: number, network?: 'none'|{allowlistNetwork: string},
 *   mounts?: Array<{source: string, target: string, readOnly?: boolean}>, pidsLimit?: number, workdir?: string}} profile
 *   - Untrusted: what the session asks for. It may NOT carry mountRoots/writableRoots.
 * @param {{uid: number|null, gid?: number|null, groups?: number[], runtimes?: Record<string, boolean>, canSwitchUid?: boolean,
 *   env?: Record<string, string>, realpath?: (p: string) => string, mountRoots?: string[], writableRoots?: string[],
 *   home?: string, protectedRoots?: string[]}} host - Trusted: facts and policy the server supplies.
 * @returns {{ok: true, mode: string, launch: object, attestation: object}|{ok: false, code: string, reason: string}}
 */
function planIsolation(profile, host) {
  const p = profile && typeof profile === 'object' ? profile : null;
  const h = host && typeof host === 'object' ? host : null;
  if (!p || !ISOLATION_MODES.includes(p.mode)) return refused('MODE_INVALID', `mode must be one of ${ISOLATION_MODES.join(', ')}`);
  if (!h) return refused('HOST_FACTS_REQUIRED', 'host facts are required');

  if (p.mode === 'shared_uid') {
    if (p.requireIsolation === true) return refused('ISOLATION_REQUIRED', 'this profile requires isolation; shared_uid is not isolation');
    return {
      ok: true, mode: 'shared_uid', launch: { kind: 'spawn', options: {} },
      attestation: { mode: 'shared_uid', isolated: false, process: 'shared', filesystem: 'shared', network: 'shared', hostUid: h.uid ?? null, targetUid: h.uid ?? null }
    };
  }

  if (p.mode === 'separate_unix_uid') {
    if (!isUnprivilegedId(p.uid) || !isUnprivilegedId(p.gid)) return refused('TARGET_ID_INVALID', 'target uid and gid must be positive integers (root is refused)');
    const conflict = hostIdentityConflict(p, h);
    if (conflict) return conflict;
    if (h.canSwitchUid !== true) return refused('ISOLATION_UNAVAILABLE', 'this host cannot start a process as another uid');
    if (p.workdir !== undefined && (typeof p.workdir !== 'string' || !path.isAbsolute(p.workdir))) return refused('WORKDIR_INVALID', 'workdir must be absolute');
    const env = {};
    for (const key of ENV_ALLOWLIST) if (h.env && typeof h.env[key] === 'string') env[key] = h.env[key];
    if (p.workdir) env.HOME = p.workdir;
    return {
      ok: true, mode: 'separate_unix_uid',
      // `clearSupplementaryGroups`: the launcher must drop every inherited
      // supplementary group (setgroups([])) before exec, so the session
      // keeps no host group access through them.
      launch: { kind: 'spawn', clearSupplementaryGroups: true, options: { uid: p.uid, gid: p.gid, env, ...(p.workdir ? { cwd: p.workdir } : {}) } },
      attestation: { mode: 'separate_unix_uid', isolated: true, process: 'separate-uid', filesystem: 'uid-permissions', network: 'shared', hostUid: h.uid, targetUid: p.uid }
    };
  }

  // container
  if (!CONTAINER_RUNTIMES.includes(p.runtime)) return refused('RUNTIME_INVALID', `runtime must be one of ${CONTAINER_RUNTIMES.join(', ')}`);
  if (!h.runtimes || h.runtimes[p.runtime] !== true) return refused('RUNTIME_UNAVAILABLE', `${p.runtime} is not available on this host`);
  if (!ARGV_RUNTIMES.includes(p.runtime)) return refused('RUNTIME_UNSUPPORTED', `${p.runtime} is recognized but its launch flags are not yet verified`);
  if (typeof p.image !== 'string' || !IMAGE_PATTERN.test(p.image)) return refused('IMAGE_INVALID', 'image must be a plain image reference');
  if (!isUnprivilegedId(p.uid) || !isUnprivilegedId(p.gid)) return refused('TARGET_ID_INVALID', 'a container runs as a non-root uid and gid');
  const conflict = hostIdentityConflict(p, h);
  if (conflict) return conflict;
  if (!Array.isArray(p.command) || !p.command.length || !p.command.every((a) => typeof a === 'string' && !a.includes('\0'))) {
    return refused('COMMAND_INVALID', 'command must be a non-empty list of strings');
  }
  let networkArg;
  if (p.network === undefined || p.network === 'none') networkArg = 'none';
  else if (p.network && typeof p.network.allowlistNetwork === 'string' && NETWORK_PATTERN.test(p.network.allowlistNetwork)) networkArg = p.network.allowlistNetwork;
  else return refused('NETWORK_INVALID', 'network must be "none" or {allowlistNetwork: <name>}');
  if (networkArg === 'host' || networkArg === 'bridge') return refused('NETWORK_INVALID', `network "${networkArg}" is not an allowlist`);
  const pidsLimit = p.pidsLimit === undefined ? DEFAULT_PIDS_LIMIT : p.pidsLimit;
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 1) return refused('PIDS_LIMIT_INVALID', 'pidsLimit must be a positive integer');
  if (p.workdir !== undefined && (typeof p.workdir !== 'string' || !path.posix.isAbsolute(p.workdir))) return refused('WORKDIR_INVALID', 'workdir must be absolute');
  // Mount policy is the HOST's. A profile that tries to supply its own is
  // refused outright rather than silently ignored, so the misuse is visible.
  if (p.mountRoots !== undefined || p.writableRoots !== undefined) {
    return refused('MOUNT_POLICY_FROM_PROFILE', 'mount roots come from host policy, never from the session profile');
  }
  const mountRoots = Array.isArray(h.mountRoots) ? h.mountRoots.filter((r) => typeof r === 'string' && path.isAbsolute(r)) : [];
  const writableRoots = Array.isArray(h.writableRoots) ? h.writableRoots.filter((r) => typeof r === 'string' && path.isAbsolute(r)) : [];
  if (Array.isArray(p.mounts) && p.mounts.length && typeof h.realpath !== 'function') return refused('HOST_FACTS_REQUIRED', 'host.realpath is required to admit mounts');
  const home = typeof h.home === 'string' ? h.home : os.homedir();
  const checked = validateMounts(p.mounts, { mountRoots, writableRoots, realpath: h.realpath, home, protectedRoots: h.protectedRoots });
  if (!checked.ok) return checked;

  const args = ['run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    `--pids-limit=${pidsLimit}`, `--network=${networkArg}`, `--user=${p.uid}:${p.gid}`];
  for (const m of checked.mounts) args.push(`--mount=type=bind,src=${m.source},dst=${m.target}${m.readOnly ? ',readonly' : ''}`);
  if (p.workdir) args.push(`--workdir=${p.workdir}`);
  args.push(p.image, ...p.command);
  return {
    ok: true, mode: 'container',
    launch: { kind: 'exec', command: p.runtime, args },
    attestation: {
      mode: 'container', isolated: true, runtime: p.runtime, process: 'container', filesystem: 'read-only-rootfs',
      network: networkArg === 'none' ? 'none' : `allowlist:${networkArg}`, hostUid: h.uid ?? null, targetUid: p.uid,
      mounts: checked.mounts.map((m) => `${m.source}:${m.target}:${m.readOnly ? 'ro' : 'rw'}`)
    }
  };
}

/**
 * Create the attestation receipts table if it does not exist. Idempotent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v6_isolation_attestations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      profile_digest  TEXT    NOT NULL CHECK (length(profile_digest) = 64),
      mode            TEXT    NOT NULL,
      decision        TEXT    NOT NULL CHECK (decision IN ('admitted', 'refused')),
      code            TEXT,
      isolated        INTEGER NOT NULL CHECK (isolated IN (0, 1)),
      host_uid        INTEGER,
      target_uid      INTEGER,
      detail_json     TEXT    NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS v6_isolation_attestations_once
      ON v6_isolation_attestations (session_id, profile_digest, decision);
  `);
}

/**
 * Record one isolation decision as a receipt. Idempotent: the same session,
 * profile and decision record once; a repeat returns the existing row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionId: string, profile: object, plan: ReturnType<typeof planIsolation>, now?: number}} args
 * @returns {{id: number, created: boolean, decision: string, isolated: boolean}}
 * @throws {TypeError} On a missing session id or plan.
 */
function recordAttestation(db, { sessionId, profile, plan, now = Date.now() }) {
  if (typeof sessionId !== 'string' || !sessionId || !plan || typeof plan.ok !== 'boolean') throw new TypeError('sessionId and plan required');
  ensureSchema(db);
  const digest = profileDigest(profile);
  const decision = plan.ok ? 'admitted' : 'refused';
  const a = plan.ok ? plan.attestation : {};
  const mode = plan.ok ? plan.mode : (profile && typeof profile.mode === 'string' ? profile.mode : 'unknown');
  const info = db.prepare(`INSERT OR IGNORE INTO v6_isolation_attestations
    (session_id, profile_digest, mode, decision, code, isolated, host_uid, target_uid, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId, digest, mode, decision, plan.ok ? null : plan.code, plan.ok && a.isolated ? 1 : 0,
    Number.isSafeInteger(a.hostUid) ? a.hostUid : null, Number.isSafeInteger(a.targetUid) ? a.targetUid : null,
    JSON.stringify(plan.ok ? a : { code: plan.code, reason: plan.reason }), now
  );
  const row = db.prepare('SELECT id, decision, isolated FROM v6_isolation_attestations WHERE session_id = ? AND profile_digest = ? AND decision = ?')
    .get(sessionId, digest, decision);
  return { id: Number(row.id), created: Number(info.changes) === 1, decision: row.decision, isolated: row.isolated === 1 };
}

/**
 * Every receipt recorded for a session, oldest first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @returns {object[]}
 */
function listAttestations(db, sessionId) {
  ensureSchema(db);
  return db.prepare('SELECT * FROM v6_isolation_attestations WHERE session_id = ? ORDER BY id').all(sessionId)
    .map((r) => ({ ...r, isolated: r.isolated === 1, detail: JSON.parse(r.detail_json) }));
}

/**
 * The facts of the running host that can be read without spawning
 * anything. Container runtimes and uid switching are left for the caller to
 * probe and supply; unknown here means unavailable, so planning fails closed.
 * @returns {{uid: number|null, gid: number|null, groups: number[], runtimes: object, canSwitchUid: boolean, env: object}}
 */
function currentHostFacts() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
  return { uid, gid, groups, runtimes: {}, canSwitchUid: false, env: { ...process.env } };
}

module.exports = {
  ISOLATION_MODES,
  CONTAINER_RUNTIMES,
  ARGV_RUNTIMES,
  ENV_ALLOWLIST,
  FORBIDDEN_MOUNT_TARGETS,
  SENSITIVE_SYSTEM_DIRS,
  SENSITIVE_HOME_DIRS,
  DEFAULT_PIDS_LIMIT,
  profileDigest,
  validateMounts,
  sensitiveSource,
  planIsolation,
  ensureSchema,
  recordAttestation,
  listAttestations,
  currentHostFacts
};
