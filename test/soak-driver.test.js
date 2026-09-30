'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const driver = require('../lib/soak/driver');
const sched = require('../lib/soak/schedule');

const MIN = 60 * 1000;

/** A realistic epoch start: the log refuses a start time that is not a real epoch. */
const T0 = 1_790_000_000_000;

/**
 * A fake wall clock: `sleep` advances time instantly and records each wait.
 * @param {number} start - Initial epoch ms
 * @returns {{now: () => number, sleep: (ms: number) => Promise<void>, advance: (ms: number) => void, sleeps: number[]}} Clock
 */
function fakeClock(start) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    advance: (ms) => { t += ms; },
    sleeps
  };
}

/**
 * An api-only schedule short enough to reason about event by event.
 * @param {object} [over] - Option overrides
 * @returns {object} Schedule
 */
function apiSchedule(over = {}) {
  return sched.buildSchedule({ seed: 'driver', phase: 'certifying', durationMs: 10 * MIN, loadMeanMs: MIN, classes: ['api'], ...over });
}

/**
 * Executors for every api kind that record what ran and resolve OK.
 * @param {string[]} ran - Receives each kind as it runs
 * @returns {object} Executors
 */
function recordingExecutors(ran) {
  const out = {};
  for (const t of sched.TASKS.filter((k) => k.class === 'api')) {
    out[t.kind] = async () => { ran.push(t.kind); return { ok: true, code: 'OK', status: 200 }; };
  }
  return out;
}

/**
 * Parse a log file into records.
 * @param {string} p - Log path
 * @returns {object[]} Records
 */
function records(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * A stop condition that trips once the log holds `k` event records, so a test
 * says "stop after k events" rather than counting how often the driver asks.
 * @param {number} k - Events to allow
 * @returns {() => boolean} Stop check
 */
function afterEvents(k) {
  return () => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('"type":"event"')).length >= k;
}

let dir;
let logPath;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-driver-'));
  logPath = path.join(dir, 'soak.ndjson');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('soak driver — a complete run', () => {
  it('runs every event at its scheduled slot and writes header, events and end', async () => {
    const s = apiSchedule();
    const clock = fakeClock(1_000_000);
    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock });
    assert.deepEqual(result, { status: 'completed', ran: s.events.length, resumedFrom: 0, tornTail: false, skipped: 0, ownershipUnverified: false });
    assert.deepEqual(ran, s.events.map((e) => e.kind));

    const recs = records(logPath);
    assert.equal(recs[0].type, 'header');
    assert.equal(recs[0].schema, driver.LOG_SCHEMA);
    assert.equal(recs[0].scheduleDigest, s.digest);
    assert.equal(recs[0].startEpochMs, 1_000_000);
    const events = recs.filter((r) => r.type === 'event');
    assert.deepEqual(events.map((r) => r.index), s.events.map((e) => e.index));
    events.forEach((r, i) => {
      assert.equal(r.scheduledAt, 1_000_000 + s.events[i].atMs);
      assert.equal(r.startedAt, r.scheduledAt);
      assert.equal(r.lateMs, 0);
      assert.equal(r.ok, true);
    });
    assert.equal(recs[recs.length - 1].type, 'end');
    assert.equal(recs[recs.length - 1].events, s.events.length);
  });

  it('creates the log readable by its owner only', async () => {
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  });

  it('records a failed outcome and keeps going', async () => {
    const s = apiSchedule();
    const executors = recordingExecutors([]);
    executors['api.health'] = async () => ({ ok: false, code: 'HTTP_STATUS', status: 503 });
    await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) });
    const events = records(logPath).filter((r) => r.type === 'event');
    assert.equal(events.length, s.events.length);
    for (const r of events.filter((e) => e.kind === 'api.health')) assert.deepEqual([r.ok, r.code, r.status], [false, 'HTTP_STATUS', 503]);
  });

  it('records an executor that throws as EXECUTOR_THREW and keeps going', async () => {
    const s = apiSchedule();
    const executors = recordingExecutors([]);
    executors['api.health'] = async () => { throw new Error('boom'); };
    const result = await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) });
    assert.equal(result.status, 'completed');
    const thrown = records(logPath).filter((r) => r.kind === 'api.health');
    assert.ok(thrown.length > 0);
    for (const r of thrown) assert.deepEqual([r.ok, r.code, r.error], [false, 'EXECUTOR_THREW', 'boom']);
  });

  it('passes each event its own params and the shared context', async () => {
    const s = apiSchedule({ durationMs: 60 * MIN });
    const seen = [];
    const executors = recordingExecutors([]);
    executors['api.ports.lease-release'] = async (ctx, params) => { seen.push([ctx.tag, params.port]); return { ok: true, code: 'OK' }; };
    await driver.runSchedule({ schedule: s, executors, ctx: { tag: 'guest' }, logPath, clock: fakeClock(T0) });
    const expected = s.events.filter((e) => e.kind === 'api.ports.lease-release').map((e) => ['guest', e.params.port]);
    assert.ok(expected.length > 0);
    assert.deepEqual(seen, expected);
  });

  it('tells each executor which event it is running, without changing the shared context', async () => {
    const s = apiSchedule({ durationMs: 60 * MIN });
    const shared = { tag: 'guest' };
    const seen = [];
    const executors = {};
    for (const kind of new Set(s.events.map((e) => e.kind))) {
      executors[kind] = async (ctx) => { seen.push([ctx.eventIndex, ctx.tag]); return { ok: true, code: 'OK' }; };
    }
    await driver.runSchedule({ schedule: s, executors, ctx: shared, logPath, clock: fakeClock(T0) });
    assert.deepEqual(seen, s.events.map((e) => [e.index, 'guest']));
    assert.deepEqual(shared, { tag: 'guest' });
  });

  it('tells each executor its run: the same key after a real resume, a different one for another run', async () => {
    const s = apiSchedule({ durationMs: 30 * MIN });
    /**
     * Executors that record the run key each event was given.
     * @param {string[]} into - Where to record
     * @returns {object} Executors by kind
     */
    const recording = (into) => {
      const ex = {};
      for (const kind of new Set(s.events.map((e) => e.kind))) ex[kind] = async (ctx) => { into.push(ctx.runKey); return { ok: true, code: 'OK' }; };
      return ex;
    };
    const keys = [];
    const clock = fakeClock(T0);
    await driver.runSchedule({ schedule: s, executors: recording(keys), ctx: {}, logPath, clock, shouldStop: afterEvents(1) });
    const beforeResume = keys.length;
    assert.ok(beforeResume >= 1);
    // A new process resumes the same log a minute later: the key comes back
    // from the log's header, not from the new start.
    clock.advance(MIN);
    await driver.runSchedule({ schedule: s, executors: recording(keys), ctx: {}, logPath, clock });
    assert.ok(keys.length > beforeResume, 'the resumed segment ran events');
    assert.ok(records(logPath).some((r) => r.type === 'resume'), 'it really resumed');
    assert.deepEqual([...new Set(keys)], [`${s.digest.slice(0, 16)}-${T0}`]);
    // The same schedule run again, on its own log, is another run.
    const other = [];
    await driver.runSchedule({ schedule: s, executors: recording(other), ctx: {}, logPath: path.join(dir, 'other.ndjson'), clock: fakeClock(T0 + 5000) });
    assert.equal(new Set(other).size, 1);
    assert.notEqual(other[0], keys[0], 'a second run never shares the first one\'s request ids');
  });
});

describe('soak driver — refusals', () => {
  it('refuses an invalid schedule before writing anything', async () => {
    const s = apiSchedule();
    const bad = { ...s, digest: '0'.repeat(64) };
    await assert.rejects(
      driver.runSchedule({ schedule: bad, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err instanceof driver.DriverRefusal && err.code === 'INVALID_SCHEDULE'
    );
    assert.equal(fs.existsSync(logPath), false);
  });

  it('refuses a schedule with kinds that have no executor, naming them, rather than skipping them', async () => {
    const s = sched.buildSchedule({ seed: 'x', phase: 'certifying', durationMs: 6 * 60 * MIN, faultMeanMs: 30 * MIN });
    await assert.rejects(
      driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'NO_EXECUTOR' && err.details.kinds.includes('engine.session.cycle') && err.details.kinds.some((k) => k.startsWith('fault.'))
    );
    assert.equal(fs.existsSync(logPath), false);
  });

  it('refuses a log that belongs to another schedule', async () => {
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule({ seed: 'other' }), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'LOG_MISMATCH'
    );
  });

  it('refuses a log with a malformed line before its end', async () => {
    // Damage in the MIDDLE of the log, with a valid record after it, is never
    // the leftovers of a crash, so it is refused. (Unsealed damage at the very
    // end is the pending region of the last crash, tested separately.)
    fs.writeFileSync(logPath, `${JSON.stringify({ type: 'header', schema: driver.LOG_SCHEMA, scheduleDigest: apiSchedule().digest, startEpochMs: T0 })}\nnot json\n${JSON.stringify({ type: 'event', index: 0, kind: 'api.health', startedAt: T0 })}\n`);
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'LOG_UNREADABLE'
    );
  });

  it('refuses a file that is not a soak log', async () => {
    fs.writeFileSync(logPath, `${JSON.stringify({ hello: 'world' })}\n`);
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'LOG_UNREADABLE'
    );
  });
});

