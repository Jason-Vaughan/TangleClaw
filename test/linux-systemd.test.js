'use strict';

// #1424 — the Linux systemd service layer. `systemctl`/`loginctl` are faked
// through `_internal.exec`; nothing here reaches a real init system (physical
// Linux verification is #1564, deferred under Ruling A185).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const systemd = require('../lib/linux-systemd');
const cli = require('../scripts/linux-systemd-install.js');

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
});

describe('scripts/linux-systemd-install.js CLI (#1424, PRR-A Round 1 on PR #2899)', () => {
  let original;
  let tmpDir;
  let out;
  let origWrite;

  beforeEach(() => {
    original = systemd._internal.exec;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-systemd-cli-'));
    out = [];
    origWrite = process.stdout.write;
    process.stdout.write = (chunk) => { out.push(chunk); return true; };
  });

  afterEach(() => {
    systemd._internal.exec = original;
    process.stdout.write = origWrite;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  describe('parseArgs', () => {
    it('accepts each subcommand with its defaults (repo root, process.execPath, no home-dir override)', () => {
      const opts = cli.parseArgs(['verify']);
      assert.equal(opts.command, 'verify');
      assert.equal(opts.repoDir, cli.REPO_ROOT);
      assert.equal(opts.nodeBin, process.execPath);
      assert.equal(opts.homeDir, undefined);
    });

    it('accepts --repo-dir, --node-bin and --home-dir overrides', () => {
      const opts = cli.parseArgs(['install', '--repo-dir', '/opt/tc', '--node-bin', '/usr/bin/node', '--home-dir', '/home/tc']);
      assert.equal(opts.repoDir, '/opt/tc');
      assert.equal(opts.nodeBin, '/usr/bin/node');
      assert.equal(opts.homeDir, '/home/tc');
    });

    it('refuses an unknown subcommand, an unrecognized flag, and a flag missing its value', () => {
      assert.throws(() => cli.parseArgs(['nope']));
      assert.throws(() => cli.parseArgs(['verify', '--nope', 'x']));
      assert.throws(() => cli.parseArgs(['install', '--repo-dir']));
    });
  });

  it('verify passes for a unit file that meets its own contract', async () => {
    const code = await cli.main(['verify', '--repo-dir', '/opt/tangleclaw', '--node-bin', '/usr/bin/node']);
    assert.equal(code, 0, out.join(''));
    assert.match(out.join(''), /verify passed/);
  });

  it('verify fails, with the reason on stderr, for a repoDir that is not absolute', async () => {
    const stderrChunks = [];
    const origErr = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
    try {
      const code = await cli.main(['verify', '--repo-dir', 'relative/path']);
      assert.equal(code, 1);
      assert.match(stderrChunks.join(''), /could not generate the unit file/);
    } finally {
      process.stderr.write = origErr;
    }
  });

  it('install writes the unit file under --home-dir, never the real home directory', async () => {
    systemd._internal.exec = async () => ({ exitCode: 0, stdout: '', stderr: '', error: null });
    const code = await cli.main(['install', '--repo-dir', '/opt/tangleclaw', '--node-bin', '/usr/bin/node', '--home-dir', tmpDir]);
    assert.equal(code, 0, out.join(''));
    assert.equal(fs.existsSync(systemd.unitFilePath(tmpDir)), true);
  });

  it('uninstall against --home-dir is a no-op success when nothing was installed there', async () => {
    systemd._internal.exec = async (f, args) => (args[1] === 'stop'
      ? { exitCode: 5, stdout: '', stderr: 'Unit tangleclaw.service not loaded.', error: null }
      : { exitCode: 0, stdout: '', stderr: '', error: null });
    const code = await cli.main(['uninstall', '--home-dir', tmpDir]);
    assert.equal(code, 0, out.join(''));
    assert.match(out.join(''), /uninstall ok/);
  });

  it('status reports unavailable, with its reason, when systemctl is not installed', async () => {
    systemd._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: '', error: null, errorCode: 'ENOENT', timedOut: false });
    const code = await cli.main(['status']);
    assert.equal(code, 1);
    assert.match(out.join(''), /status unavailable/);
  });

  it('exits 4 and prints to stderr, not stdout, for an unparseable argv', async () => {
    const stderrChunks = [];
    const origErr = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
    try {
      const code = await cli.main(['nope']);
      assert.equal(code, 4);
      assert.deepEqual(out, []);
      assert.ok(stderrChunks.join('').includes('unknown subcommand'));
    } finally {
      process.stderr.write = origErr;
    }
  });
});
