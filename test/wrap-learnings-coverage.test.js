'use strict';

// #843 / #1405 — `learnings-capture` blocked a wrap whose learnings entry had
// already landed: written while the session prepared to wrap, or finished by the
// AI after a blocked attempt and then Retried. The gate only asked "did the file
// change during this step?", so the one way through was writing more, which the
// step's own prompt forbids. The `learnings-entry` predicate asks whether the
// file already carries this session's entry.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const coverage = require('../lib/wrap-steps/learnings-coverage');
const aic = require('../lib/wrap-steps/ai-content');
const defaultPipeline = require('../lib/wrap-default-pipeline');
const { isoLocalDate } = require('../lib/wrap-steps/_date');

const REL = '.tangleclaw/memories/learnings.md';
const HOUR = 60 * 60 * 1000;

/**
 * Write the learnings file under a temp project and set its modification time.
 * @param {string} root - Temp project root
 * @param {string} content - File content
 * @param {number} mtimeMs - Modification time to stamp
 * @returns {void}
 */
function writeLearnings(root, content, mtimeMs) {
  const abs = path.join(root, REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  fs.utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000);
}

describe('learnings-coverage.evaluate', () => {
  let root;
  const now = Date.now();
  const today = isoLocalDate(now);
  // An hour ago, unless that crosses local midnight; then a minute ago.
  const startedAtMs = isoLocalDate(now - HOUR) === today ? now - HOUR : now - 60 * 1000;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-learnings-cov-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('covered: a dated entry written during the session (before the wrap started)', () => {
    writeLearnings(root, `# Learnings\n\n## ${today} — the gate asked the wrong question\nBody.\n`, startedAtMs + 1000);
    const r = coverage.evaluate(root, [REL], { startedAtMs });
    assert.equal(r.verdict, 'covered');
    assert.equal(r.entryDate, today);
  });

  it('covered: the honest no-op line', () => {
    writeLearnings(root, `# Learnings\n\n- ${today}: no novel learnings (routine work).\n`, startedAtMs + 1000);
    assert.equal(coverage.evaluate(root, [REL], { startedAtMs }).verdict, 'covered');
  });

  it('uncovered: a file nobody wrote since the session started, even with a same-day entry', () => {
    // A previous session earlier today wrote this entry; this session never touched the file.
    writeLearnings(root, `## ${today} — a previous session's entry\nBody.\n`, startedAtMs - 1000);
    const r = coverage.evaluate(root, [REL], { startedAtMs });
    assert.equal(r.verdict, 'uncovered');
    assert.match(r.reason, /has not been written since this session started/);
  });

  it('uncovered: written this session but carrying no entry dated within it', () => {
    writeLearnings(root, '## 2020-01-01 — an old entry\nBody.\n', startedAtMs + 1000);
    const r = coverage.evaluate(root, [REL], { startedAtMs });
    assert.equal(r.verdict, 'uncovered');
    assert.match(r.reason, /carries no entry dated/);
  });

  it('uncovered: the file does not exist', () => {
    const r = coverage.evaluate(root, [REL], { startedAtMs });
    assert.equal(r.verdict, 'uncovered');
    assert.match(r.reason, /could not be read/);
  });

  it('credits a session that started yesterday and wraps today', () => {
    const t = new Date(2026, 8, 14, 0, 30).getTime();
    const started = new Date(2026, 8, 13, 23, 0).getTime();
    const deps = {
      now: () => t,
      stat: () => ({ mtimeMs: t }),
      read: () => '## 2026-09-13 — written before midnight\nBody.\n'
    };
    assert.equal(coverage.evaluate('/p', [REL], { startedAtMs: started }, deps).verdict, 'covered');
    deps.read = () => '## 2026-09-12 — the day before the session\nBody.\n';
    assert.equal(coverage.evaluate('/p', [REL], { startedAtMs: started }, deps).verdict, 'uncovered');
  });

  it('unavailable: the session start time is unknown (a row from before launch baselines)', () => {
    writeLearnings(root, `## ${today} — entry\n`, now);
    assert.equal(coverage.evaluate(root, [REL], { startedAtMs: null }).verdict, 'unavailable');
    assert.equal(coverage.evaluate(root, [REL], null).verdict, 'unavailable');
  });

  it('entryDates reads headings and the no-op line, and nothing else', () => {
    assert.deepEqual(coverage.entryDates([
      '# Cross-Session Learnings',
      '## 2026-09-01 — a',
      'text mentioning 2026-09-02 inline',
      '- 2026-09-03: no novel learnings (routine work).',
      '- 2026-09-04: something else',
      '### 2026-09-05 — a sub-heading'
    ].join('\n')), ['2026-09-01', '2026-09-03']);
  });

  // #3216 Pillar 4: a TCC-exempt managed workspace mirror of `learnings.md`
  // (`~/.tangleclaw/workspaces/<project>/<rel>`) lets a wrap's
  // `learnings-capture` step still find an entry a session's shell wrote
  // there, when `<project.path>` itself hit macOS TCC EPERM/EACCES.
  describe('managed workspace fallback (#3216 Pillar 4)', () => {
    let managedRoot;

    beforeEach(() => { managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-learnings-managed-')); });
    afterEach(() => { fs.rmSync(managedRoot, { recursive: true, force: true }); });

    /**
     * Where `_managedFallbackPath` resolves for this test's own `root`
     * fixture, under a scratch `managedWorkspacesDir` rather than the real
     * `~/.tangleclaw/workspaces`.
     * @returns {string}
     */
    function fallbackDeps() {
      return { managedWorkspacesDir: managedRoot };
    }

    function writeFallback(content, mtimeMs) {
      const abs = coverage._managedFallbackPath(root, REL, fallbackDeps());
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      fs.utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000);
    }

    it('EPERM on the primary path: resolves and verifies coverage from the managed fallback instead, mirror write also fails', () => {
      writeFallback(`# Learnings\n\n## ${today} — written to the managed fallback\nBody.\n`, startedAtMs + 1000);
      const deps = {
        ...fallbackDeps(),
        stat: (p) => {
          if (p === path.join(root, REL)) { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; }
          return fs.statSync(p);
        },
        read: (p) => {
          if (p === path.join(root, REL)) { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; }
          return fs.readFileSync(p, 'utf8');
        },
        write: (p) => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; }
      };
      const r = coverage.evaluate(root, [REL], { startedAtMs }, deps);
      assert.equal(r.verdict, 'covered');
      assert.equal(r.source, 'managed-fallback');
      assert.equal(r.entryDate, today);
      assert.equal(r.mirroredBack, false);
    });

    it('EACCES on the primary path behaves the same as EPERM', () => {
      writeFallback(`# Learnings\n\n## ${today} — written to the managed fallback\nBody.\n`, startedAtMs + 1000);
      const deps = {
        ...fallbackDeps(),
        stat: (p) => {
          if (p === path.join(root, REL)) { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; }
          return fs.statSync(p);
        },
        read: (p) => {
          if (p === path.join(root, REL)) { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; }
          return fs.readFileSync(p, 'utf8');
        },
        write: (p) => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; }
      };
      const r = coverage.evaluate(root, [REL], { startedAtMs }, deps);
      assert.equal(r.verdict, 'covered');
      assert.equal(r.source, 'managed-fallback');
      assert.equal(r.mirroredBack, false);
    });

    it('mirrors the managed-fallback content back to the primary path when the primary is writable', () => {
      writeLearnings(root, `## ${today} — a previous session's entry\nBody.\n`, startedAtMs - 1000);
      writeFallback(`# Learnings\n\n## ${today} — written to the managed fallback\nBody.\n`, startedAtMs + 1000);
      const r = coverage.evaluate(root, [REL], { startedAtMs }, fallbackDeps());
      assert.equal(r.verdict, 'covered');
      assert.equal(r.source, 'managed-fallback');
      assert.equal(r.mirroredBack, true);
      assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), fs.readFileSync(coverage._managedFallbackPath(root, REL, fallbackDeps()), 'utf8'));
    });

    it('does not mirror back when the primary (not the fallback) is the chosen candidate', () => {
      writeLearnings(root, `# Learnings\n\n## ${today} — written to the primary path\nBody.\n`, startedAtMs + 2000);
      writeFallback(`## ${today} — a stale managed-fallback copy\nBody.\n`, startedAtMs - 1000);
      const r = coverage.evaluate(root, [REL], { startedAtMs }, fallbackDeps());
      assert.equal(r.source, 'primary');
      assert.equal(r.mirroredBack, undefined);
    });

    it('both readable, managed fallback fresher: the fresher one is judged, even though the primary is stale', () => {
      // Primary: written BEFORE the session started (would read uncovered alone).
      writeLearnings(root, `## ${today} — a previous session's entry\nBody.\n`, startedAtMs - 1000);
      // Managed fallback: written during THIS session, after the primary.
      writeFallback(`# Learnings\n\n## ${today} — written to the managed fallback\nBody.\n`, startedAtMs + 1000);
      const r = coverage.evaluate(root, [REL], { startedAtMs }, fallbackDeps());
      assert.equal(r.verdict, 'covered');
      assert.equal(r.source, 'managed-fallback');
    });

    it('both readable, primary fresher: the primary is judged, not the stale managed fallback', () => {
      writeLearnings(root, `# Learnings\n\n## ${today} — written to the primary path\nBody.\n`, startedAtMs + 2000);
      writeFallback(`## ${today} — a stale managed-fallback copy\nBody.\n`, startedAtMs - 1000);
      const r = coverage.evaluate(root, [REL], { startedAtMs }, fallbackDeps());
      assert.equal(r.verdict, 'covered');
      assert.equal(r.source, 'primary');
    });

    it('both unreadable: uncovered, naming both failures', () => {
      const r = coverage.evaluate(root, [REL], { startedAtMs }, fallbackDeps());
      assert.equal(r.verdict, 'uncovered');
      assert.match(r.reason, /could not be read from the project path/);
      assert.match(r.reason, /managed workspace fallback/);
    });

    it('_managedFallbackPath derives the project name from the final path segment', () => {
      const abs = coverage._managedFallbackPath('/Users/x/Documents/Projects/my-proj', REL, { managedWorkspacesDir: '/mw' });
      assert.equal(abs, path.join('/mw', 'my-proj', REL));
    });

    // PRR-A R-Gate R1 BLOCKING 1 (PR #3239): many registered projects have
    // `project.name !== path.basename(project.path)` — the basename-only
    // derivation misses the managed fallback entirely for those.
    describe('canonical project name — path.basename(project.path) disagrees with project.name (#3216 R2)', () => {
      it('_resolveProjectName: deps.projectName wins outright, no store lookup attempted', () => {
        let storeCalled = false;
        const name = coverage._resolveProjectName('/Users/x/Documents/Projects/checkout-dir', {
          projectName: 'Registered-Name',
          store: { projects: { getByPath: () => { storeCalled = true; return { name: 'ignored' }; } } }
        });
        assert.equal(name, 'Registered-Name');
        assert.equal(storeCalled, false);
      });

      it('_resolveProjectName: falls back to a store.projects.getByPath lookup when no projectName is given', () => {
        const name = coverage._resolveProjectName('/Users/x/Documents/Projects/checkout-dir', {
          store: { projects: { getByPath: (p) => (p === '/Users/x/Documents/Projects/checkout-dir' ? { name: 'Registered-Name' } : null) } }
        });
        assert.equal(name, 'Registered-Name');
      });

      it('_resolveProjectName: null when neither projectName nor a store lookup resolves anything — caller falls back to basename', () => {
        assert.equal(coverage._resolveProjectName('/Users/x/Documents/Projects/checkout-dir', {}), null);
        assert.equal(coverage._resolveProjectName('/Users/x/Documents/Projects/checkout-dir', { store: { projects: { getByPath: () => null } } }), null);
      });

      it('_managedFallbackCandidatePaths: checks the canonical name FIRST, then path.basename too, when they differ', () => {
        const paths = coverage._managedFallbackCandidatePaths('/Users/x/Documents/Projects/TangleClaw-PR-Reviewer', REL, {
          managedWorkspacesDir: '/mw', projectName: 'TC-Lane-PRR-A'
        });
        assert.deepEqual(paths, [
          path.join('/mw', 'TC-Lane-PRR-A', REL),
          path.join('/mw', 'TangleClaw-PR-Reviewer', REL)
        ]);
      });

      it('_managedFallbackCandidatePaths: a single candidate when the canonical name and the basename agree', () => {
        const paths = coverage._managedFallbackCandidatePaths('/Users/x/Documents/Projects/my-proj', REL, {
          managedWorkspacesDir: '/mw', projectName: 'my-proj'
        });
        assert.deepEqual(paths, [path.join('/mw', 'my-proj', REL)]);
      });

      it('evaluate(): checkout directory name disagrees with the registered project name — resolves coverage from the canonically-named managed fallback', () => {
        // `root`'s own basename is whatever mkdtemp assigned it — this
        // test's `projectName` override stands in for a project registered
        // under a DIFFERENT name entirely (the real-world case PRR-A
        // named: TC-Lane-PRR-A's checkout basename is
        // "TangleClaw-PR-Reviewer", not its registered name) — proving
        // the canonical name, not the basename, is what gets checked.
        const canonicalDeps = { managedWorkspacesDir: managedRoot, projectName: 'Registered-Name' };
        const abs = coverage._managedFallbackPath(root, REL, canonicalDeps);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `# Learnings\n\n## ${today} — written under the canonical registered name\nBody.\n`);
        fs.utimesSync(abs, (startedAtMs + 1000) / 1000, (startedAtMs + 1000) / 1000);
        const r = coverage.evaluate(root, [REL], { startedAtMs }, canonicalDeps);
        assert.equal(r.verdict, 'covered');
        assert.equal(r.source, 'managed-fallback');
      });
    });

    // PRR-A R-Gate R1 BLOCKING 2 (PR #3239): the exact regression the
    // finding named — a readable-but-invalid fallback must never win over
    // a readable, valid primary, even when it is fresher.
    it('a FRESHER managed fallback with no entry for this session never displaces a readable, VALID primary', () => {
      writeLearnings(root, `# Learnings\n\n## ${today} — valid entry on the primary path\nBody.\n`, startedAtMs + 1000);
      // Fresher than the primary, readable, but carries no entry at all —
      // readable-but-INVALID for this contract.
      writeFallback('# Learnings\n\nno dated entries here.\n', startedAtMs + 5000);
      const r = coverage.evaluate(root, [REL], { startedAtMs }, fallbackDeps());
      assert.equal(r.verdict, 'covered');
      assert.equal(r.source, 'primary', 'the invalid (no-entry) fallback must not win just for being fresher');
      assert.equal(r.mirroredBack, undefined, 'no mirror-back — the primary won, not the fallback');
    });
  });
});

