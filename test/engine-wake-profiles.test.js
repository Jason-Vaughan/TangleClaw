'use strict';

/*
 * The wake signature is a declared property of the engine (#1255).
 *
 * `ENGINE_WAKE_PROFILES` used to be a literal in `lib/medusa-wake.js`, so
 * adding a sixth engine to TangleClaw meant editing a `lib/` module — the
 * construction `prime-delivery-direction.md` § Direction §1 forbids one layer
 * up ("a channel's limit is a declared property of the engine"). It is now
 * derived from each profile's `capabilities.wake` block.
 *
 * **The tests that still PASS are the suspects here.** The pre-existing wake
 * suite drives `_assessPane` against live-capture panes with whatever profile
 * the module hands it, so it would go green against a migration that silently
 * dropped `promptPad` or `placeholderSgr` — the fields whose absence degrades a
 * gate rather than breaking it. Every guard below therefore names the value it
 * is protecting, and each was verified red against a named mutation of the
 * JSON rather than against a green suite.
 *
 * Two properties are load-bearing beyond the migration itself:
 *
 *  - **Provenance is per FIELD.** A field that loses "this was measured"
 *    becomes an assumption the next reader trusts. The `evidence` map is
 *    checked in both directions so neither a new field without provenance nor
 *    a stale entry for a removed one can survive.
 *  - **The derivation is lazy.** The runtime reads profiles from the user-local
 *    engines directory, which `store.init()` populates — and `server.js`
 *    requires every module before calling it. A table built at module load
 *    ships zero wake profiles, silently, which is the failure this chunk
 *    exists to end, introduced by its own fix.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('wake-profiles');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');
const {
  IDLE_PANE, BUSY_PANE, DIALOG_PANE, TYPING_PANE,
  AG_IDLE_PANE, AG_BUSY_PANE, AG_DIALOG_PANE, AG_TYPING_PANE
} = require('./_wake-fixtures');

const ROOT = path.join(__dirname, '..');
const ENGINES_DIR = path.join(ROOT, 'data', 'engines');

/** @returns {object[]} Every bundled engine profile, `{file, profile}`. */
function bundled() {
  return fs.readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, profile: JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, f), 'utf8')) }));
}

/** @param {string} id - Engine id. @returns {object} Its declared wake block. */
function block(id) {
  const found = bundled().find((b) => b.profile.id === id);
  assert.ok(found, `${id} must be a bundled profile`);
  return found.profile.capabilities.wake;
}

/**
 * A well-formed wake block, as a mutable copy — the base every malformed case
 * below deviates from by exactly one field, so a case can never pass because
 * the fixture was broken for a second reason.
 * @returns {object}
 */
function wellFormed() {
  return JSON.parse(JSON.stringify(block('antigravity')));
}

/**
 * Build a one-engine table from a wake block.
 * @param {object|undefined} wakeBlock - The block to declare.
 * @returns {Object<string, object>} The derived table.
 */
function derive(wakeBlock) {
  return wake._buildWakeProfiles([{ id: 'probe', capabilities: { wake: wakeBlock } }]);
}

