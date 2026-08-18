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

/**
 * A declaration plus its balanced body — a function, or a factory call's
 * argument object.
 *
 * Brace-matched, never a fixed-size window or a cut to the next `\n}\n`. Both
 * cheaper forms were tried in this file and both landed in the WRONG REGION: the
 * newline cut matched the close of a shorter function two definitions earlier,
 * and a 900-character window anchored on a bare identifier started at a COMMENT
 * mentioning it, 300 characters before the call. Neither failed loudly — each
 * asserted confidently about text nobody meant, one reporting a present thing as
 * missing.
 *
 * @param {string} decl - Declaration or call text to find.
 * @param {string} src - Source to slice from.
 * @returns {string} The declaration plus its balanced body.
 */
function lift(decl, src) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return assert.fail(`${decl} body must close`);
}

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
    // `Access` left this list in #755 chunk 3 — its toggle has a backend now, so
    // it is a live control rather than an absence needing a reason. Removing it
    // here is not weakening the guard: the rule is about controls with NO route,
    // and a reason rendered beside a working control is its own falsehood.
    for (const key of ['Upload', 'Wrap', 'Kill', 'Medusa']) {
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
    // `access` is GONE (#755 chunk 3) and its absence is the assertion: a
    // control that works must not still carry an explanation for why it cannot.
    // This list shrinking is how a shipped backend is proved to have taken the
    // pending treatment WITH it, rather than beside it.
    assert.deepEqual(Object.keys(G.tcMasterPendingReasons).sort(),
      ['kill', 'medusa', 'upload', 'wrap']);
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
    guardDegradedReason: null
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

  it('a degraded guard is stated in words, on its own line (R-15)', () => {
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
      const block = lift('window.tcCreateMasterControlBar({', src);
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
    const poll = lift('async function pollStatus', SESSION_JS);
    assert.match(poll, /masterBar\.loadAccess\(\)/,
      'the polled read must refresh the Master access controls');
    assert.match(poll, /masterOpen/,
      'gated on the drawer being open — a closed drawer must not add a request per tick');

    const tick = lift('async function pollTick', SESSION_JS);
    assert.match(tick, /pollStatus\(\)/, 'and the scheduled tick must reach it');
    assert.match(lift('function startPolling', SESSION_JS), /pollTick\(\)/,
      'and the chain that schedules it must be the page\'s existing one');
  });

  it('neither surface grew a timer of its own for the Master level', () => {
    // Decision C. The dashboard has no clock and is not getting one; the
    // residual (a panel left open showing a stale segment) cannot be ACTED on,
    // because the bar re-fetches before every flip.
    //
    // THE MUTATION THIS CATCHES: reaching for setInterval on the dashboard to
    // close the cosmetic half — the reflex this decision exists to refuse.
    const dot = lift('async function refreshMasterDot', UI);
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
      const block = lift('window.tcCreateMasterSettings({', src);
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
