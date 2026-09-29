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

  it('pf profile denies everything but loopback, SSH in from the host, and DHCP 68→67 with the attested server, all on the guest interface', () => {
    const rules = fs.readFileSync(path.join(GUEST, 'pf', 'soak-deny.conf'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(rules, [
      'set block-policy drop',
      'set skip on lo0',
      'block drop all',
      'pass in quick on $guest_if inet proto tcp from $host_addr to ($guest_if) port 22 flags S/SA keep state',
      'pass out quick on $guest_if inet proto udp from any port 68 to 255.255.255.255 port 67 keep state',
      'pass out quick on $guest_if inet proto udp from any port 68 to $dhcp_server port 67 keep state',
      'pass in quick on $guest_if inet proto udp from $dhcp_server port 67 to any port 68 keep state'
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
    assert.equal(calls[3], `tart run vm-t --no-graphics --dir=soak:${fs.realpathSync(share)}`);
  });

  it('refuses a VM name that already exists instead of reusing it', () => {
    f = fakes(tmp, { tart: 'vm-t\n' });
    const r = runScript(HOST_PROVISION, ['--execute'], f.bin, { HOME: tmp, SOAK_SHARE_DIR: share, SOAK_OPERATOR_APPROVED: '1', SOAK_VM_NAME: 'vm-t' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /already exists/);
    assert.deepEqual(f.calls(), ['tart list --quiet']);
  });

  it('refuses to share $HOME, anything containing it, /, a relative path or a missing directory', () => {
    fs.symlinkSync(tmp, path.join(share, 'to-home'));
    const cases = [
      tmp, `${tmp}/`, `${tmp}/.`, `${share}/..`, path.dirname(tmp),
      path.join(share, 'to-home'), '/', 'relative/share', path.join(tmp, 'missing')
    ];
    for (const dir of cases) {
      const r = runScript(HOST_PROVISION, [], f.bin, { HOME: tmp, SOAK_SHARE_DIR: dir });
      assert.equal(r.status, 3, `${dir}: ${r.stdout}`);
      assert.match(r.stderr, /^refused: /m, dir);
    }
    assert.deepEqual(f.calls(), []);
  });

  it('prints the resolved share path, so a symlinked share is shown as what the guest gets', () => {
    const real = path.join(tmp, 'real-share');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmp, 'link-share'));
    const r = runScript(HOST_PROVISION, [], f.bin, { HOME: tmp, SOAK_SHARE_DIR: path.join(tmp, 'link-share') });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`--dir=soak:${fs.realpathSync(real)}`), r.stdout);
  });

  it('exits 2 on an unknown argument', () => {
    assert.equal(runScript(HOST_PROVISION, ['--force'], f.bin, { HOME: tmp, SOAK_SHARE_DIR: share }).status, 2);
  });
});


/** The rules pfctl reports for the profile, in its normalized form (fake). */
const PF_RULES = [
  'block drop all',
  'pass in quick on en0 inet proto tcp from 192.168.64.1 to (en0) port = 22 flags S/SA keep state',
  'pass out quick on en0 inet proto udp from any port = 68 to 255.255.255.255 port = 67 keep state',
  'pass out quick on en0 inet proto udp from any port = 68 to 192.168.64.2 port = 67 keep state',
  'pass in quick on en0 inet proto udp from 192.168.64.2 port = 67 to any port = 68 keep state'
].join('\n') + '\n';

/**
 * Fake system commands for guest-setup.sh inside a "VM". `FAKE_USER` in the
 * environment is who is running (default the admin); `sudo -u` switches it,
 * and only the admin may use sudo or pfctl. Each command logs its call, with
 * the user, to calls.log; `over` replaces a command's shell body so a test can
 * make one thing misbehave.
 * @param {string} dir - Directory to create them in
 * @param {Object<string, string>} [over] - Command name → shell body
 * @returns {{bin: string, calls: () => string[]}} Fakes
 */
