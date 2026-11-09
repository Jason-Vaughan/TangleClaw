'use strict';

// #1424 — the Linux systemd service layer. `systemctl`/`loginctl` are faked
// through `_internal.exec`; nothing here reaches a real init system (physical
// Linux verification is #1564, deferred under Ruling A185).
//
// #2931 (Car 5730-W1-B) added the three companion units (ttyd, caddy,
// bridge-helper) below. The CLI's own tests moved out to their own file,
// test/linux-systemd-install.test.js, which this issue's file envelope also
// names — one test file per source file, matching e.g.
// test/cache-bump-guard.test.js/scripts/cache-bump-guard.js.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const systemd = require('../lib/linux-systemd');

setLevel('error');

describe('generateUnitFile', () => {
  it('produces a unit execing node directly, with KillMode=process', () => {
    const text = systemd.generateUnitFile({ repoDir: '/opt/tangleclaw', nodeBin: '/usr/bin/node' });
    assert.match(text, /^ExecStart=\/usr\/bin\/node \/opt\/tangleclaw\/server\.js$/m);
    assert.match(text, /^KillMode=process$/m);
    assert.match(text, /^WorkingDirectory=\/opt\/tangleclaw$/m);
    assert.match(text, /^\[Unit\]$/m);
    assert.match(text, /^\[Service\]$/m);
    assert.match(text, /^\[Install\]$/m);
  });

  it('defaults nodeBin to "node" and restartSec to 5', () => {
    const text = systemd.generateUnitFile({ repoDir: '/opt/tangleclaw' });
    assert.match(text, /^ExecStart=node \/opt\/tangleclaw\/server\.js$/m);
    assert.match(text, /^RestartSec=5$/m);
  });

  it('refuses a non-absolute repoDir', () => {
    assert.throws(() => systemd.generateUnitFile({ repoDir: 'relative/path' }), systemd.LinuxSystemdError);
  });

  it('refuses an empty nodeBin', () => {
    assert.throws(() => systemd.generateUnitFile({ repoDir: '/opt/tangleclaw', nodeBin: '' }), systemd.LinuxSystemdError);
  });
});

describe('verifyUnitFileContract', () => {
  const good = systemd.generateUnitFile({ repoDir: '/opt/tangleclaw', nodeBin: '/usr/bin/node' });

  it('is satisfied by a correctly generated unit', () => {
    assert.deepEqual(systemd.verifyUnitFileContract(good), []);
  });

  it('flags a missing KillMode=process', () => {
    const bad = good.replace('KillMode=process\n', '');
    const violations = systemd.verifyUnitFileContract(bad);
    assert.ok(violations.some((v) => v.includes('KillMode=process')));
  });

  it('flags an ExecStart that runs through a shell', () => {
    const bad = good.replace('ExecStart=/usr/bin/node /opt/tangleclaw/server.js', 'ExecStart=/bin/sh -c "node server.js"');
    const violations = systemd.verifyUnitFileContract(bad);
    assert.ok(violations.some((v) => v.toLowerCase().includes('shell')));
  });

  it('flags an ExecStart that runs through npm', () => {
    const bad = good.replace('ExecStart=/usr/bin/node /opt/tangleclaw/server.js', 'ExecStart=npm start');
    const violations = systemd.verifyUnitFileContract(bad);
    assert.ok(violations.length > 0);
  });

  it('flags a missing ExecStart entirely', () => {
    const bad = good.split('\n').filter((l) => !l.startsWith('ExecStart=')).join('\n');
    const violations = systemd.verifyUnitFileContract(bad);
    assert.ok(violations.some((v) => v.includes('ExecStart is missing')));
  });
});

