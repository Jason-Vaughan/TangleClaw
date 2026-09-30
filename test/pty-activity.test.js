'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const ptyActivity = require('../lib/pty-activity');

/**
 * A stand-in socket: an emitter that can carry data and close.
 * @returns {EventEmitter} Fake socket
 */
function sock() {
  return new EventEmitter();
}

/**
 * One proxied connection at a fixed clock.
 * @param {number} at - Epoch ms the clock reads
 * @returns {{client: EventEmitter, upstream: EventEmitter}} Its sockets
 */
function connection(at) {
  const client = sock();
  const upstream = sock();
  ptyActivity.trackTerminalConnection(client, upstream, () => at);
  return { client, upstream };
}

describe('lib/pty-activity (#1949)', () => {
  beforeEach(() => ptyActivity._reset());

  it('counts an attach when ttyd accepts the upgrade, and a detach when it closes', () => {
    const c = connection(1000);
    c.upstream.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    assert.equal(ptyActivity.snapshot().attaches, 1);
    const later = ptyActivity.snapshot();
    assert.deepEqual([later.attaches, later.detaches, later.firstAt, later.lastAt], [1, 0, 1000, 1000]);
    c.client.emit('close');
    c.upstream.emit('close');
    const s = ptyActivity.snapshot();
    assert.deepEqual([s.attaches, s.detaches], [1, 1]);
  });

  it('recognises the status line split across chunks', () => {
    const c = connection(5);
    c.upstream.emit('data', Buffer.from('HTTP/1'));
    c.upstream.emit('data', Buffer.from('.1 101 Switching'));
    assert.equal(ptyActivity.snapshot().attaches, 1);
  });

  it('counts neither for an upgrade ttyd refused or a connection that never answered', () => {
    const refused = connection(1);
    refused.upstream.emit('data', Buffer.from('HTTP/1.1 401 Unauthorized\r\n\r\n'));
    refused.upstream.emit('close');
    const silent = connection(2);
    silent.client.emit('close');
    silent.upstream.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    const s = ptyActivity.snapshot();
    assert.deepEqual([s.attaches, s.detaches, s.firstAt], [0, 0, null]);
  });

  it('stops reading the stream once the status line is known', () => {
    const c = connection(1);
    c.upstream.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    assert.equal(c.upstream.listenerCount('data'), 0);
  });

  it('keeps the first and latest event times across connections', () => {
    const a = connection(100);
    a.upstream.emit('data', Buffer.from('HTTP/1.1 101 OK'));
    const b = connection(900);
    b.upstream.emit('data', Buffer.from('HTTP/1.1 101 OK'));
    b.upstream.emit('close');
    const s = ptyActivity.snapshot();
    assert.deepEqual([s.attaches, s.detaches, s.firstAt, s.lastAt], [2, 1, 100, 900]);
  });

  it('names a new instance when the counters restart', () => {
    const before = ptyActivity.snapshot().instance;
    ptyActivity._reset();
    assert.notEqual(ptyActivity.snapshot().instance, before);
  });

  it('is wired into the terminal proxy and served at GET /api/system/pty-activity', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /ptyActivity\.trackTerminalConnection\(socket, proxySocket\)/);
    assert.match(src, /route\('GET', '\/api\/system\/pty-activity'/);
  });
});
