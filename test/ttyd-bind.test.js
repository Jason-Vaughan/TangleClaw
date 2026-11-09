'use strict';

/*
 * #710 — bringing an already-installed ttyd launchd job into line.
 *
 * install.sh writes the ttyd plist once; a TangleClaw update is a `git checkout`
 * and never rewrites launchd jobs. So every machine installed before ttyd was
 * pinned keeps a `--writable` terminal listening on every interface, and the
 * release notes would be lying about it.
 *
 * The decision is tested exhaustively here, separately from the apply, because
 * it runs unattended on a remote operator's machine and a ttyd job that fails to
 * start takes every terminal with it. The bias throughout is: recognize our own
 * job or refuse; edit the smallest possible thing; treat "not sure" as "don't".
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ttydBind = require('../lib/ttyd-bind');
const { desiredBind, parseProgramArguments, describeInstalledBind, planReconcile,
        reconcileInstalledJob, parseExecStartArgs, planReconcileSystemd,
        TTYD_SYSTEMD_UNIT } = ttydBind;

/** A plist in the shape install.sh produced BEFORE #710: port only, no interface. */
function legacyPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tangleclaw.ttyd</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>exec "$@"</string>
        <string>ttyd-launch</string>
        <string>/opt/homebrew/bin/ttyd</string>
        <string>--writable</string>
        <string>--url-arg</string>
        <string>--port</string>
        <string>3100</string>
        <string>--client-option</string>
        <string>scrollback=10000</string>
        <string>/Users/x/.tangleclaw/deploy/ttyd-attach.sh</string>
    </array>
</dict>
</plist>`;
}

/** The post-#710 shape: an explicit interface ahead of the port. */
function pinnedPlist(iface = '127.0.0.1') {
  return legacyPlist().replace(
    '        <string>--port</string>',
    `        <string>--interface</string>\n        <string>${iface}</string>\n        <string>--port</string>`
  );
}

/** The Linux (systemd) analogue of {@link legacyPlist} (#2933): port only, no interface. */
function legacyUnit() {
  return `[Unit]
Description=TangleClaw ttyd terminal
After=network.target

[Service]
ExecStart=/usr/bin/ttyd --writable --url-arg --port 3100 --client-option scrollback=10000 /home/x/.tangleclaw/deploy/ttyd-attach.sh
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** The Linux analogue of {@link pinnedPlist}: an explicit interface ahead of the port. */
function pinnedUnit(iface = '127.0.0.1') {
  return legacyUnit().replace(' --port', ` --interface ${iface} --port`);
}

describe('ttyd-bind.desiredBind', () => {
  it('wants loopback for a direct-mode install', () => {
    const d = desiredBind({ ingressMode: 'direct' });
    assert.equal(d.manage, true);
    assert.equal(d.iface, '127.0.0.1');
  });

  it('stays on loopback EVEN WHEN the operator opted the dashboard wide', () => {
    // The opt-in is about reaching the dashboard remotely. Nothing addresses
    // ttyd directly, so following it here would publish a --writable shell for
    // no gain — and would silently re-open this port on the next restart for
    // anyone who ever set the flag.
    assert.equal(desiredBind({ ingressMode: 'direct', bindAllInterfaces: true }).iface, '127.0.0.1');
  });

  it('declines to manage a caddy install, whose socket the cutover owns', () => {
    const d = desiredBind({ ingressMode: 'caddy' });
    assert.equal(d.manage, false, 'a unix socket is already unreachable over the network');
  });

  it('is unaffected by the dashboard setting in any form', () => {
    for (const value of [true, false, null, undefined, 'true', 1, {}]) {
      assert.equal(desiredBind({ ingressMode: 'direct', bindAllInterfaces: value }).iface, '127.0.0.1',
        `ttyd must stay pinned regardless of bindAllInterfaces=${JSON.stringify(value)}`);
    }
  });
});

