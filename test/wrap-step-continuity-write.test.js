'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const step = require('../lib/wrap-steps/continuity-write');
const continuity = require('../lib/continuity');
const transcript = require('../lib/transcript');

describe('continuity-write wrap step (CC-1)', () => {
  let tmpDir;
  let project;
  let origExec;
  let origToday;
  let origClaudeHome;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cwstep-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const projPath = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    project = { id: 1, name: 'demo', path: projPath };
    origExec = step._internal.exec;
    origToday = step._internal.today;
    // Pin the transcript resolver at an absent ~/.claude so the CC-4b cold-tier
    // snapshot is a deterministic, fast honest-skip in these warm-tier tests
    // (the transcript module has its own dedicated suite).
    origClaudeHome = transcript._internal.claudeHome;
    transcript._internal.claudeHome = () => path.join(tmpDir, 'no-claude-home');
    step._internal.today = () => '2026-06-15';
    // Default git stub: HEAD sha + branch.
    step._internal.exec = async (file, args) => {
      if (args.includes('--short')) return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
      if (args.includes('--abbrev-ref')) return { exitCode: 0, stdout: 'feat/cc-1\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    };
  });

  afterEach(() => {
    step._internal.exec = origExec;
    step._internal.today = origToday;
    transcript._internal.claudeHome = origClaudeHome;
  });

  function ctx(previousResults) {
    return { project, previousResults: previousResults || [], step: {}, staged: {}, options: {} };
  }

  it('writes the index from a prior memory-update capture + git facts', async () => {
    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: {
        summary: 'Shipped the spine.',
        nextSteps: '- build CC-2\n- wire grep',
        learnings: 'none'
      } } }
    ]));

    assert.equal(res.ok, true);
    assert.equal(res.status, 'done');
    assert.equal(res.output.written, true);
    assert.equal(res.output.hadCapture, true);

    const idx = continuity.readIndex(project.path);
    assert.equal(idx.currentState, 'Shipped the spine.');
    assert.equal(idx.nextAction, '- build CC-2\n- wire grep');
    assert.equal(idx.freshness.sha, 'abc1234');
    assert.equal(idx.freshness.branch, 'feat/cc-1');
    assert.equal(idx.freshness.writtenAt, '2026-06-15');
  });

  it('picks the most recent capture when several steps carry parsedFields', async () => {
    const res = await step.run(ctx([
      { stepId: 'changelog-update', status: 'done', output: { parsedFields: { summary: 'old' } } },
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 'new', nextSteps: 'go' } } }
    ]));
    assert.equal(res.output.hadCapture, true);
    assert.equal(continuity.readIndex(project.path).currentState, 'new');
  });

  it('degrades honestly when no AI capture is present (mechanical floor)', async () => {
    const res = await step.run(ctx([
      { stepId: 'commit', status: 'done', output: { commitSha: 'abc1234' } }
    ]));
    assert.equal(res.ok, true, 'never blocks the wrap');
    assert.equal(res.output.written, true);
    assert.equal(res.output.hadCapture, false);
    // No judgment content → readIndex treats it as nothing to resume from,
    // but the file still exists on disk with the freshness stamp.
    assert.equal(continuity.readIndex(project.path), null);
    const raw = fs.readFileSync(continuity.indexPath(project.path), 'utf8');
    assert.match(raw, /## Next action\n_⚠ not captured/);
    assert.match(raw, /- sha: abc1234/);
  });

  it('still writes a stamp-less index when git facts are unavailable', async () => {
    step._internal.exec = async () => { throw new Error('not a git repo'); };
    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    assert.equal(res.ok, true);
    const idx = continuity.readIndex(project.path);
    assert.equal(idx.nextAction, 'n');
    assert.equal(idx.freshness.sha, '');
  });

  it('never halts the wrap when the index write itself fails', async () => {
    // Point the project at a path whose store dir cannot be created
    // (a file sits where the .tangleclaw dir would go).
    const badProj = fs.mkdtempSync(path.join(tmpDir, 'bad-'));
    fs.writeFileSync(path.join(badProj, '.tangleclaw'), 'i am a file, not a dir');
    project = { id: 2, name: 'bad', path: badProj };

    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    assert.equal(res.ok, true, 'continuity failure must not block a wrap');
    assert.equal(res.output.written, false);
    assert.ok(res.output.error);
  });

  it('_resolveCapturedFields ignores results without parsedFields', () => {
    const out = step._resolveCapturedFields([
      { stepId: 'lint', status: 'done', output: null },
      { stepId: 'test', status: 'done', output: { capturedText: 'x' } }
    ]);
    assert.equal(out.currentState, '');
    assert.equal(out.nextAction, '');
  });

  // ── CC-7 degraded-wrap tier derivation (pure helpers) ──

  it('_deriveTier: no capture → mechanical-only regardless of plugin governance', () => {
    assert.equal(step._deriveTier(false, true), 'mechanical-only');
    assert.equal(step._deriveTier(false, false), 'mechanical-only');
  });

  it('_deriveTier: capture + plugin-governed → full; capture + non-governed → no-plugin', () => {
    assert.equal(step._deriveTier(true, true), 'full');
    assert.equal(step._deriveTier(true, false), 'no-plugin');
  });

  it('_deriveUncapturedReason: duck-types the skip cause off prior step output', () => {
    assert.equal(step._deriveUncapturedReason([{ stepId: 'ai-content', status: 'skipped', output: { webui: true } }]), 'no AI channel');
    assert.equal(step._deriveUncapturedReason([{ stepId: 'ai-content', status: 'skipped', output: { override: true } }]), 'AI content skipped by operator');
    assert.equal(step._deriveUncapturedReason([{ stepId: 'commit', status: 'done', output: { commitSha: 'x' } }]), 'no AI capture this wrap');
    assert.equal(step._deriveUncapturedReason([]), 'no AI capture this wrap');
    assert.equal(step._deriveUncapturedReason(null), 'no AI capture this wrap');
  });

  // ── CC-2 warm tier: changelog + wrap summary written alongside the index ──

  function ctxWithSession(session, previousResults) {
    return { project, session, previousResults: previousResults || [], step: {}, staged: {}, options: {} };
  }

  it('appends a changelog entry + writes the wrap summary when a session is present', async () => {
    const res = await step.run(ctxWithSession(
      { id: 42, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: {
        summary: 'Built CC-2 warm tier.',
        nextSteps: '- run critic',
        learnings: 'branch hygiene matters'
      } } }]
    ));
    assert.equal(res.ok, true);
    assert.equal(res.output.changelogAppended, true);
    assert.equal(res.output.wrapSummaryWritten, true);

    const changelog = fs.readFileSync(continuity.changelogPath(project.path), 'utf8');
    // CC-5: the default stub branch (feat/cc-1) now renders a [feat] type token.
    assert.match(changelog, /\(session:42\) \[feat\] Built CC-2 warm tier\./);

    const summary = continuity.readWrapSummary(project.path, 42);
    assert.equal(summary.meta.session, '42');
    assert.equal(summary.meta.harness, 'claude');
    assert.equal(summary.sections['Where we are'], 'Built CC-2 warm tier.');
    assert.equal(summary.sections['Next action'], '- run critic');
    assert.equal(summary.sections['Landmines'], 'branch hygiene matters');
    assert.equal(summary.sections['Delta'], '', 'uncaptured section honest-flagged → empty on read');

    const rawSummary = fs.readFileSync(continuity.wrapSummaryPath(project.path, 42), 'utf8');
    assert.match(rawSummary, /- sha: abc1234/);
    assert.match(rawSummary, /## Delta\n_⚠ not captured_/);
  });

  it('honors a project-configured wrapSections selection (CC-6, #381)', async () => {
    // Persist a per-project wrap-section override: only Where we are + Freshness
    // (Next action is forced in regardless). The step should read project.json
    // and write a summary that omits the unselected sections.
    const tcDir = path.join(project.path, '.tangleclaw');
    fs.mkdirSync(tcDir, { recursive: true });
    fs.writeFileSync(
      path.join(tcDir, 'project.json'),
      JSON.stringify({ wrapSections: ['Where we are', 'Freshness'] }, null, 2)
    );

    const res = await step.run(ctxWithSession(
      { id: 77, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: {
        summary: 'Selected sections only.',
        nextSteps: '- ship it',
        learnings: 'should be omitted'
      } } }]
    ));
    assert.equal(res.output.wrapSummaryWritten, true);

    const rawSummary = fs.readFileSync(continuity.wrapSummaryPath(project.path, 77), 'utf8');
    assert.match(rawSummary, /## Where we are/);
    assert.match(rawSummary, /## Next action/); // forced keystone
    assert.match(rawSummary, /## Freshness/);
    assert.doesNotMatch(rawSummary, /## Landmines/); // captured but section deselected
    assert.doesNotMatch(rawSummary, /## Delta/);
  });

  // ── CC-7 degraded-wrap tier stamped end-to-end ──

  it('mechanical-only wrap stamps tier + flags judgment sections WITH the reason', async () => {
    const res = await step.run(ctxWithSession(
      { id: 50, engineId: 'webui' },
      // ai-content honest-skipped because the webui session has no AI channel (#334)
      [{ stepId: 'ai-content', status: 'skipped', output: { webui: true, reason: 'no tmux pane' } }]
    ));
    assert.equal(res.output.hadCapture, false);
    assert.equal(res.output.tier, 'mechanical-only');

    // Index freshness carries the tier (read at the next resume).
    const rawIndex = fs.readFileSync(continuity.indexPath(project.path), 'utf8');
    assert.match(rawIndex, /- tier: mechanical-only/);

    // Per-session wrap summary: tier frontmatter + reason-bearing flag.
    const rawSummary = fs.readFileSync(continuity.wrapSummaryPath(project.path, 50), 'utf8');
    assert.match(rawSummary, /\ntier: mechanical-only\n/);
    assert.match(rawSummary, /## Next action\n_⚠ not captured \(no AI channel\)_/);
    // GUARD: a bare marker here means the reason plumbing regressed.
    assert.doesNotMatch(rawSummary, /## Next action\n_⚠ not captured_\n/);
  });

  it('no-plugin wrap (capture, non-governed project) stamps tier: no-plugin with bare markers', async () => {
    const res = await step.run(ctxWithSession(
      { id: 51, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }]
    ));
    assert.equal(res.output.tier, 'no-plugin');
    const rawSummary = fs.readFileSync(continuity.wrapSummaryPath(project.path, 51), 'utf8');
    assert.match(rawSummary, /\ntier: no-plugin\n/);
    // hadCapture → structurally-uncaptured sections get the BARE marker (not a degradation reason).
    assert.match(rawSummary, /## Delta\n_⚠ not captured_/);
    assert.doesNotMatch(rawSummary, /not captured \(/);
  });

  it('full wrap (capture + plugin-governed) stamps tier: full', async () => {
    // Mark the project plugin-governed the way engines.isPluginGoverned detects it.
    const claudeDir = path.join(project.path, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'prawduct@1.0.0': true } }));

    const res = await step.run(ctxWithSession(
      { id: 52, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }]
    ));
    assert.equal(res.output.tier, 'full');
    const rawIndex = fs.readFileSync(continuity.indexPath(project.path), 'utf8');
    assert.match(rawIndex, /- tier: full/);
  });

  it('search finds the just-written entry by its session pointer', async () => {
    await step.run(ctxWithSession(
      { id: 7, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 'Fixed PTY exhaustion', nextSteps: 'n' } } }]
    ));
    const hits = continuity.search(project.path, 'PTY exhaustion');
    assert.ok(hits.length > 0);
    assert.ok(hits.some((h) => h.sid === '7'));
  });

  it('skips the warm tier (no sid) but still writes the index when session is absent', async () => {
    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    assert.equal(res.output.written, true, 'index still written');
    assert.equal(res.output.changelogAppended, false);
    assert.equal(res.output.wrapSummaryWritten, false);
    assert.ok(!fs.existsSync(continuity.changelogPath(project.path)), 'no changelog without a session');
  });

  it('warm-tier failure never halts the wrap (non-blocking note)', async () => {
    // Plant a file where the wraps/ dir would go so writeWrapSummary fails,
    // AFTER the index write has already succeeded.
    const projPath = fs.mkdtempSync(path.join(tmpDir, 'warmfail-'));
    project = { id: 3, name: 'wf', path: projPath };
    fs.mkdirSync(continuity.storeDir(projPath), { recursive: true });
    fs.writeFileSync(continuity.wrapsDir(projPath), 'i am a file, not a dir');

    const res = await step.run(ctxWithSession(
      { id: 9, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }]
    ));
    assert.equal(res.ok, true, 'warm-tier failure must not block a wrap');
    assert.equal(res.output.written, true, 'index still written');
    assert.equal(res.output.wrapSummaryWritten, false);
  });

  // ── CC-3: the Map is self-maintained at wrap (stub touched, prune deleted) ──

  // A git stub that resolves `main` as base and returns a --name-status diff.
  function gitStubWithDiff(nameStatus) {
    return async (file, args) => {
      if (args.includes('--short')) return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
      if (args.includes('--abbrev-ref')) return { exitCode: 0, stdout: 'feat/cc-3\n', stderr: '' };
      // base resolution: `git rev-parse --verify --quiet main`
      if (args.includes('rev-parse') && args.includes('main')) return { exitCode: 0, stdout: 'main\n', stderr: '' };
      if (args.includes('rev-parse')) return { exitCode: 1, stdout: '', stderr: '' };
      if (args.includes('--name-status')) return { exitCode: 0, stdout: nameStatus, stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    };
  }

  it('stubs a touched source file into the index Map', async () => {
    step._internal.exec = gitStubWithDiff('M\tlib/widget.js\nA\tlib/new.js\n');
    await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    const parsed = continuity.parseIndex(fs.readFileSync(continuity.indexPath(project.path), 'utf8'));
    assert.match(parsed.map, /- \*\*TBD\*\* — `lib\/widget\.js`/);
    assert.match(parsed.map, /- \*\*TBD\*\* — `lib\/new\.js`/);
  });

  it('prunes a deleted file and preserves a prior curated entry across the rewrite', async () => {
    // First wrap with a curated Map already on disk, plus a file that will be deleted.
    continuity.writeIndex(project.path, {
      currentState: 'prior', nextAction: 'prior',
      map: '- **Widget** — the widget. `lib/widget.js`\n- **TBD** — `lib/doomed.js` <!-- describe -->',
      freshness: { sha: 'old', branch: 'main', writtenAt: '2026-06-16' }
    });
    step._internal.exec = gitStubWithDiff('D\tlib/doomed.js\n');
    await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's2', nextSteps: 'n2' } } }
    ]));
    const parsed = continuity.parseIndex(fs.readFileSync(continuity.indexPath(project.path), 'utf8'));
    assert.match(parsed.map, /Widget/, 'curated entry survives the index rewrite');
    assert.doesNotMatch(parsed.map, /doomed\.js/, 'deleted file pruned from the Map');
    // The rest of the index was regenerated from this wrap's capture.
    assert.equal(parsed.currentState, 's2');
  });

  it('leaves the Map empty when no base branch resolves (best-effort, non-blocking)', async () => {
    // Default beforeEach stub: rev-parse main/master fall through to exitCode 1.
    const res = await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    assert.equal(res.ok, true);
    const parsed = continuity.parseIndex(fs.readFileSync(continuity.indexPath(project.path), 'utf8'));
    assert.equal(parsed.map, '', 'no base → no delta → empty Map, wrap unaffected');
  });

  it('ignores non-indexable touched paths (allowlist reuse)', async () => {
    step._internal.exec = gitStubWithDiff('A\tnode_modules/pkg/index.js\nM\tdist/bundle.js\nM\tlib/real.js\n');
    await step.run(ctx([
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    const parsed = continuity.parseIndex(fs.readFileSync(continuity.indexPath(project.path), 'utf8'));
    assert.match(parsed.map, /lib\/real\.js/);
    assert.doesNotMatch(parsed.map, /node_modules|dist/);
  });

  it('_mapDelta classifies A/M/D/R via --name-status', async () => {
    step._internal.exec = gitStubWithDiff('A\tlib/added.js\nM\tlib/mod.js\nD\tlib/del.js\nR100\tlib/old.js\tlib/renamed.js\n');
    const delta = await step._mapDelta(project.path);
    assert.deepEqual(delta.touched.sort(), ['lib/added.js', 'lib/mod.js', 'lib/renamed.js'].sort());
    assert.deepEqual(delta.deleted.sort(), ['lib/del.js', 'lib/old.js'].sort());
  });

  // ── CC-4b cold tier ──

  it('reports an honest transcript skip when none resolves (no ~/.claude match)', async () => {
    const res = await step.run(ctxWithSession({ id: 12, engineId: 'claude' }, [
      { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } }
    ]));
    assert.equal(res.ok, true);
    assert.equal(res.output.transcript.captured, false);
  });

  // ── CC-5: type (branch prefix) + files (touched) flow into the warm tier ──

  it('_branchType maps the branch prefix to a work type (feature → feat); typeless → empty', () => {
    assert.equal(step._branchType('feat/cc-5-operator-search'), 'feat');
    assert.equal(step._branchType('feature/x'), 'feat');
    assert.equal(step._branchType('fix/bug'), 'fix');
    assert.equal(step._branchType('chore/deps'), 'chore');
    assert.equal(step._branchType('docs/readme'), 'docs');
    assert.equal(step._branchType('refactor/core'), 'refactor');
    assert.equal(step._branchType('main'), '', 'no prefix → no type');
    assert.equal(step._branchType('wip/experiment'), '', 'unknown prefix → no type');
    assert.equal(step._branchType(''), '');
  });

  it('writes [type] + files: into the changelog and frontmatter from branch + diff', async () => {
    step._internal.exec = gitStubWithDiff('M\tlib/auth.js\nM\tserver.js\n'); // branch feat/cc-3
    const res = await step.run(ctxWithSession(
      { id: 55, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 'CC-5 search', nextSteps: 'n' } } }]
    ));
    assert.equal(res.ok, true);

    const changelog = fs.readFileSync(continuity.changelogPath(project.path), 'utf8');
    assert.match(changelog, /\(session:55\) \[feat\] CC-5 search/, 'type rides as [feat] after the pointer');
    assert.match(changelog, /\n {2}files: lib\/auth\.js, server\.js/);

    const summary = continuity.readWrapSummary(project.path, 55);
    assert.equal(summary.meta.type, 'feat');
    assert.equal(summary.meta.files, 'lib/auth.js, server.js');

    // The new fields are queryable end-to-end through listSessions.
    const rec = continuity.listSessions(project.path).find((s) => s.sid === '55');
    assert.equal(rec.type, 'feat');
    assert.deepEqual(rec.files.sort(), ['lib/auth.js', 'server.js']);
  });

  it('omits type when the branch carries no recognized prefix (un-indexed, honest)', async () => {
    step._internal.exec = async (file, args) => {
      if (args.includes('--short')) return { exitCode: 0, stdout: 'abc1234\n', stderr: '' };
      if (args.includes('--abbrev-ref')) return { exitCode: 0, stdout: 'main\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    await step.run(ctxWithSession(
      { id: 56, engineId: 'claude' },
      [{ stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 'on main', nextSteps: 'n' } } }]
    ));
    const changelog = fs.readFileSync(continuity.changelogPath(project.path), 'utf8');
    assert.match(changelog, /\(session:56\) on main/);
    assert.doesNotMatch(changelog, /\(session:56\) \[/, 'no [type] token for a typeless branch');
    assert.equal(continuity.readWrapSummary(project.path, 56).meta.type, undefined);
  });

  it('a transcript-snapshot failure never halts the wrap or the warm tier', async () => {
    const origSnapshot = transcript.snapshot;
    transcript.snapshot = async () => { throw new Error('boom'); };
    try {
      const res = await step.run(ctxWithSession({ id: 13, engineId: 'claude' }, [
        { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 'still here', nextSteps: 'n' } } }
      ]));
      // Wrap completes, warm tier still written, the failure is captured honestly.
      assert.equal(res.ok, true);
      assert.equal(res.output.wrapSummaryWritten, true);
      assert.equal(res.output.transcript.captured, false);
      assert.match(res.output.transcript.reason, /boom/);
    } finally {
      transcript.snapshot = origSnapshot;
    }
  });
});
