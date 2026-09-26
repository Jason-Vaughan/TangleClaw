'use strict';

/*
 * #1472 / #1474 / #1475 / #1476 — the session header cleanup: two or more
 * groups share one counted pill, the command bar and Peek buttons move behind
 * one ⋯ menu (still reachable, never removed), and the settings gear asks for
 * its emoji form. Behaviour is tested by RUNNING the page's functions against
 * a small DOM stub; markup by reading the real files.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8');

/**
 * Slice a top-level function out of a script by brace matching.
 * @param {string} src
 * @param {string} name
 * @returns {string}
 */
function extract(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} should exist`);
  const head = src.lastIndexOf('\n', start) + 1;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(head, i + 1);
    }
  }
  throw new Error(`could not brace-match ${name}`);
}

/**
 * An element with a real class set and readable attributes.
 * @returns {object}
 */
function node() {
  const classes = new Set();
  const attrs = {};
  return {
    innerHTML: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { if (force) classes.add(c); else classes.delete(c); }
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    focus() {}
  };
}

/**
 * The header functions in a sandbox over named stub elements.
 * @param {object} [answers] - url → `api()` answer (missing means refused)
 * @returns {{ els: object, ctx: object, calls: string[] }}
 */
function load(answers = {}) {
  const ids = ['moreBtn', 'moreMenu', 'bannerUser', 'bannerUserPop', 'bannerGroups', 'groupsPop',
    'otherPop', 'commandBar', 'cmdBtn', 'commandInput', 'groupPop-g1', 'peekBtn', 'copyBtn', 'selectBtn', 'uploadBtn'];
  const els = Object.fromEntries(ids.map((id) => [id, node()]));
  const calls = [];
  const ctx = vm.createContext({
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => [els.moreMenu, els.bannerUserPop, els.groupsPop, els.otherPop]
        .filter((p) => p.classList.contains('open'))
    },
    projectName: 'alpha',
    sessionState: { commandBarOpen: false },
    api: async (url) => {
      calls.push(url);
      return Object.prototype.hasOwnProperty.call(answers, url) ? answers[url] : null;
    }
  });
  const fns = ['esc', 'closeBannerPopovers', 'syncBannerExpanded', 'toggleMoreMenu', 'onMoreMenuClick',
    'clickHitsSelector', 'renderBannerGroups', 'groupPopoverHtml', 'toggleGroupsPopover', 'toggleCommandBar',
    'toggleGroupPopover', 'onGroupPillKey', 'applyWebuiMode'];
  vm.runInContext(`let bannerGroupNames = {};\n${fns.map((f) => extract(SESSION_SRC, f)).join('\n')}\n`
    + fns.map((f) => `this.${f} = ${f};`).join('\n'), ctx);
  return { els, ctx, calls };
}

/**
 * A click as `clickHitsSelector` reads it: the dispatch-time path, each node
 * answering `matches` for one tag or class.
 * @param {...string} kinds - Target first, then ancestors: 'button' or '.class'
 * @returns {object}
 */
function clickOn(...kinds) {
  const pathNodes = kinds.map((k) => ({ matches: (sel) => sel === k }));
  return { composedPath: () => pathNodes };
}

describe('the ⋯ menu holds the command bar and Peek (#1474, #1475)', () => {
  it('markup: both buttons live inside the menu, keep their ids, and are no longer loose in the banner', () => {
    const menuStart = SESSION_HTML.indexOf('id="moreMenu"');
    const menuEnd = SESSION_HTML.indexOf('</span>', menuStart);
    assert.ok(menuStart > -1, 'the menu exists');
    for (const id of ['cmdBtn', 'peekBtn']) {
      const at = SESSION_HTML.indexOf(`id="${id}"`);
      assert.ok(at > menuStart && at < menuEnd, `#${id} is inside the ⋯ menu`);
      assert.equal(SESSION_HTML.split(`id="${id}"`).length, 2, `#${id} appears once`);
    }
    assert.match(SESSION_HTML, /<button class="banner-btn" id="moreBtn"[^>]*aria-haspopup="true"[^>]*aria-expanded="false"[^>]*aria-controls="moreMenu"/);
    assert.ok(SESSION_HTML.indexOf('id="bannerMoreWrap"') < SESSION_HTML.indexOf('id="chimeBtn"'),
      'the menu sits where the command bar button was, before the chime');
  });

  it('the dashboard keeps its Peek', () => {
    assert.match(UI_SRC, /openPeekFromCard\(\$\{nArg\}\)" title="Peek"/);
  });

  it('opens and closes on its button, keeping aria-expanded true to the menu', () => {
    const { els, ctx } = load();
    ctx.toggleMoreMenu();
    assert.equal(els.moreMenu.classList.contains('open'), true);
    assert.equal(els.moreBtn.getAttribute('aria-expanded'), 'true');
    ctx.toggleMoreMenu();
    assert.equal(els.moreMenu.classList.contains('open'), false);
    assert.equal(els.moreBtn.getAttribute('aria-expanded'), 'false');
  });

  it('is one banner popover among the rest: opening it closes another, and a close from outside resets aria-expanded', () => {
    const { els, ctx } = load();
    els.otherPop.classList.add('open');
    ctx.toggleMoreMenu();
    assert.equal(els.otherPop.classList.contains('open'), false);
    ctx.closeBannerPopovers();
    assert.equal(els.moreMenu.classList.contains('open'), false);
    assert.equal(els.moreBtn.getAttribute('aria-expanded'), 'false');
  });

  it('closes once one of its buttons is used, and not on a click between them', () => {
    const { els, ctx } = load();
    ctx.toggleMoreMenu();
    ctx.onMoreMenuClick(clickOn('.banner-more-menu'));
    assert.equal(els.moreMenu.classList.contains('open'), true, 'padding is not a choice');
    ctx.onMoreMenuClick(clickOn('button', '.banner-more-menu'));
    assert.equal(els.moreMenu.classList.contains('open'), false);
    assert.equal(els.moreBtn.getAttribute('aria-expanded'), 'false');
  });

  it('is disabled in a Web UI session, where everything it holds is, and the command bar is closed with every mark of it', () => {
    const { els, ctx } = load();
    ctx.toggleCommandBar();
    ctx.applyWebuiMode();
    for (const id of ['moreBtn', 'cmdBtn', 'peekBtn']) assert.equal(els[id].disabled, true, id);
    assert.match(els.moreBtn.title, /not available for Web UI sessions/);
    assert.equal(ctx.sessionState.commandBarOpen, false);
    assert.equal(els.commandBar.classList.contains('hidden'), true);
    assert.equal(els.moreBtn.classList.contains('active'), false);
    assert.equal(els.cmdBtn.classList.contains('active'), false);
    assert.equal(els.cmdBtn.getAttribute('aria-expanded'), 'false');
  });

  it('marks ⋯ while the command bar is open, since the bar\'s own button is out of sight', () => {
    const { els, ctx } = load();
    ctx.toggleCommandBar();
    assert.equal(els.moreBtn.classList.contains('active'), true);
    assert.equal(els.cmdBtn.getAttribute('aria-expanded'), 'true');
    ctx.toggleCommandBar();
    assert.equal(els.moreBtn.classList.contains('active'), false);
  });

  it('is wired, and a click inside it is not an outside click', () => {
    assert.match(SESSION_SRC, /\$\('moreBtn'\)\.addEventListener\('click', toggleMoreMenu\)/);
    assert.match(SESSION_SRC, /\$\('moreMenu'\)\.addEventListener\('click', onMoreMenuClick\)/);
    assert.match(SESSION_SRC, /\$\('cmdBtn'\)\.addEventListener\('click', toggleCommandBar\)/);
    assert.match(SESSION_SRC, /\$\('peekBtn'\)\.addEventListener\('click', openPeek\)/);
    assert.match(extract(SESSION_SRC, 'onBannerOutsideClick'), /\.banner-more-wrap/);
  });
});

