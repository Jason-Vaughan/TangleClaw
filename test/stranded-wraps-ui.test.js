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

  it('marks an acknowledged item, and who acknowledged it', () => {
    const html = helpers.tcStrandedItemsMarkup([{ ...ITEM, acknowledged: true, acknowledgedBy: '<op>' }]);
    assert.match(html, /acknowledged by &lt;op&gt;/);
    assert.match(helpers.tcStrandedItemsMarkup([{ ...ITEM, acknowledged: true }]), /stranded-acked">acknowledged</);
    assert.doesNotMatch(helpers.tcStrandedItemsMarkup([ITEM]), /stranded-acked/);
  });

  it('renders nothing for no items', () => {
    assert.equal(helpers.tcStrandedItemsMarkup([]), '');
    assert.equal(helpers.tcStrandedItemsMarkup(null), '');
  });

  it('says a wrap past the items acknowledges nothing, in the singular and plural', () => {
    assert.match(helpers.tcStrandedWrapNotice(1), /^1 earlier wrap branch was .* it will still hold the next launch\.$/);
    assert.match(helpers.tcStrandedWrapNotice(2), /^2 earlier wrap branches were .* they will still hold the next launch\.$/);
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
      tcStrandedWrapNotice: helpers.tcStrandedWrapNotice,
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
      tcStrandedWrapNotice: helpers.tcStrandedWrapNotice,
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
    // #1708: the dialog's keep-running answer rides every wrap, untick included.
    assert.deepEqual(JSON.parse(JSON.stringify(sb.sent[1])), { options: { proceedPastStranded: [KEY], keepSessionRunning: false } });
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
      tcStrandedWrapNotice: helpers.tcStrandedWrapNotice,
      phase: 'idle',
      wrapRunState() { return { phase: sandbox.phase }; },
      dispatchWrapRun() { return {}; },
      currentWrapPassword: '',
      async postWrap(body) { posted.push(body); return true; }
    };
    vm.createContext(sandbox);
    vm.runInContext([
      'let wrapReleaseChoice = ""; let wrapBumpLevel = ""; let wrapUntrackState = ""; let wrapSkipPreflight = false;',
      'let wrapPathDecisions = {}; let wrapPathDecisionBasis = {}; let wrapSkippedAiSteps = {}; let wrapProceedPastStranded = [];',
      // The page's own initial value (#1708): no keep-running choice made yet.
      'let wrapKeepRunning = null;',
      'let lastRefusedStrandedItems = null; let wrapDrawerStrandedItems = null; let wrapModalStrandedItems = null;',
      liftFunction(SESSION_SRC, 'function wrapStartInFlight('),
      liftFunction(SESSION_SRC, 'function showWrapModalStranded('),
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
      liftFunction(UI_SRC, 'function strandedItemActions('),
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

  describe('ensureStrandedItems()', () => {
    /**
     * Run the fetcher with a controllable fetch.
     * @param {Function} fetchImpl - `tcFetch` stand-in
     * @returns {object} The sandbox, counting renders in `renders`
     */
    function fetcherFor(fetchImpl) {
      const sandbox = {
        fetches: [],
        renders: 0,
        async tcFetch(url) { sandbox.fetches.push(url); return fetchImpl(url); },
        renderProjects() { sandbox.renders += 1; }
      };
      vm.createContext(sandbox);
      vm.runInContext([
        'const strandedItemsCache = {};',
        liftFunction(UI_SRC, 'function strandedSig('),
        liftFunction(UI_SRC, 'async function ensureStrandedItems('),
        'this.ensure = ensureStrandedItems; this.cache = strandedItemsCache;'
      ].join('\n'), sandbox);
      return sandbox;
    }
    const project = { name: 'p w', stranded: counts({ total: 1, unacknowledged: 1, blocking: 1 }) };
    const ok = (items) => async () => ({ ok: true, status: 200, json: async () => ({ items }) });

    it('fetches the list once for the current counts, then re-renders', async () => {
      const sb = fetcherFor(ok([ITEM]));
      await sb.ensure(project);
      assert.deepEqual(sb.fetches, ['/api/projects/p%20w/stranded-wraps']);
      assert.equal(sb.cache['p w'].items.length, 1);
      assert.equal(sb.cache['p w'].loading, false);
      assert.equal(sb.renders, 1);
      await sb.ensure(project);
      assert.equal(sb.fetches.length, 1, 'the same counts do not fetch again');
    });

    it('fetches again when the counts change', async () => {
      const sb = fetcherFor(ok([ITEM]));
      await sb.ensure(project);
      await sb.ensure({ ...project, stranded: counts({ total: 2, unacknowledged: 2, blocking: 2 }) });
      assert.equal(sb.fetches.length, 2);
    });

    it('keeps a refused or failed fetch as an error, never as an empty list', async () => {
      const refused = fetcherFor(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Project "p w" not found' }) }));
      await refused.ensure(project);
      assert.equal(refused.cache['p w'].items, null);
      assert.match(refused.cache['p w'].error, /not found/);
      const thrown = fetcherFor(async () => { throw new Error('Failed to fetch'); });
      await thrown.ensure(project);
      assert.equal(thrown.cache['p w'].error, 'Failed to fetch');
      assert.equal(thrown.renders, 1);
    });

    it('drops an answer for counts that changed while it was out', async () => {
      let release;
      const sb = fetcherFor(() => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ items: [ITEM] }) }); }));
      const first = sb.ensure(project);
      const moved = { ...project, stranded: counts({ total: 2, unacknowledged: 2, blocking: 2 }) };
      const firstRelease = release;
      const second = sb.ensure(moved);
      firstRelease();
      await first;
      assert.equal(sb.cache['p w'].sig, JSON.stringify(moved.stranded), 'the older answer does not overwrite the newer fetch');
      assert.equal(sb.cache['p w'].loading, true);
      release();
      await second;
      assert.equal(sb.cache['p w'].loading, false);
    });

    it('does nothing for a project with nothing recorded, or no project', async () => {
      const sb = fetcherFor(ok([]));
      await sb.ensure({ name: 'p', stranded: counts({}) });
      await sb.ensure({ name: 'p', stranded: null });
      await sb.ensure(undefined);
      assert.equal(sb.fetches.length, 0);
    });
  });

  it('is on the card and in its detail panel', () => {
    assert.match(liftFunction(UI_SRC, 'function renderCard('), /\$\{strandedBadge\}/);
    assert.match(liftFunction(UI_SRC, 'function renderCardDetail('), /renderStrandedDetail\(project\)/);
  });
});

