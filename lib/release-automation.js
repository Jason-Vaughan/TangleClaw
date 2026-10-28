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
 * **Version source mirrors `version-bump`'s rungs, but a configured one is
 * strict, not probed past.** `version-bump` already solves "which file holds
 * the version" (`version.json`, then `package.json`, then `pyproject.toml`,
 * or a configured `versionFilePath`) in `lib/project-version-files.js`.
 * `resolveVersion` below reuses `readProbedVersion` for the UNCONFIGURED
 * case, but deliberately does NOT reuse `readConfiguredVersion` — that
 * reader degrades to the probe on a bad configured file, which is correct
 * for its own caller (a dashboard display value) and wrong here: a release
 * that silently tags a DIFFERENT file than the one actually named would
 * repeat the exact failure class `version-bump`'s own docstring warns about.
 * When `versionFilePath` is configured, it is the ONLY candidate — it
 * resolves or this module fails closed, with no fallback.
 *
 * **Changelog path, configurable the same way `versionFilePath` is.**
 * `releaseAutomationChangelogPath` (project config) names the changelog
 * relative to the project root; `resolveChangelogPath` runs it through
 * `lib/project-paths.js`'s `resolveConfiguredFile`, the same containment-safe
 * resolver `versionFilePath` is read with, so a configured path can never
 * point outside the project. Unset, it defaults to `CHANGELOG.md`.
 *
 * **The plan captures the exact commit, and refuses a dirty working tree.**
 * `planRelease` reads `HEAD` once and refuses outright if the resolved
 * version file or changelog carries an uncommitted change — tagging `HEAD`
 * in that state would tag a commit whose actually-committed files disagree
 * with the version/notes just read. The captured sha rides with the plan as
 * `headSha`; `applyRelease` tags that commit explicitly, never the implicit
 * `HEAD` at apply time, so a commit landing on the branch between planning
 * and applying can never silently retarget what gets released.
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
 * **Deliberately does NOT call `readConfiguredVersion` OR `readProbedVersion`
 * for their leniency**, even though both honor the same files — they are
 * written for the DASHBOARD's lenient detection (its own docstring: "a
 * reason to keep looking, not to fail the wrap"), so a bad file there
 * silently degrades to the next candidate. `readProbedVersion` in particular
 * reads PAST an invalid `version.json` to `package.json` (its own docstring,
 * #58) — `version-bump`'s own write-path `_resolveVersionSource` does NOT:
 * once `version.json` exists, it is the ONLY candidate — a problem with it
 * refuses outright, with no fallback to `package.json`. Only a `package.json`
 * that parses but carries no `version` field (`noVersion` below) continues
 * to `pyproject.toml`; nothing else does. `_probeVersion` below re-derives
 * that exact asymmetry rather than reusing either lenient reader, because
 * silently tagging a DIFFERENT file than version-bump would have bumped is
 * exactly the failure mode its docstring warns about ("There is deliberately
 * no fallback, because falling through is how a project... ended up bumping
 * an unrelated package.json").
 *
 * **Content is read from the COMMITTED blob at `headSha`, never the working
 * tree.** A file that is gitignored and was never committed is invisible to
 * `git status --porcelain` (empty status), so a dirty-working-tree check
 * alone cannot catch it — reading `git show <headSha>:<path>` instead fails
 * closed on exactly that case, and guarantees the version this module tags
 * is the one actually IN the commit being tagged, not whatever happens to be
 * on disk.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string} headSha - The commit being planned against (`planRelease` captures this)
 * @param {object|null|undefined} [config] - A project config as `load` returns;
 *   defaults to loading it fresh. Needed to read `versionFilePath`.
 * @returns {{ok:true, version:string, source:string, path:string}|{ok:false, reason:string}}
 */
function resolveVersion(projectRoot, headSha, config) {
  const cfg = config || projectConfig.load(projectRoot);

  const resolvedConfigured = projectPaths.resolveConfiguredFile(projectRoot, cfg, 'versionFilePath');
  if (resolvedConfigured.configured) {
    if (!resolvedConfigured.ok) {
      return {
        ok: false,
        reason: `configured versionFilePath ${JSON.stringify(resolvedConfigured.raw)} is not usable `
          + `(${resolvedConfigured.reason}) — refusing to fall back to another version file`
      };
    }
    // The configured path is the ONLY candidate, whatever its failure mode —
    // `noVersion` is not honored here, unlike in the probe below.
    const result = _readVersionFileStrict(projectRoot, headSha, resolvedConfigured.path);
    return result.ok ? result : { ok: false, reason: result.reason };
  }

  return _probeVersion(projectRoot, headSha);
}

/**
 * The unconfigured probe, mirroring `version-bump`'s own ladder: `version.json`,
 * then `package.json`, then `pyproject.toml`. Existence is checked on disk —
 * a candidate that does not exist is skipped to the next, exactly as
 * `version-bump` does — but a candidate that DOES exist is read from the
 * committed blob at `headSha`, not the working tree (see `resolveVersion`'s
 * docstring). `version.json`, once present, is the ONLY candidate: anything
 * wrong with it refuses immediately. `package.json` continues to
 * `pyproject.toml` ONLY when it parses but carries no `version` field
 * (`result.noVersion`); any other problem with it (unreadable, bad JSON, a
 * non-string version) refuses there too, never reaching `pyproject.toml`.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string} headSha - The commit being planned against
 * @returns {{ok:true, version:string, source:string, path:string}|{ok:false, reason:string}}
 */
function _probeVersion(projectRoot, headSha) {
  const versionPath = path.join(projectRoot, 'version.json');
  if (fs.existsSync(versionPath)) {
    return _readVersionFileStrict(projectRoot, headSha, versionPath);
  }

  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const result = _readVersionFileStrict(projectRoot, headSha, pkgPath);
    if (result.ok || !result.noVersion) return result;
    // else: package.json parses but has no "version" field — fall through.
  }

  const pyPath = path.join(projectRoot, projectVersionFiles.PYPROJECT_FILENAME);
  if (fs.existsSync(pyPath)) {
    return _readVersionFileStrict(projectRoot, headSha, pyPath);
  }

  return { ok: false, reason: 'no version could be resolved (checked version.json, package.json, pyproject.toml)' };
}

