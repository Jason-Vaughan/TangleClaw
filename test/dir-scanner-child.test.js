'use strict';

/**
 * The walks themselves — marker short-circuiting, deadline truncation, what
 * counts as a candidate directory.
 *
 * WHY THESE RUN IN-PROCESS AND NOT THROUGH THE SUPERVISOR. This behavior is only
 * observable by stubbing `fs`, and a stub cannot cross a process boundary: these
 * assertions used to live in `test/projects.test.js` against `fsp.readdir`, and
 * when the walk moved into the scanner child (#883) every one of those fixtures
 * stopped reaching its subject. Rather than weaken them into end-to-end tests
 * that can no longer see what they were pinning, they moved here, where the code
 * they describe now lives and where the stubs still work.
 *
 * `test/dir-scanner.test.js` covers the supervisor; `test/projects.test.js`
 * covers the delegation and the operator-facing wording.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs').promises;
const { execFileSync } = require('node:child_process');

const { HANDLERS, PROJECT_MARKERS } = require('../lib/dir-scanner-child');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scanner-child-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A fresh scratch directory, so no test can see another's entries.
 * @param {string} name - Distinguishing name.
 * @returns {string} Absolute path.
 */
function scratch(name) {
  const p = path.join(tmpRoot, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe('dir-scanner child — scanEntries (the wizard walk)', () => {
  test('classifies a marker-bearing directory as detected and a bare one as not', async () => {
    const root = scratch('classify');
    fs.mkdirSync(path.join(root, 'with-marker'));
    fs.writeFileSync(path.join(root, 'with-marker', 'go.mod'), 'module example.com/x\n');
    fs.mkdirSync(path.join(root, 'bare'));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, 'loose-file.txt'), 'x');

    const { projects } = await HANDLERS.scanEntries({ dir: root, budgetMs: 5000 });
    const names = projects.map(p => p.name).sort();

    assert.deepEqual(names, ['bare', 'with-marker'],
      'hidden directories and loose files are not candidate projects');
    assert.equal(projects.find(p => p.name === 'with-marker').detected, true);
    assert.equal(projects.find(p => p.name === 'bare').detected, false);
  });

  test('forwards `incomplete` alongside the git fields it qualifies', async () => {
    // This payload projects only `branch` and `dirty` out of the git object, so
    // it has to carry `incomplete` with them: a `dirty: null` the walk never got
    // to check is otherwise indistinguishable HERE from a repository that is
    // genuinely clean, which is the same false fact the projectFacts path
    // carries it to prevent. Without this the projection can be quietly dropped
    // again and nothing fails (#891).
    const root = scratch('incomplete-projection');
    const repo = path.join(root, 'a-repo');
    fs.mkdirSync(repo);
    // Empty --template: a bare `git init` inherits the live global template dir,
    // which TangleClaw rewrites, and that flakes (#831).
    execFileSync('git', ['init', '--template=', '-q'], { cwd: repo });

    const { projects } = await HANDLERS.scanEntries({ dir: root, budgetMs: 5000 });
    const found = projects.find(p => p.name === 'a-repo');

    assert.ok(found.git, 'a git directory reports a git object');
    assert.ok(Array.isArray(found.git.incomplete),
      'the projection must keep `incomplete`, or `dirty: null` reads as clean here');
    assert.deepEqual(found.git.incomplete, [],
      'a healthy repository establishes every field');
  });

  test('stops probing markers once one has answered', async () => {
    // Twelve concurrent probes to settle a question the first hit answers is
    // twelve threadpool slots against a filesystem that may not return any of
    // them. The short-circuit is the difference between costing one stuck slot
    // per directory and costing twelve.
    const root = scratch('short-circuit');
    fs.mkdirSync(path.join(root, 'js-project'));
    fs.writeFileSync(path.join(root, 'js-project', 'package.json'), '{}');

    const realAccess = fsp.access;
    const probed = [];
    fsp.access = (p, ...rest) => {
      if (String(p).startsWith(root)) probed.push(path.basename(String(p)));
      return realAccess(p, ...rest);
    };
    try {
      const { projects } = await HANDLERS.scanEntries({ dir: root, budgetMs: 5000 });
      assert.equal(projects[0].detected, true);
      // The TangleClaw config probe, then package.json — first in the marker
      // list, and the last thing that should have been looked at.
      assert.deepEqual(probed, ['project.json', 'package.json'],
        'must stop at the first marker that answers');
    } finally {
      fsp.access = realAccess;
    }
  });

  test('package.json is the first marker, so the common case short-circuits soonest', () => {
    // The assertion above encodes this ordering; without pinning it here, a
    // reorder would break that test for a reason its name does not suggest.
    assert.equal(PROJECT_MARKERS[0], 'package.json');
  });

  test('abandons the walk at the deadline instead of running it to the end', async () => {
    // A walk left running keeps issuing filesystem calls into a path already
    // known not to answer, long after nobody is waiting — and each holds a libuv
    // threadpool slot in THIS process until the kernel returns. That the process
    // is now disposable does not make the walk free: the supervisor kills the
    // child on ITS deadline, and a walk that stops itself first is what lets a
    // merely-slow directory report how far it got instead of being killed.
    // Mutation: delete the per-entry deadline check and the walk runs every entry.
    const realReaddir = fsp.readdir;
    const realAccess = fsp.access;
    const realStat = fsp.stat;
    let accessCalls = 0;
    let entriesWalked = 0;
    const fakeDir = '/tc-fake-scan-root';
    const ENTRY_COUNT = 200;
    const dirents = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      name: `proj-${i}`, isDirectory: () => true
    }));

    fsp.stat = (p, ...rest) => (p === fakeDir
      ? Promise.resolve({ isDirectory: () => true })
      : realStat(p, ...rest));
    fsp.readdir = (p, ...rest) => (p === fakeDir
      ? Promise.resolve(dirents)
      : realReaddir(p, ...rest));
    fsp.access = (p, ...rest) => {
      if (String(p).startsWith(fakeDir)) {
        accessCalls++;
        // One TangleClaw-config probe per entry, so this counts entries.
        if (path.basename(String(p)) === 'project.json') entriesWalked++;
        // Slow, but finite — the shape a deadline race alone cannot catch,
        // because every individual call does eventually return.
        return new Promise((resolve) => setTimeout(resolve, 20));
      }
      return realAccess(p, ...rest);
    };

    try {
      await assert.rejects(
        () => HANDLERS.scanEntries({ dir: fakeDir, budgetMs: 400 }),
        (err) => {
          // NOT tcTimedOut: this walk was being answered, just not fast enough.
          // Blaming Full Disk Access for a large directory on a slow disk sends
          // the operator to fix something that was never wrong.
          assert.equal(err.tcTruncated, true, 'a slow walk is truncated, not timed out');
          assert.ok(!err.tcTimedOut);
          assert.match(err.message, /checked \d+ of 200 subdirectories/,
            'must say how far it got, so the operator can tell slow from blocked');
          return true;
        }
      );

      // Without this the test passes vacuously: every other assertion here also
      // holds if the stubs were never reached and the path simply 404'd.
      assert.ok(entriesWalked > 0, 'the fixture must actually reach the walk');
      assert.ok(entriesWalked < ENTRY_COUNT,
        `must not have walked every entry (${entriesWalked} of ${ENTRY_COUNT})`);

      // Sample after a grace longer than one entry's worth of probes, so the
      // entry in flight at the deadline has finished and the next check fired.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const settled = accessCalls;
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(accessCalls, settled,
        `the walk must stop when the deadline passes (kept going: ${settled} → ${accessCalls})`);
    } finally {
      fsp.stat = realStat;
      fsp.readdir = realReaddir;
      fsp.access = realAccess;
    }
  });

  test('reports a missing directory as ENOENT and a file as ENOTDIR', async () => {
    // Both travel as codes rather than prose: the browser offers to CREATE on
    // the first, and it used to decide which failure it was by regex-matching
    // the message, so rewording a sentence silently removed the button.
    await assert.rejects(
      () => HANDLERS.scanEntries({ dir: path.join(tmpRoot, 'nope'), budgetMs: 5000 }),
      (err) => { assert.equal(err.code, 'ENOENT'); return true; }
    );

    const filePath = path.join(scratch('notdir'), 'a-file.txt');
    fs.writeFileSync(filePath, 'x');
    await assert.rejects(
      () => HANDLERS.scanEntries({ dir: filePath, budgetMs: 5000 }),
      (err) => { assert.equal(err.code, 'ENOTDIR'); return true; }
    );
  });
});

