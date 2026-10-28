'use strict';

/**
 * `lib/project-config.js`'s `replyGuidance` and `suppressNonActionableWakes`
 * settings (#2402): a project whose fleet answers by session-to-session
 * direct input instead of `tc message send` overrides the "how to reply"
 * text baked into every carrier, and may opt a `shared_doc_updated`-only
 * inbox out of waking the session.
 *
 * Pure-function coverage only — `lib/project-config.js` touches nothing but
 * `node:fs` and `node:path` by design (it runs in the dashboard's forked
 * scanner child), so no store or temp project is needed here.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

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
