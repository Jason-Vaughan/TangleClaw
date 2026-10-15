'use strict';

// The read-only host check (#1380, #2142). These pin each row state and exit
// code from fixtures, per-site certificate coverage, redaction, the bounded
// /api/ports read, the trust result, the run budget and the name cap, and —
// over a REAL run under spies — that a run writes nothing, opens no database
// and runs nothing outside its three allowed commands. No test changes
// Tailscale, keychain or Caddy state: commands are stubs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { setLevel } = require('../lib/logger');
const hostCheck = require('../lib/host-check');

setLevel('error');

const FIXTURES = path.join(__dirname, 'fixtures', 'host-check');
const CERTS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'certs.json'), 'utf8'));
const TS = 'box.tailexample.ts.net';
const KEY_MATERIAL = 'FIXTURE-KEY-MATERIAL-never-printed';

/**
 * Read a fixture file as text.
 * @param {...string} parts - Path under the fixture directory.
 * @returns {string}
 */
function fixture(...parts) {
  return fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8');
}

/**
 * A temporary TangleClaw home holding certificates, a decoy key, a mkcert
 * root directory, and optionally a Caddyfile fixture and a config.
 * @param {{caddyfile?: string|null, config?: object|null, leafA?: string}} [opts]
 * @returns {{home: string, caroot: string, cleanup: function(): void}}
 */
function makeHome(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-check-'));
  const home = path.join(root, 'home');
  const caroot = path.join(root, 'caroot');
  fs.mkdirSync(path.join(home, 'certs'), { recursive: true });
  fs.mkdirSync(caroot);
  fs.writeFileSync(path.join(home, 'certs', 'leaf-a.pem'), opts.leafA || CERTS.leafA);
  fs.writeFileSync(path.join(home, 'certs', 'leaf-b.pem'), CERTS.leafB);
  fs.writeFileSync(path.join(home, 'certs', 'key-decoy.pem'), `-----BEGIN PRIVATE KEY-----\n${KEY_MATERIAL}\n-----END PRIVATE KEY-----\n`);
  fs.writeFileSync(path.join(caroot, 'rootCA.pem'), CERTS.rootCA);
  fs.writeFileSync(path.join(caroot, 'rootCA-key.pem'), KEY_MATERIAL);
  const caddyfile = opts.caddyfile === undefined ? 'v1-multihost.caddyfile' : opts.caddyfile;
  if (caddyfile) {
    fs.writeFileSync(path.join(home, 'Caddyfile'), fixture('caddyfiles', caddyfile).replaceAll('/fixture/home', home));
  }
  const config = opts.config === undefined ? { ingressMode: 'caddy', caddyTailnetHost: TS, serverPort: 3101 } : opts.config;
  if (config) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return { home, caroot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * A stub `execFile` answering from a table keyed by `cmd arg0 arg1 …` (or
 * `cmd arg0` as a prefix). A missing entry behaves like a missing binary; the
 * string `hang` never answers; an Error is returned as the command failure.
 * @param {object} table - Answers.
 * @returns {function & {calls: object[]}}
 */
function fakeExec(table) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    const entry = table[[cmd, ...args].join(' ')] ?? table[`${cmd} ${args[0]}`];
    if (entry === undefined) {
      const e = Object.assign(new Error('spawn SECRET-ERROR-TEXT ENOENT'), { code: 'ENOENT' });
      setImmediate(() => cb(e, '', ''));
      return;
    }
    if (entry === 'hang') return;
    if (entry instanceof Error) {
      setImmediate(() => cb(entry, entry.stdout || '', entry.stderr || ''));
      return;
    }
    setImmediate(() => cb(null, entry, ''));
  };
  fn.calls = calls;
  return fn;
}

/**
 * A stub `http` module whose single request is answered by `respond`.
 * @param {function(object, EventEmitter, function): void} respond - Answers.
 * @returns {{request: function, calls: object[]}}
 */
function fakeHttp(respond) {
  const calls = [];
  return {
    calls,
    request(options, cb) {
      calls.push(options);
      const req = new EventEmitter();
      req.end = () => setImmediate(() => respond(options, req, cb));
      req.destroy = () => {};
      return req;
    }
  };
}

/**
 * A responder that answers with a status and a JSON body.
 * @param {number} status - HTTP status.
 * @param {*} [body] - Body.
 * @returns {function}
 */
function answer(status, body) {
  return (opts, req, cb) => {
    const res = new EventEmitter();
    res.statusCode = status;
    res.resume = () => {};
    cb(res);
    if (body !== undefined) res.emit('data', Buffer.from(JSON.stringify(body)));
    res.emit('end');
  };
}

const LEASES = { leases: [{ port: 3101, host: 'localhost', project: 'fixture-project-name', service: 'server' }] };

/**
 * The stub table for a healthy host.
 * @param {object} [overrides] - Entries to replace.
 * @returns {object}
 */
function healthyCommands(overrides = {}) {
  return {
    'tailscale status --json': fixture('tailscale', 'status-running.json'),
    'tailscale serve status --json': fixture('tailscale', 'serve-routes.json'),
    'security verify-cert': 'certificate verification successful.\n',
    ...overrides
  };
}

/**
 * A dns.lookup stub resolving every name to one tailnet address.
 * @param {object} [failures] - Name → error code.
 * @returns {function}
 */
function fakeLookup(failures = {}) {
  return (name, opts, cb) => {
    if (failures[name]) {
      setImmediate(() => cb(Object.assign(new Error('lookup SECRET-ERROR-TEXT'), { code: failures[name] })));
      return;
    }
    setImmediate(() => cb(null, [{ address: '100.64.0.7', family: 4 }]));
  };
}

// Synthetic secrets spelled exactly like Node and errno codes: upper case,
// `E` or `ERR_` first, nothing but letters, digits and underscores. Each holds
// `QX7`, which no known code contains.
const CODE_SHAPED_SECRETS = ['ERR_TOKEN_SECRET_QX7', 'ESECRETQX7', 'EAI_QX7'];

/**
 * Run the check against a home with stubbed dependencies.
 * @param {object} h - From makeHome.
 * @param {object} [deps] - Dependency overrides.
 * @param {object} [options] - runHostCheck options.
 * @returns {Promise<{rows: object[], exitCode: number}>}
 */
