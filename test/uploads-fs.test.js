'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const uploadsFs = require('../lib/uploads-fs');
const { canForceRefusal } = require('./_eacces');
const { saveUpload, listUploads, listDir, readScanManifest, recordScan } = uploadsFs;
const continuity = require('../lib/continuity');

describe('uploads-fs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-uploads-'));
  });

  afterEach(() => {
    mock.restoreAll();
    // Restore anything a chmod-000 fixture made unremovable before the rm.
    try {
      for (const dir of [path.join(tmpDir, '.uploads'), continuity.sessionsRoot(tmpDir)]) {
        if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755);
      }
    } catch {
      // Best-effort: the fixture may never have been created for this test.
    }
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
    it('reports no uploads and no failure for a project that has never had one', () => {
      const result = listUploads(tmpDir);
      assert.deepEqual(result.uploads, []);
      assert.equal(result.unreadable, null, 'an absent directory is not a refused one');
      assert.equal(result.code, null);
    });

    it('should return sorted list of uploads (newest first)', () => {
      const data = Buffer.from('a').toString('base64');
      saveUpload(tmpDir, 'first.txt', data);
      // Small delay to ensure different timestamps
      saveUpload(tmpDir, 'second.txt', data);

      const result = listUploads(tmpDir);
      assert.equal(result.uploads.length, 2);
      // Both should have metadata
      assert.ok(result.uploads[0].name);
      assert.ok(result.uploads[0].path);
      assert.ok(result.uploads[0].size > 0);
    });
  });

  describe('an unreadable directory is named, not reported as empty (#889)', () => {
    it('names the refusal and carries the errno when the legacy dir cannot be read (needs a directory this process cannot read)', (t) => {
      if (!canForceRefusal()) { t.skip('this process can read a 000 directory'); return; }
      const data = Buffer.from('secret contents').toString('base64');
      saveUpload(tmpDir, 'kept.txt', data);
      const legacy = path.join(tmpDir, '.uploads');
      fs.chmodSync(legacy, 0o000);

      const result = listUploads(tmpDir);
      // THE MUTATION THAT MUST GO RED: restore the old `if (!fs.existsSync(dir))
      // return []` and this pair fails — the list is empty AND says nothing.
      assert.notEqual(result.unreadable, null,
        'a directory that refused to be read must say so, not report an empty list');
      assert.equal(result.code, 'EACCES', 'the filesystem\'s own errno crosses to the caller');
      assert.deepEqual(result.uploads, [], 'nothing readable was found, which is a separate fact');
    });

    it('still lists what WAS readable when only one directory refuses (needs a directory this process cannot read)', (t) => {
      if (!canForceRefusal()) { t.skip('this process can read a 000 directory'); return; }
      saveUpload(tmpDir, 'legacy.txt', Buffer.from('a').toString('base64'));
      saveUpload(tmpDir, 'in-session.txt', Buffer.from('b').toString('base64'), 4);
      fs.chmodSync(continuity.sessionUploadsDir(tmpDir, 4), 0o000);

      const result = listUploads(tmpDir);
      assert.equal(result.uploads.length, 1, 'the readable directory is still listed');
      assert.match(result.uploads[0].name, /legacy\.txt$/);
      assert.notEqual(result.unreadable, null, 'a partial list is reported as partial');
      assert.equal(result.code, 'EACCES');

      fs.chmodSync(continuity.sessionUploadsDir(tmpDir, 4), 0o755);
    });

    it('keeps the FIRST refusal, so the reported cause is not the last dir walked (needs a directory this process cannot read)', (t) => {
      if (!canForceRefusal()) { t.skip('this process can read a 000 directory'); return; }
      saveUpload(tmpDir, 'a.txt', Buffer.from('a').toString('base64'));
      saveUpload(tmpDir, 'b.txt', Buffer.from('b').toString('base64'), 5);
      const legacy = path.join(tmpDir, '.uploads');
      const sessionDir = continuity.sessionUploadsDir(tmpDir, 5);
      fs.chmodSync(legacy, 0o000);
      fs.chmodSync(sessionDir, 0o000);

      const result = listUploads(tmpDir);
      assert.ok(result.unreadable.includes(legacy),
        `the legacy dir is walked first, so it is the reported cause (got: ${result.unreadable})`);

      fs.chmodSync(legacy, 0o755);
      fs.chmodSync(sessionDir, 0o755);
    });

    it('listDir reports an absent directory as empty with no failure', () => {
      // Deliberately NOT gated on `canForceRefusal`: this half needs no refusal,
      // and pairing it with the half that does would take it off every host that
      // runs the suite as root — losing the "absence is not refusal" assertion
      // exactly where the refusal half is already unavailable.
      const absent = listDir(path.join(tmpDir, 'never-created'), null);
      assert.deepEqual(absent, { entries: [], unreadable: null, code: null });
    });

    it('listDir reports a refused directory with its errno (needs a directory this process cannot read)', (t) => {
      if (!canForceRefusal()) { t.skip('this process can read a 000 directory'); return; }
      const refused = path.join(tmpDir, 'refused');
      fs.mkdirSync(refused);
      fs.chmodSync(refused, 0o000);
      try {
        const result = listDir(refused, null);
        assert.equal(result.code, 'EACCES');
        assert.notEqual(result.unreadable, null);
      } finally {
        fs.chmodSync(refused, 0o755);
      }
    });
  });

  describe('writes are staged and renamed, so a kill cannot truncate (#889)', () => {
    /**
     * Stand in for the supervisor's SIGKILL by making the write die partway.
     * The point under test is which FILE the bytes land in, not how the process
     * ends: a plain `writeFileSync` to the destination truncates it first, so a
     * write that dies mid-flight is observable at the destination. A staged one
     * is not, whatever kills it.
     * @param {number} bytes - How many bytes to land before dying.
     * @returns {void}
     */
    const dieMidWrite = (bytes) => {
      const real = fs.writeFileSync;
      mock.method(fs, 'writeFileSync', (file, contents, ...rest) => {
        const partial = Buffer.isBuffer(contents)
          ? contents.subarray(0, bytes)
          : String(contents).slice(0, bytes);
        real.call(fs, file, partial, ...rest);
        const err = new Error('killed mid-write');
        err.code = 'EIO';
        throw err;
      });
    };

    it('a save that dies mid-write leaves no half-written upload in the listing', () => {
      const body = 'x'.repeat(4096);
      dieMidWrite(16);

      assert.throws(() => saveUpload(tmpDir, 'big.txt', Buffer.from(body).toString('base64')));
      mock.restoreAll();

      const result = listUploads(tmpDir);
      // THE MUTATION THAT MUST GO RED: write straight to `filePath` and the
      // 16-byte corpse is listed as a 4 KB upload the operator can hand to
      // their assistant.
      assert.deepEqual(result.uploads, [],
        'a partially-written upload must never appear as a saved file');
      assert.equal(result.unreadable, null);
    });

    it('a scan-flag record that dies mid-write leaves the previous manifest parseable', () => {
      // A real flagged upload, so a real manifest exists to be destroyed.
      const flagged = saveUpload(tmpDir, 'creds.env',
        Buffer.from('api_key=AKIAIOSFODNN7EXAMPLE\n').toString('base64'), 8);
      const uploadsDir = continuity.sessionUploadsDir(tmpDir, 8);
      assert.equal(readScanManifest(uploadsDir)[flagged.name].flagged, true, 'fixture precondition');

      dieMidWrite(3); // enough to make `{` valid JSON prefix and nothing more
      recordScan(uploadsDir, 'second-file.txt', { flagged: true, types: ['aws'] });
      mock.restoreAll();

      const manifest = readScanManifest(uploadsDir);
      // THE MUTATION THAT MUST GO RED: write straight to `_scan.json` and this
      // reads `{}` — every previously recorded flag silently gone.
      assert.equal(manifest[flagged.name] && manifest[flagged.name].flagged, true,
        'the earlier flag survives a killed write');
    });

    it('a stranded staging file is never listed as an upload', () => {
      const uploadsDir = path.join(tmpDir, '.uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(path.join(uploadsDir, `${uploadsFs.STAGING_PREFIX}999.deadbeef.tmp`), 'partial');

      const result = listUploads(tmpDir);
      assert.deepEqual(result.uploads, [], 'a staging file is not a file the operator uploaded');
    });

    it('a successful write sweeps staging files stranded by an earlier death', () => {
      const uploadsDir = path.join(tmpDir, '.uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const corpse = path.join(uploadsDir, `${uploadsFs.STAGING_PREFIX}999.deadbeef.tmp`);
      fs.writeFileSync(corpse, 'partial');
      // Older than STAGING_STALE_MS, so it is a corpse rather than a live write.
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(corpse, old, old);

      saveUpload(tmpDir, 'fresh.txt', Buffer.from('ok').toString('base64'));

      assert.equal(fs.existsSync(corpse), false, 'the stale staging file is swept');
    });

    it('a staging file young enough to be another writer in flight is left alone', () => {
      const uploadsDir = path.join(tmpDir, '.uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const live = path.join(uploadsDir, `${uploadsFs.STAGING_PREFIX}998.cafebabe.tmp`);
      fs.writeFileSync(live, 'another writer is mid-flight');

      saveUpload(tmpDir, 'fresh.txt', Buffer.from('ok').toString('base64'));

      assert.equal(fs.existsSync(live), true,
        'unlinking a live staging file would break that writer\'s rename for no reason');
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
      const { uploads: list } = listUploads(tmpDir);
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
      const { uploads: list } = listUploads(tmpDir);
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
      const { uploads: list } = listUploads(tmpDir);
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i - 1].createdAt >= list[i].createdAt, 'sorted newest-first');
      }
    });
  });
});
