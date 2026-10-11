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
 *
 * Every directory scanned here is one this file creates. The walk costs a git
 * probe per subdirectory against one wall-clock budget, so scanning the folder
 * the checkout happens to sit in made the result a function of how many
 * neighbours the host holds and how loaded it is (#1999).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { cloneRepo } = require('./_temp-repo');
const store = require('../lib/store');
const dirScanner = require('../lib/dir-scanner');
const { HANDLERS } = require('../lib/dir-scanner-child');
const projects = require('../lib/projects');

// What lib/projects computes for itself: the checkout this process runs from.
const REPO_ROOT = fs.realpathSync(path.join(__dirname, '..'));

// What a walk of the fixture parent must list: its real, non-hidden
// subdirectories and nothing else.
const FIXTURE_LISTING = ['TangleClaw', 'notes', 'their-app'];

describe('setup scan excludes the running install (#708)', () => {
  let tmpDir;
  let fixtureParent;
  let standInRealPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-own-install-'));
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    ({ fixtureParent, standInRealPath } = makeFixtureParent(tmpDir));
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

  /**
   * Build the parent directory the child-level cases walk: a stand-in for the
   * running checkout, a neighbouring project, a plain directory, and two
   * entries the walk must skip (a hidden directory and a file).
   *
   * The child is told which realpath is "us" by argument and compares nothing
   * else, so a directory made here can stand for the checkout. Its realpath is
   * returned resolved because the temporary directory is itself reached
   * through a symlink on macOS: the unresolved spelling would match nothing.
   *
   * @param {string} root - Existing directory to build under.
   * @returns {{fixtureParent: string, standInRealPath: string}}
   */
  function makeFixtureParent(root) {
    const parent = path.join(root, 'fixture-parent');
    for (const name of ['TangleClaw', 'their-app']) {
      fs.mkdirSync(path.join(parent, name), { recursive: true });
      fs.writeFileSync(path.join(parent, name, 'package.json'), '{}\n');
    }
    fs.mkdirSync(path.join(parent, 'notes'));
    fs.mkdirSync(path.join(parent, '.cache'));
    fs.writeFileSync(path.join(parent, 'README.txt'), 'not a directory\n');
    return {
      fixtureParent: parent,
      standInRealPath: fs.realpathSync(path.join(parent, 'TangleClaw'))
    };
  }

  /**
   * Run the real scan route in a separate node process whose own checkout is
   * `checkout`, and return its answer.
   *
   * The route fixes "the checkout this server runs from" when its module
   * loads, so the only way to scan the running checkout's parent without
   * scanning THIS checkout's parent is to be a process that runs from
   * somewhere else. The child gets its own data directory and none of this
   * session's launch identity or tmux, so it reads and writes nothing of the
   * host's.
   *
   * @param {string} checkout - A TangleClaw checkout to run the route from.
   * @param {string} directory - The directory that process is asked to scan.
   * @returns {{ok: boolean, projects?: object[], error?: string}}
   */
  function scanFromCheckout(checkout, directory) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('TANGLECLAW_')) continue;
      env[key] = value;
    }
    env.TANGLECLAW_HOME = path.join(tmpDir, 'chain-home');
    const script = [
      "const projects = require(process.argv[1]);",
      "projects.scanDirectoryForProjects(process.argv[2]).then((result) => {",
      "  require('node:fs').writeSync(1, JSON.stringify(result));",
      "  process.exit(0);",
      "}, (err) => { console.error(err); process.exit(1); });"
    ].join('\n');
    const out = execFileSync(
      process.execPath,
      ['-e', script, path.join(checkout, 'lib', 'projects.js'), directory],
      { env, cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }
    );
    return JSON.parse(out);
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
    // The child probes realpath under its own budget. Reach the parent through
    // a symlink so every entry path is spelled differently from its resolved
    // identity — the mark must land on resolution, not spelling.
    const link = path.join(tmpDir, 'route');
    fs.symlinkSync(fixtureParent, link);

    const { projects: entries } = await HANDLERS.scanEntries({
      dir: link, budgetMs: 30000, ownInstallRealPath: standInRealPath
    });

    assert.deepEqual(entries.map((e) => e.name).sort(), FIXTURE_LISTING,
      'the walk must list every real subdirectory, and only those');
    const me = entries.find((e) => e.name === 'TangleClaw');
    assert.equal(me.isOwnInstall, true, 'the child must mark the running checkout');
    for (const other of entries.filter((e) => e !== me)) {
      assert.equal(other.isOwnInstall, false, `${other.name} must not be marked`);
    }
  });

  it('child marks nothing when no identity was provided', async () => {
    const { projects: entries } = await HANDLERS.scanEntries({
      dir: fixtureParent, budgetMs: 30000
    });

    assert.deepEqual(entries.map((e) => e.name).sort(), FIXTURE_LISTING,
      'the walk must list every real subdirectory, and only those');
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
    cloneRepo(`file://${REPO_ROOT}`, path.join(cloneParent, 'TangleClaw'), ['--depth', '1']);

    const result = await projects.scanDirectoryForProjects(cloneParent);

    assert.equal(result.ok, true);
    assert.deepEqual(result.projects.map((p) => p.name), ['TangleClaw'],
      'a clone elsewhere is not the running install and must be offered');
  });

  it('never offers the running checkout when scanning its parent (full chain)', () => {
    // The reported install shape verbatim: the operator names the directory
    // their clone sits in. Here the running checkout is a clone made beside a
    // neighbouring project, and the scan runs in a process started from that
    // clone, so its parent is a directory of known contents.
    const parent = path.join(tmpDir, 'chain-parent');
    const checkout = path.join(parent, 'TangleClaw');
    fs.mkdirSync(path.join(parent, 'their-app'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'their-app', 'package.json'), '{}\n');
    cloneRepo(`file://${REPO_ROOT}`, checkout, ['--depth', '1']);
    // A clone holds the last commit. Lay the working tree's lib/ over it so
    // the code that answers is the code under test.
    fs.cpSync(path.join(REPO_ROOT, 'lib'), path.join(checkout, 'lib'), { recursive: true });

    const result = scanFromCheckout(checkout, parent);

    assert.equal(result.ok, true, `the scan of a two-entry parent must finish: ${result.error}`);
    assert.deepEqual(result.projects.map((p) => p.name), ['their-app'],
      'the neighbour is offered; the running checkout is not');
  });
});
