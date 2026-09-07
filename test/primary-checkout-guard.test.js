'use strict';

/*
 * #798 — the primary checkout stops being a writable surface for work that
 * belongs elsewhere.
 *
 * These tests drive the REAL hook script as a subprocess over stdin, against a
 * real git repository with a real linked worktree, because every interesting
 * property of this guard is a property of that layout:
 *
 *   - a worktree created by the convention lives UNDER the primary, so it is
 *     lexically inside it and must be subtracted or the guard refuses every
 *     write in every worktree;
 *   - a worktree's governance state is symlinked back into the primary, so
 *     "where does this write land" is a question about resolved paths;
 *   - the guard must FAIL OPEN on every internal error, and the only way to
 *     know that is to observe the process exit and its stdout.
 *
 * A unit test of the predicates in isolation would pass with any of those three
 * broken.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { initRepo } = require('./_temp-repo');
const engines = require('../lib/engines');
const installer = require('../scripts/install-primary-guard');

const REPO_ROOT = path.join(__dirname, '..');
// Taken from the installer rather than restated: the two disagreeing would wire
// a hook at one path and test a script at another, and both halves would pass.
const GUARD_REL = installer.GUARD_REL;

/** Files the guard needs at runtime, copied into each fixture repo. */
const GUARD_SOURCES = [
  GUARD_REL,
  path.join('lib', 'checkout-layout.js'),
  path.join('lib', 'project-paths.js')
];

/**
 * Build a throwaway repository shaped like this one: a primary checkout that is
 * "the running install", plus a linked worktree nested underneath it.
 *
 * @returns {{primary:string, worktree:string, cleanup:function():void}}
 */
