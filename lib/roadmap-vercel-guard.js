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

/** Static files the roadmap publisher must stage under the Next.js public root. */
const STATIC_EXPORT_TARGETS = Object.freeze([
  Object.freeze({ name: 'roadmap', relativePath: 'public/roadmap/index.html', publicPath: '/roadmap/' }),
  Object.freeze({
    name: 'roadmap-status',
    relativePath: 'public/roadmap/roadmap-sync-status.json',
    publicPath: '/roadmap/roadmap-sync-status.json'
  }),
  Object.freeze({ name: 'reports-index', relativePath: 'public/reports/index.html', publicPath: '/reports/' })
]);

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

/**
 * Inspect the static roadmap/report files staged for a website build.
 *
 * Next.js serves files below `website/public` from the matching URL path. The
 * publisher can therefore stage its generated HTML without coupling the
 * public artifacts to App Router implementation details.
 *
 * @param {string} websiteRoot - Path to the `website` directory.
 * @param {object} [options] - Optional report versions that must be present.
 * @param {string[]} [options.reportVersions] - Directory names below `public/reports`.
 * @returns {{ready: boolean, present: object[], missing: object[]}}
 */
function inspectStaticExport(websiteRoot, { reportVersions = [] } = {}) {
  const versionTargets = reportVersions.map((version) => {
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(version)) {
      throw new TypeError(`invalid report version "${version}"`);
    }
    return {
      name: `report-${version}`,
      relativePath: `public/reports/${version}/index.html`,
      publicPath: `/reports/${version}/`
    };
  });
  const targets = [...STATIC_EXPORT_TARGETS, ...versionTargets].map((target) => {
    const absolutePath = path.join(websiteRoot, target.relativePath);
    let present = false;
    try {
      present = fs.statSync(absolutePath).isFile();
    } catch {
      present = false;
    }
    return { ...target, absolutePath, present };
  });

  return {
    ready: targets.every((target) => target.present),
    present: targets.filter((target) => target.present),
    missing: targets.filter((target) => !target.present)
  };
}

module.exports = {
  GH_PAGES_REF,
  WEBSITE_DIR,
  STATIC_EXPORT_TARGETS,
  websiteDirExists,
  shouldSkipBuild,
  decide,
  inspectStaticExport
};