describe('dir-scanner child — listUnregistered (the dashboard walk)', () => {
  test('skips registered names, hidden directories and loose files', async () => {
    const root = scratch('unregistered');
    fs.mkdirSync(path.join(root, 'known'));
    fs.mkdirSync(path.join(root, 'unknown'));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, 'loose.txt'), 'x');

    const { unregistered, truncated } = await HANDLERS.listUnregistered({
      dir: root, skipNames: ['known'], budgetMs: 5000
    });

    assert.deepEqual(unregistered.map(u => u.name), ['unknown']);
    assert.equal(truncated, false);
    assert.equal(unregistered[0].registered, false,
      'the dashboard renders these alongside registered projects and must tell them apart');
  });

  test('TRUNCATES rather than throwing when the budget runs out', async () => {
    // This walk backs the dashboard's project list, and the caller degrades a
    // failure to the registered projects alone. Throwing would turn "the list
    // took a while" into "the list is empty", silently, for a slow disk.
    const realAccess = fsp.access;
    const realReaddir = fsp.readdir;
    const fakeDir = '/tc-fake-unregistered-root';
    const dirents = Array.from({ length: 200 }, (_, i) => ({
      name: `proj-${i}`, isDirectory: () => true
    }));
    let probed = 0;

    fsp.readdir = (p, ...rest) => (p === fakeDir
      ? Promise.resolve(dirents)
      : realReaddir(p, ...rest));
    fsp.access = (p, ...rest) => {
      if (String(p).startsWith(fakeDir)) {
        probed++;
        return new Promise((resolve) => setTimeout(resolve, 20));
      }
      return realAccess(p, ...rest);
    };

    try {
      const { unregistered, truncated } = await HANDLERS.listUnregistered({
        dir: fakeDir, skipNames: [], budgetMs: 300
      });
      assert.ok(probed > 0, 'the fixture must actually reach the walk');
      assert.equal(truncated, true, 'a walk that ran out of budget must say so');
      assert.ok(unregistered.length > 0,
        'what it DID find must still come back — a short list, not an empty one');
      assert.ok(unregistered.length < 200, 'it cannot have walked every entry');
    } finally {
      fsp.access = realAccess;
      fsp.readdir = realReaddir;
    }
  });
});

