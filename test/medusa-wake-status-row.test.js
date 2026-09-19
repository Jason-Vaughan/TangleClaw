'use strict';

// Tests for the status-row readiness gate (#1628).
//
// The defect these pin had two opposite faces from ONE cause — `includes()` over
// the whole captured tail, with no notion of which row is the status row:
//
//   * The operator's `tui.status_line` put run-state sixth of fourteen segments,
//     so the row truncated before it. The marker never rendered, every tick read
//     `not-at-rest`, and Medusa mail waited three hours for a human.
//   * The same literal appeared in TRANSCRIPT PROSE discussing the marker. Tail
//     matching found it and reported a pane at rest that was not
//     (delivery ledger 5030, 2026-09-19 03:29:50Z).
//
// So a fixture whose PROSE contains the marker while its STATUS ROW does not is
// the load-bearing case here, not an edge case: it is the false idle, and it is
// the one a tail-reading implementation passes.
//
// Every refusal is fail-closed. Readiness still requires the POSITIVE marker
// rendered in the identified row — silence, an empty composer and an absent
// marker are all "working", never "rested".

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

// The wake table derives from the profiles the store holds (#1255), and these
// reads run at file load rather than in a hook.
const _store = useThrowawayStore('medusa-wake-status-row');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');

const CODEX = wake.ENGINE_WAKE_PROFILES.codex;
const CLAUDE = wake.ENGINE_WAKE_PROFILES.claude;
const ANTIGRAVITY = wake.ENGINE_WAKE_PROFILES.antigravity;

const {
  CX_IDLE_PANE, CX_BUSY_PANE, CX_THINKING_PANE, CX_IDLE_WITH_NEIGHBOUR_PANE,
  CX_CLIPPED_PANE, CX_TRANSCRIPT_PROSE_PANE, CX_DIALOG_PANE, CX_TYPING_PANE,
  AG_IDLE_PANE, AG_BUSY_PANE, IDLE_PANE
} = require('./_wake-fixtures');

describe('#1628 codex profile declares a measured status-row marker', () => {
  it('declares the bare state token, not a separator-decorated literal', () => {
    // `· Ready ·` was wrong twice: the separators come from the JOIN between
    // rendered segments, so a configured-but-empty neighbour deleted the leading
    // one, and the literal was findable in prose.
    assert.equal(CODEX.idleMarker, 'Ready');
    assert.equal(CODEX.idleMarkerRow, 'status-row');
    assert.deepEqual(CODEX.busyStates, ['Working', 'Thinking']);
  });

  it('leaves the busy marker alone — it was measured and still holds', () => {
    assert.equal(CODEX.busyMarker, 'esc to interrupt');
  });
});

describe('#1628 status row is located as the last non-empty row', () => {
  it('finds the row when run-state renders alone', () => {
    assert.equal(wake._statusRow(CX_IDLE_PANE, CODEX), '  Ready');
  });

  it('finds the row when a neighbour contributes a joining separator', () => {
    assert.equal(wake._statusRow(CX_IDLE_WITH_NEIGHBOUR_PANE, CODEX), '  Ready · Ask for approval');
  });

  it('blanks the engine\'s own decoration rather than reading it as content', () => {
    // codex paints a braille shimmer across and above its composer. A shimmer
    // cell landing in the status row must not be able to break a match, nor to
    // forge one by separating a token from its boundary.
    const shimmered = ['  transcript', '  Rea⠁dy'];
    assert.equal(wake._statusRow(shimmered, CODEX), '  Rea dy');
  });

  it('returns null rather than guessing when nothing rendered', () => {
    assert.equal(wake._statusRow([], CODEX), null);
    assert.equal(wake._statusRow(['', '   ', ''], CODEX), null);
  });
});

