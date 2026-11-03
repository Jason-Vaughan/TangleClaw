'use strict';

// #2031 (ADR 0023 Decision 9a): which projects the operator bridge may reach,
// and how one is named. One resolver answers for the gateway's suggestions,
// the Project Master's route writes and the launch checks, so these tests are
// about that one answer: worked out from the registry each time, scoped to the
// Master's scope, failing closed, and never guessing.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const reach = require('../lib/bridge-reach');
const { bindProject } = require('./_shared-docs-callers');

let tmpDir;
let realDeps;
let scope;
let listening;

/**
 * A project in the registry.
 * @param {string} name - Project name.
 * @returns {object}
 */
function project(name) {
  return store.projects.create({ name, path: path.join(tmpDir, name.replace(/\W+/g, '_')) });
}

/**
 * A live, launch-bound session of a project, with or without a listener the server holds.
 * @param {object} of - Project row.
 * @param {boolean} [heard=true] - Whether the server holds a Medusa listener for it.
 * @returns {number} Session id.
 */
function session(of, heard = true) {
  const { sessionId } = bindProject(of);
  if (heard) listening.add(sessionId);
  return sessionId;
}

const names = () => reach.reachable().projects.map((p) => p.name);

describe('bridge: what may be reached, and how it is named (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-reach-'));
    store._setBasePath(tmpDir);
    store.init();
    realDeps = { ...reach._deps };
    scope = 'all';
    listening = new Set();
    reach._deps.masterScope = () => scope;
    reach._deps.medusa = () => ({ getStatus: (id) => ({ workspaceId: listening.has(id) ? `ws-${id}` : null }) });
  });

  afterEach(() => {
    Object.assign(reach._deps, realDeps);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a slug is the name in lower case with every run of other characters made one dash', () => {
    assert.deepEqual(['TangleClaw Pilot  B3', 'Tilt_v2!', '--Edge--', 'already-a-slug', 'Ünïcode Näme', '   '].map(reach.slugOf),
      ['tangleclaw-pilot-b3', 'tilt-v2', 'edge', 'already-a-slug', 'n-code-n-me', '']);
  });

  it('every project in the registry is reachable the moment it exists, and stops being so the moment it is archived, deleted or opted out', () => {
    assert.deepEqual(names(), []);
    const alpha = project('Alpha');
    assert.deepEqual(names(), ['Alpha'], 'no step connects a project to the bridge');
    const beta = project('Beta');
    const gamma = project('Gamma');
    assert.deepEqual(names(), ['Alpha', 'Beta', 'Gamma']);
    store.projects.archive(alpha.id);
    assert.deepEqual(names(), ['Beta', 'Gamma']);
    assert.equal(bridgeStore.optouts.set(beta.id), true);
    assert.deepEqual(names(), ['Gamma']);
    assert.equal(bridgeStore.optouts.set(beta.id), false, 'opting out twice changes nothing');
    assert.equal(bridgeStore.optouts.remove(beta.id), true);
    assert.deepEqual(names(), ['Beta', 'Gamma'], 'and back within reach at once');
    store.projects.delete(gamma.id);
    assert.deepEqual(names(), ['Beta']);
    assert.deepEqual([reach.outOfReach(store.projects.get(alpha.id)), reach.outOfReach(null), reach.outOfReach(store.projects.get(beta.id))], ['archived', 'unknown', null]);
  });

  it('the Master\'s scope bounds it, and a scope that cannot be resolved reaches nothing', () => {
    const inside = project('Inside');
    const outside = project('Outside');
    const group = store.projectGroups.create({ name: 'Fleet' });
    store.projectGroups.addMember(group.id, inside.id);
    scope = { type: 'group', groupId: group.id };
    assert.deepEqual([names(), reach.scope().kind, reach.scope().groupName], [['Inside'], 'group', 'Fleet']);
    assert.equal(reach.outOfReach(store.projects.get(outside.id)), 'out-of-scope');
    // A project added to the group is reachable at once; one removed is not.
    store.projectGroups.addMember(group.id, outside.id);
    assert.deepEqual(names(), ['Inside', 'Outside']);
    store.projectGroups.removeMember(group.id, inside.id);
    assert.deepEqual(names(), ['Outside']);

    // The group is deleted. The Master's identity text falls back to every project; the bridge does not.
    store.projectGroups.delete(group.id);
    assert.deepEqual([reach.scope(), names()], [{ kind: 'unresolved', cause: 'group-missing' }, []]);
    assert.equal(reach.outOfReach(store.projects.get(inside.id)), 'scope-unresolved');
    assert.deepEqual(reach.destinations(), {
      scope: { kind: 'unresolved', cause: 'group-missing', why: 'it names a project group that no longer exists' }, destinations: [], optedOut: 0
    }, 'said as unresolved, with what is wrong, not as an empty fleet');
    // Every other shape that is not understood, and a scope that cannot be read at all, the same, each with its own cause.
    for (const odd of [{ type: 'group' }, { type: 'team', groupId: 'x' }, 'everything', 42, null, undefined, '']) {
      scope = odd;
      assert.deepEqual([reach.scope(), names()], [{ kind: 'unresolved', cause: 'malformed' }, []], JSON.stringify(odd));
    }
    assert.equal(reach.scopeSummary().why, 'it is not a scope the bridge understands');
    reach._deps.masterScope = () => { throw new Error('config unreadable'); };
    assert.deepEqual([reach.scope(), names(), reach.scopeSummary().why], [{ kind: 'unresolved', cause: 'unreadable' }, [], 'the Master settings could not be read']);
    reach._deps.masterScope = () => 'all';
    assert.deepEqual(names(), ['Inside', 'Outside']);
  });

  it('a name means a destination only when it means exactly one reachable thing', () => {
    const arc = project('TangleClaw Architect');
    const pilot = project('Pilot');
    const one = (token) => reach.named(token);
    assert.deepEqual(one('master'), [{ kind: 'master', projectId: null }]);
    assert.deepEqual(one('MASTER'), [{ kind: 'master', projectId: null }], 'reserved, in any case');
    assert.deepEqual(one('pilot'), [{ kind: 'project', projectId: pilot.id }], 'a name, without regard to case');
    assert.deepEqual(one('tangleclaw-architect'), [{ kind: 'project', projectId: arc.id }], 'a slug');
    assert.deepEqual(one('TangleClaw-Architect'), [{ kind: 'project', projectId: arc.id }]);
    assert.deepEqual(one(String(arc.id)), [{ kind: 'project', projectId: arc.id }], 'an id');
    assert.deepEqual(one('tangleclaw'), [], 'never a prefix');
    assert.deepEqual(one('architect'), [], 'never a part');
    assert.deepEqual(one('999999'), []);

    // A nickname is an overlay on a project id.
    bridgeStore.aliases.set('tc-arc', { kind: 'project', projectId: arc.id });
    assert.deepEqual(one('TC-ARC'), [{ kind: 'project', projectId: arc.id }]);
    // Two reachable projects with one slug: the slug names neither, and their own names still name each.
    const twin = project('tangleclaw_architect');
    assert.deepEqual(one('tangleclaw-architect'), []);
    assert.deepEqual([one('TangleClaw Architect'), one('tangleclaw_architect')], [[{ kind: 'project', projectId: arc.id }], [{ kind: 'project', projectId: twin.id }]]);
    assert.deepEqual(reach.destinations().destinations.map((d) => [d.name, d.slug]), [['Pilot', 'pilot'], ['TangleClaw Architect', null], ['tangleclaw_architect', null]]);
    // A name that is one project's and another's nickname names two things, and so nothing.
    bridgeStore.aliases.set('pilot', { kind: 'project', projectId: arc.id });
    assert.equal(one('pilot').length, 2);
    assert.deepEqual(reach.resolve('pilot'), { refusal: 'ambiguous' });

    // A nickname outlives nothing: its project out of reach, it names nothing, and says why when asked directly.
    store.projects.archive(arc.id);
    assert.deepEqual([one('tc-arc'), one('pilot')], [[], [{ kind: 'project', projectId: pilot.id }]], 'a stale nickname no longer makes the name ambiguous either');
    assert.deepEqual([reach.resolve('tc-arc'), reach.whyUnnamed('tc-arc')], [{ refusal: 'archived' }, 'archived'], 'asked for directly, it says why, the same way the gateway does');
    assert.deepEqual(reach.resolve(arc.id), { refusal: 'archived' });
    assert.deepEqual([reach.resolve('nobody-at-all'), reach.whyUnnamed('nobody-at-all')], [{ refusal: 'unknown' }, null]);

    // What a nickname may be called. Digits alone are a project's id, whether or not a project has that id yet.
    assert.deepEqual(['master', 'set', 'rename', 'forget'].map((k) => reach.nicknameClash(k)), ['reserved', 'reserved', 'reserved', 'reserved']);
    assert.deepEqual([String(pilot.id), '987654321', '0'].map((k) => reach.nicknameClash(k)), ['collides', 'collides', 'collides']);
    assert.deepEqual([reach.nicknameClash('pilot'), reach.nicknameClash('free-name'), reach.nicknameClash('tc-arc'), reach.nicknameClash('tc-arc', 'tc-arc')], ['exists', null, 'exists', null]);
    bridgeStore.aliases.remove('pilot');
    assert.deepEqual([reach.nicknameClash('pilot'), reach.nicknameClash('PILOT'.toLowerCase())], ['collides', 'collides'], 'a reachable project\'s name');
  });

  it('what the Master names in a write is resolved by the same rule, and a refusal says why', () => {
    const alpha = project('Alpha One');
    const beta = project('Beta');
    assert.deepEqual(reach.resolve('master'), { destination: { kind: 'master', projectId: null, label: 'Project Master' } });
    for (const to of [alpha.id, 'Alpha One', 'alpha one', 'alpha-one']) {
      assert.deepEqual(reach.resolve(to), { destination: { kind: 'project', projectId: alpha.id, label: 'Alpha One' } }, JSON.stringify(to));
    }
    for (const to of ['', null, undefined, {}, 1.5, 'No Such', 987654]) assert.deepEqual(reach.resolve(to), { refusal: 'unknown' }, JSON.stringify(to));
    bridgeStore.optouts.set(beta.id);
    assert.deepEqual([reach.resolve('Beta'), reach.resolve(beta.id)], [{ refusal: 'opted-out' }, { refusal: 'opted-out' }]);
    const group = store.projectGroups.create({ name: 'Fleet' });
    scope = { type: 'group', groupId: group.id };
    assert.deepEqual([reach.resolve('Alpha One'), reach.resolve(alpha.id)], [{ refusal: 'out-of-scope' }, { refusal: 'out-of-scope' }]);
    assert.deepEqual(reach.resolve('master'), { destination: { kind: 'master', projectId: null, label: 'Project Master' } }, 'the Master itself is always reachable');
    store.projectGroups.delete(group.id);
    assert.deepEqual(reach.resolve(alpha.id), { refusal: 'scope-unresolved' });
  });

  it('how a project stands is read from the sessions and listeners the server holds, and two live sessions are never one', () => {
    const p = project('Alpha');
    assert.deepEqual(reach.liveness(p.id), { state: 'not-running', sessions: 0, listening: [] });
    const deaf = session(p, false);
    assert.deepEqual(reach.liveness(p.id), { state: 'unreachable', sessions: 1, listening: [] });
    listening.add(deaf);
    assert.deepEqual(reach.liveness(p.id), { state: 'live', sessions: 1, listening: [deaf] });
    const second = session(p);
    assert.deepEqual([reach.liveness(p.id).state, reach.liveness(p.id).listening.sort()], ['several-live', [deaf, second].sort()]);
    // One of two with a listener is one live session, whichever was started last, and it is the one named.
    listening.delete(second);
    assert.deepEqual([reach.liveness(p.id).state, reach.liveness(p.id).listening], ['live', [deaf]]);
    // A listener is not enough: a session with no launch record can be sent nothing, since no reply to it could be proven.
    const realHasLaunch = reach._deps.hasLaunch;
    reach._deps.hasLaunch = () => false;
    assert.deepEqual(reach.liveness(p.id), { state: 'unreachable', sessions: 2, listening: [] });
    reach._deps.hasLaunch = realHasLaunch;
    store.sessions.kill(deaf, 'ended');
    assert.equal(reach.liveness(p.id).state, 'unreachable');
    assert.deepEqual(reach.destinations().destinations, [{ projectId: p.id, name: 'Alpha', slug: 'alpha', nicknames: [], live: 'unreachable' }]);
  });

  it('nothing is remembered between two askings', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bridge-reach.js'), 'utf8');
    assert.ok(!/\bnew Map\(\)\s*;?\s*$|^(const|let) \w+ = (new Map|new Set|\[\]|\{\})/m.test(src.replace(/function [\s\S]*/, '')), 'no module-level store of projects');
    const a = project('Alpha');
    const first = reach.destinations();
    project('Beta');
    store.projects.archive(a.id);
    assert.deepEqual(reach.destinations().destinations.map((d) => d.name), ['Beta'], 'the second answer owes nothing to the first');
    assert.deepEqual(first.destinations.map((d) => d.name), ['Alpha']);
  });
});

