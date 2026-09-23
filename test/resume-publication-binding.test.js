'use strict';

/**
 * A finished wrap binds to the publication the next launch reads (#1675).
 *
 * The seam this covers spans three modules that each passed their own tests
 * while the Resume a launch rendered came from a file no publication vouched
 * for: the wrap stages and publishes, the preflight selects, the prime renders.
 * These drive the real step, the real finalizer, the real preflight and the
 * real renderer end to end, and assert on what the next session is handed.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store.js');
const sessions = require('../lib/sessions.js');
const continuity = require('../lib/continuity.js');
const stageStep = require('../lib/wrap-steps/handoff-stage.js');
const { evaluate } = require('../lib/launch-preflight-context.js');

const tmpDirs = [];
let project;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-resume-bind-'));
  tmpDirs.push(dir);
  store._setBasePath(dir);
  store.init();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-resume-bind-root-'));
  tmpDirs.push(root);
  project = store.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, path: root, engine: 'claude' });
});

after(() => {
  try { store.close(); } catch { /* already closed */ }
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Run a wrap's tail the way `_runClaimedWrap` does: the continuity step's row,
 * the real handoff step, the lifecycle binding and the real finalizer.
 * @param {object} session - A started session row
 * @param {string} runId - The wrap run
 * @param {{currentState: string, nextAction: string}} words - What the continuity step wrote
 * @returns {Promise<object>} The finalizer's account of the handoff
 */
async function wrapWith(session, runId, words) {
  const cw = {
    stepId: 'continuity-write', kind: 'continuity-write', status: 'done', blockers: [],
    output: {
      written: true, ...words,
      freshness: { sha: 'abc1234', branch: 'main', writtenAt: '2026-09-23', tier: 'full' }
    }
  };
  // The index on disk is written by the real step in a real wrap; here it is
  // written to match, so a later divergence is the test's doing, not setup's.
  continuity.writeIndex(project.path, { ...words, freshness: cw.output.freshness });
  const step = await stageStep.run({
    project, session: { id: session.id, engineId: 'claude' }, previousResults: [cw], scope: {}, options: {}, wrapRunId: runId
  });
  const pipelineResult = {
    ok: true, blockedAt: null,
    results: [cw, { stepId: 'handoff-stage', kind: 'handoff-stage', status: step.status, output: step.output, blockers: [] }]
  };
  const handoff = sessions._stagedHandoff(pipelineResult, runId);
  const bound = store.sessions.wrap(session.id, 'summary', { publicationId: handoff.publicationId, wrapRunId: runId });
  return sessions._finalizeHandoff(project, handoff, {
    lifecycleCompleted: bound !== null, publicationBound: bound.publicationBound === true, keepRequested: false, pipelineOk: true
  });
}

/**
 * The prime the next launch would build, handed the preflight's selection
 * exactly as `sessions.launchSession` threads it.
 * @returns {{prompt: string, preflight: object}}
 */
function nextLaunchPrime() {
  const preflight = evaluate(project);
  const prompt = sessions.generatePrimePrompt(project, store.engines.get('claude'), { handoffResume: preflight.handoffResume });
  return { prompt, preflight };
}

/**
 * Start a session for this project.
 * @returns {object}
 */
function startSession() {
  return store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `s-${Math.random().toString(36).slice(2)}` });
}

