'use strict';

/*
 * #1420 — how recovery codes reach the operator's dashboard, tested by RUNNING
 * the render code against a DOM stub (the pattern `caddy-drift-surfacing.test.js`
 * follows): a grep proves a string exists, only execution proves the notice
 * shows, escapes what it shows, and goes away when acknowledged.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const LANDING_SRC = fs.readFileSync(path.join(PUBLIC, 'landing.js'), 'utf8');
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
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`could not brace-match ${name}`);
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * A minimal element: text, markup, hidden class, listeners, children.
 * @returns {object}
 */
function el() {
  const node = {
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    dataset: {},
    children: [],
    _hidden: true,
    _listeners: {},
    classList: {
      add(c) { if (c === 'hidden') node._hidden = true; },
      remove(c) { if (c === 'hidden') node._hidden = false; }
    },
    addEventListener(ev, fn) { (node._listeners[ev] = node._listeners[ev] || []).push(fn); },
    appendChild(child) { node.children.push(child); },
    click: async () => { for (const fn of node._listeners.click || []) await fn(); }
  };
  return node;
}

describe('the recovery-code notice banner (#1420)', () => {
  function render(notice, apiMutate = async () => ({ cleared: 1 })) {
    const els = { recoveryNoticeBanner: el(), recoveryNoticeBannerText: el(), recoveryNoticeAckBtn: el() };
    const calls = [];
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || null },
      esc: escHtml,
      apiMutate: async (...args) => { calls.push(args); return apiMutate(...args); }
    });
    vm.runInContext(`${extract(LANDING_SRC, 'renderRecoveryNotice')}\nthis.renderRecoveryNotice = renderRecoveryNotice;`, ctx);
    ctx.renderRecoveryNotice(notice);
    return { els, calls, ctx };
  }

  it('stays hidden with no notice', () => {
    for (const n of [null, undefined, { redemptions: [], remaining: 8 }]) {
      assert.equal(render(n).els.recoveryNoticeBanner._hidden, true);
    }
  });

  it('shows the latest use, where it came from, and how many codes are left', () => {
    const { els } = render({ redemptions: [{ usedAt: Date.UTC(2026, 8, 13), from: '100.64.0.9 (through the proxy)' }], remaining: 7 });
    assert.equal(els.recoveryNoticeBanner._hidden, false);
    const html = els.recoveryNoticeBannerText.innerHTML;
    assert.match(html, /A recovery code was used/);
    assert.match(html, /100\.64\.0\.9 \(through the proxy\)/);
    assert.match(html, /7 left/);
    assert.match(html, /If this was not you/);
  });

  it('names the routes that actually replace an account password — not a Settings form that does not exist', () => {
    const html = render({ redemptions: [{ usedAt: 1, from: 'a' }], remaining: 3 }).els.recoveryNoticeBannerText.innerHTML;
    assert.match(html, /another recovery code/);
    assert.match(html, /reset-admin\.js --store/);
    assert.match(html, /Settings → Recovery codes/);
    assert.doesNotMatch(html, /change your password/i,
      'Settings has no account-password form; its only password section is Caddy\'s');
  });

  it('counts several uses', () => {
    const { els } = render({ redemptions: [{ usedAt: 2, from: 'a' }, { usedAt: 1, from: 'b' }], remaining: 6 });
    assert.match(els.recoveryNoticeBannerText.innerHTML, /2 recovery codes were used/);
  });

  it('escapes the recorded address before it reaches innerHTML', () => {
    const { els } = render({ redemptions: [{ usedAt: 1, from: '<img src=x onerror=alert(1)>' }], remaining: 1 });
    assert.doesNotMatch(els.recoveryNoticeBannerText.innerHTML, /<img/);
  });

  it('acknowledges through the API and hides — and stays up if the call fails', async () => {
    const ok = render({ redemptions: [{ usedAt: 1, from: 'a' }], remaining: 1 });
    await ok.els.recoveryNoticeAckBtn.click();
    assert.deepEqual(ok.calls[0].slice(0, 2), ['/api/auth/recovery-codes/acknowledge', 'POST']);
    assert.equal(ok.els.recoveryNoticeBanner._hidden, true);

    const failing = render({ redemptions: [{ usedAt: 1, from: 'a' }], remaining: 1 }, async () => null);
    await failing.els.recoveryNoticeAckBtn.click();
    assert.equal(failing.els.recoveryNoticeBanner._hidden, false);
  });

  it('wires the button once across polls', () => {
    const { els, ctx } = render({ redemptions: [{ usedAt: 1, from: 'a' }], remaining: 1 });
    ctx.renderRecoveryNotice({ redemptions: [{ usedAt: 1, from: 'a' }], remaining: 1 });
    assert.equal(els.recoveryNoticeAckBtn._listeners.click.length, 1);
  });

  it('is wired into the server-info poll and has its anchor', () => {
    assert.match(LANDING_SRC, /renderRecoveryNotice\(data\.recoveryNotice\)/);
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    for (const id of ['recoveryNoticeBanner', 'recoveryNoticeBannerText', 'recoveryNoticeAckBtn']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
  });
});

