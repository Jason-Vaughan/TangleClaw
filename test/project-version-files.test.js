'use strict';

/**
 * The pure-fs version layer (#884, chunk 02b).
 *
 * Two properties are worth a test file of their own, because both are invariants
 * that a plausible edit breaks while every behavioral test still passes:
 *
 *   1. THE LADDER'S ORDER. Version detection has two ladders — the live one here
 *      and `lib/project-version.js:detectVersion`, which writes the cache at
 *      session launch and wrap. Where they disagree about which file holds a
 *      project's version, the read-time self-heal overwrites what the launch
 *      writer wrote and stamps a `source:` naming a file the value did not come
 *      from. Extracting these readers into a shared module is exactly the kind of
 *      change that silently reorders a chain, so the order is pinned rung by rung
 *      rather than left to the two or three cases other tests happen to cover.
 *
 *   2. THE CACHE WRITE IS ATOMIC. The self-heal now runs inside the forked
 *      scanner child, which the supervisor SIGKILLs mid-syscall. A write straight
 *      to the destination truncates it first, so a kill in that window leaves a
 *      partial file that `readVersionCacheFile` parses without complaint.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

const versionFiles = require('../lib/project-version-files');
const projectVersion = require('../lib/project-version');

setLevel('error');

describe('project-version-files', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pvf-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Write a project config naming an explicit version file, plus that file.
   * @param {string} filename - Basename of the configured version file.
   * @param {string} version - Version it should carry.
   * @returns {void}
   */
  function configureVersionFile(filename, version) {
    fs.mkdirSync(path.join(dir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'),
      JSON.stringify({ versionFilePath: filename }));
    fs.writeFileSync(path.join(dir, filename), JSON.stringify({ version }));
  }

  describe('the live ladder\'s order', () => {
    it('prefers each rung over the ones below it, all the way down', () => {
      // Every source present at once, each with a DISTINCT version, then removed
      // one rung at a time. A reordering shows up as the wrong version, not as a
      // missing one — which is what makes this stronger than four separate
      // single-source tests, each of which passes under any order.
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [1.1.1] - 2026-01-01\n');
      configureVersionFile('RELEASE.json', '2.2.2');
      fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '3.3.3' }));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '4.4.4' }));

      assert.deepEqual(versionFiles.detectLiveVersion(dir),
        { version: '1.1.1', source: 'CHANGELOG.md' }, 'CHANGELOG.md outranks everything');

      fs.rmSync(path.join(dir, 'CHANGELOG.md'));
      assert.deepEqual(versionFiles.detectLiveVersion(dir),
        { version: '2.2.2', source: 'RELEASE.json' },
        'a configured versionFilePath outranks the built-in probe');

      fs.rmSync(path.join(dir, 'RELEASE.json'));
      assert.deepEqual(versionFiles.detectLiveVersion(dir),
        { version: '3.3.3', source: 'version.json' }, 'version.json outranks package.json');

      fs.rmSync(path.join(dir, 'version.json'));
      assert.deepEqual(versionFiles.detectLiveVersion(dir),
        { version: '4.4.4', source: 'package.json' }, 'package.json is the last live rung');

      fs.rmSync(path.join(dir, 'package.json'));
      assert.equal(versionFiles.detectLiveVersion(dir), null,
        'and there is deliberately no git-tag rung here — that one belongs to the writer');
    });

    it('agrees rung for rung with the launch/wrap ladder, which writes the cache', () => {
      // THE MUTATION THIS CATCHES: reordering ONE of the two ladders. They are
      // separate functions in separate modules and the tail differs on purpose,
      // so nothing but this comparison notices when their shared rungs drift —
      // and the symptom of drift is a cache stamped with a `source:` that names a
      // file the version did not come from.
      const rungs = [
        () => fs.writeFileSync(path.join(dir, 'CHANGELOG.md'),
          '# Changelog\n\n## [1.1.1] - 2026-01-01\n'),
        () => configureVersionFile('RELEASE.json', '2.2.2'),
        () => fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '3.3.3' })),
        () => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '4.4.4' }))
      ];
      // Build the stack from the BOTTOM up, asserting after each addition that
      // both ladders now report the newly-added, higher-priority source.
      for (const addRung of [...rungs].reverse()) {
        addRung();
        const live = versionFiles.detectLiveVersion(dir);
        const recorded = projectVersion.detectVersion(dir);
        assert.deepEqual(
          { version: recorded.version, source: recorded.source }, live,
          'the writing ladder and the self-healing ladder must pick the same source'
        );
      }
    });
  });

  describe('the cache write', () => {
    const cacheOf = (d) => path.join(d, '.tangleclaw', 'project-version.txt');

    it('writes a readable cache and reports success', () => {
      assert.equal(versionFiles.writeVersionCacheFile(dir, '1.2.3', 'CHANGELOG.md'), true);
      const body = fs.readFileSync(cacheOf(dir), 'utf8');
      assert.match(body, /^version: 1\.2\.3$/m);
      assert.match(body, /^source: CHANGELOG\.md$/m);
      assert.match(body, /^recorded_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
      assert.equal(versionFiles.readVersionCacheFile(dir), '1.2.3');
    });

    it('never opens the destination for writing — it stages and renames', () => {
      // THE MUTATION THIS CATCHES: `fs.writeFileSync(file, ...)` instead of the
      // temp-then-rename pair. That passes every content assertion above, because
      // the resulting file is identical; the difference only appears when the
      // process dies between the truncate and the last byte, which no ordinary
      // test can schedule. So the guard is on the MECHANISM: the destination path
      // must never be handed to a call that truncates it.
      const realWrite = fs.writeFileSync;
      const written = [];
      fs.writeFileSync = (target, ...rest) => {
        written.push(String(target));
        return realWrite(target, ...rest);
      };
      try {
        assert.equal(versionFiles.writeVersionCacheFile(dir, '9.9.9', 'version.json'), true);
      } finally {
        fs.writeFileSync = realWrite;
      }

      assert.ok(written.length > 0, 'the writer must actually have written something');
      assert.ok(!written.includes(cacheOf(dir)),
        'the destination must be reached by rename, never by a truncating write');
      assert.ok(written.every((p) => path.dirname(p) === path.dirname(cacheOf(dir))),
        'the staging file must share a directory with the destination, or the rename '
        + 'can cross a filesystem and stop being atomic');
      assert.equal(versionFiles.readVersionCacheFile(dir), '9.9.9');
    });

    it('leaves the previous cache intact when it dies before the rename', () => {
      // The kill this models: the supervisor SIGKILLs the scanner child once a
      // path stops answering, and it can land at any instruction. Failing the
      // rename is the observable stand-in for dying just before it — the staged
      // content exists, and the destination must still hold the OLD version
      // rather than a truncated or half-written one.
      assert.equal(versionFiles.writeVersionCacheFile(dir, '1.0.0', 'CHANGELOG.md'), true);
      const before = fs.readFileSync(cacheOf(dir), 'utf8');

      const realRename = fs.renameSync;
      fs.renameSync = () => { throw Object.assign(new Error('killed'), { code: 'EIO' }); };
      let result;
      try {
        result = versionFiles.writeVersionCacheFile(dir, '2.0.0', 'version.json');
      } finally {
        fs.renameSync = realRename;
      }

      assert.equal(result, false, 'a failed write reports failure rather than throwing');
      assert.equal(fs.readFileSync(cacheOf(dir), 'utf8'), before,
        'the destination still holds the complete previous version');
      assert.equal(versionFiles.readVersionCacheFile(dir), '1.0.0');
      assert.deepEqual(
        fs.readdirSync(path.join(dir, '.tangleclaw')), ['project-version.txt'],
        'and the staging file is cleaned up rather than accumulating one per failed poll'
      );
    });

    it('returns false rather than throwing when the project directory is not writable', () => {
      if (process.getuid && process.getuid() === 0) return; // root bypasses the check
      fs.chmodSync(dir, 0o500);
      try {
        assert.equal(versionFiles.writeVersionCacheFile(dir, '1.0.0', 'version.json'), false);
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    });
  });

  describe('the self-heal', () => {
    it('rewrites a cache the live sources have moved past, and returns the live value', () => {
      fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '5.0.0' }));
      assert.equal(versionFiles.writeVersionCacheFile(dir, '4.0.0', 'version.json'), true);

      assert.equal(versionFiles.detectProjectVersion(dir), '5.0.0');
      assert.equal(versionFiles.readVersionCacheFile(dir), '5.0.0',
        'the cache is healed in place, not just bypassed');
    });

    it('preserves a cache no live reader can reproduce', () => {
      // A git-tag-derived value: the launch/wrap ladder can produce it and the
      // live ladder deliberately cannot, so a null live read must not clobber it.
      assert.equal(versionFiles.writeVersionCacheFile(dir, '7.7.7', 'git tag'), true);
      assert.equal(versionFiles.detectProjectVersion(dir), '7.7.7');
      assert.equal(versionFiles.readVersionCacheFile(dir), '7.7.7');
    });

    it('reads nothing for a path that is not there', () => {
      assert.equal(versionFiles.detectProjectVersion(path.join(dir, 'nope')), null);
    });
  });

  it('reaches a project config without loading the server database', () => {
    // THE MUTATION THIS CATCHES: reading project config through
    // `require('./store').projectConfig.load` here. It is the module that owns
    // the public name for this API, it works, and it opens SQLite at require
    // time — inside a process the supervisor SIGKILLs mid-syscall, which is a
    // handle on the server's own database in a process that never closes it.
    //
    // Asserted in a FRESH process, and on THIS module rather than only on the
    // child that consumes it: this suite has loaded `store` long ago through
    // `project-version.js`'s neighbours, so an in-process check passes while the
    // defect is live. `detectProjectVersion` is called, not merely required,
    // because the form that gets through review is the lazy one that appears
    // only on first call.
    //
    // IT RUNS AGAINST AN EMPTY DIRECTORY, and that is the whole difference
    // between this guard working and merely appearing to. Pointed at the repo
    // root — the obvious choice — the first rung reads TangleClaw's own
    // CHANGELOG.md and returns, so the ladder never reaches the config rung and
    // the probe reports a clean process while the defect sits one rung below.
    // Measured, not assumed: the mutation was run and passed until the fixture
    // was changed to a directory with no version source at all.
    const { execFileSync } = require('node:child_process');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pvf-probe-'));
    try {
      const probe = 'const vf = require("./lib/project-version-files");'
        + `vf.detectProjectVersion(${JSON.stringify(empty)});`
        + 'process.stdout.write(String(Object.keys(require.cache).some(k => k.endsWith("/lib/store.js"))))';
      const loaded = execFileSync(process.execPath, ['-e', probe], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8'
      });
      assert.equal(loaded, 'false',
        'the version chain must reach project config without loading lib/store.js');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
