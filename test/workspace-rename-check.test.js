'use strict';

// #1370 Slice 1 (v5.61.0 Car 61-D, Architect Ruling A1370): the workspace
// rename orphaned-engine-state detector, via `lib/workspace-rename-check.js`.
// Real temp fixtures standing in for `~/.claude` and `~/.codex`, passed
// explicitly through `options.claudeHome`/`options.codexHome` -- no global
// home-directory stubbing needed, since every public function here takes
// them directly.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const wrc = require('../lib/workspace-rename-check');
const transcript = require('../lib/transcript');
const { shellWord } = require('../lib/shell-word');

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

  it('refuses an at-risk rename without explicit confirmation (A1370 addendum §1.3)', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
    const decision = wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome });
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresConfirmation, true);
    assert.match(decision.warning, /WARNING/);
  });

  it('never defaults confirmation to true implicitly -- only an explicit confirmOrphanRisk: true passes', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
    for (const bad of [undefined, null, false, 'true', 1]) {
      assert.equal(wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome, confirmOrphanRisk: bad }).allowed, false,
        `confirmOrphanRisk: ${JSON.stringify(bad)} must not pass as confirmation`);
    }
  });

  it('allows an at-risk rename once explicitly confirmed, and still returns the warning for the caller to log', () => {
    const oldPath = path.join(tmp, 'old-name');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
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
  // ask this function to skip its own inspection anymore.
  it('refuses a genuinely risky rename even when the caller never computed or saw any risk report itself', () => {
    const oldPath = path.join(tmp, 'risky-old');
    const newPath = path.join(tmp, 'new-name');
    writeClaudeTranscript(oldPath);
    // The caller supplies only oldPath/newPath/options -- exactly the
    // vulnerable repro from the review (`decideWorkspaceRename('/risky/old',
    // '/new', null)`), now structurally impossible to reproduce since the
    // third argument IS options, never an impact report.
    const decision = wrc.decideWorkspaceRename(oldPath, newPath, { claudeHome, codexHome });
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresConfirmation, true);
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
