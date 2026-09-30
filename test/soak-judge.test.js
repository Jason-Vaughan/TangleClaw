'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const bundle = require('../lib/soak/bundle');
const driver = require('../lib/soak/driver');
const integrity = require('../lib/soak/integrity');
const judge = require('../lib/soak/judge');
const sched = require('../lib/soak/schedule');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
/** The sampler's interval in these fixtures. */
const SAMPLE_MS = 10 * MIN;
const T0 = 1_790_000_000_000;
const CAND = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

let dir;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-judge-'))); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * The sha256 of a file.
 * @param {string} p - File
 * @returns {string} Hex digest
 */
function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * Run a 72-hour certifying api schedule to completion from T0 on a fake
 * clock, every event succeeding. An hourly load mean keeps it to about 70
 * events.
 * @param {object} [opts] - `{phase, durationMs, seed, outcome, reclaimed, tornEvent}`: the schedule's phase, length and seed; `outcome(n)` gives the n-th event's result; `reclaimed` leaves the run crashed after two events, its lock and open segment naming a dead owner, and resumes it, which the driver records as ownership-unverified; `tornEvent` also makes that crash lose only the second event's final newline, so the resume seals a whole record and runs the event again
 * @returns {Promise<{schedule: object, schedulePath: string, logPath: string, startedAt: number, completedAt: number}>} The run
 */
async function finishedRun(opts = {}) {
  const schedule = sched.buildSchedule({ seed: opts.seed || 'judge', phase: opts.phase || 'certifying', durationMs: opts.durationMs || 72 * HOUR, loadMeanMs: HOUR, classes: ['api'] });
  const schedulePath = path.join(dir, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify(schedule));
  const logPath = path.join(dir, 'soak.ndjson');
  let n = 0;
  const executors = {};
  for (const t of sched.TASKS.filter((k) => k.class === 'api')) {
    executors[t.kind] = async () => (opts.outcome ? opts.outcome(n++) : { ok: true, code: 'OK', status: 200 });
  }
  let t = T0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  // A coarse stop poll keeps the wait to the schedule's horizon cheap here.
  const stopPollMs = HOUR;
  if (opts.reclaimed) {
    const events = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('"type":"event"')).length : 0;
    await driver.runSchedule({ schedule, executors, ctx: {}, logPath, clock, stopPollMs, shouldStop: () => events() >= 2 });
    if (opts.tornEvent) {
      // A crash, not a stop: no stop record, and the last event's write lost
      // only its newline.
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      assert.equal(JSON.parse(lines.at(-1)).type, 'stop');
      fs.writeFileSync(logPath, lines.slice(0, -1).join('\n'));
      fs.rmSync(driver.segmentPath(logPath), { force: true });
    }
    const owner = { pid: require('node:child_process').spawnSync(process.execPath, ['-e', '0']).pid, host: os.hostname() };
    driver.openSegment(logPath, owner, t);
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify(owner));
  }
  const result = await driver.runSchedule({ schedule, executors, ctx: {}, logPath, clock, stopPollMs });
  assert.equal(result.status, opts.reclaimed ? 'completed-ownership-unverified' : 'completed');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { schedule, schedulePath, logPath, startedAt: lines[0].startEpochMs, completedAt: lines.at(-1).completedAt };
}

/**
 * Write a samples file covering [from, to] every SAMPLE_MS, all healthy
 * unless `edit` changes a record.
 * @param {number} from - First sample time
 * @param {number} to - Last sample time
 * @param {function(object, number): object} [edit] - Rewrites the i-th sample
 * @returns {string} The file
 */
function samplesFile(from, to, edit = (x) => x) {
  const file = path.join(dir, 'samples.ndjson');
  // Written in one go, in the sampler's format: one JSON record per line.
  const records = [{ type: 'header', schema: integrity.SAMPLES_SCHEMA, home: '/h', intervalMs: SAMPLE_MS }];
  let i = 0;
  for (let at = from; at <= to; at += SAMPLE_MS, i++) {
    records.push(edit({ type: 'sample', seq: i, at, db: { check: 'quick_check', state: 'ok', bytes: 10 }, process: { pid: 1, alive: true, rssKb: 100, openFds: 20 }, disk: { freeBytes: 500, totalBytes: 1000 }, health: { status: 200 } }, i));
  }
  fs.writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
  return file;
}

