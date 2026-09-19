'use strict';

/*
 * Car 21.10's wiring: the frozen drift, the READY gate that reads it, and the
 * step-3 section that states it.
 *
 * The pure diff has its own file (`launch-rule-drift.test.js`). What this one
 * pins is the property that makes the feature honest end to end — the gate and
 * the text are ONE answer, computed once and frozen. Every defect this car
 * could plausibly ship is a place where those two come apart: a revision that
 * re-renders step 3 without the drift while the gate still demands it, a gate
 * that recomputes at attest time and demands a reconciliation for a rule the
 * agent was never shown, or an unrecorded source that gates an attestation on a
 * comparison nobody made.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');
const drift = require('../lib/launch-rule-drift');
const handoffPublication = require('../lib/handoff-publication');

/**
 * A sequence as `_reconciliationRequired` reads one.
 * @param {object} [o] - Overrides
 * @returns {object} The sequence
 */
function sequence(o = {}) {
  return {
    id: 1,
    revision: 1,
    readyAt: null,
    recovery: 'none',
    recoveryMode: 'operator',
    preflight: { verdict: 'ok', reason: 'fine', requiresReconciliation: false },
    sourceManifest: { ruleDrift: null },
    ...o
  };
}

/**
 * A drift result with drift in it.
 * @returns {object} The drift
 */
function drifted() {
  return drift.diffRuleManifests(
    { rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }], manifestSources: ['project'] },
    { rules: [{ id: 1, source: 'project', revision: 2, contentHash: 'b' }], manifestSources: ['project'] }
  );
}

