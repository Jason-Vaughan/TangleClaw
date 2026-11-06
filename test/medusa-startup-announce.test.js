'use strict';

/**
 * `lib/medusa-startup-announce.js` (#1732): once a session's launch
 * sequence has attested READY and it has an active Medusa presence, send
 * one switchboard message announcing it is online — exactly once per
 * launch sequence, regardless of which of the two real call sites
 * (`lib/launch-sequence.js#ready`, `lib/sessions.js#_maybeAutoStartMedusa`)
 * observes both conditions first.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const announce = require('../lib/medusa-startup-announce');
const launchSequence = require('../lib/launch-sequence');
const store = require('../lib/store');
const medusa = require('../lib/medusa');
const medusaRegistry = require('../lib/medusa-registry');
const primerLaunchWiring = require('../lib/primer-launch-wiring');
const projectConfigModule = require('../lib/project-config');

beforeEach(() => {
  announce._resetAnnouncedForTesting();
});

describe('medusa-startup-announce: announceDisabled', () => {
  it('exports the exact env var name the escape hatch reads', () => {
    assert.equal(announce.ANNOUNCE_ENV_VAR, 'TANGLECLAW_STARTUP_ANNOUNCE_DISABLED');
  });

  it('is false with no project config and no env override', () => {
    assert.equal(announce.announceDisabled(null, { env: {} }), false);
  });

  it('is true when the project config opts out', () => {
    assert.equal(announce.announceDisabled({ startupAnnounceDisabled: true }, { env: {} }), true);
  });

  it('is true when the env var is set to "true" or "1", regardless of project config', () => {
    assert.equal(announce.announceDisabled({}, { env: { [announce.ANNOUNCE_ENV_VAR]: 'true' } }), true);
    assert.equal(announce.announceDisabled({}, { env: { [announce.ANNOUNCE_ENV_VAR]: '1' } }), true);
  });

  it('ignores an unrecognized env value', () => {
    assert.equal(announce.announceDisabled({}, { env: { TANGLECLAW_STARTUP_ANNOUNCE_DISABLED: 'nope' } }), false);
  });
});

describe('medusa-startup-announce: buildStartupAnnouncement', () => {
  it('renders the exact shape #1732 specifies', () => {
    const text = announce.buildStartupAnnouncement({
      sessionName: 'TC-Lane-B', role: 'worker', sessionId: 1555, workspaceId: 'tc-lane-b-bf9cd917'
    });
    assert.equal(text, '[Startup] TC-Lane-B (worker) online — session #1555, workspace tc-lane-b-bf9cd917, ready for switchboard work.');
  });
});

describe('medusa-startup-announce: markAnnounced / hasAnnounced', () => {
  it('hasAnnounced reads back exactly what markAnnounced recorded, independent of maybeAnnounceStartup', () => {
    assert.equal(announce.hasAnnounced(777), false);
    announce.markAnnounced(777);
    assert.equal(announce.hasAnnounced(777), true);
    assert.equal(announce.hasAnnounced(778), false, 'marking one sequence id must not mark another');
  });
});

// I-Gate Round 1 (#5798277310) on #1732: TangleClaw admits at most one
// active session per store.projects row (lib/sessions.js's own guard), and
// each fleet coordinator (TC-Lane-PM, TC-Lane-Arc) is its own project row,
// never a second session of the lane it coordinates. So the real audience
// is CROSS-PROJECT -- every OTHER project holding an active coordinator
// grant, each contributing its own active session's workspace id -- never
// same-project (a same-project query always excludes the only session a
// project ever has: itself). These fixtures model exactly that invariant:
// one project per entry in `projects`, at most one "active session" each.
describe('medusa-startup-announce: resolveProjectRecipients (cross-project, #5798277310)', () => {
  const PROJECTS = [
    { id: 1, path: '/tmp/builder' }, // the announcing project -- excluded regardless of role
    { id: 2, path: '/tmp/pm' }, // holds an active project-manager grant
    { id: 3, path: '/tmp/arch' }, // holds an active architect grant
    { id: 4, path: '/tmp/plain' } // no coordinator grant at all
  ];
  const ROLE_BY_PROJECT = { 1: null, 2: { role: 'project-manager' }, 3: { role: 'architect' }, 4: null };
  const SESSION_BY_PROJECT = { 1: { id: 10 }, 2: { id: 20 }, 3: { id: 30 }, 4: { id: 40 } };
  const WORKSPACE_BY_SESSION = { 10: 'ws-builder', 20: 'ws-pm', 30: 'ws-arch', 40: 'ws-plain' };

  const deps = () => ({
    listProjects: () => PROJECTS,
    getActiveRoleForProject: (pid) => ROLE_BY_PROJECT[pid] || null,
    getActiveSessionForProject: (pid) => SESSION_BY_PROJECT[pid] || null,
    getWorkspaceId: (_path, sessionId) => WORKSPACE_BY_SESSION[sessionId] || null
  });

  it('resolves every OTHER project holding an active coordinator grant, never the announcing project or a non-coordinator', () => {
    const recipients = announce.resolveProjectRecipients(1, 10, deps());
    assert.deepEqual(recipients.sort(), ['ws-arch', 'ws-pm']);
  });

  it('excludes a coordinator project with no active session for its grant', () => {
    const d = deps();
    d.getActiveSessionForProject = (pid) => (pid === 2 ? null : SESSION_BY_PROJECT[pid]);
    const recipients = announce.resolveProjectRecipients(1, 10, d);
    assert.deepEqual(recipients, ['ws-arch']);
  });

  it('skips a coordinator project whose active session has no resolvable workspace id', () => {
    const d = deps();
    d.getWorkspaceId = (_path, sessionId) => (sessionId === 30 ? null : WORKSPACE_BY_SESSION[sessionId]);
    const recipients = announce.resolveProjectRecipients(1, 10, d);
    assert.deepEqual(recipients, ['ws-pm']);
  });

  it('returns an empty list when no OTHER project holds an active coordinator grant', () => {
    const d = deps();
    d.getActiveRoleForProject = () => null;
    assert.deepEqual(announce.resolveProjectRecipients(1, 10, d), []);
  });

  it('uses the real store by default when no deps are injected (smoke only -- a bare require touches no DB)', () => {
    assert.equal(typeof announce.resolveProjectRecipients, 'function');
  });

  // I-Gate Round 2 (#5798507488): a pre-filter slice(0, MAX_PROJECT_SESSIONS)
  // on the RAW project list, applied before filtering by active coordinator
  // role, silently drops a real coordinator sitting past the cap in
  // project-id order -- 100 plain (non-coordinator) projects followed by one
  // genuine PM at project id 101 used to resolve to [] (`no-recipients`)
  // even though that PM is live and opted in. The cap must apply to the
  // RESOLVED recipient list, never the input project list.
  it('resolves a coordinator sitting past the first 100 projects in list order (#5798507488)', () => {
    const manyProjects = [{ id: 0, path: '/tmp/builder' }];
    const manyRoles = { 0: null };
    const manySessions = { 0: { id: 10 } };
    const manyWorkspaces = { 10: 'ws-builder' };
    for (let i = 1; i <= 100; i++) {
      manyProjects.push({ id: i, path: `/tmp/plain-${i}` });
      manyRoles[i] = null;
    }
    manyProjects.push({ id: 101, path: '/tmp/pm' });
    manyRoles[101] = { role: 'project-manager' };
    manySessions[101] = { id: 2101 };
    manyWorkspaces[2101] = 'ws-pm-101';

    const d = {
      listProjects: () => manyProjects,
      getActiveRoleForProject: (pid) => manyRoles[pid] || null,
      getActiveSessionForProject: (pid) => manySessions[pid] || null,
      getWorkspaceId: (_path, sessionId) => manyWorkspaces[sessionId] || null
    };
    const recipients = announce.resolveProjectRecipients(0, 10, d);
    assert.deepEqual(recipients, ['ws-pm-101']);
  });
});

describe('medusa-startup-announce: maybeAnnounceStartup', () => {
  const baseInput = () => ({
    sequenceId: 42, sessionId: 1555, sessionName: 'TC-Lane-B', role: 'worker',
    workspaceId: 'tc-lane-b-bf9cd917', isReady: true, isListening: true, projConfig: null
  });

  it('sends to every resolved recipient and reports sent:true', async () => {
    const sent = [];
    const result = await announce.maybeAnnounceStartup(baseInput(), {
      resolveRecipients: () => ['ws-a', 'ws-b'],
      sendSystemMessage: async ({ to, message }) => { sent.push({ to, message }); }
    });
    assert.equal(result.sent, true);
    assert.equal(result.reason, null);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((s) => s.to), ['ws-a', 'ws-b']);
    assert.match(sent[0].message, /\[Startup\] TC-Lane-B \(worker\) online/);
  });

  it('is idempotent per sequenceId -- a second call sends nothing more', async () => {
    const sent = [];
    const deps = {
      resolveRecipients: () => ['ws-a'],
      sendSystemMessage: async ({ to }) => { sent.push(to); }
    };
    const first = await announce.maybeAnnounceStartup(baseInput(), deps);
    const second = await announce.maybeAnnounceStartup(baseInput(), deps);
    assert.equal(first.sent, true);
    assert.equal(second.sent, false);
    assert.equal(second.reason, 'already-announced');
    assert.equal(sent.length, 1);
  });

  it('does not send when disabled, and does not consume the idempotency slot either', async () => {
    const deps = { resolveRecipients: () => ['ws-a'], sendSystemMessage: async () => {} };
    const disabledResult = await announce.maybeAnnounceStartup(
      { ...baseInput(), projConfig: { startupAnnounceDisabled: true } }, deps
    );
    assert.equal(disabledResult.sent, false);
    assert.equal(disabledResult.reason, 'disabled');
    assert.equal(announce.hasAnnounced(42), false, 'a disabled check must not block a later enabled attempt');
  });

  it('does not send when not both isReady and isListening are true', async () => {
    const deps = { resolveRecipients: () => ['ws-a'], sendSystemMessage: async () => {} };
    const notReady = await announce.maybeAnnounceStartup({ ...baseInput(), isReady: false }, deps);
    assert.equal(notReady.sent, false);
    assert.equal(notReady.reason, 'not-both-conditions');
    const notListening = await announce.maybeAnnounceStartup({ ...baseInput(), sequenceId: 43, isListening: false }, deps);
    assert.equal(notListening.sent, false);
    assert.equal(notListening.reason, 'not-both-conditions');
  });

  it('marks the sequence announced (no retry) when there are no recipients at all', async () => {
    const result = await announce.maybeAnnounceStartup(baseInput(), { resolveRecipients: () => [], sendSystemMessage: async () => {} });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'no-recipients');
    assert.equal(announce.hasAnnounced(42), true);
  });

  it('tolerates one recipient failing to send while still reporting the others sent', async () => {
    const sent = [];
    const result = await announce.maybeAnnounceStartup(baseInput(), {
      resolveRecipients: () => ['ws-fails', 'ws-ok'],
      sendSystemMessage: async ({ to }) => {
        if (to === 'ws-fails') throw new Error('bridge unreachable');
        sent.push(to);
      }
    });
    assert.equal(result.sent, true);
    assert.deepEqual(sent, ['ws-ok']);
  });

  it('reports sent:false with reason send-failed when every recipient fails', async () => {
    const result = await announce.maybeAnnounceStartup(baseInput(), {
      resolveRecipients: () => ['ws-a'],
      sendSystemMessage: async () => { throw new Error('bridge unreachable'); }
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'send-failed');
  });

  it('never throws, even when resolveRecipients itself throws', async () => {
    const result = await announce.maybeAnnounceStartup(baseInput(), {
      resolveRecipients: () => { throw new Error('boom'); },
      sendSystemMessage: async () => {}
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'error');
  });

  it('refuses a non-integer sequenceId rather than silently never-announcing', async () => {
    const result = await announce.maybeAnnounceStartup({ ...baseInput(), sequenceId: undefined }, {
      resolveRecipients: () => ['ws-a'], sendSystemMessage: async () => {}
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'no-sequence-id');
  });
});

// `lib/launch-sequence.js#_attemptStartupAnnounce` is the glue both real call
// sites use (`ready()`, `lib/sessions.js#_maybeAutoStartMedusa`); stubbed
// through each dependency's own `module.exports` property (never the
// closure-local binding `_attemptStartupAnnounce` captured at require time),
// same convention `lib/medusa.js#_captureCarriedMail`'s own test file uses.
describe('launch-sequence: _attemptStartupAnnounce (#1732 wiring)', () => {
  const origSessionsGet = store.sessions.get;
  const origProjectsGet = store.projects.get;
  const origGetStatus = medusa.getStatus;
  const origGetWorkspaceId = medusaRegistry.getWorkspaceId;
  const origResolveSessionRole = primerLaunchWiring.resolveSessionRole;
  const origConfigLoad = projectConfigModule.load;
  const origMaybeAnnounce = announce.maybeAnnounceStartup;

  function restore() {
    store.sessions.get = origSessionsGet;
    store.projects.get = origProjectsGet;
    medusa.getStatus = origGetStatus;
    medusaRegistry.getWorkspaceId = origGetWorkspaceId;
    primerLaunchWiring.resolveSessionRole = origResolveSessionRole;
    projectConfigModule.load = origConfigLoad;
    announce.maybeAnnounceStartup = origMaybeAnnounce;
  }

  it('resolves listening/workspace/role and calls maybeAnnounceStartup with isReady/isListening true', () => {
    store.sessions.get = () => ({ id: 1555 });
    store.projects.get = () => ({ id: 7, name: 'TC-Lane-B', path: '/tmp/proj' });
    medusa.getStatus = () => ({ state: 'listening' });
    medusaRegistry.getWorkspaceId = () => 'tc-lane-b-bf9cd917';
    primerLaunchWiring.resolveSessionRole = () => 'worker';
    projectConfigModule.load = () => ({});
    let captured = null;
    announce.maybeAnnounceStartup = async (input) => { captured = input; return { sent: true }; };
    try {
      launchSequence._attemptStartupAnnounce({ id: 42, sessionId: 1555, projectId: 7 });
      assert.ok(captured, 'maybeAnnounceStartup must have been called');
      assert.equal(captured.sequenceId, 42);
      assert.equal(captured.sessionId, 1555);
      assert.equal(captured.sessionName, 'TC-Lane-B');
      assert.equal(captured.role, 'worker');
      assert.equal(captured.workspaceId, 'tc-lane-b-bf9cd917');
      assert.equal(captured.isReady, true);
      assert.equal(captured.isListening, true);
    } finally {
      restore();
    }
  });

  it('does not call maybeAnnounceStartup when the session has no active Medusa listener', () => {
    store.sessions.get = () => ({ id: 1555 });
    store.projects.get = () => ({ id: 7, name: 'TC-Lane-B', path: '/tmp/proj' });
    medusa.getStatus = () => ({ state: 'off' });
    medusaRegistry.getWorkspaceId = () => 'tc-lane-b-bf9cd917';
    let called = false;
    announce.maybeAnnounceStartup = async () => { called = true; return { sent: false }; };
    try {
      launchSequence._attemptStartupAnnounce({ id: 42, sessionId: 1555, projectId: 7 });
      assert.equal(called, false);
    } finally {
      restore();
    }
  });

  it('never throws when the session or project row cannot be found', () => {
    store.sessions.get = () => null;
    store.projects.get = () => null;
    assert.doesNotThrow(() => launchSequence._attemptStartupAnnounce({ id: 42, sessionId: 9999, projectId: 9999 }));
    restore();
  });

  it('never throws when a dependency itself throws', () => {
    store.sessions.get = () => { throw new Error('db unavailable'); };
    assert.doesNotThrow(() => launchSequence._attemptStartupAnnounce({ id: 42, sessionId: 1555, projectId: 7 }));
    restore();
  });
});
