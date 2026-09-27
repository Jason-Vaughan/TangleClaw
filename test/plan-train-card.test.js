'use strict';

/*
 * #1930 — roadmap train cards on served plan pages. A plan is session-authored
 * and served on the dashboard origin, so the contract is the escaping and the
 * closed schema: asserted on rendered OUTPUT through renderPlanBody, the path a
 * reader actually gets.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const planDocs = require('../lib/plan-docs');
const trainCard = require('../lib/plan-train-card');

const REPO = 'https://github.com/Jason-Vaughan/TangleClaw';

/**
 * A valid train, with overrides.
 * @param {object} [over] - Fields to replace.
 * @returns {object}
 */
function train(over = {}) {
  return {
    train: 1,
    title: 'First Install, Completed',
    href: `${REPO}/milestone/5`,
    verified: true,
    thesis: 'The rest of the **first** hour.',
    cars: [
      { issue: 411, closed: false, href: `${REPO}/issues/411`, type: 'bug', title: 'Stale service worker' },
      { issue: 1234, closed: true, href: `${REPO}/issues/1234`, type: 'enhancement', title: 'Done thing' }
    ],
    sequencing: 'Do `A` first.',
    ...over
  };
}

/**
 * Render one block through the plan renderer.
 * @param {object|string} body - Train object, or raw block text.
 * @param {string} [fence] - Fence marker.
 * @returns {string}
 */
function render(body, fence = '```') {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return planDocs.renderPlanBody(`${fence}tc-train\n${text}\n${fence}`);
}

/**
 * Assert a block is refused: code fallback plus a reason matching `why`.
 * @param {object|string} body - Block.
 * @param {RegExp} why - Expected reason.
 * @returns {string} The HTML.
 */
function refused(body, why) {
  const html = render(body);
  assert.doesNotMatch(html, /class="train-card"/);
  assert.match(html, /<p class="block-error">Train block not rendered: /);
  assert.match(html, /<pre><code class="language-tc-train">/);
  assert.match(html, why);
  return html;
}

