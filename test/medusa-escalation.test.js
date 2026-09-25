'use strict';

// #1839 chunk 04: the watchdog's escalation ladder. Every rung is reached once,
// from server time, recorded before its notice is sent, and routed by the
// operator-set escalation list on the recipient's control assignment, never by
// a role name. Notices are recorded queued, then accepted or failed, and a
// target that cannot receive one is undeliverable while the operator alert
// stands. Time is a fake clock throughout.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const mx = require('../lib/medusa-exchanges');
const watchdog = require('../lib/medusa-watchdog');
const control = require('../lib/control-state');
const registry = require('../lib/medusa-registry');
const sessions = require('../lib/sessions');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-25T12:00:00.000Z');

let tmpDir = null;
let pm;
let builder;
let sent;
let failNext;
let workspaces;
let activity;

/**
 * A project with a directory under the scratch store.
 * @param {string} name - Project name
 * @returns {object}
 */
function mkProject(name) {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir);
  return store.projects.create({ name, path: dir, engine: 'claude' });
}

/**
 * A message from the PM to the Builder, stored and delivered.
 * @param {object} [body] - Send body
 * @param {string} [hubId] - Hub id
 * @returns {object} The exchange row
 */
function pmToBuilder(body = { priority: 'blocking' }, hubId = 'hub-1') {
  const caller = { kind: 'project', projectId: pm.id };
  const x = mx.createSendIntent({
    meta: mx.validateSendMeta(body, caller, pm.id),
    sender: { projectId: pm.id, workspaceId: 'pm-ws' },
    recipient: { workspaceId: 'builder-ws', projectId: builder.id, sessionId: 2 }
  });
  mx.bindHubId(x.exchange_id, hubId);
  mx.recordArrival({ hubId, recipientWorkspaceId: 'builder-ws' });
  return store.medusaExchanges.get(x.exchange_id);
}

/**
 * Run one watchdog pass at a time and wait for its notices.
 * @param {number} ms - Epoch ms
 * @returns {Promise<object>}
 */
async function tickAt(ms) {
  const out = watchdog.tick(ms);
  await out.notices;
  return out;
}

/**
 * Give the Builder an assignment whose blocking/critical messages escalate to the PM.
 * @returns {void}
 */
function routeToPm() {
  control.create({
    projectId: builder.id, requestId: `req-${Math.random().toString(16).slice(2)}`,
    authority: { hold: [`project:${pm.id}`], escalation: { blocking: [`project:${pm.id}`], critical: [`project:${pm.id}`] } }
  }, { principal: 'operator', operatorProof: 'verified-session' });
}

const facts = (x) => store.medusaExchanges.facts(x.exchange_id);
const kinds = (x) => facts(x).map((f) => f.fact);

