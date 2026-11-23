'use strict';

// #1370 Slice 1 (v5.61.0 Car 61-D, Architect Ruling A1370): the workspace
// rename orphaned-engine-state detector, via `lib/workspace-rename-check.js`.
// Real temp fixtures standing in for `~/.claude` and `~/.codex`, passed
// explicitly through `options.claudeHome`/`options.codexHome` -- no global
// home-directory stubbing needed, since every public function here takes
// them directly.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const logger = require('../lib/logger');
const { setLevel } = logger;

setLevel('error');

const wrc = require('../lib/workspace-rename-check');
const transcript = require('../lib/transcript');
const { shellWord } = require('../lib/shell-word');
const store = require('../lib/store');
const projects = require('../lib/projects');

let tmp;
let claudeHome;
let codexHome;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-workspace-rename-'));
  claudeHome = path.join(tmp, 'claude-home');
  codexHome = path.join(tmp, 'codex-home');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Write a Claude Code transcript for `workspacePath` into the fake `~/.claude`.
 * @param {string} workspacePath
 * @param {string} [uuid]
 * @returns {string} The file written.
 */
function writeClaudeTranscript(workspacePath, uuid = 'sess-1') {
  const dir = path.join(claudeHome, 'projects', transcript._encodeDir(workspacePath));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ type: 'message', cwd: workspacePath, content: 'hi' })}\n`);
  return file;
}

/**
 * Write a Codex rollout recording `cwd` as its content into the fake `~/.codex`.
 * @param {string} cwd
 * @param {string} [uuid]
 * @returns {string} The file written.
 */
function writeCodexRollout(cwd, uuid = 'rollout-1') {
  const dir = path.join(codexHome, 'sessions', '2026', '11');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { cwd, timestamp: '2026-11-03T00:00:00.000Z' } })}\n`);
  return file;
}

describe('SUPPORTED_ENGINES', () => {
  it('names exactly the engines this slice has a verified read path for', () => {
    assert.deepEqual(wrc.SUPPORTED_ENGINES, ['claude', 'codex']);
  });
});

describe('detectOrphanedEngineState', () => {
  it('reports no risk for a path with no engine state at all', () => {
    const r = wrc.detectOrphanedEngineState(path.join(tmp, 'fresh'), { claudeHome, codexHome });
    assert.deepEqual(r, { hasOrphanRisk: false, affectedEngines: [], orphanedPaths: [] });
  });

  it('finds Claude Code state keyed by the encoded directory name', () => {
    const ws = path.join(tmp, 'my-project');
    writeClaudeTranscript(ws);
    const r = wrc.detectOrphanedEngineState(ws, { claudeHome, codexHome });
    assert.equal(r.hasOrphanRisk, true);
    assert.deepEqual(r.affectedEngines, ['claude']);
    assert.equal(r.orphanedPaths[0].fileCount, 1);
  });

  it('finds Codex state by its own RECORDED cwd, not a directory name', () => {
    const ws = path.join(tmp, 'my-project');
    writeCodexRollout(ws);
    const r = wrc.detectOrphanedEngineState(ws, { claudeHome, codexHome });
    assert.equal(r.hasOrphanRisk, true);
    assert.deepEqual(r.affectedEngines, ['codex']);
  });

  it('reports both engines when both have state for the same path', () => {
    const ws = path.join(tmp, 'my-project');
    writeClaudeTranscript(ws);
    writeCodexRollout(ws);
    const r = wrc.detectOrphanedEngineState(ws, { claudeHome, codexHome });
    assert.deepEqual(r.affectedEngines.slice().sort(), ['claude', 'codex']);
  });

  it('never matches a Codex rollout recorded for a DIFFERENT cwd', () => {
    writeCodexRollout(path.join(tmp, 'other-project'));
    const r = wrc.detectOrphanedEngineState(path.join(tmp, 'my-project'), { claudeHome, codexHome });
    assert.equal(r.hasOrphanRisk, false);
  });

  it('refuses a non-absolute or non-string path rather than guess', () => {
    assert.equal(wrc.detectOrphanedEngineState('relative/path', { claudeHome, codexHome }).hasOrphanRisk, false);
    assert.equal(wrc.detectOrphanedEngineState(undefined, { claudeHome, codexHome }).hasOrphanRisk, false);
  });
});

