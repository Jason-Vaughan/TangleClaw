'use strict';

/*
 * ADR 0013 — a setting TangleClaw offers must take effect, or say why it does
 * not. `engines.settingDisposition` is the one mechanism that answers it: does
 * this setting apply on this project's engine, what does the operator read when
 * it does not, and was the stored value a real choice.
 *
 * Three things here are worth more than the rest:
 *
 *  - **The warn/info asymmetry**, which is derived from provenance rather than
 *    picked per setting. Collapsing it to one level is the obvious "cleanup"
 *    and breaks one of the two cases every time.
 *  - **No second implementation.** The two predicates that predate the
 *    mechanism must be expressed in terms of it (or of each other), not
 *    restated alongside it.
 *  - **Cross-realm parity of the reason TEXT, not just the boolean.**
 *    `public/` cannot require `lib/`, so the browser carries a restated copy; a
 *    reason that drifts tells the operator something the server does not
 *    believe.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engines = require('../lib/engines');
const { DEFAULT_PROJECT_CONFIG } = require('../lib/project-config');
const loadApiHelperGlobals = require('./_api-helper-globals');

const ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');

/** @returns {object[]} Every bundled engine profile. */
function bundledProfiles() {
  return fs.readdirSync(ENGINES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, f), 'utf8')));
}

const supporting = { id: 'claude', name: 'Claude Code', capabilities: { supportsSilentPrime: true } };
const notSupporting = { id: 'codex', name: 'Codex', capabilities: { supportsSilentPrime: false } };

