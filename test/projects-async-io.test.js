'use strict';

// #1350 Slice 1 (v5.61.0 Car 61-D, Architect Ruling A1350): the async,
// bounded, non-blocking project-path I/O primitive layer, via
// `lib/projects-async-io.js`. Real temp fixtures for the ordinary
// read/stat/scan/cache behavior; `_internal.fs` is replaced with a
// controlled fake ONLY for the timeout and concurrency-bound tests, which
// need deterministic delay a real local filesystem cannot give them.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const io = require('../lib/projects-async-io');

let tmp;
let realFs;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-projects-async-io-'));
  realFs = io._internal.fs;
  io._clearCaches();
});

afterEach(() => {
  io._internal.fs = realFs;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readProjectFileAsync', () => {
  it('reads a real file\'s content', async () => {
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'hello');
    assert.equal(await io.readProjectFileAsync(file), 'hello');
  });

  it('rejects with the real fs error for a missing file -- never swallowed', async () => {
    await assert.rejects(() => io.readProjectFileAsync(path.join(tmp, 'nope.txt')), (err) => err.code === 'ENOENT');
  });

  it('caches a successful read for the TTL window, even after the file changes on disk', async () => {
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'first');
    assert.equal(await io.readProjectFileAsync(file), 'first');
    fs.writeFileSync(file, 'second');
    assert.equal(await io.readProjectFileAsync(file), 'first', 'served from cache, not re-read');
    assert.equal(await io.readProjectFileAsync(file, { noCache: true }), 'second', 'noCache bypasses it both ways');
  });

  it('never caches a rejection -- the very next call retries for real', async () => {
    const file = path.join(tmp, 'a.txt');
    await assert.rejects(() => io.readProjectFileAsync(file));
    fs.writeFileSync(file, 'now it exists');
    assert.equal(await io.readProjectFileAsync(file), 'now it exists');
  });
});

describe('statProjectPathAsync', () => {
  it('reports exists: true with real stats for a real path', async () => {
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'x');
    const r = await io.statProjectPathAsync(file);
    assert.equal(r.exists, true);
    assert.equal(r.stats.isFile(), true);
  });

  it('reports exists: false for a missing path -- the existsSync shape, not a thrown error', async () => {
    const r = await io.statProjectPathAsync(path.join(tmp, 'nope'));
    assert.deepEqual(r, { exists: false, stats: null });
  });

  it('still rejects on a non-ENOENT stat failure (e.g. a path through a non-directory)', async () => {
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'x');
    await assert.rejects(() => io.statProjectPathAsync(path.join(file, 'child')), (err) => err.code === 'ENOTDIR');
  });

  it('lstat vs stat: followSymlinks false reports the link itself, not its target', async () => {
    const target = path.join(tmp, 'target.txt');
    const link = path.join(tmp, 'link.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, link);
    const followed = await io.statProjectPathAsync(link, { noCache: true });
    const unfollowed = await io.statProjectPathAsync(link, { followSymlinks: false, noCache: true });
    assert.equal(followed.stats.isFile(), true);
    assert.equal(unfollowed.stats.isSymbolicLink(), true);
  });
});

describe('scanProjectMetadataAsync', () => {
  it('lists a real directory\'s own entries', async () => {
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'x');
    const names = (await io.scanProjectMetadataAsync(tmp)).slice().sort();
    assert.deepEqual(names, ['f.txt', 'sub']);
  });

  it('answers [] for a missing directory -- the readdirSync-caller shape, not a thrown error', async () => {
    assert.deepEqual(await io.scanProjectMetadataAsync(path.join(tmp, 'nope')), []);
  });

  it('still rejects on a non-ENOENT failure (e.g. scanning a plain file as a directory)', async () => {
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'x');
    await assert.rejects(() => io.scanProjectMetadataAsync(file), (err) => err.code === 'ENOTDIR');
  });

  it('withFileTypes returns Dirent entries naming their own kind', async () => {
    fs.mkdirSync(path.join(tmp, 'sub'));
    const entries = await io.scanProjectMetadataAsync(tmp, { withFileTypes: true });
    assert.equal(entries[0].isDirectory(), true);
  });
});

describe('TimeoutError and the deadline (fake, delayed fs)', () => {
  it('rejects with TimeoutError when the underlying op outlasts the deadline, without cancelling it', async () => {
    let resolveSlow;
    const slow = new Promise((resolve) => { resolveSlow = resolve; });
    io._internal.fs = { ...realFs, readFile: () => slow };
    const call = io.readProjectFileAsync('/whatever', { timeoutMs: 20, noCache: true });
    await assert.rejects(call, (err) => err instanceof io.TimeoutError && err.code === 'PROJECTS_ASYNC_IO_TIMEOUT');
    resolveSlow('eventually'); // the real op is never cancelled -- let it settle so nothing leaks past this test.
  });

  it('rejects promptly at the configured deadline, not after some much longer real wait', async () => {
    io._internal.fs = { ...realFs, readFile: () => new Promise(() => {}) };
    const start = Date.now();
    await assert.rejects(io.readProjectFileAsync('/whatever', { timeoutMs: 15, noCache: true }), io.TimeoutError);
    assert.ok(Date.now() - start < 1000, 'rejected promptly');
  });

  it('an explicit timeoutMs: 0 disables the deadline entirely, rather than firing immediately', async () => {
    io._internal.fs = { ...realFs, readFile: () => new Promise((resolve) => setTimeout(() => resolve('eventually'), 20)) };
    assert.equal(await io.readProjectFileAsync('/whatever', { timeoutMs: 0, noCache: true }), 'eventually');
  });
});

describe('bounded concurrency (fake, delayed fs)', () => {
  it('never runs more than the configured limit of this reader\'s own operations at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    io._internal.fs = {
      ...realFs,
      readFile: () => new Promise((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => { inFlight -= 1; resolve('x'); }, 20);
      })
    };
    const calls = Array.from({ length: io.DEFAULT_CONCURRENCY + 4 }, (_, i) => io.readProjectFileAsync(`/f${i}`, { noCache: true }));
    await Promise.all(calls);
    assert.ok(maxInFlight <= io.DEFAULT_CONCURRENCY, `max in flight ${maxInFlight} exceeded the configured bound ${io.DEFAULT_CONCURRENCY}`);
  });

  it('a later call still completes once an earlier one frees its slot, never starved', async () => {
    const order = [];
    io._internal.fs = {
      ...realFs,
      readFile: (p) => new Promise((resolve) => setTimeout(() => { order.push(p); resolve('x'); }, 5))
    };
    const calls = Array.from({ length: io.DEFAULT_CONCURRENCY + 2 }, (_, i) => io.readProjectFileAsync(`/f${i}`, { noCache: true }));
    await Promise.all(calls);
    assert.equal(order.length, io.DEFAULT_CONCURRENCY + 2);
  });
});
