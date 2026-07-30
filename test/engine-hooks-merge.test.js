'use strict';

// `.claude/settings.json` hooks are MERGED, not replaced (#752).
//
// The defect: `syncEngineHooks` assigned `settings.hooks` wholesale from
// `_buildBaselineHooks`, which emits exactly one entry — TangleClaw's own
// SessionStart prime. Every other hook in the file was discarded. That file is the
// shareable, committable hooks location the Claude Code docs point operators at, and
// this function runs on every session launch, so an operator's PreToolUse guard or
// PostToolUse formatter vanished silently and repeatedly — and if the file was
// committed, TangleClaw dirtied the working tree on every launch too.
//
// The property under test is therefore not "our hook is present" but "everything
// that is not ours is still there", including in shapes this code does not model.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const engines = require('../lib/engines');

setLevel('error');

/** A hook entry TangleClaw emits, as it appears on disk after placeholder resolution. */
function tcEntry(script = 'sessionstart-prime.sh', arg = '') {
  return {
    matcher: 'startup',
    hooks: [{
      type: 'command',
      command: `"/Users/someone/Projects/TangleClaw/data/hooks/${script}"${arg}`,
      statusMessage: 'Loading session prime...'
    }]
  };
}

/** A hook entry the OPERATOR wrote — the thing that used to be destroyed. */
function operatorEntry(command = 'npm run lint') {
  return { matcher: 'Bash', hooks: [{ type: 'command', command }] };
}

describe('_isTangleClawHookEntry', () => {
  it('recognizes both scripts TangleClaw emits', () => {
    for (const script of engines.TC_HOOK_SCRIPTS) {
      assert.equal(engines._isTangleClawHookEntry(tcEntry(script)), true, script);
    }
  });

  it('recognizes its own entry after the install has been MOVED', () => {
    // Ownership keys off the script path, not the resolved install directory: an
    // operator who relocates the clone must not end up with a duplicate prime hook
    // beside an unrecognized old one.
    const moved = {
      matcher: 'startup',
      hooks: [{ type: 'command', command: '"/opt/tc/data/hooks/sessionstart-prime.sh"' }]
    };
    assert.equal(engines._isTangleClawHookEntry(moved), true);
  });

  it('does not claim an operator hook, however it is shaped', () => {
    for (const entry of [
      operatorEntry(),
      operatorEntry('/Users/someone/data/hooks/my-own-script.sh'),
      { matcher: 'Bash', hooks: [] },
      { hooks: [{ type: 'command' }] },
      {}, null, undefined, 'nonsense', 42
    ]) {
      assert.equal(engines._isTangleClawHookEntry(entry), false, JSON.stringify(entry));
    }
  });

  it('does not claim a hook merely because it mentions the TangleClaw directory', () => {
    // An operator hook that happens to reference the install (a wrap helper, a log
    // tail) is still theirs.
    const referencing = {
      hooks: [{ type: 'command', command: 'tail -f /Users/someone/Projects/TangleClaw/logs/server.log' }]
    };
    assert.equal(engines._isTangleClawHookEntry(referencing), false);
  });
});

