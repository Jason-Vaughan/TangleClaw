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

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const subagent = require('../lib/subagent-parallelization');
const engines = require('../lib/engines');
const store = require('../lib/store');
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

  it('fails closed on an unknown write status, rather than guessing "no writes" (A506-W2C-R6)', () => {
    // {} is a well-formed object, so it passes the malformed-task guard above
    // -- this is the PRR-B-caught bug: an absent `writes` must not be treated
    // the same as a known `false`.
    for (const bad of [{}, { writes: undefined }, { writes: null }, { writes: 'false' }, { writes: 0 }, { writes: 1 }]) {
      const result = subagent.evaluateSubagentTask(bad);
      assert.equal(result.parallelizable, false, JSON.stringify(bad));
      assert.equal(result.reason, 'task.writes must be an explicit boolean — serialize rather than guess', JSON.stringify(bad));
    }
  });

  it('a known writes:false is the only way to reach the fan-out branch', () => {
    assert.equal(subagent.evaluateSubagentTask({ writes: false }).parallelizable, true);
    assert.equal(subagent.evaluateSubagentTask({ writes: false, mutatesGitState: false }).parallelizable, true);
  });
});

describe('evaluateSubagentDispatch: the combined gate (#1257, A506-W2C-R6)', () => {
  const supporting = { id: 'claude', name: 'Claude Code', capabilities: { supportsSubagentDispatch: true } };
  const unsupporting = { id: 'aider', name: 'Aider', capabilities: {} };

  it('fails closed on engine capability first', () => {
    const d = subagent.evaluateSubagentDispatch({
      engineProfile: unsupporting, projectConfig: { subagentParallelizationEnabled: true }, task: { writes: false }
    });
    assert.equal(d.authorized, false);
    assert.equal(d.reason, subagent.subagentDispatchReason(unsupporting));
  });

  it('fails closed on project authorization second, even on a supporting engine', () => {
    const d = subagent.evaluateSubagentDispatch({
      engineProfile: supporting, projectConfig: { subagentParallelizationEnabled: false }, task: { writes: false }
    });
    assert.equal(d.authorized, false);
    assert.match(d.reason, /has not authorized/);
  });

  it('fails closed on the Read/Write heuristic third, even when engine and project both authorize', () => {
    const d = subagent.evaluateSubagentDispatch({
      engineProfile: supporting, projectConfig: { subagentParallelizationEnabled: true }, task: { writes: true }
    });
    assert.equal(d.authorized, false);
    assert.match(d.reason, /writes into shared files/);
  });

  it('authorizes only when all three gates pass', () => {
    const d = subagent.evaluateSubagentDispatch({
      engineProfile: supporting, projectConfig: { subagentParallelizationEnabled: true }, task: { writes: false }
    });
    assert.equal(d.authorized, true);
  });

  it('never guesses from a missing opts object', () => {
    const d = subagent.evaluateSubagentDispatch();
    assert.equal(d.authorized, false);
  });
});

describe('ingestSubagentFinding: a finding never reaches project state without an authorized dispatch (#1257, A506-W2C-R6)', () => {
  const authorized = { authorized: true, reason: 'pure reading/discovery can fan out safely' };
  const refused = { authorized: false, reason: 'this project has not authorized sub-agent parallelization' };

  it('wraps the finding as a hypothesis when the dispatch verdict authorized it', () => {
    const result = subagent.ingestSubagentFinding(authorized, 'the file is dead code', 'sub-1');
    assert.deepEqual(result, { status: 'hypothesis', finding: 'the file is dead code', source: 'sub-1', verifiedAt: null });
  });

  it('refuses the finding outright when the dispatch verdict did not authorize it', () => {
    const result = subagent.ingestSubagentFinding(refused, 'an unauthorized finding');
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, refused.reason);
  });

  it('refuses rather than guesses when no dispatch verdict is given at all', () => {
    const result = subagent.ingestSubagentFinding(null, 'x');
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /no authorized dispatch verdict/);
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

describe('carrier wiring: the toggle reaches the generated config (#1257, A506-W2C-R6)', () => {
  const ON = { subagentParallelizationEnabled: true };
  const OFF = { subagentParallelizationEnabled: false };
  const UNSET = {};
  let tmpDir;

  // store.engines.get() only re-syncs its bundled-profile cache from the real
  // data/engines/*.json once store.init() has run in this process — without
  // it, generateConfig('claude', ...) reads a profile with no
  // supportsSubagentDispatch flag at all, and every assertion below fails
  // for a reason that has nothing to do with the code under test.
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-subagent-engines-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('claude.md carries the guidance when the project turned it on, on a supporting engine', () => {
    const content = engines.generateConfig('claude', ON);
    assert.match(content, /Sub-agent parallelization is authorized/);
    assert.match(content, /#1257/);
  });

  it('claude.md is byte-for-byte unchanged when the toggle is off or unset', () => {
    const off = engines.generateConfig('claude', OFF);
    const unset = engines.generateConfig('claude', UNSET);
    assert.doesNotMatch(off, /Sub-agent parallelization is authorized/);
    assert.equal(off, unset, 'off must read identically to never having touched the setting');
  });

  it('never appears on an engine that does not declare supportsSubagentDispatch, even when the project turned it on', () => {
    const content = engines.generateConfig('aider', ON);
    assert.doesNotMatch(content, /Sub-agent parallelization is authorized/);
  });

  it('the aider conventions carrier (the second file) also carries it when authorized on a supporting profile', () => {
    // generateConfig('aider', ...) renders .aider.conf.yml, a bare `read:`
    // pointer with no rules content at all (lib/engines.js#_generateAiderConf)
    // -- the actual rules carrier is the second file,
    // _generateAiderConventionsMd, which this exercises directly against a
    // FABRICATED supporting profile the bundled aider.json itself is not,
    // proving the wiring (not aider's own declared capability).
    const supportingProfile = { id: 'claude', name: 'Claude Code', capabilities: { supportsSubagentDispatch: true } };
    const content = engines._generateAiderConventionsMd(ON, null, supportingProfile);
    assert.match(content, /Sub-agent parallelization is authorized/);
  });

  it('codex.yaml and GEMINI.md carry it too, under the same gate', () => {
    assert.match(engines.generateConfig('codex', ON), /Sub-agent parallelization is authorized/);
    assert.match(engines.generateConfig('antigravity', ON), /Sub-agent parallelization is authorized/);
  });

  describe('saving the toggle through a real project refreshes the live carrier immediately', () => {
    // Isolated store, same pattern test/projects.test.js's own before/after
    // uses — a fresh temp projectsDir, never the real install's. Shadows the
    // outer describe's own tmpDir/store init with its own, since this one
    // also needs a projectsDir and a real project on disk.
    const projects = require('../lib/projects');
    let tmpDir;
    let projectsDir;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-subagent-carrier-'));
      projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      const config = store.config.load();
      config.projectsDir = projectsDir;
      store.config.save(config);
    });

    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('CLAUDE.md gains the guidance only after the toggle is saved on', async () => {
      const name = 'subagent-carrier-test';
      const created = projects.createProject({ name, engine: 'claude' });
      assert.deepEqual(created.errors, []);
      const carrierPath = path.join(created.project.path, 'CLAUDE.md');

      const before = fs.readFileSync(carrierPath, 'utf8');
      assert.doesNotMatch(before, /Sub-agent parallelization is authorized/);

      const updated = await projects.updateProject(name, { subagentParallelizationEnabled: true });
      assert.deepEqual(updated.errors, []);

      const after = fs.readFileSync(carrierPath, 'utf8');
      assert.match(after, /Sub-agent parallelization is authorized/);
    });
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