describe('the next launch resumes from the publication the wrap reported (#1675)', () => {
  it('names the same publication the wrap result named, and renders its text', async () => {
    const session = startSession();
    const reported = await wrapWith(session, 'run-1', { currentState: 'Chunk 03 shipped.', nextAction: 'Plan chunk 04.' });
    assert.equal(reported.state, 'published');

    const { prompt, preflight } = nextLaunchPrime();
    assert.equal(preflight.handoffResume.publicationId, reported.publicationId);
    assert.equal(preflight.handoffResume.digest, reported.digest);
    assert.ok(prompt.includes(`Source: handoff publication \`${reported.publicationId}\` (final, digest ${reported.digest.slice(0, 12)}) from session ${session.id}`), prompt);
    assert.ok(prompt.includes('launch verdict `ok`'));
    assert.ok(prompt.includes('- Where we are: Chunk 03 shipped.'));
    assert.ok(prompt.includes('- Next action: Plan chunk 04.'));
  });

  it('keeps rendering the published text after a later failed run rewrites the continuity index', async () => {
    const session = startSession();
    await wrapWith(session, 'run-1', { currentState: 'Chunk 03 shipped.', nextAction: 'Plan chunk 04.' });
    // What a later wrap that reached its continuity step and then blocked or
    // was cancelled leaves behind: a rewritten index and no publication.
    continuity.writeIndex(project.path, { currentState: 'a blocked wrap wrote this', nextAction: 'act on an unfinished attempt' });

    const { prompt } = nextLaunchPrime();
    assert.ok(prompt.includes('- Next action: Plan chunk 04.'));
    assert.equal(prompt.includes('act on an unfinished attempt'), false,
      'text no publication vouches for must not reach the Resume as the last session\'s record');
  });

  it('labels the handoff OLDER, naming the crashed session, before any proposal (the 1057 shape)', async () => {
    const first = startSession();
    const reported = await wrapWith(first, 'run-1', { currentState: 'Older work.', nextAction: 'Older next.' });
    const crashed = startSession();
    store.sessions.markCrashed(crashed.id, 'tmux session died');

    const { prompt, preflight } = nextLaunchPrime();
    assert.equal(preflight.verdict, 'crash-recovery');
    const older = `This is OLDER than the latest session: session ${crashed.id} (crashed) ran after it`;
    assert.ok(prompt.includes(older), prompt);
    assert.ok(prompt.includes(`\`${reported.publicationId}\``));
    assert.ok(prompt.indexOf(older) < prompt.indexOf('Last session recorded:'), 'provenance comes before the recorded text');
    assert.ok(prompt.includes('launch verdict `crash-recovery`'));
  });
});

describe('what the Resume opens with when there is no publication to vouch (#1675)', () => {
  it('labels the continuity index UNBOUND when the launch selected no publication', () => {
    continuity.writeIndex(project.path, { currentState: 'somewhere', nextAction: 'something' });
    const prompt = sessions.generatePrimePrompt(project, store.engines.get('claude'), { handoffResume: null });
    assert.match(prompt, /Source: the continuity index, UNBOUND/);
    assert.ok(prompt.indexOf('UNBOUND') < prompt.indexOf('- Next action: something'));
  });

  it('offers no Resume at all from a publication with nothing to resume, rather than falling back to the index', () => {
    continuity.writeIndex(project.path, { currentState: 'unrelated', nextAction: 'unrelated' });
    const prompt = sessions.generatePrimePrompt(project, store.engines.get('claude'), {
      handoffResume: {
        publicationId: 'p1', digest: 'd'.repeat(64), kind: 'final', sessionId: 3, stagedAt: 'x', verdict: 'ok',
        newerSession: null, resume: { currentState: null, nextAction: null, freshness: {} }, note: null
      }
    });
    assert.equal(prompt.includes('## Resume'), false);
    assert.equal(prompt.includes('unrelated'), false);
  });

  it('carries the selection\'s note, so a partial resume says what is missing', () => {
    const prompt = sessions.generatePrimePrompt(project, store.engines.get('claude'), {
      handoffResume: {
        publicationId: 'p1', digest: null, kind: 'final', sessionId: 3, stagedAt: '2026-09-23T00:13:21.640Z', verdict: 'ok',
        newerSession: null, resume: { currentState: null, nextAction: 'n', freshness: {} },
        note: 'this wrap recorded no resume'
      }
    });
    assert.ok(prompt.includes('Note: this wrap recorded no resume.'));
    assert.ok(prompt.includes('staged 2026-09-23T00:13:21.640Z'), 'the exact staged time, not only a date');
  });

  it('labels a legacy session summary as not a handoff', () => {
    const session = startSession();
    store.sessions.wrap(session.id, 'the passive summary');
    const prompt = sessions.generatePrimePrompt(project, store.engines.get('claude'), { handoffResume: null });
    assert.ok(prompt.includes(`_A summary recorded on session ${session.id} (wrapped), not a handoff`), prompt);
  });
});
