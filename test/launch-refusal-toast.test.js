'use strict';

/*
 * A refused launch's message on the dashboard (#2339).
 *
 * The refusal is the only place the dashboard says why nothing started and
 * what to do, and refusals are long sentences carrying an absolute path. It
 * was shown for six seconds, and every message on the page shares one toast
 * element whose sites each set their own hide timer, so an earlier message's
 * timer could hide a refusal sooner still and leave its button behind, off
 * screen but in the tab order.
 *
 * `showToast` in public/ui.js is now the toast's one owner: each message
 * cancels the one before it, a refusal stays until it is dismissed or a newer
 * message replaces it, and whatever a message added goes with it. These cases
 * RUN the page's own functions, lifted from the shipped files, in a sandbox
 * whose timers the test holds; only the toast's layout is read from source.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');
const { liftDeclaration } = require('./helpers/lift');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const LANDING_SRC = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');
const STYLE_SRC = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
const SESSION_CSS_SRC = fs.readFileSync(path.join(PUB, 'session.css'), 'utf8');

/** A 120-character path, the length the issue says a refusal can carry. */
const LONG_PATH = `/private/tmp/${'a'.repeat(60)}/${'b'.repeat(40)}/codex`.slice(0, 120);

/**
 * The dashboard's launch and connection code in a sandbox: the real
 * `showToast`, `hideToast`, `setConnected`, `doLaunchProject` and the refusal's
 * pointer, with timers that run only when the test says so and honour
 * `clearTimeout` as a browser does.
 * @param {object} launch - What the launch request does: `{refusal}` answers
 *   409 with that body, `{throws}` rejects with that error
 * @returns {object} The page: `toast`, `timers`, `opened`, `escape()`, the lifted functions
 */
