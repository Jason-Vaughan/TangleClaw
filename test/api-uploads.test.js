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

  it('POST /api/upload accepts any file type (#338)', async () => {
    const data = Buffer.from('binary').toString('base64');
    const res = await request(server, 'POST', '/api/upload', {
      project: projectName,
      filename: 'tool.exe',
      data
    });
    assert.equal(res.status, 201, 'a previously-rejected .exe now uploads');
    assert.ok(res.data.path.endsWith('.exe'));
    assert.ok(res.data.name && res.data.name.endsWith('.exe'));
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

  describe('a directory that cannot be read is not a directory with nothing in it (#889)', () => {
    /**
     * Can this process still read a directory it has removed its own permission
     * from? Root can, and a container that runs the suite as root would turn
     * every assertion below into a false pass. Probed rather than inferred from
     * the uid, because that is the condition that actually matters.
     * @returns {boolean}
     */
    function canForceRefusal() {
      const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eacces-probe-'));
      try {
        fs.chmodSync(probe, 0o000);
        fs.readdirSync(probe);
        return false; // it answered anyway — this process outranks the mode bits
      } catch {
        return true;
      } finally {
        try {
          fs.chmodSync(probe, 0o755);
          fs.rmSync(probe, { recursive: true, force: true });
        } catch {
          // The probe directory is disposable; a failure to clean it is not a
          // reason to fail the suite.
        }
      }
    }

    const projDir = () => path.join(tmpDir, projectName);

    it('GET /api/uploads names the refusal instead of reporting an empty list', async (t) => {
      if (!canForceRefusal()) {
        t.skip('this process can read a 000 directory, so no genuine EACCES can be staged');
        return;
      }
      const legacy = path.join(projDir(), '.uploads');
      fs.chmodSync(legacy, 0o000);
      try {
        const res = await request(server, 'GET', `/api/uploads?project=${projectName}`);
        assert.equal(res.status, 200, 'a refused directory is a partial answer, not a failed request');
        assert.deepEqual(res.data.uploads, []);
        // Without these the route says exactly what "nothing has been uploaded"
        // says, and the operator is told their files are gone.
        assert.ok(res.data.unreadable, 'the route must carry the reason');
        assert.equal(res.data.unreadableCode, 'EACCES');
        assert.equal(res.data.unreadableHint, null, 'the filesystem answered; this is not a TCC problem');
      } finally {
        fs.chmodSync(legacy, 0o755);
      }
    });

    it('GET /api/uploads reports no failure when the project simply has no uploads', async () => {
      const emptyProject = 'upload-empty-proj';
      const dir = path.join(tmpDir, emptyProject);
      fs.mkdirSync(dir, { recursive: true });
      store.projects.create({ name: emptyProject, path: dir, engine: 'claude', tags: [], ports: {} });

      const res = await request(server, 'GET', `/api/uploads?project=${emptyProject}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.uploads, []);
      assert.equal(res.data.unreadable, null, 'absence is not refusal');
      assert.equal(res.data.unreadableCode, null);
    });

    it('the session drill-down carries the same distinction', async (t) => {
      if (!canForceRefusal()) {
        t.skip('this process can read a 000 directory, so no genuine EACCES can be staged');
        return;
      }
      const legacy = path.join(projDir(), '.uploads');
      fs.chmodSync(legacy, 0o000);
      try {
        const res = await request(server, 'GET',
          `/api/continuity/${projectName}/sessions/1`);
        assert.equal(res.status, 200);
        assert.ok(res.data.uploadsUnreadable,
          'a session whose uploads could not be read must not look like one that has none');
        assert.equal(res.data.uploadsUnreadableCode, 'EACCES');
      } finally {
        fs.chmodSync(legacy, 0o755);
      }
    });

    it('POST /api/upload returns 400 when the project directory is gone from disk', async () => {
      const gone = 'upload-gone-proj';
      const dir = path.join(tmpDir, gone);
      fs.mkdirSync(dir, { recursive: true });
      store.projects.create({ name: gone, path: dir, engine: 'claude', tags: [], ports: {} });
      fs.rmSync(dir, { recursive: true, force: true });

      const res = await request(server, 'POST', '/api/upload', {
        project: gone,
        filename: 'test.txt',
        data: Buffer.from('x').toString('base64')
      });
      assert.equal(res.status, 400);
      // The check that produces this moved into the scanner child with the
      // write; dropping it would have `recursive: true` rebuild the tree and
      // report the upload as saved into a project the operator deleted.
      assert.equal(fs.existsSync(dir), false, 'the project tree must not be recreated');
    });
  });
});
