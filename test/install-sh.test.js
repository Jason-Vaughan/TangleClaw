'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'deploy', 'install.sh');

// Sandbox roots created by the executed tests, removed once the file finishes.
const sandboxRoots = [];
after(() => {
  for (const root of sandboxRoots) fs.rmSync(root, { recursive: true, force: true });
});

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
      // Case-insensitive on the SOURCE because the predicate itself now folds
      // case (macOS filesystems are case-insensitive, so ~/documents is the same
      // protected directory) and its arms are spelled in lower case. The claim
      // being pinned is "all three roots are checked, anchored on $HOME" — not
      // how they are spelled. What each root actually classifies is executed,
      // not grepped, in the projects-directory describe below.
      for (const root of ['documents', 'desktop', 'downloads']) {
        assert.match(script, new RegExp(`\\$\\{?_?tcc_home\\}?/${root}/|\\$HOME/${root}/`, 'i'),
          `must check the ${root} root, anchored on the installing user's home`);
      }
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
      assert.ok(/TCC_PROJECTS_PROTECTED=""/.test(script), 'TCC_PROJECTS_PROTECTED must be initialized');
      // PROJECTS_DIR is assigned inside the Darwin branch but read again in the
      // completion summary, where the guard is a *different* variable. Under
      // `set -u` that is a fatal error the moment the two disagree.
      assert.ok(/^PROJECTS_DIR=""/m.test(script), 'PROJECTS_DIR must be initialized for set -u safety');
    });
  });

  // The projects directory is a different path from the repo and fails in a
  // different way, so it needs its own coverage. The repo case hangs node at
  // startup and the health check catches it; a protected PROJECTS directory
  // lets the install succeed — health check included — and then wedges the
  // server on the first request that enumerates projects.
  //
  // These execute the real decision functions out of the real file rather than
  // grepping for their text. A source-shape assertion cannot tell a working
  // classifier from one that answers "safe" for everything, and the specific
  // way this guard dies quietly is an unexpanded "~" matching no case arm.
  // Running it is also safe in a way running the installer is not: both
  // functions are pure string logic that shell out to nothing.
  describe('macOS TCC preflight — projects directory (#859, executed not grepped)', () => {
    const { execFileSync } = require('node:child_process');

    /**
     * Extract shell functions from install.sh and run an expression against
     * them, with HOME pinned so the results are machine-independent.
     * @param {string} fakeHome - value to use for $HOME
     * @param {string} expr - shell expression evaluated after the functions load
     * @returns {string} trimmed stdout
     */
    function runShellFn(fakeHome, expr) {
      const fns = ['tcc_protected_path', 'expand_tilde']
        .map((name) => {
          const m = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
          assert.ok(m, `${name}() must be defined as a top-level shell function`);
          return m[0];
        })
        .join('\n');
      return execFileSync('/bin/bash', ['-c', `HOME=${JSON.stringify(fakeHome)}\n${fns}\n${expr}`], {
        encoding: 'utf8'
      }).trim();
    }

    /** @param {string} p @returns {boolean} */
    const isProtected = (p) =>
      runShellFn('/Users/tester', `tcc_protected_path ${JSON.stringify(p)} && echo YES || echo NO`) === 'YES';

    it('classifies every TCC-protected root, and leaves other paths alone', () => {
      for (const p of [
        '/Users/tester/Documents/Projects',
        '/Users/tester/Desktop/Projects',
        '/Users/tester/Downloads/Projects',
        '/Users/tester/Documents/Projects/'      // trailing slash must not change the answer
      ]) {
        assert.ok(isProtected(p), `${p} must be classified TCC-protected`);
      }
      for (const p of [
        '/Users/tester/tc/TangleClaw',
        '/Users/tester/Projects',
        '/opt/tangleclaw',
        '/Users/tester/DocumentsElsewhere/Projects'  // prefix-similar, must NOT match
      ]) {
        assert.ok(!isProtected(p), `${p} must NOT be classified TCC-protected`);
      }
    });

    it('classifies the same folder however it was capitalised', () => {
      // macOS filesystems are case-insensitive by default, so ~/documents is
      // the SAME directory TCC protects. A case-sensitive match reports it safe
      // — the identical quiet-wrong-answer failure the tilde case below exists
      // for. The wizard learned this first; this is the sibling call site.
      for (const p of [
        '/Users/tester/documents/Projects',
        '/Users/tester/DOCUMENTS/Projects',
        '/Users/tester/desktop/Projects',
        '/Users/tester/DownLoads/Projects'
      ]) {
        assert.ok(isProtected(p), `${p} must be classified TCC-protected`);
      }
      // Folding case must not fold path boundaries away with it.
      assert.ok(!isProtected('/Users/tester/documentselsewhere/Projects'),
        'a prefix-similar folder is still a different folder in any casing');
    });

    it('does not confuse another user\'s Documents with this user\'s', () => {
      // The arms are anchored on $HOME; a rewrite to a bare */Documents/* glob
      // would pass every test above and fail this one.
      assert.ok(!isProtected('/Users/someone-else/Documents/Projects'),
        'only the installing user\'s protected folders count');
    });

    it('expands a stored "~/" path before classifying it — the quiet-wrong-answer case', () => {
      // This is the mutation the guard exists to survive. lib/store.js ships
      // projectsDir as the literal "~/Documents/Projects"; classified without
      // expansion it matches nothing and reports safe, so the default config —
      // the one case that matters most — would silently skip the warning.
      assert.equal(runShellFn('/Users/tester', 'expand_tilde "~/Documents/Projects"'),
        '/Users/tester/Documents/Projects');
      assert.equal(runShellFn('/Users/tester', 'expand_tilde "~"'), '/Users/tester');
      assert.equal(runShellFn('/Users/tester', 'expand_tilde "/already/absolute"'), '/already/absolute');
      // A literal tilde must NOT be treated as protected before expansion...
      assert.ok(!isProtected('~/Documents/Projects'),
        'an unexpanded tilde matches no case arm — this is why expansion must happen first');
      // ...and MUST be once expanded. Composition is the actual contract.
      assert.equal(
        runShellFn('/Users/tester',
          'tcc_protected_path "$(expand_tilde "~/Documents/Projects")" && echo YES || echo NO'),
        'YES',
        'the shipped default projectsDir must be classified TCC-protected once expanded'
      );
    });

    it('reads projectsDir from config and falls back to the shipped default', () => {
      assert.ok(/PROJECTS_DIR_RAW="\$HOME\/Documents\/Projects"/.test(script),
        'must default to the same path lib/store.js ships as projectsDir');
      assert.ok(/c\.projectsDir/.test(script), 'must read projectsDir out of config.json when it exists');
      assert.ok(/PROJECTS_DIR="\$\(expand_tilde "\$PROJECTS_DIR_RAW"\)"/.test(script),
        'the config value must go through expand_tilde before classification');
    });

    it('warns that the install can SUCCEED and the server still stop responding', () => {
      // The warning's whole value is contradicting the health check, which
      // passes in this scenario. A generic "check Full Disk Access" line would
      // read as the repo warning and be dismissed.
      assert.ok(/pass its health check/.test(script),
        'must say the install can pass its health check and still be broken');
      assert.ok(/lists projects/.test(script), 'must name the trigger (listing projects)');
      assert.ok(/no error in any log/.test(script), 'must warn there will be no log evidence');
    });

    it('repeats the projects warning in the completion summary', () => {
      // The up-front notice is printed before dependency installation, which on
      // a bare machine emits thousands of lines and scrolls it out of view.
      const summaryAt = script.search(/installed successfully!/);
      const repeatAt = script.search(/HEADS-UP: the projects directory/);
      assert.notEqual(repeatAt, -1, 'the projects warning must be repeated after the summary banner');
      assert.ok(repeatAt > summaryAt, 'the repeat must come AFTER the completion banner, where it is read');
    });

    it('warns that the Full Disk Access path is version-pinned and dies on brew upgrade', () => {
      // `realpathSync` resolves /opt/homebrew/bin/node to
      // /opt/homebrew/Cellar/node@22/<version>/bin/node. Resolving is CORRECT --
      // macOS keys the grant to the real binary, not the symlink -- but the path
      // moves on the next `brew upgrade node`, silently revoking a grant the
      // operator believes is still in place. Telling them the path without
      // telling them it expires is a fix with a hidden shelf life.
      assert.ok(/brew upgrade node/.test(script),
        'must warn that upgrading node moves the granted path');
      assert.ok(/REAL binary/.test(script),
        'must say the resolved path is the real binary, not the symlink');
    });

    it('never calls the login-bearing cutover "optional", and always prints BOTH commands', () => {
      // The wording this replaced produced a live unprotected install: it
      // advertised `ingress-cutover --to caddy` as an optional one-liner, which
      // configures an ingress with NO password and prints a green health check.
      // docs/setup-guide.md carries the same warning in bold; the installer's
      // own closing text was still contradicting it.
      const closing = script.slice(script.search(/installed successfully!/));
      assert.doesNotMatch(closing, /Caddy ingress \(optional\)/,
        'the step that installs the login must never be labelled optional');
      assert.match(closing, /reset-admin\.js --create-gate/,
        'the completion text must name the command that actually creates the login');
      assert.match(closing, /ingress-cutover\.js --to caddy/,
        'and the cutover that must precede it');
      const cutoverAt = closing.search(/ingress-cutover\.js --to caddy/);
      const gateAt = closing.search(/reset-admin\.js --create-gate/);
      assert.ok(cutoverAt < gateAt,
        'order matters: --create-gate exits when no Caddyfile exists yet');
    });

    it('does not claim a major version it cannot know', () => {
      assert.ok(!/TangleClaw v3 installed/.test(script),
        'the completion banner must not hardcode a stale major version');
    });
  });

  // These tests run the real script rather than grepping it, because the
  // defects were failures of BEHAVIOR that a source-shape assertion would have
  // happily matched: the script "handled" a failed download and "supported"
  // Linux right up until you ran it.
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
      sandboxRoots.push(root);
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

      // Safety interlock (see the describe comment): containment for THIS path
      // rests on the execution guard exiting non-zero. Regressed to a
      // non-exiting form, `||` suppresses `set -e`, control falls through to
      // the absolute-path brew probe and on to a real `brew install node`.
      assert.match(script, /\/bin\/bash -c "\$brew_installer" \\\n\s*\|\| \{[^}]*exit 1/,
        'the installer execution must exit non-zero on failure, or a regression would reach the real Homebrew');

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

  // #1900: on a caddy-mode host install.sh rewrote the ttyd plist for DIRECT
  // mode and restarted it, cutting the dashboard off with a 502. The refusal
  // must happen before ANY mutation, so these tests run the real script and
  // compare the sandbox HOME byte for byte before and after.
  describe('ingress-mode guard (#1900, executed)', () => {
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');

    /**
     * Build a sandbox whose PATH holds the real node and `which` (the guard
     * parses the config with node) and stubs for every tool that mutates the
     * machine. Each stub records its call in `calls.log` and fails, so a guard
     * that let the script through is visible and still contained. A `brew` on
     * PATH also keeps ensure_homebrew away from its absolute-path probes.
     * @param {string|null} configBody - config.json contents, or null for none
     * @returns {{ bin: string, home: string, calls: string }}
     */
    function sandbox(configBody) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-guard-'));
      sandboxRoots.push(root);
      const bin = path.join(root, 'bin');
      const home = path.join(root, 'home');
      const calls = path.join(root, 'calls.log');
      fs.mkdirSync(bin);
      fs.mkdirSync(home);
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      for (const real of ['dirname', 'which']) {
        const found = ['/usr/bin', '/bin'].map((d) => path.join(d, real)).find((p) => fs.existsSync(p));
        if (found) fs.symlinkSync(found, path.join(bin, real));
      }
      const stubs = { uname: 'echo Darwin' };
      // ttyd, tmux, mkcert and caddy are deliberately NOT stubbed: an absent ttyd
      // sends ensure_dep to the failing brew stub, which stops the script before
      // it can reach the real ttyd-runtime.js provision build.
      for (const name of ['brew', 'curl', 'launchctl']) {
        stubs[name] = `echo "${name} $*" >> "${calls}"; exit 99`;
      }
      for (const [name, body] of Object.entries(stubs)) {
        const p = path.join(bin, name);
        fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
        fs.chmodSync(p, 0o755);
      }
      if (configBody !== null) {
        fs.mkdirSync(path.join(home, '.tangleclaw'));
        fs.writeFileSync(path.join(home, '.tangleclaw', 'config.json'), configBody);
      }
      return { bin, home, calls };
    }

    /**
     * Snapshot every file under a directory as relative path → contents.
     * @param {string} dir
     * @returns {Record<string, string>}
     */
    function snapshot(dir) {
      const out = {};
      for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        const full = path.join(entry.parentPath || entry.path, entry.name);
        out[path.relative(dir, full)] = entry.isFile() ? fs.readFileSync(full, 'utf8') : '<dir>';
      }
      return out;
    }

    /**
     * Run install.sh in the sandbox.
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

    /**
     * Read the stub call log, empty when no stub ran.
     * @param {{ calls: string }} box
     * @returns {string}
     */
    function stubCalls(box) {
      return fs.existsSync(box.calls) ? fs.readFileSync(box.calls, 'utf8') : '';
    }

    it('is positioned before every dependency install, build, plist write and restart', () => {
      // Safety interlock: the executed tests below rely on the script stopping
      // at the guard. If it moved later, fail here instead of running further.
      const guardAt = script.search(/if \[ "\$INGRESS_MODE" = "caddy" \]/);
      assert.notEqual(guardAt, -1, 'the ingress-mode guard must exist');
      for (const re of [/ensure_dep ttyd/, /ttyd-runtime\.js" provision/, /mkdir -p "\$LAUNCH_AGENTS_DIR"/,
        /> "\$\{LAUNCH_AGENTS_DIR\}\/\$\{TTYD_PLIST\}"/, /launchctl unload/, /launchctl load/, /cp "\$TMUX_CONF_SRC"/]) {
        const at = script.search(re);
        assert.notEqual(at, -1, `expected to find ${re}`);
        assert.ok(guardAt < at, `the guard must precede ${re}`);
      }
    });

    // #1901 replaced the caddy-mode refusal with a refresh. What it protected (no
    // mutation before it is known to be safe) is pinned more strictly by the
    // preflight tests in 'caddy-mode refresh (#1901, executed)' below.

    it('refuses an unparseable config with zero mutation rather than guessing direct', () => {
      const box = sandbox('{ "ingressMode": "caddy", ');
      const before = snapshot(box.home);
      const { code, output } = runInstall(box);

      assert.equal(code, 1, 'must exit non-zero when the mode cannot be read');
      assert.deepEqual(snapshot(box.home), before, 'HOME must be byte-identical after the refusal');
      assert.equal(stubCalls(box), '', 'no mutating tool may run');
      assert.match(output, /cannot read the ingress mode/);
    });

    for (const [label, body] of [
      ['a persisted direct mode', JSON.stringify({ ingressMode: 'direct' })],
      ['a config without ingressMode', JSON.stringify({ httpsEnabled: false })],
      ['no config (first install)', null]
    ]) {
      it(`lets ${label} through to the dependency step`, () => {
        // Safety interlock: the failing brew stub must stop the script at the
        // ttyd dependency, before the real runtime build.
        // The direct path's build is the TTYD_PATH line. The caddy-only bootstrap
        // (#1901) also names provision, earlier, but a direct-mode run never
        // reaches it, so the interlock guards the line this test could run.
        assert.ok(script.search(/ensure_dep ttyd/) < script.search(/TTYD_PATH="\$\(node "\$\{REPO_DIR\}\/scripts\/ttyd-runtime\.js" provision/),
          'ensure_dep ttyd must precede the runtime build, or this test would run it');
        const box = sandbox(body);
        const { code, output } = runInstall(box);

        assert.doesNotMatch(output, /ingress mode is 'caddy'|cannot read the ingress mode/,
          'must not refuse a direct-mode host');
        // The stubbed brew fails the first dependency install, which proves the
        // script got past the guard and stops it there.
        assert.match(stubCalls(box), /^brew install ttyd/m, 'must proceed to the ttyd dependency');
        assert.equal(code, 1);
        assert.doesNotMatch(output, /Caddy mode: checking/, 'a direct-mode run never runs the caddy preflight');
      });
    }
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

// #1901: on a caddy-mode host install.sh refreshes what it owns and hands the
// ingress to the cutover, instead of refusing. Run for real in a sandbox:
// `launchctl`, `curl`, `brew`, the dependency binaries and `sleep` are stubs
// that log, and a `node` wrapper hands `scripts/ingress-cutover.js` and
// `scripts/ttyd-runtime.js` to a scripted fake while every other node call runs
// for real. Nothing here can reach this machine's launchd or its live server.
describe('deploy/install.sh caddy-mode refresh (#1901, executed)', () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');

  // The fake cutover / runtime. Reads the scenario, logs its call, and answers
  // the way the real script would for that scenario.
  const FAKE = `
    const fs = require('fs');
    const [, , which, script, ...args] = process.argv;
    const box = process.env.TC_FAKE_BOX;
    const scenario = JSON.parse(fs.readFileSync(box + '/scenario.json', 'utf8'));
    fs.appendFileSync(box + '/calls.log', which + ' ' + args.join(' ') + '\\n');
    const resultAt = args.indexOf('--result-file');
    const resultFile = resultAt >= 0 ? args[resultAt + 1] : null;
    if (which === 'runtime') {
      if (scenario.provisionFails) { console.error('build failed'); process.exit(1); }
      process.stdout.write(box + '/home/.tangleclaw/bin/ttyd\\n');
      process.exit(0);
    }
    if (args.includes('--dry-run')) {
      const n = fs.existsSync(box + '/dryruns') ? Number(fs.readFileSync(box + '/dryruns', 'utf8')) : 0;
      fs.writeFileSync(box + '/dryruns', String(n + 1));
      const step = scenario.dryRuns[Math.min(n, scenario.dryRuns.length - 1)];
      if (step.code && resultFile) fs.writeFileSync(resultFile, JSON.stringify({ ok: false, code: step.code }));
      if (step.status !== 0) console.error('fake dry run: ' + (step.reason || step.code || 'refuse'));
      process.exit(step.status);
    }
    const real = scenario.cutover || { status: 0, ok: true, code: 'ok', healthOk: true };
    fs.writeFileSync(resultFile, JSON.stringify({ ok: real.ok, code: real.code, healthOk: real.healthOk,
      healthUrl: 'https://localhost:8443/api/health', gateNote: real.gateNote || null,
      gateChanges: real.gateChanges || [] }));
    process.exit(real.status);
  `;

  /**
   * Build a caddy-mode sandbox.
   * @param {object} scenario - What the fake cutover, runtime and curl answer.
   * @returns {{root: string, bin: string, home: string}}
   */
  function sandbox(scenario) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-caddy-'));
    sandboxRoots.push(root);
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(home, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tangleclaw', 'config.json'), JSON.stringify({ ingressMode: 'caddy' }));
    fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(scenario));
    fs.writeFileSync(path.join(root, 'fake.js'), FAKE);
    const calls = path.join(root, 'calls.log');
    const stubs = {
      node: `case "$1" in\n  */scripts/ingress-cutover.js) shift; exec "${process.execPath}" "${root}/fake.js" cutover x "$@";;\n`
        + `  */scripts/ttyd-runtime.js) shift; exec "${process.execPath}" "${root}/fake.js" runtime x "$@";;\nesac\n`
        + `exec "${process.execPath}" "$@"`,
      uname: 'echo Darwin',
      sleep: 'exit 0',
      launchctl: `echo "launchctl $*" >> "${calls}"`,
      brew: `echo "brew $*" >> "${calls}"; exit 99`,
      curl: `url=""; for a in "$@"; do url="$a"; done\necho "curl $url" >> "${calls}"\n`
        + `case "$url" in *127.0.0.1*) printf '%s' "${scenario.restart1 || '200'}";; *) printf '%s' "${scenario.caddyHealth || '200'}";; esac`,
      tmux: `echo "tmux $*" >> "${calls}"; exit 1`,
      mkcert: `echo "mkcert $*" >> "${calls}"`,
      ttyd: 'exit 0',
      caddy: 'exit 0'
    };
    for (const [name, body] of Object.entries(stubs)) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    return { root, bin, home };
  }

  /**
   * Run install.sh in the sandbox.
   * @param {{bin: string, home: string, root: string}} box
   * @returns {{code: number, output: string}}
   */
  function runInstall(box) {
    try {
      const output = execFileSync('/bin/bash', [SCRIPT_PATH], {
        env: { PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.home, TMPDIR: box.root, TC_FAKE_BOX: box.root },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000
      });
      return { code: 0, output };
    } catch (err) {
      return { code: err.status, output: `${err.stdout || ''}${err.stderr || ''}` };
    }
  }

  /** @returns {string[]} The logged calls, one per line. */
  const callsOf = (box) => (fs.existsSync(path.join(box.root, 'calls.log'))
    ? fs.readFileSync(path.join(box.root, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : []);

  /**
   * Snapshot every file under HOME as relative path → contents.
   * @param {string} dir
   * @returns {Record<string, string>}
   */
  function snapshot(dir) {
    const out = {};
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const full = path.join(entry.parentPath || entry.path, entry.name);
      out[path.relative(dir, full)] = entry.isFile() ? fs.readFileSync(full, 'utf8') : '<dir>';
    }
    return out;
  }

  /** Index of the first call matching `re`, or -1. */
  const firstCall = (calls, re) => calls.findIndex((c) => re.test(c));

  const CLEAN = { dryRuns: [{ status: 0 }] };

  it('the sandbox shadows every tool that could touch this machine', () => {
    const box = sandbox(CLEAN);
    const env = { PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.home };
    for (const tool of ['launchctl', 'curl', 'brew', 'tmux', 'node', 'mkcert', 'caddy', 'ttyd']) {
      const where = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { env, encoding: 'utf8' }).trim();
      assert.equal(where, path.join(box.bin, tool), `${tool} must resolve to the sandbox stub`);
    }
  });

  it('refreshes the server plist, tmux.conf and attach script, writes NO ttyd plist, and confirms both restarts', () => {
    const box = sandbox(CLEAN);
    const { code, output } = runInstall(box);
    assert.equal(code, 0, output);

    const agents = path.join(box.home, 'Library', 'LaunchAgents');
    assert.ok(fs.existsSync(path.join(agents, 'com.tangleclaw.server.plist')), 'the server plist is refreshed');
    assert.ok(!fs.existsSync(path.join(agents, 'com.tangleclaw.ttyd.plist')),
      'caddy mode must never write the TCP ttyd plist, which cuts the dashboard off (#1900)');
    assert.equal(fs.readFileSync(path.join(box.home, '.tmux.conf'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '..', 'deploy', 'tmux.conf'), 'utf8'));
    assert.ok(fs.existsSync(path.join(box.home, '.tangleclaw', 'deploy', 'ttyd-attach.sh')));

    assert.match(output, /Restart 1 of 2 confirmed: the server is up on 127\.0\.0\.1:3102/);
    assert.match(output, /Restart 2 of 2: the ingress cutover re-applies the ttyd and Caddy plists/);
    assert.match(output, /Restart 2 of 2 confirmed: healthy through Caddy \(https:\/\/localhost:8443\/api\/health\)/);
    assert.doesNotMatch(output, /Put a password and TLS in front of it/, 'a caddy host already has its gate');
  });

  it('runs the preflight before anything else, then restarts in order: server reload, health, cutover', () => {
    const box = sandbox(CLEAN);
    runInstall(box);
    const calls = callsOf(box);
    assert.match(calls[0], /^cutover --to caddy --dry-run --result-file /, 'the first call is the preflight');
    const reload = firstCall(calls, /^launchctl load .*com\.tangleclaw\.server\.plist/);
    const health = firstCall(calls, /^curl http:\/\/127\.0\.0\.1:3102\/api\/health/);
    const real = firstCall(calls, /^cutover --to caddy --result-file /);
    assert.ok(reload > 0 && reload < health && health < real, calls.join('\n'));
    assert.ok(!calls.some((c) => /^launchctl .*(ttyd|caddy)\.plist/.test(c)),
      'install.sh never loads the ttyd or Caddy plist itself in caddy mode; the cutover does');
  });

  it('a predicted refusal (3) aborts with HOME byte-identical and nothing but the preflight run', () => {
    const box = sandbox({ dryRuns: [{ status: 3, reason: 'the Caddyfile is hand-edited' }] });
    const before = snapshot(box.home);
    const { code, output } = runInstall(box);
    assert.equal(code, 1);
    assert.deepEqual(snapshot(box.home), before, 'HOME must be byte-identical');
    assert.deepEqual(callsOf(box).map((c) => c.split(' ').slice(0, 4).join(' ')),
      ['cutover --to caddy --dry-run'], 'no brew, launchctl, provision or real cutover');
    assert.match(output, /the Caddyfile is hand-edited/, 'the cutover\'s reason reaches the operator');
    assert.match(output, /the ingress cutover would refuse \(reason above\), so nothing was refreshed/);
    assert.match(output, /Nothing was changed/);
  });

  it('any other preflight failure aborts the same way, without the bootstrap', () => {
    const box = sandbox({ dryRuns: [{ status: 1, code: 'failed', reason: 'generator error' }] });
    const before = snapshot(box.home);
    const { code, output } = runInstall(box);
    assert.equal(code, 1);
    assert.deepEqual(snapshot(box.home), before);
    assert.equal(callsOf(box).length, 1, 'only the preflight ran');
    assert.match(output, /preflight failed \(status 1; reason above\)/);
  });

  it('a stale runtime (typed code) bootstraps ONLY the runtime, re-runs the full preflight, then proceeds', () => {
    const box = sandbox({ dryRuns: [{ status: 1, code: 'ttyd-runtime-unavailable' }, { status: 0 }] });
    const { code, output } = runInstall(box);
    assert.equal(code, 0, output);
    const calls = callsOf(box);
    assert.match(calls[0], /^cutover --to caddy --dry-run/);
    assert.match(calls[1], /^runtime provision --base-dir /, 'the bootstrap provisions the runtime');
    assert.match(calls[2], /^cutover --to caddy --dry-run/, 'then the COMPLETE preflight runs again');
    assert.ok(!calls.slice(0, 3).some((c) => /^(brew|launchctl|mkcert|tmux)/.test(c)),
      'nothing but the runtime is touched before the preflight passes');
    assert.match(output, /Provisioning it into ~\/\.tangleclaw\/bin/);
  });

  it('a bootstrap whose re-run preflight refuses says the new runtime is in place but not in use', () => {
    const box = sandbox({ dryRuns: [{ status: 1, code: 'ttyd-runtime-unavailable' }, { status: 3, reason: 'hand-edited' }] });
    const before = snapshot(box.home);
    const { code, output } = runInstall(box);
    assert.equal(code, 1);
    assert.deepEqual(snapshot(box.home), before, 'the (faked) runtime write is the only one allowed, and it is faked');
    assert.deepEqual(callsOf(box).map((c) => c.split(' ')[0] + ' ' + c.split(' ')[1]),
      ['cutover --to', 'runtime provision', 'cutover --to']);
    assert.match(output, /A new ttyd runtime WAS provisioned into ~\/\.tangleclaw\/bin\. It is not in use/);
  });

  it('a bootstrap that cannot provision stops there', () => {
    const box = sandbox({ dryRuns: [{ status: 1, code: 'ttyd-runtime-unavailable' }], provisionFails: true });
    const { code, output } = runInstall(box);
    assert.equal(code, 1);
    assert.equal(callsOf(box).length, 2, 'no second preflight and nothing else');
    assert.match(output, /the ttyd runtime could not be provisioned/);
  });

  it('a server that does not come back after restart 1 stops before the cutover, and says the gate is intact', () => {
    const box = sandbox({ ...CLEAN, restart1: '000' });
    const { code, output } = runInstall(box);
    assert.equal(code, 1);
    const calls = callsOf(box);
    assert.equal(calls.filter((c) => /^curl http:\/\/127\.0\.0\.1:3102/.test(c)).length, 30, 'bounded: 30 probes');
    assert.ok(!calls.some((c) => /^cutover --to caddy --result-file/.test(c)), 'the cutover is not run');
    assert.match(output, /did not come back after restart 1 of 2/);
    assert.match(output, /Caddy and its login gate are unchanged/);
  });

  it('a failed cutover exits non-zero with its code', () => {
    const box = sandbox({ ...CLEAN, cutover: { status: 1, ok: false, code: 'validate-failed', healthOk: false } });
    const { code, output } = runInstall(box);
    assert.equal(code, 1);
    assert.match(output, /the ingress cutover failed \(status 1, code validate-failed/);
  });

  it('confirms restart 2 itself when the cutover\'s own short health poll did not', () => {
    const box = sandbox({ ...CLEAN, cutover: { status: 0, ok: true, code: 'ok', healthOk: false } });
    const { code, output } = runInstall(box);
    assert.equal(code, 0, output);
    assert.ok(callsOf(box).some((c) => c === 'curl https://localhost:8443/api/health'), 'install.sh polls through Caddy');
    assert.match(output, /Restart 2 of 2 confirmed/);
  });

  it('every surface that tells an operator how to refresh deploy assets names install.sh for both modes', () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(read('public/update-beacon.js'), /run \.\/deploy\/install\.sh '\s*\+ '\(it works in both ingress modes/);
    assert.match(read('lib/update-applier.js'), /runs `\.\/deploy\/install\.sh`, which handles both ingress modes/);
    const readme = read('README.md');
    assert.match(readme, /It works in both ingress modes:/);
    for (const [f, text] of [['README.md', readme], ['docs/configuration-reference.md', read('docs/configuration-reference.md')],
      ['docs/runbooks/roll-out-the-owned-ttyd.md', read('docs/runbooks/roll-out-the-owned-ttyd.md')],
      ['docs/user-guide.md', read('docs/user-guide.md')], ['lib/ttyd-runtime.js', read('lib/ttyd-runtime.js')]]) {
      assert.doesNotMatch(text, /no caddy-mode refresh yet|never deploy\/install\.sh|on a caddy-mode host it refuses/,
        `${f} still sends caddy-mode operators to the old refusal`);
    }
  });

  it('names the gate that remains in the cutover\'s own words, and never claims a Caddy password was kept', () => {
    const box = sandbox({ ...CLEAN, cutover: { status: 0, ok: true, code: 'ok', healthOk: true,
      gateNote: "Caddy's basic_auth is NOT written — TangleClaw's login (armed) is the gate for every site",
      gateChanges: ["Caddy's basic_auth (1 user) will be REMOVED: the regenerated Caddyfile carries none"] } });
    const { code, output } = runInstall(box);
    assert.equal(code, 0, output);
    assert.match(output, /Login gate now: Caddy's basic_auth is NOT written — TangleClaw's login \(armed\) is the gate for every site/);
    assert.match(output, /Gate change: {4}Caddy's basic_auth \(1 user\) will be REMOVED/);
    assert.doesNotMatch(output, /gate was kept/i, 'an existing Caddy gate must never be claimed as preserved');
    assert.match(output, /which login gate is in force is above/);
  });

  it('leaves none of the cutover\'s scratch result files behind, whether it succeeds or refuses', () => {
    const leftovers = (box) => fs.readdirSync(box.root).filter((f) => /^tc-install-(preflight|cutover)\./.test(f));
    const ok = sandbox(CLEAN);
    assert.equal(runInstall(ok).code, 0);
    assert.deepEqual(leftovers(ok), []);
    const refused = sandbox({ dryRuns: [{ status: 3, reason: 'hand-edited' }] });
    assert.equal(runInstall(refused).code, 1, 'the cleanup keeps the run\'s own exit status');
    assert.deepEqual(leftovers(refused), []);
  });

  it('fails, bounded, when restart 2 never confirms healthy', () => {
    const box = sandbox({ ...CLEAN, caddyHealth: '502', cutover: { status: 0, ok: true, code: 'ok', healthOk: false } });
    const { code, output } = runInstall(box);
    assert.equal(code, 1);
    assert.equal(callsOf(box).filter((c) => c === 'curl https://localhost:8443/api/health').length, 30);
    assert.match(output, /restart 2 of 2 could not be confirmed healthy through Caddy/);
  });

  it('still names the gate now in force, once, when a successful cutover is followed by a health timeout', () => {
    const leftovers = (b) => fs.readdirSync(b.root).filter((f) => /^tc-install-(preflight|cutover)\./.test(f));
    const box = sandbox({ ...CLEAN, caddyHealth: '502', cutover: { status: 0, ok: true, code: 'ok', healthOk: false,
      gateNote: "Caddy's basic_auth is NOT written — TangleClaw's login (armed) is the gate for every site",
      gateChanges: [
        "Caddy's basic_auth (1 user) will be REMOVED: the regenerated Caddyfile carries none",
        'the existing Caddyfile has a `import` directive this tool does not generate; the cutover '
          + 'converges to the canonical config, and anything it provided (a gate included) will NOT be carried over'
      ] } });
    const { code, output } = runInstall(box);
    assert.equal(code, 1, 'the timeout is still a bounded failure');
    assert.equal(callsOf(box).filter((c) => c === 'curl https://localhost:8443/api/health').length, 30);
    assert.match(output, /restart 2 of 2 could not be confirmed healthy through Caddy/);
    const count = (re) => (output.match(re) || []).length;
    assert.equal(count(/Login gate now: Caddy's basic_auth is NOT written — TangleClaw's login \(armed\) is the gate for every site/g), 1);
    assert.equal(count(/Gate change: {4}Caddy's basic_auth \(1 user\) will be REMOVED/g), 1);
    assert.equal(count(/Gate change: {4}the existing Caddyfile has a `import` directive/g), 1);
    assert.doesNotMatch(output, /Restart 2 of 2 confirmed/);
    assert.deepEqual(leftovers(box), [], 'the EXIT trap still removes the result files');
  });
});
