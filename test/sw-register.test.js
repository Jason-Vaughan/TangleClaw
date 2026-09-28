'use strict';

/*
 * Regression tests for #380 (layer 2) — iOS Safari stranded operators on a
 * stale service worker because nothing ever asked the browser to check for a
 * new /sw.js after the initial load. registerServiceWorker() adds:
 *   1. reg.update() polling on load + on tab visibility (forces iOS to pick
 *      up a fresh worker on a long-lived tab), and
 *   2. a controllerchange -> reload, GUARDED so it only fires when an
 *      existing controller is replaced (not on first install) and at most
 *      once (no reload loop).
 *
 * Behavioural tests against a mock ServiceWorkerContainer — the reload guard
 * is the only risky logic, so it gets the most coverage.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { registerServiceWorker, requestServiceWorkerUpdate } = require('../public/sw-register.js');

/**
 * Minimal mock of the `navigator.serviceWorker` surface the function uses:
 * `controller`, `addEventListener`, and `register`.
 * @param {{controller?: boolean, registration?: Object}} cfg
 * @returns {Object} mock with a `_fire(type)` helper to dispatch events.
 */
function makeNav(cfg) {
  cfg = cfg || {};
  const listeners = {};
  const reg = cfg.registration || { updateCount: 0, update() { this.updateCount++; return Promise.resolve(); } };
  return {
    serviceWorker: {
      controller: cfg.controller ? {} : null,
      lastRegister: null,
      addEventListener(type, cb) { (listeners[type] = listeners[type] || []).push(cb); },
      _fire(type) { (listeners[type] || []).forEach((cb) => cb()); },
      register(url, opts) { this.lastRegister = { url, opts }; return Promise.resolve(reg); }
    },
    _reg: reg
  };
}

describe('registerServiceWorker (#380 SW update propagation)', () => {
  it('registers /sw.js with updateViaCache:none (preserves #258)', async () => {
    const nav = makeNav({});
    await registerServiceWorker(nav, {});
    assert.equal(nav.serviceWorker.lastRegister.url, '/sw.js');
    assert.equal(nav.serviceWorker.lastRegister.opts.updateViaCache, 'none');
  });

  it('calls reg.update() once on load (forces the iOS update check)', async () => {
    const nav = makeNav({});
    await registerServiceWorker(nav, {});
    assert.equal(nav._reg.updateCount, 1);
  });

  it('re-checks for an update when the tab regains visibility', async () => {
    const nav = makeNav({});
    let visCb = null;
    await registerServiceWorker(nav, { addVisibilityListener: (cb) => { visCb = cb; } });
    assert.equal(nav._reg.updateCount, 1, 'one check on load');
    assert.equal(typeof visCb, 'function', 'a visibility listener was registered');
    visCb();
    assert.equal(nav._reg.updateCount, 2, 'a second check on visibility');
  });

  it('reloads when an EXISTING controller is replaced (the stranded-update case)', async () => {
    const nav = makeNav({ controller: true });
    let reloads = 0;
    await registerServiceWorker(nav, { reload: () => { reloads++; } });
    nav.serviceWorker._fire('controllerchange');
    assert.equal(reloads, 1);
  });

  it('does NOT reload on first install (no prior controller)', async () => {
    const nav = makeNav({ controller: false });
    let reloads = 0;
    await registerServiceWorker(nav, { reload: () => { reloads++; } });
    nav.serviceWorker._fire('controllerchange');
    assert.equal(reloads, 0, 'first-ever activation must not refresh the page');
  });

  it('reloads at most once even if controllerchange fires repeatedly (no loop)', async () => {
    const nav = makeNav({ controller: true });
    let reloads = 0;
    await registerServiceWorker(nav, { reload: () => { reloads++; } });
    nav.serviceWorker._fire('controllerchange');
    nav.serviceWorker._fire('controllerchange');
    nav.serviceWorker._fire('controllerchange');
    assert.equal(reloads, 1);
  });

  it('returns null and does not throw when service workers are unavailable', async () => {
    assert.equal(await registerServiceWorker({}, {}), null);
    assert.equal(await registerServiceWorker(null, {}), null);
  });

  it('resolves to null (no throw) when registration rejects', async () => {
    const nav = makeNav({});
    nav.serviceWorker.register = () => Promise.reject(new Error('blocked'));
    assert.equal(await registerServiceWorker(nav, {}), null);
  });
});

describe('requestServiceWorkerUpdate (#411 update check when the stale-server banner appears)', () => {
  /**
   * A nav whose container also answers getRegistration, as a real browser's does.
   * @param {object} [cfg]
   * @returns {object}
   */
  function navWithRegistration(cfg) {
    const nav = makeNav(cfg);
    nav.serviceWorker.getRegistration = () => Promise.resolve(nav._reg);
    return nav;
  }

  it('checks for a new /sw.js through the page\'s existing registration', async () => {
    const nav = navWithRegistration({});
    assert.equal(await requestServiceWorkerUpdate(nav), true);
    assert.equal(nav._reg.updateCount, 1);
  });

  it('end to end: the banner-triggered check finds a new worker, which takes control and reloads the page once', async () => {
    // A long-lived tab: a worker already controls it, registration ran at load.
    const nav = navWithRegistration({ controller: true });
    let reloads = 0;
    await registerServiceWorker(nav, { reload: () => { reloads++; }, addVisibilityListener: () => {} });
    const loadChecks = nav._reg.updateCount;
    // The next update check finds a new sw.js; skipWaiting + clients.claim in
    // sw.js hand it control, which the browser reports as controllerchange.
    nav._reg.update = function () {
      this.updateCount++;
      nav.serviceWorker._fire('controllerchange');
      return Promise.resolve();
    };
    assert.equal(await requestServiceWorkerUpdate(nav), true);
    assert.equal(nav._reg.updateCount, loadChecks + 1, 'the banner issued exactly one extra check');
    assert.equal(reloads, 1, 'the existing guarded controllerchange path reloaded onto the new assets');
  });

  it('answers false, and never throws, when there is nothing to update', async () => {
    assert.equal(await requestServiceWorkerUpdate(undefined), false);
    assert.equal(await requestServiceWorkerUpdate({}), false);
    assert.equal(await requestServiceWorkerUpdate({ serviceWorker: {} }), false, 'no getRegistration');
    const none = makeNav({});
    none.serviceWorker.getRegistration = () => Promise.resolve(undefined);
    assert.equal(await requestServiceWorkerUpdate(none), false, 'page not yet registered');
  });

  it('swallows a failed check (offline, a rejected getRegistration) and answers false', async () => {
    const offline = makeNav({ registration: { update: () => Promise.reject(new Error('offline')) } });
    offline.serviceWorker.getRegistration = () => Promise.resolve(offline._reg);
    assert.equal(await requestServiceWorkerUpdate(offline), false);
    const broken = makeNav({});
    broken.serviceWorker.getRegistration = () => { throw new Error('SecurityError'); };
    assert.equal(await requestServiceWorkerUpdate(broken), false);
  });
});
