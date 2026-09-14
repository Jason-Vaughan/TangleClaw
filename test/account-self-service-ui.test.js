'use strict';

/*
 * #1463 / #1457 — the dashboard's sign-out and account controls, tested by
 * RUNNING the render code against a DOM stub (the `recovery-codes-ui.test.js`
 * pattern): the shared sign-out helper, the header button, the session page's
 * Account group, and global settings → Your account.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const loadApiHelperGlobals = require('./_api-helper-globals');

const PUBLIC = path.join(__dirname, '..', 'public');
const LANDING_SRC = fs.readFileSync(path.join(PUBLIC, 'landing.js'), 'utf8');
const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
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

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * A minimal element.
 * @returns {object}
 */
function el() {
  const node = {
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    hidden: false,
    className: '',
    dataset: {},
    _hidden: true,
    _listeners: {},
    classList: {
      add(c) { if (c === 'hidden') node._hidden = true; },
      remove(c) { if (c === 'hidden') node._hidden = false; },
      toggle(c, force) { if (c === 'hidden') node._hidden = !!force; }
    },
    addEventListener(ev, fn) { (node._listeners[ev] = node._listeners[ev] || []).push(fn); },
    click: async () => { for (const fn of node._listeners.click || []) await fn(); }
  };
  return node;
}

/**
 * A fake `api()` that answers by URL and records what it was asked.
 * @param {object} answers - url → value (null means refused)
 * @returns {Function & { calls: Array, lastError: string|null }}
 */
function fakeApi(answers) {
  const fn = async (url, opts) => {
    fn.calls.push({ url, opts });
    const value = Object.prototype.hasOwnProperty.call(answers, url) ? answers[url] : null;
    fn.lastError = value === null ? 'Connection lost.' : null;
    return value;
  };
  fn.calls = [];
  fn.lastError = null;
  return fn;
}

describe('tcSignOut — one sign-out for every control', () => {
  function withLocation() {
    const helper = loadApiHelperGlobals();
    const visits = [];
    helper.location = { pathname: '/', replace: (to) => visits.push(to) };
    return { helper, visits };
  }

  it('posts the logout route through the page\'s api() — the CSRF path — and goes to /login', async () => {
    const { helper, visits } = withLocation();
    const api = fakeApi({ '/api/auth/logout': { ok: true } });
    assert.equal(await helper.tcSignOut(api), true);
    assert.deepEqual(api.calls.map((c) => [c.url, c.opts.method]), [['/api/auth/logout', 'POST']]);
    assert.deepEqual(visits, ['/login']);
  });

  it('signs out everywhere through its own route', async () => {
    const { helper, visits } = withLocation();
    const api = fakeApi({ '/api/auth/logout-everywhere': { ok: true, sessionsEnded: 2 } });
    assert.equal(await helper.tcSignOut(api, { everywhere: true }), true);
    assert.equal(api.calls[0].url, '/api/auth/logout-everywhere');
    assert.deepEqual(visits, ['/login']);
  });

  it('stays on the page when the server did not answer — a live session must not look ended', async () => {
    const { helper, visits } = withLocation();
    assert.equal(await helper.tcSignOut(fakeApi({})), false);
    assert.deepEqual(visits, []);
  });

  it('the logout request really carries the CSRF token through the real api()', async () => {
    const helper = loadApiHelperGlobals();
    helper.document = { cookie: 'tc_csrf=tok' };
    helper.location = { pathname: '/', replace() {} };
    const sent = [];
    helper.fetch = async (url, opts) => {
      sent.push(opts);
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
    };
    await helper.tcSignOut(helper.tcCreateApi());
    assert.equal(sent[0].headers['X-CSRF-Token'], 'tok');
  });
});

