'use strict';

// Fleet Coordinator / Decider self-service provisioning (#2937). Every test
// runs against its own fresh store, scratch `projectsDir`, and a real local
// git "origin" repo — the same per-test-store convention
// `test/fleet-provisioning.test.js` (#2825, a different module) already
// uses for `lib/fleet-provisioner.js`'s sibling.
//
// Two pieces the issue's "How" section proposed are deliberately absent from
// both the module and these tests, after verifying the real code rather
// than the issue text (see `lib/fleet-provisioner.js`'s module doc):
// binding `control_assignments` automatically, and authoring "TEAM COMMON
// CORE + ROLE OVERLAY" rule content. Neither is testable here because
// neither is built.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { initRepo: _tcInitRepo } = require('./_temp-repo');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

let tmpDir;
let projectsDir;
let upstreamDir;
let fp;

/** A git identity for every throwaway repo this file creates. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'tc-test', GIT_AUTHOR_EMAIL: 'tc-test@example.invalid',
  GIT_COMMITTER_NAME: 'tc-test', GIT_COMMITTER_EMAIL: 'tc-test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', HOME: undefined
};

/**
 * A real, non-bare local git repo with one commit — plain `git clone`
 * accepts a filesystem path directly, no `file://` needed.
 * @param {string} dir - Where to create it.
 * @returns {void}
 */
