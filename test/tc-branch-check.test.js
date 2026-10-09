'use strict';

/*
 * #1878 — `tc branch check <name>`: the verb's argument handling and its
 * exit-code contract (0 only for safe, 3 preserve, 4 unknown, 1 usage), in
 * process through the roster, then once end to end through `bin/tc` against a
 * real repository, because the exit code is what a script gates a deletion on.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { VERB_ROSTER, BRANCH_VERDICT_EXIT, receiptVerbLabel, renderUsage } = require('../lib/tc-verbs');
const { outsidePane } = require('./_tc-env');

const branch = VERB_ROSTER.find((v) => v.id === 'branch');
const OID = 'a'.repeat(40);

/**
 * A stub git whose every answer describes one repository state.
 * @param {object} o
 * @param {string} [o.revList=''] - Unique commits the walk returns.
 * @param {boolean} [o.fetchFails=false]
 * @returns {Function} `execFile`-compatible
 */
function stubGit({ revList = '', fetchFails = false } = {}) {
  return (file, args, _opts, cb) => {
    const a = args.slice(1);
    const key = a.slice(0, 2).join(' ');
    let out;
    if (key === 'rev-parse --show-toplevel') out = '/r\n';
    else if (key === 'check-ref-format --branch') out = `${a[2]}\n`;
    else if (key === 'rev-parse --verify') out = `${OID}\n`;
    else if (key === 'config --get') out = a[2].endsWith('.remote') ? 'origin\n' : 'refs/heads/feat\n';
    else if (a[0] === 'remote') out = 'origin\n';
    else if (key === 'fetch --prune') out = fetchFails ? new Error('Could not read from remote repository.') : '';
    else if (key === 'symbolic-ref --quiet') out = 'origin/main\n';
    else if (a[0] === 'rev-list') out = revList;
    else if (key === 'worktree list') out = `worktree /r\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/main\n`;
    else out = new Error(`unexpected git ${a.join(' ')}`);
    setImmediate(() => (out instanceof Error ? cb(out, '') : cb(null, out)));
  };
}

/**
 * Run the verb in process.
 * @param {string[]} argv
 * @param {Function} [execFile]
 * @returns {Promise<{code: number, stdout?: string, stderr?: string}>}
 */
function run(argv, execFile = stubGit()) {
  return branch.run({ argv, cwd: '/r', execFile, env: {} });
}

describe('tc branch check (in process)', () => {
  it('is in the roster and in help, with the verdict-as-exit-code contract', () => {
    assert.ok(branch, 'branch verb is declared');
    assert.match(renderUsage(), /tc branch check <name>/);
    assert.deepEqual(BRANCH_VERDICT_EXIT, { safe: 0, preserve: 3, unknown: 4 });
    assert.equal(receiptVerbLabel('branch', ['check', 'feat']), 'branch.check');
  });

  it('exits 0 only for safe', async () => {
    const r = await run(['check', 'feat']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /SAFE to retire/);
  });

  it('exits 3 for preserve and lists the unique commit', async () => {
    const sha = 'c'.repeat(40);
    const r = await run(['check', 'feat'], stubGit({ revList: `${sha}\n` }));
    assert.equal(r.code, 3);
    assert.match(r.stdout, /PRESERVE/);
    assert.ok(r.stdout.includes(sha));
  });

  it('exits 4 for unknown', async () => {
    const r = await run(['check', 'feat'], stubGit({ fetchFails: true }));
    assert.equal(r.code, 4);
    assert.match(r.stdout, /UNKNOWN — treat as PRESERVE/);
    assert.match(r.stdout, /\[FETCH_FAILED\]/);
  });

  it('--json prints the whole assessment as parseable JSON with stable reason codes', async () => {
    const r = await run(['check', 'feat', '--json'], stubGit({ revList: `${'c'.repeat(40)}\n${'d'.repeat(40)}\n` }));
    assert.equal(r.code, 3);
    const j = JSON.parse(r.stdout);
    assert.equal(j.verdict, 'preserve');
    assert.equal(j.oid, OID);
    assert.equal(j.unique.count, 2);
    assert.deepEqual(j.reasons.map((x) => x.code), ['UNIQUE_COMMITS']);
    assert.equal(typeof j.safeNextAction, 'string');
  });

  it('usage errors exit 1: no subverb, no name, two names, unknown flag, --repo without a path', async () => {
    for (const argv of [[], ['nope'], ['check'], ['check', 'a', 'b'], ['check', 'a', '--force'], ['check', 'a', '--repo']]) {
      const r = await run(argv);
      assert.equal(r.code, 1, argv.join(' '));
      assert.match(r.stderr, /usage: tc branch check/);
    }
  });

  it('--repo points the check at another checkout', async () => {
    const seen = [];
    const inner = stubGit();
    const execFile = (file, args, opts, cb) => { seen.push(opts.cwd); inner(file, args, opts, cb); };
    await branch.run({ argv: ['check', 'feat', '--repo', '/elsewhere'], cwd: '/r', execFile, env: {} });
    assert.equal(seen[0], '/elsewhere');
  });
});

describe('tc branch check (bin/tc against a real repository)', () => {
  let root;
  const TC = path.join(__dirname, '..', 'bin', 'tc');

  /**
   * Run git synchronously with a fixed identity.
   * @param {string} cwd
   * @param {...string} args
   * @returns {string}
   */
  function git(cwd, ...args) {
    return childProcess.execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...outsidePane(process.env), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: root }
    }).trim();
  }

  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-branch-check-')); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('the incident shape exits 3 and names the unpushed commit; after pushing it, exits 0', () => {
    const origin = path.join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    const dir = path.join(root, 'work');
    git(root, 'clone', '-q', origin, dir);
    git(dir, 'checkout', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(dir, 'wrap.md'), 'wrap\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'wrap');
    const wrap = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');

    // The child must really spawn git, so it must not inherit the test
    // runner's marker that makes the default git seam refuse to.
    const { NODE_TEST_CONTEXT: _drop, TANGLECLAW_LAUNCH_ID: _l, ...env } = outsidePane(process.env);
    const opts = { cwd: dir, encoding: 'utf8', env: { ...env, TANGLECLAW_API: 'http://127.0.0.1:9' } };

    const first = childProcess.spawnSync(process.execPath, [TC, 'branch', 'check', 'feat'], opts);
    assert.equal(first.status, 3, first.stderr);
    assert.ok(first.stdout.includes(wrap));

    git(dir, 'push', '-q', '-u', 'origin', 'feat');
    const second = childProcess.spawnSync(process.execPath, [TC, 'branch', 'check', 'feat', '--json'], opts);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(JSON.parse(second.stdout).verdict, 'safe');
  });
});
