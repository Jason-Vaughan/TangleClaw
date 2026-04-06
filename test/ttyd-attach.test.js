'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'deploy', 'ttyd-attach.sh');

describe('deploy/ttyd-attach.sh', () => {
  const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const lines = script.split('\n');

  /** @returns {string[]} Non-empty, non-comment lines */
  function codeLines() {
    return lines.filter(l => l.trim() && !l.startsWith('#'));
  }

  it('should exist and be executable', () => {
    const stat = fs.statSync(SCRIPT_PATH);
    // Check owner-execute bit (0o100)
    assert.ok(stat.mode & 0o100, 'script should have execute permission');
  });

  it('should have a bash shebang', () => {
    assert.match(lines[0], /^#!.*bash/, 'first line should be a bash shebang');
  });

  it('should default session name to "tangleclaw" when no arg given', () => {
    assert.ok(
      script.includes('${1:-tangleclaw}'),
      'should use ${1:-tangleclaw} default for session name'
    );
  });

  it('should check session existence with tmux has-session before attaching', () => {
    assert.ok(
      script.includes('tmux has-session -t'),
      'must check for session existence with tmux has-session'
    );
  });

  it('should use tmux attach-session (not new-session -A) to avoid orphan shells', () => {
    const attachLine = codeLines().find(l => l.includes('tmux attach-session'));
    assert.ok(attachLine, 'must use tmux attach-session for existing sessions');

    const hasNewSessionA = codeLines().some(l =>
      /tmux\s+new-session\s+-A/.test(l)
    );
    assert.ok(
      !hasNewSessionA,
      'must NOT use tmux new-session -A — it creates orphan bare shells when the session is gone (fixes #47)'
    );
  });

  it('should NOT use the broken exec-or-exec pattern', () => {
    const hasExecOr = codeLines().some(l =>
      /exec\s+.*\|\|/.test(l)
    );
    assert.ok(
      !hasExecOr,
      'must not use "exec cmd || exec cmd" — exec replaces the shell so || is dead code'
    );
  });

  it('should exec the tmux attach command (not fork)', () => {
    const attachLine = codeLines().find(l => l.includes('tmux attach-session'));
    assert.match(
      attachLine,
      /^\s*exec\s+tmux/,
      'tmux attach command should be called with exec to replace the shell process'
    );
  });

  it('should quote the session variable', () => {
    const attachLine = codeLines().find(l => l.includes('tmux attach-session'));
    assert.match(
      attachLine,
      /"\$session"/,
      'session variable must be quoted to handle names with spaces'
    );
  });

  it('should sanitize the session name for tmux', () => {
    assert.ok(
      script.includes("tr ' ' '-'"),
      'should replace spaces with hyphens for tmux compatibility'
    );
  });

  it('should show a message when session does not exist', () => {
    assert.ok(
      script.includes('not running'),
      'should display a user-friendly message when the session is gone'
    );
  });

  it('should sleep after showing session-ended message so ttyd keeps the terminal open', () => {
    // Without sleep, ttyd closes the connection immediately when the script
    // exits, flashing the message too briefly to read.
    const elseBlock = script.slice(script.indexOf('else'));
    assert.ok(
      elseBlock.includes('sleep'),
      'should sleep after message so the user can read it before ttyd closes'
    );
  });
});
