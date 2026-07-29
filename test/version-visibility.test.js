'use strict';

/*
 * #744 / #745 — the running version must be visible, and true, everywhere it
 * appears: the dashboard header, the update pill, and every session's status
 * bar.
 *
 * The bug class these pin down is one-directional rendering — code that shows
 * a thing and has no path that ever takes it back down. Three separate
 * instances shipped together: the version label written once at page load, the
 * update pill with no hide path, and the stale-server banner with no hide path.
 * Each looks correct in isolation and each lies after a restart the page did
 * not drive.
 *
 * The frontend halves are executed, not grepped — `landing.js` is a browser
 * global rather than a module, so they are sliced out and run against a DOM
 * stub the way test/bind-notice-render.test.js does. A grep can prove the word
 * `hidden` appears; only a run proves the pill comes down.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tmux = require('../lib/tmux');
const serverInfo = require('../lib/server-info');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

/**
 * Slice a top-level function out of landing.js by brace matching.
 * @param {string} name - Function name as declared.
 * @returns {string} The full declaration text.
 */
function extract(name) {
  const start = SRC.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start > -1, `${name} should exist in landing.js`);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`could not brace-match ${name}`);
}

/**
 * A DOM stub exposing only what these renderers touch.
 * @param {string[]} ids - Element ids to provide.
 * @returns {{els: object, document: object}}
 */
function makeDom(ids) {
  const els = {};
  for (const id of ids) {
    els[id] = {
      textContent: '',
      innerHTML: '',
      _hidden: true,
      classList: {
        add(c) { if (c === 'hidden') els[id]._hidden = true; },
        remove(c) { if (c === 'hidden') els[id]._hidden = false; }
      },
      // The show path wires an apply and a dismiss button into the pill it just
      // rendered, so querySelector must hand back something listenable.
      querySelector: () => ({ addEventListener: () => {}, textContent: '', disabled: false }),
      addEventListener: () => {}
    };
  }
  return { els, document: { getElementById: (id) => els[id] || null } };
}