describe('the READY gate reads the frozen drift', () => {
  // A scratch store, because the revision branch calls `anyStepReadBefore`.
  // Never the live one: a test that reads the running install's database
  // answers about whatever that install happens to hold today.
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-drift-gate-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('demands a reconciliation when the governing rules drifted', () => {
    const why = launchSequence._reconciliationRequired(
      sequence({ sourceManifest: { ruleDrift: drifted() } })
    );
    assert.ok(why, 'drift must require a reconciliation');
    assert.match(why, /changed since the previous session's handoff/);
  });

  it('does not demand one when nothing drifted', () => {
    const clean = drift.diffRuleManifests(
      { rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }], manifestSources: ['project'] },
      { rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }], manifestSources: ['project'] }
    );
    assert.equal(launchSequence._reconciliationRequired(sequence({ sourceManifest: { ruleDrift: clean } })), null);
  });

  it('does not demand one for a source the handoff never recorded', () => {
    // A launch cannot ask an agent to reconcile with a comparison nobody made.
    const unrecorded = drift.diffRuleManifests(
      { rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }] }, // legacy
      {
        rules: [
          { id: 1, source: 'project', revision: 1, contentHash: 'a' },
          { id: 7, source: 'shared', revision: null, contentHash: 'brand-new' }
        ],
        manifestSources: ['project', 'global', 'shared']
      }
    );
    assert.equal(unrecorded.perSource.shared, 'not-recorded');
    assert.equal(launchSequence._reconciliationRequired(sequence({ sourceManifest: { ruleDrift: unrecorded } })), null);
  });

  it('a sequence with no drift recorded at all gates nothing', () => {
    assert.equal(launchSequence._reconciliationRequired(sequence()), null);
    assert.equal(launchSequence._reconciliationRequired(sequence({ sourceManifest: {} })), null);
    assert.equal(launchSequence._reconciliationRequired(sequence({ sourceManifest: null })), null);
  });

  it('a stronger trigger keeps its wording, so the reason that matters is not buried', () => {
    // An uncleared advisory recovery outranks drift: the wording an agent reads
    // must name the gate it is actually standing at.
    const why = launchSequence._reconciliationRequired(sequence({
      recovery: 'required',
      recoveryMode: 'advisory',
      sourceManifest: { ruleDrift: drifted() }
    }));
    assert.match(why, /needs recovering/);
    assert.doesNotMatch(why, /changed since the previous session's handoff/);
  });

  it('a preflight verdict that demands one outranks drift', () => {
    // The gap R-4 named: every other drift test left `requiresReconciliation`
    // false, so this rung of the four-way precedence was documented as pinned
    // and was not exercised at all.
    const why = launchSequence._reconciliationRequired(sequence({
      preflight: { verdict: 'handoff-behind', reason: 'the newest session never published', requiresReconciliation: true },
      sourceManifest: { ruleDrift: drifted() }
    }));
    assert.match(why, /handoff-behind/);
    assert.doesNotMatch(why, /changed since the previous session's handoff/);
  });

  it('drift is reported when NO stronger trigger applies', () => {
    // The other side of precedence: drift must actually surface when it is the
    // only reason, or the ordering above would be indistinguishable from drift
    // never being checked.
    const why = launchSequence._reconciliationRequired(sequence({
      preflight: { verdict: 'ok', reason: 'fine', requiresReconciliation: false },
      sourceManifest: { ruleDrift: drifted() }
    }));
    assert.match(why, /changed since the previous session's handoff/);
  });

  it('a revision outranks drift for the same reason', () => {
    const why = launchSequence._reconciliationRequired(sequence({
      revision: 2,
      sourceManifest: { ruleDrift: drifted() },
      // No step rows exist for this id, so `anyStepReadBefore` answers false and
      // the branch takes its never-served wording. Which wording is not the
      // point — that the revision branch wins over drift is.
      id: 424242
    }));
    assert.match(why, /revised to revision 2/);
  });
});

describe('the handoff document carries what the next launch needs to diff', () => {
  /**
   * A minimal valid document input.
   * @param {object} [o] - Overrides
   * @returns {object} The input
   */
  const input = (o = {}) => ({
    publicationId: 'p1',
    projectId: 14,
    workspaceId: null,
    sessionId: 1,
    wrapRunId: 'r1',
    engineId: 'claude',
    kind: 'final',
    stagedAt: '2026-09-19T00:00:00.000Z',
    worktree: null,
    rules: [],
    globalRulesHash: null,
    engineConfigHash: null,
    continuityIndexHash: null,
    wrapOutcome: 'complete',
    ...o
  });

  it('records manifestSources when the producer declares them', () => {
    const doc = handoffPublication.buildHandoffDocument(input({
      rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }],
      manifestSources: ['project', 'global', 'shared']
    }));
    assert.deepEqual(doc.manifestSources, ['project', 'global', 'shared']);
  });

  it('omits the field entirely when the producer declares nothing', () => {
    // Absent must stay distinguishable from empty: `[]` would claim the wrap
    // looked at no sources, which is a different fact from a wrap that predates
    // the field. Rows are supplied because they are what makes a legacy
    // document evidence of anything — an empty legacy array is ambiguous
    // between "no rules" and "the read failed", and is read as unknown.
    const doc = handoffPublication.buildHandoffDocument(input({
      rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }]
    }));
    assert.equal('manifestSources' in doc, false);
    assert.deepEqual(drift.recordedSources(doc), ['project']);
  });

  it('a document with an empty declaration is read as having recorded nothing', () => {
    const doc = handoffPublication.buildHandoffDocument(input({ manifestSources: [] }));
    assert.deepEqual(doc.manifestSources, []);
    assert.deepEqual(drift.recordedSources(doc), []);
    assert.equal(drift.diffRuleManifests(doc, { rules: [], manifestSources: ['project'] }).recorded, false);
  });

  it('survives a serialize/read round trip, which is how the next launch gets it', () => {
    const doc = handoffPublication.buildHandoffDocument(input({
      rules: [{ id: 1, source: 'shared', revision: null, contentHash: 'h' }],
      manifestSources: ['project', 'shared']
    }));
    const read = handoffPublication.readDocument(handoffPublication.serializeDocument(doc));
    assert.equal(read.outcome, 'ok');
    assert.deepEqual(read.doc.manifestSources, ['project', 'shared']);
    assert.deepEqual(drift.recordedSources(read.doc), ['project', 'shared']);
  });
});

