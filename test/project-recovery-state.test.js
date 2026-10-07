'use strict';

/**
 * Per-project recovery state (#1937): the operator's recovery-mode decision in
 * the server store, the resolver that reads it beside `project.json`, and the
 * once-only inherited-mode notice marker.
 *
 * The properties that matter are the ones a single happy write never shows.
 * The store outranks the file, in both directions. A row is not a pin. A
 * decision and a notice share a row and neither write may erase the other.
 * Two stores cannot be written atomically, so every half-failure has one fixed
 * answer, and each is read back through the resolver rather than through the
 * write's own report.
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const projectConfig = require('../lib/project-config');
const recoveryDefault = require('../lib/recovery-default');
const authGate = require('../lib/auth-gate');
const projects = require('../lib/projects');
const launchSequence = require('../lib/launch-sequence');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');

const tmpDirs = [];

/**
 * A fresh temporary directory, removed when the file's tests finish.
 * @param {string} tag - Directory name prefix
 * @returns {string}
 */
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-recovery-state-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

/**
 * The stored DDL of the recovery state table, whitespace normalised.
 * @returns {string}
 */
function tableDdl() {
  const row = store.getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_recovery_state'").get();
  return ((row && row.sql) || '').replace(/\s+/g, ' ').trim();
}

/**
 * Run a block on an install whose login is in force, which is where advisory
 * is the default recovery mode. Installs the gate probe `server.js` installs
 * once its listener is bound, answering `armed`, and removes it afterwards.
 * @param {function(): *} fn - The block
 * @returns {*} Whatever the block returns
 */
function withAdvisoryDefault(fn) {
  recoveryDefault.setGateStateProbe(() => authGate.GATE_STATES.ARMED);
  try {
    return fn();
  } finally {
    recoveryDefault.setGateStateProbe(null);
  }
}

after(() => {
  store.close();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('v54→55: the project recovery state table (#1937)', () => {
  /**
   * Seed a database stamped at v54 that has projects and no recovery table.
   * @returns {string} The store's base directory
   */
  function seedV54() {
    const fresh = tmp('fresh');
    store._setBasePath(fresh);
    store.init();
    store.projects.create({ name: 'carried', path: path.join(fresh, 'carried'), engine: 'claude' });
    store.close();
    const db = new DatabaseSync(path.join(fresh, 'tangleclaw.db'));
    db.exec('DROP TABLE project_recovery_state');
    db.exec('DELETE FROM schema_version');
    db.exec('INSERT INTO schema_version (version) VALUES (54)');
    db.close();
    return fresh;
  }

  it('is at or below the current schema version', () => {
    // v55 is this table's version; later migrations move the constant on.
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 55);
  });

  it('gives an upgraded store the same table as a fresh one, CHECKs and cascade included', () => {
    const freshDir = tmp('shape');
    store._setBasePath(freshDir);
    store.init();
    const fresh = tableDdl();
    assert.match(fresh, /REFERENCES projects\(id\) ON DELETE CASCADE/);
    assert.match(fresh, /CHECK \(pinned_mode IS NULL OR pinned_at IS NOT NULL\)/);
    store.close();

    const dir = seedV54();
    const probe = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    assert.equal(probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'project_recovery_state'").get().n, 0,
      'precondition: the v54 store has no such table');
    probe.close();
    store._setBasePath(dir);
    store.init();
    assert.equal(tableDdl(), fresh);
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.ok(store.projects.getByName('carried'), 'the upgrade keeps the projects it found');
    assert.equal(store.projectRecoveryState.get(store.projects.getByName('carried').id), null,
      'and records no decision for any of them');
  });

  it('refuses a pin nobody is recorded as having made, and any pinned mode but operator', () => {
    const dir = tmp('checks');
    store._setBasePath(dir);
    store.init();
    const project = store.projects.create({ name: 'checked', path: path.join(dir, 'checked'), engine: 'claude' });
    const db = store.getDb();
    assert.throws(() => db.prepare("INSERT INTO project_recovery_state (project_id, pinned_mode) VALUES (?, 'operator')").run(project.id), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO project_recovery_state (project_id, pinned_mode, pinned_at, pinned_by) VALUES (?, 'advisory', 'now', 'operator')").run(project.id), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO project_recovery_state (project_id, pinned_at) VALUES (?, 'now')").run(project.id), /CHECK/,
      'a decision names who made it');
    assert.throws(() => db.prepare("INSERT INTO project_recovery_state (project_id, inherited_notice_at) VALUES (?, 'now')").run(project.id), /CHECK/,
      'a notice names the launch that carried it');
  });
});

