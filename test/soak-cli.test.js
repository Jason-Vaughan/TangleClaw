'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../scripts/soak');

/** The pinned candidate every bundle here names. */
const CAND = 'a'.repeat(40);

/**
 * A writable that collects what is written.
 * @returns {{write: (s: string) => void, text: () => string}} Sink
 */
function sink() {
  let buf = '';
  return { write: (s) => { buf += s; }, text: () => buf };
}

/** The Operator password every test login holds; a test searches its output for it. */
const OPERATOR_PASSWORD = 'cli-test-operator-password-0123';

/** The session and CSRF tokens the fake sign-in hands out. */
const SESSION_TOKEN = 'cli-test-session-token';
const CSRF_TOKEN = 'cli-test-csrf-token';

/**
 * Write the Operator login file `run --operator-login` reads, mode 0600, in
 * the test's temp dir.
 * @param {object} [over] - Fields to replace
 * @returns {string} Its path
 */
function loginFile(over = {}) {
  const file = path.join(dir, 'operator-login.json');
  fs.writeFileSync(file, JSON.stringify({ username: 'soak-operator', password: OPERATOR_PASSWORD, ...over }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * Answer the sign-in a run makes before its load, as an armed guest would:
 * the gate reads `armed`, and the login sets a session. Every other request
 * goes to `fetch`, which never sees the sign-in.
 * @param {Function} fetch - The test's fetch
 * @param {object} [opt] - `{gateState, loginStatus}`
 * @returns {Function} Fetch
 */
function signedIn(fetch, opt = {}) {
  return async (url, init) => {
    if (url.pathname === '/api/auth/me') return { status: 200, text: async () => JSON.stringify({ authenticated: false, gateState: opt.gateState || 'armed' }) };
    if (url.pathname === '/api/auth/login') {
      if (opt.loginStatus && opt.loginStatus !== 200) return { status: opt.loginStatus, text: async () => JSON.stringify({ code: 'INVALID_CREDENTIALS' }) };
      return {
        status: 200,
        headers: { getSetCookie: () => [`tc_session=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax`, `tc_csrf=${CSRF_TOKEN}; Path=/; SameSite=Lax`] },
        text: async () => JSON.stringify({ username: 'soak-operator', csrfToken: CSRF_TOKEN })
      };
    }
    return fetch(url, init);
  };
}

/**
 * Run the CLI with collected output.
 *
 * Every `run` here writes as the Operator (its schedules hold port leases),
 * so by default it gets a login file and a target that signs it in
 * (`loginFile`, `signedIn`), and the test's own fetch sees only the load.
 * `operatorLogin: false` runs it exactly as given, for the tests of the
 * login itself.
 * @param {string[]} argv - Arguments
 * @param {object} [deps] - Extra deps, and `operatorLogin: false` to opt out
 * @returns {Promise<{code: number, out: string, err: string}>} Result
 */
async function run(argv, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  const { operatorLogin, ...rest } = deps;
  let args = argv;
  if (argv[0] === 'run' && operatorLogin !== false && !argv.includes('--operator-login')) {
    args = [...argv, '--operator-login', loginFile()];
    if (rest.fetch) rest.fetch = signedIn(rest.fetch);
  }
  // Names resolve to a guest-like address unless a test says otherwise, so no
  // test depends on this machine's DNS.
  const code = await cli.main(args, { stdout, stderr, env: {}, onStopSignal: () => {}, lookup: async () => ['192.168.64.7'], ...rest });
  return { code, out: stdout.text(), err: stderr.text() };
}

/**
 * An instant fake clock.
 * @returns {{now: () => number, sleep: (ms: number) => Promise<void>}} Clock
 */
function instantClock() {
  let t = 1_790_000_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-cli-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('soak CLI — plan and validate', () => {
  it('writes a schedule file readable by its owner only and reports its digest', async () => {
    const out = path.join(dir, 's.json');
    const r = await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '1', '--out', out]);
    assert.equal(r.code, 0, r.err);
    const schedule = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(JSON.parse(r.err).digest, schedule.digest);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    const v = await run(['validate', '--schedule', out]);
    assert.equal(v.code, 0);
    assert.equal(JSON.parse(v.out).digest, schedule.digest);
  });

  it('never overwrites an existing schedule', async () => {
    const out = path.join(dir, 's.json');
    fs.writeFileSync(out, 'keep');
    const r = await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '1', '--out', out]);
    assert.equal(r.code, 2);
    assert.equal(fs.readFileSync(out, 'utf8'), 'keep');
  });

  it('passes classes, projects and intervals through to the schedule', async () => {
    const out = path.join(dir, 's.json');
    const r = await run(['plan', '--seed', 'rc', '--phase', 'destructive', '--duration-hours', '0.5', '--out', out,
      '--classes', 'api,engine', '--projects', 'soak-p1,soak-p2', '--load-mean-ms', '10000', '--fault-mean-ms', '60000', '--fault-quiet-ms', '0']);
    assert.equal(r.code, 0, r.err);
    const p = JSON.parse(fs.readFileSync(out, 'utf8')).params;
    assert.deepEqual([p.phase, p.classes, p.projects, p.loadMeanMs, p.faultMeanMs, p.faultQuietMs, p.durationMs],
      ['destructive', ['api', 'engine'], ['soak-p1', 'soak-p2'], 10000, 60000, 0, 30 * 60 * 1000]);
  });

  it('exits 3 and lists violations for a tampered schedule', async () => {
    const out = path.join(dir, 's.json');
    await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '1', '--out', out]);
    const s = JSON.parse(fs.readFileSync(out, 'utf8'));
    s.events[0].atMs += 1;
    fs.writeFileSync(out, JSON.stringify(s));
    const v = await run(['validate', '--schedule', out]);
    assert.equal(v.code, 3);
    assert.ok(JSON.parse(v.err).violations.some((x) => x.code === 'DIGEST_MISMATCH'));
  });

  const usage = [
    ['no command', []],
    ['an unknown command', ['explode']],
    ['a missing required flag', ['plan', '--seed', 'x', '--phase', 'certifying', '--out', 'y']],
    ['an unknown flag', ['validate', '--schedule', 'x', '--verbose', 'yes']],
    ['a flag with no value', ['validate', '--schedule']],
    ['a repeated flag', ['validate', '--schedule', 'a', '--schedule', 'b']],
    ['a repeated boolean flag', ['run', '--schedule', 'a', '--api', 'http://h:1', '--log', 'l', '--allow-unverified-live', '--allow-unverified-live']],
    ['a boolean flag on a command that does not take it', ['validate', '--schedule', 'a', '--allow-unverified-live']],
    ['a bad phase', ['plan', '--seed', 'x', '--phase', 'nope', '--duration-hours', '1', '--out', 'y']],
    ['a non-numeric interval', ['plan', '--seed', 'x', '--phase', 'certifying', '--duration-hours', '1', '--out', 'y', '--load-mean-ms', '1e3']],
    ['a token on the command line', ['run', '--schedule', 'a', '--api', 'http://h:1', '--log', 'l', '--token', 'secret']],
    ['an Operator password on the command line', ['run', '--schedule', 'a', '--api', 'http://h:1', '--log', 'l', '--operator-password', 'secret']],
    ['operator-login with neither --create nor --body', ['operator-login', '--file', '/x/login.json']],
    ['operator-login with both --create and --body', ['operator-login', '--file', '/x/login.json', '--create', '--body', 'login']],
    ['operator-login with an unknown body', ['operator-login', '--file', '/x/login.json', '--body', 'token', '--out', '/x/b']],
    ['operator-login with a body but nowhere to write it', ['operator-login', '--file', '/x/login.json', '--body', 'login']],
    ['operator-login --create with --out', ['operator-login', '--file', '/x/login.json', '--create', '--out', '/x/b']],
    ['operator-login with the retired setup body', ['operator-login', '--file', '/x/login.json', '--body', 'setup', '--out', '/x/b']],
    ['operator-login with a projects directory', ['operator-login', '--file', '/x/login.json', '--body', 'login', '--out', '/x/b', '--projects-dir', '/p']],
    ['an --api that is not http(s)', ['run', '--schedule', 'a', '--api', 'file:///etc', '--log', 'l']],
    ['an unreadable schedule', ['validate', '--schedule', '/nonexistent/soak.json']]
  ];
  for (const [label, argv] of usage) {
    it(`exits 2 with usage for ${label}`, async () => {
      const r = await run(argv);
      assert.equal(r.code, 2);
      assert.match(r.err, /usage: soak plan/);
    });
  }
});

