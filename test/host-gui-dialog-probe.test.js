'use strict';

/*
 * `lib/host-gui-dialog-probe.js` (#1112, Ruling A503-R1) -- detecting a
 * blocking host-level GUI dialog (a macOS TCC prompt, Gatekeeper warning,
 * crash reporter) no pane capture or switchboard probe can see, and
 * correlating it with sessions that look stalled. Every test drives the
 * real exported function through the injectable `execFile`/`platform`
 * seams; none spawns a real subprocess (small tier).
 */

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../lib/host-gui-dialog-probe');

describe('probeHostGuiDialogs: platform guard', () => {
  it('is inert on a non-macOS platform: no execFile call, blocked false', async () => {
    const execFile = mock.fn(async () => ({ stdout: 'should never be read\n' }));
    const result = await probe.probeHostGuiDialogs({ platform: 'linux', execFile, stalledSessions: [{ pid: 1 }] });
    assert.deepEqual(result, {
      blocked: false, dialogs: [], stalledSessions: [],
      summary: 'host GUI dialog detection is macOS-only; this host reports "linux"'
    });
    assert.equal(execFile.mock.calls.length, 0);
  });

  it('is inert on win32 too', async () => {
    const execFile = mock.fn(async () => ({ stdout: '' }));
    const result = await probe.probeHostGuiDialogs({ platform: 'win32', execFile });
    assert.equal(result.blocked, false);
    assert.match(result.summary, /win32/);
  });
});

describe('probeHostGuiDialogs: on macOS, no dialog running', () => {
  it('is an honest empty negative when ps reports no dialog-class process', async () => {
    const execFile = mock.fn(async () => ({
      stdout: '    1 launchd           01-00:00:00\n'
        + '  501 Finder            00:10:00\n'
    }));
    const result = await probe.probeHostGuiDialogs({ platform: 'darwin', execFile, stalledSessions: [{ pid: 75078 }] });
    assert.equal(result.blocked, false);
    assert.deepEqual(result.dialogs, []);
    assert.deepEqual(result.stalledSessions, []);
    assert.equal(result.summary, 'no host GUI dialog process detected');
    assert.equal(execFile.mock.calls.length, 1);
    assert.deepEqual(execFile.mock.calls[0].arguments, ['ps', ['-A', '-o', 'pid=,comm=,etime=']]);
  });

  it('defaults stalledSessions to empty when omitted', async () => {
    const execFile = mock.fn(async () => ({ stdout: '' }));
    const result = await probe.probeHostGuiDialogs({ platform: 'darwin', execFile });
    assert.deepEqual(result.stalledSessions, []);
    assert.equal(result.blocked, false);
  });
});

