'use strict';

/*
 * #768 chunk 2 — the Master control bar.
 *
 * From inside a session there was no route to the Master's settings at all, and
 * the dashboard's status row carried a gear the drawer's did not. The bar is
 * the session banner's control set, rendered by ONE component into both
 * surfaces.
 *
 * The property worth guarding is not "a bar exists" — it is that there is only
 * ONE of it. A hand-written second row is identical on the day it is written
 * and drifted by the third restyle, and every screenshot-style assertion passes
 * throughout. So these tests pin single-sourcing, not appearance.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { spawnSync } = require('node:child_process');
const loadApiHelperGlobals = require('./_api-helper-globals');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');
// Slices here are brace-matched, never a fixed-size window or a cut to the next
// `\n}\n`: both cheaper forms landed in the wrong region in this file (the cut
// matched a shorter function's close, the window started at a comment) and
// neither failed loudly.
const { liftDeclaration } = require('./helpers/lift');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const INDEX = read('index.html');
const SESSION_HTML = read('session.html');
const UI = read('ui.js');
const SESSION_JS = read('session.js');
const SW = read('sw.js');

const G = loadApiHelperGlobals();
// The server's own emitted degradation codes, read as TEXT. Requiring
// `lib/master.js` here would pull the store and its SQLite handle into a
// frontend test file; the codes are string literals, so reading them is honest
// and the assertion is about the two staying in step.
const master = {
  readMasterGuardPostureSource: fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'master.js'), 'utf8')
};

describe('#768 one implementation, two surfaces', () => {
  it('neither page declares the controls itself', () => {
    // The regression this exists to prevent: someone adds "just a status dot"
    // straight into a page and the two bars begin to diverge. Both pages carry
    // a mount root and nothing else.
    assert.match(INDEX, /id="masterPanelBar"/);
    assert.match(SESSION_HTML, /id="masterDrawerBar"/);
    for (const [name, html] of [['index.html', INDEX], ['session.html', SESSION_HTML]]) {
      assert.doesNotMatch(html, /id="master(Panel|Drawer)(Dot|StatusText|RetryBtn|SettingsBtn)"/,
        `${name} must not re-declare a control the shared bar owns`);
    }
  });

  it('both pages construct the same factory', () => {
    assert.match(UI, /window\.tcCreateMasterControlBar\(/,
      'the dashboard must mount the shared bar');
    assert.match(SESSION_JS, /window\.tcCreateMasterControlBar\(/,
      'the session page must mount the same one');
  });

  it('a change to the component reaches both surfaces', () => {
    // The Done-when criterion, expressed as behaviour rather than as a promise:
    // render both surfaces from the same function and assert they differ ONLY by
    // the id prefix and the label. If a page ever grows its own copy, the two
    // stop being substitutable and this fails.
    const panel = G.tcMasterControlBarMarkup('masterPanel', { title: 'X' });
    const drawer = G.tcMasterControlBarMarkup('masterDrawer', { title: 'X' });
    assert.equal(panel.replace(/masterPanel/g, 'P'), drawer.replace(/masterDrawer/g, 'P'),
      'the two surfaces must be the same markup modulo their id prefix');
  });

  it('every control id is prefixed, so the two surfaces cannot collide', () => {
    // Both bars can exist in one document — the session page has the drawer, and
    // nothing stops a future surface. An unprefixed id would mean
    // getElementById returning the one the operator cannot see, which presents
    // as "the control does nothing".
    const drawer = G.tcMasterControlBarMarkup('masterDrawer', {});
    const ids = [...drawer.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length >= 8, `expected a real control set, got ${ids.length}`);
    const unprefixed = ids.filter((id) => !id.startsWith('masterDrawer'));
    assert.deepEqual(unprefixed, [], 'every id the bar emits must carry its surface prefix');
  });

  it('does not collide with the host session banner\'s own controls', () => {
    // The drawer renders on the SAME page as the session banner, which already
    // owns uploadBtn / wrapBtn / killBtn / settingsBtn. A bare `uploadBtn` here
    // would silently retarget the session's own Upload.
    const drawer = G.tcMasterControlBarMarkup('masterDrawer', {});
    for (const id of ['uploadBtn', 'wrapBtn', 'killBtn', 'settingsBtn', 'medusaControl']) {
      assert.doesNotMatch(drawer, new RegExp(`id="${id}"`),
        `${id} belongs to the host session banner — the bar must not claim it`);
    }
  });
});

describe('#768 controls with no backend are absent WITH a reason', () => {
  it('names a reason for each control that has no route — EMPTY now (#3137)', () => {
    // `access` left this list in #755 chunk 3, `kill` in #968, `medusa` in #996 —
    // each removal was the assertion that a shipped backend took its control's
    // pending treatment WITH it, rather than leaving a reason beside a working
    // button. `upload` and `wrap` are the same move: `POST /api/master/attachments`
    // and `POST /api/master/wrap` now exist (#3137), so the table is empty.
    assert.deepEqual(Object.keys(G.tcMasterPendingReasons).sort(), []);
  });

  it('Upload and Wrap are no longer pending-disabled', () => {
    // The flip side of #755/#741's rule: once a control has a backend, it must
    // NOT still carry the pending treatment — that would be a reason rendered
    // beside a working control, which is its own falsehood (the same check
    // `access`/`kill`/`medusa` passed when THEIR backends landed).
    const bar = G.tcMasterControlBarMarkup('masterPanel', {});
    for (const key of ['Upload', 'Wrap']) {
      const m = new RegExp(`<button[^>]*id="masterPanel${key}Btn"[^>]*>`).exec(bar);
      assert.ok(m, `${key} must render`);
      assert.doesNotMatch(m[0], /\sdisabled(?=[\s>])/, `${key} must be pressable`);
      assert.doesNotMatch(m[0], /aria-disabled="true"/, `${key} must not claim to assistive tech that it is inert`);
      assert.doesNotMatch(m[0], /master-bar-pending/, `${key} must not carry the pending treatment`);
    }
    assert.doesNotMatch(bar, /masterPanelUploadWhy|masterPanelWrapWhy/,
      'no pending-reason description elements should remain for either control');
  });
});

describe('#768 the bar behaves', () => {
  /** @returns {{doc: object, ids: object, bar: object, opened: number[]}} */
  function mounted(prefix) {
    const { doc, ids } = makeDocument([prefix + 'Bar']);
    // The mini-DOM does not parse markup by default, deliberately. This is the
    // narrowest stand-in that lets a component which BUILDS its own DOM be
    // mounted and driven, rather than asserting on its source.
    withIdParsingInnerHTML(ids[prefix + 'Bar'], doc);
    const opened = [];
    const bar = G.tcCreateMasterControlBar({
      doc, rootId: prefix + 'Bar', prefix, title: 'M',
      onOpenSettings: () => opened.push(1)
    });
    return { doc, ids, bar, opened };
  }

  it('mount is idempotent — a second mount does not double-bind', () => {
    // Asserted by MOUNTING TWICE, never by matching the source: a regex for the
    // guard passes whether or not the second mount is inert.
    const { doc, bar, opened } = mounted('masterPanel');
    bar.mount();
    bar.mount();
    doc.getElementById('masterPanelSettingsBtn').dispatch('click');
    assert.equal(opened.length, 1, 'the gear must fire once, not once per mount');
  });

  it('Retry actually fires its handler', () => {
    // Behavioural, because the source-regex version of this passes whether or
    // not `mount()` still binds the button — which is exactly the shape this
    // repo's `feedback_measure_against_the_real_shape` learning warns about.
    const { doc, ids } = makeDocument(['masterPanelBar']);
    withIdParsingInnerHTML(ids.masterPanelBar, doc);
    const fired = [];
    const bar = G.tcCreateMasterControlBar({
      doc, rootId: 'masterPanelBar', prefix: 'masterPanel', onRetry: () => fired.push(1)
    });
    bar.mount();
    doc.getElementById('masterPanelRetryBtn').dispatch('click');
    assert.equal(fired.length, 1, 'Retry must reach the handler the page supplied');
  });

  it('Wrap actually fires deps.onWrap (#3137)', () => {
    // Behavioural, same reasoning as the Retry test above: a source-regex
    // version passes whether or not `mount()` still binds the button.
    const { doc, ids } = makeDocument(['masterPanelBar']);
    withIdParsingInnerHTML(ids.masterPanelBar, doc);
    const fired = [];
    const bar = G.tcCreateMasterControlBar({
      doc, rootId: 'masterPanelBar', prefix: 'masterPanel', onWrap: () => fired.push(1)
    });
    bar.mount();
    doc.getElementById('masterPanelWrapBtn').dispatch('click');
    assert.equal(fired.length, 1, 'Wrap must reach the handler the page supplied');
  });

  it('does not throw mounting with no onWrap/onUpload supplied', () => {
    // Both are optional deps (the pages that mount this bar always pass them,
    // but the component itself must not assume they exist) — same contract
    // `onRetry`/`onOpenSettings` already have above.
    const { doc, ids } = makeDocument(['masterPanelBar']);
    withIdParsingInnerHTML(ids.masterPanelBar, doc);
    const bar = G.tcCreateMasterControlBar({ doc, rootId: 'masterPanelBar', prefix: 'masterPanel' });
    assert.doesNotThrow(() => bar.mount());
    assert.doesNotThrow(() => doc.getElementById('masterPanelWrapBtn').dispatch('click'));
  });

  it('Upload opens the file picker, then fires deps.onUpload with the chosen file (#3137)', () => {
    const { doc, ids } = makeDocument(['masterPanelBar']);
    withIdParsingInnerHTML(ids.masterPanelBar, doc);
    const uploaded = [];
    const bar = G.tcCreateMasterControlBar({
      doc, rootId: 'masterPanelBar', prefix: 'masterPanel', onUpload: (file) => uploaded.push(file)
    });
    bar.mount();
    const input = doc.getElementById('masterPanelUploadInput');
    assert.ok(input, 'the file input must exist');
    const clicked = [];
    input.click = () => clicked.push(1);
    doc.getElementById('masterPanelUploadBtn').dispatch('click');
    assert.equal(clicked.length, 1, 'Upload must open the picker');
    // Simulate a choice, then the input's own change event.
    const fakeFile = { name: 'screenshot.png' };
    input.files = [fakeFile];
    input.dispatch('change');
    assert.deepEqual(uploaded, [fakeFile], 'the chosen file must reach the handler the page supplied');
  });

  it('Upload no longer restricts the file picker to accept="image/*" (#3218)', () => {
    const { doc, ids } = makeDocument(['masterPanelBar']);
    withIdParsingInnerHTML(ids.masterPanelBar, doc);
    const bar = G.tcCreateMasterControlBar({ doc, rootId: 'masterPanelBar', prefix: 'masterPanel' });
    bar.mount();
    const html = ids.masterPanelBar.innerHTML;
    assert.doesNotMatch(html, /accept="image\/\*"/);
    assert.match(html, /aria-label="Attach a file, photo, or screenshot"/);
    assert.match(html, /title="Attach a file, photo, or screenshot for Admin-PM"/);
  });

  it('Upload hands the picked file off with its sanitized name too (#3218)', () => {
    const { doc, ids } = makeDocument(['masterPanelBar']);
    withIdParsingInnerHTML(ids.masterPanelBar, doc);
    const uploaded = [];
    const bar = G.tcCreateMasterControlBar({
      doc, rootId: 'masterPanelBar', prefix: 'masterPanel', onUpload: (file, sanitized) => uploaded.push([file, sanitized])
    });
    bar.mount();
    const input = doc.getElementById('masterPanelUploadInput');
    input.files = [{ name: 'Screenshot 2026-11-22 at 9.15.00 PM.png' }];
    input.dispatch('change');
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0][1], 'Screenshot-2026-11-22-at-9.15.00-PM.png');
  });

  it('paints the model pill from a real fetch', async () => {
    // BEHAVIOURAL, because the source-pin version of this was itself a review
    // finding: `assert.match(UI, /masterBar\.loadModel\(/)` stays green for
    // `loadModel(status.engine)`, `loadModel(undefined)`, or any other wrong
    // field — which is exactly how the dashboard shipped passing `undefined`
    // while the guard reported the defect fixed.
    const { doc, ids } = makeDocument(['masterPanelBar']);
    withIdParsingInnerHTML(ids.masterPanelBar, doc);
    const asked = [];
    const bar = G.tcCreateMasterControlBar({
      doc, rootId: 'masterPanelBar', prefix: 'masterPanel',
      api: async (url) => { asked.push(url); return { status: { claude: { status: 'degraded' } } }; }
    });
    bar.mount();
    const pill = doc.getElementById('masterPanelModel');
    assert.equal(pill.hidden, true, 'hidden until a model is known');

    await bar.loadModel('claude');
    assert.deepEqual(asked, ['/api/models/status'], 'it must actually ask');
    assert.equal(pill.hidden, false, 'and the pill must appear');
    assert.match(pill.textContent, /claude/, 'carrying the engine it painted');
    assert.match(pill.className, /engine-pill-degraded/, 'and its health');
  });

  it('each page passes a field that exists on the payload it reads', async () => {
    // The other half of the same defect: the component was correct and the
    // CALLER passed a field the API does not return. Pinning the field names
    // against the shapes their own producers emit is what a regex could not do.
    assert.match(UI, /status\.settings && status\.settings\.resolvedEngine/,
      'the dashboard reads getMasterStatus, whose engine is settings.resolvedEngine');
    assert.match(SESSION_JS, /masterBar\.loadModel\(result\.engine/,
      'the session page reads the ensure response, whose engine IS top-level');
    const master = fs.readFileSync(path.join(__dirname, '..', 'lib', 'master.js'), 'utf8');
    assert.match(master, /resolvedEngine: engineId/,
      'getMasterStatus must still expose resolvedEngine, or the dashboard call is dead again');
    assert.match(master, /engine: engineId, accessLevel/,
      'the ensure response must still carry a top-level engine');
  });

  it('a failed open is visible, not console-only', () => {
    // What chunk 1's review required. Before this, a Master whose status fetch
    // failed looked exactly like a gear that does nothing.
    const { doc, bar } = mounted('masterPanel');
    bar.mount();
    const box = doc.getElementById('masterPanelError');
    assert.equal(box.hidden, true, 'nothing to report at rest');
    bar.setError('the Master did not answer');
    assert.equal(box.hidden, false);
    assert.match(box.textContent, /did not answer/);
    bar.setError('');
    assert.equal(box.hidden, true, 'and it clears, so a stale error cannot outlive its cause');
  });

  it('paints status without touching the other surface', () => {
    const a = mounted('masterPanel');
    const b = mounted('masterDrawer');
    a.bar.mount(); b.bar.mount();
    a.bar.setStatus('live', 'up', false);
    assert.equal(a.doc.getElementById('masterPanelStatusText').textContent, 'up');
    assert.equal(b.doc.getElementById('masterDrawerStatusText').textContent, 'M · checking…',
      'one surface must not paint the other');
  });

  it('hides the model pill when the model is unknown rather than showing an empty one', () => {
    const { doc, bar } = mounted('masterPanel');
    bar.mount();
    bar.setModel({ status: 'operational' }, null);
    assert.equal(doc.getElementById('masterPanelModel').hidden, true,
      'an empty pill would assert a model we cannot name');
    bar.setModel({ status: 'degraded', message: 'elevated_errors' }, 'opus-5');
    const pill = doc.getElementById('masterPanelModel');
    assert.equal(pill.hidden, false);
    assert.match(pill.className, /engine-pill-degraded/,
      'a non-operational model must tint the whole pill, not rest on a 6px dot');
    assert.match(pill.title, /elevated errors/, 'and say what is wrong in words');
  });
});