describe('the wake signature is declared in the engine profile (#1255)', () => {
  it('exactly the two live-probed engines declare a block, and the set is unchanged', () => {
    // The migration must not change WHICH engines can be nudged. Codex, aider
    // and openclaw have no live pane capture, and declaring an unmeasured
    // signature to make the settings modal read better is the exact dishonesty
    // this chunk exists to end.
    const declaring = bundled().filter((b) => b.profile.capabilities && b.profile.capabilities.wake)
      .map((b) => b.profile.id).sort();
    assert.deepEqual(declaring, ['antigravity', 'claude']);
    assert.deepEqual(Object.keys(wake.ENGINE_WAKE_PROFILES).sort(), ['antigravity', 'claude'],
      'the derived table is the declaring set — no engine gained or lost a profile in the move');
  });

  it('every declared field carries provenance, and every provenance entry a field', () => {
    // Both directions: a field added without provenance is a measurement
    // nobody made, and a stale entry for a removed field is provenance for
    // nothing. Both read as "this was verified" to the next author.
    for (const id of ['claude', 'antigravity']) {
      const b = block(id);
      const fields = Object.keys(b).filter((k) => k !== 'evidence').sort();
      assert.ok(fields.length > 0, `${id} declares no wake fields — this asserts nothing`);
      assert.deepEqual(Object.keys(b.evidence).sort(), fields,
        `${id}'s evidence map and its declared fields must cover each other`);
    }
  });

  it('provenance names a date or an explicit null, and always a source', () => {
    // `verifiedOn: null` is the honest form for a value nobody has measured
    // (antigravity's separator). It is a DIFFERENT claim from a value measured
    // and found absent — Claude's `idleMarker` is null and carries a date,
    // because the absence itself was what got measured.
    let nulls = 0;
    for (const id of ['claude', 'antigravity']) {
      for (const [field, entry] of Object.entries(block(id).evidence)) {
        assert.ok(entry && typeof entry === 'object', `${id}.${field} needs an evidence object`);
        if (entry.verifiedOn === null) nulls++;
        else {
          assert.match(entry.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${id}.${field}.verifiedOn is an ISO date`);
          assert.ok(!Number.isNaN(Date.parse(entry.verifiedOn)), `${id}.${field}.verifiedOn parses`);
        }
        assert.ok(typeof entry.source === 'string' && entry.source.length > 20,
          `${id}.${field} must say where it was measured, not just that it was`);
      }
    }
    assert.equal(block('antigravity').evidence.promptPad.verifiedOn, null,
      'antigravity has never had its separator captured — that gap is the reason the field is null');
    assert.ok(nulls > 0, 'no unmeasured field in the roster — this case compared nothing');
    assert.notEqual(block('claude').evidence.idleMarker.verifiedOn, null,
      'Claude\'s absent idle marker was MEASURED absent, which is a dated claim');
  });

  it('carries every value the consumers read, and nothing they do not', () => {
    // The guard the existing suite cannot be: `_assessPane` would still pass
    // its live-pane matrix with `promptPad` or `placeholderSgr` silently gone,
    // because their absence degrades the composer check rather than breaking
    // it. Named value by value for that reason.
    const claude = wake.ENGINE_WAKE_PROFILES.claude;
    assert.equal(claude.busyMarker, 'esc to interrupt');
    assert.equal(claude.promptGlyph, '❯');
    assert.equal(claude.promptPad.charCodeAt(0), 160, 'the measured separator is NBSP, not a space');
    assert.equal(claude.promptPad.length, 1);
    assert.deepEqual(claude.placeholderSgr, [2]);
    assert.equal(claude.idleMarker, null);
    assert.equal(claude.pasteRejectedMarker, undefined,
      'Claude has never been measured discarding a paste, so it declares no marker');

    const agy = wake.ENGINE_WAKE_PROFILES.antigravity;
    assert.equal(agy.busyMarker, 'esc to cancel');
    assert.equal(agy.promptGlyph, '>');
    assert.equal(agy.promptPad, null, 'unmeasured, so the composer check keeps its laxer reading');
    assert.deepEqual(agy.placeholderSgr, [90]);
    assert.equal(agy.idleMarker, '? for shortcuts');
    assert.equal(agy.pasteRejectedMarker, 'Please try again shortly');
  });

  it('the derived profile is the declared block, field for field', () => {
    // Driven off the JSON rather than a list written here: a field added to a
    // profile and not to the builder would otherwise reach neither the table
    // nor this guard.
    for (const id of ['claude', 'antigravity']) {
      const declared = block(id);
      const derived = wake.ENGINE_WAKE_PROFILES[id];
      for (const [field, value] of Object.entries(declared)) {
        if (field === 'evidence') continue;
        if (field === 'promptPattern') {
          assert.equal(derived.promptRe.source, value,
            `${id}: the compiled pattern must be the declared one`);
          continue;
        }
        assert.deepEqual(derived[field], value, `${id}.${field} did not survive the derivation`);
      }
      const expected = Object.keys(declared).filter((k) => k !== 'evidence')
        .map((k) => (k === 'promptPattern' ? 'promptRe' : k)).sort();
      assert.deepEqual(Object.keys(derived).sort(), expected,
        `${id}: the derived profile carries a field the profile never declared`);
    }
  });

  it('the pattern is compiled once, not re-parsed per capture', () => {
    // It is the injection gate: a pattern re-compiled on every pane read would
    // turn an upstream glyph change into a per-tick cost, and a pattern that
    // failed to compile late would read as "no profile" rather than as an error.
    assert.ok(wake.ENGINE_WAKE_PROFILES.claude.promptRe instanceof RegExp);
    assert.equal(wake.ENGINE_WAKE_PROFILES.claude.promptRe,
      wake.ENGINE_WAKE_PROFILES.claude.promptRe,
      'the same compiled object, not a fresh one per access');
  });

  describe('the declared pattern gates the live-capture panes', () => {
    /**
     * Does any line of this pane read as a BARE prompt under the profile?
     * @param {string[]} pane - Pane lines.
     * @param {object} profile - A derived wake profile.
     * @returns {boolean}
     */
    const bare = (pane, profile) => pane.some((line) => profile.promptRe.test(line));

    it('matches a resting pane on both engines', () => {
      assert.equal(bare(IDLE_PANE, wake.ENGINE_WAKE_PROFILES.claude), true);
      assert.equal(bare(AG_IDLE_PANE, wake.ENGINE_WAKE_PROFILES.antigravity), true);
      // Claude's busy pane still renders the bare prompt — measured, and the
      // reason the busy marker cannot be the only gate (#1114). Asserted so a
      // pattern narrowed until it stopped matching would be caught here rather
      // than by a wake that quietly never fires.
      assert.equal(bare(BUSY_PANE, wake.ENGINE_WAKE_PROFILES.claude), true);
      assert.equal(bare(AG_BUSY_PANE, wake.ENGINE_WAKE_PROFILES.antigravity), true);
    });

    it('refuses a half-typed line on both engines', () => {
      // The pattern IS the injection gate against an operator's own input: a
      // line the operator is part-way through must never read as bare, or the
      // nudge is pasted over it.
      assert.equal(bare(TYPING_PANE, wake.ENGINE_WAKE_PROFILES.claude), false);
      assert.equal(bare(AG_TYPING_PANE, wake.ENGINE_WAKE_PROFILES.antigravity), false);
    });

    it('refuses a Claude dialog by the pattern, and an antigravity one by the marker', () => {
      // Not the same mechanism on the two engines, and the difference is the
      // reason `idleMarker` exists. Claude replaces the bare prompt with option
      // rows (`❯ 1. Yes`), so the pattern alone refuses it. Antigravity keeps
      // its bare `>` in a dialog — measured — and what is gone is the at-rest
      // hint, so the POSITIVE marker is what refuses. Asserting the same shape
      // for both would have been a fixture that agrees with itself.
      const claude = wake.ENGINE_WAKE_PROFILES.claude;
      assert.equal(bare(DIALOG_PANE, claude), false);

      const agy = wake.ENGINE_WAKE_PROFILES.antigravity;
      assert.equal(bare(AG_DIALOG_PANE, agy), true,
        'precondition: the bare prompt survives a dialog here, which is why the pattern cannot decide');
      assert.equal(AG_DIALOG_PANE.join('\n').includes(agy.idleMarker), false,
        'the at-rest marker is absent in a dialog — that is what makes this fail-safe');
      assert.equal(AG_IDLE_PANE.join('\n').includes(agy.idleMarker), true);
    });

    it('does not accept a typed space as a bare prompt (#1109)', () => {
      // The hole the measured NBSP closed. `❯` plus an ordinary space is the
      // separator a build might render; `❯` plus TWO is the operator's.
      const re = wake.ENGINE_WAKE_PROFILES.claude.promptRe;
      assert.equal(re.test('❯  '), false, 'a second blank cell is input, not padding');
      assert.equal(re.test('❯\t'), false);
    });

    it('neither profile matches the other engine\'s pane', () => {
      assert.equal(bare(AG_IDLE_PANE, wake.ENGINE_WAKE_PROFILES.claude), false);
      assert.equal(bare(IDLE_PANE, wake.ENGINE_WAKE_PROFILES.antigravity), false);
    });
  });
});

describe('a malformed wake block is refused at the read, never half-loaded', () => {
  // The guard runs where the profile is READ, not only over the bundled files:
  // an operator profile in ~/.tangleclaw/engines/ never passes through this
  // suite, and a half-loaded profile reaches the gate that decides whether to
  // type into a live pane.

  it('a well-formed block loads — so the refusals below mean something', () => {
    assert.deepEqual(wake._wakeBlockErrors(wellFormed()), []);
    assert.ok(derive(wellFormed()).probe, 'the base fixture must load');
  });

  it('refuses a promptPattern that will not compile', () => {
    const b = wellFormed();
    b.promptPattern = '^\\s*(unclosed';
    assert.match(wake._wakeBlockErrors(b).join(' '), /promptPattern/);
    assert.equal(derive(b).probe, undefined, 'the engine stays unprofiled, not half-loaded');
  });

  it('refuses a field with no evidence entry', () => {
    const b = wellFormed();
    delete b.evidence.busyMarker;
    assert.match(wake._wakeBlockErrors(b).join(' '), /evidence\.busyMarker/);
    assert.equal(derive(b).probe, undefined);
  });

  it('refuses an evidence entry for a field that is not declared', () => {
    const b = wellFormed();
    b.evidence.promptSuffix = { verifiedOn: '2026-07-14', source: 'a field that no longer exists' };
    assert.match(wake._wakeBlockErrors(b).join(' '), /no field to vouch for/);
    assert.equal(derive(b).probe, undefined);
  });

  it('refuses a field the gate does not read', () => {
    // A typo is the realistic case: `busyMarkr` with its own evidence entry
    // would otherwise satisfy the coverage check while the field the gate
    // reads went missing.
    const b = wellFormed();
    b.busyMarkr = 'esc to cancel';
    b.evidence.busyMarkr = { verifiedOn: '2026-07-14', source: 'a typo with provenance' };
    assert.match(wake._wakeBlockErrors(b).join(' '), /not a field this gate reads/);
    assert.equal(derive(b).probe, undefined);
  });

  it('refuses a missing required field, null included', () => {
    // `null` is a value here, not an absence: an author who has not measured a
    // separator writes null and says so. Omitting the field is the same gap
    // with nobody able to tell it from an oversight.
    for (const field of ['busyMarker', 'promptPattern', 'promptGlyph', 'promptPad', 'placeholderSgr', 'idleMarker']) {
      const b = wellFormed();
      delete b[field];
      delete b.evidence[field];
      assert.match(wake._wakeBlockErrors(b).join(' '), new RegExp(`wake\\.${field} is required`),
        `${field} must be required`);
      assert.equal(derive(b).probe, undefined, `${field} missing must leave the engine unprofiled`);
    }
  });

  it('refuses provenance that is not provenance', () => {
    const undated = wellFormed();
    undated.evidence.busyMarker.verifiedOn = 'last summer';
    assert.match(wake._wakeBlockErrors(undated).join(' '), /verifiedOn must be an ISO date or null/);

    const sourceless = wellFormed();
    sourceless.evidence.busyMarker.source = '';
    assert.match(wake._wakeBlockErrors(sourceless).join(' '), /source must name where/);

    const none = wellFormed();
    delete none.evidence;
    assert.match(wake._wakeBlockErrors(none).join(' '), /evidence is required/);
  });

  it('refuses a block that is not an object at all', () => {
    for (const bad of [null, 'esc to cancel', ['esc to cancel']]) {
      assert.ok(wake._wakeBlockErrors(bad).length > 0, `${JSON.stringify(bad)} is not a wake block`);
    }
  });

  it('leaves the other engines alone when one profile is bad', () => {
    // The refusal is per engine. A single broken operator profile must not
    // take the wake feature down for every project on the machine.
    const table = wake._buildWakeProfiles([
      { id: 'broken', capabilities: { wake: { busyMarker: 'x' } } },
      { id: 'good', capabilities: { wake: wellFormed() } }
    ]);
    assert.deepEqual(Object.keys(table), ['good']);
  });

  it('an engine that declares no block is simply absent, not an error', () => {
    assert.deepEqual(wake._buildWakeProfiles([{ id: 'codex', capabilities: {} }]), {});
    assert.deepEqual(wake._buildWakeProfiles([{ id: 'codex' }]), {});
  });

  it('refuses a glyph or pad wider than the cell it is compared against', () => {
    // `_composerEmpty` compares both against ONE terminal cell, so a
    // multi-character value is not lenient — it can never match, and the
    // composer then reads non-empty on every capture: the engine is never
    // idle, never nudged, never chimed, with nothing logged. The realistic way
    // to author one is copying an NBSP out of a document as the six literal
    // characters ` `, so that exact value is the fixture.
    const pasted = '\\u00a0';
    assert.equal(pasted.length, 6, 'the fixture must be the pasted escape, not a real NBSP');

    const pad = wellFormed();
    pad.promptPad = pasted;
    assert.match(wake._wakeBlockErrors(pad).join(' '), /promptPad must be exactly one character/);
    assert.equal(derive(pad).probe, undefined);

    const glyph = wellFormed();
    glyph.promptGlyph = '>>';
    assert.match(wake._wakeBlockErrors(glyph).join(' '), /promptGlyph must be exactly one character/);

    // One code POINT, not one UTF-16 unit: an astral glyph is a single cell.
    const astral = wellFormed();
    astral.promptGlyph = '𝄞';
    assert.deepEqual(wake._wakeBlockErrors(astral), []);
  });
});

describe('declaring badly and declaring nothing are one answer', () => {
  // The divergence this closes: the monitor gated on VALIDITY while the
  // settings row gated on the raw key being PRESENT. An operator profile with
  // a malformed block would then render a live Auto-wake checkbox for a
  // session the monitor refuses to nudge — the ADR 0013 silence, produced by
  // the guard built to end it.
  const engines = require('../lib/engines');
  const loadApiHelperGlobals = require('./_api-helper-globals');

  /** @returns {object} A profile whose wake block is present but malformed. */
  function malformed() {
    const b = wellFormed();
    b.promptPattern = '^\\s*(unclosed';
    return { id: 'homebrew', name: 'Homebrew', capabilities: { wake: b }, launchModes: {} };
  }

  it('wakeSignature is the one decision', () => {
    assert.equal(wake.wakeSignature(malformed()), null);
    assert.equal(wake.wakeSignature({ id: 'codex', capabilities: {} }), null);
    assert.ok(wake.wakeSignature({ id: 'ok', capabilities: { wake: wellFormed() } }));
  });

  it('all three readers answer the same for a malformed block', () => {
    const profile = malformed();
    // 1. the monitor
    assert.equal(wake._buildWakeProfiles([profile]).homebrew, undefined);
    // 2. the settings row
    assert.equal(engines.settingDisposition('medusaWake', { medusaWake: true }, profile).applies, false);
    // 3. the browser, through the projection it actually receives
    const projected = engines.engineClientPayload(profile, { available: true });
    assert.equal(projected.capabilities.wake, undefined,
      'a block the monitor refuses must not cross to the browser at all');
    const browser = loadApiHelperGlobals()
      .tcSettingDisposition('medusaWake', { medusaWake: true }, projected);
    assert.equal(browser.applies, false);
    assert.match(browser.reason, /has no measured idle signature/);
  });

  it('a valid block still crosses whole, provenance included', () => {
    // Trimming `evidence` here would make the projected shape one
    // `wakeSignature` itself refuses, so the server and the browser would
    // disagree the moment either was handed a projected profile.
    const profile = { id: 'ok', name: 'OK', capabilities: { wake: wellFormed() }, launchModes: {} };
    const projected = engines.engineClientPayload(profile, { available: true });
    assert.ok(projected.capabilities.wake.evidence);
    assert.ok(wake.wakeSignature(projected), 'the projected block must still validate');
  });
});

describe('the table is derived when it is READ, not when the module is required', () => {
  it('resolves after store.init(), from a store that was empty at require time', () => {
    // `server.js` requires every module before calling `store.init()`, and the
    // runtime reads profiles from the user-local engines directory that init
    // populates (#251). A table built at module load reads that directory
    // pre-sync — empty on a fresh install — and ships zero wake profiles,
    // silently. That is the failure this chunk exists to end, and building it
    // eagerly would reintroduce it as its own fix.
    //
    // Run in a child process because the ordering is a property of a FRESH
    // module registry: nothing in-process can un-require this module.
    const script = `
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wake-order-'));
      const store = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});
      store._setBasePath(tmp);
      require(${JSON.stringify(path.join(ROOT, 'lib', 'logger.js'))}).setLevel('error');
      const wake = require(${JSON.stringify(path.join(ROOT, 'lib', 'medusa-wake.js'))});
      const before = Object.keys(wake.ENGINE_WAKE_PROFILES);
      store.init();
      const after = Object.keys(wake.ENGINE_WAKE_PROFILES).sort();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(JSON.stringify({ before, after }));
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
    assert.deepEqual(out.before, [],
      'precondition: the engines directory really is empty at require time');
    assert.deepEqual(out.after, ['antigravity', 'claude'],
      'the table must be built from the store the sync populated, not from the pre-sync directory');
  });

  it('a populated read IS memoised, so the pattern is compiled once', () => {
    // The other half of the contract the child process above pins: the empty
    // read must not cache, and the populated one must. Rebuilding per access
    // would recompile every engine's `promptRe` on every monitor tick and
    // every dashboard poll.
    assert.equal(wake.ENGINE_WAKE_PROFILES, wake.ENGINE_WAKE_PROFILES);
    assert.equal(wake.ENGINE_WAKE_PROFILES.claude, wake.ENGINE_WAKE_PROFILES.claude);
  });

  it('an unreadable engines directory is reported ONCE, and recovers', () => {
    // A different case from the empty one: `store.engines.list()` returns `[]`
    // for a missing directory but THROWS on a file that will not parse — and
    // it parses every file in one pass, so one bad operator profile answers
    // for all of them. The read is retried on every access so the table
    // recovers with no restart, which is exactly why the warning has to latch:
    // otherwise it fires per session per five-second tick, plus every
    // dashboard poll, and buries the line that names what broke.
    // Reported through a file rather than stdout: the warning itself is what
    // is being counted, so a channel it also writes to cannot carry the count.
    const answer = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wake-answer-')), 'r.json');
    const script = `
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wake-bad-'));
      fs.mkdirSync(path.join(tmp, 'engines'));
      fs.writeFileSync(path.join(tmp, 'engines', 'broken.json'), '{ not json');
      const store = require(${JSON.stringify(path.join(ROOT, 'lib', 'store.js'))});
      store._setBasePath(tmp);
      require(${JSON.stringify(path.join(ROOT, 'lib', 'logger.js'))}).setLevel('warn');
      let warns = 0;
      const err = process.stderr.write.bind(process.stderr);
      const out = process.stdout.write.bind(process.stdout);
      const count = (chunk) => {
        if (String(chunk).includes('engine profiles unreadable')) warns++;
        return true;
      };
      process.stderr.write = (c) => count(c);
      process.stdout.write = (c) => count(c);
      const wake = require(${JSON.stringify(path.join(ROOT, 'lib', 'medusa-wake.js'))});
      for (let i = 0; i < 5; i++) Object.keys(wake.ENGINE_WAKE_PROFILES);
      const whileBroken = Object.keys(wake.ENGINE_WAKE_PROFILES);
      // Fix the file the way an operator would, with the process still up.
      fs.rmSync(path.join(tmp, 'engines', 'broken.json'));
      store.init();
      const afterFix = Object.keys(wake.ENGINE_WAKE_PROFILES).sort();
      process.stderr.write = err;
      process.stdout.write = out;
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.writeFileSync(${JSON.stringify(answer)}, JSON.stringify({ warns, whileBroken, afterFix }));
    `;
    execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const out = JSON.parse(fs.readFileSync(answer, 'utf8'));
    fs.rmSync(path.dirname(answer), { recursive: true, force: true });
    assert.deepEqual(out.whileBroken, [], 'one unparsable file answers for the whole directory');
    assert.equal(out.warns, 1, 'reported once per process, not once per read');
    assert.deepEqual(out.afterFix, ['antigravity', 'claude'],
      'and the table recovers once the file is fixed, with no restart');
  });
});