/**
 * Read exactly one named file's version from its COMMITTED blob at `headSha`
 * — the strict half both `resolveVersion`'s configured branch and
 * `_probeVersion` need. Unlike `lib/wrap-steps/version-bump.js`'s
 * `_resolveVersionSource` (whose semantics this mirrors) this never WRITES;
 * it only reads, because this module never bumps a version, only tags one
 * that was already bumped.
 *
 * `noVersion: true` is set ONLY when the file parses fine but carries no
 * version at all — the one failure mode `_probeVersion`'s `package.json`
 * rung is allowed to continue past. Every other failure (unreadable, not
 * committed, bad JSON, a non-string version) carries no such flag, so a
 * caller that does not explicitly check for it refuses as it should.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string} headSha - The commit to read the file from
 * @param {string} filePath - Absolute path to a JSON version file or a `pyproject.toml`
 * @returns {{ok:true, version:string, source:string, path:string}|{ok:false, reason:string, noVersion?:true}}
 */
function _readVersionFileStrict(projectRoot, headSha, filePath) {
  const label = path.basename(filePath);
  const committed = _readCommittedBlob(projectRoot, headSha, filePath);
  if (!committed.ok) return { ok: false, reason: `${label} ${committed.reason}` };
  const text = committed.text;

  if (label.toLowerCase() === projectVersionFiles.PYPROJECT_FILENAME) {
    // parsePyprojectVersion returns {ok, version, start, end} on success or
    // {ok:false, noVersion?, reason} on failure — never a bare string, and
    // never falsy on failure either (it is always an object). Checking
    // `parsed.ok` and reading `parsed.version` explicitly is required: `if
    // (!parsed)` is always false, so a bare truthiness check would wrap the
    // whole result object as the version instead of refusing.
    const parsed = projectVersionFiles.parsePyprojectVersion(text);
    if (!parsed.ok || typeof parsed.version !== 'string' || parsed.version.trim() === '') {
      return {
        ok: false,
        reason: `${label} has no usable static [project] version`,
        ...(parsed.noVersion ? { noVersion: true } : {})
      };
    }
    return { ok: true, version: parsed.version.trim(), source: label, path: filePath };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `${label} unreadable as JSON (${err.message})` };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, reason: `${label} is not an object` };
  }
  const v = json.version;
  if (typeof v !== 'string' || v.trim() === '') {
    return { ok: false, reason: `${label} has no "version" field — nothing to tag`, noVersion: true };
  }
  return { ok: true, version: v.trim(), source: label, path: filePath };
}

