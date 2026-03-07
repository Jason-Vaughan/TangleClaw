'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const uploads = require('../lib/uploads');

describe('uploads.save (global)', () => {
  const savedFiles = [];

  after(() => {
    for (const f of savedFiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('saves a base64 file and returns path', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const result = uploads.save('test-img.png', base64);
    savedFiles.push(result.path);

    assert.ok(result.name.endsWith('.png'));
    assert.ok(result.name.includes('test-img'));
    assert.ok(fs.existsSync(result.path));
    assert.equal(result.size, 70);
    assert.equal(result.project, null);
  });

  it('sanitizes filenames but preserves extension', () => {
    const base64 = 'dGVzdA==';
    const result = uploads.save('bad/name with spaces!.txt', base64);
    savedFiles.push(result.path);

    assert.ok(!result.name.includes('/'));
    assert.ok(!result.name.includes(' '));
    assert.ok(result.name.endsWith('.txt'));
  });

  it('generates unique names for same-second uploads', () => {
    const base64 = 'dGVzdA==';
    const r1 = uploads.save('same.txt', base64);
    savedFiles.push(r1.path);
    const r2 = uploads.save('same.txt', base64);
    savedFiles.push(r2.path);

    assert.notEqual(r1.name, r2.name);
  });
});

describe('uploads.save (project-specific)', () => {
  const testProject = '_tc_upload_test_' + Date.now();
  const projectDir = path.join(process.env.HOME, 'Documents', 'Projects', testProject);

  after(() => {
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('saves to project .uploads/ directory', () => {
    fs.mkdirSync(projectDir, { recursive: true });
    const base64 = 'dGVzdA==';
    const result = uploads.save('screenshot.png', base64, testProject);

    assert.equal(result.project, testProject);
    assert.ok(result.path.includes(testProject));
    assert.ok(result.path.includes('.uploads'));
    assert.ok(fs.existsSync(result.path));
  });

  it('lists project-specific uploads', () => {
    const files = uploads.list(testProject);
    assert.ok(Array.isArray(files));
    assert.ok(files.length >= 1);
    assert.ok(files[0].path.includes(testProject));
  });
});

describe('uploads.list', () => {
  it('returns an array for global uploads', () => {
    const files = uploads.list();
    assert.ok(Array.isArray(files));
  });

  it('returns files sorted newest first', () => {
    const files = uploads.list();
    if (files.length >= 2) {
      assert.ok(files[0].created >= files[1].created);
    }
  });
});
