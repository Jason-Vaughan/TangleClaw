'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const drift = require('../lib/launch-rule-drift');

/**
 * A manifest with explicit sources, as car 21.10 and later wraps write them.
 * @param {object[]} rules - Fingerprints
 * @param {string[]} [sources] - Recorded sources
 * @returns {object} The manifest
 */
function manifest(rules, sources = ['project', 'global', 'shared']) {
  return { rules, manifestSources: sources };
}

/**
 * One fingerprint.
 * @param {string} source - project | global | shared
 * @param {string|number} id - Rule id
 * @param {string} hash - Content hash
 * @param {number|null} [revision] - Version number
 * @returns {object} The fingerprint
 */
function fp(source, id, hash, revision = 1) {
  return { id, source, revision, contentHash: hash };
}

test('recordedSources reads a legacy document WITH ROWS as project-only', () => {
  // No `manifestSources` means a pre-21.10 wrap, which looked at project rules
  // and nothing else regardless of what its rows claim — but only its ROWS are
  // evidence it looked. An empty legacy array is the ambiguous case and is
  // covered by its own test below.
  assert.deepStrictEqual(
    drift.recordedSources({ rules: [{ id: 1, source: 'project', contentHash: 'a' }] }),
    ['project']
  );
  assert.deepStrictEqual(drift.recordedSources({ rules: [] }), []);
  assert.deepStrictEqual(drift.recordedSources(null), []);
  assert.deepStrictEqual(
    drift.recordedSources(manifest([], ['project', 'shared'])),
    ['project', 'shared']
  );
});

test('an added rule is reported as added, and only in a recorded source', () => {
  const before = manifest([fp('project', 1, 'a')]);
  const after = manifest([fp('project', 1, 'a'), fp('project', 2, 'b')]);
  const d = drift.diffRuleManifests(before, after);
  assert.strictEqual(d.hasDrift, true);
  assert.deepStrictEqual(d.added.map((r) => r.id), [2]);
  assert.deepStrictEqual(d.removed, []);
  assert.deepStrictEqual(d.changed, []);
  assert.strictEqual(d.perSource.project, 'changed');
});

test('a removed rule is reported as removed', () => {
  const before = manifest([fp('project', 1, 'a'), fp('project', 2, 'b')]);
  const after = manifest([fp('project', 1, 'a')]);
  const d = drift.diffRuleManifests(before, after);
  assert.deepStrictEqual(d.removed.map((r) => r.id), [2]);
  assert.strictEqual(d.hasDrift, true);
});

test('a changed body is one change, never an add plus a remove', () => {
  const before = manifest([fp('project', 1, 'a', 3)]);
  const after = manifest([fp('project', 1, 'a2', 4)]);
  const d = drift.diffRuleManifests(before, after);
  assert.deepStrictEqual(d.added, []);
  assert.deepStrictEqual(d.removed, []);
  assert.strictEqual(d.changed.length, 1);
  assert.strictEqual(d.changed[0].fromRevision, 3);
  assert.strictEqual(d.changed[0].toRevision, 4);
});

test('a revision that moved with no content change is NOT drift', () => {
  // The body is what the previous session read. A no-op version bump changes
  // nothing it was governed by, so demanding a reconciliation for it would
  // train the agent to write past a requirement that means nothing.
  const before = manifest([fp('project', 1, 'same', 3)]);
  const after = manifest([fp('project', 1, 'same', 9)]);
  const d = drift.diffRuleManifests(before, after);
  assert.strictEqual(d.hasDrift, false);
  assert.strictEqual(d.perSource.project, 'unchanged');
});

test('the global rule set drifts at set granularity', () => {
  const before = manifest([fp('global', 'global', 'g1')]);
  const after = manifest([fp('global', 'global', 'g2')]);
  const d = drift.diffRuleManifests(before, after);
  assert.strictEqual(d.perSource.global, 'changed');
  assert.strictEqual(d.hasDrift, true);
});

