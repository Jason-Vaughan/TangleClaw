'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

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
  vm.runInContext(liftFunction(LANDING_SRC, 'function honoredLaunchModes'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function preselectedLaunchMode'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function updateLaunchModeWarning'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function openLaunchModeModal'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function proceedWithLaunchModeCheck'), ctx);

  return { doc, ctx };
}

/**
 * Drive the picker through its REAL entry point, with `doLaunchProject` captured.
 *
 * Calling `openLaunchModeModal` directly is what let the preselect defect live:
 * a fixture that hands the modal an engine has already made the decision the
 * production caller actually makes, so a wrong seed is invisible to it.
 *
 * @param {object|null} project - Project record as `state.projects` holds it
 * @param {string} engineId - Engine the project resolves to
 * @returns {object} `{ doc, ctx, launched }`; `launched.called` marks a launch
 */
function launchThroughGate(project, engineId = 'claude') {
  // `id` last: the profile JSON carries its own, and letting it win silently
  // decoupled the fixture's engine from the one the gate looks up — the gate
  // then found nothing and launched directly, passing a test for the opposite
  // reason to the one it claimed.
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
 * @returns {object} Engine object
 */
function engineWithDisabled(engineId, disabled) {
  const engine = Object.assign({}, readEngine(engineId), { id: engineId });
  const modes = Object.assign({}, engine.launchModes);
  for (const key of disabled) {
    assert.ok(modes[key], `fixture names a mode "${key}" that ${engineId} does not declare`);
    modes[key] = Object.assign({}, modes[key], { disabled: true });
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
    
    // Checked with NO project supplied — the only case where the engine's own
    // default is still the right seed. A project that configured
    // `defaultLaunchMode` overrides it; see the preselect suite below. This
    // assertion narrowed because the requirement changed (the operator's
    // 2026-07-17 scope addition on #596), not because it was relaxed.
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
 * The picker preselects the PROJECT's configured launch mode (#596, the
 * operator's 2026-07-17 scope addition).
 *
 * Why this is a defect and not a missing nicety: the picker sends its selection
 * explicitly on every launch, and `lib/sessions.js` applies the project's
 * stored `defaultLaunchMode` only when the caller sent none. Seeded from the
 * engine, the picker therefore overrode the setting on every launch it showed —
 * and it shows by default (`showLaunchModePicker` defaults true). A project
 * configured to launch in `plan` launched interactive, forever, unless someone
 * re-picked by hand.
 *
 * These drive `proceedWithLaunchModeCheck` — the real caller — because the seed
 * is chosen from the project that only the real caller supplies.
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
 * The picker's options and the gate that opens it read the same flag.
 *
 * `proceedWithLaunchModeCheck` counted only non-disabled modes to decide the
 * picker was worth showing, while the picker rendered every mode the profile
 * declared — so the gate could see two real choices and the picker offer three,
 * one of which the engine refuses. Latent today (no bundled profile ships a
 * disabled mode) but `disabled` is a supported field: `updateProject` rejects a
 * disabled mode key, and test/launch-mode-settings.test.js pins that rejection
 * as "symmetric with the picker filter" — a symmetry that did not exist here.
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
