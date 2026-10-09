'use strict';

/*
 * The launch-isolation inventory (#2233): for every live session, whether the
 * command its pane was started with shows it was kept off the engine's shared
 * background process. Everything here runs on injected reads: no tmux, no
 * store, no engine.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const codex = require('../lib/startup-control-codex');
const inventory = require('../lib/launch-isolation-inventory');
const sessions = require('../lib/sessions');
const bridgeHandoff = require('../lib/bridge-handoff');

const BIN = '/opt/fake/bin/codex';
const SOCKET = '/private/tmp/codex-daemon-501/abc123';
const CHANNEL = { resolvedSocketPath: SOCKET, enginePath: BIN, engineVersion: '0.156.1' };
const VERIFIED = ['0.156.1'];

/**
 * Judge one recorded Codex command.
 * @param {string} command - The engine command
 * @param {object} [over] - Other inputs
 * @returns {object}
 */
function recorded(command, over = {}) {
  return codex.judgeRecordedCommand({ engineId: 'codex', command, channel: CHANNEL, nativeVerifiedVersions: VERIFIED, ...over });
}

describe('judgeRecordedCommand: was a running Codex session started isolated (#2233)', () => {
  it('isolated: attached to the server this session\'s own channel records, on a verified version', () => {
    const v = recorded(`${BIN} --remote unix://${SOCKET} --dangerously-bypass-approvals-and-sandbox`);
    assert.deepEqual({ applies: v.applies, verdict: v.verdict, basis: v.basis, reasonCode: v.reasonCode }, { applies: true, verdict: 'isolated', basis: 'native-app-server', reasonCode: null });
    assert.match(v.reason, /0\.156\.1/);
  });

  it('isolated: the exact executable with --no-daemon, and it says the version is not re-checked', () => {
    const v = recorded(`${BIN} --full-auto --no-daemon`, { channel: null });
    assert.deepEqual({ verdict: v.verdict, basis: v.basis }, { verdict: 'isolated', basis: 'no-daemon' });
    assert.match(v.reason, /checked when it was launched and is not checked again/);
  });

  it('isolated: an executable path that needed quoting', () => {
    const spaced = '/opt/my tools/bin/codex';
    const v = recorded(`'${spaced}' --no-daemon`, { channel: null });
    assert.equal(v.verdict, 'isolated');
  });

  for (const [label, command, over, code] of [
    ['the bare command name with --no-daemon, as launches were made before the judgment', 'codex --full-auto --no-daemon', { channel: null }, 'command_not_pinned'],
    ['the bare command name attached to its own server', `codex --remote unix://${SOCKET}`, {}, 'command_not_pinned'],
    ['a bare codex with nothing else', 'codex', { channel: null }, 'command_not_pinned'],
    ['the exact executable with neither flag', `${BIN} --full-auto`, { channel: null }, 'command_unisolated'],
    ['attached to a socket other than the one recorded for this session', `${BIN} --remote unix:///private/tmp/codex-daemon-501/other`, {}, 'command_unisolated'],
    ['attached to a server when this session has no open channel', `${BIN} --remote unix://${SOCKET}`, { channel: null }, 'command_unisolated'],
    ['attached to a server recorded for a different executable', `${BIN} --remote unix://${SOCKET}`, { channel: { ...CHANNEL, enginePath: '/usr/local/bin/codex' } }, 'command_unisolated'],
    ['--remote that is not the first argument', `${BIN} --full-auto --remote unix://${SOCKET}`, {}, 'command_unisolated'],
    ['a server on a version not verified for attaching', `${BIN} --remote unix://${SOCKET}`, { channel: { ...CHANNEL, engineVersion: '0.157.1' } }, 'native_version_unverified'],
    ['a server whose version was never recorded', `${BIN} --remote unix://${SOCKET}`, { channel: { ...CHANNEL, engineVersion: undefined } }, 'native_version_unverified'],
    ['no versions verified for attaching at all', `${BIN} --remote unix://${SOCKET}`, { nativeVerifiedVersions: null }, 'native_version_unverified'],
    ['both isolation flags', `${BIN} --remote unix://${SOCKET} --no-daemon`, {}, 'command_unparseable'],
    ['the flag twice', `${BIN} --no-daemon --no-daemon`, { channel: null }, 'command_unparseable'],
    ['a flag that turns the shared process back on', `${BIN} --no-daemon --daemon`, { channel: null }, 'command_unparseable'],
    ['the flag in its = form', `${BIN} --no-daemon=true`, { channel: null }, 'command_unparseable'],
    ['shell syntax after the executable', `${BIN} --no-daemon; ${BIN}`, { channel: null }, 'command_unparseable'],
    ['an end of options before the flag', `${BIN} -- --no-daemon`, { channel: null }, 'command_unparseable'],
    ['a Codex session started with a wrapper not named codex', '/opt/fake/bin/codex-wrapper --no-daemon', { channel: null }, 'executable_unverified'],
    ['an environment assignment in front of the executable', `FOO=1 ${BIN} --no-daemon`, { channel: null }, 'command_not_pinned']
  ]) {
    it(`not isolated: ${label}`, () => {
      const v = recorded(command, over);
      assert.equal(v.applies, true);
      assert.equal(v.verdict, 'not-isolated', v.reason);
      assert.equal(v.reasonCode, code, v.reason);
      assert.equal(v.basis, null);
      assert.ok(v.reason.length > 20, 'it says why in words');
    });
  }

  it('answers for a session only its caller identified as Codex', () => {
    const v = codex.judgeRecordedCommand({ engineId: 'my-codex', identifiedAs: 'codex', command: '/opt/x/wrapper --no-daemon', channel: null });
    assert.equal(v.verdict, 'not-isolated');
  });

  it('does not apply to another engine\'s command', () => {
    assert.deepEqual(codex.judgeRecordedCommand({ engineId: 'claude', command: 'claude --dangerously-skip-permissions', channel: null }), { applies: false });
    assert.deepEqual(codex.judgeRecordedCommand({ engineId: 'claude', command: '', channel: null }), { applies: false });
  });

  it('applies to a command that runs codex whatever the session\'s engine id says', () => {
    assert.equal(codex.judgeRecordedCommand({ engineId: 'claude', command: 'codex --full-auto', channel: null }).verdict, 'not-isolated');
  });

  it('reads arguments by the rules the launch judgment uses, for every form that judgment refuses as unparseable', () => {
    for (const args of ['--no-daemon $(x)', '--no-daemon `x`', '--no-daemon "a b"', '--no-daemon >out', '--no-daemon ~/x', '--no-daemon a=b=c|d']) {
      const atLaunch = codex.judgeLaunchCommand({ engineId: 'codex', command: `${BIN} ${args}`, enginePath: BIN, probe: { version: '0.156.1', enginePath: BIN }, native: null });
      const afterwards = recorded(`${BIN} ${args}`, { channel: null });
      assert.equal(atLaunch.allowed, false, args);
      assert.equal(afterwards.verdict, 'not-isolated', args);
      assert.equal(afterwards.reasonCode, atLaunch.reasonCode, args);
    }
  });
});

