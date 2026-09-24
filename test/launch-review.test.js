'use strict';

/**
 * `tc start review` (#1761): the read-only re-read of an attested launch.
 *
 * A session whose context was cleared or compacted after READY has no other
 * way back to its launch context — `next` has nothing left to pull. What these
 * pin is that the re-read is a PURE read: it serves the frozen snapshot the
 * session attested, and leaves every piece of sequence state (pages served,
 * cursor, revision, readiness) byte-identical, including when the rules have
 * changed since.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');
const launchPage = require('../lib/launch-page');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');

describe('launch review (#1761)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-review-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Launch a fresh project with tmux and engine detection stubbed, so no pane
   * is ever started.
   * @param {string} name - Project name
   * @returns {{project: object, sequence: object, id: {launchId: string, projectId: number}}}
   */
  function launched(name) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    store.sessionRules.create({ projectId: project.id, content: 'A rule the launch carried.' });
    const real = {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
    };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    let result;
    try {
      result = sessions.launchSession(name, {});
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
    const sequence = store.launchSequences.getBySession(result.session.id);
    return { project, sequence, id: { launchId: sequence.launchId, projectId: project.id } };
  }

  /**
   * Serve and acknowledge every step, then attest READY.
   * @param {{launchId: string, projectId: number}} id - The pane's identity
   * @returns {object} The attested sequence row
   */
  function attest(id) {
    for (let guard = 0; guard < store.LAUNCH_STEP_IDS.length * 2; guard++) {
      const seq = store.launchSequences.getByLaunchId(id.launchId);
      if (seq.cursor >= store.launchSequences.listSteps(seq.id, seq.revision).length) break;
      let body = launchSequence.next(id).body;
      while (!body.ack) body = launchSequence.next({ ...id, page: body.page.index + 1 }).body;
      launchSequence.next({ ...id, ack: { step: body.step.id, revision: body.revision, digest: body.ack.digest } });
    }
    const seq = store.launchSequences.getByLaunchId(id.launchId);
    const answer = launchSequence.ready({
      ...id,
      artifact: {
        schema: 'tc.ready/1',
        preflightVerdict: seq.preflight.verdict,
        proposedFirstAction: 'confirm the next chunk with the operator'
      }
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return store.launchSequences.getByLaunchId(id.launchId);
  }

  /**
   * Everything a read must leave alone, as one comparable value.
   * @param {string} launchId - The launch
   * @returns {string}
   */
  function sequenceState(launchId) {
    const seq = store.launchSequences.getByLaunchId(launchId);
    const steps = store.launchSequences.listSteps(seq.id, seq.revision);
    return JSON.stringify({
      cursor: seq.cursor,
      revision: seq.revision,
      readyAt: seq.readyAt,
      readyDigest: seq.readyDigest,
      steps: steps.map((st) => ({
        index: st.index, digest: st.digest, pagesServed: st.pagesServed, servedAt: st.servedAt, ackedAt: st.ackedAt
      }))
    });
  }

  it('refuses before READY and changes nothing, because next still serves the launch', () => {
    const { id } = launched('review-early');
    const before = sequenceState(id.launchId);
    const answer = launchSequence.review(id);
    assert.equal(answer.status, 409);
    assert.equal(answer.body.code, 'NOT_READY');
    assert.match(answer.body.error, /tc start next/);
    assert.equal(sequenceState(id.launchId), before,
      'a refused review marks nothing served — an unserved page shown here and then acked would look served');
  });

  it('walks every page of every step after READY, and every byte is the attested snapshot', () => {
    const { id } = launched('review-walk');
    const attested = attest(id);
    const before = sequenceState(id.launchId);
    const steps = store.launchSequences.listSteps(attested.id, attested.revision);

    let answer = launchSequence.review(id);
    const seen = [];
    for (let guard = 0; guard < 1000; guard++) {
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.equal(answer.body.schema, launchSequence.REVIEW_SCHEMA);
      seen.push(answer.body);
      if (!answer.body.nextRef) break;
      answer = launchSequence.review({ ...id, step: answer.body.nextRef.step, page: answer.body.nextRef.page });
    }
    assert.equal(seen[seen.length - 1].next, 'done');
    for (const step of steps) {
      const pages = seen.filter((b) => b.step.id === step.id);
      assert.equal(pages.length, step.pageOffsets.length, `every page of ${step.id} is reachable`);
      assert.equal(pages.map((b) => b.content).join(''), step.content,
        `${step.id} re-reads exactly the content its digest covers`);
    }
    assert.equal(sequenceState(id.launchId), before,
      'pages served, cursor, revision and readiness are untouched by a full walk');
  });

  it('carries the attestation it re-reads, so the session sees what it already vouched for', () => {
    const { id } = launched('review-attestation');
    const attested = attest(id);
    const body = launchSequence.review({ ...id, step: 'task' }).body;
    assert.equal(body.step.id, 'task');
    assert.equal(body.review.readyAt, attested.readyAt);
    assert.equal(body.review.attestedVerdict, attested.preflight.verdict);
    assert.equal(body.review.attestedFirstAction, 'confirm the next chunk with the operator');
    assert.equal(body.status.ready, true);
    assert.equal(body.ack, undefined, 'a review offers no acknowledgement');
  });

  it('serves the frozen snapshot after a rule change, and does not revise it', () => {
    const { project, id } = launched('review-rule-change');
    const attested = attest(id);
    const frozen = store.launchSequences.listSteps(attested.id, attested.revision)
      .find((st) => st.id === 'governance').content;
    store.sessionRules.create({ projectId: project.id, content: 'A rule added after the attestation.' });

    const body = launchSequence.review({ ...id, step: 'governance' }).body;
    assert.equal(body.revision, attested.revision, 'the snapshot is not re-rendered');
    assert.equal(body.revised, undefined);
    assert.ok(frozen.startsWith(body.content), 'the page is the attested bytes');
    assert.ok(!body.content.includes('A rule added after the attestation.'),
      'a rule that arrived after READY is the rules channel\'s to deliver, not the review\'s');
    assert.equal(store.launchSequences.getByLaunchId(id.launchId).revision, attested.revision);
  });

  it('names a step by number or by id, and refuses one that does not exist', () => {
    const { id } = launched('review-names');
    attest(id);
    assert.equal(launchSequence.review({ ...id, step: 3 }).body.step.id, 'state');
    assert.equal(launchSequence.review({ ...id, step: 'state' }).body.step.id, 'state');
    assert.equal(launchSequence.review(id).body.step.id, 'identity', 'the first step when none is named');
    for (const step of [0, 5, 'sideways']) {
      const refused = launchSequence.review({ ...id, step });
      assert.equal(refused.status, 400, String(step));
      assert.equal(refused.body.code, 'UNKNOWN_STEP', String(step));
    }
    for (const page of [-1, 999, 'x']) {
      const refused = launchSequence.review({ ...id, step: 'identity', page });
      assert.equal(refused.status, 400, String(page));
      assert.equal(refused.body.code, 'PAGE_OUT_OF_RANGE', String(page));
    }
  });

  it('gives the same binding refusals next gives', () => {
    const { id } = launched('review-binding');
    attest(id);
    const other = launched('review-binding-other');

    assert.equal(launchSequence.review({ launchId: id.launchId, projectId: other.project.id }).body.code,
      'SEQUENCE_SESSION_MISMATCH');
    assert.equal(launchSequence.review({ launchId: 'not-a-launch-id', projectId: id.projectId }).body.code,
      'BAD_LAUNCH_ID');
    const unbound = launchSequence.review({ launchId: launchSequence.mintLaunchId(), projectId: id.projectId });
    assert.equal(unbound.body.code, 'LAUNCH_NOT_BOUND');
    assert.equal(unbound.body.retryAfterMs, launchSequence.NOT_BOUND_RETRY_MS);
    const legacy = launchSequence.review({ launchId: null, projectId: id.projectId });
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.code, 'LAUNCH_ID_REQUIRED', 'the code next gives a pane with no launch id');
    assert.match(legacy.body.error, /tc rules/, 'and it names the read that pane does have');

    const seq = store.launchSequences.getByLaunchId(id.launchId);
    store.sessions.kill(seq.sessionId);
    assert.equal(launchSequence.review(id).body.code, 'SESSION_ENDED');
  });

  it('renders a banner that says this is not a new launch, and no acknowledgement', () => {
    const { id } = launched('review-render');
    attest(id);
    const body = launchSequence.review({ ...id, step: 'task' }).body;
    const printed = launchPage.renderReviewPage(body);
    assert.ok(printed.startsWith('[read-only re-read'), 'the banner comes before the content');
    assert.match(printed, /not a new launch/);
    assert.match(printed, /do not re-attest and do not re-emit the resume proposal/);
    assert.match(printed, /still binding/);
    assert.match(printed, /reflects launch time/);
    assert.doesNotMatch(printed, /--ack/);
    assert.match(printed, /\[tc start review · step 4\/4 task · page 1\/\d+ · revision \d+ · read-only\]/);
  });

  it('a review page fits inside the budget the pages were cut to', () => {
    const widest = {
      step: { index: 3, id: 'governance', of: 4 },
      page: { index: 998, of: 999, continued: true },
      revision: 999999,
      content: '',
      review: { readyAt: '2026-09-24 21:58:21' },
      nextRef: { command: launchPage.reviewCommand('governance', 998) }
    };
    assert.ok(launchPage.renderReviewPage(widest).length <= launchPage.pageOverhead(),
      'the frozen page budget covers the review decoration too');
  });
});
