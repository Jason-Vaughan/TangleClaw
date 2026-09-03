'use strict';

/*
 * #83 — every form-handler error path renders the server's reason.
 *
 * #80 gave the shared api() helper a `lastError` side-channel and migrated the
 * three "Check server logs" handlers. The rest of the frontend kept guessing:
 * "Wrap failed. Check password." when the server said the session was gone,
 * "Save failed. Name may already exist." when it said the directory was
 * missing, "Test failed — could not reach server" when the server was reached
 * and rejected the key. This suite lifts each migrated handler out of its page
 * script (the project's vm harness — see test/project-rules-unknown.test.js),
 * runs it against an api() that refuses with a specific reason, and asserts
 * that reason is what the operator reads. Where a guess was removed, a
 * negative pin keeps it from returning.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public');
const SRC = {
  session: fs.readFileSync(path.join(PUB, 'session.js'), 'utf8'),
  ui: fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8'),
  landing: fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8'),
  history: fs.readFileSync(path.join(PUB, 'history-drawer.js'), 'utf8')
};

/**
 * Slice a top-level function — signature and body — out of a source text by
 * brace matching from its declaration.
 * @param {string} src - Source text.
 * @param {string} decl - The start of the declaration to find (`async function name(`).
 * @returns {string} The whole function, ready to evaluate.
 */
function functionSource(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * A minimal element: the properties the lifted handlers read and write.
 * @param {string} value - Initial `.value`.
 * @returns {object} The element.
 */
function fakeElement(value) {
  const listeners = {};
  return {
    textContent: '',
    innerHTML: '',
    className: '',
    value,
    disabled: false,
    checked: false,
    title: '',
    type: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    listeners,
    addEventListener(name, fn) { listeners[name] = fn; }
  };
}

/**
 * A document whose elements are created on first lookup and remembered, so a
 * test can read back what the handler wrote to `#wrapError` (etc.).
 * @param {Object<string, string>} [values] - Initial `.value` per element id.
 * @returns {object} `{document, el}` — `el(id)` reads an element back.
 */
function fakeDocument(values = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, fakeElement(Object.prototype.hasOwnProperty.call(values, id) ? values[id] : ''));
    return els.get(id);
  };
  const document = {
    getElementById: el,
    querySelectorAll: () => [],
    createElement: () => fakeElement('')
  };
  return { document, el };
}

/**
 * An api()/apiMutate() pair that refuses every call with `reason`, exactly as
 * the shared helper does on a non-OK response: returns null and parks the
 * server's message on `api.lastError`.
 * @param {string|null} reason - The server's message (`null` mimics a helper that left none).
 * @returns {{api: Function, apiMutate: Function}} The stubs.
 */
function refusingApi(reason) {
  const api = async () => { api.lastError = reason; return null; };
  api.lastError = null;
  api.lastErrorCode = null;
  const apiMutate = async () => api();
  return { api, apiMutate };
}

/**
 * The wrap flow's api(): the wrap POST is refused with `reason`, but the
 * `/wrap/status` probe that `watchWrapRun` makes afterwards SUCCEEDS — and a
 * successful api() call clears `lastError`, exactly as the shared helper does.
 * A handler that reads `lastError` after the probe reads null.
 * @param {string|null} reason - The wrap POST's server message.
 * @returns {{api: Function, apiMutate: Function, watchWrapRun: Function}} The stubs.
 */
function wrapApi(reason) {
  const api = async (url) => {
    if (/\/wrap\/status/.test(url)) { api.lastError = null; api.lastErrorCode = null; return { state: 'idle' }; }
    api.lastError = reason;
    return null;
  };
  api.lastError = null;
  api.lastErrorCode = null;
  const apiMutate = async (url) => api(url);
  // The real watchWrapRun's first act is `await api(statusUrl)`; it returns
  // false when there is no run to reattach to.
  const watchWrapRun = async () => { await api('/api/sessions/demo/wrap/status'); return false; };
  return { api, apiMutate, watchWrapRun };
}

