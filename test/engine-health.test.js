'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');
const engineHealth = require('../lib/engine-health');
const { uniqueSessionName } = require('./_tmux-session-names');

setLevel('error');

const {
  STATES,
  UNRESPONSIVE_STRIKES_FOR_CRASHED,
  HANDOFF_TAIL_LINES,
  probeTmuxEngine,
  probeWebuiEngine,
  createHealthTracker,
  recordProbeResult,
  lastKnownLines,
  buildFailoverHandoffPrime,
  recordCrashTelemetry
} = engineHealth;

describe('recordProbeResult — classification from a run of probes (#109)', () => {
  it('a live, answered probe is HEALTHY and resets strikes', () => {
    const tracker = createHealthTracker();
    const result = recordProbeResult(tracker, 's1', { answered: true, live: true, cause: null });
    assert.equal(result.state, STATES.HEALTHY);
    assert.equal(result.strikes, 0);
  });

  it('an answered probe that says the session is gone is CRASHED immediately, no strikes needed', () => {
    const tracker = createHealthTracker();
    const result = recordProbeResult(tracker, 's1', { answered: true, live: false, cause: null });
    assert.equal(result.state, STATES.CRASHED);
    assert.equal(result.reason, 'session-gone');
  });

  it('one unanswered probe is DEGRADED, not CRASHED', () => {
    const tracker = createHealthTracker();
    const result = recordProbeResult(tracker, 's1', { answered: false, live: false, cause: 'read-timed-out' });
    assert.equal(result.state, STATES.DEGRADED);
    assert.equal(result.strikes, 1);
  });

  it(`${UNRESPONSIVE_STRIKES_FOR_CRASHED} consecutive unanswered probes promote DEGRADED to CRASHED`, () => {
    const tracker = createHealthTracker();
    let result;
    for (let i = 0; i < UNRESPONSIVE_STRIKES_FOR_CRASHED; i++) {
      result = recordProbeResult(tracker, 's1', { answered: false, live: false, cause: 'read-timed-out' });
    }
    assert.equal(result.state, STATES.CRASHED);
    assert.equal(result.strikes, UNRESPONSIVE_STRIKES_FOR_CRASHED);
  });

  it('two strikes then a healthy probe resets the count — no promotion on the next unanswered probe alone', () => {
    const tracker = createHealthTracker();
    recordProbeResult(tracker, 's1', { answered: false, live: false, cause: 'x' });
    recordProbeResult(tracker, 's1', { answered: false, live: false, cause: 'x' });
    recordProbeResult(tracker, 's1', { answered: true, live: true, cause: null });
    const result = recordProbeResult(tracker, 's1', { answered: false, live: false, cause: 'x' });
    assert.equal(result.state, STATES.DEGRADED);
    assert.equal(result.strikes, 1);
  });

  it('two sessions track strikes independently', () => {
    const tracker = createHealthTracker();
    recordProbeResult(tracker, 'a', { answered: false, live: false, cause: 'x' });
    recordProbeResult(tracker, 'a', { answered: false, live: false, cause: 'x' });
    const b = recordProbeResult(tracker, 'b', { answered: false, live: false, cause: 'x' });
    assert.equal(b.strikes, 1, 'session b must not inherit session a\'s strike count');
  });

  it('suppressProbe (longRunningTask) reports HEALTHY and does not accrue or reset strikes', () => {
    const tracker = createHealthTracker();
    recordProbeResult(tracker, 's1', { answered: false, live: false, cause: 'x' });
    recordProbeResult(tracker, 's1', { answered: false, live: false, cause: 'x' });
    // Suppressed round: a long-running task is in progress. Must read HEALTHY
    // regardless of what the (ignored) probe result would have said, and must
    // not reset the two strikes already accrued.
    const suppressed = recordProbeResult(
      tracker, 's1', { answered: false, live: false, cause: 'x' }, { suppressProbe: true }
    );
    assert.equal(suppressed.state, STATES.HEALTHY);
    assert.equal(suppressed.strikes, 2, 'a suppressed round must not reset the existing strike count');

    // Suppression lifts: the next real probe resumes from where the strikes were.
    const resumed = recordProbeResult(tracker, 's1', { answered: false, live: false, cause: 'x' });
    assert.equal(resumed.state, STATES.CRASHED, 'the third real strike (2 before + 1 now) must promote to CRASHED');
    assert.equal(resumed.strikes, 3);
  });
});

