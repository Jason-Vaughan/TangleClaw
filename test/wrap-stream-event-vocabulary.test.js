'use strict';

/*
 * #1228 — the wrap stream's event names are declared once, in
 * `public/wrap-stream-events.js`, and every consumer is checked against that
 * declaration rather than against a list of its own.
 *
 * The failure this guards is silent in both directions. A browser `EventSource`
 * delivers a named event only to a listener registered for that name, so a type
 * the server adds and the client never subscribes to runs no handler and logs
 * nothing; and a folding table with a default branch absorbs a type it was never
 * taught. The first symptom would be a step that never appears in the drawer,
 * with nothing in the console and nothing red here — unless this test reads the
 * producer's list, which it does.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { WRAP_STREAM_EVENTS, WRAP_STREAM_EVENT_TYPES } = require('../public/wrap-stream-events');
const drawer = require('../public/wrap-drawer');
const wrapRunRegistry = require('../lib/wrap-run-registry');

/** @param {string} rel @returns {string} */
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('wrap stream event vocabulary (#1228)', () => {
  it('is declared, non-empty, unique and frozen', () => {
    assert.ok(WRAP_STREAM_EVENT_TYPES.length > 0);
    assert.equal(new Set(WRAP_STREAM_EVENT_TYPES).size, WRAP_STREAM_EVENT_TYPES.length);
    assert.ok(Object.isFrozen(WRAP_STREAM_EVENTS));
    assert.ok(Object.isFrozen(WRAP_STREAM_EVENT_TYPES));
    assert.deepEqual([...WRAP_STREAM_EVENT_TYPES], Object.values(WRAP_STREAM_EVENTS));
  });

  it('the drawer folds exactly the declared types — none missing, none it invented', () => {
    const handled = Object.keys(drawer.WRAP_STREAM_FOLDS).sort();
    assert.deepEqual(handled, [...WRAP_STREAM_EVENT_TYPES].sort());
  });

  it('every declared type changes the live view it is folded into', () => {
    // Keys alone could be satisfied by a no-op entry. Each type must do something.
    const base = drawer.applyWrapStreamEvent(null, { type: WRAP_STREAM_EVENTS.RUN_START, steps: [{ stepId: 's', kind: 'k' }] });
    const samples = {
      [WRAP_STREAM_EVENTS.RUN_START]: { steps: [{ stepId: 'other', kind: 'k' }] },
      [WRAP_STREAM_EVENTS.STEP_START]: { stepId: 's', kind: 'k' },
      [WRAP_STREAM_EVENTS.STEP_DONE]: { stepId: 's', kind: 'k', status: 'done' },
      [WRAP_STREAM_EVENTS.STEP_BLOCKED]: { stepId: 's', kind: 'k', status: 'blocked', halted: true },
      [WRAP_STREAM_EVENTS.RUN_DONE]: { result: { ok: true } }
    };
    for (const type of WRAP_STREAM_EVENT_TYPES) {
      assert.ok(samples[type], `no sample for declared type ${type} — add one`);
      const folded = drawer.applyWrapStreamEvent(base, { type, ...samples[type] });
      assert.notDeepEqual(folded, base, `${type} is handled but changes nothing`);
    }
  });

  it('the page subscribes by the declared list, and loads it before the drawer', () => {
    const session = read('public/session.js');
    assert.match(session, /for \(const type of window\.tcWrapStreamEvents\.WRAP_STREAM_EVENT_TYPES\)/);
    const html = read('public/session.html');
    const events = html.indexOf('<script src="/wrap-stream-events.js">');
    assert.ok(events !== -1, 'session.html loads the vocabulary');
    assert.ok(events < html.indexOf('<script src="/session.js">'));
    assert.ok(html.indexOf('<script src="/wrap-drawer.js">') < html.indexOf('<script src="/wrap-run-controller.js">'),
      'the controller folds through the drawer helpers, so the drawer loads first');
  });

  it('no producer or page spells an event type as a literal', () => {
    // Built from the declaration, so a type added there is searched for here.
    // String quotes only: backticks are how JSDoc and comments name a type.
    const literal = new RegExp(`['"](${WRAP_STREAM_EVENT_TYPES.join('|')})['"]`);
    for (const rel of ['lib/wrap-pipeline.js', 'lib/wrap-run-registry.js', 'lib/sessions.js', 'server.js', 'public/session.js']) {
      const hit = read(rel).split('\n').find((line) => literal.test(line));
      assert.equal(hit, undefined, `${rel} spells an event type instead of using the vocabulary: ${hit}`);
    }
  });

  it('every event a real run records is a declared type', () => {
    wrapRunRegistry._resetForTests();
    const { runId } = wrapRunRegistry.begin('vocab-probe', 1);
    wrapRunRegistry.emit('vocab-probe', runId, { type: WRAP_STREAM_EVENTS.STEP_START, stepId: 'x' });
    wrapRunRegistry.finish('vocab-probe', runId, { ok: true });
    const sub = wrapRunRegistry.subscribe('vocab-probe', runId, { onEvent() {}, onEnd() {} });
    for (const ev of sub.replay) {
      assert.ok(WRAP_STREAM_EVENT_TYPES.includes(ev.type), `recorded ${ev.type}, which is not declared`);
    }
    assert.equal(sub.replay[sub.replay.length - 1].type, WRAP_STREAM_EVENTS.RUN_DONE);
    wrapRunRegistry._resetForTests();
  });
});
