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
const { execFileSync, spawnSync, spawn } = require('node:child_process');

const { initRepo } = require('./_temp-repo');
const engines = require('../lib/engines');
const installer = require('../scripts/install-primary-guard');

const REPO_ROOT = path.join(__dirname, '..');
// Taken from the installer rather than restated: the two disagreeing would wire
// a hook at one path and test a script at another, and both halves would pass.
const GUARD_REL = installer.GUARD_REL;

/**
 * Files the guard and its installer need at runtime, copied into each fixture repo.
 *
 * Hand-enumerated, so it is a set rather than a family: adding a `require` to
 * the installer without adding it here makes every case in this block fail with
 * an EMPTY output rather than a named missing module, because the script dies
 * before it prints. If that happens again, derive this list from the installer's
 * own requires instead of extending it once more.
 */
const GUARD_SOURCES = [
  GUARD_REL,
  path.join('scripts', 'install-primary-guard.js'),
  path.join('lib', 'checkout-layout.js'),
  path.join('lib', 'project-paths.js'),
  path.join('lib', 'tangleclaw-home.js'),
  path.join('lib', 'shell-word.js')
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

/**
 * Run the fixture's own `install-primary-guard.js --invoke` directly — the
 * STABLE OUTER RUNNER itself (#1400), bypassing the shell `|| true` wrapper
 * so a test isolates the runner's own behavior from shell quoting.
 *
 * @param {object} fx - Fixture from `makeFixture()`.
 * @param {object} toolInput - Payload `tool_input`.
 * @param {object} [env] - Extra environment for the `--invoke` process itself.
 * @param {string} [tool] - Tool name; default 'Write'.
 * @returns {{status:number, stdout:string, stderr:string}}
 */
function invokeCli(fx, toolInput, env, tool, rawStdin) {
  const payload = rawStdin !== undefined ? rawStdin
    : JSON.stringify({ tool_name: tool || 'Write', tool_input: toolInput, cwd: fx.primary });
  const res = spawnSync(process.execPath,
    [path.join(fx.primary, 'scripts', 'install-primary-guard.js'), '--invoke'],
    {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: fx.primary, TANGLECLAW_ALLOW_PRIMARY_WRITE: '', ...(env || {}) }
    });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Run `install-primary-guard.js --invoke` ASYNCHRONOUSLY (not `spawnSync`),
 * so two calls can genuinely overlap — the only way to exercise the lock
 * `updateStatus` takes around a real read-modify-write race (#1400 Round 2
 * finding 2).
 *
 * @param {object} fx - Fixture from `makeFixture()`.
 * @param {object} toolInput - Payload `tool_input`.
 * @param {object} [env] - Extra environment.
 * @returns {Promise<{status:number, stdout:string, stderr:string}>}
 */
function invokeCliAsync(fx, toolInput, env) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: toolInput, cwd: fx.primary });
    const child = spawn(process.execPath,
      [path.join(fx.primary, 'scripts', 'install-primary-guard.js'), '--invoke'],
      {
        env: { ...process.env, CLAUDE_PROJECT_DIR: fx.primary, TANGLECLAW_ALLOW_PRIMARY_WRITE: '', ...(env || {}) }
      });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(payload);
  });
}

/**
 * Seed `engineInvocations`/`lastEngineHeartbeatAt` with ONE genuine-looking
 * engine invocation — the only thing `selfTest` will accept as proof the
 * guard is on the live route (#1400 Round 4 finding 1 / AC8). A real,
 * on-disk `.jsonl` transcript file whose basename matches `session_id` is
 * required by `looksLikeEngineEnvelope` itself, not just a plausible field
 * name — so this creates one for real, then cleans it up.
 *
 * @param {object} fx - Fixture from `makeFixture()`.
 * @param {object} [toolInput] - Payload `tool_input`; defaults to an ordinary allow.
 * @returns {{status:number, stdout:string, stderr:string}}
 */
