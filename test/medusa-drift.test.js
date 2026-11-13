'use strict';

// Tests for #2956 — Medusa upstream & local Hub drift detection. Every test
// injects `_internal` (execFileAsync, fetchImpl, pathExists); zero live
// network or process calls.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const drift = require('../lib/medusa-drift');
const medusa = require('../lib/medusa');

const LOCAL_SHA = 'a'.repeat(40);
const UPSTREAM_SHA = 'b'.repeat(40);

describe('medusa-drift (#2956)', () => {
  const realInternal = { ...drift._internal };

  afterEach(() => {
    Object.assign(drift._internal, realInternal);
    drift.stop();
  });

  describe('localCheckoutStatus', () => {
    it('reads "not installed" when the checkout path does not exist, without ever running git', async () => {
      drift._internal.pathExists = () => false;
      drift._internal.execFileAsync = async () => { throw new Error('must not run git'); };
      const out = await drift.localCheckoutStatus({ checkoutPath: '/nonexistent/Medusa-PM' });
      assert.deepEqual(out, { installed: false, path: '/nonexistent/Medusa-PM', gitSha: null, commitsBehind: null, updateAvailable: false, error: null });
    });

    it('reads the HEAD sha and commitsBehind when the checkout is current', async () => {
      drift._internal.pathExists = () => true;
      drift._internal.execFileAsync = async (cmd, args) => {
        if (args.includes('rev-parse')) return { stdout: `${LOCAL_SHA}\n` };
        if (args.includes('rev-list')) return { stdout: '0\n' };
        throw new Error(`unexpected git ${args.join(' ')}`);
      };
      const out = await drift.localCheckoutStatus({ checkoutPath: '/fake/Medusa-PM' });
      assert.deepEqual(out, { installed: true, path: '/fake/Medusa-PM', gitSha: LOCAL_SHA, commitsBehind: 0, updateAvailable: false, error: null });
    });

    it('reads updateAvailable:true when behind origin/main', async () => {
      drift._internal.pathExists = () => true;
      drift._internal.execFileAsync = async (cmd, args) => {
        if (args.includes('rev-parse')) return { stdout: `${LOCAL_SHA}\n` };
        if (args.includes('rev-list')) return { stdout: '3\n' };
        throw new Error('unexpected');
      };
      const out = await drift.localCheckoutStatus({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.commitsBehind, 3);
      assert.equal(out.updateAvailable, true);
    });

    it('still reports the HEAD sha honestly when origin/main cannot be compared (no such ref, or not a git repo)', async () => {
      drift._internal.pathExists = () => true;
      drift._internal.execFileAsync = async (cmd, args) => {
        if (args.includes('rev-parse')) return { stdout: `${LOCAL_SHA}\n` };
        if (args.includes('rev-list')) throw new Error("fatal: ambiguous argument 'HEAD..origin/main'");
        throw new Error('unexpected');
      };
      const out = await drift.localCheckoutStatus({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.gitSha, LOCAL_SHA);
      assert.equal(out.commitsBehind, null);
      assert.equal(out.updateAvailable, false);
      assert.equal(out.error, null);
    });

    it('surfaces an error, honestly, when even rev-parse HEAD fails (a damaged or non-git directory)', async () => {
      drift._internal.pathExists = () => true;
      drift._internal.execFileAsync = async () => { throw new Error('fatal: not a git repository'); };
      const out = await drift.localCheckoutStatus({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.installed, true);
      assert.equal(out.gitSha, null);
      assert.match(out.error, /not a git repository/);
    });
  });

  describe('hubVersionStatus', () => {
    it('reads gitSha/version/capabilities from /health when it answers', async () => {
      drift._internal.fetchImpl = async (url) => {
        assert.match(url, /\/health$/);
        return { ok: true, json: async () => ({ version: '1.2.3', gitSha: UPSTREAM_SHA, capabilities: ['idempotency'] }) };
      };
      const out = await drift.hubVersionStatus({ bridgeHttpUrl: 'http://localhost:3009' });
      assert.deepEqual(out, { reachable: true, gitSha: UPSTREAM_SHA, version: '1.2.3', capabilities: ['idempotency'], error: null });
    });

    it('falls back to /version when /health answers not-ok', async () => {
      drift._internal.fetchImpl = async (url) => {
        if (url.endsWith('/health')) return { ok: false, status: 404 };
        if (url.endsWith('/version')) return { ok: true, json: async () => ({ version: '1.2.3', gitSha: UPSTREAM_SHA }) };
        throw new Error('unexpected url');
      };
      const out = await drift.hubVersionStatus({ bridgeHttpUrl: 'http://localhost:3009' });
      assert.equal(out.reachable, true);
      assert.equal(out.gitSha, UPSTREAM_SHA);
    });

    it('tolerates a Hub that predates Medusa#70 (no gitSha/capabilities at all): reachable, but those fields are null, never an error', async () => {
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
      const out = await drift.hubVersionStatus({ bridgeHttpUrl: 'http://localhost:3009' });
      assert.equal(out.reachable, true);
      assert.equal(out.gitSha, null);
      assert.equal(out.capabilities, null);
      assert.equal(out.error, null);
    });

    it('reads unreachable, honestly, when neither endpoint answers', async () => {
      drift._internal.fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
      const out = await drift.hubVersionStatus({ bridgeHttpUrl: 'http://localhost:3009' });
      assert.equal(out.reachable, false);
      assert.ok(out.error);
    });
  });

  describe('getDrift', () => {
    beforeEach(() => { drift.stop(); });

    it('reads hubRestartNeeded:true when the Hub\'s reported gitSha differs from the checkout\'s disk HEAD', async () => {
      drift._internal.pathExists = () => true;
      drift._internal.execFileAsync = async (cmd, args) => {
        if (args.includes('rev-parse')) return { stdout: `${LOCAL_SHA}\n` };
        if (args.includes('rev-list')) return { stdout: '0\n' };
        throw new Error('unexpected');
      };
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: UPSTREAM_SHA }) });
      const out = await drift.getDrift({ force: true, checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.hubRestartNeeded, true);
      assert.equal(out.updateAvailable, false);
    });

    it('reads hubRestartNeeded:false when the Hub\'s reported gitSha matches the checkout\'s disk HEAD', async () => {
      drift._internal.pathExists = () => true;
      drift._internal.execFileAsync = async (cmd, args) => {
        if (args.includes('rev-parse')) return { stdout: `${LOCAL_SHA}\n` };
        if (args.includes('rev-list')) return { stdout: '0\n' };
        throw new Error('unexpected');
      };
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      const out = await drift.getDrift({ force: true, checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.hubRestartNeeded, false);
    });

    it('never reads hubRestartNeeded:true when either side\'s gitSha is unknown', async () => {
      drift._internal.pathExists = () => false; // not installed -- local.gitSha stays null
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: UPSTREAM_SHA }) });
      const out = await drift.getDrift({ force: true, checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.hubRestartNeeded, false);
    });

    it('caches for drift.TTL_MS and expires exactly then; force bypasses it regardless', async (t) => {
      drift._internal.pathExists = () => true;
      let calls = 0;
      drift._internal.execFileAsync = async (cmd, args) => {
        if (args.includes('rev-parse')) { calls += 1; return { stdout: `${LOCAL_SHA}\n` }; }
        if (args.includes('rev-list')) return { stdout: '0\n' };
        throw new Error('unexpected');
      };
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      t.mock.timers.enable({ apis: ['Date'] });
      await drift.getDrift({ force: true, checkoutPath: '/fake/Medusa-PM' });
      await drift.getDrift({ checkoutPath: '/fake/Medusa-PM' }); // cached, no new call
      assert.equal(calls, 1);
      await drift.getDrift({ force: true, checkoutPath: '/fake/Medusa-PM' });
      assert.equal(calls, 2, 'force always bypasses the cache, well inside TTL_MS');
      t.mock.timers.tick(drift.TTL_MS - 1);
      await drift.getDrift({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(calls, 2, 'one millisecond short of TTL_MS, still cached');
      t.mock.timers.tick(1);
      await drift.getDrift({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(calls, 3, 'TTL_MS elapsed: a fresh check, with no force needed');
    });

    it('`fetch: true` runs git fetch origin main before comparing, and tolerates its failure', async () => {
      drift._internal.pathExists = () => true;
      const ran = [];
      drift._internal.execFileAsync = async (cmd, args) => {
        ran.push(args.join(' '));
        if (args.includes('fetch')) throw new Error('ECONNREFUSED');
        if (args.includes('rev-parse')) return { stdout: `${LOCAL_SHA}\n` };
        if (args.includes('rev-list')) return { stdout: '0\n' };
        throw new Error('unexpected');
      };
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      const out = await drift.getDrift({ force: true, fetch: true, checkoutPath: '/fake/Medusa-PM' });
      assert.ok(ran.some((a) => a.startsWith('fetch')));
      assert.equal(out.local.gitSha, LOCAL_SHA, 'a failed fetch still falls through to comparing the refs already on disk');
    });
  });

  describe('refreshDrift / onDriftChange', () => {
    beforeEach(() => { drift.stop(); });

    it('calls every onDriftChange subscriber with the fresh snapshot', async () => {
      drift._internal.pathExists = () => false;
      drift._internal.fetchImpl = async () => { throw new Error('unreachable'); };
      const seen = [];
      const unsubscribe = drift.onDriftChange((snap) => seen.push(snap));
      const out = await drift.refreshDrift();
      assert.equal(seen.length, 1);
      assert.equal(seen[0], out);
      unsubscribe();
      await drift.refreshDrift();
      assert.equal(seen.length, 1, 'unsubscribed, never called again');
    });

    it('one throwing subscriber does not stop the others', async () => {
      drift._internal.pathExists = () => false;
      drift._internal.fetchImpl = async () => { throw new Error('unreachable'); };
      let secondCalled = false;
      drift.onDriftChange(() => { throw new Error('boom'); });
      drift.onDriftChange(() => { secondCalled = true; });
      await drift.refreshDrift();
      assert.equal(secondCalled, true);
    });
  });

  describe('start / stop — wiring to lib/medusa.js\'s hub.version_updated fan-out', () => {
    afterEach(() => { drift.stop(); });

    it('a hub.version_updated notification triggers a fresh, forced refresh', async () => {
      drift._internal.pathExists = () => false;
      drift._internal.fetchImpl = async () => { throw new Error('unreachable'); };
      drift.start();
      const seen = [];
      drift.onDriftChange((snap) => seen.push(snap));
      medusa.applyHubVersionUpdate({ gitSha: UPSTREAM_SHA });
      // applyHubVersionUpdate's own subscribers run synchronously, but this
      // one's body is an un-awaited async refresh -- give it a tick.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 1);
    });

    it('stop() unsubscribes; a later hub.version_updated does nothing', async () => {
      drift._internal.pathExists = () => false;
      drift._internal.fetchImpl = async () => { throw new Error('unreachable'); };
      drift.start();
      drift.stop();
      const seen = [];
      drift.onDriftChange((snap) => seen.push(snap));
      medusa.applyHubVersionUpdate({ gitSha: UPSTREAM_SHA });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 0);
    });

    it('start() twice does not double-subscribe (a single hub.version_updated triggers exactly one refresh)', async () => {
      drift._internal.pathExists = () => false;
      drift._internal.fetchImpl = async () => { throw new Error('unreachable'); };
      drift.start();
      drift.start();
      const seen = [];
      drift.onDriftChange((snap) => seen.push(snap));
      medusa.applyHubVersionUpdate({ gitSha: UPSTREAM_SHA });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 1);
    });

    it('the first check runs after initialDelayMs, then the periodic background check calls refreshDrift on its own interval -- and start() twice resets it rather than stacking a second timer', async (t) => {
      drift._internal.pathExists = () => false;
      drift._internal.fetchImpl = async () => { throw new Error('unreachable'); };
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      const seen = [];
      drift.onDriftChange((snap) => seen.push(snap));
      drift.start({ initialDelayMs: 500, intervalMs: 1000 });
      drift.start({ initialDelayMs: 500, intervalMs: 1000 });
      t.mock.timers.tick(499);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 0, 'not yet due -- one millisecond short of the initial delay');
      t.mock.timers.tick(1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 1, 'the first check, right after initialDelayMs, not after a full intervalMs');
      t.mock.timers.tick(1000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 2, 'exactly one periodic refresh per tick after that, not two stacked timers');
      t.mock.timers.tick(1000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 3);
    });

    it('start() with no options uses DEFAULT_INITIAL_DELAY_MS, then DEFAULT_CHECK_INTERVAL_MS', async (t) => {
      drift._internal.pathExists = () => false;
      drift._internal.fetchImpl = async () => { throw new Error('unreachable'); };
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      const seen = [];
      drift.onDriftChange((snap) => seen.push(snap));
      drift.start();
      t.mock.timers.tick(drift.DEFAULT_INITIAL_DELAY_MS - 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 0, 'not yet due');
      t.mock.timers.tick(1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 1, 'the first check, after DEFAULT_INITIAL_DELAY_MS -- not DEFAULT_CHECK_INTERVAL_MS');
      t.mock.timers.tick(drift.DEFAULT_CHECK_INTERVAL_MS);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seen.length, 2, 'the periodic interval took over afterward');
    });
  });

  describe('restartHubCommand', () => {
    it('darwin: launchctl kickstart -k gui/<uid>/com.medusa.hub', () => {
      assert.deepEqual(drift.restartHubCommand({ platform: 'darwin', uid: 501 }),
        { cmd: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.medusa.hub'] });
    });

    it('linux (or anything else): systemctl --user restart medusa-hub.service', () => {
      assert.deepEqual(drift.restartHubCommand({ platform: 'linux' }),
        { cmd: 'systemctl', args: ['--user', 'restart', 'medusa-hub.service'] });
    });

    it('defaults to the real process.platform/process.getuid() when not overridden', () => {
      const out = drift.restartHubCommand();
      if (process.platform === 'darwin') {
        assert.deepEqual(out, { cmd: 'launchctl', args: ['kickstart', '-k', `gui/${process.getuid()}/com.medusa.hub`] });
      } else {
        assert.deepEqual(out, { cmd: 'systemctl', args: ['--user', 'restart', 'medusa-hub.service'] });
      }
    });
  });

  describe('applyDriftAction (#2956, the one-click Operator action)', () => {
    /**
     * A ready-to-use git command stub: `rev-parse`/`rev-list` answer as a
     * checkout `commitsBehind` behind, `status --porcelain` answers clean
     * unless `dirty` is set (or answers `status` verbatim, NUL-delimited like
     * the real `-z` output), `rev-parse --abbrev-ref HEAD` answers `branch`
     * (default `main`; `'HEAD'` is a detached HEAD; `null` makes it fail), and
     * every other call (merge, fetch) is recorded in `calls` and succeeds
     * unless `fail` names it.
     * @param {object} [opts]
     * @returns {{impl: Function, calls: string[]}}
     */
    function gitStub(opts = {}) {
      const calls = [];
      const commitsBehind = opts.commitsBehind || 0;
      const impl = async (cmd, args) => {
        calls.push(args.join(' '));
        if (cmd !== 'git') return { stdout: '' }; // the restart command, recorded but not git
        if (args.includes('--abbrev-ref')) {
          if (opts.branch === null) throw new Error('fatal: not a git repository');
          return { stdout: `${opts.branch === undefined ? 'main' : opts.branch}\n` };
        }
        if (args.includes('rev-parse')) return { stdout: `${LOCAL_SHA}\n` };
        if (args.includes('rev-list')) return { stdout: `${commitsBehind}\n` };
        if (args.includes('status')) {
          if (typeof opts.status === 'string') return { stdout: opts.status };
          return { stdout: opts.dirty ? ' M some-file.js\0' : '' };
        }
        if (args.includes('merge')) {
          if (opts.failMerge) throw new Error('fatal: Not possible to fast-forward');
          return { stdout: '' };
        }
        if (args.includes('fetch')) return { stdout: '' };
        throw new Error(`unexpected git ${args.join(' ')}`);
      };
      return { impl, calls };
    }

    /**
     * A hub stub whose reported `gitSha` only becomes `LOCAL_SHA` (matching
     * the checkout) once the restart command recorded in `calls` has
     * actually run — so a test can tell "restart attempted and verified"
     * apart from "restart attempted but the Hub never actually came up",
     * same distinction #2956 R-Gate R2's own finding turns on.
     * @param {object} [opts]
     * @param {string[]} calls - The same array `gitStub`'s impl pushes to
     * @returns {Function} `fetchImpl`
     */
    function hubStub(opts, calls) {
      return async () => {
        if (opts.neverReachable) throw new Error('ECONNREFUSED');
        const restarted = calls.some((c) => c === 'restart-marker');
        if (opts.reachableOnlyAfterRestart && !restarted) throw new Error('ECONNREFUSED');
        const sha = restarted ? LOCAL_SHA : (opts.staleSha || LOCAL_SHA);
        return { ok: true, json: async () => ({ gitSha: sha }) };
      };
    }

    beforeEach(() => {
      drift._internal.sleep = async () => {}; // never actually wait in tests
    });

    it('a clean checkout, current, Hub matching: a no-op success, nothing run but the read', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 0 });
      drift._internal.execFileAsync = impl;
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.deepEqual(out, { ok: true, fastForwarded: false, restarted: false, snapshot: out.snapshot });
      assert.equal(restartCalled, false, 'nothing to restart for');
      assert.ok(!calls.some((c) => c.includes('merge')), 'nothing to fast-forward');
    });

    it('updateAvailable + clean tree: fast-forwards via git merge --ff-only origin/main, restarts the now-stale Hub, and verifies it comes back reporting the new HEAD', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 3, dirty: false });
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') calls.push('restart-marker');
        return impl(cmd, args);
      };
      drift._internal.fetchImpl = hubStub({ staleSha: UPSTREAM_SHA }, calls);
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, true);
      assert.equal(out.fastForwarded, true);
      assert.equal(out.restarted, true, 'the checkout just moved, so the reachable Hub is restarted even though it matched the OLD HEAD');
      assert.equal(out.snapshot.hubRestartNeeded, false, 'verified: the Hub now reports the new HEAD, not just that a command ran');
      assert.ok(calls.some((c) => c === 'merge --ff-only origin/main'));
      assert.equal(restartCalled, true);
    });

    it('a dirty checkout refuses outright: never merges, never discards', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 3, dirty: true });
      drift._internal.execFileAsync = impl;
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'dirty-tree');
      assert.equal(out.fastForwarded, false);
      assert.ok(!calls.some((c) => c.includes('merge')), 'never attempted');
      assert.equal(restartCalled, false, 'never reached');
    });

    it('a non-fast-forwardable merge refuses, naming the git error; nothing restarts', async () => {
      drift._internal.pathExists = () => true;
      const { impl } = gitStub({ commitsBehind: 3, dirty: false, failMerge: true });
      drift._internal.execFileAsync = impl;
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'not-fast-forwardable');
      assert.match(out.error, /fast-forward/);
      assert.equal(restartCalled, false);
    });

    it('hubRestartNeeded alone (checkout already current): restarts, never merges, and verifies the new sha', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 0 });
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') calls.push('restart-marker');
        return impl(cmd, args);
      };
      drift._internal.fetchImpl = hubStub({ staleSha: UPSTREAM_SHA }, calls); // disagrees with LOCAL_SHA until "restarted"
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, true);
      assert.equal(out.fastForwarded, false);
      assert.equal(out.restarted, true);
      assert.ok(!calls.some((c) => c.includes('merge')));
    });

    it('a Hub that was unreachable before this action is still restarted after a fast-forward, not skipped (#2956 R-Gate R2)', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 2, dirty: false });
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') calls.push('restart-marker');
        return impl(cmd, args);
      };
      // Unreachable until the restart command actually runs -- a Hub that
      // was simply down, which `launchctl kickstart`/`systemctl restart`
      // both START, not merely restart.
      drift._internal.fetchImpl = hubStub({ reachableOnlyAfterRestart: true }, calls);
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, true);
      assert.equal(out.fastForwarded, true);
      assert.equal(out.restarted, true, 'attempted even though the Hub read unreachable beforehand');
      assert.equal(out.snapshot.hub.reachable, true, 'verified: the Hub actually came back up');
      assert.ok(calls.some((c) => c === 'merge --ff-only origin/main'));
      assert.equal(restartCalled, true);
    });

    it('restarted, but the Hub never actually comes back up: reported as a failure, never a false ok:true', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 2, dirty: false });
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') calls.push('restart-marker');
        return impl(cmd, args);
      };
      // Permanently unreachable: the restart command "succeeds" (no throw)
      // but the Hub process itself never actually comes back.
      drift._internal.fetchImpl = hubStub({ neverReachable: true }, calls);
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'restart-unverified');
      assert.equal(out.fastForwarded, true, 'the fast-forward itself still succeeded');
      assert.equal(out.restarted, true, 'the restart command itself still ran without throwing');
      assert.match(out.error, /not answering/);
      assert.equal(restartCalled, true);
    });

    it('restarted and reachable, but still reporting the OLD sha after every retry: reported as a failure', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 2, dirty: false });
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') calls.push('restart-marker');
        return impl(cmd, args);
      };
      // Always reachable, but the stubbed "restart" never actually changes
      // what the Hub reports -- simulates a Hub that restarted onto the
      // SAME stale build (e.g. a launchd job pinned to an old binary).
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: UPSTREAM_SHA }) });
      drift._internal.restartHubCommand = () => ({ cmd: 'true', args: [] });
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'restart-unverified');
      assert.equal(out.restarted, true);
      assert.match(out.error, /does not match/);
    });

    it('a failed restart command is reported, with the fast-forward (if any) still reflected', async () => {
      drift._internal.pathExists = () => true;
      const { impl } = gitStub({ commitsBehind: 1, dirty: false });
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd === 'launchctl') throw new Error('No such process');
        return impl(cmd, args);
      };
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      drift._internal.restartHubCommand = () => ({ cmd: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.medusa.hub'] });
      // No LaunchAgent plist (#3048), so the precheck passes and the command
      // itself runs and fails -- never this host's real plist.
      drift._internal.fileExists = () => false;
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'restart-failed');
      assert.equal(out.fastForwarded, true, 'the fast-forward itself already succeeded before the restart failed');
      assert.match(out.error, /No such process/);
    });

    it('verification requires a positive gitSha match, not just the absence of a detected mismatch: a pre-#70 Hub (gitSha unknown) after a restart reports restart-unverified, never a false ok:true (#2956 R-Gate R3)', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 1, dirty: false });
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') calls.push('restart-marker');
        return impl(cmd, args);
      };
      // Reachable throughout, but never reports a gitSha at all -- a Hub
      // predating Jason-Vaughan/Medusa#70. hubRestartNeeded's plain
      // comparison reads false for this (can't detect a mismatch it can't
      // see), which must NOT be read as "verified current".
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({}) });
      drift._internal.restartHubCommand = () => ({ cmd: 'true', args: [] });
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'restart-unverified');
      assert.equal(out.fastForwarded, true);
      assert.equal(out.restarted, true);
      assert.equal(out.snapshot.hub.reachable, true);
      assert.equal(out.snapshot.hub.gitSha, null);
      assert.match(out.error, /does not report its own gitSha/);
    });

    it('a restart left unverified by one applyDriftAction call is retried by the next, instead of a silent no-op success (#2956 R-Gate R3, persistent _restartPending)', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 0 });
      let restartCount = 0;
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') { restartCount += 1; calls.push('restart-marker'); }
        return impl(cmd, args);
      };
      // Click 1 sees a REAL mismatch (ordinary trigger). Once a restart has
      // run once, the Hub stops reporting any gitSha at all -- simulating
      // a Hub that came back up but can no longer be compared, which a
      // fresh, isolated check could misread as "nothing to do".
      drift._internal.fetchImpl = async () => {
        if (restartCount > 0) return { ok: true, json: async () => ({}) };
        return { ok: true, json: async () => ({ gitSha: UPSTREAM_SHA }) };
      };
      drift._internal.restartHubCommand = () => ({ cmd: 'true', args: [] });

      const first = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(first.ok, false);
      assert.equal(first.code, 'restart-unverified');
      assert.equal(first.fastForwarded, false);
      assert.equal(restartCount, 1);

      const second = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(second.restarted, true, 'retried, not a silent no-op success, even though a fresh plain comparison alone reads nothing to do (gitSha now unknown)');
      assert.equal(restartCount, 2);
    });

    it('_restartPending clears once a fresh check proves the Hub reachable and reporting the checkout\'s own current gitSha', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 0 });
      let restartCount = 0;
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') { restartCount += 1; calls.push('restart-marker'); }
        return impl(cmd, args);
      };
      // Click 1: mismatch, restart "succeeds" but the mock never updates
      // its own reported sha (same unverified shape as the dedicated
      // restart-unverified test above).
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: UPSTREAM_SHA }) });
      drift._internal.restartHubCommand = () => ({ cmd: 'true', args: [] });
      const first = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(first.code, 'restart-unverified');

      // Between clicks, the Hub actually catches up on its own (e.g. an
      // operator-triggered restart outside this action).
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      const cleared = await drift.getDrift({ force: true, checkoutPath: '/fake/Medusa-PM' });
      assert.equal(cleared.hubRestartNeeded, false, '_restartPending must not keep flagging once genuinely confirmed current');

      const second = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(second.restarted, false, 'nothing pending any more, so this click is a true no-op');
    });

    it('a restart-unverified result is reflected immediately, in its own returned snapshot AND in the cache a non-force getDrift() reads next (#2956 R-Gate R4)', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 1, dirty: false });
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') calls.push('restart-marker');
        return impl(cmd, args);
      };
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({}) }); // reachable, gitSha unknown throughout
      drift._internal.restartHubCommand = () => ({ cmd: 'true', args: [] });

      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.code, 'restart-unverified');
      assert.equal(out.snapshot.hubRestartNeeded, true, 'the RETURNED snapshot must not still read false');

      // No force:true, no explicit TTL expiry -- exactly what the
      // dashboard's own periodic/polling read uses, and exactly the stale
      // read the bug let through for up to TTL_MS.
      const polled = await drift.getDrift({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(polled.hubRestartNeeded, true, 'a plain, non-force poll right after must see it too, not a stale cached false');
    });

    it('a restart-failed result (the command itself threw) is also reflected immediately in its own snapshot and the cache (#2956 R-Gate R4)', async () => {
      drift._internal.pathExists = () => true;
      const { impl } = gitStub({ commitsBehind: 1, dirty: false });
      drift._internal.execFileAsync = async (cmd, args) => {
        if (cmd !== 'git') throw new Error('No such process');
        return impl(cmd, args);
      };
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      drift._internal.restartHubCommand = () => ({ cmd: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.medusa.hub'] });

      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.code, 'restart-failed');
      assert.ok(out.snapshot, 'restart-failed now carries a snapshot too, not just an error string');
      assert.equal(out.snapshot.hubRestartNeeded, true);

      const polled = await drift.getDrift({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(polled.hubRestartNeeded, true, 'a plain, non-force poll right after must see it too, not a stale cached false');
    });

    describe('#3048: the dirty-tree check reads tracked changes only, and names them', () => {
      /**
       * Run applyDriftAction against a checkout 3 commits behind with the
       * given `git status` output, a matching Hub, and a no-op restart.
       * @param {object} stubOpts - Passed to gitStub
       * @returns {Promise<{out: object, calls: string[]}>}
       */
      async function applyWithStatus(stubOpts) {
        drift._internal.pathExists = () => true;
        const { impl, calls } = gitStub({ commitsBehind: 3, ...stubOpts });
        drift._internal.execFileAsync = impl;
        drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
        drift._internal.restartHubCommand = () => ({ cmd: 'true', args: [] });
        const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
        return { out, calls };
      }

      it('asks git for tracked changes only, NUL-delimited, so untracked files never block', async () => {
        const { calls } = await applyWithStatus({ status: '' });
        assert.ok(calls.includes('status --porcelain=v1 -z --untracked-files=no'), calls.join(' | '));
      });

      it('changes only under .tangleclaw/ (runtime state) do not block: the checkout fast-forwards', async () => {
        const { out, calls } = await applyWithStatus({ status: ' M .tangleclaw/project.json\0 M .tangleclaw/memories/MEMORY.md\0' });
        assert.equal(out.code, undefined, out.error);
        assert.equal(out.fastForwarded, true);
        assert.ok(calls.includes('merge --ff-only origin/main'));
      });

      it('a tracked change outside .tangleclaw/ refuses, naming the file and the branch, and never merges', async () => {
        const { out, calls } = await applyWithStatus({ status: ' M .tangleclaw/x.json\0M  src/hub.js\0', branch: 'wrap/2026-11-13' });
        assert.equal(out.code, 'dirty-tree');
        assert.match(out.error, /src\/hub\.js/);
        assert.doesNotMatch(out.error, /\.tangleclaw/, 'runtime state is never named as blocking');
        assert.match(out.error, /branch wrap\/2026-11-13/);
        assert.ok(!calls.some((c) => c.includes('merge')));
      });

      it('lists at most five blocking files and counts the rest', async () => {
        const status = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => ` M ${n}.js\0`).join('');
        const { out } = await applyWithStatus({ status });
        assert.equal(out.code, 'dirty-tree');
        assert.match(out.error, /a\.js, b\.js, c\.js, d\.js, e\.js and 2 more/);
        assert.doesNotMatch(out.error, /f\.js/);
      });

      it('a rename entry\'s original path is not read as a separate entry', async () => {
        // -z prints a rename as "R  <new>\0<old>\0": the old path is not a change of its own.
        const clean = await applyWithStatus({ status: 'R  .tangleclaw/new.json\0src/old-name.js\0' });
        assert.equal(clean.out.fastForwarded, true, 'only the new path counts, and it is runtime state');
        const dirty = await applyWithStatus({ status: 'R  src/new-name.js\0.tangleclaw/old.json\0' });
        assert.equal(dirty.out.code, 'dirty-tree');
        assert.match(dirty.out.error, /src\/new-name\.js/);
        assert.doesNotMatch(dirty.out.error, /old\.json/);
      });

      it('a refusal on a detached HEAD says so; an unreadable branch is simply left out', async () => {
        const detached = await applyWithStatus({ status: ' M x.js\0', branch: 'HEAD' });
        assert.match(detached.out.error, /\(branch \(detached HEAD\)\)/);
        const unknown = await applyWithStatus({ status: ' M x.js\0', branch: null });
        assert.equal(unknown.out.code, 'dirty-tree');
        assert.doesNotMatch(unknown.out.error, /branch/);
      });

      it('a non-fast-forwardable merge names the branch along with git\'s own error', async () => {
        const { out } = await applyWithStatus({ status: '', failMerge: true, branch: 'wrap/abc' });
        assert.equal(out.code, 'not-fast-forwardable');
        assert.match(out.error, /branch wrap\/abc/);
        assert.match(out.error, /Not possible to fast-forward/);
      });
    });

    describe('#3048: kickstart -k is refused when the LaunchAgent could not respawn the Hub', () => {
      const PLIST = '/fake/Library/LaunchAgents/com.medusa.hub.plist';

      /**
       * Run applyDriftAction where a restart is owed (the Hub reports a
       * stale sha) and the restart command is the real darwin
       * `launchctl kickstart -k`, against a stubbed plist.
       * @param {object} plist
       * @param {boolean} [plist.exists] - Whether the plist file exists
       * @param {string|Error} [plist.json] - plutil's JSON output, or the error it throws
       * @param {string[]} [plist.dirs] - Directories that exist on disk
       * @param {{cmd: string, args: string[]}} [command] - Override the restart command
       * @returns {Promise<{out: object, ran: string[]}>} `ran` lists every non-git command run
       */
      async function applyWithPlist(plist, command) {
        const dirs = new Set(['/fake/Medusa-PM', ...(plist.dirs || [])]);
        drift._internal.pathExists = (p) => dirs.has(p);
        drift._internal.fileExists = (p) => p === PLIST && plist.exists !== false;
        drift._internal.hubPlistPath = () => PLIST;
        drift._internal.restartHubCommand = () => command || { cmd: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.medusa.hub'] };
        const { impl, calls } = gitStub({ commitsBehind: 0 });
        const ran = [];
        drift._internal.execFileAsync = async (cmd, args) => {
          if (cmd === 'plutil') {
            ran.push(`plutil ${args.join(' ')}`);
            if (plist.json instanceof Error) throw plist.json;
            return { stdout: plist.json };
          }
          if (cmd !== 'git') { ran.push(`${cmd} ${args.join(' ')}`); calls.push('restart-marker'); }
          return impl(cmd, args);
        };
        drift._internal.fetchImpl = hubStub({ staleSha: UPSTREAM_SHA }, calls);
        const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
        return { out, ran };
      }

      it('a WorkingDirectory that no longer exists refuses with restart-failed, never runs kickstart, and keeps the restart owed', async () => {
        const { out, ran } = await applyWithPlist({ json: JSON.stringify({ Label: 'com.medusa.hub', WorkingDirectory: '/gone/Medusa' }) });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'restart-failed');
        assert.equal(out.restarted, false);
        assert.match(out.error, /WorkingDirectory to \/gone\/Medusa, which does not exist/);
        assert.match(out.error, /left alone/);
        assert.ok(!ran.some((c) => c.startsWith('launchctl')), `kickstart must not run: ${ran.join(' | ')}`);
        assert.equal(out.snapshot.hubRestartNeeded, true, 'the restart is still owed');
        assert.equal((await drift.getDrift()).hubRestartNeeded, true, 'and the cache says so too');
      });

      it('reads the plist through plutil as JSON, so XML and binary plists both work', async () => {
        const { ran } = await applyWithPlist({ json: JSON.stringify({ WorkingDirectory: '/gone' }) });
        assert.deepEqual(ran, [`plutil -convert json -o - ${PLIST}`]);
      });

      it('an existing WorkingDirectory lets kickstart -k run', async () => {
        const { out, ran } = await applyWithPlist({ json: JSON.stringify({ WorkingDirectory: '/real/Medusa-PM' }), dirs: ['/real/Medusa-PM'] });
        assert.equal(out.ok, true, out.error);
        assert.equal(out.restarted, true);
        assert.ok(ran.includes('launchctl kickstart -k gui/501/com.medusa.hub'));
      });

      it('no plist at all, or one declaring no WorkingDirectory, lets kickstart -k run', async () => {
        const none = await applyWithPlist({ exists: false });
        assert.equal(none.out.restarted, true, none.out.error);
        assert.ok(!none.ran.some((c) => c.startsWith('plutil')), 'no file, nothing to read');
        const noKey = await applyWithPlist({ json: JSON.stringify({ Label: 'com.medusa.hub' }) });
        assert.equal(noKey.out.restarted, true, noKey.out.error);
      });

      it('a plist that exists but cannot be read as a job dictionary is refused, never guessed at', async () => {
        const cases = [
          { json: new Error('Invalid object in plist for JSON format'), why: /Invalid object in plist/ },
          { json: 'not json', why: /could not read/ },
          { json: JSON.stringify('garbage'), why: /root is not a dictionary/ },
          { json: JSON.stringify([1]), why: /root is not a dictionary/ },
          { json: JSON.stringify({ WorkingDirectory: 7 }), why: /WorkingDirectory is not a path/ },
          { json: JSON.stringify({ WorkingDirectory: '' }), why: /WorkingDirectory is not a path/ }
        ];
        for (const c of cases) {
          drift.stop();
          const { out, ran } = await applyWithPlist({ json: c.json });
          assert.equal(out.code, 'restart-failed', String(c.json));
          assert.match(out.error, c.why);
          assert.ok(!ran.some((r) => r.startsWith('launchctl')), `kickstart must not run for ${String(c.json)}`);
        }
      });

      it('only launchctl kickstart -k is checked: systemctl never reads the plist', async () => {
        const { out, ran } = await applyWithPlist({ json: JSON.stringify({ WorkingDirectory: '/gone' }) },
          { cmd: 'systemctl', args: ['--user', 'restart', 'medusa-hub.service'] });
        assert.equal(out.restarted, true, out.error);
        assert.ok(!ran.some((c) => c.startsWith('plutil')));
      });
    });

    it('exposes its retry bound and delay as named constants, not a magic number buried in the loop', () => {
      assert.equal(typeof drift.HUB_RESTART_VERIFY_ATTEMPTS, 'number');
      assert.ok(drift.HUB_RESTART_VERIFY_ATTEMPTS >= 1);
      assert.equal(typeof drift.HUB_RESTART_VERIFY_DELAY_MS, 'number');
    });
  });

  describe('checkoutPath', () => {
    const realEnv = process.env.MEDUSA_CHECKOUT_PATH;
    afterEach(() => {
      if (realEnv === undefined) delete process.env.MEDUSA_CHECKOUT_PATH;
      else process.env.MEDUSA_CHECKOUT_PATH = realEnv;
    });

    it('honors MEDUSA_CHECKOUT_PATH when set', () => {
      process.env.MEDUSA_CHECKOUT_PATH = '/custom/medusa';
      assert.equal(drift.checkoutPath(), '/custom/medusa');
    });

    it('defaults to a sibling "Medusa-PM" directory next to wherever this repo is checked out', () => {
      delete process.env.MEDUSA_CHECKOUT_PATH;
      assert.equal(drift.checkoutPath(), drift.DEFAULT_CHECKOUT_PATH);
      assert.equal(require('node:path').basename(drift.DEFAULT_CHECKOUT_PATH), 'Medusa-PM');
    });
  });
});
