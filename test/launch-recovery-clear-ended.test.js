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
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { handleRequest } = require('../server');
const fixture = require('./_recovery-fixture');

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