function run(h, deps = {}, options = {}) {
  return hostCheck.runHostCheck({
    baseDir: h.home,
    ...options,
    deps: {
      execFile: fakeExec(healthyCommands()),
      http: fakeHttp(answer(200, LEASES)),
      dnsLookup: fakeLookup(),
      env: { CAROOT: h.caroot },
      platform: 'darwin',
      homedir: () => '/fixture-user-home',
      hostname: () => 'fixturehost',
      // Never this machine's real launchd plist: the port comes from the fixture config.
      serverPlistPath: '/nonexistent/host-check-test.plist',
      ...deps
    }
  });
}

/**
 * The row with an id.
 * @param {{rows: object[]}} result - A run.
 * @param {string} id - Row id.
 * @returns {object}
 */
function row(result, id) {
  const r = result.rows.find((x) => x.id === id);
  assert.ok(r, `row ${id} present`);
  return r;
}

describe('host-check: the command allow-list', () => {
  it('accepts exactly the three commands and refuses everything else', () => {
    assert.equal(hostCheck.isAllowedCommand('tailscale', ['status', '--json']), true);
    assert.equal(hostCheck.isAllowedCommand('tailscale', ['serve', 'status', '--json']), true);
    assert.equal(hostCheck.isAllowedCommand('security', ['verify-cert', '-c', '/x/rootCA.pem']), true);
    assert.equal(hostCheck.isAllowedCommand('tailscale', ['status']), false);
    assert.equal(hostCheck.isAllowedCommand('tailscale', ['serve', '--bg', '3101']), false);
    assert.equal(hostCheck.isAllowedCommand('tailscale', ['status', '--json', '--peers']), false);
    assert.equal(hostCheck.isAllowedCommand('security', ['verify-cert', '-c']), false);
    assert.equal(hostCheck.isAllowedCommand('security', ['add-trusted-cert', '-c', '/x']), false);
    assert.equal(hostCheck.isAllowedCommand('mkcert', ['-CAROOT']), false);
    assert.equal(hostCheck.isAllowedCommand('sh', ['-c', 'tailscale status --json']), false);
  });

  it('throws before running a command off the list', () => {
    const exec = fakeExec({});
    assert.throws(() => hostCheck.runAllowed({ execFile: exec }, 'mkcert', ['-install']), /not on the allow-list/);
    assert.equal(exec.calls.length, 0);
  });

  it('runs allowed commands with no shell, a 5 s timeout and a 1 MiB stdout cap', async () => {
    const exec = fakeExec(healthyCommands());
    await hostCheck.runAllowed({ execFile: exec }, 'tailscale', ['status', '--json']);
    assert.equal(exec.calls[0].opts.shell, false);
    assert.equal(exec.calls[0].opts.timeout, 5000);
    assert.equal(exec.calls[0].opts.maxBuffer, 1024 * 1024);
  });
});