describe('soak driver — resume', () => {
  it('resumes after a stop without re-running any logged event, at the original slots', async () => {
    const s = apiSchedule();
    const clock = fakeClock(5_000);
    const firstRun = [];
    const stopAfter = 4;
    const first = await driver.runSchedule({
      schedule: s, executors: recordingExecutors(firstRun), ctx: {}, logPath, clock,
      shouldStop: afterEvents(stopAfter)
    });
    assert.equal(first.status, 'stopped');
    assert.equal(firstRun.length, stopAfter);

    const secondRun = [];
    const second = await driver.runSchedule({ schedule: s, executors: recordingExecutors(secondRun), ctx: {}, logPath, clock });
    assert.equal(second.status, 'completed');
    assert.equal(second.resumedFrom, stopAfter);
    assert.deepEqual([...firstRun, ...secondRun], s.events.map((e) => e.kind));

    const recs = records(logPath);
    assert.equal(recs.filter((r) => r.type === 'header').length, 1, 'one header across both runs');
    const resume = recs.filter((r) => r.type === 'resume');
    assert.equal(resume.length, 1, 'the second segment is marked');
    assert.equal(resume[0].resumedFrom, stopAfter);
    const indexes = recs.filter((r) => r.type === 'event').map((r) => r.index);
    assert.deepEqual(indexes, s.events.map((e) => e.index), 'every event exactly once, in order');
    for (const r of recs.filter((x) => x.type === 'event')) assert.equal(r.scheduledAt, 5_000 + s.events[r.index].atMs);
  });

  it('runs an event that is only slightly late at once, and records how late', async () => {
    const s = apiSchedule();
    const clock = fakeClock(T0);
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(1) });
    const next = s.events[1];
    clock.advance(next.atMs - s.events[0].atMs + 20 * 1000); // resume 20 s after the next slot
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock });
    const r = records(logPath).find((x) => x.type === 'event' && x.index === 1);
    assert.equal(r.skipped, undefined);
    assert.ok(r.lateMs >= 20 * 1000 && r.lateMs < driver.STALE_LOAD_MS);
    assert.equal(r.startedAt - r.scheduledAt, r.lateMs);
  });

  it('skips and records load that went stale while it was down, then runs the rest on time', async () => {
    const s = apiSchedule();
    const clock = fakeClock(T0);
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(1) });
    clock.advance(5 * MIN);
    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock });
    const ev = records(logPath).filter((r) => r.type === 'event');
    const stale = ev.filter((r) => r.skipped);
    assert.ok(stale.length > 0);
    assert.equal(result.skipped, stale.length);
    for (const r of stale) {
      assert.deepEqual([r.code, r.ok, r.startedAt], ['SKIPPED_STALE', null, null]);
      assert.ok(r.lateMs > driver.STALE_LOAD_MS);
    }
    assert.equal(ran.length + stale.length, s.events.length - 1, 'every remaining event is either run or recorded as skipped');
    assert.deepEqual(ev.map((r) => r.index), s.events.map((e) => e.index), 'still exactly once each, in order');
    assert.equal(ev[ev.length - 1].lateMs, 0, 'later events are back on their slots');
  });

  it('seals a torn final line by appending, never rewriting, and runs that event again', async () => {
    const s = apiSchedule();
    const clock = fakeClock(T0);
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(3) });
    const fragment = '{"type":"event","index":3,"kind":"api.he';
    fs.appendFileSync(logPath, fragment);
    const before = fs.readFileSync(logPath, 'utf8');

    const peek = driver.readLog(logPath);
    const crypto = require('node:crypto');
    assert.deepEqual([peek.tornTail, peek.lastIndex], [true, 2]);
    assert.deepEqual(peek.torn, { offset: Buffer.byteLength(before) - Buffer.byteLength(fragment), bytes: Buffer.byteLength(fragment), sha256: crypto.createHash('sha256').update(fragment).digest('hex'), endsWithNewline: false });
    assert.equal(fs.readFileSync(logPath, 'utf8'), before, 'reading the log changes nothing');

    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock });
    assert.equal(result.tornTail, true);
    assert.equal(result.resumedFrom, 3);
    assert.equal(ran[0], s.events[3].kind);
    const after = fs.readFileSync(logPath, 'utf8');
    assert.ok(after.startsWith(before), 'every original byte, the fragment included, is still there');
    const seal = after.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r && r.type === 'torn-tail-sealed');
    assert.deepEqual([seal.offset, seal.bytes, seal.sha256], [peek.torn.offset, peek.torn.bytes, peek.torn.sha256]);
    const indexes = after.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.type === 'event').map((r) => r.index);
    assert.deepEqual(indexes, s.events.map((e) => e.index));
    // and the sealed log reads back cleanly
    assert.equal(driver.readLog(logPath).ended, true);
  });

  describe('seals bind their exact fragment', () => {
    /**
     * A log with one sealed fragment in it, as a real crash and resume leave it.
     * @returns {Promise<{text: string, fragment: string}>} The log text and the fragment
     */
    async function sealedLog() {
      const s = apiSchedule();
      const clock = fakeClock(T0);
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(2) });
      const fragment = '{"type":"event","index":2,"kind":"api.he';
      fs.appendFileSync(logPath, fragment);
      // afterEvents counts the fragment too (it contains "type":"event"), so 4
      // here means one real event runs after the seal.
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(4) });
      return { text: fs.readFileSync(logPath, 'utf8'), fragment };
    }
    const sealOf = (text) => JSON.parse(text.split('\n').find((l) => l.includes('"torn-tail-sealed"')));
    const rewriteSeal = (text, edit) => text.split('\n').map((l) => {
      if (!l.includes('"torn-tail-sealed"')) return l;
      const r = JSON.parse(l);
      edit(r);
      return JSON.stringify(r);
    }).join('\n');

    it('accepts a genuine seal', async () => {
      await sealedLog();
      assert.equal(driver.readLog(logPath).lastIndex, 2);
    });

    const tampers = [
      ['a seal with the wrong sha256', (t) => rewriteSeal(t, (r) => { r.sha256 = '0'.repeat(64); })],
      ['a seal with the wrong length', (t) => rewriteSeal(t, (r) => { r.bytes += 1; })],
      ['a seal with the wrong offset', (t) => rewriteSeal(t, (r) => { r.offset -= 1; })],
      ['a seal with no binding at all', (t) => rewriteSeal(t, (r) => { delete r.offset; delete r.bytes; delete r.sha256; })],
      ['a fragment altered after sealing (same length)', (t, f) => t.replace(f, f.replace('api.he', 'api.xx'))],
      ['a second malformed line under one seal', (t, f) => t.replace(`${f}\n`, `${f}\n{also-broken\n`)],
      ['a stray seal with no fragment before it', (t) => { const lines = t.split('\n'); const seal = lines.find((l) => l.includes('"torn-tail-sealed"')); return t.replace(seal, `${seal}\n${seal}`); }],
      ['an empty line in the middle', (t) => t.replace('\n', '\n\n')]
    ];
    for (const [label, tamper] of tampers) {
      it(`refuses ${label}`, async () => {
        const { text, fragment } = await sealedLog();
        fs.writeFileSync(logPath, tamper(text, fragment));
        assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_UNREADABLE', label);
      });
    }

    it('still resumes when the crash cut off only the newline, leaving a complete, valid record', async () => {
      const s = apiSchedule();
      const clock = fakeClock(T0);
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(2) });
      // A whole event record, as the writer would have written it, minus its newline.
      fs.appendFileSync(logPath, JSON.stringify({ type: 'event', index: 2, kind: s.events[2].kind, startedAt: T0, ok: true }));
      const first = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(4) });
      assert.equal(first.tornTail, true);
      // The next resume must read the sealed log, not refuse it.
      const second = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock });
      assert.equal(second.status, 'completed');
      assert.equal(driver.readLog(logPath).ended, true);
    });

    // The two fragment kinds a crash can leave: a record cut mid-way, and a
    // complete record that lost only its newline, which parses as JSON.
    const FRAGMENTS = [
      ['a record cut mid-way', () => '{"type":"event","index":2,"kind":"api.he'],
      ['a complete record missing only its newline', (s) => JSON.stringify({ type: 'event', index: 2, kind: s.events[2].kind, startedAt: T0 + 1, ok: true })]
    ];

    /**
     * Rebuild the crashed log deterministically.
     * @param {object} s - Schedule
     * @param {string} fragment - Torn bytes
     * @returns {Promise<Buffer>} The crashed log
     */
    async function crashedLog(s, fragment) {
      if (fs.existsSync(logPath)) fs.rmSync(logPath);
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), shouldStop: afterEvents(2) });
      fs.appendFileSync(logPath, fragment);
      return fs.readFileSync(logPath);
    }

    /**
     * The exact bytes sealing would append to a log.
     * @param {Buffer} log - Log bytes
     * @returns {Buffer} The seal write
     */
    function sealWriteFor(log) {
      const scratch = `${logPath}.probe`;
      fs.writeFileSync(scratch, log);
      driver.sealTornTail(scratch, driver.readLog(scratch).torn, T0 + 1);
      const out = fs.readFileSync(scratch).subarray(log.length);
      fs.rmSync(scratch);
      return out;
    }

    /**
     * Resume to completion, then check the log reads back the same way twice.
     * @param {object} s - Schedule
     * @param {string} label - For messages
     */
    async function resumesCleanly(s, label) {
      const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0 + 10 * MIN) });
      assert.equal(result.status, 'completed', label);
      const once = driver.readLog(logPath);
      // Every event is on record exactly once: none lost, none duplicated,
      // whatever the crash cut. The sealed region is the only place bytes of
      // a record may sit outside the record list.
      const events = fs.readFileSync(logPath, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const sealedAt = new Set(events.filter((r) => r && r.type === 'torn-tail-sealed').map((r) => r.offset));
      let offset = 0;
      const counted = [];
      for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
        let r = null;
        try { r = JSON.parse(line); } catch { r = null; }
        if (r && r.type === 'event' && !sealedAt.has(offset)) counted.push(r.index);
        offset += Buffer.byteLength(line) + 1;
      }
      assert.deepEqual([...counted].sort((a, b) => a - b), s.events.map((e) => e.index), `${label}: each event exactly once`);
      const twice = driver.readLog(logPath);
      assert.equal(once.ended, true, label);
      assert.equal(once.torn, null, `${label}: nothing left pending`);
      assert.deepEqual(twice, once, `${label}: reads back the same every time`);
    }

    for (const [kind, make] of FRAGMENTS) {
      it(`resumes whichever byte the seal's own write was cut at: ${kind}`, async () => {
        const s = apiSchedule();
        const crashed = await crashedLog(s, make(s));
        const seal = sealWriteFor(crashed);
        for (let cut = 0; cut <= seal.length; cut++) {
          fs.writeFileSync(logPath, Buffer.concat([crashed, seal.subarray(0, cut)]));
          await resumesCleanly(s, `${kind}, seal cut at byte ${cut}`);
        }
      });

      it(`resumes when a second seal is cut too: ${kind}`, async () => {
        // A crash tears the seal; the next run seals the leftovers and is
        // torn again. Sampled cut points keep the pairs to a few hundred.
        const s = apiSchedule();
        const crashed = await crashedLog(s, make(s));
        const seal1 = sealWriteFor(crashed);
        for (let c1 = 0; c1 <= seal1.length; c1 += 9) {
          const afterFirst = Buffer.concat([crashed, seal1.subarray(0, c1)]);
          fs.writeFileSync(logPath, afterFirst);
          const back = driver.readLog(logPath);
          if (!back.torn) continue; // nothing to seal a second time at this cut
          const seal2 = sealWriteFor(afterFirst);
          for (let c2 = 0; c2 <= seal2.length; c2 += 11) {
            fs.writeFileSync(logPath, Buffer.concat([afterFirst, seal2.subarray(0, c2)]));
            await resumesCleanly(s, `${kind}, seals cut at ${c1} and ${c2}`);
          }
        }
      });
    }

    it('still resumes a log that survived two crashes, each sealed to its own fragment', async () => {
      const s = apiSchedule();
      const clock = fakeClock(T0);
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(2) });
      fs.appendFileSync(logPath, '{"type":"event","index":2');
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(4) });
      fs.appendFileSync(logPath, '{"type":"eve');
      const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock });
      assert.equal(result.status, 'completed');
      const seals = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('"torn-tail-sealed"'));
      assert.equal(seals.length, 2);
      assert.notEqual(sealOf(seals[0]).offset, sealOf(seals[1]).offset);
      assert.equal(driver.readLog(logPath).ended, true);
    });
  });

  it('refuses a malformed line that no seal follows', () => {
    fs.writeFileSync(logPath, `${JSON.stringify({ type: 'header', schema: driver.LOG_SCHEMA, scheduleDigest: 'x', startEpochMs: T0 })}\n{broken\n${JSON.stringify({ type: 'event', index: 0 })}\n`);
    assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_UNREADABLE');
  });

  it('refuses a log whose only content is a torn header', () => {
    fs.writeFileSync(logPath, '{"type":"header","sch');
    assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_UNREADABLE');
  });

  it('does nothing for a log that already ended', async () => {
    const s = apiSchedule();
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    const before = fs.readFileSync(logPath, 'utf8');
    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock: fakeClock(T0) });
    assert.equal(result.status, 'already-complete');
    assert.equal(ran.length, 0);
    assert.equal(fs.readFileSync(logPath, 'utf8'), before);
  });
});

