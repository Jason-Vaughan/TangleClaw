'use strict';

// #828 — TangleClaw's base directory had two derivations, one from
// `process.env.HOME` and one from `os.homedir()`. They agree when `$HOME` is
// set (Node's `os.homedir()` prefers it) and disagree when it is NOT: the env
// read yields `''` while `os.homedir()` falls back to the passwd entry, so the
// store wrote its database to `/.tangleclaw/` while master state and git
// templates kept writing to the operator's real home. A half-relocated install
// is worse than an un-relocated one because it looks like it worked.
//
// The behaviour that matters here is a PROPERTY of the whole install, not of
// one module, so the second suite drives every derivation site at once: any new
// site that re-derives the base independently makes it fail.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tangleclawHome = require('../lib/tangleclaw-home');

const REPO_ROOT = path.join(__dirname, '..');

describe('lib/tangleclaw-home', () => {
  let savedOverride, savedHome;

  beforeEach(() => {
    savedOverride = process.env[tangleclawHome.HOME_ENV];
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedOverride === undefined) delete process.env[tangleclawHome.HOME_ENV];
    else process.env[tangleclawHome.HOME_ENV] = savedOverride;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  describe('baseDir', () => {
    it('is the home directory plus .tangleclaw when nothing overrides it', () => {
      delete process.env[tangleclawHome.HOME_ENV];
      assert.equal(tangleclawHome.baseDir(), path.join(tangleclawHome.userHome(), '.tangleclaw'));
    });

    it('TANGLECLAW_HOME names the base directory itself, with no .tangleclaw appended', () => {
      process.env[tangleclawHome.HOME_ENV] = '/tmp/tc-scratch';
      assert.equal(tangleclawHome.baseDir(), '/tmp/tc-scratch');
    });

    it('resolves a relative override to absolute, so no consumer resolves it against its own cwd', () => {
      process.env[tangleclawHome.HOME_ENV] = 'rel/scratch';
      assert.equal(tangleclawHome.baseDir(), path.resolve('rel/scratch'));
    });

    it('ignores a blank override rather than treating cwd as the base directory', () => {
      // `path.resolve('')` is the cwd, so a variable exported empty by a shell
      // script would silently move every install onto whatever directory the
      // process happened to start in.
      for (const blank of ['', '   ']) {
        process.env[tangleclawHome.HOME_ENV] = blank;
        assert.equal(tangleclawHome.baseDir(), path.join(tangleclawHome.userHome(), '.tangleclaw'));
      }
    });

    it('is read at call time, so an override set after this module loaded is honoured', () => {
      delete process.env[tangleclawHome.HOME_ENV];
      const before = tangleclawHome.baseDir();
      process.env[tangleclawHome.HOME_ENV] = '/tmp/tc-late';
      assert.notEqual(tangleclawHome.baseDir(), before);
      assert.equal(tangleclawHome.baseDir(), '/tmp/tc-late');
    });
  });

  describe('an unresolvable home is named, not papered over', () => {
    it('throws instead of composing a cwd-relative base directory', () => {
      // `path.join('', '.tangleclaw')` drops the empty segment and yields the
      // RELATIVE `.tangleclaw`, so the store would seed a config and open an
      // empty database under the process's working directory and report a
      // healthy boot. Driven through a child with both home sources removed,
      // because `os.homedir()` cannot be stubbed in-process.
      const childEnv = { ...process.env };
      delete childEnv.HOME;
      delete childEnv[tangleclawHome.HOME_ENV];
      childEnv.USERPROFILE = '';
      const r = require('node:child_process').spawnSync(process.execPath, [
        '-e',
        // Force the failure the way the real one arrives: no home resolves.
        'const m = require("./lib/tangleclaw-home");'
        + 'const os = require("node:os"); os.homedir = () => "";'
        + 'delete process.env.HOME;'
        + 'try { process.stdout.write("RETURNED:" + m.baseDir()); }'
        + 'catch (e) { process.stdout.write("THREW:" + e.message); }'
      ], { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8' });
      assert.match(r.stdout, /^THREW:/, `expected a named error, got ${r.stdout}`);
      assert.match(r.stdout, new RegExp(tangleclawHome.HOME_ENV),
        'the error must name the override that fixes it');
    });
  });

  describe('userHome', () => {
    it('answers even with HOME unset — the case the two old derivations disagreed on', () => {
      // The env-read derivation returned `''` here and put the database at
      // `/.tangleclaw`. Asserted in a child process because deleting HOME in
      // this one would not change `os.homedir()`'s already-cached answer for
      // other suites sharing the process.
      //
      // The child reports whether HOME actually reached it unset, because
      // `env: {...}` silently keeping HOME would leave this passing for the
      // wrong reason — the guard would read as caution while testing nothing.
      const childEnv = { ...process.env };
      delete childEnv.HOME;
      const out = execFileSync(process.execPath, [
        '-e',
        'process.stdout.write(JSON.stringify({ home: require("./lib/tangleclaw-home").userHome(), envHome: process.env.HOME ?? null }))'
      ], { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8' });
      const got = JSON.parse(out);
      assert.equal(got.envHome, null, 'HOME reached the child still set — this case was never exercised');
      assert.notEqual(got.home, '');
      assert.ok(path.isAbsolute(got.home), `expected an absolute home, got ${got.home}`);

      // And the old env-only derivation is what fails here — stated as an
      // assertion rather than a comment, so the premise stays checked.
      const oldWay = execFileSync(process.execPath, [
        '-e',
        'process.stdout.write(JSON.stringify(process.env.HOME || ""))'
      ], { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8' });
      assert.equal(JSON.parse(oldWay), '', 'the derivation this replaced no longer diverges — re-check whether #828 still holds');
    });
  });
});

describe('one base directory across every derivation site (#828)', () => {
  // The acceptance criterion: the override relocates ALL of it or none of it,
  // never half. Each entry names a site that used to derive the base for
  // itself; the expression is evaluated in a child process so the override is
  // in place before any module loads.
  const SITES = [
    ['store (database)', 'require("./lib/store")._getBasePath()', ''],
    ['master state', 'require("./lib/master").masterHome()', 'master'],
    ['git template', 'require("./lib/git-template").templateDir()', 'git-template'],
    ['ttyd attach script', 'require("./lib/ttyd-attach").attachScriptPath()', 'deploy/ttyd-attach.sh']
  ];

  /**
   * Evaluate an expression in a fresh node process with the base-directory
   * override set, returning its trimmed stdout.
   *
   * @param {string} expr - Expression whose value is a path
   * @param {string} base - Value for `TANGLECLAW_HOME`
   * @returns {string}
   */
  function resolveIn(expr, base) {
    return execFileSync(process.execPath, ['-e', `process.stdout.write(String(${expr}))`], {
      cwd: REPO_ROOT,
      env: { ...process.env, [tangleclawHome.HOME_ENV]: base },
      encoding: 'utf8'
    }).trim();
  }

  let scratch;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-base-'));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  for (const [label, expr, suffix] of SITES) {
    it(`${label} relocates with the override`, () => {
      const got = resolveIn(expr, scratch);
      assert.equal(got, suffix ? path.join(scratch, ...suffix.split('/')) : scratch,
        `${label} did not follow TANGLECLAW_HOME — it derives the base directory independently`);
    });
  }

  it('no site is left behind: every site lands under the same root', () => {
    const roots = SITES.map(([, expr]) => resolveIn(expr, scratch));
    for (const got of roots) {
      assert.ok(got === scratch || got.startsWith(scratch + path.sep),
        `${got} is outside the overridden base ${scratch}`);
    }
    assert.equal(new Set(roots).size, roots.length,
      'two sites resolved to the same path — the fixture is not distinguishing them');
  });

  it('the PID file lands in the overridden base — checked by writing one, not by asking', () => {
    // `pidfile` exposes no path accessor, and inventing one for the test would
    // assert the derivation rather than the behaviour it drives. Drive the real
    // producer instead: `write()` with no argument is exactly what the server
    // calls at boot.
    execFileSync(process.execPath, ['-e', 'require("./lib/pidfile").write()'], {
      cwd: REPO_ROOT,
      env: { ...process.env, [tangleclawHome.HOME_ENV]: scratch },
      encoding: 'utf8'
    });
    assert.ok(fs.existsSync(path.join(scratch, 'tangleclaw.pid')),
      'pidfile wrote outside the overridden base — it derives the base directory independently');
  });
});