/**
 * A guest home holding a sound database.
 * @returns {string} The home
 */
function home() {
  const h = path.join(dir, 'home');
  fs.mkdirSync(h);
  const db = new DatabaseSync(path.join(h, 'tangleclaw.db'));
  db.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7);');
  db.close();
  return h;
}

/**
 * A complete, passing bundle and the certification run it is judged for.
 * @param {object} [opts] - `finishedRun` options, and `{candidateSha, samples: false, db: false, edit}`
 * @returns {Promise<{out: string, run: object, soak: object}>} The bundle, the run identity and the soak run
 */
async function passingBundle(opts = {}) {
  const soak = await finishedRun(opts);
  const samples = opts.samples === false ? undefined : samplesFile(soak.startedAt, soak.completedAt, opts.edit);
  const out = path.join(dir, 'evidence');
  bundle.buildBundle({ candidateSha: opts.candidateSha || CAND, out, schedule: soak.schedulePath, log: soak.logPath, samples, home: opts.db === false ? undefined : home() });
  const run = { candidateSha: CAND, runId: 'a'.repeat(32), manifestDigest: 'b'.repeat(64), startedAt: soak.startedAt - MIN, updatedAt: soak.completedAt + MIN };
  assert.ok(soak.completedAt - soak.startedAt >= soak.schedule.params.durationMs, 'the fixture ran to its horizon');
  return { out, run, soak };
}

/**
 * The reason codes of a judgement.
 * @param {object} j - Judgement
 * @returns {string[]} Codes
 */
function codes(j) {
  return j.reasons.map((r) => r.code);
}

/**
 * Rewrite the bundle's manifest, keeping its file list consistent.
 * @param {string} out - Bundle
 * @param {function(object): void} edit - Mutates the manifest
 * @returns {void}
 */
function editManifest(out, edit) {
  const p = path.join(out, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  edit(m);
  fs.writeFileSync(p, JSON.stringify(m));
}

/**
 * Replace a bundled file and re-bind it in the manifest, as someone forging a
 * consistent bundle would.
 * @param {string} out - Bundle
 * @param {string} rel - Bundled path
 * @param {string|Buffer} content - New content
 * @returns {void}
 */
function forge(out, rel, content) {
  fs.writeFileSync(path.join(out, rel), content);
  editManifest(out, (m) => {
    const f = m.files.find((x) => x.path === rel);
    f.bytes = fs.statSync(path.join(out, rel)).size;
    f.sha256 = sha(path.join(out, rel));
  });
}

describe('soak judge — a passing bundle', () => {
  it('passes, and binds every digest it vouches for to the run', async () => {
    const { out, run, soak } = await passingBundle();
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual(j.reasons, []);
    assert.equal(j.passed, true);
    assert.equal(j.schema, judge.JUDGEMENT_SCHEMA);
    assert.deepEqual(j.binding, {
      candidateSha: CAND, runId: run.runId, manifestDigest: run.manifestDigest,
      bundleManifestSha256: sha(path.join(out, 'manifest.json')), bundleCandidateSha: CAND,
      scheduleDigest: soak.schedule.digest, logBytes: fs.statSync(soak.logPath).size, logSha256: sha(soak.logPath),
      soakStartedAt: soak.startedAt, soakCompletedAt: soak.completedAt, ownershipVerified: true, operatorAcceptance: null
    });
  });

  it('tolerates a sample that failed or could not measure, while coverage still holds', async () => {
    const { out, run } = await passingBundle({ edit: (x, i) => {
      if (i === 2) return { type: 'sample-failed', seq: x.seq, at: x.at, error: 'EIO' };
      if (i === 4) return { ...x, db: { check: 'quick_check', state: 'unavailable', error: 'locked' } };
      if (i === 6) return { ...x, process: { pid: 1, alive: null, reason: 'ps timed out' } };
      return x;
    } });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), []);
  });
});