describe('ttyd-bind.describeInstalledBind', () => {
  it('reads a port-only job as WIDE — that is ttyd\'s default, and the whole bug', () => {
    const { args } = parseProgramArguments(legacyPlist());
    const d = describeInstalledBind(args);
    assert.equal(d.iface, null);
    assert.equal(d.port, '3100');
    assert.equal(d.wide, true, 'no --interface means every interface');
  });

  it('reads an explicit 0.0.0.0 as wide too', () => {
    const { args } = parseProgramArguments(pinnedPlist('0.0.0.0'));
    assert.equal(describeInstalledBind(args).wide, true);
  });

  it('reads a pinned job as not wide', () => {
    const { args } = parseProgramArguments(pinnedPlist());
    const d = describeInstalledBind(args);
    assert.equal(d.iface, '127.0.0.1');
    assert.equal(d.wide, false);
  });

  it('reads a job hand-bound to a LAN address as WIDE — it is reachable from the whole network (#1056)', () => {
    // The list form ("0.0.0.0 or no --interface") said not-wide here, so the
    // exposure notice that reads this field stayed silent on an exposed job.
    for (const iface of ['192.168.1.5', '10.0.0.7', 'en0', '[::]', '0.0.0.0']) {
      const { args } = parseProgramArguments(pinnedPlist(iface));
      assert.equal(describeInstalledBind(args).wide, true, `${iface} is reachable from off the box`);
    }
  });

  it('reads every spelling of loopback, and a unix socket, as not wide', () => {
    for (const iface of ['127.0.0.1', '127.0.0.2', '::1', 'localhost', 'lo0', 'lo', '/var/run/ttyd.sock']) {
      const { args } = parseProgramArguments(pinnedPlist(iface));
      assert.equal(describeInstalledBind(args).wide, false, `${iface} is local-only`);
    }
  });

  it('a plan for a LAN-bound job reports it still wide until the rewrite lands', () => {
    const plan = planReconcile(pinnedPlist('192.168.1.5'), { ingressMode: 'direct' });
    assert.equal(plan.action, 'rewrite', 'a LAN pin is re-pinned to loopback like any other widened job');
    assert.equal(plan.stillWide, true, 'and the operator is told the job is exposed as it stands');
  });
});

describe('ttyd-bind.planReconcile', () => {
  it('rewrites a legacy port-only job to loopback', () => {
    const plan = planReconcile(legacyPlist(), { ingressMode: 'direct' });
    assert.equal(plan.action, 'rewrite');
    assert.equal(plan.to, '127.0.0.1');
    const { args } = parseProgramArguments(plan.xml);
    assert.deepEqual(
      args.slice(args.indexOf('--url-arg') + 1, args.indexOf('--client-option')),
      ['--interface', '127.0.0.1', '--port', '3100'],
      'the interface is inserted ahead of the port and nothing else moves'
    );
  });

  it('changes nothing else in the file', () => {
    const before = legacyPlist();
    const plan = planReconcile(before, { ingressMode: 'direct' });
    // Everything except the two inserted lines must survive byte-for-byte.
    const stripped = plan.xml
      .replace('        <string>--interface</string>\n', '')
      .replace('        <string>127.0.0.1</string>\n', '');
    assert.equal(stripped, before, 'the edit must be surgical, not a regeneration');
  });

  it('is a no-op once the job is already correct', () => {
    const plan = planReconcile(pinnedPlist(), { ingressMode: 'direct' });
    assert.equal(plan.action, 'none');
    assert.equal(plan.reason, 'already-correct');
  });

  it('re-pins a job someone widened, rather than honouring it', () => {
    // The regression this guards: a config that says bindAllInterfaces:true must
    // NOT drag the terminal port open with it on the next restart.
    const plan = planReconcile(pinnedPlist('0.0.0.0'), { ingressMode: 'direct', bindAllInterfaces: true });
    assert.equal(plan.action, 'rewrite');
    assert.equal(plan.to, '127.0.0.1');
    assert.equal(describeInstalledBind(parseProgramArguments(plan.xml).args).iface, '127.0.0.1');
  });

  it('leaves a caddy install alone entirely', () => {
    const plan = planReconcile(legacyPlist(), { ingressMode: 'caddy' });
    assert.equal(plan.action, 'none');
  });

  it('REFUSES a job it does not recognize as ours', () => {
    // Somebody else's ttyd, or a hand-rolled one. Rewriting it blind is how a
    // remote operator loses their terminal to a change they never asked for.
    const foreign = legacyPlist().replace('<string>--writable</string>', '<string>--readonly</string>');
    const plan = planReconcile(foreign, { ingressMode: 'direct' });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.reason, /unrecognized-job/);
  });

  it('REFUSES a socket-bound job even when config claims direct mode', () => {
    // Config and reality disagree; the cutover owns that. Converting a socket
    // job to TCP here would EXPOSE something currently unreachable.
    const plan = planReconcile(pinnedPlist('/Users/x/.tangleclaw/run/ttyd.sock'), { ingressMode: 'direct' });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.reason, /socket-bound/);
  });

  it('REFUSES an unparseable plist rather than guessing', () => {
    for (const junk of ['', 'not a plist', '<plist><dict></dict></plist>']) {
      assert.equal(planReconcile(junk, { ingressMode: 'direct' }).action, 'refuse');
    }
  });

  it('never returns a rewrite without the rewritten document', () => {
    // A caller that trusted `action` alone and wrote `plan.xml` would truncate
    // the operator's plist to nothing.
    for (const xml of [legacyPlist(), pinnedPlist(), 'junk', '']) {
      for (const cfg of [{ ingressMode: 'direct' }, { ingressMode: 'caddy' }]) {
        const plan = planReconcile(xml, cfg);
        if (plan.action === 'rewrite') {
          assert.ok(typeof plan.xml === 'string' && plan.xml.length > 0);
        } else {
          assert.equal(plan.xml, null);
        }
      }
    }
  });
});

