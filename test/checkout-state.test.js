'use strict';

/*
 * #993 / #1678 — what the live checkout is on, and whether a range of commits
 * changes anything a restart would load.
 *
 * Two halves. The stubbed half drives every branch of `lib/checkout-state.js`
 * through its `execFile` seam, including each failure, because the property
 * that matters most — a failed probe is never reported as a clean checkout —
 * lives in the failure paths. The real-git half builds throwaway repositories
 * and runs the actual argv against the installed git, because a parser tested
 * only against hand-written output proves nothing about the output git emits.
 */

const { describe, it, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const cs = require('../lib/checkout-state');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * Build a fake `execFile` answering by git subcommand. Each answer is a
 * string (stdout), an Error (the call fails), or a function of the argv.
 * @param {Object<string, string|Error|Function>} answers - Keyed by subcommand (`status`, `rev-parse`, ...).
 * @returns {{execFile: Function, calls: string[][]}}
 */
function fakeGit(answers) {
  const calls = [];
  const execFile = (file, args, _opts, cb) => {
    assert.equal(file, 'git');
    assert.equal(args[0], '--no-optional-locks', 'every call is lock-free, so a poll never blocks a commit');
    const sub = args[1];
    calls.push(args.slice(1));
    let a = answers[sub];
    if (typeof a === 'function') a = a(args.slice(1));
    setImmediate(() => {
      if (a instanceof Error) cb(a, '');
      else if (a === undefined) cb(new Error(`unexpected git ${sub}`), '');
      else cb(null, a);
    });
  };
  return { execFile, calls };
}

/**
 * Porcelain v2 `-z` status output.
 * @param {{oid?: string, head?: string, upstream?: string, ab?: string, entries?: string[]}} o
 * @returns {string}
 */
function statusOut(o) {
  const recs = [`# branch.oid ${o.oid || SHA_A}`, `# branch.head ${o.head || 'main'}`];
  if (o.upstream) recs.push(`# branch.upstream ${o.upstream}`);
  if (o.ab) recs.push(`# branch.ab ${o.ab}`);
  return recs.concat(o.entries || []).join('\0') + '\0';
}

describe('checkout-state: parseStatusV2', () => {
  it('reads branch, upstream and the upstream ahead/behind header', () => {
    const r = cs.parseStatusV2(statusOut({ head: 'feat/x', upstream: 'origin/feat/x', ab: '+2 -1' }));
    assert.equal(r.head, 'feat/x');
    assert.equal(r.detached, false);
    assert.equal(r.upstream, 'origin/feat/x');
    assert.equal(r.upstreamAhead, 2);
    assert.equal(r.upstreamBehind, 1);
    assert.equal(r.oid, SHA_A);
  });

  it('counts ordinary, renamed and unmerged entries as tracked changes and ? as untracked; ignores !', () => {
    const r = cs.parseStatusV2(statusOut({
      entries: [
        '1 .M N... 100644 100644 100644 abc abc lib/a.js',
        '2 R. N... 100644 100644 100644 abc abc R100 lib/new name.js', 'lib/old\nname.js',
        'u UU N... 100644 100644 100644 100644 a b c lib/conflict.js',
        '? scratch file.txt',
        '? server.js.orig',
        '! node_modules/'
      ]
    }));
    assert.equal(r.dirtyTracked, 3, 'the rename original path is a second field, not a second entry');
    assert.equal(r.untracked, 2);
  });

  it('marks a detached HEAD and leaves head null', () => {
    const r = cs.parseStatusV2(statusOut({ head: '(detached)' }));
    assert.equal(r.detached, true);
    assert.equal(r.head, null);
  });

  it('an initial commit reads oid null, not a fake SHA', () => {
    assert.equal(cs.parseStatusV2('# branch.oid (initial)\0# branch.head main\0').oid, null);
  });
});

describe('checkout-state: measure (stubbed git)', () => {
  it('a clean main equal to origin/main', async () => {
    const { execFile } = fakeGit({
      status: statusOut({ upstream: 'origin/main', ab: '+0 -0' }),
      'rev-parse': `${SHA_A}\n`,
      'rev-list': '0\t0\n'
    });
    const r = await cs.measure('/x', { execFile });
    assert.equal(r.state, 'measured');
    assert.equal(r.branch, 'main');
    assert.equal(r.onDefaultBranch, true);
    assert.equal(r.relation, 'equal');
    assert.deepEqual(r.unpushed, { count: 0, against: 'origin/main' });
    assert.equal(r.dirtyTracked, 0);
    assert.equal(r.untracked, 0);
    assert.deepEqual(r.incomplete, []);
  });

  for (const [lr, relation] of [['3\t0', 'ahead'], ['0\t4', 'behind'], ['2\t5', 'diverged']]) {
    it(`names the relation ${relation} from rev-list --left-right`, async () => {
      const { execFile, calls } = fakeGit({
        status: statusOut({ head: 'feat/y' }),
        'rev-parse': `${SHA_B}\n`,
        'rev-list': `${lr}\n`
      });
      const r = await cs.measure('/x', { execFile });
      assert.equal(r.relation, relation);
      assert.equal(r.onDefaultBranch, false);
      assert.deepEqual(calls.find((c) => c[0] === 'rev-list'), ['rev-list', '--left-right', '--count', 'HEAD...origin/main']);
    });
  }

  it('a branch with no upstream reports unpushed against origin/main', async () => {
    const { execFile } = fakeGit({
      status: statusOut({ head: 'feat/local' }),
      'rev-parse': `${SHA_B}\n`,
      'rev-list': '4\t1\n'
    });
    const r = await cs.measure('/x', { execFile });
    assert.deepEqual(r.unpushed, { count: 4, against: 'origin/main' });
  });

  it('a branch with an upstream reports unpushed against it, from the status header', async () => {
    const { execFile } = fakeGit({
      status: statusOut({ head: 'feat/x', upstream: 'origin/feat/x', ab: '+1 -0' }),
      'rev-parse': `${SHA_B}\n`,
      'rev-list': '6\t0\n'
    });
    const r = await cs.measure('/x', { execFile });
    assert.deepEqual(r.unpushed, { count: 1, against: 'origin/feat/x' });
    assert.equal(r.ahead, 6, 'ahead of the shared target is a separate fact');
  });

  it('a detached HEAD at a tag names the tag; one not at a tag has tag null', async () => {
    let { execFile } = fakeGit({
      status: statusOut({ head: '(detached)' }),
      describe: 'v5.29.0\n',
      'rev-parse': `${SHA_A}\n`,
      'rev-list': '0\t2\n'
    });
    let r = await cs.measure('/x', { execFile });
    assert.equal(r.detached, true);
    assert.equal(r.tag, 'v5.29.0');
    assert.equal(r.branch, null);
    assert.equal(r.onDefaultBranch, false);
    ({ execFile } = fakeGit({
      status: statusOut({ head: '(detached)' }),
      describe: Object.assign(new Error('fatal: no tag exactly matches'), { code: 128 }),
      'rev-parse': `${SHA_A}\n`,
      'rev-list': '0\t0\n'
    }));
    r = await cs.measure('/x', { execFile });
    assert.equal(r.tag, null);
  });

  it('a failed git status is state unknown with a reason — never zero changes', async () => {
    const { execFile } = fakeGit({ status: Object.assign(new Error('fatal: index file corrupt'), { stderr: 'fatal: index file corrupt' }) });
    const r = await cs.measure('/x', { execFile });
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /index file corrupt/);
    assert.equal(r.dirtyTracked, null);
    assert.equal(r.untracked, null);
    assert.equal(r.branch, null);
    assert.equal(r.onDefaultBranch, null);
    assert.equal(r.relation, 'unknown');
  });

  it('a timed-out status says it timed out', async () => {
    const { execFile } = fakeGit({ status: Object.assign(new Error('killed'), { killed: true }) });
    const r = await cs.measure('/x', { execFile });
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /timed out/);
  });

  it('no git binary, or not a repository, is the designed no-git opt-out', async () => {
    let { execFile } = fakeGit({ status: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) });
    assert.equal((await cs.measure('/x', { execFile })).state, 'no-git');
    ({ execFile } = fakeGit({ status: Object.assign(new Error('x'), { stderr: 'fatal: not a git repository (or any of the parent directories): .git' }) }));
    assert.equal((await cs.measure('/x', { execFile })).state, 'no-git');
  });

  it('a missing origin/main leaves ahead/behind/unpushed unknown and says why', async () => {
    const { execFile } = fakeGit({
      status: statusOut({ head: 'feat/z' }),
      'rev-parse': new Error('exit 1')
    });
    const r = await cs.measure('/x', { execFile });
    assert.equal(r.state, 'measured', 'the checkout itself was read');
    assert.equal(r.ahead, null);
    assert.equal(r.behind, null);
    assert.equal(r.relation, 'unknown');
    assert.equal(r.unpushed.count, null);
    assert.ok(r.incomplete.some((i) => /origin\/main is not present/.test(i)));
    assert.ok(r.incomplete.some((i) => /unpushed/.test(i)));
  });

  it('a failed or garbage rev-list leaves the relation unknown, not equal', async () => {
    for (const bad of [new Error('fatal: bad object'), 'warning: x\n']) {
      const { execFile } = fakeGit({ status: statusOut({}), 'rev-parse': `${SHA_A}\n`, 'rev-list': bad });
      const r = await cs.measure('/x', { execFile });
      assert.equal(r.relation, 'unknown');
      assert.equal(r.ahead, null);
      assert.ok(r.incomplete.some((i) => /ahead\/behind/.test(i)));
    }
  });

  it('a seam that throws synchronously resolves as unknown instead of escaping', async () => {
    const r = await cs.measure('/x', { execFile: () => { throw new Error('spawn refused'); } });
    assert.equal(r.state, 'unknown');
  });
});

