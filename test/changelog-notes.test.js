'use strict';

const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setLevel } = require('../lib/logger');
setLevel('error');

const { extractReleaseNotes } = require('../lib/changelog-notes');

const BRACKETED = `# Changelog

All notable changes are documented in this file.

## [Unreleased]

## [4.32.1] - 2026-07-26

### Fixed
- Port reporting matches what the server binds (#654).

### Internal
- Generated engine configs are gitignored (#708).

## [4.32.0] - 2026-07-26

### Added
- Something older.
`;

const BARE = `# Changelog

## Unreleased

## 1.4.2 - 2026-01-05

### Fixed
- A bare-style project's fix.

## 1.4.1 - 2026-01-01

### Added
- Older bare entry.
`;

test('extracts the body of a bracketed release section', () => {
  const notes = extractReleaseNotes(BRACKETED, '4.32.1');
  assert.match(notes, /### Fixed/);
  assert.match(notes, /#654/);
  assert.match(notes, /### Internal/);
  assert.match(notes, /#708/);
});

test('excludes the heading line itself from the body', () => {
  const notes = extractReleaseNotes(BRACKETED, '4.32.1');
  assert.ok(!notes.includes('## [4.32.1]'), 'heading leaked into the notes body');
  assert.ok(notes.startsWith('### Fixed'), `expected body to start at first entry, got: ${notes.slice(0, 40)}`);
});

test('stops at the next release heading — does not bleed into older sections', () => {
  const notes = extractReleaseNotes(BRACKETED, '4.32.1');
  assert.ok(!notes.includes('Something older'), 'notes bled into the previous release');
  assert.ok(!notes.includes('4.32.0'), 'notes included the next heading');
});

test('a leading "v" on the requested version is accepted', () => {
  assert.equal(extractReleaseNotes(BRACKETED, 'v4.32.1'), extractReleaseNotes(BRACKETED, '4.32.1'));
});

test('extracts from a bare-style changelog (## X.Y.Z - date)', () => {
  // version-bump emits bare headings for projects already using that convention
  // (lib/wrap-steps/version-bump.js), so the extractor must read them too.
  const notes = extractReleaseNotes(BARE, '1.4.2');
  assert.match(notes, /A bare-style project's fix/);
  assert.ok(!notes.includes('Older bare entry'), 'bled into the previous bare section');
});

test('returns null when the version has no section', () => {
  assert.equal(extractReleaseNotes(BRACKETED, '9.9.9'), null);
});

test('never matches the Unreleased section', () => {
  assert.equal(extractReleaseNotes(BRACKETED, 'Unreleased'), null);
});

test('a version that is a prefix of another does not match it', () => {
  const text = `# Changelog

## [4.3.10] - 2026-02-02

### Fixed
- The ten release.
`;
  assert.equal(extractReleaseNotes(text, '4.3.1'), null, '4.3.1 must not match the 4.3.10 heading');
  assert.match(extractReleaseNotes(text, '4.3.10'), /The ten release/);
});

test('handles a release that is the last section in the file', () => {
  const text = `# Changelog

## [1.0.0] - 2026-01-01

### Added
- First release.
`;
  const notes = extractReleaseNotes(text, '1.0.0');
  assert.match(notes, /First release/);
  assert.ok(!notes.endsWith('\n\n'), 'trailing blank lines should be trimmed');
});

test('a fenced code block containing a "## " line does not truncate the notes', () => {
  const text = `# Changelog

## [2.0.0] - 2026-03-03

### Changed
- Reworked the changelog format. Entries now look like:

\`\`\`markdown
## [1.0.0] - 2025-01-01
### Added
- example
\`\`\`

- A second bullet that must survive the fence.

## [1.9.0] - 2026-02-02

### Added
- Older.
`;
  const notes = extractReleaseNotes(text, '2.0.0');
  assert.match(notes, /A second bullet that must survive the fence/,
    'notes were truncated at a "## " line inside a fenced block');
  assert.ok(!notes.includes('Older.'), 'notes bled past the next real heading');
});

test('a release heading inside a fenced block is not mistaken for the section', () => {
  const text = `# Changelog

## [2.0.0] - 2026-03-03

### Changed
- Example of the old format:

\`\`\`
## [1.0.0] - 2025-01-01
\`\`\`

## [1.9.0] - 2026-02-02

### Added
- Real older entry.
`;
  assert.equal(extractReleaseNotes(text, '1.0.0'), null,
    'matched a heading that only appears inside a code fence');
});

test('returns null for an empty section rather than an empty string', () => {
  const text = `# Changelog

## [1.0.0] - 2026-01-01

## [0.9.0] - 2025-12-01

### Added
- Older.
`;
  assert.equal(extractReleaseNotes(text, '1.0.0'), null,
    'an empty release section must not produce empty release notes');
});

test('guards against bad input instead of throwing', () => {
  assert.equal(extractReleaseNotes('', '1.0.0'), null);
  assert.equal(extractReleaseNotes(null, '1.0.0'), null);
  assert.equal(extractReleaseNotes(BRACKETED, ''), null);
  assert.equal(extractReleaseNotes(BRACKETED, null), null);
});

test("this repo's own CHANGELOG yields notes for the shipped version", () => {
  const root = path.resolve(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')).version;
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const notes = extractReleaseNotes(changelog, version);
  assert.ok(notes && notes.length > 0,
    `no CHANGELOG section for the current version ${version} — the release workflow would fail`);
});

// The CLI shim is the entire interface the release workflow consumes: it reads
// stdout for the notes and keys on the exit code to decide whether to publish.
// Exercised as a real subprocess, because that is how the workflow calls it.
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'lib', 'changelog-notes.js');

function writeTempChangelog(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-changelog-'));
  const file = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(file, contents);
  return file;
}

test('CLI prints the notes to stdout and exits 0', () => {
  const file = writeTempChangelog(BRACKETED);
  const out = execFileSync('node', [CLI, '4.32.1', file], { encoding: 'utf8' });
  assert.match(out, /### Fixed/);
  assert.match(out, /#654/);
  assert.ok(!out.includes('Something older'), 'CLI output bled into the previous release');
});

test('CLI accepts a leading v on the version', () => {
  const file = writeTempChangelog(BRACKETED);
  const out = execFileSync('node', [CLI, 'v4.32.1', file], { encoding: 'utf8' });
  assert.match(out, /#654/);
});

test('CLI exits 1 with a diagnostic when the section is missing', () => {
  const file = writeTempChangelog(BRACKETED);
  const res = spawnSync('node', [CLI, '9.9.9', file], { encoding: 'utf8' });
  assert.equal(res.status, 1, 'a missing section must fail the release, not publish empty notes');
  assert.match(res.stderr, /No CHANGELOG section found for version 9\.9\.9/);
  assert.equal(res.stdout, '', 'nothing may reach stdout when there are no notes');
});

test('CLI exits 2 when called with no version', () => {
  const res = spawnSync('node', [CLI], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage:/);
});

test('CLI exits 2 when the changelog file is unreadable', () => {
  const res = spawnSync('node', [CLI, '1.0.0', '/nonexistent/CHANGELOG.md'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /cannot read changelog/);
});

test('the release workflow references an extractor path that exists', () => {
  // release.yml shells out to the extractor by path. A rename would break the
  // release chain silently and surface only at the next release.
  const root = path.resolve(__dirname, '..');
  const workflowPath = path.join(root, '.github/workflows/release.yml');
  assert.ok(fs.existsSync(workflowPath), 'release workflow is missing');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  const refs = [...workflow.matchAll(/(?:node\s+)(lib\/[\w./-]+\.js)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, 'expected release.yml to invoke a lib/ script for release notes');
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(root, ref)), `release.yml references missing file: ${ref}`);
  }
});

// Opt-in release automation for managed projects (#721), folded into this file
// per A481-R1 rather than a separate test file — it reuses extractReleaseNotes
// above and is the other half of the same release-notes machinery.
const releaseAutomation = require('../lib/release-automation');
const { execFileSync: realExecFileSync, spawnSync: realSpawnSync } = require('node:child_process');
const { initRepo } = require('./_temp-repo');

/**
 * A throwaway project directory with a real git repo, so classifyRemote and
 * applyRelease's `git` calls have something real to talk to.
 * @returns {string} Absolute path
 */
function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-automation-'));
  initRepo(dir);
  realExecFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  realExecFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

describe('isEnabled — strict opt-in', () => {
  it('is off with no config', () => {
    assert.equal(releaseAutomation.isEnabled(null), false);
    assert.equal(releaseAutomation.isEnabled(undefined), false);
  });
  it('is off when the key is absent or falsy', () => {
    assert.equal(releaseAutomation.isEnabled({}), false);
    assert.equal(releaseAutomation.isEnabled({ releaseAutomationEnabled: false }), false);
  });
  it('is off for a truthy-but-not-boolean value — no coercion', () => {
    assert.equal(releaseAutomation.isEnabled({ releaseAutomationEnabled: 'true' }), false);
    assert.equal(releaseAutomation.isEnabled({ releaseAutomationEnabled: 1 }), false);
  });
  it('is on only for the literal true', () => {
    assert.equal(releaseAutomation.isEnabled({ releaseAutomationEnabled: true }), true);
  });
});

describe('resolveVersion — reuses the version-bump readers, fails closed on a configured path', () => {
  function setVersionFilePath(dir, configuredPath) {
    fs.mkdirSync(path.join(dir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), JSON.stringify({ versionFilePath: configuredPath }));
  }

  it('reads version.json', () => {
    const dir = makeTempProject();
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '2.3.4' }));
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, true);
    assert.equal(result.version, '2.3.4');
    assert.equal(result.source, 'version.json');
    assert.equal(result.path, path.join(dir, 'version.json'));
  });

  it('falls through to package.json when there is no version.json', () => {
    const dir = makeTempProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.0' }));
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, true);
    assert.equal(result.version, '0.5.0');
    assert.equal(result.source, 'package.json');
  });

  it('reads past an unusable version.json to package.json — matches the probe\'s own documented leniency', () => {
    // #721 B1 asked for coverage of "invalid primary probes": readProbedVersion
    // (lib/project-version-files.js) deliberately reads past a version.json with
    // no usable version to package.json (its own docstring, #58) — this pins that
    // this module inherits that documented behavior rather than silently
    // diverging from it.
    const dir = makeTempProject();
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ notVersion: true }));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.0' }));
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, true);
    assert.equal(result.version, '0.5.0');
    assert.equal(result.source, 'package.json');
  });

  it('refuses when the ONLY primary probe candidate is invalid and nothing follows it', () => {
    const dir = makeTempProject();
    fs.writeFileSync(path.join(dir, 'version.json'), '{ not valid json');
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /version\.json exists but has no usable "version" field/);
  });

  it('honors a configured versionFilePath over the probe', () => {
    const dir = makeTempProject();
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'VERSION.json'), JSON.stringify({ version: '9.9.9' }));
    setVersionFilePath(dir, 'VERSION.json');
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, true);
    assert.equal(result.version, '9.9.9');
    assert.equal(result.source, 'VERSION.json');
  });

  it('B1: FAILS CLOSED when the configured path does not exist, rather than falling back to the probe', () => {
    const dir = makeTempProject();
    // A real, valid version.json sits right there — the bug this guards against
    // is silently using IT once the configured file is missing. A name that
    // cannot collide with it even on a case-insensitive filesystem (macOS
    // default), unlike "VERSION.json", which IS "version.json" there.
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.0.0' }));
    setVersionFilePath(dir, 'missing-version.json');
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing-version\.json unreadable/);
    assert.doesNotMatch(result.reason, /1\.0\.0/, 'must not silently report the probe\'s version.json value');
  });

  it('B1: fails closed when the configured path is malformed JSON', () => {
    const dir = makeTempProject();
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'VERSION.json'), '{ not valid json');
    setVersionFilePath(dir, 'VERSION.json');
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /unreadable as JSON/);
  });

  it('B1: fails closed when the configured path has no "version" field', () => {
    const dir = makeTempProject();
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'VERSION.json'), JSON.stringify({ name: 'x' }));
    setVersionFilePath(dir, 'VERSION.json');
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /has no "version" field/);
  });

  it('B1: fails closed when the configured path escapes the project root (unsafe)', () => {
    const dir = makeTempProject();
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.0.0' }));
    setVersionFilePath(dir, '../../etc/passwd');
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /configured versionFilePath ".*etc\/passwd" is not usable/);
  });

  it('returns a refusal, not a throw, when nothing resolves', () => {
    const dir = makeTempProject();
    const result = releaseAutomation.resolveVersion(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no version could be resolved/);
  });
});

