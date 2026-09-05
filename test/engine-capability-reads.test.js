'use strict';

/*
 * A capability an engine profile DECLARES is not a capability TangleClaw READS
 * (#1254).
 *
 * `supportsSlashCommands`, `supportsCoAuthor`, `supportsRemote` and
 * `supportsModes` are declared across the bundled profiles and drive nothing —
 * and nothing in the data says so, which is what makes a capability panel
 * (#764) a liability rather than a feature: `supportsCoAuthor: true` on aider
 * would render as a promise the product does not keep. `READ_CAPABILITIES` is
 * that missing distinction, and it is worth having only while it stays true,
 * so this file holds it to the code in BOTH directions.
 *
 * Nothing here argues for deleting the unread flags. They describe the engines
 * accurately; whether to wire one is a question per flag.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engines = require('../lib/engines');

const ROOT = path.join(__dirname, '..');
const ENGINES_DIR = path.join(ROOT, 'data', 'engines');
// Where application code lives. `test/` is excluded on purpose: a flag read
// only by its own test is not read by the product, and counting the test would
// let a capability keep its wiring claim after the wiring was deleted.
const CODE_ROOTS = ['lib', 'public', 'hooks', 'bin', 'scripts'];
const CODE_FILES = [path.join(ROOT, 'server.js')];

/**
 * Every `.js` file under `dir`, recursively.
 * @param {string} dir - Directory to walk.
 * @returns {string[]} Absolute paths.
 */
function jsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * The repo-relative files carrying a CODE read of one capability flag.
 *
 * A read is a non-comment line naming the flag that also names the object it
 * is read off — `profile.capabilities.supportsConfigFile`, `caps.supportsPrimePrompt`.
 * Both halves matter: comments naming a flag are pointers rather than readers,
 * and `awareness` on its own matches a whole unrelated feature (awareness
 * receipts) whose lines say nothing about any engine profile.
 *
 * @param {string} flag - Capability flag name.
 * @returns {string[]} Sorted repo-relative paths.
 */
function readersOf(flag) {
  // Member-expression form, not a bare mention: `READ_CAPABILITIES`'s own
  // entries are `flag: '<what it decides>'` lines in a searched file, and a
  // description containing the word "capabilities" would otherwise match
  // itself — the list would satisfy its own has-a-reader guard and the whole
  // check would pass with no reader anywhere.
  const member = new RegExp(`\\.${flag}\\b|\\[['"\`]${flag}['"\`]\\]`);
  return codeFilesMatching((t) => member.test(t) && /\bcaps\b|capabilit/.test(t));
}

/**
 * The repo-relative files carrying a CODE mention of a profile field that lives
 * OUTSIDE `capabilities` — where the qualifier `readersOf` requires would never
 * appear, and asking for it would make the search vacuous.
 *
 * @param {string} field - Profile field name, distinctive enough to search bare.
 * @returns {string[]} Sorted repo-relative paths.
 */
function plainReadersOf(field) {
  return codeFilesMatching((t) => t.includes(field));
}

/**
 * The repo-relative application-code files with a non-comment line satisfying
 * `predicate`.
 * @param {(line: string) => boolean} predicate - Applied to each trimmed line.
 * @returns {string[]} Sorted repo-relative paths.
 */
function codeFilesMatching(predicate) {
  const files = CODE_ROOTS.map((d) => jsFiles(path.join(ROOT, d))).flat().concat(CODE_FILES);
  const out = [];
  for (const file of files) {
    const hit = fs.readFileSync(file, 'utf8').split('\n')
      .map((line) => line.trim())
      .filter((t) => !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'))
      .some(predicate);
    if (hit) out.push(path.relative(ROOT, file));
  }
  return out.sort();
}

/** @returns {object[]} Every bundled engine profile. */
function bundledProfiles() {
  return fs.readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, f), 'utf8')));
}

/** @returns {string[]} Every capability key any bundled profile declares. */
function declaredCapabilities() {
  const keys = new Set();
  for (const profile of bundledProfiles()) {
    for (const key of Object.keys(profile.capabilities || {})) keys.add(key);
  }
  return [...keys].sort();
}

