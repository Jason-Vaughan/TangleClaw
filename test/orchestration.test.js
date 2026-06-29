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

describe('orchestration.detectHardcodedKeys (TB-2 #189)', () => {
  // A realistic-shaped LiteLLM master key literal (sk- + long random tail).
  const MASTER_LITERAL = 'sk-1234567890abcdefABCDEF_secret';

  it('flags a hardcoded LiteLLM-shaped key literal in launch.env', () => {
    const engine = { id: 'aider', launch: { env: { OPENAI_API_KEY: MASTER_LITERAL } } };
    const findings = orchestration.detectHardcodedKeys(engine);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].envVar, 'OPENAI_API_KEY');
    assert.match(findings[0].reason, /keyRef/);
  });

  it('redacts the secret — the raw value never appears in a finding', () => {
    const engine = { id: 'aider', launch: { env: { OPENAI_API_KEY: MASTER_LITERAL } } };
    const [finding] = orchestration.detectHardcodedKeys(engine);
    assert.ok(!finding.redacted.includes(MASTER_LITERAL));
    assert.ok(!finding.redacted.includes('secret'));
    assert.match(finding.redacted, /redacted, \d+ chars/);
    // No field on the finding leaks the full secret.
    assert.ok(!JSON.stringify(finding).includes(MASTER_LITERAL));
  });

  it('flags LITELLM_MASTER_KEY by name even if its value is differently shaped', () => {
    const engine = { id: 'x', launch: { env: { LITELLM_MASTER_KEY: 'whatever-value' } } };
    const findings = orchestration.detectHardcodedKeys(engine);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].envVar, 'LITELLM_MASTER_KEY');
  });

  it('returns [] for an empty launch.env (the sanctioned clean config)', () => {
    const engine = { id: 'aider', launch: { env: {} } };
    assert.deepEqual(orchestration.detectHardcodedKeys(engine), []);
  });

  it('does not flag non-key env values', () => {
    const engine = { id: 'x', launch: { env: { FOO: 'bar', OPENAI_API_BASE: 'http://monad-1.tail123678.ts.net:4000/v1' } } };
    assert.deepEqual(orchestration.detectHardcodedKeys(engine), []);
  });

  it('does not flag a keyRef-style value (refs are not secrets)', () => {
    // A keyRef lives in a profile, not engine env, but assert it would not
    // false-trigger even if one appeared here — it does not match the key shape.
    const engine = { id: 'x', launch: { env: { SOME_REF: 'file:~/.config/monad/tangleclaw-aider.key' } } };
    assert.deepEqual(orchestration.detectHardcodedKeys(engine), []);
  });

  it('handles a profile with no launch or no env (no throw, [])', () => {
    assert.deepEqual(orchestration.detectHardcodedKeys({ id: 'x' }), []);
    assert.deepEqual(orchestration.detectHardcodedKeys({ id: 'x', launch: {} }), []);
    assert.deepEqual(orchestration.detectHardcodedKeys(null), []);
  });

  it('the sanctioned path is silent while the footgun path warns', () => {
    // Base config is clean (env: {}); the scoped key arrives via the overlay,
    // which detectHardcodedKeys never sees (it scans the pre-overlay base).
    const base = { id: 'aider', launch: { shellCommand: 'aider', args: [], env: {} } };
    assert.deepEqual(orchestration.detectHardcodedKeys(base), []);

    const overlaid = orchestration.applyLaunchOverlay(base, {
      baseUrl: 'http://monad-1.tail123678.ts.net:4000/v1',
      model: 'openai/qwen2.5-coder-32b-fp16',
      apiKey: MASTER_LITERAL, // resolved scoped key — legitimately injected
      profileName: 'direct'
    });
    // The resolved scoped key IS present in the overlaid launch env (acceptance #1)…
    assert.equal(overlaid.launch.env.OPENAI_API_KEY, MASTER_LITERAL);
    // …yet the base config the guard scans stays clean (acceptance #3).
    assert.deepEqual(orchestration.detectHardcodedKeys(base), []);

    // A footgun config (literal hardcoded in the base) IS flagged (acceptance #2).
    const footgun = { id: 'aider', launch: { env: { OPENAI_API_KEY: MASTER_LITERAL } } };
    assert.equal(orchestration.detectHardcodedKeys(footgun).length, 1);
  });
});

