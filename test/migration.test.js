'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');

describe('migration — detectExistingProjects', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-migration-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();

    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects project with .tangleclaw/project.json marker', () => {
    const projDir = path.join(projectsDir, 'tc-marked');
    fs.mkdirSync(path.join(projDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.tangleclaw', 'project.json'), '{}');

    const result = projects.detectExistingProjects();
    const found = result.detected.find(d => d.name === 'tc-marked');
    assert.ok(found, 'should detect project with .tangleclaw config');
    assert.equal(found.hasTangleclawConfig, true);
  });

  it('detects project with a .prawduct governance marker', () => {
    const projDir = path.join(projectsDir, 'prawduct-proj');
    fs.mkdirSync(path.join(projDir, '.prawduct'), { recursive: true });

    const result = projects.detectExistingProjects();
    const found = result.detected.find(d => d.name === 'prawduct-proj');
    assert.ok(found, 'should detect project with .prawduct marker');
  });

  it('no longer detects a .tilt marker as a project (tilt retired)', () => {
    // TiLT was retired (operator-ratified 2026-07-17). The scan surfaces
    // dirs with a TC config or a governance marker; a leftover .tilt
    // dir is neither anymore, so it must not read as an existing project.
    const projDir = path.join(projectsDir, 'tilt-proj');
    fs.mkdirSync(path.join(projDir, '.tilt'), { recursive: true });

    const result = projects.detectExistingProjects();
    assert.ok(!result.detected.some(d => d.name === 'tilt-proj'),
      'a bare .tilt dir must no longer register as a project marker');
  });

  it('skips already registered projects', () => {
    // Create and register a project
    projects.createProject({ name: 'registered-proj', gitInit: false });

    const result = projects.detectExistingProjects();
    assert.ok(!result.detected.some(d => d.name === 'registered-proj'),
      'should not detect already registered project');
  });

  it('skips hidden directories', () => {
    fs.mkdirSync(path.join(projectsDir, '.hidden-project'), { recursive: true });
    fs.mkdirSync(path.join(projectsDir, '.hidden-project', '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, '.hidden-project', '.tangleclaw', 'project.json'), '{}');

    const result = projects.detectExistingProjects();
    assert.ok(!result.detected.some(d => d.name === '.hidden-project'),
      'should skip hidden directories');
  });

  it('skips non-directory entries', () => {
    fs.writeFileSync(path.join(projectsDir, 'just-a-file.txt'), 'not a project');

    const result = projects.detectExistingProjects();
    assert.ok(!result.detected.some(d => d.name === 'just-a-file.txt'),
      'should skip regular files');
  });

  it('returns empty array for empty projectsDir', () => {
    const emptyDir = path.join(tmpDir, 'empty-projects');
    fs.mkdirSync(emptyDir, { recursive: true });

    const config = store.config.load();
    const origDir = config.projectsDir;
    config.projectsDir = emptyDir;
    store.config.save(config);

    const result = projects.detectExistingProjects();
    assert.deepEqual(result.detected, []);
    assert.deepEqual(result.errors, []);

    // Restore
    config.projectsDir = origDir;
    store.config.save(config);
  });

  it('detects project with both .tangleclaw and governance markers', () => {
    const projDir = path.join(projectsDir, 'both-markers');
    fs.mkdirSync(path.join(projDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.tangleclaw', 'project.json'), '{}');
    fs.mkdirSync(path.join(projDir, '.prawduct'), { recursive: true });

    const result = projects.detectExistingProjects();
    const found = result.detected.find(d => d.name === 'both-markers');
    assert.ok(found, 'should detect project with both markers');
    assert.equal(found.hasTangleclawConfig, true);
  });

  /*
   * #920 — the other member of the #708 family. #708 stopped the setup wizard
   * offering the running checkout as a candidate; this path is worse, because
   * it REGISTERS what it finds: writing `.tangleclaw/project.json` into the
   * clone dirties it and strands the self-updater behind its dirty-tree guard.
   *
   * The install carries both detection markers, so nothing else in this
   * function keeps it out.
   */
  describe('#920 — the running install is never a detected project', () => {
    // The scenario is not hypothetical and cannot be faked with a symlink:
    // `readdirSync(…, {withFileTypes:true})` reports a symlink as
    // isSymbolicLink(), not isDirectory(), so a symlinked stand-in is skipped
    // long before the exclusion runs and would prove nothing. The real shape
    // is the install sitting as a REAL directory inside the scanned folder —
    // which is what the README's install steps produce, because the operator
    // clones into the same folder they then name as their projects directory.
    //
    // So the fixture points the scan at the install's own parent.
    const ownInstall = fs.realpathSync(path.join(__dirname, '..'));
    const ownParent = path.dirname(ownInstall);
    const ownName = path.basename(ownInstall);

    /** Run a detection with `projectsDir` pointed somewhere else, then restore. */
    function detectIn(dir) {
      const config = store.config.load();
      const orig = config.projectsDir;
      config.projectsDir = dir;
      store.config.save(config);
      try {
        return projects.detectExistingProjects();
      } finally {
        const c = store.config.load();
        c.projectsDir = orig;
        store.config.save(c);
      }
    }

    it('excludes the running checkout even though it carries a marker', () => {
      // Proof the fixture is the real shape rather than a stand-in: the
      // install really does carry a marker the scan keys on, so the exclusion
      // is the only thing that can keep it out of the result.
      assert.ok(fs.existsSync(path.join(ownInstall, '.prawduct')),
        'the install must actually carry a marker, or this test proves nothing');

      const result = detectIn(ownParent);
      assert.ok(!result.detected.some((d) => d.name === ownName),
        'registering the install into itself dirties the clone and breaks self-update');
      assert.deepEqual(result.errors, [], 'exclusion is silent, not an error');
    });

    it('identifies the install by realpath, not by the path string it was reached through', () => {
      // Reached via a symlinked parent, the scanned path is a different string
      // from the install's realpath — the shape macOS produces for /tmp vs
      // /private/tmp. A string compare passes the test above and fails here.
      const linkedParent = path.join(tmpDir, 'linked-parent');
      fs.symlinkSync(ownParent, linkedParent, 'dir');
      try {
        const result = detectIn(linkedParent);
        assert.ok(!result.detected.some((d) => d.name === ownName),
          'identity is the realpath, not the route the operator happened to take');
      } finally {
        fs.unlinkSync(linkedParent);
      }
    });

    it('still detects an ordinary marked project sitting beside it', () => {
      // The exclusion must be surgical — a scan that dropped everything, or
      // that bailed on the whole directory, would pass both tests above while
      // silently breaking the feature.
      const neighbour = path.join(ownParent, 'tc-920-neighbour');
      fs.mkdirSync(path.join(neighbour, '.prawduct'), { recursive: true });
      try {
        const result = detectIn(ownParent);
        assert.ok(result.detected.some((d) => d.name === 'tc-920-neighbour'),
          'only the install is excluded, not the directory it sits in');
      } finally {
        fs.rmSync(neighbour, { recursive: true, force: true });
      }
    });
  });
});
