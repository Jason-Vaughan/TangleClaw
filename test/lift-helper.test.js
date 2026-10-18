'use strict';

/**
 * Contract for `test/helpers/lift.js`, the shared brace-matcher that lifts
 * shipped browser functions out of `public/*.js` for a test to run (#1903).
 *
 * About ninety test files carry a private copy of the same matcher, and copies
 * drift: one copy of `esc` accepted fewer types than the shipped one. These
 * cases pin the helper to exactly what the copies do today, limitations
 * included, so moving a test onto it cannot change what that test lifts. The
 * inventory at the bottom records every copy, so a new one fails here and each
 * migration shrinks the list in the same change.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lift = require('./helpers/lift');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

describe('test/helpers/lift.js — the shared brace-matcher (#1903)', () => {
  const SRC = [
    'const before = 1;',
    'function outer(a) {',
    '  if (a) { return { a }; }',
    '  return null;',
    '}',
    'function after() { return 2; }'
  ].join('\n');

  it('liftDeclaration returns the declaration through the brace that closes its body', () => {
    assert.equal(lift.liftDeclaration(SRC, 'function outer('),
      'function outer(a) {\n  if (a) { return { a }; }\n  return null;\n}');
  });

  it('liftBody returns the body alone, from its opening brace through its closing one', () => {
    assert.equal(lift.liftBody(SRC, 'function outer('),
      '{\n  if (a) { return { a }; }\n  return null;\n}');
  });

  it('names the declaration when it is missing', () => {
    assert.throws(() => lift.liftDeclaration(SRC, 'function absent('),
      (err) => err instanceof assert.AssertionError && /function absent\( must exist/.test(err.message));
    assert.throws(() => lift.liftBody(SRC, 'function absent('),
      (err) => err instanceof assert.AssertionError && /function absent\( must exist/.test(err.message));
  });

  it('names the declaration when its body never closes', () => {
    const open = 'function broken() { if (x) {';
    assert.throws(() => lift.liftDeclaration(open, 'function broken('),
      (err) => err instanceof assert.AssertionError && /function broken\( body must close/.test(err.message));
    assert.throws(() => lift.liftBody(open, 'function broken('),
      (err) => err instanceof assert.AssertionError && /function broken\( body must close/.test(err.message));
    assert.throws(() => lift.liftDeclaration('function bare()', 'function bare('),
      (err) => err instanceof assert.AssertionError && /body must close/.test(err.message),
      'a declaration with no brace anywhere after it does not close either');
  });

  it('counts a brace inside a string or a comment, as every copy does today', () => {
    // A known limitation, pinned on purpose: changing it would change what a
    // migrated test lifts, and that is its own decision.
    const quoted = "function q() { const s = '}'; return s; }\nfunction next() {}";
    assert.equal(lift.liftDeclaration(quoted, 'function q('), "function q() { const s = '}");
    const commented = 'function c() { /* { */ return 1; }\n}\nlater();';
    assert.equal(lift.liftDeclaration(commented, 'function c('),
      'function c() { /* { */ return 1; }\n}', 'the brace in the comment held the body open one line longer');
  });

  it('lifts the first occurrence when the declaration appears twice', () => {
    const twice = 'function d() { return 1; }\nfunction d() { return 2; }';
    assert.equal(lift.liftDeclaration(twice, 'function d('), 'function d() { return 1; }');
  });

  for (const file of ['landing.js', 'session.js']) {
    describe(`loaders run the esc and jsArg shipped in public/${file}`, () => {
      const shipped = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

      it('loadEsc encodes as the shipped esc does, and is built from its text', () => {
        const esc = lift.loadEsc(file);
        assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
        assert.equal(esc(7), '7');
        assert.equal(esc({}), '', 'the shipped esc refuses an object');
        assert.equal(esc.toString(), lift.liftDeclaration(shipped, 'function esc('),
          'a re-implemented esc would pass the behaviour checks; this one would not');
      });

      it('loadJsArg encodes a quote and a backslash, and is built from the shipped text', () => {
        const jsArg = lift.loadJsArg(file);
        assert.equal(jsArg("O'Brien"), '&quot;O&#39;Brien&quot;');
        assert.equal(jsArg('a\\b'), '&quot;a\\\\b&quot;');
        assert.equal(jsArg(undefined), 'null');
        assert.equal(jsArg.toString(), lift.liftDeclaration(shipped, 'function jsArg('));
      });
    });
  }

  it('the loaders default to public/landing.js', () => {
    const landing = fs.readFileSync(path.join(PUBLIC_DIR, 'landing.js'), 'utf8');
    assert.equal(lift.loadEsc().toString(), lift.liftDeclaration(landing, 'function esc('));
    assert.equal(lift.loadJsArg().toString(), lift.liftDeclaration(landing, 'function jsArg('));
  });
});

// ── The inventory of private copies ──────────────────────────────────────────
//
// The rule: a line that searches for '{' with `indexOf`, followed within eight
// lines by depth counting over '{' and '}'. Each match is keyed by its file and
// the helper it sits in (a definition within six lines above it), or
// `(inline)` when it is written straight into a test. Keys repeat when one file
// has several inline copies, so the comparison is a multiset.
//
// What the rule does not find: a matcher that locates its brace another way.
// None of that shape was found when the list was taken; the other depth
// counters in `test/` match `${` interpolations or parentheses, not bodies.

/** Rule matches that are not JS-function lifters, each with why. */
const EXCEPTIONS = {
  'button-touch-targets.test.js :: (inline)': 'reads a CSS @media block, not a function',
  'mobile-toolbar-layout.test.js :: mediaBlocks': 'reads CSS @media blocks, not a function',
  'update-beacon-pages.test.js :: beaconConstruction': 'lifts a call\'s object-literal argument, not a declaration'
};

