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

  });

  describe('_parseNetstatListener (macOS netstat -anv)', () => {
    const HEADER = 'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat    pid   epid';
    const row = (local, state, pid) => `tcp4       0      0  ${local}  *.*  ${state}  0  0  131072  131072  ${pid}  0`;

    it('finds a LISTEN row on the port, with its pid, across address shapes', () => {
      for (const local of ['*.22', '127.0.0.1.22', 'fd7a:115c:a1e0::.22', '100.74.90.65.22']) {
        assert.deepEqual(portScanner._parseNetstatListener([HEADER, row(local, 'LISTEN', 1)].join('\n'), 22), { pid: 1 }, local);
      }
    });

    it('ignores other ports, a port that only shares a suffix, and non-LISTEN rows', () => {
      const out = [HEADER, row('*.2222', 'LISTEN', 5), row('127.0.0.1.22', 'ESTABLISHED', 6), row('*.8022', 'LISTEN', 7)].join('\n');
      assert.equal(portScanner._parseNetstatListener(out, 22), null);
    });

    it('reports a null pid when the column is not a number', () => {
      assert.deepEqual(portScanner._parseNetstatListener(row('*.22', 'LISTEN', '-'), 22), { pid: null });
    });
  });

  describe('_parseSsListener (Linux ss -Hltn)', () => {
    it('finds IPv4, IPv6 and interface-scoped listeners on the port', () => {
      for (const local of ['0.0.0.0:22', '[::]:22', '127.0.0.1%lo:22', '*:22']) {
        assert.equal(portScanner._parseSsListener(`LISTEN 0 128 ${local} 0.0.0.0:*`, 22), true, local);
      }
    });

    it('ignores a different port and a port that only shares a suffix', () => {
      const out = 'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:*\nLISTEN 0 128 [::]:8022 [::]:*';
      assert.equal(portScanner._parseSsListener(out, 22), false);
      assert.equal(portScanner._parseSsListener('', 22), false);
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

    it('accepts a numeric string and probes it as the number', () => {
      let asked;
      portScanner._setExec((cmd) => {
        asked = cmd;
        return 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\ncaddy 77 me 7u IPv6 0x1 0t0 TCP *:8443 (LISTEN)';
      });
      assert.equal(portScanner.probePort('8443').inUse, true);
      assert.match(asked, /-iTCP:8443 /);
    });

    it("finds a root-owned listener lsof cannot see, through the socket table (macOS)", () => {
      // lsof as a normal user lists only that user's sockets; tailscale serve,
      // sshd and other root listeners are invisible to it.
      portScanner._setPlatform('darwin');
      portScanner._setExec((cmd) => {
        if (cmd.startsWith('lsof')) throw Object.assign(new Error('none'), { status: 1, stdout: '', stderr: '' });
        if (cmd.startsWith('netstat')) {
          return [
            'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat    pid   epid',
            'tcp4       0      0  100.74.90.65.8444      *.*                    LISTEN                 0            0  131072  131072  59047      0',
            'tcp4       0      0  127.0.0.1.3102         *.*                    ESTABLISHED            0            0  131072  131072   6930      0'
          ].join('\n');
        }
        if (cmd.startsWith('ps -p 59047')) return '/Library/SystemExtensions/x/io.tailscale.ipn.macsys.network-extension\n';
        throw new Error(`unexpected command: ${cmd}`);
      });
      assert.deepEqual(portScanner.probePort(8444),
        { inUse: true, process: 'io.tailscale.ipn.macsys.network-extension', pid: 59047, source: 'probe' });
    });

    it('does not read a non-LISTEN socket-table row as a listener', () => {
      portScanner._setPlatform('darwin');
      portScanner._setExec((cmd) => {
        if (cmd.startsWith('lsof')) throw Object.assign(new Error('none'), { status: 1, stdout: '', stderr: '' });
        if (cmd.startsWith('netstat')) {
          return 'tcp4       0      0  127.0.0.1.3102         127.0.0.1.50000        ESTABLISHED            0            0  131072  131072   6930      0';
        }
        throw new Error(`unexpected command: ${cmd}`);
      });
      assert.equal(portScanner.probePort(3102).inUse, false);
    });

    it('finds a listener lsof cannot see through ss on Linux, without a pid', () => {
      portScanner._setPlatform('linux');
      portScanner._setExec((cmd) => {
        if (cmd.startsWith('lsof')) throw Object.assign(new Error('none'), { status: 1, stdout: '', stderr: '' });
        if (cmd === 'ss -Hltn') return 'LISTEN 0      4096         [::]:8444          [::]:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*';
        throw new Error(`unexpected command: ${cmd}`);
      });
      assert.deepEqual(portScanner.probePort(8444), { inUse: true, process: null, pid: null, source: 'probe' });
      assert.equal(portScanner.probePort(8445).inUse, false);
    });

    it('asks no fallback on a platform that has none', () => {
      portScanner._setPlatform('win32');
      const asked = [];
      portScanner._setExec((cmd) => {
        asked.push(cmd);
        throw Object.assign(new Error('none'), { status: 1, stdout: '', stderr: '' });
      });
      assert.equal(portScanner.probePort(3999).inUse, false);
      assert.deepEqual(asked.map((c) => c.split(' ')[0]), ['lsof']);
    });

    it("keeps lsof's clear answer when the socket-table fallback cannot run", () => {
      portScanner._setExec((cmd) => {
        if (cmd.startsWith('lsof')) throw Object.assign(new Error('none'), { status: 1, stdout: '', stderr: '' });
        throw Object.assign(new Error('not found'), { status: 127, stdout: '', stderr: 'not found' });
      });
      assert.deepEqual(portScanner.probePort(3999), { inUse: false, process: null, pid: null, source: 'probe' });
    });

    it('never shells out for a port outside 1..65535', () => {
      let ran = false;
      portScanner._setExec(() => { ran = true; return ''; });
      for (const bad of [0, 70000, -1, 3.5, NaN, 'abc']) {
        assert.equal(portScanner.probePort(bad).source, 'unavailable');
      }
      assert.equal(ran, false);
    });
  });
});