describe('lastKnownLines — the handoff prime\'s source for terminal output (#109)', () => {
  it('is null for a session that was never probed', () => {
    const tracker = createHealthTracker();
    assert.equal(lastKnownLines(tracker, 'never-seen'), null);
  });

  it('caches the lines from the most recent live probe that captured any', () => {
    const tracker = createHealthTracker();
    recordProbeResult(tracker, 's1', { answered: true, live: true, cause: null, lines: ['a', 'b'] });
    assert.deepEqual(lastKnownLines(tracker, 's1'), ['a', 'b']);
  });

  it('survives past the crash that follows it — nothing left to capture once gone, so the cache is what a handoff prime quotes', () => {
    const tracker = createHealthTracker();
    recordProbeResult(tracker, 's1', { answered: true, live: true, cause: null, lines: ['last', 'known', 'output'] });
    recordProbeResult(tracker, 's1', { answered: true, live: false, cause: null });
    assert.deepEqual(lastKnownLines(tracker, 's1'), ['last', 'known', 'output']);
  });

  it('a live probe with no fresh capture does not overwrite a previously cached one', () => {
    const tracker = createHealthTracker();
    recordProbeResult(tracker, 's1', { answered: true, live: true, cause: null, lines: ['kept'] });
    recordProbeResult(tracker, 's1', { answered: true, live: true, cause: null, lines: null });
    assert.deepEqual(lastKnownLines(tracker, 's1'), ['kept']);
  });
});

describe('buildFailoverHandoffPrime — the context a swapped-to engine receives (#109)', () => {
  it('names the previous engine and when it ended', () => {
    const prime = buildFailoverHandoffPrime({ previousEngine: 'Claude Code', crashedAt: '2026-11-08T20:00:00Z' });
    assert.match(prime, /Claude Code/);
    assert.match(prime, /2026-11-08T20:00:00Z/);
  });

  it('includes the last action when given one', () => {
    const prime = buildFailoverHandoffPrime({
      previousEngine: 'Codex', crashedAt: '2026-11-08T20:00:00Z', lastAction: 'Running test suite...'
    });
    assert.match(prime, /Running test suite\.\.\./);
  });

  it('includes up to HANDOFF_TAIL_LINES of terminal output when given', () => {
    const tail = Array.from({ length: HANDOFF_TAIL_LINES }, (_, i) => `line ${i}`);
    const prime = buildFailoverHandoffPrime({
      previousEngine: 'Codex', crashedAt: '2026-11-08T20:00:00Z', lastTerminalLines: tail
    });
    assert.match(prime, /line 0/);
    assert.match(prime, new RegExp(`line ${HANDOFF_TAIL_LINES - 1}`));
  });

  it('omits the terminal-output section entirely when there is none to show', () => {
    const prime = buildFailoverHandoffPrime({ previousEngine: 'Codex', crashedAt: '2026-11-08T20:00:00Z' });
    assert.doesNotMatch(prime, /Last terminal output/);
  });
});

describe('recordCrashTelemetry — a running, in-process diagnostic log (#109)', () => {
  it('prepends newest-first', () => {
    const log = [];
    recordCrashTelemetry(log, { engine: 'Codex', durationMs: 1000, crashedAt: '2026-11-08T20:00:00Z', reason: 'r1' });
    recordCrashTelemetry(log, { engine: 'Claude Code', durationMs: 2000, crashedAt: '2026-11-08T20:01:00Z', reason: 'r2' });
    assert.equal(log.length, 2);
    assert.equal(log[0].engine, 'Claude Code', 'the most recently recorded crash must be first');
    assert.equal(log[1].engine, 'Codex');
  });

  it('defaults lastAction to null rather than omitting the field', () => {
    const log = [];
    recordCrashTelemetry(log, { engine: 'Codex', durationMs: 1000, crashedAt: '2026-11-08T20:00:00Z', reason: 'r1' });
    assert.equal(log[0].lastAction, null);
  });
});

describe('probeWebuiEngine — HTTP healthcheck for webui-mode sessions (#109)', () => {
  it('a 2xx response is answered and live', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200 });
    const result = await probeWebuiEngine('http://example.invalid/health', { fetchImpl });
    assert.deepEqual(result, { answered: true, live: true, cause: null });
  });

  it('a non-2xx response is unanswered, with the status as the cause', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503 });
    const result = await probeWebuiEngine('http://example.invalid/health', { fetchImpl });
    assert.equal(result.answered, false);
    assert.equal(result.cause, 'http-503');
  });

  it('a network error is unanswered', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const result = await probeWebuiEngine('http://example.invalid/health', { fetchImpl });
    assert.equal(result.answered, false);
    assert.equal(result.cause, 'ECONNREFUSED');
  });

  it('a request that never resolves is unanswered once the timeout fires', async () => {
    const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const result = await probeWebuiEngine('http://example.invalid/health', { fetchImpl, timeoutMs: 20 });
    assert.equal(result.answered, false);
    assert.equal(result.cause, 'timed-out');
  });
});

