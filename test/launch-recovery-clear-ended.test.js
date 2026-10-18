'use strict';

/**
 * `POST /api/sessions/:project/launch/recovery-clear` refuses a launch whose
 * session has ended (#2049).
 *
 * A clear lets a held session through its launch gate. Once the session is
 * killed, crashed or wrapped there is nothing to let through, and recording a
 * clearance for it would put an operator's name on a decision about a session
 * that no longer exists. The function's own contract is in
 * `launch-recovery-clear-one.test.js`; this file holds what a caller is told
 * over HTTP, on both kinds of install that can clear.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { handleRequest } = require('../server');
const fixture = require('./_recovery-fixture');
const { liftDeclaration } = require('./helpers/lift');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const LANDING_SRC = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');

/**
 * The panel's own recovery line for one row, run from `public/ui.js` with the
 * page's own `esc`.
 * @param {object} row - A sequence row as `GET /api/launch-sequences` returned it
 * @returns {string} Markup
 */
function panelRecoveryHtml(row) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(liftDeclaration(LANDING_SRC, 'function esc(str)'), ctx);
  vm.runInContext(liftDeclaration(UI_SRC, 'function launchClearanceLabel'), ctx);
  vm.runInContext(liftDeclaration(UI_SRC, 'function launchRecoveryHtml'), ctx);
  return ctx.launchRecoveryHtml(row, null);
}

/**
 * The launch a rendered Clear recovery button names, read the way the click
 * handler reads it.
 * @param {string} html - The panel's recovery markup
 * @returns {{sessionId: number, sequenceId: number, recoveryRevision: number}|null} Null when no button was rendered
 */
function bindingOnButton(html) {
  const m = /<button[^>]*data-launch-recovery-clear="(\d+)"[^>]*data-session-id="(\d+)"[^>]*data-recovery-revision="(\d+)"/.exec(html);
  return m ? { sequenceId: Number(m[1]), sessionId: Number(m[2]), recoveryRevision: Number(m[3]) } : null;
}