describe('host-check T-H1: states and exit codes', () => {
  it('an explicit multi-host v1 layout on a healthy host is ok, exit 0', async () => {
    const h = makeHome();
    try {
      const result = await run(h);
      for (const r of result.rows) assert.ok(['ok', 'observed'].includes(r.state), `${r.id} is ${r.state} (${r.reason})`);
      assert.equal(row(result, 'caddyfile').state, 'ok');
      assert.equal(result.exitCode, 0);
    } finally { h.cleanup(); }
  });

  it('two tls sites headed by one DNS name with no topology marker are ambiguous, exit 3', async () => {
    const h = makeHome({ caddyfile: 'two-tls-sites.caddyfile' });
    try {
      const result = await run(h);
      assert.equal(row(result, 'caddyfile').state, 'ambiguous');
      assert.equal(result.exitCode, 3);
    } finally { h.cleanup(); }
  });

  it('an unsupported shape is unknown, never ok or drift, exit 4', async () => {
    const h = makeHome({ caddyfile: 'unsupported-import.caddyfile' });
    try {
      const result = await run(h);
      const r = row(result, 'caddyfile');
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /unsupported shape: .*snippet/);
      assert.equal(row(result, 'coverage').state, 'unknown');
      assert.equal(result.exitCode, 4);
    } finally { h.cleanup(); }
  });

  it('a configured tailnet host that is not the tailnet name is drift, exit 3', async () => {
    const h = makeHome({ config: { ingressMode: 'caddy', caddyTailnetHost: 'old.tailexample.ts.net' } });
    try {
      const result = await run(h);
      assert.equal(row(result, 'config').state, 'drift');
      assert.equal(result.exitCode, 3);
    } finally { h.cleanup(); }
  });

  it('a Caddyfile missing while ingressMode is caddy is drift; in direct mode it is observed', async () => {
    const caddy = makeHome({ caddyfile: null });
    const direct = makeHome({ caddyfile: null, config: { ingressMode: 'direct' } });
    try {
      assert.equal(row(await run(caddy), 'caddyfile').state, 'drift');
      const r = await run(direct);
      assert.equal(row(r, 'caddyfile').state, 'observed');
      assert.equal(row(r, 'coverage').state, 'observed');
    } finally { caddy.cleanup(); direct.cleanup(); }
  });

  it('an expired certificate is drift', async () => {
    const h = makeHome();
    try {
      const future = Date.parse('2040-01-01T00:00:00Z');
      const result = await run(h, { now: () => future });
      assert.equal(row(result, 'certificates').state, 'drift');
    } finally { h.cleanup(); }
  });

  const tailnetCases = [
    ['cli-absent', {}],
    ['daemon-stopped', { 'tailscale status --json': fixture('tailscale', 'status-stopped.json') }],
    ['daemon-needslogin', { 'tailscale status --json': fixture('tailscale', 'status-needslogin.json') }],
    ['magicdns-off', { 'tailscale status --json': fixture('tailscale', 'status-magicdns-off.json') }],
    ['no-name', { 'tailscale status --json': fixture('tailscale', 'status-no-name.json') }],
    ['unparseable', { 'tailscale status --json': 'not json' }],
    ['probe-timeout', { 'tailscale status --json': Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) }],
    ['output-too-large', { 'tailscale status --json': Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }],
    ['daemon-unreachable', { 'tailscale status --json': Object.assign(new Error('failed to connect'), { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' }) }]
  ];
  for (const [reason, entries] of tailnetCases) {
    it(`tailnet identity: ${reason} is unknown with that reason`, async () => {
      const h = makeHome();
      try {
        const table = reason === 'cli-absent' ? {} : healthyCommands(entries);
        const result = await run(h, { execFile: fakeExec(table) });
        const r = row(result, 'tailnet');
        assert.equal(r.state, 'unknown');
        assert.equal(r.reason, reason);
        assert.notEqual(result.exitCode, 0);
      } finally { h.cleanup(); }
    });
  }

  it('a declared name no site answers is drift', async () => {
    const h = makeHome({ config: { ingressMode: 'caddy', caddyTailnetHost: TS, publicDomain: 'public.example.org' } });
    try {
      const r = row(await run(h), 'coverage');
      assert.equal(r.state, 'drift');
      assert.ok(r.facts.some((f) => f.label === 'declared but answered by no site' && f.value === 'public.example.org'));
    } finally { h.cleanup(); }
  });

  it('agrees with the product\'s reader: two blocks for ONE host, or a ported header, are not ambiguous', async () => {
    const h = makeHome({ caddyfile: 'two-tls-sites.caddyfile' });
    try {
      const same = fixture('caddyfiles', 'two-tls-sites.caddyfile').replaceAll('/fixture/home', h.home).replace('old.tailexample.ts.net {', `${TS} {`);
      fs.writeFileSync(path.join(h.home, 'Caddyfile'), same);
      assert.notEqual(row(await run(h), 'caddyfile').state, 'ambiguous');
      const ported = fixture('caddyfiles', 'two-tls-sites.caddyfile').replaceAll('/fixture/home', h.home).replace('old.tailexample.ts.net {', 'old.tailexample.ts.net:8443 {');
      fs.writeFileSync(path.join(h.home, 'Caddyfile'), ported);
      assert.notEqual(row(await run(h), 'caddyfile').state, 'ambiguous');
    } finally { h.cleanup(); }
  });

  it('the journal row claims nothing it did not check', async () => {
    const h = makeHome();
    try {
      const r = row(await run(h), 'journal');
      assert.equal(r.state, 'observed');
      assert.equal(r.reason, 'journal inspection unsupported in this version; not checked');
    } finally { h.cleanup(); }
  });

  it('an undeclared tailnet name with no Caddy site is observed, and says nothing else was checked', async () => {
    const h = makeHome({ config: { ingressMode: 'caddy' }, caddyfile: 'per-site-certs.caddyfile' });
    try {
      fs.writeFileSync(path.join(h.home, 'Caddyfile'), `localhost {\n\ttls ${h.home}/certs/leaf-a.pem ${h.home}/certs/key-decoy.pem\n}\n`);
      const r = row(await run(h), 'coverage');
      const f = r.facts.find((x) => x.value === TS);
      assert.ok(f);
      assert.match(f.label, /undeclared tailnet name/);
      assert.match(f.label, /not checked elsewhere/);
      assert.equal(r.state, 'ok');
    } finally { h.cleanup(); }
  });

  it('a name that does not resolve locally is drift, labelled local-only', async () => {
    const h = makeHome();
    try {
      const r = row(await run(h, { dnsLookup: fakeLookup({ 'alias.example.com': 'ENOTFOUND' }) }), 'resolution');
      assert.equal(r.state, 'drift');
      assert.match(r.label, /local-only/);
    } finally { h.cleanup(); }
  });
});

describe('host-check T-H2: per-site coverage', () => {
  it('judges each site against its own certificate, not the union', async () => {
    const h = makeHome({ caddyfile: 'per-site-certs.caddyfile' });
    try {
      const r = row(await run(h), 'coverage');
      assert.equal(r.state, 'drift');
      // leaf-a carries localhost, but site 2 serves localhost with leaf-b, which does not.
      assert.ok(r.facts.some((f) => f.label === 'site 2 NOT covered by its own certificate' && f.value === 'localhost'));
      assert.ok(r.facts.some((f) => f.label === 'site 2 covered' && f.value === 'alias.example.com'));
      assert.ok(r.facts.some((f) => f.label === 'site 1 covered' && f.value === TS));
    } finally { h.cleanup(); }
  });

  it('matches an IP site address against the certificate\'s IP SANs', async () => {
    const h = makeHome({ caddyfile: 'per-site-certs.caddyfile' });
    try {
      fs.writeFileSync(path.join(h.home, 'Caddyfile'), `127.0.0.1 {\n\ttls ${h.home}/certs/leaf-a.pem ${h.home}/certs/key-decoy.pem\n}\n10.9.9.9 {\n\ttls ${h.home}/certs/leaf-a.pem ${h.home}/certs/key-decoy.pem\n}\n`);
      const r = row(await run(h), 'coverage');
      assert.ok(r.facts.some((f) => f.label === 'site 1 covered' && f.value === '127.0.0.1'));
      assert.ok(r.facts.some((f) => f.label === 'site 2 NOT covered by its own certificate' && f.value === '10.9.9.9'));
    } finally { h.cleanup(); }
  });
});

describe('host-check T-H3: redaction', () => {
  it('the default output carries none of the fixture\'s names, addresses, paths, users, URLs or error texts', async () => {
    const h = makeHome({ caddyfile: 'two-tls-sites.caddyfile', config: { ingressMode: 'caddy', caddyTailnetHost: TS, primaryUrl: `https://${TS}:8443/?token=fixture-config-secret` } });
    try {
      const result = await run(h, { execFile: fakeExec(healthyCommands({ 'security verify-cert': Object.assign(new Error('SECRET-ERROR-TEXT'), { code: 9 }) })) });
      const text = hostCheck.formatReport(result);
      for (const secret of ['tailexample', 'alias.example', '100.64.0.7', h.home, os.tmpdir(), 'fixtureuser', 'FIXTUREHASH',
        'fixture-route-secret', 'fixture-config-secret', 'fixture-project-name', 'fixturehost', 'SECRET-ERROR-TEXT', KEY_MATERIAL, '127.0.0.1:3101', 'https://']) {
        assert.ok(!text.includes(secret), `default output leaks ${secret}`);
      }
      assert.match(text, /<host-1>/);
      assert.match(text, /<path-1>/);
      assert.ok(!text.startsWith('PRIVATE'));
    } finally { h.cleanup(); }
  });

  it('--reveal shows values under a PRIVATE banner but never credentials, hashes, key bytes or query tokens', async () => {
    const h = makeHome({ caddyfile: 'two-tls-sites.caddyfile', config: { ingressMode: 'caddy', caddyTailnetHost: TS, primaryUrl: `https://u:p@${TS}:8443/?token=fixture-config-secret` } });
    try {
      const text = hostCheck.formatReport(await run(h), { reveal: true });
      assert.ok(text.startsWith('PRIVATE'));
      assert.ok(text.includes(TS));
      for (const secret of ['FIXTUREHASH', 'fixtureuser', KEY_MATERIAL, 'fixture-route-secret', 'fixture-config-secret', 'u:p@']) {
        assert.ok(!text.includes(secret), `--reveal leaks ${secret}`);
      }
    } finally { h.cleanup(); }
  });

  it('never reads a key file, the decoy beside the certificate or the mkcert root key', async () => {
    const h = makeHome();
    const reads = [];
    const spyFs = { ...fs, readFileSync: (p, ...rest) => { reads.push(String(p)); return fs.readFileSync(p, ...rest); } };
    try {
      await run(h, { fs: spyFs });
      assert.ok(reads.length > 0);
      assert.ok(!reads.some((p) => p.endsWith('key-decoy.pem') || p.endsWith('rootCA-key.pem')), reads.join('\n'));
    } finally { h.cleanup(); }
  });

  it('tokens are stable within one run', () => {
    const r = new hostCheck.Redactor(false);
    assert.equal(r.render('a.example', 'host'), r.render('a.example', 'host'));
    assert.notEqual(r.render('a.example', 'host'), r.render('b.example', 'host'));
    assert.equal(r.render('localhost', 'host'), 'localhost');
  });
});

describe('host-check T-H4: routes and leases', () => {
  it('a serve route with no lease is observed, and a leased one names its project', async () => {
    const h = makeHome();
    try {
      const r = row(await run(h), 'routes');
      assert.equal(r.state, 'observed');
      assert.ok(r.facts.some((f) => f.label === '  lease' && f.value === 'unleased'));
      assert.ok(r.facts.some((f) => f.label === '  leased by' && f.value === 'fixture-project-name'));
    } finally { h.cleanup(); }
  });

  it('no serve routes at all is observed, with none listed', async () => {
    const h = makeHome();
    try {
      const r = row(await run(h, { execFile: fakeExec(healthyCommands({ 'tailscale serve status --json': fixture('tailscale', 'serve-empty.json') })) }), 'routes');
      assert.equal(r.state, 'observed');
      assert.ok(r.facts.some((f) => f.label === 'routes' && f.value === 'none'));
    } finally { h.cleanup(); }
  });

  it('an unreachable server is unknown', async () => {
    const h = makeHome();
    try {
      const unreachable = fakeHttp((o, req) => req.emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' })));
      const r = row(await run(h, { http: unreachable }), 'routes');
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /server-unreachable/);
    } finally { h.cleanup(); }
  });

  it('opens no database file and leaves the home exactly as it was', async () => {
    const h = makeHome();
    const listing = () => fs.readdirSync(h.home, { recursive: true }).sort();
    try {
      const before = listing();
      await run(h);
      assert.deepEqual(listing(), before);
    } finally { h.cleanup(); }
  });
});

describe('host-check T-H5: local trust', () => {
  it('the specific not-trusted result is drift', async () => {
    const h = makeHome();
    try {
      const notTrusted = Object.assign(new Error('exit 1'), { code: 1, stdout: 'Cert Verify Result: CSSMERR_TP_NOT_TRUSTED\n', stderr: '' });
      const r = row(await run(h, { execFile: fakeExec(healthyCommands({ 'security verify-cert': notTrusted })) }), 'trust');
      assert.equal(r.state, 'drift');
    } finally { h.cleanup(); }
  });

  it('any other security failure is unknown', async () => {
    const h = makeHome();
    try {
      const other = Object.assign(new Error('exit 2'), { code: 2, stdout: 'Cert Verify Result: CSSMERR_TP_CERT_EXPIRED\n', stderr: '' });
      const r = row(await run(h, { execFile: fakeExec(healthyCommands({ 'security verify-cert': other })) }), 'trust');
      assert.equal(r.state, 'unknown');
    } finally { h.cleanup(); }
  });

  it('is unknown on a platform without the keychain check, and runs no command there', async () => {
    const h = makeHome();
    try {
      const exec = fakeExec(healthyCommands());
      const r = row(await run(h, { platform: 'linux', execFile: exec }), 'trust');
      assert.equal(r.state, 'unknown');
      assert.ok(!exec.calls.some((c) => c.cmd === 'security'));
    } finally { h.cleanup(); }
  });

  it('a certificate the local root did not issue is unknown, not trusted', async () => {
    const h = makeHome({ leafA: CERTS.leafOther, caddyfile: 'two-tls-sites.caddyfile' });
    try {
      const r = row(await run(h), 'trust');
      assert.equal(r.state, 'unknown');
    } finally { h.cleanup(); }
  });
});

describe('host-check T-H6: the run budget', () => {
  it('a command that hangs leaves its row unknown: budget exhausted, and the run ends within budget plus 1 s', async () => {
    const h = makeHome();
    try {
      const budgetMs = 300;
      const started = Date.now();
      const result = await run(h, { execFile: fakeExec(healthyCommands({ 'tailscale status --json': 'hang' })) }, { budgetMs });
      const elapsed = Date.now() - started;
      assert.ok(elapsed < budgetMs + 1000, `took ${elapsed} ms`);
      const r = row(result, 'tailnet');
      assert.equal(r.state, 'unknown');
      assert.equal(r.reason, 'budget exhausted');
      assert.equal(result.exitCode, 4);
    } finally { h.cleanup(); }
  });
});

describe('host-check T-H7: carry-ins', () => {
  it('(a) more than 64 names reports names unknown: truncated and a non-zero exit', async () => {
    const aliases = Array.from({ length: 70 }, (_, i) => `alias${i}.example.com`);
    const h = makeHome({ config: { ingressMode: 'caddy', caddyTailnetHost: TS, urlAliases: aliases } });
    try {
      const result = await run(h);
      const r = row(result, 'names');
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /^truncated \(\d+ not checked\)$/);
      assert.notEqual(result.exitCode, 0);
    } finally { h.cleanup(); }
  });

  it('(b) proposed certificate names are labelled advisory', async () => {
    const h = makeHome();
    try {
      const r = row(await run(h), 'proposed');
      assert.equal(r.state, 'observed');
      assert.ok(r.facts.some((f) => f.value === hostCheck.ADVISORY_LABEL));
      assert.ok(hostCheck.formatReport({ rows: [r], exitCode: 0 }).includes('advisory: what a new certificate would likely carry; not guaranteed to match the product\'s minting'));
    } finally { h.cleanup(); }
  });

  it('(c) /api/ports is one loopback GET with no credentials of any kind', async () => {
    const h = makeHome();
    try {
      const fake = fakeHttp(answer(200, LEASES));
      await run(h, { http: fake, env: { CAROOT: h.caroot, TANGLECLAW_SERVICE_TOKEN: 'svc', TANGLECLAW_LAUNCH_ID: 'launch' } });
      assert.equal(fake.calls.length, 1);
      const o = fake.calls[0];
      assert.equal(o.host, '127.0.0.1');
      assert.equal(o.method, 'GET');
      assert.equal(o.path, '/api/ports');
      assert.equal(o.port, 3101);
      assert.deepEqual(Object.keys(o.headers), ['accept']);
      assert.ok(o.timeout > 0);
    } finally { h.cleanup(); }
  });

  for (const [status, reason] of [[401, 'refused-401'], [403, 'refused-403'], [302, 'redirect'], [307, 'redirect']]) {
    it(`(c) a ${status} answer is unknown (${reason}) and is not followed`, async () => {
      const h = makeHome();
      try {
        const fake = fakeHttp(answer(status));
        const r = row(await run(h, { http: fake }), 'routes');
        assert.equal(r.state, 'unknown');
        assert.match(r.reason, new RegExp(reason));
        assert.equal(fake.calls.length, 1);
      } finally { h.cleanup(); }
    });
  }

  it('(c) no answer is unknown', async () => {
    const h = makeHome();
    try {
      const silent = fakeHttp((o, req) => req.emit('timeout'));
      const r = row(await run(h, { http: silent }), 'routes');
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /server-timeout/);
    } finally { h.cleanup(); }
  });
});

