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
const os = require('node:os');
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
 * Every bundled profile as the BROWSER receives it.
 *
 * The server reads whole profiles off disk; `public/` only ever sees what
 * `engineClientPayload` projects, and a predicate reading a field the
 * projection drops answers for every engine as though the capability were
 * absent — silently, and identically to a correct answer about an engine that
 * genuinely lacks it. Comparing the two realms over raw profiles cannot see
 * that: both sides get a field production never sends, and agree.
 *
 * So the browser side is driven through the real producer. A field added to a
 * predicate in `public/` and not to the projection fails here rather than in
 * the modal.
 *
 * @returns {object[]}
 */
function clientProfiles() {
  return bundledProfiles().map((p) => engines.engineClientPayload(p, { available: true }));
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
  evalAuditMode: {
    shipped: false, chosen: true, inapplicable: true, extras: [],
    // The flag lives inside an object of tunables. Without this the fixture
    // would hand both realms `{ evalAuditMode: true }`, whose `.enabled` is
    // undefined on either side — the two would agree perfectly about a shape
    // the product never stores, and the case would assert nothing.
    wrap: (value) => ({ evalAuditMode: { enabled: value } })
  },
  defaultLaunchMode: {
    shipped: 'default', chosen: 'plan', inapplicable: 'plan',
    // A mode claude declares and codex does not, and one no profile declares.
    extras: ['bypassPermissions', 'nosuchmode']
  },
  // No `inapplicable`: these two are never gated outright. Their engine
  // conditionality is a caveat, and the fixtures that reach both of ITS
  // outcomes are the silent-prime states crossed in below.
  featureIndexEnabled: { shipped: false, chosen: true, extras: [] },
  projectMapEnabled: { shipped: false, chosen: true, extras: [] },
  generatedConfig: {
    shipped: false, chosen: true, inapplicable: true, extras: [],
    // The row's value is DERIVED — whether the operator moved any extension
    // rule off what ships — so the fixture has to store a rules block rather
    // than a `generatedConfig` key the product never writes. `independentCritic`
    // ships false, which is why storing `true` is the customized case and
    // storing `false` is the stock one.
    wrap: (value) => ({ rules: { extensions: { independentCritic: value } } })
  },
  // Off is what ships — a wake spends a real turn — so a stored `true` is the
  // operator's choice, and it cannot apply on an engine declaring no signature.
  medusaWake: { shipped: false, chosen: true, inapplicable: true, extras: [] }
};

// The silent-prime states every case is crossed with. A caveat row's answer
// turns on the project's own `silentPrime` as well as the engine's capability,
// and a fixture set that never varied it would compare the two realms only on
// the half of the condition the engine decides — the operator's own switch,
// the one leg they control, would go uncompared. Harmless for the gated rows:
// `configWith` is spread last, so a case about `silentPrime` itself keeps its
// own value.
const SILENT_PRIME_STATES = [{}, { silentPrime: true }, { silentPrime: false }];

/**
 * The settings gated outright — the rows declaring `applies`, whose answer is
 * a live control or an inert one with a reason.
 * @returns {string[]}
 */
function gatedSettings() {
  return Object.entries(engines.ENGINE_CONDITIONAL_SETTINGS)
    .filter(([, spec]) => typeof spec.applies === 'function').map(([key]) => key);
}

/**
 * The settings that always take effect but may do so only in part — the rows
 * declaring `caveat`.
 * @returns {string[]}
 */
function caveatSettings() {
  return Object.entries(engines.ENGINE_CONDITIONAL_SETTINGS)
    .filter(([, spec]) => typeof spec.caveat === 'function').map(([key]) => key);
}

/**
 * The project config that stores `value` for `setting`, in the shape the
 * product actually writes.
 * @param {string} setting - Setting key.
 * @param {*} value - Value to store.
 * @returns {object}
 */