function guestFakes(dir, over = {}) {
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rules.txt'), PF_RULES);
  const rules = path.join(dir, 'rules.txt');
  const bodies = {
    uname: 'echo Darwin',
    sysctl: [
      'case "$*" in',
      '  "-n kern.hv_vmm_present") echo 1;;',
      '  "-n kern.bootsessionuuid") echo 11111111-2222-3333-4444-555555555555;;',
      '  "-n kern.boottime") echo "{ sec = 1790000000, usec = 0 } Tue Sep 29 00:00:00 2026";;',
      'esac'
    ].join('\n'),
    sudo: [
      '[ "$1" = "-v" ] && exit 0',
      '[ "$1" = "-n" ] && shift',
      'if [ "$1" = "-l" ]; then echo "User $3 is not allowed to run sudo on guest."; exit 0; fi',
      'if [ "$1" = "-u" ]; then u="$2"; shift 2; [ "$1" = "-H" ] && shift; FAKE_USER="$u"; export FAKE_USER; exec "$@"; fi',
      '[ "${FAKE_USER:-admin}" = admin ] || exit 1',
      'exec "$@"'
    ].join('\n'),
    pfctl: [
      '[ "${FAKE_USER:-admin}" = admin ] || { echo "pfctl: /dev/pf: Permission denied" >&2; exit 1; }',
      'case "$*" in',
      '  "-s info") echo "Status: Enabled for 0 days 00:00:01";;',
      `  "-s rules") cat "${rules}";;`,
      `  *"-n -v"*) cat "${rules}";;`,
      '  "-s Interfaces -v") printf "en0\\nlo0 (skip)\\n";;',
      'esac'
    ].join('\n'),
    id: [
      'u="${FAKE_USER:-admin}"',
      'case "$*" in',
      '  -un) echo "$u";;',
      '  -u) if [ "$u" = admin ]; then echo 501; else echo 502; fi;;',
      '  -Gn) if [ "$u" = admin ]; then echo "staff admin"; else echo "staff everyone localaccounts"; fi;;',
      '  *) [ -n "$FAKE_USER_EXISTS" ] && exit 0; exit 1;;',
      'esac'
    ].join('\n'),
    dseditgroup: 'exit 1',
    sysadminctl: 'exit 0',
    openssl: 'echo 0123456789abcdef',
    install: 'exit 0',
    mkdir: 'exit 0',
    node: 'exit 0',
    ifconfig: 'exit 0',
    // The lease names a DHCP server that is not the SSH host, so nothing can
    // pass by assuming the two are the same.
    ipconfig: [
      'case "$*" in',
      '  "getifaddr en0") echo 192.168.64.5;;',
      '  "getpacket en0") printf "op = BOOTREPLY\\nyiaddr = 192.168.64.5\\nserver_identifier (ip): 192.168.64.2\\nlease_time (uint32): 0x15180\\n";;',
      '  *) exit 1;;',
      'esac'
    ].join('\n'),
    netstat: 'echo "tcp4       0      0  *.22                   *.*                    LISTEN"',
    ping: 'exit 0',
    ping6: 'exit 0',
    nc: 'exit 1',
    dig: 'exit 9',
    curl: [
      'case "$*" in',
      '  *api/projects/attach*) printf 201;;',
      '  *http_code*) printf 404;;',
      'esac'
    ].join('\n'),
    ...over
  };
  for (const [name, body] of Object.entries(bodies)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "[\${FAKE_USER:-admin}] ${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  }
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

/**
 * Run guest-setup.sh with the fakes, a short probe timeout, and `env` on top.
 * @param {string[]} args - Arguments
 * @param {{bin: string}} f - Fakes
 * @param {string} home - HOME
 * @param {Object<string, string>} [env] - Extra environment
 * @returns {{status: number, stdout: string, stderr: string, json: object[]}} Result, with stdout's JSON lines parsed
 */
function setup(args, f, home, env = {}) {
  const r = runScript(GUEST_SETUP, args, f.bin, { HOME: home, SOAK_PROBE_TIMEOUT: '2', ...env });
  const json = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  return { ...r, json };
}

/**
 * The sha256 of a string, as shasum prints it.
 * @param {string|Buffer} s - Input
 * @returns {string} Hex digest
 */
const sha256 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');

describe('soak guest: guest-setup.sh setup', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-guest-setup-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the workload user, loads pf, attests both planes, then installs, creates and attaches, in that order', () => {
    const f = guestFakes(tmp);
    const r = setup([], f, tmp);
    assert.equal(r.status, 0, r.stderr);
    const calls = f.calls();
    const idx = (re) => calls.findIndex((c) => re.test(c));
    const order = [
      /^\[admin\] sysadminctl -addUser soakrun .*-password 0123456789abcdef$/,
      /^\[admin\] pfctl -D host_addr=192\.168\.64\.1 -D dhcp_server=192\.168\.64\.2 -D guest_if=en0 -f .*soak-deny\.conf -E$/,
      /^\[admin\] pfctl -s rules$/,
      /^\[soakrun\] ping6 -c 1 ::1$/,
      /^\[soakrun\] dig @1\.1\.1\.1 /,
      /^\[admin\] install -m 0755 .*soak-stub\.js .*\/soak-stub$/,
      /^\[soakrun\] node .*scripts\/soak\.js repos --root \/Users\/soakrun\/Projects --origins \/Users\/soakrun\/soak-origins --projects soak-a,soak-b,soak-c$/
    ];
    let last = -1;
    for (const re of order) {
      const i = idx(re);
      assert.ok(i > last, `${re} out of order or missing:\n${calls.join('\n')}`);
      last = i;
    }
    for (const name of ['soak-a', 'soak-b', 'soak-c']) {
      assert.ok(calls.some((c) => c.includes(`{"name":"${name}"}`) && c.includes('http://127.0.0.1:3102/api/projects/attach')), name);
    }
    assert.deepEqual(r.json.map((j) => [j.mode, j.ok]), [['admin', true], ['workload', true]]);
    assert.match(r.stdout, /guest ready/);
  });

  it('reuses an existing non-admin workload user without recreating it', () => {
    const f = guestFakes(tmp);
    const r = setup([], f, tmp, { FAKE_USER_EXISTS: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!f.calls().some((c) => c.includes('sysadminctl')));
  });

  it('refuses a workload user in the admin group, before touching pf, and never demotes it', () => {
    const f = guestFakes(tmp, { dseditgroup: 'case "$*" in *" admin") exit 0;; *) exit 1;; esac' });
    const r = setup([], f, tmp, { FAKE_USER_EXISTS: '1' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /member of admin/);
    assert.ok(!f.calls().some((c) => /pfctl -D/.test(c) || /dseditgroup -o (edit|delete)/.test(c)));
  });

  it('refuses a workload user with sudo rights', () => {
    const f = guestFakes(tmp, { sudo: '[ "$1" = "-v" ] && exit 0\n[ "$1" = "-n" ] && shift\nif [ "$1" = "-l" ]; then echo "User soakrun may run the following commands"; exit 0; fi\nexec "$@"' });
    const r = setup([], f, tmp, { FAKE_USER_EXISTS: '1' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /has sudo rights/);
  });

  const badInputs = {
    'an interface name carrying shell or pf syntax': { SOAK_GUEST_IF: 'en0 -f /etc/pf.conf' },
    'lo0 as the guest interface': { SOAK_GUEST_IF: 'lo0' },
    'an out-of-range host address': { SOAK_HOST_ADDR: '999.1.1.1' },
    'a host address with trailing text': { SOAK_HOST_ADDR: '192.168.64.1 -f x' },
    'root as the workload user': { SOAK_WORKLOAD_USER: 'root' },
    'a non-synthetic project': { SOAK_PROJECTS: 'soak-a,prod' },
    'a zero probe timeout': { SOAK_PROBE_TIMEOUT: '0' }
  };
  for (const [label, env] of Object.entries(badInputs)) {
    it(`refuses ${label} before any sudo, user or pf action`, () => {
      const f = guestFakes(tmp);
      const r = setup([], f, tmp, env);
      assert.equal(r.status, 3, `${label}: ${r.stderr}`);
      assert.ok(!f.calls().some((c) => /\] (sudo|pfctl|sysadminctl)/.test(c)), f.calls().join('\n'));
    });
  }

  it('skips a project the guest already has, and refuses when the auth gate is up', () => {
    let f = guestFakes(tmp, { curl: 'case "$*" in *http_code*) printf 200;; esac' });
    let r = setup([], f, tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls().filter((c) => c.includes('api/projects/attach')).length, 0);
    fs.rmSync(path.join(tmp, 'calls.log'));
    f = guestFakes(tmp, { curl: 'case "$*" in *api/projects/attach*) printf 401;; *http_code*) printf 404;; esac' });
    r = setup([], f, tmp);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /auth gate is up/);
  });

  it('exits 2 on an unknown or retired argument', () => {
    const f = guestFakes(tmp);
    for (const arg of ['--verify-network', '--skip-network']) assert.equal(setup([arg], f, tmp).status, 2, arg);
    assert.deepEqual(f.calls(), []);
  });
});

