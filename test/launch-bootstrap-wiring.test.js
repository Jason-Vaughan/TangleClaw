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
  let rawKeys;
  let ledger;
  const real = {};

  // A markerless engine with no wake profile: the paste, when it runs, is a
  // fixed short delay away rather than gated on a pane these tests do not have.
  const ENGINE = 'fake-engine';
  const PROFILE = Object.freeze({ capabilities: { supportsPrimePrompt: true }, launch: { startupDelay: 5 } });
  // Codex's real shape: engine-level preKeys that would dismiss a dialog.
  const PROFILE_WITH_PREKEYS = Object.freeze({ capabilities: { supportsPrimePrompt: true }, launch: { startupDelay: 5, preKeys: ['Enter', 'Enter'], preKeyDelay: 5 } });

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bootstrap-wiring-'));
    store._setBasePath(tmpDir);
    store.init();
    sessions = require('../lib/sessions');
    real.bootstrap = launchBootstrap.bootstrap;
    real.kickoff = launchKickoff.kickoff;
    real.sendKeys = tmux.sendKeys;
    real.sendRawKey = tmux.sendRawKey;
    real.hasSession = tmux.hasSession;
    real.probe = tmux.probeSession;
    real.capture = tmux.capturePane;
    real.record = store.sessionRuleDeliveries.record;
  });

  after(() => {
    Object.assign(launchBootstrap, { bootstrap: real.bootstrap });
    launchKickoff.kickoff = real.kickoff;
    tmux.sendKeys = real.sendKeys;
    tmux.sendRawKey = real.sendRawKey;
    tmux.hasSession = real.hasSession;
    tmux.probeSession = real.probe;
    tmux.capturePane = real.capture;
    store.sessionRuleDeliveries.record = real.record;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    bootstraps = [];
    kickoffs = [];
    pastes = [];
    rawKeys = [];
    ledger = [];
    launchBootstrap.bootstrap = (args) => { bootstraps.push(args); return Promise.resolve('fired'); };
    launchKickoff.kickoff = (args) => { kickoffs.push(args); return Promise.resolve('sent'); };
    tmux.sendKeys = (name, text) => { pastes.push({ name, text }); return true; };
    tmux.sendRawKey = (name, key) => { rawKeys.push({ name, key }); return true; };
    tmux.hasSession = () => true;
    tmux.probeSession = () => ({ answered: true, live: true });
    store.sessionRuleDeliveries.record = (entry) => { ledger.push(entry); return entry; };
  });

  afterEach(() => {
    launchBootstrap.bootstrap = real.bootstrap;
    launchKickoff.kickoff = real.kickoff;
    tmux.sendKeys = real.sendKeys;
    tmux.sendRawKey = real.sendRawKey;
    tmux.hasSession = real.hasSession;
    tmux.probeSession = real.probe;
    tmux.capturePane = real.capture;
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

  it('a native launch gets no preKeys either: a keystroke that would accept a trust dialog is exactly what F2 refuses', async () => {
    sessions._deferEngineInit(
      'tc-b1', 'TangleClaw-Builder1', ENGINE, PROFILE_WITH_PREKEYS,
      'the prime', null, false, null,
      { sessionId: 99, projectId: 3, hasSequence: true, startupDelivery: 'native' }
    );
    await settle();
    assert.deepEqual(rawKeys, [], 'nothing is typed into a native pane, preKeys included');
    assert.deepEqual(pastes, []);
    assert.equal(bootstraps.length, 1);

    rawKeys = [];
    sessions._deferEngineInit(
      'tc-b1', 'TangleClaw-Builder1', ENGINE, PROFILE_WITH_PREKEYS,
      'the prime', null, false, null,
      { sessionId: 98, projectId: 3, hasSequence: true, startupDelivery: 'legacy' }
    );
    // The second preKey is scheduled 500 ms after the first, as it always was.
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.deepEqual(rawKeys.map((k) => k.key), ['Enter', 'Enter'], 'the legacy launch keeps its preKeys exactly as before');
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

  describe('an engine that declares guarded dialogs is never typed into while one is up (#2177)', () => {
    const PROMPTS = [{ id: 'update', match: 'Update available', humanAction: 'Skip it with Escape.' }];
    const DECLARING = Object.freeze({ name: 'Fake', capabilities: { supportsPrimePrompt: true }, launch: { startupDelay: 5, guardedDialogs: PROMPTS } });
    const DECLARING_WITH_PREKEYS = Object.freeze({ name: 'Fake', capabilities: { supportsPrimePrompt: true }, launch: { startupDelay: 5, preKeys: ['Enter', 'Enter'], preKeyDelay: 5, guardedDialogs: PROMPTS } });
    const UPDATE_PROMPT = ['> ', '  Update available · 1 → 2', '> 1. Update now', '  enter continue · esc skip'];
    const LEGACY = { sessionId: 99, projectId: 3, hasSequence: true, startupDelivery: 'legacy' };

    it('the prime is not pasted into a declared prompt, and the ledger says which prompt and what to do', async () => {
      tmux.capturePane = () => ({ lines: UPDATE_PROMPT });
      sessions._deferEngineInit('tc-b1', 'TangleClaw-Builder1', ENGINE, DECLARING, 'the prime', null, false, { ...DELIVERY }, LEGACY);
      await settle();

      assert.deepEqual(pastes, [], 'a paste ends in Enter, and Enter takes the prompt\'s default');
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].channel, 'prime-paste');
      assert.equal(ledger[0].outcome, 'skipped');
      assert.match(ledger[0].skipReason, /Fake is showing its update prompt, which TangleClaw does not answer/);
      assert.match(ledger[0].skipReason, /Skip it with Escape\./);
    });

    it('the prime is not pasted blind into a screen the launch cannot recognise', async () => {
      tmux.capturePane = () => ({ lines: ['Signing in…'] });
      sessions._deferEngineInit('tc-b1', 'TangleClaw-Builder1', ENGINE, DECLARING, 'the prime', null, false, { ...DELIVERY }, LEGACY);
      await settle();

      assert.deepEqual(pastes, []);
      assert.equal(ledger[0].outcome, 'skipped');
      assert.match(ledger[0].skipReason, /never observed ready/);
    });

    it('the prime is not pasted when the pane cannot be read', async () => {
      // What `tmux.capturePane` really answers when `tmux capture-pane` fails.
      tmux.capturePane = () => ({ lines: [], alternateScreen: false });
      sessions._deferEngineInit('tc-b1', 'TangleClaw-Builder1', ENGINE, DECLARING, 'the prime', null, false, { ...DELIVERY }, LEGACY);
      await settle();

      assert.deepEqual(pastes, []);
      assert.match(ledger[0].skipReason, /could not be read, so nothing was typed/);
    });

    it('a preKey is withheld while a declared prompt is up, and sent once it is not', async () => {
      tmux.capturePane = () => ({ lines: UPDATE_PROMPT });
      sessions._deferEngineInit('tc-b1', 'TangleClaw-Builder1', ENGINE, DECLARING_WITH_PREKEYS, null, null, false, null, LEGACY);
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.deepEqual(rawKeys, [], 'no Enter reaches the update prompt');

      tmux.capturePane = () => ({ lines: ['some other dialog'] });
      sessions._deferEngineInit('tc-b1', 'TangleClaw-Builder1', ENGINE, DECLARING_WITH_PREKEYS, null, null, false, null, { ...LEGACY, sessionId: 98 });
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.deepEqual(rawKeys.map((k) => k.key), ['Enter', 'Enter'], 'a preKey still answers the screen its profile wrote it for');
    });

    it('a preKey is withheld when the pane cannot be read', async () => {
      tmux.capturePane = () => ({ lines: [], alternateScreen: false });
      sessions._deferEngineInit('tc-b1', 'TangleClaw-Builder1', ENGINE, DECLARING_WITH_PREKEYS, null, null, false, null, LEGACY);
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.deepEqual(rawKeys, []);
    });

    it('a profile whose guarded dialog cannot be read gets no preKey and no paste, even over a composer', async () => {
      const BROKEN = Object.freeze({ name: 'Fake', capabilities: { supportsPrimePrompt: true }, launch: { startupDelay: 5, preKeys: ['Enter'], preKeyDelay: 5, guardedDialogs: [{ id: 'update', match: 'Update available (' }] } });
      tmux.capturePane = () => ({ lines: ['> '] });
      sessions._deferEngineInit('tc-b1', 'TangleClaw-Builder1', ENGINE, BROKEN, 'the prime', null, false, { ...DELIVERY }, LEGACY);
      // The paste is scheduled after the preKey slot, as on any launch with preKeys.
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.deepEqual(rawKeys, [], 'the key would have answered the prompt the broken entry named');
      assert.deepEqual(pastes, []);
      assert.match(ledger[0].skipReason, /could not read/);
    });

    it('an engine that declares none keeps its paste without its pane being read', async () => {
      let reads = 0;
      tmux.capturePane = () => { reads++; return { lines: UPDATE_PROMPT }; };
      sessions._deferEngineInit('tc-b1', 'TangleClaw-Builder1', ENGINE, PROFILE, 'the prime', null, false, { ...DELIVERY }, LEGACY);
      await settle();
      assert.equal(pastes.length, 1);
      assert.equal(reads, 0);
    });
  });
});

