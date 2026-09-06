'use strict';

// TangleClaw's hooks live in `.claude/settings.local.json`, never in the tracked
// `.claude/settings.json` (#1022, #1242, #1275).
//
// The defect: `syncEngineHooks` wrote a `SessionStart` hook naming an ABSOLUTE path
// to one machine's install into the shared, committable settings file. That path
// resolves nowhere else, so every managed project had to choose between a clone that
// works and committed governance — and the same file is the only carrier of the
// plugin install reference `lib/governance-state.js` anchors on, so ignoring it to
// protect other clones threw the governance reference away too.
//
// In this repo it had a second consequence with its own issue: the file was rewritten
// on every launch, so it was permanently dirty, so the wrap's `git add -A` swept it
// into the wrap commit, where the repo's own no-absolute-path guard rejected it — and
// `pr-merge` deliberately does not wait for CI, so the PR stranded with auto-merge
// armed while the wrap reported success.
//
// The properties under test are therefore about LOCATION and QUIET, not about the
// hook's content: ours is in the local file, ours is gone from the tracked file,
// the operator's is untouched in both, and a sync with nothing to say writes nothing.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const engines = require('../lib/engines');

setLevel('error');

/** A hook entry TangleClaw emits, as it appears on disk after placeholder resolution. */
function tcEntry(script = 'sessionstart-prime-claude.sh') {
  return {
    matcher: 'startup',
    hooks: [{
      type: 'command',
      command: `"/Users/someone/Projects/TangleClaw/data/hooks/${script}"`,
      statusMessage: 'Loading session prime...'
    }]
  };
}

/** A hook entry the OPERATOR wrote — never ours to move, retire, or rewrite. */
function operatorEntry(command = 'npm run lint') {
  return { matcher: 'Bash', hooks: [{ type: 'command', command }] };
}

/** The plugin install reference governance detection anchors on. */
const INSTALL_REFERENCE = {
  enabledPlugins: { 'prawduct@prawduct': true },
  extraKnownMarketplaces: {
    prawduct: { source: { source: 'github', repo: 'brookstalley/prawduct', ref: 'main' }, autoUpdate: true }
  }
};

