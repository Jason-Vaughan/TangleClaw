'use strict';

/*
 * #1678 — every related session shows the same upstream target.
 *
 * The composition is where the acceptance gate lives: two clones of one
 * repository must read the same observed SHA; a project with no remote is
 * related only through a group that names exactly one repository; the
 * install's own project, and only it, carries running-versus-disk; and the
 * prime line says unknown as unknown. Git is stubbed per directory, the store
 * is a throwaway one.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const cs = require('../lib/checkout-state');
const uo = require('../lib/upstream-observer');
const cf = require('../lib/checkout-freshness');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const ON = { behindOriginCheckEnabled: true };

/**
 * Porcelain v2 `-z` status output for a branch with optional entries.
 * @param {string} oid
 * @param {string} head
 * @param {string[]} [entries]
 * @returns {string}
 */
function statusOut(oid, head, entries = []) {
  return [`# branch.oid ${oid}`, `# branch.head ${head}`, ...entries].join('\0') + '\0';
}

/**
 * A fake git answering per working directory. `repos[dir]` describes one
 * clone: its status output (or an Error), its origin URL (or an Error), the
 * commits it has, and ls-remote's answer.
 * @param {Object<string, object>} repos
 * @returns {{execFile: Function, calls: Array<{dir: string, args: string[]}>}}
 */
function fakeRepos(repos) {
  const calls = [];
  const execFile = (file, args, options, cb) => {
    const dir = options.cwd;
    const a = args.slice(1); // drop --no-optional-locks
    calls.push({ dir, args: a });
    const r = repos[dir] || {};
    let out;
    switch (a[0]) {
      case 'status': out = r.status; break;
      case 'remote': out = r.origin; break;
      case 'rev-parse': {
        const want = a[a.length - 1].replace(/\^\{commit\}$/, '');
        if (want === 'origin/main') out = r.localOriginMain ? `${r.localOriginMain}\n` : Object.assign(new Error('x'), { code: 1 });
        else out = (r.has || []).includes(want) ? `${want}\n` : Object.assign(new Error('x'), { code: 1 });
        break;
      }
      case 'rev-list': out = r.leftRight || '0\t0\n'; break;
      case 'ls-remote': out = r.lsRemote; break;
      default: out = Object.assign(new Error(`unexpected git ${a[0]}`), { code: 128 });
    }
    setImmediate(() => (out instanceof Error ? cb(out, '') : cb(null, out === undefined ? '' : out)));
  };
  return { execFile, calls };
}

