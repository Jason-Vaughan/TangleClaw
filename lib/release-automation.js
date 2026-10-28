'use strict';

/**
 * Opt-in release automation for TangleClaw-MANAGED projects (#721).
 *
 * `.github/workflows/release.yml` (#713) tags and publishes TangleClaw's OWN
 * repo automatically once a version bump lands on `main`. A managed project
 * gets nothing: its wrap can bump `version.json` (or `package.json`) and
 * promote `[Unreleased]`, but nothing afterward ever creates the tag the
 * update path actually polls — which is the same defect #713 fixed, one level
 * out. This module is the reusable core that a managed project (or a future
 * wrap step) can call to close that gap for itself, OR scaffold a workflow
 * that closes it on GitHub Actions instead.
 *
 * **Why this is NOT `.github/workflows/release.yml` copied verbatim.** That
 * workflow is TangleClaw's own: it hardcodes `version.json`, assumes GitHub
 * Actions, and shells out to `scripts/release-tag-gate.js` /
 * `scripts/release-notes-gate.js`, neither of which exists outside this repo.
 * None of that generalizes — see #721's own "Why it isn't just 'copy the
 * workflow'" — so this module re-derives the parts that DO generalize
 * (resolve a version, extract its notes, tag, publish) as plain functions a
 * caller can drive from anywhere, plus a self-contained workflow template for
 * the project that wants its tagging to run on GitHub Actions instead.
 *
 * **Strict opt-in.** `planRelease` refuses outright unless the project's
 * config carries `releaseAutomationEnabled: true`. Auto-tagging a project the
 * operator never asked to release from is a destructive surprise — a tag is
 * public and a GitHub Release sends notifications — so there is no probe, no
 * "looks like a release repo" heuristic, and no default-on.
 *
 * **Version source, reused rather than reimplemented.** `version-bump`
 * already solves "which file holds the version" (`version.json`, then
 * `package.json`, then a configured `versionFilePath`, then `pyproject.toml`)
 * in `lib/project-version-files.js`, with its own tests. `resolveVersion`
 * below calls those readers directly instead of re-probing the filesystem a
 * second way, so the version this module tags is always the one the wrap
 * actually bumped — never a second opinion that could disagree with it.
 *
 * **Changelog path, configurable the same way `versionFilePath` is.**
 * `releaseAutomationChangelogPath` (project config) names the changelog
 * relative to the project root; `resolveChangelogPath` runs it through
 * `lib/project-paths.js`'s `resolveConfiguredFile`, the same containment-safe
 * resolver `versionFilePath` is read with, so a configured path can never
 * point outside the project. Unset, it defaults to `CHANGELOG.md`.
 *
 * **Non-GitHub remotes degrade, they don't refuse.** `classifyRemote` reads
 * `origin` and tells a `github.com` remote from any other kind (a self-hosted
 * Gitea/GitLab, a bare path, none at all). `planRelease` turns that into
 * `tag-and-release` only on GitHub; a non-GitHub remote still gets
 * `tag-only` — the thing the update-checker's tag poll needs regardless of
 * where Releases live — and no remote at all is an honest `skip`, never a
 * silent no-op.
 *
 * **Reuses `lib/changelog-notes.js` verbatim** for the one step that already
 * has its own tests and handles both this repo's heading conventions
 * (`## [X.Y.Z]` and bare `## X.Y.Z`) — written, per its own header, precisely
 * so this kind of reuse would not require reimplementing it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { extractReleaseNotes } = require('./changelog-notes');
const projectConfig = require('./project-config');
const projectPaths = require('./project-paths');
const projectVersionFiles = require('./project-version-files');
const { repoOf } = require('./stranded-check');

/** Changelog basename used when no `releaseAutomationChangelogPath` is configured. */
const DEFAULT_CHANGELOG_BASENAME = 'CHANGELOG.md';