describe('ttyd-bind.planReconcileSystemd (#2933)', () => {
  it('rewrites a legacy port-only job to loopback', () => {
    const plan = planReconcileSystemd(legacyUnit(), { ingressMode: 'direct' });
    assert.equal(plan.action, 'rewrite');
    assert.equal(plan.to, '127.0.0.1');
    const { args } = parseExecStartArgs(plan.unitText);
    assert.deepEqual(
      args.slice(args.indexOf('--url-arg') + 1, args.indexOf('--client-option')),
      ['--interface', '127.0.0.1', '--port', '3100'],
      'the interface is inserted ahead of the port and nothing else moves'
    );
  });

  it('changes nothing else in the file', () => {
    const before = legacyUnit();
    const plan = planReconcileSystemd(before, { ingressMode: 'direct' });
    const stripped = plan.unitText.replace('--interface 127.0.0.1 --port', '--port');
    assert.equal(stripped, before, 'the edit must be surgical, not a regeneration');
  });

  it('is a no-op once the job is already correct', () => {
    const plan = planReconcileSystemd(pinnedUnit(), { ingressMode: 'direct' });
    assert.equal(plan.action, 'none');
    assert.equal(plan.reason, 'already-correct');
  });

  it('re-pins a job someone widened, rather than honouring it', () => {
    // Same regression this guards on Linux: bindAllInterfaces:true must not
    // drag the terminal port open with it on the next restart either.
    const plan = planReconcileSystemd(pinnedUnit('0.0.0.0'), { ingressMode: 'direct', bindAllInterfaces: true });
    assert.equal(plan.action, 'rewrite');
    assert.equal(plan.to, '127.0.0.1');
    assert.equal(describeInstalledBind(parseExecStartArgs(plan.unitText).args).iface, '127.0.0.1');
  });

  it('leaves a caddy install alone entirely', () => {
    const plan = planReconcileSystemd(legacyUnit(), { ingressMode: 'caddy' });
    assert.equal(plan.action, 'none');
  });

  it('REFUSES a job it does not recognize as ours', () => {
    const foreign = legacyUnit().replace('--writable', '--readonly');
    const plan = planReconcileSystemd(foreign, { ingressMode: 'direct' });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.reason, /unrecognized-job/);
  });

  it('REFUSES a socket-bound job even when config claims direct mode', () => {
    const plan = planReconcileSystemd(pinnedUnit('/home/x/.tangleclaw/run/ttyd.sock'), { ingressMode: 'direct' });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.reason, /socket-bound/);
  });

  it('REFUSES an unparseable unit rather than guessing', () => {
    for (const junk of ['', 'not a unit file', '[Service]\nExecStop=true\n']) {
      assert.equal(planReconcileSystemd(junk, { ingressMode: 'direct' }).action, 'refuse');
    }
  });

  it('never returns a rewrite without the rewritten document', () => {
    // A caller that trusted `action` alone and wrote `plan.unitText` would
    // truncate the operator's unit file to nothing.
    for (const unitText of [legacyUnit(), pinnedUnit(), 'junk', '']) {
      for (const cfg of [{ ingressMode: 'direct' }, { ingressMode: 'caddy' }]) {
        const plan = planReconcileSystemd(unitText, cfg);
        if (plan.action === 'rewrite') {
          assert.ok(typeof plan.unitText === 'string' && plan.unitText.length > 0);
        } else {
          assert.equal(plan.unitText, null);
        }
      }
    }
  });
});

