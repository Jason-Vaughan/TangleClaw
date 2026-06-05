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
