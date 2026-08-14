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
 * Two hops, both pinned by running the REAL functions:
 *  1. submitCreate routes through launchProject and performs no raw launch.
 *  2. launchProject, given the real bundled claude profile, opens the picker.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const LANDING_SRC = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');

// The REAL bundled profile — the shape a fresh install seeds (#251 syncs it
// on every boot), not a hand-invented launchModes block.
const CLAUDE_PROFILE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'claude.json'), 'utf8'));

/**
 * Slice a top-level function (declaration + body) out of source text by
 * brace-matching, so the sandbox runs the REAL code rather than a copy.
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
  it('submitCreate hands off to launchProject and performs no raw launch', async () => {
    // One shared sequence array: the ORDER is load-bearing, not just the
    // counts. launchProject reads the refreshed state.projects to honor the
    // per-project picker opt-out — launch-before-refresh would silently skip
    // it while a count-only assertion stayed green.
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
      launchProject: async (name) => { seq.push(`launchProject:${name}`); },
      closeCreateModal: () => {},
      navigateToSession: (name) => { seq.push(`NAVIGATE:${name}`); },
      fetch: async (url, opts) => {
        seq.push(`${(opts && opts.method) || 'GET'} ${url}`);
        return { ok: true, json: async () => ({}) };
      }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext([
      'let createStep = 0;',
      "let createData = { name: 'proj-x', engine: 'claude', tags: '' };",
      liftFunction(UI_SRC, 'async function submitCreate()'),
      'globalThis.submitCreate = submitCreate;'
    ].join('\n'), sandbox);

    await sandbox.submitCreate();

    assert.deepEqual(seq, ['loadProjects', 'launchProject:proj-x'],
      'exactly one refresh THEN one gated launch — no raw session POST, no '
      + 'navigation around the gate, and never launch before the list refresh');
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
      liftFunction(LANDING_SRC, 'async function launchProject(name)'),
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
      liftFunction(LANDING_SRC, 'async function launchProject(name)'),
      'globalThis.launchProject = launchProject;'
    ].join('\n'), sandbox);

    await sandbox.launchProject('proj-x');

    assert.deepEqual(calls.picker, [], 'opt-out projects skip the picker by choice');
    assert.deepEqual(calls.direct, [{ name: 'proj-x', mode: null }],
      'the server resolves the configured default mode — the UI sends none');
  });
});
