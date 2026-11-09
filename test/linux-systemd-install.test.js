'use strict';

// scripts/linux-systemd-install.js's CLI (#1424, PRR-A Round 1 on PR #2899).
// Moved out of test/linux-systemd.test.js by #2931 (Car 5730-W1-B), which
// also adds the --unit ttyd/caddy/bridge-helper coverage below — one test
// file per source file, matching e.g.
// test/cache-bump-guard.test.js/scripts/cache-bump-guard.js. `systemctl`/
// `loginctl`/`which` are faked; nothing here reaches a real init system or
// a real ttyd/caddy binary (physical Linux verification is #1564, deferred
// under Ruling A185).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const systemd = require('../lib/linux-systemd');
const ttydRuntime = require('../lib/ttyd-runtime');
const cli = require('../scripts/linux-systemd-install.js');

setLevel('error');

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
    it('accepts each subcommand with its defaults (repo root, process.execPath, no home-dir override, --unit server)', () => {
      const opts = cli.parseArgs(['verify']);
      assert.equal(opts.command, 'verify');
      assert.equal(opts.unit, 'server');
      assert.equal(opts.repoDir, cli.REPO_ROOT);
      assert.equal(opts.nodeBin, process.execPath);
      assert.equal(opts.homeDir, undefined);
      assert.equal(opts.mode, 'direct');
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

    it('refuses an unknown --unit (#2931)', () => {
      assert.throws(() => cli.parseArgs(['verify', '--unit', 'nope']), /--unit must be one of/);
    });

    it('refuses an unknown --mode (#2931)', () => {
      assert.throws(() => cli.parseArgs(['verify', '--unit', 'ttyd', '--mode', 'nope']), /--mode must be/);
    });

    it('parses and range-checks --ttyd-port (#2931)', () => {
      assert.equal(cli.parseArgs(['verify', '--unit', 'ttyd', '--ttyd-port', '8080']).ttydPort, 8080);
      assert.throws(() => cli.parseArgs(['verify', '--unit', 'ttyd', '--ttyd-port', '0']), /--ttyd-port must be/);
      assert.throws(() => cli.parseArgs(['verify', '--unit', 'ttyd', '--ttyd-port', '65536']), /--ttyd-port must be/);
      assert.throws(() => cli.parseArgs(['verify', '--unit', 'ttyd', '--ttyd-port', 'nope']), /--ttyd-port must be/);
    });

    it('accepts every companion-specific flag (#2931)', () => {
      const opts = cli.parseArgs([
        'install', '--unit', 'caddy', '--base-dir', '/x/.tangleclaw',
        '--caddy-path', '/x/caddy', '--caddyfile', '/x/Caddyfile'
      ]);
      assert.equal(opts.unit, 'caddy');
      assert.equal(opts.baseDir, '/x/.tangleclaw');
      assert.equal(opts.caddyPath, '/x/caddy');
      assert.equal(opts.caddyfile, '/x/Caddyfile');
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

describe('scripts/linux-systemd-install.js CLI — companion units (#2931)', () => {
  let original;
  let tmpDir;
  let out;
  let origWrite;
  let origWhich;
  let origResolveTtydPath;

  beforeEach(() => {
    original = systemd._internal.exec;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-systemd-cli-companions-'));
    out = [];
    origWrite = process.stdout.write;
    process.stdout.write = (chunk) => { out.push(chunk); return true; };
    origWhich = cli._internal.which;
    origResolveTtydPath = ttydRuntime.resolveTtydPath;
  });

  afterEach(() => {
    systemd._internal.exec = original;
    process.stdout.write = origWrite;
    cli._internal.which = origWhich;
    ttydRuntime.resolveTtydPath = origResolveTtydPath;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  describe('resolveUnit', () => {
    it('server: unchanged (repoDir/nodeBin only)', () => {
      const unit = cli.resolveUnit({ unit: 'server', repoDir: '/opt/tc', nodeBin: '/usr/bin/node', homeDir: tmpDir });
      assert.equal(unit.serviceName, systemd.SERVICE_NAME);
      assert.match(unit.generate(), /^ExecStart=\/usr\/bin\/node \/opt\/tc\/server\.js$/m);
    });

    it('ttyd: direct mode binds 127.0.0.1 with an empty socket to unlink', () => {
      const unit = cli.resolveUnit({
        unit: 'ttyd', mode: 'direct', ttydPath: '/x/ttyd', ttydAttachScript: '/x/attach.sh',
        baseDir: '/x/.tangleclaw', homeDir: tmpDir
      });
      assert.equal(unit.serviceName, systemd.TTYD_SERVICE_NAME);
      const text = unit.generate();
      assert.match(text, /--interface' '127\.0\.0\.1'/);
      assert.match(text, /^Environment=TTYD_SOCKET=$/m);
    });

    it('ttyd: caddy mode binds a Unix socket under --base-dir/run/ttyd.sock', () => {
      const unit = cli.resolveUnit({
        unit: 'ttyd', mode: 'caddy', ttydPath: '/x/ttyd', ttydAttachScript: '/x/attach.sh',
        baseDir: '/x/.tangleclaw', homeDir: tmpDir
      });
      const text = unit.generate();
      assert.match(text, /--interface' '\/x\/\.tangleclaw\/run\/ttyd\.sock'/);
      assert.match(text, /^Environment=TTYD_SOCKET=\/x\/\.tangleclaw\/run\/ttyd\.sock$/m);
    });

    it('ttyd: resolves ttydPath via lib/ttyd-runtime.js when --ttyd-path is not given', () => {
      ttydRuntime.resolveTtydPath = ({ baseDir }) => ({ path: path.join(baseDir, 'bin', 'ttyd'), managed: true, warning: null });
      const unit = cli.resolveUnit({ unit: 'ttyd', mode: 'direct', ttydAttachScript: '/x/attach.sh', baseDir: '/x/.tangleclaw', homeDir: tmpDir });
      assert.match(unit.generate(), /'\/x\/\.tangleclaw\/bin\/ttyd'/);
    });

    it('caddy: resolves caddyPath via which() when --caddy-path is not given', () => {
      cli._internal.which = () => '/usr/local/bin/caddy';
      const unit = cli.resolveUnit({ unit: 'caddy', baseDir: '/x/.tangleclaw', homeDir: tmpDir });
      assert.match(unit.generate(), /^ExecStart=\/usr\/local\/bin\/caddy run/m);
    });

    it('caddy: throws a clear error when caddy is not on PATH and --caddy-path is not given (lazily — not until generate() is actually called)', () => {
      cli._internal.which = () => null;
      const unit = cli.resolveUnit({ unit: 'caddy', baseDir: '/x/.tangleclaw', homeDir: tmpDir });
      assert.throws(() => unit.generate(), /caddy was not found on PATH/);
    });

    it('bridge-helper: unchanged (repoDir/nodeBin only)', () => {
      const unit = cli.resolveUnit({ unit: 'bridge-helper', repoDir: '/opt/tc', nodeBin: '/usr/bin/node', homeDir: tmpDir });
      assert.equal(unit.serviceName, systemd.BRIDGE_HELPER_SERVICE_NAME);
      assert.match(unit.generate(), /^ExecStart=\/usr\/bin\/node \/opt\/tc\/bin\/tc-bridge-helper run$/m);
    });
  });

  it('verify --unit ttyd passes with explicit overrides, writing nothing', async () => {
    const code = await cli.main(['verify', '--unit', 'ttyd', '--ttyd-path', '/x/ttyd', '--ttyd-attach-script', '/x/attach.sh']);
    assert.equal(code, 0, out.join(''));
    assert.match(out.join(''), /verify passed/);
  });

  it('verify --unit ttyd reports the ttyd-runtime resolver\'s own error when no --ttyd-path is given', async () => {
    ttydRuntime.resolveTtydPath = () => { throw new Error('no managed runtime here'); };
    const stderrChunks = [];
    const origErr = process.stderr.write;
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
    try {
      const code = await cli.main(['verify', '--unit', 'ttyd', '--base-dir', '/x/.tangleclaw']);
      assert.equal(code, 1);
      assert.match(stderrChunks.join(''), /could not generate the unit file/);
      assert.match(stderrChunks.join(''), /no managed runtime here/);
    } finally {
      process.stderr.write = origErr;
    }
  });

  it('verify --unit caddy passes with explicit overrides', async () => {
    const code = await cli.main(['verify', '--unit', 'caddy', '--caddy-path', '/x/caddy', '--caddyfile', '/x/Caddyfile', '--home-dir', tmpDir]);
    assert.equal(code, 0, out.join(''));
    assert.match(out.join(''), /verify passed/);
  });

  it('verify --unit bridge-helper passes with the default repoDir/nodeBin', async () => {
    const code = await cli.main(['verify', '--unit', 'bridge-helper']);
    assert.equal(code, 0, out.join(''));
    assert.match(out.join(''), /verify passed/);
  });

  it('install --unit ttyd writes tangleclaw-ttyd.service under --home-dir', async () => {
    systemd._internal.exec = async () => ({ exitCode: 0, stdout: '', stderr: '', error: null });
    const code = await cli.main(['install', '--unit', 'ttyd', '--ttyd-path', '/x/ttyd', '--ttyd-attach-script', '/x/attach.sh', '--home-dir', tmpDir]);
    assert.equal(code, 0, out.join(''));
    assert.equal(fs.existsSync(systemd.unitFilePath(tmpDir, systemd.TTYD_SERVICE_NAME)), true);
  });

  it('install --unit caddy writes tangleclaw-caddy.service under --home-dir', async () => {
    systemd._internal.exec = async () => ({ exitCode: 0, stdout: '', stderr: '', error: null });
    const code = await cli.main(['install', '--unit', 'caddy', '--caddy-path', '/x/caddy', '--caddyfile', path.join(tmpDir, 'Caddyfile'), '--home-dir', tmpDir]);
    assert.equal(code, 0, out.join(''));
    assert.equal(fs.existsSync(systemd.unitFilePath(tmpDir, systemd.CADDY_SERVICE_NAME)), true);
  });

  it('install --unit bridge-helper writes tangleclaw-bridge-helper.service under --home-dir', async () => {
    systemd._internal.exec = async () => ({ exitCode: 0, stdout: '', stderr: '', error: null });
    const code = await cli.main(['install', '--unit', 'bridge-helper', '--repo-dir', '/opt/tangleclaw', '--home-dir', tmpDir]);
    assert.equal(code, 0, out.join(''));
    assert.equal(fs.existsSync(systemd.unitFilePath(tmpDir, systemd.BRIDGE_HELPER_SERVICE_NAME)), true);
  });

  it('uninstall --unit ttyd against --home-dir is a no-op success when nothing was installed there', async () => {
    systemd._internal.exec = async (f, args) => (args[1] === 'stop'
      ? { exitCode: 5, stdout: '', stderr: 'Unit tangleclaw-ttyd.service not loaded.', error: null }
      : { exitCode: 0, stdout: '', stderr: '', error: null });
    const code = await cli.main(['uninstall', '--unit', 'ttyd', '--home-dir', tmpDir]);
    assert.equal(code, 0, out.join(''));
    assert.match(out.join(''), /uninstall ok/);
  });

  it('status --unit caddy queries the caddy service name, not the server\'s', async () => {
    const calls = [];
    systemd._internal.exec = async (f, args) => { calls.push([f, ...args]); return { exitCode: 0, stdout: 'LoadState=loaded\n', stderr: '', error: null }; };
    const code = await cli.main(['status', '--unit', 'caddy']);
    assert.equal(code, 0, out.join(''));
    assert.deepEqual(calls, [['systemctl', '--user', 'show', 'tangleclaw-caddy.service']]);
  });
});