describe('the wrap and the launch derive the same manifest shape', () => {
  it('ruleFingerprints stamps the source it is given, not a literal', () => {
    // 21.9 asserted this coupling in a comment only. The comment was right and
    // the code was not: every row was stamped `project`, so two of the three
    // sources the schema declares were unreachable.
    const rules = [{ id: 1, content: 'a' }];
    assert.equal(launchSequence.ruleFingerprints(rules)[0].source, 'project');
    assert.equal(launchSequence.ruleFingerprints(rules, 'shared')[0].source, 'shared');
  });

  it('a fingerprint hashes the trimmed body, so whitespace is not drift', () => {
    const a = launchSequence.ruleFingerprints([{ id: 1, content: 'rule' }]);
    const b = launchSequence.ruleFingerprints([{ id: 1, content: '  rule\n' }]);
    assert.equal(a[0].contentHash, b[0].contentHash);
  });

  describe('manifestFingerprints declares exactly what it read', () => {
    let tmpDir;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-drift-manifest-'));
      store._setBasePath(path.join(tmpDir, 'store'));
      store.init();
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('names every source it successfully read', () => {
      const m = launchSequence.manifestFingerprints({ id: 1, name: 'p' });
      assert.deepEqual(m.manifestSources, ['project', 'global', 'shared']);
      // Exactly one global row: the global rules are one document, so there is
      // no per-rule identity to diff below the set.
      assert.equal(m.rules.filter((r) => r.source === 'global').length, 1);
    });

    it('takes no rules from its caller, so both sides read one population', () => {
      // The defect this signature change closes: the launch used to hand in
      // its already-filtered bundle while the wrap read the store unfiltered,
      // so a project holding one empty rule reported it as removed on every
      // launch and blocked READY forever for a deletion that never happened.
      // A second argument is ignored rather than trusted.
      const a = launchSequence.manifestFingerprints({ id: 1, name: 'p' });
      const b = launchSequence.manifestFingerprints({ id: 1, name: 'p' }, [{ id: 7, content: 'ghost' }]);
      assert.deepEqual(a.rules, b.rules);
      assert.equal(launchSequence.manifestFingerprints.length, 1, 'the composer takes exactly one argument');
    });

    it('a global row carries a label, so step 3 never prints a bare id', () => {
      const m = launchSequence.manifestFingerprints({ id: 1, name: 'p' }, []);
      const global = m.rules.find((r) => r.source === 'global');
      assert.equal(global.label, 'the global rules');
    });
  });
});