describe('soak driver — the live-install guard', () => {
  // A fixed picture of "this machine", so the tests do not depend on the
  // interfaces of whichever host runs them.
  const names = { exact: new Set(['localhost', '::1', '[::1]', '0.0.0.0', '::', '[::]', 'devbox', '192.168.1.20', '100.64.0.7']), hostnamePrefix: 'devbox.' };
  const LIVE = 'http://localhost:3102';

  it('refuses every spelling that reaches the live port on this machine', () => {
    const spellings = [
      'http://localhost:3102', 'http://localhost:3102/', 'http://localhost:3102/api',
      'http://127.0.0.1:3102', 'http://127.1.2.3:3102', 'http://[::1]:3102', 'http://0.0.0.0:3102',
      'https://localhost:3102', 'http://DEVBOX:3102', 'http://devbox.tail123678.ts.net:3102',
      'http://192.168.1.20:3102', 'http://100.64.0.7:3102',
      'http://[::ffff:127.0.0.1]:3102', 'http://[::ffff:7f00:1]:3102', 'http://localhost.:3102', 'http://localhost..:3102',
      'http://foo.localhost:3102', 'http://2130706433:3102', 'http://0x7f.1:3102', 'http://devbox.:3102'
    ];
    for (const target of spellings) {
      assert.throws(() => driver.refuseLiveTarget(target, LIVE, names), (err) => err.code === 'LIVE_INSTALL_TARGET', target);
    }
  });

  it('refuses the same origin even on another machine', () => {
    assert.throws(() => driver.refuseLiveTarget('http://tc.example:3102', 'http://tc.example:3102', names), (err) => err.code === 'LIVE_INSTALL_TARGET');
  });

  it('fills in the scheme default port when comparing', () => {
    assert.throws(() => driver.refuseLiveTarget('http://127.0.0.1', 'http://localhost:80', names), (err) => err.code === 'LIVE_INSTALL_TARGET');
  });

  it('allows another port on this machine, another machine, or anything when there is no live install', () => {
    driver.refuseLiveTarget('http://localhost:3202', LIVE, names);
    driver.refuseLiveTarget('http://192.168.64.7:3102', LIVE, names);
    driver.refuseLiveTarget('http://devboxer:3102', LIVE, names);
    driver.refuseLiveTarget('http://localhost:3102', undefined, names);
  });

  it('knows this machine\'s real loopback and hostname', () => {
    const real = driver.localNames();
    assert.ok(real.exact.has('localhost'));
    assert.ok(real.exact.has(os.hostname().toLowerCase().split('.')[0]));
  });
});

describe('soak driver — the same-install identity check', () => {
  /**
   * A fetch that answers /api/server-info per origin.
   * @param {Object<string, {status: number, body?: object}|Error>} byOrigin - Answer per origin
   * @returns {Function} Fetch
   */
  function infoFetch(byOrigin) {
    return async (url) => {
      const a = byOrigin[url.origin];
      if (a instanceof Error) throw a;
      assert.equal(url.pathname, '/api/server-info');
      return { status: a.status, text: async () => JSON.stringify(a.body || {}) };
    };
  }
  const LIVE = 'http://localhost:3102';
  const PROXY = 'https://devbox.tail123678.ts.net:8443';
  const same = { status: 200, body: { startedAt: '2026-09-28T17:27:45.023Z', startupSha: 'a'.repeat(40) } };
  const other = { status: 200, body: { startedAt: '2026-09-28T18:00:00.000Z', startupSha: 'a'.repeat(40) } };

  it('refuses a target that reports the same running server, whatever address reached it', async () => {
    await assert.rejects(
      driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: infoFetch({ [LIVE]: same, [PROXY]: same }) }),
      (err) => err.code === 'LIVE_INSTALL_TARGET'
    );
  });

  it('allows a different server', async () => {
    const r = await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: infoFetch({ [LIVE]: same, [PROXY]: other }) });
    assert.deepEqual(r, { checked: true, reason: null, liveUnverified: false });
  });

  it('refuses when the LIVE identity cannot be read, whatever the reason', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const unreadable = [
      [new TypeError('fetch failed'), /fetch failed/],
      [timeout, /timeout/],
      [{ status: 401 }, /HTTP 401/],
      [{ status: 503 }, /HTTP 503/],
      [{ status: 200, body: {} }, /no startedAt\/startupSha/],
      [{ status: 200, body: { startedAt: 'x' } }, /no startedAt\/startupSha/]
    ];
    for (const [liveAnswer, reason] of unreadable) {
      await assert.rejects(
        driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: infoFetch({ [LIVE]: liveAnswer, [PROXY]: other }) }),
        (err) => err.code === 'LIVE_IDENTITY_UNREADABLE' && reason.test(err.details.reason),
        String(reason)
      );
    }
  });

  it('proceeds on an unreadable live identity only with the explicit override, and says so', async () => {
    const r = await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, allowUnverifiedLive: true, fetch: infoFetch({ [LIVE]: { status: 503 }, [PROXY]: other }) });
    assert.deepEqual(r, { checked: false, reason: 'live install server-info: HTTP 503', liveUnverified: true });
  });

  it('reports unchecked, not refused, when only the TARGET cannot be read', async () => {
    for (const [answer, reason] of [[{ status: 401 }, /target server-info: HTTP 401/], [new TypeError('fetch failed'), /target server-info: fetch failed/]]) {
      const r = await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: infoFetch({ [LIVE]: same, [PROXY]: answer }) });
      assert.equal(r.checked, false);
      assert.equal(r.liveUnverified, false);
      assert.match(r.reason, reason);
    }
  });

  it('never follows a redirect on either side: live refuses, target is unchecked', async () => {
    const modes = [];
    const redirecting = (who) => async (url, init) => {
      modes.push(init.redirect);
      if (url.origin === who) return { status: 307, text: async () => '' };
      return { status: 200, text: async () => JSON.stringify(url.origin === LIVE ? same.body : other.body) };
    };
    await assert.rejects(
      driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: redirecting(LIVE) }),
      (err) => err.code === 'LIVE_IDENTITY_UNREADABLE' && /redirect refused \(HTTP 307\)/.test(err.details.reason)
    );
    const r = await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: redirecting(PROXY) });
    assert.deepEqual([r.checked, r.reason], [false, 'target server-info: redirect refused (HTTP 307)']);
    assert.ok(modes.length === 4 && modes.every((m) => m === 'manual'));
  });

  it('does nothing without a live install, the soak guest\'s normal case', async () => {
    const r = await driver.refuseSameInstall({ apiBase: 'http://localhost:3102', liveApi: undefined, fetch: async () => { throw new Error('must not fetch'); } });
    assert.deepEqual(r, { checked: false, reason: 'no TANGLECLAW_API in this pane', liveUnverified: false });
  });

  it('sends the service token to the target only', async () => {
    const auth = {};
    const fetch = async (url, init) => { auth[url.origin] = init.headers.authorization; return { status: 200, text: async () => JSON.stringify(url.origin === LIVE ? same.body : other.body) }; };
    await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch, token: 'tok' });
    assert.deepEqual(auth, { [LIVE]: undefined, [PROXY]: 'Bearer tok' });
  });
});

