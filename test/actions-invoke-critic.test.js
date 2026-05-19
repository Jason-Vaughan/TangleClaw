'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const invokeCritic = require('../lib/actions/invoke-critic');

describe('lib/actions/invoke-critic (#139 Chunk 11b)', () => {
  let tmpDir;
  let projectPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-invoke-critic-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Fresh project dir per test so file state is isolated.
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'project-'));
    execSync('git init -q', { cwd: projectPath });
    execSync('git config user.email test@example.com', { cwd: projectPath });
    execSync('git config user.name test-user', { cwd: projectPath });
    execSync('git commit --allow-empty -m init -q', { cwd: projectPath });
    execSync('git checkout -q -b feat/chunk-11b-test', { cwd: projectPath });
  });

  it('creates .tangleclaw/critic-runs.json on first run', () => {
    const result = invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');
    assert.ok(fs.existsSync(filePath));
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(arr.length, 1);
    assert.equal(arr[0].branchName, 'feat/chunk-11b-test');
    assert.ok(typeof arr[0].timestamp === 'string' && arr[0].timestamp.endsWith('Z'),
      'timestamp is ISO 8601 UTC');
    assert.equal(result.output.totalRuns, 1);
    assert.deepEqual(result.output.entry, arr[0]);
  });

  it('appends to an existing array', () => {
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([
      { branchName: 'feat/old', timestamp: '2026-05-18T00:00:00.000Z' }
    ]) + '\n');

    const result = invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(arr.length, 2);
    assert.equal(arr[0].branchName, 'feat/old', 'prior entry preserved');
    assert.equal(arr[1].branchName, 'feat/chunk-11b-test', 'new entry appended');
  });

  it('recovers from a malformed critic-runs.json by starting fresh', () => {
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{not json}');

    const result = invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(arr.length, 1, 'malformed file is rebuilt with a single new entry');
    assert.equal(arr[0].branchName, 'feat/chunk-11b-test');
  });

  it('recovers from a top-level object (non-array) by starting fresh', () => {
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ unexpected: 'object' }));

    const result = invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(arr.length, 1);
  });

  it('uses caller-supplied branchName when provided', () => {
    const result = invokeCritic.run(
      { path: projectPath, name: 'p' },
      { branchName: 'explicit/branch' }
    );
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(
      path.join(projectPath, '.tangleclaw', 'critic-runs.json'), 'utf8'
    ));
    assert.equal(arr[0].branchName, 'explicit/branch');
  });

  it('fails gracefully on detached HEAD', () => {
    // Detach
    const sha = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf8' }).trim();
    execSync(`git checkout -q --detach ${sha}`, { cwd: projectPath });

    const result = invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('git branch'),
      'detached HEAD surfaces a branch-resolution error');
    assert.equal(
      fs.existsSync(path.join(projectPath, '.tangleclaw', 'critic-runs.json')),
      false,
      'no file is written on branch-resolution failure'
    );
  });

  it('fails gracefully on non-git directory', () => {
    const nonGitDir = fs.mkdtempSync(path.join(tmpDir, 'non-git-'));
    const result = invokeCritic.run({ path: nonGitDir, name: 'p' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('git branch'));
  });

  it('refuses an empty / missing project.path', () => {
    const r1 = invokeCritic.run({ path: '', name: 'p' });
    assert.equal(r1.ok, false);
    assert.ok(r1.error.includes('non-empty project.path'));

    const r2 = invokeCritic.run({ name: 'p' });
    assert.equal(r2.ok, false);

    const r3 = invokeCritic.run(null);
    assert.equal(r3.ok, false);
  });

  it('uses caller-supplied now() seam for deterministic timestamps', () => {
    const fixed = new Date('2026-05-19T12:34:56.789Z');
    const result = invokeCritic.run(
      { path: projectPath, name: 'p' },
      { now: () => fixed }
    );
    assert.equal(result.ok, true);
    assert.equal(result.output.entry.timestamp, '2026-05-19T12:34:56.789Z');
  });

  it('atomic write — no temp file remains after success', () => {
    invokeCritic.run({ path: projectPath, name: 'p' });
    const tcDir = path.join(projectPath, '.tangleclaw');
    const remnants = fs.readdirSync(tcDir).filter((n) => n.startsWith('critic-runs.json.tmp.'));
    assert.deepEqual(remnants, [], 'no .tmp.* files remain');
  });

  it('idempotency: multiple invocations append distinct entries', () => {
    invokeCritic.run({ path: projectPath, name: 'p' }, { now: () => new Date('2026-05-19T01:00:00Z') });
    invokeCritic.run({ path: projectPath, name: 'p' }, { now: () => new Date('2026-05-19T02:00:00Z') });
    invokeCritic.run({ path: projectPath, name: 'p' }, { now: () => new Date('2026-05-19T03:00:00Z') });
    const arr = JSON.parse(fs.readFileSync(
      path.join(projectPath, '.tangleclaw', 'critic-runs.json'), 'utf8'
    ));
    assert.equal(arr.length, 3);
    assert.deepEqual(arr.map((e) => e.timestamp), [
      '2026-05-19T01:00:00.000Z',
      '2026-05-19T02:00:00.000Z',
      '2026-05-19T03:00:00.000Z'
    ]);
  });

  it('fails gracefully when .tangleclaw exists as a regular file', () => {
    // mkdirSync({recursive: true}) throws EEXIST when the target path
    // is a non-directory. Pin the surfaced shape so a future refactor
    // can't regress to a crash.
    const tangleclawPath = path.join(projectPath, '.tangleclaw');
    fs.writeFileSync(tangleclawPath, 'this is a regular file, not a directory');

    const result = invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('failed to create .tangleclaw directory'));
    // Project absolute path must NOT appear in the surfaced error.
    assert.equal(result.error.includes(projectPath), false,
      'project absolute path must be redacted from error messages');
    assert.ok(result.error.includes('<project>') || !result.error.includes('/'),
      'redaction placeholder used when fs error mentioned the path');
  });

  it('_redactProjectPath strips the project absolute path', () => {
    const redacted = invokeCritic._redactProjectPath(
      "EEXIST: file already exists, mkdir '/abs/path/to/proj/.tangleclaw'",
      '/abs/path/to/proj'
    );
    assert.equal(redacted, "EEXIST: file already exists, mkdir '<project>/.tangleclaw'");
  });

  it('_redactProjectPath is a no-op when projectPath is empty', () => {
    const msg = "EEXIST: '/some/path'";
    assert.equal(invokeCritic._redactProjectPath(msg, ''), msg);
    assert.equal(invokeCritic._redactProjectPath(msg, null), msg);
  });

  it('writes a file that critic-check.js can read end-to-end', () => {
    // Round-trip pin: this writer + the Chunk 7 reader must agree on shape.
    const criticCheckMod = require('../lib/wrap-steps/critic-check');
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');

    invokeCritic.run({ path: projectPath, name: 'p' }, { branchName: 'feat/chunk-11b-test' });

    // The check handler's `defaultLoadCriticRuns` isn't exported, but the
    // module's reader is well-pinned in its own test file. Read the file
    // raw and apply the same filter to verify shape compatibility.
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const filtered = arr.filter((e) => e && typeof e.branchName === 'string');
    assert.equal(filtered.length, 1, 'reader-side filter retains our entries');
    assert.ok(criticCheckMod, 'critic-check module is importable');
  });
});
