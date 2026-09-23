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
function callRoute(body = null) {
  const matched = server.matchRoute('POST', '/api/update/apply');
  assert.ok(matched, 'POST /api/update/apply should be registered');
  const cap = {};
  const res = {
    writeHead: (status) => { cap.status = status; },
    end: (out) => { cap.body = out ? JSON.parse(out) : null; }
  };
  matched.handler({}, res, matched.params, body);
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
      if (key === 'diff --name-status -z --no-renames HEAD v9.9.9') return ''; // #1730: preflight
      if (key === 'diff --name-only old new') return ''; // #711: provisioning diff
      throw new Error(`unexpected git: ${key}`);
    };
    const { status, body } = callRoute();
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.toRef, 'v9.9.9');
    assert.equal(body.fromSha, 'old');
    assert.equal(body.toSha, 'new');
  });

  it('the route discard gate is a strict boolean — a truthy string changes nothing (#711)', () => {
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
    const calls = [];
    applier._internal.git = (args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'rev-parse HEAD') return 'old\n';
      if (key === 'status --porcelain') return ' M .claude/settings.json\n';
      // A committed settings file carrying a hook TangleClaw retires; the
      // working copy below is that file after the retirement write.
      if (key === 'show HEAD:.claude/settings.json') {
        return JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'bash data/hooks/sessionstart-prime-claude.sh' }] }] } });
      }
      throw new Error(`unexpected git: ${key}`);
    };
    const origRead = applier._internal.readFile;
    applier._internal.readFile = () => JSON.stringify({});
    let status, body;
    try {
      ({ status, body } = callRoute({ discardDirty: 'yes' }));
    } finally {
      applier._internal.readFile = origRead;
    }
    assert.equal(status, 409, 'a truthy string must refuse like no flag at all');
    assert.equal(body.code, 'dirty-tree');
    assert.deepEqual(body.dirty, { discardable: ['.claude/settings.json'], realWork: [], carried: [] },
      'the refusal payload must reach the wire');
    assert.equal(calls.some((c) => c.startsWith('checkout --')), false, 'and nothing is discarded');
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

  describe('the #1730 codes reach the wire with their status and body', () => {
    let origApply;
    beforeEach(() => { origApply = applier.applyUpdate; });
    afterEach(() => { applier.applyUpdate = origApply; });

    it('reconcile-required is a 409, with every reconcile entry intact', () => {
      const result = {
        ok: false, code: 'reconcile-required', error: 'the update needs these files reconciled first — nothing was changed',
        fromSha: 'old', toRef: null, toSha: null,
        reconcile: [{ path: 'data/global-rules.md', reason: 'merge-conflict', action: 'Open Global Rules…' }]
      };
      applier.applyUpdate = () => result;
      const { status, body } = callRoute();
      assert.equal(status, 409, 'a refusal that changed nothing is a 409');
      assert.deepEqual(body, result);
    });

    it('recovery-failed is a 500, never a 409, with recovery intact', () => {
      // THE MUTATION THIS CATCHES: dropping recovery-failed from the 500 set.
      // A 409 tells every consumer that nothing moved, which is exactly what
      // this code exists to say it cannot promise.
      const result = {
        ok: false, code: 'recovery-failed', error: 'the update failed at "write-merged" — manual recovery is required',
        fromSha: 'old', toRef: null, toSha: null,
        recovery: {
          fromSha: 'old', fromRef: 'main', backup: ['/b/global-rules.old-v9.md'], failedStep: 'write-merged',
          observed: { headSha: 'old', ref: 'main', fileMatchesOriginal: false, flagsMatchOriginal: null }
        }
      };
      applier.applyUpdate = () => result;
      const { status, body } = callRoute();
      assert.equal(status, 500);
      assert.deepEqual(body, result);
    });
  });
});
