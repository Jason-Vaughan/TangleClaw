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

const remote = require('./openclaw-remote');
const { createLogger } = require('./logger');
// Shape guards for the SSH-command-interpolated fields live in the shared
// ssh-target-safety module (#314 — one source of truth, also used by the
// version reader and the /api/openclaw/test route). Re-exported below for
// back-compat with callers that reach for `openclawDetect.unsafeReason`.
const { unsafeReason } = require('./ssh-target-safety');
const { expandHomePath } = require('./project-paths');

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
  const keyPath = expandHomePath(String(conn.sshKeyPath || ''));
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

// ── #128: Dockerized-vs-host detection + resource/health telemetry ──
//
// A second remote script, same shape and safety posture as DISCOVERY_SCRIPT
// above: fed to `sh` via stdin (never interpolated), one bounded SSH
// round-trip, output parsed by a pure function below. `docker stats`'s own
// CPUPerc/MemPerc columns are used directly rather than hand-computing
// percentages from cgroup files — Portainer/Lazydocker do the same, and it
// keeps the remote script free of arithmetic that would need its own tests
// against a real container to trust.

/**
 * Remote telemetry script. Emits `key=value` lines (one bounded SSH
 * round-trip, like DISCOVERY_SCRIPT), parsed by `parseRuntimeTelemetry`:
 *   mode=docker|host
 *   cpuPct=<number>              (docker: CPUPerc; host: ps %cpu)
 *   memPct=<number>               (docker: MemPerc; host: ps %mem)
 *   memUsage=<"USED / LIMIT">     (docker only, human units — parsed in JS)
 *   memUsedBytes=<number>         (host only — ps RSS, already in kB * 1024)
 *   containerHealthy=true|false   (docker only, when the container defines a HEALTHCHECK)
 *   stuckSessions=<number>        ([diagnostic] stuck session log lines, last 5 min)
 *   lockHoldCount=<number>        ([session-write-lock] releasing lock held for Nms log lines, last 5 min)
 *   lockHoldMaxMs=<number>        (the largest N among those lines)
 * @type {string}
 */
const RUNTIME_STATS_SCRIPT = `set -u
cid=""
if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
  cid=$(docker ps --format '{{.ID}} {{.Image}}' 2>/dev/null | awk '$2 ~ /openclaw/ {print $1; exit}')
fi
if [ -n "$cid" ]; then
  echo "mode=docker"
  docker stats --no-stream --format '{{.CPUPerc}}|{{.MemPerc}}|{{.MemUsage}}' "$cid" 2>/dev/null | \
    awk -F'|' '{ gsub(/%/,"",$1); gsub(/%/,"",$2); print "cpuPct=" $1; print "memPct=" $2; print "memUsage=" $3 }'
  h=$(docker inspect "$cid" --format '{{.State.Health.Status}}' 2>/dev/null)
  case "$h" in
    healthy) echo "containerHealthy=true" ;;
    unhealthy) echo "containerHealthy=false" ;;
  esac
  logs=$(docker logs --since 5m "$cid" 2>/dev/null)
  echo "stuckSessions=$(printf '%s\\n' "$logs" | grep -c '\\[diagnostic\\] stuck session' 2>/dev/null || echo 0)"
  echo "lockHoldCount=$(printf '%s\\n' "$logs" | grep -c 'releasing lock held for' 2>/dev/null || echo 0)"
  echo "lockHoldMaxMs=$(printf '%s\\n' "$logs" | grep -o 'releasing lock held for [0-9]*ms' 2>/dev/null | grep -o '[0-9]*' | sort -rn | head -1)"
else
  echo "mode=host"
  pid=$(pgrep -f openclaw 2>/dev/null | head -1)
  if [ -n "$pid" ]; then
    ps -o pcpu=,pmem=,rss= -p "$pid" 2>/dev/null | awk '{ print "cpuPct=" $1; print "memPct=" $2; print "memUsedBytes=" ($3*1024) }'
  fi
fi
`;