function page(launch) {
  const { doc } = makeDocument(['toast']);
  const toast = doc.getElementById('toast');
  // The mini DOM's events carry no key, so the toast's keydown listeners are
  // kept here and called with one.
  const keydown = [];
  const realAdd = toast.addEventListener;
  toast.addEventListener = (type, fn) => { if (type === 'keydown') keydown.push(fn); else realAdd(type, fn); };

  const pending = new Map();
  let nextId = 1;
  const timers = {
    /** @returns {number} How many timers are set and not cancelled. */
    get pending() { return pending.size; },
    /** Fire every timer set and not cancelled, as if any length of time had passed. */
    runAll() {
      while (pending.size > 0) {
        const [id, fn] = pending.entries().next().value;
        pending.delete(id);
        fn();
      }
    }
  };
  const opened = [];
  const ctx = {
    document: {
      getElementById: (id) => doc.getElementById(id),
      createElement: (tag) => doc.createElement(tag),
      querySelector: () => null
    },
    setTimeout: (fn) => { const id = nextId++; pending.set(id, fn); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    state: { connected: true, projects: [{ id: 7, name: 'alpha' }] },
    reconnectPolicy: { begin() {}, end() {} },
    strandedLaunch: null,
    api: async () => ({ authenticated: true, gateActive: true }),
    recoveryModeControlOffer: () => ({ offered: true }),
    openIsolationOverrideSettings: (name) => opened.push(name),
    tcFetch: async () => {
      if (launch && launch.throws) throw launch.throws;
      return { ok: false, status: 409, json: async () => (launch && launch.refusal) || { error: 'refused' } };
    },
    navigateToSession: () => {},
    closeStrandedLaunchModal: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext([
    liftDeclaration(UI_SRC, 'function showToast('),
    liftDeclaration(UI_SRC, 'function hideToast('),
    liftDeclaration(LANDING_SRC, 'function setConnected('),
    liftDeclaration(LANDING_SRC, 'function launchRefusalIsOverridable'),
    liftDeclaration(LANDING_SRC, 'function appendLaunchIsolationPointer'),
    liftDeclaration(LANDING_SRC, 'async function doLaunchProject')
  ].join('\n'), ctx);
  return {
    toast,
    timers,
    opened,
    ctx,
    /** Press Escape with focus in the message. */
    escape() { keydown.forEach((fn) => fn({ key: 'Escape' })); },
    /** @returns {string[]} The message's buttons, by their words. */
    buttons() { return toast.childNodes.filter((c) => c.tagName === 'BUTTON').map((c) => c.textContent); },
    /** @param {string} words - The button's words */
    click(words) { toast.childNodes.find((c) => c.textContent === words).dispatch('click'); }
  };
}

const VERSION_REFUSAL = { error: `TangleClaw asked ${LONG_PATH} for its version and got no answer.`, code: 'LAUNCH_ISOLATION_UNVERIFIED', reasonCode: 'version_unknown' };

describe('a refused launch stays until it is dismissed (#2339)', () => {
  for (const [branch, launch, words] of [
    ['the server\'s refusal', { refusal: VERSION_REFUSAL }, /^Launch failed: TangleClaw asked \/private\/tmp\//],
    ['a launch request that failed', { throws: new Error('socket hang up') }, /^Launch failed: socket hang up$/]
  ]) {
    it(`${branch}: no time hides it, and Dismiss does, leaving nothing behind`, async () => {
      const p = page(launch);
      await p.ctx.doLaunchProject('alpha', 'default');
      assert.match(p.toast.textContent, words);
      assert.match(p.toast.className, /\btoast-warn\b/);
      assert.equal(p.timers.pending, 0, 'no timer is set for it');
      p.timers.runAll();
      assert.equal(p.toast.classList.contains('visible'), true);
      const dismiss = p.toast.childNodes.find((c) => c.textContent === 'Dismiss');
      assert.equal(dismiss.type, 'button');
      p.click('Dismiss');
      assert.equal(p.toast.classList.contains('visible'), false);
      assert.equal(p.toast.childNodes.length, 0, 'no button or note is left in a message moved off screen');
    });

    it(`${branch}: Escape with focus in the message dismisses it`, async () => {
      const p = page(launch);
      await p.ctx.doLaunchProject('alpha', 'default');
      p.escape();
      assert.equal(p.toast.classList.contains('visible'), false);
      assert.equal(p.toast.childNodes.length, 0);
    });
  }

  it('Escape does nothing to a message that is not one to dismiss', () => {
    const p = page();
    p.ctx.showToast('Refusal', 'warn', 0, { sticky: true });
    p.click('Dismiss');
    p.ctx.showToast('Reconnected', 'ok', 3000);
    p.escape();
    assert.equal(p.toast.classList.contains('visible'), true);
    assert.equal(p.toast.textContent, 'Reconnected');
  });

  it('the way to the override closes the message as it opens Settings', async () => {
    const p = page({ refusal: VERSION_REFUSAL });
    await p.ctx.doLaunchProject('alpha', 'default');
    assert.deepEqual(p.buttons(), ['Open launch isolation settings', 'Dismiss']);
    p.click('Open launch isolation settings');
    assert.deepEqual(p.opened, ['alpha']);
    assert.equal(p.toast.classList.contains('visible'), false);
    assert.equal(p.toast.childNodes.length, 0);
  });
});

describe('one owner of the toast: no message is hidden by another\'s timer (#2339)', () => {
  it('a message shown just before a refusal cannot hide it', async () => {
    const p = page({ refusal: VERSION_REFUSAL });
    // Each of these sets a timer of its own; every one is fired afterwards.
    p.ctx.showToast('Copied: ssh -i key me@host', 'ok', 5000);
    p.ctx.setConnected(false);
    p.ctx.setConnected(true);
    p.ctx.showToast('Repaired 1 project(s)', 'ok', 3000);
    await p.ctx.doLaunchProject('alpha', 'default');
    p.timers.runAll();
    assert.equal(p.toast.classList.contains('visible'), true);
    assert.match(p.toast.textContent, /^Launch failed: /);
    assert.deepEqual(p.buttons(), ['Open launch isolation settings', 'Dismiss'], 'and it keeps its buttons');
  });

  it('a message shown after a refusal replaces it, takes away what the refusal added, and hides on its own time', async () => {
    const p = page({ refusal: VERSION_REFUSAL });
    await p.ctx.doLaunchProject('alpha', 'default');
    p.ctx.showToast('Reconnected', 'ok', 3000);
    assert.equal(p.toast.textContent, 'Reconnected');
    assert.match(p.toast.className, /\btoast-ok\b.*\bvisible\b/);
    assert.equal(p.toast.childNodes.length, 0, 'nothing the refusal added remains');
    assert.equal(p.timers.pending, 1);
    p.timers.runAll();
    assert.equal(p.toast.classList.contains('visible'), false);
  });

  it('a newer refusal replaces an older one: one Dismiss, and the newer words', async () => {
    const p = page({ refusal: VERSION_REFUSAL });
    await p.ctx.doLaunchProject('alpha', 'default');
    p.ctx.showToast('Launch failed: busy', 'warn', 0, { sticky: true });
    assert.equal(p.toast.textContent, 'Launch failed: busy');
    assert.deepEqual(p.buttons(), ['Dismiss']);
  });

  it('a timed message still shows its words and kind, and hides after its time', () => {
    const p = page();
    p.ctx.showToast('Tunnel killed — port 4100 released', 'ok', 5000);
    assert.equal(p.toast.textContent, 'Tunnel killed — port 4100 released');
    assert.match(p.toast.className, /\btoast-ok\b.*\bvisible\b/);
    assert.equal(p.toast.childNodes.length, 0, 'a timed message has no Dismiss');
    p.timers.runAll();
    assert.equal(p.toast.classList.contains('visible'), false);
  });

  it('no dashboard code writes the toast except its owner', () => {
    for (const [file, src] of [['landing.js', LANDING_SRC], ['ui.js', UI_SRC]]) {
      const outside = src.replace(liftDeclaration(UI_SRC, 'function showToast('), '').replace(liftDeclaration(UI_SRC, 'function hideToast('), '');
      assert.doesNotMatch(outside, /getElementById\('toast'\)/, `${file} reaches the toast only through showToast and hideToast`);
    }
  });
});

describe('a long refusal fits a narrow screen (#2339)', () => {
  /**
   * The body of a top-level CSS rule.
   * @param {string} css - Stylesheet source
   * @param {string} selector - The rule's exact selector
   * @returns {string}
   */
  const rule = (css, selector) => {
    const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
    assert.ok(m, `${selector} must exist`);
    return m[1];
  };

  it('breaks a long word inside the toast\'s padding, on the dashboard and the session page', () => {
    assert.match(rule(STYLE_SRC, '.toast'), /overflow-wrap: anywhere;/);
    assert.match(rule(SESSION_CSS_SRC, '.toast'), /overflow-wrap: anywhere;/);
  });

  it('puts each of a message\'s buttons on its own line, at a touch target\'s height', () => {
    const action = rule(STYLE_SRC, '.toast .toast-action');
    assert.match(action, /display: block;/);
    assert.match(action, /min-height: 44px;/);
  });
});
