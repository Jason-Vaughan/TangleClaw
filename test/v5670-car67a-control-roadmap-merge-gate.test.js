'use strict';

// Car 67-A (v5.67.0, Architect Ruling A504-W1A-R2): the Slice 2 wiring for
// #2866, #2877 and #2878. Each underlying library (lib/merge-role-guard.js,
// lib/roadmap-admission.js, lib/roadmap-sync.js, lib/merge-inbox-gate.js)
// already has its own test file proving its own logic; this file covers the
// NEW wiring only:
//   #2866 — the new createRoleGuardWrapperScripts/recordBlockedAttempt
//     exports on lib/merge-role-guard.js, and lib/sessions.js's
//     _mergeRoleGuardWrapperDir/_withPathFloor wiring that puts the
//     generated `gh` wrapper on every launched pane's PATH.
//   #2877 — the `tc roadmap` verb (lib/tc-verbs.js), a thin local mount of
//     scripts/roadmap-sync-check.js.
//   #2878 — the `tc merge-gate` verb and the
//     /api/sessions/:project/merge-gate/* routes (lib/routes/sessions.js),
//     both over lib/tc-docs-scorecard-merge-wiring.js's mergeGate* adapters.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const sessions = require('../lib/sessions');
const mergeRoleGuard = require('../lib/merge-role-guard');
const { VERB_ROSTER } = require('../lib/tc-verbs');
const { createServer } = require('../server');
const { bindProject, sendAs, operatorOf, operatorHeaders } = require('./_shared-docs-callers');

const roadmapVerb = VERB_ROSTER.find((v) => v.id === 'roadmap');
const mergeGateVerb = VERB_ROSTER.find((v) => v.id === 'merge-gate');

/**
 * Whether `gh` is actually installed on this host -- same convention
 * `test/engine-launch-flags.test.js#resolveBinary` uses. Only the ONE test
 * below that needs the wrapper's pass-through to reach a REAL `gh` needs
 * this; every refusal-path test returns before the wrapper ever execs it.
 * @returns {boolean}
 */
function _ghAvailable() {
  try {
    return Boolean(require('node:child_process').execFileSync('which', ['gh'], { encoding: 'utf8', timeout: 5000 }).trim());
  } catch {
    return false;
  }
}

