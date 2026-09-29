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
  let home;
  let share;
  let f;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-guest-'));
    // HOME and the share are siblings: a share inside HOME is refused.
    home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    share = path.join(tmp, 'share');
    fs.mkdirSync(share);
    f = fakes(tmp, { tart: '' });
    // stat, as the host-side trust check asks it: everything is the operator's
    // and closed, unless FAKE_BAD_PATH names a path to report as FAKE_BAD_META.
    fs.writeFileSync(path.join(f.bin, 'stat'), [
      '#!/bin/sh',
      'p="$3"',
      'if [ -n "$FAKE_BAD_PATH" ] && [ "$p" = "$FAKE_BAD_PATH" ]; then echo "$FAKE_BAD_META"; exit 0; fi',
      'u=$(id -u)',
      'case "$2" in',
      '  "%u %Lp") echo "$u 755";;',
      '  *) if [ -d "$p" ]; then echo "$u 755 Directory"; else echo "$u 644 Regular File"; fi;;',
      'esac'
    ].join('\n'), { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prints the tart commands and runs nothing by default', () => {
    const r = runScript(HOST_PROVISION, [], f.bin, { HOME: home, SOAK_SHARE_DIR: share, SOAK_OPERATOR_APPROVED: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run: nothing executed/);
    assert.match(r.stdout, /^tart clone /m);
    assert.match(r.stdout, /^tart run tc-soak-guest --no-graphics --dir=soak:/m);
    assert.deepEqual(f.calls(), []);
  });

  it('refuses --execute without operator approval, running nothing', () => {
    const r = runScript(HOST_PROVISION, ['--execute'], f.bin, { HOME: home, SOAK_SHARE_DIR: share });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /SOAK_OPERATOR_APPROVED=1/);
    assert.deepEqual(f.calls(), []);
  });

  it('with --execute and approval, clones, sets and runs the named VM', () => {
    const r = runScript(HOST_PROVISION, ['--execute'], f.bin, { HOME: home, SOAK_SHARE_DIR: share, SOAK_OPERATOR_APPROVED: '1', SOAK_VM_NAME: 'vm-t' });
    assert.equal(r.status, 0, r.stderr);
    const calls = f.calls();
    assert.equal(calls[0], 'tart list --quiet');
    assert.match(calls[1], /^tart clone \S+ vm-t$/);
    assert.equal(calls[2], 'tart set vm-t --cpu 4 --memory 8192 --disk-size 80');
    assert.equal(calls[3], `tart run vm-t --no-graphics --dir=soak:${fs.realpathSync(share)}`);
  });

  it('refuses a VM name that already exists instead of reusing it', () => {
    f = fakes(tmp, { tart: 'vm-t\n' });
    const r = runScript(HOST_PROVISION, ['--execute'], f.bin, { HOME: home, SOAK_SHARE_DIR: share, SOAK_OPERATOR_APPROVED: '1', SOAK_VM_NAME: 'vm-t' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /already exists/);
    assert.deepEqual(f.calls(), ['tart list --quiet']);
  });

  it('refuses to share $HOME, anything containing it, anything inside it, /, a relative path or a missing directory', () => {
    fs.symlinkSync(home, path.join(share, 'to-home'));
    const cases = [
      home, `${home}/`, `${home}/.`, `${home}/.ssh/..`, tmp, path.dirname(tmp),
      path.join(share, 'to-home'), '/', 'relative/share', path.join(tmp, 'missing'),
      path.join(home, '.ssh')
    ];
    for (const dir of cases) {
      const r = runScript(HOST_PROVISION, [], f.bin, { HOME: home, SOAK_SHARE_DIR: dir });
      assert.equal(r.status, 3, `${dir}: ${r.stdout}`);
      assert.match(r.stderr, /^refused: /m, dir);
    }
    assert.deepEqual(f.calls(), []);
  });

  it('prints the resolved share path, so a symlinked share is shown as what the guest gets', () => {
    const real = path.join(tmp, 'real-share');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmp, 'link-share'));
    const r = runScript(HOST_PROVISION, [], f.bin, { HOME: home, SOAK_SHARE_DIR: path.join(tmp, 'link-share') });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`--dir=soak:${fs.realpathSync(real)}`), r.stdout);
  });

  it('exits 2 on an unknown argument', () => {
    assert.equal(runScript(HOST_PROVISION, ['--force'], f.bin, { HOME: home, SOAK_SHARE_DIR: share }).status, 2);
  });

  const hostTrust = {
    'host-provision.sh is group-writable': [() => HOST_PROVISION, '501 664 Regular File', /host-provision\.sh is writable by group or others/],
    'guest.conf is a symlink': [() => path.join(GUEST, 'guest.conf'), '501 755 Symbolic Link', /guest\.conf is a 'Symbolic Link'/],
    'an ancestor is owned by someone else': [() => path.dirname(GUEST), '777 755 Directory', /is owned by uid 777/],
    'the share is owned by someone else': [() => fs.realpathSync(share), '0 755', /is owned by uid 0, not you/],
    'the share is group-writable': [() => fs.realpathSync(share), `${process.getuid()} 775`, /is writable by group or others \(mode 775\)/]
  };
  for (const [label, [target, meta, reason]] of Object.entries(hostTrust)) {
    it(`refuses (exit 3, no tart) when ${label}`, () => {
      const r = runScript(HOST_PROVISION, [], f.bin, { HOME: home, SOAK_SHARE_DIR: share, FAKE_BAD_PATH: target(), FAKE_BAD_META: meta });
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stderr, reason);
      assert.deepEqual(f.calls(), []);
    });
  }

  it('refuses --execute into a share that is not empty', () => {
    fs.writeFileSync(path.join(share, 'leftover'), 'x');
    const r = runScript(HOST_PROVISION, ['--execute'], f.bin, { HOME: home, SOAK_SHARE_DIR: share, SOAK_OPERATOR_APPROVED: '1' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /is not empty/);
    assert.ok(!f.calls().some((c) => c.startsWith('tart clone')));
  });
});