/**
 * Whether release automation is turned on for this project.
 *
 * Strict opt-in: anything other than the literal `true` reads as off,
 * including an absent key, `"true"`, or a legacy/typo'd spelling. There is no
 * heuristic default-on, because tagging and publishing are destructive and
 * public the moment they happen.
 *
 * @param {object|null|undefined} config - A project config as `lib/project-config.js`'s `load` returns
 * @returns {boolean}
 */
function isEnabled(config) {
  return !!(config && config.releaseAutomationEnabled === true);
}

/**
 * Resolve the project's current version, reusing the same readers
 * `version-bump` resolves its write target with — `versionFilePath` when
 * configured, else the built-in probe (`version.json`, `package.json`,
 * `pyproject.toml`).
 *
 * Deliberately does NOT consult `CHANGELOG.md` the way
 * `detectLiveVersion`'s dashboard-facing ladder does: that rung exists so the
 * dashboard shows a version even before a file is bumped, which is the wrong
 * answer here — this module tags whatever the version FILE says, the same
 * source version-bump writes, so the tag and the bumped file can never
 * disagree.
 *
 * @param {string} projectRoot - Absolute project root
 * @returns {{version:string, source:string}|null} Null when no version file resolves
 */
function resolveVersion(projectRoot) {
  const configured = projectVersionFiles.readConfiguredVersion(projectRoot);
  if (configured) return configured;
  const probed = projectVersionFiles.readProbedVersion(projectRoot);
  if (probed && probed.version) return { version: probed.version, source: probed.source };
  return null;
}

/**
 * Resolve the changelog path this project's release notes come from.
 *
 * `releaseAutomationChangelogPath` is read through
 * `lib/project-paths.js`'s `resolveConfiguredFile` — the same containment
 * check `versionFilePath` goes through — so a configured value can be a
 * nested path (`plugin/CHANGELOG.md` in a monorepo) but can never resolve
 * outside the project root. Unset, this is `CHANGELOG.md` at the project root.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {object|null|undefined} config - A project config as `load` returns
 * @returns {{ok:true, path:string, label:string}|{ok:false, reason:string}}
 */
function resolveChangelogPath(projectRoot, config) {
  const resolved = projectPaths.resolveConfiguredFile(
    projectRoot, config || {}, 'releaseAutomationChangelogPath'
  );
  if (!resolved.configured) {
    return {
      ok: true,
      path: path.join(projectRoot, DEFAULT_CHANGELOG_BASENAME),
      label: DEFAULT_CHANGELOG_BASENAME
    };
  }
  if (!resolved.ok) {
    return {
      ok: false,
      reason: `configured releaseAutomationChangelogPath ${JSON.stringify(resolved.raw)} is not usable: ${resolved.reason}`
    };
  }
  return { ok: true, path: resolved.path, label: path.basename(resolved.path) };
}

/**
 * Classify this project's `origin` remote: a `github.com` repository, some
 * other remote (self-hosted Git, a bare local path), or none at all.
 *
 * Reuses `lib/stranded-check.js`'s `repoOf` for the URL parsing — it already
 * reads https, ssh and scp-style GitHub remotes, with or without credentials
 * or a `.git` suffix, and has its own tests — rather than a second regex that
 * could disagree with it on an edge case.
 *
 * @param {string} projectRoot - Absolute project root
 * @returns {{kind:'github', url:string, repo:string}|{kind:'other', url:string}|{kind:'none'}}
 *   `repo` is the GitHub `owner/name` slug, suitable for `gh release create --repo`.
 */
function classifyRemote(projectRoot) {
  let url;
  try {
    url = _internal.execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    // No `origin`, or not a git repository at all — either way, nothing to tag.
    return { kind: 'none' };
  }
  if (!url) return { kind: 'none' };
  const hostAndRepo = repoOf(url);
  if (!hostAndRepo) return { kind: 'other', url };
  return { kind: 'github', url, repo: hostAndRepo.slice(hostAndRepo.indexOf('/') + 1) };
}

/**
 * The tag name for a version, in this repo's own convention: a leading `v`,
 * never doubled when the version already carries one.
 *
 * @param {string} version
 * @returns {string}
 */