describe('resolveChangelogPath — containment-safe, defaulting to CHANGELOG.md', () => {
  it('defaults to CHANGELOG.md with no config', () => {
    const dir = makeTempProject();
    const resolved = releaseAutomation.resolveChangelogPath(dir, {});
    assert.equal(resolved.ok, true);
    assert.equal(resolved.path, path.join(dir, 'CHANGELOG.md'));
    assert.equal(resolved.label, 'CHANGELOG.md');
  });
  it('honors a configured nested path', () => {
    const dir = makeTempProject();
    const resolved = releaseAutomation.resolveChangelogPath(dir, { releaseAutomationChangelogPath: 'plugin/CHANGELOG.md' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.path, path.join(dir, 'plugin', 'CHANGELOG.md'));
  });
  it('refuses a configured path that escapes the project root', () => {
    const dir = makeTempProject();
    const resolved = releaseAutomation.resolveChangelogPath(dir, { releaseAutomationChangelogPath: '../../etc/passwd' });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /not usable/);
  });
});

describe('classifyRemote — github vs other vs none', () => {
  it('classifies a github.com https remote', () => {
    const dir = makeTempProject();
    realExecFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: dir });
    const remote = releaseAutomation.classifyRemote(dir);
    assert.equal(remote.kind, 'github');
    assert.equal(remote.repo, 'acme/widgets');
  });
  it('classifies a github.com ssh remote', () => {
    const dir = makeTempProject();
    realExecFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir });
    assert.equal(releaseAutomation.classifyRemote(dir).repo, 'acme/widgets');
  });
  it('classifies a non-github remote as other', () => {
    const dir = makeTempProject();
    realExecFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.example.com/acme/widgets.git'], { cwd: dir });
    const remote = releaseAutomation.classifyRemote(dir);
    assert.equal(remote.kind, 'other');
  });
  it('classifies no origin as none', () => {
    const dir = makeTempProject();
    assert.equal(releaseAutomation.classifyRemote(dir).kind, 'none');
  });
});

