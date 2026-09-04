'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
const API_HELPER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
const engines = require('../lib/engines');

const readEngine = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', `${id}.json`), 'utf8'));

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

function setupLanding(state) {
  const ids = ['launchModeModal', 'launchModeText', 'launchModeList', 'launchModeWarning', 'launchModeConfirmBtn'];
  const { doc, ids: domIds } = makeDocument(ids);

  const ctx = {
    document: doc,
    window: { location: { host: 'localhost:3000' } },
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    pendingContinuityMode: null,
    launchModeTarget: null,
    selectedLaunchMode: null,
    // `proceedWithLaunchModeCheck` resolves the engine off `state`, exactly as
    // the page does. Supplied so tests can enter through the real gate rather
    // than handing the modal an engine the production caller never chose.
    state: state || { engines: [], config: {}, projects: [] }
  };

  vm.createContext(ctx);
  // The honored-mode predicate is shared frontend base (`public/api-helper.js`,
  // loaded before every page script), not landing-page code.
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcHonoredLaunchModes'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function preselectedLaunchMode'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function updateLaunchModeWarning'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function openLaunchModeModal'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function proceedWithLaunchModeCheck'), ctx);

  return { doc, ctx };
}

/**
 * Drive the picker through its REAL entry point, with `doLaunchProject` captured.
 *
 * The seed under test is chosen from the project, and only the production
 * caller supplies one — a fixture that calls `openLaunchModeModal` directly has
 * already made the decision being asserted, so a wrong seed is invisible to it.
 *
 * @param {object|null} project - Project record as `state.projects` holds it
 * @param {string} engineId - Engine the project resolves to
 * @returns {object} `{ doc, ctx, launched }`; `launched.called` marks a launch
 */
function launchThroughGate(project, engineId = 'claude') {
  // `id` last: the profile JSON carries its own. If it wins, the fixture's
  // engine is not the one `state.engines.find` resolves, the gate finds nothing
  // and launches directly — and the assertions still pass, for the opposite
  // reason to the one they name.
  const engine = Object.assign({}, readEngine(engineId), { id: engineId });
  const state = {
    engines: [engine],
    config: { defaultEngine: engineId },
    projects: project ? [project] : []
  };
  const { doc, ctx } = setupLanding(state);

  const launched = {};
  ctx.doLaunchProject = async (name, mode, contMode) => {
    Object.assign(launched, { called: true, name, mode, contMode });
  };
  vm.runInContext(liftFunction(LANDING_SRC, 'function closeLaunchModeModal'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'async function confirmLaunchMode'), ctx);

  ctx.proceedWithLaunchModeCheck(project ? project.name : 'MyProj', project, null);
  return { doc, ctx, launched };
}

/**
 * A bundled engine profile as `state.engines` holds it, with named modes
 * disabled.
 *
 * `id` is applied last for the reason given in `launchThroughGate`: the profile
 * supplies its own, and a fixture whose engine id does not match the one the
 * gate resolves is never found, so the gate falls through and the test reports
 * the right answer for the wrong reason.
 *
 * @param {string} engineId - Bundled profile to read
 * @param {string[]} disabled - Mode keys to mark `disabled`
 * @param {*} value - Value to write into `disabled` (default `true`). Only
 *   exact `true` disables a mode; a truthy non-`true` value is the case where a
 *   `!disabled` spelling and a `disabled !== true` spelling disagree, so the
 *   parity check needs one to have anything to compare.
 * @returns {object} Engine object
 */
function engineWithDisabled(engineId, disabled, value = true) {
  const engine = Object.assign({}, readEngine(engineId), { id: engineId });
  const modes = Object.assign({}, engine.launchModes);
  for (const key of disabled) {
    assert.ok(modes[key], `fixture names a mode "${key}" that ${engineId} does not declare`);
    modes[key] = Object.assign({}, modes[key], { disabled: value });
  }
  engine.launchModes = modes;
  return engine;
}

/** @returns {string|null} The mode key carrying `checked`, or null. */
function checkedMode(doc) {
  const m = /value="([^"]+)" checked/.exec(doc.getElementById('launchModeList').innerHTML);
  return m ? m[1] : null;
}