describe('soak CLI — redirects never carry the load to the live install', () => {
  const http = require('node:http');

  /**
   * Start a local HTTP server on an OS-assigned port.
   * @param {Function} handler - Request handler
   * @returns {Promise<{port: number, close: () => Promise<void>}>} Server
   */
  function serve(handler) {
    return new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }));
    });
  }
  const identity = (tag) => JSON.stringify({ startedAt: tag, startupSha: 'd'.repeat(40) });

  for (const code of [301, 302, 303, 307, 308]) {
    it(`a target answering ${code} to the live install gets its load refused, and the live side receives none of it`, async () => {
      const liveHits = [];
      const live = await serve((req, res) => {
        liveHits.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url === '/api/server-info' ? identity('live') : '{}');
      });
      const target = await serve((req, res) => {
        if (req.url === '/api/server-info') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(identity('target'));
          return;
        }
        res.writeHead(code, { location: `http://localhost:${live.port}${req.url}` });
        res.end();
      });
      try {
        const out = path.join(dir, 's.json');
        await run(['plan', '--seed', 'rd', '--phase', 'certifying', '--duration-hours', '0.25', '--out', out, '--classes', 'api', '--load-mean-ms', '60000']);
        const log = path.join(dir, 'l');
        const r = await run(['run', '--schedule', out, '--api', `http://127.0.0.1:${target.port}`, '--log', log],
          { fetch: globalThis.fetch, clock: instantClock(), env: { TANGLECLAW_API: `http://localhost:${live.port}` } });
        assert.equal(r.code, 0, r.err);
        assert.deepEqual(liveHits, ['GET /api/server-info'], 'the live side saw only its own identity probe');
        const events = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.type === 'event');
        assert.ok(events.length > 0);
        assert.ok(events.filter((e) => e.kind !== 'api.server-info').every((e) => e.code === 'REDIRECT_REFUSED' && e.status === code));
      } finally {
        await target.close();
        await live.close();
      }
    });
  }

  it('a target whose identity endpoint redirects to the live install is not believed, and still sends it nothing', async () => {
    const liveHits = [];
    const live = await serve((req, res) => { liveHits.push(`${req.method} ${req.url}`); res.writeHead(200); res.end(identity('live')); });
    const target = await serve((req, res) => { res.writeHead(307, { location: `http://localhost:${live.port}${req.url}` }); res.end(); });
    try {
      const out = path.join(dir, 's.json');
      await run(['plan', '--seed', 'rd', '--phase', 'certifying', '--duration-hours', '0.25', '--out', out, '--classes', 'api', '--load-mean-ms', '60000']);
      const r = await run(['run', '--schedule', out, '--api', `http://127.0.0.1:${target.port}`, '--log', path.join(dir, 'l')],
        { fetch: globalThis.fetch, clock: instantClock(), env: { TANGLECLAW_API: `http://localhost:${live.port}` } });
      assert.equal(r.code, 0, r.err);
      assert.match(JSON.parse(r.err.split('\n')[0]).reason, /redirect refused/);
      assert.deepEqual(liveHits, ['GET /api/server-info']);
    } finally {
      await target.close();
      await live.close();
    }
  });
});

