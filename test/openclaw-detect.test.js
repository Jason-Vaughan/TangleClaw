'use strict';

// Tests for #306-followup (PR B) — auto-detect an OpenClaw connection's
// instanceDir over SSH. Covers the pure helpers (shape guards, output parsing,
// command build) with a mocked exec, the handler's error/empty/success paths,
// and the frontend wiring (Detect button + handler) via source assertions.

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const detect = require('../lib/openclaw-detect');

const GOOD = { host: '192.168.20.10', sshUser: 'habitat-admin', sshKeyPath: '~/.ssh/genesis_habitat' };

describe('openclaw-detect (#306-followup)', () => {
  describe('unsafeReason', () => {
    it('accepts a well-formed target', () => {
      assert.equal(detect.unsafeReason(GOOD), null);
    });
    it('requires host, sshUser, and sshKeyPath', () => {
      assert.match(detect.unsafeReason({ host: 'h', sshUser: 'u' }), /required/);
      assert.match(detect.unsafeReason(null), /required/);
    });
    it('rejects shell-metacharacter injection in each field', () => {
      assert.match(detect.unsafeReason({ ...GOOD, host: '10.0.0.1; rm -rf /' }), /host/);
      assert.match(detect.unsafeReason({ ...GOOD, sshUser: 'a$(whoami)' }), /sshUser/);
      assert.match(detect.unsafeReason({ ...GOOD, sshKeyPath: '~/.ssh/k`id`' }), /sshKeyPath/);
    });
    it('accepts IPv6 hosts and tailscale names', () => {
      assert.equal(detect.unsafeReason({ ...GOOD, host: 'fd7a::1' }), null);
      assert.equal(detect.unsafeReason({ ...GOOD, host: 'kobold.tail1234.ts.net' }), null);
    });
  });

  describe('parseDirs', () => {
    it('keeps absolute paths, trims, and dedups', () => {
      const out = '/home/jason/workspace/openclaw\n/home/jason/workspace/openclaw\n  /Users/habitat-admin/openclaw  \n';
      assert.deepEqual(detect.parseDirs(out), ['/home/jason/workspace/openclaw', '/Users/habitat-admin/openclaw']);
    });
    it('drops non-absolute noise lines and handles empty/bad input', () => {
      assert.deepEqual(detect.parseDirs('docker not accessible\nopenclaw-* \n'), []);
      assert.deepEqual(detect.parseDirs(''), []);
      assert.deepEqual(detect.parseDirs(null), []);
    });
  });

  describe('_buildSshCmd', () => {
    it('expands a leading ~ in the key path and runs remote sh with no tty', () => {
      const cmd = detect._buildSshCmd(GOOD);
      assert.ok(!cmd.includes('-i "~/.ssh'), 'leading ~ must be expanded to $HOME');
      assert.match(cmd, /ssh -T .*-o BatchMode=yes/);
      assert.match(cmd, /habitat-admin@192\.168\.20\.10 sh$/);
    });
  });

  describe('DISCOVERY_SCRIPT', () => {
    it('uses both the docker compose label and a bounded candidate-path scan', () => {
      assert.match(detect.DISCOVERY_SCRIPT, /com\.docker\.compose\.project\.working_dir/);
      assert.match(detect.DISCOVERY_SCRIPT, /OPENCLAW_IMAGE=/);
      // Bounded scan — must NOT shell out to an unbounded recursive grep.
      assert.doesNotMatch(detect.DISCOVERY_SCRIPT, /grep -r/);
    });
  });

  describe('detectInstanceDir', () => {
    let calls;
    const orig = detect._internal.exec;
    beforeEach(() => { calls = []; });
    afterEach(() => { detect._internal.exec = orig; });

    it('refuses an unsafe target without running ssh', () => {
      detect._internal.exec = (...a) => { calls.push(a); return ''; };
      const r = detect.detectInstanceDir({ ...GOOD, host: 'h;evil' });
      assert.deepEqual(r.dirs, []);
      assert.match(r.error, /host/);
      assert.equal(calls.length, 0, 'ssh must not run for an unsafe target');
    });

    it('feeds the discovery script over stdin and returns parsed dirs', () => {
      detect._internal.exec = (cmd, opts) => {
        calls.push({ cmd, opts });
        return '/Users/habitat-admin/openclaw\n';
      };
      const r = detect.detectInstanceDir(GOOD);
      assert.deepEqual(r.dirs, ['/Users/habitat-admin/openclaw']);
      assert.equal(r.error, null);
      assert.equal(calls[0].opts.input, detect.DISCOVERY_SCRIPT, 'script is passed via stdin, not interpolated');
    });

    it('reports a clean "not found" when discovery yields nothing', () => {
      detect._internal.exec = () => '\n';
      const r = detect.detectInstanceDir(GOOD);
      assert.deepEqual(r.dirs, []);
      assert.match(r.error, /no OpenClaw stack directory found/i);
    });

    it('surfaces an ssh failure as an error without throwing', () => {
      detect._internal.exec = () => { const e = new Error('boom'); e.stderr = 'Permission denied'; throw e; };
      const r = detect.detectInstanceDir(GOOD);
      assert.deepEqual(r.dirs, []);
      assert.match(r.error, /ssh detect failed: Permission denied/);
    });
  });

  describe('frontend wiring (public/ui.js + index.html)', () => {
    let ui, html;
    before(() => {
      ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
      html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    });
    it('renders a Detect button beside the Instance Dir input', () => {
      assert.match(html, /id="ocDetectBtn"/);
      assert.match(html, /class="oc-detect-row"/);
    });
    it('defines detectOcInstanceDir, posts to the detect endpoint, and wires the button', () => {
      assert.match(ui, /async function detectOcInstanceDir\(\)/);
      assert.match(ui, /apiMutate\('\/api\/openclaw\/detect-instance-dir', 'POST'/);
      assert.match(ui, /\$\('ocDetectBtn'\)\.addEventListener\('click', detectOcInstanceDir\)/);
    });
    it('guards on the SSH fields before calling out', () => {
      assert.match(ui, /Fill Host, SSH User, and SSH Key Path first/);
    });
  });
});
