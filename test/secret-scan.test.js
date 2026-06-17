'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { scanText } = require('../lib/secret-scan');

describe('secret-scan (CC-4 #343)', () => {
  describe('scanText — high-confidence patterns', () => {
    it('flags an AWS access key id', () => {
      const r = scanText('export AWS_KEY=AKIAIOSFODNN7EXAMPLE more text');
      assert.equal(r.flagged, true);
      assert.ok(r.types.includes('aws-access-key'));
    });

    it('flags a PEM private key block', () => {
      const r = scanText('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...');
      assert.equal(r.flagged, true);
      assert.ok(r.types.includes('private-key'));
    });

    it('flags a Slack token', () => {
      // Assembled from parts on purpose: a contiguous `xoxb-…` literal in a
      // tracked file trips GitHub push protection (it can't tell a test fixture
      // from a real leak). Splitting the prefix keeps the runtime string — and
      // thus this scanner test — intact while keeping the source pushable.
      const r = scanText('slack=' + 'xox' + 'b-123456789012-abcdefghijklmnop');
      assert.equal(r.flagged, true);
      assert.ok(r.types.includes('slack-token'));
    });

    it('flags a classic GitHub PAT', () => {
      const r = scanText('token ghp_' + 'a'.repeat(36));
      assert.equal(r.flagged, true);
      assert.ok(r.types.includes('github-token'));
    });

    it('flags a fine-grained GitHub PAT', () => {
      const r = scanText('github_pat_' + 'A'.repeat(30));
      assert.equal(r.flagged, true);
      assert.ok(r.types.includes('github-token'));
    });

    it('flags a Google API key', () => {
      const r = scanText('key=AIza' + 'B'.repeat(35));
      assert.equal(r.flagged, true);
      assert.ok(r.types.includes('google-api-key'));
    });

    it('flags a generic key/secret assignment with a long value', () => {
      const r = scanText('api_key = "s3cr3tValue0123456789abcdef"');
      assert.equal(r.flagged, true);
      assert.ok(r.types.includes('generic-secret'));
    });
  });

  describe('scanText — privacy + cleanliness', () => {
    it('does NOT flag ordinary prose / short config', () => {
      const r = scanText('This is a normal note.\nport = 3200\nname = "demo"');
      assert.equal(r.flagged, false);
      assert.deepEqual(r.types, []);
    });

    it('returns pattern types, never the matched secret value', () => {
      const secret = 'AKIAIOSFODNN7EXAMPLE';
      const r = scanText(`key=${secret}`);
      assert.equal(r.flagged, true);
      // The privacy invariant: the secret value must not appear in the result.
      assert.ok(!JSON.stringify(r).includes(secret), 'result must not leak the secret value');
    });

    it('de-duplicates and sorts types', () => {
      const r = scanText('AKIAIOSFODNN7EXAMPLE and AKIAJKLMNOPQRSTUV1234');
      assert.deepEqual(r.types, ['aws-access-key']);
    });

    it('returns a clean result for empty / non-string input', () => {
      assert.deepEqual(scanText(''), { flagged: false, types: [] });
      assert.deepEqual(scanText(null), { flagged: false, types: [] });
      assert.deepEqual(scanText(undefined), { flagged: false, types: [] });
    });
  });
});