describe('inspectWorkspaceRenameImpact', () => {
  it('names a real mv command for Claude\'s own encoded directory', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
    const impact = wrc.inspectWorkspaceRenameImpact(oldPath, newPath, { claudeHome, codexHome });
    assert.equal(impact.hasOrphanRisk, true);
    assert.equal(impact.migrationSteps.length, 1);
    assert.match(impact.migrationSteps[0], /^mv /);
    assert.ok(impact.migrationSteps[0].includes(transcript._encodeDir(oldPath)));
    assert.ok(impact.migrationSteps[0].includes(transcript._encodeDir(newPath)));
  });

  it('never proposes a command for Codex -- its rollouts cannot be relocated by moving a file', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeCodexRollout(oldPath);
    const impact = wrc.inspectWorkspaceRenameImpact(oldPath, newPath, { claudeHome, codexHome });
    assert.equal(impact.hasOrphanRisk, true);
    assert.ok(!/^mv /.test(impact.migrationSteps[0]));
    assert.match(impact.migrationSteps[0], /cannot be relocated/);
  });

  it('reports no risk and no migration steps for a workspace with no engine state', () => {
    const impact = wrc.inspectWorkspaceRenameImpact(path.join(tmp, 'old'), path.join(tmp, 'new'), { claudeHome, codexHome });
    assert.equal(impact.hasOrphanRisk, false);
    assert.deepEqual(impact.migrationSteps, []);
  });

  it('shell-escapes a path containing quotes, dollar signs, and shell metacharacters (I-Gate R1)', () => {
    // All legal in a macOS directory name. A naive `"${path}"` wrap would
    // place `; echo injected; #` outside quotes and execute it.
    const dangerous = path.join(tmp, '"; echo injected; #$(whoami)`id`\'x');
    const newPath = path.join(tmp, 'safe-new-name');
    writeClaudeTranscript(dangerous);
    const impact = wrc.inspectWorkspaceRenameImpact(dangerous, newPath, { claudeHome, codexHome });
    const step = impact.migrationSteps[0];
    const expectedTarget = path.join(claudeHome, 'projects', transcript._encodeDir(newPath));
    const expectedSource = path.join(claudeHome, 'projects', transcript._encodeDir(dangerous));
    assert.equal(step, `mv ${shellWord(expectedSource)} ${shellWord(expectedTarget)}`,
      'uses this repo\'s one shell-quoting primitive, not a hand-rolled escape');
  });
});

