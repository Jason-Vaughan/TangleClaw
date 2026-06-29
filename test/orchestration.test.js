'use strict';

/*
 * TB-1 (#357) — launch-binder orchestration resolver.
 *
 * Covers the pure resolver module (lib/orchestration.js): key-ref resolution,
 * profile resolution with its refusal cases (honest degradation, never a
 * silent fallback), and the launch overlay's NO-MUTATION contract (the engine
 * profile is shared/cached by the store — overlaying it in place would leak the
 * injected key + model into every later launch).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const orchestration = require('../lib/orchestration');
const sessions = require('../lib/sessions');

const PROFILES = {
  profiles: {
    direct: {
      baseUrl: 'http://monad-1.tail123678.ts.net:4000/v1',
      model: 'openai/qwen2.5-coder-32b-fp16',
      keyRef: 'env:TB1_TEST_KEY',
      status: 'real'
    },
    'semantic-route': {
      baseUrl: null, // not-yet-landed endpoint
      model: 'openai/auto',
      keyRef: 'env:TB1_TEST_KEY',
      status: 'provisional'
    },
    'no-model': {
      baseUrl: 'http://monad-1.tail123678.ts.net:4000/v1',
      model: null,
      keyRef: 'env:TB1_TEST_KEY'
    }
  }
};

const okKeyDeps = { env: { TB1_TEST_KEY: 'sk-test-123' } };

describe('orchestration.resolveKeyRef', () => {
  it('resolves an env: reference', () => {
    const r = orchestration.resolveKeyRef('env:FOO', { env: { FOO: 'secret' } });
    assert.deepEqual(r, { value: 'secret' });
  });

  it('errors when the env var is unset', () => {
    const r = orchestration.resolveKeyRef('env:MISSING', { env: {} });
    assert.ok(r.error);
    assert.equal(r.value, undefined);
  });

  it('resolves a file: reference and trims trailing whitespace', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb1-key-'));
    const keyFile = path.join(tmp, 'k.key');
    fs.writeFileSync(keyFile, 'sk-file-key\n');
    try {
      const r = orchestration.resolveKeyRef(`file:${keyFile}`);
      assert.deepEqual(r, { value: 'sk-file-key' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('expands a leading ~ in a file: reference', () => {
    // Inject a fake readFile so we can assert the ~ was expanded to homedir.
    let seenPath = null;
    const r = orchestration.resolveKeyRef('file:~/.config/monad/x.key', {
      readFile: (p) => { seenPath = p; return 'sk-home'; }
    });
    assert.deepEqual(r, { value: 'sk-home' });
    assert.equal(seenPath, path.join(os.homedir(), '.config/monad/x.key'));
  });

  it('errors on an empty key file', () => {
    const r = orchestration.resolveKeyRef('file:/whatever', { readFile: () => '   \n' });
    assert.ok(r.error);
  });

  it('errors on an unreadable key file', () => {
    const r = orchestration.resolveKeyRef('file:/nope', {
      readFile: () => { throw new Error('ENOENT'); }
    });
    assert.match(r.error, /unreadable/);
  });

  it('errors on a malformed reference (no scheme separator)', () => {
    assert.ok(orchestration.resolveKeyRef('not-a-ref').error);
  });

  it('errors on an unknown scheme', () => {
    assert.match(orchestration.resolveKeyRef('vault:secret/x').error, /unknown keyRef scheme/);
  });

  it('errors on a null/empty keyRef', () => {
    assert.ok(orchestration.resolveKeyRef(null).error);
    assert.ok(orchestration.resolveKeyRef('').error);
  });
});

describe('orchestration.resolveLaunchProfile', () => {
  it('returns null when the project has no binding (today\'s behavior)', () => {
    assert.equal(
      orchestration.resolveLaunchProfile({ orchestrationProfile: null }, {}, PROFILES, okKeyDeps),
      null
    );
    assert.equal(
      orchestration.resolveLaunchProfile({}, {}, PROFILES, okKeyDeps),
      null
    );
  });

  it('resolves a bound profile to the full (baseUrl, model, apiKey) triple', () => {
    const r = orchestration.resolveLaunchProfile(
      { orchestrationProfile: 'direct' }, {}, PROFILES, okKeyDeps
    );
    assert.deepEqual(r, {
      baseUrl: 'http://monad-1.tail123678.ts.net:4000/v1',
      model: 'openai/qwen2.5-coder-32b-fp16',
      apiKey: 'sk-test-123',
      profileName: 'direct'
    });
  });

  it('refuses an unknown profile name (no silent fallback)', () => {
    const r = orchestration.resolveLaunchProfile(
      { orchestrationProfile: 'ghost' }, {}, PROFILES, okKeyDeps
    );
    assert.equal(r.refused, true);
    assert.match(r.reason, /unknown profile/);
  });

  it('refuses a profile with a null baseUrl (endpoint not yet landed)', () => {
    const r = orchestration.resolveLaunchProfile(
      { orchestrationProfile: 'semantic-route' }, {}, PROFILES, okKeyDeps
    );
    assert.equal(r.refused, true);
    assert.match(r.reason, /baseUrl/);
  });

  it('refuses a profile with no model', () => {
    const r = orchestration.resolveLaunchProfile(
      { orchestrationProfile: 'no-model' }, {}, PROFILES, okKeyDeps
    );
    assert.equal(r.refused, true);
    assert.match(r.reason, /model/);
  });

  it('refuses when the keyRef cannot be resolved', () => {
    const r = orchestration.resolveLaunchProfile(
      { orchestrationProfile: 'direct' }, {}, PROFILES, { env: {} }
    );
    assert.equal(r.refused, true);
    assert.match(r.reason, /key unresolved/);
  });

  it('lets a per-(project,profile) keyRef override win over the profile default', () => {
    const r = orchestration.resolveLaunchProfile(
      { orchestrationProfile: 'direct' },
      { orchestrationKeyRef: 'env:PROJECT_KEY' },
      PROFILES,
      { env: { TB1_TEST_KEY: 'shared', PROJECT_KEY: 'isolated' } }
    );
    assert.equal(r.apiKey, 'isolated');
  });

  it('treats an empty/missing profiles config as no injectable profile', () => {
    const r = orchestration.resolveLaunchProfile(
      { orchestrationProfile: 'direct' }, {}, { profiles: {} }, okKeyDeps
    );
    assert.equal(r.refused, true);
  });
});

describe('orchestration.applyLaunchOverlay', () => {
  const resolved = {
    baseUrl: 'http://monad-1.tail123678.ts.net:4000/v1',
    model: 'openai/qwen2.5-coder-32b-fp16',
    apiKey: 'sk-test-123',
    profileName: 'direct'
  };

  it('appends --model to launch.args and merges OPENAI_* into launch.env', () => {
    const engine = { id: 'aider', launch: { shellCommand: 'aider', args: ['--foo'], env: { EXISTING: '1' } } };
    const out = orchestration.applyLaunchOverlay(engine, resolved);
    assert.deepEqual(out.launch.args, ['--foo', '--model', 'openai/qwen2.5-coder-32b-fp16']);
    assert.deepEqual(out.launch.env, {
      EXISTING: '1',
      OPENAI_API_BASE: 'http://monad-1.tail123678.ts.net:4000/v1',
      OPENAI_API_KEY: 'sk-test-123'
    });
    assert.equal(out.launch.shellCommand, 'aider'); // unrelated fields preserved
  });

  it('NEVER mutates the input engine profile (shared cache safety)', () => {
    const engine = { id: 'aider', launch: { shellCommand: 'aider', args: [], env: {} } };
    const argsRef = engine.launch.args;
    const envRef = engine.launch.env;
    const out = orchestration.applyLaunchOverlay(engine, resolved);

    assert.deepEqual(engine.launch.args, []); // original args untouched
    assert.deepEqual(engine.launch.env, {});  // original env untouched
    assert.equal(engine.launch.args, argsRef); // same identity (not reassigned)
    assert.equal(engine.launch.env, envRef);
    assert.notEqual(out.launch.args, argsRef); // overlay produced new arrays/objects
    assert.notEqual(out.launch.env, envRef);
    assert.notEqual(out, engine);
  });

  it('handles an engine profile with no launch.args/env', () => {
    const engine = { id: 'x', launch: { shellCommand: 'x' } };
    const out = orchestration.applyLaunchOverlay(engine, resolved);
    assert.deepEqual(out.launch.args, ['--model', 'openai/qwen2.5-coder-32b-fp16']);
    assert.equal(out.launch.env.OPENAI_API_KEY, 'sk-test-123');
  });
});

describe('orchestration overlay → _buildLaunchCommand integration', () => {
  it('a bound profile injects --model into the launch command', () => {
    const engine = { launch: { shellCommand: 'aider', args: [] }, launchModes: {} };
    const resolved = {
      baseUrl: 'http://monad-1.tail123678.ts.net:4000/v1',
      model: 'openai/qwen2.5-coder-32b-fp16',
      apiKey: 'sk-test-123',
      profileName: 'direct'
    };
    const overlaid = orchestration.applyLaunchOverlay(engine, resolved);
    const cmd = sessions._buildLaunchCommand(overlaid, {}, null);
    assert.equal(cmd, 'aider --model openai/qwen2.5-coder-32b-fp16');
  });

  it('an unbound launch command is byte-identical to today (no injection)', () => {
    const engine = { launch: { shellCommand: 'aider', args: [] }, launchModes: {} };
    const cmd = sessions._buildLaunchCommand(engine, {}, null);
    assert.equal(cmd, 'aider');
  });
});
