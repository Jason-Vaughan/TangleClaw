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

describe('honorsLaunchMode is the single definition of "the engine will run this" (#731)', () => {
  const engines = require('../lib/engines');

  it('accepts a mode the profile declares', () => {
    assert.equal(engines.honorsLaunchMode(codex, 'bypassPermissions'), true);
  });

  it('rejects a mode the profile does not declare', () => {
    assert.equal(engines.honorsLaunchMode(codex, 'acceptEdits'), false);
  });

  it('rejects a declared-but-disabled mode', () => {
    const disabled = { launchModes: { fullAuto: { args: [], disabled: true } } };
    assert.equal(engines.honorsLaunchMode(disabled, 'fullAuto'), false);
  });

  it('rejects inherited Object members — a mode key arrives from request bodies', () => {
    // `constructor` / `__proto__` / `toString` resolve to truthy prototype
    // members. A bare index treats them as valid modes: no args appended, no
    // warning logged — the precise silent mismatch this predicate exists for.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(engines.honorsLaunchMode(codex, key), false, `${key} must not resolve as a mode`);
    }
  });

  it('handles a missing or malformed profile without throwing', () => {
    assert.equal(engines.honorsLaunchMode(null, 'default'), false);
    assert.equal(engines.honorsLaunchMode({}, 'default'), false);
    assert.equal(engines.honorsLaunchMode(codex, ''), false);
    assert.equal(engines.honorsLaunchMode(codex, undefined), false);
  });

  it('reconciles an unhonored mode to default, including inherited keys', () => {
    // `projects.reconcileLaunchMode` is module-internal and now delegates here;
    // that delegation is covered behaviorally by the engine-switch tests in
    // test/launch-mode-settings.test.js rather than by exporting it for a test.
    assert.equal(engines.reconcileLaunchMode('bypassPermissions', codex), 'bypassPermissions');
    assert.equal(engines.reconcileLaunchMode('acceptEdits', codex), 'default');
    assert.equal(engines.reconcileLaunchMode('__proto__', codex), 'default');
    assert.equal(engines.reconcileLaunchMode('default', null), 'default');
  });
});

describe('_buildLaunchCommand rejects prototype members as modes (#731)', () => {
  it('appends nothing and warns for an inherited key', () => {
    const captured = [];
    logger.setConsoleStream({ write: (s) => captured.push(s) });
    try {
      const cmd = sessions._buildLaunchCommand(codex, null, 'constructor');
      assert.equal(cmd, 'codex', 'a prototype member must never contribute args');
      assert.match(captured.join(''), /not honored by this engine/);
    } finally {
      logger.setConsoleStream(null);
    }
  });
});

describe('_resolvePreKeys uses the same honored-mode predicate (#731)', () => {
  it('ignores an inherited mode that would supply preKeys', () => {
    // The fixture has to be one where a bare index and hasOwnProperty actually
    // DIVERGE. `constructor` does not: `Object.preKeys` is undefined, so the
    // old bare-index path fell straight through to the same engine-level
    // branch, and a test using it passes identically before and after the
    // hardening — the exact defect this test exists to catch, which is why the
    // first version of it was worthless.
    //
    // An inherited mode that DOES carry preKeys separates them: a bare index
    // finds it through the prototype chain and returns ['X']; hasOwnProperty
    // does not, so engine-level preKeys win.
    const profile = {
      launch: { preKeys: ['Enter', 'Enter'], preKeyDelay: 3000 },
      launchModes: Object.create({ evil: { preKeys: ['X'] } })
    };
    profile.launchModes.default = { args: [] };

    const resolved = sessions._resolvePreKeys(profile, 'evil');
    assert.deepEqual(resolved.preKeys, ['Enter', 'Enter'], 'an inherited mode must not supply preKeys');
    assert.notDeepEqual(resolved.preKeys, ['X']);
  });

  it('still returns engine preKeys for a real mode that declares none', () => {
    // Codex's modes carry no mode-level preKeys, so the engine-level
    // ["Enter","Enter"] must survive — they clear codex's directory-trust
    // prompt on startup, verified against codex-cli 0.145.0.
    const resolved = sessions._resolvePreKeys(codex, 'fullAuto');
    assert.deepEqual(resolved.preKeys, ['Enter', 'Enter']);
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
    assert.match(text, /not honored by this engine/);
    assert.match(text, /launchMode=acceptEdits/);
    assert.match(text, /engine=codex/);
    assert.match(text, /available=/, 'the warning must name the modes that do exist');
    // Still launches — refusing would strand a project over a cosmetic setting.
    assert.equal(cmd, 'codex');
  });

  it('stays quiet on a mode the engine does define', () => {
    sessions._buildLaunchCommand(codex, null, 'fullAuto');
    assert.doesNotMatch(captured.join(''), /not honored by this engine/);
  });
});
