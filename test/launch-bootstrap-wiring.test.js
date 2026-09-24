'use strict';

/*
 * The hop between the launch path and the bootstrap (#1825 B3).
 *
 * `test/launch-bootstrap.test.js` proves the module decides correctly; these
 * prove the launch calls it with the launch's own facts, that a native launch
 * withholds the paste and the kickoff, that its inline-rules ledger row reads
 * `skipped`, and that a legacy launch keeps both while still being recorded.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const launchBootstrap = require('../lib/launch-bootstrap');
const launchKickoff = require('../lib/launch-kickoff');

describe('the launch path reaches the bootstrap (#1825 B3)', () => {
  let tmpDir;
  let sessions;
  let bootstraps;
  let kickoffs;
  let pastes;
  let ledger;
  const real = {};

  // A markerless engine with no wake profile: the paste, when it runs, is a
  // fixed short delay away rather than gated on a pane these tests do not have.
  const ENGINE = 'fake-engine';
  const PROFILE = Object.freeze({ capabilities: { supportsPrimePrompt: true }, launch: { startupDelay: 5 } });

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bootstrap-wiring-'));
    store._setBasePath(tmpDir);
    store.init();
    sessions = require('../lib/sessions');
    real.bootstrap = launchBootstrap.bootstrap;
    real.kickoff = launchKickoff.kickoff;
    real.sendKeys = tmux.sendKeys;
    real.probe = tmux.probeSession;
    real.record = store.sessionRuleDeliveries.record;
  });

  after(() => {
    Object.assign(launchBootstrap, { bootstrap: real.bootstrap });
    launchKickoff.kickoff = real.kickoff;
    tmux.sendKeys = real.sendKeys;
    tmux.probeSession = real.probe;
    store.sessionRuleDeliveries.record = real.record;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    bootstraps = [];
    kickoffs = [];
    pastes = [];
    ledger = [];
    launchBootstrap.bootstrap = (args) => { bootstraps.push(args); return Promise.resolve('fired'); };
    launchKickoff.kickoff = (args) => { kickoffs.push(args); return Promise.resolve('sent'); };
    tmux.sendKeys = (name, text) => { pastes.push({ name, text }); return true; };
    tmux.probeSession = () => ({ answered: true, live: true });
    store.sessionRuleDeliveries.record = (entry) => { ledger.push(entry); return entry; };
  });

  afterEach(() => {
    launchBootstrap.bootstrap = real.bootstrap;
    launchKickoff.kickoff = real.kickoff;
    tmux.sendKeys = real.sendKeys;
    tmux.probeSession = real.probe;
    store.sessionRuleDeliveries.record = real.record;
  });

  /** Let the deferred timers fire. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  const DELIVERY = Object.freeze({ sessionId: 99, projectId: 3, engineId: ENGINE, kind: 'startup', ruleIds: [1], digest: 'd' });

  it('a native launch is bootstrapped, never pasted, never kicked off, and its inline-rules row reads skipped', async () => {
    sessions._deferEngineInit(
      'tc-b1', 'TangleClaw-Builder1', ENGINE, PROFILE,
      'the prime with rules inline', null, false, { ...DELIVERY },
      { sessionId: 99, projectId: 3, hasSequence: true, startupDelivery: 'native' }
    );
    await settle();

    assert.equal(bootstraps.length, 1);
    assert.deepEqual(bootstraps[0], {
      sessionId: 99, projectId: 3, projectName: 'TangleClaw-Builder1', tmuxName: 'tc-b1',
      engineId: ENGINE, hasSequence: true, startupDelivery: 'native'
    });
    assert.deepEqual(kickoffs, [], 'the kickoff is a keystroke and the native pane gets none');
    assert.deepEqual(pastes, [], 'the prime is not pasted: the fired prompt asks the engine to read it');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].channel, 'none');
    assert.equal(ledger[0].outcome, 'skipped');
    assert.equal(ledger[0].skipReason, store.RULES_SERVED_BY_LAUNCH_SEQUENCE);
  });

  it('a legacy launch keeps its paste and its kickoff, and is still handed to the bootstrap to be recorded', async () => {
    sessions._deferEngineInit(
      'tc-b1', 'TangleClaw-Builder1', ENGINE, PROFILE,
      'the prime', null, false, { ...DELIVERY },
      { sessionId: 99, projectId: 3, hasSequence: true, startupDelivery: 'legacy' }
    );
    await settle();

    assert.equal(bootstraps.length, 1);
    assert.equal(bootstraps[0].startupDelivery, 'legacy');
    assert.equal(kickoffs.length, 1, 'the kickoff decides for itself (here: not-silent)');
    assert.equal(pastes.length, 1, 'the paste is the legacy first turn');
    assert.equal(pastes[0].text, 'the prime');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].channel, 'prime-paste', 'the paste records its own delivery as before');
  });

  it('a launch that never said which path it took is the keystroke path', async () => {
    sessions._deferEngineInit(
      'tc-b1', 'TangleClaw-Builder1', ENGINE, PROFILE,
      'the prime', null, true, null,
      { sessionId: 99, projectId: 3, hasSequence: true }
    );
    await settle();
    assert.equal(bootstraps[0].startupDelivery, 'legacy');
    assert.equal(kickoffs.length, 1);
  });

  it('does not bootstrap a caller that is not launching a session', async () => {
    sessions._deferEngineInit('tc-b1', 'TangleClaw-Builder1', ENGINE, PROFILE, 'the prime', null, false, null, null);
    await settle();
    assert.deepEqual(bootstraps, []);
  });
});