describe('_mergeBaselineHooks', () => {
  it('keeps a foreign EVENT untouched', () => {
    const existing = { PreToolUse: [operatorEntry()] };
    const { hooks, preservedForeign } = engines._mergeBaselineHooks(existing, { SessionStart: [tcEntry()] });
    assert.deepEqual(hooks.PreToolUse, [operatorEntry()]);
    assert.equal(hooks.SessionStart.length, 1);
    assert.equal(preservedForeign, 1);
  });

  it('keeps a foreign ENTRY inside an event TangleClaw also writes', () => {
    // The harder half: SessionStart shared between an operator hook and ours.
    const existing = { SessionStart: [operatorEntry('echo hi'), tcEntry()] };
    const { hooks, replacedOwn } = engines._mergeBaselineHooks(existing, { SessionStart: [tcEntry()] });
    assert.equal(replacedOwn, 1, 'our previous entry is reconciled, not duplicated');
    assert.equal(hooks.SessionStart.length, 2);
    assert.deepEqual(hooks.SessionStart[0], operatorEntry('echo hi'), 'the operator entry survives');
    assert.equal(engines._isTangleClawHookEntry(hooks.SessionStart[1]), true);
  });

  it('does not duplicate our own entry across repeated syncs', () => {
    // syncEngineHooks runs on EVERY session launch, so a merge that appended
    // without reconciling would grow the file without bound.
    let hooks = { SessionStart: [tcEntry()] };
    for (let i = 0; i < 5; i += 1) {
      hooks = engines._mergeBaselineHooks(hooks, { SessionStart: [tcEntry()] }).hooks;
    }
    assert.equal(hooks.SessionStart.length, 1);
  });

  it('drops an event that held only our entries once we stop emitting it', () => {
    const { hooks } = engines._mergeBaselineHooks({ SessionStart: [tcEntry()] }, {});
    assert.equal('SessionStart' in hooks, false);
  });

  it('keeps an event that still holds foreign entries once we stop emitting it', () => {
    const { hooks } = engines._mergeBaselineHooks(
      { SessionStart: [operatorEntry('echo hi'), tcEntry()] }, {});
    assert.equal(hooks.SessionStart.length, 1);
    assert.deepEqual(hooks.SessionStart[0], operatorEntry('echo hi'));
  });

  it('passes through a shape it does not model rather than normalizing it away', () => {
    // A future Claude Code version, or an operator's hand-edit, may use a shape this
    // function has never seen. Dropping it would be the same class of loss as #752.
    const existing = { Stop: { legacy: 'object-not-array' }, PreToolUse: 'string' };
    const { hooks } = engines._mergeBaselineHooks(existing, {});
    assert.deepEqual(hooks.Stop, { legacy: 'object-not-array' });
    assert.equal(hooks.PreToolUse, 'string');
  });

  it('handles an absent or malformed existing hooks object', () => {
    for (const input of [undefined, null, 'x', 42, []]) {
      const { hooks } = engines._mergeBaselineHooks(input, { SessionStart: [tcEntry()] });
      assert.equal(hooks.SessionStart.length, 1, JSON.stringify(input));
    }
  });

  it('does not mutate the inputs', () => {
    const existing = { SessionStart: [operatorEntry()] };
    const baseline = { SessionStart: [tcEntry()] };
    const before = JSON.stringify([existing, baseline]);
    engines._mergeBaselineHooks(existing, baseline);
    assert.equal(JSON.stringify([existing, baseline]), before);
  });
});

describe('syncEngineHooks preserves operator hooks end to end', () => {
  let tmpDir;
  let projectPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hookmerge-'));
    store._setBasePath(path.join(tmpDir, 'home'));
    store.init();
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a settings.json and return its parsed content after a sync. */
  function syncWith(settings, projConfig) {
    fs.writeFileSync(path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify(settings, null, 2) + '\n');
    const cfg = { ...store.DEFAULT_PROJECT_CONFIG, ...(projConfig || {}) };
    store.projectConfig.save(projectPath, cfg);
    engines.syncEngineHooks(projectPath, cfg.engine || 'claude');
    return JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf8'));
  }

  it('leaves an operator PreToolUse guard in place after a claude sync', () => {
    const after = syncWith({
      enabledPlugins: { 'prawduct@prawduct': true },
      hooks: { PreToolUse: [operatorEntry()] }
    }, { engine: 'claude', silentPrime: true });

    assert.deepEqual(after.hooks.PreToolUse, [operatorEntry()],
      'the operator guard was discarded — this is #752');
    assert.deepEqual(after.enabledPlugins, { 'prawduct@prawduct': true },
      'non-hook keys must still survive');
  });

  it('leaves an operator hook in place when the engine is NOT claude', () => {
    // The non-claude branch deleted the whole hooks object, so it had the same
    // defect as the claude branch and needed the same fix.
    const after = syncWith({ hooks: { PreToolUse: [operatorEntry()] } }, { engine: 'codex' });
    assert.deepEqual(after.hooks.PreToolUse, [operatorEntry()]);
  });

  it('still clears OUR stale entry when the engine is not claude', () => {
    const after = syncWith({
      hooks: { SessionStart: [tcEntry()], PreToolUse: [operatorEntry()] }
    }, { engine: 'codex' });
    assert.equal('SessionStart' in (after.hooks || {}), false, 'our stale entry must go');
    assert.deepEqual(after.hooks.PreToolUse, [operatorEntry()], 'theirs must stay');
  });

  it('removes the hooks key entirely when nothing is left to hold', () => {
    const after = syncWith({ hooks: { SessionStart: [tcEntry()] } }, { engine: 'codex' });
    assert.equal('hooks' in after, false);
  });

  it('does not rewrite the file when there is nothing of ours to clear', () => {
    // Avoids dirtying a committed settings.json on every launch for a non-claude
    // project that has only operator hooks.
    const settingsFile = path.join(projectPath, '.claude', 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [operatorEntry()] } }, null, 2) + '\n');
    const cfg = { ...store.DEFAULT_PROJECT_CONFIG, engine: 'codex' };
    store.projectConfig.save(projectPath, cfg);
    const before = fs.statSync(settingsFile).mtimeMs;
    const raw = fs.readFileSync(settingsFile, 'utf8');
    engines.syncEngineHooks(projectPath, 'codex');
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), raw, 'file content changed');
    assert.equal(fs.statSync(settingsFile).mtimeMs, before, 'file was rewritten unnecessarily');
  });
});
