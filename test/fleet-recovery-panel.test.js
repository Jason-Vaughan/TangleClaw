'use strict';

// #2049: the fleet recovery panel, run rather than read.
//
// The REAL public/fleet-recovery-panel.js is lifted into a sandbox beside the
// real api-helper.js (whose escaper it uses) and driven two ways: against the
// real request handler on a real store, to pin that the panel and the three
// routes agree, and against a scripted `api()`, for the answers a fixture
// cannot produce on demand. What is held here: the operator chooses, then
// reviews, then clears, and nothing is sent before the last of those; only the
// launches chosen are named, by the binding that was read; every item's outcome
// is shown and only a clear is worded as one; what a launch says afterwards is
// an observation and claims nothing about a session; and an install with no
// login is shown the server's refusal and no control.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');
const { makeDocument } = require('./_mini-dom');

setLevel('error');

const store = require('../lib/store');
const fixture = require('./_recovery-fixture');
const { handleRequest } = require('../server');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');
const SRC = read('fleet-recovery-panel.js');
const API_HELPER_SRC = read('api-helper.js');

/**
 * Lift the panel script into a sandbox that already holds what api-helper.js
 * publishes, as the dashboard page does.
 * @returns {object} The sandbox, with what both scripts published.
 */
function lift() {
  const sandbox = { console: { log() {}, error() {}, warn() {} } };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(API_HELPER_SRC, sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

/**
 * A scripted `api()` and `apiMutate()` pair, as the page makes them: a call
 * returns the body, or null with `lastError` and `lastErrorCode` set.
 * @param {function(string, string, object): (Promise<{status: number, body: object}|null>|{status: number, body: object}|null)} answer -
 *   What the server says; null for no answer at all.
 * @returns {{api: Function, apiMutate: Function, calls: Array}}
 */
function scripted(answer) {
  const calls = [];
  const run = async (url, method, body) => {
    calls.push({ url, method, body });
    const res = await answer(url, method, body);
    if (!res) {
      api.lastError = 'Connection lost.';
      api.lastErrorCode = null;
      return null;
    }
    if (res.status >= 400) {
      api.lastError = res.body.error || 'refused';
      api.lastErrorCode = res.body.code || null;
      return null;
    }
    api.lastError = null;
    api.lastErrorCode = null;
    return res.body;
  };
  const api = (url) => run(url, 'GET');
  api.lastError = null;
  api.lastErrorCode = null;
  return { api, apiMutate: (url, method, body) => run(url, method, body), calls };
}

/**
 * A controller over a given `api()` pair.
 * @param {{api: Function, apiMutate: Function}} wires - The pair.
 * @returns {object} The panel's controller
 */
const controller = (wires) => lift().tcCreateFleetRecoveryPanel({ api: wires.api, apiMutate: wires.apiMutate });

/** The actions the controls on screen carry, in order. */
const actionsIn = (html) => [...html.matchAll(/data-fleet-action="([^"]+)"/g)].map((m) => m[1]);

/** What a result or observation must never say: it would be a claim about a session's work. */
const WORK_CLAIMS = /acknowledg|prompt|resum|working|woke|awake|\bidle\b/i;

/**
 * A row of the fleet read, with every field the panel reads.
 * @param {number} n - Distinguishes the launch
 * @param {object} [overrides] - Fields to replace
 * @returns {object}
 */
function heldRow(n, overrides = {}) {
  return {
    projectId: n,
    projectName: `project-${n}`,
    sessionId: 100 + n,
    sequenceId: 200 + n,
    revision: 1,
    recoveryRevision: 1,
    createdAt: '2026-10-09 01:00:00',
    recovery: 'required',
    recoveryMode: 'operator',
    sessionStatus: { value: 'active', basis: 'stored-session-status' },
    preflight: {
      verdict: 'handoff-unreadable', reason: 'the handoff could not be read', requiresRecovery: true,
      requiresReconciliation: false, worktreeDirty: null
    },
    priorSession: { source: 'sessions', state: 'recorded', sessionId: 90 + n, status: 'killed', endedAt: '2026-10-09 00:59:00' },
    uncertainWork: [
      { kind: 'strandedWraps', source: 'activity_log', state: 'none-recorded', completeness: 'incomplete-history', note: 'The record is pruned.', items: [] },
      { kind: 'launchNudge', source: 'launch_sequences', state: 'recorded', completeness: 'unpruned', note: 'A sent nudge is not proof it was read.', nudgeCount: 2, lastNudgedAt: '2026-10-09 01:05:00', unreadyAt: null },
      { kind: 'paneInput', source: 'none', state: 'unavailable', reasonCode: 'NO_DURABLE_SOURCE', note: 'Recorded nowhere durable.' }
    ],
    ...overrides
  };
}

/** The four ids a batch item names, from a fleet-read row. */
const bindingOf = (row) => ({
  projectId: row.projectId, sessionId: row.sessionId, sequenceId: row.sequenceId, recoveryRevision: row.recoveryRevision
});

/**
 * A scripted server holding a list of held rows, answering the batch clear
 * with a chosen outcome per launch and the batch read with one observation each.
 * @param {object[]} rows - The fleet read's rows
 * @param {object} [opts]
 * @param {function(object): string} [opts.outcome] - The outcome for an item (default `cleared`)
 * @param {function(string, string): (object|null|undefined)} [opts.intercept] - Answer a call first; undefined to fall through
 * @returns {{api: Function, apiMutate: Function, calls: Array}}
 */
function scriptedFleet(rows, opts = {}) {
  let sent = [];
  return scripted((url, method, body) => {
    const early = opts.intercept ? opts.intercept(url, method) : undefined;
    if (early !== undefined) return early;
    if (url === '/api/launch/recovery-held') {
      return { status: 200, body: { gateState: 'armed', generatedAt: '2026-10-09T08:00:00.000Z', launches: rows } };
    }
    if (method === 'POST') {
      sent = body.items.map((item, index) => ({
        index, ...item, outcome: opts.outcome ? opts.outcome(item) : 'cleared', recorded: true,
        recoveryNow: 'cleared', recoveryRevisionNow: item.recoveryRevision, stillBlocked: false
      }));
      return { status: 200, body: { batchId: 'batch-1', requestedBy: 'rosie', requestedAt: '2026-10-09 08:00:01', items: sent } };
    }
    return {
      status: 200,
      body: {
        batchId: 'batch-1', requestedBy: 'rosie', requestedAt: '2026-10-09 08:00:01', itemCount: sent.length,
        recordedItemCount: sent.length, unrecordedIndexes: [], observedAt: '2026-10-09T08:00:02.000Z',
        items: sent.map((item) => ({
          ...item,
          observation: {
            state: 'recorded', source: 'launch_sequences and sessions, as stored', recovery: 'cleared', recoveryRevision: 1,
            stillBlocked: false, cursor: 3, readyAt: null, attestedReady: false,
            sessionStatus: { state: 'recorded', value: 'active', endedAt: null, basis: 'stored-session-status' }
          }
        }))
      }
    };
  });
}

describe('the fleet recovery panel (#2049)', () => {
  describe('against the real routes', () => {
    let env;
    const client = fixture.makeClient(handleRequest);

    before(() => { env = fixture.openTempStore('tc-fleet-panel-'); });
    after(() => { fixture.resetLogin(); env.restore(); });
    beforeEach(() => {
      fixture.resetLogin();
      // Each case reads the whole fleet, so it starts with no launch held.
      store.getDb().prepare('UPDATE launch_sequences SET recovery = \'none\' WHERE recovery = \'required\'').run();
    });

    /**
     * A page's `api()` pair wired to the real request handler, carrying what a
     * signed-in browser carries: the cookie, and the CSRF token on a write.
     * @param {{cookie?: string, csrf?: string}} [auth] - From the fixture's `signIn`; empty for a caller who is not signed in
     * @returns {{api: Function, apiMutate: Function, calls: Array}}
     */
    function real(auth = {}) {
      return scripted(async (url, method, body) => {
        const headers = {};
        if (auth.cookie) headers.cookie = auth.cookie;
        if (method !== 'GET' && auth.csrf) headers['x-csrf-token'] = auth.csrf;
        const res = await client.send(method, url, { body, headers });
        return { status: res.statusCode, body: client.json(res) };
      });
    }

    /**
     * Turn the login on and sign in as the operator.
     * @returns {Promise<{cookie: string, csrf: string}>}
     */
    async function operator() {
      client.arm();
      return client.signIn();
    }

    const recoveryOf = (held) => store.launchSequences.getBySession(held.sequence.sessionId).recovery;
    const keyOf = (held) => `${held.sequence.id}:${held.sequence.recoveryRevision}`;

    it('lists every held launch with its binding and evidence, and sends nothing until the reviewed clear', async () => {
      const chosen = fixture.launchInRecovery(env);
      const left = fixture.launchInRecovery(env);
      const wires = real(await operator());
      const panel = controller(wires);
      await panel.load();

      const list = panel.html();
      for (const held of [chosen, left]) {
        assert.ok(list.includes(held.project.name), 'the project is named');
        assert.ok(list.includes(`session ${held.sequence.sessionId} | launch ${held.sequence.id} | recovery revision ${held.sequence.recoveryRevision}`),
          'with the exact binding a clear names');
        assert.ok(list.includes(`data-fleet-key="${keyOf(held)}"`), 'and a checkbox of its own');
      }
      assert.ok(list.includes(chosen.sequence.preflight.verdict), 'the stored preflight verdict is shown');
      assert.match(list, /Prior session: this project has no earlier session on record/);
      assert.match(list, /Pane input:<\/strong> unknown \(NO_DURABLE_SOURCE\)/, 'a source that does not exist reads as unknown, not as none');
      assert.match(list, /Review 0 selected<\/button>/);
      assert.match(list, /data-fleet-action="review" disabled/, 'nothing chosen, nothing to review');

      await panel.act('toggle', { key: keyOf(chosen) });
      await panel.act('review');
      const review = panel.html();
      assert.equal(panel.state.phase, 'review');
      assert.ok(review.includes(chosen.project.name));
      assert.ok(!review.includes(left.project.name), 'the review names only what was chosen');
      assert.match(review, /Clear 1 launch\(es\)/);
      assert.deepEqual(wires.calls.map((c) => c.method), ['GET'], 'choosing and reviewing sent nothing');
      assert.equal(recoveryOf(chosen), 'required');

      await panel.act('clear');
      const posts = wires.calls.filter((c) => c.method === 'POST');
      assert.equal(posts.length, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(posts[0].body)), { items: [{ projectId: chosen.project.id, ...chosen.binding }] },
        'the clear names exactly the chosen launch, by the binding that was read');
      assert.equal(recoveryOf(chosen), 'cleared');
      assert.equal(recoveryOf(left), 'required', 'a launch that was not chosen is not cleared');

      const result = panel.html();
      assert.equal(panel.state.phase, 'result');
      assert.match(result, /1 of 1 launch\(es\) cleared/);
      assert.match(result, /<strong>Cleared\.<\/strong>/);
      assert.ok(result.includes(panel.state.batch.batchId), 'the batch id is shown');
      assert.match(result, /sent by rosie/);
      assert.match(result, /Observed [^:]+:[^<]*recovery <code>cleared<\/code>/, 'what the launch says now, with when it was read');
      assert.match(result, /READY attestation: none recorded/);
      assert.match(result, /session's stored status: <code>active<\/code>/);
      assert.doesNotMatch(result, WORK_CLAIMS, 'an observation claims nothing about a session\'s work');

      await panel.act('done');
      const after = panel.html();
      assert.equal(panel.state.phase, 'list');
      assert.ok(after.includes(left.project.name));
      assert.ok(!after.includes(chosen.project.name), 'the cleared launch has left the list');
    });

    it('clears a whole selection and reports each item, including one somebody else cleared first', async () => {
      const first = fixture.launchInRecovery(env);
      const second = fixture.launchInRecovery(env);
      const auth = await operator();
      const wires = real(auth);
      const panel = controller(wires);
      await panel.load();
      await panel.act('select-all');
      await panel.act('review');
      assert.match(panel.html(), /Clear 2 launch\(es\)/);

      // Another tab clears one of them between the review and the clear.
      const other = await client.send('POST', '/api/launch/recovery-clear-batch', {
        body: { items: [{ projectId: second.project.id, ...second.binding }] },
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf }
      });
      assert.equal(other.statusCode, 200, other.body);

      await panel.act('clear');
      assert.deepEqual(panel.state.batch.items.map((item) => item.outcome), ['cleared', 'already-clear']);
      const result = panel.html();
      assert.match(result, /1 of 2 launch\(es\) cleared/, 'the count is of what this request cleared');
      assert.match(result, /<strong>Already clear\.<\/strong><\/span> The launch was already cleared at the revision you reviewed\. This request changed nothing\./);
      assert.equal(recoveryOf(first), 'cleared');
    });

    it('shows an install with no login the server\'s refusal and no control, and sends no clear', async () => {
      const held = fixture.launchInRecovery(env);
      const wires = real();
      const panel = controller(wires);
      await panel.load();
      const drawn = panel.html();
      assert.equal(panel.state.refused.code, 'LOGIN_GATE_REQUIRED');
      assert.match(drawn, /This install has no login/);
      assert.match(drawn, /Launch readiness panel still shows its own launches/, 'and says where one launch is still cleared');
      assert.deepEqual(actionsIn(drawn), [], 'no control at all');
      assert.ok(!drawn.includes(held.project.name), 'and nothing of the fleet');

      // Pressing what is not there sends nothing.
      for (const action of ['select-all', 'review', 'clear', 'observe']) await panel.act(action, { key: keyOf(held) });
      assert.deepEqual(wires.calls.map((c) => c.method), ['GET']);
      assert.equal(recoveryOf(held), 'required');
    });

    it('shows a caller who is not signed in the refusal and only a way to try again', async () => {
      const held = fixture.launchInRecovery(env);
      client.arm();
      const panel = controller(real());
      await panel.load();
      const drawn = panel.html();
      assert.equal(panel.state.refused.code, 'UNAUTHENTICATED');
      assert.match(drawn, /Sign in/, 'the server\'s own words');
      assert.deepEqual(actionsIn(drawn), ['refresh']);
      assert.ok(!drawn.includes(held.project.name));
    });

    it('says so when no launch is held', async () => {
      const panel = controller(real(await operator()));
      await panel.load();
      const drawn = panel.html();
      assert.match(drawn, /No launch of an active session is waiting on an operator's clear/);
      assert.deepEqual(actionsIn(drawn), ['refresh']);
    });
  });

  describe('choosing', () => {
    it('selects all, selects none, and keeps a subset', async () => {
      const rows = [heldRow(1), heldRow(2), heldRow(3)];
      const panel = controller(scriptedFleet(rows));
      await panel.load();
      await panel.act('select-all');
      assert.match(panel.html(), /Review 3 selected/);
      assert.equal((panel.html().match(/ checked>/g) || []).length, 3);
      await panel.act('toggle', { key: '202:1' });
      assert.match(panel.html(), /Review 2 selected/);
      await panel.act('select-none');
      assert.match(panel.html(), /Review 0 selected/);
      await panel.act('review');
      assert.equal(panel.state.phase, 'list', 'an empty selection is not reviewed');
    });

    it('ignores a key that names no listed launch', async () => {
      const panel = controller(scriptedFleet([heldRow(1)]));
      await panel.load();
      await panel.act('toggle', { key: '999:1' });
      await panel.act('toggle', { key: undefined });
      assert.equal(panel.state.selected.size, 0);
    });

    it('drops a selection when the launch has left the list or its recovery revision has moved', async () => {
      const rows = [heldRow(1), heldRow(2), heldRow(3)];
      const panel = controller(scriptedFleet(rows));
      await panel.load();
      await panel.act('select-all');
      rows.splice(0, 1);
      rows[0] = heldRow(2, { recoveryRevision: 2 });
      await panel.act('refresh');
      assert.deepEqual([...panel.state.selected], ['203:1'],
        'a launch chosen at one revision is not carried to another: it is a different decision');
      assert.match(panel.html(), /Review 1 selected/);
    });

    it('will not review more launches than one batch may name, and says why', async () => {
      const rows = Array.from({ length: 101 }, (_, i) => heldRow(i + 1));
      const wires = scriptedFleet(rows);
      const panel = controller(wires);
      await panel.load();
      await panel.act('select-all');
      const drawn = panel.html();
      assert.match(drawn, /One batch clears at most 100 launches and 101 are selected/);
      assert.match(drawn, /data-fleet-action="review" disabled/);
      await panel.act('review');
      assert.equal(panel.state.phase, 'list');
      await panel.act('toggle', { key: '201:1' });
      await panel.act('review');
      assert.equal(panel.state.phase, 'review', 'a hundred is reviewed');
      assert.equal(wires.calls.filter((c) => c.method === 'POST').length, 0);
    });

    it('goes back from the review with the selection kept and nothing sent', async () => {
      const wires = scriptedFleet([heldRow(1), heldRow(2)]);
      const panel = controller(wires);
      await panel.load();
      await panel.act('toggle', { key: '201:1' });
      await panel.act('review');
      await panel.act('back');
      assert.equal(panel.state.phase, 'list');
      assert.match(panel.html(), /Review 1 selected/);
      assert.deepEqual(wires.calls.map((c) => c.method), ['GET']);
    });

    it('does not clear from the list: a clear is taken only from the review', async () => {
      const wires = scriptedFleet([heldRow(1)]);
      const panel = controller(wires);
      await panel.load();
      await panel.act('select-all');
      await panel.act('clear');
      assert.deepEqual(wires.calls.map((c) => c.method), ['GET']);
      assert.ok(!actionsIn(panel.html()).includes('clear'), 'and the list offers no clear');
    });
  });

  describe('the evidence', () => {
    it('words the three states of a source apart, with how complete each source is', async () => {
      const panel = controller(scriptedFleet([heldRow(1)]));
      await panel.load();
      const drawn = panel.html();
      assert.match(drawn, /<summary>Work that may have been queued or in flight: 1 recorded, 1 none recorded, 1 unknown<\/summary>/);
      assert.match(drawn, /Stranded wraps:<\/strong> none recorded\. The record is pruned\..*completeness: incomplete-history/);
      assert.match(drawn, /Launch nudges:<\/strong> recorded\..*nudgeCount: <code>2<\/code>/);
      assert.match(drawn, /Pane input:<\/strong> unknown \(NO_DURABLE_SOURCE\)/);
    });

    it('shows the stored preflight record whole, and a value never measured as not recorded', async () => {
      const panel = controller(scriptedFleet([heldRow(1, {
        preflight: { verdict: 'handoff-unreadable', reason: 'unreadable', requiresRecovery: true, worktreeDirty: null, addedLater: { nested: 1 } }
      })]));
      await panel.load();
      const drawn = panel.html();
      assert.match(drawn, /worktreeDirty: <em>not recorded<\/em>/, 'null is "never measured", not false');
      assert.doesNotMatch(drawn, /worktreeDirty: <code>false<\/code>/);
      assert.match(drawn, /requiresRecovery: <code>true<\/code>/);
      assert.match(drawn, /addedLater: <code>\{&quot;nested&quot;:1\}<\/code>/, 'a field this page has no word for is still shown');
    });

    it('says a preflight record or a prior session could not be read, and never that there was none', async () => {
      const panel = controller(scriptedFleet([heldRow(1, {
        preflight: null,
        priorSession: { source: 'sessions', state: 'unavailable', reasonCode: 'SOURCE_READ_FAILED' },
        uncertainWork: undefined
      })]));
      await panel.load();
      const drawn = panel.html();
      assert.match(drawn, /Preflight: the stored record could not be read/);
      assert.match(drawn, /Prior session: could not be read \(SOURCE_READ_FAILED\)\. That is not a statement that there was none\./);
      assert.match(drawn, /the server sent no evidence for this launch/);
      assert.ok(actionsIn(drawn).includes('toggle'), 'the launch is still listed and can still be chosen');
    });

    it('shows the prior session\'s stored status as the row\'s own word', async () => {
      const panel = controller(scriptedFleet([heldRow(1)]));
      await panel.load();
      assert.match(panel.html(), /Prior session 91: stored status <code>killed<\/code>, ended 2026-10-09 00:59:00\. The status is the session row's own word; no reason for the end is recorded\./);
    });

    it('escapes what it prints', async () => {
      const panel = controller(scriptedFleet([heldRow(1, {
        projectName: '<img src=x onerror=alert(1)>',
        preflight: { verdict: '<b>v</b>', reason: '"><script>x</script>' }
      })]));
      await panel.load();
      await panel.act('select-all');
      for (const step of ['review', 'clear']) {
        const drawn = panel.html();
        assert.doesNotMatch(drawn, /<img|<script|<b>v/);
        assert.match(drawn, /&lt;img src=x onerror=alert\(1\)&gt;/);
        await panel.act(step);
      }
      assert.doesNotMatch(panel.html(), /<img|<script/);
      assert.match(panel.html(), /&lt;img src=x/, 'the result names the project as the list did');
    });
  });

  describe('the result', () => {
    const OUTCOMES = {
      cleared: /<span class="rules-status-ok"><strong>Cleared\.<\/strong>/,
      'already-clear': /<strong>Already clear\.<\/strong>/,
      stale: /<strong>Changed since you read it\.<\/strong><\/span> The launch is not as you reviewed it, so it was left alone/,
      advisory: /<strong>Not an operator&#39;s to clear\.<\/strong>/,
      'session-ended': /<strong>Session ended\.<\/strong>/,
      'not-found': /<strong>Not found\.<\/strong>/,
      archived: /<strong>Project archived\.<\/strong>/,
      failed: /<strong>Failed\.<\/strong>.*server log names the error/
    };

    for (const [outcome, wording] of Object.entries(OUTCOMES)) {
      it(`words the outcome "${outcome}", and only a clear as a clear`, async () => {
        const panel = controller(scriptedFleet([heldRow(1)], { outcome: () => outcome }));
        await panel.load();
        await panel.act('select-all');
        await panel.act('review');
        await panel.act('clear');
        const drawn = panel.html();
        assert.match(drawn, wording);
        assert.match(drawn, new RegExp(`${outcome === 'cleared' ? 1 : 0} of 1 launch\\(es\\) cleared`));
        assert.equal(/rules-status-ok/.test(drawn), outcome === 'cleared', 'only a clear is marked as a pass');
        assert.doesNotMatch(drawn, WORK_CLAIMS);
      });
    }

    it('words every outcome the server can answer', () => {
      const { ITEM_OUTCOMES } = require('../lib/launch-recovery-batch');
      assert.deepEqual(Object.values(ITEM_OUTCOMES).sort(), Object.keys(OUTCOMES).sort(),
        'an outcome added to the batch needs its words here and in the panel');
    });

    it('shows an outcome it does not know by its code, never as a clear', async () => {
      const panel = controller(scriptedFleet([heldRow(1)], { outcome: () => 'cleared-ish<i>' }));
      await panel.load();
      await panel.act('select-all');
      await panel.act('review');
      await panel.act('clear');
      const drawn = panel.html();
      assert.match(drawn, /Outcome <code>cleared-ish&lt;i&gt;<\/code><\/strong><\/span>, which this page does not know\. It is not a clear\./);
      assert.match(drawn, /0 of 1 launch\(es\) cleared/);
      assert.doesNotMatch(drawn, /rules-status-ok/);
    });

    it('says when an outcome could not be written to the batch\'s record', async () => {
      const wires = scripted((url, method) => {
        if (url === '/api/launch/recovery-held') return { status: 200, body: { generatedAt: 't', launches: [heldRow(1)] } };
        if (method === 'POST') {
          return { status: 200, body: { batchId: 'b', requestedBy: 'rosie', requestedAt: 't', items: [{ index: 0, ...bindingOf(heldRow(1)), outcome: 'stale', recorded: false }] } };
        }
        return { status: 200, body: { batchId: 'b', observedAt: 't2', unrecordedIndexes: [0], items: [] } };
      });
      const panel = controller(wires);
      await panel.load();
      await panel.act('select-all');
      await panel.act('review');
      await panel.act('clear');
      const drawn = panel.html();
      assert.match(drawn, /This outcome could not be written to the batch's record\./);
      assert.match(drawn, /The batch's record holds no row for item\(s\) 0\./);
      assert.match(drawn, /this item is not in the batch's record, so nothing was read for it\./);
    });

    it('keeps the review on screen when the clear is refused or its answer is lost, and says a resend is safe', async () => {
      let lost = true;
      const wires = scriptedFleet([heldRow(1)], {
        intercept: (url, method) => {
          if (method !== 'POST') return undefined;
          if (lost) return null;
          return { status: 403, body: { code: 'CSRF_TOKEN_INVALID', error: 'The CSRF token is missing or wrong.' } };
        }
      });
      const panel = controller(wires);
      await panel.load();
      await panel.act('select-all');
      await panel.act('review');
      await panel.act('clear');
      assert.equal(panel.state.phase, 'review');
      assert.equal(panel.state.batch, null, 'no result is shown for an answer that never came');
      assert.match(panel.html(), /The batch was not confirmed: Connection lost\. If the answer was lost, sending again is safe/);
      assert.ok(actionsIn(panel.html()).includes('clear'), 'and the clear can be sent again');

      lost = false;
      await panel.act('clear');
      assert.equal(panel.state.phase, 'review');
      assert.match(panel.html(), /The CSRF token is missing or wrong\./, 'a refusal is shown as the server worded it');
      assert.doesNotMatch(panel.html(), /Cleared\./);
    });

    it('shows the outcomes even when the launches cannot be read back, and reads them on request', async () => {
      let readable = false;
      const wires = scriptedFleet([heldRow(1)], {
        intercept: (url, method) => (method === 'GET' && url.startsWith('/api/launch/recovery-clear-batch/') && !readable
          ? { status: 500, body: { code: 'BATCH_NOT_READ', error: 'The batch could not be read. Try again.' } }
          : undefined)
      });
      const panel = controller(wires);
      await panel.load();
      await panel.act('select-all');
      await panel.act('review');
      await panel.act('clear');
      let drawn = panel.html();
      assert.equal(panel.state.phase, 'result');
      assert.match(drawn, /<strong>Cleared\.<\/strong>/, 'the clear\'s own answer is not lost with the read');
      assert.match(drawn, /Not read back yet\. As the clear re-read it: recovery <code>cleared<\/code> at revision 1 \(not held\)\./,
        'whether the launch is still held is on screen from the clear\'s own answer');
      assert.match(drawn, /What the launches say now could not be read: The batch could not be read\. Try again\./);

      readable = true;
      await panel.act('observe');
      drawn = panel.html();
      assert.match(drawn, /Observed 2026-10-09T08:00:02\.000Z: recovery <code>cleared<\/code> at revision 1 \(not held\) \| launch step cursor: 3/);
      assert.doesNotMatch(drawn, /could not be read/);
      assert.equal(wires.calls.at(-1).url, '/api/launch/recovery-clear-batch/batch-1');
    });

    it('says from the clear\'s own answer that a launch is still held, or that it is unknown, when the read-back fails', async () => {
      const wires = scripted((url, method) => {
        if (url === '/api/launch/recovery-held') return { status: 200, body: { generatedAt: 't', launches: [heldRow(1), heldRow(2)] } };
        if (method !== 'POST') return null;
        return {
          status: 200,
          body: {
            batchId: 'b', requestedBy: 'rosie', requestedAt: 't', items: [
              { index: 0, ...bindingOf(heldRow(1)), outcome: 'stale', recorded: true, recoveryNow: 'required', recoveryRevisionNow: 2, stillBlocked: true },
              { index: 1, ...bindingOf(heldRow(2)), outcome: 'failed', recorded: true, recoveryNow: null, recoveryRevisionNow: null, stillBlocked: null }
            ]
          }
        };
      });
      const panel = controller(wires);
      await panel.load();
      await panel.act('select-all');
      await panel.act('review');
      await panel.act('clear');
      const drawn = panel.html();
      assert.match(drawn, /As the clear re-read it: recovery <code>required<\/code> at revision 2 \(still held\)\./);
      assert.match(drawn, /The clear could not re-read this launch, so nothing is known about it now\./);
      assert.equal((drawn.match(/not held/g) || []).length, 0, 'unknown is never shown as not held');
    });

    it('words an observation that found no launch, or could not read one, apart from "not held"', () => {
      const sandbox = lift();
      const wires = scripted((url, method) => {
        if (url === '/api/launch/recovery-held') return { status: 200, body: { generatedAt: 't', launches: [heldRow(1), heldRow(2), heldRow(3)] } };
        const items = [1, 2, 3].map((n, index) => ({ index, ...bindingOf(heldRow(n)), outcome: 'cleared', recorded: true }));
        if (method === 'POST') return { status: 200, body: { batchId: 'b', requestedBy: 'rosie', requestedAt: 't', items } };
        const observations = [
          { state: 'none-recorded', source: 's' },
          { state: 'unavailable', source: 's', reasonCode: 'SOURCE_READ_FAILED' },
          {
            state: 'recorded', source: 's', recovery: 'required', recoveryRevision: 2, stillBlocked: true, cursor: 0,
            readyAt: '2026-10-09 08:01:00', attestedReady: true, sessionStatus: { state: 'unavailable', reasonCode: 'SOURCE_READ_FAILED' }
          }
        ];
        return { status: 200, body: { batchId: 'b', observedAt: 't2', unrecordedIndexes: [], items: items.map((item, i) => ({ ...item, observation: observations[i] })) } };
      });
      const panel = sandbox.tcCreateFleetRecoveryPanel(wires);
      return (async () => {
        await panel.load();
        await panel.act('select-all');
        await panel.act('review');
        await panel.act('clear');
        const drawn = panel.html();
        assert.match(drawn, /the launch could not be found as this item names it, so nothing is known about it now\./);
        assert.match(drawn, /the launch could not be read \(SOURCE_READ_FAILED\), so nothing is known about it now\. That is not a statement that it is no longer held\./);
        assert.match(drawn, /recovery <code>required<\/code> at revision 2 \(still held\)/);
        assert.match(drawn, /READY attestation: recorded 2026-10-09 08:01:00/);
        assert.match(drawn, /session's stored status: could not be read \(SOURCE_READ_FAILED\)/);
        assert.doesNotMatch(drawn, WORK_CLAIMS);
      })();
    });
  });

  describe('on the page', () => {
    /**
     * A container that records what is drawn in it and what it is asked to
     * find, with one click listener a test can fire.
     * @returns {object}
     */
    function fakeContainer() {
      const focused = [];
      const container = {
        dataset: {},
        innerHTML: '',
        listeners: [],
        asked: [],
        focused,
        addEventListener(type, fn) { if (type === 'click') this.listeners.push(fn); },
        querySelector(selector) {
          this.asked.push(selector);
          return { focus: () => focused.push(selector) };
        },
        click(dataset, disabled = false) { return Promise.all(this.listeners.map((fn) => fn({ target: { dataset, disabled } }))); }
      };
      return container;
    }

    it('draws in its container, and moves focus to the step\'s heading when the step changes', async () => {
      const sandbox = lift();
      const container = fakeContainer();
      const wires = scriptedFleet([heldRow(1), heldRow(2)]);
      const panel = await sandbox.tcMountFleetRecovery(container, wires);
      assert.match(container.innerHTML, /Launches waiting on an operator/);
      assert.equal(container.listeners.length, 1);
      assert.deepEqual(container.focused, [], 'opening the panel does not take focus');

      await container.click({ fleetAction: 'toggle', fleetKey: '201:1' });
      assert.match(container.innerHTML, /Review 1 selected/);
      assert.deepEqual(container.focused, ['[data-fleet-key="201:1"]'], 'the checkbox that was pressed keeps focus across the redraw');

      await container.click({ fleetAction: 'review' });
      assert.equal(panel.state.phase, 'review');
      assert.equal(container.focused.at(-1), '.fleet-recovery-heading');

      await container.click({ fleetAction: 'clear' });
      assert.equal(panel.state.phase, 'result');
      assert.match(container.innerHTML, /Batch result/);
      assert.equal(container.focused.at(-1), '.fleet-recovery-heading');
    });

    it('ignores a disabled control, and a key that is not one it wrote', async () => {
      const sandbox = lift();
      const container = fakeContainer();
      const wires = scriptedFleet([heldRow(1)]);
      const panel = await sandbox.tcMountFleetRecovery(container, wires);
      await container.click({ fleetAction: 'select-all' }, true);
      assert.equal(panel.state.selected.size, 0);
      await container.click({ fleetAction: 'toggle', fleetKey: '"],body,[x="' });
      assert.equal(panel.state.selected.size, 0);
      assert.deepEqual(container.asked.at(-1), '[data-fleet-action="toggle"]', 'a key in another shape never reaches a selector');
    });

    it('disables the clear while it is on its way, so it is not sent twice', async () => {
      const sandbox = lift();
      const container = fakeContainer();
      let release;
      const wires = scriptedFleet([heldRow(1)], {
        intercept: (url, method) => (method === 'POST' && !release ? new Promise((resolve) => { release = () => resolve(undefined); }) : undefined)
      });
      await sandbox.tcMountFleetRecovery(container, wires);
      await container.click({ fleetAction: 'select-all' });
      await container.click({ fleetAction: 'review' });
      const first = container.click({ fleetAction: 'clear' });
      assert.match(container.innerHTML, /data-fleet-action="clear" disabled/);
      assert.match(container.innerHTML, /data-fleet-action="back" disabled/, 'and no control that would do nothing looks pressable');
      await container.click({ fleetAction: 'clear' });
      assert.equal(wires.calls.filter((c) => c.method === 'POST').length, 1, 'a second press while one is out sends nothing');
      release();
      await first;
    });

    it('reads the list again when it is opened a second time, with the selection kept and one listener', async () => {
      const sandbox = lift();
      const container = fakeContainer();
      const rows = [heldRow(1), heldRow(2)];
      const wires = scriptedFleet(rows);
      const panel = await sandbox.tcMountFleetRecovery(container, wires);
      await container.click({ fleetAction: 'toggle', fleetKey: '201:1' });
      rows.push(heldRow(3));
      const again = await sandbox.tcMountFleetRecovery(container, wires);
      assert.equal(again, panel, 'the same controller, not a second one');
      assert.equal(wires.calls.filter((c) => c.url === '/api/launch/recovery-held').length, 2);
      assert.match(container.innerHTML, /project-3/, 'a launch held since the first opening is listed');
      assert.match(container.innerHTML, /Review 1 selected/);
      assert.equal(container.listeners.length, 1);
    });

    it('does not discard a review or a batch result when it is opened again', async () => {
      const sandbox = lift();
      const container = fakeContainer();
      const wires = scriptedFleet([heldRow(1)]);
      await sandbox.tcMountFleetRecovery(container, wires);
      await container.click({ fleetAction: 'select-all' });
      await container.click({ fleetAction: 'review' });
      let calls = wires.calls.length;
      await sandbox.tcMountFleetRecovery(container, wires);
      assert.match(container.innerHTML, /Review before clearing/);
      assert.equal(wires.calls.length, calls, 'reopening during a review reads nothing');

      await container.click({ fleetAction: 'clear' });
      const result = container.innerHTML;
      calls = wires.calls.length;
      await sandbox.tcMountFleetRecovery(container, wires);
      assert.equal(container.innerHTML, result, 'the result of a clear already sent is still on screen');
      assert.equal(wires.calls.length, calls);
    });

    it('asks again on reopening after a refusal, which is the way back in after signing in', async () => {
      const sandbox = lift();
      const container = fakeContainer();
      let refused = true;
      const wires = scriptedFleet([heldRow(1)], {
        intercept: () => (refused ? { status: 403, body: { code: 'LOGIN_GATE_REQUIRED', error: 'This install has no login.' } } : undefined)
      });
      await sandbox.tcMountFleetRecovery(container, wires);
      assert.match(container.innerHTML, /This install has no login\./);
      assert.deepEqual(actionsIn(container.innerHTML), []);
      refused = false;
      await sandbox.tcMountFleetRecovery(container, wires);
      assert.match(container.innerHTML, /project-1/);
    });

    it('is loaded by the dashboard after the escaper it uses and before the script that mounts it', () => {
      const index = read('index.html');
      const at = (needle) => {
        const i = index.indexOf(needle);
        assert.notEqual(i, -1, `${needle} is on the dashboard`);
        return i;
      };
      assert.ok(at('<script src="/api-helper.js">') < at('<script src="/fleet-recovery-panel.js">'));
      assert.ok(at('<script src="/fleet-recovery-panel.js">') < at('<script src="/ui.js">'));
      at('id="fleetRecoveryPanel"');
      assert.match(index, /id="fleetRecoveryToggle" aria-expanded="false" aria-controls="fleetRecoveryPanel"/);
      const sw = read('sw.js');
      assert.equal(sw.split('\'/fleet-recovery-panel.js\'').length - 1, 2,
        'the service worker precaches it and fetches it network-first, as it does the panels beside it');
    });

    describe('the dashboard\'s Recovery button', () => {
      /**
       * Lift `toggleFleetRecovery` out of ui.js and run it against a page.
       * @param {object|undefined} mount - `window.tcMountFleetRecovery`, or undefined for a page that has not loaded the panel
       * @returns {{toggle: Function, ids: object, mounts: Array}}
       */
      function page(mount) {
        const ui = read('ui.js');
        const start = ui.indexOf('function toggleFleetRecovery()');
        const end = ui.indexOf('// ── Project Master (chunk G, #331) ──');
        assert.ok(start !== -1 && end > start, 'the toggle is where this test lifts it from');
        const { doc, ids } = makeDocument(['fleetRecoveryPanel', 'fleetRecoveryToggle']);
        const ctx = { document: doc, window: {}, state: { fleetRecoveryOpen: false }, api: () => null, apiMutate: () => null };
        if (mount) ctx.window.tcMountFleetRecovery = mount;
        vm.createContext(ctx);
        vm.runInContext(ui.slice(start, end), ctx);
        return { toggle: ctx.toggleFleetRecovery, ids };
      }

      it('opens the panel and hands its container to the mount on each opening', () => {
        const mounts = [];
        const { toggle, ids } = page((container, deps) => { mounts.push({ container, deps }); return Promise.resolve({}); });
        toggle();
        assert.ok(ids.fleetRecoveryPanel.classList.contains('open'));
        assert.equal(ids.fleetRecoveryToggle.getAttribute('aria-expanded'), 'true');
        assert.equal(mounts.length, 1);
        assert.equal(mounts[0].container, ids.fleetRecoveryPanel);
        assert.equal(typeof mounts[0].deps.apiMutate, 'function', 'the write goes through the page\'s own helper, which carries the CSRF token');
        toggle();
        assert.ok(!ids.fleetRecoveryPanel.classList.contains('open'));
        assert.equal(ids.fleetRecoveryToggle.getAttribute('aria-expanded'), 'false');
        assert.equal(mounts.length, 1, 'closing reads nothing');
        toggle();
        assert.equal(mounts.length, 2, 'the mount decides what a reopening keeps');
      });

      it('opens an empty panel on a page that has not loaded the script', () => {
        const { toggle, ids } = page(undefined);
        assert.doesNotThrow(() => toggle());
        assert.ok(ids.fleetRecoveryPanel.classList.contains('open'));
      });
    });
  });
});