describe('host-check: the /api/ports read over HTTPS keeps TLS verification', () => {
  const httpsConfig = { ingressMode: 'direct', httpsEnabled: true, httpsCertPath: '/x/cert.pem', httpsKeyPath: '/x/key.pem', serverPort: 3101 };

  it('a TLS verification failure is unknown, with one attempt and no insecure retry', async () => {
    const h = makeHome({ config: httpsConfig });
    try {
      const tlsFail = fakeHttp((o, req) => req.emit('error', Object.assign(new Error('self-signed SECRET-ERROR-TEXT'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })));
      const plain = fakeHttp(answer(200, LEASES));
      const result = await run(h, { https: tlsFail, http: plain });
      const r = row(result, 'routes');
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /tls-unverified/);
      assert.equal(tlsFail.calls.length, 1);
      assert.equal(plain.calls.length, 0, 'no fallback to plain HTTP');
      assert.notEqual(tlsFail.calls[0].rejectUnauthorized, false);
      assert.ok(!r.facts.some((f) => f.label === '  leased by'), 'no lease data from an unverified read');
    } finally { h.cleanup(); }
  });

  it('the module never turns certificate verification off', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'host-check.js'), 'utf8');
    assert.ok(!/rejectUnauthorized/.test(source));
    assert.ok(!/NODE_TLS_REJECT_UNAUTHORIZED/.test(source));
  });
});

