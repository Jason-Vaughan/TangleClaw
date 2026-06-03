'use strict';

// #306-followup (PR B) — auto-detect an OpenClaw connection's `instanceDir`
// over SSH, so an operator doesn't have to hand TangleClaw the host path by
// hand (which is what kept the version display dark — see #306/#308).
//
// Two discovery strategies, run in one SSH round-trip and unioned:
//   1. docker compose working-dir label — if `docker` is on the SSH user's
//      PATH and usable, the `com.docker.compose.project.working_dir` label on
//      any running `*openclaw*` container is the stack directory. Most reliable.
//   2. candidate-path scan — when docker isn't reachable to the SSH user
//      (common: the gateway runs as another user, cf. #297), check a bounded
//      list of conventional locations for a `.env` declaring `OPENCLAW_IMAGE`.
//      Bounded on purpose — an unbounded `grep -r $HOME` is slow enough to hang.
//
// The discovery script is fed to a remote `sh` over stdin (not interpolated
// into the command), so it can contain any quoting without injection risk. The
// only interpolated values are host/user/keyPath, each shape-validated first.

const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');
// Shape guards for the SSH-command-interpolated fields live in the shared
// ssh-target-safety module (#314 — one source of truth, also used by the
// version reader and the /api/openclaw/test route). Re-exported below for
// back-compat with callers that reach for `openclawDetect.unsafeReason`.
const { unsafeReason } = require('./ssh-target-safety');

const log = createLogger('openclaw-detect');

// Remote discovery script — fed to `sh` via stdin, so quoting is unconstrained.
// Emits absolute stack-dir paths, one per line, deduped.
const DISCOVERY_SCRIPT = `set -u
{
  if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
    docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | while read n img rest; do
      case "$img" in
        *openclaw*)
          wd=$(docker inspect "$n" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)
          if [ -n "$wd" ]; then echo "$wd"; fi
          ;;
      esac
    done
  fi
  for d in "$HOME"/openclaw "$HOME"/workspace/openclaw "$HOME"/openclaw-* "$HOME"/*/openclaw /opt/openclaw /srv/openclaw; do
    if [ -f "$d/.env" ] && grep -q "^OPENCLAW_IMAGE=" "$d/.env" 2>/dev/null; then echo "$d"; fi
  done
} 2>/dev/null | sort -u
`;

/**
 * Build the SSH command that runs the discovery script via remote `sh`.
 * @param {object} conn - { host, sshUser, sshKeyPath }
 * @returns {string}
 */
function _buildSshCmd(conn) {
  const keyPath = String(conn.sshKeyPath || '').replace(/^~/, process.env.HOME || '');
  // `-T`: no pseudo-tty (we feed a script on stdin); `sh` reads it from stdin
  // because ssh forwards our stdin to the remote command.
  return `ssh -T -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new -i "${keyPath}" ${conn.sshUser}@${conn.host} sh`;
}

/**
 * Parse the discovery script's stdout into a deduped list of absolute dirs.
 * @param {string} out
 * @returns {string[]}
 */
function parseDirs(out) {
  if (!out || typeof out !== 'string') return [];
  return [...new Set(
    out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('/'))
  )];
}

/**
 * Detect candidate `instanceDir` values for a connection over SSH.
 * @param {object} conn - { host, sshUser, sshKeyPath }
 * @param {object} [opts]
 * @param {number} [opts.timeout] - exec timeout ms (default 15000)
 * @returns {{ dirs: string[], error: string|null }}
 */
function detectInstanceDir(conn, opts = {}) {
  const bad = unsafeReason(conn);
  if (bad) return { dirs: [], error: bad };

  const cmd = _buildSshCmd(conn);
  let out;
  try {
    out = _internal.exec(cmd, {
      input: DISCOVERY_SCRIPT,
      timeout: opts.timeout || 15000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    log.warn('instanceDir detect failed', { host: conn.host, error: err.message });
    return { dirs: [], error: `ssh detect failed: ${(err.stderr || err.message || '').toString().slice(0, 200)}` };
  }

  const dirs = parseDirs(out);
  return { dirs, error: dirs.length ? null : 'no OpenClaw stack directory found on the host' };
}

// Overridable for tests.
const _internal = { exec: execSync };

module.exports = {
  detectInstanceDir,
  parseDirs,
  unsafeReason,
  _buildSshCmd,
  DISCOVERY_SCRIPT,
  _internal
};