describe('reconcileInstalledJob.stillWide — what server.js actually reads', () => {
  const HOME = '/home/x';
  const PLIST = '/home/x/Library/LaunchAgents/com.tangleclaw.ttyd.plist';

  function harness({ initial = legacyPlist(), lintFails = false, listening = true } = {}) {
    const files = { [PLIST]: initial };
    return {
      files,
      deps: {
        fs: {
          existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
          readFileSync: (p) => files[p],
          writeFileSync: (p, c) => { files[p] = c; },
          copyFileSync: (a, b) => { files[b] = files[a]; },
          renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
          rmSync: (p) => { delete files[p]; }
        },
        path: { join: (...parts) => parts.join('/') },
        execFileSync: (cmd) => { if (cmd === 'plutil' && lintFails) throw new Error('malformed'); },
        uid: 501,
        log: { info() {}, warn() {}, error() {} },
        probe: () => listening
      }
    };
  }

  // Pinned to darwin (#2933): this suite's harness/fixtures are launchd-shaped
  // (a plist, `uid`, `plutil`/`launchctl` stubs), and the default platform param
  // must not silently drift to whatever OS actually runs the test.
  const run = (opts, config = { ingressMode: 'direct' }) =>
    reconcileInstalledJob({ home: HOME, config, deps: harness(opts).deps, platform: 'darwin' });

  it('reports STILL WIDE when staging fails and the live job was never touched', () => {
    // The regression that prompted this: a plan carrying the post-apply state
    // made this report `false`, so an operator with a read-only LaunchAgents
    // directory kept an unauthenticated shell and got no dashboard chip.
    const r = run({ lintFails: true });
    assert.equal(r.action, 'refuse');
    assert.equal(r.stillWide, true, 'the wide job is still installed');
  });

  it('reports not-wide after a successful pin', () => {
    const r = run({});
    assert.equal(r.action, 'rewrite');
    assert.equal(r.stillWide, false);
  });

  it('reports not-wide when the job was already correct', () => {
    assert.equal(run({ initial: pinnedPlist() }).stillWide, false);
  });

  it('reports not-wide for an unrecognized job that is nonetheless pinned', () => {
    const foreign = pinnedPlist().replace('<string>--writable</string>', '<string>--readonly</string>');
    const r = run({ initial: foreign });
    assert.equal(r.action, 'refuse');
    assert.equal(r.stillWide, false, 'not ours, but not exposed either — do not cry wolf');
  });

  it('always returns a boolean, on every path server.js can reach', () => {
    for (const opts of [{}, { lintFails: true }, { listening: false }, { initial: pinnedPlist() }]) {
      assert.equal(typeof run(opts).stillWide, 'boolean');
    }
    assert.equal(typeof run({}, { ingressMode: 'caddy' }).stillWide, 'boolean');
  });
});

