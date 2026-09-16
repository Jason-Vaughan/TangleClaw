'use strict';

/*
 * The stranded-wrap surfaces in the browser (#1539, #1540, #1541): the shared
 * list markup, the dashboard's acknowledge-and-launch dialog, the wrap modals'
 * "Wrap anyway" confirmation on both pages, the drawer's Retry, and the card
 * badge. Each runs the real page code, lifted out of its file, against a small
 * fake DOM, and follows the choice all the way to the request body it produces.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const loadApiHelperGlobals = require('./_api-helper-globals');

const PUBLIC = path.join(__dirname, '..', 'public');
const LANDING_SRC = fs.readFileSync(path.join(PUBLIC, 'landing.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8');
const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');

const helpers = loadApiHelperGlobals();
const drawer = require('../public/wrap-drawer');

const REMOTE = 'https://github.com/example/sandbox.git';
const SHA = 'c'.repeat(40);
const ITEM = {
  scope: 'repo', remote: REMOTE, branch: 'wrap/1-x', headSha: SHA, recordedAt: '2026-09-16T21:39:10Z',
  sessionId: 7, grandfathered: false, acknowledged: false, acknowledgedBy: null, acknowledgedAt: null
};
const KEY = { remote: REMOTE, branch: 'wrap/1-x', headSha: SHA };

/**
 * Slice a top-level function out of source text by brace-matching, so the test
 * runs the real code rather than a copy.
 * @param {string} src - File source text
 * @param {string} decl - Declaration to find
 * @returns {string} The declaration plus its balanced body
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
  return '';
}

/**
 * A fake element: the handful of properties the stranded surfaces touch.
 * @param {string} id
 * @returns {object}
 */
function makeElement(id) {
  const classes = new Set();
  const el = {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    checked: false,
    dataset: {},
    children: [],
    className: '',
    type: '',
    _classes: classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (on ? classes.add(c) : classes.delete(c)))
    },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el); },
    /**
     * The two selectors the stranded code asks of a decision area.
     * @param {string} sel
     * @returns {object|null}
     */
    querySelector(sel) {
      const all = [];
      const walk = (node) => { for (const c of node.children) { all.push(c); walk(c); } };
      walk(el);
      if (sel === '.wrap-decision--stranded') return all.find((c) => /wrap-decision--stranded/.test(c.className)) || null;
      if (sel === 'input[data-options-key="proceedPastStranded"]') {
        return all.find((c) => c.dataset && c.dataset.optionsKey === 'proceedPastStranded') || null;
      }
      return null;
    },
    querySelectorAll() { return []; }
  };
  return el;
}

/**
 * A fake document whose elements are created on first lookup.
 * @returns {{document: object, els: Object<string, object>}}
 */
function makeDocument() {
  const els = {};
  const document = {
    getElementById: (id) => (els[id] = els[id] || makeElement(id)),
    createElement: (tag) => makeElement(tag),
    querySelector: () => null
  };
  return { document, els };
}

// The page's own HTML escape, as landing.js defines it, for sandboxes that
// render with `esc`.
const escSrc = liftFunction(LANDING_SRC, 'function esc(');

describe('shared stranded-wrap helpers (api-helper.js)', () => {
  it('lists each item with its full head SHA and remote', () => {
    const html = helpers.tcStrandedItemsMarkup([ITEM]);
    assert.match(html, new RegExp(SHA));
    assert.match(html, /wrap\/1-x/);
    assert.match(html, /2026-09-16/);
    assert.match(html, /github\.com\/example\/sandbox/);
  });

  it('escapes a branch name, which comes from the repository', () => {
    const html = helpers.tcStrandedItemsMarkup([{ ...ITEM, branch: 'wrap/<img src=x onerror=alert(1)>' }]);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });

  it('says an older record has no head SHA rather than printing null', () => {
    const html = helpers.tcStrandedItemsMarkup([{ ...ITEM, headSha: null, remote: null, grandfathered: true }]);
    assert.match(html, /no head SHA/);
    assert.doesNotMatch(html, /null/);
  });

  it('renders nothing for no items', () => {
    assert.equal(helpers.tcStrandedItemsMarkup([]), '');
    assert.equal(helpers.tcStrandedItemsMarkup(null), '');
  });

  it('copies the keys exactly as listed', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.tcStrandedKeys([ITEM]))), [KEY]);
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.tcStrandedKeys([{ branch: 'wrap/0', remote: undefined }]))),
      [{ remote: null, branch: 'wrap/0', headSha: null }]);
  });
});

