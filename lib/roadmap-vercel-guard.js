'use strict';

/*
 * Vercel "Ignored Build Step" guard for the roadmap publisher (#2258).
 *
 * The roadmap sync job pushes to the `gh-pages` branch, which holds only the
 * published static page and has no `website` root directory. Vercel's
 * project is configured with `website` as its Root Directory, so a build
 * triggered for `gh-pages` always fails before it can build anything,
 * notifying on every roadmap refresh. Nothing production depends on that
 * build: `main` is what Vercel actually serves, and the roadmap itself is
 * served from GitHub Pages, not Vercel.
 *
 * Vercel's Ignored Build Step convention: exit 0 skips the build, any other
 * exit code lets it proceed. `scripts/vercel-ignore-gh-pages.sh` is the thin
 * shell entry point Vercel's dashboard setting calls; this module holds the
 * decision so it can be unit-tested without spawning a process.
 */

const fs = require('fs');
const path = require('path');

/** The branch the roadmap publisher pushes to, which Vercel cannot build. */
const GH_PAGES_REF = 'gh-pages';

/** The directory Vercel's project expects as its build root. */
const WEBSITE_DIR = 'website';

/**
 * Whether the build's root directory exists in the checkout Vercel cloned.
 *
 * @param {string} [root] - The checkout root; the current working directory when omitted.
 * @returns {boolean}
 */
function websiteDirExists(root = process.cwd()) {
  try {
    return fs.statSync(path.join(root, WEBSITE_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a Vercel build for this ref should be skipped: the `gh-pages`
 * branch itself, or any ref whose checkout has no `website` directory to
 * build (the same condition that would otherwise fail during the build).
 *
 * @param {object} input - What the decision needs.
 * @param {string} [input.ref] - `VERCEL_GIT_COMMIT_REF`, the branch or tag being built.
 * @param {boolean} input.hasWebsiteDir - Whether the checkout has a `website` directory.
 * @returns {boolean} `true` to skip the build.
 */
function shouldSkipBuild({ ref, hasWebsiteDir }) {
  if (ref === GH_PAGES_REF) return true;
  return !hasWebsiteDir;
}

/**
 * The guard's decision for the real process: reads `VERCEL_GIT_COMMIT_REF`
 * and checks the checkout on disk.
 *
 * @param {object} [env] - The environment to read `VERCEL_GIT_COMMIT_REF` from; `process.env` when omitted.
 * @param {string} [root] - The checkout root; the current working directory when omitted.
 * @returns {boolean} `true` to skip the build.
 */
function decide(env = process.env, root = process.cwd()) {
  return shouldSkipBuild({ ref: env.VERCEL_GIT_COMMIT_REF, hasWebsiteDir: websiteDirExists(root) });
}

module.exports = {
  GH_PAGES_REF,
  WEBSITE_DIR,
  websiteDirExists,
  shouldSkipBuild,
  decide
};
