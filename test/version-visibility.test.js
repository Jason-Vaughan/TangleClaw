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
    it('reports the version captured at startup, not the one on disk', () => {
      // The whole point: between a self-update's checkout and its restart the
      // two disagree, and that is exactly when someone asks.
      serverInfo.captureStartup();
      const info = serverInfo.getServerInfo();
      assert.equal(serverInfo.getRunningVersion(), info.runningVersion);
    });
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
      const dom = makeDom(['updatePill']);
      dom.els.updatePill.classList.remove('hidden'); // a pill is already showing
      const ctx = vm.createContext({
        document: dom.document,
        api: async () => payload,
        localStorage: { getItem: () => (dismissed ? '1' : null), setItem: () => {} },
        esc: (s) => String(s)
      });
      await vm.runInContext(`${extract('loadUpdateStatus')}\nloadUpdateStatus();`, ctx);
      return dom.els;
    }

    it('hides once the offered update is installed', async () => {
      // The state it most often re-runs into after a restart.
      const els = await runUpdateStatus({ updateAvailable: false, currentVersion: '4.35.0' });
      assert.equal(els.updatePill._hidden, true);
    });

    it('hides when the endpoint gives nothing back', async () => {
      for (const nothing of [null, undefined, {}]) {
        const els = await runUpdateStatus(nothing);
        assert.equal(els.updatePill._hidden, true);
      }
    });

    it('hides a version the operator already dismissed', async () => {
      const els = await runUpdateStatus(
        { updateAvailable: true, latestVersion: '4.36.0' }, true
      );
      assert.equal(els.updatePill._hidden, true);
    });

    it('still shows a genuine update', async () => {
      const els = await runUpdateStatus({ updateAvailable: true, latestVersion: '4.36.0' });
      assert.equal(els.updatePill._hidden, false);
      assert.match(els.updatePill.innerHTML, /4\.36\.0/);
    });
  });
});
