'use strict';

/*
 * #1241 — a regenerated `CLAUDE.md` must not strand the self-updater, and must
 * not cost the operator an uncommitted hand edit either.
 *
 * TangleClaw manages its own clone, so `writeEngineConfig` splices its
 * BEGIN/END:tangleclaw region into `CLAUDE.md` on every launch. Since #833 that
 * file is tracked, so any release that changes generated guide text dirties it.
 * Before this, it landed in `realWork` and `/api/update/apply` returned a hard
 * 409 with no discard offer — the operator stuck on the current version.
 *
 * The ratified rule it collided with is NOT relaxed here. `test/update-applier.test.js`
 * pins it: "a modified CLAUDE.md is not provably TC's even when TC once
 * generated it — a later hand edit must never be discarded". That still holds,
 * because the question changed from *which path is it* to *where is the delta*:
 * a carrier is discardable only when the working copy matches HEAD everywhere
 * OUTSIDE the markers. Content outside is a hand edit, and a hand edit is still
 * real work.
 *
 * The asymmetry that drives every fail-closed branch below: a wrong `false`
 * costs the operator the old refusal; a wrong `true` costs them their work.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const applier = require('../lib/update-applier');
const engines = require('../lib/engines');

const M = engines._managedBlockMarkers('markdown');

/** A carrier file: hand-maintained text, TC's block, then a tail. */
const file = (head, block, tail) => `${head}\n${M.begin}\n${block}\n${M.end}\n${tail}\n`;

/**
 * Drive `_managedRegionOnlyDiff` with stubbed HEAD and working-tree content.
 *
 * @param {string|Error} head - Committed content, or an error to throw.
 * @param {string|Error} work - Working content, or an error to throw.
 * @returns {boolean}
 */
function containment(head, work) {
  const realGit = applier._internal.git;
  const realRead = applier._internal.readFile;
  applier._internal.git = () => { if (head instanceof Error) throw head; return head; };
  applier._internal.readFile = () => { if (work instanceof Error) throw work; return work; };
  try {
    return applier._managedRegionOnlyDiff('CLAUDE.md');
  } finally {
    applier._internal.git = realGit;
    applier._internal.readFile = realRead;
  }
}

describe('managed-block containment (#1241)', () => {
  it('is true when only the managed region changed', () => {
    assert.equal(
      containment(file('# Doc', 'old generated body', 'tail'),
        file('# Doc', 'NEW generated body', 'tail')),
      true);
  });

  it('is FALSE when anything above the block changed — the ratified rule', () => {
    // The case the whole decision exists to protect: an uncommitted hand edit
    // outside TC's region must keep the file classified as real work.
    assert.equal(
      containment(file('# Doc', 'body', 'tail'),
        file('# Doc\n\nmy uncommitted note', 'body', 'tail')),
      false);
  });

  it('is FALSE when anything below the block changed', () => {
    assert.equal(
      containment(file('# Doc', 'body', 'tail'),
        file('# Doc', 'body', 'tail plus my edit')),
      false);
  });

  it('is FALSE for a whitespace-only edit outside the block', () => {
    // Trailing whitespace outside the markers is still the operator's change.
    // `_git` trims, which would erase exactly this difference — the helper
    // reads untrimmed for that reason.
    assert.equal(
      containment(file('# Doc', 'body', 'tail'), `${file('# Doc', 'body', 'tail')}   \n`),
      false);
  });

  it('fails closed when the markers are missing on either side', () => {
    const plain = '# Doc\nno markers here\n';
    assert.equal(containment(plain, file('# Doc', 'b', 't')), false);
    assert.equal(containment(file('# Doc', 'b', 't'), plain), false);
  });

  it('fails closed on duplicated markers', () => {
    // The state that makes TC refuse to splice at all; nothing here can be
    // reasoned about, so it must not be discarded.
    const doubled = `${M.begin}\nx\n${M.end}\n${M.begin}\ny\n${M.end}\n`;
    assert.equal(containment(doubled, doubled), false);
  });

  it('fails closed when the end marker precedes the begin marker', () => {
    // Claimed in the JSDoc and the CHANGELOG; asserted here so the claim is
    // not the only thing holding it. Counts are 1/1, so only the ordering
    // check rejects this.
    const inverted = `head\n${M.end}\nbody\n${M.begin}\ntail\n`;
    assert.equal(containment(inverted, inverted), false);
    assert.equal(applier._outsideManagedBlock(inverted, M), null);
  });

  it('fails closed when the file is absent from HEAD or unreadable', () => {
    assert.equal(containment(new Error('fatal: path does not exist'), file('a', 'b', 'c')), false);
    assert.equal(containment(file('a', 'b', 'c'), new Error('ENOENT')), false);
  });
});

