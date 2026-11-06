'use strict';

// #2883: scripts/scorecard-publish-metrics.js, the thin CLI around
// lib/tc-docs-scorecard-merge-wiring.js#publishScorecardToMetricsBranch
// (already thoroughly tested at the library level, including a real-git
// integration regression -- test/tc-docs-scorecard-merge-wiring.test.js).
// This file's only job is the CLI's own logic: arg parsing, the
// not-fresh-cache refusal, and output shape -- both `readScorecardCache`
// and `publish` are injected seams, so no real cache file or git call is
// ever needed here.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { main, parseArgs } = require('../scripts/scorecard-publish-metrics');

/** A fake stdout/stderr pair that records what was written. */
function fakeIo(extra = {}) {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    out, err,
    ...extra
  };
}

describe('scorecard-publish-metrics: parseArgs', () => {
  it('defaults base and repo to the current directory', () => {
    const opts = parseArgs([]);
    assert.equal(opts.base, process.cwd());
    assert.equal(opts.repo, process.cwd());
    assert.equal(opts.branch, undefined);
    assert.equal(opts.path, undefined);
  });

  it('parses --base, --repo, --branch and --path', () => {
    const opts = parseArgs(['--base', '/b', '--repo', '/r', '--branch', 'metrics-2', '--path', 'x/y.json']);
    assert.deepEqual(opts, { base: '/b', repo: '/r', branch: 'metrics-2', path: 'x/y.json' });
  });

  it('refuses an unknown flag and a flag with no value', () => {
    assert.equal(parseArgs(['--bogus', 'x']), null);
    assert.equal(parseArgs(['--base']), null);
  });
});

describe('scorecard-publish-metrics: main', () => {
  it('usage error (2) on a bad flag, before anything is read', async () => {
    let readCalled = false;
    const io = fakeIo({ readScorecardCache: () => { readCalled = true; return { status: 'ok', doc: {} }; } });
    const code = await main(['--bogus'], io);
    assert.equal(code, 2);
    assert.match(io.err.join(''), /usage: scorecard-publish-metrics/);
    assert.equal(readCalled, false);
  });

  for (const status of ['missing', 'stale', 'invalid', 'unreadable']) {
    it(`refuses to publish a cache that is not fresh (status: ${status}), and calls publish 0 times`, async () => {
      let publishCalls = 0;
      const io = fakeIo({
        readScorecardCache: () => ({ status, reason: `test: ${status}` }),
        publish: async () => { publishCalls += 1; return { published: true, branch: 'metrics', commit: 'deadbeef' }; }
      });
      const code = await main([], io);
      assert.equal(code, 1);
      assert.match(io.err.join(''), new RegExp(`status: ${status}`));
      assert.match(io.err.join(''), /run scorecard-produce\.js first/);
      assert.equal(publishCalls, 0);
    });
  }

  it('publishes the cached document when the cache is fresh, forwarding repoDir/branch/path', async () => {
    const doc = { schema: 'x', generatedAt: 1, freshUntil: 2 };
    let seenInput = null;
    const io = fakeIo({
      readScorecardCache: () => ({ status: 'ok', doc }),
      publish: async (input) => { seenInput = input; return { published: true, branch: 'metrics', commit: 'abc123' }; }
    });
    const code = await main(['--repo', '/some/repo', '--branch', 'metrics-custom', '--path', 'scorecard/v2.json'], io);
    assert.equal(code, 0);
    assert.deepEqual(seenInput, {
      repoDir: '/some/repo', document: doc, enabled: true, branch: 'metrics-custom', path: 'scorecard/v2.json'
    });
    assert.deepEqual(JSON.parse(io.out.join('')), { branch: 'metrics', commit: 'abc123' });
  });

  it('a publish failure answers 1 with the reason', async () => {
    const io = fakeIo({
      readScorecardCache: () => ({ status: 'ok', doc: {} }),
      publish: async () => ({ published: false, reason: 'push-failed', detail: 'non-fast-forward' })
    });
    const code = await main([], io);
    assert.equal(code, 1);
    assert.match(io.err.join(''), /could not publish scorecard: push-failed \(non-fast-forward\)/);
  });
});