describe('wrap options carry the stranded choice (wrap-drawer.js)', () => {
  it('sends proceedPastStranded when the accessor has keys', () => {
    const options = drawer.collectOptionsFromAccessors({ proceedPastStranded: () => [KEY] });
    assert.deepEqual(options, { proceedPastStranded: [KEY] });
  });

  it('sends nothing when no stranded wrap was confirmed, so the wrap is still gated', () => {
    assert.deepEqual(drawer.collectOptionsFromAccessors({ proceedPastStranded: () => [] }), {});
    assert.deepEqual(drawer.collectOptionsFromAccessors({ proceedPastStranded: () => null }), {});
  });

  it('drops malformed keys', () => {
    const options = drawer.collectOptionsFromAccessors({ proceedPastStranded: () => [KEY, null, { remote: REMOTE }, 'wrap/1-x'] });
    assert.deepEqual(options.proceedPastStranded, [KEY]);
  });

  it('gives the choice back from a recorded run, so a reload keeps it for Retry', () => {
    assert.deepEqual(drawer.replayChoicesFromOptions({ proceedPastStranded: [KEY] }).proceedPastStranded, [KEY]);
    assert.deepEqual(drawer.replayChoicesFromOptions({}).proceedPastStranded, []);
  });
});

describe('dashboard: acknowledge and launch (#1539)', () => {
  /**
   * Run the dashboard launch code against a fake fetch.
   * @param {Array<{status: number, body: object}>} responses - Answers in order
   * @returns {object} The sandbox, with `sent` holding each request body
   */
  function sandboxFor(responses) {
    const { document, els } = makeDocument();
    const sent = [];
    const sandbox = {
      document,
      els,
      sent,
      navigated: [],
      state: { projects: [] },
      tcStrandedKeys: helpers.tcStrandedKeys,
      tcStrandedItemsMarkup: helpers.tcStrandedItemsMarkup,
      setConnected: () => {},
      setTimeout: () => {},
      navigateToSession(name) { sandbox.navigated.push(name); },
      async tcFetch(url, opts) {
        sent.push(JSON.parse(opts.body));
        const next = responses.shift();
        return { ok: next.status < 300, status: next.status, json: async () => next.body };
      }
    };
    vm.createContext(sandbox);
    vm.runInContext([
      escSrc,
      'let strandedLaunch = null;',
      liftFunction(LANDING_SRC, 'async function doLaunchProject('),
      liftFunction(LANDING_SRC, 'function openStrandedLaunchModal('),
      liftFunction(LANDING_SRC, 'function closeStrandedLaunchModal('),
      liftFunction(LANDING_SRC, 'function showStrandedLaunchError('),
      liftFunction(LANDING_SRC, 'async function confirmStrandedLaunch('),
      'this.doLaunchProject = doLaunchProject; this.confirmStrandedLaunch = confirmStrandedLaunch;',
      'this.closeStrandedLaunchModal = closeStrandedLaunchModal;'
    ].join('\n'), sandbox);
    return sandbox;
  }

  const refusal = { status: 409, body: { code: 'STRANDED_WRAPS', error: 'Not starting the session', items: [ITEM] } };

  it('opens the dialog with the items instead of a failure toast', async () => {
    const sb = sandboxFor([refusal]);
    await sb.doLaunchProject('proj', 'yolo', 'continue');
    assert.ok(sb.els.strandedLaunchModal._classes.has('open'));
    assert.match(sb.els.strandedLaunchList.innerHTML, /wrap\/1-x/);
    assert.equal(sb.els.toast.textContent, '', 'no failure toast for a refusal the dialog handles');
    assert.deepEqual(sb.navigated, []);
  });

  it('resends the same launch choices with the listed keys, then opens the session', async () => {
    const sb = sandboxFor([refusal, { status: 201, body: { sessionId: 1 } }]);
    await sb.doLaunchProject('proj', 'yolo', 'continue');
    await sb.confirmStrandedLaunch();
    assert.deepEqual(JSON.parse(JSON.stringify(sb.sent[1])),
      { launchMode: 'yolo', continuityMode: 'continue', acknowledgeStranded: [KEY] });
    assert.deepEqual(sb.navigated, ['proj']);
    assert.ok(!sb.els.strandedLaunchModal._classes.has('open'), 'the dialog closes on launch');
  });

  it('keeps the dialog open with the reason when the acknowledgement fails', async () => {
    const sb = sandboxFor([refusal, { status: 404, body: { code: 'NOT_FOUND', error: 'No stranded wrap is listed' } }]);
    await sb.doLaunchProject('proj', null, null);
    await sb.confirmStrandedLaunch();
    assert.ok(sb.els.strandedLaunchModal._classes.has('open'));
    assert.match(sb.els.strandedLaunchError.textContent, /No stranded wrap is listed/);
    assert.equal(sb.els.strandedLaunchConfirmBtn.disabled, false, 'the operator can try again');
  });

  it('shows a newer list when another item appeared before the resend', async () => {
    const newer = { ...ITEM, branch: 'wrap/2-y' };
    const sb = sandboxFor([refusal, { status: 409, body: { code: 'STRANDED_WRAPS', error: 'x', items: [ITEM, newer] } }]);
    await sb.doLaunchProject('proj', null, null);
    await sb.confirmStrandedLaunch();
    assert.match(sb.els.strandedLaunchList.innerHTML, /wrap\/2-y/);
    assert.equal(sb.els.strandedLaunchConfirmBtn.disabled, false);
  });

  it('does nothing when Cancel was pressed first', async () => {
    const sb = sandboxFor([refusal]);
    await sb.doLaunchProject('proj', null, null);
    sb.closeStrandedLaunchModal();
    await sb.confirmStrandedLaunch();
    assert.equal(sb.sent.length, 1);
  });

  it('is wired into the page', () => {
    assert.match(INDEX_HTML, /id="strandedLaunchModal"/);
    assert.match(UI_SRC, /\$\('strandedLaunchConfirmBtn'\)\.addEventListener\('click', confirmStrandedLaunch\)/);
    assert.match(UI_SRC, /\$\('strandedLaunchCancelBtn'\)\.addEventListener\('click', closeStrandedLaunchModal\)/);
  });
});

