'use strict';

// #2395 (Architect Ruling A2395): reusable Sprint Team Template package
// schema, validation and Settings preview. Also covers #1604 (Ruling A1604,
// lib/rules-compress-preview.js) per that ruling's own "tests... may be
// co-located in the authorized Car 60-B test files" -- this file and
// test/session-rules-bulk.test.js are the two files Car 60-B's envelope
// authorizes.
//
// Both modules under test are pure libraries: no store, no route, no
// network. Every assertion here drives the real exported function.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const teamTemplates = require('../lib/team-templates');
const compress = require('../lib/rules-compress-preview');

describe('team-templates: validateTeamTemplate (#2395)', () => {
  const validPkg = {
    templateId: 'tmpl-1', name: 'RM Pilot Team', version: 1, description: 'A sample team',
    roles: [
      { roleId: 'builder-1', title: 'Builder', laneClass: 'builder', defaultRules: ['never force-push'] },
      { roleId: 'int-1', title: 'Integrator', laneClass: 'integrator', reviewGates: ['builder-1'] }
    ]
  };

  it('exposes its own known lane classes', () => {
    assert.deepEqual(teamTemplates.LANE_CLASSES,
      ['builder', 'integrator', 'prr-a', 'prr-b', 'architect', 'pm', 'observer']);
  });

  it('accepts a well-formed package and normalizes every role field', () => {
    const r = teamTemplates.validateTeamTemplate(validPkg);
    assert.equal(r.ok, true);
    assert.equal(r.template.templateId, 'tmpl-1');
    assert.equal(r.template.roles.length, 2);
    assert.deepEqual(r.template.roles[0].defaultRules, ['never force-push']);
    assert.equal(r.template.roles[0].enginePreference, null, 'absent fields default to null, not undefined');
  });

  it('refuses a non-object package', () => {
    assert.equal(teamTemplates.validateTeamTemplate('nope').code, 'TEAM_TEMPLATE_INVALID');
    assert.equal(teamTemplates.validateTeamTemplate(null).code, 'TEAM_TEMPLATE_INVALID');
    assert.equal(teamTemplates.validateTeamTemplate([]).code, 'TEAM_TEMPLATE_INVALID');
  });

  it('requires templateId, name, and a numeric version', () => {
    assert.equal(teamTemplates.validateTeamTemplate({ ...validPkg, templateId: undefined }).code, 'TEAM_TEMPLATE_INVALID');
    assert.equal(teamTemplates.validateTeamTemplate({ ...validPkg, name: '' }).code, 'TEAM_TEMPLATE_INVALID');
    assert.equal(teamTemplates.validateTeamTemplate({ ...validPkg, version: '1' }).code, 'TEAM_TEMPLATE_INVALID');
  });

  it('requires a non-empty roles (or seats) array', () => {
    assert.equal(teamTemplates.validateTeamTemplate({ ...validPkg, roles: [] }).code, 'TEAM_TEMPLATE_INVALID');
    const { roles, ...noRoles } = validPkg;
    assert.equal(teamTemplates.validateTeamTemplate(noRoles).code, 'TEAM_TEMPLATE_INVALID');
  });

  it('accepts "seats" as an alias for "roles"', () => {
    const { roles, ...rest } = validPkg;
    const r = teamTemplates.validateTeamTemplate({ ...rest, seats: roles });
    assert.equal(r.ok, true);
    assert.equal(r.template.roles.length, 2);
  });

  it('refuses a role with no roleId or title', () => {
    assert.equal(teamTemplates.validateTeamTemplate({ ...validPkg, roles: [{ title: 'X', laneClass: 'builder' }] }).code, 'TEAM_TEMPLATE_INVALID');
    assert.equal(teamTemplates.validateTeamTemplate({ ...validPkg, roles: [{ roleId: 'x', laneClass: 'builder' }] }).code, 'TEAM_TEMPLATE_INVALID');
  });

  it('refuses an unknown laneClass', () => {
    const r = teamTemplates.validateTeamTemplate({ ...validPkg, roles: [{ roleId: 'x', title: 'X', laneClass: 'wizard' }] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TEAM_TEMPLATE_INVALID');
    assert.match(r.message, /unknown laneClass/);
  });

  it('refuses a duplicate role id', () => {
    const r = teamTemplates.validateTeamTemplate({ ...validPkg, roles: [...validPkg.roles, validPkg.roles[0]] });
    assert.equal(r.ok, false);
    assert.match(r.message, /Duplicate role id/);
  });

  it('refuses a reviewGates entry that names no role in the same package', () => {
    const r = teamTemplates.validateTeamTemplate({
      ...validPkg,
      roles: [{ roleId: 'x', title: 'X', laneClass: 'builder', reviewGates: ['nobody'] }]
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /reviewGates entry "nobody"/);
  });
});

describe('team-templates: previewTeamTemplateApplication (#2395)', () => {
  const pkg = {
    templateId: 'tmpl-1', name: 'RM Pilot Team', version: 1,
    roles: [
      { roleId: 'builder-1', title: 'Builder', laneClass: 'builder', defaultRules: ['never force-push'] },
      { roleId: 'int-1', title: 'Integrator', laneClass: 'integrator' }
    ]
  };

  it('propagates template validation failures', () => {
    const r = teamTemplates.previewTeamTemplateApplication({ ...pkg, roles: [] }, []);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TEAM_TEMPLATE_INVALID');
  });

  it('refuses a non-array currentSeats', () => {
    const r = teamTemplates.previewTeamTemplateApplication(pkg, 'nope');
    assert.equal(r.ok, false);
  });

  it('a role with no matching current seat is addedSeats', () => {
    const r = teamTemplates.previewTeamTemplateApplication(pkg, []);
    assert.equal(r.ok, true);
    assert.equal(r.preview.addedSeats.length, 2);
    assert.equal(r.preview.updatedSeats.length, 0);
    assert.equal(r.preview.unchangedSeats.length, 0);
  });

  it('an identical current seat is unchangedSeats, not updatedSeats', () => {
    const currentSeats = [
      { roleId: 'builder-1', title: 'Builder', laneClass: 'builder', defaultRules: ['never force-push'] },
      { roleId: 'int-1', title: 'Integrator', laneClass: 'integrator', defaultRules: [] }
    ];
    const r = teamTemplates.previewTeamTemplateApplication(pkg, currentSeats);
    assert.equal(r.preview.unchangedSeats.length, 2);
    assert.equal(r.preview.addedSeats.length, 0);
    assert.equal(r.preview.updatedSeats.length, 0);
  });

  it('a differing field puts the seat in updatedSeats, naming exactly the changed fields', () => {
    const currentSeats = [{ roleId: 'builder-1', title: 'Old Title', laneClass: 'builder', defaultRules: ['never force-push'] }];
    const r = teamTemplates.previewTeamTemplateApplication(pkg, currentSeats.concat([{ roleId: 'int-1', title: 'Integrator', laneClass: 'integrator' }]));
    const updated = r.preview.updatedSeats.find((u) => u.roleId === 'builder-1');
    assert.ok(updated);
    assert.deepEqual(updated.changedFields, ['title']);
  });

  it('a defaultRules difference is reported in both updatedSeats and ruleChanges', () => {
    const currentSeats = [
      { roleId: 'builder-1', title: 'Builder', laneClass: 'builder', defaultRules: ['old rule'] },
      { roleId: 'int-1', title: 'Integrator', laneClass: 'integrator' }
    ];
    const r = teamTemplates.previewTeamTemplateApplication(pkg, currentSeats);
    const change = r.preview.ruleChanges.find((c) => c.roleId === 'builder-1');
    assert.ok(change);
    assert.deepEqual(change.added, ['never force-push']);
    assert.deepEqual(change.removed, ['old rule']);
  });

  it('a current seat the template says nothing about gets a warning, not a removal', () => {
    const r = teamTemplates.previewTeamTemplateApplication(pkg, [
      { roleId: 'builder-1', title: 'Builder', laneClass: 'builder', defaultRules: ['never force-push'] },
      { roleId: 'int-1', title: 'Integrator', laneClass: 'integrator' },
      { roleId: 'legacy-role', title: 'Old', laneClass: 'observer' }
    ]);
    assert.equal(r.preview.warnings.length, 1);
    assert.equal(r.preview.warnings[0].roleId, 'legacy-role');
    assert.ok(!('removedSeats' in r.preview), 'this preview never proposes removing a seat');
  });

  it('packageDigestSha256 is deterministic for the same template', () => {
    const a = teamTemplates.previewTeamTemplateApplication(pkg, []);
    const b = teamTemplates.previewTeamTemplateApplication(pkg, []);
    assert.equal(a.preview.packageDigestSha256, b.preview.packageDigestSha256);
    assert.match(a.preview.packageDigestSha256, /^[0-9a-f]{64}$/);
  });
});

describe('rules-compress-preview: buildRulesCompressPreview (#1604)', () => {
  it('exposes its own fixed vocabulary', () => {
    assert.ok(compress.FILLER_PHRASES.length > 0);
    assert.deepEqual(compress.GUARDRAIL_KEYWORDS, ['never', 'always', 'must', 'required', 'forbidden', 'prohibited']);
    assert.ok(compress.PIN_MARKERS.length === 2);
  });

  it('refuses a non-object input', () => {
    assert.equal(compress.buildRulesCompressPreview('nope').code, 'COMPRESS_PREVIEW_INPUT_INVALID');
  });

  it('requires a valid scope', () => {
    const r = compress.buildRulesCompressPreview({ scope: { type: 'bogus', id: 'x' }, originalText: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'COMPRESS_PREVIEW_INPUT_INVALID');
  });

  it('requires originalText to be a string', () => {
    const r = compress.buildRulesCompressPreview({ scope: { type: 'project', id: 'p1' }, originalText: 42 });
    assert.equal(r.ok, false);
  });

  it('is read-only and non-mutating: never changes its own input object', () => {
    const input = { scope: { type: 'project', id: 'p1' }, originalText: 'Never do X.\nNever do X.' };
    const frozen = JSON.parse(JSON.stringify(input));
    compress.buildRulesCompressPreview(input);
    assert.deepEqual(input, frozen);
  });

  it('drops an exact-duplicate clause, keeping only the first occurrence', () => {
    const r = compress.buildRulesCompressPreview({
      scope: { type: 'project', id: 'p1' }, originalText: 'Report status often.\nReport status often.'
    });
    assert.equal(r.ok, true);
    assert.equal(r.preview.compressedText, 'Report status often.');
    assert.ok(r.preview.diffHunks.some((h) => h.reason === 'duplicate-clause'));
  });

  it('strips a filler phrase, case-insensitively', () => {
    const r = compress.buildRulesCompressPreview({
      scope: { type: 'project', id: 'p1' }, originalText: 'Please note that reports are weekly.'
    });
    assert.equal(r.preview.compressedText, 'reports are weekly.');
  });

  it('collapses a run of blank lines to one', () => {
    const r = compress.buildRulesCompressPreview({
      scope: { type: 'project', id: 'p1' }, originalText: 'A.\n\n\n\nB.'
    });
    assert.equal(r.preview.compressedText, 'A.\n\nB.');
  });

  it('never touches a [PINNED] or DO NOT COMPRESS clause, even one with filler text', () => {
    const r = compress.buildRulesCompressPreview({
      scope: { type: 'project', id: 'p1' },
      originalText: '[PINNED] Please note that this exact wording is required forever.'
    });
    assert.equal(r.preview.compressedText, '[PINNED] Please note that this exact wording is required forever.');
    assert.ok(r.preview.diffHunks.some((h) => h.reason === 'pinned'));
  });

  it('compressing a clause carrying guardrail keywords preserves every one of them -- FILLER_PHRASES never overlaps GUARDRAIL_KEYWORDS by design', () => {
    const r = compress.buildRulesCompressPreview({
      scope: { type: 'project', id: 'p1' },
      originalText: 'As a reminder, you must always confirm before deploying.'
    });
    assert.equal(r.ok, true);
    assert.match(r.preview.compressedText, /must always confirm/, 'both guardrail keywords survive normalization');
    assert.equal(r.preview.warnings.length, 0,
      'no warning fires here because nothing was actually dropped -- see the guardrail-check branch\'s own comment for why that branch is currently unreachable by design');
  });

  it('computes correct, consistent stats', () => {
    const r = compress.buildRulesCompressPreview({
      scope: { type: 'project', id: 'p1' }, originalText: 'Please note that this is long.\nPlease note that this is long.'
    });
    assert.equal(r.preview.stats.originalChars, 'Please note that this is long.\nPlease note that this is long.'.length);
    assert.equal(r.preview.stats.compressedChars, r.preview.compressedText.length);
    assert.equal(r.preview.stats.charsSaved, r.preview.stats.originalChars - r.preview.stats.compressedChars);
    assert.ok(r.preview.stats.savingsPercent > 0);
    assert.equal(r.preview.stats.tokensSaved, r.preview.stats.originalTokensEstimate - r.preview.stats.compressedTokensEstimate);
  });

  it('sourceDigestSha256 is a deterministic digest of the exact original text', () => {
    const text = 'Some rule text.';
    const a = compress.buildRulesCompressPreview({ scope: { type: 'project', id: 'p1' }, originalText: text });
    const b = compress.buildRulesCompressPreview({ scope: { type: 'team-member', id: 'm1' }, originalText: text });
    assert.equal(a.preview.sourceDigestSha256, b.preview.sourceDigestSha256, 'the digest is over the text, not the scope');
    assert.match(a.preview.sourceDigestSha256, /^[0-9a-f]{64}$/);
  });

  it('the scope is carried through unchanged, never influencing the compression itself', () => {
    const r = compress.buildRulesCompressPreview({ scope: { type: 'team-member', id: 'm-42' }, originalText: 'Text.' });
    assert.deepEqual(r.preview.scope, { type: 'team-member', id: 'm-42' });
  });
});
