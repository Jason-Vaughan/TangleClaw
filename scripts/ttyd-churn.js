#!/usr/bin/env node
'use strict';

/**
 * The ttyd churn harness (#1245). Starts a SCRATCH ttyd on its own unix socket,
 * attached to a SCRATCH tmux server, opens and closes websocket clients against
 * it in every way a browser tab can go away, and measures whether ttyd is left
 * with children stuck in the exiting state. The live ttyd, the live tmux server
 * and the TangleClaw service are never touched: the scratch tmux is reached only
 * through a shim that pins `tmux -L <unique name>` with its own TMUX_TMPDIR, and
 * cleanup kills exact PIDs this run started, never by name.
 *
 * Usage:
 *   node scripts/ttyd-churn.js --mode baseline|control|candidate
 *     [--cycles N] [--soak-minutes M] [--concurrency C]
 *     [--ttyd-bin PATH] [--attach-script PATH] [--out DIR] [--preflight-only]
 *     [--modes clean,abrupt,paused,replay,noread]
 *
 *   baseline   the installed ttyd + the shipped attach script; expected to reproduce
 *   control    the scratch ttyd runs `cat` (no output), which must show no wedges
 *   candidate  a fix under test (--ttyd-bin and/or --attach-script); must meet R22 Q7
 *
 * The decisions (preflight, stop lines, verdicts) live in lib/ttyd-churn.js.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const churn = require('../lib/ttyd-churn');
const { _parseChildren, _poolFromCounts } = require('../lib/ttyd-watcher');
const { WsUnixClient } = require('../lib/ws-unix-client');

const SAMPLE_MS = 250;
const SOAK_SAMPLE_MS = 10 * 1000;
const FIRST_OUTPUT_TIMEOUT_MS = 3000;
const SOCKET_WAIT_MS = 5000;
const KILL_GRACE_MS = 3000;

/**
 * Parse the command line.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {object} Options.
 */
function parseArgs(argv) {
  const o = { mode: null, cycles: null, soakMinutes: 0, concurrency: churn.MAX_CONCURRENCY, ttydBin: null, attachScript: null, out: null, preflightOnly: false, modes: [...churn.CLOSE_MODES] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--mode') o.mode = next();
    else if (a === '--cycles') o.cycles = Number(next());
    else if (a === '--soak-minutes') o.soakMinutes = Number(next());
    else if (a === '--concurrency') o.concurrency = Number(next());
    else if (a === '--ttyd-bin') o.ttydBin = next();
    else if (a === '--attach-script') o.attachScript = next();
    else if (a === '--out') o.out = next();
    else if (a === '--preflight-only') o.preflightOnly = true;
    else if (a === '--modes') o.modes = String(next()).split(',').filter(Boolean);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['baseline', 'control', 'candidate'].includes(o.mode)) throw new Error('--mode must be baseline, control or candidate');
  if (o.cycles === null) o.cycles = o.mode === 'candidate' ? churn.ACCEPT_CYCLES : 500;
  if (!Number.isInteger(o.cycles) || o.cycles < 1) throw new Error('--cycles must be a positive integer');
  if (!(o.soakMinutes >= 0)) throw new Error('--soak-minutes must be zero or more');
  if (o.modes.length === 0 || o.modes.some((m) => !churn.CLOSE_MODES.includes(m))) {
    throw new Error(`--modes must be a comma-separated subset of ${churn.CLOSE_MODES.join(',')}`);
  }
  return o;
}

/**
 * Run a command and resolve its stdout.
 * @param {string} cmd - Executable.
 * @param {string[]} args - Arguments.
 * @param {object} [opts] - `execFile` options.
 * @returns {Promise<string>}
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 10000, ...opts }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * The path if it is an executable file, else null.
 * @param {string|null} p - Candidate path.
 * @returns {string|null}
 */
