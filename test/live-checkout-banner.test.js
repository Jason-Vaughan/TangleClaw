'use strict';

/*
 * #993 / #1678 — the dashboard says what the live checkout is on, and whether
 * a stale server's unloaded commits need a restart.
 *
 * The renderers are LIFTED from public/landing.js and RUN against a DOM stub
 * (the behind-origin.test.js approach): only a run proves the banner comes
 * down when the condition clears and never renders "unknown" as clean.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LANDING_SRC = fs.readFileSync(path.join(ROOT, 'public', 'landing.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const STYLE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

/**
 * Slice a top-level function out of landing.js by brace matching.
 * @param {string} name
 * @returns {string}
 */
function extract(name) {
  const start = LANDING_SRC.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start > -1, `${name} should exist in landing.js`);
  let depth = 0;
  for (let i = LANDING_SRC.indexOf('{', start); i < LANDING_SRC.length; i++) {
    if (LANDING_SRC[i] === '{') depth++;
    else if (LANDING_SRC[i] === '}') {
      depth--;
      if (depth === 0) return LANDING_SRC.slice(start, i + 1);
    }
  }
  throw new Error(`could not brace-match ${name}`);
}

/**
 * A DOM stub with classList add/remove/toggle.
 * @param {string[]} ids
 * @returns {{els: object, document: object}}
 */
function makeDom(ids) {
  const els = {};
  for (const id of ids) {
    const classes = new Set(['hidden']);
    els[id] = {
      innerHTML: '',
      classes,
      get _hidden() { return classes.has('hidden'); },
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, force) { if (force) classes.add(c); else classes.delete(c); }
      }
    };
  }
  return { els, document: { getElementById: (id) => els[id] || null } };
}

/** A real HTML escaper, so an injection test proves escaping, not a pass-through. */
const ESC_SRC = extract('esc');

const LIVE_FNS = ['_liveCheckoutConditions', '_liveCheckoutUnknowns', 'renderLiveCheckoutBanner'].map(extract).join('\n');

/**
 * Run the live-checkout renderer.
 * @param {*} checkout
 * @param {*} [bo]
 * @param {object} [dom]
 * @returns {{banner: object, text: object}}
 */
function renderLive(checkout, bo, dom = makeDom(['liveCheckoutBanner', 'liveCheckoutBannerText'])) {
  const ctx = vm.createContext({ document: dom.document, checkout, bo });
  vm.runInContext(`${ESC_SRC}\n${LIVE_FNS}\nrenderLiveCheckoutBanner(checkout, bo);`, ctx);
  return { banner: dom.els.liveCheckoutBanner, text: dom.els.liveCheckoutBannerText };
}

/** A measured clean main, level with a fetched origin/main. */
function clean(over = {}) {
  return {
    state: 'measured', reason: null, measuredAt: '2026-09-22T10:00:00.000Z',
    branch: 'main', detached: false, tag: null, onDefaultBranch: true, headSha: 'a'.repeat(40),
    upstream: { ref: 'origin/main', sha: 'a'.repeat(40), observation: 'fetched', observedAt: '2026-09-22T10:00:00.000Z' },
    ahead: 0, behind: 0, relation: 'equal', unpushed: { count: 0, against: 'origin/main' },
    dirtyTracked: 0, untracked: 0, incomplete: [], ...over
  };
}
const BO_OK = { enabled: true, state: 'measured', commitsAhead: 0, checkedAt: 'T', reason: null };

