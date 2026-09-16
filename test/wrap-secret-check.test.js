'use strict';

/*
 * The wrap's content-based secret check (#1513).
 *
 * Driven against real repositories through the two steps that carry it
 * (`session-files` and `commit`), because what matters is what git ends up
 * committing, and whether the matched text escapes into any output.
 */

const { describe, it, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const secretScan = require('../lib/secret-scan');
const secretCheck = require('../lib/wrap-steps/_secret-check');
const sessionFiles = require('../lib/wrap-steps/session-files');
const commitStep = require('../lib/wrap-steps/commit');
const launchBaseline = require('../lib/launch-baseline');
const wrapScope = require('../lib/wrap-scope');
const { execFileArgs } = require('../lib/wrap-steps/_exec-shell');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * A real-format GitHub token, assembled at runtime so this source file does not
 * itself hold one for a scanner to find.
 * @type {string}
 */
const TOKEN = ['gh', 'p_'].join('') + 'Ab12Cd34Ef'.repeat(3) + 'Gh56Ij';

/**
 * A classification whose only stageable files are `names`.
 * @param {string[]} names - Repo-relative paths owned by the session.
 * @returns {object} The shape `ownership.classify` returns.
 */
function classificationFor(names) {
  return {
    owned: [...names], foreign: [], included: [], left: [], undecided: [],
    tangleclawMaintenance: [], tangleclawState: [], stageable: [...names]
  };
}

/** Activity rows the check recorded during the current test. */
let activity = [];
const realLogActivity = secretCheck._internal.logActivity;
beforeEach(() => {
  activity = [];
  secretCheck._internal.logActivity = (event) => { activity.push(event); };
});
afterEach(() => { secretCheck._internal.logActivity = realLogActivity; });

/**
 * Run git with a fixed identity.
 * @param {string} cwd - Repo directory.
 * @param {...string} args - Argv after `git`.
 * @returns {string} Trimmed stdout.
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
}

/**
 * A repo on a feature branch with one commit and a local identity.
 * @returns {string} Repo path, symlinks resolved.
 */
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secret-')));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  fs.writeFileSync(path.join(dir, 'shared.js'), 'v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/session');
  return dir;
}

/** The argv runner the scope takes in production. */
const asyncExec = (file, args, opts) => execFileArgs(file, args, { cwd: opts.cwd, timeoutMs: 10000, maxBufferBytes: 1024 * 1024 });

/**
 * Resolve the real scope for a session launched at `baseline`.
 * @param {string} repo - Registered checkout.
 * @param {object|null} baseline - Launch baseline.
 * @returns {Promise<object>}
 */
function scopeFor(repo, baseline) {
  return wrapScope.resolve({ name: 'sec', path: repo }, { id: 1, tmuxSession: 'sec', startedAt: '2000-01-01 00:00:00' }, {
    exec: asyncExec,
    paneCurrentPath: () => repo,
    getLaunchBaseline: () => baseline
  });
}

/**
 * Run a step against the scoped project, as the pipeline would.
 * @param {object} step - Step module.
 * @param {string} repo - Registered checkout.
 * @param {object} scope - Scope.
 * @param {object} [options] - Run options.
 * @returns {Promise<object>}
 */
function runStep(step, repo, scope, options = {}) {
  return step.run({
    project: wrapScope.stepProject({ id: 7, name: 'sec', path: repo }, scope),
    session: { id: 42 },
    step: { id: step === commitStep ? 'commit' : 'session-files' },
    previousResults: [],
    staged: {},
    options,
    scope
  });
}

/**
 * Files the last commit touched.
 * @param {string} repo - Repo directory.
 * @returns {string[]} Sorted paths.
 */
function committedFiles(repo) {
  return git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
}

/**
 * A session that writes one ordinary file and one holding a token.
 * @returns {Promise<{repo:string, scope:object}>}
 */
async function sessionWithSecret() {
  const repo = makeRepo();
  const baseline = launchBaseline.capture(repo);
  fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
  fs.writeFileSync(path.join(repo, 'config.js'), `module.exports = { gh: '${TOKEN}' };\n`);
  return { repo, scope: await scopeFor(repo, baseline) };
}

/**
 * Assert that the token appears nowhere in a value, however deeply nested.
 * @param {*} value - Step result, activity row, etc.
 * @param {string} where - Label for the failure message.
 */
