'use strict';

/*
 * #2278 — `PATCH /api/config` allowlisted `defaultEngine` and wrote it with no
 * check that it was a string or named an engine this install has. These tests
 * pin the route-level contract added in `lib/routes/config.js`: a non-string,
 * an empty string, an unknown engine id, and an engine profile that cannot be
 * trusted (unreadable JSON, or one that does not identify as the id it was
 * asked for) are all refused with 400 BAD_REQUEST before the value is stored,
 * the same identity test `master.engine` already made next to it.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { createServer } = require('../server');
const { operatorHeaders } = require('./_shared-docs-callers');

setLevel('error');

/**
 * Make an HTTP request to the test server, identified as the operator's
 * dashboard for a write (#2233) — same convention as `test/api-config.test.js`.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{status: number, data: object}>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...(method === 'PATCH' ? operatorHeaders(server) : {}) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('PATCH /api/config — defaultEngine validation (#2278)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-config-default-engine-'));
    store._setBasePath(tmpDir);
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * The stored `defaultEngine` right now, read straight from the config file
   * so an assertion that a refused PATCH left it untouched is not trusting
   * the same in-process `store` instance the route itself wrote through.
   * @returns {*}
   */
  function storedDefaultEngine() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8')).defaultEngine;
  }

  it('accepts a known, usable engine id and persists it', async () => {
    const { status, data } = await request(server, 'PATCH', '/api/config', { defaultEngine: 'claude' });
    assert.equal(status, 200);
    assert.equal(data.config.defaultEngine, 'claude');
    assert.equal(storedDefaultEngine(), 'claude');
  });

  for (const bad of [123, true, {}, [], null]) {
    it(`refuses a non-string defaultEngine (${JSON.stringify(bad)}) with 400, unchanged`, async () => {
      const before_ = storedDefaultEngine();
      const { status, data } = await request(server, 'PATCH', '/api/config', { defaultEngine: bad });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /non-empty string/);
      assert.equal(storedDefaultEngine(), before_, 'a refused patch must not mutate the stored value');
    });
  }

  it('refuses an empty string with 400, unchanged', async () => {
    const before_ = storedDefaultEngine();
    const { status, data } = await request(server, 'PATCH', '/api/config', { defaultEngine: '' });
    assert.equal(status, 400);
    assert.equal(data.code, 'BAD_REQUEST');
    assert.match(data.error, /non-empty string/);
    assert.equal(storedDefaultEngine(), before_);
  });

  it('refuses an id naming no configured engine, with 400, unchanged', async () => {
    const before_ = storedDefaultEngine();
    const { status, data } = await request(server, 'PATCH', '/api/config', { defaultEngine: 'no-such-engine-xyz' });
    assert.equal(status, 400);
    assert.equal(data.code, 'BAD_REQUEST');
    assert.match(data.error, /is not a configured engine/);
    assert.equal(storedDefaultEngine(), before_);
  });

  it('refuses an engine profile that does not parse as JSON, with 400, unchanged', async () => {
    const before_ = storedDefaultEngine();
    fs.writeFileSync(path.join(tmpDir, 'engines', 'broken-default.json'), '{ not json');
    try {
      const { status, data } = await request(server, 'PATCH', '/api/config', { defaultEngine: 'broken-default' });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /could not be read as JSON/);
      assert.equal(storedDefaultEngine(), before_);
    } finally {
      fs.rmSync(path.join(tmpDir, 'engines', 'broken-default.json'));
    }
  });

  it('refuses a profile file that does not identify as the id it was asked for, with 400, unchanged', async () => {
    const before_ = storedDefaultEngine();
    // Same identity test `master.engine` makes: a file saved under one name
    // but carrying another engine's `id` is not that engine's profile.
    fs.writeFileSync(path.join(tmpDir, 'engines', 'mismatched.json'),
      JSON.stringify({ id: 'claude', name: 'Mismatched' }));
    try {
      const { status, data } = await request(server, 'PATCH', '/api/config', { defaultEngine: 'mismatched' });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /is not a configured engine/);
      assert.equal(storedDefaultEngine(), before_);
    } finally {
      fs.rmSync(path.join(tmpDir, 'engines', 'mismatched.json'));
    }
  });

  it('a patch touching only an unrelated field never runs the defaultEngine check at all', async () => {
    const before_ = storedDefaultEngine();
    const { status } = await request(server, 'PATCH', '/api/config', { chimeMuted: true });
    assert.equal(status, 200);
    assert.equal(storedDefaultEngine(), before_);
  });
});
