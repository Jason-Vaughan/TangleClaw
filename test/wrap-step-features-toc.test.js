'use strict';

// Tests for the `features-toc` wrap step (#207, Chunk 3).
// Covers: pure helpers (path filter, drift extraction, TODO append),
// gate semantics (toggle off, FEATURES.md missing), git plumbing
// (base-branch resolution, diff parsing), happy-path stage shape, and
// the commit body line emitted from `lib/wrap-steps/commit.js`.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const featuresToc = require('../lib/wrap-steps/features-toc');
const commitStep = require('../lib/wrap-steps/commit');

describe('wrap-step features-toc (#207 Chunk 3)', () => {
  describe('_todayIsoLocal (#205 parity — local-zoned date)', () => {
    // Mirrors the version-bump fix in PR #216. The bundled
    // `## TODO (auto-stubbed YYYY-MM-DD)` heading date must reflect
    // the operator's local clock, not UTC. Same three pins as the
    // version-bump test set: shape, local-vs-UTC behavior, wiring.

    it('returns YYYY-MM-DD shape (10 chars, separators at correct positions)', () => {
      const out = featuresToc._todayIsoLocal();
      assert.equal(typeof out, 'string');
      assert.equal(out.length, 10, 'should be exactly 10 characters');
      assert.equal(out[4], '-', 'separator at index 4');
      assert.equal(out[7], '-', 'separator at index 7');
      assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns LOCAL date (not UTC) when the host is in a non-UTC zone', (t) => {
      // The bug pattern is UTC emission; the fix uses local-zone date
      // components. To EXERCISE the bug-vs-fix distinction we need a
      // wall-clock moment where LOCAL date differs from UTC date —
      // i.e. a host TZ with a non-zero offset. On a UTC-host CI
      // (Linux containers default to UTC), local == UTC and the bug
      // never surfaces, so the distinguishing assertion is vacuous.
      // Skip in that case; the wiring pin below still catches
      // regressions on any host.
      if (new Date().getTimezoneOffset() === 0) {
        t.skip('host is in UTC; local-vs-UTC distinction is unobservable here');
        return;
      }

      const origDate = global.Date;
      try {
        // Construct candidate UTC moments and pick the one whose
        // LOCAL projection lives on a different calendar day than UTC.
        // Negative-offset hosts (Americas) split on the first; positive-
        // offset hosts (most of the world) split on the second.
        const candidates = [
          new origDate(origDate.UTC(2026, 4, 23, 6, 30, 0)),
          new origDate(origDate.UTC(2026, 4, 22, 18, 0, 0))
        ];
        const pinned = candidates.find((m) => {
          const utcDay = m.toISOString().slice(0, 10);
          const pad = (n) => String(n).padStart(2, '0');
          const localDay = `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
          return utcDay !== localDay;
        });
        if (!pinned) {
          t.skip('could not construct a UTC/LOCAL date-mismatch moment for this host TZ');
          return;
        }

        global.Date = class extends origDate {
          constructor(...args) {
            super(...(args.length === 0 ? [pinned.getTime()] : args));
          }
        };

        const out = featuresToc._todayIsoLocal();
        const pad = (n) => String(n).padStart(2, '0');
        const expectedLocal = `${pinned.getFullYear()}-${pad(pinned.getMonth() + 1)}-${pad(pinned.getDate())}`;
        assert.equal(out, expectedLocal,
          `must reflect local date ${expectedLocal} for the pinned UTC moment; got ${out}`);
        assert.notEqual(out, pinned.toISOString().slice(0, 10),
          'must NOT equal the UTC slice — that would mean the UTC-emitting pattern still ships');
      } finally {
        global.Date = origDate;
      }
    });

    it('default _internal.todayIso is wired to the local-zoned helper (regression pin)', () => {
      // Host-independent regression safety: a future refactor that
      // reverts to a UTC default fails this assertion on any host
      // regardless of TZ. Mirrors the wiring pin from PR #216.
      assert.equal(featuresToc._internal.todayIso, featuresToc._todayIsoLocal,
        '_internal.todayIso must point to _todayIsoLocal (the local-zoned formatter)');
    });
  });

  describe('_isIndexableCandidate', () => {
    const { _isIndexableCandidate } = featuresToc;

    it('accepts source files with allowlisted extensions', () => {
      assert.equal(_isIndexableCandidate('lib/foo.js'), true);
      assert.equal(_isIndexableCandidate('lib/foo.ts'), true);
      assert.equal(_isIndexableCandidate('public/ui.js'), true);
      assert.equal(_isIndexableCandidate('public/index.html'), true);
      assert.equal(_isIndexableCandidate('public/style.css'), true);
      assert.equal(_isIndexableCandidate('data/templates/prawduct/template.json'), true);
      assert.equal(_isIndexableCandidate('docs/note.md'), true);
      assert.equal(_isIndexableCandidate('hooks/run.sh'), true);
      assert.equal(_isIndexableCandidate('lib/foo.jsx'), true);
      assert.equal(_isIndexableCandidate('lib/foo.tsx'), true);
      assert.equal(_isIndexableCandidate('config.yaml'), true);
      assert.equal(_isIndexableCandidate('config.yml'), true);
    });

    it('rejects files outside the allowlisted extension set', () => {
      assert.equal(_isIndexableCandidate('lib/foo.txt'), false);
      assert.equal(_isIndexableCandidate('lib/binary.bin'), false);
      assert.equal(_isIndexableCandidate('lib/image.png'), false);
      assert.equal(_isIndexableCandidate('lib/foo'), false); // no extension
    });

    it('rejects vendored / build / hidden prefixes', () => {
      assert.equal(_isIndexableCandidate('node_modules/foo/index.js'), false);
      assert.equal(_isIndexableCandidate('dist/bundle.js'), false);
      assert.equal(_isIndexableCandidate('coverage/lcov.info.js'), false);
      assert.equal(_isIndexableCandidate('build/output.js'), false);
      assert.equal(_isIndexableCandidate('.git/HEAD.json'), false);
      assert.equal(_isIndexableCandidate('.tangleclaw/project.json'), false);
    });

    it('rejects any path with a leading-dot segment', () => {
      assert.equal(_isIndexableCandidate('.eslintrc.json'), false);
      assert.equal(_isIndexableCandidate('foo/.cache/bar.js'), false);
      assert.equal(_isIndexableCandidate('a/.b/c.md'), false);
    });

    it('rejects project-level docs by basename (changelog/readme/license/features.md)', () => {
      assert.equal(_isIndexableCandidate('CHANGELOG.md'), false);
      assert.equal(_isIndexableCandidate('README.md'), false);
      assert.equal(_isIndexableCandidate('LICENSE'), false);
      assert.equal(_isIndexableCandidate('FEATURES.md'), false, 'cannot index the index itself');
    });

    it('handles defensive cases — empty string, non-string, undefined', () => {
      assert.equal(_isIndexableCandidate(''), false);
      assert.equal(_isIndexableCandidate(null), false);
      assert.equal(_isIndexableCandidate(undefined), false);
      assert.equal(_isIndexableCandidate(42), false);
    });
  });

  describe('_extractIndexedPaths', () => {
    const { _extractIndexedPaths } = featuresToc;

    it('extracts backtick-wrapped paths', () => {
      const text = '## UI / Web\n- **Pill** — renders the pill: `lib/pill.js:42`.';
      const set = _extractIndexedPaths(text);
      assert.ok(set.has('lib/pill.js'), 'should extract from inside backticks');
    });

    it('extracts free-text path references', () => {
      const text = '## Server\nThe handler lives in lib/handler.js (line 12).';
      const set = _extractIndexedPaths(text);
      assert.ok(set.has('lib/handler.js'));
    });

    it('strips trailing colon line refs from the captured path', () => {
      const text = 'Handler at lib/foo.js:100 and helper lib/bar.ts:42';
      const set = _extractIndexedPaths(text);
      assert.ok(set.has('lib/foo.js'));
      assert.ok(set.has('lib/bar.ts'));
      assert.equal(set.has('lib/foo.js:100'), false, 'colon line-ref must NOT be part of the captured path');
    });

    it('handles multiple entries on the same line', () => {
      const text = '- **Foo** — does foo. `lib/foo.js`, `lib/foo2.js`, `public/bar.html`.';
      const set = _extractIndexedPaths(text);
      assert.ok(set.has('lib/foo.js'));
      assert.ok(set.has('lib/foo2.js'));
      assert.ok(set.has('public/bar.html'));
    });

    it('returns empty set on empty / non-string input', () => {
      assert.equal(_extractIndexedPaths('').size, 0);
      assert.equal(_extractIndexedPaths(null).size, 0);
      assert.equal(_extractIndexedPaths(undefined).size, 0);
    });

    it('is safe to call repeatedly (stateful regex reset)', () => {
      const text = '`lib/foo.js`, `lib/bar.js`';
      const first = _extractIndexedPaths(text);
      const second = _extractIndexedPaths(text);
      assert.equal(first.size, 2);
      assert.equal(second.size, 2,
        'lastIndex reset must allow consecutive scans on the same text to return the same set');
    });
  });

  describe('_appendTodoSection', () => {
    const { _appendTodoSection } = featuresToc;

    it('appends a new TODO section with one stub per file', () => {
      const initial = '# Feature Index\n\n## UI / Web\n- **Pill** — `lib/pill.js`.\n';
      const out = _appendTodoSection(initial, ['lib/foo.js', 'lib/bar.js'], '2026-05-22');
      assert.ok(out.includes('## TODO (auto-stubbed 2026-05-22)'));
      assert.ok(out.includes('- **TBD** — touched in this session: `lib/foo.js`.'));
      assert.ok(out.includes('- **TBD** — touched in this session: `lib/bar.js`.'));
      assert.ok(out.endsWith('\n'), 'final newline preserved');
    });

    it('trims trailing whitespace before appending so the new section is tight', () => {
      const initial = '# Feature Index\n\n## UI\n- **A** — `a.js`.\n\n\n\n';
      const out = _appendTodoSection(initial, ['b.js'], '2026-05-22');
      assert.equal(out.includes('\n\n\n\n## TODO'), false, 'trailing blank-line run must be normalized');
      assert.ok(out.includes('\n\n## TODO (auto-stubbed 2026-05-22)\n'),
        'exactly one blank line between prior content and the new heading');
    });

    it('preserves all prior content byte-for-byte (up to trailing whitespace)', () => {
      const initial = '# Feature Index\n\nLine A\nLine B\n';
      const out = _appendTodoSection(initial, ['c.js'], '2026-05-22');
      assert.ok(out.startsWith('# Feature Index\n\nLine A\nLine B\n\n## TODO'),
        'leading content survives verbatim');
    });
  });

  describe('handler — skip semantics (never blocks)', () => {
    let tmpDir;
    let projectPath;
    let createdProject;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-features-toc-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();

      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const cfg = store.config.load();
      cfg.projectsDir = projectsDir;
      store.config.save(cfg);

      projectPath = path.join(projectsDir, 'features-toc-test');
      fs.mkdirSync(projectPath, { recursive: true });
      createdProject = store.projects.create({
        name: 'features-toc-test',
        path: projectPath,
        engine: 'claude',
        methodology: 'minimal'
      });
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      // Reset project config so each test starts from the default (toggle off).
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        methodology: 'minimal',
        featureIndexEnabled: false
      });
      try { fs.rmSync(path.join(projectPath, 'FEATURES.md'), { force: true }); } catch {}
    });

    it('returns ok:true,skipped when project path missing', async () => {
      const result = await featuresToc.run({
        project: null,
        staged: {}
      });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /no project path/i);
    });

    it('returns ok:true,skipped when featureIndexEnabled is not true', async () => {
      // Toggle stays false from beforeEach.
      const result = await featuresToc.run({
        project: createdProject,
        staged: {}
      });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /featureIndexEnabled/i);
    });

    it('self-heals (creates the seed) when FEATURES.md is missing but the toggle is on (#425)', async () => {
      // Parity with project-map's #423: the toggle is the off-switch, not file
      // deletion. A missing file under an enabled toggle is created, not skipped.
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        methodology: 'minimal',
        featureIndexEnabled: true
      });
      // No base branch resolves → the create path stages the bare seed.
      const orig = featuresToc._internal.execSync;
      featuresToc._internal.execSync = () => { throw new Error('ref not found'); };
      const staged = {};
      try {
        const result = await featuresToc.run({ project: createdProject, staged });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'done');
        assert.equal(result.output.created, true);
        assert.equal(result.output.addedCount, 0);
        const entry = staged['features-toc:append'];
        assert.ok(entry, 'a staged write must be produced so the commit flush creates the file');
        assert.equal(entry.created, true);
        assert.equal(entry.featuresToc, true);
        assert.equal(entry.changed, true);
        assert.match(entry.newContent, /^# Feature Index/, 'staged content is the seed template');
        assert.equal(entry.todoDate, null);
      } finally {
        featuresToc._internal.execSync = orig;
      }
    });

    it('self-heals AND appends drift when FEATURES.md is missing and the session touched new files (#425)', async () => {
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        methodology: 'minimal',
        featureIndexEnabled: true
      });
      const orig = featuresToc._internal.execSync;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.startsWith('git rev-parse')) return Buffer.from('');
        if (cmd.startsWith('git diff')) return Buffer.from('lib/new-thing.js\n');
        throw new Error(`unexpected command: ${cmd}`);
      };
      const staged = {};
      try {
        const result = await featuresToc.run({ project: createdProject, staged });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'done');
        assert.equal(result.output.created, true);
        assert.equal(result.output.addedCount, 1);
        const entry = staged['features-toc:append'];
        assert.ok(entry);
        assert.equal(entry.created, true);
        assert.equal(entry.featuresToc, true);
        assert.match(entry.newContent, /^# Feature Index/, 'built on the seed');
        assert.match(entry.newContent, /lib\/new-thing\.js/, 'drift appended onto the seed');
        assert.deepEqual(entry.addedFiles, ['lib/new-thing.js']);
      } finally {
        featuresToc._internal.execSync = orig;
      }
    });

    it('returns ok:true,skipped when base branch (main/master) cannot resolve', async () => {
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        methodology: 'minimal',
        featureIndexEnabled: true
      });
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'), '# Feature Index\n\n## UI\n');

      // Stub execSync to fail every base-branch resolution attempt.
      const orig = featuresToc._internal.execSync;
      featuresToc._internal.execSync = () => { throw new Error('ref not found'); };
      try {
        const result = await featuresToc.run({
          project: createdProject,
          staged: {}
        });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'skipped');
        assert.match(result.output.reason, /no base branch/);
      } finally {
        featuresToc._internal.execSync = orig;
      }
    });

    it('returns ok:true,skipped when the diff is empty (no files touched)', async () => {
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        methodology: 'minimal',
        featureIndexEnabled: true
      });
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'), '# Feature Index\n');

      const origExec = featuresToc._internal.execSync;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.startsWith('git rev-parse')) return Buffer.from('');
        if (cmd.startsWith('git diff')) return Buffer.from('');
        throw new Error(`unexpected command: ${cmd}`);
      };
      try {
        const result = await featuresToc.run({
          project: createdProject,
          staged: {}
        });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'skipped');
        assert.match(result.output.reason, /no files touched/);
      } finally {
        featuresToc._internal.execSync = origExec;
      }
    });

    it('returns ok:true,skipped when every touched file is already indexed', async () => {
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        methodology: 'minimal',
        featureIndexEnabled: true
      });
      // Index already mentions both files.
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'),
        '# Feature Index\n\n- **Foo** — `lib/foo.js`.\n- **Bar** — `lib/bar.js`.\n');

      const origExec = featuresToc._internal.execSync;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.startsWith('git rev-parse')) return Buffer.from('');
        if (cmd.startsWith('git diff')) return 'lib/foo.js\nlib/bar.js\n';
        throw new Error(`unexpected command: ${cmd}`);
      };
      try {
        const result = await featuresToc.run({
          project: createdProject,
          staged: {}
        });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'skipped');
        assert.match(result.output.reason, /no drift/);
      } finally {
        featuresToc._internal.execSync = origExec;
      }
    });

    it('returns ok:true,skipped when every touched file is excluded by the filter', async () => {
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        methodology: 'minimal',
        featureIndexEnabled: true
      });
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'), '# Feature Index\n');

      const origExec = featuresToc._internal.execSync;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.startsWith('git rev-parse')) return Buffer.from('');
        if (cmd.startsWith('git diff')) {
          // All exclusion-tripping paths — nothing should survive the filter.
          return 'README.md\nCHANGELOG.md\nnode_modules/foo/x.js\n.eslintrc.json\nFEATURES.md\n';
        }
        throw new Error(`unexpected command: ${cmd}`);
      };
      try {
        const result = await featuresToc.run({
          project: createdProject,
          staged: {}
        });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'skipped');
        assert.match(result.output.reason, /no indexable candidates/);
      } finally {
        featuresToc._internal.execSync = origExec;
      }
    });
  });

  describe('handler — happy path (drift detected → staged append)', () => {
    let tmpDir;
    let projectPath;
    let createdProject;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-features-toc-happy-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();

      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const cfg = store.config.load();
      cfg.projectsDir = projectsDir;
      store.config.save(cfg);

      projectPath = path.join(projectsDir, 'features-toc-happy');
      fs.mkdirSync(projectPath, { recursive: true });
      createdProject = store.projects.create({
        name: 'features-toc-happy',
        path: projectPath,
        engine: 'claude',
        methodology: 'minimal'
      });
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        methodology: 'minimal',
        featureIndexEnabled: true
      });
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      // Reset the index between cases.
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'),
        '# Feature Index\n\n## UI / Web\n- **Pill** — `lib/pill.js`.\n');
    });

    it('stages an append with shape {primingPath, newContent, changed:true, addedCount, addedFiles, todoDate}', async () => {
      const origExec = featuresToc._internal.execSync;
      const origToday = featuresToc._internal.todayIso;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.startsWith('git rev-parse')) return Buffer.from('');
        if (cmd.startsWith('git diff')) return 'lib/pill.js\nlib/new-foo.js\nlib/new-bar.ts\n';
        throw new Error(`unexpected command: ${cmd}`);
      };
      featuresToc._internal.todayIso = () => '2026-05-22';

      try {
        const staged = {};
        const result = await featuresToc.run({
          project: createdProject,
          staged
        });

        assert.equal(result.ok, true);
        assert.equal(result.status, 'done');
        assert.equal(result.output.addedCount, 2, 'lib/pill.js is already indexed; the other two are drift');
        assert.deepEqual(result.output.addedFiles, ['lib/new-foo.js', 'lib/new-bar.ts']);
        assert.equal(result.output.todoDate, '2026-05-22');
        assert.match(result.output.detail, /2 untracked file/);

        const entry = staged['features-toc:append'];
        assert.ok(entry, 'staged composite key must be set');
        assert.equal(entry.primingPath, path.join(projectPath, 'FEATURES.md'));
        assert.equal(entry.changed, true);
        assert.equal(entry.addedCount, 2);
        assert.deepEqual(entry.addedFiles, ['lib/new-foo.js', 'lib/new-bar.ts']);
        assert.equal(entry.todoDate, '2026-05-22');
        assert.ok(entry.newContent.includes('## TODO (auto-stubbed 2026-05-22)'));
        assert.ok(entry.newContent.includes('- **TBD** — touched in this session: `lib/new-foo.js`.'));
        assert.ok(entry.newContent.includes('- **TBD** — touched in this session: `lib/new-bar.ts`.'));
      } finally {
        featuresToc._internal.execSync = origExec;
        featuresToc._internal.todayIso = origToday;
      }
    });

    it('does NOT write the filesystem — the file content on disk is unchanged after the handler runs', async () => {
      const featuresPath = path.join(projectPath, 'FEATURES.md');
      const before = fs.readFileSync(featuresPath, 'utf8');

      const origExec = featuresToc._internal.execSync;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.startsWith('git rev-parse')) return Buffer.from('');
        if (cmd.startsWith('git diff')) return 'lib/some-new.js\n';
        throw new Error(`unexpected command: ${cmd}`);
      };
      try {
        await featuresToc.run({
          project: createdProject,
          staged: {}
        });
        const after = fs.readFileSync(featuresPath, 'utf8');
        assert.equal(after, before,
          'single-transaction discipline: handler stages content but never writes — flush is the commit step\'s job');
      } finally {
        featuresToc._internal.execSync = origExec;
      }
    });

    it('idempotence — re-running with the same staged content after a flush appends nothing new', async () => {
      const featuresPath = path.join(projectPath, 'FEATURES.md');
      const origExec = featuresToc._internal.execSync;
      const origToday = featuresToc._internal.todayIso;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.startsWith('git rev-parse')) return Buffer.from('');
        if (cmd.startsWith('git diff')) return 'lib/idempo.js\n';
        throw new Error(`unexpected command: ${cmd}`);
      };
      featuresToc._internal.todayIso = () => '2026-05-22';

      try {
        const staged1 = {};
        const r1 = await featuresToc.run({ project: createdProject, staged: staged1 });
        assert.equal(r1.status, 'done');
        // Simulate the commit step's flush.
        fs.writeFileSync(featuresPath, staged1['features-toc:append'].newContent);

        // Second run on the same diff — the file now contains lib/idempo.js,
        // so drift detection should find no new files.
        const staged2 = {};
        const r2 = await featuresToc.run({ project: createdProject, staged: staged2 });
        assert.equal(r2.status, 'skipped');
        assert.match(r2.output.reason, /no drift/);
        assert.equal(staged2['features-toc:append'], undefined,
          'idempotent re-run must not stage a duplicate append');
      } finally {
        featuresToc._internal.execSync = origExec;
        featuresToc._internal.todayIso = origToday;
      }
    });
  });

  describe('cached-install reconciliation (CHANGELOG migration-note pin)', () => {
    it('_reconcileMergeBy:id end-appends features-toc on a cached install missing the step (caveat regression pin)', () => {
      // Mirrors the prawduct-aicontent-prompts test's reconciliation
      // pin. The CHANGELOG entry for Chunk 3 explicitly warns that
      // existing installs with a cached `~/.tangleclaw/templates/
      // prawduct/template.json` predating this PR will receive
      // `features-toc` at the END of the steps array (after `commit`),
      // not in the bundled-position-correct slot between
      // `next-session-prime` and `memory-update`. If `_reconcileMergeBy`
      // ever changes to position-aware insert, this test fails — and
      // the CHANGELOG migration-note can be removed at that point.
      const cachedLiveSteps = [
        { id: 'open-pr-check', kind: 'pr-check', blocker: false },
        { id: 'critic-check', kind: 'critic-check', blocker: false },
        { id: 'version-bump', kind: 'version-bump', blocker: false },
        { id: 'changelog-update', kind: 'ai-content', prompt: 'old' },
        { id: 'learnings-capture', kind: 'ai-content', prompt: 'old' },
        { id: 'next-session-prime', kind: 'priming-roll' },
        { id: 'memory-update', kind: 'ai-content', prompt: 'old' },
        { id: 'commit', kind: 'commit', blocker: true }
      ];
      const bundledSteps = [
        { id: 'open-pr-check', kind: 'pr-check', blocker: false },
        { id: 'critic-check', kind: 'critic-check', blocker: false },
        { id: 'version-bump', kind: 'version-bump', blocker: false },
        { id: 'changelog-update', kind: 'ai-content', prompt: 'new' },
        { id: 'learnings-capture', kind: 'ai-content', prompt: 'new' },
        { id: 'next-session-prime', kind: 'priming-roll' },
        { id: 'features-toc', kind: 'features-toc' },
        { id: 'memory-update', kind: 'ai-content', prompt: 'new' },
        { id: 'commit', kind: 'commit', blocker: true }
      ];

      const merged = store._reconcileMergeBy(cachedLiveSteps, bundledSteps, 'id');
      assert.ok(Array.isArray(merged), 'merge produces a new array (bundled had a new id)');
      assert.equal(merged.length, 9, 'one new entry appended');

      const mergedIds = merged.map((s) => s.id);
      assert.deepStrictEqual(
        mergedIds,
        [
          'open-pr-check',
          'critic-check',
          'version-bump',
          'changelog-update',
          'learnings-capture',
          'next-session-prime',
          'memory-update',
          'commit',
          'features-toc'
        ],
        'features-toc lands at end-of-array; bundled-correct slot between next-session-prime and memory-update is NOT honored. '
        + 'This is the documented caveat — cached installs must delete `~/.tangleclaw/templates/prawduct/template.json` to pick up the bundled order.'
      );

      // Specifically: features-toc lands AFTER commit on a cached install
      // — which is what makes the stub append a silent no-op (commit is
      // the flusher, and runs before the staging step).
      const commitIdx = mergedIds.indexOf('commit');
      const featuresIdx = mergedIds.indexOf('features-toc');
      assert.ok(featuresIdx > commitIdx,
        'features-toc must land after commit on cached installs (the silent no-op condition documented in CHANGELOG)');
    });
  });

  describe('commit-step body-line emission (#207 Chunk 3 — duck-typed)', () => {
    it('emits "- Feature Index: N stub(s) appended (files…)" when staged.addedCount > 0', () => {
      const staged = {
        'features-toc:append': {
          primingPath: '/p/FEATURES.md',
          newContent: '...',
          changed: true,
          featuresToc: true,
          addedCount: 2,
          addedFiles: ['lib/foo.js', 'lib/bar.js'],
          todoDate: '2026-05-22'
        }
      };
      const lines = commitStep._buildBodyLines(staged);
      const matched = lines.find((l) => l.startsWith('- Feature Index:'));
      assert.ok(matched, 'commit body must include the feature-index summary line');
      assert.match(matched, /2 stub\(s\) appended/);
      assert.ok(matched.includes('lib/foo.js'));
      assert.ok(matched.includes('lib/bar.js'));
    });

    it('truncates the preview to 3 files and appends "+N more" beyond that', () => {
      const staged = {
        'features-toc:append': {
          primingPath: '/p/FEATURES.md',
          newContent: '...',
          changed: true,
          featuresToc: true,
          addedCount: 5,
          addedFiles: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'],
          todoDate: '2026-05-22'
        }
      };
      const lines = commitStep._buildBodyLines(staged);
      const matched = lines.find((l) => l.startsWith('- Feature Index:'));
      assert.ok(matched, 'commit body must include the feature-index summary line');
      assert.match(matched, /a\.js, b\.js, c\.js, \+2 more/);
    });

    it('emits nothing when addedCount is 0 (defensive)', () => {
      const staged = {
        'features-toc:append': {
          primingPath: '/p/FEATURES.md',
          newContent: '...',
          changed: true,
          featuresToc: true,
          addedCount: 0,
          addedFiles: [],
          todoDate: '2026-05-22'
        }
      };
      const lines = commitStep._buildBodyLines(staged);
      const matched = lines.find((l) => l.startsWith('- Feature Index:'));
      assert.equal(matched, undefined,
        'no body line when there were zero adds — the handler would have skipped, but the duck-type must be defensive');
    });

    it('emits "- Feature Index: created" when self-heal created the file with no drift (#425)', () => {
      const staged = {
        'features-toc:append': {
          primingPath: '/p/FEATURES.md',
          newContent: '# Feature Index\n',
          changed: true,
          featuresToc: true,
          created: true,
          addedCount: 0,
          addedFiles: [],
          todoDate: null
        }
      };
      const lines = commitStep._buildBodyLines(staged);
      assert.ok(lines.includes('- Feature Index: created'),
        'self-heal create with no drift gets a bare "created" line');
    });

    it('emits "- Feature Index: created (N stub(s) appended)" when self-heal created the file with drift (#425)', () => {
      const staged = {
        'features-toc:append': {
          primingPath: '/p/FEATURES.md',
          newContent: '# Feature Index\n...',
          changed: true,
          featuresToc: true,
          created: true,
          addedCount: 3,
          addedFiles: ['lib/a.js', 'lib/b.js', 'lib/c.js'],
          todoDate: '2026-06-30'
        }
      };
      const lines = commitStep._buildBodyLines(staged);
      assert.ok(lines.includes('- Feature Index: created (3 stub(s) appended)'),
        'self-heal create with drift reports the appended count');
    });
  });
});
