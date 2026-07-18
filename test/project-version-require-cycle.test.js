'use strict';

/**
 * Regression test for #584 — recordVersion silently failing under the
 * server's module load order.
 *
 * `projects.js` → `sessions.js` → `project-version.js` → `projects.js` is a
 * require cycle. Entered via `projects.js` (as the server does), a top-level
 * `require('./projects')` in project-version.js captured projects' partial
 * exports and `detectVersion` threw `projects._readChangelogVersion is not a
 * function` on every call — swallowed by recordVersion's catch, so the
 * version cache was silently stale fleet-wide.
 *
 * The ORDER of the two requires below is the whole test: projects.js FIRST
 * enters the cycle the way the server does. project-version.test.js can't
 * host this — it requires project-version first, the order that always
 * worked. Each test file runs in its own process under `node --test`, so the
 * order here is deterministic and unaffected by other files.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

require('../lib/projects'); // MUST come first — see module head
const projectVersion = require('../lib/project-version');

describe('project-version require cycle (#584)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pv-cycle-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detectVersion works when projects.js loaded the cycle first', () => {
    fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [2.7.1] - 2026-07-01\n');
    const result = projectVersion.detectVersion(tmpDir);
    assert.deepEqual(result, { version: '2.7.1', source: 'CHANGELOG.md' });
  });

  it('recordVersion writes the cache file (returns non-null) under server load order', () => {
    fs.writeFileSync(path.join(tmpDir, 'version.json'), '{ "version": "1.0.0" }\n');
    const result = projectVersion.recordVersion(tmpDir);
    // Under the #584 bug this returned null (warn-and-bail) and wrote nothing.
    assert.ok(result, 'recordVersion must not bail under server load order');
    assert.equal(result.version, '1.0.0');
    const cachePath = path.join(tmpDir, '.tangleclaw', 'project-version.txt');
    assert.ok(fs.existsSync(cachePath), 'cache file must be written');
    const body = fs.readFileSync(cachePath, 'utf8');
    assert.match(body, /^version: 1\.0\.0$/m);
    assert.match(body, /^source: version\.json$/m);
  });
});
