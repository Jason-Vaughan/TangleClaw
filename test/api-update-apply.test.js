'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const server = require('../server');
const applier = require('../lib/update-applier');

/**
 * Invoke the matched route handler with a mock res that captures the status +
 * parsed JSON body, driving the real applier through its `_internal` seam.
 * @returns {{ status: number, body: object }}
 */
function callRoute() {
  const matched = server.matchRoute('POST', '/api/update/apply');
  assert.ok(matched, 'POST /api/update/apply should be registered');
  const cap = {};
  const res = {
    writeHead: (status) => { cap.status = status; },
    end: (body) => { cap.body = body ? JSON.parse(body) : null; }
  };
  matched.handler({}, res, matched.params, null);
  return cap;
}

describe('POST /api/update/apply (UB #228/#229)', () => {
  let origGit, origCheck;

  beforeEach(() => {
    origGit = applier._internal.git;
    origCheck = applier._internal.checkForUpdate;
  });
  afterEach(() => {
    applier._internal.git = origGit;
    applier._internal.checkForUpdate = origCheck;
  });

  it('returns 200 with the shas on a successful apply', () => {
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
    let revParseCount = 0;
    applier._internal.git = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') { revParseCount++; return revParseCount === 1 ? 'old\n' : 'new\n'; }
      if (key === 'status --porcelain') return '';
      if (key === 'rev-parse --abbrev-ref HEAD') return 'main\n';
      if (key === 'fetch --tags origin') return '';
      if (key === 'ls-remote --tags origin') return 'sha\trefs/tags/v9.9.9\n';
      if (key === 'checkout v9.9.9') return '';
      throw new Error(`unexpected git: ${key}`);
    };
    const { status, body } = callRoute();
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.toRef, 'v9.9.9');
    assert.equal(body.fromSha, 'old');
    assert.equal(body.toSha, 'new');
  });

  it('returns 409 with a stable code on a refused guard (dirty tree)', () => {
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
    applier._internal.git = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') return 'old\n';
      if (key === 'status --porcelain') return ' M lib/x.js\n';
      throw new Error(`unexpected git: ${key}`);
    };
    const { status, body } = callRoute();
    assert.equal(status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'dirty-tree');
  });

  it('returns 500 on an unexpected git failure mid-flow', () => {
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
    applier._internal.git = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') return 'old\n';
      if (key === 'status --porcelain') return '';
      if (key === 'rev-parse --abbrev-ref HEAD') return 'main\n';
      if (key === 'fetch --tags origin') throw new Error('network down');
      throw new Error(`unexpected git: ${key}`);
    };
    const { status, body } = callRoute();
    assert.equal(status, 500);
    assert.equal(body.code, 'git-error');
    assert.equal(body.fromSha, 'old');
  });
});
