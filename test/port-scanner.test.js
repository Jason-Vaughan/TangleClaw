'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const portScanner = require('../lib/port-scanner');

describe('port-scanner', () => {
  afterEach(() => {
    portScanner._reset();
  });

  describe('_parseLsofOutput', () => {
    it('parses standard lsof output', () => {
      const output = [
        'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
        'node    12345   user   22u  IPv4 0x1234      0t0  TCP *:3101 (LISTEN)',
        'node    12346   user   23u  IPv6 0x5678      0t0  TCP *:8080 (LISTEN)'
      ].join('\n');

      const result = portScanner._parseLsofOutput(output);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], { port: 3101, pid: 12345, command: 'node' });
      assert.deepEqual(result[1], { port: 8080, pid: 12346, command: 'node' });
    });

    it('parses IPv4 address format', () => {
      const output = [
        'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
        'nginx   999   root   6u  IPv4 0xabc      0t0  TCP 127.0.0.1:443 (LISTEN)'
      ].join('\n');

      const result = portScanner._parseLsofOutput(output);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], { port: 443, pid: 999, command: 'nginx' });
    });

    it('parses IPv6 address format', () => {
      const output = [
        'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
        'node    5555   user   10u  IPv6 0xdef      0t0  TCP [::1]:3000 (LISTEN)'
      ].join('\n');

      const result = portScanner._parseLsofOutput(output);
      assert.equal(result.length, 1);
      assert.equal(result[0].port, 3000);
    });

    it('returns empty array for empty input', () => {
      const result = portScanner._parseLsofOutput('');
      assert.deepEqual(result, []);
    });

    it('returns empty array for header-only input', () => {
      const result = portScanner._parseLsofOutput(
        'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n'
      );
      assert.deepEqual(result, []);
    });

    it('skips malformed lines', () => {
      const output = [
        'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
        'this is not valid',
        '',
        'node    12345   user   22u  IPv4 0x1234      0t0  TCP *:3101 (LISTEN)'
      ].join('\n');

      const result = portScanner._parseLsofOutput(output);
      assert.equal(result.length, 1);
      assert.equal(result[0].port, 3101);
    });

    it('deduplicates ports', () => {
      const output = [
        'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
        'node    12345   user   22u  IPv4 0x1234      0t0  TCP *:3101 (LISTEN)',
        'node    12345   user   23u  IPv6 0x5678      0t0  TCP *:3101 (LISTEN)'
      ].join('\n');

      const result = portScanner._parseLsofOutput(output);
      assert.equal(result.length, 1);
    });
  });

  describe('getSystemPorts', () => {
    it('returns empty array before any scan', () => {
      assert.deepEqual(portScanner.getSystemPorts(), []);
    });
  });

  describe('isPortInUseBySystem', () => {
    it('returns not in use when cache is empty', () => {
      const result = portScanner.isPortInUseBySystem(3101);
      assert.equal(result.inUse, false);
      assert.equal(result.process, null);
      assert.equal(result.pid, null);
    });
  });

  describe('startScanner / stopScanner', () => {
    it('starts and stops without error', () => {
      // Use a very long interval so it doesn't actually fire during the test
      portScanner.startScanner(999999);
      portScanner.stopScanner();
    });

    it('restarts with new interval when called while running', () => {
      portScanner.startScanner(999999);
      portScanner.startScanner(888888); // should stop and restart
      portScanner.stopScanner();
    });

    it('is idempotent on stop', () => {
      portScanner.stopScanner();
      portScanner.stopScanner(); // should not throw
    });
  });

  describe('scan', () => {
    it('returns an array (may be empty in test environment)', () => {
      const result = portScanner.scan();
      assert.ok(Array.isArray(result));
    });

    it('populates getSystemPorts cache after scan', () => {
      portScanner.scan();
      const cached = portScanner.getSystemPorts();
      assert.ok(Array.isArray(cached));
    });

    it('isPortInUseBySystem reflects scan results', () => {
      portScanner.scan();
      // We can't predict which ports are in use, but we can verify the function works
      const result = portScanner.isPortInUseBySystem(99999); // unlikely to be in use
      assert.equal(result.inUse, false);
    });
  });
  describe('probePort (#814)', () => {
    const fail = (status, stderr, stdout = '') => () => {
      const err = new Error('lsof exited');
      err.status = status;
      err.stderr = stderr;
      err.stdout = stdout;
      throw err;
    };

    it('asks lsof about exactly that port and parses a listener', () => {
      let asked;
      portScanner._setExec((cmd) => {
        asked = cmd;
        return 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\ncaddy 77 me 7u IPv6 0x1 0t0 TCP *:8443 (LISTEN)';
      });
      assert.deepEqual(portScanner.probePort(8443), { inUse: true, process: 'caddy', pid: 77, source: 'probe' });
      assert.match(asked, /-iTCP:8443 /);
      assert.match(asked, /-sTCP:LISTEN/);
    });

    it("reads lsof's silent exit 1 as nothing listening, not as a failure", () => {
      portScanner._setExec(fail(1, ''));
      assert.deepEqual(portScanner.probePort(3999), { inUse: false, process: null, pid: null, source: 'probe' });
    });

    it('does not trust a stale cache when the probe answered clear', () => {
      portScanner._setLastScan([{ port: 3999, pid: 1, command: 'old' }]);
      portScanner._setExec(fail(1, ''));
      assert.equal(portScanner.probePort(3999).inUse, false, 'the fresh answer wins over the cache');
    });

    it('falls back to the cached scan when lsof cannot run, and says so', () => {
      portScanner._setLastScan([{ port: 5432, pid: 9, command: 'postgres' }]);
      portScanner._setExec(fail(127, 'sh: lsof: not found'));
      assert.deepEqual(portScanner.probePort(5432), { inUse: true, process: 'postgres', pid: 9, source: 'cache' });
      assert.equal(portScanner.probePort(5433).source, 'cache');
    });

    it('reports unavailable when lsof cannot run and nothing is cached', () => {
      portScanner._setExec(fail(127, 'sh: lsof: not found'));
      assert.deepEqual(portScanner.probePort(5432), { inUse: false, process: null, pid: null, source: 'unavailable' });
    });

    it('treats an exit 1 WITH error text as a failure, not a clear answer', () => {
      portScanner._setExec(fail(1, 'lsof: WARNING: permission denied'));
      assert.equal(portScanner.probePort(5432).source, 'unavailable');
    });

    it('never shells out for a port outside 1..65535', () => {
      let ran = false;
      portScanner._setExec(() => { ran = true; return ''; });
      for (const bad of [0, 70000, -1, 3.5, NaN]) {
        assert.equal(portScanner.probePort(bad).source, 'unavailable');
      }
      assert.equal(ran, false);
    });
  });
});
