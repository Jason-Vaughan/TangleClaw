'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLIST_PATH = path.join(__dirname, '..', 'deploy', 'com.tangleclaw.ttyd.plist');

describe('deploy/com.tangleclaw.ttyd.plist', () => {
  const plist = fs.readFileSync(PLIST_PATH, 'utf8');

  it('should be the ttyd launchd job on port 3100', () => {
    assert.match(plist, /<string>com\.tangleclaw\.ttyd<\/string>/, 'Label must identify the ttyd job');
    assert.match(plist, /<string>3100<\/string>/, 'ttyd must listen on port 3100');
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
