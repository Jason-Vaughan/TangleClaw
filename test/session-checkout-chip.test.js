'use strict';

/*
 * #1678 — the session page's checkout chip. The model and the renderer are
 * LIFTED from public/session.js and RUN (the live-checkout-banner approach),
 * because the rule that matters — a state nobody measured never gets the quiet
 * tone — only shows when the code runs.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SESSION_SRC = fs.readFileSync(path.join(ROOT, 'public', 'session.js'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(ROOT, 'public', 'session.html'), 'utf8');

/**
 * Slice a top-level function out of session.js by brace matching.
 * @param {string} name
 * @returns {string}
 */
function extract(name) {
  const start = SESSION_SRC.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start > -1, `${name} should exist in session.js`);
  let depth = 0;
  for (let i = SESSION_SRC.indexOf('{', start); i < SESSION_SRC.length; i++) {
    if (SESSION_SRC[i] === '{') depth++;
    else if (SESSION_SRC[i] === '}') {
      depth--;
      if (depth === 0) return SESSION_SRC.slice(start, i + 1);
    }
  }
  throw new Error(`could not brace-match ${name}`);
}

const SRC = ['checkoutChipModel', 'renderCheckoutChip'].map(extract).join('\n');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * A measured, level, clean checkout on main, with overrides.
 * @param {object} over
 * @returns {object}
 */
function measured(over = {}) {
  return {
    state: 'measured', branch: 'main', detached: false, tag: null, onDefaultBranch: true, headSha: SHA_A,
    dirtyTracked: 0, untracked: 0,
    upstream: { identity: 'github.com/O/R', via: 'origin', state: 'measured', sha: SHA_A, observedAt: '2026-09-22T12:00:00Z', observedFrom: 'P' },
    vsUpstream: { ahead: 0, behind: 0, relation: 'equal', reason: null },
    runtime: null,
    ...over
  };
}

/**
 * Run the model.
 * @param {*} c
 * @returns {object|null}
 */
function model(c) {
  const ctx = vm.createContext({ c });
  return vm.runInContext(`${SRC}\ncheckoutChipModel(c);`, ctx);
}

describe('session checkout chip (#1678)', () => {
  it('markup: a hidden chip beside the version, with a click detail and no button inside', () => {
    const m = SESSION_HTML.match(/<span class="banner-checkout" id="bannerCheckout"[^>]*>([\s\S]*?)<\/span><\/span>/);
    assert.ok(m, 'the chip exists');
    assert.match(m[0], /\shidden>/, 'hidden until a checkout arrives');
    assert.ok(SESSION_HTML.indexOf('id="bannerCheckout"') > SESSION_HTML.indexOf('id="bannerVersion"'));
    assert.doesNotMatch(m[0], /<button/, 'the chip carries no action');
  });

  it('level and clean on main is the only quiet state', () => {
    const r = model(measured());
    assert.equal(r.tone, 'ok');
    assert.equal(r.text, 'main @aaaaaaa · level');
  });

  it('ahead, behind, diverged, dirty, untracked and off-main all warn', () => {
    assert.equal(model(measured({ vsUpstream: { ahead: 2, behind: 0, relation: 'ahead' } })).tone, 'warn');
    const behind = model(measured({ vsUpstream: { ahead: 0, behind: 3, relation: 'behind' }, upstream: { sha: SHA_B, observedAt: '2026-09-22T12:00:00Z' } }));
    assert.equal(behind.tone, 'warn');
    assert.match(behind.detail, /3 behind origin\/main @bbbbbbb/);
    assert.equal(model(measured({ vsUpstream: { ahead: 1, behind: 1, relation: 'diverged' } })).tone, 'warn');
    const dirty = model(measured({ dirtyTracked: 1, untracked: 2 }));
    assert.equal(dirty.tone, 'warn');
    assert.match(dirty.detail, /1 uncommitted, 2 untracked/);
    assert.equal(model(measured({ branch: 'feat/x', onDefaultBranch: false })).tone, 'warn');
    assert.equal(model(measured({ detached: true, tag: null, branch: null })).tone, 'warn');
    assert.equal(model(measured({ detached: true, tag: 'v5.24.0', branch: null })).tone, 'ok', 'a release tag is a healthy detached install');
    const notFetched = model(measured({ vsUpstream: { relation: 'behind-unknown', reason: 'upstream commit not fetched here' } }));
    assert.equal(notFetched.tone, 'warn');
    assert.match(notFetched.detail, /count unknown: upstream commit not fetched here/);
  });

  it('nothing unmeasured is ever the quiet tone', () => {
    for (const c of [
      measured({ state: 'pending' }),
      measured({ state: 'unknown', reason: 'git status: timed out' }),
      measured({ dirtyTracked: null, untracked: null }),
      measured({ vsUpstream: { relation: 'unknown', reason: 'git ls-remote: timed out' }, upstream: { state: 'unknown', sha: null } }),
      measured({ vsUpstream: { relation: 'unknown' }, upstream: { state: 'disabled', sha: null } }),
      measured({ vsUpstream: { relation: 'pending' } })
    ]) {
      assert.equal(model(c).tone, 'unknown', JSON.stringify(c.vsUpstream) + c.state);
    }
    assert.match(model(measured({ vsUpstream: { relation: 'unknown' }, upstream: { state: 'disabled', sha: null } })).detail, /turned off/);
  });

  it('a no-git project related through a group says so, without a comparison', () => {
    const r = model({ state: 'no-git', upstream: { via: 'group', identity: 'github.com/O/R', groupName: 'G', sha: SHA_A }, vsUpstream: { relation: 'not-compared' } });
    assert.equal(r.text, 'related repo');
    assert.match(r.detail, /Related repo github\.com\/O\/R \(via group G\) at origin\/main @aaaaaaa; no checkout comparison/);
  });

  it('the install row adds running versus disk and the restart impact', () => {
    const r = model(measured({ runtime: { startupSha: SHA_A, currentDiskSha: SHA_B, isStale: true, restartImpact: { impact: 'records-only' } } }));
    assert.match(r.detail, /Server running aaaaaaa, disk bbbbbbb: records-only, no restart needed/);
    assert.match(model(measured({ runtime: { startupSha: SHA_A, currentDiskSha: SHA_B, isStale: true, restartImpact: { impact: 'pending' } } })).detail,
      /restart impact unknown/);
  });

  it('no checkout (a restricted row) hides the chip; a checkout shows it with its tone and detail', () => {
    const attrs = {};
    const chip = { hidden: true, setAttribute: (k, v) => { attrs[k] = v; } };
    const text = { textContent: '' };
    const document = { getElementById: (id) => ({ bannerCheckout: chip, bannerCheckoutText: text }[id] || null) };
    const run = (c) => vm.runInContext(`${SRC}\nrenderCheckoutChip(c);`, vm.createContext({ document, c }));
    run(measured({ dirtyTracked: 2 }));
    assert.equal(chip.hidden, false);
    assert.equal(attrs['data-tone'], 'warn');
    assert.match(attrs['data-pill-detail'], /2 uncommitted/);
    assert.match(text.textContent, /main @aaaaaaa · level · 2±/);
    run(undefined);
    assert.equal(chip.hidden, true);
  });
});