describe('step 3 states the drift it was frozen with', () => {
  const sessions = require('../lib/sessions');
  const lines = (d) => sessions._ruleDriftLines(d).join('\n');

  /**
   * A manifest with explicit sources.
   * @param {object[]} rules - Fingerprints
   * @param {string[]} [sources] - Recorded sources
   * @returns {object} The manifest
   */
  const m = (rules, sources = ['project', 'global', 'shared']) => ({ rules, manifestSources: sources });

  it('renders nothing when there was no comparison to make', () => {
    // A first launch has no handoff. The section is absent rather than present
    // and empty, so it never implies a comparison nobody made.
    assert.deepEqual(sessions._ruleDriftLines(null), []);
  });

  it('says so explicitly when nothing drifted, naming only what it compared', () => {
    // "No drift" is a finding. A section that only appears on bad news is one
    // whose absence tells the reader nothing.
    const text = lines(drift.diffRuleManifests(
      m([{ id: 1, source: 'project', revision: 1, contentHash: 'a' }]),
      m([{ id: 1, source: 'project', revision: 1, contentHash: 'a' }])
    ));
    assert.match(text, /Nothing changed in project, global, shared since the handoff/);
  });

  it('the no-drift sentence never speaks for a source it did not compare', () => {
    // The sentence used to be blanket, so the first launch after this ships
    // for any project — where two of three sources were never recorded —
    // stated that nothing changed and then retracted it on the next line.
    const text = lines(drift.diffRuleManifests(
      { rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }] }, // legacy
      m([{ id: 1, source: 'project', revision: 1, contentHash: 'a' }])
    ));
    assert.match(text, /Nothing changed in project since the handoff/);
    assert.doesNotMatch(text, /global rule or shared document changed/);
    assert.doesNotMatch(text, /Nothing changed in project, global/);
  });

  it('names each added, removed and changed source', () => {
    const text = lines(drift.diffRuleManifests(
      m([
        { id: 1, source: 'project', revision: 1, contentHash: 'a' },
        { id: 2, source: 'project', revision: 1, contentHash: 'gone' }
      ]),
      m([
        { id: 1, source: 'project', revision: 2, contentHash: 'CHANGED' },
        { id: 3, source: 'project', revision: 1, contentHash: 'new' }
      ])
    ));
    assert.match(text, /project rule 3.*added/);
    assert.match(text, /project rule 2.*removed/);
    assert.match(text, /project rule 1.*changed.*revision 1 → 2/);
  });

  it('names an unrecorded source as not compared, never as unchanged', () => {
    // The defect this whole car exists to avoid: telling an agent the shared
    // documents are the previous session's when nothing ever hashed them.
    const text = lines(drift.diffRuleManifests(
      { rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }] },
      m([
        { id: 1, source: 'project', revision: 1, contentHash: 'a' },
        { id: 4, source: 'shared', revision: null, contentHash: 'h' }
      ])
    ));
    assert.match(text, /Not compared/);
    assert.match(text, /global, shared/);
    assert.doesNotMatch(text, /shared document.*added/);
  });

  it('a handoff that recorded nothing says nothing can be compared', () => {
    const text = lines(drift.diffRuleManifests(m([], []), m([])));
    assert.match(text, /recorded no governing sources/);
  });

  it('uses the shared document label rather than a bare id', () => {
    const text = lines(drift.diffRuleManifests(
      m([{ id: 4, source: 'shared', revision: null, contentHash: 'h1', label: 'shared document NETWORK' }]),
      m([{ id: 4, source: 'shared', revision: null, contentHash: 'h2', label: 'shared document NETWORK' }])
    ));
    assert.match(text, /shared document NETWORK/);
  });
});

describe('the launch never fails on drift', () => {
  const sessions = require('../lib/sessions');

  it('takes exactly two arguments, so a stale call site cannot pass vacuously', () => {
    // These three calls were written against the pre-fix three-argument shape
    // and survived the signature change: `[]` is truthy, so the manifest guard
    // fell through on the WRONG argument, every call returned null on line
    // three, and the test below never entered the try it claims to cover. A
    // green assertion about a function reached by the wrong path is worse than
    // no assertion, so the arity is pinned first.
    assert.equal(sessions._launchRuleDrift.length, 2);
  });

  it('returns null when the preflight offered no manifest', () => {
    assert.equal(sessions._launchRuleDrift({ id: 1, name: 'p' }, { handoffManifest: null }), null);
    assert.equal(sessions._launchRuleDrift({ id: 1, name: 'p' }, undefined), null);
  });

  it('reaches the body and produces a diff when the manifest is offered', () => {
    // The guard's only other answer is null, so a diff result proves the body
    // ran. This does NOT reach the catch — see the test below for that.
    const result = sessions._launchRuleDrift(
      { id: -999, name: 'nope' },
      { handoffManifest: { rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }], manifestSources: ['project'] } }
    );
    assert.notEqual(result, null);
    assert.ok(Array.isArray(result.added));
  });

  it('names the failure instead of throwing when the composer itself throws', () => {
    // The broad-except path is UNREACHABLE without a stub: `manifestFingerprints`
    // catches each of its three source reads, and the diff is defensive
    // throughout. An earlier version of this test claimed to reach the catch and
    // could not — its assertion was a disjunction satisfied by the success path,
    // so it was green about code it never executed. Stubbing is what makes the
    // name true.
    const real = launchSequence.manifestFingerprints;
    launchSequence.manifestFingerprints = () => { throw new Error('composer exploded'); };
    try {
      const result = sessions._launchRuleDrift(
        { id: 1, name: 'p' },
        { handoffManifest: { rules: [{ id: 1, source: 'project', revision: 1, contentHash: 'a' }], manifestSources: ['project'] } }
      );
      assert.match(result.unavailable, /could not compare them/);
      assert.match(result.unavailable, /composer exploded/);
    } finally {
      launchSequence.manifestFingerprints = real;
    }
  });
});