describe('read capabilities are distinguishable from declared ones (#1254)', () => {
  it('the search actually reaches application code', () => {
    // Every case below is a search over the tree, and a search that reaches
    // nothing answers "unread" for everything — the whole file would pass
    // while proving the opposite of what it claims. Pinned against a flag read
    // in a file the walk must cross, and against one the walk must find bare.
    assert.deepEqual(readersOf('supportsConfigFile'), ['lib/engines.js']);
    assert.ok(plainReadersOf('settingDisposition').length > 0,
      'the bare search reaches no code — every "no readers" verdict below is vacuous');
    assert.deepEqual(readersOf('__noSuchCapability__'), [], 'and it does not match everything');
    // And it does not count the list as its own reader. `supportsSlashCommands`
    // is unread; adding it to READ_CAPABILITIES with a description mentioning
    // capabilities must not make it look wired.
    const selfMatch = "  supportsSlashCommands: 'the capabilities this engine offers',";
    assert.equal(/\.supportsSlashCommands\b/.test(selfMatch), false,
      'a list entry is not a member expression, so it cannot satisfy the guard');
  });

  it('every key in the read set has a reader in application code', () => {
    // A key added to the list without wiring is the failure this catches: the
    // list would then claim the product acts on something it ignores, which is
    // the exact dishonesty it exists to end.
    const listed = Object.keys(engines.READ_CAPABILITIES);
    assert.ok(listed.length > 0, 'an empty read set distinguishes nothing');
    for (const flag of listed) {
      const readers = readersOf(flag);
      assert.ok(readers.length > 0,
        `${flag} is listed as read but nothing outside test/ reads it — `
        + 'wire it, or move it to the unread set');
    }
  });

  it('every declared key with a reader is in the read set', () => {
    // The other direction, and the one that rots quietly: a flag that gains
    // wiring stays labelled unread, so a panel keeps calling a live capability
    // a broken promise.
    for (const flag of declaredCapabilities()) {
      const readers = readersOf(flag);
      if (readers.length === 0) continue;
      assert.ok(Object.prototype.hasOwnProperty.call(engines.READ_CAPABILITIES, flag),
        `${flag} is read by ${readers.join(', ')} but is not in READ_CAPABILITIES`);
    }
  });

  it('each entry says what the flag decides, not where it is read', () => {
    // A file path in the value would be a durable sentence riding on a value
    // that moves under it; what the flag DECIDES survives the refactor.
    for (const [flag, decides] of Object.entries(engines.READ_CAPABILITIES)) {
      assert.equal(typeof decides, 'string');
      assert.ok(decides.trim().length > 0, `${flag} must say what it decides`);
      assert.doesNotMatch(decides, /\.js\b/, `${flag}'s entry names a file that will move`);
    }
  });

  it('leaves the declared-but-unread flags in the profiles, identifiable as such', () => {
    // The distinction is the deliverable; deleting declared data a future
    // feature may want is churn. Named individually because each is a standing
    // decision — wiring one is a feature question, and the day one is wired the
    // case above fails until the read set is updated.
    for (const flag of ['supportsSlashCommands', 'supportsCoAuthor', 'supportsRemote', 'supportsModes']) {
      assert.ok(declaredCapabilities().includes(flag), `${flag} must stay declared`);
      assert.equal(Object.prototype.hasOwnProperty.call(engines.READ_CAPABILITIES, flag), false,
        `${flag} is in the read set — if it is now wired, that is the fix, not this list`);
    }
  });

  it('the engine guide\'s Read? column agrees with the read set', () => {
    // A third copy of the distinction, and the one a reader building #764's
    // panel — or deciding a flag is safe to delete — would act on. The failure
    // is asymmetric: a flag that gains wiring forces the READ_CAPABILITIES edit
    // the cases above demand, and leaves the doc saying "declared only" with
    // nothing to catch it. Parsed rather than eyeballed, because the table is
    // machine-readable and the guard already reads files off disk.
    const guide = fs.readFileSync(path.join(ROOT, 'docs', 'engine-guide.md'), 'utf8');
    const section = guide.slice(guide.indexOf('### Capabilities'), guide.indexOf('#### `startupInjection'));
    const documented = new Map();
    for (const line of section.split('\n')) {
      const row = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (!row) continue;
      documented.set(row[1].split('.')[0], /\*\*read\*\*/.test(row[2]));
    }
    assert.ok(documented.size > 0, 'the capability table did not parse — this compares nothing');
    for (const [flag, saysRead] of documented) {
      assert.equal(saysRead, Object.prototype.hasOwnProperty.call(engines.READ_CAPABILITIES, flag),
        `docs/engine-guide.md and READ_CAPABILITIES disagree about ${flag}`);
    }
    for (const flag of Object.keys(engines.READ_CAPABILITIES)) {
      assert.ok(documented.has(flag), `${flag} is read but absent from the engine guide's table`);
    }
  });

  it('holds the two halves of the co-author promise together', () => {
    // `coAuthorFormat` is the payload of `supportsCoAuthor` and lives beside
    // `capabilities` rather than inside it — so it is searched bare, because
    // the qualifier the capability search requires would never appear on its
    // reader's line and the check would pass by construction.
    const declaring = bundledProfiles().filter((p) => p.coAuthorFormat);
    assert.ok(declaring.length > 0, 'no profile declares a co-author format — this asserts nothing');
    assert.deepEqual(plainReadersOf('coAuthorFormat'), [],
      'coAuthorFormat gained a reader — wire supportsCoAuthor with it and list both');
  });
});
