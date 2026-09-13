'use strict';

// `public/account-setup.html` — the page an install with no account shows
// (#1420). Its script runs in a sandbox with a stubbed DOM and `fetch`, so the
// outcome of each server answer is asserted as where the page sends the person.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'account-setup.html'), 'utf8');
const SCRIPT = HTML.slice(HTML.lastIndexOf('<script>') + '<script>'.length, HTML.lastIndexOf('</script>'));

/**
 * Load the page script with the given form values and server answer, submit,
 * and report what happened.
 * @param {object} opts
 * @param {string} [opts.password]
 * @param {string} [opts.confirm]
 * @param {{status:number, body:object}} [opts.answer]
 * @returns {Promise<{ fetches: object[], nav: string[], error: string }>}
 */
async function submit({ password = 'a-long-enough-password', confirm, answer = { status: 200, body: {} } }) {
  const values = { u: 'jason', p: password, c: confirm === undefined ? password : confirm };
  const elements = {};
  let onSubmit = null;
  const el = (id) => {
    if (!elements[id]) {
      elements[id] = {
        id, value: values[id], textContent: '', disabled: false,
        focus() {},
        addEventListener(ev, fn) { if (ev === 'submit') onSubmit = fn; }
      };
    }
    return elements[id];
  };
  const fetches = [];
  const nav = [];
  const sandbox = {
    document: { getElementById: el },
    window: { location: { replace: (u) => nav.push(u) } },
    fetch: async (url, init) => {
      fetches.push({ url, body: JSON.parse(init.body) });
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
    },
    JSON, Promise
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await onSubmit({ preventDefault() {} });
  return { fetches, nav, error: el('error').textContent };
}

describe('public/account-setup.html (#1420)', () => {
  it('posts the username and password to the first-account route, then goes to the dashboard', async () => {
    const r = await submit({ answer: { status: 200, body: { username: 'jason' } } });
    assert.equal(r.fetches.length, 1);
    assert.equal(r.fetches[0].url, '/api/auth/set-password');
    assert.deepEqual(r.fetches[0].body, { username: 'jason', password: 'a-long-enough-password' });
    assert.deepEqual(r.nav, ['/']);
  });

  it('refuses to submit when the two passwords differ', async () => {
    const r = await submit({ confirm: 'something-else-entirely' });
    assert.equal(r.fetches.length, 0);
    assert.match(r.error, /do not match/);
  });

  it('goes to the login page on a 401 — how a signed-out page learns an account now exists', async () => {
    const r = await submit({ answer: { status: 401, body: { code: 'UNAUTHENTICATED', error: 'Sign in to continue.' } } });
    assert.deepEqual(r.nav, ['/login']);
  });

  it('goes to the login page on ACCOUNT_EXISTS — an account landed between the gate and the write', async () => {
    const r = await submit({ answer: { status: 409, body: { code: 'ACCOUNT_EXISTS', error: 'exists' } } });
    assert.deepEqual(r.nav, ['/login']);
  });

  it('stays and shows the server\'s reason for a weak password', async () => {
    const r = await submit({ answer: { status: 400, body: { code: 'WEAK_PASSWORD', error: 'Password is too common' } } });
    assert.deepEqual(r.nav, []);
    assert.equal(r.error, 'Password is too common');
  });
});
