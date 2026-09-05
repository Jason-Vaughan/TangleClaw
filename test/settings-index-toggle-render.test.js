'use strict';

/*
 * The Feature Index and Project Map rows are RUN here, not matched as source
 * text.
 *
 * Both toggles have two halves and only one of them is engine-agnostic: the
 * wrap seeds and maintains the file on every engine, while the SessionStart
 * pointer that tells a session the file exists rides the hidden prime. On four
 * of five engines the toggle therefore built a file nothing was ever told to
 * read, and the modal said nothing (#1252). ADR 0013 makes the missing sentence
 * the deliverable, so the sentence — produced by the predicate, escaped, and
 * interpolated — is what these cases assert, against what the SERVER would say
 * for the same project and engine.
 *
 * Running rather than matching also catches what a regex cannot: these renders
 * call `tcSettingDisposition`, a global published by a different file the page
 * happens to load first, and an unresolved identifier there throws on every
 * open of the settings modal (#1037).
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

// The two rows are one render with two labels, so every case runs both: the
// defect they were filed for was one setting saying nothing, and a fixture
// naming a single toggle would let the next one regress alone.
const ROWS = [
  { fn: 'renderFeatureIndexToggle', container: 'settingsFeatureIndexContainer', input: 'settingsFeatureIndex', file: 'FEATURES.md', setting: 'featureIndexEnabled' },
  { fn: 'renderProjectMapToggle', container: 'settingsProjectMapContainer', input: 'settingsProjectMap', file: 'PROJECT-MAP.md', setting: 'projectMapEnabled' }
];

/**
 * Run one index toggle's renderer and hand back what its container holds.
 *
 * @param {object} row - An entry of `ROWS`.
 * @param {object} opts - `roster` (what `state.engines` carries), `engineId`,
 *   `checked` (the toggle's own state), `silentPrime`, `projectEngine`.
 * @returns {string} The container's rendered markup.
 */