describe('probeHostGuiDialogs: a dialog agent running', () => {
  function psOutputWith(dialogLine) {
    return `    1 launchd           01-00:00:00\n${dialogLine}\n  501 Finder            00:10:00\n`;
  }

  it("#1112's own repro: SecurityAgent running + a stalled session => blocked", async () => {
    const execFile = mock.fn(async () => ({
      stdout: psOutputWith('12345 /System/Library/CoreServices/SecurityAgent.app/Contents/MacOS/SecurityAgent 08-00:19:01')
    }));
    const result = await probe.probeHostGuiDialogs({
      platform: 'darwin', execFile, stalledSessions: [{ pid: 75078, elapsedSeconds: 691141, label: 'PrawductSteward' }]
    });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.dialogs, [{ pid: 12345, name: 'SecurityAgent', elapsedSeconds: 8 * 86400 + 19 * 60 + 1, reliable: true }]);
    assert.deepEqual(result.stalledSessions, [{ pid: 75078, elapsedSeconds: 691141, label: 'PrawductSteward' }]);
    assert.match(result.summary, /SecurityAgent/);
    assert.match(result.summary, /1 session\(s\) look stalled/);
  });

  it('a dialog agent running with NO stalled sessions is not reported as blocked', async () => {
    const execFile = mock.fn(async () => ({ stdout: psOutputWith('999 UserNotificationCenter 00:00:05') }));
    const result = await probe.probeHostGuiDialogs({ platform: 'darwin', execFile, stalledSessions: [] });
    assert.equal(result.blocked, false);
    assert.equal(result.dialogs.length, 1);
    assert.deepEqual(result.stalledSessions, []);
    assert.match(result.summary, /no stalled sessions reported/);
  });

  it('recognizes every named dialog-class process, marking reliable vs. not', async () => {
    for (const name of probe.DIALOG_PROCESS_NAMES) {
      const execFile = mock.fn(async () => ({ stdout: psOutputWith(`42 ${name} 00:01:00`) }));
      const result = await probe.probeHostGuiDialogs({ platform: 'darwin', execFile, stalledSessions: [{ pid: 1 }] });
      assert.equal(result.dialogs.length, 1, `expected ${name} to be recognized`);
      assert.equal(result.dialogs[0].name, name);
      assert.equal(result.dialogs[0].reliable, probe.RELIABLE_DIALOG_PROCESS_NAMES.includes(name));
    }
  });

  it("I-Gate Round 1 regression (#2903): ordinary SystemUIServer presence alone never reads blocked, even with a stalled session", async () => {
    const execFile = mock.fn(async () => ({ stdout: psOutputWith('99 SystemUIServer 1-00:00:00') }));
    const result = await probe.probeHostGuiDialogs({
      platform: 'darwin', execFile, stalledSessions: [{ pid: 75078, label: 'some-stalled-session' }]
    });
    assert.equal(result.blocked, false);
    assert.equal(result.dialogs.length, 1);
    assert.equal(result.dialogs[0].name, 'SystemUIServer');
    assert.equal(result.dialogs[0].reliable, false);
    assert.deepEqual(result.stalledSessions, []);
    assert.match(result.summary, /uncertain/);
    assert.doesNotMatch(result.summary, /likely cause/);
  });

  it('a reliable dialog alongside SystemUIServer still reads blocked, counting only the reliable one in the summary', async () => {
    const execFile = mock.fn(async () => ({
      stdout: psOutputWith('1 SecurityAgent 00:00:05') + '    2 SystemUIServer      1-00:00:00\n'
    }));
    const result = await probe.probeHostGuiDialogs({ platform: 'darwin', execFile, stalledSessions: [{ pid: 1 }] });
    assert.equal(result.blocked, true);
    assert.equal(result.dialogs.length, 2);
    assert.match(result.summary, /1 host GUI dialog process\(es\) running \(SecurityAgent\)/);
  });

  it('reports multiple simultaneous dialog agents', async () => {
    const execFile = mock.fn(async () => ({
      stdout: psOutputWith('1 SecurityAgent 00:00:01') + '    2 CrashReporter      00:00:02\n'
    }));
    const result = await probe.probeHostGuiDialogs({ platform: 'darwin', execFile, stalledSessions: [{ pid: 1 }] });
    assert.equal(result.dialogs.length, 2);
    assert.deepEqual(result.dialogs.map((d) => d.name).sort(), ['CrashReporter', 'SecurityAgent']);
  });

  it('ignores a line ps emits in a shape this parser does not recognize, rather than throwing', async () => {
    const execFile = mock.fn(async () => ({ stdout: 'garbage line with no valid columns\n' + psOutputWith('1 SecurityAgent 00:00:01') }));
    const result = await probe.probeHostGuiDialogs({ platform: 'darwin', execFile, stalledSessions: [{ pid: 1 }] });
    assert.equal(result.dialogs.length, 1);
  });
});

describe('probeHostGuiDialogs: default execFile seam', () => {
  it('_internal.defaultExecFile exists and is a function (the real, unmocked production seam)', () => {
    assert.equal(typeof probe._internal.defaultExecFile, 'function');
  });

  it('_internal.parsePs / parseEtime are exposed and read directly', () => {
    assert.deepEqual(probe._internal.parsePs('  5 SecurityAgent 00:00:10\n'), [{ pid: 5, comm: 'SecurityAgent', etimeSeconds: 10 }]);
    assert.equal(probe._internal.parseEtime('08-00:19:01'), 8 * 86400 + 19 * 60 + 1);
    assert.equal(probe._internal.parseEtime('01:30'), 90);
    assert.equal(probe._internal.parseEtime('not-a-time'), null);
  });
});

describe('DIALOG_PROCESS_NAMES / RELIABLE_DIALOG_PROCESS_NAMES', () => {
  it('names exactly the five system agents #1112 enumerates', () => {
    assert.deepEqual(probe.DIALOG_PROCESS_NAMES, [
      'SecurityAgent', 'UserNotificationCenter', 'CoreServicesUIAgent', 'CrashReporter', 'SystemUIServer'
    ]);
  });

  it('RELIABLE_DIALOG_PROCESS_NAMES is every name except SystemUIServer', () => {
    assert.deepEqual(probe.RELIABLE_DIALOG_PROCESS_NAMES, ['SecurityAgent', 'UserNotificationCenter', 'CoreServicesUIAgent', 'CrashReporter']);
    assert.equal(probe.RELIABLE_DIALOG_PROCESS_NAMES.includes('SystemUIServer'), false);
  });
});
