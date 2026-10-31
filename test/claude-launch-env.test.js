'use strict';

// #1113 — spawned Claude sessions must not auto-open artifact tabs on a host
// nobody watches. Claude Code's own auto-open guard honors
// `CLAUDE_CODE_ARTIFACT_AUTO_OPEN` (its `qp()` check accepts "0"|"false"|
// "no"|"off"; unset defaults to auto-open ON), and `lib/sessions.js`'s
// `_launchEnv` merges `launchProfile.launch.env` straight into the spawned
// session's environment. The fix is data, not code: this pins the bundled
// claude.json profile carries the key, as a string value (tmux's `-e`
// injection stringifies it regardless, but the profile should not rely on
// that coercion).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');

describe('claude engine launch env (#1113)', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-claude-launch-env-test-'));
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('disables Claude Code artifact auto-open in the bundled profile', () => {
    const profile = store.engines.get('claude');
    assert.ok(profile, 'claude profile missing from store after init');
    assert.equal(profile.launch.env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN, '0',
      'CLAUDE_CODE_ARTIFACT_AUTO_OPEN must be the string "0", not boolean/number — Claude ' +
      'Code\'s own qp() check matches "0"|"false"|"no"|"off" as strings');
  });

  it('leaves every other bundled engine profile untouched', () => {
    const dataDir = path.join(__dirname, '..', 'data', 'engines');
    const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json') && f !== 'claude.json');
    assert.ok(files.length > 0, 'expected other engine profiles to exist alongside claude.json');
    for (const file of files) {
      const raw = fs.readFileSync(path.join(dataDir, file), 'utf8');
      const profile = JSON.parse(raw);
      const env = (profile.launch && profile.launch.env) || {};
      assert.equal(env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN, undefined,
        `${file} must not gain the Claude-specific artifact auto-open key`);
    }
  });
});
