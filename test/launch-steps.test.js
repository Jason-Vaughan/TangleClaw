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

  // #1680. A launch stopped and asked the operator for permission to run
  // `tc start next`. Nothing in the sequence told it to: the prime carried two
  // directives that each claimed the first turn, and a wait-for-confirmation
  // rule that named no scope, so "do not act before the operator confirms"
  // read as covering initialization itself. These pin the three properties
  // that resolve it — one stated order, initialization authorized, and the
  // project-work gate still shut.
  describe('the opening order is stated once and initialization is authorized (#1680)', () => {
    it('step 1 states the whole order before any directive that claims a turn', () => {
      const { identity } = render();
      assert.match(identity, /Your opening runs in this order:/);
      // The order must name all four stages, in order, in one place.
      const order = identity.slice(identity.indexOf('Your opening runs in this order:'));
      const stages = ['(a)', '(b)', '(c)', '(d)'].map((n) => order.indexOf(`\n${n} `));
      assert.ok(stages.every((i) => i > -1), 'all four stages are present');
      assert.deepEqual(stages, [...stages].sort((a, b) => a - b), 'and they are in order');
      // The stages must not be numbered: "step N" already means a
      // launch-sequence step, and a rival 1-4 is how "step 4" comes to mean
      // the task step rather than the proposal.
      assert.ok(!/\n[1-4]\. /.test(order),
        'the opening stages never reuse the numbering that already names launch steps');
      // The name says "before any directive that claims a turn", so check it
      // rather than leave the name carrying an unasserted claim. The banner
      // block is the one such directive sharing this step; the Resume section
      // is the other, and it rides step 4, which is after step 1 by
      // construction.
      const bannerIdx = identity.indexOf('begin your FIRST visible reply');
      const orderIdx = identity.indexOf('Your opening runs in this order:');
      assert.ok(bannerIdx > -1 && orderIdx > bannerIdx,
        'the stated order follows the banner directive it sequences, in the same step');
    });

    it('step 1 authorizes initialization explicitly and scopes the confirmation rule to the work', () => {
      const { identity } = render();
      assert.match(identity, /already authorized/, 'routine bootstrap needs no operator approval');
      assert.match(identity, /Do not ask the operator to approve them/);
      assert.match(identity, /those rules gate \(d\), the work you propose/,
        'the wait-for-confirmation rule is scoped to the proposed work, not to initialization');
      assert.match(identity, /never gate reading a launch step, including the task step/,
        'and it says so about the step whose arrival used to be read as needing approval');
    });

    it('authorizing initialization does not widen into authorizing the work', () => {
      const { identity } = render();
      assert.match(identity, /never authorize executing the recorded next action/);
      assert.match(identity, /privileged-action approval requirement still applies/);
    });

    it('step 4 never claims to be the first visible message', () => {
      const { task } = render();
      assert.ok(!/FIRST visible message/i.test(task),
        'a step served fourth cannot be obeyed as the first thing said');
      assert.ok(!/Before doing anything else/i.test(task),
        'nor can it retroactively precede what the agent already emitted');
    });

    it('step 4 still shuts the gate on the work it proposes', () => {
      const { task } = render();
      assert.match(task, /MUST NOT start the work it proposes until the operator confirms/);
      assert.match(task, /Wait for the operator/);
    });

    it('the banner stays required and stays separate from the confirmation gate', () => {
      const { identity } = render();
      assert.match(identity, /begin your FIRST visible reply/i, 'the banner is still unconditional');
      assert.match(identity, /Reading your launch context is not acting/,
        'and it no longer reads as gating initialization');
    });
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

  it('a plans directory that cannot be read is never rendered as "no plans"', () => {
    const realList = require('../lib/plan-docs').listPlans;
    require('../lib/plan-docs').listPlans = () => { throw new Error('permission denied'); };
    try {
      const { task } = render();
      assert.match(task, /could not be read \(permission denied\)/);
      assert.ok(!task.includes('No plan files are present'), 'a failed read is not an absence');
    } finally {
      require('../lib/plan-docs').listPlans = realList;
    }
  });

  // #1738 — the return path: a launch that can run the methodology, after a
  // session that could not, is told to revalidate with Doctor, never onboard.
  describe('dormant methodology reattach (#1738)', () => {
    const dormant = { disposition: 'capability-unavailable', engineId: 'gemini' };
    const withOnboarded = (fn) => {
      const marker = path.join(project.path, '.prawduct');
      fs.mkdirSync(marker, { recursive: true });
      try { fn(); } finally { fs.rmSync(marker, { recursive: true, force: true }); }
    };

    it('tells a Claude launch after a dormant session to run Doctor, never onboard', () => {
      withOnboarded(() => {
        const { state } = render({ mode: 'pull', handoffMethodology: dormant });
        assert.match(state, /## Prawduct state was dormant/);
        assert.match(state, /the gemini engine/);
        assert.match(state, /run `\/prawduct:doctor`/);
        assert.match(state, /Never run `\/prawduct:onboard`/);
        assert.match(state, /withheld until Doctor passes/);
        // Architect E6: advisory, never a claim of restored authority.
        assert.match(state, /nothing here means Doctor has passed or authority is restored/);
        assert.match(state, /previous handoff keeps its record as written/);
      });
    });

    it('says nothing after a session that measured', () => {
      withOnboarded(() => {
        const { state } = render({ mode: 'pull', handoffMethodology: { disposition: 'measured', engineId: 'claude' } });
        assert.doesNotMatch(state, /Prawduct state was dormant/);
      });
    });

    it('says nothing when this launch cannot run the methodology either', () => {
      withOnboarded(() => {
        const codex = store.engines.get('codex');
        assert.ok(codex, 'the codex engine profile ships with TangleClaw');
        const { state } = sessions.renderLaunchSteps(project, codex, { operatorHost: 'operator.example.test', mode: 'pull', handoffMethodology: dormant });
        assert.doesNotMatch(state, /Prawduct state was dormant/);
      });
    });

    it('says nothing for a project that is not onboarded', () => {
      const { state } = render({ mode: 'pull', handoffMethodology: dormant });
      assert.doesNotMatch(state, /Prawduct state was dormant/);
    });
  });
});
