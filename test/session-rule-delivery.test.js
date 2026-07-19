'use strict';

/**
 * Startup session-rule delivery (#595).
 *
 * Before this, `kind='startup'` rules were assembled only inside engine
 * config-file generation, which `writeEngineConfig` skips wholesale for
 * plugin-governed projects. Every governed project therefore had a rules tier
 * that accepted writes, showed rows in the UI, and delivered nothing — and
 * nothing recorded the miss, so a severed channel was indistinguishable from
 * "no rules configured".
 *
 * These tests pin both halves of the fix: the rules reach the prime regardless
 * of governance or engine, and every delivery attempt lands in the ledger.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('startup session-rule delivery (#595)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rule-delivery-'));
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
   * Create a throwaway project with its own directory.
   * @param {string} name - Project name (also the directory name)
   * @param {object} [opts]
   * @param {boolean} [opts.pluginGoverned] - Seed the committed plugin install
   *   reference that makes `engines.isPluginGoverned` true for this path
   * @returns {object} The created project record
   */
  function makeProject(name, opts = {}) {
    const projDir = path.join(projectsDir, name);
    fs.mkdirSync(projDir, { recursive: true });
    if (opts.pluginGoverned) {
      const claudeDir = path.join(projDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({ enabledPlugins: { 'prawduct@prawduct': true } }, null, 2)
      );
      fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '<!-- PRAWDUCT:ANCHOR -->\n');
    }
    return store.projects.create({ name, path: projDir, engine: 'claude', methodology: 'minimal' });
  }

  describe('buildStartupRulesSection', () => {
    let project;

    beforeEach(() => {
      project = makeProject(`rules-${Math.floor(Math.random() * 1e9)}`);
    });

    afterEach(() => {
      for (const rule of store.sessionRules.list({ projectId: project.id })) {
        store.sessionRules.delete(rule.id);
      }
      store.projects.delete(project.id);
    });

    it('renders the project\'s active startup rules with their ids and a digest', () => {
      const a = store.sessionRules.create({ content: 'Always run lint', projectId: project.id });
      const b = store.sessionRules.create({ content: 'Never touch main', projectId: project.id });

      const section = sessions.buildStartupRulesSection(project.id);
      const text = section.lines.join('\n');

      assert.match(text, /## Project Rules/);
      assert.match(text, /- Always run lint/);
      assert.match(text, /- Never touch main/);
      assert.deepEqual(section.ruleIds, [a.id, b.id]);
      assert.match(section.digest, /^[0-9a-f]{64}$/);
    });

    it('returns an empty section (and empty digest) when the project has no rules', () => {
      const section = sessions.buildStartupRulesSection(project.id);
      assert.deepEqual(section.lines, []);
      assert.deepEqual(section.ruleIds, []);
      assert.equal(section.digest, '');
    });

    it('excludes disabled rules and rules belonging to other projects', () => {
      const other = makeProject(`other-${Math.floor(Math.random() * 1e9)}`);
      store.sessionRules.create({ content: 'other project directive', projectId: other.id });
      const off = store.sessionRules.create({ content: 'disabled directive', projectId: project.id });
      store.sessionRules.update(off.id, { enabled: false });
      store.sessionRules.create({ content: 'live directive', projectId: project.id });

      const text = sessions.buildStartupRulesSection(project.id).lines.join('\n');

      assert.match(text, /live directive/);
      assert.doesNotMatch(text, /disabled directive/);
      assert.doesNotMatch(text, /other project directive/);

      for (const rule of store.sessionRules.list({ projectId: other.id })) store.sessionRules.delete(rule.id);
      store.projects.delete(other.id);
    });

    it('excludes wrap-kind rules — that tier injects at wrap time, not launch', () => {
      store.sessionRules.create({ content: 'wrap-only directive', projectId: project.id, kind: 'wrap' });
      const text = sessions.buildStartupRulesSection(project.id).lines.join('\n');
      assert.doesNotMatch(text, /wrap-only directive/);
    });

    it('gives the same rule set the same digest, and a changed set a different one', () => {
      const rule = store.sessionRules.create({ content: 'stable directive', projectId: project.id });
      const first = sessions.buildStartupRulesSection(project.id).digest;
      const second = sessions.buildStartupRulesSection(project.id).digest;
      assert.equal(first, second, 'an unchanged rule set must hash identically');

      store.sessionRules.update(rule.id, { content: 'edited directive' });
      assert.notEqual(sessions.buildStartupRulesSection(project.id).digest, first);
    });

    it('returns an empty section rather than throwing when the rules query fails', () => {
      const original = store.sessionRules.listActiveForProject;
      store.sessionRules.listActiveForProject = () => { throw new Error('db exploded'); };
      try {
        const section = sessions.buildStartupRulesSection(project.id);
        assert.deepEqual(section.lines, []);
        assert.equal(section.digest, '');
      } finally {
        store.sessionRules.listActiveForProject = original;
      }
    });
  });

  describe('the prime carries the rules (the severed path, restored)', () => {
    it('delivers rules on a PLUGIN-GOVERNED project, where config generation delivers nothing', () => {
      const project = makeProject('governed-proj', { pluginGoverned: true });
      store.sessionRules.create({ content: 'governed projects must receive this', projectId: project.id });
      const engines = require('../lib/engines');
      const engine = store.engines.get('claude');

      // The precondition that made #595 possible: this project's config file is
      // never regenerated by TC, so anything routed through it is undeliverable.
      const writeResult = engines.writeEngineConfig('claude', project.path, { id: project.id }, engine, null);
      assert.equal(writeResult.written, false);
      assert.equal(writeResult.skipped, true);
      // Assert WHY it skipped. `skipped: true` has three causes, and only this
      // one is the #595 precondition — without pinning the reason the test would
      // still pass if config generation merely returned empty.
      assert.match(writeResult.skipReason, /governed by the Prawduct V2 plugin/);

      const prompt = sessions.generatePrimePrompt(store.projects.get(project.id), engine);
      assert.match(prompt, /governed projects must receive this/);

      for (const rule of store.sessionRules.list({ projectId: project.id })) store.sessionRules.delete(rule.id);
      store.projects.delete(project.id);
    });

    it('delivers rules for every engine, not only Claude', () => {
      const project = makeProject('multi-engine-proj');
      store.sessionRules.create({ content: 'engine-agnostic directive', projectId: project.id });
      const record = store.projects.get(project.id);

      for (const engineId of ['claude', 'codex', 'aider', 'antigravity']) {
        const prompt = sessions.generatePrimePrompt(record, store.engines.get(engineId));
        assert.match(prompt, /engine-agnostic directive/, `${engineId} prime must carry the rule`);
      }

      for (const rule of store.sessionRules.list({ projectId: project.id })) store.sessionRules.delete(rule.id);
      store.projects.delete(project.id);
    });

    it('uses a caller-supplied section verbatim, so the shipped block matches the ledgered one', () => {
      const project = makeProject('prebuilt-section-proj');
      store.sessionRules.create({ content: 'db content that must not appear', projectId: project.id });
      const prompt = sessions.generatePrimePrompt(store.projects.get(project.id), store.engines.get('claude'), {
        startupRules: { lines: ['## Project Rules', '', '- pre-built directive', ''], ruleIds: [1], digest: 'deadbeef' }
      });

      assert.match(prompt, /pre-built directive/);
      assert.doesNotMatch(prompt, /db content that must not appear/);

      for (const rule of store.sessionRules.list({ projectId: project.id })) store.sessionRules.delete(rule.id);
      store.projects.delete(project.id);
    });

    it('adds no Project Rules heading when the project has no rules', () => {
      const project = makeProject('no-rules-proj');
      const prompt = sessions.generatePrimePrompt(store.projects.get(project.id), store.engines.get('claude'));
      assert.doesNotMatch(prompt, /## Project Rules/);
      store.projects.delete(project.id);
    });
  });

  describe('delivery ledger', () => {
    let project;

    beforeEach(() => {
      project = makeProject(`ledger-${Math.floor(Math.random() * 1e9)}`);
    });

    afterEach(() => {
      store.projects.delete(project.id);
    });

    it('records a successful delivery with its rule ids, digest and channel', () => {
      const rec = store.sessionRuleDeliveries.record({
        sessionId: 101, projectId: project.id, engineId: 'claude',
        channel: 'prime-file', delivered: true, ruleIds: [7, 9], digest: 'abc123'
      });

      assert.equal(rec.delivered, true);
      assert.equal(rec.channel, 'prime-file');
      assert.equal(rec.kind, 'startup');
      assert.deepEqual(rec.ruleIds, [7, 9]);
      assert.equal(rec.ruleCount, 2);
      assert.equal(rec.digest, 'abc123');
      assert.equal(rec.skipReason, null);
    });

    it('records a FAILED delivery with its reason — the row that exposes a severed channel', () => {
      const rec = store.sessionRuleDeliveries.record({
        sessionId: 102, projectId: project.id, engineId: 'openclaw',
        channel: 'none', delivered: false, skipReason: 'engine openclaw declares no prime channel',
        ruleIds: [7], digest: 'abc123'
      });

      assert.equal(rec.delivered, false);
      assert.match(rec.skipReason, /no prime channel/);
      // The distinction that matters: rules existed, and did not arrive.
      assert.equal(rec.ruleCount, 1);
    });

    it('refuses an undelivered row with no reason — it would record a failure while discarding why', () => {
      assert.throws(
        () => store.sessionRuleDeliveries.record({ projectId: project.id, engineId: 'claude', channel: 'none', delivered: false }),
        /skipReason is required/
      );
    });

    it('refuses an unknown channel and a missing engine id', () => {
      assert.throws(
        () => store.sessionRuleDeliveries.record({ projectId: project.id, engineId: 'claude', channel: 'carrier-pigeon', delivered: true }),
        /channel must be one of/
      );
      assert.throws(
        () => store.sessionRuleDeliveries.record({ projectId: project.id, channel: 'prime-file', delivered: true }),
        /engineId is required/
      );
    });

    it('answers "did session X receive rule set Y" by session id, oldest first', () => {
      store.sessionRuleDeliveries.record({ sessionId: 555, projectId: project.id, engineId: 'claude', channel: 'none', delivered: false, skipReason: 'first attempt failed', digest: 'v1' });
      store.sessionRuleDeliveries.record({ sessionId: 555, projectId: project.id, engineId: 'claude', channel: 'prime-paste', delivered: true, digest: 'v1' });

      const rows = store.sessionRuleDeliveries.listForSession(555);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].delivered, false);
      assert.equal(rows[1].delivered, true);
      assert.ok(rows.some((r) => r.digest === 'v1' && r.delivered), 'digest identifies the rule set that arrived');
    });

    it('answers "is this project receiving its rules" newest-first, and honours limit', () => {
      for (let i = 0; i < 5; i++) {
        store.sessionRuleDeliveries.record({ sessionId: 600 + i, projectId: project.id, engineId: 'claude', channel: 'prime-file', delivered: true, digest: `d${i}` });
      }

      const rows = store.sessionRuleDeliveries.listForProject(project.id, { limit: 2 });
      assert.equal(rows.length, 2);
      assert.equal(rows[0].digest, 'd4', 'newest first');
      assert.equal(store.sessionRuleDeliveries.latestForProject(project.id).digest, 'd4');
    });

    it('reports null for a project that has never had a delivery attempt', () => {
      assert.equal(store.sessionRuleDeliveries.latestForProject(project.id), null);
    });

    it('is written by a real launch, not only by direct calls', () => {
      // The recording lives on the launch path; a ledger only ever exercised
      // through store.record() would pass while the launch path never called it
      // — the same "assumed, never verified" shape as the bug itself.
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      const orig = { hasSession: tmux.hasSession, createSession: tmux.createSession, detectEngine: enginesModule.detectEngine };
      tmux.hasSession = () => false;
      tmux.createSession = () => true;
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const launched = makeProject(`launch-${Math.floor(Math.random() * 1e9)}`);
      store.sessionRules.create({ content: 'must be delivered at launch', projectId: launched.id });
      try {
        const result = sessions.launchSession(launched.name);
        assert.equal(result.error, null);
        assert.match(result.primePrompt, /must be delivered at launch/);

        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1, 'the launch must leave exactly one ledger row');
        assert.equal(rows[0].projectId, launched.id);
        assert.equal(rows[0].ruleCount, 1);
        assert.match(rows[0].digest, /^[0-9a-f]{64}$/);
        // silentPrime defaults on, so this is the prime-file channel, recorded
        // synchronously once the file is written. Named explicitly so the test
        // says which of the three branches it actually covers.
        assert.equal(rows[0].channel, 'prime-file');
        assert.equal(rows[0].delivered, true);

        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        tmux.hasSession = orig.hasSession;
        tmux.createSession = orig.createSession;
        enginesModule.detectEngine = orig.detectEngine;
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('records the deferred tmux-paste delivery only once the paste actually fires', (t) => {
      // The paste channel runs on a background timer, long after launchSession
      // returns. Recording it at launch would assert delivery that has not
      // happened yet — so the ledger must stay empty until the timer runs.
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      const orig = { hasSession: tmux.hasSession, createSession: tmux.createSession, sendKeys: tmux.sendKeys, detectEngine: enginesModule.detectEngine };
      let created = false;
      tmux.hasSession = () => created;
      tmux.createSession = () => { created = true; return true; };
      tmux.sendKeys = () => true;
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
      t.mock.timers.enable({ apis: ['setTimeout'] });

      const launched = makeProject(`paste-${Math.floor(Math.random() * 1e9)}`);
      store.sessionRules.create({ content: 'pasted directive', projectId: launched.id });
      // Force the visible-paste channel instead of the silent prime file.
      const projConfig = store.projectConfig.load(launched.path);
      projConfig.silentPrime = false;
      store.projectConfig.save(launched.path, projConfig);

      try {
        const result = sessions.launchSession(launched.name);
        assert.equal(result.error, null);
        assert.deepEqual(
          store.sessionRuleDeliveries.listForSession(result.session.id), [],
          'nothing may be recorded before the paste actually happens'
        );

        t.mock.timers.tick(60_000);

        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].channel, 'prime-paste');
        assert.equal(rows[0].delivered, true);
        assert.equal(rows[0].ruleCount, 1);

        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        t.mock.timers.reset();
        Object.assign(tmux, { hasSession: orig.hasSession, createSession: orig.createSession, sendKeys: orig.sendKeys });
        enginesModule.detectEngine = orig.detectEngine;
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('records a failed paste with the reason instead of silently losing it', (t) => {
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      const orig = { hasSession: tmux.hasSession, createSession: tmux.createSession, sendKeys: tmux.sendKeys, detectEngine: enginesModule.detectEngine };
      let created = false;
      tmux.hasSession = () => created;
      tmux.createSession = () => { created = true; return true; };
      tmux.sendKeys = () => { throw new Error('pane is gone'); };
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
      t.mock.timers.enable({ apis: ['setTimeout'] });

      const launched = makeProject(`pastefail-${Math.floor(Math.random() * 1e9)}`);
      store.sessionRules.create({ content: 'never arrives', projectId: launched.id });
      const projConfig = store.projectConfig.load(launched.path);
      projConfig.silentPrime = false;
      store.projectConfig.save(launched.path, projConfig);

      try {
        const result = sessions.launchSession(launched.name);
        t.mock.timers.tick(60_000);

        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].delivered, false);
        assert.match(rows[0].skipReason, /pane is gone/);

        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        t.mock.timers.reset();
        Object.assign(tmux, { hasSession: orig.hasSession, createSession: orig.createSession, sendKeys: orig.sendKeys });
        enginesModule.detectEngine = orig.detectEngine;
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('keeps the audit row after the project it describes is deleted', () => {
      const doomed = makeProject(`doomed-${Math.floor(Math.random() * 1e9)}`);
      store.sessionRuleDeliveries.record({ sessionId: 777, projectId: doomed.id, engineId: 'claude', channel: 'prime-file', delivered: true, digest: 'survives' });
      store.projects.delete(doomed.id);

      const rows = store.sessionRuleDeliveries.listForSession(777);
      assert.equal(rows.length, 1, 'delivery history must outlive the project — it is an audit trail');
      assert.equal(rows[0].digest, 'survives');
    });
  });
});
