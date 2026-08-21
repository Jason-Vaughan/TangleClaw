'use strict';

/*
 * #1015 — the dashboard renders a session-authored "Next action" as Markdown.
 *
 * `public/next-markdown.js` carries its own `module.exports` shim, so these
 * run the real renderer directly rather than lifting it out of a browser
 * global script. Asserting on OUTPUT is the point: a source guard over a
 * renderer can stay green while the operator sees nothing (learnings, #885).
 *
 * The escaping cases are not decoration. `nextAction` is written by an engine
 * session at wrap and is placed into `innerHTML`, so "no markup survives" is
 * the contract this file exists to hold.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderNextMarkdown, escHtml } = require('../public/next-markdown');

/**
 * Read a file from `public/`.
 *
 * @param {string} name - File name.
 * @returns {string} Its source text.
 */
function pub(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
}

describe('renderNextMarkdown', () => {
  describe('nothing to render', () => {
    // The paths a populated fixture never reaches, and the ones a project
    // with no captured wrap actually takes (learnings, #885).
    it('renders absent input as empty', () => {
      assert.equal(renderNextMarkdown(undefined), '');
      assert.equal(renderNextMarkdown(null), '');
    });

    it('renders an empty string as empty', () => {
      assert.equal(renderNextMarkdown(''), '');
    });

    it('renders whitespace-only input as empty, not as an empty list', () => {
      assert.equal(renderNextMarkdown('   \n\n \t \n'), '');
    });
  });

  describe('bullets', () => {
    it('groups consecutive dash bullets into one list', () => {
      assert.equal(
        renderNextMarkdown('- first\n- second'),
        '<ul class="next-list"><li>first</li><li>second</li></ul>'
      );
    });

    it('accepts asterisk bullets', () => {
      assert.equal(
        renderNextMarkdown('* only'),
        '<ul class="next-list"><li>only</li></ul>'
      );
    });

    it('closes the list on a blank line and opens a new one after', () => {
      assert.equal(
        renderNextMarkdown('- a\n\n- b'),
        '<ul class="next-list"><li>a</li></ul><ul class="next-list"><li>b</li></ul>'
      );
    });

    it('closes an open list before a paragraph', () => {
      assert.equal(
        renderNextMarkdown('- a\ntrailing prose'),
        '<ul class="next-list"><li>a</li></ul><p>trailing prose</p>'
      );
    });

    it('does not treat a bold run at line start as a bullet', () => {
      // `**bold**` begins with `*` but has no space after it, so the bullet
      // pattern must not claim it.
      assert.equal(renderNextMarkdown('**done** already'),
        '<p><strong>done</strong> already</p>');
    });

    it('leaves a bare dash with no text as a paragraph', () => {
      assert.equal(renderNextMarkdown('-'), '<p>-</p>');
    });
  });

  describe('inline marks', () => {
    it('renders inline code', () => {
      assert.equal(renderNextMarkdown('run `npm test` now'),
        '<p>run <code>npm test</code> now</p>');
    });

    it('renders bold', () => {
      assert.equal(renderNextMarkdown('this is **important**'),
        '<p>this is <strong>important</strong></p>');
    });

    it('does not apply bold inside a code span', () => {
      // A single alternating pass consumes the code span first, so the
      // asterisks inside it stay literal rather than becoming <strong>.
      assert.equal(renderNextMarkdown('`a **b** c`'),
        '<p><code>a **b** c</code></p>');
    });

    it('applies marks inside a bullet', () => {
      assert.equal(
        renderNextMarkdown('- ship `lib/x.js` and **stop**'),
        '<ul class="next-list"><li>ship <code>lib/x.js</code> and <strong>stop</strong></li></ul>'
      );
    });

    it('leaves an unpaired backtick literal', () => {
      assert.equal(renderNextMarkdown('a ` b'), '<p>a ` b</p>');
    });
  });

  describe('escaping — nothing authored by a session becomes markup', () => {
    it('escapes a script tag rather than emitting it', () => {
      const html = renderNextMarkdown('- <script>alert(1)</script>');
      assert.ok(!html.includes('<script'), 'no live script tag may survive');
      assert.ok(html.includes('&lt;script&gt;'), 'it must appear as text');
    });

    it('escapes an img onerror payload', () => {
      const html = renderNextMarkdown('<img src=x onerror="alert(1)">');
      assert.ok(!html.includes('<img'), 'no live img tag may survive');
      assert.ok(!html.includes('onerror="'), 'no live attribute may survive');
    });

    it('escapes a tag written inside a code span', () => {
      // The real case from the portfolio wrap: `<h2>` in backticks. It must
      // become a code span CONTAINING escaped text, not a live element.
      assert.equal(
        renderNextMarkdown('- trim the duplicate `<h2>`'),
        '<ul class="next-list"><li>trim the duplicate <code>&lt;h2&gt;</code></li></ul>'
      );
    });

    it('escapes ampersands and quotes', () => {
      assert.equal(renderNextMarkdown('a & "b" \'c\''),
        '<p>a &amp; &quot;b&quot; &#39;c&#39;</p>');
    });

    it('escapes before applying marks, so markup cannot be built across them', () => {
      // If marks were applied to raw text, the closing backtick could be used
      // to break out of the code span into a live attribute.
      const html = renderNextMarkdown('`<a href="x">`');
      assert.ok(!html.includes('href="x"'), 'no live href may be assembled');
    });
  });

  describe('real wrap data', () => {
    it('renders a multi-bullet next action as a list, not one flat line', () => {
      const real = [
        '- #89 — swap hero screenshots for 4.0 captures once they land',
        '- #82 — cert issuer logos + per-card OG-preview stubs',
        '- Accessibility/contrast pass (**WCAG AA fail** on tag-pill text)',
        '- Next cut is 0.3.0 — `[Unreleased]` holds 2× Added, 3× Changed'
      ].join('\n');

      const html = renderNextMarkdown(real);
      assert.equal((html.match(/<li>/g) || []).length, 4);
      assert.equal((html.match(/<ul class="next-list">/g) || []).length, 1);
      assert.ok(html.includes('<strong>WCAG AA fail</strong>'));
      assert.ok(html.includes('<code>[Unreleased]</code>'));
      // The defect this feature exists to fix: the markers must be gone.
      assert.ok(!html.includes('- #89'), 'raw bullet markers must not survive');
    });
  });
});

