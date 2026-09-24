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

  describe('_parseNetstatListeners (macOS netstat -anv, per port)', () => {
    const HEADER = 'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat    pid   epid';
    const row = (local, state, pid) => `tcp4       0      0  ${local}  *.*  ${state}  0  0  131072  131072  ${pid}  0`;

    it('finds a LISTEN row on the port, with its pid, across address shapes', () => {
      for (const local of ['*.22', '127.0.0.1.22', 'fd7a:115c:a1e0::.22', '100.74.90.65.22', 'fe80::1%lo0.22']) {
        assert.deepEqual(portScanner._parseNetstatListeners([HEADER, row(local, 'LISTEN', 1)].join('\n')), [{ port: 22, pid: 1 }], local);
      }
    });

    it('does not read a port that only shares a suffix, or a non-LISTEN row, as that port', () => {
      const out = [HEADER, row('*.2222', 'LISTEN', 5), row('127.0.0.1.22', 'ESTABLISHED', 6), row('*.8022', 'LISTEN', 7)].join('\n');
      const ports = portScanner._parseNetstatListeners(out).map((r) => r.port);
      assert.deepEqual(ports, [2222, 8022]);
      assert.equal(ports.includes(22), false);
    });

    it('reports a null pid when the column is not a number', () => {
      assert.deepEqual(portScanner._parseNetstatListeners(row('*.22', 'LISTEN', '-')), [{ port: 22, pid: null }]);
    });
  });

  describe('_parseSsListeners (Linux ss -Hltn, per port)', () => {
    it('finds IPv4, IPv6 and interface-scoped listeners on the port', () => {
      for (const local of ['0.0.0.0:22', '[::]:22', '127.0.0.1%lo:22', '*:22']) {
        assert.deepEqual(portScanner._parseSsListeners(`LISTEN 0 128 ${local} 0.0.0.0:*`), [{ port: 22 }], local);
      }
    });

    it('does not read a port that only shares a suffix as that port', () => {
      const out = 'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:*\nLISTEN 0 128 [::]:8022 [::]:*';
      assert.deepEqual(portScanner._parseSsListeners(out), [{ port: 2222 }, { port: 8022 }]);
    });
  });

  describe('_parseNetstatListeners (macOS netstat -anv, whole table)', () => {
    const row = (local, state, pid) => `tcp4       0      0  ${local}  *.*  ${state}  0  0  131072  131072  ${pid}  0`;

    it('lists every LISTEN row once per port, across address shapes, skipping other states', () => {
      const out = [
        'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat    pid   epid',
        row('*.22', 'LISTEN', 1),
        row('127.0.0.1.3102', 'LISTEN', 24578),
        row('fd7a:115c:a1e0::.8444', 'LISTEN', 59047),
        row('::1.22', 'LISTEN', 2),
        row('127.0.0.1.50000', 'ESTABLISHED', 9),
        row('*.5900', 'LISTEN', '-')
      ].join('\n');
      assert.deepEqual(portScanner._parseNetstatListeners(out), [
        { port: 22, pid: 1 },
        { port: 3102, pid: 24578 },
        { port: 8444, pid: 59047 },
        { port: 5900, pid: null }
      ]);
    });

    it('returns an empty list for empty input', () => {
      assert.deepEqual(portScanner._parseNetstatListeners(''), []);
    });
  });

  describe('_parseSsListeners (Linux ss -Hltn, whole table)', () => {
    it('lists IPv4, IPv6 and interface-scoped listeners once per port', () => {
      const out = [
        'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
        'LISTEN 0 128 [::]:22 [::]:*',
        'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*',
        'LISTEN 0 511 *:8444 *:*'
      ].join('\n');
      assert.deepEqual(portScanner._parseSsListeners(out), [{ port: 22 }, { port: 53 }, { port: 8444 }]);
      assert.deepEqual(portScanner._parseSsListeners(''), []);
    });
  });

  describe('scan reads the socket table too (#1771)', () => {
    const LSOF = [
      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
      'node 24578 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:3102 (LISTEN)'
    ].join('\n');
    const NETSTAT = [
      'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat    pid   epid',
      'tcp4       0      0  127.0.0.1.3102         *.*                    LISTEN                 0            0  131072  131072  24578      0',
      'tcp4       0      0  *.22                   *.*                    LISTEN                 0            0  131072  131072      1      0',
      'tcp6       0      0  *.22                   *.*                    LISTEN                 0            0  131072  131072      1      0',
      'tcp4       0      0  100.74.90.65.8444      *.*                    LISTEN                 0            0  131072  131072  59047      0',
      'tcp4       0      0  *.5900                 *.*                    LISTEN                 0            0  131072  131072    444      0'
    ].join('\n');

    // A darwin host: this user's node on 3102, root's launchd on 22,
    // tailscale on 8444, and a pid on 5900 that has exited before ps runs.
    const darwinHost = (asked = []) => (cmd) => {
      asked.push(cmd);
      if (cmd.startsWith('lsof -iTCP -sTCP:LISTEN')) return LSOF;
      if (cmd.startsWith('lsof')) throw Object.assign(new Error('none'), { status: 1, stdout: '', stderr: '' });
      if (cmd === 'netstat -anv -p tcp') return NETSTAT;
      if (cmd.startsWith('ps -p ') && cmd.endsWith(' -o pid=,comm=')) {
        // ps exits 1 when a pid is gone, and still prints the rest.
        const out = '    1 /sbin/launchd\n59047 /Library/Application Support/x/io.tailscale.ipn\n24578 node\n';
        throw Object.assign(new Error('ps exited'), { status: 1, stdout: out, stderr: '' });
      }
      if (cmd.startsWith('ps -p ')) {
        const pid = Number(cmd.split(' ')[2]);
        return { 1: '/sbin/launchd\n', 59047: '/Library/Application Support/x/io.tailscale.ipn\n', 24578: 'node\n' }[pid] || '';
      }
      throw new Error(`unexpected command: ${cmd}`);
    };

    it('lists root-owned listeners lsof cannot see, named through one batched ps (macOS)', () => {
      portScanner._setPlatform('darwin');
      const asked = [];
      portScanner._setExec(darwinHost(asked));
      const expected = [
        { port: 3102, pid: 24578, command: 'node' },
        { port: 22, pid: 1, command: 'launchd' },
        { port: 8444, pid: 59047, command: 'io.tailscale.ipn' },
        { port: 5900, pid: 444, command: null }
      ];
      assert.deepEqual(portScanner.scan(), expected);
      assert.deepEqual(portScanner.getSystemPorts(), expected, 'the cache holds the merged scan');
      assert.deepEqual(asked.filter((c) => c.startsWith('ps ')), ['ps -p 24578,1,59047,444 -o pid=,comm='],
        'one ps names every pid');
    });

    it("keeps lsof's entry when both sources report a port", () => {
      portScanner._setPlatform('darwin');
      portScanner._setExec((cmd) => {
        if (cmd.startsWith('lsof')) return LSOF.replace('node 24578', 'caddy 77');
        if (cmd === 'netstat -anv -p tcp') return NETSTAT.split('\n').slice(0, 2).join('\n');
        if (cmd.startsWith('ps')) return '24578 other\n';
        throw new Error(`unexpected command: ${cmd}`);
      });
      assert.deepEqual(portScanner.scan(), [{ port: 3102, pid: 77, command: 'caddy' }]);
    });

    it('still lists socket-table listeners, unnamed, when ps cannot run at all', () => {
      portScanner._setPlatform('darwin');
      portScanner._setExec((cmd) => {
        if (cmd.startsWith('lsof')) return LSOF;
        if (cmd === 'netstat -anv -p tcp') return NETSTAT;
        if (cmd.startsWith('ps')) throw Object.assign(new Error('timed out'), { status: null, stdout: '', stderr: '' });
        throw new Error(`unexpected command: ${cmd}`);
      });
      assert.deepEqual(portScanner.scan(), [
        { port: 3102, pid: 24578, command: 'node' },
        { port: 22, pid: 1, command: null },
        { port: 8444, pid: 59047, command: null },
        { port: 5900, pid: 444, command: null }
      ]);
    });

    it('lists an ss-only listener on Linux with a null pid and command', () => {
      portScanner._setPlatform('linux');
      portScanner._setExec((cmd) => {
        if (cmd.startsWith('lsof')) return LSOF;
        if (cmd === 'ss -Hltn') return 'LISTEN 0 128 127.0.0.1:3102 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*';
        throw new Error(`unexpected command: ${cmd}`);
      });
      assert.deepEqual(portScanner.scan(), [
        { port: 3102, pid: 24578, command: 'node' },
        { port: 22, pid: null, command: null }
      ]);
    });

    it("keeps lsof's entries when the socket table cannot run", () => {
      portScanner._setPlatform('darwin');
      portScanner._setExec((cmd) => {
        if (cmd.startsWith('lsof')) return LSOF;
        throw Object.assign(new Error('not found'), { status: 127, stdout: '', stderr: 'netstat: not found' });
      });
      assert.deepEqual(portScanner.scan(), [{ port: 3102, pid: 24578, command: 'node' }]);
    });

    it("reads lsof's silent exit 1 as no listeners of this user's, and warns only on a real failure", () => {
      const logger = require('../lib/logger');
      const lines = [];
      const scanWith = (lsofStatus) => {
        portScanner._setPlatform('linux');
        portScanner._setExec((cmd) => {
          if (cmd.startsWith('lsof')) throw Object.assign(new Error('lsof exited'), { status: lsofStatus, stdout: '', stderr: '' });
          if (cmd === 'ss -Hltn') return 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*';
          throw new Error(`unexpected command: ${cmd}`);
        });
        lines.length = 0;
        return portScanner.scan();
      };
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (line) => { lines.push(String(line)); return true; } });
      try {
        assert.deepEqual(scanWith(1), [{ port: 22, pid: null, command: null }]);
        assert.equal(lines.some((l) => l.includes('WARN')), false, 'no listeners of this user is not a failure');
        assert.deepEqual(scanWith(127), [{ port: 22, pid: null, command: null }]);
        assert.equal(lines.some((l) => l.includes('lsof scan failed')), true, 'a missing lsof is warned about');
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel('error');
      }
    });

    it('lists the socket table alone when lsof cannot run', () => {
      portScanner._setPlatform('linux');
      portScanner._setExec((cmd) => {
        if (cmd.startsWith('lsof')) throw Object.assign(new Error('not found'), { status: 127, stdout: '', stderr: '' });
        if (cmd === 'ss -Hltn') return 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*';
        throw new Error(`unexpected command: ${cmd}`);
      });
      assert.deepEqual(portScanner.scan(), [{ port: 22, pid: null, command: null }]);
    });

    it('caches an empty scan when neither source can run', () => {
      portScanner._setLastScan([{ port: 1, pid: 1, command: 'stale' }]);
      portScanner._setPlatform('darwin');
      portScanner._setExec(() => {
        throw Object.assign(new Error('not found'), { status: 127, stdout: '', stderr: '' });
      });
      assert.deepEqual(portScanner.scan(), []);
      assert.deepEqual(portScanner.getSystemPorts(), []);
    });

    it('lists every port the lease probe would refuse, on the same host', () => {
      for (const platform of ['darwin', 'linux']) {
        portScanner._reset();
        portScanner._setPlatform(platform);
        portScanner._setExec(platform === 'darwin' ? darwinHost() : (cmd) => {
          if (cmd.startsWith('lsof -iTCP -sTCP:LISTEN')) return LSOF;
          if (/^lsof -nP -iTCP:3102 /.test(cmd)) return LSOF;
          if (cmd.startsWith('lsof')) throw Object.assign(new Error('none'), { status: 1, stdout: '', stderr: '' });
          if (cmd === 'ss -Hltn') return 'LISTEN 0 128 127.0.0.1:3102 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 128 [::]:8444 [::]:*';
          throw new Error(`unexpected command: ${cmd}`);
        });
        const listed = new Set(portScanner.scan().map((e) => e.port));
        const refused = [22, 3102, 5900, 8444, 9999].filter((p) => portScanner.probePort(p).inUse);
        assert.ok(refused.length >= 3, `${platform}: the fixture host has listeners the probe refuses`);
        for (const p of refused) assert.ok(listed.has(p), `${platform}: probe refuses ${p}, so the scan lists it`);
        assert.equal(listed.has(9999), false, `${platform}: a free port is not listed`);
      }
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
