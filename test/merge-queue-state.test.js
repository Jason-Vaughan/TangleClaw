'use strict';

// #2322: the merge queue's rules with no I/O. The allowed moves are spelled
// out here a second time on purpose: this table is the contract, and the
// module's own table has to agree with it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const state = require('../lib/merge-queue-state');

const ALLOWED = {
  queued: ['assembling', 'failed', 'withdrawn'],
  assembling: ['testing', 'failed', 'withdrawn'],
  testing: ['landing', 'assembling', 'failed', 'withdrawn'],
  landing: ['landed', 'testing', 'assembling', 'failed'],
  landed: [],
  failed: [],
  withdrawn: []
};

describe('merge queue state machine (#2322)', () => {
  it('knows exactly the seven states, split into waiting, active and finished', () => {
    assert.deepEqual([...state.STATES].sort(), Object.keys(ALLOWED).sort());
    assert.deepEqual([...state.ACTIVE_STATES], ['assembling', 'testing', 'landing']);
    assert.deepEqual([...state.FINISHED_STATES], ['landed', 'failed', 'withdrawn']);
    for (const s of state.STATES) {
      const kinds = [s === 'queued', state.isActive(s), state.isFinished(s)].filter(Boolean);
      assert.equal(kinds.length, 1, `${s} must be exactly one of waiting, active, finished`);
    }
  });

  it('allows every listed move and records it under a known event', () => {
    for (const [from, tos] of Object.entries(ALLOWED)) {
      for (const to of tos) {
        const answer = state.checkTransition(from, to);
        assert.equal(answer.ok, true, `${from} → ${to} should be allowed`);
        assert.ok(state.EVENTS.includes(answer.event), `${from} → ${to} is recorded as "${answer.event}", which is not an event`);
      }
    }
  });

  it('refuses every move not listed, by a named code', () => {
    for (const from of state.STATES) {
      for (const to of state.STATES) {
        if (ALLOWED[from].includes(to)) continue;
        const answer = state.checkTransition(from, to);
        assert.equal(answer.ok, false, `${from} → ${to} should be refused`);
        const expected = ALLOWED[from].length === 0 ? state.REFUSALS.ENTRY_FINISHED : state.REFUSALS.TRANSITION_NOT_ALLOWED;
        assert.equal(answer.code, expected, `${from} → ${to}`);
        assert.ok(answer.message);
      }
    }
  });

  it('refuses a state it does not know, whichever side it is on', () => {
    assert.equal(state.checkTransition('queued', 'merged').code, state.REFUSALS.UNKNOWN_STATE);
    assert.equal(state.checkTransition('parked', 'queued').code, state.REFUSALS.UNKNOWN_STATE);
    assert.equal(state.checkTransition(undefined, 'queued').code, state.REFUSALS.UNKNOWN_STATE);
  });

  it('cannot withdraw once landing has started, and can before', () => {
    assert.equal(state.checkTransition('landing', 'withdrawn').ok, false);
    for (const from of ['queued', 'assembling', 'testing']) assert.equal(state.checkTransition(from, 'withdrawn').ok, true);
  });

  it('names a distinct event for each kind of move', () => {
    assert.equal(state.checkTransition('queued', 'assembling').event, 'assembly-started');
    assert.equal(state.checkTransition('assembling', 'testing').event, 'candidate-made');
    assert.equal(state.checkTransition('testing', 'assembling').event, 'candidate-discarded');
    assert.equal(state.checkTransition('landing', 'assembling').event, 'candidate-discarded');
    assert.equal(state.checkTransition('testing', 'landing').event, 'landing-started');
    assert.equal(state.checkTransition('landing', 'testing').event, 'landing-not-made');
    assert.equal(state.checkTransition('landing', 'landed').event, 'landed');
    assert.equal(state.checkTransition('testing', 'failed').event, 'failed');
    assert.equal(state.checkTransition('queued', 'withdrawn').event, 'withdrawn');
  });

  it('keeps every refusal code equal to its own name', () => {
    for (const [name, code] of Object.entries(state.REFUSALS)) assert.equal(code, name);
  });
});

describe('merge queue: which entry is next (#2322)', () => {
  const entry = (id, s, position) => ({ id, state: s, position });

  it('is nothing for an empty queue or one with only finished entries', () => {
    assert.equal(state.nextActive([]), null);
    assert.equal(state.nextActive(undefined), null);
    assert.equal(state.nextActive([entry('a', 'landed', 1), entry('b', 'failed', 2), entry('c', 'withdrawn', 3)]), null);
  });

  it('is the queued entry submitted first, whatever order the list is in', () => {
    assert.equal(state.nextActive([entry('c', 'queued', 3), entry('a', 'queued', 1), entry('b', 'queued', 2)]).id, 'a');
  });

  it('is the active entry while there is one, even when an earlier position is queued', () => {
    for (const s of state.ACTIVE_STATES) {
      assert.equal(state.nextActive([entry('a', 'queued', 1), entry('b', s, 2)]).id, 'b');
    }
  });

  it('skips a withdrawn entry in the middle and keeps the others in order', () => {
    const list = [entry('a', 'landed', 1), entry('b', 'withdrawn', 2), entry('c', 'queued', 3), entry('d', 'queued', 4)];
    assert.equal(state.nextActive(list).id, 'c');
  });
});

describe('merge queue: what is still wrong with an entry\'s gates (#2322)', () => {
  const met = () => ({
    gates: {
      review: { status: 'recorded', reference: 'critic rev-1' },
      test: { status: 'recorded', reference: 'run 42' },
      base: { status: 'recorded', reference: 'main e4dfaf47' },
      operator: { status: 'not-required', reference: null }
    }
  });

  it('finds nothing wrong when the three owner gates are recorded and no Operator gate is needed', () => {
    assert.deepEqual(state.gateProblems(met()), []);
  });

  it('finds nothing wrong when a required Operator gate has been recorded with a reference', () => {
    const entry = met();
    entry.gates.operator = { status: 'recorded', reference: 'pane, 21:15' };
    assert.deepEqual(state.gateProblems(entry), []);
  });

  it('names each owner gate that is not recorded or has no reference', () => {
    for (const name of state.OWNER_GATES) {
      const missing = met();
      missing.gates[name].status = 'missing';
      assert.deepEqual(state.gateProblems(missing).map((p) => [p.gate, p.code]), [[name, state.REFUSALS.GATE_NOT_RECORDED]]);
      const blank = met();
      blank.gates[name].reference = '   ';
      assert.deepEqual(state.gateProblems(blank).map((p) => [p.gate, p.code]), [[name, state.REFUSALS.GATE_REFERENCE_MISSING]]);
    }
  });

  it('holds an entry whose Operator gate is required and open', () => {
    const entry = met();
    entry.gates.operator = { status: 'required', reference: null };
    assert.deepEqual(state.gateProblems(entry).map((p) => [p.gate, p.code]), [['operator', state.REFUSALS.OPERATOR_GATE_OPEN]]);
  });

  it('does not take a recorded Operator gate with no reference, or a status it cannot read', () => {
    const noRef = met();
    noRef.gates.operator = { status: 'recorded', reference: '' };
    assert.equal(state.gateProblems(noRef)[0].code, state.REFUSALS.GATE_REFERENCE_MISSING);
    const unknown = met();
    unknown.gates.operator = { status: 'waived' };
    assert.equal(state.gateProblems(unknown)[0].code, state.REFUSALS.GATE_NOT_RECORDED);
  });

  it('fails closed on an entry with no gates at all', () => {
    assert.equal(state.gateProblems({}).length, 4);
    assert.equal(state.gateProblems(null).length, 4);
  });
});
