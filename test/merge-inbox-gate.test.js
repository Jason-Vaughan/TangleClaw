'use strict';

/*
 * `lib/merge-inbox-gate.js` (#1717 Slice 1) — a durable, action-scoped
 * merge constraint / hold engine, built to the Architect's direction that
 * an unread Medusa inbox must not be the source of merge authority
 * (Ruling A500-W1B-R1). Driven against a real file on disk: the module's
 * whole point is durability independent of any caller's in-memory state,
 * so every test re-reads through a fresh call rather than trusting a
 * returned object.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gate = require('../lib/merge-inbox-gate');

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-merge-inbox-gate-'));
  file = path.join(dir, 'holds.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const REPO = 'Jason-Vaughan/TangleClaw';

/**
 * Issue a valid hold, asserting success, and return it.
 * @param {object} [over] - Fields to replace.
 * @returns {object}
 */
function hold(over = {}) {
  const result = gate.issueHold(file, { repo: REPO, pr: 2875, reason: 'In-flight ruling', issuedBy: 'tc-lane-arc-4041e89e', ...over });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.hold;
}

describe('lock constants', () => {
  it('are sane relative to each other, and the suffix is what the lock path check elsewhere assumes', () => {
    assert.ok(gate.LOCK_STALE_MS > gate.LOCK_MAX_WAIT_MS,
      'a lock must be presumed abandoned well after the wait budget this module itself gives up at, or a live holder\'s own pending call could be broken as "stale" by a waiting peer');
    assert.equal(gate.LOCK_SUFFIX, '.lock');
  });
});

describe('_internal seam', () => {
  const real = { now: gate._internal.now, id: gate._internal.id };
  afterEach(() => { gate._internal.now = real.now; gate._internal.id = real.id; });

  it('stamps a hold with exactly the clock and id the seam gives, so a test can pin both deterministically', () => {
    gate._internal.now = () => '2026-11-05T00:00:00.000Z';
    gate._internal.id = () => 'hold_deterministic';
    const result = gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x', issuedBy: 'y' });
    assert.equal(result.hold.holdId, 'hold_deterministic');
    assert.equal(result.hold.issuedAt, '2026-11-05T00:00:00.000Z');
  });
});

describe('ACTIONS / HARD_GATE_ACTIONS / SOFT_ACTIONS', () => {
  it('partitions every action into exactly one of hard-gate or soft', () => {
    assert.deepEqual([...gate.HARD_GATE_ACTIONS, ...gate.SOFT_ACTIONS].sort(), [...gate.ACTIONS].sort());
    assert.equal(gate.HARD_GATE_ACTIONS.filter((a) => gate.SOFT_ACTIONS.includes(a)).length, 0);
  });

  it('commit is the one soft action; merge, auto-merge, release and restart are hard-gated', () => {
    assert.deepEqual([...gate.SOFT_ACTIONS], ['commit']);
    assert.deepEqual([...gate.HARD_GATE_ACTIONS].sort(), ['auto-merge', 'merge', 'release', 'restart']);
  });
});