describe('dashboard: wrap anyway (#1540)', () => {
  /**
   * Run the dashboard wrap modal against a fake apiMutate.
   * @param {Array<object|null>} answers - apiMutate results in order; null is a refusal
   * @param {Array<object>} refusals - `{code, body}` for each null answer
   * @returns {object} The sandbox
   */
  function sandboxFor(answers, refusals) {
    const { document, els } = makeDocument();
    const sent = [];
    const api = {};
    const sandbox = {
      document, els, sent, api,
      state: { config: {} },
      tcStrandedKeys: helpers.tcStrandedKeys,
      tcStrandedItemsMarkup: helpers.tcStrandedItemsMarkup,
      async apiMutate(url, method, body) {
        sent.push(body);
        const answer = answers.shift();
        if (answer === null) {
          const r = refusals.shift();
          api.lastError = r.body.error;
          api.lastErrorCode = r.code;
          api.lastBody = r.body;
        }
        return answer;
      },
      awaitDashboardWrapFailure: async () => null,
      loadProjects: async () => {}
    };
    vm.createContext(sandbox);
    vm.runInContext([
      escSrc,
      'let wrapTarget = null; let wrapInFlight = false;',
      liftFunction(LANDING_SRC, 'function openWrapModal('),
      'let wrapStrandedItems = null;',
      liftFunction(LANDING_SRC, 'function showWrapStranded('),
      liftFunction(LANDING_SRC, 'function syncWrapConfirmButton('),
      liftFunction(LANDING_SRC, 'function closeWrapModal('),
      liftFunction(LANDING_SRC, 'async function confirmWrap('),
      'this.openWrapModal = openWrapModal; this.confirmWrap = confirmWrap;'
    ].join('\n'), sandbox);
    return sandbox;
  }

  const refusal = { code: 'STRANDED_WRAPS', body: { code: 'STRANDED_WRAPS', error: 'Not starting the wrap', items: [ITEM] } };

  it('lists the items and holds Wrap until "Wrap anyway" is ticked', async () => {
    const sb = sandboxFor([null], [refusal]);
    sb.openWrapModal('proj');
    await sb.confirmWrap();
    assert.ok(!sb.els.wrapStranded._classes.has('hidden'));
    assert.match(sb.els.wrapStrandedList.innerHTML, /wrap\/1-x/);
    assert.equal(sb.els.wrapConfirmBtn.disabled, true);
    assert.ok(sb.els.wrapError._classes.has('hidden'), 'the list replaces a bare refusal');
    await sb.confirmWrap();
    assert.equal(sb.sent.length, 1, 'an unticked confirmation sends nothing');
  });

  it('sends the listed keys once ticked', async () => {
    const sb = sandboxFor([null, { runId: 'r1' }], [refusal]);
    sb.openWrapModal('proj');
    await sb.confirmWrap();
    sb.els.wrapStrandedConfirm.checked = true;
    vm.runInContext('syncWrapConfirmButton()', sb);
    assert.equal(sb.els.wrapConfirmBtn.disabled, false);
    await sb.confirmWrap();
    assert.deepEqual(JSON.parse(JSON.stringify(sb.sent[1])), { options: { proceedPastStranded: [KEY] } });
  });

  it('starts unticked and empty every time the modal opens', async () => {
    const sb = sandboxFor([null], [refusal]);
    sb.openWrapModal('proj');
    await sb.confirmWrap();
    sb.els.wrapStrandedConfirm.checked = true;
    sb.openWrapModal('proj');
    assert.ok(sb.els.wrapStranded._classes.has('hidden'));
    assert.equal(sb.els.wrapStrandedConfirm.checked, false);
    assert.equal(sb.els.wrapConfirmBtn.disabled, false);
  });

  it('is wired into the page', () => {
    assert.match(INDEX_HTML, /id="wrapStrandedConfirm"/);
    assert.match(UI_SRC, /\$\('wrapStrandedConfirm'\)\.addEventListener\('change', syncWrapConfirmButton\)/);
  });
});

