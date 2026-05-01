'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const HOOK_SCRIPT = path.join(__dirname, '..', 'data', 'hooks', 'sessionstart-prime.sh');

describe('sessionstart-prime.sh hook script (#103)', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sessionstart-hook-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  /**
   * Run the hook with CLAUDE_PROJECT_DIR set, returning stdout as a string.
   * @param {string|null} stdinJson - Stdin payload (Claude Code passes hook event JSON); null skips
   * @returns {string}
   */
  function runHook(stdinJson) {
    return execFileSync(HOOK_SCRIPT, [], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      input: stdinJson || '',
      encoding: 'utf8'
    });
  }

  it('script exists and is executable', () => {
    const stat = fs.statSync(HOOK_SCRIPT);
    assert.ok(stat.isFile(), 'hook script should be a file');
    // 0o100 == owner-execute bit
    assert.ok((stat.mode & 0o100) !== 0, 'hook script should have owner-execute bit set');
  });

  it('cats the session-prime.md when present', () => {
    const dir = path.join(projectDir, '.tangleclaw');
    fs.mkdirSync(dir, { recursive: true });
    const body = '# Session Prime\nLast session: shipped #103\n';
    fs.writeFileSync(path.join(dir, 'session-prime.md'), body);

    const out = runHook(null);
    assert.equal(out, body);
  });

  it('exits 0 silently when prime file is missing', () => {
    // No prime file written → hook should produce empty stdout and exit 0.
    const out = runHook(null);
    assert.equal(out, '');
  });

  it('exits 0 silently when CLAUDE_PROJECT_DIR is unset', () => {
    // Drop CLAUDE_PROJECT_DIR from env. Without it the hook must still exit 0
    // so Claude Code does not surface a hook error to the user.
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const out = execFileSync(HOOK_SCRIPT, [], { env, input: '', encoding: 'utf8' });
    assert.equal(out, '');
  });

  it('preserves multi-line content exactly (no LF→CR mangling)', () => {
    // Regression cousin to #75: tmux paste mangled newlines. The hook is plain
    // cat through stdout, so this is more of a sanity-anchor than a bug guard,
    // but it locks the contract that hook stdout = file contents byte-for-byte.
    const dir = path.join(projectDir, '.tangleclaw');
    fs.mkdirSync(dir, { recursive: true });
    const body = 'line one\nline two\n\nline four after blank\n';
    fs.writeFileSync(path.join(dir, 'session-prime.md'), body);

    const out = runHook(null);
    assert.equal(out, body);
  });
});
