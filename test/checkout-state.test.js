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
  it('two clones of one repository share an identity and read one observed upstream (#1678)', async () => {
    const uo = require('../lib/upstream-observer');
    const seed = makeRepo('seed');
    const bare = path.join(root, 'origin.git');
    git(root, 'clone', '-q', '--bare', seed, bare);
    const a = path.join(root, 'clone-a');
    const b = path.join(root, 'clone-b');
    git(root, 'clone', '-q', bare, a);
    git(root, 'clone', '-q', bare, b);
    fs.writeFileSync(path.join(b, 'server.js'), 'moved upstream\n');
    git(b, 'commit', '-q', '-am', 'upstream moves');
    git(b, 'push', '-q', 'origin', 'main');

    const ma = await cs.measure(a, { execFile: realExec });
    const mb = await cs.measure(b, { execFile: realExec });
    assert.match(ma.repository.identity, /^file:[0-9a-f]{64}$/, 'a local repository is an opaque identity');
    assert.ok(!ma.repository.identity.includes(root), 'the identity never carries where the repository lives');
    assert.equal(ma.repository.identity, mb.repository.identity, 'one repository, one identity, whichever clone');
    // A clone naming the same repository through a symlink agrees, because the
    // path is canonicalized before it is hashed.
    const viaLink = path.join(root, 'origin-link.git');
    fs.symlinkSync(bare, viaLink);
    const c = path.join(root, 'clone-c');
    git(root, 'clone', '-q', viaLink, c);
    assert.equal((await cs.measure(c, { execFile: realExec })).repository.identity, ma.repository.identity);

    const savedExec = uo._internal.execFile;
    uo._reset();
    uo._internal.execFile = realExec;
    try {
      const obs = await uo.refresh(ma.repository.identity, { dir: a, name: 'A' });
      assert.equal(obs.state, 'measured', obs.reason);
      assert.equal(obs.sha, git(b, 'rev-parse', 'HEAD'), 'ls-remote sees the push clone A has not fetched');
      assert.equal(git(a, 'rev-parse', 'origin/main'), ma.headSha, 'observing wrote nothing into clone A');

      const behind = await cs.compareToUpstream(a, ma.headSha, obs.sha, { execFile: realExec });
      assert.deepEqual(behind, { ahead: null, behind: null, relation: 'behind-unknown', reason: 'upstream commit not fetched here' });
      const level = await cs.compareToUpstream(b, mb.headSha, obs.sha, { execFile: realExec });
      assert.equal(level.relation, 'equal');

      git(a, 'fetch', '-q', 'origin');
      const counted = await cs.compareToUpstream(a, ma.headSha, obs.sha, { execFile: realExec });
      assert.deepEqual(counted, { ahead: 0, behind: 1, relation: 'behind', reason: null });
    } finally {
      uo._internal.execFile = savedExec;
      uo._reset();
    }
  });

  it('a clone with no remote reads "no origin remote", which leaves its own facts complete', async () => {
    const r = await cs.measure(makeRepo('noremote'), { execFile: realExec });
    assert.deepEqual(r.repository, { identity: null, reason: 'no origin remote' });
    assert.deepEqual(r.incomplete, []);
  });
});

describe('checkout-state: repository identity (#1678)', () => {
  const savedRealpath = cs._internal.realpath;
  it('scp, https-with-token, ssh with port 22 and an uppercase host are one repository', () => {
    const forms = [
      'git@github.com:Jason-Vaughan/TangleClaw.git',
      'https://x-access-token:ghp_secret@GitHub.com/Jason-Vaughan/TangleClaw.git/',
      'ssh://git@github.com:22/Jason-Vaughan/TangleClaw.git',
      'https://github.com:443/Jason-Vaughan/TangleClaw',
      'git://github.com/Jason-Vaughan/TangleClaw.git'
    ];
    for (const f of forms) assert.equal(cs.normalizeRemoteUrl(f), 'github.com/Jason-Vaughan/TangleClaw', f);
  });

  it('never keeps a credential, keeps a non-default port and the path case', () => {
    const id = cs.normalizeRemoteUrl('https://user:pa55@git.example.com:8443/Team/Repo.git');
    assert.equal(id, 'git.example.com:8443/Team/Repo');
    assert.ok(!id.includes('pa55'));
    assert.notEqual(cs.normalizeRemoteUrl('git@github.com:owner/repo'), cs.normalizeRemoteUrl('git@github.com:Owner/Repo'),
      'path case is kept, so a case-only mismatch reads as two repositories, never as a false match');
  });

  it('a local path remote is an opaque identity that never carries the path; unreadable forms are null', () => {
    const id = cs.normalizeRemoteUrl('/srv/git/repo.git');
    assert.match(id, /^file:[0-9a-f]{64}$/);
    assert.ok(!id.includes('srv'));
    assert.equal(cs.normalizeRemoteUrl('file:///srv/git/repo.git'), id);
    assert.equal(cs.normalizeRemoteUrl('/srv/git/repo'), id, '.git or not, one repository');
    assert.equal(cs.normalizeRemoteUrl('../repo.git', '/srv/git/clone'), id, 'relative to the clone it was read from');
    assert.equal(cs.localRemotePath('git@github.com:o/r.git'), null, 'a network remote is not local');
    assert.equal(cs.normalizeRemoteUrl(''), null);
    assert.equal(cs.normalizeRemoteUrl('not a url'), null);
    assert.equal(cs.normalizeRemoteUrl(null), null);
  });

  it('measure reads the identity; no remote is a fact, a failed read is not "no remote"', async () => {
    const answers = (remote) => fakeGit({
      status: statusOut({}), 'rev-parse': `${SHA_A}\n`, 'rev-list': '0\t0\n', remote
    }).execFile;
    let r = await cs.measure('/x', { execFile: answers('git@github.com:o/r.git\n') });
    assert.deepEqual(r.repository, { identity: 'github.com/o/r', reason: null });
    r = await cs.measure('/x', { execFile: answers(Object.assign(new Error('x'), { code: 2, stderr: "error: No such remote 'origin'" })) });
    assert.deepEqual(r.repository, { identity: null, reason: 'no origin remote' });
    cs._internal.realpath = async (p) => p.replace('/link/', '/real/');
    try {
      r = await cs.measure('/x', { execFile: answers('/link/repo.git\n') });
      assert.equal(r.repository.identity, cs.localIdentity('/real/repo.git'), 'the path is canonicalized before it is hashed');
    } finally {
      cs._internal.realpath = savedRealpath;
    }
    r = await cs.measure('/x', { execFile: answers(Object.assign(new Error('x'), { killed: true })) });
    assert.equal(r.repository.identity, null);
    assert.match(r.repository.reason, /timed out/);
    assert.equal(r.state, 'measured', 'the identity is not one of the checkout\'s own facts');
  });
});