describe('ttyd-bind.reconcileInstalledJob — the apply must be reversible', () => {
  const HOME = '/home/x';
  const PLIST = '/home/x/Library/LaunchAgents/com.tangleclaw.ttyd.plist';

  /** Minimal injected environment with an in-memory filesystem. */
  function harness({ initial = legacyPlist(), lintFails = false, bootstrapFails = false, listening = true } = {}) {
    const files = { [PLIST]: initial };
    const calls = [];
    const deps = {
      fs: {
        existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
        readFileSync: (p) => files[p],
        writeFileSync: (p, c) => { files[p] = c; calls.push(`write:${p}`); },
        copyFileSync: (a, b) => { files[b] = files[a]; calls.push(`copy:${a}->${b}`); },
        renameSync: (a, b) => { files[b] = files[a]; delete files[a]; calls.push(`rename:${a}->${b}`); },
        rmSync: (p) => { delete files[p]; }
      },
      path: { join: (...parts) => parts.join('/') },
      execFileSync: (cmd, args) => {
        calls.push(`${cmd} ${args[0]}`);
        if (cmd === 'plutil' && lintFails) throw new Error('malformed');
        if (cmd === 'launchctl' && args[0] === 'bootstrap' && bootstrapFails) throw new Error('bootstrap refused');
      },
      uid: 501,
      log: { info() {}, warn() {}, error() {} },
      probe: () => listening
    };
    return { files, calls, deps };
  }

  it('backs up and lint-validates BEFORE the live plist is replaced', () => {
    const h = harness();
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'darwin' });
    assert.equal(r.action, 'rewrite');
    const copyAt = h.calls.findIndex((c) => c.startsWith('copy:'));
    const lintAt = h.calls.findIndex((c) => c === 'plutil -lint');
    const swapAt = h.calls.findIndex((c) => c.startsWith('rename:'));
    assert.ok(copyAt > -1 && copyAt < swapAt, 'a backup must exist before the swap');
    assert.ok(lintAt > -1 && lintAt < swapAt, 'validity must be proven before the swap');
    assert.equal(describeInstalledBind(parseProgramArguments(h.files[PLIST]).args).iface, '127.0.0.1');
  });

  it('never touches the live job when the candidate fails lint', () => {
    const h = harness({ lintFails: true });
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'darwin' });
    assert.equal(r.action, 'refuse');
    assert.equal(h.files[PLIST], legacyPlist(), 'the installed plist must be byte-identical');
    assert.ok(!h.calls.some((c) => c.startsWith('launchctl bootstrap')), 'nothing should have been reloaded');
  });

  it('rolls back when ttyd does not come back listening', () => {
    // The failure that matters: the plist is valid, launchd accepts it, and ttyd
    // still does not start. Without the probe this looks like success and the
    // operator finds a dead terminal later, with no idea why.
    const h = harness({ listening: false });
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'darwin' });
    assert.equal(r.action, 'refuse');
    assert.equal(r.rolledBack, true);
    assert.equal(h.files[PLIST], legacyPlist(), 'the operator keeps the job that worked');
  });

  it('rolls back when launchd refuses the new job', () => {
    const h = harness({ bootstrapFails: true });
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'darwin' });
    assert.equal(r.rolledBack, true);
    assert.equal(h.files[PLIST], legacyPlist());
  });

  it('does nothing at all when there is no installed plist', () => {
    const h = harness();
    delete h.files[PLIST];
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'darwin' });
    assert.equal(r.action, 'none');
    assert.equal(h.calls.length, 0, 'a machine without the job must not be poked');
  });

  it('does not reload anything when the job is already correct', () => {
    const h = harness({ initial: pinnedPlist() });
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'darwin' });
    assert.equal(r.action, 'none');
    assert.ok(!h.calls.some((c) => c.startsWith('launchctl')), 'an idempotent boot must not restart terminals');
  });
});

describe('reconcileInstalledJob.stillWide on linux — what server.js actually reads (#2933)', () => {
  const HOME = '/home/x';
  const UNIT = '/home/x/.config/systemd/user/tangleclaw-ttyd.service';

  function harness({ initial = legacyUnit(), verifyFails = false, listening = true } = {}) {
    const files = { [UNIT]: initial };
    return {
      files,
      deps: {
        fs: {
          existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
          readFileSync: (p) => files[p],
          writeFileSync: (p, c) => { files[p] = c; },
          copyFileSync: (a, b) => { files[b] = files[a]; },
          renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
          rmSync: (p) => { delete files[p]; }
        },
        path: { join: (...parts) => parts.join('/') },
        execFileSync: (cmd) => { if (cmd === 'systemd-analyze' && verifyFails) throw new Error('invalid unit'); },
        log: { info() {}, warn() {}, error() {} },
        probe: () => listening
      }
    };
  }

  const run = (opts, config = { ingressMode: 'direct' }) =>
    reconcileInstalledJob({ home: HOME, config, deps: harness(opts).deps, platform: 'linux' });

  it('reports STILL WIDE when staging fails and the live job was never touched', () => {
    const r = run({ verifyFails: true });
    assert.equal(r.action, 'refuse');
    assert.equal(r.stillWide, true, 'the wide job is still installed');
  });

  it('reports not-wide after a successful pin', () => {
    const r = run({});
    assert.equal(r.action, 'rewrite');
    assert.equal(r.stillWide, false);
  });

  it('reports not-wide when the job was already correct', () => {
    assert.equal(run({ initial: pinnedUnit() }).stillWide, false);
  });

  it('reports not-wide for an unrecognized job that is nonetheless pinned', () => {
    const foreign = pinnedUnit().replace('--writable', '--readonly');
    const r = run({ initial: foreign });
    assert.equal(r.action, 'refuse');
    assert.equal(r.stillWide, false, 'not ours, but not exposed either — do not cry wolf');
  });

  it('always returns a boolean, on every path server.js can reach', () => {
    for (const opts of [{}, { verifyFails: true }, { listening: false }, { initial: pinnedUnit() }]) {
      assert.equal(typeof run(opts).stillWide, 'boolean');
    }
    assert.equal(typeof run({}, { ingressMode: 'caddy' }).stillWide, 'boolean');
  });
});

