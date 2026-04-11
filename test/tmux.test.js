'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const tmux = require('../lib/tmux');

describe('tmux', () => {
  describe('toSessionName', () => {
    it('should pass through valid names unchanged', () => {
      assert.equal(tmux.toSessionName('my-project'), 'my-project');
      assert.equal(tmux.toSessionName('TiLT-v2'), 'TiLT-v2');
    });

    it('should replace spaces with hyphens', () => {
      assert.equal(tmux.toSessionName('TiLT v2'), 'TiLT-v2');
      assert.equal(tmux.toSessionName('My Cool Project'), 'My-Cool-Project');
    });

    it('should strip invalid characters', () => {
      assert.equal(tmux.toSessionName('project@123'), 'project123');
      assert.equal(tmux.toSessionName('a/b:c'), 'abc');
    });

    it('should handle multiple consecutive spaces', () => {
      assert.equal(tmux.toSessionName('a  b'), 'a-b');
    });
  });

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

  describe('createSession - history-limit', () => {
    const testSession = '__tc_test_histlimit__';

    it('should set history-limit to 50000 on new session', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        const { execSync } = require('node:child_process');
        const val = execSync(
          `tmux show-option -t ${testSession} history-limit`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        assert.ok(val.includes('50000'), `Expected history-limit 50000, got: ${val}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('createSession - status bar', () => {
    const testSession = '__tc_test_statusbar__';

    it('should set status-left to "TangleClaw" label', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        const { execSync } = require('node:child_process');
        const val = execSync(
          `tmux show-option -t ${testSession} status-left`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        assert.ok(val.includes('TangleClaw'), `Expected status-left to contain "TangleClaw", got: ${val}`);
        // Should NOT contain raw tmux session name variables — that's confusing
        assert.ok(!val.includes('#{session_name}'), `status-left should not include session_name variable, got: ${val}`);
        assert.ok(!val.includes('#S'), `status-left should not include #S variable, got: ${val}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should set status-right with time and date', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        const { execSync } = require('node:child_process');
        const val = execSync(
          `tmux show-option -t ${testSession} status-right`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        assert.ok(val.includes('%H:%M'), `Expected status-right to contain time format, got: ${val}`);
        assert.ok(val.includes('%Y-%m-%d'), `Expected status-right to contain date format, got: ${val}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('capturePane - full mode', () => {
    const testSession = '__tc_test_fullcap__';

    it('should capture full scrollback with full option', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        // Send some content
        tmux.sendKeys(testSession, 'echo peek-full-test');
        // Small delay for output
        const { execSync } = require('node:child_process');
        execSync('sleep 0.5');
        const capture = tmux.capturePane(testSession, { full: true });
        assert.ok(Array.isArray(capture.lines));
        assert.ok(capture.lines.length > 0, 'Expected at least some output');
        assert.equal(typeof capture.alternateScreen, 'boolean');
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should return more output with full than limited lines', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        // Generate several lines of output
        for (let i = 0; i < 10; i++) {
          tmux.sendKeys(testSession, `echo line-${i}`);
        }
        const { execSync } = require('node:child_process');
        execSync('sleep 1');
        const limited = tmux.capturePane(testSession, { lines: 3 });
        const full = tmux.capturePane(testSession, { full: true });
        assert.ok(full.lines.length >= limited.lines.length,
          `Full (${full.lines.length}) should be >= limited (${limited.lines.length})`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('isAlternateScreen', () => {
    it('should return false for non-existent session', () => {
      assert.equal(tmux.isAlternateScreen('__nonexistent_test_session__'), false);
    });

    it('should return false for a normal bash session (not in alternate screen)', () => {
      const testSession = '__tc_test_altscreen__';
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        assert.equal(tmux.isAlternateScreen(testSession), false);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('capturePane - alternate screen handling', () => {
    const testSession = '__tc_test_altcap__';

    it('should return alternateScreen false for normal bash pane', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        const capture = tmux.capturePane(testSession, { full: true });
        assert.equal(capture.alternateScreen, false);
        assert.ok(Array.isArray(capture.lines));
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should return alternateScreen true and visible content for TUI pane', () => {
      try {
        // Use `less` as a controlled alternate screen app
        tmux.createSession(testSession, { command: 'exec bash' });
        tmux.sendKeys(testSession, 'echo hello-alt-test | less');
        const { execSync } = require('node:child_process');
        execSync('sleep 0.5');
        const capture = tmux.capturePane(testSession, { full: true });
        assert.equal(capture.alternateScreen, true);
        assert.ok(Array.isArray(capture.lines));
        // less should show our content on the visible screen
        const joined = capture.lines.join('\n');
        assert.ok(joined.includes('hello-alt-test'),
          `Expected visible content to include "hello-alt-test", got: ${joined.slice(0, 200)}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });
});
