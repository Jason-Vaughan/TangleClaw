'use strict';

/*
 * `renderSilentPrimeToggle` is RUN here, not matched as source text.
 *
 * Every guard on it was `assert.match(uiSource, /.../)`, which proves a string
 * is spelled in `public/ui.js` and nothing more. The function now calls
 * `tcSettingDisposition` — a global published by a *different* file that the
 * page happens to load first — and a regex cannot tell whether that identifier
 * resolves at runtime. If it does not, every open of the project settings modal
 * throws a ReferenceError, which is exactly what shipped to the live install
 * once already (#1037, `test/settings-launch-mode-render.test.js`).
 *
 * The second thing only a real render can check: the operator-facing sentence.
 * ADR 0013 makes the WORDS the deliverable, and the words are produced by the
 * predicate, escaped, and interpolated — three steps a source match skips.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');
const engines = require('../lib/engines');

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
  return '';
}

/**
 * Run `renderSilentPrimeToggle` and hand back what the container holds.
 *
 * @param {object} opts - `roster` (what `state.engines` carries), `engineId`
 *   (the dropdown's value), `preserveChecked`, `projectEngine`.
 * @returns {string} The container's rendered markup.
 */
function render({ roster = [], engineId = 'claude', preserveChecked = true, projectEngine = null }) {
  const { doc } = makeDocument(['settingsSilentPrimeContainer']);
  const ctx = {
    document: doc,
    state: { engines: roster },
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  };
  vm.createContext(ctx);
  // The predicate is shared frontend base, loaded before every page script.
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcSettingDisposition'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcEngineDisplayName'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcHonoredLaunchModes'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcResolveEngineProfile'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcIndexPointerCaveat'), ctx);
  // `tcSettingDisposition` closes over module-level `TC_SETTING_*` tables.
  // Lifted by PATTERN rather than by name: naming them one at a time means the
  // next table added is missing here, and the failure is a ReferenceError from
  // inside the lifted function — which is what this file exists to catch, so it
  // should not be the thing that breaks it.
  const tables = API_HELPER_SRC.match(/const TC_SETTING_\w+ = \{[\s\S]*?\n {2}\};/g) || [];
  assert.ok(tables.length >= 2,
    `expected the shipped-default and reader tables to lift, found ${tables.length}`);
  for (const table of tables) vm.runInContext(table, ctx);
  vm.runInContext(liftFunction(UI_SRC, 'function renderSilentPrimeToggle'), ctx);

  ctx.renderSilentPrimeToggle(engineId, preserveChecked, projectEngine);
  return doc.getElementById('settingsSilentPrimeContainer').innerHTML;
}

describe('the settings modal silent-prime row actually renders (#1037, ADR 0013)', () => {
  it('renders a live toggle on an engine that honors the setting, without throwing', () => {
    // The assertion no source-regex can make: an undeclared identifier anywhere
    // in this function — `tcSettingDisposition` included — fails here.
    const claude = Object.assign({}, readEngine('claude'), { id: 'claude' });
    const html = render({ roster: [claude], engineId: 'claude' });
    assert.match(html, /id="settingsSilentPrime"/);
    assert.match(html, /checked/);
    assert.doesNotMatch(html, /disabled/);
  });

  it('renders an inert row carrying the server\'s own sentence on an engine that cannot', () => {
    const codex = Object.assign({}, readEngine('codex'), { id: 'codex' });
    const html = render({ roster: [codex], engineId: 'codex' });
    assert.match(html, /id="settingsSilentPrimeNotApplicable"/, 'inert, not absent');
    assert.match(html, /disabled/);
    assert.doesNotMatch(html, /id="settingsSilentPrime"/,
      'no saveable control, or doSaveSettings would attach a doomed value');
    // The words are the deliverable. Compared against what the SERVER would
    // say for the same project and engine, through the real escape+interpolate
    // path — a drifted sentence tells the operator something the launch path
    // does not believe.
    const server = engines.settingDisposition('silentPrime', { silentPrime: true }, codex);
    assert.ok(html.includes(server.reason),
      `rendered hint must carry the server's reason.\nserver: ${server.reason}\nhtml: ${html}`);
  });

  it('reads capabilities off the project\'s own engine when the picker roster omits it', () => {
    // `state.engines` drops connection-backed ids, so an OpenClaw project finds
    // nothing there while the server answers from the base profile. Without the
    // fallback the row claims TangleClaw has no profile for an engine it knows.
    const projectEngine = {
      id: 'openclaw:conn-1',
      name: 'Studio (OpenClaw)',
      capabilities: readEngine('openclaw').capabilities || {}
    };
    const html = render({ roster: [], engineId: 'openclaw:conn-1', projectEngine });
    assert.match(html, /Studio \(OpenClaw\)/, 'the engine is named, not called unknown');
    assert.doesNotMatch(html, /no profile for this engine/);
  });

  it('says it cannot tell for an engine nothing knows about', () => {
    const html = render({ roster: [], engineId: 'ghost', projectEngine: null });
    assert.match(html, /no profile for this engine/);
    assert.doesNotMatch(html, /hidden prime/, 'it must not claim the capability is absent');
  });

  it('does not apply a stale project engine to a different dropdown selection', () => {
    // The fallback is keyed on the dropdown still naming the project's engine.
    // Carrying it across a switch would answer for the engine the operator just
    // left, which is the wrong engine's capabilities on the right row.
    const projectEngine = {
      id: 'claude', name: 'Claude Code', capabilities: { supportsSilentPrime: true }
    };
    const html = render({ roster: [], engineId: 'codex', projectEngine });
    assert.match(html, /no profile for this engine/,
      'codex is not in the roster and is not the project engine — nothing to read');
    assert.doesNotMatch(html, /id="settingsSilentPrime"/);
  });
});
