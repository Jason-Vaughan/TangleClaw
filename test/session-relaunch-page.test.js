'use strict';

/*
 * Restart Session on the session page's ended bar (#1637), EXECUTED.
 *
 * The decisions live in `public/session-relaunch.js` and are tested there. What
 * this file owes is the wiring: that the two ended-bar painters in the real
 * `session.js` consult that decision, that an offered button suppresses the
 * auto-redirect, that a press reaches exactly one POST, and that a launch that
 * never answers is bounded and reconciled instead of retried.
 *
 * session.js touches the DOM at load and cannot be required, so the functions
 * under test are sliced out of the real file and run in a vm sandbox over the
 * mini-dom, with the real relaunch module and wrap-drawer helpers loaded
 * beside them. The markup and service-worker checks read the real files.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeDocument } = require('./_mini-dom');
const guard = require('../scripts/cache-bump-guard.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

/**
 * The full source of one top-level function in session.js, declaration included.
 * @param {string} name - Function name.
 * @returns {string}
 */
function functionSource(name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(SESSION_SRC);
  assert.ok(m, `session.js must define ${name}`);
  const bodyStart = SESSION_SRC.indexOf('{', SESSION_SRC.indexOf(')', m.index));
  let depth = 0;
  for (let i = bodyStart; i < SESSION_SRC.length; i += 1) {
    if (SESSION_SRC[i] === '{') depth += 1;
    else if (SESSION_SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SESSION_SRC.slice(m.index, i + 1);
    }
  }
  return assert.fail(`unbalanced braces in ${name}`);
}

/**
 * One top-level `const` declaration from session.js, so the sandbox runs the
 * shipped value rather than a copy of it.
 * @param {string} name - Constant name.
 * @returns {string}
 */
function constSource(name) {
  const m = new RegExp(`^const ${name} = [^;]+;`, 'm').exec(SESSION_SRC);
  assert.ok(m, `session.js must declare ${name}`);
  return m[0];
}

const WIRING = [
  'stopPolling', 'handleSessionEnded', 'handleWrapCompleted',
  'applyRelaunchEligibility', 'sendRelaunch', 'readRelaunchStatus', 'renderRelaunch', 'onRelaunchClick'
];

const IDS = [
  'sessionWrapIdle', 'sessionWrapping', 'statusDot', 'statusPill', 'wrapBtn', 'killBtn', 'cmdBtn',
  'commandSend', 'sessionEnded', 'endedBackLink', 'relaunchBtn', 'stayBtn', 'countdown', 'relaunchStatus'
];

const WRAPPED = { active: false, wrapping: false, lastSession: { sessionId: 7, status: 'wrapped' } };
const KILLED = { active: false, wrapping: false, lastSession: { sessionId: 7, status: 'killed' } };
const CRASHED = { active: false, wrapping: false, lastSession: { sessionId: 7, status: 'crashed' } };
const UNKNOWN = { active: null, incomplete: ['active'], lastSession: { sessionId: 7, status: 'wrapped' } };

/**
 * Build a sandbox running the real wiring over a mini-dom.
 *
 * `net.post` is a queue of launch answers — each entry is `{data, code, error}`
 * or `'hang'` for a POST that never settles. `net.status` is a queue of status
 * bodies (null for a failed read); an empty queue answers null.
 *
 * @returns {object} Handles the tests drive and read.
 */