describe('_classifyDirty routes carriers on containment, not on path (#1241)', () => {
  const dirty = ' M CLAUDE.md\n';

  it('keeps the pre-#1241 refusal when no containment test is supplied', () => {
    // The default. A caller that cannot answer the question gets the old
    // behavior rather than a guess — which is why the existing ratified-rule
    // test in test/update-applier.test.js still passes unchanged.
    const d = applier._classifyDirty(dirty);
    assert.deepEqual(d.discardable, []);
    assert.deepEqual(d.realWork, ['CLAUDE.md']);
  });

  it('discards a carrier whose delta is confined to the block', () => {
    const d = applier._classifyDirty(dirty, () => true);
    assert.deepEqual(d.discardable, [{ path: 'CLAUDE.md', tracked: true }]);
    assert.deepEqual(d.realWork, []);
  });

  it('keeps a carrier with edits outside the block as real work', () => {
    const d = applier._classifyDirty(dirty, () => false);
    assert.deepEqual(d.discardable, []);
    assert.deepEqual(d.realWork, ['CLAUDE.md']);
  });

  it('treats only an exact `true` as containment', () => {
    // A predicate that returns something truthy-but-not-true must not
    // authorize a discard, mirroring the strict-boolean discard opt-in.
    for (const v of ['yes', 1, {}]) {
      assert.deepEqual(applier._classifyDirty(dirty, () => v).realWork, ['CLAUDE.md'],
        `a ${typeof v} return must not authorize a discard`);
    }
  });

  it('never treats an UNTRACKED carrier as discardable', () => {
    // `git checkout --` has nothing to restore an untracked file from, and TC
    // has written no block into it. The containment test is not even consulted.
    let asked = false;
    const d = applier._classifyDirty('?? CLAUDE.md\n', () => { asked = true; return true; });
    assert.deepEqual(d.realWork, ['CLAUDE.md']);
    assert.equal(asked, false, 'an untracked carrier must not be probed');
  });

  it('leaves every other path on THE LINE exactly where it was', () => {
    const d = applier._classifyDirty(
      ' M .tangleclaw/x\n M .claude/settings.json\n M .claude/settings.local.json\n M lib/a.js\n',
      () => true);
    assert.deepEqual(d.discardable.map((e) => e.path), ['.tangleclaw/x', '.claude/settings.json']);
    assert.deepEqual(d.realWork, ['.claude/settings.local.json', 'lib/a.js']);
  });
});

describe('the carrier list tracks its source of truth', () => {
  const profile = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'data', 'engines', 'claude.json'), 'utf8'));

  it('names the filename the claude engine profile declares', () => {
    // A rename in the profile must fail here rather than leave the list
    // pointing at a file that no longer exists.
    assert.ok(applier.MANAGED_BLOCK_CARRIERS.includes(profile.configFormat.filename),
      `MANAGED_BLOCK_CARRIERS must include "${profile.configFormat.filename}"`);
  });

  it('locates markers with the syntax that profile declares', () => {
    // The other half of the same coupling, and the quieter one: a syntax change
    // makes the markers unmatchable, so containment answers false forever and
    // #1241 is silently back — with the filename pin above still green.
    assert.equal(applier.MANAGED_BLOCK_SYNTAX, profile.configFormat.syntax);
    assert.ok(engines._managedBlockMarkers(applier.MANAGED_BLOCK_SYNTAX),
      'the declared syntax must resolve to a real comment form');
  });
});

