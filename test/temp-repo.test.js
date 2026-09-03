'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { initRepo, cloneRepo } = require('./_temp-repo');

describe('test/_temp-repo — initRepo isolates the suite from the machine\'s git template', () => {
  let scratch;
  let gitconfigPath;
  let templateDir;

  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-temp-repo-'));
    // A global config that points init.templateDir at a template carrying a
    // hook — the exact shape TangleClaw installs on a developer machine. A
    // repository that inherits it gets the hook copied into .git/hooks/.
    templateDir = path.join(scratch, 'template');
    fs.mkdirSync(path.join(templateDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'hooks', 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    gitconfigPath = path.join(scratch, 'gitconfig');
    fs.writeFileSync(gitconfigPath, `[init]\n\ttemplateDir = ${templateDir}\n`);
  });

  after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * Environment with the sandboxed global config active, so neither the
   * machine's real config nor its real template is consulted.
   *
   * @returns {object} Environment for the git child
   */
  function sandboxEnv() {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfigPath };
    // GIT_TEMPLATE_DIR outranks init.templateDir — even when empty, which
    // means "no template" and would disable the very thing the control
    // proves. Drop it so the sandboxed config is what decides.
    delete env.GIT_TEMPLATE_DIR;
    return env;
  }

  it('the sandbox is real: a bare `git init` under it DOES copy the template hook', () => {
    // The control. Without this, the assertion below could pass because the
    // sandbox never reached git at all.
    const dir = fs.mkdtempSync(path.join(scratch, 'bare-'));
    execFileSync('git', ['init', '-q'], { cwd: dir, env: sandboxEnv(), stdio: 'pipe' });
    assert.ok(fs.existsSync(path.join(dir, '.git', 'hooks', 'commit-msg')),
      'control failed — the sandboxed template was not applied, so the test below proves nothing');
  });

  it('initRepo does NOT copy the template hook — the machine\'s template is never read (#831)', () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'isolated-'));
    initRepo(dir, [], { env: sandboxEnv() });
    assert.ok(fs.existsSync(path.join(dir, '.git')), 'a repository was initialised');
    assert.equal(fs.existsSync(path.join(dir, '.git', 'hooks', 'commit-msg')), false,
      'the template hook was copied — initRepo inherited the global template dir');
  });

  it('passes extra arguments through: -b names the initial branch, --bare makes a bare repo', () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'branch-'));
    initRepo(dir, ['-b', 'trunk']);
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    assert.equal(head, 'ref: refs/heads/trunk');

    const bare = fs.mkdtempSync(path.join(scratch, 'bare-'));
    initRepo(bare, ['--bare']);
    assert.ok(fs.existsSync(path.join(bare, 'HEAD')), 'bare repo has HEAD at its root');
    assert.equal(fs.existsSync(path.join(bare, '.git')), false);
  });

  it('a bare `git clone` under the sandbox DOES copy the template hook — clone is init', () => {
    // Control for the clone half, for the same reason as the init control.
    const src = fs.mkdtempSync(path.join(scratch, 'clone-src-'));
    initRepo(src, ['--bare']);
    const dest = path.join(scratch, 'clone-bare-dest');
    execFileSync('git', ['clone', '-q', src, dest], { env: sandboxEnv(), stdio: 'pipe' });
    assert.ok(fs.existsSync(path.join(dest, '.git', 'hooks', 'commit-msg')),
      'control failed — a bare clone did not apply the sandboxed template');
  });

  it('cloneRepo does NOT copy the template hook', () => {
    const src = fs.mkdtempSync(path.join(scratch, 'clone-src2-'));
    initRepo(src, ['--bare']);
    const dest = path.join(scratch, 'clone-iso-dest');
    cloneRepo(src, dest, [], { env: sandboxEnv() });
    assert.ok(fs.existsSync(path.join(dest, '.git')), 'a clone was made');
    assert.equal(fs.existsSync(path.join(dest, '.git', 'hooks', 'commit-msg')), false,
      'the template hook was copied — cloneRepo inherited the global template dir');
  });

  it('cloneRepo resolves a relative destination against execOpts.cwd', () => {
    const src = fs.mkdtempSync(path.join(scratch, 'clone-src3-'));
    initRepo(src, ['--bare']);
    const parent = fs.mkdtempSync(path.join(scratch, 'clone-parent-'));
    cloneRepo(src, 'here', [], { cwd: parent });
    assert.ok(fs.existsSync(path.join(parent, 'here', '.git')));
  });

  it('returns the directory, and throws (does not swallow) when git refuses', () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'ret-'));
    assert.equal(initRepo(dir), dir);
    assert.throws(() => initRepo(path.join(scratch, 'does-not-exist')));
  });
});