describe('a failed measurement is distinguishable from a clean slate', () => {
  const sessions = require('../lib/sessions');

  it('a corrupt handoff renders a section saying it could not be read', () => {
    const text = sessions._ruleDriftLines({ unavailable: 'the handoff could not be read (invalid)' }).join('\n');
    assert.match(text, /Not compared/);
    assert.match(text, /could not be read/);
    assert.match(text, /possibly different/);
  });

  it('a first launch renders no section at all', () => {
    // Nothing was attempted, so there is nothing to report. This is the ONE
    // case that legitimately renders blank.
    assert.deepEqual(sessions._ruleDriftLines(null), []);
  });

  it('the preflight says WHY it has no manifest, so the two cannot collapse', () => {
    // A document that exists and could not be read is a failed measurement.
    assert.equal(
      sessions._launchRuleDrift({ id: 1, name: 'p' }, { handoffManifest: null, handoffManifestUnavailable: 'boom' }).unavailable,
      'boom'
    );
    // A project with no handoff at all has nothing to say.
    assert.equal(
      sessions._launchRuleDrift({ id: 1, name: 'p' }, { handoffManifest: null, handoffManifestUnavailable: null }),
      null
    );
  });

  it('an unavailable drift never gates READY', () => {
    // It states a gap; it cannot demand a reconciliation for a comparison
    // nobody completed.
    assert.equal(
      launchSequence._reconciliationRequired(sequence({ sourceManifest: { ruleDrift: { unavailable: 'boom' } } })),
      null
    );
  });
});

describe('a revision carries the drift through', () => {
  it('the re-render is handed the same drift the first render was', () => {
    // A revision re-renders steps 2-4. Without the carry-through, step 3 would
    // lose the drift section while the gate still demanded a reconciliation for
    // it — a requirement whose stated reason had vanished from the text.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'lib', 'launch-sequence.js'), 'utf8'
    );
    const reviseFn = src.slice(src.indexOf('function _reviseIfRulesChanged'));
    const body = reviseFn.slice(0, reviseFn.indexOf('\nfunction '));
    // Both halves: the re-render call and the rebuilt manifest.
    assert.match(body, /ruleDrift: manifest\.ruleDrift \?\? null/);
    assert.equal((body.match(/ruleDrift: manifest\.ruleDrift \?\? null/g) || []).length, 2,
      'the drift must be carried into BOTH the re-render and the rebuilt manifest');
  });
});

