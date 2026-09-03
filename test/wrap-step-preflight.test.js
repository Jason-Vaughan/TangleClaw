'use strict';

/**
 * `preflight` wrap step (#854) — ask prawduct for its session-end verdict
 * before the pipeline writes anything.
 *
 * The property that matters is NEGATIVE, so it is the one most of this suite
 * pins: a probe that could not answer must never be reported as clear gates.
 * Hook missing, hook killed, spawn refused — each is `skipped` with
 * `measured: false`, never `done`. A step that says "gates clear" about gates
 * it never measured is the false-report class the wrap drawer exists to end,
 * and it is invisible in the UI precisely when it is wrong.
 *
 * The two `_exec-shell` options this step introduced are exercised against
 * REAL child processes rather than a double, because both are about what the
 * OS does: `closeStdin` fixes a child that reads stdin to EOF hanging to the
 * timeout (prawduct's Stop hook reads its harness payload that way), and `env`
 * pins `CLAUDE_PROJECT_DIR`. A hand-built double asserts the model, not the
 * behaviour, and the model is the thing that was wrong.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const preflight = require('../lib/wrap-steps/preflight');
const execShellLib = require('../lib/wrap-steps/_exec-shell');

/**
 * Run `fn` with `preflight._internal` overridden, restoring every key after.
 * @param {object} overrides - Keys to replace on `_internal`.
 * @param {Function} fn - Async body.
 * @returns {Promise<*>} Whatever `fn` resolves to.
 */
async function withInternal(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = preflight._internal[k];
  Object.assign(preflight._internal, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(preflight._internal, saved);
  }
}

/**
 * A temporary directory, removed after `fn`.
 * @param {Function} fn - Receives the directory path.
 * @returns {Promise<*>} Whatever `fn` resolves to.
 */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-preflight-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * An exec double resolving the given result, recording how it was called.
 * @param {object} result - The `execFileArgs` contract shape.
 * @returns {Function} The double, with `.calls`.
 */
function execDouble(result) {
  const fn = async (file, args, options) => {
    fn.calls.push({ file, args, options });
    return { exitCode: 0, stdout: '', stderr: '', error: null, timedOut: false, ...result };
  };
  fn.calls = [];
  return fn;
}

/** A governed project context: a real directory carrying `.prawduct/`. */
async function withGovernedProject(fn) {
  return withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, '.prawduct'));
    return fn({ id: 1, name: 'demo', path: dir });
  });
}