/*
 * The seam between `applyUpdate` and the containment predicate.
 *
 * Both halves were covered in isolation, and that was not enough: deleting the
 * second argument at the single call site restores the #1241 dead end with the
 * whole suite green, because `_classifyDirty`'s default IS the pre-fix
 * behaviour. Only driving `applyUpdate` itself pins the wiring.
 */
describe('applyUpdate wires the containment test in (#1241)', () => {
  // Mirrors the stub table in test/update-applier.test.js — the same git calls
  // applyUpdate really makes, so this drives the production path rather than a
  // shape invented here.
  const SHA = 'aaaaaaa0000000000000000000000000000000';
  const HAPPY = {
    'rev-parse HEAD': `${SHA}\n`,
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'fetch --tags origin': '',
    'ls-remote --tags origin': 'sha1\trefs/tags/v9.9.9\n',
    'checkout v9.9.9': '',
    [`diff --name-only ${SHA} ${SHA}`]: ''
  };

  /**
   * @param {string} porcelain - status output, then clean on any later call.
   * @returns {object} `{ fn, calls }` git stub.
   */
  function gitStub(porcelain) {
    const calls = [];
    let n = 0;
    return {
      calls,
      fn: (args) => {
        const key = args.join(' ');
        calls.push(key);
        if (key === 'status --porcelain') return n++ === 0 ? porcelain : '';
        if (key.startsWith('checkout -- ') || key.startsWith('clean -fd -- ')) return '';
        if (key.startsWith('show HEAD:')) return CONTAINED_HEAD;
        if (!(key in HAPPY)) throw new Error(`unexpected git call: ${key}`);
        return HAPPY[key];
      }
    };
  }

  const CONTAINED_HEAD = file('# Doc', 'old body', 'tail');
  const CONTAINED_WORK = file('# Doc', 'NEW body', 'tail');
  const EDITED_WORK = file('# Doc\n\nmy note', 'NEW body', 'tail');

  /**
   * Run applyUpdate with stubs in place, restoring them afterwards.
   *
   * @param {string} work - Working-tree content for the carrier.
   * @param {object} opts - Passed to applyUpdate.
   * @returns {object} `{ result, calls }`
   */
  function run(work, opts) {
    const real = { ...applier._internal };
    const { fn, calls } = gitStub(' M CLAUDE.md\n');
    applier._internal.git = fn;
    applier._internal.readFile = () => work;
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
    try {
      return { result: applier.applyUpdate(opts), calls };
    } finally {
      Object.assign(applier._internal, real);
    }
  }

  it('offers the discard for a carrier whose delta is inside the block', () => {
    const { result } = run(CONTAINED_WORK, {});
    assert.equal(result.ok, false, 'the discard is still opt-in per request');
    assert.equal(result.code, 'dirty-tree');
    assert.deepEqual(result.dirty, { discardable: ['CLAUDE.md'], realWork: [] });
    assert.match(result.error, /discard option/,
      'an all-TC refusal must tell the operator the way out exists — this is the #1241 dead end');
  });

  it('discards it and proceeds when asked', () => {
    const { result, calls } = run(CONTAINED_WORK, { discardDirty: true });
    assert.equal(result.ok, true, 'the update must proceed once the tree is provably clean');
    assert.ok(calls.includes('checkout -- CLAUDE.md'),
      'the carrier is restored from HEAD, and TC rewrites its own region on next boot');
  });

  it('still refuses hard when the operator edited outside the block', () => {
    const { result, calls } = run(EDITED_WORK, { discardDirty: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.dirty, { discardable: [], realWork: ['CLAUDE.md'] });
    assert.equal(calls.some((c) => c.startsWith('checkout -- ')), false,
      'a hand edit outside the markers must never be discarded');
  });
});
