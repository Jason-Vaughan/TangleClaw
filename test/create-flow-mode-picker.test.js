'use strict';

/*
 * #401 — creating a project must offer the launch-mode picker, not silently
 * launch with no mode.
 *
 * The issue's own hypothesis (a fresh-install engine-profile seeding gap) was
 * wrong: bundled profiles have carried the full launch-mode set since #251,
 * and the picker gate in launchProject works. The actual mechanism was the
 * create flow: submitCreate auto-launched the new project with a raw
 * `fetch POST /api/sessions/<name>` — bypassing launchProject and its gate
 * entirely. On a fresh install, creating a project is the FIRST launch anyone
 * performs, which is why clean-Mac installs never saw the picker while
 * long-lived installs (opening existing projects via the card button) did.
 *
 * #1304 moved WHEN the gated launch happens — creating a project opens
 * Settings in its draft/setup step instead of launching immediately, so the
 * operator can configure Medusa/model/rules first — but not WHETHER it stays
 * gated: "Save & Launch" (public/ui.js#_submitSettings) still calls the same
 * launchProject, one hop later, which is what `test/create-launch-posture.test.js`
 * pins directly. This file's job narrows to what's still true at the create
 * step itself: no raw session POST, and launchProject's own picker gate
 * (second test below) is unchanged.
 *
 * Two hops, both pinned by running the REAL functions:
 *  1. submitCreate hands off to openSettings — no raw launch, no direct
 *     launchProject call from the create step itself.
 *  2. launchProject, given the real bundled claude profile, opens the picker.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { liftDeclaration, liftBody } = require('./helpers/lift');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const LANDING_SRC = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');
const API_HELPER_SRC = fs.readFileSync(path.join(PUB, 'api-helper.js'), 'utf8');
const SESSION_SRC = fs.readFileSync(path.join(PUB, 'session.js'), 'utf8');

// The REAL bundled profile — the shape a fresh install seeds (#251 syncs it
// on every boot), not a hand-invented launchModes block.
const CLAUDE_PROFILE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'claude.json'), 'utf8'));

/** A DOM element stub covering what the create drawer touches. */
function makeElement() {
  const classSet = new Set();
  return {
    value: '', textContent: '', innerHTML: '', disabled: false,
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c)
    }
  };
}