describe('#1628 readiness is read from the status row only', () => {
  const verdict = (lines) => wake._assessStatusRow(lines, CODEX);

  it('reports at rest when the marker renders alone', () => {
    assert.deepEqual(verdict(CX_IDLE_PANE), { working: false, reason: null });
  });

  it('reports at rest when the marker renders beside a neighbour', () => {
    assert.deepEqual(verdict(CX_IDLE_WITH_NEIGHBOUR_PANE), { working: false, reason: null });
  });

  it('reports busy on Working', () => {
    assert.deepEqual(verdict(CX_BUSY_PANE), { working: true, reason: 'not-at-rest' });
  });

  it('reports busy on Thinking', () => {
    // Never observed live — declared from codex's own segment help text. If the
    // rendering differs the cost is a missed wake, never a false idle, because
    // readiness needs the positive marker regardless.
    assert.deepEqual(verdict(CX_THINKING_PANE), { working: true, reason: 'not-at-rest' });
  });

  it('fails closed with an actionable reason when the row is truncated', () => {
    // The #1628 incident itself.
    assert.deepEqual(verdict(CX_CLIPPED_PANE), { working: true, reason: 'status-row-truncated' });
  });

  it('NEVER reports rest from a marker that is only in the transcript', () => {
    // The false idle. A tail-reading implementation passes this fixture.
    assert.ok(CX_TRANSCRIPT_PROSE_PANE.join('\n').includes('· Ready ·'),
      'fixture must actually carry the old literal in its prose, or it pins nothing');
    assert.ok(CX_TRANSCRIPT_PROSE_PANE.join('\n').includes('Ready'));
    assert.equal(verdict(CX_TRANSCRIPT_PROSE_PANE).working, true);
  });

  it('fails closed when a row renders with no run-state at all', () => {
    assert.deepEqual(verdict(['  transcript', '  gpt-6-astra high · main']),
      { working: true, reason: 'status-row-no-state' });
  });

  it('fails closed when the capture yielded no row', () => {
    assert.deepEqual(verdict([]), { working: true, reason: 'status-row-unavailable' });
  });

  it('matches the state as a whole word, not a substring', () => {
    // A branch named `ready-for-review` in the status row is not a run-state.
    assert.equal(verdict(['  gpt-6 · main · ready-for-review']).reason, 'status-row-no-state');
    assert.equal(verdict(['  Ready-ish']).reason, 'status-row-no-state');
  });

  it('refuses when the caller supplies no lines to establish provenance', () => {
    // Falling back to the joined text IS the defect, and it fails toward rested.
    const a = wake._assessActivity('  Ready', CODEX, undefined);
    assert.deepEqual(a, { working: true, reason: 'status-row-unavailable' });
  });
});

describe('#1628 the composer is an additional requirement, never a substitute', () => {
  it('refuses a dialog even though no busy marker is present', () => {
    assert.equal(wake._assessStatusRow(CX_DIALOG_PANE, CODEX).working, true);
  });

  it('refuses a pane holding an operator draft', () => {
    // The status row says Ready — the composer is what forbids typing here, and
    // `_assessPane` is the gate that owns that question.
    assert.equal(wake._assessStatusRow(CX_TYPING_PANE, CODEX).working, false);
    const paneVerdict = wake._assessPane(CX_TYPING_PANE, CODEX, null);
    assert.equal(paneVerdict.idle, false);
  });
});

describe('#1628 other engines are unchanged', () => {
  it('claude declares no status-row scope and keeps a null marker', () => {
    assert.equal(CLAUDE.idleMarker, null);
    assert.equal(CLAUDE.idleMarkerRow, undefined);
    assert.equal(wake._assessActivity(IDLE_PANE.join('\n'), CLAUDE, IDLE_PANE).working, false);
  });

  it('antigravity keeps its tail-matched hint marker', () => {
    assert.equal(ANTIGRAVITY.idleMarker, '? for shortcuts');
    assert.equal(ANTIGRAVITY.idleMarkerRow, undefined);
    assert.equal(wake._assessActivity(AG_IDLE_PANE.join('\n'), ANTIGRAVITY, AG_IDLE_PANE).working, false);
    assert.equal(wake._assessActivity(AG_BUSY_PANE.join('\n'), ANTIGRAVITY, AG_BUSY_PANE).working, true);
  });

  it('antigravity still reads its marker from anywhere in the tail', () => {
    // Deliberate: its marker was measured as a tail read and nothing here
    // re-measures it. Narrowing it without evidence would be the guess this
    // module forbids.
    const hintAboveTheRow = ['? for shortcuts', '>', '  something else'];
    assert.equal(wake._assessActivity(hintAboveTheRow.join('\n'), ANTIGRAVITY, hintAboveTheRow).working, false);
  });
});
