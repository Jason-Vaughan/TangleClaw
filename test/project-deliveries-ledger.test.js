'use strict';

/*
 * #1164 — the Settings modal's rule-delivery ledger lands somewhere visible,
 * and says which of three things it found.
 *
 * `loadProjectRules` fetched `/api/session-rules/deliveries` on every Settings
 * open and rendered into `projRuleDeliveriesList` — an id no markup created,
 * so the request was issued and discarded, and a failed read was silence.
 * These run the real functions lifted out of `public/ui.js` (the same way
 * test/project-rules-unknown.test.js does for the rules lists) against the
 * real `tcRulesUnknownHtml` / `tcDegradedRead` / `tcDeliveryOutcomeClass`
 * from `public/api-helper.js`, so the assertions are about what the operator's
 * list says. The section markup is rendered by the real
 * `renderProjectRulesSection`, so "the container exists" is measured on the
 * HTML the modal produces, not on a source string.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
const HELPER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');

/**
 * Slice a top-level function's body out of a source text by brace matching.
 * @param {string} src - Source text.
 * @param {string} decl - The declaration to find.
 * @returns {string} The body including its braces.
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(bodyStart, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * A top-level `const NAME = [...]` array literal, as source text.
 * @param {string} name - The constant's name.
 * @returns {string} The `const NAME = [...];` statement.
 */
function arrayConst(name) {
  const m = UI_SRC.match(new RegExp(`const ${name}\\s*=\\s*\\[[\\s\\S]*?\\];`));
  assert.ok(m, `${name} array literal must exist in ui.js`);
  return m[0];
}

/**
 * The real helper globals, as api-helper.js exports them.
 * @returns {object} `{tcRulesUnknownHtml, tcDegradedRead, tcDeliveryOutcomeClass}`
 */
