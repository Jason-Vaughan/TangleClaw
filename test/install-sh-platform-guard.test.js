'use strict';

/*
 * Linux platform support for deploy/install.sh (#2932, Car 5730-W2-B):
 * accepting Linux at the platform guard, detecting a package manager
 * (apt-get/dnf/pacman), dispatching ensure_dep's installs through it,
 * forcing direct-mode ingress (no systemd analogue of the caddy-mode
 * cutover yet), and delegating service installation to
 * scripts/linux-systemd-install.js instead of launchctl.
 *
 * test/install-sh.test.js already covers the platform guard's refusal on an
 * unsupported OS and every macOS-specific behavior (TCC preflight, the
 * caddy-mode cutover, launchd plist generation) — this file is Linux's own
 * dispatch, not a restatement of that coverage.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'deploy', 'install.sh');
const script = fs.readFileSync(SCRIPT_PATH, 'utf8');

const sandboxRoots = [];
after(() => {
  for (const root of sandboxRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe('deploy/install.sh — Linux platform dispatch (#2932)', () => {
  it('parses as valid bash', () => {
    execFileSync('bash', ['-n', SCRIPT_PATH]); // throws on a syntax error
  });

  it('accepts Linux at the platform guard, rejecting only neither Darwin nor Linux', () => {
    assert.match(script, /OS="\$\(uname -s\)"/);
    assert.match(script, /if \[ "\$OS" != "Darwin" \] && \[ "\$OS" != "Linux" \]/);
  });

  it('defines detect_pkg_mgr, linux_pkg_install, and an OS-dispatching ensure_dep', () => {
    assert.match(script, /detect_pkg_mgr\(\)\s*\{/);
    assert.match(script, /linux_pkg_install\(\)\s*\{/);
    assert.match(script, /ensure_dep\(\)\s*\{/);
    assert.match(script, /if \[ "\$OS" = "Darwin" \]/);
  });

  it('ensures ttyd build prerequisites (cmake, compiler, dev headers) before building ttyd, on Linux only', () => {
    const prereqAt = script.search(/ensure_linux_ttyd_build_prereqs\(\)\s*\{/);
    const callAt = script.search(/^ensure_linux_ttyd_build_prereqs$/m);
    const ttydAt = script.search(/^ensure_dep ttyd ttyd$/m);
    assert.notEqual(prereqAt, -1, 'must define ensure_linux_ttyd_build_prereqs');
    assert.notEqual(callAt, -1, 'must call ensure_linux_ttyd_build_prereqs');
    assert.ok(callAt < ttydAt, 'build prerequisites must be ensured before ttyd is built/provisioned');
    for (const pkg of ['libwebsockets-dev', 'libjson-c-dev', 'zlib1g-dev', 'libssl-dev']) {
      assert.ok(script.includes(pkg), `apt-get package list must include ${pkg}`);
    }
    for (const pkg of ['libwebsockets-devel', 'json-c-devel', 'zlib-devel', 'openssl-devel']) {
      assert.ok(script.includes(pkg), `dnf package list must include ${pkg}`);
    }
  });

  it('delegates service installation to scripts/linux-systemd-install.js, never launchctl, on Linux', () => {
    const linuxAt = script.search(/if \[ "\$OS" = "Linux" \]; then\n\s*# Direct mode only/);
    assert.notEqual(linuxAt, -1, 'must branch Load Services on $OS = Linux');
    assert.match(script, /LINUX_SYSTEMD_INSTALL="\$\{REPO_DIR\}\/scripts\/linux-systemd-install\.js"/);
    assert.match(script, /"\$LINUX_SYSTEMD_INSTALL" install --unit server/);
    assert.match(script, /"\$LINUX_SYSTEMD_INSTALL" install --unit ttyd/);
  });

  it('forces direct-mode ingress on Linux when config.json requests caddy mode, before the caddy preflight', () => {
    const forceAt = script.search(/if \[ "\$OS" = "Linux" \] && \[ "\$INGRESS_MODE" = "caddy" \]/);
    const preflightAt = script.search(/# ── Caddy-mode preflight/);
    assert.notEqual(forceAt, -1, 'must force direct mode on Linux when caddy is requested');
    assert.ok(forceAt < preflightAt, 'the force-direct override must run before the caddy preflight ever checks $INGRESS_MODE');
  });

  it('points the uninstall and ingress-mode guidance at systemd, not launchd, on Linux', () => {
    assert.match(script, /node scripts\/linux-systemd-install\.js uninstall --unit server/);
    assert.match(script, /password-gated Caddy ingress .*\bis not yet"/);
    assert.match(script, /available on Linux through install\.sh/);
  });

  /**
   * Build a sandbox: a stub bin dir on an otherwise-empty PATH, plus a
   * throwaway HOME, and a `calls.log` every stub can append its invocation
   * to. `dirname`/`which` are symlinked in because install.sh resolves its
   * own location, and ensure_dep's `command -v` checks, through them.
   * `sudo` execs straight through to its argument, since linux_pkg_install's
   * real commands are `sudo apt-get ...` etc. — without it, `sudo` itself
   * would be missing from this sandboxed PATH.
   *
   * `node` is a wrapper: a call to `scripts/ttyd-runtime.js` is answered with
   * a canned staged path (install.sh's `TTYD_PATH="$(node .../ttyd-
   * runtime.js provision ...)"` runs unconditionally once ensure_dep's own
   * `ttyd` check passes, so a test whose ttyd stub makes that check pass
   * WOULD otherwise reach the real provisioner — a real build, network
   * included); every other `node` call (the Node.js version check,
   * config.json reads) runs the real interpreter.
   * @param {(calls: string) => Record<string, string>} buildStubs - Given
   *   the sandbox's calls-log path, returns stub name → shell body.
   * @returns {{ bin: string, home: string, calls: string }}
   */
  function sandbox(buildStubs) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-linux-'));
    sandboxRoots.push(root);
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    const calls = path.join(root, 'calls.log');
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    for (const real of ['dirname', 'which']) {
      const found = ['/usr/bin', '/bin'].map((d) => path.join(d, real)).find((p) => fs.existsSync(p));
      if (found) fs.symlinkSync(found, path.join(bin, real));
    }
    const nodeBody = `case "$1" in\n  */scripts/ttyd-runtime.js) echo "${path.join(root, 'fake-ttyd')}"; exit 0 ;;\nesac\n`
      + `exec "${process.execPath}" "$@"`;
    const stubs = { sudo: 'exec "$@"', node: nodeBody, ...buildStubs(calls) };
    for (const [name, body] of Object.entries(stubs)) {
      const p = path.join(bin, name);
      fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
      fs.chmodSync(p, 0o755);
    }
    return { bin, home, calls };
  }

  /**
   * Run install.sh in the sandbox, returning its combined output and exit code.
   * @param {{ bin: string, home: string }} box
   * @returns {{ code: number, output: string }}
   */
  function runInstall(box) {
    try {
      const output = execFileSync('/bin/bash', [SCRIPT_PATH], {
        env: { PATH: box.bin, HOME: box.home },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000
      });
      return { code: 0, output };
    } catch (err) {
      return { code: err.status, output: `${err.stdout || ''}${err.stderr || ''}` };
    }
  }

  /** @param {{calls: string}} box @returns {string} */
  const stubCalls = (box) => (fs.existsSync(box.calls) ? fs.readFileSync(box.calls, 'utf8') : '');

  describe('package-manager detection (executed, not grepped)', () => {
    it('refuses cleanly when none of apt-get/dnf/pacman is on PATH, before any install attempt', () => {
      // Safety interlock: refuse to run at all unless the guard text we are
      // about to execute still matches what the source actually says.
      assert.match(script, /no supported package manager found/);

      // jq is the first ensure_dep call on Linux; with no package-manager
      // stub present at all, detect_pkg_mgr must refuse before trying to
      // install anything.
      const box = sandbox(() => ({ uname: 'echo Linux' }));
      const { code, output } = runInstall(box);
      assert.equal(code, 1);
      assert.match(output, /no supported package manager found/i);
    });

    for (const mgr of ['apt-get', 'dnf', 'pacman']) {
      it(`detects ${mgr} and dispatches ensure_dep's first Linux-only install (jq) through it`, () => {
        const box = sandbox((calls) => ({
          uname: 'echo Linux',
          [mgr]: `echo "${mgr} $*" >> "${calls}"\nexit 7`
        }));
        const { code } = runInstall(box);
        assert.equal(code, 1, 'the failing package-manager stub must stop the script');
        const calls = stubCalls(box);
        assert.match(calls, new RegExp(`^${mgr} .*\\bjq\\b`, 'm'), `expected ${mgr} to be asked to install jq first; got: ${calls}`);
      });
    }
  });

  describe('ensure_dep package-name dispatch (executed)', () => {
    it('installs jq via "apt-get update -qq" then "apt-get install -y jq" when apt-get is detected', () => {
      const box = sandbox((calls) => ({
        uname: 'echo Linux',
        'apt-get': `echo "apt-get $*" >> "${calls}"`
      }));
      // apt-get "succeeds" (exit 0, the default for a stub with no explicit
      // exit) but never actually puts a jq binary on PATH, so ensure_dep's
      // post-install `command -v jq` check fails and the script stops right
      // there — which is fine: the calls log already proves what mattered.
      runInstall(box);
      const calls = stubCalls(box);
      assert.match(calls, /^apt-get update -qq$/m);
      assert.match(calls, /^apt-get install -y jq$/m);
    });

    it('passes certutil\'s Linux-only, per-manager package name (libnss3-tools) to apt-get', () => {
      // certutil is Linux-only and named differently per manager (mkcert's
      // own Firefox-NSS-trust-store requirement) — the clearest case where a
      // wrong dispatch would pass the WRONG package name. Reached only once
      // jq/git/curl, ttyd's build prereqs, ttyd itself, tmux and mkcert all
      // "succeed" (apt-get exits 0 for everything), so every one of those
      // must be stubbed as present on PATH too, or the script stops earlier.
      const box = sandbox((calls) => ({
        uname: 'echo Linux',
        'apt-get': `echo "apt-get $*" >> "${calls}"`,
        jq: 'true', git: 'true', curl: 'true',
        ttyd: 'true', tmux: 'true', mkcert: 'true'
      }));
      runInstall(box);
      const calls = stubCalls(box);
      assert.match(calls, /^apt-get install -y libnss3-tools$/m, `expected libnss3-tools via apt-get; got:\n${calls}`);
    });
  });
});
