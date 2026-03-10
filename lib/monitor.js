'use strict';

const tmux = require('./tmux');

// Central session monitor: polls peek for all active sessions,
// detects when output stabilizes after sustained changing, emits events via SSE.
//
// Logic: output must change for at least 3 consecutive polls (sustained activity)
// before we consider the session "busy". Only then, when output stabilizes for
// 2 consecutive polls, do we fire an idle event. This filters out noise from
// cursor blinks, clock updates, and status bar changes.

const _clients = [];          // SSE response objects
const _lastPeek = {};         // sessionName -> last peek text
const _changeCount = {};      // sessionName -> consecutive polls where output changed
const _stableCount = {};      // sessionName -> consecutive polls where output was same
const _wasBusy = {};          // sessionName -> true if sustained activity was detected
let _pollInterval = 5000;     // ms (5s for responsive detection)
let _pollTimer = null;

const BUSY_THRESHOLD = 3;     // consecutive changing polls to count as "busy"
const STABLE_THRESHOLD = 2;   // consecutive stable polls to count as "idle"

function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':\n\n');
  _clients.push(res);

  res.on('close', () => {
    const idx = _clients.indexOf(res);
    if (idx !== -1) _clients.splice(idx, 1);
  });

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
        _lastPeek[name] = text;
        _changeCount[name] = 0;
        _stableCount[name] = 0;
        _wasBusy[name] = false;
        continue;
      }

      if (text !== _lastPeek[name]) {
        // Output changed
        _changeCount[name] = (_changeCount[name] || 0) + 1;
        _stableCount[name] = 0;

        // Mark as busy after sustained activity
        if (_changeCount[name] >= BUSY_THRESHOLD) {
          _wasBusy[name] = true;
        }
      } else {
        // Output stable
        _stableCount[name] = (_stableCount[name] || 0) + 1;
        _changeCount[name] = 0;

        // Fire chime only after sustained busy → sustained stable
        if (_wasBusy[name] && _stableCount[name] >= STABLE_THRESHOLD) {
          broadcast(name);
          _wasBusy[name] = false;
        }
      }
      _lastPeek[name] = text;
    } catch {}
  }

  // Clean up sessions that no longer exist
  for (const name of Object.keys(_lastPeek)) {
    if (!(name in sessions)) {
      delete _lastPeek[name];
      delete _changeCount[name];
      delete _stableCount[name];
      delete _wasBusy[name];
    }
  }

  if (_clients.length === 0) {
    stop();
  }
}

function start() {
  if (_pollTimer) return;
  _pollTimer = setInterval(poll, _pollInterval);
  poll();
}

function stop() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  for (const key of Object.keys(_lastPeek)) delete _lastPeek[key];
  for (const key of Object.keys(_changeCount)) delete _changeCount[key];
  for (const key of Object.keys(_stableCount)) delete _stableCount[key];
  for (const key of Object.keys(_wasBusy)) delete _wasBusy[key];
}

module.exports = { addClient };