describe('the dashboard header: Sign out beside the chip (#1463)', () => {
  function render(user, api = fakeApi({ '/api/auth/logout': { ok: true } })) {
    const els = { authUser: el(), signOutBtn: el(), toast: el() };
    const visits = [];
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || null },
      esc: escHtml,
      api,
      tcSignOut: async (a) => {
        const res = await a('/api/auth/logout', { method: 'POST' });
        if (res) visits.push('/login');
        return !!res;
      }
    });
    vm.runInContext(`${extract(LANDING_SRC, 'renderAuthUser')}\nthis.renderAuthUser = renderAuthUser;`, ctx);
    ctx.renderAuthUser(user);
    return { els, ctx, visits, api };
  }

  it('shows with a signed-in user and hides without one', () => {
    assert.equal(render('rosie').els.signOutBtn._hidden, false);
    for (const nobody of [null, undefined, '']) {
      assert.equal(render(nobody).els.signOutBtn._hidden, true, String(nobody));
    }
  });

  it('wires one listener however often the poll re-renders', () => {
    const { els, ctx } = render('rosie');
    ctx.renderAuthUser('rosie');
    ctx.renderAuthUser(null);
    ctx.renderAuthUser('rosie');
    assert.equal(els.signOutBtn._listeners.click.length, 1);
  });

  it('signs out on click', async () => {
    const { els, visits } = render('rosie');
    await els.signOutBtn.click();
    assert.deepEqual(visits, ['/login']);
  });

  it('says why when the sign-out did not reach the server, and re-enables the button', async () => {
    const { els, visits } = render('rosie', fakeApi({}));
    await els.signOutBtn.click();
    assert.deepEqual(visits, []);
    assert.equal(els.signOutBtn.disabled, false);
    assert.match(els.toast.textContent, /Could not sign out: Connection lost\./);
  });
});

describe('the session page: Account group in settings (#1463)', () => {
  function load(me) {
    const els = { accountGroup: el(), accountSignedInAs: el(), signOutBtn: el(), signOutHint: el() };
    els.accountGroup.hidden = true;
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || null },
      api: fakeApi({ '/api/auth/me': me })
    });
    vm.runInContext(`${extract(SESSION_SRC, 'renderAccountGroup')}\nthis.renderAccountGroup = renderAccountGroup;`, ctx);
    return { els, ctx };
  }

  it('shows who is signed in, set as text', async () => {
    const { els, ctx } = load({ authenticated: true, username: '<b>rosie</b>' });
    await ctx.renderAccountGroup();
    assert.equal(els.accountGroup.hidden, false);
    assert.equal(els.accountSignedInAs.textContent, 'Signed in as <b>rosie</b>');
    assert.equal(els.accountSignedInAs.innerHTML, '', 'never through innerHTML');
  });

  it('stays hidden with no session, and when the question fails', async () => {
    for (const me of [{ authenticated: false, username: null }, null]) {
      const { els, ctx } = load(me);
      await ctx.renderAccountGroup();
      assert.equal(els.accountGroup.hidden, true, JSON.stringify(me));
    }
  });

  it('asks each time the settings modal opens', () => {
    const open = extract(SESSION_SRC, 'openSettings');
    assert.match(open, /renderAccountGroup\(\)/);
  });

  it('wires the button to the session page\'s sign-out', () => {
    assert.match(SESSION_SRC, /\$\('signOutBtn'\)\.addEventListener\('click', signOutFromSession\)/);
    assert.match(extract(SESSION_SRC, 'signOutFromSession'),
      /signOutWith\(document\.getElementById\('signOutBtn'\), document\.getElementById\('signOutHint'\)\)/);
    assert.match(extract(SESSION_SRC, 'signOutWith'), /tcSignOut\(api\)/);
  });
});