describe('soak judge — the bundle itself (fail closed)', () => {
  it('refuses a missing or unparsable manifest, and judges nothing else', async () => {
    const { out, run } = await passingBundle();
    fs.writeFileSync(path.join(out, 'manifest.json'), '{nope');
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['MANIFEST_INVALID']);
    fs.rmSync(path.join(out, 'manifest.json'));
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual([codes(j), j.passed], [['MANIFEST_MISSING'], false]);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: path.join(dir, 'absent'), run })), ['MANIFEST_MISSING']);
  });

  it('refuses a manifest of another schema, or with a file entry outside the bundle', async () => {
    const { out, run } = await passingBundle();
    editManifest(out, (m) => { m.schema = 'tc.soak-evidence/v0'; });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['MANIFEST_INVALID']);
    for (const bad of ['../x', '/etc/passwd', 'a/../schedule.json', 'manifest.json']) {
      const again = await (async () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); return passingBundle(); })();
      editManifest(again.out, (m) => { m.files.push({ path: bad, bytes: 1, sha256: 'c'.repeat(64) }); });
      assert.deepEqual(codes(judge.judgeBundle({ bundleDir: again.out, run: again.run })), ['MANIFEST_INVALID'], bad);
    }
  });

  it('refuses a bundled file whose bytes differ from the manifest', async () => {
    const { out, run } = await passingBundle();
    fs.appendFileSync(path.join(out, 'samples.ndjson'), '');
    const logFile = path.join(out, 'soak-log.ndjson');
    const bytes = fs.readFileSync(logFile);
    bytes[10] = bytes[10] ^ 1;
    fs.writeFileSync(logFile, bytes);
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ code: 'FILE_MISMATCH', file: 'soak-log.ndjson' }]);
  });

  it('refuses a listed file that is missing or a symlink, and a file the manifest does not list', async () => {
    const { out, run } = await passingBundle();
    fs.rmSync(path.join(out, 'samples.ndjson'));
    fs.symlinkSync(path.join(dir, 'samples.ndjson'), path.join(out, 'samples.ndjson'));
    fs.writeFileSync(path.join(out, 'soak-log.ndjson.segment'), '{}\n');
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual(j.reasons, [{ code: 'FILE_MISSING', file: 'samples.ndjson' }, { code: 'FILE_UNLISTED', file: 'soak-log.ndjson.segment' }]);
    assert.equal(j.binding.bundleManifestSha256, null, 'an untrusted bundle binds nothing');
  });
});

describe('soak judge — a damaged bundle is a reason, never a crash', () => {
  it('refuses a bundle whose manifest does not list the log or the schedule, even with a directory in its place', async () => {
    for (const rel of ['soak-log.ndjson', 'schedule.json']) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle();
      fs.rmSync(path.join(out, rel));
      fs.mkdirSync(path.join(out, rel));
      editManifest(out, (m) => { m.files = m.files.filter((f) => f.path !== rel); });
      assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ code: 'FILE_MISSING', file: rel }], rel);
    }
  });

  it('refuses samples with a line that is JSON but not a record', async () => {
    const { out, run } = await passingBundle();
    forge(out, 'samples.ndjson', `${fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8')}null\n`);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['SAMPLES_UNREADABLE']);
  });
});