// ── #2035 — Full screen and Pop out on the Master control bar ──
//
// Both buttons live in the ONE shared markup/mount function (#768's own
// property), so adding them here is what gives BOTH the dashboard panel and
// the session drawer the controls with no change to either surface's own
// page — the thing this chunk is scoped to prove, not just implement.
describe('#2035 Full screen and Pop out', () => {
  /** @returns {{doc: object, ids: object, bar: object, surface: object}} */
  function mountedWithSurface(prefix, extraDeps) {
    const { doc, ids } = makeDocument([prefix + 'Bar', prefix]);
    withIdParsingInnerHTML(ids[prefix + 'Bar'], doc);
    const surface = ids[prefix];
    const bar = G.tcCreateMasterControlBar(Object.assign(
      { doc, rootId: prefix + 'Bar', prefix, title: 'M' }, extraDeps
    ));
    return { doc, ids, bar, surface };
  }

  it('hides Full screen when the surface or the browser has no requestFullscreen', () => {
    const { doc, bar } = mountedWithSurface('masterPanel');
    bar.mount();
    assert.equal(doc.getElementById('masterPanelFullscreenBtn').hidden, true,
      'the lift-and-run stub element has no requestFullscreen, same as an unsupporting browser');
  });

  it('wires Full screen to the surface\'s requestFullscreen when it exists, and toggles exit', () => {
    const { doc, bar, surface } = mountedWithSurface('masterPanel');
    const calls = [];
    surface.requestFullscreen = () => { calls.push('enter'); doc.fullscreenElement = surface; };
    doc.exitFullscreen = () => { calls.push('exit'); doc.fullscreenElement = null; };
    bar.mount();
    const btn = doc.getElementById('masterPanelFullscreenBtn');
    assert.equal(btn.hidden, false, 'Full screen must show once the surface supports it');

    btn.dispatch('click');
    assert.deepEqual(calls, ['enter']);
    assert.equal(doc.fullscreenElement, surface);

    btn.dispatch('click');
    assert.deepEqual(calls, ['enter', 'exit'], 'a second press exits rather than re-entering');
    assert.equal(doc.fullscreenElement, null);
  });

  it('toggleFullscreen is reachable directly, for a caller that is not a click', () => {
    const { doc, bar, surface } = mountedWithSurface('masterDrawer');
    let entered = false;
    surface.requestFullscreen = () => { entered = true; doc.fullscreenElement = surface; };
    bar.mount();
    bar.toggleFullscreen();
    assert.equal(entered, true);
  });

  it('Full screen expands deps.surfaceId when given one, not the bar\'s own prefix', () => {
    const { doc, ids } = makeDocument(['masterPanelBar', 'masterPanel', 'customSurface']);
    withIdParsingInnerHTML(ids.masterPanelBar, doc);
    let targeted = null;
    ids.customSurface.requestFullscreen = () => { targeted = 'customSurface'; };
    ids.masterPanel.requestFullscreen = () => { targeted = 'masterPanel'; };
    const bar = G.tcCreateMasterControlBar({
      doc, rootId: 'masterPanelBar', prefix: 'masterPanel', surfaceId: 'customSurface'
    });
    bar.mount();
    bar.toggleFullscreen();
    assert.equal(targeted, 'customSurface');
  });

  it('hides Pop out on a page that IS a popout, so a popout cannot open another one', () => {
    const { doc, bar } = mountedWithSurface('masterPanel', { isPopout: true });
    bar.mount();
    assert.equal(doc.getElementById('masterPanelPopoutBtn').hidden, true);
  });

  it('Pop out opens the root dashboard with ?master=popout, in a named window', () => {
    const { doc, bar } = mountedWithSurface('masterPanel');
    const opened = [];
    doc.defaultView = {
      location: { href: 'https://tc.example/' },
      URL,
      open: (url, name, features) => opened.push({ url, name, features })
    };
    bar.mount();
    doc.getElementById('masterPanelPopoutBtn').dispatch('click');
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, 'https://tc.example/?master=popout');
    assert.equal(opened[0].name, 'tc-master-popout');
  });

  it('Pop out from the session drawer still targets the root dashboard, not the session page (PRR-A C1)', () => {
    // The drawer mounts this same bar on `/session/...` or `/session.html?project=...`
    // — a page with no `?master=popout` handling of its own (that lives only in
    // public/ui.js). Carrying the current path forward would open that page
    // normally, with an unused query param, never reaching Master-only mode.
    const { doc, bar } = mountedWithSurface('masterDrawer');
    const opened = [];
    doc.defaultView = {
      location: { href: 'https://example.test/session.html?project=Foo' },
      URL,
      open: (url, name, features) => opened.push({ url, name, features })
    };
    bar.mount();
    doc.getElementById('masterDrawerPopoutBtn').dispatch('click');
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, 'https://example.test/?master=popout',
      'must be the root dashboard, not /session.html');
    assert.equal(opened[0].name, 'tc-master-popout');
  });

  it('Pop out defers to deps.openPopout when the page supplies one', () => {
    const fired = [];
    const { doc, bar } = mountedWithSurface('masterPanel', { openPopout: () => fired.push(1) });
    bar.mount();
    doc.getElementById('masterPanelPopoutBtn').dispatch('click');
    assert.deepEqual(fired, [1]);
  });
});

// #192, web-terminal layer: `test/tmux.test.js`'s raw-mode PTY regression
// covers the SERVER side (tmux sendKeys to the pane); this covers the CLIENT
// side (pasteToMaster handing the browser clipboard's text to xterm.js) —
// the other half of the same pipe, with its own chance to mangle a multi-line
// payload (e.g. splitting on \n, or re-joining with the wrong line ending).
describe('#192 pasteToMaster passes a multi-line payload to xterm intact', () => {
  /**
   * Mount a bar with a given frame registered at `frameId`, directly on the
   * `ids` map `makeDocument` hands back — the same seam `test/paste-affordance.test.js`
   * uses for this same component, kept local here since that file is outside
   * this chunk's authorized scope.
   * @returns {{doc: object, bar: object}}
   */
  function mountedWithFrame(prefix, frameId, frame, extraDeps) {
    const { doc, ids } = makeDocument([prefix + 'Bar']);
    withIdParsingInnerHTML(ids[prefix + 'Bar'], doc);
    ids[frameId] = frame;
    const bar = G.tcCreateMasterControlBar(Object.assign(
      { doc, rootId: prefix + 'Bar', prefix, title: 'M' }, extraDeps
    ));
    bar.mount();
    return { doc, bar };
  }

  it('a multi-line clipboard payload reaches term.paste() with every line and ending intact', async () => {
    const pasted = [];
    const term = { paste: (t) => pasted.push(t), focus: () => {} };
    const { doc, bar } = mountedWithFrame('masterPanel', 'masterFrame', { contentWindow: { term } });
    const multiLine = 'line one\nline two\nline three\n';
    doc.defaultView = { navigator: { clipboard: { readText: async () => multiLine } } };
    await bar.paste();
    assert.deepEqual(pasted, [multiLine], 'the payload must reach term.paste() byte for byte — no split, re-join, or line-ending change');
  });

  it('the same holds through the fallback prompt, for a client with no clipboard read', async () => {
    const pasted = [];
    const term = { paste: (t) => pasted.push(t), focus: () => {} };
    const multiLine = 'alpha\nbeta\ngamma';
    const { doc, bar } = mountedWithFrame('masterDrawer', 'masterDrawerFrame', { contentWindow: { term } },
      { prompt: () => multiLine });
    doc.defaultView = { navigator: {} };
    await bar.paste();
    assert.deepEqual(pasted, [multiLine]);
  });
});

