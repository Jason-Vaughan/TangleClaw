'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const faults = require('../lib/soak/faults');
const ex = require('../lib/soak/executors');
const sched = require('../lib/soak/schedule');
const tmux = require('../lib/tmux');

const F = faults.FAULT_EXECUTORS;
const O = faults.FAULT_OUTCOME;

/**
 * A fetch stand-in answering from a script. The script sees each request and
 * returns `{status, body}`, or an Error to reject the fetch.
 * @param {(req: {method: string, path: string, body: *}) => object|Error} answer - Response per request
 * @returns {{fetch: Function, calls: object[]}} The fake and its log
 */
function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = { method: init.method, path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(req);
    const r = answer(req);
    if (r instanceof Error) throw r;
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return { status: r.status, text: async () => text };
  };
  return { fetch, calls };
}

/**
 * A fake clock: sleeping advances it instantly, so a whole poll budget runs
 * without waiting.
 * @returns {{now: Function, sleep: Function}} Clock
 */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

/**
 * A call context with local control.
 * @param {Function} fetch - Fetch implementation
 * @param {object} [localOver] - Overrides for `ctx.local`
 * @returns {object} Context
 */
function ctx(fetch, localOver = {}) {
  const clock = fakeClock();
  return {
    apiBase: 'http://127.0.0.1:3102/',
    token: null,
    fetch,
    ...clock,
    eventIndex: 7,
    runKey: 'abcdef0123456789-1700000000000',
    local: { home: '/nonexistent', dbPath: '/nonexistent/tangleclaw.db', uid: process.getuid(), phase: 'certifying', webdriver: null, run: async () => { throw new Error('no command expected'); }, ...localOver }
  };
}

describe('soak faults — the catalogue', () => {
  it('has an executor for every fault kind and nothing else', () => {
    assert.deepEqual(Object.keys(F).sort(), sched.FAULTS.map((f) => f.kind).sort());
  });

  it('refuses every fault without local control, sending nothing', async () => {
    for (const [kind, run] of Object.entries(F)) {
      const f = fakeFetch(() => ({ status: 200, body: {} }));
      const c = ctx(f.fetch);
      delete c.local;
      const r = await run(c, { project: 'soak-a' });
      assert.equal(r.code, O.NO_LOCAL_CONTROL, kind);
      assert.equal(f.calls.length, 0, kind);
    }
  });

  it('derives tmux names exactly as the server does', () => {
    for (const n of ['soak-a', 'soak-b', 'My Project', 'a.b/c', 'x  y']) assert.equal(faults.tmuxName(n), tmux.toSessionName(n), n);
  });
});