describe('soak CLI — a lost lock', () => {
  it('exits 3 with LOCK_LOST when the lock vanishes mid-run, records it beside the log, and refuses a rerun', async () => {
    const out = path.join(dir, 's.json');
    await run(['plan', '--seed', 'll', '--phase', 'certifying', '--duration-hours', '0.25', '--out', out, '--classes', 'api', '--load-mean-ms', '60000']);
    const log = path.join(dir, 'l');
    let removed = false;
    const fetch = async () => {
      if (!removed) { removed = true; fs.rmSync(`${log}.lock`); }
      return { status: 200, text: async () => '{}' };
    };
    const r = await run(['run', '--schedule', out, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'], { fetch, clock: instantClock() });
    assert.equal(r.code, 3);
    const report = JSON.parse(r.err.trim().split('\n').pop());
    assert.equal(report.code, 'LOCK_LOST');
    assert.ok(fs.existsSync(report.details.sidecar), 'the loss is recorded beside the log');
    assert.ok(!fs.readFileSync(log, 'utf8').includes('"type":"end"'), 'the log never reads as complete');
    const rerun = await run(['run', '--schedule', out, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'], { fetch: async () => ({ status: 200, text: async () => '{}' }), clock: instantClock() });
    assert.equal(rerun.code, 3);
    assert.equal(JSON.parse(rerun.err.trim().split('\n').pop()).code, 'LOG_LOCK_LOST', 'a rerun is refused, never already-complete');
  });
});

describe('soak CLI — ownership that cannot be verified', () => {
  it('exits 5, never 0, when the log was resumed by an exact-owner reclaim', async () => {
    const driver = require('../lib/soak/driver');
    const out = path.join(dir, 's.json');
    await run(['plan', '--seed', 'ou', '--phase', 'certifying', '--duration-hours', '0.25', '--out', out, '--classes', 'api', '--load-mean-ms', '60000']);
    const log = path.join(dir, 'l');
    const argv = ['run', '--schedule', out, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'];
    const deps = { fetch: async () => ({ status: 200, text: async () => '{}' }), clock: instantClock() };
    const clean = await run(argv, deps);
    assert.deepEqual([clean.code, JSON.parse(clean.out).status], [0, 'completed'], clean.err);
    // What a crash between the end record and the lock release leaves behind.
    const owner = { pid: require('node:child_process').spawnSync(process.execPath, ['-e', '0']).pid, host: os.hostname() };
    driver.openSegment(log, owner, 1);
    fs.writeFileSync(`${log}.lock`, JSON.stringify(owner));
    const r = await run(argv, deps);
    assert.equal(r.code, 5, r.err);
    assert.deepEqual([JSON.parse(r.out).status, JSON.parse(r.out).ownershipUnverified], ['already-complete-ownership-unverified', true]);
  });
});

describe('soak CLI — every soak fetch refuses redirects', () => {
  it('passes redirect: manual at every fetch call site in the soak modules', () => {
    const files = ['lib/soak/executors.js', 'lib/soak/driver.js', 'scripts/soak.js'].map((f) => path.join(__dirname, '..', f));
    let sites = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bfetch\(\s*(?:new URL\([^)]*\)[^,]*|url)\s*,\s*\{/g)) {
        sites++;
        const opts = src.slice(m.index, src.indexOf('});', m.index));
        assert.match(opts, /redirect: 'manual'/, `${path.basename(f)}: a fetch call without redirect: 'manual'`);
      }
    }
    assert.equal(sites, 3, 'the soak modules make exactly the fetch calls this test knows about');
  });
});

describe('soak CLI — run', () => {
  /**
   * Plan an api-only schedule into the temp dir.
   * @returns {Promise<string>} Schedule path
   */
  async function planApi() {
    const out = path.join(dir, 's.json');
    const r = await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '0.25', '--out', out, '--classes', 'api', '--load-mean-ms', '60000']);
    assert.equal(r.code, 0, r.err);
    return out;
  }

  it('runs an api-only schedule against the named server with the env token', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'soak.ndjson');
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ origin: url.origin, path: url.pathname, auth: init.headers.authorization });
      if (url.pathname === '/api/server-info') {
        return { status: 200, text: async () => JSON.stringify({ startedAt: url.origin, startupSha: 'c'.repeat(40) }) };
      }
      return { status: 200, text: async () => '{}' };
    };
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log],
      { fetch, clock: instantClock(), env: { TANGLECLAW_SERVICE_TOKEN: 'tok', TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).status, 'completed');
    // The live install is contacted once, without the token, for the identity
    // check; every other request goes to the guest, with it.
    const live = seen.filter((s) => s.origin === 'http://localhost:3102');
    assert.deepEqual(live, [{ origin: 'http://localhost:3102', path: '/api/server-info', auth: undefined }]);
    const guest = seen.filter((s) => s.origin !== 'http://localhost:3102');
    assert.ok(guest.length > 1);
    assert.ok(guest.every((s) => s.origin === 'http://192.168.64.7:3102' && s.auth === 'Bearer tok'));
  });

  it('refuses the pane\'s own TangleClaw with exit 3 and makes no request', async () => {
    const schedulePath = await planApi();
    let calls = 0;
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://localhost:3102/', '--log', path.join(dir, 'l')],
      { fetch: async () => { calls++; return { status: 200, text: async () => '{}' }; }, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'LIVE_INSTALL_TARGET');
    assert.equal(calls, 0);
  });

  it('refuses, before any load, a target that reports the same running server as the live install', async () => {
    const schedulePath = await planApi();
    const hits = [];
    const info = JSON.stringify({ startedAt: '2026-09-28T17:27:45.023Z', startupSha: 'b'.repeat(40) });
    const fetch = async (url) => { hits.push(url.pathname); return { status: 200, text: async () => info }; };
    const r = await run(['run', '--schedule', schedulePath, '--api', 'https://100.100.100.100:8443', '--log', path.join(dir, 'l')],
      { fetch, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'LIVE_INSTALL_TARGET');
    assert.deepEqual(hits, ['/api/server-info', '/api/server-info'], 'only the identity check reached any server');
    assert.equal(fs.existsSync(path.join(dir, 'l')), false);
  });

  it('refuses when the live identity cannot be read, and makes no load request', async () => {
    const schedulePath = await planApi();
    const hits = [];
    const fetch = async (url) => { hits.push(`${url.origin}${url.pathname}`); return { status: 503, text: async () => '{}' }; };
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', path.join(dir, 'l')],
      { fetch, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'LIVE_IDENTITY_UNREADABLE');
    assert.ok(hits.every((h) => h.endsWith('/api/server-info')));
    assert.equal(fs.existsSync(path.join(dir, 'l')), false);
  });

  it('runs past an unreadable live identity only with --allow-unverified-live, and records the override in the log', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const fetch = async (url) => (url.origin === 'http://localhost:3102'
      ? { status: 503, text: async () => '{}' }
      : { status: 200, text: async () => '{}' });
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log, '--allow-unverified-live'],
      { fetch, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 0, r.err);
    const warning = JSON.parse(r.err.split('\n')[0]);
    assert.deepEqual([warning.warning, warning.liveUnverified], ['IDENTITY_UNCHECKED', true]);
    const header = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
    assert.deepEqual(header.liveIdentityOverride, { reason: 'live install server-info: HTTP 503' });
  });

  it('refuses to run with no TANGLECLAW_API unless --no-live-install says so', async () => {
    const schedulePath = await planApi();
    let calls = 0;
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', path.join(dir, 'l')],
      { fetch: async () => { calls++; return { status: 200, text: async () => '{}' }; }, clock: instantClock() });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'GUARD_CONTEXT_ABSENT');
    assert.equal(calls, 0);
  });

  it('runs in the guest with --no-live-install, and records the override in the log header', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://localhost:3102', '--log', log, '--no-live-install'],
      { fetch: async () => ({ status: 200, text: async () => '{}' }), clock: instantClock() });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]).guardContextOverride, 'no-live-install');
  });

  it('records --no-live-install on a RESUMED segment, even when the first segment ran without it', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const clock = instantClock();
    const live = { TANGLECLAW_API: 'http://localhost:3102' };
    const identity = async (url) => (url.pathname === '/api/server-info'
      ? { status: 200, text: async () => JSON.stringify({ startedAt: url.origin, startupSha: 'e'.repeat(40) }) }
      : { status: 200, text: async () => '{}' });
    let fire;
    let calls = 0;
    // Segment 1: guarded by TANGLECLAW_API, no override. Stopped early.
    const first = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log],
      { fetch: async (...a) => { if (++calls === 4) fire(); return identity(...a); }, clock, env: live, onStopSignal: (fn) => { fire = fn; } });
    assert.equal(first.code, 4, first.err);
    // Segment 2: resumed from a plain shell with the override.
    const second = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'],
      { fetch: identity, clock });
    assert.equal(second.code, 0, second.err);
    const recs = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(recs[0].guardContextOverride, undefined, 'the first segment ran without it');
    const resume = recs.filter((r) => r.type === 'resume');
    assert.equal(resume.length, 1);
    assert.equal(resume[0].guardContextOverride, 'no-live-install');
    assert.ok(resume[0].resumedFrom > 0);
    assert.deepEqual(resume[0].guard, { liveApi: null, target: 'http://192.168.64.7:3102', targetAddress: null, identity: { checked: false, reason: 'no TANGLECLAW_API in this pane' } });
    assert.equal(recs[0].guard.liveApi, 'http://localhost:3102', 'the first segment recorded its own, guarded, context');
  });

  it('records --allow-unverified-live on a RESUMED segment', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const clock = instantClock();
    const env = { TANGLECLAW_API: 'http://localhost:3102' };
    const readable = async (url) => (url.pathname === '/api/server-info'
      ? { status: 200, text: async () => JSON.stringify({ startedAt: url.origin, startupSha: 'f'.repeat(40) }) }
      : { status: 200, text: async () => '{}' });
    let fire;
    let calls = 0;
    const first = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log],
      { fetch: async (...a) => { if (++calls === 4) fire(); return readable(...a); }, clock, env, onStopSignal: (fn) => { fire = fn; } });
    assert.equal(first.code, 4, first.err);
    // Segment 2: the live identity has become unreadable; resumed with the override.
    const liveDown = async (url) => (url.origin === 'http://localhost:3102' ? { status: 503, text: async () => '{}' } : readable(url));
    const second = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log, '--allow-unverified-live'],
      { fetch: liveDown, clock, env });
    assert.equal(second.code, 0, second.err);
    const recs = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(recs[0].liveIdentityOverride, undefined);
    const resume = recs.filter((r) => r.type === 'resume');
    assert.deepEqual(resume[0].liveIdentityOverride, { reason: 'live install server-info: HTTP 503' });
  });

  it('writes a resume record for every resumed segment, with no overrides when none were given', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const clock = instantClock();
    let fire;
    let calls = 0;
    await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'],
      { fetch: async () => { if (++calls === 2) fire(); return { status: 200, text: async () => '{}' }; }, clock, onStopSignal: (fn) => { fire = fn; } });
    const env = { TANGLECLAW_API: 'http://localhost:3102' };
    const identity = async (url) => (url.pathname === '/api/server-info'
      ? { status: 200, text: async () => JSON.stringify({ startedAt: url.origin, startupSha: 'a'.repeat(40) }) }
      : { status: 200, text: async () => '{}' });
    await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log], { fetch: identity, clock, env });
    const recs = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(recs[0].guardContextOverride, 'no-live-install');
    const resume = recs.find((r) => r.type === 'resume');
    assert.equal(resume.guardContextOverride, undefined, 'the second segment ran guarded, and says nothing it did not do');
    assert.equal(resume.liveIdentityOverride, undefined);
  });

  it('rejects --no-live-install where TANGLECLAW_API is set, since the claim is false', async () => {
    const schedulePath = await planApi();
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', path.join(dir, 'l'), '--no-live-install'],
      { fetch: async () => ({ status: 200, text: async () => '{}' }), clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 2);
  });

  it('refuses, with a code, when TANGLECLAW_API is set but is not a URL', async () => {
    const schedulePath = await planApi();
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', path.join(dir, 'l')],
      { fetch: async () => ({ status: 200, text: async () => '{}' }), clock: instantClock(), env: { TANGLECLAW_API: 'not a url' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'GUARD_CONTEXT_ABSENT');
  });

  it('says on stderr that it is stopping, once, when the first signal arrives', async () => {
    const schedulePath = await planApi();
    let fire;
    let calls = 0;
    const fetch = async () => { if (++calls === 2) { fire(); fire(); } return { status: 200, text: async () => '{}' }; };
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', path.join(dir, 'l'), '--no-live-install'],
      { fetch, clock: instantClock(), onStopSignal: (fn) => { fire = fn; } });
    assert.equal(r.code, 4);
    assert.equal(r.err.split('\n').filter((l) => l.includes('"stopping"')).length, 1);
  });

  it('with a live install to guard, refuses a hostname target without ever resolving it', async () => {
    const schedulePath = await planApi();
    let lookups = 0;
    let calls = 0;
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://soak-guest.example:3102', '--log', path.join(dir, 'l')],
      { fetch: async () => { calls++; return { status: 200, text: async () => '{}' }; }, lookup: async () => { lookups++; return ['192.168.64.7']; }, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'TARGET_NOT_IP_LITERAL');
    assert.deepEqual([lookups, calls], [0, 0]);
  });

  it('refuses a loopback IP on the live port', async () => {
    const schedulePath = await planApi();
    let calls = 0;
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://127.0.0.1:3102', '--log', path.join(dir, 'l')],
      { fetch: async () => { calls++; return { status: 200, text: async () => '{}' }; }, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'LIVE_INSTALL_TARGET');
    assert.equal(calls, 0);
  });

  it('records what the guards established in the header of a guarded run', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const fetch = async (url) => (url.pathname === '/api/server-info'
      ? { status: 200, text: async () => JSON.stringify({ startedAt: url.origin, startupSha: '9'.repeat(40) }) }
      : { status: 200, text: async () => '{}' });
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log], { fetch, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 0, r.err);
    const header = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
    assert.deepEqual(header.guard, { liveApi: 'http://localhost:3102', target: 'http://192.168.64.7:3102', targetAddress: '192.168.64.7', identity: { checked: true, reason: null } });
  });

  it('warns, and still runs, when only the target cannot be compared', async () => {
    const schedulePath = await planApi();
    const fetch = async (url) => {
      if (url.origin === 'http://localhost:3102') return { status: 200, text: async () => JSON.stringify({ startedAt: 'live', startupSha: 'd'.repeat(40) }) };
      return { status: 200, text: async () => '{}' };
    };
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', path.join(dir, 'l')],
      { fetch, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 0, r.err);
    const warning = JSON.parse(r.err.split('\n')[0]);
    assert.deepEqual([warning.warning, warning.liveUnverified], ['IDENTITY_UNCHECKED', false]);
  });

  it('refuses a schedule with fault or browser events outside the soak guest, before any load', async () => {
    const out = path.join(dir, 'full.json');
    await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '4', '--out', out]);
    const log = path.join(dir, 'l');
    let calls = 0;
    const r = await run(['run', '--schedule', out, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'],
      { fetch: async () => { calls++; return { status: 200, text: async () => '{}' }; }, clock: instantClock(), local: { run: async () => ({ code: 0, stdout: '0\n', stderr: '', error: null }) } });
    assert.equal(r.code, 3);
    const lines = r.err.trim().split('\n');
    const refusal = JSON.parse(lines[lines.length - 1]);
    assert.equal(refusal.code, 'LOCAL_CONTROL_REFUSED');
    assert.ok(refusal.details.problems.length >= 3, 'names the api, the home and the machine');
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(log), false);
  });

  it('has an executor for every kind in the catalogue, and names the local context it ran under', async () => {
    const catalogue = require('../lib/soak/schedule');
    assert.deepEqual(Object.keys(cli.RUN_EXECUTORS).sort(), [...catalogue.TASKS, ...catalogue.FAULTS].map((k) => k.kind).sort());
    const sched = require('../lib/soak/schedule');
    // A short api-and-fault schedule draws no fault, so one api event is
    // turned into a client abort, the one fault that needs nothing but HTTP.
    const s = sched.buildSchedule({ seed: 'local-run', phase: 'certifying', durationMs: 20 * 60 * 1000, classes: ['api', 'fault'], faultMeanMs: 60 * 60 * 1000 });
    const i = s.events.findIndex((e) => Object.keys(e.params).length === 0);
    s.events[i] = { ...s.events[i], kind: 'fault.client.abort', class: 'fault' };
    s.digest = sched.scheduleDigest(s);
    assert.deepEqual(sched.validateSchedule(s), []);
    const schedulePath = path.join(dir, 'local.json');
    fs.writeFileSync(schedulePath, JSON.stringify(s));
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-cli-home-')));
    fs.writeFileSync(path.join(home, 'tangleclaw.db'), '');
    try {
      const log = path.join(dir, 'local.ndjson');
      const fetch = async (url) => ({ status: 200, text: async () => JSON.stringify(url.pathname === '/api/server-info' ? { startedAt: 'A', startupSha: 'a'.repeat(40) } : {}) });
      const r = await run(['run', '--schedule', schedulePath, '--api', 'http://127.0.0.1:3102', '--log', log, '--no-live-install', '--home', home],
        { fetch, clock: instantClock(), local: { run: async () => ({ code: 0, stdout: '1\n', stderr: '', error: null }) } });
      assert.equal(r.code, 0, r.err);
      const recs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(recs[0].guard.local, { home, webdriver: null, uid: process.getuid() });
      const abort = recs.find((x) => x.kind === 'fault.client.abort');
      assert.equal(abort.ok, true, JSON.stringify(abort));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits 4 when stopped by a signal, and a second run resumes to completion', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'soak.ndjson');
    const fetch = async () => ({ status: 200, text: async () => '{}' });
    const clock = instantClock();
    let fire;
    let count = 0;
    const counting = async (...a) => { count++; if (count === 3) fire(); return fetch(...a); };
    const first = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'],
      { fetch: counting, clock, onStopSignal: (fn) => { fire = fn; } });
    assert.equal(first.code, 4);
    const second = await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'], { fetch, clock });
    assert.equal(second.code, 0, second.err);
    assert.equal(JSON.parse(second.out).status, 'completed');
    assert.ok(JSON.parse(second.out).resumedFrom > 0);
  });
});

