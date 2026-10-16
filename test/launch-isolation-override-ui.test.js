'use strict';

/*
 * The launch-isolation override on screen (#2229): the install-wide switch in
 * Global Settings, a project's switch in Project Settings, and the way from a
 * refused launch to that switch.
 *
 * The functions are RUN here, lifted out of the shipped files, for the reason
 * `test/launch-readiness-panel.test.js` states: a source match cannot see an
 * undeclared identifier, and these render on the live install the moment the
 * file is saved.
 *
 * What the assertions hold is what the override's design rests on. The switch
 * shows the server's answer and never its own guess; it goes through the five
 * override routes and no settings route; a refusal to turn it on says a login
 * must be in force and leaves it off; and the sentence that says what a launch
 * under it risks is the server's own.
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

const UI_FUNCTIONS = [
  'function recoveryModeControlOffer', 'function isolationOverrideRiskText', 'function isolationOverrideStands',
  'function isolationOverrideHtml', 'function isolationOverrideOutcome', 'async function refreshIsolationOverride',
  'function wireIsolationOverride', 'async function refreshProjectIsolationOverride', 'function openIsolationOverrideSettings',
  'function isolationOverrideConfirmText'
];

/**
 * A sandbox holding the page's own override functions. Its `confirm()` says
 * yes unless the case supplies one, so a case about what a change sends is
 * about the change the operator confirmed (#2393).
 * @param {object} [extra] - Globals the case supplies (`api`, `document`, `openSettings`, `confirm`)
 * @returns {object} The context
 */