describe('renameWarningFor', () => {
  it('is null when there is no orphan risk', () => {
    assert.equal(wrc.renameWarningFor({ hasOrphanRisk: false }, '/a', '/b'), null);
  });

  it('names every affected engine and every migration step', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
    const impact = wrc.inspectWorkspaceRenameImpact(oldPath, newPath, { claudeHome, codexHome });
    const warning = wrc.renameWarningFor(impact, oldPath, newPath);
    assert.match(warning, /WARNING/);
    assert.match(warning, /claude/);
    assert.match(warning, new RegExp(oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('decideWorkspaceRename', () => {
  it('allows a rename outright when there is no orphan risk', () => {
    assert.deepEqual(wrc.decideWorkspaceRename('/a', '/b', { claudeHome, codexHome }), { allowed: true, requiresConfirmation: false, warning: null });
  });

  // #3196: Claude's own state, with its target encoded directory still
  // free, is exactly what migrateEngineStateOnRename will relocate right
  // after the rename -- never truly orphaned, so this must auto-allow.
  it('allows outright, with autoMigratable: ["claude"], when the only state is Claude\'s own and its target directory is free (#3196)', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
    const decision = wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome });
    assert.deepEqual(decision, { allowed: true, requiresConfirmation: false, warning: null, autoMigratable: ['claude'] });
  });

  // Pre-#3196 behavior (A1370 addendum §1.3), now exercised with CONTENT-
  // KEYED Codex state -- never auto-migratable, so it still must refuse.
  it('refuses an at-risk rename without explicit confirmation when the state is NOT auto-migratable', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeCodexRollout(oldPath);
    const decision = wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome });
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresConfirmation, true);
    assert.match(decision.warning, /WARNING/);
  });

  // #3196: being Claude's own state is not enough on its own -- a target
  // collision is exactly the case a human must resolve.
  it('refuses when Claude state exists but its target encoded directory already exists (#3196)', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
    fs.mkdirSync(path.join(claudeHome, 'projects', transcript._encodeDir(newPath)), { recursive: true });
    const decision = wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome });
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresConfirmation, true);
    assert.equal(decision.autoMigratable, undefined);
  });

  it('never defaults confirmation to true implicitly -- only an explicit confirmOrphanRisk: true passes, for non-migratable state', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeCodexRollout(oldPath);
    for (const bad of [undefined, null, false, 'true', 1]) {
      assert.equal(wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome, confirmOrphanRisk: bad }).allowed, false,
        `confirmOrphanRisk: ${JSON.stringify(bad)} must not pass as confirmation`);
    }
  });

  it('allows an at-risk (non-migratable) rename once explicitly confirmed, and still returns the warning for the caller to log', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeCodexRollout(oldPath);
    const decision = wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome, confirmOrphanRisk: true });
    assert.equal(decision.allowed, true);
    assert.equal(decision.requiresConfirmation, true);
    assert.match(decision.warning, /WARNING/);
  });

  // I-Gate Round 2 (#2863, review 5756902464): the earlier signature took a
  // caller-supplied impact and trusted it outright -- omitting inspection
  // (passing null) or passing a report for an unrelated workspace got
  // allowed: true with no confirmation check. Fixed by removing the
  // parameter entirely: there is no longer a caller-reachable argument
  // position where a missing or mismatched report could be supplied, so
  // these regressions prove the fix by construction -- there is no way to
  // ask this function to skip its own inspection anymore. Content-keyed
  // Codex state keeps this genuinely non-migratable post-#3196.
  it('refuses a genuinely risky (non-migratable) rename even when the caller never computed or saw any risk report itself', () => {
    const oldPath = path.join(tmp, 'risky-old');
    const newPath = path.join(tmp, 'new-name');
    writeCodexRollout(oldPath);
    // The caller supplies only oldPath/newPath/options -- exactly the
    // vulnerable repro from the review (`decideWorkspaceRename('/risky/old',
    // '/new', null)`), now structurally impossible to reproduce since the
    // third argument IS options, never an impact report.
    const decision = wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome });
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresConfirmation, true);
  });

  it('refuses when Claude state is auto-migratable but Codex state alongside it is not (#3196 -- mixed state)', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
    writeCodexRollout(oldPath);
    const decision = wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome });
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresConfirmation, true);
  });
});

