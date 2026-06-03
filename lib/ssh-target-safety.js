'use strict';

// Shared shape-validators for SSH-target fields that get interpolated into
// shell `ssh`/`scp` commands (#314 — one source of truth for the guards
// introduced in #311/#312/#313). Used by lib/openclaw-detect.js,
// lib/openclaw-version.js, and the POST /api/openclaw/test route.
//
// These are deliberately strict allow-lists: anything outside the character
// class is rejected before it can reach a shell. They are NOT a substitute for
// avoiding interpolation where practical — they're the defense-in-depth net for
// the places that already build command strings.

// hostname / IPv4 / IPv6 / tailscale name. Colons allow IPv6 literals.
const SAFE_HOST = /^[A-Za-z0-9._:-]+$/;
// POSIX-ish usernames.
const SAFE_USER = /^[A-Za-z0-9._-]+$/;
// Key/dir paths: a leading ~ (expanded by the caller or remote shell) plus a
// metacharacter-free path body. No spaces, quotes, $, backticks, ;, |, &, etc.
const SAFE_KEYPATH = /^~?[A-Za-z0-9_./-]+$/;

/**
 * Validate that an SSH target's interpolated fields are all shape-safe.
 * @param {object} conn - { host, sshUser, sshKeyPath }
 * @returns {string|null} An error reason, or null when all fields are safe.
 */
function unsafeReason(conn) {
  if (!conn || !conn.host || !conn.sshUser || !conn.sshKeyPath) {
    return 'host, sshUser, and sshKeyPath are all required';
  }
  if (!SAFE_HOST.test(conn.host)) return 'host contains unsafe characters';
  if (!SAFE_USER.test(conn.sshUser)) return 'sshUser contains unsafe characters';
  if (!SAFE_KEYPATH.test(conn.sshKeyPath)) return 'sshKeyPath contains unsafe characters';
  return null;
}

module.exports = { SAFE_HOST, SAFE_USER, SAFE_KEYPATH, unsafeReason };
