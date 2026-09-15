'use strict';

/**
 * #1514 — the browser half of the message body limit.
 *
 * The helpers `public/api-helper.js` publishes are RUN (lifted into a sandbox,
 * the `_api-helper-globals` convention), and the session page's send handlers
 * are lifted out of `public/session.js` and run against an `api()` that refuses
 * the way the real one does on a 413 — so what is pinned is the sentence the
 * operator reads, not the presence of a branch.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const loadApiHelperGlobals = require('./_api-helper-globals');
const { makeDocument } = require('./_mini-dom');

const G = loadApiHelperGlobals();
const SESSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
const LIMIT = 64 * 1024;

/**
 * Slice a top-level function out of session.js by brace matching.
 * @param {string} decl - Declaration start, e.g. `async function sendCommand(`.
 * @returns {string} The function source.
 */
function functionSource(decl) {
  const start = SESSION_SRC.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = SESSION_SRC.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < SESSION_SRC.length; i++) {
    if (SESSION_SRC[i] === '{') depth++;
    else if (SESSION_SRC[i] === '}' && --depth === 0) return SESSION_SRC.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * Evaluate lifted session.js functions in a sandbox with the given globals.
 * @param {string[]} decls - Declarations to lift.
 * @param {object} globals - What the functions reach for.
 * @returns {object} The sandbox, each lifted function a property on it.
 */
function lift(decls, globals) {
  const names = decls.map((d) => d.replace(/^(async )?function /, '').replace(/\(.*$/, ''));
  const ctx = vm.createContext({ console, encodeURIComponent, parseInt, JSON, Number, ...globals });
  vm.runInContext(`${decls.map(functionSource).join('\n')}\n${names.map((n) => `this.${n} = ${n};`).join('\n')}`, ctx);
  return ctx;
}

/**
 * An api()/apiMutate() pair that refuses with the server's 413 shape, parking
 * the body on `lastBody` exactly as the shared helper does. Records each call.
 * @param {object} body - The refusal body.
 * @returns {{api: Function, apiMutate: Function, calls: Array<object>}}
 */
function refusing413(body) {
  const calls = [];
  const api = async () => {
    api.lastError = body.error;
    api.lastErrorCode = body.code;
    api.lastBody = body;
    return null;
  };
  api.lastError = null;
  api.lastErrorCode = null;
  api.lastBody = null;
  const apiMutate = async (url, method, payload) => { calls.push({ url, payload }); return api(); };
  return { api, apiMutate, calls };
}

const TOO_LARGE = {
  error: 'Request body too large: 71680 bytes, limit is 65536 bytes',
  code: 'BODY_TOO_LARGE',
  limitBytes: LIMIT,
  receivedBytes: 70 * 1024
};

describe('api-helper — message size helpers (#1514)', () => {
  it('tcUtf8Bytes counts what the server counts, not UTF-16 units', () => {
    assert.equal(G.tcUtf8Bytes('abc'), 3);
    assert.equal(G.tcUtf8Bytes('é'), Buffer.byteLength('é'));
    assert.equal(G.tcUtf8Bytes('中文'), Buffer.byteLength('中文'));
    assert.equal(G.tcUtf8Bytes('😀'), Buffer.byteLength('😀'), 'a surrogate pair is 4 bytes, not 6');
    assert.equal(G.tcUtf8Bytes('\ud800'), 3, 'a lone surrogate is encoded as U+FFFD');
  });

  it('tcFormatKB keeps whole kilobytes whole and rounds anything else up', () => {
    assert.equal(G.tcFormatKB(LIMIT), '64 KB');
    assert.equal(G.tcFormatKB(LIMIT + 1), '64.1 KB');
    assert.equal(G.tcFormatKB(1), '0.1 KB');
  });

  it('tcMessageSize measures the JSON body and grades it ok / warn / over', () => {
    const small = G.tcMessageSize({ message: 'hi' }, LIMIT);
    assert.equal(small.bytes, Buffer.byteLength(JSON.stringify({ message: 'hi' })));
    assert.equal(small.level, 'ok');
    assert.equal(small.text, '0.1 KB of 64 KB');

    const near = G.tcMessageSize({ message: 'x'.repeat(55 * 1024) }, LIMIT);
    assert.equal(near.level, 'warn');
    assert.match(near.text, /of 64 KB — close to the limit$/);

    const over = G.tcMessageSize({ message: 'x'.repeat(LIMIT) }, LIMIT);
    assert.equal(over.level, 'over', 'the envelope counts: a limit-sized message is over');
    assert.match(over.text, /too long to send/);
  });

  it('tcMessageSize shows nothing until the limit is served — no guessed number', () => {
    const size = G.tcMessageSize({ message: 'x'.repeat(100 * 1024) }, undefined);
    assert.equal(size.level, 'unknown');
    assert.equal(size.text, '');
  });

  it('tcApiFailureText renders a 413 as "message is X KB, limit is 64 KB"', () => {
    const { api } = refusing413(TOO_LARGE);
    api.lastError = TOO_LARGE.error; api.lastErrorCode = TOO_LARGE.code; api.lastBody = TOO_LARGE;
    assert.equal(G.tcApiFailureText(api, 'x'), 'message is 70 KB, limit is 64 KB');
    api.lastBody = { ...TOO_LARGE, receivedBytes: 65600, receivedBytesIsLowerBound: true };
    assert.equal(G.tcApiFailureText(api, 'x'), 'message is more than 64.1 KB, limit is 64 KB');
  });

  it('tcApiFailureText falls back to the server words, and ignores a stale 413 body', () => {
    const api = { lastError: 'Connection lost.', lastErrorCode: null, lastBody: TOO_LARGE };
    assert.equal(G.tcApiFailureText(api, 'x'), 'Connection lost.', 'lastBody outlives a connection loss; the code does not');
    assert.equal(G.tcApiFailureText({ lastError: null, lastErrorCode: null, lastBody: null }, 'fallback'), 'fallback');
  });

  it('the Medusa control keeps the served limit, and a toggle response without it does not blank it', () => {
    const ids = G.tcMedusaIds('');
    const { doc } = makeDocument(Object.values(ids).filter(Boolean));
    doc.addEventListener = () => {};
    const c = G.tcCreateMedusaControl({ doc, api: async () => null, apiBase: '/api/sessions/p/medusa', ids });
    c.applyStatus({ state: 'listening', unread: 0, messageLimitBytes: LIMIT });
    assert.equal(c.state.messageLimitBytes, LIMIT);
    c.applyStatus({ state: 'listening', unread: 0 });
    assert.equal(c.state.messageLimitBytes, LIMIT);
  });
});

describe('session.js — send surfaces say why a message was too long (#1514)', () => {
  it('sendCommand toasts the 413 sizes and keeps the typed command', async () => {
    const { api, apiMutate } = refusing413(TOO_LARGE);
    const toasts = [];
    const input = { value: 'long command' };
    const ctx = lift(['async function sendCommand('], {
      api, apiMutate, projectName: 'demo', window: G,
      sessionState: { ended: false },
      document: { getElementById: () => input },
      addToHistory: () => assert.fail('a refused command is not history'),
      showBannerActionToast: (msg, isError) => toasts.push({ msg, isError })
    });
    await ctx.sendCommand('long command');
    assert.deepEqual(toasts, [{ msg: "Couldn't send command: message is 70 KB, limit is 64 KB", isError: true }]);
    assert.equal(input.value, 'long command');
  });

  it('continueMedusaLoop refuses an over-limit message before sending, with the sizes', async () => {
    const { api, apiMutate, calls } = refusing413(TOO_LARGE);
    const toasts = [];
    const ctx = lift(['async function continueMedusaLoop('], {
      api, apiMutate, projectName: 'demo', window: G,
      sessionState: { medusa: { messageLimitBytes: LIMIT, loops: [] } },
      showBannerActionToast: (msg, isError) => toasts.push({ msg, isError })
    });
    await ctx.continueMedusaLoop('loop-1', 'f'.repeat(70 * 1024));
    assert.equal(calls.length, 0, 'nothing is posted');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].msg, /^Couldn't send feedback: message is 70\.\d KB, limit is 64 KB$/);
  });

  it('continueMedusaLoop renders a server 413 the same way when no limit was known to check against', async () => {
    const { api, apiMutate, calls } = refusing413(TOO_LARGE);
    const toasts = [];
    const ctx = lift(['async function continueMedusaLoop('], {
      api, apiMutate, projectName: 'demo', window: G,
      sessionState: { medusa: { loops: [] } },
      showBannerActionToast: (msg) => toasts.push(msg)
    });
    await ctx.continueMedusaLoop('loop-1', 'f'.repeat(70 * 1024));
    assert.equal(calls.length, 1);
    assert.deepEqual(toasts, ["Couldn't send feedback: message is 70 KB, limit is 64 KB"]);
  });

  /**
   * The loop modal's elements, with the given task text.
   * @param {string} task - Task textarea value.
   * @returns {{document: object, els: object}}
   */
  function loopModal(task) {
    const classes = () => { const set = new Set(); return { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), has: (c) => set.has(c) }; };
    const els = {
      medusaLoopTarget: { value: 'peer-ws', selectedIndex: 0, options: [{ text: 'Peer' }] },
      medusaLoopTask: { value: task, focus() {} },
      medusaLoopDone: { value: 'done', focus() {} },
      medusaLoopMode: { value: 'supervised' },
      medusaLoopMaxRounds: { value: '10' },
      medusaLoopMaxMinutes: { value: '480' },
      medusaLoopLaunchBtn: { disabled: false, textContent: '' },
      medusaLoopError: { hidden: true, textContent: '' },
      medusaLoopSize: { textContent: '', classList: classes() }
    };
    return { document: { getElementById: (id) => els[id] || null }, els };
  }

  const LOOP_FNS = ['async function launchMedusaLoop(', 'function medusaLoopPayload(', 'function renderMedusaSizeLine('];

  it('launchMedusaLoop blocks an over-limit task with the sizes in the modal error, and flags the count', async () => {
    const { api, apiMutate, calls } = refusing413(TOO_LARGE);
    const { document, els } = loopModal('t'.repeat(70 * 1024));
    const ctx = lift(LOOP_FNS, {
      api, apiMutate, projectName: 'demo', window: G, document,
      sessionState: { medusa: { messageLimitBytes: LIMIT } }
    });
    await ctx.launchMedusaLoop();
    assert.equal(calls.length, 0, 'nothing is posted');
    assert.equal(els.medusaLoopError.hidden, false);
    assert.match(els.medusaLoopError.textContent, /^message is 70\.\d KB, limit is 64 KB$/);
    assert.match(els.medusaLoopSize.textContent, /of 64 KB — too long to send/);
    assert.ok(els.medusaLoopSize.classList.has('is-over'));
  });

  it('launchMedusaLoop posts the body it measured, and renders a server 413 with the sizes', async () => {
    const { api, apiMutate, calls } = refusing413(TOO_LARGE);
    const { document, els } = loopModal('small task');
    const ctx = lift(LOOP_FNS, {
      api, apiMutate, projectName: 'demo', window: G, document,
      sessionState: { medusa: { messageLimitBytes: LIMIT } }
    });
    await ctx.launchMedusaLoop();
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), {
      target: 'peer-ws', task: 'small task', doneCriteria: 'done', mode: 'supervised',
      guards: { maxRounds: 10, maxWallTimeSeconds: 480 * 60 }
    });
    assert.equal(els.medusaLoopError.textContent, "Couldn't open loop: message is 70 KB, limit is 64 KB");
    assert.equal(els.medusaLoopSize.textContent, '0.2 KB of 64 KB');
  });
});
