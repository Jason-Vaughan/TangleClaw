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

  // #645 — the gate that verifies changelog-update must be satisfiable by the
  // changelog being CORRECT, not only by it being different, or it blocks every
  // session that followed the changelog-per-change rule. The declaration is what
  // carries the fix to an install, so pin it here rather than only at the gate.
  it('changelog-update declares the coverage predicate alongside its mutation check', () => {
    const step = defaultPipeline.steps().find((s) => s.id === 'changelog-update');
    assert.deepEqual(step.verifyChanged, ['CHANGELOG.md']);
    assert.equal(step.verifySatisfiedBy, 'changelog-coverage');
  });

  it('every declared verifySatisfiedBy names a predicate the gate implements', () => {
    // An unrecognized name degrades to the mutation check rather than throwing, so
    // a typo here would be silent at runtime — this is the only thing that catches it.
    const IMPLEMENTED = new Set(['changelog-coverage']);
    for (const step of defaultPipeline.steps()) {
      if (!step.verifySatisfiedBy) continue;
      assert.ok(IMPLEMENTED.has(step.verifySatisfiedBy),
        `${step.id} declares unimplemented predicate "${step.verifySatisfiedBy}"`);
    }
  });

  it('a step declaring verifySatisfiedBy also declares verifyChanged (the predicate is a second route, not the only one)', () => {
    for (const step of defaultPipeline.steps()) {
      if (!step.verifySatisfiedBy) continue;
      assert.ok(Array.isArray(step.verifyChanged) && step.verifyChanged.length > 0,
        `${step.id} declares a satisfaction predicate but no verifyChanged — the gate would never run`);
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

// ── The v27→v28 terminal seed sweep (#538) ──
//
// Before the methodology layer was retired, a project labeled `minimal` ran an
// effectively commit-only wrap. The label is the only thing that could identify
// those projects, so the migration that DROPS it must seed their overrides
// first — otherwise they silently flip to the full pipeline. These tests run the
// migration against a REAL pre-v28 database rather than a fresh create, because
// a fresh DB never has the column and would prove nothing.

const { DatabaseSync } = require('node:sqlite');
const store = require('../lib/store');

describe('v27→v28 methodology drop — terminal wrap-config seed', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-seed-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a store dir holding a pre-v28 database: real old schema (projects
   * carries `methodology`), stamped at v27 so the migration ladder runs.
   * @param {Array<{name: string, methodology: string, path: string, archived?: number}>} rows
   * @returns {string} the store base path
   */
  function makeV27Store(rows) {
    const base = fs.mkdtempSync(path.join(tmpDir, 'store-'));
    fs.mkdirSync(base, { recursive: true });
    const db = new DatabaseSync(path.join(base, 'tangleclaw.db'));
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        engine_id TEXT NOT NULL DEFAULT 'claude',
        methodology TEXT NOT NULL DEFAULT 'minimal',
        tags TEXT NOT NULL DEFAULT '[]',
        ports TEXT NOT NULL DEFAULT '{}',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_projects_methodology ON projects(methodology);
    `);
    db.prepare('INSERT INTO schema_version (version) VALUES (27)').run();
    for (const r of rows) {
      db.prepare('INSERT INTO projects (name, path, methodology, archived) VALUES (?, ?, ?, ?)')
        .run(r.name, r.path, r.methodology, r.archived ? 1 : 0);
    }
    db.close();
    return base;
  }

  /** Make a project dir, optionally with an existing project.json. */
  function makeProjectDir(name, config) {
    const p = path.join(tmpDir, name);
    fs.mkdirSync(path.join(p, '.tangleclaw'), { recursive: true });
    if (config) {
      fs.writeFileSync(path.join(p, '.tangleclaw', 'project.json'), JSON.stringify(config, null, 2));
    }
    return p;
  }

  /** Read a project's on-disk config raw (no default merge). */
  function readRawConfig(projectPath) {
    return JSON.parse(fs.readFileSync(path.join(projectPath, '.tangleclaw', 'project.json'), 'utf8'));
  }

  /** Run the migration by opening the store against a prepared base path. */
  function migrate(base) {
    store._setBasePath(base);
    store.init();
  }

  it('drops the methodology column and advances the schema version', () => {
    const base = makeV27Store([]);
    migrate(base);
    const cols = store.getDb().prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    assert.ok(!cols.includes('methodology'), 'the methodology column must be gone');
    const version = store.getDb().prepare('SELECT MAX(version) v FROM schema_version').get().v;
    assert.equal(version, 28);
    store.close();
  });

  it('seeds a minimal project commit-only BEFORE the column that identifies it is dropped', () => {
    const projectPath = makeProjectDir('seed-minimal');
    migrate(makeV27Store([{ name: 'seed-minimal', path: projectPath, methodology: 'minimal' }]));

    const onDisk = readRawConfig(projectPath);
    assert.equal(onDisk.wrapOverridesSeeded, true);
    const expected = defaultPipeline.steps()
      .filter((s) => !wrapStepOverrides.UNDISABLEABLE_KINDS.has(s.kind))
      .map((s) => s.id);
    assert.deepStrictEqual(Object.keys(onDisk.wrapStepOverrides).sort(), expected.slice().sort());
    for (const id of Object.keys(onDisk.wrapStepOverrides)) {
      assert.deepStrictEqual(onDisk.wrapStepOverrides[id], { enabled: false });
    }
    assert.deepStrictEqual(defaultPipeline.effectiveStepIds(onDisk.wrapStepOverrides), ['commit'],
      'a migrated project must wrap exactly as before: commit only');
    store.close();
  });

  it('seeds ARCHIVED minimal projects too — unarchiving must not flip the wrap shape', () => {
    const projectPath = makeProjectDir('seed-archived');
    migrate(makeV27Store([{ name: 'seed-archived', path: projectPath, methodology: 'minimal', archived: 1 }]));

    const onDisk = readRawConfig(projectPath);
    assert.equal(onDisk.wrapOverridesSeeded, true);
    assert.deepStrictEqual(defaultPipeline.effectiveStepIds(onDisk.wrapStepOverrides), ['commit']);
    store.close();
  });

  it('leaves a project that already carries the marker untouched', () => {
    // The operator may have cleared the map to opt INTO the full pipeline; the
    // migration must not undo that.
    const projectPath = makeProjectDir('seed-marked', { wrapOverridesSeeded: true, wrapStepOverrides: {} });
    migrate(makeV27Store([{ name: 'seed-marked', path: projectPath, methodology: 'minimal' }]));

    assert.deepStrictEqual(readRawConfig(projectPath).wrapStepOverrides, {},
      "the operator's cleared map must survive the migration");
    store.close();
  });

  it('preserves hand-authored overrides — stamps the marker only', () => {
    const projectPath = makeProjectDir('seed-authored', { wrapStepOverrides: { 'changelog-update': { enabled: false } } });
    migrate(makeV27Store([{ name: 'seed-authored', path: projectPath, methodology: 'minimal' }]));

    const onDisk = readRawConfig(projectPath);
    assert.equal(onDisk.wrapOverridesSeeded, true);
    assert.deepStrictEqual(onDisk.wrapStepOverrides, { 'changelog-update': { enabled: false } },
      'hand-authored overrides must not be replaced by the seed');
    store.close();
  });

  it('does not seed a non-minimal project', () => {
    const projectPath = makeProjectDir('seed-prawduct');
    migrate(makeV27Store([{ name: 'seed-prawduct', path: projectPath, methodology: 'prawduct' }]));

    assert.ok(!fs.existsSync(path.join(projectPath, '.tangleclaw', 'project.json')),
      'no config write for a project that already ran the full pipeline');
    store.close();
  });

  it('snapshots the database before dropping columns, and never overwrites an existing snapshot', () => {
    // The drops are unrecoverable from the live file and a downgrade cannot
    // read the result, so the one-time snapshot is the only way back.
    const base = makeV27Store([]);
    const backup = path.join(base, 'tangleclaw.db.pre-v28-backup');
    migrate(base);
    assert.ok(fs.existsSync(backup), 'a pre-v28 snapshot must exist');
    const snapshot = new DatabaseSync(backup, { readOnly: true });
    assert.ok(
      snapshot.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'methodology'),
      'the snapshot must hold the PRE-migration schema, not a copy of the migrated file'
    );
    snapshot.close();
    store.close();

    // Re-running must not clobber it with a post-migration copy.
    const before = fs.readFileSync(backup);
    migrate(base);
    assert.deepEqual(fs.readFileSync(backup), before, 'an existing snapshot must be left alone');
    store.close();
  });

  it('survives a project whose directory is gone, and still drops the column', () => {
    // Nothing can be written for an unreachable project, so the migration must
    // record it and carry on rather than aborting the whole ladder.
    const base = makeV27Store([{ name: 'seed-missing', path: path.join(tmpDir, 'does-not-exist'), methodology: 'minimal' }]);
    migrate(base);
    const cols = store.getDb().prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    assert.ok(!cols.includes('methodology'));
    store.close();
  });

  it('does NOT seed a project born after the cutover — the full pipeline is the ratified default (#652)', () => {
    // The seed sweep is scoped to the migrating population and deliberately has
    // no birth-time equivalent: it keys on a column that no longer exists.
    // A project created after the cutover therefore starts with an empty
    // override map and runs every shipped step. That is a REVERSAL of the
    // pre-cutover default (a new project used to be born `minimal`, i.e.
    // commit-only), ratified by the operator on 2026-07-20 after the
    // tc-cleanroom Phase B exit gate surfaced the inversion.
    //
    // This pins the decision so reintroducing birth-time commit-only seeding
    // fails here rather than silently re-flipping the default.
    const base = makeV27Store([]);
    migrate(base);

    const newborn = makeProjectDir('born-after-cutover');
    const config = store.projectConfig.load(newborn);

    assert.deepStrictEqual(config.wrapStepOverrides, {},
      'a project born after the cutover carries no overrides');
    assert.ok(!config.wrapOverridesSeeded,
      'the one-shot migration marker belongs to migrated projects only');
    assert.deepStrictEqual(
      defaultPipeline.effectiveStepIds(config.wrapStepOverrides),
      defaultPipeline.steps().map((s) => s.id),
      'a newborn project runs the FULL shipped pipeline, not a commit-only wrap'
    );
    store.close();
  });

  it('refuses to leave an unreadable project.json half-migrated', () => {
    // A corrupt config reads as "not yet seeded" through the defaults-returning
    // loader; the migration must raw-read so it never overwrites a file it
    // could not parse.
    const projectPath = makeProjectDir('seed-corrupt');
    fs.writeFileSync(path.join(projectPath, '.tangleclaw', 'project.json'), '{ not json');
    migrate(makeV27Store([{ name: 'seed-corrupt', path: projectPath, methodology: 'minimal' }]));

    assert.equal(fs.readFileSync(path.join(projectPath, '.tangleclaw', 'project.json'), 'utf8'), '{ not json',
      'the unparseable config must be left exactly as found');
    store.close();
  });
});