function harness() {
  const { doc, ids } = makeDocument(IDS);
  ids.relaunchBtn.classList.add('hidden');
  ids.sessionEnded.classList.add('hidden');
  const posts = [];
  const statusReads = [];
  const navigations = [];
  const timers = [];
  const intervals = [];
  const net = { post: [], status: [] };

  const api = async (url) => {
    statusReads.push(url);
    const body = net.status.length ? net.status.shift() : null;
    api.lastError = body ? null : 'Connection lost.';
    api.lastErrorCode = null;
    return body;
  };
  api.lastError = null;
  api.lastErrorCode = null;

  const sandbox = {
    console: { warn: () => {}, log: console.log, error: () => {} },
    JSON, Promise, Date, Map, Set, Object, Array, String, Number, Boolean, Error,
    encodeURIComponent,
    document: doc,
    projectName: 'my proj',
    sessionState: { wrapDrawerOpen: false },
    pollTimer: null,
    setPillDetail: () => {},
    api,
    apiMutate: (url, method, body) => {
      posts.push({ url, method, body });
      const next = net.post.shift() || { data: null, code: null, error: 'Connection lost.' };
      if (next === 'hang') return new Promise(() => {});
      api.lastError = next.error || null;
      api.lastErrorCode = next.code || null;
      return Promise.resolve(next.data || null);
    },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; intervals.push(t); return t; },
    clearInterval: (t) => { if (t) t.cleared = true; },
    location: {}
  };
  Object.defineProperty(sandbox.location, 'href', {
    get: () => navigations[navigations.length - 1] || '/session/current',
    set: (v) => navigations.push(v)
  });
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'wrap-drawer.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'session-relaunch.js'), 'utf8'), sandbox);
  const globals = ['let countdownTimer = null;', 'let relaunchController = null;', constSource('RELAUNCH_TIMEOUT_MS')].join('\n');
  vm.runInContext(`${globals}\n${WIRING.map(functionSource).join('\n\n')}\n`
    + 'this.__w = { handleSessionEnded, handleWrapCompleted, onRelaunchClick, timeoutMs: RELAUNCH_TIMEOUT_MS };', sandbox);

  // Bind the button the way the page does, so a click goes through the listener.
  ids.relaunchBtn.addEventListener('click', sandbox.__w.onRelaunchClick);

  return {
    w: sandbox.__w,
    doc,
    ids,
    net,
    posts,
    statusReads,
    navigations,
    timers,
    intervals,
    liveIntervals: () => intervals.filter((t) => !t.cleared),
    offered: () => !ids.relaunchBtn.classList.contains('hidden'),
    /** Fire every pending, uncleared timer once. */
    fireTimers() {
      timers.splice(0).filter((t) => !t.cleared).forEach((t) => t.fn());
    },
    settle: async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); }
  };
}

describe('the ended bar offers Restart Session only after a completed wrap', () => {
  it('handleSessionEnded with a wrapped status shows the button and starts no countdown', () => {
    const h = harness();
    h.w.handleSessionEnded(WRAPPED);
    assert.ok(!h.ids.sessionEnded.classList.contains('hidden'), 'the ended bar is shown');
    assert.ok(h.offered(), 'Restart Session is offered');
    assert.equal(h.liveIntervals().length, 0, 'no redirect countdown runs away from the offered button');
    assert.equal(h.ids.countdown.textContent, '');
  });

  for (const [label, status] of [['killed', KILLED], ['crashed', CRASHED], ['unknown liveness', UNKNOWN],
    ['no payload', undefined], ['no last session', { active: false }]]) {
    it(`handleSessionEnded with ${label} hides the button and keeps the countdown`, () => {
      const h = harness();
      h.w.handleSessionEnded(status);
      assert.ok(!h.offered(), `${label} must not offer a relaunch`);
      assert.equal(h.liveIntervals().length, 1, 'an unexpected end still redirects as before');
      assert.match(h.ids.countdown.textContent, /Returning in 10s/);
    });
  }

  it('handleWrapCompleted reads status once and offers the button when it says wrapped', async () => {
    const h = harness();
    h.net.status.push(WRAPPED);
    await h.w.handleWrapCompleted();
    assert.equal(h.statusReads.length, 1, 'exactly one status read');
    assert.equal(h.statusReads[0], '/api/sessions/my%20proj/status');
    assert.ok(h.offered());
    assert.equal(h.liveIntervals().length, 0, 'the wrap-completed path never counts down');
  });

  for (const [label, status] of [['a failed read', null], ['killed', KILLED], ['unknown liveness', UNKNOWN]]) {
    it(`handleWrapCompleted leaves the button hidden on ${label}`, async () => {
      const h = harness();
      h.net.status.push(status);
      await h.w.handleWrapCompleted();
      assert.ok(!h.offered(), 'fails closed');
      assert.ok(!h.ids.sessionEnded.classList.contains('hidden'), 'the ended bar itself still shows');
    });
  }
});

