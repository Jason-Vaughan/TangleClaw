'use strict';

// Tests for the `index-describe` wrap step (#426) — AI-fills empty
// `<!-- describe -->` stubs in the enabled PIDX index file(s) on wrap.
// Covers: pure helpers (stub count, prompt contract), gate semantics
// (no session, no toggle, no stubs), the clobber-avoidance skip
// (pending staged write), the happy path (delegate → re-scan → count),
// non-blocking failure, and the commit body line.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const aiContent = require('../lib/wrap-steps/ai-content');
const indexDescribe = require('../lib/wrap-steps/index-describe');
const commitStep = require('../lib/wrap-steps/commit');

const SESSION = { id: 1, sessionMode: 'tmux', tmuxSession: 'tc:0' };

describe('wrap-step index-describe (#426)', () => {
  describe('_countStubs (pure)', () => {
    it('counts the empty <!-- describe --> marker occurrences', () => {
      assert.equal(indexDescribe._countStubs(''), 0);
      assert.equal(indexDescribe._countStubs('no markers here'), 0);
      assert.equal(indexDescribe._countStubs('- `lib/` — <!-- describe -->'), 1);
      assert.equal(
        indexDescribe._countStubs('- `lib/` — <!-- describe -->\n- `test/` — <!-- describe -->'),
        2
      );
    });

    it('does not count an already-described entry', () => {
      const filled = '- `lib/` — core library code.\n- `test/` — <!-- describe -->';
      assert.equal(indexDescribe._countStubs(filled), 1);
    });

    it('is null/non-string safe', () => {
      assert.equal(indexDescribe._countStubs(null), 0);
      assert.equal(indexDescribe._countStubs(undefined), 0);
      assert.equal(indexDescribe._countStubs(42), 0);
    });
  });

  describe('_buildPrompt (contract)', () => {
    it('names the target files and pins the fill-only-empty-stubs rules', () => {
      const prompt = indexDescribe._buildPrompt([
        { filename: 'PROJECT-MAP.md', label: 'Project Map', stubsBefore: 2 },
        { filename: 'FEATURES.md', label: 'Feature Index', stubsBefore: 1 }
      ]);
      assert.match(prompt, /PROJECT-MAP\.md/);
      assert.match(prompt, /FEATURES\.md/);
      assert.match(prompt, /2 empty stubs/);
      assert.match(prompt, /1 empty stub\b/);
      assert.match(prompt, /<!-- describe -->/);
      assert.match(prompt, /preserve curation/i);
      assert.match(prompt, /Do NOT add new entries/);
      assert.match(prompt, /## Result/);
    });
  });

  describe('handler — gate + skip semantics (never blocks)', () => {
    let tmpDir;
    let projectPath;
    let createdProject;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-index-describe-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const cfg = store.config.load();
      cfg.projectsDir = projectsDir;
      store.config.save(cfg);
      projectPath = path.join(projectsDir, 'idx');
      fs.mkdirSync(projectPath, { recursive: true });
      createdProject = store.projects.create({
        name: 'idx', path: projectPath, engine: 'claude'
      });
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      // Clean index files between cases.
      for (const f of ['PROJECT-MAP.md', 'FEATURES.md']) {
        const p = path.join(projectPath, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    });

    function enable(cfg) {
      store.projectConfig.save(projectPath, {
        engine: 'claude', methodology: 'minimal', ...cfg
      });
    }

    it('skips when there is no active session', async () => {
      enable({ projectMapEnabled: true });
      const result = await indexDescribe.run({ project: createdProject, session: null, staged: {} });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /no active session/);
    });

    it('skips when neither index toggle is enabled', async () => {
      enable({ projectMapEnabled: false, featureIndexEnabled: false });
      const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged: {} });
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /neither/);
    });

    it('skips when an enabled index file is missing on disk', async () => {
      enable({ projectMapEnabled: true });
      const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged: {} });
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /no enabled index file/);
    });

    it('skips when the enabled file has no empty stubs', async () => {
      enable({ projectMapEnabled: true });
      fs.writeFileSync(path.join(projectPath, 'PROJECT-MAP.md'),
        '# Project Map\n\n## Structure\n\n- `lib/` — already described.\n');
      const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged: {} });
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /describable empty stubs/);
    });

    it('skips a file that has a pending staged write this wrap (clobber-avoidance)', async () => {
      enable({ projectMapEnabled: true });
      fs.writeFileSync(path.join(projectPath, 'PROJECT-MAP.md'),
        '# Project Map\n\n## Structure\n\n- `lib/` — <!-- describe -->\n');
      // project-map staged a refresh this wrap → the commit flush would clobber
      // any AI edits, so index-describe must skip this file (and not call the AI).
      const orig = aiContent.run;
      let called = false;
      aiContent.run = async () => { called = true; return { ok: true, status: 'done', output: {}, blockers: [] }; };
      try {
        const staged = { 'project-map:refresh': { primingPath: 'x', newContent: 'y', changed: true } };
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged });
        assert.equal(result.status, 'skipped');
        assert.equal(called, false, 'must not drive the AI when the only target has a pending staged write');
      } finally {
        aiContent.run = orig;
      }
    });
  });

  describe('handler — happy path + failure (delegates to ai-content)', () => {
    let tmpDir;
    let projectPath;
    let createdProject;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-index-describe-hp-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const cfg = store.config.load();
      cfg.projectsDir = projectsDir;
      store.config.save(cfg);
      projectPath = path.join(projectsDir, 'idx-hp');
      fs.mkdirSync(projectPath, { recursive: true });
      createdProject = store.projects.create({
        name: 'idx-hp', path: projectPath, engine: 'claude'
      });
      store.projectConfig.save(projectPath, {
        engine: 'claude', methodology: 'minimal', projectMapEnabled: true, featureIndexEnabled: true
      });
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('describes empty stubs and reports the honest filled count from a post-scan', async () => {
      const mapPath = path.join(projectPath, 'PROJECT-MAP.md');
      const featPath = path.join(projectPath, 'FEATURES.md');
      fs.writeFileSync(mapPath,
        '# Project Map\n\n## Structure\n\n- `lib/` — <!-- describe -->\n- `test/` — <!-- describe -->\n');
      fs.writeFileSync(featPath,
        '# Feature Index\n\n- **TBD** — `lib/x.js`. <!-- describe -->\n');

      const orig = aiContent.run;
      // Simulate the AI editing the files on disk: fill ALL stubs in the map,
      // and the one in FEATURES.md.
      aiContent.run = async (ctx) => {
        fs.writeFileSync(mapPath,
          '# Project Map\n\n## Structure\n\n- `lib/` — core library.\n- `test/` — the test suite.\n');
        fs.writeFileSync(featPath,
          '# Feature Index\n\n- **TBD** — `lib/x.js`. the x feature.\n');
        return { ok: true, status: 'done', output: { capturedText: '## Result\nDescribed 3 stubs.' }, blockers: [] };
      };
      try {
        const staged = {};
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'done');
        assert.equal(result.output.describedCount, 3, '2 in the map + 1 in FEATURES.md');
        // Staged shape drives the commit body line — NOT ai-content's generic marker.
        assert.deepEqual(staged['index-describe'], {
          indexDescribe: true, describedCount: 3, stepId: 'index-describe'
        });
      } finally {
        aiContent.run = orig;
      }
    });

    it('counts only the stubs actually filled (AI leaves some untouched)', async () => {
      const mapPath = path.join(projectPath, 'PROJECT-MAP.md');
      const featPath = path.join(projectPath, 'FEATURES.md');
      fs.writeFileSync(mapPath,
        '# Project Map\n\n## Structure\n\n- `lib/` — <!-- describe -->\n- `test/` — <!-- describe -->\n');
      if (fs.existsSync(featPath)) fs.unlinkSync(featPath); // map-only this case

      const orig = aiContent.run;
      aiContent.run = async () => {
        // Only fills ONE of the two stubs.
        fs.writeFileSync(mapPath,
          '# Project Map\n\n## Structure\n\n- `lib/` — core library.\n- `test/` — <!-- describe -->\n');
        return { ok: true, status: 'done', output: {}, blockers: [] };
      };
      try {
        const staged = {};
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged });
        assert.equal(result.output.describedCount, 1, 'only one of two stubs was filled');
      } finally {
        aiContent.run = orig;
      }
    });

    it('never blocks — an ai-content failure becomes a graceful skip with no staged entry', async () => {
      const mapPath = path.join(projectPath, 'PROJECT-MAP.md');
      fs.writeFileSync(mapPath,
        '# Project Map\n\n## Structure\n\n- `lib/` — <!-- describe -->\n');
      const featPath = path.join(projectPath, 'FEATURES.md');
      if (fs.existsSync(featPath)) fs.unlinkSync(featPath);

      const orig = aiContent.run;
      aiContent.run = async () => ({
        ok: false, status: 'blocked', output: null, blockers: ['AI did not return within 300s']
      });
      try {
        const staged = {};
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged });
        assert.equal(result.ok, true, 'handler result is always ok (non-blocking)');
        assert.equal(result.status, 'skipped');
        assert.match(result.output.reason, /describe not applied/);
        assert.equal(staged['index-describe'], undefined, 'no staged marker left behind on failure');
      } finally {
        aiContent.run = orig;
      }
    });
  });

  describe('commit-step body-line emission (#426)', () => {
    it('emits "- Index: described N stub(s)" when describedCount > 0', () => {
      const lines = commitStep._buildBodyLines({
        'index-describe': { indexDescribe: true, describedCount: 4, stepId: 'index-describe' }
      });
      assert.ok(lines.includes('- Index: described 4 stub(s)'));
    });

    it('emits nothing when describedCount is 0 (AI filled nothing)', () => {
      const lines = commitStep._buildBodyLines({
        'index-describe': { indexDescribe: true, describedCount: 0, stepId: 'index-describe' }
      });
      assert.equal(lines.find((l) => l.startsWith('- Index:')), undefined);
    });
  });
});
