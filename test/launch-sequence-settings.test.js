'use strict';

/**
 * The launch sequence's project settings (Train 21, Chunk 02): where a
 * paste-only engine's rules come from, and how long a session has to attest.
 *
 * The case that matters is the one where the setting cannot be honoured: a
 * project asking for `pull` on a launch with no sequence must still get its
 * rules, because a pointer to a channel the session does not have delivers
 * nothing at all (#749, one engine over).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const projectConfig = require('../lib/project-config');
const projects = require('../lib/projects');

describe('launch-sequence settings (Train 21, Chunk 02)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-settings-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a project with one startup rule.
   * @param {string} name - Project and directory name
   * @param {string} engine - Engine id
   * @returns {object} The project record
   */
  function makeProject(name, engine) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine });
    store.sessionRules.create({ projectId: project.id, content: 'Keep the diff small.' });
    return project;
  }

  describe('resolvePasteRules', () => {
    it('ships pull, per the ratified prime-delivery §3 amendment', () => {
      assert.equal(projectConfig.DEFAULT_PROJECT_CONFIG.launchSequence.pasteRules, 'pull');
      assert.deepEqual(projectConfig.resolvePasteRules({}), { mode: 'pull', source: 'default' });
      assert.deepEqual(projectConfig.resolvePasteRules(null), { mode: 'pull', source: 'default' });
    });

    it('takes an explicit value and falls back to the DELIVERING side on a bad one', () => {
      assert.equal(projectConfig.resolvePasteRules({ launchSequence: { pasteRules: 'paste' } }).mode, 'paste');
      const bad = projectConfig.resolvePasteRules({ launchSequence: { pasteRules: 'Pull' } });
      assert.equal(bad.mode, 'paste', 'a value nobody recognises must not drop the rule text');
      assert.equal(bad.source, 'invalid');
      assert.match(bad.warning, /is not one of paste, pull/);
    });
  });

  describe('resolveUnreadyWindow', () => {
    it('defaults to the shipped window and reports where the answer came from', () => {
      const shipped = projectConfig.DEFAULT_PROJECT_CONFIG.launchSequence.unreadyWindowMinutes;
      assert.deepEqual(projectConfig.resolveUnreadyWindow({}),
        { ms: shipped * 60_000, minutes: shipped, source: 'default' });
      assert.equal(projectConfig.resolveUnreadyWindow({ launchSequence: { unreadyWindowMinutes: 3 } }).ms, 180_000);
    });

    it('refuses a window outside the range rather than nudging every session at once', () => {
      for (const minutes of [0, -5, 10_000, 'ten', null]) {
        const answer = projectConfig.resolveUnreadyWindow({ launchSequence: { unreadyWindowMinutes: minutes } });
        assert.equal(answer.minutes, projectConfig.DEFAULT_PROJECT_CONFIG.launchSequence.unreadyWindowMinutes,
          `${JSON.stringify(minutes)} falls back to the shipped window`);
        if (minutes !== null) assert.equal(answer.source, 'invalid');
      }
    });
  });

  describe('PATCH validation', () => {
    it('accepts a known setting and merges rather than replacing the object', async () => {
      const project = makeProject('settings-patch', 'codex');
      const first = await projects.updateProject(project.name, { launchSequence: { pasteRules: 'paste' } });
      assert.deepEqual(first.errors, []);
      const second = await projects.updateProject(project.name, { launchSequence: { unreadyWindowMinutes: 2 } });
      assert.deepEqual(second.errors, []);
      const saved = store.projectConfig.load(project.path).launchSequence;
      assert.deepEqual(saved, { pasteRules: 'paste', unreadyWindowMinutes: 2 },
        'a save that sends one key does not reset the other');
    });

    it('refuses a bad mode, a bad window and an unknown key', async () => {
      const project = makeProject('settings-refuse', 'codex');
      const cases = [
        [{ pasteRules: 'both' }, /pasteRules must be one of paste, pull/],
        [{ unreadyWindowMinutes: 0 }, /unreadyWindowMinutes must be a number of minutes between/],
        [{ pastRules: 'pull' }, /has no setting pastRules/],
        ['pull', /launchSequence must be an object/]
      ];
      for (const [value, expected] of cases) {
        const result = await projects.updateProject(project.name, { launchSequence: value });
        assert.equal(result.project, null, `refused: ${JSON.stringify(value)}`);
        assert.match(result.errors[0], expected);
      }
      assert.deepEqual(store.projectConfig.load(project.path).launchSequence,
        projectConfig.DEFAULT_PROJECT_CONFIG.launchSequence, 'a refusal stores nothing');
    });
  });

  describe('what the delivery ledger records', () => {
    /**
     * Launch with tmux and engine detection stubbed, so no pane is started.
     * @param {string} name - Project name
     * @param {object} [launchOptions] - Passed to `launchSession`
     * @returns {object} The launch result
     */
    function launch(name, launchOptions = {}) {
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      const real = {
        create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
      };
      tmux.createSession = () => true;
      tmux.hasSession = () => false;
      tmux.killSession = () => true;
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
      try {
        return sessions.launchSession(name, launchOptions);
      } finally {
        tmux.createSession = real.create;
        tmux.hasSession = real.has;
        tmux.killSession = real.kill;
        enginesModule.detectEngine = real.detect;
      }
    }

    it('records a pointer paste as a skip, never as a rule delivery', () => {
      // The row must not put the rule digest on a `delivered` outcome for a
      // prime that carried a pointer: that is the claim prime-delivery §4
      // forbids, and it is what this ledger exists to catch (#759, #1063).
      const project = makeProject('ledger-pull', 'codex');
      const session = launch('ledger-pull').session;
      const rows = store.sessionRuleDeliveries.listForSession(session.id);
      assert.equal(rows.length, 1, 'one row per launch, from the launch path');
      assert.equal(rows[0].outcome, 'skipped');
      assert.equal(rows[0].channel, 'none');
      assert.equal(rows[0].skipReason, store.RULES_SERVED_BY_LAUNCH_SEQUENCE);
      assert.ok(store.launchSequences.getBySession(session.id), 'the pull channel has its own record');
    });

    it('does not report a pulled project as one whose rules never arrived', () => {
      // The fleet-health list asks "this project has rules and nothing
      // delivered them". For a pulled project the prime deliberately carried
      // none, and the answer lives in that launch's own record — so the list
      // must not raise it, while the skip stays a skip.
      const project = makeProject('ledger-pull-health', 'codex');
      launch('ledger-pull-health');
      const flagged = store.sessionRuleDeliveries.projectsWithUndeliveredRules()
        .map((p) => p.projectName);
      assert.ok(!flagged.includes(project.name));
    });

    it('still records a real paste as a delivery when the rules were pasted', () => {
      const project = makeProject('ledger-paste', 'codex');
      store.projectConfig.save(project.path, { launchSequence: { pasteRules: 'paste' } });
      const session = launch('ledger-paste').session;
      const rows = store.sessionRuleDeliveries.listForSession(session.id);
      // The paste itself is recorded later, by the deferred init; what matters
      // here is that the launch path did NOT pre-empt it with a skip.
      assert.ok(!rows.some((r) => r.skipReason === store.RULES_SERVED_BY_LAUNCH_SEQUENCE),
        'a pasted launch records no pull skip');
    });

    it('pastes the rules when the sequence could not be built after all', () => {
      // The prime is rendered before the snapshot exists, so it commits to the
      // pull carrier on an assumption. If the snapshot then degrades, a prime
      // still pointing at the sequence would leave the rules on no channel.
      const project = makeProject('ledger-degraded', 'codex');
      const realLoad = store.globalRules.load;
      let launched;
      try {
        // The pull path renders the global rules; a failing read is how a
        // snapshot degrades without stubbing the renderer.
        let calls = 0;
        store.globalRules.load = () => {
          calls += 1;
          if (calls > 1) throw new Error('global rules unreadable');
          return '';
        };
        launched = launch('ledger-degraded');
      } finally {
        store.globalRules.load = realLoad;
      }
      const sequence = store.launchSequences.getBySession(launched.session.id);
      assert.equal(sequence.applicability, 'not-applicable', 'the snapshot degraded');
      assert.ok(launched.primePrompt.includes('## Project Rules'),
        'so the prime carries the rule text after all');
      assert.ok(launched.primePrompt.includes('Keep the diff small.'));
      const rows = store.sessionRuleDeliveries.listForSession(launched.session.id);
      assert.ok(!rows.some((r) => r.skipReason === store.RULES_SERVED_BY_LAUNCH_SEQUENCE),
        'and the ledger does not claim the rules went to a sequence that does not exist');
    });
  });

  describe('what the prime carries', () => {
    /**
     * Render a push prime for a project.
     * @param {object} project - Project record
     * @param {string} engineId - Engine id
     * @param {object} [options] - Prime options
     * @returns {string}
     */
    function prime(project, engineId, options = {}) {
      return sessions.generatePrimePrompt(store.projects.get(project.id), store.engines.get(engineId), options);
    }

    it('drops the pasted rule text for a paste engine that will pull it', () => {
      const project = makeProject('prime-pull', 'codex');
      const pulled = prime(project, 'codex', { launchSequence: true });
      assert.ok(!pulled.includes('## Project Rules'), 'the rule text is not pasted');
      assert.ok(pulled.includes('they are NOT in this prime'));
      assert.ok(pulled.includes('Keep the diff small.') === false, 'nor is any rule body');
      assert.ok(pulled.includes("in the governance step of this session's launch sequence"),
        'and the rule-sources line names the carrier that actually carries them');
    });

    it('keeps the paste when the launch has no sequence to pull from', () => {
      const project = makeProject('prime-no-sequence', 'codex');
      const pasted = prime(project, 'codex', {});
      assert.ok(pasted.includes('## Project Rules'), 'the rules are still delivered');
      assert.ok(pasted.includes('Keep the diff small.'));
      assert.ok(pasted.includes('delivered in this prime.'), 'and the prime says where they came from');
    });

    it('keeps the paste when the project opted out, sequence or not', () => {
      const project = makeProject('prime-opt-out', 'codex');
      store.projectConfig.save(project.path, { launchSequence: { pasteRules: 'paste' } });
      const pasted = prime(project, 'codex', { launchSequence: true });
      assert.ok(pasted.includes('## Project Rules'));
      assert.ok(pasted.includes('Keep the diff small.'));
    });

    it('changes nothing on an engine whose rules ride the startup hook', () => {
      const project = makeProject('prime-hook', 'claude');
      store.projectConfig.save(project.path, { silentPrime: true, launchSequence: { pasteRules: 'pull' } });
      const hooked = prime(project, 'claude', { launchSequence: true });
      assert.ok(hooked.includes('## Rules delivery'), 'the manifest still ships');
      assert.ok(hooked.includes('they arrive on a separate channel'), 'and still names the hook channel');
      assert.ok(!hooked.includes('they are NOT in this prime'), 'the pull pointer is not used here');
      assert.ok(hooked.includes('delivered through the rules hook.'));
    });

    it('serves the full rule text on the pull side regardless of the setting', () => {
      const project = makeProject('prime-pull-step', 'codex');
      const steps = sessions.renderLaunchSteps(store.projects.get(project.id), store.engines.get('codex'), {});
      assert.ok(steps.governance.includes('## Project Rules'), 'the governance step carries the rules in full');
      assert.ok(steps.governance.includes('Keep the diff small.'));
      assert.ok(steps.governance.includes('delivered in this launch step.'));
    });
  });
});
