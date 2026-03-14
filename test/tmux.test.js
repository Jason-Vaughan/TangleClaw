'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const tmux = require('../lib/tmux');

describe('tmux', () => {
  describe('isValidSessionName', () => {
    it('should accept valid names', () => {
      assert.ok(tmux.isValidSessionName('my-project'));
      assert.ok(tmux.isValidSessionName('TiLT-v2'));
      assert.ok(tmux.isValidSessionName('test_project'));
      assert.ok(tmux.isValidSessionName('abc123'));
      assert.ok(tmux.isValidSessionName('A'));
    });

    it('should reject empty or non-string values', () => {
      assert.equal(tmux.isValidSessionName(''), false);
      assert.equal(tmux.isValidSessionName(null), false);
      assert.equal(tmux.isValidSessionName(undefined), false);
      assert.equal(tmux.isValidSessionName(42), false);
    });

    it('should reject names with special characters', () => {
      assert.equal(tmux.isValidSessionName('my project'), false);
      assert.equal(tmux.isValidSessionName('my.project'), false);
      assert.equal(tmux.isValidSessionName('my/project'), false);
      assert.equal(tmux.isValidSessionName('my:project'), false);
      assert.equal(tmux.isValidSessionName('$project'), false);
      assert.equal(tmux.isValidSessionName("'; rm -rf /"), false);
    });

    it('should reject names that are too long', () => {
      assert.equal(tmux.isValidSessionName('a'.repeat(129)), false);
      assert.ok(tmux.isValidSessionName('a'.repeat(128)));
    });
  });

  describe('_escapeArg', () => {
    it('should wrap in single quotes', () => {
      assert.equal(tmux._escapeArg('hello'), "'hello'");
    });

    it('should escape embedded single quotes', () => {
      assert.equal(tmux._escapeArg("it's"), "'it'\\''s'");
    });

    it('should handle empty string', () => {
      assert.equal(tmux._escapeArg(''), "''");
    });

    it('should handle strings with special chars', () => {
      const result = tmux._escapeArg('hello world; rm -rf /');
      assert.equal(result, "'hello world; rm -rf /'");
    });
  });

  describe('listSessions', () => {
    it('should return an array', () => {
      const sessions = tmux.listSessions();
      assert.ok(Array.isArray(sessions));
    });

    it('should return objects with expected fields', () => {
      const sessions = tmux.listSessions();
      // Even if empty, the function should not throw
      for (const session of sessions) {
        assert.ok(typeof session.name === 'string');
        assert.ok(typeof session.windows === 'number');
        assert.ok(typeof session.attached === 'boolean');
      }
    });
  });

  describe('hasSession', () => {
    it('should return false for non-existent session', () => {
      assert.equal(tmux.hasSession('__nonexistent_test_session__'), false);
    });
  });

  describe('isServerRunning', () => {
    it('should return a boolean', () => {
      const result = tmux.isServerRunning();
      assert.ok(typeof result === 'boolean');
    });
  });

  describe('sendKeys - error cases', () => {
    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.sendKeys('__nonexistent_test_session__', 'hello'),
        /does not exist/
      );
    });
  });

  describe('capturePane - error cases', () => {
    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.capturePane('__nonexistent_test_session__'),
        /does not exist/
      );
    });
  });

  describe('setMouse - error cases', () => {
    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.setMouse('__nonexistent_test_session__', true),
        /does not exist/
      );
    });
  });

  describe('getMouse - error cases', () => {
    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.getMouse('__nonexistent_test_session__'),
        /does not exist/
      );
    });
  });

  describe('createSession - validation', () => {
    it('should throw for invalid session name', () => {
      assert.throws(
        () => tmux.createSession('invalid name!'),
        /Invalid tmux session name/
      );
    });

    it('should throw for empty session name', () => {
      assert.throws(
        () => tmux.createSession(''),
        /Invalid tmux session name/
      );
    });
  });
});