describe('create flow routes through the launch gate (#401)', () => {
  it('submitCreate hands off to openSettings in its draft/setup step, performing no raw launch and no direct launchProject call (#1304)', async () => {
    // One shared sequence array: the ORDER is load-bearing, not just the
    // counts.
    const seq = [];
    const elements = new Map();
    const sandbox = {
      console, setTimeout: () => 0, clearTimeout() {},
      document: {
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, makeElement());
          return elements.get(id);
        }
      },
      apiMutate: async () => ({ ok: true }),
      api: Object.assign(async () => null, { lastError: null }),
      loadProjects: async () => { seq.push('loadProjects'); },
      // #1304: submitCreate must not reach launchProject directly any more —
      // that now only happens one hop later, from "Save & Launch"
      // (test/create-launch-posture.test.js pins that hop directly).
      launchProject: async (name) => { seq.push(`launchProject:${name}`); },
      openSettings: (name, options) => { seq.push(`openSettings:${name}:${JSON.stringify(options)}`); },
      closeCreateModal: () => {},
      navigateToSession: (name) => { seq.push(`NAVIGATE:${name}`); },
      fetch: async (url, opts) => {
        seq.push(`${(opts && opts.method) || 'GET'} ${url}`);
        return { ok: true, json: async () => ({}) };
      }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    // `submitCreate` builds its POST body through `tcCreateProjectBody`
    // (api-helper.js), which the page loads first. Lifted here with the
    // predicate and tables it closes over — this test caught the omission as a
    // ReferenceError from inside the real function, which is what running the
    // code buys over matching its source.
    const settingTables = API_HELPER_SRC.match(/const TC_SETTING_\w+ = \{[\s\S]*?\n {2}\};/g) || [];
    assert.ok(settingTables.length >= 2, 'the setting tables must lift');
    vm.runInContext([
      'let createStep = 0;',
      "let createData = { name: 'proj-x', engine: 'claude', tags: '' };",
      // The body builder resolves the chosen engine off `state.engines`, the
      // same roster the drawer's picker is built from.
      `let state = { engines: [${JSON.stringify(CLAUDE_PROFILE)}] };`,
      ...settingTables,
      liftDeclaration(API_HELPER_SRC, 'function tcHonoredLaunchModes'),
      liftDeclaration(API_HELPER_SRC, 'function tcEngineDisplayName'),
      liftDeclaration(API_HELPER_SRC, 'function tcSettingDisposition'),
      liftDeclaration(API_HELPER_SRC, 'function tcCreateProjectBody'),
      liftDeclaration(UI_SRC, 'async function submitCreate()'),
      'globalThis.submitCreate = submitCreate;'
    ].join('\n'), sandbox);

    await sandbox.submitCreate();

    assert.deepEqual(seq, ['loadProjects', 'openSettings:proj-x:{"offerLaunch":true}'],
      'exactly one refresh THEN Settings opened in its draft/setup step (#1304) — no raw '
      + 'session POST, no navigation around the gate, and no direct launchProject call '
      + 'from the create step itself (that only happens one hop later, via Save & Launch)');
  });

  it('launchProject opens the picker for the real bundled claude profile', async () => {
    const calls = { picker: [], direct: [] };
    const sandbox = {
      console,
      state: {
        projects: [{ name: 'proj-x', engineId: 'claude', session: null }],
        config: { defaultEngine: 'claude' },
        engines: [{ id: 'claude', launchModes: CLAUDE_PROFILE.launchModes,
          defaultLaunchMode: CLAUDE_PROFILE.defaultLaunchMode }]
      },
      navigateToSession: () => { assert.fail('no session exists to navigate to'); },
      openLaunchModeModal: (name, engine) => { calls.picker.push({ name, engine }); },
      doLaunchProject: async (name, mode) => { calls.direct.push({ name, mode }); }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext([
      // The gate asks the shared helper which modes the engine will run, so it
      // comes along: running the REAL gate is the point of this test.
      liftDeclaration(API_HELPER_SRC, 'function tcHonoredLaunchModes(engine)'),
      liftDeclaration(LANDING_SRC, 'function proceedWithLaunchModeCheck(name, project, continuityMode)'),
      liftDeclaration(LANDING_SRC, 'async function launchProject(name)'),
      'globalThis.launchProject = launchProject;'
    ].join('\n'), sandbox);

    await sandbox.launchProject('proj-x');

    assert.equal(calls.picker.length, 1,
      'the real claude profile offers a choice of modes — the picker must open');
    assert.equal(calls.picker[0].name, 'proj-x');
    assert.deepEqual(calls.direct, [], 'no silent no-mode launch when a choice exists');
    const enabled = Object.values(CLAUDE_PROFILE.launchModes).filter((m) => !m.disabled);
    assert.ok(enabled.length > 1,
      'the bundled profile itself must keep offering >1 enabled mode, or the gate closes');
  });

  it('still honors a per-project picker opt-out on the create path', async () => {
    const calls = { picker: [], direct: [] };
    const sandbox = {
      console,
      state: {
        projects: [{ name: 'proj-x', engineId: 'claude', session: null,
          showLaunchModePicker: false }],
        config: { defaultEngine: 'claude' },
        engines: [{ id: 'claude', launchModes: CLAUDE_PROFILE.launchModes,
          defaultLaunchMode: CLAUDE_PROFILE.defaultLaunchMode }]
      },
      navigateToSession: () => {},
      openLaunchModeModal: (name, engine) => { calls.picker.push(name); },
      doLaunchProject: async (name, mode) => { calls.direct.push({ name, mode }); }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext([
      // The gate asks the shared helper which modes the engine will run, so it
      // comes along: running the REAL gate is the point of this test.
      liftDeclaration(API_HELPER_SRC, 'function tcHonoredLaunchModes(engine)'),
      liftDeclaration(LANDING_SRC, 'function proceedWithLaunchModeCheck(name, project, continuityMode)'),
      liftDeclaration(LANDING_SRC, 'async function launchProject(name)'),
      'globalThis.launchProject = launchProject;'
    ].join('\n'), sandbox);

    await sandbox.launchProject('proj-x');

    assert.deepEqual(calls.picker, [], 'opt-out projects skip the picker by choice');
    assert.deepEqual(calls.direct, [{ name: 'proj-x', mode: null }],
      'the server resolves the configured default mode — the UI sends none');
  });
});

describe('a successful launch carries a path-health warning via sessionStorage, never a blocking confirm (#2401 PRR-A renewed REVISE: a confirm() decline stranded an already-launched session)', () => {
  /**
   * Run the page's own `doLaunchProject` against a successful launch.
   * @param {object|null} pathHealthWarning - The response's warning, or null.
   * @returns {Promise<{seq: string[], store: object}>} The ordered call
   *   sequence, and the fake sessionStorage's final contents.
   */
  async function run(pathHealthWarning) {
    const seq = [];
    const store = {};
    const sandbox = {
      console, setTimeout: () => 0, clearTimeout() {},
      document: { querySelector: () => null },
      setConnected: () => {},
      closeStrandedLaunchModal: () => {},
      navigateToSession: (name) => seq.push(`navigate:${name}`),
      sessionStorage: { setItem: (k, v) => { seq.push(`setItem:${k}`); store[k] = v; } },
      tcFetch: async () => ({ ok: true, json: async () => ({ sessionId: 1, pathHealthWarning }) })
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext([
      liftDeclaration(LANDING_SRC, 'async function doLaunchProject('),
      'globalThis.doLaunchProject = doLaunchProject;'
    ].join('\n'), sandbox);
    await sandbox.doLaunchProject('proj-x', null, null);
    return { seq, store };
  }

  it('navigates immediately when the launch carries no warning, writing nothing to sessionStorage', async () => {
    const { seq, store } = await run(null);
    assert.deepEqual(seq, ['navigate:proj-x']);
    assert.deepEqual(store, {});
  });

  it('stashes the warning in sessionStorage and still navigates immediately — no confirm() to strand the already-launched session', async () => {
    const warning = { message: 'proj-x has no git history', code: 'PROJECT_PATH_UNSEEDED' };
    const { seq, store } = await run(warning);
    assert.deepEqual(seq, ['setItem:tc_pathHealthWarning', 'navigate:proj-x']);
    assert.deepEqual(JSON.parse(store.tc_pathHealthWarning), warning);
  });
});

describe('session.js shows the launch path-health warning carried via sessionStorage (#2401 PRR-A renewed REVISE)', () => {
  const start = SESSION_SRC.indexOf('// #2401: a pathHealthWarning');
  const end = SESSION_SRC.indexOf('// Keep the terminal\'s prompt', start);
  const snippet = SESSION_SRC.slice(start, end);

  it('is present inside initSession itself, not dead code elsewhere', () => {
    assert.ok(start > -1, 'the #2401 snippet must exist in session.js');
    const initBody = liftBody(SESSION_SRC, 'async function initSession()');
    assert.ok(initBody.includes(snippet.trim()), 'the snippet must be inside initSession');
  });

  /**
   * Run the extracted snippet with a controllable sessionStorage + flashToast.
   * @param {string|null} stored - What sessionStorage.getItem returns, or null.
   * @returns {{toasts: Array<{msg: string, cls: string}>, removed: string[], storeAfter: object}}
   */
  function run(stored) {
    const toasts = [];
    const removed = [];
    const store = stored === null ? {} : { tc_pathHealthWarning: stored };
    const sessionStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      removeItem: (k) => { removed.push(k); delete store[k]; }
    };
    const flashToast = (msg, cls) => toasts.push({ msg, cls });
    new Function('sessionStorage', 'flashToast', snippet)(sessionStorage, flashToast);
    return { toasts, removed, storeAfter: store };
  }

  it('does nothing when nothing was stashed', () => {
    const { toasts, removed } = run(null);
    assert.deepEqual(toasts, []);
    assert.deepEqual(removed, []);
  });

  it('shows the warning as a toast-warn flash and clears the key, read-once', () => {
    const warning = { message: 'proj-x has no git history', code: 'PROJECT_PATH_UNSEEDED' };
    const { toasts, removed, storeAfter } = run(JSON.stringify(warning));
    assert.deepEqual(toasts, [{ msg: warning.message, cls: 'toast-warn' }]);
    assert.deepEqual(removed, ['tc_pathHealthWarning']);
    assert.equal('tc_pathHealthWarning' in storeAfter, false);
  });
});
