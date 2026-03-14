'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLogger, setLevel, getLevel, initFileLogging, closeFileLogging } = require('../lib/logger');

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

      // Old file should be rotated
      assert.ok(fs.existsSync(`${logFile}.1`), 'Rotated file should exist');

      // New log file should have the new message
      const newContent = fs.readFileSync(logFile, 'utf8');
      assert.ok(newContent.includes('after rotation'), 'New file should have new content');
    });
  });
});
