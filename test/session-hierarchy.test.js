'use strict';

/*
 * #1578 — session hierarchy: a persistent, project-level delegation
 * relationship letting one session (the superior) direct, wrap and clear
 * another (the subordinate). Covers config validation/persistence,
 * `canSuperiorExecute`, `isAuthorizedSuperiorSender`, and the generated
 * primer text, against a real isolated store and real temp project
 * directories -- the same `store._setBasePath`/`store.init()` pattern
 * `test/coordinator-rotation.test.js` uses for its own authority tests.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const medusaRegistry = require('../lib/medusa-registry');
const sharedDocsAccess = require('../lib/shared-docs-access');
const sessionHierarchy = require('../lib/session-hierarchy');
const operatingPrimer = require('../lib/operating-primer');
const launchSequence = require('../lib/launch-sequence');
const sessions = require('../lib/sessions');
const medusa = require('../lib/medusa');
const serverModule = require('../server');
const { bindProject, sendAs, operatorOf } = require('./_shared-docs-callers');

describe('#1578 session hierarchy', () => {
  let prevBase;
  let tempDir;
  let subPath;
  let supPath;
  let subordinate;
  let superior;
  let unrelated;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hierarchy-'));
    subPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hierarchy-sub-')));
    supPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hierarchy-sup-')));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    subordinate = store.projects.create({ name: 'Subordinate', path: subPath, engine: 'claude' });
    superior = store.projects.create({ name: 'Superior', path: supPath, engine: 'claude' });
    unrelated = store.projects.create({ name: 'Unrelated', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hierarchy-un-')), engine: 'claude' });
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(subPath, { recursive: true, force: true });
    fs.rmSync(supPath, { recursive: true, force: true });
  });

  beforeEach(() => {
    sessionHierarchy.clearConfig(subordinate);
  });

  describe('normalizeHierarchyConfig', () => {
    it('accepts a valid config and de-dupes delegatedScope', () => {
      const r = sessionHierarchy.normalizeHierarchyConfig({ reportsTo: 'Superior', delegatedScope: ['wrap', 'clear', 'wrap'] });
      assert.equal(r.ok, true);
      assert.deepEqual(r.config, { reportsTo: 'Superior', delegatedScope: ['wrap', 'clear'] });
    });

    it('rejects a missing/blank reportsTo', () => {
      assert.equal(sessionHierarchy.normalizeHierarchyConfig({ delegatedScope: [] }).ok, false);
      assert.equal(sessionHierarchy.normalizeHierarchyConfig({ reportsTo: '  ', delegatedScope: [] }).ok, false);
    });

    it('rejects a non-array delegatedScope', () => {
      const r = sessionHierarchy.normalizeHierarchyConfig({ reportsTo: 'Superior', delegatedScope: 'wrap' });
      assert.equal(r.ok, false);
    });

    it('rejects (never silently drops) a RESERVED scope in delegatedScope', () => {
      const r = sessionHierarchy.normalizeHierarchyConfig({ reportsTo: 'Superior', delegatedScope: ['wrap', 'kill_session'] });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('kill_session') && e.includes('reserved')));
    });

    it('rejects an unrecognized scope', () => {
      const r = sessionHierarchy.normalizeHierarchyConfig({ reportsTo: 'Superior', delegatedScope: ['teleport'] });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('teleport')));
    });

    it('every RESERVED_SCOPES entry is refused individually', () => {
      for (const scope of sessionHierarchy.RESERVED_SCOPES) {
        const r = sessionHierarchy.normalizeHierarchyConfig({ reportsTo: 'Superior', delegatedScope: [scope] });
        assert.equal(r.ok, false, `"${scope}" must be refused`);
      }
    });

    it('every DELEGABLE_SCOPES entry accepts individually -- the public contract '
      + 'normalizeHierarchyConfig actually honors, not a list it quietly diverges from', () => {
      for (const scope of sessionHierarchy.DELEGABLE_SCOPES) {
        const r = sessionHierarchy.normalizeHierarchyConfig({ reportsTo: 'Superior', delegatedScope: [scope] });
        assert.equal(r.ok, true, `"${scope}" must be accepted`);
      }
    });

    it('DELEGABLE_SCOPES and RESERVED_SCOPES never overlap', () => {
      for (const scope of sessionHierarchy.DELEGABLE_SCOPES) {
        assert.ok(!sessionHierarchy.RESERVED_SCOPES.includes(scope), `"${scope}" is in both lists`);
      }
    });
  });

  describe('getConfig / setConfig / clearConfig', () => {
    it('round-trips a valid config to disk', () => {
      const set = sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
      assert.equal(set.ok, true);
      assert.deepEqual(sessionHierarchy.getConfig(subordinate), { reportsTo: 'Superior', delegatedScope: ['wrap'] });
    });

    it('getConfig reads null when nothing is configured', () => {
      assert.equal(sessionHierarchy.getConfig(subordinate), null);
    });

    it('setConfig refuses and does not persist an invalid config', () => {
      const set = sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['deploy'] });
      assert.equal(set.ok, false);
      assert.equal(sessionHierarchy.getConfig(subordinate), null);
    });

    it('clearConfig removes a stored config and is idempotent', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
      assert.equal(sessionHierarchy.clearConfig(subordinate), true);
      assert.equal(sessionHierarchy.getConfig(subordinate), null);
      assert.equal(sessionHierarchy.clearConfig(subordinate), false);
    });

    it('a corrupt config file on disk reads as unset, not thrown', () => {
      const file = path.join(subPath, '.tangleclaw', 'session-hierarchy.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{not json');
      assert.equal(sessionHierarchy.getConfig(subordinate), null);
    });
  });

  describe('canSuperiorExecute', () => {
    beforeEach(() => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap', 'clear'] });
    });

    it('allows the configured superior a delegated scope', () => {
      const caller = { kind: sharedDocsAccess.KINDS.PROJECT, projectId: superior.id };
      assert.equal(sessionHierarchy.canSuperiorExecute(subordinate, caller, 'wrap'), true);
    });

    it('refuses a scope not in delegatedScope', () => {
      const caller = { kind: sharedDocsAccess.KINDS.PROJECT, projectId: superior.id };
      assert.equal(sessionHierarchy.canSuperiorExecute(subordinate, caller, 'plan'), false);
    });

    it('refuses a project that is not the configured superior', () => {
      const caller = { kind: sharedDocsAccess.KINDS.PROJECT, projectId: unrelated.id };
      assert.equal(sessionHierarchy.canSuperiorExecute(subordinate, caller, 'wrap'), false);
    });

    it('refuses a non-PROJECT caller kind (operator/master go through their own gates)', () => {
      assert.equal(sessionHierarchy.canSuperiorExecute(subordinate, { kind: sharedDocsAccess.KINDS.OPERATOR }, 'wrap'), false);
      assert.equal(sessionHierarchy.canSuperiorExecute(subordinate, { kind: sharedDocsAccess.KINDS.MASTER }, 'wrap'), false);
    });

    it('refuses the subordinate acting as its own superior', () => {
      const caller = { kind: sharedDocsAccess.KINDS.PROJECT, projectId: subordinate.id };
      assert.equal(sessionHierarchy.canSuperiorExecute(subordinate, caller, 'wrap'), false);
    });

    it('refuses with no config at all', () => {
      sessionHierarchy.clearConfig(subordinate);
      const caller = { kind: sharedDocsAccess.KINDS.PROJECT, projectId: superior.id };
      assert.equal(sessionHierarchy.canSuperiorExecute(subordinate, caller, 'wrap'), false);
    });

    it('refuses EVERY reserved action unconditionally, even naming the real configured superior', () => {
      const caller = { kind: sharedDocsAccess.KINDS.PROJECT, projectId: superior.id };
      for (const action of sessionHierarchy.RESERVED_SCOPES) {
        assert.equal(sessionHierarchy.canSuperiorExecute(subordinate, caller, action), false, `"${action}" must be refused`);
      }
    });
  });

  describe('isAuthorizedSuperiorSender', () => {
    let session;

    beforeEach(() => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['clear'] });
      session = store.sessions.start({ projectId: superior.id, engineId: 'claude', tmuxSession: 'tc-hierarchy-sup', primePrompt: '' });
    });

    afterEach(() => {
      store.sessions.kill(session.id, 'test cleanup');
    });

    it('authorizes the superior\'s current registered workspace id', () => {
      const workspaceId = medusaRegistry.ensureWorkspaceId(supPath, session.id, 'Superior');
      assert.equal(sessionHierarchy.isAuthorizedSuperiorSender(subordinate, workspaceId), true);
    });

    it('refuses a STALE workspace id that no longer matches the current session', () => {
      medusaRegistry.ensureWorkspaceId(supPath, session.id, 'Superior');
      assert.equal(sessionHierarchy.isAuthorizedSuperiorSender(subordinate, 'superior-deadbeef'), false);
    });

    it('refuses with no config at all', () => {
      sessionHierarchy.clearConfig(subordinate);
      const workspaceId = medusaRegistry.ensureWorkspaceId(supPath, session.id, 'Superior');
      assert.equal(sessionHierarchy.isAuthorizedSuperiorSender(subordinate, workspaceId), false);
    });

    it('refuses a non-string/empty fromWorkspaceId', () => {
      assert.equal(sessionHierarchy.isAuthorizedSuperiorSender(subordinate, ''), false);
      assert.equal(sessionHierarchy.isAuthorizedSuperiorSender(subordinate, null), false);
      assert.equal(sessionHierarchy.isAuthorizedSuperiorSender(subordinate, undefined), false);
    });
  });

  describe('findSubordinatesOf', () => {
    beforeEach(() => {
      sessionHierarchy.clearConfig(subordinate);
      sessionHierarchy.clearConfig(unrelated);
    });

    it('finds a project configured to report to the given superior', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
      const found = sessionHierarchy.findSubordinatesOf(superior);
      assert.equal(found.length, 1);
      assert.equal(found[0].project.id, subordinate.id);
      assert.deepEqual(found[0].config.delegatedScope, ['wrap']);
    });

    it('is empty when no project reports to the given superior', () => {
      assert.deepEqual(sessionHierarchy.findSubordinatesOf(superior), []);
    });

    it('never includes the superior itself even if misconfigured to report to itself', () => {
      sessionHierarchy.setConfig(superior, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
      try {
        assert.deepEqual(sessionHierarchy.findSubordinatesOf(superior), []);
      } finally {
        sessionHierarchy.clearConfig(superior);
      }
    });
  });

  describe('generated primer text', () => {
    const config = { reportsTo: 'Superior', delegatedScope: ['wrap', 'clear'] };

    it('subordinate instructions name the superior, the delegated scopes, and the full reserved list', () => {
      const text = sessionHierarchy.generateSubordinateInstructions('Subordinate', config);
      assert.match(text, /Superior/);
      assert.match(text, /wrap, clear/);
      assert.match(text, /prepare to wrap/);
      assert.match(text, /prepare to clear/);
      for (const scope of sessionHierarchy.RESERVED_SCOPES) assert.ok(text.includes(scope), `missing ${scope}`);
    });

    it('superior instructions name the subordinate, the delegated scopes, and the full reserved list', () => {
      const text = sessionHierarchy.generateSuperiorInstructions('Subordinate', config);
      assert.match(text, /Subordinate/);
      assert.match(text, /wrap, clear/);
      for (const scope of sessionHierarchy.RESERVED_SCOPES) assert.ok(text.includes(scope), `missing ${scope}`);
    });

    it('renders "(none)" for an empty delegatedScope rather than a dangling colon', () => {
      const text = sessionHierarchy.generateSubordinateInstructions('Subordinate', { reportsTo: 'Superior', delegatedScope: [] });
      assert.match(text, /\(none\)/);
    });
  });

  describe('operating-primer.js: appendSessionHierarchySection', () => {
    beforeEach(() => {
      sessionHierarchy.clearConfig(subordinate);
    });

    it('returns the base text unchanged, byte for byte, when the project has neither role', () => {
      const base = 'base primer text\n';
      assert.equal(operatingPrimer.appendSessionHierarchySection(base, unrelated), base);
    });

    it('appends the subordinate block when the project has its own config', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
      const out = operatingPrimer.appendSessionHierarchySection('base\n', subordinate);
      assert.match(out, /base/);
      assert.match(out, /reports to \*\*Superior\*\*/);
    });

    it('appends one superior block per live subordinate reporting to the project', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['clear'] });
      const out = operatingPrimer.appendSessionHierarchySection('base\n', superior);
      assert.match(out, /\*\*Subordinate\*\* reports to this project/);
    });
  });

  describe('launch-sequence.js: sessionHierarchyAddendum', () => {
    beforeEach(() => {
      sessionHierarchy.clearConfig(subordinate);
    });

    it('is null for a project with neither role', () => {
      assert.equal(launchSequence.sessionHierarchyAddendum(unrelated), null);
    });

    it('is the subordinate block, trimmed, for a configured subordinate', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
      const text = launchSequence.sessionHierarchyAddendum(subordinate);
      assert.ok(text && text.startsWith('## Session Hierarchy'));
      assert.notEqual(text[text.length - 1], '\n', 'trimmed, not a caller-surprising trailing newline');
    });
  });

  describe('lib/sessions.js: wired into the real startup text (#1578, Ruling A506-W2B-SCOPE-R1)', () => {
    const engineProfile = { id: 'claude', name: 'claude' };

    beforeEach(() => {
      sessionHierarchy.clearConfig(subordinate);
    });

    it('renderLaunchSteps\' "identity" step carries the subordinate block when configured', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap', 'clear'] });
      const steps = sessions.renderLaunchSteps(subordinate, engineProfile, {});
      assert.match(steps.identity, /## Session Hierarchy/);
      assert.match(steps.identity, /reports to \*\*Superior\*\*/);
    });

    it('renderLaunchSteps\' "identity" step carries the superior block for each live subordinate', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['clear'] });
      const steps = sessions.renderLaunchSteps(superior, engineProfile, {});
      assert.match(steps.identity, /\*\*Subordinate\*\* reports to this project/);
    });

    it('carries neither block for a project configured as neither role', () => {
      const steps = sessions.renderLaunchSteps(unrelated, engineProfile, {});
      assert.doesNotMatch(steps.identity, /## Session Hierarchy/);
    });

    it('generatePrimePrompt (the push-mode pasted prime) also carries the subordinate block', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
      const prime = sessions.generatePrimePrompt(subordinate, engineProfile, {});
      assert.match(prime, /## Session Hierarchy/);
    });
  });

  // ------------------------------------------------------------------------
  // lib/medusa.js (Ruling A506-W2B-SCOPE-R2): getMessages annotates each
  // inbox message with `fromConfiguredSuperior`, purely descriptive -- this
  // module makes no authority decision itself. A minimal FakeWS, mirroring
  // the essential slice of `test/api-medusa.test.js`'s own class (that file
  // is out of this car's envelope, so not reused directly).
  // ------------------------------------------------------------------------
  describe('lib/medusa.js: getMessages annotates fromConfiguredSuperior (#1578)', () => {
    const OPEN = 1;
    const CONNECTING = 0;

    /** Minimal fake WebSocket matching what MedusaListener drives. */
    class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = CONNECTING;
        this.sent = [];
        this._h = Object.create(null);
      }

      addEventListener(t, h) {
        (this._h[t] || (this._h[t] = [])).push(h);
      }

      send(d) { this.sent.push(d); }
      close() {}

      _fire(t, e) { for (const h of this._h[t] || []) h(e); }
      _open() { this.readyState = OPEN; this._fire('open', {}); }
      _recv(obj) { this._fire('message', { data: JSON.stringify(obj) }); }
    }

    /**
     * Start a listener for `sessionId` and drive it to `listening`.
     * `projectPath` MUST be the real project's own path: `isAuthorizedSuperiorSender`
     * resolves the superior's workspace id via `medusaRegistry.getWorkspaceId(superior.path, ...)`,
     * so registering it under any other path (e.g. an unrelated scratch dir)
     * would never be found.
     * @param {string|number} sessionId
     * @param {string} projectPath
     * @returns {{fake: FakeWS, workspaceId: string}}
     */
    function startListening(sessionId, projectPath) {
      let fake;
      const status = medusa.startSession({
        projectPath, sessionId, name: `session-${sessionId}`, wsFactory: (url) => (fake = new FakeWS(url))
      });
      fake._open();
      fake._recv({ type: 'registered', workspaceId: status.workspaceId, connectionId: 'c1' });
      return { fake, workspaceId: status.workspaceId };
    }

    let superiorSession;
    let subordinateSession;

    beforeEach(() => {
      sessionHierarchy.clearConfig(subordinate);
      superiorSession = store.sessions.start({ projectId: superior.id, engineId: 'claude', tmuxSession: 'tc-hierarchy-medusa-sup', primePrompt: '' });
      subordinateSession = store.sessions.start({ projectId: subordinate.id, engineId: 'claude', tmuxSession: 'tc-hierarchy-medusa-sub', primePrompt: '' });
    });

    afterEach(() => {
      medusa.stopSession(subordinateSession.id);
      medusa.stopSession(superiorSession.id);
      store.sessions.kill(superiorSession.id, 'test cleanup');
      store.sessions.kill(subordinateSession.id, 'test cleanup');
    });

    it('flags true for the configured superior\'s current workspace id', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
      const sup = startListening(superiorSession.id, supPath);
      const sub = startListening(subordinateSession.id, subPath);
      sub.fake._recv({ type: 'new_message', messageId: 'm1', message: { id: 'm1', from: sup.workspaceId, message: 'prepare to wrap' } });
      const [msg] = medusa.getMessages(subordinateSession.id);
      assert.equal(msg.fromConfiguredSuperior, true);
    });

    it('flags false for a stranger workspace id, even with a hierarchy configured', () => {
      sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
      const sub = startListening(subordinateSession.id, subPath);
      sub.fake._recv({ type: 'new_message', messageId: 'm1', message: { id: 'm1', from: 'stranger-deadbeef', message: 'prepare to wrap' } });
      const [msg] = medusa.getMessages(subordinateSession.id);
      assert.equal(msg.fromConfiguredSuperior, false);
    });

    it('flags false with no hierarchy configured at all', () => {
      const sup = startListening(superiorSession.id, supPath);
      const sub = startListening(subordinateSession.id, subPath);
      sub.fake._recv({ type: 'new_message', messageId: 'm1', message: { id: 'm1', from: sup.workspaceId, message: 'hi' } });
      const [msg] = medusa.getMessages(subordinateSession.id);
      assert.equal(msg.fromConfiguredSuperior, false);
    });

    it('never throws for an unknown session id (no project context)', () => {
      assert.deepEqual(medusa.getMessages('no-such-session'), []);
    });
  });

  // ------------------------------------------------------------------------
  // Route wiring (lib/routes/wrap.js, lib/routes/sessions.js): a real HTTP
  // server over the SAME store/projects set up above, mirroring the
  // established `test/api-sessions.test.js` pattern for #2824's own
  // governed-/clear tests (`bindProject`, `sendAs`, a stubbed activity
  // observer + a real complete/safe-to-clear workload receipt). This only
  // proves the AUTHORIZATION gate: `assert.notEqual(res.status, 403)` +
  // the specific refusal code, never that a full wrap pipeline completes
  // (the same cheap-and-reliable boundary `api-sess-test/wrap`'s own
  // "returns 404 when no active session" test already uses).
  // ------------------------------------------------------------------------
  describe('route wiring over a real HTTP server', () => {
    let server;
    let writeHeaders;

    before(async () => {
      server = serverModule.createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      writeHeaders = await operatorOf(server)();
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    beforeEach(() => {
      sessionHierarchy.clearConfig(subordinate);
    });

    /**
     * Give `bound`'s own session a current complete/safe-to-clear receipt
     * and stub the activity observer at-rest, so it genuinely composes
     * AVAILABLE/safe-to-clear -- `test/api-sessions.test.js`'s own
     * `makeSafeToClear`, mirrored here since that file is out of this
     * car's file envelope.
     * @param {{headers: Record<string,string>}} bound - From `bindProject`.
     * @returns {Promise<() => void>} Restores the observer stub.
     */
    async function makeSafeToClear(bound) {
      const res = await sendAs(server, 'POST', '/api/tc/workload',
        { schema: 'tc.workload/1', state: 'complete', clearance: 'safe-to-clear', summary: 'test' },
        { ...bound.headers, 'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'workload.set' });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      const real = serverModule._activityObserver.get;
      serverModule._activityObserver.get = () => ({ activity: 'at-rest', reason: 'test', observedAt: null, ageSeconds: 0 });
      return () => { serverModule._activityObserver.get = real; };
    }

    describe('POST /api/sessions/:project/wrap', () => {
      it('a hierarchy-delegated superior reaches past authorization (passes, then 404s on no active session)', async () => {
        sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
        const superiorBound = bindProject(superior);
        try {
          const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(subordinate.name)}/wrap`, {}, superiorBound.headers);
          assert.notEqual(res.status, 403, JSON.stringify(res.data));
        } finally {
          store.sessions.kill(superiorBound.sessionId, 'test cleanup');
        }
      });

      it('an unrelated project is refused, same request shape', async () => {
        sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
        const unrelatedBound = bindProject(unrelated);
        try {
          const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(subordinate.name)}/wrap`, {}, unrelatedBound.headers);
          assert.equal(res.status, 403, JSON.stringify(res.data));
        } finally {
          store.sessions.kill(unrelatedBound.sessionId, 'test cleanup');
        }
      });

      it('the configured superior is refused when wrap is NOT in delegatedScope', async () => {
        sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['clear'] });
        const superiorBound = bindProject(superior);
        try {
          const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(subordinate.name)}/wrap`, {}, superiorBound.headers);
          assert.equal(res.status, 403, JSON.stringify(res.data));
        } finally {
          store.sessions.kill(superiorBound.sessionId, 'test cleanup');
        }
      });
    });

    describe('POST /api/sessions/:project/command — governed /clear (#1578)', () => {
      it('a hierarchy-delegated superior may /clear a target lane that composes AVAILABLE/safe-to-clear', async () => {
        sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['clear'] });
        const superiorBound = bindProject(superior);
        const subordinateBound = bindProject(subordinate);
        const restore = await makeSafeToClear(subordinateBound);
        try {
          const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(subordinate.name)}/command`,
            { command: '/clear', startupIntervention: true }, superiorBound.headers);
          assert.notEqual(res.status, 403, JSON.stringify(res.data));
          assert.notEqual(res.data && res.data.code, 'SLASH_COMMAND_OPERATOR_ONLY');
        } finally {
          restore();
          store.sessions.kill(superiorBound.sessionId, 'test cleanup');
          store.sessions.kill(subordinateBound.sessionId, 'test cleanup');
        }
      });

      it('is still refused while the target lane is NOT safe-to-clear (busy)', async () => {
        sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['clear'] });
        const superiorBound = bindProject(superior);
        const subordinateBound = bindProject(subordinate);
        const real = serverModule._activityObserver.get;
        serverModule._activityObserver.get = () => ({ activity: 'busy', reason: 'test', observedAt: null, ageSeconds: 0 });
        try {
          const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(subordinate.name)}/command`,
            { command: '/clear', startupIntervention: true }, superiorBound.headers);
          assert.equal(res.status, 403);
          assert.equal(res.data.code, 'SLASH_COMMAND_OPERATOR_ONLY');
        } finally {
          serverModule._activityObserver.get = real;
          store.sessions.kill(superiorBound.sessionId, 'test cleanup');
          store.sessions.kill(subordinateBound.sessionId, 'test cleanup');
        }
      });

      it('a superior with only "wrap" delegated (not "clear") is refused /clear', async () => {
        sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap'] });
        const superiorBound = bindProject(superior);
        const subordinateBound = bindProject(subordinate);
        const restore = await makeSafeToClear(subordinateBound);
        try {
          const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(subordinate.name)}/command`,
            { command: '/clear', startupIntervention: true }, superiorBound.headers);
          assert.equal(res.status, 403);
          assert.equal(res.data.code, 'SLASH_COMMAND_OPERATOR_ONLY');
        } finally {
          restore();
          store.sessions.kill(superiorBound.sessionId, 'test cleanup');
          store.sessions.kill(subordinateBound.sessionId, 'test cleanup');
        }
      });
    });

    describe('DELETE /api/sessions/:project — kill is never delegable (#1578)', () => {
      it('a configured superior is refused with the explicit SUPERIOR_ACTION_FORBIDDEN code, not the generic one', async () => {
        sessionHierarchy.setConfig(subordinate, { reportsTo: 'Superior', delegatedScope: ['wrap', 'clear'] });
        const superiorBound = bindProject(superior);
        try {
          const res = await sendAs(server, 'DELETE', `/api/sessions/${encodeURIComponent(subordinate.name)}`, undefined, superiorBound.headers);
          assert.equal(res.status, 403);
          assert.equal(res.data.code, 'SUPERIOR_ACTION_FORBIDDEN');
        } finally {
          store.sessions.kill(superiorBound.sessionId, 'test cleanup');
        }
      });

      it('an unrelated project is refused with the generic (non-superior) code', async () => {
        const unrelatedBound = bindProject(unrelated);
        try {
          const res = await sendAs(server, 'DELETE', `/api/sessions/${encodeURIComponent(subordinate.name)}`, undefined, unrelatedBound.headers);
          assert.equal(res.status, 403);
          assert.notEqual(res.data.code, 'SUPERIOR_ACTION_FORBIDDEN');
        } finally {
          store.sessions.kill(unrelatedBound.sessionId, 'test cleanup');
        }
      });
    });
  });
});