function assertNoToken(value, where) {
  assert.ok(!JSON.stringify(value).includes(TOKEN), `the matched text leaked into ${where}`);
  assert.ok(!JSON.stringify(value).includes(TOKEN.slice(4, 20)), `part of the matched text leaked into ${where}`);
}

describe('a file holding a real-format token is flagged and not committed', () => {
  it('session-files blocks on the file, names the rule, and never the value', async () => {
    const { repo, scope } = await sessionWithSecret();
    const r = await runStep(sessionFiles, repo, scope);
    assert.equal(r.status, 'blocked');
    assert.deepEqual(r.output.foreignPaths.map((f) => f.path), ['config.js']);
    assert.match(r.output.foreignPaths[0].why, /github-token/);
    assert.match(r.output.remediation, /config\.js \(github-token\)/);
    assert.match(r.blockers.join('\n'), /1 file the wrap would commit matches a secret pattern/);
    assertNoToken(r, 'the session-files result');
    assert.equal(activity.length, 1);
    assert.equal(activity[0].eventType, 'wrap.secret_scan');
    assert.equal(activity[0].projectId, 7);
    assert.equal(activity[0].sessionId, 42);
    assert.deepEqual(activity[0].detail.flagged, [{ path: 'config.js', rules: ['github-token'], decision: 'undecided' }]);
    assert.equal(activity[0].detail.blocked, true);
    assertNoToken(activity, 'the activity row');
  });

  it('the commit refuses it without a decision, even if session-files never ran', async () => {
    const { repo, scope } = await sessionWithSecret();
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'blocked');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.deepEqual(r.output.foreignPaths.map((f) => f.path), ['config.js']);
    assertNoToken(r, 'the commit result');
    assert.equal(activity.at(-1).detail.step, 'commit');
    assertNoToken(activity, 'the activity row');
  });

  it('Leave: the session\'s other work is committed, the flagged file stays on disk uncommitted', async () => {
    const { repo, scope } = await sessionWithSecret();
    const options = { pathDecisions: { 'config.js': 'leave' } };
    const first = await runStep(sessionFiles, repo, scope, options);
    assert.equal(first.status, 'done');
    assert.match(first.output.detail, /1 secret match left uncommitted/);
    const r = await runStep(commitStep, repo, scope, options);
    assert.equal(r.status, 'done');
    assert.deepEqual(committedFiles(repo), ['mine.js']);
    assert.ok(fs.readFileSync(path.join(repo, 'config.js'), 'utf8').includes(TOKEN), 'the file is untouched');
    assert.match(git(repo, 'status', '--porcelain', '--', 'config.js'), /^\?\? config\.js$/);
    assert.deepEqual(r.output.secretScan.flagged, [{ path: 'config.js', rules: ['github-token'], decision: 'leave' }]);
    assertNoToken(r, 'the commit result');
    assert.equal(activity.at(-1).detail.blocked, false);
    assert.equal(activity.at(-1).detail.flagged[0].decision, 'leave');
  });

  it('Leave on the only file the session changed is a skip that says it was left, not TangleClaw state', async () => {
    const repo = makeRepo();
    const baseline = launchBaseline.capture(repo);
    fs.writeFileSync(path.join(repo, 'config.js'), `token = "${TOKEN}"\n`);
    const scope = await scopeFor(repo, baseline);
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'config.js': 'leave' } });
    assert.equal(r.status, 'skipped');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.doesNotMatch(r.output.reason, /TangleClaw state/);
  });

  it('Include: the operator\'s decision commits the flagged file as it is', async () => {
    const { repo, scope } = await sessionWithSecret();
    const r = await runStep(commitStep, repo, scope, { pathDecisions: { 'config.js': 'include' } });
    assert.equal(r.status, 'done');
    assert.deepEqual(committedFiles(repo), ['config.js', 'mine.js']);
    assert.equal(r.output.secretScan.flagged[0].decision, 'include');
    assertNoToken(r, 'the commit result');
  });

  it('removing the credential clears the block with no decision needed', async () => {
    const { repo, scope } = await sessionWithSecret();
    assert.equal((await runStep(sessionFiles, repo, scope)).status, 'blocked');
    fs.writeFileSync(path.join(repo, 'config.js'), 'module.exports = { gh: process.env.GH_TOKEN };\n');
    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'done');
    assert.deepEqual(committedFiles(repo), ['config.js', 'mine.js']);
  });

  it('a secret written after session-files passed is still caught at the commit', async () => {
    const repo = makeRepo();
    const baseline = launchBaseline.capture(repo);
    fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    const scope = await scopeFor(repo, baseline);
    assert.equal((await runStep(sessionFiles, repo, scope)).status, 'done');
    fs.writeFileSync(path.join(repo, 'notes.md'), `aws ${'AKIA'}${'ABCDEFGHIJKLMNOP'}\n`);
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'blocked');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(r.output.foreignPaths.map((f) => [f.path, f.secretRules]), [['notes.md', ['aws-access-key']]]);
  });
});