describe('settingDisposition — the one answer to "does this setting apply here" (ADR 0013)', () => {
  it('answers applies with no reason to render when the engine honors the setting', () => {
    const d = engines.settingDisposition('silentPrime', { silentPrime: true }, supporting);
    assert.equal(d.applies, true);
    assert.equal(d.reason, null, 'nothing to tell the operator when the control is live');
    assert.equal(d.evidence, null);
    assert.equal(d.level, null, 'no log line is owed either');
  });

  it('carries an operator-readable reason naming the engine when it does not', () => {
    const d = engines.settingDisposition('silentPrime', { silentPrime: true }, notSupporting);
    assert.equal(d.applies, false);
    assert.match(d.reason, /Codex/, 'the reason names the engine as the operator knows it');
    assert.doesNotMatch(d.reason, /capabilities\./,
      'the sentence the operator reads is not a field path');
    assert.equal(d.evidence, 'capabilities.supportsSilentPrime is not true',
      'the profile fact stays available for the log');
  });

  it('refuses a setting nobody declared a gate for, rather than answering "it applies"', () => {
    // A silent yes here would be the exact no-op ADR 0013 exists to end: a
    // caller asks about a setting, gets "fine", and ships a control that does
    // nothing. A typo must fail loudly instead.
    assert.throws(
      () => engines.settingDisposition('silentPrimee', { }, supporting),
      /no engine gate declared/
    );
  });

  describe('the warn/info asymmetry is derived from provenance, not picked per setting', () => {
    it('a value the operator actually chose warns when it is dropped', () => {
      // `defaultLaunchMode` ships 'default', so a stored 'plan' is intent.
      const d = engines.settingDisposition('defaultLaunchMode',
        { defaultLaunchMode: 'plan' }, notSupporting);
      assert.equal(d.applies, false);
      assert.equal(d.chosen, true);
      assert.equal(d.level, 'warn');
    });

    it('a value indistinguishable from the shipped default records at info', () => {
      // `silentPrime` ships `true`, so a stored `true` cannot be told apart
      // from "never touched" — warning would fire on every non-Claude launch
      // about a preference nobody expressed.
      assert.equal(DEFAULT_PROJECT_CONFIG.silentPrime, true,
        'if the shipped default changes, this case is no longer the one described');
      const d = engines.settingDisposition('silentPrime', { silentPrime: true }, notSupporting);
      assert.equal(d.chosen, false);
      assert.equal(d.level, 'info');
    });

    it('the same setting warns when the stored value differs from what ships', () => {
      // The asymmetry belongs to the VALUE, not to the setting: `silentPrime`
      // is not "the info one". A stored `false` is a choice and warns.
      const d = engines.settingDisposition('silentPrime', { silentPrime: false }, notSupporting);
      assert.equal(d.chosen, true);
      assert.equal(d.level, 'warn');
    });

    it('an absent key is the shipped default, not a choice', () => {
      const d = engines.settingDisposition('silentPrime', {}, notSupporting);
      assert.equal(d.value, DEFAULT_PROJECT_CONFIG.silentPrime);
      assert.equal(d.chosen, false);
      assert.equal(d.level, 'info');
    });

    it('the two levels are not the same level', () => {
      // The one assertion that fails if a later refactor collapses them.
      const chosen = engines.settingDisposition('silentPrime', { silentPrime: false }, notSupporting);
      const shipped = engines.settingDisposition('silentPrime', { silentPrime: true }, notSupporting);
      assert.notEqual(chosen.level, shipped.level,
        'provenance is what decides the level — one level for both is the bug');
    });
  });

  describe('launch modes: the reason distinguishes "disabled here" from "never offered here"', () => {
    const withDisabled = {
      id: 'claude',
      name: 'Claude Code',
      launchModes: { default: { label: 'Interactive' }, plan: { label: 'Plan', disabled: true } }
    };

    it('names a declared-but-disabled mode as disabled', () => {
      const d = engines.settingDisposition('defaultLaunchMode', { defaultLaunchMode: 'plan' }, withDisabled);
      assert.equal(d.applies, false);
      assert.match(d.reason, /has disabled the launch mode "plan"/);
      assert.equal(d.evidence, 'mode is disabled');
    });

    it('names an undeclared mode as one the engine does not offer', () => {
      const d = engines.settingDisposition('defaultLaunchMode',
        { defaultLaunchMode: 'bypassPermissions' }, withDisabled);
      assert.equal(d.applies, false);
      assert.match(d.reason, /does not offer the launch mode "bypassPermissions"/);
      assert.equal(d.evidence, 'engine does not define this mode');
    });

    it('a mode the engine runs applies, with nothing to say', () => {
      const d = engines.settingDisposition('defaultLaunchMode', { defaultLaunchMode: 'default' }, withDisabled);
      assert.equal(d.applies, true);
      assert.equal(d.reason, null);
    });

    it('a non-string stored value is still judged rather than skipped', () => {
      // The pre-mechanism launch path guarded on `typeof === 'string'` and fell
      // through in silence for anything else — a stored value producing no
      // effect and no record, which is the shape ADR 0013 forbids.
      const d = engines.settingDisposition('defaultLaunchMode', { defaultLaunchMode: 42 }, withDisabled);
      assert.equal(d.applies, false);
      assert.match(d.reason, /that launch mode/, 'no key to quote, so the sentence still reads');
    });
  });

  describe('one implementation, not a third', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engines.js'), 'utf8');

    /**
     * @param {string} name - Function name.
     * @returns {string} The function's source, declaration through closing brace.
     */
    function body(name) {
      const start = SRC.indexOf(`function ${name}(`);
      assert.ok(start >= 0, `${name} must exist`);
      let depth = 0;
      for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
      }
      assert.fail(`${name} body must close`);
      return '';
    }

    it('silentPrimeDisposition asks the mechanism rather than restating the capability check', () => {
      const src = body('silentPrimeDisposition');
      assert.match(src, /settingDisposition\('silentPrime'/);
      assert.doesNotMatch(src, /supportsSilentPrime/,
        'the capability gate has one owner');
    });

    it('reconcileLaunchMode still delegates to honorsLaunchMode', () => {
      const src = body('reconcileLaunchMode');
      assert.match(src, /honorsLaunchMode\(/);
      assert.doesNotMatch(src, /hasOwnProperty/, 'it must not grow its own membership test');
    });

    it('the launch-mode gate has exactly one implementation of "declares and not disabled"', () => {
      // `honorsLaunchMode` owns the predicate; the disposition table is
      // expressed in terms of it. A second `disabled !== true` in this file is
      // a restated copy.
      const hits = SRC.match(/disabled\s*!==\s*true/g) || [];
      assert.equal(hits.length, 1,
        'exactly one place decides whether a declared mode is honored');
    });

    it('the tri-state answer survives the routing', () => {
      assert.equal(engines.silentPrimeDisposition({ silentPrime: true }, supporting), 'on');
      assert.equal(engines.silentPrimeDisposition({ silentPrime: false }, supporting), 'off');
      assert.equal(engines.silentPrimeDisposition({ silentPrime: true }, notSupporting), 'not-applicable');
    });
  });

  describe('the browser copy answers what the server answers — text included', () => {
    const ctx = loadApiHelperGlobals();

    it('restates the shipped defaults the server derives provenance from', () => {
      // The browser cannot require `lib/project-config.js`. A default that
      // changes on one side and not the other silently reclassifies a real
      // choice as a default, which is the input the log level is derived from.
      for (const [key, value] of Object.entries(ctx.tcSettingDefaults)) {
        assert.equal(value, DEFAULT_PROJECT_CONFIG[key],
          `the browser's shipped default for ${key} must be the one the product ships`);
      }
      assert.ok(Object.keys(ctx.tcSettingDefaults).length > 0, 'an empty table compares nothing');
    });

    it('agrees field for field over every bundled profile and every gated setting', () => {
      const profiles = bundledProfiles();
      assert.ok(profiles.length > 0, 'no bundled profiles found — this would assert nothing');

      // Fixtures the bundled set does not contain, so the loop compares more
      // than the cases where any two spellings happen to agree: a
      // declared-but-disabled mode, and a profile that declares no modes at all.
      const fixtures = profiles.concat([
        {
          id: 'claude', name: 'Claude Code',
          capabilities: { supportsSilentPrime: true },
          launchModes: { default: { label: 'Interactive' }, plan: { label: 'Plan', disabled: true } }
        },
        { id: 'barebones', name: 'Barebones', capabilities: {}, launchModes: {} }
      ]);

      const cases = [
        ['silentPrime', { silentPrime: true }],
        ['silentPrime', { silentPrime: false }],
        ['silentPrime', {}],
        ['defaultLaunchMode', { defaultLaunchMode: 'default' }],
        ['defaultLaunchMode', { defaultLaunchMode: 'plan' }],
        ['defaultLaunchMode', { defaultLaunchMode: 'bypassPermissions' }],
        ['defaultLaunchMode', {}]
      ];

      let compared = 0;
      for (const profile of fixtures) {
        for (const [setting, projConfig] of cases) {
          const server = engines.settingDisposition(setting, projConfig, profile);
          const browser = ctx.tcSettingDisposition(setting, projConfig, profile);
          // Compared field by field rather than deep-equal: the browser object
          // is built in a vm realm, so `deepStrictEqual` reports two identical
          // objects as unequal on their prototypes.
          for (const field of ['setting', 'value', 'applies', 'chosen', 'reason', 'evidence', 'level']) {
            assert.equal(browser[field], server[field],
              `${profile.id}/${setting}=${JSON.stringify(projConfig[setting])}: `
              + `${field} must match the server (browser ${JSON.stringify(browser[field])}, `
              + `server ${JSON.stringify(server[field])})`);
          }
          compared++;
        }
      }
      assert.ok(compared >= fixtures.length * cases.length, 'the loop must have run');
    });

    it('the browser fails closed on an unknown setting instead of rendering a live control', () => {
      // The server throws; a throw inside a render would blank the modal, so
      // the browser answers "does not apply" and says it could not judge.
      const d = ctx.tcSettingDisposition('notASetting', {}, notSupporting);
      assert.equal(d.applies, false);
      assert.match(d.reason, /could not determine/);
    });
  });
});

