'use strict';

const tmux = require('./tmux');

// Central session monitor: polls peek for all active sessions,
// detects when output stabilizes after changing, emits events via SSE.

const _clients = [];          // SSE response objects
const _lastPeek = {};         // sessionName -> last peek text
const _wasChanging = {};      // sessionName -> bool
const _stableCount = {};      // sessionName -> int
let _pollInterval = 10000;    // ms
let _pollTimer = null;

function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':\n\n'); // SSE comment to flush headers
  _clients.push(res);

  res.on('close', () => {
    const idx = _clients.indexOf(res);
    if (idx !== -1) _clients.splice(idx, 1);
  });

  // Start monitoring if not already running
  if (!_pollTimer) start();
}

function broadcast(sessionName) {
  const data = JSON.stringify({ session: sessionName, event: 'idle' });
  const msg = `data: ${data}\n\n`;
  for (const client of _clients) {
    try { client.write(msg); } catch {}
  }
}

function poll() {
  const sessions = tmux.getSessions();

  for (const name of Object.keys(sessions)) {
    try {
      const text = tmux.peek(name, 20);

      if (!(name in _lastPeek)) {
        // First poll for this session — record baseline
        _lastPeek[name] = text;
        _wasChanging[name] = false;
        _stableCount[name] = 0;
        continue;
      }

      if (text !== _lastPeek[name]) {
        // Output changed
        _wasChanging[name] = true;
        _stableCount[name] = 0;
      } else {
        // Same as last poll
        _stableCount[name] = (_stableCount[name] || 0) + 1;
        if (_wasChanging[name] && _stableCount[name] >= 1) {
          broadcast(name);
          _wasChanging[name] = false;
        }
      }
      _lastPeek[name] = text;
    } catch {}
  }

  // Clean up sessions that no longer exist
  for (const name of Object.keys(_lastPeek)) {
    if (!(name in sessions)) {
      delete _lastPeek[name];
      delete _wasChanging[name];
      delete _stableCount[name];
    }
  }

  // Stop polling if no clients
  if (_clients.length === 0) {
    stop();
  }
}

function start() {
  if (_pollTimer) return;
  _pollTimer = setInterval(poll, _pollInterval);
  poll(); // immediate first poll
}

function stop() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  // Clear state so next start gets fresh baselines
  for (const key of Object.keys(_lastPeek)) delete _lastPeek[key];
  for (const key of Object.keys(_wasChanging)) delete _wasChanging[key];
  for (const key of Object.keys(_stableCount)) delete _stableCount[key];
}

function setInterval_(ms) {
  _pollInterval = ms;
  if (_pollTimer) {
    stop();
    start();
  }
}

module.exports = { addClient, setInterval: setInterval_ };