describe('the recovery-clear route and an ended session (#2049)', () => {
  let env;
  const client = fixture.makeClient(handleRequest);

  before(() => { env = fixture.openTempStore('tc-clear-ended-'); });
  after(() => { env.restore(); });
  beforeEach(() => { fixture.resetLogin(); });

  const clearUrl = (project) => `/api/sessions/${encodeURIComponent(project.name)}/launch/recovery-clear`;

  /**
   * Assert a response is the ended-session refusal and that nothing was cleared.
   * @param {object} res - The response
   * @param {object} held - The launch from the fixture
   * @returns {void}
   */
  function assertRefusedAsEnded(res, held) {
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(client.json(res).code, 'SESSION_ENDED');
    const stored = store.launchSequences.getBySession(held.sequence.sessionId);
    assert.equal(stored.recovery, 'required', 'nothing was cleared');
    assert.equal(stored.recoveryClearance, null);
    assert.deepEqual(
      store.activity.query({ projectId: held.project.id, eventType: 'launch.recovery-cleared', limit: 50 }), [],
      'no clearance was recorded');
  }

  it('open install: refuses a killed session\'s launch', async () => {
    const held = fixture.launchInRecovery(env);
    store.sessions.kill(held.sequence.sessionId, 'test');
    const token = await client.pageToken();
    const res = await client.send('POST', clearUrl(held.project), {
      body: held.binding, headers: { 'x-tc-open-token': token }
    });
    assertRefusedAsEnded(res, held);
  });

  it('armed install: refuses a crashed session\'s launch for a signed-in operator', async () => {
    const held = fixture.launchInRecovery(env);
    store.sessions.markCrashed(held.sequence.sessionId, 'test');
    client.arm();
    const { cookie, csrf } = await client.signIn();
    const res = await client.send('POST', clearUrl(held.project), {
      body: held.binding, headers: { cookie, 'x-csrf-token': csrf }
    });
    assertRefusedAsEnded(res, held);
  });

  it('keeps the stale answer for a moved revision on an ended session', async () => {
    const held = fixture.launchInRecovery(env);
    store.sessions.kill(held.sequence.sessionId, 'test');
    const token = await client.pageToken();
    const res = await client.send('POST', clearUrl(held.project), {
      body: { ...held.binding, recoveryRevision: held.binding.recoveryRevision + 1 },
      headers: { 'x-tc-open-token': token }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(client.json(res).code, 'STALE_RECOVERY');
  });

  it('still clears a launch whose session is active', async () => {
    const held = fixture.launchInRecovery(env);
    const token = await client.pageToken();
    const res = await client.send('POST', clearUrl(held.project), {
      body: held.binding, headers: { 'x-tc-open-token': token }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(client.json(res).recovery, 'cleared');
  });

  describe('the panel offers what the route will do (#2178)', () => {
    /**
     * The row the panel is given for one launch, read over HTTP.
     * @param {object} held - The launch from the fixture
     * @returns {Promise<object>} That launch's row from `GET /api/launch-sequences`
     */
    async function readRow(held) {
      const res = await client.send('GET', `/api/launch-sequences?projectId=${held.project.id}`);
      assert.equal(res.statusCode, 200, res.body);
      const row = client.json(res).sequences.find((s) => s.sequenceId === held.sequence.id);
      assert.ok(row, 'the held launch is in the listing');
      return row;
    }

    for (const [how, end] of [
      ['killed', (id) => store.sessions.kill(id, 'test')],
      ['crashed', (id) => store.sessions.markCrashed(id, 'test')],
      ['wrapped', (id) => store.sessions.wrap(id, 'test')]
    ]) {
      it(`a ${how} session: the panel renders no button, and the route refuses that launch as SESSION_ENDED`, async () => {
        const held = fixture.launchInRecovery(env);
        end(held.sequence.sessionId);
        const row = await readRow(held);
        assert.equal(row.sessionActive, false);
        const html = panelRecoveryHtml(row);
        assert.equal(bindingOnButton(html), null, 'no button is offered');
        assert.doesNotMatch(html, /Clear recovery/);
        assert.match(html, /Its session has ended, so there is nothing here to clear/);
        // What the absent button would have sent: the route's answer is the
        // reason the panel must not offer it.
        const token = await client.pageToken();
        const res = await client.send('POST', clearUrl(held.project), {
          body: held.binding, headers: { 'x-tc-open-token': token }
        });
        assertRefusedAsEnded(res, held);
      });
    }

    it('an active session: the panel renders the button, and the route clears the launch it names', async () => {
      const held = fixture.launchInRecovery(env);
      const row = await readRow(held);
      assert.equal(row.sessionActive, true);
      const binding = bindingOnButton(panelRecoveryHtml(row));
      assert.deepEqual(binding, held.binding, 'the button names the held launch');
      const token = await client.pageToken();
      const res = await client.send('POST', clearUrl(held.project), {
        body: binding, headers: { 'x-tc-open-token': token }
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(client.json(res).recovery, 'cleared');
      assert.equal(bindingOnButton(panelRecoveryHtml(await readRow(held))), null, 'a cleared launch offers nothing further');
    });

    it('a session that ends after the panel was read: the stale button is refused, and the re-read drops it', async () => {
      const held = fixture.launchInRecovery(env);
      const binding = bindingOnButton(panelRecoveryHtml(await readRow(held)));
      assert.ok(binding, 'the button was there while the session was active');
      store.sessions.kill(held.sequence.sessionId, 'test');
      const token = await client.pageToken();
      const res = await client.send('POST', clearUrl(held.project), {
        body: binding, headers: { 'x-tc-open-token': token }
      });
      assertRefusedAsEnded(res, held);
      assert.equal(bindingOnButton(panelRecoveryHtml(await readRow(held))), null,
        'the panel re-reads after a refusal, and this time the button is gone');
    });
  });

  it('proves the operator before it says anything about the session', async () => {
    // An ended session must not become a way to learn about a launch without
    // the proof: the unauthenticated answer is the same as for a live one.
    const held = fixture.launchInRecovery(env);
    store.sessions.kill(held.sequence.sessionId, 'test');
    client.arm();
    const res = await client.send('POST', clearUrl(held.project), { body: held.binding });
    assert.equal(res.statusCode, 401);
    assert.equal(client.json(res).code, 'UNAUTHENTICATED');
  });
});