test('a shared document change is named per document', () => {
  const before = manifest([fp('shared', 4, 'h1'), fp('shared', 5, 'h2')]);
  const after = manifest([fp('shared', 4, 'h1'), fp('shared', 5, 'CHANGED')]);
  const d = drift.diffRuleManifests(before, after);
  assert.deepStrictEqual(d.changed.map((r) => r.id), [5]);
  assert.strictEqual(d.perSource.shared, 'changed');
});

test('a source the handoff never recorded reads not-recorded, never unchanged', () => {
  // The whole point of the module: a pre-21.10 handoff holds no evidence about
  // shared docs, and saying "unchanged" would state a fact nobody measured.
  const before = { rules: [fp('project', 1, 'a')] }; // legacy: no manifestSources
  const after = manifest([fp('project', 1, 'a'), fp('shared', 4, 'h1'), fp('global', 'global', 'g1')]);
  const d = drift.diffRuleManifests(before, after);
  assert.strictEqual(d.perSource.shared, 'not-recorded');
  assert.strictEqual(d.perSource.global, 'not-recorded');
  assert.strictEqual(d.perSource.project, 'unchanged');
});

test('an unrecorded source never contributes drift, so it never gates READY', () => {
  const before = { rules: [fp('project', 1, 'a')] };
  const after = manifest([fp('project', 1, 'a'), fp('shared', 4, 'brand-new')]);
  const d = drift.diffRuleManifests(before, after);
  // The shared doc is not reported as "added" — nothing said it was absent before.
  assert.deepStrictEqual(d.added, []);
  assert.strictEqual(d.hasDrift, false);
});

test('a project with zero shared docs reads unchanged, not not-recorded', () => {
  // The case `manifestSources` exists to separate from the one above.
  const before = manifest([fp('project', 1, 'a')]);
  const after = manifest([fp('project', 1, 'a')]);
  const d = drift.diffRuleManifests(before, after);
  assert.strictEqual(d.perSource.shared, 'unchanged');
  assert.strictEqual(d.hasDrift, false);
});

test('no manifest at all is recorded:false and gates nothing', () => {
  const d = drift.diffRuleManifests(null, manifest([fp('project', 1, 'a')]));
  assert.strictEqual(d.recorded, false);
  assert.strictEqual(d.hasDrift, false);
  assert.deepStrictEqual(d.comparedSources, []);
  for (const source of drift.SOURCES) assert.strictEqual(d.perSource[source], 'not-recorded');
});

test('rows are ordered by source then id, so step 3 renders the same every launch', () => {
  const before = manifest([fp('shared', 9, 'x'), fp('project', 2, 'y')]);
  const after = manifest([]);
  const d = drift.diffRuleManifests(before, after);
  assert.deepStrictEqual(d.removed.map((r) => r.source), ['project', 'shared']);
});

test('an unknown source on a row is read as project rather than dropped', () => {
  const before = manifest([{ id: 1, source: 'wat', revision: 1, contentHash: 'a' }]);
  const after = manifest([{ id: 1, source: 'wat', revision: 1, contentHash: 'b' }]);
  const d = drift.diffRuleManifests(before, after);
  assert.strictEqual(d.changed.length, 1);
  assert.strictEqual(d.changed[0].source, 'project');
});

test('driftSummary names what moved, and is null without drift', () => {
  assert.strictEqual(drift.driftSummary({ hasDrift: false }), null);
  const d = drift.diffRuleManifests(
    manifest([fp('project', 1, 'a')]),
    manifest([fp('project', 1, 'b')])
  );
  const summary = drift.driftSummary(d);
  assert.match(summary, /1 changed/);
  assert.match(summary, /project rule 1/);
});

test('an unreadable file on BOTH sides is never "unchanged"', () => {
  // `_fileHash` answers null for a file it could not read. Two nulls compare
  // equal, so an unreadable shared document used to satisfy the unchanged
  // branch — a measurement nobody took, reported as a measurement.
  const before = manifest([{ id: 4, source: 'shared', revision: null, contentHash: null, measured: false }]);
  const after = manifest([{ id: 4, source: 'shared', revision: null, contentHash: null, measured: false }]);
  const d = drift.diffRuleManifests(before, after);
  assert.notStrictEqual(d.perSource.shared, drift.SOURCE_STATES.UNCHANGED);
  assert.ok(d.unmeasured.before.includes('shared') && d.unmeasured.after.includes('shared'));
  assert.strictEqual(d.hasDrift, false);
});

