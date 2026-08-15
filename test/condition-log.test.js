'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConditionLog } = require('../lib/condition-log');
const { setConsoleStream, setLevel } = require('../lib/logger');
const tmux = require('../lib/tmux');

/**
 * Capture every log line written while `fn` runs, at debug level so the quiet
 * repeats are visible — the whole point of this mechanism is that the repeats
 * still reach the log, just not at a level that buries anything.
 * @param {Function} fn - Body to run; may be async.
 * @returns {Promise<string[]>} The captured lines.
 */
async function captured(fn) {
  const lines = [];
  setConsoleStream({ write: (s) => lines.push(s) });
  setLevel('debug');
  try {
    await fn();
  } finally {
    setConsoleStream(null);
    setLevel('info');
  }
  return lines;
}

/**
 * Count captured lines carrying a level tag.
 * @param {string[]} lines - Captured output.
 * @param {string} level - `WARN`, `ERROR`, `DEBUG`.
 * @param {RegExp} match - Message matcher, so unrelated lines do not count.
 * @returns {number}
 */
function countAt(lines, level, match) {
  return lines.filter((l) => l.includes(`[${level}]`) && match.test(l)).length;
}

describe('condition log — loud once, quiet while it persists, loud on recurrence', () => {
  const fakeLog = () => {
    const calls = [];
    const rec = (level) => (message, meta) => calls.push({ level, message, meta });
    return { calls, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
  };

  it('reports the first occurrence at the caller\'s level and repeats at debug', () => {
    // THE MUTATION THIS CATCHES: dropping the `active.has(key)` check, so every
    // poll reports at full volume — the ten-second flood #906 was filed for.
    const log = fakeLog();
    const cl = createConditionLog(log);

    cl.report('k', 'error', 'wedged');
    cl.report('k', 'error', 'wedged');
    cl.report('k', 'error', 'wedged');

    assert.deepEqual(log.calls.map((c) => c.level), ['error', 'debug', 'debug'],
      'the condition is news once; while it holds it is evidence, not news');
  });

  it('goes loud again after the condition resolves', () => {
    // THE MUTATION THIS CATCHES: deleting the `active.delete(key)` in
    // `resolved`, i.e. a plain warn-once. A wedge that recurs an hour after a
    // recovery is a NEW incident, and a plain warn-once reports it only as a
    // debug line under a warning from before the recovery — which reads as one
    // continuous condition that was already acknowledged.
    const log = fakeLog();
    const cl = createConditionLog(log);

    cl.report('k', 'warn', 'wedged');
    cl.report('k', 'warn', 'wedged');
    cl.resolved('k');
    cl.report('k', 'warn', 'wedged');

    assert.deepEqual(log.calls.map((c) => c.level), ['warn', 'debug', 'warn'],
      'the second incident must be as loud as the first');
  });

  it('keeps conditions independent, so one silence does not mute another', () => {
    // THE MUTATION THIS CATCHES: a single boolean instead of a keyed set —
    // which would make the first unreachable pane silence the first report
    // about every other pane.
    const log = fakeLog();
    const cl = createConditionLog(log);

    cl.report('a', 'warn', 'a is wedged');
    cl.report('b', 'warn', 'b is wedged');

    assert.deepEqual(log.calls.map((c) => c.level), ['warn', 'warn']);
  });

  it('releases the key on resolve, so keys do not accumulate for the process life', () => {
    const log = fakeLog();
    const cl = createConditionLog(log);
    cl.report('a', 'warn', 'x');
    cl.report('b', 'warn', 'x');
    assert.equal(cl._size(), 2);
    cl.resolved('a');
    cl.resolved('b');
    assert.equal(cl._size(), 0,
      'a resolved condition must leave nothing behind — this set lives as long as the process');
  });

  it('passes structured context through untouched', () => {
    const log = fakeLog();
    const cl = createConditionLog(log);
    cl.report('k', 'error', 'wedged', { timeout: 5000 });
    assert.deepEqual(log.calls[0].meta, { timeout: 5000 },
      'the cadence must not cost the diagnostic detail that makes the line worth reading');
  });
});

describe('the tmux session listing reports a wedge at the condition\'s cadence, not the poll\'s', () => {
  let binDir = null;
  const realPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = realPath;
    if (binDir) fs.rmSync(binDir, { recursive: true, force: true });
    binDir = null;
    tmux._conditionLog.resolved(tmux._TMUX_UNREACHABLE);
  });

  // Two budgets, because the two modes need opposite things from one.
  //
  // A read meant to TIME OUT wants a small budget so the test is quick; a read
  // meant to ANSWER needs one comfortably above the cost of spawning a shell
  // script, which on a loaded machine is well over 200ms. Sharing one small
  // budget made the answering read time out under parallel load and the
  // "recovery" tests failed 11 runs in 12 — measuring the machine, not the code.
  //
  // Splitting them is honest rather than a dodge: what is under test here is the
  // CADENCE logic, and which mode each read is in is something the test decides.
  // That a killed probe is classified as unanswered at all is pinned separately
  // in `test/tmux.test.js`, against a real stalling `tmux`.
  const STALL_MS = 200;
  const ANSWER_MS = 5000;

  /**
   * Put a controllable `tmux` on PATH. Driven by a REAL stalling binary rather
   * than a stub, because the subject is a timeout and the repo has been bitten
   * three times by hand-written models of one (#891/#894).
   * @returns {{stall: () => Promise<object>, answer: () => Promise<object>}}
   *   Mode switches that also perform the read at the matching budget.
   */
  function shim() {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cadence-tmux-'));
    const flag = path.join(binDir, 'STALL');
    fs.writeFileSync(path.join(binDir, 'tmux'),
      `#!/bin/sh\nif [ -f ${flag} ]; then exec sleep 30; fi\necho tc-alive\n`,
      { mode: 0o755 });
    process.env.PATH = `${binDir}:${realPath}`;
    // A fresh snapshot per read on purpose: the snapshot memoises one answer for
    // one list, so several reads through ONE snapshot would spawn one tmux and
    // prove nothing about cadence.
    const read = (timeout) => tmux.createSessionNameSnapshot({ timeout }).get();
    return {
      async stall() {
        fs.writeFileSync(flag, '');
        return read(STALL_MS);
      },
      async answer() {
        fs.rmSync(flag, { force: true });
        return read(ANSWER_MS);
      }
    };
  }

  it('says it once, then keeps the repeats at debug', async () => {
    // Driven through `createSessionNameSnapshot`, which is what `GET
    // /api/projects` really calls — a fixture that called `_readSessionNames`
    // directly would measure a path no poll takes (#895).
    const mode = shim();

    const lines = await captured(async () => {
      for (let i = 0; i < 3; i++) await mode.stall();
    });

    const msg = /session listing timed out/;
    assert.equal(countAt(lines, 'ERROR', msg), 1,
      'three polls into a wedged server is one incident, not three');
    assert.equal(countAt(lines, 'DEBUG', msg), 2,
      'the repeats stay in the log as evidence — they just stop shouting');
  });

  it('is loud again when the wedge returns after a recovery', async () => {
    // THE MUTATION THIS CATCHES: never calling `resolved` on the answered path.
    // The listing would then report the SECOND wedge as a debug line under an
    // error from before the recovery — the operator reading the log during
    // incident two sees no error for it at all.
    const mode = shim();

    const lines = await captured(async () => {
      await mode.stall();
      const recovered = await mode.answer();
      assert.equal(recovered.answered, true,
        'precondition: the middle read must genuinely answer, or this measures nothing');
      await mode.stall();
    });

    assert.equal(countAt(lines, 'ERROR', /session listing timed out/), 2,
      'two wedges separated by a working read are two incidents');
  });

  it('treats a tmux that answered "no server running" as a recovery', async () => {
    // The ordinary state of a machine with no sessions is an exit-1 answer, and
    // it is still an ANSWER — the server replied. Re-arming on it matters
    // because that is the shape a recovering tmux most often takes first.
    const mode = shim();
    await mode.stall();
    assert.equal(tmux._conditionLog._size(), 1, 'the wedge is being tracked');

    // `exit 1` with no output is how tmux reports no server; the snapshot maps
    // that to answered-with-an-empty-set.
    fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const verdict = await tmux.createSessionNameSnapshot({ timeout: ANSWER_MS }).get();

    assert.equal(verdict.answered, true, 'precondition: an exit-1 reply is an answer');
    assert.equal(tmux._conditionLog._size(), 0,
      'a server that replied is not a wedged one, so the next wedge is news again');
  });
});