describe('migrateEngineStateOnRename (#3196)', () => {
  it('moves Claude\'s encoded directory (and every file in it) when the target is free', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    const file = writeClaudeTranscript(oldPath, 'sess-1');
    const sourceDir = path.dirname(file);
    const targetDir = path.join(claudeHome, 'projects', transcript._encodeDir(newPath));

    const result = wrc.migrateEngineStateOnRename(oldPath, newPath, { claudeHome, codexHome });

    assert.deepEqual(result, { migrated: [{ engine: 'claude', from: sourceDir, to: targetDir, status: 'migrated' }], warnings: [] });
    assert.equal(fs.existsSync(sourceDir), false);
    assert.equal(fs.existsSync(path.join(targetDir, 'sess-1.jsonl')), true);
  });

  it('does nothing and reports nothing when there is no engine state at all', () => {
    const result = wrc.migrateEngineStateOnRename(path.join(tmp, 'a'), path.join(tmp, 'b'), { claudeHome, codexHome });
    assert.deepEqual(result, { migrated: [], warnings: [] });
  });

  it('does not overwrite an existing target directory, and surfaces a warning with the manual mv fallback', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    const file = writeClaudeTranscript(oldPath, 'sess-1');
    const sourceDir = path.dirname(file);
    const targetDir = path.join(claudeHome, 'projects', transcript._encodeDir(newPath));
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'existing-session.jsonl'), 'already here');

    const result = wrc.migrateEngineStateOnRename(oldPath, newPath, { claudeHome, codexHome });

    assert.equal(result.migrated.length, 1);
    assert.equal(result.migrated[0].status, 'failed');
    assert.equal(result.migrated[0].reason, 'target directory already exists');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /already exists/);
    assert.match(result.warnings[0], new RegExp(`mv ${shellWord(sourceDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // Neither side was touched: the pre-existing target content survives,
    // and the source was never moved out from under it.
    assert.equal(fs.existsSync(path.join(targetDir, 'existing-session.jsonl')), true);
    assert.equal(fs.existsSync(path.join(sourceDir, 'sess-1.jsonl')), true);
  });

  it('reports a failed migration (never throws) when fs.renameSync itself errors, e.g. EACCES', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    const file = writeClaudeTranscript(oldPath, 'sess-1');
    const sourceDir = path.dirname(file);
    const projectsDir = path.join(claudeHome, 'projects');
    fs.chmodSync(projectsDir, 0o555); // read+execute only: blocks the rename's own directory-entry rewrite
    try {
      assert.doesNotThrow(() => {
        const result = wrc.migrateEngineStateOnRename(oldPath, newPath, { claudeHome, codexHome });
        assert.equal(result.migrated[0].status, 'failed');
        assert.ok(typeof result.migrated[0].reason === 'string' && result.migrated[0].reason.length > 0);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0], /could not be migrated/);
      });
    } finally {
      fs.chmodSync(projectsDir, 0o755); // restore so afterEach's rmSync can clean up
    }
    assert.equal(fs.existsSync(sourceDir), true, 'the source is left exactly where it was on a failed migration');
  });

  it('never attempts to move Codex state -- always a non-fatal warning, reusing the content-keyed explanation', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeCodexRollout(oldPath);
    const result = wrc.migrateEngineStateOnRename(oldPath, newPath, { claudeHome, codexHome });
    assert.deepEqual(result.migrated, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /cannot be relocated/);
  });

  it('migrates Claude and warns about Codex independently when both have state for the same path', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
    writeCodexRollout(oldPath);
    const result = wrc.migrateEngineStateOnRename(oldPath, newPath, { claudeHome, codexHome });
    assert.equal(result.migrated.length, 1);
    assert.equal(result.migrated[0].status, 'migrated');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /cannot be relocated/);
  });
});

describe('findOrphanedSibling', () => {
  it('finds nothing when the workspace itself already has engine state (not freshly renamed)', () => {
    const ws = path.join(tmp, 'ws');
    writeClaudeTranscript(ws);
    const found = wrc.findOrphanedSibling(ws, [], { claudeHome, codexHome });
    assert.equal(found.hasOrphanedSibling, false);
  });

  it('finds a single candidate sibling with orphaned state, when the workspace itself has none', () => {
    const parent = path.join(tmp, 'projects');
    fs.mkdirSync(parent, { recursive: true });
    const oldSibling = path.join(parent, 'old-name');
    const ws = path.join(parent, 'new-name');
    fs.mkdirSync(oldSibling);
    fs.mkdirSync(ws);
    writeClaudeTranscript(oldSibling);
    const found = wrc.findOrphanedSibling(ws, [], { claudeHome, codexHome });
    assert.equal(found.hasOrphanedSibling, true);
    assert.equal(found.sibling, oldSibling);
    assert.deepEqual(found.impact.affectedEngines, ['claude']);
  });

  it('never reports a sibling that is still tracked under its own name', () => {
    const parent = path.join(tmp, 'projects');
    fs.mkdirSync(parent, { recursive: true });
    const stillActive = path.join(parent, 'still-active');
    const ws = path.join(parent, 'new-name');
    fs.mkdirSync(stillActive);
    fs.mkdirSync(ws);
    writeClaudeTranscript(stillActive);
    const found = wrc.findOrphanedSibling(ws, ['still-active'], { claudeHome, codexHome });
    assert.equal(found.hasOrphanedSibling, false);
    assert.deepEqual(found.candidates, []);
  });

  it('refuses to guess between more than one candidate sibling', () => {
    const parent = path.join(tmp, 'projects');
    fs.mkdirSync(parent, { recursive: true });
    const a = path.join(parent, 'a');
    const b = path.join(parent, 'b');
    const ws = path.join(parent, 'new-name');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.mkdirSync(ws);
    writeClaudeTranscript(a);
    writeClaudeTranscript(b);
    const found = wrc.findOrphanedSibling(ws, [], { claudeHome, codexHome });
    assert.equal(found.hasOrphanedSibling, false);
    assert.equal(found.sibling, null);
    assert.deepEqual(found.candidates.slice().sort(), [a, b].sort());
  });

  // A1370 addendum: the caller's own known rename history, checked directly
  // -- never guessed at by listing a directory -- so it works even when the
  // previous path has a DIFFERENT parent entirely (a cross-volume move).
  it('finds an explicitly-named previous path with orphaned state, even outside the same parent', () => {
    const elsewhere = path.join(tmp, 'elsewhere-entirely', 'old-name');
    fs.mkdirSync(elsewhere, { recursive: true });
    const ws = path.join(tmp, 'projects', 'new-name');
    fs.mkdirSync(ws, { recursive: true });
    writeClaudeTranscript(elsewhere);
    const found = wrc.findOrphanedSibling(ws, [], { claudeHome, codexHome, previousWorkspacePaths: [elsewhere] });
    assert.equal(found.hasOrphanedSibling, true);
    assert.equal(found.sibling, elsewhere);
    assert.deepEqual(found.impact.affectedEngines, ['claude']);
  });

  it('ignores a previousWorkspacePaths entry with no orphaned state', () => {
    const ws = path.join(tmp, 'ws');
    const noState = path.join(tmp, 'never-had-state');
    const found = wrc.findOrphanedSibling(ws, [], { claudeHome, codexHome, previousWorkspacePaths: [noState] });
    assert.equal(found.hasOrphanedSibling, false);
    assert.deepEqual(found.candidates, []);
  });

  it('is ambiguous (fails closed) when a previousWorkspacePaths entry AND a same-parent sibling both have state', () => {
    const parent = path.join(tmp, 'projects');
    fs.mkdirSync(parent, { recursive: true });
    const sibling = path.join(parent, 'sibling-with-state');
    const ws = path.join(parent, 'new-name');
    fs.mkdirSync(sibling);
    fs.mkdirSync(ws);
    writeClaudeTranscript(sibling);
    const elsewhere = path.join(tmp, 'elsewhere', 'old-name');
    fs.mkdirSync(elsewhere, { recursive: true });
    writeClaudeTranscript(elsewhere);
    const found = wrc.findOrphanedSibling(ws, [], { claudeHome, codexHome, previousWorkspacePaths: [elsewhere] });
    assert.equal(found.hasOrphanedSibling, false);
    assert.deepEqual(found.candidates.slice().sort(), [elsewhere, sibling].sort());
  });

  it('never reports the workspace\'s own current path back to itself via previousWorkspacePaths', () => {
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const found = wrc.findOrphanedSibling(ws, [], { claudeHome, codexHome, previousWorkspacePaths: [ws] });
    assert.equal(found.hasOrphanedSibling, false);
    assert.deepEqual(found.candidates, []);
  });
});

describe('orphanedSiblingWarningFor', () => {
  it('is null when nothing was found', () => {
    assert.equal(wrc.orphanedSiblingWarningFor({ hasOrphanedSibling: false }, '/ws'), null);
  });

  it('names the sibling and its affected engines', () => {
    const parent = path.join(tmp, 'projects');
    fs.mkdirSync(parent, { recursive: true });
    const oldSibling = path.join(parent, 'old-name');
    const ws = path.join(parent, 'new-name');
    fs.mkdirSync(oldSibling);
    fs.mkdirSync(ws);
    writeClaudeTranscript(oldSibling);
    const found = wrc.findOrphanedSibling(ws, [], { claudeHome, codexHome });
    const note = wrc.orphanedSiblingWarningFor(found, ws);
    assert.match(note, /NOTE/);
    assert.ok(note.includes('old-name'));
    assert.match(note, /claude/);
  });
});

// #3196 (Car V659-W1-D): `_applyProjectUpdates`'s (`lib/projects.js`)
// automatic engine-state migration on project rename -- it wires
// `migrateEngineStateOnRename` right after `fs.renameSync` succeeds,
// folding its `warnings` into `updateProject`'s own return value and
// logging every successful migration. `migrateEngineStateOnRename`'s own
// logic is already fully covered above against real `claudeHome`/
// `codexHome` fixtures; this block's only job is the INTEGRATION seam. The
// real call site takes no `claudeHome`/`codexHome` override (by design --
// it reads the REAL `~/.claude`/`~/.codex`, same as every other
// engine-state reader in this codebase), so these tests stub
// `workspace-rename-check`'s own exported function for the duration of
// each one that needs a specific migration result, restoring it
// immediately after -- never touching the real filesystem's `~/.claude` or
// `~/.codex`. A separate `store`-backed project fixture, independent of
// this file's top-level `claudeHome`/`codexHome` temp dirs above.
describe('_applyProjectUpdates: automatic engine-state migration on rename (#3196)', () => {
  let storeTmpDir;
  let projectsDir;
  let originalMigrate;

  before(() => {
    storeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rename-migrate-'));
    projectsDir = path.join(storeTmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(storeTmpDir, 'tangleclaw'));
    store.init();
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(storeTmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalMigrate = wrc.migrateEngineStateOnRename;
  });

  afterEach(() => {
    // Restore the real implementation unconditionally, so a stub set by
    // one test can never leak into the next.
    wrc.migrateEngineStateOnRename = originalMigrate;
  });

  it('calls migrateEngineStateOnRename with the exact old/new paths right after a successful rename', async () => {
    projects.createProject({ name: 'mig-called' });
    let calledWith = null;
    wrc.migrateEngineStateOnRename = (oldPath, newPath) => {
      calledWith = { oldPath, newPath };
      return { migrated: [], warnings: [] };
    };
    const result = await projects.updateProject('mig-called', { name: 'mig-called-renamed' });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(calledWith.oldPath, path.join(projectsDir, 'mig-called'));
    assert.equal(calledWith.newPath, path.join(projectsDir, 'mig-called-renamed'));
  });

  it('adds nothing to updateProject\'s own warnings on a clean migration with 0 warnings', async () => {
    projects.createProject({ name: 'mig-clean' });
    wrc.migrateEngineStateOnRename = () => ({
      migrated: [{ engine: 'claude', from: '/old/encoded', to: '/new/encoded', status: 'migrated' }],
      warnings: []
    });
    const result = await projects.updateProject('mig-clean', { name: 'mig-clean-renamed' });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.deepEqual((result.warnings || []).filter((w) => w.includes('migrat')), []);
  });

  it('surfaces a migration warning (target collision / EACCES / Codex) onto updateProject\'s own warnings, without blocking the rename', async () => {
    projects.createProject({ name: 'mig-warn' });
    const WARNING = 'Claude Code engine state at /src was not migrated: /dst already exists. Resolve manually: mv /src /dst';
    wrc.migrateEngineStateOnRename = () => ({
      migrated: [{ engine: 'claude', from: '/src', to: '/dst', status: 'failed', reason: 'target directory already exists' }],
      warnings: [WARNING]
    });
    const result = await projects.updateProject('mig-warn', { name: 'mig-warn-renamed' });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.ok((result.warnings || []).includes(WARNING), JSON.stringify(result.warnings));
    // The directory rename itself already succeeded on disk -- a migration
    // warning reports that one piece did not complete, it never undoes the
    // rename or blocks the update as a whole.
    assert.equal(fs.existsSync(path.join(projectsDir, 'mig-warn-renamed')), true);
    assert.equal(fs.existsSync(path.join(projectsDir, 'mig-warn')), false);
  });

  it('logs every successful migration, keyed by the real old/new project paths', async () => {
    projects.createProject({ name: 'mig-logged' });
    const oldPath = path.join(projectsDir, 'mig-logged');
    const newPath = path.join(projectsDir, 'mig-logged-renamed');
    const migratedEntry = { engine: 'claude', from: '/a', to: '/b', status: 'migrated' };
    wrc.migrateEngineStateOnRename = () => ({ migrated: [migratedEntry], warnings: [] });
    // Every module's logger funnels through this one shared stream
    // (lib/logger.js#_write); pinning it here is the one seam that lets a
    // test read what `lib/projects.js`'s OWN (unexported) `log` instance
    // actually wrote. The whole file suppresses below ERROR (`setLevel`
    // above), so the level is raised for exactly this one call.
    let written = '';
    logger.setLevel('info');
    logger.setConsoleStream({ write: (chunk) => { written += chunk; } });
    try {
      await projects.updateProject('mig-logged', { name: 'mig-logged-renamed' });
    } finally {
      logger.setConsoleStream(null);
      logger.setLevel('error');
    }
    const line = written.split('\n').find((l) => l.includes('Engine state directory migrated with project rename'));
    assert.ok(line, `expected a migration log line among:\n${written}`);
    assert.ok(line.includes(`from=${oldPath}`), line);
    assert.ok(line.includes(`to=${newPath}`), line);
    assert.ok(line.includes(`migrated=${JSON.stringify([migratedEntry])}`), line);
  });

  it('never calls migrateEngineStateOnRename when the update carries no rename', async () => {
    projects.createProject({ name: 'mig-no-rename' });
    let called = false;
    wrc.migrateEngineStateOnRename = () => { called = true; return { migrated: [], warnings: [] }; };
    const result = await projects.updateProject('mig-no-rename', { tags: ['x'] });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(called, false);
  });
});
