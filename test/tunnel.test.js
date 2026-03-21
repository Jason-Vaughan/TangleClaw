'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { setLevel } = require('../lib/logger');

setLevel('error');

const tunnel = require('../lib/tunnel');

describe('tunnel', () => {
  afterEach(() => {
    // Clean up tracked tunnels between tests
    tunnel._tunnels.clear();
    mock.restoreAll();
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
});