describe('two or more groups share one pill (#1472)', () => {
  const groups = [
    { id: 'g1', name: 'Backend' },
    { id: 'g2', name: '<i>Ops</i>' },
    { id: 'g3', name: 'Tools' }
  ];

  it('renders nothing with no groups, and one named pill for a single group', () => {
    const { els, ctx } = load();
    ctx.renderBannerGroups([]);
    assert.equal(els.bannerGroups.innerHTML, '');
    ctx.renderBannerGroups([groups[0]]);
    assert.match(els.bannerGroups.innerHTML, /class="group-pill"[^>]*data-tooltip="Project group"[^>]*onclick="toggleGroupPopover\(this, 'g1'\)"[^>]*>Backend</);
    assert.equal((els.bannerGroups.innerHTML.match(/class="group-pill"/g) || []).length, 1);
  });

  it('renders ONE counted pill for several groups, carrying their ids and no names', () => {
    const { els, ctx } = load();
    ctx.renderBannerGroups(groups);
    const html = els.bannerGroups.innerHTML;
    assert.equal((html.match(/class="group-pill"/g) || []).length, 1);
    assert.match(html, /data-group-ids="g1,g2,g3"/);
    assert.match(html, /data-tooltip="Project groups"/);
    assert.match(html, />3 groups</);
    assert.doesNotMatch(html, /Backend|Ops/);
  });

  it('opens a popover listing every group with its members, this project marked, names escaped', async () => {
    const { els, ctx, calls } = load({
      '/api/groups/g1': { name: 'Backend', members: [{ name: 'alpha' }, { name: 'beta' }] },
      '/api/groups/g2': { name: '<i>Ops</i>', members: [{ name: 'gamma' }], docs: [{}, {}] },
      '/api/groups/g3': { name: 'Tools', members: [] }
    });
    ctx.renderBannerGroups(groups);
    const pill = { getAttribute: () => 'g1,g2,g3' };
    await ctx.toggleGroupsPopover(pill);
    const html = els.groupsPop.innerHTML;
    assert.deepEqual(calls, ['/api/groups/g1', '/api/groups/g2', '/api/groups/g3']);
    assert.equal(els.groupsPop.classList.contains('open'), true);
    assert.ok(html.indexOf('Backend') < html.indexOf('&lt;i&gt;Ops') && html.indexOf('&lt;i&gt;Ops') < html.indexOf('Tools'));
    assert.doesNotMatch(html, /<i>Ops/);
    assert.match(html, /group-popover-member current">alpha</);
    assert.match(html, /2 shared docs/);
    assert.equal((html.match(/groups-popover-sep/g) || []).length, 2);
  });

  it('names a group whose details failed to load and says so, instead of dropping it', async () => {
    const { els, ctx } = load({ '/api/groups/g1': { name: 'Backend', members: [] } });
    ctx.renderBannerGroups(groups.slice(0, 2));
    await ctx.toggleGroupsPopover({ getAttribute: () => 'g1,g2' });
    assert.match(els.groupsPop.innerHTML, /&lt;i&gt;Ops&lt;\/i&gt;<\/div><div class="pill-detail-text">Could not load this group\./);
  });

  it('closes on a second click, and opening it closes another banner popover', async () => {
    const { els, ctx } = load({ '/api/groups/g1': { name: 'Backend' }, '/api/groups/g2': { name: 'Ops' } });
    els.otherPop.classList.add('open');
    const pill = { getAttribute: () => 'g1,g2' };
    await ctx.toggleGroupsPopover(pill);
    assert.equal(els.otherPop.classList.contains('open'), false);
    await ctx.toggleGroupsPopover(pill);
    assert.equal(els.groupsPop.classList.contains('open'), false);
  });

  it('both group pills open from the keyboard: focusable buttons answering Enter and Space', () => {
    const { els, ctx } = load();
    ctx.renderBannerGroups(groups);
    assert.match(els.bannerGroups.innerHTML, /role="button" tabindex="0" onclick="toggleGroupsPopover\(this\)" onkeydown="onGroupPillKey\(event\)"/);
    ctx.renderBannerGroups([groups[0]]);
    assert.match(els.bannerGroups.innerHTML, /role="button" tabindex="0" onclick="toggleGroupPopover\(this, 'g1'\)" onkeydown="onGroupPillKey\(event\)"/);

    const press = (key, fromInside = false) => {
      let opened = 0;
      let prevented = false;
      const pill = { click: () => { opened += 1; } };
      ctx.onGroupPillKey({ key, target: fromInside ? {} : pill, currentTarget: pill, preventDefault: () => { prevented = true; } });
      return { opened, prevented };
    };
    assert.deepEqual(press('Enter'), { opened: 1, prevented: true });
    assert.deepEqual(press(' '), { opened: 1, prevented: true });
    assert.deepEqual(press('Tab'), { opened: 0, prevented: false }, 'other keys pass through');
    assert.deepEqual(press('Enter', true), { opened: 0, prevented: false }, 'a key from inside the popover is not the pill\'s');
  });

  it('a single group that fails to load says so instead of a click with no answer', async () => {
    const { els, ctx } = load({});
    ctx.renderBannerGroups([groups[0]]);
    await ctx.toggleGroupPopover({}, 'g1');
    assert.equal(els['groupPop-g1'].classList.contains('open'), true);
    assert.match(els['groupPop-g1'].innerHTML, /Backend<\/div><div class="pill-detail-text">Could not load this group\./);
  });

  it('the single-group popover and the counted one render a group the same way', () => {
    assert.match(extract(SESSION_SRC, 'toggleGroupPopover'), /groupPopoverHtml\(data\)/);
    assert.match(extract(SESSION_SRC, 'toggleGroupsPopover'), /groupPopoverHtml\(data\)/);
  });
});

describe('the settings gear asks for its emoji form (#1476)', () => {
  it('on the session banner and the dashboard header', () => {
    assert.match(SESSION_HTML, /id="settingsBtn"[^>]*>&#9881;&#65039;<\/button>/);
    assert.match(INDEX_HTML, /id="gearBtn"[^>]*>&#9881;&#65039;<\/button>/);
  });
});