describe('soak driver — the target address', () => {
  const names = { exact: new Set(['localhost', '::1', 'devbox', '192.168.1.20']), hostnamePrefix: 'devbox.' };
  const LIVE = 'http://localhost:3102';
  const lookupFrom = (table) => async (host) => {
    if (!(host in table)) { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; }
    return table[host];
  };
  const never = async (host) => { throw new Error(`must not resolve ${host}`); };

  it('requires an IP-literal target when a live install is guarded, and never resolves the target', async () => {
    // DNS rebinding: a name that resolves elsewhere when checked and to
    // 127.0.0.1 when connected to. The target is never looked up at all, so
    // there is no check-to-connect window for it to exploit.
    let answers = 0;
    const rebinding = async () => (answers++ === 0 ? ['10.9.9.9'] : ['127.0.0.1']);
    for (const target of ['http://guest.example:3102', 'http://sneaky.example:3102', 'http://localhost:3202']) {
      await assert.rejects(
        driver.refuseLiveAddress({ apiBase: target, liveApi: LIVE, names, lookup: rebinding }),
        (err) => err.code === 'TARGET_NOT_IP_LITERAL',
        target
      );
    }
    assert.equal(answers, 0, 'the target name was never resolved');
  });

  it('refuses an IP-literal target that is this machine on the live port, in any spelling', async () => {
    for (const target of ['http://127.0.0.1:3102', 'http://[::1]:3102', 'http://[::ffff:127.0.0.1]:3102', 'http://192.168.1.20:3102', 'http://2130706433:3102', 'http://0.0.0.0:3102']) {
      await assert.rejects(
        driver.refuseLiveAddress({ apiBase: target, liveApi: LIVE, names, lookup: never }),
        (err) => err.code === 'LIVE_INSTALL_TARGET',
        target
      );
    }
  });

  it('allows a guest IP, and a local IP on another port, and reports what it checked', async () => {
    assert.deepEqual(await driver.refuseLiveAddress({ apiBase: 'http://192.168.64.7:3102', liveApi: LIVE, names, lookup: never }), { targetAddress: '192.168.64.7', liveLocal: true });
    assert.deepEqual(await driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3202', liveApi: LIVE, names, lookup: never }), { targetAddress: '127.0.0.1', liveLocal: true });
  });

  it('does not apply without a live install, the soak guest\'s case', async () => {
    assert.equal(await driver.refuseLiveAddress({ apiBase: 'http://localhost:3102', liveApi: undefined, names, lookup: never }), null);
  });

  it('refuses 127.0.0.1 on the live port when TANGLECLAW_API names this machine by another name', async () => {
    // e.g. a Tailscale name that is not the hostname and so fails every spelling rule.
    const live = 'http://tc-box.tail123678.ts.net:3102';
    const lookup = lookupFrom({ 'tc-box.tail123678.ts.net': ['192.168.1.20'] });
    driver.refuseLiveTarget('http://127.0.0.1:3102', live, names); // the spelling check cannot know
    await assert.rejects(
      driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3102', liveApi: live, names, lookup }),
      (err) => err.code === 'LIVE_INSTALL_TARGET'
    );
  });

  it('treats a live name that does not resolve as this machine, the protective answer', async () => {
    await assert.rejects(
      driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3102', liveApi: 'http://gone.example:3102', names, lookup: lookupFrom({}) }),
      (err) => err.code === 'LIVE_INSTALL_TARGET'
    );
  });

  it('allows a local target when the live install resolves to another machine', async () => {
    const r = await driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3102', liveApi: 'http://far.example:3102', names, lookup: lookupFrom({ 'far.example': ['10.0.0.9'] }) });
    assert.deepEqual(r, { targetAddress: '127.0.0.1', liveLocal: false });
  });

  it('knows the real loopback addresses of this machine', async () => {
    await assert.rejects(driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3102', liveApi: LIVE }), (err) => err.code === 'LIVE_INSTALL_TARGET');
  });
});

describe('soak driver — run-time pacing', () => {
  /**
   * A schedule with faults, as the driver sees it; a fault executor is supplied by the test.
   * @returns {object} Schedule
   */
  function faultSchedule() {
    return sched.buildSchedule({ seed: 'pace', phase: 'certifying', durationMs: 12 * 60 * MIN, loadMeanMs: 5 * MIN, faultMeanMs: 60 * MIN, faultQuietMs: 30 * MIN, classes: ['api', 'fault'] });
  }
  /**
   * Executors for every kind in a schedule, resolving OK.
   * @param {object} s - Schedule
   * @returns {object} Executors
   */
  function allOk(s) {
    const out = {};
    for (const k of new Set(s.events.map((e) => e.kind))) out[k] = async () => ({ ok: true, code: 'OK' });
    return out;
  }

  it('keeps faults a full quiet window apart after a long outage, and says so', async () => {
    const s = faultSchedule();
    const clock = fakeClock(T0);
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock, shouldStop: afterEvents(1) });
    clock.advance(10 * 60 * MIN); // down for ten hours: most of the schedule is overdue
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock });
    const faults = records(logPath).filter((r) => r.type === 'event' && r.kind.startsWith('fault.'));
    assert.ok(faults.length >= 3, 'the fixture must have several overdue faults');
    for (let i = 1; i < faults.length; i++) assert.ok(faults[i].startedAt - faults[i - 1].startedAt >= s.params.faultQuietMs, `fault ${i}`);
    assert.ok(faults.some((f) => f.paced === 'quiet-window'));
    // Faults are deferred, never skipped, and all of them run before the log ends.
    assert.equal(faults.length, s.events.filter((e) => e.class === 'fault').length);
    assert.ok(faults.every((f) => !f.skipped && f.ok === true));
    const all = records(logPath);
    assert.equal(all[all.length - 1].type, 'end');
    assert.ok(all[all.length - 1].completedAt >= faults[faults.length - 1].startedAt);
  });

  it('counts a fault that ran before a restart, read back from the log', async () => {
    // Both faults are overdue when the first runs, and the driver restarts
    // immediately after it. Only the fault time recovered from the log keeps
    // the second a quiet window away: a fresh process that forgot it would
    // start the second one catch-up-gap later.
    const s = faultSchedule();
    const [f0, f1] = s.events.filter((e) => e.class === 'fault');
    assert.ok(f1, 'the fixture needs two faults');
    const clock = fakeClock(T0);
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock, shouldStop: () => true });
    clock.advance(f1.atMs + 60 * MIN); // both faults are now overdue
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock, shouldStop: () => records(logPath).some((r) => r.index === f0.index) });
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock });
    const byIndex = new Map(records(logPath).filter((r) => r.type === 'event').map((r) => [r.index, r]));
    const gap = byIndex.get(f1.index).startedAt - byIndex.get(f0.index).startedAt;
    assert.ok(gap >= s.params.faultQuietMs, `gap ${gap}`);
    assert.equal(byIndex.get(f1.index).paced, 'quiet-window');
  });

  it('spaces overdue events instead of firing them in one burst', async () => {
    const s = apiSchedule({ durationMs: 60 * MIN });
    const clock = fakeClock(T0);
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(1) });
    clock.advance(50 * MIN);
    // Stale-skipping is turned off here so the catch-up spacing itself is what is measured.
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, catchUpGapMs: 2000, staleLoadMs: Infinity });
    const ev = records(logPath).filter((r) => r.type === 'event');
    const overdue = ev.filter((r) => r.lateMs > 0);
    assert.ok(overdue.length > 3);
    for (let i = 1; i < ev.length; i++) {
      if (ev[i].lateMs > 0) assert.ok(ev[i].startedAt - ev[i - 1].startedAt >= 2000, `event ${ev[i].index}`);
    }
    assert.ok(overdue.every((r) => r.paced === 'catch-up' || r === overdue[0]));
  });

  it('leaves events that are on time at their slots, unpaced', async () => {
    const s = apiSchedule();
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    for (const r of records(logPath).filter((x) => x.type === 'event')) {
      assert.equal(r.paced, null);
      assert.equal(r.lateMs, 0);
    }
  });
});

describe('soak driver — stopping and record integrity', () => {
  it('honours a stop during a long deferred-fault wait within one poll, not after the whole window', async () => {
    const s = sched.buildSchedule({ seed: 'pace', phase: 'certifying', durationMs: 12 * 60 * MIN, loadMeanMs: 5 * MIN, faultMeanMs: 60 * MIN, faultQuietMs: 30 * MIN, classes: ['api', 'fault'] });
    const executors = {};
    for (const k of new Set(s.events.map((e) => e.kind))) executors[k] = async () => ({ ok: true, code: 'OK' });
    const clock = fakeClock(T0);
    let asked = null;
    const result = await driver.runSchedule({
      schedule: s, executors, ctx: {}, logPath, clock, stopPollMs: 1000,
      // Ask to stop 5 s into the first wait that is longer than a minute.
      shouldStop: () => {
        const last = clock.sleeps[clock.sleeps.length - 1];
        if (asked === null && clock.sleeps.length > 0 && last === 1000) asked = clock.now();
        return asked !== null && clock.now() >= asked + 5000;
      }
    });
    assert.equal(result.status, 'stopped');
    assert.ok(clock.now() - asked <= 5000 + 1000, 'stopped within one poll of the request');
  });

  it('never lets an override key overwrite the header or resume record fields', async () => {
    const s = apiSchedule();
    const clock = fakeClock(T0);
    const headerExtra = { type: 'end', schema: 'x', startEpochMs: 1, scheduleDigest: 'x', resumedFrom: -1, guardContextOverride: 'no-live-install' };
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, headerExtra, shouldStop: afterEvents(1) });
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, headerExtra });
    const recs = records(logPath);
    assert.deepEqual([recs[0].type, recs[0].schema, recs[0].startEpochMs, recs[0].scheduleDigest], ['header', driver.LOG_SCHEMA, T0, s.digest]);
    const resume = recs.find((r) => r.type === 'resume');
    assert.equal(resume.resumedFrom, 1);
    assert.equal(resume.guardContextOverride, 'no-live-install');
    assert.equal(recs[recs.length - 1].type, 'end');
  });

  it('never lets an executor overwrite the fields resume depends on', async () => {
    const s = apiSchedule();
    const executors = recordingExecutors([]);
    for (const k of Object.keys(executors)) executors[k] = async () => ({ ok: true, code: 'OK', type: 'end', index: 999, kind: 'x', startedAt: 1 });
    await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) });
    const ev = records(logPath).filter((r) => r.type === 'event');
    assert.deepEqual(ev.map((r) => r.index), s.events.map((e) => e.index));
    assert.ok(ev.every((r) => r.kind === s.events[r.index].kind && r.startedAt > T0));
  });

  it('uses the validated quiet window, never a value read raw from the file', async () => {
    const s = sched.buildSchedule({ seed: 'pace', phase: 'certifying', durationMs: 12 * 60 * MIN, loadMeanMs: 5 * MIN, faultMeanMs: 60 * MIN, faultQuietMs: 30 * MIN, classes: ['api', 'fault'] });
    const tampered = JSON.parse(JSON.stringify(s));
    delete tampered.params.faultQuietMs;
    tampered.digest = sched.scheduleDigest(tampered);
    const executors = {};
    for (const k of new Set(s.events.map((e) => e.kind))) executors[k] = async () => ({ ok: true });
    await assert.rejects(
      driver.runSchedule({ schedule: tampered, executors, ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'INVALID_SCHEDULE'
    );
  });
});

describe('soak driver — writing every byte', () => {
  it('keeps writing until a partial write has written everything', () => {
    const got = [];
    const partial = (fd, buf, off, len) => { const n = Math.min(3, len); got.push(buf.subarray(off, off + n).toString()); return n; };
    driver.writeAll(7, Buffer.from('abcdefgh'), partial);
    assert.equal(got.join(''), 'abcdefgh');
  });

  it('throws, instead of leaving a partial record, when a write makes no progress', () => {
    let calls = 0;
    const stuck = (fd, buf, off, len) => (calls++ === 0 ? Math.min(2, len) : 0);
    assert.throws(() => driver.writeAll(7, Buffer.from('abcdefgh'), stuck), (err) => err.code === 'ESHORTWRITE' && /2 of 8/.test(err.message));
  });
});

describe('soak driver — the guard context', () => {
  it('refuses to run unguarded with no TANGLECLAW_API unless told so explicitly', () => {
    assert.throws(() => driver.requireGuardContext(undefined, false), (err) => err.code === 'GUARD_CONTEXT_ABSENT');
    assert.equal(driver.requireGuardContext(undefined, true), true);
    assert.equal(driver.requireGuardContext('http://localhost:3102', false), false);
  });
});

