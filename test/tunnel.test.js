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
          host: '192.168.20.10',
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
        host: '192.168.20.10',
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
        host: '192.168.20.10',
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
        host: '192.168.20.10',
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
          host: '192.168.20.10',
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
        host: '192.168.20.10',
        remotePort: 18789
      });

      tunnel.killTunnel('test-kill');

      // Verify the port was released from PortHub
      const lease = store.portLeases.get(localPort);
      assert.equal(lease, null, 'port lease should be released');
    });
  });
});
