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
    it('describe-mode: names the file and pins the fill-only-empty-stubs rules', () => {
      const prompt = indexDescribe._buildPrompt([
        { filename: 'PROJECT-MAP.md', label: 'Project Map', mode: 'describe', stubsBefore: 2 }
      ]);
      assert.match(prompt, /PROJECT-MAP\.md/);
      assert.match(prompt, /2 empty stubs/);
      assert.match(prompt, /<!-- describe -->/);
      assert.match(prompt, /preserve curation/i);
      assert.match(prompt, /Do NOT add, remove, reorder, or restructure/);
      assert.match(prompt, /## Result/);
      // No graduate section when there are no graduate targets.
      assert.doesNotMatch(prompt, /graduate the auto-stubbed backlog/i);
    });

    it('a missing mode defaults to describe (fill-only), never graduate', () => {
      const prompt = indexDescribe._buildPrompt([
        { filename: 'PROJECT-MAP.md', label: 'Project Map', stubsBefore: 1 }
      ]);
      assert.match(prompt, /1 empty stub\b/);
      assert.match(prompt, /Only fill empty stubs in place/);
      assert.doesNotMatch(prompt, /CURATE the auto-stubbed backlog/);
    });

    it('graduate-mode: names the file and pins the TODO-block-only curation rules', () => {
      const prompt = indexDescribe._buildPrompt([
        { filename: 'FEATURES.md', label: 'Feature Index', mode: 'graduate', entriesBefore: 3 }
      ]);
      assert.match(prompt, /FEATURES\.md/);
      assert.match(prompt, /3 entries awaiting graduation/);
      assert.match(prompt, /## TODO \(auto-stubbed/);
      assert.match(prompt, /best-fit EXISTING category/);
      assert.match(prompt, /Only ever touch entries currently inside a/);
      assert.match(prompt, /NEVER modify, reorder, or delete an entry already under a real category/);
      assert.match(prompt, /never delete it/);
      assert.match(prompt, /## Result/);
      // No describe/fill section when there are no describe targets.
      assert.doesNotMatch(prompt, /FILL empty description stubs/);
    });

    it('both modes: emits both sections when a describe and a graduate target are present', () => {
      const prompt = indexDescribe._buildPrompt([
        { filename: 'PROJECT-MAP.md', label: 'Project Map', mode: 'describe', stubsBefore: 1 },
        { filename: 'FEATURES.md', label: 'Feature Index', mode: 'graduate', entriesBefore: 2 }
      ]);
      assert.match(prompt, /FILL empty description stubs/);
      assert.match(prompt, /CURATE the auto-stubbed backlog/);
      assert.match(prompt, /PROJECT-MAP\.md/);
      assert.match(prompt, /FEATURES\.md/);
    });
  });

  describe('_countTodoEntries (pure)', () => {
    const H = '## TODO (auto-stubbed 2026-07-02)';
    it('counts list entries inside a TODO block', () => {
      const c = `# Feature Index\n\n${H}\n\n- **TBD** — \`a.js\`. <!-- describe -->\n- **TBD** — \`b.js\`. <!-- describe -->\n`;
      assert.equal(indexDescribe._countTodoEntries(c), 2);
    });
    it('counts a described-but-un-graduated entry (no marker left)', () => {
      const c = `# Feature Index\n\n${H}\n\n- **TBD** — the a feature. \`a.js\`\n`;
      assert.equal(indexDescribe._countTodoEntries(c), 1);
    });
    it('does not count entries under a real category heading', () => {
      const c = `# Feature Index\n\n## Server / API\n\n- **Real** — desc. \`r.js\`\n\n${H}\n\n- **TBD** — \`a.js\`. <!-- describe -->\n`;
      assert.equal(indexDescribe._countTodoEntries(c), 1);
    });
    it('a real heading ends the TODO block', () => {
      const c = `${H}\n\n- **TBD** — \`a.js\`.\n\n## CLI / Tooling\n\n- **After** — \`b.js\`\n`;
      assert.equal(indexDescribe._countTodoEntries(c), 1);
    });
    it('handles multiple TODO blocks', () => {
      const c = `${H}\n\n- **TBD** — \`a.js\`.\n\n## TODO (auto-stubbed 2026-07-03)\n\n- **TBD** — \`b.js\`.\n- **TBD** — \`c.js\`.\n`;
      assert.equal(indexDescribe._countTodoEntries(c), 3);
    });
    it('does not count indented sub-bullets', () => {
      const c = `${H}\n\n- **TBD** — \`a.js\`.\n  - a nested note\n`;
      assert.equal(indexDescribe._countTodoEntries(c), 1);
    });
    it('is null/non-string safe and 0 when no TODO block', () => {
      assert.equal(indexDescribe._countTodoEntries(null), 0);
      assert.equal(indexDescribe._countTodoEntries('# Feature Index\n\n## UI / Web\n\n- x\n'), 0);
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
      assert.match(result.output.reason, /stubs to describe or entries to graduate/);
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
      // Project Map (describe mode) has the stubs; keep FEATURES out of this case
      // so the count is unambiguously the describe path.
      fs.writeFileSync(mapPath,
        '# Project Map\n\n## Structure\n\n- `lib/` — <!-- describe -->\n- `test/` — <!-- describe -->\n');
      if (fs.existsSync(featPath)) fs.unlinkSync(featPath);

      const orig = aiContent.run;
      // Simulate the AI editing the files on disk: fill ALL stubs in the map.
      aiContent.run = async () => {
        fs.writeFileSync(mapPath,
          '# Project Map\n\n## Structure\n\n- `lib/` — core library.\n- `test/` — the test suite.\n');
        return { ok: true, status: 'done', output: { capturedText: '## Result\nDescribed 2 stubs.' }, blockers: [] };
      };
      try {
        const staged = {};
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'done');
        assert.equal(result.output.describedCount, 2, 'both map stubs filled');
        assert.equal(result.output.graduatedCount, 0, 'no graduate target this case');
        // Staged shape drives the commit body line — NOT ai-content's generic marker.
        assert.deepEqual(staged['index-describe'], {
          indexDescribe: true, describedCount: 2, graduatedCount: 0, stepId: 'index-describe'
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

  describe('handler — graduate mode (Feature Index convergence, #568)', () => {
    let tmpDir;
    let projectPath;
    let createdProject;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-index-graduate-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const cfg = store.config.load();
      cfg.projectsDir = projectsDir;
      store.config.save(cfg);
      projectPath = path.join(projectsDir, 'idx-grad');
      fs.mkdirSync(projectPath, { recursive: true });
      createdProject = store.projects.create({ name: 'idx-grad', path: projectPath, engine: 'claude' });
      // Feature Index on, Project Map off — isolate the graduate path.
      store.projectConfig.save(projectPath, {
        engine: 'claude', methodology: 'minimal', featureIndexEnabled: true, projectMapEnabled: false
      });
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const featPath = () => path.join(projectPath, 'FEATURES.md');

    it('graduates TODO-block entries into a category and reports the honest count', async () => {
      fs.writeFileSync(featPath(),
        '# Feature Index\n\n## Server / API\n\n## TODO (auto-stubbed 2026-07-02)\n\n'
        + '- **TBD** — touched in this session: `lib/a.js`. <!-- describe -->\n'
        + '- **TBD** — touched in this session: `lib/b.js`. <!-- describe -->\n');

      const orig = aiContent.run;
      // Simulate the AI graduating both entries under the category and deleting
      // the now-empty TODO block.
      aiContent.run = async () => {
        fs.writeFileSync(featPath(),
          '# Feature Index\n\n## Server / API\n\n'
          + '- **A handler** — does A. `lib/a.js`\n'
          + '- **B handler** — does B. `lib/b.js`\n');
        return { ok: true, status: 'done', output: {}, blockers: [] };
      };
      try {
        const staged = {};
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged });
        assert.equal(result.status, 'done');
        assert.equal(result.output.graduatedCount, 2, 'both TODO entries left the backlog');
        assert.equal(result.output.describedCount, 0, 'no describe-mode target');
        assert.deepEqual(staged['index-describe'], {
          indexDescribe: true, describedCount: 0, graduatedCount: 2, stepId: 'index-describe'
        });
      } finally {
        aiContent.run = orig;
      }
    });

    it('triggers on a described-but-un-graduated TODO entry (no marker left)', async () => {
      // The pre-existing-install case: entry has a description but still says
      // **TBD** and sits in a TODO block, with no `<!-- describe -->` marker.
      fs.writeFileSync(featPath(),
        '# Feature Index\n\n## CLI / Tooling\n\n## TODO (auto-stubbed 2026-07-01)\n\n'
        + '- **TBD** — already has a description. `lib/c.js`\n');

      const orig = aiContent.run;
      let called = false;
      aiContent.run = async () => {
        called = true;
        fs.writeFileSync(featPath(),
          '# Feature Index\n\n## CLI / Tooling\n\n- **C tool** — already has a description. `lib/c.js`\n');
        return { ok: true, status: 'done', output: {}, blockers: [] };
      };
      try {
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged: {} });
        assert.equal(called, true, 'must drive the AI even with no <!-- describe --> marker');
        assert.equal(result.output.graduatedCount, 1);
      } finally {
        aiContent.run = orig;
      }
    });

    it('skips when FEATURES.md has no TODO block (nothing to graduate)', async () => {
      fs.writeFileSync(featPath(),
        '# Feature Index\n\n## Server / API\n\n- **Real** — desc. `lib/r.js`\n');
      const orig = aiContent.run;
      let called = false;
      aiContent.run = async () => { called = true; return { ok: true, status: 'done', output: {}, blockers: [] }; };
      try {
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged: {} });
        assert.equal(result.status, 'skipped');
        assert.equal(called, false, 'a fully-graduated index needs no AI turn');
      } finally {
        aiContent.run = orig;
      }
    });

    it('defers FEATURES.md when features-toc staged an append this wrap (clobber-avoidance)', async () => {
      fs.writeFileSync(featPath(),
        '# Feature Index\n\n## TODO (auto-stubbed 2026-07-02)\n\n- **TBD** — `lib/a.js`. <!-- describe -->\n');
      const orig = aiContent.run;
      let called = false;
      aiContent.run = async () => { called = true; return { ok: true, status: 'done', output: {}, blockers: [] }; };
      try {
        const staged = { 'features-toc:append': { featuresToc: true, addedCount: 1 } };
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged });
        assert.equal(result.status, 'skipped');
        assert.equal(called, false, 'must not graduate a file with a pending staged append');
      } finally {
        aiContent.run = orig;
      }
    });

    it('honest count: an entry the AI drops (not filed) is NOT billed as graduated', async () => {
      // Conservation guard (#568): graduatedCount counts arrivals under a real
      // category, so an entry that merely leaves the TODO block (deleted, not
      // filed) must not read as success.
      fs.writeFileSync(featPath(),
        '# Feature Index\n\n## Server / API\n\n## TODO (auto-stubbed 2026-07-02)\n\n'
        + '- **TBD** — `lib/a.js`. <!-- describe -->\n- **TBD** — `lib/b.js`. <!-- describe -->\n');
      const orig = aiContent.run;
      // Misbehaving AI: deletes the TODO block entirely, files nothing.
      aiContent.run = async () => {
        fs.writeFileSync(featPath(), '# Feature Index\n\n## Server / API\n');
        return { ok: true, status: 'done', output: {}, blockers: [] };
      };
      try {
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged: {} });
        assert.equal(result.output.graduatedCount, 0, 'two entries vanished but zero arrived → graduated 0');
      } finally {
        aiContent.run = orig;
      }
    });

    it('curation invariant: does not report entries the AI left under a real category', async () => {
      // The AI (misbehaving) touches nothing — a curated entry must never be
      // counted as graduated, and the pre-existing curated entry is preserved.
      fs.writeFileSync(featPath(),
        '# Feature Index\n\n## UI / Web\n\n- **Kept** — a curated entry. `public/x.js`\n\n'
        + '## TODO (auto-stubbed 2026-07-02)\n\n- **TBD** — `lib/a.js`. <!-- describe -->\n');
      const orig = aiContent.run;
      aiContent.run = async () => ({ ok: true, status: 'done', output: {}, blockers: [] }); // no edit
      try {
        const result = await indexDescribe.run({ project: createdProject, session: SESSION, staged: {} });
        assert.equal(result.output.graduatedCount, 0, 'nothing moved → nothing graduated');
        // The curated entry is untouched on disk.
        const after = fs.readFileSync(featPath(), 'utf8');
        assert.match(after, /- \*\*Kept\*\* — a curated entry\. `public\/x\.js`/);
      } finally {
        aiContent.run = orig;
      }
    });
  });

  describe('commit-step body-line emission (#426/#568)', () => {
    it('emits "- Index: described N stub(s)" when describedCount > 0', () => {
      const lines = commitStep._buildBodyLines({
        'index-describe': { indexDescribe: true, describedCount: 4, graduatedCount: 0, stepId: 'index-describe' }
      });
      assert.ok(lines.includes('- Index: described 4 stub(s)'));
    });

    it('emits "- Feature Index: graduated N entries" when graduatedCount > 0', () => {
      const lines = commitStep._buildBodyLines({
        'index-describe': { indexDescribe: true, describedCount: 0, graduatedCount: 3, stepId: 'index-describe' }
      });
      assert.ok(lines.includes('- Feature Index: graduated 3 entries'));
      assert.equal(lines.find((l) => l.startsWith('- Index:')), undefined);
    });

    it('singularizes a single graduated entry', () => {
      const lines = commitStep._buildBodyLines({
        'index-describe': { indexDescribe: true, describedCount: 0, graduatedCount: 1, stepId: 'index-describe' }
      });
      assert.ok(lines.includes('- Feature Index: graduated 1 entry'));
    });

    it('emits both lines when the AI both graduated and described', () => {
      const lines = commitStep._buildBodyLines({
        'index-describe': { indexDescribe: true, describedCount: 2, graduatedCount: 5, stepId: 'index-describe' }
      });
      assert.ok(lines.includes('- Feature Index: graduated 5 entries'));
      assert.ok(lines.includes('- Index: described 2 stub(s)'));
    });

    it('emits nothing when both counts are 0', () => {
      const lines = commitStep._buildBodyLines({
        'index-describe': { indexDescribe: true, describedCount: 0, graduatedCount: 0, stepId: 'index-describe' }
      });
      assert.equal(lines.find((l) => l.startsWith('- Index:') || l.startsWith('- Feature Index:')), undefined);
    });

    it('still renders the legacy shape (describedCount only, no graduatedCount)', () => {
      const lines = commitStep._buildBodyLines({
        'index-describe': { indexDescribe: true, describedCount: 4, stepId: 'index-describe' }
      });
      assert.ok(lines.includes('- Index: described 4 stub(s)'));
    });
  });
});
