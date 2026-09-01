'use strict';

/**
 * Awareness observability (ambient-awareness Chunk 05).
 *
 * "Sessions that never became aware" as a queryable, surfaced state. The
 * 2026-08-18 regression is the specification: eight projects launched
 * antigravity sessions for 12 days with a severed carrier and no surface
 * anywhere turned red, because delivery was asserted rather than observed and
 * awareness was not a state at all.
 *
 * Two layers under test. The store: a per-session state COMPOSED at read time
 * from the two ledgers that already exist — awareness receipts (what the
 * session demonstrated) and the delivery ledger (what a channel was observed
 * to do) — with the § Direction 4 vocabulary: confirmed / sent / unverified,
 * plus `unaware`, the red state. The server: `GET /api/awareness` serving the
 * fleet view the dashboard polls and the Project Master queries.
 *
 * The acceptance criterion of the whole plan is pinned here: a launch whose
 * carrier delivered nothing and whose session demonstrated nothing reads
 * `unaware` — red — from the very first query after the launch.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

/**
 * One JSON GET against the in-process server.
 * @param {object} server - Listening http server
 * @param {string} urlPath
 * @returns {Promise<{status: number, body: object|null}>}
 */
function getJson(server, urlPath) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('awareness state composition (store.awarenessReceipts.sessionAwareness)', () => {
  let tmpDir;
  let project;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-awareness-'));
    store._setBasePath(tmpDir);
    store.init();
    project = store.projects.create({ name: 'aware-p', path: path.join(tmpDir, 'aware-p') });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a receipt makes the session CONFIRMED — awareness demonstrated, not presumed', () => {
    const s = store.sessions.start({ projectId: project.id, engineId: 'antigravity' });
    store.awarenessReceipts.record({
      projectId: project.id, sessionId: s.id, verb: 'whoami', source: 'tc-cli'
    });
    store.awarenessReceipts.record({
      projectId: project.id, sessionId: s.id, verb: 'sessions', source: 'tc-cli'
    });
    const aw = store.awarenessReceipts.sessionAwareness(s.id);
    assert.equal(aw.state, 'confirmed');
    assert.equal(aw.receiptCount, 2);
    assert.equal(aw.lastVerb, 'sessions');
    assert.ok(aw.lastReceiptAt, 'the confirmation is dated');
    assert.match(aw.basis, /invoked tc itself/);
  });

  it('a delivered channel with no receipt is SENT — observed to land, never demonstrated', () => {
    const s = store.sessions.start({ projectId: project.id, engineId: 'claude' });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'claude',
      channel: 'rules-hook', outcome: 'delivered', digest: 'd'
    });
    const aw = store.awarenessReceipts.sessionAwareness(s.id);
    assert.equal(aw.state, 'sent');
    assert.equal(aw.receiptCount, 0);
    assert.match(aw.basis, /rules-hook/);
    assert.match(aw.basis, /never demonstrated/);
  });

  it('a blind send with no receipt is UNVERIFIED, carrying the recorded reason', () => {
    const s = store.sessions.start({ projectId: project.id, engineId: 'antigravity' });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'antigravity',
      channel: 'prime-paste', outcome: 'unverified',
      skipReason: 'at-rest marker never rendered within 90000ms', digest: ''
    });
    const aw = store.awarenessReceipts.sessionAwareness(s.id);
    assert.equal(aw.state, 'unverified');
    assert.match(aw.basis, /blind send/);
    assert.match(aw.basis, /marker never rendered/);
  });

  it('a receipt outranks every delivery row — demonstration beats observation', () => {
    const s = store.sessions.start({ projectId: project.id, engineId: 'antigravity' });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'antigravity',
      channel: 'prime-paste', outcome: 'unverified', skipReason: 'blind', digest: ''
    });
    store.awarenessReceipts.record({
      projectId: project.id, sessionId: s.id, verb: 'ports', source: 'tc-cli'
    });
    assert.equal(store.awarenessReceipts.sessionAwareness(s.id).state, 'confirmed');
  });

  it('delivered outranks unverified when both were recorded', () => {
    const s = store.sessions.start({ projectId: project.id, engineId: 'antigravity' });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'antigravity',
      channel: 'prime-paste', outcome: 'unverified', skipReason: 'first, blind', digest: ''
    });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'antigravity',
      channel: 'prime-paste', outcome: 'delivered', digest: 'd'
    });
    assert.equal(store.awarenessReceipts.sessionAwareness(s.id).state, 'sent');
  });

  it('a no-rules row is NOT the red state — the launch path ran and nothing was owed (#1139)', () => {
    // The row lib/sessions.js writes for a rule-less project exists, per its
    // own comment, to prove "the launch path ran and had nothing to send".
    // Scoring it as unaware discarded that evidence and left 23 projects
    // permanently red for a non-fault no relaunch could clear.
    const s = store.sessions.start({ projectId: project.id, engineId: 'claude' });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'claude',
      channel: 'none', outcome: 'no-rules', digest: ''
    });
    const aw = store.awarenessReceipts.sessionAwareness(s.id);
    assert.equal(aw.state, 'no-rules');
    assert.notEqual(aw.state, 'unaware');
    assert.match(aw.basis, /launch path ran/);
    assert.match(aw.basis, /no active rules/);
    assert.equal(aw.receiptCount, 0);
  });

  it('a skipped row outranks a no-rules row — a failed carrier stays red even when nothing was owed (Critic R-2)', () => {
    // Reachable in production: a rule-less project on a paste-channel engine
    // records no-rules at launch, then the deferred prime paste fails and
    // records skipped. The skip is severed-carrier evidence; "nothing was
    // owed" must not soothe it.
    const s = store.sessions.start({ projectId: project.id, engineId: 'antigravity' });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'antigravity',
      channel: 'none', outcome: 'no-rules', digest: ''
    });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'antigravity',
      channel: 'prime-paste', outcome: 'skipped',
      skipReason: 'tmux session ended before the prime was pasted', digest: ''
    });
    const aw = store.awarenessReceipts.sessionAwareness(s.id);
    assert.equal(aw.state, 'unaware');
    assert.match(aw.basis, /explicitly skipped/);
    assert.match(aw.basis, /prime-paste/);
    assert.match(aw.basis, /no evidence awareness ever arrived/);
  });

  it('a delivery outranks a no-rules row, and a receipt outranks both', () => {
    // A session can carry both (e.g. no startup rules, then a wrap-tier
    // delivery): the stronger evidence wins.
    const s = store.sessions.start({ projectId: project.id, engineId: 'antigravity' });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'antigravity',
      channel: 'none', outcome: 'no-rules', digest: ''
    });
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'antigravity',
      channel: 'prime-paste', outcome: 'delivered', digest: 'd'
    });
    assert.equal(store.awarenessReceipts.sessionAwareness(s.id).state, 'sent');
    store.awarenessReceipts.record({
      projectId: project.id, sessionId: s.id, verb: 'whoami', source: 'tc-cli'
    });
    assert.equal(store.awarenessReceipts.sessionAwareness(s.id).state, 'confirmed');
  });

  it('ACCEPTANCE: a launch with the carrier severed reads UNAWARE from the first query — within one launch, not after 12 days', () => {
    // The simulated regression: the session starts, no channel records a
    // delivery (a severed carrier writes nothing — that is its signature),
    // and the agent never invokes tc because nothing told it tc exists.
    const s = store.sessions.start({ projectId: project.id, engineId: 'antigravity' });
    const aw = store.awarenessReceipts.sessionAwareness(s.id);
    assert.equal(aw.state, 'unaware');
    assert.match(aw.basis, /no evidence awareness ever arrived/);
    // A skip row (an explicit non-delivery) must NOT soften the state: the
    // channel said in words that nothing was sent.
    store.sessionRuleDeliveries.record({
      sessionId: s.id, projectId: project.id, engineId: 'antigravity',
      channel: 'none', outcome: 'skipped', skipReason: 'carrier disabled', digest: ''
    });
    assert.equal(store.awarenessReceipts.sessionAwareness(s.id).state, 'unaware');
  });
});

