'use strict';

/**
 * Fixture scanner child that PRINTS to stderr, so the supervisor's re-emission
 * can be tested against a real pipe rather than a stub.
 *
 * The real child's diagnostics are the thing under test and they cannot be
 * observed from the child side: `test/dir-scanner-child.test.js` proves a
 * warning leaves the process, and that is all it can prove. Whether anything
 * then carries it to a sink an operator reads is the supervisor's half, and a
 * pipe is what makes it non-trivial — writes are split wherever the kernel
 * likes, so a line can arrive in pieces.
 *
 * This fixture therefore writes deliberately awkward output: a complete line, a
 * line delivered in two chunks with the newline arriving late, and lines at
 * different levels. A stub that emitted whole lines in one write would exercise
 * none of it.
 */

/**
 * Write a string to stderr and resolve once it has actually been flushed.
 *
 * Awaited between chunks so the two halves of the split line reach the parent as
 * SEPARATE `data` events. Without that they coalesce in the pipe buffer, arrive
 * as one chunk, and the partial-line path this fixture exists to exercise is
 * never taken.
 *
 * @param {string} s - Exact bytes to write.
 * @returns {Promise<void>}
 */
function write(s) {
  return new Promise((resolve) => process.stderr.write(s, resolve));
}

process.on('message', async (msg) => {
  const { id, op } = msg || {};

  if (op === 'flood-then-die') {
    // More than the supervisor's 4096-byte death buffer holds, then a nonzero
    // exit. The point is which end survives: the supervisor keeps a bounded TAIL
    // precisely because this stream carries routine chatter as well as crash
    // output, so a long-lived child would otherwise fill the buffer with healthy
    // notices and have no room for what explains the death. The marker lines
    // below sit at the two ends so a test can tell head-bounded from
    // tail-bounded, which is invisible from any other observation.
    // Numbered rather than marked at the two ends only. The very last write
    // races the parent's `exit` event — two different streams, no ordering
    // guarantee — so a test that insisted on the FINAL line would be asserting
    // on a race rather than on the bound. An early index and a late index
    // separate head-bounded from tail-bounded just as decisively and are stable.
    for (let i = 0; i < 60; i++) {
      const n = String(i).padStart(3, '0');
      await write(`[2026-08-09T00:00:00.000Z] [WARN] [fixture] filler-${n} ${'x'.repeat(80)}\n`);
    }
    // Long enough for the parent to drain what was written before `exit` fires.
    await new Promise((r) => setTimeout(r, 200));
    process.exit(3);
  }

  if (op === 'talk') {
    // A well-formed line in the logger's own format, at WARN. The supervisor
    // must preserve that level rather than flattening it to info.
    await write('[2026-08-09T00:00:00.000Z] [WARN] [fixture] cache write failed code=EACCES\n');
    // The same again, at DEBUG, to prove the level is read rather than assumed.
    await write('[2026-08-09T00:00:00.000Z] [DEBUG] [fixture] routine detail\n');
    // One line split across two writes, newline last. The supervisor must hold
    // the first half until the newline arrives and emit ONE line, not two.
    await write('[2026-08-09T00:00:00.000Z] [WARN] [fixture] split ');
    await new Promise((r) => setTimeout(r, 30));
    await write('across two chunks\n');
    // Output in no known format — a native warning or a stack. Must not be
    // dropped just because it does not parse.
    await write('Something the runtime printed by itself\n');
    // Give the parent's `data` handlers a turn before the reply, so the test
    // does not race the flush.
    await new Promise((r) => setTimeout(r, 50));
  }

  if (process.connected) process.send({ id, ok: true, value: { pid: process.pid } });
});

process.on('disconnect', () => { process.exit(0); });