describe('syncEngineHooks writes hooks to the machine-local file only', () => {
  let tmpDir;
  let projectPath;
  let sharedFile;
  let localFile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hookloc-'));
    store._setBasePath(path.join(tmpDir, 'home'));
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // A fresh project per test: these assert on file EXISTENCE, so a leftover
    // settings.local.json from the previous test would make an absence pass.
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'project-'));
    fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
    sharedFile = path.join(projectPath, '.claude', engines.SHARED_SETTINGS_BASENAME);
    localFile = path.join(projectPath, '.claude', engines.LOCAL_SETTINGS_BASENAME);
  });

  /** Write a shared settings file, sync, and return both files' parsed content. */
  function syncWith(shared, projConfig) {
    if (shared !== null) {
      fs.writeFileSync(sharedFile, JSON.stringify(shared, null, 2) + '\n');
    }
    const cfg = { ...store.DEFAULT_PROJECT_CONFIG, ...(projConfig || {}) };
    store.projectConfig.save(projectPath, cfg);
    engines.syncEngineHooks(projectPath, cfg.engine || 'claude');
    return {
      shared: fs.existsSync(sharedFile) ? JSON.parse(fs.readFileSync(sharedFile, 'utf8')) : null,
      local: fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : null
    };
  }

  it('puts its SessionStart hook in settings.local.json and not in settings.json', () => {
    const { shared, local } = syncWith(INSTALL_REFERENCE, { engine: 'claude', silentPrime: true });

    assert.ok(local && local.hooks && Array.isArray(local.hooks.SessionStart),
      'the hook must land in the machine-local file');
    assert.ok(local.hooks.SessionStart.some(engines._isTangleClawHookEntry),
      'and it must be recognisably ours');
    assert.equal('hooks' in shared, false,
      'the tracked, committable file must carry no hooks block — this is #1022');
  });

  it('leaves the plugin install reference in the tracked file untouched', () => {
    // `lib/governance-state.js` reads exactly these two keys. Moving the hooks out
    // must not disturb the pair, or a governed project reads as ungoverned.
    const { shared } = syncWith(INSTALL_REFERENCE, { engine: 'claude', silentPrime: true });
    assert.deepEqual(shared.enabledPlugins, INSTALL_REFERENCE.enabledPlugins);
    assert.deepEqual(shared.extraKnownMarketplaces, INSTALL_REFERENCE.extraKnownMarketplaces);
  });

  it('retires an entry a PREVIOUS version wrote into the tracked file', () => {
    // The migration case, and the reason the relocation is not simply a new write
    // target: every already-configured project holds one of these, naming a path
    // that resolves on exactly one machine, and nothing else would remove it (#1007).
    const { shared, local } = syncWith(
      { ...INSTALL_REFERENCE, hooks: { SessionStart: [tcEntry(), tcEntry('sessionstart-rules-claude.sh')] } },
      { engine: 'claude', silentPrime: true }
    );
    assert.equal('hooks' in shared, false, 'both stale entries must be retired');
    assert.ok(local.hooks.SessionStart.length > 0, 'and re-emitted in the local file');
  });

  it('retires our entry from the tracked file while keeping the operator entry beside it', () => {
    // The harder half of retirement: SessionStart shared between their hook and ours.
    // Clearing the whole event is what #752 fixed; the relocation must not undo it.
    const { shared } = syncWith(
      { ...INSTALL_REFERENCE, hooks: { SessionStart: [operatorEntry('echo hi'), tcEntry()] } },
      { engine: 'claude', silentPrime: true }
    );
    assert.equal(shared.hooks.SessionStart.length, 1);
    assert.deepEqual(shared.hooks.SessionStart[0], operatorEntry('echo hi'));
  });

  it('keeps a foreign event in the tracked file entirely alone', () => {
    const { shared } = syncWith(
      { ...INSTALL_REFERENCE, hooks: { PreToolUse: [operatorEntry()] } },
      { engine: 'claude', silentPrime: true }
    );
    assert.deepEqual(shared.hooks.PreToolUse, [operatorEntry()]);
  });

  it('keeps an operator hook already in the LOCAL file', () => {
    // `settings.local.json` is where Claude Code puts their per-machine config, so
    // it is no more ours to overwrite wholesale than the shared file was (#752).
    fs.writeFileSync(localFile, JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { PreToolUse: [operatorEntry()] }
    }, null, 2) + '\n');
    const { local } = syncWith(INSTALL_REFERENCE, { engine: 'claude', silentPrime: true });
    assert.deepEqual(local.hooks.PreToolUse, [operatorEntry()]);
    assert.deepEqual(local.permissions, { allow: ['Bash(ls:*)'] },
      'non-hook keys in the local file survive too');
    assert.ok(local.hooks.SessionStart.some(engines._isTangleClawHookEntry));
  });

  it('does not rewrite the tracked file when it holds nothing of ours', () => {
    // The #1242/#1275 property. A sync that changes nothing must leave the file
    // byte-identical, or the tracked file is permanently dirty and the wrap's
    // `git add -A` sweeps it into a commit the repo's own guard then rejects.
    fs.writeFileSync(sharedFile, JSON.stringify(INSTALL_REFERENCE, null, 2) + '\n');
    const before = fs.readFileSync(sharedFile, 'utf8');
    const mtimeBefore = fs.statSync(sharedFile).mtimeMs;

    const cfg = { ...store.DEFAULT_PROJECT_CONFIG, engine: 'claude', silentPrime: true };
    store.projectConfig.save(projectPath, cfg);
    engines.syncEngineHooks(projectPath, 'claude');

    assert.equal(fs.readFileSync(sharedFile, 'utf8'), before, 'content must be identical');
    assert.equal(fs.statSync(sharedFile).mtimeMs, mtimeBefore,
      'and the file must not have been written at all');
  });

  it('is idempotent on the local file across repeated syncs', () => {
    // syncEngineHooks runs on every launch, create, attach, PATCH and boot-sync.
    const cfg = { ...store.DEFAULT_PROJECT_CONFIG, engine: 'claude', silentPrime: true };
    store.projectConfig.save(projectPath, cfg);
    engines.syncEngineHooks(projectPath, 'claude');
    const first = fs.readFileSync(localFile, 'utf8');
    const mtimeAfterFirst = fs.statSync(localFile).mtimeMs;

    for (let i = 0; i < 3; i += 1) engines.syncEngineHooks(projectPath, 'claude');

    assert.equal(fs.readFileSync(localFile, 'utf8'), first, 'no growth, no reordering');
    assert.equal(fs.statSync(localFile).mtimeMs, mtimeAfterFirst,
      'a settled sync writes nothing at all');
  });

  it('does not create a tracked settings.json that was never there', () => {
    // Nothing to retire in a file that does not exist. Creating an empty `{}` in a
    // project TangleClaw had no reason to touch is the same unasked-for write this
    // whole change exists to stop making.
    const cfg = { ...store.DEFAULT_PROJECT_CONFIG, engine: 'claude', silentPrime: true };
    store.projectConfig.save(projectPath, cfg);
    engines.syncEngineHooks(projectPath, 'claude');
    assert.equal(fs.existsSync(sharedFile), false);
    assert.equal(fs.existsSync(localFile), true, 'but the local file IS created');
  });

  it('creates no file at all when the engine emits no baseline hooks', () => {
    // silentPrime off and no rules: there is nothing to write, so nothing is written.
    const cfg = { ...store.DEFAULT_PROJECT_CONFIG, engine: 'claude', silentPrime: false };
    store.projectConfig.save(projectPath, cfg);
    engines.syncEngineHooks(projectPath, 'claude');
    assert.equal(fs.existsSync(localFile), false);
    assert.equal(fs.existsSync(sharedFile), false);
  });
});