describe('host-check: the server port is the installed server\'s, not this process\'s', () => {
  it('reads the port from the launchd plist when one exists, over config and TANGLECLAW_PORT', async () => {
    const h = makeHome();
    const plist = path.join(path.dirname(h.home), 'server.plist');
    fs.writeFileSync(plist, '<plist><dict><key>TANGLECLAW_PORT</key>\n<string>4567</string></dict></plist>');
    try {
      const fake = fakeHttp(answer(200, LEASES));
      await run(h, { http: fake, serverPlistPath: plist, env: { CAROOT: h.caroot, TANGLECLAW_PORT: '3999' } });
      assert.equal(fake.calls[0].port, 4567);
    } finally { h.cleanup(); }
  });

  it('falls back to config when there is no plist', async () => {
    const h = makeHome({ config: { ingressMode: 'caddy', caddyTailnetHost: TS, serverPort: 3555 } });
    try {
      const fake = fakeHttp(answer(200, LEASES));
      await run(h, { http: fake });
      assert.equal(fake.calls[0].port, 3555);
    } finally { h.cleanup(); }
  });
});

describe('host-check: size bounds', () => {
  const big = (n) => `${'#'.repeat(n)}\n`;

  it('a config.json over 1 MiB is unknown: config-too-large', async () => {
    const h = makeHome();
    try {
      fs.writeFileSync(path.join(h.home, 'config.json'), `{"pad":"${'x'.repeat(hostCheck.LIMITS.configBytes)}"}`);
      assert.equal(row(await run(h), 'config').reason, 'config-too-large');
    } finally { h.cleanup(); }
  });

  it('a Caddyfile over 1 MiB is unknown: caddyfile-too-large', async () => {
    const h = makeHome();
    try {
      fs.writeFileSync(path.join(h.home, 'Caddyfile'), big(hostCheck.LIMITS.caddyfileBytes));
      const r = row(await run(h), 'caddyfile');
      assert.equal(r.state, 'unknown');
      assert.equal(r.reason, 'caddyfile-too-large');
    } finally { h.cleanup(); }
  });

  it('a certificate file over 64 KiB is unknown and is not parsed', async () => {
    const h = makeHome();
    try {
      fs.writeFileSync(path.join(h.home, 'certs', 'leaf-a.pem'), CERTS.leafA + big(hostCheck.LIMITS.certificateBytes));
      const r = row(await run(h), 'certificates');
      assert.equal(r.state, 'unknown');
      assert.ok(r.facts.some((f) => f.label === 'unreadable' && f.value === 'too-large'));
    } finally { h.cleanup(); }
  });

  it('an /api/ports body over 1 MiB is unknown: output-too-large', async () => {
    const h = makeHome();
    try {
      const huge = fakeHttp((o, req, cb) => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = () => {};
        cb(res);
        res.emit('data', Buffer.alloc(hostCheck.LIMITS.portsBodyBytes + 1, 32));
        res.emit('end');
      });
      const r = row(await run(h, { http: huge }), 'routes');
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /output-too-large/);
    } finally { h.cleanup(); }
  });
});

