'use strict';

// #2825 (Architect Ruling A2825): idempotent Fleet Group, shared
// LANE_QUEUE doc & Merge Queue bootstrap. Unlike every other Slice 1
// module this wave, provisionFleetResources is a real orchestration
// function over a real (scratch, per-test) store -- standing up a fleet's
// shared infrastructure necessarily means real side effects. Every test
// here runs against its own fresh store and sharedDir on disk.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

let tmpDir;
let fp;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-prov-'));
  store._setBasePath(tmpDir);
  store.init();
  delete require.cache[require.resolve('../lib/fleet-provisioning')];
  fp = require('../lib/fleet-provisioning');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a real project backed by its own fresh temp directory.
 * @param {string} name
 * @returns {object} The created project row
 */
function makeProject(name) {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-fleet-prov-${name}-`));
  return store.projects.create({ name, path: projDir });
}

describe('fleet-provisioning: input validation', () => {
  it('refuses a missing groupName, sharedDir, or non-array memberProjectIds', () => {
    assert.equal(fp.provisionFleetResources({}).code, 'FLEET_PROVISIONING_INVALID');
    assert.equal(fp.provisionFleetResources({ groupName: 'X' }).code, 'FLEET_PROVISIONING_INVALID');
    assert.equal(
      fp.provisionFleetResources({ groupName: 'X', sharedDir: path.join(tmpDir, 'x'), memberProjectIds: 'nope' }).code,
      'FLEET_PROVISIONING_INVALID'
    );
  });

  it('propagates a sharedDir validation failure from ensureGroupSharedDir unchanged', () => {
    const r = fp.provisionFleetResources({ groupName: 'X', sharedDir: 'relative/path', memberProjectIds: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SHARED_DIR_INVALID');
  });

  it('refuses a laneQueueFilename that would traverse outside sharedDir, before any write (PRR-B I-Gate Round 1 #1 on PR #2869)', () => {
    const a = makeProject('Lane-A');
    const sharedDir = path.join(tmpDir, 'shared-traversal');
    const outsidePath = path.join(tmpDir, 'outside.md');

    for (const bad of ['../outside.md', '..\\outside.md', '/etc/outside.md', '.', '..', '']) {
      const r = fp.provisionFleetResources({
        groupName: `Fleet Traversal ${bad}`, sharedDir, memberProjectIds: [a.id], laneQueueFilename: bad
      });
      assert.equal(r.ok, false, `expected a refusal for laneQueueFilename ${JSON.stringify(bad)}`);
      assert.equal(r.code, 'FLEET_PROVISIONING_INVALID');
    }
    assert.ok(!fs.existsSync(sharedDir), 'sharedDir must never be created when the filename is rejected up front');
    assert.ok(!fs.existsSync(outsidePath), 'nothing must be written outside sharedDir');
  });

  it('accepts a plain custom laneQueueFilename and scaffolds it inside sharedDir', () => {
    const a = makeProject('Lane-A');
    const sharedDir = path.join(tmpDir, 'shared-custom-filename');

    const r = fp.provisionFleetResources({
      groupName: 'Fleet CustomFilename', sharedDir, memberProjectIds: [a.id], laneQueueFilename: 'QUEUE.md'
    });

    assert.equal(r.ok, true);
    assert.equal(r.result.laneQueue.path, path.join(sharedDir, 'QUEUE.md'));
    assert.ok(fs.existsSync(r.result.laneQueue.path));
  });

  it('still defaults to LANE_QUEUE.md when laneQueueFilename is omitted', () => {
    const a = makeProject('Lane-A');
    const sharedDir = path.join(tmpDir, 'shared-default-filename');

    const r = fp.provisionFleetResources({ groupName: 'Fleet DefaultFilename', sharedDir, memberProjectIds: [a.id] });

    assert.equal(r.ok, true);
    assert.equal(r.result.laneQueue.path, path.join(sharedDir, 'LANE_QUEUE.md'));
  });

  it('refuses a dangling symlink at the lane-queue path rather than writing through it outside sharedDir (PRR-B I-Gate Round 2 on PR #2869)', () => {
    const a = makeProject('Lane-A');
    const sharedDir = path.join(tmpDir, 'shared-dangling-symlink');
    fs.mkdirSync(sharedDir, { recursive: true });
    const laneQueuePath = path.join(sharedDir, 'LANE_QUEUE.md');
    const outsideTarget = path.join(tmpDir, 'outside.md');
    fs.symlinkSync(outsideTarget, laneQueuePath);

    const r = fp.provisionFleetResources({ groupName: 'Fleet DanglingSymlink', sharedDir, memberProjectIds: [a.id] });

    assert.equal(r.ok, false);
    assert.equal(r.code, 'FLEET_PROVISIONING_UNSAFE_PATH');
    assert.ok(!fs.existsSync(outsideTarget), 'the scaffold must never be written through the dangling symlink to outside sharedDir');
  });

  it('refuses a live symlink at the lane-queue path, even when its target is readable and inside sharedDir', () => {
    const a = makeProject('Lane-A');
    const sharedDir = path.join(tmpDir, 'shared-live-symlink');
    fs.mkdirSync(sharedDir, { recursive: true });
    const realFile = path.join(sharedDir, 'real.md');
    fs.writeFileSync(realFile, '# real');
    const laneQueuePath = path.join(sharedDir, 'LANE_QUEUE.md');
    fs.symlinkSync(realFile, laneQueuePath);

    const r = fp.provisionFleetResources({ groupName: 'Fleet LiveSymlink', sharedDir, memberProjectIds: [a.id] });

    assert.equal(r.ok, false);
    assert.equal(r.code, 'FLEET_PROVISIONING_UNSAFE_PATH');
  });

  it('a plain pre-existing regular file at the lane-queue path is still left untouched, not refused', () => {
    const a = makeProject('Lane-A');
    const sharedDir = path.join(tmpDir, 'shared-preexisting-file');
    fs.mkdirSync(sharedDir, { recursive: true });
    const laneQueuePath = path.join(sharedDir, 'LANE_QUEUE.md');
    fs.writeFileSync(laneQueuePath, '# already here');

    const r = fp.provisionFleetResources({ groupName: 'Fleet PreexistingFile', sharedDir, memberProjectIds: [a.id] });

    assert.equal(r.ok, true);
    assert.equal(r.result.laneQueue.scaffolded, false);
    assert.equal(fs.readFileSync(laneQueuePath, 'utf8'), '# already here');
  });

  it('refuses an existing directory at the lane-queue path rather than registering it (PRR-B I-Gate Round 3 on PR #2869)', () => {
    const a = makeProject('Lane-A');
    const sharedDir = path.join(tmpDir, 'shared-dir-at-lanequeue-path');
    const laneQueuePath = path.join(sharedDir, 'LANE_QUEUE.md');
    fs.mkdirSync(laneQueuePath, { recursive: true });

    const r = fp.provisionFleetResources({ groupName: 'Fleet DirAtLaneQueue', sharedDir, memberProjectIds: [a.id] });

    assert.equal(r.ok, false);
    assert.equal(r.code, 'FLEET_PROVISIONING_UNSAFE_PATH');
    assert.ok(fs.statSync(laneQueuePath).isDirectory(), 'the directory must be left untouched, not written through');
  });
});

describe('fleet-provisioning: provisionFleetResources (#2825)', () => {
  it('creates the group, sharedDir, and a registered, scaffolded LANE_QUEUE.md in one call', () => {
    const a = makeProject('Lane-A');
    const b = makeProject('Lane-B');
    const sharedDir = path.join(tmpDir, 'shared-fleet-x');

    const r = fp.provisionFleetResources({
      groupName: 'Fleet X', sharedDir, memberProjectIds: [a.id, b.id], coordinatorProjectId: a.id
    });

    assert.equal(r.ok, true);
    assert.equal(r.result.groupCreated, true);
    assert.equal(r.result.group.name, 'Fleet X');
    assert.equal(r.result.sharedDir.created, true);
    assert.ok(fs.statSync(sharedDir).isDirectory());
    assert.deepEqual(r.result.memberProjectIds.sort(), [a.id, b.id].sort());
    assert.equal(r.result.laneQueue.scaffolded, true);
    assert.equal(r.result.laneQueue.registered, true);
    assert.ok(fs.existsSync(r.result.laneQueue.path));
    assert.match(fs.readFileSync(r.result.laneQueue.path, 'utf8'), /# Lane Queue/);

    const groups = store.projectGroups.getByProject(a.id);
    assert.ok(groups.some((g) => g.name === 'Fleet X'));
  });

  it('binds every memberProjectId AND the coordinatorProjectId into the group', () => {
    const a = makeProject('Lane-A');
    const b = makeProject('Lane-B');
    const coord = makeProject('Lane-PM');
    const sharedDir = path.join(tmpDir, 'shared-fleet-y');

    const r = fp.provisionFleetResources({
      groupName: 'Fleet Y', sharedDir, memberProjectIds: [a.id, b.id], coordinatorProjectId: coord.id
    });
    assert.deepEqual(r.result.memberProjectIds.sort(), [a.id, b.id, coord.id].sort());
  });

  it('is idempotent: re-running on an already-provisioned fleet reuses the group and sharedDir', () => {
    const a = makeProject('Lane-A');
    const sharedDir = path.join(tmpDir, 'shared-fleet-z');
    const input = { groupName: 'Fleet Z', sharedDir, memberProjectIds: [a.id], coordinatorProjectId: a.id };

    const first = fp.provisionFleetResources(input);
    const second = fp.provisionFleetResources(input);

    assert.equal(first.result.groupCreated, true);
    assert.equal(second.result.groupCreated, false);
    assert.equal(second.result.group.id, first.result.group.id);
    assert.equal(second.result.sharedDir.created, false);
    assert.equal(second.result.laneQueue.scaffolded, false);
    assert.equal(second.result.laneQueue.registered, false, 'already registered from the first run -- not re-registered, not an error');
  });

  it('never clobbers LANE_QUEUE.md\'s own content on re-run', () => {
    const a = makeProject('Lane-A');
    const sharedDir = path.join(tmpDir, 'shared-fleet-w');
    const input = { groupName: 'Fleet W', sharedDir, memberProjectIds: [a.id] };

    const first = fp.provisionFleetResources(input);
    fs.appendFileSync(first.result.laneQueue.path, '\n| Car 1 | Lane-A | TC-Lane-PRR-A | #1 | lib/x.js | WORKING |\n');
    const before = fs.readFileSync(first.result.laneQueue.path, 'utf8');

    fp.provisionFleetResources(input);
    const after = fs.readFileSync(first.result.laneQueue.path, 'utf8');
    assert.equal(before, after);
  });

  it('reconciles an existing group\'s sharedDir when the caller names a different one', () => {
    const a = makeProject('Lane-A');
    const firstDir = path.join(tmpDir, 'shared-first');
    const secondDir = path.join(tmpDir, 'shared-second');

    fp.provisionFleetResources({ groupName: 'Fleet Reloc', sharedDir: firstDir, memberProjectIds: [a.id] });
    const r = fp.provisionFleetResources({ groupName: 'Fleet Reloc', sharedDir: secondDir, memberProjectIds: [a.id] });

    assert.equal(r.result.group.sharedDir, secondDir);
    assert.ok(fs.statSync(secondDir).isDirectory());
  });

  it('skips the Merge Queue step with a named reason when no repoSlug is given', () => {
    const a = makeProject('Lane-A');
    const r = fp.provisionFleetResources({
      groupName: 'Fleet NoRepo', sharedDir: path.join(tmpDir, 'shared-norepo'), memberProjectIds: [a.id]
    });
    assert.equal(r.result.mergeQueue.skipped, true);
    assert.match(r.result.mergeQueue.reason, /repoSlug/);
  });

  it('skips the Merge Queue step with a named reason when repoSlug is given but no operatorProof', () => {
    const a = makeProject('Lane-A');
    const r = fp.provisionFleetResources({
      groupName: 'Fleet NoAuth', sharedDir: path.join(tmpDir, 'shared-noauth'), memberProjectIds: [a.id],
      repoSlug: 'acme/repo'
    });
    assert.equal(r.result.mergeQueue.skipped, true);
    assert.match(r.result.mergeQueue.reason, /operator authority/);
  });

  it('creates the Merge Queue when repoSlug and operatorProof are both given', () => {
    const a = makeProject('Lane-A');
    const r = fp.provisionFleetResources({
      groupName: 'Fleet WithQueue', sharedDir: path.join(tmpDir, 'shared-wq'), memberProjectIds: [a.id],
      coordinatorProjectId: a.id, repoSlug: 'acme/repo', operatorProof: 'test-proof-123'
    });
    assert.equal(r.result.mergeQueue.skipped, false);
    assert.equal(r.result.mergeQueue.reused, false);
    assert.equal(r.result.mergeQueue.queue.repo, 'acme/repo');
    assert.equal(r.result.mergeQueue.queue.ownerProjectId, a.id);
  });

  it('reuses an existing active Merge Queue on re-run rather than refusing', () => {
    const a = makeProject('Lane-A');
    const input = {
      groupName: 'Fleet ReuseQueue', sharedDir: path.join(tmpDir, 'shared-rq'), memberProjectIds: [a.id],
      coordinatorProjectId: a.id, repoSlug: 'acme/repo2', operatorProof: 'test-proof-456'
    };
    const first = fp.provisionFleetResources(input);
    const second = fp.provisionFleetResources(input);
    assert.equal(first.result.mergeQueue.reused, false);
    assert.equal(second.result.mergeQueue.reused, true);
    assert.equal(second.result.mergeQueue.queue, null);
  });

  it('uses the first bound member as the Merge Queue owner when no coordinatorProjectId is given', () => {
    const a = makeProject('Lane-A');
    const r = fp.provisionFleetResources({
      groupName: 'Fleet NoCoord', sharedDir: path.join(tmpDir, 'shared-nc'), memberProjectIds: [a.id],
      repoSlug: 'acme/repo3', operatorProof: 'test-proof-789'
    });
    assert.equal(r.result.mergeQueue.queue.ownerProjectId, a.id);
  });
});

describe('fleet-provisioning: exported vocabulary', () => {
  it('exposes the default LANE_QUEUE filename and scaffold text', () => {
    assert.equal(fp.DEFAULT_LANE_QUEUE_FILENAME, 'LANE_QUEUE.md');
    assert.match(fp.LANE_QUEUE_SCAFFOLD, /# Lane Queue/);
  });
});
