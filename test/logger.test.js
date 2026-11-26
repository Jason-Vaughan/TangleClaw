'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createLogger, setLevel, getLevel, setConsoleStream, initFileLogging, closeFileLogging,
  _isFileLoggingActiveForTesting
} = require('../lib/logger');

describe('logger', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-logger-'));
    setLevel('debug');
  });

  afterEach(() => {
    closeFileLogging();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('setLevel / getLevel', () => {
    it('should default to info', () => {
      // Reset by setting to info
      setLevel('info');
      assert.equal(getLevel(), 'info');
    });

    it('should accept valid levels', () => {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        setLevel(level);
        assert.equal(getLevel(), level);
      }
    });

    it('should accept case-insensitive levels', () => {
      setLevel('DEBUG');
      assert.equal(getLevel(), 'debug');
      setLevel('Info');
      assert.equal(getLevel(), 'info');
    });

    it('should reject invalid levels', () => {
      assert.throws(() => setLevel('verbose'), /Invalid log level/);
    });
  });

  describe('createLogger', () => {
    it('should return an object with debug, info, warn, error methods', () => {
      const log = createLogger('test');
      assert.equal(typeof log.debug, 'function');
      assert.equal(typeof log.info, 'function');
      assert.equal(typeof log.warn, 'function');
      assert.equal(typeof log.error, 'function');
    });

    it('should tag output with module name', () => {
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const log = createLogger('mymodule');
      log.info('hello');
      closeFileLogging();

      const content = fs.readFileSync(path.join(logDir, 'tangleclaw.log'), 'utf8');
      assert.ok(content.includes('[mymodule]'), 'Should contain module tag');
      assert.ok(content.includes('[INFO]'), 'Should contain level');
      assert.ok(content.includes('hello'), 'Should contain message');
    });
  });

  describe('level filtering', () => {
    it('should filter messages below the set level', () => {
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      setLevel('warn');

      const log = createLogger('test');
      log.debug('debug msg');
      log.info('info msg');
      log.warn('warn msg');
      log.error('error msg');
      closeFileLogging();

      const content = fs.readFileSync(path.join(logDir, 'tangleclaw.log'), 'utf8');
      assert.ok(!content.includes('debug msg'), 'Debug should be filtered');
      assert.ok(!content.includes('info msg'), 'Info should be filtered');
      assert.ok(content.includes('warn msg'), 'Warn should be shown');
      assert.ok(content.includes('error msg'), 'Error should be shown');
    });
  });

  describe('setConsoleStream', () => {
    /** Collect stream writes. */
    function capture() {
      const lines = [];
      return { write: (s) => lines.push(s), text: () => lines.join('') };
    }

    afterEach(() => setConsoleStream(null));

    it('routes every level to the pinned stream, not the stdout/stderr split', () => {
      // A CLI whose stdout is a parsed contract cannot tolerate an INFO line
      // landing in front of its payload — the default split would put one there.
      const pinned = capture();
      setConsoleStream(pinned);
      setLevel('debug');

      const log = createLogger('test');
      log.info('info msg');
      log.error('error msg');

      assert.match(pinned.text(), /info msg/);
      assert.match(pinned.text(), /error msg/, 'ERROR must follow the pin too, not stay on stderr');
    });

    it('leaves level filtering alone', () => {
      const pinned = capture();
      setConsoleStream(pinned);
      setLevel('warn');

      const log = createLogger('test');
      log.info('filtered msg');
      log.warn('kept msg');

      assert.doesNotMatch(pinned.text(), /filtered msg/);
      assert.match(pinned.text(), /kept msg/);
    });

    it('leaves file logging alone — an audit trail survives the pin', () => {
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      setConsoleStream(capture());
      setLevel('info');

      createLogger('test').info('audited msg');
      closeFileLogging();

      const content = fs.readFileSync(path.join(logDir, 'tangleclaw.log'), 'utf8');
      assert.ok(content.includes('audited msg'), 'pinning the console must not silence the file');
    });

    it('restores the default split when passed null', () => {
      const pinned = capture();
      setConsoleStream(pinned);
      setConsoleStream(null);
      setLevel('info');

      createLogger('test').info('unpinned msg');

      assert.equal(pinned.text(), '', 'no writes should reach the released stream');
    });
  });

  describe('context formatting', () => {
    it('should append key=value pairs from context object', () => {
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const log = createLogger('test');
      log.info('operation complete', { duration: 42, path: '/api/health' });
      closeFileLogging();

      const content = fs.readFileSync(path.join(logDir, 'tangleclaw.log'), 'utf8');
      assert.ok(content.includes('duration=42'), 'Should contain numeric context');
      assert.ok(content.includes('path=/api/health'), 'Should contain string context');
    });

    it('should handle empty context gracefully', () => {
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const log = createLogger('test');
      log.info('no context', {});
      log.info('null context');
      closeFileLogging();

      const content = fs.readFileSync(path.join(logDir, 'tangleclaw.log'), 'utf8');
      assert.ok(content.includes('no context'), 'Should work with empty context');
      assert.ok(content.includes('null context'), 'Should work without context');
    });
  });

  describe('file logging', () => {
    it('should create log directory if it does not exist', () => {
      const logDir = path.join(tmpDir, 'nested', 'logs');
      initFileLogging(logDir);
      assert.ok(fs.existsSync(logDir), 'Log directory should be created');
      closeFileLogging();
    });

    it('should write to tangleclaw.log', () => {
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const log = createLogger('test');
      log.info('file test');
      closeFileLogging();

      const logFile = path.join(logDir, 'tangleclaw.log');
      assert.ok(fs.existsSync(logFile), 'Log file should exist');
      const content = fs.readFileSync(logFile, 'utf8');
      assert.ok(content.includes('file test'), 'Should contain logged message');
    });
  });

  describe('log format', () => {
    it('should follow [ISO-8601] [LEVEL] [module] message format', () => {
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const log = createLogger('server');
      log.info('Listening on :3101');
      closeFileLogging();

      const content = fs.readFileSync(path.join(logDir, 'tangleclaw.log'), 'utf8').trim();
      // Pattern: [2026-03-14T...] [INFO] [server] Listening on :3101
      const pattern = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] \[server\] Listening on :3101$/;
      assert.ok(pattern.test(content), `Log line should match format. Got: ${content}`);
    });
  });

  describe('log rotation', () => {
    it('should rotate when file exceeds size threshold', () => {
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const logFile = path.join(logDir, 'tangleclaw.log');

      // Write a large amount of data to trigger rotation
      // We'll directly create a large file to simulate this
      closeFileLogging();

      // Create a file larger than 10MB
      const largeContent = 'x'.repeat(11 * 1024 * 1024);
      fs.writeFileSync(logFile, largeContent);

      // Re-init should trigger rotation
      initFileLogging(logDir);
      const log = createLogger('test');
      log.info('after rotation');
      closeFileLogging();

      // Old file should be rotated. This test is also what keeps its sibling
      // (`rotate:false`) honest: both build an 11MB fixture, so if the size
      // threshold ever moved above it, this one goes red rather than the
      // sibling passing vacuously.
      assert.ok(fs.existsSync(`${logFile}.1`), 'Rotated file should exist');

      // New log file should have the new message
      const newContent = fs.readFileSync(logFile, 'utf8');
      assert.ok(newContent.includes('after rotation'), 'New file should have new content');
    });

    it('should NOT rotate on open when rotate:false', () => {
      // A short-lived process sharing the server's log dir must not rename the
      // file: the server holds an open fd on the old inode and would go on
      // writing to tangleclaw.log.1, unnoticed, until its next restart.
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const logFile = path.join(logDir, 'tangleclaw.log');
      closeFileLogging();

      fs.writeFileSync(logFile, 'x'.repeat(11 * 1024 * 1024));

      initFileLogging(logDir, { rotate: false });
      createLogger('test').info('appended without rotating');
      closeFileLogging();

      assert.ok(!fs.existsSync(`${logFile}.1`), 'oversized log must be left in place');
      const content = fs.readFileSync(logFile, 'utf8');
      assert.ok(content.includes('appended without rotating'), 'writes still land in the same file');
    });

    it('reopens a fresh file once the periodic check notices the current one was unlinked (#3315)', () => {
      // The old `_rotateIfNeeded` only ever checked the PATH
      // (fs.existsSync/statSync), so once the file was unlinked while _fd
      // stayed open, it became a permanent no-op: _fd kept growing an
      // orphaned inode with nothing ever rotating it (the 271 GB incident).
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const logFile = path.join(logDir, 'tangleclaw.log');
      const log = createLogger('test');

      fs.unlinkSync(logFile);
      assert.ok(!fs.existsSync(logFile), 'unlinked: the path is gone even though _fd is still open on the old inode');

      // The periodic check only runs every ROTATION_CHECK_INTERVAL (1000)
      // writes -- drive enough writes to make it fire.
      for (let i = 0; i < 1000; i++) log.info(`line ${i}`);

      assert.ok(fs.existsSync(logFile), 'the periodic check must reopen a real file at the original path once it notices the unlink');
      log.info('after reopen');
      const content = fs.readFileSync(logFile, 'utf8');
      assert.ok(content.includes('after reopen'), 'new writes land in the reopened file');
      assert.ok(!content.includes('line 0'), 'the reopened file does not carry forward everything written to the old unlinked inode');
    });

    it('closes the open descriptor once the whole log directory is gone, instead of growing an unlinked inode forever (#3315)', () => {
      // A removed scratch TANGLECLAW_HOME (scripts/with-scratch-server.js's
      // teardown) leaves nowhere to reopen into -- file logging must stop
      // cleanly rather than keep writing.
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const log = createLogger('test');
      log.info('before dir removal');
      assert.equal(_isFileLoggingActiveForTesting(), true);

      fs.rmSync(logDir, { recursive: true, force: true });

      for (let i = 0; i < 1000; i++) log.info(`line ${i}`);

      assert.equal(_isFileLoggingActiveForTesting(), false,
        '_fd must close once the periodic check notices the log directory itself is gone');
      assert.doesNotThrow(() => log.info('a write after the directory is gone must be a safe no-op'));
    });

    it('stops file writes rather than leaving the descriptor open when the rotation rename itself fails (#3315 hard ceiling)', () => {
      const logDir = path.join(tmpDir, 'logs');
      initFileLogging(logDir);
      const logFile = path.join(logDir, 'tangleclaw.log');
      const log = createLogger('test');

      // Block the rename chain. The loop shifts files from the HIGHEST
      // index down (.1 -> .2 first, then the live file -> .1), so blocking
      // .1 alone does nothing -- it just gets moved out of the way before
      // the live file ever reaches it. Block the .1 -> .2 step instead: a
      // real file at .1 (so that rename is actually attempted) and a
      // non-empty directory at .2 (a file can never be renamed onto one).
      fs.writeFileSync(`${logFile}.1`, 'old rotated content');
      fs.mkdirSync(`${logFile}.2`);
      fs.writeFileSync(path.join(`${logFile}.2`, 'blocker.txt'), 'x');

      // Grow the already-open fd's own file past MAX_LOG_SIZE directly
      // (same path/inode _fd already has open), then drive the check.
      fs.appendFileSync(logFile, 'x'.repeat(11 * 1024 * 1024));
      for (let i = 0; i < 1000; i++) log.info(`line ${i}`);

      assert.equal(_isFileLoggingActiveForTesting(), false,
        'a rotation that cannot complete must still close the descriptor rather than leave it open and growing');
      assert.doesNotThrow(() => log.info('after a failed rotation, logging must be a safe no-op'));
    });
  });

  describe('console stream write safety (#3315)', () => {
    afterEach(() => setConsoleStream(null));

    it('does not throw when the console stream write itself throws synchronously (e.g. EPIPE)', () => {
      setConsoleStream({ write() { throw Object.assign(new Error('write after end'), { code: 'EPIPE' }); } });
      assert.doesNotThrow(() => createLogger('test').info('must not throw'));
    });

    it('skips the write entirely for a destroyed stream', () => {
      let writeCalled = false;
      setConsoleStream({ destroyed: true, write() { writeCalled = true; } });
      createLogger('test').info('should be skipped');
      assert.equal(writeCalled, false);
    });

    it('skips the write entirely for a stream with writableEnded true', () => {
      let writeCalled = false;
      setConsoleStream({ writableEnded: true, write() { writeCalled = true; } });
      createLogger('test').info('should be skipped');
      assert.equal(writeCalled, false);
    });

    it('skips the write entirely for a stream with writable === false', () => {
      let writeCalled = false;
      setConsoleStream({ writable: false, write() { writeCalled = true; } });
      createLogger('test').info('should be skipped');
      assert.equal(writeCalled, false);
    });

    it('attaches an "error" listener to process.stdout/stderr at module load, so an EPIPE never becomes an unhandled exception', () => {
      // The module-load-time guard (_ensureStreamErrorGuards) attaches one
      // unconditionally -- checked by listener count rather than actually
      // emitting a synthetic 'error' on the real global stdout/stderr,
      // which would also reach (and disrupt) the test runner's own
      // reporting machinery, since it shares those same streams.
      assert.ok(process.stdout.listenerCount('error') > 0, 'stdout must carry the EPIPE-swallowing listener');
      assert.ok(process.stderr.listenerCount('error') > 0, 'stderr must carry the EPIPE-swallowing listener');
    });
  });
});
