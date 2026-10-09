'use strict';

/*
 * GET /api/launch/isolation and `tc sessions isolation` (#2233): who is
 * answered, what the answer holds, and how `tc` prints it. The store is a
 * scratch one and a function stands in for tmux, so no pane is read.
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const logger = require('../lib/logger');
const sessions = require('../lib/sessions');
const verbs = require('../lib/tc-verbs');
const inventory = require('../lib/launch-isolation-inventory');
const { createServer } = require('../server');
const { operatorHeaders, bindProject, sendAs } = require('./_shared-docs-callers');

const savedAsync = { ...tmux._async };

/**
 * Have tmux report these panes.
 * @param {Object<string, string>} panes - Start command by session name, as handed to tmux
 * @returns {void}
 */
function tmuxReports(panes) {
  const lines = Object.entries(panes).map(([name, command]) => `${name}\t"${command.replace(/(["$\\])/g, '\\$1')}"`);
  tmux._async.execFile = (_bin, _args, _opts, cb) => setImmediate(() => cb(null, lines.join('\n') + '\n'));
}

describe('GET /api/launch/isolation (#2233)', () => {
  let tmpDir;
  let server;
  let claude;
  let codexProject;
  let binding;
  let codexBinding;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-isolation-route-'));
    store._setBasePath(tmpDir);
    store.init();
    const mk = (name, engine) => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir);
      return store.projects.create({ name, path: dir, engine });
    };
    claude = mk('iso-claude', 'claude');
    codexProject = mk('iso-codex', 'codex');
    binding = bindProject(claude);
    codexBinding = bindProject(codexProject);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    Object.assign(tmux._async, savedAsync);
    logger.setConsoleStream(null);
  });

  /**
   * The tmux session name the store recorded for a bound session.
   * @param {{sessionId: number}} bound - From `bindProject`
   * @param {{name: string}} project - Its project
   * @returns {string}
   */
  const paneName = (bound, project) => store.sessions.get(bound.sessionId).tmuxSession || tmux.toSessionName(project.name);

  it('answers a verified project session with a row for every live session', async () => {
    tmuxReports({
      [paneName(binding, claude)]: sessions._withPathFloor('claude --dangerously-skip-permissions'),
      [paneName(codexBinding, codexProject)]: sessions._withPathFloor('codex --full-auto')
    });
    const res = await sendAs(server, 'GET', '/api/launch/isolation', undefined, binding.headers);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.tmux, { answered: true, cause: null });
    const byId = new Map(res.data.sessions.map((s) => [s.sessionId, s]));
    assert.equal(byId.get(binding.sessionId).verdict, 'not-applicable');
    assert.deepEqual(
      [byId.get(codexBinding.sessionId).verdict, byId.get(codexBinding.sessionId).reasonCode, byId.get(codexBinding.sessionId).projectName],
      ['not-isolated', 'command_not_pinned', 'iso-codex']
    );
    assert.equal(res.data.summary['not-isolated'], 1);
    assert.ok(!('replaced' in res.data), 'no verification was asked for');
    assert.doesNotMatch(JSON.stringify(res.data), /export PATH/, 'the command itself is not returned');
  });

  it('answers the operator\'s dashboard', async () => {
    tmuxReports({});
    const res = await sendAs(server, 'GET', '/api/launch/isolation', undefined, operatorHeaders(server));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.sessions));
  });

  it('refuses a caller with no binding, in the write floor\'s words', async () => {
    tmuxReports({});
    const res = await sendAs(server, 'GET', '/api/launch/isolation', undefined, {});
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
    assert.ok(!('sessions' in res.data));
  });

  it('refuses a stale binding, and does not read tmux for it', async () => {
    let asked = 0;
    tmux._async.execFile = (_b, _a, _o, cb) => { asked += 1; setImmediate(() => cb(null, '')); };
    const res = await sendAs(server, 'GET', '/api/launch/isolation', undefined, { 'x-tangleclaw-project-id': String(claude.id), 'x-tangleclaw-launch-id': 'not-a-launch' });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'LAUNCH_BINDING_INVALID');
    assert.match(res.data.error, /Do not act from this pane/);
    assert.equal(asked, 0);
  });

  it('says tmux did not answer, and calls no session isolated on that read', async () => {
    logger.setConsoleStream({ write: () => {} });
    tmux._async.execFile = (_b, _a, _o, cb) => setImmediate(() => cb(Object.assign(new Error('timed out'), { killed: true }), ''));
    const res = await sendAs(server, 'GET', '/api/launch/isolation', undefined, binding.headers);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.tmux, { answered: false, cause: 'read-timed-out' });
    assert.equal(res.data.summary.isolated, 0);
    assert.ok(res.data.sessions.filter((s) => s.role === 'project').every((s) => s.verdict === 'unknown' && s.reasonCode === 'tmux_unanswered'));
  });

  it('a tmux that failed is not an empty fleet: every pane reads not shown isolated, down to what tc prints', async () => {
    logger.setConsoleStream({ write: () => {} });
    tmux._async.execFile = (_b, _a, _o, cb) => setImmediate(() => cb(Object.assign(new Error('Command failed: tmux list-panes -a\nprotocol version mismatch (client 8, server 7)\n'), { code: 1 }), ''));
    const res = await sendAs(server, 'GET', '/api/launch/isolation', undefined, binding.headers);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.tmux, { answered: false, cause: 'tmux-failed' });
    assert.equal(res.data.summary['not-applicable'], 0);
    assert.ok(res.data.sessions.some((s) => s.role === 'master'), 'the Master is listed, because it may be running');
    const printed = verbs.renderIsolation(res.data);
    assert.match(printed.split('\n')[0], /tmux did not answer \(tmux-failed\)/);
    assert.doesNotMatch(printed, /No live session needs relaunching/);
    assert.match(printed, /NOT SHOWN ISOLATED/);
  });

  it('with ?replaced, says what became of each earlier session', async () => {
    const p = store.projects.create({ name: 'iso-relaunch', path: fs.mkdtempSync(path.join(tmpDir, 'r-')), engine: 'codex' });
    const first = bindProject(p);
    store.sessions.kill(first.sessionId, 'test');
    const second = bindProject(p);
    tmuxReports({ [paneName(second, p)]: sessions._withPathFloor('/opt/fake/bin/codex --full-auto --no-daemon') });
    const res = await sendAs(server, 'GET', `/api/launch/isolation?replaced=${first.sessionId},${second.sessionId},999999`, undefined, binding.headers);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.replaced.map((r) => [r.sessionId, r.outcome, r.replacedBy]), [
      [first.sessionId, 'relaunched-isolated', second.sessionId],
      [second.sessionId, 'still-running', null],
      [999999, 'unknown-session', null]
    ]);
  });

  it('refuses a ?replaced that is not a list of session ids', async () => {
    tmuxReports({});
    for (const bad of ['abc', '1,,2', '']) {
      const res = await sendAs(server, 'GET', `/api/launch/isolation?replaced=${bad}`, undefined, binding.headers);
      assert.equal(res.status, 400, bad);
      assert.equal(res.data.code, 'BAD_REQUEST');
    }
  });

  it('answers 500 with no verdicts when the inventory itself fails', async () => {
    logger.setConsoleStream({ write: () => {} });
    const real = inventory.inventory;
    inventory.inventory = async () => { throw new Error('database is locked'); };
    try {
      const res = await sendAs(server, 'GET', '/api/launch/isolation', undefined, binding.headers);
      assert.equal(res.status, 500);
      assert.ok(!('sessions' in res.data));
      assert.doesNotMatch(JSON.stringify(res.data), /database is locked/);
    } finally {
      inventory.inventory = real;
    }
  });
});