describe('checkout-freshness', () => {
  let tmp;
  const saved = {};

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-checkout-freshness-'));
    store._setBasePath(tmp);
    store.init();
    saved.csExec = cs._internal.execFile;
    saved.uoExec = uo._internal.execFile;
    saved.installRoot = cf._internal.installRoot;
    saved.startupSha = cf._internal.startupSha;
    saved.activeSession = cf._internal.activeSession;
    saved.now = cf._internal.now;
  });

  after(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    cs._reset();
    uo._reset();
    cf._internal.installRoot = () => '/nowhere';
    cf._internal.startupSha = () => null;
    cf._internal.activeSession = () => null;
  });

  afterEach(() => {
    cs._internal.execFile = saved.csExec;
    uo._internal.execFile = saved.uoExec;
    cf._internal.installRoot = saved.installRoot;
    cf._internal.startupSha = saved.startupSha;
    cf._internal.activeSession = saved.activeSession;
    cf._internal.now = saved.now;
    cs._reset();
    uo._reset();
  });

  let seq = 0;
  /**
   * A registered project at a fresh fake path.
   * @param {string} label
   * @returns {object} Store row.
   */
  function project(label) {
    seq += 1;
    return store.projects.create({ name: `${label}-${seq}`, path: `/clones/${label}-${seq}` });
  }

  /**
   * Install the fake on both seams and warm every cache the way the launch
   * route does, then read the composed block.
   * @param {object} p - Store row.
   * @param {object} fake
   * @param {object} [config]
   * @returns {Promise<object>}
   */
  async function warmAndRead(p, fake, config = ON) {
    cs._internal.execFile = fake.execFile;
    uo._internal.execFile = fake.execFile;
    await cf.refreshForLaunch(p, config, 2000);
    return cf.projectCheckout(p, { config });
  }

  it('two clones of one repository read the same observed upstream, from one remote call', async () => {
    const a = project('clone-a');
    const b = project('clone-b');
    const fake = fakeRepos({
      [a.path]: { status: statusOut(SHA_A, 'main'), origin: 'git@github.com:O/R.git\n', has: [SHA_A, SHA_B], lsRemote: `${SHA_B}\trefs/heads/main\n`, leftRight: '0\t1\n' },
      [b.path]: { status: statusOut(SHA_B, 'feat/x'), origin: 'https://github.com/O/R\n', has: [SHA_B], lsRemote: `${SHA_B}\trefs/heads/main\n` }
    });
    const ca = await warmAndRead(a, fake);
    const cb = await warmAndRead(b, fake);
    assert.equal(ca.upstream.identity, 'github.com/O/R');
    assert.equal(ca.upstream.sha, SHA_B);
    assert.equal(cb.upstream.sha, ca.upstream.sha, 'both sessions name the same upstream target');
    assert.equal(ca.upstream.observedAt, cb.upstream.observedAt, 'and the same observation');
    assert.equal(fake.calls.filter((c) => c.args[0] === 'ls-remote').length, 1, 'one observation per repository');
    assert.deepEqual(ca.vsUpstream, { ahead: 0, behind: 1, relation: 'behind', reason: null });
    assert.equal(cb.vsUpstream.relation, 'equal');
    assert.equal(ca.upstream.via, 'origin');
  });

  it('a clone that has not fetched the observed commit is behind by an unknown count', async () => {
    const a = project('stale');
    const fake = fakeRepos({
      [a.path]: { status: statusOut(SHA_A, 'main'), origin: 'git@github.com:O/S.git\n', has: [SHA_A], lsRemote: `${SHA_C}\trefs/heads/main\n` }
    });
    const c = await warmAndRead(a, fake);
    assert.equal(c.vsUpstream.relation, 'behind-unknown');
    assert.equal(c.vsUpstream.behind, null);
    assert.ok(!fake.calls.some((x) => x.args[0] === 'fetch'), 'nothing is fetched into the session\'s clone');
  });

  it('with the check off no remote call is made and the comparison is unknown, not level', async () => {
    const a = project('off');
    const fake = fakeRepos({ [a.path]: { status: statusOut(SHA_A, 'main'), origin: 'git@github.com:O/T.git\n', has: [SHA_A] } });
    const c = await warmAndRead(a, fake, { behindOriginCheckEnabled: false });
    assert.equal(c.upstream.state, 'disabled');
    assert.equal(c.vsUpstream.relation, 'unknown');
    assert.equal(fake.calls.filter((x) => x.args[0] === 'ls-remote').length, 0);
  });

  describe('a project with no remote (D7)', () => {
    /**
     * A group of the given members.
     * @param {object[]} members
     * @returns {object}
     */
    function group(members) {
      seq += 1;
      const g = store.projectGroups.create({ name: `g-${seq}` });
      for (const m of members) store.projectGroups.addMember(g.id, m.id);
      return g;
    }

    it('is related through a group whose other members share one repository, with no comparison', async () => {
      const advisor = project('advisor');
      const a = project('repo-a');
      const b = project('repo-b');
      const g = group([advisor, a, b]);
      const fake = fakeRepos({
        [advisor.path]: { status: Object.assign(new Error('x'), { stderr: 'fatal: not a git repository' }) },
        [a.path]: { status: statusOut(SHA_A, 'main'), origin: 'git@github.com:O/U.git\n', lsRemote: `${SHA_A}\trefs/heads/main\n` },
        [b.path]: { status: statusOut(SHA_A, 'main'), origin: 'https://github.com/O/U.git\n' }
      });
      cs._internal.execFile = fake.execFile;
      uo._internal.execFile = fake.execFile;
      await Promise.all([cs.refresh(a.path), cs.refresh(b.path), cs.refresh(advisor.path)]);
      await uo.refresh('github.com/O/U', { dir: a.path, name: a.name });
      const c = cf.projectCheckout(advisor, { config: ON });
      assert.equal(c.state, 'no-git');
      assert.equal(c.upstream.via, 'group');
      assert.equal(c.upstream.groupName, g.name);
      assert.equal(c.upstream.identity, 'github.com/O/U');
      assert.equal(c.upstream.sha, SHA_A);
      assert.equal(c.vsUpstream.relation, 'not-compared');
      assert.match(cf.primeLines(c)[0], /not a git checkout; related repo github\.com\/O\/U \(via group g-\d+\)/);
    });

    it('is related to nothing when its group names two repositories', async () => {
      const advisor = project('advisor2');
      const a = project('two-a');
      const b = project('two-b');
      group([advisor, a, b]);
      const fake = fakeRepos({
        [advisor.path]: { status: statusOut(SHA_A, 'main'), origin: Object.assign(new Error('x'), { code: 2, stderr: "error: No such remote 'origin'" }) },
        [a.path]: { status: statusOut(SHA_A, 'main'), origin: 'git@github.com:O/One.git\n' },
        [b.path]: { status: statusOut(SHA_A, 'main'), origin: 'git@github.com:O/Two.git\n' }
      });
      cs._internal.execFile = fake.execFile;
      await Promise.all([cs.refresh(a.path), cs.refresh(b.path), cs.refresh(advisor.path)]);
      const c = cf.projectCheckout(advisor, { config: ON });
      assert.equal(c.upstream.via, null);
      assert.equal(c.upstream.identity, null);
      assert.equal(c.upstream.sha, null);
    });

    it('is not related while a member is unread, because it could name a second repository', async () => {
      const advisor = project('advisor3');
      const a = project('read-a');
      const unread = project('unread');
      group([advisor, a, unread]);
      const fake = fakeRepos({
        [advisor.path]: { status: Object.assign(new Error('x'), { stderr: 'fatal: not a git repository' }) },
        [a.path]: { status: statusOut(SHA_A, 'main'), origin: 'git@github.com:O/V.git\n' }
      });
      cs._internal.execFile = fake.execFile;
      await Promise.all([cs.refresh(a.path), cs.refresh(advisor.path)]);
      const c = cf.projectCheckout(advisor, { config: ON });
      assert.equal(c.upstream.state, 'pending');
      assert.equal(c.upstream.via, null);
    });

    it('an unreadable clone is never related through a group', async () => {
      const broken = project('broken');
      const a = project('ok-a');
      group([broken, a]);
      const fake = fakeRepos({
        [broken.path]: { status: Object.assign(new Error('x'), { stderr: 'fatal: index file corrupt' }) },
        [a.path]: { status: statusOut(SHA_A, 'main'), origin: 'git@github.com:O/W.git\n' }
      });
      cs._internal.execFile = fake.execFile;
      await Promise.all([cs.refresh(a.path), cs.refresh(broken.path)]);
      const c = cf.projectCheckout(broken, { config: ON });
      assert.equal(c.state, 'unknown');
      assert.equal(c.upstream.via, null);
      assert.equal(c.upstream.state, 'unknown');
    });
  });

  it('only the install\'s own project carries running-versus-disk, and names the owning session', async () => {
    const install = project('install');
    const other = project('other');
    const fake = fakeRepos({
      [install.path]: { status: statusOut(SHA_B, 'main'), origin: 'git@github.com:O/X.git\n', has: [SHA_B], lsRemote: `${SHA_B}\trefs/heads/main\n` },
      [other.path]: { status: statusOut(SHA_B, 'main'), origin: 'git@github.com:O/X.git\n', has: [SHA_B] }
    });
    cf._internal.installRoot = () => install.path;
    cf._internal.startupSha = () => SHA_A;
    cf._internal.activeSession = (id) => (id === install.id ? { id: 77 } : null);
    const ci = await warmAndRead(install, fake);
    const co = await warmAndRead(other, fake);
    assert.equal(co.runtime, null);
    assert.equal(ci.runtime.startupSha, SHA_A);
    assert.equal(ci.runtime.currentDiskSha, SHA_B);
    assert.equal(ci.runtime.isStale, true);
    assert.ok(ci.runtime.restartImpact, 'a stale install asks what a restart would load');
    assert.deepEqual(ci.owner, { project: install.name, sessionId: 77 });
    assert.deepEqual(co.owner, { project: other.name, sessionId: null });
  });

  describe('prime line', () => {
    const NOW = Date.parse('2026-09-22T12:00:00Z');
    /**
     * A measured checkout block with overrides.
     * @param {object} over
     * @returns {object}
     */
    function block(over = {}) {
      return {
        state: 'measured', reason: null, branch: 'main', detached: false, tag: null, headSha: SHA_A,
        dirtyTracked: 0, untracked: 0,
        upstream: { identity: 'github.com/O/R', via: 'origin', state: 'measured', sha: SHA_B, observedAt: new Date(NOW - 4 * 60000).toISOString(), observedFrom: 'P', reason: null },
        vsUpstream: { ahead: 0, behind: 0, relation: 'equal', reason: null },
        runtime: null,
        ...over
      };
    }
    beforeEach(() => { cf._internal.now = () => NOW; });

    it('names branch, HEAD, the relation to the observed upstream with its age, and the tree', () => {
      const [line] = cf.primeLines(block({
        branch: 'feat/x', dirtyTracked: 1, untracked: 2,
        vsUpstream: { ahead: 2, behind: 3, relation: 'diverged', reason: null }
      }));
      assert.equal(line, '_Checkout: feat/x @aaaaaaa, 2 ahead / 3 behind origin/main @bbbbbbb (observed 4m ago via P); 1 uncommitted, 2 untracked._');
    });

    it('never renders an unmeasured or failed state as clean or level', () => {
      assert.match(cf.primeLines(block({ state: 'pending' }))[0], /not measured yet — unknown, not clean/);
      assert.match(cf.primeLines(block({ state: 'unknown', reason: 'git status: timed out' }))[0], /\*\*unknown\*\* — git status: timed out/);
      assert.match(cf.primeLines(block({ dirtyTracked: null, untracked: null }))[0], /working tree unknown/);
      const noUp = cf.primeLines(block({
        upstream: { identity: 'github.com/O/R', via: 'origin', state: 'unknown', sha: null, observedAt: null, reason: 'git ls-remote: timed out' },
        vsUpstream: { ahead: null, behind: null, relation: 'unknown', reason: 'git ls-remote: timed out' }
      }))[0];
      assert.match(noUp, /vs origin\/main: unknown \(git ls-remote: timed out\)/);
      assert.ok(!/level with/.test(noUp));
      assert.match(cf.primeLines(block({
        upstream: { via: 'origin', state: 'disabled', sha: null },
        vsUpstream: { relation: 'unknown', reason: 'check turned off' }
      }))[0], /upstream not observed: the behind-origin check is turned off/);
      assert.match(cf.primeLines(block({ vsUpstream: { relation: 'behind-unknown', reason: 'upstream commit not fetched here' } }))[0],
        /behind origin\/main @bbbbbbb \(observed 4m ago via P\), count unknown: upstream commit not fetched here/);
      assert.match(cf.primeLines(null)[0], /unknown/);
    });

    it('adds the running-versus-disk line for the install, with the restart impact', () => {
      const lines = cf.primeLines(block({
        runtime: { startupSha: SHA_A, currentDiskSha: SHA_B, isStale: true, restartImpact: { impact: 'records-only' } }
      }));
      assert.equal(lines[1], '_Server: running aaaaaaa, disk bbbbbbb — records-only, no restart needed._');
      assert.match(cf.primeLines(block({ runtime: { startupSha: SHA_A, currentDiskSha: SHA_B, isStale: true, restartImpact: { impact: 'unknown' } } }))[1],
        /restart impact unknown/);
      assert.match(cf.primeLines(block({ runtime: { startupSha: SHA_A, currentDiskSha: SHA_A, isStale: false, restartImpact: null } }))[1],
        /running the on-disk commit aaaaaaa/);
      const noStart = cf.primeLines(block({ runtime: { startupSha: null, currentDiskSha: SHA_A, isStale: null, restartImpact: null } }))[1];
      assert.equal(noStart, '_Server: the commit it started on is unknown — restart impact unknown._', 'never "running ?"');
      assert.match(cf.primeLines(block({ runtime: { startupSha: SHA_A, currentDiskSha: null, isStale: null, restartImpact: null } }))[1],
        /running aaaaaaa, on-disk commit unknown — restart impact unknown/);
    });

    it('a detached HEAD says whether it is at a tag', () => {
      assert.match(cf.primeLines(block({ detached: true, branch: null, tag: 'v5.24.0' }))[0], /detached at tag v5\.24\.0 @aaaaaaa/);
      assert.match(cf.primeLines(block({ detached: true, branch: null, tag: null }))[0], /detached \(no tag\)/);
    });
  });

  it('the launch warm-up is bounded and never rejects', async () => {
    const a = project('hang');
    cs._internal.execFile = () => {}; // never answers
    const t0 = Date.now();
    await cf.refreshForLaunch(a, ON, 50);
    assert.ok(Date.now() - t0 < 1000);
  });
});
