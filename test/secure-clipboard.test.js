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

const { describe, it, before, after } = require('node:test');
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

    it('rejects a filename of exactly "." or ".." (Architect hardening, round 2)', () => {
      assert.throws(
        () => secureClipboard.writeSecretFile(project, { filename: '.', content: 'x' }),
        /filename must be/
      );
      assert.throws(
        () => secureClipboard.writeSecretFile(project, { filename: '..', content: 'x' }),
        /filename must be/
      );
      // A dotfile with a REAL name is still fine — only the bare tokens are refused.
      const result = secureClipboard.writeSecretFile(project, { filename: '.env', content: 'x' });
      assert.equal(result.bytes, 1);
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

  describe('readImageFile (#3083, Ruling A751)', () => {
    // The smallest byte strings that carry each type's signature.
    const SIGS = {
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
      jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      gif: Buffer.from('GIF89a\x01\x00', 'latin1'),
      webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
    };
    /** @param {string} name @param {Buffer} buf */
    const put = (name, buf) => {
      secureClipboard.writeSecretFile(project, { filename: name, content: buf.toString('base64'), encoding: 'base64' });
    };

    it('serves each allowed image type with its own content type, extension compared case-insensitively', () => {
      const cases = [['shot.png', SIGS.png, 'image/png'], ['photo.jpg', SIGS.jpg, 'image/jpeg'], ['photo2.JPEG', SIGS.jpg, 'image/jpeg'],
        ['anim.gif', SIGS.gif, 'image/gif'], ['pic.webp', SIGS.webp, 'image/webp'], ['UPPER.PNG', SIGS.png, 'image/png']];
      for (const [name, buf, type] of cases) {
        put(name, buf);
        const got = secureClipboard.readImageFile(project, name);
        assert.equal(got.contentType, type, name);
        assert.equal(got.bytes, buf.length, name);
        assert.ok(got.buffer.equals(buf), name);
      }
      assert.deepEqual(Object.keys(secureClipboard.IMAGE_TYPES).sort(), ['.gif', '.jpeg', '.jpg', '.png', '.webp']);
    });

    it('refuses a non-image file with 415, so a key or text secret is never served', () => {
      for (const name of ['api-key.txt', 'id_rsa', 'cert.pem', 'notes.md', 'page.svg', 'page.html']) {
        put(name, Buffer.from('-----BEGIN PRIVATE KEY-----'));
        assert.throws(() => secureClipboard.readImageFile(project, name),
          (err) => err.status === 415 && err.code === 'UNSUPPORTED_MEDIA_TYPE', name);
      }
    });

    it('refuses a non-image name by its extension alone, before opening anything (415 even when no such file exists)', () => {
      const realOpen = fs.openSync;
      let opened = 0;
      fs.openSync = (...args) => { opened += 1; return realOpen(...args); };
      try {
        assert.throws(() => secureClipboard.readImageFile(project, 'never-written.txt'),
          (err) => err.status === 415 && err.code === 'UNSUPPORTED_MEDIA_TYPE');
        assert.equal(opened, 0, 'a secret is never even opened for a preview');
      } finally {
        fs.openSync = realOpen;
      }
    });

    it('refuses a secret renamed to an image extension, by its bytes (415)', () => {
      put('disguised.png', Buffer.from('sk-live-not-an-image'));
      assert.throws(() => secureClipboard.readImageFile(project, 'disguised.png'),
        (err) => err.status === 415 && err.code === 'UNSUPPORTED_MEDIA_TYPE');
      put('wrong-kind.gif', SIGS.png);
      assert.throws(() => secureClipboard.readImageFile(project, 'wrong-kind.gif'), (err) => err.status === 415);
    });

    it('refuses a bad filename with 400 before touching the filesystem', () => {
      for (const name of ['../escape.png', 'a/b.png', '..', '', 'x'.repeat(129) + '.png']) {
        assert.throws(() => secureClipboard.readImageFile(project, name),
          (err) => err.status === 400 && err.code === 'BAD_REQUEST', JSON.stringify(name));
      }
    });

    it('answers 404 for a missing file, and when the secrets directory does not exist yet', () => {
      assert.throws(() => secureClipboard.readImageFile(project, 'never-written.png'),
        (err) => err.status === 404 && err.code === 'NOT_FOUND');
      const fresh = { name: 'sc-lib-nodir', path: fs.mkdtempSync(path.join(tmpDir, 'nodir-')) };
      assert.throws(() => secureClipboard.readImageFile(fresh, 'a.png'), (err) => err.status === 404);
    });

    it('never follows a symlinked file, even to a real image (404)', () => {
      const outside = path.join(tmpDir, 'outside.png');
      fs.writeFileSync(outside, SIGS.png);
      fs.symlinkSync(outside, path.join(secureClipboard.secretsDir(project), 'link.png'));
      assert.throws(() => secureClipboard.readImageFile(project, 'link.png'),
        (err) => err.status === 404 && err.code === 'NOT_FOUND');
    });

    it('refuses a secrets directory that is a symlink (404)', () => {
      const root = fs.mkdtempSync(path.join(tmpDir, 'dirlink-'));
      const elsewhere = fs.mkdtempSync(path.join(tmpDir, 'elsewhere-'));
      fs.writeFileSync(path.join(elsewhere, 'a.png'), SIGS.png);
      fs.mkdirSync(path.join(root, '.tangleclaw'));
      fs.symlinkSync(elsewhere, path.join(root, '.tangleclaw', 'secrets'));
      assert.throws(() => secureClipboard.readImageFile({ name: 'sc-dirlink', path: root }, 'a.png'),
        (err) => err.status === 404);
    });

    it('refuses a non-regular file and an oversized one', () => {
      fs.mkdirSync(path.join(secureClipboard.secretsDir(project), 'dir.png'));
      assert.throws(() => secureClipboard.readImageFile(project, 'dir.png'), (err) => err.status === 404);
      const big = Buffer.alloc(secureClipboard.MAX_FILE_BYTES + 1);
      SIGS.png.copy(big);
      fs.writeFileSync(path.join(secureClipboard.secretsDir(project), 'big.png'), big);
      assert.throws(() => secureClipboard.readImageFile(project, 'big.png'),
        (err) => err.status === 413 && err.code === 'TOO_LARGE');
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

  /**
   * A GET whose body is kept as bytes, with the response headers.
   * @param {string} urlPath
   * @param {Record<string, string>} [headers]
   * @returns {Promise<{status: number, headers: object, body: Buffer}>}
   */
  function rawGet(urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET', headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
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

  describe('GET /api/sessions/:project/secure-clipboard/:filename — image preview (#3083, Ruling A751)', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    /** @param {string} project @param {string} filename @param {Buffer} buf */
    const upload = (project, filename, buf) => request('POST', `/api/sessions/${project}/secure-clipboard`,
      { text: buf.toString('base64'), encoding: 'base64', mode: 'file', filename }, opHeaders);

    it('serves an uploaded image to the operator, byte for byte, with no-sniff, a locked-down CSP and no caching', async () => {
      makeProject('sc-img-ok');
      assert.equal((await upload('sc-img-ok', 'shot.png', PNG)).status, 200);
      const r = await rawGet('/api/sessions/sc-img-ok/secure-clipboard/shot.png', opHeaders);
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(PNG));
      assert.equal(r.headers['content-type'], 'image/png');
      assert.equal(r.headers['content-length'], String(PNG.length));
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['content-security-policy'], "default-src 'none'; img-src 'self'");
      assert.equal(r.headers['cache-control'], 'private, no-store');
    });

    it('refuses a request that carries launch-binding headers, even alongside a signed-in operator\'s (403 OPERATOR_ONLY)', async () => {
      makeProject('sc-img-forged');
      await upload('sc-img-forged', 'shot.png', PNG);
      for (const header of ['x-tangleclaw-project-id', 'x-tangleclaw-launch-id', 'x-tangleclaw-role']) {
        const r = await rawGet('/api/sessions/sc-img-forged/secure-clipboard/shot.png', { ...opHeaders, [header]: '' });
        assert.equal(r.status, 403, header);
        assert.equal(JSON.parse(r.body.toString('utf8')).code, 'OPERATOR_ONLY', header);
        assert.ok(!r.body.includes(PNG), header);
      }
    });

    it('refuses a reader with no operator session (401)', async () => {
      makeProject('sc-img-noauth');
      await upload('sc-img-noauth', 'shot.png', PNG);
      const r = await rawGet('/api/sessions/sc-img-noauth/secure-clipboard/shot.png');
      assert.equal(r.status, 401);
    });

    it('answers 415 for a non-image secret, 404 for a missing file or project, 400 for a bad name', async () => {
      makeProject('sc-img-refuse');
      await request('POST', '/api/sessions/sc-img-refuse/secure-clipboard', { text: 'sk-secret', mode: 'file', filename: 'key.txt' }, opHeaders);
      const secret = await rawGet('/api/sessions/sc-img-refuse/secure-clipboard/key.txt', opHeaders);
      assert.equal(secret.status, 415);
      assert.equal(JSON.parse(secret.body.toString('utf8')).code, 'UNSUPPORTED_MEDIA_TYPE');
      assert.ok(!secret.body.toString('utf8').includes('sk-secret'), 'the secret never leaves in the refusal');
      assert.equal((await rawGet('/api/sessions/sc-img-refuse/secure-clipboard/none.png', opHeaders)).status, 404);
      assert.equal((await rawGet('/api/sessions/no-such-project/secure-clipboard/a.png', opHeaders)).status, 404);
      const bad = await rawGet('/api/sessions/sc-img-refuse/secure-clipboard/a%2F..%2Fb.png', opHeaders);
      assert.ok(bad.status === 400 || bad.status === 404, `a traversal-shaped name is refused (got ${bad.status})`);
    });
  });

  describe('POST /api/sessions/:project/secure-clipboard — mode: paste (PRR-B R-Gate finding 2, round 1: never the raw secret in the pane)', () => {
    it('400s with no filename (now required for both modes)', async () => {
      makeProject('sc-paste-nofile');
      const { status, data } = await request('POST', '/api/sessions/sc-paste-nofile/secure-clipboard',
        { text: 'secret', mode: 'paste' }, opHeaders);
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('writes the secret file even with no active session, then 404s ("No active session") only on the notify step', async () => {
      const project = makeProject('sc-paste-none');
      const { status, data } = await request('POST', '/api/sessions/sc-paste-none/secure-clipboard',
        { text: 'secret', mode: 'paste', filename: 'orphan.txt' }, opHeaders);
      assert.equal(status, 404);
      assert.ok(data.error.includes('No active'));
      // The write happens BEFORE the notify attempt, so it is not undone by
      // a notify that then fails — the secret is safely stored regardless.
      const file = path.join(secureClipboard.secretsDir(project), 'orphan.txt');
      assert.equal(fs.readFileSync(file, 'utf8'), 'secret');
    });

    it('writes the secret to disk, notifies the pane with a content-free pointer (enter:false), and never sends the secret value to the pane or the HTTP response', async () => {
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
          { text: secretText, mode: 'paste', filename: 'aws.txt' }, opHeaders);
        assert.equal(status, 200);
        assert.equal(data.ok, true);
        assert.equal(data.mode, 'paste');
        assert.equal(data.notified, true);
        assert.equal(data.bytes, secretText.length);
        assert.deepEqual(data.secretTypesDetected, ['aws-access-key']);
        assert.ok(!JSON.stringify(data).includes(secretText), 'the response must never carry the secret value');

        // The file landed on disk, same as mode: file.
        const file = path.join(secureClipboard.secretsDir(project), 'aws.txt');
        assert.equal(fs.readFileSync(file, 'utf8'), secretText);

        // The PANE never receives the secret — only a pointer to the file.
        assert.equal(sentSession, 'sc-paste-pane');
        assert.ok(!sentText.includes(secretText), 'the pane text must never contain the secret value itself');
        assert.match(sentText, /aws\.txt/, 'the pane text should name the file the secret was saved to');
        assert.equal(sentOptions.enter, false, 'the notice must never be auto-submitted');
      } finally {
        Object.assign(tmux, real);
        store.sessions.kill(session.id, 'test cleanup');
      }
    });
  });
});

describe('secure-clipboard-routes — open-install (no-login) gate (PRR-B R-Gate finding 1, round 1)', () => {
  // A SEPARATE store/server left at the default `open` gate (no `authEnabled`),
  // proving the fix independently of the ARMED-gate suite above: this feature's
  // write AND read must both succeed carrying only the same-origin shape plus
  // the open-install anti-forgery token — the exact headers
  // `tcOperatorProofHeaders` (public/api-helper.js) now builds for this
  // module's frontend, in place of the old `apiMutate()` call that sent
  // neither.
  let tmpDir;
  let store;
  let server;
  let openInstallToken;
  let operatorHeaders;

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

  /** Same-origin + the open-install token — what `tcOperatorProofHeaders` sends. */
  function openHeaders() {
    return { ...operatorHeaders(server), 'X-TC-Open-Token': openInstallToken.mint() };
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secure-clipboard-open-'));
    store = require('../lib/store');
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    ({ operatorHeaders } = require('./_shared-docs-callers'));
    openInstallToken = require('../lib/open-install-token');
    const serverModule = require('../server');
    server = serverModule.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProject(name) {
    const projPath = path.join(tmpDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    return store.projects.create({ name, path: projPath, engine: 'claude' });
  }

  it('confirms the gate really is open (sanity check on the fixture)', async () => {
    const me = await request('GET', '/api/auth/me');
    assert.equal(me.data.gateState, 'open');
  });

  it('POST (mode: file) succeeds with the open-install token, and is refused without it', async () => {
    makeProject('sc-open-write');
    const withToken = await request('POST', '/api/sessions/sc-open-write/secure-clipboard',
      { text: 'x', mode: 'file', filename: 'a.txt' }, openHeaders());
    assert.equal(withToken.status, 200, JSON.stringify(withToken.data));

    const withoutToken = await request('POST', '/api/sessions/sc-open-write/secure-clipboard',
      { text: 'x', mode: 'file', filename: 'b.txt' }, operatorHeaders(server));
    assert.equal(withoutToken.status, 403);
    assert.equal(withoutToken.data.code, 'OPEN_INSTALL_TOKEN_INVALID');
  });

  it('the image preview GET succeeds with the open-install token and is refused without it (#3083)', async () => {
    makeProject('sc-open-img');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const up = await request('POST', '/api/sessions/sc-open-img/secure-clipboard',
      { text: png.toString('base64'), encoding: 'base64', mode: 'file', filename: 'p.png' }, openHeaders());
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const ok = await request('GET', '/api/sessions/sc-open-img/secure-clipboard/p.png', undefined, openHeaders());
    assert.equal(ok.status, 200);
    const refused = await request('GET', '/api/sessions/sc-open-img/secure-clipboard/p.png', undefined, operatorHeaders(server));
    assert.equal(refused.status, 403);
    assert.equal(refused.data.code, 'OPEN_INSTALL_TOKEN_INVALID');
  });

  it('GET succeeds with the open-install token — the exact case the old _requireOperatorRead-based route could never answer', async () => {
    makeProject('sc-open-read');
    const { status, data } = await request('GET', '/api/sessions/sc-open-read/secure-clipboard', undefined, openHeaders());
    assert.equal(status, 200, JSON.stringify(data));
    assert.deepEqual(data.files, []);
  });
});
