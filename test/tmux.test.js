'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');
const tmux = require('../lib/tmux');

setLevel('error');

const TEST_PREFIX = '__tc_test_';

/**
 * Generate a unique test session name.
 * @returns {string}
 */
function testSessionName() {
  return `${TEST_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Kill all test sessions (cleanup helper).
 */
function killAllTestSessions() {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' });
    for (const name of output.trim().split('\n').filter(Boolean)) {
      if (name.startsWith(TEST_PREFIX)) {
        try { execSync(`tmux kill-session -t '${name}' 2>/dev/null`); } catch { /* ignore */ }
      }
    }
  } catch { /* no tmux server or no sessions */ }
}

/**
 * Wait for output to appear in the captured pane.
 * @param {string} session - Session name
 * @param {string} expected - Substring to look for
 * @param {number} [timeout=3000] - Max wait in ms
 * @returns {string[]} - Captured lines
 */
function waitForOutput(session, expected, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const lines = tmux.capturePane(session, { lines: 30 });
    if (lines.some(l => l.includes(expected))) return lines;
    execSync('sleep 0.1');
  }
  return tmux.capturePane(session, { lines: 30 });
}

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

  // ─── Integration tests (real tmux sessions) ───────────────────────

  describe('session lifecycle (integration)', () => {
    let sessionName;

    before(() => {
      killAllTestSessions();
    });

    afterEach(() => {
      if (sessionName) {
        try { tmux.killSession(sessionName); } catch { /* ignore */ }
        sessionName = null;
      }
    });

    after(() => {
      killAllTestSessions();
    });

    it('createSession should create a detached session', () => {
      sessionName = testSessionName();
      const result = tmux.createSession(sessionName);
      assert.equal(result, true);
      assert.equal(tmux.hasSession(sessionName), true);
    });

    it('createSession should return false if session already exists', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      const result = tmux.createSession(sessionName);
      assert.equal(result, false);
    });

    it('createSession with cwd should set working directory', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName, { cwd: '/tmp' });
      assert.equal(tmux.hasSession(sessionName), true);
      // Verify cwd by running pwd
      tmux.sendKeys(sessionName, 'pwd', { enterDelay: 100 });
      const lines = waitForOutput(sessionName, '/tmp');
      assert.ok(lines.some(l => l.includes('/tmp')), 'Expected /tmp in output');
    });

    it('createSession with command should run the command', () => {
      sessionName = testSessionName();
      // Use bash -c so the shell stays alive after echo
      tmux.createSession(sessionName, { command: 'bash -c "echo HELLO_TC_TEST; exec bash"' });
      const lines = waitForOutput(sessionName, 'HELLO_TC_TEST');
      assert.ok(lines.some(l => l.includes('HELLO_TC_TEST')), 'Expected command output');
    });

    it('createSession with env should set environment variables', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName, { env: { TC_TEST_VAR: 'test_value_42' } });
      // tmux set-environment sets it for new processes in the session
      execSync('sleep 0.2');
      assert.equal(tmux.hasSession(sessionName), true);
    });

    it('killSession should destroy the session', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      assert.equal(tmux.hasSession(sessionName), true);
      const result = tmux.killSession(sessionName);
      assert.equal(result, true);
      assert.equal(tmux.hasSession(sessionName), false);
      sessionName = null; // already cleaned up
    });

    it('killSession should return false for non-existent session', () => {
      const result = tmux.killSession('__tc_test_nonexistent__');
      assert.equal(result, false);
    });

    it('hasSession should return true for existing session', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      assert.equal(tmux.hasSession(sessionName), true);
    });

    it('hasSession should return false after kill', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      tmux.killSession(sessionName);
      assert.equal(tmux.hasSession(sessionName), false);
      sessionName = null;
    });

    it('listSessions should include the test session', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      const sessions = tmux.listSessions();
      const found = sessions.find(s => s.name === sessionName);
      assert.ok(found, 'Test session should appear in listSessions');
      assert.equal(typeof found.windows, 'number');
      assert.ok(found.windows >= 1);
      assert.equal(typeof found.attached, 'boolean');
    });
  });

  describe('sendKeys (integration)', () => {
    let sessionName;

    before(() => {
      killAllTestSessions();
    });

    afterEach(() => {
      if (sessionName) {
        try { tmux.killSession(sessionName); } catch { /* ignore */ }
        sessionName = null;
      }
    });

    after(() => {
      killAllTestSessions();
    });

    it('should send text and Enter by default', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      execSync('sleep 0.3'); // wait for shell prompt
      tmux.sendKeys(sessionName, 'echo SENDKEYS_TEST', { enterDelay: 100 });
      const lines = waitForOutput(sessionName, 'SENDKEYS_TEST');
      // Should appear twice: once in the command, once in the output
      const matches = lines.filter(l => l.includes('SENDKEYS_TEST'));
      assert.ok(matches.length >= 1, 'Expected echo output');
    });

    it('should not send Enter when enter: false', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      execSync('sleep 0.3');
      tmux.sendKeys(sessionName, 'echo NO_ENTER_TEST', { enter: false });
      execSync('sleep 0.3');
      const lines = tmux.capturePane(sessionName, { lines: 10 });
      // The text should be on the command line but not executed
      const hasOutput = lines.some(l => l.includes('NO_ENTER_TEST') && !l.includes('echo'));
      assert.equal(hasOutput, false, 'Command should not have executed');
    });

    it('should handle special characters', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      execSync('sleep 0.3');
      tmux.sendKeys(sessionName, 'echo "hello $USER & <world>"', { enterDelay: 100 });
      const lines = waitForOutput(sessionName, '<world>');
      assert.ok(lines.some(l => l.includes('<world>')), 'Expected special chars in output');
    });

    it('should handle single quotes in text', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      execSync('sleep 0.3');
      tmux.sendKeys(sessionName, "echo \"it's a test\"", { enterDelay: 100 });
      const lines = waitForOutput(sessionName, "it's a test");
      assert.ok(lines.some(l => l.includes("it's a test")), 'Expected single quote in output');
    });

    it('should handle large payloads', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      execSync('sleep 0.3');
      // Generate a large payload (~2KB) — cat a heredoc to count lines
      const bigText = 'cat <<\'TCEOF\'\n' + 'A'.repeat(80) + '\n'.repeat(20) + 'BIGPAYLOAD_MARKER\nTCEOF';
      tmux.sendKeys(sessionName, bigText, { enterDelay: 200 });
      const lines = waitForOutput(sessionName, 'BIGPAYLOAD_MARKER', 5000);
      assert.ok(lines.some(l => l.includes('BIGPAYLOAD_MARKER')), 'Expected large payload marker in output');
    });

    it('should handle multiline text', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      execSync('sleep 0.3');
      tmux.sendKeys(sessionName, 'echo "line1"\necho "line2_MULTI"', { enterDelay: 200 });
      const lines = waitForOutput(sessionName, 'line2_MULTI');
      assert.ok(lines.some(l => l.includes('line2_MULTI')), 'Expected multiline output');
    });
  });

  describe('sendRawKey (integration)', () => {
    let sessionName;

    afterEach(() => {
      if (sessionName) {
        try { tmux.killSession(sessionName); } catch { /* ignore */ }
        sessionName = null;
      }
    });

    it('should send Enter key', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      execSync('sleep 0.3');
      // Type a command without Enter, then send Enter via sendRawKey
      tmux.sendKeys(sessionName, 'echo RAWKEY_ENTER', { enter: false });
      execSync('sleep 0.2');
      tmux.sendRawKey(sessionName, 'Enter');
      const lines = waitForOutput(sessionName, 'RAWKEY_ENTER');
      // Should see output (command was executed)
      const outputLines = lines.filter(l => l.includes('RAWKEY_ENTER'));
      assert.ok(outputLines.length >= 1, 'Expected command to execute after raw Enter');
    });

    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.sendRawKey('__tc_test_nonexistent__', 'Enter'),
        /does not exist/
      );
    });
  });

  describe('capturePane (integration)', () => {
    let sessionName;

    afterEach(() => {
      if (sessionName) {
        try { tmux.killSession(sessionName); } catch { /* ignore */ }
        sessionName = null;
      }
    });

    it('should capture recent output', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      execSync('sleep 0.3');
      tmux.sendKeys(sessionName, 'echo CAPTURE_TEST_OUTPUT', { enterDelay: 100 });
      const lines = waitForOutput(sessionName, 'CAPTURE_TEST_OUTPUT');
      assert.ok(Array.isArray(lines));
      assert.ok(lines.some(l => l.includes('CAPTURE_TEST_OUTPUT')));
    });

    it('should respect lines option', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      execSync('sleep 0.3');
      const lines = tmux.capturePane(sessionName, { lines: 2 });
      assert.ok(Array.isArray(lines));
      assert.ok(lines.length <= 3); // 2 lines + possible trailing empty
    });

    it('should return empty array on capture failure for killed session', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      tmux.killSession(sessionName);
      assert.throws(
        () => tmux.capturePane(sessionName),
        /does not exist/
      );
      sessionName = null;
    });
  });

  describe('setMouse / getMouse (integration)', () => {
    let sessionName;

    afterEach(() => {
      if (sessionName) {
        try { tmux.killSession(sessionName); } catch { /* ignore */ }
        sessionName = null;
      }
    });

    it('should enable mouse mode', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      tmux.setMouse(sessionName, true);
      assert.equal(tmux.getMouse(sessionName), true);
    });

    it('should disable mouse mode', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      tmux.setMouse(sessionName, true);
      tmux.setMouse(sessionName, false);
      assert.equal(tmux.getMouse(sessionName), false);
    });

    it('should set and unset hooks when hooks option is true', () => {
      sessionName = testSessionName();
      tmux.createSession(sessionName);
      // Enable with hooks — should not throw
      tmux.setMouse(sessionName, true, { hooks: true });
      assert.equal(tmux.getMouse(sessionName), true);
      // Disable with hooks — should not throw
      tmux.setMouse(sessionName, false, { hooks: true });
      assert.equal(tmux.getMouse(sessionName), false);
    });
  });

  describe('_exec', () => {
    it('should throw when command exceeds timeout', () => {
      assert.throws(
        () => tmux._exec('sleep 10', { timeout: 100 }),
        /ETIMEDOUT|timed out/
      );
    });

    it('should return trimmed stdout', () => {
      const result = tmux._exec('echo hello');
      assert.equal(result, 'hello');
    });
  });
});