/**
 * Read a file's content from a specific commit, never the working tree.
 *
 * This is what makes a gitignored-and-never-committed file fail closed: `git
 * status --porcelain` reports nothing for a gitignored path, so a dirty-tree
 * check alone would read it as "clean" even though it was never part of any
 * commit. `git show <sha>:<path>` instead fails outright when the path is
 * absent from that commit's tree, which is the authoritative answer.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string} headSha - The commit to read from
 * @param {string} filePath - Absolute path within the project
 * @returns {{ok:true, text:string}|{ok:false, reason:string}}
 */
function _readCommittedBlob(projectRoot, headSha, filePath) {
  const relPath = path.relative(projectRoot, filePath);
  try {
    const text = _internal.execFileSync('git', ['show', `${headSha}:${relPath}`], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      reason: `is not committed at ${headSha.slice(0, 12)} — ${String(err.message).split('\n')[0]}`
    };
  }
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
 * Whether any of `paths` (absolute) carries an uncommitted change relative to
 * `HEAD` — modified, staged, or untracked. Used to refuse planning a release
 * from a working tree whose version or changelog file disagrees with what is
 * actually committed: tagging HEAD would then tag a commit whose on-disk
 * `version.json`/`CHANGELOG.md` says something OTHER than what was just read,
 * publishing a release for a version that was never really landed. This is
 * the same invariant `docs/release-process.md` "Tag and version must agree"
 * states for TangleClaw's own repo, applied here before a tag is even
 * planned rather than diagnosed after the fact.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string[]} paths - Absolute paths to check
 * @returns {{dirty:true, path:string}|{dirty:false}} The first dirty path found, if any
 */
