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

/**
 * Every file under `dir` carrying a CODE read of a capability flag.
 *
 * Comment lines are excluded deliberately: prose naming the flag is a pointer,
 * not a second implementation, and a guard that counted prose would push the
 * next author to delete the explanation instead of the duplicate.
 *
 * Walks the tree, not one level: `lib/wrap-steps/`, `lib/actions/` and their
 * siblings are where a sixth copy would most plausibly appear, and a flat
 * `readdirSync` cannot see one.
 *
 * @param {string} dir - Directory to walk recursively for `.js` files.
 * @param {string} flag - Capability flag name.
 * @returns {string[]} Sorted repo-relative paths.
 */
function capabilityReads(dir, flag) {
  const root = path.join(__dirname, '..');
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...capabilityReads(full, flag));
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    if (codeLinesMentioning(fs.readFileSync(full, 'utf8'), flag).length > 0) {
      out.push(path.relative(root, full));
    }
  }
  return out.sort();
}

/**
 * The non-comment lines of `src` that mention `needle`, trimmed.
 * @param {string} src - Source text.
 * @param {string} needle - Substring to look for.
 * @returns {string[]}
 */
function codeLinesMentioning(src, needle) {
  return src.split('\n')
    .map((line) => line.trim())
    .filter((t) => t.includes(needle) && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'));
}

/**
 * The source of a brace-delimited declaration, declaration through closing brace.
 * @param {string} src - Source text.
 * @param {string} decl - Text that opens the declaration.
 * @returns {string}
 */
function declarationSource(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start >= 0, `${decl} must exist`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} must close`);
  return '';
}

// Probe values per setting: what the product ships, and a value that is a real
// operator choice AND cannot apply on an engine declaring nothing. Checked
// against the server's roster wherever it is used, so a setting added there
// without probes fails rather than going untested.
const PROBES = {
  silentPrime: { shipped: true, chosen: false, inapplicable: true, extras: [] },
  defaultLaunchMode: {
    shipped: 'default', chosen: 'plan', inapplicable: 'plan',
    // A mode claude declares and codex does not, and one no profile declares.
    extras: ['bypassPermissions', 'nosuchmode']
  }
};

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

  describe('an engine with no profile is a thing TangleClaw cannot answer, not a missing capability', () => {
    it('says it cannot say, rather than stating a fact about a flag nobody read', () => {
      // Reachable for a connection-backed id and for an engine retired out of
      // the roster. "Codex does not deliver a hidden prime" for an engine with
      // no profile is the same dishonesty this mechanism exists to end, aimed
      // at the engine instead of the setting.
      const d = engines.settingDisposition('silentPrime', { silentPrime: true }, null);
      assert.equal(d.applies, false);
      assert.match(d.reason, /no profile for this engine/);
      assert.doesNotMatch(d.reason, /hidden prime/, 'it must not claim the capability is absent');
      assert.equal(d.evidence, 'no engine profile');
    });

    it('the browser says the same', () => {
      const ctx2 = loadApiHelperGlobals();
      const d = ctx2.tcSettingDisposition('silentPrime', { silentPrime: true }, null);
      assert.equal(d.applies, false);
      assert.match(d.reason, /no profile for this engine/);
      assert.equal(d.evidence, 'no engine profile');
    });
  });

  describe("'default' is the absence of a mode, not one the engine must declare", () => {
    it('applies on a profile that declares no launch modes at all', () => {
      // `reconcileLaunchMode` short-circuits `'default'`, and it adds no CLI
      // args downstream. Asking the honored-modes predicate about it produced
      // "does not offer the launch mode \"default\", so this project launches in
      // its engine default instead" — a sentence that contradicts itself, shown
      // to the operator on every launch of a project that configured nothing.
      const modeless = { id: 'x', name: 'Modeless', launchModes: {} };
      const d = engines.settingDisposition('defaultLaunchMode', { defaultLaunchMode: 'default' }, modeless);
      assert.equal(d.applies, true);
      assert.equal(d.reason, null);
      assert.equal(engines.reconcileLaunchMode('default', modeless), 'default',
        'and it agrees with the reconciler, which is where the disagreement was');
    });

    it('a real mode the engine does not declare still does not apply', () => {
      const modeless = { id: 'x', name: 'Modeless', launchModes: {} };
      const d = engines.settingDisposition('defaultLaunchMode', { defaultLaunchMode: 'plan' }, modeless);
      assert.equal(d.applies, false);
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

    it('a key holding nothing usable is not called disabled', () => {
      // `hasOwnProperty` alone would report "the engine disabled this mode" for
      // a profile whose key holds `null` — sending the operator to look for a
      // switch nobody ever offered.
      const hollow = { id: 'x', name: 'Hollow', launchModes: { default: { label: 'Interactive' }, plan: null } };
      const d = engines.settingDisposition('defaultLaunchMode', { defaultLaunchMode: 'plan' }, hollow);
      assert.equal(d.applies, false);
      assert.match(d.reason, /does not offer the launch mode "plan"/);
      assert.equal(d.evidence, 'engine does not define this mode');
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
      return declarationSource(SRC, `function ${name}(`);
    }

    it('silentPrimeDisposition asks the mechanism rather than restating the capability check', () => {
      const src = body('silentPrimeDisposition');
      assert.match(src, /settingDisposition\('silentPrime'/);
      assert.doesNotMatch(src, /supportsSilentPrime/,
        'the capability gate has one owner');
    });

    it('no file in lib/ reads the silent-prime capability outside the table', () => {
      // An assertion scoped to one function body while its message claims a
      // file-wide property is how the class survives its own guard: the gate
      // was spelled out at five more sites in `lib/` — the hooks builder, the
      // rules-channel choice, two prime pointers and the PATCH validation —
      // each of them `silentPrimeDisposition(...) === 'on'` written by hand,
      // and every one would have kept the old rule the day the table grew a
      // second condition. Counted across the tree, the way the launch-mode
      // guard already counts `disabled !== true`.
      assert.deepEqual(capabilityReads(path.join(__dirname, '..', 'lib'), 'supportsSilentPrime'),
        ['lib/engines.js'], 'one file may read it');
      const table = declarationSource(SRC, 'const ENGINE_CONDITIONAL_SETTINGS = {');
      for (const line of codeLinesMentioning(SRC, 'supportsSilentPrime')) {
        assert.ok(table.includes(line),
          `a read outside ENGINE_CONDITIONAL_SETTINGS is a second implementation: ${line}`);
      }
    });

    it('no browser file reads it outside the restated table', () => {
      assert.deepEqual(capabilityReads(path.join(__dirname, '..', 'public'), 'supportsSilentPrime'),
        ['public/api-helper.js'], 'the modal and the wizard ask the owner, they do not read the flag');
      const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
      const fn = declarationSource(helperSrc, 'function tcSettingDisposition(');
      for (const line of codeLinesMentioning(helperSrc, 'supportsSilentPrime')) {
        assert.ok(fn.includes(line), `a read outside tcSettingDisposition: ${line}`);
      }
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

    it('covers the same settings the server declares', () => {
      // Driven off the server's roster, not a list written here: a setting
      // added to `ENGINE_CONDITIONAL_SETTINGS` with no browser row falls into
      // the browser's unknown-key branch and renders "could not determine" on a
      // control the server is happy to gate — silent, and invisible to a
      // fixture that enumerates today's keys.
      const declared = Object.keys(engines.ENGINE_CONDITIONAL_SETTINGS);
      assert.ok(declared.length > 0, 'an empty roster compares nothing');
      assert.deepEqual(Object.keys(ctx.tcSettingDefaults).sort(), declared.slice().sort(),
        'the browser must carry a shipped default for every setting the server gates');
      for (const setting of declared) {
        const d = ctx.tcSettingDisposition(setting, { [setting]: PROBES[setting].inapplicable },
          { id: 'barebones', name: 'Barebones', capabilities: {}, launchModes: {} });
        assert.doesNotMatch(String(d.reason), /could not determine/,
          `the browser has no branch for "${setting}"`);
      }
    });

    it('every declared setting produces words and a profile fact when it does not apply', () => {
      // The roster is the fixture: a row added with a missing or empty reason
      // renders a disabled control explaining nothing, which is the shape
      // ADR 0013 forbids.
      const barebones = { id: 'barebones', name: 'Barebones', capabilities: {}, launchModes: {} };
      assert.deepEqual(Object.keys(PROBES).sort(),
        Object.keys(engines.ENGINE_CONDITIONAL_SETTINGS).sort(),
        'every gated setting needs a value that cannot apply, or it goes untested here');
      for (const setting of Object.keys(engines.ENGINE_CONDITIONAL_SETTINGS)) {
        const d = engines.settingDisposition(setting, { [setting]: PROBES[setting].inapplicable }, barebones);
        assert.equal(d.applies, false, `${setting} must not apply on a profile declaring nothing`);
        assert.ok(d.reason && d.reason.length > 0, `${setting} owes the operator a reason`);
        assert.match(d.reason, /Barebones/, `${setting}'s reason must name the engine`);
        assert.ok(d.evidence && d.evidence.length > 0, `${setting} owes the log a profile fact`);
      }
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
        { id: 'barebones', name: 'Barebones', capabilities: {}, launchModes: {} },
        { id: 'hollow', name: 'Hollow', capabilities: {}, launchModes: { default: { label: 'Interactive' }, plan: null } }
      ]);

      // Probe values per setting, checked against the server's roster so a
      // setting added there without probes fails here rather than going
      // uncompared.
      assert.deepEqual(Object.keys(PROBES).sort(),
        Object.keys(engines.ENGINE_CONDITIONAL_SETTINGS).sort(),
        'every gated setting needs probe values, or the parity loop skips it');

      const cases = [];
      for (const [setting, values] of Object.entries(PROBES)) {
        for (const value of new Set([values.shipped, values.chosen, values.inapplicable, ...values.extras])) {
          cases.push([setting, { [setting]: value }]);
        }
        cases.push([setting, {}]);  // absent: the shipped-default path
      }

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