describe('soak CLI — sample and bundle', () => {
  /**
   * Plan an api-only schedule into the temp dir.
   * @returns {Promise<string>} Schedule path
   */
  async function planApi() {
    const out = path.join(dir, 's.json');
    const r = await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '0.25', '--out', out, '--classes', 'api', '--load-mean-ms', '60000']);
    assert.equal(r.code, 0, r.err);
    return out;
  }

  /**
   * A guest home with a database, and a runner that answers as a VM.
   * @param {string} [vmm] - What `kern.hv_vmm_present` prints
   * @returns {{home: string, local: object}} Home and local deps
   */
  function guest(vmm = '1') {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'home-')));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(home, 'tangleclaw.db'));
    db.exec('CREATE TABLE t (v INTEGER)');
    db.close();
    const run = async (file) => {
      if (file === 'sysctl') return { code: 0, stdout: `${vmm}\n`, stderr: '', error: null };
      return { code: 1, stdout: '', stderr: '', error: '1' };
    };
    return { home, local: { run } };
  }
  const health = async () => ({ status: 200, text: async () => '{"status":"ok"}' });

  it('samples a guest home and exits 0', async () => {
    const g = guest();
    const out = path.join(dir, 'samples.ndjson');
    const r = await run(['sample', '--home', g.home, '--api', 'http://127.0.0.1:3102', '--out', out, '--no-live-install', '--count', '2', '--interval-ms', '1000'],
      { fetch: health, clock: instantClock(), local: g.local });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { taken: 2, lastSeq: 1 });
    assert.equal(fs.readFileSync(out, 'utf8').trim().split('\n').length, 3);
  });

  it('refuses to sample outside the guest, or beside a live install', async () => {
    const g = guest('0');
    const r = await run(['sample', '--home', g.home, '--api', 'http://127.0.0.1:3102', '--out', path.join(dir, 's'), '--no-live-install'], { fetch: health, clock: instantClock(), local: g.local });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err.trim()).code, 'LOCAL_CONTROL_REFUSED');
    const live = await run(['sample', '--home', g.home, '--api', 'http://127.0.0.1:3102', '--out', path.join(dir, 's'), '--no-live-install'], { fetch: health, clock: instantClock(), local: g.local, env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(live.code, 2);
    assert.equal(fs.existsSync(path.join(dir, 's')), false);
  });

  it('refuses a sample interval under a second', async () => {
    const g = guest();
    const r = await run(['sample', '--home', g.home, '--api', 'http://127.0.0.1:3102', '--out', path.join(dir, 's'), '--no-live-install', '--interval-ms', '10'], { local: g.local });
    assert.equal(r.code, 2);
  });

  it('bundles a run, with the guest database when --home is admitted', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'soak.ndjson');
    const fetch = async () => ({ status: 200, text: async () => '{}' });
    assert.equal((await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'], { fetch, clock: instantClock() })).code, 0);
    const g = guest();
    const out = path.join(dir, 'evidence');
    const r = await run(['bundle', '--candidate-sha', CAND, '--out', out, '--schedule', schedulePath, '--log', log, '--home', g.home, '--no-live-install'], { clock: instantClock(), local: g.local });
    assert.equal(r.code, 0, r.err);
    const res = JSON.parse(r.out);
    assert.equal(res.manifest, path.join(out, 'manifest.json'));
    const manifest = JSON.parse(fs.readFileSync(res.manifest, 'utf8'));
    assert.ok(manifest.files.some((f) => f.path === path.join('db', 'tangleclaw.db')));
    assert.equal(manifest.summary.log.ended, true);
  });

  it('bundles without --home anywhere, but snapshots a database only inside the guest', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'soak.ndjson');
    const fetch = async () => ({ status: 200, text: async () => '{}' });
    await run(['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'], { fetch, clock: instantClock() });
    const plain = await run(['bundle', '--candidate-sha', CAND, '--out', path.join(dir, 'e1'), '--schedule', schedulePath, '--log', log], { clock: instantClock() });
    assert.equal(plain.code, 0, plain.err);
    const g = guest('0');
    const refused = await run(['bundle', '--candidate-sha', CAND, '--out', path.join(dir, 'e2'), '--schedule', schedulePath, '--log', log, '--home', g.home, '--no-live-install'], { clock: instantClock(), local: g.local });
    assert.equal(refused.code, 3);
    assert.equal(fs.existsSync(path.join(dir, 'e2')), false);
    const stray = await run(['bundle', '--candidate-sha', CAND, '--out', path.join(dir, 'e3'), '--schedule', schedulePath, '--log', log, '--no-live-install'], { clock: instantClock() });
    assert.equal(stray.code, 2);
  });

  it('refuses to bundle into an existing directory with exit 3', async () => {
    const schedulePath = await planApi();
    fs.mkdirSync(path.join(dir, 'exists'));
    fs.writeFileSync(path.join(dir, 'l'), '');
    const r = await run(['bundle', '--candidate-sha', CAND, '--out', path.join(dir, 'exists'), '--schedule', schedulePath, '--log', path.join(dir, 'l')], { clock: instantClock() });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err.trim()).code, 'BUNDLE_REFUSED');
  });
  it('needs --candidate-sha (exit 2 when absent) and refuses one that is not a full SHA (exit 3)', async () => {
    const schedulePath = await planApi();
    fs.writeFileSync(path.join(dir, 'l'), '');
    const absent = await run(['bundle', '--out', path.join(dir, 'e1'), '--schedule', schedulePath, '--log', path.join(dir, 'l')], { clock: instantClock() });
    assert.equal(absent.code, 2);
    const short = await run(['bundle', '--candidate-sha', 'abc1234', '--out', path.join(dir, 'e2'), '--schedule', schedulePath, '--log', path.join(dir, 'l')], { clock: instantClock() });
    assert.equal(short.code, 3);
    assert.equal(JSON.parse(short.err.trim()).code, 'BUNDLE_REFUSED');
    assert.equal(fs.existsSync(path.join(dir, 'e2')), false);
  });
});

