'use strict';

/*
 * The dashboard's notice that a launch-isolation override is on (#2393).
 *
 * The functions are RUN here, lifted out of the shipped files, for the reason
 * `test/launch-isolation-override-ui.test.js` states: a source match cannot see
 * an undeclared identifier, and these render on the live install the moment
 * the file is saved.
 *
 * What the assertions hold is what the notice's design rests on. It shows only
 * what the server answered: a refused read hides it and says nothing either
 * way, a failed read says it failed, and an older read can never repaint over
 * a newer one. Names reach the page as text, never as markup, and each
 * override leads to its own switch through the existing Settings navigation.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const LANDING_SRC = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

/**
 * Slice a top-level function out of source text by brace-matching, so the
 * sandbox runs the REAL code rather than a copy.
 * @param {string} src - File source text
 * @param {string} decl - Declaration to find
 * @returns {string} The declaration plus its balanced body
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
 * A document holding the notice's two elements, with the two node calls the
 * notice makes that the shared mini-DOM does not: `createTextNode` and
 * `replaceChildren`. Each behaves as a browser's does for what is asked of it.
 * @returns {{doc: object, banner: object, textEl: object}}
 */
function noticeDocument() {
  const { doc, ids } = makeDocument(['isolationOverrideBanner', 'isolationOverrideBannerText']);
  doc.createTextNode = (s) => {
    const node = doc.createElement('#text');
    node.textContent = String(s);
    return node;
  };
  const textEl = ids.isolationOverrideBannerText;
  textEl.replaceChildren = (...nodes) => {
    for (const child of [...textEl.childNodes]) child.remove();
    for (const node of nodes) textEl.appendChild(node);
  };
  const banner = ids.isolationOverrideBanner;
  banner.classList.add('hidden');
  return { doc, banner, textEl };
}

/**
 * A page `api()` that records each call and answers from a table, with
 * `create()` standing in for `window.tcCreateApi`: each instance it makes
 * keeps its own failure fields, as the factory's do, and logs into the same
 * `calls`.
 * @param {function(string, object=): {data: (object|null), error?: string, code?: string}} answer - What each call is told
 * @returns {Function} The `api`, with `calls` and `create`
 */
function fakeApi(answer) {
  const calls = [];
  const make = () => {
    const api = async (url, opts) => {
      calls.push({ url, method: (opts && opts.method) || 'GET' });
      const a = await answer(url, opts);
      api.lastError = a.error || null;
      api.lastErrorCode = a.code || null;
      return a.data;
    };
    api.lastError = null;
    api.lastErrorCode = null;
    return api;
  };
  const api = make();
  api.calls = calls;
  api.create = make;
  return api;
}

/**
 * Override settings as the routes answer them.
 * @param {boolean} install - Whether the install-wide override is on
 * @param {Array<[number, (string|null)]>} [projects] - `[id, name]` of each project whose own override is on
 * @returns {object}
 */
function settings(install, projects) {
  return {
    install: { allowed: install, setAt: install ? '2026-10-15T20:00:00.000Z' : null, setBy: null },
    projects: (projects || []).map(([projectId, projectName]) => ({
      projectId, projectName, allowed: true, setAt: '2026-10-15T20:00:00.000Z', setBy: 'op'
    }))
  };
}

/**
 * A sandbox holding the dashboard's own notice functions.
 * @param {object} [extra] - Globals the case supplies (`api`, `openGlobalSettings`, `openIsolationOverrideSettings`)
 * @returns {{ctx: object, banner: object, textEl: object, doc: object}}
 */
function sandbox(extra) {
  const { doc, banner, textEl } = noticeDocument();
  const given = extra || {};
  const ctx = {
    document: doc,
    setConnected: () => {},
    window: { tcCreateApi: () => (given.api ? given.api.create() : null) },
    ...given
  };
  vm.createContext(ctx);
  vm.runInContext('let isolationOverrideBannerRead = 0;', ctx);
  for (const decl of ['async function refreshIsolationOverrideBanner', 'function renderIsolationOverrideBanner',
    'function openInstallOverrideSettings']) {
    vm.runInContext(liftFunction(LANDING_SRC, decl), ctx);
  }
  return { ctx, banner, textEl, doc };
}