function executable(p) {
  if (!p) return null;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a binary on PATH.
 * @param {string} name - Binary name.
 * @returns {Promise<string|null>}
 */
async function which(name) {
  try {
    return (await run('/bin/sh', ['-c', `command -v ${name}`])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read the global PTY pool.
 * @returns {Promise<{used: number, cap: number}|null>}
 */
async function readPool() {
  try {
    const cap = parseInt(await run('sysctl', ['-n', 'kern.tty.ptmx_max']), 10);
    const used = parseInt(await run('sh', ['-c', 'ls /dev/ttys* 2>/dev/null | wc -l']), 10);
    const pool = _poolFromCounts(cap, used, 1);
    return pool ? { used: pool.used, cap: pool.cap } : null;
  } catch {
    return null;
  }
}

/**
 * Read the live health panel's ttyd row state, read-only.
 * @returns {Promise<string|null>} `clear` / `fired` / `unknown`, or null if unreadable.
 */
async function readLiveTtydState() {
  const api = process.env.TANGLECLAW_API;
  if (!api) return null;
  try {
    const body = JSON.parse(await run('curl', ['-sk', '--max-time', '10', `${api.replace(/\/$/, '')}/api/system/health`]));
    const row = (body.conditions || []).find((c) => c.id === 'ttyd-leak');
    return row ? row.state : null;
  } catch {
    return null;
  }
}

/**
 * The scratch ttyd's direct children.
 * @param {number} ttydPid - Scratch ttyd PID.
 * @returns {Promise<Array<{pid: number, stat: string, ageMs: number|null}>|null>}
 */
async function readChildren(ttydPid) {
  try {
    return _parseChildren(await run('ps', ['-A', '-o', 'pid=,ppid=,stat=,etime=']), ttydPid);
  } catch {
    return null;
  }
}

/**
 * The scratch ttyd's open file descriptor count.
 * @param {number} ttydPid - Scratch ttyd PID.
 * @returns {Promise<number|null>}
 */
async function readFds(ttydPid) {
  try {
    const out = await run('lsof', ['-p', String(ttydPid)]);
    return Math.max(0, out.trim().split('\n').length - 1);
  } catch {
    return null;
  }
}

/**
 * Whether a PID is alive.
 * @param {number} pid - PID.
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sleep.
 * @param {number} ms - Milliseconds.
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lay out the scratch directory: the tmux shim, the tmux config, the output
 * generator and the attach script under test.
 * @param {object} o - Options.
 * @param {string} dir - Scratch directory.
 * @param {string} tmuxBin - Real tmux.
 * @param {string} tmuxName - Unique `-L` name.
 * @param {string} repoRoot - Repository root.
 * @returns {{shim: string, attach: string, env: object}}
 */
function layout(o, dir, tmuxBin, tmuxName, repoRoot) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tmux'), { recursive: true });
  const shim = path.join(dir, 'bin', 'tmux');
  // Every tmux call the attach script makes lands on the scratch server.
  fs.writeFileSync(shim, `#!/bin/sh\nexec '${tmuxBin}' -L '${tmuxName}' -f '${path.join(dir, 'tmux.conf')}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'tmux.conf'), 'set -g history-limit 10000\n');
  // Output the way a busy pane makes it: scrollback to replay, then a steady stream.
  fs.writeFileSync(path.join(dir, 'generator.sh'),
    '#!/bin/sh\nseq 1 9000\nwhile :; do seq 1 40; sleep 0.02; done\n', { mode: 0o755 });
  const attach = path.join(dir, 'attach.sh');
  if (o.mode === 'control') {
    // A child that writes nothing: if output queued at close is what wedges,
    // this must never wedge, and a wedge here is the harness's own.
    fs.writeFileSync(attach, '#!/bin/sh\nexec cat\n', { mode: 0o755 });
  } else {
    fs.copyFileSync(o.attachScript || path.join(repoRoot, 'deploy', 'ttyd-attach.sh'), attach);
    fs.chmodSync(attach, 0o755);
  }
  const env = { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, TMUX_TMPDIR: path.join(dir, 'tmux') };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return { shim, attach, env };
}

/**
 * One websocket client, closed the way `mode` names.
 * @param {string} sock - Scratch ttyd socket.
 * @param {string} mode - One of `churn.CLOSE_MODES`.
 * @returns {Promise<boolean>} Whether ttyd sent terminal output before the close.
 */
async function oneClient(sock, mode) {
  const c = new WsUnixClient(sock, { path: '/ws?arg=churn', protocol: 'tty', handshakeTimeoutMs: 5000 });
  c.on('error', () => {});
  let gotOutput = false;
  const firstOutput = new Promise((resolve) => {
    c.on('message', (m) => {
      if (!gotOutput && m[0] === '0') { gotOutput = true; resolve(); }
    });
  });
  await c.connect();
  c.send(JSON.stringify({ AuthToken: '', columns: 120, rows: 40 }));
  const outputOrTimeout = () => Promise.race([firstOutput, sleep(FIRST_OUTPUT_TIMEOUT_MS)]);
  if (mode === 'noread') {
    // Stop reading entirely: ttyd's writes back up while the pane keeps printing.
    c.socket.pause();
    await sleep(2000);
    c.socket.destroy();
  } else if (mode === 'replay') {
    // Close on the first output byte, while the scrollback replay is still streaming.
    await outputOrTimeout();
    c.socket.destroy();
  } else {
    await outputOrTimeout();
    await sleep(200);
    if (mode === 'paused') {
      c.send('2');
      await sleep(500);
      c.socket.destroy();
    } else if (mode === 'abrupt') {
      c.socket.destroy();
    } else {
      c.close();
    }
  }
  return gotOutput;
}

/**
 * Stop the scratch processes this run started, by exact PID, and verify.
 * @param {object} s - Run state.
 * @returns {Promise<{ok: boolean, leftovers: string[]}>}
 */
async function cleanup(s) {
  const leftovers = [];
  if (s.ttydPid && alive(s.ttydPid)) {
    process.kill(s.ttydPid, 'SIGTERM');
    const deadline = Date.now() + KILL_GRACE_MS;
    while (alive(s.ttydPid) && Date.now() < deadline) await sleep(100);
    if (alive(s.ttydPid)) process.kill(s.ttydPid, 'SIGKILL');
    await sleep(300);
    if (alive(s.ttydPid)) leftovers.push(`scratch ttyd ${s.ttydPid}`);
  }
  if (s.shim) {
    try { await run(s.shim, ['kill-server'], { env: s.env }); } catch { /* already gone */ }
    try {
      await run(s.shim, ['has-session'], { env: s.env });
      leftovers.push(`scratch tmux server ${s.tmuxName}`);
    } catch { /* gone, as intended */ }
  }
  if (s.ttydPid) {
    const orphans = await readChildren(s.ttydPid);
    if (orphans === null) leftovers.push('could not verify the scratch ttyd\'s children are gone');
    else if (orphans.length) leftovers.push(`${orphans.length} processes still parented by the scratch ttyd`);
  }
  return { ok: leftovers.length === 0, leftovers };
}

/**
 * Run the harness.
 * @param {object} o - Options.
 * @returns {Promise<object>} The report.
 */
async function main(o) {
  const repoRoot = path.resolve(__dirname, '..');
  const runId = Date.now().toString(36);
  // Short on purpose: a unix socket path is limited to 104 bytes on macOS, and
  // `os.tmpdir()` there is ~50 bytes before tmux adds `tmux-<uid>/<name>`.
  const dir = o.out || path.join('/tmp', `tcc-${runId}`);
  const sock = path.join(dir, 'ttyd.sock');
  // Checked as executables, not just as strings: a wrong --ttyd-bin must be
  // refused here, before a scratch tmux server exists to be orphaned.
  const ttydBin = executable(o.ttydBin || await which('ttyd'));
  const tmuxBin = executable(await which('tmux'));
  const basePool = await readPool();
  const facts = {
    platform: process.platform,
    ttydLeakState: await readLiveTtydState(),
    pool: basePool,
    socketInUse: fs.existsSync(sock),
    ttydBin,
    tmuxBin,
    concurrency: o.concurrency
  };
  const pre = churn.checkPreflight(facts);
  console.log(JSON.stringify({ preflight: { ...pre, facts, dir } }, null, 2));
  if (!pre.ok || o.preflightOnly) return { preflight: pre };

  const s = { tmuxName: `tcc-${runId}`, ttydPid: null, shim: null, env: null };
  const report = { runId, mode: o.mode, modes: o.modes, dir, ttydBin, attachScript: o.mode === 'control' ? 'exec cat' : (o.attachScript || 'deploy/ttyd-attach.sh'), startedAt: new Date().toISOString() };
  const tracker = new churn.LifetimeTracker();
  let sampler = null;
  let exitedEarly = false;
  // An interrupted run must not leave its scratch ttyd, tmux server or output
  // loop behind: the loop holds a PTY and prints every 20 ms forever.
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    if (sampler) clearInterval(sampler);
    cleanup(s).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const l = layout(o, dir, tmuxBin, s.tmuxName, repoRoot);
    Object.assign(s, { shim: l.shim, env: l.env });
    await run(l.shim, ['new-session', '-d', '-s', 'churn', '-x', '120', '-y', '40', '-c', dir, path.join(dir, 'generator.sh')], { env: l.env });

    const ttyd = spawn(ttydBin, ['--writable', '--url-arg', '--interface', sock, '--port', '0',
      '--client-option', 'scrollback=10000', l.attach], { env: l.env, stdio: ['ignore', 'ignore', fs.openSync(path.join(dir, 'ttyd.log'), 'a')] });
    s.ttydPid = ttyd.pid;
    ttyd.on('exit', () => { exitedEarly = true; });
    ttyd.on('error', () => { exitedEarly = true; });
    const socketDeadline = Date.now() + SOCKET_WAIT_MS;
    while (!fs.existsSync(sock) && Date.now() < socketDeadline) await sleep(50);
    if (!fs.existsSync(sock)) throw new Error('the scratch ttyd did not create its socket');

    report.baseline = { pool: basePool, fds: await readFds(s.ttydPid) };
    let latest = [];
    let sampling = false;
    let maxChildren = 0;
    sampler = setInterval(async () => {
      if (sampling) return;
      sampling = true;
      const kids = await readChildren(s.ttydPid);
      sampling = false;
      latest = kids;
      if (kids) {
        tracker.observe(kids, Date.now());
        maxChildren = Math.max(maxChildren, kids.length);
      }
    }, SAMPLE_MS);

    let cycles = 0;
    let withOutput = 0;
    let clientErrors = 0;
    let stop = 'completed';
    let peakPool = basePool;
    let maxWedges = 0;
    const between = async () => {
      const pool = await readPool();
      if (pool && (!peakPool || pool.used > peakPool.used)) peakPool = pool;
      // Wedges are children SEEN exiting for the floor, from the sampler's own
      // first sighting. A failed ps read leaves the run blind.
      const wedges = latest === null ? null : churn.countWedges(tracker.stillOpen(Date.now()));
      if (wedges !== null) maxWedges = Math.max(maxWedges, wedges);
      if (exitedEarly) return 'aborted-unmeasured';
      return churn.nextStep({ wedges, pool });
    };
    while (cycles < o.cycles) {
      const n = Math.min(o.concurrency, o.cycles - cycles);
      const results = await Promise.allSettled(Array.from({ length: n }, (_, i) =>
        oneClient(sock, o.modes[(cycles + i) % o.modes.length])));
      for (const r of results) {
        if (r.status === 'fulfilled') { if (r.value) withOutput++; } else clientErrors++;
      }
      cycles += n;
      const step = await between();
      if (step !== 'continue') { stop = step; break; }
    }

    // Quiet time: let every client's child finish exiting (or not), then the
    // soak. A reproduced run is watched for the same window before ttyd is
    // killed, so "never exited" is a claim about 30 s, not about one sample.
    // Only a run stopped at the pool limit or blind skips it.
    const soakMs = stop === 'completed' ? o.soakMinutes * 60 * 1000 : 0;
    const quietUntil = Date.now() + churn.RETURN_WINDOW_MS + soakMs;
    while ((stop === 'completed' || stop === 'reproduced') && Date.now() < quietUntil) {
      await sleep(Math.min(SOAK_SAMPLE_MS, Math.max(0, quietUntil - Date.now())));
      const step = await between();
      if (step === 'aborted-pool' || step === 'aborted-unmeasured') stop = step;
      else if (step === 'reproduced' && stop === 'completed') stop = step;
    }
    clearInterval(sampler);
    sampler = null;
    const final = { pool: await readPool(), fds: await readFds(s.ttydPid), children: await readChildren(s.ttydPid) };
    maxWedges = Math.max(maxWedges, churn.countWedges(tracker.stillOpen(Date.now())));

    report.run = {
      cycles, withOutput, clientErrors, stop, maxChildren, confirmedWedges: maxWedges,
      // Every client has closed by now, so any child left is one ttyd never reaped.
      lingering: final.children === null ? null : final.children.length,
      lingeringStates: final.children === null ? null : final.children.map((c) => c.stat),
      transientLifetimesMs: churn.percentiles(tracker.lifetimes),
      stillExitingMs: tracker.stillOpen(Date.now()),
      pool: { baseline: basePool, peak: peakPool, final: final.pool },
      fds: { baseline: report.baseline.fds, final: final.fds },
      restarts: exitedEarly ? 1 : 0,
      soakMs: stop === 'completed' ? soakMs : 0
    };
  } finally {
    if (sampler) clearInterval(sampler);
    report.cleanup = await cleanup(s);
    report.afterCleanup = { pool: await readPool() };
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  if (report.run) {
    const r = report.run;
    const poolReturned = churn.returned(r.pool.baseline && r.pool.baseline.used, r.pool.final && r.pool.final.used, churn.POOL_TOLERANCE);
    const fdsReturned = churn.returned(r.fds.baseline, r.fds.final, churn.FD_TOLERANCE);
    const cleanupPool = churn.returned(r.pool.baseline && r.pool.baseline.used, report.afterCleanup.pool && report.afterCleanup.pool.used, churn.POOL_TOLERANCE);
    if (cleanupPool === false) report.cleanup.leftovers.push('the global PTY pool did not return to baseline after cleanup');
    report.cleanup.ok = report.cleanup.leftovers.length === 0;
    report.verdict = churn.verdict({
      mode: o.mode, stop: r.stop, cycles: r.cycles, soakMs: r.soakMs, confirmedWedges: r.confirmedWedges,
      restarts: r.restarts, clientErrors: r.clientErrors, withOutput: r.withOutput, lingering: r.lingering,
      poolReturned, fdsReturned, cleanupOk: report.cleanup.ok
    });
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: report.verdict, run: report.run, cleanup: report.cleanup, afterCleanup: report.afterCleanup, report: path.join(dir, 'report.json') }, null, 2));
  return report;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  main(opts).then(
    (report) => {
      // 3: refused at preflight. 0: preflight-only passed, or the run earned the
      // verdict its mode is for. 1: anything else.
      if (report.preflight) process.exit(report.preflight.ok ? 0 : 3);
      const v = report.verdict && report.verdict.verdict;
      process.exit(v === 'pass' || v === 'reproduced' ? 0 : 1);
    },
    (err) => {
      console.error(`ttyd-churn failed: ${err.stack || err.message}`);
      process.exit(1);
    }
  );
}

module.exports = { parseArgs };
