'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const spec = require('../lib/v6/fleet-template-spec');

// v6.5.0 Wave 1 (#3115, Car V650-W1-B): the Portable Fleet Template JSON
// Spec (`.fleet.json`) schema, validator, and sanitized export/import/
// preview engine. Backend slice only — see the module's own header for why
// this is distinct from lib/v6/c2-fleet-templates.js (#2984).

/** A minimal, otherwise-valid spec object, for tests that mutate one field. */
function validSpec() {
  return {
    schemaVersion: '1.0',
    metadata: {
      id: 'x', name: 'X', version: '1.0.0', author: 'me', description: 'd',
      category: 'Software Engineering', tags: ['a'], homepageUrl: 'https://x.example', license: 'MIT'
    },
    seats: [
      { seatId: 'pm', displayNameSuffix: '', role: 'PM', supervisory: true, launchPolicy: 'immediate', recommendedEngine: 'claude' },
      { seatId: 'builder-a', displayNameSuffix: 'Builder A', role: 'Builder', supervisory: false, launchPolicy: 'on-demand', recommendedEngine: 'codex', fallbackEngines: ['claude'], primingPrompt: 'build it' }
    ],
    rules: [
      { title: 'A rule', category: 'process', severity: 'blocking', body: 'Do the thing.', enforcedByHook: false }
    ],
    charterTemplate: {
      title: 'T', mission: 'M', scope: 'S', successCriteria: ['done'], requiredSignOffRoles: ['PM'], waveTopologyDefaults: { maxParallelCars: 1 }
    },
    sharedDocuments: [
      { name: 'n', filename: 'f.md', content: 'hello' }
    ]
  };
}

describe('validateFleetSpec — schema validation (#3115)', () => {
  it('accepts a minimal, well-formed spec', () => {
    const result = spec.validateFleetSpec(validSpec());
    assert.deepEqual(result, { ok: true, errors: [] });
  });

  it('rejects a non-object spec without throwing', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      const result = spec.validateFleetSpec(bad);
      assert.equal(result.ok, false);
      assert.ok(result.errors.length >= 1);
    }
  });

  it('rejects the wrong schemaVersion', () => {
    const s = validSpec();
    s.schemaVersion = '2.0';
    const result = spec.validateFleetSpec(s);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'schemaVersion'));
  });

  it('requires every metadata field, by name', () => {
    const s = validSpec();
    delete s.metadata.license;
    s.metadata.tags = 'not-an-array';
    const result = spec.validateFleetSpec(s);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'metadata.license'));
    assert.ok(result.errors.some((e) => e.path === 'metadata.tags'));
  });

  it('requires at least one seat, and at least one supervisory seat', () => {
    const empty = validSpec();
    empty.seats = [];
    assert.ok(spec.validateFleetSpec(empty).errors.some((e) => e.path === 'seats'));

    const noSupervisory = validSpec();
    noSupervisory.seats = noSupervisory.seats.map((s) => ({ ...s, supervisory: false }));
    const result = spec.validateFleetSpec(noSupervisory);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'seats' && /supervisory/.test(e.message)));
  });

  it('rejects a duplicate seatId', () => {
    const s = validSpec();
    s.seats[1].seatId = s.seats[0].seatId;
    const result = spec.validateFleetSpec(s);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'seats' && /unique/.test(e.message)));
  });

  it('accepts a custom role string, not just BUILTIN_ROLES', () => {
    const s = validSpec();
    s.seats[1].role = 'SomeCustomRole';
    assert.equal(spec.validateFleetSpec(s).ok, true);
  });

  it('rejects an unknown recommendedEngine or launchPolicy', () => {
    const badEngine = validSpec();
    badEngine.seats[0].recommendedEngine = 'gpt4';
    assert.ok(spec.validateFleetSpec(badEngine).errors.some((e) => e.path === 'seats[0].recommendedEngine'));

    const badPolicy = validSpec();
    badPolicy.seats[0].launchPolicy = 'eventually';
    assert.ok(spec.validateFleetSpec(badPolicy).errors.some((e) => e.path === 'seats[0].launchPolicy'));
  });

  it('rejects a fallbackEngines entry outside ENGINES, when present', () => {
    const s = validSpec();
    s.seats[1].fallbackEngines = ['claude', 'gpt4'];
    assert.ok(spec.validateFleetSpec(s).errors.some((e) => e.path === 'seats[1].fallbackEngines'));
  });

  it('validates seatGroups when present (min/max/default, min <= max)', () => {
    const s = validSpec();
    s.seatGroups = { Builder: { min: 5, max: 2, default: 3 } };
    const result = spec.validateFleetSpec(s);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'seatGroups.Builder' && /min.*max/.test(e.message)));
  });

  it('rejects a seatGroups default outside its own min/max range (PRR-A R1 BLOCKING 2a)', () => {
    const tooHigh = validSpec();
    tooHigh.seatGroups = { Builder: { min: 2, max: 4, default: 10 } };
    assert.ok(spec.validateFleetSpec(tooHigh).errors.some((e) => e.path === 'seatGroups.Builder.default'));

    const tooLow = validSpec();
    tooLow.seatGroups = { Builder: { min: 2, max: 4, default: 0 } };
    assert.ok(spec.validateFleetSpec(tooLow).errors.some((e) => e.path === 'seatGroups.Builder.default'));

    const inRange = validSpec();
    inRange.seatGroups = { Builder: { min: 2, max: 4, default: 3 } };
    assert.equal(spec.validateFleetSpec(inRange).ok, true);
  });

  it('validates every rule field, by name, and leaves severity\'s vocabulary open', () => {
    const s = validSpec();
    s.rules[0].severity = 'whatever-the-fleet-calls-it';
    delete s.rules[0].enforcedByHook;
    const result = spec.validateFleetSpec(s);
    assert.equal(result.errors.some((e) => e.path === 'rules[0].severity'), false, 'severity has no closed enum');
    assert.ok(result.errors.some((e) => e.path === 'rules[0].enforcedByHook'));
  });

  it('accepts a null charterTemplate (optional), but validates every field when present', () => {
    const nullCharter = validSpec();
    nullCharter.charterTemplate = null;
    assert.equal(spec.validateFleetSpec(nullCharter).ok, true);

    const incomplete = validSpec();
    delete incomplete.charterTemplate.mission;
    incomplete.charterTemplate.successCriteria = [];
    const result = spec.validateFleetSpec(incomplete);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'charterTemplate.mission'));
    assert.ok(result.errors.some((e) => e.path === 'charterTemplate.successCriteria'));
  });

  it('validates every sharedDocuments field, by name', () => {
    const s = validSpec();
    s.sharedDocuments[0] = { name: 'n' };
    const result = spec.validateFleetSpec(s);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'sharedDocuments[0].filename'));
    assert.ok(result.errors.some((e) => e.path === 'sharedDocuments[0].content'));
  });

  it('rejects a path-traversal or absolute sharedDocuments[].filename (PRR-A R1 BLOCKING 1a) — a .fleet.json is an untrusted, community-downloadable artifact', () => {
    for (const badFilename of ['../../.ssh/authorized_keys', '/etc/passwd', '..\\evil.md', '.git/hooks/pre-commit', 'sub/dir.md', '.hidden']) {
      const s = validSpec();
      s.sharedDocuments[0].filename = badFilename;
      const result = spec.validateFleetSpec(s);
      assert.equal(result.ok, false, `expected "${badFilename}" to be rejected`);
      assert.ok(result.errors.some((e) => e.path === 'sharedDocuments[0].filename'), `expected a filename error for "${badFilename}"`);
    }
    const ok = validSpec();
    ok.sharedDocuments[0].filename = 'LANE_QUEUE.md';
    assert.equal(spec.validateFleetSpec(ok).ok, true);
  });

  it('rejects a non-http(s) metadata.homepageUrl (PRR-A R1 BLOCKING 1b)', () => {
    for (const badUrl of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://x.example', '']) {
      const s = validSpec();
      s.metadata.homepageUrl = badUrl;
      assert.ok(spec.validateFleetSpec(s).errors.some((e) => e.path === 'metadata.homepageUrl'), `expected "${badUrl}" to be rejected`);
    }
    const ok = validSpec();
    ok.metadata.homepageUrl = 'http://x.example/path';
    assert.equal(spec.validateFleetSpec(ok).ok, true);
  });

  it('reports every problem in one pass, not just the first', () => {
    const result = spec.validateFleetSpec({ schemaVersion: 'wrong' });
    assert.ok(result.errors.length >= 4, `expected several errors at once, got ${result.errors.length}`);
  });
});

