'use strict';

// #1947: governed control hooks on a direct-mode HTTPS install. The server
// serves `https://localhost` with a certificate from the operator's mkcert
// root, which Node's bundled roots do not include, so the hook's plain fetch
// refused every governed commit, push and wrap. The hook now trusts that root,
// recorded in the marker as `caFile`, for a literal loopback origin only, with
// full verification. Everything here uses a throwaway CA made with openssl in
// a temp dir: no mkcert, and never the live service.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { execSync, execFileSync, spawnSync, spawn } = require('node:child_process');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const hooks = require('../lib/control-hooks');
const httpsSetup = require('../lib/https-setup');
const store = require('../lib/store');
const commitStep = require('../lib/wrap-steps/commit');
const { initRepo } = require('./_temp-repo');
const { cleanLaunchScope } = require('./_wrap-scope-fixture');

let tmpDir;
let pki;
let stub;

/**
 * Make a root CA (key + self-signed cert) in `dir`, named like mkcert's.
 * @param {string} dir - Destination (created)
 * @param {string} cn - Subject common name
 * @returns {{dir: string, cert: string, key: string}}
 */
function makeCa(dir, cn) {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'rootCA-key.pem');
  const cert = path.join(dir, 'rootCA.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${cn}`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', key, '-out', cert], { stdio: 'ignore' });
  return { dir, cert, key };
}

/**
 * Issue a localhost leaf (localhost, 127.0.0.1, ::1 — mkcert's defaults) from a CA.
 * @param {{cert: string, key: string}} ca - Issuer
 * @param {string} dir - Destination
 * @returns {{cert: string, key: string}}
 */
function makeLeaf(ca, dir) {
  const key = path.join(dir, 'key.pem');
  const csr = path.join(dir, 'leaf.csr');
  const cert = path.join(dir, 'cert.pem');
  const ext = path.join(dir, 'leaf.ext');
  fs.writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', key, '-out', csr], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', ca.cert, '-CAkey', ca.key, '-CAcreateserial',
    '-days', '2', '-extfile', ext, '-out', cert], { stdio: 'ignore' });
  return { cert, key };
}

/**
 * A stub control API over HTTPS in a child process: git runs hooks through a
 * synchronous spawn, which would block a stub served from this process. It
 * answers from a JSON file and appends one line per request to a hits file,
 * so a test can prove the hook never connected.
 */
const STUB_API = `
const https = require('https'); const fs = require('fs');
const [answers, hits, cert, key] = process.argv.slice(1);
const srv = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
  fs.appendFileSync(hits, req.url + '\\n');
  const id = new URL(req.url, 'https://x').searchParams.get('assignmentId');
  let all = {}; try { all = JSON.parse(fs.readFileSync(answers, 'utf8')); } catch {}
  const body = all[id];
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body || { code: 'ASSIGNMENT_NOT_FOUND' }));
});
srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port) + '\\n'));
`;

/**
 * Set what the stub answers for an assignment.
 * @param {string} id - Assignment id
 * @param {string} state - `active`, `held` or `stopped`
 * @returns {void}
 */
function setState(id, state) {
  const all = JSON.parse(fs.readFileSync(stub.answers, 'utf8'));
  const blocked = state === 'held' || state === 'stopped';
  all[id] = { assignmentId: id, state, stateGeneration: 2, blocked, code: blocked ? `CONTROL_${state.toUpperCase()}` : null };
  fs.writeFileSync(stub.answers, JSON.stringify(all));
}

/**
 * How many requests the stub has served.
 * @returns {number}
 */
function hitCount() {
  return fs.readFileSync(stub.hits, 'utf8').split('\n').filter(Boolean).length;
}

/**
 * A fresh repo with one commit on main and an empty hooks directory.
 * @param {string} name - Prefix
 * @returns {string} Path
 */