describe('soak CLI — the Operator login', () => {
  /**
   * Plan an api-only schedule, whose port leases write as the Operator.
   * @returns {Promise<string>} Schedule path
   */
  async function planApi() {
    const out = path.join(dir, 's.json');
    const r = await run(['plan', '--seed', 'op', '--phase', 'certifying', '--duration-hours', '0.25', '--out', out, '--classes', 'api', '--load-mean-ms', '60000']);
    assert.equal(r.code, 0, r.err);
    return out;
  }
  const guestRun = (schedulePath, log) => ['run', '--schedule', schedulePath, '--api', 'http://192.168.64.7:3102', '--log', log, '--no-live-install'];

  it('refuses a schedule that writes as the Operator with no --operator-login, before any load', async () => {
    const schedulePath = await planApi();
    const paths = [];
    const r = await run(guestRun(schedulePath, path.join(dir, 'l')), { operatorLogin: false, fetch: async (url) => { paths.push(url.pathname); return { status: 200, text: async () => '{}' }; }, clock: instantClock() });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err.trim().split('\n').pop()).code, 'OPERATOR_LOGIN_UNAVAILABLE');
    assert.deepEqual(paths, []);
    assert.equal(fs.existsSync(path.join(dir, 'l')), false);
  });

  for (const [label, prep, reason] of [
    ['readable by others', (f) => fs.chmodSync(f, 0o644), /must be 0600/],
    ['a symlink', (f) => { fs.renameSync(f, `${f}.real`); fs.symlinkSync(`${f}.real`, f); }, /is a symlink/],
    ['missing', (f) => fs.rmSync(f), /does not exist/],
    ['not JSON', (f) => fs.writeFileSync(f, `{"password": "${OPERATOR_PASSWORD}"`, { mode: 0o600 }), /is not JSON/],
    ['without a password', (f) => fs.writeFileSync(f, JSON.stringify({ username: 'soak-operator' }), { mode: 0o600 }), /non-empty "username" and "password"/]
  ]) {
    it(`refuses a login file that is ${label}, without quoting it and before any request`, async () => {
      const schedulePath = await planApi();
      const file = loginFile();
      prep(file);
      let calls = 0;
      const r = await run([...guestRun(schedulePath, path.join(dir, 'l')), '--operator-login', file], { operatorLogin: false, fetch: async () => { calls++; return { status: 200, text: async () => '{}' }; }, clock: instantClock() });
      assert.equal(r.code, 3);
      const refusal = JSON.parse(r.err.trim().split('\n').pop());
      assert.equal(refusal.code, 'OPERATOR_LOGIN_UNAVAILABLE');
      assert.match(refusal.message, reason);
      assert.ok(!r.err.includes(OPERATOR_PASSWORD));
      assert.equal(calls, 0);
    });
  }

  it('refuses a login the target will not accept, naming its code and nothing secret', async () => {
    const schedulePath = await planApi();
    const r = await run([...guestRun(schedulePath, path.join(dir, 'l')), '--operator-login', loginFile()],
      { operatorLogin: false, fetch: signedIn(async () => ({ status: 200, text: async () => '{}' }), { loginStatus: 401 }), clock: instantClock() });
    assert.equal(r.code, 3);
    const refusal = JSON.parse(r.err.trim().split('\n').pop());
    assert.deepEqual([refusal.code, refusal.details.serverCode, refusal.details.status], ['OPERATOR_LOGIN_FAILED', 'INVALID_CREDENTIALS', 401]);
    assert.ok(!r.err.includes(OPERATOR_PASSWORD));
  });

  it('signs in, sends the leases with the session, and records the account but no secret in the log or the output', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const leases = [];
    const fetch = async (url, init) => {
      if (url.pathname.startsWith('/api/ports/')) leases.push({ cookie: init.headers.cookie, csrf: init.headers['x-csrf-token'] });
      return { status: 200, text: async () => '{}' };
    };
    const r = await run(guestRun(schedulePath, log), { fetch, clock: instantClock() });
    assert.equal(r.code, 0, r.err);
    const recs = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(recs[0].operator, { username: 'soak-operator', gateState: 'armed', via: 'login' });
    assert.ok(leases.length > 0, 'the schedule leased ports');
    assert.ok(leases.every((l) => l.cookie === `tc_session=${SESSION_TOKEN}` && l.csrf === CSRF_TOKEN));
    const everything = [fs.readFileSync(log, 'utf8'), r.out, r.err].join('\n');
    for (const secret of [OPERATOR_PASSWORD, SESSION_TOKEN, CSRF_TOKEN]) assert.ok(!everything.includes(secret), `${secret} leaked`);
  });

  it('records the account on a resumed segment too', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const clock = instantClock();
    let fire;
    let calls = 0;
    const first = await run(guestRun(schedulePath, log), { fetch: async () => { if (++calls === 2) fire(); return { status: 200, text: async () => '{}' }; }, clock, onStopSignal: (fn) => { fire = fn; } });
    assert.equal(first.code, 4, first.err);
    const second = await run(guestRun(schedulePath, log), { fetch: async () => ({ status: 200, text: async () => '{}' }), clock });
    assert.equal(second.code, 0, second.err);
    const resume = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.type === 'resume');
    assert.deepEqual(resume.operator, { username: 'soak-operator', gateState: 'armed', via: 'login' });
    assert.ok(!fs.readFileSync(log, 'utf8').includes(OPERATOR_PASSWORD));
  });

  describe('operator-login', () => {
    it('creates the login file once, 0600, with a generated password it never prints, and keeps it on a second run', async () => {
      const file = path.join(dir, 'soak-operator-login.json');
      const first = await run(['operator-login', '--file', file, '--create']);
      assert.equal(first.code, 0, first.err);
      assert.deepEqual(JSON.parse(first.out), { file, created: true, username: 'soak-operator' });
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const login = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(login.username, 'soak-operator');
      assert.match(login.password, /^[A-Za-z0-9_-]{32}$/);
      assert.ok(!`${first.out}${first.err}`.includes(login.password));
      const second = await run(['operator-login', '--file', file, '--create']);
      assert.deepEqual(JSON.parse(second.out), { file, created: false, username: 'soak-operator' });
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).password, login.password, 'an existing login is never replaced');
      assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left');
    });

    it('refuses to keep an existing login file others can read', async () => {
      const file = loginFile();
      fs.chmodSync(file, 0o640);
      const r = await run(['operator-login', '--file', file, '--create']);
      assert.equal(r.code, 3);
      assert.match(JSON.parse(r.err).message, /must be 0600/);
    });

    /**
     * An empty private file, as mktemp makes one.
     * @param {string} name - File name in the temp dir
     * @returns {string} Its path
     */
    const privateFile = (name) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, '', { mode: 0o600 });
      fs.chmodSync(f, 0o600);
      return f;
    };

    it('writes the sign-in body only into the private file named, replacing what it held, and prints nothing', async () => {
      const file = loginFile();
      const body = privateFile('body');
      const r = await run(['operator-login', '--file', file, '--body', 'login', '--out', body]);
      assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
      assert.deepEqual(JSON.parse(fs.readFileSync(body, 'utf8')), { username: 'soak-operator', password: OPERATOR_PASSWORD });
      assert.equal(fs.statSync(body).mode & 0o777, 0o600);
      fs.writeFileSync(body, 'x'.repeat(500));
      const again = await run(['operator-login', '--file', file, '--body', 'login', '--out', body]);
      assert.deepEqual([again.code, again.out, again.err], [0, '', '']);
      assert.deepEqual(JSON.parse(fs.readFileSync(body, 'utf8')), { username: 'soak-operator', password: OPERATOR_PASSWORD }, 'what the file held was replaced, not appended to');
    });

    for (const [label, prep, reason] of [
      ['does not exist', (f) => fs.rmSync(f), /does not exist; it is never created here/],
      ['others can read', (f) => fs.chmodSync(f, 0o644), /must be 0600/],
      ['is a symlink', (f) => { fs.renameSync(f, `${f}.real`); fs.symlinkSync(`${f}.real`, f); }, /is a symlink/]
    ]) {
      it(`refuses to write a body into a file that ${label}, and writes the password nowhere`, async () => {
        const file = loginFile();
        const body = privateFile('body');
        prep(body);
        const r = await run(['operator-login', '--file', file, '--body', 'login', '--out', body]);
        assert.equal(r.code, 3);
        assert.match(JSON.parse(r.err).message, reason);
        assert.equal(r.out, '');
        assert.ok(!r.err.includes(OPERATOR_PASSWORD));
        if (fs.existsSync(`${body}.real`)) assert.equal(fs.readFileSync(`${body}.real`, 'utf8'), '', 'nothing was written through the link');
        if (fs.existsSync(body) && !fs.lstatSync(body).isSymbolicLink()) assert.equal(fs.readFileSync(body, 'utf8'), '');
      });
    }
  });
});