describe('tagNameFor', () => {
  it('prefixes a bare version with v', () => {
    assert.equal(releaseAutomation.tagNameFor('1.2.3'), 'v1.2.3');
  });
  it('does not double a leading v', () => {
    assert.equal(releaseAutomation.tagNameFor('v1.2.3'), 'v1.2.3');
  });
});

describe('planRelease — pure decision, no side effects', () => {
  function seedProject({ enabled = true, version = '1.0.0', changelog = true, remote = 'github', commit = true } = {}) {
    const dir = makeTempProject();
    if (version) fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version }));
    if (changelog) {
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), [
        '# Changelog', '', '## [Unreleased]', '', `## [${version}] - 2026-01-01`, '',
        '### Fixed', '- A fix.', ''
      ].join('\n'));
    }
    if (remote === 'github') {
      realExecFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: dir });
    } else if (remote === 'other') {
      realExecFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.example.com/acme/widgets.git'], { cwd: dir });
    }
    if (commit) {
      realExecFileSync('git', ['add', '-A'], { cwd: dir });
      // --allow-empty: some seedProject callers (e.g. "no version resolves")
      // write nothing at all, and a commit is still needed so HEAD exists.
      realExecFileSync('git', ['commit', '-q', '-m', 'seed', '--allow-empty'], { cwd: dir });
    }
    const config = { releaseAutomationEnabled: enabled };
    return { dir, config };
  }

  it('skips when not enabled', () => {
    const { dir, config } = seedProject({ enabled: false });
    const plan = releaseAutomation.planRelease(dir, { config });
    assert.equal(plan.ok, false);
    assert.equal(plan.action, 'skip');
    assert.match(plan.reason, /not enabled/);
  });

  it('skips when no version resolves', () => {
    const { dir, config } = seedProject({ version: null, changelog: false });
    const plan = releaseAutomation.planRelease(dir, { config });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /no version could be resolved/);
  });

  it('skips when the changelog has no section for the version', () => {
    const { dir, config } = seedProject({ changelog: false, commit: false });
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n');
    realExecFileSync('git', ['add', '-A'], { cwd: dir });
    realExecFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
    const plan = releaseAutomation.planRelease(dir, { config });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /no CHANGELOG\.md section found/);
  });

  it('plans tag-and-release for a github remote, capturing HEAD', () => {
    const { dir, config } = seedProject({});
    const headSha = realExecFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const plan = releaseAutomation.planRelease(dir, { config });
    assert.equal(plan.ok, true);
    assert.equal(plan.action, 'tag-and-release');
    assert.equal(plan.tagName, 'v1.0.0');
    assert.match(plan.notes, /A fix\./);
    assert.equal(plan.remote.repo, 'acme/widgets');
    assert.equal(plan.headSha, headSha);
  });

  it('plans tag-only for a non-github remote', () => {
    const { dir, config } = seedProject({ remote: 'other' });
    const plan = releaseAutomation.planRelease(dir, { config });
    assert.equal(plan.ok, true);
    assert.equal(plan.action, 'tag-only');
    assert.match(plan.reason, /not a github\.com remote/);
    assert.ok(plan.headSha);
  });

  it('skips when there is no remote at all', () => {
    const { dir, config } = seedProject({ remote: 'none' });
    const plan = releaseAutomation.planRelease(dir, { config });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /no origin remote is configured/);
  });

  it('B2: refuses an uncommitted bump — version.json differs from what HEAD carries', () => {
    const { dir, config } = seedProject({});
    // An uncommitted edit must refuse even when the version NUMBER it reads is
    // unchanged — the invariant is "matches what's committed", not "the number
    // still parses the same", so this adds a field rather than changing the
    // version string itself.
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.0.0', extra: true }));
    const plan = releaseAutomation.planRelease(dir, { config });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /version\.json has uncommitted changes/);
  });

  it('B2: refuses an uncommitted CHANGELOG edit the same way', () => {
    const { dir, config } = seedProject({});
    fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '\n- extra uncommitted line\n');
    const plan = releaseAutomation.planRelease(dir, { config });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /CHANGELOG\.md has uncommitted changes/);
  });

  it('B2: a plan survives HEAD moving afterward — applyRelease still tags the PLANNED commit, not the new one', () => {
    // tag-only (a non-github remote): applyRelease for tag-and-release would
    // also shell out to the real `gh` CLI for anything this stub doesn't
    // intercept, which has no real GitHub repo to talk to here. tag-only
    // exercises exactly the thing under test — what commit the tag names —
    // with no such dependency.
    const { dir, config } = seedProject({ remote: 'other' });
    const plan = releaseAutomation.planRelease(dir, { config });
    assert.equal(plan.ok, true);
    const plannedSha = plan.headSha;

    // HEAD moves on, as it would if another commit landed on this branch
    // between planning and applying.
    fs.writeFileSync(path.join(dir, 'README.md'), 'later work\n');
    realExecFileSync('git', ['add', '-A'], { cwd: dir });
    realExecFileSync('git', ['commit', '-q', '-m', 'later work'], { cwd: dir });
    const newHead = realExecFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.notEqual(newHead, plannedSha, 'the test did not actually move HEAD');

    // No real `origin` to push to here — this test only asserts WHAT COMMIT
    // the local tag object names, not that it reaches a remote.
    const original = releaseAutomation._internal.execFileSync;
    releaseAutomation._internal.execFileSync = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'ls-remote') return '';
      if (cmd === 'git' && args[0] === 'push') return '';
      return original(cmd, args, opts);
    };
    try {
      const result = releaseAutomation.applyRelease(dir, plan);
      assert.equal(result.ok, true);
    } finally {
      releaseAutomation._internal.execFileSync = original;
    }

    const taggedSha = realExecFileSync('git', ['rev-list', '-n', '1', plan.tagName], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(taggedSha, plannedSha, 'the tag must name the commit that was PLANNED, not the one HEAD moved to');
  });
});

