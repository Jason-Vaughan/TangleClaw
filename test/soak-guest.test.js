'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUEST = path.join(__dirname, '..', 'deploy', 'soak', 'guest');
const HOST_PROVISION = path.join(GUEST, 'host-provision.sh');
const GUEST_SETUP = path.join(GUEST, 'guest-setup.sh');

/**
 * A bin directory of fake commands that record every call to `calls.log` and
 * print a fixed answer, so no test can reach real tart, sudo or pfctl.
 * @param {string} dir - Directory to create them in
 * @param {Object<string, string>} answers - Command name → stdout
 * @returns {{bin: string, calls: () => string[]}} Fakes
 */
function fakes(dir, answers) {
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, out] of Object.entries(answers)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nprintf '%b' '${out}'\n`, { mode: 0o755 });
  }
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

/**
 * Run a script with PATH led by the fakes and a controlled environment.
 * @param {string} script - Script path
 * @param {string[]} args - Arguments
 * @param {string} bin - Fake bin directory
 * @param {Object<string, string>} env - Extra environment
 * @returns {{status: number, stdout: string, stderr: string}} Result
 */
function runScript(script, args, bin, env) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: env.HOME, ...env }
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('soak guest: files', () => {
  it('has scripts that parse as bash and are executable', () => {
    for (const f of [HOST_PROVISION, GUEST_SETUP]) {
      const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.ok((fs.statSync(f).mode & 0o111) !== 0, `${f} is not executable`);
    }
  });

  it('pf profile denies everything but loopback and SSH in from the host', () => {
    const rules = fs.readFileSync(path.join(GUEST, 'pf', 'soak-deny.conf'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(rules, [
      'set block-policy drop',
      'set skip on lo0',
      'block drop all',
      'pass in quick inet proto tcp from $host_addr to any port 22 flags S/SA keep state'
    ]);
  });

  it('guest.conf assigns no secret or credential', () => {
    const assigned = fs.readFileSync(path.join(GUEST, 'guest.conf'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('#'))
      .map((l) => (l.match(/\$\{(\w+):=/) || [])[1]).filter(Boolean);
    assert.ok(assigned.length > 0);
    for (const name of assigned) assert.doesNotMatch(name, /TOKEN|PASSWORD|SECRET|KEY|CREDENTIAL/i, name);
  });

  it('guest.conf names the same synthetic projects the schedule defaults to', () => {
    const schedule = require('../lib/soak/schedule');
    const m = fs.readFileSync(path.join(GUEST, 'guest.conf'), 'utf8').match(/SOAK_PROJECTS:=([^}]+)\}/);
    assert.deepEqual(m[1].split(','), [...schedule.DEFAULTS.projects]);
  });
});

describe('soak guest: host-provision.sh', () => {
  let tmp;
  let share;
  let f;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-guest-'));
    share = path.join(tmp, 'share');
    fs.mkdirSync(share);
    f = fakes(tmp, { tart: '' });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prints the tart commands and runs nothing by default', () => {
    const r = runScript(HOST_PROVISION, [], f.bin, { HOME: tmp, SOAK_SHARE_DIR: share, SOAK_OPERATOR_APPROVED: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run: nothing executed/);
    assert.match(r.stdout, /^tart clone /m);
    assert.match(r.stdout, /^tart run tc-soak-guest --no-graphics --dir=soak:/m);
    assert.deepEqual(f.calls(), []);
  });

  it('refuses --execute without operator approval, running nothing', () => {
    const r = runScript(HOST_PROVISION, ['--execute'], f.bin, { HOME: tmp, SOAK_SHARE_DIR: share });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /SOAK_OPERATOR_APPROVED=1/);
    assert.deepEqual(f.calls(), []);
  });

  it('with --execute and approval, clones, sets and runs the named VM', () => {
    const r = runScript(HOST_PROVISION, ['--execute'], f.bin, { HOME: tmp, SOAK_SHARE_DIR: share, SOAK_OPERATOR_APPROVED: '1', SOAK_VM_NAME: 'vm-t' });
    assert.equal(r.status, 0, r.stderr);
    const calls = f.calls();
    assert.equal(calls[0], 'tart list --quiet');
    assert.match(calls[1], /^tart clone \S+ vm-t$/);
    assert.equal(calls[2], 'tart set vm-t --cpu 4 --memory 8192 --disk-size 80');
    assert.equal(calls[3], `tart run vm-t --no-graphics --dir=soak:${share}`);
  });

  it('refuses a VM name that already exists instead of reusing it', () => {
    f = fakes(tmp, { tart: 'vm-t\n' });
    const r = runScript(HOST_PROVISION, ['--execute'], f.bin, { HOME: tmp, SOAK_SHARE_DIR: share, SOAK_OPERATOR_APPROVED: '1', SOAK_VM_NAME: 'vm-t' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /already exists/);
    assert.deepEqual(f.calls(), ['tart list --quiet']);
  });

  it('refuses to share $HOME, /, or a relative path into the guest', () => {
    for (const dir of [tmp, `${tmp}/`, '/', 'relative/share']) {
      const r = runScript(HOST_PROVISION, [], f.bin, { HOME: tmp, SOAK_SHARE_DIR: dir });
      assert.equal(r.status, 3, dir);
    }
  });

  it('exits 2 on an unknown argument', () => {
    assert.equal(runScript(HOST_PROVISION, ['--force'], f.bin, { HOME: tmp, SOAK_SHARE_DIR: share }).status, 2);
  });
});

/**
 * Fake system commands for a full guest-setup.sh run inside a "VM". Each one
 * logs its call; `over` replaces a command's script body, so a test can make
 * one probe misbehave.
 * @param {string} dir - Directory to create them in
 * @param {Object<string, string>} [over] - Command name → shell body
 * @returns {{bin: string, calls: () => string[]}} Fakes
 */
function guestFakes(dir, over = {}) {
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  const bodies = {
    uname: 'echo Darwin',
    sysctl: 'echo 1',
    sudo: 'exec "$@"',
    pfctl: [
      'case "$*" in',
      '  "-s info") echo "Status: Enabled for 0 days 00:00:01";;',
      '  "-s rules") printf "block drop all\\npass in quick inet proto tcp from 192.168.64.1 to any port = 22 flags S/SA keep state\\n";;',
      '  "-s Interfaces -v") printf "en0\\nlo0 (skip)\\n";;',
      'esac'
    ].join('\n'),
    ping: 'exit 0',
    ping6: 'exit 0',
    nc: 'exit 1',
    dig: 'exit 9',
    install: 'exit 0',
    node: 'exit 0',
    curl: [
      'case "$*" in',
      '  *api/projects/attach*) printf 201;;',
      '  *http_code*) printf 404;;',
      'esac'
    ].join('\n'),
    ...over
  };
  for (const [name, body] of Object.entries(bodies)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  }
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

describe('soak guest: guest-setup.sh network proof', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-guest-net-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Whether any call after the network step ran (stub, repos or attach).
   * @param {string[]} calls - Logged calls
   * @returns {boolean} True when setup went past the network proof
   */
  const wentPastNetwork = (calls) => calls.some((c) => /^install |^node |api\/projects/.test(c));

  it('with everything holding, proves the network then installs, creates and attaches, in that order', () => {
    const f = guestFakes(tmp);
    const r = runScript(GUEST_SETUP, [], f.bin, { HOME: tmp });
    assert.equal(r.status, 0, r.stderr);
    const calls = f.calls();
    const idx = (re) => calls.findIndex((c) => re.test(c));
    assert.ok(idx(/^pfctl -D host_addr=192\.168\.64\.1 -f .*soak-deny\.conf -E$/) >= 0);
    for (const re of [/^pfctl -s info$/, /^pfctl -s rules$/, /^ping -c 1 -t 2 127\.0\.0\.1$/, /^ping6 -c 1 ::1$/, /^nc -z -G 3 1\.1\.1\.1 443$/, /^nc -6 -z -G 3 2606:4700:4700::1111 443$/, /^dig @1\.1\.1\.1 /]) {
      assert.ok(idx(re) >= 0 && idx(re) < idx(/^install /), `${re} must run before the stub install`);
    }
    assert.ok(idx(/^curl -fsS --max-time 10 http:\/\/127\.0\.0\.1:3102\/api\/health$/) < idx(/^install /));
    assert.ok(idx(/^node .*scripts\/soak\.js repos --root .* --origins .* --projects soak-a,soak-b,soak-c$/) > idx(/^install /));
    for (const name of ['soak-a', 'soak-b', 'soak-c']) {
      assert.ok(calls.some((c) => c.includes(`{"name":"${name}"}`) && c.includes('http://127.0.0.1:3102/api/projects/attach')), name);
    }
    assert.match(r.stdout, /guest ready/);
  });

  const failures = {
    'pf not enabled': { pfctl: 'case "$*" in "-s info") echo "Status: Disabled";; esac' },
    'an extra pass-out rule loaded': { pfctl: 'case "$*" in "-s info") echo "Status: Enabled";; "-s rules") printf "block drop all\\npass out all\\npass in quick inet proto tcp from 192.168.64.1 to any port = 22 flags S/SA keep state\\n";; "-s Interfaces -v") echo "lo0 (skip)";; esac' },
    'no rules loaded': { pfctl: 'case "$*" in "-s info") echo "Status: Enabled";; "-s Interfaces -v") echo "lo0 (skip)";; esac' },
    'lo0 not skipped': { pfctl: 'case "$*" in "-s info") echo "Status: Enabled";; "-s rules") printf "block drop all\\npass in quick inet proto tcp from 192.168.64.1 to any port = 22 flags S/SA keep state\\n";; "-s Interfaces -v") echo "lo0";; esac' },
    'IPv4 loopback down': { ping: 'exit 2' },
    'IPv6 loopback down': { ping6: 'exit 2' },
    'guest API not answering': { curl: 'exit 7' },
    'IPv4 egress reachable': { nc: 'case "$*" in *-6*) exit 1;; *) exit 0;; esac' },
    'IPv6 egress reachable': { nc: 'case "$*" in *-6*) exit 0;; *) exit 1;; esac' },
    'DNS over UDP answered': { dig: 'exit 0' }
  };
  for (const [label, over] of Object.entries(failures)) {
    it(`refuses (exit 3) before any workload when ${label}`, () => {
      const f = guestFakes(tmp, over);
      const r = runScript(GUEST_SETUP, [], f.bin, { HOME: tmp });
      assert.equal(r.status, 3, `${label}: ${r.stderr}`);
      assert.match(r.stderr, /^refused: /m);
      assert.equal(wentPastNetwork(f.calls()), false, `${label} went on to: ${f.calls().join(' | ')}`);
    });
  }

  it('skips a project the guest already has, and refuses when the auth gate is up', () => {
    let f = guestFakes(tmp, { curl: 'case "$*" in *http_code*) printf 200;; esac' });
    let r = runScript(GUEST_SETUP, [], f.bin, { HOME: tmp });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls().filter((c) => c.includes('api/projects/attach')).length, 0);
    fs.rmSync(path.join(tmp, 'calls.log'));
    f = guestFakes(tmp, { curl: 'case "$*" in *api/projects/attach*) printf 401;; *http_code*) printf 404;; esac' });
    r = runScript(GUEST_SETUP, [], f.bin, { HOME: tmp });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /auth gate is up/);
  });
});

describe('soak guest: guest-setup.sh', () => {
  let tmp;
  let f;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-guest-setup-'));
    f = fakes(tmp, { sudo: '', pfctl: '', sysctl: '0', uname: 'Darwin', node: '', curl: '' });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses in a live TangleClaw pane before touching anything', () => {
    const r = runScript(GUEST_SETUP, [], f.bin, { HOME: tmp, TANGLECLAW_API: 'http://localhost:3102' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /live TangleClaw pane/);
    assert.deepEqual(f.calls(), []);
  });

  it('refuses outside macOS', () => {
    f = fakes(tmp, { sudo: '', sysctl: '1', uname: 'Linux' });
    const r = runScript(GUEST_SETUP, [], f.bin, { HOME: tmp });
    assert.equal(r.status, 3);
    assert.ok(!f.calls().some((c) => c.startsWith('sudo')));
  });

  it('refuses on a machine that is not a VM, before any sudo', () => {
    const r = runScript(GUEST_SETUP, [], f.bin, { HOME: tmp });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /not a virtual machine/);
    assert.ok(!f.calls().some((c) => c.startsWith('sudo')));
  });
});
