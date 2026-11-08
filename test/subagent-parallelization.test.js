'use strict';

/*
 * Authorization toggle: Allow sub-agent parallelization (#1257).
 *
 * `lib/subagent-parallelization.js` holds the pure logic: whether an engine
 * declares `supportsSubagentDispatch`, the honest reason when it does not
 * (ADR 0013), and the Read/Write heuristic a Builder applies once
 * authorized. This file pins that logic directly, then exercises the
 * Project Settings control the same way `test/setting-disposition.test.js`
 * exercises `renderMedusaWakeToggle` — the shipped renderer, lifted from
 * source, against a mini-DOM, never a copy.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const subagent = require('../lib/subagent-parallelization');
const engines = require('../lib/engines');
const { liftDeclaration } = require('./helpers/lift');
const { makeDocument } = require('./_mini-dom');

describe('supportsSubagentDispatch (#1257)', () => {
  it('is true only for a profile declaring it, never by default', () => {
    assert.equal(subagent.supportsSubagentDispatch({ capabilities: { supportsSubagentDispatch: true } }), true);
    assert.equal(subagent.supportsSubagentDispatch({ capabilities: { supportsSubagentDispatch: false } }), false);
    assert.equal(subagent.supportsSubagentDispatch({ capabilities: {} }), false);
    assert.equal(subagent.supportsSubagentDispatch({}), false);
    assert.equal(subagent.supportsSubagentDispatch(null), false);
  });

  it('agrees with every bundled engine profile declared in data/engines/*.json', () => {
    // claude, codex and antigravity declare native sub-agent fan-out; aider
    // and openclaw do not (A506-W2C-SCOPE-DATA-ENGINES).
    const dir = path.join(__dirname, '..', 'data', 'engines');
    const expected = { claude: true, codex: true, antigravity: true, aider: false, openclaw: false };
    for (const [id, expectedValue] of Object.entries(expected)) {
      const profile = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
      assert.equal(subagent.supportsSubagentDispatch(profile), expectedValue, id);
    }
  });
});

describe('subagentDispatchReason (#1257)', () => {
  it('names the engine and states the setting has no effect', () => {
    assert.equal(
      subagent.subagentDispatchReason({ name: 'Aider' }),
      'Aider does not support sub-agent dispatch, so this setting has no effect on this project.'
    );
  });

  it('falls back to "This engine" when no profile is given', () => {
    assert.match(subagent.subagentDispatchReason(null), /^This engine does not support sub-agent dispatch/);
  });
});

describe('evaluateSubagentTask: the Read/Write heuristic (#1257)', () => {
  it('fans out pure reading/discovery', () => {
    const result = subagent.evaluateSubagentTask({ writes: false });
    assert.equal(result.parallelizable, true);
    assert.match(result.reason, /reading\/discovery/);
  });

  it('serializes anything that writes', () => {
    const result = subagent.evaluateSubagentTask({ writes: true });
    assert.equal(result.parallelizable, false);
    assert.match(result.reason, /writes into shared files/);
  });

  it('serializes git-state mutation even when the task does not otherwise write', () => {
    const result = subagent.evaluateSubagentTask({ writes: false, mutatesGitState: true });
    assert.equal(result.parallelizable, false);
    assert.match(result.reason, /mutates git state directly/);
  });

  it('a task that both writes and mutates git state is serialized for the git-state reason', () => {
    // Worktree hazards are checked first: a sub-agent racing git state is the
    // sharper failure mode (a yanked HEAD), so it is named even when the task
    // would also fail the plain write check.
    const result = subagent.evaluateSubagentTask({ writes: true, mutatesGitState: true });
    assert.equal(result.parallelizable, false);
    assert.match(result.reason, /mutates git state directly/);
  });

  it('refuses to guess from a missing or malformed task description', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const result = subagent.evaluateSubagentTask(bad);
      assert.equal(result.parallelizable, false);
      assert.match(result.reason, /no task description was given/);
    }
  });
});

describe('asHypothesis: a sub-agent finding is never adopted unverified (#1257)', () => {
  it('wraps a finding as an unverified hypothesis', () => {
    const wrapped = subagent.asHypothesis('the file is dead code', 'sub-1');
    assert.deepEqual(wrapped, { status: 'hypothesis', finding: 'the file is dead code', source: 'sub-1', verifiedAt: null });
  });

  it('defaults source to null when omitted', () => {
    const wrapped = subagent.asHypothesis('x');
    assert.equal(wrapped.source, null);
    assert.equal(wrapped.verifiedAt, null);
  });
});

describe('the ENGINE_CONDITIONAL_SETTINGS row (#1257)', () => {
  it('gates outright, exactly like medusaWake, with no caveat', () => {
    const spec = engines.ENGINE_CONDITIONAL_SETTINGS.subagentParallelizationEnabled;
    assert.equal(typeof spec.applies, 'function');
    assert.equal(typeof spec.reason, 'function');
    assert.equal(typeof spec.evidence, 'function');
    assert.equal(spec.caveat, undefined);
    assert.equal(spec.shippedDefault(), false);
  });

  it('settingDisposition agrees with supportsSubagentDispatch over the bundled roster', () => {
    const dir = path.join(__dirname, '..', 'data', 'engines');
    for (const id of ['claude', 'codex', 'antigravity', 'aider', 'openclaw']) {
      const profile = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
      const d = engines.settingDisposition('subagentParallelizationEnabled',
        { subagentParallelizationEnabled: true }, profile);
      assert.equal(d.applies, subagent.supportsSubagentDispatch(profile), id);
      if (!d.applies) {
        assert.equal(d.reason, subagent.subagentDispatchReason(profile), id);
        assert.equal(d.evidence, 'capabilities.supportsSubagentDispatch is not true');
      }
    }
  });

  it('an untouched project on a supporting engine reads the shipped default, with nothing to say', () => {
    const untouched = engines.settingDisposition('subagentParallelizationEnabled', {},
      { id: 'claude', name: 'Claude Code', capabilities: { supportsSubagentDispatch: true } });
    assert.equal(untouched.value, false);
    assert.equal(untouched.chosen, false);
    assert.equal(untouched.applies, true);
    // Applies, with nothing stored off the default and no caveat: there is
    // nothing for the operator to read, so the disposition has no level.
    assert.equal(untouched.level, null);
  });

  it('an untouched project on an unsupported engine reads the shipped default and records at info level', () => {
    const untouched = engines.settingDisposition('subagentParallelizationEnabled', {},
      { id: 'aider', name: 'Aider', capabilities: {} });
    assert.equal(untouched.value, false);
    assert.equal(untouched.chosen, false);
    assert.equal(untouched.applies, false);
    assert.equal(untouched.level, 'info');
  });

  it('a stored true on an unsupported engine is a real choice and warns', () => {
    const chosen = engines.settingDisposition('subagentParallelizationEnabled',
      { subagentParallelizationEnabled: true }, { id: 'aider', name: 'Aider', capabilities: {} });
    assert.equal(chosen.applies, false);
    assert.equal(chosen.chosen, true);
    assert.equal(chosen.level, 'warn');
  });
});

describe('the Project Settings modal control (#1257)', () => {
  const UI = fs.readFileSync(path.join(__dirname, '..', 'public', 'subagent-parallelization-ui.js'), 'utf8');
  const API = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');

  /**
   * Run the shipped renderer against a mini-DOM and return the container's
   * HTML — the real function, lifted from source, not a copy.
   * @param {object} opts - `engineId`, `projectEngine`, `checked`, `engines`.
   * @returns {string}
   */
  function render(opts) {
    const { doc } = makeDocument(['settingsSubagentParallelizationContainer']);
    const ctx = {
      document: doc,
      state: { engines: opts.engines || [] },
      esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    };
    vm.createContext(ctx);
    const tables = API.match(/const TC_SETTING_\w+ = \{[\s\S]*?\n {2}\};/g) || [];
    assert.ok(tables.length >= 3, `expected the setting tables to lift, found ${tables.length}`);
    for (const table of tables) vm.runInContext(table, ctx);
    vm.runInContext(liftDeclaration(API, 'function tcHonoredLaunchModes'), ctx);
    vm.runInContext(liftDeclaration(API, 'function tcEngineDisplayName'), ctx);
    vm.runInContext(liftDeclaration(API, 'function tcSettingDisposition'), ctx);
    vm.runInContext(liftDeclaration(API, 'function tcResolveEngineProfile'), ctx);
    vm.runInContext(liftDeclaration(UI, 'function renderSubagentParallelizationToggle'), ctx);
    ctx.renderSubagentParallelizationToggle(opts.engineId, opts.checked === true, opts.projectEngine || null);
    return doc.getElementById('settingsSubagentParallelizationContainer').innerHTML;
  }

  it('is live, unchecked by default, on an engine that supports dispatch', () => {
    const html = render({
      engineId: 'claude',
      engines: [{ id: 'claude', name: 'Claude Code', capabilities: { supportsSubagentDispatch: true } }]
    });
    assert.match(html, /id="settingsSubagentParallelization"/);
    assert.doesNotMatch(html, /checked/);
    assert.match(html, /Allow sub-agent parallelization/);
  });

  it('preserves a checked state across a re-render', () => {
    const html = render({
      engineId: 'claude',
      checked: true,
      engines: [{ id: 'claude', name: 'Claude Code', capabilities: { supportsSubagentDispatch: true } }]
    });
    assert.match(html, /id="settingsSubagentParallelization" checked/);
  });

  it('renders inert with the honest reason on an engine that does not support dispatch', () => {
    const html = render({
      engineId: 'aider',
      engines: [{ id: 'aider', name: 'Aider', capabilities: {} }]
    });
    assert.match(html, /id="settingsSubagentParallelizationNotApplicable" disabled/);
    assert.doesNotMatch(html, /id="settingsSubagentParallelization"[^N]/);
    assert.match(html, /Aider does not support sub-agent dispatch/);
  });

  it('never silently hides the control — a profile TangleClaw has no data for still says so', () => {
    const html = render({ engineId: 'nonexistent-engine', engines: [] });
    assert.match(html, /disabled/);
    assert.match(html, /has no profile for this engine/);
  });
});
