'use strict';

/*
 * A TEXT scan of lib/master.js, deliberately WITHOUT requiring it.
 *
 * The Project Master's write guard is generated from a template literal inside
 * `buildMasterGuardScript`. A backtick anywhere in that template — including in
 * one of its comments — ends the string early and makes lib/master.js a syntax
 * error, which takes the whole module down at REQUIRE time. That happened three
 * times while #755 was being built.
 *
 * Every other guard for it lives in test/master.test.js, which `require`s the
 * module — so when this failure occurs, those tests do not report it, they
 * simply all die at once with the same opaque parse error. This file reads the
 * source as text and never imports it, so it survives to name the cause.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'master.js'), 'utf8');

/**
 * Slice out the guard-script template literal by its delimiters.
 * @returns {string} The template body.
 */
function guardTemplate() {
  const open = SRC.indexOf('return `#!/usr/bin/env node');
  assert.notEqual(open, -1, 'the guard template must still be a template literal starting this way');
  const bodyStart = open + 'return `'.length;
  const close = SRC.indexOf('\n`;', bodyStart);
  assert.notEqual(close, -1, 'the guard template must terminate');
  return SRC.slice(bodyStart, close);
}

describe('the generated write guard, scanned as source', () => {
  it('contains no backtick, which would end its own template literal', () => {
    const body = guardTemplate();
    const line = body.split('\n').findIndex((l) => l.includes('`'));
    assert.equal(line, -1,
      'a backtick inside buildMasterGuardScript ends the template early and breaks lib/master.js at '
      + `require time — offending line: ${line === -1 ? '' : body.split('\n')[line].trim()}`);
  });

  it('still ends every decision path in an explicit decision', () => {
    // The property the whole guard rests on: the harness fails OPEN on hook
    // crashes, so a path that neither denies nor decides is a path that writes.
    const body = guardTemplate();
    assert.match(body, /function readLevel\(\)/);
    assert.match(body, /return \{ level: 'read-only', degraded: true \};/,
      'unrecognised and unreadable levels must resolve to read-only');
    assert.match(body, /if \(resolved === null\) \{/,
      'an unresolvable path must be denied, never handed to the carve-out test');
  });

  it('resolution failures set the unresolved sentinel, never the lexical path', () => {
    // A SOURCE assertion, and the reason is worth stating: the behavioural
    // version would need `readlinkSync`/`realpathSync` to throw on demand, which
    // cannot be staged portably. Left ungated, the mutation that matters is
    // invisible — `resolved = lexical` in the catch READS as a safe fallback and
    // is the opposite: for anything under memory/ the lexical path starts with
    // memoryDir, so the carve-out test ALLOWS it. "Fall back to lexical" is only
    // restrictive for targets already outside, which are not the interesting
    // ones. Verified by mutation: swapping the sentinel for `lexical` turns this
    // red and nothing else in the suite notices.
    // Anchored BACKWARDS from the sentinel test, not forwards from the `let`:
    // there is an inner catch around the lstat hop, and searching forwards found
    // that one instead — the assertion then measured the wrong block and failed
    // against correct code.
    const body = guardTemplate();
    const sentinel = body.indexOf('  if (resolved === null) {');
    assert.notEqual(sentinel, -1, 'the unresolved test must exist');
    const outerCatch = body.slice(body.lastIndexOf('} catch (err) {', sentinel), sentinel);
    assert.match(outerCatch, /resolved = null;/,
      'the catch must mark the path unresolved, not fall back to the lexical path');
    assert.doesNotMatch(outerCatch, /resolved = lexical;/);
  });
});