/**
 * Parse one `VALUE / LIMIT`-shaped docker `MemUsage` string (e.g.
 * `"104.9MiB / 536.9MiB"`) into `{ usedBytes, limitBytes }`. Docker emits
 * binary units (`KiB`/`MiB`/`GiB`); decimal `KB`/`MB`/`GB` are accepted too
 * in case a future docker version changes format. Returns `null` for either
 * side it cannot parse, rather than throwing.
 * @param {string} raw
 * @returns {{usedBytes: number|null, limitBytes: number|null}}
 */
function _parseMemUsage(raw) {
  if (typeof raw !== 'string' || !raw.includes('/')) return { usedBytes: null, limitBytes: null };
  const [usedRaw, limitRaw] = raw.split('/').map((s) => s.trim());
  return { usedBytes: _parseByteSize(usedRaw), limitBytes: _parseByteSize(limitRaw) };
}

/**
 * Parse one human byte-size token (`"104.9MiB"`, `"1.2GB"`, `"512B"`) to a
 * byte count. Binary (`KiB`/`MiB`/`GiB`/`TiB`) and decimal (`KB`/`MB`/`GB`/`TB`)
 * units both accepted, case-insensitively. Returns `null` on anything that
 * doesn't match, rather than `NaN` silently propagating into a comparison.
 * @param {string} token
 * @returns {number|null}
 */
