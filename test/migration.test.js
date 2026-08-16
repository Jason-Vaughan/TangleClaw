'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
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
   * offering the running checkout as a candidate; this is the same omission in
   * the other detection path.
   *
   * The harm is what a caller does with the answer: #708's scan fed a
   * pre-checked box that attached the clone as a project, writing per-project
   * config into it — which dirties the checkout and strands the self-updater
   * behind its dirty-tree guard. `detectExistingProjects` only reports, and
   * today only tests call it, so this closes the hole before a caller reopens
   * it rather than fixing damage the function does on its own.
   *
   * The install carries both detection markers, so nothing else in this
   * function keeps it out.
   */
  describe('#920 — the running install is never a detected project', () => {
    // The scenario cannot be faked with a symlink standing in for the install:
    // `readdirSync(…, {withFileTypes:true})` reports a symlink as
    // isSymbolicLink(), not isDirectory(), so such an entry is skipped long
    // before the exclusion runs and would prove nothing. The real shape is the
    // install sitting as a REAL directory inside the scanned folder — what the
    // README's install steps produce, because the operator clones into the
    // same folder they then name as their projects directory.
    //
    // The install cannot be moved into a temp dir, and pointing the scan at the
    // REAL install's parent would walk the operator's actual projects directory
    // — the TCC-protected path whose synchronous readdir this function's own
    // note says never returns. So the install's identity is injected instead,
    // exactly as `scanDirectoryForProjects` passes `ownInstallRealPath` to its
    // child, and everything here happens inside the suite's temp directory.
    let scanDir;
    let installDir;

    beforeEach(() => {
      scanDir = fs.mkdtempSync(path.join(tmpDir, 'scan-'));
      installDir = path.join(scanDir, 'TangleClaw');
      // A stand-in install carrying the same marker the real clone carries, so
      // the exclusion is the only thing that can keep it out of the result.
      fs.mkdirSync(path.join(installDir, '.prawduct'), { recursive: true });
      fs.mkdirSync(path.join(installDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(installDir, '.tangleclaw', 'project.json'), '{}');
    });

    /** Detect inside `dir`, treating `install` as the running checkout. */
    function detectIn(dir, install) {
      const config = store.config.load();
      const orig = config.projectsDir;
      config.projectsDir = dir;
      store.config.save(config);
      try {
        return projects.detectExistingProjects({
          ownInstallRealPath: fs.realpathSync(install)
        });
      } finally {
        const c = store.config.load();
        c.projectsDir = orig;
        store.config.save(c);
      }
    }

    it('excludes the running checkout even though it carries both markers', () => {
      const result = detectIn(scanDir, installDir);
      assert.ok(!result.detected.some((d) => d.name === 'TangleClaw'),
        'a caller wired to this must not be handed the tool as a candidate project');
      assert.deepEqual(result.errors, [], 'exclusion is silent, not an error');
    });

    it('detects that same directory when it is NOT the running install', () => {
      // Isolates the exclusion from the marker check: the identical directory,
      // with the identical markers, must be detected when it is someone else's
      // checkout. Without this, a broken marker check would pass the test above.
      const other = path.join(scanDir, 'not-the-install');
      fs.mkdirSync(path.join(other, '.prawduct'), { recursive: true });
      const result = detectIn(scanDir, other);
      assert.ok(result.detected.some((d) => d.name === 'TangleClaw'),
        'the exclusion must key on identity, not on carrying markers');
    });

    it('identifies the install by realpath, not by the path string it was reached through', () => {
      // Reached via a symlinked parent the scanned path is a different string
      // from the install's realpath — the shape macOS produces for /tmp vs
      // /private/tmp. A string compare passes the first test and fails here.
      const linked = path.join(tmpDir, 'linked-scan');
      fs.symlinkSync(scanDir, linked, 'dir');
      try {
        const result = detectIn(linked, installDir);
        assert.ok(!result.detected.some((d) => d.name === 'TangleClaw'),
          'identity is the realpath, not the route the operator happened to take');
      } finally {
        fs.unlinkSync(linked);
      }
    });

    it('still detects an ordinary marked project sitting beside it', () => {
      // The exclusion must be surgical — a scan that dropped everything, or
      // bailed on the whole directory, would pass the tests above while
      // silently breaking the feature.
      const neighbour = path.join(scanDir, 'innocent-neighbour');
      fs.mkdirSync(path.join(neighbour, '.prawduct'), { recursive: true });
      const result = detectIn(scanDir, installDir);
      assert.ok(result.detected.some((d) => d.name === 'innocent-neighbour'),
        'only the install is excluded, not the directory it sits in');
    });

    it('defaults to this process own checkout when nothing is injected', () => {
      // The seam must not become the only thing that works: with no option the
      // guard still compares against the real install. Asserted without
      // scanning anything — the default is read from the module's behavior on
      // an empty directory, and the real install is simply not in it.
      const empty = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
      const config = store.config.load();
      const orig = config.projectsDir;
      config.projectsDir = empty;
      store.config.save(config);
      try {
        const result = projects.detectExistingProjects();
        assert.deepEqual(result.detected, [], 'no candidates, and no crash on the default path');
        assert.deepEqual(result.errors, []);
      } finally {
        const c = store.config.load();
        c.projectsDir = orig;
        store.config.save(c);
      }
    });
  });
});
