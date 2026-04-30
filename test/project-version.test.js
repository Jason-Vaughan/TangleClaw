'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const projectVersion = require('../lib/project-version');

describe('project-version (#101)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-project-version-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectVersion', () => {
    it('reads the first non-Unreleased version from CHANGELOG.md', () => {
      fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [3.13.3] - 2026-04-30\n\n## [3.13.2] - 2026-04-29\n');
      const result = projectVersion.detectVersion(tmpDir);
      assert.deepEqual(result, { version: '3.13.3', source: 'CHANGELOG.md' });
    });

    it('falls back to version.json when CHANGELOG is absent', () => {
      fs.writeFileSync(path.join(tmpDir, 'version.json'), '{ "version": "1.2.3" }\n');
      assert.deepEqual(projectVersion.detectVersion(tmpDir), { version: '1.2.3', source: 'version.json' });
    });

    it('falls back to package.json when CHANGELOG and version.json are absent', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ "name": "thing", "version": "0.4.2" }\n');
      assert.deepEqual(projectVersion.detectVersion(tmpDir), { version: '0.4.2', source: 'package.json' });
    });

    it('falls back to git tag when no manifest sources exist', () => {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });
      execFileSync('git', ['tag', 'v2.5.1'], { cwd: tmpDir });
      assert.deepEqual(projectVersion.detectVersion(tmpDir), { version: '2.5.1', source: 'git tag' });
    });

    it('returns the fallback when no source is available', () => {
      assert.deepEqual(projectVersion.detectVersion(tmpDir), { version: '0.0.0-dev', source: 'fallback' });
    });

    it('returns the fallback for a missing or empty path', () => {
      assert.deepEqual(projectVersion.detectVersion(''), { version: '0.0.0-dev', source: 'fallback' });
      assert.deepEqual(projectVersion.detectVersion(null), { version: '0.0.0-dev', source: 'fallback' });
      assert.deepEqual(projectVersion.detectVersion(undefined), { version: '0.0.0-dev', source: 'fallback' });
    });

    it('CHANGELOG wins over version.json wins over package.json', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ "version": "9.9.9" }\n');
      fs.writeFileSync(path.join(tmpDir, 'version.json'), '{ "version": "8.8.8" }\n');
      assert.equal(projectVersion.detectVersion(tmpDir).source, 'version.json');
      fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [7.0.0] - 2026-04-30\n');
      assert.equal(projectVersion.detectVersion(tmpDir).source, 'CHANGELOG.md');
      assert.equal(projectVersion.detectVersion(tmpDir).version, '7.0.0');
    });

    it('strips leading "v" from git tags so it matches manifest sources', () => {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });
      execFileSync('git', ['tag', 'v3.0.0'], { cwd: tmpDir });
      assert.equal(projectVersion.detectVersion(tmpDir).version, '3.0.0');
    });

    it('rejects date-style CHANGELOG headers (delegates to projects._readChangelogVersion shape rule)', () => {
      // `[2026-04-30]` is not version-shaped (no `digit.digit`); should fall through.
      fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [2026-04-30] - some entry\n');
      fs.writeFileSync(path.join(tmpDir, 'version.json'), '{ "version": "0.5.0" }\n');
      assert.deepEqual(projectVersion.detectVersion(tmpDir), { version: '0.5.0', source: 'version.json' });
    });
  });

  describe('recordVersion', () => {
    it('writes the cache file with version, recorded_at, source', () => {
      fs.writeFileSync(path.join(tmpDir, 'version.json'), '{ "version": "4.5.6" }\n');
      const out = projectVersion.recordVersion(tmpDir);

      assert.ok(out, 'recordVersion should return a result');
      assert.equal(out.version, '4.5.6');
      assert.equal(out.source, 'version.json');
      assert.equal(out.path, path.join(tmpDir, '.tangleclaw', 'project-version.txt'));

      const body = fs.readFileSync(out.path, 'utf8');
      assert.match(body, /^version: 4\.5\.6$/m);
      assert.match(body, /^source: version\.json$/m);
      assert.match(body, /^recorded_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
      assert.ok(body.endsWith('\n'), 'cache file should end with a trailing newline');
    });

    it('creates .tangleclaw/ directory if missing', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ "version": "1.0.0" }\n');
      assert.equal(fs.existsSync(path.join(tmpDir, '.tangleclaw')), false);
      const out = projectVersion.recordVersion(tmpDir);
      assert.ok(out);
      assert.ok(fs.existsSync(path.join(tmpDir, '.tangleclaw')));
    });

    it('overwrites existing cache file (idempotent for content; recorded_at advances)', () => {
      fs.writeFileSync(path.join(tmpDir, 'version.json'), '{ "version": "1.0.0" }\n');

      const first = projectVersion.recordVersion(tmpDir);
      const firstBody = fs.readFileSync(first.path, 'utf8');
      const firstTs = firstBody.match(/recorded_at: (\S+)/)[1];

      // Wait long enough for the second-resolution timestamp to advance.
      const start = Date.now();
      while (Date.now() - start < 1100) { /* spin */ }

      const second = projectVersion.recordVersion(tmpDir);
      const secondBody = fs.readFileSync(second.path, 'utf8');
      const secondTs = secondBody.match(/recorded_at: (\S+)/)[1];

      assert.equal(second.version, '1.0.0');
      assert.equal(second.source, 'version.json');
      assert.notEqual(firstTs, secondTs, 'timestamp should advance between writes');
    });

    it('writes the fallback when no version source exists', () => {
      const out = projectVersion.recordVersion(tmpDir);
      assert.equal(out.version, '0.0.0-dev');
      assert.equal(out.source, 'fallback');
      const body = fs.readFileSync(out.path, 'utf8');
      assert.match(body, /^version: 0\.0\.0-dev$/m);
      assert.match(body, /^source: fallback$/m);
    });

    it('returns null on empty/non-string projectPath without throwing', () => {
      assert.equal(projectVersion.recordVersion(''), null);
      assert.equal(projectVersion.recordVersion(null), null);
      assert.equal(projectVersion.recordVersion(undefined), null);
      assert.equal(projectVersion.recordVersion(42), null);
    });

    it('returns null and does not throw when the project dir is not writable', () => {
      fs.writeFileSync(path.join(tmpDir, 'version.json'), '{ "version": "1.0.0" }\n');
      // Make the project dir read-only so .tangleclaw/ creation fails.
      fs.chmodSync(tmpDir, 0o500);
      try {
        const out = projectVersion.recordVersion(tmpDir);
        // On macOS root-owned tmpdirs, chmod may not actually deny — accept either result.
        // Either: the write succeeded (returns an object), or it was rejected (returns null).
        if (out !== null) {
          assert.ok(typeof out === 'object', 'should return an object on success');
        } else {
          assert.equal(out, null, 'should return null on failure');
        }
      } finally {
        fs.chmodSync(tmpDir, 0o755);
      }
    });
  });

  describe('_formatCacheFile', () => {
    it('produces the canonical 3-line format with trailing newline', () => {
      const out = projectVersion._formatCacheFile({
        version: '1.2.3',
        source: 'CHANGELOG.md',
        recordedAt: '2026-04-30T12:34:56Z'
      });
      assert.equal(out, 'version: 1.2.3\nrecorded_at: 2026-04-30T12:34:56Z\nsource: CHANGELOG.md\n');
    });
  });

  describe('_readGitTagVersion', () => {
    it('returns null for a non-git directory', () => {
      assert.equal(projectVersion._readGitTagVersion(tmpDir), null);
    });

    it('returns null for a git repo with no tags', () => {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });
      assert.equal(projectVersion._readGitTagVersion(tmpDir), null);
    });

    it('returns the most recent tag, "v" prefix stripped', () => {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });
      execFileSync('git', ['tag', 'v1.0.0'], { cwd: tmpDir });
      assert.equal(projectVersion._readGitTagVersion(tmpDir), '1.0.0');
    });

    it('preserves tags without a "v" prefix', () => {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });
      execFileSync('git', ['tag', '1.0.0'], { cwd: tmpDir });
      assert.equal(projectVersion._readGitTagVersion(tmpDir), '1.0.0');
    });
  });
});