function _firstDirtyReleaseInput(projectRoot, paths) {
  for (const absPath of paths) {
    const rel = path.relative(projectRoot, absPath);
    let out;
    try {
      out = _internal.execFileSync('git', ['status', '--porcelain', '--', rel], {
        cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      // A failed status read is caught by the headSha read right beside this
      // call, which runs the same command class — surfacing the same error
      // there is enough; here it is safer to treat an unreadable status as
      // "cannot confirm clean" than to let a release proceed unchecked.
      return { dirty: true, path: rel };
    }
    if (out && out.trim()) return { dirty: true, path: rel };
  }
  return { dirty: false };
}

/**
 * Decide what release-automation action this project's current state calls
 * for, performing no side effects — no tag, no push, no network call beyond
 * reading `origin`'s configured URL and `HEAD`'s sha. Pure enough to
 * unit-test directly; `applyRelease` is the half that acts on the result.
 *
 * **Captures the exact commit the plan is about, and refuses on a dirty
 * input.** `headSha` is `HEAD` at the moment of planning, and
 * `applyRelease` tags THAT sha explicitly rather than whatever `HEAD`
 * happens to be when it runs — so a commit landing on this branch between
 * planning and applying can never silently retarget the tag. And if the
 * resolved version file or changelog carries an uncommitted change, planning
 * refuses outright: tagging HEAD in that state would tag a commit whose
 * committed files disagree with the version/notes just read from the
 * working tree.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {object} [options]
 * @param {object} [options.config] - A pre-loaded project config; defaults to
 *   `lib/project-config.js`'s `load(projectRoot)`. Passing it in lets a
 *   caller that already loaded the config once (a wrap step) avoid a second
 *   read.
 * @returns {{ok:false, action:'skip', reason:string}
 *   |{ok:true, action:'tag-only', version:string, versionSource:string, tagName:string, notes:string, remote:object, headSha:string, reason:string}
 *   |{ok:true, action:'tag-and-release', version:string, versionSource:string, tagName:string, notes:string, remote:object, headSha:string}}
 */
function planRelease(projectRoot, options = {}) {
  const config = options.config || projectConfig.load(projectRoot);

  if (!isEnabled(config)) {
    return {
      ok: false, action: 'skip',
      reason: 'release automation is not enabled for this project (set releaseAutomationEnabled: true to opt in)'
    };
  }

  let headSha;
  try {
    headSha = _internal.execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (err) {
    return { ok: false, action: 'skip', reason: `could not resolve HEAD: ${err.message}` };
  }

  const version = resolveVersion(projectRoot, headSha, config);
  if (!version.ok) {
    return { ok: false, action: 'skip', reason: version.reason };
  }

  const changelog = resolveChangelogPath(projectRoot, config);
  if (!changelog.ok) {
    return { ok: false, action: 'skip', reason: changelog.reason };
  }

  // Both inputs read from the COMMITTED blob at headSha, never the working
  // tree — a gitignored-and-never-committed file is invisible to `git
  // status --porcelain` (empty status reads as "clean"), so only a read
  // against the actual commit can catch it. The dirty check below is kept
  // too, for a friendlier refusal on the far more common case (a real,
  // tracked uncommitted edit) before reaching for git internals.
  const dirty = _firstDirtyReleaseInput(projectRoot, [version.path, changelog.path]);
  if (dirty.dirty) {
    return {
      ok: false, action: 'skip',
      reason: `${dirty.path} has uncommitted changes — commit the release inputs before planning a release, `
        + 'so the tag matches what is actually on this commit'
    };
  }

  const committedChangelog = _readCommittedBlob(projectRoot, headSha, changelog.path);
  if (!committedChangelog.ok) {
    return { ok: false, action: 'skip', reason: `${changelog.label} ${committedChangelog.reason}` };
  }

  const notes = extractReleaseNotes(committedChangelog.text, version.version);
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
      tagName, notes, remote, headSha
    };
  }
  if (remote.kind === 'other') {
    return {
      ok: true, action: 'tag-only',
      version: version.version, versionSource: version.source,
      tagName, notes, remote, headSha,
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
 * Tags `plan.headSha` explicitly, never the implicit `HEAD` at call time —
 * see the tagging step below for why. Refuses if the plan carries no
 * `headSha` at all (a hand-built plan object rather than one `planRelease`
 * actually produced).
 *
 * @param {string} projectRoot - Absolute project root
 * @param {object} plan - A `{ok:true, ...}` plan from `planRelease`, with its `headSha`
 * @returns {{ok:true, tagged:true, published:boolean, tagName:string}
 *   |{ok:false, tagged?:boolean, reason:string}}
 */
function applyRelease(projectRoot, plan) {
  if (!plan || plan.ok !== true) {
    return { ok: false, reason: 'refusing to apply a plan that is not ok (call planRelease first and check its result)' };
  }
  if (!plan.headSha) {
    return { ok: false, reason: 'plan carries no headSha — it was not produced by planRelease, refusing to tag an implicit HEAD' };
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
    // Tags `plan.headSha` EXPLICITLY — the commit `planRelease` actually read
    // its version and notes from — never the implicit (current) `HEAD`. A
    // commit landing on this branch between planning and applying (another
    // push, a concurrent wrap) must not silently retarget what gets tagged;
    // `git tag <name> <sha>` names its target directly, so it is correct
    // regardless of where `HEAD` has moved to by the time this runs.
    git(['tag', '-a', plan.tagName, '-m', `Release ${plan.tagName}`, plan.headSha]);
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
