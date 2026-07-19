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

  it('creates .tangleclaw/critic-runs.json on first run', async () => {
    const result = await invokeCritic.run({ path: projectPath, name: 'p' });
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

  it('appends to an existing array', async () => {
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([
      { branchName: 'feat/old', timestamp: '2026-05-18T00:00:00.000Z' }
    ]) + '\n');

    const result = await invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(arr.length, 2);
    assert.equal(arr[0].branchName, 'feat/old', 'prior entry preserved');
    assert.equal(arr[1].branchName, 'feat/chunk-11b-test', 'new entry appended');
  });

  it('recovers from a malformed critic-runs.json by starting fresh', async () => {
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{not json}');

    const result = await invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(arr.length, 1, 'malformed file is rebuilt with a single new entry');
    assert.equal(arr[0].branchName, 'feat/chunk-11b-test');
  });

  it('recovers from a top-level object (non-array) by starting fresh', async () => {
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ unexpected: 'object' }));

    const result = await invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(arr.length, 1);
  });

  it('uses caller-supplied branchName when provided', async () => {
    const result = await invokeCritic.run(
      { path: projectPath, name: 'p' },
      { branchName: 'explicit/branch' }
    );
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(
      path.join(projectPath, '.tangleclaw', 'critic-runs.json'), 'utf8'
    ));
    assert.equal(arr[0].branchName, 'explicit/branch');
  });

  it('fails gracefully on detached HEAD', async () => {
    // Detach
    const sha = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf8' }).trim();
    execSync(`git checkout -q --detach ${sha}`, { cwd: projectPath });

    const result = await invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('git branch'),
      'detached HEAD surfaces a branch-resolution error');
    assert.equal(
      fs.existsSync(path.join(projectPath, '.tangleclaw', 'critic-runs.json')),
      false,
      'no file is written on branch-resolution failure'
    );
  });

  it('fails gracefully on non-git directory', async () => {
    const nonGitDir = fs.mkdtempSync(path.join(tmpDir, 'non-git-'));
    const result = await invokeCritic.run({ path: nonGitDir, name: 'p' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('git branch'));
  });

  it('refuses an empty / missing project.path', async () => {
    const r1 = await invokeCritic.run({ path: '', name: 'p' });
    assert.equal(r1.ok, false);
    assert.ok(r1.error.includes('non-empty project.path'));

    const r2 = await invokeCritic.run({ name: 'p' });
    assert.equal(r2.ok, false);

    const r3 = await invokeCritic.run(null);
    assert.equal(r3.ok, false);
  });

  it('uses caller-supplied now() seam for deterministic timestamps', async () => {
    const fixed = new Date('2026-05-19T12:34:56.789Z');
    const result = await invokeCritic.run(
      { path: projectPath, name: 'p' },
      { now: () => fixed }
    );
    assert.equal(result.ok, true);
    assert.equal(result.output.entry.timestamp, '2026-05-19T12:34:56.789Z');
  });

  it('atomic write — no temp file remains after success', async () => {
    await invokeCritic.run({ path: projectPath, name: 'p' });
    const tcDir = path.join(projectPath, '.tangleclaw');
    const remnants = fs.readdirSync(tcDir).filter((n) => n.startsWith('critic-runs.json.tmp.'));
    assert.deepEqual(remnants, [], 'no .tmp.* files remain');
  });

  it('idempotency: multiple invocations append distinct entries', async () => {
    await invokeCritic.run({ path: projectPath, name: 'p' }, { now: () => new Date('2026-05-19T01:00:00Z') });
    await invokeCritic.run({ path: projectPath, name: 'p' }, { now: () => new Date('2026-05-19T02:00:00Z') });
    await invokeCritic.run({ path: projectPath, name: 'p' }, { now: () => new Date('2026-05-19T03:00:00Z') });
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

  it('fails gracefully when .tangleclaw exists as a regular file', async () => {
    // mkdirSync({recursive: true}) throws EEXIST when the target path
    // is a non-directory. Pin the surfaced shape so a future refactor
    // can't regress to a crash.
    const tangleclawPath = path.join(projectPath, '.tangleclaw');
    fs.writeFileSync(tangleclawPath, 'this is a regular file, not a directory');

    const result = await invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('failed to create .tangleclaw directory'));
    // Project absolute path must NOT appear in the surfaced error.
    assert.equal(result.error.includes(projectPath), false,
      'project absolute path must be redacted from error messages');
    assert.ok(result.error.includes('<project>') || !result.error.includes('/'),
      'redaction placeholder used when fs error mentioned the path');
  });

  it('_redactProjectPath strips the project absolute path', async () => {
    const redacted = invokeCritic._redactProjectPath(
      "EEXIST: file already exists, mkdir '/abs/path/to/proj/.tangleclaw'",
      '/abs/path/to/proj'
    );
    assert.equal(redacted, "EEXIST: file already exists, mkdir '<project>/.tangleclaw'");
  });

  it('_redactProjectPath is a no-op when projectPath is empty', async () => {
    const msg = "EEXIST: '/some/path'";
    assert.equal(invokeCritic._redactProjectPath(msg, ''), msg);
    assert.equal(invokeCritic._redactProjectPath(msg, null), msg);
  });

  it('writes a per-branch audit entry with the documented shape', async () => {
    // `.tangleclaw/critic-runs.json` is a branch-keyed audit record of Critic
    // dispatches — the wrap no longer gates on it, so this pins the shape the
    // file itself promises rather than a consumer's expectations.
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');

    await invokeCritic.run({ path: projectPath, name: 'p' }, { branchName: 'feat/chunk-11b-test' });

    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(Array.isArray(arr), 'the store is a JSON array');
    assert.equal(arr.length, 1);
    assert.equal(arr[0].branchName, 'feat/chunk-11b-test');
    assert.equal(typeof arr[0].timestamp, 'string');
  });
});