/** A tmux server identity as `tmux.createSession` reports it: `<pid>.<start time>`. */
const SRV = '4242.1790431343';

describe('a launch records the pane it created on its channel (#2186)', () => {
  const sessions = require('../lib/sessions');

  it('writes the pane id it is handed into the channel\'s adapter state', () => {
    const writes = [];
    const got = sessions._recordLaunchPane({ id: 41 }, { paneId: '%12', server: SRV }, { setAdapterState: (id, patch) => writes.push([id, patch]) });
    assert.equal(got, '%12');
    assert.deepEqual(writes, [[41, { paneId: '%12', paneServer: SRV }]]);
  });

  it('records nothing, and does not throw, when no usable pane id came from creation or the write fails: the launch goes on', () => {
    const writes = [];
    for (const bad of [undefined, null, '', '12', '%', 'tc-b1', '%12 ', 12]) {
      assert.equal(sessions._recordLaunchPane({ id: 41 }, { paneId: bad, server: SRV }, { setAdapterState: (id, patch) => writes.push([id, patch]) }), null, String(bad));
    }
    // A pane id with no usable tmux server beside it is not recorded either: the id alone can recur.
    for (const bad of [undefined, null, '', '4242', '4242.', 'x.1', 4242.1]) {
      assert.equal(sessions._recordLaunchPane({ id: 41 }, { paneId: '%12', server: bad }, { setAdapterState: (id, patch) => writes.push([id, patch]) }), null, String(bad));
    }
    for (const bad of [undefined, null, '%12']) {
      assert.equal(sessions._recordLaunchPane({ id: 41 }, bad, { setAdapterState: (id, patch) => writes.push([id, patch]) }), null, String(bad));
    }
    assert.deepEqual(writes, []);
    assert.equal(sessions._recordLaunchPane({ id: 41 }, { paneId: '%12', server: SRV }, { setAdapterState: () => { throw new Error('db locked'); } }), null);
  });

  it('records nothing for a launch with no channel row', () => {
    let wrote = 0;
    assert.equal(sessions._recordLaunchPane(null, { paneId: '%12', server: SRV }, { setAdapterState: () => { wrote += 1; } }), null);
    assert.equal(wrote, 0);
  });
});

