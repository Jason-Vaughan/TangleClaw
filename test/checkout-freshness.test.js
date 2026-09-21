'use strict';

/*
 * #993 — the live install's checkout says what it is serving.
 *
 * Local facts are read from REAL temporary git repositories with a bare
 * "origin", through the unguarded runner (`runGit`) installed at the module's
 * seam: parsing porcelain output against strings alone would pass against a
 * shape git does not print. The assessment is driven with hand-built origin
 * observations so every evidence state is covered without a network.
 *
 * The dashboard half lifts `renderLiveCheckoutBanner` out of public/landing.js
 * and runs it against a DOM stub, the behind-origin.test.js approach.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const cf = require('../lib/checkout-freshness');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir()
};

/**
 * Run git synchronously in `cwd` for fixture setup.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string} stdout, trimmed.
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Commit a file with the given content.
 * @param {string} dir
 * @param {string} name
 * @param {string} content
 * @returns {string} The new HEAD SHA.
 */
function commitFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, 'add', name);
  git(dir, 'commit', '-q', '-m', `add ${name}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * A bare origin with one commit on main, and a clone of it tracking origin/main.
 * @param {string} root - Temp directory to build in.
 * @param {string} name - Fixture name.
 * @returns {{origin: string, clone: string}}
 */
function makeClone(root, name) {
  const origin = path.join(root, `${name}-origin.git`);
  const seed = path.join(root, `${name}-seed`);
  const clone = path.join(root, `${name}-clone`);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', seed);
  commitFile(seed, 'README.md', 'seed\n');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, clone);
  return { origin, clone };
}

/**
 * A fresh origin observation of `sha` against origin at `originSha`.
 * @param {object} fields - Overrides.
 * @returns {object}
 */
function observed(fields) {
  return {
    upstreamRef: 'origin/main', evidence: 'fresh', reason: null, originMainSha: 'a'.repeat(40),
    headSha: null, ahead: 0, behind: 0, relation: 'equal', checkedAt: '2026-09-21T00:00:00.000Z', ...fields
  };
}

describe('lib/checkout-freshness (#993)', () => {
  let tmp;
  const origGit = cf._internal.git;

  // Resolved: on macOS the temp dir sits behind /var → /private/var.
  before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-checkout-freshness-'))); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => { cf._reset(); cf._internal.git = cf.runGit; });
  afterEach(() => { cf._internal.git = origGit; cf._reset(); });

  describe('parseBranchHeader', () => {
    it('reads branch, upstream and both counts', () => {
      assert.deepEqual(cf.parseBranchHeader('## main...origin/main [ahead 1, behind 2]'),
        { branch: 'main', detached: false, upstream: 'origin/main', ahead: 1, behind: 2, upstreamGone: false });
      assert.deepEqual(cf.parseBranchHeader('## feat/x...origin/feat/x'),
        { branch: 'feat/x', detached: false, upstream: 'origin/feat/x', ahead: 0, behind: 0, upstreamGone: false });
    });

    it('reads a branch with no upstream, a detached HEAD, an unborn branch and a gone upstream', () => {
      assert.deepEqual(cf.parseBranchHeader('## scratch'),
        { branch: 'scratch', detached: false, upstream: null, ahead: null, behind: null, upstreamGone: false });
      assert.equal(cf.parseBranchHeader('## HEAD (no branch)').detached, true);
      assert.equal(cf.parseBranchHeader('## No commits yet on main').branch, 'main');
      const gone = cf.parseBranchHeader('## old...origin/old [gone]');
      assert.equal(gone.upstreamGone, true);
      assert.equal(gone.ahead, null, 'a gone upstream has no counts to report');
    });
  });

  describe('countEntries', () => {
    it('separates untracked paths from tracked changes', () => {
      assert.deepEqual(cf.countEntries([' M a.js', 'A  b.js', '?? c.txt', '?? d/', 'UU e.js', '']),
        { trackedChanges: 3, untracked: 2 });
    });
  });

  describe('readLocal against real repositories', () => {
    it('reads a clean clone on main that is level with origin', async () => {
      const { clone } = makeClone(tmp, 'clean');
      const local = await cf.readLocal(clone);
      assert.equal(local.ok, true);
      assert.equal(local.branch, 'main');
      assert.equal(local.detached, false);
      assert.equal(local.upstream, 'origin/main');
      assert.equal(local.ahead, 0);
      assert.equal(local.trackedChanges, 0);
      assert.equal(local.untracked, 0);
      assert.match(local.headSha, /^[0-9a-f]{40}$/);
    });

    it('reports a feature branch with unpushed commits — the 2026-08-18 state', async () => {
      const { clone } = makeClone(tmp, 'feature');
      git(clone, 'checkout', '-q', '-b', 'feat/x');
      commitFile(clone, 'a.js', '1\n');
      git(clone, 'push', '-q', '-u', 'origin', 'feat/x');
      commitFile(clone, 'b.js', '2\n');
      commitFile(clone, 'c.js', '3\n');
      const local = await cf.readLocal(clone);
      assert.equal(local.branch, 'feat/x');
      assert.equal(local.upstream, 'origin/feat/x');
      assert.equal(local.ahead, 2);
      const codes = cf.assess(local, observed({ headSha: local.headSha, relation: 'ahead', ahead: 3 })).findings.map((f) => f.code);
      assert.ok(codes.includes('not-on-main'));
      assert.ok(codes.includes('unpushed'));
    });

    it('separates tracked changes from untracked files', async () => {
      const { clone } = makeClone(tmp, 'dirty');
      fs.writeFileSync(path.join(clone, 'README.md'), 'edited\n');
      fs.writeFileSync(path.join(clone, 'server.js.orig'), 'scratch\n');
      fs.writeFileSync(path.join(clone, 'notes.txt'), 'scratch\n');
      const local = await cf.readLocal(clone);
      assert.equal(local.trackedChanges, 1);
      assert.equal(local.untracked, 2);
    });

    it('reports a detached HEAD, and whether it sits on a release tag', async () => {
      const { clone } = makeClone(tmp, 'detached');
      const first = git(clone, 'rev-parse', 'HEAD');
      commitFile(clone, 'x.js', 'x\n');
      git(clone, 'checkout', '-q', '--detach', 'HEAD');
      const offTag = await cf.readLocal(clone);
      assert.equal(offTag.detached, true);
      assert.equal(offTag.releaseTag, null);
      assert.equal(offTag.branch, null);

      git(clone, 'tag', 'v1.0.0', first);
      git(clone, 'checkout', '-q', 'v1.0.0');
      const onTag = await cf.readLocal(clone);
      assert.equal(onTag.detached, true);
      assert.equal(onTag.releaseTag, 'v1.0.0');
    });

    it('marks a directory that is not a git checkout as the designed no-git case', async () => {
      const dir = path.join(tmp, 'not-git');
      fs.mkdirSync(dir);
      const local = await cf.readLocal(dir);
      assert.equal(local.ok, false);
      assert.equal(local.notGit, true);
      assert.equal(cf.assess(local, observed({})).status, 'not-a-checkout');
      await cf.refresh(dir);
      assert.deepEqual(cf.primeLines(cf.snapshot(dir, null)), [], 'a tarball install gets no checkout lines');
    });

    it('reports a failed read as unknown with its reason, never as ok', async () => {
      cf._internal.git = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: index file corrupt', error: null,
        errorCode: null, signal: null, timedOut: false });
      const local = await cf.readLocal('/nowhere');
      assert.equal(local.ok, false);
      assert.equal(local.notGit, false);
      const a = cf.assess(local, observed({}));
      assert.equal(a.status, 'unknown');
      assert.match(a.findings[0].text, /could not be read: git status failed: fatal: index file corrupt/);
    });

    it('is read-only: the working tree and index are unchanged by a read', async () => {
      const { clone } = makeClone(tmp, 'readonly');
      // Same content, new mtime: exactly what makes a plain `git status` want
      // to rewrite the index with fresh stat data — the write this guards.
      const past = new Date(Date.now() - 3600 * 1000);
      fs.utimesSync(path.join(clone, 'README.md'), past, past);
      fs.writeFileSync(path.join(clone, 'new.txt'), 'n\n');
      const before = execFileSync('git', ['status', '--porcelain=v1'],
        { cwd: clone, env: { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8' }).trim();
      const indexBefore = fs.readFileSync(path.join(clone, '.git', 'index'));
      await cf.readLocal(clone);
      assert.deepEqual(fs.readFileSync(path.join(clone, '.git', 'index')), indexBefore,
        'GIT_OPTIONAL_LOCKS=0: a banner read must not rewrite the index an agent is committing through');
      assert.equal(execFileSync('git', ['status', '--porcelain=v1'],
        { cwd: clone, env: { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8' }).trim(), before);
    });
  });

  describe('the default runner under the test runner', () => {
    it('spawns nothing — a route test must not run git in the developer checkout', async () => {
      cf._internal.git = origGit;
      assert.ok(process.env.NODE_TEST_CONTEXT);
      const local = await cf.readLocal(tmp);
      assert.equal(local.ok, false);
      assert.match(local.reason, /could not run \(BLOCKED\)/);
    });
  });

  describe('assess — the origin half', () => {
    const local = { repoRoot: '/r', ok: true, notGit: false, headSha: 'b'.repeat(40), branch: 'main', detached: false,
      releaseTag: null, upstream: 'origin/main', ahead: 0, behind: 0, upstreamGone: false, trackedChanges: 0, untracked: 0 };

    it('is ok only with a fresh observation of this HEAD that finds nothing wrong', () => {
      const a = cf.assess(local, observed({ headSha: local.headSha }));
      assert.equal(a.status, 'ok');
      assert.deepEqual(a.findings, []);
    });

    it('never reports current without an observation — pending and unavailable are unknown', () => {
      const pending = cf.assess(local, observed({ evidence: 'pending', reason: 'x', originMainSha: null, relation: null }));
      assert.equal(pending.status, 'unknown');
      assert.match(pending.findings[0].text, /unknown, not current/);
      const down = cf.assess(local, observed({ evidence: 'unavailable', reason: 'fetch failed: Could not resolve host',
        originMainSha: null, relation: null }));
      assert.equal(down.status, 'unknown');
      assert.match(down.findings[0].text, /could not be observed \(fetch failed: Could not resolve host\)/);
      assert.equal(cf.assess(local, null).status, 'unknown');
    });

    it('does not state a relation measured against a HEAD that has since moved', () => {
      const a = cf.assess(local, observed({ headSha: 'c'.repeat(40), relation: 'equal' }));
      assert.equal(a.status, 'unknown');
      assert.equal(a.findings[0].code, 'origin-outdated');
    });

    it('names behind, ahead and diverged with origin/main\'s SHA', () => {
      const behind = cf.assess(local, observed({ headSha: local.headSha, behind: 2, relation: 'behind' }));
      assert.equal(behind.status, 'attention');
      assert.match(behind.findings[0].text, /2 commits behind origin\/main \(origin\/main is aaaaaaa\)/);
      const diverged = cf.assess(local, observed({ headSha: local.headSha, ahead: 1, behind: 3, relation: 'diverged' }));
      assert.match(diverged.findings[0].text, /Diverged from origin\/main: 1 ahead, 3 behind/);
      const ahead = cf.assess(local, observed({ headSha: local.headSha, ahead: 1, relation: 'ahead' }));
      assert.match(ahead.findings[0].text, /1 commit ahead of origin\/main/);
    });

    it('says a stale observation is stale', () => {
      const a = cf.assess(local, observed({ headSha: local.headSha, evidence: 'stale', reason: 'last observed 20 min ago' }));
      assert.equal(a.status, 'unknown');
      assert.match(a.findings[0].text, /stale: last observed 20 min ago/);
    });

    it('treats a release-tag install as healthy and a disabled check as information, not a fault', () => {
      const tagged = { ...local, branch: null, detached: true, releaseTag: 'v5.29.0', upstream: null };
      assert.equal(cf.assess(tagged, observed({ evidence: 'skipped', relation: null })).status, 'ok');
      const off = cf.assess(local, observed({ evidence: 'disabled', relation: null, originMainSha: null }));
      assert.equal(off.status, 'ok');
      assert.equal(off.findings[0].severity, 'info');
    });

    it('flags a detached HEAD that is not a release tag', () => {
      const detached = { ...local, branch: null, detached: true, releaseTag: null, upstream: null };
      const a = cf.assess(detached, observed({ headSha: local.headSha }));
      assert.equal(a.status, 'attention');
      assert.match(a.findings[0].text, /HEAD is detached at bbbbbbb, not on main, and that commit is not a release tag/);
    });
  });

  describe('snapshot, cache and prime lines', () => {
    it('reads the cache without waiting, and shares one read among concurrent callers', async () => {
      let reads = 0;
      cf._internal.git = async (args) => {
        if (args[0] === 'status') reads++;
        return { exitCode: 0, stdout: args[0] === 'status' ? '## main...origin/main\n' : `${'d'.repeat(40)}\n`,
          stderr: '', error: null, errorCode: null, signal: null, timedOut: false };
      };
      const cold = cf.snapshot('/repo', null);
      assert.equal(cold.local, null, 'a cold cache is not a read');
      assert.equal(cold.status, 'unknown');
      await Promise.all([cf.refresh('/repo'), cf.refresh('/repo')]);
      assert.equal(reads, 1, 'concurrent refreshes share one read');
      const warm = cf.snapshot('/repo', observed({ headSha: 'd'.repeat(40) }));
      assert.equal(warm.status, 'ok');
      assert.match(warm.identity, /Checkout: \/repo — main @ ddddddd; origin\/main aaaaaaa \(fresh, observed /);
    });

    it('prime lines: one quiet line when ok, the findings and a no-action note otherwise, nothing for no-git', () => {
      const ok = cf.primeLines({ status: 'ok', identity: 'Checkout: /r — main @ 1234567', findings: [] });
      assert.equal(ok.length, 2);
      assert.match(ok[0], /Live install checkout: current — \/r — main @ 1234567/);
      const bad = cf.primeLines({ status: 'attention', identity: 'Checkout: /r — x', findings: [{ text: 'A.' }, { text: 'B.' }] });
      assert.match(bad[0], /NEEDS ATTENTION/);
      assert.ok(bad.includes('- A.') && bad.includes('- B.'));
      assert.ok(bad.some((l) => /do not pull, check out, stash or restart/.test(l)),
        'facts are not a licence to act on a shared production checkout');
      assert.match(cf.primeLines({ status: 'unknown', identity: 'x', findings: [] })[0], /UNKNOWN/);
      assert.deepEqual(cf.primeLines({ status: 'not-a-checkout', findings: [] }), []);
    });
  });

  describe('isLiveInstall', () => {
    it('matches the root as given or as resolved, and never touches the project path', () => {
      const real = path.join(tmp, 'live');
      fs.mkdirSync(real, { recursive: true });
      const link = path.join(tmp, 'live-link');
      fs.symlinkSync(real, link);
      // The root may be given through a symlink; its resolved form still matches.
      assert.equal(cf.isLiveInstall(real, link), true);
      assert.equal(cf.isLiveInstall(link, link), true);
      assert.equal(cf.isLiveInstall(`${real}/`, real), true, 'a trailing slash is the same directory');
      assert.equal(cf.isLiveInstall(tmp, real), false);
      assert.equal(cf.isLiveInstall(null, real), false);
      // A project path is compared as a string only: a path that does not exist
      // answers false without any filesystem call that could block.
      assert.equal(cf.isLiveInstall(path.join(tmp, 'missing', 'deeper'), real), false);
    });

    it('does not resolve a project registered through a symlink — a missed line, never a hung server', () => {
      const real = path.join(tmp, 'live2');
      fs.mkdirSync(real, { recursive: true });
      const link = path.join(tmp, 'live2-link');
      fs.symlinkSync(real, link);
      assert.equal(cf.isLiveInstall(link, real), false);
    });
  });

  describe('assess — one fact, one sentence', () => {
    const local = { repoRoot: '/r', ok: true, notGit: false, headSha: 'b'.repeat(40), branch: 'main', detached: false,
      releaseTag: null, upstream: 'origin/main', ahead: 2, behind: 0, upstreamGone: false, trackedChanges: 0, untracked: 0 };

    it('on main tracking origin/main, ahead is said once — by the observation', () => {
      const a = cf.assess(local, observed({ headSha: local.headSha, ahead: 2, relation: 'ahead' }));
      const codes = a.findings.map((f) => f.code);
      assert.deepEqual(codes, ['ahead-of-origin']);
    });

    it('keeps the status-header count when the observation cannot speak for this HEAD', () => {
      const down = cf.assess(local, observed({ evidence: 'unavailable', reason: 'offline', relation: null, originMainSha: null }));
      assert.ok(down.findings.some((f) => f.code === 'unpushed'));
      const moved = cf.assess(local, observed({ headSha: 'c'.repeat(40) }));
      assert.ok(moved.findings.some((f) => f.code === 'unpushed'));
    });
  });

  describe('liveInstallSnapshot and warmForLaunch keep their promises', () => {
    const behindOrigin = require('../lib/behind-origin');
    const saved = {};
    beforeEach(() => {
      for (const k of ['snapshot', 'observation', 'remeasureRelation']) saved[k] = behindOrigin[k];
    });
    afterEach(() => Object.assign(behindOrigin, saved));

    it('starts the origin refresh on every read, and a re-measure when HEAD has moved', () => {
      let refreshes = 0;
      let remeasures = 0;
      behindOrigin.snapshot = () => { refreshes++; return {}; };
      behindOrigin.remeasureRelation = () => { remeasures++; return Promise.resolve(null); };
      behindOrigin.observation = () => observed({ headSha: 'c'.repeat(40) });
      cf._internal.git = async (args) => ({ exitCode: 0, stdout: args[0] === 'status' ? '## main...origin/main\n' : `${'d'.repeat(40)}\n`,
        stderr: '', error: null, errorCode: null, signal: null, timedOut: false });
      return cf.refresh(cf.LIVE_INSTALL_ROOT).then(() => {
        const snap = cf.liveInstallSnapshot({});
        assert.equal(refreshes, 1, 'the snapshot itself keeps the observation moving');
        assert.equal(snap.findings[0].code, 'origin-outdated');
        assert.equal(remeasures, 1, '"being re-measured" is only said when a re-measure was started');
        behindOrigin.observation = () => observed({ headSha: 'd'.repeat(40) });
        cf.liveInstallSnapshot({});
        assert.equal(remeasures, 1, 'no re-measure when the observation matches HEAD');
      });
    });

    it('warmForLaunch reads the live checkout for its own project only', async () => {
      let reads = 0;
      let starts = 0;
      behindOrigin.snapshot = () => { starts++; return {}; };
      cf._internal.git = async () => { reads++; return { exitCode: 0, stdout: '## main\n', stderr: '', error: null,
        errorCode: null, signal: null, timedOut: false }; };
      assert.equal(await cf.warmForLaunch(tmp, {}), false);
      assert.equal(reads + starts, 0, 'another project costs nothing');
      assert.equal(await cf.warmForLaunch(cf.LIVE_INSTALL_ROOT, {}), true);
      assert.ok(reads > 0);
      assert.equal(starts, 1);
      assert.ok(cf.readCached(cf.LIVE_INSTALL_ROOT), 'the prime then reads a warm cache');
    });

    it('takes its root from behind-origin, so both halves name the same checkout', () => {
      assert.equal(cf.LIVE_INSTALL_ROOT, behindOrigin.REPO_ROOT);
    });
  });
});

describe('renderLiveCheckoutBanner (public/landing.js)', () => {
  const ROOT = path.join(__dirname, '..');
  const LANDING_SRC = fs.readFileSync(path.join(ROOT, 'public', 'landing.js'), 'utf8');
  const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  /**
   * Slice a top-level function out of landing.js by brace matching.
   * @param {string} name
   * @returns {string}
   */
  function extract(name) {
    const start = LANDING_SRC.search(new RegExp(`(async )?function ${name}\\(`));
    assert.ok(start > -1, `${name} should exist in landing.js`);
    let depth = 0;
    for (let i = LANDING_SRC.indexOf('{', start); i < LANDING_SRC.length; i++) {
      if (LANDING_SRC[i] === '{') depth++;
      else if (LANDING_SRC[i] === '}') {
        depth--;
        if (depth === 0) return LANDING_SRC.slice(start, i + 1);
      }
    }
    throw new Error(`could not brace-match ${name}`);
  }

  /**
   * Run the renderer against a DOM stub.
   * @param {object} payload
   * @param {boolean} [startVisible]
   * @returns {object} The stub elements.
   */
  function render(payload, startVisible = false) {
    const els = {};
    for (const id of ['liveCheckoutBanner', 'liveCheckoutBannerTitle', 'liveCheckoutBannerIdentity', 'liveCheckoutBannerList']) {
      els[id] = {
        textContent: '', innerHTML: '', children: [], _hidden: !startVisible,
        appendChild(c) { this.children.push(c); },
        classList: { add(c) { if (c === 'hidden') els[id]._hidden = true; }, remove(c) { if (c === 'hidden') els[id]._hidden = false; } }
      };
    }
    // Setting textContent clears children, as the DOM does.
    const list = els.liveCheckoutBannerList;
    Object.defineProperty(list, 'textContent', { set() { list.children = []; }, get() { return ''; } });
    const document = {
      getElementById: (id) => els[id] || null,
      createElement: () => ({ textContent: '' })
    };
    vm.runInContext(`${extract('renderLiveCheckoutBanner')}\nrenderLiveCheckoutBanner(payload);`,
      vm.createContext({ document, payload }));
    return els;
  }

  it('shows each finding as text, with the identity line', () => {
    const els = render({ status: 'attention', identity: 'Checkout: /r — feat/x @ 1234567',
      findings: [{ text: 'The checkout is on branch "feat/x", not main.' }, { text: '2 untracked paths are in the checkout.' }] });
    assert.equal(els.liveCheckoutBanner._hidden, false);
    assert.match(els.liveCheckoutBannerTitle.textContent, /needs attention/);
    assert.equal(els.liveCheckoutBannerIdentity.textContent, 'Checkout: /r — feat/x @ 1234567');
    assert.deepEqual(els.liveCheckoutBannerList.children.map((c) => c.textContent),
      ['The checkout is on branch "feat/x", not main.', '2 untracked paths are in the checkout.']);
  });

  it('shows unknown as unknown — not as fine', () => {
    const els = render({ status: 'unknown', identity: 'x', findings: [{ text: 'origin/main could not be observed.' }] });
    assert.equal(els.liveCheckoutBanner._hidden, false);
    assert.match(els.liveCheckoutBannerTitle.textContent, /unknown, not current/);
  });

  it('comes down when the checkout is ok, is not a checkout, or the server predates the field', () => {
    for (const payload of [{ status: 'ok', findings: [] }, { status: 'not-a-checkout', findings: [] }, undefined, null]) {
      assert.equal(render(payload, true).liveCheckoutBanner._hidden, true);
    }
  });

  it('never puts a branch name into markup', () => {
    const src = extract('renderLiveCheckoutBanner');
    assert.doesNotMatch(src, /innerHTML/, 'a branch name is text its owner chose; it must not become markup');
  });

  it('is present at rest as a hidden status region, and loadServerInfo renders it before the stale-server returns', () => {
    assert.match(INDEX_SRC, /id="liveCheckoutBanner" class="orphan-banner live-checkout-banner hidden" role="status"/);
    const load = extract('loadServerInfo');
    const call = load.indexOf('renderLiveCheckoutBanner(data.checkout)');
    assert.ok(call > -1);
    assert.ok(call < load.indexOf('if (data.isStale === null)'));
  });
});

describe('server wiring (#993)', () => {
  const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('the launch route warms the live checkout before the prime is rendered', () => {
    const start = SERVER_SRC.indexOf("route('POST', '/api/sessions/:project'");
    assert.ok(start > -1);
    const route = SERVER_SRC.slice(start, start + 4000);
    const warm = route.search(/await checkoutFreshness\.warmForLaunch\(project\.path, /);
    assert.ok(warm > -1, 'the launch route must await warmForLaunch with the launching project');
    const ci = route.indexOf('await ciStatus.refresh(project.path)');
    assert.ok(ci > -1 && warm > ci, 'warmed beside the CI verdict, before the synchronous prime');
  });

  it('server-info and whoami read the one live-install snapshot', () => {
    assert.match(SERVER_SRC, /info\.checkout = checkoutFreshness\.liveInstallSnapshot\(cfg\)/);
    assert.match(SERVER_SRC, /liveInstall: project && checkoutFreshness\.isLiveInstall\(project\.path, checkoutFreshness\.LIVE_INSTALL_ROOT\)/);
  });
});
