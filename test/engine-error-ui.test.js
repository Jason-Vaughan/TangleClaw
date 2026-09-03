'use strict';

/*
 * #261 — what the operator sees: the session page's engine-error banner and
 * the project card's badge, rendered from the status payload. Both lift the
 * REAL render functions out of public/ and run them against the mini DOM,
 * so the assertion is about rendered state rather than source text.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8');
const LANDING_SRC = fs.readFileSync(path.join(PUBLIC, 'landing.js'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');
const SESSION_CSS = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text by
 * brace-matching, so the sandbox runs the REAL code rather than a copy.
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find, e.g. `function esc(str)`.
 * @returns {string} The declaration plus its balanced body.
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

const ERR = {
  type: 'invalid_request_error',
  status: 400,
  message: 'The requested model is not supported under the current <auth> mode.',
  timestamp: '2026-09-03T14:02:11.000Z'
};

describe('#261 session page banner', () => {
  /** A sandbox with the real banner renderer, `esc`, and a document holding the banner element. */
  function load(project) {
    const { doc, ids } = makeDocument(['engineErrorBanner']);
    const sandbox = { document: doc, sessionState: { project }, Number, Date, console };
    vm.createContext(sandbox);
    vm.runInContext([
      liftFunction(SESSION_SRC, 'function esc(str)'),
      liftFunction(SESSION_SRC, 'function renderEngineErrorBanner(err)'),
      'globalThis.renderEngineErrorBanner = renderEngineErrorBanner;'
    ].join('\n'), sandbox);
    return { render: sandbox.renderEngineErrorBanner, el: ids.engineErrorBanner };
  }

  it('the page ships the banner element, hidden, and the stylesheet knows it', () => {
    assert.match(SESSION_HTML, /id="engineErrorBanner"[^>]*role="alert"/);
    assert.match(SESSION_HTML, /class="engine-error-banner hidden" id="engineErrorBanner"/);
    assert.match(SESSION_CSS, /\.engine-error-banner\.hidden \{ display: none; \}/);
  });

  it('names the engine, the status, the type and the provider message — escaped', () => {
    const { render, el } = load({ engine: { id: 'codex', name: 'Codex' } });
    el.classList.add('hidden');
    render(ERR);
    assert.equal(el.classList.contains('hidden'), false, 'a recorded error shows the banner');
    assert.match(el.innerHTML, /<strong>Codex's API returned HTTP 400<\/strong>/);
    assert.match(el.innerHTML, /<code>invalid_request_error<\/code>/);
    assert.match(el.innerHTML, /current &lt;auth&gt; mode\.<span/, 'provider text is escaped, not injected, and not re-punctuated');
    assert.match(el.innerHTML, /Seen \d/, 'the first-seen time is shown');
    assert.match(el.innerHTML, /Clears once the terminal moves past the error line\./, 'the clear rule is stated to the operator');
  });

  it('falls back honestly when the engine name is not known yet', () => {
    const { render, el } = load(null);
    render({ status: 500, message: 'server had an error' });
    assert.match(el.innerHTML, /The engine’s API returned HTTP 500<\/strong> — server had an error<span/);
    assert.doesNotMatch(el.innerHTML, /Seen /, 'no timestamp, no claim about when');
  });

  it('a null payload hides and empties the banner again', () => {
    const { render, el } = load({ engine: { id: 'codex', name: 'Codex' } });
    render(ERR);
    render(null);
    assert.equal(el.classList.contains('hidden'), true);
    assert.equal(el.innerHTML, '');
  });

  it('the status poll is what drives it', () => {
    const poll = liftFunction(SESSION_SRC, 'async function pollStatus()');
    assert.match(poll, /renderEngineErrorBanner\(data\.lastEngineError\)/,
      'pollStatus must hand the payload to the banner on every tick');
  });
});

describe('#261 project card badge', () => {
  /** The real badge renderer with the real `esc`. */
  function load() {
    const sandbox = { Number, console };
    vm.createContext(sandbox);
    vm.runInContext([
      liftFunction(LANDING_SRC, 'function esc(str)'),
      liftFunction(UI_SRC, 'function renderEngineErrorBadge(project)'),
      'globalThis.renderEngineErrorBadge = renderEngineErrorBadge;'
    ].join('\n'), sandbox);
    return sandbox.renderEngineErrorBadge;
  }

  it('renders a red HTTP-status badge with the detail in its tooltip for a live session', () => {
    const html = load()({ session: { active: true, lastEngineError: ERR } });
    assert.match(html, /class="badge badge-engine-error"/);
    assert.match(html, /&#9888; HTTP 400</);
    assert.match(html, /title="Engine API error — HTTP 400\. invalid_request_error: The requested model is not supported under the current &lt;auth&gt; mode\."/);
    assert.match(STYLE_CSS, /\.badge-engine-error \{/);
  });

  it('renders nothing without an error, and nothing for a session the server could not confirm', () => {
    const render = load();
    assert.equal(render({ session: { active: true, lastEngineError: null } }), '');
    assert.equal(render({ session: null }), '');
    assert.equal(render({}), '');
    assert.equal(render({ session: { active: null, lastEngineError: ERR } }), '',
      'an unknown-liveness session has no pane reading to draw');
  });

  it('is placed in the card row beside the engine badge', () => {
    assert.match(UI_SRC, /const engineErrorBadge = renderEngineErrorBadge\(project\);/);
    assert.match(UI_SRC, /\$\{engineBadge\}\s*\$\{engineErrorBadge\}/);
  });
});