describe('checkout-state: snapshot cache', () => {
  const orig = { ...cs._internal };
  let now;
  beforeEach(() => {
    cs._reset();
    now = 1_000_000;
    cs._internal.now = () => now;
  });
  afterEach(() => {
    Object.assign(cs._internal, orig);
    cs._reset();
  });

  it('answers pending at once, starts one measurement, then serves the cache inside the TTL', async () => {
    let statusCalls = 0;
    const { execFile } = fakeGit({
      status: () => { statusCalls++; return statusOut({}); },
      'rev-parse': `${SHA_A}\n`,
      'rev-list': '0\t0\n'
    });
    cs._internal.execFile = execFile;
    const first = cs.snapshot('/x');
    assert.equal(first.state, 'pending');
    assert.equal(first.dirtyTracked, null, 'pending is never a clean checkout');
    cs.snapshot('/x');
    cs.snapshot('/x');
    await cs.refresh('/x');
    assert.equal(statusCalls, 1, 'concurrent callers share one measurement');
    assert.equal(cs.snapshot('/x').state, 'measured');
    assert.equal(statusCalls, 1, 'served from cache inside the TTL');
    now += cs.CACHE_TTL_MS;
    assert.equal(cs.snapshot('/x').state, 'measured', 'an expired cache is still served while re-measuring');
    await cs.refresh('/x');
    assert.equal(statusCalls, 2, 'one re-measurement past the TTL');
  });

  it('under the node test runner the default seam spawns nothing', async () => {
    Object.assign(cs._internal, orig);
    assert.equal(cs._spawnBlockedReason(), 'node test runner');
    const r = await cs.measure(process.cwd());
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /spawn blocked/);
  });
});

