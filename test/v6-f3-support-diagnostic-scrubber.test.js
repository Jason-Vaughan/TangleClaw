'use strict';

/*
 * v6 (#2999, V6-29 / F3, Car V61-W1-D): the support diagnostic bundle
 * scrubber, redaction verifier, issue preview and consent-gated submission
 * (`lib/v6/f3-support-diagnostic-scrubber.js`). Small tier: pure logic; the
 * submission adapter is an injected fake.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  BUNDLE_SCHEMA, MAX_LOG_LINES, MAX_LOG_LINE, MAX_CODES, CONSENT_SCOPE, DETECTORS,
  scrub, findSecrets, buildBundle, previewIssue, submitIssue
} = require('../lib/v6/f3-support-diagnostic-scrubber');

const NOW = 1_800_000_000_000;

/** Secrets, each paired with the detector expected to catch it. */
const SECRETS = [
  ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'],
  ['url-credentials', 'https://alice:hunter2@git.example.com/x'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['github-token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['github-token', 'github_pat_11ABCDEFG0abcdefghijklmn'],
  ['api-key', 'sk-ant-api03-abcdefghijklmnop'],
  ['api-key', 'AKIAIOSFODNN7EXAMPLE'],
  ['api-key', 'xoxb-1234567890-abcdefghij'],
  ['bearer', 'Authorization header Bearer abc.def.ghi'],
  ['key-value', 'password=hunter2'],
  ['key-value', '{"token": "s3cr3t-value"}'],
  ['key-value', "client_secret: 'abc123'"],
  ['query-secret', 'GET /cb?code=1&access_token=abc123&x=1'],
  ['email', 'contact ntehosting@gmail.com today'],
  ['tailnet-host', 'https://cursatory.tail123678.ts.net:8443/plans'],
  ['ipv4', 'peer 192.168.1.20 refused'],
  ['home-path', 'at /Users/jason/Documents/x.js'],
  ['home-path', 'at C:\\Users\\jason\\x.js'],
  ['phone', 'call (415) 555-0123']
];

describe('constants', () => {
  it('pins the bundle bounds, schema and consent scope', () => {
    assert.equal(BUNDLE_SCHEMA, 1);
    assert.equal(MAX_LOG_LINES, 40);
    assert.equal(MAX_LOG_LINE, 300);
    assert.equal(MAX_CODES, 30);
    assert.equal(CONSENT_SCOPE, 'github-issue');
  });

  it('every detector has a unique name and a global pattern', () => {
    const names = DETECTORS.map((d) => d.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(DETECTORS.every((d) => d.pattern.global));
  });
});

describe('scrub and findSecrets', () => {
  for (const [detector, text] of SECRETS) {
    it(`${detector} is found, then scrubbed away: ${text.slice(0, 32)}`, () => {
      assert.ok(findSecrets(text).includes(detector), `findSecrets(${text}) = ${findSecrets(text)}`);
      const out = scrub(text);
      assert.deepEqual(findSecrets(out), [], `left in: ${out}`);
    });
  }

  it('removes the secret material itself, not just a label', () => {
    const out = scrub('{"token": "s3cr3t-value", "password":"hunter2"} ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    for (const leaked of ['s3cr3t-value', 'hunter2', 'ghp_abc']) assert.ok(!out.includes(leaked), `${leaked} in ${out}`);
  });

  it('is idempotent', () => {
    for (const [, text] of SECRETS) assert.equal(scrub(scrub(text)), scrub(text), text);
  });

  it('leaves ordinary diagnostics alone', () => {
    const plain = 'version 6.1.0 on darwin arm64; 3 sessions; 2026-11-11T20:59:01.387Z; epoch 1800000000000; PORT_CONFLICT';
    assert.equal(scrub(plain), plain);
    assert.deepEqual(findSecrets(plain), []);
  });
});

describe('buildBundle', () => {
  const INPUT = {
    version: '6.1.0', platform: 'darwin', mode: 'loopback',
    healthCodes: ['DB_OK', 'bad code', 42, 'PORTHUB_OK'],
    errorCodes: ['PORT_CONFLICT'],
    logLines: ['started on /Users/jason/tc', 'token=abc123 refused', 'peer 10.0.0.2'],
    prompt: 'my private plans', env: { GH_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, config: { secret: 'x' }
  };

  it('keeps only allowlisted fields and drops malformed codes', () => {
    const bundle = buildBundle(INPUT, { now: NOW });
    assert.deepEqual(Object.keys(bundle).sort(), ['createdAt', 'errorCodes', 'healthCodes', 'mode', 'platform', 'schema', 'version']);
    assert.deepEqual(bundle.healthCodes, ['DB_OK', 'PORTHUB_OK']);
    assert.equal(bundle.createdAt, new Date(NOW).toISOString());
    assert.ok(!JSON.stringify(bundle).includes('private plans'));
    assert.ok(!JSON.stringify(bundle).includes('ghp_'));
  });

  it('includes scrubbed log lines only when asked', () => {
    const bundle = buildBundle(INPUT, { includeLogs: true, now: NOW });
    assert.deepEqual(bundle.logLines, ['started on /[HOME]/tc', 'token=[REDACTED] refused', 'peer [IP]']);
  });

  it('bounds lines, line length, code count and free-text fields', () => {
    const bundle = buildBundle({
      version: 'v'.repeat(1000), mode: 'm'.repeat(1000),
      healthCodes: Array.from({ length: 100 }, (_, i) => `C${i}`),
      logLines: Array.from({ length: 100 }, () => 'x'.repeat(5000))
    }, { includeLogs: true, now: NOW });
    assert.equal(bundle.version.length, 80);
    assert.equal(bundle.mode.length, 40);
    assert.equal(bundle.healthCodes.length, MAX_CODES);
    assert.equal(bundle.logLines.length, MAX_LOG_LINES);
    assert.ok(bundle.logLines.every((l) => l.length === MAX_LOG_LINE));
  });

  it('a secret straddling the length cut is still scrubbed, not left as a short prefix', () => {
    const line = `${'x'.repeat(MAX_LOG_LINE - 6)} ghp_abcdefghijklmnopqrstuvwxyz0123456789`;
    const [kept] = buildBundle({ logLines: [line] }, { includeLogs: true, now: NOW }).logLines;
    assert.ok(!kept.includes('ghp_'), kept.slice(-20));
  });

  it('defaults missing fields to "unknown" and refuses a non-object', () => {
    const bundle = buildBundle({}, { now: NOW });
    assert.equal(bundle.version, 'unknown');
    assert.deepEqual(bundle.errorCodes, []);
    assert.throws(() => buildBundle(null), TypeError);
  });

  it('every built bundle passes the redaction verifier', () => {
    const lines = SECRETS.map(([, text]) => text);
    const bundle = buildBundle({ version: SECRETS[3][1], logLines: lines }, { includeLogs: true, now: NOW });
    assert.deepEqual(findSecrets(JSON.stringify(bundle)), []);
  });
});

describe('previewIssue', () => {
  const bundle = buildBundle({ version: '6.1.0', errorCodes: ['PORT_CONFLICT'] }, { now: NOW });

  it('renders a fenced JSON body, a coded title and a digest over all three', () => {
    const p = previewIssue(bundle, 'Jason-Vaughan/TangleClaw');
    assert.equal(p.title, '[Support] PORT_CONFLICT');
    assert.match(p.body, /^```json\n\{/);
    const expected = crypto.createHash('sha256').update(`${p.repo}\n${p.title}\n${p.body}`).digest('hex');
    assert.equal(p.digest, expected);
    assert.equal(previewIssue({ ...bundle, errorCodes: [] }, 'a/b').title, '[Support] DIAGNOSTIC_REPORT');
  });

  it('a log line with backticks cannot close the code fence', () => {
    const tricky = buildBundle({ logLines: ['```\n# Injected heading\n```'] }, { includeLogs: true, now: NOW });
    const p = previewIssue(tricky, 'a/b');
    const fence = p.body.match(/^`+/)[0];
    assert.ok(fence.length > 3, 'the fence grows past the longest inner backtick run');
    assert.equal(p.body.split('\n').filter((line) => line.startsWith(fence)).length, 2, 'only the opening and closing fence lines');
  });

  it('refuses a malformed repo or bundle', () => {
    for (const repo of ['', 'noslash', 'a/b/c', 'a b/c', null]) assert.throws(() => previewIssue(bundle, repo), TypeError, String(repo));
    assert.throws(() => previewIssue(null, 'a/b'), TypeError);
  });
});

describe('submitIssue', () => {
  const bundle = buildBundle({ version: '6.1.0', errorCodes: ['PORT_CONFLICT'] }, { now: NOW });
  const preview = previewIssue(bundle, 'org/repo');
  const consent = { approved: true, scope: 'github-issue', repo: 'org/repo', bundleDigest: preview.digest, expiresAt: NOW + 1000, consentId: 'c1' };

  /** A fake adapter recording every call. */
  function adapter(result = { issueUrl: 'https://github.com/org/repo/issues/1' }) {
    const calls = [];
    const fn = async (issue) => { calls.push(issue); if (result instanceof Error) throw result; return result; };
    return { fn, calls };
  }

  it('files exactly the previewed issue with the consent id as the idempotency key', async () => {
    const a = adapter();
    const r = await submitIssue({ preview, consent, adapter: a.fn, allowedRepos: ['org/repo'], now: NOW });
    assert.deepEqual(r, { ok: true, issueUrl: 'https://github.com/org/repo/issues/1' });
    assert.deepEqual(a.calls, [{ repo: 'org/repo', title: preview.title, body: preview.body, idempotencyKey: 'c1' }]);
  });

  it('refuses every consent defect without calling the adapter', async () => {
    const bad = [
      null,
      { ...consent, approved: 'yes' },
      { ...consent, scope: 'github-pr' },
      { ...consent, repo: 'org/other' },
      { ...consent, bundleDigest: 'f'.repeat(64) },
      { ...consent, expiresAt: NOW },
      { ...consent, consentId: '' }
    ];
    for (const c of bad) {
      const a = adapter();
      const r = await submitIssue({ preview, consent: c, adapter: a.fn, allowedRepos: ['org/repo'], now: NOW });
      assert.equal(r.code, 'CONSENT_REQUIRED', JSON.stringify(c));
      assert.equal(a.calls.length, 0);
    }
  });

  it('refuses a repository outside the allowlist', async () => {
    const a = adapter();
    const r = await submitIssue({ preview, consent, adapter: a.fn, allowedRepos: ['org/elsewhere'], now: NOW });
    assert.equal(r.code, 'REPO_NOT_ALLOWED');
    assert.equal(a.calls.length, 0);
  });

  it('refuses a preview edited after consent, including one re-hashed around an unscrubbed secret', async () => {
    const edited = { ...preview, body: preview.body.replace('6.1.0', '6.1.1') };
    const a = adapter();
    assert.equal((await submitIssue({ preview: edited, consent, adapter: a.fn, allowedRepos: ['org/repo'], now: NOW })).code, 'PREVIEW_CHANGED');
    const body = `${preview.body}\npassword=hunter2`;
    const digest = crypto.createHash('sha256').update(`org/repo\n${preview.title}\n${body}`).digest('hex');
    const sneaky = { ...preview, body, digest };
    const r = await submitIssue({ preview: sneaky, consent: { ...consent, bundleDigest: digest }, adapter: a.fn, allowedRepos: ['org/repo'], now: NOW });
    assert.equal(r.code, 'PREVIEW_CHANGED');
    assert.equal(a.calls.length, 0);
  });

  it('a consent id files at most once', async () => {
    const used = new Set();
    const a = adapter();
    assert.equal((await submitIssue({ preview, consent, adapter: a.fn, allowedRepos: ['org/repo'], usedConsentIds: used, now: NOW })).ok, true);
    assert.equal((await submitIssue({ preview, consent, adapter: a.fn, allowedRepos: ['org/repo'], usedConsentIds: used, now: NOW })).code, 'CONSENT_ALREADY_USED');
    assert.equal(a.calls.length, 1);
  });

  it('an adapter that throws or returns no URL is a failed submission, with its error scrubbed', async () => {
    const thrown = await submitIssue({ preview, consent, adapter: adapter(new Error('401 for token=abc123')).fn, allowedRepos: ['org/repo'], now: NOW });
    assert.equal(thrown.code, 'SUBMIT_FAILED');
    assert.ok(!thrown.error.includes('abc123'), thrown.error);
    const empty = await submitIssue({ preview, consent, adapter: adapter({}).fn, allowedRepos: ['org/repo'], now: NOW });
    assert.equal(empty.code, 'SUBMIT_FAILED');
  });

  it('needs an adapter function and an allowlist array', async () => {
    await assert.rejects(() => submitIssue({ preview, consent, allowedRepos: [] }), TypeError);
    await assert.rejects(() => submitIssue({ preview, consent, adapter: async () => ({}) }), TypeError);
  });
});
