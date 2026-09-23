'use strict';

/*
 * The dashboard's startup prompt editor (#1825). The REAL `loadStartupPrompt`
 * and `saveStartupPrompt` are lifted out of public/landing.js and run against a
 * fake document and a fake `api`, so the assertions follow one edit through
 * every hop: what the widget renders, what the collector reads back from that
 * markup, and what the PUT carries to the server.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public');
const LANDING_SRC = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

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
 * A sandbox holding the editor's functions, a fake DOM and a scripted `api`.
 * @param {object} prompt - What GET /api/startup-prompt returns.
 * @param {object[]} projects - What GET /api/projects returns.
 * @param {object} [opts]
 * @param {object|null} [opts.putAnswer] - What the PUT resolves to (null = refused).
 * @param {string|null} [opts.openToken] - The open-install token /api/auth/me issues.
 * @returns {object} The sandbox.
 */
function sandbox(prompt, projects, { putAnswer = null, openToken = 'tok', putRefusal = 'The startup prompt changed since revision 3. Reload it and try again.' } = {}) {
  const els = {};
  for (const id of ['startupPromptEditor', 'startupPromptRevision', 'startupPromptFirers', 'startupPromptStatus', 'startupPromptSaveBtn']) {
    els[id] = {
      id, value: '', textContent: '', innerHTML: '', className: '', disabled: false,
      classList: { remove() {}, add() {} }
    };
  }
  const calls = [];
  /**
   * The route's answer for a request, as the server would give it.
   * @param {string} url - Request URL.
   * @param {object} [opts] - fetch options.
   * @returns {*} The body, or null for a refusal.
   */
  const answer = (url, opts) => {
    if (url === '/api/startup-prompt' && (!opts || !opts.method)) return prompt;
    if (url === '/api/projects') return { projects };
    if (url === '/api/auth/me') return { openInstallToken: openToken };
    if (url === '/api/startup-prompt' && opts.method === 'PUT') return putAnswer;
    return null;
  };
  // Mirrors public/api-helper.js: a refusal sets lastError, and EVERY success
  // clears it. A fake that never cleared it could not see a caller reading
  // lastError after a later, successful request.
  const api = async (url, opts) => {
    calls.push({ url, opts });
    const body = answer(url, opts);
    api.lastError = body === null ? putRefusal : null;
    return body;
  };
  api.lastError = null;
  const document = {
    getElementById: (id) => els[id] || null,
    // Reads the checkboxes back out of the markup the widget rendered, so the
    // collector is tested against real output rather than a hand-built list.
    querySelectorAll: (selector) => {
      assert.equal(selector, '#startupPromptFirers input[type="checkbox"]:checked');
      return [...els.startupPromptFirers.innerHTML.matchAll(/<input type="checkbox" value="(\d+)" checked>/g)]
        .map((m) => ({ value: m[1] }));
    }
  };
  const ctx = { state: {}, api, document, calls, els, JSON, Number, Set, Array, Promise };
  vm.createContext(ctx);
  vm.runInContext([
    liftFunction(LANDING_SRC, 'function esc('),
    liftFunction(LANDING_SRC, 'async function loadStartupPrompt('),
    liftFunction(LANDING_SRC, 'async function saveStartupPrompt(')
  ].join('\n'), ctx);
  return ctx;
}

const PROMPT = { revision: 3, text: 'read your launch context: run tc start next', firerProjectIds: [2], digest: 'x' };
const PROJECTS = [{ id: 2, name: 'Zeta PM' }, { id: 1, name: 'alpha' }, { id: 5, name: '<b>evil</b>' }];