describe('session page: wrap anyway, and Retry (#1540)', () => {
  /**
   * Run the session page's stranded pieces with a fake DOM.
   * @returns {object} The sandbox
   */
  function sandboxFor() {
    const { document, els } = makeDocument();
    const api = {};
    const posted = [];
    const sandbox = {
      document, els, api, posted,
      window: { tcWrapDrawerHelpers: drawer },
      tcStrandedKeys: helpers.tcStrandedKeys,
      tcStrandedItemsMarkup: helpers.tcStrandedItemsMarkup,
      phase: 'idle',
      wrapRunState() { return { phase: sandbox.phase }; },
      dispatchWrapRun() { return {}; },
      currentWrapPassword: '',
      async postWrap(body) { posted.push(body); return true; }
    };
    vm.createContext(sandbox);
    vm.runInContext([
      'let wrapReleaseChoice = ""; let wrapBumpLevel = ""; let wrapUntrackState = ""; let wrapSkipPreflight = false;',
      'let wrapPathDecisions = {}; let wrapSkippedAiSteps = {}; let wrapProceedPastStranded = [];',
      'let lastRefusedStrandedItems = null; let wrapDrawerStrandedItems = null; let wrapModalStrandedItems = null;',
      liftFunction(SESSION_SRC, 'function wrapStartInFlight('),
      liftFunction(SESSION_SRC, 'function showWrapModalStranded('),
      liftFunction(SESSION_SRC, 'function strandedWrapNotice('),
      liftFunction(SESSION_SRC, 'function wrapModalNeedsStrandedConfirm('),
      liftFunction(SESSION_SRC, 'function syncWrapModalConfirm('),
      liftFunction(SESSION_SRC, 'function renderWrapDrawerStranded('),
      liftFunction(SESSION_SRC, 'function adoptWrapRunChoices('),
      liftFunction(SESSION_SRC, 'async function retryWrap('),
      'this.get = (name) => eval(name); this.set = (name, v) => eval(`${name} = v`);'
    ].join('\n'), sandbox);
    return sandbox;
  }

  it('holds Wrap in the modal until the listed items are confirmed', () => {
    const sb = sandboxFor();
    vm.runInContext('showWrapModalStranded(this.items)', Object.assign(sb, { items: [ITEM] }));
    assert.equal(sb.els.wrapConfirmBtn.disabled, true);
    assert.match(sb.els.wrapStrandedText.textContent, /still hold the next launch/);
    sb.els.wrapStrandedConfirm.checked = true;
    vm.runInContext('syncWrapModalConfirm()', sb);
    assert.equal(sb.els.wrapConfirmBtn.disabled, false);
    vm.runInContext('showWrapModalStranded(null)', sb);
    assert.equal(sb.els.wrapStrandedConfirm.checked, false);
    assert.equal(sb.get('wrapModalStrandedItems'), null);
  });

  it('replays the confirmation on Retry', async () => {
    const sb = sandboxFor();
    sb.set('wrapProceedPastStranded', [KEY]);
    await vm.runInContext('retryWrap()', sb);
    assert.deepEqual(JSON.parse(JSON.stringify(sb.posted[0].options)), { proceedPastStranded: [KEY] });
  });

  it('lists a Retry refusal in the drawer, and its ticked box covers the new list on the next Retry', async () => {
    const sb = sandboxFor();
    const newer = { ...ITEM, branch: 'wrap/2-y' };
    sb.set('wrapProceedPastStranded', [KEY]);
    vm.runInContext('renderWrapDrawerStranded(this.items)', Object.assign(sb, { items: [ITEM, newer] }));
    const decision = sb.els.wrapDrawerDecision;
    assert.ok(!decision._classes.has('hidden'));
    const box = decision.querySelector('input[data-options-key="proceedPastStranded"]');
    assert.ok(box, 'the drawer offers the confirmation');

    await vm.runInContext('retryWrap()', sb);
    assert.deepEqual(JSON.parse(JSON.stringify(sb.posted[0].options.proceedPastStranded)), [KEY],
      'an unticked box leaves the earlier choice, which the server refuses again');

    box.checked = true;
    await vm.runInContext('retryWrap()', sb);
    assert.deepEqual(JSON.parse(JSON.stringify(sb.posted[1].options.proceedPastStranded)),
      [KEY, { remote: REMOTE, branch: 'wrap/2-y', headSha: SHA }]);
    assert.equal(JSON.parse(JSON.stringify(sb.get('wrapProceedPastStranded'))).length, 2, 'and later Retries keep it');
  });

  it('replaces the drawer list rather than stacking a second one', () => {
    const sb = sandboxFor();
    vm.runInContext('renderWrapDrawerStranded(this.items); renderWrapDrawerStranded(this.items);', Object.assign(sb, { items: [ITEM] }));
    assert.equal(sb.els.wrapDrawerDecision.children.length, 1);
  });

  it('takes the choice back from the run it follows after a reload', () => {
    const sb = sandboxFor();
    vm.runInContext('adoptWrapRunChoices({ proceedPastStranded: this.keys })', Object.assign(sb, { keys: [KEY] }));
    assert.deepEqual(JSON.parse(JSON.stringify(sb.get('wrapProceedPastStranded'))), [KEY]);
  });

  it('carries the choice from the modal into the first POST, and the refusal back into the modal and drawer', () => {
    const confirm = liftFunction(SESSION_SRC, 'async function confirmWrap(');
    assert.match(confirm, /proceedPastStranded: \(\) => wrapProceedPastStranded/);
    assert.match(confirm, /wrapProceedPastStranded = Array\.isArray\(wrapModalStrandedItems\)/);
    assert.match(confirm, /showWrapModalStranded\(lastRefusedStrandedItems\)/);
    const post = liftFunction(SESSION_SRC, 'async function postWrap(');
    assert.match(post, /api\.lastErrorCode === 'STRANDED_WRAPS'/);
    assert.match(SESSION_SRC, /if \(lastRefusedStrandedItems\) renderWrapDrawerStranded\(lastRefusedStrandedItems\)/);
    assert.match(SESSION_HTML, /id="wrapStrandedConfirm"/);
    assert.match(SESSION_SRC, /\$\('wrapStrandedConfirm'\)\.addEventListener\('change', syncWrapModalConfirm\)/);
  });
});