describe('#745 status bar names the version the process actually loaded', () => {
  describe('buildStatusLeft', () => {
    it('carries the version beside the brand', () => {
      const s = tmux.buildStatusLeft('4.35.0');
      assert.match(s, /TangleClaw v4\.35\.0/);
    });

    it('degrades to the bare brand rather than inventing a version', () => {
      // getRunningVersion() is null until the server captures startup. A bar
      // reading "v" or "vnull" would be worse than one that declines to say.
      for (const missing of [null, undefined, '', '   ', 42, {}]) {
        const s = tmux.buildStatusLeft(missing);
        assert.match(s, /TangleClaw/);
        assert.doesNotMatch(s, /v(null|undefined|\s|$)/,
          `expected no bogus version for ${JSON.stringify(missing)}, got: ${s}`);
      }
    });

    it('fits the 30-column status-left budget deploy/tmux.conf sets', () => {
      // Overflow truncates silently, and the version is the part on the right.
      const visible = tmux.buildStatusLeft('4.35.0').replace(/#\[[^\]]*\]/g, '');
      assert.ok(visible.length <= 30, `status-left is ${visible.length} cols: "${visible}"`);
    });
  });

  describe('refreshStatusBars', () => {
    const brandedOld = 'status-left "#[fg=#8BC34A,bold] TangleClaw v4.34.0 "';

    /** Build an exec stub that records set-option calls. @returns {object} */
    function harness(sessions, current) {
      const setCalls = [];
      const exec = (cmd) => {
        if (cmd.includes('set-option')) { setCalls.push(cmd); return ''; }
        const name = /-t '?([^' ]+)/.exec(cmd)[1];
        const val = current[name];
        if (val instanceof Error) throw val;
        return val;
      };
      return {
        setCalls,
        deps: { listSessions: () => sessions, exec, version: () => '4.35.0' }
      };
    }

    it('re-stamps a session that predates the update', () => {
      const h = harness([{ name: 'proj' }], { proj: brandedOld });
      const res = tmux.refreshStatusBars(h.deps);
      assert.deepEqual(res, { updated: 1, skipped: 0 });
      assert.match(h.setCalls[0], /TangleClaw v4\.35\.0/);
    });

    it('leaves a session TangleClaw did not brand alone', () => {
      // listSessions() returns every tmux session on the host, including ones
      // started by hand. Branding those would be us vandalising someone's shell.
      const h = harness([{ name: 'mine' }], { mine: 'status-left "[my-shell] "' });
      const res = tmux.refreshStatusBars(h.deps);
      assert.deepEqual(res, { updated: 0, skipped: 1 });
      assert.equal(h.setCalls.length, 0);
    });

    it('does not rewrite a bar that is already current', () => {
      const h = harness([{ name: 'proj' }], { proj: 'status-left "#[x] TangleClaw v4.35.0 "' });
      const res = tmux.refreshStatusBars(h.deps);
      assert.deepEqual(res, { updated: 0, skipped: 1 });
      assert.equal(h.setCalls.length, 0);
    });

    it('recognises a current bar even if tmux stops quoting the value', () => {
      // The guard used to anchor on a trailing space, which survives _exec's
      // trim only while tmux quotes values containing one. If it ever stopped,
      // every branded bar would be re-stamped on every boot.
      const h = harness([{ name: 'proj' }], { proj: 'status-left #[x] TangleClaw v4.35.0' });
      const res = tmux.refreshStatusBars(h.deps);
      assert.deepEqual(res, { updated: 0, skipped: 1 });
    });

    it('corrects a version that is a prefix of the current one', () => {
      // `v4.3` is a substring of `v4.35.0`, so a prefix comparison would read
      // this bar as already-current and leave it wrong forever.
      const h = harness([{ name: 'proj' }], { proj: 'status-left "#[x] TangleClaw v4.3 "' });
      const res = tmux.refreshStatusBars(h.deps);
      assert.deepEqual(res, { updated: 1, skipped: 0 });
      assert.match(h.setCalls[0], /TangleClaw v4\.35\.0/);
    });

    it('keeps going when one session fails', () => {
      // Multi-session hosts are the norm here; one dead session must not
      // strand the rest on a version they no longer run.
      const h = harness(
        [{ name: 'bad' }, { name: 'good' }],
        { bad: new Error('no server running'), good: brandedOld }
      );
      const res = tmux.refreshStatusBars(h.deps);
      assert.deepEqual(res, { updated: 1, skipped: 1 });
      assert.match(h.setCalls[0], /-t 'good'/);
    });

    it('does nothing at all when the running version is unknown', () => {
      // Stamping buildStatusLeft(null) here would strip a correct version off
      // every bar — worse than the staleness it exists to fix.
      const h = harness([{ name: 'proj' }], { proj: brandedOld });
      const res = tmux.refreshStatusBars({ ...h.deps, version: () => null });
      assert.deepEqual(res, { updated: 0, skipped: 0 });
      assert.equal(h.setCalls.length, 0);
    });
  });

  describe('getRunningVersion', () => {
    it('holds the startup version when the checkout moves underneath it', () => {
      // The behaviour #745 turns on, so it is asserted by making the two
      // disagree — a self-update checks out the new release while this process
      // keeps serving the old one, and that is exactly when someone reads the
      // status bar. Comparing getRunningVersion() to getServerInfo()'s own copy
      // would pass just as well if this were rewritten to read from disk.
      const realRead = serverInfo._internal.readFileSync;
      try {
        serverInfo.__unsafeResetForTest();
        serverInfo._internal.readFileSync = () => JSON.stringify({ version: '1.1.1' });
        serverInfo.captureStartup();
        assert.equal(serverInfo.getRunningVersion(), '1.1.1');

        // The checkout advances; the running process has not restarted.
        serverInfo._internal.readFileSync = () => JSON.stringify({ version: '9.9.9' });
        assert.equal(serverInfo.getRunningVersion(), '1.1.1',
          'must report what this process loaded, never what is on disk now');
        assert.equal(serverInfo.getServerInfo().diskVersion, '9.9.9',
          'the disk read itself still works — the two are meant to differ here');
      } finally {
        serverInfo._internal.readFileSync = realRead;
        serverInfo.__unsafeResetForTest();
        serverInfo.captureStartup();
      }
    });
  });
});