describe('tc sessions isolation (#2233)', () => {
  const INV = {
    observedAt: '2026-10-09T20:00:00.000Z',
    tmux: { answered: true, cause: null },
    sessions: [
      { sessionId: 1, projectId: 10, projectName: 'alpha', engineId: 'codex', role: 'project', verdict: 'isolated', basis: 'no-daemon', reasonCode: null, reason: 'Started with --no-daemon.' },
      { sessionId: 2, projectId: 20, projectName: 'beta', engineId: 'codex', role: 'project', verdict: 'not-isolated', basis: null, reasonCode: 'command_not_pinned', reason: 'Started with `codex`.' },
      { sessionId: 3, projectId: 30, projectName: null, engineId: 'codex', role: 'project', verdict: 'unknown', basis: null, reasonCode: 'command_unreadable', reason: 'Could not be read back.' },
      { sessionId: 4, projectId: 40, projectName: 'delta', engineId: 'claude', role: 'project', verdict: 'not-applicable', basis: null, reasonCode: null, reason: 'No shared background process.' },
      { sessionId: null, projectId: null, projectName: null, engineId: 'claude', role: 'master', verdict: 'not-applicable', basis: null, reasonCode: null, reason: 'No shared background process.' }
    ],
    summary: { isolated: 1, 'not-isolated': 1, unknown: 1, 'not-applicable': 2 }
  };

  it('prints every session with its verdict and reason, the ones to act on first', () => {
    const out = verbs.renderIsolation(INV);
    const lines = out.split('\n');
    const at = (text) => lines.findIndex((line) => line.includes(text));
    assert.ok(at('NOT ISOLATED') !== -1 && at('NOT ISOLATED') < at('NOT SHOWN ISOLATED'));
    assert.ok(at('NOT SHOWN ISOLATED') < at('ISOLATED (no-daemon)'));
    assert.match(out, /NOT ISOLATED\s+#2 beta — engine codex \[command_not_pinned\]/);
    assert.match(out, /NOT SHOWN ISOLATED\s+#3 \(unknown project\) — engine codex \[command_unreadable\]/);
    assert.match(out, /ISOLATED \(no-daemon\)\s+#1 alpha — engine codex/);
    assert.match(out, /not applicable\s+Project Master — engine claude/);
    for (const s of INV.sessions) assert.ok(out.includes(s.reason));
    assert.match(out, /1 isolated, 1 not isolated, 1 not shown isolated, 2 not applicable/);
  });

  it('never prints an unknown as a pass, and says what to do about the two that need it', () => {
    const out = verbs.renderIsolation(INV);
    assert.doesNotMatch(out.split('\n').find((line) => line.includes('#3')), /^\s*ISOLATED/);
    assert.match(out, /tc sessions isolation --replaced 2,3/);
    assert.match(out, /Nothing here ends or restarts a session/);
  });

  it('says so first when tmux did not answer', () => {
    const out = verbs.renderIsolation({ ...INV, tmux: { answered: false, cause: 'read-timed-out' } });
    assert.match(out.split('\n')[0], /tmux did not answer \(read-timed-out\)/);
  });

  it('says there is nothing to relaunch when every session is isolated or not applicable', () => {
    const out = verbs.renderIsolation({ ...INV, sessions: INV.sessions.filter((s) => s.verdict === 'isolated' || s.verdict === 'not-applicable') });
    assert.match(out, /No live session needs relaunching for isolation\./);
    assert.doesNotMatch(out, /--replaced/);
  });

  it('prints an empty fleet as an answer', () => {
    assert.match(verbs.renderIsolation({ ...INV, sessions: [], summary: {} }), /No live TangleClaw sessions/);
  });

  it('still prints what became of earlier sessions when nothing is live', () => {
    const out = verbs.renderIsolation({
      ...INV, sessions: [], summary: {},
      replaced: [{ sessionId: 2, outcome: 'ended-not-relaunched', replacedBy: null, detail: 'Ended, and its project has no running session.' }]
    });
    assert.match(out, /No live TangleClaw sessions/);
    assert.match(out, /#2: ended-not-relaunched\. Ended, and its project has no running session\./);
    assert.match(out, /0 of 1 ended and relaunched isolated/);
  });

  it('prints what became of each earlier session', () => {
    const out = verbs.renderIsolation({
      ...INV,
      replaced: [
        { sessionId: 2, outcome: 'relaunched-isolated', replacedBy: 9, detail: 'Ended, and the current session reads isolated.' },
        { sessionId: 3, outcome: 'still-running', replacedBy: null, detail: 'Still running.' }
      ]
    });
    assert.match(out, /#2: relaunched-isolated \(now session 9\)\. Ended, and the current session reads isolated\./);
    assert.match(out, /#3: still-running\. Still running\./);
    assert.match(out, /1 of 2 ended and relaunched isolated/);
  });

  describe('the verb', () => {
    /**
     * Run `tc sessions` with these arguments against a recording context.
     * @param {string[]} argv - Arguments after the verb
     * @returns {Promise<{result: object, paths: string[]}>}
     */
    async function run(argv) {
      const paths = [];
      const entry = verbs.VERB_ROSTER.find((v) => v.id === 'sessions');
      const result = await entry.run({ argv, env: {}, getJson: async (p) => { paths.push(p); return p.startsWith('/api/launch/isolation') ? INV : { sessions: [] }; } });
      return { result, paths };
    }

    it('still lists the fleet with no argument', async () => {
      const { result, paths } = await run([]);
      assert.deepEqual(paths, ['/api/tc/sessions']);
      assert.equal(result.code, 0);
    });

    it('reads the inventory for `isolation`', async () => {
      const { result, paths } = await run(['isolation']);
      assert.deepEqual(paths, ['/api/launch/isolation']);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /NOT ISOLATED/);
    });

    it('passes --replaced on', async () => {
      const { paths } = await run(['isolation', '--replaced', '2,3']);
      assert.deepEqual(paths, ['/api/launch/isolation?replaced=2%2C3']);
    });

    it('refuses a --replaced with no ids, or an argument it does not know, before asking the server', async () => {
      for (const argv of [['isolation', '--replaced'], ['isolation', '--replaced', 'x'], ['isolation', '--what'], ['nonsense']]) {
        const { result, paths } = await run(argv);
        assert.equal(result.code, 1, argv.join(' '));
        assert.match(result.stderr, /tc sessions/);
        assert.deepEqual(paths, []);
      }
    });
  });
});
