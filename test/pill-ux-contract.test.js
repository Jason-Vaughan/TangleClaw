'use strict';

/*
 * #104 — the banner pill UX contract: hover answers "what kind of thing is
 * this" (a category label via the `[data-tooltip]` CSS primitive), click
 * answers "what does it say right now" (a detail popover, where a pill has
 * one). The engine pill's status text used to live in its hover `title`; it
 * now lives in the click detail, and the pill's colour-state channel is
 * unchanged by the move.
 *
 * The click path runs the page's REAL functions in the mini-DOM rather than
 * pinning their source, so a `title` that crept back or a popover that never
 * rendered would show up as behaviour, not as a regex miss.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');
const SESSION_CSS = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text.
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find.
 * @returns {string} The declaration plus its balanced body.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * The opening tag of the element with this id, from the real session markup.
 * @param {string} id - Element id.
 * @returns {string} The `<span ...>` tag text.
 */
function tagOf(id) {
  const m = SESSION_HTML.match(new RegExp(`<span[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(m, `#${id} must exist in session.html`);
  return m[0];
}

/**
 * Every element in the tree carrying ALL of the given classes.
 * The mini-DOM's `querySelector` takes a single class; the page's
 * close-others step asks for `.group-popover.open`, so this walks for it.
 * @param {object} root - Element to walk from.
 * @param {string[]} classes - Classes every match must carry.
 * @returns {object[]} Matching elements.
 */
function collect(root, classes) {
  const out = [];
  for (const child of root.childNodes) {
    if (classes.every((c) => child.classList.contains(c))) out.push(child);
    out.push(...collect(child, classes));
  }
  return out;
}

/**
 * Build a sandbox running the page's real pill code over the mini-DOM.
 * @param {object} [modelStatus] - What `/api/models/status` answers.
 * @returns {object} vm context with `ids` attached.
 */
function loadPills(modelStatus) {
  const { doc, ids } = makeDocument(
    ['toast', 'statusDot', 'statusPill', 'bannerEngine', 'commandSend']);
  // The real markup ships the status pill with its label, initial detail and
  // accessible name; the engine pill with its label only.
  ids.statusPill.setAttribute('data-tooltip', 'Session status');
  ids.statusPill.setAttribute('data-pill-detail', 'Connected');
  ids.statusPill.setAttribute('aria-label', 'Session status: Connected');
  ids.bannerEngine.setAttribute('data-tooltip', 'AI engine');
  ids.bannerEngine.textContent = 'Claude Code';
  doc.querySelectorAll = (sel) => {
    assert.equal(sel, '.group-popover.open', `unexpected selector ${sel}`);
    return collect(doc.body, ['group-popover', 'open']);
  };
  doc.addEventListener = () => {};

  const sandbox = {
    console,
    document: doc,
    sessionState: { connected: true, project: { engine: { id: 'claude' } } },
    api: async () => ({ status: modelStatus || {} }),
    setTimeout: () => 0,
    reconnectPolicy: { begin() {}, end() {} }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    liftFunction(SESSION_SRC, 'function esc(str)'),
    liftFunction(SESSION_SRC, 'function closeBannerPopovers(keep)'),
    liftFunction(SESSION_SRC, 'function setPillDetail(pill, detail)'),
    liftFunction(SESSION_SRC, 'function renderPillDetail(pill, pop)'),
    liftFunction(SESSION_SRC, 'function togglePillDetail(pill)'),
    liftFunction(SESSION_SRC, 'function bindPillDetails()'),
    liftFunction(SESSION_SRC, 'async function loadModelStatus(engineId)'),
    liftFunction(SESSION_SRC, 'function setConnected(connected)'),
    'globalThis.loadModelStatus = loadModelStatus;',
    'globalThis.setConnected = setConnected;',
    'globalThis.togglePillDetail = togglePillDetail;',
    'bindPillDetails();'
  ].join('\n'), sandbox);
  sandbox.ids = ids;
  return sandbox;
}

/** @returns {object|null} A pill's detail popover, if it has been created. */
const popoverOf = (pill) => pill.querySelector('.pill-detail');

describe('#104 every banner pill says what kind of thing it is on hover', () => {
  it('version, status and engine pills carry their category label', () => {
    assert.match(tagOf('bannerVersion'), /data-tooltip="Project version"/);
    assert.match(tagOf('statusPill'), /data-tooltip="Session status"/);
    assert.match(tagOf('bannerEngine'), /data-tooltip="AI engine"/);
  });

  it('the status dot lives inside the labelled pill, keeping its own id', () => {
    // The dot's breathing is an opacity animation; a tooltip or popover
    // rendered inside the dot would breathe with it. The wrapper carries both.
    const wrapper = SESSION_HTML.indexOf('id="statusPill"');
    const dot = SESSION_HTML.indexOf('id="statusDot"');
    const close = SESSION_HTML.indexOf('</span>', wrapper);
    assert.ok(wrapper !== -1 && dot > wrapper && dot < SESSION_HTML.indexOf('</span>', close + 1),
      'the dot must be nested inside the status pill');
    assert.match(tagOf('statusDot'), /class="status-dot"/,
      'the dot keeps its class so every existing state rule still applies');
  });

  it('the status dot has a name for readers even though it is only a colour', () => {
    assert.match(tagOf('statusPill'), /aria-label="Session status: Connected"/);
    assert.match(tagOf('statusPill'), /role="button"/);
  });

  it('group pills carry their label', () => {
    const src = liftFunction(SESSION_SRC, 'function renderBannerGroups(groups)');
    assert.match(src, /class="group-pill"[^`]*data-tooltip="Project group"/);
  });

  it('hover is reserved for the label: no pill ships a title', () => {
    for (const id of ['bannerVersion', 'statusPill', 'statusDot', 'bannerEngine']) {
      assert.doesNotMatch(tagOf(id), /\btitle=/, `#${id} must not carry a title`);
    }
    assert.doesNotMatch(SESSION_SRC, /engineEl\.title\s*=/,
      'the engine status text must not be written to the hover');
    assert.doesNotMatch(SESSION_SRC, /\bdot\.title\s*=/,
      'the connection state must not be written to the hover');
  });
});

describe('#104 the [data-tooltip] CSS primitive', () => {
  it('positions its host and renders the attribute as the tooltip', () => {
    assert.match(SESSION_CSS, /\[data-tooltip\]\s*\{\s*position:\s*relative;\s*\}/);
    const before = SESSION_CSS.match(/\[data-tooltip\]:hover::before\s*\{([^}]*)\}/);
    assert.ok(before, 'the ::before tooltip rule must exist');
    assert.match(before[1], /content:\s*attr\(data-tooltip\)/);
    assert.match(before[1], /position:\s*absolute/);
    assert.match(before[1], /pointer-events:\s*none/);
    assert.match(SESSION_CSS, /\[data-tooltip\]:hover::after\s*\{/, 'the arrow rule must exist');
  });

  it('hangs below the pill — the banner is at the top of the viewport', () => {
    const before = SESSION_CSS.match(/\[data-tooltip\]:hover::before\s*\{([^}]*)\}/)[1];
    assert.match(before, /top:\s*calc\(100%/);
    assert.doesNotMatch(before, /bottom:\s*calc\(100%/,
      'an above-the-pill tooltip is clipped by the window edge on every page');
  });

  it('is gated on a device that can hover, so a touch tap does not pin it', () => {
    const gate = SESSION_CSS.indexOf('@media (hover: hover)');
    const rule = SESSION_CSS.indexOf('[data-tooltip]:hover::before');
    assert.ok(gate !== -1 && rule > gate, 'the hover rules must sit inside the (hover: hover) gate');
  });

  it('gives the pills with a click a pointer, and leaves the version pill alone', () => {
    assert.match(SESSION_CSS, /\.status-pill\s*\{[^}]*cursor:\s*pointer/);
    assert.match(SESSION_CSS, /\.banner-engine\s*\{[^}]*cursor:\s*pointer/);
    const version = SESSION_CSS.match(/\.banner-version\s*\{([^}]*)\}/)[1];
    assert.doesNotMatch(version, /cursor/, 'a no-op pill must not promise a click');
  });
});

describe('#104 the engine pill says its status on click, not on hover', () => {
  it('a degraded engine: colour state applied, hover clean, click shows the message', async () => {
    const ctx = loadPills({ claude: { status: 'degraded', message: 'elevated_error_rates' } });
    await ctx.loadModelStatus('claude');
    const pill = ctx.ids.bannerEngine;

    // The colour channel is untouched by the contract.
    assert.ok(pill.classList.contains('engine-pill-degraded'), 'pill-level colour state');
    const dot = pill.querySelector('.engine-status-dot');
    assert.ok(dot && dot.classList.contains('engine-status-degraded'), 'status dot colour');

    // Hover carries the category, not the status.
    assert.equal(pill.title, '');
    assert.equal(pill.getAttribute('title'), null);
    assert.equal(pill.getAttribute('data-tooltip'), 'AI engine');
    assert.equal(popoverOf(pill), null, 'nothing opens until the pill is clicked');

    assert.ok(pill.dispatch('click'), 'the engine pill must be clickable');
    const pop = popoverOf(pill);
    assert.ok(pop && pop.classList.contains('open'), 'the click opens the detail');
    assert.match(pop.innerHTML, /elevated error rates/, 'the status message, underscores spaced');
    assert.match(pop.innerHTML, /AI engine/,
      'the popover carries the label too — a touch user never sees the hover');
  });

  it('a status the check could not read says so', async () => {
    const ctx = loadPills({ claude: { status: 'unknown', error: 'fetch failed' } });
    await ctx.loadModelStatus('claude');
    ctx.ids.bannerEngine.dispatch('click');
    assert.match(popoverOf(ctx.ids.bannerEngine).innerHTML, /Status unknown: fetch failed/);
  });

  it('clicking again closes it, and a status change re-renders an open detail', async () => {
    const ctx = loadPills({ claude: { status: 'operational', message: 'all_systems_operational' } });
    await ctx.loadModelStatus('claude');
    const pill = ctx.ids.bannerEngine;
    pill.dispatch('click');
    assert.match(popoverOf(pill).innerHTML, /all systems operational/);

    ctx.api = async () => ({ status: { claude: { status: 'major_outage', message: 'api_down' } } });
    await ctx.loadModelStatus('claude');
    assert.ok(popoverOf(pill).classList.contains('open'), 'a poll must not close what the operator opened');
    assert.match(popoverOf(pill).innerHTML, /api down/, 'an open detail follows the status');
    assert.ok(pill.classList.contains('engine-pill-major_outage'));
    assert.ok(!pill.classList.contains('engine-pill-degraded') && !pill.classList.contains('engine-pill-operational'));

    pill.dispatch('click');
    assert.ok(!popoverOf(pill).classList.contains('open'), 'second click closes');
  });

  it('one detail open at a time', async () => {
    const ctx = loadPills({ claude: { status: 'operational', message: 'fine' } });
    await ctx.loadModelStatus('claude');
    ctx.ids.bannerEngine.dispatch('click');
    ctx.ids.statusPill.dispatch('click');
    assert.ok(!popoverOf(ctx.ids.bannerEngine).classList.contains('open'), 'engine detail closed');
    assert.ok(popoverOf(ctx.ids.statusPill).classList.contains('open'), 'status detail open');
  });
});

describe('#104 the status dot says its state on click and to readers', () => {
  it('a lost connection updates the detail and the accessible name, and the click shows it', () => {
    const ctx = loadPills();
    ctx.setConnected(false);
    const pill = ctx.ids.statusPill;
    assert.ok(ctx.ids.statusDot.classList.contains('disconnected'), 'the colour channel still moves');
    assert.equal(pill.getAttribute('data-pill-detail'), 'Disconnected');
    assert.equal(pill.getAttribute('aria-label'), 'Session status: Disconnected');
    assert.equal(ctx.ids.statusDot.title, '', 'the dot no longer carries the state as a hover');

    assert.ok(pill.dispatch('click'), 'the status pill must be clickable');
    assert.match(popoverOf(pill).innerHTML, /Session status/);
    assert.match(popoverOf(pill).innerHTML, /Disconnected/);

    ctx.setConnected(true);
    assert.match(popoverOf(pill).innerHTML, /Connected/, 'an open detail follows the state');
    assert.equal(pill.getAttribute('aria-label'), 'Session status: Connected');
  });
});
