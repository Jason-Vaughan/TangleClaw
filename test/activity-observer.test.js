'use strict';

/*
 * #1912, ADR 0020 §5: the bounded background activity observer. The tests
 * drive it with a fake clock and fake captures, so the budget, the round-robin
 * and the freshness contract are asserted exactly rather than timed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const observerMod = require('../lib/activity-observer');
const { createObserver, ACTIVITY, TICK_BUDGET_MS, FRESH_MS, captureAsync } = observerMod;

/**
 * A fake clock and harness.
 * @param {object} opts - Sessions, per-capture cost, verdict function
 * @returns {{obs: object, clock: {t: number}, captured: string[]}}
 */
function harness({ sessions, captureMs = 100, verdict, profile = { busyMarker: 'esc to interrupt' }, capture } = {}) {
  const clock = { t: 1_000_000 };
  const captured = [];
  const obs = createObserver({
    listSessions: () => sessions,
    profileFor: () => profile,
    now: () => clock.t,
    capture: capture || (async (name) => {
      captured.push(name);
      clock.t += captureMs;
      return { lines: [name], cursor: null };
    }),
    assess: verdict || (() => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 2 }))
  });
  return { obs, clock, captured };
}

const S = (id) => ({ id, engineId: 'claude', tmuxSession: `s${id}`, sessionMode: 'tmux' });

describe('activity observer budget and round-robin (ADR 0020 §5)', () => {
  it('stops starting captures once the tick budget is spent, and resumes there next tick', async () => {
    const sessions = [S(1), S(2), S(3), S(4), S(5)];
    const { obs, captured } = harness({ sessions, captureMs: 1500 });
    const first = await obs.tick();
    assert.deepEqual(first.observed, [1, 2], 'two 1.5 s captures spend the 3 s budget');
    assert.deepEqual(first.skipped, [3, 4, 5]);
    const second = await obs.tick();
    assert.deepEqual(second.observed, [3, 4], 'the next tick starts where the last stopped');
    const third = await obs.tick();
    assert.deepEqual(third.observed, [5, 1]);
    assert.deepEqual(captured, ['s1', 's2', 's3', 's4', 's5', 's1']);
  });

  it('never starts a capture after the budget, even one that would be quick', async () => {
    const sessions = [S(1), S(2)];
    const { obs } = harness({ sessions, captureMs: TICK_BUDGET_MS });
    const r = await obs.tick();
    assert.deepEqual(r.observed, [1]);
    assert.deepEqual(r.skipped, [2]);
  });

  it('observes every session within ceil(n / per-tick) ticks: no session starves', async () => {
    const sessions = Array.from({ length: 9 }, (_, i) => S(i + 1));
    const { obs } = harness({ sessions, captureMs: 1000 });
    const seen = new Set();
    for (let k = 0; k < 3; k++) (await obs.tick()).observed.forEach((id) => seen.add(id));
    assert.equal(seen.size, 9, 'with 3 captures per tick, 3 ticks reach all 9');
  });

  it('forgets a session that is no longer live', async () => {
    const sessions = [S(1), S(2)];
    const { obs } = harness({ sessions });
    await obs.tick();
    assert.equal(obs.get(2).activity, ACTIVITY.AT_REST);
    sessions.pop();
    await obs.tick();
    assert.equal(obs.get(2).reason, 'not-observed');
  });
});

describe('activity observer freshness and failure (ADR 0020 §5)', () => {
  it('a never-observed session is unknown', () => {
    const { obs } = harness({ sessions: [] });
    assert.deepEqual(obs.get(42), {
      activity: 'unknown', reason: 'not-observed', observedAt: null, ageSeconds: null, provenance: 'engine-observed'
    });
  });

  it('an observation older than 30 s reads as unknown, and reports its age', async () => {
    const { obs, clock } = harness({ sessions: [S(1)] });
    await obs.tick();
    assert.equal(obs.get(1).activity, ACTIVITY.AT_REST);
    clock.t += FRESH_MS;
    assert.equal(obs.get(1).activity, ACTIVITY.AT_REST, 'exactly 30 s is still fresh');
    clock.t += 1;
    const stale = obs.get(1);
    assert.equal(stale.activity, ACTIVITY.UNKNOWN);
    assert.equal(stale.reason, 'stale-observation');
    assert.equal(stale.ageSeconds, 30);
    assert.equal(stale.provenance, 'engine-observed');
  });

  it('an engine with no wake profile is unknown, and its pane is never captured', async () => {
    const { obs, captured } = harness({ sessions: [S(1)], profile: null });
    await obs.tick();
    assert.equal(obs.get(1).activity, ACTIVITY.UNKNOWN);
    assert.equal(obs.get(1).reason, 'no-wake-profile');
    assert.deepEqual(captured, []);
  });

  it('a session that is not a tmux pane is unknown and never captured', async () => {
    const { obs, captured } = harness({ sessions: [{ ...S(1), sessionMode: 'webui' }] });
    await obs.tick();
    assert.equal(obs.get(1).reason, 'not-a-tmux-pane');
    assert.deepEqual(captured, []);
  });

  it('a capture that times out or fails is unknown, never a guess', async () => {
    const timeout = harness({
      sessions: [S(1)],
      capture: async () => { throw Object.assign(new Error('slow'), { tcTimedOut: true }); }
    });
    await timeout.obs.tick();
    assert.equal(timeout.obs.get(1).activity, ACTIVITY.UNKNOWN);
    assert.equal(timeout.obs.get(1).reason, 'capture-timeout');

    const failed = harness({ sessions: [S(1)], capture: async () => { throw new Error('gone'); } });
    await failed.obs.tick();
    assert.equal(failed.obs.get(1).reason, 'capture-failed');
  });
});

