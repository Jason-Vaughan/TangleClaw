'use strict';

// #298 — version-bump falls back to package.json (Node projects) when there's
// no version.json. The package.json write is surgical (only the top-level
// "version" value changes); version.json stays preferred + normalized.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const vb = require('../lib/wrap-steps/version-bump');

const PKG = `{
  "name": "rentalclaw",
  "version": "1.4.2",
  "private": true,
  "scripts": { "build": "next build" },
  "dependencies": { "next": "14.0.0" }
}
`;
const CHANGELOG = `# Changelog

## [Unreleased]

### Added
- **A new feature.**

## [1.4.2] - 2026-05-01

### Fixed
- something old
`;

describe('version-bump package.json support (#298)', () => {
  let saved;
  beforeEach(() => { saved = { ...vb._internal }; });
  afterEach(() => { Object.assign(vb._internal, saved); });

  describe('_resolveVersionSource', () => {
    it('prefers version.json when present (unchanged behavior)', () => {
      vb._internal.existsSync = (p) => p.endsWith('version.json');
      vb._internal.readFileSync = () => '{"version":"3.0.0"}';
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json');
      assert.equal(s.kind, 'version.json');
      assert.equal(s.currentVersion, '3.0.0');
      assert.equal(s.stagedKey, 'version-bump:version-json');
      assert.equal(s.makeContent('3.1.0'), '{\n  "version": "3.1.0"\n}\n');
    });

    it('falls back to package.json when there is no version.json', () => {
      vb._internal.existsSync = (p) => p.endsWith('package.json');
      vb._internal.readFileSync = () => PKG;
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json');
      assert.equal(s.kind, 'package.json');
      assert.equal(s.currentVersion, '1.4.2');
      assert.equal(s.stagedKey, 'version-bump:package-json');
      const out = s.makeContent('1.5.0');
      // Surgical: ONLY the top-level version value changed; rest byte-identical.
      assert.equal(out, PKG.replace('"version": "1.4.2"', '"version": "1.5.0"'));
      assert.ok(out.includes('"name": "rentalclaw"'));
      assert.ok(out.includes('"next": "14.0.0"'), 'dependency untouched');
    });

    it('does NOT touch a dependency version that coincides with the package version', () => {
      const pkg = '{\n  "version": "14.0.0",\n  "dependencies": { "next": "14.0.0" }\n}\n';
      vb._internal.existsSync = (p) => p.endsWith('package.json');
      vb._internal.readFileSync = () => pkg;
      const out = vb._resolveVersionSource('/p/version.json', '/p/package.json').makeContent('15.0.0');
      assert.ok(out.includes('"version": "15.0.0"'), 'top-level version bumped');
      assert.ok(out.includes('"next": "14.0.0"'), 'matching dependency value untouched');
    });

    it('skips with a clear message when neither file exists', () => {
      vb._internal.existsSync = () => false;
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json');
      assert.match(s.skip, /not version-tracked/);
    });

    it('skips when package.json has no semver version', () => {
      vb._internal.existsSync = (p) => p.endsWith('package.json');
      vb._internal.readFileSync = () => '{"name":"x"}';
      const s = vb._resolveVersionSource('/p/version.json', '/p/package.json');
      assert.match(s.skip, /package\.json "version" field missing or non-semver/);
    });
  });

  describe('run() end-to-end on a package.json project', () => {
    it('bumps package.json + promotes CHANGELOG (no version.json present)', async () => {
      vb._internal.existsSync = (p) => p.endsWith('package.json') || p.endsWith('CHANGELOG.md');
      vb._internal.readFileSync = (p) => (p.endsWith('package.json') ? PKG : CHANGELOG);
      vb._internal.todayIso = () => '2026-06-02';

      const ctx = { project: { path: '/proj', name: 'rentalclaw' }, staged: {}, options: {} };
      const r = await vb.run(ctx);

      assert.equal(r.ok, true);
      assert.equal(r.status, 'done');
      assert.equal(r.output.from, '1.4.2');
      assert.equal(r.output.to, '1.5.0', 'minor bump driven by ### Added');
      assert.equal(r.output.versionFile, 'package.json');

      const pkgStaged = ctx.staged['version-bump:package-json'];
      assert.ok(pkgStaged, 'package.json write staged');
      assert.equal(pkgStaged.primingPath, '/proj/package.json');
      assert.equal(pkgStaged.newContent, PKG.replace('"version": "1.4.2"', '"version": "1.5.0"'));
      assert.ok(!ctx.staged['version-bump:version-json'], 'no version-json entry for a package.json project');

      assert.match(ctx.staged['version-bump:changelog'].newContent, /## \[1\.5\.0\] - 2026-06-02/);
    });

    it('still skips cleanly on a project with neither file', async () => {
      vb._internal.existsSync = (p) => p.endsWith('CHANGELOG.md'); // CHANGELOG only, no version files
      vb._internal.readFileSync = () => CHANGELOG;
      const ctx = { project: { path: '/proj', name: 'x' }, staged: {}, options: {} };
      const r = await vb.run(ctx);
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /not version-tracked/);
      assert.deepEqual(ctx.staged, {}, 'nothing staged on skip');
    });
  });
});