describe('generateTtydUnitFile / verifyTtydUnitFileContract (#2931)', () => {
  const goodDirect = systemd.generateTtydUnitFile({
    ttydPath: '/home/jason/.tangleclaw/bin/ttyd',
    attachScriptPath: '/home/jason/.tangleclaw/deploy/ttyd-attach.sh'
  });

  it('defaults to direct mode: loopback, port 3100, an empty socket to unlink', () => {
    assert.match(goodDirect, /^Environment=TTYD_SOCKET=$/m);
    assert.match(goodDirect, /--interface' '127\.0\.0\.1'/);
    assert.match(goodDirect, /--port' '3100'/);
    assert.match(goodDirect, /--writable/);
    assert.match(goodDirect, /--client-option' 'scrollback=10000'/);
    assert.match(goodDirect, /ttyd-attach\.sh/);
  });

  it('passes the real ttyd command as positional args after a static "$@" script, never embedded inside it (#2931 PRR-A R1)', () => {
    const execStart = /^ExecStart=(.+)$/m.exec(goodDirect)[1];
    const tokens = systemd._internal.tokenizeSystemdExecStart(execStart);
    assert.deepEqual(tokens.slice(0, 4), [
      '/bin/bash', '-c',
      'if [ -n "$TTYD_SOCKET" ]; then rm -f "$TTYD_SOCKET"; fi; exec "$@"',
      'ttyd-launch'
    ]);
    assert.deepEqual(tokens.slice(4), [
      '/home/jason/.tangleclaw/bin/ttyd', '--writable', '--interface', '127.0.0.1',
      '--port', '3100', '--url-arg', '--client-option', 'scrollback=10000',
      '/home/jason/.tangleclaw/deploy/ttyd-attach.sh'
    ]);
  });

  it('refuses an argument containing a single quote — it cannot be safely systemd-quoted', () => {
    assert.throws(
      () => systemd.generateTtydUnitFile({ ttydPath: "/x/tty'd", attachScriptPath: '/x/attach.sh' }),
      systemd.LinuxSystemdError
    );
  });

  it('REGRESSION (#2931 PRR-A R1): verifyTtydUnitFileContract flags a script that swallows the real command via nested quoting', () => {
    // Reconstructs the exact Round 1 bug: each real argv token was shell-quoted
    // with single quotes, then embedded INSIDE the systemd single-quoted -c
    // script. Per systemd.syntax(7), systemd's own tokenizer closes the -c
    // word at the first single quote it finds after "exec " — truncating the
    // script to "...exec " and spilling --writable/--interface/etc. out as
    // bash's own $1, $2, ... instead of the script's "$@". A regex scan for
    // the substring "--writable" would NOT catch this: the substring is still
    // present in the line, just in the wrong token.
    const buggy = [
      '[Unit]',
      'Description=TangleClaw ttyd (terminal bridge)',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'Environment=TTYD_SOCKET=',
      'ExecStart=/bin/bash -c \'if [ -n "$TTYD_SOCKET" ]; then rm -f "$TTYD_SOCKET"; fi; exec \'/x/ttyd\' \'--writable\' \'--interface\' \'127.0.0.1\' \'--port\' \'3100\' \'--url-arg\' \'--client-option\' \'scrollback=10000\' \'/x/attach.sh\'\'',
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      ''
    ].join('\n');
    const violations = systemd.verifyTtydUnitFileContract(buggy);
    assert.ok(violations.length > 0, 'expected the swallowed-script bug to be flagged');
    assert.ok(violations.some((v) => v.includes('-c script must be exactly')));
  });

  it('caddy mode: binds the Unix socket and carries it in TTYD_SOCKET for the self-heal unlink', () => {
    const text = systemd.generateTtydUnitFile({
      ttydPath: '/x/ttyd', attachScriptPath: '/x/attach.sh',
      bindVal: '/x/run/ttyd.sock', socketPath: '/x/run/ttyd.sock'
    });
    assert.match(text, /^Environment=TTYD_SOCKET=\/x\/run\/ttyd\.sock$/m);
    assert.match(text, /--interface' '\/x\/run\/ttyd\.sock'/);
    assert.match(text, /rm -f "\$TTYD_SOCKET"/);
  });

  it('is pure: identical options produce byte-identical output', () => {
    const opts = { ttydPath: '/x/ttyd', attachScriptPath: '/x/attach.sh' };
    assert.equal(systemd.generateTtydUnitFile(opts), systemd.generateTtydUnitFile(opts));
  });

  it('refuses a relative ttydPath or attachScriptPath', () => {
    assert.throws(() => systemd.generateTtydUnitFile({ ttydPath: 'ttyd', attachScriptPath: '/x/attach.sh' }), systemd.LinuxSystemdError);
    assert.throws(() => systemd.generateTtydUnitFile({ ttydPath: '/x/ttyd', attachScriptPath: 'attach.sh' }), systemd.LinuxSystemdError);
  });

  it('refuses an out-of-range port', () => {
    assert.throws(() => systemd.generateTtydUnitFile({ ttydPath: '/x/ttyd', attachScriptPath: '/x/attach.sh', port: 0 }), systemd.LinuxSystemdError);
    assert.throws(() => systemd.generateTtydUnitFile({ ttydPath: '/x/ttyd', attachScriptPath: '/x/attach.sh', port: 65536 }), systemd.LinuxSystemdError);
  });

  it('is satisfied by a correctly generated unit, in either mode', () => {
    assert.deepEqual(systemd.verifyTtydUnitFileContract(goodDirect), []);
    const caddyMode = systemd.generateTtydUnitFile({ ttydPath: '/x/ttyd', attachScriptPath: '/x/attach.sh', bindVal: '/x/run/ttyd.sock', socketPath: '/x/run/ttyd.sock' });
    assert.deepEqual(systemd.verifyTtydUnitFileContract(caddyMode), []);
  });

  it('flags a missing --writable', () => {
    const bad = goodDirect.replace("'--writable' ", '');
    assert.ok(systemd.verifyTtydUnitFileContract(bad).some((v) => v.includes('--writable')));
  });

  it('flags a missing --interface (AUTH-1: an unqualified bind is every interface)', () => {
    const bad = goodDirect.replace("'--interface' '127.0.0.1' ", '');
    assert.ok(systemd.verifyTtydUnitFileContract(bad).some((v) => v.includes('--interface')));
  });

  it('flags --interface 0.0.0.0 — ttyd must never bind a public interface', () => {
    const bad = systemd.generateTtydUnitFile({ ttydPath: '/x/ttyd', attachScriptPath: '/x/attach.sh', bindVal: '0.0.0.0' });
    assert.ok(systemd.verifyTtydUnitFileContract(bad).some((v) => v.includes('0.0.0.0')));
  });

  it('flags a missing ExecStart entirely', () => {
    const bad = goodDirect.split('\n').filter((l) => !l.startsWith('ExecStart=')).join('\n');
    assert.ok(systemd.verifyTtydUnitFileContract(bad).some((v) => v.includes('ExecStart is missing')));
  });
});

describe('generateCaddyUnitFile / verifyCaddyUnitFileContract (#2931)', () => {
  const good = systemd.generateCaddyUnitFile({
    caddyPath: '/usr/bin/caddy', caddyfilePath: '/home/jason/.tangleclaw/Caddyfile', homeDir: '/home/jason'
  });

  it('execs caddy run --config <file> --adapter caddyfile', () => {
    assert.match(good, /^ExecStart=\/usr\/bin\/caddy run --config \/home\/jason\/\.tangleclaw\/Caddyfile --adapter caddyfile$/m);
  });

  it('sets XDG_DATA_HOME/XDG_CONFIG_HOME under <homeDir>/.tangleclaw/caddy, not the real XDG defaults', () => {
    assert.match(good, /^Environment=XDG_DATA_HOME=\/home\/jason\/\.tangleclaw\/caddy\/data$/m);
    assert.match(good, /^Environment=XDG_CONFIG_HOME=\/home\/jason\/\.tangleclaw\/caddy\/config$/m);
  });

  it('refuses a relative caddyPath, caddyfilePath, or homeDir', () => {
    assert.throws(() => systemd.generateCaddyUnitFile({ caddyPath: 'caddy', caddyfilePath: '/x/Caddyfile', homeDir: '/home/jason' }), systemd.LinuxSystemdError);
    assert.throws(() => systemd.generateCaddyUnitFile({ caddyPath: '/x/caddy', caddyfilePath: 'Caddyfile', homeDir: '/home/jason' }), systemd.LinuxSystemdError);
    assert.throws(() => systemd.generateCaddyUnitFile({ caddyPath: '/x/caddy', caddyfilePath: '/x/Caddyfile', homeDir: 'home' }), systemd.LinuxSystemdError);
  });

  it('is satisfied by a correctly generated unit', () => {
    assert.deepEqual(systemd.verifyCaddyUnitFileContract(good), []);
  });

  it('flags ExecStart missing run/--config/--adapter caddyfile', () => {
    const bad = good.replace('--adapter caddyfile', '--adapter nginx');
    assert.ok(systemd.verifyCaddyUnitFileContract(bad).some((v) => v.includes('--adapter caddyfile')));
  });

  it('flags a missing XDG_DATA_HOME or XDG_CONFIG_HOME', () => {
    const noData = good.split('\n').filter((l) => !l.startsWith('Environment=XDG_DATA_HOME=')).join('\n');
    assert.ok(systemd.verifyCaddyUnitFileContract(noData).some((v) => v.includes('XDG_DATA_HOME')));
    const noConfig = good.split('\n').filter((l) => !l.startsWith('Environment=XDG_CONFIG_HOME=')).join('\n');
    assert.ok(systemd.verifyCaddyUnitFileContract(noConfig).some((v) => v.includes('XDG_CONFIG_HOME')));
  });

  it('flags a missing ExecStart entirely', () => {
    const bad = good.split('\n').filter((l) => !l.startsWith('ExecStart=')).join('\n');
    assert.ok(systemd.verifyCaddyUnitFileContract(bad).some((v) => v.includes('ExecStart is missing')));
  });
});

describe('generateBridgeHelperUnitFile / verifyBridgeHelperUnitFileContract (#2931)', () => {
  const good = systemd.generateBridgeHelperUnitFile({ repoDir: '/opt/tangleclaw' });

  it('execs node bin/tc-bridge-helper run, with WorkingDirectory set, RestartSec defaulting to 30', () => {
    assert.match(good, /^ExecStart=node \/opt\/tangleclaw\/bin\/tc-bridge-helper run$/m);
    assert.match(good, /^WorkingDirectory=\/opt\/tangleclaw$/m);
    assert.match(good, /^RestartSec=30$/m);
  });

  it('refuses a relative repoDir or an empty nodeBin', () => {
    assert.throws(() => systemd.generateBridgeHelperUnitFile({ repoDir: 'opt/tangleclaw' }), systemd.LinuxSystemdError);
    assert.throws(() => systemd.generateBridgeHelperUnitFile({ repoDir: '/opt/tangleclaw', nodeBin: '' }), systemd.LinuxSystemdError);
  });

  it('is satisfied by a correctly generated unit', () => {
    assert.deepEqual(systemd.verifyBridgeHelperUnitFileContract(good), []);
  });

  it('flags ExecStart not running tc-bridge-helper run', () => {
    const bad = good.replace('bin/tc-bridge-helper run', 'bin/other-thing run');
    assert.ok(systemd.verifyBridgeHelperUnitFileContract(bad).some((v) => v.includes('tc-bridge-helper run')));
  });

  it('flags RestartSec below 30 — the systemd analogue of the launchd plist\'s ThrottleInterval=30', () => {
    const bad = systemd.generateBridgeHelperUnitFile({ repoDir: '/opt/tangleclaw', restartSec: 10 });
    assert.ok(systemd.verifyBridgeHelperUnitFileContract(bad).some((v) => v.includes('RestartSec')));
  });

  it('flags a missing ExecStart entirely', () => {
    const bad = good.split('\n').filter((l) => !l.startsWith('ExecStart=')).join('\n');
    assert.ok(systemd.verifyBridgeHelperUnitFileContract(bad).some((v) => v.includes('ExecStart is missing')));
  });
});

describe('parseSystemctlShow / verifyRestartButtonContract', () => {
  const GOOD_OUTPUT = 'LoadState=loaded\nKillMode=process\nNeedDaemonReload=no\nMainPID=4242\n';

  it('parses key=value lines into a flat map', () => {
    assert.deepEqual(systemd.parseSystemctlShow(GOOD_OUTPUT), { LoadState: 'loaded', KillMode: 'process', NeedDaemonReload: 'no', MainPID: '4242' });
  });

  it('is satisfied when all four conditions hold and the PID matches', () => {
    const fields = systemd.parseSystemctlShow(GOOD_OUTPUT);
    assert.deepEqual(systemd.verifyRestartButtonContract(fields, { expectedPid: 4242 }), []);
  });

  it('flags each condition independently', () => {
    const base = systemd.parseSystemctlShow(GOOD_OUTPUT);
    assert.ok(systemd.verifyRestartButtonContract({ ...base, LoadState: 'not-found' }).some((v) => v.includes('LoadState')));
    assert.ok(systemd.verifyRestartButtonContract({ ...base, KillMode: 'control-group' }).some((v) => v.includes('KillMode')));
    assert.ok(systemd.verifyRestartButtonContract({ ...base, NeedDaemonReload: 'yes' }).some((v) => v.includes('NeedDaemonReload')));
    assert.ok(systemd.verifyRestartButtonContract(base, { expectedPid: 9999 }).some((v) => v.includes('MainPID')));
  });

  it('skips the PID check when no expectedPid is supplied', () => {
    const fields = systemd.parseSystemctlShow(GOOD_OUTPUT);
    assert.deepEqual(systemd.verifyRestartButtonContract(fields), []);
  });
});

describe('unitFilePath', () => {
  it('SERVICE_NAME is the fixed unit name', () => {
    assert.equal(systemd.SERVICE_NAME, 'tangleclaw.service');
  });

  it('places the unit under .config/systemd/user', () => {
    assert.equal(systemd.unitFilePath('/home/jason'), '/home/jason/.config/systemd/user/tangleclaw.service');
  });

  it('defaults to os.homedir()', () => {
    assert.equal(systemd.unitFilePath(), path.join(os.homedir(), '.config', 'systemd', 'user', 'tangleclaw.service'));
  });

  it('the three companion service names are fixed (#2931)', () => {
    assert.equal(systemd.TTYD_SERVICE_NAME, 'tangleclaw-ttyd.service');
    assert.equal(systemd.CADDY_SERVICE_NAME, 'tangleclaw-caddy.service');
    assert.equal(systemd.BRIDGE_HELPER_SERVICE_NAME, 'tangleclaw-bridge-helper.service');
  });

  it('a second argument picks a companion\'s own file, not the server\'s (#2931)', () => {
    assert.equal(systemd.unitFilePath('/home/jason', systemd.TTYD_SERVICE_NAME), '/home/jason/.config/systemd/user/tangleclaw-ttyd.service');
    assert.equal(systemd.unitFilePath('/home/jason', systemd.CADDY_SERVICE_NAME), '/home/jason/.config/systemd/user/tangleclaw-caddy.service');
    assert.equal(systemd.unitFilePath('/home/jason', systemd.BRIDGE_HELPER_SERVICE_NAME), '/home/jason/.config/systemd/user/tangleclaw-bridge-helper.service');
  });
});

describe('install / uninstall / status', () => {
  let original;
  let tmpDir;

  beforeEach(() => {
    original = systemd._internal.exec;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-systemd-'));
  });

  afterEach(() => {
    systemd._internal.exec = original;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('install writes the unit file and runs daemon-reload, enable-linger, enable, start in order', async () => {
    const calls = [];
    systemd._internal.exec = async (file, args) => {
      calls.push([file, ...args]);
      return { exitCode: 0, stdout: '', stderr: '', error: null };
    };
    const result = await systemd.install({ repoDir: '/opt/tangleclaw', nodeBin: '/usr/bin/node', homeDir: tmpDir });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(result.file), true);
    assert.deepEqual(calls, [
      ['systemctl', '--user', 'daemon-reload'],
      ['loginctl', 'enable-linger'],
      ['systemctl', '--user', 'enable', 'tangleclaw.service'],
      ['systemctl', '--user', 'start', 'tangleclaw.service']
    ]);
  });

  it('install refuses before any exec call when the generated unit fails its own contract', async () => {
    let execCalled = false;
    systemd._internal.exec = async () => { execCalled = true; return { exitCode: 0, stdout: '', stderr: '', error: null }; };
    await assert.rejects(
      () => systemd.install({ repoDir: '/opt/tangleclaw', nodeBin: '', homeDir: tmpDir }),
      systemd.LinuxSystemdError
    );
    assert.equal(execCalled, false);
  });

  it('install stops at the first failing step and reports it', async () => {
    const calls = [];
    systemd._internal.exec = async (file, args) => {
      calls.push([file, ...args]);
      if (file === 'loginctl') return { exitCode: 1, stdout: '', stderr: 'Failed to enable linger', error: 'boom' };
      return { exitCode: 0, stdout: '', stderr: '', error: null };
    };
    const result = await systemd.install({ repoDir: '/opt/tangleclaw', homeDir: tmpDir });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 2, 'stops after the failing step, never reaches enable/start');
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[1].ok, false);
  });

  it('uninstall stops, disables, removes the file, and reloads', async () => {
    const file = systemd.unitFilePath(tmpDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'placeholder');
    const calls = [];
    systemd._internal.exec = async (f, args) => { calls.push([f, ...args]); return { exitCode: 0, stdout: '', stderr: '', error: null }; };
    const result = await systemd.uninstall({ homeDir: tmpDir });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(calls, [
      ['systemctl', '--user', 'stop', 'tangleclaw.service'],
      ['systemctl', '--user', 'disable', 'tangleclaw.service'],
      ['systemctl', '--user', 'daemon-reload']
    ]);
  });

  it('uninstall is a no-op success when the unit file was never installed, even when systemctl stop reports "not loaded"', async () => {
    const file = systemd.unitFilePath(tmpDir);
    assert.equal(fs.existsSync(file), false, 'sanity: nothing was ever installed');
    systemd._internal.exec = async (f, args) => (args[1] === 'stop'
      ? { exitCode: 5, stdout: '', stderr: 'Unit tangleclaw.service not loaded.', error: null }
      : { exitCode: 0, stdout: '', stderr: '', error: null });
    const result = await systemd.uninstall({ homeDir: tmpDir });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.existsSync(file), false);
  });

  it('uninstall still reports failure when stop fails for a REAL unit (file existed, something else is wrong)', async () => {
    const file = systemd.unitFilePath(tmpDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'placeholder');
    systemd._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: 'Failed to stop tangleclaw.service: Access denied', error: null });
    const result = await systemd.uninstall({ homeDir: tmpDir });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(file), true, 'a genuinely failed uninstall leaves the file in place');
  });

  it('status reports the parsed fields on success', async () => {
    systemd._internal.exec = async () => ({ exitCode: 0, stdout: 'LoadState=loaded\nKillMode=process\n', stderr: '', error: null });
    const result = await systemd.status();
    assert.deepEqual(result, { available: true, fields: { LoadState: 'loaded', KillMode: 'process' } });
  });

  it('status is unavailable, never a guess, when systemctl is not installed', async () => {
    systemd._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: '', error: null, errorCode: 'ENOENT', timedOut: false });
    const result = await systemd.status();
    assert.equal(result.available, false);
    assert.ok(result.reason);
  });

  it('uninstall against a non-default serviceName removes THAT unit\'s own file, not tangleclaw.service\'s (#2931 regression — the file path never carried serviceName before this car)', async () => {
    const serverFile = systemd.unitFilePath(tmpDir);
    const ttydFile = systemd.unitFilePath(tmpDir, systemd.TTYD_SERVICE_NAME);
    fs.mkdirSync(path.dirname(serverFile), { recursive: true });
    fs.writeFileSync(serverFile, 'server placeholder');
    fs.writeFileSync(ttydFile, 'ttyd placeholder');
    systemd._internal.exec = async () => ({ exitCode: 0, stdout: '', stderr: '', error: null });
    const result = await systemd.uninstall({ homeDir: tmpDir, serviceName: systemd.TTYD_SERVICE_NAME });
    assert.equal(result.ok, true);
    assert.equal(result.file, ttydFile);
    assert.equal(fs.existsSync(ttydFile), false, 'the ttyd unit file must be the one removed');
    assert.equal(fs.existsSync(serverFile), true, 'the server unit file must be left alone');
  });
});