/** A real node binary, so the executable check can canonicalize the path it is given. */
const NODE = process.execPath;

/** A lease's three timing fields (1 day, renew at 12 h, rebind at 21 h), for printf. */
const TIMING = 'lease_time (uint32): 0x15180\\nrenewal_t1_time_value (uint32): 0xa8c0\\nrebinding_t2_time_value (uint32): 0x12750';

/** The rules pfctl reports for the profile, in its normalized form (fake). */
const PF_RULES = [
  'block drop all',
  'pass in quick on en0 inet proto tcp from 192.168.64.1 to (en0) port = 22 flags S/SA keep state',
  'pass out quick on en0 inet proto udp from any port = 68 to 255.255.255.255 port = 67 keep state',
  'pass out quick on en0 inet proto udp from any port = 68 to 192.168.64.2 port = 67 keep state',
  'pass in quick on en0 inet proto udp from 192.168.64.2 port = 67 to any port = 68 keep state'
].join('\n') + '\n';

/**
 * A LeaseStartTime string, as the fake ipconfig reports it, some seconds ago.
 * @param {number} seconds - How long ago the lease started
 * @returns {string} `YYYY-MM-DD HH:MM:SS +0000`
 */
function leaseStartAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');
}

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
  const leaseStart = leaseStartAgo(3600);
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
      // sudo -l -U <user> <cmd>: the admin may; anyone else may not.
      'if [ "$1" = "-l" ]; then [ "$3" = admin ] && exit 0; echo "User $3 is not allowed to run sudo on guest."; exit 1; fi',
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
      '  "-u soakrun") echo 502;;',
      '  -Gn) if [ "$u" = admin ]; then echo "staff admin"; else echo "staff everyone localaccounts"; fi;;',
      '  *) [ -n "$FAKE_USER_EXISTS" ] && exit 0; exit 1;;',
      'esac'
    ].join('\n'),
    dseditgroup: 'exit 1',
    // The guest TangleClaw listening on 3102 is pid 4242, uid 502 (soakrun), executing node.
    lsof: [
      'case "$*" in',
      '  *-iTCP:3102*) printf "p4242\\nu502\\nf12\\n";;',
      `  *"-d txt"*) printf "p4242\\nftxt\\nn${NODE}\\nftxt\\nn/usr/lib/dyld\\n";;`,
      'esac'
    ].join('\n'),
    ps: `case "$*" in *uid=*) echo "  502";; *comm=*) echo "${NODE}";; esac`,
    // stat answers in the forms the script asks for: the workload home's owner
    // (%u), or owner/mode/type for the checkout trust check. FAKE_BAD_PATH and
    // FAKE_BAD_META make one path report something else.
    stat: [
      'p="$3"',
      'if [ -n "$FAKE_BAD_PATH" ] && [ "$p" = "$FAKE_BAD_PATH" ]; then echo "$FAKE_BAD_META"; exit 0; fi',
      'case "$2" in',
      '  %u) if [ "$p" = /Users/soakrun ]; then echo 502; else echo 501; fi;;',
      '  *) if [ -d "$p" ]; then echo "501 755 Directory"; else echo "501 644 Regular File"; fi;;',
      'esac'
    ].join('\n'),
    // test as the workload: nothing is writable unless FAKE_WRITABLE names it,
    // and FAKE_SUDO_U_BROKEN makes the positive control (-r) fail too.
    test: [
      'if [ "${FAKE_USER:-admin}" = soakrun ]; then',
      '  [ -n "$FAKE_SUDO_U_BROKEN" ] && exit 1',
      '  if [ "$1" = "-w" ]; then [ -n "$FAKE_WRITABLE" ] && [ "$2" = "$FAKE_WRITABLE" ] && exit 0; exit 1; fi',
      'fi',
      // The shell's own test builtin: its path differs between macOS and Linux.
      'test "$@"; exit $?'
    ].join('\n'),
    dscl: 'echo "NFSHomeDirectory: /Users/soakrun"',
    sysadminctl: 'exit 0',
    openssl: 'echo 0123456789abcdef',
    install: 'exit 0',
    mkdir: 'exit 0',
    // The attestation encoder runs on the real node; `soak.js repos` is only logged.
    node: `[ "$1" = "-e" ] && exec "${process.execPath}" "$@"\nexit 0`,
    ifconfig: 'exit 0',
    // The lease names a DHCP server that is not the SSH host, so nothing can
    // pass by assuming the two are the same.
    ipconfig: [
      'case "$*" in',
      '  "getifaddr en0") echo 192.168.64.5;;',
      '  "getpacket en0") printf "op = BOOTREPLY\\nyiaddr = 192.168.64.5\\nserver_identifier (ip): 192.168.64.2\\nlease_time (uint32): 0x15180\\nrenewal_t1_time_value (uint32): 0xa8c0\\nrebinding_t2_time_value (uint32): 0x12750\\n";;',
      `  "getsummary en0") printf "<dictionary> {\\n  LeaseStartTime : ${leaseStart}\\n}\\n";;`,
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
    if (body === null) continue; // leave the command missing
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
  const r = runScript(GUEST_SETUP, args, f.bin, { HOME: home, SOAK_PROBE_TIMEOUT: '2', SOAK_DHCP_SERVER: '192.168.64.2', ...env });
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
      /^\[admin\] lsof -nP -iTCP:3102 -sTCP:LISTEN -Fpu$/,
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
    const f = guestFakes(tmp, { sudo: '[ "$1" = "-v" ] && exit 0\n[ "$1" = "-n" ] && shift\nif [ "$1" = "-l" ]; then [ "$3" = admin ] && exit 0; case "$4" in /sbin/pfctl) echo "/sbin/pfctl"; exit 0;; *) exit 1;; esac; fi\nexec "$@"' });
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
    'a zero probe timeout': { SOAK_PROBE_TIMEOUT: '0' },
    'a loopback IPv4 egress probe': { SOAK_EGRESS_PROBE_ADDR: '127.0.0.2' },
    'a private IPv4 egress probe': { SOAK_EGRESS_PROBE_ADDR: '10.1.2.3' },
    'a CGNAT IPv4 egress probe': { SOAK_EGRESS_PROBE_ADDR: '100.64.0.1' },
    'a link-local DNS probe': { SOAK_DNS_PROBE_ADDR: '169.254.1.1' },
    'a private DNS probe': { SOAK_DNS_PROBE_ADDR: '192.168.64.1' },
    'a loopback IPv6 probe': { SOAK_EGRESS_PROBE_ADDR6: '::1' },
    'a link-local IPv6 probe': { SOAK_EGRESS_PROBE_ADDR6: 'fe80::1' },
    'a unique-local IPv6 probe': { SOAK_EGRESS_PROBE_ADDR6: 'FD00::1' },
    'a documentation IPv6 probe': { SOAK_EGRESS_PROBE_ADDR6: '2001:db8::1' },
    'a malformed IPv6 probe with too few groups': { SOAK_EGRESS_PROBE_ADDR6: '1:2:3' },
    'a malformed IPv6 probe with two ::': { SOAK_EGRESS_PROBE_ADDR6: '2606::4700::1' },
    'an unspecified-range IPv6 probe': { SOAK_EGRESS_PROBE_ADDR6: '::2' },
    'an IPv4 address given as the IPv6 probe': { SOAK_EGRESS_PROBE_ADDR6: '1.1.1.1' },
    'an IPv4 documentation probe': { SOAK_EGRESS_PROBE_ADDR: '192.0.2.1' },
    'an IPv4 documentation DNS probe': { SOAK_DNS_PROBE_ADDR: '203.0.113.9' },
    'an IPv4 benchmark probe': { SOAK_EGRESS_PROBE_ADDR: '198.18.0.1' },
    'an IPv4 probe with a leading-zero octet': { SOAK_EGRESS_PROBE_ADDR: '01.1.1.1' }
  };
  for (const [label, env] of Object.entries(badInputs)) {
    it(`refuses ${label} before any sudo, user or pf action`, () => {
      const f = guestFakes(tmp);
      const r = setup([], f, tmp, env);
      assert.equal(r.status, 3, `${label}: ${r.stderr}`);
      assert.ok(!f.calls().some((c) => /\] (sudo|pfctl|sysadminctl)/.test(c)), f.calls().join('\n'));
    });
  }

  it('--bootstrap-user creates the workload user and stops, before pf, the owner check or any workload', () => {
    const f = guestFakes(tmp);
    const r = setup(['--bootstrap-user'], f, tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /start the pinned TangleClaw as soakrun/);
    const calls = f.calls();
    assert.ok(calls.some((c) => c.includes('sysadminctl -addUser soakrun')));
    // node runs to validate the probe literals; soak.js (the workload) must not.
    assert.ok(!calls.some((c) => /\] (pfctl|lsof|install|curl|ipconfig) |\] node .*soak\.js/.test(c)), calls.join('\n'));
  });

  it('refuses setup before loading pf when the guest TangleClaw runs as the admin', () => {
    const f = guestFakes(tmp, { lsof: 'printf "p4242\\nu501\\n"' });
    const r = setup([], f, tmp);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /not soakrun/);
    assert.ok(!f.calls().some((c) => /pfctl -D/.test(c)));
  });

  it('refuses an existing account with a system uid or a foreign home, without adopting it', () => {
    let f = guestFakes(tmp, { id: 'case "$*" in "-u soakrun") echo 300;; -u) echo 501;; -un) echo admin;; *) exit 0;; esac' });
    let r = setup(['--bootstrap-user'], f, tmp, { FAKE_USER_EXISTS: '1' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /system or unknown uid/);
    fs.rmSync(path.join(tmp, 'calls.log'));
    f = guestFakes(tmp, { dscl: 'echo "NFSHomeDirectory: /var/empty"' });
    r = setup(['--bootstrap-user'], f, tmp, { FAKE_USER_EXISTS: '1' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /home is '\/var\/empty'/);
    assert.ok(!f.calls().some((c) => /sysadminctl|dseditgroup -o edit/.test(c)));
  });

  it('refuses setup when TangleClaw listens as both the workload user and another', () => {
    const f = guestFakes(tmp, { lsof: 'printf "p1\\nu502\\np2\\nu501\\n"' });
    assert.equal(setup([], f, tmp).status, 3);
  });

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

/**
 * A fake ipconfig whose lease holds the given extra fields and whose summary
 * holds the given lines, with the usual address and DHCP server.
 * @param {string} packetExtra - Extra getpacket lines (\\n-separated, for printf)
 * @param {string} summary - getsummary lines (\\n-separated, for printf), or ''
 * @returns {string} Shell body
 */
function packetWith(packetExtra, summary) {
  return [
    'case "$*" in',
    '  "getifaddr en0") echo 192.168.64.5;;',
    `  "getpacket en0") printf "server_identifier (ip): 192.168.64.2\\n${packetExtra}\\n";;`,
    `  "getsummary en0") printf "<dictionary> {\\n${summary}\\n}\\n";;`,
    'esac'
  ].join('\n');
}

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
    const { observedEpoch, remainingSeconds, leaseStartRaw, ...dhcp } = j.dhcp;
    const start = Math.floor(Date.parse(leaseStartRaw.replace(' ', 'T').replace(' +0000', 'Z')) / 1000);
    assert.deepEqual(dhcp, {
      server: '192.168.64.2', leaseServer: '192.168.64.2', leaseSeconds: 86400,
      leaseStartEpoch: start, leaseExpiryEpoch: start + 86400, renewEpoch: start + 43200, rebindEpoch: start + 75600,
      requiredSeconds: 900, sampleIntervalSeconds: 600, safetyMarginSeconds: 300
    });
    assert.ok(Math.abs(Date.now() / 1000 - observedEpoch) < 60);
    assert.equal(remainingSeconds, start + 86400 - observedEpoch);
    assert.deepEqual(j.management, { ssh: 'listening' });
    assert.deepEqual(j.tangleclaw, { port: 3102, user: 'soakrun', uid: 502, pid: 4242, executable: fs.realpathSync(NODE) });
    assert.deepEqual(j.boot, { session: '11111111-2222-3333-4444-555555555555', time: 1790000000 });
    assert.deepEqual(j.artifact, {
      scriptSha256: sha256(fs.readFileSync(GUEST_SETUP)),
      profileSha256: sha256(fs.readFileSync(path.join(GUEST, 'pf', 'soak-deny.conf'))),
      guestConfSha256: sha256(fs.readFileSync(path.join(GUEST, 'guest.conf')))
    });
    assert.equal(j.trust.workloadCannotWrite, true);
    assert.ok(j.trust.files >= 8 && j.trust.dirs >= 5, JSON.stringify(j.trust));
    assert.ok(!f.calls().some((c) => / -E$/.test(c)), 'a verifier must never load pf');
    assert.ok(f.calls().some((c) => c.includes('pfctl -n -v -D host_addr=192.168.64.1 -D dhcp_server=192.168.64.2 -D guest_if=en0 -f ')));
  });

  it('accepts a TangleClaw started as a bare `node` from PATH: its argv[0] is not the executable evidence', () => {
    const f = guestFakes(tmp, { ps: 'case "$*" in *uid=*) echo "  502";; *comm=*) echo node;; esac' });
    const r = setup(['--verify-admin'], f, tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json[0].tangleclaw.executable, fs.realpathSync(NODE));
    assert.ok(!f.calls().some((c) => c.includes('comm=')), 'ps comm must not be consulted');
  });

  it('encodes the line with a real JSON encoder, so a reason carrying quotes and newlines still parses', () => {
    const f = guestFakes(tmp, { pfctl: `case "$*" in "-s info") echo "Status: Enabled";; "-s rules") printf 'pass out all "quoted"\\n'; cat "$RULES";; *"-n -v"*) cat "$RULES";; esac` });
    const r = setup(['--verify-admin'], f, tmp, { RULES: path.join(tmp, 'rules.txt') });
    assert.equal(r.status, 3);
    assert.match(r.json[0].reason, /pass out all "quoted"\nblock drop all/);
  });

  it('with no encoder available, still prints a fixed, valid failure line', () => {
    const f = guestFakes(tmp, { node: null });
    const r = setup(['--verify-admin'], f, tmp);
    assert.equal(r.status, 3);
    assert.deepEqual(r.json, [{ schema: 'tc.soak-guest-attest/v1', mode: 'admin', ok: false, code: 'ENCODER_MISSING', reason: 'node is missing, so no attestation can be encoded' }]);
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
    'sudo is unavailable': [{ sudo: '[ "$1" = "-n" ] && shift\n[ "$1" = true ] && exit 1\nif [ "$1" = "-l" ]; then [ "$3" = admin ] && exit 0; exit 1; fi\n[ "${FAKE_USER:-admin}" = admin ] || exit 1\nexec "$@"' }, {}, /needs non-interactive sudo/],
    'pf is disabled': [{ pfctl: 'case "$*" in "-s info") echo "Status: Disabled";; esac' }, {}, /pf is not enabled/],
    'an extra rule is loaded': [{ pfctl: `case "$*" in "-s info") echo "Status: Enabled";; "-s rules") printf "pass out all\\n"; cat "${'${RULES}'}";; *"-n -v"*) cat "${'${RULES}'}";; "-s Interfaces -v") echo "lo0 (skip)";; esac` }, {}, /not exactly the soak profile/],
    'pfctl parses a different rule count': [{ pfctl: 'case "$*" in "-s info") echo "Status: Enabled";; *"-n -v"*) echo "block drop all";; esac' }, {}, /unexpected number of rules/],
    'lo0 is not skipped': [{ pfctl: `case "$*" in "-s info") echo "Status: Enabled";; "-s rules"|*"-n -v"*) cat "${'${RULES}'}";; "-s Interfaces -v") echo "lo0";; esac` }, {}, /not skipping lo0/],
    'the guest interface has no address': [{ ipconfig: packetWith(TIMING, `LeaseStartTime : ${leaseStartAgo(60)}`).replace('echo 192.168.64.5', 'exit 1') }, {}, /no IPv4 address/],
    'the guest has no DHCP lease': [{ ipconfig: 'case "$*" in "getifaddr en0") echo 192.168.64.5;; *) exit 1;; esac' }, {}, /has no DHCP lease/],
    'the DHCP server comes from the lease alone': [{}, { SOAK_DHCP_SERVER: '' }, /a lease alone is not trusted/],
    'the configured DHCP server differs from the lease': [{}, { SOAK_DHCP_SERVER: '192.168.64.9' }, /lease's DHCP server is 192\.168\.64\.2, not the configured 192\.168\.64\.9/],
    'the configured DHCP server is not an address': [{}, { SOAK_DHCP_SERVER: '192.168.64.2 port 53' }, /not an IPv4 address/],
    'the lease names two DHCP servers': [{ ipconfig: 'case "$*" in "getifaddr en0") echo 192.168.64.5;; "getpacket en0") printf "server_identifier (ip): 192.168.64.2\\nserver_identifier (ip): 192.168.64.7\\nlease_time (uint32): 0x15180\\n";; esac' }, {}, /server_identifier 2 times/],
    'the lease time is malformed': [{ ipconfig: 'case "$*" in "getifaddr en0") echo 192.168.64.5;; "getpacket en0") printf "server_identifier (ip): 192.168.64.2\\nlease_time (uint32): forever\\n";; esac' }, {}, /lease_time is malformed/],
    'the lease is not reported to have started': [{ ipconfig: packetWith(TIMING, '') }, {}, /does not report when the lease started/],
    'the lease start is unparseable': [{ ipconfig: packetWith(TIMING, 'LeaseStartTime : yesterday') }, {}, /not in the expected form/],
    'the lease start is reported twice': [{ ipconfig: packetWith(TIMING, `LeaseStartTime : ${leaseStartAgo(60)}\\nLeaseStartTime : ${leaseStartAgo(60)}`) }, {}, /more than once/],
    'the lease start is in the future': [{ ipconfig: packetWith(TIMING, `LeaseStartTime : ${leaseStartAgo(-3600)}`) }, {}, /out of range/],
    'the lease has expired': [{ ipconfig: packetWith(TIMING, `LeaseStartTime : ${leaseStartAgo(2 * 86400)}`) }, {}, /lease expired/],
    'less lease remains than the next attestation window': [{ ipconfig: packetWith(TIMING, `LeaseStartTime : ${leaseStartAgo(86400 - 300)}`) }, {}, /less than the next sample interval plus margin \(900 s\)/],
    'renewal comes after rebinding': [{ ipconfig: packetWith('lease_time (uint32): 0x15180\\nrenewal_t1_time_value (uint32): 0x12750\\nrebinding_t2_time_value (uint32): 0xa8c0', `LeaseStartTime : ${leaseStartAgo(60)}`) }, {}, /timing is inconsistent/],
    'renewal equals rebinding': [{ ipconfig: packetWith('lease_time (uint32): 0x15180\\nrenewal_t1_time_value (uint32): 0xa8c0\\nrebinding_t2_time_value (uint32): 0xa8c0', `LeaseStartTime : ${leaseStartAgo(60)}`) }, {}, /timing is inconsistent/],
    'rebinding reaches the lease end': [{ ipconfig: packetWith('lease_time (uint32): 0x15180\\nrenewal_t1_time_value (uint32): 0xa8c0\\nrebinding_t2_time_value (uint32): 0x15180', `LeaseStartTime : ${leaseStartAgo(60)}`) }, {}, /timing is inconsistent/],
    'the lease omits its renewal time': [{ ipconfig: packetWith('lease_time (uint32): 0x15180\\nrebinding_t2_time_value (uint32): 0x12750', `LeaseStartTime : ${leaseStartAgo(60)}`) }, {}, /must report lease_time, renewal_t1_time_value and rebinding_t2_time_value/],
    'the renewal field appears twice': [{ ipconfig: packetWith('lease_time (uint32): 0x15180\\nrenewal_t1_time_value (uint32): 0xa8c0\\nrenewal_t1_time_value (uint32): 0xa8c0', `LeaseStartTime : ${leaseStartAgo(60)}`) }, {}, /renewal_t1_time_value 2 times/],
    'the rebinding value is malformed': [{ ipconfig: packetWith('lease_time (uint32): 0x15180\\nrebinding_t2_time_value (uint32): soon', `LeaseStartTime : ${leaseStartAgo(60)}`) }, {}, /rebinding_t2_time_value is malformed/],
    'more than one process listens on the TangleClaw port': [{ lsof: 'printf "p1\\nu502\\np2\\nu502\\n"' }, {}, /more than one process/],
    'ps disagrees about the TangleClaw uid': [{ ps: 'echo "  501"' }, {}, /ps reports pid 4242 as uid '501'/],
    'the TangleClaw process is not node': [{ lsof: 'case "$*" in *-iTCP:3102*) printf "p4242\\nu502\\n";; *"-d txt"*) printf "p4242\\nn/usr/bin/python3\\n";; esac' }, {}, /maps 0 node executables/],
    'the lease has no lease time': [{ ipconfig: 'case "$*" in "getifaddr en0") echo 192.168.64.5;; "getpacket en0") printf "server_identifier (ip): 192.168.64.2\\n";; esac' }, {}, /must report lease_time/],
    'the TangleClaw process maps two node executables': [{ lsof: `case "$*" in *-iTCP:3102*) printf "p4242\\nu502\\n";; *"-d txt"*) printf "p4242\\nn${NODE}\\nn/opt/other/bin/node\\n";; esac` }, {}, /maps 2 node executables/],
    'the workload account became an admin after setup': [{ dseditgroup: 'case "$*" in *" admin") exit 0;; *) exit 1;; esac' }, {}, /member of admin/],
    'the workload account gained sudo after setup': [{ sudo: '[ "$1" = "-n" ] && shift\nif [ "$1" = "-l" ]; then exit 0; fi\n[ "${FAKE_USER:-admin}" = admin ] || exit 1\nexec "$@"' }, {}, /has sudo rights \(\/bin\/sh is permitted\)/],
    'sudo -l hangs for the workload account': [{ sudo: '[ "$1" = "-n" ] && shift\nif [ "$1" = "-l" ]; then [ "$3" = admin ] && exit 0; sleep 30; fi\n[ "${FAKE_USER:-admin}" = admin ] || exit 1\nexec "$@"' }, {}, /sudo -l for soakrun hung/],
    'the workload home is owned by someone else': [{ stat: 'case "$2" in %u) if [ "$3" = /Users/soakrun ]; then echo 0; else echo 501; fi;; *) if [ -d "$3" ]; then echo "501 755 Directory"; else echo "501 644 Regular File"; fi;; esac' }, {}, /is not owned by soakrun/],
    'SSH is not listening': [{ netstat: 'echo "tcp4 0 0 127.0.0.1.3102 *.* LISTEN"' }, {}, /SSH management path is down/],
    'the guest TangleClaw runs as the admin': [{ lsof: 'printf "p4242\\nu501\\n"' }, {}, /runs as uid 501 not soakrun/],
    'nothing listens on the TangleClaw port': [{ lsof: 'exit 1' }, {}, /nothing is listening on port 3102/],
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

const REPO = path.join(__dirname, '..');

describe('soak guest: checkout trust (B1)', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-guest-trust-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const refusals = {
    'guest.conf is group-writable': [{ FAKE_BAD_PATH: path.join(GUEST, 'guest.conf'), FAKE_BAD_META: '501 664 Regular File' }, /guest\.conf is writable by group or others/],
    'the pf profile is a symlink': [{ FAKE_BAD_PATH: path.join(GUEST, 'pf', 'soak-deny.conf'), FAKE_BAD_META: '501 755 Symbolic Link' }, /soak-deny\.conf is a 'Symbolic Link'/],
    'scripts/soak.js is owned by another user': [{ FAKE_BAD_PATH: path.join(REPO, 'scripts', 'soak.js'), FAKE_BAD_META: '777 644 Regular File' }, /soak\.js is owned by uid 777/],
    'a lib/soak module is world-writable': [{ FAKE_BAD_PATH: path.join(REPO, 'lib', 'soak', 'repos.js'), FAKE_BAD_META: '501 646 Regular File' }, /repos\.js is writable by group or others/],
    'the stub engine is owned by another user': [{ FAKE_BAD_PATH: path.join(REPO, 'deploy', 'soak', 'stub-engine', 'soak-stub.js'), FAKE_BAD_META: '502 755 Regular File' }, /soak-stub\.js is owned by uid 502/],
    'an ancestor of the checkout is owned by another user': [{ FAKE_BAD_PATH: path.dirname(REPO), FAKE_BAD_META: '777 755 Directory' }, /is owned by uid 777/],
    'an ancestor is world-writable without the sticky bit': [{ FAKE_BAD_PATH: path.dirname(REPO), FAKE_BAD_META: '0 777 Directory' }, /writable by group or others \(mode 777\)/],
    'stat cannot be read': [{ FAKE_BAD_PATH: path.join(GUEST, 'guest.conf'), FAKE_BAD_META: 'garbage' }, /cannot read the owner and mode/],
    'the workload can write a trusted file': [{ FAKE_WRITABLE: path.join(GUEST, 'guest.conf') }, /soakrun can write .*guest\.conf/],
    'the workload can write a closed ancestor': [{ FAKE_WRITABLE: path.join(REPO, 'deploy', 'soak') }, /soakrun can write .*deploy\/soak/],
    'sudo -u fails its positive control': [{ FAKE_SUDO_U_BROKEN: '1' }, /sudo -u failed its positive control/]
  };
  for (const [label, [env, reason]] of Object.entries(refusals)) {
    it(`--verify-admin refuses (ok:false) when ${label}`, () => {
      const f = guestFakes(tmp);
      const r = setup(['--verify-admin'], f, tmp, env);
      assert.equal(r.status, 3, `${label}: ${r.stderr}`);
      assert.equal(r.json.length, 1);
      assert.equal(r.json[0].ok, false);
      assert.match(r.json[0].reason, reason);
    });
  }

  it('refuses even a root-owned sticky ancestor such as /Users/Shared (A73: no exception)', () => {
    const f = guestFakes(tmp);
    const r = setup(['--verify-admin'], f, tmp, { FAKE_BAD_PATH: path.dirname(REPO), FAKE_BAD_META: '0 1777 Directory' });
    assert.equal(r.status, 3);
    assert.match(r.json[0].reason, /writable by group or others \(mode 1777\)/);
  });

  it('checks the checkout in workload mode too, before guest.conf is read', () => {
    const f = guestFakes(tmp);
    const r = setup(['--verify-workload'], f, tmp, { FAKE_USER: 'soakrun', FAKE_BAD_PATH: path.join(GUEST, 'guest.conf'), FAKE_BAD_META: '501 666 Regular File' });
    assert.equal(r.status, 3);
    assert.match(r.json[0].reason, /guest\.conf is writable by group or others/);
  });

  it('refuses a checkout the workload user owns, in workload mode', () => {
    const f = guestFakes(tmp);
    const r = setup(['--verify-workload'], f, tmp, { FAKE_USER: 'soakrun', FAKE_BAD_PATH: REPO, FAKE_BAD_META: '502' });
    assert.equal(r.status, 3);
    assert.match(r.json[0].reason, /which must not own the checkout/);
  });

  it('refuses when the admin cannot run sudo right now (A4 control 1)', () => {
    const f = guestFakes(tmp, { sudo: '[ "$1" = "-n" ] && shift\nif [ "$1" = "-l" ]; then [ "$3" = admin ] && exit 0; exit 1; fi\n[ "$1" = true ] && exit 1\n[ "${FAKE_USER:-admin}" = admin ] || exit 1\nexec "$@"' });
    const r = setup(['--verify-admin'], f, tmp);
    assert.equal(r.status, 3);
    assert.match(r.json[0].reason, /non-interactive sudo|does not run for admin/);
  });

  it('treats a workload sudo -l exit other than 1 as unknown, not denial (A4)', () => {
    const f = guestFakes(tmp, { sudo: '[ "$1" = "-n" ] && shift\nif [ "$1" = "-l" ]; then [ "$3" = admin ] && exit 0; exit 2; fi\n[ "${FAKE_USER:-admin}" = admin ] || exit 1\nexec "$@"' });
    const r = setup(['--verify-admin'], f, tmp);
    assert.equal(r.status, 3);
    assert.match(r.json[0].reason, /sudo -l for soakrun exited 2/);
  });

  it('refuses before guest.conf is read, in setup too, and never loads pf', () => {
    const f = guestFakes(tmp);
    const r = setup([], f, tmp, { FAKE_BAD_PATH: path.join(GUEST, 'guest.conf'), FAKE_BAD_META: '501 666 Regular File' });
    assert.equal(r.status, 3);
    assert.ok(!f.calls().some((c) => /\] (sudo|pfctl|sysadminctl|ipconfig) /.test(c)), f.calls().join('\n'));
  });

  it('refuses a checkout reached through a symlinked path', () => {
    const f = guestFakes(tmp);
    const link = path.join(tmp, 'link-to-repo');
    fs.symlinkSync(REPO, link);
    const r = runScript(path.join(link, 'deploy', 'soak', 'guest', 'guest-setup.sh'), ['--verify-admin'], f.bin, { HOME: tmp, SOAK_PROBE_TIMEOUT: '2', SOAK_DHCP_SERVER: '192.168.64.2' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /reached through a symlink/);
  });

  it('setup refuses when the workload can write the checkout, before loading pf', () => {
    const f = guestFakes(tmp);
    const r = setup([], f, tmp, { FAKE_WRITABLE: path.join(GUEST, 'guest-setup.sh') });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /soakrun can write/);
    assert.ok(!f.calls().some((c) => /pfctl -D/.test(c)));
  });

  it('setup prints the admin verifier\'s ok:false line when it fails (A1)', () => {
    const f = guestFakes(tmp, { pfctl: 'case "$*" in "-s info") echo "Status: Disabled";; esac' });
    const r = setup([], f, tmp);
    assert.equal(r.status, 3);
    const admin = r.json.find((j) => j.mode === 'admin');
    assert.ok(admin, r.stdout);
    assert.equal(admin.ok, false);
    assert.match(admin.reason, /pf is not enabled/);
  });

  it('refuses when sudo -l cannot confirm the admin\'s own rights (A4 positive control)', () => {
    const f = guestFakes(tmp, { sudo: '[ "$1" = "-v" ] && exit 0\n[ "$1" = "-n" ] && shift\nif [ "$1" = "-l" ]; then exit 1; fi\n[ "${FAKE_USER:-admin}" = admin ] || exit 1\nexec "$@"' });
    const r = setup(['--verify-admin'], f, tmp);
    assert.equal(r.status, 3);
    assert.match(r.json[0].reason, /does not confirm admin's own rights/);
  });
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
    assert.deepEqual(j.refused, { sudo: true, pfctl: true });
    assert.deepEqual(Object.keys(j.artifact), ['scriptSha256', 'profileSha256', 'guestConfSha256']);
    assert.deepEqual(j.probes, { tcp4: '1.1.1.1', tcp6: '2606:4700:4700::1111', udpDns: '1.1.1.1' });
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
    'it runs as the admin instead': [{}, { FAKE_USER: 'admin' }, /must run as soakrun|run it as the workload user/],
    'the workload is in the admin group': [{ id: 'case "$*" in -un) echo soakrun;; -u) echo 502;; -Gn) echo "staff admin";; esac' }, {}, /in the admin group/],
    'the workload has uid 500, below the regular-account floor': [{ id: 'case "$*" in -un) echo soakrun;; -u) echo 500;; -Gn) echo staff;; esac' }, {}, /system or root uid/],
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
    // No node here: a refusal this early prints the fixed fallback line.
    f = fakes(tmp, { sudo: '', pfctl: '', sysctl: '0', uname: 'Darwin', curl: '' });
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
