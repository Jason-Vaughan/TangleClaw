'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { KINDS } = require('../lib/shared-docs-access');
const view = require('../lib/project-view');

/** An enriched project row with every workspace field set. */
function row(overrides = {}) {
  return {
    id: 7,
    name: 'alpha',
    path: '/Users/someone/Projects/alpha',
    engine: { id: 'claude', name: 'Claude Code', command: 'claude', capabilities: { x: 1 } },
    tags: ['a'],
    archived: false,
    registered: true,
    groups: [{ id: 'g1', name: 'secret group', docCount: 2 }],
    git: { branch: 'main', dirty: true, headSha: 'abc' },
    ports: { dev: 3200 },
    session: { active: true, status: 'active', startedAt: '2026-09-22', tmuxSession: 'alpha', lastEngineError: { message: 'x' } },
    sessionHealth: { newPaths: ['secret.txt'] },
    futureField: 'added later',
    ...overrides
  };
}

const operator = { kind: KINDS.OPERATOR, projectId: null };
const master = { kind: KINDS.MASTER, projectId: null };
const owner = { kind: KINDS.PROJECT, projectId: 7 };
const stranger = { kind: KINDS.PROJECT, projectId: 8 };
const unbound = { kind: KINDS.UNBOUND, projectId: null };
const invalid = { kind: KINDS.INVALID, projectId: null };

describe('project-view', () => {
  it('gives the operator, the Master and the owning project the row itself', () => {
    const r = row();
    assert.equal(view.shapeProject(operator, r), r);
    assert.equal(view.shapeProject(master, r), r);
    assert.equal(view.shapeProject(owner, r), r);
  });

  for (const [label, access] of [['another project', stranger], ['an unbound caller', unbound], ['an invalid binding', invalid]]) {
    it(`gives ${label} only the allowlisted fields`, () => {
      const shaped = view.shapeProject(access, row());
      assert.deepEqual(shaped, {
        id: 7,
        name: 'alpha',
        registered: true,
        archived: false,
        tags: ['a'],
        engine: { id: 'claude', name: 'Claude Code' },
        session: { active: true, status: 'active', startedAt: '2026-09-22' },
        restricted: true
      });
    });
  }

  it('withholds a field added to the row later, because the projection is an allowlist', () => {
    assert.equal('futureField' in view.shapeProject(unbound, row()), false);
  });

  it('does not treat an unregistered directory (no id) as owned by a bound caller', () => {
    const dir = row({ id: undefined, registered: false });
    const shaped = view.shapeProject({ kind: KINDS.PROJECT, projectId: undefined }, dir);
    assert.equal(shaped.restricted, true);
    assert.equal(shaped.id, null);
    assert.equal(shaped.registered, false);
  });

  it('keeps a null engine and session null', () => {
    const shaped = view.shapeProject(unbound, row({ engine: null, session: null }));
    assert.equal(shaped.engine, null);
    assert.equal(shaped.session, null);
  });

  it('returns a copy of the tags, not the row\'s own array', () => {
    const r = row();
    const shaped = view.shapeProject(unbound, r);
    shaped.tags.push('mutated');
    assert.deepEqual(r.tags, ['a']);
  });

  describe('shapeScan', () => {
    const scan = { dir: '/Users/someone/Projects', complete: false, code: 'EACCES', reason: 'denied', hint: 'grant FDA to /Users/someone', listed: 3 };

    it('gives the operator and the Master the whole scan block', () => {
      assert.equal(view.shapeScan(operator, scan), scan);
      assert.equal(view.shapeScan(master, scan), scan);
    });

    it('gives every other caller whether the list is whole, without the directory', () => {
      for (const access of [owner, stranger, unbound, invalid]) {
        assert.deepEqual(view.shapeScan(access, scan), { complete: false, code: 'EACCES', listed: 3 });
      }
    });

    it('passes a missing scan block through', () => {
      assert.equal(view.shapeScan(unbound, null), null);
    });
  });
});