describe('#2035 the dashboard\'s popout bootstrap (public/ui.js)', () => {
  /** @returns {Function} `isMasterPopoutLoad`, lifted and run for real. */
  function loadIsMasterPopoutLoad() {
    return new Function(`${liftDeclaration(UI, 'function isMasterPopoutLoad(')}\nreturn isMasterPopoutLoad;`)();
  }

  /** @returns {Function} `enterMasterPopoutMode`, lifted and run for real. */
  function loadEnterMasterPopoutMode() {
    return new Function(`${liftDeclaration(UI, 'function enterMasterPopoutMode(')}\nreturn enterMasterPopoutMode;`)();
  }

  it('reads exactly ?master=popout, not any other value or an absent one', () => {
    const isPopout = loadIsMasterPopoutLoad();
    assert.equal(isPopout({ search: '?master=popout' }), true);
    assert.equal(isPopout({ search: '' }), false);
    assert.equal(isPopout({ search: '?master=1' }), false, 'only the exact value "popout" counts');
    assert.equal(isPopout({ search: '?other=popout' }), false, 'the key must be master');
  });

  it('adds the popout-mode class and opens Master, in that order', () => {
    const enter = loadEnterMasterPopoutMode();
    const added = [];
    const doc = { body: { classList: { add: (c) => added.push(c) } } };
    const order = [];
    enter(doc, () => order.push('opened'));
    assert.deepEqual(added, ['master-popout-mode']);
    assert.deepEqual(order, ['opened'], 'openMaster must actually run');
  });
});

