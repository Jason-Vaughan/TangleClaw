'use strict';

/*
 * #711 chunk 03 (Critic R-1) — the dirty-tree discard flow must be REACHABLE
 * from the dashboard, not merely present in the source.
 *
 * The first version read `applyResp.dirty`, but `api()` returns null for any
 * !ok response — so after the 409 the whole branch was dead code, and a
 * source-pin test proved it existed without proving a browser could reach it.
 * These tests run the REAL `applyUpdateAndRestart` through the REAL
 * `tcCreateApi`/`tcCreateApiMutate` chain with fetch resolving the actual 409
 * shapes the route produces, and assert on what the operator experiences: the
 * confirm, the re-apply with the explicit opt-in, and the named-file refusal.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public');
const LANDING_SRC = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');
const API_HELPER_SRC = fs.readFileSync(path.join(PUB, 'api-helper.js'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text by
 * brace-matching, so the sandbox runs the REAL code rather than a copy.
 *
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find.
 * @returns {string} The declaration plus its balanced body.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/** A JSON Response the route would produce. */
function jsonRes(status, body) {
  return new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Build the chain: real api factory + real applyUpdateAndRestart, with fetch,
 * confirm, and alert under test control.
 *
 * @param {Function} fetchImpl - Sequenced fetch stand-in.
 * @param {{confirmAnswers?: boolean[]}} [opts] - Dialog scripting.
 * @returns {object} sandbox with `calls` attached.
 */
function loadFlow(fetchImpl, opts = {}) {
  const calls = { confirms: [], alerts: [], fetches: [] };
  const confirmAnswers = opts.confirmAnswers || [true, true];
  const sandbox = {
    console, setTimeout: (fn) => 0, clearTimeout() {},
    Response, Headers,
    state: { connected: true, restartInFlight: false },
    location: { origin: 'https://tc.example:8443' },
    document: { getElementById: () => null },
    fetch: async (url, o) => {
      calls.fetches.push({ url, body: o && o.body ? JSON.parse(o.body) : null });
      return fetchImpl(calls.fetches.length, url, o);
    }
  };
  sandbox.confirm = (msg) => {
    calls.confirms.push(msg);
    return confirmAnswers[calls.confirms.length - 1];
  };
  sandbox.alert = (msg) => { calls.alerts.push(msg); };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(API_HELPER_SRC, sandbox);
  vm.runInContext([
    'const api = tcCreateApi({});',
    'const apiMutate = tcCreateApiMutate(api);',
    liftFunction(LANDING_SRC, 'async function applyUpdateAndRestart(data)'),
    'globalThis.applyUpdateAndRestart = applyUpdateAndRestart;',
    'globalThis.api = api;'
  ].join('\n'), sandbox);
  sandbox.calls = calls;
  return sandbox;
}

const DIRTY_ALL_TC = {
  ok: false, code: 'dirty-tree',
  error: 'local changes present — all of them TangleClaw-written; retry with the discard option',
  fromSha: 'aaa', toRef: null, toSha: null,
  dirty: { discardable: ['.tangleclaw/', '.claude/settings.json'], realWork: [] }
};

const DIRTY_MIXED = {
  ok: false, code: 'dirty-tree',
  error: 'local changes present — commit or stash before updating',
  fromSha: 'aaa', toRef: null, toSha: null,
  dirty: { discardable: ['.tangleclaw/'], realWork: ['lib/projects.js'] }
};

describe('dashboard reaches the dirty-tree discard flow through the real api chain (#711 R-1)', () => {
  it('an all-TC 409 produces the confirm and a re-apply carrying discardDirty', async () => {
    const ctx = loadFlow((n) => {
      if (n === 1) return jsonRes(409, DIRTY_ALL_TC);
      // Second call: refuse generically so the flow ends before the restart
      // plumbing — the assertion target is the wire, not the restart.
      return jsonRes(409, { ok: false, code: 'no-update', error: 'raced: already updated' });
    });
    await ctx.applyUpdateAndRestart({ latestVersion: '9.9.9' });

    assert.equal(ctx.calls.confirms.length, 2, 'the update confirm, then the discard confirm');
    assert.match(ctx.calls.confirms[1], /\.tangleclaw\//, 'the confirm must NAME the files');
    assert.equal(ctx.calls.fetches.length, 2, 'accepting the confirm must re-apply');
    assert.deepEqual(ctx.calls.fetches[1].body, { discardDirty: true },
      'the re-apply must carry the explicit opt-in and nothing else');
  });

  it('declining the discard confirm applies nothing further', async () => {
    const ctx = loadFlow(() => jsonRes(409, DIRTY_ALL_TC), { confirmAnswers: [true, false] });
    await ctx.applyUpdateAndRestart({ latestVersion: '9.9.9' });
    assert.equal(ctx.calls.fetches.length, 1, 'a declined confirm must not re-apply');
    assert.equal(ctx.state ? ctx.state.restartInFlight : null, false,
      'the flow must release the in-flight latch');
  });

  it('a mixed 409 names the real-work files and never offers the discard', async () => {
    const ctx = loadFlow(() => jsonRes(409, DIRTY_MIXED));
    await ctx.applyUpdateAndRestart({ latestVersion: '9.9.9' });

    assert.equal(ctx.calls.confirms.length, 1, 'only the initial update confirm — no discard offer');
    assert.equal(ctx.calls.fetches.length, 1, 'no second apply');
    const refusal = ctx.calls.alerts.join('\n');
    assert.match(refusal, /lib\/projects\.js/, 'the refusal must name the blocking file');
    assert.match(refusal, /\.tangleclaw\//,
      'and still show the TC-written files waiting behind it');
  });
});