describe('startup prompt editor (#1825)', () => {
  it('the markup and the save wiring exist', () => {
    for (const id of ['startupPromptEditor', 'startupPromptFirers', 'startupPromptSaveBtn', 'startupPromptStatus']) {
      assert.ok(INDEX.includes(`id="${id}"`), id);
    }
    assert.match(UI_SRC, /\$\('startupPromptSaveBtn'\)\.addEventListener\('click', saveStartupPrompt\)/);
    assert.match(LANDING_SRC, /loadStartupPrompt\(\),/, 'loaded with the page');
  });

  it('renders the text, the revision and one checkbox per project, with listed firers checked', async () => {
    const ctx = sandbox(PROMPT, PROJECTS);
    await ctx.loadStartupPrompt();
    assert.equal(ctx.els.startupPromptEditor.value, PROMPT.text);
    assert.equal(ctx.els.startupPromptRevision.textContent, '(revision 3)');
    const html = ctx.els.startupPromptFirers.innerHTML;
    assert.match(html, /value="2" checked> Zeta PM/);
    assert.match(html, /value="1"> alpha/);
    assert.ok(html.indexOf('alpha') < html.indexOf('Zeta PM'), 'sorted by name');
    assert.ok(!html.includes('<b>evil</b>'), 'project names are escaped');
  });

  it('saves the edited text, the checked firers and the loaded revision, with the page token and JSON type', async () => {
    const ctx = sandbox(PROMPT, PROJECTS, { putAnswer: { revision: 4 } });
    await ctx.loadStartupPrompt();
    ctx.els.startupPromptEditor.value = 'edited';
    ctx.els.startupPromptFirers.innerHTML = ctx.els.startupPromptFirers.innerHTML
      .replace('value="1">', 'value="1" checked>');
    await ctx.saveStartupPrompt();
    const put = ctx.calls.find((c) => c.opts && c.opts.method === 'PUT');
    assert.ok(put, 'a PUT was sent');
    assert.equal(put.url, '/api/startup-prompt');
    assert.equal(put.opts.headers['Content-Type'], 'application/json');
    assert.equal(put.opts.headers['X-TC-Open-Token'], 'tok');
    const body = JSON.parse(put.opts.body);
    assert.equal(body.text, 'edited');
    assert.equal(body.expectedRevision, 3);
    assert.deepEqual(body.firerProjectIds.slice().sort(), [1, 2]);
    assert.equal(ctx.els.startupPromptStatus.textContent, 'Saved as revision 4');
    assert.equal(ctx.els.startupPromptSaveBtn.disabled, false);
  });

  it('sends no page token on an armed install, where api() carries the CSRF header', async () => {
    const ctx = sandbox(PROMPT, PROJECTS, { putAnswer: { revision: 4 }, openToken: null });
    await ctx.loadStartupPrompt();
    await ctx.saveStartupPrompt();
    const put = ctx.calls.find((c) => c.opts && c.opts.method === 'PUT');
    assert.equal(put.opts.headers['X-TC-Open-Token'], undefined);
  });

  it('on a refusal, keeps the typed text and ticks, and says so', async () => {
    const ctx = sandbox(PROMPT, PROJECTS, { putAnswer: null });
    await ctx.loadStartupPrompt();
    ctx.els.startupPromptEditor.value = 'my unsaved edit';
    const ticks = ctx.els.startupPromptFirers.innerHTML.replace('value="1">', 'value="1" checked>');
    ctx.els.startupPromptFirers.innerHTML = ticks;
    await ctx.saveStartupPrompt();
    assert.equal(ctx.els.startupPromptEditor.value, 'my unsaved edit', 'the refusal does not overwrite the text');
    assert.equal(ctx.els.startupPromptFirers.innerHTML, ticks, 'nor the ticks');
    assert.match(ctx.els.startupPromptStatus.textContent, /Your edits are kept/);
    assert.match(ctx.els.startupPromptStatus.textContent, /^The startup prompt changed since revision 3/,
      'the server\'s own reason reaches the operator, even though a later request succeeded');
    assert.equal(ctx.els.startupPromptStatus.className, 'rules-status rules-status-err');
    assert.equal(ctx.state.startupPrompt.revision, 3, 'the revision did not move, so nothing claims it did');
  });

  it('shows the server\'s reason for an invalid prompt', async () => {
    const ctx = sandbox(PROMPT, PROJECTS, { putAnswer: null, putRefusal: 'text must be at most 4096 bytes of UTF-8' });
    await ctx.loadStartupPrompt();
    await ctx.saveStartupPrompt();
    assert.match(ctx.els.startupPromptStatus.textContent, /^text must be at most 4096 bytes of UTF-8\. Your edits are kept\./);
  });

  it('on a stale refusal, moves to the current revision and says a second save replaces it', async () => {
    const ctx = sandbox(PROMPT, PROJECTS, { putAnswer: null });
    await ctx.loadStartupPrompt();
    ctx.els.startupPromptEditor.value = 'my unsaved edit';
    // Someone else saved revision 4 in between. Same lastError contract.
    const newer = { ...PROMPT, revision: 4, text: 'their text' };
    const realApi = ctx.api;
    ctx.api = async (url, opts) => {
      if (url === '/api/startup-prompt' && !opts) { ctx.api.lastError = null; return newer; }
      const body = await realApi(url, opts);
      ctx.api.lastError = realApi.lastError;
      return body;
    };
    ctx.api.lastError = null;
    vm.runInContext('api = this.api', ctx);
    await ctx.saveStartupPrompt();
    assert.match(ctx.els.startupPromptStatus.textContent, /^The startup prompt changed since revision 3/);
    assert.equal(ctx.els.startupPromptEditor.value, 'my unsaved edit');
    assert.equal(ctx.state.startupPrompt.revision, 4);
    assert.equal(ctx.els.startupPromptRevision.textContent, '(revision 4)');
    assert.match(ctx.els.startupPromptStatus.textContent, /now at revision 4.*saving again replaces it/);
  });

  it('has no character maxlength that disagrees with the server\'s byte limit', () => {
    const tag = INDEX.slice(INDEX.indexOf('id="startupPromptEditor"') - 80, INDEX.indexOf('id="startupPromptEditor"') + 120);
    assert.doesNotMatch(tag, /maxlength/);
  });
});
