'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const h1 = require('../lib/v6/h1-branding-policy');

// v6 (#2987, V6-15 / H1, Car V60-T2-W1-D): the three-surface branding &
// attribution policy, its defaults, and its two hard locks.

describe('defaultBrandingPolicy (#2987 deliverable 1)', () => {
  it('defaults uiWatermark and generatedDocAttribution true, gitCommitTrailer false', () => {
    assert.deepEqual(h1.defaultBrandingPolicy(), {
      'branding.uiWatermark': true,
      'branding.gitCommitTrailer': false,
      'branding.generatedDocAttribution': true
    });
  });

  it('every key in the default policy is one of the declared BRANDING_KEYS', () => {
    for (const key of Object.keys(h1.defaultBrandingPolicy())) {
      assert.ok(h1.BRANDING_KEYS.includes(key), key);
    }
  });
});

describe('classifyAttributionTarget', () => {
  it('classifies a .tangleclaw/ path as generated', () => {
    assert.equal(h1.classifyAttributionTarget('.tangleclaw/continuity/report.md'), 'generated');
  });

  it('classifies application source, tests, and configs as application', () => {
    assert.equal(h1.classifyAttributionTarget('server.js'), 'application');
    assert.equal(h1.classifyAttributionTarget('test/foo.test.js'), 'application');
    assert.equal(h1.classifyAttributionTarget('.testament.toml'), 'application');
    assert.equal(h1.classifyAttributionTarget('docs/some-report.md'), 'application');
  });

  it('fails closed to application for an unrecognized path', () => {
    assert.equal(h1.classifyAttributionTarget('literally/anything/else.txt'), 'application');
  });
});

describe('effectiveGitCommitTrailer — hard lock on client/external repos', () => {
  it('is false by default on a first-party repo with no stored value', () => {
    assert.equal(h1.effectiveGitCommitTrailer(undefined, 'first-party'), false);
  });

  it('is true on a first-party repo that explicitly opted in', () => {
    assert.equal(h1.effectiveGitCommitTrailer(true, 'first-party'), true);
  });

  it('is HARD-LOCKED false on a client/external repo even when stored true', () => {
    assert.equal(h1.effectiveGitCommitTrailer(true, 'client-external'), false);
  });

  it('is false on a client/external repo with no stored value', () => {
    assert.equal(h1.effectiveGitCommitTrailer(undefined, 'client-external'), false);
  });
});

describe('effectiveGeneratedDocAttribution — permanently forbidden on application paths', () => {
  it('is true by default for a .tangleclaw/ path with no stored value', () => {
    assert.equal(h1.effectiveGeneratedDocAttribution(undefined, '.tangleclaw/continuity/report.md'), true);
  });

  it('respects an explicit false override on a .tangleclaw/ path', () => {
    assert.equal(h1.effectiveGeneratedDocAttribution(false, '.tangleclaw/continuity/report.md'), false);
  });

  it('is PERMANENTLY FORBIDDEN (false) on application source even when stored true', () => {
    assert.equal(h1.effectiveGeneratedDocAttribution(true, 'server.js'), false);
    assert.equal(h1.effectiveGeneratedDocAttribution(true, 'test/foo.test.js'), false);
    assert.equal(h1.effectiveGeneratedDocAttribution(true, '.testament.toml'), false);
  });
});

describe('effectiveUiWatermark', () => {
  it('defaults true with no stored value', () => {
    assert.equal(h1.effectiveUiWatermark(undefined), true);
  });

  it('respects an explicit false override', () => {
    assert.equal(h1.effectiveUiWatermark(false), false);
  });
});

describe('validateBrandingPolicyChange', () => {
  it('refuses an unknown key', () => {
    const res = h1.validateBrandingPolicyChange('branding.notARealKey', true);
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'UNKNOWN_BRANDING_KEY');
  });

  it('allows uiWatermark changes unconditionally', () => {
    assert.equal(h1.validateBrandingPolicyChange('branding.uiWatermark', false).allowed, true);
    assert.equal(h1.validateBrandingPolicyChange('branding.uiWatermark', true).allowed, true);
  });

  it('allows gitCommitTrailer: true on a first-party repo', () => {
    const res = h1.validateBrandingPolicyChange('branding.gitCommitTrailer', true, { repoClassification: 'first-party' });
    assert.equal(res.allowed, true);
  });

  it('refuses gitCommitTrailer: true on a client/external repo', () => {
    const res = h1.validateBrandingPolicyChange('branding.gitCommitTrailer', true, { repoClassification: 'client-external' });
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'GIT_COMMIT_TRAILER_LOCKED_CLIENT_EXTERNAL');
  });

  it('allows gitCommitTrailer: false regardless of repo classification', () => {
    assert.equal(h1.validateBrandingPolicyChange('branding.gitCommitTrailer', false, { repoClassification: 'client-external' }).allowed, true);
  });

  it('allows generatedDocAttribution: true for a .tangleclaw/ target path', () => {
    const res = h1.validateBrandingPolicyChange('branding.generatedDocAttribution', true, { targetPath: '.tangleclaw/x.md' });
    assert.equal(res.allowed, true);
  });

  it('refuses generatedDocAttribution: true for an application target path', () => {
    const res = h1.validateBrandingPolicyChange('branding.generatedDocAttribution', true, { targetPath: 'server.js' });
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'DOC_ATTRIBUTION_FORBIDDEN_ON_APPLICATION_PATH');
  });

  it('allows generatedDocAttribution: true with no targetPath given (nothing to check yet)', () => {
    const res = h1.validateBrandingPolicyChange('branding.generatedDocAttribution', true);
    assert.equal(res.allowed, true);
  });

  it('allows generatedDocAttribution: false regardless of targetPath', () => {
    assert.equal(h1.validateBrandingPolicyChange('branding.generatedDocAttribution', false, { targetPath: 'server.js' }).allowed, true);
  });
});

describe('REPO_CLASSIFICATIONS', () => {
  it('names exactly first-party and client-external', () => {
    assert.deepEqual(h1.REPO_CLASSIFICATIONS, ['first-party', 'client-external']);
  });
});
