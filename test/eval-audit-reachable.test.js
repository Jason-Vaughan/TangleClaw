'use strict';

/*
 * #1236 — Eval Audit could only be switched on by hand-editing `project.json`,
 * so the dashboard panel was empty on every install and the feature read as
 * dead. #1227 read that panel and filed to DELETE a complete working feature;
 * it was closed NOT_PLANNED once the premise was disproven. This chunk gives
 * the setting a write path, a readable current value, and words.
 *
 * The load-bearing correction here is the one C1's design got wrong: Eval Audit
 * is NOT universal. `POST /api/audit/ingest` authenticates a bearer token
 * against `openclaw_connections.auditSecret` and resolves the project as the one
 * whose engine is `openclaw:<conn.id>`. That is the only write path into
 * `evalExchanges`, and every score, anomaly and incident is downstream of an
 * exchange — so on any other engine the setting stores a value no row can
 * follow, which is the very defect #1236 was filed for.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');
setLevel('error');
const store = require('../lib/store');
const engines = require('../lib/engines');
const { makeDocument } = require('./_mini-dom');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const API_HELPER_SRC = fs.readFileSync(path.join(PUB, 'api-helper.js'), 'utf8');

/**
 * Slice a top-level declaration out of source by brace-matching, so the sandbox
 * runs the REAL code rather than a copy of it.
 * @param {string} src - File source.
 * @param {string} decl - Declaration text to find.
 * @returns {string}
 */