function makeFixture() {
  // realpathSync because macOS puts temp dirs under /var, a symlink to
  // /private/var. The guard resolves its paths; a fixture that does not would
  // compare a resolved path against a lexical one and never match.
  const primary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-798-')));
  initRepo(primary, ['-b', 'main']);
  const git = (...args) => execFileSync('git', args, { cwd: primary, stdio: ['pipe', 'pipe', 'pipe'] });
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');

  for (const rel of GUARD_SOURCES) {
    fs.mkdirSync(path.join(primary, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(primary, rel));
  }
  fs.mkdirSync(path.join(primary, 'public'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'public', 'sw.js'), "const CACHE_NAME = 'v1';\n");
  fs.writeFileSync(path.join(primary, 'server.js'), '// server\n');
  fs.writeFileSync(path.join(primary, 'lib', 'x.js'), '// tracked source\n');
  fs.mkdirSync(path.join(primary, '.prawduct'), { recursive: true });
  fs.writeFileSync(path.join(primary, '.prawduct', 'change-log.md'), '# tracked\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  // Untracked, and written in the primary BY DESIGN — the case the guard must
  // never refuse.
  fs.writeFileSync(path.join(primary, '.prawduct', 'learnings.md'), '# untracked\n');

  const worktree = path.join(primary, '.claude', 'worktrees', 'wt');
  git('worktree', 'add', '-q', worktree, '-b', 'feat/x');

  // The convention: untracked governance state is symlinked back to the primary.
  // `change-log.md` is TRACKED and symlinking it is a known defect (#710 chunk
  // 3) — it is linked here on purpose, because the guard refusing it is the
  // documented correct answer.
  fs.rmSync(path.join(worktree, '.prawduct', 'change-log.md'), { force: true });
  fs.symlinkSync(path.join(primary, '.prawduct', 'change-log.md'),
    path.join(worktree, '.prawduct', 'change-log.md'));
  fs.symlinkSync(path.join(primary, '.prawduct', 'learnings.md'),
    path.join(worktree, '.prawduct', 'learnings.md'));

  return {
    primary,
    worktree,
    cleanup: () => fs.rmSync(primary, { recursive: true, force: true })
  };
}

/**
 * Invoke the guard exactly as Claude Code would.
 *
 * @param {object} opts - Invocation description.
 * @param {string} opts.primary - Fixture primary checkout.
 * @param {string} opts.sessionRoot - Value for `CLAUDE_PROJECT_DIR`; null to unset.
 * @param {string} [opts.cwd] - The tool's working directory.
 * @param {string} [opts.tool] - Tool name.
 * @param {object} [opts.toolInput] - The tool's input object.
 * @param {object} [opts.env] - Extra environment.
 * @param {string} [opts.rawStdin] - Send this verbatim instead of JSON.
 * @returns {{status:number, stdout:string, stderr:string, decision:string|null, reason:string}}
 */
function runGuard(opts) {
  const env = { ...process.env, ...(opts.env || {}) };
  delete env.TANGLECLAW_ALLOW_PRIMARY_WRITE;
  if (opts.env && 'TANGLECLAW_ALLOW_PRIMARY_WRITE' in opts.env) {
    env.TANGLECLAW_ALLOW_PRIMARY_WRITE = opts.env.TANGLECLAW_ALLOW_PRIMARY_WRITE;
  }
  if (opts.sessionRoot === null) delete env.CLAUDE_PROJECT_DIR;
  else env.CLAUDE_PROJECT_DIR = opts.sessionRoot;

  const payload = opts.rawStdin !== undefined ? opts.rawStdin : JSON.stringify({
    tool_name: opts.tool || 'Write',
    tool_input: opts.toolInput || {},
    cwd: opts.cwd || opts.sessionRoot
  });

  const res = spawnSync(process.execPath, [path.join(opts.primary, GUARD_REL)], {
    input: payload,
    env,
    encoding: 'utf8'
  });
  let decision = null;
  let reason = '';
  if (res.stdout && res.stdout.trim()) {
    const parsed = JSON.parse(res.stdout);
    decision = parsed.hookSpecificOutput.permissionDecision;
    reason = parsed.hookSpecificOutput.permissionDecisionReason;
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, decision, reason };
}

describe('#798 primary-checkout guard — P1, the session is rooted in a worktree', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('refuses a tracked write that lands in the primary', () => {
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.worktree, cwd: fx.primary,
      toolInput: { file_path: path.join(fx.primary, 'lib', 'x.js') }
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /tracked file in the PRIMARY checkout/);
    assert.ok(r.reason.includes(fx.worktree),
      'the refusal must name where the write should have gone, or it is unactionable');
    assert.match(r.reason, /TANGLECLAW_ALLOW_PRIMARY_WRITE/);
  });

  it('allows the same write inside the worktree — a nested worktree is not the primary', () => {
    // The load-bearing case for enumerating worktree roots: `.claude/worktrees/wt`
    // is LEXICALLY inside the primary, so a containment test that did not
    // subtract it would refuse every write in every worktree.
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.worktree, cwd: fx.worktree,
      toolInput: { file_path: path.join(fx.worktree, 'lib', 'x.js') }
    });
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
    assert.equal(r.status, 0);
  });

  it('allows an UNTRACKED write in the primary — .prawduct/ is written there by design', () => {
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.worktree, cwd: fx.primary,
      toolInput: { file_path: path.join(fx.primary, '.prawduct', 'reflections.md') }
    });
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('allows a write through the worktree symlink to UNTRACKED governance state', () => {
    // Resolves into the primary, and must still be allowed: this is how every
    // worktree session writes its learnings and evidence.
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.worktree, cwd: fx.worktree,
      toolInput: { file_path: path.join(fx.worktree, '.prawduct', 'learnings.md') }
    });
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('refuses a write through a symlink that redirects a TRACKED file into the primary', () => {
    // Blanket-symlinking `.prawduct/` replaces the branch's change-log with the
    // primary's — silent, and a known defect. The guard catching it is the
    // correct answer, not a false positive.
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.worktree, cwd: fx.worktree,
      toolInput: { file_path: path.join(fx.worktree, '.prawduct', 'change-log.md') }
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /tracked file in the PRIMARY checkout/);
  });

  it('does not fire when the session is rooted in the primary', () => {
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.primary, cwd: fx.primary,
      toolInput: { file_path: path.join(fx.primary, 'lib', 'x.js') }
    });
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('reads notebook_path as well as file_path', () => {
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.worktree, cwd: fx.primary, tool: 'NotebookEdit',
      toolInput: { notebook_path: path.join(fx.primary, 'lib', 'x.js') }
    });
    assert.equal(r.decision, 'deny');
  });
});

