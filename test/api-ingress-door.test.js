'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const caddy = require('../lib/caddy');
const drift = require('../lib/caddy-drift');
const { handleRequest } = require('../server');
const { FIXTURE_CADDYFILES, adaptFromFixtures } = require('./_caddy-drift-fixtures');

// `authEnabled: false` in caddy mode, driven through the REAL request handler:
// the Caddyfile on disk decides whether the opt-out opens the install
// (`server.js#_gateIngress` → `lib/ingress-door.js`). `lib/ingress-door` proves
// the reading; these prove the server asks it, caches it per change of the
// file, and fails closed when the file goes away under it (#1420).
//
// `caddy adapt` is answered from the committed fixtures, so nothing here depends
// on whether the host has Caddy.

const PASSWORD = 'correct-horse-battery';

describe('the Caddyfile as a door, end to end (#1420)', () => {
  let tempDir;
  let prevBase;
  let realAdapt;
  let adapts;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ingress-door-api-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store.getDb().prepare('DELETE FROM auth_sessions').run();
    store.getDb().prepare('DELETE FROM recovery_codes').run();
    store.getDb().prepare('DELETE FROM users').run();
    fs.rmSync(caddy.getCaddyfilePath(), { force: true });
    const cfg = store.config.load();
    Object.assign(cfg, { authEnabled: false, ingressMode: 'caddy' });
    store.config.save(cfg);
    realAdapt = drift.adaptCaddyfileContent;
    adapts = 0;
    drift.adaptCaddyfileContent = realAdaptStub;
  });

  /**
   * `caddy adapt` answered from the committed fixture JSON for a fixture's text.
   * @param {string} text - Caddyfile text.
   * @returns {{ ok: boolean, config: object|null, reason: string|null }}
   */
  function realAdaptStub(text) {
    adapts++;
    return adaptFromFixtures(text);
  }

  afterEach(() => {
    drift.adaptCaddyfileContent = realAdapt;
  });

  /**
   * GET /api/auth/me as a browser, and return the gate state it reports.
   * @returns {Promise<string>}
   */
  async function gateState() {
    const res = {
      statusCode: 0, body: '', headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status) { this.statusCode = status; },
      end(chunk) { if (chunk != null) this.body = String(chunk); }
    };
    const req = {
      url: '/api/auth/me', method: 'GET',
      headers: { host: 'localhost:3102', 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) { if (event === 'end') cb(); }
    };
    await handleRequest(req, res);
    return JSON.parse(res.body).gateState;
  }

  /**
   * Write a fixture Caddyfile with a distinct mtime, so the cache key changes
   * even when two writes land in the same clock tick.
   * @param {string} name - Key of FIXTURE_CADDYFILES.
   */
  let tick = 0;
  function writeCaddyfile(name) {
    const file = caddy.getCaddyfilePath();
    fs.writeFileSync(file, FIXTURE_CADDYFILES[name], { mode: 0o600 });
    tick += 10;
    const when = new Date(Date.now() + tick * 1000);
    fs.utimesSync(file, when, when);
  }

  it('opens for a gated file and keeps the accounts deciding for each kind of door', async () => {
    store.users.create('rosie', PASSWORD);
    writeCaddyfile('live-shape-gated');
    assert.equal(await gateState(), 'open');
    writeCaddyfile('live-shape-own-auth');
    assert.equal(await gateState(), 'armed', 'basic_auth beside an ungated handle is a door');
    writeCaddyfile('per-site-gate');
    assert.equal(await gateState(), 'armed', 'a credential on another site does not gate this one');
    writeCaddyfile('ungated-unguarded');
    assert.equal(await gateState(), 'armed', 'an unguarded localhost site, with accounts');
    writeCaddyfile('generated');
    assert.equal(await gateState(), 'open');
  });

  it('adapts once per change of the file, not per request', async () => {
    store.users.create('rosie', PASSWORD);
    writeCaddyfile('armed');
    assert.equal(await gateState(), 'armed');
    assert.equal(await gateState(), 'armed');
    assert.equal(adapts, 1);
    writeCaddyfile('generated');
    assert.equal(await gateState(), 'open');
    assert.equal(adapts, 2);
  });

  it('keeps the login on while caddy adapt cannot read the file, and asks again after a while', async () => {
    store.users.create('rosie', PASSWORD);
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      drift.adaptCaddyfileContent = () => { adapts++; return { ok: false, config: null, reason: 'caddy is not available' }; };
      writeCaddyfile('live-shape-gated');
      assert.equal(await gateState(), 'armed', 'a gated file Caddy could not read is still a door');
      assert.equal(await gateState(), 'armed');
      assert.equal(adapts, 1, 'not re-asked on every request');
      clock += 31000;
      drift.adaptCaddyfileContent = realAdaptStub;
      assert.equal(await gateState(), 'open', 're-asked once the retry window passed, and Caddy answered');
    } finally {
      Date.now = realNow;
    }
  });

  it('no Caddyfile is no door', async () => {
    store.users.create('rosie', PASSWORD);
    assert.equal(await gateState(), 'open');
  });

  it('a Caddyfile gone between the stat and the read enforces, and is not cached', async () => {
    store.users.create('rosie', PASSWORD);
    const file = caddy.getCaddyfilePath();
    const realStat = fs.statSync;
    // The stat sees a file; the read that follows finds none.
    fs.statSync = function statSync(p, ...rest) {
      if (p === file) return { mtimeMs: 424242, size: 99 };
      return realStat.call(this, p, ...rest);
    };
    try {
      assert.equal(await gateState(), 'unreadable');
      assert.equal(adapts, 0, 'nothing was described');
    } finally {
      fs.statSync = realStat;
    }
    // The same key again, now with a real file behind it: re-read, not a cached
    // "no door" from the failed attempt.
    writeCaddyfile('armed');
    fs.statSync = function statSync(p, ...rest) {
      if (p === file) return { mtimeMs: 424242, size: 99 };
      return realStat.call(this, p, ...rest);
    };
    try {
      assert.equal(await gateState(), 'armed');
    } finally {
      fs.statSync = realStat;
    }
  });
});