describe('Launch Mode picker (#596)', () => {
  it('renders all enabled modes from the engine profile and checks the default', () => {
    const { doc, ctx } = setupLanding();
    const claude = readEngine('claude');
    
    ctx.openLaunchModeModal('MyProj', claude);
    
    const list = doc.getElementById('launchModeList');
    const html = list.innerHTML;
    
    // Assert vacuous pass prevention
    assert.ok(html.includes('launch-mode-option'), 'must render at least one option');
    
    // Check modes
    assert.match(html, /value="default"/);
    assert.match(html, /value="acceptEdits"/);
    assert.match(html, /value="plan"/);
    assert.match(html, /value="auto"/);
    assert.match(html, /value="bypassPermissions"/);
    
    // No project is supplied here, which is the only case where the engine's
    // own default is the seed. A project carrying `defaultLaunchMode` overrides
    // it — see the preselect suite below.
    assert.match(html, /value="default" checked/);
  });
  
  it('renders the warning for bypassPermissions', () => {
    const { doc, ctx } = setupLanding();
    const claude = readEngine('claude');
    
    ctx.openLaunchModeModal('MyProj', claude);
    
    const list = doc.getElementById('launchModeList');
    assert.match(list.innerHTML, /Only use in isolated environments/);
  });

  it('wires Launch button to doLaunchProject with selected mode', async () => {
    const { doc, ctx } = setupLanding();
    const claude = readEngine('claude');
    
    let launched = null;
    ctx.doLaunchProject = async (name, mode, contMode) => {
      launched = { name, mode, contMode };
    };
    // We need to lift closeLaunchModeModal and confirmLaunchMode as well
    vm.runInContext(liftFunction(LANDING_SRC, 'function closeLaunchModeModal'), ctx);
    vm.runInContext(liftFunction(LANDING_SRC, 'async function confirmLaunchMode'), ctx);

    ctx.openLaunchModeModal('MyProj', claude);
    ctx.selectedLaunchMode = 'bypassPermissions';
    await ctx.confirmLaunchMode();
    
    assert.deepEqual(launched, {
      name: 'MyProj',
      mode: 'bypassPermissions',
      contMode: null
    }, 'must launch with the currently selected mode');
  });
});

/*
 * The picker preselects the PROJECT's configured launch mode (#596).
 *
 * The picker sends its selection explicitly on every launch, and
 * `lib/sessions.js` applies the project's stored `defaultLaunchMode` only when
 * the caller sent none. The seed is therefore what makes that setting apply at
 * all on a launch showing the picker — the shipped default.
 *
 * These drive `proceedWithLaunchModeCheck`, the real caller, because the seed
 * comes from the project only the real caller supplies.
 */
describe('launch picker preselects the project default (#596)', () => {
  it('opens on the project\'s configured mode, not the engine\'s', () => {
    const { doc } = launchThroughGate({ name: 'Planner', engineId: 'claude', defaultLaunchMode: 'plan' });
    assert.equal(checkedMode(doc), 'plan',
      'a project configured for plan must open the picker on plan');
  });

  it('launches in the project default when the operator just presses Launch', async () => {
    // The end-to-end the bug breaks. Nothing touches the radios: this is the
    // operator opening the picker and accepting what it offers.
    const { ctx, launched } = launchThroughGate({ name: 'Planner', engineId: 'claude', defaultLaunchMode: 'plan' });
    await ctx.confirmLaunchMode();

    assert.equal(launched.called, true, 'must reach doLaunchProject');
    assert.equal(launched.mode, 'plan',
      'the mode sent to the server must be the project default, not the engine default');
  });

  it('preselects a warning-carrying mode the project configured', () => {
    // `bypassPermissions` is deliberately NOT special-cased. The settings modal
    // already gates this combination eyes-open — it refuses to hide the picker
    // when the default carries a warning — and that guard is only coherent if a
    // shown picker actually reflects the stored choice, warning and all.
    const { doc } = launchThroughGate({ name: 'Yolo', engineId: 'claude', defaultLaunchMode: 'bypassPermissions' });
    assert.equal(checkedMode(doc), 'bypassPermissions');
    assert.match(doc.getElementById('launchModeList').innerHTML, /Only use in isolated environments/,
      'the warning must still render on the mode it preselected');
  });

  it('falls back to the engine default when the stored mode is not a mode of this engine', () => {
    // A stale key, e.g. a hand-edited project.json. Checking a radio that is
    // not rendered would open the picker with nothing selected.
    const { doc } = launchThroughGate({ name: 'Stale', engineId: 'claude', defaultLaunchMode: 'fullAuto' });
    assert.equal(checkedMode(doc), 'default');
  });

  it('falls back to the engine default when the stored mode is disabled', () => {
    const engine = engineWithDisabled('claude', ['plan']);
    const project = { name: 'Disabled', engineId: 'claude', defaultLaunchMode: 'plan' };
    const { doc, ctx } = setupLanding({
      engines: [engine], config: { defaultEngine: 'claude' }, projects: [project]
    });
    ctx.doLaunchProject = async () => {};
    ctx.proceedWithLaunchModeCheck('Disabled', project, null);

    assert.equal(checkedMode(doc), 'default',
      'a disabled mode is not a choice, so it cannot be the preselected one');
  });

  it('is unchanged for a project that configured nothing', () => {
    const { doc } = launchThroughGate({ name: 'Plain', engineId: 'claude' });
    assert.equal(checkedMode(doc), 'default');
  });

  it('falls past the ENGINE default too when the engine disabled its own', () => {
    // The last rung of the fallback. Reachable because `defaultLaunchMode` and
    // `launchModes[key].disabled` are independent fields of a profile, so a
    // profile can disable the very mode it names as its default — and seeding
    // an unrendered radio is the failure either way.
    const engine = engineWithDisabled('claude', ['default']);
    const project = { name: 'NoDefault', engineId: 'claude' };
    const { doc, ctx } = setupLanding({
      engines: [engine], config: { defaultEngine: 'claude' }, projects: [project]
    });
    ctx.doLaunchProject = async () => {};
    ctx.proceedWithLaunchModeCheck('NoDefault', project, null);

    const checked = checkedMode(doc);
    assert.notEqual(checked, null, 'something must be preselected — an empty picker cannot be launched');
    assert.notEqual(checked, 'default', 'the engine default is disabled, so it is not a choice');
    assert.match(doc.getElementById('launchModeList').innerHTML, new RegExp(`value="${checked}"`),
      'the preselected mode must be one the picker actually rendered');
  });
});