test('a measured change in a partly-unreadable source is still reported and still gates', () => {
  // This test previously asserted the DEFECT: it demanded hasDrift be false
  // while doc 4 demonstrably moved h1 -> CHANGED. Dropping a measured change
  // because a SIBLING row was unreadable loses the one fact the agent most
  // needs, and it silently fails open at the READY gate.
  const before = manifest([
    { id: 4, source: 'shared', revision: null, contentHash: 'h1' },
    { id: 5, source: 'shared', revision: null, contentHash: null, measured: false }
  ]);
  const after = manifest([
    { id: 4, source: 'shared', revision: null, contentHash: 'CHANGED' },
    { id: 5, source: 'shared', revision: null, contentHash: null, measured: false }
  ]);
  const d = drift.diffRuleManifests(before, after);
  assert.deepStrictEqual(d.changed.map((r) => r.id), [4]);
  assert.strictEqual(d.hasDrift, true, 'a measured change must gate even beside an unreadable row');
  // A measured change outranks the partial read in the verdict, and the gap is
  // still reported separately so "nothing else changed" is never implied.
  assert.strictEqual(d.perSource.shared, drift.SOURCE_STATES.CHANGED);
  assert.ok(d.unmeasured.before.includes('shared'));
  assert.ok(d.unmeasured.after.includes('shared'));
});

test('an unmeasured row is never compared against a measured one', () => {
  const before = manifest([{ id: 4, source: 'shared', revision: null, contentHash: 'h1' }]);
  const after = manifest([{ id: 4, source: 'shared', revision: null, contentHash: null, measured: false }]);
  const d = drift.diffRuleManifests(before, after);
  // It cannot be called changed (nobody measured the new value) and it cannot
  // be called unchanged. It is a gap, reported as one.
  assert.deepStrictEqual(d.changed, []);
  assert.strictEqual(d.hasDrift, false);
  assert.strictEqual(d.perSource.shared, drift.SOURCE_STATES.UNREADABLE_NOW);
});

test('WHICH side failed to measure is carried, not collapsed', () => {
  // The renderer sends the reader to a different machine for each, so a single
  // "something was unmeasured" answer makes one of the two messages false.
  const atWrap = drift.diffRuleManifests(
    manifest([{ id: 4, source: 'shared', revision: null, contentHash: null, measured: false }]),
    manifest([{ id: 4, source: 'shared', revision: null, contentHash: 'h1' }])
  );
  assert.strictEqual(atWrap.perSource.shared, drift.SOURCE_STATES.UNREADABLE_AT_WRAP);
  assert.deepStrictEqual(atWrap.unmeasured.before, ['shared']);
  assert.deepStrictEqual(atWrap.unmeasured.after, []);

  const atLaunch = drift.diffRuleManifests(
    manifest([{ id: 4, source: 'shared', revision: null, contentHash: 'h1' }]),
    manifest([{ id: 4, source: 'shared', revision: null, contentHash: null, measured: false }])
  );
  assert.strictEqual(atLaunch.perSource.shared, drift.SOURCE_STATES.UNREADABLE_NOW);
  assert.deepStrictEqual(atLaunch.unmeasured.after, ['shared']);
  assert.deepStrictEqual(atLaunch.unmeasured.before, []);
});

test('a legacy handoff with no rows claims nothing, rather than inventing drift', () => {
  // The pre-21.10 producer returned `[]` for a project with no rules AND for a
  // rules read that threw. Reading that as "recorded: project" makes every
  // rule in force now report as ADDED and refuses READY forever.
  assert.deepStrictEqual(drift.recordedSources({ rules: [] }), []);
  const d = drift.diffRuleManifests(
    { rules: [] },
    manifest([{ id: 1, source: 'project', revision: 1, contentHash: 'a' }])
  );
  assert.deepStrictEqual(d.added, []);
  assert.strictEqual(d.hasDrift, false);
  assert.strictEqual(d.perSource.project, drift.SOURCE_STATES.NOT_RECORDED);
});