describe('the "not this session\'s" list is scanned too', () => {
  it('a file already uncommitted at launch names both reasons in one entry', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'shared.js'), `const password = "${TOKEN}";\n`);
    const baseline = launchBaseline.capture(repo);
    fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    const scope = await scopeFor(repo, baseline);
    const r = await runStep(sessionFiles, repo, scope);
    assert.equal(r.status, 'blocked');
    assert.equal(r.output.foreignPaths.length, 1, 'asked about once, not twice');
    const [entry] = r.output.foreignPaths;
    assert.equal(entry.path, 'shared.js');
    assert.match(entry.why, /already uncommitted when this session launched; it also matches the secret rules generic-secret, github-token/);
    assert.equal(r.blockers.length, 2, 'both blocker lines are true of this file');
    assertNoToken(r, 'the session-files result');

    const left = await runStep(commitStep, repo, scope, { pathDecisions: { 'shared.js': 'leave' } });
    assert.equal(left.status, 'done');
    assert.deepEqual(committedFiles(repo), ['mine.js']);
  });
});

describe('files that are not scanned say why', () => {
  it('a binary file and an oversized file are skipped with a stated reason and do not block', async () => {
    const repo = makeRepo();
    const baseline = launchBaseline.capture(repo);
    fs.writeFileSync(path.join(repo, 'image.bin'), Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x00]), Buffer.from(TOKEN)]));
    fs.writeFileSync(path.join(repo, 'huge.txt'), `${'x'.repeat(secretCheck.SCAN_SIZE_CAP)}\n${TOKEN}\n`);
    fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    const scope = await scopeFor(repo, baseline);

    const first = await runStep(sessionFiles, repo, scope);
    assert.equal(first.status, 'done');
    assert.match(first.output.detail, /2 files not scanned for secrets/);

    const r = await runStep(commitStep, repo, scope);
    assert.equal(r.status, 'done');
    const reasons = Object.fromEntries(r.output.secretScan.skipped.map((s) => [s.path, s.reason]));
    assert.match(reasons['image.bin'], /looks binary, so it was not scanned/);
    assert.match(reasons['huge.txt'], /larger than 1 MB \(\d+ bytes\), so it was not scanned/);
    assert.deepEqual(r.output.secretScan.flagged, []);
    const row = activity.find((a) => a.detail.step === 'commit');
    assert.ok(row, 'the commit records the skips');
    assert.equal(row.detail.skippedCount, 2);
    // session-files records a skip-only scan too, or a wrap that could not read
    // a file looks in the log exactly like one that scanned everything clean.
    const sfRow = activity.find((a) => a.detail.step === 'session-files');
    assert.ok(sfRow, 'session-files records a scan that only skipped');
    assert.equal(sfRow.detail.skippedCount, 2);
    assert.deepEqual(sfRow.detail.flagged, []);
    assertNoToken(activity, 'the activity row');
    assertNoToken(r, 'the commit result');
  });

  it('a binary file is sniffed, not read whole — the stall the budget exists to prevent', () => {
    const repo = makeRepo();
    // 4 MB is over SCAN_SIZE_CAP, so use one just under it: the size check
    // must not be what saves us here, the prefix sniff must.
    const size = secretCheck.SCAN_SIZE_CAP - 1;
    const buf = Buffer.alloc(size, 0x41);
    buf[3] = 0x00; // NUL inside the sniff window → binary
    fs.writeFileSync(path.join(repo, 'image.bin'), buf);
    const reads = [];
    const realReadFile = secretCheck._internal.readFile;
    secretCheck._internal.readFile = (abs) => { reads.push(abs); return realReadFile(abs); };
    try {
      const r = secretCheck.scanFile(repo, 'image.bin');
      assert.equal(r.state, 'skipped');
      assert.match(r.reason, /looks binary/);
      assert.deepEqual(reads, [], 'the whole file was never read');
      assert.ok(r.bytes > 0 && r.bytes <= 8192, `only the sniff window was read, got ${r.bytes}`);
    } finally {
      secretCheck._internal.readFile = realReadFile;
    }
  });

  it('bytes read for a file that ends in a skip still count against the budget', () => {
    const repo = makeRepo();
    // Two binaries, each costing a sniff. A budget below their combined sniff
    // cost must stop the loop — under the old code neither counted at all.
    for (const n of ['a.bin', 'b.bin', 'c.bin']) {
      const buf = Buffer.alloc(9000, 0x41);
      buf[3] = 0x00;
      fs.writeFileSync(path.join(repo, n), buf);
    }
    const names = ['a.bin', 'b.bin', 'c.bin'];
    const res = secretCheck.check(repo, classificationFor(names), {}, { maxBytes: 9000 });
    const stopped = res.report.skipped.filter((s) => /stopped scanning after/.test(s.reason));
    assert.equal(stopped.length, 1, 'the third was refused by the budget, not sniffed');
    assert.equal(res.report.skipped.length, 3, 'all three are still reported');
  });

  it('a symbolic link is skipped: git commits the link, not its target', () => {
    const repo = makeRepo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-secret-out-')));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'creds'), `${TOKEN}\n`);
    fs.symlinkSync(path.join(outside, 'creds'), path.join(repo, 'link'));
    const r = secretCheck.scanFile(repo, 'link');
    assert.equal(r.state, 'skipped');
    assert.match(r.reason, /symbolic link/);
  });

  it('a deleted file has nothing to scan and is not reported', () => {
    const repo = makeRepo();
    assert.deepEqual(secretCheck.scanFile(repo, 'gone.js'), { state: 'gone' });
  });

  it('an unreadable file is skipped with the error code, not treated as clean', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'x.js'), 'hello\n');
    const real = secretCheck._internal.readPrefix;
    secretCheck._internal.readPrefix = () => { const e = new Error('nope'); e.code = 'EACCES'; throw e; };
    try {
      assert.deepEqual(secretCheck.scanFile(repo, 'x.js'),
        { state: 'skipped', reason: 'could not be read (EACCES), so it was not scanned', bytes: 0 });
    } finally {
      secretCheck._internal.readPrefix = real;
    }
  });

  it('a file that turns unreadable after the sniff is skipped too, never clean', () => {
    // A file larger than the sniff window takes the second read, so both read
    // paths must fail closed. This is the one the prefix sniff added.
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'big.txt'), 'a'.repeat(20000));
    const real = secretCheck._internal.readFile;
    secretCheck._internal.readFile = () => { const e = new Error('nope'); e.code = 'EACCES'; throw e; };
    try {
      const r = secretCheck.scanFile(repo, 'big.txt');
      assert.equal(r.state, 'skipped');
      assert.match(r.reason, /could not be read \(EACCES\)/);
      assert.ok(r.bytes > 0, 'the sniff that did happen still counts against the budget');
    } finally {
      secretCheck._internal.readFile = real;
    }
  });

  it('a real permission denial is skipped, not clean', function () {
    if (process.getuid && process.getuid() === 0) return; // root reads anything
    const repo = makeRepo();
    const f = path.join(repo, 'locked.txt');
    fs.writeFileSync(f, `${TOKEN}\n`);
    fs.chmodSync(f, 0o000);
    try {
      const r = secretCheck.scanFile(repo, 'locked.txt');
      assert.equal(r.state, 'skipped', 'an unopenable file is never reported clean');
      assert.match(r.reason, /could not be read/);
    } finally {
      fs.chmodSync(f, 0o644);
    }
  });
});