describe('installTtyd / installCaddy / installBridgeHelper (#2931)', () => {
  let original;
  let tmpDir;

  beforeEach(() => {
    original = systemd._internal.exec;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-systemd-companions-'));
  });

  afterEach(() => {
    systemd._internal.exec = original;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('installTtyd writes tangleclaw-ttyd.service and runs the same 4-step orchestration', async () => {
    const calls = [];
    systemd._internal.exec = async (file, args) => {
      calls.push([file, ...args]);
      return { exitCode: 0, stdout: '', stderr: '', error: null };
    };
    const result = await systemd.installTtyd({
      ttydPath: '/x/ttyd', attachScriptPath: '/x/attach.sh', homeDir: tmpDir
    });
    assert.equal(result.ok, true);
    assert.equal(result.file, systemd.unitFilePath(tmpDir, systemd.TTYD_SERVICE_NAME));
    assert.equal(fs.existsSync(result.file), true);
    assert.deepEqual(calls, [
      ['systemctl', '--user', 'daemon-reload'],
      ['loginctl', 'enable-linger'],
      ['systemctl', '--user', 'enable', 'tangleclaw-ttyd.service'],
      ['systemctl', '--user', 'start', 'tangleclaw-ttyd.service']
    ]);
  });

  it('installTtyd refuses before any exec call when the generated unit fails its own contract', async () => {
    let execCalled = false;
    systemd._internal.exec = async () => { execCalled = true; return { exitCode: 0, stdout: '', stderr: '', error: null }; };
    await assert.rejects(
      () => systemd.installTtyd({ ttydPath: '/x/ttyd', attachScriptPath: '/x/attach.sh', bindVal: '0.0.0.0', homeDir: tmpDir }),
      systemd.LinuxSystemdError
    );
    assert.equal(execCalled, false);
  });

  it('installCaddy writes tangleclaw-caddy.service', async () => {
    systemd._internal.exec = async () => ({ exitCode: 0, stdout: '', stderr: '', error: null });
    const result = await systemd.installCaddy({
      caddyPath: '/usr/bin/caddy', caddyfilePath: path.join(tmpDir, 'Caddyfile'), homeDir: tmpDir
    });
    assert.equal(result.ok, true);
    assert.equal(result.file, systemd.unitFilePath(tmpDir, systemd.CADDY_SERVICE_NAME));
    assert.equal(fs.existsSync(result.file), true);
    assert.match(fs.readFileSync(result.file, 'utf8'), new RegExp(`XDG_DATA_HOME=${tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('installCaddy refuses before any exec call when the generated unit fails its own contract', async () => {
    let execCalled = false;
    systemd._internal.exec = async () => { execCalled = true; return { exitCode: 0, stdout: '', stderr: '', error: null }; };
    await assert.rejects(
      () => systemd.installCaddy({ caddyPath: 'caddy', caddyfilePath: path.join(tmpDir, 'Caddyfile'), homeDir: tmpDir }),
      systemd.LinuxSystemdError
    );
    assert.equal(execCalled, false);
  });

  it('installBridgeHelper writes tangleclaw-bridge-helper.service', async () => {
    systemd._internal.exec = async () => ({ exitCode: 0, stdout: '', stderr: '', error: null });
    const result = await systemd.installBridgeHelper({ repoDir: '/opt/tangleclaw', homeDir: tmpDir });
    assert.equal(result.ok, true);
    assert.equal(result.file, systemd.unitFilePath(tmpDir, systemd.BRIDGE_HELPER_SERVICE_NAME));
    assert.equal(fs.existsSync(result.file), true);
  });

  it('installBridgeHelper refuses before any exec call when the generated unit fails its own contract', async () => {
    let execCalled = false;
    systemd._internal.exec = async () => { execCalled = true; return { exitCode: 0, stdout: '', stderr: '', error: null }; };
    await assert.rejects(
      () => systemd.installBridgeHelper({ repoDir: '/opt/tangleclaw', restartSec: 5, homeDir: tmpDir }),
      systemd.LinuxSystemdError
    );
    assert.equal(execCalled, false);
  });

  it('all three companions and the server install side by side without colliding', async () => {
    systemd._internal.exec = async () => ({ exitCode: 0, stdout: '', stderr: '', error: null });
    await systemd.install({ repoDir: '/opt/tangleclaw', homeDir: tmpDir });
    await systemd.installTtyd({ ttydPath: '/x/ttyd', attachScriptPath: '/x/attach.sh', homeDir: tmpDir });
    await systemd.installCaddy({ caddyPath: '/usr/bin/caddy', caddyfilePath: path.join(tmpDir, 'Caddyfile'), homeDir: tmpDir });
    await systemd.installBridgeHelper({ repoDir: '/opt/tangleclaw', homeDir: tmpDir });
    const dir = path.dirname(systemd.unitFilePath(tmpDir));
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ['tangleclaw-bridge-helper.service', 'tangleclaw-caddy.service', 'tangleclaw-ttyd.service', 'tangleclaw.service']
    );
  });
});