function helperGlobals() {
  const sandbox = { console, setTimeout };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HELPER_SRC, sandbox);
  return {
    tcRulesUnknownHtml: sandbox.tcRulesUnknownHtml,
    tcDegradedRead: sandbox.tcDegradedRead,
    tcDeliveryOutcomeClass: sandbox.tcDeliveryOutcomeClass
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Run the real `renderProjectRulesSection` for a project.
 * @returns {string} The section's HTML.
 */
function renderSection() {
  const decl = 'function renderProjectRulesSection(project)';
  const ctx = vm.createContext({ esc, console });
  vm.runInContext(`${arrayConst('WRAP_SECTION_NAMES')}\n${arrayConst('PROJECT_RULE_KINDS')}\n`
    + `${decl}${functionBody(UI_SRC, decl)}\nthis.html = renderProjectRulesSection({ id: 7, name: 'p', wrapSections: null });`, ctx);
  return ctx.html;
}

/**
 * Build the ledger read path against a stubbed `api` and a one-container
 * document, running the real ui.js functions.
 * @param {Function} api - The `api()` stub (must carry `lastError`).
 * @returns {object} `{refresh, retarget, list}`
 */
function build(api) {
  const list = { innerHTML: '' };
  const document = { getElementById: (id) => (id === 'projRuleDeliveriesList' ? list : null) };
  const helpers = helperGlobals();
  const decls = [
    'async function refreshProjectRuleDeliveries(projectId)',
    'function renderProjectRuleDeliveriesUnknown(why)',
    'function renderProjectRuleDeliveries(deliveries)'
  ];
  const source = decls.map((d) => d + functionBody(UI_SRC, d)).join('\n');
  const ctx = vm.createContext({
    api,
    document,
    window: helpers,
    tcDeliveryOutcomeClass: helpers.tcDeliveryOutcomeClass,
    esc,
    encodeURIComponent,
    projectRulesTargetId: 7,
    console
  });
  vm.runInContext(`${source}\nthis.refresh = refreshProjectRuleDeliveries;\n`
    + 'this.retarget = (id) => { projectRulesTargetId = id; };', ctx);
  return { refresh: ctx.refresh, retarget: ctx.retarget, list };
}

/**
 * An `api()` stub that answers with one fixed value, or fails with a reason.
 * @param {object|null} answer - The payload, or null for a failed read.
 * @param {string|null} [why] - `api.lastError` to leave behind on failure.
 * @returns {Function} The stub, carrying `lastError` and the URLs it was asked.
 */
function apiStub(answer, why = null) {
  const api = async (url) => { api.calls.push(url); api.lastError = answer ? null : why; return answer; };
  api.calls = [];
  api.lastError = null;
  return api;
}

describe('#1164 — the Settings modal renders the rule-delivery ledger', () => {
  it('renderProjectRulesSection creates the container the ledger renders into', () => {
    const html = renderSection();
    assert.match(html, /id="projRuleDeliveriesList"/, 'the container exists in the markup the modal renders');
    assert.match(html, /Rule deliveries/, 'and is labelled as the ledger');
    // The rules lists it sits under are still there — the container was
    // added, not swapped in.
    assert.match(html, /id="projRulesList-startup"/);
    assert.match(html, /id="projRulesList-wrap"/);
  });

  it('loadProjectRules reaches the ledger through the three-state reader', () => {
    const body = functionBody(UI_SRC, 'async function loadProjectRules(projectId)');
    assert.match(body, /await refreshProjectRuleDeliveries\(projectId\)/);
    assert.doesNotMatch(body, /api\(`\/api\/session-rules\/deliveries/,
      'the loader does not keep its own copy of the fetch beside the reader');
  });

  it('renders the rows, newest five, with the shared outcome classes', async () => {
    const rows = [];
    for (let i = 0; i < 7; i++) {
      rows.push({ sessionId: 9000 + i, outcome: i === 0 ? 'delivered' : 'skipped', channel: 'rules-hook',
        digest: 'abcdef0123456789', ruleIds: [1, 2], skipReason: i === 0 ? null : 'engine has no silent-prime channel' });
    }
    const api = apiStub({ deliveries: rows });
    const { refresh, list } = build(api);

    const ok = await refresh(7);

    assert.equal(ok, true, 'a real read reports that it happened');
    assert.deepEqual(api.calls, ['/api/session-rules/deliveries?projectId=7']);
    assert.match(list.innerHTML, /<strong>9000<\/strong>: <span class="rules-status-ok">delivered<\/span>/);
    assert.match(list.innerHTML, /<span class="rules-status-err">skipped<\/span>/);
    assert.match(list.innerHTML, /Reason: engine has no silent-prime channel/);
    assert.match(list.innerHTML, /Channel: rules-hook \| Digest: <code>abcdef01<\/code> \| Rules: 2/);
    assert.equal((list.innerHTML.match(/session-rule-item/g) || []).length, 5, 'the newest five, not the whole ledger');
    assert.doesNotMatch(list.innerHTML, /9005|9006/);
    assert.doesNotMatch(list.innerHTML, /No delivery records|Deliveries unknown/);
  });

  it('renders "No delivery records" for a successful empty read — and nothing else', async () => {
    const { refresh, list } = build(apiStub({ deliveries: [] }));

    const ok = await refresh(7);

    assert.equal(ok, true);
    assert.match(list.innerHTML, /No delivery records/);
    assert.doesNotMatch(list.innerHTML, /Deliveries unknown/, 'an empty ledger is not an outage');
    assert.doesNotMatch(list.innerHTML, /role="alert"/);
  });

  it('renders the unknown state, naming the failure, when the read fails', async () => {
    const { refresh, list } = build(apiStub(null, 'Connection lost.'));

    const ok = await refresh(7);

    assert.equal(ok, false, 'a failed read reports that it did not happen');
    assert.doesNotMatch(list.innerHTML, /No delivery records/, 'an outage must not read as a project that never launched');
    assert.match(list.innerHTML, /Deliveries unknown/);
    assert.match(list.innerHTML, /Connection lost\./, 'carries the transport\'s reason');
    assert.match(list.innerHTML, /Close and reopen Settings to retry\./);
    assert.match(list.innerHTML, /role="alert"/);
  });

  it('treats a payload without a deliveries array as unknown, not as empty', async () => {
    const { refresh, list } = build(apiStub({ ok: true }));

    const ok = await refresh(7);

    assert.equal(ok, false);
    assert.match(list.innerHTML, /Deliveries unknown/);
    assert.match(list.innerHTML, /answered without a ledger/);
    assert.doesNotMatch(list.innerHTML, /No delivery records/);
  });

  it('renders nothing when the modal moved to another project mid-read', async () => {
    const api = async () => { retarget(8); return { deliveries: [] }; };
    api.lastError = null;
    const built = build(api);
    const { refresh, list } = built;
    const retarget = built.retarget;

    const ok = await refresh(7);

    assert.equal(ok, null, 'a retargeted modal is neither a read nor an outage');
    assert.equal(list.innerHTML, '', 'the other project\'s container is left alone');
  });

  it('escapes ledger fields before they reach the page', async () => {
    const { refresh, list } = build(apiStub({ deliveries: [
      { sessionId: '<img src=x>', outcome: 'skipped', channel: 'x', digest: null, ruleIds: null, skipReason: '<b>why</b>' }
    ] }));

    await refresh(7);

    assert.doesNotMatch(list.innerHTML, /<img src=x>|<b>why<\/b>/);
    assert.match(list.innerHTML, /&lt;img src=x&gt;/);
    assert.match(list.innerHTML, /Digest: <code>none<\/code> \| Rules: 0/);
  });
});
