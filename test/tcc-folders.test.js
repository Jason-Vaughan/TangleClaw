'use strict';

/*
 * The shipped projects directory and the macOS protected folders (#880).
 *
 * Two contracts. The default must sit OUTSIDE every protected folder, because
 * the wizard cautions on path shape alone and a caution every fresh Mac sees is
 * one people learn to ignore. And every copy that cannot import its source must
 * still say the same thing: the default's copies (the browser's fallbacks) must
 * name `lib/store.js`'s value, and the folder list's copies (the wizard's
 * caution, the EACCES hint, the installer) must name every folder in
 * `lib/tcc-folders.js`. Otherwise a fresh install pre-fills one folder and warns
 * about another.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tccFolders = require('../lib/tcc-folders');
const store = require('../lib/store');
const { DEFAULT_CONFIG } = store;
const migration = require('../lib/tcc-workspace-migration');
const { liftDeclaration } = require('./helpers/lift');

const ROOT = path.join(__dirname, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'setup.js'), 'utf8');

/**
 * The wizard's own caution check, fed the roots the server would send.
 * @param {string} home - The home directory the server would report
 * @returns {function(string): (string|null)} The protected root a path is under, or null
 */
function wizardCheck(home) {
  const ctx = { state: { config: { protectedRoots: tccFolders.protectedRootsFor(home) } } };
  vm.createContext(ctx);
  vm.runInContext(liftDeclaration(SETUP_SRC, 'function wizardProtectedRootFor'), ctx);
  return (p) => ctx.wizardProtectedRootFor(p);
}

describe('macOS protected folders, one owner (#880)', () => {
  it('names the three folders TCC protects, and the prose says the same three', () => {
    assert.deepEqual([...tccFolders.TCC_PROTECTED_FOLDERS], ['Documents', 'Desktop', 'Downloads']);
    assert.equal(tccFolders.TCC_PROTECTED_FOLDERS_PROSE, '~/Documents, ~/Desktop and ~/Downloads');
    assert.ok(Object.isFrozen(tccFolders.TCC_PROTECTED_FOLDERS), 'a shared list nobody can edit in place');
  });

  it('builds the roots the server ships, in both the ~ and the absolute form', () => {
    assert.deepEqual(tccFolders.protectedRootsFor('/Users/tester'), [
      '~/Documents', '/Users/tester/Documents',
      '~/Desktop', '/Users/tester/Desktop',
      '~/Downloads', '/Users/tester/Downloads'
    ]);
    assert.deepEqual(tccFolders.protectedRootsFor(''), ['~/Documents', '~/Desktop', '~/Downloads'],
      'with no home, only the form an operator types');
  });

  it('every copy that cannot import the list still names every folder in it', () => {
    const caution = liftDeclaration(SETUP_SRC, 'function wizardUpdateDirAdvice');
    const apiHelper = fs.readFileSync(path.join(ROOT, 'public', 'api-helper.js'), 'utf8');
    const eacces = apiHelper.slice(apiHelper.indexOf('EACCES:'), apiHelper.indexOf('SCAN_FAILED:'));
    const install = fs.readFileSync(path.join(ROOT, 'deploy', 'install.sh'), 'utf8');
    const tccFn = liftDeclaration(install, 'tcc_protected_path()');
    for (const name of tccFolders.TCC_PROTECTED_FOLDERS) {
      assert.ok(caution.includes(`~/${name}`), `the wizard caution names ~/${name}`);
      assert.ok(eacces.includes(`~/${name}`), `the EACCES hint names ~/${name}`);
      // Lower-cased there, because the function folds case before matching.
      assert.ok(tccFn.includes(`"$_tcc_home/${name.toLowerCase()}/"*`), `install.sh's tcc_protected_path covers ${name}`);
    }
  });
});