/**
 * Lift the named functions out of a page script and evaluate them in a
 * sandbox holding the given globals.
 * @param {string} src - Page-script source.
 * @param {string[]} decls - Declarations to lift (`async function name(`).
 * @param {object} globals - Sandbox globals the functions reach for.
 * @returns {object} The sandbox; each lifted function is a property on it.
 */
function lift(src, decls, globals) {
  const source = decls.map((d) => functionSource(src, d)).join('\n');
  const names = decls.map((d) => d.replace(/^(async )?function /, '').replace(/\(.*$/, ''));
  const ctx = vm.createContext({
    console, encodeURIComponent, parseInt, Date,
    setTimeout: () => 0,
    ...globals
  });
  vm.runInContext(`${source}\n${names.map((n) => `this.${n} = ${n};`).join('\n')}`, ctx);
  return ctx;
}

/** HTML-escape the way the pages' `esc` does; the history drawer renders via innerHTML. */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('#83 — form handlers render the server reason, not a guess', () => {
  describe('session.js', () => {
    it('confirmWrap shows the POST\'s reason even though the status probe that follows succeeds', async () => {
      const { api, apiMutate, watchWrapRun } = wrapApi('Invalid password');
      const { document, el } = fakeDocument({ wrapPassword: 'pw' });
      const ctx = lift(SRC.session, ['async function confirmWrap('], {
        api, apiMutate, document, watchWrapRun,
        wrapInFlight: false, wrapSkippedAiSteps: {}, wrapBumpLevel: '',
        window: { tcWrapDrawerHelpers: { collectOptionsFromAccessors: () => ({}) } },
        sessionState: {}, projectName: 'demo',
        showWrappingState() {}, clearWrappingState() {}, closeWrapModal() {},
        openWrapDrawer() {}, startPolling() {}
      });
      await ctx.confirmWrap();
      assert.equal(api.lastError, null, 'the probe cleared lastError — the handler must have captured it first');
      assert.equal(el('wrapError').textContent, 'Invalid password');
    });

    it('confirmWrap falls back to a plain "Wrap failed." when no reason came back', async () => {
      const { api, apiMutate, watchWrapRun } = wrapApi(null);
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.session, ['async function confirmWrap('], {
        api, apiMutate, document, watchWrapRun,
        wrapInFlight: false, wrapSkippedAiSteps: {}, wrapBumpLevel: '',
        window: { tcWrapDrawerHelpers: { collectOptionsFromAccessors: () => ({}) } },
        sessionState: {}, projectName: 'demo',
        showWrappingState() {}, clearWrappingState() {}, closeWrapModal() {},
        openWrapDrawer() {}, startPolling() {}
      });
      await ctx.confirmWrap();
      assert.equal(el('wrapError').textContent, 'Wrap failed.');
      assert.doesNotMatch(el('wrapError').textContent, /password/i, 'the password guess must not return');
    });

    it('submitUpload names the file AND the server reason', async () => {
      const { api, apiMutate } = refusingApi('File too large (max 10 MB)');
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.session, ['async function submitUpload('], {
        api, apiMutate, document, projectName: 'demo',
        uploadFiles: [{ name: 'big.bin', data: 'AAAA' }]
      });
      await ctx.submitUpload();
      assert.equal(el('uploadError').textContent, 'Upload failed for big.bin: File too large (max 10 MB)');
    });

    it('injectUpdatePrompt toasts the server reason', async () => {
      const { api, apiMutate } = refusingApi('Session "demo" is not running');
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.session, ['async function injectUpdatePrompt('], {
        api, apiMutate, document, projectName: 'demo',
        buildUpdatePrompt: () => 'update please'
      });
      await ctx.injectUpdatePrompt({});
      assert.equal(el('toast').textContent, 'Session "demo" is not running');
    });

    it('the wrap-drawer handback button toasts the server reason', async () => {
      const { api, apiMutate } = refusingApi('tmux pane is gone');
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.session, ['function buildHandbackButton('], {
        api, apiMutate, document, projectName: 'demo',
        window: { tcWrapDrawerHelpers: { composeHandbackPrompt: () => 'fix it' } }
      });
      const btn = ctx.buildHandbackButton({ id: 'changelog', kindLabel: 'CHANGELOG', remediation: 'x', agentResolvable: true });
      await btn.listeners.click();
      assert.equal(el('toast').textContent, 'tmux pane is gone');
      assert.equal(btn.disabled, false, 'the operator can retry the injection');
    });
  });

  describe('ui.js', () => {
    it('confirmDelete shows the server reason and never says "Check password"', async () => {
      const { api, apiMutate } = refusingApi('Session is still running — stop it first');
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.ui, ['async function confirmDelete('], {
        api, apiMutate, document,
        deleteTarget: 'proj', deleteMode: 'detach',
        closeDelete() {}, loadProjects: async () => {}
      });
      await ctx.confirmDelete();
      assert.equal(el('deleteError').textContent, 'Session is still running — stop it first');
    });

    it('confirmDelete falls back to "<Action> failed." without the password guess', async () => {
      const { api, apiMutate } = refusingApi(null);
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.ui, ['async function confirmDelete('], {
        api, apiMutate, document,
        deleteTarget: 'proj', deleteMode: 'detach',
        closeDelete() {}, loadProjects: async () => {}
      });
      await ctx.confirmDelete();
      assert.equal(el('deleteError').textContent, 'Detach failed.');
    });

    it('saveGroup shows the server reason instead of "Name may already exist"', async () => {
      const { api, apiMutate } = refusingApi('sharedDir does not exist: /nope');
      const { document, el } = fakeDocument({ groupName: 'Backend' });
      const ctx = lift(SRC.ui, ['async function saveGroup('], { api, apiMutate, document, groupEditId: null });
      await ctx.saveGroup();
      assert.equal(el('groupError').textContent, 'sharedDir does not exist: /nope');
    });

    it('syncGroupDir shows the server reason instead of "check the directory path"', async () => {
      const { api, apiMutate } = refusingApi('Group has no sharedDir configured');
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.ui, ['async function syncGroupDir('], { api, apiMutate, document, groupEditId: 3 });
      await ctx.syncGroupDir();
      assert.equal(el('groupSyncStatus').textContent, 'Group has no sharedDir configured');
    });

    it('testConnection reports the server reason instead of "could not reach server"', async () => {
      const { api, apiMutate } = refusingApi('SSH key not found: /Users/me/.ssh/id_missing');
      const { document, el } = fakeDocument({ ocHost: 'h', ocSshUser: 'u', ocSshKeyPath: '/Users/me/.ssh/id_missing' });
      const ctx = lift(SRC.ui, ['async function testConnection('], { api, apiMutate, document });
      await ctx.testConnection();
      assert.equal(el('ocTestResult').textContent, 'Test failed: SSH key not found: /Users/me/.ssh/id_missing');
      assert.doesNotMatch(el('ocTestResult').textContent, /could not reach server/);
    });

    it('saveConnection falls back to "Save failed." — never "Name may already exist"', async () => {
      const { api, apiMutate } = refusingApi(null);
      const { document, el } = fakeDocument({ ocName: 'habitat', ocHost: 'h', ocSshUser: 'u', ocSshKeyPath: '/k' });
      const ctx = lift(SRC.ui, ['async function saveConnection('], {
        api, apiMutate, document, ocEditId: null,
        tcParseBridgePort: () => ({ ok: true, value: null })
      });
      await ctx.saveConnection();
      assert.equal(el('ocError').textContent, 'Save failed.');
    });

    it('saveConnection shows the server reason with its code', async () => {
      const { api, apiMutate } = refusingApi('Port 18789 is leased by "other" (bridge)');
      api.lastErrorCode = 'PORT_CONFLICT';
      const { document, el } = fakeDocument({ ocName: 'habitat', ocHost: 'h', ocSshUser: 'u', ocSshKeyPath: '/k' });
      const ctx = lift(SRC.ui, ['async function saveConnection('], {
        api, apiMutate, document, ocEditId: null,
        tcParseBridgePort: () => ({ ok: true, value: null })
      });
      await ctx.saveConnection();
      assert.equal(el('ocError').textContent, 'Save failed: Port 18789 is leased by "other" (bridge) (PORT_CONFLICT)');
    });

    it('saveDoc shows the server reason instead of "File path may already exist"', async () => {
      const { api, apiMutate } = refusingApi('filePath must be absolute');
      const { document, el } = fakeDocument({ docName: 'NETWORK', docFilePath: 'relative/NETWORK.md', docInjectMode: 'reference' });
      const ctx = lift(SRC.ui, ['async function saveDoc('], { api, apiMutate, document, docEditId: null, docEditGroupId: 'g1' });
      await ctx.saveDoc();
      assert.equal(el('docError').textContent, 'filePath must be absolute');
    });
  });

  describe('landing.js', () => {
    it('confirmWrap shows the server reason and never says "Check password"', async () => {
      const { api, apiMutate } = refusingApi('Wrap already in progress');
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.landing, ['async function confirmWrap('], {
        api, apiMutate, document,
        wrapTarget: 'proj', wrapInFlight: false,
        closeWrapModal() {}, loadProjects: async () => {}
      });
      await ctx.confirmWrap();
      assert.equal(el('wrapError').textContent, 'Wrap already in progress');
    });

    it('saveGlobalRules shows the server reason on the status line', async () => {
      const { api, apiMutate } = refusingApi('Rules file is read-only');
      const { document, el } = fakeDocument({ rulesEditor: '# rules' });
      const ctx = lift(SRC.landing, ['async function saveGlobalRules('], {
        api, apiMutate, document, state: {}
      });
      await ctx.saveGlobalRules();
      assert.equal(el('rulesStatus').textContent, 'Rules file is read-only');
    });

    it('repairAllOrphanHooks toasts the server reason', async () => {
      const { api, apiMutate } = refusingApi('settings.json is not valid JSON');
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.landing, ['async function repairAllOrphanHooks('], {
        api, apiMutate, document,
        state: { orphanHooks: { projectsWithOrphans: [{ name: 'a' }] } },
        window: { confirm: () => true },
        loadProjects: async () => {}
      });
      await ctx.repairAllOrphanHooks();
      assert.equal(el('toast').textContent, 'Repair failed: settings.json is not valid JSON');
    });
  });

  describe('history-drawer.js', () => {
    it('runHistorySearch renders the server reason, HTML-escaped', async () => {
      const { api } = refusingApi('Index <not built>');
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.history, ['async function runHistorySearch('], {
        api, document, esc, historyTarget: 'proj',
        historyQueryString: () => 'q=x', renderHistoryResults() {}
      });
      await ctx.runHistorySearch();
      assert.match(el('historyResults').innerHTML, /Index &lt;not built&gt;/);
      assert.doesNotMatch(el('historyResults').innerHTML, /<not built>/, 'server text goes through esc()');
    });

    it('openHistorySession renders the server reason', async () => {
      const { api } = refusingApi('Session summary missing on disk');
      const { document, el } = fakeDocument({});
      const ctx = lift(SRC.history, ['async function openHistorySession('], {
        api, document, esc, historyTarget: 'proj', safeSid: (s) => s
      });
      await ctx.openHistorySession('sid-1');
      assert.match(el('historyDrill').innerHTML, /Session summary missing on disk/);
    });

    it('runTranscriptSearch renders the server reason', async () => {
      const { api } = refusingApi('Transcript search is disabled for this engine');
      const { document, el } = fakeDocument({ historyTranscriptQuery: 'term' });
      const ctx = lift(SRC.history, ['async function runTranscriptSearch('], {
        api, document, esc, historyTarget: 'proj'
      });
      await ctx.runTranscriptSearch('sid-1');
      assert.match(el('historyTranscriptResults').innerHTML, /Transcript search is disabled for this engine/);
    });
  });
});
