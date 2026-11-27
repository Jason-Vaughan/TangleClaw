'use strict';

// Standalone memory-backup module (#3314). No subprocess, no node:sqlite
// database, no socket -- every test here is plain fs against throwaway
// temp directories, matching the `small` tier's own contract.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backup = require('../lib/backup');
const cli = require('../scripts/backup-db');

let tmpDir;
let claudeProjectsDir;
let backupsRoot;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-backup-memory-'));
  claudeProjectsDir = path.join(tmpDir, 'claude-projects');
  backupsRoot = path.join(tmpDir, 'backups');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed one project's memory/ directory with the given {relPath: content} files. */
function seedProjectMemory(projectName, files) {
  const memoryDir = path.join(claudeProjectsDir, projectName, 'memory');
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(memoryDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

describe('createMemoryBackup', () => {
  it('snapshots only the memory/ subdirectory of each project, with a verified manifest', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': '# index\n', 'feedback_a.md': 'be terse\n' });
    seedProjectMemory('TC-Lane-PM', { 'MEMORY.md': '# pm index\n' });
    // Not under memory/ -- must never be archived.
    fs.mkdirSync(path.join(claudeProjectsDir, 'TC-Lane-D', 'transcripts'), { recursive: true });
    fs.writeFileSync(path.join(claudeProjectsDir, 'TC-Lane-D', 'transcripts', 'session.jsonl'), 'ignore me\n');
    // A project with no memory/ at all -- must be skipped cleanly, not error.
    fs.mkdirSync(path.join(claudeProjectsDir, 'TC-Lane-NoMemory'), { recursive: true });

    const { backupDir, manifest, verification } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });

    assert.ok(fs.existsSync(backupDir));
    assert.equal(verification.ok, true);
    assert.deepEqual(manifest.projects, ['TC-Lane-D', 'TC-Lane-PM']);
    assert.equal(manifest.fileCount, 3);
    assert.equal(manifest.files.length, 3);
    const relPaths = manifest.files.map((f) => f.relPath).sort();
    assert.deepEqual(relPaths, [
      'claude-projects-memory/TC-Lane-D/MEMORY.md',
      'claude-projects-memory/TC-Lane-D/feedback_a.md',
      'claude-projects-memory/TC-Lane-PM/MEMORY.md'
    ]);
    // Every entry carries a real, independently-recomputable digest.
    for (const entry of manifest.files) {
      const bytes = fs.readFileSync(path.join(backupDir, 'files', ...entry.relPath.split('/')));
      assert.equal(backup._sha256(bytes), entry.sha256);
      assert.equal(bytes.length, entry.bytes);
    }
    assert.equal(fs.existsSync(path.join(backupDir, 'files', 'claude-projects-memory', 'TC-Lane-D', 'transcripts')), false);
  });

  it('includes extraMemoryDirs and an optional sqliteDbPath under their own labels', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    const otherEngineMemory = path.join(tmpDir, 'other-engine-brain');
    fs.mkdirSync(otherEngineMemory, { recursive: true });
    fs.writeFileSync(path.join(otherEngineMemory, 'notes.md'), 'other engine notes\n');
    const sqliteDbPath = path.join(tmpDir, 'fake.db');
    fs.writeFileSync(sqliteDbPath, 'not a real sqlite file, just bytes\n');

    const { manifest } = backup.createMemoryBackup({
      claudeProjectsDir,
      backupsRoot,
      extraMemoryDirs: [{ label: 'other-engine', dir: otherEngineMemory }],
      sqliteDbPath
    });

    const relPaths = manifest.files.map((f) => f.relPath).sort();
    assert.deepEqual(relPaths, [
      'claude-projects-memory/TC-Lane-D/MEMORY.md',
      'other-engine/notes.md',
      'sqlite/fake.db'
    ]);
    assert.deepEqual(manifest.sources, ['claude-projects-memory', 'other-engine', 'sqlite']);
  });

  it('refuses a reserved label and a malformed extraMemoryDirs entry', () => {
    assert.throws(
      () => backup.createMemoryBackup({ claudeProjectsDir, backupsRoot, extraMemoryDirs: [{ label: 'sqlite', dir: tmpDir }] }),
      TypeError
    );
    assert.throws(
      () => backup.createMemoryBackup({ claudeProjectsDir, backupsRoot, extraMemoryDirs: [{ label: '', dir: tmpDir }] }),
      TypeError
    );
  });

  // PRR-B R-Gate Round 2 WARNING on PR #3338: an unrestricted label would
  // let _copyIntoBundle's `${label}/${relPath}` join escape files/ via `..`
  // during CREATE -- the same class of escape, on the write side this time.
  it('refuses a path-traversal extraMemoryDirs label, writing nothing outside the backup', () => {
    const otherEngineMemory = path.join(tmpDir, 'other-engine-brain');
    fs.mkdirSync(otherEngineMemory, { recursive: true });
    fs.writeFileSync(path.join(otherEngineMemory, 'notes.md'), 'notes\n');

    for (const badLabel of ['../../../tmp/evil', 'a/b', '.', '..', '.hidden']) {
      assert.throws(
        () => backup.createMemoryBackup({
          claudeProjectsDir, backupsRoot, extraMemoryDirs: [{ label: badLabel, dir: otherEngineMemory }]
        }),
        TypeError,
        `label "${badLabel}" must be refused`
      );
    }
    assert.equal(fs.existsSync(backupsRoot), false, 'validation must run before any backup directory is even created');
  });

  it('succeeds with an empty manifest when claudeProjectsDir does not exist yet', () => {
    const { manifest, verification } = backup.createMemoryBackup({
      claudeProjectsDir: path.join(tmpDir, 'does-not-exist'), backupsRoot
    });
    assert.equal(manifest.fileCount, 0);
    assert.deepEqual(manifest.projects, []);
    assert.equal(verification.ok, true);
  });

  it('never follows a symlink inside a memory/ directory', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'real\n' });
    const outside = path.join(tmpDir, 'outside-secret.md');
    fs.writeFileSync(outside, 'must never be archived\n');
    fs.symlinkSync(outside, path.join(claudeProjectsDir, 'TC-Lane-D', 'memory', 'link.md'));

    const { manifest } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    assert.deepEqual(manifest.files.map((f) => f.relPath), ['claude-projects-memory/TC-Lane-D/MEMORY.md']);
  });

  // PRR-B R-Gate Round 1 WARNING on PR #3338: the per-entry symlink skip
  // above never covered the WALK'S OWN ROOT -- a project's memory/ directory
  // itself (never an entry found by readdirSync on something else) could be
  // a symlink and still get followed.
  it('never follows a memory/ directory that is itself a symlink', () => {
    const outsideDir = path.join(tmpDir, 'outside-secret-dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'must never be archived\n');
    fs.mkdirSync(path.join(claudeProjectsDir, 'TC-Lane-D'), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(claudeProjectsDir, 'TC-Lane-D', 'memory'));

    const { manifest } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    assert.deepEqual(manifest.files, []);
    assert.deepEqual(manifest.projects, []);
  });

  it('never follows an extraMemoryDirs root that is itself a symlink', () => {
    const outsideDir = path.join(tmpDir, 'outside-secret-dir-2');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'must never be archived\n');
    const engineMemoryLink = path.join(tmpDir, 'engine-memory-link');
    fs.symlinkSync(outsideDir, engineMemoryLink);

    const { manifest } = backup.createMemoryBackup({
      claudeProjectsDir, backupsRoot, extraMemoryDirs: [{ label: 'other-engine', dir: engineMemoryLink }]
    });
    assert.deepEqual(manifest.files, []);
  });

  it('refuses to overwrite an existing backup directory for the same timestamp', () => {
    const now = new Date('2026-11-27T18:00:00.000Z');
    backup.createMemoryBackup({ claudeProjectsDir, backupsRoot, now });
    assert.throws(() => backup.createMemoryBackup({ claudeProjectsDir, backupsRoot, now }), /already exists/);
  });
});