describe('issueHold', () => {
  it('persists a hold independent of the caller: a fresh read sees it', () => {
    const issued = hold();
    assert.equal(gate.getHold(file, issued.holdId).holdId, issued.holdId);
    assert.equal(issued.status, 'active');
    assert.equal(issued.resolution, null);
    assert.deepEqual(issued.overrides, []);
  });

  it('refuses a repo that is not "owner/name"', () => {
    for (const bad of ['', 'onlyname', '/leading-slash', 'owner/', 'owner//two-slash']) {
      const result = gate.issueHold(file, { repo: bad, pr: 1, reason: 'x', issuedBy: 'y' });
      assert.equal(result.ok, false, bad);
      assert.equal(result.code, 'INVALID_IDENTITY');
    }
  });

  it('refuses an identity with none of pr, branch or issue', () => {
    const result = gate.issueHold(file, { repo: REPO, reason: 'x', issuedBy: 'y' });
    assert.equal(result.code, 'INVALID_IDENTITY');
  });

  it('accepts branch or issue as the identity, with no pr', () => {
    assert.equal(hold({ pr: undefined, branch: 'feat/x' }).branch, 'feat/x');
    assert.equal(hold({ pr: undefined, issue: 1717 }).issue, 1717);
  });

  it('refuses a malformed branch, and a branch ending ".." or "/"', () => {
    for (const bad of ['a..b', 'trailing/']) {
      assert.equal(gate.issueHold(file, { repo: REPO, branch: bad, reason: 'x', issuedBy: 'y' }).code, 'INVALID_IDENTITY');
    }
  });

  it('requires reason and issuedBy, each a non-blank string within the bound', () => {
    assert.equal(gate.issueHold(file, { repo: REPO, pr: 1, issuedBy: 'y' }).code, 'INVALID_INPUT');
    assert.equal(gate.issueHold(file, { repo: REPO, pr: 1, reason: '   ' }).code, 'INVALID_INPUT');
    assert.equal(gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x' }).code, 'INVALID_INPUT');
  });

  it('supersedes a named active hold atomically: the old one is superseded, the new one is active', () => {
    const old = hold({ reason: 'first' });
    const result = gate.issueHold(file, { repo: REPO, pr: 2875, reason: 'second, supersedes first', issuedBy: 'tc-lane-pm-9d85f3aa', supersedes: old.holdId });
    assert.equal(result.ok, true);
    const refreshedOld = gate.getHold(file, old.holdId);
    assert.equal(refreshedOld.status, 'superseded');
    assert.equal(refreshedOld.resolution.kind, 'superseded');
    assert.equal(refreshedOld.resolution.supersededBy, result.hold.holdId);
    assert.equal(result.hold.status, 'active');
  });

  it('refuses to supersede a hold that does not exist, or one that is not active', () => {
    assert.equal(gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x', issuedBy: 'y', supersedes: 'hold_nope' }).code, 'HOLD_NOT_FOUND');
    const old = hold();
    gate.acknowledgeHold(file, old.holdId, { by: 'z' });
    assert.equal(gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x', issuedBy: 'y', supersedes: old.holdId }).code, 'HOLD_NOT_ACTIVE');
  });
});

describe('acknowledgeHold', () => {
  it('moves an active hold to acknowledged, recording who and when', () => {
    const h = hold();
    const result = gate.acknowledgeHold(file, h.holdId, { by: 'tc-lane-int-08674b81', note: 'Confirmed resolved' });
    assert.equal(result.ok, true);
    assert.equal(result.hold.status, 'acknowledged');
    assert.equal(result.hold.resolution.kind, 'acknowledged');
    assert.equal(result.hold.resolution.by, 'tc-lane-int-08674b81');
    assert.equal(result.hold.resolution.note, 'Confirmed resolved');
    assert.equal(gate.getHold(file, h.holdId).status, 'acknowledged');
  });

  it('requires by, and accepts no note', () => {
    const h = hold();
    assert.equal(gate.acknowledgeHold(file, h.holdId, {}).code, 'INVALID_INPUT');
    const result = gate.acknowledgeHold(file, h.holdId, { by: 'x' });
    assert.equal(result.hold.resolution.note, null);
  });

  it('refuses an unknown hold id, and a hold already resolved', () => {
    assert.equal(gate.acknowledgeHold(file, 'hold_nope', { by: 'x' }).code, 'HOLD_NOT_FOUND');
    const h = hold();
    gate.acknowledgeHold(file, h.holdId, { by: 'x' });
    assert.equal(gate.acknowledgeHold(file, h.holdId, { by: 'y' }).code, 'HOLD_NOT_ACTIVE');
  });
});

describe('overrideHold', () => {
  it('scopes the override to one named action: that action clears, others stay blocked', () => {
    const h = hold();
    const result = gate.overrideHold(file, h.holdId, { by: 'tc-lane-arc-4041e89e', reason: 'Scoped, reasoned, audited', action: 'commit' });
    assert.equal(result.ok, true);
    assert.equal(result.hold.status, 'active', 'overriding one action does not resolve the hold itself');
    assert.equal(result.hold.overrides.length, 1);
    assert.equal(result.hold.overrides[0].action, 'commit');
    assert.equal(result.hold.overrides[0].by, 'tc-lane-arc-4041e89e');

    const merge = gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO, pr: 2875 } });
    assert.equal(merge.allowed, false, 'merge was never overridden, so it still blocks');
  });

  it('requires by, reason and a valid action', () => {
    const h = hold();
    assert.equal(gate.overrideHold(file, h.holdId, { reason: 'x', action: 'merge' }).code, 'INVALID_INPUT');
    assert.equal(gate.overrideHold(file, h.holdId, { by: 'x', action: 'merge' }).code, 'INVALID_INPUT');
    assert.equal(gate.overrideHold(file, h.holdId, { by: 'x', reason: 'y', action: 'nope' }).code, 'INVALID_INPUT');
  });

  it('refuses an unknown hold id, and one that is no longer active', () => {
    assert.equal(gate.overrideHold(file, 'hold_nope', { by: 'x', reason: 'y', action: 'merge' }).code, 'HOLD_NOT_FOUND');
    const h = hold();
    gate.acknowledgeHold(file, h.holdId, { by: 'x' });
    assert.equal(gate.overrideHold(file, h.holdId, { by: 'x', reason: 'y', action: 'merge' }).code, 'HOLD_NOT_ACTIVE');
  });

  it('records every override, never collapsing repeat overrides of different actions', () => {
    const h = hold();
    gate.overrideHold(file, h.holdId, { by: 'a', reason: 'r1', action: 'commit' });
    gate.overrideHold(file, h.holdId, { by: 'b', reason: 'r2', action: 'merge' });
    assert.equal(gate.getHold(file, h.holdId).overrides.length, 2);
  });
});