describe('dir-scanner child — createDir', () => {
  test('creates one level and reports which of the three things happened', async () => {
    const root = scratch('createdir');
    const target = path.join(root, 'Projects');

    const first = await HANDLERS.createDir({ dir: target });
    assert.equal(first.status, 'created');
    assert.ok(fs.existsSync(target));

    // Two clicks on the same button, or a folder made in Finder while the screen
    // was open, must both end well rather than reporting an error.
    const second = await HANDLERS.createDir({ dir: target });
    assert.equal(second.status, 'exists');

    // Creating ONE level is "it wasn't there yet"; creating five is building a
    // tree nobody asked for at a path nobody checked.
    const deep = await HANDLERS.createDir({ dir: path.join(root, 'a', 'b') });
    assert.equal(deep.status, 'parent-missing');
    assert.equal(deep.parent, path.join(root, 'a'));
    assert.ok(!fs.existsSync(path.join(root, 'a')));
  });
});

describe('dir-scanner child — projectFacts (#884)', () => {
  test('reports a real Claude project directory and what governs it', async () => {
    const root = scratch('facts-governed');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'prawduct@tangleclaw': true } })
    );

    const facts = await HANDLERS.projectFacts({ dir: root, engineId: 'claude' });
    assert.equal(facts.exists, true);
    assert.equal(facts.governanceState, 'governed-plugin');
  });

  test('a vendored governance hook reads as governed-vendored, and neither as ungoverned', async () => {
    const vendored = scratch('facts-vendored');
    fs.mkdirSync(path.join(vendored, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(vendored, 'tools', 'product-hook'), '#!/bin/sh\n');
    assert.equal(
      (await HANDLERS.projectFacts({ dir: vendored, engineId: 'claude' })).governanceState,
      'governed-vendored'
    );

    const bare = scratch('facts-bare');
    assert.equal(
      (await HANDLERS.projectFacts({ dir: bare, engineId: 'claude' })).governanceState,
      'ungoverned'
    );
  });

  test('governance is not-applicable on a non-Claude engine, even though the directory is there', async () => {
    // The distinction the `exists` field carries: a directory that IS present
    // can still have no governance question to answer. Collapsing the two would
    // make a codex project indistinguishable from a missing folder.
    const root = scratch('facts-codex');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'prawduct@tangleclaw': true } })
    );

    const facts = await HANDLERS.projectFacts({ dir: root, engineId: 'codex' });
    assert.equal(facts.exists, true);
    assert.equal(facts.governanceState, 'not-applicable');
  });

  test('a directory that is not there answers, rather than throwing', async () => {
    const gone = path.join(tmpRoot, 'facts-never-created');
    assert.deepEqual(
      await HANDLERS.projectFacts({ dir: gone, engineId: 'claude' }),
      { exists: false, governanceState: 'not-applicable', git: null, config: null, version: null }
    );
  });

  test('malformed settings fail closed to ungoverned rather than throwing', async () => {
    // The whole point of the fail-closed catch: a parse error must not read as
    // "governed", which would make TangleClaw skip config generation for a
    // project that has no plugin at all.
    const root = scratch('facts-malformed');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ not json');

    assert.equal(
      (await HANDLERS.projectFacts({ dir: root, engineId: 'claude' })).governanceState,
      'ungoverned'
    );
  });

  test('the handler never imports the server database — it exists to be SIGKILLed', () => {
    // THE MUTATION THIS CATCHES: importing `./engines` here instead of
    // `./governance-state` to reach `governanceState`. That is the obvious edit,
    // it passes every other test in this file, and it gives a process the
    // supervisor kills mid-syscall an open handle on the SQLite database the
    // server depends on. Asserted on a FRESH child process because this suite's
    // own requires have long since loaded `store` into this one.
    const probe = 'require("./lib/dir-scanner-child.js");'
      + 'process.stdout.write(String(Object.keys(require.cache).some(k => k.endsWith("/lib/store.js"))))';
    const loaded = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8'
    });
    assert.equal(loaded, 'false',
      'the scanner child must not load lib/store.js — see lib/governance-state.js');
  });
});