describe('soak judge — the candidate (A5)', () => {
  it('refuses a bundle naming another candidate', async () => {
    const { out, run } = await passingBundle({ candidateSha: OTHER });
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual(j.reasons, [{ code: 'CANDIDATE_SHA_MISMATCH', bundle: OTHER, run: CAND }]);
  });

  it('refuses a bundle with no candidate, or a malformed one', async () => {
    for (const bad of [undefined, null, 'abc1234', CAND.toUpperCase(), 42]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle();
      editManifest(out, (m) => { if (bad === undefined) delete m.candidateSha; else m.candidateSha = bad; });
      assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['CANDIDATE_SHA_INVALID'], String(bad));
    }
  });

  it('takes the run identity from the caller only, and refuses a malformed one as a bug', async () => {
    const { out, run } = await passingBundle();
    for (const bad of [null, { ...run, candidateSha: 'abc' }, { ...run, runId: '' }, { ...run, manifestDigest: undefined }, { ...run, startedAt: '1' }]) {
      assert.throws(() => judge.judgeBundle({ bundleDir: out, run: bad }), TypeError);
    }
    assert.throws(() => judge.judgeBundle({ bundleDir: 'relative', run }), TypeError);
  });
});

describe('soak judge — schedule and log', () => {
  it('refuses a destructive-phase soak', async () => {
    const { out, run } = await passingBundle({ phase: 'destructive' });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['SCHEDULE_NOT_CERTIFYING']);
  });

  it('refuses a schedule edited after the fact, even re-bound in the manifest', async () => {
    const { out, run } = await passingBundle();
    const s = JSON.parse(fs.readFileSync(path.join(out, 'schedule.json'), 'utf8'));
    s.events.pop();
    forge(out, 'schedule.json', JSON.stringify(s));
    const c = codes(judge.judgeBundle({ bundleDir: out, run }));
    assert.ok(c.includes('SCHEDULE_INVALID'), c.join());
  });

  it('refuses a log that belongs to another schedule', async () => {
    const { out, run } = await passingBundle();
    const other = sched.buildSchedule({ seed: 'another', phase: 'certifying', durationMs: 72 * HOUR, loadMeanMs: HOUR, classes: ['api'] });
    forge(out, 'schedule.json', JSON.stringify(other));
    editManifest(out, (m) => { m.summary.schedule.digest = other.digest; });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['LOG_SCHEDULE_MISMATCH']);
  });

  it('refuses a summary that disagrees with what the judge re-derives', async () => {
    const { out, run } = await passingBundle();
    editManifest(out, (m) => { m.summary.log.ended = false; });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['SUMMARY_MISMATCH']);
  });

  it('refuses a log that never ended, whatever the summary says', async () => {
    const { out, run } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'soak-log.ndjson'), 'utf8').trim().split('\n');
    forge(out, 'soak-log.ndjson', `${lines.slice(0, -1).join('\n')}\n`);
    const c = codes(judge.judgeBundle({ bundleDir: out, run }));
    assert.ok(c.includes('LOG_NOT_ENDED') && c.includes('OUTSIDE_RUN_WINDOW'), c.join());
  });

  it('refuses a log the driver will not read as evidence (a lost lock)', async () => {
    const { out, run } = await passingBundle();
    fs.writeFileSync(driver.lockLostPath(path.join(out, 'soak-log.ndjson')), '{}\n');
    editManifest(out, (m) => {
      const rel = path.basename(driver.lockLostPath(path.join(out, 'soak-log.ndjson')));
      m.files.push({ path: rel, bytes: fs.statSync(path.join(out, rel)).size, sha256: sha(path.join(out, rel)) });
    });
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.equal(j.reasons[0].code, 'LOG_REFUSED');
    assert.equal(j.passed, false);
  });

  it('refuses a soak outside the run\'s window', async () => {
    const { out, run, soak } = await passingBundle();
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run: { ...run, startedAt: soak.startedAt + 1 } })), ['OUTSIDE_RUN_WINDOW']);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run: { ...run, updatedAt: soak.completedAt - 1 } })), ['OUTSIDE_RUN_WINDOW']);
  });
});

