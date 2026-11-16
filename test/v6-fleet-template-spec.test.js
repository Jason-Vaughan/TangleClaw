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

  it('bundled specs are frozen — read-only, never mutated by a caller', () => {
    assert.ok(Object.isFrozen(spec.BUNDLED_FLEET_SPECS));
    for (const bundled of Object.values(spec.BUNDLED_FLEET_SPECS)) assert.ok(Object.isFrozen(bundled));
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