function tagNameFor(version) {
  return `v${String(version).replace(/^v/, '')}`;
}

/**
 * Decide what release-automation action this project's current state calls
 * for, performing no side effects — no tag, no push, no network call beyond
 * reading `origin`'s configured URL. Pure enough to unit-test directly;
 * `applyRelease` is the half that acts on the result.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {object} [options]
 * @param {object} [options.config] - A pre-loaded project config; defaults to
 *   `lib/project-config.js`'s `load(projectRoot)`. Passing it in lets a
 *   caller that already loaded the config once (a wrap step) avoid a second
 *   read.
 * @returns {{ok:false, action:'skip', reason:string}
 *   |{ok:true, action:'tag-only', version:string, versionSource:string, tagName:string, notes:string, remote:object, reason:string}
 *   |{ok:true, action:'tag-and-release', version:string, versionSource:string, tagName:string, notes:string, remote:object}}
 */
function planRelease(projectRoot, options = {}) {
  const config = options.config || projectConfig.load(projectRoot);

  if (!isEnabled(config)) {
    return {
      ok: false, action: 'skip',
      reason: 'release automation is not enabled for this project (set releaseAutomationEnabled: true to opt in)'
    };
  }

  const version = resolveVersion(projectRoot);
  if (!version) {
    return {
      ok: false, action: 'skip',
      reason: 'no version could be resolved (checked versionFilePath, version.json, package.json, pyproject.toml)'
    };
  }

  const changelog = resolveChangelogPath(projectRoot, config);
  if (!changelog.ok) {
    return { ok: false, action: 'skip', reason: changelog.reason };
  }

  let changelogText;
  try {
    changelogText = fs.readFileSync(changelog.path, 'utf8');
  } catch (err) {
    return { ok: false, action: 'skip', reason: `could not read ${changelog.label}: ${err.message}` };
  }

  const notes = extractReleaseNotes(changelogText, version.version);
  if (!notes) {
    return {
      ok: false, action: 'skip',
      reason: `no ${changelog.label} section found for version ${version.version} — the version was bumped `
        + 'without promoting the matching section, so there are no release notes to publish'
    };
  }

  const remote = classifyRemote(projectRoot);
  const tagName = tagNameFor(version.version);

  if (remote.kind === 'github') {
    return {
      ok: true, action: 'tag-and-release',
      version: version.version, versionSource: version.source,
      tagName, notes, remote
    };
  }
  if (remote.kind === 'other') {
    return {
      ok: true, action: 'tag-only',
      version: version.version, versionSource: version.source,
      tagName, notes, remote,
      reason: 'origin is not a github.com remote — tagging only; no GitHub Release can be published here'
    };
  }
  return { ok: false, action: 'skip', reason: 'no origin remote is configured — nothing to tag or publish to' };
}

/**
 * Carry out a plan `planRelease` produced: create and push an annotated tag,
 * and — only for `tag-and-release` — publish a GitHub Release from it via
 * `gh`.
 *
 * Refuses outright if the tag already exists on `origin`, the same guard
 * `.github/workflows/release.yml` applies: healing a missing Release onto an
 * existing tag is a legitimate retry, but this function does not attempt that
 * healing itself — a tag that is already there means some other run already
 * handled it, or named a different commit entirely, and either way silently
 * re-tagging is wrong. Call this only once per version per remote.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {object} plan - A `{ok:true, ...}` plan from `planRelease`
 * @returns {{ok:true, tagged:true, published:boolean, tagName:string}
 *   |{ok:false, tagged?:boolean, reason:string}}
 */
