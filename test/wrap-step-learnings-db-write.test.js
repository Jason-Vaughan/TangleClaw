'use strict';

// Tests for the `learnings-db-write` wrap step (#466). Covers the pure
// today-entry parser and the handler's insert / dedup / skip / session-
// attribution behavior against a real SQLite store.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const step = require('../lib/wrap-steps/learnings-db-write');

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
        name: 'learnings-db-test', path: projectPath, engine: 'claude', methodology: 'prawduct'
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
  });
});