describe('soak driver — the log lock and header', () => {
  it('refuses a second driver on the same log while the first holds it', async () => {
    const lock = driver.acquireLogLock(logPath);
    try {
      await assert.rejects(
        driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
        (err) => err.code === 'LOG_LOCKED' && err.details.holder.pid === process.pid
      );
      assert.equal(fs.existsSync(logPath), false, 'the refused run wrote nothing');
    } finally {
      lock.release();
    }
  });

  it('releases the lock when the run ends, and when it is refused', async () => {
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    assert.equal(fs.existsSync(`${logPath}.lock`), false);
    await assert.rejects(driver.runSchedule({ schedule: apiSchedule({ seed: 'other' }), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }));
    assert.equal(fs.existsSync(`${logPath}.lock`), false);
  });

  it('reclaims a lock left by a dead process on this host, and records it', async () => {
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 999999, host: os.hostname() }));
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), lockDeps: { isAlive: () => false } });
    const reclaim = records(logPath).find((r) => r.type === 'lock-reclaimed');
    assert.deepEqual(reclaim.holder, { pid: 999999, host: os.hostname() });
  });

  it('lets exactly one of many concurrent processes reclaim a stale lock: never two holders at once', async () => {
    const { spawn, spawnSync } = require('node:child_process');
    // A pid that is certainly dead: a process that has already exited.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: dead, host: os.hostname() }));
    const child = `
      const driver = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'soak', 'driver.js'))});
      try {
        // Every contender waits here after finding the lock stale, so they
        // all reach the reclaim together: the window a naive reclaim loses in.
        const hold = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        const lock = driver.acquireLogLock(${JSON.stringify(logPath)}, { afterStaleCheck: hold });
        const t0 = Date.now();
        setTimeout(() => { const t1 = Date.now(); lock.release(); console.log(JSON.stringify({ won: true, t0, t1, reclaimed: lock.reclaimed !== null })); }, 1500);
      } catch (err) {
        console.log(JSON.stringify({ won: false, code: err.code }));
      }`;
    const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', child]);
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => resolve(JSON.parse(out.trim())));
    })));
    const winners = runs.filter((r) => r.won).sort((a, b) => a.t0 - b.t0);
    assert.ok(winners.length >= 1, 'someone takes the lock');
    for (let i = 1; i < winners.length; i++) assert.ok(winners[i].t0 >= winners[i - 1].t1, 'no two holders overlap');
    assert.equal(winners.filter((w) => w.reclaimed).length, 1, 'the stale lock is reclaimed exactly once');
    assert.ok(runs.filter((r) => !r.won).every((r) => r.code === 'LOG_LOCKED'));
    assert.equal(fs.existsSync(`${logPath}.lock.reclaim`), false, 'the reclaim mutex is gone');
  });

  it('refuses while another process is mid-reclaim, naming the mutex', () => {
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 999999, host: os.hostname() }));
    fs.mkdirSync(`${logPath}.lock.reclaim`);
    assert.throws(() => driver.acquireLogLock(logPath, { isAlive: () => false }), (err) => err.code === 'LOG_LOCKED' && /reclaiming/.test(err.details.why));
    assert.ok(fs.existsSync(`${logPath}.lock`), 'the stale lock was left alone');
  });

  it('does not reclaim a lock that changed hands between the first read and the mutex', () => {
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 999999, host: os.hostname() }));
    let checks = 0;
    // isAlive runs after the first read; swap the holder at that moment, as a
    // faster reclaimer would.
    const isAlive = () => {
      if (checks++ === 0) fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 424242, host: os.hostname() }));
      return false;
    };
    assert.throws(() => driver.acquireLogLock(logPath, { isAlive }), (err) => err.code === 'LOG_LOCKED' && /changed hands/.test(err.details.why));
    assert.equal(JSON.parse(fs.readFileSync(`${logPath}.lock`, 'utf8')).pid, 424242, 'the new holder keeps its lock');
    assert.equal(fs.existsSync(`${logPath}.lock.reclaim`), false);
  });

  it('release tells ownership loss apart from a lock it still owns but cannot remove, and never throws', () => {
    const lock = driver.acquireLogLock(logPath);
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 1, host: 'someone-else' }));
    const taken = lock.release();
    assert.ok(fs.existsSync(`${logPath}.lock`), 'another holder\'s lock survives our release');
    assert.deepEqual([taken.lost.why, taken.lost.holder, taken.releaseFailed], ['lock taken over during the run', { pid: 1, host: 'someone-else' }, null]);
    fs.rmSync(`${logPath}.lock`);

    const gone = driver.acquireLogLock(logPath);
    fs.rmSync(`${logPath}.lock`);
    assert.equal(gone.release().lost.why, 'lock file removed during the run');

    const io = (what) => ({
      readFileSync: (p, enc) => { if (what === 'read') { const e = new Error('io'); e.code = 'EIO'; throw e; } return fs.readFileSync(p, enc); },
      rmSync: (p, o) => { if (what === 'rm') { const e = new Error('perm'); e.code = 'EPERM'; throw e; } return fs.rmSync(p, o); }
    });
    const unreadable = driver.acquireLogLock(logPath, { releaseFs: io('read') });
    const u = unreadable.release();
    assert.deepEqual([u.lost, u.unverified.why, u.releaseFailed], [null, 'lock unreadable (EIO)', null], 'ownership that cannot be read is unverified, not lost');
    assert.ok(fs.existsSync(`${logPath}.lock`), 'a lock that cannot be read is never removed');
    fs.rmSync(`${logPath}.lock`);
    const stuck = driver.acquireLogLock(logPath, { releaseFs: io('rm') });
    const r = stuck.release();
    assert.equal(r.lost, null, 'a lock we still own was not lost');
    assert.match(r.releaseFailed.why, /could not be removed \(EPERM\)/);
  });

  describe('a lock lost during a run', () => {
    const lockFile = () => `${logPath}.lock`;
    const takeOver = () => fs.writeFileSync(lockFile(), JSON.stringify({ pid: 4242, host: 'intruder' }));
    const logLines = () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

    it('stops the moment an event finds the lock taken over: that event and end are never written, and a bound sidecar is', async () => {
      const s = apiSchedule();
      // Take the lock over inside the SECOND executor call, whatever its kind.
      const executors = {};
      let calls = 0;
      for (const [kind, fn] of Object.entries(recordingExecutors([]))) {
        executors[kind] = async (...a) => { if (++calls === 2) takeOver(); return fn(...a); };
      }
      await assert.rejects(
        driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }),
        (err) => err.code === 'LOCK_LOST' && err.details.observed.host === 'intruder' && err.details.expected.pid === process.pid
      );
      const recs = logLines();
      assert.ok(!recs.some((r) => r.type === 'end'), 'no end');
      assert.deepEqual(recs.filter((r) => r.type === 'event').map((r) => r.index), [0], 'the first event is on record; the one in flight at the loss is not');
      assert.ok(!recs.some((r) => r.type === 'lock-lost'), 'nothing about the loss goes into the shared log');
      const side = JSON.parse(fs.readFileSync(driver.lockLostPath(logPath), 'utf8'));
      const bytes = fs.readFileSync(logPath);
      assert.deepEqual([side.logPath, side.logBytes, side.logSha256], [path.resolve(logPath), bytes.length, require('node:crypto').createHash('sha256').update(bytes).digest('hex')]);
      assert.deepEqual(side.observed, { pid: 4242, host: 'intruder' });
      assert.equal(fs.readFileSync(lockFile(), 'utf8'), JSON.stringify({ pid: 4242, host: 'intruder' }), 'the other holder\'s lock is left alone');
    });

    it('checks ownership immediately before end: a loss after the last event leaves no end record', async () => {
      const s = apiSchedule();
      const base = fakeClock(T0);
      let taken = false;
      // The end record reads the clock just before it is written; take the
      // lock over at that exact moment, after every event is on record.
      const clock = {
        ...base,
        now: () => {
          if (!taken && fs.existsSync(logPath) && logLines().filter((r) => r.type === 'event').length === s.events.length) { taken = true; takeOver(); }
          return base.now();
        }
      };
      await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock }), (err) => err.code === 'LOCK_LOST');
      const recs = logLines();
      assert.equal(recs.filter((r) => r.type === 'event').length, s.events.length, 'every event was written while the lock was held');
      assert.ok(!recs.some((r) => r.type === 'end'), 'but no end');
      assert.ok(fs.existsSync(driver.lockLostPath(logPath)));
    });

    it('refuses to read, resume or rerun the log while the sidecar exists: never already-complete', async () => {
      const s = apiSchedule();
      const executors = recordingExecutors([]);
      const k = s.events[0].kind;
      const inner = executors[k];
      let fired = false;
      executors[k] = async (...a) => { if (!fired) { fired = true; fs.rmSync(lockFile()); } return inner(...a); };
      await assert.rejects(driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOCK_LOST');
      assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_LOCK_LOST');
      const ran = [];
      await assert.rejects(
        driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock: fakeClock(T0) }),
        (err) => err.code === 'LOG_LOCK_LOST'
      );
      assert.equal(ran.length, 0, 'the rerun ran nothing');
      assert.equal(fs.existsSync(lockFile()), false, 'the refused rerun did not even take the lock');
    });

    const tampers = [
      ['a sidecar whose sha256 was altered', (side) => { side.logSha256 = '0'.repeat(64); }],
      ['a sidecar naming another log', (side) => { side.logPath = '/tmp/some-other.ndjson'; }],
      ['a sidecar claiming more bytes than the log has', (side) => { side.logBytes += 10; }],
      ['a malformed sidecar', () => 'not json'],
      ['a sidecar of the wrong type', (side) => { side.type = 'lock-reclaimed'; }]
    ];
    for (const [label, edit] of tampers) {
      it(`still refuses, as invalid, ${label}`, async () => {
        const s = apiSchedule();
        const executors = recordingExecutors([]);
        const k = s.events[0].kind;
        const inner = executors[k];
        let fired = false;
        executors[k] = async (...a) => { if (!fired) { fired = true; takeOver(); } return inner(...a); };
        await assert.rejects(driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }));
        const sp = driver.lockLostPath(logPath);
        const side = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const out = edit(side);
        fs.writeFileSync(sp, typeof out === 'string' ? out : JSON.stringify(side));
        assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_LOCK_LOST_INVALID', label);
        fs.rmSync(lockFile(), { force: true });
        await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOG_LOCK_LOST_INVALID');
      });
    }

    it('refuses, as invalid, a log cut back after the loss was recorded', async () => {
      const s = apiSchedule();
      const executors = recordingExecutors([]);
      const k = s.events[1].kind;
      const inner = executors[k];
      let fired = false;
      executors[k] = async (...a) => { if (!fired) { fired = true; takeOver(); } return inner(...a); };
      await assert.rejects(driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }));
      const bytes = fs.readFileSync(logPath);
      fs.writeFileSync(logPath, bytes.subarray(0, bytes.length - 5));
      assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_LOCK_LOST_INVALID');
    });

    it('reports LOCK_LOST_UNRECORDED, and still writes no end, when the sidecar cannot be created', { skip: process.getuid && process.getuid() === 0 ? 'running as root: chmod does not deny root' : false }, async () => {
      const s = apiSchedule();
      const executors = recordingExecutors([]);
      const k = s.events[0].kind;
      const inner = executors[k];
      let fired = false;
      executors[k] = async (...a) => {
        if (!fired) { fired = true; takeOver(); fs.chmodSync(dir, 0o500); }
        return inner(...a);
      };
      try {
        await assert.rejects(
          driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }),
          (err) => err.code === 'LOCK_LOST_UNRECORDED' && err.details.sidecar === null && /EACCES/.test(err.details.sidecarError)
        );
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      assert.ok(!logLines().some((r) => r.type === 'end'));
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false);
    });

    it('keeps the run\'s own error first when the lock is also lost, with the recorded loss attached', async () => {
      const boom = new Error('primary failure');
      let calls = 0;
      await assert.rejects(
        driver.runSchedule({
          schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0),
          shouldStop: () => { if (++calls === 3) { takeOver(); throw boom; } return false; }
        }),
        (err) => err === boom && err.lockLost.observed.host === 'intruder' && err.lockLost.sidecar === driver.lockLostPath(logPath)
      );
      assert.ok(fs.existsSync(driver.lockLostPath(logPath)), 'the loss is on record even though another error came first');
    });

    it('keeps the run\'s own error first when the lock is unreadable at release', async () => {
      const boom = new Error('primary failure');
      const ioFail = { readFileSync: () => { const e = new Error('io'); e.code = 'EIO'; throw e; }, rmSync: fs.rmSync };
      let calls = 0;
      await assert.rejects(
        driver.runSchedule({
          schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), lockDeps: { releaseFs: ioFail },
          shouldStop: () => { if (++calls === 3) throw boom; return false; }
        }),
        (err) => err === boom && /lock unreadable \(EIO\)/.test(err.ownershipUnverified.why) && err.lockLost === undefined
      );
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false, 'an unverified lock condemns nothing');
      assert.equal(driver.readSegment(logPath).state, 'active', 'the segment stays open');
    });
  });

  it('reports LOCK_RELEASE_FAILED, not a loss, when a clean run cannot remove the lock it still owns', async () => {
    const s = apiSchedule();
    const perm = { readFileSync: fs.readFileSync, rmSync: () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; } };
    await assert.rejects(
      driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), lockDeps: { releaseFs: perm } }),
      (err) => err.code === 'LOCK_RELEASE_FAILED' && err.details.result.status === 'completed'
    );
    assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false, 'no sidecar: the lock was never lost');
    // The lock was never released, so the segment stays open until a later
    // run reconciles it (once this owner is dead). Until then it is not evidence.
    assert.equal(driver.readSegment(logPath).owner.pid, process.pid);
    assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_SEGMENT_OPEN');
    const raw = fs.readFileSync(logPath, 'utf8');
    assert.ok(raw.includes('"type":"end"'), 'the log itself is intact and complete');
  });

  describe('the segment marker', () => {
    const logLines = () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const deadPid = () => require('node:child_process').spawnSync(process.execPath, ['-e', '0']).pid;

    /**
     * Leave the log as a crashed run would: part-written, with its lock and its
     * open segment both naming `owner`.
     * @param {object} s - Schedule
     * @param {{pid: number, host: string}} owner - The crashed run's owner
     * @param {object} [o] - `{complete, lock}`: finish the log first; write the lock (default true)
     */
    async function crashedRun(s, owner, o = {}) {
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), shouldStop: o.complete ? undefined : afterEvents(2) });
      driver.openSegment(logPath, owner, T0 + 1);
      if (o.lock !== false) fs.writeFileSync(`${logPath}.lock`, JSON.stringify(owner));
    }

    it('opens durably before work and closes on a clean finish or a graceful stop', async () => {
      const s = apiSchedule();
      let seenMidRun = null;
      const executors = recordingExecutors([]);
      const k = s.events[0].kind;
      const inner = executors[k];
      executors[k] = async (...a) => { if (seenMidRun === null) seenMidRun = driver.readSegment(logPath); return inner(...a); };
      await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0), shouldStop: afterEvents(2) });
      assert.deepEqual(seenMidRun.owner, { pid: process.pid, host: os.hostname() }, 'the marker exists while the run works');
      assert.equal(driver.readSegment(logPath), null, 'a graceful stop closes the segment, so it can be resumed');
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
      assert.equal(driver.readSegment(logPath), null);
      assert.equal(driver.readLog(logPath).ended, true);
    });

    it('refuses to be read as evidence while a segment is open, even by a caller mid-run', async () => {
      const s = apiSchedule();
      const executors = recordingExecutors([]);
      const k = s.events[0].kind;
      const inner = executors[k];
      let refusal = null;
      executors[k] = async (...a) => {
        if (refusal === null) { try { driver.readLog(logPath); refusal = 'none'; } catch (err) { refusal = err.code; } }
        return inner(...a);
      };
      await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) });
      assert.equal(refusal, 'LOG_SEGMENT_OPEN');
    });

    it('resumes an ordinary crash, where the lock and the marker name the same dead owner, and records the recovery', async () => {
      const s = apiSchedule();
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashedRun(s, owner);
      const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
      assert.equal(result.status, 'completed-ownership-unverified', 'an exact-owner reclaim is never a clean completion');
      const resume = logLines().find((r) => r.type === 'resume');
      assert.deepEqual(resume.recoveredFrom, { owner, segmentStartedAt: T0 + 1, state: 'ownership-unverified' }, 'the recovery is on record, written under the new lock');
      assert.equal(driver.readSegment(logPath), null);
      assert.equal(fs.existsSync(`${logPath}.lock`), false);
      assert.equal(driver.readLog(logPath).ended, true);
    });

    it('reconciles a crash between end and release: the log is complete, and it closes cleanly', async () => {
      const s = apiSchedule();
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashedRun(s, owner, { complete: true });
      const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
      assert.deepEqual([result.status, result.recoveredFrom.owner], ['already-complete-ownership-unverified', owner]);
      assert.equal(logLines().filter((r) => r.type === 'resume').at(-1).recoveredFrom.state, 'ownership-unverified', 'the recovery is recorded even though the log was complete');
      assert.equal(driver.readSegment(logPath), null);
      assert.equal(driver.readLog(logPath).ended, true);
    });

    it('fails safe on a crash between release and marker-clear: the lock is gone, so it is never resumed', async () => {
      const s = apiSchedule();
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashedRun(s, owner, { complete: true, lock: false });
      await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOG_SEGMENT_UNRECONCILED' && err.details.condemned === driver.lockLostPath(logPath));
      assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_LOCK_LOST', 'the refusal is recorded, so it is permanent');
      assert.equal(fs.existsSync(`${logPath}.lock`), false, 'the refused run released the lock it took');
    });

    it('never resumes when the old lock names a different owner than the marker', async () => {
      const s = apiSchedule();
      await crashedRun(s, { pid: deadPid(), host: os.hostname() }, { lock: false });
      fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: deadPid(), host: os.hostname() }));
      await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOG_SEGMENT_UNRECONCILED' && err.details.lockFound !== null);
    });

    it('keeps the unrecorded double fault condemned: the lock is lost AND the sidecar cannot be written', { skip: process.getuid && process.getuid() === 0 ? 'running as root: chmod does not deny root' : false }, async () => {
      const s = apiSchedule();
      const executors = recordingExecutors([]);
      const k = s.events[0].kind;
      const inner = executors[k];
      let fired = false;
      executors[k] = async (...a) => { if (!fired) { fired = true; fs.rmSync(`${logPath}.lock`); fs.chmodSync(dir, 0o500); } return inner(...a); };
      try {
        await assert.rejects(driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOCK_LOST_UNRECORDED');
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false, 'no sidecar could be written');
      assert.ok(driver.readSegment(logPath), 'but the segment is still open');
      // Later, with the directory writable again: never resumed, never read.
      const ran = [];
      await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOG_SEGMENT_UNRECONCILED');
      assert.equal(ran.length, 0);
      assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_SEGMENT_OPEN');
      assert.ok(!fs.readFileSync(logPath, 'utf8').includes('"type":"end"'), 'and it never reads as complete');
    });

    it('commits a graceful stop under ownership: a stop record, then a stopped-clean marker, then release, then cleanup', async () => {
      const s = apiSchedule();
      const seen = [];
      // Watch the marker's state at each release, via a release-time fs stand-in.
      const watch = {
        readFileSync: (p, enc) => { if (p === `${logPath}.lock` && fs.existsSync(driver.segmentPath(logPath))) seen.push(JSON.parse(fs.readFileSync(driver.segmentPath(logPath), 'utf8')).state); return fs.readFileSync(p, enc); },
        rmSync: fs.rmSync
      };
      const r = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), shouldStop: afterEvents(2), lockDeps: { releaseFs: watch } });
      assert.equal(r.status, 'stopped');
      assert.deepEqual(seen, ['stopped-clean'], 'the marker was stopped-clean when the lock was released');
      const recs = logLines();
      assert.deepEqual(recs[recs.length - 1], { type: 'stop', at: recs[recs.length - 1].at, lastIndex: 1 }, 'the stop record is the last thing written');
      assert.equal(driver.readSegment(logPath), null, 'cleanup removed the marker');
      const again = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
      assert.equal(again.status, 'completed');
    });

    /**
     * Leave the log as a clean stop whose cleanup never ran: the stop and the
     * stopped-clean marker are durable, and the lock is gone.
     * @param {object} s - Schedule
     * @returns {Promise<object>} The stopped-clean marker
     */
    async function stoppedButNotCleaned(s) {
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), shouldStop: afterEvents(2) });
      const owner = { pid: deadPid(), host: os.hostname() };
      driver.openSegment(logPath, owner, T0 + 1);
      driver.stopSegment(logPath, driver.readSegment(logPath), T0 + 2);
      return driver.readSegment(logPath);
    }

    it('resumes a clean stop whose cleanup never ran, even with no lock, and records it', async () => {
      const s = apiSchedule();
      const m = await stoppedButNotCleaned(s);
      assert.equal(m.state, 'stopped-clean');
      assert.equal(fs.existsSync(`${logPath}.lock`), false);
      const r = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
      assert.equal(r.status, 'completed');
      assert.deepEqual(logLines().find((x) => x.type === 'resume').recoveredFrom, { owner: m.owner, segmentStartedAt: T0 + 1, state: 'stopped-clean' });
    });

    it('never lets a judge read a leftover stopped-clean segment as evidence', async () => {
      await stoppedButNotCleaned(apiSchedule());
      assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_SEGMENT_OPEN');
    });

    const stoppedTampers = [
      ['a byte appended to the log after the stop', () => fs.appendFileSync(logPath, '{"type":"event","index":9}\n')],
      ['a stopped-clean marker whose whole-log sha256 was altered', (mp) => { const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.logSha256 = '0'.repeat(64); fs.writeFileSync(mp, JSON.stringify(m)); }],
      ['a stopped-clean marker missing its binding', (mp) => { const m = JSON.parse(fs.readFileSync(mp, 'utf8')); delete m.logBytes; fs.writeFileSync(mp, JSON.stringify(m)); }],
      ['a marker with an unknown state', (mp) => { const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.state = 'done'; fs.writeFileSync(mp, JSON.stringify(m)); }]
    ];
    for (const [label, tamper] of stoppedTampers) {
      it(`refuses ${label}`, async () => {
        const s = apiSchedule();
        await stoppedButNotCleaned(s);
        tamper(driver.segmentPath(logPath));
        await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOG_SEGMENT_INVALID', label);
      });
    }

    it('writes neither the stop record nor the transition when the lock is lost before the stop commits', async () => {
      const s = apiSchedule();
      let n = 0;
      await assert.rejects(
        driver.runSchedule({
          schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0),
          shouldStop: () => {
            if (fs.existsSync(logPath) && logLines().filter((r) => r.type === 'event').length >= 2 && n++ === 0) { fs.rmSync(`${logPath}.lock`); return true; }
            return false;
          }
        }),
        (err) => err.code === 'LOCK_LOST'
      );
      assert.ok(!logLines().some((r) => r.type === 'stop'), 'no stop record');
      assert.ok(fs.existsSync(driver.segmentPath(logPath)), 'the segment stays open');
      const m = JSON.parse(fs.readFileSync(driver.segmentPath(logPath), 'utf8'));
      assert.equal(m.state, 'active', 'the marker never became stopped-clean');
      await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOG_LOCK_LOST');
    });

    it('keeps the run\'s own error first when closing the segment also fails, and reports it', async () => {
      const boom = new Error('primary failure');
      const failRm = { rmSync: () => { const e = new Error('io'); e.code = 'EIO'; throw e; } };
      let calls = 0;
      await assert.rejects(
        driver.runSchedule({
          schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), segmentFs: failRm,
          shouldStop: () => { if (++calls === 3) throw boom; return false; }
        }),
        (err) => err === boom && /could not be removed \(EIO\)/.test(err.segmentCloseFailed.why)
      );
      assert.ok(fs.existsSync(driver.segmentPath(logPath)), 'the marker stays, so the log stays refused');
    });

    it('fails a clean run with SEGMENT_CLOSE_FAILED when the marker cannot be removed', async () => {
      const failRm = { rmSync: () => { const e = new Error('io'); e.code = 'EIO'; throw e; } };
      await assert.rejects(
        driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), segmentFs: failRm }),
        (err) => err.code === 'SEGMENT_CLOSE_FAILED' && err.details.result.status === 'completed'
      );
      assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_SEGMENT_OPEN');
    });

    it('reports how the lock release went when a reconcile is refused', async () => {
      const s = apiSchedule();
      await crashedRun(s, { pid: deadPid(), host: os.hostname() }, { lock: false });
      const perm = { readFileSync: fs.readFileSync, rmSync: () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; } };
      await assert.rejects(
        driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), lockDeps: { releaseFs: perm } }),
        (err) => err.code === 'LOG_SEGMENT_UNRECONCILED' && /EPERM/.test(err.lockRelease.releaseFailed.why)
      );
    });

    const tampers = [
      ['a marker naming another log', (m) => { m.logPath = '/tmp/other.ndjson'; }],
      ['a marker whose start sha256 was altered', (m) => { m.logSha256AtStart = '0'.repeat(64); }],
      ['a marker claiming more bytes than the log has', (m) => { m.logBytesAtStart += 100; }],
      ['a malformed marker', () => '{not json'],
      ['a marker with no owner', (m) => { delete m.owner; }]
    ];
    for (const [label, edit] of tampers) {
      it(`refuses ${label}, for resume and for reading`, async () => {
        const s = apiSchedule();
        const owner = { pid: deadPid(), host: os.hostname() };
        await crashedRun(s, owner);
        const mp = driver.segmentPath(logPath);
        const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
        const out = edit(m);
        fs.writeFileSync(mp, typeof out === 'string' ? out : JSON.stringify(m));
        await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOG_SEGMENT_INVALID', label);
        assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_SEGMENT_INVALID', label);
      });
    }
  });

  it('never reclaims a lock held on another host', async () => {
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 1, host: 'elsewhere' }));
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), lockDeps: { isAlive: () => false } }),
      (err) => err.code === 'LOG_LOCKED'
    );
  });

  it('refuses a header without a real start time, instead of firing every event at once', async () => {
    for (const startEpochMs of [undefined, 'soon', 0, -5, 1.5]) {
      fs.writeFileSync(logPath, `${JSON.stringify({ type: 'header', schema: driver.LOG_SCHEMA, scheduleDigest: apiSchedule().digest, startEpochMs })}\n`);
      await assert.rejects(
        driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
        (err) => err.code === 'LOG_UNREADABLE',
        String(startEpochMs)
      );
    }
  });
});

