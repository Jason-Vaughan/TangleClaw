'use strict';

// version-bump fail-closed behavior (#540, #571 item 3).
//
// One defect class in three places: the step silently did something other than
// what was asked instead of stopping.
//
//  1. `_resolveVersionSource` only ever tested lowercase `version.json`, then
//     fell through to `package.json`. On a case-sensitive filesystem a project
//     whose version file is `VERSION.json` resolved nothing, fell through, and
//     bumped an unrelated `package.json` — inserting a bogus release heading
//     above the project's real one.
//  2. The drift guard read `if (topReleased && …)`, and `_topReleasedVersion`
//     returns null for ANY changelog whose headings aren't 3-octet
//     `## [X.Y.Z] - YYYY-MM-DD`. So on a 4-octet scheme the guard skipped
//     itself rather than firing — the one check that would have caught (1).
//     Fixed twice: the first attempt used two independent predicates for
//     "comparable?" and "foreign?", which disagreed on both undated headings
//     (hard-skipping valid projects) and prerelease ones (falling through to
//     the bump, reopening the fail-open). `_classifyTopRelease` is now the
//     single source both questions are answered from.
//  3. An out-of-set `bumpLevel` override fell through to the heuristic, so an
//     operator who asked for patch and typo'd got a minor bump and no signal.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const vb = require('../lib/wrap-steps/version-bump');
const store = require('../lib/store');

// A 4-octet project (TiLT v2's real shape): the version file is VERSION.json
// and the changelog headings carry an operator-owned 4th octet.
const VERSION_JSON_4OCTET = '{"version":"2.85.0.41"}';
const PKG_UNRELATED = '{"name":"tilt","version":"0.1.0","private":true}\n';
const CHANGELOG_4OCTET = `# Changelog

## [Unreleased]

### Added
- **A feature that merged to staging mid-train.**

## [2.85.0.41] - 2026-07-15

### Fixed
- something shipped
`;

// A conventional 3-octet project, for the cases that must still work.
const CHANGELOG_3OCTET = `# Changelog

## [Unreleased]

### Fixed
- a bug

## [1.4.2] - 2026-05-01

### Fixed
- something old
`;

// A first-ever release: [Unreleased] with no released heading below it. This
// is the case that must still bump: no release heading to compare against.
const CHANGELOG_FIRST_RELEASE = `# Changelog

## [Unreleased]

### Added
- the first thing
`;

function ctx(overrides = {}) {
  return {
    project: { name: 'p', path: '/p' },
    step: { id: 'version-bump', kind: 'version-bump' },
    staged: {},
    options: {},
    ...overrides
  };
}

