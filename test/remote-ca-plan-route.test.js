'use strict';

// #2886: GET /api/https/remote-ca-plan, the thin read-only route over
// lib/remote-ca-installer.js#planInstall. A plain GET with no caller
// identity to prove (same shape as GET /api/scorecard) -- planInstall
// itself, and the lib/https-setup.js#getRemoteTrustInstructions it wraps,
// are pure and touch neither the filesystem nor a real mkcert install.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');

function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(body); } catch { data = null; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/https/remote-ca-plan (#2886)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-remote-ca-plan-'));
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

  it('400 when caRootPath is missing', async () => {
    const r = await get(server, '/api/https/remote-ca-plan');
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'BAD_REQUEST');
  });

  it('returns every platform\'s trust-install step, plus the stage step, when platform is omitted', async () => {
    const r = await get(server, `/api/https/remote-ca-plan?caRootPath=${encodeURIComponent('/ca')}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.caRootPath, '/ca');
    assert.equal(r.data.rootCaPath, path.join('/ca', 'rootCA.pem'));
    assert.equal(r.data.steps[0].kind, 'stage-ca-file');
    assert.equal(r.data.steps[0].privileged, false);
    const platforms = r.data.steps.filter((s) => s.kind === 'trust-install').map((s) => s.platform);
    assert.deepEqual(platforms, ['macOS', 'Linux', 'Windows']);
    assert.ok(r.data.steps.every((s) => s.kind !== 'trust-install' || s.privileged === true));
  });

  it('narrows to one platform\'s trust-install step when platform is given', async () => {
    const r = await get(server, `/api/https/remote-ca-plan?caRootPath=${encodeURIComponent('/ca')}&platform=Linux`);
    assert.equal(r.status, 200);
    const trustSteps = r.data.steps.filter((s) => s.kind === 'trust-install');
    assert.equal(trustSteps.length, 1);
    assert.equal(trustSteps[0].platform, 'Linux');
  });

  it('ignores an unrecognized platform value rather than erroring, falling back to every platform', async () => {
    const r = await get(server, `/api/https/remote-ca-plan?caRootPath=${encodeURIComponent('/ca')}&platform=BeOS`);
    assert.equal(r.status, 200);
    const trustSteps = r.data.steps.filter((s) => s.kind === 'trust-install');
    assert.equal(trustSteps.length, 3);
  });
});
