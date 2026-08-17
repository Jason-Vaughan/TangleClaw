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

const loadApiHelperGlobals = require('./_api-helper-globals');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const INDEX = read('index.html');
const SESSION_HTML = read('session.html');
const UI = read('ui.js');
const SESSION_JS = read('session.js');
const SW = read('sw.js');

const G = loadApiHelperGlobals();

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
  const bar = G.tcMasterControlBarMarkup('masterPanel', {});

  it('every pending control is disabled and carries its reason', () => {
    // The rule from #755/#741: never present-and-inert. A disabled control that
    // states why is the honest middle — the operator sees the bar's final shape
    // without being able to press something that would do nothing.
    for (const key of ['Upload', 'Wrap', 'Kill']) {
      const m = new RegExp(`<button[^>]*id="masterPanel${key}Btn"[^>]*>`).exec(bar);
      assert.ok(m, `${key} must render`);
      // A STANDALONE attribute, not `\bdisabled\b` — that also matches inside
      // `aria-disabled="true"`, so the first version of this guard stayed green
      // when the real `disabled` was removed. It asserted nothing.
      assert.match(m[0], /\sdisabled(?=[\s>])/, `${key} must not be pressable`);
      assert.match(m[0], /aria-disabled="true"/, `${key} must say so to assistive tech`);
      assert.match(m[0], /title="[^"]{10,}"/, `${key} must carry its reason`);
    }
  });

  it('the reason is reachable without hover', () => {
    // A `title` is invisible on touch, and this install is driven from a phone.
    // Each pending control points at a description element carrying the same
    // text, so the reason survives a device with no pointer.
    for (const key of ['Upload', 'Wrap', 'Kill', 'Medusa', 'Access']) {
      assert.match(bar, new RegExp(`aria-describedby="masterPanel${key}Why"`),
        `${key} must reference a description`);
      assert.match(bar, new RegExp(`id="masterPanel${key}Why"`),
        `${key}'s description element must exist`);
    }
  });

  it('the reasons are one table, not one per surface', () => {
    // Two surfaces giving different reasons for the same absence reads as one of
    // them being wrong.
    const panel = G.tcMasterControlBarMarkup('masterPanel', {});
    const drawer = G.tcMasterControlBarMarkup('masterDrawer', {});
    for (const reason of Object.values(G.tcMasterPendingReasons)) {
      assert.ok(panel.includes(reason) && drawer.includes(reason),
        `both surfaces must state: ${reason}`);
    }
  });

  it('names a reason for each control that has no route', () => {
    assert.deepEqual(Object.keys(G.tcMasterPendingReasons).sort(),
      ['access', 'kill', 'medusa', 'upload', 'wrap']);
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

  it('paints the model pill from a real fetch, and both pages ask for one', () => {
    // THE BLOCKING DEFECT THIS CATCHES: `setModel` existed with no production
    // caller, so the pill was permanently hidden while the plan, CHANGELOG and
    // FEATURES all said it was one of only two working controls. A component
    // method nothing calls is not a feature.
    assert.match(UI, /masterBar\.loadModel\(/, 'the dashboard must load a model');
    assert.match(SESSION_JS, /masterBar\.loadModel\(/, 'the session page must too');
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
    // style.css, so it was unstyled on the session page — invisible to a guard
    // that only checked classes it already assumed were shared.
    const pageOwned = new Set(['btn', 'btn-small', 'hidden', 'sr-only', 'banner-btn',
      'btn-wrap', 'btn-kill', 'medusa-control', 'medusa-mark', 'medusa-head',
      'medusa-head--in', 'medusa-head--out', 'medusa-emblem', 'master-dot',
      'master-status-text']);
    const unstyled = [...emitted].filter((c) => !pageOwned.has(c)
      && !new RegExp(`\\.${c}(?![\\w-])`).test(css));
    assert.deepEqual(unstyled, [],
      'emitted by the bar but styled nowhere both pages can see');
    // And the classes deferred to the shared sheet above must really be there —
    // otherwise the allow-list becomes a way to hide the same defect.
    const sharedCss = css;
    for (const c of ['banner-btn', 'btn-wrap', 'medusa-control']) {
      assert.match(sharedCss, new RegExp(`\\.${c}(?![\\w-])`),
        `${c} is on the allow-list because it is SHARED — it must live in the shared sheet`);
    }
  });
});
