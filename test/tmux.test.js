'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const tmux = require('../lib/tmux');

describe('tmux.toSessionName', () => {
  it('passes through simple names', () => {
    assert.equal(tmux.toSessionName('MyProject'), 'MyProject');
  });

  it('replaces spaces with hyphens', () => {
    assert.equal(tmux.toSessionName('TiLT v2'), 'TiLT-v2');
  });

  it('replaces special characters with hyphens', () => {
    assert.equal(tmux.toSessionName('my.project@home'), 'my-project-home');
  });

  it('preserves underscores and hyphens', () => {
    assert.equal(tmux.toSessionName('my_project-name'), 'my_project-name');
  });

  it('handles empty string', () => {
    assert.equal(tmux.toSessionName(''), '');
  });
});

describe('tmux.validateSessionName', () => {
  it('accepts valid names', () => {
    assert.doesNotThrow(() => tmux.validateSessionName('MyProject'));
    assert.doesNotThrow(() => tmux.validateSessionName('my-project_123'));
    assert.doesNotThrow(() => tmux.validateSessionName('A'));
  });

  it('rejects names with spaces', () => {
    assert.throws(() => tmux.validateSessionName('my project'), /Invalid session name/);
  });

  it('rejects names with special chars', () => {
    assert.throws(() => tmux.validateSessionName('my.project'), /Invalid session name/);
    assert.throws(() => tmux.validateSessionName('my/project'), /Invalid session name/);
    assert.throws(() => tmux.validateSessionName('my;project'), /Invalid session name/);
  });

  it('rejects empty string', () => {
    assert.throws(() => tmux.validateSessionName(''), /Invalid session name/);
  });
});
