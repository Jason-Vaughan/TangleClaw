'use strict';

// #500 — lib/ttyd-attach.js keeps the ttyd attach script current in a non-TCC
// install path (~/.tangleclaw/deploy/), out of the TCC-protected ~/Documents
// repo where ttyd (denied Full Disk Access) freezes reading it per connection.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ttydAttach = require('../lib/ttyd-attach');

describe('lib/ttyd-attach', () => {
  let tmp, repoDir, home, srcPath, destPath;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ttyd-attach-'));
    repoDir = path.join(tmp, 'repo');
    home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(repoDir, 'deploy'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    srcPath = path.join(repoDir, 'deploy', 'ttyd-attach.sh');
    destPath = ttydAttach.attachScriptPath(home);
    fs.writeFileSync(srcPath, '#!/usr/bin/env bash\necho v1\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('attachScriptPath', () => {
    it('resolves under ~/.tangleclaw/deploy (a non-TCC location), never the repo', () => {
      const p = ttydAttach.attachScriptPath(home);
      assert.equal(p, path.join(home, '.tangleclaw', 'deploy', 'ttyd-attach.sh'));
      assert.ok(!p.includes(path.join('repo', 'deploy')), 'must not point back into the repo');
    });
  });

  describe('syncAttachScript', () => {
    it('copies the script (0755) when the destination is missing, creating the dir', () => {
      assert.equal(fs.existsSync(path.dirname(destPath)), false);
      const r = ttydAttach.syncAttachScript({ repoDir, home });
      assert.equal(r.synced, true);
      assert.equal(r.reason, 'copied');
      assert.equal(r.path, destPath);
      assert.equal(fs.readFileSync(destPath, 'utf8'), '#!/usr/bin/env bash\necho v1\n');
      assert.equal(fs.statSync(destPath).mode & 0o777, 0o755, 'exec bit must be set');
    });

    it('is a no-op when the copy already matches (idempotent boot)', () => {
      ttydAttach.syncAttachScript({ repoDir, home });
      const r = ttydAttach.syncAttachScript({ repoDir, home });
      assert.equal(r.synced, false);
      assert.equal(r.reason, 'up-to-date');
    });

    it('refreshes the copy when the repo script changes (drift after an update)', () => {
      ttydAttach.syncAttachScript({ repoDir, home });
      fs.writeFileSync(srcPath, '#!/usr/bin/env bash\necho v2-updated\n');
      const r = ttydAttach.syncAttachScript({ repoDir, home });
      assert.equal(r.synced, true);
      assert.equal(r.reason, 'refreshed');
      assert.equal(fs.readFileSync(destPath, 'utf8'), '#!/usr/bin/env bash\necho v2-updated\n');
    });

    it('re-asserts the exec bit even when the bytes already match', () => {
      ttydAttach.syncAttachScript({ repoDir, home });
      fs.chmodSync(destPath, 0o644); // simulate a copy that lost +x
      const r = ttydAttach.syncAttachScript({ repoDir, home });
      assert.equal(r.reason, 'up-to-date');
      assert.equal(fs.statSync(destPath).mode & 0o777, 0o755, 'up-to-date path must still fix perms');
    });

    it('reports no-source (never throws) when the repo script is absent', () => {
      fs.rmSync(srcPath);
      const r = ttydAttach.syncAttachScript({ repoDir, home });
      assert.equal(r.synced, false);
      assert.equal(r.reason, 'no-source');
      assert.equal(fs.existsSync(destPath), false);
    });

    it('returns an error reason instead of throwing when the dest dir cannot be created (boot must not crash)', () => {
      // Place a FILE where the ~/.tangleclaw/deploy directory needs to be, so
      // mkdirSync throws ENOTDIR — the boot/cutover callers must survive it.
      fs.mkdirSync(path.join(home, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(home, '.tangleclaw', 'deploy'), 'not a directory');
      let r;
      assert.doesNotThrow(() => { r = ttydAttach.syncAttachScript({ repoDir, home }); });
      assert.equal(r.synced, false);
      assert.match(r.reason, /^error:/);
    });

    it('the real repo deploy/ttyd-attach.sh is the sync source (keeps copy == repo)', () => {
      // Guards against the install path and the sync source drifting apart:
      // syncing from the actual repo yields byte-identical content.
      const realRepo = path.join(__dirname, '..');
      const r = ttydAttach.syncAttachScript({ repoDir: realRepo, home });
      assert.equal(r.synced, true);
      assert.equal(
        fs.readFileSync(destPath, 'utf8'),
        fs.readFileSync(path.join(realRepo, 'deploy', 'ttyd-attach.sh'), 'utf8')
      );
    });
  });
});
