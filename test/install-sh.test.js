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
});