describe('check', () => {
  /**
   * A classification with only the fields `check` reads.
   * @param {object} over - Field overrides.
   * @returns {object}
   */
  function classification(over) {
    return {
      owned: [], foreign: [], included: [], left: [], undecided: [],
      tangleclawMaintenance: [], tangleclawState: [], stageable: [], ...over
    };
  }

  it('TangleClaw maintenance that matches is held back like any other file', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), `key: ${TOKEN}\n`);
    const res = secretCheck.check(repo, classification({ tangleclawMaintenance: ['CLAUDE.md'], stageable: ['CLAUDE.md'] }), {});
    assert.deepEqual(res.classified.stageable, []);
    assert.deepEqual(res.classified.tangleclawMaintenance, [], 'not named in the commit body either');
    assert.deepEqual(res.undecided.map((f) => f.path), ['CLAUDE.md']);
  });

  it('a Leave on a clean file of the session\'s own changes nothing', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'a.js'), 'fine\n');
    const res = secretCheck.check(repo, classification({ owned: ['a.js'], stageable: ['a.js'] }), { 'a.js': 'leave' });
    assert.deepEqual(res.classified.stageable, ['a.js']);
    assert.deepEqual(res.undecided, []);
  });

  it('with no repo root nothing is read and nothing is held back', () => {
    const res = secretCheck.check(null, classification({ owned: ['a.js'], stageable: ['a.js'] }), {});
    assert.deepEqual(res.classified.stageable, ['a.js']);
    assert.equal(res.report.scannedCount, 0);
  });

  it('detailPhrase says nothing when there is nothing to say', () => {
    assert.equal(secretCheck.detailPhrase({ flagged: [], skipped: [] }), null);
  });

  it('a file budget stops the scan and says so, rather than reading the whole tree', () => {
    const repo = makeRepo();
    const names = [];
    for (let i = 0; i < 5; i++) {
      const n = `f${i}.txt`;
      names.push(n);
      fs.writeFileSync(path.join(repo, n), 'fine\n');
    }
    const res = secretCheck.check(repo, classification({ owned: names, stageable: names }), {}, { maxFiles: 2 });
    assert.equal(res.report.scannedCount, 2, 'stopped at the budget');
    assert.equal(res.report.skipped.length, 3, 'the rest are reported, not silently dropped');
    for (const s of res.report.skipped) {
      assert.match(s.reason, /stopped scanning after/, 'the reason names the budget');
    }
    assert.deepEqual(res.classified.stageable, names, 'an unscanned file is not withheld');
  });

  it('a byte budget stops the scan the same way', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(4096));
    fs.writeFileSync(path.join(repo, 'next.txt'), 'fine\n');
    const res = secretCheck.check(
      repo,
      classification({ owned: ['big.txt', 'next.txt'], stageable: ['big.txt', 'next.txt'] }),
      {},
      { maxBytes: 100 }
    );
    assert.equal(res.report.scannedCount, 1);
    assert.deepEqual(res.report.skipped.map((s) => s.path), ['next.txt']);
  });

  it('a budget never hides a secret already found before it was reached', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), `key: ${TOKEN}\n`);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'fine\n');
    const res = secretCheck.check(
      repo,
      classification({ owned: ['a.txt', 'b.txt'], stageable: ['a.txt', 'b.txt'] }),
      {},
      { maxFiles: 1 }
    );
    assert.deepEqual(res.undecided.map((f) => f.path), ['a.txt'], 'the match still blocks');
    assert.ok(!res.classified.stageable.includes('a.txt'), 'and is still withheld');
  });
});

describe('the scan size cap has one owner', () => {
  it('secret-scan owns it and uploads re-exports the same number', () => {
    const uploadsFs = require('../lib/uploads-fs');
    assert.equal(typeof secretScan.SCAN_SIZE_CAP, 'number');
    assert.equal(uploadsFs.SCAN_SIZE_CAP, secretScan.SCAN_SIZE_CAP);
    assert.equal(secretCheck.SCAN_SIZE_CAP, secretScan.SCAN_SIZE_CAP);
  });
});

describe('looksLikeText', () => {
  it('reads text as text, and NUL, dense control bytes or emptiness as not', () => {
    assert.equal(secretScan.looksLikeText(Buffer.from('plain\ttext\r\n')), true);
    assert.equal(secretScan.looksLikeText(Buffer.from([0x41, 0x00, 0x42])), false);
    assert.equal(secretScan.looksLikeText(Buffer.from([0x01, 0x02, 0x03, 0x41])), false);
    assert.equal(secretScan.looksLikeText(Buffer.alloc(0)), false);
  });
});
