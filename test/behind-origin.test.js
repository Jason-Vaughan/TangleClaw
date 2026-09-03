'use strict';

/*
 * #227 — the dashboard says when the local clone is behind origin/main.
 *
 * Backend half: `lib/behind-origin.js` with both git calls stubbed at its
 * `_internal` seam, so every failure branch is driven without a remote and
 * the cache is driven against a controlled clock.
 *
 * Frontend half: `renderBehindOriginBanner` is LIFTED from public/landing.js
 * and RUN against a DOM stub (the version-visibility.test.js approach) — a
 * grep can prove the word `hidden` appears; only a run proves the banner
 * comes down after a pull.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const behindOrigin = require('../lib/behind-origin');

const ROOT = path.join(__dirname, '..');
const LANDING_SRC = fs.readFileSync(path.join(ROOT, 'public', 'landing.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const STYLE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

/**
 * Slice a top-level function out of landing.js by brace matching.
 * @param {string} name - Function name as declared.
 * @returns {string} The full declaration text.
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
 * A DOM stub exposing only what the renderer touches.
 * @param {string[]} ids - Element ids to provide.
 * @returns {{els: object, document: object}}
 */
function makeDom(ids) {
  const els = {};
  for (const id of ids) {
    els[id] = {
      innerHTML: '',
      _hidden: true,
      classList: {
        add(c) { if (c === 'hidden') els[id]._hidden = true; },
        remove(c) { if (c === 'hidden') els[id]._hidden = false; }
      }
    };
  }
  return { els, document: { getElementById: (id) => els[id] || null } };
}

/**
 * Install stubbed git calls. `fetch` / `revList` are either an Error (the
 * call fails), a string (rev-list stdout), `null` (success with no output),
 * or the token 'throw' (the seam itself throws synchronously).
 * @param {{fetch?: Error|null|'throw', revList?: Error|string|'throw'}} plan
 * @returns {{fetches: () => number, revLists: () => number}}
 */
function stubGit(plan) {
  let fetches = 0;
  let revLists = 0;
  behindOrigin._internal.gitFetch = (cb) => {
    fetches++;
    if (plan.fetch === 'throw') throw new Error('spawn refused');
    setImmediate(() => cb(plan.fetch instanceof Error ? plan.fetch : null));
  };
  behindOrigin._internal.gitRevList = (cb) => {
    revLists++;
    if (plan.revList === 'throw') throw new Error('spawn refused');
    setImmediate(() => {
      if (plan.revList instanceof Error) cb(plan.revList, '');
      else cb(null, plan.revList == null ? '' : plan.revList);
    });
  };
  return { fetches: () => fetches, revLists: () => revLists };
}