describe('the shipped projects directory (#880)', () => {
  it('is ~/Projects, and the wizard\'s own check draws no caution for it', () => {
    assert.equal(DEFAULT_CONFIG.projectsDir, '~/Projects');
    const check = wizardCheck('/Users/tester');
    assert.equal(check(DEFAULT_CONFIG.projectsDir), null,
      'a fresh Mac must reach the projects step with no caution showing');
    assert.equal(check('/Users/tester/Projects'), null, 'nor for its absolute form');
    // The same check still fires for a protected folder an operator types, so
    // the test above is not passing because the check is inert.
    assert.equal(check('~/Documents/Projects'), '~/Documents');
    assert.equal(check('/Users/tester/Desktop/code'), '/Users/tester/Desktop');
  });

  it('is the value every copy that cannot import the store falls back to', () => {
    const quoted = `'${DEFAULT_CONFIG.projectsDir}'`;
    assert.ok(SETUP_SRC.includes(`state.config.projectsDir || ${quoted} : ${quoted}`),
      'the wizard\'s fallback when no config arrived');
    assert.ok(SETUP_SRC.includes(`placeholder="${DEFAULT_CONFIG.projectsDir}"`), 'the wizard\'s placeholder');
    const ui = fs.readFileSync(path.join(ROOT, 'public', 'ui.js'), 'utf8');
    assert.ok(ui.includes(`c.projectsDir || ${quoted}`), 'the settings modal\'s fallback');
    assert.ok(!/Documents\/Projects/.test(liftDeclaration(SETUP_SRC, 'function showWizard')),
      'no stale default left in the wizard\'s opening');
  });
});

