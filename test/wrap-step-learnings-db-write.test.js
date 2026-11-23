'use strict';

// Tests for the `learnings-db-write` wrap step (#466). Covers the pure
// today-entry parser and the handler's insert / dedup / skip / session-
// attribution behavior against a real SQLite store.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const step = require('../lib/wrap-steps/learnings-db-write');
const coverage = require('../lib/wrap-steps/learnings-coverage');

const TODAY = '2026-07-04';
const YESTERDAY = '2026-07-03';

describe('wrap-step learnings-db-write (#466)', () => {
  describe('_parseTodayEntries', () => {
    it('returns only entries whose heading is dated today', () => {
      const md = [
        '# Cross-Session Learnings — proj',
        '',
        `## ${YESTERDAY} — old thing`,
        'Old body.',
        '',
        `## ${TODAY} — new thing`,
        'New body one.',
        'New body two.',
        ''
      ].join('\n');
      const out = step._parseTodayEntries(md, TODAY);
      assert.equal(out.length, 1);
      assert.match(out[0], /^## 2026-07-04 — new thing/);
      assert.match(out[0], /New body one\.\nNew body two\./);
      assert.ok(!out[0].includes('old thing'));
    });

    it('captures multiple same-day entries as separate rows', () => {
      const md = [
        `## ${TODAY} — first`, 'a.', '',
        `## ${TODAY} — second`, 'b.', ''
      ].join('\n');
      const out = step._parseTodayEntries(md, TODAY);
      assert.equal(out.length, 2);
      assert.match(out[0], /first/);
      assert.match(out[1], /second/);
    });

    it('ignores the preamble/title before the first dated heading', () => {
      const md = `# Title\n\nsome intro prose\n\n## ${TODAY} — real\nbody.\n`;
      const out = step._parseTodayEntries(md, TODAY);
      assert.equal(out.length, 1);
      assert.match(out[0], /^## 2026-07-04 — real/);
    });

    it('ignores the "no novel learnings" sentinel (not a ## heading)', () => {
      const md = `# Title\n\n- ${TODAY}: no novel learnings (routine work).\n`;
      assert.deepEqual(step._parseTodayEntries(md, TODAY), []);
    });

    it('accepts a hyphen separator as well as an em-dash', () => {
      const md = `## ${TODAY} - hyphen title\nbody.\n`;
      const out = step._parseTodayEntries(md, TODAY);
      assert.equal(out.length, 1);
      assert.match(out[0], /hyphen title/);
    });

    it('returns [] for empty / non-string / no-today input', () => {
      assert.deepEqual(step._parseTodayEntries('', TODAY), []);
      assert.deepEqual(step._parseTodayEntries(null, TODAY), []);
      assert.deepEqual(step._parseTodayEntries(`## ${YESTERDAY} — old\nx\n`, TODAY), []);
    });
  });

  describe('handler', () => {
    let tmpDir;
    let projectPath;
    let project;
    let learningsPath;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-learnings-db-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const cfg = store.config.load();
      cfg.projectsDir = projectsDir;
      store.config.save(cfg);
      projectPath = path.join(projectsDir, 'learnings-db-test');
      fs.mkdirSync(path.join(projectPath, '.tangleclaw', 'memories'), { recursive: true });
      project = store.projects.create({
        name: 'learnings-db-test', path: projectPath, engine: 'claude'
      });
      learningsPath = path.join(projectPath, step.LEARNINGS_RELPATH);
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      // Fresh learnings table + file per case.
      for (const l of store.learnings.list(project.id)) store.learnings.delete(l.id);
      try { fs.rmSync(learningsPath, { force: true }); } catch {}
      step._internal.todayIso = () => TODAY;
    });

    it('skips when project path is missing', async () => {
      const r = await step.run({ project: null });
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /no project path/);
    });

    it('skips when the project has a path but no id (rows key on project_id)', async () => {
      const r = await step.run({ project: { path: projectPath, name: 'no-id' } });
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /no project id/);
    });

    it('skips when learnings.md is absent', async () => {
      const r = await step.run({ project });
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /no learnings\.md/);
    });

    it('skips when the file has no entry dated today', async () => {
      fs.writeFileSync(learningsPath, `# T\n\n## ${YESTERDAY} — old\nbody.\n`);
      const r = await step.run({ project });
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /no learnings\.md entry dated 2026-07-04/);
      assert.equal(store.learnings.list(project.id).length, 0);
    });

    it('inserts one provisional learning row per today-entry', async () => {
      fs.writeFileSync(learningsPath, [
        '# T', '',
        `## ${YESTERDAY} — old`, 'skip me.', '',
        `## ${TODAY} — alpha`, 'body a.', '',
        `## ${TODAY} — beta`, 'body b.', ''
      ].join('\n'));
      const r = await step.run({ project });
      assert.equal(r.status, 'done');
      assert.equal(r.output.inserted, 2);
      const rows = store.learnings.list(project.id);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((l) => l.tier === 'provisional'));
      const contents = rows.map((l) => l.content).sort();
      assert.match(contents[0], /## 2026-07-04 — alpha\nbody a\./);
      assert.match(contents[1], /## 2026-07-04 — beta\nbody b\./);
      // Yesterday's entry must NOT be stored.
      assert.ok(!rows.some((l) => l.content.includes('old')));
    });

    it('is idempotent — a second run inserts nothing (dedup by content)', async () => {
      fs.writeFileSync(learningsPath, `# T\n\n## ${TODAY} — once\nbody.\n`);
      const first = await step.run({ project });
      assert.equal(first.output.inserted, 1);
      const second = await step.run({ project });
      assert.equal(second.status, 'skipped');
      assert.match(second.output.reason, /already in the DB/);
      assert.equal(store.learnings.list(project.id).length, 1);
    });

    it('inserts only the new entry when an earlier today-entry is already stored', async () => {
      fs.writeFileSync(learningsPath, `# T\n\n## ${TODAY} — one\nbody one.\n`);
      await step.run({ project });
      // A later capture in the same day appends a second entry.
      fs.appendFileSync(learningsPath, `\n## ${TODAY} — two\nbody two.\n`);
      const r = await step.run({ project });
      assert.equal(r.status, 'done');
      assert.equal(r.output.inserted, 1);
      assert.equal(store.learnings.list(project.id).length, 2);
    });

    it('confirms a recurring learning based on topic match, ignoring body differences', async () => {
      // 1. Insert an existing provisional learning from yesterday
      store.learnings.create({
        projectId: project.id,
        content: `## ${YESTERDAY} — the same topic\nold body.\n`,
        tier: 'provisional',
        sourceSession: null
      });

      // 2. Wrap writes a new learning today with the same topic but a different body
      fs.writeFileSync(learningsPath, `# T\n\n## ${TODAY} — The Same Topic  \nnew body.\n`);
      const r = await step.run({ project });

      assert.equal(r.status, 'done');
      assert.equal(r.output.confirmed, 1);
      assert.equal(r.output.inserted, 0); // Confirms instead of inserting a near-twin
      
      const rows = store.learnings.list(project.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tier, 'active');
      // Content remains the old one because confirm() doesn't overwrite
      assert.match(rows[0].content, /old body/);
    });

    it('attributes source_session to the active session when one exists', async () => {
      const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'learnings-db-test' });
      fs.writeFileSync(learningsPath, `# T\n\n## ${TODAY} — attributed\nbody.\n`);
      try {
        const r = await step.run({ project });
        assert.equal(r.output.inserted, 1);
        const row = store.learnings.list(project.id)[0];
        assert.equal(row.sourceSession, session.id);
      } finally {
        store.sessions.kill(session.id, 'test-cleanup');
      }
    });

    // #3216 Pillar 4: the TCC-exempt managed workspace mirror
    // (`~/.tangleclaw/workspaces/<project>/.tangleclaw/memories/learnings.md`)
    // — shares `_managedFallbackPath`/`_readCandidate` with
    // `lib/wrap-steps/learnings-coverage.js` (not duplicated), so both
    // steps agree on exactly where it lives for a given project.
    describe('managed workspace fallback (#3216 Pillar 4)', () => {
      let managedRoot;

      beforeEach(() => {
        managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-learnings-db-managed-'));
        step._internal.managedWorkspacesDir = managedRoot;
      });

      afterEach(() => {
        step._internal.managedWorkspacesDir = undefined;
        fs.rmSync(managedRoot, { recursive: true, force: true });
      });

      function managedPath() {
        return coverage._managedFallbackPath(projectPath, step.LEARNINGS_RELPATH, { managedWorkspacesDir: managedRoot });
      }

      it('the project path has no learnings.md at all: mirrors from the managed fallback instead, and mirrors it back', async () => {
        const abs = managedPath();
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `# T\n\n## ${TODAY} — written only to the managed fallback\nbody.\n`);
        const r = await step.run({ project });
        assert.equal(r.status, 'done', JSON.stringify(r));
        assert.equal(r.output.inserted, 1);
        const rows = store.learnings.list(project.id);
        assert.equal(rows.length, 1);
        assert.match(rows[0].content, /written only to the managed fallback/);
        // #3216 Pillar 4: best-effort control-plane mirror sync back to the
        // primary path, created fresh since it didn't exist at all.
        assert.match(fs.readFileSync(learningsPath, 'utf8'), /written only to the managed fallback/);
      });

      it('both exist: the fresher one (by mtime) is mirrored, even when that is the managed fallback, and mirrored back', async () => {
        fs.writeFileSync(learningsPath, `# T\n\n## ${TODAY} — stale primary copy\nbody.\n`);
        fs.utimesSync(learningsPath, 1000, 1000); // far in the past

        const fallbackAbs = managedPath();
        fs.mkdirSync(path.dirname(fallbackAbs), { recursive: true });
        fs.writeFileSync(fallbackAbs, `# T\n\n## ${TODAY} — fresher managed-fallback copy\nbody.\n`);
        // fallbackAbs keeps its real (current) mtime — fresher than learningsPath.

        const r = await step.run({ project });
        assert.equal(r.status, 'done', JSON.stringify(r));
        const rows = store.learnings.list(project.id);
        assert.equal(rows.length, 1);
        assert.match(rows[0].content, /fresher managed-fallback copy/);
        assert.ok(!rows[0].content.includes('stale primary'));
        // The stale primary copy is overwritten with the fresher content.
        assert.match(fs.readFileSync(learningsPath, 'utf8'), /fresher managed-fallback copy/);
      });

      it('neither exists: skips exactly as before, naming both candidates', async () => {
        const r = await step.run({ project });
        assert.equal(r.status, 'skipped');
        assert.match(r.output.reason, /no learnings\.md/);
        assert.match(r.output.reason, /project path/);
        assert.match(r.output.reason, /managed workspace fallback/);
      });

      it('mirror write failing (EPERM on the primary) never fails the step itself', async () => {
        const abs = managedPath();
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `# T\n\n## ${TODAY} — written only to the managed fallback\nbody.\n`);
        const realMkdirSync = step._internal.mkdirSync;
        step._internal.mkdirSync = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
        try {
          const r = await step.run({ project });
          assert.equal(r.status, 'done', JSON.stringify(r));
          assert.equal(r.output.inserted, 1);
          const rows = store.learnings.list(project.id);
          assert.equal(rows.length, 1);
          // The mirror write failed silently — no file was created at the primary path.
          assert.ok(!fs.existsSync(learningsPath));
        } finally {
          step._internal.mkdirSync = realMkdirSync;
        }
      });

      // PRR-A R-Gate R1 BLOCKING 2 (PR #3239): the exact regression the
      // finding named — a readable-but-invalid fallback must never win
      // over a readable, valid primary, even when it is fresher.
      it('a FRESHER managed fallback with no today-entry never displaces a readable, VALID primary', async () => {
        fs.writeFileSync(learningsPath, `# T\n\n## ${TODAY} — valid entry on the primary path\nbody.\n`);
        const fallbackAbs = managedPath();
        fs.mkdirSync(path.dirname(fallbackAbs), { recursive: true });
        // Fresher than the primary, readable, but carries no today-entry —
        // readable-but-INVALID for this step's own contract.
        fs.writeFileSync(fallbackAbs, `# T\n\n## ${YESTERDAY} — no today entry here\nbody.\n`);

        const r = await step.run({ project });
        assert.equal(r.status, 'done', JSON.stringify(r));
        const rows = store.learnings.list(project.id);
        assert.equal(rows.length, 1);
        assert.match(rows[0].content, /valid entry on the primary path/);
        // No mirror-back happened — the primary won, not the fallback.
        assert.equal(fs.readFileSync(learningsPath, 'utf8'), `# T\n\n## ${TODAY} — valid entry on the primary path\nbody.\n`);
      });
    });

    // PRR-A R-Gate R1 BLOCKING 1 (PR #3239): many registered projects have
    // `project.name !== path.basename(project.path)` (e.g. a checkout
    // cloned under a different directory name than it was registered
    // under) — the basename-only derivation missed the managed fallback
    // entirely for those.
    describe('canonical project.name, not path.basename(project.path) (#3216 R2)', () => {
      let mismatchedProjectPath;
      let mismatchedProject;

      before(() => {
        // The checkout's directory name ("checkout-dir-...") deliberately
        // does NOT match the project's registered name ("Registered-Name-...").
        mismatchedProjectPath = path.join(path.dirname(projectPath), `checkout-dir-${Date.now()}`);
        fs.mkdirSync(mismatchedProjectPath, { recursive: true });
        mismatchedProject = store.projects.create({
          name: `Registered-Name-${Date.now()}`, path: mismatchedProjectPath, engine: 'claude'
        });
      });

      beforeEach(() => { step._internal.todayIso = () => TODAY; });

      it('resolves the managed fallback under the REGISTERED project name, not the checkout directory name', async () => {
        const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-learnings-db-managed-mismatch-'));
        step._internal.managedWorkspacesDir = managedRoot;
        try {
          // Written under the CANONICAL registered name, not the checkout
          // directory's own basename.
          const abs = coverage._managedFallbackPath(mismatchedProjectPath, step.LEARNINGS_RELPATH, {
            managedWorkspacesDir: managedRoot, projectName: mismatchedProject.name
          });
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, `# T\n\n## ${TODAY} — written under the canonical registered name\nbody.\n`);
          const r = await step.run({ project: mismatchedProject });
          assert.equal(r.status, 'done', JSON.stringify(r));
          const rows = store.learnings.list(mismatchedProject.id);
          assert.equal(rows.length, 1);
          assert.match(rows[0].content, /written under the canonical registered name/);
        } finally {
          step._internal.managedWorkspacesDir = undefined;
          fs.rmSync(managedRoot, { recursive: true, force: true });
        }
      });
    });
  });
});
