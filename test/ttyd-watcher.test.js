'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

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

  describe('_countTtydChildren', () => {
    it('parses integer count from pgrep output', () => {
      ttydWatcher._setRunner(makeRunner({
        'pgrep:-c': '7\n'
      }));
      assert.equal(ttydWatcher._countTtydChildren(12345), 7);
    });

    it('returns 0 when pgrep exits 1 (no matches)', () => {
      const noMatch = new Error('pgrep no match');
      noMatch.status = 1;
      ttydWatcher._setRunner(makeRunner({
        'pgrep:-c': noMatch
      }));
      assert.equal(ttydWatcher._countTtydChildren(12345), 0);
    });

    it('returns 0 and logs on unexpected pgrep error', () => {
      const fatal = new Error('pgrep crashed');
      fatal.status = 2;
      ttydWatcher._setRunner(makeRunner({
        'pgrep:-c': fatal
      }));
      assert.equal(ttydWatcher._countTtydChildren(12345), 0);
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

  describe('_check', () => {
    it('kickstarts when child count meets threshold and targets the right gui domain', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'pgrep:-c': '50\n',
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', threshold: 50 });
      const kickstartCall = runner.calls.find(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.ok(kickstartCall, 'kickstart was not invoked');
      assert.equal(kickstartCall.args[1], '-k');
      assert.match(kickstartCall.args[2], /^gui\/\d+\/com\.tangleclaw\.ttyd$/);
    });

    it('kickstarts when child count exceeds threshold', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'pgrep:-c': '480\n',
        'launchctl:kickstart': ''
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', threshold: 50 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, true);
    });

    it('does not kickstart when child count is below threshold', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_RUNNING,
        'pgrep:-c': '3\n'
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', threshold: 50 });
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(kickstarted, false);
    });

    it('skips when ttyd PID is unavailable', () => {
      const runner = makeRunner({
        'launchctl:list': LAUNCHCTL_OUTPUT_NOT_RUNNING
      });
      ttydWatcher._setRunner(runner);
      ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', threshold: 50 });
      const pgrepCalled = runner.calls.some((c) => c.cmd === 'pgrep');
      const kickstarted = runner.calls.some(
        (c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart'
      );
      assert.equal(pgrepCalled, false);
      assert.equal(kickstarted, false);
    });

    it('does not throw when runner errors mid-check', () => {
      ttydWatcher._setRunner(() => {
        throw new Error('boom');
      });
      assert.doesNotThrow(() => {
        ttydWatcher._check({ ttydLabel: 'com.tangleclaw.ttyd', threshold: 50 });
      });
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