describe('the recovery-mode resolver (#1937)', () => {
  const pinned = { pinnedMode: 'operator', pinnedAt: '2026-10-06 00:00:00', pinnedBy: 'operator' };
  const chosen = { pinnedMode: null, pinnedAt: '2026-10-06 00:00:00', pinnedBy: 'operator' };
  const noticeOnly = { pinnedMode: null, pinnedAt: null, pinnedBy: null, inheritedNoticeAt: '2026-10-06 00:00:00', inheritedNoticeLaunchId: 'l1' };
  const file = (recoveryMode) => ({ launchSequence: recoveryMode === undefined ? {} : { recoveryMode } });
  const resolve = projectConfig.resolveRecoveryMode;

  it('a pin decides whatever the file says, and reports every file that is not operator', () => {
    assert.deepEqual(resolve(file('operator'), pinned), { mode: 'operator', source: 'pinned' });
    for (const value of ['advisory', undefined, 'garbage', null]) {
      const got = resolve(file(value), pinned);
      assert.equal(got.mode, 'operator', JSON.stringify(value));
      assert.equal(got.source, 'pinned', JSON.stringify(value));
      assert.match(got.discrepancy, /the pin decides/, JSON.stringify(value));
    }
    assert.equal(resolve(null, pinned).mode, 'operator', 'no config at all does not loosen a pin');
  });

  it('a chosen advisory decides over a file that still says operator, and reports it', () => {
    assert.deepEqual(resolve(file('advisory'), chosen), { mode: 'advisory', source: 'chosen' });
    assert.deepEqual(resolve(file(undefined), chosen), { mode: 'advisory', source: 'chosen' });
    const stale = resolve(file('operator'), chosen);
    assert.equal(stale.mode, 'advisory');
    assert.equal(stale.source, 'chosen');
    assert.match(stale.discrepancy, /chose advisory/);
  });

  it('an unrecognised value is operator, and is a discrepancy only against a decision on record', () => {
    for (const pin of [null, noticeOnly]) {
      const got = resolve(file('Advisory'), pin);
      assert.equal(got.mode, 'operator');
      assert.equal(got.source, 'invalid');
      assert.match(got.warning, /not one of operator, advisory/);
      assert.equal(got.discrepancy, undefined, 'nobody decided anything, so there is nothing for the file to disagree with');
    }
    const against = resolve(file('Advisory'), chosen);
    assert.equal(against.mode, 'operator');
    assert.equal(against.source, 'invalid', 'held by a bad value, never described as pinned');
    assert.match(against.warning, /not one of operator, advisory/);
    assert.match(against.discrepancy, /the operator chose advisory recovery, and project\.json holds an unrecognised/);
    assert.doesNotMatch(against.discrepancy, /pinned/);
  });

  it('with no decision on record and advisory not the default, every recognised file value is operator', () => {
    // A notice-only row reads exactly like no row. The file cannot choose
    // advisory here: it sits where the project's own session can write it.
    for (const pin of [null, undefined, noticeOnly]) {
      for (const options of [undefined, {}, { advisoryDefault: false }]) {
        assert.deepEqual(resolve(file(undefined), pin, options), { mode: 'operator', source: 'not-armed' });
        assert.deepEqual(resolve(file('operator'), pin, options), { mode: 'operator', source: 'not-armed' });
        const asked = resolve(file('advisory'), pin, options);
        assert.equal(asked.mode, 'operator', 'a file saying advisory does not get it');
        assert.equal(asked.source, 'not-armed');
        assert.match(asked.warning, /no operator decision on record/);
        assert.match(asked.warning, /PATCH \/api\/projects\/:name/, 'and the warning names what does choose it');
        assert.equal(asked.discrepancy, undefined, 'nobody decided anything, so there is nothing to disagree with');
      }
    }
  });

  it('only the boolean true makes advisory the default', () => {
    for (const advisoryDefault of [false, null, undefined, 'true', 1, {}, 'armed']) {
      for (const value of [undefined, 'operator', 'advisory']) {
        assert.equal(resolve(file(value), null, { advisoryDefault }).mode, 'operator',
          `${JSON.stringify(advisoryDefault)} with file ${JSON.stringify(value)}`);
      }
    }
    assert.equal(resolve(file(undefined), null, { advisoryDefault: true }).mode, 'advisory');
  });

  it('a decision on record and an unrecognised value answer the same whether or not advisory is the default', () => {
    for (const value of ['operator', 'advisory', undefined, 'garbage']) {
      for (const pin of [pinned, chosen]) {
        assert.deepEqual(resolve(file(value), pin, { advisoryDefault: true }), resolve(file(value), pin),
          `${JSON.stringify(value)} under ${pin.pinnedMode || 'chosen'}`);
      }
    }
    assert.deepEqual(resolve(file('Advisory'), null, { advisoryDefault: true }), resolve(file('Advisory'), null));
    assert.equal(resolve(file('Advisory'), null, { advisoryDefault: true }).mode, 'operator',
      'an advisory default does not rescue a value nobody recognises');
  });

  it('a hand-written operator is not a pin: under an advisory default it reads as inherited, with no discrepancy', () => {
    const armed = { advisoryDefault: true };
    for (const pin of [null, noticeOnly]) {
      assert.deepEqual(resolve(file('operator'), pin, armed), { mode: 'advisory', source: 'inherited' });
      assert.deepEqual(resolve(file(undefined), pin, armed), { mode: 'advisory', source: 'default' });
      assert.deepEqual(resolve(file('advisory'), pin, armed), { mode: 'advisory', source: 'launchSequence' });
    }
    assert.equal(resolve(file('operator'), pinned, armed).source, 'pinned', 'a real pin still holds');
    assert.equal(resolve(file('operator'), chosen, armed).source, 'chosen', 'a recorded choice is never the migration');
    assert.equal(resolve(file('operator'), null).source, 'not-armed', 'and the row is unreachable while advisory is not the default');
  });
});