describe('soak judge — every scheduled event is a required test (A6.4)', () => {
  /**
   * Rewrite the bundled log's records and re-bind it, as a forger would.
   * @param {string} out - Bundle
   * @param {function(object[]): object[]} edit - Maps the records
   * @returns {void}
   */
  function editLog(out, edit) {
    const lines = fs.readFileSync(path.join(out, 'soak-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    forge(out, 'soak-log.ndjson', `${edit(lines).map((l) => JSON.stringify(l)).join('\n')}\n`);
  }

  it('fails an event that did not succeed, a fault that could not be injected or recover included, naming the first and the count', async () => {
    const { out, run } = await passingBundle({ outcome: (n) => (n === 5 || n === 9 ? { ok: false, code: n === 5 ? 'RECOVERY_FAILED' : 'HTTP_STATUS', status: 500 } : { ok: true, code: 'OK', status: 200 }) });
    const [r, ...rest] = judge.judgeBundle({ bundleDir: out, run }).reasons;
    assert.deepEqual(rest, []);
    assert.deepEqual([r.code, r.index, r.code === 'EVENT_FAILED' && r.count], ['EVENT_FAILED', 5, 2]);
  });

  it('fails a skipped event, including one skipped as stale', async () => {
    const { out, run } = await passingBundle();
    editLog(out, (rs) => rs.map((x) => (x.type === 'event' && x.index === 3 ? { ...x, skipped: true, ok: null, code: 'SKIPPED_STALE' } : x)));
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons.map((r) => [r.code, r.index]), [['EVENT_SKIPPED', 3]]);
  });

  it('fails a missing event, a duplicated one, and one the schedule does not hold', async () => {
    const cases = [
      ['EVENT_MISSING', (rs) => rs.filter((x) => !(x.type === 'event' && x.index === 4))],
      ['EVENT_DUPLICATE', (rs) => rs.flatMap((x) => (x.type === 'event' && x.index === 4 ? [x, x] : [x]))],
      ['EVENT_UNKNOWN', (rs) => rs.map((x) => (x.type === 'event' && x.index === 4 ? { ...x, kind: 'api.not-this-one' } : x))],
      ['EVENT_UNKNOWN', (rs) => [...rs.slice(0, -1), { ...rs.find((x) => x.type === 'event'), index: 99999 }, rs.at(-1)]]
    ];
    for (const [code, edit] of cases) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle();
      editLog(out, edit);
      const got = judge.judgeBundle({ bundleDir: out, run }).reasons.map((r) => r.code);
      // A kind that does not match leaves its index unaccounted for too.
      assert.deepEqual(got.filter((c) => c !== 'EVENT_MISSING' || code === 'EVENT_MISSING'), [code], `${code}: ${got}`);
    }
  });

  it('fails a log whose end record counts other events than the schedule', async () => {
    const { out, run } = await passingBundle();
    editLog(out, (rs) => rs.map((x) => (x.type === 'end' ? { ...x, events: x.events + 1 } : x)));
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['EVENT_COUNT_MISMATCH']);
  });
});

