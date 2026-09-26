'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const ttydWatcher = require('../lib/ttyd-watcher');

const TTYD_PID = 12345;
const LSTART = 'Fri Sep 25 11:28:54 2026';

/**
 * `launchctl list <label>` output for a running job.
 * @param {number} pid - The job's PID.
 * @returns {string}
 */
function launchctlRunning(pid = TTYD_PID) {
  return `{
\t"StandardOutPath" = "/dev/null";
\t"Label" = "com.tangleclaw.ttyd";
\t"LastExitStatus" = 0;
\t"PID" = ${pid};
\t"Program" = "/opt/homebrew/bin/ttyd";
};
`;
}

const LAUNCHCTL_OUTPUT_NOT_RUNNING = `{
\t"Label" = "com.tangleclaw.ttyd";
\t"OnDemand" = false;
\t"LastExitStatus" = 0;
};
`;

/**
 * `ps -A -o pid=,ppid=,stat=,etime=` rows for children of `ppid`.
 * @param {Array<[string, string]>} children - `[stat, etime]` pairs; pids are assigned from 20000.
 * @param {number} [ppid=TTYD_PID]
 * @returns {string}
 */
function psRows(children, ppid = TTYD_PID) {
  const rows = ['    1     0 Ss   13-02:11:47'];
  children.forEach(([stat, etime], i) => rows.push(`${20000 + i} ${ppid} ${stat} ${etime}`));
  return rows.join('\n') + '\n';
}

/** `n` children in the given state and age. @returns {Array<[string, string]>} */
const many = (n, stat, etime) => Array.from({ length: n }, () => [stat, etime]);

/**
 * Build a runner double that dispatches by (cmd, firstArg) and records calls.
 * A value may be a string, an Error (thrown), or a function returning either,
 * so a test can change what a probe answers between calls.
 * @param {object} responses - keys like 'launchctl:list' → string|Error|Function
 * @returns {Function & { calls: Array }}
 */
function makeRunner(responses) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const key = `${cmd}:${args[0] || ''}`;
    let r = responses[key];
    if (typeof r === 'function') r = r(args);
    if (r instanceof Error) throw r;
    if (typeof r === 'string') return r;
    return '';
  };
  fn.calls = calls;
  return fn;
}

/**
 * A runner for a running ttyd with a healthy pool unless overridden.
 * @param {object} overrides - Response overrides.
 * @returns {Function & { calls: Array }}
 */
function ttydRunner(overrides = {}) {
  return makeRunner({
    'launchctl:list': launchctlRunning(),
    'sysctl:-n': '511\n',
    'sh:-c': '54\n', // ratio 0.106 — nowhere near the 0.85 pool gate
    'ps:-A': psRows([]),
    'ps:-o': `${LSTART}\n`,
    'ps:-p': '/Users/op/.tangleclaw/bin/ttyd\n',
    'launchctl:kickstart': '',
    ...overrides
  });
}

/**
 * A runner whose ttyd is replaced by a new process the moment a kickstart
 * lands — the behaviour of a launchd KeepAlive job.
 * @param {object} overrides - Response overrides for the OLD ttyd.
 * @returns {Function & { calls: Array, kicked: () => boolean }}
 */
function restartingRunner(overrides = {}) {
  let kicked = false;
  const runner = ttydRunner({
    'launchctl:list': () => launchctlRunning(kicked ? 54321 : TTYD_PID),
    'ps:-o': () => (kicked ? 'Fri Sep 25 12:00:00 2026\n' : `${LSTART}\n`),
    'launchctl:kickstart': () => { kicked = true; return ''; },
    ...overrides
  });
  runner.kicked = () => kicked;
  return runner;
}