describe('the session banner: signed-in user pill with Sign out (#1471)', () => {
  const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');

  /**
   * An element whose classList really tracks classes and whose attributes are
   * readable, for the popover's open state and aria-expanded.
   * @returns {object}
   */
  function node() {
    const classes = new Set();
    const attrs = {};
    return {
      textContent: '',
      innerHTML: '',
      disabled: false,
      hidden: false,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c)
      },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => (k in attrs ? attrs[k] : null)
    };
  }

  function load(answers) {
    const ids = ['bannerUserWrap', 'bannerUser', 'bannerUserName', 'bannerUserPop', 'bannerUserPopName',
      'bannerSignOutBtn', 'bannerSignOutHint', 'otherPop'];
    const els = Object.fromEntries(ids.map((id) => [id, node()]));
    els.bannerUserWrap.hidden = true;
    const visits = [];
    const api = fakeApi(answers);
    const ctx = vm.createContext({
      document: {
        getElementById: (id) => els[id] || null,
        querySelectorAll: () => [els.bannerUserPop, els.otherPop].filter((p) => p.classList.contains('open'))
      },
      api,
      tcSignOut: async (a) => {
        const res = await a('/api/auth/logout', { method: 'POST' });
        if (res) visits.push('/login');
        return !!res;
      }
    });
    const fns = ['closeBannerPopovers', 'syncBannerExpanded', 'loadBannerUser', 'toggleBannerUser',
      'signOutFromBanner', 'signOutWith'];
    vm.runInContext(`${fns.map((f) => extract(SESSION_SRC, f)).join('\n')}\n`
      + fns.map((f) => `this.${f} = ${f};`).join('\n'), ctx);
    return { els, ctx, api, visits };
  }

  it('shows who is signed in, as text in the pill and the popover', async () => {
    const { els, ctx } = load({ '/api/auth/me': { authenticated: true, username: '<b>rosie</b>' } });
    await ctx.loadBannerUser();
    assert.equal(els.bannerUserWrap.hidden, false);
    assert.equal(els.bannerUserName.textContent, '<b>rosie</b>');
    assert.equal(els.bannerUserPopName.textContent, '<b>rosie</b>');
    assert.equal(els.bannerUserName.innerHTML, '', 'never through innerHTML');
  });

  it('stays hidden with no session, and when the question fails', async () => {
    for (const me of [{ authenticated: false, username: null }, { authenticated: true, username: '' }, null]) {
      const { els, ctx } = load({ '/api/auth/me': me });
      await ctx.loadBannerUser();
      assert.equal(els.bannerUserWrap.hidden, true, JSON.stringify(me));
    }
  });

  it('keeps a shown pill when a later question fails — a blip must not take Sign out off the banner', async () => {
    const answers = { '/api/auth/me': { authenticated: true, username: 'rosie' } };
    const { els, ctx } = load(answers);
    await ctx.loadBannerUser();
    answers['/api/auth/me'] = null;
    ctx.toggleBannerUser();
    await new Promise((r) => setImmediate(r));
    assert.equal(els.bannerUserWrap.hidden, false);
    assert.equal(els.bannerUserName.textContent, 'rosie');
    assert.equal(els.bannerUserPop.classList.contains('open'), true);
  });

  it('opens and closes on the pill, keeping aria-expanded true to the popover', async () => {
    const { els, ctx } = load({ '/api/auth/me': { authenticated: true, username: 'rosie' } });
    await ctx.loadBannerUser();
    ctx.toggleBannerUser();
    assert.equal(els.bannerUserPop.classList.contains('open'), true);
    assert.equal(els.bannerUser.getAttribute('aria-expanded'), 'true');
    ctx.toggleBannerUser();
    assert.equal(els.bannerUserPop.classList.contains('open'), false);
    assert.equal(els.bannerUser.getAttribute('aria-expanded'), 'false');
  });

  it('is one popover among the banner\'s: opening it closes another, and an outside close resets aria-expanded', async () => {
    const { els, ctx } = load({ '/api/auth/me': { authenticated: true, username: 'rosie' } });
    els.otherPop.classList.add('open');
    ctx.toggleBannerUser();
    assert.equal(els.otherPop.classList.contains('open'), false);
    ctx.closeBannerPopovers();
    assert.equal(els.bannerUserPop.classList.contains('open'), false);
    assert.equal(els.bannerUser.getAttribute('aria-expanded'), 'false');
  });

  it('asks who is signed in again each time it opens, and hides if the session is gone', async () => {
    const answers = { '/api/auth/me': { authenticated: true, username: 'rosie' } };
    const { els, ctx, api } = load(answers);
    await ctx.loadBannerUser();
    answers['/api/auth/me'] = { authenticated: false, username: null };
    ctx.toggleBannerUser();
    await new Promise((r) => setImmediate(r));
    assert.equal(api.calls.filter((c) => c.url === '/api/auth/me').length, 2);
    assert.equal(els.bannerUserWrap.hidden, true);
    assert.equal(els.bannerUserPop.classList.contains('open'), false);
    assert.equal(els.bannerUser.getAttribute('aria-expanded'), 'false');
  });

  it('signs out through the shared helper and leaves for /login', async () => {
    const { ctx, api, visits } = load({ '/api/auth/logout': { ok: true } });
    await ctx.signOutFromBanner();
    assert.deepEqual(api.calls.map((c) => c.url), ['/api/auth/logout']);
    assert.deepEqual(visits, ['/login']);
  });

  it('says why in the popover when the sign-out did not reach the server, and re-enables the button', async () => {
    const { els, ctx, visits } = load({});
    await ctx.signOutFromBanner();
    assert.deepEqual(visits, []);
    assert.equal(els.bannerSignOutBtn.disabled, false);
    assert.equal(els.bannerSignOutHint.textContent, 'Could not sign out: Connection lost.');
  });

  it('clears an earlier failure when reopened', async () => {
    const { els, ctx } = load({ '/api/auth/me': { authenticated: true, username: 'rosie' } });
    els.bannerSignOutHint.textContent = 'Could not sign out: Connection lost.';
    ctx.toggleBannerUser();
    assert.equal(els.bannerSignOutHint.textContent, '');
  });

  it('is wired: loaded at startup, the pill toggles, the button signs out, and an inside click is not an outside one', () => {
    assert.match(extract(SESSION_SRC, 'initSession'), /bindEvents\(\);\s*\n(?:\s*\/\/.*\n)*\s*loadBannerUser\(\);/);
    assert.match(SESSION_SRC, /\$\('bannerUser'\)\.addEventListener\('click', toggleBannerUser\)/);
    assert.match(SESSION_SRC, /\$\('bannerSignOutBtn'\)\.addEventListener\('click', signOutFromBanner\)/);
    assert.match(extract(SESSION_SRC, 'onBannerOutsideClick'), /\.banner-user-wrap/);
  });

  it('on a phone the pill is the icon alone, the name visually hidden rather than removed from the accessible name', () => {
    const css = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');
    const phoneBlocks = [...css.matchAll(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    const rule = phoneBlocks.map((b) => b.match(/\.banner-user-name \{([^}]*)\}/)).find(Boolean);
    assert.ok(rule, 'a phone rule for the pill\'s name exists');
    assert.match(rule[1], /clip: rect\(0 0 0 0\)/);
    assert.match(rule[1], /position: absolute/);
    assert.doesNotMatch(rule[1], /display: none|visibility: hidden/, 'display:none would drop the name for screen readers');
  });

  it('markup: a real button pill, hidden until someone is signed in, with Sign out beside it rather than inside it', () => {
    const wrap = SESSION_HTML.match(/<span class="banner-user-wrap" id="bannerUserWrap"[^>]*>/);
    assert.ok(wrap, 'the wrapper exists');
    assert.match(wrap[0], /\shidden>/);
    assert.match(SESSION_HTML, /<button type="button" class="banner-user" id="bannerUser"[^>]*aria-expanded="false"[^>]*aria-controls="bannerUserPop"/);
    const pill = SESSION_HTML.slice(SESSION_HTML.indexOf('id="bannerUser"'));
    assert.ok(pill.indexOf('</button>') < pill.indexOf('id="bannerSignOutBtn"'), 'Sign out is not nested in the pill');
  });
});

