'use strict';

/*
 * #1678 / #993 — one fleet view of the checkouts.
 *
 * Who sees which rows (D11 as ruled, D18), and which fields reach them (D17):
 * the operator and the Master see every live project, a bound project sees
 * itself and its project groups' members, an unbound caller sees none and is
 * told why. The block is an allowlist, names outside the caller's view are
 * withheld from the fields and from the words, and no row carries a path.
 * `projectCheckout` is stubbed; the store is a throwaway one.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const fleet = require('../lib/checkout-fleet');
const { KINDS } = require('../lib/shared-docs-access');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * A full checkout block of the shape `projectCheckout` returns, with fields a
 * fleet reader must never see mixed in.
 * @param {object} project - Store row.
 * @param {object} [over] - Field overrides.
 * @returns {object}
 */
function blockFor(project, over = {}) {
  return {
    state: 'measured', reason: null, measuredAt: '2026-09-22T00:00:00.000Z',
    branch: 'main', detached: false, tag: null, onDefaultBranch: true, headSha: SHA_A,
    unpushed: { count: 0, against: 'origin/main' }, dirtyTracked: 0, untracked: 1,
    repository: { identity: 'github.com/O/R', reason: null },
    incomplete: [],
    localRef: { ref: 'origin/main', sha: SHA_A, ahead: 0, behind: 0, relation: 'equal', incomplete: [] },
    upstream: {
      identity: 'github.com/O/R', via: 'origin', state: 'measured', sha: SHA_B,
      observedAt: '2026-09-22T00:00:00.000Z', reason: null, observedFrom: 'hidden-observer', lastKnown: { sha: SHA_B, observedAt: 'x' }
    },
    vsUpstream: { ahead: 0, behind: 1, relation: 'behind', reason: null },
    owner: { project: project.name, sessionId: 1 },
    runtime: null,
    summary: ['stale words'],
    workspacePath: project.path,
    somethingAddedLater: 'secret',
    ...over
  };
}

