'use strict';

/*
 * Source pins for `.github/workflows/release.yml`'s exact-commit rule (#1551):
 * a release publishes only the commit the same run tested, and only under a
 * tag that dereferences to it.
 *
 * The workflow is config GitHub executes, not code the suite can run, so these
 * pin its load-bearing text: which job runs the suite, what the publishing job
 * waits on, where the tag gate is called, and who holds the write token. They
 * show what the file says, not what GitHub does with it; the first release run
 * after a change here is the live proof.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS = path.join(__dirname, '..', '.github', 'workflows');
const RELEASE = fs.readFileSync(path.join(WORKFLOWS, 'release.yml'), 'utf8');
const TEST = fs.readFileSync(path.join(WORKFLOWS, 'test.yml'), 'utf8');

/**
 * Return the text of one top-level key's block (from `key:` to the next
 * unindented key).
 * @param {string} src - Workflow source.
 * @param {string} key - Top-level key, e.g. `permissions`.
 * @returns {string}
 */
function topLevelBlock(src, key) {
  const m = new RegExp(`^${key}:[^\\n]*\\n((?:(?:[ \\t]+[^\\n]*|[ \\t]*)\\n)*)`, 'm').exec(src);
  assert.ok(m, `no top-level ${key}: block`);
  return m[0];
}

/**
 * Split the `jobs:` block into job name → job text, keyed on two-space
 * indented names.
 * @param {string} src - Workflow source.
 * @returns {Map<string, string>}
 */
function jobs(src) {
  const block = topLevelBlock(src, 'jobs');
  const out = new Map();
  const re = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm;
  const heads = [...block.matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : block.length;
    out.set(h[1], block.slice(h.index, end));
  });
  return out;
}

/**
 * Strip YAML comment lines so an assertion cannot be satisfied by prose.
 * @param {string} text - Workflow text.
 * @returns {string}
 */
function code(text) {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

const RELEASE_JOBS = jobs(RELEASE);
const PUBLISH = code(RELEASE_JOBS.get('release') || '');

/**
 * Index of a step's `- name:` line in the publishing job.
 * @param {string} name - Step name.
 * @returns {number}
 */
function stepIndex(name) {
  const i = PUBLISH.indexOf(`- name: ${name}`);
  assert.ok(i >= 0, `release job has no step named "${name}"`);
  return i;
}

describe('release.yml publishes only the commit this run tested (#1551)', () => {
  it('test.yml can be called as a reusable workflow', () => {
    const on = code(topLevelBlock(TEST, 'on'));
    assert.match(on, /^ {2}workflow_call:/m, 'test.yml has no workflow_call trigger, so release.yml cannot run it');
  });

  it('a test job runs test.yml inside the release run', () => {
    const test = code(RELEASE_JOBS.get('test') || '');
    assert.ok(test, 'release.yml has no `test` job');
    assert.match(test, /^\s+uses:\s+\.\/\.github\/workflows\/test\.yml\s*$/m);
  });

  it('the publishing job needs the test job', () => {
    assert.ok(PUBLISH, 'release.yml has no `release` job');
    assert.match(PUBLISH, /^\s+needs:\s+(?:test|\[\s*test\s*\])\s*$/m);
  });

  it('the publishing job has no status function that would run it after a failed test', () => {
    const ifs = [...PUBLISH.matchAll(/^ {4}if:\s*(.*)$/gm)].map((m) => m[1]);
    for (const cond of ifs) {
      assert.doesNotMatch(cond, /always\(\)|cancelled\(\)|failure\(\)/, `job-level if: ${cond}`);
    }
  });

  it('confirms the checkout is GITHUB_SHA before tagging', () => {
    const confirm = stepIndex('Confirm the checkout is the tested commit');
    assert.ok(confirm < stepIndex('Create and push the tag'));
    const body = PUBLISH.slice(confirm, stepIndex('Read the version being released'));
    assert.match(body, /git rev-parse HEAD/);
    assert.match(body, /!= "\$GITHUB_SHA"/);
  });
});

describe('release.yml refuses a tag that does not dereference to the tested commit (#1551)', () => {
  const gateCalls = [...PUBLISH.matchAll(/node scripts\/release-tag-gate\.js([^\n]*)/g)];

  it('checks every existing tag, released or not, before creating, pushing or publishing', () => {
    const existing = stepIndex('Check what already exists');
    const body = PUBLISH.slice(existing, stepIndex('Extract release notes from CHANGELOG'));
    const lines = body.split('\n');
    const call = lines.findIndex((l) => l.includes('release-tag-gate.js'));
    assert.ok(call > 0, 'the existence check does not call the gate');
    assert.match(lines[call], /--tag "\$TAG" --expect "\$GITHUB_SHA"\s*$/);
    // Guarded on the tag existing ONLY: a tag + Release on another commit refuses too.
    const guard = lines.slice(0, call).reverse().find((l) => /^\s*(?:if|elif) /.test(l));
    assert.match(guard, /^\s*if \[ "\$TAG_EXISTS" = true \]; then\s*$/);
    // It runs before anything reports "already fully released".
    assert.ok(body.indexOf('release-tag-gate.js') < body.indexOf('already fully released'));
    assert.ok(existing < stepIndex('Create and push the tag'));
  });

  it('verifies the pushed tag on origin before publishing, with no escape flag', () => {
    const verify = stepIndex('Verify the tag on origin names the tested commit');
    assert.ok(stepIndex('Create and push the tag') < verify);
    assert.ok(verify < stepIndex('Publish the GitHub Release'));
    const body = PUBLISH.slice(verify, stepIndex('Publish the GitHub Release'));
    const call = /release-tag-gate\.js([^\n]*)/.exec(body);
    assert.ok(call, 'verify step does not call the gate');
    assert.match(call[1], /--expect "\$GITHUB_SHA"/);
    assert.doesNotMatch(call[1], /--allow-absent|--warn-only/);
  });

  it('always compares against GITHUB_SHA, with no escape flag', () => {
    assert.ok(gateCalls.length >= 2, 'expected the pre-existing and post-push gate calls');
    for (const [, argv] of gateCalls) {
      assert.match(argv, /--expect "\$GITHUB_SHA"/);
      assert.doesNotMatch(argv, /--allow-absent|--warn-only/);
    }
  });

  it('asks ls-remote for the peeled ^{} line every time it reads the tag', () => {
    const calls = [...PUBLISH.matchAll(/git ls-remote --tags origin([^\n)]*)/g)];
    assert.ok(calls.length >= 2);
    for (const [, argv] of calls) {
      assert.match(argv, /"refs\/tags\/\$TAG\^\{\}"/, `ls-remote without the peeled pattern: ${argv}`);
    }
  });
});

describe('release.yml grants the write token only to the publishing job', () => {
  it('top-level permissions are read-only', () => {
    const perms = code(topLevelBlock(RELEASE, 'permissions'));
    assert.match(perms, /contents:\s*read/);
    assert.doesNotMatch(perms, /write/);
  });

  it('only the release job holds contents: write', () => {
    for (const [name, text] of RELEASE_JOBS) {
      const hasWrite = /contents:\s*write/.test(code(text));
      assert.equal(hasWrite, name === 'release', `job ${name} write grant`);
    }
  });
});