describe('live-checkout banner (#993) — executed against a DOM stub', () => {
  it('stays hidden for a clean main level with origin/main', () => {
    assert.equal(renderLive(clean(), BO_OK).banner._hidden, true);
  });

  it('the #993 incident: names the branch, unpushed commits, edits and untracked files together', () => {
    const { banner, text } = renderLive(clean({
      branch: 'feat/771-185-wrap-progress', onDefaultBranch: false,
      unpushed: { count: 4, against: 'origin/main' }, dirtyTracked: 1, untracked: 4
    }), BO_OK);
    assert.equal(banner._hidden, false);
    assert.equal(banner.classes.has('live-checkout-banner-unknown'), false, 'warning tone when a condition holds');
    assert.match(text.innerHTML, /on branch <code>feat\/771-185-wrap-progress<\/code>, not <code>main<\/code>/);
    assert.match(text.innerHTML, /4 commits not pushed to <code>origin\/main<\/code>/);
    assert.match(text.innerHTML, /1 uncommitted change to tracked files/);
    assert.match(text.innerHTML, /4 untracked paths/);
  });

  it('warns on a detached HEAD that is not a release tag, and not on one that is', () => {
    let r = renderLive(clean({ branch: null, detached: true, tag: null, onDefaultBranch: false }), BO_OK);
    assert.equal(r.banner._hidden, false);
    assert.match(r.text.innerHTML, /HEAD is detached at <code>aaaaaaa<\/code>, not a release tag/);
    r = renderLive(clean({ branch: null, detached: true, tag: 'v5.29.0', onDefaultBranch: false }), { ...BO_OK, state: 'skipped' });
    assert.equal(r.banner._hidden, true, 'a release-pinned install is the healthy state the self-updater leaves');
  });

  it('unknown is never clean: a failed probe, an unread fact, or a failed origin check is shown', () => {
    let r = renderLive(clean({ state: 'unknown', reason: 'git status: timed out', branch: null, dirtyTracked: null, untracked: null }), BO_OK);
    assert.equal(r.banner._hidden, false);
    assert.equal(r.banner.classes.has('live-checkout-banner-unknown'), true, 'info tone when only unknowns');
    assert.match(r.text.innerHTML, /git state unreadable \(git status: timed out\)/);
    r = renderLive(clean({ incomplete: ['upstream: origin/main is not present in this clone'] }), BO_OK);
    assert.equal(r.banner._hidden, false);
    assert.match(r.text.innerHTML, /origin\/main is not present/);
    r = renderLive(clean(), { ...BO_OK, state: 'unknown', reason: 'fetch failed: offline' });
    assert.equal(r.banner._hidden, false);
    assert.match(r.text.innerHTML, /origin\/main not checked \(fetch failed: offline\) — this checkout may be behind/);
  });

  it('a disabled origin check is the operator\'s choice, not an unknown to report', () => {
    assert.equal(renderLive(clean({ upstream: { ref: 'origin/main', sha: 'a'.repeat(40), observation: 'local-ref', observedAt: null } }),
      { enabled: false, state: 'disabled', reason: 'check turned off' }).banner._hidden, true);
  });

  it('says whether origin/main was fetched or is only the local ref', () => {
    let r = renderLive(clean({ dirtyTracked: 2 }), BO_OK);
    assert.match(r.text.innerHTML, /origin\/main is <code>aaaaaaa<\/code> \(fetched /);
    r = renderLive(clean({ dirtyTracked: 2, upstream: { ref: 'origin/main', sha: 'a'.repeat(40), observation: 'local-ref', observedAt: null } }), BO_OK);
    assert.match(r.text.innerHTML, /local ref, not confirmed by a fetch since it was read/);
  });

  it('stays hidden while pending, with no git by design, or from an older server', () => {
    assert.equal(renderLive({ state: 'pending' }, BO_OK).banner._hidden, true);
    assert.equal(renderLive({ state: 'no-git' }, BO_OK).banner._hidden, true);
    assert.equal(renderLive(undefined, BO_OK).banner._hidden, true);
    assert.equal(renderLive(null, undefined).banner._hidden, true);
  });

  it('comes down when the condition clears — hiding is as load-bearing as showing', () => {
    const dom = makeDom(['liveCheckoutBanner', 'liveCheckoutBannerText']);
    renderLive(clean({ untracked: 3 }), BO_OK, dom);
    assert.equal(dom.els.liveCheckoutBanner._hidden, false);
    renderLive(clean(), BO_OK, dom);
    assert.equal(dom.els.liveCheckoutBanner._hidden, true);
  });

  it('escapes branch names and clamps counts before innerHTML', () => {
    const { text } = renderLive(clean({
      branch: '<img src=x onerror=1>', onDefaultBranch: false, dirtyTracked: '<b>', untracked: -2,
      unpushed: { count: 'x', against: '<i>' }
    }), BO_OK);
    assert.doesNotMatch(text.innerHTML, /<img|<b>|<i>/);
    assert.match(text.innerHTML, /&lt;img/);
    assert.doesNotMatch(text.innerHTML, /uncommitted|untracked|not pushed/, 'non-numeric counts clamp to 0');
  });

  it('offers no action and no dismiss control — it states what is served', () => {
    const m = INDEX_SRC.match(/<div id="liveCheckoutBanner"[\s\S]*?<\/div>/);
    assert.ok(m, 'index.html has the banner');
    assert.match(m[0], /class="orphan-banner live-checkout-banner hidden" role="status"/);
    assert.doesNotMatch(m[0], /<button/);
    const stale = INDEX_SRC.indexOf('id="staleServerBanner"');
    const live = INDEX_SRC.indexOf('id="liveCheckoutBanner"');
    const grid = INDEX_SRC.indexOf('id="cardsGrid"');
    assert.ok(stale < live && live < grid, 'in the alert stack above the projects grid');
    assert.match(STYLE_SRC, /\.live-checkout-banner\.live-checkout-banner-unknown \{/);
  });

  it('loadServerInfo renders it before the stale-server branches return', () => {
    const src = extract('loadServerInfo');
    const call = src.indexOf('renderLiveCheckoutBanner(data.liveCheckout, data.behindOrigin)');
    assert.ok(call > -1);
    assert.ok(call < src.indexOf('if (data.isStale === null)'));
  });
});

describe('stale-server banner restart impact (#1678)', () => {
  /**
   * Run the real stale renderer.
   * @param {object} info
   * @returns {{banner: object, text: object}}
   */
  function renderStale(info) {
    const dom = makeDom(['staleServerBanner', 'staleServerBannerText', 'staleServerRestartBtn']);
    const ctx = vm.createContext({ document: dom.document, info, formatUptime: (s) => `${s}s` });
    vm.runInContext(`${ESC_SRC}\n${extract('_restartImpactWording')}\n${extract('toggleStaleRestartBtn')}\n${extract('renderStaleServerBanner')}\nrenderStaleServerBanner(info);`, ctx);
    return { banner: dom.els.staleServerBanner, text: dom.els.staleServerBannerText, btn: dom.els.staleServerRestartBtn };
  }
  const base = { startupSha: 'd0124256d000', currentDiskSha: '7e25288c5000', commitsAhead: 2, uptimeSeconds: 5, restartMechanism: 'launchctl' };

  it('records-only says no restart is needed, keeps the banner, and hides its restart button (D6)', () => {
    const r = renderStale({ ...base, restartImpact: { impact: 'records-only', executablePaths: [], recordsPaths: ['docs/a.md'] } });
    assert.equal(r.banner._hidden, false, 'the operator still sees that disk moved');
    assert.match(r.text.innerHTML, /Only records changed on disk — no restart needed\./);
    assert.doesNotMatch(r.text.innerHTML, /Restart TC to load/);
    assert.equal(r.btn._hidden, true, 'nothing to load, so the banner offers no restart');
  });

  it('keeps the restart button for executable, mixed, unknown, pending and a downloaded release', () => {
    for (const ri of [{ impact: 'executable', executablePaths: ['lib/a.js'] }, { impact: 'mixed', executablePaths: ['lib/a.js'] },
      { impact: 'unknown', reason: 'x' }, { impact: 'pending' }, undefined]) {
      assert.equal(renderStale({ ...base, restartImpact: ri }).btn._hidden, false, JSON.stringify(ri));
    }
    const rel = renderStale({ ...base, runningVersion: '5.29.0', diskVersion: '5.30.0',
      restartImpact: { impact: 'records-only', executablePaths: [] } });
    assert.match(rel.text.innerHTML, /v5\.30\.0 is downloaded — restart to finish/);
    assert.equal(rel.btn._hidden, false, 'a downloaded release always needs its restart');
  });

  it('a later executable range brings the button back after a records-only one hid it', () => {
    const dom = makeDom(['staleServerBanner', 'staleServerBannerText', 'staleServerRestartBtn']);
    const run = (info) => {
      const ctx = vm.createContext({ document: dom.document, info, formatUptime: (s) => `${s}s` });
      vm.runInContext(`${ESC_SRC}\n${extract('_restartImpactWording')}\n${extract('toggleStaleRestartBtn')}\n${extract('renderStaleServerBanner')}\nrenderStaleServerBanner(info);`, ctx);
    };
    run({ ...base, restartImpact: { impact: 'records-only' } });
    assert.equal(dom.els.staleServerRestartBtn._hidden, true);
    run({ ...base, restartImpact: { impact: 'executable', executablePaths: ['server.js'] } });
    assert.equal(dom.els.staleServerRestartBtn._hidden, false);
  });

  it('executable and mixed keep the restart advice and name the code that changed', () => {
    for (const impact of ['executable', 'mixed']) {
      const r = renderStale({ ...base, restartImpact: { impact, executablePaths: ['lib/a.js', 'server.js', 'public/x.js', 'lib/b.js'] } });
      assert.match(r.text.innerHTML, /TC server is out of date\./);
      assert.match(r.text.innerHTML, /Restart TC to load the latest code \(changed: <code>lib\/a\.js<\/code>, <code>server\.js<\/code>, <code>public\/x\.js<\/code> and more\)\./);
    }
  });

  it('unknown says so and keeps the restart advice — never read as records-only', () => {
    const r = renderStale({ ...base, restartImpact: { impact: 'unknown', reason: 'git diff: bad object' } });
    assert.match(r.text.innerHTML, /Whether a restart loads new code is unknown \(git diff: bad object\)\. Restart TC/);
    assert.doesNotMatch(r.text.innerHTML, /no restart needed/);
  });

  it('pending, missing (older server) or garbage keep today\'s wording', () => {
    for (const ri of [{ impact: 'pending' }, undefined, null, { impact: '<script>' }]) {
      const r = renderStale({ ...base, restartImpact: ri });
      assert.match(r.text.innerHTML, /TC server is out of date\.<\/strong> .*Restart TC to load the latest code\./);
      assert.doesNotMatch(r.text.innerHTML, /<script>/);
    }
  });

  it('escapes changed paths', () => {
    const r = renderStale({ ...base, restartImpact: { impact: 'executable', executablePaths: ['lib/<img src=x>.js'] } });
    assert.doesNotMatch(r.text.innerHTML, /<img/);
  });
});
