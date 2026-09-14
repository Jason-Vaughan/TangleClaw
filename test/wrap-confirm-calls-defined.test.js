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
 *     finally { wrapInFlight = false; }           // never runs (the flag of the time)
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
 * a guard nobody trusts gets deleted. The surface is the named functions below.
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
const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'encodeURIComponent', 'setTimeout', 'clearTimeout']);

/**
 * Slice one top-level function's source out of a file by brace-matching.
 * @param {string} src - File source
 * @param {string} name - Function name
 * @returns {string} The function, or '' when absent
 */
function functionSource(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) return '';
  const bodyStart = src.indexOf('{', src.indexOf(')', m.index));
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return '';
}

// Everything a Wrap press runs through before the pipeline's own frames arrive:
// the confirm handler, the POST it shares with Retry, and the controller
// dispatch and effects both of them feed.
const WRAP_PATH = [
  'confirmWrap', 'postWrap', 'retryWrap', 'dispatchWrapRun', 'syncWrapRunEffects',
  'paintWrapRun', 'startWrapStream', 'scheduleWrapStatusPoll', 'restoreWrapRunOnLoad'
];

describe('the wrap-confirm path calls only functions that exist', () => {
  const session = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
  const helper = fs.readFileSync(path.join(PUBLIC, 'api-helper.js'), 'utf8');
  const bodies = WRAP_PATH.map((name) => [name, functionSource(session, name)]);

  it('the wrap-confirm path is still locatable (the scan has something to read)', () => {
    // Without this the extraction could silently yield an empty string and the
    // assertion below would pass on zero calls — green, and measuring nothing.
    for (const [name, body] of bodies) {
      assert.ok(body.length > 0, `could not find ${name} in session.js`);
    }
  });

  it('every function it calls is defined in session.js or api-helper.js', () => {
    // Single-quoted strings are blanked too: notice copy like "killed mid-run
    // (most likely …)" reads as a call to `run`.
    const body = stripComments(bodies.map(([, b]) => b).join('\n')).replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    const called = [...new Set(
      [...body.matchAll(/(?:^|[^\w$.])([a-z_][\w$]*)\s*\(/g)].map((m) => m[1])
    )].filter((n) => !NOT_FUNCTIONS.has(n));

    assert.ok(called.length >= 15,
      `expected the wrap path to call many helpers, found ${called.length} — the extraction is probably wrong`);

    const defined = new Set([...definedNames(stripComments(session)), ...definedNames(stripComments(helper))]);
    const missing = called.filter((n) => !defined.has(n));

    assert.deepEqual(missing, [],
      `the wrap path calls ${missing.join(', ')}, which nothing defines. At runtime this `
      + 'throws a ReferenceError mid-handler: the optimistic UI above it has already run, the POST '
      + 'below it never fires, and the `finally` that re-enables the modal is skipped — so the wrap '
      + 'never starts and Cancel stays disabled. `node --check` will not catch it.');
  });
});
