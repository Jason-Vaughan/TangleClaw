'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const integrity = require('../lib/soak/integrity');

let home;
let dbPath;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-integrity-')));
  dbPath = path.join(home, 'tangleclaw.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'a\');');
  db.close();
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/**
 * A `runCommand` stand-in for `ps` and `lsof`.
 * @param {object} [opt] - `{rss, fds, psFails}`
 * @returns {Function} Runner
 */
function procRunner(opt = {}) {
  return async (file) => {
    if (file === 'ps') return opt.psFails ? { code: 1, stdout: '', stderr: '', error: '1' } : { code: 0, stdout: `  ${opt.rss || 51234}\n`, stderr: '', error: null };
    if (file === 'lsof') return { code: 0, stdout: `p42\n${Array.from({ length: opt.fds || 3 }, (_, i) => `f${i}`).join('\n')}\nfcwd\n`, stderr: '', error: null };
    throw new Error(`unexpected ${file}`);
  };
}

/**
 * A fetch answering `/api/health`.
 * @param {number} [status] - Status to answer
 * @returns {Function} Fetch
 */
function health(status = 200) {
  return async () => ({ status, text: async () => JSON.stringify({ status: status === 200 ? 'ok' : 'degraded', services: { database: status === 200 ? 'ok' : 'error' } }) });
}

