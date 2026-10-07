'use strict';

/*
 * #2177 — a launch reads the pane before it types.
 *
 * Codex opens on dialogs whose highlighted default has consequences, and
 * TangleClaw used to send two Enters into whatever was up. These tests pin the
 * reader that replaced the guess: which declared prompt is the live screen,
 * judged on whole live captures, and what a launch-time send is refused for.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const startupPrompts = require('../lib/startup-prompts');
const { CODEX_STARTUP_PANES: PANES } = require('./_codex-startup-fixtures');

const codex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
const COMPOSER_RE = new RegExp(codex.capabilities.wake.promptPattern);

describe('declared startup prompts (#2177)', () => {
  it('reads the prompts Codex declares, each with what the operator should do', () => {
    const prompts = startupPrompts.declared(codex);
    assert.deepEqual(prompts.map((p) => p.id), ['folder-trust', 'update']);
    for (const p of prompts) assert.ok(p.humanAction.length > 0, `${p.id} says what to do`);
  });

  it('is empty for a profile that declares none', () => {
    assert.deepEqual(startupPrompts.declared({ launch: {} }), []);
    assert.deepEqual(startupPrompts.declared({}), []);
    assert.deepEqual(startupPrompts.declared(null), []);
  });

  it('drops a malformed entry and keeps the rest, so a bad profile cannot fail a launch', () => {
    const prompts = startupPrompts.declared({ launch: { startupPrompts: [
      { id: 'ok', match: 'Continue\\?' },
      { id: 'bad-pattern', match: '(' },
      { id: '', match: 'x' },
      { match: 'no id' },
      null
    ] } });
    assert.deepEqual(prompts.map((p) => p.id), ['ok']);
    assert.equal(prompts[0].humanAction, '');
  });
});

describe('which screen is live, on whole Codex captures (#2177)', () => {
  const prompts = startupPrompts.declared(codex);
  const assess = (pane) => startupPrompts.assess(pane.lines, prompts, COMPOSER_RE);

  it('the folder-trust prompt is live although the opening composer is still drawn above it', () => {
    assert.ok(PANES.trustPrompt.lines.some((l) => COMPOSER_RE.test(l)), 'the capture holds a bare composer row');
    const seen = assess(PANES.trustPrompt);
    assert.equal(seen.state, 'prompt');
    assert.equal(seen.prompt.id, 'folder-trust');
  });

  it('the update prompt is live although the opening composer is still drawn above it', () => {
    assert.ok(PANES.updatePrompt.lines.some((l) => COMPOSER_RE.test(l)), 'the capture holds a bare composer row');
    const seen = assess(PANES.updatePrompt);
    assert.equal(seen.state, 'prompt');
    assert.equal(seen.prompt.id, 'update');
  });

  it('an update prompt already skipped is not live: its rows sit above the composer that replaced it', () => {
    assert.ok(PANES.composerAfterUpdateSkipped.lines.join('\n').includes('Update available · '), 'the answered prompt is still on screen');
    assert.deepEqual(assess(PANES.composerAfterUpdateSkipped), { state: 'composer' });
  });

  it('a usable composer is a composer', () => {
    assert.deepEqual(assess(PANES.composer), { state: 'composer' });
  });

  it('a styled dialog row matches like a plain one', () => {
    const styled = PANES.updatePrompt.lines.map((l) => l.replace('Update available', '\x1b[1mUpdate available\x1b[0m'));
    assert.equal(startupPrompts.assess(styled, prompts, COMPOSER_RE).state, 'prompt');
  });

  it('a screen with neither a composer nor a declared prompt is unrecognised', () => {
    assert.deepEqual(startupPrompts.assess(['Verifying your account…', ''], prompts, COMPOSER_RE), { state: 'unrecognised' });
    assert.deepEqual(startupPrompts.assess([], prompts, COMPOSER_RE), { state: 'unrecognised' });
  });

  it('without a composer pattern the whole capture is searched, and no composer is ever claimed', () => {
    assert.equal(startupPrompts.assess(PANES.trustPrompt.lines, prompts, null).state, 'prompt');
    assert.deepEqual(startupPrompts.assess(PANES.composer.lines, prompts, null), { state: 'unrecognised' });
  });
});

describe('what a launch-time send is refused for (#2177)', () => {
  let tmpDir;
  let sessions;
  let wakeProfile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-startup-prompts-'));
    store._setBasePath(tmpDir);
    store.init();
    sessions = require('../lib/sessions');
    wakeProfile = require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const refusal = (pane, readiness) => sessions._startupTypingRefusal('t', codex, wakeProfile, readiness.ready !== true, () => ({ lines: [...pane.lines] }));

  it('resolves the shipped Codex wake profile, so the composer is judged by the real pattern', () => {
    assert.ok(wakeProfile && wakeProfile.promptRe instanceof RegExp);
  });

  it('the folder-trust prompt refuses the send and tells the operator it is theirs to answer', () => {
    for (const readiness of [{ gated: true, ready: false }, { gated: true, ready: true }]) {
      const r = refusal(PANES.trustPrompt, readiness);
      assert.equal(r.promptId, 'folder-trust');
      assert.match(r.reason, /folder-trust prompt, which TangleClaw does not answer/);
      assert.match(r.reason, /does not accept folder trust on your behalf/);
    }
  });

  it('the update prompt refuses the send, ready or not', () => {
    for (const readiness of [{ gated: true, ready: false }, { gated: true, ready: true }]) {
      const r = refusal(PANES.updatePrompt, readiness);
      assert.equal(r.promptId, 'update');
      assert.match(r.reason, /Escape skips it/);
    }
  });

  it('a composer is typed into, including one the gate never saw its marker on', () => {
    assert.equal(refusal(PANES.composer, { gated: true, ready: false }), null);
    assert.equal(refusal(PANES.composer, { gated: true, ready: true }), null);
    assert.equal(refusal(PANES.composerAfterUpdateSkipped, { gated: true, ready: false }), null);
  });

  it('an unrecognised screen is refused unless the pane was observed ready', () => {
    const odd = { lines: ['Signing in…'] };
    const r = refusal(odd, { gated: true, ready: false });
    assert.equal(r.promptId, null);
    assert.match(r.reason, /never observed ready/);
    assert.equal(refusal(odd, { gated: true, ready: true }), null);
  });

  it('a pane that cannot be read is refused: nothing is typed on a guess', () => {
    const r = sessions._startupTypingRefusal('t', codex, wakeProfile, false, () => { throw new Error('no server running'); });
    assert.equal(r.promptId, null);
    assert.match(r.reason, /could not be read, so nothing was typed.*no server running/);
  });

  it('an empty capture is an unread pane, not an empty screen: tmux answers a failed read with no lines', () => {
    for (const refuseUnrecognised of [true, false]) {
      for (const cap of [{ lines: [] }, {}, null]) {
        const r = sessions._startupTypingRefusal('t', codex, wakeProfile, refuseUnrecognised, () => cap);
        assert.equal(r.promptId, null);
        assert.match(r.reason, /could not be read, so nothing was typed.*came back empty/);
      }
    }
  });

  it('an engine that declares no startup prompts is not asked, and its pane is not read', () => {
    let reads = 0;
    const r = sessions._startupTypingRefusal('t', { id: 'aider', launch: {} }, null, true, () => { reads++; return { lines: [] }; });
    assert.equal(r, null);
    assert.equal(reads, 0);
  });
});