describe('Settings > Recovery codes (#1420)', () => {
  async function load(apiAnswer, { lastErrorCode = null, lastError = null, mutate = async () => null } = {}) {
    const els = {
      gsRecoveryCodesSection: el(), gsRecoveryGenerateBtn: el(), gsRecoveryHint: el(),
      gsRecoveryPassword: el(), gsRecoveryList: el()
    };
    const api = async () => apiAnswer;
    api.lastErrorCode = lastErrorCode;
    api.lastError = lastError;
    const calls = [];
    const ctx = vm.createContext({
      document: {
        getElementById: (id) => els[id] || null,
        createElement: () => el()
      },
      api,
      apiMutate: async (...args) => { calls.push(args); return mutate(...args); },
      esc: escHtml
    });
    vm.runInContext(`async ${extract(UI_SRC, '_loadRecoveryCodesSection')}\nthis.run = _loadRecoveryCodesSection;`, ctx);
    await ctx.run();
    return { els, calls };
  }

  it('says a login is not in use rather than drawing a form', async () => {
    const { els } = await load(null, { lastErrorCode: 'LOGIN_NOT_REQUIRED' });
    assert.match(els.gsRecoveryCodesSection.innerHTML, /does not require one/);
    assert.doesNotMatch(els.gsRecoveryCodesSection.innerHTML, /gsRecoveryPassword/);
  });

  it('tells an account with no codes to generate some', async () => {
    const { els } = await load({ remaining: 0, total: 0, generatedAt: null, notice: null });
    assert.match(els.gsRecoveryCodesSection.innerHTML, /no recovery codes/);
  });

  it('reports how many are left', async () => {
    const { els } = await load({ remaining: 3, total: 8, generatedAt: 1, notice: null });
    assert.match(els.gsRecoveryCodesSection.innerHTML, /<strong>3<\/strong> unused recovery codes of 8/);
  });

  it('sends the current password and shows the new codes with textContent, once', async () => {
    const codes = ['AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', '<b>x</b>'];
    const { els, calls } = await load({ remaining: 8, total: 8, generatedAt: 1, notice: null },
      { mutate: async () => ({ codes, remaining: 2 }) });
    els.gsRecoveryPassword.value = 'my-current-password';
    await els.gsRecoveryGenerateBtn.click();
    // Compared as JSON: the body object was built inside the vm realm.
    assert.equal(JSON.stringify(calls[0]), JSON.stringify(['/api/auth/recovery-codes', 'POST', { password: 'my-current-password' }]));
    assert.deepEqual(els.gsRecoveryList.children.map((c) => c.textContent), codes);
    assert.equal(els.gsRecoveryList.children[1].innerHTML, '', 'never markup');
    assert.equal(els.gsRecoveryList._hidden, false);
    assert.equal(els.gsRecoveryPassword.value, '', 'the password field is cleared');
    assert.match(els.gsRecoveryHint.innerHTML, /will not be shown again/);
  });

  it('says nothing was generated when the server refuses', async () => {
    const { els } = await load({ remaining: 8, total: 8, generatedAt: 1, notice: null }, { mutate: async () => null });
    await els.gsRecoveryGenerateBtn.click();
    assert.match(els.gsRecoveryHint.innerHTML, /No new codes were generated/);
    assert.equal(els.gsRecoveryList.children.length, 0);
  });
});

describe('the self-contained auth pages (#1420)', () => {
  it('the account page shows codes with textContent and waits for the person', () => {
    const src = fs.readFileSync(path.join(PUBLIC, 'account-setup.html'), 'utf8');
    assert.match(src, /li\.textContent = c/);
    assert.doesNotMatch(src, /setTimeout|setInterval/);
    assert.match(src, /id="done"/);
  });

  it('the recovery page loads nothing external and posts only to its route', () => {
    const src = fs.readFileSync(path.join(PUBLIC, 'recover.html'), 'utf8');
    assert.doesNotMatch(src, /<script[^>]+src=|<link[^>]+href=/);
    assert.match(src, /fetch\('\/api\/auth\/recover'/);
    assert.match(src, /window\.location\.replace\('\/'\)/);
  });
});
