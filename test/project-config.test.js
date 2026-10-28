'use strict';

/**
 * `lib/project-config.js`'s `replyGuidance` and `suppressNonActionableWakes`
 * settings (#2402): a project whose fleet answers by session-to-session
 * direct input instead of `tc message send` overrides the "how to reply"
 * text baked into every carrier, and may opt a `shared_doc_updated`-only
 * inbox out of waking the session. Also covers `load`'s refusal boundary
 * (#1289) — when it returns defaults silently versus calling `onError`.
 *
 * No store — `lib/project-config.js` touches nothing but `node:fs` and
 * `node:path` by design (it runs in the dashboard's forked scanner child).
 * The refusal-boundary tests use a real temp directory because the
 * distinction under test (missing file vs. present-but-unreadable) is a
 * filesystem fact a stub cannot stand in for.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectConfig = require('../lib/project-config');

describe('project-config — replyGuidance (#2402)', () => {
  it('defaults to null, meaning every carrier keeps its own built-in text', () => {
    assert.equal(projectConfig.DEFAULT_PROJECT_CONFIG.replyGuidance, null);
    assert.deepEqual(projectConfig.resolveReplyGuidance({}), { text: null, source: 'default', warnings: [] });
    assert.deepEqual(projectConfig.resolveReplyGuidance(null), { text: null, source: 'default', warnings: [] });
    assert.deepEqual(projectConfig.resolveReplyGuidance(undefined), { text: null, source: 'default', warnings: [] });
  });

  it('takes a valid one-line override', () => {
    const r = projectConfig.resolveReplyGuidance({ replyGuidance: 'Answer by direct input: POST /api/sessions/<project>/command' });
    assert.equal(r.text, 'Answer by direct input: POST /api/sessions/<project>/command');
    assert.equal(r.source, 'replyGuidance');
    assert.deepEqual(r.warnings, []);
  });

  it('falls back to the default and warns on a multi-line value', () => {
    const r = projectConfig.resolveReplyGuidance({ replyGuidance: 'line one\nline two' });
    assert.equal(r.text, null);
    assert.equal(r.source, 'invalid');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /replyGuidance/);
  });

  it('falls back to the default and warns on a non-string value', () => {
    const r = projectConfig.resolveReplyGuidance({ replyGuidance: 42 });
    assert.equal(r.text, null);
    assert.equal(r.source, 'invalid');
    assert.match(r.warnings[0], /replyGuidance \(42\)/);
  });

  it('falls back to the default and warns on text with no visible character', () => {
    const r = projectConfig.resolveReplyGuidance({ replyGuidance: '   ' });
    assert.equal(r.text, null);
    assert.equal(r.source, 'invalid');
  });

  it('falls back to the default and warns past the length cap', () => {
    const tooLong = 'a'.repeat(projectConfig.REPLY_GUIDANCE_TEXT_MAX + 1);
    const r = projectConfig.resolveReplyGuidance({ replyGuidance: tooLong });
    assert.equal(r.text, null);
    assert.equal(r.source, 'invalid');
  });

  it('accepts a line exactly at the length cap', () => {
    const exact = 'a'.repeat(projectConfig.REPLY_GUIDANCE_TEXT_MAX);
    const r = projectConfig.resolveReplyGuidance({ replyGuidance: exact });
    assert.equal(r.text, exact);
    assert.equal(r.source, 'replyGuidance');
  });

  describe('replyGuidanceProblem', () => {
    it('accepts null', () => {
      assert.equal(projectConfig.replyGuidanceProblem(null), null);
    });

    it('accepts a safe one-line string', () => {
      assert.equal(projectConfig.replyGuidanceProblem('Answer by direct input'), null);
    });

    it('names the reason for every unsafe shape', () => {
      assert.match(projectConfig.replyGuidanceProblem('two\nlines'), /one line/);
      assert.match(projectConfig.replyGuidanceProblem(42), /one line/);
      assert.match(projectConfig.replyGuidanceProblem(''), /one line/);
    });
  });
});

describe('project-config — suppressNonActionableWakes (#2402)', () => {
  it('defaults to false, preserving today\'s behavior', () => {
    assert.equal(projectConfig.DEFAULT_PROJECT_CONFIG.suppressNonActionableWakes, false);
  });
});

/*
 * `load`'s refusal boundary (#1289): a missing `project.json` is the only
 * silent case — an unreadable or malformed one must call `onError` so a
 * write-path caller (`lib/projects.js#loadConfigForWrite`) can refuse rather
 * than save over it.
 */
describe('project-config — load refusal boundary (#1289)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-project-config-load-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A fresh project directory with no `.tangleclaw/project.json`.
   * @returns {string} The project path.
   */
  function freshProjectDir() {
    const projPath = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    return projPath;
  }

  /**
   * Write `.tangleclaw/project.json` with raw content under a project dir.
   * @param {string} projPath
   * @param {string} raw
   */
  function writeConfig(projPath, raw) {
    const dir = path.join(projPath, '.tangleclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), raw);
  }

  it('returns defaults and does NOT call onError for a missing file', () => {
    const projPath = freshProjectDir();
    let called = false;
    const result = projectConfig.load(projPath, { onError: () => { called = true; } });
    assert.deepEqual(result, projectConfig.DEFAULT_PROJECT_CONFIG);
    assert.equal(called, false);
  });

  for (const [label, raw] of [
    ['an array', '[1,2,3]'],
    ['a string', '"just a string"'],
    ['a number', '42'],
    ['null', 'null']
  ]) {
    it(`returns defaults but DOES call onError when project.json parses to ${label}`, () => {
      const projPath = freshProjectDir();
      writeConfig(projPath, raw);
      let caught = null;
      const result = projectConfig.load(projPath, { onError: (err) => { caught = err; } });
      assert.deepEqual(result, projectConfig.DEFAULT_PROJECT_CONFIG);
      assert.ok(caught instanceof Error, `onError should have been called for ${label}`);
    });
  }

  it('returns defaults but DOES call onError for malformed JSON', () => {
    const projPath = freshProjectDir();
    writeConfig(projPath, '{ not valid json');
    let caught = null;
    const result = projectConfig.load(projPath, { onError: (err) => { caught = err; } });
    assert.deepEqual(result, projectConfig.DEFAULT_PROJECT_CONFIG);
    assert.ok(caught instanceof Error);
  });

  it('merges normally and does not call onError for a valid object', () => {
    const projPath = freshProjectDir();
    writeConfig(projPath, JSON.stringify({ silentPrime: false }));
    let called = false;
    const result = projectConfig.load(projPath, { onError: () => { called = true; } });
    assert.equal(result.silentPrime, false);
    assert.equal(called, false);
  });
});