function applyRelease(projectRoot, plan) {
  if (!plan || plan.ok !== true) {
    return { ok: false, reason: 'refusing to apply a plan that is not ok (call planRelease first and check its result)' };
  }

  const git = (args) => _internal.execFileSync('git', args, {
    cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });

  let remoteTags;
  try {
    // Both the tag ref and its peeled `^{}` deref, matching
    // `.github/workflows/release.yml`'s own check — an annotated tag only
    // shows the commit it names on the second line.
    remoteTags = git(['ls-remote', '--tags', 'origin', `refs/tags/${plan.tagName}`, `refs/tags/${plan.tagName}^{}`]);
  } catch (err) {
    return { ok: false, reason: `could not reach origin to check for ${plan.tagName}: ${err.message}` };
  }
  if (remoteTags && remoteTags.trim()) {
    return { ok: false, reason: `${plan.tagName} already exists on origin — refusing to re-tag it` };
  }

  try {
    git(['tag', '-a', plan.tagName, '-m', `Release ${plan.tagName}`]);
    git(['push', 'origin', plan.tagName]);
  } catch (err) {
    return { ok: false, reason: `could not create or push tag ${plan.tagName}: ${err.message}` };
  }

  if (plan.action !== 'tag-and-release') {
    return { ok: true, tagged: true, published: false, tagName: plan.tagName };
  }

  const notesFile = _internal.writeTempNotesFile(plan.notes);
  try {
    _internal.execFileSync('gh', [
      'release', 'create', plan.tagName,
      '--title', plan.tagName,
      '--notes-file', notesFile,
      '--repo', plan.remote.repo
    ], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // The tag is already pushed and real at this point — say so, rather than
    // reporting a bare failure that reads as "nothing happened" and invites a
    // retry that would hit the already-exists refusal above.
    return {
      ok: false, tagged: true, published: false, tagName: plan.tagName,
      reason: `the tag ${plan.tagName} was pushed, but the GitHub Release could not be published: ${err.message}`
    };
  } finally {
    fs.rmSync(notesFile, { force: true });
  }

  return { ok: true, tagged: true, published: true, tagName: plan.tagName };
}

/**
 * Generate a self-contained GitHub Actions workflow that tags and publishes a
 * release when this project's version file changes on its default branch —
 * the GitHub-Actions equivalent of calling `planRelease` + `applyRelease`
 * from outside, for a project that would rather run its tagging on GitHub's
 * infrastructure than TangleClaw's.
 *
 * Deliberately self-contained: it inlines its own version read and release-
 * notes extraction rather than depending on `scripts/release-tag-gate.js` or
 * `scripts/release-notes-gate.js`, neither of which exists outside this repo
 * — those are a convenience `.github/workflows/release.yml` has BECAUSE it
 * lives in this repo, not a dependency a generated template can assume.
 *
 * This function only returns text. Writing it into a project's
 * `.github/workflows/` is a caller decision, never automatic: scaffolding a
 * workflow file into someone's repo grants it CI write permissions and runs
 * on their Actions minutes, which #721 calls out as a much larger intrusion
 * than anything TangleClaw already generates.
 *
 * @param {object} [options]
 * @param {string} [options.branch='main'] - The branch a version bump must land on to trigger a release
 * @param {string} [options.versionFilePath='version.json'] - Where to read the version from;
 *   read as `require(...).version` when it ends in `.json`, so this covers `version.json` and
 *   `package.json` alike
 * @param {string} [options.changelogPath='CHANGELOG.md'] - Where to extract this version's release notes from
 * @returns {string} YAML workflow content, ending in a trailing newline
 */
function generateReleaseWorkflow(options = {}) {
  const branch = options.branch || 'main';
  const versionFilePath = options.versionFilePath || 'version.json';
  const changelogPath = options.changelogPath || DEFAULT_CHANGELOG_BASENAME;

  return `name: Release

# Tag and publish a release when the version file changes on ${branch}.
# Generated by TangleClaw's release automation (#721) — edit freely, this is
# a starting point, not a managed file TangleClaw will overwrite.

on:
  push:
    branches: [${branch}]
    paths: ['${versionFilePath}']
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  release:
    if: github.ref == 'refs/heads/${branch}'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Read the version being released
        id: version
        shell: bash
        run: |
          set -euo pipefail
          VERSION="$(node -p "require('./${versionFilePath}').version")"
          if [[ ! "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+[A-Za-z0-9.+-]*$ ]]; then
            echo "::error::${versionFilePath} holds an invalid semver version."
            exit 1
          fi
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "tag=v$VERSION" >> "$GITHUB_OUTPUT"

      - name: Check whether this tag already exists
        id: existing
        shell: bash
        env:
          TAG: \${{ steps.version.outputs.tag }}
        run: |
          set -euo pipefail
          if ! REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")"; then
            echo "::error::could not reach origin to check for $TAG."
            exit 1
          fi
          if [ -n "$REMOTE_TAG" ]; then echo "exists=true" >> "$GITHUB_OUTPUT"; else echo "exists=false" >> "$GITHUB_OUTPUT"; fi

      - name: Extract release notes from ${changelogPath}
        if: steps.existing.outputs.exists == 'false'
        shell: bash
        env:
          VERSION: \${{ steps.version.outputs.version }}
        run: |
          set -euo pipefail
          node <<'NODE'
          const fs = require("fs");
          const text = fs.readFileSync("${changelogPath}", "utf8");
          const version = process.env.VERSION.replace(/^v/, "");
          const lines = text.split("\\n");
          const headingRe = /^##\\s+(?:\\[([^\\]]+)\\]|(\\d+\\.\\d+\\.\\d+[^\\s]*))/;
          const anyH2 = /^##\\s+/;
          const fence = /^\\s*(\`\`\`|~~~)/;
          let start = -1, inFence = false;
          for (let i = 0; i < lines.length; i++) {
            if (fence.test(lines[i])) { inFence = !inFence; continue; }
            if (inFence) continue;
            const m = lines[i].match(headingRe);
            if (!m) continue;
            const token = (m[1] || m[2] || "").replace(/^v/, "");
            if (token.toLowerCase() === "unreleased") continue;
            if (token === version) { start = i + 1; break; }
          }
          if (start === -1) { console.error("No " + "${changelogPath}" + " section found for version " + version); process.exit(1); }
          let end = lines.length;
          inFence = false;
          for (let i = start; i < lines.length; i++) {
            if (fence.test(lines[i])) { inFence = !inFence; continue; }
            if (!inFence && anyH2.test(lines[i])) { end = i; break; }
          }
          const body = lines.slice(start, end).join("\\n").trim();
          if (!body) { console.error("Empty " + "${changelogPath}" + " section for version " + version); process.exit(1); }
          fs.writeFileSync("release-notes.md", body + "\\n");
          NODE

      - name: Create and push the tag
        if: steps.existing.outputs.exists == 'false'
        shell: bash
        env:
          TAG: \${{ steps.version.outputs.tag }}
        run: |
          set -euo pipefail
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git tag -a "$TAG" -m "Release $TAG"
          git push origin "$TAG"

      - name: Publish the GitHub Release
        if: steps.existing.outputs.exists == 'false'
        shell: bash
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          TAG: \${{ steps.version.outputs.tag }}
        run: |
          set -euo pipefail
          gh release create "$TAG" --title "$TAG" --notes-file release-notes.md
`;
}

/**
 * Write a temporary file holding release notes, for `gh release create
 * --notes-file`. Kept in `_internal` so a test can stub the write without
 * touching the real filesystem.
 *
 * @param {string} notes
 * @returns {string} Absolute path to the written file
 */
function _writeTempNotesFile(notes) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-notes-')), 'notes.md');
  fs.writeFileSync(file, `${notes}\n`);
  return file;
}

/**
 * Seam for tests: every subprocess call and the one filesystem write
 * `applyRelease` performs beyond reading the changelog, so a test can stub
 * git/gh invocations without touching a real repository or network.
 */
const _internal = {
  execFileSync,
  writeTempNotesFile: _writeTempNotesFile
};

module.exports = {
  isEnabled,
  resolveVersion,
  resolveChangelogPath,
  classifyRemote,
  tagNameFor,
  planRelease,
  applyRelease,
  generateReleaseWorkflow,
  _internal
};
