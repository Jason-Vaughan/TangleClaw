'use strict';

/*
 * The wrap-confirm path must not call a function that does not exist.
 *
 * #185 shipped the SERVER half of live wrap progress and left a call to
 * `startWrapSse()` in `public/session.js` with no definition anywhere. At
 * runtime that threw a ReferenceError positioned exactly between the optimistic
 * UI and the POST:
 *
 *     sessionState.wrapping = true;
 *     showWrappingState();          // spinner appears
 *     openWrapDrawer({results: []}) // drawer opens EMPTY
 *     startWrapSse();               // THROWS
 *     try { await apiMutate(.../wrap, 'POST') }   // never reached
 *     finally { wrapInFlight = false; }           // never runs
 *
 * So the wrap never started, the drawer never filled, and Cancel stayed
 * permanently disabled because the throw skipped the `finally`. It shipped in
 * v5.11.0 and broke the first wrap attempted after it.
 *
 * `node --check` passes on an undefined call — it is a runtime error, not a
 * syntax one — so CI was green throughout. This guard is the thing that would
 * have caught it.
 *
 * Deliberately scoped to the wrap-confirm path rather than the whole file: a
 * whole-file scan produces false positives from prose and browser globals, and
 * a guard nobody trusts gets deleted. This surface is ~9 calls and exact.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');

/** @param {string} t - Source. @returns {string} Source with comments removed. */
function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Names defined in a file: function declarations, assignments, and the
 * `global.x = x` exports `api-helper.js` uses to publish shared helpers.
 * @param {string} t - Source.
 * @returns {Set<string>}
 */
function definedNames(t) {
  const out = new Set();
  const re = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|global\.([A-Za-z_$][\w$]*)\s*=)/g;
  for (const m of t.matchAll(re)) out.add(m[1] || m[2] || m[3]);
  return out;
}

// Language keywords and platform builtins that read as calls to the scanner.
const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'encodeURIComponent']);

describe('the wrap-confirm path calls only functions that exist', () => {
  const session = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
  const helper = fs.readFileSync(path.join(PUBLIC, 'api-helper.js'), 'utf8');

  // The confirm handler, from the in-flight latch to the `finally` that clears it.
  const start = session.indexOf('  wrapInFlight = true;');
  const end = session.indexOf('    wrapInFlight = false;', start);

  it('the wrap-confirm path is still locatable (the scan has something to read)', () => {
    // Without this the extraction could silently yield an empty string and the
    // assertion below would pass on zero calls — green, and measuring nothing.
    assert.ok(start !== -1, 'could not find the wrap-confirm in-flight latch in session.js');
    assert.ok(end > start, 'could not find the finally that clears wrapInFlight');
  });

  it('every function it calls is defined in session.js or api-helper.js', () => {
    const body = stripComments(session.slice(start, end));
    const called = [...new Set(
      [...body.matchAll(/(?:^|[^\w$.])([a-z][\w$]*)\s*\(/g)].map((m) => m[1])
    )].filter((n) => !NOT_FUNCTIONS.has(n));

    assert.ok(called.length >= 5,
      `expected the wrap path to call several helpers, found ${called.length} — the extraction is probably wrong`);

    const defined = new Set([...definedNames(stripComments(session)), ...definedNames(stripComments(helper))]);
    const missing = called.filter((n) => !defined.has(n));

    assert.deepEqual(missing, [],
      `the wrap-confirm path calls ${missing.join(', ')}, which nothing defines. At runtime this `
      + 'throws a ReferenceError mid-handler: the optimistic UI above it has already run, the POST '
      + 'below it never fires, and the `finally` that clears wrapInFlight is skipped — so the wrap '
      + 'never starts and Cancel stays disabled. `node --check` will not catch it.');
  });
});
