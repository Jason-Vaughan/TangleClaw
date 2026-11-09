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
     * unless `dirty` is set, and every other call (merge, fetch) is recorded
     * in `calls` and succeeds unless `fail` names it.
     * @param {object} [opts]
     * @returns {{impl: Function, calls: string[]}}
     */
    function gitStub(opts = {}) {
      const calls = [];
      const commitsBehind = opts.commitsBehind || 0;
      const impl = async (cmd, args) => {
        calls.push(args.join(' '));
        if (cmd !== 'git') return { stdout: '' }; // the restart command, recorded but not git
        if (args.includes('rev-parse')) return { stdout: `${LOCAL_SHA}\n` };
        if (args.includes('rev-list')) return { stdout: `${commitsBehind}\n` };
        if (args.includes('status')) return { stdout: opts.dirty ? ' M some-file.js\n' : '' };
        if (args.includes('merge')) {
          if (opts.failMerge) throw new Error('fatal: Not possible to fast-forward');
          return { stdout: '' };
        }
        if (args.includes('fetch')) return { stdout: '' };
        throw new Error(`unexpected git ${args.join(' ')}`);
      };
      return { impl, calls };
    }

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

    it('updateAvailable + clean tree: fast-forwards via git merge --ff-only origin/main, then restarts the now-stale Hub', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 3, dirty: false });
      drift._internal.execFileAsync = impl;
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: LOCAL_SHA }) });
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, true);
      assert.equal(out.fastForwarded, true);
      assert.equal(out.restarted, true, 'the checkout just moved, so the reachable Hub is restarted even though it matched the OLD HEAD');
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

    it('hubRestartNeeded alone (checkout already current): restarts, never merges', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 0 });
      drift._internal.execFileAsync = impl;
      drift._internal.fetchImpl = async () => ({ ok: true, json: async () => ({ gitSha: UPSTREAM_SHA }) }); // disagrees with LOCAL_SHA
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, true);
      assert.equal(out.fastForwarded, false);
      assert.equal(out.restarted, true);
      assert.ok(!calls.some((c) => c.includes('merge')));
    });

    it('an unreachable Hub: still fast-forwards when behind, but never attempts a restart', async () => {
      drift._internal.pathExists = () => true;
      const { impl, calls } = gitStub({ commitsBehind: 2, dirty: false });
      drift._internal.execFileAsync = impl;
      drift._internal.fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
      let restartCalled = false;
      drift._internal.restartHubCommand = () => { restartCalled = true; return { cmd: 'true', args: [] }; };
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, true);
      assert.equal(out.fastForwarded, true);
      assert.equal(out.restarted, false, 'nothing reachable to restart');
      assert.ok(calls.some((c) => c === 'merge --ff-only origin/main'));
      assert.equal(restartCalled, false);
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
      const out = await drift.applyDriftAction({ checkoutPath: '/fake/Medusa-PM' });
      assert.equal(out.ok, false);
      assert.equal(out.code, 'restart-failed');
      assert.equal(out.fastForwarded, true, 'the fast-forward itself already succeeded before the restart failed');
      assert.match(out.error, /No such process/);
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