describe('wrap step: preflight (#854)', () => {
  describe('when it must not spawn at all', () => {
    it('skips without a project path, and says the gates were not measured', async () => {
      const exec = execDouble({});
      const result = await withInternal({ execFileArgs: exec }, () =>
        preflight.run({ project: null, step: {} }));

      assert.equal(result.status, 'skipped');
      assert.equal(result.ok, true, 'a skip is not a failure — the wrap goes on');
      assert.match(result.output.reason, /context\.project\.path/);
      assert.equal(exec.calls.length, 0, 'nothing may be spawned without a project');
    });

    it('skips a project with no .prawduct/ without spawning a probe', async () => {
      const exec = execDouble({});
      await withTempDir(async (dir) => {
        const result = await withInternal({ execFileArgs: exec }, () =>
          preflight.run({ project: { id: 1, name: 'plain', path: dir }, step: {} }));

        assert.equal(result.status, 'skipped');
        assert.equal(result.output.governed, false);
        assert.match(result.output.reason, /not a prawduct-governed project/);
        // The hook would exit 0 here; the point is that an ungoverned project
        // never pays a python spawn per wrap to be told so.
        assert.equal(exec.calls.length, 0, 'an ungoverned project spawns nothing');
      });
    });
  });

  describe('a probe that could not answer is never a clean verdict', () => {
    it('reports the hook being absent as unmeasured, not as clear', async () => {
      const exec = execDouble({});
      await withGovernedProject(async (project) => {
        const result = await withInternal({ locateHook: () => null, execFileArgs: exec }, () =>
          preflight.run({ project, step: {} }));

        assert.equal(result.status, 'skipped');
        assert.notEqual(result.status, 'done', 'a hook that was never found measured nothing');
        assert.equal(result.output.governed, true);
        assert.equal(result.output.measured, false);
        assert.match(result.output.reason, /gates not measured/);
        assert.equal(exec.calls.length, 0);
      });
    });

    it('reports a killed probe as unmeasured, naming the timeout in seconds', async () => {
      const exec = execDouble({ timedOut: true, exitCode: 124, error: 'timed out' });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec,
          timeoutMs: 60000
        }, () => preflight.run({ project, step: {} }));

        assert.equal(result.status, 'skipped');
        assert.equal(result.output.measured, false);
        assert.match(result.output.reason, /did not finish within 60s/);
        assert.match(result.output.reason, /gates not measured/);
      });
    });

    it('reports a spawn error as unmeasured, carrying the error text', async () => {
      const exec = execDouble({ error: 'EACCES: permission denied', exitCode: 1 });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec
        }, () => preflight.run({ project, step: {} }));

        assert.equal(result.status, 'skipped');
        assert.equal(result.output.measured, false);
        assert.match(result.output.reason, /EACCES: permission denied/);
        assert.match(result.output.reason, /gates not measured/);
      });
    });
  });

  describe('the verdict', () => {
    it('exit 0 is done and measured', async () => {
      const exec = execDouble({ exitCode: 0 });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec
        }, () => preflight.run({ project, step: {} }));

        assert.equal(result.status, 'done');
        assert.equal(result.ok, true);
        assert.equal(result.output.measured, true);
        assert.equal(result.output.governed, true);
        assert.deepStrictEqual(result.blockers, []);
      });
    });

    it('pins the probe to the project it was asked about, and closes its stdin', async () => {
      const exec = execDouble({ exitCode: 0 });
      await withGovernedProject(async (project) => {
        await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec
        }, () => preflight.run({ project, step: {} }));

        const call = exec.calls[0];
        assert.deepStrictEqual(call.args, ['stop']);
        assert.equal(call.options.cwd, project.path);
        // The server's own environment may carry a CLAUDE_PROJECT_DIR from the
        // session it was launched from; the probe must ask about THIS project.
        assert.equal(call.options.env.CLAUDE_PROJECT_DIR, project.path);
        assert.equal(call.options.closeStdin, true,
          'the hook reads stdin to EOF — an open pipe hangs it to the timeout');
      });
    });

    it('an unmet gate is advisory by default: blocked, but flagged so the wrap reads as continued', async () => {
      const exec = execDouble({ exitCode: 2, stderr: 'BLOCKED — resolve before ending session:\nREFLECTION: ...' });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec
        }, () => preflight.run({ project, step: { blocker: false } }));

        assert.equal(result.status, 'blocked');
        assert.equal(result.ok, false);
        assert.equal(result.output.advisory, true);
        assert.equal(result.output.warning, true,
          'the drawer\'s "ok, but look at this" channel — the banner must read completed-with-warnings');
        assert.match(result.output.blockText, /REFLECTION/);
        assert.match(result.output.remediation, /nothing here needs a retry/);
      });
    });

    it('a project that opted into blocking halts here, with remediation that says the tree is untouched', async () => {
      const exec = execDouble({ exitCode: 2, stderr: 'BLOCKED — CRITIC: no review captured' });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec
        }, () => preflight.run({ project, step: { blocker: true } }));

        assert.equal(result.status, 'blocked');
        assert.equal(result.output.advisory, false);
        assert.notEqual(result.output.warning, true, 'a halting block IS the blocker — no warning flag');
        assert.match(result.output.remediation, /before touching the tree/);
        assert.deepStrictEqual(result.blockers, ['BLOCKED — CRITIC: no review captured']);
      });
    });

    it('treats `errors-only` as halting too, so the resolved blocker value decides the wording', async () => {
      const exec = execDouble({ exitCode: 2, stderr: 'BLOCKED' });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec
        }, () => preflight.run({ project, step: { blocker: 'errors-only' } }));

        assert.equal(result.output.advisory, false);
      });
    });

    it('an exit code outside the hook\'s 0/2 contract is unmeasured, not a verdict', async () => {
      // The hook's contract is exactly two outcomes. It ALSO exits 1 on an
      // unrecognised subcommand, a build-plan refusal, and a traceback — and
      // rendering a Python stack trace to the operator as prawduct's block text
      // is precisely the false report this step exists to prevent.
      const exec = execDouble({ exitCode: 1, stderr: 'Traceback (most recent call last): ...' });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec
        }, () => preflight.run({ project, step: { blocker: false } }));

        assert.equal(result.status, 'skipped', 'a broken hook measured nothing');
        assert.notEqual(result.status, 'blocked', 'and must not be dressed up as a governance block');
        assert.equal(result.output.measured, false);
        assert.match(result.output.reason, /neither clear \(0\) nor blocked \(2\)/);
        assert.deepStrictEqual(result.blockers, []);
      });
    });

    it('falls back to stdout when the hook printed no stderr, and never reports an empty blocker', async () => {
      const exec = execDouble({ exitCode: 2, stderr: '', stdout: 'gate text on stdout' });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec
        }, () => preflight.run({ project, step: { blocker: false } }));

        assert.equal(result.output.blockText, 'gate text on stdout');
      });

      const silent = execDouble({ exitCode: 2, stderr: '', stdout: '' });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: silent
        }, () => preflight.run({ project, step: { blocker: false } }));

        assert.deepStrictEqual(result.blockers, ['prawduct-hook stop exited 2 with no message'],
          'a silent refusal still names itself — an empty blocker list would read as no block at all');
      });
    });

    it('keeps the TAIL of a runaway block text, capped, so the verdict survives the truncation', async () => {
      // The verdict prawduct prints last is the part an operator needs; a head
      // slice would keep the banner and drop the reason.
      const noise = 'x'.repeat(9000);
      const exec = execDouble({ exitCode: 2, stderr: `${noise}\nTHE ACTUAL VERDICT` });
      await withGovernedProject(async (project) => {
        const result = await withInternal({
          locateHook: () => ({ path: '/hook', via: 'PATH' }),
          execFileArgs: exec
        }, () => preflight.run({ project, step: { blocker: false } }));

        assert.ok(result.output.blockText.length <= 4000, 'block text is capped');
        assert.match(result.output.blockText, /THE ACTUAL VERDICT$/);
      });
    });
  });

  describe('locating the hook', () => {
    it('prefers PATH, and reports which route found it', async () => {
      await withTempDir(async (dir) => {
        const hook = path.join(dir, preflight.HOOK_NAME);
        fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const found = await withInternal({
          pathDirs: () => [dir],
          installedPluginBin: () => '/never/reached'
        }, async () => preflight.locateHook());

        assert.deepStrictEqual(found, { path: hook, via: 'PATH' });
      });
    });

    it('falls back to the plugin registry when PATH carries no hook', async () => {
      const found = await withInternal({
        pathDirs: () => ['/nonexistent'],
        installedPluginBin: () => '/plugins/prawduct/bin/prawduct-hook'
      }, async () => preflight.locateHook());

      assert.deepStrictEqual(found, { path: '/plugins/prawduct/bin/prawduct-hook', via: 'installed plugin' });
    });

    it('is null when neither route finds one — the caller turns that into an unmeasured skip', async () => {
      const found = await withInternal({
        pathDirs: () => ['/nonexistent'],
        installedPluginBin: () => null
      }, async () => preflight.locateHook());

      assert.equal(found, null);
    });

    it('skips a PATH entry that names a directory rather than an executable file', async () => {
      await withTempDir(async (dir) => {
        // A directory named `prawduct-hook` is X_OK-accessible; only the
        // isFile() half of the check rejects it.
        fs.mkdirSync(path.join(dir, preflight.HOOK_NAME));
        const found = await withInternal({
          pathDirs: () => [dir],
          installedPluginBin: () => null
        }, async () => preflight.locateHook());

        assert.equal(found, null, 'a directory is not a hook');
      });
    });
  });

  describe('installedPluginBin', () => {
    it('prefers a user-scope install over a project-scope one', async () => {
      await withTempDir(async (home) => {
        const userDir = path.join(home, 'user-install', 'bin');
        const projDir = path.join(home, 'proj-install', 'bin');
        for (const d of [userDir, projDir]) {
          fs.mkdirSync(d, { recursive: true });
          fs.writeFileSync(path.join(d, preflight.HOOK_NAME), '#!/bin/sh\n', { mode: 0o755 });
        }
        fs.writeFileSync(path.join(home, 'installed_plugins.json'), JSON.stringify({
          plugins: {
            // Project scope listed FIRST, so a pass that merely took the first
            // entry would pick it.
            'prawduct@marketplace': [
              { scope: 'project', installPath: path.join(home, 'proj-install') },
              { scope: 'user', installPath: path.join(home, 'user-install') }
            ]
          }
        }));

        const found = await withInternal({ pluginsHome: () => home }, async () =>
          preflight.installedPluginBin());

        assert.equal(found, path.join(userDir, preflight.HOOK_NAME));
      });
    });

    it('ignores plugins that are not prawduct', async () => {
      await windowlessRegistry({ 'somethingelse@mk': [{ scope: 'user', installPath: '/x' }] }, null);
    });

    it('is null on a malformed registry rather than throwing into the pipeline', async () => {
      await windowlessRegistry('not an object at all', null);
    });

    it('is null when the registry names an install with no executable hook', async () => {
      await withTempDir(async (home) => {
        fs.mkdirSync(path.join(home, 'install', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(home, 'installed_plugins.json'), JSON.stringify({
          plugins: { 'prawduct@mk': [{ scope: 'user', installPath: path.join(home, 'install') }] }
        }));

        const found = await withInternal({ pluginsHome: () => home }, async () =>
          preflight.installedPluginBin());

        assert.equal(found, null, 'a registry entry is a claim, not a hook');
      });
    });

    it('is null when there is no registry file at all', async () => {
      await withTempDir(async (home) => {
        const found = await withInternal({ pluginsHome: () => home }, async () =>
          preflight.installedPluginBin());
        assert.equal(found, null);
      });
    });
  });
});

