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

    it('should return PID when another live TangleClaw process owns the PID file', () => {
      // Was written against PID 1 (launchd) purely because it is always alive.
      // Since #1029 that is the impostor case, not the running-instance case:
      // launchd holding our recorded PID is exactly what must NOT read as a
      // live instance. Liveness is stubbed instead, so the assertion is about
      // the branch it names rather than about what happens to hold PID 1.
      fs.writeFileSync(path.join(tmpDir, pidfile.PID_FILENAME), '4242', 'utf8');
      const result = pidfile.check(tmpDir, {
        processAlive: () => true,
        readCommand: () => 'node /opt/tangleclaw/server.js'
      });
      assert.equal(result, 4242);
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

  describe('check — PID reuse (#1029)', () => {
    const FOREIGN = '/usr/libexec/AudioToolbox/SandboxHelper';
    const OURS = 'node /Users/x/Documents/Projects/TangleClaw/server.js';

    /**
     * Write a JSON PID record directly, so a test can place `writtenAt`
     * relative to a stubbed boot time.
     */
    function writeRecord(dir, pid, writtenAt) {
      fs.writeFileSync(path.join(dir, pidfile.PID_FILENAME), JSON.stringify({ pid, writtenAt }), 'utf8');
    }

    it('treats a PID file that outlived a reboot as stale, even though the PID is alive', () => {
      // The reported failure: PID 633 recorded before a restart, reassigned by
      // macOS to an unrelated Apple process, read as a running instance. With
      // KeepAlive that exit(1) became a permanent crash loop.
      const boot = Date.now() - 60_000;
      writeRecord(tmpDir, 633, boot - 24 * 60 * 60 * 1000); // written a day before this boot

      // readCommand deliberately reports a TangleClaw-looking process, so layer 2
      // CANNOT save this case and only the boot-time check can. Stubbing a foreign
      // command here instead would let this pass with layer 1 deleted — verified by
      // mutation: it did.
      const result = pidfile.check(tmpDir, {
        processAlive: () => true,
        bootTime: () => boot,
        readCommand: () => OURS
      });

      assert.equal(result, null, 'must be clear to start');
      assert.equal(fs.existsSync(path.join(tmpDir, pidfile.PID_FILENAME)), false, 'stale file must be removed');
    });

    it('is stale on a pre-boot record even when the command line is unreadable', () => {
      // The reboot case must not depend on `ps` being available at all.
      const boot = Date.now() - 60_000;
      writeRecord(tmpDir, 633, boot - 24 * 60 * 60 * 1000);

      const result = pidfile.check(tmpDir, {
        processAlive: () => true,
        bootTime: () => boot,
        readCommand: () => null
      });

      assert.equal(result, null);
    });

    it('treats a same-boot PID reused by a foreign process as stale', () => {
      // Layer 1 cannot see this one — the file and the impostor share a boot —
      // so it is layer 2 that has to catch it.
      const boot = Date.now() - 60 * 60 * 1000;
      writeRecord(tmpDir, 633, Date.now() - 1000); // written this boot

      const result = pidfile.check(tmpDir, {
        processAlive: () => true,
        bootTime: () => boot,
        readCommand: () => FOREIGN
      });

      assert.equal(result, null);
    });

    it('still reports a genuine live instance from this boot', () => {
      // The error direction that starts a second server. This is the guard
      // against over-aggressive staleness.
      const boot = Date.now() - 60 * 60 * 1000;
      writeRecord(tmpDir, 4242, Date.now() - 1000);

      const result = pidfile.check(tmpDir, {
        processAlive: () => true,
        bootTime: () => boot,
        readCommand: () => OURS
      });

      assert.equal(result, 4242);
    });

    it('reports a live instance when the command line cannot be read', () => {
      // `ps` unavailable is not evidence about the process, so the conservative
      // pre-existing behaviour stands rather than a guess in either direction.
      const boot = Date.now() - 60 * 60 * 1000;
      writeRecord(tmpDir, 4242, Date.now() - 1000);

      const result = pidfile.check(tmpDir, {
        processAlive: () => true,
        bootTime: () => boot,
        readCommand: () => null
      });

      assert.equal(result, 4242);
    });

    it('does not call a record written just after boot pre-boot', () => {
      // Guards BOOT_SKEW_MS. os.uptime() has second granularity and NTP can
      // step the clock, so a file written moments after boot must not be
      // misread as surviving one — that would start a second server.
      const boot = Date.now() - 5000;
      writeRecord(tmpDir, 4242, boot + 100);

      const result = pidfile.check(tmpDir, {
        processAlive: () => true,
        bootTime: () => boot,
        readCommand: () => OURS
      });

      assert.equal(result, 4242);
    });

    it('accepts a legacy bare-number PID file and falls back to the command check', () => {
      // Installs that predate this fix have a bare integer on disk. There is no
      // writtenAt to compare, so identity must still be decided by layer 2.
      fs.writeFileSync(path.join(tmpDir, pidfile.PID_FILENAME), '633', 'utf8');

      assert.equal(
        pidfile.check(tmpDir, { processAlive: () => true, readCommand: () => FOREIGN }),
        null,
        'legacy file naming a foreign process is stale'
      );

      fs.writeFileSync(path.join(tmpDir, pidfile.PID_FILENAME), '633', 'utf8');
      assert.equal(
        pidfile.check(tmpDir, { processAlive: () => true, readCommand: () => OURS }),
        633,
        'legacy file naming our own process still reports it'
      );
    });
  });

  describe('readRecord', () => {
    it('round-trips what write() produced', () => {
      const before = Date.now();
      pidfile.write(tmpDir);
      const record = pidfile.readRecord(tmpDir);
      assert.equal(record.pid, process.pid);
      assert.ok(record.writtenAt >= before, 'writtenAt is stamped');
      assert.equal(pidfile.readPid(tmpDir), process.pid, 'readPid still works on the new format');
    });

    it('returns a null writtenAt for the legacy bare-number format', () => {
      fs.writeFileSync(path.join(tmpDir, pidfile.PID_FILENAME), '633', 'utf8');
      assert.deepEqual(pidfile.readRecord(tmpDir), { pid: 633, writtenAt: null });
    });

    it('returns null for corrupt JSON', () => {
      fs.writeFileSync(path.join(tmpDir, pidfile.PID_FILENAME), '{"pid": 63', 'utf8');
      assert.equal(pidfile.readRecord(tmpDir), null);
      assert.equal(pidfile.readPid(tmpDir), null);
    });
  });

  describe('predatesBoot', () => {
    it('is false when there is nothing to compare', () => {
      assert.equal(pidfile.predatesBoot({ writtenAt: null }), false);
      assert.equal(pidfile.predatesBoot(null), false);
    });
  });

  describe('isForeignProcess', () => {
    it('is false when the command line is unavailable', () => {
      assert.equal(pidfile.isForeignProcess(1, { readCommand: () => null }), false);
    });

    it('recognises a TangleClaw command line', () => {
      assert.equal(pidfile.isForeignProcess(1, { readCommand: () => 'node /x/TangleClaw/server.js' }), false);
    });

    it('flags an unrelated command line', () => {
      assert.equal(pidfile.isForeignProcess(1, { readCommand: () => '/sbin/launchd' }), true);
    });
  });

});