describe('dir-scanner child — projectFacts carries git and config (#884, chunk 02a)', () => {
  const { execFileSync } = require('node:child_process');

  test('reports the branch of a real repository', () => {
    // A real repo, not a stub: `git.getInfo` shells out, and the entire reason
    // this read moved here is that shelling out blocks the caller's event loop.
    // A stub would test the plumbing and not the thing that made it necessary.
    const root = scratch('facts-git');
    try {
      // `-c init.templateDir=` isolates this from the host's global git template,
      // which #831 records as a source of flakes when TangleClaw rewrites it. And
      // a commit is required, not decoration: a repo with no commits has no
      // resolvable HEAD, so `getInfo` reports branch `unknown` and the assertion
      // below would pass against a repo that proves nothing about branch reading.
      execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', '-b', 'trunk', root],
        { stdio: 'ignore' });
      for (const args of [
        ['config', 'user.email', 'test@example.com'],
        ['config', 'user.name', 'Test'],
        ['commit', '--allow-empty', '-q', '-m', 'init']
      ]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    } catch {
      return; // no git on this host — the assertion below would say nothing
    }
    return HANDLERS.projectFacts({ dir: root, engineId: 'claude' }).then((facts) => {
      assert.ok(facts.git, 'a git repository must report git info');
      assert.equal(facts.git.branch, 'trunk');
    });
  });

  test('a directory that is not a repository reports null git rather than failing', async () => {
    const facts = await HANDLERS.projectFacts({ dir: scratch('facts-nogit'), engineId: 'claude' });
    assert.equal(facts.git, null);
    assert.ok(facts.config, 'and still answers for everything else');
  });

  test('reads the project config, and returns defaults when there is none', async () => {
    const configured = scratch('facts-cfg');
    fs.mkdirSync(path.join(configured, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(configured, '.tangleclaw', 'project.json'),
      JSON.stringify({ versionBumpEnabled: false, versionFilePath: 'VERSION.json' })
    );

    const facts = await HANDLERS.projectFacts({ dir: configured, engineId: 'claude' });
    assert.equal(facts.config.versionBumpEnabled, false, 'an explicit false must survive the round trip');
    assert.equal(facts.config.versionFilePath, 'VERSION.json');
    assert.equal(facts.config.silentPrime, true, 'and unset keys still come from the defaults');

    const bare = await HANDLERS.projectFacts({ dir: scratch('facts-nocfg'), engineId: 'claude' });
    assert.equal(bare.config.versionBumpEnabled, true, 'no config file reads as the documented default');
  });

  test('a malformed config reads as defaults without throwing, and without a logger', async () => {
    // The reader has no logger of its own by design — acquiring one would give
    // this process a dependency it exists to avoid. The condition is carried by
    // the return value instead, which is what this pins.
    const root = scratch('facts-badcfg');
    fs.mkdirSync(path.join(root, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tangleclaw', 'project.json'), '{ not json');

    const facts = await HANDLERS.projectFacts({ dir: root, engineId: 'claude' });
    assert.equal(facts.config.versionBumpEnabled, true);
  });

  test('reports the project version, and null when nothing on disk names one', async () => {
    const versioned = scratch('facts-version');
    fs.writeFileSync(path.join(versioned, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [4.2.0] - 2026-05-01\n');
    const facts = await HANDLERS.projectFacts({ dir: versioned, engineId: 'claude' });
    assert.equal(facts.version, '4.2.0');

    const bare = await HANDLERS.projectFacts({ dir: scratch('facts-noversion'), engineId: 'claude' });
    assert.equal(bare.version, null,
      'a project with no version source reports null rather than a fabricated fallback');
  });

  test('the self-heal write happens HERE, in the process that can be killed', async () => {
    // The reason this op is the only handler in the file that writes. Version
    // detection rewrites a cache its live sources have moved past (#165), and
    // that write is the whole reason the chunk that moved this had to make the
    // writer atomic first — the supervisor SIGKILLs this process mid-syscall.
    const root = scratch('facts-selfheal');
    fs.mkdirSync(path.join(root, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tangleclaw', 'project-version.txt'),
      'version: 1.0.0\nrecorded_at: 2026-01-01T00:00:00Z\nsource: version.json\n');
    fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version: '2.0.0' }));

    const facts = await HANDLERS.projectFacts({ dir: root, engineId: 'claude' });
    assert.equal(facts.version, '2.0.0', 'the live value wins over a stale cache');
    assert.match(
      fs.readFileSync(path.join(root, '.tangleclaw', 'project-version.txt'), 'utf8'),
      /^version: 2\.0\.0$/m,
      'and the cache is healed in place, by this process'
    );
  });

  test('a warning from inside the child reaches stderr instead of a discarded stdout', async () => {
    // THE MUTATION THIS CATCHES: dropping `setConsoleStream(process.stderr)` from
    // the child's entry block. The logger sends warn to `process.stdout`, and the
    // supervisor forks this child with stdout `'ignore'` — so without the pin,
    // every warning this process emits goes to /dev/null and the code still
    // "works". That is invisible from in-process tests, which own a real stdout.
    //
    // Forked for real rather than required, because `require.main === module` is
    // exactly the condition under test.
    const { fork } = require('node:child_process');
    const root = scratch('facts-childwarn');
    fs.mkdirSync(path.join(root, '.tangleclaw'), { recursive: true });
    // A configured version file that is not there — one of the diagnostics this
    // process now owns, and one an operator has to be able to see.
    fs.writeFileSync(path.join(root, '.tangleclaw', 'project.json'),
      JSON.stringify({ versionFilePath: 'ABSENT.json' }));

    const child = fork(path.join(__dirname, '..', 'lib', 'dir-scanner-child.js'), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], // the supervisor's exact stdio
      serialization: 'json'
    });
    try {
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => { stderr += c; });

      await new Promise((resolve) => {
        child.on('message', resolve);
        child.send({ id: 1, op: 'projectFacts', payload: { dir: root, engineId: 'claude' } });
      });
      // The reply races the stderr flush; they are different channels.
      await new Promise((r) => setTimeout(r, 250));

      assert.match(stderr, /configured version file unreadable/,
        'the child\'s warning must leave the process, or nothing an operator reads will ever carry it');
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('the child still never imports the server database, now that it detects versions too', () => {
    // THE MUTATION THIS CATCHES: reaching version detection through
    // `require('./projects')`, which owns the public names for these readers and
    // pulls the database in with them.
    //
    // Pointed at an EMPTY directory, not at the repo root. Against the repo the
    // first rung reads TangleClaw's own CHANGELOG.md and returns, so the ladder
    // never reaches the rung that reads project config — the probe passes while
    // the defect sits one rung below it. That was measured, not assumed: the
    // mutation was run against a cwd-based probe and it passed.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-child-vprobe-'));
    try {
      const probe = 'const c = require("./lib/dir-scanner-child.js");'
        + `c.HANDLERS.projectFacts({ dir: ${JSON.stringify(empty)}, engineId: "claude" }).then(() => `
        + 'process.stdout.write(String(Object.keys(require.cache).some(k => k.endsWith("/lib/store.js")))))';
      const loaded = execFileSync(process.execPath, ['-e', probe], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8'
      });
      assert.equal(loaded, 'false',
        'the scanner child must not load lib/store.js, even walking the whole version ladder');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('the child still never imports the server database, now that it reads config too', () => {
    // THE MUTATION THIS CATCHES, and the reason it is re-asserted rather than
    // left to the chunk-01 copy: the obvious way to read project config is
    // `require('./store').projectConfig.load`, and `lib/project-version.js`
    // reached for exactly that, lazily, so the import appeared only on first
    // CALL. A fresh process is the only place this is observable.
    const probe = 'const c = require("./lib/dir-scanner-child.js");'
      + 'c.HANDLERS.projectFacts({ dir: process.cwd(), engineId: "claude" }).then(() => '
      + 'process.stdout.write(String(Object.keys(require.cache).some(k => k.endsWith("/lib/store.js")))))';
    const loaded = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8'
    });
    assert.equal(loaded, 'false',
      'the scanner child must not load lib/store.js, even after answering a real request');
  });

  test('a directory that is there but unreadable is not reported as deleted', async () => {
    // THE MUTATION THIS CATCHES: routing this through `_exists`, which collapses
    // EACCES into `false`. That renders a directory the server may not traverse
    // as one the operator deleted — confidently wrong rather than merely absent,
    // and indistinguishable in the UI from a project they removed on purpose.
    if (process.getuid && process.getuid() === 0) return; // root bypasses the check
    const locked = scratch('facts-locked');
    const inner = path.join(locked, 'project');
    fs.mkdirSync(inner, { recursive: true });
    fs.chmodSync(locked, 0o000);
    try {
      const facts = await HANDLERS.projectFacts({ dir: inner, engineId: 'claude' });
      assert.equal(facts.exists, true, 'the directory is there, and saying otherwise is a lie');
      assert.equal(facts.code, 'EACCES');
      assert.match(facts.unreadable, /permission denied/);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});
