'use strict';

// #2029: every rule surface names a rule "Rule #<id>" from its database id,
// independent of what its author typed. One fixture set — a proposed, an
// active, a disabled, a superseded and a rejected rule — is driven through the
// store (the API's shape), the `tc rules` CLI, the startup delivery carriers,
// the dashboard lists, the wrap drawer and every approval prompt.
//
// "Superseded" is not a stored state: session_rules knows proposed | active |
// rejected plus `enabled`. A superseded rule is what the operator makes of one
// — an active rule disabled once its replacement is approved — so the fixture
// builds exactly that, with each rule's text naming the other's number.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const loadApiHelperGlobals = require('./_api-helper-globals');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const SESSION_SRC = fs.readFileSync(path.join(PUB, 'session.js'), 'utf8');
const HELPER_SRC = fs.readFileSync(path.join(PUB, 'api-helper.js'), 'utf8');
const DRAWER_SRC = fs.readFileSync(path.join(PUB, 'wrap-drawer.js'), 'utf8');

const helpers = loadApiHelperGlobals();

/**
 * Lift one function's `{ … }` body out of a browser source file.
 * @param {string} src - The file's source
 * @param {string} decl - The declaration text that opens the function
 * @returns {string}
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} must exist`);
  const open = src.indexOf('{', start + decl.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return assert.fail(`${decl} must close`);
}

/**
 * Compile a lifted browser function with its free variables supplied.
 * @param {string} src - The file's source
 * @param {string} decl - Declaration to lift, e.g. 'function renderProjectRulesList('
 * @param {string} params - Its parameter list, e.g. 'kind, rules'
 * @param {object} deps - Free variables, by name
 * @returns {Function}
 */
function lift(src, decl, params, deps) {
  const names = Object.keys(deps);
  const isAsync = decl.startsWith('async ');
  // eslint-disable-next-line no-new-func
  return new Function(...names,
    `return ${isAsync ? 'async ' : ''}function (${params}) ${functionBody(src, decl)};`)(...names.map((n) => deps[n]));
}

/** The label helpers exactly as the page gets them from api-helper.js. */
const labelDeps = {
  tcRuleLabel: helpers.tcRuleLabel,
  tcStripSameIdPrefix: helpers.tcStripSameIdPrefix,
  tcAuthoredIdMismatch: helpers.tcAuthoredIdMismatch,
  tcRuleMismatchBadge: helpers.tcRuleMismatchBadge,
  tcRuleMismatchTitle: helpers.tcRuleMismatchTitle
};

/** Escape as the pages do, so assertions see what the browser would. */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