/** @returns {object[]} The notice's list items */
const rows = (textEl) => {
  const list = textEl.querySelector('ul');
  return list ? list.childNodes : [];
};

describe('The dashboard notice of a launch-isolation override: what it says (#2393)', () => {
  it('stays hidden, and empty, when no override is on', () => {
    const s = sandbox();
    s.ctx.renderIsolationOverrideBanner(settings(false), null);
    assert.equal(s.banner.classList.contains('hidden'), true);
    assert.equal(s.textEl.childNodes.length, 0);
  });

  it('names the install-wide override, and whom it covers', () => {
    const s = sandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    s.ctx.renderIsolationOverrideBanner(settings(true), null);
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.match(s.textEl.text, /A launch isolation override is on\./);
    assert.match(s.textEl.text, /may borrow another project's TangleClaw identity/);
    assert.equal(rows(s.textEl).length, 1);
    assert.match(rows(s.textEl)[0].text, /^every project on this install, and the Project Master/);
  });

  it('names each project whose own override is on, one row each', () => {
    const s = sandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    s.ctx.renderIsolationOverrideBanner(settings(false, [[7, 'alpha'], [9, 'beta']]), null);
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.deepEqual(rows(s.textEl).map((li) => li.childNodes[0].textContent), ['alpha', 'beta']);
  });

  it('names the install-wide override and the projects together', () => {
    const s = sandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    s.ctx.renderIsolationOverrideBanner(settings(true, [[7, 'alpha']]), null);
    assert.equal(rows(s.textEl).length, 2);
  });

  it('says it once the page reads one is on: the reproduction of #2393 ends with the project named', async () => {
    const api = fakeApi(() => ({ data: settings(false, [[7, 'alpha']]) }));
    const s = sandbox({ api, openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    assert.equal(await s.ctx.refreshIsolationOverrideBanner(), true);
    assert.deepEqual(api.calls, [{ url: '/api/launch/isolation-overrides', method: 'GET' }]);
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.equal(rows(s.textEl)[0].childNodes[0].textContent, 'alpha');
  });

  it('sets a name as text, never as markup', () => {
    const name = '<img src=x onerror="alert(1)">&amp;';
    const s = sandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    s.ctx.renderIsolationOverrideBanner(settings(false, [[7, name]]), null);
    const li = rows(s.textEl)[0];
    assert.equal(li.childNodes[0].tagName, '#TEXT');
    assert.equal(li.childNodes[0].textContent, name);
    assert.equal(s.textEl.innerHTML, '', 'nothing is written through innerHTML');
    assert.equal(li.innerHTML, '');
  });

  it('names a project the install no longer has by its id, with no way to a Settings that cannot open', () => {
    const s = sandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    s.ctx.renderIsolationOverrideBanner(settings(false, [[12, null]]), null);
    const li = rows(s.textEl)[0];
    assert.match(li.text, /the project with id 12, which this install no longer names/);
    assert.equal(li.querySelector('button'), null);
  });

  it('ignores a row that does not read on', () => {
    const s = sandbox();
    const answer = settings(false, [[7, 'alpha']]);
    answer.projects[0].allowed = false;
    s.ctx.renderIsolationOverrideBanner(answer, null);
    assert.equal(s.banner.classList.contains('hidden'), true);
  });
});

describe('The dashboard notice: a read that did not answer the overrides (#2393)', () => {
  it('hides when the server refuses the read, and does not say none is on', () => {
    const s = sandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    s.ctx.renderIsolationOverrideBanner(settings(false, [[7, 'alpha']]), null);
    s.ctx.renderIsolationOverrideBanner(null, { error: 'Only the operator can read the launch-isolation overrides.', code: 'OPERATOR_ONLY' });
    assert.equal(s.banner.classList.contains('hidden'), true);
    assert.equal(s.textEl.childNodes.length, 0, 'the names the earlier read put up are taken down');
    assert.doesNotMatch(s.textEl.text, /none|no override|off/i);
  });

  it('says the read failed, with the reason, when the server did not answer', () => {
    const s = sandbox();
    s.ctx.renderIsolationOverrideBanner(null, { error: 'Connection lost.', code: null });
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.equal(s.banner.classList.contains('isolation-override-banner-unread'), true);
    assert.match(s.textEl.text, /^The launch isolation overrides could not be read \(Connection lost\.\), so this page does not say whether one is on\./);
  });

  it('says the read failed when the server refused it for any reason but the operator-only one', () => {
    const s = sandbox();
    s.ctx.renderIsolationOverrideBanner(null, { error: 'The launch-isolation overrides could not be read just now.', code: 'INTERNAL_ERROR' });
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.match(s.textEl.text, /could not be read \(The launch-isolation overrides could not be read just now\.\)/);
  });

  it('says the read failed when the server answered without the settings', () => {
    const s = sandbox();
    s.ctx.renderIsolationOverrideBanner({ ok: true }, { error: null, code: null });
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.match(s.textEl.text, /could not be read: the server answered without them, so this page does not say/);
  });

  it('drops the failure tone once a later read answers', () => {
    const s = sandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    s.ctx.renderIsolationOverrideBanner(null, { error: 'Connection lost.', code: null });
    s.ctx.renderIsolationOverrideBanner(settings(true), null);
    assert.equal(s.banner.classList.contains('isolation-override-banner-unread'), false);
    assert.equal(s.banner.classList.contains('hidden'), false);
  });

  it('takes a failure line down once a later read answers that none is on', () => {
    const s = sandbox();
    s.ctx.renderIsolationOverrideBanner(null, { error: 'Connection lost.', code: null });
    s.ctx.renderIsolationOverrideBanner(settings(false), null);
    assert.equal(s.banner.classList.contains('hidden'), true);
    assert.equal(s.textEl.childNodes.length, 0);
  });
});

describe('The dashboard notice: overlapping reads, latest wins (#2393)', () => {
  /**
   * A page `api()` whose answers the case releases one at a time, in any order.
   * @returns {{api: Function, release: function(number, object): void}}
   */
  function heldApi() {
    const held = [];
    const api = fakeApi(() => new Promise((resolve) => held.push(resolve)));
    return { api, release: (i, answer) => held[i](answer) };
  }

  it('an older read answering last does not overwrite the newer one', async () => {
    const { api, release } = heldApi();
    const s = sandbox({ api, openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    const older = s.ctx.refreshIsolationOverrideBanner();
    const newer = s.ctx.refreshIsolationOverrideBanner();
    release(1, { data: settings(false) });
    assert.equal(await newer, true);
    release(0, { data: settings(false, [[7, 'alpha']]) });
    assert.equal(await older, false, 'the older answer is dropped');
    assert.equal(s.banner.classList.contains('hidden'), true, 'the newer read said none is on, and that stands');
    assert.equal(s.textEl.childNodes.length, 0);
  });

  it('an older read answering last does not put back names a newer refusal took down', async () => {
    const { api, release } = heldApi();
    const s = sandbox({ api, openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    const older = s.ctx.refreshIsolationOverrideBanner();
    const newer = s.ctx.refreshIsolationOverrideBanner();
    release(1, { data: null, error: 'Only the operator can read the launch-isolation overrides.', code: 'OPERATOR_ONLY' });
    await newer;
    release(0, { data: settings(true, [[7, 'alpha']]) });
    await older;
    assert.equal(s.banner.classList.contains('hidden'), true);
    assert.doesNotMatch(s.textEl.text, /alpha/);
  });

  it('a newer read answering last paints over an older one', async () => {
    const { api, release } = heldApi();
    const s = sandbox({ api, openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    const older = s.ctx.refreshIsolationOverrideBanner();
    const newer = s.ctx.refreshIsolationOverrideBanner();
    release(0, { data: settings(false) });
    assert.equal(await older, false);
    release(1, { data: settings(false, [[7, 'alpha']]) });
    assert.equal(await newer, true);
    assert.equal(rows(s.textEl)[0].childNodes[0].textContent, 'alpha');
  });
});

describe('The dashboard notice: its failure is its own, whatever else the page is reading (#2393)', () => {
  const loadApiHelperGlobals = require('./_api-helper-globals');

  /**
   * The real `public/api-helper.js`, over a `fetch` that holds every response
   * until the case lets them all go at once, in the order the requests were
   * made. Both answers are then ready together, so the later request's `api()`
   * finishes, and writes its failure fields, before the earlier request's
   * caller resumes: the window in which the page's one `api()` is overwritten.
   * @param {object} answers - `{<url>: {status, body}}`
   * @returns {{helper: object, release: function(): void, seen: Array<object>}}
   */
  function heldHelper(answers) {
    const helper = loadApiHelperGlobals();
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const seen = [];
    helper.fetch = (url, opts) => {
      const headers = (opts && opts.headers) || {};
      seen.push({ url: String(url), client: headers['X-TangleClaw-Client'] || null });
      const a = answers[String(url)];
      const response = {
        status: a.status,
        ok: a.status >= 200 && a.status < 300,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => a.body,
        clone() { return response; }
      };
      return gate.then(() => response);
    };
    return { helper, release: () => open(), seen };
  }

  /**
   * The notice's functions, given the real factory, beside a page `api()`
   * from the same factory that the unrelated request goes through.
   * @param {object} helper - From {@link heldHelper}
   * @returns {object} The sandbox, with `pageApi`
   */
  function pageWith(helper) {
    const s = sandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    s.ctx.window = { tcCreateApi: helper.tcCreateApi };
    s.pageApi = helper.tcCreateApi({});
    s.ctx.api = s.pageApi;
    return s;
  }

  const REFUSED = { status: 403, body: { error: 'Only the operator can read the launch-isolation overrides.', code: 'OPERATOR_ONLY' } };
  const FAILED = { status: 500, body: { error: 'The launch-isolation overrides could not be read just now.', code: 'INTERNAL_ERROR' } };

  it('a refusal still hides, and takes the names down, when an unrelated read fails meanwhile', async () => {
    const h = heldHelper({ '/api/launch/isolation-overrides': REFUSED, '/api/stats': { status: 500, body: { error: 'stats broke', code: 'INTERNAL_ERROR' } } });
    const s = pageWith(h.helper);
    s.ctx.renderIsolationOverrideBanner(settings(true, [[7, 'alpha']]), null);
    const notice = s.ctx.refreshIsolationOverrideBanner();
    const other = s.pageApi('/api/stats');
    h.release();
    await Promise.all([notice, other]);
    assert.equal(s.pageApi.lastErrorCode, 'INTERNAL_ERROR', 'the page\'s shared slot holds the unrelated failure');
    assert.equal(s.banner.classList.contains('hidden'), true);
    assert.equal(s.textEl.childNodes.length, 0);
  });

  it('a refusal still hides when an unrelated read succeeds meanwhile and clears the shared slot', async () => {
    const h = heldHelper({ '/api/launch/isolation-overrides': REFUSED, '/api/stats': { status: 200, body: { ok: true } } });
    const s = pageWith(h.helper);
    s.ctx.renderIsolationOverrideBanner(settings(false, [[7, 'alpha']]), null);
    const notice = s.ctx.refreshIsolationOverrideBanner();
    const other = s.pageApi('/api/stats');
    h.release();
    await Promise.all([notice, other]);
    assert.equal(s.pageApi.lastErrorCode, null, 'the page\'s shared slot was cleared');
    assert.equal(s.banner.classList.contains('hidden'), true);
    assert.doesNotMatch(s.textEl.text, /alpha|could not be read/);
  });

  it('a genuine failure still shows when another overrides read is refused meanwhile', async () => {
    const h = heldHelper({ '/api/launch/isolation-overrides': FAILED, '/api/other-overrides-read': REFUSED });
    const s = pageWith(h.helper);
    const notice = s.ctx.refreshIsolationOverrideBanner();
    const other = s.pageApi('/api/other-overrides-read');
    h.release();
    await Promise.all([notice, other]);
    assert.equal(s.pageApi.lastErrorCode, 'OPERATOR_ONLY', 'the page\'s shared slot holds someone else\'s refusal');
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.match(s.textEl.text, /could not be read \(The launch-isolation overrides could not be read just now\.\)/);
  });

  it('goes out with the dashboard marker, through the same factory as the page', async () => {
    const h = heldHelper({ '/api/launch/isolation-overrides': { status: 200, body: settings(false) } });
    const s = pageWith(h.helper);
    const notice = s.ctx.refreshIsolationOverrideBanner();
    h.release();
    await notice;
    assert.deepEqual(h.seen.map((x) => ({ ...x })), [{ url: '/api/launch/isolation-overrides', client: 'dashboard' }]);
  });
});

describe('The dashboard notice leads to each override\'s switch (#2393)', () => {
  it('opens a project\'s Settings at its override, through the existing pointer', () => {
    const opened = [];
    const s = sandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: (name) => opened.push(name) });
    s.ctx.renderIsolationOverrideBanner(settings(false, [[7, 'alpha'], [9, 'beta']]), null);
    const btn = rows(s.textEl)[1].querySelector('button');
    assert.equal(btn.type, 'button');
    assert.equal(btn.textContent, 'Settings');
    assert.equal(btn.getAttribute('aria-label'), 'Open beta\'s Settings at its launch isolation override');
    btn.dispatch('click');
    assert.deepEqual(opened, ['beta']);
  });

  it('opens Global Settings at the install-wide override', () => {
    let opened = 0;
    let scrolled = null;
    const s = sandbox({ openGlobalSettings: () => { opened++; }, openIsolationOverrideSettings: () => {} });
    const section = s.doc.createElement('div');
    section.id = 'gsIsolationOverrideSection';
    section.scrollIntoView = (opts) => { scrolled = opts; };
    s.doc._register(section);
    s.ctx.renderIsolationOverrideBanner(settings(true), null);
    const btn = rows(s.textEl)[0].querySelector('button');
    assert.equal(btn.textContent, 'Global Settings');
    btn.dispatch('click');
    assert.equal(opened, 1);
    assert.equal(scrolled && scrolled.block, 'center');
    assert.equal(s.doc.activeElement, section, 'the focus starts at the override, not at the top of Global Settings');
    assert.equal(section.getAttribute('tabindex'), '-1');
  });

  it('offers no button on a page that has no Settings to open', () => {
    const s = sandbox();
    s.ctx.renderIsolationOverrideBanner(settings(true, [[7, 'alpha']]), null);
    assert.equal(rows(s.textEl).length, 2);
    assert.ok(rows(s.textEl).every((li) => li.querySelector('button') === null));
  });
});

describe('The dashboard notice and the switches, run together (#2393)', () => {
  /**
   * One sandbox holding the switch's wiring from `ui.js` and the notice from
   * `landing.js`, over a server whose overrides the writes change.
   * @param {boolean} answer - What `confirm()` answers
   * @returns {object}
   */
  function page(answer) {
    const on = new Set();
    const api = fakeApi((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/auth/me') return { data: { authenticated: true, gateActive: true, openInstallToken: null } };
      if (method === 'PUT') on.add(7);
      if (method === 'DELETE') on.delete(7);
      return { data: settings(false, [...on].map((id) => [id, 'alpha'])) };
    });
    const asked = [];
    const s = sandbox({
      api,
      confirm: (text) => { asked.push(text); return answer; },
      state: { projects: [{ id: 7, name: 'alpha' }] },
      openGlobalSettings: () => {},
      openIsolationOverrideSettings: () => {},
      esc: (v) => String(v)
    });
    vm.runInContext('let isolationOverrideNotice = null; let projectRulesTargetId = 7;', s.ctx);
    for (const decl of ['function recoveryModeControlOffer', 'function isolationOverrideRiskText',
      'function isolationOverrideStands', 'function isolationOverrideHtml', 'function isolationOverrideOutcome',
      'function isolationOverrideConfirmText', 'async function refreshIsolationOverride', 'function wireIsolationOverride']) {
      vm.runInContext(liftFunction(UI_SRC, decl), s.ctx);
    }
    return { ...s, api, asked };
  }

  /**
   * A project switch's container, re-made on each render as `innerHTML` does.
   * @param {boolean} checked - What the person just set the switch to
   * @returns {{box: object, input: object, change: function(): Promise}}
   */
  function switchBox(checked) {
    const listeners = [];
    const input = { checked, disabled: false, addEventListener: (type, fn) => { if (type === 'change') listeners.push(fn); } };
    let raw = '';
    const box = {
      get innerHTML() { return raw; },
      set innerHTML(v) { raw = String(v); },
      querySelectorAll: () => [input],
      querySelector: () => null
    };
    return { box, input, change: () => Promise.all(listeners.map((fn) => fn())) };
  }

  it('turning a project\'s override on puts the notice up; turning it off takes it down', async () => {
    const p = page(true);
    const turnOn = switchBox(true);
    p.ctx.wireIsolationOverride(turnOn.box, 'project', 7);
    await turnOn.change();
    assert.equal(p.asked.length, 1);
    assert.equal(p.banner.classList.contains('hidden'), false);
    assert.equal(rows(p.textEl)[0].childNodes[0].textContent, 'alpha');

    const turnOff = switchBox(false);
    p.ctx.wireIsolationOverride(turnOff.box, 'project', 7);
    await turnOff.change();
    assert.equal(p.asked.length, 1, 'turning it off asked nothing');
    assert.equal(p.banner.classList.contains('hidden'), true);
  });

  it('a Cancel sends nothing, the notice read included', async () => {
    const p = page(false);
    const sw = switchBox(true);
    p.ctx.wireIsolationOverride(sw.box, 'project', 7);
    await sw.change();
    assert.deepEqual(p.api.calls, []);
    assert.equal(sw.input.checked, false);
    assert.equal(p.banner.classList.contains('hidden'), true);
  });
});

describe('The dashboard notice is on the main view and read at load (#2393)', () => {
  it('the main view holds the notice\'s slot, hidden until a read paints it, as a status', () => {
    assert.match(INDEX_SRC, /<div id="isolationOverrideBanner" class="orphan-banner isolation-override-banner hidden" role="status">\s*<span class="orphan-banner-text" id="isolationOverrideBannerText"><\/span>/);
  });

  it('the dashboard reads the overrides once at load, beside the other first reads', () => {
    const init = LANDING_SRC.slice(LANDING_SRC.indexOf('await Promise.all([loadStats()'));
    const first = init.slice(0, init.indexOf(']);'));
    assert.match(first, /refreshIsolationOverrideBanner\(\)/);
  });

  it('only the read route is asked: the notice never writes an override', () => {
    const body = liftFunction(LANDING_SRC, 'async function refreshIsolationOverrideBanner')
      + liftFunction(LANDING_SRC, 'function renderIsolationOverrideBanner');
    assert.deepEqual(body.match(/\/api\/[\w/-]+/g), ['/api/launch/isolation-overrides']);
    assert.doesNotMatch(body, /innerHTML/);
    assert.match(body, /const once = window\.tcCreateApi\(\{ setConnected \}\);/, 'the read has an api() of its own, from the page\'s factory');
    assert.doesNotMatch(body, /\bapi\.last/, 'the page\'s shared failure fields are never read');
  });
});

/*
 * The landing page's notice that no login is in force (#2378). It lives beside
 * the isolation notice and is tested the same way: the shipped functions are
 * lifted and run. Its signal is the gate state the 60-second server-info poll
 * already carries, and it is drawn from inside `renderAuthStatus`, so the poll
 * itself is unchanged and every test that stubs that render by name still
 * holds.
 */

const { AUTH_STATUSES } = require('../lib/auth-identity');

/** The notice's exact copy, as the Architect set it. */
const NO_LOGIN_TEXT = 'No login is in force on this install. TangleClaw is not requiring a sign-in credential '
  + 'here: open-mode operator actions on this page rely on request shape rather than a login, while actions that '
  + 'grant or widen authority over sessions (approving session rules, changing the global rules, granting '
  + 'coordinator roles, releasing a HOLD, choosing a project\'s recovery mode, changing the startup prompt, and '
  + 'the others listed in the docs) are refused until a login is enabled and you are signed in.';

/**
 * A sandbox holding the login chip, the no-login notice and the isolation
 * notice, with the shipped render functions for all three.
 * @param {object} [extra] - Globals the case supplies (`openGlobalSettings`)
 * @returns {{ctx: object, doc: object, banner: object, textEl: object, btn: object, chip: object, iso: object}}
 */
function noLoginSandbox(extra) {
  const { doc, ids } = makeDocument(['authStatusWarning', 'noLoginBanner', 'noLoginBannerText',
    'isolationOverrideBanner', 'isolationOverrideBannerText']);
  doc.createTextNode = (s) => {
    const node = doc.createElement('#text');
    node.textContent = String(s);
    return node;
  };
  for (const id of ['noLoginBannerText', 'isolationOverrideBannerText']) {
    const el = ids[id];
    el.replaceChildren = (...nodes) => {
      for (const child of [...el.childNodes]) child.remove();
      for (const node of nodes) el.appendChild(node);
    };
  }
  const btn = doc.createElement('button');
  btn.id = 'noLoginBannerBtn';
  btn.type = 'button';
  btn.textContent = 'Add a login';
  ids.noLoginBanner.appendChild(btn);
  doc._register(btn);
  for (const id of ['authStatusWarning', 'noLoginBanner', 'isolationOverrideBanner']) ids[id].classList.add('hidden');
  const ctx = { document: doc, ...(extra || {}) };
  vm.createContext(ctx);
  // A top-level const is not a property of the context, so the copy is
  // re-exposed for the assertions that read it back.
  vm.runInContext(`${liftFunction(LANDING_SRC, 'const NO_LOGIN_NOTICE =')};\nthis.NO_LOGIN_NOTICE = NO_LOGIN_NOTICE;`, ctx);
  for (const decl of ['function _authStatusWarning', 'function renderAuthStatus', 'function renderNoLoginBanner',
    'function openAddLoginSettings', 'function renderIsolationOverrideBanner', 'function openInstallOverrideSettings']) {
    vm.runInContext(liftFunction(LANDING_SRC, decl), ctx);
  }
  return { ctx, doc, banner: ids.noLoginBanner, textEl: ids.noLoginBannerText, btn, chip: ids.authStatusWarning,
    iso: ids.isolationOverrideBanner };
}

describe('The landing notice that no login is in force: when it shows (#2378)', () => {
  it('shows for an install with no login, with the exact copy', () => {
    const s = noLoginSandbox({ openGlobalSettings: () => {} });
    s.ctx.renderAuthStatus('open');
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.equal(s.textEl.text, NO_LOGIN_TEXT);
    const strong = s.textEl.querySelector('strong');
    assert.equal(strong.textContent, 'No login is in force on this install.', 'the first sentence leads, in bold');
  });

  it('hides for every other state the server can send, and for none', () => {
    const others = AUTH_STATUSES.filter((st) => st !== 'open');
    assert.ok(others.includes('armed') && others.includes('fallback'), 'the gate states this was written against');
    for (const status of [...others, undefined, null, '']) {
      const s = noLoginSandbox({ openGlobalSettings: () => {} });
      s.ctx.renderAuthStatus(status);
      assert.equal(s.banner.classList.contains('hidden'), true, String(status));
      assert.equal(s.textEl.childNodes.length, 0, String(status));
    }
  });

  it('follows the poll: up on open, down once a login is in force, up again if it goes', () => {
    const s = noLoginSandbox({ openGlobalSettings: () => {} });
    s.ctx.renderAuthStatus('open');
    assert.equal(s.banner.classList.contains('hidden'), false);
    s.ctx.renderAuthStatus('armed');
    assert.equal(s.banner.classList.contains('hidden'), true);
    assert.equal(s.textEl.text, '');
    s.ctx.renderAuthStatus('open');
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.equal(s.textEl.text, NO_LOGIN_TEXT, 'painted once, not appended to');
  });

  it('is not repainted by a poll that reads open again, so a screen reader does not re-announce it', () => {
    const s = noLoginSandbox({ openGlobalSettings: () => {} });
    s.ctx.renderAuthStatus('open');
    const painted = [...s.textEl.childNodes];
    s.ctx.renderAuthStatus('open');
    assert.equal(s.textEl.childNodes.length, painted.length);
    s.textEl.childNodes.forEach((node, i) => assert.equal(node, painted[i], 'the same nodes stay in place'));
    s.ctx.renderAuthStatus('armed');
    s.ctx.renderAuthStatus('open');
    assert.notEqual(s.textEl.childNodes[0], painted[0], 'painted afresh once it has been down');
    assert.equal(s.textEl.text, NO_LOGIN_TEXT);
  });

  it('leaves the login chip silent for open, and its warnings as they were', () => {
    const s = noLoginSandbox({ openGlobalSettings: () => {} });
    s.ctx.renderAuthStatus('open');
    assert.equal(s.chip.classList.contains('hidden'), true);
    assert.equal(s.chip.textContent, '');
    s.ctx.renderAuthStatus('fallback');
    assert.equal(s.chip.classList.contains('hidden'), false);
    assert.match(s.chip.textContent, /gate-fallback\.js --undo/);
    assert.equal(s.banner.classList.contains('hidden'), true, 'fallback has a credential in front of the page');
  });

  it('sets its copy as text, never as markup', () => {
    const body = liftFunction(LANDING_SRC, 'function renderNoLoginBanner')
      + liftFunction(LANDING_SRC, 'function openAddLoginSettings');
    assert.doesNotMatch(body, /innerHTML/);
    assert.doesNotMatch(body, /setTimeout|setInterval/, 'no timer: it ends when a login is added');
    assert.equal(liftFunction(LANDING_SRC, 'const NO_LOGIN_NOTICE =').includes('<'), false);
    const s = noLoginSandbox({ openGlobalSettings: () => {} });
    assert.equal(s.ctx.NO_LOGIN_NOTICE.lead + s.ctx.NO_LOGIN_NOTICE.body, NO_LOGIN_TEXT);
  });

  it('is drawn from the login render, so the poll is unchanged', () => {
    assert.match(liftFunction(LANDING_SRC, 'function renderAuthStatus'), /renderNoLoginBanner\(authStatus\);/);
    assert.doesNotMatch(liftFunction(LANDING_SRC, 'async function loadServerInfo'), /renderNoLoginBanner/);
  });
});

describe('The landing notice that no login is in force: its way through (#2378)', () => {
  it('opens Global Settings at "Your account", with the focus there', () => {
    let opened = 0;
    let scrolled = null;
    const s = noLoginSandbox({ openGlobalSettings: () => { opened++; } });
    const section = s.doc.createElement('div');
    section.id = 'gsAccountSection';
    section.scrollIntoView = (opts) => { scrolled = opts; };
    s.doc._register(section);
    s.ctx.renderAuthStatus('open');
    assert.equal(s.btn.classList.contains('hidden'), false);
    assert.equal(s.btn.dispatch('click'), true);
    assert.equal(opened, 1);
    assert.equal(scrolled && scrolled.block, 'center');
    assert.equal(s.doc.activeElement, section, 'the focus starts at the account, not at the top of Global Settings');
    assert.equal(section.getAttribute('tabindex'), '-1');
  });

  it('wires the button once, however many polls paint the notice', () => {
    let opened = 0;
    const s = noLoginSandbox({ openGlobalSettings: () => { opened++; } });
    for (let i = 0; i < 3; i++) s.ctx.renderAuthStatus('open');
    s.btn.dispatch('click');
    assert.equal(opened, 1);
  });

  it('offers no button on a page that has no Global Settings to open', () => {
    const s = noLoginSandbox();
    s.ctx.renderAuthStatus('open');
    assert.equal(s.banner.classList.contains('hidden'), false, 'the notice still says it');
    assert.equal(s.btn.classList.contains('hidden'), true);
    assert.equal(s.btn.dispatch('click'), false);
  });

  it('shows together with the isolation notice, each in its own slot', () => {
    const s = noLoginSandbox({ openGlobalSettings: () => {}, openIsolationOverrideSettings: () => {} });
    s.ctx.renderIsolationOverrideBanner(settings(true), null);
    s.ctx.renderAuthStatus('open');
    assert.equal(s.iso.classList.contains('hidden'), false);
    assert.equal(s.banner.classList.contains('hidden'), false);
    assert.match(s.ctx.document.getElementById('isolationOverrideBannerText').text, /A launch isolation override is on\./);
    assert.equal(s.textEl.text, NO_LOGIN_TEXT);
  });
});

describe('The landing notice that no login is in force: on the main view (#2378)', () => {
  it('holds the notice\'s slot, hidden until a poll reads open, as a status, with its button', () => {
    assert.match(INDEX_SRC, /<div id="noLoginBanner" class="orphan-banner no-login-banner hidden" role="status">\s*<span class="orphan-banner-text" id="noLoginBannerText"><\/span>\s*<button type="button" class="orphan-banner-details no-login-banner-open" id="noLoginBannerBtn">Add a login<\/button>\s*<\/div>/);
  });

  it('sits after the isolation notice and before the recovery-code notice', () => {
    const iso = INDEX_SRC.indexOf('id="isolationOverrideBanner"');
    const notice = INDEX_SRC.indexOf('id="noLoginBanner"');
    const recovery = INDEX_SRC.indexOf('id="recoveryNoticeBanner"');
    assert.ok(iso !== -1 && notice !== -1 && recovery !== -1);
    assert.ok(iso < notice && notice < recovery);
  });
});