describe('soak driver — ownership that cannot be verified', () => {
  const asRoot = process.getuid && process.getuid() === 0 ? 'running as root: chmod does not deny root' : false;
  const lockFile = () => `${logPath}.lock`;
  const logLines = () => records(logPath);
  const deadPid = () => require('node:child_process').spawnSync(process.execPath, ['-e', '0']).pid;
  const sha = (buf) => require('node:crypto').createHash('sha256').update(buf).digest('hex');
  const run = (over = {}) => driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), ...over });

  /**
   * Executors that call `hook` once, inside the second event.
   * @param {Function} hook - Called once
   * @returns {object} Executors
   */
  function secondEventDoes(hook) {
    const out = {};
    let calls = 0;
    for (const [kind, fn] of Object.entries(recordingExecutors([]))) {
      out[kind] = async (...a) => { if (++calls === 2) hook(); return fn(...a); };
    }
    return out;
  }

  /**
   * Leave the log as a crashed run would: part-written, with an open
   * segment naming `owner`, and the lock as `lock` says.
   * @param {{pid: number, host: string}} owner - The crashed run's owner
   * @param {string|null} lock - Lock file content, or null for none
   */
  async function crashed(owner, lock) {
    await run({ shouldStop: afterEvents(2) });
    driver.openSegment(logPath, owner, T0 + 1);
    if (lock !== null) fs.writeFileSync(lockFile(), lock);
  }

  // V1, variant 1: the lock became unreadable mid-run, and the sidecar could
  // not have been written either. It used to fail LOCK_LOST_UNRECORDED and,
  // once the lock read back, resume as an ordinary crash to ended=true.
  it('V1 mid-run: stops at an unreadable lock with nothing more written, and a later resume is recorded and never clean', { skip: asRoot }, async () => {
    const owner = { pid: deadPid(), host: os.hostname() };
    const executors = secondEventDoes(() => { fs.chmodSync(lockFile(), 0o000); fs.chmodSync(dir, 0o500); });
    try {
      await assert.rejects(run({ executors, lockDeps: { pid: owner.pid } }),
        (err) => err.code === 'OWNERSHIP_UNVERIFIED' && /EACCES/.test(err.details.why) && err.details.expected.pid === owner.pid);
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.chmodSync(lockFile(), 0o600);
    }
    assert.deepEqual(logLines().filter((r) => r.type === 'event').map((r) => r.index), [0], 'the event in flight and everything after it were never written');
    assert.ok(!logLines().some((r) => r.type === 'end'));
    assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false, 'no sidecar: nothing shows another writer');
    assert.equal(fs.readFileSync(lockFile(), 'utf8'), JSON.stringify(owner), 'the unreadable lock was left exactly as it was');
    assert.deepEqual([driver.readSegment(logPath).state, driver.readSegment(logPath).owner], ['active', owner]);
    assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_SEGMENT_OPEN', 'not evidence in the meantime');

    // The lock reads back naming the exact dead owner: resumable, but marked.
    const result = await run();
    assert.deepEqual([result.status, result.ownershipUnverified], ['completed-ownership-unverified', true]);
    const resume = logLines().find((r) => r.type === 'resume');
    assert.deepEqual(resume.recoveredFrom, { owner, segmentStartedAt: resume.recoveredFrom.segmentStartedAt, state: 'ownership-unverified' });
    const log = driver.readLog(logPath);
    assert.equal(log.ended, true);
    assert.deepEqual([log.ownership.verified, log.ownership.unverifiedSegments.map((u) => u.owner)], [false, [owner]]);
    const bytes = fs.readFileSync(logPath);
    assert.deepEqual(log.certification, {
      automaticPassAllowed: false,
      defaultDisposition: 'fail-reset',
      reason: 'OWNERSHIP_UNVERIFIED',
      operatorAcceptance: { required: true, evidence: { logPath: path.resolve(logPath), logBytes: bytes.length, logSha256: sha(bytes) } }
    });
  });

  // V1, variant 3: the directory alone becomes unreadable (the
  // lock file itself is never touched) at the third event, then is restored.
  // Nothing about the lock file differs afterwards, so no lock metadata could
  // tell this apart from an ordinary crash.
  it('V1 with only the directory unreadable: stops, leaves everything in place, and the resume is marked', { skip: asRoot }, async () => {
    const owner = { pid: deadPid(), host: os.hostname() };
    const executors = {};
    let calls = 0;
    for (const [kind, fn] of Object.entries(recordingExecutors([]))) {
      executors[kind] = async (...a) => { if (++calls === 3) fs.chmodSync(dir, 0o000); return fn(...a); };
    }
    try {
      await assert.rejects(run({ executors, lockDeps: { pid: owner.pid } }), (err) => err.code === 'OWNERSHIP_UNVERIFIED' && /EACCES/.test(err.details.why));
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.deepEqual(logLines().filter((r) => r.type === 'event').map((r) => r.index), [0, 1]);
    assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false);
    assert.equal(fs.readFileSync(lockFile(), 'utf8'), JSON.stringify(owner));
    assert.equal(driver.readSegment(logPath).state, 'active');
    const result = await run();
    assert.deepEqual([result.status, result.ownershipUnverified], ['completed-ownership-unverified', true]);
    assert.equal(logLines().find((r) => r.type === 'resume').recoveredFrom.state, 'ownership-unverified');
    assert.equal(driver.readLog(logPath).certification.automaticPassAllowed, false);
  });

  // V1, variant 2: every event and `end` were written under verified
  // ownership, then the lock could not be read at release. It used to resume
  // straight to already-complete, leaving no trace in the log.
  it('V1 at release: leaves the lock and segment in place, and the already-complete resume is recorded and never clean', async () => {
    const owner = { pid: deadPid(), host: os.hostname() };
    const eio = { readFileSync: () => { const e = new Error('io'); e.code = 'EIO'; throw e; }, rmSync: () => assert.fail('an unverified lock is never removed') };
    await assert.rejects(run({ lockDeps: { pid: owner.pid, releaseFs: eio } }),
      (err) => err.code === 'OWNERSHIP_UNVERIFIED' && err.details.result.status === 'completed' && /EIO/.test(err.details.why));
    assert.ok(logLines().some((r) => r.type === 'end'));
    assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false);
    assert.equal(fs.readFileSync(lockFile(), 'utf8'), JSON.stringify(owner));
    assert.equal(driver.readSegment(logPath).state, 'active');
    assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_SEGMENT_OPEN');

    const before = logLines().length;
    const result = await run();
    assert.deepEqual([result.status, result.ran, result.ownershipUnverified], ['already-complete-ownership-unverified', 0, true]);
    const added = logLines().slice(before);
    assert.deepEqual(added.map((r) => r.type), ['resume', 'lock-reclaimed'], 'the recovery is persisted in the log');
    assert.equal(added[0].recoveredFrom.state, 'ownership-unverified');
    assert.equal(driver.readLog(logPath).certification.automaticPassAllowed, false);
    // Asking again changes nothing: the log stays marked.
    const again = await run();
    assert.deepEqual([again.status, again.ownershipUnverified], ['already-complete-ownership-unverified', true]);
  });

  it('keeps a clean run clean: verified ownership, an automatic pass allowed, exit-worthy completed', async () => {
    const result = await run();
    assert.deepEqual([result.status, result.ownershipUnverified], ['completed', false]);
    const log = driver.readLog(logPath);
    assert.deepEqual([log.ownership, log.certification.automaticPassAllowed, log.certification.defaultDisposition], [{ verified: true, unverifiedSegments: [] }, true, null]);
  });

  it('lets a judge accept only the exact evidence the disposition names', async () => {
    const owner = { pid: deadPid(), host: os.hostname() };
    await crashed(owner, JSON.stringify(owner));
    await run();
    const cert = driver.readLog(logPath).certification;
    const exact = { ...cert.operatorAcceptance.evidence };
    assert.equal(driver.acceptanceMatches(cert, exact), true);
    for (const [label, bad] of [
      ['other bytes', { ...exact, logSha256: '0'.repeat(64) }],
      ['another size', { ...exact, logBytes: exact.logBytes + 1 }],
      ['another log', { ...exact, logPath: '/tmp/other.ndjson' }],
      ['no binding', {}],
      ['nothing', null]
    ]) assert.equal(driver.acceptanceMatches(cert, bad), false, label);
    assert.equal(driver.acceptanceMatches(driver.readLog(logPath).certification, exact), true, 'reading again names the same evidence');
    fs.appendFileSync(logPath, `${JSON.stringify({ type: 'note' })}\n`);
    assert.equal(driver.acceptanceMatches(driver.readLog(logPath).certification, exact), false, 'an acceptance does not follow the log once it changes');
  });

  describe('a recovery that fails before it is recorded', () => {
    /**
     * Resume an exact-owner crash under a (dead) identity that `fail` makes
     * fail before the resume record, then resume it correctly.
     * @param {object} over - What makes the first resume fail
     * @param {Function} [after] - Undo the failure before the correct rerun
     * @returns {Promise<object>} The correct rerun's result
     */
    async function failThenResume(over, after) {
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashed(owner, JSON.stringify(owner));
      const before = fs.readFileSync(logPath);
      const second = { pid: deadPid(), host: os.hostname() };
      let caught = null;
      try {
        await run({ lockDeps: { pid: second.pid }, ...over });
      } catch (err) { // the failure under test
        caught = err;
      } finally {
        if (after) after();
      }
      assert.ok(caught, 'the first resume failed');
      assert.deepEqual(caught.recoveryPending.owner, second, 'the failure says the recovery is still pending');
      assert.equal(fs.readFileSync(`${logPath}.lock`, 'utf8'), JSON.stringify(second), 'the lock is left as a crash would leave it');
      assert.deepEqual([driver.readSegment(logPath).state, driver.readSegment(logPath).owner], ['active', second], 'and so is the segment');
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false);
      assert.ok(fs.readFileSync(logPath).subarray(0, before.length).equals(before));
      const result = await run();
      assert.equal(result.ownershipUnverified, true);
      assert.equal(driver.readLog(logPath).certification.automaticPassAllowed, false);
      return result;
    }

    it('keeps the mark through a resume with the wrong schedule', async () => {
      const result = await failThenResume({ schedule: apiSchedule({ seed: 'other' }) });
      assert.equal(result.status, 'completed-ownership-unverified');
    });

    it('never lets a resume that finds the log damaged end clean, repaired or not', async () => {
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashed(owner, JSON.stringify(owner));
      const original = fs.readFileSync(logPath);
      fs.appendFileSync(logPath, 'garbage\n{"type":"note"}\n'); // damage in the middle, after the marker's bound prefix
      const second = { pid: deadPid(), host: os.hostname() };
      await assert.rejects(run({ lockDeps: { pid: second.pid } }), (err) => err.code === 'LOG_UNREADABLE' && err.recoveryPending.owner.pid === second.pid);
      assert.equal(fs.readFileSync(`${logPath}.lock`, 'utf8'), JSON.stringify(second), 'left as a crash would leave it');
      await assert.rejects(run({ lockDeps: { pid: deadPid() } }), (err) => err.code === 'LOG_UNREADABLE' && !!err.recoveryPending, 'still pending, not laundered');
      fs.writeFileSync(logPath, original);
      await assert.rejects(run(), (err) => err.code === 'LOG_SEGMENT_INVALID', 'a repair under an open segment is a rewrite, and refused');
    });

    it('keeps the mark through a resume whose record could not be written', { skip: asRoot }, async () => {
      let restore;
      const result = await failThenResume({
        clock: (() => {
          const c = fakeClock(T0);
          let done = false;
          return { ...c, now: () => { if (!done) { done = true; fs.chmodSync(logPath, 0o400); restore = () => fs.chmodSync(logPath, 0o600); } return c.now(); } };
        })()
      }, () => restore());
      assert.equal(result.status, 'completed-ownership-unverified');
    });
  });

  describe('exact owner and exact bindings', () => {
    it('never resumes when the lock names the marker\'s pid on another host', async () => {
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashed(owner, JSON.stringify({ pid: owner.pid, host: 'elsewhere' }));
      await assert.rejects(run(), (err) => err.code === 'LOG_LOCKED');
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false, 'a lock on another host proves nothing about the owner');
    });

    it('never resumes, and condemns, when the lock names another dead process on this host', async () => {
      const owner = { pid: deadPid(), host: os.hostname() };
      const other = { pid: deadPid(), host: os.hostname() };
      await crashed(owner, JSON.stringify(other));
      await assert.rejects(run(), (err) => err.code === 'LOG_SEGMENT_UNRECONCILED' && err.details.lockFound.pid === other.pid && err.details.condemned === driver.lockLostPath(logPath));
      fs.writeFileSync(lockFile(), JSON.stringify(owner));
      await assert.rejects(run(), (err) => err.code === 'LOG_LOCK_LOST', 'a lock restored to name the exact owner resumes nothing');
    });

    it('never resumes an exact-owner lock when the marker is on another host', async () => {
      const pid = deadPid();
      await crashed({ pid, host: 'elsewhere' }, JSON.stringify({ pid, host: os.hostname() }));
      await assert.rejects(run(), (err) => err.code === 'LOG_SEGMENT_UNRECONCILED' && err.details.condemned === null);
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false, 'an owner on another host is not provably dead, so it is not condemned');
    });

    it('never resumes an exact-owner lock when the log no longer begins with the bytes the marker bound', async () => {
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashed(owner, JSON.stringify(owner));
      const bytes = fs.readFileSync(logPath);
      bytes[bytes.indexOf('"index":0') + 8] = 0x37; // one digit of the first event's index
      fs.writeFileSync(logPath, bytes);
      await assert.rejects(run(), (err) => err.code === 'LOG_SEGMENT_INVALID');
    });
  });

  describe('permanent refusal', () => {
    it('condemns a segment whose lock was removed, so a lock restored later still resumes nothing', async () => {
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashed(owner, null);
      await assert.rejects(run(), (err) => err.code === 'LOG_SEGMENT_UNRECONCILED' && err.details.lockFound === null && err.details.condemned !== null);
      const side = JSON.parse(fs.readFileSync(driver.lockLostPath(logPath), 'utf8'));
      assert.deepEqual([side.expected, side.observed], [owner, null]);
      fs.writeFileSync(lockFile(), JSON.stringify(owner));
      await assert.rejects(run(), (err) => err.code === 'LOG_LOCK_LOST');
      assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_LOCK_LOST');
    });

    it('condemns a segment whose lock is unreadable at recovery, even once it reads back as the exact owner', { skip: asRoot }, async () => {
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashed(owner, JSON.stringify(owner));
      fs.chmodSync(lockFile(), 0o000);
      try {
        await assert.rejects(run(), (err) => err.code === 'LOG_SEGMENT_UNRECONCILED' && /unreadable \(EACCES\)/.test(err.message) && err.details.condemned !== null);
      } finally {
        fs.chmodSync(lockFile(), 0o600);
      }
      await assert.rejects(run(), (err) => err.code === 'LOG_LOCK_LOST');
    });

    it('condemns a segment whose lock holds no identity at recovery', async () => {
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashed(owner, 'not json');
      await assert.rejects(run(), (err) => err.code === 'LOG_SEGMENT_UNRECONCILED' && /unparseable/.test(err.message));
      fs.writeFileSync(lockFile(), JSON.stringify(owner));
      await assert.rejects(run(), (err) => err.code === 'LOG_LOCK_LOST');
    });

    it('is permanent only once recorded: a directory unreadable at recovery refuses, names the directory, and a later resume is still marked', { skip: asRoot }, async () => {
      const owner = { pid: deadPid(), host: os.hostname() };
      await crashed(owner, JSON.stringify(owner));
      fs.chmodSync(dir, 0o000);
      try {
        await assert.rejects(run(), (err) => err.code === 'LOG_LOCK_LOST_INVALID'
          && err.details.directoryUnreadable === path.dirname(path.resolve(logPath))
          && /directory .* cannot be read \(EACCES\)/.test(err.message)
          && /whether it has a lock-lost sidecar is unknown/.test(err.message)
          && !/has a lock-lost sidecar that cannot be read/.test(err.message));
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false, 'nothing could be recorded in an unreadable directory');
      const result = await run();
      assert.deepEqual([result.status, result.ownershipUnverified], ['completed-ownership-unverified', true], 'the documented exception: it resumes, but never clean');
    });

    it('still says the sidecar itself cannot be read when only the sidecar is unreadable', { skip: asRoot }, async () => {
      fs.writeFileSync(logPath, '');
      fs.writeFileSync(driver.lockLostPath(logPath), '{}');
      fs.chmodSync(driver.lockLostPath(logPath), 0o000);
      try {
        assert.throws(() => driver.checkLockLost(logPath), (err) => err.code === 'LOG_LOCK_LOST_INVALID' && err.details.directoryUnreadable === null
          && /has a lock-lost sidecar that cannot be read \(EACCES\)/.test(err.message));
      } finally {
        fs.chmodSync(driver.lockLostPath(logPath), 0o600);
      }
    });

    it('never condemns a segment whose owner may still be running', async () => {
      await crashed({ pid: process.pid, host: os.hostname() }, null);
      await assert.rejects(run(), (err) => err.code === 'LOG_SEGMENT_UNRECONCILED' && err.details.condemned === null);
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false, 'a live owner may be finishing its segment right now');
      fs.writeFileSync(lockFile(), 'not json');
      await assert.rejects(run(), (err) => err.code === 'LOG_LOCKED' && err.details.lockUnreadable === 'unparseable');
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false);
    });

    it('still condemns a lock removed or taken over mid-run as LOCK_LOST, never as unverified', async () => {
      await assert.rejects(run({ executors: secondEventDoes(() => fs.rmSync(lockFile())) }), (err) => err.code === 'LOCK_LOST');
      assert.ok(fs.existsSync(driver.lockLostPath(logPath)));
      fs.rmSync(driver.lockLostPath(logPath));
      fs.rmSync(driver.segmentPath(logPath));
      fs.rmSync(logPath);
      await assert.rejects(run({ executors: secondEventDoes(() => fs.writeFileSync(lockFile(), JSON.stringify({ pid: 1, host: 'intruder' }))) }), (err) => err.code === 'LOCK_LOST');
      assert.ok(fs.existsSync(driver.lockLostPath(logPath)));
    });
  });

  describe('a segment that could not be closed', () => {
    it('says to start a new log or reset by hand when the marker could not be removed', async () => {
      const failRm = { rmSync: () => { const e = new Error('io'); e.code = 'EIO'; throw e; } };
      await assert.rejects(run({ segmentFs: failRm }), (err) => err.code === 'SEGMENT_CLOSE_FAILED' && err.details.cleanup === 'marker-remains'
        && /start a new log, or reset it by hand/.test(err.message) && !/until it is reconciled/.test(err.message));
      assert.ok(fs.existsSync(driver.segmentPath(logPath)));
    });

    it('reports the cleanup as unknown, not as a marker that remains, when the unlink worked but the directory fsync failed', async () => {
      const failSync = { fsyncDir: () => { const e = new Error('io'); e.code = 'EIO'; throw e; } };
      await assert.rejects(run({ segmentFs: failSync }), (err) => err.code === 'SEGMENT_CLOSE_FAILED' && err.details.cleanup === 'unknown'
        && /unknown/.test(err.message) && !/could not be removed/.test(err.message) && err.details.result.status === 'completed');
      assert.equal(fs.existsSync(driver.segmentPath(logPath)), false, 'the marker is gone now; only its durability is unknown');
    });
  });
});