describe('matchingHolds — alias matching', () => {
  it('matches a hold issued against a PR when the lookup asks only about its branch, if the hold ALSO named that branch', () => {
    hold({ pr: 1714, branch: 'feat/guarded-accept' });
    const byBranch = gate.matchingHolds(file, { repo: REPO, branch: 'feat/guarded-accept' });
    assert.equal(byBranch.length, 1);
  });

  it('does not match when neither side shares an alias, even in the same repo', () => {
    hold({ pr: 1714 });
    assert.equal(gate.matchingHolds(file, { repo: REPO, branch: 'unrelated' }).length, 0);
  });

  it('never matches a different repo', () => {
    hold({ pr: 1 });
    assert.equal(gate.matchingHolds(file, { repo: 'someone-else/other-repo', pr: 1 }).length, 0);
  });

  it('matches by issue alias too, and leaves out acknowledged and superseded holds', () => {
    const h = hold({ pr: undefined, issue: 1717 });
    assert.equal(gate.matchingHolds(file, { repo: REPO, issue: 1717 }).length, 1);
    gate.acknowledgeHold(file, h.holdId, { by: 'x' });
    assert.equal(gate.matchingHolds(file, { repo: REPO, issue: 1717 }).length, 0);
  });
});

describe('checkActionGate', () => {
  it('reads clear with no matching hold', () => {
    const result = gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO, pr: 1 } });
    assert.deepEqual(result, { allowed: true, status: 'clear', action: 'merge', holds: [] });
  });

  it('blocks every hard-gate action while an active hold matches, naming it', () => {
    const h = hold();
    for (const action of gate.HARD_GATE_ACTIONS) {
      const result = gate.checkActionGate({ file, action, identity: { repo: REPO, pr: 2875 } });
      assert.equal(result.allowed, false, action);
      assert.equal(result.status, 'hold-active');
      assert.equal(result.holds[0].holdId, h.holdId);
      assert.match(result.message, /active hold/);
    }
  });

  it('never blocks commit: it reports advisory true while a hold matches, false once it does not', () => {
    const h = hold();
    const advised = gate.checkActionGate({ file, action: 'commit', identity: { repo: REPO, pr: 2875 } });
    assert.deepEqual(advised, { allowed: true, advisory: true, action: 'commit', holds: [h] });
    gate.acknowledgeHold(file, h.holdId, { by: 'x' });
    const clear = gate.checkActionGate({ file, action: 'commit', identity: { repo: REPO, pr: 2875 } });
    assert.deepEqual(clear, { allowed: true, advisory: false, action: 'commit', holds: [] });
  });

  it('clears once the hold is acknowledged, with no re-issue needed', () => {
    const h = hold();
    assert.equal(gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO, pr: 2875 } }).allowed, false);
    gate.acknowledgeHold(file, h.holdId, { by: 'x' });
    assert.equal(gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO, pr: 2875 } }).allowed, true);
  });

  it('clears once the hold is superseded by a newer one, but the newer hold blocks in its place', () => {
    const old = hold();
    const result = gate.issueHold(file, { repo: REPO, pr: 2875, reason: 'supersedes', issuedBy: 'z', supersedes: old.holdId });
    assert.equal(gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO, pr: 2875 } }).allowed, false);
    assert.equal(gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO, pr: 2875 } }).holds[0].holdId, result.hold.holdId);
  });

  it('a scoped override clears only the overridden action; a different identity alias is unaffected', () => {
    hold({ pr: 1714, branch: 'feat/guarded-accept' });
    const h = gate.matchingHolds(file, { repo: REPO, pr: 1714 })[0];
    gate.overrideHold(file, h.holdId, { by: 'x', reason: 'y', action: 'merge' });
    assert.equal(gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO, pr: 1714 } }).allowed, true);
    assert.equal(gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO, branch: 'feat/guarded-accept' } }).allowed, true,
      'the same hold, reached by its other alias, is still cleared for this action');
    assert.equal(gate.checkActionGate({ file, action: 'release', identity: { repo: REPO, pr: 1714 } }).allowed, false,
      'release was not named in the override');
  });

  it('refuses an unknown action or a malformed identity, rather than silently allowing', () => {
    assert.equal(gate.checkActionGate({ file, action: 'deploy', identity: { repo: REPO, pr: 1 } }).ok, false);
    assert.equal(gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO } }).ok, false);
  });

  it('two holds on the same identity both block, and both must clear', () => {
    hold({ reason: 'first' });
    hold({ reason: 'second' });
    assert.equal(gate.checkActionGate({ file, action: 'merge', identity: { repo: REPO, pr: 2875 } }).holds.length, 2);
  });
});