describe('dashboard card: GitHub check badges, row and Check now (#1542, #1543)', () => {
  const AT = '2026-09-16T10:00:00.000Z';
  const LATER = '2026-09-16T11:00:00.000Z';
  const counts = (github, over) => ({ total: 0, unacknowledged: 0, grandfathered: 0, blocking: 0, github, ...over });
  const gh = (over) => ({ state: 'ok', lastOkAt: AT, lastAttemptAt: AT, reason: null, redCi: 0, noPr: 0, unchecked: 0, ...over });

  /**
   * Run the card's GitHub helpers, with a controllable request.
   * @param {Function} [mutate] - `apiMutate` stand-in
   * @returns {object} The sandbox
   */
  function sandboxFor(mutate) {
    const sandbox = {
      requests: [],
      renders: 0,
      loads: 0,
      api: { lastError: null },
      async apiMutate(url, method, body) { sandbox.requests.push({ url, method, body }); return mutate ? mutate(sandbox) : {}; },
      renderProjects() { sandbox.renders += 1; },
      async loadProjects() { sandbox.loads += 1; }
    };
    vm.createContext(sandbox);
    vm.runInContext([
      escSrc,
      liftFunction(UI_SRC, 'function strandedTime('),
      liftFunction(UI_SRC, 'function renderStrandedGithubBadge('),
      'const strandedItemsCache = {};',
      'const strandedCheckState = {};',
      liftFunction(UI_SRC, 'function strandedSig('),
      liftFunction(UI_SRC, 'function strandedFindingsMarkup('),
      liftFunction(UI_SRC, 'function renderStrandedGithubDetail('),
      liftFunction(UI_SRC, 'async function checkStrandedNow('),
      'this.badge = renderStrandedGithubBadge; this.detail = renderStrandedGithubDetail;',
      'this.cache = strandedItemsCache; this.sig = strandedSig; this.checkNow = checkStrandedNow; this.run = strandedCheckState;',
      'this.time = strandedTime;'
    ].join('\n'), sandbox);
    return sandbox;
  }

  describe('badges', () => {
    it('shows red CI and no-PR counts, with the time of the check, and never as a launch hold', () => {
      const sb = sandboxFor();
      const html = sb.badge({ name: 'p', stranded: counts(gh({ redCi: 2, noPr: 1 })) });
      assert.match(html, /badge-github-red[^>]*>&#10005; 2 red CI</);
      assert.match(html, /badge-github-nopr[^>]*>1 no PR</);
      assert.ok(html.includes(`as of ${sb.time(AT)}`));
      assert.match(html, /Never holds a launch/);
      assert.doesNotMatch(html, /GitHub \?/);
    });

    it('shows "GitHub ?" with the time and reason when the latest check failed', () => {
      const sb = sandboxFor();
      const html = sb.badge({ name: 'p', stranded: counts(gh({ state: 'failed', lastAttemptAt: LATER, reason: 'gh is not installed' })) });
      assert.match(html, /badge-github-unknown[^>]*>GitHub \?</);
      assert.ok(html.includes(`at ${sb.time(LATER)} (gh is not installed)`));
    });

    it('keeps older findings beside a failed check, marked with their own time', () => {
      const sb = sandboxFor();
      const html = sb.badge({ name: 'p', stranded: counts(gh({ state: 'failed', lastAttemptAt: LATER, reason: 'offline', redCi: 1 })) });
      assert.match(html, /1 red CI/);
      assert.match(html, /GitHub \?/);
      assert.ok(html.includes(`as of ${sb.time(AT)}`));
    });

    it('shows nothing for a clean check, no check, or nothing to check', () => {
      const sb = sandboxFor();
      assert.equal(sb.badge({ name: 'p', stranded: counts(gh()) }), '');
      assert.equal(sb.badge({ name: 'p', stranded: counts(gh({ state: 'never', lastOkAt: null, lastAttemptAt: null })) }), '');
      assert.equal(sb.badge({ name: 'p', stranded: counts(gh({ state: 'none', reason: 'no origin remote' })) }), '');
      assert.equal(sb.badge({ name: 'p', stranded: null }), '');
    });

    it('escapes the reason, which comes from gh', () => {
      const sb = sandboxFor();
      const html = sb.badge({ name: 'p', stranded: counts(gh({ state: 'failed', reason: '<img src=x>"' })) });
      assert.doesNotMatch(html, /<img/);
    });
  });

  describe('detail row', () => {
    it('says when it last checked and that nothing was found, with Check now', () => {
      const sb = sandboxFor();
      const html = sb.detail({ name: 'p', stranded: counts(gh()) });
      assert.ok(html.includes(`checked ${sb.time(AT)}, nothing found`));
      assert.match(html, /onclick="event.stopPropagation\(\); checkStrandedNow\('p'\)">Check now</);
    });

    it('says a failed check failed, when and why, and when the last good one was', () => {
      const sb = sandboxFor();
      const html = sb.detail({ name: 'p', stranded: counts(gh({ state: 'failed', lastAttemptAt: LATER, reason: 'HTTP 502' })) });
      assert.ok(html.includes(`couldn&#39;t check at ${sb.time(LATER)} (HTTP 502); last successful check ${sb.time(AT)}`));
      assert.match(html, /detail-row-warn/);
    });

    it('says "not checked yet" when no check is on record', () => {
      const sb = sandboxFor();
      assert.match(sb.detail({ name: 'p', stranded: counts(gh({ state: 'never', lastOkAt: null, lastAttemptAt: null })) }), /not checked yet/);
    });

    it('hides the row for a project with nothing to check and nothing recorded, and has no button when a check is not possible', () => {
      const sb = sandboxFor();
      assert.equal(sb.detail({ name: 'p', stranded: counts(gh({ state: 'none', reason: 'no origin remote' })) }), '');
      const html = sb.detail({ name: 'p', stranded: counts(gh({ state: 'none', reason: 'no origin remote' }), { total: 1, unacknowledged: 1, blocking: 1 }) });
      assert.match(html, /not possible: no origin remote/);
      assert.doesNotMatch(html, /Check now/);
    });

    it('lists the fetched findings for the same counts, with a link for a red PR', () => {
      const sb = sandboxFor();
      const project = { name: 'p', stranded: counts(gh({ redCi: 1, noPr: 1, unchecked: 2 })) };
      sb.cache.p = {
        sig: sb.sig(project), items: [], error: null, loading: false,
        github: { findings: [
          { kind: 'red-ci', branch: 'wrap/2-y', prNumber: 9, prUrl: 'https://github.com/example/sandbox/pull/9' },
          { kind: 'no-pr', branch: 'wrap/<3>', prNumber: null, prUrl: null }
        ] }
      };
      const html = sb.detail(project);
      assert.match(html, /1 wrap PR with failing checks, 1 wrap branch with no PR \(never blocks\)/);
      assert.match(html, /2 more wrap branches were not looked up/);
      assert.match(html, /<a href="https:\/\/github.com\/example\/sandbox\/pull\/9"[^>]*>PR #9<\/a> has failing checks/);
      assert.match(html, /wrap\/&lt;3&gt;<\/code>: on GitHub with no pull request/);
      const stale = { name: 'p', stranded: counts(gh({ redCi: 2 })) };
      assert.doesNotMatch(sb.detail(stale), /pull\/9/);
    });

    it('never links a PR URL that is not on github.com', () => {
      const sb = sandboxFor();
      const project = { name: 'p', stranded: counts(gh({ redCi: 1 })) };
      sb.cache.p = { sig: sb.sig(project), items: [], error: null, loading: false,
        github: { findings: [{ kind: 'red-ci', branch: 'wrap/2-y', prNumber: 9, prUrl: 'javascript:alert(1)' }] } };
      const html = sb.detail(project);
      assert.doesNotMatch(html, /<a /);
      assert.match(html, /PR #9 has failing checks/);
    });
  });

  describe('Check now', () => {
    it('posts the check, shows "Checking…" only while it is out, then reloads the list', async () => {
      let seenDuring = null;
      const sb = sandboxFor((box) => {
        seenDuring = box.detail({ name: 'p w', stranded: counts(gh()) });
        return { check: { state: 'ok' } };
      });
      await sb.checkNow('p w');
      assert.deepEqual(JSON.parse(JSON.stringify(sb.requests)), [{ url: '/api/projects/p%20w/stranded-wraps/check', method: 'POST', body: {} }]);
      assert.match(seenDuring, /disabled[^>]*>Checking…</);
      assert.equal(sb.loads, 1);
      assert.match(sb.detail({ name: 'p w', stranded: counts(gh()) }), />Check now</);
    });

    it('says a failed request failed, in the row, until the next one', async () => {
      const sb = sandboxFor((box) => { box.api.lastError = 'Connection lost.'; return null; });
      await sb.checkNow('p');
      assert.equal(sb.loads, 0);
      assert.match(sb.detail({ name: 'p', stranded: counts(gh()) }), /Check now failed: Connection lost\./);
    });

    it('ignores a second press while one is out', async () => {
      let release;
      const sb = sandboxFor(() => new Promise((r) => { release = () => r({}); }));
      const first = sb.checkNow('p');
      await sb.checkNow('p');
      release();
      await first;
      assert.equal(sb.requests.length, 1);
    });
  });

  it('fetches the list for a card with findings and no local items', async () => {
    const fetches = [];
    const sandbox = {
      async tcFetch(url) { fetches.push(url); return { ok: true, status: 200, json: async () => ({ items: [], github: { findings: [] } }) }; },
      renderProjects() {}
    };
    vm.createContext(sandbox);
    vm.runInContext([
      'const strandedItemsCache = {};',
      liftFunction(UI_SRC, 'function strandedSig('),
      liftFunction(UI_SRC, 'async function ensureStrandedItems('),
      'this.ensure = ensureStrandedItems; this.cache = strandedItemsCache;'
    ].join('\n'), sandbox);
    await sandbox.ensure({ name: 'p', stranded: counts(gh({ noPr: 1 })) });
    assert.equal(fetches.length, 1);
    assert.equal(JSON.stringify(sandbox.cache.p.github), '{"findings":[]}');
    await sandbox.ensure({ name: 'q', stranded: counts(gh()) });
    assert.equal(fetches.length, 1, 'a clean card fetches nothing');
  });

  it('is on the card and in its detail panel, and styled', () => {
    assert.match(liftFunction(UI_SRC, 'function renderCard('), /\$\{githubBadge\}/);
    assert.match(liftFunction(UI_SRC, 'function renderCardDetail('), /renderStrandedGithubDetail\(project\)/);
    const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
    for (const cls of ['badge-github-red', 'badge-github-nopr', 'badge-github-unknown']) {
      assert.match(css, new RegExp(`\\.${cls}\\s*\\{`), `${cls} is styled`);
    }
  });
});

describe('dashboard card: per-item actions and their dialog (#1545)', () => {
  const OLDER = { ...ITEM, branch: 'wrap/0-old', headSha: null, remote: null, grandfathered: true };
  const PR_URL = 'https://github.com/example/sandbox/pull/42';

  /**
   * Run the card's action code against a fake DOM, with a controllable request.
   * @param {Function} [mutate] - `apiMutate` stand-in
   * @returns {object} The sandbox
   */
  function sandboxFor(mutate) {
    const { document, els } = makeDocument();
    const sandbox = {
      document,
      els,
      requests: [],
      loads: 0,
      api: { lastError: null },
      tcStrandedItemsMarkup: helpers.tcStrandedItemsMarkup,
      tcStrandedKeys: helpers.tcStrandedKeys,
      async apiMutate(url, method, body) { sandbox.requests.push({ url, method, body }); return mutate ? mutate(sandbox) : { ok: true }; },
      async loadProjects() { sandbox.loads += 1; }
    };
    vm.createContext(sandbox);
    vm.runInContext([
      escSrc,
      'const strandedItemsCache = {};',
      'let strandedAction = null;',
      liftFunction(UI_SRC, 'function strandedItemActions('),
      liftFunction(UI_SRC, 'function openStrandedAction('),
      liftFunction(UI_SRC, 'function closeStrandedAction('),
      liftFunction(UI_SRC, 'async function confirmStrandedAction('),
      'this.actions = strandedItemActions; this.open = openStrandedAction; this.close = closeStrandedAction;',
      'this.confirm = confirmStrandedAction; this.cache = strandedItemsCache; this.held = () => strandedAction;'
    ].join('\n'), sandbox);
    return sandbox;
  }

  const plain = (v) => JSON.parse(JSON.stringify(v));

  it('offers Acknowledge and Open PR on an open item, by position, never sending on the press', () => {
    const sb = sandboxFor();
    const items = [OLDER, ITEM];
    const html = sb.actions('p', items, ITEM);
    assert.match(html, /openStrandedAction\('p', 'ack', 1\)">Acknowledge</);
    assert.match(html, /openStrandedAction\('p', 'open-pr', 1\)">Open PR</);
    assert.doesNotMatch(html, /wrap\/1-x/, 'the branch name never goes into the handler');
    assert.equal(sb.requests.length, 0);
  });

  it('drops Acknowledge once acknowledged and Open PR once a PR was opened here', () => {
    const sb = sandboxFor();
    const acked = { ...ITEM, acknowledged: true };
    assert.doesNotMatch(sb.actions('p', [acked], acked), /Acknowledge/);
    const done = { ...ITEM, acknowledged: true, prOpened: { url: PR_URL, by: null, at: 'x' } };
    assert.equal(sb.actions('p', [done], done), '');
    assert.equal(sb.actions('p', [ITEM], { ...ITEM }), '', 'an item not in the list gets nothing');
  });

  it('shows the items with their actions in the card row, and a PR opened here', () => {
    const html = helpers.tcStrandedItemsMarkup([{ ...ITEM, prOpened: { url: PR_URL, by: 'rosie', at: 'x' } }], () => '<i>act</i>');
    assert.match(html, /PR opened \(<a href="https:\/\/github\.com\/example\/sandbox\/pull\/42"[^>]*>#42<\/a>\) by rosie/);
    assert.match(html, /<i>act<\/i><\/li>/);
    const notGithub = helpers.tcStrandedItemsMarkup([{ ...ITEM, prOpened: { url: 'javascript:alert(1)', by: null, at: 'x' } }]);
    assert.match(notGithub, /PR opened/);
    assert.doesNotMatch(notGithub, /<a /, 'only a github.com URL becomes a link');
    assert.doesNotMatch(helpers.tcStrandedItemsMarkup([ITEM]), /PR opened/);
  });

  it('explains Open PR, the default-branch target and manual branch deletion, before anything is sent', () => {
    const sb = sandboxFor();
    sb.cache.p = { items: [ITEM] };
    sb.open('p', 'open-pr', 0);
    assert.ok(sb.els.strandedActionModal._classes.has('open'));
    assert.equal(sb.els.strandedActionTitle.textContent, 'Open a pull request');
    assert.match(sb.els.strandedActionText.textContent, /wrap\/1-x, into the repository's default branch/);
    assert.match(sb.els.strandedActionText.textContent, /not merged/);
    assert.match(sb.els.strandedActionNote.textContent, /git push origin --delete wrap\/1-x \(TangleClaw does not delete branches\)/);
    assert.match(sb.els.strandedActionItem.innerHTML, new RegExp(SHA));
    assert.equal(sb.els.strandedActionConfirmBtn.textContent, 'Open pull request');
    assert.equal(sb.requests.length, 0);
  });

  it('words Acknowledge for an older record as never having held a launch', () => {
    const sb = sandboxFor();
    sb.cache.p = { items: [OLDER] };
    sb.open('p', 'ack', 0);
    assert.equal(sb.els.strandedActionConfirmBtn.textContent, 'Acknowledge');
    assert.match(sb.els.strandedActionText.textContent, /older record and never held a launch/);
  });

  it('does nothing for an index or action it does not know', () => {
    const sb = sandboxFor();
    sb.cache.p = { items: [ITEM] };
    sb.open('p', 'ack', 5);
    sb.open('p', 'delete-branch', 0);
    sb.open('q', 'ack', 0);
    assert.equal(sb.held(), null);
    assert.equal(sb.els.strandedActionModal, undefined, 'the dialog was never touched');
  });

  it('sends Open PR with confirm and the listed key, then closes and reloads the list', async () => {
    const sb = sandboxFor();
    sb.cache['p w'] = { items: [ITEM] };
    sb.open('p w', 'open-pr', 0);
    await sb.confirm();
    assert.deepEqual(plain(sb.requests), [{
      url: '/api/projects/p%20w/stranded-wraps/open-pr', method: 'POST', body: { ...KEY, confirm: true }
    }]);
    assert.ok(!sb.els.strandedActionModal._classes.has('open'));
    assert.equal(sb.cache['p w'], undefined, 'the list is fetched again with the PR on it');
    assert.equal(sb.loads, 1);
  });

  it('sends Acknowledge with the listed key only', async () => {
    const sb = sandboxFor();
    sb.cache.p = { items: [OLDER] };
    sb.open('p', 'ack', 0);
    await sb.confirm();
    assert.deepEqual(plain(sb.requests), [{
      url: '/api/projects/p/stranded-wraps/ack', method: 'POST', body: { remote: null, branch: 'wrap/0-old', headSha: null }
    }]);
  });

  it('shows the server\'s reason in the dialog on failure, and keeps it open to try again', async () => {
    const sb = sandboxFor((box) => { box.api.lastError = 'wrap/1-x is no longer on origin'; return null; });
    sb.cache.p = { items: [ITEM] };
    sb.open('p', 'open-pr', 0);
    await sb.confirm();
    assert.ok(sb.els.strandedActionModal._classes.has('open'));
    assert.ok(!sb.els.strandedActionError._classes.has('hidden'));
    assert.equal(sb.els.strandedActionError.textContent, 'wrap/1-x is no longer on origin');
    assert.equal(sb.els.strandedActionConfirmBtn.disabled, false);
    assert.equal(sb.els.strandedActionConfirmBtn.textContent, 'Open pull request');
    assert.equal(sb.loads, 0);
    assert.ok(sb.cache.p, 'nothing is assumed to have changed');
  });

  it('sends once while a request is out, and says so on the button', async () => {
    let release;
    let during = null;
    const sb = sandboxFor((box) => {
      during = { text: box.els.strandedActionConfirmBtn.textContent, disabled: box.els.strandedActionConfirmBtn.disabled };
      return new Promise((r) => { release = () => r({ ok: true }); });
    });
    sb.cache.p = { items: [ITEM] };
    sb.open('p', 'open-pr', 0);
    const first = sb.confirm();
    const second = sb.confirm();
    const early = await Promise.race([second.then(() => 'returned'), new Promise((r) => setTimeout(() => r('still waiting'), 50))]);
    const sent = sb.requests.length;
    release();
    await first;
    assert.equal(early, 'returned', 'the second press returns at once');
    assert.equal(sent, 1);
    assert.deepEqual(during, { text: 'Opening…', disabled: true });
  });

  it('does not reopen when the dialog was closed while the request was out, but still refreshes a done action', async () => {
    let release;
    const sb = sandboxFor(() => new Promise((r) => { release = () => r({ ok: true }); }));
    sb.cache.p = { items: [ITEM] };
    sb.open('p', 'open-pr', 0);
    const pending = sb.confirm();
    sb.close();
    release();
    await pending;
    assert.ok(!sb.els.strandedActionModal._classes.has('open'));
    assert.equal(sb.cache.p, undefined, 'the list is fetched again, so Open PR is not offered twice');
    assert.equal(sb.loads, 1);
  });

  it('changes nothing when a request that was closed on failed', async () => {
    let release;
    const sb = sandboxFor(() => new Promise((r) => { release = () => r(null); }));
    sb.cache.p = { items: [ITEM] };
    sb.open('p', 'open-pr', 0);
    const pending = sb.confirm();
    sb.close();
    release();
    await pending;
    assert.equal(sb.loads, 0);
    assert.ok(sb.cache.p);
    assert.ok(!sb.els.strandedActionModal._classes.has('open'));
  });

  it('has its dialog in the page, wired to its buttons', () => {
    for (const id of ['strandedActionModal', 'strandedActionTitle', 'strandedActionText', 'strandedActionItem',
      'strandedActionNote', 'strandedActionError', 'strandedActionCancelBtn', 'strandedActionConfirmBtn']) {
      assert.match(INDEX_HTML, new RegExp(`id="${id}"`), `${id} is in index.html`);
    }
    assert.match(UI_SRC, /\$\('strandedActionCancelBtn'\)\.addEventListener\('click', closeStrandedAction\)/);
    assert.match(UI_SRC, /\$\('strandedActionConfirmBtn'\)\.addEventListener\('click', confirmStrandedAction\)/);
    assert.match(liftFunction(UI_SRC, 'function renderStrandedDetail('), /strandedItemActions\(project\.name, cached\.items, item\)/);
  });
});

describe('dashboard card: last session badge and row (#1544)', () => {
  const ENDED = '2026-09-16T10:00:00Z';
  const health = (over) => ({
    scope: 'session', sessionId: 3, status: 'killed', endedAt: ENDED, state: 'clean', checkedAt: '2026-09-16T10:05:00.000Z',
    reason: null, newPaths: [], newPathCount: 0, unpushed: 0, snapshotComplete: true, ...over
  });

  /**
   * Run the card's session-health helpers.
   * @returns {object} The sandbox
   */
  function sandboxFor() {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext([
      escSrc,
      liftFunction(UI_SRC, 'function strandedTime('),
      liftFunction(UI_SRC, 'function sessionLeftoverSummary('),
      liftFunction(UI_SRC, 'function renderSessionHealthBadge('),
      liftFunction(UI_SRC, 'function renderSessionHealthDetail('),
      'this.badge = renderSessionHealthBadge; this.detail = renderSessionHealthDetail;'
    ].join('\n'), sandbox);
    return sandbox;
  }

  describe('badge', () => {
    it('shows nothing when there is nothing to say', () => {
      const sb = sandboxFor();
      assert.equal(sb.badge({ name: 'p' }), '');
      assert.equal(sb.badge({ name: 'p', sessionHealth: null }), '');
      assert.equal(sb.badge({ name: 'p', sessionHealth: health() }), '', 'a clean kill');
      for (const state of ['checking', 'unknown']) {
        assert.equal(sb.badge({ name: 'p', sessionHealth: health({ state }) }), '', `a killed session, ${state}`);
      }
      assert.equal(sb.badge({ name: 'p', sessionHealth: health({ status: null, state: 'unknown' }) }), '');
    });

    it('shows a killed session that left work, with the counts and the caveat', () => {
      const sb = sandboxFor();
      const html = sb.badge({ name: 'p', sessionHealth: health({ state: 'left-work', newPathCount: 2, unpushed: 1 }) });
      assert.match(html, /badge-session-left/);
      assert.match(html, /killed · work left/);
      assert.match(html, /2 changed files and 1 unpushed commit in the project folder \(may be from another session\)/);
    });

    it('always shows a crashed session, saying whether it left work', () => {
      const sb = sandboxFor();
      const clean = sb.badge({ name: 'p', sessionHealth: health({ status: 'crashed' }) });
      assert.match(clean, /badge-session-crashed/);
      assert.match(clean, />&#9888; crashed</);
      assert.match(clean, /title="The last session crashed\. Open/);
      const left = sb.badge({ name: 'p', sessionHealth: health({ status: 'crashed', state: 'left-work', newPathCount: 1, unpushed: 0 }) });
      assert.match(left, /crashed · work left/);
      assert.match(left, /1 changed file in the project folder/);
      assert.match(sb.badge({ name: 'p', sessionHealth: health({ status: 'crashed', state: 'checking' }) }), />&#9888; crashed</);
    });
  });

  describe('Last session row', () => {
    it('is empty when nothing applies', () => {
      assert.equal(sandboxFor().detail({ name: 'p', sessionHealth: null }), '');
    });

    it('says a clean kill left nothing, with when it was read', () => {
      const html = sandboxFor().detail({ name: 'p', sessionHealth: health() });
      assert.match(html, /Last session/);
      assert.match(html, /killed .*; nothing left uncommitted or unpushed \(checked /);
      assert.doesNotMatch(html, /detail-row-warn/);
    });

    it('says it is checking', () => {
      assert.match(sandboxFor().detail({ name: 'p', sessionHealth: health({ state: 'checking', checkedAt: null }) }), /checking the project folder…/);
    });

    it('says it cannot tell, and why', () => {
      const html = sandboxFor().detail({ name: 'p', sessionHealth: health({ state: 'unknown', reason: 'git status did not finish in time' }) });
      assert.match(html, /can't tell whether it left work: git status did not finish in time/);
    });

    it('lists what was left, escaped, with the total and every caveat', () => {
      const html = sandboxFor().detail({
        name: 'p',
        sessionHealth: health({
          state: 'left-work', newPaths: ['a.txt', '<img src=x>.txt'], newPathCount: 9, unpushed: null,
          reason: 'commits since launch could not be counted: git rev-list failed', snapshotComplete: false
        })
      });
      assert.match(html, /detail-row-warn/);
      assert.match(html, /left 9 changed files in the project folder/);
      assert.match(html, /may be from another session/);
      assert.match(html, /launch snapshot was incomplete/);
      assert.match(html, /commits since launch could not be counted/);
      assert.match(html, /<code class="stranded-branch">a\.txt<\/code>/);
      assert.doesNotMatch(html, /<img/);
      assert.match(html, /, and 7 more/);
    });

    it('says the record could not be read rather than hiding the row', () => {
      const html = sandboxFor().detail({ name: 'p', sessionHealth: health({ status: null, state: 'unknown', reason: 'the session record could not be read: locked' }) });
      assert.match(html, /could not be read: the session record could not be read: locked/);
    });

    it('marks a crashed session even when it left nothing', () => {
      assert.match(sandboxFor().detail({ name: 'p', sessionHealth: health({ status: 'crashed' }) }), /detail-row-warn/);
    });
  });

  it('is on the card and in its detail panel, and styled', () => {
    assert.match(liftFunction(UI_SRC, 'function renderCard('), /\$\{sessionHealthBadge\}/);
    assert.match(liftFunction(UI_SRC, 'function renderCardDetail('), /renderSessionHealthDetail\(project\)/);
    const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
    for (const cls of ['badge-session-crashed', 'badge-session-left']) {
      assert.match(css, new RegExp(`\\.${cls}\\s*\\{`), `${cls} is styled`);
    }
  });
});
