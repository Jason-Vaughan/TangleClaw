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
 * It runs off the event loop — git as a child process, files read
 * asynchronously — under one total deadline, and it caps how much it will
 * read. A checkout that cannot be fingerprinted inside those bounds is
 * reported as unavailable, never as clean.
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
const MAX_PATHS = 1000;

/** Most important-ignored files a checkpoint may declare. */
const MAX_IMPORTANT_IGNORED = 50;

/** Most bytes of file content one fingerprint will hash, across all files. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** The whole fingerprint's time budget. */
const DEADLINE_MS = 30000;

/**
 * What a git call resolves to when the deadline, not git, ended it. A timeout
 * is told from a failure by this value, never by re-reading the clock: a Node
 * timer can fire a fraction of a millisecond early, while time is still left.
 */
const DEADLINE = Symbol('deadline');

/**
 * Run git asynchronously in `dir`, bounded by `timeoutMs`, optionally feeding
 * `input` on stdin. Resolves to stdout, or to null on any failure: callers
 * turn null into "unavailable", never into an empty answer.
 * @param {string} dir - Working directory.
 * @param {string[]} args - Arguments.
 * @param {{timeoutMs: number, input?: string, okCodes?: number[]}} opts - Budget, stdin, and exit codes that count as success.
 * @returns {Promise<Buffer|null>}
 */
function _runGit(dir, args, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = childProcess.execFile('git', ['-C', dir, ...args],
        { timeout: Math.max(1, opts.timeoutMs), maxBuffer: MAX_GIT_BYTES, encoding: 'buffer' },
        (err, stdout) => {
          const code = err && typeof err.code === 'number' ? err.code : (err ? -1 : 0);
          resolve((opts.okCodes || [0]).includes(code) ? stdout : null);
        });
    } catch {
      resolve(null);
      return;
    }
    if (opts.input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    }
  });
}

/** Seams for tests. */
const _seams = { git: _runGit };

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
 * @param {{bytes: number}} budget - Bytes still allowed; decremented.
 * @returns {Promise<string>} `sha256:<hex>`, `symlink:<hex of target>`, or `unavailable:<reason>`.
 */
async function _hashFile(root, rel, budget) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return 'unavailable:outside-checkout';
  let st;
  try {
    st = await fs.promises.lstat(abs);
  } catch {
    return 'unavailable:missing';
  }
  if (!st.isSymbolicLink() && !st.isFile()) return 'unavailable:not-a-file';
  if (st.size > MAX_FILE_BYTES) return 'unavailable:too-large';
  if (st.size > budget.bytes) return 'unavailable:total-bytes-exceeded';
  budget.bytes -= st.size;
  try {
    return st.isSymbolicLink()
      ? `symlink:${_sha256(await fs.promises.readlink(abs))}`
      : `sha256:${_sha256(await fs.promises.readFile(abs))}`;
  } catch {
    return 'unavailable:unreadable';
  }
}

/**
 * Fingerprint a checkout, within {@link DEADLINE_MS} in total.
 * @param {string} dir - The checkout directory.
 * @param {{importantIgnored?: string[]}} [opts] - Ignored files the owner declared important.
 * @param {object} [deps] - Seams: `git(dir, args, {timeoutMs, input, okCodes})`, `deadlineMs`.
 * @returns {Promise<{ok: true, fingerprint: object}|{ok: false, reason: string}>}
 */
async function fingerprint(dir, opts = {}, deps = {}) {
  const git = deps.git || _seams.git;
  const deadline = Date.now() + (deps.deadlineMs || DEADLINE_MS);
  const left = () => deadline - Date.now();
  // Each call is raced against what is left of the deadline, so a git that
  // never answers cannot hold the fingerprint past it. A call the deadline
  // ended resolves to DEADLINE; a git that failed resolves to null.
  const run = (args, extra = {}) => {
    const budget = left();
    if (budget <= 0) return Promise.resolve(DEADLINE);
    let timer;
    const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(DEADLINE), budget); });
    return Promise.race([Promise.resolve(git(root, args, { timeoutMs: budget, ...extra })), expired])
      .finally(() => clearTimeout(timer));
  };
  const important = opts.importantIgnored || [];
  if (important.length > MAX_IMPORTANT_IGNORED) return { ok: false, reason: 'too-many-important-ignored' };
  let root;
  try {
    root = await fs.promises.realpath(dir);
  } catch {
    return { ok: false, reason: 'checkout-missing' };
  }
  const top = await run(['rev-parse', '--show-toplevel']);
  if (top === DEADLINE) return { ok: false, reason: 'deadline' };
  if (!top) return { ok: false, reason: 'not-a-git-checkout' };
  // A project may live in a subdirectory of its repository; git reports
  // every path relative to the top, so that is where files are read from.
  try {
    root = await fs.promises.realpath(top.toString('utf8').trim());
  } catch {
    return { ok: false, reason: 'checkout-missing' };
  }
  const head = await run(['rev-parse', '--verify', 'HEAD']);
  if (head === DEADLINE) return { ok: false, reason: 'deadline' };
  if (!head) return { ok: false, reason: 'no-head' };
  const symbolic = await run(['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] });
  if (symbolic === DEADLINE) return { ok: false, reason: 'deadline' };
  const status = await run(['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  if (status === DEADLINE) return { ok: false, reason: 'deadline' };
  if (!status) return { ok: false, reason: 'status-unreadable' };
  const diff = await run(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv']);
  if (diff === DEADLINE) return { ok: false, reason: 'deadline' };
  if (!diff) return { ok: false, reason: 'diff-unreadable' };
  const { dirty, untracked } = parseStatus(status);
  if (dirty.length > MAX_PATHS) return { ok: false, reason: 'too-many-dirty-paths' };

  const budget = { bytes: MAX_TOTAL_BYTES };
  const untrackedHashes = {};
  for (const p of untracked) {
    if (left() <= 0) return { ok: false, reason: 'deadline' };
    untrackedHashes[p] = await _hashFile(root, p, budget);
  }
  const ignoredHashes = {};
  if (important.length) {
    // One batched check for every declared path, not one git per path.
    const out = await run(['check-ignore', '-z', '--stdin'], { input: important.join('\0') + '\0', okCodes: [0, 1] });
    if (out === DEADLINE) return { ok: false, reason: 'deadline' };
    if (!out) return { ok: false, reason: 'check-ignore-unreadable' };
    const ignored = new Set(out.toString('utf8').split('\0').filter(Boolean));
    for (const p of important.slice().sort()) {
      if (left() <= 0) return { ok: false, reason: 'deadline' };
      ignoredHashes[p] = ignored.has(p) ? await _hashFile(root, p, budget) : 'unavailable:not-ignored';
    }
  }
  return {
    ok: true,
    fingerprint: {
      path: root,
      ref: symbolic && symbolic.length ? symbolic.toString('utf8').trim() : 'detached',
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

module.exports = { fingerprint, compare, parseStatus, MAX_IMPORTANT_IGNORED, MAX_TOTAL_BYTES, DEADLINE_MS, _seams };
