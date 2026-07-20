'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const defaultPipeline = require('../lib/wrap-default-pipeline');
const wrapStepOverrides = require('../lib/wrap-step-overrides');

describe('wrap-default-pipeline — the code-owned pipeline', () => {
  it('pins step id order — the order carries correctness contracts between steps', () => {
    // The changelog must be written before the version bump reads it to
    // choose a level, and both before the commit that flushes them;
    // continuity-write runs after commit; apply-pr-resolutions last so the
    // auto-merge it authorizes cannot fire before the wrap commit is in
    // the PR. A failing run of this test means the order contract moved —
    // update deliberately, never casually.
    assert.deepStrictEqual(
      defaultPipeline.steps().map((s) => s.id),
      ['open-pr-check', 'changelog-update', 'version-bump', 'learnings-capture', 'learnings-db-write', 'rule-proposal', 'next-session-prime', 'features-toc', 'project-map', 'index-describe', 'memory-update', 'commit', 'continuity-write', 'apply-pr-resolutions']
    );
  });

  it('orders the correctness-coupled steps: changelog-update < version-bump < commit < continuity-write', () => {
    const ids = defaultPipeline.steps().map((s) => s.id);
    assert.ok(ids.indexOf('changelog-update') < ids.indexOf('version-bump'),
      'version-bump derives its level from the changelog the AI just wrote');
    assert.ok(ids.indexOf('version-bump') < ids.indexOf('commit'),
      'the commit flush must include the staged bump');
    assert.ok(ids.indexOf('commit') < ids.indexOf('continuity-write'),
      'continuity records the wrap commit, so it must follow it');
    assert.equal(ids[ids.length - 1], 'apply-pr-resolutions',
      'auto-merge authorization stays last');
  });

  it('steps() returns a deep copy — mutating a returned spec never leaks into the shared definition', () => {
    const first = defaultPipeline.steps();
    first[0].id = 'mutated';
    first.push({ id: 'extra', kind: 'commit' });
    const second = defaultPipeline.steps();
    assert.equal(second[0].id, 'open-pr-check');
    assert.equal(second.length, 14);
  });

  it('every ai-content step carries a non-empty prompt (a sane full-featured default, not minimal\'s self-skip shape)', () => {
    for (const step of defaultPipeline.steps()) {
      if (step.kind !== 'ai-content') continue;
      assert.equal(typeof step.prompt, 'string', `${step.id} must ship a prompt`);
      assert.ok(step.prompt.trim().length > 0,
        `${step.id} must not ship an empty prompt — empty prompts self-skip, which silently hollows the step out`);
    }
  });

  it('a step declaring captureFields also declares captureFile (the parse source)', () => {
    for (const step of defaultPipeline.steps()) {
      if (!Array.isArray(step.captureFields)) continue;
      assert.equal(typeof step.captureFile, 'string',
        `${step.id} declares captureFields but no captureFile — the fields would be unparseable`);
    }
  });

  describe('wrapShape', () => {
    it('derives step ids in run order plus the captureFields union', () => {
      const shape = defaultPipeline.wrapShape();
      assert.equal(shape.command, null);
      assert.deepStrictEqual(shape.steps, defaultPipeline.steps().map((s) => s.id));
      assert.deepStrictEqual(shape.captureFields, ['summary', 'nextSteps', 'learnings']);
    });
  });

  describe('effectiveStepIds', () => {
    it('returns all step ids when no overrides exist', () => {
      assert.deepStrictEqual(
        defaultPipeline.effectiveStepIds(null),
        defaultPipeline.steps().map((s) => s.id)
      );
    });

    it('filters out override-disabled steps', () => {
      const ids = defaultPipeline.effectiveStepIds({
        'changelog-update': { enabled: false },
        'memory-update': { enabled: false }
      });
      assert.ok(!ids.includes('changelog-update'));
      assert.ok(!ids.includes('memory-update'));
      assert.ok(ids.includes('commit'));
      assert.equal(ids.length, 12);
    });
  });
});

// ── One-shot commit-only seeding for `minimal`-labeled projects ──

const store = require('../lib/store');
const projects = require('../lib/projects');

