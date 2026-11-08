#!/usr/bin/env node
'use strict';

/**
 * Update the files a TangleClaw release needs besides `version.json` and
 * `CHANGELOG.md` (#1502). The wrap's `commit` step runs this as the project's
 * `releasePrepareCommand` once the bump and the CHANGELOG promotion are on disk:
 *
 *   "releasePrepareCommand": "node scripts/release-prepare.js"
 *
 * Three files, each guarded by a test that fails the release PR without them:
 *   - `README.md` clone pins (`--branch vX.Y.Z`) → the release version
 *     (`test/readme-version-pins.test.js`).
 *   - `README.md`'s top `**Latest release:**` banner (#2935): the version tag
 *     and the `docs/releases/vX.Y.Z.md` / sprint-report link both move to the
 *     release version (`test/readme-version-pins.test.js`). The banner's own
 *     prose — what shipped, in words — is not generated: nothing in this
 *     repo's tree says that in a form a script can read, so the release PR
 *     author writes it, the same way they write the CHANGELOG entry it
 *     summarizes.
 *   - `test/fixtures/changelog-released-sections.lock.json` gains the new
 *     release's section hash (`test/changelog-released-immutable.test.js`).
 *
 * The lock is extended, never regenerated. That lock exists to catch an
 * already-published section changing underneath a release, and a full regen
 * would bless exactly that. So an existing entry whose section no longer
 * matches, or a released section other than this release that has no entry,
 * stops the script instead.
 *
 * The version comes from `TANGLECLAW_RELEASE_VERSION` when the wrap sets it,
 * and must agree with `version.json`. Run by hand, `version.json` alone decides.
 *
 * One guard before any file is touched (#1220): a changelog fragment still under
 * `changelog.d/` is an entry the release did not compile, and locking the
 * release's section without it would publish that entry twice (the next cut
 * compiles it again) or never. The wrap's version bump deletes every fragment it
 * compiles in the same flush this script runs after, so on a correct cut the
 * directory is already empty.
 *
 * Exit: 0 files are current · 1 refused (reason on stderr). Idempotent.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readFragments, FRAGMENT_DIR } = require('../lib/changelog-fragments');

const LOCK_REL = path.join('test', 'fixtures', 'changelog-released-sections.lock.json');
const RELEASE_HEADING_RE = /^## \[(\d+\.\d+\.\d+)\] - /;
const PIN_RE = /(--branch\s+v)(\d+\.\d+\.\d+)/g;

// The banner is the one line starting with this marker (#2935). Rewriting
// only within that line — never a whole-file version-string replace — is
// deliberate: the Sprint Reports section further down (and the Kaizen
// retrospective range in the banner itself) link past releases on purpose,
// and a blind substitution would overwrite that history.
const BANNER_LINE_RE = /^\*\*Latest release:\*\*/;
const BANNER_VERSION_RE = /(\*\*Latest release:\*\*\s+`v)(\d+\.\d+\.\d+)(`)/;
const BANNER_STATUS_LINK_RE = /(docs\/releases\/v)(\d+\.\d+\.\d+)(\.md)/;
const BANNER_REPORT_LINK_RE = /(\[`v)(\d+\.\d+\.\d+)(`\s+Sprint Report\]\(https:\/\/jason-vaughan\.github\.io\/TangleClaw\/reports\/v)(\d+\.\d+\.\d+)(\/\))/;

/**
 * Hash the body of every dated release section, in the order they appear.
 *
 * Deliberately a copy of the immutability test's hash, not shared with it: a
 * guard that imports the tool it checks agrees with that tool's bugs.
 *
 * @param {string} text - Full CHANGELOG.md contents
 * @returns {Array<{version:string, hash:string}>} Newest first, as the file lists them
 */
function hashReleasedSections(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    const m = line.match(RELEASE_HEADING_RE);
    if (m) starts.push({ index: i, version: m[1] });
  });
  return starts.map((s, n) => {
    const end = n + 1 < starts.length ? starts[n + 1].index : lines.length;
    const body = lines.slice(s.index + 1, end).join('\n').trim();
    return { version: s.version, hash: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16) };
  });
}

/**
 * Point every README clone pin at `version`.
 *
 * @param {string} readme - README.md contents
 * @param {string} version - Release version
 * @returns {string} Updated contents
 * @throws {Error} When the README pins no release at all
 */
function updatePins(readme, version) {
  if (!PIN_RE.test(readme)) {
    throw new Error('README.md has no `--branch vX.Y.Z` clone pin to update');
  }
  PIN_RE.lastIndex = 0;
  return readme.replace(PIN_RE, `$1${version}`);
}

