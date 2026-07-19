'use strict';

/*
 * Tests for #623 — Create Project was a full-width bottom drawer.
 *
 * The dialog rendered as `.drawer` (fixed to the bottom, `max-height: 70vh`,
 * full bleed left-to-right), so on a phone its fields ran off the bottom of the
 * screen. Every other dialog in the app already used a centered
 * `.modal-backdrop` / `.modal-content` that caps at 90vh and scrolls
 * internally — the fix was to adopt it, not to invent anything.
 *
 * Three things have to hold together, and two of them are the kind that break
 * silently:
 *
 *   1. The markup nests the dialog INSIDE the backdrop. That is what makes it
 *      center — but it also means an unguarded backdrop click handler would
 *      close the modal on every click inside the form.
 *   2. `.drawer-header` / `.steps-row` carry `padding: 0 16px` from the
 *      bottom-sheet era, where the drawer itself had no horizontal padding.
 *      The modal container owns that inset now, so those must be neutralized
 *      or the header sits 16px inside the body's left edge.
 *   3. `sw.js`'s CACHE_NAME must move whenever a cached `public/*` asset
 *      changes, or the operator keeps being served the old UI and the fix is
 *      invisible to the only person who reported it.
 *
 * Pinned by source probes — the documented scope limit of the zero-dep /
 * no-browser-harness choice (same pattern as paste-affordance.test.js).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('Create Project modal (#623)', () => {
  const html = read('public/index.html');
  const css = read('public/style.css');
  const ui = read('public/ui.js');

  describe('markup', () => {
    it('renders the dialog inside a centered modal backdrop', () => {
      const idx = html.indexOf('id="createBackdrop"');
      assert.notEqual(idx, -1, 'createBackdrop must exist');
      const openTag = html.slice(html.lastIndexOf('<', idx), html.indexOf('>', idx) + 1);
      assert.match(openTag, /class="modal-backdrop"/,
        'createBackdrop must be a .modal-backdrop (centered), not a .drawer-backdrop');
    });

    it('gives the dialog the create-modal content class', () => {
      assert.match(html, /class="modal-content create-modal"[^>]*id="createModal"/,
        'the dialog must use .modal-content.create-modal');
    });

    it('nests the dialog INSIDE the backdrop (this is what centers it)', () => {
      const backdrop = html.indexOf('id="createBackdrop"');
      const dialog = html.indexOf('id="createModal"');
      const closingDiv = html.indexOf('</div>', dialog);
      assert.ok(backdrop < dialog, 'dialog must come after the backdrop opening tag');
      assert.ok(dialog < closingDiv, 'dialog must be nested, not a sibling');
    });

    it('no longer renders a bottom-sheet grab handle', () => {
      // A drag handle is bottom-sheet affordance; it reads as a bug on a
      // centered modal that cannot be dragged.
      const start = html.indexOf('id="createBackdrop"');
      const end = html.indexOf('id="createBody"');
      assert.doesNotMatch(html.slice(start, end), /drawer-handle/,
        'the grab handle must not survive into the centered modal');
    });

    it('keeps the accessible dialog semantics', () => {
      const idx = html.indexOf('id="createModal"');
      const openTag = html.slice(html.lastIndexOf('<', idx), html.indexOf('>', idx) + 1);
      assert.match(openTag, /role="dialog"/);
      assert.match(openTag, /aria-modal="true"/);
      assert.match(openTag, /aria-label=/);
    });

    it('does not leave a bottom-sheet drawer in the landing markup', () => {
      assert.doesNotMatch(html, /class="drawer"/,
        'index.html should have no bottom-sheet drawer left');
      assert.doesNotMatch(html, /class="drawer-backdrop"/,
        'index.html should have no drawer-backdrop left');
    });
  });

  describe('styling', () => {
    const block = (() => {
      const start = css.indexOf('.modal-content.create-modal {');
      assert.notEqual(start, -1, '.modal-content.create-modal rule must exist');
      return css.slice(start, css.indexOf('}', start));
    })();

    it('caps at the viewport so the dialog never grows off-screen', () => {
      assert.match(block, /max-height:\s*90vh/);
    });

    it('uses the flex-column split so the body can scroll under a fixed header', () => {
      assert.match(block, /display:\s*flex/);
      assert.match(block, /flex-direction:\s*column/);
      assert.match(block, /overflow:\s*hidden/,
        'the container must not scroll — the inner body owns the scroll');
    });

    it('makes the body the scrolling region', () => {
      const start = css.indexOf('.modal-content.create-modal > .create-modal-body');
      assert.notEqual(start, -1);
      const body = css.slice(start, css.indexOf('}', start));
      assert.match(body, /overflow-y:\s*auto/);
      assert.match(body, /min-height:\s*0/,
        'a flex child needs min-height:0 to shrink below content height and scroll');
    });

    it('keeps the header and step dots from shrinking when the body scrolls', () => {
      const start = css.indexOf('.modal-content.create-modal > .create-modal-header');
      assert.notEqual(start, -1);
      const rule = css.slice(start, css.indexOf('}', start));
      assert.match(rule, /flex-shrink:\s*0/);
    });

    it('carries no drawer-era horizontal inset on the modal children', () => {
      // The old `.drawer-header`/`.drawer-body`/`.steps-row` rules used
      // `padding: 0 16px` because the bottom sheet had no padding of its own.
      // The modal container owns that inset now, so a surviving `0 16px` would
      // push the header 16px inside the form fields' left edge.
      for (const sel of ['.create-modal-header', '.create-modal-body', '.steps-row']) {
        const start = css.indexOf('\n' + sel + ' {');
        assert.notEqual(start, -1, sel + ' rule must exist');
        const rule = css.slice(start, css.indexOf('}', start));
        assert.doesNotMatch(rule, /padding:\s*0\s+16px/,
          sel + ' must not keep the bottom-sheet horizontal inset');
      }
    });

    it('removes the bottom-sheet rules that no longer have a consumer', () => {
      // index.html no longer uses them and session.html loads session.css
      // (which carries its own copies), so these matched nothing in style.css.
      for (const sel of ['\n.drawer {', '\n.drawer.open', '\n.drawer-backdrop', '\n.drawer-handle']) {
        assert.equal(css.indexOf(sel), -1, 'dead rule must be deleted: ' + sel.trim());
      }
    });

    it('is declared with a two-class selector so a reorder cannot break it', () => {
      // Order-independence, not order-exploitation: this block currently sits
      // AFTER the base `.modal-content` rule, so a single-class `.create-modal`
      // would win today purely on source order — and silently stop winning if
      // the block were ever moved above it. The two-class form outranks the
      // base on specificity regardless of position.
      const baseIdx = css.indexOf('\n.modal-content {');
      const createIdx = css.indexOf('.modal-content.create-modal {');
      assert.notEqual(baseIdx, -1);
      assert.notEqual(createIdx, -1);
      // The real property: no BARE `.create-modal {` selector exists. That is
      // what would silently start losing to the base rule after a reorder —
      // asserting the two-class string at an index derived from that same
      // string could not fail.
      assert.equal(css.search(/(^|[\s,}])\.create-modal\s*\{/m), -1,
        'must be the two-class form (.modal-content.create-modal), not a bare .create-modal');
    });
  });

  describe('behavior', () => {
    it('toggles .open on the backdrop only', () => {
      // The content's transition is driven by `.modal-backdrop.open
      // .modal-content`; adding .open to the content too would be dead state.
      const open = ui.slice(ui.indexOf('function openCreateModal('), ui.indexOf('function closeCreateModal('));
      assert.match(open, /getElementById\('createBackdrop'\)\.classList\.add\('open'\)/);
      assert.doesNotMatch(open, /getElementById\('createModal'\)\.classList\.add\('open'\)/,
        'the nested content must not carry .open');
    });

    it('guards the backdrop click so clicks inside the form do not close it', () => {
      // The regression this prevents is severe and silent: every click on a
      // field would dismiss the dialog mid-entry.
      const line = ui.split('\n').find((l) => l.includes("$('createBackdrop').addEventListener('click'"));
      assert.ok(line, 'backdrop click handler must exist');
      assert.match(line, /e\.target === e\.currentTarget/,
        'must only close when the backdrop itself is clicked');
    });
  });

  describe('cache busting', () => {
    it('bumps CACHE_NAME past the revision that shipped the drawer', () => {
      // public/* assets are precached; without a bump the operator is served
      // the old UI and the fix is invisible to them.
      const sw = read('public/sw.js');
      const m = sw.match(/const CACHE_NAME = 'tangleclaw-v3-(\d+)'/);
      assert.ok(m, 'CACHE_NAME must match the expected format');
      assert.ok(Number(m[1]) >= 54,
        `CACHE_NAME must be >= v3-54 (v3-53 shipped the drawer); found v3-${m[1]}`);
    });

    it('still precaches the assets this change touched', () => {
      const sw = read('public/sw.js');
      assert.match(sw, /'\/ui\.js'/);
      assert.match(sw, /'\/style\.css'|'\/index\.html'|'\/'/);
    });
  });
});
