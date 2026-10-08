'use strict';

/*
 * `tmux.readPaneAsync` (#2086): the pane read that does not block the event
 * loop. A stand-in program takes tmux's place, so these run real child
 * processes: what is under test is that a wedged one is killed and reaped,
 * that the loop keeps turning while it is waited on, and that a session name
 * reaches the program as one argument, never as shell text.
 *
 * Every bound on elapsed time here is loose on purpose. The assertions are
 * about which thing happened, and a loaded machine must not turn them red.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const logger = require('../lib/logger');

const tmux = require('../lib/tmux');

let dir;
let fake;
const saved = { ...tmux._async };

/**
 * Whether a process is still alive.
 * @param {number} pid - Process id
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until `test` is true or `ms` pass.
 * @param {() => boolean} test - Condition
 * @param {number} ms - Longest wait
 * @returns {Promise<boolean>} Whether it became true
 */
async function eventually(test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return test();
}

before(() => {
  // A timed-out read logs an error by design; these tests make it happen on purpose.
  logger.setConsoleStream({ write: () => {} });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-read-pane-'));
  fake = path.join(dir, 'fake-tmux');
  // A stand-in for tmux. `mode` picks how it behaves; every call appends its
  // pid and its arguments, one per line, to the log.
  fs.writeFileSync(fake, `#!/bin/sh
mode=$(cat "${dir}/mode" 2>/dev/null)
echo "pid $$" >> "${dir}/log"
for a in "$@"; do echo "arg $a" >> "${dir}/log"; done
case "$mode" in
  hang) exec sleep 30 ;;
  absent) [ "$1" = "has-session" ] && exit 1 ;;
  slow-each) sleep 0.4 ;;
  no-cursor) [ "$1" = "display-message" ] && { echo ","; exit 0; } ;;
  capture-fails) [ "$1" = "capture-pane" ] && exit 1 ;;
  cursor-shown) [ "$1" = "display-message" ] && { echo "0,3,1,1"; exit 0; } ;;
  cursor-hidden) [ "$1" = "display-message" ] && { echo "0,3,1,0"; exit 0; } ;;
  cursor-flag-odd) [ "$1" = "display-message" ] && { echo "0,3,1,?"; exit 0; } ;;
esac
case "$1" in
  has-session) exit 0 ;;
  display-message) echo "0,3,1" ;;
  capture-pane) printf 'line one\\nline two\\n' ;;
esac
`, { mode: 0o755 });
});

after(() => {
  logger.setConsoleStream(null);
  Object.assign(tmux._async, saved);
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(dir, 'log'), { force: true });
  fs.writeFileSync(path.join(dir, 'mode'), 'ok');
  tmux._async.bin = fake;
});

afterEach(() => { Object.assign(tmux._async, saved); });

/**
 * Set how the stand-in behaves.
 * @param {string} mode - One of the script's modes
 * @returns {void}
 */
const mode = (m) => fs.writeFileSync(path.join(dir, 'mode'), m);

/**
 * The stand-in's log, as lines.
 * @returns {string[]}
 */