describe('#2866: lib/merge-role-guard.js#createRoleGuardWrapperScripts + recordBlockedAttempt', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-guard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a syntactically valid, executable gh wrapper script', () => {
    const r = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    assert.equal(r.dir, tmpDir);
    assert.equal(r.file, path.join(tmpDir, 'gh'));
    assert.ok(fs.existsSync(r.file));
    const mode = fs.statSync(r.file).mode & 0o777;
    assert.equal(mode, 0o755);
    // The generated script must itself be valid JS -- a template-escaping
    // bug here is exactly how #2866 shipped a real fork bomb during this
    // car's own development (see the module's own comment on the realpath
    // fix); this is the regression that catches a repeat.
    assert.doesNotThrow(() => new (require('node:vm').Script)(fs.readFileSync(r.file, 'utf8')));
  });

  it('requires the EXACT file that generated it, never a relative or guessed path', () => {
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'gh'), 'utf8');
    assert.ok(content.includes(JSON.stringify(require.resolve('../lib/merge-role-guard.js'))));
  });

  it('is idempotent and safe to call repeatedly (as every session launch does)', () => {
    const a = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const b = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    assert.deepEqual(a, b);
  });

  it('creates the target directory if missing', () => {
    const nested = path.join(tmpDir, 'nested', 'deeper');
    mergeRoleGuard.createRoleGuardWrapperScripts(nested);
    assert.ok(fs.existsSync(path.join(nested, 'gh')));
  });

  it('runs correctly end-to-end: passes through a non-merge command', (t) => {
    if (!_ghAvailable()) {
      t.skip('gh not installed on this host');
      return;
    }
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const out = require('node:child_process').execFileSync(
      process.execPath, [path.join(tmpDir, 'gh'), '--version'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` } }
    );
    assert.match(out, /gh version/);
  });

  it('runs correctly end-to-end: refuses a PR merge when no tmux session can be resolved (fails closed, never open)', () => {
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const { execFileSync } = require('node:child_process');
    const env = { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` };
    delete env.TMUX; // outside any tmux pane -- lane is unresolvable
    assert.throws(
      () => execFileSync(process.execPath, [path.join(tmpDir, 'gh'), 'pr', 'merge', '123', '--squash'], { encoding: 'utf8', env }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /MERGE_ROLE_FORBIDDEN/);
        return true;
      }
    );
  });

  // A real-tmux-session variant (asserting a SPECIFIC "TC-Lane-X" session
  // name maps to the builder role) was deliberately not added here: this
  // repo's own test/_tmux-session-names.js convention requires every real
  // tmux session a test creates to come from uniqueSessionName (collision-
  // proof, randomized names) -- which is fundamentally incompatible with
  // needing one exact recognizable lane name. The lane-name -> role mapping
  // itself is already covered directly by test/merge-role-guard.test.js;
  // the no-tmux-available case above already proves the WRAPPER's own
  // fail-closed integration. Verified manually instead (see the PR body):
  // a real "TC-Lane-D" tmux session running the generated wrapper refuses
  // `gh pr merge` with MERGE_ROLE_FORBIDDEN, naming that exact lane.

  it('recordBlockedAttempt appends one JSON line per call and never throws on a bad target', () => {
    const file = path.join(tmpDir, 'nested', 'audit.jsonl');
    const ok = mergeRoleGuard.recordBlockedAttempt(file, {
      commandText: 'gh pr merge 1 --squash', lane: 'TC-Lane-D', code: 'MERGE_ROLE_FORBIDDEN', message: 'nope'
    });
    assert.equal(ok, true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.lane, 'TC-Lane-D');
    assert.equal(parsed.code, 'MERGE_ROLE_FORBIDDEN');
    assert.ok(parsed.at);

    mergeRoleGuard.recordBlockedAttempt(file, { commandText: 'x', code: 'Y', message: 'z' });
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);

    // A target that cannot possibly be created (a file component in the
    // middle of the path) must degrade to false, never throw -- an audit
    // write is advisory, per the function's own doc.
    const impossible = path.join(file, 'cannot-have-children-under-a-file');
    assert.equal(mergeRoleGuard.recordBlockedAttempt(impossible, { commandText: 'x', code: 'Y', message: 'z' }), false);
  });
});

describe('#2866: lib/sessions.js wiring — the gh wrapper reaches every launched pane\'s PATH', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-sessions-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('_withPathFloor itself is completely unchanged by #2866 -- its exact output shape is pinned by test/tc-cli.test.js\'s own #1140 regression coverage', () => {
    const binDir = path.join(__dirname, '..', 'bin');
    assert.equal(sessions._withPathFloor('echo hi'), `export PATH="${binDir}:$PATH"; echo hi`);
    assert.equal(sessions._withPathFloor('echo hi', '/fake/bin'), 'export PATH="/fake/bin:$PATH"; echo hi');
  });

  it('_withMergeGuardFloor combines both dirs into ONE export, never two stacked ones', () => {
    const wrapped = sessions._withMergeGuardFloor('echo hi');
    const guardDir = path.join(store._getBasePath(), 'merge-role-guard-wrapper');
    const binDir = path.join(__dirname, '..', 'bin');
    // ONE `export PATH=...; ` prefix, not two: lib/recorded-launch-command.js's
    // #_withoutPathFloor deliberately strips only a single such prefix
    // (test/recorded-launch-command.test.js's own #2228 regression coverage
    // for exactly this), so the two directories ride together in the one
    // combined floor _withPathFloor's own binDirOverride seam already
    // accepts a `:`-joined string for.
    assert.equal(wrapped, `export PATH="${binDir}:${guardDir}:$PATH"; echo hi`);
    assert.ok(fs.existsSync(path.join(guardDir, 'gh')), 'the wrapper script must actually have been written as a side effect');
  });

  it('_withMergeGuardFloor returns the input unchanged for an empty/undefined command', () => {
    assert.equal(sessions._withMergeGuardFloor(undefined), undefined);
    assert.equal(sessions._withMergeGuardFloor(''), '');
  });
});