function render(row, { roster = [], engineId = 'claude', checked = true, silentPrime = true, projectEngine = null }) {
  const { doc } = makeDocument([row.container]);
  const ctx = {
    document: doc,
    state: { engines: roster },
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  };
  vm.createContext(ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcSettingDisposition'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcEngineDisplayName'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcHonoredLaunchModes'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcResolveEngineProfile'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcIndexPointerCaveat'), ctx);
  // Lifted by PATTERN, not by name: the next table added is otherwise missing
  // here, and the failure would be a ReferenceError from inside the lifted
  // function — which is the thing this file exists to catch.
  const tables = API_HELPER_SRC.match(/const TC_SETTING_\w+ = \{[\s\S]*?\n {2}\};/g) || [];
  assert.ok(tables.length >= 3,
    `expected the defaults, reader and caveat tables to lift, found ${tables.length}`);
  for (const table of tables) vm.runInContext(table, ctx);
  vm.runInContext(liftFunction(UI_SRC, 'function renderIndexToggle'), ctx);
  vm.runInContext(liftFunction(UI_SRC, `function ${row.fn}`), ctx);

  ctx[row.fn](engineId, checked, projectEngine, silentPrime);
  return doc.getElementById(row.container).innerHTML;
}

describe('both inputs the caveat turns on re-render it (#1252)', () => {
  // Structural, unlike everything below: `openSettings` reaches `state`,
  // `apiMutate`, the rules loader and half the page, so it cannot be lifted
  // into a sandbox the way a single render can. What is pinned is the pair —
  // the caveat depends on the engine AND on the project's own silent-prime
  // switch, and wiring one while forgetting the other leaves the modal
  // truthful about half the condition. The live check is queued in
  // `.prawduct/operator-verification.md`.
  const open = UI_SRC.slice(UI_SRC.indexOf('function openSettings'));
  const body = open.slice(0, open.indexOf('\n}\n'));

  it('re-renders them when the engine dropdown changes', () => {
    const handler = body.slice(body.indexOf("getElementById('settingsEngine').addEventListener"));
    assert.match(handler.slice(0, 1200), /renderIndexToggles\(e\.target\.value/);
  });

  it('remembers the silent-prime state across an engine that cannot honor it', () => {
    // The inert branch renders `#settingsSilentPrimeNotApplicable`, so
    // recovering the state from the DOM loses it on the way through codex:
    // claude -> codex -> claude re-checked a box the operator had unchecked,
    // and the caveat riding that value disappeared with it.
    assert.match(body, /let silentPrimeNow = initialSilentChecked;/,
      'the state is held outside the DOM the inert branch replaces');
    assert.match(body, /if \(checkbox\) silentPrimeNow = checkbox\.checked;/,
      'a live control updates it; an inert one cannot have changed it');
    assert.doesNotMatch(body, /checkbox \? checkbox\.checked : initialSilentChecked/,
      'the initial value is no longer the fallback — that is the drop');
  });

  it('re-renders them when silent prime is switched, without waiting for a save', () => {
    // Delegated to the container, which survives every re-render, rather than
    // bound to the checkbox, which `renderSilentPrimeToggle` replaces on each
    // engine change — a listener bound to the element would stop firing after
    // the first engine switch.
    const host = body.slice(body.indexOf("getElementById('settingsSilentPrimeContainer')"));
    assert.match(host.slice(0, 800), /addEventListener\('change'/);
    assert.match(host.slice(0, 800), /e\.target\.id !== 'settingsSilentPrime'/,
      'the delegate must ignore every other control inside the container');
    assert.match(host.slice(0, 800), /renderIndexToggles\(/);
  });
});

describe('the index toggles say which half of them does not run here (#1252, ADR 0013)', () => {
  for (const row of ROWS) {
    describe(row.fn, () => {
      it('renders a live, saveable control with no caveat where the whole setting works', () => {
        const claude = Object.assign({}, readEngine('claude'), { id: 'claude' });
        const html = render(row, { roster: [claude], engineId: 'claude', silentPrime: true });
        assert.match(html, new RegExp(`id="${row.input}"`), 'the control saves on every engine');
        assert.match(html, /checked/);
        assert.doesNotMatch(html, /disabled/, 'the wrap half runs here — nothing is inert');
        assert.doesNotMatch(html, /form-hint--caveat/, 'nothing is lost, so nothing is said');
      });

      it('stays live but carries the server\'s own sentence on an engine that cannot announce the file', () => {
        const codex = Object.assign({}, readEngine('codex'), { id: 'codex' });
        const html = render(row, { roster: [codex], engineId: 'codex', silentPrime: true });
        assert.match(html, new RegExp(`id="${row.input}"`),
          'the toggle still does something here — hiding or disabling it would be the opposite lie');
        assert.match(html, /form-hint--caveat/, 'the caveat is marked, not filed as more description');
        const server = engines.settingDisposition(row.setting,
          { [row.setting]: true, silentPrime: true }, codex);
        assert.ok(server.caveat, 'the server must have something to say for this fixture');
        assert.ok(html.includes(server.caveat),
          `rendered caveat must be the server's.\nserver: ${server.caveat}\nhtml: ${html}`);
        assert.ok(html.includes(row.file), 'and must name the file still being maintained');
      });

      it('carries the caveat on a capable engine when silent prime is switched off', () => {
        // The gate is a triple; this is the leg the operator controls, and the
        // one the modal never mentioned.
        const claude = Object.assign({}, readEngine('claude'), { id: 'claude' });
        const html = render(row, { roster: [claude], engineId: 'claude', silentPrime: false });
        const server = engines.settingDisposition(row.setting,
          { [row.setting]: true, silentPrime: false }, claude);
        assert.ok(server.caveat);
        assert.ok(html.includes(server.caveat),
          `rendered caveat must be the server's.\nserver: ${server.caveat}\nhtml: ${html}`);
      });

      it('reads capabilities off the project\'s own engine when the picker roster omits it', () => {
        // `state.engines` drops connection-backed ids, so an OpenClaw project
        // finds nothing there while the server answers from the base profile.
        // Without the fallback the row would claim TangleClaw has no profile
        // for an engine it knows.
        const openclaw = Object.assign({}, readEngine('openclaw'), { id: 'openclaw:conn-1' });
        const html = render(row, {
          roster: [], engineId: 'openclaw:conn-1', projectEngine: openclaw, silentPrime: true
        });
        assert.doesNotMatch(html, /no profile for this engine/);
        const server = engines.settingDisposition(row.setting,
          { [row.setting]: true, silentPrime: true }, openclaw);
        assert.ok(html.includes(server.caveat));
      });

      it('escapes the engine name it interpolates', () => {
        const hostile = { id: 'x', name: '<img src=x onerror=alert(1)>', capabilities: {} };
        const html = render(row, { roster: [hostile], engineId: 'x', silentPrime: true });
        assert.doesNotMatch(html, /<img/, 'the reason is escaped before it reaches the DOM');
        assert.match(html, /&lt;img/);
      });
    });
  }
});
