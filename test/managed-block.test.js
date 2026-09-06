'use strict';

// Covers: `lib/managed-block.js` — the splice that both the engine-config layer
// and the wrap pipeline's priming roll now share (#1132). The policy questions
// live here; each caller's own test file pins what IT passes in, because a call
// site's arguments are code that a test of the callee does not cover.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  spliceManagedBlock, extractManagedBlock, _markerFault, _managedSpans
} = require('../lib/managed-block');

const MARKERS = { begin: '<!-- BEGIN:tc -->', end: '<!-- END:tc -->' };
const { begin: B, end: E } = MARKERS;

/**
 * Splice and assert the call was allowed, so a refusal can never masquerade as
 * a passing assertion about content.
 * @param {string} existing - Current file contents
 * @param {string} body - Generated body for the managed block
 * @param {object} [markers] - Marker pair to use
 * @returns {string} The merged file content
 */
function splice(existing, body, markers = MARKERS) {
  const { merged, error } = spliceManagedBlock(existing, body, markers);
  assert.equal(error, null, `splice refused: ${error}`);
  return merged;
}

describe('a well-formed file is spliced, and nothing outside the region moves', () => {
  test('an existing block is replaced in place', () => {
    const prior = `head\n${B}\nold\n${E}\ntail`;
    assert.equal(splice(prior, 'new'), `head\n${B}\nnew\n${E}\ntail`);
  });

  test('an absent block is appended after one blank line', () => {
    assert.equal(splice('prose', 'body'), `prose\n\n${B}\nbody\n${E}\n`);
  });

  test('an empty file gets the block with no leading whitespace', () => {
    assert.equal(splice('', 'body'), `${B}\nbody\n${E}\n`);
  });

  test('a foreign vendor block in the same file is untouched', () => {
    // The reason this mechanism exists: `next dev` re-adds its own block to the
    // same AGENTS.md on every run, and the operator writes there too.
    const prior = `<!-- BEGIN:nextjs-agent-rules -->\nvendor\n<!-- END:nextjs-agent-rules -->\n\n${B}\nours\n${E}\n`;
    const out = splice(prior, 'ours v2');
    assert.match(out, /^<!-- BEGIN:nextjs-agent-rules -->\nvendor\n<!-- END:nextjs-agent-rules -->\n/);
    assert.ok(!/\bours\n/.test(out), 'only our body is replaced');
  });
});

describe('a broken marker set is repaired, never guessed at', () => {
  test('a begin nothing closed keeps the text after it', () => {
    assert.equal(splice(`head\n${B}\ntheirs`, 'body'), `head\n${B}\nbody\n${E}\ntheirs`);
  });

  test('an end nothing opened keeps the text around it', () => {
    assert.equal(splice(`head\n${E}\ntheirs`, 'body'), `head\n${B}\nbody\n${E}\ntheirs`);
  });

  test('misordered markers keep the prose between them, outside the repaired block', () => {
    const out = splice(`${E}\nkeep me\n${B}\n`, 'body');
    assert.match(out, /keep me/);
    // Mutation this catches: treating the span between a stray end and a stray
    // begin as OUR body and dropping it — the failure the old refusal existed
    // to prevent, which repair has to prevent by construction instead.
    assert.ok(out.indexOf('keep me') > out.indexOf(E), 'their prose lands outside our region');
  });

  test('duplicated blocks collapse; only bodies between our own markers go', () => {
    const out = splice(`${B}\na\n${E}\nmiddle\n${B}\nb\n${E}\n`, 'fresh');
    // The trailing newline followed the SECOND block and was never inside it,
    // so it survives the collapse.
    assert.equal(out, `${B}\nfresh\n${E}\nmiddle\n\n`);
  });

  test('the repaired block keeps its position rather than migrating to the end', () => {
    // A managed block earns its keep by sitting among the other writers'
    // sections. Mutation this catches: repairing by stripping markers and
    // appending, which silently relocates our region on every broken file.
    const out = splice(`top\n${E}\nmid\nbottom`, 'body');
    assert.ok(out.indexOf(B) < out.indexOf('mid'), 'the block stays where the marker was');
    assert.match(out, /^top\n/);
  });

  test('every broken shape is byte-identical on the second pass', () => {
    const broken = [
      `head\n${B}\ntheirs`,
      `head\n${E}\ntheirs`,
      `${E}\nkeep me\n${B}\n`,
      `${B}\na\n${E}\nmiddle\n${B}\nb\n${E}\n`,
      `${B}\n${B}\n${E}\n${E}\n`,
      `${E}${B}`
    ];
    for (const prior of broken) {
      const once = splice(prior, 'body');
      assert.equal(splice(once, 'body'), once, `not idempotent for ${JSON.stringify(prior)}`);
      assert.equal(once.split(B).length - 1, 1, `not one begin for ${JSON.stringify(prior)}`);
      assert.equal(once.split(E).length - 1, 1, `not one end for ${JSON.stringify(prior)}`);
    }
  });

  test('repeated splices against a malformed file do not grow it', () => {
    // #1132's acceptance criterion, stated as the property rather than as one
    // re-run: the old append added a block per pass, forever.
    let file = `${E}\nkeep me\n${B}\n`;
    const sizes = [];
    for (let pass = 0; pass < 5; pass += 1) {
      file = splice(file, `body ${pass}`);
      sizes.push(file.length);
    }
    assert.equal(new Set(sizes.slice(1)).size, 1, `file kept growing: ${sizes}`);
    assert.match(file, /keep me/, 'their prose survives every pass, not just the first');
  });
});