describe('buildStatusCheckPayload / autoMergeAllowed', () => {
  it('reads success with no active hold, and auto-merge is allowed', () => {
    const payload = gate.buildStatusCheckPayload({ file, identity: { repo: REPO, pr: 1 } });
    assert.equal(payload.state, 'success');
    assert.deepEqual(payload.holds, []);
    assert.equal(gate.autoMergeAllowed({ file, identity: { repo: REPO, pr: 1 } }), true);
  });

  it('reads failure while an active hold matches, naming it in the description; auto-merge is not allowed', () => {
    const h = hold();
    const payload = gate.buildStatusCheckPayload({ file, identity: { repo: REPO, pr: 2875 } });
    assert.equal(payload.state, 'failure');
    assert.match(payload.description, new RegExp(h.holdId));
    assert.equal(gate.autoMergeAllowed({ file, identity: { repo: REPO, pr: 2875 } }), false);
  });

  it('flips to success the moment the hold is acknowledged: a hold arriving after arming is exactly what this projection exists to catch going the other way', () => {
    const h = hold();
    assert.equal(gate.autoMergeAllowed({ file, identity: { repo: REPO, pr: 2875 } }), false);
    gate.acknowledgeHold(file, h.holdId, { by: 'x' });
    assert.equal(gate.autoMergeAllowed({ file, identity: { repo: REPO, pr: 2875 } }), true);
  });

  it('never reports pending: only success or failure, since this module\'s own computation is instant', () => {
    hold();
    const payload = gate.buildStatusCheckPayload({ file, identity: { repo: REPO, pr: 2875 } });
    assert.ok(['success', 'failure'].includes(payload.state));
  });
});

describe('evaluateMergeGate', () => {
  it('defaults to the merge action and attaches the status-check projection', () => {
    hold();
    const result = gate.evaluateMergeGate({ file, identity: { repo: REPO, pr: 2875 } });
    assert.equal(result.action, 'merge');
    assert.equal(result.allowed, false);
    assert.equal(result.statusCheck.state, 'failure');
  });

  it('evaluates auto-merge when asked, which is also what the status-check payload always reflects', () => {
    hold();
    const result = gate.evaluateMergeGate({ file, identity: { repo: REPO, pr: 2875 }, autoMerge: true });
    assert.equal(result.action, 'auto-merge');
    assert.equal(result.allowed, false);
  });

  it('allows and reads a success status check once clear', () => {
    const result = gate.evaluateMergeGate({ file, identity: { repo: REPO, pr: 2875 } });
    assert.equal(result.allowed, true);
    assert.equal(result.statusCheck.state, 'success');
  });
});