test('a source THIS launch could not read is `unreadable`, not `not-recorded`', () => {
  // Opposite silences. `not-recorded` sends the operator to the previous
  // session; `unreadable` sends them to this machine.
  const before = manifest([
    { id: 1, source: 'project', revision: 1, contentHash: 'a' },
    { id: 'global', source: 'global', revision: null, contentHash: 'g' }
  ], ['project', 'global']);
  const after = manifest([{ id: 1, source: 'project', revision: 1, contentHash: 'a' }], ['project']);
  const d = drift.diffRuleManifests(before, after);
  assert.strictEqual(d.perSource.global, drift.SOURCE_STATES.UNREADABLE_NOW);
  // shared was recorded by neither side, so it keeps the other verdict.
  assert.strictEqual(d.perSource.shared, 'not-recorded');
});

test('a measured hash is still required to be a non-empty string', () => {
  const before = manifest([{ id: 1, source: 'project', revision: 1, contentHash: '' }]);
  const after = manifest([{ id: 1, source: 'project', revision: 1, contentHash: '' }]);
  const d = drift.diffRuleManifests(before, after);
  // Both sides are unmeasured here, and the wrap side is reported first
  // because it is the one the reader can do nothing about locally.
  assert.strictEqual(d.perSource.project, drift.SOURCE_STATES.UNREADABLE_AT_WRAP);
  assert.ok(d.unmeasured.before.includes('project') && d.unmeasured.after.includes('project'));
  assert.strictEqual(d.hasDrift, false);
});

test('a MEASURED empty source compares zero-to-zero unchanged', () => {
  // The Architect's amendment: a manifest that explicitly declares `shared` and
  // carries no shared rows has measured zero. That is a fact, not a gap, and it
  // must not be confused with the pre-21.10 producer's ambiguous empty array.
  const before = manifest([], ['project', 'global', 'shared']);
  const after = manifest([], ['project', 'global', 'shared']);
  const d = drift.diffRuleManifests(before, after);
  assert.strictEqual(d.perSource.shared, drift.SOURCE_STATES.UNCHANGED);
  assert.strictEqual(d.hasDrift, false);
});

test('a MEASURED empty source compares zero-to-one as added', () => {
  const before = manifest([], ['project', 'global', 'shared']);
  const after = manifest([{ id: 4, source: 'shared', revision: null, contentHash: 'h1' }], ['project', 'global', 'shared']);
  const d = drift.diffRuleManifests(before, after);
  assert.deepStrictEqual(d.added.map((r) => r.id), [4]);
  assert.strictEqual(d.perSource.shared, drift.SOURCE_STATES.CHANGED);
  assert.strictEqual(d.hasDrift, true, 'a document appearing under a measured-empty source IS drift');
});

test('the measured empty and the ambiguous legacy empty are different answers', () => {
  // Both manifests carry zero rows. One declared what it looked at; the other
  // is a pre-21.10 document whose `[]` meant either "no rules" or "the read
  // threw". They must not resolve alike.
  const declared = drift.diffRuleManifests(
    manifest([], ['project']),
    manifest([{ id: 1, source: 'project', revision: 1, contentHash: 'a' }], ['project'])
  );
  const legacy = drift.diffRuleManifests(
    { rules: [] },
    manifest([{ id: 1, source: 'project', revision: 1, contentHash: 'a' }], ['project'])
  );
  assert.strictEqual(declared.hasDrift, true);
  assert.strictEqual(legacy.hasDrift, false);
  assert.strictEqual(declared.perSource.project, drift.SOURCE_STATES.CHANGED);
  assert.strictEqual(legacy.perSource.project, drift.SOURCE_STATES.NOT_RECORDED);
});
