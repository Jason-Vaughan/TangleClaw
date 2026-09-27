#!/usr/bin/env node
'use strict';

/**
 * Refuse a release body GitHub might not accept, before anything is tagged
 * (#1947).
 *
 *   node scripts/release-notes-gate.js release-notes.md
 *
 * `release.yml` pushes the tag and only then runs `gh release create
 * --notes-file`. A body GitHub rejects as too long fails that last step with
 * the tag already on origin: a tag with no Release, which every install's
 * update check can already see. So the exact bytes `--notes-file` will send
 * are measured here, first, and the run stops before any tag, push or release
 * when they cannot be published.
 *
 * The ceiling is 120,000 UTF-8 BYTES. That is deliberately under GitHub's
 * limit, and bytes rather than JavaScript characters, which undercount
 * multibyte text. It is set by an Architect ruling. There is no truncation
 * mode, and none should be added: a release whose notes were cut to fit looks
 * complete and is not, the failure this workflow exists to prevent. An
 * oversized body is fixed in `CHANGELOG.md`, never here.
 *
 * Exit: 0 publishable · 1 refused (empty, or over the ceiling) · 2 usage
 * error or unreadable file.
 */

const fs = require('node:fs');

const MAX_RELEASE_BODY_BYTES = 120000;

/**
 * Judge a release body by its exact bytes.
 * @param {Buffer} body - The file `gh release create --notes-file` will send, unmodified.
 * @returns {{ ok: boolean, bytes: number, message: string }}
 */
function checkNotes(body) {
  if (!Buffer.isBuffer(body)) throw new Error('release notes must be a Buffer of the exact bytes to publish');
  const bytes = body.length;
  if (body.toString('utf8').trim() === '') {
    return { ok: false, bytes, message: 'the release notes are empty, so the Release would deliver nothing' };
  }
  if (bytes > MAX_RELEASE_BODY_BYTES) {
    return {
      ok: false,
      bytes,
      message: `the release notes are ${bytes} bytes, over the ${MAX_RELEASE_BODY_BYTES}-byte ceiling for a GitHub Release body. `
        + 'Shorten this version\'s CHANGELOG.md section; the notes are never truncated'
    };
  }
  return { ok: true, bytes, message: `release notes are ${bytes} of ${MAX_RELEASE_BODY_BYTES} bytes` };
}

/**
 * Run the CLI.
 * @param {string[]} argv - Arguments after the script name: one notes file.
 * @param {(file: string) => Buffer} [read] - File reader (a seam for tests).
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function main(argv, read = (f) => fs.readFileSync(f)) {
  if (argv.length !== 1 || !argv[0] || argv[0].startsWith('-')) {
    return { code: 2, stdout: '', stderr: '::error::release notes gate: usage: release-notes-gate.js <notes-file>\n' };
  }
  let body;
  try {
    body = read(argv[0]);
  } catch (err) {
    return { code: 2, stdout: '', stderr: `::error::release notes gate: cannot read ${argv[0]}: ${err.message}\n` };
  }
  const verdict = checkNotes(body);
  if (verdict.ok) return { code: 0, stdout: `${verdict.message}\n`, stderr: '' };
  return { code: 1, stdout: '', stderr: `::error::${verdict.message}. Refusing to tag or release.\n` };
}

if (require.main === module) {
  const { code, stdout, stderr } = main(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}

module.exports = { MAX_RELEASE_BODY_BYTES, checkNotes, main };