describe('fleet awareness view (store + GET /api/awareness)', () => {
  let tmpDir;
  let server;
  let aware;
  let severed;
  let awareSession;
  let severedSession;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-awareness-api-'));
    store._setBasePath(tmpDir);
    store.init();

    aware = store.projects.create({ name: 'fleet-aware', path: path.join(tmpDir, 'fa') });
    severed = store.projects.create({ name: 'fleet-severed', path: path.join(tmpDir, 'fs') });
    // A project with no sessions at all — omitted from the view: nothing
    // launched means nothing to be aware.
    store.projects.create({ name: 'fleet-idle', path: path.join(tmpDir, 'fi') });

    awareSession = store.sessions.start({ projectId: aware.id, engineId: 'claude' });
    store.awarenessReceipts.record({
      projectId: aware.id, sessionId: awareSession.id, verb: 'whoami', source: 'tc-cli'
    });
    // The severed launch: one session, zero delivery rows, zero receipts.
    severedSession = store.sessions.start({ projectId: severed.id, engineId: 'antigravity' });

    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fleetAwareness reports each launched project, newest session first, and omits the sessionless one', () => {
    const fleet = store.awarenessReceipts.fleetAwareness();
    const names = fleet.map((p) => p.name);
    assert.ok(names.includes('fleet-aware'));
    assert.ok(names.includes('fleet-severed'));
    assert.ok(!names.includes('fleet-idle'), 'a project that never launched has nothing to be aware');

    const sev = fleet.find((p) => p.name === 'fleet-severed');
    assert.equal(sev.sessions[0].engineId, 'antigravity', 'the SESSION names its engine — which engine goes unaware is the diagnostic');
    assert.equal(sev.sessions[0].id, severedSession.id);
    assert.equal(sev.sessions[0].state, 'unaware');

    const ok = fleet.find((p) => p.name === 'fleet-aware');
    assert.equal(ok.sessions[0].state, 'confirmed');
  });

  it('GET /api/awareness serves the view with the vocabulary spelled out', async () => {
    const res = await getJson(server, '/api/awareness');
    assert.equal(res.status, 200);
    assert.ok(res.body.generatedAt);
    for (const state of ['confirmed', 'sent', 'unverified', 'no-rules', 'unaware']) {
      assert.ok(res.body.states[state], `the response defines '${state}' in words`);
    }
    const sev = res.body.projects.find((p) => p.name === 'fleet-severed');
    assert.ok(sev, 'the severed project is in the surfaced view');
    assert.equal(sev.sessions[0].state, 'unaware');
    assert.match(sev.sessions[0].basis, /no evidence/);
    const ok = res.body.projects.find((p) => p.name === 'fleet-aware');
    assert.equal(ok.sessions[0].state, 'confirmed');
  });

  it('sessionsPerProject is clamped to 1..20 — junk falls back to the default', async () => {
    for (const q of ['?sessionsPerProject=0', '?sessionsPerProject=999', '?sessionsPerProject=junk', '']) {
      const res = await getJson(server, `/api/awareness${q}`);
      assert.equal(res.status, 200, `query '${q}' still answers`);
      assert.ok(res.body.projects.every((p) => p.sessions.length <= 3), `query '${q}' respects the default cap`);
    }
    // A valid override widens the window.
    store.sessions.start({ projectId: severed.id, engineId: 'antigravity' });
    store.sessions.start({ projectId: severed.id, engineId: 'antigravity' });
    store.sessions.start({ projectId: severed.id, engineId: 'antigravity' });
    const wide = await getJson(server, '/api/awareness?sessionsPerProject=4');
    const sev = wide.body.projects.find((p) => p.name === 'fleet-severed');
    assert.equal(sev.sessions.length, 4);
    const dflt = await getJson(server, '/api/awareness');
    const sevD = dflt.body.projects.find((p) => p.name === 'fleet-severed');
    assert.equal(sevD.sessions.length, 3);
  });

  it('a store failure during claimed-project resolution is NAMED, not silently filed as unresolved', async () => {
    // The rider's shape: `resolveClaimedProject` used to bare-catch store
    // failures into `project = null`, so a broken lookup filed receipts in the
    // null bucket indistinguishably from a genuinely wrong id. The answer must
    // still come back (the invocation happened and must be recorded), but the
    // failure must be observable.
    const logger = require('../lib/logger');
    const lines = [];
    const realGet = store.projects.get;
    logger.setLevel('warn');
    logger.setConsoleStream({ write: (s) => lines.push(s) });
    store.projects.get = () => { throw new Error('synthetic store failure'); };
    try {
      const res = await getJson(server, `/api/tc/whoami?projectId=${aware.id}`);
      assert.equal(res.status, 200, 'the answer must not go down with the ledger');
      assert.equal(res.body.project, null, 'the id resolves to nothing when the store cannot answer');
      const warned = lines.join('');
      assert.match(warned, /claimed-project lookup failed/);
      assert.match(warned, /synthetic store failure/);
    } finally {
      store.projects.get = realGet;
      logger.setConsoleStream(null);
      logger.setLevel('error');
    }
  });

  it('a store failure resolving a roster project name is NAMED too — the last member of the bare-catch family', async () => {
    // GET /api/tc/sessions was the one remaining sibling of the pattern above:
    // a store failure rendered every session anonymous with nothing saying why.
    const logger = require('../lib/logger');
    const lines = [];
    const realGet = store.projects.get;
    logger.setLevel('warn');
    logger.setConsoleStream({ write: (s) => lines.push(s) });
    store.projects.get = () => { throw new Error('synthetic roster failure'); };
    try {
      const res = await getJson(server, '/api/tc/sessions');
      assert.equal(res.status, 200, 'the roster must not go down with the name lookup');
      assert.ok(res.body.sessions.length > 0, 'live sessions still listed');
      assert.ok(res.body.sessions.every((s) => s.projectName === null));
      assert.match(lines.join(''), /project-name lookup failed for tc sessions roster/);
      assert.match(lines.join(''), /synthetic roster failure/);
    } finally {
      store.projects.get = realGet;
      logger.setConsoleStream(null);
      logger.setLevel('error');
    }
  });

  it('an archived project leaves the view', () => {
    store.projects.archive(severed.id);
    try {
      const fleet = store.awarenessReceipts.fleetAwareness();
      assert.ok(!fleet.some((p) => p.name === 'fleet-severed'));
    } finally {
      store.projects.unarchive(severed.id);
    }
  });
});

