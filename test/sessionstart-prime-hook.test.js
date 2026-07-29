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

  // ── Chunk 3 hardening: set -u + ${VAR:-} defaults ──

  it('declares set -u for variable strictness (chunk 3 hardening)', () => {
    // Locks in the chunk-3 hardening: hook script uses `set -u` so a typo in any
    // env-var reference fails fast at install time rather than silently producing
    // an empty prime. The original `set +e` was a no-op (errexit off by default)
    // and is replaced by `set -u`.
    const src = fs.readFileSync(HOOK_SCRIPT, 'utf8');
    assert.match(src, /^\s*set -u\s*$/m);
    assert.ok(!/^\s*set \+e\s*$/m.test(src), 'no-op `set +e` should be gone');
  });

  it('uses ${CLAUDE_PROJECT_DIR:-} default to survive set -u when env is unset', () => {
    // Without the `:-` default, an unset CLAUDE_PROJECT_DIR would trip set -u and
    // exit non-zero, violating the always-exit-0 contract. The defensive default
    // is the structural reason the unset-env test (above) keeps passing.
    const src = fs.readFileSync(HOOK_SCRIPT, 'utf8');
    assert.match(src, /\$\{CLAUDE_PROJECT_DIR:-\}/);
    // And there's no bare ${CLAUDE_PROJECT_DIR} reference (would fail under set -u).
    const bareRefs = src.match(/\$\{CLAUDE_PROJECT_DIR\}/g) || [];
    assert.equal(bareRefs.length, 0, 'no bare ${CLAUDE_PROJECT_DIR} dereferences under set -u');
  });

  it('cat is guarded by `|| true` to survive a race where the file vanishes', () => {
    // Between the [ -f ] readability check and `cat`, an aggressive cleanup or
    // a filesystem-removed-after-test could disappear the file. Without `|| true`
    // a future addition of `set -e` would make that exit non-zero. The guard is
    // a small forward-defense.
    const src = fs.readFileSync(HOOK_SCRIPT, 'utf8');
    assert.match(src, /cat "\$PRIME_FILE"\s*\|\|\s*true/);
  });

  it('survives an empty CLAUDE_PROJECT_DIR (set, but blank)', () => {
    // Distinct from the unset case: an explicitly-blank env var would set
    // PRIME_FILE='/.tangleclaw/session-prime.md' (root-level path) under naive
    // expansion. The `[ -n "${CLAUDE_PROJECT_DIR:-}" ]` guard rejects empty
    // strings before that path is consulted.
    const env = { ...process.env, CLAUDE_PROJECT_DIR: '' };
    const out = execFileSync(HOOK_SCRIPT, [], { env, input: '', encoding: 'utf8' });
    assert.equal(out, '');
  });
});

/*
 * #759 — every emitted hook command must survive an install path with a space.
 *
 * Reported from the field: a TangleClaw directory under `~/Library/Mobile
 * Documents/…` made every Claude session start fail with
 * `/bin/sh: /Users/<user>/Library/Mobile  No such file or directory`. The prime
 * hook was emitted unquoted while the rules hook fifteen lines below it was
 * quoted, with a comment naming this exact hazard — so a test that sampled one
 * command could pass while the other shipped broken.
 *
 * This asserts over EVERY command `_buildBaselineHooks` emits, and asserts it
 * by running the command the way Claude Code does rather than by inspecting the
 * string. Unreproducible on this machine's own install, whose path has no space.
 */
describe('#759 hook commands survive a TangleClaw path containing a space', () => {
  const engines = require('../lib/engines');

  // Matches this file's existing convention — every fixture root this block
  // creates is torn down, so a run leaves nothing behind in tmp.
  const fixtureRoots = [];
  afterEach(() => {
    while (fixtureRoots.length) fs.rmSync(fixtureRoots.pop(), { recursive: true, force: true });
  });

  /** An engine profile that opts into the silent-prime hook. */
  const PROFILE = { id: 'claude', capabilities: { supportsSilentPrime: true } };

  /**
   * Build a fake TangleClaw dir whose path contains a space, with executable
   * no-op stand-ins for every shipped hook script.
   * @returns {string} the directory path
   */
  function makeSpacedInstallDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hooks-'));
    fixtureRoots.push(root);
    const dir = path.join(root, 'Mobile Documents', 'TangleClaw');
    fs.mkdirSync(path.join(dir, 'data', 'hooks'), { recursive: true });
    for (const name of ['sessionstart-prime.sh', 'sessionstart-rules.sh']) {
      const p = path.join(dir, 'data', 'hooks', name);
      fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(p, 0o755);
    }
    assert.ok(dir.includes(' '), 'the fixture must actually contain a space');
    return dir;
  }

  /** Every command string in a hooks object, flattened. @returns {string[]} */
  function allCommands(hooks) {
    const out = [];
    for (const entries of Object.values(hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) out.push(h.command);
      }
    }
    return out;
  }

  it('runs every emitted command from a spaced install path', () => {
    const dir = makeSpacedInstallDir();
    // Two shards so the rules hook is emitted more than once — the loop that
    // builds them must not be the only guarded path.
    const hooks = engines._buildBaselineHooks({ silentPrime: true }, PROFILE, 2);
    const commands = allCommands(hooks);
    assert.ok(commands.length >= 2, `expected prime + rules commands, got ${commands.length}`);

    for (const raw of commands) {
      const command = raw.replace(/\{\{TANGLECLAW_DIR\}\}/g, dir);
      // Exactly how the engine runs it: hand the string to a shell.
      execFileSync('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    }
  });

  it('covers the prime hook specifically, since that is the one that shipped broken', () => {
    const dir = makeSpacedInstallDir();
    const hooks = engines._buildBaselineHooks({ silentPrime: true }, PROFILE, 0);
    const commands = allCommands(hooks);
    assert.equal(commands.length, 1, 'with no rule shards, only the prime hook is emitted');
    const command = commands[0].replace(/\{\{TANGLECLAW_DIR\}\}/g, dir);
    assert.match(command, /sessionstart-prime\.sh/);
    execFileSync('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
  });
});