describe('version-bump fail-closed (#540, #571 item 3)', () => {
  let savedInternal;
  let savedLoad;

  beforeEach(() => {
    savedInternal = { ...vb._internal };
    savedLoad = store.projectConfig.load;
    store.projectConfig.load = () => ({});
    vb._internal.todayIso = () => '2026-07-19';
  });

  afterEach(() => {
    Object.assign(vb._internal, savedInternal);
    store.projectConfig.load = savedLoad;
  });

  describe('1. versionFilePath — an explicit path resolves that file or skips', () => {
    it('resolves a configured VERSION.json that a case-sensitive FS would miss', async () => {
      // Case-sensitive filesystem: lowercase version.json does NOT exist.
      vb._internal.existsSync = (p) => p.endsWith('VERSION.json')
        || p.endsWith('package.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => {
        if (p.endsWith('VERSION.json')) return VERSION_JSON_4OCTET;
        if (p.endsWith('package.json')) return PKG_UNRELATED;
        return CHANGELOG_3OCTET;
      };
      store.projectConfig.load = () => ({ versionFilePath: 'VERSION.json' });

      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json', '/p/VERSION.json');
      assert.equal(s.kind, 'VERSION.json');
      assert.equal(s.currentVersion, '2.85.0.41');
      assert.equal(s.path, '/p/VERSION.json');
    });

    it('skips rather than falling through when the configured path is missing', () => {
      // package.json IS present — today's code would happily bump it.
      vb._internal.existsSync = (p) => p.endsWith('package.json');
      vb._internal.readFileSync = () => PKG_UNRELATED;

      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json', '/p/VERSION.json');
      assert.ok(s.skip, 'must skip, not resolve');
      assert.match(s.skip, /VERSION\.json/, 'reason names the configured path');
      assert.doesNotMatch(String(s.kind), /package/, 'must not fall through to package.json');
    });

    it('run() bumps ONLY the configured file, never package.json', async () => {
      vb._internal.existsSync = (p) => p.endsWith('VERSION.json')
        || p.endsWith('package.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => {
        if (p.endsWith('VERSION.json')) return '{"version":"1.4.2"}';
        if (p.endsWith('package.json')) return PKG_UNRELATED;
        return CHANGELOG_3OCTET;
      };
      store.projectConfig.load = () => ({ versionFilePath: 'VERSION.json' });

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'done');
      const stagedPaths = Object.values(c.staged).map((s) => s.primingPath);
      assert.ok(stagedPaths.some((p) => p.endsWith('VERSION.json')), 'staged the configured file');
      assert.ok(!stagedPaths.some((p) => p.endsWith('package.json')),
        'package.json must never be staged when versionFilePath is set');
    });
  });

  describe('1b. versionFilePath cannot escape the project root', () => {
    // The commit step flushes staged writes by path, so an escaping value would
    // turn a settings field into an arbitrary-file write.
    for (const escape of ['../../../etc/passwd.json', '/etc/passwd.json', 'sub/../../outside.json']) {
      it(`skips on ${JSON.stringify(escape)}`, async () => {
        vb._internal.existsSync = () => true;
        vb._internal.readFileSync = () => '{"version":"1.0.0"}';
        store.projectConfig.load = () => ({ versionFilePath: escape });

        const c = ctx();
        const r = await vb.run(c);
        assert.equal(r.status, 'skipped');
        assert.match(r.output.reason, /outside the project root|not absolute/,
          'reason distinguishes an escape from an absolute path');
        assert.deepEqual(c.staged, {}, 'nothing staged outside the project');
      });
    }

    it('allows a nested path inside the project', async () => {
      vb._internal.existsSync = (p) => p.endsWith('meta/VERSION.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('VERSION.json')
        ? '{"version":"1.4.2"}' : CHANGELOG_3OCTET);
      store.projectConfig.load = () => ({ versionFilePath: 'meta/VERSION.json' });

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'done');
      assert.ok(c.staged['version-bump:version-json'].primingPath.endsWith('meta/VERSION.json'));
    });
  });

  describe('1c. configured-path error branches', () => {
    const cases = [
      ['unparseable JSON', '{not json', /unreadable/],
      ['not an object', '"a string"', /not an object/],
      ['no version field', '{"name":"x"}', /no "version" field/]
    ];
    for (const [label, content, expected] of cases) {
      it(`skips on ${label}`, () => {
        vb._internal.existsSync = () => true;
        vb._internal.readFileSync = () => content;
        const s = vb._resolveVersionSource('/p/version.json', '/p/package.json', '/p/VERSION.json');
        assert.ok(s.skip);
        assert.match(s.skip, expected);
        assert.match(s.skip, /VERSION\.json/, 'names the configured file, not version.json');
      });
    }
  });

  describe('2. drift guard fails closed on an unparseable changelog scheme', () => {
    it('skips a 4-octet changelog instead of bumping an unrelated package.json', async () => {
      // The exact corruption path from #540: case-sensitive FS, no config set.
      vb._internal.existsSync = (p) => p.endsWith('package.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('package.json') ? PKG_UNRELATED : CHANGELOG_4OCTET);

      const c = ctx();
      const r = await vb.run(c);

      assert.equal(r.status, 'skipped', 'must not bump a scheme it cannot parse');
      assert.equal(r.ok, true, 'never blocks — ADR 0002 step-kind contract');
      assert.match(r.output.reason, /2\.85\.0\.41|scheme|parse/i,
        'reason must name why it stopped, not just that it did');
      assert.deepEqual(c.staged, {}, 'nothing staged — no bogus heading, no package.json bump');
    });

    it('still bumps a first release, where null topReleased is legitimate', async () => {
      vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('version.json')
        ? '{"version":"0.1.0"}' : CHANGELOG_FIRST_RELEASE);

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'done',
        'no release headings at all is a first release, not an unparseable scheme');
      assert.equal(c.staged['version-bump:version-json'].newVersion, '0.2.0');
    });

    it('still fires the original #203 drift guard on a 3-octet changelog', async () => {
      // version.json (1.0.0) trails the changelog (1.4.2) — must refuse.
      vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('version.json')
        ? '{"version":"1.0.0"}' : CHANGELOG_3OCTET);

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /strictly greater/);
    });

    it('names the scheme and the remedy when the current version is not 3-octet', async () => {
      // Reached via a configured VERSION.json holding a 4-octet counter — the
      // bare "could not bump 2.85.0.41 (minor)" this replaced named the value
      // but neither the problem nor what to do about it.
      vb._internal.existsSync = (p) => p.endsWith('VERSION.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('VERSION.json')
        ? VERSION_JSON_4OCTET : CHANGELOG_4OCTET);
      store.projectConfig.load = () => ({ versionFilePath: 'VERSION.json' });

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /2\.85\.0\.41/, 'names the value');
      assert.match(r.output.reason, /MAJOR\.MINOR\.PATCH/, 'names the problem');
      assert.match(r.output.reason, /versionBumpEnabled/, 'names the remedy');
      assert.deepEqual(c.staged, {});
    });

    it('_classifyTopRelease separates every reason the top heading may not compare', () => {
      assert.equal(vb._classifyTopRelease(CHANGELOG_4OCTET).kind, 'foreign');
      assert.equal(vb._classifyTopRelease(CHANGELOG_FIRST_RELEASE).kind, 'none');
      assert.equal(vb._classifyTopRelease(CHANGELOG_3OCTET).kind, 'released');
      assert.deepEqual(vb._classifyTopRelease(CHANGELOG_3OCTET).version,
        { major: 1, minor: 4, patch: 2 });
    });

    // Ordinary semver formatted differently is still comparable — demanding a
    // date is what mis-blamed these projects' "versioning scheme".
    for (const [label, heading] of [
      ['no date', '## [1.4.2]'],
      ['en-dash separator', '## [1.4.2] \u2013 2026-05-01'],
      ['trailing annotation', '## [1.4.2] - 2026-05-01 (hotfix)']
    ]) {
      it(`treats a 3-octet heading with ${label} as comparable`, () => {
        const text = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n- x\n\n${heading}\n\n### Fixed\n- y\n`;
        const top = vb._classifyTopRelease(text);
        assert.equal(top.kind, 'released');
        assert.deepEqual(top.version, { major: 1, minor: 4, patch: 2 });
      });
    }

    it('does not read `## [Unreleased] - TBD` as a release heading', () => {
      const text = '# Changelog\n\n## [Unreleased] - TBD\n\n### Fixed\n- x\n';
      assert.equal(vb._classifyTopRelease(text).kind, 'none');
    });

    // Prerelease/build suffixes are valid semver but ordering against a plain
    // version is ambiguous, so they are their own stop — NOT 'none', which
    // would skip the drift guard entirely and let the bump write above them.
    for (const [label, heading] of [
      ['prerelease', '## [2.0.0-beta.1] - 2026-05-01'],
      ['build metadata', '## [2.0.0+build.5] - 2026-05-01'],
      ['both', '## [2.0.0-rc.1+build.5] - 2026-05-01']
    ]) {
      it(`classifies a ${label} heading as unbumpable, not none`, () => {
        const text = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n- x\n\n${heading}\n`;
        assert.equal(vb._classifyTopRelease(text).kind, 'unbumpable');
      });
    }

    it('run() refuses rather than writing a lower version above a prerelease', async () => {
      // The regression the classifier exists to prevent: a heading that is
      // neither comparable nor foreign used to fall through to the bump,
      // writing `## [1.0.1]` directly above `## [2.0.0-beta.1]`.
      const text = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- x\n\n## [2.0.0-beta.1] - 2026-05-01\n';
      vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('version.json') ? '{"version":"1.0.0"}' : text);

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /prerelease or build suffix/);
      assert.match(r.output.reason, /2\.0\.0-beta\.1/, 'names the heading it stopped on');
      assert.deepEqual(c.staged, {}, 'nothing staged above the prerelease');
    });

    it('names the offending heading when the scheme is foreign', async () => {
      vb._internal.existsSync = (p) => p.endsWith('package.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('package.json') ? PKG_UNRELATED : CHANGELOG_4OCTET);

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /2\.85\.0\.41/);
    });

    it('still bumps a project whose headings omit the date', async () => {
      const noDate = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- a bug\n\n## [1.4.2]\n\n### Fixed\n- old\n';
      vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('version.json') ? '{"version":"1.4.2"}' : noDate);

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'done', 'a date-less heading is a formatting choice, not a foreign scheme');
      assert.equal(c.staged['version-bump:version-json'].newVersion, '1.4.3');
    });
  });

  describe('2b. unbracketed changelog styles are read, not mistaken for empty', () => {
    // `## 1.4.2 - date` is ordinary Keep a Changelog without link references.
    // Keying the scan on `## [` meant such a changelog had NO release headings
    // and no section terminator: the guard read "first release" and proceeded,
    // and `_parseUnreleased` ran to EOF, sweeping every past release into the
    // body it was about to promote under one new heading.
    const UNBRACKETED = [
      '# Changelog', '', '## [Unreleased]', '', '### Fixed', '- a bug', '',
      '## 1.4.2 - 2026-05-01', '', '### Fixed', '- old', '',
      '## 1.4.1 - 2026-04-01', '', '### Fixed', '- older', ''
    ].join('\n');

    it('ends the [Unreleased] body at the next release heading', () => {
      const parsed = vb._parseUnreleased(UNBRACKETED);
      const body = parsed.bodyLines.join('\n');
      assert.match(body, /a bug/);
      assert.doesNotMatch(body, /1\.4\.2/, 'must not sweep the release history into the promotion');
      assert.doesNotMatch(body, /older/);
    });

    it('classifies an unbracketed release heading as comparable', () => {
      const top = vb._classifyTopRelease(UNBRACKETED);
      assert.equal(top.kind, 'released');
      assert.deepEqual(top.version, { major: 1, minor: 4, patch: 2 });
    });

    it('run() applies the drift guard to an unbracketed changelog', async () => {
      vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('version.json')
        ? '{"version":"1.0.0"}' : UNBRACKETED);

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'skipped', 'guard must fire, not read this as a first release');
      assert.match(r.output.reason, /strictly greater/);
      assert.deepEqual(c.staged, {});
    });

    it('classifies an unbracketed foreign scheme as foreign', () => {
      const text = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- x\n\n## 2.85.0.41 - 2026-05-01\n';
      assert.equal(vb._classifyTopRelease(text).kind, 'foreign');
    });

    it('keeps a bracketed 4-octet heading foreign, not a truncated 3-octet read', () => {
      // `## [2.85.0.41]` must not satisfy a bare `\d+\.\d+\.\d+` prefix and
      // read as 2.85.0 — that is the original #540 bug in a new regex.
      const top = vb._classifyTopRelease(CHANGELOG_4OCTET);
      assert.equal(top.kind, 'foreign');
      assert.equal(top.version, undefined);
    });

    it('ignores a prose ## section rather than treating it as a foreign scheme', () => {
      const text = '# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n\n## Migration guide\n\nprose\n';
      assert.equal(vb._classifyTopRelease(text).kind, 'none');
    });
  });

  describe('2c. a configured package.json keeps its surgical write', () => {
    it('preserves formatting instead of reserializing', async () => {
      const PKG = '{\n  "name": "demo",\n  "version": "1.4.2",\n  "scripts": { "build": "x" }\n}\n';
      vb._internal.existsSync = (p) => p.endsWith('package.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('package.json') ? PKG : CHANGELOG_3OCTET);
      store.projectConfig.load = () => ({ versionFilePath: 'package.json' });

      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'done');
      const staged = c.staged['version-bump:package-json'];
      assert.ok(staged, 'uses the package.json staged key, not the version-json one');
      assert.equal(staged.newContent, PKG.replace('"1.4.2"', '"1.4.3"'),
        'byte-preserving: only the version value changed');
    });
  });

  describe('3. an invalid bumpLevel override skips instead of guessing', () => {
    const setup3Octet = () => {
      vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('version.json')
        ? '{"version":"1.4.2"}' : CHANGELOG_3OCTET);
    };

    it('skips on a typo rather than silently applying the heuristic', async () => {
      setup3Octet();
      const c = ctx({ options: { bumpLevel: 'pathc' } });
      const r = await vb.run(c);
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /pathc/, 'reason names the bad value');
      assert.deepEqual(c.staged, {});
    });

    it('skips on a case mismatch ("Minor"), which the old set-check dropped silently', async () => {
      setup3Octet();
      const c = ctx({ options: { bumpLevel: 'Minor' } });
      const r = await vb.run(c);
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /Minor/);
    });

    it('honors a valid override', async () => {
      setup3Octet();
      const c = ctx({ options: { bumpLevel: 'major' } });
      const r = await vb.run(c);
      assert.equal(r.status, 'done');
      assert.equal(c.staged['version-bump:version-json'].newVersion, '2.0.0');
    });

    it('absent/undefined bumpLevel still uses the heuristic', async () => {
      setup3Octet();
      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'done');
      // CHANGELOG_3OCTET's [Unreleased] has only ### Fixed → patch.
      assert.equal(c.staged['version-bump:version-json'].newVersion, '1.4.3');
      assert.equal(c.staged['version-bump:version-json'].bumpLevel, 'patch');
    });
  });
});