function seedGenuineEngineHeartbeat(fx, toolInput) {
  const sessionId = `self-test-seed-${Math.random().toString(36).slice(2, 10)}`;
  const transcriptPath = path.join(os.tmpdir(), `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, '{}\n');
  try {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: sessionId, transcript_path: transcriptPath,
      tool_name: 'Write', tool_input: toolInput || { file_path: path.join(fx.primary, 'lib', 'x.js') },
      cwd: fx.primary
    });
    return invokeCli(fx, null, {}, null, payload);
  } finally {
    fs.rmSync(transcriptPath, { force: true });
  }
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

  it('allows a git command naming its OWN worktree by absolute path', () => {
    // Every worktree root is lexically prefixed by the primary
    // (`<primary>/.claude/worktrees/<name>`), so answering "does this touch the
    // primary" by substring-matching the command text refused a worktree's own
    // commands — telling the actor to go run it where it already was. Absolute
    // paths are the normal form for a dispatched actor, whose cwd resets between
    // Bash calls, so this fired on ordinary swarm work. The test above cannot
    // see it: its command carries no absolute path at all.
    for (const command of [
      `git -C ${fx.worktree} checkout -b feat/x`,
      `git -C ${fx.worktree} merge main`,
      `cd ${fx.worktree} && git rebase main`
    ]) {
      const r = bash(command, fx.worktree, fx.primary);
      assert.equal(r.decision, null, `${command} must not be refused; got ${r.stdout}`);
    }
  });

  it('refuses a `cd` to the primary written with a tilde', () => {
    // `cd ~/Documents/Projects/<checkout> && git checkout main` is the form an
    // operator types, and it never contains the RESOLVED primary path — so the
    // substring test this replaced walked straight past the very case it existed
    // for. `HOME` is set for the child rather than skipping when the fixture is
    // not under the real home: a test that skips on this machine is not a test.
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.worktree, cwd: fx.worktree, tool: 'Bash',
      toolInput: { command: `cd ~/${path.basename(fx.primary)} && git checkout main` },
      env: { HOME: path.dirname(fx.primary) }
    });
    assert.equal(r.decision, 'deny');
  });

  it('treats a NEWLINE as a command boundary', () => {
    // The dangerous direction, and the one a hand-picked separator set missed:
    // with `\n` absent the whole thing is one segment, so `cd` moved the
    // directory and the `git checkout` behind it was never inspected at all —
    // a straight bypass of the arm.
    const r = bash(`cd ${fx.primary}\ngit checkout main`, fx.worktree, fx.worktree);
    assert.equal(r.decision, 'deny');
  });

  it('newline separates two GIT commands, with no cd involved', () => {
    // Isolates the separator set. The test above cannot: with `\n` removed the
    // whole string is one segment, and the `cd` loop then finds `git` anyway —
    // the two fixes are deliberate belt-and-braces for one bypass, so each needs
    // a case the other cannot cover. Here there is no `cd` to fall back on: with
    // `\n` absent, the segment's subcommand is `log` and nothing is refused.
    const r = bash('git log --oneline\ngit checkout main', fx.worktree, fx.primary);
    assert.equal(r.decision, 'deny');
  });

  it('a cd does not end its own segment, whatever separated them', () => {
    // Isolates the other half. No shell operator here at all — this is the
    // property that a separator the pattern does NOT know about cannot hide a
    // git command behind a cd that has already moved the tree.
    const r = bash(`cd ${fx.primary} git checkout main`, fx.worktree, fx.worktree);
    assert.equal(r.decision, 'deny');
  });

  it('treats the other control operators as boundaries too', () => {
    for (const sep of ['\r\n', ' & ', '; ', ' && ']) {
      const r = bash(`cd ${fx.primary}${sep}git checkout main`, fx.worktree, fx.worktree);
      assert.equal(r.decision, 'deny', `separator ${JSON.stringify(sep)} was not honoured`);
    }
  });

  it('RESTORES the directory when a subshell closes', () => {
    // `)` was consumed as a boundary without restoring, so the trailing checkout
    // inherited the subshell's `cd` and was refused — telling the actor to run it
    // in the worktree they were already in. Fail-CLOSED, the direction this
    // guard may not fail in.
    const r = bash(
      `(cd ${fx.primary} && git log) && git checkout -b feat/y`, fx.worktree, fx.worktree);
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('still refuses when the subshell itself moves the tree', () => {
    const r = bash(`(cd ${fx.primary} && git checkout main)`, fx.worktree, fx.worktree);
    assert.equal(r.decision, 'deny');
  });

  it('an unresolvable cd yields no target rather than a guessed one', () => {
    // `cd -` and `cd $VAR` name a directory this cannot compute. Treating them
    // as "no change" would attribute the next git command to the wrong tree —
    // in either direction — so they resolve to unknown, and unknown never
    // refuses.
    for (const command of ['cd - && git checkout main', 'cd "$SOMEWHERE" && git checkout main']) {
      const r = bash(command, fx.worktree, fx.primary);
      assert.equal(r.decision, null, `${command} must not be refused; got ${r.stdout}`);
      // "Did not refuse" is not enough: without the unknown-directory guard the
      // path resolver THROWS on it, the outer catch fails open, and this reads
      // green for the wrong reason. The clean fall-through is what is asserted.
      assert.doesNotMatch(r.stderr, /internal error/,
        `${command} fell through by throwing rather than by deciding`);
    }
  });

  it('sees through a subshell', () => {
    // `(cd /p && git checkout main)` tokenized its first segment as `(cd`, which
    // is not the token `cd`, so the directory never moved and the command
    // resolved against the tool cwd. Fail-open — the permitted direction — but a
    // real escape, and parentheses are segment separators like `&&` and `;`.
    const r = bash(`(cd ${fx.primary} && git checkout main)`, fx.worktree, fx.worktree);
    assert.equal(r.decision, 'deny');
  });

  it('does not let a parenthesis inside a commit message refuse the commit', () => {
    const r = bash('git commit -m "fix (checkout) path"', fx.worktree, fx.primary);
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('honours the LAST cd, not the tool cwd, when the command moves first', () => {
    const r = bash(`cd ${fx.worktree} && git checkout main`, fx.worktree, fx.primary);
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

  it('never refuses a commit whose MESSAGE contains a moving verb', () => {
    // The verb was matched anywhere in the string, so an ordinary commit message
    // made `git commit` refusable — with a refusal asserting something false.
    // The test above cannot catch it: "wrap" contains no verb word, so it stays
    // green straight through the defect. The verb is now recognised only in
    // git's subcommand position.
    for (const command of [
      'git commit -m "fix the checkout path"',
      'git commit -m "merge main into the branch"',
      'git log --grep "reset"',
      'git commit -am "switch to the new reader"'
    ]) {
      const r = bash(command, fx.worktree, fx.primary);
      assert.equal(r.decision, null, `${command} must not be refused; got ${r.stdout}`);
    }
  });

  it('still refuses a moving verb that IS the subcommand, after git options', () => {
    const r = bash('git --no-pager -c core.pager=cat checkout main', fx.worktree, fx.primary);
    assert.equal(r.decision, 'deny');
  });

  it('sees a moving verb in the second of two chained commands', () => {
    const r = bash('git add -A && git reset --hard origin/main', fx.worktree, fx.primary);
    assert.equal(r.decision, 'deny');
  });

  it('does not read a non-git command mentioning a moving verb as one', () => {
    const r = bash('grep -rn "checkout" .', fx.worktree, fx.primary);
    assert.equal(r.decision, null, `expected no decision, got ${r.stdout}`);
  });

  it('recognises an absolute git invocation', () => {
    // `/usr/bin/git checkout` is the same command. Requiring whitespace before
    // the token let a fully-qualified path walk straight past the guard.
    const r = bash('/usr/bin/git checkout main', fx.worktree, fx.primary);
    assert.equal(r.decision, 'deny');
  });

  it('still does not match a word merely ending in "git"', () => {
    const r = bash('mygit checkout main', fx.worktree, fx.primary);
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

  it('SAYS which route disarmed it, rather than looking like "no rule matched"', () => {
    // The one path that disarms the guard was the one path that emitted nothing,
    // so a forgotten sentinel was byte-identical to not-applicable and whoever
    // debugged "why did that write land in the primary" reached "the guard is
    // broken" first.
    const byEnv = runGuard({ ...denied(), env: { TANGLECLAW_ALLOW_PRIMARY_WRITE: '1' } });
    assert.match(byEnv.stderr, /standing down.*TANGLECLAW_ALLOW_PRIMARY_WRITE/);

    const sentinel = path.join(fx.primary, '.prawduct', '.allow-primary-write');
    fs.writeFileSync(sentinel, '');
    try {
      const bySentinel = runGuard(denied());
      assert.match(bySentinel.stderr, /standing down.*allow-primary-write/);
      assert.ok(bySentinel.stderr.includes(sentinel),
        'name the file to delete, or the note cannot be acted on');
    } finally {
      fs.rmSync(sentinel);
    }
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

  it('falls open for a session belonging to a DIFFERENT repository', () => {
    // The wiring is machine-local, so nothing structurally stops this guard
    // being invoked for another project's session — where it would apply THIS
    // repo's public/** policy to a tree nobody serves.
    const other = makeFixture();
    try {
      const r = runGuard({
        primary: fx.primary,          // this guard
        sessionRoot: other.primary,   // someone else's checkout
        cwd: other.primary,
        toolInput: { file_path: path.join(other.primary, 'public', 'sw.js') }
      });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /belongs to/);
    } finally {
      other.cleanup();
    }
  });

  it('emits the WHOLE decision, not a truncated one', () => {
    // Writes to a pipe are asynchronous and `process.exit` discards what has not
    // flushed — a truncated decision parses as nothing and silently permits the
    // write it just refused. Asserting the closing sentence proves the tail
    // arrived, which asserting `deny` alone does not.
    const r = runGuard(denied());
    assert.equal(r.decision, 'deny');
    assert.ok(r.reason.endsWith('delete it after.'),
      `decision looks truncated: ...${r.reason.slice(-60)}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  });

  it('says so when git cannot answer whether a file is tracked, instead of assuming untracked', () => {
    // `git ls-files --error-unmatch` exits 1 for "not tracked" — an ANSWER.
    // Every other failure means the question was never answered, and folding
    // those into "untracked" disarms P1 while everything still looks healthy:
    // `--self-test` probes P2, so it reports PASS with P1 dead. git is removed
    // from PATH rather than the repo being broken, so the test names the
    // condition it means.
    const r = runGuard({
      primary: fx.primary, sessionRoot: fx.worktree, cwd: fx.primary,
      toolInput: { file_path: path.join(fx.primary, 'lib', 'x.js') },
      env: { PATH: '/nonexistent' }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'an unestablished read must not refuse');
    assert.match(r.stderr, /could not say whether .* is tracked/);
  });

  it('falls open when the worktree list cannot be established', () => {
    // Not the same as "no worktrees". With an unknown subtraction list every
    // path inside every nested worktree reads as the primary, so treating it as
    // empty makes a fail-open guard refuse everything.
    const records = path.join(fx.primary, '.git', 'worktrees');
    const saved = `${records}.saved`;
    fs.renameSync(records, saved);
    fs.writeFileSync(records, 'not a directory\n');
    try {
      const r = runGuard(denied());
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', 'an unknown worktree list must not produce a refusal');
      assert.match(r.stderr, /could not read the worktree records/);
    } finally {
      fs.rmSync(records);
      fs.renameSync(saved, records);
    }
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

  it('falls back to a shell-only sentinel write, never a bare `|| true`, so the guard can never fail a hook', () => {
    // A non-zero hook exit is fed back as a synthetic user message and starts a
    // new turn — the loop this guard exists downstream of. The `||` fallback is
    // belt-and-braces alongside `--invoke`'s own exit-0 guarantee (#1400),
    // rather than the guard's only protection, but it still has to be there
    // for the one failure mode `--invoke` cannot see itself: `node` missing
    // entirely, or this very file failing to parse. #1400 Round 3 makes that
    // branch WRITE a sentinel (pure shell — no `node`) rather than stay
    // silent, and still end in `true` so the fallback itself can never
    // produce a non-zero hook exit either.
    const cmd = installer.guardCommand('/repo');
    assert.match(cmd, /\|\| \{.*true; \}$/s);
    assert.match(cmd, /printf/);
    assert.ok(cmd.includes(installer.INSTALLER_REL));
    assert.ok(cmd.includes('--invoke'));
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

  it('refuses a PreToolUse it cannot model instead of overwriting it', () => {
    // `_mergeBaselineHooks` preserves unmodelled shapes verbatim; an installer
    // that silently replaced them would make the two disagree about one file,
    // and the operator would lose whatever they wrote there.
    assert.throws(
      () => installer.apply({ hooks: { PreToolUse: { matcher: 'Bash' } } }, '/repo', 'install'),
      /not an array/);
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

describe('#798 installer — the CLI, against a real settings file', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  const SETTINGS = () => path.join(fx.primary, '.claude', 'settings.local.json');

  /**
   * Run the fixture's own copy of the installer.
   *
   * The CLI resolves its primary from `__dirname`, so only the copy inside the
   * fixture can be driven against the fixture. `apply()` alone leaves main(),
   * readSettings(), writeSettings() and every exit code unexercised — including
   * `--check`'s exit 1, which is a Done-when deliverable.
   *
   * @param {...string} args - CLI arguments.
   * @returns {{status:number, stdout:string, stderr:string}}
   */
  const cli = (...args) => {
    const r = spawnSync(process.execPath,
      [path.join(fx.primary, 'scripts', 'install-primary-guard.js'), ...args],
      { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('--check exits 1 and says so before anything is wired', () => {
    const r = cli('--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /NOT wired/);
  });

  it('installs, is idempotent, and writes a settings file that parses', () => {
    const first = cli();
    assert.equal(first.status, 0);
    assert.match(first.stdout, /wired into/);
    const parsed = JSON.parse(fs.readFileSync(SETTINGS(), 'utf8'));
    assert.equal(parsed.hooks.PreToolUse.length, 2);

    const second = cli();
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already wired/);
  });

  it('--check reports the command actually PRESENT, not the one it would write', () => {
    // The two are IDENTICAL in the normal case, so comparing against the wired
    // command as-installed cannot tell the readings apart — a version printing
    // `guardCommand(primary)` passes such a test unchanged. The entry is
    // therefore hand-edited to a still-valid but DIFFERENT command first, which
    // is also the real-world shape: an operator or an older installer wrote it.
    const settings = JSON.parse(fs.readFileSync(SETTINGS(), 'utf8'));
    // Not a SUPERSTRING of the installer's command either: `/usr/bin/env node
    // "<path>" || true` contains `node "<path>" || true` verbatim, so the
    // negative assertion below could not tell the two readings apart — the same
    // defect this test exists to catch, one level down. Differing in the tail
    // makes neither string a substring of the other.
    const distinct = `node "${path.join(fx.primary, installer.GUARD_REL)}" || exit 0`;
    assert.ok(!distinct.includes(installer.guardCommand(fx.primary))
      && !installer.guardCommand(fx.primary).includes(distinct),
    'the fixture must be distinguishable from the installer output in both directions');
    settings.hooks.PreToolUse[0].hooks[0].command = distinct;
    fs.writeFileSync(SETTINGS(), JSON.stringify(settings, null, 2));
    try {
      const r = cli('--check');
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes(distinct),
        `--check printed ${r.stdout.trim()}, not the command in the file`);
      assert.ok(!r.stdout.includes(installer.guardCommand(fx.primary)),
        '--check echoed the command it WOULD write, which answers a different question');
    } finally {
      fs.writeFileSync(SETTINGS(), JSON.stringify(
        installer.apply({}, fx.primary, 'install').settings, null, 2));
    }
  });

  it('--self-test drives the WIRED command and sees a real refusal', () => {
    // #1400 Round 4 finding 1 / AC8: self-test now requires an EXISTING
    // genuine engine heartbeat before it will run its own probes at all —
    // seed one first. (This also carries forward for every later test in
    // this shared fixture, since engineInvocations never resets.)
    seedGenuineEngineHeartbeat(fx);
    const r = cli('--self-test');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /self-test: PASS/);
  });

  it('--check calls a stale pin STALE, and --self-test fails on it', () => {
    // `isGuardEntry` matches the script BASENAME, so an entry pinned at a path
    // that no longer exists still reads as "wired" — and the wired command ends
    // in `|| true`, so it fails silently. This repo already shipped the mirror
    // image (#755: a readback keyed on the SCRIPT, blind to the registration
    // being gone); a readback keyed on the registration must not be blind to the
    // script being gone.
    const settings = JSON.parse(fs.readFileSync(SETTINGS(), 'utf8'));
    settings.hooks.PreToolUse[0].hooks[0].command =
      `node "${path.join(fx.primary, 'scripts', 'gone', 'guard-primary-checkout.js')}" || true`;
    fs.writeFileSync(SETTINGS(), JSON.stringify(settings, null, 2));

    const checked = cli('--check');
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /STALE/);

    fs.writeFileSync(SETTINGS(), JSON.stringify(
      installer.apply({}, fx.primary, 'install').settings, null, 2));
  });

  it('--self-test FAILS when a sentinel has silently disarmed the guard', () => {
    // The case `--check` structurally cannot see: entry listed, script present,
    // and the guard refusing nothing.
    const sentinel = path.join(fx.primary, '.prawduct', '.allow-primary-write');
    fs.writeFileSync(sentinel, '');
    try {
      const r = cli('--self-test');
      assert.equal(r.status, 1);
      assert.match(r.stdout, /self-test: FAIL/);
      assert.match(r.stdout, /NO decision/);
    } finally {
      fs.rmSync(sentinel);
    }
  });

  it('--remove unwires and leaves the file parseable', () => {
    assert.equal(cli('--remove').status, 0);
    assert.equal(JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')).hooks, undefined);
    assert.equal(cli('--check').status, 1);
    assert.match(cli('--remove').stdout, /already absent/);
  });

  it('refuses an unparseable settings file rather than clobbering it', () => {
    // The operator's permissions block lives in this file. Replacing it to
    // install a guard would be a worse outcome than not installing one.
    const saved = fs.readFileSync(SETTINGS(), 'utf8');
    fs.writeFileSync(SETTINGS(), '{ not json');
    try {
      const r = cli();
      assert.notEqual(r.status, 0);
      assert.equal(fs.readFileSync(SETTINGS(), 'utf8'), '{ not json',
        'the malformed file must be left exactly as it was');
      // A bare SyntaxError naming no file is not an answer a remote operator can
      // act on, and this CLI is exactly what the arming runbook tells them to run.
      assert.match(r.stderr, /install-primary-guard:/);
      assert.ok(r.stderr.includes(SETTINGS()), 'the refusal must name the file to fix');
      assert.doesNotMatch(r.stderr, /at Object\.<anonymous>|node:internal/,
        'a raw stack trace is not an operator-facing message');
    } finally {
      fs.writeFileSync(SETTINGS(), saved);
    }
  });

  it('refuses to wire a hook to a guard script that is not there', () => {
    const guard = path.join(fx.primary, installer.GUARD_REL);
    const saved = fs.readFileSync(guard, 'utf8');
    fs.rmSync(guard);
    try {
      const r = cli();
      assert.equal(r.status, 1);
      assert.match(r.stderr, /guard script missing/);
    } finally {
      fs.writeFileSync(guard, saved);
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

describe('#1400 — the stable outer runner (`--invoke`) and liveness telemetry', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  const statusPath = () => installer.statusFilePath(fx.primary);
  const readStatusNow = () => installer.readStatus(statusPath());

  it('--invoke forwards a genuine refusal and records it as genuine, not self-test', () => {
    const before_ = readStatusNow();
    const r = invokeCli(fx, { file_path: path.join(fx.primary, 'public', 'sw.js') });
    assert.equal(r.status, 0, 'the runner must exit 0 even for a refusal');
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');

    const after_ = readStatusNow();
    assert.equal(after_.counts.total, before_.counts.total + 1);
    assert.equal(after_.counts.refusal, before_.counts.refusal + 1);
    assert.equal(after_.lastOutcome, 'refusal');
    assert.equal(after_.lastHook, 'Write');
    assert.equal(after_.selfTest.counts.total, before_.selfTest.counts.total,
      'a genuine invocation must not inflate the self-test bucket');
  });

  it('--invoke forwards a genuine allow (no decision) and records it', () => {
    const before_ = readStatusNow();
    const r = invokeCli(fx, { file_path: path.join(fx.primary, 'lib', 'x.js') });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    const after_ = readStatusNow();
    assert.equal(after_.counts.allow, before_.counts.allow + 1);
    assert.equal(after_.lastOutcome, 'allow');
  });

  it('a broken inner script is recorded as `error`, not silently as allow, and the decision stays empty', () => {
    // The case #1400 requirement 2c names explicitly: a syntax/runtime
    // failure in the INNER guard must not read as a clean fall-through.
    // Corrupting a COPY (the fixture's) rather than the real repo's script —
    // this is exactly why `selfTest` itself does not probe this case against
    // the real primary.
    const guardPath = path.join(fx.primary, installer.GUARD_REL);
    const saved = fs.readFileSync(guardPath, 'utf8');
    fs.writeFileSync(guardPath, 'this is not valid node syntax {{{');
    try {
      const before_ = readStatusNow();
      const r = invokeCli(fx, { file_path: path.join(fx.primary, 'public', 'sw.js') });
      assert.equal(r.status, 0, 'the outer runner must still exit 0 when the inner script crashes');
      assert.equal(r.stdout, '', 'a crashed inner script must produce no decision — fail open');
      const after_ = readStatusNow();
      assert.equal(after_.counts.error, before_.counts.error + 1);
      assert.equal(after_.lastOutcome, 'error');
      assert.ok(after_.lastError, 'a crash must leave a reason code');
      assert.ok(!after_.lastError.includes(fx.primary),
        'telemetry must never contain the raw script path (#1400 Security)');
      assert.ok(!after_.lastError.includes('node:internal') && after_.lastError.length < 40,
        'the recorded code must be bounded, not a raw stack trace');
    } finally {
      fs.writeFileSync(guardPath, saved);
    }
  });

  it('a telemetry write failure does not alter the decision', () => {
    const file = statusPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(file, { recursive: true, force: true }); // earlier tests in this block already wrote a real status file here
    // A directory sits where the status file belongs: every write to it
    // fails at the final rename, without touching the decision path at all.
    fs.mkdirSync(file);
    try {
      const r = invokeCli(fx, { file_path: path.join(fx.primary, 'public', 'sw.js') });
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny',
        'the refusal must still reach the harness even though telemetry could not be written');
      assert.match(r.stderr, /telemetry write failed/);
    } finally {
      fs.rmSync(file, { recursive: true, force: true });
    }
  });

  it('--self-test advances the self-test counter, not the genuine one, and stamps success', () => {
    fs.writeFileSync(path.join(fx.primary, '.claude', 'settings.local.json'),
      JSON.stringify(installer.apply({}, fx.primary, 'install').settings, null, 2));
    seedGenuineEngineHeartbeat(fx); // #1400 Round 4 finding 1 / AC8: self-test now requires this first
    const before_ = readStatusNow();
    const r = spawnSync(process.execPath,
      [path.join(fx.primary, 'scripts', 'install-primary-guard.js'), '--self-test'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /self-test: PASS/);

    const after_ = readStatusNow();
    assert.equal(after_.selfTest.counts.total, before_.selfTest.counts.total + 2,
      'self-test drives two probes — a refusal case and an allow case (#1400 Round 4: the Round 3 '
      + 'engine-shaped probe was removed — self-test must never manufacture its own engine proof)');
    assert.equal(after_.counts.total, before_.counts.total,
      'self-test traffic must never be counted as genuine traffic');
    assert.equal(after_.engineInvocations, before_.engineInvocations,
      'self-test traffic must never inflate engineInvocations');
    assert.ok(after_.selfTest.lastSuccessfulAt, 'a passing self-test must stamp its own success');
  });

  it('--status/--json reports the shape #1400 asks for', () => {
    const r = spawnSync(process.execPath,
      [path.join(fx.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
      { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok('counts' in parsed && 'total' in parsed.counts);
    assert.ok('lastInvokedAt' in parsed);
    assert.ok('selfTest' in parsed);
    assert.ok('staleWarning' in parsed);
    assert.ok('crashSinceLastSelfTest' in parsed);
  });

  it('--status flags a crash recorded AFTER the last successful self-test as actionable', () => {
    // A fresh fixture, so the crash/self-test ORDER is unambiguous.
    const fresh = makeFixture();
    try {
      fs.writeFileSync(path.join(fresh.primary, '.claude', 'settings.local.json'),
        JSON.stringify(installer.apply({}, fresh.primary, 'install').settings, null, 2));
      seedGenuineEngineHeartbeat(fresh); // #1400 Round 4 finding 1 / AC8: self-test now requires this first
      const selfTestFirst = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--self-test'],
        { encoding: 'utf8' });
      assert.equal(selfTestFirst.status, 0, selfTestFirst.stdout + selfTestFirst.stderr);

      const guardPath = path.join(fresh.primary, installer.GUARD_REL);
      const saved = fs.readFileSync(guardPath, 'utf8');
      fs.writeFileSync(guardPath, 'not valid node {{{');
      try {
        const crashed = invokeCli(fresh, { file_path: path.join(fresh.primary, 'public', 'sw.js') });
        assert.equal(crashed.status, 0);
      } finally {
        fs.writeFileSync(guardPath, saved);
      }

      const statusRun = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8' });
      assert.equal(statusRun.status, 1, 'an actionable status must exit non-zero');
      const parsed = JSON.parse(statusRun.stdout);
      assert.equal(parsed.crashSinceLastSelfTest, true);
    } finally {
      fresh.cleanup();
    }
  });

  it('warns when commits advanced since the last check with no genuine invocation, '
    + 'and stays quiet when neither advanced', () => {
    const fresh = makeFixture();
    try {
      const git = (...args) => execFileSync('git', args, { cwd: fresh.primary, stdio: 'pipe' });
      const first = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8' });
      assert.equal(JSON.parse(first.stdout).staleWarning, false, 'first check has no baseline yet');

      // Neither signal advances: a check right after must stay quiet — the
      // "intentionally idle install" case #1400 requirement 4 names.
      const quiet = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8' });
      assert.equal(JSON.parse(quiet.stdout).staleWarning, false,
        'an intentionally idle install must remain quiet');

      // Commits advance; no guard invocation happens in between.
      fs.writeFileSync(path.join(fresh.primary, 'lib', 'x.js'), '// changed\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'unrelated activity, no guard invocation');

      const warned = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8' });
      assert.equal(warned.status, 1);
      assert.equal(JSON.parse(warned.stdout).staleWarning, true);
    } finally {
      fresh.cleanup();
    }
  });
});

describe('#1400 Round 2 — pre-invocation heartbeat, locking, bounded telemetry, live-engine proof', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  const statusPath = () => installer.statusFilePath(fx.primary);
  const readStatusNow = () => installer.readStatus(statusPath());

  it('lastHook is bounded/sanitized, never the raw tool_name verbatim', () => {
    const hostile = JSON.stringify({
      tool_name: '../../etc/passwd; rm -rf /',
      tool_input: { file_path: path.join(fx.primary, 'lib', 'x.js') },
      cwd: fx.primary
    });
    const r = invokeCli(fx, null, {}, null, hostile);
    assert.equal(r.status, 0);
    const status = readStatusNow();
    assert.equal(status.lastHook, 'unknown',
      'a tool_name outside the bounded pattern must never reach telemetry verbatim');
  });

  it('a hung inner script is killed and recorded as `error`, not left to hang forever', () => {
    const guardPath = path.join(fx.primary, installer.GUARD_REL);
    const saved = fs.readFileSync(guardPath, 'utf8');
    // Never reads stdin, never exits on its own — exactly the shape a
    // timeout has to catch, not a crash `runInner`'s try/catch would see
    // immediately on its own.
    fs.writeFileSync(guardPath, 'setInterval(() => {}, 1000);\n');
    try {
      const before_ = readStatusNow();
      const start = Date.now();
      const r = invokeCli(fx, { file_path: path.join(fx.primary, 'public', 'sw.js') }, {
        [installer.INNER_TIMEOUT_ENV]: '300'
      });
      const elapsed = Date.now() - start;
      assert.equal(r.status, 0, 'the outer runner must still exit 0 when its child is killed');
      assert.equal(r.stdout, '');
      assert.ok(elapsed < 5000, `expected the 300ms timeout to bound this, took ${elapsed}ms`);
      const after_ = readStatusNow();
      assert.equal(after_.counts.error, before_.counts.error + 1);
      assert.ok(after_.lastError, 'a killed child must leave a reason code');
    } finally {
      fs.writeFileSync(guardPath, saved);
    }
  });

  it('an abandoned pending entry is reclaimed as `unclosed-entry` on the next status update', () => {
    // Simulates the OUTER `--invoke` process itself being killed between
    // `recordInvocationStart` and `recordInvocation` — the one case nothing
    // in THIS process's own lifetime can close (#1400 Round 2 finding 1).
    const file = statusPath();
    const id = installer.recordInvocationStart(fx.primary, 'Bash', false);
    assert.ok(id, 'recordInvocationStart must return an id to test against');
    const before_ = installer.readStatus(file);
    assert.ok(id in before_.pending, 'the entry must exist while "in flight"');

    const r = spawnSync(process.execPath,
      [path.join(fx.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
      { encoding: 'utf8', env: { ...process.env, [installer.PENDING_STALE_ENV]: '1' } });
    // `--status`'s exit code is not asserted here: this shared fixture may
    // already carry an unrelated crash/staleness flag from an earlier test
    // in this block, and that is not what this test is about.
    const after_ = JSON.parse(r.stdout);
    assert.equal(after_.lastOutcome, 'error');
    assert.equal(after_.lastError, 'unclosed-entry');
    assert.ok(!(id in after_.pending), 'the reclaimed entry must be removed, not left to be reclaimed again');
  });

  it('two concurrent invocations do not lose an increment to each other', async () => {
    const before_ = readStatusNow();
    await Promise.all([
      invokeCliAsync(fx, { file_path: path.join(fx.primary, 'lib', 'x.js') }),
      invokeCliAsync(fx, { file_path: path.join(fx.primary, 'public', 'sw.js') })
    ]);
    const after_ = readStatusNow();
    assert.equal(after_.counts.total, before_.counts.total + 2,
      'both concurrent invocations must be counted — a lost update means the lock did not hold');
  });

  it('acquireLock breaks a stale lock rather than waiting out the full budget', () => {
    const file = statusPath();
    const lockPath = `${file}${installer.LOCK_SUFFIX}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(lockPath, '');
    const old = Date.now() / 1000 - 60; // 60s old — well past the staleness threshold
    fs.utimesSync(lockPath, old, old);
    const start = Date.now();
    const acquired = installer.acquireLock(file);
    try {
      assert.ok(acquired, 'a stale lock must be broken, not waited out');
      assert.ok(Date.now() - start < 1000, 'breaking a stale lock must be fast, not a full timeout wait');
    } finally {
      installer.releaseLock(acquired);
    }
  });

  it('liveEngineVerified stays false for a hand-built CLI call, true only for an engine-shaped payload', () => {
    const fresh = makeFixture();
    try {
      const before_ = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8' });
      assert.equal(JSON.parse(before_.stdout).liveEngineVerified, false);

      // An ordinary, hand-built payload — no hook_event_name/session_id/
      // transcript_path — must NOT count, even though it produces a real
      // decision and is not a self-test probe (#1400 Round 3 finding 2).
      invokeCli(fresh, { file_path: path.join(fresh.primary, 'public', 'sw.js') });
      const stillFalse = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8' });
      assert.equal(JSON.parse(stillFalse.stdout).liveEngineVerified, false,
        'a hand-built CLI call must not satisfy liveEngineVerified');
      assert.equal(JSON.parse(stillFalse.stdout).engineInvocations, 0);

      // A payload with the right FIELD NAMES but a transcript_path that
      // does not exist, or whose basename does not match session_id, must
      // still be rejected (#1400 Round 4 finding 1) — plausible field
      // names alone are not proof; the on-disk check is the point.
      const fakeTranscript = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'real-session', transcript_path: '/tmp/does-not-exist.jsonl',
        tool_name: 'Write', tool_input: { file_path: path.join(fresh.primary, 'public', 'sw.js') },
        cwd: fresh.primary
      });
      invokeCli(fresh, null, {}, null, fakeTranscript);
      const stillFakeRejected = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8' });
      assert.equal(JSON.parse(stillFakeRejected.stdout).liveEngineVerified, false,
        'a nonexistent transcript file must not satisfy the engine-envelope check');

      const r = seedGenuineEngineHeartbeat(fresh, { file_path: path.join(fresh.primary, 'public', 'sw.js') });
      assert.equal(r.status, 0);

      const after_ = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8' });
      const parsedAfter = JSON.parse(after_.stdout);
      assert.equal(parsedAfter.liveEngineVerified, true);
      assert.equal(parsedAfter.engineInvocations, 1);
      assert.ok(parsedAfter.lastEngineHeartbeatAt);
    } finally {
      fresh.cleanup();
    }
  });

  it('flags a competing exact-matcher PreToolUse entry in the shared settings.json as actionable', () => {
    const fresh = makeFixture();
    try {
      fs.writeFileSync(path.join(fresh.primary, '.claude', 'settings.json'), JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo unrelated' }] }] }
      }));
      const r = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8' });
      assert.equal(r.status, 1);
      const parsed = JSON.parse(r.stdout);
      assert.deepEqual(parsed.sharedSettingsHookConflicts, ['Bash']);
    } finally {
      fresh.cleanup();
    }
  });

  it('does not flag settings.json when it declares no PreToolUse hooks at all', () => {
    const r = spawnSync(process.execPath,
      [path.join(fx.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
      { encoding: 'utf8' });
    assert.equal(JSON.parse(r.stdout).sharedSettingsHookConflicts.length, 0);
  });

  it('checkNodeResolvable passes under the real node binary', () => {
    assert.equal(installer.checkNodeResolvable().ok, true);
  });
});

describe('#1400 Round 3 — outer-node sentinel, merged-settings AC8, lock-contention safety', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  const statusPath = () => installer.statusFilePath(fx.primary);
  const readStatusNow = () => installer.readStatus(statusPath());

  it('guardCommand\'s shell fallback writes a sentinel, pure shell, when the outer node invocation itself fails', () => {
    // No node on PATH at all — the ONE failure mode nothing JS-based can
    // observe from inside this file, which is exactly why the fallback has
    // to be pure shell (`printf`, no `node`) to catch it.
    const cmd = installer.guardCommand(fx.primary);
    const r = spawnSync('/bin/sh', ['-c', cmd], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    assert.equal(r.status, 0, 'the fallback itself must still end in `true` and exit 0');
    const sentinel = installer.outerFailureSentinelPath(fx.primary);
    assert.ok(fs.existsSync(sentinel), 'the shell fallback must have written the sentinel');
    fs.rmSync(sentinel);
  });

  it('a later real --invoke folds the sentinel into telemetry as OUTER_NODE_FAILED', () => {
    const sentinel = installer.outerFailureSentinelPath(fx.primary);
    fs.writeFileSync(sentinel, '{"code":"OUTER_NODE_FAILED"}\n');
    const before_ = readStatusNow();

    const r = invokeCli(fx, { file_path: path.join(fx.primary, 'lib', 'x.js') });
    assert.equal(r.status, 0);

    const after_ = readStatusNow();
    assert.ok(!fs.existsSync(sentinel), 'the sentinel must be consumed, not left to be folded again');
    assert.equal(after_.counts.error, before_.counts.error + 1,
      'folding the sentinel is itself one more error — on top of whatever THIS invocation decided');
    assert.equal(after_.lastError, 'OUTER_NODE_FAILED');
  });

  it('--status alone folds the sentinel even with no invocation since', () => {
    const sentinel = installer.outerFailureSentinelPath(fx.primary);
    fs.writeFileSync(sentinel, '{"code":"OUTER_NODE_FAILED"}\n');
    const before_ = readStatusNow();

    const r = spawnSync(process.execPath,
      [path.join(fx.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
      { encoding: 'utf8' });
    assert.equal(r.status, 1, 'a freshly-folded crash must be actionable');
    assert.ok(!fs.existsSync(sentinel));
    const after_ = JSON.parse(r.stdout);
    assert.equal(after_.counts.error, before_.counts.error + 1);
    assert.equal(after_.lastError, 'OUTER_NODE_FAILED');
  });

  it('disableAllHooks anywhere in the merged settings hierarchy fails --self-test', () => {
    const fresh = makeFixture();
    try {
      fs.writeFileSync(path.join(fresh.primary, '.claude', 'settings.local.json'),
        JSON.stringify(installer.apply({}, fresh.primary, 'install').settings, null, 2));
      // Set on the SHARED file, not the local one that is already confirmed
      // wired — settings.local.json alone could never reveal this.
      fs.writeFileSync(path.join(fresh.primary, '.claude', 'settings.json'),
        JSON.stringify({ disableAllHooks: true }));

      const r = spawnSync(process.execPath,
        [path.join(fresh.primary, 'scripts', 'install-primary-guard.js'), '--self-test'], { encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /self-test: FAIL/);
      assert.match(r.stdout, /disableAllHooks/);
    } finally {
      fresh.cleanup();
    }
  });

  it('a lock still held (not stale) causes the update to be SKIPPED, never an unlocked overwrite', () => {
    const file = statusPath();
    const lockPath = `${file}${installer.LOCK_SUFFIX}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(lockPath, ''); // fresh — NOT stale, so acquireLock must not break it
    try {
      const before_ = readStatusNow();
      const r = invokeCli(fx, { file_path: path.join(fx.primary, 'public', 'sw.js') }, {
        [installer.LOCK_MAX_WAIT_ENV]: '50'
      });
      assert.equal(r.status, 0, 'the decision must still be forwarded even when telemetry is skipped');
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(r.stderr, /telemetry update skipped/);

      const after_ = readStatusNow();
      assert.deepEqual(after_.counts, before_.counts,
        'a contended lock must leave counts untouched, not clobbered by an unlocked write');
    } finally {
      fs.rmSync(lockPath, { force: true });
    }

    // Normal operation resumes once the lock is released.
    const resumed = invokeCli(fx, { file_path: path.join(fx.primary, 'public', 'sw.js') });
    assert.equal(JSON.parse(resumed.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(readStatusNow().counts.refusal > 0, true);
  });
});

describe('#1400 Round 4 — AC8 fail-closed self-test, locked sentinel fold, --status under contention', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  const statusPath = () => installer.statusFilePath(fx.primary);
  const readStatusNow = () => installer.readStatus(statusPath());

  const cliSelfTest = (dir) => spawnSync(process.execPath,
    [path.join(dir, 'scripts', 'install-primary-guard.js'), '--self-test'], { encoding: 'utf8' });
  const cliStatusJson = (dir) => spawnSync(process.execPath,
    [path.join(dir, 'scripts', 'install-primary-guard.js'), '--status', '--json'], { encoding: 'utf8' });

  it('selfTest FAILS CLOSED on a freshly-installed guard before any real engine invocation — never skips', () => {
    const fresh = makeFixture();
    try {
      fs.writeFileSync(path.join(fresh.primary, '.claude', 'settings.local.json'),
        JSON.stringify(installer.apply({}, fresh.primary, 'install').settings, null, 2));
      // No seedGenuineEngineHeartbeat call — this is the whole point.
      const r = cliSelfTest(fresh.primary);
      assert.equal(r.status, 1, 'a check that cannot be made must be a failure, not a skip (#1400 AC8)');
      assert.match(r.stdout, /self-test: FAIL/);
      assert.match(r.stdout, /no genuine, engine-produced PreToolUse heartbeat/);
      // And it must not have run its own probes at all — no selfTest counter movement.
      const status = installer.readStatus(installer.statusFilePath(fresh.primary));
      assert.equal(status.selfTest.counts.total, 0);
    } finally {
      fresh.cleanup();
    }
  });

  it('selfTest never increments engineInvocations itself, confirmed directly by calling it', () => {
    const fresh = makeFixture();
    try {
      fs.writeFileSync(path.join(fresh.primary, '.claude', 'settings.local.json'),
        JSON.stringify(installer.apply({}, fresh.primary, 'install').settings, null, 2));
      seedGenuineEngineHeartbeat(fresh);
      const before_ = installer.readStatus(installer.statusFilePath(fresh.primary));
      const r = cliSelfTest(fresh.primary);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const after_ = installer.readStatus(installer.statusFilePath(fresh.primary));
      assert.equal(after_.engineInvocations, before_.engineInvocations,
        'a passing self-test must not move engineInvocations at all');
    } finally {
      fresh.cleanup();
    }
  });

  it('a lock held during a sentinel fold attempt preserves the sentinel, rather than losing it (#1400 Round 4 finding 2)', () => {
    const sentinel = installer.outerFailureSentinelPath(fx.primary);
    fs.writeFileSync(sentinel, '{"code":"OUTER_NODE_FAILED"}\n');
    const file = statusPath();
    const lockPath = `${file}${installer.LOCK_SUFFIX}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(lockPath, ''); // fresh, not stale
    try {
      const before_ = readStatusNow();
      const r = invokeCli(fx, { file_path: path.join(fx.primary, 'lib', 'x.js') }, {
        [installer.LOCK_MAX_WAIT_ENV]: '50'
      });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /telemetry update skipped/);
      // The whole point of Round 4 finding 2: the sentinel must SURVIVE a
      // contended lock, not be claimed-then-dropped by an unlink that ran
      // before the (now-skipped) write.
      assert.ok(fs.existsSync(sentinel), 'a contended lock must never destroy the still-unfolded sentinel');
      const after_ = readStatusNow();
      assert.deepEqual(after_.counts, before_.counts, 'nothing should have changed while the lock was held');
    } finally {
      fs.rmSync(lockPath, { force: true });
    }

    // Once the lock clears, the next update folds it correctly.
    const resumed = invokeCli(fx, { file_path: path.join(fx.primary, 'lib', 'x.js') });
    assert.equal(resumed.status, 0);
    assert.ok(!fs.existsSync(sentinel), 'the sentinel must be folded once the lock is free');
    assert.equal(readStatusNow().lastError, 'OUTER_NODE_FAILED');
  });

  it('--status answers with a real read, never crashes, when its own locked update is contended', () => {
    const file = statusPath();
    const lockPath = `${file}${installer.LOCK_SUFFIX}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(lockPath, '');
    try {
      const r = spawnSync(process.execPath,
        [path.join(fx.primary, 'scripts', 'install-primary-guard.js'), '--status', '--json'],
        { encoding: 'utf8', env: { ...process.env, [installer.LOCK_MAX_WAIT_ENV]: '50' } });
      assert.equal(r.status === 0 || r.status === 1, true, 'must answer with a clean exit code, never crash');
      assert.doesNotThrow(() => JSON.parse(r.stdout), 'must still print a parseable status, not a stack trace');
      assert.doesNotMatch(r.stderr, /TypeError|Cannot read properties of undefined/,
        'reportStatus must not dereference a field on undefined when the lock is contended');
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  it('guardCommand appends (not overwrites) on repeated outer-node failures, and both lines fold as two errors', () => {
    const cmd = installer.guardCommand(fx.primary);
    spawnSync('/bin/sh', ['-c', cmd], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    spawnSync('/bin/sh', ['-c', cmd], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    const sentinel = installer.outerFailureSentinelPath(fx.primary);
    const raw = fs.readFileSync(sentinel, 'utf8');
    assert.equal(raw.trim().split('\n').length, 2, 'two failures must append two lines, not overwrite to one');

    const before_ = readStatusNow();
    const r = invokeCli(fx, { file_path: path.join(fx.primary, 'lib', 'x.js') });
    assert.equal(r.status, 0);
    const after_ = readStatusNow();
    assert.equal(after_.counts.error, before_.counts.error + 2, 'both appended failures must fold as two errors');
    assert.ok(!fs.existsSync(sentinel));
  });
});