describe('#744 both writers of the version label agree by construction', () => {
  it('/api/version answers with the running version, not the disk read', () => {
    // The header is written from GET /api/version at page load and from
    // /api/server-info's runningVersion on every poll. Those are two endpoints
    // answering one question, and they used to derive it differently — so the
    // label could change under the operator 60 seconds after load with nothing
    // having happened. Pinned at the source rather than by ordering the two
    // calls, because the first-run wizard path never reaches the poll at all.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = src.indexOf('function _getVersion(');
    assert.ok(start > -1, '_getVersion should exist');
    const body = src.slice(start, src.indexOf('\n}', start));
    const runningIdx = body.indexOf('serverInfo.getRunningVersion()');
    const diskIdx = body.indexOf('readFileSync');
    assert.ok(runningIdx > -1, '_getVersion must consult the running version');
    assert.ok(diskIdx === -1 || runningIdx < diskIdx,
      'the running version must be preferred over the disk read, not the reverse');
  });
});

describe('#744 the update check asks about the code that is running', () => {
  it('compares against the loaded version, not the checkout', () => {
    // Otherwise the checker contradicts the server it reports on: after a
    // self-update's checkout, version.json already reads the new number while
    // the old code still serves, so the checker would answer "up to date" and
    // the dashboard would take the pill down for a server that has not
    // restarted onto it.
    const updateChecker = require('../lib/update-checker');
    const realRead = serverInfo._internal.readFileSync;
    try {
      serverInfo.__unsafeResetForTest();
      serverInfo._internal.readFileSync = () => JSON.stringify({ version: '2.0.0' });
      serverInfo.captureStartup();
      assert.equal(updateChecker._getCurrentVersion(), '2.0.0');

      // The checkout advances past the running process.
      serverInfo._internal.readFileSync = () => JSON.stringify({ version: '3.0.0' });
      assert.equal(updateChecker._getCurrentVersion(), '2.0.0',
        'the checker must keep comparing against the code that is running');
    } finally {
      serverInfo._internal.readFileSync = realRead;
      serverInfo.__unsafeResetForTest();
      serverInfo.captureStartup();
    }
  });
});