// The reader must agree with the writer about where the version lives —
// otherwise `versionFilePath` closes the reader/writer divergence at the wrap
// step and reopens it one layer up, in what TC records as the project version.
describe('project-version honors versionFilePath (#540)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const projectVersion = require('../lib/project-version');
  const storeMod = require('../lib/store');

  let dir;
  let savedLoad;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vfp-'));
    savedLoad = storeMod.projectConfig.load;
  });
  afterEach(() => {
    storeMod.projectConfig.load = savedLoad;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the configured file ahead of the built-in probe', () => {
    fs.writeFileSync(path.join(dir, 'VERSION.json'), '{"version":"2.5.0"}');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"0.1.0"}');
    storeMod.projectConfig.load = () => ({ versionFilePath: 'VERSION.json' });

    const got = projectVersion.detectVersion(dir);
    assert.equal(got.version, '2.5.0');
    assert.equal(got.source, 'VERSION.json');
  });

  it('falls through to the probe when no path is configured', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"0.1.0"}');
    storeMod.projectConfig.load = () => ({});

    const got = projectVersion.detectVersion(dir);
    assert.equal(got.version, '0.1.0');
    assert.equal(got.source, 'package.json');
  });

  it('ignores a configured path that escapes the project root', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"0.1.0"}');
    storeMod.projectConfig.load = () => ({ versionFilePath: '../../../etc/passwd.json' });

    const got = projectVersion.detectVersion(dir);
    assert.equal(got.source, 'package.json', 'falls through rather than reading outside');
  });

  it('falls through when the configured file is missing or malformed', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"0.1.0"}');
    storeMod.projectConfig.load = () => ({ versionFilePath: 'nope.json' });
    assert.equal(projectVersion.detectVersion(dir).source, 'package.json');

    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    storeMod.projectConfig.load = () => ({ versionFilePath: 'bad.json' });
    assert.equal(projectVersion.detectVersion(dir).source, 'package.json');
  });
});