function repo(name) {
  const dir = fs.mkdtempSync(path.join(tmpDir, `${name}-`));
  initRepo(dir);
  execSync('git config user.email t@example.com && git config user.name Test && git config commit.gpgsign false', { cwd: dir, shell: '/bin/sh' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  execSync('git add a.txt && git commit --quiet -m init && git branch -M main', { cwd: dir, shell: '/bin/sh' });
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  return dir;
}

/**
 * Try a commit; return whether git accepted it and what it said.
 * @param {string} dir - Checkout
 * @returns {{ok: boolean, stderr: string}}
 */
function tryCommit(dir) {
  fs.appendFileSync(path.join(dir, 'a.txt'), 'x\n');
  const r = spawnSync('git', ['commit', '-am', 'change'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) execSync('git checkout -- a.txt', { cwd: dir });
  return { ok: r.status === 0, stderr: r.stderr };
}

/**
 * A governed checkout whose marker points at `api`, with `caFile` when given.
 * @param {string} name - Repo prefix
 * @param {string} api - Marker origin
 * @param {string|null} caFile - Local trust anchor
 * @returns {string} Checkout path
 */
function governed(name, api, caFile) {
  const dir = repo(name);
  hooks.install(dir, { assignmentId: `asg_${name}`, api, caFile });
  return dir;
}

describe('control hooks over direct-mode HTTPS (#1947)', () => {
  let localApi;

  before(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-hooks-https-')));
    const ca = makeCa(path.join(tmpDir, 'caroot'), 'Throwaway mkcert-like CA');
    const other = makeCa(path.join(tmpDir, 'other-caroot'), 'Some other CA');
    const leafDir = path.join(tmpDir, 'certs');
    fs.mkdirSync(leafDir);
    pki = { ca, other, leaf: makeLeaf(ca, leafDir) };
    stub = { answers: path.join(tmpDir, 'answers.json'), hits: path.join(tmpDir, 'hits.log') };
    fs.writeFileSync(stub.answers, '{}');
    fs.writeFileSync(stub.hits, '');
    stub.proc = spawn(process.execPath, ['-e', STUB_API, stub.answers, stub.hits, pki.leaf.cert, pki.leaf.key], { stdio: ['ignore', 'pipe', 'inherit'] });
    stub.port = await new Promise((resolve, reject) => {
      stub.proc.stdout.once('data', (d) => resolve(String(d).trim()));
      stub.proc.once('error', reject);
    });
    localApi = `https://localhost:${stub.port}`;
  });

  after(() => {
    stub.proc.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => fs.writeFileSync(stub.answers, '{}'));

  describe('the hook', () => {
    it('trusts the local root for https://localhost: an ACTIVE lane commits, a HELD one is refused', () => {
      const dir = governed('ok', localApi, pki.ca.cert);
      setState('asg_ok', 'active');
      const r = tryCommit(dir);
      assert.equal(r.ok, true, r.stderr);
      setState('asg_ok', 'held');
      const held = tryCommit(dir);
      assert.equal(held.ok, false);
      assert.match(held.stderr, /CONTROL_HELD/);
    });

    it('trusts the local root for the literal https://127.0.0.1 too', () => {
      const dir = governed('ip', `https://127.0.0.1:${stub.port}`, pki.ca.cert);
      setState('asg_ip', 'active');
      const r = tryCommit(dir);
      assert.equal(r.ok, true, r.stderr);
    });

    it('with no trust anchor, the mkcert-style certificate is untrusted and the commit fails closed, saying so', () => {
      const dir = governed('untrusted', localApi, null);
      setState('asg_untrusted', 'active');
      const r = tryCommit(dir);
      assert.equal(r.ok, false);
      assert.match(r.stderr, /certificate at localhost:\d+ is not trusted \([A-Z_]+\)/);
      assert.match(r.stderr, /fails closed/);
    });

    it('a trust anchor that did not issue the certificate fails closed', () => {
      const dir = governed('wrongca', localApi, pki.other.cert);
      setState('asg_wrongca', 'active');
      const r = tryCommit(dir);
      assert.equal(r.ok, false);
      assert.match(r.stderr, /is not trusted/);
    });

    it('an unreachable or refusing HTTPS origin fails closed as unreachable', () => {
      const dir = governed('down', 'https://localhost:9', pki.ca.cert);
      const r = tryCommit(dir);
      assert.equal(r.ok, false);
      assert.match(r.stderr, /TangleClaw is unreachable, so this governed checkout fails closed/);
    });

    it('refuses the trust anchor for any non-loopback origin before connecting — including names that resolve to loopback', () => {
      const before = hitCount();
      for (const host of ['localhost.', 'example.invalid', '127.0.0.1.nip.io', 'localhost.example.com']) {
        const dir = governed(`nonloop-${host.replace(/\W/g, '')}`, `https://${host}:${stub.port}`, pki.ca.cert);
        const r = tryCommit(dir);
        assert.equal(r.ok, false, host);
        assert.match(r.stderr, /refusing a local trust anchor for the non-loopback origin/, host);
      }
      assert.equal(hitCount(), before, 'no request reached the API');
    });

    it('a trust anchor beside a plain-http origin, or an unreadable one, fails closed', () => {
      const http = governed('anchorhttp', `http://127.0.0.1:${stub.port}`, pki.ca.cert);
      assert.match(tryCommit(http).stderr, /local trust anchor for a non-HTTPS origin/);
      const missing = governed('anchorgone', localApi, path.join(tmpDir, 'nope', 'rootCA.pem'));
      assert.match(tryCommit(missing).stderr, /local trust anchor .*rootCA\.pem is unreadable/);
    });

    it('a push is checked over HTTPS the same way: allowed ACTIVE, refused HELD', () => {
      const dir = governed('push', localApi, pki.ca.cert);
      const remote = fs.mkdtempSync(path.join(tmpDir, 'remote-'));
      initRepo(remote, ['--bare']);
      execSync(`git remote add origin ${remote}`, { cwd: dir });
      setState('asg_push', 'active');
      const ok = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir, encoding: 'utf8' });
      assert.equal(ok.status, 0, ok.stderr);
      setState('asg_push', 'held');
      execSync('git commit --quiet --allow-empty --no-verify -m more', { cwd: dir });
      const held = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir, encoding: 'utf8' });
      assert.notEqual(held.status, 0);
      assert.match(held.stderr, /pre-push refused: this lane is CONTROL_HELD/);
    });
  });

  describe('the marker', () => {
    it('records caFile only when one is given', () => {
      const withAnchor = governed('marker-a', localApi, pki.ca.cert);
      const m = JSON.parse(fs.readFileSync(path.join(withAnchor, '.git', hooks.MARKER_FILE), 'utf8'));
      assert.equal(m.caFile, pki.ca.cert);
      const without = governed('marker-b', `http://127.0.0.1:${stub.port}`, null);
      const n = JSON.parse(fs.readFileSync(path.join(without, '.git', hooks.MARKER_FILE), 'utf8'));
      assert.equal('caFile' in n, false);
    });
  });

  describe('localTrustAnchor', () => {
    const httpsConfig = () => ({ httpsEnabled: true, httpsCertPath: pki.leaf.cert, httpsKeyPath: pki.leaf.key });

    it('returns the rootCA.pem that issued the served certificate', () => {
      assert.equal(httpsSetup.localTrustAnchor(httpsConfig(), { caroots: [pki.other.dir, pki.ca.dir] }), pki.ca.cert);
    });

    it('returns null for a root that did not issue it, for plain http, behind Caddy, and for an unreadable certificate', () => {
      assert.equal(httpsSetup.localTrustAnchor(httpsConfig(), { caroots: [pki.other.dir] }), null);
      assert.equal(httpsSetup.localTrustAnchor({ httpsEnabled: false }, { caroots: [pki.ca.dir] }), null);
      assert.equal(httpsSetup.localTrustAnchor({ ...httpsConfig(), ingressMode: 'caddy' }, { caroots: [pki.ca.dir] }), null);
      assert.equal(httpsSetup.localTrustAnchor({ ...httpsConfig(), httpsCertPath: path.join(tmpDir, 'none.pem') }, { caroots: [pki.ca.dir] }), null);
    });
  });

  describe('the wrap commit', () => {
    let storeDir;
    let n = 0;

    before(() => {
      storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-hooks-https-store-'));
      store._setBasePath(storeDir);
      store.init();
    });

    after(() => {
      store.close();
      fs.rmSync(storeDir, { recursive: true, force: true });
    });

    /**
     * Run the wrap's commit step on a governed HTTPS checkout with one edit.
     * @param {string} state - What the stub answers for the lane
     * @returns {Promise<{result: object, dir: string, headBefore: string}>}
     */
    async function wrapCommit(state) {
      n += 1;
      const dir = governed(`wrap${n}`, localApi, pki.ca.cert);
      const cfg = store.projectConfig.load(dir);
      cfg.wrapAutoPrEnabled = false;
      store.projectConfig.save(dir, cfg);
      execSync('git add -f .tangleclaw/project.json && git commit --quiet --no-verify -m config', { cwd: dir, shell: '/bin/sh' });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'the session\'s work\n');
      setState(`asg_wrap${n}`, state);
      const project = store.projects.create({ name: `wrap-https-${n}`, path: dir });
      const headBefore = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
      const result = await commitStep.run({
        project: { name: project.name, path: dir, id: project.id },
        session: null,
        step: { id: 'commit', kind: 'commit', blocker: true },
        previousResults: [],
        staged: {},
        options: { allowDirectToMain: true },
        scope: cleanLaunchScope(dir)
      });
      return { result, dir, headBefore };
    }

    it('commits through the hook on an ACTIVE lane — the path #1947 refused', async () => {
      const { result, dir, headBefore } = await wrapCommit('active');
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.notEqual(execSync('git rev-parse HEAD', { cwd: dir }).toString().trim(), headBefore);
    });

    it('is refused by the hook on a HELD lane, committing nothing', async () => {
      const { result, dir, headBefore } = await wrapCommit('held');
      assert.equal(result.ok, false);
      assert.match(JSON.stringify(result), /CONTROL_HELD/);
      assert.equal(execSync('git rev-parse HEAD', { cwd: dir }).toString().trim(), headBefore);
    });
  });

  describe('end to end: a real HTTPS instance writes the marker and its hook answers', () => {
    let storeDir;
    let server;
    const saved = { port: process.env.TANGLECLAW_PORT, caroot: process.env.CAROOT };

    before(async () => {
      // A launched pane exports TANGLECLAW_PORT, which outranks config: left
      // in place, the marker would name the live server.
      delete process.env.TANGLECLAW_PORT;
      process.env.CAROOT = pki.ca.dir;
      storeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-hooks-https-e2e-')));
      store._setBasePath(storeDir);
      store.init();
      const { createServer } = require('../server');
      server = createServer({ httpsEnabled: true, certPath: pki.leaf.cert, keyPath: pki.leaf.key });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      store.config.save({ ...store.config.load(), serverPort: server.address().port, httpsEnabled: true, httpsCertPath: pki.leaf.cert, httpsKeyPath: pki.leaf.key });
    });

    after(async () => {
      for (const [k, v] of [['TANGLECLAW_PORT', saved.port], ['CAROOT', saved.caroot]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await new Promise((resolve) => server.close(resolve));
      store.close();
      fs.rmSync(storeDir, { recursive: true, force: true });
    });

    /**
     * A JSON request to the HTTPS test instance, trusting the throwaway root.
     * @param {string} method - HTTP method
     * @param {string} urlPath - Path
     * @param {object} [body] - JSON body
     * @returns {Promise<{status: number, raw: string, data: object}>}
     */
    function send(method, urlPath, body) {
      const port = server.address().port;
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : '';
        const r = https.request({
          host: '127.0.0.1', port, path: urlPath, method, ca: fs.readFileSync(pki.ca.cert), agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: `https://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' }
        }, (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            let data = null;
            try { data = JSON.parse(raw); } catch { data = null; }
            resolve({ status: res.statusCode, raw, data });
          });
        });
        r.on('error', reject);
        r.end(payload);
      });
    }

    /**
     * Run a command without blocking this process's event loop, which serves the API the hook calls.
     * @param {string} cmd - Command
     * @param {string[]} args - Arguments
     * @param {string} cwd - Directory
     * @returns {Promise<{code: number, stderr: string}>}
     */
    function run(cmd, args, cwd) {
      return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        p.stderr.on('data', (d) => { stderr += d; });
        p.on('error', reject);
        p.on('close', (code) => resolve({ code, stderr }));
      });
    }

    it('governing a project writes https://localhost with the issuing root, and a shell commit passes through the real server', async () => {
      const dir = repo('e2e');
      const project = store.projects.create({ name: 'e2e-https', path: dir, engine: 'claude' });
      const created = await send('POST', '/api/control/assignments', { projectId: project.id, requestId: 'https-e2e', issueRef: '#1947' });
      assert.equal(created.status, 201, created.raw);
      require('../lib/sessions').syncControlHooks(project);
      const marker = JSON.parse(fs.readFileSync(path.join(dir, '.git', hooks.MARKER_FILE), 'utf8'));
      assert.equal(marker.api, `https://localhost:${server.address().port}`);
      assert.equal(marker.caFile, path.join(pki.ca.dir, 'rootCA.pem'));
      fs.appendFileSync(path.join(dir, 'a.txt'), 'x\n');
      const r = await run('git', ['commit', '-am', 'governed commit over https'], dir);
      assert.equal(r.code, 0, r.stderr);
    });

    it('an https origin with no issuing root on record is logged, naming where it looked, and the marker carries no caFile', async () => {
      const dir = repo('e2e-noroot');
      const project = store.projects.create({ name: 'e2e-https-noroot', path: dir, engine: 'claude' });
      const created = await send('POST', '/api/control/assignments', { projectId: project.id, requestId: 'https-e2e-noroot', issueRef: '#1947' });
      assert.equal(created.status, 201, created.raw);
      process.env.CAROOT = pki.other.dir;
      let out = '';
      setConsoleStream({ write: (line) => { out += line; } });
      setLevel('warn');
      try {
        require('../lib/sessions').syncControlHooks(project);
      } finally {
        setLevel('error');
        setConsoleStream(null);
        process.env.CAROOT = pki.ca.dir;
      }
      assert.match(out, /no local root CA issued the served certificate/);
      assert.match(out, /mkcert -CAROOT/);
      const marker = JSON.parse(fs.readFileSync(path.join(dir, '.git', hooks.MARKER_FILE), 'utf8'));
      assert.equal('caFile' in marker, false);
    });
  });
});