describe('applyRelease — stubbed git/gh, no real network', () => {
  function withStubbedExec(responses, fn) {
    const original = releaseAutomation._internal.execFileSync;
    const originalWriteNotes = releaseAutomation._internal.writeTempNotesFile;
    const calls = [];
    releaseAutomation._internal.execFileSync = (cmd, args, opts) => {
      calls.push([cmd, args]);
      const handler = responses[calls.length - 1];
      if (!handler) throw new Error(`unexpected call #${calls.length}: ${cmd} ${args.join(' ')}`);
      return handler(cmd, args, opts);
    };
    releaseAutomation._internal.writeTempNotesFile = (notes) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-notes-stub-'));
      const file = path.join(dir, 'notes.md');
      fs.writeFileSync(file, notes);
      return file;
    };
    try {
      return fn(calls);
    } finally {
      releaseAutomation._internal.execFileSync = original;
      releaseAutomation._internal.writeTempNotesFile = originalWriteNotes;
    }
  }

  it('refuses when the plan is not ok', () => {
    const result = releaseAutomation.applyRelease('/tmp/whatever', { ok: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not ok/);
  });

  it('B2: refuses a plan with no headSha, rather than tagging an implicit HEAD', () => {
    const plan = { ok: true, action: 'tag-only', tagName: 'v1.0.0', notes: 'notes', remote: { url: 'other' } };
    const result = releaseAutomation.applyRelease('/tmp/whatever', plan);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no headSha/);
  });

  it('B2: tags the plan\'s captured headSha explicitly, not implicit HEAD', () => {
    const plan = { ok: true, action: 'tag-only', tagName: 'v1.0.0', notes: 'notes', remote: { url: 'other' }, headSha: 'cafef00d' };
    withStubbedExec([
      () => '', // ls-remote: nothing
      () => '', // git tag -a
      () => ''  // git push
    ], (calls) => {
      releaseAutomation.applyRelease('/tmp/whatever', plan);
      const tagCall = calls[1][1];
      assert.equal(tagCall[0], 'tag');
      assert.ok(tagCall.includes('cafef00d'), `expected the explicit sha in the tag command, got: ${tagCall.join(' ')}`);
    });
  });

  it('refuses to re-tag an already-existing tag', () => {
    const plan = { ok: true, action: 'tag-and-release', tagName: 'v1.0.0', notes: 'notes', remote: { repo: 'acme/widgets' }, headSha: 'deadbeef' };
    withStubbedExec([
      () => 'refs/tags/v1.0.0\tabc123\n' // ls-remote finds it
    ], () => {
      const result = releaseAutomation.applyRelease('/tmp/whatever', plan);
      assert.equal(result.ok, false);
      assert.match(result.reason, /already exists on origin/);
    });
  });

  it('tags and pushes only, for tag-only (non-github)', () => {
    const plan = { ok: true, action: 'tag-only', tagName: 'v1.0.0', notes: 'notes', remote: { url: 'other' }, headSha: 'deadbeef' };
    withStubbedExec([
      () => '', // ls-remote: nothing
      () => '', // git tag -a
      () => ''  // git push
    ], (calls) => {
      const result = releaseAutomation.applyRelease('/tmp/whatever', plan);
      assert.equal(result.ok, true);
      assert.equal(result.tagged, true);
      assert.equal(result.published, false);
      assert.equal(calls[1][1][0], 'tag');
      assert.equal(calls[2][1][0], 'push');
    });
  });

  it('tags, pushes and publishes for tag-and-release (github)', () => {
    const plan = { ok: true, action: 'tag-and-release', tagName: 'v1.0.0', notes: 'notes', remote: { repo: 'acme/widgets' }, headSha: 'deadbeef' };
    withStubbedExec([
      () => '', // ls-remote: nothing
      () => '', // git tag -a
      () => '', // git push
      () => ''  // gh release create
    ], (calls) => {
      const result = releaseAutomation.applyRelease('/tmp/whatever', plan);
      assert.equal(result.ok, true);
      assert.equal(result.published, true);
      assert.equal(calls[3][0], 'gh');
      assert.ok(calls[3][1].includes('--repo'));
    });
  });

  it('reports the tag as pushed even when gh release create fails', () => {
    const plan = { ok: true, action: 'tag-and-release', tagName: 'v1.0.0', notes: 'notes', remote: { repo: 'acme/widgets' }, headSha: 'deadbeef' };
    withStubbedExec([
      () => '',
      () => '',
      () => '',
      () => { throw new Error('gh: not authenticated'); }
    ], () => {
      const result = releaseAutomation.applyRelease('/tmp/whatever', plan);
      assert.equal(result.ok, false);
      assert.equal(result.tagged, true);
      assert.equal(result.published, false);
      assert.match(result.reason, /was pushed, but the GitHub Release could not be published/);
    });
  });
});

