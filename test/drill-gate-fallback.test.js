'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const drillCmd = require('../scripts/drill-gate-fallback');
const fallbackCmd = require('../scripts/gate-fallback');

// The drill's sequence and verdicts, with the fallback command, the server and
// Caddy injected. The live run is A-VRF's (from the phone, over SSH).

const TARGETS = [{ port: 8443, tls: true, host: 'box.example' }, { port: 8443, tls: true, host: 'localhost' }];
const ORIGINAL = '# the Caddyfile before the drill\n';
const FALLBACK = '# the fallback Caddyfile\n';

describe('scripts/drill-gate-fallback.js (#1420)', () => {
  let dir;
  let caddyfilePath;
  let snapshotPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-drill-'));
    caddyfilePath = path.join(dir, 'Caddyfile');
    snapshotPath = path.join(dir, 'drill-gate-fallback-x.Caddyfile');
    fs.writeFileSync(caddyfilePath, ORIGINAL);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * Collaborators that behave like a healthy install: the fallback writes its
   * Caddyfile, and the undo restores whatever `restore` names.
   * @param {object} [over]
   * @returns {{ deps: object, log: string[], runs: object[] }}
   */
  function healthy(over = {}) {
    const log = [];
    const runs = [];
    let state = 'armed';
    const deps = {
      queryState: async () => { log.push(`query:${state}`); return { state, error: null }; },
      runFallback: async (opts) => {
        runs.push(opts);
        log.push(opts.undo ? 'undo' : 'fallback');
        if (opts.undo) {
          if (opts.restore) fs.copyFileSync(opts.restore, caddyfilePath);
          state = 'armed';
        } else {
          fs.writeFileSync(caddyfilePath, FALLBACK);
          state = 'fallback';
        }
        return fallbackCmd.EXIT.OK;
      },
      readDoor: () => ({ ok: true, reason: null, probes: TARGETS }),
      getWithCredential: async (target, user, password) => {
        log.push(`signin:${target.host}:${user}:${password === 'pw' ? 'right' : 'wrong'}`);
        return { status: 200, basicChallenge: false, error: null };
      },
      ...over
    };
    return { deps, log, runs };
  }

  const run = (deps) => drillCmd.drill({
    user: 'fallback-user', password: 'pw', port: 3102, snapshotPath,
    fallbackOpts: { caddyfilePath },
    deps, stdout: { write: () => {} }
  });

  it('passes a healthy install in the documented order, leaving the Caddyfile as it was', async () => {
    const { deps, log, runs } = healthy();
    const result = await run(deps);
    assert.equal(result.passed, true, JSON.stringify(result.steps));
    assert.deepEqual(log, [
      'query:armed', 'fallback',
      'signin:box.example:fallback-user:right', 'signin:localhost:fallback-user:right',
      'query:fallback', 'undo', 'query:armed'
    ]);
    assert.equal(runs[1].restore, snapshotPath, 'the undo restores the copy taken before the drill');
    assert.equal(fs.readFileSync(caddyfilePath, 'utf8'), ORIGINAL);
    assert.equal(fs.existsSync(snapshotPath), false, 'a passing drill removes its copy');
  });

  it('stops before touching anything when the login is not the gate', async () => {
    for (const answer of [{ state: 'unreadable', error: null }, { state: null, error: 'ECONNREFUSED' }]) {
      const { deps, log } = healthy({ queryState: async () => answer });
      const result = await run(deps);
      assert.equal(result.passed, false);
      assert.equal(result.steps.length, 1);
      assert.equal(log.includes('fallback'), false);
      assert.equal(fs.existsSync(snapshotPath), false);
    }
  });

  it('fails, without signing in or undoing, when the fallback itself fails', async () => {
    const { deps, log } = healthy();
    deps.runFallback = async (opts) => { log.push(opts.undo ? 'undo' : 'fallback'); return fallbackCmd.EXIT.REFUSED; };
    const result = await run(deps);
    assert.equal(result.passed, false);
    assert.deepEqual(log, ['query:armed', 'fallback']);
  });

  it('fails when a site does not let the Caddy password through — a 401, or a 502 behind it', async () => {
    for (const answer of [{ status: 401, basicChallenge: true, error: null }, { status: 502, basicChallenge: false, error: null },
      { status: null, basicChallenge: false, error: 'ECONNRESET' }]) {
      fs.writeFileSync(caddyfilePath, ORIGINAL);
      const { deps } = healthy({ getWithCredential: async () => answer });
      const result = await run(deps);
      assert.equal(result.passed, false, JSON.stringify(answer));
      assert.ok(result.steps.some((s) => /sign in/.test(s.step) && !s.ok));
    }
  });

  it('fails when the undo keeps Caddy\'s password, and keeps the copy', async () => {
    const { deps } = healthy();
    const inner = deps.runFallback;
    deps.runFallback = async (opts) => {
      if (!opts.undo) return inner(opts);
      return fallbackCmd.EXIT.KEPT;
    };
    const result = await run(deps);
    assert.equal(result.passed, false);
    assert.ok(result.steps.some((s) => s.step === 'undo the fallback' && !s.ok));
    assert.ok(result.steps.some((s) => /as it was before/.test(s.step) && !s.ok));
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), ORIGINAL, 'the copy survives a failed drill');
  });

  it('fails when the undo exits 0 but the Caddyfile is not the one the drill started with', async () => {
    const { deps } = healthy();
    const inner = deps.runFallback;
    deps.runFallback = async (opts) => (opts.undo ? fallbackCmd.EXIT.OK : inner(opts));
    const result = await run(deps);
    assert.equal(result.passed, false);
    assert.ok(result.steps.some((s) => /as it was before/.test(s.step) && !s.ok));
  });

  it('fails when TangleClaw never reports fallback, and still undoes', async () => {
    const { deps, log } = healthy();
    const inner = deps.queryState;
    deps.queryState = async (p) => {
      const r = await inner(p);
      return r.state === 'fallback' ? { state: 'armed', error: null } : r;
    };
    const result = await run(deps);
    assert.equal(result.passed, false);
    assert.ok(log.includes('undo'));
  });

  it('parses its arguments, requiring a value for --user and --restore', () => {
    assert.deepEqual(drillCmd.parseArgs(['--user', 'jason', '--password-stdin', '--restore', '/x.bak']),
      { user: 'jason', passwordStdin: true, restore: '/x.bak', help: false, unknown: [] });
    assert.deepEqual(drillCmd.parseArgs(['--user']).unknown, ['--user (needs a value)']);
    assert.deepEqual(drillCmd.parseArgs(['--password', 'x']).unknown, ['--password', 'x']);
  });

  it('sends the credential as HTTP Basic to the named host', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, auth: req.headers.authorization });
      res.writeHead(req.headers.authorization === `Basic ${Buffer.from('u:p').toString('base64')}` ? 200 : 401,
        { 'WWW-Authenticate': 'Basic realm="x"' });
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = server.address().port;
      const ok = await drillCmd.getWithCredential({ port, tls: false, host: 'box.example' }, 'u', 'p');
      assert.equal(ok.status, 200);
      assert.equal(seen[0].host, 'box.example');
      const wrong = await drillCmd.getWithCredential({ port, tls: false, host: null }, 'u', 'nope');
      assert.equal(wrong.status, 401);
      assert.equal(wrong.basicChallenge, true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
