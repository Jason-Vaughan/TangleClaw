'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const drillCmd = require('../scripts/drill-gate-fallback');
const fallbackCmd = require('../scripts/gate-fallback');

// The drill's sequence and verdicts, with the fallback command, the server and
// Caddy injected. The live run is A-VRF's (from the phone, over SSH).

const TARGETS = [{ port: 8443, tls: true, host: 'box.example' }, { port: 8443, tls: true, host: 'localhost' }];

/**
 * Build injected collaborators that behave like a healthy install, with
 * per-case overrides.
 * @param {object} [over]
 * @returns {{ deps: object, log: string[] }}
 */
function healthy(over = {}) {
  const log = [];
  let state = 'armed';
  const deps = {
    queryState: async () => { log.push(`query:${state}`); return { state, error: null }; },
    runFallback: async (opts) => {
      log.push(opts.undo ? 'undo' : 'fallback');
      state = opts.undo ? 'armed' : 'fallback';
      return fallbackCmd.EXIT.OK;
    },
    readDoor: () => ({ ok: true, reason: null, probes: TARGETS }),
    getWithCredential: async (target, user, password) => {
      log.push(`signin:${target.host}:${user}:${password === 'pw' ? 'right' : 'wrong'}`);
      return { status: 200, basicChallenge: false, error: null };
    },
    ...over
  };
  return { deps, log };
}

const run = (deps) => drillCmd.drill({
  user: 'fallback-user', password: 'pw', port: 3102,
  fallbackOpts: { caddyfilePath: '/nonexistent/Caddyfile' },
  deps, stdout: { write: () => {} }
});

describe('scripts/drill-gate-fallback.js (#1420)', () => {
  it('passes a healthy install in the documented order', async () => {
    const { deps, log } = healthy();
    const result = await run(deps);
    assert.equal(result.passed, true, JSON.stringify(result.steps));
    assert.deepEqual(log, [
      'query:armed', 'fallback',
      'signin:box.example:fallback-user:right', 'signin:localhost:fallback-user:right',
      'query:fallback', 'undo', 'query:armed'
    ]);
  });

  it('stops before touching anything when the login is not the gate', async () => {
    for (const answer of [{ state: 'unreadable', error: null }, { state: null, error: 'ECONNREFUSED' }]) {
      const { deps, log } = healthy({ queryState: async () => answer });
      const result = await run(deps);
      assert.equal(result.passed, false);
      assert.equal(result.steps.length, 1);
      assert.equal(log.includes('fallback'), false);
    }
  });

  it('fails, without signing in or undoing, when the fallback itself fails', async () => {
    const { deps, log } = healthy({ runFallback: async (opts) => { log.push(opts.undo ? 'undo' : 'fallback'); return fallbackCmd.EXIT.REFUSED; } });
    const result = await run(deps);
    assert.equal(result.passed, false);
    assert.deepEqual(log, ['query:armed', 'fallback']);
  });

  it('fails when a site still refuses the Caddy password', async () => {
    const { deps } = healthy({ getWithCredential: async () => ({ status: 401, basicChallenge: true, error: null }) });
    const result = await run(deps);
    assert.equal(result.passed, false);
    assert.ok(result.steps.some((s) => /sign in/.test(s.step) && !s.ok));
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