describe('a marker literal in the body is refused, because repair cannot undo it', () => {
  test('a begin literal is refused and nothing is spliced', () => {
    const { merged, error } = spliceManagedBlock('file', `body ${B} more`, MARKERS);
    assert.equal(merged, null);
    assert.match(error, /marker literal/);
  });

  test('an end literal is refused', () => {
    assert.equal(spliceManagedBlock('file', `body ${E}`, MARKERS).merged, null);
  });

  test('the caller\'s hint names where the literal came from', () => {
    const { error } = spliceManagedBlock('file', B, MARKERS, { bodySourceHint: 'check the shared doc' });
    assert.match(error, /check the shared doc/);
  });

  test('a refusal leaves the file writable by the next clean body', () => {
    assert.equal(spliceManagedBlock('file', B, MARKERS).merged, null);
    const recovered = spliceManagedBlock('file', 'clean', MARKERS);
    assert.equal(recovered.error, null);
    assert.match(recovered.merged, /clean/);
  });
});

describe('a marker pair that cannot delimit a region is a caller fault, reported as one', () => {
  test('identical markers are refused', () => {
    const { merged, error } = spliceManagedBlock('x', 'body', { begin: '#tc', end: '#tc' });
    assert.equal(merged, null);
    assert.match(error, /identical/);
  });

  test('nested markers are refused — the scan could not tell them apart', () => {
    // Mutation this catches: dropping the overlap check. `indexOf` for the
    // shorter marker would match inside the longer one, so every begin would
    // also register as an end and the spans would be nonsense.
    const { merged, error } = spliceManagedBlock('x', 'body', { begin: '<!-- tc:begin -->', end: 'tc:begin' });
    assert.equal(merged, null);
    assert.match(error, /overlap/);
  });

  test('a missing form is refused rather than defaulted', () => {
    assert.match(spliceManagedBlock('x', 'body', { begin: '', end: E }).error, /missing/);
    assert.match(_markerFault(null), /missing/);
  });
});

describe('extractManagedBlock reads only an established block', () => {
  test('it returns the body between the first complete pair', () => {
    assert.equal(extractManagedBlock(`h\n${B}\nbody\n${E}\nt`, MARKERS), '\nbody\n');
  });

  test('an empty block reads as empty, not as absent', () => {
    // A caller comparing bodies to detect drift has to tell those apart.
    assert.equal(extractManagedBlock(`${B}${E}`, MARKERS), '');
  });

  test('a file with no complete pair reads as null', () => {
    assert.equal(extractManagedBlock(`${B}\nno close`, MARKERS), null);
    assert.equal(extractManagedBlock(`${E}\nprose\n${B}`, MARKERS), null);
    assert.equal(extractManagedBlock('nothing here', MARKERS), null);
  });

  test('an unusable marker pair reads as null rather than throwing', () => {
    assert.equal(extractManagedBlock('x', { begin: '#a', end: '#a' }), null);
  });
});

describe('span classification', () => {
  test('a complete pair is one span, and strays are their own', () => {
    const spans = _managedSpans(`${E}x${B}y${E}z${B}`, MARKERS);
    assert.deepEqual(spans.map((s) => s.complete), [false, true, false]);
  });

  test('spans come back in document order', () => {
    const spans = _managedSpans(`${B}a${E}${B}b${E}`, MARKERS);
    assert.deepEqual(spans.map((s) => s.start), [...spans.map((s) => s.start)].sort((a, b) => a - b));
  });
});