describe('#798 primary-checkout guard — P2, the live-on-write serving surface', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('refuses public/** in the primary even from a primary-rooted session', () => {
    // The Train 14 shape: a swarm coordinator launched in the primary. P1 cannot
    // see this, which is why P2 is not conditioned on the session root.
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.primary, cwd: fx.primary,
      toolInput: { file_path: path.join(fx.primary, 'public', 'sw.js') }
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /served LIVE off the primary checkout/);
  });

  it('refuses server.js in the primary', () => {
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.primary, cwd: fx.primary,
      toolInput: { file_path: path.join(fx.primary, 'server.js') }
    });
    assert.equal(r.decision, 'deny');
  });

  it('allows lib/** from a primary-rooted session — live on restart, not on write', () => {
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.primary, cwd: fx.primary,
      toolInput: { file_path: path.join(fx.primary, 'lib', 'x.js') }
    });
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('allows public/** inside a worktree — nothing serves that tree', () => {
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.worktree, cwd: fx.worktree,
      toolInput: { file_path: path.join(fx.worktree, 'public', 'sw.js') }
    });
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('resolves a relative file_path against the tool cwd', () => {
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.primary, cwd: fx.primary,
      toolInput: { file_path: path.join('public', 'sw.js') }
    });
    assert.equal(r.decision, 'deny');
  });
});