describe('pressing Restart Session', () => {
  it('a click produces exactly one POST with only the continuity choice, and a 201 opens the new session', async () => {
    const h = harness();
    h.w.handleSessionEnded(WRAPPED);
    h.net.post.push({ data: { session: { id: 8 } } });
    h.ids.relaunchBtn.dispatch('click');
    h.ids.relaunchBtn.dispatch('click');
    await h.settle();
    assert.equal(h.posts.length, 1, 'a double click is one launch');
    // Through JSON: the body was built inside the sandbox's realm, whose
    // Object.prototype is not this file's, and strict deepEqual compares prototypes.
    assert.deepEqual(JSON.parse(JSON.stringify(h.posts[0])), { url: '/api/sessions/my%20proj', method: 'POST', body: { continuityMode: 'continue' } });
    assert.deepEqual(h.navigations, ['/session/my%20proj?launched=1']);
  });

  it('is disabled and labelled while the launch is in flight', async () => {
    const h = harness();
    h.w.handleSessionEnded(WRAPPED);
    h.net.post.push('hang');
    h.ids.relaunchBtn.dispatch('click');
    await h.settle();
    assert.equal(h.ids.relaunchBtn.disabled, true);
    assert.equal(h.ids.relaunchBtn.textContent, 'Restarting…');
  });

  it('a retryable refusal is announced in the live region and the button comes back', async () => {
    const h = harness();
    h.w.handleSessionEnded(WRAPPED);
    h.net.post.push({ code: 'CONTROL_STOPPED', error: 'A STOP is in force for this lane.' });
    h.ids.relaunchBtn.dispatch('click');
    await h.settle();
    assert.equal(h.ids.relaunchStatus.textContent, 'A STOP is in force for this lane.');
    assert.equal(h.ids.relaunchStatus.dataset.tone, 'error');
    assert.equal(h.ids.relaunchBtn.disabled, false);
    assert.equal(h.ids.relaunchBtn.textContent, 'Restart Session');
    assert.equal(h.navigations.length, 0);
  });

  it('stranded wraps send the operator to the landing page, focus included, and never retry', async () => {
    const h = harness();
    h.w.handleSessionEnded(WRAPPED);
    h.net.post.push({ code: 'STRANDED_WRAPS', error: 'Two wraps are stranded.' });
    h.ids.relaunchBtn.dispatch('click');
    await h.settle();
    h.ids.relaunchBtn.dispatch('click');
    await h.settle();
    assert.equal(h.posts.length, 1, 'no second POST, and no auto-acknowledgement');
    assert.equal(h.ids.relaunchBtn.disabled, true);
    assert.match(h.ids.relaunchStatus.textContent, /Back to Projects/);
    assert.equal(h.doc.activeElement, h.ids.endedBackLink, 'focus moves to where the message points');
  });

  it('a lost connection reconciles by reading status, never by POSTing again', async () => {
    const h = harness();
    h.w.handleSessionEnded(WRAPPED);
    h.net.post.push({ code: null, error: 'Connection lost.' });
    h.net.status.push({ active: true });
    h.ids.relaunchBtn.dispatch('click');
    await h.settle();
    assert.equal(h.posts.length, 1);
    assert.equal(h.statusReads.length, 1, 'one reconcile read');
    assert.deepEqual(h.navigations, ['/session/my%20proj'], 'a running session is opened without the launch grace');
  });
});