describe('soak faults — server restart', () => {
  it('restarts through the route and waits for a new start time', async () => {
    let restarted = false;
    let downReads = 0;
    const f = fakeFetch((req) => {
      if (req.path === '/api/server/restart') { restarted = true; return { status: 202, body: { ok: true } }; }
      if (req.path === '/api/server-info') {
        if (!restarted) return { status: 200, body: { startedAt: 'A' } };
        // The old process is going away: two refused reads, then the new one.
        if (downReads++ < 2) return new Error('ECONNREFUSED');
        return { status: 200, body: { startedAt: 'B' } };
      }
      if (req.path === '/api/health') return { status: 200, body: { status: 'ok' } };
      return { status: 404 };
    });
    const r = await F['fault.server.restart'](ctx(f.fetch));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(typeof r.restartMs, 'number');
    const post = f.calls.find((c) => c.path === '/api/server/restart');
    assert.deepEqual(post.body, {});
  });

  it('records a server with no restart mechanism', async () => {
    const f = fakeFetch((req) => (req.path === '/api/server/restart' ? { status: 501, body: { error: 'no' } } : { status: 200, body: { startedAt: 'A' } }));
    const r = await F['fault.server.restart'](ctx(f.fetch));
    assert.equal(r.code, O.NO_RESTART_MECHANISM);
  });

  it('retries a restart a wrap blocks, never forcing it', async () => {
    let tries = 0;
    let restarted = false;
    const f = fakeFetch((req) => {
      if (req.path === '/api/server/restart') {
        if (tries++ < 2) return { status: 409, body: { code: 'WRAP_RESTART_BLOCKED' } };
        restarted = true;
        return { status: 202, body: {} };
      }
      if (req.path === '/api/server-info') return { status: 200, body: { startedAt: restarted ? 'B' : 'A' } };
      return { status: 200, body: {} };
    });
    const r = await F['fault.server.restart'](ctx(f.fetch));
    assert.equal(r.ok, true);
    assert.equal(r.blockedRetries, 2);
    for (const c of f.calls.filter((x) => x.path === '/api/server/restart')) assert.equal(c.body.force, undefined);
  });

  it('gives up on a restart blocked for the whole window', async () => {
    const f = fakeFetch((req) => (req.path === '/api/server/restart' ? { status: 409, body: { code: 'WRAP_RESTART_BLOCKED' } } : { status: 200, body: { startedAt: 'A' } }));
    const r = await F['fault.server.restart'](ctx(f.fetch));
    assert.equal(r.code, O.RESTART_BLOCKED);
    assert.ok(r.blockedRetries > 1);
  });

  it('records a server that never comes back with a new start time', async () => {
    const f = fakeFetch((req) => (req.path === '/api/server/restart' ? { status: 202, body: {} } : { status: 200, body: { startedAt: 'A' } }));
    const r = await F['fault.server.restart'](ctx(f.fetch));
    assert.equal(r.code, O.NOT_RESTARTED);
  });

  it('does nothing when the start time cannot be read first', async () => {
    const f = fakeFetch(() => ({ status: 500, body: {} }));
    const r = await F['fault.server.restart'](ctx(f.fetch));
    assert.equal(r.step, 'before');
    assert.equal(f.calls.some((c) => c.path === '/api/server/restart'), false);
  });
});

