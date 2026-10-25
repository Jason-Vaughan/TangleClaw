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
const path = require('node:path');
const http = require('node:http');

const scratch = require('../scripts/with-scratch-server');

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
