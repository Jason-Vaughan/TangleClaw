'use strict';

// #2320: who decides when a project's pull requests merge. Driven through the
// real settings reader, the real project registry and the real merge queue
// store on a temporary database: the answer is only as good as what those
// three actually say, so none of them is replaced except to make one fail.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const queues = require('../lib/merge-queue-store');
const authority = require('../lib/merge-authority');

const OPERATOR = { kind: 'operator', operatorProof: 'verified-session' };
const REPO = 'Jason-Vaughan/TangleClaw';
const WHERE = { repo: REPO, baseBranch: 'main' };

let tmpDir = null;
const original = { ...authority._internal };

/**
 * Register a project in a folder of its own.
 * @param {string} name - Project name
 * @param {*} [workloadNudge] - Its `workloadNudge` setting; omitted writes no settings file
 * @returns {object} The project record
 */
function mkProject(name, workloadNudge) {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir);
  if (workloadNudge !== undefined) writeSettings(dir, JSON.stringify({ workloadNudge }));
  return store.projects.create({ name, path: dir, engine: 'claude' });
}

/**
 * Write a project's settings file as given, valid JSON or not.
 * @param {string} dir - Project folder
 * @param {string} text - The file's whole content
 * @returns {void}
 */
function writeSettings(dir, text) {
  fs.mkdirSync(path.join(dir, '.tangleclaw'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), text);
}

/**
 * Make an active queue.
 * @param {number} ownerProjectId - Its owner
 * @param {string} [repo] - Its repository
 * @param {string} [baseBranch] - Its base branch
 * @returns {object} The queue
 */
function mkQueue(ownerProjectId, repo = REPO, baseBranch = 'main') {
  const made = queues.createQueue({ repo, baseBranch, ownerProjectId, actor: OPERATOR });
  assert.equal(made.ok, true, made.message);
  return made.queue;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-merge-authority-'));
  store._setBasePath(tmpDir);
  store.init();
});