describe('a launch that never answers', () => {
  it('is bounded by the page timeout and reconciled, not re-POSTed', async () => {
    const h = harness();
    h.w.handleSessionEnded(WRAPPED);
    h.net.post.push('hang');
    h.net.status.push({ active: false });
    h.ids.relaunchBtn.dispatch('click');
    await h.settle();
    const bound = h.timers.filter((t) => !t.cleared);
    assert.equal(bound.length, 1, 'the launch is bounded by one timer');
    assert.equal(bound[0].ms, h.w.timeoutMs);
    assert.ok(h.w.timeoutMs >= 30 * 1000, 'long enough for a launch that runs the handoff preflight');

    h.fireTimers();
    await h.settle();
    assert.equal(h.posts.length, 1, 'the timeout never sends a second launch');
    assert.equal(h.statusReads.length, 1, 'it reconciles through a status read');
    assert.match(h.ids.relaunchStatus.textContent, /did not answer in time/);
    assert.match(h.ids.relaunchStatus.textContent, /No session is running/);
    assert.equal(h.ids.relaunchBtn.disabled, false, 'confirmed absence permits an explicit retry');
  });

  it('stays disabled when the reconcile read cannot confirm either way', async () => {
    const h = harness();
    h.w.handleSessionEnded(WRAPPED);
    h.net.post.push('hang');
    h.net.status.push(null);
    h.ids.relaunchBtn.dispatch('click');
    await h.settle();
    h.fireTimers();
    await h.settle();
    assert.equal(h.ids.relaunchBtn.disabled, true);
    assert.equal(h.ids.relaunchStatus.dataset.tone, 'warn');
    assert.equal(h.navigations.length, 0);
  });

  it('clears its timer when the launch answers first', async () => {
    const h = harness();
    h.w.handleSessionEnded(WRAPPED);
    h.net.post.push({ data: { session: { id: 8 } } });
    h.ids.relaunchBtn.dispatch('click');
    await h.settle();
    assert.equal(h.timers.filter((t) => !t.cleared).length, 0, 'no stale timeout left behind');
  });
});

describe('the markup and the service worker', () => {
  it('places a hidden, typed Restart Session button before Stay in the ended bar', () => {
    const bar = SESSION_HTML.slice(SESSION_HTML.indexOf('id="sessionEnded"'), SESSION_HTML.indexOf('<!-- Command Bar -->'));
    const btn = /<button[^>]*id="relaunchBtn"[^>]*>Restart Session<\/button>/.exec(bar);
    assert.ok(btn, 'the ended bar holds the button');
    assert.match(btn[0], /type="button"/);
    assert.match(btn[0], /class="[^"]*\bhidden\b/, 'hidden until a status read offers it');
    assert.ok(bar.indexOf('id="relaunchBtn"') < bar.indexOf('id="stayBtn"'), 'before Stay');
    assert.match(bar, /id="endedBackLink"/, 'Back to Projects is addressable for the focus move');
  });

  it('announces outcomes through a polite live region', () => {
    const m = /<span[^>]*id="relaunchStatus"[^>]*>/.exec(SESSION_HTML);
    assert.ok(m);
    assert.match(m[0], /role="status"/);
    assert.match(m[0], /aria-live="polite"/);
  });

  it('loads session-relaunch.js before session.js', () => {
    const rel = SESSION_HTML.indexOf('<script src="/session-relaunch.js"></script>');
    assert.ok(rel !== -1);
    assert.ok(rel < SESSION_HTML.indexOf('<script src="/session.js"></script>'));
  });

  it('serves session-relaunch.js network-first and precaches it', () => {
    const stripped = guard.stripComments(SW_SRC);
    const networkFirst = [...guard.bracketedLiteral(stripped, 'const NETWORK_FIRST_PATHS').matchAll(/'([^']*)'/g)].map((x) => x[1]);
    const precache = [...guard.bracketedLiteral(stripped, 'const STATIC_ASSETS').matchAll(/'([^']*)'/g)].map((x) => x[1]);
    assert.ok(networkFirst.includes('/session-relaunch.js'), 'lockstep with the network-first session.js');
    assert.ok(precache.includes('/session-relaunch.js'), 'precached so an offline miss is not a 503 script');
  });
});
