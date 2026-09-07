'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const ttydWatcher = require('../lib/ttyd-watcher');

const LAUNCHCTL_OUTPUT_RUNNING = `{
\t"StandardOutPath" = "/dev/null";
\t"LimitLoadToSessionType" = "Aqua";
\t"StandardErrorPath" = "/dev/null";
\t"Label" = "com.tangleclaw.ttyd";
\t"OnDemand" = false;
\t"LastExitStatus" = 0;
\t"PID" = 12345;
\t"Program" = "/opt/homebrew/bin/ttyd";
};
`;

const LAUNCHCTL_OUTPUT_NOT_RUNNING = `{
\t"Label" = "com.tangleclaw.ttyd";
\t"OnDemand" = false;
\t"LastExitStatus" = 0;
};
`;

/**
 * Build a runner double that dispatches by (cmd, firstArg) and records calls.
 * @param {object} responses - keys like 'launchctl:list' → string|Error
 * @returns {Function & { calls: Array }}
 */
function makeRunner(responses) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const key = `${cmd}:${args[0] || ''}`;
    const r = responses[key];
    if (r instanceof Error) throw r;
    if (typeof r === 'string') return r;
    return '';
  };
  fn.calls = calls;
  return fn;
}

describe('ttyd-watcher', () => {
  beforeEach(() => {
    ttydWatcher._reset();
  });

  afterEach(() => {
    ttydWatcher._reset();
  });

  describe('_getTtydPid', () => {
    it('parses PID from launchctl list output', () => {
      ttydWatcher._setRunner(makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING
      }));
      assert.equal(ttydWatcher._getTtydPid('com.tangleclaw.ttyd'), 12345);
    });

    it('returns null when service is loaded but not running (no PID line)', () => {
      ttydWatcher._setRunner(makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_NOT_RUNNING
      }));
      assert.equal(ttydWatcher._getTtydPid('com.tangleclaw.ttyd'), null);
    });

    it('returns null when launchctl fails', () => {
      ttydWatcher._setRunner(makeRunner({
        'launchctl:list': new Error('not found')
      }));
      assert.equal(ttydWatcher._getTtydPid('com.tangleclaw.ttyd'), null);
    });
  });

  // ── #144: PTY-pool measurement (replaces pre-#144 _countTtydChildren proxy) ──
  describe('_isPtyPoolExhausted', () => {
    it('trips when used >= floor(cap * threshold)', () => {
      // cap=511, threshold=0.85 → floor(511 * 0.85) = 434. used=434 should trip.
      ttydWatcher._setRunner(makeRunner({
        'sysctl:-n': '511\n',
        'sh:-c': '434\n'
      }));
      const result = ttydWatcher._isPtyPoolExhausted(0.85);
      assert.equal(result.exhausted, true);
      assert.equal(result.used, 434);
      assert.equal(result.cap, 511);
      assert.ok(result.ratio > 0.84 && result.ratio < 0.86);
    });

    it('trips at the canonical #94 incident shape (used=527, cap=511 → ratio > 1)', () => {
      ttydWatcher._setRunner(makeRunner({
        'sysctl:-n': '511\n',
        'sh:-c': '527\n'
      }));
      const result = ttydWatcher._isPtyPoolExhausted(0.85);
      assert.equal(result.exhausted, true);
      assert.equal(result.used, 527);
    });

    it('does not trip when used < floor(cap * threshold)', () => {
      // cap=511, threshold=0.85 → floor=434. used=104 (post-kickstart state).
      ttydWatcher._setRunner(makeRunner({
        'sysctl:-n': '511\n',
        'sh:-c': '104\n'
      }));
      const result = ttydWatcher._isPtyPoolExhausted(0.85);
      assert.equal(result.exhausted, false);
      assert.equal(result.used, 104);
      assert.equal(result.cap, 511);
    });

    it('does NOT trip at floor(cap * threshold) - 1 (off-by-one boundary lock, Critic NIT 1)', () => {
      // cap=511, threshold=0.85 → floor=434. used=433 is one below floor and must NOT trip.
      // Pairs with the `trips when used >= floor(cap * threshold)` test above
      // (used=434) to lock the >= vs > predicate from drifting in either direction.
      ttydWatcher._setRunner(makeRunner({
        'sysctl:-n': '511\n',
        'sh:-c': '433\n'
      }));
      const result = ttydWatcher._isPtyPoolExhausted(0.85);
      assert.equal(result.exhausted, false);
    });

    it('returns fail-safe { exhausted: false } when sysctl reading is non-numeric (#144 fail-safe contract)', () => {
      ttydWatcher._setRunner(makeRunner({
        'sysctl:-n': 'not-a-number\n',
        'sh:-c': '500\n'
      }));
      const result = ttydWatcher._isPtyPoolExhausted(0.85);
      assert.equal(result.exhausted, false);
      assert.equal(result.cap, 0);
      assert.equal(result.used, 0);
    });

    it('returns fail-safe { exhausted: false } when sysctl throws (e.g. binary missing in obscure environments)', () => {
      ttydWatcher._setRunner(makeRunner({
        'sysctl:-n': new Error('sysctl: command not found'),
        'sh:-c': '500\n'
      }));
      const result = ttydWatcher._isPtyPoolExhausted(0.85);
      assert.equal(result.exhausted, false);
    });

    it('returns fail-safe when ls/wc pipeline throws', () => {
      ttydWatcher._setRunner(makeRunner({
        'sysctl:-n': '511\n',
        'sh:-c': new Error('sh: command not found')
      }));
      const result = ttydWatcher._isPtyPoolExhausted(0.85);
      assert.equal(result.exhausted, false);
    });

    it('returns fail-safe when cap <= 0', () => {
      ttydWatcher._setRunner(makeRunner({
        'sysctl:-n': '0\n',
        'sh:-c': '100\n'
      }));
      const result = ttydWatcher._isPtyPoolExhausted(0.85);
      assert.equal(result.exhausted, false);
    });

    it('uses DEFAULT_PTY_THRESHOLD when no threshold argument is passed', () => {
      // DEFAULT_PTY_THRESHOLD = 0.85; cap=100; used=86 → should trip
      ttydWatcher._setRunner(makeRunner({
        'sysctl:-n': '100\n',
        'sh:-c': '86\n'
      }));
      const result = ttydWatcher._isPtyPoolExhausted();
      assert.equal(result.exhausted, true);
    });
  });

  describe('_countTtydZombies', () => {
    it('counts only rows where ppid matches AND stat contains Z', () => {
      const psOutput = `
  12345 ?Es
  12345 ?S
  12345 ?Z
  12345 Z+
  99999 Z
  12345 ?R
`;
      ttydWatcher._setRunner(makeRunner({ 'ps:-A': psOutput }));
      // Expected: rows 3 (12345 ?Z) and 4 (12345 Z+) match. Others either lack Z
      // in the stat code or are parented by a different pid.
      const result = ttydWatcher._countTtydZombies(12345);
      assert.equal(result, 2);
    });

    it('returns 0 when no rows match the parent pid', () => {
      const psOutput = `
  99999 Z
  88888 ?Z
`;
      ttydWatcher._setRunner(makeRunner({ 'ps:-A': psOutput }));
      assert.equal(ttydWatcher._countTtydZombies(12345), 0);
    });

    it('returns 0 when all matching rows are live (no Z in stat)', () => {
      const psOutput = `
  12345 ?S
  12345 ?R
  12345 ?Sl
`;
      ttydWatcher._setRunner(makeRunner({ 'ps:-A': psOutput }));
      assert.equal(ttydWatcher._countTtydZombies(12345), 0);
    });

    it('returns 0 on ps error (fail-safe — diagnostic only, never crashes _check)', () => {
      ttydWatcher._setRunner(makeRunner({
        'ps:-A': new Error('ps: command not found')
      }));
      assert.equal(ttydWatcher._countTtydZombies(12345), 0);
    });

    it('handles empty ps output gracefully', () => {
      ttydWatcher._setRunner(makeRunner({ 'ps:-A': '' }));
      assert.equal(ttydWatcher._countTtydZombies(12345), 0);
    });

    it('skips malformed ps rows without throwing', () => {
      const psOutput = `
garbage line with no ppid
  12345 ?Z
not numeric  ?Z
  12345 Z+
`;
      ttydWatcher._setRunner(makeRunner({ 'ps:-A': psOutput }));
      assert.equal(ttydWatcher._countTtydZombies(12345), 2);
    });
  });

  // ── #380: orphan (leaked-child) count — the signal the #144 pool gate missed ──
  describe('_countTtydOrphans', () => {
    it('counts children stuck exiting (E) OR zombied (Z), ignoring live (S/R) children', () => {
      // The #380 incident shape: many `?Es` children (exiting-wedged) holding
      // PTY slots, a couple zombies, and some healthy attached clients.
      const psOutput = `
  12345 ?Es
  12345 ?Es
  12345 ?Z
  12345 Z+
  12345 ?S
  12345 ?R
  99999 ?Es
`;
      ttydWatcher._setRunner(makeRunner({ 'ps:-A': psOutput }));
      // 2×E + 1×?Z + 1×Z+ = 4 for pid 12345; the ?S/?R are healthy, the 99999
      // row belongs to a different parent.
      assert.equal(ttydWatcher._countTtydOrphans(12345), 4);
    });

    it('returns 0 when all matching children are healthy (S/R)', () => {
      const psOutput = `
  12345 ?S
  12345 ?R
  12345 ?Sl
`;
      ttydWatcher._setRunner(makeRunner({ 'ps:-A': psOutput }));
      assert.equal(ttydWatcher._countTtydOrphans(12345), 0);
    });

    it('returns 0 on ps error (fail-safe — never kickstarts on a failed measurement)', () => {
      ttydWatcher._setRunner(makeRunner({ 'ps:-A': new Error('ps: command not found') }));
      assert.equal(ttydWatcher._countTtydOrphans(12345), 0);
    });

    it('skips malformed rows without throwing', () => {
      const psOutput = `
garbage line
  12345 ?Es
not numeric ?Es
  12345 Z+
`;
      ttydWatcher._setRunner(makeRunner({ 'ps:-A': psOutput }));
      assert.equal(ttydWatcher._countTtydOrphans(12345), 2);
    });
  });

  describe('_kickstartTtyd', () => {
    it('returns true on success and invokes launchctl kickstart', () => {
      const runner = makeRunner({
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      const ok = ttydWatcher._kickstartTtyd('com.tangleclaw.ttyd');
      assert.equal(ok, true);
      const call = runner.calls.find((c) => c.cmd === 'launchctl');
      assert.ok(call);
      assert.equal(call.args[0], 'kickstart');
      assert.equal(call.args[1], '-k');
      assert.match(call.args[2], /^gui\/\d+\/com\.tangleclaw\.ttyd$/);
    });

    it('returns false when launchctl fails', () => {
      ttydWatcher._setRunner(makeRunner({
        'launchctl:kickstart': new Error('permission denied')
      }));
      assert.equal(ttydWatcher._kickstartTtyd('com.tangleclaw.ttyd'), false);
    });

    it('returns false without invoking launchctl when uid is unsafe (root or unknown)', () => {
      const originalGetuid = process.getuid;
      const runner = makeRunner({});
      ttydWatcher._setRunner(runner);
      try {
        process.getuid = () => 0;
        assert.equal(ttydWatcher._kickstartTtyd('com.tangleclaw.ttyd'), false);
        assert.equal(runner.calls.length, 0);
      } finally {
        process.getuid = originalGetuid;
      }
    });
  });

  // #1245 — the orphan gate could fire on damage a RESTART caused. A restart
  // blanks every open terminal iframe at once, they all reconnect together, and
  // connect/disconnect churn is what leaks: on 2026-09-07 a FRESH ttyd reached
  // 22 wedged children within five minutes of being kickstarted, and the gate
  // fired again on the very next poll. Each round blanks the operator's
  // terminals, so the thrash is the user-visible half of this bug.
  //
  // The hold is derived from ttyd's OWN uptime, never from this module's
  // bookkeeping, so it covers the operator's manual `launchctl kickstart` (the
  // remedy the health panel hands them) and a launchd respawn exactly as it
  // covers ours — and it survives a server restart, because the fact lives in
  // the OS.
  describe('_check — the orphan gate waits for ttyd to be old enough (#1245)', () => {
    const ORPHANS_OVER = '  12345 ?Es\n'.repeat(25);

    /**
     * A runner whose pool reading is healthy and whose orphan count is over the
     * gate — the #1245 shape, never the #94 one.
     * @param {string} etime - what `ps -o etime=` reports for ttyd
     * @returns {Function & {calls: Array}}
     */
    function leakyRunner(etime) {
      return makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '54\n', // ratio 0.106 — nowhere near the 0.85 pool gate
        'ps:-A': ORPHANS_OVER,
        'ps:-o': `${etime}\n`,
        'launchctl:kickstart': ''
      });
    }

    /** Count kickstart invocations in a runner's call log. @returns {number} */
    const kicks = (runner) => runner.calls.filter(
      (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
    ).length;

    const CHECK = { ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 };

    it('fires when ttyd has been up longer than the minimum age', () => {
      const runner = leakyRunner('02:58:17');
      ttydWatcher._setRunner(runner);
      const r = ttydWatcher._check(CHECK);
      assert.equal(r.action, 'kickstart');
      assert.equal(kicks(runner), 1);
    });

    it('holds down on a ttyd restarted five minutes ago — the 01:09 to 01:14 shape', () => {
      const runner = leakyRunner('05:00');
      ttydWatcher._setRunner(runner);
      const r = ttydWatcher._check(CHECK);
      assert.equal(r.action, 'suppressed');
      assert.equal(r.orphans, 25, 'it still MEASURED the leak — it declined to act on it');
      assert.equal(r.ttydUptimeMs, 5 * 60 * 1000);
      assert.equal(kicks(runner), 0, 'the terminals do not blank a second time');
    });

    // THE POINT OF KEYING ON UPTIME. `lib/system-health.js` hands the operator
    // `launchctl kickstart -k …` as the panel's remedy and the user guide tells
    // them to run it. That restart makes the identical reconnect burst. Keyed to
    // our own bookkeeping the gate would fire on it next tick; keyed to ttyd's
    // age it cannot, because a manually restarted ttyd is just as young.
    it('covers a restart this process did not perform', () => {
      // No kickstart has EVER been fired through this module — the state is
      // fresh — and the gate still holds, purely because ttyd is young.
      const runner = leakyRunner('00:30');
      ttydWatcher._setRunner(runner);
      assert.equal(ttydWatcher._check(CHECK).action, 'suppressed');
      assert.equal(kicks(runner), 0);
    });

    it('fires the moment ttyd passes the minimum age, and not before', () => {
      const under = leakyRunner('14:59');
      ttydWatcher._setRunner(under);
      assert.equal(ttydWatcher._check(CHECK).action, 'suppressed', 'one second short still holds');

      const over = leakyRunner('15:00');
      ttydWatcher._setRunner(over);
      assert.equal(ttydWatcher._check(CHECK).action, 'kickstart',
        'the hold bounds the thrash, it does not disable the gate');
      assert.equal(kicks(over), 1);
    });

    // THE ASYMMETRY, and the reason this change is safe. Pool exhaustion is the
    // #94 incident — every attach fails and the box is unusable. Observed pool
    // ratios during the #1245 thrash were 0.084–0.115 against a 0.85 gate, so
    // the pool gate has never fired here and must keep its ability to fire on
    // ANY tick. Binding it too would trade a papercut for the incident the
    // watcher exists to prevent.
    it('the POOL gate still fires on a freshly restarted ttyd', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '527\n', // the canonical #94 overflow
        'ps:-A': ORPHANS_OVER,
        'ps:-o': '00:30\n',
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      const r = ttydWatcher._check(CHECK);
      assert.equal(r.action, 'kickstart', 'pool exhaustion is never suppressed');
      assert.equal(kicks(runner), 1);
    });

    // A failed kickstart must not arm anything. Keyed to uptime it cannot: if
    // launchctl refused, ttyd's age is unchanged and old, so the next tick
    // retries on schedule instead of sitting the hold out after doing
    // nothing at all.
    it('a REFUSED kickstart leaves the gate armed for the next tick', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '54\n',
        'ps:-A': ORPHANS_OVER,
        'ps:-o': '02:58:17\n',
        'launchctl:kickstart': new Error('permission denied')
      });
      ttydWatcher._setRunner(runner);
      const first = ttydWatcher._check(CHECK);
      assert.equal(first.action, 'kickstart-failed', 'the refusal is reported, not swallowed');

      // ttyd is still the same old process, so the gate fires again.
      const second = ttydWatcher._check(CHECK);
      assert.equal(second.action, 'kickstart-failed');
      assert.equal(kicks(runner), 2, 'it retried rather than holding itself down for 15 minutes');
    });

    it('an unreadable uptime does not suppress — a failed measurement is no reason to sit on a leak', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '54\n',
        'ps:-A': ORPHANS_OVER,
        'ps:-o': new Error('ps: no such process'),
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      const r = ttydWatcher._check(CHECK);
      assert.equal(r.action, 'kickstart');
      assert.equal(r.ttydUptimeMs, null);
    });

    it('the minimum age is three poll intervals, computed rather than restated', () => {
      assert.equal(ttydWatcher.DEFAULT_MIN_TTYD_AGE_MS,
        3 * ttydWatcher.DEFAULT_INTERVAL_MS);
    });
  });

  // The SHIPPED surface. Everything above measures `_check`'s return value,
  // which is a test-only seam — no production caller reads it. What an operator
  // actually gets when the gate holds down is a log line, so that is what has to
  // be pinned: a suppression that logged nothing would pass every assertion
  // above while leaving them unable to explain why terminals stopped blanking.
  describe('_check — the suppression is legible in the log (#1245)', () => {
    it('says it held down, and how long is left', () => {
      const lines = [];
      setLevel('warn');
      setConsoleStream({ write: (text) => lines.push(text) });
      try {
        ttydWatcher._setRunner(makeRunner({
          'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
          'sysctl:-n': '511\n',
          'sh:-c': '54\n',
          'ps:-A': '  12345 ?Es\n'.repeat(25),
          'ps:-o': '05:00\n',
          'launchctl:kickstart': ''
        }));
        ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 });
      } finally {
        setConsoleStream(null);
        setLevel('error');
      }
      const held = lines.join('');
      assert.match(held, /orphan gate held down/, 'the decision is on the record, not swallowed');
      assert.match(held, /ttydUptimeMs=300000/, 'with how young ttyd is');
      assert.match(held, /remainingMs=600000/, 'and how long is left, not just the elapsed');
      assert.match(held, /orphans=25/, 'and the leak it declined to act on');
      assert.ok(!/leak detected, kickstarting/.test(held),
        `a suppressed tick must not also claim it kickstarted: ${held}`);
    });
  });

  describe('_parseEtime — macOS ps has no `etimes` keyword (#1245)', () => {
    it('parses every documented shape of [[dd-]hh:]mm:ss', () => {
      assert.equal(ttydWatcher._parseEtime('05:00'), 5 * 60 * 1000);
      assert.equal(ttydWatcher._parseEtime('02:58:17'), ((2 * 3600) + (58 * 60) + 17) * 1000);
      assert.equal(ttydWatcher._parseEtime('3-02:58:17'),
        ((3 * 86400) + (2 * 3600) + (58 * 60) + 17) * 1000);
      assert.equal(ttydWatcher._parseEtime('  00:07\n'), 7000, 'ps pads and newline-terminates');
    });

    it('returns null rather than a plausible number for anything it does not recognise', () => {
      // A wrong number here would silently suppress a real leak, so an
      // unrecognised shape must be an ANSWER THIS DID NOT GET, not a zero.
      for (const bad of ['', '   ', 'not-a-time', '17', '1:2:3:4', '-']) {
        assert.equal(ttydWatcher._parseEtime(bad), null, `should reject: ${JSON.stringify(bad)}`);
      }
    });
  });

  describe('_check', () => {
    it('kickstarts when PTY pool is exhausted past the threshold ratio', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '527\n', // canonical #94 incident shape (overflow)
        'ps:-A': '  12345 ?Z\n  12345 Z+\n',
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 });
      const kickstartCall = runner.calls.find(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.ok(kickstartCall, 'kickstart was not invoked');
      assert.equal(kickstartCall.args[1], '-k');
      assert.match(kickstartCall.args[2], /^gui\/\d+\/com\.tangleclaw\.ttyd$/);
    });

    it('does not kickstart when PTY pool is below threshold (post-kickstart steady state)', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '104\n', // post-kickstart used count from #94 incident report
        'ps:-A': ''
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, false);
    });

    it('skips measurement when ttyd PID is unavailable', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_NOT_RUNNING
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 });
      const sysctlCalled = runner.calls.some((c) => c.cmd === 'sysctl');
      const lsCalled = runner.calls.some((c) => c.cmd === 'sh');
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(sysctlCalled, false, 'sysctl should not be called when PID is unavailable');
      assert.equal(lsCalled, false, 'ls/wc should not be called when PID is unavailable');
      assert.equal(kickstarted, false);
    });

    it('does not kickstart on fail-safe { exhausted: false } from a non-numeric reading', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': 'corrupted-binary-output',
        'sh:-c': '999\n'
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, false);
    });

    it('does not call sysctl twice when measurement returns fail-safe (Critic MINOR 1 — measurement-failed branch short-circuits)', () => {
      // When `cap === 0` (fail-safe sentinel from `_isPtyPoolExhausted`), `_check`
      // emits a `warn` and returns rather than falling through to the ok-branch
      // debug log. We can't easily assert log content from here without a logger
      // stub, but we CAN positively assert the function returned without
      // attempting a kickstart by checking the calls log. Also assert no
      // exception escapes the catch.
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': new Error('sysctl: command not found'),
        'sh:-c': '500\n',
        'ps:-A': ''
      });
      ttydWatcher._setRunner(runner);
      assert.doesNotThrow(() => {
        ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 });
      });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, false);
    });

    it('does not throw when runner errors mid-check (fail-open loop contract)', () => {
      ttydWatcher._setRunner(() => {
        throw new Error('boom');
      });
      assert.doesNotThrow(() => {
        ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 });
      });
    });

    it('still kickstarts even when zombie count is 0 (pool-only gate — issue #144 design call)', () => {
      // Documents the explicit policy: pool exhaustion alone triggers a kickstart,
      // independent of zombie population. If false positives ever bite, file as
      // a #144 follow-up — easier to add a gate than remove one.
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '100\n',
        'sh:-c': '100\n', // 100/100 → exhausted
        'ps:-A': '', // zero zombies
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, true);
    });

    it('kickstarts on orphan accumulation even when the PTY pool is well below threshold (#380 regression)', () => {
      // The exact #380 miss: pool ratio 230/511 = 0.45 (far below 0.85, so the
      // #144 gate stays silent) while ttyd holds 25 wedged `E`-state children.
      // The orphan gate must fire the kickstart the pool gate would not.
      const orphanRows = Array.from({ length: 25 }, () => '  12345 ?Es').join('\n');
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '230\n', // ratio 0.45 — pool gate would NOT trip
        'ps:-A': orphanRows,
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85, orphanThreshold: 20 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, true, 'orphan gate must kickstart when pool ratio alone would not');
    });

    it('does NOT kickstart when orphans are below threshold and the pool is healthy', () => {
      const orphanRows = Array.from({ length: 5 }, () => '  12345 ?Es').join('\n');
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '104\n', // healthy pool
        'ps:-A': orphanRows, // 5 orphans < 20 threshold
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85, orphanThreshold: 20 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, false);
    });

    it('orphan gate fires even when the pool MEASUREMENT fails (cap=0) — gates are independent', () => {
      // A broken sysctl reading must not suppress an orphan-driven kickstart:
      // the `cap===0 && !orphanGate` short-circuit only bails when BOTH the pool
      // reading is broken AND orphans are below threshold.
      const orphanRows = Array.from({ length: 30 }, () => '  12345 ?Es').join('\n');
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': new Error('sysctl: command not found'), // pool measurement broken
        'sh:-c': '500\n',
        'ps:-A': orphanRows,
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85, orphanThreshold: 20 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, true, 'a broken pool reading must not suppress the orphan gate');
    });

    it('honors a custom orphanThreshold', () => {
      const orphanRows = Array.from({ length: 10 }, () => '  12345 ?Es').join('\n');
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '104\n',
        'ps:-A': orphanRows, // 10 orphans
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      // threshold 8 → 10 orphans trips it
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85, orphanThreshold: 8 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, true);
    });

    it('defaults orphanThreshold to DEFAULT_ORPHAN_THRESHOLD when omitted', () => {
      // No orphanThreshold passed; DEFAULT is 20. 25 orphans must trip it.
      const orphanRows = Array.from({ length: 25 }, () => '  12345 ?Es').join('\n');
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'sysctl:-n': '511\n',
        'sh:-c': '104\n', // healthy pool — only the orphan gate can fire
        'ps:-A': orphanRows,
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', ptyThresholdRatio: 0.85 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, true);
      assert.equal(ttydWatcher.DEFAULT_ORPHAN_THRESHOLD, 20);
    });
  });

  // ── #144: Production-runner smoke test ──
  // Closes the "Test gap to close" item from issue #144. Pre-#144 the entire
  // watcher implementation was stubbed by _setRunner, so the production-runner
  // path against real BSD pgrep / sysctl had never been exercised. This test
  // is gated on darwin so non-mac CI passes.
  describe('production runner smoke test (darwin only)', () => {
    it('_isPtyPoolExhausted returns finite values when run against the real host shell', { skip: process.platform !== 'darwin' }, () => {
      // No _setRunner — exercises the production code path.
      const result = ttydWatcher._isPtyPoolExhausted(0.85);
      assert.ok(Number.isFinite(result.cap), `cap should be finite, got ${result.cap}`);
      assert.ok(result.cap > 0, `cap should be > 0 on a running mac, got ${result.cap}`);
      assert.ok(Number.isFinite(result.used), `used should be finite, got ${result.used}`);
      assert.ok(result.used >= 0, `used should be >= 0, got ${result.used}`);
      assert.ok(Number.isFinite(result.ratio), `ratio should be finite, got ${result.ratio}`);
      assert.equal(typeof result.exhausted, 'boolean');
    });

    it('_countTtydZombies returns a finite non-negative count against the real host shell', { skip: process.platform !== 'darwin' }, () => {
      // Use PID 1 (launchd) — guaranteed to exist on every macOS install. We
      // don't assert a specific count (the host's process tree varies); just
      // that the function returns a sane number without throwing.
      const result = ttydWatcher._countTtydZombies(1);
      assert.ok(Number.isFinite(result), `result should be finite, got ${result}`);
      assert.ok(result >= 0, `result should be >= 0, got ${result}`);
    });
  });

  describe('lifecycle', () => {
    it('start() is a no-op on non-darwin platforms — no timer scheduled, no runner calls', () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      const originalSetInterval = global.setInterval;
      let setIntervalCalled = false;
      const runner = makeRunner({});
      ttydWatcher._setRunner(runner);
      try {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        global.setInterval = (...args) => {
          setIntervalCalled = true;
          return originalSetInterval.apply(global, args);
        };
        ttydWatcher.start({ intervalMs: 60000 });
        assert.equal(setIntervalCalled, false, 'setInterval should not be scheduled on non-darwin');
        assert.equal(runner.calls.length, 0, 'no runner invocations on non-darwin');
      } finally {
        global.setInterval = originalSetInterval;
        Object.defineProperty(process, 'platform', originalPlatform);
        ttydWatcher.stop();
      }
    });

    it('start() is idempotent', () => {
      if (process.platform !== 'darwin') {
        // start() no-ops on non-darwin; covered separately
        return;
      }
      ttydWatcher._setRunner(makeRunner({}));
      ttydWatcher.start({ intervalMs: 60000 });
      ttydWatcher.start({ intervalMs: 60000 });
      assert.doesNotThrow(() => ttydWatcher.stop());
    });

    it('stop() is idempotent', () => {
      assert.doesNotThrow(() => {
        ttydWatcher.stop();
        ttydWatcher.stop();
      });
    });
  });
});

