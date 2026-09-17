'use strict';

/**
 * What each launch step carries (Train 21, car 21.2).
 *
 * `test/prime-golden.test.js` pins that the pushed prime did not change; this
 * pins the other half — that the four pulled steps carry what the plan's step
 * table says, and that the one declared push delta (the bootstrap line) appears
 * exactly when the launch has a sequence.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const continuity = require('../lib/continuity');

describe('launch step contents (car 21.2)', () => {
  let tmpDir;
  let sessions;
  let project;
  let engine;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-steps-'));
    store._setBasePath(tmpDir);
    store.init();
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');

    const dir = path.join(projectsDir, 'steps-project');
    fs.mkdirSync(dir, { recursive: true });
    project = store.projects.create({ name: 'steps-project', path: dir, engine: 'claude' });
    // Silent prime ON: the push path sends a rules MANIFEST, so a pull that
    // served the same thing would point at a channel and carry nothing.
    store.projectConfig.save(dir, { silentPrime: true });
    store.sessionRules.create({ projectId: project.id, content: 'The full text of a project rule.' });
    store.learnings.create({ projectId: project.id, content: 'A learning this session should have.', tier: 'active' });
    continuity.writeIndex(dir, {
      project: 'steps-project',
      currentState: 'Mid-chunk.',
      nextAction: 'finish the step renderer',
      freshness: { sha: 'abc1234', branch: 'feat/steps', writtenAt: '2026-09-17' }
    });
    fs.mkdirSync(path.join(dir, '.tangleclaw', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.tangleclaw', 'plans', 'a-plan.md'), '# A plan\n');
    engine = store.engines.get('claude');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Render the four steps for the fixture project. */
  const render = (options = {}) => sessions.renderLaunchSteps(project, engine, { operatorHost: 'operator.example.test', ...options });

  it('serves four non-empty steps, in the order the store accepts', () => {
    const steps = render();
    assert.deepEqual(Object.keys(steps), store.LAUNCH_STEP_IDS);
    for (const id of store.LAUNCH_STEP_IDS) {
      assert.ok(steps[id].trim().length > 0, `${id} is not empty`);
    }
  });

  it('step 1 carries identity, the global rules and the wrap sentinel', () => {
    const { identity } = render();
    assert.match(identity, /# Session Start — steps-project/);
    assert.match(identity, /## Session Ownership/);
    assert.match(identity, /## Scope Guard/);
    assert.match(identity, /## Global rules/);
    assert.match(identity, /## Wrapping this session/);
    assert.match(identity, /## Launch sequence/, 'the bootstrap line rides step 1');
  });

  it('step 2 carries the rules in full, not the manifest that points at a channel', () => {
    const { governance } = render();
    assert.match(governance, /## Project Rules/);
    assert.ok(governance.includes('The full text of a project rule.'), 'the rule body is served');
    assert.ok(!governance.includes('## Rules delivery'), 'not the push manifest');
    assert.match(governance, /## Rule sources in force/);
    assert.match(governance, /delivered in this launch step/);
    assert.match(governance, /## Engine config and shared documents/);
    assert.ok(governance.includes('CLAUDE.md'), "the engine's own config filename, not a hardcoded one");
    assert.match(governance, /## Active Learnings/);
    assert.ok(governance.includes('A learning this session should have.'));
  });

  it('step 3 leads with the preflight verdict and says what it does not know', () => {
    const { state } = render();
    assert.match(state, /## Launch preflight/);
    assert.match(state, /not-evaluated/);
    assert.match(state, /Do not read this as a clean handoff/);
    assert.match(state, /Stranded wraps/);
  });

  it('step 4 proposes the recorded next action and points at the plans', () => {
    const { task } = render();
    assert.match(task, /## Resume/);
    assert.ok(task.includes('finish the step renderer'));
    assert.match(task, /Wait for the operator/, 'the resume rules are unchanged: it proposes, it does not authorize');
    assert.match(task, /## Plans/);
    assert.ok(task.includes(path.join(project.path, '.tangleclaw', 'plans', 'a-plan.md')));
    assert.match(task, /\/api\/projects\/\d+\/plans/, 'and the route that gives the shareable link');
  });

  it('step 4 says so when there is no recorded next action', () => {
    const fresh = render({ continuityMode: 'fresh' });
    assert.match(fresh.task, /## Task/);
    assert.match(fresh.task, /deliberately not offered/);
    assert.ok(!fresh.task.includes('## Resume'));
  });

  it('bulk reference material stays outside the sequence', () => {
    const steps = render();
    const all = Object.values(steps).join('\n');
    assert.ok(!all.includes('## TangleClaw Ecosystem'), 'the ecosystem primer is pointer-shaped and not served here');
  });

  it('the pushed prime names the sequence only when the launch has one', () => {
    const withSequence = sessions.generatePrimePrompt(project, engine, { operatorHost: 'operator.example.test', launchSequence: true });
    const without = sessions.generatePrimePrompt(project, engine, { operatorHost: 'operator.example.test' });
    assert.match(withSequence, /Run `tc start next` now/);
    assert.ok(!without.includes('Run `tc start next` now'));
    // The delta is exactly the bootstrap block and nothing else.
    assert.equal(withSequence.replace(`${sessions.LAUNCH_BOOTSTRAP_LINES.join('\n')}\n`, ''), without);
  });

  it('renderLaunchStep answers for one step and refuses an unknown one', () => {
    const ctx = { project, engineProfile: engine, options: { operatorHost: 'operator.example.test' } };
    assert.equal(sessions.renderLaunchStep('governance', ctx), render().governance);
    assert.throws(() => sessions.renderLaunchStep('preflight', ctx), /Unknown launch step/);
  });
});