describe('host-check: a row that throws', () => {
  it('reports internal-error, and --reveal shows only the error class, never its message or stack', async () => {
    const h = makeHome();
    try {
      const result = await run(h, { hostname: () => { throw new Error('boom at /private/fixture/path'); } });
      const r = row(result, 'proposed');
      assert.equal(r.state, 'unknown');
      assert.equal(r.reason, 'internal-error');
      const revealed = hostCheck.formatReport(result, { reveal: true });
      assert.ok(!hostCheck.formatReport(result).includes('boom at'));
      assert.ok(!revealed.includes('boom at'), 'the message never reaches --reveal');
      assert.ok(!revealed.includes('host-check.test.js'), 'no stack frame reaches --reveal');
      assert.ok(revealed.includes('    diagnostic: Error\n'));
    } finally { h.cleanup(); }
  });

  it('keeps a code only when it is a known one', async () => {
    const h = makeHome();
    try {
      const coded = await run(h, { hostname: () => { throw Object.assign(new TypeError('x'), { code: 'EACCES' }); } });
      assert.equal(row(coded, 'proposed').reason, 'internal-error:EACCES');
      assert.ok(hostCheck.formatReport(coded, { reveal: true }).includes('    diagnostic: TypeError EACCES\n'));
      const shaped = await run(h, { hostname: () => { throw Object.assign(new Error('x'), { code: 'sentinel-code /tmp/qx7' }); } });
      assert.equal(row(shaped, 'proposed').reason, 'internal-error');
      assert.ok(!hostCheck.formatReport(shaped, { reveal: true }).includes('qx7'));
      for (const secret of CODE_SHAPED_SECRETS) {
        const spelled = await run(h, { hostname: () => { throw Object.assign(new TypeError('x'), { code: secret }); } });
        assert.equal(row(spelled, 'proposed').reason, 'internal-error', secret);
        const revealed = hostCheck.formatReport(spelled, { reveal: true });
        assert.ok(revealed.includes('    diagnostic: TypeError\n'), secret);
        for (const text of [hostCheck.formatReport(spelled), revealed]) assert.ok(!text.includes('QX7'), `${secret} leaks`);
      }
    } finally { h.cleanup(); }
  });

  it('never names a custom error class or prints a thrown non-error value', async () => {
    class SentinelQx7Error extends Error {}
    const h = makeHome();
    try {
      const custom = await run(h, { hostname: () => { throw new SentinelQx7Error('x'); } });
      assert.ok(hostCheck.formatReport(custom, { reveal: true }).includes('    diagnostic: Error\n'));
      const thrownString = await run(h, { hostname: () => { throw 'sentinel-thrown-qx7'; } });
      const text = hostCheck.formatReport(thrownString, { reveal: true });
      assert.ok(!text.includes('qx7'));
      assert.ok(text.includes('    diagnostic: non-error-value\n'));
    } finally { h.cleanup(); }
  });
});

