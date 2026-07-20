'use strict';

/*
 * The wrap's CHANGELOG write transaction — a cross-step contract that spans
 * `changelog-update` (the AI edits CHANGELOG.md on disk), `version-bump` (reads
 * CHANGELOG.md and stages the WHOLE promoted file), and `commit` (flushes every
 * staged write back to disk verbatim).
 *
 * The hazard: a staged whole-file snapshot taken BEFORE the AI's edit is
 * written back AFTER it, silently discarding the edit. That is exactly what
 * happened while `version-bump` ran ahead of `changelog-update` — the AI's
 * entry never survived a wrap that bumped, and the bump level was derived from
 * a CHANGELOG missing the session's own entry. The order is the fix, so these
 * tests pin the order AND the behavior it buys, not just one of the two.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const vb = require('../lib/wrap-steps/version-bump');
const commit = require('../lib/wrap-steps/commit');
const store = require('../lib/store');
const wrapDefaultPipeline = require('../lib/wrap-default-pipeline');

const AI_LINE = '- **The entry the AI wrote this session (#12345).**';

const CHANGELOG_WITH_AI_EDIT = `# Changelog

## [Unreleased]

### Added
${AI_LINE}

## [1.4.2] - 2026-05-01

### Fixed
- something old
`;

describe('wrap CHANGELOG transaction — step order is load-bearing', () => {
  const steps = wrapDefaultPipeline.steps();
  const idx = (id) => steps.findIndex((s) => s.id === id);

  it('every ai-content step that must change CHANGELOG.md runs BEFORE version-bump', () => {
    // The general invariant, not just today's step names: version-bump stages a
    // whole-file CHANGELOG snapshot, so any agent step contracted to edit that
    // file must have already done so.
    const vbIdx = idx('version-bump');
    assert.ok(vbIdx >= 0, 'precondition: the pipeline has a version-bump step');
    const changelogEditors = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => Array.isArray(s.verifyChanged) && s.verifyChanged.includes('CHANGELOG.md'));
    assert.ok(changelogEditors.length > 0, 'precondition: some step is contracted to edit CHANGELOG.md');
    for (const { s, i } of changelogEditors) {
      assert.ok(i < vbIdx,
        `"${s.id}" edits CHANGELOG.md but runs at ${i}, after version-bump at ${vbIdx} — `
        + 'its edit would be discarded by the commit flush of version-bump\'s staged snapshot');
    }
  });

  it('changelog-update precedes version-bump precedes commit', () => {
    assert.ok(idx('changelog-update') < idx('version-bump'));
    assert.ok(idx('version-bump') < idx('commit'));
  });

  // The step order used to live in a per-project JSON template, so reaching an
  // already-onboarded install needed a `schemaRevision` ratchet — pinned here by
  // a per-revision order fingerprint, plus a suite proving the re-sync landed.
  // The pipeline is code now (#538): the order ships with the code that runs it
  // and cannot lag on any install, so there is nothing left to propagate. The
  // order itself is pinned in test/wrap-default-pipeline.test.js.
});

describe('wrap CHANGELOG transaction — the AI edit survives into the release', () => {
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

  it('version-bump promotes the AI entry it finds on disk (so the release contains it)', async () => {
    vb._internal.existsSync = (p) => p.endsWith('version.json') || p.endsWith('CHANGELOG.md');
    vb._internal.readFileSync = (p) => (p.endsWith('version.json')
      ? '{"version":"1.4.2"}'
      : CHANGELOG_WITH_AI_EDIT);

    const context = {
      project: { name: 'p', path: '/p' },
      step: { id: 'version-bump', kind: 'version-bump' },
      staged: {},
      options: {}
    };
    const res = await vb.run(context);

    assert.equal(res.status, 'done', 'precondition: the bump happened');
    const stagedChangelog = context.staged['version-bump:changelog'];
    assert.ok(stagedChangelog, 'the changelog promote was staged');
    assert.ok(stagedChangelog.newContent.includes(AI_LINE),
      'THE PIN: the promoted changelog carries the AI-written entry — running version-bump '
      + 'after changelog-update is what puts the session entry inside the release section');
    assert.match(stagedChangelog.newContent, /## \[1\.5\.0\] - 2026-07-19/,
      'and the entry was promoted into a dated release heading');
  });
});

describe('wrap CHANGELOG transaction — why the order matters (the clobber mechanism)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-clobber-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('the commit flush overwrites an on-disk edit made after a write was staged', () => {
    // This documents the mechanism the step order defends against: staged
    // whole-file content is written back verbatim, with no re-read and no merge.
    const target = path.join(tmpDir, 'CHANGELOG.md');
    fs.writeFileSync(target, 'snapshot taken here\n');
    const staged = {
      'version-bump:changelog': {
        primingPath: target,
        newContent: 'snapshot taken here\n',
        changed: true
      }
    };
    // ...an agent edits the same file after the snapshot was staged...
    fs.writeFileSync(target, 'snapshot taken here\nAI ADDED THIS\n');

    commit._flushStagedWrites(staged);

    assert.equal(fs.readFileSync(target, 'utf8'), 'snapshot taken here\n',
      'the flush discards the later on-disk edit — hence the ordering invariant above');
  });
});