describe('activity observer classification: the strict at-rest gate (ADR 0020 §5)', () => {
  const classify = async (verdict) => {
    const { obs } = harness({ sessions: [S(1)], verdict: () => verdict });
    await obs.tick();
    return obs.get(1).activity;
  };

  it('a turn in flight, running agents, a missing at-rest marker or a moving pane is busy', async () => {
    for (const reason of ['turn-in-flight', 'agents-running', 'not-at-rest', 'pane-writing']) {
      assert.equal(await classify({ idle: false, reason, digest: 'd', idleTicks: 0 }), ACTIVITY.BUSY, reason);
    }
  });

  it('a filled composer, a dialog or a first unconfirmed observation is not-at-rest, never at-rest', async () => {
    for (const reason of ['composer-has-input', 'no-prompt', 'at-prompt']) {
      assert.equal(await classify({ idle: false, reason, digest: 'd', idleTicks: 1 }), ACTIVITY.NOT_AT_REST, reason);
    }
  });

  it('asks the wake assessment for the strictest form: typeable, two stable observations', async () => {
    let asked;
    const { obs } = harness({ sessions: [S(1)], verdict: (o) => { asked = o; return { idle: false, reason: 'at-prompt', digest: 'x', idleTicks: 1 }; } });
    await obs.tick();
    assert.equal(asked.mustBeTypeable, true);
    assert.equal(asked.ticksRequired, 2);
    assert.equal(asked.prevDigest, undefined, 'the first observation has no previous digest');
    await obs.tick();
    assert.equal(asked.prevDigest, 'x', 'the second carries the first digest forward');
    assert.equal(asked.idleTicks, 1);
  });

  it('through the real wake assessment: a busy marker is busy, and one resting observation is not yet at rest', async () => {
    const os = require('node:os');
    const store = require('../lib/store');
    const medusaWake = require('../lib/medusa-wake');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-observer-profile-'));
    store._setBasePath(tmp);
    store.init();
    const profile = medusaWake.ENGINE_WAKE_PROFILES.claude;
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.ok(profile && profile.busyMarker, 'the claude engine has a wake profile');
    const run = async (lines, ticks) => {
      const { obs } = harness({
        sessions: [S(1)], profile,
        capture: async () => ({ lines, cursor: null }),
        verdict: (o) => medusaWake.assessSessionIdle(o)
      });
      for (let k = 0; k < ticks; k++) await obs.tick();
      return obs.get(1).activity;
    };
    assert.equal(await run(['working...', `✻ Thinking… (${profile.busyMarker})`, '>'], 1), ACTIVITY.BUSY);
    assert.notEqual(await run(['done.', '>'], 1), ACTIVITY.AT_REST, 'one observation never establishes rest');
  });
});

describe('activity observer scope (ADR 0020 §5, §8)', () => {
  // Code only: the module's comments explain what it deliberately does NOT do,
  // and naming those things there is not doing them.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'activity-observer.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('reads no mail and no inbox state: it observes independently of the switchboard', () => {
    assert.doesNotMatch(src, /medusa\/messages|inbox|unread|listOpenForRecipient|medusaExchanges/);
  });

  it('never derives workload or clearance from pane text', () => {
    assert.doesNotMatch(src, /SAFE TO CLEAR|DO NOT CLEAR|safe-to-clear|do-not-clear|clearance/);
  });

  it('uses no synchronous child process', () => {
    assert.doesNotMatch(src, /execSync|execFileSync|spawnSync/);
  });
});

describe('captureAsync against a real tmux pane', () => {
  let hasTmux = true;
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { hasTmux = false; }

  it('captures a live pane asynchronously and refuses a missing one', { skip: hasTmux ? false : 'tmux not installed' }, async () => {
    const name = `tc-observer-test-${process.pid}`;
    execFileSync('tmux', ['new-session', '-d', '-s', name, '-x', '80', '-y', '10', 'sh -c "echo observer-probe; sleep 30"']);
    try {
      let cap;
      for (let k = 0; k < 20; k++) {
        cap = await captureAsync(name, 1000);
        if (cap.lines.join('\n').includes('observer-probe')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(cap.lines.join('\n').includes('observer-probe'));
      assert.ok(cap.cursor === null || Number.isInteger(cap.cursor.y));
      await assert.rejects(captureAsync(`${name}-missing`, 1000));
    } finally {
      execFileSync('tmux', ['kill-session', '-t', `=${name}`]);
    }
  });
});