describe('seedCommitOnlyWrapOverrides — minimal-methodology migration', () => {
  let tmpDir;
  let projectPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-seed-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    projectPath = path.join(tmpDir, 'seed-sandbox');
    fs.mkdirSync(projectPath, { recursive: true });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const cfgPath = path.join(projectPath, '.tangleclaw', 'project.json');
    if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
  });

  /** Load the on-disk project.json (raw, no default merge). */
  function readRawConfig() {
    return JSON.parse(fs.readFileSync(path.join(projectPath, '.tangleclaw', 'project.json'), 'utf8'));
  }

  it('seeds a minimal project with every step disabled except commit, and stamps the marker', () => {
    const project = { name: 'seed-sandbox', path: projectPath, methodology: 'minimal' };
    const projConfig = store.projectConfig.load(projectPath);

    const changed = projects.seedCommitOnlyWrapOverrides(project, projConfig);
    assert.equal(changed, true);

    const onDisk = readRawConfig();
    assert.equal(onDisk.wrapOverridesSeeded, true);
    const disabledIds = Object.keys(onDisk.wrapStepOverrides);
    const expected = defaultPipeline.steps()
      .filter((s) => !wrapStepOverrides.UNDISABLEABLE_KINDS.has(s.kind))
      .map((s) => s.id);
    assert.deepStrictEqual(disabledIds.sort(), expected.slice().sort());
    for (const id of disabledIds) {
      assert.deepStrictEqual(onDisk.wrapStepOverrides[id], { enabled: false });
    }
    assert.ok(!disabledIds.includes('commit'), 'commit is undisableable and must not be seeded off');
  });

  it('the seeded overrides yield a commit-only effective pipeline', () => {
    const project = { name: 'seed-sandbox', path: projectPath, methodology: 'minimal' };
    const projConfig = store.projectConfig.load(projectPath);
    projects.seedCommitOnlyWrapOverrides(project, projConfig);
    const ids = defaultPipeline.effectiveStepIds(readRawConfig().wrapStepOverrides);
    assert.deepStrictEqual(ids, ['commit'],
      'a migrated minimal project must wrap exactly as before: commit only');
  });

  it('is one-shot: a cleared overrides map is NOT re-seeded once the marker exists', () => {
    const project = { name: 'seed-sandbox', path: projectPath, methodology: 'minimal' };
    projects.seedCommitOnlyWrapOverrides(project, store.projectConfig.load(projectPath));

    // Operator opts into the full pipeline by clearing the map.
    const cleared = store.projectConfig.load(projectPath);
    cleared.wrapStepOverrides = {};
    store.projectConfig.save(projectPath, cleared);

    const changed = projects.seedCommitOnlyWrapOverrides(project, store.projectConfig.load(projectPath));
    assert.equal(changed, false, 'marker must prevent re-seeding');
    assert.deepStrictEqual(readRawConfig().wrapStepOverrides, {},
      'the operator\'s cleared map must survive the next boot');
  });

  it('preserves hand-authored overrides on a minimal project — stamps the marker only', () => {
    const authored = store.projectConfig.load(projectPath);
    authored.wrapStepOverrides = { 'changelog-update': { enabled: false } };
    store.projectConfig.save(projectPath, authored);

    const project = { name: 'seed-sandbox', path: projectPath, methodology: 'minimal' };
    const changed = projects.seedCommitOnlyWrapOverrides(project, store.projectConfig.load(projectPath));
    assert.equal(changed, true, 'marker stamp still writes');

    const onDisk = readRawConfig();
    assert.equal(onDisk.wrapOverridesSeeded, true);
    assert.deepStrictEqual(onDisk.wrapStepOverrides, { 'changelog-update': { enabled: false } },
      'hand-authored overrides must not be replaced by the seed');
  });

  it('does not touch prawduct projects', () => {
    const project = { name: 'seed-sandbox', path: projectPath, methodology: 'prawduct' };
    const changed = projects.seedCommitOnlyWrapOverrides(project, store.projectConfig.load(projectPath));
    assert.equal(changed, false);
    assert.ok(!fs.existsSync(path.join(projectPath, '.tangleclaw', 'project.json')),
      'no config write for a non-minimal project');
  });
});