describe('the wrappers TangleClaw puts in front of an engine command can be taken off again', () => {
  it('the PATH floor, for any bin directory the floor itself accepts', () => {
    for (const bin of ['/Users/x/Projects/TangleClaw/bin', '/a b/bin', undefined]) {
      const wrapped = sessions._withPathFloor('claude --x', bin);
      assert.notEqual(wrapped, 'claude --x');
      assert.equal(sessions._withoutPathFloor(wrapped), 'claude --x');
    }
  });

  it('leaves a command with no floor as it is', () => {
    assert.equal(sessions._withoutPathFloor('claude --x'), 'claude --x');
    assert.equal(sessions._withoutPathFloor('export PATH="/x:$PATH" ; claude'), 'export PATH="/x:$PATH" ; claude', 'a near miss is not the floor');
    assert.equal(sessions._withoutPathFloor('export PATH="/x:$HOME"; claude'), 'export PATH="/x:$HOME"; claude');
  });

  it('the bridge handoff, for any paths its builder can be given', () => {
    for (const [node, receiver, fifo] of [
      ['/opt/homebrew/bin/node', '/x/bin/tc-bridge-receive', '/Users/x/.tangleclaw/bridge-handoff/handoff-abc'],
      ['/a b/node', '/it\'s/receive', '/f i/fo']
    ]) {
      const wrapped = bridgeHandoff.wrapLaunchCommand('claude --x', fifo, { nodePath: node, receiverPath: receiver });
      assert.equal(bridgeHandoff.unwrapLaunchCommand(wrapped), 'claude --x');
    }
  });

  it('leaves a command with no handoff as it is, and a lookalike too', () => {
    assert.equal(bridgeHandoff.unwrapLaunchCommand('claude --x'), 'claude --x');
    const lookalike = 'TANGLECLAW_BRIDGE_CREDENTIAL="$(cat /etc/passwd)"; export TANGLECLAW_BRIDGE_CREDENTIAL; claude';
    assert.equal(bridgeHandoff.unwrapLaunchCommand(lookalike), lookalike);
  });
});