describe('the wrap and the launch build byte-equal manifests', () => {
  let tmpDir;
  let project;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-drift-eq-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    project = store.projects.create({ name: 'drift-eq', path: tmpDir, engine: 'claude' });
    store.sessionRules.create({ projectId: project.id, content: 'a governing rule', createdBy: 'operator', approvedByOperator: true });
    store.sessionRules.create({ projectId: project.id, content: 'another one', createdBy: 'operator', approvedByOperator: true });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the wrap step and the launch derive the identical manifest', () => {
    // 21.9's comment asserted this coupling and nothing checked it; the first
    // cut of 21.10 then broke it by letting the launch pass its own already-
    // filtered bundle. Now both go through one reader with no caller input, so
    // the property is structural — and pinned here rather than narrated.
    const handoffStage = require('../lib/wrap-steps/handoff-stage');
    const fromWrap = handoffStage._ruleManifest(project);
    const fromLaunch = launchSequence.manifestFingerprints(project);
    assert.deepEqual(fromWrap, fromLaunch);
  });

  it('and they therefore diff to no drift against each other', () => {
    const handoffStage = require('../lib/wrap-steps/handoff-stage');
    const d = drift.diffRuleManifests(
      handoffStage._ruleManifest(project),
      launchSequence.manifestFingerprints(project)
    );
    assert.equal(d.hasDrift, false);
    assert.deepEqual(d.comparedSources, ['project', 'global', 'shared']);
  });
});

describe('step 3 sends the reader to the machine that actually failed', () => {
  const sessions = require('../lib/sessions');
  const lines = (d) => sessions._ruleDriftLines(d).join('\n');
  const m = (rules, sources = ['project', 'global', 'shared']) => ({ rules, manifestSources: sources });

  it('a wrap-side failure does not blame this machine', () => {
    // The defect: one collapsed "unmeasured" set made step 3 say "this launch
    // could not read it — the server log names what failed" about a file that
    // failed at the PREVIOUS wrap, on a machine whose log says nothing.
    const text = lines(drift.diffRuleManifests(
      m([{ id: 4, source: 'shared', revision: null, contentHash: null, measured: false }]),
      m([{ id: 4, source: 'shared', revision: null, contentHash: 'h1' }])
    ));
    assert.match(text, /previous session's wrap recorded/);
    assert.doesNotMatch(text, /This machine's server log/);
  });

  it('a launch-side failure does blame this machine, and says so', () => {
    const text = lines(drift.diffRuleManifests(
      m([{ id: 4, source: 'shared', revision: null, contentHash: 'h1' }]),
      m([{ id: 4, source: 'shared', revision: null, contentHash: null, measured: false }])
    ));
    assert.match(text, /this launch could not read part of/);
    assert.match(text, /This machine's server log/);
    assert.doesNotMatch(text, /previous session's wrap recorded/);
  });

  it('a partly-unreadable source never carries "nothing changed"', () => {
    // `comparedSources` includes a partly-unreadable source, so the no-drift
    // sentence is built from the VERDICT instead — only a source whose verdict
    // is literally `unchanged` is spoken for.
    const text = lines(drift.diffRuleManifests(
      m([
        { id: 1, source: 'project', revision: 1, contentHash: 'a' },
        { id: 4, source: 'shared', revision: null, contentHash: null, measured: false }
      ]),
      m([
        { id: 1, source: 'project', revision: 1, contentHash: 'a' },
        { id: 4, source: 'shared', revision: null, contentHash: null, measured: false }
      ])
    ));
    assert.match(text, /Nothing changed in project, global since the handoff/);
    assert.doesNotMatch(text, /Nothing changed in project, global, shared/);
  });

  it('a measured change is still named when its source is partly unreadable', () => {
    const text = lines(drift.diffRuleManifests(
      m([
        { id: 4, source: 'shared', revision: null, contentHash: 'h1', label: 'shared document NETWORK' },
        { id: 5, source: 'shared', revision: null, contentHash: null, measured: false }
      ]),
      m([
        { id: 4, source: 'shared', revision: null, contentHash: 'CHANGED', label: 'shared document NETWORK' },
        { id: 5, source: 'shared', revision: null, contentHash: null, measured: false }
      ])
    ));
    assert.match(text, /shared document NETWORK.*changed/);
    // And the gap is still disclosed beside it, so the change never reads as
    // the complete list.
    assert.match(text, /what is NOT named may have changed too/);
  });
});