describe('ttyd-watcher measureLeak (#345 — a reading the health panel can trust)', () => {
  const PS_HEALTHY = '    1 Ss\n12345 S\n12345 S\n12345 R\n';
  const PS_LEAKING = '    1 Ss\n' + '12345 ?Es\n'.repeat(25) + '12345 S\n';

  beforeEach(() => ttydWatcher._reset());
  afterEach(() => ttydWatcher._reset());

  it('reports pid null and measures nothing when the job is not running', async () => {
    const runner = makeRunner({ 'launchctl:list': LAUNCHCTL_OUTPUT_NOT_RUNNING });
    ttydWatcher._setRunner(runner);
    const m = (await ttydWatcher.measureLeak());
    assert.equal(m.pid, null);
    assert.equal(m.pool, null);
    assert.equal(m.orphans, null);
    assert.equal(runner.calls.length, 1, 'no sysctl/ps for a job that has no pid');
  });

  it('returns both gates read when everything answers', async () => {
    ttydWatcher._setRunner(makeRunner({
      'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
      'sysctl:-n': '511\n',
      'sh:-c': '40\n',
      'ps:-A': PS_HEALTHY
    }));
    const m = (await ttydWatcher.measureLeak());
    assert.equal(m.pid, 12345);
    assert.deepEqual({ used: m.pool.used, cap: m.pool.cap, exhausted: m.pool.exhausted }, { used: 40, cap: 511, exhausted: false });
    assert.equal(m.orphans, 0);
    assert.equal(m.orphanThreshold, ttydWatcher.DEFAULT_ORPHAN_THRESHOLD);
    assert.equal(m.ptyThresholdRatio, ttydWatcher.DEFAULT_PTY_THRESHOLD);
  });

  it('counts leaked E/Z children as orphans', async () => {
    ttydWatcher._setRunner(makeRunner({
      'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
      'sysctl:-n': '511\n',
      'sh:-c': '40\n',
      'ps:-A': PS_LEAKING
    }));
    assert.equal((await ttydWatcher.measureLeak()).orphans, 25);
  });

  it('returns pool null — not the fail-safe zero — when the pool reading broke', async () => {
    // THE MUTATION THIS CATCHES: passing `_isPtyPoolExhausted`'s sentinel through,
    // which reads as "0 of 0 used, not exhausted" — a clear the machine never said.
    ttydWatcher._setRunner(makeRunner({
      'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
      'sysctl:-n': new Error('sysctl: unknown oid'),
      'ps:-A': PS_HEALTHY
    }));
    const m = (await ttydWatcher.measureLeak());
    assert.equal(m.pool, null);
    assert.equal(m.orphans, 0, 'the other gate is still read');
  });

  it('returns orphans null — not zero — when ps failed', async () => {
    ttydWatcher._setRunner(makeRunner({
      'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
      'sysctl:-n': '511\n',
      'sh:-c': '40\n',
      'ps:-A': new Error('ps: command not found')
    }));
    const m = (await ttydWatcher.measureLeak());
    assert.equal(m.orphans, null);
    assert.equal(m.pool.cap, 511, 'the other gate is still read');
  });

  it('runs through an injected async runner when one is set', async () => {
    const seen = [];
    ttydWatcher._setAsyncRunner(async (cmd, args) => {
      seen.push(`${cmd}:${args[0]}`);
      if (cmd === 'launchctl') return LAUNCHCTL_OUTPUT_RUNNING;
      if (cmd === 'sysctl') return '511\n';
      if (cmd === 'sh') return '40\n';
      // TWO ps reads, and they ask different questions: the child population,
      // and ttyd's own age (#1245).
      if (cmd === 'ps' && args[0] === '-A') return PS_HEALTHY;
      if (cmd === 'ps' && args[0] === '-o') return '02:58:17\n';
      throw new Error('unexpected ' + cmd + ' ' + args.join(' '));
    });
    const m = await ttydWatcher.measureLeak();
    assert.equal(m.pid, 12345);
    assert.equal(m.pool.used, 40);
    assert.equal(m.uptimeMs, ((2 * 3600) + (58 * 60) + 17) * 1000,
      'the panel gets ttyd\'s age, so it can say when a leak count may be a restart burst');
    assert.deepEqual([...seen].sort(),
      ['launchctl:list', 'ps:-A', 'ps:-o', 'sh:-c', 'sysctl:-n'],
      'measured through the async runner');
  });
});