describe('ttyd-bind.reconcileInstalledJob on linux — the apply must be reversible (#2933)', () => {
  const HOME = '/home/x';
  const UNIT = '/home/x/.config/systemd/user/tangleclaw-ttyd.service';

  /** Minimal injected environment with an in-memory filesystem; no `uid` — systemd user units need none. */
  function harness({ initial = legacyUnit(), verifyFails = false, restartFails = false, listening = true } = {}) {
    const files = { [UNIT]: initial };
    const calls = [];
    const deps = {
      fs: {
        existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
        readFileSync: (p) => files[p],
        writeFileSync: (p, c) => { files[p] = c; calls.push(`write:${p}`); },
        copyFileSync: (a, b) => { files[b] = files[a]; calls.push(`copy:${a}->${b}`); },
        renameSync: (a, b) => { files[b] = files[a]; delete files[a]; calls.push(`rename:${a}->${b}`); },
        rmSync: (p) => { delete files[p]; }
      },
      path: { join: (...parts) => parts.join('/') },
      execFileSync: (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'systemd-analyze' && verifyFails) throw new Error('invalid unit');
        if (cmd === 'systemctl' && args[1] === 'restart' && restartFails) throw new Error('restart refused');
      },
      log: { info() {}, warn() {}, error() {} },
      probe: () => listening
    };
    return { files, calls, deps };
  }

  it('backs up and verifies BEFORE the live unit is replaced', () => {
    const h = harness();
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'linux' });
    assert.equal(r.action, 'rewrite');
    const copyAt = h.calls.findIndex((c) => c.startsWith('copy:'));
    const verifyAt = h.calls.findIndex((c) => c.startsWith('systemd-analyze verify'));
    const swapAt = h.calls.findIndex((c) => c.startsWith('rename:'));
    assert.ok(copyAt > -1 && copyAt < swapAt, 'a backup must exist before the swap');
    assert.ok(verifyAt > -1 && verifyAt < swapAt, 'validity must be proven before the swap');
    assert.equal(describeInstalledBind(parseExecStartArgs(h.files[UNIT]).args).iface, '127.0.0.1');
  });

  it('never touches the live job when the candidate fails verify', () => {
    const h = harness({ verifyFails: true });
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'linux' });
    assert.equal(r.action, 'refuse');
    assert.equal(h.files[UNIT], legacyUnit(), 'the installed unit must be byte-identical');
    assert.ok(!h.calls.some((c) => c.startsWith(`systemctl --user restart ${TTYD_SYSTEMD_UNIT}`)),
      'nothing should have been reloaded');
  });

  it('rolls back when ttyd does not come back listening', () => {
    // The failure that matters: the unit is valid, systemd accepts it, and
    // ttyd still does not start. Without the probe this looks like success
    // and the operator finds a dead terminal later, with no idea why.
    const h = harness({ listening: false });
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'linux' });
    assert.equal(r.action, 'refuse');
    assert.equal(r.rolledBack, true);
    assert.equal(h.files[UNIT], legacyUnit(), 'the operator keeps the job that worked');
  });

  it('rolls back when systemd refuses the new job', () => {
    const h = harness({ restartFails: true });
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'linux' });
    assert.equal(r.rolledBack, true);
    assert.equal(h.files[UNIT], legacyUnit());
  });

  it('does nothing at all when there is no installed unit', () => {
    const h = harness();
    delete h.files[UNIT];
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'linux' });
    assert.equal(r.action, 'none');
    assert.equal(h.calls.length, 0, 'a machine without the job must not be poked');
  });

  it('does not reload anything when the job is already correct', () => {
    const h = harness({ initial: pinnedUnit() });
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps: h.deps, platform: 'linux' });
    assert.equal(r.action, 'none');
    assert.ok(!h.calls.some((c) => c.startsWith('systemctl')), 'an idempotent boot must not restart terminals');
  });
});

