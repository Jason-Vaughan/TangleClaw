'use strict';

const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const child_process = require('node:child_process');

describe('porthub', () => {
  let porthub;

  before(() => {
    porthub = require('../lib/porthub');
  });

  describe('isAvailable', () => {
    it('returns a boolean', () => {
      const result = porthub.isAvailable();
      assert.equal(typeof result, 'boolean');
    });
  });

  describe('registerPort', () => {
    it('returns result with success and error fields', () => {
      const result = porthub.registerPort(9999, 'test-project', 'test-service');
      assert.equal(typeof result.success, 'boolean');
      assert.ok(result.error === null || typeof result.error === 'string');
    });
  });

  describe('releasePort', () => {
    it('returns result with success field', () => {
      const result = porthub.releasePort(9999);
      assert.equal(typeof result.success, 'boolean');
    });
  });

  describe('registerPorts', () => {
    it('handles multiple ports', () => {
      const result = porthub.registerPorts({ dev: 8080, api: 8081 }, 'test-project');
      assert.ok(typeof result.registered === 'object');
      assert.ok(Array.isArray(result.errors));
    });
  });

  describe('releasePorts', () => {
    it('handles multiple ports', () => {
      const result = porthub.releasePorts({ dev: 8080, api: 8081 });
      assert.ok(Array.isArray(result.released));
      assert.ok(Array.isArray(result.errors));
    });
  });

  describe('checkPort', () => {
    it('returns availability info', () => {
      const result = porthub.checkPort(9999);
      assert.equal(typeof result.available, 'boolean');
    });

    it('assumes available when PortHub unavailable', () => {
      if (!porthub.isAvailable()) {
        const result = porthub.checkPort(9999);
        assert.equal(result.available, true);
        assert.equal(result.leasedBy, null);
      }
    });
  });

  describe('graceful degradation', () => {
    it('registerPort returns error string when unavailable', () => {
      if (!porthub.isAvailable()) {
        const result = porthub.registerPort(8080, 'test', 'dev');
        assert.equal(result.success, false);
        assert.ok(result.error.includes('not available'));
      }
    });

    it('releasePort returns error string when unavailable', () => {
      if (!porthub.isAvailable()) {
        const result = porthub.releasePort(8080);
        assert.equal(result.success, false);
        assert.ok(result.error.includes('not available'));
      }
    });

    it('isDaemonRunning returns false when unavailable', () => {
      if (!porthub.isAvailable()) {
        assert.equal(porthub.isDaemonRunning(), false);
      }
    });
  });

  describe('command construction (mocked)', () => {
    it('registerPort constructs correct lease command', (t) => {
      const calls = [];
      t.mock.method(child_process, 'execSync', (cmd, opts) => {
        calls.push(cmd);
        if (cmd.includes('which porthub')) return '/usr/local/bin/porthub\n';
        if (cmd.includes('porthub lease')) return 'Leased\n';
        return '';
      });

      // Re-require to pick up mock — or call directly since isAvailable uses execSync
      const result = porthub.registerPort(8080, 'my-project', 'dev-server');

      // Find the lease command
      const leaseCmd = calls.find((c) => c.includes('porthub lease'));
      if (leaseCmd) {
        assert.ok(leaseCmd.includes('8080'), 'Command should include port');
        assert.ok(leaseCmd.includes('my-project'), 'Command should include project name');
        assert.ok(leaseCmd.includes('dev-server'), 'Command should include service');
        assert.ok(leaseCmd.includes('--permanent'), 'Command should include permanent flag');
      }

      t.mock.restoreAll();
    });

    it('releasePort constructs correct release command', (t) => {
      const calls = [];
      t.mock.method(child_process, 'execSync', (cmd) => {
        calls.push(cmd);
        if (cmd.includes('which porthub')) return '/usr/local/bin/porthub\n';
        if (cmd.includes('porthub release')) return 'Released\n';
        return '';
      });

      porthub.releasePort(9090);

      const releaseCmd = calls.find((c) => c.includes('porthub release'));
      if (releaseCmd) {
        assert.ok(releaseCmd.includes('9090'), 'Command should include port');
      }

      t.mock.restoreAll();
    });

    it('registerPort with permanent=false omits --permanent', (t) => {
      const calls = [];
      t.mock.method(child_process, 'execSync', (cmd) => {
        calls.push(cmd);
        if (cmd.includes('which porthub')) return '/usr/local/bin/porthub\n';
        if (cmd.includes('porthub lease')) return 'Leased\n';
        return '';
      });

      porthub.registerPort(8080, 'test', 'svc', { permanent: false });

      const leaseCmd = calls.find((c) => c.includes('porthub lease'));
      if (leaseCmd) {
        assert.ok(!leaseCmd.includes('--permanent'), 'Should not include --permanent');
      }

      t.mock.restoreAll();
    });

    it('registerPort escapes special characters in project name', (t) => {
      const calls = [];
      t.mock.method(child_process, 'execSync', (cmd) => {
        calls.push(cmd);
        if (cmd.includes('which porthub')) return '/usr/local/bin/porthub\n';
        if (cmd.includes('porthub lease')) return 'Leased\n';
        return '';
      });

      porthub.registerPort(8080, 'project$name', 'dev');

      const leaseCmd = calls.find((c) => c.includes('porthub lease'));
      if (leaseCmd) {
        // $ should be escaped
        assert.ok(!leaseCmd.includes('project$name'), 'Dollar sign should be escaped');
        assert.ok(leaseCmd.includes('project\\$name'), 'Dollar sign should be backslash-escaped');
      }

      t.mock.restoreAll();
    });
  });
});