describe('soak judge — the certifying 72-hour schedule (A6.5, A7)', () => {
  it('fails a log whose end came before the schedule\'s horizon', async () => {
    const { out, run, soak } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'soak-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const lastEvent = lines.filter((x) => x.type === 'event').at(-1);
    lines.at(-1).completedAt = lastEvent.startedAt + lastEvent.durationMs;
    forge(out, 'soak-log.ndjson', `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons,
      [{ code: 'RUN_TOO_SHORT', ranMs: lines.at(-1).completedAt - soak.startedAt, durationMs: 72 * HOUR }]);
  });

  it('fails a certifying schedule of any other length', async () => {
    const { out, run } = await passingBundle({ durationMs: 12 * HOUR });
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ code: 'SCHEDULE_DURATION', durationMs: 12 * HOUR, required: judge.CERTIFYING_DURATION_MS }]);
  });
});

describe('soak judge — a log that survived a crash', () => {
  it('does not count a sealed record the driver ran again', async () => {
    const { out, run } = await passingBundle({ reclaimed: true, tornEvent: true });
    const lines = fs.readFileSync(path.join(out, 'soak-log.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const indexes = lines.filter((x) => x.type === 'event').map((x) => x.index);
    assert.ok(indexes.length > new Set(indexes).size, 'the fixture really logged one event twice, the first copy sealed');
    assert.ok(lines.some((x) => x.type === 'torn-tail-sealed'));
    const e = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).summary.log.certification.operatorAcceptance.evidence;
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run, acceptance: { ...e, actor: 'operator', at: T0 } })), []);
  });
});

describe('soak judge — ownership (A4c)', () => {
  it('fails and resets an ownership-unverified log with no acceptance', async () => {
    const { out, run } = await passingBundle({ reclaimed: true });
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual(j.reasons, [{ code: 'OWNERSHIP_UNVERIFIED', disposition: 'fail-reset' }]);
    assert.equal(j.binding.ownershipVerified, false);
  });

  it('passes it only on an Operator acceptance of exactly that log', async () => {
    const { out, run, soak } = await passingBundle({ reclaimed: true });
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const e = m.summary.log.certification.operatorAcceptance.evidence;
    assert.equal(e.logPath, path.resolve(soak.logPath), 'the disposition names the original log');
    const acceptance = { ...e, actor: 'operator', at: T0 + 99 };
    const j = judge.judgeBundle({ bundleDir: out, run, acceptance });
    assert.deepEqual(j.reasons, []);
    assert.deepEqual(j.binding.operatorAcceptance, { actor: 'operator', at: T0 + 99, logSha256: e.logSha256 });
  });

  it('refuses an acceptance of other bytes, another path, or with no actor', async () => {
    const { out, run } = await passingBundle({ reclaimed: true });
    const e = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).summary.log.certification.operatorAcceptance.evidence;
    const ok = { ...e, actor: 'operator', at: T0 };
    for (const [acceptance, code] of [
      [{ ...ok, logSha256: 'd'.repeat(64) }, 'OWNERSHIP_UNVERIFIED'],
      [{ ...ok, logBytes: e.logBytes + 1 }, 'OWNERSHIP_UNVERIFIED'],
      [{ ...ok, logPath: '/elsewhere/soak.ndjson' }, 'OWNERSHIP_UNVERIFIED'],
      [{ ...ok, actor: ' ' }, 'ACCEPTANCE_INVALID'],
      [{ ...ok, at: 'now' }, 'ACCEPTANCE_INVALID'],
      ['yes', 'ACCEPTANCE_INVALID']
    ]) {
      assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run, acceptance })), [code], JSON.stringify(acceptance));
    }
  });

  it('never lets an acceptance turn a verified log\'s other failures into a pass', async () => {
    const { out, run } = await passingBundle({ candidateSha: OTHER });
    const j = judge.judgeBundle({ bundleDir: out, run, acceptance: { logPath: '/x', logBytes: 1, logSha256: 'e'.repeat(64), actor: 'operator', at: 1 } });
    assert.deepEqual(codes(j), ['CANDIDATE_SHA_MISMATCH']);
    assert.equal(j.binding.operatorAcceptance, null);
  });
});

describe('soak judge — samples and database', () => {
  it('fails on data corruption in any sample', async () => {
    const { out, run } = await passingBundle({ edit: (x, i) => (i === 3 ? { ...x, db: { check: 'quick_check', state: 'corrupt', bytes: 10 } } : x) });
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ code: 'DATA_CORRUPTION', sampleSeq: 3 }]);
  });

  it('fails when the server is not alive and healthy at the last sample', async () => {
    for (const last of [{ health: { status: 503 } }, { process: { pid: 1, alive: false } }]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle();
      const lines = fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      Object.assign(lines.at(-1), last);
      forge(out, 'samples.ndjson', `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ code: 'SERVER_NOT_RECOVERED', sampleSeq: lines.at(-1).seq }], JSON.stringify(last));
    }
  });

  it('fails a server that died and came back only as unknown', async () => {
    const { out, run } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    lines.at(-2).process = { pid: 1, alive: false };
    lines.at(-1).process = { pid: 1, alive: null, reason: 'ps timed out' };
    forge(out, 'samples.ndjson', `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    // Unknown liveness is not evidence: recovery is judged at the last sample
    // that is, which found the server down. That sample is one interval
    // before the log's end, so coverage still holds.
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['SERVER_NOT_RECOVERED']);
  });

  it('fails failed samples once they leave a gap longer than two intervals', async () => {
    const { out, run } = await passingBundle({ edit: (x, i) => (i >= 3 && i <= 5 ? { type: 'sample-failed', seq: x.seq, at: x.at, error: 'EIO' } : x) });
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ code: 'COVERAGE', detail: 'gap', afterSampleSeq: 2 }]);
  });

  it('does not count a sample with no time, and fails samples out of order', async () => {
    const untimed = await passingBundle({ edit: (x, i) => (i > 0 && i < 400 ? { ...x, at: null } : x) });
    assert.deepEqual(judge.judgeBundle({ bundleDir: untimed.out, run: untimed.run }).reasons.map((r) => r.detail), ['gap']);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const swapped = await passingBundle({ edit: (x, i) => (i === 5 ? { ...x, at: x.at - 2 * SAMPLE_MS } : x) });
    assert.deepEqual(judge.judgeBundle({ bundleDir: swapped.out, run: swapped.run }).reasons.map((r) => r.detail), ['out-of-order']);
  });

  it('needs at least two evidentiary samples', async () => {
    const { out, run } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    forge(out, 'samples.ndjson', `${[lines[0], lines.at(-1)].map((l) => JSON.stringify(l)).join('\n')}\n`);
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ code: 'COVERAGE', detail: 'fewer than two evidentiary samples' }]);
  });

  it('fails samples that start late, stop early or leave a gap', async () => {
    // A sample whose database check could not run is not evidence, so a run
    // of them is a hole in the coverage.
    const unavailable = (x) => ({ ...x, db: { check: 'quick_check', state: 'unavailable', error: 'locked' } });
    const cases = [
      ['late-start', (x, i) => (i === 0 || i === 1 ? unavailable(x) : x)],
      ['gap', (x, i) => (i >= 3 && i <= 5 ? unavailable(x) : x)]
    ];
    for (const [detail, edit] of cases) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle({ edit });
      assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons.map((r) => r.detail), [detail], detail);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const { out, run } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8').trim().split('\n');
    forge(out, 'samples.ndjson', `${lines.slice(0, -3).join('\n')}\n`);
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons.map((r) => r.detail), ['early-stop']);
  });

  it('fails a bundle with no samples, torn samples, or samples with no interval', async () => {
    const none = await passingBundle({ samples: false });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: none.out, run: none.run })), ['SAMPLES_MISSING']);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const torn = await passingBundle();
    forge(torn.out, 'samples.ndjson', `${fs.readFileSync(path.join(torn.out, 'samples.ndjson'), 'utf8')}{"type":"sam`);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: torn.out, run: torn.run })), ['SAMPLES_TORN']);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const nohdr = await passingBundle();
    const lines = fs.readFileSync(path.join(nohdr.out, 'samples.ndjson'), 'utf8').trim().split('\n');
    forge(nohdr.out, 'samples.ndjson', `${lines.slice(1).join('\n')}\n`);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: nohdr.out, run: nohdr.run })), ['SAMPLES_UNREADABLE']);
  });

  it('fails a bundle with no database snapshot, or a snapshot that is damaged', async () => {
    const none = await passingBundle({ db: false });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: none.out, run: none.run })), ['DB_SNAPSHOT_MISSING']);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const bad = await passingBundle();
    const rel = path.join('db', 'tangleclaw.db');
    const bytes = fs.readFileSync(path.join(bad.out, rel));
    forge(bad.out, rel, Buffer.concat([Buffer.from('not a database'), bytes.subarray(14)]));
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: bad.out, run: bad.run })), ['DB_SNAPSHOT_NOT_OK']);
  });
});