function _parseByteSize(token) {
  if (typeof token !== 'string') return null;
  const m = token.trim().match(/^([\d.]+)\s*([KMGT]?I?B)$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const mult = {
    B: 1,
    KB: 1000, KIB: 1024,
    MB: 1000 ** 2, MIB: 1024 ** 2,
    GB: 1000 ** 3, GIB: 1024 ** 3,
    TB: 1000 ** 4, TIB: 1024 ** 4
  }[m[2].toUpperCase()];
  return typeof mult === 'number' ? Math.round(value * mult) : null;
}

/**
 * Parse `RUNTIME_STATS_SCRIPT`'s `key=value` output into a telemetry object.
 * Never throws — an empty, truncated, or garbled probe yields `mode:
 * 'unknown'` and `null`/`0` fields rather than a parse error, since the
 * caller (`detectRuntimeAndStats`) must still be able to report SOMETHING.
 * @param {string} raw - The script's stdout.
 * @returns {{mode: 'docker'|'host'|'unknown', cpuPct: number|null, memUsedBytes: number|null,
 *   memLimitBytes: number|null, memPct: number|null, stuckSessions: number, lockHoldMaxMs: number,
 *   lockHoldCount: number, containerHealthy: boolean|null}}
 */
function parseRuntimeTelemetry(raw) {
  const fields = {};
  if (typeof raw === 'string') {
    for (const line of raw.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }

  const mode = fields.mode === 'docker' || fields.mode === 'host' ? fields.mode : 'unknown';
  const cpuPct = fields.cpuPct !== undefined && fields.cpuPct !== '' ? parseFloat(fields.cpuPct) : null;
  let memPct = fields.memPct !== undefined && fields.memPct !== '' ? parseFloat(fields.memPct) : null;
  let memUsedBytes = null;
  let memLimitBytes = null;

  if (fields.memUsage) {
    const parsed = _parseMemUsage(fields.memUsage);
    memUsedBytes = parsed.usedBytes;
    memLimitBytes = parsed.limitBytes;
  }
  if (fields.memUsedBytes !== undefined && fields.memUsedBytes !== '') {
    const n = parseFloat(fields.memUsedBytes);
    if (Number.isFinite(n)) memUsedBytes = Math.round(n);
  }

  return {
    mode,
    cpuPct: Number.isFinite(cpuPct) ? cpuPct : null,
    memUsedBytes,
    memLimitBytes,
    memPct: Number.isFinite(memPct) ? memPct : null,
    stuckSessions: Number.isFinite(parseInt(fields.stuckSessions, 10)) ? parseInt(fields.stuckSessions, 10) : 0,
    lockHoldMaxMs: Number.isFinite(parseInt(fields.lockHoldMaxMs, 10)) ? parseInt(fields.lockHoldMaxMs, 10) : 0,
    lockHoldCount: Number.isFinite(parseInt(fields.lockHoldCount, 10)) ? parseInt(fields.lockHoldCount, 10) : 0,
    containerHealthy: fields.containerHealthy === 'true' ? true : (fields.containerHealthy === 'false' ? false : null)
  };
}

/**
 * The default resource/health thresholds (#128 acceptance #5).
 * @type {{warnCpuPct: number, alarmCpuPct: number, warnMemPct: number, alarmMemPct: number}}
 */
const DEFAULT_HEALTH_THRESHOLDS = Object.freeze({ warnCpuPct: 60, alarmCpuPct: 90, warnMemPct: 80, alarmMemPct: 95 });

/**
 * Reduce parsed telemetry to one health level, per #128's acceptance
 * criteria #5: `alarm` wins over `warn` whenever both would otherwise apply
 * — an operator checking the pill should see the worst thing that's true,
 * not whichever rule happened to run last.
 * @param {ReturnType<typeof parseRuntimeTelemetry>} telemetry
 * @param {{warnCpuPct: number, alarmCpuPct: number, warnMemPct: number, alarmMemPct: number}} [thresholds]
 * @returns {{level: 'ok'|'warn'|'alarm'|'unverified', resourceSummary: string, healthSummary: string, reasons: string[]}}
 */
function evaluateOpenclawHealth(telemetry, thresholds) {
  // I-Gate Round 1 Finding 2 (#5799301385): `mode=host\n`/`mode=docker\n`
  // with no metric lines (no process found, or Docker stats errored with
  // no output) parsed to null CPU/memory, which fell through every alarm/
  // warn check below and read as 'ok' — a failed or empty measurement
  // rendering as a green "Healthy" pill is actively misleading, worse than
  // showing nothing. Nothing was measured here; say so, rather than guess.
  if (!telemetry || telemetry.mode === 'unknown'
      || (telemetry.cpuPct === null && telemetry.memPct === null && telemetry.memUsedBytes === null)) {
    return {
      level: 'unverified',
      resourceSummary: 'unavailable',
      healthSummary: 'telemetry unavailable',
      reasons: ['no runtime metrics measured']
    };
  }
  const t = telemetry || {};
  const th = thresholds || DEFAULT_HEALTH_THRESHOLDS;
  const alarmReasons = [];
  const warnReasons = [];

  if (typeof t.cpuPct === 'number' && t.cpuPct > th.alarmCpuPct) alarmReasons.push(`CPU ${t.cpuPct}% > ${th.alarmCpuPct}%`);
  if (typeof t.memPct === 'number' && t.memPct > th.alarmMemPct) alarmReasons.push(`memory ${t.memPct}% > ${th.alarmMemPct}%`);
  if (typeof t.lockHoldCount === 'number' && t.lockHoldCount > 0) alarmReasons.push(`${t.lockHoldCount} lock hold(s) over max`);
  if (t.containerHealthy === false) alarmReasons.push('container reports unhealthy');

  if (typeof t.cpuPct === 'number' && t.cpuPct > th.warnCpuPct) warnReasons.push(`CPU ${t.cpuPct}% > ${th.warnCpuPct}%`);
  if (typeof t.memPct === 'number' && t.memPct > th.warnMemPct) warnReasons.push(`memory ${t.memPct}% > ${th.warnMemPct}%`);
  if (typeof t.stuckSessions === 'number' && t.stuckSessions > 0) warnReasons.push(`${t.stuckSessions} stuck session(s)`);

  const level = alarmReasons.length ? 'alarm' : (warnReasons.length ? 'warn' : 'ok');
  const reasons = alarmReasons.length ? alarmReasons : warnReasons;

  const resourceSummary = (typeof t.cpuPct === 'number' && typeof t.memPct === 'number')
    ? `CPU ${t.cpuPct}% · Mem ${t.memPct}%`
    : 'resource data unavailable';
  const healthSummary = reasons.length ? reasons.join('; ') : 'no pathology detected';

  return { level, resourceSummary, healthSummary, reasons };
}

/**
 * Detect whether a connection's OpenClaw is Dockerized or host-installed,
 * and read its resource + health telemetry, in one bounded SSH round-trip
 * (#128). Mirrors `detectInstanceDir`'s shape and safety posture exactly —
 * same `unsafeReason` shape guard, same `_internal.exec` seam, same
 * never-throw contract.
 * @param {object} conn - { host, sshUser, sshKeyPath }
 * @param {object} [opts]
 * @param {number} [opts.timeout] - exec timeout ms (default 15000)
 * @param {{warnCpuPct: number, alarmCpuPct: number, warnMemPct: number, alarmMemPct: number}} [opts.thresholds]
 * @returns {Promise<{mode: 'docker'|'host'|'unknown', telemetry: object|null, health: object|null, error: string|null}>}
 */
async function detectRuntimeAndStats(conn, opts = {}) {
  const bad = unsafeReason(conn);
  if (bad) return { mode: 'unknown', telemetry: null, health: null, error: bad };

  const cmd = _buildSshCmd(conn);
  let out;
  try {
    out = await _internal.exec(cmd, {
      input: RUNTIME_STATS_SCRIPT,
      timeout: opts.timeout || 15000
    });
  } catch (err) {
    log.warn('runtime stats detect failed', { host: conn.host, error: err.message });
    return { mode: 'unknown', telemetry: null, health: null, error: `ssh stats failed: ${(err.stderr || err.message || '').toString().slice(0, 200)}` };
  }

  const telemetry = parseRuntimeTelemetry(out);
  const health = evaluateOpenclawHealth(telemetry, opts.thresholds);
  return { mode: telemetry.mode, telemetry, health, error: null };
}

/**
 * Detect candidate `instanceDir` values for a connection over SSH.
 * @param {object} conn - { host, sshUser, sshKeyPath }
 * @param {object} [opts]
 * @param {number} [opts.timeout] - exec timeout ms (default 15000)
 * @returns {Promise<{ dirs: string[], error: string|null }>}
 */
async function detectInstanceDir(conn, opts = {}) {
  const bad = unsafeReason(conn);
  if (bad) return { dirs: [], error: bad };

  const cmd = _buildSshCmd(conn);
  let out;
  try {
    out = await _internal.exec(cmd, {
      input: DISCOVERY_SCRIPT,
      timeout: opts.timeout || 15000
    });
  } catch (err) {
    log.warn('instanceDir detect failed', { host: conn.host, error: err.message });
    return { dirs: [], error: `ssh detect failed: ${(err.stderr || err.message || '').toString().slice(0, 200)}` };
  }

  const dirs = parseDirs(out);
  return { dirs, error: dirs.length ? null : 'no OpenClaw stack directory found on the host' };
}

// Overridable for tests.
/**
 * Run the discovery command with the script on stdin, off the event loop.
 * @param {string} cmd
 * @param {{input: string, timeout: number}} opts
 * @returns {Promise<string>} Stdout; rejects with an error carrying `stderr`.
 */
async function _exec(cmd, opts) {
  const { stdout } = await remote.runShell(cmd, { input: opts.input, timeout: opts.timeout });
  return stdout;
}

const _internal = { exec: _exec };

module.exports = {
  detectInstanceDir,
  parseDirs,
  unsafeReason,
  _buildSshCmd,
  DISCOVERY_SCRIPT,
  // #128
  DEFAULT_HEALTH_THRESHOLDS,
  parseRuntimeTelemetry,
  evaluateOpenclawHealth,
  detectRuntimeAndStats,
  RUNTIME_STATS_SCRIPT,
  _internal
};