describe('checkout-state: withUpstreamObservation', () => {
  const measured = { state: 'measured', upstream: { ref: 'origin/main', sha: SHA_A } };

  it('a successful fetch before the checkout was read makes the ref a fetched observation with its time', () => {
    const r = cs.withUpstreamObservation({ ...measured, measuredAt: '2026-09-22T10:00:05.000Z' },
      { state: 'measured', checkedAt: '2026-09-22T10:00:00.000Z' });
    assert.equal(r.upstream.observation, 'fetched');
    assert.equal(r.upstream.observedAt, '2026-09-22T10:00:00.000Z');
  });

  it('a checkout read before the fetch shows the pre-fetch ref, so it is local-ref', () => {
    const r = cs.withUpstreamObservation({ ...measured, measuredAt: '2026-09-22T09:59:50.000Z' },
      { state: 'measured', checkedAt: '2026-09-22T10:00:00.000Z' });
    assert.equal(r.upstream.observation, 'local-ref');
    assert.equal(r.upstream.observedAt, null);
    const noTime = cs.withUpstreamObservation(measured, { state: 'measured', checkedAt: '2026-09-22T10:00:00.000Z' });
    assert.equal(noTime.upstream.observation, 'local-ref', 'an unknown read time cannot be ordered after the fetch');
  });

  it('without a successful fetch the ref is local-ref with no observation time', () => {
    for (const bo of [{ state: 'unknown', checkedAt: 'T' }, { state: 'disabled', checkedAt: null }, { state: 'skipped', checkedAt: 'T' }, null]) {
      const r = cs.withUpstreamObservation(measured, bo);
      assert.equal(r.upstream.observation, 'local-ref');
      assert.equal(r.upstream.observedAt, null);
    }
  });

  it('no upstream SHA is unknown, whatever the fetch said', () => {
    const r = cs.withUpstreamObservation({ upstream: { ref: 'origin/main', sha: null } }, { state: 'measured', checkedAt: 'T' });
    assert.equal(r.upstream.observation, 'unknown');
    assert.equal(r.upstream.observedAt, null);
  });
});

