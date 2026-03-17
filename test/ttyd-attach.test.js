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

  it('should use tmux new-session -A (attach-or-create)', () => {
    const tmuxLine = codeLines().find(l => l.includes('tmux'));
    assert.ok(tmuxLine, 'script must contain a tmux command');
    assert.match(
      tmuxLine,
      /tmux\s+new-session\s+-A/,
      'must use "tmux new-session -A" for atomic attach-or-create'
    );
  });

  it('should NOT use the broken exec-or-exec pattern', () => {
    // The pattern `exec cmd || exec cmd` is broken because exec replaces the
    // shell process — the || fallback can never run. This caused a rapid
    // reconnect loop when tmux sessions died overnight.
    const hasExecOr = codeLines().some(l =>
      /exec\s+.*\|\|/.test(l)
    );
    assert.ok(
      !hasExecOr,
      'must not use "exec cmd || exec cmd" — exec replaces the shell so || is dead code'
    );
  });

  it('should exec the final tmux command (not fork)', () => {
    const tmuxLine = codeLines().find(l => l.includes('tmux'));
    assert.match(
      tmuxLine,
      /^\s*exec\s+tmux/,
      'tmux command should be called with exec to replace the shell process'
    );
  });

  it('should quote the session variable', () => {
    const tmuxLine = codeLines().find(l => l.includes('tmux'));
    assert.match(
      tmuxLine,
      /"\$session"/,
      'session variable must be quoted to handle names with spaces'
    );
  });

  it('should sanitize the session name for tmux', () => {
    // Script must replace spaces and strip invalid chars before passing to tmux
    assert.ok(
      script.includes("tr ' ' '-'"),
      'should replace spaces with hyphens for tmux compatibility'
    );
  });
});