describe('soak guest: admin verifier', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-guest-admin-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prints one JSON line attesting pf, the exact ruleset fingerprint, the interface, SSH and the boot identity', () => {
    const f = guestFakes(tmp);
    const r = setup(['--verify-admin'], f, tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    const [j] = r.json;
    assert.equal(j.schema, 'tc.soak-guest-attest/v1');
    assert.equal(j.mode, 'admin');
    assert.equal(j.ok, true);
    assert.deepEqual(j.pf, { enabled: true, expectedRulesSha256: sha256(PF_RULES), activeRulesSha256: sha256(PF_RULES), rulesMatch: true, rules: 5 });
    assert.deepEqual(j.interface, { name: 'en0', address: '192.168.64.5' });
    assert.equal(j.host, '192.168.64.1');
    assert.deepEqual(j.dhcp, { server: '192.168.64.2', source: 'lease', leaseSeconds: 86400 });
    assert.deepEqual(j.management, { ssh: 'listening' });
    assert.deepEqual(j.boot, { session: '11111111-2222-3333-4444-555555555555', time: 1790000000 });
    assert.deepEqual(j.artifact, { scriptSha256: sha256(fs.readFileSync(GUEST_SETUP)), profileSha256: sha256(fs.readFileSync(path.join(GUEST, 'pf', 'soak-deny.conf'))) });
    assert.ok(!f.calls().some((c) => / -E$/.test(c)), 'a verifier must never load pf');
    assert.ok(f.calls().some((c) => c.includes('pfctl -n -v -D host_addr=192.168.64.1 -D dhcp_server=192.168.64.2 -D guest_if=en0 -f ')));
  });

  it('uses a configured DHCP server over the lease, and says so', () => {
    const rules = path.join(tmp, 'rules.txt');
    const f = guestFakes(tmp);
    fs.writeFileSync(rules, PF_RULES.replaceAll('192.168.64.2', '192.168.64.9'));
    const r = setup(['--verify-admin'], f, tmp, { SOAK_DHCP_SERVER: '192.168.64.9' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json[0].dhcp.server, '192.168.64.9');
    assert.equal(r.json[0].dhcp.source, 'config');
  });

  it('reports both ruleset digests and rulesMatch false when the loaded rules differ', () => {
    const f = guestFakes(tmp, { pfctl: `case "$*" in "-s info") echo "Status: Enabled";; "-s rules") printf "pass out all\\n"; cat "$RULES";; *"-n -v"*) cat "$RULES";; esac` });
    const r = setup(['--verify-admin'], f, tmp, { RULES: path.join(tmp, 'rules.txt') });
    assert.equal(r.status, 3);
    const [j] = r.json;
    assert.equal(j.ok, false);
    assert.equal(j.pf.rulesMatch, false);
    assert.equal(j.pf.expectedRulesSha256, sha256(PF_RULES));
    assert.equal(j.pf.activeRulesSha256, sha256(`pass out all\n${PF_RULES}`));
  });

  const failures = {
    'sudo is unavailable': [{}, { FAKE_USER: 'soakrun' }, /needs non-interactive sudo/],
    'pf is disabled': [{ pfctl: 'case "$*" in "-s info") echo "Status: Disabled";; esac' }, {}, /pf is not enabled/],
    'an extra rule is loaded': [{ pfctl: `case "$*" in "-s info") echo "Status: Enabled";; "-s rules") printf "pass out all\\n"; cat "${'${RULES}'}";; *"-n -v"*) cat "${'${RULES}'}";; "-s Interfaces -v") echo "lo0 (skip)";; esac` }, {}, /not exactly the soak profile/],
    'pfctl parses a different rule count': [{ pfctl: 'case "$*" in "-s info") echo "Status: Enabled";; *"-n -v"*) echo "block drop all";; esac' }, {}, /unexpected number of rules/],
    'lo0 is not skipped': [{ pfctl: `case "$*" in "-s info") echo "Status: Enabled";; "-s rules"|*"-n -v"*) cat "${'${RULES}'}";; "-s Interfaces -v") echo "lo0";; esac` }, {}, /not skipping lo0/],
    'the guest interface has no address': [{ ipconfig: 'case "$*" in "getpacket en0") echo "server_identifier (ip): 192.168.64.2";; *) exit 1;; esac' }, {}, /no IPv4 address/],
    'there is no DHCP lease and none is configured': [{ ipconfig: 'case "$*" in "getifaddr en0") echo 192.168.64.5;; *) exit 1;; esac' }, {}, /no valid DHCP server/],
    'the configured DHCP server is not an address': [{}, { SOAK_DHCP_SERVER: '192.168.64.2 port 53' }, /no valid DHCP server/],
    'SSH is not listening': [{ netstat: 'echo "tcp4 0 0 127.0.0.1.3102 *.* LISTEN"' }, {}, /SSH management path is down/],
    'the boot identity is unreadable': [{ sysctl: 'case "$*" in "-n kern.hv_vmm_present") echo 1;; esac' }, {}, /boot identity/]
  };
  for (const [label, [over, env, reason]] of Object.entries(failures)) {
    it(`fails closed (exit 3, ok:false) when ${label}`, () => {
      const f = guestFakes(tmp, over);
      const r = setup(['--verify-admin'], f, tmp, { RULES: path.join(tmp, 'rules.txt'), ...env });
      assert.equal(r.status, 3, `${label}: ${r.stderr}`);
      assert.equal(r.json.length, 1);
      assert.equal(r.json[0].ok, false);
      assert.match(r.json[0].reason, reason);
    });
  }
});

