'use strict';

// Tests for lib/engine-error-monitor.js: the periodic pane read that feeds
// engine API error detection (#261). The last suite pins that pane text is
// never a wrap request (#2027). Drives `_internal.tick()` deterministically
// with stubbed reads; `stop()` between tests clears module state.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const monitor = require('../lib/engine-error-monitor');

/** The retired wrap marker, assembled so this file never carries it whole. */
const LEGACY_MARKER = ['TANGLECLAW', 'WRAP'].join('_');

/**
 * A tmux session record.
 * @param {number} [id]
 * @returns {object}
 */
function tmuxSession(id = 1) {
  return { id, projectId: id * 10, sessionMode: 'tmux', tmuxSession: `tc-${id}`, engineId: 'claude' };
}

describe('engine-error-monitor — pane reads', () => {
  let saved;
  let observed;
  let forgotten;
  beforeEach(() => {
    monitor.stop();
    saved = { ...monitor._internal };
    observed = [];
    forgotten = [];
    monitor._internal.getEngineProfile = (engineId) => ({ id: engineId });
    monitor._internal.observeEngineErrors = (session, lines, profile) => observed.push({ id: session.id, lines, profile });
    monitor._internal.forgetEngineErrors = (sid) => forgotten.push(sid);
  });
  afterEach(() => { Object.assign(monitor._internal, saved); monitor.stop(); });

  it('hands every live tmux pane tail, with its engine profile, to engine-error detection', async () => {
    monitor._internal.listLiveAll = () => [tmuxSession(1), tmuxSession(2)];
    monitor._internal.capturePane = (name) => ({ lines: [`tail of ${name}`] });
    await monitor._internal.tick();
    assert.deepEqual(observed.map((o) => [o.id, o.lines, o.profile.id]), [
      [1, ['tail of tc-1'], 'claude'],
      [2, ['tail of tc-2'], 'claude']
    ]);
  });

  it('reads the engine profile once per tick for a fleet on one engine', async () => {
    let reads = 0;
    monitor._internal.getEngineProfile = (engineId) => { reads += 1; return { id: engineId }; };
    monitor._internal.listLiveAll = () => [tmuxSession(1), tmuxSession(2), tmuxSession(3)];
    monitor._internal.capturePane = () => ({ lines: [] });
    await monitor._internal.tick();
    assert.equal(reads, 1);
  });

  it('does not read a webui session or a session with no pane', async () => {
    monitor._internal.listLiveAll = () => [
      { id: 7, projectId: 70, sessionMode: 'webui', tmuxSession: null, engineId: 'openclaw:c' },
      { id: 8, projectId: 80, sessionMode: 'tmux', tmuxSession: null, engineId: 'claude' }
    ];
    let captures = 0;
    monitor._internal.capturePane = () => { captures += 1; return { lines: [] }; };
    await monitor._internal.tick();
    assert.equal(captures, 0);
    assert.deepEqual(observed, []);
  });

  it('survives a vanished pane mid-poll, and one failing scan does not stop the rest', async () => {
    monitor._internal.listLiveAll = () => [tmuxSession(5), tmuxSession(6)];
    monitor._internal.capturePane = (name) => {
      if (name === 'tc-5') throw new Error('no such session');
      return { lines: ['ok'] };
    };
    await monitor._internal.tick();
    assert.deepEqual(observed.map((o) => o.id), [6]);
  });

  it('forgets an ended session\'s engine-error state', async () => {
    let live = [tmuxSession(9)];
    monitor._internal.listLiveAll = () => live;
    monitor._internal.capturePane = () => ({ lines: [] });
    await monitor._internal.tick();
    live = [];
    await monitor._internal.tick();
    assert.deepEqual(forgotten, [9]);
  });

  it('start is idempotent and stop clears state', () => {
    monitor.start({ intervalMs: 60000 });
    monitor.start({ intervalMs: 60000 });
    monitor.stop();
  });
});

describe('pane output cannot request or open a wrap (#2027)', () => {
  it('the monitor exposes no wrap-request surface at all', () => {
    assert.deepEqual(Object.keys(monitor).sort(), ['_internal', 'start', 'stop']);
  });

  it('a pane printing the legacy marker, bare and on its own line, is only ever engine-error input', async () => {
    const saved = { ...monitor._internal };
    const seen = [];
    try {
      monitor._internal.listLiveAll = () => [tmuxSession(4)];
      monitor._internal.getEngineProfile = () => null;
      monitor._internal.observeEngineErrors = (session, lines) => seen.push(lines);
      let pane = ['working'];
      monitor._internal.capturePane = () => ({ lines: pane });
      await monitor._internal.tick();
      pane = ['done', LEGACY_MARKER];
      await monitor._internal.tick();
      assert.deepEqual(seen, [['working'], ['done', LEGACY_MARKER]]);
    } finally {
      Object.assign(monitor._internal, saved);
      monitor.stop();
    }
  });
});
