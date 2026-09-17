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
const { createServer } = require('../server');

/**
 * One JSON request against the test server.
 * @param {object} server - The listening server
 * @param {string} urlPath - Path with query
 * @returns {Promise<{status: number, body: object|null}>}
 */
function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET'
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
    const bind = (proj, applicability = { applicable: true, reason: null }) => {
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

    // One launch whose rules were pulled (no hook row at all), and one with a
    // hook row recorded beside it.
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

  it('keeps the hook record separate, and says when there is none', async () => {
    const res = await get(server, `/api/launch-sequences?projectId=${project.id}`);
    const byId = new Map(res.body.sequences.map((s) => [s.sequenceId, s]));
    assert.equal(byId.get(pulled.sequence.id).hook, null,
      'a launch whose rules were pulled has no hook row, and that is reported as null');
    assert.deepEqual(byId.get(hooked.sequence.id).hook,
      { outcome: 'written', channel: 'rules-hook', skipReason: null });
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

  it('refuses a missing or unusable argument rather than guessing a scope', async () => {
    for (const query of ['', '?projectId=evidence', '?projectId=1&limit=0', '?projectId=1&limit=99']) {
      const res = await get(server, `/api/launch-sequences${query}`);
      assert.equal(res.status, 400, `refused: ${query || '(no query)'}`);
      assert.equal(res.body.code, 'BAD_REQUEST');
    }
  });
});