describe('_sanitize / exportFleetSpec — path and secret redaction (#3115)', () => {
  it('drops a key matching the secret-key pattern entirely, case-insensitively', () => {
    const sanitized = spec._sanitize({ sessionToken: 'abc', SECRET: 'x', apiKey: 'y', Password: 'z', keep: 'me' });
    assert.deepEqual(sanitized, { keep: 'me' });
  });

  it('redacts an absolute macOS/Linux home path inside a string, leaving the rest of the sentence intact', () => {
    const sanitized = spec._sanitize('see /Users/someone/Documents/project for details');
    assert.equal(sanitized, 'see <path-redacted> for details');
    const sanitizedHome = spec._sanitize('path: /home/someone/work');
    assert.match(sanitizedHome, /^path: <path-redacted>$/);
  });

  it('never redacts an ordinary string with no path or secret in it', () => {
    assert.equal(spec._sanitize('just a normal sentence'), 'just a normal sentence');
  });

  it('redacts an inline secret/token VALUE inside a string, even with no telling key name (PRR-A R1 WARNING 1)', () => {
    assert.equal(spec._sanitize('my anthropic key is sk-ant-abc123def456ghijklmno, keep it secret'), 'my anthropic key is <token-redacted>, keep it secret');
    assert.equal(spec._sanitize('token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'token: <token-redacted>');
    assert.equal(spec._sanitize('Authorization: Bearer abcdef0123456789'), 'Authorization: <token-redacted>');
    assert.equal(spec._sanitize('no secret here'), 'no secret here');
  });

  it('sanitizes recursively through arrays and nested objects', () => {
    const sanitized = spec._sanitize({ seats: [{ primingPrompt: 'home is /Users/x/y', token: 'leak' }] });
    assert.deepEqual(sanitized, { seats: [{ primingPrompt: 'home is <path-redacted>' }] });
  });

  it('exportFleetSpec sanitizes fleetState and stamps the current schemaVersion', () => {
    const fleetState = {
      metadata: validSpec().metadata,
      seats: [{ seatId: 'pm', displayNameSuffix: '', role: 'PM', supervisory: true, launchPolicy: 'immediate', recommendedEngine: 'claude', primingPrompt: 'base: /Users/x/secret', sessionToken: 'shouldnotleak' }],
      rules: [],
      charterTemplate: null,
      sharedDocuments: []
    };
    const result = spec.exportFleetSpec(fleetState);
    assert.equal(result.ok, true);
    assert.equal(result.spec.schemaVersion, spec.SCHEMA_VERSION);
    assert.equal(result.spec.seats[0].sessionToken, undefined);
    assert.doesNotMatch(result.spec.seats[0].primingPrompt, /\/Users\//);
  });

  it('exportFleetSpec reports validation errors rather than exporting a broken spec', () => {
    const result = spec.exportFleetSpec({ seats: [] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.equal(result.spec, undefined);
  });
});

describe('previewFleetSpecImport — dry-run preview (#3115)', () => {
  it('summarizes seat counts, engine counts, rules, charter, and shared docs without creating anything', () => {
    const result = spec.previewFleetSpecImport(validSpec());
    assert.equal(result.ok, true);
    assert.deepEqual(result.preview, {
      metadata: validSpec().metadata,
      seatCount: 2,
      immediateSeatCount: 1,
      onDemandSeatCount: 1,
      recommendedEngineCounts: { claude: 1, codex: 1 },
      rulesCount: 1,
      charterSummary: { title: 'T', mission: 'M' },
      sharedDocumentNames: ['n']
    });
  });

  it('reports a null charterSummary when charterTemplate is null', () => {
    const s = validSpec();
    s.charterTemplate = null;
    assert.equal(spec.previewFleetSpecImport(s).preview.charterSummary, null);
  });

  it('the preview\'s metadata is a copy — mutating it must never reach the input spec', () => {
    const input = validSpec();
    const result = spec.previewFleetSpecImport(input);
    result.preview.metadata.tags.push('MUTATED');
    assert.deepEqual(input.metadata.tags, ['a']);
  });

  it('refuses to preview an invalid spec', () => {
    const result = spec.previewFleetSpecImport({ seats: [] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.equal(result.preview, undefined);
  });
});

describe('applyFleetSpecImport — provisioning plan (#3115)', () => {
  it('returns a plan with every section copied, not creating anything', () => {
    const input = validSpec();
    const result = spec.applyFleetSpecImport(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.plan.seats, input.seats);
    assert.deepEqual(result.plan.rules, input.rules);
    assert.deepEqual(result.plan.charterTemplate, input.charterTemplate);
    assert.deepEqual(result.plan.sharedDocuments, input.sharedDocuments);
    // Pure: the plan's seats are a COPY, not the same array/objects.
    assert.notEqual(result.plan.seats, input.seats);
    result.plan.seats[0].role = 'mutated';
    assert.equal(input.seats[0].role, 'PM', 'mutating the plan must never mutate the input spec');
  });

  it('returns a null charterTemplate in the plan when the spec has none', () => {
    const s = validSpec();
    s.charterTemplate = null;
    assert.equal(spec.applyFleetSpecImport(s).plan.charterTemplate, null);
  });

  it('deep-copies every nested array/object, never sharing a NESTED reference with the input spec (PRR-A R1 BLOCKING 2b)', () => {
    const input = validSpec();
    input.seatGroups = { Builder: { min: 1, max: 3, default: 2 } };
    const result = spec.applyFleetSpecImport(input);

    result.plan.seats[1].fallbackEngines.push('MUTATED');
    assert.deepEqual(input.seats[1].fallbackEngines, ['claude'], 'mutating a plan seat\'s nested array must never reach the input spec');

    result.plan.metadata.tags.push('MUTATED');
    assert.deepEqual(input.metadata.tags, ['a'], 'mutating the plan\'s metadata.tags must never reach the input spec');

    result.plan.charterTemplate.successCriteria.push('MUTATED');
    assert.deepEqual(input.charterTemplate.successCriteria, ['done'], 'mutating the plan\'s charter must never reach the input spec');

    result.plan.seatGroups.Builder.default = 999;
    assert.equal(input.seatGroups.Builder.default, 2, 'mutating the plan\'s seatGroups must never reach the input spec');
  });

  it('refuses to build a plan from an invalid spec', () => {
    const result = spec.applyFleetSpecImport({ seats: [] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.equal(result.plan, undefined);
  });
});

describe('BUNDLED_FLEET_SPECS — the two flagship reference templates (#3115)', () => {
  it('ships exactly software-factory-10-role and ai-design-agency', () => {
    assert.deepEqual(Object.keys(spec.BUNDLED_FLEET_SPECS).sort(), ['ai-design-agency', 'software-factory-10-role']);
  });

  it('every bundled spec passes validateFleetSpec on its own', () => {
    for (const [id, bundled] of Object.entries(spec.BUNDLED_FLEET_SPECS)) {
      const result = spec.validateFleetSpec(bundled);
      assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.errors)}`);
    }
  });

  it('software-factory-10-role seats exactly the 10 TC-Lane-* roles', () => {
    const roster = spec.BUNDLED_FLEET_SPECS['software-factory-10-role'].seats.map((s) => s.role);
    assert.equal(roster.length, 10);
    assert.equal(roster.filter((r) => r === 'Builder').length, 4);
    assert.equal(roster.filter((r) => r === 'PRR').length, 2);
    assert.ok(roster.includes('PM') && roster.includes('Architect') && roster.includes('Integrator') && roster.includes('Observer'));
  });

  it('ai-design-agency demonstrates a custom (non-builtin) role string', () => {
    const roster = spec.BUNDLED_FLEET_SPECS['ai-design-agency'].seats.map((s) => s.role);
    const customRoles = roster.filter((r) => !spec.BUILTIN_ROLES.includes(r));
    assert.ok(customRoles.length > 0, 'expected at least one custom role to exercise that path');
    assert.ok(customRoles.includes('ArtDir') || customRoles.includes('Critic'));
  });

  it('every bundled spec has exactly one supervisory (PM) seat', () => {
    for (const bundled of Object.values(spec.BUNDLED_FLEET_SPECS)) {
      assert.equal(bundled.seats.filter((s) => s.supervisory).length, 1);
    }
  });

  it('bundled specs are DEEPLY frozen — every nested array/object too, not just the top level (PRR-A R1 BLOCKING 2b)', () => {
    assert.ok(Object.isFrozen(spec.BUNDLED_FLEET_SPECS));
    for (const bundled of Object.values(spec.BUNDLED_FLEET_SPECS)) {
      assert.ok(Object.isFrozen(bundled));
      assert.ok(Object.isFrozen(bundled.seats), 'the seats ARRAY itself must be frozen');
      assert.throws(() => bundled.seats.push({ evil: true }), TypeError, 'pushing to a frozen array must throw, not silently no-op');
      for (const seat of bundled.seats) {
        assert.ok(Object.isFrozen(seat), `seat ${seat.seatId} must be frozen`);
        if (seat.fallbackEngines) assert.ok(Object.isFrozen(seat.fallbackEngines), `seat ${seat.seatId}.fallbackEngines must be frozen`);
      }
      assert.ok(Object.isFrozen(bundled.metadata) && Object.isFrozen(bundled.metadata.tags));
      assert.ok(Object.isFrozen(bundled.rules));
      for (const rule of bundled.rules) assert.ok(Object.isFrozen(rule));
      if (bundled.charterTemplate) {
        assert.ok(Object.isFrozen(bundled.charterTemplate));
        assert.ok(Object.isFrozen(bundled.charterTemplate.successCriteria));
      }
      assert.ok(Object.isFrozen(bundled.sharedDocuments));
      for (const doc of bundled.sharedDocuments) assert.ok(Object.isFrozen(doc));
    }
  });

  it('a bundled spec can round-trip through previewFleetSpecImport and applyFleetSpecImport', () => {
    for (const bundled of Object.values(spec.BUNDLED_FLEET_SPECS)) {
      assert.equal(spec.previewFleetSpecImport(bundled).ok, true);
      assert.equal(spec.applyFleetSpecImport(bundled).ok, true);
    }
  });
});

describe('getEcosystemDirectoryInfo (#3115)', () => {
  it('returns a tangleclaw.com marketplace URL and description', () => {
    const info = spec.getEcosystemDirectoryInfo();
    assert.match(info.marketplaceUrl, /^https:\/\/tangleclaw\.com\//);
    assert.equal(typeof info.description, 'string');
    assert.ok(info.description.length > 0);
  });
});

// v6.6.0 Wave 1 (#3194, Car V660-W1-A, Ruling A1042): the "1.1" Fleet Pack
// (Plane A) schema and its four portability guardrails (PG-1..PG-4).

/** A minimal, otherwise-valid "1.1" spec: validSpec() plus authorityClass per seat and symbolic seatIds. */
function validSpecV11() {
  const s = validSpec();
  s.schemaVersion = spec.FLEETPACK_SCHEMA_VERSION;
  s.seats[0].authorityClass = 'coordinator';
  s.seats[1].authorityClass = 'builder';
  return s;
}

describe('validateFleetSpec — schemaVersion "1.1" and backward compatibility (#3194)', () => {
  it('accepts a minimal, well-formed "1.1" spec', () => {
    assert.deepEqual(spec.validateFleetSpec(validSpecV11()), { ok: true, errors: [] });
  });

  it('exposes SUPPORTED_SCHEMA_VERSIONS as exactly ["1.0", "1.1"]', () => {
    assert.deepEqual(spec.SUPPORTED_SCHEMA_VERSIONS, ['1.0', '1.1']);
    assert.equal(spec.FLEETPACK_SCHEMA_VERSION, '1.1');
  });

  it('still rejects a schemaVersion outside the supported set, naming both', () => {
    const s = validSpec();
    s.schemaVersion = '2.0';
    const result = spec.validateFleetSpec(s);
    assert.equal(result.ok, false);
    const err = result.errors.find((e) => e.path === 'schemaVersion');
    assert.ok(err && /1\.0/.test(err.message) && /1\.1/.test(err.message));
  });

  it('a "1.0" spec with a numeric or Medusa-suffixed seatId still validates (PG-1 is additive to "1.1" only)', () => {
    const s = validSpec();
    s.seats[0].seatId = '42';
    s.seats[1].seatId = 'tc-lane-pm-80246dee';
    assert.equal(spec.validateFleetSpec(s).ok, true, 'PG-1 must not retroactively tighten "1.0"');
  });

  it('a "1.0" spec needs no authorityClass at all (PG-3 is additive to "1.1" only)', () => {
    assert.equal(spec.validateFleetSpec(validSpec()).ok, true);
  });

  it('every existing BUNDLED_FLEET_SPECS entry still validates unchanged', () => {
    for (const [id, bundled] of Object.entries(spec.BUNDLED_FLEET_SPECS)) {
      assert.equal(bundled.schemaVersion, '1.0', `${id} must still declare "1.0"`);
      assert.equal(spec.validateFleetSpec(bundled).ok, true, id);
    }
  });
});

describe('PG-1 — symbolic seatId addressing on a "1.1" spec (#3194)', () => {
  it('rejects a raw numeric seatId', () => {
    const s = validSpecV11();
    s.seats[0].seatId = '42';
    const result = spec.validateFleetSpec(s);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'seats[0].seatId' && /PG-1/.test(e.message)));
  });

  it('rejects a seatId carrying a runtime Medusa workspace suffix', () => {
    for (const badId of ['tc-lane-pm-80246dee', 'tc-lane-pm-3cc41bf8', 'observer-DEADBEEF']) {
      const s = validSpecV11();
      s.seats[0].seatId = badId;
      assert.ok(spec.validateFleetSpec(s).errors.some((e) => e.path === 'seats[0].seatId' && /PG-1/.test(e.message)), `expected "${badId}" to be rejected`);
    }
  });

  it('accepts an ordinary symbolic seatId', () => {
    const s = validSpecV11();
    s.seats[0].seatId = 'pm';
    assert.equal(spec.validateFleetSpec(s).ok, true);
  });

  it('rejects a seatId whose 8-character tail is purely numeric too (PRR-B R2 BLOCKING, #3194) — a real random 8-hex Medusa suffix can itself be all-digit, so an all-numeric tail is not proof of a human-chosen sequence number', () => {
    for (const badId of ['seat-80246642', 'sprint-20261124', 'node-00000012']) {
      const s = validSpecV11();
      s.seats[0].seatId = badId;
      assert.ok(spec.validateFleetSpec(s).errors.some((e) => e.path === 'seats[0].seatId' && /PG-1/.test(e.message)), `expected "${badId}" to be rejected as a potential Medusa suffix`);
    }
  });

  it('still accepts a short, genuinely symbolic numeric suffix that never reaches the 8-character length this guardrail checks', () => {
    for (const okId of ['builder-1', 'lane-02', 'observer-z']) {
      const s = validSpecV11();
      s.seats[0].seatId = okId;
      assert.equal(spec.validateFleetSpec(s).ok, true, `expected "${okId}" to be accepted`);
    }
  });
});

describe('PG-3 — explicit authorityClass declarations on a "1.1" spec (#3194)', () => {
  it('requires a recognized authorityClass per seat', () => {
    const missing = validSpecV11();
    delete missing.seats[0].authorityClass;
    assert.ok(spec.validateFleetSpec(missing).errors.some((e) => e.path === 'seats[0].authorityClass' && /PG-3/.test(e.message)));

    const unrecognized = validSpecV11();
    unrecognized.seats[0].authorityClass = 'overlord';
    assert.ok(spec.validateFleetSpec(unrecognized).errors.some((e) => e.path === 'seats[0].authorityClass'));
  });

  it('exposes AUTHORITY_CLASSES as exactly the six named classes', () => {
    assert.deepEqual(spec.AUTHORITY_CLASSES.slice().sort(), ['architect', 'builder', 'coordinator', 'integrator', 'observer', 'reviewer']);
  });

  it('accepts every declared authority class', () => {
    for (const authorityClass of spec.AUTHORITY_CLASSES) {
      const s = validSpecV11();
      s.seats[0].authorityClass = authorityClass;
      assert.equal(spec.validateFleetSpec(s).ok, true, authorityClass);
    }
  });
});

describe('PG-4 — Plane A / Plane B separation (#3194)', () => {
  it('rejects a "1.1" spec carrying a top-level instanceBinding or instanceBindings key', () => {
    for (const key of ['instanceBinding', 'instanceBindings']) {
      const s = validSpecV11();
      s[key] = { anything: true };
      const result = spec.validateFleetSpec(s);
      assert.equal(result.ok, false, key);
      assert.ok(result.errors.some((e) => e.path === 'instanceBinding' && /PG-4/.test(e.message)), key);
    }
  });

  it('a "1.0" spec is not checked for instanceBinding (PG-4 is additive to "1.1" only)', () => {
    const s = validSpec();
    s.instanceBinding = { anything: true };
    assert.equal(spec.validateFleetSpec(s).ok, true);
  });

  describe('validateInstanceBindingRecord — the Plane B counterpart', () => {
    function validBinding() {
      return { seatId: 'pm', projectId: '111', host: 'cursatory.tail123678.ts.net', boundAt: '2026-11-24T06:00:00.000Z' };
    }

    it('accepts a well-formed binding record', () => {
      assert.deepEqual(spec.validateInstanceBindingRecord(validBinding()), { ok: true, errors: [] });
    });

    it('a raw numeric/Medusa-suffixed projectId is fine here — PG-1 governs Plane A, not Plane B', () => {
      const b = validBinding();
      b.projectId = '111';
      b.seatId = 'tc-lane-pm-80246dee';
      assert.equal(spec.validateInstanceBindingRecord(b).ok, true);
    });

    it('rejects a non-object record without throwing', () => {
      for (const bad of [null, undefined, 'nope', 42, []]) {
        const result = spec.validateInstanceBindingRecord(bad);
        assert.equal(result.ok, false);
        assert.ok(result.errors.length >= 1);
      }
    });

    it('requires every field, by name', () => {
      const result = spec.validateInstanceBindingRecord({});
      assert.equal(result.ok, false);
      for (const field of ['seatId', 'projectId', 'host', 'boundAt']) {
        assert.ok(result.errors.some((e) => e.path === field), `expected an error for "${field}"`);
      }
    });

    it('rejects a boundAt that is not a parseable date string', () => {
      const b = validBinding();
      b.boundAt = 'not-a-date';
      assert.ok(spec.validateInstanceBindingRecord(b).errors.some((e) => e.path === 'boundAt'));
    });

    it('rejects a boundAt that Date.parse accepts but is not strict ISO-8601 (R-Gate R2 WARNING, PRR-A/Architect, #3194)', () => {
      for (const nonIso of ['November 24, 2026', '11/24/2026', '2026-11-24']) {
        const b = validBinding();
        b.boundAt = nonIso;
        assert.ok(spec.validateInstanceBindingRecord(b).errors.some((e) => e.path === 'boundAt'), `expected "${nonIso}" to be rejected despite Date.parse accepting it`);
      }
    });

    it('rejects an impossible calendar date that Date.parse silently normalizes instead of rejecting (R-Gate R4 WARNING, PRR-A, #3194)', () => {
      for (const impossible of ['2024-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-02-29T00:00:00Z']) {
        const b = validBinding();
        b.boundAt = impossible;
        assert.ok(spec.validateInstanceBindingRecord(b).errors.some((e) => e.path === 'boundAt'), `expected "${impossible}" to be rejected (2026 is not a leap year; Feb 30 and month 13 do not exist)`);
      }
      // A REAL leap day must still be accepted.
      const b = validBinding();
      b.boundAt = '2024-02-29T00:00:00Z';
      assert.equal(spec.validateInstanceBindingRecord(b).ok, true, '2024 is a leap year; Feb 29 is valid');
    });
  });
});

describe('exportFleetPackBlueprint — PG-2 logical path tokens + Plane A dry-run export (#3194)', () => {
  /** A fleetState input shaped like exportFleetSpec's own parameter, carrying a live seatId, host paths, and a secret — everything a Plane A blueprint must either rewrite or drop. */
  function v11FleetState() {
    return {
      metadata: validSpec().metadata,
      seats: [
        {
          seatId: 'pm', displayNameSuffix: '', role: 'PM', supervisory: true, launchPolicy: 'immediate',
          recommendedEngine: 'claude', authorityClass: 'coordinator',
          primingPrompt: 'shared docs live at /Users/jasonvaughan/Documents/Projects/Shared and your own workspace is ~/.tangleclaw/workspaces/pm',
          sessionToken: 'shouldnotleak'
        },
        {
          seatId: 'builder-a', displayNameSuffix: 'Builder A', role: 'Builder', supervisory: false, launchPolicy: 'on-demand',
          recommendedEngine: 'codex', authorityClass: 'builder'
        }
      ],
      rules: [],
      charterTemplate: null,
      sharedDocuments: []
    };
  }

  it('stamps schemaVersion "1.1" and sanitizes like exportFleetSpec (secret keys dropped)', () => {
    const result = spec.exportFleetPackBlueprint(v11FleetState());
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.schemaVersion, spec.FLEETPACK_SCHEMA_VERSION);
    assert.equal(result.blueprint.seats[0].sessionToken, undefined);
  });

  it('substitutes a recognized fleetSharedDir/seatWorkspaceDir with their logical tokens', () => {
    const result = spec.exportFleetPackBlueprint(v11FleetState(), {
      fleetSharedDir: '/Users/jasonvaughan/Documents/Projects/Shared',
      seatWorkspaceDir: '~/.tangleclaw/workspaces/pm'
    });
    assert.equal(result.ok, true);
    const prompt = result.blueprint.seats[0].primingPrompt;
    assert.match(prompt, /\$\{FLEET_SHARED_DIR\}/);
    assert.match(prompt, /\$\{SEAT_WORKSPACE_DIR\}/);
    assert.doesNotMatch(prompt, /\/Users\//);
    assert.doesNotMatch(prompt, /~\//);
  });

  it('strips a ~-relative home path even with no logical-token options given', () => {
    const result = spec.exportFleetPackBlueprint(v11FleetState());
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.blueprint.seats[0].primingPrompt, /~\//);
    assert.match(result.blueprint.seats[0].primingPrompt, /<path-redacted>/);
  });

  it('strips non-home absolute Unix/macOS paths that _PATH_RE does not cover (R-Gate R2, PRR-A/Architect, #3194)', () => {
    for (const leak of ['/opt/private/secret', '/var/lib/tangleclaw', '/tmp/scratch', '/etc/tangleclaw.conf', '/private/tmp/leak', '/srv/data', '/mnt/share', '/Volumes/External/notes', '/Applications/TangleClaw.app', '/Library/LaunchAgents/x', '/usr/local/bin/tc', '/bin/sh', '/sbin/launchd']) {
      const fleetState = v11FleetState();
      fleetState.seats[0].primingPrompt = `see ${leak} for details`;
      const result = spec.exportFleetPackBlueprint(fleetState);
      assert.equal(result.ok, true, leak);
      assert.doesNotMatch(result.blueprint.seats[0].primingPrompt, new RegExp(leak.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), `expected "${leak}" to be redacted`);
      assert.match(result.blueprint.seats[0].primingPrompt, /<path-redacted>/, leak);
    }
  });

  it('strips ANY absolute multi-segment path, not just an enumerated root allowlist (R-Gate R4 BLOCKING, PRR-A/PRR-B/Architect, #3194) -- /root and an arbitrary custom root were missed by the R2 allowlist', () => {
    for (const leak of ['/root/.ssh/id_ed25519', '/root/.ssh/id_rsa', '/srv/custom/secret', '/data/secret/file']) {
      const fleetState = v11FleetState();
      fleetState.seats[0].primingPrompt = `see ${leak} for details`;
      const result = spec.exportFleetPackBlueprint(fleetState);
      assert.equal(result.ok, true, leak);
      assert.doesNotMatch(result.blueprint.seats[0].primingPrompt, new RegExp(leak.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), `expected "${leak}" to be redacted`);
      assert.match(result.blueprint.seats[0].primingPrompt, /<path-redacted>/, leak);
    }
  });

  it('never redacts a URL (masked out before path matching, restored after) or an already-substituted logical path token', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'see https://example.com/a/b for details, and the shared doc at /Users/jasonvaughan/Documents/Projects/Shared/README.md';
    const result = spec.exportFleetPackBlueprint(fleetState, { fleetSharedDir: '/Users/jasonvaughan/Documents/Projects/Shared' });
    assert.equal(result.ok, true);
    assert.match(result.blueprint.seats[0].primingPrompt, /https:\/\/example\.com\/a\/b/, 'a URL must never be redacted');
    assert.match(result.blueprint.seats[0].primingPrompt, /\$\{FLEET_SHARED_DIR\}\/README\.md/, 'a logical token substitution must survive intact, not get re-redacted');
  });

  it('redacts an absolute path embedded with no whitespace/quote boundary before it (R-Gate R5 BLOCKING, PRR-A/PRR-B, #3194) -- the boundary-character approach from R5 missed exactly this shape', () => {
    for (const embedded of ['config=/root/.ssh/id_ed25519', 'path:/opt/secret/file', 'KEY=/var/lib/tangleclaw,other=1']) {
      const fleetState = v11FleetState();
      fleetState.seats[0].primingPrompt = embedded;
      const result = spec.exportFleetPackBlueprint(fleetState);
      assert.equal(result.ok, true, embedded);
      assert.match(result.blueprint.seats[0].primingPrompt, /<path-redacted>/, `expected "${embedded}" to redact its embedded path`);
    }
  });

  it('still never redacts a URL even when it has no whitespace/quote before it either (the fix that closes the R5 gap must not reopen the URL exclusion)', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'see(https://example.com/a/b)for details';
    const result = spec.exportFleetPackBlueprint(fleetState);
    assert.equal(result.ok, true);
    assert.match(result.blueprint.seats[0].primingPrompt, /https:\/\/example\.com\/a\/b/);
  });

  it('preserves a MULTI-segment relative suffix after a logical path token intact (R-Gate R6 WARNING, PRR-A/PRR-B, #3194) -- dropping the boundary requirement in R6 made the suffix itself look like a 2+-segment absolute path', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'docs at /Users/jasonvaughan/Documents/Projects/Shared/docs/architecture/README.md';
    const result = spec.exportFleetPackBlueprint(fleetState, { fleetSharedDir: '/Users/jasonvaughan/Documents/Projects/Shared' });
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.seats[0].primingPrompt, 'docs at ${FLEET_SHARED_DIR}/docs/architecture/README.md');
  });

  it('preserves a multi-segment suffix after seatWorkspaceDir too, and still redacts an UNRELATED absolute path in the same string', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'workspace at ~/.tangleclaw/workspaces/pm/logs/today.log, unrelated leak at /opt/private/secret';
    const result = spec.exportFleetPackBlueprint(fleetState, { seatWorkspaceDir: '~/.tangleclaw/workspaces/pm' });
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.seats[0].primingPrompt, 'workspace at ${SEAT_WORKSPACE_DIR}/logs/today.log, unrelated leak at <path-redacted>');
  });

  it('redacts a file:// URL\'s own host path -- a file:// URL is never a "safe remote URL" the way http(s) is (R-Gate R8 BLOCKING, PRR-A/PRR-B, #3194)', () => {
    for (const leak of ['file:///root/.ssh/id_ed25519', 'file:///etc/passwd', 'file:///Users/alice/.env']) {
      const fleetState = v11FleetState();
      fleetState.seats[0].primingPrompt = `see ${leak} for details`;
      const result = spec.exportFleetPackBlueprint(fleetState);
      assert.equal(result.ok, true, leak);
      assert.match(result.blueprint.seats[0].primingPrompt, /^see file:\/\/<path-redacted> for details$/, `expected "${leak}"'s path to redact while keeping the file:// prefix`);
    }
  });

  it('redacts a URL\'s own userinfo credentials, including a generic password _INLINE_TOKEN_RE would never recognize on its own (R-Gate R8 BLOCKING, PRR-A/PRR-B, #3194)', () => {
    const ghpLeak = spec.exportFleetPackBlueprint((() => {
      const s = v11FleetState();
      s.seats[0].primingPrompt = 'clone https://user:ghp_1234567890123456789012345@github.com/org/repo for details';
      return s;
    })());
    assert.equal(ghpLeak.ok, true);
    assert.equal(ghpLeak.blueprint.seats[0].primingPrompt, 'clone https://<credentials-redacted>@github.com/org/repo for details');
    assert.doesNotMatch(ghpLeak.blueprint.seats[0].primingPrompt, /ghp_/);

    const genericPasswordLeak = spec.exportFleetPackBlueprint((() => {
      const s = v11FleetState();
      s.seats[0].primingPrompt = 'login at https://admin:hunter2@example.com/a/b';
      return s;
    })());
    assert.equal(genericPasswordLeak.ok, true);
    assert.equal(genericPasswordLeak.blueprint.seats[0].primingPrompt, 'login at https://<credentials-redacted>@example.com/a/b');
    assert.doesNotMatch(genericPasswordLeak.blueprint.seats[0].primingPrompt, /hunter2/);
  });

  it('redacts a known secret-shaped token inside a URL\'s own query string', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'see https://example.com/api?token=ghp_1234567890123456789012345 for details';
    const result = spec.exportFleetPackBlueprint(fleetState);
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.seats[0].primingPrompt, 'see https://example.com/api?token=<token-redacted> for details');
  });

  it('redacts a URL\'s own sensitive query/fragment parameters by NAME, even when the value has no recognizable secret shape (R-Gate R8 BLOCKING, PRR-A, #3194)', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'see https://example.com/hook?password=hunter2&access_token=abc123&mode=live#client_secret=xyz for details';
    const result = spec.exportFleetPackBlueprint(fleetState);
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.seats[0].primingPrompt, 'see https://example.com/hook?password=<token-redacted>&access_token=<token-redacted>&mode=live#client_secret=<token-redacted> for details');
  });

  it('redacts a BARE "key" query parameter too, not just a compound api_key/private_key/etc. (R-Gate R10 BLOCKING, PRR-A/Architect, #3194) -- the Google Maps API convention', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'see https://maps.example/api?key=AIzaSyExampleSecret1234567890&format=json for details';
    const result = spec.exportFleetPackBlueprint(fleetState);
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.seats[0].primingPrompt, 'see https://maps.example/api?key=<token-redacted>&format=json for details');
  });

  it('never redacts a benign parameter name that merely CONTAINS a sensitive keyword as a substring, for ANY keyword in the list (R-Gate R11/R12 WARNING, PRR-B, #3194) -- every keyword must be component-bounded, not just "key"', () => {
    for (const benign of ['monkey=banana', 'keyboard=us', 'keynote=1', 'design=logo', 'author=alice']) {
      const fleetState = v11FleetState();
      fleetState.seats[0].primingPrompt = `see https://example.com/x?${benign} for details`;
      const result = spec.exportFleetPackBlueprint(fleetState);
      assert.equal(result.ok, true, benign);
      assert.equal(result.blueprint.seats[0].primingPrompt, `see https://example.com/x?${benign} for details`, `expected "${benign}" to survive untouched`);
    }
  });

  it('stops a sensitive parameter\'s value at a semicolon delimiter too, not just & and # (R-Gate R11 WARNING, PRR-B, #3194)', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'see https://example.com/hook?password=hunter2;mode=live for details';
    const result = spec.exportFleetPackBlueprint(fleetState);
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.seats[0].primingPrompt, 'see https://example.com/hook?password=<token-redacted>;mode=live for details');
  });

  it('redacts a Google-style API key or AWS access key id anywhere in a string, even with no telling query-parameter name around it', () => {
    const googleKey = spec.exportFleetPackBlueprint((() => {
      const s = v11FleetState();
      s.seats[0].primingPrompt = 'the key is AIzaSyExampleGoogleApiKey1234567890 -- keep it secret';
      return s;
    })());
    assert.equal(googleKey.ok, true);
    assert.equal(googleKey.blueprint.seats[0].primingPrompt, 'the key is <token-redacted> -- keep it secret');

    const awsKey = spec.exportFleetPackBlueprint((() => {
      const s = v11FleetState();
      s.seats[0].primingPrompt = 'access key: AKIAIOSFODNN7EXAMPLE';
      return s;
    })());
    assert.equal(awsKey.ok, true);
    assert.equal(awsKey.blueprint.seats[0].primingPrompt, 'access key: <token-redacted>');
  });

  it('a plain, credential-free https:// URL is still never touched (the credential/file:// fixes must not reopen the URL exclusion)', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'see https://example.com/a/b for details';
    const result = spec.exportFleetPackBlueprint(fleetState);
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.seats[0].primingPrompt, 'see https://example.com/a/b for details');
  });

  it('never leaks a directory\'s real suffix when it merely shares a PREFIX with the configured fleetSharedDir/seatWorkspaceDir (Critic BLOCKING finding, #3194)', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'see /Users/jasonvaughan/Documents/Projects/SharedArchive-2026/secretproject for details';
    const result = spec.exportFleetPackBlueprint(fleetState, { fleetSharedDir: '/Users/jasonvaughan/Documents/Projects/Shared' });
    assert.equal(result.ok, true);
    const prompt = result.blueprint.seats[0].primingPrompt;
    // The false-prefix match must fall through to the generic redaction, never a tokenized leak of the real suffix.
    assert.doesNotMatch(prompt, /secretproject/, 'the unrelated directory\'s real name must never survive in the exported blueprint');
    assert.doesNotMatch(prompt, /SharedArchive/, 'a directory that only shares a PREFIX with fleetSharedDir must not be treated as a match');
    assert.match(prompt, /<path-redacted>/);
  });

  it('still substitutes the configured dir when it is immediately followed by a path separator, not just end-of-string', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].primingPrompt = 'docs at /Users/jasonvaughan/Documents/Projects/Shared/README.md';
    const result = spec.exportFleetPackBlueprint(fleetState, { fleetSharedDir: '/Users/jasonvaughan/Documents/Projects/Shared' });
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.seats[0].primingPrompt, 'docs at ${FLEET_SHARED_DIR}/README.md');
  });

  it('refuses a fleetState whose live seatId trips PG-1, rather than exporting a leaking blueprint', () => {
    const fleetState = v11FleetState();
    fleetState.seats[0].seatId = 'tc-lane-pm-80246dee';
    const result = spec.exportFleetPackBlueprint(fleetState);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /PG-1/.test(e.message)));
  });

  it('refuses a fleetState missing authorityClass (PG-3)', () => {
    const fleetState = v11FleetState();
    delete fleetState.seats[1].authorityClass;
    const result = spec.exportFleetPackBlueprint(fleetState);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /PG-3/.test(e.message)));
  });
});