describe('checkout-state: restart-impact classification', () => {
  it('records-only paths are docs, tests, plans, prawduct state, .github and top-level markdown', () => {
    for (const p of ['docs/adr/0002.md', 'test/a.test.js', '.tangleclaw/plans/x.md', '.prawduct/change-log.md',
      '.github/workflows/ci.yml', 'CHANGELOG.md', 'README.md']) {
      assert.equal(cs.isRecordsPath(p), true, p);
    }
  });

  it('everything else is executable — including unlisted and new top-level directories', () => {
    for (const p of ['server.js', 'lib/a.js', 'public/landing.js', 'package.json', 'version.json', 'data/global-rules.md',
      '.claude/settings.json', 'hooks/x.sh', 'bin/tc', 'deploy/install.sh', 'newdir/thing.md', 'public/help.md',
      '.tangleclaw/memories/MEMORY.md', 'docsx/a.md', '']) {
      assert.equal(cs.isRecordsPath(p), false, p || '(empty)');
    }
  });

  it('classifies ranges as records-only, executable or mixed', () => {
    assert.equal(cs.classifyPaths(['docs/a.md', 'CHANGELOG.md']).impact, 'records-only');
    assert.equal(cs.classifyPaths(['lib/a.js']).impact, 'executable');
    const m = cs.classifyPaths(['lib/a.js', 'docs/a.md']);
    assert.equal(m.impact, 'mixed');
    assert.deepEqual(m.executablePaths, ['lib/a.js']);
    assert.deepEqual(m.recordsPaths, ['docs/a.md']);
  });

  it('parses name-status -z with both sides of a rename', () => {
    assert.deepEqual(cs.parseNameStatus('M\0docs/a.md\0R087\0docs/x.js\0lib/x.js\0D\0public/old.js\0'),
      ['docs/a.md', 'docs/x.js', 'lib/x.js', 'public/old.js']);
    assert.equal(cs.parseNameStatus('garbage\0'), null);
    assert.equal(cs.parseNameStatus('R100\0only-one\0'), null, 'a truncated rename is malformed, not a one-path change');
    assert.deepEqual(cs.parseNameStatus(''), []);
  });

  it('a rename from docs/ into lib/ needs a restart — both sides count, so it is never records-only', async () => {
    const { execFile } = fakeGit({ diff: 'R100\0docs/tool.js\0lib/tool.js\0' });
    const r = await cs.classifyRange('/x', SHA_A, SHA_B, { execFile });
    assert.equal(r.impact, 'mixed');
    assert.deepEqual(r.executablePaths, ['lib/tool.js']);
  });

  it('unknown when a SHA is missing, the SHAs are equal, git fails, or the output is garbage', async () => {
    const { execFile } = fakeGit({ diff: 'M\0docs/a.md\0' });
    assert.equal((await cs.classifyRange('/x', null, SHA_B, { execFile })).impact, 'unknown');
    assert.equal((await cs.classifyRange('/x', SHA_A, SHA_A, { execFile })).impact, 'unknown',
      'an empty range must not read as records-only');
    const failing = fakeGit({ diff: Object.assign(new Error('x'), { stderr: 'fatal: bad object bbbb' }) });
    const f = await cs.classifyRange('/x', SHA_A, SHA_B, { execFile: failing.execFile });
    assert.equal(f.impact, 'unknown');
    assert.match(f.reason, /bad object/);
    const garbage = fakeGit({ diff: 'what\0' });
    assert.equal((await cs.classifyRange('/x', SHA_A, SHA_B, { execFile: garbage.execFile })).impact, 'unknown');
  });

  it('caps the echoed paths and says so', async () => {
    const many = Array.from({ length: cs.IMPACT_PATH_LIMIT + 5 }, (_, i) => `M\0lib/f${i}.js\0`).join('');
    const { execFile } = fakeGit({ diff: many });
    const r = await cs.classifyRange('/x', SHA_A, SHA_B, { execFile });
    assert.equal(r.executablePaths.length, cs.IMPACT_PATH_LIMIT);
    assert.equal(r.truncated, true);
  });

  describe('impactSnapshot', () => {
    const orig = { ...cs._internal };
    beforeEach(() => cs._reset());
    afterEach(() => { Object.assign(cs._internal, orig); cs._reset(); });

    it('pending first, then the cached answer; a range is classified once', async () => {
      let diffs = 0;
      cs._internal.execFile = fakeGit({ diff: () => { diffs++; return 'M\0docs/a.md\0'; } }).execFile;
      assert.equal(cs.impactSnapshot('/x', SHA_A, SHA_B).impact, 'pending');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(cs.impactSnapshot('/x', SHA_A, SHA_B).impact, 'records-only');
      cs.impactSnapshot('/x', SHA_A, SHA_B);
      assert.equal(diffs, 1);
    });

    it('keeps only the newest IMPACT_RESULTS_MAX ranges', async () => {
      cs._internal.execFile = fakeGit({ diff: 'M\0docs/a.md\0' }).execFile;
      const sha = (i) => i.toString(16).padStart(40, '0');
      for (let i = 1; i <= cs.IMPACT_RESULTS_MAX + 3; i++) {
        cs.impactSnapshot('/x', SHA_A, sha(i));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      }
      let diffs = 0;
      cs._internal.execFile = fakeGit({ diff: () => { diffs++; return 'M\0docs/a.md\0'; } }).execFile;
      assert.equal(cs.impactSnapshot('/x', SHA_A, sha(cs.IMPACT_RESULTS_MAX + 3)).impact, 'records-only', 'the newest is kept');
      assert.equal(diffs, 0);
      assert.equal(cs.impactSnapshot('/x', SHA_A, sha(1)).impact, 'pending', 'the oldest was dropped and is re-asked');
      assert.equal(diffs, 1);
    });

    it('an unknown answer is reported, not cached — the next poll retries', async () => {
      let diffs = 0;
      cs._internal.execFile = fakeGit({ diff: () => { diffs++; return new Error('transient'); } }).execFile;
      cs.impactSnapshot('/x', SHA_A, SHA_B);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(cs.impactSnapshot('/x', SHA_A, SHA_B).impact, 'unknown', 'the failure is shown, not pending forever');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.ok(diffs >= 2, 'retried');
    });
  });
});

