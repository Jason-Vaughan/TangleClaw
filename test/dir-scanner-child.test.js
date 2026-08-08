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
