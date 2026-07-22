'use strict';

// Tests for the `features-toc` wrap step (#207, Chunk 3).
// Covers: pure helpers (path filter, drift extraction, TODO append),
// gate semantics (toggle off, FEATURES.md missing), git plumbing
// (base-branch resolution, diff parsing), happy-path stage shape, and
// the commit body line emitted from `lib/wrap-steps/commit.js`.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
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

/**
 * Materialize repo-relative fixture paths inside a project dir.
 *
 * A stubbed `git diff` must be backed by real files: the handler only stubs
 * paths that still exist on disk, because FEATURES.md's citation contract
 * asserts every cited path exists and a dangling stub blocks the wrap's own PR.
 * Without this, a stubbed diff would describe a tree that could never occur.
 *
 * @param {string} projectPath - Absolute project root.
 * @param {...string} relativePaths - Repo-relative paths to create.
 */
function materialize(projectPath, ...relativePaths) {
  for (const rel of relativePaths) {
    const abs = path.join(projectPath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// fixture\n');
  }
}

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
      assert.equal(_isIndexableCandidate('data/engines/claude.json'), true);
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
        engine: 'claude'
      });
      materialize(projectPath, 'lib/new-thing.js', 'lib/foo.js', 'lib/bar.js');
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      // Reset project config so each test starts from the default (toggle off).
      store.projectConfig.save(projectPath, {
        engine: 'claude',
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

    it('returns ok:true,skipped when neither a session SHA nor a base branch resolves', async () => {
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        featureIndexEnabled: true
      });
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'), '# Feature Index\n\n## UI\n');

      // Stub execSync to fail every ref-resolution attempt (no lastWrapSha set,
      // and both base-branch candidates fail) → no session range resolves.
      const orig = featuresToc._internal.execSync;
      featuresToc._internal.execSync = () => { throw new Error('ref not found'); };
      try {
        const result = await featuresToc.run({
          project: createdProject,
          staged: {}
        });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'skipped');
        assert.match(result.output.reason, /no session range resolves/);
      } finally {
        featuresToc._internal.execSync = orig;
      }
    });

    it('returns ok:true,skipped when the diff is empty (no files touched)', async () => {
      store.projectConfig.save(projectPath, {
        engine: 'claude',
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
        engine: 'claude'
      });
      store.projectConfig.save(projectPath, {
        engine: 'claude',
        featureIndexEnabled: true
      });
      materialize(projectPath,
        'lib/pill.js', 'lib/new-foo.js', 'lib/new-bar.ts', 'lib/some-new.js', 'lib/idempo.js');
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

  describe('_resolveSessionRange (#465 — session diff, not branch diff)', () => {
    const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';

    it('prefers <lastWrapSha>..HEAD when the recorded SHA resolves to a commit', () => {
      const orig = featuresToc._internal.execSync;
      const calls = [];
      featuresToc._internal.execSync = (cmd) => { calls.push(cmd); return Buffer.from(''); };
      try {
        const r = featuresToc._resolveSessionRange('/repo', SHA);
        assert.deepEqual(r, { range: `${SHA}..HEAD`, kind: 'session', baseBranch: null });
        // It verified the SHA peels to a commit; no base-branch resolution needed.
        assert.ok(calls.some((c) => c.includes(`${SHA}^{commit}`)));
        assert.ok(!calls.some((c) => c.includes('rev-parse --verify --quiet main')));
      } finally {
        featuresToc._internal.execSync = orig;
      }
    });

    it('falls back to <base>...HEAD on the first wrap (no lastWrapSha)', () => {
      const orig = featuresToc._internal.execSync;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.includes('rev-parse --verify --quiet main')) return Buffer.from('');
        throw new Error('nope');
      };
      try {
        const r = featuresToc._resolveSessionRange('/repo', null);
        assert.deepEqual(r, { range: 'main...HEAD', kind: 'branch', baseBranch: 'main' });
      } finally {
        featuresToc._internal.execSync = orig;
      }
    });

    it('falls back to <base>...HEAD when the recorded SHA no longer resolves (rebase / fresh clone)', () => {
      const orig = featuresToc._internal.execSync;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.includes(`${SHA}^{commit}`)) throw new Error('bad object');
        if (cmd.includes('rev-parse --verify --quiet main')) return Buffer.from('');
        throw new Error('nope');
      };
      try {
        const r = featuresToc._resolveSessionRange('/repo', SHA);
        assert.equal(r.kind, 'branch');
        assert.equal(r.range, 'main...HEAD');
      } finally {
        featuresToc._internal.execSync = orig;
      }
    });

    it('never shells out a malformed lastWrapSha; treats it as unresolvable', () => {
      const orig = featuresToc._internal.execSync;
      const calls = [];
      featuresToc._internal.execSync = (cmd) => {
        calls.push(cmd);
        if (cmd.includes('rev-parse --verify --quiet main')) return Buffer.from('');
        throw new Error('nope');
      };
      try {
        const r = featuresToc._resolveSessionRange('/repo', 'not-a-sha; rm -rf /');
        assert.equal(r.kind, 'branch', 'malformed SHA must not be used as a range');
        assert.ok(!calls.some((c) => c.includes('rm -rf')), 'the bad value must never reach a shell command');
      } finally {
        featuresToc._internal.execSync = orig;
      }
    });

    it('returns null when neither a session SHA nor a base branch resolves', () => {
      const orig = featuresToc._internal.execSync;
      featuresToc._internal.execSync = () => { throw new Error('nothing resolves'); };
      try {
        assert.equal(featuresToc._resolveSessionRange('/repo', SHA), null);
      } finally {
        featuresToc._internal.execSync = orig;
      }
    });
  });

  describe('handler — #465 regression (wrap on main after merges captures the session)', () => {
    let tmpDir;
    let projectPath;
    let createdProject;
    const SHA = 'feedbeefcafe0011223344556677889900aabbcc';

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-features-toc-465-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const cfg = store.config.load();
      cfg.projectsDir = projectsDir;
      store.config.save(cfg);
      projectPath = path.join(projectsDir, 'features-toc-465');
      fs.mkdirSync(projectPath, { recursive: true });
      createdProject = store.projects.create({
        name: 'features-toc-465', path: projectPath, engine: 'claude'
      });
      materialize(projectPath, 'lib/merged-a.js', 'lib/merged-b.js');
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('diffs <lastWrapSha>..HEAD so files merged this session are stubbed even though main...HEAD is empty', async () => {
      store.projectConfig.save(projectPath, {
        engine: 'claude', methodology: 'minimal', featureIndexEnabled: true, lastWrapSha: SHA
      });
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'), '# Feature Index\n\n## UI\n');

      const origExec = featuresToc._internal.execSync;
      const origToday = featuresToc._internal.todayIso;
      let sawSessionDiff = false;
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.includes(`${SHA}^{commit}`)) return Buffer.from(''); // SHA resolves
        if (cmd.includes('merge-base --is-ancestor')) return Buffer.from(''); // SHA is on HEAD's history (#664)
        // The OLD (branch) range is empty — this is the wrap-on-main bug condition.
        if (cmd.includes('main...HEAD')) return Buffer.from('');
        // The NEW (session) range captures everything merged since the last wrap.
        if (cmd.includes(`${SHA}..HEAD`)) {
          sawSessionDiff = true;
          return 'lib/merged-a.js\nlib/merged-b.js\n';
        }
        if (cmd.startsWith('git rev-parse')) return Buffer.from('');
        throw new Error(`unexpected command: ${cmd}`);
      };
      featuresToc._internal.todayIso = () => '2026-07-04';
      try {
        const staged = {};
        const result = await featuresToc.run({ project: createdProject, staged });
        assert.ok(sawSessionDiff, 'the handler must diff the <lastWrapSha>..HEAD session range');
        assert.equal(result.status, 'done');
        assert.equal(result.output.addedCount, 2);
        assert.deepEqual(result.output.addedFiles, ['lib/merged-a.js', 'lib/merged-b.js']);
        assert.match(staged['features-toc:append'].newContent, /lib\/merged-a\.js/);
      } finally {
        featuresToc._internal.execSync = origExec;
        featuresToc._internal.todayIso = origToday;
      }
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

  describe('deleted files are never stubbed (dangling-citation regression)', () => {
    let tmpDir;
    let projectPath;
    let createdProject;
    let firstSha;

    // Driven against a REAL git repo, not a stubbed execSync. The bug is a
    // disagreement between what a range diff reports and what is actually on
    // disk, so a stub that hand-writes the diff output would be asserting the
    // very relationship under test — it could show the guard filtering a list,
    // never that the list git really produces contains a doomed path.
    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-features-toc-deleted-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const cfg = store.config.load();
      cfg.projectsDir = projectsDir;
      store.config.save(cfg);

      projectPath = path.join(projectsDir, 'features-toc-deleted');
      fs.mkdirSync(path.join(projectPath, 'lib'), { recursive: true });

      const git = (cmd) => execSync(`git ${cmd}`, { cwd: projectPath, stdio: 'ignore' });
      git('init -q');
      git('config user.email test@example.com');
      git('config user.name Test');
      git('config commit.gpgsign false');

      // Baseline commit — this is where the previous wrap left off.
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'), '# Feature Index\n\n## UI\n');
      fs.writeFileSync(path.join(projectPath, 'lib', 'doomed.js'), '// removed later\n');
      git('add -A');
      git('commit -q -m baseline');
      firstSha = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf8' }).trim();

      // The session: add one file, delete another. Mirrors the real #637 trigger
      // (a wrap-step file disposed of mid-session), which stubbed the deleted
      // path and blocked that wrap's own PR on the citation contract.
      fs.writeFileSync(path.join(projectPath, 'lib', 'kept.js'), '// still here\n');
      fs.rmSync(path.join(projectPath, 'lib', 'doomed.js'));
      git('add -A');
      git('commit -q -m session');

      createdProject = store.projects.create({
        name: 'features-toc-deleted', path: projectPath, engine: 'claude'
      });
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stubs a file added this session but NOT one deleted this session', async () => {
      store.projectConfig.save(projectPath, {
        engine: 'claude', methodology: 'minimal', featureIndexEnabled: true, lastWrapSha: firstSha
      });

      const origToday = featuresToc._internal.todayIso;
      featuresToc._internal.todayIso = () => '2026-07-19';
      try {
        const staged = {};
        const result = await featuresToc.run({ project: createdProject, staged });

        assert.equal(result.status, 'done');
        assert.deepEqual(result.output.addedFiles, ['lib/kept.js'],
          'the added file is stubbed; the deleted file must not appear');
        assert.equal(result.output.addedCount, 1);

        const { newContent } = staged['features-toc:append'];
        assert.match(newContent, /lib\/kept\.js/);
        assert.doesNotMatch(newContent, /doomed/,
          'a stub for a deleted path is a dangling citation — it fails the FEATURES.md citation contract and blocks the wrap PR');
      } finally {
        featuresToc._internal.todayIso = origToday;
      }
    });

    it('does NOT stub a file deleted in the WORKING TREE after being added in the range', async () => {
      // The route a range-level `--diff-filter` cannot close: `transient.js` is
      // ADDED by a commit inside the session range, so every range diff reports
      // it as added — but it is gone from the working tree, and the wrap's own
      // `git add -A` (lib/wrap-steps/commit.js) commits that deletion moments
      // after this step runs. Stubbing it would dangle by the time CI looks.
      const headBefore = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf8' }).trim();
      fs.writeFileSync(path.join(projectPath, 'lib', 'transient.js'), '// added then removed\n');
      execSync('git add -A && git commit -q -m "add transient"', { cwd: projectPath, stdio: 'ignore' });
      fs.rmSync(path.join(projectPath, 'lib', 'transient.js')); // uncommitted deletion

      store.projectConfig.save(projectPath, {
        engine: 'claude', methodology: 'minimal', featureIndexEnabled: true, lastWrapSha: headBefore
      });

      const rangeSawIt = execSync(`git diff --name-only ${headBefore}..HEAD`, { cwd: projectPath, encoding: 'utf8' });
      assert.match(rangeSawIt, /transient\.js/,
        'precondition: the range reports it as added, so only an on-disk check can catch it');

      const staged = {};
      const result = await featuresToc.run({ project: createdProject, staged });

      assert.equal(result.ok, true, 'never blocks');
      assert.equal(result.status, 'skipped', 'nothing survives to stub');
      assert.equal(staged['features-toc:append'], undefined);

      execSync('git add -A && git commit -q -m "commit the deletion"', { cwd: projectPath, stdio: 'ignore' });
    });

    it('skips entirely when the session only deleted files (nothing left to describe)', async () => {
      // Self-contained: create and commit this test's own file, then delete it,
      // so the case does not depend on a sibling test having run first.
      fs.writeFileSync(path.join(projectPath, 'lib', 'solo.js'), '// this test owns this file\n');
      execSync('git add -A && git commit -q -m "add solo"', { cwd: projectPath, stdio: 'ignore' });
      const headBefore = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf8' }).trim();
      fs.rmSync(path.join(projectPath, 'lib', 'solo.js'));
      execSync('git add -A && git commit -q -m "delete only"', { cwd: projectPath, stdio: 'ignore' });

      store.projectConfig.save(projectPath, {
        engine: 'claude', methodology: 'minimal', featureIndexEnabled: true, lastWrapSha: headBefore
      });

      const staged = {};
      const result = await featuresToc.run({ project: createdProject, staged });

      assert.equal(result.ok, true, 'never blocks');
      assert.equal(result.status, 'skipped');
      assert.equal(staged['features-toc:append'], undefined, 'nothing staged when there is no drift');
      // Pin the specific reason, not just the shared prefix: reporting an
      // all-deletions session as "already indexed" would be a false statement
      // about why nothing happened.
      assert.match(result.output.reason, /every touched file was deleted/,
        'the skip reason must name deletion as the cause');
    });
  });

  // #640: aged dangling citations (target deleted in an EARLIER session) must be
  // healed — a dead auto-stub this step wrote is pruned; a hand-written / already-
  // described one is reported, never silently rewritten. Otherwise the DOC-3K7Q
  // citation contract reds the wrap PR while every step still reports success.
  describe('_pruneDeadAutoStubs (#640)', () => {
    const PROJ = '/proj';
    let origExists;
    beforeEach(() => { origExists = featuresToc._internal.existsSync; });
    afterEach(() => { featuresToc._internal.existsSync = origExists; });

    function withExisting(relPaths) {
      const set = new Set(relPaths.map((r) => path.join(PROJ, r)));
      featuresToc._internal.existsSync = (abs) => set.has(abs);
    }

    it('removes a dead auto-stub entry and drops the emptied TODO section + its separator blank', () => {
      withExisting(['lib/widget.js']); // the hand-written entry survives; the stub target does not
      const content = [
        '# Feature Index',
        '',
        '## UI / Web',
        '- **Widget** — `lib/widget.js`.',
        '',
        '## TODO (auto-stubbed 2026-07-01)',
        '',
        '- **TBD** — touched in this session: `lib/gone.js`. <!-- describe -->',
        ''
      ].join('\n');
      const { content: out, prunedPaths } = featuresToc._pruneDeadAutoStubs(content, PROJ);
      assert.deepEqual(prunedPaths, ['lib/gone.js']);
      assert.ok(!out.includes('lib/gone.js'), 'dead stub line removed');
      assert.ok(!out.includes('## TODO (auto-stubbed 2026-07-01)'), 'emptied TODO heading removed');
      assert.ok(out.includes('## UI / Web'), 'unrelated section preserved');
      assert.ok(out.includes('- **Widget** — `lib/widget.js`.'), 'hand-written entry untouched');
      assert.ok(out.endsWith('\n'), 'trailing newline preserved');
    });

    it('prunes only the dead stub when a live stub shares the section — heading kept', () => {
      withExisting(['lib/live.js']);
      const content = [
        '# Feature Index',
        '',
        '## TODO (auto-stubbed 2026-07-01)',
        '',
        '- **TBD** — touched in this session: `lib/live.js`. <!-- describe -->',
        '- **TBD** — touched in this session: `lib/dead.js`. <!-- describe -->',
        ''
      ].join('\n');
      const { content: out, prunedPaths } = featuresToc._pruneDeadAutoStubs(content, PROJ);
      assert.deepEqual(prunedPaths, ['lib/dead.js']);
      assert.ok(out.includes('lib/live.js'), 'live stub kept');
      assert.ok(!out.includes('lib/dead.js'), 'dead stub removed');
      assert.ok(out.includes('## TODO (auto-stubbed 2026-07-01)'), 'heading kept — section still has a live stub');
    });

    it('keeps a section (and its dead stub) when operator prose shares it — prose is not ours to delete', () => {
      withExisting([]); // stub target absent
      const content = [
        '# Feature Index',
        '',
        '## TODO (auto-stubbed 2026-07-01)',
        '',
        '- **TBD** — touched in this session: `lib/dead.js`. <!-- describe -->',
        'Operator note: revisit this batch after the refactor.',
        ''
      ].join('\n');
      const { content: out, prunedPaths } = featuresToc._pruneDeadAutoStubs(content, PROJ);
      assert.deepEqual(prunedPaths, ['lib/dead.js'], 'the dead stub line itself is still pruned');
      assert.ok(out.includes('## TODO (auto-stubbed 2026-07-01)'), 'heading kept — operator prose present');
      assert.ok(out.includes('Operator note: revisit'), 'operator prose preserved');
    });

    it('does not touch a described/graduated entry pointing at a deleted file (reported, not pruned)', () => {
      withExisting([]); // lib/graduated.js is gone
      const content = [
        '# Feature Index',
        '',
        '## Server / API',
        '- **Graduated** — `lib/graduated.js` does the thing.',
        ''
      ].join('\n');
      const { content: out, prunedPaths } = featuresToc._pruneDeadAutoStubs(content, PROJ);
      assert.deepEqual(prunedPaths, [], 'a graduated entry is not the auto-stub format — pruning leaves it');
      assert.ok(out.includes('lib/graduated.js'), 'entry preserved for the report path to surface');
    });

    it('returns content unchanged when there are no auto-stub sections', () => {
      withExisting([]);
      const content = '# Feature Index\n\n## UI\n- **A** — `lib/a.js`.\n';
      const { content: out, prunedPaths } = featuresToc._pruneDeadAutoStubs(content, PROJ);
      assert.equal(out, content, 'byte-identical when nothing to prune');
      assert.deepEqual(prunedPaths, []);
    });
  });

  describe('_findDanglingCitations (#640)', () => {
    const PROJ = '/proj';
    let origExists;
    beforeEach(() => { origExists = featuresToc._internal.existsSync; });
    afterEach(() => { featuresToc._internal.existsSync = origExists; });

    function withExisting(relPaths) {
      const set = new Set(relPaths.map((r) => path.join(PROJ, r)));
      featuresToc._internal.existsSync = (abs) => set.has(abs);
    }

    it('reports a hand-written citation whose file is gone, and not one that exists', () => {
      withExisting(['lib/here.js']);
      const content = '- **Here** — `lib/here.js`.\n- **Gone** — `lib/gone.js`.\n';
      assert.deepEqual(featuresToc._findDanglingCitations(content, PROJ), ['lib/gone.js']);
    });

    it('reports a dangling `path#symbol` anchor as its full token', () => {
      withExisting([]);
      const content = '- **X** — `lib/gone.js#doThing`.\n';
      assert.deepEqual(featuresToc._findDanglingCitations(content, PROJ), ['lib/gone.js#doThing']);
    });

    it('skips globs, placeholders, non-path tokens, and vendored prefixes', () => {
      withExisting([]);
      const content = [
        '`lib/*.js`',          // glob
        '`<lib/foo.js>`',      // placeholder
        '`file.js`',           // no slash → not a repo path
        '`node_modules/x.js`', // excluded prefix
        '`and/or`'             // has slash but no indexable ext / symbol
      ].join(' ');
      assert.deepEqual(featuresToc._findDanglingCitations(content, PROJ), []);
    });

    it('dedupes a repeated dangling token', () => {
      withExisting([]);
      const content = '`lib/gone.js` … `lib/gone.js`';
      assert.deepEqual(featuresToc._findDanglingCitations(content, PROJ), ['lib/gone.js']);
    });

    it('reports a dangling non-indexable-extension citation (it reds the same required check)', () => {
      withExisting([]);
      const content = '- **Schema** — `data/schema.sql`.\n- **Logo** — `docs/logo.png`.\n';
      assert.deepEqual(
        featuresToc._findDanglingCitations(content, PROJ),
        ['data/schema.sql', 'docs/logo.png']
      );
    });

    it('does not misreport a URL as a dangling repo path', () => {
      withExisting([]);
      const content = '- **Docs** — see `https://example.com/guide.html`.\n';
      assert.deepEqual(featuresToc._findDanglingCitations(content, PROJ), []);
    });
  });

  describe('commit-step body-line — pruned dead stubs (#640)', () => {
    it('emits "- Feature Index: pruned N dead stub(s)" when prunedCount > 0', () => {
      const staged = {
        'features-toc:append': {
          primingPath: '/p/FEATURES.md',
          newContent: '# Feature Index\n',
          changed: true,
          featuresToc: true,
          addedCount: 0,
          addedFiles: [],
          prunedCount: 2,
          prunedFiles: ['lib/a.js', 'lib/b.js'],
          todoDate: null
        }
      };
      const lines = commitStep._buildBodyLines(staged);
      assert.ok(lines.includes('- Feature Index: pruned 2 dead stub(s)'),
        'the prune count gets its own audit line');
    });

    it('emits BOTH the append and the prune line when a wrap did both', () => {
      const staged = {
        'features-toc:append': {
          primingPath: '/p/FEATURES.md',
          newContent: '...',
          changed: true,
          featuresToc: true,
          addedCount: 1,
          addedFiles: ['lib/fresh.js'],
          prunedCount: 1,
          prunedFiles: ['lib/dead.js'],
          todoDate: '2026-07-22'
        }
      };
      const lines = commitStep._buildBodyLines(staged);
      assert.ok(lines.some((l) => l.includes('1 stub(s) appended')), 'append line present');
      assert.ok(lines.includes('- Feature Index: pruned 1 dead stub(s)'), 'prune line present');
    });
  });

  describe('handler — dangling-citation heal (#640)', () => {
    let tmpDir;
    let projectPath;
    let createdProject;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-features-toc-640-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const cfg = store.config.load();
      cfg.projectsDir = projectsDir;
      store.config.save(cfg);
      projectPath = path.join(projectsDir, 'features-toc-640');
      fs.mkdirSync(projectPath, { recursive: true });
      createdProject = store.projects.create({ name: 'features-toc-640', path: projectPath, engine: 'claude' });
      store.projectConfig.save(projectPath, { engine: 'claude', featureIndexEnabled: true });
      // lib/fresh.js is the only file that exists on disk; every cited-but-absent
      // path below is a genuine dangling citation.
      materialize(projectPath, 'lib/fresh.js');
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Stub execSync so the range resolves and `git diff` returns `diffOut`. */
    function stubDiff(diffOut) {
      featuresToc._internal.execSync = (cmd) => {
        if (cmd.startsWith('git rev-parse')) return Buffer.from('');
        if (cmd.startsWith('git diff')) return Buffer.from(diffOut);
        throw new Error(`unexpected command: ${cmd}`);
      };
    }

    it('prunes a dead auto-stub and stages the healed content even with no drift', async () => {
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'), [
        '# Feature Index',
        '',
        '## TODO (auto-stubbed 2026-06-01)',
        '',
        '- **TBD** — touched in this session: `lib/deleted.js`. <!-- describe -->',
        ''
      ].join('\n'));
      const origExec = featuresToc._internal.execSync;
      stubDiff(''); // empty diff → no drift; the prune alone must produce a staged write
      const staged = {};
      try {
        const result = await featuresToc.run({ project: createdProject, staged });
        assert.equal(result.status, 'done');
        assert.equal(result.output.prunedCount, 1);
        assert.deepEqual(result.output.prunedFiles, ['lib/deleted.js']);
        assert.match(result.output.detail, /pruned 1 dead auto-stub/);
        const entry = staged['features-toc:append'];
        assert.ok(entry, 'a prune with no drift still stages the healed content');
        assert.ok(!entry.newContent.includes('lib/deleted.js'), 'dead stub gone from staged content');
        assert.ok(!entry.newContent.includes('auto-stubbed 2026-06-01'), 'emptied TODO section gone');
      } finally {
        featuresToc._internal.execSync = origExec;
      }
    });

    it('reports a dangling hand-written citation without editing the file (non-blocking)', async () => {
      const featuresPath = path.join(projectPath, 'FEATURES.md');
      const original = [
        '# Feature Index',
        '',
        '## Server / API',
        '- **Old thing** — `lib/handgone.js` used to live here.',
        ''
      ].join('\n');
      fs.writeFileSync(featuresPath, original);
      const origExec = featuresToc._internal.execSync;
      stubDiff('');
      const staged = {};
      try {
        const result = await featuresToc.run({ project: createdProject, staged });
        assert.equal(result.ok, true, 'never blocks');
        assert.equal(result.status, 'done', 'surfaced as a visible finding, not a silent skip');
        assert.deepEqual(result.output.danglingHandwritten, ['lib/handgone.js']);
        assert.match(result.output.detail, /dangling hand-written citation/);
        assert.equal(staged['features-toc:append'], undefined, 'operator prose is not rewritten');
        assert.equal(fs.readFileSync(featuresPath, 'utf8'), original, 'file on disk untouched');
      } finally {
        featuresToc._internal.execSync = origExec;
      }
    });

    it('composes a prune with a drift append in one wrap', async () => {
      fs.writeFileSync(path.join(projectPath, 'FEATURES.md'), [
        '# Feature Index',
        '',
        '## TODO (auto-stubbed 2026-06-01)',
        '',
        '- **TBD** — touched in this session: `lib/deleted.js`. <!-- describe -->',
        ''
      ].join('\n'));
      const origExec = featuresToc._internal.execSync;
      const origToday = featuresToc._internal.todayIso;
      stubDiff('lib/fresh.js\n'); // lib/fresh.js exists → drift to append
      featuresToc._internal.todayIso = () => '2026-07-22';
      const staged = {};
      try {
        const result = await featuresToc.run({ project: createdProject, staged });
        assert.equal(result.status, 'done');
        assert.equal(result.output.prunedCount, 1);
        assert.equal(result.output.addedCount, 1);
        assert.deepEqual(result.output.addedFiles, ['lib/fresh.js']);
        const entry = staged['features-toc:append'];
        assert.ok(!entry.newContent.includes('lib/deleted.js'), 'dead stub pruned');
        assert.ok(entry.newContent.includes('- **TBD** — touched in this session: `lib/fresh.js`.'), 'fresh drift appended');
      } finally {
        featuresToc._internal.execSync = origExec;
        featuresToc._internal.todayIso = origToday;
      }
    });
  });
});