describe('checkout-state: comparison against an observed upstream (#1678)', () => {
  beforeEach(() => cs._reset());
  afterEach(() => { cs._internal.execFile = savedCsExec; cs._reset(); });
  const savedCsExec = cs._internal.execFile;

  it('equal SHAs need no git', async () => {
    const r = await cs.compareToUpstream('/x', SHA_A, SHA_A, { execFile: () => { throw new Error('no call expected'); } });
    assert.deepEqual(r, { ahead: 0, behind: 0, relation: 'equal', reason: null });
  });

  it('a present upstream commit is counted from the clone\'s own objects', async () => {
    const { execFile, calls } = fakeGit({ 'rev-parse': `${SHA_B}\n`, 'rev-list': '2\t3\n' });
    const r = await cs.compareToUpstream('/x', SHA_A, SHA_B, { execFile });
    assert.deepEqual(r, { ahead: 2, behind: 3, relation: 'diverged', reason: null });
    assert.deepEqual(calls.find((c) => c[0] === 'rev-list'), ['rev-list', '--left-right', '--count', `${SHA_A}...${SHA_B}`]);
    assert.ok(!calls.some((c) => c[0] === 'fetch'));
  });

  it('a missing upstream commit is behind by an unknown count; any other failure is unknown', async () => {
    let r = await cs.compareToUpstream('/x', SHA_A, SHA_B, { execFile: fakeGit({ 'rev-parse': Object.assign(new Error('x'), { code: 1 }) }).execFile });
    assert.equal(r.relation, 'behind-unknown');
    assert.equal(r.behind, null);
    r = await cs.compareToUpstream('/x', SHA_A, SHA_B, { execFile: fakeGit({ 'rev-parse': Object.assign(new Error('x'), { code: 128, stderr: 'fatal: bad object' }) }).execFile });
    assert.equal(r.relation, 'unknown');
    r = await cs.compareToUpstream('/x', SHA_A, SHA_B, { execFile: fakeGit({ 'rev-parse': `${SHA_B}\n`, 'rev-list': 'garbage' }).execFile });
    assert.equal(r.relation, 'unknown');
    r = await cs.compareToUpstream('/x', null, SHA_B, { execFile: fakeGit({}).execFile });
    assert.equal(r.relation, 'unknown');
  });

  it('compareSnapshot is pending first, keeps a definite answer, and retries a behind-unknown one', async () => {
    let fetched = false;
    const { execFile, calls } = fakeGit({
      'rev-parse': () => (fetched ? `${SHA_B}\n` : Object.assign(new Error('x'), { code: 1 })),
      'rev-list': '0\t1\n'
    });
    cs._internal.execFile = execFile;
    assert.equal(cs.compareSnapshot('/x', SHA_A, SHA_B).relation, 'pending');
    await cs.compareRefresh('/x', SHA_A, SHA_B);
    fetched = true; // the owning session fetches; the next read must notice
    assert.equal(cs.compareSnapshot('/x', SHA_A, SHA_B).relation, 'behind-unknown', 'served while the retry runs');
    await cs.compareRefresh('/x', SHA_A, SHA_B);
    assert.equal(cs.compareSnapshot('/x', SHA_A, SHA_B).relation, 'behind');
    const before = calls.length;
    cs.compareSnapshot('/x', SHA_A, SHA_B);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, before, 'a definite answer is not re-measured');
  });
});
