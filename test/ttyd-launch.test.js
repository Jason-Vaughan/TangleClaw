'use strict';

// #397 bug 2 — the ttyd launch wrapper unlinks a stale Unix socket before
// exec'ing ttyd. Exercised by running the real shell script with a harmless
// command (/bin/echo) standing in for ttyd, so we observe both the unlink and
// the pass-through exec without binding a real socket.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const WRAPPER = path.join(__dirname, '..', 'deploy', 'ttyd-launch.sh');

/** Run the wrapper with the given env + args; return trimmed stdout. */
function runWrapper(env, args) {
  return execFileSync('bash', [WRAPPER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  }).toString().trim();
}

describe('deploy/ttyd-launch.sh', () => {
  let tmpDir;
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ttyd-launch-')); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('execs the passed command, forwarding all args', () => {
    const out = runWrapper({ TTYD_SOCKET: '' }, ['/bin/echo', 'hello', 'world']);
    assert.equal(out, 'hello world');
  });

  it('unlinks a stale socket file when TTYD_SOCKET is set, before exec', () => {
    const sock = path.join(tmpDir, 'ttyd.sock');
    fs.writeFileSync(sock, ''); // simulate a leftover socket inode
    assert.ok(fs.existsSync(sock));
    runWrapper({ TTYD_SOCKET: sock }, ['/bin/echo', 'ok']);
    assert.ok(!fs.existsSync(sock), 'wrapper must remove the stale socket before binding');
  });

  it('is a no-op on the socket when TTYD_SOCKET is empty (direct mode)', () => {
    const sentinel = path.join(tmpDir, 'keep.me');
    fs.writeFileSync(sentinel, 'x');
    runWrapper({ TTYD_SOCKET: '' }, ['/bin/echo', 'ok']);
    assert.ok(fs.existsSync(sentinel), 'must not touch anything when no socket is configured');
  });

  it('does not fail when the configured socket does not exist yet', () => {
    const sock = path.join(tmpDir, 'absent.sock');
    const out = runWrapper({ TTYD_SOCKET: sock }, ['/bin/echo', 'fresh']);
    assert.equal(out, 'fresh');
  });
});
