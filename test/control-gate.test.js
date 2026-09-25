'use strict';

// #1861: the mutation gate. It reads the control tables directly, never the
// inbox or a listener, and gates the mutation's SUBJECT: a job is held by the
// assignment it was admitted under and can only be tightened by a newer one; a
// caller-owned global request is held by the caller's own assignment, or, when
// the caller cannot be attributed, by any held lane. A store that cannot be read
// refuses subjects known to be governed.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const control = require('../lib/control-state');
const gate = require('../lib/control-gate');
const commitStep = require('../lib/wrap-steps/commit');
const prMerge = require('../lib/wrap-steps/pr-merge');
const strandedCheck = require('../lib/stranded-check');
const strandedWraps = require('../lib/stranded-wraps');
const { initRepo } = require('./_temp-repo');
const { cleanLaunchScope } = require('./_wrap-scope-fixture');

const OPERATOR = { principal: 'operator', operatorProof: 'verified-session' };
const PM = { principal: 'project:74' };

let tmpDir;
let n = 0;
const rid = () => { n += 1; return `gate-${n}`; };

/**
 * A fresh project, optionally governed by an operator assignment.
 * @param {boolean} [governed]
 * @returns {{project: object, assignmentId: (string|null)}}
 */
function lane(governed = true) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'lane-'));
  const project = store.projects.create({ name: `lane-${path.basename(dir)}`, path: dir, engine: 'claude' });
  if (!governed) return { project, assignmentId: null };
  const a = control.create({ projectId: project.id, requestId: rid(), authority: { hold: ['project:74'], stop: ['project:74'] } }, OPERATOR);
  return { project, assignmentId: a.assignment.assignmentId };
}

/**
 * Place a PM hold.
 * @param {string} assignmentId
 * @returns {object}
 */
