'use strict';

// #1444 — version-bump reads and writes a Python project's pyproject.toml
// (`[project] version`). It used to probe only version.json and package.json,
// so every Python project skipped as "not version-tracked" on every wrap.
// The write must change only the version value; any shape the line scanner
// cannot edit safely is a skip with a reason, never a guess.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const vb = require('../lib/wrap-steps/version-bump');
const projectConfigModule = require('../lib/project-config');
const versionFiles = require('../lib/project-version-files');
const { parsePyprojectVersion } = versionFiles;

const PYPROJECT = `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "tanglebrain"
version = "0.25.0"  # bumped by the wrap
description = """
A readme block that quotes
version = "9.9.9"
[not-a-table]
"""
dependencies = [
  "httpx>=0.27",
]

[project.urls]
version = "https://example.invalid/should-not-count"

[tool.ruff]
version = "0.1.0"
`;

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed
- a bug

## [0.25.0] - 2026-09-01

### Fixed
- something old
`;

/**
 * Assert that `after` differs from `before` only by the version value.
 *
 * @param {string} before
 * @param {string} after
 * @param {string} from
 * @param {string} to
 */
function assertOnlyVersionChanged(before, after, from, to) {
  const b = before.split('\n');
  const a = after.split('\n');
  assert.equal(a.length, b.length, 'line count unchanged');
  const changed = b.map((line, i) => (line === a[i] ? null : i)).filter((i) => i !== null);
  assert.equal(changed.length, 1, 'exactly one line changed');
  assert.equal(a[changed[0]], b[changed[0]].replace(from, to));
}

function ctx() {
  return { project: { name: 'tanglebrain', path: '/proj' }, staged: {}, options: {} };
}

describe('version-bump pyproject.toml support (#1444)', () => {
  let savedInternal;
  let savedLoad;
  beforeEach(() => {
    savedInternal = { ...vb._internal };
    savedLoad = projectConfigModule.load;
    projectConfigModule.load = () => ({});
    vb._internal.todayIso = () => '2026-09-22';
  });
  afterEach(() => {
    Object.assign(vb._internal, savedInternal);
    projectConfigModule.load = savedLoad;
  });

  describe('parsePyprojectVersion', () => {
    it('finds [project] version and ignores multi-line strings, subtables and other tables', () => {
      const r = parsePyprojectVersion(PYPROJECT);
      assert.equal(r.ok, true);
      assert.equal(r.version, '0.25.0');
      assert.equal(PYPROJECT.slice(r.start, r.end), '0.25.0');
    });

    it('accepts single quotes, a header comment and indentation', () => {
      const text = "[project]  # metadata\n  name = 'x'\n  version = '1.2.3'\n";
      const r = parsePyprojectVersion(text);
      assert.equal(r.version, '1.2.3');
      assert.equal(text.slice(r.start, r.end), '1.2.3');
    });

    it('treats delimiters inside single-line strings and comments as text', () => {
      const text = '[project]\nname = "x"""y"\ndescription = \'a """ b\'  # \'\'\'\nversion = "1.2.3"\n';
      const r = parsePyprojectVersion(text);
      assert.equal(r.ok, true);
      assert.equal(r.version, '1.2.3');
    });

    it('still skips lines inside a real multi-line string', () => {
      const text = "[project]\nreadme = '''\nversion = \"9.9.9\"\n'''\nversion = '1.2.3'\n";
      assert.equal(parsePyprojectVersion(text).version, '1.2.3');
    });

    it('keeps offsets exact across CRLF endings and a BOM', () => {
      const text = '﻿[project]\r\nname = "x"\r\nversion = "2.0.0"\r\n';
      const r = parsePyprojectVersion(text);
      assert.equal(r.ok, true);
      assert.equal(text.slice(r.start, r.end), '2.0.0');
    });

    const refusals = [
      ['no [project] table', '[tool.poetry]\nversion = "1.0.0"\n', /no \[project\] table/],
      ['an inline project table', 'project = { name = "x", version = "1.0.0" }\n', /inline table/],
      ['a project key inside another table', '[tool.x]\nproject = { name = "x" }\n', /no \[project\] table/],
      ['a dynamic version', '[project]\nname = "x"\ndynamic = ["version"]\n', /dynamic/],
      ['a dynamic version in a multi-line array', '[project]\nname = "x"\ndynamic = [\n  "readme",\n  "version",\n]\n', /dynamic/],
      ['a multi-line version value', '[project]\nversion = """1.0.0"""\n', /single-line quoted string/],
      ['an unquoted version value', '[project]\nversion = 1\n', /single-line quoted string/],
      ['two version lines', '[project]\nversion = "1.0.0"\nversion = "1.0.1"\n', /more than one version line/],
      ['two [project] tables', '[project]\nversion = "1.0.0"\n[project]\nname = "x"\n', /more than one \[project\] table/],
      ['[project] with no version', '[project]\nname = "x"\n', /has no version in \[project\]/],
      // A delimiter in a comment must not open a multi-line string: two of them
      // on either side of the [tool.x] header would hide it, and the scanner
      // would take that table's version for the project's.
      ['a version that belongs to another table', '[project]\nname = "x"  # a stray \'\'\'\n[tool.x]\n# and its twin \'\'\'\nversion = "1.0.0"\n', /has no version in \[project\]/]
    ];
    for (const [label, text, reason] of refusals) {
      it(`refuses ${label}`, () => {
        const r = parsePyprojectVersion(text);
        assert.equal(r.ok, false);
        assert.match(r.reason, reason);
      });
    }
  });

  describe('_resolveVersionSource probe', () => {
    it('falls back to pyproject.toml when there is no version.json or package.json', () => {
      vb._internal.existsSync = (p) => p.endsWith('pyproject.toml');
      vb._internal.readFileSync = () => PYPROJECT;
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json');
      assert.equal(s.kind, 'pyproject.toml');
      assert.equal(s.path, '/p/pyproject.toml');
      assert.equal(s.currentVersion, '0.25.0');
      assert.equal(s.stagedKey, 'version-bump:pyproject-toml');
      assertOnlyVersionChanged(PYPROJECT, s.makeContent('0.25.1'), '0.25.0', '0.25.1');
    });

    it('preserves CRLF endings byte for byte', () => {
      const crlf = PYPROJECT.replace(/\n/g, '\r\n');
      vb._internal.existsSync = (p) => p.endsWith('pyproject.toml');
      vb._internal.readFileSync = () => crlf;
      const out = vb._resolveVersionSource('/p/version.json', '/p/package.json').makeContent('0.26.0');
      assert.equal(out, crlf.replace('version = "0.25.0"', 'version = "0.26.0"'));
    });

    it('keeps version.json and package.json ahead of pyproject.toml', () => {
      vb._internal.existsSync = (p) => p.endsWith('package.json') || p.endsWith('pyproject.toml');
      vb._internal.readFileSync = (p) => (p.endsWith('package.json') ? '{"version":"3.0.0"}' : PYPROJECT);
      assert.equal(vb._resolveVersionSource('/p/version.json', '/p/package.json').kind, 'package.json');
      vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('pyproject.toml');
      vb._internal.readFileSync = (p) => (p.endsWith('version.json') ? '{"version":"3.0.0"}' : PYPROJECT);
      assert.equal(vb._resolveVersionSource('/p/version.json', '/p/package.json').kind, 'version.json');
    });

    it('skips a shape it cannot edit, naming the file and the shape', () => {
      vb._internal.existsSync = (p) => p.endsWith('pyproject.toml');
      vb._internal.readFileSync = () => '[project]\nname = "x"\ndynamic = ["version"]\n';
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json');
      assert.match(s.skip, /^pyproject\.toml /);
      assert.match(s.skip, /dynamic/);
    });

    it('skips a non-semver static version with the neutral wording', () => {
      vb._internal.existsSync = (p) => p.endsWith('pyproject.toml');
      vb._internal.readFileSync = () => '[project]\nversion = "2026.9"\n';
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json');
      assert.match(s.skip, /pyproject\.toml version "2026\.9" isn't MAJOR\.MINOR\.PATCH semver/);
    });

    it('passes over a package.json with no version to reach pyproject.toml, as the reader does', () => {
      // A Python repo whose package.json exists only for tooling (#1444).
      vb._internal.existsSync = (p) => p.endsWith('package.json') || p.endsWith('pyproject.toml');
      vb._internal.readFileSync = (p) => (p.endsWith('package.json') ? '{"private":true,"scripts":{}}' : PYPROJECT);
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json');
      assert.equal(s.kind, 'pyproject.toml');
      assert.equal(s.currentVersion, '0.25.0');
    });

    it('stops at a version.json with no version rather than falling to a lower file', () => {
      vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('pyproject.toml');
      vb._internal.readFileSync = (p) => (p.endsWith('version.json') ? '{"name":"x"}' : PYPROJECT);
      assert.match(vb._resolveVersionSource('/p/version.json', '/p/package.json').skip, /version\.json has no "version" field/);
    });

    it('stops at a file that is broken rather than version-less', () => {
      vb._internal.existsSync = (p) => p.endsWith('package.json') || p.endsWith('pyproject.toml');
      vb._internal.readFileSync = (p) => (p.endsWith('package.json') ? '{not json' : PYPROJECT);
      assert.match(vb._resolveVersionSource('/p/version.json', '/p/package.json').skip, /package\.json unreadable/);
      vb._internal.readFileSync = (p) => (p.endsWith('package.json') ? '{"version":"2026.9"}' : PYPROJECT);
      assert.match(vb._resolveVersionSource('/p/version.json', '/p/package.json').skip, /isn't MAJOR\.MINOR\.PATCH/);
    });

    it('reports the version-less file when nothing below it has a version', () => {
      vb._internal.existsSync = (p) => p.endsWith('package.json');
      vb._internal.readFileSync = () => '{"private":true}';
      assert.match(vb._resolveVersionSource('/p/version.json', '/p/package.json').skip, /package\.json has no "version" field/);
    });

    it('names all three files when none exists', () => {
      vb._internal.existsSync = () => false;
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json');
      assert.match(s.skip, /not version-tracked/);
      assert.match(s.skip, /pyproject\.toml/);
    });
  });

  describe('configured versionFilePath', () => {
    it('routes a configured pyproject.toml to the TOML line swap', () => {
      vb._internal.existsSync = () => true;
      vb._internal.readFileSync = () => PYPROJECT;
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json', '/p/sub/pyproject.toml');
      assert.equal(s.path, '/p/sub/pyproject.toml');
      assert.equal(s.stagedKey, 'version-bump:pyproject-toml');
      assertOnlyVersionChanged(PYPROJECT, s.makeContent('0.26.0'), '0.25.0', '0.26.0');
    });

    it('says what it supports when a configured file is not JSON', () => {
      vb._internal.existsSync = () => true;
      vb._internal.readFileSync = () => 'version: 1.0.0\n';
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json', '/p/VERSION.yaml');
      assert.match(s.skip, /VERSION\.yaml unreadable as JSON/);
      assert.match(s.skip, /a JSON file, package\.json or pyproject\.toml/);
    });

    it('still bumps a JSON file whose name does not end in .json', () => {
      vb._internal.existsSync = () => true;
      vb._internal.readFileSync = () => '{"version":"1.2.3"}';
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json', '/p/VERSION.txt');
      assert.equal(s.currentVersion, '1.2.3');
      assert.equal(s.makeContent('1.2.4'), '{\n  "version": "1.2.4"\n}\n');
    });
  });

  describe('run() end-to-end on a pyproject.toml project', () => {
    it('bumps pyproject.toml and promotes the CHANGELOG', async () => {
      vb._internal.existsSync = (p) => p.endsWith('pyproject.toml') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('pyproject.toml') ? PYPROJECT : CHANGELOG);
      const c = ctx();
      const r = await vb.run(c);

      assert.equal(r.status, 'done');
      assert.equal(r.output.from, '0.25.0');
      assert.equal(r.output.to, '0.25.1', 'patch bump driven by ### Fixed');
      assert.equal(r.output.versionFile, 'pyproject.toml');

      const staged = c.staged['version-bump:pyproject-toml'];
      assert.equal(staged.primingPath, '/proj/pyproject.toml');
      assertOnlyVersionChanged(PYPROJECT, staged.newContent, '0.25.0', '0.25.1');
      assert.ok(!c.staged['version-bump:version-json'], 'no version.json entry');
      assert.match(c.staged['version-bump:changelog'].newContent, /## \[0\.25\.1\] - 2026-09-22/);
    });

    it('bumps a real pyproject.toml on disk, and the reader then agrees with it', async () => {
      // No stubbed filesystem: the real read, the real parse and the real
      // detection ladder, on a project shaped like the one the issue was filed on.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vb-py-'));
      try {
        fs.writeFileSync(path.join(dir, 'pyproject.toml'), PYPROJECT);
        fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), CHANGELOG);
        fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"devDependencies":{}}\n');
        const c = { project: { name: 'tanglebrain', path: dir }, staged: {}, options: {} };
        const r = await vb.run(c);
        assert.equal(r.status, 'done');
        const staged = c.staged['version-bump:pyproject-toml'];
        assert.equal(staged.primingPath, path.join(dir, 'pyproject.toml'));
        assertOnlyVersionChanged(PYPROJECT, staged.newContent, '0.25.0', '0.25.1');

        // Write what the commit step would flush, then read it back the way the
        // dashboard does (the CHANGELOG rung is removed so pyproject.toml answers).
        fs.writeFileSync(staged.primingPath, staged.newContent);
        fs.rmSync(path.join(dir, 'CHANGELOG.md'));
        assert.deepEqual(versionFiles.detectLiveVersion(dir), { version: '0.25.1', source: 'pyproject.toml' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // The dashboard must never show a version from a file the bump would not
    // reach. Each shape runs the real writer probe and both real reader ladders
    // on the same files on disk.
    const PY = '[project]\nversion = "5.5.5"\n';
    const shapes = [
      ['a tooling-only package.json above pyproject.toml', { 'package.json': '{"private":true}', 'pyproject.toml': PY }, 'pyproject.toml'],
      ['a version.json with no version above pyproject.toml', { 'version.json': '{"name":"x"}', 'pyproject.toml': PY }, null],
      ['a malformed package.json above pyproject.toml', { 'package.json': '{not json', 'pyproject.toml': PY }, null],

      ['a versioned package.json above pyproject.toml', { 'package.json': '{"version":"4.4.4"}', 'pyproject.toml': PY }, 'package.json'],
      ['a dynamic pyproject.toml alone', { 'pyproject.toml': '[project]\ndynamic = ["version"]\n' }, null]
    ];
    for (const [label, files, expected] of shapes) {
      it(`writer and reader pick the same file: ${label}`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vb-align-'));
        try {
          for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
          const source = vb._resolveVersionSource(path.join(dir, 'version.json'), path.join(dir, 'package.json'));
          const live = versionFiles.detectLiveVersion(dir);
          const recorded = require('../lib/project-version').detectVersion(dir);
          assert.equal(source.skip ? null : source.kind, expected, 'writer');
          assert.equal(live ? live.source : null, expected, 'self-heal ladder');
          assert.equal(['git tag', 'fallback'].includes(recorded.source) ? null : recorded.source, expected, 'launch/wrap ladder');
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    it('keeps the reader\'s long-standing read past an unusable version.json to package.json (#58)', () => {
      // A split that predates #1444 and is kept on purpose: the dashboard shows
      // the package version while the bump refuses the version.json. What #1444
      // guarantees is only that such a project never shows a pyproject version.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vb-align-'));
      try {
        fs.writeFileSync(path.join(dir, 'version.json'), '{not json');
        fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"4.4.4"}');
        fs.writeFileSync(path.join(dir, 'pyproject.toml'), PY);
        assert.match(vb._resolveVersionSource(path.join(dir, 'version.json'), path.join(dir, 'package.json')).skip, /version\.json unreadable/);
        assert.deepEqual(versionFiles.detectLiveVersion(dir), { version: '4.4.4', source: 'package.json' });
        fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
        assert.equal(versionFiles.detectLiveVersion(dir), null, 'still never reaches pyproject.toml');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('honours releaseMode off on a pyproject.toml project', async () => {
      projectConfigModule.load = () => ({ releaseMode: 'off' });
      vb._internal.existsSync = (p) => p.endsWith('pyproject.toml') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('pyproject.toml') ? PYPROJECT : CHANGELOG);
      const c = ctx();
      const r = await vb.run(c);
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /releaseMode is off/);
      assert.deepEqual(c.staged, {});
    });
  });
});
