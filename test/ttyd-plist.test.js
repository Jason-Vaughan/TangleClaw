'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLIST_PATH = path.join(__dirname, '..', 'deploy', 'com.tangleclaw.ttyd.plist');

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