describe('test/ — every `git init` and `git clone` goes through the helper (the #831 family guard)', () => {
  const TEST_DIR = __dirname;

  // The places an `init`/`clone` invocation is allowed to live, and how many
  // each may carry. `_temp-repo.js` IS the helper (one of each). `git-template.test.js`
  // has one end-to-end case whose subject is the template mechanism itself; it
  // sandboxes its own global config and must keep reading a template.
  const SANCTIONED = {
    '_temp-repo.js': 2,
    'git-template.test.js': 1
  };
  // This file is not scanned: it holds the scanner's own fixture strings and
  // the sandboxed control case above, both of which name the command on
  // purpose. Its one real `git init` runs under a private global config.
  const SELF = path.basename(__filename);

  // The PROPERTY: no test reads the machine's git template. Every way git can
  // do that is a subcommand — `init` or `clone` — so the scanner keys on the
  // subcommand wherever it appears, not on one call syntax. The first version
  // pinned two syntaxes and stayed green over four survivors (a local
  // `git(cmd)` wrapper, and clones); this list is what it missed, kept so the
  // next shape is added here rather than discovered by the next flake.
  const SHAPES = [
    // a command string: execSync('git init …'), a `git clone …` template
    // literal, or such a string assembled in an array and joined later
    /['"`]git (init|clone)(\s|['"`])/,
    // an argv whose subcommand is init/clone, with any -c/--flag elements
    // before it: execFileSync('git', ['init', …]) or ['-c', 'x=y', 'init', …]
    // (elements before the subcommand must look like options — `-x` or
    // `key=value` — so a commit MESSAGE of "init" is not a match)
    /\bgit['"],\s*\[(?:\s*['"](?:-[^'"]*|[^'"]*=[^'"]*)['"]\s*,)*\s*['"](init|clone)['"]/,
    // a local wrapper: const git = (cmd) => execSync(`git ${cmd}`); git('init -q')
    /\bgit\s*\(\s*['"`](init|clone)(\s|['"`])/,
    // the workaround the helper replaces: a second isolation path is a second
    // place to forget
    /init\.templateDir=/
  ];

  /**
   * Count the lines in a file that make a repository — `git init` or
   * `git clone` in any of the shapes above — ignoring comments and test titles.
   *
   * @param {string} file - Absolute path
   * @returns {string[]} The offending lines, trimmed
   */
  function gitInitInvocations(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
      .filter((l) => !/^(describe|it|test)\(/.test(l))
      .filter((l) => SHAPES.some((re) => re.test(l)));
  }

  it('no test file makes a repository on its own — only the helper and the sanctioned template test', () => {
    const found = {};
    for (const name of fs.readdirSync(TEST_DIR)) {
      if (!name.endsWith('.js') || name === SELF) continue;
      const hits = gitInitInvocations(path.join(TEST_DIR, name));
      if (hits.length > 0) found[name] = hits;
    }
    const offenders = Object.entries(found)
      .filter(([name, hits]) => (SANCTIONED[name] || 0) < hits.length)
      .map(([name, hits]) => `${name}:\n    ${hits.join('\n    ')}`);
    assert.deepEqual(offenders, [],
      'a bare `git init` or `git clone` inherits the machine\'s global template dir, which TangleClaw '
      + 'rewrites under the running suite (#831). Call initRepo()/cloneRepo() from test/_temp-repo.js instead.');
  });

  it('the sanctioned sites are still present — a stale allowance would let one new site in unnoticed', () => {
    for (const [name, allowed] of Object.entries(SANCTIONED)) {
      const hits = gitInitInvocations(path.join(TEST_DIR, name));
      assert.equal(hits.length, allowed, `${name} was expected to carry exactly ${allowed} git init invocation(s)`);
    }
  });

  it('the scanner recognises every shape — string, argv (with -c prefix), wrapper, clone, templateDir — and ignores comments and titles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scan-'));
    try {
      const f = path.join(dir, 'x.js');
      fs.writeFileSync(f, [
        '// a comment about `git init` is fine',
        ' * so is a JSDoc line mentioning git init',
        "it('runs `git init` somewhere', () => {",
        "describe('git init picks up the hook', () => {",
        "execSync('git init -q', { cwd });",
        "execFileSync('git', ['init', '--template=', '-q'], { cwd });",
        'execFileSync("git", ["init"], { cwd });',
        "const setup = ['git init -q -b main', 'git config user.name t'];",
        "execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', root]);",
        "git('init -q .');",
        "git(`clone ${src} dest`);",
        "execSync(`git clone -q ${JSON.stringify(remote)} cloned`);",
        "execFileSync('git', ['clone', '--quiet', '--depth', '1', src, dest]);",
        "execSync('git status');",
        "execSync('git initialise-nothing');",
        "git('config user.name t');",
        "execFileSync('git', ['-c', 'user.name=t', 'commit', '-m', 'x']);",
        "execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });"
      ].join('\n'));
      assert.equal(gitInitInvocations(f).length, 9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
