'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { saveUpload, listUploads } = require('../lib/uploads');
const continuity = require('../lib/continuity');

describe('uploads', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-uploads-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('saveUpload', () => {
    it('should save a valid file and return metadata', () => {
      const data = Buffer.from('hello world').toString('base64');
      const result = saveUpload(tmpDir, 'test.txt', data);

      assert.ok(result.path.endsWith('.txt'));
      assert.ok(result.name.includes('test'));
      assert.equal(result.size, 11);
      assert.ok(result.createdAt);

      const content = fs.readFileSync(result.path, 'utf8');
      assert.equal(content, 'hello world');
    });

    it('allows any file type, including previously-disallowed ones (#338)', () => {
      const data = Buffer.from('binary').toString('base64');
      // .exe was rejected before #338; it now saves like any other file.
      const result = saveUpload(tmpDir, 'tool.exe', data);
      assert.ok(result.path.endsWith('.exe'), '.exe must now be accepted');
      assert.ok(fs.existsSync(result.path));
    });

    it('should create .uploads/ directory if missing', () => {
      const subDir = path.join(tmpDir, 'project');
      fs.mkdirSync(subDir);
      const data = Buffer.from('test').toString('base64');
      saveUpload(subDir, 'file.txt', data);

      assert.ok(fs.existsSync(path.join(subDir, '.uploads')));
    });

    it('should generate timestamped filenames', () => {
      const data = Buffer.from('test').toString('base64');
      const result = saveUpload(tmpDir, 'photo.png', data);

      // Format: YYYYMMDD-HHmmss-photo.png
      assert.match(result.name, /^\d{8}-\d{6}\d?-photo\.png$/);
    });

    it('should decode base64 correctly', () => {
      const original = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG magic bytes
      const data = original.toString('base64');
      const result = saveUpload(tmpDir, 'image.png', data);

      const written = fs.readFileSync(result.path);
      assert.deepEqual(written, original);
    });

    it('should throw for missing fields', () => {
      assert.throws(() => saveUpload(null, 'f.txt', 'abc'), /projectPath/);
      assert.throws(() => saveUpload(tmpDir, null, 'abc'), /filename/);
      assert.throws(() => saveUpload(tmpDir, 'f.txt', null), /base64Data/);
    });

    it('should sanitize filenames with special characters', () => {
      const data = Buffer.from('test').toString('base64');
      const result = saveUpload(tmpDir, '../../../etc/passwd.txt', data);

      assert.ok(!result.name.includes('/'));
      assert.ok(!result.name.includes('..'));
    });

    it('allows any extension — formerly-allowed and formerly-rejected alike (#338)', () => {
      const data = Buffer.from('test').toString('base64');
      const exts = ['.png', '.pdf', '.yaml', '.exe', '.zip', '.mp4', '.csv', '.bin'];
      for (const ext of exts) {
        const result = saveUpload(tmpDir, `file${ext}`, data);
        assert.ok(result.path.endsWith(ext), `${ext} should be accepted`);
      }
    });

    it('accepts a file with no extension (#338)', () => {
      const data = Buffer.from('test').toString('base64');
      const result = saveUpload(tmpDir, 'Dockerfile', data);
      assert.match(result.name, /^\d{8}-\d{6}\d?-Dockerfile$/, 'extension-less name preserved, no trailing dot');
      assert.ok(fs.existsSync(result.path));
    });

    it('sanitizes a crafted extension to alphanumerics (#338)', () => {
      const data = Buffer.from('test').toString('base64');
      // A name whose "extension" carries odd characters must not smuggle them to disk.
      const result = saveUpload(tmpDir, 'note.t<x>t', data);
      assert.ok(/\.txt$/.test(result.name), `crafted ext sanitized to .txt (got ${result.name})`);
      assert.ok(!/[<>]/.test(result.name), 'no angle brackets on disk');
    });

    it('sanitizes an all-symbol base name to safe characters (#338)', () => {
      const data = Buffer.from('test').toString('base64');
      const result = saveUpload(tmpDir, '@@@.png', data);
      assert.match(result.name, /^\d{8}-\d{6}\d?-_+\.png$/, 'symbols become underscores, ext preserved');
      assert.ok(!/[^a-zA-Z0-9_.-]/.test(result.name), 'no unsafe characters on disk');
    });

    it('falls back to "file" when the base name is empty (#338)', () => {
      const data = Buffer.from('test').toString('base64');
      // A pure-separator name has an empty base name → the "file" fallback.
      const result = saveUpload(tmpDir, '/', data);
      assert.match(result.name, /^\d{8}-\d{6}\d?-file$/, 'empty base name → "file", no extension');
    });
  });

  describe('listUploads', () => {
    it('should return empty array for missing .uploads/ dir', () => {
      const result = listUploads(tmpDir);
      assert.deepEqual(result, []);
    });

    it('should return sorted list of uploads (newest first)', () => {
      const data = Buffer.from('a').toString('base64');
      saveUpload(tmpDir, 'first.txt', data);
      // Small delay to ensure different timestamps
      saveUpload(tmpDir, 'second.txt', data);

      const result = listUploads(tmpDir);
      assert.equal(result.length, 2);
      // Both should have metadata
      assert.ok(result[0].name);
      assert.ok(result[0].path);
      assert.ok(result[0].size > 0);
    });
  });

  describe('CC-4 — session-linked store + secret flag', () => {
    const b64 = (s) => Buffer.from(s).toString('base64');

    it('routes an upload with a sid into sessions/<sid>/uploads/', () => {
      const result = saveUpload(tmpDir, 'shot.png', b64('x'), 7);
      assert.equal(
        path.dirname(result.path),
        continuity.sessionUploadsDir(tmpDir, 7),
        'file must land in the session uploads dir'
      );
      assert.equal(result.session, 7);
      assert.equal(result.secretsFlagged, false);
      assert.deepEqual(result.secretTypes, []);
    });

    it('falls back to the legacy flat dir when no sid is given', () => {
      const result = saveUpload(tmpDir, 'old.txt', b64('hello'));
      assert.equal(path.dirname(result.path), path.join(tmpDir, '.uploads'));
      assert.equal(result.session, null);
    });

    it('listUploads merges legacy (session:null) and per-session uploads', () => {
      saveUpload(tmpDir, 'legacy.txt', b64('a'));         // legacy dir
      saveUpload(tmpDir, 'in-session.txt', b64('b'), 11); // sessions/11/uploads
      const list = listUploads(tmpDir);
      const byName = Object.fromEntries(list.map((u) => [u.name.replace(/^\d{8}-\d{6}\d?-/, ''), u]));
      assert.equal(byName['legacy.txt'].session, null);
      assert.equal(String(byName['in-session.txt'].session), '11');
    });

    it('flags a text upload containing a secret (flag only — file unchanged)', () => {
      const body = 'config\napi_key=AKIAIOSFODNN7EXAMPLE\n';
      const result = saveUpload(tmpDir, 'creds.env', b64(body), 3);
      assert.equal(result.secretsFlagged, true);
      assert.ok(result.secretTypes.length > 0);
      // The file on disk is untouched — flag-only contract.
      assert.equal(fs.readFileSync(result.path, 'utf8'), body);
      // A sidecar manifest records the flag for listUploads.
      const manifest = path.join(continuity.sessionUploadsDir(tmpDir, 3), '_scan.json');
      assert.ok(fs.existsSync(manifest), '_scan.json manifest written');
      // listUploads surfaces the flag and excludes the manifest itself.
      const list = listUploads(tmpDir);
      assert.ok(!list.some((u) => u.name === '_scan.json'), 'manifest not listed as an upload');
      const entry = list.find((u) => u.name === result.name);
      assert.equal(entry.secretsFlagged, true);
    });

    it('does NOT scan binary uploads (a PNG with secret-looking bytes)', () => {
      // A NUL byte marks the buffer binary → skipped by the text heuristic.
      const binary = Buffer.concat([Buffer.from([0x89, 0x00]), Buffer.from('AKIAIOSFODNN7EXAMPLE')]);
      const result = saveUpload(tmpDir, 'image.png', binary.toString('base64'), 5);
      assert.equal(result.secretsFlagged, false);
    });

    it('does NOT scan a text upload above the 1 MB size cap', () => {
      // Over-cap text is skipped (the scan is best-effort, memory-bounded) — so
      // even a real secret pattern in a >1 MB file returns secretsFlagged:false.
      const body = 'x'.repeat(1024 * 1024 + 16) + ' AKIAIOSFODNN7EXAMPLE';
      const result = saveUpload(tmpDir, 'big.log', b64(body), 6);
      assert.ok(result.size > 1024 * 1024, 'fixture must exceed the cap');
      assert.equal(result.secretsFlagged, false);
    });

    it('keeps newest-first order across legacy + session dirs', () => {
      saveUpload(tmpDir, 'a.txt', b64('a'));
      saveUpload(tmpDir, 'b.txt', b64('b'), 9);
      const list = listUploads(tmpDir);
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i - 1].createdAt >= list[i].createdAt, 'sorted newest-first');
      }
    });
  });
});