describe('recovery state in the store and on the launch path (#1937)', () => {
  let dir;
  let projectsDir;
  let sessions;
  let counter = 0;

  before(() => {
    dir = tmp('launch');
    store._setBasePath(dir);
    store.init();
    projectsDir = path.join(dir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
  });

  beforeEach(() => { counter += 1; });

  /**
   * Create a project, optionally with a recovery mode written into its file.
   * @param {string|undefined} [fileMode] - The value for `project.json`, or undefined to write none
   * @returns {object} The project record
   */
  function makeProject(fileMode) {
    const name = `state-${counter}-${Math.random().toString(36).slice(2, 8)}`;
    const projectDir = path.join(projectsDir, name);
    fs.mkdirSync(projectDir, { recursive: true });
    const project = store.projects.create({ name, path: projectDir, engine: 'claude' });
    if (fileMode !== undefined) writeFileMode(project, fileMode);
    return project;
  }

  /**
   * Write a recovery mode into a project's file directly, as a hand edit would.
   * @param {object} project - The project
   * @param {string} mode - The value to write
   * @returns {void}
   */
  function writeFileMode(project, mode) {
    fs.mkdirSync(path.join(project.path, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(project.path, '.tangleclaw', 'project.json'),
      JSON.stringify({ launchSequence: { recoveryMode: mode } }) + '\n');
  }

  /**
   * The recovery mode in a project's file, read raw.
   * @param {object} project - The project
   * @returns {string|undefined}
   */
  function fileMode(project) {
    const file = path.join(project.path, '.tangleclaw', 'project.json');
    if (!fs.existsSync(file)) return undefined;
    const block = JSON.parse(fs.readFileSync(file, 'utf8')).launchSequence;
    return block ? block.recoveryMode : undefined;
  }

  /**
   * The project's effective mode, through the resolver and the live store.
   * @param {object} project - The project
   * @returns {object} The resolver's answer
   */
  function effective(project) {
    return projectConfig.resolveRecoveryMode(store.projectConfig.load(project.path), store.projectRecoveryState.get(project.id),
      { advisoryDefault: recoveryDefault.gateAnswer().advisoryDefault });
  }

  /**
   * Launch with tmux and engine detection stubbed, then end the session so the
   * project can launch again.
   * @param {object} project - The project
   * @returns {object} The launch's sequence row
   */
  function launch(project) {
    const real = { create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    try {
      const result = sessions.launchSession(project.name, {});
      assert.ok(result.session, `the launch produced a session: ${JSON.stringify(result.error || null)}`);
      const sequence = store.launchSequences.getBySession(result.session.id);
      store.sessions.wrap(result.session.id, 'done');
      return sequence;
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  describe('the decision record', () => {
    it('operator pins; advisory unpins and still records the decision, creating the row when there is none', () => {
      const project = makeProject();
      assert.equal(store.projectRecoveryState.get(project.id), null);
      const chose = store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
      assert.equal(chose.pinnedMode, null);
      assert.ok(chose.pinnedAt, 'choosing advisory is a decision on record');
      assert.equal(chose.pinnedBy, 'operator');
      const pin = store.projectRecoveryState.recordDecision(project.id, 'operator', 'master');
      assert.equal(pin.pinnedMode, 'operator');
      assert.equal(pin.pinnedBy, 'master');
      const unpin = store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
      assert.equal(unpin.pinnedMode, null);
      assert.ok(unpin.pinnedAt, 'unpinning never deletes the row or the decision');
    });

    it('refuses a mode that is neither, and a decision nobody made', () => {
      const project = makeProject();
      assert.throws(() => store.projectRecoveryState.recordDecision(project.id, 'Operator', 'operator'), /operator or advisory/);
      assert.throws(() => store.projectRecoveryState.recordDecision(project.id, 'operator', ''), /who made it/);
      assert.throws(() => store.projectRecoveryState.recordDecision(project.id, 'operator'), /who made it/);
      assert.equal(store.projectRecoveryState.get(project.id), null);
    });

    it('goes when the project is deleted, and by nothing else', () => {
      const project = makeProject();
      store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
      store.projectRecoveryState.claimInheritedNotice(project.id, 'launch-x');
      store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
      assert.ok(store.projectRecoveryState.get(project.id), 'unpinning leaves the row');
      store.projects.delete(project.id);
      assert.equal(store.projectRecoveryState.get(project.id), null);
    });
  });

  describe('the once-only notice marker', () => {
    it('creates the row on a project with none, and claims exactly once', () => {
      const project = makeProject();
      assert.equal(store.projectRecoveryState.claimInheritedNotice(project.id, 'launch-1'), true);
      assert.equal(store.projectRecoveryState.claimInheritedNotice(project.id, 'launch-2'), false);
      const row = store.projectRecoveryState.get(project.id);
      assert.equal(row.inheritedNoticeLaunchId, 'launch-1');
      assert.ok(row.inheritedNoticeAt);
      assert.equal(row.pinnedAt, null, 'a row made by the claim records no decision');
      assert.equal(row.pinnedMode, null);
    });

    it('claims on a row that already exists with a NULL pin, and leaves the pin columns alone', () => {
      const project = makeProject();
      store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
      const before = store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
      assert.equal(store.projectRecoveryState.claimInheritedNotice(project.id, 'launch-1'), true);
      assert.equal(store.projectRecoveryState.claimInheritedNotice(project.id, 'launch-2'), false);
      const row = store.projectRecoveryState.get(project.id);
      assert.equal(row.inheritedNoticeLaunchId, 'launch-1');
      assert.deepEqual([row.pinnedMode, row.pinnedAt, row.pinnedBy], [before.pinnedMode, before.pinnedAt, before.pinnedBy]);
    });

    it('survives a pin and an unpin unchanged', () => {
      const project = makeProject();
      store.projectRecoveryState.claimInheritedNotice(project.id, 'launch-1');
      const claimed = store.projectRecoveryState.get(project.id);
      store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
      store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
      const row = store.projectRecoveryState.get(project.id);
      assert.equal(row.inheritedNoticeAt, claimed.inheritedNoticeAt);
      assert.equal(row.inheritedNoticeLaunchId, 'launch-1');
      assert.equal(store.projectRecoveryState.claimInheritedNotice(project.id, 'launch-2'), false);
    });

    it('two connections racing yield one notice, with and without a row beforehand', () => {
      for (const seedRow of [false, true]) {
        const project = makeProject();
        if (seedRow) store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
        // A second connection to the same database file stands in for the
        // second launch. Each claim is one statement, so whichever lands
        // second sees the first's row and changes nothing.
        const other = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
        try {
          const theirs = other.prepare(
            `INSERT INTO project_recovery_state (project_id, inherited_notice_at, inherited_notice_launch_id)
             VALUES (?, datetime('now'), ?)
             ON CONFLICT(project_id) DO UPDATE
               SET inherited_notice_at = excluded.inherited_notice_at,
                   inherited_notice_launch_id = excluded.inherited_notice_launch_id
               WHERE project_recovery_state.inherited_notice_at IS NULL`
          ).run(project.id, 'launch-theirs');
          const ours = store.projectRecoveryState.claimInheritedNotice(project.id, 'launch-ours');
          assert.equal(Number(theirs.changes) + (ours ? 1 : 0), 1, `seeded row: ${seedRow}`);
          assert.equal(store.projectRecoveryState.get(project.id).inheritedNoticeLaunchId, 'launch-theirs');
        } finally {
          other.close();
        }
      }
    });
  });

  describe('a launch freezes the mode the store and file resolve to', () => {
    it('a pinned project launches in operator mode even when its file says advisory', () => {
      const project = makeProject('advisory');
      store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
      assert.equal(launch(project).recoveryMode, 'operator');
    });

    it('a project the operator chose advisory for launches advisory even when its file says operator', () => {
      const project = makeProject('operator');
      store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
      assert.equal(launch(project).recoveryMode, 'advisory');
    });

    it('a hand-written operator with no decision behind it is not a pin, and today still launches operator', () => {
      const project = makeProject('operator');
      assert.equal(launch(project).recoveryMode, 'operator');
      assert.equal(store.projectRecoveryState.get(project.id), null, 'and no launch records a decision');
    });

    it('reads the decision exactly once per launch', () => {
      const project = makeProject('advisory');
      store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
      const real = store.projectRecoveryState.get;
      let reads = 0;
      store.projectRecoveryState.get = (id) => {
        reads += 1;
        // A second read would see the operator unpin mid-launch. The launch
        // must have decided from the first.
        return reads === 1 ? real(id) : { pinnedMode: null, pinnedAt: 'later', pinnedBy: 'operator' };
      };
      let sequence;
      try {
        sequence = launch(project);
      } finally {
        store.projectRecoveryState.get = real;
      }
      assert.equal(reads, 1);
      assert.equal(sequence.recoveryMode, 'operator');
    });

    it('takes operator mode when the decision cannot be read, whatever the file says', () => {
      const project = makeProject('advisory');
      const real = store.projectRecoveryState.get;
      store.projectRecoveryState.get = () => { throw new Error('disk I/O error'); };
      let sequence;
      try {
        sequence = launch(project);
      } finally {
        store.projectRecoveryState.get = real;
      }
      assert.equal(sequence.recoveryMode, 'operator', 'an unreadable decision never loosens the gate');
    });
  });

  describe('the launch claims the inherited notice, once', () => {
    it('the first inherited launch creates the row and claims it; the second does not', () => {
      const project = makeProject('operator');
      withAdvisoryDefault(() => {
        const first = launch(project);
        assert.equal(first.recoveryMode, 'advisory');
        const row = store.projectRecoveryState.get(project.id);
        assert.equal(row.inheritedNoticeLaunchId, first.launchId);
        assert.equal(row.pinnedAt, null);
        const second = launch(project);
        assert.notEqual(second.launchId, first.launchId);
        assert.equal(store.projectRecoveryState.get(project.id).inheritedNoticeLaunchId, first.launchId,
          'the marker still names the launch that carried the notice');
      });
    });

    it('a project pinned and then unpinned is chosen, so its launches claim nothing', () => {
      // Pinned then unpinned is a decision on record, so the project is
      // `chosen`, not `inherited`, and its launches claim nothing.
      const project = makeProject('operator');
      store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
      store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
      withAdvisoryDefault(() => {
        assert.equal(launch(project).recoveryMode, 'advisory');
        assert.equal(store.projectRecoveryState.get(project.id).inheritedNoticeAt, null);
      });
    });

    it('a project that was never inherited never sets the marker', () => {
      withAdvisoryDefault(() => {
        // A `launchSequence` block with no `recoveryMode` in it: the one file
        // shape that reads as holding nothing, and so as `default`.
        const absent = makeProject();
        fs.mkdirSync(path.join(absent.path, '.tangleclaw'), { recursive: true });
        fs.writeFileSync(path.join(absent.path, '.tangleclaw', 'project.json'),
          JSON.stringify({ launchSequence: { pasteRules: 'pull' } }) + '\n');
        assert.equal(effective(absent).source, 'default', 'precondition: this project holds no value');
        const advisory = makeProject('advisory');
        const pinned = makeProject('operator');
        store.projectRecoveryState.recordDecision(pinned.id, 'operator', 'operator');
        const chose = makeProject('operator');
        store.projectRecoveryState.recordDecision(chose.id, 'advisory', 'operator');
        const invalid = makeProject('nonsense');
        for (const project of [absent, advisory, pinned, chose, invalid]) {
          launch(project);
          const row = store.projectRecoveryState.get(project.id);
          assert.equal(row ? row.inheritedNoticeAt : null, null, effective(project).source);
        }
      });
      const today = makeProject('operator');
      launch(today);
      assert.equal(store.projectRecoveryState.get(today.id), null, 'and nothing claims while advisory is not the default');
    });

    it('a project with no file at all holds the seeded value, so its first launch under the default claims', () => {
      // `load` hands a project with no file the default block, `operator`
      // included, so it cannot be told from one saved long ago. Both read as
      // inherited, which is why the notice does not say the project moved.
      const fresh = makeProject();
      assert.equal(fileMode(fresh), undefined, 'precondition: nothing was written');
      withAdvisoryDefault(() => {
        assert.equal(effective(fresh).source, 'inherited');
        const first = launch(fresh);
        assert.equal(first.recoveryMode, 'advisory');
        assert.equal(store.projectRecoveryState.get(fresh.id).inheritedNoticeLaunchId, first.launchId);
      });
    });

    it('a launch whose insert fails leaves the marker unset and no row, and the next launch carries the notice', () => {
      const project = makeProject('operator');
      withAdvisoryDefault(() => {
        // The duplicate launch id fails the sequence INSERT, which runs after
        // the claim in the same transaction, so this is a rollback of a claim
        // that had been made and not a launch that never tried.
        const taken = launch(makeProject('advisory')).launchId;
        assert.throws(() => store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: `dup-${counter}`,
          launchSequence: {
            launchId: taken, pageBudget: 4000, applicability: 'not-applicable', notApplicableReason: 'test',
            preflight: { verdict: 'ok' }, sourceManifest: {}, steps: [], claimInheritedNotice: true
          }
        }), /UNIQUE/);
        assert.equal(store.projectRecoveryState.get(project.id), null, 'the rollback took the claimed row with it');
        const next = launch(project);
        assert.equal(store.projectRecoveryState.get(project.id).inheritedNoticeLaunchId, next.launchId);
      });
    });
  });

  describe('a recovery-mode write is two stores, store first', () => {
    /**
     * Make one store method throw for the duration of a block.
     * @param {object} owner - The object holding the method
     * @param {string} method - Its name
     * @param {function(): Promise<*>} fn - The block
     * @returns {Promise<*>}
     */
    async function failing(owner, method, fn) {
      const real = owner[method];
      owner[method] = () => { throw new Error(`injected ${method} failure`); };
      try {
        return await fn();
      } finally {
        owner[method] = real;
      }
    }

    it('both succeed: the store holds the decision and the file shows it', async () => {
      const project = makeProject();
      const result = await projects.updateProject(project.name, { launchSequence: { recoveryMode: 'operator' } }, { recoveryDecisionBy: 'operator' });
      assert.ok(result.project);
      assert.deepEqual({ ...result.recoveryMode, decidedAt: null }, { mode: 'operator', pinnedMode: 'operator', decidedAt: null, decidedBy: 'operator', fileWritten: true });
      assert.equal(fileMode(project), 'operator');
      assert.deepEqual(effective(project), { mode: 'operator', source: 'pinned' });
      const back = await projects.updateProject(project.name, { launchSequence: { recoveryMode: 'advisory' } }, { recoveryDecisionBy: 'operator' });
      assert.equal(back.recoveryMode.pinnedMode, null);
      assert.equal(fileMode(project), 'advisory');
      assert.deepEqual(effective(project), { mode: 'advisory', source: 'chosen' });
      // The row holds only the latest decision. The activity log is what says
      // the project was pinned before the pin was lifted, and who did each.
      const events = store.activity.query({ projectId: project.id, eventType: 'project.recovery-mode-decided' });
      assert.deepEqual(events.map((e) => [e.detail.mode, e.detail.pinnedMode, e.detail.decidedBy]).sort(),
        [['advisory', null, 'operator'], ['operator', 'operator', 'operator']]);
    });

    it('a decision that could not be saved, or was refused, leaves no decision event', async () => {
      const project = makeProject();
      await failing(store.projectRecoveryState, 'recordDecision', () => projects.updateProject(project.name,
        { launchSequence: { recoveryMode: 'operator' } }, { recoveryDecisionBy: 'operator' }));
      await projects.updateProject(project.name, { launchSequence: { recoveryMode: 'operator' } });
      await projects.updateProject(project.name, { launchSequence: { unreadyWindowMinutes: 12 } });
      assert.deepEqual(store.activity.query({ projectId: project.id, eventType: 'project.recovery-mode-decided' }), []);
    });

    it('the store write fails: an error, the file is not attempted, and nothing else in the request is applied', async () => {
      const project = makeProject('advisory');
      let saves = 0;
      const realSave = store.projectConfig.save;
      store.projectConfig.save = (...args) => { saves += 1; return realSave(...args); };
      let result;
      try {
        result = await failing(store.projectRecoveryState, 'recordDecision', () => projects.updateProject(project.name,
          { tags: ['smuggled'], launchSequence: { recoveryMode: 'operator', unreadyWindowMinutes: 20 } }, { recoveryDecisionBy: 'operator' }));
      } finally {
        store.projectConfig.save = realSave;
      }
      assert.equal(result.project, null);
      assert.equal(result.code, projects.RECOVERY_DECISION_NOT_SAVED);
      assert.match(result.errors[0], /Nothing in this request was applied/);
      assert.equal(saves, 0, 'the file write was not attempted');
      assert.equal(fileMode(project), 'advisory');
      assert.deepEqual(store.projects.getByName(project.name).tags, []);
      assert.equal(store.projectRecoveryState.get(project.id), null);
      // Read where the file's `advisory` counts, so "unchanged" is told apart
      // from the operator pin the failed request asked for.
      withAdvisoryDefault(() => {
        assert.deepEqual(effective(project), { mode: 'advisory', source: 'launchSequence' }, 'the effective mode is unchanged');
      });
    });

    it('the store succeeds and the file fails: the mode is as requested, and the answer names what did not land', async () => {
      const project = makeProject('advisory');
      const result = await failing(store.projectConfig, 'save', () => projects.updateProject(project.name,
        { launchSequence: { recoveryMode: 'operator', unreadyWindowMinutes: 20 } }, { recoveryDecisionBy: 'operator' }));
      assert.ok(result.project, 'the request succeeded at the write that decides');
      assert.equal(result.recoveryMode.fileWritten, false);
      assert.equal(result.recoveryMode.pinnedMode, 'operator');
      const warning = result.warnings.find((w) => w.startsWith(projects.RECOVERY_FILE_NOT_WRITTEN));
      assert.ok(warning, 'the warning is named');
      assert.match(warning, /saved as operator/);
      assert.match(warning, /launchSequence\.unreadyWindowMinutes/, 'and names the setting that lives only in the file');
      assert.equal(fileMode(project), 'advisory', 'the file still shows the old value');
      const now = effective(project);
      assert.equal(now.mode, 'operator', 'the store decides');
      assert.equal(now.source, 'pinned');
      assert.match(now.discrepancy, /the pin decides/);
    });

    it('an advisory choice on a project with no row, with the file write failing, is chosen and never the migration', async () => {
      const project = makeProject('operator');
      const result = await failing(store.projectConfig, 'save', () => projects.updateProject(project.name,
        { launchSequence: { recoveryMode: 'advisory' } }, { recoveryDecisionBy: 'operator' }));
      assert.ok(result.project);
      assert.ok(result.warnings.some((w) => w.startsWith(projects.RECOVERY_FILE_NOT_WRITTEN)));
      const row = store.projectRecoveryState.get(project.id);
      assert.equal(row.pinnedMode, null);
      assert.ok(row.pinnedAt, 'the row exists with a NULL pin and the decision stamped');
      assert.equal(fileMode(project), 'operator');
      withAdvisoryDefault(() => {
        const now = effective(project);
        assert.equal(now.mode, 'advisory');
        assert.equal(now.source, 'chosen');
        assert.match(now.discrepancy, /chose advisory/);
        const live = launchSequence.projectRecoveryNow(project.id);
        assert.equal(live.projectRecoverySource, 'chosen');
        assert.match(live.projectRecoveryDiscrepancy, /chose advisory/);
        const sequence = launch(project);
        assert.equal(sequence.recoveryMode, 'advisory');
        assert.equal(store.projectRecoveryState.get(project.id).inheritedNoticeAt, null,
          'a chosen project never carries the inherited notice');
      });
    });

    it('a caller that names no decider is refused whole: no store row, no file write, no other key', async () => {
      const project = makeProject();
      for (const options of [undefined, {}, { recoveryDecisionBy: '' }]) {
        const result = await projects.updateProject(project.name, { tags: ['x'], launchSequence: { recoveryMode: 'operator' } }, options);
        assert.equal(result.project, null);
        assert.match(result.errors[0], /operator's decision/);
      }
      assert.equal(store.projectRecoveryState.get(project.id), null);
      assert.equal(fileMode(project), undefined);
      assert.deepEqual(store.projects.getByName(project.name).tags, []);
    });

    it('a request that names no recovery mode writes no decision, and a disk failure is still a failure', async () => {
      const project = makeProject();
      const ok = await projects.updateProject(project.name, { launchSequence: { unreadyWindowMinutes: 15 } });
      assert.ok(ok.project);
      assert.equal(ok.recoveryMode, undefined);
      assert.equal(store.projectRecoveryState.get(project.id), null);
      await assert.rejects(failing(store.projectConfig, 'save',
        () => projects.updateProject(project.name, { launchSequence: { unreadyWindowMinutes: 16 } })), /injected save failure/);
    });

    it('a later failure in the same request still says the mode was saved', async () => {
      const project = makeProject();
      const realSave = store.projectConfig.save;
      let calls = 0;
      // The first file write of this request is `wrapSections`; it fails
      // before the launch block is reached, after the store write landed.
      store.projectConfig.save = (...args) => {
        calls += 1;
        if (calls === 1) throw new Error('injected first-save failure');
        return realSave(...args);
      };
      let thrown;
      try {
        await assert.rejects(projects.updateProject(project.name,
          { wrapSections: null, launchSequence: { recoveryMode: 'operator' } }, { recoveryDecisionBy: 'operator' }),
        (err) => { thrown = err; return /injected first-save failure\. The recovery mode itself was saved as operator/.test(err.message); });
      } finally {
        store.projectConfig.save = realSave;
      }
      assert.equal(effective(project).mode, 'operator');
      // As a field too, for a caller that does not read sentences.
      assert.equal(thrown.recoveryDecisionSaved.mode, 'operator');
      assert.equal(thrown.recoveryDecisionSaved.pinnedMode, 'operator');
      assert.equal(thrown.recoveryDecisionSaved.decidedBy, 'operator');
      assert.match(thrown.recoveryDecisionSavedMessage, /saved as operator before this failed/);
    });

    it('a returned failure after the decision carries it too: a rename that will not move', async () => {
      const project = makeProject();
      const realRename = fs.renameSync;
      fs.renameSync = () => { throw new Error('injected rename failure'); };
      let result;
      try {
        result = await projects.updateProject(project.name,
          { name: `${project.name}-moved`, launchSequence: { recoveryMode: 'operator' } }, { recoveryDecisionBy: 'operator' });
      } finally {
        fs.renameSync = realRename;
      }
      assert.equal(result.project, null);
      assert.match(result.errors[0], /Failed to rename directory: injected rename failure/);
      assert.equal(result.recoveryDecisionSaved.mode, 'operator');
      assert.equal(result.recoveryDecisionSaved.pinnedMode, 'operator');
      assert.match(result.recoveryDecisionSavedMessage, /saved as operator before this failed/);
      assert.ok(store.projects.getByName(project.name), 'the project keeps its name');
      assert.equal(effective(project).mode, 'operator', 'and the decision stands');
    });

    it('a failure with no decision in the request carries no such statement', async () => {
      const project = makeProject();
      const realRename = fs.renameSync;
      fs.renameSync = () => { throw new Error('injected rename failure'); };
      let result;
      try {
        result = await projects.updateProject(project.name, { name: `${project.name}-moved` });
      } finally {
        fs.renameSync = realRename;
      }
      assert.equal(result.project, null);
      assert.equal(result.recoveryDecisionSaved, undefined);
      assert.deepEqual(result.errors, ['Failed to rename directory: injected rename failure']);
    });
  });

  describe('what the live read reports', () => {
    it('names the source, the decision and the marker, and null for a project that does not exist', () => {
      const project = makeProject('advisory');
      withAdvisoryDefault(() => {
        assert.deepEqual(launchSequence.projectRecoveryNow(project.id), {
          projectRecoveryMode: 'advisory',
          projectRecoverySource: 'launchSequence',
          projectRecoveryGateState: 'armed',
          projectRecoveryDiscrepancy: null,
          projectRecoveryDecision: null,
          projectRecoveryInheritedNotice: null
        });
      });
      store.projectRecoveryState.claimInheritedNotice(project.id, 'launch-n');
      const noticed = launchSequence.projectRecoveryNow(project.id);
      assert.equal(noticed.projectRecoveryDecision, null, 'a row is not a decision');
      assert.equal(noticed.projectRecoveryInheritedNotice.launchId, 'launch-n');
      store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
      const pinned = launchSequence.projectRecoveryNow(project.id);
      assert.equal(pinned.projectRecoveryMode, 'operator');
      assert.equal(pinned.projectRecoverySource, 'pinned');
      assert.match(pinned.projectRecoveryDiscrepancy, /the pin decides/);
      assert.equal(pinned.projectRecoveryDecision.pinnedMode, 'operator');
      assert.equal(pinned.projectRecoveryDecision.decidedBy, 'operator');
      assert.equal(pinned.projectRecoveryInheritedNotice.launchId, 'launch-n');
      for (const missing of [999999, null, undefined]) {
        assert.deepEqual(Object.values(launchSequence.projectRecoveryNow(missing)), [null, null, null, null, null, null]);
      }
    });

    it('resolves against the login gate as it stands, and reports the state it used', () => {
      const seeded = makeProject('operator');
      const asked = makeProject('advisory');
      const read = (project) => {
        const now = launchSequence.projectRecoveryNow(project.id);
        return [now.projectRecoveryMode, now.projectRecoverySource, now.projectRecoveryGateState];
      };
      assert.deepEqual(read(seeded), ['operator', 'not-armed', null], 'a process that cannot ask the gate');
      for (const state of Object.values(authGate.GATE_STATES)) {
        recoveryDefault.setGateStateProbe(() => state);
        try {
          const armed = state === authGate.GATE_STATES.ARMED;
          assert.deepEqual(read(seeded), armed ? ['advisory', 'inherited', state] : ['operator', 'not-armed', state], state);
          assert.deepEqual(read(asked), armed ? ['advisory', 'launchSequence', state] : ['operator', 'not-armed', state], state);
          assert.equal(launchSequence.projectRecoveryNow(999999).projectRecoveryGateState, state,
            'the gate state is the install\'s, so it is reported for a project this install does not have');
        } finally {
          recoveryDefault.setGateStateProbe(null);
        }
      }
    });
  });
});