describe('#2877: tc roadmap verb (lib/tc-verbs.js)', () => {
  it('is registered on the verb roster', () => {
    assert.ok(roadmapVerb);
    assert.equal(typeof roadmapVerb.run, 'function');
  });

  it('refuses an unknown subverb without spawning anything', async () => {
    const r = await roadmapVerb.run({ argv: ['bogus'] });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /needs a subverb/);
  });

  it('admission: runs the real script end-to-end and surfaces an executable classification', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-roadmap-'));
    try {
      const candidateFile = path.join(tmpDir, 'candidate.json');
      const factsFile = path.join(tmpDir, 'facts.json');
      fs.writeFileSync(candidateFile, JSON.stringify({ trainId: 'train:car67a-test', issues: ['#2866'] }));
      fs.writeFileSync(factsFile, JSON.stringify({ issues: { '#2866': { state: 'open' } }, conflicts: [] }));
      const r = await roadmapVerb.run({ argv: ['admission', '--candidate', candidateFile, '--facts', factsFile] });
      assert.equal(r.code, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.classification, 'executable');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('admission: a hard-open prerequisite blocks, surfaced through the verb unchanged from the script', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-roadmap-'));
    try {
      const candidateFile = path.join(tmpDir, 'candidate.json');
      const factsFile = path.join(tmpDir, 'facts.json');
      fs.writeFileSync(candidateFile, JSON.stringify({ trainId: 'train:car67a-test-2', issues: ['#2877'], prereqs: ['#1'] }));
      fs.writeFileSync(factsFile, JSON.stringify({ issues: { '#1': { state: 'open' }, '#2877': { state: 'open' } } }));
      const r = await roadmapVerb.run({ argv: ['admission', '--candidate', candidateFile, '--facts', factsFile] });
      assert.equal(r.code, 0);
      assert.equal(JSON.parse(r.stdout).classification, 'blocked');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('admission: missing required files refuses with exit 1 before spawning', async () => {
    const r = await roadmapVerb.run({ argv: ['admission', '--candidate', '/nonexistent/x.json'] });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--candidate and --facts are required/);
  });

  it('uses the injected ctx.execFile seam rather than always spawning a real process', async () => {
    let seenArgs = null;
    const r = await roadmapVerb.run({
      argv: ['sync', '--state', '/tmp/x.json', '--issues', '1,2'],
      execFile: (cmd, args) => { seenArgs = args; return 'STUBBED\n'; }
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'STUBBED\n');
    assert.ok(seenArgs.includes('sync'));
    assert.ok(seenArgs.includes('--state'));
  });

  it('propagates the script\'s own exit code and stderr on failure', async () => {
    const r = await roadmapVerb.run({
      argv: ['sync', '--state', '/tmp/x.json', '--issues', '1'],
      execFile: () => { const err = new Error('boom'); err.status = 2; err.stderr = 'script refused\n'; throw err; }
    });
    assert.equal(r.code, 2);
    assert.equal(r.stderr, 'script refused\n');
  });
});

describe('#2878: tc merge-gate verb (lib/tc-verbs.js)', () => {
  it('is registered on the verb roster', () => {
    assert.ok(mergeGateVerb);
    assert.equal(typeof mergeGateVerb.run, 'function');
  });

  it('refuses an unknown subverb', async () => {
    const r = await mergeGateVerb.run({ argv: ['bogus'] });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /needs a subverb/);
  });

  it('refuses a missing project before making any HTTP call', async () => {
    let called = false;
    const r = await mergeGateVerb.run({ argv: ['list'], getJson: () => { called = true; } });
    assert.equal(r.code, 1);
    assert.equal(called, false);
  });

  it('hold: posts the right body to the right path and reports the new hold', async () => {
    let seenPath = null;
    let seenBody = null;
    const r = await mergeGateVerb.run({
      argv: ['hold', 'my-project', '--repo', 'org/repo', '--reason', 'investigating', '--issued-by', 'TC-Lane-Arc', '--pr', '42'],
      postJson: async (p, body) => { seenPath = p; seenBody = body; return { hold: { holdId: 'hold_1', sequence: 3 } }; }
    });
    assert.equal(r.code, 0);
    assert.equal(seenPath, '/api/sessions/my-project/merge-gate/holds');
    assert.deepEqual(seenBody, {
      repo: 'org/repo', pr: '42', branch: undefined, issue: undefined, reason: 'investigating', issuedBy: 'TC-Lane-Arc', supersedes: undefined
    });
    assert.match(r.stdout, /hold_1/);
  });

  it('list: renders "No holds recorded." when the server returns an empty list', async () => {
    const r = await mergeGateVerb.run({
      argv: ['list', 'my-project'],
      getJson: async () => ({ holds: [] })
    });
    assert.equal(r.stdout, 'No holds recorded.\n');
  });

  it('evaluate: exits 2 (not 0) when the server reports allowed:false', async () => {
    const r = await mergeGateVerb.run({
      argv: ['evaluate', 'my-project', '--repo', 'org/repo', '--pr', '7'],
      getJson: async () => ({ allowed: false, status: 'hold-active', holds: [{ holdId: 'h1' }] })
    });
    assert.equal(r.code, 2);
  });

  it('a server refusal (err.body.code) is reported as a stable, parseable refusal, not an uncaught throw', async () => {
    const r = await mergeGateVerb.run({
      argv: ['ack', 'my-project', 'hold_x', '--by', 'someone'],
      postJson: async () => { const err = new Error('refused'); err.body = { code: 'HOLD_NOT_FOUND', error: 'no such hold' }; throw err; }
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /HOLD_NOT_FOUND/);
  });
});

describe('#2878: /api/sessions/:project/merge-gate/* routes (lib/routes/sessions.js)', () => {
  let tmpDir;
  let server;
  let project;
  let binding;
  let writeHeaders;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-merge-gate-'));
    store._setBasePath(tmpDir);
    store.init();

    const dir = path.join(tmpDir, 'proj-dir');
    fs.mkdirSync(dir, { recursive: true });
    project = store.projects.create({ name: 'merge-gate-route-project', path: dir, engine: 'claude' });
    binding = bindProject(project);

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    writeHeaders = await operatorOf(server)();
    const me = await sendAs(server, 'GET', '/api/auth/me', undefined, operatorHeaders(server));
    if (me.data && me.data.openInstallToken) writeHeaders = { ...writeHeaders, 'x-tc-open-token': me.data.openInstallToken };
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const base = () => `/api/sessions/${encodeURIComponent(project.name)}/merge-gate`;

  function issueHold(overrides = {}) {
    return sendAs(server, 'POST', `${base()}/holds`, {
      repo: 'org/repo', reason: 'testing', issuedBy: 'test-suite', ...overrides
    }, writeHeaders);
  }

  it('404s for an unknown project', async () => {
    const r = await sendAs(server, 'GET', '/api/sessions/does-not-exist/merge-gate/holds', undefined, writeHeaders);
    assert.equal(r.status, 404);
  });

  it('the project\'s own verified launch may issue a hold', async () => {
    const r = await sendAs(server, 'POST', `${base()}/holds`, {
      repo: 'org/repo', pr: '9', reason: 'reviewing', issuedBy: 'test-suite'
    }, binding.headers);
    assert.equal(r.status, 200);
    assert.ok(r.data.hold.holdId);
    assert.equal(r.data.hold.status, 'active');
  });

  it('a read with no verified access at all is refused', async () => {
    const r = await sendAs(server, 'GET', `${base()}/holds`, undefined, {});
    assert.ok([401, 403].includes(r.status));
  });

  it('issue -> list -> show -> ack round trip, through the real HTTP routes', async () => {
    const issued = await issueHold({ pr: '101' });
    assert.equal(issued.status, 200);
    const holdId = issued.data.hold.holdId;

    const listed = await sendAs(server, 'GET', `${base()}/holds?repo=org/repo`, undefined, writeHeaders);
    assert.equal(listed.status, 200);
    assert.ok(listed.data.holds.some((h) => h.holdId === holdId));

    const shown = await sendAs(server, 'GET', `${base()}/holds/${holdId}`, undefined, writeHeaders);
    assert.equal(shown.status, 200);
    assert.equal(shown.data.hold.holdId, holdId);

    const acked = await sendAs(server, 'POST', `${base()}/holds/${holdId}/ack`, { by: 'test-suite' }, writeHeaders);
    assert.equal(acked.status, 200);
    assert.equal(acked.data.hold.status, 'acknowledged');
  });

  it('showing an unknown hold id 404s with HOLD_NOT_FOUND', async () => {
    const r = await sendAs(server, 'GET', `${base()}/holds/does-not-exist`, undefined, writeHeaders);
    assert.equal(r.status, 404);
    assert.equal(r.data.code, 'HOLD_NOT_FOUND');
  });

  it('evaluate reflects an active hold as not allowed, and clears once acknowledged', async () => {
    const issued = await issueHold({ pr: '202' });
    const holdId = issued.data.hold.holdId;

    const blocked = await sendAs(server, 'GET', `${base()}/evaluate?repo=org/repo&pr=202`, undefined, writeHeaders);
    assert.equal(blocked.status, 200);
    assert.equal(blocked.data.allowed, false);

    await sendAs(server, 'POST', `${base()}/holds/${holdId}/ack`, { by: 'test-suite' }, writeHeaders);

    const clear = await sendAs(server, 'GET', `${base()}/evaluate?repo=org/repo&pr=202`, undefined, writeHeaders);
    assert.equal(clear.status, 200);
    assert.equal(clear.data.allowed, true);
  });

  it('override scopes the release to one action only — a different action is still blocked', async () => {
    const issued = await issueHold({ pr: '303' });
    const holdId = issued.data.hold.holdId;

    const overridden = await sendAs(server, 'POST', `${base()}/holds/${holdId}/override`, {
      by: 'test-suite', reason: 'manual review done', action: 'merge'
    }, writeHeaders);
    assert.equal(overridden.status, 200);

    const mergeGate = await sendAs(server, 'GET', `${base()}/evaluate?repo=org/repo&pr=303`, undefined, writeHeaders);
    assert.equal(mergeGate.data.allowed, true);

    const autoMergeGate = await sendAs(server, 'GET', `${base()}/evaluate?repo=org/repo&pr=303&autoMerge=true`, undefined, writeHeaders);
    assert.equal(autoMergeGate.data.allowed, false, 'the override named "merge" only, not "auto-merge"');
  });

  it('publish-status is inert without enabled:true, and reports why', async () => {
    const r = await sendAs(server, 'POST', `${base()}/publish-status`, {
      repo: 'org/repo', pr: '404', sha: 'abc123'
    }, writeHeaders);
    assert.equal(r.status, 200);
    assert.equal(r.data.published, false);
    assert.equal(r.data.reason, 'disabled');
  });

  it('a project launch bound to a DIFFERENT project may still issue a hold (authority travels across lanes, #1717)', async () => {
    const otherDir = path.join(tmpDir, 'other-proj-dir');
    fs.mkdirSync(otherDir, { recursive: true });
    const otherProject = store.projects.create({ name: 'other-merge-gate-project', path: otherDir, engine: 'claude' });
    const otherBinding = bindProject(otherProject);
    const r = await sendAs(server, 'POST', `${base()}/holds`, {
      repo: 'org/repo', pr: '505', reason: 'cross-lane hold', issuedBy: 'other-lane'
    }, otherBinding.headers);
    assert.equal(r.status, 200);
  });
});
