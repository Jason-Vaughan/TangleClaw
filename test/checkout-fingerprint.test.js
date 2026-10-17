'use strict';

/*
 * #2032, Architect ruling A7a: a checkout's fingerprint is its content, not
 * just an inventory. Against real repositories: the tracked diff, every
 * untracked file (directories expanded) and each declared important ignored
 * file are hashed; an undeclared ignored cache is never read; and any change
 * to any of them shows up in `compare` as a typed item with before/after.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fp = require('../lib/checkout-fingerprint');
const { initRepo } = require('./_temp-repo');

/**
 * Run git in a directory.
 * @param {string} dir - Repo.
 * @param {...string} args - Arguments.
 * @returns {string}
 */
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('checkout fingerprint (#2032 A7a)', () => {
  let dir;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fp-')));
    initRepo(dir, ['-b', 'main']);
    git(dir, 'config', 'user.email', 't@example.test');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const take = async (opts) => {
    const r = await fp.fingerprint(dir, opts);
    assert.ok(r.ok, r.reason);
    return r.fingerprint;
  };

  it('a clean checkout has its path, ref and head, and no dirt', async () => {
    const f = await take();
    assert.equal(f.path, dir);
    assert.equal(f.ref, 'refs/heads/main');
    assert.equal(f.head, git(dir, 'rev-parse', 'HEAD').trim());
    assert.deepEqual(f.dirty, []);
    assert.deepEqual(f.untracked, {});
  });

  it('lists tracked changes and untracked files, expanding untracked directories, but never ignored caches', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.mkdirSync(path.join(dir, 'notes/deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes/deep/x.md'), 'x');
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'cache');
    const f = await take();
    assert.deepEqual(f.dirty, ['a.txt', 'notes/deep/x.md']);
    assert.deepEqual(Object.keys(f.untracked), ['notes/deep/x.md']);
    assert.match(f.untracked['notes/deep/x.md'], /^sha256:/);
  });

  it('a content change with the same inventory still changes the fingerprint', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'v1');
    const before = await take();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'v2');
    const after = await take();
    assert.deepEqual(before.dirty, after.dirty, 'same inventory');
    assert.equal(before.statusDigest, after.statusDigest, 'the status inventory alone cannot see this change');
    assert.deepEqual(fp.compare(before, after).map((i) => i.key).sort(), ['checkout.trackedDiffDigest', 'checkout.untracked:new.txt']);
    assert.ok(fp.compare(before, after).every((i) => i.before !== i.after));
  });

  it('a commit, a branch switch and a new untracked file all show as drift', async () => {
    const before = await take();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    git(dir, 'commit', '-q', '-am', 'more');
    git(dir, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    const keys = fp.compare(before, await take()).map((i) => i.key);
    for (const k of ['checkout.ref', 'checkout.head', 'checkout.untracked:b.txt']) assert.ok(keys.includes(k), k);
  });

  it('hashes a declared important ignored file, and reports one that is missing or not ignored', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    const f = await take({ importantIgnored: ['.env', 'a.txt', 'gone.env'] });
    assert.match(f.importantIgnored['.env'], /^sha256:/);
    assert.equal(f.importantIgnored['a.txt'], 'unavailable:not-ignored');
    assert.equal(f.importantIgnored['gone.env'], 'unavailable:not-ignored');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=2');
    const after = await take({ importantIgnored: ['.env', 'a.txt', 'gone.env'] });
    assert.deepEqual(fp.compare(f, after).map((i) => i.key), ['checkout.importantIgnored:.env']);
  });

  it('a directory that is not a checkout, or does not exist, is unavailable rather than clean', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fp-plain-'));
    try {
      assert.deepEqual(await fp.fingerprint(plain), { ok: false, reason: 'not-a-git-checkout' });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    assert.deepEqual(await fp.fingerprint(path.join(dir, 'nope')), { ok: false, reason: 'checkout-missing' });
  });

  it('a project in a subdirectory of its repository is fingerprinted from the repository root', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
    const r = await fp.fingerprint(path.join(dir, 'sub'));
    assert.ok(r.ok, r.reason);
    assert.equal(r.fingerprint.path, dir);
    assert.match(r.fingerprint.untracked['new.txt'], /^sha256:/, 'a repo-relative path is read from the root, not the subdirectory');
  });

  it('refuses more important-ignored paths than the cap, and a declared set it cannot finish in time', async () => {
    const many = Array.from({ length: fp.MAX_IMPORTANT_IGNORED + 1 }, (_, i) => `f${i}.env`);
    assert.deepEqual(await fp.fingerprint(dir, { importantIgnored: many }), { ok: false, reason: 'too-many-important-ignored' });
    const slowGit = (d, args, o) => new Promise((resolve) => o.signal.addEventListener('abort', () => resolve(null)));
    assert.deepEqual(await fp.fingerprint(dir, {}, { git: slowGit, deadlineMs: 50 }), { ok: false, reason: 'deadline' });
  });

  it('reports a timeout as the deadline even when the timer fires before the clock reaches it', async () => {
    // Node can fire a timer a fraction of a millisecond early; this one fires
    // 20 ms early, so time is still left when the call is ended. Each git call
    // the deadline can end must still read as the deadline, not a git failure.
    const realSetTimeout = globalThis.setTimeout;
    const stalls = ['rev-parse --show-toplevel', 'rev-parse --verify', 'symbolic-ref', 'status', 'diff', 'check-ignore'];
    const results = [];
    globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.max(0, (ms || 0) - 20), ...rest);
    try {
      for (const stall of stalls) {
        // The stalled call settles when it is aborted, as the real runner does
        // once its child has exited; one that never did would cost the grace.
        const stalled = (o) => new Promise((resolve) => o.signal.addEventListener('abort', () => resolve(null)));
        const git = (d, args, o) => (args.join(' ').startsWith(stall) ? stalled(o) : fp._seams.git(d, args, o));
        results.push([stall, await fp.fingerprint(dir, { importantIgnored: ['.env'] }, { git, deadlineMs: 300 })]);
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    for (const [stall, r] of results) assert.deepEqual(r, { ok: false, reason: 'deadline' }, `stalled at ${stall}`);
  });

  it('checks every declared ignored path in one batched git call', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'x');
    const calls = [];
    const counting = (d, args, opts) => { calls.push(args[0]); return fp._seams.git(d, args, opts); };
    const r = await fp.fingerprint(dir, { importantIgnored: ['.env', 'a.txt', 'nope.env'] }, { git: counting });
    assert.ok(r.ok, r.reason);
    assert.equal(calls.filter((c) => c === 'check-ignore').length, 1);
  });

  it('parses renames, keeping both paths', () => {
    const rec = Buffer.from('2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\0old.txt\0? u.txt\0');
    assert.deepEqual(fp.parseStatus(rec), { dirty: ['new name.txt', 'old.txt', 'u.txt'], untracked: ['u.txt'] });
  });
});