/*
 * Every browser surface offering a launch mode, and the gate that decides to
 * open the picker, read one predicate: `tcHonoredLaunchModes`. A surface that
 * answers "which modes will this engine run" differently offers the operator a
 * mode another surface refuses.
 */
describe('launch picker offers only modes the engine honors (#596)', () => {
  it('omits a disabled mode from the rendered options', () => {
    const engine = engineWithDisabled('claude', ['auto']);
    const { doc, ctx } = setupLanding({
      engines: [engine], config: { defaultEngine: 'claude' }, projects: []
    });
    ctx.doLaunchProject = async () => {};
    ctx.proceedWithLaunchModeCheck('MyProj', { name: 'MyProj', engineId: 'claude' }, null);

    const html = doc.getElementById('launchModeList').innerHTML;
    assert.ok(html.includes('launch-mode-option'), 'must still render the honored options');
    assert.match(html, /value="plan"/, 'the honored modes must survive the filter');
    assert.doesNotMatch(html, /value="auto"/,
      'a disabled mode must not be offered — the gate already excluded it from the count');
  });

  it('launches directly when the engine is unknown, instead of throwing', () => {
    // `state.engines.find` returns undefined for a project pinned to an engine
    // this install does not have. The gate used to guard that with an explicit
    // `engine && engine.launchModes`; it now leans on the predicate returning
    // an empty list, so the no-engine path needs its own assertion or the
    // behavior rests on nothing.
    const project = { name: 'Ghost', engineId: 'not-installed' };
    const { doc, ctx } = setupLanding({ engines: [], config: {}, projects: [project] });
    let launched = null;
    ctx.doLaunchProject = async (name, mode) => { launched = { name, mode }; };
    ctx.proceedWithLaunchModeCheck('Ghost', project, null);

    assert.deepEqual(launched, { name: 'Ghost', mode: null });
    assert.equal(doc.getElementById('launchModeList').innerHTML, '');
  });

  it('answers exactly what the server predicate answers, for every bundled profile', () => {
    // The browser copy exists because `public/` cannot require `lib/` — no
    // bundler, no build step. What keeps it a boundary rather than a variant is
    // this assertion: `engines.honorsLaunchMode` is the server's definition of
    // "this engine will run that mode", and the two must not drift apart.
    const { ctx } = setupLanding();
    const profiles = fs.readdirSync(path.join(__dirname, '..', 'data', 'engines'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readEngine(path.basename(f, '.json')));
    assert.ok(profiles.length > 0, 'no bundled profiles found — this would assert nothing');

    const fixtures = profiles.concat([
      engineWithDisabled('claude', ['plan', 'auto']),
      // The only shape the two spellings disagree on. Without it this loop
      // compares `!disabled` and `disabled !== true` over values where they
      // agree, and passes while the copies have drifted.
      engineWithDisabled('claude', ['plan'], 'yes'),
      engineWithDisabled('claude', ['auto'], 1)
    ]);

    let modesChecked = 0;
    for (const profile of fixtures) {
      // `Array.from` in this realm: the helper runs inside a vm context, so the
      // array it returns has that realm's prototype and deepStrictEqual reports
      // two identical-looking lists as unequal.
      const browser = Array.from(ctx.tcHonoredLaunchModes(profile), ([key]) => key);
      const server = Object.keys(profile.launchModes || {})
        .filter((key) => engines.honorsLaunchMode(profile, key));
      assert.deepEqual(browser, server,
        `${profile.id}: the browser and server predicates must honor the same modes`);
      modesChecked += Object.keys(profile.launchModes || {}).length;
    }
    assert.ok(modesChecked > 0, 'the profiles carried no launch modes — nothing was compared');
  });

  it('does not open the picker when only one mode is honored', () => {
    // The gate and the options now agree, so an engine with one real choice
    // launches straight through instead of showing a one-option modal.
    const engine = engineWithDisabled('claude', ['plan', 'auto', 'acceptEdits', 'bypassPermissions']);
    assert.equal(engine.launchModes.default.disabled, undefined,
      'exactly one mode must remain honored, or this asserts nothing');
    const project = { name: 'Solo', engineId: 'claude' };
    const { doc, ctx } = setupLanding({
      engines: [engine], config: { defaultEngine: 'claude' }, projects: [project]
    });
    let launched = null;
    ctx.doLaunchProject = async (name, mode) => { launched = { name, mode }; };
    ctx.proceedWithLaunchModeCheck('Solo', project, null);

    assert.deepEqual(launched, { name: 'Solo', mode: null },
      'one honored mode is not a choice — launch directly, sending no explicit mode');
    assert.equal(doc.getElementById('launchModeList').innerHTML, '',
      'the picker must not have been rendered');
  });
});