afterEach(() => {
  Object.assign(authority._internal, original);
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('merge authority: a project that names no coordinator decides its own merges (#2320)', () => {
  it('is self with no settings file and no queue', () => {
    const solo = mkProject('solo');
    const answer = authority.forProject(solo, WHERE);
    assert.deepEqual(answer, { authority: 'self' });
    assert.equal(authority.mayArmAutoMerge(answer), true);
    assert.equal(authority.describe(answer, solo), null);
  });

  it('is self when its settings name nobody, in each way of naming nobody', () => {
    for (const nudge of [null, {}, { enabled: true }, { enabled: true, coordinatorProject: null }]) {
      const name = `solo-${JSON.stringify(nudge).length}-${Math.random().toString(36).slice(2, 8)}`;
      assert.deepEqual(authority.forProject(mkProject(name, nudge), WHERE), { authority: 'self' }, JSON.stringify(nudge));
    }
  });

  it('stays self on a repository whose queue another project owns, and the queue is not read', () => {
    const integrator = mkProject('integrator', { coordinatorProject: 'integrator' });
    mkQueue(integrator.id);
    const solo = mkProject('solo');
    let reads = 0;
    authority._internal.findActiveQueue = (...args) => { reads += 1; return original.findActiveQueue(...args); };
    assert.deepEqual(authority.forProject(solo, WHERE), { authority: 'self' });
    assert.equal(reads, 0);
  });

  it('stays self when the repository and base are not known', () => {
    assert.deepEqual(authority.forProject(mkProject('solo'), { repo: null, baseBranch: null }), { authority: 'self' });
    assert.deepEqual(authority.forProject(mkProject('solo-2')), { authority: 'self' });
  });
});

describe('merge authority: a project that names a coordinator has given its merges away (#2320)', () => {
  it('names the coordinator when no queue exists', () => {
    const lane = mkProject('lane-a', { enabled: true, coordinatorProject: 'integrator' });
    const answer = authority.forProject(lane, WHERE);
    assert.deepEqual(answer, { authority: 'integrator', integrator: 'integrator', source: 'coordinator' });
    assert.equal(authority.mayArmAutoMerge(answer), false);
    assert.match(authority.describe(answer, lane), /belong to integrator.*integrator merges this pull request/);
  });

  it('names the coordinator whether or not the nudge is switched on, and whether or not it is registered', () => {
    const lane = mkProject('lane-a', { enabled: false, coordinatorProject: 'nobody-registered' });
    assert.deepEqual(authority.forProject(lane, WHERE),
      { authority: 'integrator', integrator: 'nobody-registered', source: 'coordinator' });
  });

  it('is confirmed by a queue the coordinator owns', () => {
    const integrator = mkProject('integrator', { coordinatorProject: 'integrator' });
    mkQueue(integrator.id);
    const lane = mkProject('lane-a', { coordinatorProject: 'integrator' });
    assert.deepEqual(authority.forProject(lane, WHERE),
      { authority: 'integrator', integrator: 'integrator', source: 'coordinator-and-queue' });
  });

  it('leaves the queue\'s owner unarmed too, when it names a coordinator', () => {
    const integrator = mkProject('integrator', { coordinatorProject: 'integrator' });
    mkQueue(integrator.id);
    const answer = authority.forProject(integrator, WHERE);
    assert.deepEqual(answer, { authority: 'integrator', integrator: 'integrator', source: 'coordinator-and-queue' });
    assert.equal(authority.mayArmAutoMerge(answer), false);
    assert.match(authority.describe(answer, integrator), /integrator coordinates the merges/);
  });

  it('leaves the queue\'s owner unarmed when the coordinator it names is another project', () => {
    const owner = mkProject('owner', { coordinatorProject: 'manager' });
    mkQueue(owner.id);
    assert.deepEqual(authority.forProject(owner, WHERE),
      { authority: 'integrator', integrator: 'owner', source: 'coordinator-and-queue' });
  });

  it('ignores a retired queue, a queue for another base and a queue for another repository', () => {
    const other = mkProject('other');
    const retired = mkQueue(other.id);
    assert.equal(queues.retireQueue(retired.queueId, { actor: OPERATOR }).ok, true);
    mkQueue(other.id, REPO, 'release');
    mkQueue(other.id, 'Jason-Vaughan/Elsewhere', 'main');
    const lane = mkProject('lane-a', { coordinatorProject: 'integrator' });
    assert.deepEqual(authority.forProject(lane, WHERE),
      { authority: 'integrator', integrator: 'integrator', source: 'coordinator' });
  });
});

describe('merge authority: what cannot be read arms nothing (#2320)', () => {
  /**
   * Assert an answer is `unknown`, arms nothing and says why.
   * @param {object} answer - From `forProject`
   * @param {RegExp} why - What the reason must say
   * @returns {void}
   */
  function assertUnknown(answer, why) {
    assert.equal(answer.authority, 'unknown', JSON.stringify(answer));
    assert.match(answer.reason, why);
    assert.equal(authority.mayArmAutoMerge(answer), false);
    assert.match(authority.describe(answer), /could not be established/);
    assert.ok(authority.describe(answer).includes(answer.reason));
  }

  it('is unknown for a project with no folder, and for no project at all', () => {
    assertUnknown(authority.forProject({ name: 'ghost' }, WHERE), /no folder/);
    assertUnknown(authority.forProject(null, WHERE), /no folder/);
  });

  it('is unknown when the settings file is not JSON', () => {
    const lane = mkProject('lane-a');
    writeSettings(lane.path, '{ "workloadNudge": { "coordinatorProject": "integr');
    assertUnknown(authority.forProject(lane, WHERE), /settings .* could not be read/);
  });

  it('is unknown, never self, for a coordinator value the settings reader refuses', () => {
    for (const value of ['', '   ', ' integrator', 'integrator ', 7, true, ['integrator'], { name: 'integrator' }, 'two\nlines']) {
      const name = `lane-${Math.random().toString(36).slice(2, 8)}`;
      assertUnknown(authority.forProject(mkProject(name, { coordinatorProject: value }), WHERE), /not a project name/);
    }
  });

  it('is unknown when workloadNudge is not an object', () => {
    for (const value of ['integrator', 7, true, ['integrator']]) {
      const name = `lane-${Math.random().toString(36).slice(2, 8)}`;
      assertUnknown(authority.forProject(mkProject(name, value), WHERE), /not an object/);
    }
  });

  it('is unknown when a coordinator is named and the repository or the base is not known', () => {
    const lane = mkProject('lane-a', { coordinatorProject: 'integrator' });
    for (const repo of [null, undefined, '', 'not-a-repo', 'github.com/Jason-Vaughan/TangleClaw']) {
      assertUnknown(authority.forProject(lane, { repo, baseBranch: 'main' }), /repository could not be named/);
    }
    for (const baseBranch of [null, undefined, '', '  ']) {
      assertUnknown(authority.forProject(lane, { repo: REPO, baseBranch }), /base branch is not known/);
    }
    assertUnknown(authority.forProject(lane), /repository could not be named/);
  });

  it('is unknown when the queue\'s record cannot be read', () => {
    const lane = mkProject('lane-a', { coordinatorProject: 'integrator' });
    authority._internal.findActiveQueue = () => { throw new Error('database is locked'); };
    assertUnknown(authority.forProject(lane, WHERE), /merge queue's record for Jason-Vaughan\/TangleClaw main could not be read/);
  });

  it('is unknown when the queue is owned by a project other than the coordinator named', () => {
    const integrator = mkProject('integrator', { coordinatorProject: 'integrator' });
    const stranger = mkProject('stranger');
    mkQueue(stranger.id);
    const lane = mkProject('lane-a', { coordinatorProject: 'integrator' });
    assertUnknown(authority.forProject(lane, WHERE), /name integrator as coordinator, but the merge queue .* is owned by stranger/);
    assertUnknown(authority.forProject(integrator, WHERE), /is owned by stranger/);
  });

  it('is unknown when the queue\'s owner is not a registered project', () => {
    mkQueue(9999);
    const lane = mkProject('lane-a', { coordinatorProject: 'integrator' });
    assertUnknown(authority.forProject(lane, WHERE), /owned by project 9999, which is not registered/);
  });

  it('never throws: a reader that throws is an unknown answer', () => {
    const lane = mkProject('lane-a', { coordinatorProject: 'integrator' });
    authority._internal.loadConfig = () => { throw new Error('EACCES'); };
    assertUnknown(authority.forProject(lane, WHERE), /reading it failed \(EACCES\)/);
    authority._internal.loadConfig = original.loadConfig;
    mkQueue(lane.id + 100);
    authority._internal.getProject = () => { throw new Error('no registry'); };
    assertUnknown(authority.forProject(lane, WHERE), /reading it failed \(no registry\)/);
  });

  it('arms for nothing but a self answer', () => {
    for (const answer of [null, undefined, {}, { authority: 'unknown' }, { authority: 'integrator' }, { authority: 'SELF' }, 'self']) {
      assert.equal(authority.mayArmAutoMerge(answer), false, JSON.stringify(answer));
    }
    assert.equal(authority.mayArmAutoMerge({ authority: 'self' }), true);
    assert.match(authority.describe(null), /no answer was given/);
  });
});

describe('merge authority: reads the project\'s settings from its registered checkout (#2320)', () => {
  it('uses configPath when the wrap works on another tree', () => {
    const lane = mkProject('lane-a', { coordinatorProject: 'integrator' });
    const worktree = path.join(tmpDir, 'worktree');
    fs.mkdirSync(worktree);
    const working = { ...lane, path: worktree, configPath: lane.path };
    assert.equal(authority.forProject(working, WHERE).authority, 'integrator');
    assert.deepEqual(authority.forProject({ ...lane, path: worktree }, WHERE), { authority: 'self' });
  });
});

describe('merge authority: naming a repository from its remote (#2320)', () => {
  it('gives owner/name for a github.com remote in each form, and null otherwise', () => {
    assert.equal(authority.repoFromRemoteUrl('https://github.com/Jason-Vaughan/TangleClaw.git\n'), REPO);
    assert.equal(authority.repoFromRemoteUrl('git@github.com:Jason-Vaughan/TangleClaw.git'), REPO);
    assert.equal(authority.repoFromRemoteUrl('https://token@github.com/Jason-Vaughan/TangleClaw'), REPO);
    assert.equal(authority.repoFromRemoteUrl('https://gitlab.com/Jason-Vaughan/TangleClaw.git'), null);
    assert.equal(authority.repoFromRemoteUrl('/tmp/some/bare.git'), null);
    assert.equal(authority.repoFromRemoteUrl(''), null);
    assert.equal(authority.repoFromRemoteUrl(null), null);
  });
});
