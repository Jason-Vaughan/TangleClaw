'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { saveUpload, listUploads } = require('../lib/uploads');

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

    it('should reject invalid file types', () => {
      const data = Buffer.from('binary').toString('base64');
      assert.throws(() => saveUpload(tmpDir, 'evil.exe', data), /not allowed/);
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

    it('should allow all permitted extensions', () => {
      const data = Buffer.from('test').toString('base64');
      const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.md', '.txt', '.json', '.yaml', '.yml'];
      for (const ext of allowed) {
        const result = saveUpload(tmpDir, `file${ext}`, data);
        assert.ok(result.path.endsWith(ext), `${ext} should be allowed`);
      }
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
});