function _initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // `test/temp-repo.test.js` (#831) requires every `git init`/`clone` in
  // `test/` to go through this helper — a bare call inherits the running
  // machine's global git template dir, which TangleClaw itself rewrites
  // mid-suite.
  _tcInitRepo(dir, ['-b', 'main'], { env: GIT_ENV });
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  execFileSync('git', ['-C', dir, 'add', '.'], { env: GIT_ENV, stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', 'seed'], { env: GIT_ENV, stdio: 'pipe' });
}

/**
 * A registered PM project backed by a real git checkout whose `origin`
 * points at the shared upstream repo every test's clones come from.
 * @param {string} name - Must end `-PM` for a valid fleet prefix.
 * @returns {object} The created project row.
 */
function makePmProject(name) {
  const dir = path.join(tmpDir, name);
  _initRepo(dir);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', upstreamDir], { env: GIT_ENV, stdio: 'pipe' });
  return store.projects.create({ name, path: dir });
}

/** Make `project` a verified Fleet Coordinator: the flag on disk, the role in the DB. */
function makeCoordinator(project) {
  const config = store.projectConfig.load(project.path);
  store.projectConfig.save(project.path, { ...config, fleetCoordinator: true });
  store.coordinatorRoles.grant({
    roleId: `role_${project.id}`, projectId: project.id, role: 'project-manager', note: null, now: new Date().toISOString()
  });
}

/** An open control_assignment naming `project:<pmId>` in `lifecycle` — test fixture only, never through `lib/control-state.js`'s operator-only `create`. */
function makeBoundAssignment(projectId, pmId) {
  store.control.insertAssignment({
    assignment_id: `asg_test_${projectId}`,
    project_id: projectId,
    issue_ref: null,
    authority_json: JSON.stringify({ hold: [], stop: [], lifecycle: [`project:${pmId}`], releaseDelegations: {} }),
    bound_session_id: null,
    bound_launch_id: null,
    state: 'active',
    state_generation: 1,
    created_by_kind: 'operator'
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-provisioner-'));
  projectsDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  upstreamDir = path.join(tmpDir, 'upstream');
  _initRepo(upstreamDir);

  store._setBasePath(tmpDir);
  store.init();
  const config = store.config.load();
  config.projectsDir = projectsDir;
  store.config.save(config);

  delete require.cache[require.resolve('../lib/fleet-provisioner')];
  fp = require('../lib/fleet-provisioner');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('derivePrefix', () => {
  it('strips a trailing -PM', () => {
    assert.equal(fp.derivePrefix('Ariadne-PM'), 'Ariadne');
  });
  it('refuses a name not ending -PM', () => {
    assert.equal(fp.derivePrefix('Ariadne'), null);
    assert.equal(fp.derivePrefix('Ariadne-pm'), null); // case-sensitive
    assert.equal(fp.derivePrefix('-PM'), null); // empty prefix
  });
});

describe('isInFleetNamespace', () => {
  it('accepts <prefix>-<rest>', () => {
    assert.equal(fp.isInFleetNamespace('TC-Lane-A', 'TC'), true);
  });
  it('refuses the prefix alone, with no trailing segment', () => {
    assert.equal(fp.isInFleetNamespace('TC-', 'TC'), false);
    assert.equal(fp.isInFleetNamespace('TC', 'TC'), false);
  });
  it('refuses a different project that merely starts with the same letters', () => {
    assert.equal(fp.isInFleetNamespace('TCX-Lane-A', 'TC'), false);
  });
});

describe('verifyCoordinatorAuthority', () => {
  it('refuses an unknown project id', () => {
    assert.throws(() => fp.verifyCoordinatorAuthority(999999), { code: 'NOT_FOUND' });
  });

  it('refuses a project with fleetCoordinator not set', () => {
    const pm = makePmProject('Ariadne-PM');
    assert.throws(() => fp.verifyCoordinatorAuthority(pm.id), { code: 'NOT_FLEET_COORDINATOR' });
  });

  it('refuses fleetCoordinator:true with no active project-manager role', () => {
    const pm = makePmProject('Ariadne-PM');
    const config = store.projectConfig.load(pm.path);
    store.projectConfig.save(pm.path, { ...config, fleetCoordinator: true });
    assert.throws(() => fp.verifyCoordinatorAuthority(pm.id), { code: 'NO_COORDINATOR_ROLE' });
  });

  it('refuses a coordinator-ready project whose name does not end -PM', () => {
    const pm = makePmProject('Ariadne-PM');
    store.projects.update(pm.id, { name: 'Ariadne-Coordinator' });
    const moved = { ...pm, name: 'Ariadne-Coordinator' };
    makeCoordinator(moved);
    assert.throws(() => fp.verifyCoordinatorAuthority(pm.id), { code: 'BAD_PM_NAME' });
  });

  it('succeeds for a real Fleet Coordinator and derives its prefix', () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);
    const result = fp.verifyCoordinatorAuthority(pm.id);
    assert.equal(result.prefix, 'Ariadne');
    assert.equal(result.project.id, pm.id);
  });
});

describe('provisionFleet', () => {
  it('refuses a non-coordinator caller before touching the filesystem', async () => {
    const pm = makePmProject('Ariadne-PM');
    await assert.rejects(
      fp.provisionFleet(pm.id, [{ name: 'Ariadne-Arc' }]),
      { code: 'NOT_FLEET_COORDINATOR' }
    );
    assert.equal(fs.existsSync(path.join(projectsDir, 'Ariadne-Arc')), false);
  });

  it('refuses an empty or oversized members array', async () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);
    await assert.rejects(fp.provisionFleet(pm.id, []), { code: 'BAD_REQUEST' });
    await assert.rejects(fp.provisionFleet(pm.id, 'nope'), { code: 'BAD_REQUEST' });
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `Ariadne-M${i}` }));
    await assert.rejects(fp.provisionFleet(pm.id, nine), { code: 'BAD_REQUEST' });
  });

  it('refuses a member name outside the <prefix>-* namespace', async () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);
    await assert.rejects(fp.provisionFleet(pm.id, [{ name: 'Zig-Arc' }]), { code: 'OUT_OF_NAMESPACE' });
  });

  it('refuses a path-traversal name before any clone — zero directories created (PRR-A R-Gate HOLD d02ed20a)', async () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);
    const before = fs.readdirSync(projectsDir);
    for (const bad of [
      'Ariadne-../../../tmp/outside',
      'Ariadne-..',
      'Ariadne-a/b',
      'Ariadne-a\\b',
      'Ariadne- space',
      'Ariadne-.hidden'
    ]) {
      await assert.rejects(fp.provisionFleet(pm.id, [{ name: bad }]), { code: 'OUT_OF_NAMESPACE' }, bad);
    }
    assert.deepEqual(fs.readdirSync(projectsDir), before, 'no directory was created by any rejected name');
    assert.equal(fs.existsSync(path.join(tmpDir, 'tmp', 'outside')), false);
  });

  it('refuses an unrelated pre-existing project of the same name', async () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);
    const stray = path.join(tmpDir, 'stray-arc');
    fs.mkdirSync(stray, { recursive: true });
    store.projects.create({ name: 'Ariadne-Arc', path: stray });
    await assert.rejects(fp.provisionFleet(pm.id, [{ name: 'Ariadne-Arc' }]), { code: 'NAME_COLLISION' });
  });

  it('clones, registers and configures a new sibling from the PM\'s own origin', async () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);

    const result = await fp.provisionFleet(pm.id, [{ name: 'Ariadne-Arc', engine: 'claude' }]);

    assert.equal(result.provisioned.length, 1);
    assert.equal(result.provisioned[0].name, 'Ariadne-Arc');
    assert.equal(result.provisioned[0].created, true);
    const childId = result.provisioned[0].projectId;
    assert.deepEqual(result.pendingControlBinds, [{
      projectId: childId, projectName: 'Ariadne-Arc', issueRef: null,
      authority: {
        hold: [`project:${pm.id}`], stop: [`project:${pm.id}`], lifecycle: [`project:${pm.id}`], releaseDelegations: {}
      },
      status: 'operator_bind_required'
    }]);

    const child = store.projects.get(childId);
    assert.equal(child.name, 'Ariadne-Arc');
    assert.equal(child.engineId, 'claude');
    assert.ok(fs.existsSync(path.join(child.path, 'README.md')), 'the clone actually brought the upstream content');

    const childConfig = store.projectConfig.load(child.path);
    assert.equal(childConfig.medusaEnabled, true);
    assert.equal(childConfig.medusaWake, true);
    assert.equal(childConfig.defaultLaunchMode, 'bypassPermissions');
    assert.deepEqual(childConfig.workloadNudge, { enabled: true, coordinatorProject: 'Ariadne-PM' });
  });

  it('always seeds the ratified onboarding trust-rule floor on a new child, deduplicated by tag', async () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);
    const onboardingRules = require('../lib/project-onboarding-rules');
    const result = await fp.provisionFleet(pm.id, [{ name: 'Ariadne-Arc' }]);
    const rules = store.sessionRules.listActiveForProject(result.provisioned[0].projectId);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].content, onboardingRules.TRUST_RULE_TEMPLATE);
    assert.equal(rules[0].createdBy, 'system');

    // Re-running provisionFleet against the same (now-bound) child must not
    // duplicate the trust rule.
    makeBoundAssignment(result.provisioned[0].projectId, pm.id);
    await fp.provisionFleet(pm.id, [{ name: 'Ariadne-Arc' }]);
    assert.equal(store.sessionRules.listActiveForProject(result.provisioned[0].projectId).length, 1);
  });

  it('seeds caller-supplied common and per-member rule content as active, system-authored rules, alongside the trust floor', async () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);
    const result = await fp.provisionFleet(
      pm.id,
      [{ name: 'Ariadne-Arc', rules: 'Be the Architect.', roleOverlay: ['Review things.'] }],
      { commonRules: 'Team rule for everyone.' }
    );
    const rules = store.sessionRules.listActiveForProject(result.provisioned[0].projectId);
    const contents = rules.map((r) => r.content);
    assert.ok(contents.includes('Be the Architect.'));
    assert.ok(contents.includes('Review things.'));
    assert.ok(contents.includes('Team rule for everyone.'));
    assert.equal(rules.length, 4, 'trust floor + 3 caller-supplied rules');
    for (const r of rules) {
      assert.equal(r.createdBy, 'system');
      assert.equal(r.status, 'active');
    }
  });

  it('refuses a non-string/non-array rule field', async () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);
    await assert.rejects(
      fp.provisionFleet(pm.id, [{ name: 'Ariadne-Arc', rules: 42 }]),
      { code: 'BAD_REQUEST' }
    );
    await assert.rejects(
      fp.provisionFleet(pm.id, [{ name: 'Ariadne-Arc' }], { commonRules: [''] }),
      { code: 'BAD_REQUEST' }
    );
  });

  it('reuses an already-bound sibling idempotently, without re-cloning', async () => {
    const pm = makePmProject('Ariadne-PM');
    makeCoordinator(pm);
    const existingDir = path.join(tmpDir, 'already-provisioned');
    fs.mkdirSync(existingDir, { recursive: true });
    const existing = store.projects.create({ name: 'Ariadne-Arc', path: existingDir });
    makeBoundAssignment(existing.id, pm.id);

    const result = await fp.provisionFleet(pm.id, [{ name: 'Ariadne-Arc' }]);

    assert.equal(result.provisioned[0].created, false);
    assert.equal(result.provisioned[0].projectId, existing.id);
    assert.equal(fs.existsSync(path.join(existingDir, '.git')), false, 'reuse must never clone over the existing directory');
    const config = store.projectConfig.load(existingDir);
    assert.equal(config.medusaEnabled, true, 'reuse still merges this fleet\'s config');
    // PRR-A R-Gate HOLD `d02ed20a`: an already-bound reuse must not also be
    // reported as still needing a bind.
    assert.deepEqual(result.pendingControlBinds, []);
  });

  it('refuses when the PM\'s own checkout has no origin remote', async () => {
    const dir = path.join(tmpDir, 'Lonely-PM');
    _initRepo(dir);
    const pm = store.projects.create({ name: 'Lonely-PM', path: dir });
    makeCoordinator(pm);
    await assert.rejects(fp.provisionFleet(pm.id, [{ name: 'Lonely-Arc' }]), { code: 'NO_ORIGIN' });
  });
});