/**
 * Every private brace-matcher copy when the shared helper landed. A migration
 * removes its file's entries here in the same change; a new copy is refused.
 */
const INITIAL_INVENTORY = [
  'medusa-escalation.test.js :: (inline)',
  'message-size-ui.test.js :: functionSource',
  'openclaw-cache.test.js :: setFrameSrcBlockEnd',
  'panel-toggle-rows.test.js :: liftFunction',
  'paste-affordance.test.js :: functionBody',
  'pill-ux-contract.test.js :: liftFunction',
  'port-owner-kind-panel.test.js :: liftFunction',
  'project-deliveries-ledger.test.js :: functionBody',
  'project-recovery-mode-control.test.js :: lift',
  'project-rules-modal.test.js :: functionBody',
  'project-rules-unknown.test.js :: functionBody',
  'project-tags-shape.test.js :: functionBody',
  'recovery-codes-ui.test.js :: extract',
  'rule-id-display.test.js :: functionBody',
  'select-mode-mouse.test.js :: functionBody',
  'session-checkout-chip.test.js :: extract',
  'session-clipboard.test.js :: functionBody',
  'session-header-cleanup.test.js :: extract',
  'session-relaunch-page.test.js :: functionSource',
  'session-unreachable-state.test.js :: liftFunction',
  'session-update-poll.test.js :: lift',
  'session-wrap-finalize.test.js :: lift',
  'session-wrapper.test.js :: (inline)',
  'session-wrapper.test.js :: (inline)',
  'session-wrapper.test.js :: (inline)',
  'session-wrapper.test.js :: (inline)',
  'session-wrapper.test.js :: (inline)',
  'session-wrapper.test.js :: functionBody',
  'sessions.test.js :: fnBody',
  'setting-disposition.test.js :: declarationSource',
  'settings-index-toggle-render.test.js :: liftFunction',
  'settings-launch-mode-render.test.js :: liftFunction',
  'settings-modal-silentprime.test.js :: (inline)',
  'settings-silent-prime-render.test.js :: liftFunction',
  'setup-wizard-git-unknown.test.js :: liftFunction',
  'startup-prompt-editor.test.js :: liftFunction',
  'stranded-wraps-ui.test.js :: liftFunction',
  'tcc-folders.test.js :: liftFunction',
  'update-prompt-guards.test.js :: functionBody',
  'version-visibility.test.js :: lift',
  'version-visibility.test.js :: extract',
  'wrap-bump-level-askmode.test.js :: functionBody',
  'wrap-confirm-calls-defined.test.js :: functionSource',
  'wrap-drawer-select-a11y.test.js :: functionBody',
  'wrap-ends-session.test.js :: liftFunction',
  'wrap-indicator-card.test.js :: functionBody',
  'wrap-indicator-card.test.js :: body',
  'wrap-indicator-card.test.js :: (inline)',
  'wrap-intent-cancel.test.js :: lift',
  'wrap-intent-cancel.test.js :: save',
  'wrap-release-decision.test.js :: liftFunction',
  'wrap-rule-proposal-widget.test.js :: functionBody',
  'wrap-run-reattach.test.js :: functionBody',
  'wrap-run-session-wiring.test.js :: functionSource',
  'wrap-skip-continue-label.test.js :: functionBody',
  'wrap-untrack-offer-ui.test.js :: liftFunction',
];

/**
 * Find every brace-matcher copy in `test/*.js` by the rule above.
 * @returns {string[]} Keys, `<file> :: <helper>`, sorted.
 */
function scanCopies() {
  const testDir = __dirname;
  const OPEN = /indexOf\(\s*(['"])\{\1/;
  const COUNT_OPEN = /===\s*(['"])\{\1/;
  const CLOSE = /(['"])\}\1/;
  const DEF = /^\s*(?:async\s+)?function\s+(\w+)\s*\(|^\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b|\w+\s*=>)/;
  const found = [];
  const files = fs.readdirSync(testDir)
    .filter((f) => f.endsWith('.js') && f !== path.basename(__filename))
    .sort();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(testDir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!OPEN.test(line)) return;
      const ahead = lines.slice(i, i + 8).join('\n');
      if (!COUNT_OPEN.test(ahead) || !CLOSE.test(ahead)) return;
      let name = '(inline)';
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        const m = lines[j].match(DEF);
        if (m) { name = m[1] || m[2]; break; }
      }
      found.push(`${file} :: ${name}`);
    });
  }
  return found.sort();
}

describe('the inventory of private brace-matcher copies (#1903)', () => {
  it('equals the recorded set exactly: a new copy fails, and so does a removed one until the list shrinks', () => {
    const found = scanCopies();
    const expected = [...INITIAL_INVENTORY, ...Object.keys(EXCEPTIONS)].sort();
    const added = found.filter((k) => expected.filter((e) => e === k).length < found.filter((f) => f === k).length);
    const removed = expected.filter((k) => found.filter((f) => f === k).length < expected.filter((e) => e === k).length);
    assert.deepEqual(found, expected,
      `new copies (use test/helpers/lift.js instead): ${JSON.stringify([...new Set(added)])}; `
      + `copies gone (remove them from INITIAL_INVENTORY): ${JSON.stringify([...new Set(removed)])}`);
  });

  it('does not scan the shared helper itself', () => {
    assert.ok(!scanCopies().some((k) => k.startsWith('helpers/')));
  });
});
