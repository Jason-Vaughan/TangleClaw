'use strict';

/*
 * The launch panel's Fire button (#1825 B3, Architect F5). The REAL
 * `wireStartupFires` is lifted out of public/ui.js and run against a fake
 * list, a fake document and a scripted `api`, so the assertions follow one
 * click through every hop: the current revision is read first, the POST
 * carries the row's ids and that revision under a fresh key, the open-install
 * token rides when the install has one, the outcome is shown, and the panel
 * re-reads whether the fire was accepted or refused.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

/**
 * Slice a top-level function out of source text by brace-matching.
 * @param {string} src - Source text.
 * @param {string} decl - Declaration to find.
 * @returns {string}
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
  return assert.fail(`${decl} body must close`);
}

/**
 * A sandbox with one rendered Fire button and a scripted server.
 * @param {object} [opts]
 * @param {object|null} [opts.prompt] - What GET /api/startup-prompt answers.
 * @param {object|null} [opts.fireAnswer] - What the POST answers (null = refused).
 * @param {string|null} [opts.openToken] - The open-install token.
 * @returns {object} `{click, calls, statuses, refreshes, btn}`
 */
function sandbox({ prompt = { revision: 4, text: 'x' }, fireAnswer = { fire: { id: 7, outcome: 'accepted', reasonCode: null }, duplicate: false }, openToken = 'tok' } = {}) {
  const calls = [];
  const statuses = [];
  const refreshes = [];
  let handler = null;
  const btn = {
    disabled: false,
    dataset: { startupFire: '9', sessionId: '42' },
    addEventListener: (type, fn) => { assert.equal(type, 'click'); handler = fn; }
  };
  const list = { querySelectorAll: (sel) => { assert.equal(sel, '[data-startup-fire]'); return [btn]; } };
  const api = async (url, opts) => {
    calls.push({ url, opts });
    let body = null;
    if (url === '/api/startup-prompt' && (!opts || !opts.method)) body = prompt;
    else if (url === '/api/auth/me') body = { openInstallToken: openToken };
    else if (url === '/api/sessions/My%20Project/startup-prompt/fire' && opts.method === 'POST') body = fireAnswer;
    api.lastError = body === null ? 'refused by the test' : null;
    return body;
  };
  api.lastError = null;
  const ctx = {
    api, Number, JSON, Date, Math, encodeURIComponent,
    projectRulesTargetId: 3, projectRulesTargetName: 'My Project',
    _setProjectRulesStatus: (text, ok) => statuses.push({ text, ok }),
    refreshProjectLaunchSequences: async (id) => { refreshes.push(id); }
  };
  vm.createContext(ctx);
  vm.runInContext(liftFunction(UI_SRC, 'function wireStartupFires('), ctx);
  ctx.wireStartupFires(list);
  assert.ok(handler, 'the button was wired');
  return { click: () => handler(), calls, statuses, refreshes, btn };
}

describe('the launch panel\'s Fire button (#1825 B3)', () => {
  it('reads the current revision first, then fires at the row\'s launch with that revision under a fresh key', async () => {
    const sb = sandbox();
    await sb.click();
    assert.equal(sb.calls[0].url, '/api/startup-prompt');
    const post = sb.calls.find((c) => c.opts && c.opts.method === 'POST');
    assert.ok(post, 'the fire was posted');
    assert.equal(post.url, '/api/sessions/My%20Project/startup-prompt/fire');
    const body = JSON.parse(post.opts.body);
    assert.equal(body.sessionId, 42);
    assert.equal(body.sequenceId, 9);
    assert.equal(body.expectedRevision, 4, 'the revision the server holds NOW, not one baked into the markup');
    assert.match(body.idempotencyKey, /^[A-Za-z0-9_-]{8,128}$/, 'a key the service accepts');
    assert.equal(post.opts.headers['Content-Type'], 'application/json');
    assert.equal(post.opts.headers['X-TC-Open-Token'], 'tok');
    assert.deepEqual(sb.statuses, [{ text: 'Startup prompt fire: accepted', ok: true }]);
    assert.deepEqual(sb.refreshes, [3], 'the panel re-reads');
    const again = sandbox();
    await again.click();
    assert.notEqual(JSON.parse(again.calls.find((c) => c.opts && c.opts.method === 'POST').opts.body).idempotencyKey, body.idempotencyKey, 'each click is a new attempt');
  });

  it('sends no open-install token on an armed install', async () => {
    const sb = sandbox({ openToken: null });
    await sb.click();
    const post = sb.calls.find((c) => c.opts && c.opts.method === 'POST');
    assert.equal(post.opts.headers['X-TC-Open-Token'], undefined);
  });

  it('shows a blocker as the fire\'s own typed reason, not as a success', async () => {
    const sb = sandbox({ fireAnswer: null });
    await sb.click();
    assert.equal(sb.statuses.length, 1);
    assert.equal(sb.statuses[0].ok, false);
    assert.equal(sb.statuses[0].text, 'refused by the test');
    assert.equal(sb.btn.disabled, false, 'the button is usable again');
    assert.deepEqual(sb.refreshes, [3], 'the panel still re-reads: the refusal is a fact about the row now');
  });

  it('fires nothing when the prompt cannot be read', async () => {
    const sb = sandbox({ prompt: null });
    await sb.click();
    assert.equal(sb.calls.some((c) => c.opts && c.opts.method === 'POST'), false);
    assert.equal(sb.statuses[0].ok, false);
    assert.equal(sb.btn.disabled, false);
  });
});
