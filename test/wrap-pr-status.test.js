'use strict';

// #638 — the wrap reports the commit step Done when its PR is open and red, so
// a blocked release looks like a shipped one. `lib/wrap-pr-status.js` is the
// read-only, post-pipeline resolver the drawer uses to distinguish
// merged / pending / blocked, so a blocked release never renders as success.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const prStatus = require('../lib/wrap-pr-status');

describe('wrap-pr-status.classify', () => {
  it('MERGED → merged', () => {
    assert.equal(prStatus.classify({ state: 'MERGED' }), 'merged');
  });
  it('CLOSED (unmerged) → blocked', () => {
    assert.equal(prStatus.classify({ state: 'CLOSED' }), 'blocked');
  });
  it('OPEN + BLOCKED merge state → blocked (the #636 red-check case)', () => {
    assert.equal(prStatus.classify({ state: 'OPEN', mergeStateStatus: 'BLOCKED' }), 'blocked');
  });
  it('OPEN + DIRTY (conflicts) → blocked', () => {
    assert.equal(prStatus.classify({ state: 'OPEN', mergeStateStatus: 'DIRTY' }), 'blocked');
  });
  it('OPEN + CLEAN → pending (armed, will merge when checks pass)', () => {
    assert.equal(prStatus.classify({ state: 'OPEN', mergeStateStatus: 'CLEAN' }), 'pending');
  });
  it('OPEN + UNSTABLE → pending (non-required check failing, not blocking)', () => {
    assert.equal(prStatus.classify({ state: 'OPEN', mergeStateStatus: 'UNSTABLE' }), 'pending');
  });
  it('case-insensitive on state and mergeStateStatus', () => {
    assert.equal(prStatus.classify({ state: 'open', mergeStateStatus: 'blocked' }), 'blocked');
  });
});

describe('wrap-pr-status.isValidPrRef', () => {
  it('accepts a full github.com PR URL', () => {
    assert.equal(prStatus.isValidPrRef('https://github.com/Owner/repo/pull/42'), true);
  });
  it('accepts a bare number', () => {
    assert.equal(prStatus.isValidPrRef('42'), true);
  });
  it('rejects a flag-shaped token, a random string, and non-strings', () => {
    assert.equal(prStatus.isValidPrRef('--json'), false);
    assert.equal(prStatus.isValidPrRef('not a url'), false);
    assert.equal(prStatus.isValidPrRef(42), false);
    assert.equal(prStatus.isValidPrRef(''), false);
  });
});

describe('wrap-pr-status.resolve', () => {
  let saved;
  beforeEach(() => { saved = { ...prStatus._internal }; });
  afterEach(() => { Object.assign(prStatus._internal, saved); });

  it('maps a MERGED PR to outcome merged', async () => {
    prStatus._internal.exec = async () => ({ exitCode: 0, stdout: JSON.stringify({ state: 'MERGED', url: 'u', number: 1 }), stderr: '' });
    const out = await prStatus.resolve('/tmp/p', 'https://github.com/o/r/pull/1');
    assert.equal(out.outcome, 'merged');
    assert.equal(out.state, 'MERGED');
    assert.equal(out.reason, null);
  });

  it('maps an OPEN+BLOCKED PR to outcome blocked', async () => {
    prStatus._internal.exec = async () => ({ exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED' }), stderr: '' });
    const out = await prStatus.resolve('/tmp/p', '5');
    assert.equal(out.outcome, 'blocked');
    assert.equal(out.mergeStateStatus, 'BLOCKED');
  });

  it('rejects an invalid PR ref WITHOUT invoking gh', async () => {
    let called = false;
    prStatus._internal.exec = async () => { called = true; return { exitCode: 0, stdout: '{}', stderr: '' }; };
    const out = await prStatus.resolve('/tmp/p', '--dangerous');
    assert.equal(out.outcome, 'unknown');
    assert.equal(called, false, 'an invalid ref never reaches gh');
    assert.match(out.reason, /valid PR reference/);
  });

  it('degrades to unknown (never a false success/failure) when gh fails', async () => {
    prStatus._internal.exec = async () => ({ exitCode: 127, stdout: '', stderr: 'gh: command not found' });
    const out = await prStatus.resolve('/tmp/p', '9');
    assert.equal(out.outcome, 'unknown');
    assert.match(out.reason, /gh pr view failed/);
  });

  it('degrades to unknown on unparseable gh output', async () => {
    prStatus._internal.exec = async () => ({ exitCode: 0, stdout: 'not json', stderr: '' });
    const out = await prStatus.resolve('/tmp/p', '9');
    assert.equal(out.outcome, 'unknown');
    assert.match(out.reason, /could not parse/);
  });

  it('degrades to unknown when the exec throws', async () => {
    prStatus._internal.exec = async () => { throw new Error('spawn EACCES'); };
    const out = await prStatus.resolve('/tmp/p', '9');
    assert.equal(out.outcome, 'unknown');
    assert.match(out.reason, /threw/);
  });
});
