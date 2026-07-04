'use strict';

// #456 — Antigravity engine (agy), Google's Gemini CLI successor.
//
// Pins the bundled profile's contract against the real agy v1.0.10 CLI
// surface: detection target, launch-mode flags, config generation to
// `.antigravity.md`, and the gemini-md generator's header regression
// (the antigravity-md case reuses it with a different header — the
// gemini output must stay byte-identical).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const engines = require('../lib/engines');

const PROJECT_CONFIG = {
  rules: {
    core: {
      changelogPerChange: true,
      jsdocAllFunctions: true,
      unitTestRequirements: true,
      sessionWrapProtocol: true,
      porthubRegistration: true
    },
    extensions: {}
  }
};
const TEMPLATE = { id: 'prawduct', name: 'Prawduct', description: 'Test methodology' };

describe('antigravity engine (#456)', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-antigravity-test-'));
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('bundled profile', () => {
    it('ships in data/engines/ and syncs into the store', () => {
      const profile = store.engines.get('antigravity');
      assert.ok(profile, 'antigravity profile missing from store after init');
      assert.equal(profile.name, 'Antigravity');
      assert.equal(profile.command, 'agy');
      assert.equal(profile.interactionModel, 'session');
    });

    it('passes the required-field validation used at profile load', () => {
      const profile = store.engines.get('antigravity');
      for (const field of ['id', 'name', 'command', 'interactionModel', 'configFormat', 'detection']) {
        assert.ok(profile[field] !== undefined, `required field ${field} missing`);
      }
    });

    it('detects via `which agy`', () => {
      const profile = store.engines.get('antigravity');
      assert.equal(profile.detection.strategy, 'which');
      assert.equal(profile.detection.target, 'agy');
    });

    it('appears in the engine list with availability', () => {
      const entry = engines.listWithAvailability().find((e) => e.id === 'antigravity');
      assert.ok(entry, 'antigravity missing from listWithAvailability');
      assert.equal(typeof entry.available, 'boolean');
    });
  });

  describe('launch modes — pinned to the real agy v1.0.10 flag surface', () => {
    it('offers exactly the modes the binary has (no Gemini carry-over)', () => {
      const profile = store.engines.get('antigravity');
      assert.deepEqual(
        Object.keys(profile.launchModes).sort(),
        ['bypassPermissions', 'default', 'sandbox'],
        'agy v1.0.10 has no auto_edit/plan approval modes — do not invent them'
      );
      assert.equal(profile.defaultLaunchMode, 'default');
    });

    it('default mode passes no extra args', () => {
      const profile = store.engines.get('antigravity');
      assert.deepEqual(profile.launchModes.default.args, []);
    });

    it('sandbox mode maps to --sandbox', () => {
      const profile = store.engines.get('antigravity');
      assert.deepEqual(profile.launchModes.sandbox.args, ['--sandbox']);
    });

    it('bypass mode maps to --dangerously-skip-permissions and carries a warning', () => {
      const profile = store.engines.get('antigravity');
      assert.deepEqual(profile.launchModes.bypassPermissions.args, ['--dangerously-skip-permissions']);
      assert.ok(profile.launchModes.bypassPermissions.warning, 'bypass mode must carry a warning');
    });
  });

  describe('capabilities', () => {
    it('supports prime prompt (tmux-typed) and config file; honest about the rest', () => {
      const caps = store.engines.get('antigravity').capabilities;
      assert.equal(caps.supportsPrimePrompt, true);
      assert.equal(caps.supportsConfigFile, true);
      assert.equal(caps.supportsSlashCommands, false);
      assert.equal(caps.supportsCoAuthor, false);
    });

    it('reuses the google-incidents status adapter', () => {
      const sp = store.engines.get('antigravity').statusPage;
      assert.equal(sp.adapter, 'google-incidents');
      // productName is deliberately "Gemini": agy fronts Gemini models, and
      // model-serving incidents on the Google status page carry that name.
      assert.equal(sp.productName, 'Gemini');
    });
  });

  describe('config generation (.antigravity.md)', () => {
    it('targets .antigravity.md at the project root via the antigravity-md generator', () => {
      const cf = store.engines.get('antigravity').configFormat;
      assert.equal(cf.filename, '.antigravity.md');
      assert.equal(cf.generator, 'antigravity-md');
      assert.equal(cf.syntax, 'markdown');
    });

    it('generates markdown with the .antigravity.md header and rules content', () => {
      const content = engines.generateConfig('antigravity', PROJECT_CONFIG, TEMPLATE);
      assert.ok(content, 'generateConfig("antigravity") must not return null — generator missing from switch?');
      assert.ok(
        content.startsWith('# .antigravity.md — Generated by TangleClaw'),
        `wrong header: ${content.split('\n')[0]}`
      );
      assert.ok(content.includes('Core Rules'));
      assert.ok(content.includes('JSDoc'));
    });

    it('REGRESSION: gemini output keeps its own header (shared generator, parameterized header)', () => {
      const content = engines.generateConfig('gemini', PROJECT_CONFIG, TEMPLATE);
      assert.ok(content);
      assert.ok(
        content.startsWith('# GEMINI.md — Generated by TangleClaw'),
        `gemini header drifted: ${content.split('\n')[0]}`
      );
    });
  });

  describe('UI surface', () => {
    it('session.css has an engine badge color for antigravity', () => {
      const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.css'), 'utf8');
      assert.ok(css.includes('[data-engine="antigravity"]'), 'missing .banner-engine antigravity rule');
      assert.ok(css.includes('--engine-antigravity'), 'missing --engine-antigravity color var');
    });
  });
});
