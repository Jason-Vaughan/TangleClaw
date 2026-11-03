'use strict';

/*
 * #2070 Slice 1 (Architect Ruling A2070) -- role-scoped operating primers
 * built from `lib/tc-verbs.js#VERB_ROSTER`, and the `tc help --json`
 * machine-readable manifest. Parity tests: every verb id a primer names
 * must actually exist in the live roster, so a renamed or removed verb
 * fails a test rather than leaving a role's primer silently stale.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { VERB_ROSTER } = require('../lib/tc-verbs');
const {
  ROLE_VERB_IDS, START_NEXT_VS_REVIEW_NOTE, SANDBOX_UNREACHABLE_NOTE, buildOperatingPrimer,
  SUBVERB_MANIFEST, subverbsFor, subverbManifestParity
} = require('../lib/operating-primer');

const ROOT = path.join(__dirname, '..');
const TC_BIN = path.join(ROOT, 'bin', 'tc');
const VERB_IDS = new Set(VERB_ROSTER.map((v) => v.id));

describe('buildOperatingPrimer — role parity against the live VERB_ROSTER', () => {
  for (const role of Object.keys(ROLE_VERB_IDS)) {
    it(`"${role}" names only verbs that exist in VERB_ROSTER`, () => {
      for (const id of ROLE_VERB_IDS[role]) {
        assert.ok(VERB_IDS.has(id), `role "${role}" names "${id}", which VERB_ROSTER does not have`);
      }
    });

    it(`"${role}" builds without throwing, and names every one of its verbs`, () => {
      const text = buildOperatingPrimer(role);
      for (const id of ROLE_VERB_IDS[role]) {
        const entry = VERB_ROSTER.find((v) => v.id === id);
        assert.ok(text.includes(entry.usage), `primer for "${role}" is missing ${id}'s own usage line`);
      }
    });

    it(`"${role}" carries both the start-next-vs-review note and the sandbox note`, () => {
      const text = buildOperatingPrimer(role);
      assert.ok(text.includes(START_NEXT_VS_REVIEW_NOTE));
      assert.ok(text.includes(SANDBOX_UNREACHABLE_NOTE));
    });
  }

  it('refuses an unknown role rather than building a silently empty primer', () => {
    assert.throws(() => buildOperatingPrimer('not-a-role'), /unknown role/);
  });

  it('a role naming a verb VERB_ROSTER does not have throws at build time, not silently', () => {
    // ROLE_VERB_IDS itself is frozen (its own properties cannot be
    // reassigned), but each role's array is not deep-frozen -- mutate its
    // contents in place, not the property, and restore them after.
    ROLE_VERB_IDS.worker.push('definitely-not-a-real-verb');
    try {
      assert.throws(() => buildOperatingPrimer('worker'), /no longer in VERB_ROSTER/);
    } finally {
      ROLE_VERB_IDS.worker.pop();
    }
  });
});

describe('SUBVERB_MANIFEST — the structured command/subcommand schema (Architect Ruling A2070 bullet 1)', () => {
  it('two-way parity with VERB_ROSTER: nothing missing, nothing stale', () => {
    const parity = subverbManifestParity();
    assert.deepEqual(parity.missing, [], `VERB_ROSTER verb(s) with no SUBVERB_MANIFEST entry: ${parity.missing.join(', ')}`);
    assert.deepEqual(parity.stale, [], `SUBVERB_MANIFEST entry for a verb VERB_ROSTER no longer has: ${parity.stale.join(', ')}`);
  });

  it('every record has all five required fields, non-empty', () => {
    for (const [verbId, specs] of Object.entries(SUBVERB_MANIFEST)) {
      assert.ok(specs.length > 0, `"${verbId}" has no records at all`);
      for (const spec of specs) {
        for (const field of ['syntax', 'purpose', 'authority', 'statePreconditions', 'exitRefusal']) {
          assert.equal(typeof spec[field], 'string', `"${verbId}"/${spec.id} is missing "${field}"`);
          assert.ok(spec[field].length > 0, `"${verbId}"/${spec.id}'s "${field}" is empty`);
        }
      }
    }
  });

  it('subverbsFor refuses a verb id VERB_ROSTER does not have', () => {
    assert.throws(() => subverbsFor('definitely-not-a-real-verb'), /not in VERB_ROSTER/);
  });

  it('a multi-subverb verb (message) has a distinct record per real subverb', () => {
    const specs = subverbsFor('message');
    const ids = specs.map((s) => s.id);
    assert.deepEqual(ids, ['send', 'read', 'ack', 'status', 'close', 'sent', 'owed', 'retract']);
  });

  it('a no-subverb verb (whoami) still has exactly one record, for the bare verb itself', () => {
    const specs = subverbsFor('whoami');
    assert.equal(specs.length, 1);
    assert.equal(specs[0].id, null);
  });
});

describe('the sandbox note matches bin/tc\'s own real error text', () => {
  it('SANDBOX_UNREACHABLE_NOTE\'s claim is the same one bin/tc actually makes, triggered for real', () => {
    // A real, live-triggered API_UNREACHABLE_FROM_CONTEXT, not a grep of the
    // source file -- bin/tc's own message is built from concatenated string
    // literals, so its exact runtime text is what matters, not how the
    // source happens to be line-wrapped.
    const r = spawnSync(process.execPath, [TC_BIN, 'whoami'], {
      env: { ...process.env, TANGLECLAW_API: 'http://127.0.0.1:1', PATH: process.env.PATH },
      encoding: 'utf8'
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /managed sandbox can block localhost even while the host service is healthy/);
    assert.match(SANDBOX_UNREACHABLE_NOTE, /managed sandbox can block localhost even while the host service is healthy/);
  });
});

describe('tc help --json', () => {
  /** Run `tc help --json` with no environment, same as `tc --help` needs none. */
  function run() {
    return spawnSync(process.execPath, [TC_BIN, 'help', '--json'], { env: {}, encoding: 'utf8' });
  }

  it('answers 0 with no TangleClaw environment at all', () => {
    const r = run();
    assert.equal(r.status, 0, `tc help --json exited ${r.status}: ${r.stderr}`);
  });

  it('is valid JSON listing every VERB_ROSTER entry by id, usage and summary', () => {
    const r = run();
    const manifest = JSON.parse(r.stdout);
    assert.equal(manifest.length, VERB_ROSTER.length);
    for (const entry of VERB_ROSTER) {
      const row = manifest.find((m) => m.id === entry.id);
      assert.ok(row, `tc help --json is missing "${entry.id}"`);
      assert.equal(row.usage, entry.usage);
      assert.equal(row.summary, entry.summary);
    }
  });

  it('carries the SAME structured subverb records SUBVERB_MANIFEST has, not a top-level-only summary (Architect Ruling A2070)', () => {
    const r = run();
    const manifest = JSON.parse(r.stdout);
    for (const entry of VERB_ROSTER) {
      const row = manifest.find((m) => m.id === entry.id);
      assert.deepEqual(row.subverbs, subverbsFor(entry.id), `tc help --json's subverbs for "${entry.id}" diverge from SUBVERB_MANIFEST`);
    }
  });

  it('refuses a malformed call without touching the network', () => {
    const r = spawnSync(process.execPath, [TC_BIN, 'help', '--not-json'], { env: {}, encoding: 'utf8' });
    assert.equal(r.status, 1);
  });
});