describe('bridge-reach: group-scoped defaults and batch opt-out (#2117, Ruling A2117)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-reach-2117-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('defaultActivationScope', () => {
    it('defaults to "all" with no groups', () => {
      assert.deepEqual(reach.defaultActivationScope([]), { type: 'all' });
    });

    it('prefers a group whose name suggests the fleet, among several', () => {
      const other = store.projectGroups.create({ name: 'Backend services' });
      const fleet = store.projectGroups.create({ name: 'TangleClaw Fleet' });
      const r = reach.defaultActivationScope([other, fleet]);
      assert.deepEqual(r, { type: 'group', groupId: fleet.id, groupName: fleet.name });
    });

    it('matches "fleet" case-insensitively with no "tangleclaw" in the name', () => {
      const group = store.projectGroups.create({ name: 'my fleet' });
      const r = reach.defaultActivationScope([group]);
      assert.deepEqual(r, { type: 'group', groupId: group.id, groupName: group.name });
    });

    it('defaults to the one group when exactly one exists and none looks fleet-like', () => {
      const group = store.projectGroups.create({ name: 'Backend services' });
      const r = reach.defaultActivationScope([group]);
      assert.deepEqual(r, { type: 'group', groupId: group.id, groupName: group.name });
    });

    it('falls back to "all" rather than guessing among several non-fleet-like groups', () => {
      const a = store.projectGroups.create({ name: 'Backend services' });
      const b = store.projectGroups.create({ name: 'Frontend services' });
      assert.deepEqual(reach.defaultActivationScope([a, b]), { type: 'all' });
    });
  });

  describe('needsGroupNarrowingPrompt', () => {
    it('never prompts when the current scope is already a group', () => {
      const group = store.projectGroups.create({ name: 'TangleClaw Fleet' });
      const r = reach.needsGroupNarrowingPrompt({ kind: 'group', groupId: group.id, groupName: group.name }, [group]);
      assert.deepEqual(r, { shouldPrompt: false });
    });

    it('never prompts when scoped to "all" but no groups exist', () => {
      assert.deepEqual(reach.needsGroupNarrowingPrompt({ kind: 'all' }, []), { shouldPrompt: false });
    });

    it('prompts, with a suggestion, when scoped to "all" and a group exists', () => {
      const group = store.projectGroups.create({ name: 'TangleClaw Fleet' });
      const r = reach.needsGroupNarrowingPrompt({ kind: 'all' }, [group]);
      assert.equal(r.shouldPrompt, true);
      assert.deepEqual(r.suggested, { type: 'group', groupId: group.id, groupName: group.name });
    });

    it('never prompts when the scope is unresolved -- only "all" is narrowed', () => {
      const group = store.projectGroups.create({ name: 'TangleClaw Fleet' });
      assert.deepEqual(reach.needsGroupNarrowingPrompt({ kind: 'unresolved', cause: 'malformed' }, [group]), { shouldPrompt: false });
    });

    it('never writes anything -- the scope the module reports is unchanged after asking', () => {
      const group = store.projectGroups.create({ name: 'TangleClaw Fleet' });
      scope = 'all';
      reach._deps.masterScope = () => scope;
      reach.needsGroupNarrowingPrompt(reach.scope(), [group]);
      assert.deepEqual(reach.scope(), { kind: 'all' });
    });
  });

  describe('setProjectsOutOfReachBatch', () => {
    it('opts a batch of projects out in one call, and reports what changed', () => {
      const a = project('Alpha');
      const b = project('Beta');
      const r = reach.setProjectsOutOfReachBatch([a.id, b.id], true);
      assert.equal(r.updated, 2);
      assert.deepEqual(r.reachableIds, []);
      assert.deepEqual(r.outOfReachIds.sort(), [a.id, b.id].sort());
      assert.equal(bridgeStore.optouts.has(a.id), true);
      assert.equal(bridgeStore.optouts.has(b.id), true);
    });

    it('restores a batch back within reach, and reports what changed', () => {
      const a = project('Alpha');
      const b = project('Beta');
      reach.setProjectsOutOfReachBatch([a.id, b.id], true);
      const r = reach.setProjectsOutOfReachBatch([a.id, b.id], false);
      assert.equal(r.updated, 2);
      assert.deepEqual(r.outOfReachIds, []);
      assert.deepEqual(r.reachableIds.sort(), [a.id, b.id].sort());
    });

    it('reports only what actually changed -- an already-opted-out project does not re-count', () => {
      const a = project('Alpha');
      reach.setProjectsOutOfReachBatch([a.id], true);
      const r = reach.setProjectsOutOfReachBatch([a.id], true);
      assert.equal(r.updated, 0);
      assert.deepEqual(r.outOfReachIds, [a.id]);
    });

    it('deduplicates repeated ids in one call', () => {
      const a = project('Alpha');
      const r = reach.setProjectsOutOfReachBatch([a.id, a.id, a.id], true);
      assert.equal(r.updated, 1);
      assert.deepEqual(r.outOfReachIds, [a.id]);
    });

    it('is atomic: a mix of valid and already-settled ids still succeeds as one call', () => {
      const a = project('Alpha');
      const b = project('Beta');
      reach.setProjectsOutOfReachBatch([a.id], true);
      const r = reach.setProjectsOutOfReachBatch([a.id, b.id], true);
      assert.equal(r.updated, 1, 'only Beta actually changed');
      assert.deepEqual(r.outOfReachIds.sort(), [a.id, b.id].sort());
    });

    it('throws on a non-array, empty, or non-positive-integer projectIds', () => {
      assert.throws(() => reach.setProjectsOutOfReachBatch('nope', true), TypeError);
      assert.throws(() => reach.setProjectsOutOfReachBatch([], true), TypeError);
      assert.throws(() => reach.setProjectsOutOfReachBatch([0], true), TypeError);
      assert.throws(() => reach.setProjectsOutOfReachBatch([1.5], true), TypeError);
      assert.throws(() => reach.setProjectsOutOfReachBatch([-1], true), TypeError);
    });

    it('throws on a non-boolean outOfReach', () => {
      const a = project('Alpha');
      assert.throws(() => reach.setProjectsOutOfReachBatch([a.id], 'yes'), TypeError);
    });
  });
});