describe('verifyMemoryBackup', () => {
  it('detects a missing file', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    fs.unlinkSync(path.join(backupDir, 'files', 'claude-projects-memory', 'TC-Lane-D', 'MEMORY.md'));

    const result = backup.verifyMemoryBackup(backupDir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['claude-projects-memory/TC-Lane-D/MEMORY.md']);
    assert.deepEqual(result.mismatched, []);
  });

  it('detects a tampered (digest-mismatched) file', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    fs.writeFileSync(path.join(backupDir, 'files', 'claude-projects-memory', 'TC-Lane-D', 'MEMORY.md'), 'tampered\n');

    const result = backup.verifyMemoryBackup(backupDir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatched, ['claude-projects-memory/TC-Lane-D/MEMORY.md']);
  });

  it('reports a readable error for a backup directory with no manifest at all', () => {
    const bogusDir = path.join(tmpDir, 'not-a-backup');
    fs.mkdirSync(bogusDir, { recursive: true });
    const result = backup.verifyMemoryBackup(bogusDir);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('manifest.json') || result.error.includes('ENOENT'));
  });

  // PRR-B R-Gate Round 1 BLOCKING on PR #3338: a crafted manifest can be
  // entirely self-consistent (its own files really do match its own
  // recorded SHA-256 digests) while its relPath escapes the backup's own
  // files/ directory via `../` segments -- the digest check alone cannot
  // catch this, since it never asked whether the PATH itself is safe.
  it('refuses (as invalid, never as missing) a manifest entry whose relPath escapes files/', () => {
    const bogusDir = path.join(tmpDir, 'crafted-backup');
    fs.mkdirSync(path.join(bogusDir, 'files'), { recursive: true });
    const outside = path.join(tmpDir, 'outside-secret.md');
    fs.writeFileSync(outside, 'real content, really matching its own digest\n');
    const bytes = fs.readFileSync(outside);
    const escapingRelPath = '../../outside-secret.md';
    fs.writeFileSync(path.join(bogusDir, 'manifest.json'), JSON.stringify({
      version: 1,
      files: [{ relPath: escapingRelPath, bytes: bytes.length, sha256: backup._sha256(bytes) }]
    }));

    const result = backup.verifyMemoryBackup(bogusDir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, [escapingRelPath]);
    assert.deepEqual(result.missing, [], 'an escaping path is its own category, never mistaken for merely missing');
    assert.deepEqual(result.mismatched, []);
  });

  // PRR-B R-Gate Round 3 BLOCKING repro, verbatim: backupDir/files replaced
  // with a symlink to an outside directory holding a file that matches the
  // manifest's own relPath AND recorded digest -- the digest alone cannot
  // catch this, since the attacker controls that outside file too.
  it('refuses when backupDir/files itself has been replaced with a symlink', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'real content\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    const outsideFiles = path.join(tmpDir, 'outside-files-dir');
    fs.mkdirSync(path.join(outsideFiles, 'claude-projects-memory', 'TC-Lane-D'), { recursive: true });
    fs.writeFileSync(path.join(outsideFiles, 'claude-projects-memory', 'TC-Lane-D', 'MEMORY.md'), 'real content\n');
    fs.rmSync(path.join(backupDir, 'files'), { recursive: true, force: true });
    fs.symlinkSync(outsideFiles, path.join(backupDir, 'files'));

    const result = backup.verifyMemoryBackup(backupDir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ['claude-projects-memory/TC-Lane-D/MEMORY.md']);
  });
});

