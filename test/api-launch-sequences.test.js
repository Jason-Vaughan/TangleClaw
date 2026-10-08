'use strict';

/**
 * `GET /api/launch-sequences` (Train 21, car 21.5) — the readiness evidence the
 * settings panel reads.
 *
 * The contract under test is that the three records stay three: the hook
 * ledger's row, what the sequence served, and what the session acknowledged.
 * The route must report an absent hook row as absent rather than omitting the
 * field, because "no record" and "failed" are different facts about a session.
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
const launchSequence = require('../lib/launch-sequence');
const { createServer, _recoveryGateProbeFor } = require('../server');
const recoveryDefault = require('../lib/recovery-default');

/**
 * One JSON request against the test server.
 * @param {object} server - The listening server
 * @param {string} urlPath - Path with query
 * @returns {Promise<{status: number, body: object|null}>}
 */
function get(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET', headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/launch-sequences (car 21.5)', () => {
  let tmpDir;
  let server;
  let project;
  let other;
  let pulled;
  let hooked;
  let bind;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-launch-seq-'));
    store._setBasePath(tmpDir);
    store.init();
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    const sessions = require('../lib/sessions');
    /**
     * Bind a sequence to a new session of a project, without starting a pane.
     * @param {object} proj - Project record
     * @param {object} applicability - `{applicable, reason}`
     * @returns {object} The sequence row
     */
    bind = (proj, applicability = { applicable: true, reason: null }) => {
      const engine = store.engines.get('claude');
      const launchId = launchSequence.mintLaunchId();
      const rendered = applicability.applicable ? sessions.renderLaunchSteps(proj, engine, {}) : null;
      const snapshot = launchSequence.buildSnapshot({
        launchId, project: proj, engineProfile: engine, applicability, rendered, rules: []
      });
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', launchSequence: snapshot });
      return { sequence: store.launchSequences.getBySession(session.id), session };
    };

    const dir = path.join(projectsDir, 'evidence');
    fs.mkdirSync(dir, { recursive: true });
    project = store.projects.create({ name: 'evidence', path: dir, engine: 'claude' });
    const otherDir = path.join(projectsDir, 'elsewhere');
    fs.mkdirSync(otherDir, { recursive: true });
    other = store.projects.create({ name: 'elsewhere', path: otherDir, engine: 'claude' });

    // One launch with no ledger row at all, and one with a rules-hook row
    // recorded beside it.
    pulled = bind(project);
    hooked = bind(project);
    store.sessionRuleDeliveries.record({
      sessionId: hooked.session.id,
      projectId: project.id,
      engineId: 'claude',
      kind: 'startup',
      channel: 'rules-hook',
      ruleIds: [1],
      digest: 'abc',
      outcome: 'written'
    });
    bind(other, { applicable: false, reason: 'the engine declares no launch-sequence support' });

    // #1825 B3: the startupControl evidence of `hooked` — a channel that never
    // started, an automatic attempt that recorded why, and a denied fire by a
    // project that may not fire here.
    store.startupControlChannels.recordUnavailable({
      sessionId: hooked.session.id, sequenceId: hooked.sequence.id, engineId: 'claude', adapter: 'none',
      reason: 'engine_declares_none: engine claude declares no startupControl channel'
    });
    store.startupPrompts.insertFire({
      idempotencyKey: `launch-${hooked.sequence.id}-r1`, projectId: project.id, sessionId: hooked.session.id, sequenceId: hooked.sequence.id,
      promptRevision: 1, promptTextDigest: 'd', policyDigest: 'p', callerKind: 'launch', callerClearance: 'launch-automatic',
      callerProjectId: project.id, outcome: 'unsupported', reasonCode: 'engine_declares_none', reason: 'engine claude declares no startupControl channel'
    });
    store.startupPrompts.insertFire({
      idempotencyKey: 'denied-attempt-0001', projectId: project.id, sessionId: hooked.session.id, sequenceId: hooked.sequence.id,
      promptRevision: 1, promptTextDigest: 'd', policyDigest: 'p', callerKind: 'project', callerClearance: 'project-binding',
      callerProjectId: other.id, outcome: 'denied', reasonCode: 'fire_scope_denied', reason: 'caller is not a listed firer sharing a project group with the target'
    });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('answers a project\'s launches, newest first, and nobody else\'s', async () => {
    const res = await get(server, `/api/launch-sequences?projectId=${project.id}`);
    assert.equal(res.status, 200);
    const ids = res.body.sequences.map((s) => s.sequenceId);
    assert.deepEqual(ids, [hooked.sequence.id, pulled.sequence.id], 'newest first');
    const theirs = await get(server, `/api/launch-sequences?projectId=${other.id}`);
    assert.equal(theirs.body.sequences.length, 1);
    assert.ok(!theirs.body.sequences.some((s) => ids.includes(s.sequenceId)));
  });

  // #1937: each row carries the mode its launch FROZE; the response also says
  // the project's CURRENT mode, which a later change of the setting moves.
  it('reports the project\'s current recovery mode beside the frozen per-launch one', async () => {
    const before = await get(server, `/api/launch-sequences?projectId=${project.id}`);
    assert.equal(before.body.projectRecoveryMode, 'operator', 'the default, when nobody decided and no login is in force');
    // The operator's choice is what moves it. The file saying advisory would
    // not: this install's login is not in force.
    store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
    try {
      const after = await get(server, `/api/launch-sequences?projectId=${project.id}`);
      assert.equal(after.body.projectRecoveryMode, 'advisory');
      assert.equal(after.body.projectRecoverySource, 'chosen');
      assert.ok(after.body.sequences.every((s) => s.recoveryMode === before.body.sequences.find((b) => b.sequenceId === s.sequenceId).recoveryMode),
        'a launch keeps the mode it froze');
    } finally {
      store.getDb().prepare('DELETE FROM project_recovery_state WHERE project_id = ?').run(project.id);
    }
    store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), launchSequence: { recoveryMode: 'advisory' } });
    try {
      const asked = await get(server, `/api/launch-sequences?projectId=${project.id}`);
      assert.equal(asked.body.projectRecoveryMode, 'operator', 'a file saying advisory does not choose it without a login in force');
      assert.equal(asked.body.projectRecoverySource, 'not-armed');
    } finally {
      store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), launchSequence: {} });
    }
    const unknown = await get(server, '/api/launch-sequences?projectId=999999');
    assert.equal(unknown.body.projectRecoveryMode, null, 'no project, no mode to report');
  });

  // #1937: why the project is in its mode, the operator's decision on record,
  // and the file disagreeing with it. The store outranks the file.
  it('reports the source, the operator\'s decision and a file that disagrees with it', async () => {
    const plain = await get(server, `/api/launch-sequences?projectId=${project.id}`);
    assert.equal(plain.body.projectRecoverySource, 'not-armed');
    assert.equal(plain.body.projectRecoveryDiscrepancy, null);
    assert.equal(plain.body.projectRecoveryDecision, null);
    assert.equal(plain.body.projectRecoveryInheritedNotice, null);
    store.projectRecoveryState.recordDecision(project.id, 'operator', 'operator');
    store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), launchSequence: { recoveryMode: 'advisory' } });
    try {
      const pinned = await get(server, `/api/launch-sequences?projectId=${project.id}`);
      assert.equal(pinned.body.projectRecoveryMode, 'operator', 'a file saying advisory does not loosen a pin');
      assert.equal(pinned.body.projectRecoverySource, 'pinned');
      assert.match(pinned.body.projectRecoveryDiscrepancy, /the pin decides/);
      assert.equal(pinned.body.projectRecoveryDecision.pinnedMode, 'operator');
      assert.equal(pinned.body.projectRecoveryDecision.decidedBy, 'operator');
      assert.ok(pinned.body.projectRecoveryDecision.decidedAt);
    } finally {
      store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), launchSequence: {} });
      store.getDb().prepare('DELETE FROM project_recovery_state WHERE project_id = ?').run(project.id);
    }
    const unknown = await get(server, '/api/launch-sequences?projectId=999999');
    for (const field of ['projectRecoverySource', 'projectRecoveryDiscrepancy', 'projectRecoveryDecision', 'projectRecoveryInheritedNotice']) {
      assert.equal(unknown.body[field], null, field);
    }
  });

  // #1937: advisory is the default only while the login is in force. This is
  // the probe `server.js` installs once it is listening, on a real listener,
  // against the real config and user store.
  it('reports the default this install gives, from the login gate as its own listener sees it', async () => {
    const read = async () => {
      const res = await get(server, `/api/launch-sequences?projectId=${project.id}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return [res.body.projectRecoveryMode, res.body.projectRecoverySource, res.body.projectRecoveryGateState];
    };
    // The seeded value, as any save leaves it in a project's file.
    store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), launchSequence: { recoveryMode: 'operator' } });
    const config = store.config.load();
    try {
      assert.deepEqual(await read(), ['operator', 'not-armed', null], 'no probe installed: the gate was not asked');
      recoveryDefault.setGateStateProbe(_recoveryGateProbeFor(server));
      store.config.save({ ...config, authEnabled: false });
      assert.deepEqual(await read(), ['operator', 'not-armed', 'open'], 'an install with no login');
      store.users.create('rosie', 'correct-horse-battery');
      store.config.save({ ...config, authEnabled: true });
      assert.deepEqual(await read(), ['advisory', 'inherited', 'armed'], 'the same project once a login is in force');
      store.config.save({ ...config, authEnabled: false });
      assert.deepEqual(await read(), ['operator', 'not-armed', 'open'], 'and operator-cleared again once it is switched off');
    } finally {
      recoveryDefault.setGateStateProbe(null);
      store.getDb().prepare('DELETE FROM users').run();
      store.config.save(config);
      store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), launchSequence: {} });
    }
  });

  it('keeps the rule-delivery record separate, and says when there is none', async () => {
    const res = await get(server, `/api/launch-sequences?projectId=${project.id}`);
    const byId = new Map(res.body.sequences.map((s) => [s.sequenceId, s]));
    assert.equal(byId.get(pulled.sequence.id).rulesDelivery, null,
      'a launch with no ledger row at all is reported as null, not omitted');
    assert.deepEqual(byId.get(hooked.sequence.id).rulesDelivery,
      { outcome: 'written', channel: 'rules-hook', skipReason: null });
  });

  it('carries the preflight CAUSE, not only its verdict word', async () => {
    // The route sends what the recovery panel renders. Carrying the verdict
    // alone asked an operator to grant a clearance against a cause they could
    // not see, so these three travel with it — and are asserted here because a
    // payload field nothing reads is one a later edit silently drops.
    const res = await get(server, `/api/launch-sequences?projectId=${project.id}`);
    const byId = new Map(res.body.sequences.map((s) => [s.sequenceId, s]));
    const seq = byId.get(pulled.sequence.id);
    assert.ok(seq, 'the sequence is in the listing');
    assert.ok('preflightReason' in seq, 'the reason must reach the panel');
    assert.equal(typeof seq.preflightEvaluationFailed, 'boolean',
      'a witnessed failure is a boolean claim, never undefined');
    assert.equal(typeof seq.preflightEvaluationMissing, 'boolean',
      'and so is "no usable result available" — the weaker of the two');
    assert.equal(seq.preflightEvaluationFailed && seq.preflightEvaluationMissing, false,
      'the two provenance claims are alternatives: witnessing a failure is not the same as lacking a result');
  });

  it('carries the served and acknowledged state per step', async () => {
    const id = { launchId: pulled.sequence.launchId, projectId: project.id };
    const first = launchSequence.next(id).body;
    launchSequence.next({ ...id, ack: { step: first.step.id, revision: first.revision, digest: first.ack.digest } });

    const res = await get(server, `/api/launch-sequences?projectId=${project.id}`);
    const seq = res.body.sequences.find((s) => s.sequenceId === pulled.sequence.id);
    assert.equal(seq.cursor, 1);
    assert.equal(seq.of, store.LAUNCH_STEP_IDS.length);
    assert.equal(seq.readyAt, null);
    assert.equal(seq.unreadyAt, null);
    assert.equal(seq.nudgeCount, 0);
    assert.ok(seq.steps[0].servedAt && seq.steps[0].ackedAt, 'the first step was served and acknowledged');
    assert.equal(seq.steps[1].ackedAt, null);
    assert.equal(seq.steps.every((st) => typeof st.pagesServed === 'number'), true,
      'pages served is a count, not the page list — the panel shows a ratio');
  });

  it('reports a launch that got no sequence, with the reason and no steps', async () => {
    const res = await get(server, `/api/launch-sequences?projectId=${other.id}`);
    const seq = res.body.sequences[0];
    assert.equal(seq.applicability, 'not-applicable');
    assert.equal(seq.notApplicableReason, 'the engine declares no launch-sequence support');
    assert.deepEqual(seq.steps, [], 'a launch with no sequence has nothing served');
    assert.equal(seq.of, 0);
  });

  it('every caller reads which path put the launch\'s context in front of the engine (#1825 B3)', async () => {
    const res = await get(server, `/api/launch-sequences?projectId=${project.id}`);
    for (const s of res.body.sequences) assert.equal(s.startupDelivery, 'legacy', 'these fixtures started no channel');
  });

  it('the operator reads the startupControl block: the channel header, every fire including denied, and whether Fire applies (F5)', async () => {
    const res = await get(server, `/api/launch-sequences?projectId=${project.id}`, { 'x-tangleclaw-client': 'dashboard' });
    assert.equal(res.status, 200);
    const seq = res.body.sequences.find((s) => s.sequenceId === hooked.sequence.id);
    assert.ok(seq.startupControl, 'the block is served to the operator');
    assert.equal(seq.startupControl.channel.state, 'closed');
    assert.equal(seq.startupControl.channel.adapter, 'none');
    assert.match(seq.startupControl.channel.closeReason, /engine_declares_none/);
    assert.equal('adapterState' in seq.startupControl.channel, false, 'the adapter\'s state never leaves the store');
    assert.equal(seq.startupControl.fires.length, 2);
    const outcomes = seq.startupControl.fires.map((f) => f.outcome).sort();
    assert.deepEqual(outcomes, ['denied', 'unsupported']);
    const denied = seq.startupControl.fires.find((f) => f.outcome === 'denied');
    assert.equal(denied.callerProjectId, other.id, 'the operator sees who tried');
    assert.equal(denied.reasonCode, 'fire_scope_denied');
    const automatic = seq.startupControl.fires.find((f) => f.outcome === 'unsupported');
    assert.equal(automatic.callerKind, 'launch');
    assert.equal(automatic.callerClearance, 'launch-automatic');
    assert.equal(seq.startupControl.fireable, false, 'no open channel: nothing to fire at');
    assert.ok(!JSON.stringify(res.body).includes('socketPath'), 'no adapter field anywhere in the body');
    const bare = res.body.sequences.find((s) => s.sequenceId === pulled.sequence.id);
    assert.deepEqual(bare.startupControl, { channel: null, fires: [], fireable: false }, 'a launch with no record says so, as nulls and empties');
  });

  it('a fire sent without a config trust entry is served with its dispatch note, and every other fire with none (#2186)', async () => {
    const NOTE = 'Sent without a trust entry in Codex\'s config for /p: TangleClaw did not grant trust.';
    const row = store.startupPrompts.insertFire({
      idempotencyKey: 'note-key-00000001', projectId: project.id, sessionId: hooked.sequence.sessionId, sequenceId: hooked.sequence.id,
      promptRevision: 99, promptTextDigest: 'd'.repeat(64), policyDigest: 'p'.repeat(64),
      callerKind: 'operator', callerClearance: 'operator-verified', callerProjectId: null,
      outcome: 'pending', reasonCode: null, reason: null
    });
    store.startupPrompts.updateFire(row.id, { outcome: 'dispatching', dispatchNote: NOTE });
    store.startupPrompts.updateFire(row.id, { outcome: 'accepted' });
    store.startupPrompts.updateFire(row.id, { outcome: 'applied' });

    const res = await get(server, `/api/launch-sequences?projectId=${project.id}`, { 'x-tangleclaw-client': 'dashboard' });
    const seq = res.body.sequences.find((s) => s.sequenceId === hooked.sequence.id);
    const noted = seq.startupControl.fires.find((f) => f.id === row.id);
    assert.equal(noted.outcome, 'applied');
    assert.equal(noted.dispatchNote, NOTE, 'the panel is served the note the row carries');
    for (const f of seq.startupControl.fires.filter((x) => x.id !== row.id)) assert.equal(f.dispatchNote, null);
  });

  it('Fire applies exactly to an active session with an open channel, for the operator only', async () => {
    const live = bind(project);
    store.startupControlChannels.open({ sessionId: live.session.id, sequenceId: live.sequence.id, engineId: 'claude', adapter: 'codex', adapterState: { pid: 1, socketPath: '/tmp/x.sock' } });
    const res = await get(server, `/api/launch-sequences?projectId=${project.id}`, { 'x-tangleclaw-client': 'dashboard' });
    const seq = res.body.sequences.find((s) => s.sequenceId === live.sequence.id);
    assert.equal(seq.startupControl.fireable, true);
    assert.equal(seq.startupControl.channel.state, 'open');
    assert.ok(!JSON.stringify(seq).includes('/tmp/x.sock'), 'the socket path is adapter state and stays home');
    store.sessions.kill(live.session.id, 'test');
    const after = await get(server, `/api/launch-sequences?projectId=${project.id}`, { 'x-tangleclaw-client': 'dashboard' });
    assert.equal(after.body.sequences.find((s) => s.sequenceId === live.sequence.id).startupControl.fireable, false, 'an ended session cannot be fired at');
  });

  it('a project-bound or unbound caller gets the rows without the startupControl block (D4: no cross-group oracle)', async () => {
    const unbound = await get(server, `/api/launch-sequences?projectId=${project.id}`);
    assert.equal(unbound.status, 200);
    for (const s of unbound.body.sequences) assert.equal('startupControl' in s, false);
    const bound = await get(server, `/api/launch-sequences?projectId=${project.id}`, {
      'x-tangleclaw-launch-id': pulled.sequence.launchId, 'x-tangleclaw-project-id': String(project.id)
    });
    assert.equal(bound.status, 200);
    for (const s of bound.body.sequences) assert.equal('startupControl' in s, false);
    assert.ok(!JSON.stringify(bound.body).includes('fire_scope_denied'), 'a bound session cannot learn who was denied');
  });

  it('refuses a missing or unusable argument rather than guessing a scope', async () => {
    for (const query of ['', '?projectId=evidence', '?projectId=1&limit=0', '?projectId=1&limit=99']) {
      const res = await get(server, `/api/launch-sequences${query}`);
      assert.equal(res.status, 400, `refused: ${query || '(no query)'}`);
      assert.equal(res.body.code, 'BAD_REQUEST');
    }
  });
});
