'use strict';

/*
 * `scripts/with-scratch-server.js` (#2596, A473-A3's isolated browser-check
 * pass).
 *
 * The one property that matters most: a scratch server must never see the
 * operator's real `~/Documents/Projects` or real database (#2604). The
 * "real server up and answering" tests here spawn an actual child process
 * and do real network I/O, so they belong in the medium tier, not small.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execSync } = require('node:child_process');

const scratch = require('../scripts/with-scratch-server');

/**
 * Find a process whose PPID is `parentPid` and whose command line mentions
 * `needle`, by shelling out to `ps` -- this test needs to find the real OS
 * child the harness (not this test) spawned, so there is no API to ask
 * instead.
 * @param {number} parentPid
 * @param {string} needle
 * @returns {number|null}
 */
function findChildPid(parentPid, needle) {
  const out = execSync('ps -Ao pid,ppid,command').toString();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, command] = m;
    if (Number(ppid) === parentPid && command.includes(needle)) return Number(pid);
  }
  return null;
}

/**
 * Whether a pid is still alive, probed with signal 0 (sends nothing, just
 * checks permission/existence).
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * GET a URL and parse the body as JSON.
 * @param {string} url
 * @returns {Promise<any>}
 */
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

describe('seedConfig', () => {
  it('writes a config.json naming the isolated projectsDir and setupComplete true', () => {
    const homeDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tc-scratch-seed-test-'));
    try {
      scratch.seedConfig(homeDir, '/some/isolated/projects');
      const written = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'));
      assert.equal(written.projectsDir, '/some/isolated/projects');
      assert.equal(written.setupComplete, true);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('freePort', () => {
  it('resolves a port number and releases the probe socket', async () => {
    const port = await scratch.freePort();
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  });
});

describe('waitForReady', () => {
  it('resolves once a listener answers, whatever its status code', async () => {
    const http2 = require('node:http');
    const srv = http2.createServer((req, res) => { res.writeHead(404); res.end(); });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    try {
      await scratch.waitForReady(port, 2000);
    } finally {
      srv.close();
    }
  });

  it('rejects on timeout when nothing is listening', async () => {
    // A port nothing listens on; connection refused every attempt.
    const deadPort = await scratch.freePort();
    await assert.rejects(
      () => scratch.waitForReady(deadPort, 300),
      /never answered within 300ms/
    );
  });
});

describe('withScratchServer: a real isolated server, start to finish', () => {
  it('spawns, answers, reports its own isolated projectsDir, and cleans up on success', async () => {
    let seenHomeDir;
    let seenProjectsDir;
    const result = await scratch.withScratchServer(async ({ baseUrl, homeDir, projectsDir }) => {
      seenHomeDir = homeDir;
      seenProjectsDir = projectsDir;
      assert.ok(fs.existsSync(homeDir), 'homeDir must exist while the callback runs');
      assert.ok(fs.existsSync(projectsDir), 'projectsDir must exist while the callback runs');
      assert.notEqual(projectsDir, '~/Documents/Projects');

      const config = await getJson(`${baseUrl}/api/config`);
      // The deciding assertion (#2604): the server's OWN reported config,
      // not just the file this helper wrote, names the isolated directory.
      assert.equal(config.projectsDir, projectsDir, 'the running server must report the isolated projectsDir, proving it actually loaded it');
      return 'callback-return-value';
    });
    assert.equal(result, 'callback-return-value', 'withScratchServer resolves to the callback\'s own return value');
    assert.equal(fs.existsSync(seenHomeDir), false, 'homeDir must be removed after teardown');
    assert.equal(fs.existsSync(seenProjectsDir), false, 'projectsDir must be removed after teardown');
  });

  it('tears down (process killed, temp dirs removed) even when the callback throws', async () => {
    let seenHomeDir;
    await assert.rejects(
      scratch.withScratchServer(async ({ homeDir }) => {
        seenHomeDir = homeDir;
        throw new Error('deliberate callback failure');
      }),
      /deliberate callback failure/
    );
    assert.equal(fs.existsSync(seenHomeDir), false, 'homeDir must still be removed after a thrown callback');
  });

  it('each run gets its own fresh, distinct temp directories', async () => {
    const seen = [];
    for (let i = 0; i < 2; i++) {
      await scratch.withScratchServer(async ({ homeDir, projectsDir }) => {
        seen.push({ homeDir, projectsDir });
      });
    }
    assert.notEqual(seen[0].homeDir, seen[1].homeDir);
    assert.notEqual(seen[0].projectsDir, seen[1].projectsDir);
  });
});

describe('withScratchServer: orphan self-termination (#3315)', () => {
  it('the scratch server.js child self-terminates within a few seconds when its harness is SIGKILLed', async () => {
    // A minimal helper process that itself calls the real withScratchServer
    // and then parks forever -- simulating the actual harness this bug
    // comes from. SIGKILLing THIS helper (not this test process) skips its
    // `finally` entirely, exactly like a killed pane/agent, so the question
    // becomes: does the orphaned grandchild (the real server.js) notice on
    // its own and exit?
    const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scratch-orphan-helper-'));
    const helperFile = path.join(helperDir, 'helper.js');
    const scratchModulePath = path.join(__dirname, '..', 'scripts', 'with-scratch-server.js');
    fs.writeFileSync(helperFile, [
      `const { withScratchServer } = require(${JSON.stringify(scratchModulePath)});`,
      'withScratchServer(async () => {',
      "  process.stdout.write('ready\\n');",
      '  await new Promise(() => {});', // never resolves -- SIGKILL is the only way out
      '}).catch(() => {});'
    ].join('\n'));

    const helper = spawn(process.execPath, [helperFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let helperOut = '';
    helper.stdout.on('data', (d) => { helperOut += d.toString(); });

    try {
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const check = () => {
          if (helperOut.includes('ready')) { resolve(); return; }
          if (Date.now() > deadline) { reject(new Error('helper process never reported ready')); return; }
          setTimeout(check, 100);
        };
        check();
      });

      const childPid = findChildPid(helper.pid, 'server.js');
      assert.ok(childPid, 'the real scratch server.js process must be discoverable as the helper\'s own OS child');
      assert.ok(isAlive(childPid), 'the scratch server.js child must be alive before the harness is killed');

      helper.kill('SIGKILL');

      // server.js's scratch-mode watchdog polls parent liveness every
      // ~1000ms -- give it up to 5s, per the acceptance criterion.
      const deadline = Date.now() + 5000;
      let alive = true;
      while (Date.now() < deadline) {
        alive = isAlive(childPid);
        if (!alive) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(alive, false, 'the orphaned scratch server.js child must self-terminate within 5s of its harness dying');
    } finally {
      if (helper.exitCode === null && helper.signalCode === null) {
        try { helper.kill('SIGKILL'); } catch (_err) { /* already gone */ }
      }
      fs.rmSync(helperDir, { recursive: true, force: true });
    }
  });
});