describe('host-check: values read from files and commands reach codes and reasons only through closed sets', () => {
  /**
   * Both renderings of a run.
   * @param {{rows: object[], exitCode: number}} result - A run.
   * @returns {{plain: string, revealed: string}}
   */
  function both(result) {
    return { plain: hostCheck.formatReport(result), revealed: hostCheck.formatReport(result, { reveal: true }) };
  }

  it('an unsupported ingressMode is unknown, printed as a fixed word in both outputs', async () => {
    const h = makeHome({ config: { ingressMode: 'SENTINEL-INGRESS-qx7', caddyTailnetHost: TS, serverPort: 3101 } });
    try {
      const result = await run(h);
      const r = row(result, 'config');
      assert.equal(r.state, 'unknown');
      assert.equal(r.reason, 'ingressMode-unsupported');
      assert.deepEqual(r.facts.find((f) => f.label === 'ingressMode'), { label: 'ingressMode', value: 'unsupported', kind: 'code' });
      assert.equal(result.exitCode, 4);
      const { plain, revealed } = both(result);
      assert.ok(!plain.includes('qx7') && !revealed.includes('qx7'));
    } finally { h.cleanup(); }
  });

  it('an ingressMode that is not a string is unsupported too', async () => {
    const h = makeHome({ config: { ingressMode: { mode: 'sentinel-qx7' }, caddyTailnetHost: TS } });
    try {
      const result = await run(h);
      assert.equal(row(result, 'config').reason, 'ingressMode-unsupported');
      assert.ok(!both(result).revealed.includes('qx7'));
    } finally { h.cleanup(); }
  });

  it('with no Caddyfile, an unsupported ingressMode is unknown, not observed, and its value is not printed', async () => {
    const h = makeHome({ caddyfile: null, config: { ingressMode: 'SENTINEL-INGRESS-qx7' } });
    try {
      const result = await run(h);
      const r = row(result, 'caddyfile');
      assert.equal(r.state, 'unknown');
      assert.equal(r.reason, 'absent; ingressMode unsupported');
      const { plain, revealed } = both(result);
      assert.ok(!plain.includes('qx7') && !revealed.includes('qx7'));
    } finally { h.cleanup(); }
  });

  it('an absent ingressMode is the default, direct', async () => {
    const h = makeHome({ caddyfile: null, config: { caddyTailnetHost: TS } });
    try {
      const result = await run(h);
      assert.equal(row(result, 'config').facts[0].value, 'direct');
      assert.equal(row(result, 'caddyfile').reason, 'absent (ingressMode direct)');
    } finally { h.cleanup(); }
  });

  it('an unsupported topology marker version is unknown and never printed or kept', async () => {
    const h = makeHome();
    try {
      const file = path.join(h.home, 'Caddyfile');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/tangleclaw-topology v1/, 'tangleclaw-topology SENTINEL-MARKER-qx7'));
      const result = await run(h);
      const r = row(result, 'caddyfile');
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /topology-version/);
      assert.equal(r.facts.find((f) => f.label === 'topology').value, 'marker of an unsupported version');
      const { plain, revealed } = both(result);
      assert.ok(!plain.includes('qx7') && !revealed.includes('qx7'));
      assert.ok(!JSON.stringify(hostCheck.parseCaddyfile(fs.readFileSync(file, 'utf8'))).includes('qx7'));
    } finally { h.cleanup(); }
  });

  it('a BackendState outside Tailscale\'s set is daemon-unrecognized-state; a missing one is daemon-unknown', async () => {
    const h = makeHome();
    try {
      const odd = await run(h, { execFile: fakeExec(healthyCommands({ 'tailscale status --json': JSON.stringify({ BackendState: 'SENTINEL-BACKEND-qx7' }) })) });
      assert.equal(row(odd, 'tailnet').reason, 'daemon-unrecognized-state');
      assert.ok(!both(odd).revealed.includes('qx7') && !both(odd).revealed.toLowerCase().includes('sentinel-backend'));
      const missing = await run(h, { execFile: fakeExec(healthyCommands({ 'tailscale status --json': '{}' })) });
      assert.equal(row(missing, 'tailnet').reason, 'daemon-unknown');
    } finally { h.cleanup(); }
  });

  it('a lookup error code that is not a known one is lookup-failed, however it is spelled; a known code is kept', async () => {
    const h = makeHome();
    try {
      const odd = await run(h, { dnsLookup: fakeLookup({ 'alias.example.com': 'sentinel dns /qx7' }) });
      const r = row(odd, 'resolution');
      assert.ok(r.facts.some((f) => f.label === '  result' && f.value === 'lookup-failed'));
      assert.ok(!both(odd).revealed.includes('qx7'));
      for (const secret of CODE_SHAPED_SECRETS) {
        const spelled = await run(h, { dnsLookup: fakeLookup({ 'alias.example.com': secret }) });
        assert.ok(row(spelled, 'resolution').facts.some((f) => f.label === '  result' && f.value === 'lookup-failed'), secret);
        const { plain, revealed } = both(spelled);
        assert.ok(!plain.includes('QX7') && !revealed.includes('QX7'), `${secret} leaks`);
      }
      const errno = await run(h, { dnsLookup: fakeLookup({ 'alias.example.com': 'EAI_AGAIN' }) });
      assert.ok(row(errno, 'resolution').facts.some((f) => f.label === '  result' && f.value === 'EAI_AGAIN'));
    } finally { h.cleanup(); }
  });

  it('safeErrorCode keeps the codes on its list and nothing else, however code-like', () => {
    for (const code of ['ENOENT', 'EACCES', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ERR_INVALID_ARG_TYPE']) {
      assert.equal(hostCheck.safeErrorCode({ code }), code);
    }
    for (const code of [...CODE_SHAPED_SECRETS, 'EFIXTURE', 'enoent', 'E', 'EACCES /tmp/x', 'token=abc', 'NOT_E_PREFIXED', 'E'.repeat(65), 9]) {
      assert.equal(hostCheck.safeErrorCode({ code }), null, String(code));
    }
    assert.equal(hostCheck.safeErrorCode(null), null);
    assert.equal(hostCheck.safeErrorCode('ENOENT'), null);
  });

  it('with a sentinel in every input at once, the default output holds none of them, and --reveal none of the code-channel ones', async () => {
    const h = makeHome({
      caddyfile: null,
      config: {
        ingressMode: 'SENTINEL-INGRESS-qx7',
        caddyTailnetHost: 'th-qx7.tailexample.ts.net',
        primaryUrl: 'https://pu-qx7.example.com:8443/?token=tok-qx7',
        urlAliases: ['al-qx7.example.com', { host: 'al2-qx7.example.com' }, 'not a name qx7'],
        publicDomain: 'pd-qx7.example.com',
        serverPort: 3101
      }
    });
    try {
      fs.writeFileSync(path.join(h.home, 'Caddyfile'), [
        '# tangleclaw-topology SENTINEL-MARKER-qx7',
        'site-qx7.example.com {',
        `  tls ${h.home}/certs/leaf-a.pem ${h.home}/certs/key-qx7.pem`,
        '  basic_auth {',
        '    user-qx7 HASH-qx7',
        '  }',
        '  reverse_proxy 127.0.0.1:3101',
        '}',
        'http://site-qx7.example.com {',
        '  redir https://rd-qx7.example.com{uri}?k=tok3-qx7',
        '}',
        ''
      ].join('\n'));
      const serve = { Web: { 'srv-qx7.tailexample.ts.net:443': { Handlers: { '/p-qx7': { Proxy: 'http://127.0.0.1:3101/?k=tok2-qx7' } } } }, TCP: { 4430: { TCPForward: '127.0.0.1:4430' } } };
      const status = { BackendState: 'Running', CurrentTailnet: { MagicDNSEnabled: true }, Self: { DNSName: 'self-qx7.tailexample.ts.net.' } };
      const result = await run(h, {
        execFile: fakeExec(healthyCommands({
          'tailscale status --json': JSON.stringify(status),
          'tailscale serve status --json': JSON.stringify(serve),
          'security verify-cert': Object.assign(new Error('verify-qx7'), { code: 9, stderr: 'stderr-qx7' })
        })),
        http: fakeHttp(answer(200, { leases: [{ port: 3101, host: 'localhost', project: 'proj-qx7', service: 'svc-qx7' }] })),
        dnsLookup: fakeLookup({ 'pd-qx7.example.com': 'lookupcode-qx7' }),
        hostname: () => 'mdns-qx7',
        homedir: () => '/home-qx7'
      });
      const { plain, revealed } = both(result);
      assert.ok(!plain.toLowerCase().includes('qx7'), `default output leaks a sentinel:\n${plain}`);
      for (const secret of ['SENTINEL-INGRESS', 'SENTINEL-MARKER', 'tok-qx7', 'tok2-qx7', 'tok3-qx7', 'lookupcode-qx7', 'verify-qx7', 'stderr-qx7', 'user-qx7', 'HASH-qx7', 'key-qx7']) {
        assert.ok(!revealed.includes(secret), `--reveal leaks ${secret}`);
      }
      assert.ok(revealed.includes('self-qx7.tailexample.ts.net'), '--reveal still shows the names it is for');
    } finally { h.cleanup(); }
  });
});

describe('host-check: the Caddyfile reader', () => {
  it('reads sites, tls files, redirects and the topology marker', () => {
    const parsed = hostCheck.parseCaddyfile(fixture('caddyfiles', 'v1-multihost.caddyfile'));
    assert.deepEqual(parsed.unsupported, []);
    assert.equal(parsed.marker.version, 'v1');
    assert.equal(parsed.sites.length, 4);
    assert.equal(parsed.sites[2].redirect, `https://${TS}:8443`);
    assert.equal(parsed.sites[3].addresses[0].scheme, 'http');
  });

  it('never keeps basic_auth contents', () => {
    const parsed = hostCheck.parseCaddyfile(fixture('caddyfiles', 'two-tls-sites.caddyfile'));
    assert.ok(!JSON.stringify(parsed).includes('FIXTUREHASH'));
    assert.ok(!JSON.stringify(parsed).includes('fixtureuser'));
  });

  it('an unknown topology marker version is unsupported', () => {
    const parsed = hostCheck.parseCaddyfile('# tangleclaw-topology v2 primary=x\nlocalhost {\n}\n');
    assert.ok(parsed.unsupported.includes('topology-version'));
  });

  it('a site without braces is unsupported', () => {
    assert.ok(hostCheck.parseCaddyfile('localhost\nreverse_proxy 127.0.0.1:3101\n').unsupported.includes('unbraced-site'));
  });
});

