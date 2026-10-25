#!/usr/bin/env node
'use strict';

/**
 * Run a callback against an isolated, disposable TangleClaw server instance
 * (#2596; A473-A3's isolated browser-check pass).
 *
 * **CRITICAL (#2604): a scratch server must never see the operator's real
 * `~/Documents/Projects` or their real database.** Two things make that true,
 * both done before the server's first config load (its very first request
 * reads `config.json` off disk):
 *
 *   1. `TANGLECLAW_HOME` points the whole base directory (database, config,
 *      logs, engines — `lib/tangleclaw-home.js`) at a fresh temp directory.
 *   2. A `config.json` is pre-seeded in that temp directory naming
 *      `projectsDir` as a second, separate temp directory. Without this, a
 *      fresh install's first `store.config.load()` has no `projectsDir` key
 *      and defaults to `lib/store.js`'s `LEGACY_PROJECTS_DIR`
 *      (`~/Documents/Projects`) — exactly the real directory this exists to
 *      protect.
 *
 * The server is spawned as a child `node server.js` on an OS-assigned free
 * port (never a hardcoded or `PortHub`-leased one: this is a disposable
 * process that lives for the length of one check, not a standing service),
 * polled for readiness, and killed — plus both temp directories removed —
 * whether the callback resolves or throws.
 *
 * Usage (as a library):
 *   const { withScratchServer } = require('./with-scratch-server');
 *   await withScratchServer(async ({ baseUrl, homeDir, projectsDir }) => {
 *     // drive baseUrl with a browser or fetch; homeDir/projectsDir are
 *     // the isolated temp roots, for assertions that nothing escaped them
 *   });
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server.js');

/** How long to wait for the server to answer before giving up. */
const READY_TIMEOUT_MS = 15000;
/** How often to poll while waiting. */
const READY_POLL_MS = 100;
/** How long to wait for a graceful SIGTERM exit before escalating to SIGKILL. */
const SHUTDOWN_GRACE_MS = 3000;

/**
 * Find a free TCP port by letting the OS assign one, then releasing it.
 * There is a small window in which another process could claim the same
 * port before the real spawn below — acceptable for a disposable,
 * short-lived scratch server; a standing service leases through `PortHub`
 * instead (`CLAUDE.md`'s port rules), which this explicitly is not.
 *
 * @param {object} [io] - Injection seam
 * @param {function(): import('node:net').Server} [io.createServer] - Server factory
 * @returns {Promise<number>}
 */
function freePort(io = {}) {
  const createServer = io.createServer || (() => net.createServer());
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Poll `http://127.0.0.1:<port>/` until it answers (any status code counts —
 * this only proves the process is up and listening) or the timeout elapses.
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @param {{get?: Function}} [io] - Injection seam
 * @returns {Promise<void>}
 * @throws {Error} on timeout
 */
function waitForReady(port, timeoutMs, io = {}) {
  const get = io.get || http.get;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) { reject(new Error(`scratch server on port ${port} never answered within ${timeoutMs}ms`)); return; }
        setTimeout(attempt, READY_POLL_MS);
      });
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

/**
 * Write the minimal `config.json` a fresh scratch install needs so its first
 * load never falls back to the real projects directory.
 *
 * @param {string} homeDir - The isolated `TANGLECLAW_HOME`
 * @param {string} projectsDir - The isolated projects root
 */
function seedConfig(homeDir, projectsDir) {
  fs.mkdirSync(homeDir, { recursive: true });
  const config = { setupComplete: true, projectsDir };
  fs.writeFileSync(path.join(homeDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Spawn an isolated TangleClaw server, run `fn` against it, and tear it
 * down — killing the process and removing both temp directories whether
 * `fn` resolves or throws.
 *
 * @param {function({baseUrl: string, homeDir: string, projectsDir: string}): Promise<any>} fn
 * @param {{readyTimeoutMs?: number, env?: object}} [opts]
 * @returns {Promise<any>} Whatever `fn` resolves to
 */
async function withScratchServer(fn, opts = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scratch-home-'));
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scratch-projects-'));
  seedConfig(homeDir, projectsDir);

  const port = await freePort();
  const env = {
    ...(opts.env || process.env),
    TANGLECLAW_HOME: homeDir,
    TANGLECLAW_PORT: String(port)
  };
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });

  try {
    await Promise.race([
      waitForReady(port, opts.readyTimeoutMs || READY_TIMEOUT_MS),
      exited.then((exit) => { throw new Error(`scratch server exited before answering (code ${exit.code}, signal ${exit.signal}): ${stderr.slice(-2000)}`); })
    ]);
    return await fn({ baseUrl: `http://127.0.0.1:${port}`, homeDir, projectsDir });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
}

module.exports = { withScratchServer, freePort, waitForReady, seedConfig };

if (require.main === module) {
  withScratchServer(async ({ baseUrl, homeDir, projectsDir }) => {
    process.stdout.write(`scratch server: ${baseUrl}\nhome: ${homeDir}\nprojects: ${projectsDir}\nPress Ctrl-C to stop.\n`);
    await new Promise((resolve) => process.once('SIGINT', resolve));
  }).then(() => process.exit(0)).catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
}