describe('orchestration.assertOpenAICompatEndpoint (TB-4 #359)', () => {
  it('accepts a well-formed http base URL with the /v1 convention', () => {
    assert.deepEqual(
      orchestration.assertOpenAICompatEndpoint('http://monad-1.tail123678.ts.net:4000/v1'),
      { ok: true }
    );
  });

  it('accepts https and a base mounted at a non-/v1 path (the suffix is convention, not required)', () => {
    assert.deepEqual(orchestration.assertOpenAICompatEndpoint('https://api.example.com'), { ok: true });
    assert.deepEqual(orchestration.assertOpenAICompatEndpoint('http://localhost:4000/openai/v1'), { ok: true });
  });

  it('refuses an empty / whitespace / null / non-string baseUrl', () => {
    assert.equal(orchestration.assertOpenAICompatEndpoint('').ok, false);
    assert.equal(orchestration.assertOpenAICompatEndpoint('   ').ok, false);
    assert.equal(orchestration.assertOpenAICompatEndpoint(null).ok, false);
    assert.equal(orchestration.assertOpenAICompatEndpoint(42).ok, false);
  });

  it('refuses a bare word that does not parse as a URL', () => {
    assert.match(orchestration.assertOpenAICompatEndpoint('not-a-real-url').reason, /not a valid URL/);
  });

  it('refuses a non-http(s) scheme (ftp, ws)', () => {
    assert.match(orchestration.assertOpenAICompatEndpoint('ftp://host/x').reason, /scheme/);
    assert.match(orchestration.assertOpenAICompatEndpoint('ws://host:4000').reason, /scheme/);
  });
});

describe('orchestration.resolveLaunchProfile — OpenAI-compat refusal (TB-4 #359)', () => {
  it('refuses a bound profile whose baseUrl is not OpenAI-compat (distinct from the null-baseUrl case)', () => {
    const profiles = { profiles: { bad: { baseUrl: 'ftp://nope/x', model: 'openai/x', keyRef: 'env:TB1_TEST_KEY' } } };
    const r = orchestration.resolveLaunchProfile({ orchestrationProfile: 'bad' }, {}, profiles, okKeyDeps);
    assert.equal(r.refused, true);
    assert.match(r.reason, /not OpenAI-compat/);
  });

  it('still resolves a valid OpenAI-compat endpoint unchanged', () => {
    const r = orchestration.resolveLaunchProfile({ orchestrationProfile: 'direct' }, {}, PROFILES, okKeyDeps);
    assert.equal(r.baseUrl, 'http://monad-1.tail123678.ts.net:4000/v1');
    assert.equal(r.refused, undefined);
  });
});

describe('orchestration — OpenAI-compat guarantee: endpoint swap needs no harness change (TB-4 #359)', () => {
  const engine = { id: 'aider', launch: { shellCommand: 'aider', args: ['--foo'], env: { EXISTING: '1' } } };

  function overlayFor(baseUrl) {
    const profiles = { profiles: { p: { baseUrl, model: 'openai/qwen', keyRef: 'env:TB1_TEST_KEY' } } };
    const resolved = orchestration.resolveLaunchProfile({ orchestrationProfile: 'p' }, {}, profiles, okKeyDeps);
    assert.ok(!resolved.refused, `expected ${baseUrl} to resolve`);
    return orchestration.applyLaunchOverlay(engine, resolved);
  }

  it('swapping base_url between two OpenAI-compat endpoints changes ONLY OPENAI_API_BASE', () => {
    const a = overlayFor('http://monad-1.tail123678.ts.net:4000/v1');
    const b = overlayFor('https://other-host.ts.net/v1');

    // The --model injection is identical — no endpoint-specific arg leaks.
    assert.deepEqual(a.launch.args, b.launch.args);
    // Same env key SET across endpoints; only OPENAI_API_BASE's value differs.
    assert.deepEqual(Object.keys(a.launch.env).sort(), Object.keys(b.launch.env).sort());
    assert.notEqual(a.launch.env.OPENAI_API_BASE, b.launch.env.OPENAI_API_BASE);
    assert.equal(a.launch.env.OPENAI_API_KEY, b.launch.env.OPENAI_API_KEY);
    const { OPENAI_API_BASE: _a, ...restA } = a.launch.env;
    const { OPENAI_API_BASE: _b, ...restB } = b.launch.env;
    assert.deepEqual(restA, restB); // everything except the base URL is identical
  });

  it('injects only the three generic OpenAI knobs — nothing engine/profile-specific leaks', () => {
    const out = overlayFor('http://monad-1.tail123678.ts.net:4000/v1');
    // Beyond the engine's own env, the only added keys are the two OpenAI vars.
    assert.deepEqual(
      Object.keys(out.launch.env).filter((k) => k !== 'EXISTING').sort(),
      ['OPENAI_API_BASE', 'OPENAI_API_KEY']
    );
    // The only arg added is `--model <model>` — no profile name, no endpoint flag.
    assert.deepEqual(out.launch.args, ['--foo', '--model', 'openai/qwen']);
  });
});