describe('#798 primary-checkout guard — Bash, working-tree-moving commands', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  const bash = (command, sessionRoot, cwd) => runGuard({
    primary: fx.primary, sessionRoot, cwd, tool: 'Bash', toolInput: { command }
  });

  it('refuses a checkout in the primary from a worktree-rooted session', () => {
    const r = bash('git checkout main', fx.worktree, fx.primary);
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /moves the working tree of the PRIMARY checkout/);
  });

  it('refuses `git -C <primary> switch` issued from the worktree', () => {
    const r = bash(`git -C ${fx.primary} switch main`, fx.worktree, fx.worktree);
    assert.equal(r.decision, 'deny');
  });

  it('refuses `cd <primary> && git reset --hard`, which never changes the reported cwd', () => {
    const r = bash(`cd ${fx.primary} && git reset --hard origin/main`, fx.worktree, fx.worktree);
    assert.equal(r.decision, 'deny');
  });

  it('allows a checkout inside the worktree', () => {
    const r = bash('git checkout main', fx.worktree, fx.worktree);
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('allows a checkout in the primary from a primary-rooted session — the fast rollback', () => {
    // `git checkout main` in the primary is the documented recovery from a bad
    // branch. Refusing it would take away the fix.
    const r = bash('git checkout main', fx.primary, fx.primary);
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('never refuses a commit — the wrap commits on main in the primary by design', () => {
    const r = bash('git commit -m "wrap"', fx.worktree, fx.primary);
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('does not read a non-git command mentioning a moving verb as one', () => {
    const r = bash('grep -rn "checkout" .', fx.worktree, fx.primary);
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('needs a git token, not just a moving verb standing on its own', () => {
    // Isolates the `git` conjunct. The quoted-word case above cannot: the verb
    // pattern already rejects it, so dropping the git test entirely leaves that
    // assertion green. These are the shapes where the verb IS a bare word and
    // the command has nothing to do with git.
    for (const command of ['npm run reset', 'make checkout', './deploy.sh reset --hard']) {
      const r = bash(command, fx.worktree, fx.primary);
      assert.equal(r.decision, null, `${command} should not read as a working-tree move`);
    }
  });

  it('does not read a git command with no moving verb as one', () => {
    const r = bash('git log --oneline -5', fx.worktree, fx.primary);
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });
});

describe('#798 primary-checkout guard — overrides', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  const denied = () => ({
    primary: fx.primary, sessionRoot: fx.primary, cwd: fx.primary,
    toolInput: { file_path: path.join(fx.primary, 'public', 'sw.js') }
  });

  it('stands down for the env var', () => {
    const r = runGuard({ ...denied(), env: { TANGLECLAW_ALLOW_PRIMARY_WRITE: '1' } });
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('does not stand down for a falsy env value', () => {
    // "0" and "false" read as the operator turning the override OFF, not as
    // setting it — the opposite reading would disarm the guard for anyone who
    // exported it explicitly disabled.
    for (const v of ['0', 'false', '']) {
      const r = runGuard({ ...denied(), env: { TANGLECLAW_ALLOW_PRIMARY_WRITE: v } });
      assert.equal(r.decision, 'deny', `value ${JSON.stringify(v)} should not waive the guard`);
    }
  });

  it('stands down for the sentinel file, and re-arms when it is removed', () => {
    const sentinel = path.join(fx.primary, '.prawduct', '.allow-primary-write');
    fs.writeFileSync(sentinel, '');
    try {
      assert.equal(runGuard(denied()).decision, null);
    } finally {
      fs.rmSync(sentinel);
    }
    assert.equal(runGuard(denied()).decision, 'deny');
  });
});

describe('#798 primary-checkout guard — every failure path exits 0 with no decision', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  const denied = (over) => ({
    primary: fx.primary, sessionRoot: fx.primary, cwd: fx.primary,
    toolInput: { file_path: path.join(fx.primary, 'public', 'sw.js') }, ...over
  });

  it('control: the same call refuses when nothing is broken', () => {
    // Without this, every assertion below passes for a guard that never fires.
    assert.equal(runGuard(denied()).decision, 'deny');
  });

  it('falls open when CLAUDE_PROJECT_DIR is unset, and says why on stderr', () => {
    const r = runGuard(denied({ sessionRoot: null }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /CLAUDE_PROJECT_DIR is unset/);
  });

  it('falls open when the session root is not a checkout', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-798-nogit-'));
    try {
      const r = runGuard(denied({ sessionRoot: outside }));
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /could not establish the checkout layout/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('falls open on unparseable stdin', () => {
    const r = runGuard(denied({ rawStdin: 'not json' }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /could not parse the tool input/);
  });

  it('falls open on stdin that parses but carries no tool input', () => {
    const r = runGuard(denied({ rawStdin: '{}' }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('falls open when the evaluation itself throws', () => {
    // The last-resort catch, and the only property in this file that decides
    // whether a bug here costs an edit or costs the whole session: a non-zero
    // hook exit is fed back as a synthetic user message and starts a new turn.
    // Every other case above is handled by an explicit branch and leaves that
    // catch unexercised — a numeric `cwd` reaches it, because path resolution
    // throws on a non-string.
    const r = runGuard(denied({
      rawStdin: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.primary, 'public', 'sw.js') },
        cwd: 12345
      })
    }));
    assert.equal(r.status, 0, 'a throwing guard must still exit 0');
    assert.equal(r.stdout, '', 'and must emit no decision');
    assert.match(r.stderr, /internal error/);
  });
});

describe('#798 installer — scripts/install-primary-guard.js', () => {
  it('wires two matchers, both invoking the guard', () => {
    const { settings } = installer.apply({}, '/repo', 'install');
    const entries = settings.hooks.PreToolUse;
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.matcher).sort(),
      ['Bash', installer.WRITE_MATCHER].sort());
    assert.ok(entries.every((e) => installer.isGuardEntry(e)));
  });

  it('ends the command in `|| true`, so the guard can never fail a hook', () => {
    // A non-zero hook exit is fed back as a synthetic user message and starts a
    // new turn — the loop this guard exists downstream of. The suffix is the
    // only thing that makes that structurally impossible.
    assert.match(installer.guardCommand('/repo'), /\|\| true$/);
    assert.ok(installer.guardCommand('/repo').includes(installer.GUARD_REL));
  });

  it('is idempotent — a second install changes nothing', () => {
    const once = installer.apply({}, '/repo', 'install').settings;
    const twice = installer.apply(once, '/repo', 'install');
    assert.equal(twice.changed, false);
    assert.equal(twice.settings.hooks.PreToolUse.length, 2);
  });

  it('re-wires without duplicating when the command prefix changed', () => {
    // Matched on the script basename, not the whole command, so a reworked
    // invocation does not read as "not installed" and stack a second entry.
    const stale = {
      hooks: {
        PreToolUse: [{
          matcher: 'Edit',
          hooks: [{ type: 'command', command: 'node /old/path/guard-primary-checkout.js' }]
        }]
      }
    };
    const out = installer.apply(stale, '/repo', 'install').settings;
    assert.equal(out.hooks.PreToolUse.length, 2);
  });

  it('preserves foreign PreToolUse entries and every other key', () => {
    const before = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo operator' }] }],
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo prime' }] }]
      }
    };
    const out = installer.apply(before, '/repo', 'install').settings;
    assert.deepEqual(out.permissions, before.permissions);
    assert.deepEqual(out.hooks.SessionStart, before.hooks.SessionStart);
    assert.equal(out.hooks.PreToolUse.filter((e) => !installer.isGuardEntry(e)).length, 1);
  });

  it('--remove takes only its own entries, and leaves no empty scaffolding', () => {
    const wired = installer.apply({}, '/repo', 'install').settings;
    const out = installer.apply(wired, '/repo', 'remove');
    assert.equal(out.wiredBefore, true);
    assert.equal(out.settings.hooks, undefined,
      'an emptied hooks block must be removed, not left as {}');
  });

  it('reports not-wired for settings that have never seen it', () => {
    assert.equal(installer.apply({}, '/repo', 'install').wiredBefore, false);
  });

  it('the guard script itself is TRACKED, not gitignored', () => {
    // Found the hard way: the guard was first written to `.claude/hooks/`, which
    // `.gitignore` excludes fail-closed (`.claude/*`, one deliberate exception).
    // It existed, ran, and passed every test — and would have been committed
    // nowhere, so a clone or a fresh worktree would carry an installer pointing
    // at a script that does not exist. `fs.existsSync` cannot see this; only git
    // can.
    for (const rel of [installer.GUARD_REL, path.join('scripts', 'install-primary-guard.js')]) {
      assert.doesNotThrow(
        () => execFileSync('git', ['ls-files', '--error-unmatch', '--', rel],
          { cwd: REPO_ROOT, stdio: 'ignore' }),
        `${rel} must be tracked — an ignored guard ships to nobody`);
    }
  });
});

describe('#798 — the wiring survives TangleClaw\'s own hook reconciliation', () => {
  it('is preserved as a foreign entry by _mergeBaselineHooks', () => {
    // TangleClaw rewrites the project's hooks block on every launch, create,
    // attach, PATCH and boot-sync. If it dropped this entry the guard would
    // silently disappear the next time the operator opened a session — the
    // exact failure mode of a control that looks like it did something.
    const wired = installer.apply({}, '/repo', 'install').settings;
    const baseline = {
      SessionStart: [{
        matcher: 'startup',
        hooks: [{ type: 'command', command: '"/x/data/hooks/sessionstart-prime-claude.sh"' }]
      }]
    };
    const merged = engines._mergeBaselineHooks(wired.hooks, baseline);
    assert.equal(merged.hooks.PreToolUse.filter((e) => installer.isGuardEntry(e)).length, 2);
    assert.equal(merged.preservedForeign, 2);
  });
});
