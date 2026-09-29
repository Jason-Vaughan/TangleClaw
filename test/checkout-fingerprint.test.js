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
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.test');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const take = (opts) => {
    const r = fp.fingerprint(dir, opts);
    assert.ok(r.ok, r.reason);
    return r.fingerprint;
  };

  it('a clean checkout has its path, ref and head, and no dirt', () => {
    const f = take();
    assert.equal(f.path, dir);
    assert.equal(f.ref, 'refs/heads/main');
    assert.equal(f.head, git(dir, 'rev-parse', 'HEAD').trim());
    assert.deepEqual(f.dirty, []);
    assert.deepEqual(f.untracked, {});
  });

  it('lists tracked changes and untracked files, expanding untracked directories, but never ignored caches', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.mkdirSync(path.join(dir, 'notes/deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes/deep/x.md'), 'x');
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'cache');
    const f = take();
    assert.deepEqual(f.dirty, ['a.txt', 'notes/deep/x.md']);
    assert.deepEqual(Object.keys(f.untracked), ['notes/deep/x.md']);
    assert.match(f.untracked['notes/deep/x.md'], /^sha256:/);
  });

  it('a content change with the same inventory still changes the fingerprint', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'v1');
    const before = take();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'v2');
    const after = take();
    assert.deepEqual(before.dirty, after.dirty, 'same inventory');
    assert.equal(before.statusDigest, after.statusDigest, 'the status inventory alone cannot see this change');
    assert.deepEqual(fp.compare(before, after).map((i) => i.key).sort(), ['checkout.trackedDiffDigest', 'checkout.untracked:new.txt']);
    assert.ok(fp.compare(before, after).every((i) => i.before !== i.after));
  });

  it('a commit, a branch switch and a new untracked file all show as drift', () => {
    const before = take();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    git(dir, 'commit', '-q', '-am', 'more');
    git(dir, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    const keys = fp.compare(before, take()).map((i) => i.key);
    for (const k of ['checkout.ref', 'checkout.head', 'checkout.untracked:b.txt']) assert.ok(keys.includes(k), k);
  });

  it('hashes a declared important ignored file, and reports one that is missing or not ignored', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    const f = take({ importantIgnored: ['.env', 'a.txt', 'gone.env'] });
    assert.match(f.importantIgnored['.env'], /^sha256:/);
    assert.equal(f.importantIgnored['a.txt'], 'unavailable:not-ignored');
    assert.equal(f.importantIgnored['gone.env'], 'unavailable:not-ignored');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=2');
    const after = take({ importantIgnored: ['.env', 'a.txt', 'gone.env'] });
    assert.deepEqual(fp.compare(f, after).map((i) => i.key), ['checkout.importantIgnored:.env']);
  });

  it('a directory that is not a checkout, or does not exist, is unavailable rather than clean', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fp-plain-'));
    try {
      assert.deepEqual(fp.fingerprint(plain), { ok: false, reason: 'not-a-git-checkout' });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    assert.deepEqual(fp.fingerprint(path.join(dir, 'nope')), { ok: false, reason: 'checkout-missing' });
  });

  it('parses renames, keeping both paths', () => {
    const rec = Buffer.from('2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\0old.txt\0? u.txt\0');
    assert.deepEqual(fp.parseStatus(rec), { dirty: ['new name.txt', 'old.txt', 'u.txt'], untracked: ['u.txt'] });
  });
});