describe('Round-trip: TC-Lane-* (10-seat SDLC) and TV-* (8-seat Creative Studio) through Plane A export + import (#3194)', () => {
  /** The 10-seat TC-Lane-* shape, as a pre-export fleetState (mirrors BUNDLED_FLEET_SPECS['software-factory-10-role'] but with authorityClass per seat, "1.1"-ready). */
  function tcLaneFleetState() {
    const base = structuredClone(spec.BUNDLED_FLEET_SPECS['software-factory-10-role']);
    const authorityByRole = { PM: 'coordinator', Architect: 'architect', Builder: 'builder', PRR: 'reviewer', Integrator: 'integrator', Observer: 'observer' };
    base.seats.forEach((s) => { s.authorityClass = authorityByRole[s.role]; });
    return base;
  }

  /** The 8-seat TV-* (TangleVision) shape, as a pre-export fleetState (mirrors BUNDLED_FLEET_SPECS['ai-design-agency']); custom roles (ArtDir, Critic) map onto the closest standing authority class. */
  function tvFleetState() {
    const base = structuredClone(spec.BUNDLED_FLEET_SPECS['ai-design-agency']);
    const authorityByRole = { PM: 'coordinator', ArtDir: 'architect', Builder: 'builder', Critic: 'reviewer', Integrator: 'integrator', Observer: 'observer' };
    base.seats.forEach((s) => { s.authorityClass = authorityByRole[s.role]; });
    return base;
  }

  for (const [label, buildFleetState, expectedSeatCount] of [['TC-Lane-* (10-seat SDLC)', tcLaneFleetState, 10], ['TV-* (8-seat Creative Studio)', tvFleetState, 8]]) {
    it(`${label}: exports a guardrail-clean "1.1" blueprint and round-trips through preview + apply`, () => {
      const exported = spec.exportFleetPackBlueprint(buildFleetState());
      assert.equal(exported.ok, true, JSON.stringify(exported.errors));
      assert.equal(exported.blueprint.schemaVersion, '1.1');
      assert.equal(exported.blueprint.seats.length, expectedSeatCount);

      // Guardrail contract: every seat survives export with a recognized authorityClass and a seatId PG-1 still accepts.
      for (const seat of exported.blueprint.seats) {
        assert.ok(spec.AUTHORITY_CLASSES.includes(seat.authorityClass), `${seat.seatId}: authorityClass`);
        assert.doesNotMatch(seat.seatId, /^\d+$/, `${seat.seatId}: must not be numeric`);
        assert.doesNotMatch(seat.seatId, /-[0-9a-f]{8}$/i, `${seat.seatId}: must not carry a Medusa suffix`);
      }

      const preview = spec.previewFleetSpecImport(exported.blueprint);
      assert.equal(preview.ok, true);
      assert.equal(preview.preview.seatCount, expectedSeatCount);

      const applied = spec.applyFleetSpecImport(exported.blueprint);
      assert.equal(applied.ok, true);
      assert.equal(applied.plan.seats.length, expectedSeatCount);
      // Semantic equivalence: role/authorityClass/supervisory topology survives the full round-trip untouched.
      assert.deepEqual(
        applied.plan.seats.map((s) => ({ role: s.role, authorityClass: s.authorityClass, supervisory: s.supervisory })),
        exported.blueprint.seats.map((s) => ({ role: s.role, authorityClass: s.authorityClass, supervisory: s.supervisory }))
      );
    });
  }

  it('does not mutate production fixtures: BUNDLED_FLEET_SPECS stays "1.0" and frozen after building both "1.1" fleetStates', () => {
    tcLaneFleetState();
    tvFleetState();
    assert.equal(spec.BUNDLED_FLEET_SPECS['software-factory-10-role'].schemaVersion, '1.0');
    assert.ok(Object.isFrozen(spec.BUNDLED_FLEET_SPECS['software-factory-10-role']));
    assert.equal(spec.BUNDLED_FLEET_SPECS['software-factory-10-role'].seats[0].authorityClass, undefined, 'the frozen fixture itself must never gain a field a structuredClone-based copy added');
  });
});