describe('probeTmuxEngine — against a real tmux session (#109)', () => {
  const sessionName = uniqueSessionName('tc-engine-health');
  let created = false;

  after(() => {
    if (created) {
      try { execFileSync('tmux', ['kill-session', '-t', sessionName]); } catch { /* already gone */ }
    }
  });

  it('a live session is answered and live, and captures pane output', () => {
    execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24']);
    created = true;
    const result = probeTmuxEngine(sessionName);
    assert.equal(result.answered, true);
    assert.equal(result.live, true);
    assert.ok(Array.isArray(result.lines), 'a live, capturable pane should return captured lines');
  });

  it('a session killed without going through this module reads CRASHED-shaped: answered, not live', () => {
    execFileSync('tmux', ['kill-session', '-t', sessionName]);
    created = false;
    const result = probeTmuxEngine(sessionName);
    assert.equal(result.answered, true);
    assert.equal(result.live, false);
    assert.equal(result.lines, null);
  });

  it('a session that never existed reads the same as one that just crashed', () => {
    const result = probeTmuxEngine(uniqueSessionName('tc-engine-health-never-existed'));
    assert.equal(result.answered, true);
    assert.equal(result.live, false);
  });
});

describe('engine-health-routes — HTTP surface (#109)', () => {
  let tmpDir;
  let store;
  let server;
  let routes;
  let operatorHeaders;
  let bindProject;
  let openInstallToken;

  /** Headers for a write route on an open (no-login) install: same-origin plus the anti-forgery token. */
  function writeHeaders() {
    return { ...operatorHeaders(server), 'x-tc-open-token': openInstallToken.mint() };
  }

  function request(method, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
        headers: { 'Content-Type': 'application/json', ...headers }
      };
      const bodyStr = body !== undefined ? JSON.stringify(body) : null;
      if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  function makeProject(name) {
    const projPath = path.join(tmpDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    return store.projects.create({ name, path: projPath, engine: 'claude' });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-health-routes-'));
    store = require('../lib/store');
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    const config = store.config.load();
    config.deletePassword = null;
    store.config.save(config);
    ({ operatorHeaders, bindProject } = require('./_shared-docs-callers'));
    openInstallToken = require('../lib/open-install-token');
    const serverModule = require('../server');
    routes = require('../lib/routes/engine-health-routes');
    server = serverModule.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });

  after(async () => {
    routes.stopEngineHealthProbeLoop();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Each test gets a clean probe tracker/suppression/telemetry slate —
    // these are module-level (one process, one fleet), so a prior test's
    // strikes must not leak into the next one's assertions.
    routes._tracker.clear();
    routes._suppressed.clear();
    routes._telemetry.length = 0;
  });

  describe('GET /api/sessions/:project/engine-health', () => {
    it('404s for an unknown project', async () => {
      const { status, data } = await request('GET', '/api/sessions/no-such-project/engine-health', undefined, writeHeaders());
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('reports active:false for a project with no session', async () => {
      makeProject('eh-idle');
      const { status, data } = await request('GET', '/api/sessions/eh-idle/engine-health', undefined, writeHeaders());
      assert.equal(status, 200);
      assert.equal(data.active, false);
      assert.equal(data.state, null);
    });

    it('reports a real tmux session\'s probed state without the GET itself perturbing strikes', async () => {
      const project = makeProject('eh-live');
      const sessionName = uniqueSessionName('tc-engine-health-route');
      execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24']);
      const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: sessionName });
      try {
        routes._probeOnce(); // one real probe round against the live tmux session
        const { status, data } = await request('GET', '/api/sessions/eh-live/engine-health', undefined, writeHeaders());
        assert.equal(status, 200);
        assert.equal(data.active, true);
        assert.equal(data.state, STATES.HEALTHY);

        const again = await request('GET', '/api/sessions/eh-live/engine-health', undefined, writeHeaders());
        assert.equal(again.data.strikes, 0, 'reading status must not itself count as a probe');
      } finally {
        try { execFileSync('tmux', ['kill-session', '-t', sessionName]); } catch { /* already gone */ }
        store.sessions.kill(session.id, 'test cleanup');
      }
    });
  });

  describe('POST /api/sessions/:project/engine-health/suppress', () => {
    it('400s without a boolean suppressProbe', async () => {
      makeProject('eh-suppress-bad');
      const { status } = await request('POST', '/api/sessions/eh-suppress-bad/engine-health/suppress', {}, writeHeaders());
      assert.equal(status, 400);
    });

    it('toggles suppression on and off', async () => {
      makeProject('eh-suppress');
      const on = await request('POST', '/api/sessions/eh-suppress/engine-health/suppress', { suppressProbe: true }, writeHeaders());
      assert.equal(on.status, 200);
      assert.equal(on.data.suppressed, true);
      assert.ok(routes._suppressed.has('eh-suppress'));

      const off = await request('POST', '/api/sessions/eh-suppress/engine-health/suppress', { suppressProbe: false }, writeHeaders());
      assert.equal(off.data.suppressed, false);
      assert.ok(!routes._suppressed.has('eh-suppress'));
    });
  });

  describe('POST /api/sessions/:project/engine-failover — never auto-swap (#109)', () => {
    it('refuses without userConfirmed: true, before anything else is checked', async () => {
      const { status, data } = await request(
        'POST', '/api/sessions/no-such-project/engine-failover', { action: 'kill' }, writeHeaders()
      );
      assert.equal(status, 400);
      assert.equal(data.code, 'USER_CONFIRMATION_REQUIRED');
    });

    it('refuses userConfirmed: "true" (a string, not the literal boolean)', async () => {
      const { status, data } = await request(
        'POST', '/api/sessions/no-such-project/engine-failover',
        { action: 'kill', userConfirmed: 'true' }, writeHeaders()
      );
      assert.equal(status, 400);
      assert.equal(data.code, 'USER_CONFIRMATION_REQUIRED');
    });

    it('rejects an unknown action', async () => {
      makeProject('eh-badaction');
      const { status, data } = await request(
        'POST', '/api/sessions/eh-badaction/engine-failover',
        { action: 'teleport', userConfirmed: true }, writeHeaders()
      );
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('rejects a swap with no targetEngine', async () => {
      makeProject('eh-swapnotarget');
      const { status } = await request(
        'POST', '/api/sessions/eh-swapnotarget/engine-failover',
        { action: 'swap', userConfirmed: true }, writeHeaders()
      );
      assert.equal(status, 400);
    });

    it('404s for an unknown project even with userConfirmed: true', async () => {
      const { status, data } = await request(
        'POST', '/api/sessions/no-such-project/engine-failover',
        { action: 'kill', userConfirmed: true }, writeHeaders()
      );
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('"continue-manually" acknowledges without touching the session', async () => {
      const project = makeProject('eh-continue');
      const bound = bindProject(project);
      const { status, data } = await request(
        'POST', '/api/sessions/eh-continue/engine-failover',
        { action: 'continue-manually', userConfirmed: true }, writeHeaders()
      );
      assert.equal(status, 200);
      assert.equal(data.action, 'continue-manually');
      assert.equal(store.sessions.get(bound.sessionId).status, 'active', 'continue-manually must not end the session');
      store.sessions.kill(bound.sessionId, 'test cleanup');
    });

    it('"kill" ends the active session (no real tmux pane needed — killSession tolerates one that never existed)', async () => {
      const project = makeProject('eh-kill');
      const bound = bindProject(project);
      const { status, data } = await request(
        'POST', '/api/sessions/eh-kill/engine-failover',
        { action: 'kill', userConfirmed: true }, writeHeaders()
      );
      assert.equal(status, 200);
      assert.equal(data.killed, true);
      assert.equal(store.sessions.get(bound.sessionId).status, 'killed');
    });

    it('404s "kill" for a project with no active session', async () => {
      makeProject('eh-killidle');
      const { status, data } = await request(
        'POST', '/api/sessions/eh-killidle/engine-failover',
        { action: 'kill', userConfirmed: true }, writeHeaders()
      );
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('"restart" kills the session, then reports the relaunch failure rather than silently losing the kill', async () => {
      // A real relaunch spawns a real engine CLI in a real tmux pane — not
      // something this unit suite does (no test file in this repo launches a
      // real engine through the HTTP route either). `bindProject`'s minimal
      // fixture project has no real checkout a launch can actually start
      // against, so `launchSession` fails closed deterministically. What
      // this proves is the thing this route actually adds: the kill already
      // happened and is reported, not silently swallowed by the relaunch's
      // own failure.
      const project = makeProject('eh-restart');
      const bound = bindProject(project);
      const { status, data } = await request(
        'POST', '/api/sessions/eh-restart/engine-failover',
        { action: 'restart', userConfirmed: true }, writeHeaders()
      );
      assert.equal(store.sessions.get(bound.sessionId).status, 'killed', 'the kill half must have happened regardless of the relaunch outcome');
      if (status !== 200) {
        assert.equal(status, 500);
        assert.equal(data.killedFirst, true);
      }
    });
  });
});