describe('soak judge — bound into the host\'s finalization and certification of record (A4d)', () => {
  const fx = require('./_release-certification-fixtures');
  const hc = require('../lib/release-certification/host-checks');
  const hostPublish = require('../lib/release-certification/host-publish');
  const store = require('../lib/release-certification/store');
  const GREEN = async () => ({ observation: { state: 'ok', checks: { test: 'success' } }, error: null });
  const PASSED = { state: 'passed', canonicalThresholds: true };

  /**
   * Judge a real bundle for a real host-attested run, finalize it on the host
   * with that judgement, and say whether the host would certify it.
   * @param {object} bundleOpts - `passingBundle` options
   * @param {function(string): object} [accept] - Given the bundle directory, the Operator's acceptance
   * @returns {Promise<{judgement: object, outcome: object, certified: boolean}>} What happened
   */
  async function finalizeWithSoak(bundleOpts, accept = () => null) {
    const { out, soak } = await passingBundle({ candidateSha: fx.SHA, ...bundleOpts });
    const hostBase = path.join(dir, 'host');
    hc.mintRun(hostBase, { candidateSha: fx.SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => fx.RUN_ID });
    const manifest = fx.manifest({ checksSource: 'host-attested', checksExchange: '/x', publishRemote: '/x/metrics.git', isolationProducer: '/x/guest-setup.sh' });
    const digest = store.manifestDigest(store.manifestText(manifest));
    const state = { state: 'awaiting-review', sampleCount: 0, baseline: { bootId: fx.BOOT_ID }, startedAt: soak.startedAt - MIN, updatedAt: soak.completedAt + MIN };
    const judgement = judge.judgeBundle({ bundleDir: out, run: { candidateSha: manifest.candidateSha, runId: manifest.runId, manifestDigest: digest, startedAt: state.startedAt, updatedAt: state.updatedAt }, acceptance: accept(out) });
    const outcome = await hc.finalize({ hostBase, manifest, manifestDigest: digest, state, samples: [], observe: GREEN, soakJudgement: judgement });
    const finalization = hc.readFinalization(hostBase, fx.SHA, fx.RUN_ID);
    return { judgement, outcome, certified: hostPublish.certifiedFrom(PASSED, finalization), finalization };
  }

  it('certifies a passed run only with a passing soak bound to it, and records the evidence it vouched for', async () => {
    const r = await finalizeWithSoak({});
    assert.deepEqual([r.judgement.passed, r.outcome, r.certified], [true, { ok: true, reasons: [] }, true]);
    assert.equal(r.finalization.soak.binding.bundleManifestSha256, sha(path.join(dir, 'evidence', 'manifest.json')));
  });

  it('never certifies when the soak found data corruption', async () => {
    const r = await finalizeWithSoak({ edit: (x, i) => (i === 2 ? { ...x, db: { check: 'quick_check', state: 'corrupt', bytes: 10 } } : x) });
    assert.deepEqual([r.outcome.reasons, r.certified], [[{ code: 'SOAK_JUDGEMENT_FAILED' }], false]);
    assert.deepEqual(r.finalization.soak.reasons, [{ code: 'DATA_CORRUPTION', sampleSeq: 2 }], 'why is on record');
  });

  it('never certifies from a bundle of another candidate', async () => {
    const r = await finalizeWithSoak({ candidateSha: OTHER });
    assert.deepEqual([r.outcome.reasons, r.certified], [[{ code: 'SOAK_JUDGEMENT_FAILED' }], false]);
  });

  it('certifies an ownership-unverified soak only on the Operator\'s acceptance of exactly its log', async () => {
    const refused = await finalizeWithSoak({ reclaimed: true });
    assert.deepEqual([refused.finalization.soak.reasons, refused.certified], [[{ code: 'OWNERSHIP_UNVERIFIED', disposition: 'fail-reset' }], false]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    // The Operator accepts exactly the evidence the bundle's disposition names.
    const accept = (out) => ({ ...JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).summary.log.certification.operatorAcceptance.evidence, actor: 'operator', at: T0 });
    const accepted = await finalizeWithSoak({ reclaimed: true }, accept);
    assert.deepEqual([accepted.outcome, accepted.certified], [{ ok: true, reasons: [] }, true]);
  });
});
