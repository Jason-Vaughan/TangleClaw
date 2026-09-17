'use strict';

/**
 * The launch sequence (Train 21, Chunk 01): the frozen snapshot, the ack
 * protocol, pagination, and the launch-id handshake.
 *
 * The acceptance cases these pin come from the plan's Chunk 01 list. The ones
 * that matter most are the ones a happy path never reaches: a lost response
 * replayed, an ack from a superseded revision, an ack for a step whose pages
 * were never served, and a session row that fails to write after the pane has
 * already started.
 */

const { describe, it, before, beforeEach, after } = require('node:test');
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

describe('launch sequence (Train 21, Chunk 01)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-seq-'));
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
   * Create a project with its own directory.
   * @param {string} name - Project and directory name
   * @param {string} [engine] - Engine id
   * @returns {object} The project record
   */
  function makeProject(name, engine = 'claude') {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return store.projects.create({ name, path: dir, engine });
  }

  /**
   * Launch a project with tmux and engine detection stubbed out, so no real
   * pane or engine process is ever started (#902).
   * @param {string} name - Project name
   * @param {object} [opts]
   * @param {(() => boolean)} [opts.createSession] - Stub for `tmux.createSession`
   * @param {(name: string) => boolean} [opts.hasSession] - Stub for `tmux.hasSession`
   * @param {(name: string) => boolean} [opts.killSession] - Stub for `tmux.killSession`
   * @param {object} [opts.launchOptions] - Passed to `launchSession`
   * @returns {object} The launch result
   */
  function launch(name, opts = {}) {
    const real = {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
    };
    tmux.createSession = opts.createSession || (() => true);
    tmux.hasSession = opts.hasSession || (() => false);
    tmux.killSession = opts.killSession || (() => true);
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    try {
      return sessions.launchSession(name, opts.launchOptions || {});
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  /**
   * Drive one `next` call.
   * @param {object} args - As for `launchSequence.next`
   * @returns {{status: number, body: object}}
   */
  const next = (args) => launchSequence.next(args);

  describe('pagination', () => {
    it('keeps a whole step on one page when it fits', () => {
      assert.deepEqual(launchSequence.paginate('short body', 100), [[0, 10]]);
    });

    it('breaks on a paragraph boundary when one is available', () => {
      const content = `${'a'.repeat(40)}\n\n${'b'.repeat(40)}`;
      const pages = launchSequence.paginate(content, 50);
      assert.equal(pages.length, 2);
      assert.equal(content.slice(...pages[0]), `${'a'.repeat(40)}\n\n`);
      assert.equal(content.slice(...pages[1]), 'b'.repeat(40));
    });

    it('splits an oversize paragraph on a line boundary, then on characters', () => {
      const lines = `${'x'.repeat(30)}\n${'y'.repeat(30)}\n${'z'.repeat(30)}`;
      const byLine = launchSequence.paginate(lines, 40);
      assert.ok(byLine.length > 1);
      assert.ok(lines.slice(...byLine[0]).endsWith('\n'), 'a line boundary ends the page');

      const unbroken = 'q'.repeat(250);
      const byChar = launchSequence.paginate(unbroken, 100);
      assert.deepEqual(byChar, [[0, 100], [100, 200], [200, 250]]);
    });

    it('never splits a surrogate pair', () => {
      const content = `${'a'.repeat(9)}😀${'b'.repeat(20)}`;
      const pages = launchSequence.paginate(content, 10);
      for (const [start, end] of pages) {
        const slice = content.slice(start, end);
        assert.ok(!/[\ud800-\udbff]$/.test(slice), 'no page ends on a lone high surrogate');
      }
      assert.equal(pages.map(([s, e]) => content.slice(s, e)).join(''), content);
    });

    it('marks a page that starts mid-paragraph as continued', () => {
      const content = 'p'.repeat(150);
      const pages = launchSequence.paginate(content, 100);
      assert.equal(launchSequence.pageIsContinued(content, pages[0][0]), false);
      assert.equal(launchSequence.pageIsContinued(content, pages[1][0]), true);
    });

    it('budgets pages against the engine\'s declared tool-output limit, footer included', () => {
      const declared = launchSequence.resolveToolOutput({ capabilities: { toolOutput: { maxChars: 20000 } } });
      assert.deepEqual(declared, { maxChars: 20000, measured: true, reason: null });
      assert.equal(launchSequence.pageBudgetFor(20000), 20000 - launchPage.pageOverhead());

      const undeclared = launchSequence.resolveToolOutput({ id: 'aider', capabilities: {} });
      assert.equal(undeclared.maxChars, launchSequence.DEFAULT_TOOL_OUTPUT_MAX_CHARS);
      assert.equal(undeclared.measured, false);
      assert.match(undeclared.reason, /no measured tool-output limit/);
    });

    it('a printed page never exceeds the engine\'s limit', () => {
      const maxChars = 2000;
      const budget = launchSequence.pageBudgetFor(maxChars);
      const content = 'word '.repeat(2000);
      for (const [start, end] of launchSequence.paginate(content, budget)) {
        const printed = launchPage.renderPage({
          step: { index: 1, id: 'governance', of: 4 },
          page: { index: 0, of: 9, continued: true },
          revision: 1,
          content: content.slice(start, end),
          ack: { command: launchPage.ackCommand('governance', 1, 'a'.repeat(16)) }
        });
        assert.ok(printed.length <= maxChars, `a printed page fits: ${printed.length} <= ${maxChars}`);
      }
    });
  });

  describe('applicability', () => {
    it('follows the engine\'s declaration, never its name', () => {
      assert.deepEqual(launchSequence.resolveApplicability({ id: 'x', capabilities: { launchSequence: { supported: true } } }),
        { applicable: true, reason: null });
      const off = launchSequence.resolveApplicability({ id: 'openclaw', capabilities: { launchSequence: { supported: false, reason: 'remote side' } } });
      assert.deepEqual(off, { applicable: false, reason: 'remote side' });
      const silent = launchSequence.resolveApplicability({ id: 'mystery', capabilities: {} });
      assert.equal(silent.applicable, false, 'an engine that declares nothing is not assumed to run tc');
      assert.match(silent.reason, /does not declare launch-sequence support/);
    });

    it('records whether the page size rests on a measurement or on the default', () => {
      // The disclosure the engine guide and the changelog promise: an engine
      // nobody has measured must not present its assumed limit as a fact.
      const measured = makeProject('tool-measured');
      const measuredSeq = store.launchSequences.getBySession(launch('tool-measured').session.id);
      assert.equal(measuredSeq.sourceManifest.toolOutput.measured, true);
      assert.equal(measuredSeq.sourceManifest.toolOutput.reason, null);
      assert.ok(measuredSeq.pageBudget > 0 && measuredSeq.pageBudget < measuredSeq.sourceManifest.toolOutput.maxChars,
        'the page budget is the declared limit less the printed footer');
      const shown = launchSequence.status({ launchId: measuredSeq.launchId, projectId: measured.id }).body;
      assert.equal(shown.toolOutput.measured, true);
      assert.equal(shown.pageBudget, measuredSeq.pageBudget);

      store.engines.save({
        id: 'unmeasured-engine',
        name: 'Unmeasured Engine',
        command: 'unmeasured',
        capabilities: { supportsPrimePrompt: true, launchSequence: { supported: true } }
      });
      const assumed = makeProject('tool-assumed', 'unmeasured-engine');
      const assumedSeq = store.launchSequences.getBySession(launch('tool-assumed').session.id);
      assert.equal(assumedSeq.sourceManifest.toolOutput.measured, false);
      assert.equal(assumedSeq.sourceManifest.toolOutput.maxChars, launchSequence.DEFAULT_TOOL_OUTPUT_MAX_CHARS);
      const assumedStatus = launchSequence.status({ launchId: assumedSeq.launchId, projectId: assumed.id }).body;
      assert.equal(assumedStatus.toolOutput.measured, false);
      assert.match(assumedStatus.toolOutput.reason, /no measured tool-output limit/);
      assert.deepEqual(assumedStatus.pending.stages, ['ready', 'unready', 'recovery']);
    });

    it('a launch survives steps that cannot be rendered, and says why it has no sequence', () => {
      // The documented guarantee that nothing blocks a launch. Driven by making
      // a read the pull path depends on fail, not by stubbing the renderer.
      const project = makeProject('render-fails');
      const realLoad = store.globalRules.load;
      store.globalRules.load = () => { throw new Error('global rules unreadable'); };
      let result;
      try {
        result = launch('render-fails');
      } finally {
        store.globalRules.load = realLoad;
      }
      assert.equal(result.error, null, 'the launch still happened');
      const sequence = store.launchSequences.getBySession(result.session.id);
      assert.equal(sequence.applicability, 'not-applicable');
      assert.match(sequence.notApplicableReason, /could not be built \(global rules unreadable\)/);
      assert.equal(store.launchSequences.listSteps(sequence.id, 1).length, 0);
      const refused = next({ launchId: sequence.launchId, projectId: project.id });
      assert.equal(refused.body.code, 'SEQUENCE_NOT_APPLICABLE');
      assert.match(refused.body.error, /could not be built/);
    });

    it('a launch with its prime disabled gets no sequence either', () => {
      const out = launchSequence.resolveApplicability(
        { id: 'claude', capabilities: { launchSequence: { supported: true } } },
        'the prime prompt is disabled for this launch'
      );
      assert.deepEqual(out, { applicable: false, reason: 'the prime prompt is disabled for this launch' });
    });
  });

  describe('the handshake', () => {
    it('binds the launch id in the transaction that creates the session row', () => {
      const project = makeProject('bind-ok');
      const result = launch('bind-ok');
      assert.equal(result.error, null);

      const sequence = store.launchSequences.getBySession(result.session.id);
      assert.ok(sequence, 'the session carries a sequence');
      assert.equal(sequence.projectId, project.id);
      assert.equal(sequence.applicability, 'applicable');
      assert.equal(sequence.cursor, 0);
      assert.equal(store.launchSequences.listSteps(sequence.id, 1).length, 4);
      assert.match(sequence.launchId, launchSequence.LAUNCH_ID_PATTERN);
    });

    it('exports the launch id into the pane, where tc reads it', () => {
      makeProject('bind-env');
      let captured = null;
      launch('bind-env', { createSession: (_name, opts) => { captured = opts.env; return true; } });
      const sequence = store.launchSequences.getBySession(store.sessions.getActive(store.projects.getByName('bind-env').id).id);
      assert.equal(captured.TANGLECLAW_LAUNCH_ID, sequence.launchId);
    });

    it('an unbound launch id is a retryable refusal, and resolves once it is bound', () => {
      const unbound = next({ launchId: launchSequence.mintLaunchId(), projectId: 1 });
      assert.equal(unbound.status, 409);
      assert.equal(unbound.body.code, 'LAUNCH_NOT_BOUND');
      assert.equal(unbound.body.retryAfterMs, launchSequence.NOT_BOUND_RETRY_MS);

      const project = makeProject('bind-later');
      const result = launch('bind-later');
      const sequence = store.launchSequences.getBySession(result.session.id);
      const bound = next({ launchId: sequence.launchId, projectId: project.id });
      assert.equal(bound.status, 200, 'the same shape of call succeeds once the row exists');
    });

    it('a tmux failure never reaches tc: no session, no sequence', () => {
      const project = makeProject('tmux-fails');
      const before = store.getDb().prepare('SELECT COUNT(*) AS n FROM launch_sequences').get().n;
      const result = launch('tmux-fails', { createSession: () => false });
      assert.match(result.error, /Failed to create tmux session/);
      assert.equal(result.session, null);
      assert.equal(store.sessions.getActive(project.id), null, 'no session row');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM launch_sequences').get().n, before,
        'and no sequence row');
    });

    it('a bind failure after tmux started kills the pane and reports it', () => {
      const project = makeProject('bind-fails');
      const realStart = store.sessions.start;
      store.sessions.start = () => { throw new Error('disk full'); };
      let killed = null;
      try {
        const result = launch('bind-fails', { killSession: (name) => { killed = name; return true; } });
        assert.equal(result.session, null);
        assert.equal(result.code, 'LAUNCH_BIND_FAILED');
        assert.match(result.error, /disk full/);
        assert.match(result.error, /Nothing is running/);
      } finally {
        store.sessions.start = realStart;
      }
      assert.equal(killed, tmux.toSessionName('bind-fails'), 'the orphan pane was killed');
      assert.equal(store.sessions.getActive(project.id), null);
    });

    it('a pane that survives the kill is reported as an orphan, by name', () => {
      makeProject('bind-orphan');
      const realStart = store.sessions.start;
      store.sessions.start = () => { throw new Error('disk full'); };
      try {
        const result = launch('bind-orphan', {
          killSession: () => false,
          hasSession: (name) => name === tmux.toSessionName('bind-orphan')
        });
        assert.equal(result.code, 'ORPHANED_LAUNCH');
        assert.match(result.error, /tmux session "bind-orphan" is running with no session record/);
      } finally {
        store.sessions.start = realStart;
      }
    });

    it('a pane launched before phased launch keeps read-only discovery and refuses to advance', () => {
      const legacy = launchSequence.status({ launchId: null, projectId: 1 });
      assert.equal(legacy.status, 200);
      assert.equal(legacy.body.sequence, 'none');
      assert.match(legacy.body.reason, /predates phased launch/);

      const mutating = next({ launchId: null, projectId: 1 });
      assert.equal(mutating.status, 409);
      assert.equal(mutating.body.code, 'LAUNCH_ID_REQUIRED');
    });

    it('refuses a launch id whose project or session does not match', () => {
      const project = makeProject('mismatch');
      const result = launch('mismatch');
      const sequence = store.launchSequences.getBySession(result.session.id);

      const wrongProject = next({ launchId: sequence.launchId, projectId: project.id + 5000 });
      assert.equal(wrongProject.body.code, 'SEQUENCE_SESSION_MISMATCH');

      store.sessions.wrap(result.session.id, 'done');
      const ended = next({ launchId: sequence.launchId, projectId: project.id });
      assert.equal(ended.status, 409);
      assert.equal(ended.body.code, 'SESSION_ENDED');
      assert.equal(launchSequence.status({ launchId: sequence.launchId, projectId: project.id }).body.code, 'SESSION_ENDED');
    });

    it('an engine with no launch-sequence support says so instead of serving nothing', () => {
      // An engine profile that declares nothing about launch sequences: the
      // honest default is "no sequence", with the reason said out loud.
      store.engines.save({
        id: 'undeclared-engine',
        name: 'Undeclared Engine',
        command: 'undeclared',
        capabilities: { supportsPrimePrompt: true }
      });
      const project = makeProject('no-sequence', 'undeclared-engine');
      const result = launch('no-sequence');
      const sequence = store.launchSequences.getBySession(result.session.id);
      assert.equal(sequence.applicability, 'not-applicable');
      assert.equal(store.launchSequences.listSteps(sequence.id, 1).length, 0);

      const refused = next({ launchId: sequence.launchId, projectId: project.id });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'SEQUENCE_NOT_APPLICABLE');
      assert.match(refused.body.error, /does not declare launch-sequence support/);

      const status = launchSequence.status({ launchId: sequence.launchId, projectId: project.id });
      assert.equal(status.body.applicability, 'not-applicable');
    });
  });

  describe('serving and acknowledging', () => {
    let project;
    let sequence;

    beforeEach(() => {
      const name = `serve-${Math.random().toString(36).slice(2, 8)}`;
      project = makeProject(name);
      store.sessionRules.create({ projectId: project.id, content: 'A rule the governance step carries.' });
      const result = launch(name);
      sequence = store.launchSequences.getBySession(result.session.id);
    });

    /** Serve every page of the cursor step and return the last envelope. */
    const readWholeStep = () => {
      let body = next({ launchId: sequence.launchId, projectId: project.id }).body;
      while (body.next === 'page') {
        body = next({ launchId: sequence.launchId, projectId: project.id }).body;
      }
      return body;
    };

    /** Acknowledge the step an envelope's ack block describes. */
    const ackFrom = (body, overrides = {}) => next({
      launchId: sequence.launchId,
      projectId: project.id,
      ack: { step: body.step.id, revision: body.revision, digest: body.ack.digest, ...overrides }
    });

    it('serves the steps in order and advances only on an ack', () => {
      const first = next({ launchId: sequence.launchId, projectId: project.id }).body;
      assert.equal(first.schema, launchSequence.LAUNCH_SCHEMA);
      assert.equal(first.step.id, 'identity');
      assert.equal(first.step.of, 4);
      assert.equal(first.status.cursor, 0);

      const served = readWholeStep();
      assert.ok(served.ack, 'the last page carries the ack');
      assert.equal(served.next, 'step');
      assert.equal(store.launchSequences.getByLaunchId(sequence.launchId).cursor, 0, 'serving never advances');

      const advanced = ackFrom(served);
      assert.equal(advanced.status, 200);
      assert.equal(advanced.body.step.id, 'governance');
      assert.equal(advanced.body.status.cursor, 1);
    });

    it('carries the ack only on a step\'s last page', () => {
      const budgeted = store.launchSequences.getByLaunchId(sequence.launchId);
      // Re-page the identity step small enough to need several pages.
      const step = store.launchSequences.listSteps(budgeted.id, 1)[0];
      const offsets = launchSequence.paginate(step.content, 200);
      store.getDb().prepare(
        'UPDATE launch_sequence_steps SET page_offsets = ?, page_count = ? WHERE sequence_id = ? AND revision = 1 AND step_index = 0'
      ).run(JSON.stringify(offsets), offsets.length, budgeted.id);

      const first = next({ launchId: sequence.launchId, projectId: project.id }).body;
      assert.ok(first.page.of > 1, 'the step spans several pages');
      assert.equal(first.ack, null, 'no ack on a page that is not the last');
      assert.equal(first.next, 'page');
      const last = readWholeStep();
      assert.ok(last.ack.command.startsWith('tc start next --ack identity:1:'));
    });

    it('refuses an ack while any page is unserved, and names the pages', () => {
      const seq = store.launchSequences.getByLaunchId(sequence.launchId);
      const step = store.launchSequences.listSteps(seq.id, 1)[0];
      const offsets = launchSequence.paginate(step.content, 200);
      store.getDb().prepare(
        'UPDATE launch_sequence_steps SET page_offsets = ?, page_count = ? WHERE sequence_id = ? AND revision = 1 AND step_index = 0'
      ).run(JSON.stringify(offsets), offsets.length, seq.id);

      next({ launchId: sequence.launchId, projectId: project.id });
      const refused = next({
        launchId: sequence.launchId,
        projectId: project.id,
        ack: { step: 'identity', revision: 1, digest: step.digest }
      });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'PAGES_UNSERVED');
      assert.deepEqual(refused.body.missingPages, offsets.map((_, i) => i).slice(1));
      assert.equal(store.launchSequences.getByLaunchId(sequence.launchId).cursor, 0);
    });

    it('re-serves a lost page on request, at any time', () => {
      const seq = store.launchSequences.getByLaunchId(sequence.launchId);
      const step = store.launchSequences.listSteps(seq.id, 1)[0];
      const offsets = launchSequence.paginate(step.content, 200);
      store.getDb().prepare(
        'UPDATE launch_sequence_steps SET page_offsets = ?, page_count = ? WHERE sequence_id = ? AND revision = 1 AND step_index = 0'
      ).run(JSON.stringify(offsets), offsets.length, seq.id);

      const first = next({ launchId: sequence.launchId, projectId: project.id }).body;
      const second = next({ launchId: sequence.launchId, projectId: project.id }).body;
      assert.equal(second.page.index, 1);
      const again = next({ launchId: sequence.launchId, projectId: project.id, page: 0 }).body;
      assert.equal(again.page.index, 0);
      assert.equal(again.content, first.content, 'the same bytes come back');

      const outOfRange = next({ launchId: sequence.launchId, projectId: project.id, page: offsets.length });
      assert.equal(outOfRange.status, 400);
      assert.equal(outOfRange.body.code, 'PAGE_OUT_OF_RANGE');
    });

    it('ignores a page number once an ack has moved to the next step', () => {
      const served = readWholeStep();
      const advanced = next({
        launchId: sequence.launchId,
        projectId: project.id,
        page: 0,
        ack: { step: served.step.id, revision: served.revision, digest: served.ack.digest }
      });
      assert.equal(advanced.status, 200);
      assert.equal(advanced.body.step.id, 'governance');
      assert.equal(advanced.body.page.index, 0, 'the new step starts where it starts');
    });

    it('replays an ack whose response was lost, without advancing twice', () => {
      const served = readWholeStep();
      const first = ackFrom(served);
      assert.equal(first.body.status.cursor, 1);

      const replay = ackFrom(served);
      assert.equal(replay.status, 200, 'a replayed ack is not an error');
      assert.equal(replay.body.status.cursor, 1, 'and it does not advance a second time');
      assert.equal(replay.body.step.id, 'governance', 'it re-serves where the cursor stands');
    });

    it('serialises two identical acks into one advance', () => {
      const served = readWholeStep();
      const results = [ackFrom(served), ackFrom(served)];
      assert.deepEqual(results.map((r) => r.body.status.cursor), [1, 1]);
      const acked = store.launchSequences.listSteps(sequence.id, 1).filter((s) => s.ackedAt);
      assert.equal(acked.length, 1);
    });

    it('refuses an ack from a superseded revision, never as an idempotent success', () => {
      const served = readWholeStep();
      ackFrom(served);
      // Stand in for Chunk 02's re-render: a new revision of the same steps.
      const seq = store.launchSequences.getByLaunchId(sequence.launchId);
      for (const step of store.launchSequences.listSteps(seq.id, 1)) {
        store.getDb().prepare(
          `INSERT INTO launch_sequence_steps (sequence_id, revision, step_index, step_id, content, digest, page_count, page_offsets)
           VALUES (?, 2, ?, ?, ?, ?, ?, ?)`
        ).run(seq.id, step.index, step.id, step.content, step.digest, step.pageCount, JSON.stringify(step.pageOffsets));
      }
      store.getDb().prepare('UPDATE launch_sequences SET revision = 2, cursor = 0 WHERE id = ?').run(seq.id);

      const stale = ackFrom(served);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'SNAPSHOT_REVISED');
      assert.equal(stale.body.revision, 2);
      assert.equal(store.launchSequences.getByLaunchId(sequence.launchId).cursor, 0, 'the cursor did not move');
    });

    it('refuses a mismatched digest without echoing it back', () => {
      const served = readWholeStep();
      const wrong = ackFrom(served, { digest: 'f'.repeat(16) });
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.code, 'ACK_DIGEST_MISMATCH');
      assert.equal(wrong.body.step, 'identity');
      assert.ok(!JSON.stringify(wrong.body).includes(served.ack.digest), 'the real digest is not echoed');
      assert.equal(store.launchSequences.getByLaunchId(sequence.launchId).cursor, 0);
    });

    it('refuses an ack for a step that is not the cursor', () => {
      const seq = store.launchSequences.getByLaunchId(sequence.launchId);
      const governance = store.launchSequences.listSteps(seq.id, 1)[1];
      const ahead = next({
        launchId: sequence.launchId,
        projectId: project.id,
        ack: { step: 'governance', revision: 1, digest: governance.digest }
      });
      assert.equal(ahead.status, 409);
      assert.equal(ahead.body.code, 'ACK_OUT_OF_ORDER');
      assert.equal(ahead.body.cursor, 0);
    });

    it('refuses an unknown step and a malformed ack', () => {
      assert.equal(next({
        launchId: sequence.launchId, projectId: project.id,
        ack: { step: 'nonsense', revision: 1, digest: 'a'.repeat(16) }
      }).body.code, 'UNKNOWN_STEP');
      assert.equal(next({
        launchId: sequence.launchId, projectId: project.id, ack: { step: 'identity' }
      }).body.code, 'BAD_ACK');
    });

    it('reports every step acknowledged, and status tracks the exchange', () => {
      for (let i = 0; i < 4; i++) ackFrom(readWholeStep());
      const done = next({ launchId: sequence.launchId, projectId: project.id });
      assert.equal(done.body.step, null);
      assert.equal(done.body.next, 'ready');
      assert.equal(done.body.status.cursor, 4);

      const status = launchSequence.status({ launchId: sequence.launchId, projectId: project.id }).body;
      assert.equal(status.status.cursor, 4);
      assert.equal(status.steps.filter((s) => s.ackedAt).length, 4);
      assert.equal(status.preflight.verdict, 'not-evaluated');
    });

    it('serves identical frozen bytes after a restart, and keeps its page boundaries when the budget changes', () => {
      const firstPass = readWholeStep();
      const seqId = sequence.id;
      const offsetsBefore = store.launchSequences.listSteps(seqId, 1).map((s) => s.pageOffsets);

      store.close();
      store.init();

      const afterRestart = next({ launchId: sequence.launchId, projectId: project.id, page: firstPass.page.index }).body;
      assert.equal(afterRestart.content, firstPass.content, 'the same bytes are served');
      assert.deepEqual(store.launchSequences.listSteps(seqId, 1).map((s) => s.pageOffsets), offsetsBefore,
        'and the frozen page boundaries are unchanged');

      // A later, different declared budget must not re-page what was frozen.
      const engine = store.engines.get('claude');
      const saved = JSON.parse(JSON.stringify(engine));
      engine.capabilities.toolOutput.maxChars = 3000;
      store.engines.save(engine);
      try {
        const afterBudgetChange = next({ launchId: sequence.launchId, projectId: project.id, page: firstPass.page.index }).body;
        assert.equal(afterBudgetChange.content, firstPass.content);
        assert.deepEqual(store.launchSequences.listSteps(seqId, 1).map((s) => s.pageOffsets), offsetsBefore);
      } finally {
        store.engines.save(saved);
      }
    });

    it('records what was served and what was acknowledged as separate facts', () => {
      const served = readWholeStep();
      const beforeAck = store.launchSequences.listSteps(sequence.id, 1)[0];
      assert.ok(beforeAck.servedAt, 'serving is recorded');
      assert.equal(beforeAck.ackedAt, null, 'and is not an acknowledgement');
      ackFrom(served);
      assert.ok(store.launchSequences.listSteps(sequence.id, 1)[0].ackedAt);
    });

    it('writes no rule-delivery row: the pull has its own evidence', () => {
      const rows = store.sessionRuleDeliveries.listForProject(project.id);
      const before = rows.length;
      ackFrom(readWholeStep());
      assert.equal(store.sessionRuleDeliveries.listForProject(project.id).length, before);
    });
  });

  describe('the snapshot record', () => {
    it('records what it was built from', () => {
      const project = makeProject('manifest');
      const rule = store.sessionRules.create({ projectId: project.id, content: 'Manifest rule.' });
      const result = launch('manifest');
      const sequence = store.launchSequences.getBySession(result.session.id);
      const manifest = sequence.sourceManifest;
      assert.equal(manifest.rules.length, 1);
      assert.equal(manifest.rules[0].id, rule.id);
      assert.match(manifest.rules[0].contentHash, /^[0-9a-f]{64}$/);
      assert.match(manifest.globalRulesHash, /^[0-9a-f]{64}$/);
      assert.equal(manifest.handoffDigest, null);
      assert.equal(manifest.engineConfig.file, 'CLAUDE.md');
    });

    it('survives deleting the session and the project, like the delivery ledgers', () => {
      const project = makeProject('retained');
      const result = launch('retained');
      const sequence = store.launchSequences.getBySession(result.session.id);
      store.sessions.kill(result.session.id, 'test');
      store.projects.delete(project.id);
      assert.ok(store.launchSequences.getByLaunchId(sequence.launchId), 'the sequence row is kept');
      assert.equal(store.launchSequences.listSteps(sequence.id, 1).length, 4);
    });

    it('refuses a sequence that is missing a step rather than stalling at that cursor', () => {
      const project = makeProject('bad-snapshot');
      assert.throws(() => store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        launchSequence: {
          launchId: launchSequence.mintLaunchId(),
          pageBudget: 1000,
          applicability: 'applicable',
          preflight: launchSequence.PREFLIGHT_NOT_EVALUATED,
          sourceManifest: {},
          steps: [{ id: 'identity', content: 'x', digest: 'a', pageOffsets: [[0, 1]] }]
        }
      }), /needs the steps identity, governance, state, task in order/);
      assert.equal(store.sessions.getActive(project.id), null, 'and no session row survives the refusal');
    });
  });
});