describe('dashboard awareness rendering (public/ui.js, lifted like card-detail-disclosure)', () => {
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

  /**
   * Slice out a top-level function body by brace-matching (same mechanic as
   * test/card-detail-disclosure.test.js — a source guard over markup stays
   * green against a dead branch, so the renderers are RUN).
   * @param {string} decl - The declaration to find.
   * @returns {string} The body including braces.
   */
  function functionBody(decl) {
    const start = uiSrc.indexOf(decl);
    assert.notEqual(start, -1, `${decl} must exist`);
    const bodyStart = uiSrc.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < uiSrc.length; i++) {
      if (uiSrc[i] === '{') depth++;
      else if (uiSrc[i] === '}' && --depth === 0) return uiSrc.slice(bodyStart, i + 1);
    }
    assert.fail(`${decl} body must close`);
  }

  /**
   * Lift a renderer out of ui.js and run it with its free variables supplied.
   * @param {string} decl - The declaration.
   * @param {object} scope - Free variables by name.
   * @returns {Function}
   */
  function lift(decl, scope) {
    const names = Object.keys(scope);
    // eslint-disable-next-line no-new-func
    return new Function(...names, `return function (project) ${functionBody(decl)}`)(
      ...names.map((n) => scope[n])
    );
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const stateWith = (sessions) => ({ awareness: { 7: { projectId: 7, sessions } } });
  const project = { id: 7, name: 'P' };

  it('the badge renders ONLY for an unaware latest session, glyph+text, basis in the title', () => {
    const badge = (sessions) => lift('function renderAwarenessBadge(project)', {
      esc, state: stateWith(sessions)
    })(project);
    const red = badge([{ state: 'unaware', basis: 'no evidence awareness ever arrived' }]);
    assert.match(red, /badge-unaware/);
    assert.match(red, /&#9888;/, 'the glyph pairs with text — never colour alone');
    assert.match(red, /unaware/);
    assert.match(red, /title="no evidence awareness ever arrived"/);
    for (const state of ['confirmed', 'sent', 'unverified']) {
      assert.equal(badge([{ state, basis: 'x' }]), '', `'${state}' renders no badge — badge-noise rule`);
    }
    assert.equal(badge([]), '', 'no sessions, no badge');
    // Only the LATEST session drives the badge — an old unaware launch behind
    // a confirmed one is history, not an alarm.
    assert.equal(badge([{ state: 'confirmed', basis: 'x' }, { state: 'unaware', basis: 'y' }]), '');
  });

  it('the detail row names the state with the matching class and the basis in words', () => {
    const detail = (sessions) => lift('function renderAwarenessDetail(project)', {
      esc, state: stateWith(sessions)
    })(project);
    const ok = detail([{ state: 'confirmed', basis: 'the session invoked tc itself' }]);
    assert.match(ok, /rules-status-ok/);
    assert.match(ok, /confirmed/);
    assert.match(ok, /invoked tc itself/);
    assert.match(detail([{ state: 'unaware', basis: 'b' }]), /rules-status-err/);
    assert.match(detail([{ state: 'sent', basis: 'b' }]), /rules-status-warn/);
    assert.match(detail([{ state: 'unverified', basis: 'b' }]), /rules-status-warn/);
    assert.equal(detail([]), '', 'never launched — no row, not a fabricated state');
  });

  it('renderCard emits the badge and renderCardDetail emits the row — the helpers are wired, not stranded', () => {
    // A lifted-and-run helper plus a template that never calls it is exactly
    // the dead-branch hazard the lift mechanic exists to avoid; pin the wiring.
    assert.match(functionBody('function renderCard(project)'), /renderAwarenessBadge\(project\)/);
    assert.match(uiSrc, /\$\{awarenessBadge\}/);
    assert.match(functionBody('function renderCardDetail(project)'), /renderAwarenessDetail\(project\)/);
    assert.match(uiSrc, /Awareness<\/span>/);
  });

  it('the landing poll fetches /api/awareness and keys the map by projectId', () => {
    const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
    assert.match(landing, /api\('\/api\/awareness'\)/);
    assert.match(landing, /state\.awareness = Object\.fromEntries/);
  });
});