// ── #755 chunk 3 — the access toggle goes live ──
//
// The property under guard is NOT "pressing READ sends a PATCH". It is that the
// control can never show, or act on, a level the server did not just state.
// There is exactly one Master — a single reserved tmux session every drawer
// attaches the same iframe to — so an optimistic paint shows one operator a
// level another surface already changed, and a flip computed from a stale bar
// silently reverts someone else's change.
describe('#755 the access toggle is live, and paints only from server state', () => {
  /** Let every already-resolved promise in a flip chain settle. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  /**
   * Settings payload shaped like `/api/master/status`'s.
   * @param {object} [over] - Fields to override.
   * @returns {object} A settings object.
   */
  const settings = (over) => Object.assign({
    accessLevel: 'read-only',
    enforcement: 'structural',
    levelAppliesAt: 'next-tool-call',
    guardLevel: 'read-only',
    guardDegraded: false,
    guardDegradedCode: null,
    guardDegradedReason: null,
    identityStale: false,
    identityWrittenAt: null
  }, over || {});

  /**
   * A mounted bar with recording fakes for every call it can make.
   *
   * @param {object} [opts]
   * @param {object[]} [opts.statuses] - Successive `/api/master/status` replies;
   *   the last is reused once exhausted. `null` models a failed read.
   * @param {*} [opts.patch] - What the PATCH resolves to; `null` models failure.
   * @param {boolean} [opts.confirm] - What the confirmation returns.
   * @returns {object} The bar, its document and the recorded calls.
   */
  function mountedBar(opts = {}) {
    const prefix = 'masterPanel';
    const { doc, ids } = makeDocument([prefix + 'Bar']);
    withIdParsingInnerHTML(ids[prefix + 'Bar'], doc);
    const calls = [];
    const statuses = opts.statuses || [{ settings: settings() }];
    let i = 0;
    const api = async (path) => {
      calls.push(['GET', path]);
      const next = statuses[Math.min(i, statuses.length - 1)];
      i++;
      return next;
    };
    api.lastError = 'the server said no';
    const apiMutate = async (path, method, body) => {
      calls.push([method, path, body]);
      return 'patch' in opts ? opts.patch : { ok: true };
    };
    const prompts = [];
    const bar = G.tcCreateMasterControlBar({
      doc,
      rootId: prefix + 'Bar',
      prefix,
      title: 'M',
      api,
      apiMutate,
      confirm: opts.noConfirm
        ? null
        : (text) => { prompts.push(text); return opts.confirm !== false; }
    });
    bar.mount();
    const el = (suffix) => doc.getElementById(prefix + suffix);
    return { bar, doc, el, calls, prompts };
  }

  it('the toggle ships as real buttons, with no pending treatment left on it', () => {
    // THE MUTATION THIS CATCHES: wiring the behaviour and leaving the dim
    // `master-bar-pending` markup in place — a control that works and looks
    // permanently disabled, which is the worst of both states.
    const markup = G.tcMasterControlBarMarkup('masterPanel', {});
    const group = /<span class="master-access-toggle"[^>]*>/.exec(markup);
    assert.ok(group, 'the toggle must render');
    assert.doesNotMatch(group[0], /master-bar-pending/, 'it is not pending any more');
    assert.doesNotMatch(group[0], /aria-disabled/, 'nor disabled to assistive tech');
    for (const spec of G.tcMasterAccessSegments) {
      const seg = new RegExp(`<button[^>]*id="masterPanel${spec.suffix}"[^>]*>`).exec(markup);
      assert.ok(seg, `${spec.level} must render as a real <button>`);
      // Buttons are focusable, keyboard-operable and announced as pressable for
      // free. A span with a click handler re-implements all three, and usually
      // re-implements two.
      assert.match(seg[0], /aria-pressed="/, `${spec.level} must expose its pressed state`);
      assert.doesNotMatch(seg[0], /\sdisabled(?=[\s>])/, `${spec.level} must be pressable`);
    }
  });

  it('paints the pressed segment from the level the server states', () => {
    // THE MUTATION THIS CATCHES: painting `is-on` from the clicked segment
    // instead of from `accessLevel` — indistinguishable in a happy-path click
    // test, and the entire defect this control is written to avoid.
    const { bar, el } = mountedBar();
    for (const [level, on, off] of [['read-only', 'AccessRead', 'AccessWrite'],
      ['write', 'AccessWrite', 'AccessRead']]) {
      bar.setAccess(settings({ accessLevel: level }));
      assert.equal(el(on).getAttribute('aria-pressed'), 'true', `${level}: pressed`);
      assert.equal(el(off).getAttribute('aria-pressed'), 'false', `${level}: the other is not`);
      assert.equal(el(on).classList.contains('is-on'), true);
      assert.equal(el('Access').getAttribute('aria-label'), `Master access level: ${level}`,
        'the accessible name carries the LEVEL, not just the control');
    }
    bar.setAccess(settings({ accessLevel: 'write' }));
    assert.equal(el('Access').classList.contains('is-write'), true,
      'write is marked on the group, so it does not rest on one segment tint');
  });

  it('at suggest, neither segment is pressed and a readout names the tier', () => {
    // The bar is a two-segment fast path and the gear is the complete control,
    // so `suggest` is a level the toggle cannot express. Showing it as READ
    // would be false (suggest permits asked writes) and as WRITE would be worse.
    //
    // THE MUTATION THIS CATCHES: falling back to pressing READ for any
    // non-write level — the obvious two-state simplification, which tells an
    // operator at `suggest` that their master is read-only.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({ accessLevel: 'suggest' }));
    assert.equal(el('AccessRead').getAttribute('aria-pressed'), 'false');
    assert.equal(el('AccessWrite').getAttribute('aria-pressed'), 'false');
    assert.equal(el('AccessOther').hidden, false, 'the readout must be visible');
    assert.equal(el('AccessOther').textContent, 'SUGGEST');
    assert.equal(el('Access').getAttribute('aria-label'), 'Master access level: suggest',
      'and a screen reader must not be left with two unpressed buttons and no tier');

    bar.setAccess(settings({ accessLevel: 'write' }));
    assert.equal(el('AccessOther').hidden, true, 'and it goes away again');
  });

  it('a status it could not read leaves the control inert rather than guessing', () => {
    // THE MUTATION THIS CATCHES: defaulting to 'read-only' when settings are
    // absent. That is the fail-closed instinct applied to the wrong layer — here
    // it invents a level the server never stated, and the operator cannot tell
    // an unknown from a posture.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({ accessLevel: 'write' }));
    bar.setAccess(null);
    for (const spec of G.tcMasterAccessSegments) {
      assert.equal(el(spec.suffix).getAttribute('aria-pressed'), 'false');
      assert.equal(el(spec.suffix).disabled, true, 'inert, because there is nothing to flip from');
    }
    assert.equal(el('Access').getAttribute('aria-label'), 'Master access level: unknown');
  });

  it('the bar shows the enforcement tier, so two engines stop looking identical', () => {
    // The badge vocabulary existed in the modal only, so a Gemini Master and a
    // Claude Master rendered the same on the bar — and read-only is ALREADY
    // unenforced on the instructional one.
    //
    // THE MUTATION THIS CATCHES: rendering the word and dropping the modifier
    // class, which leaves the distinction resting on a lowercase word in an 10px
    // pill — not a signal caught in passing.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({ enforcement: 'instructional' }));
    assert.equal(el('Enforce').hidden, false);
    assert.equal(el('Enforce').textContent, 'instructional');
    assert.equal(el('Enforce').classList.contains('is-instructional'), true);
    assert.match(el('Enforce').title, /rules-only/);

    bar.setAccess(settings({ enforcement: 'structural' }));
    assert.equal(el('Enforce').classList.contains('is-instructional'), false);
    assert.match(el('Enforce').title, /every tool call/);
  });

  it('a degraded guard is stated in words, on its own line', () => {
    // THE MUTATION THIS CATCHES: marking the toggle with a class and no
    // sentence. `nonfunctional-requirements.md` forbids communicating an error
    // by colour alone, and "the border went amber" does not tell an operator
    // that their master is refusing every write.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({
      accessLevel: 'write',
      guardDegraded: true,
      guardDegradedCode: 'guard-missing',
      guardDegradedReason: 'the write guard is not there — nothing is bounding this master'
    }));
    assert.equal(el('Warn').hidden, false);
    assert.match(el('Warn').textContent, /nothing is bounding/);
    assert.equal(el('Access').classList.contains('is-degraded'), true);

    bar.setAccess(settings());
    assert.equal(el('Warn').hidden, true, 'and it clears when the guard is healthy again');
    assert.equal(el('Access').classList.contains('is-degraded'), false);
  });

  it('every degradation code the server can send has a label on BOTH surfaces', () => {
    // `guardDegradedCode` exists so neither surface has to regex the reason
    // sentence to tell "the guard is gone" from "the level disagrees". A
    // discriminator nothing reads is just a longer payload, so this pins that it
    // IS read — and that the vocabulary is one table, not one per surface.
    //
    // Derived from the server's own emitted codes, so adding a sixth code to
    // `lib/master.js` without labelling it fails here rather than rendering a
    // blank tag in front of the operator.
    const emitted = [...master.readMasterGuardPostureSource.matchAll(/guardDegradedCode: '([a-z-]+)'/g)]
      .map((m) => m[1]);
    assert.ok(emitted.length >= 3, `expected the server to emit real codes, got ${emitted.length}`);
    for (const code of new Set(emitted)) {
      assert.ok(G.tcMasterGuardDegradedLabels[code],
        `${code} is emitted by the server and has no label`);
    }
  });

  it('an unreadable status says so, instead of a bare dimmed pair', () => {
    // Two unpressed segments and no sentence is the operator reading "broken" or
    // "read-only" at random — a control saying nothing, which is this chunk's own
    // subject matter turned on itself.
    //
    // THE MUTATION THIS CATCHES: clearing the warning line whenever settings are
    // absent, which is the tidy-looking `setWarning('')` and leaves the silent
    // control exactly as it was.
    const { bar, el } = mountedBar();
    bar.setAccess(null);
    assert.equal(el('Warn').hidden, false);
    assert.match(el('Warn').textContent, /could not be read/i);
  });

  it('an instructional master shows its level as PENDING, not in force', () => {
    // On that engine the level travels in the regenerated identity, so a flip
    // does not bind until the next ensure. Going back to read-only is where it
    // bites: READ paints as pressed while the identity still grants write.
    //
    // THE MUTATION THIS CATCHES: painting `is-pending` only after a flip rather
    // than from state — which leaves a freshly-loaded bar on a Gemini master
    // asserting a level that is not running.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({
      accessLevel: 'read-only', enforcement: 'instructional', levelAppliesAt: 'next-ensure'
    }));
    assert.equal(el('Access').classList.contains('is-pending'), true);
    assert.match(el('Access').getAttribute('aria-label'), /applies when the master next starts/);
    assert.equal(el('Warn').hidden, false, 'and it says so in words, not only in a border');

    bar.setAccess(settings());
    assert.equal(el('Access').classList.contains('is-pending'), false,
      'a structural master binds immediately and must not be marked pending');
    assert.equal(el('Warn').hidden, true);
  });

  it('a pending warning with no stated mechanism does not invent one', () => {
    // `pending` is true both when the server SAID `next-ensure` and when the
    // field is ABSENT (payload skew — a cached client against an older server).
    // Only the first licenses naming the mechanism. Printing the instructional
    // sentence on an absent field tells a Claude master it has no write guard,
    // which is the false claim removed from the modal hint and the confirmation
    // in the same commit — and this branch reintroduced it two functions away.
    //
    // THE MUTATION THIS CATCHES: collapsing the two back into one sentence.
    const { bar, el } = mountedBar();
    const skewed = settings();
    delete skewed.levelAppliesAt;
    bar.setAccess(skewed);
    assert.equal(el('Access').classList.contains('is-pending'), true,
      'absence is still cautious about WHEN');
    assert.doesNotMatch(el('Warn').textContent, /rather than a write guard/,
      'but must not assert a mechanism the payload did not state');
    assert.match(el('Warn').textContent, /next time the master session starts/);

    bar.setAccess(settings({ enforcement: 'instructional', levelAppliesAt: 'next-ensure' }));
    assert.match(el('Warn').textContent, /rather than a write guard/,
      'a STATED instructional binding does explain the mechanism');
  });

  it('a stale identity says the change is NOT IN EFFECT, and when it was written (#968)', () => {
    // The bug the operator hit: the toggle moved, the guard permitted the write,
    // and the Master went on refusing because it reads its instructions only at
    // launch. The bar has to say that, or the toggle looks like it did nothing.
    //
    // THE MUTATION THIS CATCHES: rendering only the guard posture and ignoring
    // identityStale — which is the shipped behaviour this fixes, and which every
    // other assertion in this file allows.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({
      accessLevel: 'write',
      identityStale: true,
      identityWrittenAt: '2026-07-17T12:00:00.000Z'
    }));
    assert.equal(el('Warn').hidden, false);
    assert.match(el('Warn').textContent, /NOT IN EFFECT/);
    assert.match(el('Warn').textContent, /Restart it to apply/);
    assert.match(el('Warn').textContent, /Jul/,
      'and it names WHEN, so the operator can see how far behind the Master is');
  });

  it('a stale identity outranks a degraded guard — it is the state hit first', () => {
    // Both can hold at once and there is one line. A degraded guard is a
    // boundary not holding; a stale identity is the Master not acting on the
    // level at all, which is what reads as "the toggle did nothing".
    //
    // THE MUTATION THIS CATCHES: ordering guardDegraded first, which hides the
    // reason the operator is actually looking at the bar.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({
      identityStale: true,
      guardDegraded: true,
      guardDegradedCode: 'guard-missing',
      guardDegradedReason: 'nothing is bounding this master'
    }));
    assert.match(el('Warn').textContent, /NOT IN EFFECT/);
  });

  it('an unconfirmable identity says so rather than reassuring', () => {
    // tmux did not answer. The #905 discipline again: silence here would render
    // "all good" from a read that never happened.
    //
    // THE MUTATION THIS CATCHES: treating null like false, which is the tidier
    // two-state version and goes quiet during exactly the tmux wedge this
    // install hits.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({ identityStale: null }));
    assert.equal(el('Warn').hidden, false);
    assert.match(el('Warn').textContent, /Could not confirm/);
  });

  it('a confirmed "not enforced" outranks an unconfirmable identity', () => {
    // Both are non-healthy and there is one line. An UNKNOWN must never suppress
    // a CONFIRMED absence — the first ordering here put the unknown branch above
    // the guard posture, so a tmux that would not answer hid a boundary that was
    // measurably gone.
    //
    // THE MUTATION THIS CATCHES: ranking `identityStale === null` above
    // `guardDegraded`, which was the shipped ordering and which no test held.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({
      identityStale: null,
      guardDegraded: true,
      guardDegradedCode: 'guard-missing',
      guardDegradedReason: 'nothing is bounding this master'
    }));
    assert.match(el('Warn').textContent, /nothing is bounding/,
      'the measured absence is what the operator must see');
    assert.doesNotMatch(el('Warn').textContent, /Could not confirm/);
  });

  it('a fresh identity says nothing at all', () => {
    // The positive control: without it, a warning that ALWAYS renders would pass
    // all three tests above.
    const { bar, el } = mountedBar();
    bar.setAccess(settings());
    assert.equal(el('Warn').hidden, true);
  });

  it('a degraded guard outranks a pending one in the single warning line', () => {
    // Both conditions can hold at once and there is one line. "Nothing is
    // enforcing" is not softened by "and it would arrive at the next start", so
    // the worse one wins.
    //
    // THE MUTATION THIS CATCHES: ordering the branches pending-first, which
    // hides an absent boundary behind a timing note.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({
      enforcement: 'instructional',
      levelAppliesAt: 'next-ensure',
      guardDegraded: true,
      guardDegradedCode: 'guard-missing',
      guardDegradedReason: 'nothing is bounding this master'
    }));
    assert.match(el('Warn').textContent, /nothing is bounding/);
    assert.match(el('Warn').textContent, /NOT ENFORCED/, 'and it carries the code\'s label');
  });

  it('the gear renders the degraded readback too — it is the complete control', () => {
    // The plan calls the modal the complete access-level control and the bar the
    // fast path. A boundary flagged on the fast path and silent on the complete
    // one makes the fuller surface the less honest of the two.
    //
    // THE MUTATION THIS CATCHES: rendering only `enforcement` in the modal, which
    // is what it did before the review and which every other modal test allows.
    const settingsComponent = G.tcCreateMasterSettings({
      api: async () => null, apiMutate: async () => null,
      esc: (v) => String(v), buildEngineOptions: () => '', state: { engines: [] },
      document: { getElementById: () => body, querySelector: () => null }
    });
    const body = { innerHTML: '' };
    settingsComponent.renderBody({
      accessLevel: 'write', accessLevels: ['read-only', 'suggest', 'write'],
      enabledAccessLevels: ['read-only', 'suggest', 'write'],
      enforcement: 'structural', levelAppliesAt: 'next-tool-call',
      launchModes: [], scope: 'all', autoStart: false,
      guardLevel: 'read-only', guardDegraded: true, guardDegradedCode: 'level-mismatch',
      guardDegradedReason: 'the guard is permitting LESS than the configured level allows'
    }, []);
    assert.match(body.innerHTML, /master-enforcement-degraded/,
      'the badge must be marked, not just tinted');
    assert.match(body.innerHTML, /permitting LESS/, 'and carry the reason');
    assert.match(body.innerHTML, /MISMATCH/, 'labelled from the shared code table');
    assert.match(body.innerHTML, /applying <strong>read-only<\/strong>/,
      'and name what the guard is ACTUALLY applying — guardLevel\'s only consumer');
  });

  it('the degraded warning survives clearing an error — they have different lifetimes', () => {
    // Opening the gear clears the error line. It does not fix a missing write
    // guard, so folding the two into one element would make a live boundary
    // warning vanish on an unrelated click.
    //
    // THE MUTATION THIS CATCHES: routing `guardDegradedReason` through
    // `setError`, which passes every assertion above and loses the warning on
    // the next gear press.
    const { bar, el } = mountedBar();
    bar.setAccess(settings({ guardDegraded: true, guardDegradedReason: 'the guard is gone' }));
    bar.setError('something else failed');
    bar.setError('');
    assert.equal(el('Warn').hidden, false, 'the standing condition is still standing');
    assert.match(el('Warn').textContent, /the guard is gone/);
  });

  it('re-fetches BEFORE it patches, so a flip cannot act on a stale bar', () => {
    // Decision C: the dangerous half of staleness is closed here rather than
    // with a timer. Order is the whole contract.
    //
    // THE MUTATION THIS CATCHES: patching first and re-reading after. Every
    // happy-path assertion still passes, and the one case it exists for — two
    // surfaces open, one already changed — silently reverts the other's change.
    const { el, calls } = mountedBar({ statuses: [{ settings: settings() }] });
    el('AccessWrite').dispatch('click');
    return flush().then(() => {
      const patchAt = calls.findIndex((c) => c[0] === 'PATCH');
      const getAt = calls.findIndex((c) => c[0] === 'GET' && c[1] === '/api/master/status');
      assert.ok(getAt > -1, 'it must read the status');
      assert.ok(patchAt > -1, 'and it must patch');
      assert.ok(getAt < patchAt, 'and the read must come FIRST');
    });
  });

  it('a press that the re-fetch has turned into a no-op sends no PATCH', async () => {
    // Another surface already moved it to `write`; this bar was showing READ.
    // Re-asserting `write` would be harmless, but re-asserting the level the
    // operator was LOOKING at is not, and the same branch is what stops it.
    //
    // THE MUTATION THIS CATCHES: dropping the equality check, which turns every
    // stale press into a write of whatever the stale bar displayed.
    const { bar, el, calls } = mountedBar({
      statuses: [{ settings: settings({ accessLevel: 'write' }) }]
    });
    bar.setAccess(settings({ accessLevel: 'read-only' }));
    el('AccessWrite').dispatch('click');
    await flush();
    assert.equal(calls.some((c) => c[0] === 'PATCH'), false, 'nothing to change');
    assert.equal(el('AccessWrite').getAttribute('aria-pressed'), 'true',
      'and the bar is corrected to what the server actually says');
  });

  it('warns on the way IN to write, and names the GLOBAL scope', async () => {
    // The blast-radius wording it grew out of was right about reach ("every
    // project it can reach") and silent about scope — and scope is the half an
    // operator flipping from one session's drawer would guess wrong.
    //
    // THE MUTATION THIS CATCHES: reusing the modal's warning verbatim, which
    // says nothing about there being one Master.
    const { el, prompts } = mountedBar({ statuses: [{ settings: settings() }] });
    el('AccessWrite').dispatch('click');
    await flush();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /one Master/i, 'it must say the change is global');
    assert.match(prompts[0], /EVERYWHERE|every session/i);
    assert.match(prompts[0], /next tool call/, 'and when it binds, from the server');
    // The operator read this dialog, flipped to write, and hit a Master that
    // refused anyway — because the sentence said "no restart". The restart is
    // the single most actionable thing in it (#968).
    assert.match(prompts[0], /restart/i,
      'and that the RUNNING Master must be restarted before it acts on the change');
  });

  it('the warning reads the engine\'s binding moment rather than promising immediacy', async () => {
    // R-4's lesson, applied to the bar: on an instructional master the level
    // travels in the regenerated identity, so it arrives with the next ensure.
    //
    // THE MUTATION THIS CATCHES: hardcoding "no restart", which puts the
    // structural promise in front of an operator whose master has no guard.
    const { el, prompts } = mountedBar({
      statuses: [{ settings: settings({ enforcement: 'instructional', levelAppliesAt: 'next-ensure' }) }]
    });
    el('AccessWrite').dispatch('click');
    await flush();
    assert.doesNotMatch(prompts[0], /next tool call/);
    assert.match(prompts[0], /next time the master session starts/i);
    // The POSITIVE half. Without it, this pair pins only that `next-ensure` is
    // not immediate — and dropping the mechanism sentence entirely, collapsing
    // the three states in the OTHER direction, would stay green. Both sibling
    // call sites pin their positive branch; this one was the half-covered member
    // of the family, which is the same shape the family test above is about.
    assert.match(prompts[0], /rather than a write guard/,
      'a STATED instructional binding must explain the mechanism, not just the timing');
  });

  it('the confirmation is cautious about WHEN and silent about WHY when the field is absent', () => {
    // The third member of the family. `bindsAt` (the modal hint) and `setAccess`
    // (the bar's warning line) both have their absent-field state pinned; this
    // one — the confirmation shown on the way into `write` — did not, and it is
    // the surface where the sentence is read most carefully.
    //
    // Payload skew is the reachable case: a service-worker-cached client against
    // an older server. On a Claude master, "this engine carries the level in its
    // instructions rather than a write guard" is false.
    //
    // THE MUTATION THIS CATCHES: collapsing `writeWarningText`'s three states
    // back to two, which is exactly what the two sibling call sites already
    // guard against and this one did not.
    const skewed = settings();
    delete skewed.levelAppliesAt;
    const { el, prompts } = mountedBar({ statuses: [{ settings: skewed }] });
    el('AccessWrite').dispatch('click');
    return flush().then(() => {
      assert.equal(prompts.length, 1, 'the confirmation must still be shown');
      assert.doesNotMatch(prompts[0], /rather than a write guard/,
        'absence of the field must not become a claim about the engine');
      assert.doesNotMatch(prompts[0], /next tool call/, 'nor a promise of immediacy');
      assert.match(prompts[0], /next time the master session starts/,
        'the cautious WHEN still ships');
    });
  });

  it('does NOT warn on the way back to read-only', async () => {
    // Returning to read-only is always the safe direction, and warning there
    // trains the operator to click through the one that matters.
    //
    // THE MUTATION THIS CATCHES: warning on every change — which is the version
    // that looks more careful and is measurably less safe.
    const { el, prompts, calls } = mountedBar({
      statuses: [{ settings: settings({ accessLevel: 'write' }) }]
    });
    el('AccessRead').dispatch('click');
    await flush();
    assert.deepEqual(prompts, [], 'the safe direction is not gated');
    assert.equal(calls.some((c) => c[0] === 'PATCH'), true, 'and it still happens');
  });

  it('warns going suggest → write too, because that is also a move IN', async () => {
    // THE MUTATION THIS CATCHES: gating the warning on the CURRENT level being
    // read-only. An operator at `suggest` — where every write is confirmed —
    // would then reach unconfirmed fleet-wide writes with no prompt at all.
    const { el, prompts } = mountedBar({
      statuses: [{ settings: settings({ accessLevel: 'suggest' }) }]
    });
    el('AccessWrite').dispatch('click');
    await flush();
    assert.equal(prompts.length, 1, 'the destination is what makes it dangerous');
  });

  it('a declined warning changes nothing', async () => {
    // THE MUTATION THIS CATCHES: ignoring the confirmation's return value —
    // a dialog that is shown, dismissed, and obeyed anyway.
    const { el, calls } = mountedBar({
      statuses: [{ settings: settings() }], confirm: false
    });
    el('AccessWrite').dispatch('click');
    await flush();
    assert.equal(calls.some((c) => c[0] === 'PATCH'), false);
    assert.equal(el('AccessRead').getAttribute('aria-pressed'), 'true', 'still read-only');
  });

  it('with no way to confirm, write is REFUSED rather than granted silently', async () => {
    // The recurring defect of this whole issue, caught in this chunk's own code:
    // `typeof ask === 'function' && !ask(...)` reads as "warn before granting
    // write" and, with nothing to warn WITH, evaluates false and carries
    // straight on to fleet-wide write access unconfirmed. A guard that fails by
    // proceeding with the value it was computing is an allow.
    //
    // `global.confirm` is undefined here, which is what makes this reachable at
    // all in a non-browser context — but the shape is wrong regardless of how
    // often the branch is hit.
    //
    // THE MUTATION THIS CATCHES: folding the two checks back into one `&&`.
    const { el, calls } = mountedBar({ statuses: [{ settings: settings() }], noConfirm: true });
    el('AccessWrite').dispatch('click');
    await flush();
    assert.equal(calls.some((c) => c[0] === 'PATCH'), false,
      'no confirmation available must mean no write');
    assert.equal(el('AccessRead').getAttribute('aria-pressed'), 'true', 'still read-only');
    assert.equal(el('Error').hidden, false, 'and the refusal is stated, not silent');
  });

  it('the same missing-confirmation path does NOT block the safe direction', async () => {
    // Returning to read-only is never gated, so a page that cannot confirm must
    // still be able to revoke. Denying both directions would leave a master
    // stuck at write with no way back — the failure the fix above must not
    // introduce while closing the one it targets.
    //
    // THE MUTATION THIS CATCHES: hoisting the confirmation-availability check
    // out of the `level === 'write'` branch, which is the tidier-looking
    // refactor and turns a safety fix into a lockout.
    const { el, calls } = mountedBar({
      statuses: [{ settings: settings({ accessLevel: 'write' }) }], noConfirm: true
    });
    el('AccessRead').dispatch('click');
    await flush();
    assert.equal(calls.some((c) => c[0] === 'PATCH'), true, 'revocation is always available');
  });

  it('a failed PATCH leaves the toggle where the server last put it, and says so', async () => {
    // THE MUTATION THIS CATCHES: painting the requested level before the PATCH
    // resolves. The operator would then be looking at WRITE on a master that is
    // still read-only — the precise inverse of the property this control exists
    // to hold.
    const { el, calls } = mountedBar({
      statuses: [{ settings: settings() }], patch: null
    });
    el('AccessWrite').dispatch('click');
    await flush();
    assert.equal(calls.filter((c) => c[0] === 'GET').length, 1,
      'it must not read the status back after a change that did not happen');
    assert.equal(el('AccessRead').getAttribute('aria-pressed'), 'true');
    assert.equal(el('AccessWrite').getAttribute('aria-pressed'), 'false');
    assert.equal(el('Error').hidden, false, 'and the failure is visible, not console-only');
  });

  it('paints the result from a fresh status read, not from the click', async () => {
    // The read-back is what can tell the operator the guard actually took the
    // change — the invisibility R-15 exists to remove. So the post-PATCH paint
    // comes from the server, including its guard readback.
    //
    // THE MUTATION THIS CATCHES: `setAccess({accessLevel: level})` after a
    // successful PATCH. It renders the right segment and silently drops the
    // enforcement tier and the degraded state.
    const { el, calls } = mountedBar({
      statuses: [
        { settings: settings() },
        { settings: settings({
          accessLevel: 'write',
          guardDegraded: true,
          guardDegradedCode: 'level-mismatch',
          guardDegradedReason: 'the guard is permitting LESS than the configured level allows'
        }) }
      ]
    });
    el('AccessWrite').dispatch('click');
    await flush();
    assert.equal(calls.filter((c) => c[0] === 'GET').length, 2, 'read before AND after');
    assert.equal(el('AccessWrite').getAttribute('aria-pressed'), 'true');
    assert.equal(el('Warn').hidden, false,
      'the post-change state includes whether the guard actually took it');
    assert.match(el('Warn').textContent, /permitting LESS/);
  });

  it('Kill confirms, posts, and repaints from the server (#968)', async () => {
    // The remedy the access toggle needs. Repaints from a status read rather
    // than from the fact that a kill returned 200 — the same rule the toggle
    // follows, and it is also how the stale-identity warning clears, since a
    // fresh session reads the current instructions.
    //
    // THE MUTATION THIS CATCHES: skipping the post-kill repaint, which leaves the
    // bar asserting a stale-identity warning about a Master that no longer
    // exists.
    const { doc, el, calls } = mountedBar({ statuses: [{ settings: settings() }] });
    el('KillBtn').dispatch('click');
    await flush();
    assert.ok(calls.some((c) => c[0] === 'POST' && c[1] === '/api/master/kill'),
      'it must actually call the kill route');
    assert.ok(calls.some((c) => c[0] === 'GET' && c[1] === '/api/master/status'),
      'and repaint from the server afterwards');
    assert.ok(doc, 'sanity');
  });

  it('an UNCONFIRMED kill is not reported as "Master stopped"', async () => {
    // The gap three reviewers converged on, at the surface end. The route refuses
    // when tmux will not confirm, and the bar must word the outcome from `killed`
    // rather than `wasRunning` — they differ in exactly that case, and
    // `wasRunning` alone prints "Master stopped" about a Master most likely still
    // up. This is also what gives `killed` a reader.
    //
    // WHAT THIS PINS, precisely: the refusal path shows the error and paints NO
    // status. It does NOT catch wording the line from `wasRunning` — measured,
    // and the api-helper comment says why: a refusal is a 500, so `apiMutate`
    // returns null and the status line is never reached. Under the route's
    // contract a 200 always has `killed === wasRunning`, so that mutation is
    // unobservable rather than uncaught. Claiming otherwise here would be the
    // false-confidence this issue is about.
    const { doc, el } = mountedBar({ statuses: [{ settings: settings() }], patch: null });
    el('KillBtn').dispatch('click');
    await flush();
    const line = doc.getElementById('masterPanelStatusText').textContent;
    assert.doesNotMatch(line, /Master stopped/,
      'a refusal must never read as a completed kill');
    assert.equal(el('Error').hidden, false, 'and the refusal is visible');
  });

  it('Kill is disabled while a press is in flight', async () => {
    // It shares the access toggle's in-flight latch, so leaving it pressable
    // meant the latch silently did a disabled control's job and the operator got
    // no signal that the first press was still running.
    //
    // Asserted mid-flight, with a confirmation that inspects the button at the
    // moment the handler is inside its own guard — a check after `flush()` would
    // pass against a control that was never disabled at all.
    //
    // THE MUTATION THIS CATCHES: dropping Kill from `setBusy`.
    let disabledDuring = null;
    const { doc, ids } = makeDocument(['masterPanelBar']);
    withIdParsingInnerHTML(ids.masterPanelBar, doc);
    const bar = G.tcCreateMasterControlBar({
      doc,
      rootId: 'masterPanelBar',
      prefix: 'masterPanel',
      title: 'M',
      api: async () => ({ settings: settings() }),
      apiMutate: async () => ({ killed: true, wasRunning: true }),
      confirm: () => {
        disabledDuring = doc.getElementById('masterPanelKillBtn').disabled;
        return true;
      }
    });
    bar.mount();
    doc.getElementById('masterPanelKillBtn').dispatch('click');
    await flush();
    assert.equal(disabledDuring, true,
      'Kill must be disabled while its own press is still running');
  });

  it('a declined confirmation kills nothing', async () => {
    // Destructive AND global — there is exactly one Master.
    //
    // THE MUTATION THIS CATCHES: ignoring the confirmation's return value.
    const { el, calls, prompts } = mountedBar({
      statuses: [{ settings: settings() }], confirm: false
    });
    el('KillBtn').dispatch('click');
    await flush();
    assert.equal(prompts.length, 1, 'it must ask');
    assert.match(prompts[0], /EVERYWHERE|every session/i, 'and say the stop is global');
    assert.match(prompts[0], /memory\//, 'and name what SURVIVES, not just what is lost');
    assert.equal(calls.some((c) => c[0] === 'POST'), false, 'and kill nothing when declined');
  });

  it('with no way to confirm, the Master is NOT stopped', async () => {
    // Same fail-closed shape as the write grant: `typeof ask === 'function' &&
    // !ask(...)` reads as "confirm before stopping" and stops it silently when
    // there is nothing to confirm with.
    //
    // THE MUTATION THIS CATCHES: folding the availability check into the `&&`.
    const { el, calls } = mountedBar({ statuses: [{ settings: settings() }], noConfirm: true });
    el('KillBtn').dispatch('click');
    await flush();
    assert.equal(calls.some((c) => c[0] === 'POST'), false);
    assert.equal(el('Error').hidden, false, 'and it says why, rather than doing nothing quietly');
  });

  it('a second press while one is in flight does not send a second PATCH', async () => {
    // THE MUTATION THIS CATCHES: dropping the in-flight latch. Two PATCHes race
    // and the toggle settles on whichever status answered last — a level nobody
    // chose. Driven through the real listeners, because `disabled` alone would
    // be the browser's guard and this must hold without it.
    const { el, calls } = mountedBar({ statuses: [{ settings: settings() }] });
    el('AccessRead').dispatch('click');
    el('AccessRead').dispatch('click');
    await flush();
    assert.equal(calls.filter((c) => c[0] === 'PATCH').length, 0,
      'read-only → read-only is a no-op either way');

    const second = mountedBar({ statuses: [{ settings: settings() }] });
    second.el('AccessWrite').dispatch('click');
    second.el('AccessWrite').dispatch('click');
    await flush();
    assert.equal(second.calls.filter((c) => c[0] === 'PATCH').length, 1,
      'exactly one change reaches the server');
  });
});