function holdIt(assignmentId) {
  return control.hold({ assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
}

describe('control-gate (#1861)', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-gate-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => gate._resetForTests());

  describe('subjects', () => {
    it('an ungoverned project passes; a held one is 423 CONTROL_HELD with its hold ids, and the refusal is recorded as observed', () => {
      const free = lane(false);
      assert.equal(gate.checkMutation({ surface: 't', subject: { kind: 'target', projectId: free.project.id } }), null);
      const { project, assignmentId } = lane();
      const h = holdIt(assignmentId);
      const r = gate.checkMutation({ surface: 't', subject: { kind: 'target', projectId: project.id } });
      assert.equal(r.status, 423);
      assert.equal(r.code, 'CONTROL_HELD');
      assert.deepEqual(r.details.activeHoldIds, [h.holdId]);
      const facts = control.status(assignmentId).events.at(-1).receipts.map((x) => [x.fact, x.outcomeCode]);
      assert.ok(facts.some(([f, o]) => f === 'observed' && o === 'gate-refusal'));
    });

    it('two lanes are isolated: holding one leaves the other allowed', () => {
      const a = lane();
      const b = lane();
      holdIt(a.assignmentId);
      assert.equal(gate.checkMutation({ surface: 't', subject: { kind: 'job', projectId: a.project.id, assignmentId: a.assignmentId } }).code, 'CONTROL_HELD');
      assert.equal(gate.checkMutation({ surface: 't', subject: { kind: 'job', projectId: b.project.id, assignmentId: b.assignmentId } }), null);
    });

    it('an old job is never revived by a new assignment: admitted under X, X stopped, Y created ⇒ still refused', () => {
      const { project, assignmentId: x } = lane();
      const captured = gate.captureAssignment(project.id);
      assert.equal(captured, x);
      control.stop({ assignmentId: x, requestId: rid(), reasonCode: 'incident' }, OPERATOR);
      const y = control.create({ projectId: project.id, requestId: rid() }, OPERATOR);
      assert.equal(y.supersededAssignmentId, x);
      const r = gate.checkMutation({ surface: 'wrap-commit', subject: { kind: 'job', projectId: project.id, assignmentId: captured } });
      assert.equal(r.code, 'CONTROL_STOPPED');
      // New work admitted under Y is allowed.
      assert.equal(gate.checkMutation({ surface: 'wrap-commit', subject: { kind: 'job', projectId: project.id, assignmentId: y.assignment.assignmentId } }), null);
    });

    it('a job admitted with no assignment is tightened by one created later', () => {
      const { project } = lane(false);
      const captured = gate.captureAssignment(project.id);
      assert.equal(captured, null);
      const a = control.create({ projectId: project.id, requestId: rid(), authority: { hold: ['project:74'] } }, OPERATOR);
      holdIt(a.assignment.assignmentId);
      assert.equal(gate.checkMutation({ surface: 'wrap-push', subject: { kind: 'job', projectId: project.id, assignmentId: captured } }).code, 'CONTROL_HELD');
    });

    it('caller subjects: the operator and the Master are never held; a bound caller is held only by its own lane; an unattributable caller is refused while any lane is held', () => {
      const caller = (kind, projectId) => ({ kind: 'caller', caller: { kind, projectId } });
      // With no lane held anywhere (a fresh store), an unattributable caller is not refused.
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-gate-fresh-'));
      store.close();
      store._setBasePath(freshDir);
      store.init();
      try {
        lane();
        assert.equal(gate.checkMutation({ surface: 'r', subject: caller('unbound') }), null, 'nothing held');
      } finally {
        store.close();
        store._setBasePath(tmpDir);
        store.init();
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
      const builder = lane();
      const pmLane = lane(false);
      holdIt(builder.assignmentId);
      assert.equal(gate.checkMutation({ surface: 'r', subject: caller('operator') }), null);
      assert.equal(gate.checkMutation({ surface: 'r', subject: caller('master') }), null);
      assert.equal(gate.checkMutation({ surface: 'r', subject: caller('project', pmLane.project.id) }), null, 'a clear PM is allowed');
      assert.equal(gate.checkMutation({ surface: 'r', subject: caller('project', builder.project.id) }).code, 'CONTROL_HELD');
      for (const kind of ['unbound', 'invalid', 'operator-unverifiable']) {
        assert.equal(gate.checkMutation({ surface: 'r', subject: caller(kind) }).code, 'CONTROL_CALLER_UNATTRIBUTABLE', kind);
      }
    });
  });

  describe('store failure', () => {
    let orig;
    beforeEach(() => { orig = { ...store.control }; });
    afterEach(() => { Object.assign(store.control, orig); });

    it('refuses a subject known to be governed with 503, and lets one never seen governed through', () => {
      const governed = lane();
      const free = lane(false);
      gate.prime();
      store.control.getOpenForProject = () => { throw new Error('database is locked'); };
      store.control.getAssignment = () => { throw new Error('database is locked'); };
      store.control.anyRestricted = () => { throw new Error('database is locked'); };
      const r = gate.checkMutation({ surface: 'w', subject: { kind: 'target', projectId: governed.project.id } });
      assert.equal(r.status, 503);
      assert.equal(r.code, 'CONTROL_STATE_UNAVAILABLE');
      assert.equal(gate.checkMutation({ surface: 'w', subject: { kind: 'job', projectId: free.project.id, assignmentId: 'asg_captured' } }).code,
        'CONTROL_STATE_UNAVAILABLE', 'a job with a captured assignment is governed by definition');
      assert.equal(gate.checkMutation({ surface: 'w', subject: { kind: 'target', projectId: free.project.id } }), null);
      assert.equal(gate.checkMutation({ surface: 'w', subject: { kind: 'caller', caller: { kind: 'unbound' } } }).code, 'CONTROL_STATE_UNAVAILABLE');
      assert.equal(gate.checkMutation({ surface: 'w', subject: { kind: 'caller', caller: { kind: 'operator' } } }), null);
    });
  });

  describe('wrap commit step', () => {
    let projectPath;
    let project;
    let assignmentId;
    let calls;
    let originals;

    beforeEach(() => {
      originals = { ...commitStep._internal };
      ({ project, assignmentId } = lane());
      projectPath = project.path;
      initRepo(projectPath);
      execSync('git config user.email t@example.com && git config user.name Test', { cwd: projectPath, shell: '/bin/sh' });
      fs.writeFileSync(path.join(projectPath, 'work.txt'), 'v0\n');
      execSync('git add work.txt && git commit --quiet -m init && git branch -M main', { cwd: projectPath, shell: '/bin/sh' });
      fs.writeFileSync(path.join(projectPath, 'work.txt'), 'work\n');
      calls = [];
      const real = originals.exec;
      commitStep._internal.exec = async (file, args, opts) => {
        calls.push([file, ...args]);
        if (file === 'git' && args[0] === 'remote') return { exitCode: 0, stdout: 'https://github.com/example/sandbox.git\n', stderr: '' };
        if (file === 'git' && args[0] === 'push') return { exitCode: 0, stdout: '', stderr: '' };
        if (file === 'gh') {
          if (args[0] === '--version') return { exitCode: 0, stdout: 'gh version 2\n', stderr: '' };
          if (args[0] === 'pr' && args[1] === 'create') {
            // The HOLD arrives while the PR is being opened: the next
            // governed step must see it without anyone reading a notice.
            if (calls.holdDuringCreate) holdIt(assignmentId);
            return { exitCode: 0, stdout: 'https://github.com/example/sandbox/pull/7\n', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return real(file, args, opts);
      };
    });

    afterEach(() => Object.assign(commitStep._internal, originals));

    /** @returns {object} A commit-step context gated on this lane's assignment */
    function ctx() {
      const captured = gate.captureAssignment(project.id);
      return {
        project: { name: project.name, path: projectPath, id: project.id },
        session: null,
        step: { id: 'commit', kind: 'commit', blocker: true },
        previousResults: [],
        staged: {},
        options: {},
        scope: cleanLaunchScope(projectPath),
        controlGate: (surface) => gate.checkMutation({ surface, subject: { kind: 'job', projectId: project.id, assignmentId: captured } })
      };
    }

    const MUTATING = (c) => (c[0] === 'git' && ['add', 'commit', 'push', 'rm'].includes(c[1]))
      || (c[0] === 'git' && c[1] === 'checkout' && c[2] === '-b') || (c[0] === 'gh' && c[1] === 'pr');

    it('a HOLD stored before the commit step runs refuses it before any git mutation', async () => {
      const context = ctx();
      holdIt(assignmentId);
      const r = await commitStep.run(context);
      assert.equal(r.status, 'blocked');
      assert.equal(r.output.control.code, 'CONTROL_HELD');
      assert.deepEqual(calls.filter(MUTATING), []);
      assert.equal(execSync('git rev-list --count HEAD', { cwd: projectPath }).toString().trim(), '1', 'nothing committed');
      assert.equal(execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath }).toString().trim(), 'main', 'no wrap branch');
    });

    it('a HOLD that lands while the PR is being opened stops auto-merge arming; the partial outcome is reported', async () => {
      const context = ctx();
      calls.holdDuringCreate = true;
      const r = await commitStep.run(context);
      const autoPr = r.output.autoPr;
      assert.equal(autoPr.pushed, true);
      assert.ok(autoPr.prUrl);
      assert.equal(autoPr.autoMergeArmed, false);
      assert.equal(autoPr.controlRefusal.code, 'CONTROL_HELD');
      assert.match(autoPr.remediation, /auto-merge was NOT armed/);
      assert.ok(!calls.some((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'merge'), 'gh pr merge --auto never ran');
    });

    it('a HOLD before the push leaves the commit local and unpushed', async () => {
      const context = ctx();
      const real = commitStep._internal.exec;
      commitStep._internal.exec = async (file, args, opts) => {
        if (file === 'git' && args[0] === 'remote') holdIt(assignmentId);
        return real(file, args, opts);
      };
      const r = await commitStep.run(context);
      assert.equal(r.output.autoPr.pushed, false);
      assert.equal(r.output.autoPr.controlRefusal.code, 'CONTROL_HELD');
      assert.ok(!calls.some((c) => c[0] === 'git' && c[1] === 'push'));
    });
  });

  describe('pr-merge step and the stranded-wrap PR', () => {
    it('pr-merge refuses before pushing when the lane is held', async () => {
      const { project, assignmentId } = lane();
      holdIt(assignmentId);
      const orig = { ...prMerge._internal };
      const calls = [];
      prMerge._internal.exec = async (file, args) => { calls.push([file, ...args]); return { exitCode: 0, stdout: '', stderr: '' }; };
      prMerge._internal.enqueueAutoMerge = async () => { calls.push(['enqueue']); return { ok: true, reason: null }; };
      try {
        const context = {
          project: { name: project.name, path: project.path, id: project.id },
          staged: { prMergeGate: { resolutions: { 1: 'merge' }, sessionScoped: [] } },
          step: { id: 'pr-merge', kind: 'pr-merge' },
          controlGate: (surface) => gate.checkMutation({ surface, subject: { kind: 'job', projectId: project.id, assignmentId } })
        };
        const r = await prMerge.run(context);
        assert.equal(r.status, 'blocked');
        assert.equal(r.output.control.code, 'CONTROL_HELD');
        assert.deepEqual(calls, [], 'nothing pushed, nothing armed');
      } finally {
        Object.assign(prMerge._internal, orig);
      }
    });

    it('the stranded-wrap open-PR path refuses a held lane before gh pr create', async () => {
      const { project, assignmentId } = lane();
      holdIt(assignmentId);
      const item = { branch: 'wrap/20260925-x', headSha: 'abc123', remote: 'https://github.com/example/sandbox.git' };
      const origList = strandedWraps.list;
      const origExec = strandedCheck._internal.exec;
      const calls = [];
      strandedWraps.list = () => ({ items: [item] });
      strandedCheck._internal.exec = async (file, args) => {
        calls.push([file, ...args]);
        if (file === 'git' && args[0] === 'remote') return { exitCode: 0, stdout: `${item.remote}\n`, stderr: '' };
        if (file === 'git' && args[0] === 'ls-remote') return { exitCode: 0, stdout: `abc123\trefs/heads/${item.branch}\n`, stderr: '' };
        if (file === 'gh' && args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      try {
        const r = await strandedCheck.openPr(project, { confirm: true, branch: item.branch, headSha: 'abc123' }, null);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'CONTROL_HELD');
        assert.ok(!calls.some((c) => c[0] === 'gh' && c[2] === 'create'), 'no PR was created');
      } finally {
        strandedWraps.list = origList;
        strandedCheck._internal.exec = origExec;
      }
    });
  });
});