/**
 * Whether a process is still alive.
 * @param {number} pid - Process id.
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('a git the deadline ended is stopped before the fingerprint returns', () => {
  // A stand-in for git, run through the real runner: at `status` it does what
  // the `mode` file says, after logging its pid; every other call is real git.
  // So the checkout is real, and what the deadline ends is a real process.
  // The writer uses only shell built-ins: a child it forked would not get the
  // signal sent to the shell, and could go on writing after the shell was gone.
  const STALL_DEADLINE_MS = 3000;
  let dir;
  let tools;
  const savedBin = fp._seams.bin;

  beforeEach(() => {
    tools = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fp-bin-'));
    fs.writeFileSync(path.join(tools, 'git'), `#!/bin/sh
case " $* " in
  *" status "*)
    echo "$$" > "${tools}/pid"
    case "$(cat "${tools}/mode")" in
      hang) exec sleep 30 ;;
      deaf) trap '' TERM; while :; do sleep 0.05; done ;;
      writer) i=0; while :; do i=$((i+1)); echo x > "$2/.git/late_$i"; done ;;
    esac ;;
esac
exec git "$@"
`, { mode: 0o755 });
    fp._seams.bin = path.join(tools, 'git');
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fp-')));
    initRepo(dir, ['-b', 'main']);
    git(dir, 'config', 'user.email', 't@example.test');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    fp._seams.bin = savedBin;
    // A failed assertion here must not leave a stand-in running: kill it outright.
    const pidFile = path.join(tools, 'pid');
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ } }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    fs.rmSync(tools, { recursive: true, force: true });
  });

  /**
   * Fingerprint with the stand-in in `mode`, and read the pid it logged.
   * @param {string} mode - hang, deaf or writer.
   * @returns {Promise<{r: object, pid: number, ms: number}>}
   */
  const stalledAt = async (mode) => {
    fs.writeFileSync(path.join(tools, 'mode'), mode);
    const started = Date.now();
    // Generous, so the real git calls before `status` finish on a loaded host
    // and the deadline lands on the stand-in, which is what is under test.
    const r = await fp.fingerprint(dir, {}, { deadlineMs: STALL_DEADLINE_MS });
    const pidFile = path.join(tools, 'pid');
    assert.ok(fs.existsSync(pidFile), `the deadline ended a call before \`status\` (${JSON.stringify(r)})`);
    return { r, pid: Number(fs.readFileSync(pidFile, 'utf8')), ms: Date.now() - started };
  };

  it('a git that hangs is reported as the deadline, and is not running when the fingerprint returns', async () => {
    const { r, pid } = await stalledAt('hang');
    assert.deepEqual(r, { ok: false, reason: 'deadline' });
    assert.equal(alive(pid), false, `git ${pid} outlived the fingerprint`);
  });

  it('a git that ignores SIGTERM is killed after the grace, and is not running when the fingerprint returns', async () => {
    const { r, pid, ms } = await stalledAt('deaf');
    assert.deepEqual(r, { ok: false, reason: 'deadline' });
    assert.equal(alive(pid), false, `git ${pid} outlived the fingerprint`);
    assert.ok(ms < STALL_DEADLINE_MS + fp.KILL_GRACE_MS + fp.REAP_MARGIN_MS + 5000, `returned after ${ms} ms`);
  });

  it('the checkout can be removed the moment the fingerprint returns, though git was writing inside it', async () => {
    const { r } = await stalledAt('writer');
    assert.deepEqual(r, { ok: false, reason: 'deadline' });
    // No retries: a late writer inside .git is what made this throw ENOTEMPTY.
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dir), false);
  });

  it('a runner that ignores the abort cannot hold the fingerprint past the deadline and the grace', async () => {
    const deaf = () => new Promise(() => {});
    const started = Date.now();
    assert.deepEqual(await fp.fingerprint(dir, {}, { git: deaf, deadlineMs: 200 }), { ok: false, reason: 'deadline' });
    const ms = Date.now() - started;
    assert.ok(ms >= fp.KILL_GRACE_MS, `it waited for the runner (${ms} ms)`);
    assert.ok(ms < 200 + fp.KILL_GRACE_MS + fp.REAP_MARGIN_MS + 5000, `returned after ${ms} ms`);
  });
});
