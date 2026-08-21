'use strict';

/**
 * Auto-approval of OpenClaw device pairing, over SSH to the gateway host.
 *
 * **Why this is a module and not four inline `execSync` calls (#1076).** The
 * previous implementation hardcoded `$HOME/.local/bin/docker` in four places.
 * On a host where docker lives at `/usr/bin/docker` — the common case — every
 * one of them failed, and the failure was invisible for a specific reason worth
 * stating: the remote command ended in `| head -1`, and **a pipeline's exit
 * status is its LAST command's**. `docker` exited 127 with
 * `No such file or directory` on stderr; `head` exited 0 with empty stdout; ssh
 * returned 0. `execSync` therefore did not throw, the empty stdout hit the
 * no-container branch, and TangleClaw reported **"No Docker container found"**
 * for a host that was running the container the whole time.
 *
 * That is the #948 shape — an unknown told as a fact — and it cost a full
 * investigation (#1012) that went looking for a browser storage bug. So this
 * module's contract is: **never report a failed command as an absent thing.**
 * Every outcome carries a distinct `code`, and a command that could not run is
 * never confused with one that ran and found nothing.
 *
 * The docker binary is resolved on the remote host rather than assumed.
 */

/** Locations to try when `command -v docker` finds nothing on a non-login shell PATH. */
const DOCKER_FALLBACK_PATHS = [
  '/usr/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '$HOME/.local/bin/docker',
  '$HOME/.docker/bin/docker'
];

/** Outcome codes. Each names a DIFFERENT thing; none of them means "and also maybe something else". */
const CODES = {
  APPROVED: 'APPROVED',
  SSH_FAILED: 'SSH_FAILED',
  DOCKER_NOT_FOUND: 'DOCKER_NOT_FOUND',
  NO_CONTAINER: 'NO_CONTAINER',
  LIST_FAILED: 'LIST_FAILED',
  NO_PENDING: 'NO_PENDING',
  MISSING_REQUEST_ID: 'MISSING_REQUEST_ID',
  APPROVE_FAILED: 'APPROVE_FAILED'
};

/**
 * Single-quote a value for safe interpolation into a POSIX shell command.
 *
 * Everything crossing into the remote shell goes through this: the container
 * name and the requestId both originate from the gateway's own output, and the
 * gateway token must never be able to terminate its own quoting.
 *
 * @param {string|number} value - Value to quote.
 * @returns {string} A single-quoted shell word.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve docker's absolute path ON THE REMOTE HOST.
 *
 * `command -v` first (honours a real PATH), then a fixed list of known install
 * locations. Emitting a sentinel rather than relying on exit status is
 * deliberate — see this module's header for how a pipeline's exit status hid
 * this failure for the previous implementation.
 *
 * @param {(cmd: string, opts?: object) => {ok: boolean, stdout: string, stderr: string, code: number}} runRemote - Remote command seam.
 * @returns {{ok: boolean, bin: string|null, code: string, detail: string|null}}
 */
function resolveDockerBin(runRemote) {
  const probe = DOCKER_FALLBACK_PATHS.map((p) => `if [ -x ${p} ]; then echo ${p}; exit 0; fi`).join('; ');
  const r = runRemote(`command -v docker 2>/dev/null || { ${probe}; exit 42; }`);

  if (!r.ok && r.code !== 42) {
    return { ok: false, bin: null, code: CODES.SSH_FAILED, detail: (r.stderr || '').trim() || `ssh exited ${r.code}` };
  }
  const bin = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!bin) {
    return {
      ok: false, bin: null, code: CODES.DOCKER_NOT_FOUND,
      detail: `docker not found on the gateway host (looked on PATH and in ${DOCKER_FALLBACK_PATHS.length} known locations)`
    };
  }
  return { ok: true, bin, code: CODES.APPROVED, detail: null };
}

/**
 * Find the gateway container publishing `port`.
 *
 * **No `| head -1`.** The previous implementation piped through `head`, which
 * made the pipeline's exit status `head`'s and swallowed docker's. The first
 * line is taken in JavaScript instead, where a non-zero status is still visible.
 *
 * @param {Function} runRemote - Remote command seam.
 * @param {string} dockerBin - Absolute path resolved by `resolveDockerBin`.
 * @param {number|string} port - Published gateway port.
 * @returns {{ok: boolean, container: string|null, code: string, detail: string|null}}
 */
