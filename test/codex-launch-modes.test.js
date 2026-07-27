'use strict';

/*
 * #731 — Codex launch modes, and the silent fall-through that hid the breakage.
 *
 * `data/engines/codex.json` shipped `--full-auto` from #211, taken from #209's
 * unverified probe target. Codex CLI later removed the flag, so "Full Auto"
 * built `codex --full-auto`, which exits 2 with "unexpected argument" — the one
 * non-interactive Codex mode could not start a session at all. Nothing caught
 * it because every engine test asserted the profile against a literal copy of
 * itself.
 *
 * The flags themselves are probed against the installed binary in
 * test/engine-launch-flags.test.js. This file pins the mapping and the
 * assembly: which modes Codex offers, what each one builds, and that a mode key
 * the engine does not define is reported rather than silently dropped.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sessions = require('../lib/sessions');
const logger = require('../lib/logger');

const codex = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8')
);

describe('Codex launch modes (#731)', () => {
  it('offers interactive, full-auto, and bypass', () => {
    assert.deepEqual(
      Object.keys(codex.launchModes).sort(),
      ['bypassPermissions', 'default', 'fullAuto']
    );
    assert.equal(codex.defaultLaunchMode, 'default');
  });

  it('never declares --full-auto again — the flag Codex removed', () => {
    const all = Object.values(codex.launchModes).flatMap((m) => m.args || []);
    assert.ok(!all.includes('--full-auto'), '--full-auto was removed from codex-cli; it exits 2');
    assert.ok(!all.includes('--auto-edit'), '--auto-edit was the other unverified guess in #209');
  });

  it('full auto skips approvals but keeps the sandbox', () => {
    // The distinction is the whole point of having two non-default modes: this
    // one is unattended, the other also removes the sandbox.
    assert.deepEqual(
      codex.launchModes.fullAuto.args,
      ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']
    );
    assert.ok(codex.launchModes.fullAuto.warning, 'unattended execution must carry a warning');
  });

  it('bypass drops the sandbox too, and says so', () => {
    assert.deepEqual(
      codex.launchModes.bypassPermissions.args,
      ['--dangerously-bypass-approvals-and-sandbox']
    );
    assert.ok(codex.launchModes.bypassPermissions.warning);
  });

  it('names bypass the same key as every other engine, so a stored mode stays portable', () => {
    // A project's defaultLaunchMode survives an engine change; matching keys
    // mean switching Claude -> Codex keeps the operator's intent instead of
    // silently degrading to interactive.
    for (const id of ['claude', 'antigravity']) {
      const other = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', `${id}.json`), 'utf8')
      );
      assert.ok(
        other.launchModes.bypassPermissions,
        `${id} uses a different bypass key — the shared name is the portability contract`
      );
    }
  });
});

describe('_buildLaunchCommand assembles Codex modes (#731)', () => {
  it('builds the interactive command with no extra args', () => {
    assert.equal(sessions._buildLaunchCommand(codex, null, 'default'), 'codex');
  });

  it('builds the full-auto command', () => {
    assert.equal(
      sessions._buildLaunchCommand(codex, null, 'fullAuto'),
      'codex --ask-for-approval never --sandbox workspace-write'
    );
  });

  it('builds the bypass command', () => {
    assert.equal(
      sessions._buildLaunchCommand(codex, null, 'bypassPermissions'),
      'codex --dangerously-bypass-approvals-and-sandbox'
    );
  });
});

describe('unknown launch mode is reported, not swallowed (#731)', () => {
  let captured;

  beforeEach(() => {
    captured = [];
    logger.setConsoleStream({ write: (s) => captured.push(s) });
  });

  afterEach(() => logger.setConsoleStream(null));

  it('warns when the engine has no such mode, naming what it does have', () => {
    // Reachable in normal use: modes are engine-specific, but a project's stored
    // defaultLaunchMode outlives a change of engine.
    const cmd = sessions._buildLaunchCommand(codex, null, 'acceptEdits');

    const text = captured.join('');
    assert.match(text, /Unknown launch mode/);
    assert.match(text, /launchMode=acceptEdits/);
    assert.match(text, /engine=codex/);
    assert.match(text, /available=/, 'the warning must name the modes that do exist');
    // Still launches — refusing would strand a project over a cosmetic setting.
    assert.equal(cmd, 'codex');
  });

  it('stays quiet on a mode the engine does define', () => {
    sessions._buildLaunchCommand(codex, null, 'fullAuto');
    assert.doesNotMatch(captured.join(''), /Unknown launch mode/);
  });
});
