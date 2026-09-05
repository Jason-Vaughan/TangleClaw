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
  projectMapEnabled: { shipped: false, chosen: true, extras: [] }
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
        { id: 'hollow', name: 'Hollow', capabilities: {}, launchModes: { default: { label: 'Interactive' }, plan: null } },
        // A connection-backed OpenClaw id. `state.engines` never carries one
        // and no bundled profile has one, so without this fixture the whole
        // evalAuditMode row would only ever be compared on `applies: false` —
        // the two realms agreeing about the case that needs no gate.
        { id: 'openclaw:conn-1', name: 'Studio (OpenClaw)', capabilities: {}, launchModes: {} },
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
