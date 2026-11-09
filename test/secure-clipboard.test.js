'use strict';

/**
 * Secure clipboard sync and file/secret uploader (#1032).
 *
 * Two layers: `lib/secure-clipboard.js`'s own filesystem store (pure,
 * no server, no tmux) and the `/api/sessions/:project/secure-clipboard*`
 * HTTP surface. The HTTP tests mock `lib/tmux.js`'s `hasSession`/`sendKeys`
 * for the paste-mode path — the same convention `test/api-sessions.test.js`
 * uses for `/command` — rather than spawning a real tmux pane: the actual
 * `sessions.injectCommand`/`tmux.sendKeys` mechanism already has its own
 * real-tmux coverage elsewhere: this file's job is to prove ITS OWN route
 * logic (auth, body validation, the audit-metadata-only log, the result
 * mapping), not to re-prove tmux delivery.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const secureClipboard = require('../lib/secure-clipboard');

describe('lib/secure-clipboard', () => {
  let tmpDir;
  let project;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secure-clipboard-lib-'));
    project = { name: 'sc-lib-test', path: tmpDir };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeSecretFile', () => {
    it('rejects a filename containing a path separator', () => {
      assert.throws(
        () => secureClipboard.writeSecretFile(project, { filename: '../escape', content: 'x' }),
        /filename must be/
      );
      assert.throws(
        () => secureClipboard.writeSecretFile(project, { filename: 'a/b', content: 'x' }),
        /filename must be/
      );
    });

    it('rejects empty content', () => {
      assert.throws(
        () => secureClipboard.writeSecretFile(project, { filename: 'empty.txt', content: '' }),
        /non-empty/
      );
    });

    it('rejects an unsupported encoding', () => {
      assert.throws(
        () => secureClipboard.writeSecretFile(project, { filename: 'bad-enc.txt', content: 'x', encoding: 'hex' }),
        /unsupported encoding/
      );
    });

    it('rejects content over the byte limit', () => {
      const big = 'x'.repeat(secureClipboard.MAX_FILE_BYTES + 1);
      assert.throws(
        () => secureClipboard.writeSecretFile(project, { filename: 'too-big.txt', content: big }),
        /over the .* limit/
      );
    });

    it('writes utf8 content to a 0600 file in a 0700 secrets directory, and reports no secret types for ordinary text', () => {
      const result = secureClipboard.writeSecretFile(project, { filename: 'plain.txt', content: 'hello world' });
      assert.equal(result.relPath, path.join('secrets', 'plain.txt'));
      assert.equal(result.bytes, 11);
      assert.deepEqual(result.secretTypesDetected, []);

      const dir = secureClipboard.secretsDir(project);
      const dirMode = fs.statSync(dir).mode & 0o777;
      assert.equal(dirMode, 0o700, 'secrets dir must be 0700');

      const file = path.join(dir, 'plain.txt');
      const fileMode = fs.statSync(file).mode & 0o777;
      assert.equal(fileMode, 0o600, 'secret file must be 0600');
      assert.equal(fs.readFileSync(file, 'utf8'), 'hello world');
    });

    it('flags a high-confidence secret shape in the audit result, without the value appearing in the error/return path', () => {
      const awsKey = 'AKIAABCDEFGHIJKLMNOP';
      const result = secureClipboard.writeSecretFile(project, { filename: 'aws.txt', content: awsKey });
      assert.deepEqual(result.secretTypesDetected, ['aws-access-key']);
      assert.ok(!JSON.stringify(result).includes(awsKey), 'the return value must never carry the secret value itself');
    });

    it('overwrites an existing file of the same name (a resend)', () => {
      secureClipboard.writeSecretFile(project, { filename: 'sync.txt', content: 'first' });
      secureClipboard.writeSecretFile(project, { filename: 'sync.txt', content: 'second' });
      const file = path.join(secureClipboard.secretsDir(project), 'sync.txt');
      assert.equal(fs.readFileSync(file, 'utf8'), 'second');
    });

    it('accepts base64-encoded content and never scans it for secret types (encoding guard, not a text scan)', () => {
      const content = Buffer.from('binary-ish payload').toString('base64');
      const result = secureClipboard.writeSecretFile(project, { filename: 'b64.bin', content, encoding: 'base64' });
      assert.equal(result.bytes, Buffer.byteLength('binary-ish payload'));
      assert.deepEqual(result.secretTypesDetected, []);
      const file = path.join(secureClipboard.secretsDir(project), 'b64.bin');
      assert.equal(fs.readFileSync(file, 'utf8'), 'binary-ish payload');
    });
  });

  describe('listSecretFiles', () => {
    it('returns an empty array when the directory does not exist yet', () => {
      const fresh = { name: 'sc-lib-fresh', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secure-clipboard-fresh-')) };
      assert.deepEqual(secureClipboard.listSecretFiles(fresh), []);
    });

    it('lists written files with byte counts, newest first', async () => {
      const fresh = { name: 'sc-lib-list', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secure-clipboard-list-')) };
      secureClipboard.writeSecretFile(fresh, { filename: 'one.txt', content: 'aaa' });
      await new Promise((r) => setTimeout(r, 5)); // distinct mtimes
      secureClipboard.writeSecretFile(fresh, { filename: 'two.txt', content: 'bb' });
      const list = secureClipboard.listSecretFiles(fresh);
      assert.deepEqual(list.map((f) => f.filename), ['two.txt', 'one.txt']);
      assert.equal(list.find((f) => f.filename === 'two.txt').bytes, 2);
    });
  });

  describe('deleteSecretFile', () => {
    it('deletes an existing file and reports false for one that never existed', () => {
      secureClipboard.writeSecretFile(project, { filename: 'to-delete.txt', content: 'bye' });
      assert.deepEqual(secureClipboard.deleteSecretFile(project, 'to-delete.txt'), { deleted: true });
      assert.deepEqual(secureClipboard.deleteSecretFile(project, 'to-delete.txt'), { deleted: false });
      assert.deepEqual(secureClipboard.deleteSecretFile(project, 'never-existed.txt'), { deleted: false });
    });

    it('rejects a bad filename rather than touching the filesystem', () => {
      assert.throws(() => secureClipboard.deleteSecretFile(project, '../escape'), /filename must be/);
    });
  });

  describe('scanForAudit', () => {
    it('reports byte count and no types for ordinary text', () => {
      assert.deepEqual(secureClipboard.scanForAudit('just some notes'), { bytes: 15, secretTypesDetected: [] });
    });

    it('reports the matched type for a high-confidence secret shape', () => {
      const result = secureClipboard.scanForAudit('xoxb-1234567890-abcdefghij');
      assert.deepEqual(result.secretTypesDetected, ['slack-token']);
    });

    it('returns zero bytes for non-string input rather than throwing', () => {
      assert.deepEqual(secureClipboard.scanForAudit(undefined), { bytes: 0, secretTypesDetected: [] });
    });
  });
});

describe('secure-clipboard-routes — HTTP surface (#1032)', () => {
  let tmpDir;
  let store;
  let server;
  let opHeaders;

  function request(method, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const bodyStr = body !== undefined ? JSON.stringify(body) : null;
      const reqHeaders = { 'Content-Type': 'application/json', ...headers };
      if (bodyStr) reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: reqHeaders
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
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  function makeProject(name) {
    const projPath = path.join(tmpDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    return store.projects.create({ name, path: projPath, engine: 'claude' });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secure-clipboard-routes-'));
    store = require('../lib/store');
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    // `_requireOperatorRead`/`_requireOperatorWrite`'s ARMED branch is the
    // only path either proof honours for a route like this one (unlike
    // `/engine-health`, whose GET has no operator check at all, these
    // routes gate every verb) — the store's default gate is `open` (login
    // disabled outright, not merely "no account yet"), so a real `armed`
    // gate needs `authEnabled: true` before `signInOperator` can reach it.
    const cfg = store.config.load();
    cfg.authEnabled = true;
    store.config.save(cfg);

    const { signInOperator } = require('./_shared-docs-callers');
    const serverModule = require('../server');
    server = serverModule.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    opHeaders = await signInOperator(server);
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/sessions/:project/secure-clipboard — mode: file', () => {
    it('404s for an unknown project', async () => {
      const { status, data } = await request('POST', '/api/sessions/no-such-project/secure-clipboard',
        { text: 'x', mode: 'file', filename: 'a.txt' }, opHeaders);
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('400s with no body / empty text / missing mode / missing filename', async () => {
      makeProject('sc-bad');
      const noText = await request('POST', '/api/sessions/sc-bad/secure-clipboard', { mode: 'file' }, opHeaders);
      assert.equal(noText.status, 400);

      const noMode = await request('POST', '/api/sessions/sc-bad/secure-clipboard', { text: 'x' }, opHeaders);
      assert.equal(noMode.status, 400);

      const noFilename = await request('POST', '/api/sessions/sc-bad/secure-clipboard', { text: 'x', mode: 'file' }, opHeaders);
      assert.equal(noFilename.status, 400);
    });

    it('writes a secret file and reports its byte count, never echoing the text back', async () => {
      makeProject('sc-file-ok');
      const { status, data } = await request('POST', '/api/sessions/sc-file-ok/secure-clipboard',
        { text: 'super-secret-value', mode: 'file', filename: 'api-key.txt' }, opHeaders);
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.mode, 'file');
      assert.equal(data.bytes, 'super-secret-value'.length);
      assert.ok(!JSON.stringify(data).includes('super-secret-value'));
    });

    it('400s on a bad filename rather than writing anything', async () => {
      makeProject('sc-badname');
      const { status, data } = await request('POST', '/api/sessions/sc-badname/secure-clipboard',
        { text: 'x', mode: 'file', filename: '../escape' }, opHeaders);
      assert.equal(status, 400);
      assert.equal(data.code, 'SECURE_CLIPBOARD_WRITE_FAILED');
    });

    it('refuses a write with no caller identity at all (the launch-binding-guard floor, before this route\'s own operator proof ever runs)', async () => {
      makeProject('sc-noauth');
      const { status, data } = await request('POST', '/api/sessions/sc-noauth/secure-clipboard',
        { text: 'x', mode: 'file', filename: 'a.txt' });
      assert.equal(status, 403);
      assert.equal(data.code, 'LAUNCH_BINDING_REQUIRED');
    });

    it('refuses a write that is same-origin but not actually signed in (this route\'s own operator proof, past the guard)', async () => {
      const { operatorHeaders } = require('./_shared-docs-callers');
      makeProject('sc-noauth-2');
      const { status, data } = await request('POST', '/api/sessions/sc-noauth-2/secure-clipboard',
        { text: 'x', mode: 'file', filename: 'a.txt' }, operatorHeaders(server));
      assert.equal(status, 401);
      assert.equal(data.code, 'UNAUTHENTICATED');
    });
  });

  describe('GET /api/sessions/:project/secure-clipboard + DELETE .../secure-clipboard/:filename', () => {
    it('404s for an unknown project', async () => {
      const { status } = await request('GET', '/api/sessions/no-such-project/secure-clipboard', undefined, opHeaders);
      assert.equal(status, 404);
    });

    it('refuses a read with no operator session', async () => {
      makeProject('sc-read-noauth');
      const { status } = await request('GET', '/api/sessions/sc-read-noauth/secure-clipboard');
      assert.equal(status, 401);
    });

    it('lists a file written through POST, then deletes it', async () => {
      makeProject('sc-list-del');
      await request('POST', '/api/sessions/sc-list-del/secure-clipboard',
        { text: 'to-list', mode: 'file', filename: 'listed.txt' }, opHeaders);

      const list = await request('GET', '/api/sessions/sc-list-del/secure-clipboard', undefined, opHeaders);
      assert.equal(list.status, 200);
      assert.equal(list.data.files.length, 1);
      assert.equal(list.data.files[0].filename, 'listed.txt');
      assert.equal(list.data.files[0].bytes, 'to-list'.length);

      const del = await request('DELETE', '/api/sessions/sc-list-del/secure-clipboard/listed.txt', undefined, opHeaders);
      assert.equal(del.status, 200);
      assert.equal(del.data.deleted, true);

      const after2 = await request('GET', '/api/sessions/sc-list-del/secure-clipboard', undefined, opHeaders);
      assert.equal(after2.data.files.length, 0);

      const delAgain = await request('DELETE', '/api/sessions/sc-list-del/secure-clipboard/listed.txt', undefined, opHeaders);
      assert.equal(delAgain.status, 404);
    });
  });

  describe('POST /api/sessions/:project/secure-clipboard — mode: paste', () => {
    it('404s ("No active session") when the project has none', async () => {
      makeProject('sc-paste-none');
      const { status, data } = await request('POST', '/api/sessions/sc-paste-none/secure-clipboard',
        { text: 'secret', mode: 'paste' }, opHeaders);
      assert.equal(status, 404);
      assert.ok(data.error.includes('No active'));
    });

    it('pastes into the session\'s pane with enter:false, and reports bytes/secret-shape without the value', async () => {
      const tmux = require('../lib/tmux');
      const real = { hasSession: tmux.hasSession, sendKeys: tmux.sendKeys };
      let sentSession = null;
      let sentText = null;
      let sentOptions = null;
      tmux.hasSession = () => true;
      tmux.sendKeys = (session, text, options) => {
        sentSession = session; sentText = text; sentOptions = options;
      };

      const project = makeProject('sc-paste-ok');
      const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'sc-paste-pane' });
      try {
        const secretText = 'AKIAABCDEFGHIJKLMNOP';
        const { status, data } = await request('POST', '/api/sessions/sc-paste-ok/secure-clipboard',
          { text: secretText, mode: 'paste' }, opHeaders);
        assert.equal(status, 200);
        assert.equal(data.ok, true);
        assert.equal(data.mode, 'paste');
        assert.equal(data.bytes, secretText.length);
        assert.deepEqual(data.secretTypesDetected, ['aws-access-key']);
        assert.ok(!JSON.stringify(data).includes(secretText), 'the response must never carry the secret value');

        assert.equal(sentSession, 'sc-paste-pane');
        assert.equal(sentText, secretText);
        assert.equal(sentOptions.enter, false, 'a pasted secret must never be auto-submitted');
      } finally {
        Object.assign(tmux, real);
        store.sessions.kill(session.id, 'test cleanup');
      }
    });
  });
});
