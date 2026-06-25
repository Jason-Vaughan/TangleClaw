'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const PLIST_PATH = path.join(__dirname, '..', 'deploy', 'com.tangleclaw.ttyd.plist');

/** Extract the ordered ProgramArguments <string> values from the plist. */
function programArguments(plistStr) {
  const start = plistStr.indexOf('<key>ProgramArguments</key>');
  const arrStart = plistStr.indexOf('<array>', start);
  const arrEnd = plistStr.indexOf('</array>', arrStart);
  const block = plistStr.slice(arrStart, arrEnd);
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]);
}

describe('deploy/com.tangleclaw.ttyd.plist', () => {
  const plist = fs.readFileSync(PLIST_PATH, 'utf8');

  it('should be the ttyd launchd job', () => {
    assert.match(plist, /<string>com\.tangleclaw\.ttyd<\/string>/, 'Label must identify the ttyd job');
  });

  // AUTH-1 (#395): the bind args are now a mode-specific placeholder, filled by
  // install.sh (direct → `--port 3100`) or scripts/ingress-cutover.js (caddy →
  // `--interface <socket>`). The "default install listens on port 3100" contract
  // is preserved — it now lives in install.sh's substitution, asserted here.
  it('should template the ttyd bind args for per-ingress-mode injection', () => {
    assert.match(plist, /<string>__TTYD_BIND_KEY__<\/string>/, 'bind key must be templated');
    assert.match(plist, /<string>__TTYD_BIND_VAL__<\/string>/, 'bind value must be templated');
  });

  it('should make install.sh bind ttyd to port 3100 for the default direct install', () => {
    const installSh = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'install.sh'), 'utf8');
    assert.match(installSh, /s\|__TTYD_BIND_KEY__\|--port\|g/, 'install.sh must fill the bind key with --port');
    assert.match(installSh, /s\|__TTYD_BIND_VAL__\|3100\|g/, 'install.sh must fill the bind value with 3100');
  });

  it('should point at the in-repo ttyd-attach.sh', () => {
    assert.match(plist, /__REPO_DIR__\/deploy\/ttyd-attach\.sh/, 'must launch the attach script');
  });

  // #397 bug 2 + durability fix: the launchd PROGRAM must be a non-TCC system
  // binary. A repo-resident wrapper script (the original bug-2 fix) is
  // un-launchable — exit 126 — when the repo sits under ~/Documents (the
  // documented default) and the launchd job lacks Full Disk Access. So /bin/bash
  // runs the self-heal inline from argv and execs the ttyd binary; both are
  // non-TCC. This test is the regression guard against re-introducing a
  // repo-resident launchd program.
  it('should run the launchd program from /bin/bash, never a repo-resident script', () => {
    const pa = programArguments(plist);
    assert.equal(pa[0], '/bin/bash', 'the launchd program (ProgramArguments[0]) must be /bin/bash');
    assert.equal(pa[1], '-c', 'must pass the inline launcher via bash -c');
    assert.doesNotMatch(pa[0], /\/deploy\//, 'the launchd program must NOT be a script under the repo (TCC exit-126 guard)');
    assert.ok(!plist.includes('ttyd-launch.sh'), 'the removed wrapper must not be referenced');
  });

  it('should exec the ttyd binary after the inline launcher', () => {
    const pa = programArguments(plist);
    const cmdIdx = 2; // pa[2] is the bash -c command; pa[3] is $0; pa[4] is the ttyd binary
    assert.match(pa[cmdIdx], /exec "\$@"/, 'inline command must exec the forwarded args');
    assert.equal(pa[4], '__TTYD_PATH__', 'the ttyd binary placeholder must be the first exec arg');
  });

  // Behavioral coverage (folded in from the deleted deploy/ttyd-launch.sh test):
  // run the actual inline command and observe the unlink + pass-through exec.
  it('the inline launcher unlinks a stale socket then execs (caddy mode)', () => {
    const cmd = programArguments(plist)[2];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ttyd-inline-'));
    try {
      const sock = path.join(tmpDir, 'ttyd.sock');
      fs.writeFileSync(sock, ''); // leftover socket inode
      const out = execFileSync('bash', ['-c', cmd, 'ttyd-launch', '/bin/echo', 'started'], {
        encoding: 'utf8', env: { ...process.env, TTYD_SOCKET: sock }
      }).trim();
      assert.equal(out, 'started', 'must exec the forwarded command');
      assert.ok(!fs.existsSync(sock), 'must unlink the stale socket before exec');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('the inline launcher is a no-op on the socket in direct mode (TTYD_SOCKET empty)', () => {
    const cmd = programArguments(plist)[2];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ttyd-inline-'));
    try {
      const sentinel = path.join(tmpDir, 'keep.me');
      fs.writeFileSync(sentinel, 'x');
      execFileSync('bash', ['-c', cmd, 'ttyd-launch', '/bin/echo', 'ok'], {
        encoding: 'utf8', env: { ...process.env, TTYD_SOCKET: '' }
      });
      assert.ok(fs.existsSync(sentinel), 'must not touch anything when no socket is configured');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should template TTYD_SOCKET for the inline launcher to unlink (filled per ingress mode)', () => {
    assert.match(plist, /<key>TTYD_SOCKET<\/key>/, 'TTYD_SOCKET env key must be present');
    assert.match(plist, /<string>__TTYD_SOCKET__<\/string>/, 'TTYD_SOCKET value must be templated');
  });

  it('should make install.sh leave TTYD_SOCKET empty for the default direct install', () => {
    const installSh = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'install.sh'), 'utf8');
    assert.match(installSh, /s\|__TTYD_SOCKET__\|\|g/, 'install.sh must fill TTYD_SOCKET with an empty string');
  });

  // #322/#290 — ttyd's xterm.js scrollback defaults to 1000 lines. We raise it
  // so long output is reachable in a live session AND so the buffer is large
  // enough to hold the history ttyd-attach.sh replays on reconnect/restart.
  it('should raise the xterm scrollback buffer above the 1000-line default', () => {
    assert.match(
      plist,
      /<string>--client-option<\/string>/,
      'must pass a ttyd --client-option to configure xterm.js'
    );
    const m = plist.match(/<string>scrollback=(\d+)<\/string>/);
    assert.ok(m, 'must set the xterm scrollback client option');
    assert.ok(
      Number(m[1]) >= 10000,
      `scrollback should be at least 10000 (got ${m && m[1]}) so the attach replay isn't truncated`
    );
  });

  it('should keep the scrollback buffer >= the attach script replay window', () => {
    const attach = fs.readFileSync(
      path.join(__dirname, '..', 'deploy', 'ttyd-attach.sh'),
      'utf8'
    );
    const replay = attach.match(/capture-pane[^\n]*-S\s+-(\d+)/);
    const buffer = plist.match(/scrollback=(\d+)/);
    assert.ok(replay, 'attach script should bound its replay with -S -N');
    assert.ok(buffer, 'plist should set scrollback=N');
    assert.ok(
      Number(buffer[1]) >= Number(replay[1]),
      `xterm scrollback (${buffer[1]}) must hold the full replay window (${replay[1]}) or the top is silently dropped`
    );
  });
});