function sandbox(extra) {
  const ctx = { window: {}, state: { projects: [{ id: 7, name: 'alpha' }] }, confirm: () => true, ...(extra || {}) };
  vm.createContext(ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function esc(str)'), ctx);
  vm.runInContext('let isolationOverrideNotice = null; let isolationOverrideReveal = false; let projectRulesTargetId = null;', ctx);
  for (const decl of UI_FUNCTIONS) vm.runInContext(liftFunction(UI_SRC, decl), ctx);
  return ctx;
}

/** What `GET /api/auth/me` answers for each kind of page. */
const ME = {
  signedIn: { authenticated: true, gateActive: true, openInstallToken: null },
  signedOut: { authenticated: false, gateActive: true, openInstallToken: null },
  noLogin: { authenticated: false, gateActive: false, openInstallToken: 'tok' }
};

/**
 * Override settings as the routes answer them.
 * @param {boolean} install - Whether the install-wide override is on
 * @param {number[]} [projectIds] - Projects whose own override is on
 * @returns {object}
 */
function settings(install, projectIds) {
  return {
    install: { allowed: install, setAt: install ? '2026-10-12 21:00:00' : null, setBy: install ? 'operator-verified' : null },
    projects: (projectIds || []).map((projectId) => ({
      projectId, projectName: `p${projectId}`, allowed: true, setAt: '2026-10-12 21:05:00', setBy: 'operator-verified'
    }))
  };
}

/**
 * Render one switch.
 * @param {object} view - `isolationOverrideHtml`'s argument, with `me` in place of `offer`
 * @returns {string} Markup
 */
function html(view) {
  const ctx = sandbox();
  const { me, ...rest } = view;
  return ctx.isolationOverrideHtml({ ...rest, offer: ctx.recoveryModeControlOffer(me === undefined ? ME.signedIn : me) });
}

describe('The launch-isolation override: what each switch says (#2229)', () => {
  it('holds the same risk sentence the server records on each overridden launch', () => {
    const sessions = require('../lib/sessions');
    assert.equal(sandbox().isolationOverrideRiskText(), sessions.ISOLATION_OVERRIDE_RISK);
  });

  it('puts the risk sentence, and whom it falls on, on both switches', () => {
    const ctx = sandbox();
    const risk = ctx.esc(ctx.isolationOverrideRiskText());
    for (const view of [{ scope: 'install', projectId: null }, { scope: 'project', projectId: 7 }]) {
      const out = html({ ...view, settings: settings(false) });
      assert.ok(out.includes(risk), `the ${view.scope} switch carries the whole risk sentence`);
      assert.match(out, /The override does not make it isolated\./);
      assert.match(out, /have not agreed to that/);
    }
  });

  it('says the install-wide switch covers every project and the Project Master', () => {
    const out = html({ scope: 'install', projectId: null, settings: settings(false) });
    assert.match(out, /for every project and the Project Master/);
    assert.match(out, /in every project on this install, and for the Project Master/);
    assert.match(out, /data-isolation-override="install"/);
    assert.doesNotMatch(out, / checked/);
    assert.match(out, /\(off\)/);
  });

  it('shows a project switch on only for the project whose override is on', () => {
    const mine = html({ scope: 'project', projectId: 7, settings: settings(false, [7]) });
    assert.match(mine, /data-isolation-override="project"[^>]* checked/);
    assert.match(mine, /Turned on 2026-10-12 21:05:00, recorded as by "operator-verified"/);
    const other = html({ scope: 'project', projectId: 8, settings: settings(false, [7]) });
    assert.doesNotMatch(other, / checked/);
    assert.doesNotMatch(other, /Turned on/);
  });

  it('says on a project switch when the install-wide override already covers the project', () => {
    const covered = html({ scope: 'project', projectId: 7, settings: settings(true) });
    assert.match(covered, /The install-wide override is on, so this project is already covered by it/);
    assert.doesNotMatch(covered, / checked/, 'the project\'s own switch still reads its own row');
    assert.doesNotMatch(html({ scope: 'project', projectId: 7, settings: settings(false) }), /already covered/);
  });

  it('is a labelled switch a keyboard can reach, described by what it does and risks', () => {
    const out = html({ scope: 'project', projectId: 7, settings: settings(false) });
    assert.match(out, /<label class="isolation-override-switch"><input type="checkbox" role="switch" id="isolationOverrideProject"/);
    assert.match(out, /aria-describedby="isolationOverrideProjectWhat isolationOverrideProjectRisk"/);
    assert.match(out, /id="isolationOverrideProjectWhat"/);
    assert.match(out, /id="isolationOverrideProjectRisk"/);
    assert.doesNotMatch(out, /tabindex="-1"|display:\s*none/);
  });

  it('names only the refusals the override sets aside, and calls no session isolated', () => {
    const out = html({ scope: 'install', projectId: null, settings: settings(true) });
    assert.match(out, /No other refusal is set aside\./);
    assert.doesNotMatch(out, /is isolated|reads isolated|ISOLATED/);
  });
});

describe('The launch-isolation override: who is offered the switch (#2229)', () => {
  it('offers the switch where no login is in force, and says turning it on will be refused there', () => {
    const out = html({ scope: 'install', projectId: null, settings: settings(false), me: ME.noLogin });
    assert.match(out, /data-isolation-override="install"/);
    assert.match(out, /TangleClaw's login is not in force on this install\./);
    assert.match(out, /until a login is in force and you are signed in\. Turning it off works without one\./);
  });

  it('says nothing about a missing login to a signed-in operator', () => {
    assert.doesNotMatch(html({ scope: 'install', projectId: null, settings: settings(false), me: ME.signedIn }), /login is not in force/);
  });

  it('shows a signed-out page the state and the reason, and no control', () => {
    const out = html({ scope: 'project', projectId: 7, settings: settings(false, [7]), me: ME.signedOut });
    assert.doesNotMatch(out, /<input/);
    assert.match(out, /Launch isolation override: on/);
    assert.match(out, /only from a signed-in operator\. Sign in, then reopen Settings\./);
  });

  it('offers nothing to a page the server does not take as the operator\'s', () => {
    const out = html({ scope: 'project', projectId: 7, settings: null, failure: { error: 'Only the operator may read the launch-isolation overrides', code: 'OPERATOR_ONLY' } });
    assert.doesNotMatch(out, /<input/);
    assert.match(out, /is the operator's to read and to change/);
    assert.match(out, /Nothing is offered here\./);
    assert.doesNotMatch(out, /\(off\)|\(on\)/);
  });

  it('does not show unread settings as off', () => {
    for (const unread of [null, {}, { install: { allowed: false } }]) {
      const out = html({ scope: 'install', projectId: null, settings: unread, failure: { error: 'Connection lost.', code: null } });
      assert.doesNotMatch(out, /<input/);
      assert.match(out, /could not be read \(Connection lost\.\), so this page does not say whether it is on/);
    }
  });

  it('still offers the switch when who is signed in could not be read: the server decides', () => {
    assert.match(html({ scope: 'install', projectId: null, settings: settings(false), me: null }), /data-isolation-override="install"/);
  });

  it('keeps the last change\'s outcome beside the switch, as a status', () => {
    const out = html({ scope: 'install', projectId: null, settings: settings(false), notice: { text: 'was <not> turned on', ok: false } });
    assert.match(out, /<small role="status" class="session-rule-meta rules-status-err">was &lt;not&gt; turned on<\/small>/);
  });
});

describe('The launch-isolation override: what a change is told (#2229)', () => {
  const outcome = (asked, answer, failure) => sandbox().isolationOverrideOutcome(asked, answer, failure || { error: null, code: null });

  it('reads a success from the settings the write answered', () => {
    const on = outcome({ scope: 'project', projectId: 7, on: true }, settings(false, [7]));
    assert.equal(on.ok, true);
    assert.match(on.text, /^This project's launch isolation override is on\./);
    const off = outcome({ scope: 'install', projectId: null, on: false }, settings(false));
    assert.equal(off.ok, true);
    assert.match(off.text, /^The install-wide launch isolation override is off\. A session already started under it keeps running, not isolated/);
  });

  it('does not report a change the answered settings do not show', () => {
    const out = outcome({ scope: 'project', projectId: 7, on: true }, settings(true, [8]));
    assert.equal(out.ok, false);
    assert.match(out.text, /was not changed: the server answered, and its settings still read the other way/);
  });

  it('says a login must be in force when turning one on is refused for want of a sign-in', () => {
    const out = outcome({ scope: 'install', projectId: null, on: true }, null,
      { error: 'A launch-isolation override can be turned on only by a signed-in operator', code: 'LOGIN_GATE_REQUIRED' });
    assert.equal(out.ok, false);
    assert.match(out.text, /was not turned on, and nothing was changed/);
    assert.match(out.text, /A login must be in force: turn TangleClaw's login on, sign in, and turn this on again\./);
    assert.match(out.text, /Turning an override off needs no sign-in\./);
  });

  it('says nothing changed for every other refusal, with the server\'s words', () => {
    for (const code of ['OPERATOR_ONLY', 'UNAUTHENTICATED', 'CSRF_TOKEN_INVALID', 'NOT_FOUND', 'INTERNAL_ERROR']) {
      const out = outcome({ scope: 'project', projectId: 7, on: true }, null, { error: `said ${code}`, code });
      assert.equal(out.ok, false, code);
      assert.match(out.text, /was not changed/, code);
      assert.ok(out.text.includes(`said ${code}`), code);
    }
  });

  it('does not claim either way when the server did not answer', () => {
    const out = outcome({ scope: 'install', projectId: null, on: true }, null, { error: 'Connection lost.', code: null });
    assert.equal(out.ok, false);
    assert.match(out.text, /got no answer from the server, so whether it was recorded is not known/);
  });
});

/**
 * A switch's container as the wiring sees it: one input, re-made on each
 * render, the way replacing `innerHTML` re-makes it in a browser.
 * @param {boolean} checked - What the person just set the switch to
 * @returns {{box: object, input: object, focused: function(): boolean}}
 */
function switchBox(checked) {
  const listeners = [];
  let focused = false;
  const input = { checked, disabled: false, addEventListener: (type, fn) => { if (type === 'change') listeners.push(fn); } };
  let raw = '';
  const box = {
    get innerHTML() { return raw; },
    set innerHTML(v) { raw = String(v); },
    querySelectorAll: () => [input],
    querySelector: () => (raw.includes('<input') ? { focus: () => { focused = true; } } : null)
  };
  return { box, input, change: () => Promise.all(listeners.map((fn) => fn())), focused: () => focused };
}

/**
 * A page `api()` that records each call and answers from a table.
 * @param {function(string, object=): {data: (object|null), error?: string, code?: string}} answer - What each call is told
 * @returns {Function} The `api`, with `calls`
 */
function fakeApi(answer) {
  const api = async (url, opts) => {
    api.calls.push({ url, method: (opts && opts.method) || 'GET', body: opts ? opts.body : undefined });
    const a = answer(url, opts);
    api.lastError = a.error || null;
    api.lastErrorCode = a.code || null;
    return a.data;
  };
  api.calls = [];
  api.lastError = null;
  api.lastErrorCode = null;
  return api;
}

describe('The launch-isolation override: what the switch sends (#2229)', () => {
  const CASES = [
    { scope: 'install', projectId: null, on: true, method: 'PUT', url: '/api/launch/isolation-overrides/install' },
    { scope: 'install', projectId: null, on: false, method: 'DELETE', url: '/api/launch/isolation-overrides/install' },
    { scope: 'project', projectId: 7, on: true, method: 'PUT', url: '/api/launch/isolation-overrides/projects/7' },
    { scope: 'project', projectId: 7, on: false, method: 'DELETE', url: '/api/launch/isolation-overrides/projects/7' }
  ];

  for (const c of CASES) {
    it(`${c.on ? 'on' : 'off'}, ${c.scope}: ${c.method} ${c.url}, no body, then the settings read again`, async () => {
      const after = settings(c.scope === 'install' && c.on, c.scope === 'project' && c.on ? [7] : []);
      const api = fakeApi((url) => (url === '/api/auth/me' ? { data: ME.signedIn } : { data: after }));
      const ctx = sandbox({ api });
      vm.runInContext('projectRulesTargetId = 7;', ctx);
      const sw = switchBox(c.on);
      ctx.wireIsolationOverride(sw.box, c.scope, c.projectId);
      await sw.change();
      assert.deepEqual(api.calls[0], { url: c.url, method: c.method, body: undefined });
      assert.deepEqual(api.calls.slice(1).map((x) => `${x.method} ${x.url}`),
        ['GET /api/launch/isolation-overrides', 'GET /api/auth/me']);
      assert.ok(api.calls.every((x) => !x.url.includes('/api/config') && !x.url.startsWith('/api/projects/')),
        'the override never goes through a settings route');
      assert.equal(c.on ? / checked/.test(sw.box.innerHTML) : !/ checked/.test(sw.box.innerHTML), true);
      assert.equal(sw.focused(), true, 'focus goes back to the re-rendered switch');
    });
  }

  it('leaves the switch off, with the reason beside it, when turning it on is refused with no login', async () => {
    const api = fakeApi((url, opts) => {
      if (url === '/api/auth/me') return { data: ME.noLogin };
      if (opts && opts.method === 'PUT') return { data: null, error: 'carries no sign-in', code: 'LOGIN_GATE_REQUIRED' };
      return { data: settings(false) };
    });
    const ctx = sandbox({ api });
    const sw = switchBox(true);
    ctx.wireIsolationOverride(sw.box, 'install', null);
    await sw.change();
    assert.doesNotMatch(sw.box.innerHTML, / checked/);
    assert.match(sw.box.innerHTML, /role="status"[^>]*rules-status-err[^>]*>The install-wide launch isolation override was not turned on, and nothing was changed/);
    assert.match(sw.box.innerHTML, /A login must be in force/);
  });

  it('turns an override off where no login is in force', async () => {
    let on = true;
    const api = fakeApi((url, opts) => {
      if (url === '/api/auth/me') return { data: ME.noLogin };
      if (opts && opts.method === 'DELETE') on = false;
      return { data: settings(on) };
    });
    const ctx = sandbox({ api });
    const sw = switchBox(false);
    ctx.wireIsolationOverride(sw.box, 'install', null);
    await sw.change();
    assert.doesNotMatch(sw.box.innerHTML, / checked/);
    assert.match(sw.box.innerHTML, /role="status" class="session-rule-meta">The install-wide launch isolation override is off\./);
  });

  it('renders nothing into a project\'s box once Settings has moved to another project', async () => {
    const api = fakeApi((url) => (url === '/api/auth/me' ? { data: ME.signedIn } : { data: settings(false, [7]) }));
    const ctx = sandbox({ api });
    vm.runInContext('projectRulesTargetId = 8;', ctx);
    const sw = switchBox(true);
    assert.equal(await ctx.refreshIsolationOverride(sw.box, 'project', 7), null);
    assert.equal(sw.box.innerHTML, '');
  });
});

describe('The launch-isolation override: turning one on asks first (#2393)', () => {
  /**
   * A page that records each `confirm()` and answers it as the case says.
   * @param {boolean} answer - What the operator answers
   * @param {object} [answers] - Overrides for the `api` table
   * @returns {{ctx: object, api: Function, asked: string[]}}
   */
  function page(answer, answers) {
    const api = fakeApi((url) => (url === '/api/auth/me' ? { data: ME.signedIn } : { data: (answers && answers[url]) || settings(false) }));
    const asked = [];
    const ctx = sandbox({ api, confirm: (text) => { asked.push(text); return answer; } });
    vm.runInContext('projectRulesTargetId = 7;', ctx);
    return { ctx, api, asked };
  }

  for (const scope of ['install', 'project']) {
    it(`asks before turning the ${scope} override on, naming whom it covers and what it risks`, async () => {
      const p = page(true);
      const sw = switchBox(true);
      p.ctx.wireIsolationOverride(sw.box, scope, scope === 'install' ? null : 7);
      await sw.change();
      assert.equal(p.asked.length, 1);
      const text = p.asked[0];
      assert.match(text, scope === 'install'
        ? /^Turn on the launch isolation override for every project on this install, and for the Project Master\?/
        : /^Turn on the launch isolation override for this project only \("alpha"\)\?/);
      assert.ok(text.includes(p.ctx.isolationOverrideRiskText()), 'the confirmation carries the shared risk sentence');
      assert.match(text, /The projects it may borrow from have not agreed to that\.$/);
      assert.equal(p.api.calls[0].method, 'PUT', 'the write goes only after a yes');
    });

    it(`sends nothing, and puts the switch back off, when turning the ${scope} override on is cancelled`, async () => {
      const p = page(false);
      const sw = switchBox(true);
      p.ctx.wireIsolationOverride(sw.box, scope, scope === 'install' ? null : 7);
      await sw.change();
      assert.equal(p.asked.length, 1);
      assert.deepEqual(p.api.calls, [], 'no request at all, the re-read included');
      assert.equal(sw.input.checked, false);
      assert.equal(sw.input.disabled, false, 'the switch can be used again');
      assert.equal(sw.box.innerHTML, '', 'nothing re-rendered and no outcome claimed');
      assert.equal(vm.runInContext('isolationOverrideNotice', p.ctx), null);
    });

    it(`asks nothing before turning the ${scope} override off`, async () => {
      const p = page(false);
      const sw = switchBox(false);
      p.ctx.wireIsolationOverride(sw.box, scope, scope === 'install' ? null : 7);
      await sw.change();
      assert.deepEqual(p.asked, []);
      assert.equal(p.api.calls[0].method, 'DELETE');
    });
  }

  it('names no project in the question when the page does not list it', () => {
    const ctx = sandbox({ state: { projects: [] } });
    assert.match(ctx.isolationOverrideConfirmText('project', 7), /^Turn on the launch isolation override for this project only\?/);
  });

  it('re-reads the dashboard notice after every change, a refused or unanswered one included', async () => {
    for (const write of [{ data: settings(false, [7]) }, { data: null, error: 'carries no sign-in', code: 'LOGIN_GATE_REQUIRED' },
      { data: null, error: 'Connection lost.', code: null }]) {
      const order = [];
      const api = fakeApi((url, opts) => {
        order.push(`${(opts && opts.method) || 'GET'} ${url}`);
        if (url === '/api/auth/me') return { data: ME.signedIn };
        return opts && opts.method ? write : { data: settings(false, [7]) };
      });
      const ctx = sandbox({ api, refreshIsolationOverrideBanner: async () => { order.push('notice'); return true; } });
      vm.runInContext('projectRulesTargetId = 7;', ctx);
      const sw = switchBox(true);
      ctx.wireIsolationOverride(sw.box, 'project', 7);
      await sw.change();
      assert.deepEqual(order, ['PUT /api/launch/isolation-overrides/projects/7', 'GET /api/launch/isolation-overrides',
        'GET /api/auth/me', 'notice'], 'the notice is read after the switch, never beside it');
    }
  });

  it('re-reads the dashboard notice even when Settings has moved to another project', async () => {
    let read = 0;
    const api = fakeApi((url) => (url === '/api/auth/me' ? { data: ME.signedIn } : { data: settings(false, [7]) }));
    const ctx = sandbox({ api, refreshIsolationOverrideBanner: async () => { read++; return true; } });
    vm.runInContext('projectRulesTargetId = 8;', ctx);
    const sw = switchBox(true);
    ctx.wireIsolationOverride(sw.box, 'project', 7);
    await sw.change();
    assert.equal(read, 1);
    assert.equal(sw.focused(), false, 'focus is not moved into a modal that has moved on');
  });
});

describe('A refused launch leads to the override (#2229)', () => {
  /**
   * The launch-failed message after the pointer was added.
   * @param {object|null} me - What `GET /api/auth/me` answered
   * @returns {{toast: object, opened: string[]}}
   */
  function pointer(me) {
    const { doc } = makeDocument(['toast']);
    const opened = [];
    const ctx = sandbox({ document: doc, openSettings: (name) => opened.push(name) });
    vm.runInContext(liftFunction(LANDING_SRC, 'function appendLaunchIsolationPointer'), ctx);
    // The dashboard's one writer of the toast, which owns what a message adds.
    vm.runInContext(liftFunction(UI_SRC, 'function showToast('), ctx);
    vm.runInContext(liftFunction(UI_SRC, 'function hideToast('), ctx);
    const toast = doc.getElementById('toast');
    ctx.showToast('Launch failed: refused', 'warn', 0, { sticky: true, action: (t) => ctx.appendLaunchIsolationPointer(t, 'alpha', me) });
    return { toast, opened, ctx };
  }

  it('is offered for the two version refusals and no other', () => {
    const ctx = sandbox();
    vm.runInContext(liftFunction(LANDING_SRC, 'function launchRefusalIsOverridable'), ctx);
    const refusal = (reasonCode, code) => ({ error: 'x', code: code || 'LAUNCH_ISOLATION_UNVERIFIED', reasonCode });
    assert.equal(ctx.launchRefusalIsOverridable(refusal('version_unknown')), true);
    assert.equal(ctx.launchRefusalIsOverridable(refusal('version_unverified')), true);
    for (const other of ['native_channel', 'wrapper_executable', 'no_daemon_in_arguments', undefined]) {
      assert.equal(ctx.launchRefusalIsOverridable(refusal(other)), false, String(other));
    }
    assert.equal(ctx.launchRefusalIsOverridable(refusal('version_unknown', 'CONFLICT')), false);
    assert.equal(ctx.launchRefusalIsOverridable(null), false);
  });

  it('reads the reason where the server puts it: beside the code, not under `isolation`', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /if \(result\.code === 'LAUNCH_ISOLATION_UNVERIFIED'\) \{\s*return errorResponse\(res, 409, result\.error, result\.code, result\.isolation\);/);
    assert.match(server, /jsonResponse\(res, status, \{ \.\.\.\(extra \|\| \{\}\), error: message, code \}\);/);
  });

  it('gives a page that would be offered the switch one button, which opens that project\'s Settings at it', () => {
    for (const me of [ME.signedIn, ME.noLogin, null]) {
      const { toast, opened, ctx } = pointer(me);
      const btn = toast.childNodes.find((c) => c.tagName === 'BUTTON');
      assert.ok(btn, 'a button is added');
      assert.equal(toast.childNodes.filter((c) => c.tagName === 'BUTTON').length, 2, 'beside the message\'s own Dismiss');
      assert.equal(btn.textContent, 'Open launch isolation settings');
      assert.equal(btn.type, 'button');
      btn.dispatch('click');
      assert.deepEqual(opened, ['alpha']);
      assert.equal(vm.runInContext('isolationOverrideReveal', ctx), true);
      assert.equal(toast.classList.contains('visible'), false);
      assert.equal(toast.childNodes.some((c) => c.tagName === 'BUTTON'), false, 'the hidden message keeps no button in the tab order');
    }
  });

  it('does not ask the next Settings to move for a project the page does not list', () => {
    const opened = [];
    const ctx = sandbox({ openSettings: (name) => opened.push(name) });
    ctx.openIsolationOverrideSettings('gone');
    assert.deepEqual(opened, ['gone']);
    assert.equal(vm.runInContext('isolationOverrideReveal', ctx), false);
  });

  /**
   * Run the page's own `doLaunchProject` against a launch the server refuses.
   * @param {object} refusal - The refusal body
   * @returns {Promise<{toast: object, timers: Function[], asked: string[]}>}
   */
  async function refusedLaunch(refusal) {
    const { doc } = makeDocument(['toast']);
    const toast = doc.getElementById('toast');
    const timers = [];
    const api = fakeApi(() => ({ data: ME.signedIn }));
    const ctx = sandbox({
      api,
      document: { querySelector: () => null, getElementById: () => toast, createElement: (tag) => doc.createElement(tag) },
      tcFetch: async () => ({ ok: false, status: 409, json: async () => refusal }),
      setTimeout: (fn) => { timers.push(fn); },
      openSettings: () => {},
      strandedLaunch: null
    });
    for (const decl of ['function launchRefusalIsOverridable', 'function appendLaunchIsolationPointer', 'async function doLaunchProject']) {
      vm.runInContext(liftFunction(LANDING_SRC, decl), ctx);
    }
    vm.runInContext(liftFunction(UI_SRC, 'function showToast('), ctx);
    vm.runInContext(liftFunction(UI_SRC, 'function hideToast('), ctx);
    await ctx.doLaunchProject('alpha', 'default');
    return { toast, timers, asked: api.calls.map((c) => c.url) };
  }

  /**
   * The message's buttons, by their words.
   * @param {object} toast - The toast element
   * @returns {string[]}
   */
  const buttons = (toast) => toast.childNodes.filter((c) => c.tagName === 'BUTTON').map((c) => c.textContent);

  it('the launch screen adds the button to a version refusal, which stays until dismissed and takes the button with it', async () => {
    const { toast, timers, asked } = await refusedLaunch({ error: 'refused', code: 'LAUNCH_ISOLATION_UNVERIFIED', reasonCode: 'version_unverified' });
    assert.match(toast.text, /^Launch failed: refused/);
    assert.equal(toast.classList.contains('visible'), true);
    assert.deepEqual(buttons(toast), ['Open launch isolation settings', 'Dismiss']);
    assert.deepEqual(asked, ['/api/auth/me']);
    assert.equal(timers.length, 0, 'no timer hides a refusal');
    toast.childNodes.find((c) => c.textContent === 'Dismiss').dispatch('click');
    assert.equal(toast.classList.contains('visible'), false);
    assert.equal(toast.childNodes.some((c) => c.tagName === 'BUTTON'), false, 'nothing focusable is left in a message moved off screen');
  });

  it('the launch screen adds only Dismiss to any other refused launch, and does not ask who is signed in', async () => {
    for (const refusal of [{ error: 'busy', code: 'CONFLICT' }, { error: 'refused', code: 'LAUNCH_ISOLATION_UNVERIFIED', reasonCode: 'wrapper_executable' }]) {
      const { toast, timers, asked } = await refusedLaunch(refusal);
      assert.deepEqual(buttons(toast), ['Dismiss'], refusal.code);
      assert.deepEqual(asked, []);
      assert.equal(timers.length, 0, refusal.code);
      toast.childNodes[0].dispatch('click');
      assert.equal(toast.classList.contains('visible'), false);
      assert.equal(toast.childNodes.length, 0, refusal.code);
    }
  });

  it('tells a signed-out page who can, in place of a button it could not use', () => {
    const { toast, opened } = pointer(ME.signedOut);
    assert.deepEqual(toast.childNodes.filter((c) => c.tagName === 'BUTTON').map((c) => c.textContent), ['Dismiss'], 'the message\'s own Dismiss, and no way to the switch');
    assert.match(toast.text, /Only a signed-in operator can turn on the launch isolation override, in this project's Settings: sign in first\./);
    assert.deepEqual(opened, []);
  });

  it('brings the switch into view and focuses it once, when Settings was opened by the pointer', async () => {
    const api = fakeApi((url) => (url === '/api/auth/me' ? { data: ME.signedIn } : { data: settings(false) }));
    const sw = switchBox(false);
    let scrolled = 0;
    sw.box.scrollIntoView = () => { scrolled++; };
    const ctx = sandbox({ api, document: { getElementById: (id) => (id === 'projIsolationOverride' ? sw.box : null) }, openSettings: () => {} });
    vm.runInContext('projectRulesTargetId = 7;', ctx);
    await ctx.refreshProjectIsolationOverride(7);
    assert.equal(scrolled, 0, 'an ordinary open does not move the page');
    ctx.openIsolationOverrideSettings('alpha');
    await ctx.refreshProjectIsolationOverride(7);
    await ctx.refreshProjectIsolationOverride(7);
    assert.equal(scrolled, 1);
    assert.equal(sw.focused(), true);
  });
});

describe('The override\'s screens are wired into the two Settings modals (#2229)', () => {
  it('Project Settings holds the switch\'s box and loads it with the panel', () => {
    assert.match(UI_SRC, /<div class="form-label">Launch isolation override<\/div>/);
    assert.match(UI_SRC, /id="projIsolationOverride" aria-live="polite"/);
    assert.match(liftFunction(UI_SRC, 'async function loadProjectRules'), /await refreshProjectIsolationOverride\(projectId\);/);
  });

  it('Project Settings loads the Launch readiness line and the switch for the project it opened', async () => {
    const calls = [];
    const ctx = sandbox();
    ctx.PROJECT_RULE_KINDS = [];
    ctx.refreshProjectRuleDeliveries = async () => true;
    ctx.refreshProjectLaunchSequences = async () => true;
    ctx.refreshProjectLaunchIsolationLine = async (id) => { calls.push(`line ${id}`); };
    ctx.refreshProjectIsolationOverride = async (id) => { calls.push(`switch ${id}`); };
    vm.runInContext('let projectRulesTargetName = null; let projectRecoveryModeNotice = null;'
      + liftFunction(UI_SRC, 'async function loadProjectRules'), ctx);
    await ctx.loadProjectRules(7, 'alpha');
    assert.deepEqual(calls, ['line 7', 'switch 7']);
    assert.match(UI_SRC, /id="projLaunchIsolationLine" aria-live="polite"/);
  });

  it('the Launch readiness line is read from the isolation inventory, for the project Settings is showing', async () => {
    const row = {
      sessionId: 12, projectId: 7, role: 'project', verdict: 'not-isolated', reason: 'r', overrideUnproved: false,
      override: { launchedUnderOverride: true, scope: 'install', refusal: 'version_unknown', versionRead: null, recordedAt: null }
    };
    const box = { innerHTML: '' };
    const api = fakeApi((url) => (url === '/api/launch/isolation' ? { data: { sessions: [row] } } : { data: null, error: 'unexpected' }));
    const ctx = sandbox({
      api,
      document: { getElementById: (id) => (id === 'projLaunchIsolationLine' ? box : null) },
      state: { projects: [{ id: 7, name: 'alpha', session: { active: true } }] }
    });
    vm.runInContext(liftFunction(UI_SRC, 'function launchIsolationOverrideLineHtml'), ctx);
    vm.runInContext(liftFunction(UI_SRC, 'async function refreshProjectLaunchIsolationLine'), ctx);
    vm.runInContext('projectRulesTargetId = 7;', ctx);
    await ctx.refreshProjectLaunchIsolationLine(7);
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.url}`), ['GET /api/launch/isolation']);
    assert.match(box.innerHTML, /<strong>12<\/strong>: .*running under the operator's launch isolation override/);
    assert.match(box.innerHTML, /under the install-wide override/);
    box.innerHTML = 'kept';
    vm.runInContext('projectRulesTargetId = 8;', ctx);
    await ctx.refreshProjectLaunchIsolationLine(7);
    assert.equal(box.innerHTML, 'kept', 'a read that lands after Settings moved on writes nothing');
  });

  it('Global Settings holds the install-wide switch\'s box and loads it on open', () => {
    const open = liftFunction(UI_SRC, 'function openGlobalSettings');
    assert.match(open, /<div class="gs-section-label">Launch isolation override<\/div>/);
    assert.match(open, /refreshIsolationOverride\(document\.getElementById\('gsIsolationOverrideSection'\), 'install', null\);/);
  });

  it('a session\'s own page and the Project Master\'s settings are given no switch', () => {
    for (const file of ['session.js', 'session.html', 'session-relaunch.js', 'api-helper.js']) {
      const src = fs.readFileSync(path.join(PUB, file), 'utf8');
      assert.doesNotMatch(src, /isolation-overrides|data-isolation-override/, file);
    }
  });

  it('no screen writes the override through a settings route', () => {
    for (const file of fs.readdirSync(PUB).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(PUB, file), 'utf8');
      if (!src.includes('isolation-overrides') || file === 'ui.js') continue;
      // The dashboard's notice (#2393) reads the overrides, through the one
      // read route and with no method, so it can only ever GET them.
      assert.equal(file, 'landing.js', `${file} names the override routes`);
      const code = src.match(/[^\n]*isolation-overrides[^\n]*/g).map((line) => line.trim())
        .filter((line) => !line.startsWith('*') && !line.startsWith('//'));
      assert.deepEqual(code, ['const settings = await once(\'/api/launch/isolation-overrides\');'], 'landing.js only reads the overrides');
    }
    const wire = liftFunction(UI_SRC, 'function wireIsolationOverride');
    assert.doesNotMatch(wire, /\/api\/config|apiMutate|\bfetch\(/);
    assert.match(liftFunction(UI_SRC, 'async function refreshIsolationOverride'), /await api\('\/api\/launch\/isolation-overrides'\)/);
  });
});