/**
 * Reads for an inventory over a made-up fleet.
 * @param {object} fleet
 * @param {Array<object>} fleet.live - Live session rows
 * @param {Object<string, Array<string|null>>} [fleet.panes] - Start commands by tmux session name
 * @param {object} [fleet.tmux] - Overrides the tmux read's `answered` and `cause`
 * @param {object|null} [fleet.master] - The Master's facts
 * @param {Object<number, object>} [fleet.channels] - Open channel rows by session id
 * @param {Object<number, object>} [fleet.ended] - Ended session rows by id
 * @param {object} [fleet.adapters] - Adapter registry
 * @returns {object}
 */
function deps(fleet) {
  const live = fleet.live || [];
  return {
    listPanes: async () => ({ answered: true, cause: null, ...(fleet.tmux || {}), sessions: new Map(Object.entries(fleet.panes || {})) }),
    liveSessions: () => live,
    project: (id) => ({ id, name: `project-${id}` }),
    engineProfile: (engineId) => (engineId === 'codex'
      ? { id: 'codex', launch: { shellCommand: 'codex' }, capabilities: { startupControl: { verifiedVersions: VERIFIED } } }
      : { id: engineId, launch: { shellCommand: engineId } }),
    openChannel: (sessionId) => (fleet.channels && fleet.channels[sessionId]) || null,
    session: (id) => live.find((s) => s.id === id) || (fleet.ended && fleet.ended[id]) || null,
    currentSession: (projectId) => live.find((s) => s.projectId === projectId) || null,
    master: () => (fleet.master === undefined ? null : fleet.master),
    adapters: fleet.adapters || { codex },
    now: () => new Date('2026-10-09T20:00:00.000Z')
  };
}

const FLOOR = sessions._withPathFloor('X').slice(0, -1);
const row = (id, engineId, over = {}) => ({ id, projectId: id * 10, engineId, tmuxSession: `s${id}`, sessionMode: 'tmux', status: 'active', ...over });