describe('delivery to the browser', () => {
  it('is loaded by index.html before ui.js', () => {
    // ui.js calls renderNextMarkdown while drawing a card, so a later tag
    // would be a ReferenceError on first render, not a late enhancement.
    const html = pub('index.html');
    const mine = html.indexOf('/next-markdown.js');
    const ui = html.indexOf('/ui.js"');
    assert.notEqual(mine, -1, 'index.html must load next-markdown.js');
    assert.ok(mine < ui, 'next-markdown.js must be loaded before ui.js');
  });

  it('is precached, so a cold miss cannot blank the dashboard', () => {
    // Network-first alone leaves a window: a MISS while the network is down
    // returns sw.js's synthetic JSON 503, and a `<script src>` served a 503
    // never defines the global — so ui.js throws while drawing the first card
    // and the operator gets no dashboard at all.
    const sw = pub('sw.js');
    const assets = sw.slice(sw.indexOf('STATIC_ASSETS'), sw.indexOf('NETWORK_FIRST_PATHS'));
    assert.match(assets, /'\/next-markdown\.js'/,
      'a parse-time dependency must be precached, not only network-first');
  });

  it('is network-first, so it stays in lockstep with ui.js', () => {
    // ui.js is network-first; a cache-first helper served against a fresh
    // ui.js is the version skew #268 hit between session.js and wrap-drawer.js.
    const sw = pub('sw.js');
    const set = sw.slice(sw.indexOf('NETWORK_FIRST_PATHS'), sw.indexOf('addEventListener'));
    assert.match(set, /'\/next-markdown\.js'/,
      'next-markdown.js must be network-first like ui.js itself');
  });
});

describe('escHtml', () => {
  it('escapes every character that can start markup', () => {
    assert.equal(escHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  });

  it('coerces non-strings rather than throwing', () => {
    assert.equal(escHtml(42), '42');
    assert.equal(escHtml(null), 'null');
  });
});