describe('_resolveContained', () => {
  it('accepts a path that stays inside baseDir, including the exact base itself', () => {
    const base = path.join(tmpDir, 'base');
    assert.equal(backup._resolveContained(base, 'a/b.md'), path.join(base, 'a', 'b.md'));
    assert.equal(backup._resolveContained(base, ''), base);
  });

  it('refuses a relPath that escapes baseDir via .. segments', () => {
    const base = path.join(tmpDir, 'base', 'nested');
    assert.throws(() => backup._resolveContained(base, '../../escaped.md'), /escapes its intended root/);
  });
});

describe('_assertNoSymlinkComponent / _resolveContainedPhysical', () => {
  // PRR-B R-Gate Round 2 BLOCKING on PR #3338: a path that is LEXICALLY
  // contained (_resolveContained accepts it) can still have an existing
  // intermediate component be a symlink pointing anywhere -- path.resolve
  // has no concept of the real filesystem at all.
  it('refuses when an existing intermediate component is a symlink', () => {
    const base = path.join(tmpDir, 'base');
    fs.mkdirSync(base, { recursive: true });
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(base, 'project'));

    assert.doesNotThrow(() => backup._resolveContained(base, 'project/memory/x.md'), 'lexically this looks contained');
    assert.throws(
      () => backup._assertNoSymlinkComponent(base, 'project/memory/x.md'),
      /is a symlink/
    );
    assert.throws(
      () => backup._resolveContainedPhysical(base, 'project/memory/x.md'),
      /is a symlink/
    );
  });

  // PRR-B R-Gate Round 3 BLOCKING: the Round 2 fix only checked components
  // BUILT FROM relPath -- baseDir itself being the symlink went uncaught,
  // since lstat on a path under a symlinked parent still resolves to the
  // real target transparently.
  it('refuses when baseDir itself is a symlink', () => {
    const outside = path.join(tmpDir, 'outside-base');
    fs.mkdirSync(outside, { recursive: true });
    const symlinkedBase = path.join(tmpDir, 'base-is-a-symlink');
    fs.symlinkSync(outside, symlinkedBase);

    assert.doesNotThrow(() => backup._resolveContained(symlinkedBase, 'file.md'), 'lexically this looks contained');
    assert.throws(() => backup._assertNoSymlinkComponent(symlinkedBase, 'file.md'), /is a symlink/);
  });

  it('accepts a path whose components do not exist yet', () => {
    const base = path.join(tmpDir, 'base2');
    fs.mkdirSync(base, { recursive: true });
    assert.doesNotThrow(() => backup._assertNoSymlinkComponent(base, 'brand-new/dir/file.md'));
  });

  it('accepts a path whose existing components are real directories, not symlinks', () => {
    const base = path.join(tmpDir, 'base3');
    fs.mkdirSync(path.join(base, 'project', 'memory'), { recursive: true });
    assert.doesNotThrow(() => backup._assertNoSymlinkComponent(base, 'project/memory/x.md'));
  });
});

