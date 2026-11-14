'use strict';

/*
 * #1478 — on a phone the session banner's actions wrapped with Kill stranded
 * on a line of its own. Wrap and Kill are now one flex item, and the phone
 * rule tightens padding and gaps without shrinking the 30px touch target.
 * Layout itself was measured in headless Chrome at 390/375/360px; these tests
 * pin the markup and the CSS rules that layout rests on.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');
const SESSION_CSS = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');
const SHARED_CSS = fs.readFileSync(path.join(PUBLIC, 'shared-controls.css'), 'utf8');

/**
 * The declarations of the first rule for `selector` inside `css`.
 * @param {string} css
 * @param {string} selector - Exact selector text as written
 * @returns {string|null}
 */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return m ? m[1] : null;
}

/**
 * Every `@media (max-width: 600px)` block's body in `css`.
 * @param {string} css
 * @returns {string[]}
 */
function phoneBlocks(css) {
  return [...css.matchAll(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
}

describe('#1478 Wrap and Kill wrap together on a phone', () => {
  it('markup: Wrap and Kill are the only buttons in one wrapper, at the end of the banner actions', () => {
    const m = SESSION_HTML.match(/<span class="banner-end-actions">([\s\S]*?)<\/span>/);
    assert.ok(m, 'the wrapper exists');
    const ids = [...m[1].matchAll(/id="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(ids, ['wrapBtn', 'killBtn']);
    // From the pair's closing tag to the end of the banner actions. Both
    // searches start at the wrapper, so an earlier `</div>` (the Medusa panel)
    // cannot end the slice before it starts.
    const wrapperAt = SESSION_HTML.indexOf('<span class="banner-end-actions">');
    const pairEnd = SESSION_HTML.indexOf('</span>', wrapperAt) + '</span>'.length;
    const actionsEnd = SESSION_HTML.indexOf('</div>', pairEnd);
    const headerEnd = SESSION_HTML.indexOf('</header>', wrapperAt);
    assert.ok(wrapperAt > SESSION_HTML.indexOf('<div class="banner-actions">'), 'the pair is inside the banner actions');
    assert.ok(pairEnd < actionsEnd && actionsEnd < headerEnd, 'the slice is non-empty and ends at the banner actions');
    assert.doesNotMatch(SESSION_HTML.slice(pairEnd, actionsEnd), /<button/, 'nothing follows the pair inside the banner actions');
  });

  it('css: the pair is one flex item that does not shrink or split', () => {
    const body = ruleBody(SESSION_CSS, '.banner-end-actions');
    assert.ok(body, 'a .banner-end-actions rule exists');
    assert.match(body, /display: inline-flex/);
    assert.match(body, /flex-shrink: 0/);
    assert.doesNotMatch(body, /flex-wrap: wrap/);
  });

  it('css: the phone rule tightens padding and gaps but never the touch target', () => {
    const block = phoneBlocks(SESSION_CSS).find((b) => /\.banner-btn \{/.test(b));
    assert.ok(block, 'a phone rule for .banner-btn exists');
    const btn = block.match(/\.banner-btn \{([^}]*)\}/)[1];
    assert.match(btn, /padding: 2px 4px/);
    assert.doesNotMatch(btn, /min-(width|height)/, 'the phone rule must not lower the 30px minimum');
    assert.match(block, /\.banner-actions,\s*\.banner-end-actions \{ gap: 3px; \}/);

    const shared = ruleBody(SHARED_CSS, '.banner-btn');
    assert.match(shared, /min-height: 30px/);
    assert.match(shared, /min-width: 30px/);
  });
});

/*
 * #1571 — the banner cut the project name at a fixed width (160px; 100px on a
 * phone; 200px on a desktop) whatever the row had free, so a 24-character
 * name read as "JasonVaughanCo…" beside empty space. Measured on a scratch
 * server before the fix: 100px of a 187px name at every width from 375 to
 * 600, with 36px free at 412 and 224px free at 600. The name is now a flex
 * item that grows into the row's free space and ellipsizes only when the row
 * is genuinely short. A cap in ANY rule would bring the bug back, so every
 * `.banner-name` rule in the file is checked, comments stripped first (a
 * declaration named in prose must not read as present, and a stray comment
 * closer would delete the rule after it while a substring test stayed green).
 */
describe('#1571 the banner name takes the row\'s free space before it truncates', () => {
  const stripped = SESSION_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

  /**
   * Every rule body for `selector` in `css`, in source order.
   * @param {string} css
   * @param {string} selector - Exact selector text as written
   * @returns {string[]}
   */
  function ruleBodies(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...css.matchAll(new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`, 'gm'))].map((m) => m[1]);
  }

  it('css: the base rule grows into free space, may shrink to zero, and still ellipsizes', () => {
    const body = ruleBody(stripped, '.banner-name');
    assert.ok(body, 'a .banner-name rule exists');
    assert.match(body, /flex: 1 1 auto/);
    assert.match(body, /min-width: 0/);
    assert.match(body, /text-overflow: ellipsis/);
    assert.match(body, /white-space: nowrap/);
  });

  it('css: no rule anywhere in the file caps the name\'s width', () => {
    const bodies = ruleBodies(stripped, '.banner-name');
    assert.ok(bodies.length >= 1, 'at least the base rule exists');
    for (const body of bodies) {
      assert.doesNotMatch(body, /max-width/, `a .banner-name rule caps the width: {${body.trim()}}`);
      assert.doesNotMatch(body, /(^|[^-])width\s*:/, `a .banner-name rule fixes the width: {${body.trim()}}`);
    }
  });

  it('css: the stylesheet still parses as a stylesheet (no orphan comment closer, balanced braces)', () => {
    assert.doesNotMatch(stripped, /\*\//, 'an orphan */ would swallow the rule after it');
    assert.doesNotMatch(stripped, /\/\*/, 'an unterminated /* would swallow the rest of the file');
    const opens = (stripped.match(/\{/g) || []).length;
    const closes = (stripped.match(/\}/g) || []).length;
    assert.equal(opens, closes, 'braces balance');
  });
});

/*
 * #3065 — every Classic page offers a way into the v6 Fleet Shell. The
 * dashboard has its own switcher (#v6ViewToggleBtn); the Classic session page
 * and the OpenClaw view now carry a matching link. The session page's link
 * starts at the shell's default route and is pointed at that session's own
 * conversation once the project row loads.
 */
describe('#3065 a Fleet Shell (v6) link on every Classic page', () => {
  const vm = require('node:vm');
  const { liftDeclaration } = require('./helpers/lift');
  const OPENCLAW_HTML = fs.readFileSync(path.join(PUBLIC, 'openclaw-view.html'), 'utf8');
  const SESSION_JS = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');

  /**
   * The opening tag of the element with `id` in `html`.
   * @param {string} html
   * @param {string} id
   * @returns {string|null}
   */
  function openingTag(html, id) {
    const m = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`, 's'));
    return m ? m[0] : null;
  }

  for (const [page, html, id] of [['session.html', SESSION_HTML, 'sessionV6Link'], ['openclaw-view.html', OPENCLAW_HTML, 'openclawV6Link']]) {
    it(`markup: ${page} has the link, labelled and pointing at the shell's default route`, () => {
      const tag = openingTag(html, id);
      assert.ok(tag, `#${id} is missing from ${page}`);
      assert.match(tag, /^<a\b/, 'a real link, so it works without script and opens in a new tab on demand');
      assert.match(tag, /class="banner-btn v6-view-toggle"/);
      assert.match(tag, /href="\/#\/projects\/default"/);
      assert.match(tag, /title="Switch to Fleet Shell \(v6\)"/);
      assert.match(tag, /aria-label="Switch to Fleet Shell \(v6\)"/);
      assert.ok(html.includes(`${tag}Fleet Shell (v6)</a>`), 'the visible text matches the dashboard switcher');
    });
  }

  it('markup: on the session page it leads the banner actions, so Wrap and Kill stay last (#1478)', () => {
    const actions = SESSION_HTML.indexOf('<div class="banner-actions">');
    const link = SESSION_HTML.indexOf('id="sessionV6Link"');
    const endActions = SESSION_HTML.indexOf('<span class="banner-end-actions">');
    assert.ok(actions > -1 && link > actions, 'inside .banner-actions');
    assert.ok(link < endActions, 'before the Wrap/Kill pair');
    assert.ok(link < SESSION_HTML.indexOf('id="projectActions"'), 'ahead of the project actions');
  });

  it('markup: on the OpenClaw view it sits in the banner row', () => {
    const row = OPENCLAW_HTML.indexOf('<div class="banner-row">');
    const link = OPENCLAW_HTML.indexOf('id="openclawV6Link"');
    const rowEnd = OPENCLAW_HTML.indexOf('</div>', row);
    assert.ok(row > -1 && link > row && link < rowEnd);
  });

  it('css: session.css styles the link on its own, because the OpenClaw view does not load shared-controls.css', () => {
    assert.equal(OPENCLAW_HTML.includes('shared-controls.css'), false, 'premise: if this changes, the rule may lean on .banner-btn');
    assert.ok(OPENCLAW_HTML.includes('href="/session.css"'), 'premise: the OpenClaw view does load session.css');
    const body = ruleBody(SESSION_CSS, '.v6-view-toggle');
    assert.ok(body, 'a .v6-view-toggle rule in session.css');
    for (const decl of [/border:\s*1px solid #56d364/, /color:\s*#56d364/, /min-height:\s*30px/, /text-decoration:\s*none/, /white-space:\s*nowrap/]) {
      assert.match(body, decl);
    }
    assert.match(ruleBody(SESSION_CSS, '.v6-view-toggle:focus-visible') || '', /outline:\s*2px solid/, 'a visible keyboard focus ring');
  });

  /**
   * Run the real `loadProject` from session.js against a project row, with
   * every other banner renderer stubbed, and return the link it leaves.
   * @param {object|null} row - What the project API answers
   * @param {boolean} [withLink] - Whether the page has the link at all
   * @returns {Promise<{href: string}|null>}
   */
  async function loadWith(row, withLink = true) {
    const link = withLink ? { href: '/#/projects/default' } : null;
    const el = () => ({ textContent: '', title: '', setAttribute() {} });
    const elements = { sessionV6Link: link, bannerName: el(), bannerEngine: el() };
    const ctx = {
      projectName: 'demo',
      sessionState: {},
      api: async () => row,
      renderCheckoutChip() {}, loadModelStatus: async () => {}, renderModelEffortDivergence() {},
      renderBannerGroups() {}, renderProjectActions() {},
      document: { getElementById: (id) => (id in elements ? elements[id] : el()), title: '' },
      encodeURIComponent
    };
    vm.createContext(ctx);
    vm.runInContext(liftDeclaration(SESSION_JS, 'async function loadProject()'), ctx);
    vm.runInContext('var _lastCheckoutAt = 0;', ctx);
    await ctx.loadProject();
    return link;
  }

  it('script: once the project loads, the link opens that session\'s own conversation', async () => {
    const link = await loadWith({ id: 42, name: 'demo', groups: [], actions: [] });
    assert.equal(link.href, '/#/resources/42/conversation');
  });

  it('script: the project id is URL-encoded into the route', async () => {
    const link = await loadWith({ id: 'a/b c?#', name: 'demo', groups: [], actions: [] });
    assert.equal(link.href, '/#/resources/a%2Fb%20c%3F%23/conversation');
  });

  it('script: with no id, or no project at all, the link keeps the default route', async () => {
    assert.equal((await loadWith({ name: 'demo', groups: [], actions: [] })).href, '/#/projects/default');
    assert.equal((await loadWith(null)).href, '/#/projects/default');
  });

  it('script: a page without the link loads its project without throwing', async () => {
    await assert.doesNotReject(loadWith({ id: 7, name: 'demo', groups: [], actions: [] }, false));
  });
});

describe('the session page reads its project from the URL, path or ?project= (#3073)', () => {
  const vm = require('node:vm');
  const { liftDeclaration } = require('./helpers/lift');
  const SESSION_JS = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
  /** Run the real sessionProjectName under a given location. */
  const nameAt = (pathname, search) => {
    const ctx = { window: { location: { pathname, search: search || '' } }, URLSearchParams, decodeURIComponent };
    vm.createContext(ctx);
    vm.runInContext(liftDeclaration(SESSION_JS, 'function sessionProjectName()'), ctx);
    return vm.runInContext('sessionProjectName()', ctx);
  };

  it('the canonical /session/<name> path, decoded, with or without a trailing slash', () => {
    assert.equal(nameAt('/session/TC-Lane-A'), 'TC-Lane-A');
    assert.equal(nameAt('/session/TiLT%20v2/'), 'TiLT v2');
  });

  it('/session.html?project= and /session?project= resolve to the query\'s project, not to "session.html"', () => {
    assert.equal(nameAt('/session.html', '?project=TV-PM'), 'TV-PM');
    assert.equal(nameAt('/session', '?project=A%20B'), 'A B');
    assert.equal(nameAt('/session/', '?project=C'), 'C');
  });

  it('/session.html with no project names none, rather than "session.html"', () => {
    assert.equal(nameAt('/session.html', ''), '');
  });

  it('the page computes its project through that function', () => {
    assert.match(SESSION_JS, /const projectName = sessionProjectName\(\);/);
  });
});