describe('attaching a launch\'s channel records its pane on the stored row (#2186)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../lib/store');
  const tmux = require('../lib/tmux');
  const sessions = require('../lib/sessions');
  let tmpDir;
  let realSole;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-attach-pane-'));
    store._setBasePath(tmpDir);
    store.init();
    realSole = tmux.solePaneId;
  });

  after(() => {
    tmux.solePaneId = realSole;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A channel as `_prepareStartupChannel` hands it over, whose adapter records the row for real. */
  const prepared = (sessionId) => ({
    handle: { state: { pid: 1, socketPath: '/x' } },
    adapterName: 'codex',
    adapter: { attachLaunch: (handle, launch) => store.startupControlChannels.open({ sessionId: launch.sessionId, sequenceId: launch.sequenceId, engineId: launch.engineId, adapter: 'codex', adapterState: handle.state }) }
  });

  it('the row the launch stores carries the pane id creation printed, beside what the adapter recorded, and the session is never asked for its pane', () => {
    let asked = 0;
    tmux.solePaneId = () => { asked += 1; return '%99'; };
    sessions._attachStartupChannel(prepared(501), { id: 501, tmuxSession: 'tc-proj' }, 'codex', { paneId: '%31', server: SRV });
    const row = store.startupControlChannels.getOpenBySession(501);
    assert.equal(asked, 0);
    assert.equal(row.adapterState.paneId, '%31');
    assert.equal(row.adapterState.paneServer, SRV, 'with the tmux server that issued it');
    assert.equal(row.adapterState.socketPath, '/x', 'the adapter\'s own state is kept');
  });

  it('a later adapter write (the thread, the server version) does not lose the pane id', () => {
    sessions._attachStartupChannel(prepared(502), { id: 502, tmuxSession: 'tc-proj2' }, 'codex', { paneId: '%32', server: SRV });
    const row = store.startupControlChannels.getOpenBySession(502);
    store.startupControlChannels.setAdapterState(row.id, { threadId: 't-1' });
    store.startupControlChannels.setAdapterState(row.id, { serverVersion: '0.156.1' });
    assert.equal(store.startupControlChannels.get(row.id).adapterState.paneId, '%32');
    assert.equal(store.startupControlChannels.get(row.id).adapterState.paneServer, SRV);
  });

  it('a launch whose creation printed no pane id still gets its channel, with no pane on record', () => {
    tmux.solePaneId = () => '%99';
    sessions._attachStartupChannel(prepared(503), { id: 503, tmuxSession: 'tc-proj3' }, 'codex', { paneId: null, server: null });
    const row = store.startupControlChannels.getOpenBySession(503);
    assert.ok(row, 'the launch is not failed by it');
    assert.equal(row.adapterState.paneId, undefined, 'and the session\'s current pane is not recorded in its place');
  });

  it('REPLACEMENT BETWEEN CREATION AND ATTACH: the session\'s only pane is already a replacement when the channel is attached; the record stays the created pane and the witness refuses the replacement', async () => {
    // Creation printed %31. Before the channel was attached the session was
    // split and %31 killed, so the session's one pane is now %40.
    tmux.solePaneId = () => '%40';
    sessions._attachStartupChannel(prepared(504), { id: 504, tmuxSession: 'tc-proj4' }, 'codex', { paneId: '%31', server: SRV });
    const row = store.startupControlChannels.getOpenBySession(504);
    assert.equal(row.adapterState.paneId, '%31', 'the replacement is not recorded as the launch\'s pane');

    const reads = [];
    const seen = await require('../lib/pane-witness').composerShown({
      tmuxName: 'tc-proj4', paneId: row.adapterState.paneId, paneServer: row.adapterState.paneServer, engineProfile: {},
      wakeProfile: require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex
    }, { gapMs: 0, sleep: async () => {}, read: (name, id) => { reads.push(id); return null; } });
    assert.deepEqual(seen, { shown: false, dialog: null, why: 'the session\'s pane is not the pane this launch created', lasting: true });
    assert.deepEqual(reads, [], 'the replacement pane is never read');
  });
});