describe('soak integrity — the database check', () => {
  it('reads an intact database as ok, with either check', () => {
    assert.deepEqual(integrity.checkDatabase(dbPath, 'quick_check'), { check: 'quick_check', state: 'ok' });
    assert.deepEqual(integrity.checkDatabase(dbPath, 'integrity_check'), { check: 'integrity_check', state: 'ok' });
  });

  it('reads a file that is not a database as corrupt', () => {
    fs.writeFileSync(dbPath, 'not a database '.repeat(200));
    const r = integrity.checkDatabase(dbPath, 'quick_check');
    assert.equal(r.state, 'corrupt');
    assert.match(r.error, /not a database/);
  });

  it('reads damaged pages as corrupt', () => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE big (v TEXT); CREATE INDEX big_v ON big (v);');
    const ins = db.prepare('INSERT INTO big VALUES (?)');
    for (let i = 0; i < 2000; i++) ins.run(`row-${i}-${'x'.repeat(50)}`);
    db.close();
    const buf = fs.readFileSync(dbPath);
    // Scribble over the middle of the file, past the header page.
    buf.fill(0x5a, Math.floor(buf.length / 2), Math.floor(buf.length / 2) + 4096);
    fs.writeFileSync(dbPath, buf);
    const r = integrity.checkDatabase(dbPath, 'integrity_check');
    assert.equal(r.state, 'corrupt', JSON.stringify(r));
  });

  it('reads a database another connection holds locked as unavailable, not corrupt', () => {
    const holder = new DatabaseSync(dbPath);
    holder.exec('BEGIN EXCLUSIVE');
    try {
      const r = integrity.checkDatabase(dbPath, 'quick_check', { busyMs: 50 });
      assert.equal(r.state, 'unavailable', JSON.stringify(r));
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('reads a missing database as unavailable, and never creates it', () => {
    fs.rmSync(dbPath);
    assert.equal(integrity.checkDatabase(dbPath, 'quick_check').state, 'unavailable');
    assert.equal(fs.existsSync(dbPath), false);
  });
});

describe('soak integrity — the server process', () => {
  it('reads both pidfile forms the server writes, and nothing else', () => {
    const pidPath = path.join(home, 'tangleclaw.pid');
    assert.equal(integrity.readServerPid(home), null);
    fs.writeFileSync(pidPath, JSON.stringify({ pid: 4321, writtenAt: 1 }));
    assert.equal(integrity.readServerPid(home), 4321);
    fs.writeFileSync(pidPath, '4321\n');
    assert.equal(integrity.readServerPid(home), 4321);
    for (const bad of ['{"pid":', '-3', '12abc', '{"pid":0}']) {
      fs.writeFileSync(pidPath, bad);
      assert.equal(integrity.readServerPid(home), null, bad);
    }
  });

  it('reads memory and descriptors of the pid the pidfile names', async () => {
    fs.writeFileSync(path.join(home, 'tangleclaw.pid'), JSON.stringify({ pid: 42, writtenAt: Date.now() }));
    assert.deepEqual(await integrity.processStats(home, procRunner({ rss: 9000, fds: 5 })), { pid: 42, alive: true, rssKb: 9000, openFds: 5 });
  });

  it('reports a gone process as down, and an unreadable one as unknown with its reason', async () => {
    assert.deepEqual(await integrity.processStats(home, procRunner()), { pid: null, alive: false, rssKb: null, openFds: null, reason: 'no-pidfile' });
    fs.writeFileSync(path.join(home, 'tangleclaw.pid'), JSON.stringify({ pid: 42, writtenAt: Date.now() }));
    const gone = await integrity.processStats(home, procRunner({ psFails: true }));
    assert.deepEqual([gone.alive, gone.reason], [false, 'not-running']);
    const hung = await integrity.processStats(home, async (file) => (file === 'ps' ? { code: null, stdout: '', stderr: '', error: 'timeout' } : { code: 0, stdout: '', stderr: '', error: null }));
    assert.deepEqual([hung.alive, hung.reason], [null, 'ps-failed:timeout']);
    const noLsof = await integrity.processStats(home, async (file) => (file === 'ps' ? { code: 0, stdout: '100\n', stderr: '', error: null } : { code: 1, stdout: '', stderr: '', error: '1' }));
    assert.deepEqual([noLsof.alive, noLsof.rssKb, noLsof.openFds, noLsof.reason], [true, 100, null, 'lsof-failed:1']);
  });

  it('reads the pidfile exactly as the server writes it', () => {
    // lib/pidfile.js is the server's writer; the soak reads it independently,
    // so this pins the two to the same name and format.
    const pidfile = require('../lib/pidfile');
    pidfile.write(home);
    assert.equal(integrity.readServerPid(home), pidfile.readPid(home));
    assert.equal(integrity.readServerPid(home), process.pid);
  });
});

describe('soak integrity — the sampler', () => {
  /**
   * Sampler options with an instant clock.
   * @param {object} [over] - Overrides
   * @returns {object} Options
   */
  function opts(over = {}) {
    let t = 1_790_000_000_000;
    return { file: path.join(home, 'samples.ndjson'), home, apiBase: 'http://127.0.0.1:3102', token: null, fetch: health(), intervalMs: 600000, count: 3, clock: { now: () => t, sleep: async (ms) => { t += ms; } }, shouldStop: () => false, run: procRunner(), ...over };
  }

  it('writes a header and samples, owner-only, with a full check first', async () => {
    const r = await integrity.runSampler(opts({ fullEvery: 2 }));
    assert.deepEqual(r, { taken: 3, lastSeq: 2 });
    const o = opts();
    assert.equal(fs.statSync(o.file).mode & 0o777, 0o600);
    const read = integrity.readSamples(o.file);
    assert.equal(read.header.schema, integrity.SAMPLES_SCHEMA);
    assert.equal(read.header.home, home);
    assert.deepEqual(read.samples.map((x) => [x.seq, x.db.check]), [[0, 'integrity_check'], [1, 'quick_check'], [2, 'integrity_check']]);
    const s0 = read.samples[0];
    assert.equal(s0.db.state, 'ok');
    assert.equal(s0.db.bytes, fs.statSync(dbPath).size);
    assert.ok(s0.disk.freeBytes > 0 && s0.disk.totalBytes >= s0.disk.freeBytes);
    assert.deepEqual(s0.health, { status: 200, code: 'OK', reported: 'ok', database: 'ok' });
    assert.equal(read.samples[1].at - s0.at, 600000);
    assert.equal(fs.existsSync(`${o.file}.lock`), false, 'releases its lock');
  });

  it('continues an existing file where it stopped', async () => {
    await integrity.runSampler(opts({ count: 2 }));
    const r = await integrity.runSampler(opts({ count: 2 }));
    assert.deepEqual(r, { taken: 2, lastSeq: 3 });
    const read = integrity.readSamples(opts().file);
    assert.deepEqual(read.samples.map((x) => x.seq), [0, 1, 2, 3]);
  });

  it('refuses a file that belongs to another home, or ends torn', async () => {
    await integrity.runSampler(opts({ count: 1 }));
    await assert.rejects(integrity.runSampler(opts({ home: '/elsewhere' })), (e) => e.code === 'SAMPLES_MISMATCH');
    fs.appendFileSync(opts().file, '{"type":"sam');
    await assert.rejects(integrity.runSampler(opts()), (e) => e.code === 'SAMPLES_TORN');
  });

  it('refuses a file damaged in the middle', () => {
    const file = opts().file;
    fs.writeFileSync(file, '{"type":"header"}\nnot json\n{"type":"sample"}\n');
    assert.throws(() => integrity.readSamples(file), (e) => e.code === 'SAMPLES_UNREADABLE');
  });

  it('refuses a second live sampler, and takes over a dead one\'s lock', async () => {
    const file = opts().file;
    fs.writeFileSync(`${file}.lock`, String(process.pid));
    await assert.rejects(integrity.runSampler(opts()), (e) => e.code === 'SAMPLER_LOCKED');
    fs.writeFileSync(`${file}.lock`, '2147483646');
    assert.deepEqual(await integrity.runSampler(opts({ count: 1 })), { taken: 1, lastSeq: 0 });
  });

  it('stops promptly when asked, between samples', async () => {
    let asked = 0;
    const r = await integrity.runSampler(opts({ count: undefined, shouldStop: () => ++asked > 3 }));
    assert.ok(r.taken >= 1 && r.taken <= 2, JSON.stringify(r));
  });

  it('records a sample that throws, and keeps sampling', async () => {
    let n = 0;
    const flaky = { ...fs, statfsSync: (...a) => { if (n++ === 0) { const e = new Error('io'); e.code = 'EIO'; throw e; } return fs.statfsSync(...a); } };
    const r = await integrity.runSampler(opts({ count: 2, fs: flaky }));
    assert.deepEqual(r, { taken: 2, lastSeq: 1 });
    const read = integrity.readSamples(opts().file);
    assert.deepEqual(read.samples.map((x) => [x.seq, x.type]), [[0, 'sample-failed'], [1, 'sample']]);
    assert.equal(read.samples[0].error, 'EIO');
  });

  it('records a health failure and a missing process, and carries on', async () => {
    await integrity.runSampler(opts({ count: 1, fetch: health(503) }));
    const s = integrity.readSamples(opts().file).samples[0];
    assert.equal(s.health.status, 503);
    assert.equal(s.process.alive, false);
  });
});
