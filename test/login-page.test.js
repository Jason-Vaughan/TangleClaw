'use strict';

// `public/login.html` — what the sign-in page offers in each gate state (#1420).
// Its script runs in a sandbox with a stubbed DOM and `fetch`, so each state is
// asserted as what the person sees: the form, a notice, the recovery link.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
const SCRIPT = HTML.slice(HTML.lastIndexOf('<script>') + '<script>'.length, HTML.lastIndexOf('</script>'));

/**
 * A stub element: enough of the DOM for the page script.
 * @param {string} tag
 * @returns {object}
 */
function stubElement(tag) {
  const node = {
    tag, hidden: false, textContent: '', href: null, value: '', disabled: false, children: [],
    focus() {},
    addEventListener() {},
    appendChild(child) { node.children.push(child); return child; }
  };
  return node;
}

/**
 * Load the page with `GET /api/auth/me` answering `me` and report what it shows.
 * @param {object|null|Error} me - The JSON body, `null` for a non-2xx answer, or
 *   an Error to reject the fetch
 * @returns {Promise<{ formHidden: boolean, subHidden: boolean, recoverHidden: boolean,
 *   stateHidden: boolean, text: string, link: string|null, fetches: string[] }>}
 */
async function load(me) {
  const elements = {};
  for (const id of ['f', 'error', 'go', 'u', 'p', 'sub', 'state', 'recover']) elements[id] = stubElement(id);
  // The static markup's starting visibility, which the script builds on.
  elements.state.hidden = /id="state"[^>]*hidden/.test(HTML);
  elements.recover.hidden = /id="recover"[^>]*hidden/.test(HTML);
  const fetches = [];
  const sandbox = {
    document: {
      getElementById: (id) => elements[id],
      createElement: stubElement,
      createTextNode: (t) => ({ tag: '#text', textContent: t })
    },
    window: { location: { replace() {} } },
    fetch: async (url) => {
      fetches.push(url);
      if (me instanceof Error) throw me;
      return { ok: me !== null, status: me === null ? 500 : 200, json: async () => me };
    },
    JSON, Promise, Object
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await new Promise((r) => setImmediate(r));
  const state = elements.state;
  const text = [state.textContent, ...state.children.map((c) => c.textContent)].join('');
  const a = state.children.find((c) => c.tag === 'a');
  return {
    formHidden: elements.f.hidden,
    subHidden: elements.sub.hidden,
    recoverHidden: elements.recover.hidden,
    stateHidden: state.hidden,
    text,
    link: a ? a.href : null,
    fetches
  };
}

describe('public/login.html — what the page offers per gate state (#1420)', () => {
  it('starts with the recovery link and the notice hidden in the markup', () => {
    // Visible only once the script learns the state: a page whose script never
    // ran must not advertise a recovery page that challenges back to itself.
    assert.match(HTML, /<p class="alt" id="recover" hidden>/);
    assert.match(HTML, /href="\/recover"/);
    assert.match(HTML, /<p class="notice" id="state" role="status" hidden>/);
  });

  it('asks the gate state from /api/auth/me', async () => {
    const r = await load({ gateState: 'armed' });
    assert.deepEqual(r.fetches, ['/api/auth/me']);
  });

  it('armed: the form, and the recovery link', async () => {
    const r = await load({ gateState: 'armed', authenticated: false });
    assert.equal(r.formHidden, false);
    assert.equal(r.recoverHidden, false);
    assert.equal(r.stateHidden, true);
  });

  it('locked: says every account is disabled and names the terminal command, with no form and no link', async () => {
    const r = await load({ gateState: 'locked' });
    assert.equal(r.formHidden, true, 'a sign-in cannot succeed, so the form is not offered');
    assert.equal(r.recoverHidden, true, '/recover does not answer in locked');
    assert.equal(r.stateHidden, false);
    assert.match(r.text, /Every account on this install is disabled/);
    assert.match(r.text, /reset-admin\.js --store --user <name>/);
    assert.match(r.text, /docs\/recovery\.md/);
  });

  it('unreadable: says the login settings cannot be read, not that the password is wrong', async () => {
    const r = await load({ gateState: 'unreadable' });
    assert.equal(r.formHidden, true);
    assert.equal(r.recoverHidden, true);
    assert.match(r.text, /cannot read its own login settings/);
  });

  for (const gateState of ['fallback', 'open']) {
    it(`${gateState}: no sign-in is asked for here, with a way on to the dashboard`, async () => {
      const r = await load({ gateState });
      assert.equal(r.formHidden, true);
      assert.equal(r.recoverHidden, true);
      assert.equal(r.link, '/');
      assert.match(r.text, gateState === 'fallback' ? /Caddy's password guards this install/ : /does not ask for/);
    });
  }

  for (const [label, me] of [
    ['a failed request', new Error('offline')],
    ['a non-2xx answer', null],
    ['an unknown state', { gateState: 'something-new' }],
    ['no state at all', {}],
    ['a state named like an Object property', { gateState: 'constructor' }]
  ]) {
    it(`${label}: the plain form, and no recovery link`, async () => {
      const r = await load(me);
      assert.equal(r.formHidden, false);
      assert.equal(r.recoverHidden, true);
      assert.equal(r.stateHidden, true);
    });
  }

  it('builds the notice from text nodes, never markup', () => {
    // Comments stripped, so the probe measures the program and not the prose.
    const code = SCRIPT.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
