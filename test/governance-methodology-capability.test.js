'use strict';

/*
 * #1738 — whether a session's engine can run the project's Prawduct methodology.
 *
 * The distinction under test is the one `governanceState` cannot make: off
 * Claude it answers `not-applicable` before reading the disk, so an onboarded
 * project on Gemini looked exactly like a project that was never onboarded.
 * The first must be left dormant and untouched; the second has nothing to leave.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const governance = require('../lib/governance-state');

/**
 * A temporary project directory, removed after `fn`.
 * @param {(dir: string) => void} setup - Seeds the directory.
 * @param {(dir: string) => void} fn - The body.
 * @returns {void}
 */
function withProject(setup, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-methodology-'));
  try {
    setup(dir);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const withPrawductDir = (dir) => fs.mkdirSync(path.join(dir, '.prawduct'));
const withPluginRef = (dir) => {
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'prawduct@prawduct': true } }));
};

describe('methodologyCapability (#1738)', () => {
  it('is available on Claude for an onboarded project', () => {
    withProject(withPrawductDir, (dir) => {
      const cap = governance.methodologyCapability(dir, { engineId: 'claude' });
      assert.equal(cap.disposition, 'available');
      assert.equal(cap.available, true);
      assert.equal(cap.onboarded, true);
      assert.equal(cap.capability, governance.METHODOLOGY_CAPABILITY);
    });
  });

  for (const engineId of ['gemini', 'codex', 'aider']) {
    it(`is capability-unavailable on ${engineId} for an onboarded project, naming the engine`, () => {
      withProject(withPrawductDir, (dir) => {
        const cap = governance.methodologyCapability(dir, { engineId });
        assert.equal(cap.disposition, 'capability-unavailable');
        assert.equal(cap.available, false);
        assert.equal(cap.onboarded, true, 'onboarding is a fact about the disk, not the engine');
        assert.equal(cap.engineId, engineId);
        assert.match(cap.reason, new RegExp(engineId));
        assert.match(cap.reason, /dormant/);
      });
    });
  }

  it('counts the committed plugin reference as onboarded even with no .prawduct/', () => {
    withProject(withPluginRef, (dir) => {
      assert.equal(governance.methodologyCapability(dir, { engineId: 'gemini' }).disposition, 'capability-unavailable');
    });
  });

  it('is not-applicable for a project that was never onboarded, on any engine', () => {
    withProject(() => {}, (dir) => {
      for (const engineId of ['claude', 'gemini']) {
        const cap = governance.methodologyCapability(dir, { engineId });
        assert.equal(cap.disposition, 'not-applicable', engineId);
        assert.equal(cap.onboarded, false);
      }
    });
  });

  it('reads an unknown engine as unable to run the plugin, never as able', () => {
    withProject(withPrawductDir, (dir) => {
      const cap = governance.methodologyCapability(dir, {});
      assert.equal(cap.disposition, 'capability-unavailable');
      assert.equal(cap.engineId, null);
    });
  });

  it('writes nothing while it looks', () => {
    withProject(withPrawductDir, (dir) => {
      const before = fs.readdirSync(path.join(dir, '.prawduct'));
      governance.methodologyCapability(dir, { engineId: 'gemini' });
      assert.deepEqual(fs.readdirSync(path.join(dir, '.prawduct')), before);
      assert.deepEqual(fs.readdirSync(dir).sort(), ['.prawduct']);
    });
  });

  it('sessionEngineId prefers the session, then the project row, and never invents one', () => {
    assert.equal(governance.sessionEngineId({ engineId: 'codex' }, { engineId: 'claude' }), 'codex');
    assert.equal(governance.sessionEngineId({}, { engineId: 'claude' }), 'claude');
    assert.equal(governance.sessionEngineId(null, { engine: 'claude' }), null, 'project rows carry engineId, not engine');
    assert.equal(governance.sessionEngineId(null, null), null);
  });
});
