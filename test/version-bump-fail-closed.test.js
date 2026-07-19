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
// is the OTHER reason _topReleasedVersion returns null, and it must still bump.
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
        assert.match(r.output.reason, /outside the project root/);
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

    it('_hasForeignSchemeHeadings keys on the version shape, not the whole heading', () => {
      assert.equal(vb._hasForeignSchemeHeadings(CHANGELOG_4OCTET), true,
        '4-octet version → a scheme this step cannot extend');
      assert.equal(vb._hasForeignSchemeHeadings(CHANGELOG_FIRST_RELEASE), false,
        'only [Unreleased] → legitimate first release');
      assert.equal(vb._hasForeignSchemeHeadings(CHANGELOG_3OCTET), false,
        'ordinary semver headings are recognized, not foreign');
    });

    // The guard must be narrower than "anything _topReleasedVersion rejects".
    // That parser also demands ` - YYYY-MM-DD`, so keying the guard on it would
    // hard-skip projects whose versions are ordinary semver but whose headings
    // are formatted differently — and blame their "versioning scheme".
    for (const [label, heading] of [
      ['no date', '## [1.4.2]'],
      ['en-dash separator', '## [1.4.2] – 2026-05-01'],
      ['trailing annotation', '## [1.4.2] - 2026-05-01 (hotfix)'],
      ['unreleased with trailing text', '## [Unreleased] - TBD'],
      ['prerelease tag', '## [1.4.2-beta.1] - 2026-05-01'],
      ['build metadata', '## [1.4.2+build.5] - 2026-05-01']
    ]) {
      it(`does not treat a 3-octet heading with ${label} as a foreign scheme`, () => {
        const text = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n- x\n\n${heading}\n\n### Fixed\n- y\n`;
        assert.equal(vb._hasForeignSchemeHeadings(text), false);
      });
    }

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
