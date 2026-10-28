'use strict';

/*
 * #227 — the dashboard says when the local clone is behind origin/main.
 *
 * Backend half: `lib/behind-origin.js` with both git calls stubbed at its
 * `_internal` seam, so every failure branch is driven without a remote and
 * the cache is driven against a controlled clock.
 *
 * Frontend half: `renderBehindOriginBanner` is LIFTED from public/landing.js
 * and RUN against a DOM stub (the version-visibility.test.js approach) — a
 * grep can prove the word `hidden` appears; only a run proves the banner
 * comes down after a pull.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const behindOrigin = require('../lib/behind-origin');
const { liftDeclaration } = require('./helpers/lift');

const ROOT = path.join(__dirname, '..');
const LANDING_SRC = fs.readFileSync(path.join(ROOT, 'public', 'landing.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const STYLE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

/**
 * Slice a top-level function out of landing.js by brace matching.
 * @param {string} name - Function name as declared.
 * @returns {string} The full declaration text.
 */
function extract(name) {
  // The first match, `async ` included, is also the first occurrence of its own
  // text, so the helper starts the slice where the match starts.
  const m = LANDING_SRC.match(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(m, `${name} should exist in landing.js`);
  return liftDeclaration(LANDING_SRC, m[0]);
}

/**
 * A DOM stub exposing only what the renderer touches.
 * @param {string[]} ids - Element ids to provide.
 * @returns {{els: object, document: object}}
 */
function makeDom(ids) {
  const els = {};
  for (const id of ids) {
    els[id] = {
      innerHTML: '',
      _hidden: true,
      disabled: false,
      textContent: '',
      _listeners: {},
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      classList: {
        add(c) { if (c === 'hidden') els[id]._hidden = true; },
        remove(c) { if (c === 'hidden') els[id]._hidden = false; },
        toggle(c, force) { if (c === 'hidden') els[id]._hidden = force; }
      }
    };
  }
  return { els, document: { getElementById: (id) => els[id] || null } };
}

/**
 * Install stubbed git calls. `fetch` / `revList` are either an Error (the
 * call fails), a string (rev-list stdout), `null` (success with no output),
 * or the token 'throw' (the seam itself throws synchronously). `head` is
 * 'branch' (default), 'detached', or an Error for any other branch-check failure.
 * @param {{fetch?: Error|null|'throw', revList?: Error|string|'throw', head?: 'branch'|'detached'|Error}} plan
 * @returns {{fetches: () => number, revLists: () => number}}
 */
function stubGit(plan) {
  let fetches = 0;
  let revLists = 0;
  // Synchronous on purpose: the snapshot tests assert "exactly one fetch was
  // started" right after the call, before yielding to the event loop.
  behindOrigin._internal.gitSymbolicRef = (cb) => {
    // execFile's error for a non-zero exit carries the status as `code`; `symbolic-ref -q`
    // exits 1 on a detached HEAD, and a caller-supplied error stands in for anything else.
    if (plan.head === 'detached') return cb(Object.assign(new Error('Command failed: git symbolic-ref -q HEAD'), { code: 1 }), '');
    if (plan.head instanceof Error) return cb(plan.head, '');
    cb(null, 'refs/heads/main\n');
  };
  behindOrigin._internal.gitFetch = (cb) => {
    fetches++;
    if (plan.fetch === 'throw') throw new Error('spawn refused');
    setImmediate(() => cb(plan.fetch instanceof Error ? plan.fetch : null));
  };
  behindOrigin._internal.gitRevList = (cb) => {
    revLists++;
    if (plan.revList === 'throw') throw new Error('spawn refused');
    setImmediate(() => {
      if (plan.revList instanceof Error) cb(plan.revList, '');
      else cb(null, plan.revList == null ? '' : plan.revList);
    });
  };
  return { fetches: () => fetches, revLists: () => revLists };
}

describe('lib/behind-origin (#227)', () => {
  const origInternal = { ...behindOrigin._internal };

  beforeEach(() => behindOrigin._reset());
  afterEach(() => {
    Object.assign(behindOrigin._internal, origInternal);
    behindOrigin._reset();
  });

  describe('getRemoteCommitsAhead', () => {
    it('counts the commits origin/main has that HEAD lacks', async () => {
      const calls = stubGit({ fetch: null, revList: '3\n' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 3);
      assert.equal(calls.fetches(), 1, 'fetches before counting — a stale origin/main is the whole bug');
      assert.equal(calls.revLists(), 1);
    });

    it('is 0 when the clone is level with origin/main', async () => {
      stubGit({ fetch: null, revList: '0\n' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });

    it('is 0 with no remote configured — fetch fails, rev-list is never asked', async () => {
      const calls = stubGit({ fetch: new Error("fatal: 'origin' does not appear to be a git repository") });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
      assert.equal(calls.revLists(), 0, 'no point counting against a ref the fetch could not bring');
    });

    it('is 0 when the fetch fails (offline, refused, timed out)', async () => {
      const timeout = new Error('spawnSync git ETIMEDOUT');
      timeout.killed = true;
      stubGit({ fetch: timeout });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });

    it('is 0 when rev-list fails (origin/main absent after the fetch)', async () => {
      stubGit({ fetch: null, revList: new Error("fatal: bad revision 'HEAD..origin/main'") });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });

    it('is 0 on unparseable or negative rev-list output', async () => {
      stubGit({ fetch: null, revList: 'warning: something\n' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
      stubGit({ fetch: null, revList: '-4\n' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
      stubGit({ fetch: null, revList: '' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });

    it('never throws — even when the git seam itself throws (git absent)', async () => {
      stubGit({ fetch: 'throw' });
      await assert.doesNotReject(behindOrigin.getRemoteCommitsAhead());
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
      stubGit({ fetch: null, revList: 'throw' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });

    it('only exit 1 from symbolic-ref is a detached HEAD; no git is no-git; a timeout or other failure is unknown', async () => {
      let calls = stubGit({ head: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) });
      let r = await behindOrigin.measure();
      assert.deepEqual(r, { commitsAhead: 0, skipped: 'no-git', state: 'skipped', reason: 'not a git checkout' });
      calls = stubGit({ head: Object.assign(new Error('x'), { code: 128, stderr: 'fatal: not a git repository' }) });
      assert.equal((await behindOrigin.measure()).skipped, 'no-git');
      calls = stubGit({ head: Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }) });
      r = await behindOrigin.measure();
      assert.equal(r.state, 'unknown', 'a timed-out branch check is a check that did not run, not a tagged install');
      assert.equal(r.skipped, null);
      assert.match(r.reason, /branch check failed/);
      assert.equal(calls.fetches(), 0, 'no fetch after a failed branch check');
      calls = stubGit({ head: Object.assign(new Error('fatal: bad object HEAD'), { code: 128 }) });
      assert.equal((await behindOrigin.measure()).state, 'unknown');
    });

    it('a failed step is state unknown with its reason, never measured — 0 is not "up to date" (#1678)', async () => {
      stubGit({ fetch: new Error('fatal: unable to access origin') });
      let r = await behindOrigin.measure();
      assert.equal(r.commitsAhead, 0);
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /fetch failed/);
      stubGit({ fetch: null, revList: new Error('fatal: bad revision') });
      r = await behindOrigin.measure();
      assert.equal(r.state, 'unknown');
      assert.match(r.reason, /rev-list failed/);
      stubGit({ fetch: null, revList: 'warning: something\n' });
      r = await behindOrigin.measure();
      assert.equal(r.state, 'unknown', 'garbage output is not a count of zero');
      assert.match(r.reason, /unparseable/);
      stubGit({ fetch: null, revList: '0\n' });
      r = await behindOrigin.measure();
      assert.deepEqual(r, { commitsAhead: 0, skipped: null, state: 'measured', reason: null },
        'a real zero is measured');
    });

    it('snapshot() carries a failed refresh as unknown with its reason and checkedAt', async () => {
      stubGit({ fetch: new Error('offline') });
      await behindOrigin.refresh();
      const snap = behindOrigin.snapshot({});
      assert.equal(snap.state, 'unknown');
      assert.equal(snap.commitsAhead, 0);
      assert.match(snap.reason, /offline/);
      assert.ok(snap.checkedAt, 'checkedAt stamps the attempt; only state measured makes it an observation');
    });

    it('skips a detached HEAD without fetching — a tagged install is behind main by construction', async () => {
      // The self-updater leaves a healthy install detached at a release tag;
      // counting there would show the banner for the whole release interval.
      const calls = stubGit({ head: 'detached', fetch: null, revList: '40\n' });
      const r = await behindOrigin.measure();
      assert.deepEqual(r, { commitsAhead: 0, skipped: 'detached-head', state: 'skipped', reason: 'HEAD is not on a branch' });
      assert.equal(calls.fetches(), 0, 'no network call for an install that should use Update now');
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });
  });

  describe('spawn hygiene', () => {
    /**
     * Run `fn` with `_internal.execFile` replaced by a recorder and the
     * test-runner guard lifted, so the REAL seams build their real options.
     * @param {() => Promise<void>} fn
     * @returns {Promise<Array<{args: string[], options: object}>>}
     */
    async function recordSpawns(fn) {
      const spawns = [];
      const saved = process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_TEST_CONTEXT;
      behindOrigin._internal.execFile = (cmd, args, options, cb) => {
        assert.equal(cmd, 'git');
        spawns.push({ args, options });
        setImmediate(() => cb(null, args[0] === 'rev-list' ? '2\n' : 'refs/heads/main\n'));
      };
      try {
        await fn();
      } finally {
        if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
        else process.env.NODE_TEST_CONTEXT = saved;
      }
      return spawns;
    }

    it('the fetch cannot prompt for credentials or steal a tty, and is bounded by FETCH_TIMEOUT_MS', async () => {
      const spawns = await recordSpawns(async () => {
        assert.equal(await behindOrigin.getRemoteCommitsAhead(), 2);
      });
      const fetch = spawns.find((s) => s.args[0] === 'fetch');
      assert.ok(fetch, 'a fetch must have been spawned');
      assert.deepEqual(fetch.args, ['fetch', '--quiet', 'origin']);
      assert.equal(fetch.options.timeout, behindOrigin.FETCH_TIMEOUT_MS);
      assert.ok(fetch.options.timeout > 0 && Number.isFinite(fetch.options.timeout),
        'an unbounded fetch would pin the single-flight slot forever on a hung remote');
      assert.equal(fetch.options.env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(fetch.options.env.GH_PROMPT_DISABLED, '1');
      assert.match(fetch.options.env.GIT_SSH_COMMAND, /BatchMode=yes/);
      assert.equal(fetch.options.env.PATH, process.env.PATH, 'the process env is inherited, not replaced');
    });

    it('the local calls are argv-form, bounded, and ordered symbolic-ref → fetch → rev-list', async () => {
      const spawns = await recordSpawns(async () => { await behindOrigin.measure(); });
      assert.deepEqual(spawns.map((s) => s.args[0]), ['symbolic-ref', 'fetch', 'rev-list'],
        'HEAD is checked before any network call is made');
      assert.deepEqual(spawns[0].args, ['symbolic-ref', '-q', 'HEAD']);
      assert.deepEqual(spawns[2].args, ['rev-list', `HEAD..${behindOrigin.UPSTREAM_REF}`, '--count']);
      for (const s of [spawns[0], spawns[2]]) {
        assert.equal(s.options.timeout, behindOrigin.LOCAL_GIT_TIMEOUT_MS);
        assert.ok(s.options.timeout > 0);
      }
    });

    it('under the node test runner the real seams spawn nothing — eight unstubbed route tests were fetching into the developer checkout', async () => {
      assert.ok(process.env.NODE_TEST_CONTEXT, 'this file runs under node --test, which sets NODE_TEST_CONTEXT');
      assert.equal(behindOrigin._spawnBlockedReason(), 'node test runner');
      let spawned = 0;
      behindOrigin._internal.execFile = () => { spawned++; };
      // Real seams (afterEach restored them before this test began).
      const r = await behindOrigin.measure();
      assert.equal(spawned, 0, 'no git process may be started from a test process');
      assert.equal(r.commitsAhead, 0);
    });
  });

  describe('cache', () => {
    it('refresh() stores the count with a checkedAt stamp', async () => {
      behindOrigin._internal.now = () => Date.parse('2026-01-01T00:00:00Z');
      stubGit({ fetch: null, revList: '2\n' });
      const result = await behindOrigin.refresh();
      assert.deepEqual(result, { commitsAhead: 2, skipped: null, state: 'measured', reason: null, checkedAt: '2026-01-01T00:00:00.000Z' });
    });

    it('refreshIfStale serves the cache inside the TTL and re-measures past it', async () => {
      let now = Date.parse('2026-01-01T00:00:00Z');
      behindOrigin._internal.now = () => now;
      const calls = stubGit({ fetch: null, revList: '2\n' });
      await behindOrigin.refreshIfStale();
      assert.equal(calls.fetches(), 1);

      now += behindOrigin.CACHE_TTL_MS - 1;
      const cached = await behindOrigin.refreshIfStale();
      assert.equal(calls.fetches(), 1, 'a cache younger than the TTL is served, not re-fetched');
      assert.equal(cached.commitsAhead, 2);

      now += 2;
      await behindOrigin.refreshIfStale();
      assert.equal(calls.fetches(), 2, 'past the TTL the answer is measured again');
    });

    it('coalesces concurrent refreshes onto one fetch (N tabs, one call to origin)', async () => {
      const calls = stubGit({ fetch: null, revList: '1\n' });
      const [a, b, c] = await Promise.all([
        behindOrigin.refresh(), behindOrigin.refresh(), behindOrigin.refresh()
      ]);
      assert.equal(calls.fetches(), 1);
      assert.equal(a, b);
      assert.equal(b, c);
    });

    it('snapshot() returns the cache immediately and starts one background refresh when it has expired', async () => {
      let now = Date.parse('2026-01-01T00:00:00Z');
      behindOrigin._internal.now = () => now;
      const calls = stubGit({ fetch: null, revList: '5\n' });

      // First poll: nothing measured yet, honest about it, fetch started.
      // repoRoot/pullCommand (#1367) are destructured out — stable but not this test's concern.
      const { repoRoot: r1, pullCommand: p1, ...first } = behindOrigin.snapshot({});
      assert.deepEqual(first, { enabled: true, commitsAhead: 0, skipped: null, checkedAt: null, state: 'pending', reason: 'not measured yet' });
      assert.ok(r1 && p1);
      assert.equal(calls.fetches(), 1);
      // A second poll before it completes must not start a second fetch.
      behindOrigin.snapshot({});
      assert.equal(calls.fetches(), 1);

      await behindOrigin.refresh(); // joins the in-flight measurement
      const { repoRoot: r2, pullCommand: p2, ...second } = behindOrigin.snapshot({});
      assert.deepEqual(second, { enabled: true, commitsAhead: 5, skipped: null, checkedAt: '2026-01-01T00:00:00.000Z', state: 'measured', reason: null });
      assert.ok(r2 && p2);
      assert.equal(calls.fetches(), 1, 'a fresh cache is served without touching the network');

      now += behindOrigin.CACHE_TTL_MS + 1;
      const third = behindOrigin.snapshot({});
      assert.equal(third.commitsAhead, 5, 'the expired value is still returned while the refresh runs');
      assert.equal(calls.fetches(), 2, 'an expired cache starts exactly one background fetch');
    });
  });

  describe('config off-switch', () => {
    it('is on by default and only a literal false turns it off', () => {
      assert.equal(behindOrigin.isCheckEnabled(undefined), true);
      assert.equal(behindOrigin.isCheckEnabled({}), true);
      assert.equal(behindOrigin.isCheckEnabled({ behindOriginCheckEnabled: true }), true);
      assert.equal(behindOrigin.isCheckEnabled({ behindOriginCheckEnabled: 'false' }), true,
        'a non-boolean is not a choice — the default stays, as PATCH refuses the value');
      assert.equal(behindOrigin.isCheckEnabled({ behindOriginCheckEnabled: false }), false);
    });

    it('a disabled check reports enabled:false and never starts a fetch, even with an expired cache', async () => {
      const calls = stubGit({ fetch: null, revList: '7\n' });
      const { repoRoot, pullCommand, ...snap } = behindOrigin.snapshot({ behindOriginCheckEnabled: false });
      assert.deepEqual(snap, { enabled: false, commitsAhead: 0, skipped: null, checkedAt: null, state: 'disabled', reason: 'check turned off' });
      assert.ok(repoRoot && pullCommand);
      assert.equal(calls.fetches(), 0);
    });

    it('the TC_BEHIND_ORIGIN_DISABLED environment kill switch overrides config (CI, sandboxes)', async () => {
      const saved = process.env[behindOrigin.ENV_KILL_SWITCH];
      const calls = stubGit({ fetch: null, revList: '7\n' });
      try {
        process.env[behindOrigin.ENV_KILL_SWITCH] = '1';
        assert.equal(behindOrigin.isCheckEnabled({ behindOriginCheckEnabled: true }), false);
        const snap = behindOrigin.snapshot({});
        assert.equal(snap.enabled, false);
        assert.equal(calls.fetches(), 0);
        process.env[behindOrigin.ENV_KILL_SWITCH] = '0';
        assert.equal(behindOrigin.isCheckEnabled({}), true, '"0" reads as not set');
        process.env[behindOrigin.ENV_KILL_SWITCH] = '';
        assert.equal(behindOrigin.isCheckEnabled({}), true, 'empty reads as not set');
      } finally {
        if (saved === undefined) delete process.env[behindOrigin.ENV_KILL_SWITCH];
        else process.env[behindOrigin.ENV_KILL_SWITCH] = saved;
      }
    });

    it('a detached-head measurement is reported as skipped, with nothing to show', async () => {
      stubGit({ head: 'detached' });
      await behindOrigin.refresh();
      const snap = behindOrigin.snapshot({});
      assert.equal(snap.enabled, true);
      assert.equal(snap.commitsAhead, 0);
      assert.equal(snap.skipped, 'detached-head');
    });

    it('a stale cached count is not reported once the operator disables the check', async () => {
      stubGit({ fetch: null, revList: '7\n' });
      await behindOrigin.refresh();
      assert.equal(behindOrigin.snapshot({}).commitsAhead, 7);
      const snap = behindOrigin.snapshot({ behindOriginCheckEnabled: false });
      assert.equal(snap.commitsAhead, 0, 'the flag is the operator\'s word; a cache must not override it');
      assert.equal(snap.enabled, false);
    });

    it('snapshot() always carries repoRoot and the copy/paste pullCommand (#1367), enabled or not', () => {
      const path = require('node:path');
      const repoRoot = path.resolve(__dirname, '..');
      for (const cfg of [{}, { behindOriginCheckEnabled: false }]) {
        const snap = behindOrigin.snapshot(cfg);
        assert.equal(snap.repoRoot, repoRoot);
        assert.equal(snap.pullCommand, `cd ${repoRoot} && git pull`);
      }
    });
  });

  describe('canFastForwardPull (#1223)', () => {
    const SAFE = {
      state: 'measured', detached: false, branch: 'main', relation: 'behind',
      ahead: 0, behind: 3, dirtyTracked: 0, untracked: 0
    };
    const ENABLED = { enabled: true };

    it('true only when on main, strictly behind, nothing ahead, and clean', () => {
      assert.equal(behindOrigin.canFastForwardPull(SAFE, ENABLED), true);
    });

    it('false when the behind-origin check itself is disabled, or the snapshot is missing', () => {
      assert.equal(behindOrigin.canFastForwardPull(SAFE, { enabled: false }), false);
      assert.equal(behindOrigin.canFastForwardPull(SAFE, null), false);
    });

    it('false when detached, or on a branch other than main', () => {
      assert.equal(behindOrigin.canFastForwardPull({ ...SAFE, detached: true, branch: null }, ENABLED), false);
      assert.equal(behindOrigin.canFastForwardPull({ ...SAFE, branch: 'feature/x' }, ENABLED), false);
    });

    it('false unless strictly behind with nothing ahead (equal, ahead, or diverged all refuse)', () => {
      assert.equal(behindOrigin.canFastForwardPull({ ...SAFE, relation: 'equal', behind: 0 }, ENABLED), false);
      assert.equal(behindOrigin.canFastForwardPull({ ...SAFE, relation: 'ahead', ahead: 2, behind: 0 }, ENABLED), false);
      assert.equal(behindOrigin.canFastForwardPull({ ...SAFE, relation: 'diverged', ahead: 1 }, ENABLED), false,
        'ahead > 0 must refuse even if relation never updates: a pull here is not a fast-forward');
    });

    it('false when the tree is not completely clean', () => {
      assert.equal(behindOrigin.canFastForwardPull({ ...SAFE, dirtyTracked: 1 }, ENABLED), false);
      assert.equal(behindOrigin.canFastForwardPull({ ...SAFE, untracked: 1 }, ENABLED), false);
    });

    it('false when the checkout state is not measured (pending, unknown, no-git)', () => {
      assert.equal(behindOrigin.canFastForwardPull({ ...SAFE, state: 'pending' }, ENABLED), false);
      assert.equal(behindOrigin.canFastForwardPull(null, ENABLED), false);
    });
  });

  describe('pullFastForward (#1223)', () => {
    const SAFE = {
      state: 'measured', detached: false, branch: 'main', relation: 'behind',
      ahead: 0, behind: 3, dirtyTracked: 0, untracked: 0, headSha: 'a'.repeat(40)
    };

    it('refuses with PULL_NOT_SAFE on a fresh recheck, without ever touching git merge', async () => {
      let merges = 0;
      behindOrigin._internal.measureCheckout = async () => ({ ...SAFE, dirtyTracked: 1 });
      behindOrigin._internal.gitMerge = (cb) => { merges++; cb(null); };
      const r = await behindOrigin.pullFastForward();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'PULL_NOT_SAFE');
      assert.match(r.error, /clean/);
      assert.equal(r.fromSha, null);
      assert.equal(r.toSha, null);
      assert.equal(merges, 0, 'an unsafe checkout must never reach the merge');
    });

    it('fast-forwards, refreshes both caches, and reports the SHA range on success', async () => {
      stubGit({ fetch: null, revList: '0\n' }); // what refresh()'s own measure() sees post-merge
      behindOrigin._internal.measureCheckout = async () => SAFE;
      let mergeArgs = null;
      behindOrigin._internal.gitMerge = (cb) => { mergeArgs = true; cb(null); };
      let refreshedDir = null;
      behindOrigin._internal.refreshCheckout = async (dir) => { refreshedDir = dir; return { ...SAFE, behind: 0, relation: 'equal', headSha: 'b'.repeat(40) }; };

      const r = await behindOrigin.pullFastForward();
      assert.ok(mergeArgs, 'git merge --ff-only must have run');
      assert.equal(r.ok, true);
      assert.equal(r.code, null);
      assert.equal(r.error, null);
      assert.equal(r.fromSha, SAFE.headSha);
      assert.equal(r.toSha, 'b'.repeat(40));
      assert.ok(refreshedDir, 'checkout-state cache must be refreshed so the next poll is fresh');
      assert.equal(behindOrigin.snapshot({}).commitsAhead, 0, 'behind-origin\'s own cache is refreshed too');
    });

    it('MERGE_FAILED when the ff-only merge itself refuses (a race since the precondition check)', async () => {
      behindOrigin._internal.measureCheckout = async () => SAFE;
      behindOrigin._internal.gitMerge = (cb) => cb(Object.assign(new Error('fatal: Not possible to fast-forward, aborting.'), { code: 128 }));
      const r = await behindOrigin.pullFastForward();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'MERGE_FAILED');
      assert.match(r.error, /fast-forward/);
      assert.equal(r.fromSha, SAFE.headSha, 'fromSha is already known from the precondition check');
      assert.equal(r.toSha, null);
    });

    it('GIT_ERROR, not MERGE_FAILED, when git itself is unavailable', async () => {
      behindOrigin._internal.measureCheckout = async () => SAFE;
      behindOrigin._internal.gitMerge = (cb) => cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
      const r = await behindOrigin.pullFastForward();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'GIT_ERROR');
    });

    it('never rejects, even when measureCheckout itself throws', async () => {
      behindOrigin._internal.measureCheckout = async () => { throw new Error('boom'); };
      const r = await behindOrigin.pullFastForward();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'PULL_NOT_SAFE');
      assert.match(r.error, /could not be read/);
    });
  });
});

describe('behind-origin banner (#227) — executed against a DOM stub', () => {
  /**
   * Run the real renderer with a payload.
   * @param {*} payload - The `behindOrigin` field of /api/server-info.
   * @returns {{banner: object, text: object}}
   */
  function render(payload) {
    const dom = makeDom(['behindOriginBanner', 'behindOriginBannerText', 'behindOriginPullBtn']);
    const ctx = vm.createContext({ document: dom.document, esc: (s) => String(s) });
    vm.runInContext(`${extract('renderBehindOriginBanner')}\nrenderBehindOriginBanner(payload);`,
      Object.assign(ctx, { payload }));
    return { banner: dom.els.behindOriginBanner, text: dom.els.behindOriginBannerText, pullBtn: dom.els.behindOriginPullBtn };
  }

  it('shows the count and the remedy when the clone is behind', () => {
    const { banner, text } = render({ enabled: true, commitsAhead: 3, checkedAt: 'T' });
    assert.equal(banner._hidden, false);
    assert.match(text.innerHTML, /3 new commits upstream on origin\/main\./);
    assert.match(text.innerHTML, /This checkout is behind — pull them when convenient\./);
    assert.match(text.innerHTML, /release tag updates through <em>Update now<\/em>/,
      'a tagged install must be pointed at the guarded applier, not a raw pull');
  });

  it('falls back to plain prose, no verbatim command, when pullCommand is absent (older server)', () => {
    const { text } = render({ enabled: true, commitsAhead: 2, checkedAt: 'T' });
    assert.doesNotMatch(text.innerHTML, /git (pull|reset|stash)/);
  });

  it('embeds the exact copy/paste command (#1367) when the server carries pullCommand', () => {
    const { text } = render({ enabled: true, commitsAhead: 2, checkedAt: 'T', pullCommand: 'cd /abs/path && git pull' });
    assert.match(text.innerHTML, /Run: <code>cd \/abs\/path && git pull<\/code>/);
  });

  it('escapes pullCommand before it reaches innerHTML', () => {
    // render()'s shared `esc` stub is an identity function (every other test
    // here only checks that esc() was CALLED, via the template shape) — a
    // real escaper is needed to prove the escaping itself, not just the call.
    const realEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const dom = makeDom(['behindOriginBanner', 'behindOriginBannerText', 'behindOriginPullBtn']);
    const ctx = vm.createContext({ document: dom.document, esc: realEsc });
    vm.runInContext(`${extract('renderBehindOriginBanner')}\nrenderBehindOriginBanner(payload);`,
      Object.assign(ctx, { payload: { enabled: true, commitsAhead: 2, checkedAt: 'T', pullCommand: '<img src=x onerror=1>' } }));
    assert.doesNotMatch(dom.els.behindOriginBannerText.innerHTML, /<img/);
    assert.match(dom.els.behindOriginBannerText.innerHTML, /&lt;img/);
  });

  it('this banner rendering a verbatim command never contradicts the #730 guard: a tagged install never reaches this render at all', () => {
    // #730's guard is upstream of this function entirely — a detached HEAD
    // skips the fetch before any measurement happens (see the other describe
    // block's "skips a detached HEAD" test), so commitsAhead stays 0 and this
    // function never renders for that install, command or no command.
    assert.equal(render({ enabled: true, commitsAhead: 0, skipped: 'detached-head', pullCommand: 'cd /x && git pull', checkedAt: 'T' }).banner._hidden, true);
  });

  it('shows the Pull button only when canFastForwardPull is true, and hides it otherwise', () => {
    assert.equal(render({ enabled: true, commitsAhead: 2, checkedAt: 'T', canFastForwardPull: true }).pullBtn._hidden, false);
    assert.equal(render({ enabled: true, commitsAhead: 2, checkedAt: 'T', canFastForwardPull: false }).pullBtn._hidden, true);
    assert.equal(render({ enabled: true, commitsAhead: 2, checkedAt: 'T' }).pullBtn._hidden, true,
      'absent (older server) must not be read as true');
  });

  it('hides the Pull button along with the banner once the count comes down', () => {
    const dom = makeDom(['behindOriginBanner', 'behindOriginBannerText', 'behindOriginPullBtn']);
    dom.els.behindOriginPullBtn._hidden = false;
    const ctx = vm.createContext({ document: dom.document, esc: (s) => String(s) });
    vm.runInContext(`${extract('renderBehindOriginBanner')}\nrenderBehindOriginBanner({ enabled: true, commitsAhead: 0, checkedAt: 'T' });`, ctx);
    assert.equal(dom.els.behindOriginPullBtn._hidden, true);
  });

  it('pluralises honestly for one commit', () => {
    const { text } = render({ enabled: true, commitsAhead: 1, checkedAt: 'T' });
    assert.match(text.innerHTML, /1 new commit upstream/);
    assert.doesNotMatch(text.innerHTML, /commits/);
  });

  it('comes down once a pull brings the count to 0 — hiding is as load-bearing as showing', () => {
    const dom = makeDom(['behindOriginBanner', 'behindOriginBannerText']);
    dom.els.behindOriginBanner._hidden = false;
    const ctx = vm.createContext({ document: dom.document, esc: (s) => String(s) });
    vm.runInContext(`${extract('renderBehindOriginBanner')}\nrenderBehindOriginBanner({ enabled: true, commitsAhead: 0, checkedAt: 'T' });`, ctx);
    assert.equal(dom.els.behindOriginBanner._hidden, true);
  });

  it('stays hidden when the check is disabled, unmeasured, absent (older server), or garbage', () => {
    assert.equal(render({ enabled: false, commitsAhead: 4, checkedAt: null }).banner._hidden, true,
      'a disabled check must not render a count it was told not to gather');
    assert.equal(render({ enabled: true, commitsAhead: 0, checkedAt: null }).banner._hidden, true);
    assert.equal(render({ enabled: true, commitsAhead: 0, skipped: 'detached-head', checkedAt: 'T' }).banner._hidden, true,
      'a tagged install is not nagged to pull');
    assert.equal(render(undefined).banner._hidden, true);
    assert.equal(render(null).banner._hidden, true);
    assert.equal(render({ enabled: true, commitsAhead: '<img src=x onerror=1>', checkedAt: 'T' }).banner._hidden, true,
      'a non-numeric count clamps to 0 — nothing unescaped reaches innerHTML');
  });

  it('is an info-tone sibling of the stale-server banner above the projects grid', () => {
    const stale = INDEX_SRC.indexOf('id="staleServerBanner"');
    const behind = INDEX_SRC.indexOf('id="behindOriginBanner"');
    const grid = INDEX_SRC.indexOf('id="cardsGrid"');
    assert.ok(stale > -1 && behind > -1 && grid > -1);
    assert.ok(stale < behind && behind < grid, 'rendered after the stale banner and before the grid');
    assert.match(INDEX_SRC, /id="behindOriginBanner" class="orphan-banner behind-origin-banner hidden" role="status"/,
      'hidden at rest; role=status not alert — the remedy is not urgent');
    assert.match(INDEX_SRC, /id="behindOriginBannerText"/);
    assert.match(INDEX_SRC, /id="behindOriginPullBtn"/, 'the Pull button (#1223) must exist in the markup, even hidden at rest');

    const rule = STYLE_SRC.match(/\.behind-origin-banner \{([^}]*)\}/);
    assert.ok(rule, 'style.css must style .behind-origin-banner');
    assert.doesNotMatch(rule[1], /--danger/, 'info tone, not the danger colour the stale-server banner uses');
    assert.match(rule[1], /background:/);
  });

  it('loadServerInfo renders it before the stale-server branches return', () => {
    const src = extract('loadServerInfo');
    const call = src.indexOf('renderBehindOriginBanner(data.behindOrigin)');
    const staleBranch = src.indexOf('if (data.isStale === null)');
    assert.ok(call > -1, 'loadServerInfo must call renderBehindOriginBanner');
    assert.ok(staleBranch > -1);
    assert.ok(call < staleBranch,
      'a checkout both behind upstream and ahead of the process must show both banners');
  });
});

describe('behind-origin Pull button click handler (#1223) — executed against stubs', () => {
  /**
   * Run the real `_handleBehindOriginPullClick` against a stubbed
   * `apiMutate`/`api`/`window`/`triggerServerRestart`/`loadServerInfo`.
   * @param {{apiMutateImpl: Function, apiLastError?: string|null}} opts
   * @returns {{btn: object, calls: {restart: number, loadInfo: number, alerts: string[]}, promise: Promise<void>}}
   */
  function run({ apiMutateImpl, apiLastError }) {
    const dom = makeDom(['behindOriginPullBtn']);
    const btn = dom.els.behindOriginPullBtn;
    btn.disabled = false;
    btn.textContent = 'Pull';
    const calls = { restart: 0, loadInfo: 0, alerts: [] };
    const ctx = vm.createContext({
      document: dom.document,
      apiMutate: apiMutateImpl,
      api: { lastError: apiLastError || null },
      window: { alert: (msg) => calls.alerts.push(msg) },
      triggerServerRestart: async () => { calls.restart++; },
      loadServerInfo: async () => { calls.loadInfo++; },
      console
    });
    const promise = vm.runInContext(
      `${extract('_handleBehindOriginPullClick')}\n_handleBehindOriginPullClick();`, ctx);
    return { btn, calls, promise };
  }

  it('on success with a restartMechanism, hands off to triggerServerRestart and re-enables the button', async () => {
    const { btn, calls, promise } = run({
      apiMutateImpl: async () => ({ ok: true, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40), restartMechanism: 'launchd' })
    });
    await promise;
    assert.equal(calls.restart, 1);
    assert.equal(calls.loadInfo, 0, 'the restart flow makes its own fresh poll — a second one here would be redundant');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Pull');
  });

  it('on success with no restartMechanism, re-polls server-info instead of offering a restart', async () => {
    const { calls, promise } = run({
      apiMutateImpl: async () => ({ ok: true, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40), restartMechanism: null })
    });
    await promise;
    assert.equal(calls.restart, 0, 'no mechanism on this host — nothing to hand off to');
    assert.equal(calls.loadInfo, 1, 'the banner must clear itself from a fresh poll, not wait for the next timer tick');
  });

  it('on a 409 refusal, alerts with the server error and restores the button — no restart offered', async () => {
    const { btn, calls, promise } = run({
      apiMutateImpl: async () => ({ ok: false, code: 'PULL_NOT_SAFE', error: 'the working tree is not clean' })
    });
    await promise;
    assert.equal(calls.restart, 0);
    assert.equal(calls.loadInfo, 0);
    assert.equal(calls.alerts.length, 1);
    assert.match(calls.alerts[0], /not clean/);
    assert.equal(btn.disabled, false, 'a refusal must not leave the button stuck disabled');
    assert.equal(btn.textContent, 'Pull');
  });

  it('on a network failure (apiMutate resolves null), alerts from api.lastError and restores the button', async () => {
    const { btn, calls, promise } = run({ apiMutateImpl: async () => null, apiLastError: 'offline' });
    await promise;
    assert.equal(calls.alerts.length, 1);
    assert.match(calls.alerts[0], /offline/);
    assert.equal(btn.disabled, false);
  });

  it('on apiMutate throwing, alerts with the error message and restores the button', async () => {
    const { btn, calls, promise } = run({ apiMutateImpl: async () => { throw new Error('boom'); } });
    await promise;
    assert.equal(calls.alerts.length, 1);
    assert.match(calls.alerts[0], /boom/);
    assert.equal(btn.disabled, false);
  });

  it('disables the button and shows "Pulling…" immediately, before the request resolves', () => {
    const dom = makeDom(['behindOriginPullBtn']);
    const btn = dom.els.behindOriginPullBtn;
    let resolveFetch;
    const ctx = vm.createContext({
      document: dom.document,
      apiMutate: () => new Promise((resolve) => { resolveFetch = resolve; }),
      api: { lastError: null },
      window: { alert: () => {} },
      triggerServerRestart: async () => {},
      loadServerInfo: async () => {},
      console
    });
    vm.runInContext(`${extract('_handleBehindOriginPullClick')}\n_handleBehindOriginPullClick();`, ctx);
    assert.equal(btn.disabled, true);
    assert.equal(btn.textContent, 'Pulling…');
    resolveFetch({ ok: true, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40), restartMechanism: null });
  });

  it('wireBehindOriginPullBtn attaches a click listener that invokes the handler', () => {
    const dom = makeDom(['behindOriginPullBtn']);
    let handlerCalls = 0;
    const ctx = vm.createContext({
      document: dom.document,
      _handleBehindOriginPullClick: async () => { handlerCalls++; },
      console
    });
    vm.runInContext(`${extract('wireBehindOriginPullBtn')}\nwireBehindOriginPullBtn();`, ctx);
    const listeners = dom.els.behindOriginPullBtn._listeners.click || [];
    assert.equal(listeners.length, 1, 'exactly one click listener — called once at init (idempotent)');
    listeners[0]();
    assert.equal(handlerCalls, 1);
  });
});