function findContainer(runRemote, dockerBin, port) {
  const r = runRemote(`${dockerBin} ps --filter ${shellQuote(`publish=${port}`)} --format ${shellQuote('{{.Names}}')}`);
  if (!r.ok) {
    return { ok: false, container: null, code: CODES.LIST_FAILED, detail: (r.stderr || '').trim() || `docker ps exited ${r.code}` };
  }
  const container = (r.stdout || '').trim().split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (!container) {
    // Genuinely nothing published on that port — the ONLY case that may say so.
    return { ok: false, container: null, code: CODES.NO_CONTAINER, detail: `no container publishes port ${port}` };
  }
  return { ok: true, container, code: CODES.APPROVED, detail: null };
}

/**
 * Approve the most recent pending device-pairing request for a connection.
 *
 * Resolves docker, finds the container, lists pending devices, and approves the
 * newest. Returns a structured outcome for EVERY path — the caller renders it,
 * and the reason is never discarded.
 *
 * @param {object} opts
 * @param {Function} opts.runRemote - Runs one command on the gateway host; returns `{ok, stdout, stderr, code}`.
 * @param {number|string} opts.port - Published gateway port.
 * @param {string} opts.gatewayToken - Bearer token for `openclaw devices approve`.
 * @returns {{approved: boolean, code: string, reason: string, count: number, requestId: string|null, dockerBin: string|null}}
 */
function approvePending(opts) {
  const { runRemote, port, gatewayToken } = opts;

  const docker = resolveDockerBin(runRemote);
  if (!docker.ok) {
    return { approved: false, code: docker.code, reason: docker.detail, count: 0, requestId: null, dockerBin: null };
  }

  const found = findContainer(runRemote, docker.bin, port);
  if (!found.ok) {
    return { approved: false, code: found.code, reason: found.detail, count: 0, requestId: null, dockerBin: docker.bin };
  }

  const listed = runRemote(`${docker.bin} exec ${shellQuote(found.container)} openclaw devices list --json`);
  if (!listed.ok) {
    return {
      approved: false, code: CODES.LIST_FAILED,
      reason: (listed.stderr || '').trim() || `devices list exited ${listed.code}`,
      count: 0, requestId: null, dockerBin: docker.bin
    };
  }

  let pending;
  try {
    pending = JSON.parse(listed.stdout).pending || [];
  } catch (err) {
    return {
      approved: false, code: CODES.LIST_FAILED,
      reason: `could not parse devices list: ${err.message}`,
      count: 0, requestId: null, dockerBin: docker.bin
    };
  }

  if (pending.length === 0) {
    return { approved: false, code: CODES.NO_PENDING, reason: 'no pending pairing requests', count: 0, requestId: null, dockerBin: docker.bin };
  }

  // `openclaw devices approve --latest` is a PREVIEW (reports what it would
  // approve without approving), so the requestId must be passed positionally.
  const latest = pending.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  const requestId = latest && latest.requestId;
  if (!requestId) {
    return { approved: false, code: CODES.MISSING_REQUEST_ID, reason: 'newest pending entry has no requestId', count: pending.length, requestId: null, dockerBin: docker.bin };
  }

  const approved = runRemote(
    `${docker.bin} exec ${shellQuote(found.container)} openclaw devices approve ${shellQuote(requestId)} --token ${shellQuote(gatewayToken)} --json`,
    { secret: gatewayToken }
  );
  if (!approved.ok) {
    return {
      approved: false, code: CODES.APPROVE_FAILED,
      reason: (approved.stderr || '').trim() || `approve exited ${approved.code}`,
      count: pending.length, requestId, dockerBin: docker.bin
    };
  }

  return { approved: true, code: CODES.APPROVED, reason: 'approved', count: pending.length, requestId, dockerBin: docker.bin };
}

module.exports = { approvePending, resolveDockerBin, findContainer, shellQuote, CODES, DOCKER_FALLBACK_PATHS };
