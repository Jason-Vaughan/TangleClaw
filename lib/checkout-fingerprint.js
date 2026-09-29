'use strict';

/**
 * A content-level fingerprint of a git checkout, for a coordinator rotation
 * (#2032, Architect ruling A7a): observed by the server at prepare and again
 * at resume, so the replacement context cannot resume over a checkout that
 * changed while it was absent.
 *
 * An inventory (which paths are dirty) is not integrity, so the fingerprint
 * also hashes the content: the whole tracked diff against HEAD, every
 * untracked file (directories expanded, never crawled beyond what git itself
 * lists as untracked, so ignored dependency and build caches are not read),
 * and each ignored file the coordinator explicitly declared as important.
 *
 * Every git call is bounded in time and output. A checkout that cannot be
 * fingerprinted is reported as unavailable, never as clean.
 *
 * @module lib/checkout-fingerprint
 */

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Largest git output read for one call. */
const MAX_GIT_BYTES = 256 * 1024 * 1024;

/** Largest single file hashed. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Most dirty paths a fingerprint carries. */
const MAX_PATHS = 2000;

/** Seams for tests. */
const _seams = {
  git: (dir, args) => {
    const r = childProcess.spawnSync('git', ['-C', dir, ...args], { timeout: 15000, maxBuffer: MAX_GIT_BYTES });
    if (r.error || r.status !== 0) return null;
    return r.stdout;
  }
};

/**
 * SHA-256 of bytes or text, hex.
 * @param {Buffer|string} data - Input.
 * @returns {string}
 */
function _sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Parse `git status --porcelain=v2 -z --untracked-files=all` into the dirty
 * path set and the untracked subset.
 * @param {Buffer} out - Raw output.
 * @returns {{dirty: string[], untracked: string[]}}
 */
function parseStatus(out) {
  const records = out.toString('utf8').split('\0');
  const dirty = new Set();
  const untracked = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const kind = rec[0];
    if (kind === '?') {
      const p = rec.slice(2);
      dirty.add(p);
      untracked.push(p);
    } else if (kind === '1') {
      dirty.add(rec.split(' ').slice(8).join(' '));
    } else if (kind === '2') {
      dirty.add(rec.split(' ').slice(9).join(' '));
      i += 1; // the original path follows as its own record
      if (records[i]) dirty.add(records[i]);
    } else if (kind === 'u') {
      dirty.add(rec.split(' ').slice(10).join(' '));
    }
  }
  return { dirty: [...dirty].sort(), untracked: untracked.sort() };
}

/**
 * Hash one file under the checkout, or say why not.
 * @param {string} root - Checkout root.
 * @param {string} rel - Repo-relative path.
 * @returns {string} `sha256:<hex>`, `symlink:<hex of target>`, or `unavailable:<reason>`.
 */
function _hashFile(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return 'unavailable:outside-checkout';
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return 'unavailable:missing';
  }
  if (st.isSymbolicLink()) return `symlink:${_sha256(fs.readlinkSync(abs))}`;
  if (!st.isFile()) return 'unavailable:not-a-file';
  if (st.size > MAX_FILE_BYTES) return 'unavailable:too-large';
  return `sha256:${_sha256(fs.readFileSync(abs))}`;
}

/**
 * Fingerprint a checkout.
 * @param {string} dir - The checkout directory.
 * @param {{importantIgnored?: string[]}} [opts] - Ignored files the owner declared important.
 * @param {object} [deps] - Seams.
 * @returns {{ok: true, fingerprint: object}|{ok: false, reason: string}}
 */
function fingerprint(dir, opts = {}, deps = {}) {
  const git = deps.git || _seams.git;
  let root;
  try {
    root = fs.realpathSync(dir);
  } catch {
    return { ok: false, reason: 'checkout-missing' };
  }
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!top) return { ok: false, reason: 'not-a-git-checkout' };
  const head = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (!head) return { ok: false, reason: 'no-head' };
  const symbolic = git(root, ['symbolic-ref', '-q', 'HEAD']);
  const status = git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  if (!status) return { ok: false, reason: 'status-unreadable' };
  const diff = git(root, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv']);
  if (!diff) return { ok: false, reason: 'diff-unreadable' };
  const { dirty, untracked } = parseStatus(status);
  if (dirty.length > MAX_PATHS) return { ok: false, reason: 'too-many-dirty-paths' };

  const untrackedHashes = {};
  for (const p of untracked) untrackedHashes[p] = _hashFile(root, p);
  const ignoredHashes = {};
  for (const p of (opts.importantIgnored || []).slice().sort()) {
    const checked = git(root, ['check-ignore', '-q', '--', p]);
    ignoredHashes[p] = checked === null ? 'unavailable:not-ignored' : _hashFile(root, p);
  }
  return {
    ok: true,
    fingerprint: {
      path: root,
      ref: symbolic ? symbolic.toString('utf8').trim() : 'detached',
      head: head.toString('utf8').trim(),
      statusDigest: _sha256(status),
      trackedDiffDigest: _sha256(diff),
      dirty,
      untracked: untrackedHashes,
      importantIgnored: ignoredHashes
    }
  };
}

/**
 * The fields of two fingerprints that differ, each as a typed local-checkout
 * integrity drift item. Order-stable, so the same change always reads the same.
 * @param {object} before - At prepare.
 * @param {object} after - At resume.
 * @returns {Array<{key: string, before: string, after: string}>}
 */
function compare(before, after) {
  const out = [];
  const digest = (v) => (typeof v === 'string' ? v : _sha256(JSON.stringify(v)));
  for (const key of ['path', 'ref', 'head', 'statusDigest', 'trackedDiffDigest']) {
    if (before[key] !== after[key]) out.push({ key: `checkout.${key}`, before: digest(before[key]), after: digest(after[key]) });
  }
  for (const group of ['untracked', 'importantIgnored']) {
    const keys = new Set([...Object.keys(before[group] || {}), ...Object.keys(after[group] || {})]);
    for (const p of [...keys].sort()) {
      const a = (before[group] || {})[p] || 'absent';
      const b = (after[group] || {})[p] || 'absent';
      if (a !== b) out.push({ key: `checkout.${group}:${p}`, before: a, after: b });
    }
  }
  return out;
}

module.exports = { fingerprint, compare, parseStatus, _seams };