describe('medusa watchdog escalation (#1839 chunk 04)', () => {
  const saved = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-escalation-'));
    store._setBasePath(tmpDir);
    store.init();
    mx._internal.now = () => new Date(T0);
    pm = mkProject('pm');
    builder = mkProject('builder');
    sent = [];
    failNext = false;
    activity = [];
    workspaces = { [pm.id]: 'pm-ws-live' };
    Object.assign(saved, watchdog._internal);
    watchdog._internal.loadConfig = () => ({});
    watchdog._internal.sendSystemMessage = async (m) => {
      if (failNext) throw new Error('hub down');
      sent.push({ to: m.to, body: JSON.parse(m.message) });
      return { status: 'received' };
    };
    watchdog._internal.workspaceForProject = (id) => workspaces[id] || null;
    watchdog._internal.isLocalWorkspace = () => false;
    watchdog._internal.logActivity = (e) => activity.push(e);
  });

  afterEach(() => {
    Object.assign(watchdog._internal, saved);
    mx._internal.now = () => new Date();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('the escalation route lives on the control assignment', () => {
    it('accepts an operator-set route, refuses unknown keys and the target itself', () => {
      assert.deepEqual(control.normalizeAuthority({ escalation: { blocking: ['project:9'] } }, 5).escalation,
        { blocking: ['project:9'], critical: [] });
      assert.throws(() => control.normalizeAuthority({ escalation: { urgent: ['project:9'] } }, 5), /unknown key/);
      assert.throws(() => control.normalizeAuthority({ escalation: { blocking: ['project:5'] } }, 5), /own escalation route/);
      assert.throws(() => control.normalizeAuthority({ escalation: { blocking: ['the-pm'] } }, 5));
      assert.equal(control.normalizeAuthority({}, 5).escalation, undefined, 'an assignment without a route reads as before');
    });

    it('resolves the route from the recipient project, and an ungoverned project has none', () => {
      assert.deepEqual(control.escalationRouteFor(builder.id, 'blocking'), { controlState: 'ungoverned', stateGeneration: null, principals: [] });
      routeToPm();
      assert.deepEqual(control.escalationRouteFor(builder.id, 'blocking'),
        { controlState: 'active', stateGeneration: 1, principals: [`project:${pm.id}`] });
    });
  });

  describe('the ladder', () => {
    it('ages, escalates to the route, then alerts the operator, each once, from server time', async () => {
      routeToPm();
      const x = pmToBuilder();
      await tickAt(T0 + 4 * MIN);
      assert.equal(sent.length, 0, 'nothing before the aged threshold');

      await tickAt(T0 + 5 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'aged');
      assert.deepEqual(sent.map((s) => [s.to, s.body.level, s.body.to]), [['pm-ws-live', 'aged', 'sender']]);

      await tickAt(T0 + 15 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'escalated');
      const escal = sent.filter((s) => s.body.level === 'escalated');
      assert.deepEqual(escal.map((s) => s.body.to).sort(), ['escalation', 'sender']);
      assert.equal(escal.find((s) => s.body.to === 'escalation').body.controlState, 'active');

      await tickAt(T0 + 16 * MIN);
      await tickAt(T0 + 16 * MIN);
      assert.equal(sent.length, 3, 'duplicate ticks send nothing more');

      await tickAt(T0 + 60 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'operator');
      assert.equal(activity.length, 1);
      assert.equal(activity[0].eventType, 'medusa-escalation');
      assert.equal(kinds(x).filter((k) => k === 'operator_alerted').length, 1);
    });

    it('records each notice queued then accepted, never "delivered", and a failure as failed', async () => {
      routeToPm();
      const x = pmToBuilder();
      await tickAt(T0 + 5 * MIN);
      const k = kinds(x);
      assert.ok(k.indexOf('escalation_queued') < k.indexOf('escalation_accepted'));
      assert.equal(facts(x).find((f) => f.fact === 'escalation_accepted').detail_json.includes('"hubStatus":"received"'), true);

      failNext = true;
      await tickAt(T0 + 15 * MIN);
      assert.ok(kinds(x).includes('escalation_failed'));
      await tickAt(T0 + 60 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'operator', 'a failed notice does not stop the operator alert');
    });

    it('with no route, escalates to the operator at the escalation threshold and records why', async () => {
      const x = pmToBuilder();
      await tickAt(T0 + 15 * MIN);
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.esc_level, 'operator');
      assert.ok(facts(x).some((f) => f.fact === 'escalation_undeliverable' && f.detail_json.includes('no-escalation-route')));
      assert.equal(activity[0].detail.reason, 'no-escalation-route');
    });

    it('records a route target with no live session as undeliverable, and still alerts the operator later', async () => {
      routeToPm();
      delete workspaces[pm.id];
      const x = pmToBuilder();
      await tickAt(T0 + 15 * MIN);
      const undeliverable = facts(x).filter((f) => f.fact === 'escalation_undeliverable');
      assert.ok(undeliverable.length >= 1);
      await tickAt(T0 + 60 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'operator');
    });

    it('lets a sender only shorten its own escalation', async () => {
      routeToPm();
      const x = pmToBuilder({ priority: 'blocking', escalateAfterMinutes: 3 });
      await tickAt(T0 + 3 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'escalated');
    });

    it('escalates critical mail at once, and the operator five minutes later', async () => {
      routeToPm();
      const caller = { kind: 'operator', proof: 'verified-session' };
      const intent = mx.createSendIntent({
        meta: mx.validateSendMeta({ priority: 'critical' }, caller, null),
        sender: { projectId: null, workspaceId: 'op-ws' },
        recipient: { workspaceId: 'builder-ws', projectId: builder.id }
      });
      mx.bindHubId(intent.exchange_id, 'hub-c');
      await tickAt(T0);
      assert.equal(store.medusaExchanges.get(intent.exchange_id).esc_level, 'escalated');
      await tickAt(T0 + 5 * MIN);
      assert.equal(store.medusaExchanges.get(intent.exchange_id).esc_level, 'operator');
    });

    it('ages normal mail and never escalates it', async () => {
      routeToPm();
      const x = pmToBuilder({});
      await tickAt(T0 + 29 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'none');
      await tickAt(T0 + 30 * MIN);
      await tickAt(T0 + 24 * 60 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'aged');
      assert.equal(activity.length, 0);
    });

    it('measures an acknowledged-but-unanswered reply from the ack, and stops once replied', async () => {
      routeToPm();
      const x = pmToBuilder();
      mx._internal.now = () => new Date(T0 + 2 * MIN);
      mx.recordAcknowledged(['hub-1'], 'builder-ws', { kind: 'project', projectId: builder.id });
      await tickAt(T0 + 31 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'none', 'nothing for 30 minutes after the ack, not even the sender');
      assert.equal(sent.length, 0);
      await tickAt(T0 + 32 * MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'escalated');
      assert.deepEqual(sent.map((s) => s.body.level).sort(), ['aged', 'escalated', 'escalated'], 'sender and route are told together');

      const y = pmToBuilder({ priority: 'blocking' }, 'hub-2');
      mx.recordAcknowledged(['hub-2'], 'builder-ws', { kind: 'project', projectId: builder.id });
      const reply = mx.createSendIntent({
        meta: mx.validateSendMeta({ inReplyTo: 'hub-2' }, { kind: 'project', projectId: builder.id }, builder.id),
        sender: { projectId: builder.id }, recipient: { workspaceId: 'pm-ws', projectId: pm.id }
      });
      mx.bindHubId(reply.exchange_id, 'hub-r');
      await tickAt(T0 + 24 * 60 * MIN);
      assert.equal(store.medusaExchanges.get(y.exchange_id).esc_level, 'none', 'a replied exchange awaits its initiator, not escalation');
    });

    it('escalates an exchange whose re-arm budget is spent, without waiting out the age', async () => {
      routeToPm();
      watchdog._internal.loadConfig = () => ({ medusaWatchdog: { maxRearms: 0 } });
      const x = pmToBuilder();
      mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux' });
      await tickAt(T0 + MIN);
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'escalated');
    });

    it('never escalates a retracted or closed exchange', async () => {
      routeToPm();
      pmToBuilder();
      mx.retract('hub-1', { kind: 'project', projectId: pm.id }, { reason: 'superseded' });
      const y = pmToBuilder({ priority: 'blocking' }, 'hub-2');
      mx.close(y.exchange_id, { kind: 'project', projectId: pm.id });
      await tickAt(T0 + 24 * 60 * MIN);
      assert.equal(sent.length, 0);
      assert.equal(activity.length, 0);
    });

    it('carries ids, ages, codes and names in a notice, never the message text', async () => {
      routeToPm();
      pmToBuilder();
      await tickAt(T0 + 5 * MIN);
      const body = sent[0].body;
      assert.equal(body.event, 'medusa_escalation');
      assert.equal(body.recipient, 'builder');
      assert.equal(body.priority, 'blocking');
      assert.equal(typeof body.ageMinutes, 'number');
      assert.ok(!('message' in body));
    });
  });

  describe('held recipients', () => {
    it('names the recipient\'s control state and generation in the escalation notice', async () => {
      routeToPm();
      const asg = store.control.getOpenForProject(builder.id);
      control.hold({ assignmentId: asg.assignment_id, requestId: 'hold-1', reasonCode: 'awaiting-ruling' },
        { principal: `project:${pm.id}` });
      pmToBuilder();
      await tickAt(T0 + 15 * MIN);
      const notice = sent.find((s) => s.body.to === 'escalation');
      assert.equal(notice.body.controlState, 'held');
      assert.equal(notice.body.controlGeneration, store.control.getOpenForProject(builder.id).state_generation);
    });
  });

  describe('retired recipients (C11)', () => {
    it('ends open exchanges to a retired workspace and tells each initiator', async () => {
      const x = pmToBuilder();
      await watchdog.retireRecipient('builder-ws');
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'recipient_retired');
      assert.deepEqual(sent.map((s) => [s.to, s.body.level]), [['pm-ws-live', 'recipient_retired']]);
    });

    it('leaves an answered exchange for its initiator when the recipient retires', async () => {
      const x = pmToBuilder();
      const reply = mx.createSendIntent({
        meta: mx.validateSendMeta({ inReplyTo: 'hub-1' }, { kind: 'project', projectId: builder.id }, builder.id),
        sender: { projectId: builder.id }, recipient: { workspaceId: 'pm-ws', projectId: pm.id }
      });
      mx.bindHubId(reply.exchange_id, 'hub-r');
      await watchdog.retireRecipient('builder-ws');
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'replied', 'still awaiting its initiator\'s close');
      assert.equal(sent.length, 0, 'nobody is told the recipient left');
    });

    it('session teardown retires its workspace, so no exchange waits on a session that will not return', async () => {
      const session = { id: 42 };
      const ws = registry.ensureWorkspaceId(builder.path, session.id, builder.name);
      const x = mx.createSendIntent({
        meta: mx.validateSendMeta({ priority: 'blocking' }, { kind: 'project', projectId: pm.id }, pm.id),
        sender: { projectId: pm.id }, recipient: { workspaceId: ws, projectId: builder.id }
      });
      mx.bindHubId(x.exchange_id, 'hub-t');
      sessions._teardownMedusa(builder, session);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'recipient_retired');
      assert.equal(registry.getWorkspaceId(builder.path, session.id), null, 'the workspace was forgotten as before');
    });
  });

  describe('what the operator sees', () => {
    it('lists escalated exchanges with names, age and blocker, and summarizes only operator-level or critical ones', async () => {
      routeToPm();
      pmToBuilder();
      await tickAt(T0 + 5 * MIN);
      assert.equal(watchdog.listEscalations(T0 + 5 * MIN).length, 1);
      assert.equal(watchdog.escalationSummary(T0 + 5 * MIN), null, 'merely aged mail raises no banner');
      await tickAt(T0 + 60 * MIN);
      const summary = watchdog.escalationSummary(T0 + 60 * MIN);
      assert.equal(summary.count, 1);
      assert.equal(summary.oldest.recipient, 'builder');
      assert.equal(summary.oldest.ageMinutes, 60);
    });

    it('renders the dashboard banner with text nodes only, and clears it when nothing is escalated', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
      const start = src.indexOf('function renderMedusaEscalationBanner(');
      let depth = 0;
      let end = -1;
      for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
      }
      const fn = src.slice(start, end);
      const el = (id) => ({
        id, _hidden: true, children: [],
        classList: { add(c) { if (c === 'hidden') this._o._hidden = true; }, remove(c) { if (c === 'hidden') this._o._hidden = false; } },
        replaceChildren(...kids) { this.children = kids; }
      });
      const banner = el('b');
      banner.classList._o = banner;
      const text = el('t');
      text.classList._o = text;
      const document = {
        getElementById: (id) => (id === 'medusaEscalationBanner' ? banner : id === 'medusaEscalationBannerText' ? text : null),
        createElement: () => ({ textContent: '' }),
        createTextNode: (t) => ({ textContent: t })
      };
      const ctx = vm.createContext({ document });
      vm.runInContext(`${fn}\nrenderMedusaEscalationBanner(summary);`, Object.assign(ctx, {
        summary: { count: 2, oldest: { priority: 'blocking', ageMinutes: 47, recipient: '<img src=x>', blocker: 'pane-composer-has-input', blockerMeaning: null } }
      }));
      assert.equal(banner._hidden, false);
      const rendered = text.children.map((c) => c.textContent).join('');
      assert.match(rendered, /Medusa: 2 messages need attention\. Oldest: blocking, 47 min, to <img src=x>, blocked by pane-composer-has-input\./);
      assert.equal(text.innerHTML, undefined, 'never written as HTML');
      vm.runInContext(`${fn}\nrenderMedusaEscalationBanner(null);`, ctx);
      assert.equal(banner._hidden, true);
    });
  });
});
