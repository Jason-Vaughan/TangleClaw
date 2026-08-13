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
    return store.projects.create({ name, path: projDir, engine: 'claude' });
  }

  // Deterministic, collision-free fixture ids. Math.random() names (the prior
  // approach) could collide under a full-suite run and made a failure message
  // non-reproducible — both flake vectors called out in #634.
  let _uidCounter = 0;
  const uid = () => (++_uidCounter);

  // Leak-proof global stubbing. The launch tests monkeypatch module globals
  // (`tmux.*`, `engines.detectEngine`, `store.engines.get`, `fs.writeFileSync`)
  // around a real `launchSession()`. The prior pattern applied those patches
  // BEFORE a `try`/`finally`, so a throw during fixture setup (e.g. a name
  // collision) left them applied — leaking a mocked global into every later
  // test in the file, the #634 flake shape. `stub()` registers each patch and
  // the top-level `afterEach` restores it unconditionally, so no code path can
  // bypass cleanup. (`t.mock.timers` is auto-restored by node at test end, so
  // it never leaks; the manual globals were the real vector.)
  const _restores = [];
  function stub(obj, key, value) {
    _restores.push([obj, key, Object.getOwnPropertyDescriptor(obj, key)]);
    obj[key] = value;
    return value;
  }
  afterEach(() => {
    while (_restores.length) {
      const [obj, key, descriptor] = _restores.pop();
      if (descriptor) Object.defineProperty(obj, key, descriptor);
      else delete obj[key];
    }
  });

  describe('buildStartupRulesSection', () => {
    let project;

    beforeEach(() => {
      project = makeProject(`rules-${uid()}`);
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

      // Bodies live on `rules` (they ship on the rules channel); `lines` is the
      // prime's fixed-size manifest, which must NOT grow with the corpus.
      const bodies = section.rules.map((r) => r.content);
      assert.deepEqual(bodies, ['Always run lint', 'Never touch main']);
      assert.deepEqual(section.ruleIds, [a.id, b.id]);
      assert.match(section.digest, /^[0-9a-f]{64}$/);

      const manifest = section.lines.join('\n');
      assert.match(manifest, /## Rules delivery/,
        'the manifest is headed differently from the block it describes, so it cannot\n         satisfy its own absence check');
      assert.match(manifest, /2 operator-authored rules/);
      assert.doesNotMatch(manifest, /Always run lint/,
        'rule bodies must not ride the prime — that is what put them in competition with it');
    });

    it('returns an empty section (and empty digest) when the project has no rules', () => {
      const section = sessions.buildStartupRulesSection(project.id);
      assert.deepEqual(section.lines, []);
      assert.deepEqual(section.ruleIds, []);
      assert.equal(section.digest, '');
    });

    it('excludes disabled rules and rules belonging to other projects', () => {
      const other = makeProject(`other-${uid()}`);
      store.sessionRules.create({ content: 'other project directive', projectId: other.id });
      const off = store.sessionRules.create({ content: 'disabled directive', projectId: project.id });
      store.sessionRules.update(off.id, { enabled: false });
      store.sessionRules.create({ content: 'live directive', projectId: project.id });

      const bodies = sessions.buildStartupRulesSection(project.id).rules.map((r) => r.content).join('\n');

      assert.match(bodies, /live directive/);
      assert.doesNotMatch(bodies, /disabled directive/);
      assert.doesNotMatch(bodies, /other project directive/);

      for (const rule of store.sessionRules.list({ projectId: other.id })) store.sessionRules.delete(rule.id);
      store.projects.delete(other.id);
    });

    it('excludes wrap-kind rules — that tier injects at wrap time, not launch', () => {
      store.sessionRules.create({ content: 'wrap-only directive', projectId: project.id, kind: 'wrap' });
      // Against the SELECTED set: the manifest never contains any body, so
      // asserting on it would pass even if wrap rules were being delivered.
      const selected = sessions.buildStartupRulesSection(project.id).rules.map((r) => r.content);
      assert.equal(selected.some((c) => /wrap-only directive/.test(c)), false);
    });

    it('gives the same rule set the same digest, and a changed set a different one', () => {
      const rule = store.sessionRules.create({ content: 'stable directive', projectId: project.id });
      const first = sessions.buildStartupRulesSection(project.id).digest;
      const second = sessions.buildStartupRulesSection(project.id).digest;
      assert.equal(first, second, 'an unchanged rule set must hash identically');

      store.sessionRules.update(rule.id, { content: 'edited directive' });
      assert.notEqual(sessions.buildStartupRulesSection(project.id).digest, first);
    });

    it('orders rules deterministically when they share a created_at timestamp', () => {
      // SQLite's datetime('now') is second-resolution, so a burst of rules gets
      // identical timestamps. Without an id tiebreaker their order — and hence
      // the digest identifying the rule set — would rest on unspecified
      // behavior rather than on the query.
      const ids = [];
      for (let i = 0; i < 6; i++) {
        ids.push(store.sessionRules.create({ content: `burst rule ${i}`, projectId: project.id }).id);
      }
      // Force the tie rather than racing the clock for it. Relying on all six
      // inserts landing inside one tick of datetime('now') makes the test's own
      // precondition timing-dependent: on a loaded machine the burst straddles a
      // second boundary, the timestamps differ, and the run fails without the
      // ordering contract ever being exercised. Pinning created_at guarantees
      // the tie every run, so the assertion below always tests what it claims to.
      //
      // Scope of the guard, measured by reverting the query: flipping the sort to
      // `id DESC` fails this test, so it does read the order. Dropping the `, id`
      // tiebreaker entirely does NOT fail it — SQLite's unspecified scan order
      // happens to coincide with ascending id here. Absence of unspecified
      // behavior isn't testable; this pins the contract, not the SQL.
      store.getDb()
        .prepare(`UPDATE session_rules SET created_at = '2000-01-01 00:00:00' WHERE id IN (${ids.map(() => '?').join(',')})`)
        .run(...ids);
      const stamps = new Set(store.sessionRules.listActiveForProject(project.id).map((r) => r.createdAt));
      assert.equal(stamps.size, 1, 'precondition: the burst must share one timestamp for this test to mean anything');

      const section = sessions.buildStartupRulesSection(project.id);
      assert.deepEqual(section.ruleIds, ids, 'ties must break by id, in creation order');
      assert.equal(sessions.buildStartupRulesSection(project.id).digest, section.digest);
    });

    it('returns an empty section rather than throwing when the rules query fails', () => {
      stub(store.sessionRules, 'listActiveForProject', () => { throw new Error('db exploded'); });
      const section = sessions.buildStartupRulesSection(project.id);
      assert.deepEqual(section.lines, []);
      assert.equal(section.digest, '');
    });
  });


  /**
   * Everything this session would actually receive: the prime plus every rules
   * shard written for the project. Rules ride the prime on engines with no
   * second startup channel and a dedicated hook on engines that have one, so a
   * test that only reads the prime silently stops checking delivery on Claude —
   * which is the engine the bug was found on.
   */
  function deliveredText(projectRecord, engine, opts) {
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    const prompt = sessions.generatePrimePrompt(projectRecord, engine, opts || {});
    const rulesChannel = require('../lib/session-rules-channel');
    const budget = rulesChannel.resolveChannelBudget(engine);
    const shards = rulesChannel.buildShards(
      sessions.buildStartupRulesSection(projectRecord.id).rules, budget);
    const shardText = shards.map((sh) => rulesChannel.renderShardText(sh, shards.length)).join('\n');
    void fs2; void path2;
    return { prompt, all: prompt + '\n' + shardText };
  }

  describe('rules reach the session on whichever channel the engine has', () => {
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

      const { prompt, all } = deliveredText(store.projects.get(project.id), engine);
      assert.match(all, /governed projects must receive this/,
        'the rule reaches a plugin-governed project, which config generation cannot serve');
      assert.match(prompt, /## Rules delivery/,
        'and the prime still says rules exist, so their absence would be detectable');

      for (const rule of store.sessionRules.list({ projectId: project.id })) store.sessionRules.delete(rule.id);
      store.projects.delete(project.id);
    });

    it('delivers rules for every engine, not only Claude', () => {
      const project = makeProject('multi-engine-proj');
      store.sessionRules.create({ content: 'engine-agnostic directive', projectId: project.id });
      const record = store.projects.get(project.id);

      for (const engineId of ['claude', 'codex', 'aider', 'antigravity']) {
        const { all } = deliveredText(record, store.engines.get(engineId));
        assert.match(all, /engine-agnostic directive/,
          `${engineId} must receive the rule by some channel — a manifest pointing at a `
          + 'channel the engine lacks would deliver nothing at all');
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
      project = makeProject(`ledger-${uid()}`);
    });

    afterEach(() => {
      store.projects.delete(project.id);
    });

    it('records a successful delivery with its rule ids, digest and channel', () => {
      const rec = store.sessionRuleDeliveries.record({
        sessionId: 101, projectId: project.id, engineId: 'claude',
        channel: 'prime-file', outcome: 'delivered', ruleIds: [7, 9], digest: 'abc123'
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
        channel: 'none', outcome: 'skipped', skipReason: 'engine openclaw declares no prime channel',
        ruleIds: [7], digest: 'abc123'
      });

      assert.equal(rec.outcome, 'skipped');
      assert.equal(rec.delivered, false);
      assert.match(rec.skipReason, /no prime channel/);
      // The distinction that matters: rules existed, and did not arrive.
      assert.equal(rec.ruleCount, 1);
    });

    it('distinguishes "no rules to send" from "rules did not arrive"', () => {
      // Under a delivered boolean these two collapse into the same value, which
      // is the conflation the outcome enum exists to prevent.
      const empty = store.sessionRuleDeliveries.record({
        sessionId: 103, projectId: project.id, engineId: 'claude', channel: 'none', outcome: 'no-rules'
      });
      const severed = store.sessionRuleDeliveries.record({
        sessionId: 104, projectId: project.id, engineId: 'claude', channel: 'none',
        outcome: 'skipped', skipReason: 'no channel', ruleIds: [7]
      });

      assert.equal(empty.outcome, 'no-rules');
      assert.equal(severed.outcome, 'skipped');
      assert.equal(empty.delivered, false);
      assert.equal(severed.delivered, false);
      assert.notEqual(empty.outcome, severed.outcome, 'the two states must remain distinguishable');
    });

    it('refuses a skip with no reason — it would record a failure while discarding why', () => {
      assert.throws(
        () => store.sessionRuleDeliveries.record({ projectId: project.id, engineId: 'claude', channel: 'none', outcome: 'skipped' }),
        /skipReason is required/
      );
    });

    it('refuses an unknown outcome', () => {
      assert.throws(
        () => store.sessionRuleDeliveries.record({ projectId: project.id, engineId: 'claude', channel: 'none', outcome: 'probably-fine' }),
        /outcome must be one of/
      );
    });

    it('refuses to store "delivered through no channel" — a state that cannot be true', () => {
      assert.throws(
        () => store.sessionRuleDeliveries.record({ projectId: project.id, engineId: 'openclaw', channel: 'none', outcome: 'delivered', digest: 'x' }),
        /cannot be delivered/
      );
    });

    it('refuses an unknown channel and a missing engine id', () => {
      assert.throws(
        () => store.sessionRuleDeliveries.record({ projectId: project.id, engineId: 'claude', channel: 'carrier-pigeon', outcome: 'delivered' }),
        /channel must be one of/
      );
      assert.throws(
        () => store.sessionRuleDeliveries.record({ projectId: project.id, channel: 'prime-file', outcome: 'delivered' }),
        /engineId is required/
      );
    });

    it('answers "did session X receive rule set Y" by session id, oldest first', () => {
      store.sessionRuleDeliveries.record({ sessionId: 555, projectId: project.id, engineId: 'claude', channel: 'none', outcome: 'skipped', skipReason: 'first attempt failed', digest: 'v1' });
      store.sessionRuleDeliveries.record({ sessionId: 555, projectId: project.id, engineId: 'claude', channel: 'prime-paste', outcome: 'delivered', digest: 'v1' });

      const rows = store.sessionRuleDeliveries.listForSession(555);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].delivered, false);
      assert.equal(rows[1].delivered, true);
      assert.ok(rows.some((r) => r.digest === 'v1' && r.delivered), 'digest identifies the rule set that arrived');
    });

    it('answers "is this project receiving its rules" newest-first, and honours limit', () => {
      for (let i = 0; i < 5; i++) {
        store.sessionRuleDeliveries.record({ sessionId: 600 + i, projectId: project.id, engineId: 'claude', channel: 'prime-file', outcome: 'delivered', digest: `d${i}` });
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
      stub(tmux, 'hasSession', () => false);
      stub(tmux, 'createSession', () => true);
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));

      const launched = makeProject(`launch-${uid()}`);
      store.sessionRules.create({ content: 'must be delivered at launch', projectId: launched.id });
      try {
        const result = sessions.launchSession(launched.name);
        assert.equal(result.error, null);
        // The rule ships on its own channel now, so the proof it was delivered
        // is the shard payload the launch wrote — reading only the prime would
        // stop checking delivery on exactly the engine the bug was found on.
        const fs2 = require('node:fs');
        const shard = path.join(launched.path, '.tangleclaw', 'session-rules-1.json');
        assert.ok(fs2.existsSync(shard), 'the launch writes the rules shard the hook will read');
        const payload = JSON.parse(fs2.readFileSync(shard, 'utf8'));
        assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
        assert.match(payload.hookSpecificOutput.additionalContext, /must be delivered at launch/);
        assert.match(result.primePrompt, /## Rules delivery/,
          'and the prime still declares that rules exist');

        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1, 'the launch must leave exactly one ledger row');
        assert.equal(rows[0].projectId, launched.id);
        assert.equal(rows[0].ruleCount, 1);
        assert.match(rows[0].digest, /^[0-9a-f]{64}$/);
        // silentPrime defaults on, so this is the prime-file channel, recorded
        // synchronously once the file is written. Named explicitly so the test
        // says which of the three branches it actually covers.
        assert.equal(rows[0].channel, 'rules-hook',
          'the ledger names the channel the rules actually rode, not the prime file');
        assert.equal(rows[0].delivered, true);

        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
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
      let created = false;
      stub(tmux, 'hasSession', () => created);
      // The prime-paste guard asks `probeSession` now, so that it can tell a
      // pane that ENDED from a tmux that would not answer — the ledger row it
      // writes is durable, and recording "the session ended" for a read that
      // never happened is a fact nobody established (#908). Same meaning as the
      // `hasSession` stub above: an ANSWERED liveness that follows `created`.
      stub(tmux, 'probeSession', () => ({ live: created, answered: true, cause: null }));
      stub(tmux, 'createSession', () => { created = true; return true; });
      stub(tmux, 'sendKeys', () => true);
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));
      t.mock.timers.enable({ apis: ['setTimeout'] });

      const launched = makeProject(`paste-${uid()}`);
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
        // `t.mock.timers` is auto-restored by node at test end; globals via
        // afterEach. Only DB rows are cleaned here.
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('does not record "the session ended" when tmux never answered (#908)', (t) => {
      // The third site on #908's census, and the one whose write OUTLIVES the
      // condition. `!tmux.hasSession(...)` answered false both for a pane that
      // ended and for a server too wedged to reply, and this branch writes a
      // DURABLE ledger row saying the session ended — a fact nobody established,
      // read later by someone asking whether the rules arrived.
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      let created = false;
      stub(tmux, 'hasSession', () => created);
      // The wedge: the probe is killed by our own timeout and establishes nothing.
      stub(tmux, 'probeSession', () => ({ live: false, answered: false, cause: 'read-timed-out' }));
      stub(tmux, 'createSession', () => { created = true; return true; });
      stub(tmux, 'sendKeys', () => { throw new Error('must not paste into a pane we could not find'); });
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));
      t.mock.timers.enable({ apis: ['setTimeout'] });

      const launched = makeProject(`pasteunknown-${uid()}`);
      store.sessionRules.create({ content: 'never arrives', projectId: launched.id });
      const projConfig = store.projectConfig.load(launched.path);
      projConfig.silentPrime = false;
      store.projectConfig.save(launched.path, projConfig);

      try {
        const result = sessions.launchSession(launched.name);
        t.mock.timers.tick(60_000);

        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1, 'the skip is still recorded — silence would be worse');
        assert.equal(rows[0].delivered, false);
        // THE MUTATION THIS CATCHES: writing the answered-branch sentence
        // unconditionally, which is what `!hasSession(...)` did.
        assert.doesNotMatch(rows[0].skipReason, /session ended/,
          'a pane whose state was never established did not "end"');
        assert.match(rows[0].skipReason, /could not establish|did not answer/i,
          'and the ledger has to say what actually happened instead');

        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('still records "the session ended" when tmux ANSWERED that it had (#908)', (t) => {
      // The other half — without it the fix could blanket-rename every skip.
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      let created = false;
      stub(tmux, 'hasSession', () => created);
      stub(tmux, 'probeSession', () => ({ live: false, answered: true, cause: null }));
      stub(tmux, 'createSession', () => { created = true; return true; });
      stub(tmux, 'sendKeys', () => true);
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));
      t.mock.timers.enable({ apis: ['setTimeout'] });

      const launched = makeProject(`pasteended-${uid()}`);
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
        assert.match(rows[0].skipReason, /session ended/,
          'an observed ending is still reported as one');

        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('records a failed paste with the reason instead of silently losing it', (t) => {
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      let created = false;
      stub(tmux, 'hasSession', () => created);
      // The prime-paste guard asks `probeSession` now, so that it can tell a
      // pane that ENDED from a tmux that would not answer — the ledger row it
      // writes is durable, and recording "the session ended" for a read that
      // never happened is a fact nobody established (#908). Same meaning as the
      // `hasSession` stub above: an ANSWERED liveness that follows `created`.
      stub(tmux, 'probeSession', () => ({ live: created, answered: true, cause: null }));
      stub(tmux, 'createSession', () => { created = true; return true; });
      stub(tmux, 'sendKeys', () => { throw new Error('pane is gone'); });
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));
      t.mock.timers.enable({ apis: ['setTimeout'] });

      const launched = makeProject(`pastefail-${uid()}`);
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
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('records no-rules at launch for a project with no rules, rather than a bare success', () => {
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      stub(tmux, 'hasSession', () => false);
      stub(tmux, 'createSession', () => true);
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));

      const launched = makeProject(`norules-${uid()}`);
      try {
        const result = sessions.launchSession(launched.name);
        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, 'no-rules');
        assert.equal(rows[0].ruleCount, 0);
        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        store.projects.delete(launched.id);
      }
    });

    it('records a skip when the prime is disabled for the launch', () => {
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      stub(tmux, 'hasSession', () => false);
      stub(tmux, 'createSession', () => true);
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));

      const launched = makeProject(`noprime-${uid()}`);
      store.sessionRules.create({ content: 'will not be primed', projectId: launched.id });
      try {
        const result = sessions.launchSession(launched.name, { primePrompt: false });
        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, 'skipped');
        assert.match(rows[0].skipReason, /prime prompt disabled/);
        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('writes no rule shards when the launch asks for no prime, so the skip row is true', () => {
      // The ledger reports the launch. If shards were still written here, the
      // hooks would deliver rules while the row said "skipped" — the mirror
      // image of a row saying "delivered" when nothing shipped.
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      stub(tmux, 'hasSession', () => false);
      stub(tmux, 'createSession', () => true);
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));

      const launched = makeProject(`noprime-${uid()}`);
      store.sessionRules.create({ content: 'must not be delivered', projectId: launched.id });
      try {
        const result = sessions.launchSession(launched.name, { primePrompt: false });
        assert.equal(result.error, null);

        const fs2 = require('node:fs');
        assert.equal(
          fs2.existsSync(path.join(launched.path, '.tangleclaw', 'session-rules-1.json')), false,
          'no shard is written, so no hook can deliver rules this launch');

        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, 'skipped');
        assert.match(rows[0].skipReason, /prime prompt disabled/);
        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        for (const r of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(r.id);
        store.projects.delete(launched.id);
      }
    });

    it('records a skip when the rules cannot be written to their channel', () => {
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      const realWrite = fs.writeFileSync;
      stub(tmux, 'hasSession', () => false);
      stub(tmux, 'createSession', () => true);
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));

      const launched = makeProject(`writefail-${uid()}`);
      store.sessionRules.create({ content: 'undeliverable', projectId: launched.id });
      // Fail only the rules-shard write, leaving every other write intact.
      // This is the delivery the ledger answers for: the prime now carries a
      // manifest, so keying the row on the prime file would report success for
      // a session that received no rules at all.
      stub(fs, 'writeFileSync', (target, ...rest) => {
        if (/session-rules-\d+\.json$/.test(String(target))) throw new Error('EACCES');
        return realWrite(target, ...rest);
      });
      try {
        const result = sessions.launchSession(launched.name);
        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, 'skipped',
          'a failed rule write must never persist as delivered');
        assert.equal(rows[0].channel, 'rules-hook');
        assert.match(rows[0].skipReason, /failed to write rule shards/);
        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('records a skip naming the engine when it declares no prime channel', () => {
      // This is the branch D1's "openclaw's gap is reported rather than silent"
      // claim rests on, so it needs the launch path exercised, not just the store.
      const tmux = require('../lib/tmux');
      const enginesModule = require('../lib/engines');
      const claude = store.engines.get('claude');
      const realGet = store.engines.get;
      stub(tmux, 'hasSession', () => false);
      stub(tmux, 'createSession', () => true);
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));
      // A channel-less engine: config file present, no prime capability.
      stub(store.engines, 'get', (id) => (id === 'claude'
        ? { ...claude, capabilities: { ...claude.capabilities, supportsPrimePrompt: false, supportsSilentPrime: false } }
        : realGet(id)));

      const launched = makeProject(`nochannel-${uid()}`);
      store.sessionRules.create({ content: 'no channel to carry this', projectId: launched.id });
      try {
        const result = sessions.launchSession(launched.name);
        const rows = store.sessionRuleDeliveries.listForSession(result.session.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, 'skipped');
        assert.equal(rows[0].channel, 'none');
        assert.match(rows[0].skipReason, /declares no prime channel/);
        store.sessions.kill(result.session.id, 'test cleanup');
      } finally {
        for (const rule of store.sessionRules.list({ projectId: launched.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(launched.id);
      }
    });

    it('prunes to the retention cap so the ledger cannot grow without bound', () => {
      store._setSessionRuleDeliveryRetention(5);
      try {
        for (let i = 0; i < 12; i++) {
          store.sessionRuleDeliveries.record({ sessionId: 800 + i, projectId: project.id, engineId: 'claude', channel: 'prime-file', outcome: 'delivered', digest: `p${i}` });
        }
        const rows = store.sessionRuleDeliveries.listForProject(project.id, { limit: 100 });
        assert.equal(rows.length, 5, 'oldest rows beyond the cap are pruned');
        assert.equal(rows[0].digest, 'p11', 'the newest survives');
      } finally {
        store._setSessionRuleDeliveryRetention(100);
      }
    });

    it('answers the fleet question: projects with rules that never had one delivered', () => {
      const broken = makeProject(`broken-${uid()}`);
      const working = makeProject(`working-${uid()}`);
      const ruleless = makeProject(`ruleless-${uid()}`);
      store.sessionRules.create({ content: 'never arrives', projectId: broken.id });
      store.sessionRules.create({ content: 'arrives fine', projectId: working.id });
      store.sessionRuleDeliveries.record({ projectId: broken.id, engineId: 'openclaw', channel: 'none', outcome: 'skipped', skipReason: 'no channel', ruleIds: [1] });
      store.sessionRuleDeliveries.record({ projectId: working.id, engineId: 'claude', channel: 'prime-file', outcome: 'delivered', ruleIds: [2] });

      try {
        const flagged = store.sessionRuleDeliveries.projectsWithUndeliveredRules();
        const names = flagged.map((r) => r.projectName);
        assert.ok(names.includes(broken.name), 'a project whose rules never landed must be flagged');
        assert.ok(!names.includes(working.name), 'a project receiving its rules must not be flagged');
        assert.ok(!names.includes(ruleless.name), 'a project with no rules has nothing to deliver');
        assert.match(flagged.find((r) => r.projectName === broken.name).lastSkipReason, /no channel/);
      } finally {
        for (const p of [broken, working, ruleless]) {
          for (const rule of store.sessionRules.list({ projectId: p.id })) store.sessionRules.delete(rule.id);
          store.projects.delete(p.id);
        }
      }
    });

    it('keeps the audit row after the project it describes is deleted', () => {
      const doomed = makeProject(`doomed-${uid()}`);
      store.sessionRuleDeliveries.record({ sessionId: 777, projectId: doomed.id, engineId: 'claude', channel: 'prime-file', outcome: 'delivered', digest: 'survives' });
      store.projects.delete(doomed.id);

      const rows = store.sessionRuleDeliveries.listForSession(777);
      assert.equal(rows.length, 1, 'delivery history must outlive the project — it is an audit trail');
      assert.equal(rows[0].digest, 'survives');
    });
  });
});