function lift(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} must close`);
  return '';
}

describe('#1236 Eval Audit is reachable, and honest about where it works', () => {
  let tmpDir;
  let projectsDir;
  let projects;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eval-audit-reach-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    projects = require('../lib/projects');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A project on `engineId`, with an optional stored `evalAuditMode`.
   * @param {string} name - Project name.
   * @param {string} engineId - Engine id to bind.
   * @param {object} [auditMode] - Stored evalAuditMode object.
   * @returns {object} The stored project row.
   */
  function makeProject(name, engineId, auditMode) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const row = store.projects.create({ name, path: dir, engine: engineId });
    const cfg = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
    cfg.engine = engineId;
    if (auditMode) cfg.evalAuditMode = { ...cfg.evalAuditMode, ...auditMode };
    store.projectConfig.save(dir, cfg);
    return row;
  }

  describe('the write path (updateProject)', () => {
    it('enables Eval Audit on a project fed by an OpenClaw connection', async () => {
      const p = makeProject('ea-openclaw', 'openclaw:conn-1');
      const result = await projects.updateProject(p.name, { evalAuditMode: { enabled: true } });
      assert.deepEqual(result.errors || [], []);
      const cfg = store.projectConfig.load(path.join(projectsDir, 'ea-openclaw'));
      assert.equal(cfg.evalAuditMode.enabled, true);
    });

    it('refuses to enable it where no exchange can ever arrive, in the words the modal shows', async () => {
      const p = makeProject('ea-claude', 'claude');
      const result = await projects.updateProject(p.name, { evalAuditMode: { enabled: true } });
      assert.equal(result.project, null, 'the PATCH is refused, not silently stored');
      assert.match(result.errors[0], /Eval Audit/, 'the error names what it refused');
      const disposition = engines.settingDisposition('evalAuditMode', {}, { id: 'claude' });
      assert.ok(result.errors[0].includes(disposition.reason),
        `the refusal carries the disposition's own sentence.\ngot: ${result.errors[0]}`);
      const cfg = store.projectConfig.load(path.join(projectsDir, 'ea-claude'));
      assert.equal(cfg.evalAuditMode.enabled, false, 'nothing was written');
    });

    it('lets a project that cannot use it be switched OFF — a refusal gates enabling, not repair', async () => {
      // A project could hold `enabled: true` from a hand-edit made before this
      // gate existed. Refusing the disable would strand it on.
      const p = makeProject('ea-stranded', 'claude', { enabled: true });
      const result = await projects.updateProject(p.name, { evalAuditMode: { enabled: false } });
      assert.deepEqual(result.errors || [], []);
      const cfg = store.projectConfig.load(path.join(projectsDir, 'ea-stranded'));
      assert.equal(cfg.evalAuditMode.enabled, false);
    });

    it('MERGES rather than replaces, so a configured cost cap survives a toggle', async () => {
      // The object carries fifteen scoring tunables beside `enabled`. Assigning
      // over it would make a settings save quietly destroy settings.
      const p = makeProject('ea-merge', 'openclaw:conn-2', { costCapPerSession: 5.5, judgeModel: 'custom-judge' });
      await projects.updateProject(p.name, { evalAuditMode: { enabled: true } });
      const cfg = store.projectConfig.load(path.join(projectsDir, 'ea-merge'));
      assert.equal(cfg.evalAuditMode.enabled, true);
      assert.equal(cfg.evalAuditMode.costCapPerSession, 5.5, 'the hand-edited cap survived');
      assert.equal(cfg.evalAuditMode.judgeModel, 'custom-judge');
      assert.equal(cfg.evalAuditMode.gateCascade, true, 'and so did the untouched defaults');
    });

    it('refuses an unknown key rather than dropping it', async () => {
      // Silently ignoring input that does nothing is the exact defect ADR 0013
      // exists to end; committing it inside the fix for it would be a poor joke.
      const p = makeProject('ea-unknown', 'openclaw:conn-3');
      const result = await projects.updateProject(p.name, {
        evalAuditMode: { enabled: true, costCapPerSession: 99 }
      });
      assert.equal(result.project, null);
      assert.match(result.errors[0], /costCapPerSession/, 'it names the key it refused');
      assert.match(result.errors[0], /project\.json/, 'and where that key IS editable');
    });

    it('rejects a non-object and a non-boolean enabled', async () => {
      const p = makeProject('ea-types', 'openclaw:conn-4');
      for (const bad of ['yes', 42, [], true]) {
        const r = await projects.updateProject(p.name, { evalAuditMode: bad });
        assert.equal(r.project, null, `${JSON.stringify(bad)} must be refused`);
        assert.match(r.errors[0], /must be an object/);
      }
      const r2 = await projects.updateProject(p.name, { evalAuditMode: { enabled: 'yes' } });
      assert.equal(r2.project, null);
      assert.match(r2.errors[0], /must be a boolean/);
    });
  });

  describe('the read shape (enrichProject)', () => {
    it('reports the setting for a project that has it off, so the modal can render the control', async () => {
      // `null` for "off" made the setting invisible to the one surface that
      // could turn it on — the whole reason it was hand-edit-only.
      makeProject('ea-read-off', 'openclaw:conn-5');
      const list = await projects.listProjects();
      const row = list.find(p => p.name === 'ea-read-off');
      assert.ok(row.evalAudit, 'evalAudit must be present even when disabled');
      assert.equal(row.evalAudit.enabled, false);
      assert.equal(row.evalAudit.openIncidents, 0);
    });

    it('carries this project\'s own judge model and cost cap, for the control to state', async () => {
      makeProject('ea-read-cost', 'openclaw:conn-6', { enabled: true, costCapPerSession: 2.5, judgeModel: 'my-judge' });
      const list = await projects.listProjects();
      const row = list.find(p => p.name === 'ea-read-cost');
      assert.equal(row.evalAudit.enabled, true);
      assert.equal(row.evalAudit.costCapPerSession, 2.5, 'the operator reads what they configured');
      assert.equal(row.evalAudit.judgeModel, 'my-judge');
    });
  });

  describe('the control renders (#1037: run it, do not match its source)', () => {
    /**
     * @param {object} opts - `engineId`, `projectEngine`, `checked`, `audit`.
     * @returns {string} The container's markup.
     */
    function render({ engineId, projectEngine = null, checked = false, audit = null }) {
      const { doc } = makeDocument(['settingsEvalAuditContainer']);
      const ctx = {
        document: doc,
        state: { engines: [] },
        esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      };
      vm.createContext(ctx);
      // By pattern, not by name: a table added later and not named here fails
      // as a ReferenceError from inside the lifted function, which is the
      // failure this style of test exists to catch rather than to suffer.
      const tables = API_HELPER_SRC.match(/const TC_SETTING_\w+ = \{[\s\S]*?\n {2}\};/g) || [];
      assert.ok(tables.length >= 2, `expected the setting tables to lift, found ${tables.length}`);
      for (const table of tables) vm.runInContext(table, ctx);
      vm.runInContext(lift(API_HELPER_SRC, 'function tcHonoredLaunchModes'), ctx);
      vm.runInContext(lift(API_HELPER_SRC, 'function tcEngineDisplayName'), ctx);
      vm.runInContext(lift(API_HELPER_SRC, 'function tcSettingDisposition'), ctx);
      vm.runInContext(lift(UI_SRC, 'function renderEvalAuditToggle'), ctx);
      ctx.renderEvalAuditToggle(engineId, checked, projectEngine, audit);
      return doc.getElementById('settingsEvalAuditContainer').innerHTML;
    }

    it('renders a live toggle for a project fed by an OpenClaw connection', () => {
      const projectEngine = { id: 'openclaw:conn-1', name: 'Studio (OpenClaw)', capabilities: {} };
      const html = render({ engineId: 'openclaw:conn-1', projectEngine });
      assert.match(html, /id="settingsEvalAudit"/);
      assert.doesNotMatch(html, /disabled/);
    });

    it('states the cost before the switch, using the project\'s own numbers', () => {
      // #1236 asks for the spend to be visible rather than a free-looking
      // checkbox. Hardcoding the numbers would show an operator who edited them
      // a cap that is not theirs.
      const projectEngine = { id: 'openclaw:conn-1', name: 'Studio (OpenClaw)', capabilities: {} };
      const html = render({
        engineId: 'openclaw:conn-1', projectEngine,
        audit: { judgeModel: 'my-judge', costCapPerSession: 2.5 }
      });
      assert.match(html, /Costs money/i, 'the cost is stated, not implied');
      assert.match(html, /my-judge/, 'the judge model is this project\'s');
      assert.match(html, /\$2\.50/, 'and so is the cap');
    });

    it('renders inert with the server\'s own sentence where no exchange can arrive', () => {
      const html = render({ engineId: 'claude', projectEngine: { id: 'claude', name: 'Claude Code', capabilities: {} } });
      assert.match(html, /id="settingsEvalAuditNotApplicable"/, 'inert, not absent');
      assert.doesNotMatch(html, /id="settingsEvalAudit"/, 'no saveable control on this branch');
      const server = engines.settingDisposition('evalAuditMode', {}, { id: 'claude', name: 'Claude Code' });
      assert.ok(html.includes(server.reason),
        `the rendered reason must be the server's.\nserver: ${server.reason}\nhtml: ${html}`);
    });
  });

  describe('the empty state says what the feature is and how to reach it', () => {
    it('names the feature, the cost and the route in, not just the state', () => {
      // "No projects have Eval Audit enabled." was true and actionable by
      // nobody. #1227 read exactly that and concluded the button was dead.
      const panel = UI_SRC.slice(UI_SRC.indexOf('function renderAuditPanel'));
      const empty = panel.slice(0, panel.indexOf('audit-summary-table'));
      assert.doesNotMatch(empty, /No projects have Eval Audit enabled\./,
        'the dead-end string is gone');
      assert.match(empty, /scores your sessions/i, 'it says what the feature does');
      assert.match(empty, /Settings/, 'and where to switch it on');
      assert.match(empty, /OpenClaw/, 'and why most projects cannot');
      assert.match(empty, /real money|spend/i, 'and that it costs');
    });
  });
});