const logLines = () => (fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8').split('\n').filter(Boolean) : []);

describe('readPaneAsync — what it answers', () => {
  it('returns the pane tail and the cursor from four commands', async () => {
    const got = await tmux.readPaneAsync('proj', { lines: 15 });
    assert.deepEqual(got.cap, { lines: ['line one', 'line two'], alternateScreen: false });
    // This stand-in reports no cursor flag, so whether the cursor is shown is "not known".
    assert.deepEqual(got.cursor, { x: 3, y: 1, line: 'line one\nline two', visible: null });
    assert.equal(logLines().filter((l) => l.startsWith('pid ')).length, 4);
    assert.ok(logLines().includes('arg -15'), 'the tail length is passed to the capture');
  });

  it('says whether the cursor is shown, from the same display-message, and never guesses', async () => {
    mode('cursor-shown');
    assert.equal((await tmux.readPaneAsync('proj')).cursor.visible, true);
    mode('cursor-hidden');
    assert.equal((await tmux.readPaneAsync('proj')).cursor.visible, false);
    mode('cursor-flag-odd');
    assert.equal((await tmux.readPaneAsync('proj')).cursor.visible, null, 'anything but 1 or 0 is not known');
    assert.ok(logLines().includes('arg #{alternate_on},#{cursor_x},#{cursor_y},#{cursor_flag}'), 'asked in the one query, not a fifth command');
  });

  it('rejects for a session tmux says is absent, and that is not a timeout', async () => {
    mode('absent');
    await assert.rejects(tmux.readPaneAsync('gone'), (err) => /does not exist/.test(err.message) && !err.tcTimedOut);
  });

  it('answers with no cursor when tmux reports none, and still returns the pane', async () => {
    mode('no-cursor');
    const got = await tmux.readPaneAsync('proj');
    assert.equal(got.cursor, null);
    assert.deepEqual(got.cap.lines, ['line one', 'line two']);
  });

  it('answers with no lines when the capture fails, as capturePane does', async () => {
    mode('capture-fails');
    const got = await tmux.readPaneAsync('proj');
    assert.deepEqual(got.cap.lines, []);
  });
});

describe('readPaneAsync — no shell is involved', () => {
  it('a session name full of shell syntax reaches the program as one argument', async () => {
    const marker = path.join(dir, 'pwned');
    const name = `x'; touch ${marker}; echo '$(touch ${marker})`;
    await tmux.readPaneAsync(name).catch(() => {});
    assert.equal(fs.existsSync(marker), false, 'nothing in the name was executed');
    assert.ok(logLines().includes(`arg =${name}:`), 'the name arrived whole, as an exact-match target');
  });
});

describe('readPaneAsync — a wedged tmux', () => {
  it('rejects as timed out, and the child is killed and gone', async () => {
    mode('hang');
    const started = Date.now();
    await assert.rejects(tmux.readPaneAsync('proj', { timeout: 300 }), (err) => err.tcTimedOut === true);
    assert.ok(Date.now() - started < 10000, 'it did not wait for the program to finish');
    const pids = logLines().filter((l) => l.startsWith('pid ')).map((l) => Number(l.slice(4)));
    assert.equal(pids.length, 1, 'the read stopped at the first command');
    assert.ok(await eventually(() => !alive(pids[0]), 5000), `process ${pids[0]} is still running`);
  });

  it('the timeout bounds the whole read, not each command', async () => {
    mode('slow-each');
    // Four commands at 0.4 s each would take 1.6 s; the read is given 1 s.
    await assert.rejects(tmux.readPaneAsync('proj', { timeout: 1000 }), (err) => err.tcTimedOut === true);
    assert.ok(logLines().filter((l) => l.startsWith('pid ')).length < 4, 'it did not run all four');
  });

  it('twenty wedged reads leave the event loop turning while they are waited on', async () => {
    mode('hang');
    let turns = 0;
    const timer = setInterval(() => { turns += 1; }, 10);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => tmux.readPaneAsync(`proj${i}`, { timeout: 600 })));
    clearInterval(timer);
    assert.ok(results.every((r) => r.status === 'rejected' && r.reason.tcTimedOut === true));
    assert.ok(turns >= 5, `the loop turned ${turns} times during the wait`);
    const pids = logLines().filter((l) => l.startsWith('pid ')).map((l) => Number(l.slice(4)));
    assert.equal(pids.length, 20);
    assert.ok(await eventually(() => pids.every((p) => !alive(p)), 5000), 'a wedged child outlived its read');
  });
});

describe('probeSessionAsync — the three answers', () => {
  it('says live for a session tmux has', async () => {
    assert.deepEqual(await tmux.probeSessionAsync('proj', 2000), { live: true, answered: true, cause: null });
  });

  it('says not live, and answered, for one tmux says is absent', async () => {
    mode('absent');
    assert.deepEqual(await tmux.probeSessionAsync('gone', 2000), { live: false, answered: true, cause: null });
  });

  it('says not answered when tmux says nothing in time', async () => {
    mode('hang');
    assert.deepEqual(await tmux.probeSessionAsync('proj', 300), { live: false, answered: false, cause: 'read-timed-out' });
  });

  it('says not answered when tmux cannot be run at all, never that the session is absent', async () => {
    tmux._async.bin = path.join(dir, 'no-such-program');
    assert.deepEqual(await tmux.probeSessionAsync('proj', 2000), { live: false, answered: false, cause: 'probe-failed' });
    await assert.rejects(tmux.readPaneAsync('proj'), (err) => err.tcTimedOut === true && /no answer/.test(err.message));
  });
});
