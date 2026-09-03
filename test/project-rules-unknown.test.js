'use strict';

/*
 * #1054 — a failed Project Rules read is an unknown, not "No rules yet."
 *
 * `fetchProjectRules` used to flatten a null from `api()` into `[]`, so an API
 * outage rendered exactly like an empty ruleset. These run the real functions
 * lifted out of `public/ui.js` against the real `tcRulesUnknownHtml` /
 * `tcDegradedRead` from `public/api-helper.js`, so the assertion is about what
 * the operator's list says, not about source strings.
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
 * The real `tcRulesUnknownHtml` and `tcDegradedRead`, as api-helper.js exports them.
 * @returns {object} `{tcRulesUnknownHtml, tcDegradedRead}`
 */
function helperGlobals() {
  const sandbox = { console, setTimeout };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HELPER_SRC, sandbox);
  return { tcRulesUnknownHtml: sandbox.tcRulesUnknownHtml, tcDegradedRead: sandbox.tcDegradedRead };
}

/**
 * Build the Project Rules read path against a stubbed `api` and a two-list
 * document, running the real ui.js functions.
 * @param {Function} api - The `api()` stub (must carry `lastError`).
 * @returns {object} `{refresh, lists}`
 */
function build(api) {
  const lists = { startup: { innerHTML: '' }, wrap: { innerHTML: '' } };
  const document = { getElementById: (id) => lists[id.replace('projRulesList-', '')] || null };
  const decls = [
    'async function fetchProjectRules(projectId, kind)',
    'async function refreshProjectRulesList(projectId, kind)',
    'async function refreshAfterProjectRuleMutation(verb, kind)',
    'function renderProjectRulesUnknown(kind, why)',
    'function renderProjectRulesList(kind, rules)'
  ];
  const source = decls.map((d) => d + functionBody(UI_SRC, d)).join('\n');
  const statuses = [];
  const ctx = vm.createContext({
    api,
    document,
    window: helperGlobals(),
    esc: (s) => String(s == null ? '' : s),
    encodeURIComponent,
    projectRulesTargetId: 7,
    _setProjectRulesStatus: (text, ok) => statuses.push({ text, ok }),
    console
  });
  vm.runInContext(`${source}\nthis.refresh = refreshProjectRulesList;\n`
    + 'this.afterMutation = refreshAfterProjectRuleMutation;\n'
    + 'this.retarget = (id) => { projectRulesTargetId = id; };', ctx);
  return { refresh: ctx.refresh, afterMutation: ctx.afterMutation, retarget: ctx.retarget, lists, statuses };
}

describe('#1054 — a failed Project Rules read renders as unknown', () => {
  it('renders the unknown state, never "No rules yet.", when the read fails', async () => {
    const api = async () => { api.lastError = 'Connection lost.'; return null; };
    api.lastError = null;
    const { refresh, lists } = build(api);

    const ok = await refresh(7, 'startup');

    assert.equal(ok, false, 'a failed read reports that it did not happen');
    assert.doesNotMatch(lists.startup.innerHTML, /No rules yet\./,
      'an outage must not read as an empty ruleset');
    assert.match(lists.startup.innerHTML, /Rules unknown/);
    assert.match(lists.startup.innerHTML, /Connection lost\./, 'carries the transport\'s reason');
    assert.match(lists.startup.innerHTML, /role="alert"/);
    assert.equal(lists.wrap.innerHTML, '', 'the other kind\'s list is untouched');
  });

  it('still renders "No rules yet." for a successful empty read', async () => {
    const api = async () => ({ rules: [] });
    api.lastError = null;
    const { refresh, lists } = build(api);

    const ok = await refresh(7, 'wrap');

    assert.equal(ok, true);
    assert.match(lists.wrap.innerHTML, /No rules yet\./);
    assert.doesNotMatch(lists.wrap.innerHTML, /Rules unknown/);
  });

  it('renders the rules, minus rejections, for a successful non-empty read', async () => {
    const api = async () => ({ rules: [
      { id: 1, content: 'keep me', enabled: true, status: 'active' },
      { id: 2, content: 'drop me', enabled: true, status: 'rejected' }
    ] });
    api.lastError = null;
    const { refresh, lists } = build(api);

    await refresh(7, 'startup');

    assert.match(lists.startup.innerHTML, /keep me/);
    assert.doesNotMatch(lists.startup.innerHTML, /drop me/, 'rejections stay filtered');
  });

  it('says on the status line when a mutation succeeded but the re-read did not', async () => {
    // The handler's own "Added" is true; the list under it is now unknown. A
    // green status over "Rules unknown" reads as a contradiction, so the
    // failed re-read gets its own sentence — and only on a failed re-read.
    const api = async () => { api.lastError = 'Connection lost.'; return null; };
    api.lastError = null;
    const { afterMutation, lists, statuses } = build(api);

    await afterMutation('Added', 'startup');

    assert.match(lists.startup.innerHTML, /Rules unknown/);
    assert.deepEqual(statuses, [{ text: 'Added, but the rules list could not be re-read — close and reopen Settings', ok: false }]);
  });

  it('stays quiet on the status line when the re-read succeeds', async () => {
    const api = async () => ({ rules: [] });
    api.lastError = null;
    const { afterMutation, statuses } = build(api);

    await afterMutation('Deleted', 'wrap');

    assert.deepEqual(statuses, [], 'a successful re-read adds nothing to the handler\'s own confirmation');
  });

  it('renders nothing and answers null when the modal moved to another project mid-read', async () => {
    let retarget;
    const api = async () => { retarget(99); api.lastError = 'Connection lost.'; return null; };
    api.lastError = null;
    const built = build(api);
    retarget = built.retarget;

    const answer = await built.refresh(7, 'startup');

    assert.equal(answer, null, 'a retargeted modal is not an outage');
    assert.equal(built.lists.startup.innerHTML, '', 'and nothing is rendered into the old target');
  });

  it('every re-read after a mutation goes through the three-state refresh', () => {
    // One call site is not the family: a mutation handler that re-reads on its
    // own is the shape that re-flattens a failed read into the list renderer.
    // The fetch may be called from exactly one place — the refresh.
    const calls = UI_SRC.match(/fetchProjectRules\(/g) || [];
    assert.equal(calls.length, 2,
      'fetchProjectRules is declared once and called once (inside refreshProjectRulesList)');
    const handlers = UI_SRC.match(/refreshAfterProjectRuleMutation\(/g) || [];
    assert.equal(handlers.length, 5,
      'declared once and called by the four mutation handlers');
  });
});