describe('host-check: the command line', () => {
  const script = path.join(__dirname, '..', 'scripts', 'host-check.js');

  /**
   * Run the script with `runHostCheck` replaced by one that rejects with an
   * error carrying `code`.
   * @param {*} errorCode - The rejected error's `code`.
   * @returns {Promise<{code: number, stdout: string, stderr: string, lines: string[]}>}
   */
  async function runFailing(errorCode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-check-fail-'));
    try {
      const preload = path.join(dir, 'reject.js');
      fs.writeFileSync(preload, `const hc = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'host-check.js'))});\n`
        + `hc.runHostCheck = async () => { throw Object.assign(new Error('SECRET-ERROR-TEXT at /private/fixture/path'), { code: ${JSON.stringify(errorCode)} }); };\n`);
      const { code, stdout, stderr } = await new Promise((resolve) => {
        execFile(process.execPath, ['-r', preload, script], (err, out, errOut) => resolve({ code: err ? err.code : 0, stdout: out, stderr: errOut }));
      });
      const lines = stderr.split('\n').filter((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l));
      return { code, stdout, stderr, lines };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  it('a failure outside every row exits 4 with one line naming only the error code', async () => {
    const { code, stdout, stderr, lines } = await runFailing('EACCES');
    assert.equal(code, 4);
    assert.deepEqual(lines, ['host-check failed: EACCES']);
    assert.ok(!`${stdout}${stderr}`.includes('SECRET-ERROR-TEXT'));
    assert.ok(!`${stdout}${stderr}`.includes('/private/fixture/path'));
  });

  it('a failure whose code is not a known one prints internal-error, never the code', async () => {
    const { code, stdout, stderr, lines } = await runFailing('sentinel-code /private/qx7');
    assert.equal(code, 4);
    assert.deepEqual(lines, ['host-check failed: internal-error']);
    assert.ok(!`${stdout}${stderr}`.includes('qx7'));
  });

  it('a failure whose code is spelled like an errno code but is not a known one prints internal-error', async () => {
    for (const secret of CODE_SHAPED_SECRETS) {
      const { code, stdout, stderr, lines } = await runFailing(secret);
      assert.equal(code, 4, secret);
      assert.deepEqual(lines, ['host-check failed: internal-error'], secret);
      assert.ok(!`${stdout}${stderr}`.includes('QX7'), `${secret} leaks`);
    }
  });

  it('a usage error exits 2', async () => {
    const code = await new Promise((resolve) => {
      execFile(process.execPath, [script, '--bogus'], (err) => resolve(err ? err.code : 0));
    });
    assert.equal(code, 2);
  });
});

describe('host-check T-H0: a real run under spies writes nothing and runs nothing off the allow-list', () => {
  let h;
  let server;
  let port;
  let report;
  let stdout;
  let exitCode;

  before(async () => {
    h = makeHome();
    const bin = path.join(path.dirname(h.home), 'bin');
    fs.mkdirSync(bin);
    // Stub binaries: the real run execs these, so no Tailscale or keychain state is read or changed.
    fs.writeFileSync(path.join(bin, 'tailscale'),
      `#!/bin/sh\nif [ "$1" = "serve" ]; then cat "${path.join(FIXTURES, 'tailscale', 'serve-routes.json')}"; else cat "${path.join(FIXTURES, 'tailscale', 'status-running.json')}"; fi\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\necho "certificate verification successful."\n', { mode: 0o755 });
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(LEASES));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    fs.writeFileSync(path.join(h.home, 'config.json'), JSON.stringify({ ingressMode: 'caddy', caddyTailnetHost: TS, serverPort: port }));
    const reportPath = path.join(path.dirname(h.home), 'spy-report.json');
    // HOME points at the temporary root, so the installed-server plist lookup
    // finds nothing real and the port comes from this test's config.
    const env = { ...process.env, HOME: path.dirname(h.home), TANGLECLAW_HOME: h.home, CAROOT: h.caroot, HOST_CHECK_SPY_REPORT: reportPath, PATH: `${bin}:${process.env.PATH}` };
    delete env.TANGLECLAW_PORT;
    const listingBefore = fs.readdirSync(h.home, { recursive: true }).sort();
    ({ stdout, exitCode } = await new Promise((resolve) => {
      execFile(process.execPath, ['-r', path.join(FIXTURES, 'spy-preload.js'), path.join(__dirname, '..', 'scripts', 'host-check.js')],
        { env, timeout: 30000 }, (err, out) => resolve({ stdout: out, exitCode: err ? err.code : 0 }));
    }));
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    report.listingBefore = listingBefore;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (h) h.cleanup();
  });

  it('completes and prints a report', () => {
    assert.match(stdout, /TangleClaw host check \(read-only\)/);
    assert.ok([0, 3, 4].includes(exitCode), `exit ${exitCode}`);
  });

  it('writes no file and leaves the home unchanged', () => {
    assert.deepEqual(report.writes, []);
    assert.deepEqual(fs.readdirSync(h.home, { recursive: true }).sort(), report.listingBefore);
  });

  it('runs only allow-listed commands, through execFile', () => {
    assert.ok(report.execs.length > 0);
    for (const e of report.execs) {
      assert.equal(e.fn, 'execFile');
      assert.ok(hostCheck.isAllowedCommand(path.basename(e.cmd), e.args), `${e.cmd} ${e.args.join(' ')}`);
    }
  });

  it('opens one loopback request to /api/ports, with no credentials, and no other socket', () => {
    assert.equal(report.requests.length, 1);
    const r = report.requests[0];
    assert.equal(r.host, '127.0.0.1');
    assert.equal(r.port, port);
    assert.equal(r.path, '/api/ports');
    assert.deepEqual(r.headers, ['accept']);
    for (const s of report.sockets) assert.ok(['127.0.0.1', 'localhost', null].includes(s.host) && (s.port === null || s.port === port), JSON.stringify(s));
  });

  it('never opens the database, initializes the store or starts file logging', () => {
    assert.deepEqual(report.database, []);
    assert.equal(report.storeInit, 0);
    assert.equal(report.fileLogging, 0);
  });

  it('never reads a private key', () => {
    assert.ok(!report.reads.some((p) => p.endsWith('key-decoy.pem') || p.endsWith('rootCA-key.pem')));
  });
});
