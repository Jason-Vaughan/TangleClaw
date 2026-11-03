'use strict';

// #2604 Slice 1 (v5.61.0 Car 61-C, Architect Ruling A2604): the scoped
// `projectsDir` default for a scratch `TANGLECLAW_HOME`, via
// `lib/scratch-home-defaults.js`. Pure functions -- real path strings, no
// env var or filesystem access, since the module itself never reads either.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const shd = require('../lib/scratch-home-defaults');

const REAL_HOME = os.homedir();

describe('isScratchHome', () => {
  it('is false for the operator\'s canonical <home>/.tangleclaw', () => {
    assert.equal(shd.isScratchHome(path.join(REAL_HOME, '.tangleclaw'), REAL_HOME), false);
  });

  it('is true for a scratch/temp TANGLECLAW_HOME override', () => {
    assert.equal(shd.isScratchHome('/tmp/tc-scratch-xyz', REAL_HOME), true);
  });

  it('is false even when TANGLECLAW_HOME literally reproduces the canonical path (the Ruling\'s own framing)', () => {
    // An explicit override that happens to equal the default is not scratch --
    // only a RESOLVED path other than the canonical one is.
    assert.equal(shd.isScratchHome(`${REAL_HOME}/.tangleclaw`, REAL_HOME), false);
  });

  it('normalizes before comparing -- a trailing slash or relative segment must not read as scratch', () => {
    assert.equal(shd.isScratchHome(path.join(REAL_HOME, '.tangleclaw') + '/', REAL_HOME), false);
    assert.equal(shd.isScratchHome(path.join(REAL_HOME, 'sibling', '..', '.tangleclaw'), REAL_HOME), false);
  });

  it('is false (fails closed, never scratch) for missing or non-string input', () => {
    assert.equal(shd.isScratchHome(undefined, REAL_HOME), false);
    assert.equal(shd.isScratchHome('/tmp/x', undefined), false);
    assert.equal(shd.isScratchHome('', ''), false);
  });
});

describe('resolveDefaultProjectsDir', () => {
  it('returns the canonical tilde default, unchanged, for a non-scratch home', () => {
    const r = shd.resolveDefaultProjectsDir(path.join(REAL_HOME, '.tangleclaw'), REAL_HOME);
    assert.equal(r.isScratch, false);
    assert.equal(r.defaultProjectsDir, '~/Projects');
    assert.equal(r.defaultProjectsDir, shd.CANONICAL_PROJECTS_DIR_DEFAULT);
  });

  it('scopes the default inside TANGLECLAW_HOME for a scratch home', () => {
    const r = shd.resolveDefaultProjectsDir('/tmp/tc-scratch-xyz', REAL_HOME);
    assert.equal(r.isScratch, true);
    assert.equal(r.defaultProjectsDir, path.join('/tmp/tc-scratch-xyz', 'projects'));
  });

  it('the scoped default is always an absolute path under TANGLECLAW_HOME, never a bare relative name', () => {
    const r = shd.resolveDefaultProjectsDir('/tmp/tc-scratch-xyz', REAL_HOME);
    assert.ok(path.isAbsolute(r.defaultProjectsDir));
    assert.ok(r.defaultProjectsDir.startsWith('/tmp/tc-scratch-xyz'));
  });
});