describe('learnings-capture gate — an entry already on disk', () => {
  let root;
  let saved;
  const now = Date.now();
  const today = isoLocalDate(now);
  const startedAtMs = isoLocalDate(now - HOUR) === today ? now - HOUR : now - 60 * 1000;
  const spec = () => defaultPipeline.steps().find((s) => s.id === 'learnings-capture');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-learnings-gate-'));
    saved = { ...aic._internal };
    aic._internal.listWrapRules = () => [];
    aic._internal.sendKeys = () => {};
    aic._internal.sleep = async () => {};
    aic._internal.newNonce = () => 'n0nce';
    aic._internal.readPaneTail = () => 'TCWRAP-DONE n0nce';
    aic._internal.capturePane = () => ({ lines: ['## Result', 'The entry for this session is already captured.'] });
  });
  afterEach(() => {
    Object.assign(aic._internal, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (step, scope) => aic.run({
    project: { name: 'proj', path: root },
    session: { tmuxSession: 'sess' },
    step, previousResults: [], staged: {}, options: {}, scope
  });

  it('passes on the first attempt when the session wrote its entry while preparing the wrap', async () => {
    // GURULifeline's scenario on #843: the entry landed before the wrap started,
    // and the AI correctly declined to duplicate it.
    writeLearnings(root, `# Learnings\n\n## ${today} — captured during preparation\nBody.\n`, startedAtMs + 1000);
    const res = await run(spec(), { startedAtMs });
    assert.equal(res.status, 'done', JSON.stringify(res.blockers));
  });

  it('a Retry passes on an entry written after the blocked attempt', async () => {
    writeLearnings(root, '# Learnings\n', startedAtMs - HOUR);
    const first = await run(spec(), { startedAtMs });
    assert.equal(first.status, 'blocked');
    assert.match(first.blockers[0], /carries no entry from this session/);
    assert.match(first.output.remediation, /Retry clears once it is on disk/);

    // The AI finishes the entry after the step gave up; the operator presses Retry.
    writeLearnings(root, `# Learnings\n\n## ${today} — finished after the block\nBody.\n`, Date.now());
    const retry = await run(spec(), { startedAtMs });
    assert.equal(retry.status, 'done', JSON.stringify(retry.blockers));
  });

  it('still blocks a file untouched since the session started', async () => {
    writeLearnings(root, `## ${today} — a previous session's entry\nBody.\n`, startedAtMs - 1000);
    const res = await run(spec(), { startedAtMs });
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /has not been written since this session started/);
  });

  it('falls back to the mutation gate when the session start is unknown', async () => {
    writeLearnings(root, `## ${today} — entry\nBody.\n`, now);
    const res = await run(spec(), { startedAtMs: null });
    assert.equal(res.status, 'blocked');
    assert.match(res.blockers[0], /byte-identical to before the AI ran/);
  });

  it('guard: without the predicate declaration, the landed entry blocks again', async () => {
    // Proves the pass above comes from `verifySatisfiedBy`, so removing it from
    // the pipeline spec turns that test red rather than leaving it vacuous.
    writeLearnings(root, `# Learnings\n\n## ${today} — captured during preparation\nBody.\n`, startedAtMs + 1000);
    const bare = { ...spec() };
    delete bare.verifySatisfiedBy;
    const res = await run(bare, { startedAtMs });
    assert.equal(res.status, 'blocked');
    assert.equal(spec().verifySatisfiedBy, 'learnings-entry');
  });
});

// #3216 Pillar 4's `learnings-db-write` DB-mirroring-from-fallback tests
// live in test/wrap-step-learnings-db-write.test.js instead of here: they
// need a real SQLite store, which bumps this FILE's own required test
// tier from small to medium (test/tiers.json) — the gate caught this
// (`node scripts/test-stage.js 1`'s "tiers ledger" step) before push.
// test/wrap-step-learnings-db-write.test.js is already tiered medium and
// already owns the rest of this module's own test coverage, so the DB
// tests belong there, not in this (declared-small) file.