function configWith(setting, value) {
  const spec = PROBES[setting];
  return spec && spec.wrap ? spec.wrap(value) : { [setting]: value };
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

  it('refuses a row that declares neither a gate nor a caveat', () => {
    // The mechanism's central invariant, and the one nothing else catches: a
    // row with no `applies` is read as "not gated" and one with no `caveat` as
    // "nothing to say", so a row declaring neither — or one that misspells
    // `caveat` — answers `{applies: true, caveat: null}` and ships the exact
    // silence ADR 0013 exists to end. Both roster helpers skip such a row, and
    // the parity test only catches a one-sided typo. The roster grows (D2 adds
    // #1251 and #1255), so this is checked over the table rather than trusted
    // to the docblock that states it.
    for (const [setting, spec] of Object.entries(engines.ENGINE_CONDITIONAL_SETTINGS)) {
      const declared = ['applies', 'caveat'].filter((k) => typeof spec[k] === 'function');
      // Exactly one, matching what both the docblock and the engine guide say.
      // Neither is the silence above. BOTH is a row the browser mirror cannot
      // represent — membership in `TC_SETTING_CAVEAT_FILES` answers before any
      // gate runs — so the server would gate it and the browser would not.
      assert.deepEqual(declared.length, 1,
        `${setting} declares ${JSON.stringify(declared)} — a row declares an applies gate `
        + 'OR a caveat: neither is a control that says nothing, and both is a shape the '
        + 'browser mirror cannot answer until TC_SETTING_CAVEAT_FILES carries caveat functions');
      if (typeof spec.applies === 'function') {
        assert.equal(typeof spec.reason, 'function', `${setting} gates without a reason to render`);
        assert.equal(typeof spec.evidence, 'function', `${setting} gates without a profile fact`);
      }
    }
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

  describe('resolveProfile is how a caller gets the engine it is asking about', () => {
    it('answers for a connection-backed id, which store.engines.get does not', () => {
      // Three sites resolved engines three ways — `store.engines.get` (null for
      // a connection-backed project), a synthesized `{ id }` stub (no name, no
      // capabilities), and this. The same project was then refused by the API
      // in different words from the ones the modal renders.
      // No store needed for these: a non-id can never name a profile, and the
      // point is that the answer is null rather than a fabricated stub.
      assert.equal(engines.resolveProfile(''), null);
      assert.equal(engines.resolveProfile(null), null);
      assert.equal(engines.resolveProfile(undefined), null);
      assert.equal(engines.resolveProfile(42), null);
    });

    it('carries the connection\'s display name into the sentence the operator reads', () => {
      // A synthesized `{ id }` has no `name`, so the API said "claude does not
      // feed Eval Audit" where the modal says "Claude Code does not feed".
      const named = { id: 'openclaw:c1', name: 'Studio (OpenClaw)', capabilities: {} };
      const d = engines.settingDisposition('silentPrime', { silentPrime: true }, named);
      assert.match(d.reason, /Studio \(OpenClaw\)/,
        'the reason names the engine the way every other surface names it');
      assert.doesNotMatch(d.reason, /openclaw:c1/, 'not the raw id');
    });

    it('a plain profile keeps its own display name', () => {
      // From the BUNDLED profile, not `resolveProfile('claude')`: that reads
      // the engine store this machine happens to have installed, so the
      // assertion passed on a dev Mac and failed on CI, where no install
      // exists and the id resolves to nothing. A test whose verdict depends on
      // host plumbing is the recurring red-on-CI shape in this repo.
      const claude = bundledProfiles().find((p2) => p2.id === 'claude');
      assert.ok(claude, 'the bundled claude profile must exist');
      const d = engines.settingDisposition('evalAuditMode', {}, claude);
      assert.equal(claude.name, 'Claude Code', 'the fixture carries the name being asserted');
      assert.match(d.reason, /Claude Code/, 'the profile name, not the id');
      assert.doesNotMatch(d.reason, /^claude /);
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

  describe('the third state — a setting that takes effect only in part (#1252)', () => {
    // The two index toggles seed and maintain a file on every engine, then
    // point a session at it through the hidden prime, which four of five
    // engines cannot deliver. `applies: false` would be false, and
    // `applies: true` in silence is what ADR 0013 forbids.
    const claudeOn = { id: 'claude', name: 'Claude Code', capabilities: { supportsSilentPrime: true } };
    const INDEX_FILES = { featureIndexEnabled: 'FEATURES.md', projectMapEnabled: 'PROJECT-MAP.md' };

    it('says nothing when the whole setting takes effect', () => {
      for (const setting of caveatSettings()) {
        const d = engines.settingDisposition(setting, { [setting]: true, silentPrime: true }, claudeOn);
        assert.equal(d.applies, true);
        assert.equal(d.caveat, null, `${setting} loses nothing here, so there is nothing to say`);
        assert.equal(d.reason, null, 'a caveat row is never inert');
        assert.equal(d.level, null, 'and owes no log line either');
      }
    });

    it('names the half that does not run on an engine that delivers no hidden prime', () => {
      for (const setting of caveatSettings()) {
        const d = engines.settingDisposition(setting, { [setting]: true, silentPrime: true }, notSupporting);
        assert.equal(d.applies, true, 'the wrap half runs on every engine — the control stays live');
        assert.ok(d.caveat, `${setting} owes the operator the half it loses`);
        assert.match(d.caveat, /Codex/, 'the caveat names the engine as the operator knows it');
        assert.ok(d.caveat.includes(INDEX_FILES[setting]),
          `${setting}'s caveat must name the file it still maintains`);
        assert.doesNotMatch(d.caveat, /capabilities\./, 'not a field path');
      }
    });

    it('names the operator\'s own switch when that is the leg that fails', () => {
      // The gate is a triple. On Claude with silent prime off the pointer is
      // lost too — the same loss, from the one leg the operator controls, and
      // undocumented until now.
      for (const setting of caveatSettings()) {
        const d = engines.settingDisposition(setting, { [setting]: true, silentPrime: false }, claudeOn);
        assert.equal(d.applies, true);
        assert.ok(d.caveat, `${setting} loses the pointer here too`);
        assert.match(d.caveat, /silent prime is off/,
          'the sentence must point at the switch, not at the engine that could honor it');
        assert.doesNotMatch(d.caveat, /Claude Code/,
          'blaming a capable engine would send the operator looking in the wrong place');
      }
    });

    it('reads the same as the whole setting being on when the toggle is off', () => {
      // The caveat describes what the setting DOES on this engine, not what
      // this project currently stores — the operator deciding whether to turn
      // it on is the one who most needs to read it.
      for (const setting of caveatSettings()) {
        const on = engines.settingDisposition(setting, { [setting]: true, silentPrime: true }, notSupporting);
        const off = engines.settingDisposition(setting, { [setting]: false, silentPrime: true }, notSupporting);
        assert.equal(off.caveat, on.caveat);
      }
    });

    it('does not claim a capability fact about an engine no profile was read for', () => {
      for (const setting of caveatSettings()) {
        const d = engines.settingDisposition(setting, { [setting]: true, silentPrime: true }, null);
        assert.equal(d.applies, true,
          'the wrap half runs regardless, so "cannot say" must not read as "does nothing"');
        assert.match(d.caveat, /cannot say/);
        assert.doesNotMatch(d.caveat, /no hidden prime/, 'nothing was read to support that');
      }
    });

    it('derives the level from provenance, exactly like a reason does', () => {
      // `featureIndexEnabled` ships false, so a stored true is intent the
      // operator expressed and is only half being honored.
      for (const setting of caveatSettings()) {
        assert.equal(DEFAULT_PROJECT_CONFIG[setting], false,
          `if ${setting}'s shipped default changes, this case is no longer the one described`);
        assert.equal(engines.settingDisposition(setting, { [setting]: true }, notSupporting).level, 'warn');
        assert.equal(engines.settingDisposition(setting, { [setting]: false }, notSupporting).level, 'info');
      }
    });

    it('fires on exactly the predicate the prime pointer is gated on', () => {
      // The caveat is a statement about a block in `sessions.js`. Asked a
      // different way it would report a loss the launch path does not have, or
      // stay quiet through one it does — so the row delegates rather than
      // restating the triple, and the pointer keeps gating on the same call.
      const SESSIONS = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sessions.js'), 'utf8');
      for (const toggle of ['featureIndexEnabled', 'projectMapEnabled']) {
        assert.match(SESSIONS, new RegExp(
          `projConfig\\.${toggle} === true\\s*\\n\\s*&& engines\\.silentPrimeDisposition\\(projConfig, engineProfile\\) === 'on'`),
        `the ${toggle} pointer must gate on the disposition the caveat speaks for`);
      }
      const helper = declarationSource(
        fs.readFileSync(path.join(__dirname, '..', 'lib', 'engines.js'), 'utf8'),
        'function _indexPointerCaveat(');
      assert.match(helper, /silentPrimeDisposition\(projConfig, engineProfile\)/,
        'the caveat asks the same predicate the pointer is gated on');
      assert.doesNotMatch(helper, /supportsSilentPrime/, 'and does not restate it');
      // Driven end to end rather than by source match: for every bundled
      // profile and both silent-prime states, a caveat must appear exactly
      // when the pointer would be skipped.
      for (const profile of bundledProfiles()) {
        for (const silentPrime of [true, false]) {
          const projConfig = { featureIndexEnabled: true, silentPrime };
          const pointerEmitted = engines.silentPrimeDisposition(projConfig, profile) === 'on';
          const d = engines.settingDisposition('featureIndexEnabled', projConfig, profile);
          assert.equal(d.caveat === null, pointerEmitted,
            `${profile.id}/silentPrime=${silentPrime}: caveat and pointer must not disagree`);
        }
      }
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
      // `server.js` sits at the repo root, outside both trees the walk covers,
      // and it is a plausible home for a sixth gate — so it is named rather
      // than left to a directory walk that would never reach it.
      const root = path.join(__dirname, '..');
      const serverReads = codeLinesMentioning(
        fs.readFileSync(path.join(root, 'server.js'), 'utf8'), 'supportsSilentPrime');
      assert.deepEqual(serverReads, [], 'the route layer asks the owner, it does not read the flag');
      assert.deepEqual(capabilityReads(path.join(root, 'lib'), 'supportsSilentPrime'),
        ['lib/engines.js'], 'one file may read it');
      // Two permitted homes, and only one of them can hold a gate. The second
      // is `READ_CAPABILITIES`, which NAMES this flag as a key to record that
      // the product acts on it (#1254) — a listing, not a read. That home is
      // safe because its own guard pins every value to a string, so no
      // predicate can hide there; the property this case defends is unchanged.
      const homes = [
        declarationSource(SRC, 'const ENGINE_CONDITIONAL_SETTINGS = {'),
        declarationSource(SRC, 'const READ_CAPABILITIES = {')
      ];
      for (const line of codeLinesMentioning(SRC, 'supportsSilentPrime')) {
        assert.ok(homes.some((home) => home.includes(line)),
          `a read outside ENGINE_CONDITIONAL_SETTINGS is a second implementation: ${line}`);
      }
    });

    it('no file reads the Eval Audit flag to decide whether the feature is live', () => {
      // The same class, for the second gated setting. `evalAuditMode.enabled`
      // is read in plenty of places to configure scoring; what must not recur
      // is a reader deciding the feature is LIVE from the bare flag, because a
      // project can hold a stored `true` on an engine no exchange can reach.
      // The readers that answer that question are named here, and a new one has
      // to be added deliberately.
      const root = path.join(__dirname, '..');
      const liveReaders = [
        ['lib/projects.js', /auditFits && auditCfg\.enabled === true/],
        ['lib/sessions.js', /settingDisposition\('evalAuditMode', projConfig, engineProfile\)\.applies/]
      ];
      for (const [file, pattern] of liveReaders) {
        assert.match(fs.readFileSync(path.join(root, file), 'utf8'), pattern,
          `${file} must ask the gate, not the bare flag`);
      }
      // And the browser must not re-derive it: every surface reads the value
      // `enrichProject` already gated.
      for (const file of ['public/ui.js', 'public/landing.js']) {
        const bare = codeLinesMentioning(fs.readFileSync(path.join(root, file), 'utf8'), 'evalAuditMode');
        for (const line of bare) {
          assert.ok(/tcSettingDisposition|body\.evalAuditMode/.test(line),
            `${file} decides liveness from the stored flag: ${line}`);
        }
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
        // Against the ROW's own `shippedDefault()`, not `DEFAULT_PROJECT_CONFIG[key]`:
        // a row may gate on a scalar nested inside an object of tunables, and
        // comparing the object would compare the wrong thing (and always pass,
        // since neither side is the other).
        assert.equal(value, engines.ENGINE_CONDITIONAL_SETTINGS[key].shippedDefault(),
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
        const d = ctx.tcSettingDisposition(setting, configWith(setting, PROBES[setting].chosen),
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
      assert.ok(gatedSettings().length > 0, 'an empty roster proves nothing');
      for (const setting of gatedSettings()) {
        assert.notEqual(PROBES[setting].inapplicable, undefined,
          `${setting} is gated outright, so it needs a value that cannot apply`);
        const d = engines.settingDisposition(setting, configWith(setting, PROBES[setting].inapplicable), barebones);
        assert.equal(d.applies, false, `${setting} must not apply on a profile declaring nothing`);
        assert.ok(d.reason && d.reason.length > 0, `${setting} owes the operator a reason`);
        assert.match(d.reason, /Barebones/, `${setting}'s reason must name the engine`);
        assert.ok(d.evidence && d.evidence.length > 0, `${setting} owes the log a profile fact`);
      }
    });

    it('agrees field for field over every bundled profile and every gated setting', () => {
      // Projected, not raw: this loop is the one place the two realms are held
      // to the same sentence, and feeding the browser a profile richer than
      // production ever sends it is how a row keyed on an unprojected field
      // passes here and answers for every engine in the modal.
      const profiles = clientProfiles();
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
        { id: 'hollow', name: 'Hollow', capabilities: {}, launchModes: { default: { label: 'Interactive' }, plan: null } },
        // A connection-backed OpenClaw id. `state.engines` never carries one
        // and no bundled profile has one, so without this fixture the whole
        // evalAuditMode row would only ever be compared on `applies: false` —
        // the two realms agreeing about the case that needs no gate.
        { id: 'openclaw:conn-1', name: 'Studio (OpenClaw)', capabilities: {}, launchModes: {} },
        // Profiles whose NAME is unusable. Every reason string starts with the
        // engine's display name, and the two realms compute that separately —
        // `engines.engineDisplayName` here, `tcEngineDisplayName` there — with
        // the server's copy taking RAW profiles, where the case is live. Every
        // bundled profile carries a good name, so without these two the loop
        // compares that half of the sentence only where any two spellings
        // agree, and a `||` on one side would go unnoticed (#736).
        { id: 'homegrown', capabilities: {}, launchModes: {} },
        { id: 'homegrown', name: 42, capabilities: {}, launchModes: {} },
        // No profile at all. Both realms hand-write a sentence for this case
        // and nothing compared them: the browser reaches it whenever the
        // settings dropdown names an engine that is neither in `state.engines`
        // nor the project's own — a retired engine id, or a project with none.
        // Uncompared, an edit to one realm's wording leaves the other stale and
        // the suite stays green, which is the failure this whole loop exists
        // to prevent.
        null
      ]);

      // Probe values per setting, checked against the server's roster so a
      // setting added there without probes fails here rather than going
      // uncompared.
      assert.deepEqual(Object.keys(PROBES).sort(),
        Object.keys(engines.ENGINE_CONDITIONAL_SETTINGS).sort(),
        'every gated setting needs probe values, or the parity loop skips it');

      const cases = [];
      for (const [setting, values] of Object.entries(PROBES)) {
        const stored = new Set([values.shipped, values.chosen, ...values.extras]);
        if (values.inapplicable !== undefined) stored.add(values.inapplicable);
        for (const ambient of SILENT_PRIME_STATES) {
          for (const value of stored) {
            cases.push([setting, { ...ambient, ...configWith(setting, value) }]);
          }
          cases.push([setting, { ...ambient }]);  // absent: the shipped-default path
        }
      }

      let compared = 0;
      for (const profile of fixtures) {
        for (const [setting, projConfig] of cases) {
          const server = engines.settingDisposition(setting, projConfig, profile);
          const browser = ctx.tcSettingDisposition(setting, projConfig, profile);
          // Compared field by field rather than deep-equal: the browser object
          // is built in a vm realm, so `deepStrictEqual` reports two identical
          // objects as unequal on their prototypes.
          for (const field of ['setting', 'value', 'applies', 'chosen', 'reason', 'evidence', 'caveat', 'level']) {
            assert.equal(browser[field], server[field],
              `${profile ? profile.id : 'no-profile'}/${setting}=${JSON.stringify(projConfig[setting])}: `
              + `${field} must match the server (browser ${JSON.stringify(browser[field])}, `
              + `server ${JSON.stringify(server[field])})`);
          }
          compared++;
        }
      }
      assert.ok(compared >= fixtures.length * cases.length, 'the loop must have run');
      // Every setting must have been compared on BOTH of its outcomes. A loop
      // where one row only ever answers one way proves the two realms agree
      // about the case that needs no gate. Which two outcomes depends on which
      // question the row answers: a gated row swings on `applies`, a caveat row
      // is always applied and swings on whether it says something.
      for (const setting of gatedSettings()) {
        const verdicts = new Set();
        for (const profile of fixtures) {
          for (const [s2, cfg] of cases) {
            if (s2 === setting) verdicts.add(engines.settingDisposition(s2, cfg, profile).applies);
          }
        }
        assert.deepEqual([...verdicts].sort(), [false, true],
          `${setting} was only ever compared on one verdict — the fixtures cannot reach the other`);
      }
      assert.ok(caveatSettings().length > 0, 'an empty caveat roster compares nothing');
      for (const setting of caveatSettings()) {
        const spoken = new Set();
        for (const profile of fixtures) {
          for (const [s2, cfg] of cases) {
            if (s2 !== setting) continue;
            const d = engines.settingDisposition(s2, cfg, profile);
            assert.equal(d.applies, true, `${setting} is not gated outright and must always apply`);
            spoken.add(d.caveat !== null);
          }
        }
        assert.deepEqual([...spoken].sort(), [false, true],
          `${setting} was only ever compared with the caveat one way — the fixtures cannot reach the other`);
      }
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

describe('an engine with no config file says what it cannot carry (#1251)', () => {
  const ctx = loadApiHelperGlobals();
  const logger = require('../lib/logger');

  /** @returns {object} The bundled OpenClaw profile — the one engine with no carrier. */
  function openclaw() {
    return bundledProfiles().find((p) => p.id === 'openclaw');
  }

  it('does not apply on the one bundled engine that has no config file', () => {
    const d = engines.settingDisposition('generatedConfig', {}, openclaw());
    assert.equal(d.applies, false);
    assert.equal(d.evidence, 'configFormat.filename is null');
    assert.match(d.reason, /OpenClaw has no config file/);
    assert.match(d.reason, /rule settings and TangleClaw guides it would carry/,
      'the sentence must name what is lost, and scope it to what that file carries — '
      + 'the modal has a separate Project Rules section this row has not checked');
  });

  it('applies on every bundled engine that does have one', () => {
    // The failure this catches is the opposite of the defect: a gate keyed on
    // the wrong field would ship a "your rules are not delivered" notice on the
    // four engines where they are, to fix the one where they are not.
    const withCarrier = bundledProfiles()
      .filter((p) => p.configFormat && p.configFormat.filename);
    assert.ok(withCarrier.length >= 3, 'the bundled set must contain engines with a carrier');
    for (const profile of withCarrier) {
      const d = engines.settingDisposition('generatedConfig', {}, profile);
      assert.equal(d.applies, true, `${profile.id} carries ${profile.configFormat.filename}`);
      assert.equal(d.reason, null, `${profile.id} has nothing to tell the operator`);
      assert.equal(d.caveat, null);
    }
  });

  it('reads the engine-specific half of the sentence off the profile', () => {
    // The whole point of declaring it there: a sixth engine with no config file
    // states its own case in its own file. A profile that declares nothing
    // still gets a complete sentence naming the engine — the fallback must not
    // be a dangling clause.
    const declared = engines.settingDisposition('generatedConfig', {}, openclaw());
    assert.ok(openclaw().configFormat.absentReason,
      'the fixture engine must declare the reason this test says is read');
    assert.ok(declared.reason.endsWith(openclaw().configFormat.absentReason),
      'the declared sentence must reach the operator verbatim');

    const bare = engines.settingDisposition('generatedConfig', {},
      { id: 'bare', name: 'Bare', configFormat: { filename: null } });
    assert.match(bare.reason, /^Bare has no config file/);
    assert.ok(bare.reason.endsWith('.'), 'a profile declaring no reason still ends its sentence');
  });

  it('neither realm carries a copy of the declared sentence', () => {
    // This is what makes cross-realm parity structural rather than a promise:
    // the words exist once, in the profile, and both realms read them. A copy
    // pasted into either file would pass the parity loop and drift the moment
    // the profile changed.
    const declared = openclaw().configFormat.absentReason;
    // Asserted, not assumed: an absent field would make every `includes` below
    // search for the string "undefined" and fail for a reason that has nothing
    // to do with a pasted copy.
    assert.equal(typeof declared, 'string', 'the fixture engine must declare a sentence');
    for (const rel of [['lib', 'engines.js'], ['public', 'api-helper.js'], ['public', 'ui.js']]) {
      const src = fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');
      assert.ok(!src.includes(declared),
        `${rel.join('/')} restates the profile's own sentence instead of rendering it`);
    }
  });

  describe('provenance — losing rules the operator chose is not losing the stock set', () => {
    it('a customized rules block warns', () => {
      const d = engines.settingDisposition('generatedConfig',
        { rules: { extensions: { ...DEFAULT_PROJECT_CONFIG.rules.extensions, independentCritic: true } } },
        openclaw());
      assert.equal(d.chosen, true);
      assert.equal(d.level, 'warn');
    });

    it('the stock rules block records at info', () => {
      assert.equal(DEFAULT_PROJECT_CONFIG.rules.extensions.independentCritic, false,
        'if the shipped default changes, this case is no longer the one described');
      const d = engines.settingDisposition('generatedConfig',
        { rules: { extensions: { ...DEFAULT_PROJECT_CONFIG.rules.extensions } } }, openclaw());
      assert.equal(d.chosen, false);
      assert.equal(d.level, 'info');
    });

    it('core rules are not consulted — they cannot be a choice', () => {
      // `updateProject` refuses to disable a core rule, so counting core would
      // report a project as customized for a value nobody could have set.
      const d = engines.settingDisposition('generatedConfig',
        { rules: { core: { changelogPerChange: false }, extensions: {} } }, openclaw());
      assert.equal(d.chosen, false);
    });

    it('a rule key the product does not ship counts as customized', () => {
      const d = engines.settingDisposition('generatedConfig',
        { rules: { extensions: { somethingOnlyAnOperatorWrote: true } } }, openclaw());
      assert.equal(d.chosen, true);
    });

    it('the browser restates the shipped extension rules it compares against', () => {
      // The browser cannot require `lib/project-config.js`. A default that
      // changes on one side only reclassifies a real choice as a default.
      assert.deepEqual({ ...ctx.tcSettingRuleDefaults },
        { ...DEFAULT_PROJECT_CONFIG.rules.extensions });
    });
  });

  describe('the skip reaches the log at the level the disposition derives', () => {
    /**
     * Run `fn` with the logger capturing info-and-above into an array.
     * @param {() => void} fn - Work to run while capturing.
     * @returns {string[]} Captured lines.
     */
    function captureLog(fn) {
      const lines = [];
      const level = logger.getLevel();
      logger.setLevel('info');
      logger.setConsoleStream({ write: (s) => lines.push(s) });
      try {
        fn();
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel(level);
      }
      return lines;
    }

    const skipped = {
      written: false,
      skipped: true,
      skipReason: 'engine has no config file (configFormat.filename is null)'
    };

    it('records the missing carrier, naming what was lost', () => {
      const lines = captureLog(() => {
        engines.reportMissingConfigCarrier(skipped, {}, openclaw(), { at: 'launch' });
      });
      assert.equal(lines.length, 1, 'exactly one line per skipped write');
      assert.match(lines[0], /OpenClaw has no config file/);
      assert.match(lines[0], /configFormat\.filename is null/, 'the profile fact goes to the log');
    });

    it('warns for a project whose rules were a real choice, records for one whose were not', () => {
      const chosen = { rules: { extensions: { independentCritic: true } } };
      const warned = captureLog(() => {
        engines.reportMissingConfigCarrier(skipped, chosen, openclaw(), {});
      });
      const noted = captureLog(() => {
        engines.reportMissingConfigCarrier(skipped, {}, openclaw(), {});
      });
      assert.match(warned[0], /WARN/i);
      assert.doesNotMatch(noted[0], /WARN/i);
    });

    it('says nothing about a write that succeeded, or a skip for another reason', () => {
      const lines = captureLog(() => {
        assert.equal(engines.reportMissingConfigCarrier(
          { written: true, skipped: false, skipReason: null }, {}, openclaw(), {}), false);
        // A governed project deferring to its plugin skips on an engine that
        // HAS a carrier. Reporting that as a missing carrier would be a false
        // statement about the engine.
        assert.equal(engines.reportMissingConfigCarrier(
          { written: false, skipped: true, skipReason: 'project governed by the Prawduct V2 plugin' },
          {}, bundledProfiles().find((p) => p.id === 'claude'), {}), false);
      });
      assert.deepEqual(lines, []);
    });

    it('a real writeEngineConfig on a carrier-less engine emits the line', () => {
      // The guard below is structural — it reads source. This one runs the
      // writer, because "the report is wired into the skip branch" and "the
      // skip branch emits" are different claims, and only the second is the one
      // an operator depends on.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-carrier-'));
      try {
        const lines = captureLog(() => {
          const result = engines.writeEngineConfig('openclaw', dir, {}, openclaw());
          assert.equal(result.skipped, true, 'the fixture must reach the skip branch');
        });
        assert.equal(lines.length, 1, 'the writer emits exactly one line for the missing carrier');
        assert.match(lines[0], /OpenClaw has no config file/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a writeEngineConfig that succeeds emits no such line', () => {
      // The other half: `claude` has a carrier, so the same call must stay
      // quiet. Without this the test above passes on a writer that reports
      // unconditionally.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-carrier-ok-'));
      try {
        const claude = bundledProfiles().find((p) => p.id === 'claude');
        const lines = captureLog(() => {
          engines.writeEngineConfig('claude', dir, DEFAULT_PROJECT_CONFIG, claude);
        });
        assert.deepEqual(lines.filter((l) => l.includes('has no config file')), []);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the writer reports its own skip, so no call site has to remember', () => {
      // The first version of this paired a report with each call site and
      // checked the pairing over a hardcoded two-file list — which holds until
      // a fifth writer appears somewhere the list does not look, and then
      // reintroduces #1251 with the guard green. The obligation is discharged
      // inside `writeEngineConfig` instead, so there is nothing left to pair.
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engines.js'), 'utf8');
      assert.match(declarationSource(src, 'function writeEngineConfig'),
        /reportMissingConfigCarrier\(/,
        'the writer must report the missing carrier itself');
      // And nothing outside that module calls it, which would double the line
      // and put the obligation back on the caller.
      const callers = capabilityReads(path.join(__dirname, '..', 'lib'), 'reportMissingConfigCarrier');
      assert.deepEqual(callers, ['lib/engines.js'],
        'only the writer reports; a caller doing it too is the pattern this replaced');
    });
  });

  it('the settings modal renders the reason where the engine is chosen', () => {
    const UI = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    const src = declarationSource(UI, 'function renderGeneratedConfigNotice');
    assert.match(src, /tcSettingDisposition\('generatedConfig'/);
    assert.match(src, /esc\(disposition\.reason\)/, 'the rendered words are the predicate\'s');
    assert.doesNotMatch(src, /configFormat/, 'no second carrier gate in the modal');
    // Re-rendered against the dropdown, not only the saved engine: the operator
    // needs to read it while choosing, not after a launch that dropped the lot.
    assert.match(UI, /renderGeneratedConfigNotice\(e\.target\.value/);
  });
});

describe('the wake nudge says where it cannot reach (#1255)', () => {
  const ctx = loadApiHelperGlobals();
  const vm = require('node:vm');
  const { makeDocument } = require('./_mini-dom');
  const UI = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  const API = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');

  /**
   * A bundled profile as the browser receives it.
   * @param {string} id - Engine id.
   * @returns {object}
   */
  const client = (id) => engines.engineClientPayload(
    bundledProfiles().find((p) => p.id === id), { available: true });

  it('applies on exactly the engines whose profile declares a wake signature', () => {
    // Both directions, over the bundled roster: a gate keyed on the wrong field
    // would either kill the setting on the two engines where it works or offer
    // it on the three where a nudge would be typed against a guessed signature.
    const nudgeable = [];
    for (const profile of bundledProfiles()) {
      const d = engines.settingDisposition('medusaWake', { medusaWake: true }, profile);
      if (d.applies) {
        nudgeable.push(profile.id);
        assert.equal(d.reason, null, `${profile.id} has nothing to tell the operator`);
        assert.equal(d.caveat, null, `${profile.id}: the row is all-or-nothing by design`);
      } else {
        assert.match(d.reason, /has no measured idle signature/, `${profile.id} owes a reason`);
        assert.equal(d.evidence, 'capabilities.wake is not declared, or is declared malformed');
      }
    }
    assert.deepEqual(nudgeable.sort(), ['antigravity', 'claude'],
      'the modal must agree with the monitor about which engines can be nudged');
  });

  it('answers from the profile the engines API already ships', () => {
    // The whole reason the wake data moved into the profiles: the browser can
    // only compute this if the projection carries it. A predicate reading a
    // field production never sends answers "no signature" for every engine —
    // indistinguishable from a correct answer about an engine that lacks it.
    for (const profile of bundledProfiles()) {
      const projected = engines.engineClientPayload(profile, { available: true });
      const server = engines.settingDisposition('medusaWake', { medusaWake: true }, profile);
      const browser = ctx.tcSettingDisposition('medusaWake', { medusaWake: true }, projected);
      assert.equal(browser.applies, server.applies, `${profile.id}: applies`);
      assert.equal(browser.reason, server.reason, `${profile.id}: reason`);
    }
    assert.ok(client('claude').capabilities.wake,
      'the browser must receive the wake block, or its predicate is answering about nothing');
    assert.equal(client('codex').capabilities.wake, undefined);
  });

  it('losing a wake the operator switched on warns; losing the default records', () => {
    const codex = bundledProfiles().find((p) => p.id === 'codex');
    const chosen = engines.settingDisposition('medusaWake', { medusaWake: true }, codex);
    assert.equal(chosen.chosen, true);
    assert.equal(chosen.level, 'warn');
    // A project that never set the key is on the shipped default — off — and
    // was never promised anything, so it records rather than alarms.
    const untouched = engines.settingDisposition('medusaWake', {}, codex);
    assert.equal(untouched.chosen, false);
    assert.equal(untouched.value, false);
    assert.equal(untouched.level, 'info');
  });

  it('the row is all-or-nothing, and the check that says so is recorded', () => {
    // ADR 0013 asks that a row be checked for PARTIAL application before an
    // `applies` gate is written (#1252's lesson). An unprofiled engine is
    // skipped by the monitor before every other gate, so there is no half that
    // runs — and the next reader's cheapest wrong move is assuming a caveat.
    const spec = engines.ENGINE_CONDITIONAL_SETTINGS.medusaWake;
    assert.equal(typeof spec.applies, 'function');
    assert.equal(spec.caveat, undefined);
    const src = declarationSource(fs.readFileSync(path.join(__dirname, '..', 'lib', 'engines.js'), 'utf8'),
      'const ENGINE_CONDITIONAL_SETTINGS');
    assert.match(src, /#1252/, 'the partial-application check is recorded at the table');
  });

  describe('the modal control', () => {
    /**
     * Run the shipped renderer against a mini-DOM and return the container's
     * HTML — the real function, lifted from source, not a copy.
     * @param {object} opts - `engineId`, `projectEngine`, `checked`, `engines`.
     * @returns {string}
     */
    function render(opts) {
      const { doc } = makeDocument(['settingsMedusaWakeContainer']);
      const vmCtx = {
        document: doc,
        state: { engines: opts.engines || [] },
        esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      };
      vm.createContext(vmCtx);
      const tables = API.match(/const TC_SETTING_\w+ = \{[\s\S]*?\n {2}\};/g) || [];
      assert.ok(tables.length >= 3, `expected the setting tables to lift, found ${tables.length}`);
      for (const table of tables) vm.runInContext(table, vmCtx);
      vm.runInContext(declarationSource(API, 'function tcHonoredLaunchModes'), vmCtx);
      vm.runInContext(declarationSource(API, 'function tcEngineDisplayName'), vmCtx);
      vm.runInContext(declarationSource(API, 'function tcSettingDisposition'), vmCtx);
      vm.runInContext(declarationSource(API, 'function tcResolveEngineProfile'), vmCtx);
      vm.runInContext(declarationSource(UI, 'function renderMedusaWakeToggle'), vmCtx);
      vmCtx.renderMedusaWakeToggle(opts.engineId, opts.checked === true, opts.projectEngine || null);
      return doc.getElementById('settingsMedusaWakeContainer').innerHTML;
    }

    it('stops claiming "Claude sessions only", which antigravity disproved in #560', () => {
      const agy = client('antigravity');
      const html = render({ engineId: 'antigravity', projectEngine: agy, engines: [agy], checked: true });
      assert.doesNotMatch(html, /Claude sessions only/);
      assert.match(html, /id="settingsMedusaWake"/, 'the control is live on a profiled engine');
      assert.match(html, /checked/, 'and carries the operator\'s state across an engine switch');
      // Nothing anywhere still says it. The string was the only operator-facing
      // sentence about this feature and it had been wrong since #560.
      assert.ok(!UI.includes('Claude sessions only'), 'ui.js still carries the stale claim');
      assert.ok(!API.includes('Claude sessions only'));
    });

    it('renders the reason, and no checkbox, on an engine with no signature', () => {
      const codex = client('codex');
      const html = render({ engineId: 'codex', projectEngine: codex, engines: [codex], checked: true });
      assert.match(html, /has no measured idle signature/);
      // The pin the plan asks for: no `#settingsMedusaWake` element at all, so
      // `doSaveSettings` attaches no value and cannot post a stale checkbox.
      assert.doesNotMatch(html, /id="settingsMedusaWake"/);
      assert.match(html, /id="settingsMedusaWakeNotApplicable"/);
      assert.match(html, /disabled/);
    });

    it('the save path reads only the live control', () => {
      const save = declarationSource(UI, 'async function doSaveSettings');
      assert.match(save, /getElementById\('settingsMedusaWake'\)/);
      assert.match(save, /if \(medusaWakeEl\)/,
        'the inert branch renders no such element, and the save must depend on that');
    });

    it('remembers the operator\'s tick across an engine that cannot be nudged', () => {
      // Same trap `silentPrimeNow` already closed one control over: the inert
      // branch renders `#settingsMedusaWakeNotApplicable`, so recovering the
      // state from the DOM loses it on the way through codex —
      // claude -> codex -> claude would drop a tick the operator had just made
      // and save the old value back. Pinned at the source because the carry
      // lives in `openSettings`'s closure, which cannot be lifted into a
      // sandbox the way a single render can; the live check is queued in
      // `.prawduct/operator-verification.md`.
      const open = UI.slice(UI.indexOf('function openSettings'));
      const body = open.slice(0, open.indexOf('\n}\n'));
      assert.match(body, /let medusaWakeNow = initialMedusaWakeChecked;/,
        'the state is held outside the DOM the inert branch replaces');
      assert.match(body, /if \(wakeEl\) medusaWakeNow = wakeEl\.checked;/,
        'a live control updates it; an inert one cannot have changed it');
      assert.doesNotMatch(body, /wakeEl \? wakeEl\.checked : initialMedusaWakeChecked/,
        'the initial value must not be the fallback — that is the drop');
    });

    it('re-renders against the dropdown, not only the saved engine', () => {
      // Switching to an engine that cannot be nudged costs the setting; the
      // operator must read that while deciding, not after a save.
      assert.match(UI, /renderMedusaWakeToggle\(e\.target\.value/);
      const src = declarationSource(UI, 'function renderMedusaWakeToggle');
      assert.match(src, /tcSettingDisposition\('medusaWake'/);
      assert.match(src, /esc\(disposition\.reason\)/, 'the rendered words are the predicate\'s');
      assert.doesNotMatch(src, /capabilities\.wake/, 'no second wake gate in the modal');
    });
  });
});

describe('what the browser is sent is what its predicates may read (#1251)', () => {
  const helpers = loadApiHelperGlobals();
  const vm = require('node:vm');
  const { makeDocument } = require('./_mini-dom');
  const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  const API_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');

  it('the carrier the gate reads survives the projection', () => {
    // The defect this closes: the browser gated on `configFormat.filename`, no
    // payload carried `configFormat`, and so the row answered "no config file"
    // for every engine — the notice firing on claude, codex, aider and
    // antigravity, and the declared sentence never appearing on the one engine
    // it was written for.
    const openclaw = engines.engineClientPayload(
      bundledProfiles().find((p) => p.id === 'openclaw'), { available: true });
    assert.ok(openclaw.configFormat, 'the browser must receive the carrier declaration');
    assert.equal(openclaw.configFormat.filename, null);
    assert.equal(typeof openclaw.configFormat.absentReason, 'string',
      'and the sentence declared beside it, which is the whole point of declaring it there');

    const claude = engines.engineClientPayload(
      bundledProfiles().find((p) => p.id === 'claude'), { available: true });
    assert.equal(claude.configFormat.filename, 'CLAUDE.md');
  });

  it('every engine the browser receives carries a usable name (#736)', () => {
    // The invariant that lets every render site read `engine.name` straight.
    // Only `id` is validated when a profile is saved and `get()` JSON-parses
    // whatever is on disk, so the unusable shapes below are reachable — and
    // `esc` renders a non-string as '', which is a blank, unidentifiable
    // control that nothing turns red for.
    for (const profile of bundledProfiles()) {
      const client = engines.engineClientPayload(profile, { available: true });
      assert.equal(typeof client.name, 'string');
      assert.ok(client.name.length > 0, `${profile.id} must reach the browser with a name`);
    }
    for (const bad of [undefined, '', 42, {}, null]) {
      const client = engines.engineClientPayload({ id: 'homegrown', name: bad }, { available: true });
      assert.equal(client.name, 'homegrown',
        `a ${JSON.stringify(bad)} name must fall back to the id, not reach a render site`);
    }
    // Normalised AFTER the overrides, so a connection-backed engine's
    // operator-authored label is covered too rather than bypassing the rule.
    const conn = engines.engineClientPayload({ id: 'openclaw', name: 'OpenClaw' },
      { id: 'openclaw:c1', name: 7, available: true });
    assert.equal(conn.name, 'openclaw:c1', 'the override is normalised, not trusted');

    // The id gets the SAME type test as the name. Falling back to an id that is
    // itself a number just moves the blank label one level down — nothing
    // validates a hand-dropped profile, so both halves are reachable.
    for (const badId of [42, {}, '', undefined]) {
      const client = engines.engineClientPayload({ id: badId, name: undefined }, { available: true });
      assert.equal(typeof client.name, 'string',
        `an id of ${JSON.stringify(badId)} must not become the name`);
      assert.ok(client.name.length > 0, 'the guarantee is total, or the render sites cannot rest on it');
    }
  });

  it('both realms answer the same for a client-shaped engine', () => {
    // The parity loop below runs over projected profiles now, but state this
    // directly too: it is the assertion whose absence let the bug ship.
    for (const profile of bundledProfiles()) {
      const client = engines.engineClientPayload(profile, { available: true });
      const server = engines.settingDisposition('generatedConfig', {}, profile);
      const browser = helpers.tcSettingDisposition('generatedConfig', {}, client);
      assert.equal(browser.applies, server.applies, `${profile.id}: applies`);
      assert.equal(browser.reason, server.reason, `${profile.id}: reason`);
    }
  });

  it('every engine the client receives comes from the one projection', () => {
    // `listWithAvailability` drops `pickerHidden` profiles, so OpenClaw — the
    // engine this row exists for — reaches the modal ONLY through the
    // per-project payload. Two hand-built shapes is how one of them stayed
    // thinner than the other without anybody noticing.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'projects.js'), 'utf8');
    // Scoped to the function that builds the payload, so an unrelated local
    // named `engine` elsewhere in the module does not fire this, and so a third
    // legitimate projection does not either — what must not come back is a
    // hand-built literal assigned to the engine this function returns.
    const enrich = declarationSource(src, 'async function enrichProject');
    assert.doesNotMatch(enrich, /engine = \{/,
      'enrichProject must not hand-build a client engine beside engineClientPayload');
    assert.ok((enrich.match(/engines\.engineClientPayload\(/g) || []).length >= 2,
      'both enrichProject branches project through the shared definition');
    // Sliced rather than brace-matched: this declaration's first brace is its
    // `options = {}` default, so the brace matcher closes on the parameter list.
    const enginesSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engines.js'), 'utf8');
    const at = enginesSrc.indexOf('function listWithAvailability');
    assert.ok(at >= 0, 'the engine roster builder must exist');
    assert.match(enginesSrc.slice(at, at + 800), /engineClientPayload\(/,
      'so does the engine roster');
  });

  describe('the notice renders in a real document', () => {
    /**
     * Run the shipped renderer against a mini-DOM and return the container's
     * HTML — the real function, lifted from source, not a copy.
     * @param {object} opts - `engineId`, `projectEngine`, `engines` (roster).
     * @returns {string}
     */
    function render(opts) {
      const { doc } = makeDocument(['settingsGeneratedConfigContainer']);
      const ctx = {
        document: doc,
        state: { engines: opts.engines || [] },
        esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      };
      vm.createContext(ctx);
      // By pattern, so a table added later and not named here fails as a
      // ReferenceError from inside the lifted function rather than silently.
      const tables = API_SRC.match(/const TC_SETTING_\w+ = \{[\s\S]*?\n {2}\};/g) || [];
      assert.ok(tables.length >= 3, `expected the setting tables to lift, found ${tables.length}`);
      for (const table of tables) vm.runInContext(table, ctx);
      vm.runInContext(declarationSource(API_SRC, 'function tcHonoredLaunchModes'), ctx);
      vm.runInContext(declarationSource(API_SRC, 'function tcEngineDisplayName'), ctx);
      vm.runInContext(declarationSource(API_SRC, 'function tcSettingDisposition'), ctx);
      vm.runInContext(declarationSource(API_SRC, 'function tcResolveEngineProfile'), ctx);
      vm.runInContext(declarationSource(UI_SRC, 'function renderGeneratedConfigNotice'), ctx);
      ctx.renderGeneratedConfigNotice(opts.engineId, opts.projectEngine || null);
      return doc.getElementById('settingsGeneratedConfigContainer').innerHTML;
    }

    const client = (id) => engines.engineClientPayload(
      bundledProfiles().find((p) => p.id === id), { available: true });

    it('says what OpenClaw cannot carry, in the profile\'s own words', () => {
      const projectEngine = client('openclaw');
      const html = render({ engineId: 'openclaw', projectEngine });
      assert.match(html, /OpenClaw has no config file/);
      assert.ok(html.includes(projectEngine.configFormat.absentReason),
        'the declared sentence reaches the rendered markup');
    });

    it('renders nothing at all on an engine that has a config file', () => {
      const claude = client('claude');
      assert.equal(render({ engineId: 'claude', projectEngine: claude, engines: [claude] }), '',
        'a notice here would be a false statement about four engines to fix one');
    });

    it('escapes the declared sentence rather than trusting it', () => {
      // `absentReason` is profile data, and an operator profile in
      // ~/.tangleclaw/engines/ is a file a human edits.
      const hostile = {
        id: 'evil', name: 'Evil', capabilities: {}, launchModes: {},
        configFormat: { filename: null, absentReason: '<img src=x onerror=alert(1)>' }
      };
      const html = render({ engineId: 'evil', projectEngine: hostile, engines: [hostile] });
      assert.doesNotMatch(html, /<img/);
      assert.match(html, /&lt;img/);
    });
  });
});