describe('checkout-state: against real git', () => {
  let root;
  const realExec = childProcess.execFile;

  /**
   * Run git synchronously in a directory with a fixed identity.
   * @param {string} cwd
   * @param {...string} args
   * @returns {string}
   */
  function git(cwd, ...args) {
    return childProcess.execFileSync('git', args, {
      cwd, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: root }
    }).trim();
  }

  /**
   * A fresh repo on main with one commit and origin/main pointing at it.
   * @param {string} name
   * @returns {string} The repo path.
   */
  function makeRepo(name) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'server.js'), '1\n');
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'a.md'), 'a\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    return dir;
  }

  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-checkout-state-')); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a clean main level with origin/main measures clean', async () => {
    const dir = makeRepo('clean');
    const r = await cs.measure(dir, { execFile: realExec });
    assert.equal(r.state, 'measured', r.reason);
    assert.equal(r.branch, 'main');
    assert.equal(r.relation, 'equal');
    assert.equal(r.headSha, git(dir, 'rev-parse', 'HEAD'));
    assert.equal(r.upstream.sha, r.headSha);
    assert.equal(r.dirtyTracked, 0);
    assert.equal(r.untracked, 0);
    assert.deepEqual(r.incomplete, []);
  });

  it('the #993 incident: a feature branch with unpushed commits, edits and scratch files', async () => {
    const dir = makeRepo('incident');
    git(dir, 'checkout', '-q', '-b', 'feat/771-wrap-progress');
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(dir, 'server.js'), `${i + 2}\n`);
      git(dir, 'commit', '-q', '-am', `c${i}`);
    }
    fs.writeFileSync(path.join(dir, 'server.js'), 'dirty\n');
    fs.writeFileSync(path.join(dir, 'server.js.orig'), 'x\n');
    fs.writeFileSync(path.join(dir, 'scratch with space.txt'), 'x\n');
    const r = await cs.measure(dir, { execFile: realExec });
    assert.equal(r.branch, 'feat/771-wrap-progress');
    assert.equal(r.onDefaultBranch, false);
    assert.deepEqual(r.unpushed, { count: 4, against: 'origin/main' });
    assert.equal(r.relation, 'ahead');
    assert.equal(r.dirtyTracked, 1);
    assert.equal(r.untracked, 2);
  });

  it('diverged and detached-at-tag against real git', async () => {
    const dir = makeRepo('diverge');
    fs.writeFileSync(path.join(dir, 'server.js'), 'upstream\n');
    git(dir, 'commit', '-q', '-am', 'upstream');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(dir, 'server.js'), 'local\n');
    git(dir, 'commit', '-q', '-am', 'local');
    let r = await cs.measure(dir, { execFile: realExec });
    assert.equal(r.relation, 'diverged');
    assert.equal(r.ahead, 1);
    assert.equal(r.behind, 1);
    git(dir, 'tag', 'v1.0.0');
    git(dir, 'checkout', '-q', '--detach', 'v1.0.0');
    r = await cs.measure(dir, { execFile: realExec });
    assert.equal(r.detached, true);
    assert.equal(r.tag, 'v1.0.0');
  });

  it('classifies real ranges: docs-only, code, and a rename out of docs/', async () => {
    const dir = makeRepo('impact');
    const base = git(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'docs', 'a.md'), 'b\n');
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'docs');
    const docsOnly = git(dir, 'rev-parse', 'HEAD');
    let r = await cs.classifyRange(dir, base, docsOnly, { execFile: realExec });
    assert.equal(r.impact, 'records-only', r.reason);
    fs.mkdirSync(path.join(dir, 'lib'));
    git(dir, 'mv', 'docs/a.md', 'lib/a.md');
    git(dir, 'commit', '-q', '-m', 'move');
    r = await cs.classifyRange(dir, docsOnly, git(dir, 'rev-parse', 'HEAD'), { execFile: realExec });
    assert.equal(r.impact, 'mixed', 'the rename counts both sides');
    assert.deepEqual(r.executablePaths, ['lib/a.md']);
    r = await cs.classifyRange(dir, base, 'c'.repeat(40), { execFile: realExec });
    assert.equal(r.impact, 'unknown', 'a SHA this clone lacks is unknown');
  });

  it('a directory that is not a repository is no-git', async () => {
    const dir = path.join(root, 'plain');
    fs.mkdirSync(dir);
    const r = await cs.measure(dir, { execFile: realExec });
    assert.equal(r.state, 'no-git');
  });
});