describe('#744 the dashboard stops advertising a version it is not running', () => {
  /**
   * Run loadServerInfo against a stubbed /api/server-info payload.
   * @param {object} payload - The server-info response.
   * @param {object} [seed] - Initial `state` values.
   * @returns {Promise<{els: object, state: object, updateChecks: number}>}
   */
  async function runServerInfo(payload, seed = {}) {
    const dom = makeDom(['version', 'staleServerBanner', 'staleServerBannerText',
      'updatePill', 'restartBtn', 'staleServerRestartBtn']);
    let updateChecks = 0;
    const state = { restartMechanism: null, serverStartedAt: null, ...seed };
    const ctx = vm.createContext({
      document: dom.document,
      state,
      api: async () => payload,
      // Module-level state renderRunningVersion consults so a manual check's
      // transient result (#716) is not overwritten mid-display by this poll.
      // Seeded false: no check result is showing in these scenarios.
      _versionLabelHeld: false,
      _lastRenderedVersion: null,
      loadUpdateStatus: async () => { updateChecks++; },
      renderAuthUser: () => {},
      renderAuthStatus: () => {},
      renderBindNotice: () => {},
      renderStaleServerBanner: () => { dom.els.staleServerBanner.classList.remove('hidden'); },
      esc: (s) => String(s)
    });
    const src = [extract('loadServerInfo'), extract('renderRunningVersion'),
      extract('hideStaleServerBanner'), 'loadServerInfo();'].join('\n');
    await vm.runInContext(src, ctx);
    return { els: dom.els, state, updateChecks };
  }

  it('tracks the running version on every poll, not just at page load', async () => {
    const { els } = await runServerInfo({ runningVersion: '4.35.0', startedAt: 'T1' });
    assert.equal(els.version.textContent, 'v4.35.0');
  });

  it('leaves the label alone when the server does not report a version', async () => {
    // An older server predating the field should read as unchanged, not blank.
    const dom = await runServerInfo({ startedAt: 'T1' });
    assert.equal(dom.els.version.textContent, '');
  });

  it('re-checks for updates when the process it is talking to changed', async () => {
    // The restart this page did not drive: a terminal apply-update.js, a
    // launchctl kickstart, a launchd respawn.
    const { updateChecks } = await runServerInfo(
      { runningVersion: '4.35.0', startedAt: 'T2' }, { serverStartedAt: 'T1' }
    );
    assert.equal(updateChecks, 1);
  });

  it('does not re-check when the same process answers again', async () => {
    const { updateChecks } = await runServerInfo(
      { runningVersion: '4.35.0', startedAt: 'T1' }, { serverStartedAt: 'T1' }
    );
    assert.equal(updateChecks, 0);
  });

  it('does not re-check on the first poll of a fresh page', async () => {
    // No baseline means nothing changed — treating it as a restart would fire
    // a redundant check on every page load.
    const { updateChecks, state } = await runServerInfo({ runningVersion: '4.35.0', startedAt: 'T1' });
    assert.equal(updateChecks, 0);
    assert.equal(state.serverStartedAt, 'T1');
  });

  it('takes the stale-server banner down once the restart resolves it', async () => {
    const { els } = await runServerInfo({ runningVersion: '4.35.0', startedAt: 'T1', isStale: false });
    assert.equal(els.staleServerBanner._hidden, true);
  });

  it('still raises the banner while the server really is stale', async () => {
    const { els } = await runServerInfo({ runningVersion: '4.34.0', startedAt: 'T1', isStale: true });
    assert.equal(els.staleServerBanner._hidden, false);
  });

  describe('the update pill comes down', () => {
    /**
     * Run loadUpdateStatus against a stubbed /api/update-status payload.
     * @param {object|null} payload - The response.
     * @param {boolean} [dismissed] - Whether this version was dismissed.
     * @returns {Promise<object>} The stubbed elements.
     */
    async function runUpdateStatus(payload, dismissed = false) {
      const dom = makeDom(['updatePill', 'version']);
      dom.els.updatePill.classList.remove('hidden'); // a pill is already showing
      const ctx = vm.createContext({
        document: dom.document,
        api: async () => payload,
        // The refresh path (#716) goes through apiMutate; stubbed to the same
        // payload so a test can drive either without changing its expectation.
        apiMutate: async () => payload,
        localStorage: { getItem: () => (dismissed ? '1' : null), setItem: () => {} },
        esc: (s) => String(s)
      });
      await vm.runInContext(
        `${extract('_agoLabel')}\n${extract('renderVersionCheckHint')}\n`
        + `${extract('loadUpdateStatus')}\nloadUpdateStatus();`,
        ctx
      );
      return dom.els;
    }

    it('hides once the offered update is installed', async () => {
      // The state it most often re-runs into after a restart.
      const els = await runUpdateStatus({
        updateAvailable: false, currentVersion: '4.35.0', checkedAt: '2026-07-28T00:00:00Z'
      });
      assert.equal(els.updatePill._hidden, true);
    });

    it('leaves the pill alone when the server has not checked yet', async () => {
      // `startChecker` waits 60s before its first check and answers
      // {updateAvailable: false, checkedAt: null} until then — and a restart
      // puts the page right into that window. Reading it as "no update" would
      // take down a pill for an update that is still genuinely available.
      const els = await runUpdateStatus({ updateAvailable: false, latestVersion: null, checkedAt: null });
      assert.equal(els.updatePill._hidden, false, 'not-checked-yet is not an answer');
    });

    it('leaves the pill alone when the request failed', async () => {
      // api() returns null on any non-OK response. Absence of an answer is not
      // an answer of absence.
      for (const nothing of [null, undefined]) {
        const els = await runUpdateStatus(nothing);
        assert.equal(els.updatePill._hidden, false);
      }
    });

    it('hides a version the operator already dismissed', async () => {
      const els = await runUpdateStatus(
        { updateAvailable: true, latestVersion: '4.36.0', checkedAt: '2026-07-28T00:00:00Z' }, true
      );
      assert.equal(els.updatePill._hidden, true);
    });

    it('still shows a genuine update', async () => {
      const els = await runUpdateStatus({
        updateAvailable: true, latestVersion: '4.36.0', checkedAt: '2026-07-28T00:00:00Z'
      });
      assert.equal(els.updatePill._hidden, false);
      assert.match(els.updatePill.innerHTML, /4\.36\.0/);
    });

    it('re-asks on a schedule, so a provisional answer is not the last word', async () => {
      // Two of its answers are deliberately left showing rather than hidden.
      // Without a retry the pill would stay up for the life of the page.
      const polling = extract('startPolling');
      assert.match(polling, /loop\(loadUpdateStatus,/,
        'loadUpdateStatus must be in the polling loop, or a provisional answer is permanent');
    });
  });
});

/*
 * #716 — the absence of an update pill must be falsifiable.
 *
 * The pill only exists when an update exists, so "no pill" previously covered
 * three different facts an operator acts on differently: checked and current,
 * never checked, and the check failed. Measured on this repo 2026-07-29 — a
 * release published 37 minutes after the server's only check stayed invisible,
 * because GET /api/update-status is a pure cache read and nothing re-measured.
 */
describe('#716 update checks happen when they matter', () => {
  /**
   * Run loadUpdateStatus and hand back the version element's tooltip plus which
   * transport was used.
   * @param {object|null} payload - The stubbed response.
   * @param {object} [opts] - Passed through to loadUpdateStatus.
   * @returns {Promise<{els: object, calls: string[]}>}
   */
  async function runHint(payload, opts) {
    const dom = makeDom(['updatePill', 'version']);
    const calls = [];
    const ctx = vm.createContext({
      document: dom.document,
      api: async () => { calls.push('GET'); return payload; },
      apiMutate: async (url, method, body) => {
        calls.push(`${method} ${url} manual=${body && body.manual}`);
        return payload;
      },
      localStorage: { getItem: () => null, setItem: () => {} },
      esc: (s) => String(s)
    });
    await vm.runInContext(
      `${extract('_agoLabel')}\n${extract('renderVersionCheckHint')}\n`
      + `${extract('loadUpdateStatus')}\n`
      + `loadUpdateStatus(${opts ? JSON.stringify(opts) : ''});`,
      ctx
    );
    return { els: dom.els, calls };
  }

  it('distinguishes "never checked" from "checked and current"', async () => {
    const cold = await runHint({ updateAvailable: false, latestVersion: null, checkedAt: null });
    assert.match(cold.els.version.title, /not checked/i,
      'a cold cache must not read as up to date — it is the state every restart lands in');

    const measured = await runHint({
      updateAvailable: false, latestVersion: null, checkOk: true,
      checkedAt: new Date().toISOString()
    });
    assert.match(measured.els.version.title, /up to date/i);
    assert.doesNotMatch(measured.els.version.title, /not checked/i);
  });

  it('says a failed check failed, rather than reporting it as up to date', async () => {
    // The failure path and the no-tags-found path built byte-identical payloads
    // before `checkOk` existed, so an offline box claimed it was current.
    const { els } = await runHint({
      updateAvailable: false, latestVersion: null, checkOk: false,
      checkedAt: new Date().toISOString()
    });
    assert.match(els.version.title, /failed/i);
    assert.doesNotMatch(els.version.title, /up to date/i);
  });

  it('reports an unreachable server rather than silently keeping a stale hint', async () => {
    const { els } = await runHint(null);
    assert.match(els.version.title, /couldn't reach|could not reach/i);
  });

  it('reads the cache by default and measures only when asked', async () => {
    const cached = await runHint({ updateAvailable: false, checkOk: true, checkedAt: new Date().toISOString() });
    assert.deepEqual(cached.calls, ['GET'],
      'the 5-minute poll must stay a cache read — refreshing it would be a git ls-remote every 5 minutes per tab');

    const refreshed = await runHint(
      { updateAvailable: false, checkOk: true, checkedAt: new Date().toISOString() },
      { refresh: true, manual: true }
    );
    assert.deepEqual(refreshed.calls, ['POST /api/update/check manual=true']);
  });

  it('carries the manual flag only when the operator actually asked', async () => {
    // The flag selects the tighter staleness floor server-side; an automatic
    // refresh claiming to be manual would defeat the throttle it exists for.
    const auto = await runHint(
      { updateAvailable: false, checkOk: true, checkedAt: new Date().toISOString() },
      { refresh: true }
    );
    assert.deepEqual(auto.calls, ['POST /api/update/check manual=false']);
  });

  it('wires the load, the refocus, and the operator gesture', () => {
    // Each of the three is a separate reason the answer goes stale; a grep here
    // is honest because the behaviors themselves are exercised above and in
    // update-checker.test.js.
    assert.match(SRC, /loadUpdateStatus\(\{ refresh: true \}\)[\s\S]{0,80}loadServerInfo\(\)/,
      'page load must measure, not read a four-hour-old cache');
    assert.match(SRC, /visibilitychange[\s\S]{0,200}loadUpdateStatus\(\{ refresh: true \}\)/,
      'returning to the tab is when the page is most likely stale');
    assert.match(SRC, /function wireVersionCheck\(/,
      'the operator needs a control, or "no pill" stays unfalsifiable');
  });
});