/**
 * Write `plugins` (or raw text) as the registry and assert the located hook.
 * @param {object|string} plugins - Registry `plugins` value, or raw file text.
 * @param {string|null} expected - Expected `installedPluginBin()` result.
 * @returns {Promise<void>}
 */
async function windowlessRegistry(plugins, expected) {
  await withTempDir(async (home) => {
    const body = typeof plugins === 'string' ? plugins : JSON.stringify({ plugins });
    fs.writeFileSync(path.join(home, 'installed_plugins.json'), body);
    const found = await withInternal({ pluginsHome: () => home }, async () =>
      preflight.installedPluginBin());
    assert.equal(found, expected);
  });
}

describe('_exec-shell options the preflight probe needs (#854)', () => {
  /** Long enough not to race a spawn, short enough to keep the suite fast. */
  const TIMEOUT_MS = 4000;

  it('closeStdin lets a child that reads stdin to EOF finish instead of hanging to the timeout', async () => {
    // Without the flag this child blocks on its read forever: nothing writes to
    // its stdin pipe and — measured — nothing closes it either, so it is killed
    // and reported as `timedOut`. That is the whole reason the flag exists.
    const script = 'import sys; sys.stdin.read(); print("read to EOF")';

    const closed = await execShellLib.execFileArgs('python3', ['-c', script], {
      cwd: os.tmpdir(), timeoutMs: TIMEOUT_MS, maxBufferBytes: 1024 * 1024, closeStdin: true
    });
    assert.equal(closed.timedOut, false, 'a closed stdin lets the child reach EOF');
    assert.equal(closed.exitCode, 0);
    assert.match(closed.stdout, /read to EOF/);

    const open = await execShellLib.execFileArgs('python3', ['-c', script], {
      cwd: os.tmpdir(), timeoutMs: 700, maxBufferBytes: 1024 * 1024
    });
    assert.equal(open.timedOut, true,
      'the pre-flag behaviour, pinned: an open stdin hangs the child to the timeout');
  });

  it('env replaces the child environment rather than merging into this process\'s', async () => {
    const result = await execShellLib.execFileArgs(
      'node', ['-e', 'process.stdout.write(String(process.env.TC_PREFLIGHT_PIN))'],
      {
        cwd: os.tmpdir(), timeoutMs: TIMEOUT_MS, maxBufferBytes: 1024 * 1024,
        env: { ...process.env, TC_PREFLIGHT_PIN: '/pinned/project' }
      }
    );

    assert.equal(result.stdout, '/pinned/project');
    // Pins that `env` REPLACED the child's environment rather than being
    // ignored: without the option the child would read this process's value,
    // which is unset — so an assertion that only checked "not empty" would
    // pass against a no-op.
    const unset = await execShellLib.execFileArgs(
      'node', ['-e', 'process.stdout.write(String(process.env.TC_PREFLIGHT_PIN))'],
      { cwd: os.tmpdir(), timeoutMs: TIMEOUT_MS, maxBufferBytes: 1024 * 1024 }
    );
    assert.equal(unset.stdout, 'undefined', 'the variable exists only because env supplied it');
  });

  it('execShell honours the same two options', async () => {
    const result = await execShellLib.execShell('cat; echo "TC:$TC_PREFLIGHT_PIN"', {
      cwd: os.tmpdir(), timeoutMs: TIMEOUT_MS, maxBufferBytes: 1024 * 1024,
      closeStdin: true, env: { ...process.env, TC_PREFLIGHT_PIN: 'pinned' }
    });

    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /TC:pinned/);
  });

  it('a failed spawn with closeStdin reports through the contract rather than throwing', async () => {
    // What this DOES pin: the failure arrives as a resolved `{error}`, and
    // closing stdin does not change that.
    //
    // What it does NOT pin, stated rather than implied: the `'error'` listener
    // on `child.stdin`. Removing that listener leaves this green, because on
    // darwin a spawn failure never emits on the stdin stream — the case it
    // guards is an async spawn error on some other platform (the hook is a
    // `#!/usr/bin/env python3` script, so an X_OK check on the file cannot see
    // a missing interpreter). Driving it deterministically would mean a guard
    // that passes here and reds on CI, which this repo has been burned by three
    // times (#974 reddened `main` and blocked a release). The listener stays as
    // a cheap unconditional safety, and this comment is the honest account of
    // its coverage.
    const result = await execShellLib.execFileArgs('/nonexistent/definitely-not-a-binary', ['stop'], {
      cwd: os.tmpdir(), timeoutMs: TIMEOUT_MS, maxBufferBytes: 1024 * 1024, closeStdin: true
    });

    assert.ok(result.error, 'the failure is reported through the contract, not thrown');
    assert.equal(result.timedOut, false);
  });

  it('leaves stdin open when the flag is absent, so no existing caller changed behaviour', async () => {
    const result = await execShellLib.execFileArgs('node', ['-e', 'process.stdout.write(String(process.stdin.readableEnded))'], {
      cwd: os.tmpdir(), timeoutMs: TIMEOUT_MS, maxBufferBytes: 1024 * 1024
    });

    assert.equal(result.stdout, 'false', 'stdin is untouched without the flag');
  });
});
