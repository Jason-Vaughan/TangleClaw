'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { createServer } = require('../server');

setLevel('error');

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);

    if (body) {
      const bodyStr = JSON.stringify(body);
      req.setHeader('Content-Length', Buffer.byteLength(bodyStr));
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('API /api/upload + /api/uploads', () => {
  let tmpDir;
  let server;
  let projectName;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-uploads-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a test project
    projectName = 'upload-test-proj';
    const projDir = path.join(tmpDir, projectName);
    fs.mkdirSync(projDir, { recursive: true });
    store.projects.create({
      name: projectName,
      path: projDir,
      engine: 'claude',
      methodology: 'minimal',
      tags: [],
      ports: {}
    });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/upload should save file and return 201', async () => {
    const data = Buffer.from('hello upload').toString('base64');
    const res = await request(server, 'POST', '/api/upload', {
      project: projectName,
      filename: 'test.txt',
      data
    });
    assert.equal(res.status, 201);
    assert.ok(res.data.path);
    assert.ok(res.data.name.includes('test'));
    assert.equal(res.data.size, 12);
  });

  it('POST /api/upload should return 400 for missing fields', async () => {
    const res = await request(server, 'POST', '/api/upload', {
      project: projectName
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/upload should return 400 for invalid file type', async () => {
    const data = Buffer.from('evil').toString('base64');
    const res = await request(server, 'POST', '/api/upload', {
      project: projectName,
      filename: 'script.exe',
      data
    });
    assert.equal(res.status, 400);
    assert.ok(res.data.error.includes('not allowed'));
  });

  it('GET /api/uploads should list uploaded files', async () => {
    const res = await request(server, 'GET', `/api/uploads?project=${projectName}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.uploads));
    assert.ok(res.data.uploads.length >= 1);
  });

  it('GET /api/uploads should return 400 without project param', async () => {
    const res = await request(server, 'GET', '/api/uploads');
    assert.equal(res.status, 400);
  });
});