/**
 * A clock whose `sleep` advances time instantly, so the receipt's bounded
 * re-read loop runs without waiting.
 * @param {number} [start=1_000_000]
 * @returns {{now: Function, sleep: Function, advance: Function}}
 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; }
  };
}

/** Count kickstart invocations in a runner's call log. @returns {number} */
const kicks = (runner) => runner.calls.filter(
  (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
).length;

/**
 * Capture warn-level log output while `fn` runs.
 * @param {Function} fn - Async body.
 * @returns {Promise<string>} Everything logged.
 */
async function captureLog(fn) {
  const lines = [];
  setLevel('warn');
  setConsoleStream({ write: (text) => lines.push(text) });
  try {
    await fn();
  } finally {
    setConsoleStream(null);
    setLevel('error');
  }
  return lines.join('');
}

/**
 * Run `fn` with `process.platform` reading `darwin`, so the macOS-only
 * `start()` path is exercised on every CI host rather than skipped off macOS.
 * @param {Function} fn - Async body.
 * @returns {Promise<*>}
 */
async function asDarwin(fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('ttyd-watcher', () => {
  let clock;
  beforeEach(() => {
    ttydWatcher._reset();
    clock = fakeClock();
    ttydWatcher._setClock(clock);
  });

  afterEach(() => {
    ttydWatcher._reset();
  });

  describe('_parsePid', () => {
    it('parses PID from launchctl list output', () => {
      assert.equal(ttydWatcher._parsePid(launchctlRunning()), 12345);
    });

    it('returns null when service is loaded but not running (no PID line)', () => {
      assert.equal(ttydWatcher._parsePid(LAUNCHCTL_OUTPUT_NOT_RUNNING), null);
    });

    it('returns null for output that is not a job description', () => {
      assert.equal(ttydWatcher._parsePid('Could not find service "x" in domain'), null);
    });
  });

  // ── #144: PTY-pool classification ──
  describe('_poolFromCounts', () => {
    it('trips when used >= floor(cap * threshold)', () => {
      // cap=511, threshold=0.85 → floor(511 * 0.85) = 434. used=434 should trip.
      const result = ttydWatcher._poolFromCounts(511, 434, 0.85);
      assert.equal(result.exhausted, true);
      assert.equal(result.used, 434);
      assert.equal(result.cap, 511);
      assert.ok(result.ratio > 0.84 && result.ratio < 0.86);
    });

    it('trips at the canonical #94 incident shape (used=527, cap=511 → ratio > 1)', () => {
      const result = ttydWatcher._poolFromCounts(511, 527, 0.85);
      assert.equal(result.exhausted, true);
      assert.equal(result.used, 527);
    });

    it('does not trip when used < floor(cap * threshold)', () => {
      const result = ttydWatcher._poolFromCounts(511, 104, 0.85);
      assert.equal(result.exhausted, false);
      assert.equal(result.used, 104);
    });

    it('does NOT trip at floor(cap * threshold) - 1 (off-by-one boundary lock)', () => {
      // Pairs with the used=434 case to lock the >= vs > predicate.
      assert.equal(ttydWatcher._poolFromCounts(511, 433, 0.85).exhausted, false);
    });

    it('returns null — never an empty pool — for a non-numeric or impossible reading', () => {
      // A broken reading is unknown. The old fail-safe `{used: 0, cap: 0}` read
      // as "nothing in use", a clear the machine never said.
      assert.equal(ttydWatcher._poolFromCounts(NaN, 500, 0.85), null);
      assert.equal(ttydWatcher._poolFromCounts(0, 100, 0.85), null);
      assert.equal(ttydWatcher._poolFromCounts(511, NaN, 0.85), null);
      assert.equal(ttydWatcher._poolFromCounts(511, -1, 0.85), null);
    });
  });

  describe('_parseChildren', () => {
    it('keeps only rows whose ppid is ttyd, with each child\'s state and age', () => {
      const out = psRows([['?Es', '02:00:00'], ['S', '00:05']]) + '777 99999 ?Es 05:00\n';
      const children = ttydWatcher._parseChildren(out, TTYD_PID);
      assert.deepEqual(children, [
        { pid: 20000, stat: '?Es', ageMs: 2 * 3600 * 1000 },
        { pid: 20001, stat: 'S', ageMs: 5000 }
      ]);
    });

    it('skips malformed rows without throwing, and returns no children for empty output', () => {
      const out = `garbage line with no ppid\n20000 ${TTYD_PID} ?Es 05:00\nnot numeric ${TTYD_PID} ?Es 05:00\n`;
      assert.equal(ttydWatcher._parseChildren(out, TTYD_PID).length, 1);
      assert.deepEqual(ttydWatcher._parseChildren('', TTYD_PID), []);
    });

    it('keeps a child whose age does not parse, with ageMs null rather than a guess', () => {
      const [child] = ttydWatcher._parseChildren(`20000 ${TTYD_PID} ?Es weird\n`, TTYD_PID);
      assert.equal(child.ageMs, null);
    });
  });

  describe('_parseEtime — macOS ps has no `etimes` keyword', () => {
    it('parses every documented shape of [[dd-]hh:]mm:ss', () => {
      assert.equal(ttydWatcher._parseEtime('05:00'), 5 * 60 * 1000);
      assert.equal(ttydWatcher._parseEtime('02:58:17'), ((2 * 3600) + (58 * 60) + 17) * 1000);
      assert.equal(ttydWatcher._parseEtime('3-02:58:17'),
        ((3 * 86400) + (2 * 3600) + (58 * 60) + 17) * 1000);
      assert.equal(ttydWatcher._parseEtime('  00:07\n'), 7000, 'ps pads and newline-terminates');
    });

    it('returns null rather than a plausible number for anything it does not recognise', () => {
      for (const bad of ['', '   ', 'not-a-time', '17', '1:2:3:4', '-']) {
        assert.equal(ttydWatcher._parseEtime(bad), null, `should reject: ${JSON.stringify(bad)}`);
      }
    });
  });

  describe('takeReading', () => {
    it('reports pid null and measures nothing else when the job is not running', async () => {
      const runner = makeRunner({ 'launchctl:list': LAUNCHCTL_OUTPUT_NOT_RUNNING });
      ttydWatcher._setRunner(runner);
      const r = await ttydWatcher.takeReading();
      assert.equal(r.pid, null);
      assert.equal(r.children, null);
      assert.equal(r.pool, null);
      assert.deepEqual(runner.calls.map((c) => c.cmd), ['launchctl'], 'no sysctl/ps for a job that has no pid');
    });

    it('treats a failing launchctl as not running', async () => {
      ttydWatcher._setRunner(makeRunner({ 'launchctl:list': new Error('not found') }));
      assert.equal((await ttydWatcher.takeReading()).pid, null);
    });

    it('carries the pid, a generation bound to ttyd\'s start time, the running binary, and the sample time', async () => {
      ttydWatcher._setRunner(ttydRunner());
      const r = await ttydWatcher.takeReading();
      assert.equal(r.binary, '/Users/op/.tangleclaw/bin/ttyd', 'which executable launchd is running (#1245, ADR 0018)');
      assert.equal(r.pid, TTYD_PID);
      assert.equal(r.generation, `${TTYD_PID}@${LSTART}`);
      assert.equal(r.sampledAt, clock.now());
    });

    it('leaves the pool null when sysctl or the ls pipeline fails, and still reads the children', async () => {
      ttydWatcher._setRunner(ttydRunner({ 'sysctl:-n': new Error('sysctl: unknown oid') }));
      const r = await ttydWatcher.takeReading();
      assert.equal(r.pool, null);
      assert.deepEqual(r.children, []);
      ttydWatcher._reset();
      ttydWatcher._setRunner(ttydRunner({ 'sh:-c': new Error('sh: command not found') }));
      assert.equal((await ttydWatcher.takeReading()).pool, null);
    });

    it('leaves the children null — not empty — when ps failed', async () => {
      ttydWatcher._setRunner(ttydRunner({ 'ps:-A': new Error('ps: command not found') }));
      const r = await ttydWatcher.takeReading();
      assert.equal(r.children, null);
      assert.equal(r.pool.cap, 511, 'the other gate is still read');
    });

    it('is single-flight: concurrent callers share one measurement', async () => {
      const runner = ttydRunner();
      ttydWatcher._setRunner(runner);
      const [a, b] = await Promise.all([ttydWatcher.takeReading(), ttydWatcher.takeReading()]);
      assert.equal(a, b, 'the panel and the watcher get the SAME reading object');
      assert.equal(runner.calls.filter((c) => c.cmd === 'launchctl').length, 1);
    });

    it('never rejects, even when every probe throws', async () => {
      ttydWatcher._setRunner(() => { throw new Error('boom'); });
      const r = await ttydWatcher.takeReading();
      assert.equal(r.pid, null);
    });
  });

  describe('classifyReading — a wedge is confirmed, a burst is not (R22 Q3 as amended)', () => {
    const OPTS = { orphanThreshold: 20, wedgeAgeMs: ttydWatcher.DEFAULT_WEDGE_AGE_MS };
    const GEN = `${TTYD_PID}@${LSTART}`;
    const EMPTY = { generation: null, since: new Map() };

    /**
     * A reading of the current ttyd.
     * @param {Array<[string, string]>} kids - `[stat, etime]` pairs.
     * @param {object} [extra] - Field overrides.
     * @returns {object}
     */
    function reading(kids, extra = {}) {
      return {
        pid: TTYD_PID,
        generation: GEN,
        sampledAt: 1_000_000,
        children: ttydWatcher._parseChildren(psRows(kids), TTYD_PID),
        pool: ttydWatcher._poolFromCounts(511, 54, 0.85),
        errors: [],
        ...extra
      };
    }

    /**
     * Fold readings through the exiting record and classify the last one, the
     * way the watcher does.
     * @param {...object} readings - In order.
     * @returns {object} The last reading's classification.
     */
    function classifyAfter(...readings) {
      let exiting = EMPTY;
      for (const r of readings) exiting = ttydWatcher.advanceExiting(exiting, r);
      return ttydWatcher.classifyReading(readings[readings.length - 1], exiting, OPTS);
    }

    const later = (ms) => ({ sampledAt: 1_000_000 + ms });

    it('counts only exiting (E) or zombied (Z) children, never live S/R ones (#380 shape)', () => {
      const kids = [['?Es', '02:00:00'], ['?Es', '02:00:00'], ['?Z', '02:00:00'], ['Z+', '02:00:00'], ['?S', '02:00:00'], ['?R', '02:00:00']];
      const c = classifyAfter(reading(kids), reading(kids, later(OPTS.wedgeAgeMs)));
      assert.equal(c.wedged.length, 4);
      assert.equal(c.transient.length, 0);
    });

    it('a burst seen exiting once is transient, not wedged — a reconnect burst does not trip the gate', () => {
      const c = classifyAfter(reading(many(25, '?Es', '00:03')));
      assert.equal(c.wedged.length, 0);
      assert.equal(c.transient.length, 25);
      assert.equal(c.orphanGate, false);
    });

    // `ps etime` is how long a process has EXISTED. Tabs open for hours that all
    // close at once (a network drop, a laptop waking) are hours "old" the moment
    // they begin to exit; judging by etime would restart ttyd on their ordinary
    // exit, the very thrash this predicate replaces.
    it('a long-lived child seen exiting once is transient, however old the process is', () => {
      const c = classifyAfter(reading(many(25, '?Es', '3-02:00:00')));
      assert.equal(c.wedged.length, 0);
      assert.equal(c.transient.length, 25);
      assert.equal(c.orphanGate, false);
    });

    it('is confirmed when the same child is still exiting a full wedge age after it was first seen exiting', () => {
      const c = classifyAfter(reading(many(25, '?Es', '00:03')), reading(many(25, '?Es', '00:03'), later(OPTS.wedgeAgeMs)));
      assert.equal(c.wedged.length, 25);
      assert.equal(c.orphanGate, true);
    });

    it('is not confirmed a moment short of the wedge age, even across several readings', () => {
      const kids = many(25, '?Es', '00:01');
      const c = classifyAfter(reading(kids), reading(kids, later(1000)), reading(kids, later(OPTS.wedgeAgeMs - 1)));
      assert.equal(c.wedged.length, 0);
    });

    it('restarts a child\'s clock when a successful reading shows it no longer exiting', () => {
      const exitingKid = [['?Es', '01:00']];
      const c = classifyAfter(
        reading(exitingKid),
        reading([['S', '01:00']], later(10_000)),
        reading(exitingKid, later(OPTS.wedgeAgeMs + 1000))
      );
      assert.equal(c.wedged.length, 0, 'its exiting time counts from the latest sighting only');
    });

    it('restarts a child\'s clock when a successful reading shows it absent', () => {
      const c = classifyAfter(
        reading([['?Es', '01:00']]),
        reading([], later(10_000)),
        reading([['?Es', '01:00']], later(OPTS.wedgeAgeMs + 1000))
      );
      assert.equal(c.wedged.length, 0);
    });

    it('a failed reading neither advances nor resets the record, and confirms nothing itself', () => {
      const kids = many(25, '?Es', '00:03');
      const failed = reading([], { ...later(10_000), children: null });
      let exiting = ttydWatcher.advanceExiting(EMPTY, reading(kids));
      const before = exiting;
      exiting = ttydWatcher.advanceExiting(exiting, failed);
      assert.equal(exiting, before, 'the record is untouched by a failed reading');
      assert.equal(ttydWatcher.classifyReading(failed, exiting, OPTS).orphanGate, null);
      const confirming = reading(kids, later(OPTS.wedgeAgeMs));
      exiting = ttydWatcher.advanceExiting(exiting, confirming);
      assert.equal(ttydWatcher.classifyReading(confirming, exiting, OPTS).wedged.length, 25,
        'the successful sightings either side still confirm');
    });

    it('a reading with no generation cannot be keyed: nothing is confirmed and the orphan gate is unknown', () => {
      const kids = many(25, '?Es', '00:03');
      let exiting = ttydWatcher.advanceExiting(EMPTY, reading(kids));
      const blind = reading(kids, { ...later(OPTS.wedgeAgeMs), generation: null });
      exiting = ttydWatcher.advanceExiting(exiting, blind);
      const c = ttydWatcher.classifyReading(blind, exiting, OPTS);
      assert.equal(c.wedged.length, 0);
      assert.equal(c.orphanGate, null);
    });

    it('a sighting under a DIFFERENT ttyd generation confirms nothing', () => {
      const old = reading(many(25, '?Es', '00:03'), { generation: '999@Thu Sep 24 01:00:00 2026' });
      const now = reading(many(25, '?Es', '00:03'), later(OPTS.wedgeAgeMs));
      assert.equal(classifyAfter(old, now).wedged.length, 0);
    });

    it('never reads a child\'s process age: an unparseable etime is confirmed exactly like any other', () => {
      const c = classifyAfter(reading([['?Es', 'weird']]), reading([['?Es', 'weird']], later(OPTS.wedgeAgeMs)));
      assert.equal(c.wedged.length, 1);
    });

    it('reports the orphan gate as null — unknown — when the children could not be read', () => {
      const c = ttydWatcher.classifyReading(reading([], { children: null }), EMPTY, OPTS);
      assert.equal(c.orphanGate, null);
      assert.equal(c.wedged, null);
    });

    it('reports the pool gate as null — unknown — when the pool could not be read', () => {
      assert.equal(classifyAfter(reading([], { pool: null })).poolGate, null);
    });
  });

  describe('_kickstartTtyd', () => {
    it('returns true on success and invokes launchctl kickstart', async () => {
      const runner = makeRunner({ 'launchctl:kickstart': '' });
      ttydWatcher._setRunner(runner);
      assert.equal(await ttydWatcher._kickstartTtyd('com.tangleclaw.ttyd'), true);
      const call = runner.calls.find((c) => c.cmd === 'launchctl');
      assert.equal(call.args[0], 'kickstart');
      assert.equal(call.args[1], '-k');
      assert.match(call.args[2], /^gui\/\d+\/com\.tangleclaw\.ttyd$/);
    });

    it('returns false when launchctl fails', async () => {
      ttydWatcher._setRunner(makeRunner({ 'launchctl:kickstart': new Error('permission denied') }));
      assert.equal(await ttydWatcher._kickstartTtyd('com.tangleclaw.ttyd'), false);
    });

    it('returns false without invoking launchctl when uid is unsafe (root or unknown)', async () => {
      const originalGetuid = process.getuid;
      const runner = makeRunner({});
      ttydWatcher._setRunner(runner);
      try {
        process.getuid = () => 0;
        assert.equal(await ttydWatcher._kickstartTtyd('com.tangleclaw.ttyd'), false);
        assert.equal(runner.calls.length, 0);
      } finally {
        process.getuid = originalGetuid;
      }
    });
  });

  /**
   * Take one reading, let the wedge age pass, then tick: the shape in which the
   * watcher can confirm a child it saw exiting before.
   * @returns {Promise<object>} The tick result.
   */
  async function tickAfterSighting() {
    await ttydWatcher.takeReading();
    clock.advance(ttydWatcher.DEFAULT_WEDGE_AGE_MS);
    return ttydWatcher._tick();
  }

  describe('_tick — the gates', () => {
    it('kickstarts when the PTY pool is exhausted past the threshold ratio', async () => {
      const runner = restartingRunner({ 'sh:-c': '527\n' }); // canonical #94 overflow
      ttydWatcher._setRunner(runner);
      const r = await ttydWatcher._tick();
      assert.equal(r.action, 'kickstart');
      assert.equal(kicks(runner), 1);
    });

    it('still kickstarts on pool exhaustion with no exiting children at all (the #144 pool-only gate)', async () => {
      const runner = restartingRunner({ 'sysctl:-n': '100\n', 'sh:-c': '100\n' });
      ttydWatcher._setRunner(runner);
      assert.equal((await ttydWatcher._tick()).action, 'kickstart');
    });

    it('the POOL gate fires on a freshly restarted ttyd full of young children — it is never held', async () => {
      const runner = restartingRunner({ 'sh:-c': '527\n', 'ps:-A': psRows(many(25, '?Es', '00:30')) });
      ttydWatcher._setRunner(runner);
      assert.equal((await ttydWatcher._tick()).action, 'kickstart');
    });

    it('does not kickstart when the pool is below threshold and nothing is exiting', async () => {
      const runner = ttydRunner({ 'sh:-c': '104\n' });
      ttydWatcher._setRunner(runner);
      assert.equal((await ttydWatcher._tick()).action, 'ok');
      assert.equal(kicks(runner), 0);
    });

    it('skips measurement when ttyd is not running', async () => {
      const runner = makeRunner({ 'launchctl:list': LAUNCHCTL_OUTPUT_NOT_RUNNING });
      ttydWatcher._setRunner(runner);
      assert.equal((await ttydWatcher._tick()).action, 'skipped');
      assert.ok(!runner.calls.some((c) => c.cmd === 'sysctl' || c.cmd === 'sh'), 'no pool read without a pid');
      assert.equal(kicks(runner), 0);
    });

    it('kickstarts on confirmed orphans even with the PTY pool well below threshold (#380 regression)', async () => {
      // Pool ratio 230/511 = 0.45 — the pool gate is silent — with 25 children
      // wedged for hours.
      const runner = restartingRunner({ 'sh:-c': '230\n', 'ps:-A': psRows(many(25, '?Es', '03:12:00')) });
      ttydWatcher._setRunner(runner);
      assert.equal((await tickAfterSighting()).action, 'kickstart');
    });

    it('does NOT kickstart when confirmed orphans are below threshold and the pool is healthy', async () => {
      const runner = ttydRunner({ 'ps:-A': psRows(many(5, '?Es', '03:12:00')) });
      ttydWatcher._setRunner(runner);
      assert.equal((await tickAfterSighting()).action, 'ok');
      assert.equal(kicks(runner), 0);
    });

    it('the orphan gate fires even when the pool MEASUREMENT fails — the gates are independent', async () => {
      const runner = restartingRunner({
        'sysctl:-n': new Error('sysctl: command not found'),
        'ps:-A': psRows(many(30, '?Es', '03:12:00'))
      });
      ttydWatcher._setRunner(runner);
      assert.equal((await tickAfterSighting()).action, 'kickstart');
    });

    it('never kickstarts on an unknown reading: a broken pool with no confirmed orphans is measurement-failed', async () => {
      const runner = ttydRunner({ 'sysctl:-n': 'corrupted-binary-output', 'sh:-c': '999\n' });
      ttydWatcher._setRunner(runner);
      assert.equal((await ttydWatcher._tick()).action, 'measurement-failed');
      assert.equal(kicks(runner), 0);
    });

    it('never kickstarts when ps failed, however full the pool reading is short of the threshold', async () => {
      const runner = ttydRunner({ 'ps:-A': new Error('ps: command not found') });
      ttydWatcher._setRunner(runner);
      assert.equal((await ttydWatcher._tick()).action, 'measurement-failed');
      assert.equal(kicks(runner), 0);
    });

    it('does not throw when the runner errors mid-tick (the loop must survive)', async () => {
      ttydWatcher._setRunner(() => { throw new Error('boom'); });
      const r = await ttydWatcher._tick();
      assert.ok(['skipped', 'error'].includes(r.action));
    });

    it('honors a configured orphanThreshold, and defaults it to DEFAULT_ORPHAN_THRESHOLD', async () => {
      assert.equal(ttydWatcher.DEFAULT_ORPHAN_THRESHOLD, 20);
      const runner = restartingRunner({ 'ps:-A': psRows(many(10, '?Es', '03:12:00')) });
      ttydWatcher._setRunner(runner);
      assert.equal((await tickAfterSighting()).action, 'ok', '10 wedges is under the default 20');

      ttydWatcher._reset();
      ttydWatcher._setClock(fakeClock());
      ttydWatcher._configure({ orphanThreshold: 8 });
      const runner2 = restartingRunner({ 'ps:-A': psRows(many(10, '?Es', '03:12:00')) });
      ttydWatcher._setRunner(runner2);
      clock = fakeClock();
      ttydWatcher._setClock(clock);
      assert.equal((await tickAfterSighting()).action, 'kickstart', '10 wedges trips a threshold of 8');
    });
  });

  // The #1245 thrash: a kickstart makes every terminal reconnect at once, and
  // that churn leaves a burst of exiting children. A single-snapshot gate fired
  // on the burst, blanking every terminal again. The confirmed-wedge rule
  // replaces the old 15-minute uptime hold: the burst is transient and ignored,
  // and only children that are still exiting a tick later count.
  describe('_tick — a reconnect burst is not a leak (R22 Q3)', () => {
    it('does not kickstart on a burst of young exiting children', async () => {
      const runner = ttydRunner({ 'ps:-A': psRows(many(25, '?Es', '00:05')) });
      ttydWatcher._setRunner(runner);
      const r = await ttydWatcher._tick();
      assert.equal(r.action, 'ok');
      assert.equal(r.classification.transient.length, 25, 'it still MEASURED the burst — it declined to act on it');
      assert.equal(kicks(runner), 0, 'the terminals do not blank');
    });

    it('does not kickstart when 25 hours-old tabs are all caught mid-exit on one tick', async () => {
      const runner = ttydRunner({ 'ps:-A': psRows(many(25, '?Es', '1-04:00:00')) });
      ttydWatcher._setRunner(runner);
      assert.equal((await ttydWatcher._tick()).action, 'ok');
      assert.equal(kicks(runner), 0, 'process age is not time spent exiting');
    });

    it('does kickstart when the same children are still exiting on a later tick', async () => {
      const runner = restartingRunner({ 'ps:-A': psRows(many(25, '?Es', '00:05')) });
      ttydWatcher._setRunner(runner);
      assert.equal((await ttydWatcher._tick()).action, 'ok');
      clock.advance(ttydWatcher.DEFAULT_INTERVAL_MS);
      assert.equal((await ttydWatcher._tick()).action, 'kickstart', 'a wedge that persists is a leak');
    });

    it('covers a restart this module did not perform — the burst after it is not counted either', async () => {
      // The first reading sees an old ttyd; then ttyd is replaced from outside.
      let external = false;
      const runner = ttydRunner({
        'launchctl:list': () => launchctlRunning(external ? 54321 : TTYD_PID),
        'ps:-o': () => (external ? 'Fri Sep 25 12:00:00 2026\n' : `${LSTART}\n`),
        'ps:-A': () => psRows(many(25, '?Es', '00:05'), external ? 54321 : TTYD_PID)
      });
      ttydWatcher._setRunner(runner);
      await ttydWatcher._tick();
      external = true;
      clock.advance(ttydWatcher.DEFAULT_INTERVAL_MS);
      const r = await ttydWatcher._tick();
      assert.equal(r.action, 'ok', 'the earlier sighting was under a different ttyd, so nothing is confirmed');
      assert.equal(kicks(runner), 0);
    });
  });

  describe('_tick — the kickstart receipt (R22 Q4)', () => {
    it('proves the restart by re-reading until a NEW generation appears: outcome ok', async () => {
      const runner = restartingRunner({ 'sh:-c': '527\n' });
      ttydWatcher._setRunner(runner);
      const r = await ttydWatcher._tick();
      assert.equal(r.receipt.outcome, 'ok');
      assert.deepEqual(r.receipt.from, { pid: TTYD_PID, generation: `${TTYD_PID}@${LSTART}` });
      assert.deepEqual(r.receipt.to, { pid: 54321, generation: '54321@Fri Sep 25 12:00:00 2026' });
      assert.equal(r.receipt.reason, 'pool-exhausted');
      assert.deepEqual(ttydWatcher.lastReceipt(), r.receipt);
    });

    it('records no-new-generation when launchctl accepted but the same ttyd is still running', async () => {
      // launchctl exiting 0 is not proof; only a different process is.
      const runner = ttydRunner({ 'sh:-c': '527\n' });
      ttydWatcher._setRunner(runner);
      const started = clock.now();
      const r = await ttydWatcher._tick();
      assert.equal(r.action, 'kickstart');
      assert.equal(r.receipt.outcome, 'no-new-generation');
      assert.equal(r.receipt.to, null);
      assert.ok(clock.now() - started >= ttydWatcher.RECEIPT_TIMEOUT_MS, 'it waited out the bound, and no longer');
    });

    it('records failed for a refused kickstart, and the gate stays armed for the next tick', async () => {
      const runner = ttydRunner({ 'sh:-c': '527\n', 'launchctl:kickstart': new Error('permission denied') });
      ttydWatcher._setRunner(runner);
      const first = await ttydWatcher._tick();
      assert.equal(first.action, 'kickstart-failed');
      assert.equal(first.receipt.outcome, 'failed');
      const second = await ttydWatcher._tick();
      assert.equal(second.action, 'kickstart-failed', 'it retried rather than holding itself down');
      assert.equal(kicks(runner), 2);
    });

    // The reading that trips a gate may have a pid but no readable start time.
    // Re-reading the SAME ttyd with its start time now readable is not a new
    // process, and the real new ttyd is still this module's own restart.
    it('when the triggering reading had no start time, only a different pid proves the restart', async () => {
      let lstartReads = 0;
      const runner = ttydRunner({
        'sh:-c': '527\n',
        'ps:-o': () => (++lstartReads === 1 ? new Error('ps: lstart unreadable') : `${LSTART}\n`)
      });
      ttydWatcher._setRunner(runner);
      const r = await ttydWatcher._tick();
      assert.equal(r.reading.generation, null, 'the fixture tripped the gate on a generation-less reading');
      assert.equal(r.receipt.outcome, 'no-new-generation', 'the same pid, newly readable, is not a restart');
      assert.equal(r.receipt.to, null);
    });

    it('when the triggering reading had no start time, the new ttyd is recorded as ok and not as external', async () => {
      let kicked = false;
      let lstartReads = 0;
      const runner = ttydRunner({
        'sh:-c': () => (kicked ? '54\n' : '527\n'),
        'launchctl:list': () => launchctlRunning(kicked ? 54321 : TTYD_PID),
        'ps:-o': () => {
          lstartReads++;
          if (kicked) return 'Fri Sep 25 12:00:00 2026\n';
          return lstartReads === 1 ? `${LSTART}\n` : new Error('ps: lstart unreadable');
        },
        'launchctl:kickstart': () => { kicked = true; return ''; }
      });
      ttydWatcher._setRunner(runner);
      // An earlier reading of the old ttyd WITH a generation is in the history.
      await ttydWatcher.takeReading();
      let r;
      const log = await captureLog(async () => { r = await ttydWatcher._tick(); });
      assert.equal(r.reading.generation, null);
      assert.equal(r.receipt.outcome, 'ok');
      assert.equal(r.receipt.to.pid, 54321);
      // The final receipt overwrites anything recorded while waiting, so the
      // log is the only place a misattributed restart would show.
      assert.ok(!/restarted outside the watcher/.test(log), `its own restart was logged as external: ${log}`);
    });

    it('does not record its own restart as an external one', async () => {
      const runner = restartingRunner({ 'sh:-c': '527\n' });
      ttydWatcher._setRunner(runner);
      await ttydWatcher.takeReading();
      const log = await captureLog(() => ttydWatcher._tick());
      assert.ok(!/restarted outside the watcher/.test(log), `its own restart was logged as external: ${log}`);
      assert.equal(ttydWatcher.lastReceipt().outcome, 'ok');
      // The next reading of the new ttyd must not re-classify that restart.
      await ttydWatcher.takeReading();
      assert.equal(ttydWatcher.lastReceipt().outcome, 'ok');
    });

    it('records external-restart for a new generation it did not cause, naming no actor', async () => {
      let external = false;
      ttydWatcher._setRunner(ttydRunner({
        'launchctl:list': () => launchctlRunning(external ? 54321 : TTYD_PID),
        'ps:-o': () => (external ? 'Fri Sep 25 12:00:00 2026\n' : `${LSTART}\n`)
      }));
      await ttydWatcher.takeReading();
      external = true;
      await ttydWatcher.takeReading();
      const receipt = ttydWatcher.lastReceipt();
      assert.equal(receipt.outcome, 'external-restart');
      assert.equal(receipt.reason, null, 'who restarted it is not knowable from here, so nothing is claimed');
      assert.equal(receipt.from.pid, TTYD_PID);
      assert.equal(receipt.to.pid, 54321);
    });

    it('drops every reading of the old generation when ttyd is replaced', async () => {
      let external = false;
      ttydWatcher._setRunner(ttydRunner({
        'launchctl:list': () => launchctlRunning(external ? 54321 : TTYD_PID),
        'ps:-o': () => (external ? 'Fri Sep 25 12:00:00 2026\n' : `${LSTART}\n`)
      }));
      await ttydWatcher.takeReading();
      external = true;
      await ttydWatcher.takeReading();
      assert.equal(ttydWatcher.latestReading().pid, 54321);
    });

    it('logs the receipt, so a restart that did not take is on the record', async () => {
      ttydWatcher._setRunner(ttydRunner({ 'sh:-c': '527\n' }));
      const log = await captureLog(() => ttydWatcher._tick());
      assert.match(log, /ttyd leak detected, kickstarting/);
      assert.match(log, /ttyd kickstart receipt/);
      assert.match(log, /outcome=no-new-generation/);
    });
  });

  describe('_tick — overlap and logging', () => {
    it('refuses to start a tick while one is running', async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      ttydWatcher._setRunner(async (cmd, args) => {
        if (cmd === 'launchctl' && args[0] === 'list') { await gate; return launchctlRunning(); }
        return ttydRunner()(cmd, args);
      });
      const first = ttydWatcher._tick();
      assert.equal((await ttydWatcher._tick()).action, 'overlap');
      release();
      assert.equal((await first).action, 'ok');
    });

    it('logs an incomplete measurement at warn, and does not claim a kickstart', async () => {
      ttydWatcher._setRunner(ttydRunner({ 'ps:-A': new Error('ps: command not found') }));
      const log = await captureLog(() => ttydWatcher._tick());
      assert.match(log, /measurement incomplete/);
      assert.ok(!/kickstarting/.test(log), `an unknown reading must not act: ${log}`);
    });
  });

  describe('configuration — the kill switch and the threshold override (R22 Q5)', () => {
    it('TANGLECLAW_TTYD_WATCHER=off disables the actions and says why', () => {
      for (const v of ['off', 'OFF', '0', 'false']) {
        const c = ttydWatcher._resolveConfig({}, { TANGLECLAW_TTYD_WATCHER: v });
        assert.equal(c.disabled, true, v);
        assert.equal(c.disabledBy, `TANGLECLAW_TTYD_WATCHER=${v}`);
      }
    });

    it('an unrecognised switch value keeps the watcher ENABLED, with a warning', () => {
      const c = ttydWatcher._resolveConfig({}, { TANGLECLAW_TTYD_WATCHER: 'maybe' });
      assert.equal(c.disabled, false);
      assert.match(c.warnings.join(), /stays ENABLED/);
    });

    it('accepts an orphan threshold inside the documented range', () => {
      assert.equal(ttydWatcher._resolveConfig({}, { TANGLECLAW_TTYD_ORPHAN_THRESHOLD: '40' }).orphanThreshold, 40);
      assert.equal(ttydWatcher._resolveConfig({}, { TANGLECLAW_TTYD_ORPHAN_THRESHOLD: String(ttydWatcher.ORPHAN_THRESHOLD_MIN) }).orphanThreshold, ttydWatcher.ORPHAN_THRESHOLD_MIN);
      assert.equal(ttydWatcher._resolveConfig({}, { TANGLECLAW_TTYD_ORPHAN_THRESHOLD: String(ttydWatcher.ORPHAN_THRESHOLD_MAX) }).orphanThreshold, ttydWatcher.ORPHAN_THRESHOLD_MAX);
    });

    it('falls back to the safe default, with a warning, for anything outside it', () => {
      for (const bad of ['0', '4', '201', '12.5', 'twenty', '-20']) {
        const c = ttydWatcher._resolveConfig({}, { TANGLECLAW_TTYD_ORPHAN_THRESHOLD: bad });
        assert.equal(c.orphanThreshold, ttydWatcher.DEFAULT_ORPHAN_THRESHOLD, bad);
        assert.match(c.warnings.join(), /outside the integer range/, bad);
      }
    });

    it('a disabled watcher does not act, and a tick says so', async () => {
      ttydWatcher._configure({}, { TANGLECLAW_TTYD_WATCHER: 'off' });
      const runner = ttydRunner({ 'sh:-c': '527\n' });
      ttydWatcher._setRunner(runner);
      assert.equal((await ttydWatcher._tick()).action, 'disabled');
      assert.equal(kicks(runner), 0);
    });
  });

  describe('measureLeak — the panel reads the watcher\'s own reading', () => {
    it('reports pid null and measures nothing when the job is not running', async () => {
      const runner = makeRunner({ 'launchctl:list': LAUNCHCTL_OUTPUT_NOT_RUNNING });
      ttydWatcher._setRunner(runner);
      const m = await ttydWatcher.measureLeak();
      assert.equal(m.pid, null);
      assert.equal(m.pool, null);
      assert.equal(m.orphans, null);
      assert.equal(runner.calls.length, 1, 'no sysctl/ps for a job that has no pid');
    });

    it('returns both gates read, with the reading\'s identity and the thresholds in force', async () => {
      ttydWatcher._setRunner(ttydRunner({ 'sh:-c': '40\n', 'ps:-A': psRows([['S', '01:00'], ['R', '01:00']]) }));
      const m = await ttydWatcher.measureLeak();
      assert.equal(m.pid, TTYD_PID);
      assert.equal(m.generation, `${TTYD_PID}@${LSTART}`);
      assert.equal(m.sampledAt, clock.now());
      assert.deepEqual({ used: m.pool.used, cap: m.pool.cap, exhausted: m.pool.exhausted }, { used: 40, cap: 511, exhausted: false });
      assert.equal(m.orphans, 0);
      assert.equal(m.transient, 0);
      assert.equal(m.orphanThreshold, ttydWatcher.DEFAULT_ORPHAN_THRESHOLD);
      assert.equal(m.ptyThresholdRatio, ttydWatcher.DEFAULT_PTY_THRESHOLD);
      assert.equal(m.disabled, false);
    });

    it('counts CONFIRMED wedges as orphans, and children not yet seen long enough separately as transient', async () => {
      let later = false;
      // Three children exiting in both readings; seven more appear only in the second.
      ttydWatcher._setRunner(ttydRunner({
        'ps:-A': () => psRows([...many(3, '?Es', '02:00:00'), ...(later ? many(7, '?Es', '00:02') : [])])
      }));
      await ttydWatcher.takeReading();
      clock.advance(ttydWatcher.DEFAULT_WEDGE_AGE_MS);
      later = true;
      const m = await ttydWatcher.measureLeak();
      assert.equal(m.orphans, 3);
      assert.equal(m.transient, 7);
    });

    it('returns pool null and orphans null — never zero — for a probe that failed', async () => {
      ttydWatcher._setRunner(ttydRunner({ 'sysctl:-n': new Error('sysctl: unknown oid'), 'ps:-A': new Error('ps: gone') }));
      const m = await ttydWatcher.measureLeak();
      assert.equal(m.pool, null);
      assert.equal(m.orphans, null);
      assert.equal(m.transient, null);
    });

    it('quotes the threshold the watcher is actually using, not the module default', async () => {
      ttydWatcher._configure({}, { TANGLECLAW_TTYD_ORPHAN_THRESHOLD: '40' });
      ttydWatcher._setRunner(ttydRunner());
      assert.equal((await ttydWatcher.measureLeak()).orphanThreshold, 40);
    });

    it('says when the watcher is disabled', async () => {
      ttydWatcher._configure({}, { TANGLECLAW_TTYD_WATCHER: 'off' });
      ttydWatcher._setRunner(ttydRunner());
      const m = await ttydWatcher.measureLeak();
      assert.equal(m.disabled, true);
      assert.equal(m.disabledBy, 'TANGLECLAW_TTYD_WATCHER=off');
    });

    it('carries the last receipt', async () => {
      ttydWatcher._setRunner(restartingRunner({ 'sh:-c': '527\n' }));
      await ttydWatcher._tick();
      assert.equal((await ttydWatcher.measureLeak()).lastReceipt.outcome, 'ok');
    });
  });

  // The parsers are only as good as the assumption that macOS `ps` prints what
  // they expect. Run them against the real host, read-only, where it can.
  describe('production output shapes (darwin only)', () => {
    it('_parseChildren reads the real `ps -A -o pid=,ppid=,stat=,etime=` output', { skip: process.platform !== 'darwin' }, () => {
      const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,etime='], { encoding: 'utf8' });
      const children = ttydWatcher._parseChildren(out, 1);
      assert.ok(children.length > 0, 'launchd (pid 1) always has children');
      assert.ok(children.every((c) => Number.isFinite(c.ageMs)), 'every real etime parses');
    });

    it('_poolFromCounts classifies the real sysctl and /dev/ttys* counts', { skip: process.platform !== 'darwin' }, () => {
      const cap = parseInt(execFileSync('sysctl', ['-n', 'kern.tty.ptmx_max'], { encoding: 'utf8' }), 10);
      const used = parseInt(execFileSync('sh', ['-c', 'ls /dev/ttys* 2>/dev/null | wc -l'], { encoding: 'utf8' }), 10);
      const pool = ttydWatcher._poolFromCounts(cap, used, 0.85);
      assert.ok(pool && pool.cap > 0 && pool.used >= 0 && typeof pool.exhausted === 'boolean');
    });
  });

  describe('lifecycle', () => {
    it('start() is a no-op on non-darwin platforms — no timer scheduled, no runner calls', () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      const originalSetInterval = global.setInterval;
      const originalSetTimeout = global.setTimeout;
      let scheduled = false;
      const runner = makeRunner({});
      ttydWatcher._setRunner(runner);
      try {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        global.setInterval = (...args) => { scheduled = true; return originalSetInterval.apply(global, args); };
        global.setTimeout = (...args) => { scheduled = true; return originalSetTimeout.apply(global, args); };
        ttydWatcher.start({ intervalMs: 60000 }, {});
        assert.equal(scheduled, false, 'nothing is scheduled on non-darwin');
        assert.equal(runner.calls.length, 0, 'no runner invocations on non-darwin');
      } finally {
        global.setInterval = originalSetInterval;
        global.setTimeout = originalSetTimeout;
        Object.defineProperty(process, 'platform', originalPlatform);
        ttydWatcher.stop();
      }
    });

    it('start() runs the first check immediately rather than a full interval later', async () => {
      const runner = ttydRunner();
      ttydWatcher._setRunner(runner);
      await asDarwin(async () => {
        ttydWatcher.start({ intervalMs: 60 * 60 * 1000 }, {});
        await new Promise((resolve) => setTimeout(resolve, 20));
        ttydWatcher.stop();
      });
      assert.ok(runner.calls.some((c) => c.cmd === 'launchctl' && c.args[0] === 'list'),
        'the boot check ran without waiting an hour');
    });

    it('start() with the kill switch schedules nothing and logs it loudly', async () => {
      const runner = ttydRunner();
      ttydWatcher._setRunner(runner);
      const log = await captureLog(() => asDarwin(async () => {
        ttydWatcher.start({ intervalMs: 60000 }, { TANGLECLAW_TTYD_WATCHER: 'off' });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }));
      ttydWatcher.stop();
      assert.equal(runner.calls.length, 0);
      assert.match(log, /ttyd watcher DISABLED/);
    });

    it('start() logs an invalid threshold instead of silently using it', async () => {
      ttydWatcher._setRunner(ttydRunner());
      const log = await captureLog(() => asDarwin(async () => {
        ttydWatcher.start({ intervalMs: 60000 }, { TANGLECLAW_TTYD_ORPHAN_THRESHOLD: '1' });
        ttydWatcher.stop();
      }));
      assert.match(log, /outside the integer range/);
    });

    it('start() is idempotent, and stop() is idempotent', async () => {
      ttydWatcher._setRunner(ttydRunner());
      await asDarwin(async () => {
        ttydWatcher.start({ intervalMs: 60000 }, {});
        ttydWatcher.start({ intervalMs: 60000 }, {});
      });
      assert.doesNotThrow(() => {
        ttydWatcher.stop();
        ttydWatcher.stop();
      });
    });
  });
});