describe('family help -- tc <verb> --help', () => {
  it('answers with that verb\'s own usage and summary, needing no environment', () => {
    const r = spawnSync(process.execPath, [TC_BIN, 'message', '--help'], { env: {}, encoding: 'utf8' });
    assert.equal(r.status, 0, `tc message --help exited ${r.status}: ${r.stderr}`);
    const entry = VERB_ROSTER.find((v) => v.id === 'message');
    assert.ok(r.stdout.includes(entry.usage));
    assert.ok(r.stdout.includes(entry.summary));
  });

  it('works the same way for -h', () => {
    const r = spawnSync(process.execPath, [TC_BIN, 'workload', '-h'], { env: {}, encoding: 'utf8' });
    assert.equal(r.status, 0);
    const entry = VERB_ROSTER.find((v) => v.id === 'workload');
    assert.ok(r.stdout.includes(entry.usage));
  });

  it('every VERB_ROSTER verb answers its own family help the same way', () => {
    for (const entry of VERB_ROSTER) {
      const r = spawnSync(process.execPath, [TC_BIN, entry.id, '--help'], { env: {}, encoding: 'utf8' });
      assert.equal(r.status, 0, `tc ${entry.id} --help exited ${r.status}: ${r.stderr}`);
      assert.ok(r.stdout.includes(entry.summary), `tc ${entry.id} --help is missing its own summary`);
    }
  });
});
