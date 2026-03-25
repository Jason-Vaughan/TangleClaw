'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const pidfile = require('../lib/pidfile');

describe('pidfile', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-pidfile-'));
  });

  afterEach(() => {
    // Clean up
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  describe('write and readPid', () => {
    it('should write current PID and read it back', () => {
      pidfile.write(tmpDir);
      const pid = pidfile.readPid(tmpDir);
      assert.equal(pid, process.pid);
    });

    it('should return null when no PID file exists', () => {
      const pid = pidfile.readPid(tmpDir);
      assert.equal(pid, null);
    });

    it('should return null for invalid PID file content', () => {
      fs.writeFileSync(path.join(tmpDir, pidfile.PID_FILENAME), 'not-a-number', 'utf8');
      const pid = pidfile.readPid(tmpDir);
      assert.equal(pid, null);
    });
  });

  describe('check', () => {
    it('should return null when no PID file exists', () => {
      const result = pidfile.check(tmpDir);
      assert.equal(result, null);
    });

    it('should return null for stale PID file (dead process) and clean it up', () => {
      // Write a PID that definitely doesn't exist (very high number)
      fs.writeFileSync(path.join(tmpDir, pidfile.PID_FILENAME), '9999999', 'utf8');
      const result = pidfile.check(tmpDir);
      assert.equal(result, null);
      // Stale file should be cleaned up
      assert.equal(fs.existsSync(path.join(tmpDir, pidfile.PID_FILENAME)), false);
    });

    it('should return PID when another live process owns the PID file', () => {
      // PID 1 (launchd/init) is always alive
      fs.writeFileSync(path.join(tmpDir, pidfile.PID_FILENAME), '1', 'utf8');
      const result = pidfile.check(tmpDir);
      assert.equal(result, 1);
    });

    it('should return null when PID file contains own PID', () => {
      fs.writeFileSync(path.join(tmpDir, pidfile.PID_FILENAME), String(process.pid), 'utf8');
      const result = pidfile.check(tmpDir);
      assert.equal(result, null);
    });
  });

  describe('remove', () => {
    it('should remove the PID file', () => {
      pidfile.write(tmpDir);
      assert.equal(fs.existsSync(path.join(tmpDir, pidfile.PID_FILENAME)), true);
      pidfile.remove(tmpDir);
      assert.equal(fs.existsSync(path.join(tmpDir, pidfile.PID_FILENAME)), false);
    });

    it('should not throw when PID file does not exist', () => {
      assert.doesNotThrow(() => pidfile.remove(tmpDir));
    });
  });

  describe('isProcessAlive', () => {
    it('should return true for current process', () => {
      assert.equal(pidfile.isProcessAlive(process.pid), true);
    });

    it('should return false for non-existent PID', () => {
      assert.equal(pidfile.isProcessAlive(9999999), false);
    });
  });
});
