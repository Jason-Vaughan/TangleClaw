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

  describe('sendKeys - behavioral', () => {
    const testSession = '__tc_test_sendkeys__';
    const { execSync } = require('node:child_process');

    function captureContent(session) {
      // Small delay so the shell finishes processing before we capture
      execSync('sleep 0.4');
      const cap = tmux.capturePane(session, { full: true });
      return cap.lines.join('\n');
    }

    it('should deliver simple text and execute it when enter:true (default)', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        tmux.sendKeys(testSession, 'echo hello-from-send-keys');
        const content = captureContent(testSession);
        assert.ok(
          content.includes('hello-from-send-keys'),
          `Expected output to contain echoed string, got: ${content.slice(0, 200)}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should NOT execute the line when enter:false', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Use a marker that would only appear in OUTPUT (not the prompt) if executed
        tmux.sendKeys(testSession, 'echo not-executed-marker', { enter: false });
        execSync('sleep 0.4');
        const cap = tmux.capturePane(testSession, { full: true });
        const content = cap.lines.join('\n');
        // The text is on the prompt line; with no Enter, only the literal command appears once.
        // After Enter we'd see two occurrences (command + echoed output).
        const occurrences = (content.match(/not-executed-marker/g) || []).length;
        assert.equal(occurrences, 1,
          `Expected exactly 1 occurrence of marker (command on prompt only, not executed), got ${occurrences}: ${content.slice(0, 200)}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should preserve single quotes in delivered text', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Single quotes are the trickiest case for shell escaping
        tmux.sendKeys(testSession, `echo "it's working"`);
        const content = captureContent(testSession);
        assert.ok(
          content.includes("it's working"),
          `Expected single-quoted content to be preserved, got: ${content.slice(0, 200)}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should preserve special shell characters ($, `, \\)', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Send a literal string with characters that would normally be interpreted
        tmux.sendKeys(testSession, `echo 'a$b\`c\\d'`);
        const content = captureContent(testSession);
        assert.ok(
          content.includes('a$b`c\\d'),
          `Expected special chars preserved literally, got: ${content.slice(0, 200)}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should deliver large multi-line payloads (>4KB) intact', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Build a heredoc that echoes a large unique marker after a long preamble
        // This catches the original 3.11.0 regression where large payloads truncated.
        const filler = 'x'.repeat(4500);
        const marker = 'large-payload-marker-end';
        tmux.sendKeys(testSession, `echo '${filler}' > /dev/null && echo ${marker}`);
        const content = captureContent(testSession);
        assert.ok(
          content.includes(marker),
          `Expected large payload to execute fully and reach marker, got tail: ${content.slice(-300)}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should use tmux paste-buffer -p so LFs are not replaced with CR (#75)', () => {
      // Source-level regression: tmux's `paste-buffer` default replaces every LF
      // with CR (per tmux 3.6 man page), which collapses multi-line prime prompts
      // into a single line when pasted into a TUI (#75). The -p flag wraps the
      // paste in bracketed-paste escape sequences — tmux then sends LFs literally
      // to apps that advertise bracketed-paste mode (Claude Code, Codex, etc.).
      // If this ever regresses to `paste-buffer -t` (no -p) the bug is back.
      const fs = require('node:fs');
      const path = require('node:path');
      const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8');
      assert.match(
        source,
        /tmux paste-buffer -p -t/,
        'lib/tmux.js must invoke `tmux paste-buffer -p -t ...` to preserve LFs in multi-line payloads (#75)'
      );
      assert.doesNotMatch(
        source,
        /tmux paste-buffer -t /,
        'lib/tmux.js must not call paste-buffer without -p — default LF→CR replacement causes #75'
      );
    });
  });

  describe('sendRawKey', () => {
    const testSession = '__tc_test_rawkey__';
    const { execSync } = require('node:child_process');

    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.sendRawKey('__nonexistent_test_session__', 'Enter'),
        /does not exist/
      );
    });

    it('should send Enter as a raw key (executes pending command)', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Stage a command without executing it
        tmux.sendKeys(testSession, 'echo raw-enter-marker', { enter: false });
        execSync('sleep 0.3');
        // Now send Enter via sendRawKey to execute it
        tmux.sendRawKey(testSession, 'Enter');
        execSync('sleep 0.4');
        const cap = tmux.capturePane(testSession, { full: true });
        const content = cap.lines.join('\n');
        // After Enter, the marker should appear at least twice (typed + echoed output)
        const occurrences = (content.match(/raw-enter-marker/g) || []).length;
        assert.ok(occurrences >= 2,
          `Expected marker to appear at least twice after Enter, got ${occurrences}: ${content.slice(0, 200)}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('killSession - success path', () => {
    const testSession = '__tc_test_killsuccess__';

    it('should return true and remove the session', () => {
      tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
      assert.equal(tmux.hasSession(testSession), true, 'precondition: session should exist');
      const result = tmux.killSession(testSession);
      assert.equal(result, true, 'killSession should return true on success');
      assert.equal(tmux.hasSession(testSession), false, 'session should be gone after kill');
    });

    it('should return false when killing a non-existent session', () => {
      const result = tmux.killSession('__never_existed_session__');
      assert.equal(result, false);
    });
  });
});
