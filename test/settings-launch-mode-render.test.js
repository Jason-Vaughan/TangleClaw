'use strict';

/*
 * `renderLaunchModeSettings` is RUN here, not matched as source text.
 *
 * It had exactly two guards before this file, and both were
 * `assert.match(uiSource, /renderLaunchModeSettings/)` — they prove the symbol
 * is spelled in `public/ui.js` and nothing else. A refactor deleted a `const
 * modes` binding while leaving a reference to it further down the same
 * function; that is a ReferenceError on every open of the project settings
 * modal, it shipped to the live install, and it was invisible to a green suite
 * and five Critic rounds because no test ever called the function.
 *
 * This is the concrete instance of #1037 ("stop regex-matching exact public/*
 * source text in frontend tests"). The fix is not a better regex: a regex
 * cannot see an undeclared identifier. It is executing the function.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const API_HELPER_SRC = fs.readFileSync(path.join(PUB, 'api-helper.js'), 'utf8');

const readEngine = (id) => JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', `${id}.json`), 'utf8'));

/**
 * Slice a top-level function out of source text by brace-matching, so the
 * sandbox runs the REAL code rather than a copy.
 *
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find.
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

/**
 * Run `renderLaunchModeSettings` against a real bundled profile.
 *
 * @param {object} opts - `engine` (profile object), `engineId`, `preserveMode`,
 *   `preserveShow`.
 * @returns {object} `{ html }` — the container's rendered markup.
 */
function render({ engine, engineId = 'claude', preserveMode = 'default', preserveShow = true }) {
  const { doc } = makeDocument(['settingsLaunchModeContainer']);
  const ctx = {
    document: doc,
    state: { engines: engine ? [engine] : [] },
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  };
  vm.createContext(ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcHonoredLaunchModes'), ctx);
  vm.runInContext(liftFunction(UI_SRC, 'function renderLaunchModeSettings'), ctx);

  ctx.renderLaunchModeSettings(engineId, preserveMode, preserveShow);
  return { html: doc.getElementById('settingsLaunchModeContainer').innerHTML };
}

/** A bundled profile with named modes disabled; `id` applied last so it wins. */
function engineWithDisabled(engineId, disabled = []) {
  const engine = Object.assign({}, readEngine(engineId), { id: engineId });
  const modes = Object.assign({}, engine.launchModes);
  for (const key of disabled) {
    assert.ok(modes[key], `fixture names a mode "${key}" that ${engineId} does not declare`);
    modes[key] = Object.assign({}, modes[key], { disabled: true });
  }
  engine.launchModes = modes;
  return engine;
}

describe('the settings modal launch-mode section actually renders (#1037)', () => {
  it('renders the section without throwing', () => {
    // The assertion the source-regex pins could not make. An undeclared
    // identifier anywhere in this function fails here and nowhere else.
    const { html } = render({ engine: engineWithDisabled('claude') });
    assert.match(html, /id="settingsDefaultLaunchMode"/);
    assert.match(html, /id="settingsShowLaunchPicker"/);
    assert.match(html, /<option value="plan"/, 'the engine\'s modes must be offered');
  });

  it('preselects the stored mode', () => {
    const { html } = render({ engine: engineWithDisabled('claude'), preserveMode: 'plan' });
    assert.match(html, /<option value="plan" selected/);
  });

  it('falls back to default when the stored mode is disabled, not to a hidden option', () => {
    // The option is not rendered, so naming it as `selected` would leave the
    // browser showing the first entry while the markup claimed another —
    // reporting a mode the operator never chose.
    const { html } = render({
      engine: engineWithDisabled('claude', ['plan']), preserveMode: 'plan'
    });
    assert.doesNotMatch(html, /<option value="plan"/, 'a disabled mode must not be offered');
    assert.match(html, /<option value="default" selected/);
  });

  it('carries the picker toggle state both ways', () => {
    assert.match(render({ engine: engineWithDisabled('claude'), preserveShow: true }).html,
      /id="settingsShowLaunchPicker" checked/);
    assert.doesNotMatch(render({ engine: engineWithDisabled('claude'), preserveShow: false }).html,
      /id="settingsShowLaunchPicker" checked/);
  });

  it('renders nothing for an engine this install does not have', () => {
    assert.equal(render({ engine: null, engineId: 'not-installed' }).html, '');
  });

  it('renders nothing when the engine honors no modes', () => {
    const engine = engineWithDisabled('claude',
      ['default', 'plan', 'auto', 'acceptEdits', 'bypassPermissions']);
    assert.equal(render({ engine }).html, '');
  });
});