describe('soak faults — tmux session kill', () => {
  /**
   * A server with one project whose session the fault launches.
   * @param {object} [opt] - `{launchBody, detects}`
   * @returns {{fetch: Function, calls: object[]}} Fake
   */
  function server(opt = {}) {
    let launched = false;
    let killed = false;
    const fake = fakeFetch((req) => {
      if (req.path === '/api/sessions/soak-a/status') {
        if (!launched) return { status: 200, body: { active: false } };
        return { status: 200, body: { active: !(killed && opt.detects !== false), engine: 'soak-stub' } };
      }
      if (req.method === 'POST' && req.path === '/api/sessions/soak-a') { launched = true; return { status: 201, body: opt.launchBody || { tmuxSession: 'soak-a', engine: 'soak-stub' } }; }
      if (req.method === 'DELETE') return { status: 404, body: {} };
      return { status: 404 };
    });
    // A successful `tmux kill-session` is what the server later notices.
    fake.run = async (file, args) => {
      fake.cmds.push([file, ...args]);
      killed = true;
      return { code: 0, stdout: '', stderr: '', error: null };
    };
    fake.cmds = [];
    return fake;
  }

  it('kills exactly the harness session and waits for the server to notice', async () => {
    const f = server();
    const r = await F['fault.tmux.session-kill'](ctx(f.fetch, { run: f.run }), { project: 'soak-a' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(f.cmds, [['tmux', 'kill-session', '-t', '=soak-a']]);
    assert.ok(f.calls.some((x) => x.method === 'DELETE'), 'cleans up after');
  });

  it('refuses to kill a session the launch did not name as the harness one', async () => {
    for (const launchBody of [{ tmuxSession: 'other', engine: 'soak-stub' }, { tmuxSession: 'soak-a', engine: 'claude' }]) {
      const f = server({ launchBody });
      const r = await F['fault.tmux.session-kill'](ctx(f.fetch), { project: 'soak-a' });
      assert.equal(r.code, O.NOT_HARNESS_SESSION);
    }
  });

  it('records a kill that failed, and still cleans up', async () => {
    const f = server();
    const r = await F['fault.tmux.session-kill'](ctx(f.fetch, { run: async () => ({ code: 1, stdout: '', stderr: "can't find session", error: '1' }) }), { project: 'soak-a' });
    assert.equal(r.code, O.KILL_FAILED);
    assert.equal(r.cleanupFailed, false);
  });

  it('records a server that never notices the dead session', async () => {
    const f = server({ detects: false });
    const r = await F['fault.tmux.session-kill'](ctx(f.fetch, { run: f.run }), { project: 'soak-a' });
    assert.equal(r.code, O.NOT_DETECTED);
  });

  it('never touches a session on another engine', async () => {
    const f = fakeFetch((req) => (req.path.endsWith('/status') ? { status: 200, body: { active: true, engine: 'claude' } } : { status: 500 }));
    const r = await F['fault.tmux.session-kill'](ctx(f.fetch), { project: 'soak-a' });
    assert.equal(r.code, ex.OUTCOME.FOREIGN_SESSION);
    assert.equal(f.calls.length, 1);
  });
});

describe('soak faults — client abort', () => {
  /**
   * A fetch that hangs until aborted, except for the recovery reads.
   * @param {string} after - The start time the recovery read reports
   * @returns {Function} Fetch
   */
  function hanging(after) {
    // Call 1 reads the start time; the next `aborts` calls are the reads the
    // fault cuts off, which hang until aborted; the rest are the recovery.
    let n = 0;
    return async (url, init) => {
      n++;
      if (n === 1) return { status: 200, text: async () => JSON.stringify({ startedAt: 'A' }) };
      if (n > 1 + faults.FAULT_LIMITS.aborts) {
        const body = url.pathname === '/api/health' ? { status: 'ok' } : { startedAt: after };
        return { status: 200, text: async () => JSON.stringify(body) };
      }
      return new Promise((resolve, reject) => {
        if (init.signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };
  }

  it('cuts off every read and finds the same server answering', async () => {
    const c = ctx(hanging('A'));
    c.local.limits = { abortAfterMs: 1 };
    const r = await F['fault.client.abort'](c);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.aborted, faults.FAULT_LIMITS.aborts);
    assert.equal(r.completed, 0);
  });

  it('fails when the server restarted under the aborts', async () => {
    const c = ctx(hanging('B'));
    c.local.limits = { abortAfterMs: 1 };
    const r = await F['fault.client.abort'](c);
    assert.equal(r.code, O.SERVER_RESTARTED);
  });

  it('aborts only reads', () => {
    assert.ok(faults.ABORT_ROUTES.length > 0);
    for (const r of faults.ABORT_ROUTES) assert.ok(r.startsWith('/api/'), r);
  });
});

describe('soak faults — database lock contention', () => {
  let home;
  let dbPath;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-faults-db-'));
    dbPath = path.join(home, 'tangleclaw.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);');
    db.close();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('locks the database while the server is probed, then releases it unchanged', async () => {
    const seenBusy = [];
    const f = fakeFetch((req) => {
      if (req.path === '/api/projects') {
        // Another connection, as the server's would be, is shut out.
        const other = new DatabaseSync(dbPath);
        try {
          other.prepare('SELECT v FROM t').all();
          seenBusy.push(false);
        } catch (err) {
          seenBusy.push(/locked|busy/i.test(err.message));
        } finally {
          other.close();
        }
        return { status: 500, body: { error: 'database is locked' } };
      }
      if (req.path === '/api/server-info') return { status: 200, body: { startedAt: 'A' } };
      return { status: 200, body: {} };
    });
    const r = await F['fault.db.lock-contention'](ctx(f.fetch, { dbPath }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(seenBusy, [true]);
    assert.deepEqual(r.during.map((d) => d.step), ['read', 'write', 'release']);
    assert.equal(r.during[0].status, 500);
    const after = new DatabaseSync(dbPath);
    assert.deepEqual(after.prepare('SELECT v FROM t').all().map((x) => x.v), [1]);
    after.close();
  });

  it('records a lock it could not take, and probes nothing', async () => {
    const holder = new DatabaseSync(dbPath);
    holder.exec('BEGIN EXCLUSIVE');
    try {
      const f = fakeFetch(() => ({ status: 200, body: { startedAt: 'A' } }));
      const r = await F['fault.db.lock-contention'](ctx(f.fetch, { dbPath }));
      assert.equal(r.code, O.LOCK_NOT_ACQUIRED);
      assert.equal(f.calls.some((c) => c.path === '/api/projects'), false);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('fails when the server restarted while locked', async () => {
    let reads = 0;
    const f = fakeFetch((req) => (req.path === '/api/server-info' ? { status: 200, body: { startedAt: reads++ === 0 ? 'A' : 'B' } } : { status: 200, body: {} }));
    const r = await F['fault.db.lock-contention'](ctx(f.fetch, { dbPath }));
    assert.equal(r.code, O.SERVER_RESTARTED);
  });
});

describe('soak faults — disk pressure', () => {
  let home;
  beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-faults-disk-'))); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const MIB = 1024 * 1024;
  const limits = { ballastFloorBytes: 2 * MIB, ballastMaxBytes: 64 * MIB, ballastMinBytes: MIB, ballastChunkBytes: MIB };
  /**
   * `node:fs` with a fixed free-space answer.
   * @param {number} freeBytes - What statfs reports as available
   * @returns {object} fs
   */
  const withFree = (freeBytes) => ({ ...fs, statfsSync: () => ({ bavail: freeBytes / 4096, bsize: 4096 }) });

  it('fills to the floor, probes under pressure, and removes the ballast', async () => {
    let sizeDuring = null;
    const f = fakeFetch((req) => {
      if (req.path === '/api/projects') {
        const dir = path.join(home, faults.BALLAST_DIR);
        const files = fs.readdirSync(dir);
        sizeDuring = files.length === 1 ? fs.statSync(path.join(dir, files[0])).size : null;
      }
      return req.path === '/api/server-info' ? { status: 200, body: { startedAt: 'A' } } : { status: 200, body: {} };
    });
    const r = await F['fault.disk.pressure'](ctx(f.fetch, { home, fs: withFree(5 * MIB), limits }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.ballastBytes, 3 * MIB);
    assert.equal(sizeDuring, 3 * MIB);
    assert.equal(r.freeBefore, 5 * MIB);
    assert.deepEqual(fs.readdirSync(path.join(home, faults.BALLAST_DIR)), []);
    assert.equal(fs.statSync(path.join(home, faults.BALLAST_DIR)).mode & 0o777, 0o700);
  });

  it('never writes past the size cap', async () => {
    const f = fakeFetch((req) => (req.path === '/api/server-info' ? { status: 200, body: { startedAt: 'A' } } : { status: 200, body: {} }));
    const r = await F['fault.disk.pressure'](ctx(f.fetch, { home, fs: withFree(500 * MIB), limits: { ...limits, ballastMaxBytes: 4 * MIB } }));
    assert.equal(r.ballastBytes, 4 * MIB);
  });

  it('records too little headroom and writes nothing', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { startedAt: 'A' } }));
    const r = await F['fault.disk.pressure'](ctx(f.fetch, { home, fs: withFree(2 * MIB + 1000), limits }));
    assert.equal(r.code, O.NO_HEADROOM);
    assert.deepEqual(fs.readdirSync(path.join(home, faults.BALLAST_DIR)), []);
  });

  it('removes ballast a dead run left, and nothing else', async () => {
    const dir = path.join(home, faults.BALLAST_DIR);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'ballast-dead-1.bin'), 'x');
    fs.writeFileSync(path.join(dir, 'ballast-0-3.bin'), 'x');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    const f = fakeFetch((req) => (req.path === '/api/server-info' ? { status: 200, body: { startedAt: 'A' } } : { status: 200, body: {} }));
    const r = await F['fault.disk.pressure'](ctx(f.fetch, { home, fs: withFree(5 * MIB), limits }));
    assert.equal(r.leftoverRemoved, 2);
    assert.deepEqual(fs.readdirSync(dir), ['keep.txt']);
  });

  it('names its ballast so a later run recognises it', () => {
    assert.ok(faults.BALLAST_RE.test('ballast-abcdef0123456789-1700000000000-7.bin'));
    assert.ok(!faults.BALLAST_RE.test('ballast-../x.bin'));
  });

  it('records a filesystem that fails while preparing the ballast, instead of throwing', async () => {
    const broken = { ...withFree(5 * MIB), statfsSync: () => { const e = new Error('io'); e.code = 'EIO'; throw e; } };
    const f = fakeFetch(() => ({ status: 200, body: { startedAt: 'A' } }));
    const r = await F['fault.disk.pressure'](ctx(f.fetch, { home, fs: broken, limits }));
    assert.deepEqual([r.code, r.step, r.error], [O.BALLAST_FAILED, 'ballast-prepare', 'EIO']);
  });

  it('refuses a ballast directory that is a symlink', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-elsewhere-'));
    try {
      fs.symlinkSync(elsewhere, path.join(home, faults.BALLAST_DIR));
      const f = fakeFetch(() => ({ status: 200, body: { startedAt: 'A' } }));
      const r = await F['fault.disk.pressure'](ctx(f.fetch, { home, fs: withFree(5 * MIB), limits }));
      assert.equal(r.code, O.BALLAST_FAILED);
      assert.deepEqual(fs.readdirSync(elsewhere), []);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('soak faults — ttyd restart', () => {
  /**
   * A launchctl stand-in whose ttyd pid changes after a kickstart.
   * @param {object} [opt] - `{restarts, kickFails}`
   * @returns {{run: Function, cmds: string[][]}} Runner and its log
   */
  function launchctl(opt = {}) {
    let pid = 100;
    const cmds = [];
    const run = async (file, args) => {
      cmds.push([file, ...args]);
      if (args[0] === 'list') return { code: 0, stdout: `{\n\t"Label" = "com.tangleclaw.ttyd";\n\t"PID" = ${pid};\n};\n`, stderr: '', error: null };
      if (opt.kickFails) return { code: 1, stdout: '', stderr: 'no such service', error: '1' };
      if (opt.restarts !== false) pid = 200;
      return { code: 0, stdout: '', stderr: '', error: null };
    };
    return { run, cmds };
  }

  it('refuses outside a destructive run and runs nothing', async () => {
    const l = launchctl();
    const r = await F['fault.ttyd.restart'](ctx(fakeFetch(() => ({ status: 200 })).fetch, { run: l.run }));
    assert.equal(r.code, O.NOT_DESTRUCTIVE);
    assert.equal(l.cmds.length, 0);
  });

  it('kickstarts the ttyd job and waits for a new pid', async () => {
    const l = launchctl();
    const f = fakeFetch(() => ({ status: 200, body: { status: 'ok' } }));
    const r = await F['fault.ttyd.restart'](ctx(f.fetch, { run: l.run, phase: 'destructive', uid: 501 }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.before, r.after], [100, 200]);
    assert.ok(l.cmds.some((c) => c.join(' ') === 'launchctl kickstart -k gui/501/com.tangleclaw.ttyd'));
  });

  it('records a ttyd launchd never replaced', async () => {
    const l = launchctl({ restarts: false });
    const r = await F['fault.ttyd.restart'](ctx(fakeFetch(() => ({ status: 200 })).fetch, { run: l.run, phase: 'destructive' }));
    assert.equal(r.code, O.TTYD_NOT_RESTARTED);
  });

  it('records a failed kickstart', async () => {
    const l = launchctl({ kickFails: true });
    const r = await F['fault.ttyd.restart'](ctx(fakeFetch(() => ({ status: 200 })).fetch, { run: l.run, phase: 'destructive' }));
    assert.equal(r.code, O.KILL_FAILED);
  });
});