/**
 * Point the README's top `**Latest release:**` banner at `version`: the
 * version tag, the release-status link (`docs/releases/vX.Y.Z.md`), and the
 * `vX.Y.Z` Sprint Report link both move. Every other line is left untouched,
 * including the Kaizen retrospective range inside the banner itself and the
 * Sprint Reports Hub's own list of past releases further down the file —
 * both intentionally keep old version numbers.
 *
 * @param {string} readme - README.md contents
 * @param {string} version - Release version
 * @returns {string} Updated contents
 * @throws {Error} When the README has no banner line to update
 */
function updateReleaseBanner(readme, version) {
  const lines = readme.split('\n');
  const bannerIndex = lines.findIndex((line) => BANNER_LINE_RE.test(line));
  if (bannerIndex === -1) {
    throw new Error('README.md has no `**Latest release:**` banner line to update');
  }
  let banner = lines[bannerIndex];
  banner = banner.replace(BANNER_VERSION_RE, `$1${version}$3`);
  banner = banner.replace(BANNER_STATUS_LINK_RE, `$1${version}$3`);
  banner = banner.replace(BANNER_REPORT_LINK_RE, `$1${version}$3${version}$5`);
  lines[bannerIndex] = banner;
  return lines.join('\n');
}

/**
 * The lock with this release's section added.
 *
 * @param {Record<string,string>} lock - Current lock
 * @param {string} changelog - CHANGELOG.md contents
 * @param {string} version - Release version
 * @returns {Record<string,string>} New lock, ordered as the CHANGELOG lists releases
 * @throws {Error} When the release has no section, a locked section changed, or
 *   another released section is unlocked
 */
function extendLock(lock, changelog, version) {
  const sections = hashReleasedSections(changelog);
  if (!sections.some((s) => s.version === version)) {
    throw new Error(`CHANGELOG.md has no "## [${version}] - <date>" section to lock`);
  }
  const changed = sections.filter((s) => s.version in lock && lock[s.version] !== s.hash).map((s) => s.version);
  if (changed.length > 0) {
    throw new Error(`already-released CHANGELOG sections changed since they were locked: ${changed.join(', ')}. Not relocking; move the edits back to [Unreleased].`);
  }
  const unlocked = sections.filter((s) => !(s.version in lock) && s.version !== version).map((s) => s.version);
  if (unlocked.length > 0) {
    throw new Error(`released sections other than ${version} are not locked: ${unlocked.join(', ')}. Lock them deliberately; this script only adds the release it is preparing.`);
  }
  const out = {};
  for (const s of sections) out[s.version] = s.hash;
  // A locked version whose heading is gone stays in the lock, so the immutability
  // test still reports it rather than this script quietly forgetting it.
  for (const [v, h] of Object.entries(lock)) if (!(v in out)) out[v] = h;
  return out;
}

/**
 * Bring the README pins and the lock up to the release in `root`.
 *
 * @param {string} root - Repository root
 * @param {object} [env] - Environment to read `TANGLECLAW_RELEASE_VERSION` from
 * @returns {{version:string, changed:string[]}} Repo-relative files this run rewrote
 * @throws {Error} On any refusal
 */
function prepareRelease(root, env = process.env) {
  const pending = readFragments(root);
  if (pending.fragments.length > 0) {
    const names = pending.fragments.map((f) => path.basename(f.path)).join(', ');
    throw new Error(`${FRAGMENT_DIR}/ still holds ${pending.fragments.length} changelog fragment(s) the release did not compile: ${names}. Locking the release without them would publish them twice or never; cut the release through the wrap, which compiles and removes them.`);
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
  const requested = env.TANGLECLAW_RELEASE_VERSION;
  if (requested && requested !== version) {
    throw new Error(`the wrap is releasing ${requested} but version.json says ${version}`);
  }
  const changed = [];
  const readmePath = path.join(root, 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const rebannered = updateReleaseBanner(updatePins(readme, version), version);
  if (rebannered !== readme) {
    fs.writeFileSync(readmePath, rebannered);
    changed.push('README.md');
  }
  const lockPath = path.join(root, LOCK_REL);
  const lockText = fs.readFileSync(lockPath, 'utf8');
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const nextLock = JSON.stringify(extendLock(JSON.parse(lockText), changelog, version), null, 2) + '\n';
  if (nextLock !== lockText) {
    fs.writeFileSync(lockPath, nextLock);
    changed.push(LOCK_REL.split(path.sep).join('/'));
  }
  return { version, changed };
}

/**
 * CLI entry point.
 *
 * @returns {number} Exit code
 */
function main() {
  try {
    const { version, changed } = prepareRelease(path.resolve(__dirname, '..'));
    process.stdout.write(changed.length > 0
      ? `release-prepare ${version}: updated ${changed.join(', ')}\n`
      : `release-prepare ${version}: already current\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`release-prepare refused: ${err.message}\n`);
    return 1;
  }
}

module.exports = { hashReleasedSections, updatePins, updateReleaseBanner, extendLock, prepareRelease, main };

if (require.main === module) process.exitCode = main();