describe('syncEngineHooks clears both files for a non-claude engine', () => {
  let tmpDir;
  let projectPath;
  let sharedFile;
  let localFile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hookloc-nc-'));
    store._setBasePath(path.join(tmpDir, 'home'));
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'project-'));
    fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
    sharedFile = path.join(projectPath, '.claude', engines.SHARED_SETTINGS_BASENAME);
    localFile = path.join(projectPath, '.claude', engines.LOCAL_SETTINGS_BASENAME);
  });

  it('clears our stale entry from the LOCAL file, which is where it now lives', () => {
    // Symmetry with the shared-file rule (#140/#137): a project that ran as
    // claude+silentPrime and then flipped engines leaves a phantom entry behind.
    // After the relocation that phantom is in the local file, so a non-claude
    // branch that only cleaned the shared file would leave it forever.
    fs.writeFileSync(localFile, JSON.stringify({
      hooks: { SessionStart: [tcEntry()], PreToolUse: [operatorEntry()] }
    }, null, 2) + '\n');
    store.projectConfig.save(projectPath, { ...store.DEFAULT_PROJECT_CONFIG, engine: 'codex' });
    engines.syncEngineHooks(projectPath, 'codex');

    const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    assert.equal('SessionStart' in local.hooks, false, 'our stale entry must go');
    assert.deepEqual(local.hooks.PreToolUse, [operatorEntry()], 'theirs must not');
  });

  it('clears our stale entry from the TRACKED file too', () => {
    fs.writeFileSync(sharedFile, JSON.stringify({
      ...INSTALL_REFERENCE, hooks: { SessionStart: [tcEntry()] }
    }, null, 2) + '\n');
    store.projectConfig.save(projectPath, { ...store.DEFAULT_PROJECT_CONFIG, engine: 'codex' });
    engines.syncEngineHooks(projectPath, 'codex');

    const shared = JSON.parse(fs.readFileSync(sharedFile, 'utf8'));
    assert.equal('hooks' in shared, false);
    assert.deepEqual(shared.enabledPlugins, INSTALL_REFERENCE.enabledPlugins,
      'and the install reference still survives on the non-claude path');
  });

  it('creates neither file when there is nothing to clear', () => {
    store.projectConfig.save(projectPath, { ...store.DEFAULT_PROJECT_CONFIG, engine: 'codex' });
    engines.syncEngineHooks(projectPath, 'codex');
    assert.equal(fs.existsSync(sharedFile), false);
    assert.equal(fs.existsSync(localFile), false);
  });
});

describe('_reconcileHooksFile refuses a file it cannot merge into', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hookloc-bad-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write `raw` to a fresh settings file and reconcile a baseline into it. */
  function reconcileRaw(raw) {
    const file = path.join(fs.mkdtempSync(path.join(tmpDir, 'p-')), 'settings.json');
    fs.writeFileSync(file, raw);
    const result = engines._reconcileHooksFile(file, { SessionStart: [tcEntry()] });
    return { result, after: fs.readFileSync(file, 'utf8') };
  }

  it('leaves an UNPARSEABLE file byte-identical rather than starting fresh', () => {
    // Starting from `{}` here would delete whatever the operator had, including the
    // install reference governance detection reads — a silent loss to fix a parse
    // error we did not cause. Refusing is the honest degrade.
    const raw = '{ "enabledPlugins": { "prawduct@prawduct": true },,, }';
    const { result, after: onDisk } = reconcileRaw(raw);
    assert.equal(result.written, false);
    assert.equal(onDisk, raw);
  });

  it('leaves a NON-OBJECT JSON file byte-identical', () => {
    for (const raw of ['[1,2,3]', '"a string"', '42', 'null']) {
      const { result, after: onDisk } = reconcileRaw(raw);
      assert.equal(result.written, false, raw);
      assert.equal(onDisk, raw, raw);
    }
  });
});

describe('_retireHooksIn', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hookloc-ret-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('never creates a file that does not exist', () => {
    const file = path.join(tmpDir, 'absent', 'settings.json');
    const result = engines._retireHooksIn(file);
    assert.equal(result.written, false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.dirname(file)), false,
      'and it must not create the directory either');
  });

  it('removes ours, keeps theirs, and reports the count', () => {
    const file = path.join(fs.mkdtempSync(path.join(tmpDir, 'p-')), 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      hooks: { SessionStart: [tcEntry(), operatorEntry('echo hi')] }
    }, null, 2) + '\n');

    const result = engines._retireHooksIn(file);
    assert.equal(result.written, true);
    assert.equal(result.replacedOwn, 1);
    assert.equal(result.preservedForeign, 1);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after.hooks.SessionStart, [operatorEntry('echo hi')]);
  });
});
