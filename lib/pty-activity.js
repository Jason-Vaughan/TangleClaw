'use strict';

/**
 * Terminal attach/detach counters (#1949).
 *
 * Release-candidate certification requires real terminal use during its soak:
 * at least 25 attaches and 25 detaches spread over six hours. Every browser
 * terminal is a websocket through the `/terminal` proxy to ttyd, and ttyd
 * starts one `tmux attach` per accepted websocket. So an attach is counted
 * when ttyd answers the proxied upgrade with `101 Switching Protocols` (a
 * refused or failed upgrade started no terminal and is not counted), and a
 * detach when that connection closes, once, from whichever side closes first.
 *
 * The counters live in memory and restart with the process. `instance`
 * changes with every process, so a reader that sees a new instance knows the
 * counts started again from zero rather than went backwards.
 *
 * @module lib/pty-activity
 */

const crypto = require('node:crypto');

const SWITCHING = Buffer.from('HTTP/1.1 101');

let _state = _fresh();

/**
 * Empty counters for a new process.
 * @returns {object} Counter state
 */
function _fresh() {
  return {
    instance: `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    attaches: 0,
    detaches: 0,
    firstAt: null,
    lastAt: null
  };
}

/**
 * Record an event time.
 * @param {number} at - Epoch ms
 * @returns {void}
 */
function _stamp(at) {
  if (_state.firstAt === null) _state.firstAt = at;
  _state.lastAt = at;
}

/**
 * Watch one proxied terminal connection and count its attach and detach.
 *
 * Reads only the start of ttyd's first reply to tell an accepted upgrade from
 * a refused one; it adds a listener and changes nothing about the piping.
 *
 * @param {import('node:net').Socket} client - The browser's socket
 * @param {import('node:net').Socket} upstream - The socket to ttyd
 * @param {function(): number} [now] - Clock seam
 * @returns {void}
 */
function trackTerminalConnection(client, upstream, now = Date.now) {
  let attached = false;
  let detached = false;
  let head = Buffer.alloc(0);
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]).subarray(0, SWITCHING.length);
    if (head.length < SWITCHING.length) return;
    upstream.removeListener('data', onData);
    if (!head.equals(SWITCHING) || detached) return;
    attached = true;
    _state.attaches += 1;
    _stamp(now());
  };
  const onClose = () => {
    if (!attached || detached) {
      detached = true;
      return;
    }
    detached = true;
    _state.detaches += 1;
    _stamp(now());
  };
  upstream.on('data', onData);
  upstream.once('close', onClose);
  client.once('close', onClose);
}

/**
 * The counters as the API serves them.
 * @returns {{instance: string, attaches: number, detaches: number, firstAt: number|null, lastAt: number|null}} Snapshot
 */
function snapshot() {
  return { ..._state };
}

/**
 * Start the counters again (tests).
 * @returns {void}
 */
function _reset() {
  _state = _fresh();
}

module.exports = { trackTerminalConnection, snapshot, _reset };