describe('checkout-fleet', () => {
  let tmp;
  let saved;
  let seq = 0;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-checkout-fleet-'));
    store._setBasePath(tmp);
    store.init();
    saved = fleet._internal.projectCheckout;
  });

  after(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Every live session from an earlier test ends, so each test's fleet is its own.
    for (const s of store.sessions.listLiveAll()) store.sessions.kill(s.id, 'test isolation');
    fleet._internal.projectCheckout = (project) => blockFor(project);
  });

  afterEach(() => {
    fleet._internal.projectCheckout = saved;
  });

  /**
   * A registered project, optionally with a live session.
   * @param {string} label
   * @param {boolean} [live=true]
   * @returns {object} Store row.
   */
  function project(label, live = true) {
    seq += 1;
    const p = store.projects.create({ name: `${label}-${seq}`, path: `/Users/someone/clones/${label}-${seq}` });
    if (live) store.sessions.start({ projectId: p.id, engineId: 'claude' });
    return p;
  }

  /**
   * A project group of the given members.
   * @param {object[]} members
   * @returns {object}
   */
  function group(members) {
    seq += 1;
    const g = store.projectGroups.create({ name: `grp-${seq}` });
    for (const m of members) store.projectGroups.addMember(g.id, m.id);
    return g;
  }

  /**
   * A bound project caller, as the resolver answers one.
   * @param {object} p - Store row.
   * @returns {object}
   */
  function bound(p) {
    return { kind: KINDS.PROJECT, projectId: p.id, groupIds: store.projectGroups.getByProject(p.id).map((g) => g.id), reason: null };
  }

  const OPERATOR = { kind: KINDS.OPERATOR, projectId: null, groupIds: [], reason: null };
  const MASTER = { kind: KINDS.MASTER, projectId: null, groupIds: [], reason: null };

  it('the operator and the Master see one row per live project, and none for an idle one', () => {
    const a = project('fleet-a');
    const b = project('fleet-b');
    store.sessions.start({ projectId: a.id, engineId: 'claude' }); // a second live session is still one row
    const idle = project('fleet-idle', false);
    for (const access of [OPERATOR, MASTER]) {
      const view = fleet.fleetView(access);
      assert.equal(view.scope, 'fleet');
      assert.equal(view.reason, null);
      const names = view.rows.map((r) => r.project.name);
      assert.deepEqual(names, [a.name, b.name]);
      assert.ok(!names.includes(idle.name), 'an idle project is not measured');
    }
  });

  it('the row names the newest live session of its project', () => {
    const a = project('newest');
    const newer = store.sessions.start({ projectId: a.id, engineId: 'claude' });
    const [row] = fleet.fleetView(OPERATOR).rows;
    assert.equal(row.sessionId, newer.id);
  });

  it('a bound project sees itself and its project groups\' members, nothing else', () => {
    const me = project('me');
    const peer = project('peer');
    const stranger = project('stranger');
    group([me, peer]);
    group([stranger]);
    const view = fleet.fleetView(bound(me));
    assert.equal(view.scope, 'related');
    assert.deepEqual(view.rows.map((r) => r.project.name).sort(), [me.name, peer.name].sort());
    assert.ok(!JSON.stringify(view).includes(stranger.name), 'an unrelated project is not named anywhere');
  });

  it('a bound project in no group sees only itself', () => {
    const alone = project('alone');
    project('other');
    assert.deepEqual(fleet.fleetView(bound(alone)).rows.map((r) => r.project.name), [alone.name]);
  });

  it('an unbound caller sees no rows and is told why', () => {
    project('any');
    const view = fleet.fleetView({ kind: KINDS.UNBOUND, projectId: null, groupIds: [], reason: null });
    assert.equal(view.scope, 'none');
    assert.deepEqual(view.rows, []);
    assert.match(view.reason, /no launch binding/);
  });

  it('carries only allowlisted fields, and no path anywhere', () => {
    const a = project('allow');
    const [row] = fleet.fleetView(OPERATOR).rows;
    assert.equal('workspacePath' in row.checkout, false);
    assert.equal('somethingAddedLater' in row.checkout, false);
    assert.deepEqual(Object.keys(row), ['project', 'sessionId', 'checkout']);
    assert.deepEqual(Object.keys(row.project), ['id', 'name']);
    const text = JSON.stringify(row);
    assert.ok(!text.includes(a.path) && !text.includes('/Users/'), 'no workspace path in the row');
    assert.deepEqual(row.checkout.upstream.lastKnown, { sha: SHA_B, observedAt: 'x' });
  });

  it('re-renders the summary from the shaped block', () => {
    project('words');
    const [row] = fleet.fleetView(OPERATOR).rows;
    assert.notDeepEqual(row.checkout.summary, ['stale words']);
    assert.match(row.checkout.summary[0], /main @aaaaaaa, 1 behind origin\/main @bbbbbbb/);
  });

  it('withholds an observer and a group a project caller cannot see, from the fields and the words', () => {
    const me = project('viewer');
    const unseenGroup = group([project('elsewhere', false)]);
    fleet._internal.projectCheckout = (p) => blockFor(p, {
      state: 'no-git', branch: null, headSha: null,
      upstream: { identity: 'github.com/O/R', via: 'group', groupName: unseenGroup.name, state: 'measured', sha: SHA_B, observedAt: '2026-09-22T00:00:00.000Z', reason: null, observedFrom: 'hidden-observer', lastKnown: null },
      vsUpstream: { ahead: null, behind: null, relation: 'not-compared', reason: 'related repo, no checkout comparison' }
    });
    const [row] = fleet.fleetView(bound(me)).rows;
    assert.equal(row.checkout.upstream.observedFrom, null);
    assert.equal(row.checkout.upstream.groupName, null);
    const words = row.checkout.summary.join(' ');
    assert.ok(!words.includes('hidden-observer') && !words.includes(unseenGroup.name), words);
    assert.match(words, /via a project group/);

    const [asOperator] = fleet.fleetView(OPERATOR).rows;
    assert.equal(asOperator.checkout.upstream.observedFrom, 'hidden-observer', 'the operator sees who observed it');
    assert.equal(asOperator.checkout.upstream.groupName, unseenGroup.name);
  });

  it('keeps an observer and a group the project caller already sees', () => {
    const me = project('keeper');
    const peer = project('observer-peer');
    const g = group([me, peer]);
    fleet._internal.projectCheckout = (p) => blockFor(p, { upstream: { ...blockFor(p).upstream, observedFrom: peer.name, groupName: g.name } });
    const row = fleet.fleetView(bound(me)).rows.find((r) => r.project.name === me.name);
    assert.equal(row.checkout.upstream.observedFrom, peer.name);
    assert.equal(row.checkout.upstream.groupName, g.name);
  });

  it('reduces the runtime restart impact to its verdict', () => {
    project('runtime');
    fleet._internal.projectCheckout = (p) => blockFor(p, {
      runtime: { startupSha: SHA_A, currentDiskSha: SHA_B, isStale: true, restartImpact: { impact: 'records-only', executablePaths: [], recordsPaths: ['docs/x.md'], fromSha: SHA_A, toSha: SHA_B } }
    });
    const [row] = fleet.fleetView(OPERATOR).rows;
    assert.deepEqual(row.checkout.runtime, { startupSha: SHA_A, currentDiskSha: SHA_B, isStale: true, restartImpact: { impact: 'records-only' } });
    assert.ok(row.checkout.summary.some((l) => /records-only, no restart needed/.test(l)));
  });
});