describe('lib/tcc-workspace-migration — guided workspace root migration (#2626)', () => {
  let tmpHome;
  let tmpDataDir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-migrate-home-'));
    fs.mkdirSync(path.join(tmpHome, 'Documents', 'Projects'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, 'Projects'), { recursive: true });
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-migrate-data-'));
    store._setBasePath(tmpDataDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  /**
   * A real project row, with a real directory under the temp "Documents/Projects".
   * @param {string} name - Project name.
   * @returns {object} The store's own project row.
   */
  function makeProject(name) {
    const dir = path.join(tmpHome, 'Documents', 'Projects', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'marker.txt'), name);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  }

  describe('planWorkspaceMigration — dry run, never touches disk/db/config', () => {
    it('plans every project under sourceRoot: computes toPath and names the config update', () => {
      const p1 = makeProject('alpha');
      const plan = migration.planWorkspaceMigration({
        home: tmpHome,
        projects: [p1],
        activeSessions: [],
        config: { projectsDir: path.join(tmpHome, 'Documents', 'Projects') }
      });
      assert.equal(plan.ok, true);
      assert.equal(plan.dryRun, true);
      assert.equal(plan.sourceRoot, path.join(tmpHome, 'Documents', 'Projects'));
      assert.equal(plan.targetRoot, path.join(tmpHome, 'Projects'));
      assert.equal(plan.moves.length, 1);
      assert.equal(plan.moves[0].id, p1.id);
      assert.equal(plan.moves[0].fromPath, p1.path);
      assert.equal(plan.moves[0].toPath, path.join(tmpHome, 'Projects', 'alpha'));
      assert.deepEqual(plan.configUpdate, {
        fromProjectsDir: path.join(tmpHome, 'Documents', 'Projects'),
        toProjectsDir: path.join(tmpHome, 'Projects')
      });
      assert.equal(plan.blockers.length, 0);
      // Nothing moved — still at its original path.
      assert.ok(fs.existsSync(p1.path));
    });

    it('omits the config update when config.projectsDir does not match sourceRoot', () => {
      const p1 = makeProject('beta');
      const plan = migration.planWorkspaceMigration({
        home: tmpHome, projects: [p1], activeSessions: [], config: { projectsDir: '/somewhere/else' }
      });
      assert.equal(plan.configUpdate, null);
    });

    it('populates the config update for the REAL legacy store.config.load() shape — the tilde form '
      + '"~/Documents/Projects", including when a keyless/blank config falls back to it (#2626 I-Gate R1 C1-a)', () => {
      const p1 = makeProject('legacy');
      // store.config.load() returns exactly this string both when
      // projectsDir is explicitly '~/Documents/Projects' AND when the file
      // is keyless/blank (lib/store.js's LEGACY_PROJECTS_DIR fallback) --
      // one plan call covers both, since the planner only ever sees this
      // already-resolved config object.
      const plan = migration.planWorkspaceMigration({
        home: tmpHome, projects: [p1], activeSessions: [], config: { projectsDir: '~/Documents/Projects' }
      });
      assert.ok(plan.configUpdate, 'a real legacy tilde-form projectsDir must still populate the config update');
      assert.deepEqual(plan.configUpdate, {
        fromProjectsDir: path.join(tmpHome, 'Documents', 'Projects'),
        toProjectsDir: path.join(tmpHome, 'Projects')
      });
    });

    it('ignores a project outside sourceRoot entirely — not this migration\'s concern', () => {
      const outside = store.projects.create({
        name: 'elsewhere', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-migrate-outside-')), engine: 'claude'
      });
      const plan = migration.planWorkspaceMigration({ home: tmpHome, projects: [outside], activeSessions: [] });
      assert.equal(plan.moves.length, 0);
      assert.equal(plan.blockers.length, 0);
      assert.equal(plan.skipped.length, 0);
      fs.rmSync(outside.path, { recursive: true, force: true });
    });

    it('refuses with ok:false when sourceRoot is not actually TCC-protected', () => {
      const plan = migration.planWorkspaceMigration({
        home: tmpHome, sourceRoot: path.join(tmpHome, 'Projects'), projects: [], activeSessions: []
      });
      assert.equal(plan.ok, false);
      assert.match(plan.error, /not a TCC-protected folder/);
    });

    it('refuses with ok:false when targetRoot is ITSELF TCC-protected', () => {
      const plan = migration.planWorkspaceMigration({
        home: tmpHome, targetRoot: path.join(tmpHome, 'Desktop', 'Projects'), projects: [], activeSessions: []
      });
      assert.equal(plan.ok, false);
      assert.match(plan.error, /itself TCC-protected/);
    });

    it('blocks a project with an active session, rather than silently skipping it', () => {
      const p1 = makeProject('busy');
      const plan = migration.planWorkspaceMigration({
        home: tmpHome, projects: [p1], activeSessions: [{ projectId: p1.id }]
      });
      assert.equal(plan.ok, true, 'the plan itself is still well-formed — the blocker is the per-project signal');
      assert.equal(plan.moves.length, 0);
      assert.equal(plan.blockers.length, 1);
      assert.equal(plan.blockers[0].id, p1.id);
      assert.match(plan.blockers[0].reason, /active session/);
    });

    it('blocks a project whose target path already exists, rather than silently overwriting', () => {
      const p1 = makeProject('clash');
      fs.mkdirSync(path.join(tmpHome, 'Projects', 'clash'), { recursive: true });
      const plan = migration.planWorkspaceMigration({ home: tmpHome, projects: [p1], activeSessions: [] });
      assert.equal(plan.moves.length, 0);
      assert.equal(plan.blockers.length, 1);
      assert.match(plan.blockers[0].reason, /already exists/);
    });

    it('a source project that no longer exists on disk is skipped, not blocked or silently moved', () => {
      const p1 = makeProject('ghost');
      fs.rmSync(p1.path, { recursive: true, force: true });
      const plan = migration.planWorkspaceMigration({ home: tmpHome, projects: [p1], activeSessions: [] });
      assert.equal(plan.moves.length, 0);
      assert.equal(plan.blockers.length, 0);
      assert.equal(plan.skipped.length, 1);
      assert.match(plan.skipped[0].reason, /does not exist/);
    });
  });

  describe('executeWorkspaceMigration — the only half that moves anything', () => {
    it('refuses a plan that is not ok, before touching anything', () => {
      const result = migration.executeWorkspaceMigration(
        { ok: false, error: 'nope', blockers: [] }, { store, configPath: '/nonexistent' }
      );
      assert.equal(result.ok, false);
      assert.equal(result.rolledBack, false);
    });

    it('refuses a plan still carrying blockers, even if ok happens to be true', () => {
      const result = migration.executeWorkspaceMigration(
        { ok: true, blockers: [{ id: 1, name: 'x', reason: 'y' }], moves: [] }, { store, configPath: '/nonexistent' }
      );
      assert.equal(result.ok, false);
      assert.equal(result.rolledBack, false);
    });

    it('refuses with no plan at all', () => {
      const result = migration.executeWorkspaceMigration(null, { store, configPath: '/nonexistent' });
      assert.equal(result.ok, false);
      assert.match(result.error, /No plan/);
    });

    it('moves the directory, updates the store row, updates config.json, and repairs a linked git worktree', () => {
      const p1 = makeProject('gamma');
      // A linked worktree's OWN directory has a FILE .git, not a folder --
      // exactly what `git worktree repair` exists to fix up after a move.
      fs.writeFileSync(path.join(p1.path, '.git'), 'gitdir: /somewhere/else/.git/worktrees/gamma\n');

      const configPath = path.join(tmpDataDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ projectsDir: path.join(tmpHome, 'Documents', 'Projects') }));

      const plan = migration.planWorkspaceMigration({
        home: tmpHome, projects: [p1], activeSessions: [],
        config: { projectsDir: path.join(tmpHome, 'Documents', 'Projects') }
      });
      assert.equal(plan.ok, true);

      const execCalls = [];
      const result = migration.executeWorkspaceMigration(plan, {
        store, configPath,
        execFileSyncImpl: (cmd, args, opts) => { execCalls.push({ cmd, args, opts }); return ''; }
      });

      assert.equal(result.ok, true);
      assert.equal(result.migrated.length, 1);
      assert.equal(result.configUpdated, true);
      assert.deepEqual(result.worktreesRepaired, [p1.id]);

      const newPath = path.join(tmpHome, 'Projects', 'gamma');
      assert.ok(fs.existsSync(newPath), 'the directory is really at the new path');
      assert.ok(!fs.existsSync(p1.path), 'and gone from the old one');
      assert.equal(store.projects.get(p1.id).path, newPath, 'the store row follows the move');
      assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).projectsDir, path.join(tmpHome, 'Projects'));
      assert.equal(execCalls.length, 1);
      assert.equal(execCalls[0].cmd, 'git');
      assert.deepEqual(execCalls[0].args, ['-C', newPath, 'worktree', 'repair']);
    });

    it('a project with no git worktree link is moved without any git call at all', () => {
      const p1 = makeProject('plain');
      const plan = migration.planWorkspaceMigration({ home: tmpHome, projects: [p1], activeSessions: [] });
      const execCalls = [];
      const result = migration.executeWorkspaceMigration(plan, {
        store, configPath: path.join(tmpDataDir, 'config.json'),
        execFileSyncImpl: (cmd, args) => { execCalls.push({ cmd, args }); return ''; }
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.worktreesRepaired, []);
      assert.equal(execCalls.length, 0);
    });

    it('refuses rather than silently replacing a target that appears AFTER planning (I-Gate Round 3 C1, #5799121198)', () => {
      const p1 = makeProject('late-collision');
      const plan = migration.planWorkspaceMigration({ home: tmpHome, projects: [p1], activeSessions: [] });
      assert.equal(plan.ok, true);
      const toPath = plan.moves[0].toPath;
      assert.equal(fs.existsSync(toPath), false, 'the plan itself saw no collision');

      // A target appears between planning and execution -- an empty
      // directory, the exact shape that `fs.renameSync` would otherwise
      // silently replace on this platform.
      fs.mkdirSync(toPath, { recursive: true, mode: 0o700 });

      const result = migration.executeWorkspaceMigration(plan, {
        store, configPath: path.join(tmpDataDir, 'config.json')
      });

      assert.equal(result.ok, false);
      assert.equal(result.rolledBack, true);
      assert.match(result.error, /already exists/);
      assert.ok(fs.existsSync(p1.path), 'the source directory was never moved');
      assert.equal(store.projects.get(p1.id).path, p1.path, 'the store row was never changed');
      assert.equal(fs.statSync(toPath).mode & 0o777, 0o700, 'the collision directory survives untouched, not replaced');
    });

    it('rolls back every already-moved directory and store row when a later step fails mid-flight', () => {
      const p1 = makeProject('first');
      const p2 = makeProject('second');
      const plan = migration.planWorkspaceMigration({ home: tmpHome, projects: [p1, p2], activeSessions: [] });
      assert.equal(plan.moves.length, 2);

      // The REAL store.projects.update, wrapped to fail on its second call —
      // p1's own move (filesystem + store) has already fully succeeded by
      // then; p2's directory has already moved when its OWN store update
      // throws (half-migrated, exactly the case `inProgress` exists for).
      const realUpdate = store.projects.update.bind(store.projects);
      let calls = 0;
      const failingStore = {
        projects: {
          update(id, data) {
            calls += 1;
            if (calls === 2) throw new Error('simulated store failure');
            return realUpdate(id, data);
          }
        }
      };

      const result = migration.executeWorkspaceMigration(plan, {
        store: failingStore, configPath: path.join(tmpDataDir, 'config.json')
      });
      assert.equal(result.ok, false);
      assert.equal(result.rolledBack, true);
      assert.match(result.error, /simulated store failure/);

      assert.ok(fs.existsSync(p1.path), 'the first (fully-migrated) project is back at its original path');
      assert.ok(!fs.existsSync(path.join(tmpHome, 'Projects', 'first')), 'and gone from the target it was moved to');
      assert.equal(store.projects.get(p1.id).path, p1.path, 'its store row reverted too');

      assert.ok(fs.existsSync(p2.path), 'the second (half-migrated when the failure hit) project is back too');
      assert.ok(!fs.existsSync(path.join(tmpHome, 'Projects', 'second')));
      assert.equal(store.projects.get(p2.id).path, p2.path, 'its store row was never actually left pointing at the new path');
    });

    it('rolls back on a config.json failure too — a later step failing undoes the moves that already succeeded', () => {
      const p1 = makeProject('delta');
      const plan = migration.planWorkspaceMigration({
        home: tmpHome, projects: [p1], activeSessions: [],
        config: { projectsDir: path.join(tmpHome, 'Documents', 'Projects') }
      });
      assert.ok(plan.configUpdate);

      // configPath points nowhere real, so the config.json read inside
      // executeWorkspaceMigration throws — AFTER the one move already
      // succeeded on disk and in the store.
      const result = migration.executeWorkspaceMigration(plan, {
        store, configPath: path.join(tmpDataDir, 'does-not-exist', 'config.json')
      });
      assert.equal(result.ok, false);
      assert.equal(result.rolledBack, true);
      assert.ok(fs.existsSync(p1.path), 'the move itself was rolled back along with the config failure');
      assert.equal(store.projects.get(p1.id).path, p1.path);
    });

    it('restores config.json too when a LATER step (git worktree repair) fails — the config write already '
      + 'happened before repair runs (#2626 I-Gate R1 C1-b)', () => {
      const p1 = makeProject('epsilon');
      // A linked worktree, so _hasWorktreeLink is true and repair actually runs.
      fs.writeFileSync(path.join(p1.path, '.git'), 'gitdir: /somewhere/else/.git/worktrees/epsilon\n');

      const configPath = path.join(tmpDataDir, 'config.json');
      const originalConfigRaw = JSON.stringify({ projectsDir: path.join(tmpHome, 'Documents', 'Projects') }, null, 2);
      fs.writeFileSync(configPath, originalConfigRaw);

      const plan = migration.planWorkspaceMigration({
        home: tmpHome, projects: [p1], activeSessions: [],
        config: { projectsDir: path.join(tmpHome, 'Documents', 'Projects') }
      });
      assert.ok(plan.configUpdate);

      const result = migration.executeWorkspaceMigration(plan, {
        store, configPath,
        execFileSyncImpl: () => { throw new Error('simulated git worktree repair failure'); }
      });

      assert.equal(result.ok, false);
      assert.equal(result.rolledBack, true);
      assert.match(result.error, /simulated git worktree repair failure/);

      // All three together, or the "whole attempt" rollback promise is false.
      assert.ok(fs.existsSync(p1.path), 'the directory is back at its original path');
      assert.ok(!fs.existsSync(path.join(tmpHome, 'Projects', 'epsilon')), 'and gone from the target');
      assert.equal(store.projects.get(p1.id).path, p1.path, 'the store row reverted too');
      assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfigRaw,
        'config.json must be back to its EXACT original bytes, not left pointing at the new root');
    });

    it('compensates an EARLIER worktree whose repair already succeeded when a LATER one throws — rollback must '
      + 'repair it back, not just move its directory back (#2626 I-Gate R2 C1)', () => {
      const p1 = makeProject('zeta');
      const p2 = makeProject('eta');
      // Both are linked worktrees, so both get a repair call during execute —
      // the first one succeeds before the second one throws.
      fs.writeFileSync(path.join(p1.path, '.git'), 'gitdir: /somewhere/else/.git/worktrees/zeta\n');
      fs.writeFileSync(path.join(p2.path, '.git'), 'gitdir: /somewhere/else/.git/worktrees/eta\n');

      const plan = migration.planWorkspaceMigration({ home: tmpHome, projects: [p1, p2], activeSessions: [] });
      assert.equal(plan.ok, true);
      assert.equal(plan.moves.length, 2);

      let callCount = 0;
      const execCalls = [];
      const result = migration.executeWorkspaceMigration(plan, {
        store, configPath: path.join(tmpDataDir, 'config.json'),
        execFileSyncImpl: (cmd, args) => {
          execCalls.push({ cmd, args });
          callCount += 1;
          if (callCount === 2) throw new Error('simulated second worktree repair failure');
          return '';
        }
      });

      assert.equal(result.ok, false);
      assert.equal(result.rolledBack, true);
      assert.match(result.error, /simulated second worktree repair failure/);

      // Both directories back at their original paths, same as any rollback.
      assert.ok(fs.existsSync(p1.path), 'zeta is back at its original path');
      assert.ok(fs.existsSync(p2.path), 'eta is back at its original path');
      assert.ok(!fs.existsSync(path.join(tmpHome, 'Projects', 'zeta')));
      assert.ok(!fs.existsSync(path.join(tmpHome, 'Projects', 'eta')));
      assert.equal(store.projects.get(p1.id).path, p1.path);
      assert.equal(store.projects.get(p2.id).path, p2.path);

      // zeta's repair succeeded (call 1) before eta's threw (call 2) — the
      // rollback must issue a THIRD, compensating repair for zeta, at its
      // restored fromPath, so the main repository's own worktree record
      // points back there instead of the now-absent toPath. eta's own
      // repair never succeeded, so it needs no compensation.
      assert.equal(execCalls.length, 3, 'two attempted repairs plus one compensating repair for zeta');
      assert.deepEqual(execCalls[0].args, ['-C', path.join(tmpHome, 'Projects', 'zeta'), 'worktree', 'repair']);
      assert.deepEqual(execCalls[1].args, ['-C', path.join(tmpHome, 'Projects', 'eta'), 'worktree', 'repair']);
      assert.deepEqual(execCalls[2].args, ['-C', p1.path, 'worktree', 'repair'],
        'the compensating repair runs at zeta\'s restored fromPath, not its reverted-away toPath');
    });
  });
});
