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
 * Whether the checkout has a `website/package.json` — a `website/`
 * directory alone is not buildable (#3116): the orphan `gh-pages` branch can
 * carry one with nothing but {@link stageGhPagesVercelGuard}'s staged
 * `vercel.json` inside it, which still has no application to build.
 *
 * @param {string} [root] - The checkout root; the current working directory when omitted.
 * @returns {boolean}
 */
function hasWebsitePackageJson(root = process.cwd()) {
  try {
    return fs.statSync(path.join(root, WEBSITE_DIR, 'package.json')).isFile();
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
  return shouldSkipBuild({ ref: env.VERCEL_GIT_COMMIT_REF, hasWebsiteDir: hasWebsitePackageJson(root) });
}

/**
 * The Vercel project-root config {@link stageGhPagesVercelGuard} writes into
 * a `gh-pages` checkout (#3116): unlike `main`'s conditional `ignoreCommand`
 * (`scripts/vercel-ignore-gh-pages.sh`, which checks the ref), this guard
 * skips unconditionally — the orphan branch carries no application code, so
 * there is nothing on it that would ever need to build.
 * @returns {object}
 */
function _ghPagesGuardConfig() {
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    ignoreCommand: 'exit 0',
    git: { deploymentEnabled: { [GH_PAGES_REF]: false } }
  };
}

/**
 * Stage both Vercel project-root configs a `gh-pages` push needs so Vercel's
 * webhook never attempts a build there (#3116): `vercel.json` at `siteRoot`
 * for the repository-root project, and `website/vercel.json` so the
 * `website` Root Directory a differently-configured project expects always
 * exists on this branch too — the failure this closes ("Root Directory
 * 'website' does not exist") can recur even before either file's own
 * `ignoreCommand` runs otherwise. Overwrites both files unconditionally, so
 * calling it again (e.g. on the next sync) is a deterministic no-op.
 * @param {string} siteRoot - The `gh-pages` checkout's working directory.
 * @returns {void}
 */
function stageGhPagesVercelGuard(siteRoot) {
  const config = JSON.stringify(_ghPagesGuardConfig(), null, 2) + '\n';
  const websiteDir = path.join(siteRoot, WEBSITE_DIR);
  fs.mkdirSync(websiteDir, { recursive: true });
  fs.writeFileSync(path.join(websiteDir, 'vercel.json'), config);
  fs.writeFileSync(path.join(siteRoot, 'vercel.json'), config);
}

/**
 * Append the markers that make a `gh-pages` commit skip both CI and Vercel
 * at the webhook layer (#3116): `[skip ci]` for GitHub Actions, `[vercel
 * skip]` for Vercel's own commit-message convention — belt-and-suspenders
 * alongside {@link stageGhPagesVercelGuard}'s config-level guard.
 * @param {string} summary - The commit message's first line / summary.
 * @returns {string}
 */
function formatGhPagesCommitMessage(summary) {
  return `${summary} [skip ci] [vercel skip]`;
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
  hasWebsitePackageJson,
  shouldSkipBuild,
  decide,
  stageGhPagesVercelGuard,
  formatGhPagesCommitMessage,
  inspectStaticExport
};
