'use strict';

/**
 * A scanner child that really hangs, for exercising the supervisor's deadline.
 *
 * WHY A FIXTURE CHILD RATHER THAN THE REAL ONE. The failure being guarded
 * against is a `readdir` that never returns, which happens on a TCC-protected
 * macOS path and cannot be produced on a CI runner: a FIFO — the one portable
 * way to make a filesystem call block — answers `readdir` with `ENOTDIR`
 * immediately (measured; only `open`/`readFile` blocks on one). So the hang is
 * reproduced with the operation that DOES block, in a child that stands in for
 * the real one.
 *
 * What that costs is honesty about scope: this proves the supervisor's contract
 * — a child that stops answering is killed, its callers are told, and the parent
 * process keeps its threadpool — against a genuinely blocked syscall holding a
 * genuine libuv thread. It does not prove anything about `readdir` in
 * particular, and nothing here should be read as if it did.
 */

const fsp = require('node:fs').promises;

process.on('message', (msg) => {
  const { id, op, payload } = msg || {};

  if (op === 'ping') {
    process.send({ id, ok: true, value: { pid: process.pid } });
    return;
  }

  if (op === 'echo') {
    process.send({ id, ok: true, value: payload });
    return;
  }

  if (op === 'crash') {
    process.exit(7);
    return;
  }

  if (op === 'hang') {
    // Opening a FIFO for reading blocks until a writer appears, and libuv
    // performs that open on the threadpool — so this occupies a real pool
    // thread in a real blocked syscall, exactly like the failure it stands in
    // for. Deliberately never replies and never settles.
    fsp.readFile(payload.fifo).catch(() => {});
    return;
  }

  process.send({ id, ok: false, error: { message: `fixture does not know: ${op}`, code: 'ENOSYS' } });
});

process.on('disconnect', () => { process.exit(0); });