describe('plan train cards (#1930)', () => {
  describe('a valid block', () => {
    const html = render(train());

    it('renders a collapsible card whose summary is the engine, the cars, the name, the count and the badge', () => {
      assert.match(html, /^<details class="train-card"><summary class="train-summary"><span class="train-engine" aria-hidden="true">🚂<\/span>/);
      assert.match(html, /<span class="train-car open" title="#411 open" aria-label="#411 open">#411<\/span><span class="train-joint" aria-hidden="true">—<\/span><span class="train-car closed" title="#1234 closed" aria-label="#1234 closed">#1234<\/span>/);
      assert.match(html, /<span class="train-name">Train 1: First Install, Completed<\/span><span class="train-count">\(1\/2\)<\/span><span class="train-badge">verified<\/span><\/summary>/);
    });

    it('expands to the thesis, the open/closed line with the milestone link, the issue table and the sequencing note', () => {
      assert.match(html, /<p><em>The rest of the <strong>first<\/strong> hour\.<\/em><\/p>/);
      assert.match(html, /<p><strong>1 open · 1 closed<\/strong> · <a href="https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/milestone\/5">milestone<\/a><\/p>/);
      assert.match(html, /<td class="train-issue"><a href="https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/issues\/411">#411<\/a><\/td><td>bug<\/td><td class="train-state">open<\/td><td>Stale service worker<\/td>/);
      assert.match(html, /<td class="train-issue"><a [^>]*>#1234<\/a><\/td><td>enhancement<\/td><td class="train-state">✅ closed<\/td><td>Done thing<\/td>/);
      // Green means done: a closed issue's title is not struck through.
      assert.doesNotMatch(html, /<del>/);
      assert.match(html, /<p><strong>Sequencing\.<\/strong> Do <code>A<\/code> first\.<\/p><\/div><\/details>$/);
    });

    it('omits the badge unless verified is true, and computes the count from the cars', () => {
      const plain = render(train({ verified: false, cars: [{ issue: 1, closed: true }, { issue: 2, closed: true }, { issue: 3, closed: false }] }));
      assert.doesNotMatch(plain, /train-badge/);
      assert.match(plain, /<span class="train-count">\(2\/3\)<\/span>/);
      assert.match(plain, /<strong>1 open · 2 closed<\/strong>/);
      assert.doesNotMatch(render(train({ verified: undefined })), /train-badge/);
    });

    it('renders a train with no cars as an engine alone and a placeholder row', () => {
      const empty = render(train({ cars: [] }));
      assert.match(empty, /🚂<\/span><span class="train-name">/);
      assert.match(empty, /\(0\/0\)/);
      assert.match(empty, /No issues assigned\./);
    });

    it('accepts a tilde fence as well as a backtick fence', () => {
      assert.match(render(train(), '~~~'), /class="train-card"/);
    });

    it('leaves every other fenced block as code', () => {
      const html = planDocs.renderPlanBody('```json\n{"train":1}\n```');
      assert.equal(html, '<pre><code class="language-json">{&quot;train&quot;:1}</code></pre>');
    });
  });

  describe('escaping — nothing in the block becomes markup', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'&';

    it('escapes the title, the car type and title, and the thesis and sequencing', () => {
      const html = render(train({
        title: evil, thesis: evil, sequencing: evil,
        cars: [{ issue: 1, closed: false, type: evil.slice(0, 40), title: evil }]
      }));
      assert.doesNotMatch(html, /<script|<img/);
      assert.match(html, /Train 1: &lt;script&gt;alert\(1\)&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
    });

    it('escapes a quote inside an accepted href so it cannot leave the attribute', () => {
      const html = render(train({ href: 'https://example.com/a"onmouseover="alert(1)' }));
      assert.match(html, /<a href="https:\/\/example\.com\/a&quot;onmouseover=&quot;alert\(1\)">milestone<\/a>/);
    });

    it('does not echo a refused value into the reason', () => {
      const html = refused({ ...train(), '<b>x</b>': 1 }, /unknown key &quot;&lt;b&gt;x&lt;\/b&gt;&quot;/);
      assert.doesNotMatch(html, /<b>/);
    });
  });

  describe('hrefs — only absolute https URLs', () => {
    for (const bad of [
      'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'http://example.com/',
      '//evil.example/x', '/\\evil.example', 'https:\\\\evil.example', '/relative', 'relative.md',
      '\u0001javascript:alert(1)', 'https://exa mple.com', 'https:///x', ''
    ]) {
      it(`refuses ${JSON.stringify(bad)} on the train and on a car`, () => {
        refused(train({ href: bad }), /href must be an absolute https URL|href must be a string/);
        refused(train({ cars: [{ issue: 1, closed: false, href: bad }] }), /cars\[0\]\.href must be an absolute https URL/);
      });
    }

    it('renders a car with no href as plain text in the table', () => {
      assert.match(render(train({ cars: [{ issue: 7, closed: false }] })), /<td class="train-issue">#7<\/td><td>—<\/td><td class="train-state">open<\/td><td><\/td>/);
    });
  });

  describe('the schema is closed', () => {
    it('refuses non-JSON, arrays, null and scalars', () => {
      refused('{not json', /block is not valid JSON/);
      refused('[1,2]', /block must be a JSON object/);
      refused('null', /block must be a JSON object/);
      refused('"x"', /block must be a JSON object/);
    });

    it('refuses an unknown key, including __proto__, at the top and on a car', () => {
      refused({ ...train(), style: 'x' }, /unknown key &quot;style&quot;/);
      refused('{"train":1,"title":"t","cars":[],"__proto__":{"x":1}}', /unknown key &quot;__proto__&quot;/);
      refused(train({ cars: [{ issue: 1, closed: false, html: '<b>' }] }), /cars\[0\] has unknown key &quot;html&quot;/);
    });

    it('refuses a missing or mistyped required field', () => {
      refused(train({ train: undefined }), /train must be an integer/);
      refused(train({ train: 0 }), /train must be an integer/);
      refused(train({ train: 1.5 }), /train must be an integer/);
      refused(train({ train: '1' }), /train must be an integer/);
      refused(train({ train: trainCard.LIMITS.train + 1 }), /train must be an integer/);
      refused(train({ title: '  ' }), /title must be a non-empty string/);
      refused(train({ title: 7 }), /title must be a non-empty string/);
      refused(train({ cars: 'x' }), /cars must be an array/);
      refused(train({ cars: undefined }), /cars must be an array/);
      refused(train({ verified: 'yes' }), /verified must be true or false/);
      refused(train({ thesis: 3 }), /thesis must be a string/);
    });

    it('refuses a malformed car', () => {
      refused(train({ cars: [null] }), /cars\[0\] must be an object/);
      refused(train({ cars: [[1]] }), /cars\[0\] must be an object/);
      refused(train({ cars: [{ issue: -1, closed: false }] }), /cars\[0\]\.issue must be a positive integer/);
      refused(train({ cars: [{ issue: '5', closed: false }] }), /cars\[0\]\.issue must be a positive integer/);
      refused(train({ cars: [{ issue: 5 }] }), /cars\[0\]\.closed must be true or false/);
      refused(train({ cars: [{ issue: 5, closed: false, type: 'x'.repeat(41) }] }), /cars\[0\]\.type is longer than 40 characters/);
    });

    it('enforces the size bounds', () => {
      refused(train({ title: 'x'.repeat(trainCard.LIMITS.title + 1) }), /title is longer than 200 characters/);
      refused(train({ cars: Array.from({ length: trainCard.LIMITS.cars + 1 }, (_, i) => ({ issue: i + 1, closed: false })) }), /cars has more than 500 entries/);
      refused(' '.repeat(trainCard.LIMITS.body + 1), /block is larger than 200000 characters/);
      assert.match(render(train({ title: 'x'.repeat(trainCard.LIMITS.title) })), /class="train-card"/);
    });
  });

  describe('page styles', () => {
    const page = planDocs.renderPlanPage({
      project: { id: 74, name: 'Roadmap' }, file: 'b.md', relative: '.tangleclaw/plans/b.md',
      modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '# B', timeZone: 'UTC'
    });

    it('keeps table cells from breaking a word, so an issue number never wraps', () => {
      assert.match(page, /main\.plan th,main\.plan td\{[^}]*overflow-wrap:normal[^}]*\}/);
      assert.match(page, /td\.train-issue,td\.train-state\{white-space:nowrap\}/);
      assert.match(page, /\.train-car\{[^}]*white-space:nowrap/);
    });

    it('colors a closed car green and an open car in the theme surface', () => {
      assert.match(page, /\.train-car\.closed\{background:#238636;border-color:#238636;color:#fff\}/);
      assert.match(page, /\.train-car\{[^}]*background:var\(--code-bg\)/);
    });
  });
});