describe('getHold / listHolds', () => {
  it('getHold reads null for an unknown id, and a fresh independent view otherwise', () => {
    assert.equal(gate.getHold(file, 'hold_nope'), null);
    const h = hold();
    const viewed = gate.getHold(file, h.holdId);
    viewed.overrides.push({ fabricated: true });
    assert.equal(gate.getHold(file, h.holdId).overrides.length, 0, 'mutating a returned view must not touch the store');
  });

  it('listHolds filters by repo and by activeOnly, newest first', () => {
    const a = hold({ reason: 'a' });
    gate.acknowledgeHold(file, a.holdId, { by: 'x' });
    const b = hold({ reason: 'b' });
    hold({ repo: 'someone-else/other-repo', pr: 1, reason: 'elsewhere' });

    const all = gate.listHolds(file);
    assert.equal(all.length, 3);
    const thisRepo = gate.listHolds(file, { repo: REPO });
    assert.equal(thisRepo.length, 2);
    assert.equal(thisRepo[0].holdId, b.holdId, 'newest first');
    const activeOnly = gate.listHolds(file, { repo: REPO, activeOnly: true });
    assert.deepEqual(activeOnly.map((h2) => h2.holdId), [b.holdId]);
  });

  it('orders by a monotonic sequence, not issuedAt, so two holds issued in the same millisecond still sort deterministically', () => {
    const real = gate._internal.now;
    gate._internal.now = () => '2026-11-05T00:00:00.000Z'; // every hold below gets the IDENTICAL timestamp
    try {
      const a = hold({ reason: 'a' });
      const b = hold({ reason: 'b' });
      assert.equal(a.issuedAt, b.issuedAt, 'the clock seam really did force a tie');
      assert.equal(gate.listHolds(file)[0].holdId, b.holdId, 'the later call still sorts first');
    } finally {
      gate._internal.now = real;
    }
  });

  it('reads an empty list, never throwing, before any hold exists', () => {
    assert.deepEqual(gate.listHolds(file), []);
    assert.deepEqual(gate.matchingHolds(file, { repo: REPO, pr: 1 }), []);
  });
});

describe('durability and the store file itself', () => {
  it('writes valid, re-readable JSON, and leaves no staging file behind', () => {
    hold();
    const raw = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.merge-inbox-gate.') && name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('refuses to write over a store file that exists but is not valid JSON', () => {
    fs.writeFileSync(file, 'not json');
    assert.equal(gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x', issuedBy: 'y' }).code, 'CORRUPT_STORE');
  });

  it('refuses to write over a store file whose JSON is valid but not a holds map', () => {
    fs.writeFileSync(file, JSON.stringify([1, 2, 3]));
    assert.equal(gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x', issuedBy: 'y' }).code, 'CORRUPT_STORE');
    fs.writeFileSync(file, JSON.stringify({ a: { not: 'a hold' } }));
    assert.equal(gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x', issuedBy: 'y' }).code, 'CORRUPT_STORE');
  });

  it('a read accessor treats a corrupt file as empty rather than throwing', () => {
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(gate.listHolds(file), []);
    assert.equal(gate.getHold(file, 'anything'), null);
  });

  it('reads as empty, and every write succeeds, when the file does not exist yet', () => {
    assert.deepEqual(gate.listHolds(file), []);
    assert.equal(gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x', issuedBy: 'y' }).ok, true);
  });

  it('gives up with LOCK_TIMEOUT rather than blocking forever when the lock directory is already held', () => {
    fs.mkdirSync(`${file}.lock`);
    try {
      const result = gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x', issuedBy: 'y' });
      assert.equal(result.code, 'LOCK_TIMEOUT');
    } finally {
      fs.rmSync(`${file}.lock`, { recursive: true, force: true });
    }
  });

  it('breaks a stale lock rather than honouring it forever', () => {
    fs.mkdirSync(`${file}.lock`);
    const old = Date.now() - (gate.LOCK_STALE_MS + 1000);
    fs.utimesSync(`${file}.lock`, old / 1000, old / 1000);
    const result = gate.issueHold(file, { repo: REPO, pr: 1, reason: 'x', issuedBy: 'y' });
    assert.equal(result.ok, true);
  });

  it('keeps every other repo\'s holds intact across an unrelated write', () => {
    hold({ repo: 'a/one', pr: 1 });
    hold({ repo: 'b/two', pr: 1 });
    hold({ repo: 'c/three', pr: 1 });
    assert.equal(gate.listHolds(file).length, 3);
    assert.equal(gate.listHolds(file, { repo: 'a/one' }).length, 1);
    assert.equal(gate.listHolds(file, { repo: 'b/two' }).length, 1);
    assert.equal(gate.listHolds(file, { repo: 'c/three' }).length, 1);
  });
});
