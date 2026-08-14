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
 * Mechanism under test, split the way the code splits it: the scanner CHILD
 * computes realpath identity under its kill budget and marks entries
 * `isOwnInstall` (a synchronous per-entry probe in the parent is the event-loop
 * shape that wedged this route on a TCC-protected directory, #859); the parent
 * route compares data only and drops marked entries. Identity, never name — a
 * clone of TangleClaw elsewhere stays attachable.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const store = require('../lib/store');
const dirScanner = require('../lib/dir-scanner');
const { HANDLERS } = require('../lib/dir-scanner-child');
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
   * Same seam as test/projects.test.js — the route's own contribution (the
   * data-only filter and nothing else) is what this isolates.
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

  it('passes the install identity to the child and drops what the child marked', async () => {
    let sentArgs = null;
    const result = await withScanner(
      async (_op, args) => {
        sentArgs = args;
        return {
          projects: [
            { name: 'their-app', path: '/tmp/their-app', detected: true, isOwnInstall: false },
            { name: 'TangleClaw', path: REPO_ROOT, detected: true, isOwnInstall: true }
          ]
        };
      },
      () => projects.scanDirectoryForProjects(os.tmpdir())
    );

    assert.equal(result.ok, true);
    assert.equal(fs.realpathSync(sentArgs.ownInstallRealPath), REPO_ROOT,
      'the route must tell the child which checkout is "us"');
    assert.deepEqual(result.projects.map((p) => p.name), ['their-app'],
      'a marked entry must not be offered; everything else stays');
  });

  it('child marks the running checkout by identity, even through a symlinked route', async () => {
    // The child probes realpath under its own budget. Reach the repo's parent
    // through a symlink so every entry path is spelled differently from its
    // resolved identity — the mark must land on resolution, not spelling.
    const link = path.join(tmpDir, 'route');
    fs.symlinkSync(path.dirname(REPO_ROOT), link);

    const { projects: entries } = await HANDLERS.scanEntries({
      dir: link, budgetMs: 30000, ownInstallRealPath: REPO_ROOT
    });

    const me = entries.find((e) => e.name === path.basename(REPO_ROOT));
    assert.ok(me, 'the checkout must appear in the raw child listing');
    assert.equal(me.isOwnInstall, true, 'the child must mark the running checkout');
    for (const other of entries.filter((e) => e !== me)) {
      assert.equal(other.isOwnInstall, false, `${other.name} must not be marked`);
    }
  });

  it('child marks nothing when no identity was provided', async () => {
    const { projects: entries } = await HANDLERS.scanEntries({
      dir: path.dirname(REPO_ROOT), budgetMs: 30000
    });
    for (const e of entries) {
      assert.equal(e.isOwnInstall, false,
        'an omitted ownInstallRealPath must mark nothing, not everything');
    }
  });

  it('keeps a REAL clone of TangleClaw living elsewhere (full chain)', async () => {
    // Attaching TangleClaw deliberately must stay possible: only the RUNNING
    // checkout is excluded, never a repository that happens to be TangleClaw.
    const cloneParent = path.join(tmpDir, 'projects');
    fs.mkdirSync(cloneParent, { recursive: true });
    execFileSync('git', ['clone', '--quiet', '--depth', '1',
      `file://${REPO_ROOT}`, path.join(cloneParent, 'TangleClaw')], { stdio: 'pipe' });

    const result = await projects.scanDirectoryForProjects(cloneParent);

    assert.equal(result.ok, true);
    assert.deepEqual(result.projects.map((p) => p.name), ['TangleClaw'],
      'a clone elsewhere is not the running install and must be offered');
  });

  it('never offers the running checkout when scanning its parent (full chain)', async () => {
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