describe('dashboard card: stranded badge and detail row (#1541)', () => {
  /**
   * Run the card helpers.
   * @returns {object} The sandbox
   */
  function sandboxFor() {
    const sandbox = {
      tcStrandedItemsMarkup: helpers.tcStrandedItemsMarkup
    };
    vm.createContext(sandbox);
    vm.runInContext([
      escSrc,
      liftFunction(UI_SRC, 'function renderStrandedBadge('),
      'const strandedItemsCache = {};',
      liftFunction(UI_SRC, 'function strandedSig('),
      liftFunction(UI_SRC, 'function renderStrandedDetail('),
      'this.badge = renderStrandedBadge; this.detail = renderStrandedDetail; this.cache = strandedItemsCache; this.sig = strandedSig;'
    ].join('\n'), sandbox);
    return sandbox;
  }

  const counts = (over) => ({ total: 0, unacknowledged: 0, grandfathered: 0, blocking: 0, ...over });

  it('shows a badge with the blocking count', () => {
    const sb = sandboxFor();
    const html = sb.badge({ name: 'p', stranded: counts({ total: 2, unacknowledged: 2, blocking: 2 }) });
    assert.match(html, /badge-stranded/);
    assert.match(html, /2 stranded/);
  });

  it('shows no badge when every item is acknowledged or older, or the count is unknown', () => {
    const sb = sandboxFor();
    assert.equal(sb.badge({ name: 'p', stranded: counts({ total: 2, unacknowledged: 1, grandfathered: 1 }) }), '');
    assert.equal(sb.badge({ name: 'p', stranded: null, strandedError: 'locked' }), '');
    assert.equal(sb.badge({ name: 'p' }), '');
  });

  it('describes each kind of item in the detail row', () => {
    const sb = sandboxFor();
    const html = sb.detail({ name: 'p', stranded: counts({ total: 4, unacknowledged: 3, grandfathered: 2, blocking: 1 }) });
    assert.match(html, /1 unacknowledged \(hold the next launch\)/);
    assert.match(html, /1 acknowledged/);
    assert.match(html, /2 older records \(never blocks\)/);
  });

  it('adds the list once fetched for the same counts, and not for stale counts', () => {
    const sb = sandboxFor();
    const project = { name: 'p', stranded: counts({ total: 1, unacknowledged: 1, blocking: 1 }) };
    sb.cache.p = { sig: sb.sig(project), items: [ITEM], error: null, loading: false };
    assert.match(sb.detail(project), new RegExp(SHA));
    const moved = { name: 'p', stranded: counts({ total: 2, unacknowledged: 2, blocking: 2 }) };
    assert.doesNotMatch(sb.detail(moved), new RegExp(SHA));
  });

  it('says the count could not be read rather than hiding the row', () => {
    const sb = sandboxFor();
    assert.match(sb.detail({ name: 'p', stranded: null, strandedError: 'database is locked' }), /could not be read: database is locked/);
  });

  it('shows nothing for a project with nothing recorded', () => {
    const sb = sandboxFor();
    assert.equal(sb.detail({ name: 'p', stranded: counts({}) }), '');
  });

  it('is on the card and in its detail panel', () => {
    assert.match(liftFunction(UI_SRC, 'function renderCard('), /\$\{strandedBadge\}/);
    assert.match(liftFunction(UI_SRC, 'function renderCardDetail('), /renderStrandedDetail\(project\)/);
  });
});
