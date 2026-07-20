'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'deploy', 'install.sh');

describe('deploy/install.sh', () => {
  const script = fs.readFileSync(SCRIPT_PATH, 'utf8');

  it('should exist and be executable', () => {
    const stat = fs.statSync(SCRIPT_PATH);
    assert.ok(stat.mode & 0o100, 'script should have execute permission');
  });

  it('should detect protocol from ~/.tangleclaw/config.json', () => {
    assert.ok(
      script.includes('$HOME/.tangleclaw/config.json'),
      'must read config.json from the TangleClaw home directory'
    );
    assert.ok(
      /PROTOCOL="http"/.test(script),
      'must default PROTOCOL to http before inspecting config'
    );
  });

  it('should require httpsEnabled AND both cert paths to pick https', () => {
    assert.ok(
      /httpsEnabled && c\.httpsCertPath && c\.httpsKeyPath/.test(script),
      'protocol detection must mirror createServer()\'s guard: httpsEnabled + both cert paths'
    );
  });

  it('should fall back to http when config file is missing (first install)', () => {
    assert.ok(
      /if \[ -f "\$CONFIG_FILE" \]/.test(script),
      'must check config file exists before trying to parse it'
    );
  });

  it('should use curl -k when protocol is https', () => {
    assert.ok(
      /CURL_OPTS="-k"/.test(script),
      'must set CURL_OPTS=-k when HTTPS is detected so self-signed/mkcert certs are accepted'
    );
    assert.ok(
      /curl -s \$CURL_OPTS/.test(script),
      'health check must pass $CURL_OPTS to curl'
    );
  });

  it('should use the detected protocol in the health-check URL', () => {
    assert.ok(
      /"\$\{PROTOCOL\}:\/\/localhost:3102\/api\/health"/.test(script),
      'health check URL must interpolate $PROTOCOL'
    );
  });

  it('should use the detected protocol in the completion landing-page URL', () => {
    assert.ok(
      /\$\{PROTOCOL\}:\/\/localhost:3102/.test(script),
      'completion output landing page URL must interpolate $PROTOCOL'
    );
  });

  it('should keep the ttyd terminal URL on http (ttyd does not serve TLS)', () => {
    assert.ok(
      script.includes('http://localhost:3100'),
      'ttyd URL stays on http since ttyd plist does not configure TLS'
    );
  });

  // Single-command install: every runtime dependency is auto-installed via
  // Homebrew (and Homebrew itself bootstrapped if absent), so a fresh Mac needs
  // only `bash deploy/install.sh`. The privileged/interactive steps (brew + the
  // mkcert CA trust) live here, never in the headless launchd server.
  describe('dependency auto-install', () => {
    it('parses as valid bash (syntax gate on the bootstrap additions)', () => {
      const { execFileSync } = require('node:child_process');
      execFileSync('bash', ['-n', SCRIPT_PATH]); // throws on a syntax error
    });

    it('defines the ensure_homebrew and ensure_dep helpers', () => {
      assert.match(script, /ensure_homebrew\(\)\s*\{/, 'must define ensure_homebrew');
      assert.match(script, /ensure_dep\(\)\s*\{/, 'must define ensure_dep');
    });

    it('bootstraps Homebrew non-interactively when it is missing', () => {
      assert.match(script, /Homebrew\/install\/HEAD\/install\.sh/, 'must use the official Homebrew installer');
      assert.match(script, /NONINTERACTIVE=1/, 'Homebrew install must be non-interactive');
      assert.match(script, /brew shellenv/, 'must prime brew onto PATH after install (Apple Silicon + Intel)');
    });

    it('auto-installs ttyd, tmux, mkcert, and caddy via ensure_dep', () => {
      for (const dep of ['ttyd ttyd', 'tmux tmux', 'mkcert mkcert', 'caddy caddy']) {
        assert.ok(script.includes(`ensure_dep ${dep}`), `must ensure_dep ${dep}`);
      }
    });

    it('auto-installs node via Homebrew when it is absent', () => {
      assert.match(script, /"\$BREW" install node/, 'must install node via brew when missing');
    });

    it('trusts the mkcert local CA during install (privileged step kept out of the server)', () => {
      assert.match(script, /mkcert -install/, 'must run mkcert -install to trust the local CA interactively');
    });
  });

  // #324 — macOS TCC preflight: warn (and later diagnose) when the repo lives
  // under a protected folder and node may lack Full Disk Access, instead of
  // letting the launchd server hang silently.
  describe('macOS TCC preflight (#324)', () => {
    it('should guard the TCC checks to Darwin only', () => {
      assert.ok(
        /\[ "\$\(uname\)" = "Darwin" \]/.test(script),
        'TCC preflight must be macOS-only (guarded on uname = Darwin)'
      );
    });

    it('should detect the repo living under a TCC-protected folder', () => {
      assert.ok(
        script.includes('$HOME/Documents/') &&
        script.includes('$HOME/Desktop/') &&
        script.includes('$HOME/Downloads/'),
        'must check all three TCC-protected roots (Documents, Desktop, Downloads)'
      );
    });

    it('should point the operator at Full Disk Access for the resolved node binary', () => {
      assert.ok(/Full Disk Access/.test(script), 'must name the Full Disk Access remedy');
      assert.ok(
        /realpathSync/.test(script),
        'must resolve the node symlink (FDA is keyed on the real binary path)'
      );
      assert.ok(/RESOLVED_NODE/.test(script), 'must surface the resolved node path');
    });

    it('should escalate to a TCC-specific diagnosis when the health check fails', () => {
      // The failure branch must be gated on the protected-folder flag so it only
      // fires in the situation that actually causes the hang.
      assert.ok(/TCC_PROTECTED/.test(script), 'must track whether the repo is under a protected folder');
      assert.ok(
        /if \[ -n "\$TCC_PROTECTED" \]/.test(script),
        'health-check-failure remediation must be gated on TCC_PROTECTED'
      );
      assert.ok(/uv_cwd/.test(script), 'diagnosis should name the uv_cwd hang signature so it is recognizable');
    });

    it('should create the log directory before loading services', () => {
      assert.ok(
        /mkdir -p "\$HOME\/\.tangleclaw\/logs"/.test(script),
        'must create ~/.tangleclaw/logs before launchd starts the server (plist StandardErrorPath lives there)'
      );
    });

    it('should initialize RESOLVED_NODE/TCC_PROTECTED (set -u safety)', () => {
      assert.ok(/TCC_PROTECTED=""/.test(script), 'TCC_PROTECTED must be initialized');
      assert.ok(/RESOLVED_NODE="\$NODE_PATH"/.test(script), 'RESOLVED_NODE must be initialized');
    });
  });

  // These two run the real script rather than grepping it, because both defects
  // were failures of BEHAVIOR that a source-shape assertion would have happily
  // matched: the script "handled" a failed download and "supported" Linux right
  // up until you ran it.
  //
  // Executing an installer in a unit test needs a hard safety story, and a
  // stubbed PATH is NOT sufficient on its own: `ensure_homebrew` probes
  // /opt/homebrew/bin/brew and /usr/local/bin/brew by ABSOLUTE path, so on a
  // developer's Mac a regressed guard escapes the sandbox and reaches the real
  // Homebrew (observed while validating these tests — the unguarded script
  // reached `brew` and began auto-updating it). So each test is interlocked:
  // it first asserts, from the source, that the fix under test is present and
  // positioned before anything that could shell out. If that assertion fails
  // the test fails THERE and never executes the script. Execution therefore
  // only ever happens against a script already known to refuse early.
  describe('first-run failure honesty (executed, not grepped)', () => {
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');

    /**
     * Build a sandbox: a stub bin dir on an otherwise-empty PATH, plus a
     * throwaway HOME. `dirname` is symlinked in because install.sh resolves its
     * own location before doing anything else.
     * @param {Record<string, string>} stubs - stub name → script body
     * @returns {{ bin: string, home: string }}
     */
    function sandbox(stubs) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-sh-'));
      const bin = path.join(root, 'bin');
      const home = path.join(root, 'home');
      fs.mkdirSync(bin);
      fs.mkdirSync(home);
      for (const real of ['dirname']) {
        const found = ['/usr/bin', '/bin'].map((d) => path.join(d, real)).find((p) => fs.existsSync(p));
        if (found) fs.symlinkSync(found, path.join(bin, real));
      }
      for (const [name, body] of Object.entries(stubs)) {
        const p = path.join(bin, name);
        fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
        fs.chmodSync(p, 0o755);
      }
      return { bin, home };
    }

    /**
     * Run install.sh in a sandbox, returning its combined output and exit code.
     * @param {{ bin: string, home: string }} box
     * @returns {{ code: number, output: string }}
     */
    function runInstall(box) {
      try {
        // Spawn the interpreter by absolute path: the sandbox PATH deliberately
        // has no bash, and resolving it through that PATH would fail to spawn
        // (exit status null) rather than run the script under test.
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

    it('refuses to run on a non-Darwin platform instead of bootstrapping Homebrew (#614)', () => {
      // Without the guard the script plows past the platform check into a
      // Linuxbrew bootstrap and on toward launchd steps that cannot work,
      // handing a Linux user a partial install instead of the honest refusal
      // the README already documents.

      // Safety interlock (see the describe comment): the guard must exist and
      // precede every shell-out, or we do not run the script at all.
      const guardAt = script.search(/if \[ "\$\(uname -s\)" != "Darwin" \]/);
      assert.notEqual(guardAt, -1, 'the platform guard must exist');
      const firstShellOut = Math.min(
        ...[/\bcurl\b/, /ensure_homebrew\b/, /\bbrew\b/]
          .map((re) => script.search(re))
          .filter((i) => i !== -1)
      );
      assert.ok(guardAt < firstShellOut,
        'the platform guard must come before anything that shells out, or a regression would run the real Homebrew');

      const box = sandbox({
        uname: 'echo Linux',
        curl: 'echo "STUB CURL SHOULD NOT RUN" >&2; exit 99'
      });
      const { code, output } = runInstall(box);

      assert.equal(code, 1, 'must exit non-zero on a non-macOS platform');
      assert.match(output, /requires macOS/i, 'must say plainly that macOS is required');
      assert.doesNotMatch(output, /Homebrew|brew\.sh/i,
        'must refuse BEFORE any Homebrew bootstrap — the refusal is the whole point');
      assert.doesNotMatch(output, /STUB CURL SHOULD NOT RUN/,
        'must not reach any network call');
    });

    it('reports a failed installer download as a download failure, not a PATH problem (#615)', () => {
      // A failed `curl` inside `bash -c "$(curl …)"` yields an empty script,
      // `bash -c ""` exits 0, and the guard never fires — so the script used to
      // blame PATH for a Homebrew that was never installed. That advice loops
      // forever: re-running reproduces it exactly.

      // Safety interlock (see the describe comment): without the two-step
      // download the script falls through to the real Homebrew probe, so refuse
      // to execute unless the capture-then-run shape is present.
      assert.match(script, /brew_installer="\$\(curl/,
        'the installer must be captured before it is executed, or a regression would reach the real Homebrew');

      const box = sandbox({
        uname: 'echo Darwin',
        curl: 'exit 6' // curl(6) — could not resolve host; writes nothing
      });
      const { code, output } = runInstall(box);

      assert.equal(code, 1, 'must fail when the installer cannot be downloaded');
      assert.match(output, /could not download the Homebrew installer/i,
        'must name the real failure: the download');
      assert.doesNotMatch(output, /not on PATH/i,
        'must NOT blame PATH — Homebrew was never installed, and that advice sends the user in a circle');
    });

    it('refuses to execute an empty installer payload (#615)', () => {
      // The subtler half of the same defect: curl exits 0 on a 200 response
      // with an empty body (a captive portal, a proxy error page stripped to
      // nothing), so the download guard passes and we would again run
      // `bash -c ""` — succeeding at nothing and then blaming PATH. Success
      // plus an empty payload must still be refused.
      assert.match(script, /\[ -n "\$brew_installer" \]/,
        'the empty-payload guard must exist before this test runs the script');

      const box = sandbox({
        uname: 'echo Darwin',
        curl: 'exit 0' // succeeds, writes nothing
      });
      const { code, output } = runInstall(box);

      assert.equal(code, 1, 'an empty installer payload must fail');
      assert.match(output, /empty/i, 'must say the payload was empty');
      assert.doesNotMatch(output, /not on PATH/i,
        'must not fall through to the PATH diagnosis');
    });

    it('reports a failing installer as an installer failure (#615)', () => {
      // The third branch: the download succeeded and the payload is non-empty,
      // but running it fails. Distinguishing this from the two above is the
      // whole point of splitting the steps — all three used to collapse into
      // the same wrong PATH diagnosis.
      const box = sandbox({
        uname: 'echo Darwin',
        curl: 'echo "exit 1" ' // a valid, non-empty script that fails when run
      });
      const { code, output } = runInstall(box);

      assert.equal(code, 1, 'a failing installer must fail the script');
      assert.match(output, /Homebrew installer failed/i,
        'must name the installer as what failed');
      assert.doesNotMatch(output, /could not download/i,
        'must not report a download problem — the download succeeded');
    });
  });

  describe('server plist stderr breadcrumb (#324)', () => {
    const plist = fs.readFileSync(
      path.join(__dirname, '..', 'deploy', 'com.tangleclaw.server.plist'),
      'utf8'
    );
    it('should capture server stderr to a log file, not /dev/null', () => {
      const m = plist.match(/<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/);
      assert.ok(m, 'StandardErrorPath must be present');
      assert.notEqual(m[1], '/dev/null', 'server stderr must not be discarded — a silent startup hang left no breadcrumb (#324)');
      assert.match(m[1], /\.tangleclaw\/logs\//, 'stderr should land in the TangleClaw logs dir');
      assert.match(m[1], /^__HOME__\//, 'path must use the __HOME__ placeholder so install.sh substitutes it');
    });
  });
});