describe('global settings → Your account (#1457, #1463)', () => {
  function load(answers) {
    const ids = ['gsAccountSection', 'gsPasswordCurrent', 'gsPasswordNew', 'gsPasswordChangeBtn',
      'gsPasswordHint', 'gsSignOutEverywhereBtn', 'gsSignOutEverywhereHint', 'gsAddLoginBtn', 'gsAddLoginHint'];
    const els = Object.fromEntries(ids.map((id) => [id, el()]));
    const api = fakeApi(answers);
    const mutations = [];
    const signOuts = [];
    const visits = [];
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || null },
      window: { location: { replace: (to) => visits.push(to) } },
      esc: escHtml,
      api,
      apiMutate: async (url, method, body) => {
        mutations.push({ url, method, body });
        return api(url, { method, body: JSON.stringify(body) });
      },
      tcSignOut: async (a, opts) => { signOuts.push(opts); return true; }
    });
    vm.runInContext(`${extract(UI_SRC, '_loadAccountSection')}\n${extract(UI_SRC, '_renderAddLogin')}\n`
      + 'this.load = _loadAccountSection;', ctx);
    return { els, ctx, api, mutations, signOuts, visits };
  }

  it('offers the forms to a signed-in account, naming it escaped', async () => {
    const { els, ctx } = load({ '/api/auth/me': { authenticated: true, username: '<i>rosie</i>' } });
    await ctx.load();
    const html = els.gsAccountSection.innerHTML;
    assert.match(html, /Signed in as <strong>&lt;i&gt;rosie&lt;\/i&gt;<\/strong>/);
    assert.match(html, /id="gsPasswordCurrent"[^>]*autocomplete="current-password"/);
    assert.match(html, /id="gsPasswordNew"[^>]*autocomplete="new-password"/);
    assert.match(html, /Sign out everywhere/);
  });

  it('says a login is not in use on an open install, and offers no form', async () => {
    const { els, ctx } = load({ '/api/auth/me': { authenticated: false, gateState: 'open' } });
    await ctx.load();
    assert.match(els.gsAccountSection.innerHTML, /does not require a login/);
    assert.doesNotMatch(els.gsAccountSection.innerHTML, /gsPasswordCurrent/);
  });

  describe('"Add a login" on an install with none (#803)', () => {
    it('is offered on an open install, with what no login means', async () => {
      const { els, ctx } = load({ '/api/auth/me': { authenticated: false, gateState: 'open' } });
      await ctx.load();
      const html = els.gsAccountSection.innerHTML;
      assert.match(html, /id="gsAddLoginBtn"/);
      assert.match(html, /Anyone who can reach this address can use TangleClaw/);
    });

    it('is not offered in any other signed-out state', async () => {
      for (const gateState of ['fallback', 'unreadable', undefined]) {
        const { els, ctx } = load({ '/api/auth/me': { authenticated: false, gateState } });
        await ctx.load();
        assert.doesNotMatch(els.gsAccountSection.innerHTML, /gsAddLoginBtn/, String(gateState));
      }
    });

    it('is not offered to a signed-in account', async () => {
      const { els, ctx } = load({ '/api/auth/me': { authenticated: true, username: 'rosie', gateState: 'armed' } });
      await ctx.load();
      assert.doesNotMatch(els.gsAccountSection.innerHTML, /gsAddLoginBtn/);
    });

    it('says what happens on the first press, and changes nothing until the second', async () => {
      const { els, ctx, mutations, visits } = load({
        '/api/auth/me': { authenticated: false, gateState: 'open' },
        '/api/auth/add-login': { loginEnabled: true, next: '/login' }
      });
      await ctx.load();
      await els.gsAddLoginBtn.click();
      assert.equal(mutations.length, 0, 'the first press only explains');
      assert.match(els.gsAddLoginHint.textContent, /sign-in page/);
      await els.gsAddLoginBtn.click();
      assert.deepEqual(JSON.parse(JSON.stringify(mutations)),
        [{ url: '/api/auth/add-login', method: 'POST', body: {} }]);
      assert.deepEqual(visits, ['/login'], 'the browser goes where the account is made or signed in');
    });

    it('shows the server\'s refusal and stays put', async () => {
      const { els, ctx, visits } = load({ '/api/auth/me': { authenticated: false, gateState: 'open' } });
      await ctx.load();
      await els.gsAddLoginBtn.click();
      await els.gsAddLoginBtn.click();
      assert.match(els.gsAddLoginHint.innerHTML, /The login was not turned on/);
      assert.match(els.gsAddLoginHint.innerHTML, /Connection lost/);
      assert.equal(els.gsAddLoginBtn.disabled, false);
      assert.deepEqual(visits, []);
    });
  });

  it('says the login is stood down during a fallback, not that none is required', async () => {
    const { els, ctx } = load({ '/api/auth/me': { authenticated: false, gateState: 'fallback' } });
    await ctx.load();
    assert.match(els.gsAccountSection.innerHTML, /stood down behind Caddy/);
    assert.doesNotMatch(els.gsAccountSection.innerHTML, /does not require a login/);
  });

  it('changes the password with both fields, clears them, and says what happened to other sessions and codes', async () => {
    const { els, ctx, mutations } = load({
      '/api/auth/me': { authenticated: true, username: 'rosie' },
      '/api/auth/password': { ok: true, otherSessionsEnded: 2 }
    });
    await ctx.load();
    els.gsPasswordCurrent.value = 'old-password-here';
    els.gsPasswordNew.value = 'a-long-enough-new-password';
    await els.gsPasswordChangeBtn.click();
    // Through JSON: the body object was built inside the sandbox's realm.
    assert.deepEqual(JSON.parse(JSON.stringify(mutations)), [{ url: '/api/auth/password', method: 'POST',
      body: { currentPassword: 'old-password-here', newPassword: 'a-long-enough-new-password' } }]);
    assert.equal(els.gsPasswordCurrent.value, '');
    assert.equal(els.gsPasswordNew.value, '');
    const hint = els.gsPasswordHint.innerHTML;
    assert.match(hint, /Password changed/);
    assert.match(hint, /2 other sessions were signed out/);
    assert.match(hint, /recovery codes still work/);
  });

  it('keeps the typed values and shows the server\'s reason when the change is refused', async () => {
    const { els, ctx, api } = load({ '/api/auth/me': { authenticated: true, username: 'rosie' } });
    await ctx.load();
    els.gsPasswordCurrent.value = 'wrong';
    els.gsPasswordNew.value = 'a-long-enough-new-password';
    assert.equal(api.calls.length, 1, 'precondition: only /api/auth/me so far');
    await els.gsPasswordChangeBtn.click();
    assert.match(els.gsPasswordHint.innerHTML, /Your password was not changed/);
    assert.equal(els.gsPasswordNew.value, 'a-long-enough-new-password');
    assert.equal(els.gsPasswordChangeBtn.disabled, false);
  });

  it('signs out everywhere through the shared helper', async () => {
    const { els, ctx, signOuts } = load({ '/api/auth/me': { authenticated: true, username: 'rosie' } });
    await ctx.load();
    await els.gsSignOutEverywhereBtn.click();
    assert.deepEqual(JSON.parse(JSON.stringify(signOuts)), [{ everywhere: true }]);
  });

  it('is loaded when global settings opens', () => {
    assert.match(UI_SRC, /_loadAccountSection\(\);/);
    assert.match(UI_SRC, /id="gsAccountSection"/);
  });
});
