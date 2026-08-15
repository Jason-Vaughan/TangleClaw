'use strict';

/*
 * UB (#228/#229) — the self-update action, and the parts of it that can only
 * be pinned rather than run.
 *
 * This file used to be `ub-self-update-pill.test.js` and was almost entirely
 * source-level assertions over `public/landing.js`: that the button was
 * rendered, that the flow POSTed the right routes, that the dirty-tree
 * branches existed. #931 moved that flow into `public/update-beacon.js` so the
 * session page could run the SAME one, and every behavioral claim those pins
 * made is now asserted by EXECUTION in `test/update-beacon.test.js` — through
 * the real `api()` chain, which is the only way to tell a live branch from a
 * dead one (the #928 R-1 lesson, where a pin proved a dirty-tree branch
 * existed while `api()`'s null-on-409 made it unreachable).
 *
 * What is left here is what running the code cannot check: the stylesheet, and
 * the one structural invariant that spans files — that no page has grown its
 * own copy of the update flow.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');

describe('UB self-update action (#228/#229)', () => {
  let css, beacon, landing, session;

  before(() => {
    css = fs.readFileSync(path.join(PUB, 'beacon.css'), 'utf8');
    beacon = fs.readFileSync(path.join(PUB, 'update-beacon.js'), 'utf8');
    landing = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');
    session = fs.readFileSync(path.join(PUB, 'session.js'), 'utf8');
  });

  describe('one flow, not one per page (#931)', () => {
    it('only the beacon POSTs the apply route', () => {
      // The invariant the #931 rewrite exists to create. A second copy is how
      // the dashboard pill and the session badge drifted into two different
      // answers to the same question in the first place — and a copy would
      // silently miss the next fix to the #711 dirty-tree handling.
      assert.equal((beacon.match(/'\/api\/update\/apply'/g) || []).length, 2,
        'exactly the first apply and the #711 discard-and-retry');
      for (const [name, src] of [['landing.js', landing], ['session.js', session]]) {
        assert.doesNotMatch(src, /\/api\/update\/apply/,
          `${name} must reach the applier through the beacon, not directly`);
      }
    });

    it('no timer in the beacon does anything but move a class on the toast', () => {
      // The mechanical boundary that keeps the auto-fade inside the
      // no-UI-timers rule (#98/#268) rather than an exception to it. The
      // behavioral half — what the callbacks actually touch — is executed in
      // update-beacon.test.js; this catches a timer added anywhere else in
      // the file, which that test would not see.
      const timerBodies = [...beacon.matchAll(/global\.setTimeout\(\(\) => \{([\s\S]*?)\n      \}/g)]
        .map((m) => m[1]);
      assert.equal(timerBodies.length, 2, 'the fade and the removal, and nothing else');
      for (const body of timerBodies) {
        assert.doesNotMatch(body, /apiMutate|location|confirm|setDot|alert/,
          'a timer may not act, navigate, or touch the dot — the dot is what '
          + 'makes the fade lossless');
      }
    });

    it('never reloads on a bare timer — the poll aborts without a baseline', () => {
      const helper = fs.readFileSync(path.join(PUB, 'api-helper.js'), 'utf8');
      assert.doesNotMatch(helper, /setTimeout\([^;]*location\.reload/);
      assert.match(helper, /if \(!oldStartedAt\) \{[\s\S]*?restore\(\);[\s\S]*?win\.alert/,
        'no baseline means abort honestly, not reload onto a possibly-dead server');
    });
  });

  describe('CSS', () => {
    it('declares the apply button with a hover + disabled treatment', () => {
      assert.match(css, /\.beacon-toast-apply\s*\{/);
      assert.match(css, /\.beacon-toast-apply:hover:not\(:disabled\)/);
      assert.match(css, /\.beacon-toast-apply:disabled/);
    });

    it('holds the 44px floor for EVERY control, not just the one a review named', () => {
      // The Critic's round pointed at the dot; the dot was fixed and its three
      // siblings were not — the primary action of the whole feature stayed
      // ~24px tall on a phone-first product. That is
      // `feedback_verify_mechanism_uniformity` applied to a RULE rather than a
      // verb: one call site is not the family. This guard is the family.
      // Sliced to the rule's own closing brace rather than a fixed character
      // window: a comment added inside a rule must not push its declarations
      // out of the guard's view, which is how a real 44px could read as absent
      // (or a missing one as present, from the NEXT rule).
      const ruleBody = (sel) => {
        const at = css.indexOf(`${sel} {`);
        assert.notEqual(at, -1, `${sel} must exist`);
        return css.slice(at, css.indexOf('}', at));
      };
      for (const control of ['.beacon-toast-apply', '.beacon-toast-secondary',
        '.beacon-toast-close']) {
        assert.match(ruleBody(control), /min-height:\s*44px/,
          `${control} must reach the recorded 44px floor`);
      }
      assert.match(ruleBody('.beacon-toast-close'), /min-width:\s*44px/,
        'the ✕ is a glyph — it needs the width as much as the height');
      // THE MUTATION THIS CATCHES: raising one control and leaving the rest,
      // which is exactly what shipped before the PR review swept them.
    });

    it('gives the dot a 44px tap target — the recorded floor, asserted as a number', () => {
      // 11px of red is the visual; the hit area is the ::after. The previous
      // guard asserted only that SOME negative inset existed, which passed at
      // 31px — under the floor `project-preferences.md` records — and two
      // reviewers derived two different sizes from it. A dimension the norm
      // states as a number is asserted here as a number.
      const rule = css.slice(css.indexOf('.beacon-dot::after'));
      assert.match(rule.slice(0, 220), /width:\s*44px/);
      assert.match(rule.slice(0, 220), /height:\s*44px/);
      assert.match(rule.slice(0, 220), /transform:\s*translate\(-50%,\s*-50%\)/,
        'centred on the dot, so the number does not depend on box-sizing');
    });

    it('gives the dot a visible focus state', () => {
      assert.match(css, /\.beacon-dot:focus-visible\s*\{[\s\S]*?outline:/);
    });

    it('survives both pages\' global reduced-motion animation kill', () => {
      // Each page stylesheet carries `* { animation: none !important }` under
      // prefers-reduced-motion, so the beacon CANNOT rely on an animation
      // completing for anything load-bearing. It does not: the toast is removed
      // by its own timer. This pins the page-level rule that makes the beacon's
      // behavior independent of it, so a future removal of that rule is a
      // deliberate act rather than an accident.
      for (const sheet of ['style.css', 'session.css']) {
        const text = fs.readFileSync(path.join(PUB, sheet), 'utf8');
        const reduced = text.slice(text.indexOf('@media (prefers-reduced-motion: reduce)'));
        assert.match(reduced.slice(0, 200), /animation:\s*none\s*!important/,
          `${sheet} disables animation under reduced motion`);
      }
      assert.doesNotMatch(css, /@media \(prefers-reduced-motion/,
        'and beacon.css must not carry a rule that could never win — unreachable '
        + 'CSS that looks like a guarantee is worse than no rule');
    });

    it('has no stylesheet left for the surfaces the beacon replaced', () => {
      // Checked in the PAGE stylesheets, which is where the dead rules were.
      for (const sheet of ['style.css', 'session.css']) {
        const text = fs.readFileSync(path.join(PUB, sheet), 'utf8');
        for (const dead of ['.update-pill', '.update-badge']) {
          assert.ok(!text.includes(dead), `${dead} rules must not outlive their markup (${sheet})`);
        }
      }
    });
  });
});
