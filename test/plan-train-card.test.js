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
 * A pattern for the markup of a car: a disclosure whose summary is the pill,
 * showing the number and the state in words, and whose content is the
 * detail, as far as the state's words. What follows is that state's meaning.
 * @param {number} issue - Issue number.
 * @param {string} state - State class.
 * @param {string} words - The state in words.
 * @param {string} [title] - The car's title, as it appears escaped.
 * @returns {RegExp}
 */
function car(issue, state, words, title) {
  /**
   * A string with every regular-expression metacharacter escaped.
   * @param {string} t - Literal text.
   * @returns {string}
   */
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<details class="car-slot"><summary class="train-car ${state}">#${issue} <span class="car-state">${words}</span></summary>`
    + `<span class="car-info"><span class="car-info-head">#${issue}${title ? ` ${esc(title)}` : ''}</span>`
    + `<span class="car-info-line"><span class="car-info-state">${words}</span>: `);
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

    it('renders a card of two rows: the engine and the cars, then a collapsible whose summary is the name, the count and the badge', () => {
      assert.match(html, /^<div class="train-card"><div class="train-cars"><span class="train-engine" aria-hidden="true">🚂<\/span><span class="train-joint" aria-hidden="true">—<\/span><details class="car-slot"><summary class="train-car open">#411 <span class="car-state">open<\/span><\/summary>/);
      assert.match(html, car(411, 'open', 'open', 'Stale service worker'));
      assert.match(html, car(1234, 'closed', 'closed', 'Done thing'));
      assert.match(html, /<\/span><\/span><\/details><span class="train-joint" aria-hidden="true">—<\/span><details class="car-slot"><summary class="train-car closed">#1234 <span class="car-state">closed<\/span><\/summary><span class="car-info"><span class="car-info-head">#1234 Done thing</);
      assert.match(html, /<\/span><\/span><\/details><\/div><details class="train-detail"><summary class="train-summary"><span class="train-name">Train 1: First Install, Completed<\/span><span class="train-count">\(1\/2\)<\/span><span class="train-badge">verified<\/span><\/summary><div class="train-body">/);
    });

    it('expands to the thesis, the open/closed line with the milestone link, the issue table and the sequencing note', () => {
      assert.match(html, /<p><em>The rest of the <strong>first<\/strong> hour\.<\/em><\/p>/);
      assert.match(html, /<p><strong>1 open · 1 closed<\/strong> · <a href="https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/milestone\/5">milestone<\/a><\/p>/);
      assert.match(html, /<td class="train-issue"><a href="https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/issues\/411">#411<\/a><\/td><td>bug<\/td><td class="train-state">open<\/td><td>Stale service worker<\/td>/);
      assert.match(html, /<td class="train-issue"><a [^>]*>#1234<\/a><\/td><td>enhancement<\/td><td class="train-state">✅ closed<\/td><td>Done thing<\/td>/);
      // Green means done: a closed issue's title is not struck through.
      assert.doesNotMatch(html, /<del>/);
      assert.match(html, /<p><strong>Sequencing\.<\/strong> Do <code>A<\/code> first\.<\/p><\/div><\/details><\/div>$/);
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
      assert.match(empty, /<div class="train-cars"><span class="train-engine" aria-hidden="true">🚂<\/span><\/div><details class="train-detail"><summary class="train-summary"><span class="train-name">/);
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
      refused(train({ train: 1.555 }), /train must be an integer/);
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

describe('train version, status and car state (#1933)', () => {
  it('shows an escaped version badge and a status badge after the count', () => {
    const html = render(train({ version: 'v6', status: 'in-progress' }));
    assert.match(html, /<span class="train-count">\(1\/2\)<\/span><span class="train-version">v6<\/span><span class="train-status status-in-progress">in progress<\/span><span class="train-badge">verified<\/span>/);
  });

  it('renders every status in the closed enum, and omits both badges when absent', () => {
    for (const status of trainCard.TRAIN_STATUSES) {
      assert.match(render(train({ status })), new RegExp(`<span class="train-status status-${status}">${status.replace('-', ' ')}</span>`));
    }
    assert.doesNotMatch(render(train()), /train-version|train-status/);
  });

  it('refuses a status outside the enum and a malformed version', () => {
    refused(train({ status: 'done' }), /status must be one of planned, ready, in-progress, blocked, shipped, sunset/);
    refused(train({ status: '<b>' }), /status must be one of/);
    refused(train({ version: '' }), /version must start with a letter or digit/);
    refused(train({ version: '-v6' }), /version must start with a letter or digit/);
    refused(train({ version: 'v6<script>' }), /version must start with a letter or digit/);
    refused(train({ version: 'v'.repeat(17) }), /version is longer than 16 characters/);
    refused(train({ version: 6 }), /version must be a string/);
    assert.match(render(train({ version: '5.30 beta_1' })), /<span class="train-version">5\.30 beta_1<\/span>/);
  });

  it('colours a car by its state, labels it in words, and says the state in the table', () => {
    const html = render(train({
      cars: [
        { issue: 1, closed: false, state: 'in-progress' },
        { issue: 2, closed: false, state: 'blocked' },
        { issue: 3, closed: false, state: 'open' },
        { issue: 4, closed: true, state: 'closed' }
      ]
    }));
    assert.match(html, car(1, 'in-progress', 'in progress'));
    assert.match(html, car(2, 'blocked', 'blocked'));
    assert.match(html, car(3, 'open', 'open'));
    assert.match(html, car(4, 'closed', 'closed'));
    assert.match(html, /<td class="train-state">◐ in progress<\/td>/);
    assert.match(html, /<td class="train-state">⛔ blocked<\/td>/);
    assert.match(html, /\(1\/4\)/);
    assert.match(html, /<strong>3 open \(1 in progress, 1 blocked\) · 1 closed<\/strong>/);
  });

  it('keeps the old behaviour when a car has no state', () => {
    const html = render(train({ cars: [{ issue: 5, closed: false }, { issue: 6, closed: true }] }));
    assert.match(html, car(5, 'open', 'open'));
    assert.match(html, car(6, 'closed', 'closed'));
    assert.match(html, /<strong>1 open · 1 closed<\/strong>/);
  });

  it('refuses a state outside the enum, or one that disagrees with closed', () => {
    refused(train({ cars: [{ issue: 1, closed: false, state: 'done' }] }), /cars\[0\]\.state must be one of open, in-progress, blocked, closed/);
    refused(train({ cars: [{ issue: 1, closed: true, state: 'in-progress' }] }), /cars\[0\]\.state must agree with closed/);
    refused(train({ cars: [{ issue: 1, closed: false, state: 'closed' }] }), /cars\[0\]\.state must agree with closed/);
  });

  it('colours in-progress amber, blocked red and a new queue issue blue', () => {
    const page = planDocs.renderPlanPage({
      project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '', timeZone: 'UTC'
    });
    assert.match(page, /\.train-car\.in-progress\{background:#9a6700;border-color:#9a6700;color:#fff\}/);
    assert.match(page, /\.train-car\.blocked\{background:#cf222e;border-color:#cf222e;color:#fff\}/);
    assert.match(page, /\.train-car\.queue-new\{background:#0969da;border-color:#0969da;color:#fff\}/);
  });

  it('lightens the coloured status badges in dark mode so small text stays legible', () => {
    const page = planDocs.renderPlanPage({
      project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '', timeZone: 'UTC'
    });
    assert.match(page, /@media \(prefers-color-scheme:dark\)\{\.train-status\.status-in-progress\{border-color:#d29922;color:#d29922\}\.train-status\.status-blocked\{border-color:#f85149;color:#f85149\}\.train-status\.status-shipped\{border-color:#3fb950;color:#3fb950\}\}/);
  });
});

describe('the new cards queue (#1933)', () => {
  const NOW = Date.parse('2026-09-27T12:00:00Z');
  const Q = 'https://github.com/Jason-Vaughan/TangleClaw/issues';

  /**
   * A valid queue, with overrides.
   * @param {object} [over] - Fields to replace.
   * @returns {object}
   */
  function queue(over = {}) {
    return {
      newDays: 14,
      issues: [
        { issue: 100, title: 'Old untriaged', href: `${Q}/100`, type: 'bug', labels: ['needs-triage'], createdAt: '2026-06-01T09:00:00Z' },
        { issue: 1932, title: 'Fresh one', href: `${Q}/1932`, type: 'enhancement', createdAt: '2026-09-27T09:30:00Z' },
        { issue: 1900, title: 'Last week', createdAt: '2026-09-20T12:00:00Z' }
      ],
      ...over
    };
  }

  /**
   * Render a queue block through the plan renderer at a fixed time.
   * @param {object|string} body - Queue object, or raw block text.
   * @returns {string}
   */
  function renderQ(body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return planDocs.renderPlanBody(`\`\`\`tc-queue\n${text}\n\`\`\``, 0, { now: NOW });
  }

  /**
   * Assert a queue block is refused with a reason matching `why`.
   * @param {object|string} body - Block.
   * @param {RegExp} why - Expected reason.
   * @returns {void}
   */
  function refusedQ(body, why) {
    const html = renderQ(body);
    assert.doesNotMatch(html, /class="train-card/);
    assert.match(html, /<p class="block-error">Queue block not rendered: /);
    assert.match(html, /<pre><code class="language-tc-queue">/);
    assert.match(html, why);
  }

  it('shows the new issues as pills in the summary, with the new and waiting counts', () => {
    const html = renderQ(queue());
    assert.match(html, /^<details class="train-card queue-card"><summary class="train-summary"><span class="train-engine" aria-hidden="true">📥<\/span>/);
    assert.match(html, /<span class="train-car queue-new" title="#1932 new" aria-label="#1932 new">#1932<\/span><span class="train-car queue-new" title="#1900 new" aria-label="#1900 new">#1900<\/span><span class="train-name">New cards queue<\/span>/);
    assert.match(html, /<span class="train-count">\(2 new · 3 waiting\)<\/span>/);
    assert.doesNotMatch(html, /title="#100 new"/);
  });

  it('lists every waiting issue newest first, and age never removes an old one', () => {
    const html = renderQ(queue());
    const order = [...html.matchAll(/<td class="train-issue">(?:<a [^>]*>)?#(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(order, [1932, 1900, 100]);
    assert.match(html, /<td class="train-issue"><a href="https:\/\/github\.com\/Jason-Vaughan\/TangleClaw\/issues\/100">#100<\/a><\/td><td>bug<\/td><td><code>needs-triage<\/code><\/td><td class="train-state">118d<\/td><td>Old untriaged<\/td>/);
  });

  it('marks new rows and computes ages in hours and days from the render time', () => {
    const html = renderQ(queue());
    assert.match(html, /<td class="train-state">2h <span class="queue-new-badge">new<\/span><\/td><td>Fresh one<\/td>/);
    assert.match(html, /<td class="train-state">7d <span class="queue-new-badge">new<\/span><\/td><td>Last week<\/td>/);
  });

  it('marks new by the threshold, inclusive, and reads a future timestamp as under an hour', () => {
    const edge = renderQ(queue({ newDays: 7, issues: [{ issue: 1, createdAt: '2026-09-20T12:00:00Z' }, { issue: 2, createdAt: '2026-09-20T11:59:59Z' }] }));
    assert.match(edge, /title="#1 new"/);
    assert.doesNotMatch(edge, /title="#2 new"/);
    const skew = renderQ(queue({ issues: [{ issue: 3, createdAt: '2026-09-27T13:00:00Z' }] }));
    assert.match(skew, /<td class="train-state">&lt;1h <span class="queue-new-badge">new<\/span><\/td>/);
  });

  it('uses a custom title, escaped, and renders an empty queue', () => {
    assert.match(renderQ(queue({ title: 'Inbox <b>' })), /<span class="train-name">Inbox &lt;b&gt;<\/span>/);
    const empty = renderQ(queue({ issues: [] }));
    assert.match(empty, /\(0 new · 0 waiting\)/);
    assert.match(empty, /Nothing waiting\./);
  });

  it('escapes titles, types and labels', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderQ(queue({ issues: [{ issue: 1, title: evil, type: '<b>', labels: ['<i>'], createdAt: '2026-09-27T00:00:00Z' }] }));
    assert.doesNotMatch(html, /<img|<b>|<i>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('computes the age at render time, so the same block ages as time passes', () => {
    const body = '```tc-queue\n' + JSON.stringify(queue()) + '\n```';
    assert.match(planDocs.renderPlanBody(body, 0, { now: NOW + 30 * 86400000 }), /\(0 new · 3 waiting\)/);
    const page = planDocs.renderPlanPage({
      project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z',
      markdown: body, timeZone: 'UTC', now: NOW
    });
    assert.match(page, /\(2 new · 3 waiting\)/);
  });

  it('refuses a malformed queue', () => {
    refusedQ('nope', /block is not valid JSON/);
    refusedQ({ ...queue(), extra: 1 }, /unknown key &quot;extra&quot;/);
    refusedQ(queue({ newDays: 0 }), /newDays must be an integer from 1 to 365/);
    refusedQ(queue({ newDays: '14' }), /newDays must be an integer/);
    refusedQ(queue({ issues: 'x' }), /issues must be an array/);
    refusedQ(queue({ issues: [{ issue: 1 }] }), /issues\[0\]\.createdAt must be an ISO-8601 timestamp with a zone/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27' }] }), /createdAt must be an ISO-8601/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-13-45T99:99:00Z' }] }), /createdAt must be an ISO-8601/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', state: 'x' }] }), /issues\[0\] has unknown key &quot;state&quot;/);
    refusedQ(queue({ issues: [{ issue: 0, createdAt: '2026-09-27T00:00:00Z' }] }), /issues\[0\]\.issue must be a positive integer/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', href: 'javascript:alert(1)' }] }), /issues\[0\]\.href must be an absolute https URL/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', labels: 'bug' }] }), /issues\[0\]\.labels must be an array/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', labels: [''] }] }), /labels\[0\] must be a string of 1 to 40 characters/);
    refusedQ(queue({ issues: [{ issue: 1, createdAt: '2026-09-27T00:00:00Z', labels: Array(11).fill('a') }] }), /labels has more than 10 entries/);
    refusedQ(queue({ issues: Array.from({ length: trainCard.LIMITS.queueIssues + 1 }, (_, i) => ({ issue: i + 1, createdAt: '2026-09-27T00:00:00Z' })) }), /issues has more than 1000 entries/);
  });
});

describe('permanent train identities and card kinds (#1942)', () => {
  /**
   * The text of a rendered card's name.
   * @param {object} over - Fields to replace on the valid train.
   * @returns {string}
   */
  function nameOf(over) {
    const html = render(train(over));
    assert.match(html, /class="train-card"/, 'the block must render as a card');
    return html.match(/<span class="train-name">([^<]*)<\/span>/)[1];
  }

  it('prints the identity it is given, never a position', () => {
    assert.equal(nameOf({ train: 16, title: 'Secure Surface' }), 'Train 16: Secure Surface');
    assert.equal(nameOf({ train: 13.5, title: 'Half Step' }), 'Train 13.5: Half Step');
    assert.equal(nameOf({ train: 'A', title: 'Version 5 Bridge Train A' }), 'Train A: Version 5 Bridge Train A');
    assert.equal(nameOf({ train: 'C-E', title: 'Later trains' }), 'Train C-E: Later trains');
  });

  it('names a Pilot as what it is, not as a train', () => {
    assert.equal(nameOf({ kind: 'pilot', train: 'B2', title: 'Pilot lane' }), 'Pilot B2: Pilot lane');
    assert.equal(nameOf({ kind: 'pilot', train: 'B2', title: 'B2' }), 'Pilot: B2', 'an identity equal to the title is not printed twice');
    assert.doesNotMatch(render(train({ kind: 'pilot', train: 'B2', title: 'T' })), />Train /);
  });

  it('renders an unconfigured milestone with no identity, and refuses one that carries an identity', () => {
    assert.equal(nameOf({ kind: 'unconfigured', train: undefined, title: 'New milestone' }), 'Unconfigured: New milestone');
    refused(train({ kind: 'unconfigured', train: 3 }), /train must be absent when kind is unconfigured/);
  });

  it('keeps a block without kind reading as a train, as before', () => {
    assert.equal(nameOf({ train: 1 }), 'Train 1: First Install, Completed');
    assert.equal(nameOf({ kind: 'train', train: 1 }), 'Train 1: First Install, Completed');
  });

  it('refuses an identity every other kind needs, and a kind outside the enum', () => {
    for (const kind of ['train', 'pilot']) {
      refused(train({ kind, train: undefined }), /train must be an integer/);
    }
    refused(train({ kind: 'epic' }), /kind must be one of train, bucket, pilot, unconfigured/);
    refused(train({ kind: 7 }), /kind must be one of/);
  });

  it('accepts only canonical identities', () => {
    // A number is written as a JSON number, so "16" and 16 cannot both name one train.
    refused(train({ train: '16' }), /train must be an integer/);
    refused(train({ train: '13.5' }), /train must be an integer/);
    refused(train({ train: 13.555 }), /train must be an integer/);
    refused(train({ train: 0.5 }), /train must be an integer/);
    refused(train({ train: -2 }), /train must be an integer/);
    refused(train({ train: '' }), /train must be an integer/);
    refused(train({ train: ' A' }), /train must be an integer/);
    refused(train({ train: 'A ' }), /train must be an integer/);
    refused(train({ train: 'x'.repeat(trainCard.LIMITS.trainId + 1) }), /train must be an integer/);
    refused(train({ train: true }), /train must be an integer/);
    refused(train({ train: ['A'] }), /train must be an integer/);
    assert.match(render(train({ train: 'x'.repeat(trainCard.LIMITS.trainId) })), /class="train-card"/);
    assert.match(render(train({ train: trainCard.LIMITS.train })), /class="train-card"/);
  });

  it('never lets an identity become markup', () => {
    refused(train({ train: 'A<b>' }), /train must be an integer/);
    refused(train({ train: 'A"x' }), /train must be an integer/);
    const html = render(train({ kind: 'pilot', train: 'R&D', title: 'R&D' }));
    assert.match(html, /class="block-error"/, 'an ampersand is outside the identity alphabet');
    assert.doesNotMatch(html, /class="train-card"/);
  });
});

describe('ID-less Topic Buckets (#2006)', () => {
  /**
   * A bucket shaped like the shared roadmap's: no `train`, a milestone link
   * and open cars.
   * @param {object} [over] - Fields to replace.
   * @returns {object}
   */
  function bucket(over = {}) {
    return {
      kind: 'bucket',
      title: 'Infrastructure Hardening',
      href: `${REPO}/milestone/9`,
      verified: false,
      thesis: 'Non-train topic bucket.',
      cars: [
        { issue: 192, closed: false, state: 'open', href: `${REPO}/issues/192`, type: 'bug', title: 'Multi-line paste corrupts input' },
        { issue: 254, closed: false, state: 'open', href: `${REPO}/issues/254`, type: 'bug', title: 'Device re-pairing each launch' }
      ],
      ...over
    };
  }

  it('renders a bucket with no train as a collapsible card', () => {
    const html = render(bucket());
    assert.match(html, /^<div class="train-card">/);
    assert.match(html, /<details class="train-detail">/);
    assert.match(html, /<summary class="train-summary"/);
    assert.match(html, /<summary class="train-car open">#192 <span class="car-state">open<\/span><\/summary>/);
  });

  it('names it exactly "Topic Bucket: <title>", with no train number', () => {
    const html = render(bucket());
    assert.equal(html.match(/<span class="train-name">([^<]*)<\/span>/)[1], 'Topic Bucket: Infrastructure Hardening');
    assert.doesNotMatch(html, />Train /);
    assert.equal(trainCard.parseTrainBlock(JSON.stringify(bucket()), () => true).train, undefined,
      'the parser never assigns a bucket an identity');
  });

  it('refuses a bucket that carries a train identity', () => {
    for (const id of [3, 13.5, 'Infra', 'Infrastructure Hardening']) {
      refused(bucket({ train: id }), /train must be absent when kind is bucket/);
    }
  });

  it('renders every current roadmap bucket shape without a block error', () => {
    for (const title of ['Infrastructure Hardening', 'Master Control', 'Version 5 Subsequent (Trains C-E)']) {
      const html = render(bucket({ title }));
      assert.doesNotMatch(html, /block-error/, title);
      assert.doesNotMatch(html, /language-tc-train/, title);
      assert.match(html, /class="train-card"/, title);
    }
  });

  it('leaves train and pilot identity validation unchanged', () => {
    refused(train({ kind: 'train', train: undefined }), /train must be an integer/);
    refused(train({ kind: 'pilot', train: undefined }), /train must be an integer/);
    refused(train({ train: '16' }), /train must be an integer/);
    refused(train({ kind: 'unconfigured', train: 3 }), /train must be absent when kind is unconfigured/);
    assert.match(render(train({ kind: 'train', train: 16 })), /class="train-card"/);
    assert.match(render(train({ kind: 'pilot', train: 'B2' })), /class="train-card"/);
  });
});

describe('in-review and dropped cars, and the owning lane (#2165)', () => {
  /**
   * The plan page's stylesheet.
   * @returns {string}
   */
  const stylesheet = () => planDocs.renderPlanPage({
    project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '', timeZone: 'UTC'
  });

  it('draws an in-review car and a dropped car with their own class, words and table cell', () => {
    const html = render(train({
      cars: [
        { issue: 1, closed: false, state: 'in-review' },
        { issue: 2, closed: true, state: 'dropped' }
      ]
    }));
    assert.match(html, car(1, 'in-review', 'in review'));
    assert.match(html, car(2, 'dropped', 'dropped'));
    assert.match(html, /<td class="train-state">◆ in review<\/td>/);
    assert.match(html, /<td class="train-state">⊘ dropped<\/td>/);
  });

  it('colours in-review purple, and marks dropped with a line-through as well as a colour that is not green', () => {
    const page = stylesheet();
    assert.match(page, /\.train-car\.in-review\{background:#8250df;border-color:#8250df;color:#fff\}/);
    assert.match(page, /\.train-car\.dropped\{background:#57606a;border-color:#57606a;color:#fff;text-decoration:line-through\}/);
  });

  it('has words, a table cell and a style for every state in the enum', () => {
    const page = stylesheet();
    const html = render(train({
      cars: trainCard.CAR_STATES.map((state, i) => ({ issue: i + 1, closed: trainCard.CLOSED_CAR_STATES.includes(state), state }))
    }));
    trainCard.CAR_STATES.forEach((state, i) => {
      const pill = html.match(new RegExp(`<summary class="train-car ${state}">#${i + 1} <span class="car-state">[a-z ]+</span></summary>`
        + `<span class="car-info"><span class="car-info-head">#${i + 1}</span><span class="car-info-line"><span class="car-info-state">([a-z ]+)</span>: `));
      assert.ok(pill, `${state} has a labelled pill`);
      assert.match(html, new RegExp(`<td class="train-state">[^<]*${pill[1]}</td>`), `${state} is named in the table`);
      if (state !== 'open') assert.match(page, new RegExp(`\\.train-car\\.${state}\\{`), `${state} has a style`);
    });
  });

  it('requires a closed issue to be closed or dropped, and an open one to be anything else', () => {
    for (const state of ['open', 'in-progress', 'in-review', 'blocked']) {
      assert.match(render(train({ cars: [{ issue: 1, closed: false, state }] })), /class="train-card"/);
      refused(train({ cars: [{ issue: 1, closed: true, state }] }), /cars\[0\]\.state must agree with closed/);
    }
    for (const state of ['closed', 'dropped']) {
      assert.match(render(train({ cars: [{ issue: 1, closed: true, state }] })), /class="train-card"/);
      refused(train({ cars: [{ issue: 1, closed: false, state }] }), /cars\[0\]\.state must agree with closed/);
    }
    refused(train({ cars: [{ issue: 1, closed: false, state: 'done' }] }),
      /cars\[0\]\.state must be one of open, in-progress, blocked, closed, in-review, dropped\./);
  });

  it('counts a state-less closed car as closed, never as dropped', () => {
    const html = render(train({ cars: [{ issue: 6, closed: true }] }));
    assert.match(html, car(6, 'closed', 'closed'));
    assert.match(html, /\(1\/1\)/);
  });

  it('leaves a dropped car out of both figures of the count and reports it separately', () => {
    const html = render(train({
      cars: [
        { issue: 1, closed: true, state: 'closed' },
        { issue: 2, closed: true, state: 'dropped' },
        { issue: 3, closed: false, state: 'in-review' },
        { issue: 4, closed: false },
        { issue: 5, closed: true }
      ]
    }));
    assert.match(html, /<span class="train-count">\(2\/4\)<\/span>/);
    assert.match(html, /<strong>2 open \(1 in review\) · 2 closed · 1 dropped<\/strong>/);
  });

  it('lets a train finish when its only unfinished car was dropped', () => {
    const html = render(train({ cars: [{ issue: 1, closed: true }, { issue: 2, closed: true, state: 'dropped' }] }));
    assert.match(html, /<span class="train-count">\(1\/1\)<\/span>/);
    assert.match(html, /<strong>0 open · 1 closed · 1 dropped<\/strong>/);
  });

  it('reads 0/0 with the dropped count when every car was dropped', () => {
    const html = render(train({ cars: [{ issue: 1, closed: true, state: 'dropped' }, { issue: 2, closed: true, state: 'dropped' }] }));
    assert.match(html, /<span class="train-count">\(0\/0\)<\/span>/);
    assert.match(html, /<strong>0 open · 0 closed · 2 dropped<\/strong>/);
  });

  it('says nothing about dropped cars when there are none', () => {
    assert.doesNotMatch(render(train()), /dropped/);
  });

  it('shows the owning lane in words after the badges, escaped', () => {
    const html = render(train({ owner: 'TangleClaw-BuilderRule' }));
    assert.match(html, /<span class="train-badge">verified<\/span><span class="train-owner">lane: TangleClaw-BuilderRule<\/span><\/summary>/);
    const hostile = render(train({ owner: '<img src=x onerror=alert(1)>' }));
    assert.match(hostile, /<span class="train-owner">lane: &lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
    assert.doesNotMatch(hostile, /<img/);
  });

  it('draws no lane when there is no owner', () => {
    assert.doesNotMatch(render(train()), /train-owner|lane:/);
  });

  it('refuses an owner that is not a string, is blank, or is longer than the bound', () => {
    refused(train({ owner: 7 }), /owner must be a string/);
    refused(train({ owner: '   ' }), /owner must not be blank/);
    refused(train({ owner: '' }), /owner must not be blank/);
    refused(train({ owner: 'x'.repeat(trainCard.LIMITS.owner + 1) }), /owner is longer than 60 characters/);
    assert.match(render(train({ owner: 'x'.repeat(trainCard.LIMITS.owner) })), /class="train-owner"/);
  });
});

describe('release panels (#2165)', () => {
  /**
   * A valid release holding one train and one Topic Bucket, with overrides.
   * @param {object} [over] - Fields to replace.
   * @returns {object}
   */
  function release(over = {}) {
    return {
      version: '5.32.0',
      status: 'planned',
      trains: [
        train({ kind: 'train', train: 31 }),
        {
          kind: 'bucket',
          title: 'Install safety',
          cars: [
            { issue: 20, closed: true },
            { issue: 21, closed: false, state: 'in-review' },
            { issue: 22, closed: true, state: 'dropped' }
          ]
        }
      ],
      ...over
    };
  }

  /**
   * A release with one of its workstreams replaced.
   * @param {*} entry - The workstream to put first.
   * @returns {object}
   */
  const withEntry = (entry) => release({ trains: [entry] });

  /**
   * Render one `tc-release` block through the plan renderer.
   * @param {object|string} body - Release object, or raw block text.
   * @returns {string}
   */
  function renderRelease(body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    return planDocs.renderPlanBody(`\`\`\`tc-release\n${text}\n\`\`\``);
  }

  /**
   * Assert a release block is refused whole: no panel, no card, the code fallback and a reason matching `why`.
   * @param {object|string} body - Block.
   * @param {RegExp} why - Expected reason.
   * @returns {string} The HTML.
   */
  function refusedRelease(body, why) {
    const html = renderRelease(body);
    assert.doesNotMatch(html, /class="release-panel"|class="train-card"/);
    assert.match(html, /<p class="block-error">Release block not rendered: /);
    assert.match(html, /<pre><code class="language-tc-release">/);
    assert.match(html, why);
    return html;
  }

  describe('a valid block', () => {
    it('draws one panel with the version, the status badge and one card per workstream in order', () => {
      const html = renderRelease(release());
      assert.equal(html.match(/<section class="release-panel"/g).length, 1);
      assert.match(html, /<section class="release-panel" aria-label="Release 5\.32\.0"><div class="release-head"><span class="release-version">v5\.32\.0<\/span><span class="train-status status-planned">planned<\/span>/);
      assert.equal(html.match(/<div class="train-card">/g).length, 2);
      assert.ok(html.indexOf('Train 31: First Install, Completed') < html.indexOf('Topic Bucket: Install safety'));
      assert.match(html, /<\/details><\/div><\/section>$/);
    });

    it('draws each workstream exactly as a tc-train block draws it, issue table included', () => {
      const entry = train({ kind: 'train', train: 31 });
      assert.ok(renderRelease(withEntry(entry)).includes(render(entry)));
    });

    it('counts the header from the cars of every workstream, buckets included, and says workstreams', () => {
      // Train: one closed of two. Bucket: one closed, one in review, one dropped.
      assert.match(renderRelease(release()),
        /<span class="release-count" aria-label="2 of 4 cars done across 2 workstreams, 1 dropped">2\/4 cars · 2 workstreams · 1 dropped<\/span>/);
    });

    it('leaves dropped out of the header when no car is dropped, and writes one workstream in the singular', () => {
      assert.match(renderRelease(withEntry(train({ kind: 'train' }))),
        /<span class="release-count" aria-label="1 of 2 cars done across 1 workstream">1\/2 cars · 1 workstream<\/span>/);
    });

    it('reads 0/0 with the dropped count when every car is dropped', () => {
      const html = renderRelease(withEntry({
        kind: 'bucket', title: 'Abandoned', cars: [{ issue: 1, closed: true, state: 'dropped' }, { issue: 2, closed: true, state: 'dropped' }]
      }));
      assert.match(html, /aria-label="0 of 0 cars done across 1 workstream, 2 dropped">0\/0 cars · 1 workstream · 2 dropped</);
    });

    it('draws no status badge in the header when the release has no status', () => {
      const { status, ...rest } = release();
      assert.equal(status, 'planned');
      assert.match(renderRelease(rest), /<span class="release-version">v5\.32\.0<\/span><span class="release-count"/);
    });

    it('accepts a release at the workstream bound', () => {
      const trains = Array.from({ length: trainCard.LIMITS.releaseTrains }, (_, i) => train({ kind: 'train', train: i + 1, cars: [] }));
      assert.match(renderRelease(release({ trains })), /across 50 workstreams/);
    });

    it('keeps a number and a string ID apart, and a train apart from a bucket of the same title', () => {
      const html = renderRelease(release({
        trains: [
          train({ kind: 'train', train: 16 }),
          train({ kind: 'train', train: 'A16' }),
          { kind: 'bucket', title: 'First Install, Completed', cars: [] }
        ]
      }));
      assert.equal(html.match(/<div class="train-card">/g).length, 3);
    });

    it('styles the panel from the page stylesheet', () => {
      const page = planDocs.renderPlanPage({
        project: { id: 1, name: 'p' }, file: 'x.md', relative: 'x.md', modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '', timeZone: 'UTC'
      });
      assert.match(page, /section\.release-panel\{border:1px solid var\(--border\)/);
      assert.match(page, /\.release-head\{display:flex/);
    });
  });

  describe('the release schema is closed', () => {
    it('refuses a body that is not JSON, or not an object', () => {
      refusedRelease('{ not json', /block is not valid JSON/);
      refusedRelease('[]', /block must be a JSON object/);
    });

    it('refuses an unknown top-level key, so a total or a done figure cannot be supplied', () => {
      refusedRelease(release({ total: 99 }), /unknown key &quot;total&quot;/);
      refusedRelease(release({ done: 99 }), /unknown key &quot;done&quot;/);
      refusedRelease(release({ title: 'Recovery' }), /unknown key &quot;title&quot;/);
    });

    for (const bad of ['v5.32.0', '5.32', '05.32.0', '5.32.0-rc1', '5.32.0 ', '', '1'.repeat(20) + '.0.0', 5, undefined]) {
      it(`refuses the version ${JSON.stringify(bad)}`, () => {
        refusedRelease(release({ version: bad }), /version must be three numbers such as 5\.32\.0/);
      });
    }

    it('refuses a status outside the list', () => {
      refusedRelease(release({ status: 'done' }), /status must be one of planned, ready, in-progress, blocked, shipped, sunset/);
    });

    it('refuses trains that are missing, empty, not an array, or over the bound', () => {
      const { trains, ...rest } = release();
      assert.equal(trains.length, 2);
      refusedRelease(rest, /trains must be a non-empty array/);
      refusedRelease(release({ trains: [] }), /trains must be a non-empty array/);
      refusedRelease(release({ trains: { 0: train() } }), /trains must be a non-empty array/);
      const many = Array.from({ length: trainCard.LIMITS.releaseTrains + 1 }, (_, i) => train({ kind: 'train', train: i + 1, cars: [] }));
      refusedRelease(release({ trains: many }), /trains has more than 50 entries/);
    });

    it('refuses more cars in total than the bound, though each workstream is within its own', () => {
      const cars = Array.from({ length: 400 }, (_, i) => ({ issue: i + 1, closed: false }));
      const trains = [1, 2, 3].map((id) => train({ kind: 'train', train: id, cars }));
      refusedRelease(release({ trains }), /trains hold more than 1000 cars in total/);
    });

    it('refuses a body over the block bound before parsing it', () => {
      refusedRelease(JSON.stringify(release()) + ' '.repeat(trainCard.LIMITS.body), /block is larger than 200000 characters/);
    });
  });

  describe('a workstream is held to the train rules, at its own path', () => {
    it('refuses a workstream that is not an object', () => {
      refusedRelease(withEntry('Train 31'), /trains\[0\] must be an object/);
      refusedRelease(withEntry(null), /trains\[0\] must be an object/);
      refusedRelease(withEntry([]), /trains\[0\] must be an object/);
    });

    it('refuses an unknown key, a missing title and a malformed car, naming the workstream', () => {
      refusedRelease(release({ trains: [train({ kind: 'train' }), train({ kind: 'train', train: 2, colour: 'red' })] }),
        /trains\[1\] has unknown key &quot;colour&quot;/);
      refusedRelease(withEntry(train({ kind: 'train', title: undefined })), /trains\[0\]\.title must be a non-empty string/);
      refusedRelease(withEntry(train({ kind: 'train', cars: [{ issue: 1 }] })), /trains\[0\]\.cars\[0\]\.closed must be true or false/);
      refusedRelease(withEntry(train({ kind: 'train', cars: [{ issue: 1, closed: false, state: 'dropped' }] })),
        /trains\[0\]\.cars\[0\]\.state must agree with closed/);
      refusedRelease(withEntry(train({ kind: 'train', cars: 'none' })), /trains\[0\]\.cars must be an array/);
    });

    it('refuses a kind that is absent, a pilot or an unconfigured milestone', () => {
      refusedRelease(withEntry(train()), /trains\[0\]\.kind must be written out as one of train, bucket/);
      refusedRelease(withEntry(train({ kind: 'pilot', train: 'B2' })), /trains\[0\]\.kind must be written out as one of train, bucket/);
      refusedRelease(withEntry({ kind: 'unconfigured', title: 'Later', cars: [] }), /trains\[0\]\.kind must be written out as one of train, bucket/);
      // A bucket that left its kind out is told about the kind, not about a train identity it must not have.
      const bare = refusedRelease(withEntry({ title: 'Install safety', cars: [] }), /trains\[0\]\.kind must be written out as one of train, bucket/);
      assert.doesNotMatch(bare, /train must be an integer/);
      refusedRelease(withEntry(train({ kind: 'release' })), /trains\[0\]\.kind must be one of train, bucket, pilot, unconfigured/);
    });

    it('refuses a version on a workstream, because the release states it', () => {
      refusedRelease(withEntry(train({ kind: 'train', version: '5.32.0' })), /trains\[0\]\.version must be absent inside a release/);
      refusedRelease(withEntry({ kind: 'bucket', title: 'B', version: 'v6', cars: [] }), /trains\[0\]\.version must be absent inside a release/);
    });

    it('refuses a train with no identity and a bucket with one', () => {
      refusedRelease(withEntry(train({ kind: 'train', train: undefined })), /trains\[0\]\.train must be an integer or a number/);
      refusedRelease(withEntry({ kind: 'bucket', train: 4, title: 'B', cars: [] }), /trains\[0\]\.train must be absent when kind is bucket/);
    });

    it('refuses a train identity used twice, however the number is written', () => {
      /**
       * A train workstream as raw JSON text, so the identity keeps the spelling given.
       * @param {string} id - The `train` value, as it is to appear in the source.
       * @returns {string}
       */
      const entry = (id) => `{"kind":"train","train":${id},"title":"T","cars":[]}`;
      refusedRelease(`{"version":"5.32.0","trains":[${entry('16')},${entry('16.0')}]}`,
        /trains\[1\]\.train repeats another train in this release/);
      refusedRelease(release({ trains: [train({ kind: 'train', train: 'C-E' }), train({ kind: 'train', train: 'C-E' })] }),
        /trains\[1\]\.train repeats another train in this release/);
    });

    it('refuses two buckets whose titles differ only by case or surrounding spaces', () => {
      refusedRelease(release({
        trains: [{ kind: 'bucket', title: 'Install Safety', cars: [] }, { kind: 'bucket', title: '  install safety ', cars: [] }]
      }), /trains\[1\]\.title repeats another bucket in this release/);
    });

    for (const bad of [
      'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'http://example.com/',
      '//evil.example/x', '/\\evil.example', 'https:\\\\evil.example', '/relative', 'relative.md',
      '\u0001javascript:alert(1)', 'https://exa mple.com', 'https:///x', ''
    ]) {
      it(`refuses the href ${JSON.stringify(bad)} on a workstream and on its car`, () => {
        refusedRelease(withEntry(train({ kind: 'train', href: bad })), /trains\[0\]\.href must be an absolute https URL/);
        refusedRelease(withEntry(train({ kind: 'train', cars: [{ issue: 1, closed: false, href: bad }] })),
          /trains\[0\]\.cars\[0\]\.href must be an absolute https URL/);
      });
    }
  });

  describe('escaping — nothing in a release becomes markup', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'&';

    it('escapes every string of a workstream and its cars', () => {
      const html = renderRelease(withEntry(train({
        kind: 'train', train: 'A-1', title: evil, thesis: evil, sequencing: evil, owner: evil.slice(0, 60),
        cars: [{ issue: 1, closed: false, type: evil.slice(0, 40), title: evil }]
      })));
      assert.match(html, /class="release-panel"/);
      assert.doesNotMatch(html, /<script|<img/);
      assert.match(html, /Train A-1: &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    });

    it('refuses a string train ID carrying markup, and shows it only as escaped code', () => {
      const html = refusedRelease(withEntry(train({ kind: 'train', train: 'A<b>' })), /trains\[0\]\.train must be an integer or a number/);
      assert.doesNotMatch(html, /<b>/);
    });

    it('does not echo a refused value into the reason, and shows the source only as escaped code', () => {
      const html = refusedRelease(release({ version: '<img src=x onerror=alert(1)>' }), /version must be three numbers/);
      assert.doesNotMatch(html, /<img/);
      assert.doesNotMatch(html.split('</p>')[0], /onerror/);
      const key = refusedRelease(withEntry({ ...train({ kind: 'train' }), '<b>x</b>': 1 }), /trains\[0\] has unknown key &quot;&lt;b&gt;x&lt;\/b&gt;&quot;/);
      assert.doesNotMatch(key, /<b>/);
    });
  });

  describe('beside the other cards', () => {
    it('leaves a tc-train and a tc-queue block on the same page as they were', () => {
      const queue = { newDays: 14, issues: [{ issue: 9, createdAt: '2026-09-27T09:30:00Z' }] };
      const now = Date.parse('2026-09-28T00:00:00Z');
      /**
       * One fenced block.
       * @param {string} info - Info string.
       * @param {object} body - Block object.
       * @returns {string}
       */
      const fence = (info, body) => `\`\`\`${info}\n${JSON.stringify(body)}\n\`\`\``;
      const alone = [fence('tc-train', train()), fence('tc-queue', queue)].map((md) => planDocs.renderPlanBody(md, 0, { now }));
      const page = planDocs.renderPlanBody(
        [fence('tc-train', train()), fence('tc-release', release()), fence('tc-queue', queue)].join('\n\n'), 0, { now });
      assert.ok(page.includes(alone[0]));
      assert.ok(page.includes(alone[1]));
      assert.equal(page.match(/<section class="release-panel"/g).length, 1);
    });

    it('does not let a refused release stop the cards around it', () => {
      /**
       * One fenced block.
       * @param {string} info - Info string.
       * @param {object} body - Block object.
       * @returns {string}
       */
      const fence = (info, body) => `\`\`\`${info}\n${JSON.stringify(body)}\n\`\`\``;
      const page = planDocs.renderPlanBody([fence('tc-release', release({ version: 'v1' })), fence('tc-train', train())].join('\n\n'));
      assert.match(page, /Release block not rendered: /);
      assert.equal(page.match(/<div class="train-card">/g).length, 1);
    });

    it('exports the block name, the kinds and the bounds', () => {
      assert.equal(trainCard.RELEASE_BLOCK_INFO, 'tc-release');
      assert.deepEqual([...trainCard.RELEASE_KINDS], ['train', 'bucket']);
      assert.equal(trainCard.LIMITS.releaseTrains, 50);
      assert.equal(trainCard.LIMITS.releaseCars, 1000);
    });
  });
});

describe('the car-state legend (#2165)', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  const queue = { newDays: 14, issues: [{ issue: 9, createdAt: '2026-09-27T09:30:00Z' }] };
  const releaseBlock = { version: '5.32.0', trains: [train({ kind: 'train' })] };

  /**
   * One fenced block.
   * @param {string} info - Info string.
   * @param {object} body - Block object.
   * @returns {string}
   */
  const fence = (info, body) => `\`\`\`${info}\n${JSON.stringify(body)}\n\`\`\``;

  /**
   * The `<main>` of a served plan page, the path a reader actually gets.
   * @param {string} markdown - Plan source.
   * @returns {string}
   */
  function mainOf(markdown) {
    const page = planDocs.renderPlanPage({
      project: { id: 74, name: 'Roadmap' }, file: 'b.md', relative: '.tangleclaw/plans/b.md',
      modifiedAt: '2026-09-27T00:00:00.000Z', markdown, timeZone: 'UTC', now
    });
    return page.slice(page.indexOf('<main'));
  }

  /**
   * How many legends a fragment holds.
   * @param {string} html - Rendered HTML.
   * @returns {number}
   */
  const legends = (html) => (html.match(/<ul class="train-legend"/g) || []).length;

  describe('once per page', () => {
    it('draws exactly one legend on a page with several cards, in front of the first', () => {
      const html = mainOf(['# Board', fence('tc-train', train()), fence('tc-release', releaseBlock), fence('tc-train', train({ train: 2 }))].join('\n\n'));
      assert.equal(legends(html), 1);
      assert.equal(html.match(/<div class="train-card">/g).length, 3);
      assert.match(html, /<\/h1>\n<ul class="train-legend" aria-label="Car states">.*?<\/ul><div class="train-card">/);
    });

    it('draws it in front of a release panel when that is the first card', () => {
      const html = mainOf([fence('tc-release', releaseBlock), fence('tc-train', train({ train: 2 }))].join('\n\n'));
      assert.equal(legends(html), 1);
      assert.match(html, /<\/ul><section class="release-panel"/);
    });

    it('draws none on a page with no card', () => {
      assert.equal(legends(mainOf('# Plan\n\nWords, and a `tc-train` mention.\n\n```json\n{"train":1}\n```')), 0);
    });

    it('draws none when the only train or release block is refused', () => {
      const html = mainOf([fence('tc-train', train({ bogus: 1 })), fence('tc-release', { ...releaseBlock, version: 'v1' })].join('\n\n'));
      assert.match(html, /Train block not rendered: /);
      assert.match(html, /Release block not rendered: /);
      assert.equal(legends(html), 0);
    });

    it('draws none on a page with only a queue card', () => {
      const html = mainOf(fence('tc-queue', queue));
      assert.match(html, /class="train-card queue-card"/);
      assert.equal(legends(html), 0);
    });

    it('waits for the first card that renders, past a refused block and a queue card', () => {
      const html = mainOf([fence('tc-train', train({ bogus: 1 })), fence('tc-queue', queue), fence('tc-train', train())].join('\n\n'));
      assert.equal(legends(html), 1);
      assert.ok(html.indexOf('<ul class="train-legend"') > html.indexOf('queue-card'));
      assert.match(html, /<\/ul><div class="train-card"><div class="train-cars">/);
    });

    it('draws one when the only card is inside a blockquote', () => {
      const quoted = fence('tc-train', train()).split('\n').map((l) => `> ${l}`).join('\n');
      const html = mainOf(quoted);
      assert.equal(legends(html), 1);
      assert.match(html, /<blockquote><ul class="train-legend"/);
    });

    it('draws one when a card in a blockquote is followed by one outside it, and the other way round', () => {
      const quoted = fence('tc-train', train()).split('\n').map((l) => `> ${l}`).join('\n');
      const plain = fence('tc-train', train({ train: 2 }));
      assert.equal(legends(mainOf(`${quoted}\n\n${plain}`)), 1);
      assert.equal(legends(mainOf(`${plain}\n\n${quoted}`)), 1);
    });

    it('gives every page its own legend', () => {
      const md = fence('tc-train', train());
      assert.equal(legends(mainOf(md)), 1);
      assert.equal(legends(mainOf(md)), 1);
    });

    it('leaves a fragment rendered without a page as the cards alone', () => {
      assert.equal(legends(planDocs.renderPlanBody(fence('tc-train', train()))), 0);
      assert.equal(legends(planDocs.renderPlanBody(fence('tc-release', releaseBlock))), 0);
    });
  });

  describe('what it says', () => {
    const legend = trainCard.renderLegend();

    it('lists every car state once, as a sample pill with its words and its meaning', () => {
      assert.match(legend, /^<ul class="train-legend" aria-label="Car states">(<li>.*?<\/li>)+<\/ul>$/);
      assert.equal(legend.match(/<li>/g).length, trainCard.CAR_STATES.length);
      for (const state of trainCard.CAR_STATES) {
        const item = legend.match(new RegExp(`<li><span class="train-car ${state}">([^<]+)</span> ([^<]+)</li>`));
        assert.ok(item, `${state} is in the legend`);
        assert.equal(item[1], state.replace('-', ' '));
        assert.equal(item[2], trainCard.CAR_STATE_MEANING[state].replace(/&/g, '&amp;'));
      }
    });

    it('says a green car is a closed issue and not proof of shipped code, and that red needs attention', () => {
      assert.match(legend, /<span class="train-car closed">closed<\/span> issue closed — not proof the code is written, ready or shipped</);
      assert.match(legend, /<span class="train-car blocked">blocked<\/span> needs attention/);
      assert.match(legend, /<span class="train-car in-review">in review<\/span> written, pull request open for review</);
      assert.match(legend, /<span class="train-car dropped">dropped<\/span> closed as not planned</);
    });

    it('runs from not started to dropped, whatever order the states are declared in', () => {
      assert.deepEqual(Object.keys(trainCard.CAR_STATE_MEANING), ['open', 'in-progress', 'in-review', 'blocked', 'closed', 'dropped']);
    });
  });

  describe('a state cannot be added half-way', () => {
    const css = trainCard.TRAIN_CARD_CSS;

    it('has legend words for exactly the declared states', () => {
      assert.deepEqual(Object.keys(trainCard.CAR_STATE_MEANING).sort(), [...trainCard.CAR_STATES].sort());
      for (const state of trainCard.CAR_STATES) {
        assert.ok(trainCard.CAR_STATE_MEANING[state].trim().length > 0, `${state} has legend words`);
      }
    });

    it('draws every declared state with words on its pill, words in its table cell and a style rule of its own', () => {
      for (const state of trainCard.CAR_STATES) {
        const closed = trainCard.CLOSED_CAR_STATES.includes(state);
        const html = render(train({ cars: [{ issue: 7, closed, state }] }));
        const pill = html.match(new RegExp(`<summary class="train-car ${state}">#7 <span class="car-state">[a-z ]+</span></summary>`
          + `<span class="car-info"><span class="car-info-head">#7</span><span class="car-info-line"><span class="car-info-state">([a-z ]+)</span>: `));
        assert.ok(pill, `${state} renders as a pill`);
        assert.match(html, new RegExp(`<td class="train-state">[^<]*${pill[1]}</td>`), `${state} is named in the table`);
        assert.ok(css.includes(`\n.train-car.${state}{`), `${state} has a style rule`);
      }
    });
  });

  describe('contrast, in both colour schemes', () => {
    const page = planDocs.renderPlanPage({
      project: { id: 74, name: 'Roadmap' }, file: 'b.md', relative: '.tangleclaw/plans/b.md',
      modifiedAt: '2026-09-27T00:00:00.000Z', markdown: '# B', timeZone: 'UTC'
    });
    const css = page.slice(page.indexOf('<style>') + 7, page.indexOf('</style>'));

    /**
     * The custom properties one rule body declares.
     * @param {string} body - Declarations.
     * @returns {Object<string, string>}
     */
    const tokensOf = (body) => Object.fromEntries([...body.matchAll(/(--[a-z-]+):(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
    const light = tokensOf(css.match(/\n:root\{([^}]*)\}/)[1]);
    const dark = { ...light, ...tokensOf(css.match(/@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}/)[1]) };

    /**
     * One declaration of one rule.
     * @param {string} selector - The rule's whole selector.
     * @param {string} prop - Property name.
     * @returns {string|undefined}
     */
    function declared(selector, prop) {
      const rule = css.match(new RegExp(`\\n${selector.replace(/[.\\-]/g, '\\$&')}\\{([^}]*)\\}`));
      assert.ok(rule, `${selector} has a rule`);
      const decl = rule[1].split(';').map((d) => d.split(':')).find((d) => d[0] === prop);
      return decl && decl.slice(1).join(':');
    }

    /**
     * A colour value as a hex colour, reading a theme token from `tokens`.
     * @param {string} value - `#rrggbb`, `#rgb` or `var(--token)`.
     * @param {Object<string, string>} tokens - The scheme's custom properties.
     * @returns {string} `#rrggbb`.
     */
    function resolve(value, tokens) {
      const token = value.match(/^var\((--[a-z-]+)\)$/);
      const hex = token ? tokens[token[1]] : value;
      assert.match(String(hex), /^#([0-9a-f]{3}|[0-9a-f]{6})$/, `${value} resolves to a colour`);
      return hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
    }

    /**
     * WCAG relative luminance.
     * @param {string} hex - `#rrggbb`.
     * @returns {number}
     */
    function luminance(hex) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    /**
     * WCAG contrast ratio of two colours.
     * @param {string} a - `#rrggbb`.
     * @param {string} b - `#rrggbb`.
     * @returns {number}
     */
    function contrast(a, b) {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    }

    it('computes the textbook ratios, so a pass below means what it says', () => {
      assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
      assert.equal(contrast('#777777', '#777777'), 1);
      assert.ok(contrast('#767676', '#ffffff') >= 4.5 && contrast('#777777', '#ffffff') < 4.5);
    });

    it('reads both schemes from the page stylesheet', () => {
      assert.notEqual(light['--fg'], dark['--fg']);
      assert.notEqual(light['--code-bg'], dark['--code-bg']);
    });

    it('restyles no car inside a colour-scheme block, so each rule read here is the whole story', () => {
      for (const block of css.match(/@media \(prefers-color-scheme:dark\)\{.*\}/g)) {
        assert.doesNotMatch(block, /\.train-car/);
      }
    });

    for (const [scheme, tokens] of [['light', light], ['dark', dark]]) {
      it(`gives every state's pill text at least 4.5:1 against its fill in the ${scheme} scheme`, () => {
        for (const state of trainCard.CAR_STATES) {
          const fill = resolve(declared(`.train-car.${state}`, 'background'), tokens);
          const text = resolve(declared(`.train-car.${state}`, 'color'), tokens);
          const ratio = contrast(text, fill);
          assert.ok(ratio >= 4.5, `${state}: ${text} on ${fill} is ${ratio.toFixed(2)}:1`);
        }
      });

      it(`gives a car's detail at least 4.5:1 for its text against its own background in the ${scheme} scheme`, () => {
        const text = resolve(declared('.car-info', 'color'), tokens);
        const fill = resolve(declared('.car-info', 'background'), tokens);
        const ratio = contrast(text, fill);
        assert.ok(ratio >= 4.5, `${text} on ${fill} is ${ratio.toFixed(2)}:1`);
      });

      it(`gives the legend's words at least 4.5:1 against the page in the ${scheme} scheme`, () => {
        const text = resolve(declared('main.plan ul.train-legend', 'color'), tokens);
        const ratio = contrast(text, tokens['--bg']);
        assert.ok(ratio >= 4.5, `${text} on ${tokens['--bg']} is ${ratio.toFixed(2)}:1`);
      });
    }
  });
});

describe('a car\'s detail (#2165)', () => {
  /**
   * The detail of one car, by issue number.
   * @param {string} html - Rendered HTML.
   * @param {number} issue - Issue number.
   * @returns {string} The detail's inner HTML.
   */
  function infoOf(html, issue) {
    const m = html.match(new RegExp(`<summary class="train-car [a-z-]+">#${issue} <span class="car-state">[a-z ]+</span></summary><span class="car-info">(.*?)</span></details>`));
    assert.ok(m, `#${issue} has a detail`);
    return m[1];
  }

  describe('what it says', () => {
    it('gives the issue number and title, then the state with the meaning the legend gives it', () => {
      const html = render(train({ cars: [{ issue: 411, closed: false, state: 'in-review', title: 'Stale service worker' }] }));
      assert.equal(infoOf(html, 411),
        '<span class="car-info-head">#411 Stale service worker</span>'
        + '<span class="car-info-line"><span class="car-info-state">in review</span>: written, pull request open for review</span>');
    });

    it('takes every state\'s meaning from the one map the legend reads', () => {
      const legend = trainCard.renderLegend();
      for (const state of trainCard.CAR_STATES) {
        const closed = trainCard.CLOSED_CAR_STATES.includes(state);
        const info = infoOf(render(train({ cars: [{ issue: 7, closed, state }] })), 7);
        const said = info.match(/<span class="car-info-state">([^<]+)<\/span>: ([^<]+)<\/span>$/);
        assert.ok(said, `${state} is said in words`);
        assert.equal(said[2], trainCard.CAR_STATE_MEANING[state]);
        assert.ok(legend.includes(`<span class="train-car ${state}">${said[1]}</span> ${said[2]}</li>`), `${state} reads the same in the legend`);
      }
    });

    it('gives a car without a title its number, state and meaning', () => {
      const html = render(train({ cars: [{ issue: 5, closed: false }] }));
      assert.equal(infoOf(html, 5),
        '<span class="car-info-head">#5</span><span class="car-info-line"><span class="car-info-state">open</span>: not started</span>');
    });

    it('adds the reason a car needs attention, and the lane that owns its train, when the block gives them', () => {
      const html = render(train({
        owner: 'Pilot-B2',
        cars: [{ issue: 9, closed: false, state: 'blocked', title: 'Merge', reason: 'Conflicts with main in CHANGELOG.md' }, { issue: 10, closed: true }]
      }));
      assert.equal(infoOf(html, 9),
        '<span class="car-info-head">#9 Merge</span>'
        + '<span class="car-info-line"><span class="car-info-state">blocked</span>: needs attention: merge conflicts, a failed check, or labelled blocked</span>'
        + '<span class="car-info-line">Reason: Conflicts with main in CHANGELOG.md</span>'
        + '<span class="car-info-line">lane: Pilot-B2</span>');
      assert.match(infoOf(html, 10), /<span class="car-info-state">closed<\/span>: [^<]+<\/span><span class="car-info-line">lane: Pilot-B2<\/span>$/);
    });

    it('shows no reason line and no lane line when there is none', () => {
      const info = infoOf(render(train({ cars: [{ issue: 9, closed: false, state: 'blocked' }] })), 9);
      assert.doesNotMatch(info, /Reason:|lane:/);
    });

    it('draws no reason line for a reason that is only spaces', () => {
      const info = infoOf(render(train({ cars: [{ issue: 9, closed: false, state: 'blocked', reason: '   ' }] })), 9);
      assert.doesNotMatch(info, /Reason:/);
    });

    it('shows a reason on a car in any state', () => {
      const info = infoOf(render(train({ cars: [{ issue: 3, closed: false, state: 'in-progress', reason: 'Waiting on #2' }] })), 3);
      assert.match(info, /<span class="car-info-line">Reason: Waiting on #2<\/span>$/);
    });
  });

  describe('the reason field', () => {
    it('escapes the reason and the title, so neither becomes markup', () => {
      const html = render(train({ cars: [{ issue: 1, closed: false, title: '<img src=x onerror=1>', reason: '<script>alert(1)</script> & "more"' }] }));
      assert.doesNotMatch(html, /<img|<script/);
      assert.match(infoOf(html, 1), /Reason: &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;more&quot;<\/span>$/);
      assert.match(infoOf(html, 1), /^<span class="car-info-head">#1 &lt;img src=x onerror=1&gt;<\/span>/);
    });

    it('refuses a reason that is not a string or is over the bound, and accepts one at the bound', () => {
      refused(train({ cars: [{ issue: 1, closed: false, reason: 5 }] }), /cars\[0\]\.reason must be a string/);
      refused(train({ cars: [{ issue: 1, closed: false, reason: 'x'.repeat(trainCard.LIMITS.carReason + 1) }] }), /cars\[0\]\.reason/);
      assert.match(render(train({ cars: [{ issue: 1, closed: false, reason: 'x'.repeat(trainCard.LIMITS.carReason) }] })), /class="train-card"/);
      assert.equal(trainCard.LIMITS.carReason, 300);
    });

    it('still refuses a car key the schema does not name', () => {
      refused(train({ cars: [{ issue: 1, closed: false, owner: 'x' }] }), /cars\[0\] has unknown key/);
    });
  });

  describe('reaching it', () => {
    const html = render(train());

    it('makes every car a keyboard stop by being a summary, which the browser focuses and toggles itself', () => {
      assert.equal(html.match(/<details class="car-slot"><summary class="train-car (?:open|closed)">#\d+ <span class="car-state">(?:open|closed)<\/span><\/summary>/g).length, 2);
      // A summary needs no tabindex, and a positive or negative one would take it out of the natural order.
      assert.doesNotMatch(html, /tabindex/);
    });

    it('starts every car closed, and groups none of them, so opening one never closes another', () => {
      assert.doesNotMatch(html, /<details class="car-slot"[^>]*\s(open|name)\b/);
      assert.equal(html.match(/<details class="car-slot">/g).length, 2);
    });

    it('carries no title attribute on a car, so a browser tooltip never doubles the detail', () => {
      assert.doesNotMatch(html, /<summary class="train-car [a-z-]+"[^>]*\stitle=/);
    });

    it('leaves a car to the browser\'s own disclosure semantics: nothing hides the detail from assistive technology or reads it early', () => {
      const cars = html.match(/<details class="car-slot">.*?<\/details>/g);
      assert.equal(cars.length, 2);
      for (const one of cars) {
        // An opened detail must be readable, and a closed one must not be announced before it is opened.
        assert.doesNotMatch(one, /aria-|role=|\sid=|\shidden|tabindex/);
        assert.match(one, /^<details class="car-slot"><summary class="train-car [a-z-]+">#\d+ <span class="car-state">[a-z ]+<\/span><\/summary><span class="car-info"><span class="car-info-head">#\d+/);
      }
    });

    it('carries no id on any car, so a page of many cards cannot repeat one', () => {
      /**
       * One fenced block.
       * @param {string} info - Info string.
       * @param {object} body - Block object.
       * @returns {string}
       */
      const block = (info, body) => `\`\`\`${info}\n${JSON.stringify(body)}\n\`\`\``;
      /**
       * A release of one train and one bucket.
       * @param {string} version - Release version.
       * @returns {object}
       */
      const rel = (version) => ({ version, trains: [train({ kind: 'train' }), { kind: 'bucket', title: 'B', cars: [{ issue: 411, closed: false }] }] });
      const quoted = block('tc-train', train({ train: 3 })).split('\n').map((l) => `> ${l}`).join('\n');
      const page = planDocs.renderPlanBody(['# Cars', block('tc-train', train()), block('tc-release', rel('5.32.0')), quoted, block('tc-release', rel('5.33.0'))].join('\n\n'));
      assert.equal(page.match(/<details class="car-slot">/g).length, 10);
      assert.deepEqual([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]), ['cars']);
    });

    it('leaves the row of cars reading as each car\'s number and state, and the summary as the train\'s name', () => {
      /**
       * What a fragment says while every car is closed: a closed disclosure's content is not
       * read, and neither is anything marked hidden from assistive technology.
       * @param {string} part - HTML.
       * @returns {string}
       */
      const read = (part) => part.replace(/<span class="car-info".*?<\/span><\/span>/g, '')
        .replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const at = html.indexOf('<details class="train-detail">');
      assert.equal(read(html.slice(html.indexOf('<div class="train-cars">'), at)), '#411 open #1234 closed');
      assert.equal(read(html.slice(at, html.indexOf('</summary>', at))), 'Train 1: First Install, Completed (1/2) verified');
    });

    it('keeps the cars out of the collapsible, so pressing one cannot open or close the train and they show when it is closed', () => {
      const card = render(train({ owner: 'Lane', thesis: 'T', sequencing: 'S' }));
      const at = card.indexOf('<details class="train-detail">');
      const collapsible = card.slice(at);
      const row = card.slice(card.indexOf('<div class="train-cars">'), at);
      assert.ok(card.indexOf('<div class="train-cars">') < at, 'the row of cars comes before the collapsible');
      assert.equal(row.match(/class="train-car /g).length, 2);
      assert.doesNotMatch(collapsible, /train-car|car-info|car-slot|train-engine/);
      assert.doesNotMatch(card, /<details[^>]*\sopen/, 'a train starts closed, with its cars showing');
      // Nothing the train's collapsible hides when closed is a control: the stops are the cars and its own summary.
      assert.equal(collapsible.match(/<summary/g).length, 1);
      assert.equal(collapsible.match(/<details/g).length, 1);
      assert.doesNotMatch(collapsible, /tabindex|contenteditable|<button|<input|<select|<textarea/);
    });

    it('holds no car inside any summary, on a page of trains and releases', () => {
      /**
       * One fenced block.
       * @param {string} info - Info string.
       * @param {object} body - Block object.
       * @returns {string}
       */
      const block = (info, body) => `\`\`\`${info}\n${JSON.stringify(body)}\n\`\`\``;
      const page = planDocs.renderPlanBody([block('tc-train', train()), block('tc-release', { version: '5.32.0', trains: [train({ kind: 'train' })] })].join('\n\n'));
      const summaries = page.match(/<summary class="train-summary"[\s\S]*?<\/summary>/g);
      assert.equal(summaries.length, 2);
      for (const summary of summaries) assert.doesNotMatch(summary, /train-car|car-info|car-slot/);
      assert.equal(page.match(/<div class="train-cars">/g).length, 2);
    });

    it('gives every car in a release panel its detail, with its own workstream\'s lane', () => {
      const panel = planDocs.renderPlanBody(`\`\`\`tc-release\n${JSON.stringify({
        version: '5.32.0',
        trains: [
          { kind: 'train', train: 31, title: 'A', owner: 'Lane one', cars: [{ issue: 1, closed: false, title: 'First' }] },
          { kind: 'bucket', title: 'B', cars: [{ issue: 2, closed: true, state: 'dropped' }] }
        ]
      })}\n\`\`\``);
      assert.match(infoOf(panel, 1), /^<span class="car-info-head">#1 First<\/span>.*<span class="car-info-line">lane: Lane one<\/span>$/);
      assert.match(infoOf(panel, 2), /<span class="car-info-state">dropped<\/span>: closed as not planned<\/span>$/);
      assert.doesNotMatch(infoOf(panel, 2), /lane:/);
    });

    it('renders the same page the same way every time: no car carries state from an earlier render', () => {
      const md = `\`\`\`tc-train\n${JSON.stringify(train())}\n\`\`\``;
      assert.equal(planDocs.renderPlanBody(md), planDocs.renderPlanBody(md));
    });

    it('leaves the legend\'s sample cars and the queue\'s pills as they were', () => {
      assert.doesNotMatch(trainCard.renderLegend(), /tabindex|car-info/);
      const queue = planDocs.renderPlanBody(`\`\`\`tc-queue\n${JSON.stringify({ newDays: 14, issues: [{ issue: 9, createdAt: '2026-09-27T09:30:00Z' }] })}\n\`\`\``,
        0, { now: Date.parse('2026-09-28T00:00:00Z') });
      assert.match(queue, /<span class="train-car queue-new" title="#9 new" aria-label="#9 new">#9<\/span>/);
      assert.doesNotMatch(queue, /car-info/);
    });
  });

  describe('a closed car says its state without colour', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const WORDS = { open: 'open', 'in-progress': 'in progress', 'in-review': 'in review', blocked: 'blocked', closed: 'closed', dropped: 'dropped' };
    const html = render(train({
      cars: trainCard.CAR_STATES.map((state, i) => ({ issue: 100 + i, closed: trainCard.CLOSED_CAR_STATES.includes(state), state }))
    }));
    const summaries = [...html.matchAll(/<details class="car-slot"><summary class="train-car ([a-z-]+)">(.*?)<\/summary>/g)];

    it('shows every one of the six states as a visible word beside the car\'s number, on the closed car', () => {
      assert.equal(summaries.length, 6);
      assert.deepEqual(summaries.map((m) => m[1]), [...trainCard.CAR_STATES]);
      summaries.forEach(([, state, inner], i) => {
        assert.equal(inner, `#${100 + i} <span class="car-state">${WORDS[state]}</span>`);
      });
      assert.equal(new Set(summaries.map((m) => m[2].replace(/#\d+ /, ''))).size, 6, 'no two states share a word');
    });

    it('gives the summary that same text as its name: the number and the state word, nothing hidden and nothing added', () => {
      summaries.forEach(([, state, inner], i) => {
        assert.equal(inner.replace(/<[^>]+>/g, ''), `#${100 + i} ${WORDS[state]}`);
        assert.doesNotMatch(inner, /aria-|hidden|title=/);
      });
      assert.doesNotMatch(html, /<summary class="train-car [a-z-]+"[^>]*\s(aria-|role=|title=|tabindex)/);
    });

    // The word has no rule of its own, so the rules that can hide it are the ones on the boxes it sits in:
    // the release panel, the card, the row of cars, the car's disclosure, the pill and each of its states.
    const REACHES_THE_WORD = /(^|[\s>+~,])(\.car-state|summary\.train-car|\.train-car|details\.car-slot|\.train-cars|\.train-card|section\.release-panel)(?![\w-])/;
    // What would hide, clip, shrink or blank the text a box holds.
    const HIDES = /(^|;)\s*(display\s*:\s*none|visibility\s*:|opacity\s*:|font-size\s*:\s*0(?![.\d])|overflow[a-z-]*\s*:|clip(-path)?\s*:|text-indent\s*:|(max-)?(width|height)\s*:|position\s*:\s*(absolute|fixed)|color\s*:\s*transparent|content-visibility\s*:)/;

    /**
     * The style rules that can reach a car's state word. A rule inside an at-rule block, such as a
     * rule for narrow screens, is taken out of its block and read like any other, so it is not missed.
     * A rule on a pseudo-element styles something else (the disclosure's marker or its content) and is
     * left out.
     * @param {string} css - A stylesheet.
     * @returns {{selector: string, body: string}[]}
     */
    function rulesReachingTheWord(css) {
      const flat = css.replace(/@[^{};]+\{((?:[^{}]+\{[^}]*\})*)\s*\}/g, '$1');
      assert.doesNotMatch(flat, /@[^{};]+\{/, 'every at-rule block was opened up');
      return (flat.match(/[^{}]+\{[^}]*\}/g) || [])
        .map((rule) => ({ selector: rule.split('{')[0].trim(), body: rule.slice(rule.indexOf('{') + 1, -1) }))
        .filter(({ selector }) => REACHES_THE_WORD.test(selector) && !selector.includes('::'));
    }

    it('never hides the state word by any style, so it is there for a reader who cannot tell the colours apart', () => {
      const rules = rulesReachingTheWord(trainCard.TRAIN_CARD_CSS);
      const selectors = rules.map((rule) => rule.selector);
      // The set is not empty, and it holds the boxes named above: one rule per car state among them.
      for (const expected of ['section.release-panel', '.train-card', '.train-cars', '.train-car', 'details.car-slot', 'summary.train-car',
        ...trainCard.CAR_STATES.map((state) => `.train-car.${state}`)]) {
        assert.ok(selectors.includes(expected), `${expected} is among the rules checked`);
      }
      for (const { selector, body } of rules) {
        assert.doesNotMatch(body, HIDES, `${selector} must not hide, clip, shrink or blank what it holds`);
      }
    });

    it('would catch each way of hiding the word, so the rule above is not passing on nothing', () => {
      for (const hidden of ['display:none', 'visibility:hidden', 'opacity:0', 'font-size:0', 'overflow:hidden', 'clip-path:inset(50%)',
        'clip:rect(0 0 0 0)', 'text-indent:-999px', 'width:1px', 'max-width:3ch', 'height:0', 'max-height:0', 'position:absolute',
        'position:fixed', 'color:transparent', 'content-visibility:hidden']) {
        assert.match(`padding:.1em;${hidden}`, HIDES, hidden);
      }
      for (const fine of ['display:block;list-style:none;cursor:pointer', 'display:contents', 'font:.82em ui-monospace;white-space:nowrap;color:var(--fg)',
        'background:#57606a;border-color:#57606a;color:#fff;text-decoration:line-through', 'box-shadow:0 0 0 2px var(--link)', 'font-size:.82em']) {
        assert.doesNotMatch(fine, HIDES, fine);
      }
    });

    it('sees a rule for narrow screens or one colour scheme as well as a plain one', () => {
      const plain = rulesReachingTheWord('.train-car{color:#fff}');
      assert.deepEqual(plain, [{ selector: '.train-car', body: 'color:#fff' }]);
      const nested = rulesReachingTheWord('\n.a{b:c}\n@media (max-width:30rem){.car-state{display:none}summary.train-car{max-width:4ch}}\n.train-cars{gap:1px}');
      assert.deepEqual(nested.map((rule) => rule.selector), ['.car-state', 'summary.train-car', '.train-cars']);
      assert.equal(nested.filter((rule) => HIDES.test(rule.body)).length, 2, 'both hiding rules inside the block are caught');
      // The real stylesheet has an at-rule block; nothing in it is lost when it is opened up.
      assert.match(trainCard.TRAIN_CARD_CSS, /@media \(prefers-color-scheme:dark\)\{/);
      assert.deepEqual(rulesReachingTheWord('@media (prefers-color-scheme:dark){.train-car.open{opacity:0}}').map((rule) => rule.body), ['opacity:0']);
      assert.deepEqual(rulesReachingTheWord('summary.train-car::-webkit-details-marker{display:none}details.car-slot::details-content{display:none}'), []);
    });

    it('uses the same word on the car, in its detail and in the legend', () => {
      const legend = trainCard.renderLegend();
      summaries.forEach(([whole, state]) => {
        const word = WORDS[state];
        const at = html.indexOf(whole);
        assert.ok(html.slice(at, at + 400).includes(`<span class="car-info-state">${word}</span>`), `${state} in its detail`);
        assert.ok(legend.includes(`<span class="train-car ${state}">${word}</span>`), `${state} in the legend`);
      });
    });

    it('keeps the user guide\'s list of the six meanings word for word with the legend\'s', () => {
      const guide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'user-guide.md'), 'utf8');
      for (const state of trainCard.CAR_STATES) {
        assert.ok(guide.includes(`  - **${WORDS[state]}**: ${trainCard.CAR_STATE_MEANING[state]}\n`), `the guide gives ${state} the legend's meaning`);
      }
      assert.equal(guide.match(/^ {2}- \*\*(?:open|in progress|in review|blocked|closed|dropped)\*\*: /gm).length, 6, 'the guide lists each state once');
    });
  });

  describe('opening it', () => {
    it('makes each car a disclosure: the pill is its summary and the detail its only content, before the joint to the next', () => {
      const row = render(train()).match(/<div class="train-cars">(.*?)<\/div><details class="train-detail">/)[1];
      const order = [...row.matchAll(/<(?:span|details|summary) class="(train-engine|train-joint|car-slot|train-car|car-info)[ "]/g)].map((m) => m[1]);
      assert.deepEqual(order, ['train-engine', 'train-joint', 'car-slot', 'train-car', 'car-info', 'train-joint', 'car-slot', 'train-car', 'car-info']);
      assert.equal(row.match(/<\/span><\/details>/g).length, 2);
    });

    it('keeps the whole of a 300-character title and a 300-character reason, with nothing cut', () => {
      const title = 'T'.repeat(trainCard.LIMITS.carTitle);
      const reason = 'R'.repeat(trainCard.LIMITS.carReason);
      assert.equal(trainCard.LIMITS.carTitle, 300);
      const info = infoOf(render(train({ cars: [{ issue: 1, closed: false, state: 'blocked', title, reason }] })), 1);
      assert.ok(info.includes(`<span class="car-info-head">#1 ${title}</span>`));
      assert.ok(info.includes(`<span class="car-info-line">Reason: ${reason}</span>`));
    });
  });

  describe('page styles', () => {
    const css = trainCard.TRAIN_CARD_CSS;
    const detail = css.match(/\n\.car-info\{([^}]*)\}/)[1];

    it('opens nothing on hover: no rule for a car or its detail depends on the pointer being over it', () => {
      const rules = css.match(/[^{}]+\{[^}]*\}/g).filter((r) => /car-slot|train-car|car-info/.test(r.split('{')[0]));
      assert.ok(rules.length > 8);
      for (const rule of rules) assert.doesNotMatch(rule.split('{')[0], /:hover|:focus(?!-visible)|:focus-within|:active|:target|:checked/, rule.split('{')[0]);
    });

    it('opens a car\'s detail only through the disclosure\'s own open state', () => {
      assert.match(css, /\ndetails\.car-slot::details-content\{display:none\}/);
      assert.match(css, /\ndetails\.car-slot\[open\]::details-content\{display:block;flex:0 0 100%\}/);
      assert.ok(css.indexOf('\ndetails.car-slot::details-content{') < css.indexOf('\ndetails.car-slot[open]::details-content{'));
    });

    it('gives the disclosure no box, so a closed car sits in the row as before and an open detail takes a full line under it', () => {
      assert.match(css, /\ndetails\.car-slot\{display:contents\}/);
      assert.match(css, /\n\.train-cars\{[^}]*display:flex;flex-wrap:wrap[^}]*\}/);
      // Meant as the fallback where a browser cannot style the disclosure's content slot: the detail would then be
      // the full-line item itself. That is reasoned from the rule below; it has not been seen in such a browser.
      assert.match(detail, /(^|;)display:block(;|$)/);
      assert.match(detail, /(^|;)flex:0 0 100%(;|$)/);
      assert.match(detail, /(^|;)box-sizing:border-box(;|$)/);
    });

    it('keeps the detail in the flow: never positioned, layered or moved', () => {
      assert.doesNotMatch(css, /(car-slot|car-info)[^{]*\{[^}]*(position:|z-index|(^|;|\{)(top|left|right|bottom|transform|translate|float):)/);
    });

    it('draws the pill as the summary without a disclosure marker, and marks the car whose detail is open', () => {
      assert.match(css, /\nsummary\.train-car\{display:block;list-style:none;cursor:pointer\}/);
      assert.match(css, /\nsummary\.train-car::-webkit-details-marker\{display:none\}/);
      assert.match(css, /\ndetails\.car-slot\[open\]>summary\.train-car\{box-shadow:0 0 0 2px var\(--link\)\}/);
      assert.match(css, /\n\.train-car:focus-visible\{outline:2px solid var\(--link\);outline-offset:2px\}/);
    });

    it('cuts nothing off: no fixed height, no clipping, no single-line text', () => {
      assert.doesNotMatch(detail, /(^|;)(height|max-height|overflow[a-z-]*|text-overflow|white-space|max-width|width):/);
      assert.doesNotMatch(css, /\.car-info[a-z-]*\{[^}]*(text-overflow|overflow:hidden|white-space:nowrap)/);
    });

    it('never hides, layers or fades a detail by any rule other than the disclosure\'s content', () => {
      assert.doesNotMatch(css, /(car-slot|car-info)[^{]*\{[^}]*(opacity|visibility|pointer-events|z-index)/);
      assert.doesNotMatch(css, /:has\(/);
      assert.doesNotMatch(css, /\.car-info[a-z-]*\{[^}]*display:none/);
    });

    it('reads as ordinary text in the theme\'s colours', () => {
      assert.match(detail, /(^|;)color:var\(--fg\)(;|$)/);
      assert.match(detail, /(^|;)background:var\(--code-bg\)(;|$)/);
    });
  });
});
