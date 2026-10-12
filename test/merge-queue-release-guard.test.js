'use strict';

/*
 * A landing is never a release (#2322).
 *
 * The release workflow runs when a push to `main` changes one of the paths it
 * watches. The merge queue refuses a pull request that changes one of those
 * paths, from a list in `lib/merge-queue-state.js`. The workflow is text
 * GitHub reads and the list is code; these tests read the workflow and fail
 * when it watches a path the list does not name, or gains a trigger that
 * would make every landing, or something else, a release. So what starts a
 * release cannot change without this list being looked at.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RELEASE_TRIGGER_PATHS, REFUSALS, releaseTriggerPaths } = require('../lib/merge-queue-state');

const WORKFLOW_PATH = '.github/workflows/release.yml';
const WORKFLOW = path.join(__dirname, '..', ...WORKFLOW_PATH.split('/'));

/**
 * The `on:` block of a workflow: every line from `on:` to the next key at the
 * left margin, comments and blank lines removed.
 * @param {string} src - The workflow file's text
 * @returns {string[]|null} The block's lines, or null when there is no `on:` block
 */
function onBlock(src) {
  const lines = src.split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start === -1) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim() && !line.trim().startsWith('#')) block.push(line);
  }
  return block;
}

/**
 * The triggers a workflow's `on:` block names: its keys at two spaces.
 * @param {string[]} block - From {@link onBlock}
 * @returns {string[]}
 */
function triggers(block) {
  return block.filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim().replace(/:.*$/, ''));
}

/**
 * The keys and values under `push:`, each a one-line flow list as this
 * workflow writes them. A value in any other form is returned as null, which
 * the tests refuse: a list this reader cannot read is not a list it vouches for.
 * @param {string[]} block - From {@link onBlock}
 * @returns {Record<string, (string[]|null)>}
 */
function pushFilters(block) {
  const filters = {};
  const start = block.findIndex((line) => /^ {2}push:\s*$/.test(line));
  if (start === -1) return filters;
  for (const line of block.slice(start + 1)) {
    if (!/^ {4}\S/.test(line)) break;
    const m = line.match(/^ {4}([a-z-]+):\s*(.*)$/);
    if (!m) { filters[line.trim()] = null; continue; }
    const list = m[2].match(/^\[(.*)\]$/);
    filters[m[1]] = list ? list[1].split(',').map((v) => v.trim().replace(/^(['"])(.*)\1$/, '$2')) : null;
  }
  return filters;
}

/**
 * Check a release workflow's text against the queue's list, as the tests do.
 * @param {string} src - A workflow file's text
 * @returns {string|null} What is wrong, or null
 */
function problemWith(src) {
  const block = onBlock(src);
  if (!block) return 'no on: block could be read';
  const unknown = triggers(block).filter((t) => t !== 'push' && t !== 'workflow_dispatch');
  if (unknown.length) return `a trigger other than push and workflow_dispatch: ${unknown.join(', ')}`;
  if (!triggers(block).includes('push')) return null;
  const filters = pushFilters(block);
  if (!Object.hasOwn(filters, 'paths')) return 'push has no paths filter, so every landing would start a release';
  if (filters.paths === null) return 'the paths filter is not a one-line list this test can read';
  const other = Object.keys(filters).filter((key) => key !== 'paths' && key !== 'branches');
  if (other.length) return `a push filter this test does not know: ${other.join(', ')}`;
  const unlisted = filters.paths.filter((p) => !RELEASE_TRIGGER_PATHS.includes(p));
  if (unlisted.length) return `the workflow watches a path the queue does not refuse: ${unlisted.join(', ')}`;
  return null;
}

describe('the merge queue refuses what would start a release (#2322)', () => {
  it('the release workflow watches only paths the queue refuses, and has no other trigger', () => {
    assert.equal(problemWith(fs.readFileSync(WORKFLOW, 'utf8')), null,
      'what starts a release changed: add the path to RELEASE_TRIGGER_PATHS in lib/merge-queue-state.js, or the queue could land a release');
  });

  it('the workflow file is itself on the list, since a pull request that rewrites it could add a trigger', () => {
    assert.ok(fs.existsSync(WORKFLOW));
    assert.ok(RELEASE_TRIGGER_PATHS.includes(WORKFLOW_PATH));
    assert.ok(RELEASE_TRIGGER_PATHS.includes('version.json'));
    assert.ok(Object.isFrozen(RELEASE_TRIGGER_PATHS));
    assert.equal(REFUSALS.RELEASE_TRIGGER_CHANGED, 'RELEASE_TRIGGER_CHANGED');
  });

  it('the reader would catch each change that makes a landing a release', () => {
    const ok = 'name: Release\non:\n  push:\n    branches: [main]\n    paths: [\'version.json\']\n  workflow_dispatch:\n\njobs:\n  x: 1\n';
    assert.equal(problemWith(ok), null);
    const cases = [
      [ok.replace("paths: ['version.json']", "paths: ['version.json', 'CHANGELOG.md']"), /does not refuse: CHANGELOG\.md/],
      [ok.replace("    paths: ['version.json']\n", ''), /no paths filter/],
      [ok.replace("paths: ['version.json']", 'paths:\n      - version.json'), /not a one-line list/],
      [ok.replace("paths: ['version.json']", "paths-ignore: ['docs/**']"), /no paths filter/],
      [ok.replace("    paths: ['version.json']\n", "    paths: ['version.json']\n    tags: ['v*']\n"), /does not know: tags/],
      [ok.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  schedule:\n    - cron: "0 0 * * *"\n'), /other than push and workflow_dispatch: schedule/],
      [ok.replace('  workflow_dispatch:\n', '  pull_request:\n'), /pull_request/],
      [ok.replace('on:\n', 'on: [push]\n'), /no on: block/]
    ];
    for (const [src, why] of cases) assert.match(String(problemWith(src)), why);
    // A comment between the keys, as the real file has, changes nothing.
    assert.equal(problemWith(ok.replace('  push:\n', '  push:\n    # only a version bump\n')), null);
  });

  it('names the trigger paths among a list of changed paths, exactly and only those', () => {
    assert.deepEqual(releaseTriggerPaths(['lib/a.js', 'version.json', 'docs/version.json']), ['version.json']);
    assert.deepEqual(releaseTriggerPaths(['.github/workflows/release.yml', '.github/workflows/test.yml']), ['.github/workflows/release.yml']);
    assert.deepEqual(releaseTriggerPaths(['Version.json', 'version.json.bak', './version.json']), []);
    for (const none of [[], undefined, null, 'version.json', { 0: 'version.json' }]) assert.deepEqual(releaseTriggerPaths(none), []);
  });
});