describe('soak guest: workload verifier', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-guest-workload-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('as the workload user, attests identity, refused privileges, loopback and denied egress, without inspecting pf', () => {
    const f = guestFakes(tmp);
    const r = setup(['--verify-workload'], f, tmp, { FAKE_USER: 'soakrun' });
    assert.equal(r.status, 0, r.stderr);
    const [j] = r.json;
    assert.equal(j.mode, 'workload');
    assert.equal(j.ok, true);
    assert.deepEqual(j.identity, { user: 'soakrun', uid: 502, groups: 'staff everyone localaccounts' });
    assert.deepEqual(j.refused, ['sudo', 'pfctl']);
    assert.deepEqual(Object.keys(j.artifact), ['scriptSha256', 'profileSha256']);
    assert.ok(!f.calls().some((c) => c.includes('getpacket')), 'the workload plane has no use for the lease');
    assert.deepEqual(j.egress, { tcp4: 'denied', tcp6: 'denied', udpDns: 'denied' });
    assert.equal(j.boot.session, '11111111-2222-3333-4444-555555555555');
    const pf = f.calls().filter((c) => c.includes('] pfctl'));
    assert.deepEqual(pf, ['[soakrun] pfctl -s info'], 'pfctl is only tried, to prove it is refused');
    for (const re of [/nc -z -G 3 1\.1\.1\.1 443$/, /nc -6 -z -G 3 2606:4700:4700::1111 443$/, /dig @1\.1\.1\.1 \+time=2 \+tries=1 /]) {
      assert.ok(f.calls().some((c) => re.test(c)), String(re));
    }
  });

  const failures = {
    'it runs as the admin instead': [{}, { FAKE_USER: 'admin' }, /must run as soakrun/],
    'the workload is in the admin group': [{ id: 'case "$*" in -un) echo soakrun;; -u) echo 502;; -Gn) echo "staff admin";; esac' }, {}, /in the admin group/],
    'the workload has a system uid': [{ id: 'case "$*" in -un) echo soakrun;; -u) echo 0;; -Gn) echo staff;; esac' }, {}, /system or root uid/],
    'sudo works for the workload': [{ sudo: 'exit 0' }, {}, /sudo works/],
    'pfctl works for the workload': [{ pfctl: 'echo "Status: Enabled"' }, {}, /pfctl works/],
    'sudo hangs': [{ sudo: 'sleep 30' }, {}, /sudo hung/],
    'IPv4 loopback is down': [{ ping: 'exit 2' }, {}, /IPv4 loopback/],
    'IPv6 loopback hangs': [{ ping6: 'sleep 30' }, {}, /IPv6 loopback/],
    'the guest API does not answer': [{ curl: 'exit 7' }, {}, /no TangleClaw answering/],
    'IPv4 egress answers': [{ nc: 'case "$*" in *-6*) exit 1;; *) exit 0;; esac' }, {}, /\(IPv4\) answered/],
    'IPv6 egress answers': [{ nc: 'case "$*" in *-6*) exit 0;; *) exit 1;; esac' }, {}, /\(IPv6\) answered/],
    'a TCP egress probe hangs': [{ nc: 'sleep 30' }, {}, /hung past 2s: denial is not proven/],
    'DNS over UDP answers': [{ dig: 'exit 0' }, {}, /over UDP answered/]
  };
  for (const [label, [over, env, reason]] of Object.entries(failures)) {
    it(`fails closed (exit 3, ok:false) when ${label}`, () => {
      const f = guestFakes(tmp, over);
      const started = Date.now();
      const r = setup(['--verify-workload'], f, tmp, { FAKE_USER: 'soakrun', ...env });
      assert.equal(r.status, 3, `${label}: ${r.stderr}`);
      assert.equal(r.json.length, 1);
      assert.equal(r.json[0].ok, false);
      assert.match(r.json[0].reason, reason);
      assert.ok(Date.now() - started < 15000, 'a hung probe must be cut off by the watchdog');
    });
  }
});

describe('soak guest: guest-setup.sh guards', () => {
  let tmp;
  let f;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-guest-guard-'));
    f = fakes(tmp, { sudo: '', pfctl: '', sysctl: '0', uname: 'Darwin', node: '', curl: '' });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const mode of [[], ['--verify-admin'], ['--verify-workload']]) {
    it(`refuses in a live TangleClaw pane before touching anything (${mode[0] || 'setup'})`, () => {
      const r = runScript(GUEST_SETUP, mode, f.bin, { HOME: tmp, TANGLECLAW_API: 'http://localhost:3102' });
      assert.equal(r.status, 3);
      assert.match(r.stderr, /live TangleClaw pane/);
      assert.deepEqual(f.calls(), []);
    });
  }

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
