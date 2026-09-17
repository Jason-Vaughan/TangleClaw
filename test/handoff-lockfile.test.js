'use strict';

/**
 * The handoff lockfile on disk (Train 21, #1585).
 *
 * These tests pin the file half of the contract: bytes land atomically, the
 * publication order never destroys the document it replaces, and a read reports
 * WHICH of the three things it found rather than collapsing them to a boolean.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lockfile = require('../lib/handoff-lockfile.js');
const { buildHandoffDocument, serializeDocument, digestOf } = require('../lib/handoff-publication.js');

const tmpDirs = [];
let project;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-fs-'));
  tmpDirs.push(dir);
  project = { path: dir, configPath: dir };
});

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * A valid document with the given id.
 * @param {string} publicationId - Attempt id
 * @returns {object} Document
 */
function doc(publicationId) {
  return buildHandoffDocument({
    publicationId,
    projectId: 14,
    workspaceId: null,
    sessionId: 100,
    wrapRunId: 'run-1',
    engineId: 'claude',
    kind: 'final',
    stagedAt: '2026-09-17T21:00:00.000Z',
    worktree: null,
    rules: [],
    globalRulesHash: null,
    engineConfigHash: null,
    continuityIndexHash: null,
    wrapOutcome: 'complete',
    missingEvidence: []
  });
}

describe('staging bytes to disk (#1585)', () => {
  it('writes the staged file and reports the digest of exactly those bytes', () => {
    const d = doc('pub-a');
    const res = lockfile.writeStaged(project, d);
    assert.equal(res.digest, digestOf(serializeDocument(d)));
    assert.equal(fs.readFileSync(res.path, 'utf8'), serializeDocument(d));
  });

  it('leaves no temp file behind, so a reader never sees a half-written document', () => {
    lockfile.writeStaged(project, doc('pub-a'));
    const names = fs.readdirSync(lockfile.handoffDir(project));
    assert.deepEqual(names.filter((n) => n.endsWith('.tmp')), []);
  });

  it('creates the handoff directory on first use', () => {
    assert.equal(fs.existsSync(lockfile.handoffDir(project)), false);
    lockfile.writeStaged(project, doc('pub-a'));
    assert.equal(fs.existsSync(lockfile.handoffDir(project)), true);
  });
});

describe('promoting a staged attempt to current', () => {
  it('makes the staged bytes current and removes the staged file', () => {
    const d = doc('pub-a');
    lockfile.writeStaged(project, d);
    lockfile.promoteStaged(project, 'pub-a', null);

    assert.equal(fs.readFileSync(lockfile.currentPath(project), 'utf8'), serializeDocument(d));
    assert.equal(fs.existsSync(lockfile.stagedPath(project, 'pub-a')), false);
  });

  it('retires the previous publication into history BEFORE the new one lands, never destroying it', () => {
    const first = doc('pub-a');
    lockfile.writeStaged(project, first);
    lockfile.promoteStaged(project, 'pub-a', null);

    const second = doc('pub-b');
    lockfile.writeStaged(project, second);
    const res = lockfile.promoteStaged(project, 'pub-b', 'pub-a');

    assert.equal(res.retired, true);
    assert.equal(fs.readFileSync(lockfile.historyPath(project, 'pub-a'), 'utf8'), serializeDocument(first),
      'the replaced publication must survive verbatim');
    assert.equal(fs.readFileSync(lockfile.currentPath(project), 'utf8'), serializeDocument(second));
  });

  it('refuses to publish an attempt whose staged file is gone, rather than recording a publication with no bytes', () => {
    assert.throws(() => lockfile.promoteStaged(project, 'pub-missing', null), /staged file is missing/);
  });

  it('reports retiring nothing when there was no current publication', () => {
    lockfile.writeStaged(project, doc('pub-a'));
    assert.equal(lockfile.promoteStaged(project, 'pub-a', 'pub-none').retired, false);
  });
});

describe('reading a handoff file', () => {
  it('tells absent from corrupt from ok — three different facts', () => {
    assert.equal(lockfile.readHandoffFile(lockfile.currentPath(project)).outcome, 'absent');

    lockfile.writeStaged(project, doc('pub-a'));
    lockfile.promoteStaged(project, 'pub-a', null);
    assert.equal(lockfile.readHandoffFile(lockfile.currentPath(project)).outcome, 'ok');

    fs.writeFileSync(lockfile.currentPath(project), '{not json', 'utf8');
    const corrupt = lockfile.readHandoffFile(lockfile.currentPath(project));
    assert.equal(corrupt.outcome, 'corrupt');
    assert.match(corrupt.reason, /not JSON/);
  });

  it('reports an unreadable file as unreadable, never as absent', { skip: process.getuid && process.getuid() === 0 ? 'running as root' : false }, () => {
    lockfile.writeStaged(project, doc('pub-a'));
    lockfile.promoteStaged(project, 'pub-a', null);
    const file = lockfile.currentPath(project);
    fs.chmodSync(file, 0o000);
    try {
      const read = lockfile.readHandoffFile(file);
      assert.equal(read.outcome, 'unreadable', 'a permission failure is not a first launch');
      assert.match(read.reason, /EACCES/);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  it('hands back the raw bytes alongside the parsed document, so a caller digests what is on disk', () => {
    const d = doc('pub-a');
    lockfile.writeStaged(project, d);
    lockfile.promoteStaged(project, 'pub-a', null);
    const read = lockfile.readHandoffFile(lockfile.currentPath(project));
    assert.equal(read.raw, serializeDocument(d));
    assert.equal(read.digest, digestOf(read.raw));
  });
});

describe('observing the directory for reconciliation', () => {
  it('reports an empty, never-used directory without inventing a state', () => {
    const seen = lockfile.observe(project);
    assert.equal(seen.current.outcome, 'absent');
    assert.deepEqual(seen.staged, []);
  });

  it('lists every staged attempt still on disk — the crashed-before-rename window', () => {
    lockfile.writeStaged(project, doc('pub-a'));
    lockfile.writeStaged(project, doc('pub-b'));
    assert.deepEqual(lockfile.observe(project).staged.sort(), ['pub-a', 'pub-b']);
  });

  it('shows a staged file still present alongside a current one — the crashed-after-rename window', () => {
    lockfile.writeStaged(project, doc('pub-a'));
    lockfile.promoteStaged(project, 'pub-a', null);
    lockfile.writeStaged(project, doc('pub-b'));

    const seen = lockfile.observe(project);
    assert.equal(seen.current.doc.publicationId, 'pub-a');
    assert.deepEqual(seen.staged, ['pub-b'], 'the unpublished attempt is still visible for reconciliation');
  });

  it('does not mistake a history file for a staged one', () => {
    lockfile.writeStaged(project, doc('pub-a'));
    lockfile.promoteStaged(project, 'pub-a', null);
    lockfile.writeStaged(project, doc('pub-b'));
    lockfile.promoteStaged(project, 'pub-b', 'pub-a');
    assert.deepEqual(lockfile.observe(project).staged, []);
  });
});

describe('where the handoff lives', () => {
  it('follows the REGISTERED checkout, not the worktree a session wrapped from', () => {
    const worktree = { path: '/tmp/some-worktree', configPath: '/tmp/registered' };
    assert.equal(lockfile.handoffDir(worktree), path.join('/tmp/registered', '.tangleclaw', 'handoff'));
  });

  it('falls back to path when a record never passed through the runner', () => {
    assert.equal(lockfile.handoffDir({ path: '/tmp/plain' }), path.join('/tmp/plain', '.tangleclaw', 'handoff'));
  });
});