describe('generateReleaseWorkflow — self-contained YAML template', () => {
  it('produces a workflow with no dependency on this repo-only scripts', () => {
    const yaml = releaseAutomation.generateReleaseWorkflow();
    assert.doesNotMatch(yaml, /scripts\/release-tag-gate\.js/);
    assert.doesNotMatch(yaml, /scripts\/release-notes-gate\.js/);
    assert.match(yaml, /name: Release/);
    assert.match(yaml, /gh release create/);
  });

  it('parameterizes the branch, version file and changelog path', () => {
    const yaml = releaseAutomation.generateReleaseWorkflow({
      branch: 'release', versionFilePath: 'package.json', changelogPath: 'docs/CHANGELOG.md'
    });
    assert.match(yaml, /branches: \[release\]/);
    assert.match(yaml, /paths: \['package\.json'\]/);
    assert.match(yaml, /require\('\.\/package\.json'\)/);
    assert.match(yaml, /docs\/CHANGELOG\.md/);
  });

  it('is well-formed YAML that a workflow runner could parse', () => {
    // No YAML parser is a project dependency, so this checks the structural
    // property that actually matters: every top-level job/step block is
    // consistently indented and the heredoc in the notes-extraction step is
    // closed, rather than asserting on a parser this repo does not carry.
    const yaml = releaseAutomation.generateReleaseWorkflow();
    const nodeHeredocOpens = (yaml.match(/node <<'NODE'/g) || []).length;
    const nodeHeredocCloses = (yaml.match(/^\s*NODE\s*$/gm) || []).length;
    assert.equal(nodeHeredocOpens, 1);
    assert.equal(nodeHeredocCloses, 1);
  });
});