describe('inspectMemoryBackup', () => {
  it('summarizes a good backup', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    const summary = backup.inspectMemoryBackup(backupDir);
    assert.deepEqual(summary.projects, ['TC-Lane-D']);
    assert.equal(summary.fileCount, 1);
    assert.equal(summary.verification.ok, true);
    assert.ok(summary.createdAt);
  });
});

describe('restoreMemoryBackup', () => {
  it('restores every file to a fresh claudeProjectsDir', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'restored content\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    const restoreTarget = path.join(tmpDir, 'restored-claude-projects');

    const { restored } = backup.restoreMemoryBackup(backupDir, { claudeProjectsDir: restoreTarget });

    assert.equal(restored.length, 1);
    assert.equal(
      fs.readFileSync(path.join(restoreTarget, 'TC-Lane-D', 'memory', 'MEMORY.md'), 'utf8'),
      'restored content\n'
    );
  });

  it('dryRun reports the plan and writes nothing', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    const restoreTarget = path.join(tmpDir, 'restored-claude-projects');

    const { restored, dryRun } = backup.restoreMemoryBackup(backupDir, { claudeProjectsDir: restoreTarget, dryRun: true });

    assert.equal(dryRun, true);
    assert.equal(restored.length, 1);
    assert.equal(fs.existsSync(restoreTarget), false, 'dryRun must not create anything');
  });

  it('onlyProject restricts restore to one seat', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'd\n' });
    seedProjectMemory('TC-Lane-PM', { 'MEMORY.md': 'pm\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    const restoreTarget = path.join(tmpDir, 'restored-claude-projects');

    const { restored } = backup.restoreMemoryBackup(backupDir, { claudeProjectsDir: restoreTarget, onlyProject: 'TC-Lane-D' });

    assert.equal(restored.length, 1);
    assert.equal(fs.existsSync(path.join(restoreTarget, 'TC-Lane-D', 'memory', 'MEMORY.md')), true);
    assert.equal(fs.existsSync(path.join(restoreTarget, 'TC-Lane-PM')), false);
  });

  it('restores an extraMemoryDirs source only when its destination is named', () => {
    const otherEngineMemory = path.join(tmpDir, 'other-engine-brain');
    fs.mkdirSync(otherEngineMemory, { recursive: true });
    fs.writeFileSync(path.join(otherEngineMemory, 'notes.md'), 'notes\n');
    const { backupDir } = backup.createMemoryBackup({
      claudeProjectsDir, backupsRoot, extraMemoryDirs: [{ label: 'other-engine', dir: otherEngineMemory }]
    });
    const restoreTarget = path.join(tmpDir, 'restored-claude-projects');
    const otherDest = path.join(tmpDir, 'restored-other-engine');

    const unnamed = backup.restoreMemoryBackup(backupDir, { claudeProjectsDir: restoreTarget });
    assert.equal(unnamed.restored.length, 0, 'an unnamed extra label is skipped, never guessed at');

    const named = backup.restoreMemoryBackup(backupDir, {
      claudeProjectsDir: restoreTarget, extraMemoryDestDirs: { 'other-engine': otherDest }
    });
    assert.equal(named.restored.length, 1);
    assert.equal(fs.readFileSync(path.join(otherDest, 'notes.md'), 'utf8'), 'notes\n');
  });

  it('refuses to write anything when the backup fails verification', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    fs.writeFileSync(path.join(backupDir, 'files', 'claude-projects-memory', 'TC-Lane-D', 'MEMORY.md'), 'tampered\n');
    const restoreTarget = path.join(tmpDir, 'restored-claude-projects');

    assert.throws(() => backup.restoreMemoryBackup(backupDir, { claudeProjectsDir: restoreTarget }), /integrity verification failed/);
    assert.equal(fs.existsSync(restoreTarget), false);
  });

  it('refuses a manifest whose relPath escapes files/, writing nothing (PRR-B R-Gate Round 1 BLOCKING)', () => {
    const bogusDir = path.join(tmpDir, 'crafted-backup');
    fs.mkdirSync(path.join(bogusDir, 'files'), { recursive: true });
    const outside = path.join(tmpDir, 'planted.md');
    fs.writeFileSync(outside, 'planted\n');
    const bytes = fs.readFileSync(outside);
    fs.writeFileSync(path.join(bogusDir, 'manifest.json'), JSON.stringify({
      version: 1,
      files: [{ relPath: '../../planted.md', bytes: bytes.length, sha256: backup._sha256(bytes) }]
    }));
    const restoreTarget = path.join(tmpDir, 'restored-claude-projects');

    assert.throws(() => backup.restoreMemoryBackup(bogusDir, { claudeProjectsDir: restoreTarget }), /integrity verification failed/);
    assert.equal(fs.existsSync(restoreTarget), false);
  });

  it('refuses a same-manifest escape that stays inside files/ but escapes claudeProjectsDir on the destination side', () => {
    // A relPath that resolves safely against files/ (so verifyMemoryBackup's
    // own SOURCE-side check alone would not catch it) but whose project
    // segment ("..") escapes claudeProjectsDir once reinterpreted as a
    // restore destination -- exactly why destination containment needs its
    // own, separate check, not a single check reused for both sides.
    const bogusDir = path.join(tmpDir, 'crafted-backup-2');
    const plantedAbs = path.join(bogusDir, 'files', 'outside', 'memory', 'x.md');
    fs.mkdirSync(path.dirname(plantedAbs), { recursive: true });
    fs.writeFileSync(plantedAbs, 'planted\n');
    const bytes = fs.readFileSync(plantedAbs);
    const relPath = 'claude-projects-memory/../outside/memory/x.md';
    fs.writeFileSync(path.join(bogusDir, 'manifest.json'), JSON.stringify({
      version: 1,
      files: [{ relPath, bytes: bytes.length, sha256: backup._sha256(bytes) }]
    }));
    // Sanity: the source side really does consider this contained, so this
    // test is exercising the destination-side check specifically.
    assert.equal(backup.verifyMemoryBackup(bogusDir).ok, true);
    const restoreTarget = path.join(tmpDir, 'restored-claude-projects');

    assert.throws(() => backup.restoreMemoryBackup(bogusDir, { claudeProjectsDir: restoreTarget }), /escapes its intended root/);
    assert.equal(fs.existsSync(path.join(tmpDir, 'memory')), false, 'the escaped write must never have happened');
  });

  // PRR-B R-Gate Round 2 BLOCKING: a lexically-safe restore destination can
  // still have an existing <project>/memory already be a symlink elsewhere.
  it('refuses to restore through an existing symlinked <project>/memory destination', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    const restoreTarget = path.join(tmpDir, 'restored-claude-projects');
    const outside = path.join(tmpDir, 'planted-via-symlink');
    fs.mkdirSync(path.join(restoreTarget, 'TC-Lane-D'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(restoreTarget, 'TC-Lane-D', 'memory'));

    assert.throws(
      () => backup.restoreMemoryBackup(backupDir, { claudeProjectsDir: restoreTarget }),
      /is a symlink/
    );
    assert.equal(fs.existsSync(path.join(outside, 'MEMORY.md')), false, 'must never have written through the symlink');
  });

  // PRR-B R-Gate Round 3 BLOCKING, the other named repro: the restore
  // ROOT itself (claudeProjectsDir, not just a project's own memory/ below
  // it) being a symlink.
  it('refuses to restore when claudeProjectsDir itself is a symlink', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    const { backupDir } = backup.createMemoryBackup({ claudeProjectsDir, backupsRoot });
    const outside = path.join(tmpDir, 'planted-via-root-symlink');
    fs.mkdirSync(outside, { recursive: true });
    const symlinkedRestoreTarget = path.join(tmpDir, 'restore-root-is-a-symlink');
    fs.symlinkSync(outside, symlinkedRestoreTarget);

    assert.throws(
      () => backup.restoreMemoryBackup(backupDir, { claudeProjectsDir: symlinkedRestoreTarget }),
      /is a symlink/
    );
    assert.equal(fs.existsSync(path.join(outside, 'TC-Lane-D')), false, 'must never have written through the symlinked root');
  });
});

