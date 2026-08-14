'use strict';

/*
 * #708 — the first-run scan must not offer the running TangleClaw checkout as
 * a candidate project.
 *
 * The README's install steps put the clone wherever the operator happens to
 * be, which is routinely the folder they then name as their projects
 * directory. The clone carries both detection markers (a git branch and
 * project files), the wizard pre-checks every detected entry, and setup ends
 * with the tool attached as the operator's first "project" — writing
 * per-project config into the clone, which then dirties it and can strand the
 * self-updater behind its own dirty-tree guard.
 *
 * The filter is server-side, by realpath identity against the checkout this
 * server runs from — never by name, so a clone of TangleClaw somewhere else
 * (developing TangleClaw with TangleClaw) remains attachable.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const store = require('../lib/store');
const dirScanner = require('../lib/dir-scanner');
const projects = require('../lib/projects');

// What lib/projects computes for itself: the checkout this process runs from.
const REPO_ROOT = fs.realpathSync(path.join(__dirname, '..'));

describe('setup scan excludes the running install (#708)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-own-install-'));
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run `fn` with `dirScanner.interactiveRequest` replaced, then restore it.
   * Same seam as test/projects.test.js — the real read happens in a child
   * process, so the filter under test lives in the parent, after this call.
   *
   * @param {Function} fakeRequest - Stand-in for interactiveRequest.
   * @param {Function} fn - Test body.
   * @returns {Promise<any>}
   */
  async function withScanner(fakeRequest, fn) {
    const real = dirScanner.interactiveRequest;
    dirScanner.interactiveRequest = fakeRequest;
    try {
      return await fn();
    } finally {
      dirScanner.interactiveRequest = real;
    }
  }

  it('drops the entry that resolves to this checkout, and only that one', async () => {
    // The shape `scanEntries` emits: entries named for their directory, path
    // joined under the scanned dir. One of them IS this checkout.
    const result = await withScanner(
      async () => ({
        projects: [
          { name: 'their-app', path: path.join(os.tmpdir(), 'their-app'),
            detected: true, git: { branch: 'main', dirty: false, incomplete: [] } },
          { name: path.basename(REPO_ROOT), path: REPO_ROOT,
            detected: true, git: { branch: 'main', dirty: false, incomplete: [] } }
        ]
      }),
      () => projects.scanDirectoryForProjects(os.tmpdir())
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.projects.map((p) => p.name), ['their-app'],
      'the running checkout must not offer itself; everything else stays');
  });

  it('reaches the checkout through a symlinked path too', async () => {
    // Identity, not spelling: a path that resolves to this checkout is still
    // this checkout. The scanner child hands the parent whatever the operator
    // typed led to.
    const link = path.join(tmpDir, 'tc-link');
    fs.symlinkSync(REPO_ROOT, link);
    const result = await withScanner(
      async () => ({ projects: [{ name: 'tc-link', path: link, detected: true, git: null }] }),
      () => projects.scanDirectoryForProjects(tmpDir)
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.projects, [], 'a symlinked route to the install is the install');
  });

  it('keeps a REAL clone of TangleClaw living elsewhere (real scanner child)', async () => {
    // Attaching TangleClaw deliberately must stay possible: only the RUNNING
    // checkout is excluded, never a repository that happens to be TangleClaw.
    // This one runs the genuine scanner child over a real directory.
    const cloneParent = path.join(tmpDir, 'projects');
    fs.mkdirSync(cloneParent, { recursive: true });
    execFileSync('git', ['clone', '--quiet', '--depth', '1',
      `file://${REPO_ROOT}`, path.join(cloneParent, 'TangleClaw')], { stdio: 'pipe' });

    const result = await projects.scanDirectoryForProjects(cloneParent);

    assert.equal(result.ok, true);
    assert.deepEqual(result.projects.map((p) => p.name), ['TangleClaw'],
      'a clone elsewhere is not the running install and must be offered');
  });

  it('never offers the running checkout when scanning its parent (real scanner child)', async () => {
    // The reported install shape verbatim: the operator names the directory
    // their clone sits in. Whatever else that directory holds, the running
    // checkout itself must be absent from the answer.
    const result = await projects.scanDirectoryForProjects(path.dirname(REPO_ROOT));

    if (!result.ok) {
      // A parent directory the scanner cannot finish (huge, slow disk) proves
      // nothing either way — but it must fail honestly, not offer the install.
      assert.equal(typeof result.error, 'string');
      return;
    }
    const resolved = result.projects.map((p) => {
      try { return fs.realpathSync(p.path); } catch { return p.path; }
    });
    assert.equal(resolved.includes(REPO_ROOT), false,
      'the running checkout offered itself from its own parent directory');
  });
});