describe('POST /api/tc/fleet/coordinator — coordinatorRule validation (PRR-A R-Gate Round 3, PM Round 3 dispatch)', () => {
  // No shared `before`/`after` here: the FILE-level `beforeEach`/`afterEach`
  // swap in a brand new store before every single `it()`, including ones in
  // this nested describe, and a nested `before()` runs once, before any of
  // that — a server (and the signed-in session it produced) created there
  // would end up bound to a store that gets replaced out from under it
  // before the first real test runs. Building the server and signing in
  // fresh inside each test is slower per test but the only ordering that is
  // actually correct here.
  async function _liveSignedInOperator() {
    // This route's `signedInOperator` gate requires a real `req.tcSession`,
    // which the dispatcher only ever resolves when the auth gate does NOT
    // stand down (server.js: `if (!authGate.standsDown(gateState))`) — an
    // open-gate install (this scratch store's default) never resolves one
    // at all, so `operatorHeaders` alone (what this file's other describe
    // blocks use, against routes with a looser gate) is not enough here.
    // `signInOperator` only creates an account when the gate already reads
    // `account-required`; a fresh store starts `open` instead (verified by
    // running it standalone first), so `authEnabled` has to be armed by
    // hand first — the same precondition `test/api-config.test.js`'s own
    // `signInOperator` callers set up before calling it.
    const config = store.config.load();
    config.authEnabled = true;
    store.config.save(config);

    const { createServer } = require('../server');
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { signInOperator } = require('./_shared-docs-callers');
    const headers = await signInOperator(server);
    return { server, headers };
  }

  it('refuses a whitespace-only or non-string coordinatorRule with 400 and makes no mutation at all', async () => {
    const { server, headers } = await _liveSignedInOperator();
    try {
      const { sendAs } = require('./_shared-docs-callers');
      const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-coord-route-'));
      const project = store.projects.create({ name: 'RouteCheck-PM', path: projDir });

      for (const bad of ['   ', '\n\t', 123, {}]) {
        const res = await sendAs(server, 'POST', '/api/tc/fleet/coordinator',
          { projectId: project.id, enabled: true, coordinatorRule: bad }, headers);
        assert.equal(res.status, 400, `coordinatorRule ${JSON.stringify(bad)} must be refused`);

        // No partial mutation: not the config flag, not the role, not a rule row.
        const config = store.projectConfig.load(project.path);
        assert.equal(config.fleetCoordinator, false, 'fleetCoordinator must not have been flipped on (the default, unset value)');
        assert.equal(store.coordinatorRoles.getActiveForProject(project.id), null, 'no role must have been granted');
        assert.deepEqual(store.sessionRules.listActiveForProject(project.id), [], 'no rule must have been created');
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('accepts a real coordinatorRule, trimmed, and completes the grant', async () => {
    const { server, headers } = await _liveSignedInOperator();
    try {
      const { sendAs } = require('./_shared-docs-callers');
      const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-coord-route-ok-'));
      const project = store.projects.create({ name: 'RouteCheckOk-PM', path: projDir });

      const res = await sendAs(server, 'POST', '/api/tc/fleet/coordinator',
        { projectId: project.id, enabled: true, coordinatorRule: '  Be excellent.  ' }, headers);
      assert.equal(res.status, 200);
      const rules = store.sessionRules.listActiveForProject(project.id);
      assert.equal(rules.length, 1);
      assert.equal(rules[0].content, 'Be excellent.', 'stored trimmed, not padded');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