describe('lib/actions/invoke-critic (#267 — real-invocation paths)', () => {
  let tmpDir;
  let projectPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-invoke-critic-267-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'project-'));
    execSync('git init -q', { cwd: projectPath });
    execSync('git config user.email test@example.com', { cwd: projectPath });
    execSync('git config user.name test-user', { cwd: projectPath });
    execSync('git commit --allow-empty -m init -q', { cwd: projectPath });
    execSync('git checkout -q -b feat/267-real-invocation', { cwd: projectPath });
  });

  it('records ranAt:"ack" when no session is provided (falls back gracefully)', async () => {
    const result = await invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, true);
    assert.equal(result.output.mode, 'ack');
    assert.equal(result.output.findingCount, 0);
    assert.deepEqual(result.output.findings, []);
    assert.equal(result.output.fallbackReason, 'noActiveSession');
    assert.equal(result.output.entry.ranAt, 'ack');
  });

  it('records ranAt:"ack" with degradedEngine fallback when engine != claude (legacy `engine` field)', async () => {
    const result = await invokeCritic.run(
      { path: projectPath, name: 'p' },
      { session: { tmuxSession: 'fake', engine: 'gemini' } }
    );
    assert.equal(result.ok, true);
    assert.equal(result.output.mode, 'ack');
    assert.equal(result.output.fallbackReason, 'degradedEngine:gemini');
    assert.equal(result.output.entry.ranAt, 'ack');
  });

  it('records degradedEngine fallback when engine != claude (production `engineId` field — Critic regression pin)', async () => {
    // Critic finding on PR #269: the production session record from
    // `store.sessions.getActive` exposes `engineId`, not `engine`. The
    // engine guard MUST read either field. This test pins that
    // contract — without it, the BLOCKING bug shipped silently because
    // every other test hand-constructed sessions with `engine: ...`.
    const result = await invokeCritic.run(
      { path: projectPath, name: 'p' },
      { session: { tmuxSession: 'fake', engineId: 'gemini' } }
    );
    assert.equal(result.ok, true);
    assert.equal(result.output.mode, 'ack');
    assert.equal(result.output.fallbackReason, 'degradedEngine:gemini');
  });

  it('treats engine prefixes like `openclaw:<conn>` as degraded (not bare "claude")', async () => {
    // OpenClaw engines surface as `openclaw:<connection-id>` —
    // string-equality against `"claude"` is the right test (substring
    // matches like `engine.includes("claude")` would mistakenly pass
    // these too).
    const result = await invokeCritic.run(
      { path: projectPath, name: 'p' },
      { session: { tmuxSession: 'fake', engineId: 'openclaw:remote-1' } }
    );
    assert.equal(result.output.fallbackReason, 'degradedEngine:openclaw:remote-1');
  });

  it('records degradedEngine:unknown when session has tmuxSession but no engine field at all', async () => {
    // Defensive: a corrupt or partial session record should still
    // surface a structured fallback reason rather than silently
    // attempting the /critic dispatch on an unknown-engine session.
    const result = await invokeCritic.run(
      { path: projectPath, name: 'p' },
      { session: { tmuxSession: 'fake' } }
    );
    assert.equal(result.output.fallbackReason, 'degradedEngine:unknown');
  });

  it('forces ack-only path via options.ackOnly even when session looks valid', async () => {
    // Belt-and-suspenders: lets the wrap pipeline or future callers
    // explicitly opt out of real invocation without faking session
    // absence.
    const result = await invokeCritic.run(
      { path: projectPath, name: 'p' },
      { session: { tmuxSession: 'fake', engine: 'claude' }, ackOnly: true }
    );
    assert.equal(result.ok, true);
    assert.equal(result.output.mode, 'ack');
    assert.equal(result.output.fallbackReason, undefined,
      'ackOnly path does NOT record a fallback reason since it never attempted real invocation');
  });

  it('records ranAt:"actual" with parsed findings when /critic returns findings', async () => {
    // Pre-write the findings file the way the Critic skill would, then
    // inject sendKeys/detectIdle/sleep stubs to fast-path the polling.
    const findingsPath = path.join(projectPath, '.prawduct', '.critic-findings.json');
    fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
    fs.writeFileSync(findingsPath, JSON.stringify({
      mode: 'chunk (lighter pass, not ready for push)',
      mode_chosen_by: 'test-fixture',
      findings: [
        { severity: 'warning', message: 'sample warning', recommendation: 'do the thing' },
        { severity: 'note',    message: 'sample note' }
      ]
    }));

    // Restore the seam after the test so subsequent tests aren't poisoned
    const originalSendKeys = invokeCritic._internal.sendKeys;
    const originalDetectIdle = invokeCritic._internal.detectIdle;
    const originalSleep = invokeCritic._internal.sleep;
    invokeCritic._internal.sendKeys = () => {};
    invokeCritic._internal.detectIdle = () => ({ idle: true });
    invokeCritic._internal.sleep = () => Promise.resolve();

    try {
      const result = await invokeCritic.run(
        { path: projectPath, name: 'p' },
        { session: { tmuxSession: 'fake', engine: 'claude' } }
      );
      assert.equal(result.ok, true);
      assert.equal(result.output.mode, 'actual');
      assert.equal(result.output.findingCount, 2);
      assert.equal(result.output.findings.length, 2);
      assert.equal(result.output.findings[0].severity, 'warning');
      assert.equal(result.output.entry.ranAt, 'actual');
      assert.equal(result.output.entry.criticFindingsRef, '.prawduct/.critic-findings.json');
      assert.equal(result.output.fallbackReason, undefined);
      assert.ok(result.output.criticSummary, 'raw Critic summary surfaces in output');
      assert.equal(result.output.criticSummary.mode_chosen_by, 'test-fixture');
    } finally {
      invokeCritic._internal.sendKeys = originalSendKeys;
      invokeCritic._internal.detectIdle = originalDetectIdle;
      invokeCritic._internal.sleep = originalSleep;
    }
  });

  it('falls back to ack-only with noFindingsFile reason when Critic finishes but writes nothing', async () => {
    const originalSendKeys = invokeCritic._internal.sendKeys;
    const originalDetectIdle = invokeCritic._internal.detectIdle;
    const originalSleep = invokeCritic._internal.sleep;
    invokeCritic._internal.sendKeys = () => {};
    invokeCritic._internal.detectIdle = () => ({ idle: true });
    invokeCritic._internal.sleep = () => Promise.resolve();

    try {
      const result = await invokeCritic.run(
        { path: projectPath, name: 'p' },
        { session: { tmuxSession: 'fake', engine: 'claude' } }
      );
      assert.equal(result.ok, true);
      assert.equal(result.output.mode, 'ack');
      assert.equal(result.output.fallbackReason, 'noFindingsFile');
    } finally {
      invokeCritic._internal.sendKeys = originalSendKeys;
      invokeCritic._internal.detectIdle = originalDetectIdle;
      invokeCritic._internal.sleep = originalSleep;
    }
  });

  it('falls back to ack-only with tmuxSendFailed when sendKeys throws', async () => {
    const originalSendKeys = invokeCritic._internal.sendKeys;
    invokeCritic._internal.sendKeys = () => { throw new Error('tmux died'); };
    try {
      const result = await invokeCritic.run(
        { path: projectPath, name: 'p' },
        { session: { tmuxSession: 'fake', engine: 'claude' } }
      );
      assert.equal(result.ok, true);
      assert.equal(result.output.mode, 'ack');
      assert.equal(result.output.fallbackReason, 'tmuxSendFailed');
    } finally {
      invokeCritic._internal.sendKeys = originalSendKeys;
    }
  });

  it('schema is backward-compatible — old entries without ranAt still read as branch-matched', async () => {
    // Readers of `.tangleclaw/critic-runs.json` identify an entry by
    // `typeof entry.branchName === "string"`; the `ranAt` field is additive.
    // Pin that old entries (no ranAt) AND new entries (ranAt:"ack" /
    // ranAt:"actual") coexist without breaking that predicate.
    const filePath = path.join(projectPath, '.tangleclaw', 'critic-runs.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([
      { branchName: 'feat/old-pre-267', timestamp: '2026-05-20T00:00:00.000Z' }
    ]));

    const result = await invokeCritic.run({ path: projectPath, name: 'p' });
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(arr.length, 2);
    assert.equal(arr[0].ranAt, undefined, 'old entry left untouched');
    assert.equal(arr[1].ranAt, 'ack', 'new entry carries ranAt');
    assert.equal(typeof arr[0].branchName, 'string',
      'old entry still carries the branch-name key readers match on');
    assert.equal(typeof arr[1].branchName, 'string',
      'new entry still carries the branch-name key readers match on');
  });
});