describe('pruneMemoryBackups', () => {
  it('keeps only the newest keepLast backups', () => {
    for (const ts of ['2026-11-25T00-00-00-000Z', '2026-11-26T00-00-00-000Z', '2026-11-27T00-00-00-000Z']) {
      fs.mkdirSync(path.join(backupsRoot, ts), { recursive: true });
    }
    const { kept, removed } = backup.pruneMemoryBackups(backupsRoot, { keepLast: 2 });
    assert.deepEqual(kept, ['2026-11-26T00-00-00-000Z', '2026-11-27T00-00-00-000Z']);
    assert.deepEqual(removed, ['2026-11-25T00-00-00-000Z']);
    assert.equal(fs.existsSync(path.join(backupsRoot, '2026-11-25T00-00-00-000Z')), false);
    assert.equal(fs.existsSync(path.join(backupsRoot, '2026-11-27T00-00-00-000Z')), true);
  });

  it('does nothing (not an error) when backupsRoot does not exist', () => {
    assert.deepEqual(backup.pruneMemoryBackups(path.join(tmpDir, 'nope'), { keepLast: 3 }), { kept: [], removed: [] });
  });
});

describe('scripts/backup-db.js CLI', () => {
  it('create -> verify -> inspect round-trip through the real CLI, each exiting 0', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });

    const created = cli.main(['create', '--claude-projects-dir', claudeProjectsDir, '--backups-root', backupsRoot]);
    assert.equal(created.code, 0);
    const backupDir = JSON.parse(created.stdout).backupDir;

    const verified = cli.main(['verify', backupDir]);
    assert.equal(verified.code, 0);

    const inspected = cli.main(['inspect', backupDir]);
    assert.equal(inspected.code, 0);
    assert.deepEqual(JSON.parse(inspected.stdout).projects, ['TC-Lane-D']);
  });

  it('verify exits 1 (not an exception) on a failed verification', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    const created = cli.main(['create', '--claude-projects-dir', claudeProjectsDir, '--backups-root', backupsRoot]);
    const backupDir = JSON.parse(created.stdout).backupDir;
    fs.writeFileSync(path.join(backupDir, 'files', 'claude-projects-memory', 'TC-Lane-D', 'MEMORY.md'), 'tampered\n');

    const verified = cli.main(['verify', backupDir]);
    assert.equal(verified.code, 1);
    assert.equal(JSON.parse(verified.stdout).ok, false);
  });

  it('restore with --dry-run and --only-project through the CLI', () => {
    seedProjectMemory('TC-Lane-D', { 'MEMORY.md': 'x\n' });
    seedProjectMemory('TC-Lane-PM', { 'MEMORY.md': 'y\n' });
    const created = cli.main(['create', '--claude-projects-dir', claudeProjectsDir, '--backups-root', backupsRoot]);
    const backupDir = JSON.parse(created.stdout).backupDir;
    const restoreTarget = path.join(tmpDir, 'restored');

    const result = cli.main([
      'restore', backupDir,
      '--claude-projects-dir', restoreTarget,
      '--only-project', 'TC-Lane-D',
      '--dry-run'
    ]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.restored.length, 1);
    assert.equal(fs.existsSync(restoreTarget), false);
  });

  it('prune with --keep-last through the CLI', () => {
    for (const ts of ['a', 'b', 'c']) fs.mkdirSync(path.join(backupsRoot, ts), { recursive: true });
    const result = cli.main(['prune', backupsRoot, '--keep-last', '1']);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).kept, ['c']);
  });

  it('refuses an unknown command and a missing required argument with exit code 2', () => {
    assert.equal(cli.main(['frobnicate']).code, 2);
    assert.equal(cli.main(['verify']).code, 2);
    assert.equal(cli.main(['restore']).code, 2);
    assert.equal(cli.main(['prune']).code, 2);
  });

  it('refuses a malformed --extra-memory-dir with exit code 1, not a thrown exception', () => {
    const result = cli.main(['create', '--extra-memory-dir', 'no-equals-sign', '--backups-root', backupsRoot]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /expected/);
  });
});