describe('stillWide — whether a refusal left an open shell behind', () => {
  // This is what decides whether the operator gets a dashboard chip. A refusal
  // is often correct AND harmless (a unix-socket job is unreachable anyway), so
  // "declined" alone cannot drive the warning — only "declined, and the door is
  // open" should. Untested, the whole notice could be deleted invisibly.
  it('is true for a legacy port-only job we refuse to touch', () => {
    const foreign = legacyPlist().replace('<string>--writable</string>', '<string>--readonly</string>');
    const plan = planReconcile(foreign, { ingressMode: 'direct' });
    assert.equal(plan.action, 'refuse');
    assert.equal(plan.stillWide, true, 'unrecognized AND wide — the operator must be told');
  });

  it('is FALSE for a socket-bound job, which is unreachable over the network', () => {
    const plan = planReconcile(pinnedPlist('/Users/x/.tangleclaw/run/ttyd.sock'), { ingressMode: 'direct' });
    assert.equal(plan.action, 'refuse');
    assert.equal(plan.stillWide, false, 'a false alarm here would cry wolf about a closed door');
  });

  it('assumes the worse when the plist cannot be parsed at all', () => {
    const plan = planReconcile('not a plist', { ingressMode: 'direct' });
    assert.equal(plan.stillWide, true, 'unknown must fail toward warning, not toward silence');
  });

  it('describes the job as it STANDS, not as a successful apply would leave it', () => {
    // A rewrite plan's stillWide is read on exactly one path: staging failure,
    // where the live plist was never touched. Reporting the intended post-apply
    // state there tells an operator whose write failed that their door is shut.
    assert.equal(planReconcile(pinnedPlist(), { ingressMode: 'direct' }).stillWide, false,
      'already pinned — genuinely not wide');
    assert.equal(planReconcile(legacyPlist(), { ingressMode: 'direct' }).stillWide, true,
      'a wide job is still wide until the rewrite is actually installed');
  });

  it('is present on EVERY outcome, so the caller can never read undefined', () => {
    const inputs = [legacyPlist(), pinnedPlist(), pinnedPlist('0.0.0.0'), 'junk', ''];
    for (const xml of inputs) {
      for (const cfg of [{ ingressMode: 'direct' }, { ingressMode: 'caddy' }]) {
        assert.equal(typeof planReconcile(xml, cfg).stillWide, 'boolean',
          `stillWide must be a boolean for ${JSON.stringify(cfg)}`);
      }
    }
  });

  it('reports the rolled-back job as still wide', () => {
    // Rollback restores the ORIGINAL job — the wide one. Reporting false here
    // would tell the operator a door was shut immediately after reopening it.
    const h = (function () {
      const P = '/home/x/Library/LaunchAgents/com.tangleclaw.ttyd.plist';
      const files = { [P]: legacyPlist() };
      return {
        deps: {
          fs: {
            existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
            readFileSync: (p) => files[p],
            writeFileSync: (p, c) => { files[p] = c; },
            copyFileSync: (a, b) => { files[b] = files[a]; },
            renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
            rmSync: (p) => { delete files[p]; }
          },
          path: { join: (...parts) => parts.join('/') },
          execFileSync: () => {},
          uid: 501,
          log: { info() {}, warn() {}, error() {} },
          probe: () => false // ttyd never comes back
        }
      };
    })();
    const r = reconcileInstalledJob({ home: '/home/x', config: { ingressMode: 'direct' }, deps: h.deps, platform: 'darwin' });
    assert.equal(r.rolledBack, true);
    assert.equal(r.stillWide, true, 'the restored job is the wide one');
  });
});