describe('the launch-isolation inventory', () => {
  it('judges every live session by the command its pane was started with', async () => {
    const inv = await inventory.inventory(deps({
      live: [row(1, 'codex'), row(2, 'codex'), row(3, 'claude'), row(4, 'codex')],
      panes: {
        s1: [`${FLOOR}${BIN} --remote unix://${SOCKET} --full-auto`],
        s2: [`${FLOOR}codex --full-auto`],
        s3: [`${FLOOR}claude --dangerously-skip-permissions`],
        s4: [`${FLOOR}${BIN} --full-auto --no-daemon`]
      },
      channels: { 1: { adapterState: CHANNEL } }
    }));
    assert.equal(inv.observedAt, '2026-10-09T20:00:00.000Z');
    assert.deepEqual(inv.tmux, { answered: true, cause: null });
    assert.deepEqual(inv.sessions.map((s) => [s.sessionId, s.projectName, s.engineId, s.role, s.verdict, s.basis, s.reasonCode]), [
      [1, 'project-10', 'codex', 'project', 'isolated', 'native-app-server', null],
      [2, 'project-20', 'codex', 'project', 'not-isolated', null, 'command_not_pinned'],
      [3, 'project-30', 'claude', 'project', 'not-applicable', null, null],
      [4, 'project-40', 'codex', 'project', 'isolated', 'no-daemon', null]
    ]);
    assert.deepEqual(inv.summary, { isolated: 2, 'not-isolated': 1, unknown: 0, 'not-applicable': 1 });
    for (const s of inv.sessions) assert.ok(typeof s.reason === 'string' && s.reason.length > 10, `row ${s.sessionId} says why`);
  });

  it('never returns the command itself, which holds paths and a handoff file name', async () => {
    const inv = await inventory.inventory(deps({
      live: [row(1, 'codex')],
      panes: { s1: [`${FLOOR}${BIN} --remote unix://${SOCKET}`] },
      channels: { 1: { adapterState: CHANNEL } }
    }));
    const text = JSON.stringify(inv);
    assert.ok(!text.includes(SOCKET) && !text.includes(BIN) && !text.includes('export PATH'), text);
  });

  for (const [label, fleet, code] of [
    ['tmux did not answer', { tmux: { answered: false, cause: 'read-timed-out' }, panes: {} }, 'tmux_unanswered'],
    ['no pane in the session has a start command', { panes: { s1: [] } }, 'no_start_command'],
    ['the command could not be read back', { panes: { s1: [null] } }, 'command_unreadable']
  ]) {
    it(`unknown, never isolated: ${label}`, async () => {
      const inv = await inventory.inventory(deps({ live: [row(1, 'codex')], ...fleet }));
      assert.equal(inv.sessions[0].verdict, 'unknown');
      assert.equal(inv.sessions[0].reasonCode, code);
      assert.equal(inv.summary.unknown, 1);
      assert.equal(inv.summary.isolated, 0);
    });
  }

  it('not applicable: tmux answered and has no session of that name, so no pane is running for it', async () => {
    const inv = await inventory.inventory(deps({ live: [row(1, 'codex'), row(2, 'claude')], panes: {} }));
    assert.deepEqual(inv.sessions.map((s) => [s.verdict, s.reasonCode]), [['not-applicable', 'no_pane'], ['not-applicable', 'no_pane']]);
    assert.match(inv.sessions[0].reason, /no pane is running/);
  });

  it('unknown: the adapter threw', async () => {
    const inv = await inventory.inventory(deps({
      live: [row(1, 'codex')],
      panes: { s1: [`${FLOOR}${BIN} --no-daemon`] },
      adapters: { codex: { judgeRecordedCommand: () => { throw new Error('boom'); } } }
    }));
    assert.deepEqual([inv.sessions[0].verdict, inv.sessions[0].reasonCode], ['unknown', 'judgment_failed']);
    assert.doesNotMatch(JSON.stringify(inv), /boom/);
  });

  it('not isolated: a Codex session that no registered adapter judges', async () => {
    for (const adapters of [{}, { codex: {} }, { codex: { judgeRecordedCommand: () => ({ applies: false }) } }]) {
      const inv = await inventory.inventory(deps({ live: [row(1, 'codex')], panes: { s1: [`${FLOOR}${BIN} --no-daemon`] }, adapters }));
      assert.deepEqual([inv.sessions[0].verdict, inv.sessions[0].reasonCode], ['not-isolated', 'no_judge']);
    }
  });

  it('takes the worst pane when a session has several with a start command', async () => {
    const inv = await inventory.inventory(deps({
      live: [row(1, 'codex'), row(2, 'codex'), row(3, 'claude')],
      panes: {
        s1: [`${FLOOR}${BIN} --no-daemon`, `${FLOOR}codex`],
        s2: [`${FLOOR}${BIN} --no-daemon`, null],
        s3: [`${FLOOR}claude`, `${FLOOR}${BIN} --no-daemon`]
      }
    }));
    assert.deepEqual(inv.sessions.map((s) => s.verdict), ['not-isolated', 'unknown', 'isolated']);
  });

  it('a session with no local pane is not applicable, and says so', async () => {
    const inv = await inventory.inventory(deps({ live: [row(1, 'openclaw:box', { sessionMode: 'webui' })], panes: {} }));
    assert.deepEqual([inv.sessions[0].verdict, inv.sessions[0].reasonCode], ['not-applicable', 'no_local_pane']);
  });

  it('unknown: the row records no tmux name and its project could not be read, so there is no name to look up', async () => {
    const d = deps({ live: [row(1, 'codex', { tmuxSession: null })], panes: { '': [`${FLOOR}claude`] } });
    d.project = () => { throw new Error('database is locked'); };
    const inv = await inventory.inventory(d);
    assert.deepEqual([inv.sessions[0].verdict, inv.sessions[0].reasonCode], ['unknown', 'session_name_unknown']);
    assert.equal(inv.summary['not-applicable'], 0);
  });

  it('falls back to the project\'s tmux name when the row records none', async () => {
    const inv = await inventory.inventory(deps({ live: [row(1, 'claude', { tmuxSession: null })], panes: { 'project-10': [`${FLOOR}claude`] } }));
    assert.equal(inv.sessions[0].verdict, 'not-applicable');
    assert.equal(inv.sessions[0].reasonCode, null);
  });

  describe('the Project Master', () => {
    const handoff = (cmd) => bridgeHandoff.wrapLaunchCommand(cmd, '/Users/x/.tangleclaw/bridge-handoff/handoff-abc');

    it('is listed while its pane is live, with the bridge handoff taken off before the command is judged', async () => {
      const inv = await inventory.inventory(deps({
        live: [],
        master: { tmuxSession: 'tangleclaw-master', engineId: 'codex' },
        panes: { 'tangleclaw-master': [sessions._withPathFloor(handoff(`${BIN} --no-daemon`))] }
      }));
      assert.equal(inv.sessions.length, 1);
      assert.deepEqual(
        { role: inv.sessions[0].role, sessionId: inv.sessions[0].sessionId, projectId: inv.sessions[0].projectId, verdict: inv.sessions[0].verdict, basis: inv.sessions[0].basis },
        { role: 'master', sessionId: null, projectId: null, verdict: 'isolated', basis: 'no-daemon' }
      );
    });

    it('is left out when tmux answered and it has no pane', async () => {
      const inv = await inventory.inventory(deps({ live: [], master: { tmuxSession: 'tangleclaw-master', engineId: 'claude' }, panes: {} }));
      assert.deepEqual(inv.sessions, []);
    });

    it('is listed as unknown when tmux did not answer, because it may be running', async () => {
      const inv = await inventory.inventory(deps({ live: [], master: { tmuxSession: 'tangleclaw-master', engineId: 'codex' }, tmux: { answered: false, cause: 'read-timed-out' }, panes: {} }));
      assert.deepEqual([inv.sessions[0].role, inv.sessions[0].verdict, inv.sessions[0].reasonCode], ['master', 'unknown', 'tmux_unanswered']);
    });

    it('is judged by its command when its engine could not be resolved', async () => {
      const inv = await inventory.inventory(deps({ live: [], master: { tmuxSession: 'tangleclaw-master', engineId: null }, panes: { 'tangleclaw-master': [sessions._withPathFloor('codex')] } }));
      assert.deepEqual([inv.sessions[0].verdict, inv.sessions[0].reasonCode], ['not-isolated', 'command_not_pinned']);
    });
  });
});

