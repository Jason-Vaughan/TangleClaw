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
function sandbox(prompt, projects, { putAnswer = null, openToken = 'tok' } = {}) {
  const els = {};
  for (const id of ['startupPromptEditor', 'startupPromptRevision', 'startupPromptFirers', 'startupPromptStatus', 'startupPromptSaveBtn']) {
    els[id] = {
      id, value: '', textContent: '', innerHTML: '', className: '', disabled: false,
      classList: { remove() {}, add() {} }
    };
  }
  const calls = [];
  const api = async (url, opts) => {
    calls.push({ url, opts });
    if (url === '/api/startup-prompt' && (!opts || !opts.method)) return prompt;
    if (url === '/api/projects') return { projects };
    if (url === '/api/auth/me') return { openInstallToken: openToken };
    if (url === '/api/startup-prompt' && opts.method === 'PUT') return putAnswer;
    return null;
  };
  api.lastError = 'The startup prompt changed since revision 1.';
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

  it('on a refusal, says so and re-reads the current prompt', async () => {
    const ctx = sandbox(PROMPT, PROJECTS, { putAnswer: null });
    await ctx.loadStartupPrompt();
    const readsBefore = ctx.calls.filter((c) => c.url === '/api/startup-prompt' && !c.opts).length;
    await ctx.saveStartupPrompt();
    assert.match(ctx.els.startupPromptStatus.textContent, /changed since revision 1.*shows the current prompt/);
    assert.equal(ctx.els.startupPromptStatus.className, 'rules-status rules-status-err');
    const readsAfter = ctx.calls.filter((c) => c.url === '/api/startup-prompt' && !c.opts).length;
    assert.equal(readsAfter, readsBefore + 1, 're-read after the refusal');
  });
});
