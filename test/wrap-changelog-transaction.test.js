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
const prawductTemplate = require('../data/templates/prawduct/template.json');

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
  const steps = prawductTemplate.wrap_pipeline.steps;
  const idx = (id) => steps.findIndex((s) => s.id === id);

  it('every ai-content step that must change CHANGELOG.md runs BEFORE version-bump', () => {
    // The general invariant, not just today's step names: version-bump stages a
    // whole-file CHANGELOG snapshot, so any agent step contracted to edit that
    // file must have already done so.
    const vbIdx = idx('version-bump');
    assert.ok(vbIdx >= 0, 'precondition: the template has a version-bump step');
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

  // `wrap_pipeline.steps` is a FRAMEWORK_OWNED_PATH, and the reconciler's merge
  // is additive-by-id: a REORDER reaches an already-onboarded install only
  // through `_reconcileFrameworkSubtrees`, which is gated on
  // `bundledRev > liveRev`. So a step-order fix shipped without a
  // schemaRevision bump is inert everywhere but a fresh install — the bundled
  // JSON (and every test asserting against it) stays green while live wraps
  // keep running the old order.
  const STEP_ORDER_BY_REVISION = {
    6: [
      'open-pr-check', 'changelog-update', 'version-bump', 'learnings-capture',
      'learnings-db-write', 'next-session-prime', 'features-toc', 'project-map',
      'index-describe', 'memory-update', 'commit', 'continuity-write',
      'apply-pr-resolutions'
    ]
  };

  it('the bundled step order matches the fingerprint recorded for its schemaRevision', () => {
    const rev = prawductTemplate.schemaRevision;
    const expected = STEP_ORDER_BY_REVISION[rev];
    assert.ok(expected,
      `no step-order fingerprint recorded for schemaRevision ${rev}. If you changed `
      + 'wrap_pipeline.steps you MUST bump schemaRevision (or the change never reaches an '
      + 'onboarded install) AND record the new order here.');
    assert.deepStrictEqual(steps.map((s) => s.id), expected,
      'bundled step order drifted from the order recorded for this schemaRevision — '
      + 'bump schemaRevision so the change propagates, then update the fingerprint');
  });
});

describe('wrap CHANGELOG transaction — the reorder actually reaches onboarded installs', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-propagate-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const writeJson = (name, obj) => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };

  it('a live template stuck on the clobbering order is re-synced by the bundled revision', () => {
    // The exact pre-fix live shape: version-bump ahead of changelog-update.
    const staleLive = {
      id: 'prawduct',
      schemaRevision: prawductTemplate.schemaRevision - 1,
      wrap_pipeline: {
        steps: [
          { id: 'open-pr-check', kind: 'pr-check', blocker: true },
          { id: 'version-bump', kind: 'version-bump', blocker: false },
          { id: 'changelog-update', kind: 'ai-content', blocker: true },
          { id: 'commit', kind: 'commit', blocker: true }
        ]
      }
    };
    const bundled = writeJson('bundled.json', prawductTemplate);
    const live = writeJson('live.json', staleLive);

    store._mergeBundledTemplate(bundled, live);
    const merged = JSON.parse(fs.readFileSync(live, 'utf8'));

    const ids = merged.wrap_pipeline.steps.map((s) => s.id);
    assert.ok(ids.indexOf('changelog-update') < ids.indexOf('version-bump'),
      'THE PIN: the corrected order must reach an already-onboarded install, not just a '
      + 'fresh one — otherwise every existing project keeps discarding the AI changelog entry');
    assert.equal(merged.schemaRevision, prawductTemplate.schemaRevision,
      'and the revision is stamped so the re-sync is one-shot');
  });
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
