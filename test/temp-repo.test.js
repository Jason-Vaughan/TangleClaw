'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { initRepo } = require('./_temp-repo');

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

  it('returns the directory, and throws (does not swallow) when git refuses', () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'ret-'));
    assert.equal(initRepo(dir), dir);
    assert.throws(() => initRepo(path.join(scratch, 'does-not-exist')));
  });
});

describe('test/ — every `git init` goes through initRepo (the #831 family guard)', () => {
  const TEST_DIR = __dirname;

  // The places a `git init` invocation is allowed to live, and how many each
  // may carry. `_temp-repo.js` IS the helper. `git-template.test.js` has
  // one end-to-end case whose subject is the template mechanism itself; it
  // sandboxes its own global config and must keep reading a template.
  const SANCTIONED = {
    '_temp-repo.js': 1,
    'git-template.test.js': 1
  };
  // This file is not scanned: it holds the scanner's own fixture strings and
  // the sandboxed control case above, both of which name the command on
  // purpose. Its one real `git init` runs under a private global config.
  const SELF = path.basename(__filename);

  /**
   * Count the lines in a file that invoke `git init`, ignoring comments and
   * test titles.
   *
   * Two shapes are recognised: a string literal starting `git init` (the
   * `execSync('git init …')` family, including a command assembled in an
   * array and joined later) and a `git` argv whose first element is `'init'`
   * (the `execFileSync('git', ['init', …])` family). Comment lines discuss
   * `git init` freely and are skipped by their leading `//` or `*`; so are
   * `describe`/`it`/`test` titles, which name the command without running it.
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
      .filter((l) => /['"`]git init(\s|['"`])/.test(l) || /\bgit['"],\s*\[\s*['"]init['"]/.test(l));
  }

  it('no test file runs `git init` on its own — only the helper and the sanctioned template test', () => {
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
      'a bare `git init` inherits the machine\'s global template dir, which TangleClaw rewrites '
      + 'under the running suite (#831). Call initRepo() from test/_temp-repo.js instead.');
  });

  it('the sanctioned sites are still present — a stale allowance would let one new site in unnoticed', () => {
    for (const [name, allowed] of Object.entries(SANCTIONED)) {
      const hits = gitInitInvocations(path.join(TEST_DIR, name));
      assert.equal(hits.length, allowed, `${name} was expected to carry exactly ${allowed} git init invocation(s)`);
    }
  });

  it('the scanner recognises both invocation shapes and ignores comments', () => {
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
        "execSync('git status');",
        "execSync('git initialise-nothing');"
      ].join('\n'));
      assert.equal(gitInitInvocations(f).length, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