describe('#755 both surfaces drive the live toggle, and neither grows a timer', () => {
  it('each page hands the bar the mutating client it needs', () => {
    // Without `apiMutate` the segments are inert — which would be a control that
    // renders live and does nothing, on one page only. Asserted per page because
    // "the component supports it" is not the same as "both callers pass it".
    for (const [name, src, root] of [['ui.js', UI, "rootId: 'masterPanelBar'"],
      ['session.js', SESSION_JS, "rootId: 'masterDrawerBar'"]]) {
      const block = liftDeclaration(src, 'window.tcCreateMasterControlBar({');
      assert.ok(block.includes(root), `${name}'s bar must be the one at ${root}`);
      assert.match(block, /apiMutate/, `${name} must pass apiMutate to the bar`);
    }
  });

  it('the dashboard\'s apiMutate is initialized before ui.js evaluates', () => {
    // A load-order contract this change CREATED, so it gets a guard.
    //
    // `apiMutate` is a top-level `const` in landing.js, shared across the page's
    // classic scripts. Every other ui.js use of it is inside a function, so it
    // resolves at call time and the order never mattered. Passing it into the
    // bar's factory is TOP-LEVEL code: if ui.js ever loaded first it would hit
    // the temporal dead zone and throw at parse-time-adjacent evaluation, taking
    // the whole dashboard down before anything rendered.
    //
    // THE MUTATION THIS CATCHES: reordering the two <script> tags in
    // index.html — a change that looks like tidying and produces a blank page.
    // Note what the sibling test above CANNOT catch: it greps for the token
    // `apiMutate` in the source, which is present either way.
    assert.match(UI, /apiMutate/, 'precondition: ui.js references it at all');
    const landingAt = INDEX.indexOf('/landing.js');
    const uiAt = INDEX.indexOf('/ui.js');
    assert.ok(landingAt > -1 && uiAt > -1, 'both scripts must be on the page');
    assert.ok(landingAt < uiAt,
      'landing.js declares apiMutate; ui.js consumes it at top level, so it must load first');
  });

  it('the session page repaints the level on its EXISTING poll chain', () => {
    // Done-when 4: a flip in one session's bar reaches another's. The mechanism
    // is the visibility-aware chain Medusa already rides — no new timer, which
    // is the arrangement #98/#268 leaves room for and `reconnect-policy.js`
    // records as inside the norm.
    //
    // The whole CHAIN is asserted, not just the one function. "A function
    // mentions loadAccess" is true of dead code; what makes the level actually
    // refresh is that the scheduled tick reaches it.
    const poll = liftDeclaration(SESSION_JS, 'async function pollStatus');
    assert.match(poll, /masterBar\.loadAccess\(\)/,
      'the polled read must refresh the Master access controls');
    assert.match(poll, /masterOpen/,
      'gated on the drawer being open — a closed drawer must not add a request per tick');

    const tick = liftDeclaration(SESSION_JS, 'async function pollTick');
    assert.match(tick, /pollStatus\(\)/, 'and the scheduled tick must reach it');
    assert.match(liftDeclaration(SESSION_JS, 'function startPolling'), /pollTick\(\)/,
      'and the chain that schedules it must be the page\'s existing one');
  });

  it('neither surface grew a timer of its own for the Master level', () => {
    // Decision C. The dashboard has no clock and is not getting one; the
    // residual (a panel left open showing a stale segment) cannot be ACTED on,
    // because the bar re-fetches before every flip.
    //
    // THE MUTATION THIS CATCHES: reaching for setInterval on the dashboard to
    // close the cosmetic half — the reflex this decision exists to refuse.
    const dot = liftDeclaration(UI, 'async function refreshMasterDot');
    assert.doesNotMatch(dot, /setInterval|setTimeout/,
      'the dashboard probe stays one-shot');
  });

  it('the dashboard repaints from the status probe it already makes', () => {
    // One fetch answering one question. Two calls asking the same thing is how
    // the two surfaces came to disagree about everything else the bar reunified.
    const at = UI.indexOf('async function refreshMasterDot');
    assert.ok(at > -1);
    const body = UI.slice(at, UI.indexOf('\n}\n', at));
    assert.match(body, /masterBar\.setAccess\(/,
      'it must paint the access controls from the status it already has');
    assert.doesNotMatch(body, /loadAccess/,
      'and must not issue a second /api/master/status for the same paint');
  });

  it('saving in the gear moves the toggle beside it', () => {
    // The gear sits INSIDE the bar, so these are two controls for one setting
    // visible in the same glance. Without this the operator saves `write` in the
    // modal and watches the toggle two inches away keep saying READ, which reads
    // as the save having failed.
    //
    // Asserted per page, because "the component supports a callback" is not the
    // same as "both callers wire it" — and this is the surface pair #768 exists
    // to stop drifting.
    //
    // THE MUTATION THIS CATCHES: adding `onSaved` to the component and wiring it
    // on one page only, which is the exact shape of every defect #768 removed.
    for (const [name, src] of [['ui.js', UI], ['session.js', SESSION_JS]]) {
      const block = liftDeclaration(src, 'window.tcCreateMasterSettings({');
      assert.match(block, /onSaved:/, `${name} must pass onSaved`);
      assert.match(block, /masterBar\.loadAccess\(\)/,
        `${name}'s onSaved must repaint the bar's access controls`);
    }
  });

  it('the settings component actually fires onSaved — and only when the save worked', async () => {
    // The wiring test above reads SOURCE, which cannot tell a callback that
    // fires from one that is merely passed. This drives the real component.
    //
    // THE MUTATION THIS CATCHES: moving the call outside the success branch, so
    // a failed save repaints the bar and makes the failure look like a change.
    /** @param {*} patchResult - What the PATCH resolves to. */
    const save = async (patchResult) => {
      let fired = 0;
      const doc = {
        getElementById: () => null,
        querySelector: () => ({ value: 'write' })
      };
      const settings = G.tcCreateMasterSettings({
        api: Object.assign(async () => null, { lastError: 'nope' }),
        apiMutate: async () => patchResult,
        esc: (v) => v,
        buildEngineOptions: () => '',
        state: { engines: [] },
        document: doc,
        onSaved: () => { fired++; }
      });
      await settings.save();
      return fired;
    };
    assert.equal(await save({ ok: true }), 1, 'a successful save must notify the surface');
    assert.equal(await save(null), 0, 'a failed save changed nothing, so it must notify nothing');
  });

  it('no surface claims the change needs no restart — the whole family (#968)', () => {
    // The string the operator actually read before hitting the bug, and the one
    // thing a structural master must not say: the guard binds immediately, the
    // Master does not.
    //
    // SCANS EVERY TRACKED MEMBER. The first version read only `api-helper.js` and
    // reported the family held while `docs/configuration-reference.md`, both
    // halves of ADR 0008, the `[Unreleased]` CHANGELOG entry and `FEATURES.md`
    // all still carried it — the CHANGELOG one would have PUBLISHED the
    // disproved claim. A family guard that knows about one member is how the
    // claim survived in the first place.
    //
    // TRACKED is the operative word. A sixth member, `.prawduct/artifacts/
    // api-contract.md`, was briefly added here and had to come out: `.gitignore`
    // is `.prawduct/*`, so that file exists in no clone and the guard would have
    // thrown ENOENT in CI while passing locally — this worktree symlinks
    // `.prawduct/artifacts` into the primary checkout, which is exactly the
    // "passes on the machine that wrote it" trap `test/degraded-reads-frontend.
    // test.js` already documents about the same directory. Its claim IS fixed;
    // it simply cannot be held from a test. Everything listed below is tracked —
    // asserted, not assumed, by the readability check itself.
    //
    // Bans the CLAIM, not the phrase: the corrected docs quote the old wording
    // to explain what changed, and a bare /no restart/ would forbid saying what
    // was fixed.
    const CLAIMS = [
      /next tool call\s*—\s*no restart/i,
      /next write attempt with no restart/i,
      /next tool call with no restart/i,
      /with no restart and no re-ensure/i
    ];
    // Seven now: `README.md` carried the claim in the operator's first-contact
    // document, and `lib/master.js`'s own JSDoc matched the banned patterns —
    // both escaped every earlier widening. The family has been bigger than the
    // last count of it three times running, which is the argument for deriving
    // it rather than listing it; that derivation is #968's own follow-up work,
    // not this branch's.
    const FAMILY = ['public/api-helper.js', 'docs/configuration-reference.md',
      'docs/adr/0008-project-master-session-model.md', 'CHANGELOG.md', 'FEATURES.md',
      'README.md', 'lib/master.js'];
    for (const rel of FAMILY) {
      const abs = path.join(__dirname, '..', rel);
      // TRACKED, not merely present. Existence is the weaker property and would
      // not have caught the member this list already lost: in this worktree
      // `.prawduct/artifacts` is a symlink into the primary checkout, so a
      // gitignored file passes `existsSync` here and still ENOENTs in CI. Asking
      // git is what makes the claim above true rather than nearly true.
      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', rel],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
      assert.equal(tracked.status, 0,
        `${rel} is not tracked by git, so this guard would pass locally and fail in CI — `
        + 'a family member has to exist in every clone');
      const body = fs.readFileSync(abs, 'utf8');
      for (const claim of CLAIMS) {
        assert.doesNotMatch(body, claim,
          `${rel} still says a level change needs no restart — the running Master reads its `
          + 'instructions only at launch');
      }
    }
  });

  it('the modal hint and the confirmation each RENDER the restart, structurally', () => {
    // Behavioural, because the source form of this guard was too coarse: both
    // functions contain the word "restart" for unrelated reasons (the engine hint
    // says "restart via tmux"), so reverting the access-level sentence alone left
    // a source scan green. Measured — that mutation was run.
    //
    // THE MUTATION THIS CATCHES: dropping the restart clause from `bindsAt` OR
    // from `writeWarningText`, one at a time.
    const body = { innerHTML: '' };
    const component = G.tcCreateMasterSettings({
      api: async () => null, apiMutate: async () => null,
      esc: (v) => String(v), buildEngineOptions: () => '', state: { engines: [] },
      document: { getElementById: () => body, querySelector: () => null }
    });
    component.renderBody({
      accessLevel: 'read-only', accessLevels: ['read-only', 'suggest', 'write'],
      enabledAccessLevels: ['read-only', 'suggest', 'write'],
      enforcement: 'structural', levelAppliesAt: 'next-tool-call',
      launchModes: [], scope: 'all', autoStart: false
    }, []);
    const hint = body.innerHTML.slice(body.innerHTML.indexOf('read-only'),
      body.innerHTML.indexOf('read-only') + 900);
    assert.match(hint, /restart/i,
      "the modal's tier hint must say the running master needs restarting");
    // The confirmation's half of this is asserted where `mountedBar` lives —
    // see 'warns on the way IN to write', which drives the real dialog.
  });

  it('every place that describes when a level change lands also names the restart', () => {
    // The positive half, and it is PER-SITE. The first version asserted one
    // matching occurrence anywhere in `api-helper.js`, so reverting a single
    // call site left it green — it did not hold the family it was named for.
    //
    // THE MUTATION THIS CATCHES: dropping the restart clause from `bindsAt` OR
    // from `writeWarningText` alone.
    const helper = read('api-helper.js');
    for (const fn of ['function renderMasterSettingsBody', 'function writeWarningText']) {
      const body = liftDeclaration(helper, fn);
      assert.match(body, /restart/i,
        `${fn} describes when a change takes effect and must name the restart`);
    }
  });

  it('the Kill button ships as a real control, with no pending treatment', () => {
    const markup = G.tcMasterControlBarMarkup('masterPanel', {});
    const m = /<button[^>]*id="masterPanelKillBtn"[^>]*>/.exec(markup);
    assert.ok(m, 'Kill must render as a real button');
    assert.doesNotMatch(m[0], /\sdisabled(?=[\s>])/, 'and be pressable');
    assert.doesNotMatch(m[0], /aria-disabled/);
  });

  it('the Launch button ships as a real control, hidden by default, with correct title', () => {
    const markup = G.tcMasterControlBarMarkup('masterPanel', {});
    const m = /<button[^>]*id="masterPanelLaunchBtn"[^>]*>/.exec(markup);
    assert.ok(m, 'Launch must render as a real button');
    assert.match(m[0], /hidden/, 'Launch must be hidden by default');
    assert.match(m[0], /title="Start a fresh Master session\. Its memory\/ files survive; the conversation does not\."/, 'Must specify fresh conversation');
  });

  it('toggles Launch and Kill visibility mutually exclusively based on status', () => {
    const { doc, ids } = makeDocument(['root']);
    withIdParsingInnerHTML(ids.root, doc);
    const bar = G.tcCreateMasterControlBar({ doc, rootId: 'root', prefix: 'masterPanel' });
    bar.mount();
    const el = (s) => doc.getElementById('masterPanel' + s);

    bar.setStatus('live');
    assert.equal(el('LaunchBtn').classList.contains('hidden'), true, 'Launch hidden when live');
    assert.equal(el('KillBtn').classList.contains('hidden'), false, 'Kill shown when live');

    bar.setStatus('down');
    assert.equal(el('LaunchBtn').classList.contains('hidden'), false, 'Launch shown when down');
    assert.equal(el('KillBtn').classList.contains('hidden'), true, 'Kill hidden when down');

    bar.setStatus('');
    // Rationale for unknown state:
    // Showing Kill on an unknown state is the safer default. The kill route (#968) 
    // refuses safely with MASTER_LIVENESS_UNKNOWN, whereas showing Launch on an 
    // unknown state risks spawning a second Master over one that could just be wedged.
    assert.equal(el('LaunchBtn').classList.contains('hidden'), true, 'Launch hidden when unknown');
    assert.equal(el('KillBtn').classList.contains('hidden'), false, 'Kill shown when unknown');
  });

  it('wires the Launch button to deps.onRetry only if provided', () => {
    let fired = 0;
    const { doc: doc1, ids: ids1 } = makeDocument(['root1']);
    withIdParsingInnerHTML(ids1.root1, doc1);
    const bar1 = G.tcCreateMasterControlBar({ 
      doc: doc1, rootId: 'root1', prefix: 'masterPanel', onRetry: () => fired++ 
    });
    bar1.mount();
    doc1.getElementById('masterPanelLaunchBtn').dispatch('click');
    assert.equal(fired, 1, 'Launch button must invoke deps.onRetry when provided');

    const { doc: doc2, ids: ids2 } = makeDocument(['root2']);
    withIdParsingInnerHTML(ids2.root2, doc2);
    const bar2 = G.tcCreateMasterControlBar({ 
      doc: doc2, rootId: 'root2', prefix: 'masterPanel2' 
    });
    bar2.mount();
    assert.doesNotThrow(() => doc2.getElementById('masterPanel2LaunchBtn').dispatch('click'), 
      'Launch button must not crash when clicked without deps.onRetry');
  });

  it('the segments meet the touch-target minimum the mobile Direction binds', () => {
    // `nonfunctional-requirements.md` § Direction: "Interactive elements are
    // ≥44×44px", ratified, no exception covering this surface — the bar renders
    // in a drawer and a panel, not a banner.
    //
    // THE MUTATION THIS CATCHES: styling the segments to match the 30px
    // `.banner-btn` beside them, which looks tidier and ships a target a thumb
    // misses. The bar's collapse rule (#768 chunk 3) is what answers the height
    // this costs; it is not a reason to ship under the minimum meanwhile.
    const css = read('shared-controls.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const at = css.indexOf('.master-access-seg {');
    assert.ok(at > -1, 'the segments must be styled in the SHARED sheet, or one page loses them');
    const block = css.slice(at, css.indexOf('}', at));
    for (const prop of ['min-height', 'min-width']) {
      const m = new RegExp(`${prop}:\\s*(\\d+)px`).exec(block);
      assert.ok(m, `${prop} must be declared`);
      assert.ok(Number(m[1]) >= 44, `${prop} is ${m[1]}px, below the ≥44px floor`);
    }
  });
});

describe('#768 the shared stylesheet is wired on both pages', () => {
  it('both pages link it, before their own sheet', () => {
    // Order is the contract: base look shared, page overrides still win.
    for (const [name, html, own] of [['index.html', INDEX, '/style.css'],
      ['session.html', SESSION_HTML, '/session.css']]) {
      const shared = html.indexOf('/shared-controls.css');
      const page = html.indexOf(own);
      assert.ok(shared > -1, `${name} must link the shared sheet`);
      assert.ok(shared < page, `${name} must link it BEFORE ${own}`);
    }
  });

  it('the service worker carries it in both lists', () => {
    // A missing shared stylesheet is not a cosmetic skew — the bar renders
    // unstyled. STATIC_ASSETS for offline coherence, NETWORK_FIRST_PATHS so a
    // restyle reaches an operator with an active worker WITHOUT a CACHE_NAME
    // bump, which tears down every browser's worker (#710).
    const statics = SW.slice(SW.indexOf('STATIC_ASSETS'), SW.indexOf('NETWORK_FIRST_PATHS'));
    const network = SW.slice(SW.indexOf('NETWORK_FIRST_PATHS'));
    assert.match(statics, /'\/shared-controls\.css'/);
    assert.match(network, /'\/shared-controls\.css'/);
  });

  it('carries the classes the bar actually emits', () => {
    // Derived from the markup, not hand-listed — the same lesson the settings
    // modal's parity guard learned, where the plan named six classes and the
    // component emitted 23.
    // Comments STRIPPED first. A prose mention of a class — "rather than
    // borrowing `.engine-pill`" — otherwise reads as a declaration, and this
    // guard reported a class as styled purely because a comment named it. A
    // guard that treats documentation as implementation cannot fail.
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
    const css = strip(read('shared-controls.css'));
    const bar = G.tcMasterControlBarMarkup('masterPanel', {});
    const emitted = new Set();
    for (const m of bar.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].trim().split(/\s+/)) if (c) emitted.add(c);
    }
    // EVERY class, not just the `master-*` ones. The first version filtered to
    // the bar's own prefix and therefore could not see the defect that actually
    // shipped: the pill emitted `engine-pill`, a class declared only in
    // style.css, so it was unstyled on the session page.
    //
    // The exemptions below are CHECKED, not asserted. A bare allow-list is the
    // mechanism that would hide the next `engine-pill`-shaped defect — so each
    // exempt class must still satisfy one of the three honest outcomes: it lives
    // in the shared sheet, or it is declared in BOTH page sheets (parity, the
    // older contract), or it is declared nowhere at all and is therefore a hook
    // needing no rule. What is forbidden is the fourth case: declared in exactly
    // one page sheet, which is what "unstyled on the other page" looks like.
    const style = strip(read('style.css'));
    const session = strip(read('session.css'));
    const has = (t, c) => new RegExp(`\\.${c}(?![\\w-])`).test(t);

    // Classes the bar emits purely as selector/JS hooks, carrying no styling of
    // their own. Each is a deliberate claim: `master-status-text` takes its
    // appearance from `.master-status-row`, and `medusa-head` is a positioning
    // hook whose visuals live on the `--in`/`--out` modifiers.
    const ACKNOWLEDGED_HOOKS = new Set(['master-status-text', 'medusa-head']);
    const bad = [];
    for (const c of [...emitted].sort()) {
      const inShared = has(css, c);
      const inStyle = has(style, c);
      const inSession = has(session, c);
      if (inShared) continue;                          // shared: the preferred home
      if (inStyle && inSession) continue;              // parity across both pages
      if (!inStyle && !inSession) {
        // Styled NOWHERE is a legitimate outcome — a pure selector hook — but it
        // has to be a claim someone made, not a bucket anything can fall into.
        // The three-way rule replaced a hand-written allow-list and, left open,
        // would pass a NEW emitted class styled nowhere: the one defect shape the
        // old list did catch. Naming them restores that without going back to
        // "trust me" for the classes that ARE styled.
        if (!ACKNOWLEDGED_HOOKS.has(c)) {
          bad.push(`${c}: styled nowhere and not acknowledged as a hook`);
        }
        continue;
      }
      bad.push(`${c}: shared=${inShared} style=${inStyle} session=${inSession}`);
    }
    assert.deepEqual(bad, [],
      'a class the shared bar emits must be shared, in parity across both page '
      + 'sheets, or styled nowhere — never declared on exactly one page');
  });
});

describe('#3218 tcSanitizeMasterAttachmentFilename', () => {
  it('passes an already-safe name through unchanged', () => {
    assert.equal(G.tcSanitizeMasterAttachmentFilename('notes.md'), 'notes.md');
  });

  it('turns a macOS screenshot name (spaces, internal dots) into a safe one', () => {
    assert.equal(
      G.tcSanitizeMasterAttachmentFilename('Screenshot 2026-11-22 at 9.15.00 PM.png'),
      'Screenshot-2026-11-22-at-9.15.00-PM.png'
    );
  });

  it('strips unicode and parentheses, collapsing the dashes they leave behind', () => {
    assert.equal(G.tcSanitizeMasterAttachmentFilename('my notes (draft) ☕.md'), 'my-notes-draft.md');
  });

  it('caps a long name at 128 chars, preserving the extension rather than truncating it away', () => {
    const long = `${'a'.repeat(200)}.png`;
    const result = G.tcSanitizeMasterAttachmentFilename(long);
    assert.equal(result.length, 128);
    assert.ok(result.endsWith('.png'), 'the extension must survive the truncation');
  });

  it('treats an extension longer than 16 chars as not being one, sanitizing the whole name as a bare stem', () => {
    const result = G.tcSanitizeMasterAttachmentFilename('report.notarealextension');
    assert.equal(result, 'report.notarealextension', 'short enough as a whole name to need no truncation, and the stray dot is a safe character either way');
  });

  it('a dot-only name (rejected outright by SAFE_FILENAME_RE) becomes "attachment"', () => {
    assert.equal(G.tcSanitizeMasterAttachmentFilename('.'), 'attachment');
    assert.equal(G.tcSanitizeMasterAttachmentFilename('..'), 'attachment');
    assert.equal(G.tcSanitizeMasterAttachmentFilename('...'), 'attachment');
  });

  it('an empty or missing name becomes "attachment" too', () => {
    assert.equal(G.tcSanitizeMasterAttachmentFilename(''), 'attachment');
    assert.equal(G.tcSanitizeMasterAttachmentFilename(undefined), 'attachment');
  });

  it('dedupes against a taken set with -2, -3, ... before the extension', () => {
    const taken = new Set(['notes.md']);
    const first = G.tcSanitizeMasterAttachmentFilename('notes.md', taken);
    assert.equal(first, 'notes-2.md');
    taken.add(first);
    const second = G.tcSanitizeMasterAttachmentFilename('notes.md', taken);
    assert.equal(second, 'notes-3.md');
  });

  it('never renames a name that is not actually in the taken set', () => {
    const taken = new Set(['other.md']);
    assert.equal(G.tcSanitizeMasterAttachmentFilename('notes.md', taken), 'notes.md');
  });

  it('every produced name clears the real SAFE_FILENAME_RE from lib/secure-clipboard.js', () => {
    const SAFE_FILENAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
    const names = [
      'Screenshot 2026-11-22 at 9.15.00 PM.png', 'my notes (draft) ☕.md', '.', '..', '...',
      '', undefined, `${'a'.repeat(200)}.png`, 'report.notarealextension', '日本語ファイル.txt'
    ];
    for (const n of names) {
      const result = G.tcSanitizeMasterAttachmentFilename(n);
      assert.match(result, SAFE_FILENAME_RE, `"${n}" -> "${result}"`);
    }
  });
});

describe('#3218 tcBindMasterDropzone', () => {
  /** Captures every listener a target registers, by type, without needing a real removeEventListener. */
  function captureAddEventListener(target) {
    const handlers = {};
    const real = typeof target.addEventListener === 'function' ? target.addEventListener.bind(target) : null;
    target.addEventListener = (type, fn) => {
      (handlers[type] = handlers[type] || []).push(fn);
      if (real) real(type, fn);
    };
    return handlers;
  }

  /**
   * Mounts `tcBindMasterDropzone` with capture already installed on every
   * target it will touch, including the overlay it creates internally —
   * `doc.createElement` is wrapped FIRST, so the very div the bind call
   * creates for the overlay is captured as it's made, not retroactively
   * (which would miss listeners already attached before the wrap ran).
   */
  function mountDropzone(onUpload) {
    const { doc, ids } = makeDocument(['masterPanel']);
    const docHandlers = captureAddEventListener(doc);
    const panelHandlers = captureAddEventListener(ids.masterPanel);
    let overlayHandlers = null;
    let overlay = null;
    const realCreateElement = doc.createElement.bind(doc);
    doc.createElement = (tag) => {
      const el = realCreateElement(tag);
      if (!overlayHandlers) { overlay = el; overlayHandlers = captureAddEventListener(el); }
      return el;
    };
    const bind = G.tcBindMasterDropzone({ doc, panelEl: ids.masterPanel, prefix: 'masterPanel', onUpload: onUpload || (() => {}) });
    return { doc, panel: ids.masterPanel, overlay, docHandlers, panelHandlers, overlayHandlers, bind };
  }

  it('creates a hidden overlay above the panel, mounted inside it', () => {
    const { panel, overlay } = mountDropzone();
    assert.ok(overlay, 'the overlay must be created');
    assert.equal(overlay.classList.contains('hidden'), true, 'hidden until a file drag is in flight');
    assert.ok(panel.childNodes.includes(overlay), 'the overlay mounts inside the panel');
  });

  it('dragenter carrying files on the document reveals the overlay; a non-file drag does not', () => {
    const { overlay, docHandlers } = mountDropzone();
    assert.ok(docHandlers.dragenter && docHandlers.dragenter.length, 'a dragenter listener must be registered on doc');
    docHandlers.dragenter[0]({ dataTransfer: { types: ['text/plain'] } });
    assert.equal(overlay.classList.contains('hidden'), true, 'a text-only drag must not reveal it');
    docHandlers.dragenter[0]({ dataTransfer: { types: ['Files'] } });
    assert.equal(overlay.classList.contains('hidden'), false, 'a file drag must reveal it');
  });

  it('drop on the overlay delivers both non-image and image files, with sanitized names, and hides the overlay', () => {
    const uploaded = [];
    const { docHandlers, overlayHandlers, overlay } = mountDropzone((file, sanitized) => uploaded.push([file.name, sanitized]));
    docHandlers.dragenter[0]({ dataTransfer: { types: ['Files'] } });
    assert.equal(overlay.classList.contains('hidden'), false, 'revealed before the drop');
    let prevented = false;
    const fileA = { name: 'notes (draft).log' };
    const fileB = { name: 'Screenshot 2026-11-22 at 9.15.00 PM.png' };
    overlayHandlers.drop[0]({ preventDefault: () => { prevented = true; }, dataTransfer: { files: [fileA, fileB] } });
    assert.equal(prevented, true, 'drop must prevent the browser\'s own navigate-to-file default');
    assert.equal(overlay.classList.contains('hidden'), true, 'hidden again once the drop is handled');
    assert.deepEqual(uploaded, [
      ['notes (draft).log', 'notes-draft.log'],
      ['Screenshot 2026-11-22 at 9.15.00 PM.png', 'Screenshot-2026-11-22-at-9.15.00-PM.png']
    ], 'both the non-image and the image file must be delivered, sanitized, never restricted to image/*');
  });

  it('paste on the panel delivers both image and non-image clipboard files (clipboardData.files form)', () => {
    const uploaded = [];
    const { panelHandlers } = mountDropzone((file, sanitized) => uploaded.push([file.name, sanitized]));
    const fileA = { name: 'log (1).txt' };
    const fileB = { name: 'clip.png' };
    panelHandlers.paste[0]({ clipboardData: { files: [fileA, fileB] } });
    assert.deepEqual(uploaded, [['log (1).txt', 'log-1.txt'], ['clip.png', 'clip.png']]);
  });

  it('paste also reads clipboardData.items when .files is empty (the items.kind === "file" form)', () => {
    const uploaded = [];
    const { panelHandlers } = mountDropzone((file, sanitized) => uploaded.push([file.name, sanitized]));
    const fileItem = { kind: 'file', getAsFile: () => ({ name: 'pasted.png' }) };
    const textItem = { kind: 'string', getAsFile: () => null };
    panelHandlers.paste[0]({ clipboardData: { files: [], items: [textItem, fileItem] } });
    assert.deepEqual(uploaded, [['pasted.png', 'pasted.png']], 'only the file-kind item is delivered, the string item is not');
  });

  it('a drag leaving the panel/overlay itself hides the overlay; crossing a child inside it does not', () => {
    const { overlay, docHandlers, panelHandlers } = mountDropzone();
    docHandlers.dragenter[0]({ dataTransfer: { types: ['Files'] } });
    assert.equal(overlay.classList.contains('hidden'), false);
    panelHandlers.dragleave[0]({ target: { id: 'some-unrelated-child' } });
    assert.equal(overlay.classList.contains('hidden'), false, 'leaving a child the drag merely crosses must not hide it');
    panelHandlers.dragleave[0]({ target: overlay });
    assert.equal(overlay.classList.contains('hidden'), true, 'leaving the overlay itself hides it');
  });

  it('returns a destroy() that does not throw even against a DOM with no removeEventListener', () => {
    const { bind } = mountDropzone();
    assert.doesNotThrow(() => bind.destroy());
  });

  it('does nothing and never throws when doc/panelEl/onUpload are missing', () => {
    assert.doesNotThrow(() => G.tcBindMasterDropzone({}));
    assert.doesNotThrow(() => G.tcBindMasterDropzone({ doc: makeDocument([]).doc }));
  });
});