describe('the settings surfaces render the disposition rather than their own words', () => {
  const UI = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

  it('the settings modal renders the reason it was given', () => {
    const start = UI.indexOf('function renderSilentPrimeToggle');
    assert.ok(start >= 0);
    const src = UI.slice(start, UI.indexOf('\n}', start));
    assert.match(src, /tcSettingDisposition\('silentPrime'/);
    assert.match(src, /esc\(disposition\.reason\)/, 'the rendered words are the predicate\'s');
    assert.doesNotMatch(src, /supportsSilentPrime/, 'no second capability gate in the browser');
  });

  it('the create wizard offers an inert control with the reason, never nothing', () => {
    // Hiding the control is not compliance under ADR 0013: an absent control
    // answers no question. The wizard used to drop it entirely.
    const start = UI.indexOf('let launchModeHtml');
    assert.ok(start >= 0, 'the create step 2 body must exist');
    const src = UI.slice(start, start + 3000);
    assert.match(src, /tcSettingDisposition\('silentPrime'/);
    assert.match(src, /createSilentPrimeNotApplicable/, 'the inert control is rendered');
    assert.match(src, /esc\(silentPrimeFit\.reason\)/);
    // `createNext` attaches `silentPrime` only when `#createSilentPrime`
    // exists, so the inert branch must not carry that id.
    const inert = src.slice(src.indexOf('createSilentPrimeNotApplicable'));
    assert.doesNotMatch(inert, /id="createSilentPrime"/);
  });
});