describe('lib/behind-origin (#227)', () => {
  const origInternal = { ...behindOrigin._internal };

  beforeEach(() => behindOrigin._reset());
  afterEach(() => {
    Object.assign(behindOrigin._internal, origInternal);
    behindOrigin._reset();
  });

  describe('getRemoteCommitsAhead', () => {
    it('counts the commits origin/main has that HEAD lacks', async () => {
      const calls = stubGit({ fetch: null, revList: '3\n' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 3);
      assert.equal(calls.fetches(), 1, 'fetches before counting — a stale origin/main is the whole bug');
      assert.equal(calls.revLists(), 1);
    });

    it('is 0 when the clone is level with origin/main', async () => {
      stubGit({ fetch: null, revList: '0\n' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });

    it('is 0 with no remote configured — fetch fails, rev-list is never asked', async () => {
      const calls = stubGit({ fetch: new Error("fatal: 'origin' does not appear to be a git repository") });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
      assert.equal(calls.revLists(), 0, 'no point counting against a ref the fetch could not bring');
    });

    it('is 0 when the fetch fails (offline, refused, timed out)', async () => {
      const timeout = new Error('spawnSync git ETIMEDOUT');
      timeout.killed = true;
      stubGit({ fetch: timeout });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });

    it('is 0 when rev-list fails (origin/main absent after the fetch)', async () => {
      stubGit({ fetch: null, revList: new Error("fatal: bad revision 'HEAD..origin/main'") });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });

    it('is 0 on unparseable or negative rev-list output', async () => {
      stubGit({ fetch: null, revList: 'warning: something\n' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
      stubGit({ fetch: null, revList: '-4\n' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
      stubGit({ fetch: null, revList: '' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });

    it('never throws — even when the git seam itself throws (git absent)', async () => {
      stubGit({ fetch: 'throw' });
      await assert.doesNotReject(behindOrigin.getRemoteCommitsAhead());
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
      stubGit({ fetch: null, revList: 'throw' });
      assert.equal(await behindOrigin.getRemoteCommitsAhead(), 0);
    });
  });

  describe('cache', () => {
    it('refresh() stores the count with a checkedAt stamp', async () => {
      behindOrigin._internal.now = () => Date.parse('2026-01-01T00:00:00Z');
      stubGit({ fetch: null, revList: '2\n' });
      const result = await behindOrigin.refresh();
      assert.deepEqual(result, { commitsAhead: 2, checkedAt: '2026-01-01T00:00:00.000Z' });
    });

    it('refreshIfStale serves the cache inside the TTL and re-measures past it', async () => {
      let now = Date.parse('2026-01-01T00:00:00Z');
      behindOrigin._internal.now = () => now;
      const calls = stubGit({ fetch: null, revList: '2\n' });
      await behindOrigin.refreshIfStale();
      assert.equal(calls.fetches(), 1);

      now += behindOrigin.CACHE_TTL_MS - 1;
      const cached = await behindOrigin.refreshIfStale();
      assert.equal(calls.fetches(), 1, 'a cache younger than the TTL is served, not re-fetched');
      assert.equal(cached.commitsAhead, 2);

      now += 2;
      await behindOrigin.refreshIfStale();
      assert.equal(calls.fetches(), 2, 'past the TTL the answer is measured again');
    });

    it('coalesces concurrent refreshes onto one fetch (N tabs, one call to origin)', async () => {
      const calls = stubGit({ fetch: null, revList: '1\n' });
      const [a, b, c] = await Promise.all([
        behindOrigin.refresh(), behindOrigin.refresh(), behindOrigin.refresh()
      ]);
      assert.equal(calls.fetches(), 1);
      assert.equal(a, b);
      assert.equal(b, c);
    });

    it('snapshot() returns the cache immediately and starts one background refresh when it has expired', async () => {
      let now = Date.parse('2026-01-01T00:00:00Z');
      behindOrigin._internal.now = () => now;
      const calls = stubGit({ fetch: null, revList: '5\n' });

      // First poll: nothing measured yet, honest about it, fetch started.
      const first = behindOrigin.snapshot({});
      assert.deepEqual(first, { enabled: true, commitsAhead: 0, checkedAt: null });
      assert.equal(calls.fetches(), 1);
      // A second poll before it completes must not start a second fetch.
      behindOrigin.snapshot({});
      assert.equal(calls.fetches(), 1);

      await behindOrigin.refresh(); // joins the in-flight measurement
      const second = behindOrigin.snapshot({});
      assert.deepEqual(second, { enabled: true, commitsAhead: 5, checkedAt: '2026-01-01T00:00:00.000Z' });
      assert.equal(calls.fetches(), 1, 'a fresh cache is served without touching the network');

      now += behindOrigin.CACHE_TTL_MS + 1;
      const third = behindOrigin.snapshot({});
      assert.equal(third.commitsAhead, 5, 'the expired value is still returned while the refresh runs');
      assert.equal(calls.fetches(), 2, 'an expired cache starts exactly one background fetch');
    });
  });

  describe('config off-switch', () => {
    it('is on by default and only a literal false turns it off', () => {
      assert.equal(behindOrigin.isCheckEnabled(undefined), true);
      assert.equal(behindOrigin.isCheckEnabled({}), true);
      assert.equal(behindOrigin.isCheckEnabled({ behindOriginCheckEnabled: true }), true);
      assert.equal(behindOrigin.isCheckEnabled({ behindOriginCheckEnabled: 'false' }), true,
        'a non-boolean is not a choice — the default stays, as PATCH refuses the value');
      assert.equal(behindOrigin.isCheckEnabled({ behindOriginCheckEnabled: false }), false);
    });

    it('a disabled check reports enabled:false and never starts a fetch, even with an expired cache', async () => {
      const calls = stubGit({ fetch: null, revList: '7\n' });
      const snap = behindOrigin.snapshot({ behindOriginCheckEnabled: false });
      assert.deepEqual(snap, { enabled: false, commitsAhead: 0, checkedAt: null });
      assert.equal(calls.fetches(), 0);
    });

    it('a stale cached count is not reported once the operator disables the check', async () => {
      stubGit({ fetch: null, revList: '7\n' });
      await behindOrigin.refresh();
      assert.equal(behindOrigin.snapshot({}).commitsAhead, 7);
      const snap = behindOrigin.snapshot({ behindOriginCheckEnabled: false });
      assert.equal(snap.commitsAhead, 0, 'the flag is the operator\'s word; a cache must not override it');
      assert.equal(snap.enabled, false);
    });
  });
});

describe('behind-origin banner (#227) — executed against a DOM stub', () => {
  /**
   * Run the real renderer with a payload.
   * @param {*} payload - The `behindOrigin` field of /api/server-info.
   * @returns {{banner: object, text: object}}
   */
  function render(payload) {
    const dom = makeDom(['behindOriginBanner', 'behindOriginBannerText']);
    const ctx = vm.createContext({ document: dom.document, esc: (s) => String(s) });
    vm.runInContext(`${extract('renderBehindOriginBanner')}\nrenderBehindOriginBanner(payload);`,
      Object.assign(ctx, { payload }));
    return { banner: dom.els.behindOriginBanner, text: dom.els.behindOriginBannerText };
  }

  it('shows the count and the remedy when the clone is behind', () => {
    const { banner, text } = render({ enabled: true, commitsAhead: 3, checkedAt: 'T' });
    assert.equal(banner._hidden, false);
    assert.match(text.innerHTML, /3 new commits upstream on origin\/main\./);
    assert.match(text.innerHTML, /This checkout is behind — pull them when convenient\./);
    assert.match(text.innerHTML, /release tag updates through <em>Update now<\/em>/,
      'a tagged install must be pointed at the guarded applier, not a raw pull');
  });

  it('never hands anyone a verbatim git mutation — the #730 guard applies here too', () => {
    const { text } = render({ enabled: true, commitsAhead: 2, checkedAt: 'T' });
    assert.doesNotMatch(text.innerHTML, /git (pull|reset|stash)/,
      'a raw pull from an install detached at a release tag moves HEAD to a non-tag commit the applier refuses');
  });

  it('pluralises honestly for one commit', () => {
    const { text } = render({ enabled: true, commitsAhead: 1, checkedAt: 'T' });
    assert.match(text.innerHTML, /1 new commit upstream/);
    assert.doesNotMatch(text.innerHTML, /commits/);
  });

  it('comes down once a pull brings the count to 0 — hiding is as load-bearing as showing', () => {
    const dom = makeDom(['behindOriginBanner', 'behindOriginBannerText']);
    dom.els.behindOriginBanner._hidden = false;
    const ctx = vm.createContext({ document: dom.document, esc: (s) => String(s) });
    vm.runInContext(`${extract('renderBehindOriginBanner')}\nrenderBehindOriginBanner({ enabled: true, commitsAhead: 0, checkedAt: 'T' });`, ctx);
    assert.equal(dom.els.behindOriginBanner._hidden, true);
  });

  it('stays hidden when the check is disabled, unmeasured, absent (older server), or garbage', () => {
    assert.equal(render({ enabled: false, commitsAhead: 4, checkedAt: null }).banner._hidden, true,
      'a disabled check must not render a count it was told not to gather');
    assert.equal(render({ enabled: true, commitsAhead: 0, checkedAt: null }).banner._hidden, true);
    assert.equal(render(undefined).banner._hidden, true);
    assert.equal(render(null).banner._hidden, true);
    assert.equal(render({ enabled: true, commitsAhead: '<img src=x onerror=1>', checkedAt: 'T' }).banner._hidden, true,
      'a non-numeric count clamps to 0 — nothing unescaped reaches innerHTML');
  });

  it('is an info-tone sibling of the stale-server banner above the projects grid', () => {
    const stale = INDEX_SRC.indexOf('id="staleServerBanner"');
    const behind = INDEX_SRC.indexOf('id="behindOriginBanner"');
    const grid = INDEX_SRC.indexOf('id="cardsGrid"');
    assert.ok(stale > -1 && behind > -1 && grid > -1);
    assert.ok(stale < behind && behind < grid, 'rendered after the stale banner and before the grid');
    assert.match(INDEX_SRC, /id="behindOriginBanner" class="orphan-banner behind-origin-banner hidden" role="status"/,
      'hidden at rest; role=status not alert — the remedy is not urgent');
    assert.match(INDEX_SRC, /id="behindOriginBannerText"/);

    const rule = STYLE_SRC.match(/\.behind-origin-banner \{([^}]*)\}/);
    assert.ok(rule, 'style.css must style .behind-origin-banner');
    assert.doesNotMatch(rule[1], /--danger/, 'info tone, not the danger colour the stale-server banner uses');
    assert.match(rule[1], /background:/);
  });

  it('loadServerInfo renders it before the stale-server branches return', () => {
    const src = extract('loadServerInfo');
    const call = src.indexOf('renderBehindOriginBanner(data.behindOrigin)');
    const staleBranch = src.indexOf('if (data.isStale === null)');
    assert.ok(call > -1, 'loadServerInfo must call renderBehindOriginBanner');
    assert.ok(staleBranch > -1);
    assert.ok(call < staleBranch,
      'a checkout both behind upstream and ahead of the process must show both banners');
  });
});