describe('planReconcileSystemd against a REAL generateTtydUnitFile unit (Architect Ruling A507-W1C-AGATE-R1)', () => {
  // lib/linux-systemd.js#generateTtydUnitFile (#2931, merged after this file's
  // own fixtures were written) single-quotes EVERY argv token:
  // ExecStart=/bin/bash -c '...' 'ttyd-launch' '/path/to/ttyd' '--writable'
  // '--interface' '0.0.0.0' '--port' '3100' … — a plain whitespace split
  // would see the literal tokens "'--writable'"/"'--interface'", matching
  // neither describeInstalledBind's own checks nor the --writable/--url-arg
  // shape planReconcileSystemd looks for, and refuse every such unit as
  // unrecognized. This drives the REAL generator, not a hand-built fixture,
  // so a regression in either module's own quoting convention fails here
  // first.
  const linuxSystemd = require('../lib/linux-systemd');

  function realUnit(bindVal = '0.0.0.0') {
    return linuxSystemd.generateTtydUnitFile({
      ttydPath: '/usr/bin/ttyd',
      attachScriptPath: '/home/x/.tangleclaw/deploy/ttyd-attach.sh',
      bindVal,
      socketPath: ''
    });
  }

  it('recognizes a real generated unit as ours, not "unrecognized-job"', () => {
    const plan = planReconcileSystemd(realUnit(), { ingressMode: 'direct' });
    assert.notEqual(plan.reason, undefined);
    assert.doesNotMatch(plan.reason, /unrecognized-job/,
      'the quoted --writable/--url-arg tokens must still be recognized once unquoted');
  });

  it('reads the quoted --interface value correctly, wide or not', () => {
    assert.equal(describeInstalledBind(parseExecStartArgs(realUnit('0.0.0.0')).args).wide, true);
    assert.equal(describeInstalledBind(parseExecStartArgs(realUnit('127.0.0.1')).args).wide, false);
  });

  it('rewrites a widened real unit back to loopback, and the result still passes the generator\'s OWN contract check', () => {
    const plan = planReconcileSystemd(realUnit('0.0.0.0'), { ingressMode: 'direct' });
    assert.equal(plan.action, 'rewrite');
    assert.equal(plan.to, '127.0.0.1');
    assert.deepEqual(linuxSystemd.verifyTtydUnitFileContract(plan.unitText), [],
      'a rewrite must never produce a unit the generator\'s own verifier would reject');
    assert.equal(describeInstalledBind(parseExecStartArgs(plan.unitText).args).iface, '127.0.0.1');
  });

  it('is a no-op once a real unit is already pinned to loopback', () => {
    const plan = planReconcileSystemd(realUnit('127.0.0.1'), { ingressMode: 'direct' });
    assert.equal(plan.action, 'none');
    assert.equal(plan.reason, 'already-correct');
  });

  it('still refuses a real unit that is socket-bound while config claims direct mode', () => {
    const plan = planReconcileSystemd(realUnit('/home/x/.tangleclaw/run/ttyd.sock'), { ingressMode: 'direct' });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.reason, /socket-bound/);
  });

  it('round-trips a full reconcileInstalledJob apply against a real unit, reversibly', () => {
    const HOME = '/home/x';
    const UNIT = linuxSystemd.unitFilePath(HOME, TTYD_SYSTEMD_UNIT);
    const files = { [UNIT]: realUnit('0.0.0.0') };
    const calls = [];
    const deps = {
      fs: {
        existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
        readFileSync: (p) => files[p],
        writeFileSync: (p, c) => { files[p] = c; },
        copyFileSync: (a, b) => { files[b] = files[a]; },
        renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
        rmSync: (p) => { delete files[p]; }
      },
      path: { join: (...parts) => parts.join('/') },
      execFileSync: (cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); },
      log: { info() {}, warn() {}, error() {} },
      probe: () => true
    };
    const r = reconcileInstalledJob({ home: HOME, config: { ingressMode: 'direct' }, deps, platform: 'linux' });
    assert.equal(r.action, 'rewrite');
    assert.equal(r.stillWide, false);
    assert.deepEqual(linuxSystemd.verifyTtydUnitFileContract(files[UNIT]), []);
    assert.equal(describeInstalledBind(parseExecStartArgs(files[UNIT]).args).iface, '127.0.0.1');
  });
});
