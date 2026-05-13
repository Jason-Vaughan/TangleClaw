'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const porthub = require('../lib/porthub');
const tunnel = require('../lib/tunnel');

describe('tunnel', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tunnel-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    // Clean up tracked tunnels between tests
    tunnel._tunnels.clear();
    mock.restoreAll();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('tcpProbe', () => {
    it('should return true when port is connectable', async () => {
      // Start a temporary TCP server
      const server = net.createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        const result = await tunnel.tcpProbe(port);
        assert.equal(result, true);
      } finally {
        server.close();
      }
    });

    it('should return false when port is not connectable', async () => {
      // Use a port that is almost certainly not in use
      const result = await tunnel.tcpProbe(19999, '127.0.0.1', 500);
      assert.equal(result, false);
    });

    it('should return false on timeout', async () => {
      // Use a non-routable address to trigger timeout
      const result = await tunnel.tcpProbe(80, '10.255.255.1', 200);
      assert.equal(result, false);
    });
  });

  describe('ensureTunnel', () => {
    it('should detect an already-up port and skip spawning', async () => {
      const server = net.createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        const result = await tunnel.ensureTunnel('test-project', {
          host: '198.51.100.10',
          port: 18789,
          localPort: port,
          sshUser: 'test',
          sshKeyPath: '~/.ssh/id_rsa'
        });

        assert.equal(result.ok, true);
        assert.equal(result.alreadyUp, true);
        assert.equal(result.pid, null);
        assert.equal(result.error, null);
      } finally {
        server.close();
      }
    });

    it('should return error when SSH tunnel fails to come up', async () => {
      // Use a bogus host/key so SSH fails immediately
      const result = await tunnel.ensureTunnel('fail-project', {
        host: '127.0.0.1',
        port: 99999,
        localPort: 19998,
        sshUser: 'nobody',
        sshKeyPath: '/nonexistent/key'
      });

      // SSH will fail — port won't become connectable
      assert.equal(result.ok, false);
      assert.equal(result.alreadyUp, false);
      assert.ok(result.error);
    });
  });

  describe('killTunnel', () => {
    it('should return ok when no tunnel is tracked', () => {
      const result = tunnel.killTunnel('nonexistent');
      assert.equal(result.ok, true);
      assert.equal(result.error, null);
    });

    it('should remove tracked tunnel entry', () => {
      // Manually track a tunnel with a fake PID
      tunnel._tunnels.set('test-project', {
        pid: 999999,
        localPort: 19997,
        host: '198.51.100.10',
        remotePort: 18789
      });

      const result = tunnel.killTunnel('test-project');
      assert.equal(result.ok, true);
      assert.equal(tunnel._tunnels.has('test-project'), false);
    });
  });

  describe('checkHealth', () => {
    it('should return healthy when server responds with ok:true', async () => {
      // Start a minimal HTTP server that returns healthz
      const server = net.createServer((socket) => {
        socket.on('data', () => {
          const body = JSON.stringify({ ok: true });
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
          );
          socket.end();
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        const result = await tunnel.checkHealth({ localPort: port });
        assert.equal(result.healthy, true);
        assert.equal(result.error, null);
      } finally {
        server.close();
      }
    });

    it('should return unhealthy when server responds with ok:false', async () => {
      const server = net.createServer((socket) => {
        socket.on('data', () => {
          const body = JSON.stringify({ ok: false });
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
          );
          socket.end();
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        const result = await tunnel.checkHealth({ localPort: port });
        assert.equal(result.healthy, false);
        assert.ok(result.error);
      } finally {
        server.close();
      }
    });

    it('should return unhealthy when server is not reachable', async () => {
      const result = await tunnel.checkHealth({ localPort: 19996 }, 500);
      assert.equal(result.healthy, false);
      assert.ok(result.error);
    });

    it('should return unhealthy on HTTP error status', async () => {
      const server = net.createServer((socket) => {
        socket.on('data', () => {
          const body = 'Internal Server Error';
          socket.write(
            `HTTP/1.1 500 Internal Server Error\r\nContent-Length: ${body.length}\r\n\r\n${body}`
          );
          socket.end();
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        const result = await tunnel.checkHealth({ localPort: port });
        assert.equal(result.healthy, false);
        assert.equal(result.error, 'HTTP 500');
      } finally {
        server.close();
      }
    });
  });

  describe('getTunnel', () => {
    it('should return null when no tunnel tracked', () => {
      assert.equal(tunnel.getTunnel('nonexistent'), null);
    });

    it('should return tunnel info when tracked', () => {
      tunnel._tunnels.set('my-project', {
        pid: 12345,
        localPort: 18789,
        host: '198.51.100.10',
        remotePort: 18789
      });

      const info = tunnel.getTunnel('my-project');
      assert.equal(info.pid, 12345);
      assert.equal(info.localPort, 18789);
    });
  });

  describe('listTunnels', () => {
    it('should return empty array when no tunnels', () => {
      assert.deepEqual(tunnel.listTunnels(), []);
    });

    it('should list all tracked tunnels', () => {
      tunnel._tunnels.set('proj-a', { pid: 1, localPort: 18789, host: 'a', remotePort: 18789 });
      tunnel._tunnels.set('proj-b', { pid: 2, localPort: 18790, host: 'b', remotePort: 18790 });

      const list = tunnel.listTunnels();
      assert.equal(list.length, 2);
      assert.equal(list[0].projectName, 'proj-a');
      assert.equal(list[1].projectName, 'proj-b');
    });
  });

  describe('detectTunnel', () => {
    it('should detect active tunnel when port is connectable', async () => {
      const server = net.createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        const result = await tunnel.detectTunnel(port);
        assert.equal(result.active, true);
        assert.equal(result.connectable, true);
        assert.equal(result.port, port);
      } finally {
        server.close();
      }
    });

    it('should return inactive when port is not connectable and no SSH process', async () => {
      const result = await tunnel.detectTunnel(19991);
      assert.equal(result.active, false);
      assert.equal(result.connectable, false);
      assert.equal(result.pid, null);
    });
  });

  describe('killTunnelByPort', () => {
    it('should release port from PortHub even when no SSH process found', () => {
      const localPort = 19993;
      porthub.registerPort(localPort, 'stale-project', 'openclaw-tunnel');

      const result = tunnel.killTunnelByPort(localPort);
      assert.equal(result.ok, true);
      assert.equal(result.pid, null);

      const lease = store.portLeases.get(localPort);
      assert.equal(lease, null, 'port lease should be released');
    });

    it('should clean up tracked tunnel entry matching the port', () => {
      tunnel._tunnels.set('tracked-proj', {
        pid: 999999,
        localPort: 19994,
        host: '198.51.100.10',
        remotePort: 18789
      });

      const result = tunnel.killTunnelByPort(19994);
      assert.equal(result.ok, true);
      assert.equal(tunnel._tunnels.has('tracked-proj'), false);
    });
  });

  describe('ensureTunnel force mode', () => {
    it('should skip force kill when port is not in use', async () => {
      // Port not in use — force flag should not cause issues
      const result = await tunnel.ensureTunnel('force-test', {
        host: '127.0.0.1',
        port: 99999,
        localPort: 19992,
        sshUser: 'nobody',
        sshKeyPath: '/nonexistent/key',
        force: true
      });

      // SSH will fail (bogus config), but force shouldn't cause errors
      assert.equal(result.alreadyUp, false);
    });
  });

  describe('_findSshPidByPort', () => {
    it('should return null when no SSH process on that port', () => {
      const pid = tunnel._findSshPidByPort(19990);
      assert.equal(pid, null);
    });
  });

  describe('PortHub integration', () => {
    it('ensureTunnel registers port with PortHub when already up', async () => {
      const server = net.createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        await tunnel.ensureTunnel('test-porthub', {
          host: '198.51.100.10',
          port: 18789,
          localPort: port,
          sshUser: 'test',
          sshKeyPath: '~/.ssh/id_rsa'
        });

        // Verify the port was registered with PortHub
        const lease = store.portLeases.get(port);
        assert.ok(lease, 'port lease should exist');
        assert.equal(lease.project, 'test-porthub');
        assert.equal(lease.service, 'openclaw-tunnel');
        assert.equal(lease.permanent, false);
      } finally {
        server.close();
      }
    });

    it('killTunnel releases port from PortHub', () => {
      const localPort = 19997;
      // Register the port first (simulating what ensureTunnel does)
      porthub.registerPort(localPort, 'test-kill', 'openclaw-tunnel');
      tunnel._tunnels.set('test-kill', {
        pid: 999999,
        localPort,
        host: '198.51.100.10',
        remotePort: 18789
      });

      tunnel.killTunnel('test-kill');

      // Verify the port was released from PortHub
      const lease = store.portLeases.get(localPort);
      assert.equal(lease, null, 'port lease should be released');
    });
  });

  describe('_formatTunnelError (#160)', () => {
    it('returns a generic message when stderr is empty', () => {
      assert.equal(
        tunnel._formatTunnelError('', []),
        'SSH tunnel spawned but port not connectable',
        'empty stderr falls through to the pre-#160 generic message'
      );
      assert.equal(
        tunnel._formatTunnelError('   \n  ', []),
        'SSH tunnel spawned but port not connectable',
        'whitespace-only stderr also treated as empty'
      );
      assert.equal(
        tunnel._formatTunnelError(undefined, []),
        'SSH tunnel spawned but port not connectable',
        'missing stderr argument tolerated'
      );
    });

    it('recognizes a local-bind conflict on a primary local port and names the port', () => {
      const stderr = 'bind [127.0.0.1]:28789: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 28789';
      const msg = tunnel._formatTunnelError(stderr, []);
      assert.match(msg, /Local port 28789 is already in use/);
      assert.match(msg, /SSH refused the forward/i,
        'message should mention why the tunnel failed');
    });

    it('recognizes a local-bind conflict on an extra forward and suggests clearing it (the canonical #160 incident)', () => {
      const stderr = 'bind [127.0.0.1]:3201: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 3201';
      const extras = [{ localPort: 3201, remotePort: 3201 }];
      const msg = tunnel._formatTunnelError(stderr, extras);
      assert.match(msg, /Local port 3201 is already in use/);
      assert.match(msg, /Clear the secondary forward/i,
        'when the conflicting port matches an extra forward, hint at clearing it (Bridge Port)');
    });

    it('recognizes auth failures (Permission denied / publickey)', () => {
      const msg = tunnel._formatTunnelError(
        'jason@198.51.100.10: Permission denied (publickey).',
        []
      );
      assert.match(msg, /SSH authentication failed:/);
      assert.match(msg, /Permission denied/);
    });

    it('recognizes connection-level failures (refused, no route, DNS)', () => {
      assert.match(
        tunnel._formatTunnelError('ssh: connect to host 1.2.3.4 port 22: Connection refused', []),
        /SSH connection failed:.*Connection refused/
      );
      assert.match(
        tunnel._formatTunnelError('ssh: connect to host bad.example.com port 22: No route to host', []),
        /SSH connection failed:.*No route to host/
      );
      assert.match(
        tunnel._formatTunnelError('ssh: Could not resolve hostname not-a-host: nodename nor servname provided', []),
        /SSH connection failed:.*Could not resolve hostname/
      );
    });

    it('falls back to the first non-empty line for unrecognized stderr', () => {
      const stderr = '\n\nSome unrecognized error happened\nfollow-up detail';
      const msg = tunnel._formatTunnelError(stderr, []);
      assert.equal(msg, 'SSH tunnel failed: Some unrecognized error happened');
    });

    it('handles multi-line bind error where address segment uses different bracket formatting', () => {
      // Some SSH versions print `bind: 0.0.0.0:port` without brackets; the
      // regex should still extract the port number.
      const variants = [
        'bind 0.0.0.0:28789: Address already in use',
        'bind [0.0.0.0]:28789: Address already in use',
        'bind 127.0.0.1:28789: Address already in use',
        'bind [127.0.0.1]:28789: Address already in use'
      ];
      for (const v of variants) {
        const msg = tunnel._formatTunnelError(v, []);
        assert.match(msg, /Local port 28789 is already in use/, `failed for variant: ${v}`);
      }
    });

    it('exports _formatTunnelError on the module', () => {
      // The helper is exported specifically for unit-testability; if a future
      // refactor inlines it, this canary will catch the drop.
      assert.equal(typeof tunnel._formatTunnelError, 'function');
    });

    it('skips the `Warning: Permanently added` first-connect noise line (Critic MAJOR-1)', () => {
      // Real-world stderr when SSH connects to a previously-unseen host. The
      // Warning line was hijacking auth/network/fallback messages — failed
      // auth would render "SSH authentication failed: Warning: Permanently
      // added 'host' (ECDSA) to the list of known hosts." instead of the
      // actual Permission-denied line.
      const auth = tunnel._formatTunnelError(
        "Warning: Permanently added '198.51.100.10' (ECDSA) to the list of known hosts.\njason@198.51.100.10: Permission denied (publickey).",
        []
      );
      assert.match(auth, /SSH authentication failed:/);
      assert.match(auth, /Permission denied/);
      assert.doesNotMatch(auth, /Warning: Permanently added/);

      const net = tunnel._formatTunnelError(
        "Warning: Permanently added '198.51.100.10' (ECDSA) to the list of known hosts.\nssh: connect to host 198.51.100.10 port 22: Connection refused",
        []
      );
      assert.match(net, /SSH connection failed:.*Connection refused/);
      assert.doesNotMatch(net, /Warning: Permanently added/);

      const fallback = tunnel._formatTunnelError(
        "Warning: Permanently added '198.51.100.10' (ECDSA) to the list of known hosts.\nSomething unrecognized went wrong",
        []
      );
      assert.match(fallback, /SSH tunnel failed: Something unrecognized went wrong/);
    });

    it('recognizes an IPv6 bind-conflict and extracts the port (Critic MINOR-1)', () => {
      // SSH formats IPv6 bind addresses as `bind [::1]:port` — the pre-Critic
      // regex `[^:]*:(\d+):` failed to match because the address segment
      // itself contains colons.
      const msg = tunnel._formatTunnelError('bind [::1]:28789: Address already in use', []);
      assert.match(msg, /Local port 28789 is already in use/,
        'IPv6 bind-conflict should be recognized like the IPv4 form');
    });
  });
});