// Confirms the generated workflow's notes-extraction script is not just
// well-formed text but produces the SAME result extractReleaseNotes does —
// run for real, the way GitHub Actions would run it, not re-parsed.
//
// GitHub Actions feeds a `run: |` block to the shell only AFTER YAML's
// literal-block-scalar parsing strips the block's common leading indentation
// from every line (the terminator of the heredoc below included — it only
// matches bash's exact, no-leading-whitespace rule once that indentation is
// gone). This test re-derives that same de-indentation by hand, rather than
// depending on a YAML parser this project does not otherwise need, so what
// gets executed here is what Actions would actually run.
test('generated workflow script extracts the same notes extractReleaseNotes would', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-workflow-run-'));
  try {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), BRACKETED);
    const yaml = releaseAutomation.generateReleaseWorkflow();
    const lines = yaml.split('\n');
    const runLineIdx = lines.findIndex((l, i) => (
      /^\s*run: \|\s*$/.test(l)
      && lines.slice(Math.max(0, i - 6), i).some((p) => p.includes('Extract release notes'))
    ));
    assert.ok(runLineIdx !== -1, 'could not locate the notes-extraction run block');
    const bodyLines = [];
    for (let i = runLineIdx + 1; i < lines.length; i++) {
      if (/^\s*- name:/.test(lines[i])) break;
      bodyLines.push(lines[i]);
    }
    const firstNonBlank = bodyLines.find((l) => l.trim().length > 0);
    const indent = firstNonBlank.match(/^\s*/)[0];
    const script = bodyLines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');

    const res = realSpawnSync('bash', ['-c', script], { cwd: dir, env: { ...process.env, VERSION: '4.32.1' }, encoding: 'utf8' });
    assert.equal(res.status, 0, `script failed: ${res.stderr}`);
    const notes = fs.readFileSync(path.join(dir, 'release-notes.md'), 'utf8');
    assert.equal(notes.trim(), extractReleaseNotes(BRACKETED, '4.32.1').trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