describe('verifyReplaced: was a listed session ended and its project relaunched isolated', () => {
  const ended = (id, projectId) => ({ id, projectId, engineId: 'codex', status: 'wrapped' });

  it('answers for each earlier session id', async () => {
    const d = deps({
      live: [row(5, 'codex', { projectId: 50 }), row(6, 'codex', { projectId: 60 }), row(7, 'claude', { projectId: 70 }), row(8, 'codex', { projectId: 80 }), row(9, 'codex', { projectId: 90 })],
      panes: {
        s5: [`${FLOOR}${BIN} --no-daemon`],
        s6: [`${FLOOR}codex`],
        s7: [`${FLOOR}claude`],
        s8: [null],
        s9: [`${FLOOR}codex`]
      },
      ended: { 1: ended(1, 50), 2: ended(2, 60), 3: ended(3, 70), 4: ended(4, 80), 10: ended(10, 990) }
    });
    const inv = await inventory.inventory(d);
    const out = inventory.verifyReplaced([1, 2, 3, 4, 10, 9, 404], inv, d);
    assert.deepEqual(out.map((r) => [r.sessionId, r.outcome, r.replacedBy]), [
      [1, 'relaunched-isolated', 5],
      [2, 'relaunched-not-isolated', 6],
      [3, 'relaunched-not-applicable', 7],
      [4, 'relaunched-unknown', 8],
      [10, 'ended-not-relaunched', null],
      [9, 'still-running', null],
      [404, 'unknown-session', null]
    ]);
    for (const r of out) assert.ok(r.detail.length > 10, `${r.sessionId} says what was found`);
  });

  it('does not call a relaunch isolated when the current session is missing from the inventory', async () => {
    const d = deps({ live: [row(5, 'codex', { projectId: 50 })], panes: { s5: [`${FLOOR}${BIN} --no-daemon`] }, ended: { 1: ended(1, 50) } });
    const out = inventory.verifyReplaced([1], { sessions: [] }, d);
    assert.equal(out[0].outcome, 'relaunched-unknown');
  });

  it('reads ids from a query value, and refuses one that is not a list of ids', () => {
    assert.deepEqual(inventory.parseSessionIds('1,22, 3'), { ok: true, ids: [1, 22, 3] });
    assert.deepEqual(inventory.parseSessionIds('7,7'), { ok: true, ids: [7] });
    for (const bad of ['', 'a', '1,,2', '1;2', '-1', '1.5', '0']) assert.equal(inventory.parseSessionIds(bad).ok, false, bad);
  });
});