describe('Rule #<id> on every surface (#2029)', () => {
  let tmpDir;
  let project;
  let rules; // { proposed, active, disabled, superseded, replacement, rejected }
  let master;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rule-id-display-'));
    store._setBasePath(tmpDir);
    store.init();
    const projDir = path.join(tmpDir, 'projects', 'rule-ids');
    fs.mkdirSync(projDir, { recursive: true });
    project = store.projects.create({ name: 'rule-ids', path: projDir, engine: 'claude' });
    const pid = project.id;
    const create = (content, extra = {}) => store.sessionRules.create({ content, projectId: pid, ...extra });

    const active = create('Always run lint before commit.');
    const proposed = create('Prefer small commits.', { createdBy: 'ai' });
    const disabled = create('Mention the ticket in every PR.');
    store.sessionRules.update(disabled.id, { enabled: false });
    // The superseded rule carries the interim authored prefix naming itself;
    // its replacement's text names the superseded rule's number, not its own.
    const superseded = create('placeholder');
    store.sessionRules.update(superseded.id, { content: `RULE #${superseded.id} — RM-LEASE X generation 1` });
    const replacement = create(`RM-LEASE X generation 2\nsupersedes: RULE #${superseded.id}`);
    store.sessionRules.update(superseded.id, { enabled: false });
    const rejected = create('Never write tests.', { createdBy: 'ai' });
    store.sessionRules.setStatus(rejected.id, 'rejected');
    master = store.sessionRules.create({ content: 'Never force-push main.', kind: 'master' });

    const get = (r) => store.sessionRules.get(r.id);
    rules = {
      proposed: get(proposed), active: get(active), disabled: get(disabled),
      superseded: get(superseded), replacement: get(replacement), rejected: get(rejected)
    };
    // The fixture is only worth something if the states are what they claim.
    assert.equal(rules.proposed.status, 'proposed');
    assert.equal(rules.active.status, 'active');
    assert.equal(rules.active.enabled, true);
    assert.equal(rules.disabled.enabled, false);
    assert.equal(rules.superseded.enabled, false);
    assert.equal(rules.rejected.status, 'rejected');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const STATES = ['proposed', 'active', 'disabled', 'superseded', 'rejected'];

  describe('the store — the shape every API response carries', () => {
    it('labels each state from its id', () => {
      for (const s of STATES) assert.equal(rules[s].label, `Rule #${rules[s].id}`, s);
    });

    it('labels list results and master rules too', () => {
      for (const r of store.sessionRules.list({ projectId: project.id })) {
        assert.equal(r.label, `Rule #${r.id}`);
      }
      assert.equal(store.sessionRules.get(master.id).label, `Rule #${master.id}`);
    });
  });

  describe('tc rules (CLI)', () => {
    it('names every rule, in every state, by its id', () => {
      const { renderRules } = require('../lib/tc-verbs')._internals || require('../lib/tc-verbs');
      const out = renderRules({ rules: Object.values(rules) });
      for (const s of STATES) assert.match(out, new RegExp(`Rule #${rules[s].id}\\b`), s);
      // A same-id authored prefix is not doubled; the replacement keeps the
      // other rule's number visible in its own text.
      assert.doesNotMatch(out, new RegExp(`Rule #${rules.superseded.id} — RULE #${rules.superseded.id}`));
      assert.match(out, new RegExp(`Rule #${rules.replacement.id} — RM-LEASE X generation 2`));
      assert.doesNotMatch(out, /text says/);
    });

    it('flags a rule whose text claims another rule\'s number', () => {
      const { renderRules } = require('../lib/tc-verbs');
      const out = renderRules({ rules: [{ id: 117, kind: 'startup', status: 'proposed', enabled: 1, content: 'RULE #94 — x' }] });
      assert.match(out, /\[startup — PROPOSED · text says #94, not this rule\] Rule #117 — RULE #94 — x/);
    });
  });

  describe('startup delivery — prime, hook channel and launch step', () => {
    it('labels each delivered rule on the inline carrier', () => {
      const sessions = require('../lib/sessions');
      const section = sessions.buildStartupRulesSection(project.id);
      const inline = section.inlineLines.join('\n');
      assert.match(inline, new RegExp(`^- Rule #${rules.active.id} — Always run lint before commit\\.$`, 'm'));
      assert.match(inline, new RegExp(`^- Rule #${rules.replacement.id} — RM-LEASE X generation 2$`, 'm'));
      // Only enabled, active rules are delivered at all.
      for (const s of ['proposed', 'disabled', 'superseded', 'rejected']) {
        assert.doesNotMatch(inline, new RegExp(`^- Rule #${rules[s].id} `, 'm'), s);
      }
    });

    it('labels each rule on the hook channel shards', () => {
      const channel = require('../lib/session-rules-channel');
      const shards = channel.buildShards([rules.active, rules.replacement], 100000);
      const body = shards.map((s) => s.body).join('\n');
      assert.match(body, new RegExp(`- Rule #${rules.active.id} — Always run lint`));
      assert.match(body, new RegExp(`- Rule #${rules.replacement.id} — RM-LEASE X generation 2`));
    });
  });

  describe('agent-facing carriers beyond the prime', () => {
    it('names each stored Hard rule by id in the Project Master\'s instructions', () => {
      const masterMod = require('../lib/master');
      const m = store.sessionRules.get(master.id);
      const md = masterMod.buildMasterClaudeMd({ serverPort: 3102 }, { rules: [m] });
      assert.match(md, new RegExp(`^- Rule #${m.id} — Never force-push main\\.$`, 'm'));
    });

    it('renders the shipped baseline as written when no rule is stored (it has no id)', () => {
      const masterMod = require('../lib/master');
      const md = masterMod.buildMasterClaudeMd({ serverPort: 3102 }, { rules: [] });
      assert.doesNotMatch(md, /^- Rule #/m);
    });

    it('names each wrap rule by id in the wrap prompt', () => {
      const aic = require('../lib/wrap-steps/ai-content');
      const saved = aic._internal.listWrapRules;
      try {
        aic._internal.listWrapRules = () => [rules.active];
        const out = aic._appendWrapRules('base', project);
        assert.match(out, new RegExp(`^- Rule #${rules.active.id} — Always run lint before commit\\.$`, 'm'));
      } finally {
        aic._internal.listWrapRules = saved;
      }
    });
  });

  describe('dashboard — Project Rules list', () => {
    /** Render the list for the given rules and return its HTML. */
    function render(list) {
      const el = { innerHTML: '' };
      const renderProjectRulesList = lift(UI_SRC, 'function renderProjectRulesList(', 'kind, rules', {
        document: { getElementById: () => el }, esc, projectRuleShownContent: new Map(), ...labelDeps
      });
      renderProjectRulesList('startup', list);
      return el.innerHTML;
    }

    it('shows the label on the card for every state', () => {
      const html = render(Object.values(rules));
      for (const s of STATES) {
        assert.match(html, new RegExp(`<span class="session-rule-label">Rule #${rules[s].id}</span>`), s);
      }
    });

    it('names the rule on the control that acts on it', () => {
      const html = render([rules.proposed, rules.active]);
      assert.match(html, new RegExp(`data-action="approve-rule" data-rule-id="${rules.proposed.id}" aria-label="Approve Rule #${rules.proposed.id}"`));
      assert.match(html, new RegExp(`data-action="reject-rule" data-rule-id="${rules.proposed.id}" aria-label="Reject Rule #${rules.proposed.id}"`));
      assert.match(html, new RegExp(`data-action="delete-rule" data-rule-id="${rules.active.id}" aria-label="Delete Rule #${rules.active.id}"`));
    });

    it('labels from the id when the text claims another number', () => {
      const html = render([{ id: 117, content: 'RULE #94 — look-alike', status: 'proposed', enabled: true, createdBy: 'ai' }]);
      assert.match(html, /<span class="session-rule-label">Rule #117<\/span>/);
      assert.match(html, /RULE #94 — look-alike/, 'the mismatched authored number stays visible');
      assert.match(html, /session-rule-badge--mismatch[^>]*>text says #94</, 'and is flagged, not just left in place');
    });

    it('flags no mismatch when the text names the rule itself, or no number', () => {
      const html = render([rules.superseded, rules.active, rules.replacement]);
      assert.doesNotMatch(html, /session-rule-badge--mismatch/);
    });
  });

  describe('dashboard — Global (master) rules list', () => {
    it('shows the label on each row and each control', () => {
      const el = { innerHTML: '' };
      const renderMasterRulesList = lift(HELPER_SRC, 'function renderMasterRulesList(', 'rules', {
        document: { getElementById: () => el }, esc, ...labelDeps
      });
      const m = store.sessionRules.get(master.id);
      renderMasterRulesList([m, { ...m, id: m.id + 1000, enabled: false, content: 'RULE #3 — borrowed' }]);
      assert.match(el.innerHTML, /session-rule-badge--mismatch[^>]*>text says #3</);
      for (const id of [m.id, m.id + 1000]) {
        assert.match(el.innerHTML, new RegExp(`<span class="session-rule-label">Rule #${id}</span>`));
        assert.match(el.innerHTML, new RegExp(`aria-label="Delete Rule #${id}"`));
        assert.match(el.innerHTML, new RegExp(`aria-label="Enable Rule #${id}"`));
      }
    });
  });

  describe('approval prompts cannot omit the id', () => {
    /**
     * Run resolveProjectRuleProposal with a scripted server answer and
     * return every status line it printed.
     */
    async function projectDecision(id, status, answer) {
      const statuses = [];
      const api = { lastError: 'boom', lastErrorCode: null, lastBody: null };
      const resolve = lift(UI_SRC, 'async function resolveProjectRuleProposal(', 'id, status, kind', {
        document: { getElementById: () => null },
        apiMutate: async () => { api.lastErrorCode = answer.code || null; return answer.data || null; },
        api,
        projectRuleShownContent: new Map([[id, 'x']]),
        _setProjectRulesStatus: (msg) => statuses.push(msg),
        refreshProjectRulesList: async () => true,
        refreshAfterProjectRuleMutation: async () => {},
        projectRulesTargetId: 1,
        ...labelDeps
      });
      await resolve(id, status, 'startup');
      return statuses;
    }

    it('names the rule in every outcome of a Project Rules decision', async () => {
      const id = rules.proposed.id;
      const outcomes = [
        ['active', { data: { id } }],
        ['rejected', { data: { id } }],
        ['active', { code: 'RULE_CONTENT_CHANGED' }],
        ['active', { code: 'SOMETHING_ELSE' }],
        ['rejected', { code: 'SOMETHING_ELSE' }]
      ];
      for (const [status, answer] of outcomes) {
        const lines = await projectDecision(id, status, answer);
        assert.ok(lines.length > 0, `${status}/${answer.code || 'ok'} said something`);
        for (const line of lines) assert.match(line, new RegExp(`Rule #${id}\\b`), `${status}/${answer.code || 'ok'}: ${line}`);
      }
    });

    it('names the rule when asking for the password', async () => {
      const statuses = [];
      const api = { lastError: null, lastErrorCode: 'FORBIDDEN', lastBody: null };
      const pwGroup = { classList: { remove() {} } };
      const resolve = lift(UI_SRC, 'async function resolveProjectRuleProposal(', 'id, status, kind', {
        document: { getElementById: (x) => (x === 'projRulesPwGroup' ? pwGroup : (x === 'projRulesPw' ? { value: '', focus() {} } : null)) },
        apiMutate: async () => null,
        api,
        projectRuleShownContent: new Map(),
        _setProjectRulesStatus: (msg) => statuses.push(msg),
        refreshProjectRulesList: async () => true,
        refreshAfterProjectRuleMutation: async () => {},
        projectRulesTargetId: 1,
        ...labelDeps
      });
      await resolve(42, 'active', 'startup');
      assert.deepEqual(statuses.length, 1);
      assert.match(statuses[0], /^Approving Rule #42 needs the delete password/);
    });

    /** Run the wrap drawer's resolveRuleProposal and return its note. */
    async function drawerDecision(decision, answer, edited) {
      const api = { lastError: 'boom', lastErrorCode: null, lastBody: null };
      const resolve = lift(SESSION_SRC, 'async function resolveRuleProposal(', 'proposal, decision, els', {
        apiMutate: async (url, method, body) => {
          if (method === 'PUT' && body && body.content !== undefined) return answer.save === false ? null : { content: body.content };
          api.lastErrorCode = answer.code || null;
          api.lastBody = answer.body || null;
          return answer.data || null;
        },
        api,
        currentWrapPassword: null,
        tcRuleLabel: helpers.tcRuleLabel
      });
      const els = {
        row: { classList: { add() {} } }, ta: { value: edited === undefined ? 'text' : edited, disabled: false },
        approveBtn: { disabled: false }, rejectBtn: { disabled: false }, note: { textContent: '' },
        passwordGroup: { classList: { remove() {} } }, passwordInput: { value: '', focus() {} }
      };
      await resolve({ ruleId: 88, content: 'text' }, decision, els);
      return els.note.textContent;
    }

    it('names the rule in every outcome of a wrap-drawer decision', async () => {
      const cases = [
        ['active', { data: { id: 88 } }],
        ['rejected', { data: { id: 88 } }],
        ['active', { code: 'FORBIDDEN' }],
        ['active', { code: 'RULE_CONTENT_CHANGED', body: { currentContent: 'new' } }],
        ['active', { code: 'OTHER' }],
        ['rejected', { code: 'OTHER' }],
        ['active', { save: false }, 'edited text'],
        ['active', {}, '   ']
      ];
      for (const [decision, answer, edited] of cases) {
        const note = await drawerDecision(decision, answer, edited);
        assert.match(note, /Rule #88\b/, `${decision}/${JSON.stringify(answer)}: ${note}`);
      }
    });

    it('labels each proposal row and its controls in the wrap drawer', () => {
      const made = [];
      const node = (tag) => {
        const n = { tag, children: [], dataset: {}, attrs: {}, classList: { add() {}, remove() {} },
          appendChild(c) { this.children.push(c); return c; },
          setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {} };
        made.push(n);
        return n;
      };
      const render = lift(SESSION_SRC, 'function renderRuleProposalWidget(', 'widget', {
        document: { createElement: node }, resolveRuleProposal: () => {},
        tcRuleLabel: helpers.tcRuleLabel, tcAuthoredIdMismatch: helpers.tcAuthoredIdMismatch,
        tcRuleMismatchTitle: helpers.tcRuleMismatchTitle
      });
      render({ kind: 'rule-proposal', proposals: [{ ruleId: 5, content: 'a' }, { ruleId: 6, content: 'RULE #99 — b' }] });
      const labels = made.filter((n) => n.className && n.className.includes('wrap-proposal-label')).map((n) => n.textContent);
      assert.deepEqual(labels, ['Rule #5', 'Rule #6']);
      const cues = made.filter((n) => n.className && n.className.includes('session-rule-badge--mismatch')).map((n) => n.textContent);
      assert.deepEqual(cues, ['text says #99'], 'only the row whose text claims another number is flagged');
      const aria = made.map((n) => n.attrs['aria-label']).filter(Boolean);
      for (const want of ['Approve Rule #5', 'Reject Rule #5', 'Approve Rule #6', 'Reject Rule #6']) {
        assert.ok(aria.includes(want), `missing aria-label ${want}`);
      }
    });

    it('source guard: no status line or note in a decision path is written without the label', () => {
      // A new branch added later must name the rule too; this catches one that
      // prints a bare string.
      const project = functionBody(UI_SRC, 'async function resolveProjectRuleProposal(');
      for (const call of project.match(/_setProjectRulesStatus\([^;]*;/gs)) {
        assert.match(call, /tcRuleLabel\(id\)/, call);
      }
      const drawer = functionBody(SESSION_SRC, 'async function resolveRuleProposal(');
      for (const assign of drawer.match(/note\.textContent = [^;]*;/gs)) {
        assert.match(assign, /\$\{label\}/, assign);
      }
    });
  });

  describe('operator notifications — the wrap summary', () => {
    it('names the proposed rules in the drawer summary', () => {
      const sandbox = {};
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(HELPER_SRC, sandbox);
      vm.runInContext(DRAWER_SRC, sandbox);
      const row = sandbox.tcWrapDrawerHelpers.buildStepRow({
        stepId: 'rule-proposal', kind: 'rule-proposal', status: 'done',
        output: { count: 2, proposed: [{ ruleId: 117 }, { ruleId: 118 }] }, blockers: []
      });
      assert.match(row.detail, /^2 rules proposed \(Rule #117, Rule #118\) — awaiting your review/);
    });

    it('names the proposed rules in the wrap step\'s own detail', async () => {
      const ruleProposal = require('../lib/wrap-steps/rule-proposal');
      store.learnings.create({ projectId: project.id, content: 'lesson one', tier: 'active' });
      store.learnings.create({ projectId: project.id, content: 'lesson two', tier: 'active' });
      const res = await ruleProposal.run({ project });
      assert.equal(res.status, 'done');
      const ids = res.output.proposed.map((p) => p.ruleId);
      assert.equal(ids.length, 2);
      assert.match(res.output.detail,
        new RegExp(`^2 rules proposed for your review \\(Rule #${ids[0]}, Rule #${ids[1]}\\) — nothing is applied`));
    });
  });
});