// Diagnostic-text contracts: a refusal must read as one sentence naming the
// setting, and must attribute the cause to the configuration when that is what
// is wrong. Both were Critic notes — behavior was correct, the message wasn't.
describe('version-bump refusal messages read as one sentence', () => {
  let savedInternal;
  let savedLoad;

  beforeEach(() => {
    savedInternal = { ...vb._internal };
    savedLoad = store.projectConfig.load;
  });
  afterEach(() => {
    Object.assign(vb._internal, savedInternal);
    store.projectConfig.load = savedLoad;
  });

  it('composes the field name with the reason, without a doubled noun', async () => {
    vb._internal.existsSync = () => true;
    vb._internal.readFileSync = () => '{"version":"1.0.0"}';
    store.projectConfig.load = () => ({ versionFilePath: '../../outside.json' });

    const c = ctx();
    const r = await vb.run(c);
    assert.match(r.output.reason, /versionFilePath "\.\.\/\.\.\/outside\.json" resolves outside the project root/);
    assert.doesNotMatch(r.output.reason, /versionFilePath path /, 'no doubled noun');
  });

  it('blames the configuration when a configured package.json is missing', () => {
    // Not "package.json not found", which reads as though the probe ran.
    vb._internal.existsSync = () => false;
    const s = vb._resolveVersionSource('/p/version.json', '/p/package.json', '/p/package.json');
    assert.ok(s.skip);
    assert.match(s.skip, /configured versionFilePath/);
  });
});
