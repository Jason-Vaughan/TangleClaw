'use strict';

/*
 * #931 — the update beacon's behavior, run rather than read.
 *
 * The whole point of the beacon is that the toast can fade WITHOUT the
 * operator losing the fact that an update exists: the dot is what carries it.
 * That is a claim about what happens after a timer fires, so these tests fire
 * the timers by hand — the sandbox records `(fn, ms)` instead of scheduling —
 * and then assert on the resulting DOM.
 *
 * Everything here runs the REAL `public/update-beacon.js` through the REAL
 * `tcCreateApi`/`tcCreateApiMutate` chain with `fetch` returning the shapes the
 * routes actually produce. A source-pin test would have proved this file's
 * branches EXIST; #928 R-1 is the standing reminder that existing and
 * reachable are different claims.
 *
 * Each guard names THE MUTATION THIS CATCHES — the change that must drive it
 * red, applied and watched go red while writing it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const PUB = path.join(__dirname, '..', 'public');
const BEACON_SRC = fs.readFileSync(path.join(PUB, 'update-beacon.js'), 'utf8');
const API_HELPER_SRC = fs.readFileSync(path.join(PUB, 'api-helper.js'), 'utf8');

const AVAILABLE = {
  updateAvailable: true,
  currentVersion: '5.1.0',
  latestVersion: '5.1.2',
  checkedAt: '2026-08-15T10:00:00.000Z',
  releaseUrl: 'https://github.com/Jason-Vaughan/TangleClaw/releases/tag/v5.1.2'
};

/** A JSON Response the route would produce. */
function jsonRes(status, body) {
  return new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Build a sandbox with the real beacon wired to a mini-DOM.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - `(callNumber, url, init) => Response`.
 * @param {boolean[]} [opts.confirmAnswers] - Scripted dialog answers.
 * @param {{label: string}} [opts.secondary] - A secondary action to offer.
 * @returns {object} The vm context, with test handles attached.
 */
function loadBeacon(opts = {}) {
  const { doc, ids } = makeDocument(['updateBeacon']);
  const calls = {
    confirms: [], alerts: [], fetches: [], timers: [], intervals: [],
    reloads: 0, secondaryRuns: [], warns: []
  };
  const confirmAnswers = opts.confirmAnswers || [true, true, true];
  const fetchImpl = opts.fetchImpl || (() => jsonRes(200, { ok: true }));

  const sandbox = {
    console: { ...console, warn: (...a) => { calls.warns.push(a.join(' ')); } },
    Response,
    Headers,
    document: doc,
    // Timers are RECORDED, not scheduled: the assertions are about what a
    // callback does when it runs, and a test that slept 3.45s for that answer
    // would be both slow and unable to inspect the callback at all.
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
    clearTimeout: (h) => { if (calls.timers[h - 1]) calls.timers[h - 1].cleared = true; },
    setInterval: (fn, ms) => { calls.intervals.push({ fn, ms }); return calls.intervals.length; },
    clearInterval: (h) => { if (calls.intervals[h - 1]) calls.intervals[h - 1].cleared = true; },
    location: { reload: () => { calls.reloads++; } },
    fetch: async (url, init) => {
      calls.fetches.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return fetchImpl(calls.fetches.length, url, init);
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
  vm.runInContext(BEACON_SRC, sandbox);

  sandbox.inFlight = false;
  vm.runInContext(`
    const api = tcCreateApi({});
    const apiMutate = tcCreateApiMutate(api);
    const restart = tcCreateRestartFlow({ api, apiMutate, win: window });
    globalThis.api = api;
    globalThis.beacon = tcCreateUpdateBeacon({
      doc: document,
      anchorId: 'updateBeacon',
      api, apiMutate, restart,
      getInFlight: () => window.inFlight,
      setInFlight: (v) => { window.inFlight = v; }${opts.secondary ? `,
      secondaryAction: {
        label: ${JSON.stringify(opts.secondary.label)},
        run: (data) => window.__secondary(data)
      }` : ''}
    });
  `, sandbox);

  sandbox.__secondary = (data) => { calls.secondaryRuns.push(data); };
  sandbox.calls = calls;
  sandbox.anchor = ids.updateBeacon;
  /** @returns {object|null} The toast element, if one is on screen. */
  sandbox.toast = () => ids.updateBeacon.querySelector('.beacon-toast');
  /** @returns {object|null} The dot element, if one is on screen. */
  sandbox.dot = () => ids.updateBeacon.querySelector('.beacon-dot');
  /** Fire every pending, uncleared timer callback in scheduled order. */
  sandbox.runTimers = () => {
    for (const t of calls.timers) if (!t.cleared) t.fn();
  };
  return sandbox;
}

describe('#931 the beacon announces an update, and the dot outlives the toast', () => {
  it('pops the toast AND sets the dot in the same render', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);

    assert.ok(ctx.toast(), 'the toast must pop');
    assert.ok(ctx.dot(), 'and the dot must be set at the same moment');
    assert.match(ctx.toast().text, /v5\.1\.2/, 'the toast names the version');
    assert.match(ctx.toast().text, /update available/);
    // THE MUTATION THIS CATCHES: setting the dot only after the fade. The dot
    // would be absent here, and an operator who looked away during the pop
    // would have nothing left to click.
  });

  it('after the fade the toast is gone and the dot is STILL there', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();

    assert.equal(ctx.toast(), null, 'the toast fades away on its own');
    assert.ok(ctx.dot(), 'the dot survives the fade — this is the whole design');
    // THE MUTATION THIS CATCHES: clearing the dot on the fade timer. This is
    // the criterion the beacon turns on: the fade must lose NOTHING, which is
    // what makes an auto-dismissing notice compatible with the no-UI-timers
    // rule (#98/#268) instead of a violation of it.
  });

  it('the fade timer only marks the toast, and the removal timer only removes it', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);

    const [fade, remove] = ctx.calls.timers;
    assert.equal(fade.ms, 3000, 'the pop stays up for three seconds');
    assert.equal(remove.ms, 3450, 'and is removed once its fade has run');

    fade.fn();
    assert.ok(ctx.toast().classList.contains('fading'),
      'the fade timer adds a class and nothing else');
    assert.ok(ctx.dot(), 'and does not touch the dot');
    assert.equal(ctx.calls.fetches.length, 0, 'no timer performs an action');
    assert.equal(ctx.calls.confirms.length, 0, 'no timer opens a dialog');
    assert.equal(ctx.calls.reloads, 0, 'no timer navigates');

    remove.fn();
    assert.equal(ctx.toast(), null);
    assert.ok(ctx.dot(), 'still not the dot');
    // THE MUTATION THIS CATCHES: giving a timer any other job — an apply call,
    // a location change, a dot removal. The no-UI-timers rule bans timer-driven
    // LIFECYCLE; this is the mechanical boundary that keeps the fade inside it.
  });
});

describe('#931 the dot re-opens what the fade took away', () => {
  it('clicking the dot brings the toast back, with a ✕ the first pop did not have', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    assert.equal(ctx.toast().querySelector('.beacon-toast-close'), null,
      'the first pop is single-action — it goes away by itself');
    ctx.runTimers();

    ctx.dot().dispatch('click');
    const reopened = ctx.toast();
    assert.ok(reopened, 'the dot re-opens the toast');
    assert.ok(reopened.querySelector('.beacon-toast-close'),
      'a toast that will NOT fade must be dismissible by hand');
    // THE MUTATION THIS CATCHES: rendering the same toast both times. Either
    // the first pop grows a ✕ nobody needs, or the re-opened one has no way to
    // be closed and sits on the logo for the life of the page.
  });

  it('the re-opened toast does not schedule a fade', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    const scheduledAfterPop = ctx.calls.timers.length;

    ctx.dot().dispatch('click');
    assert.equal(ctx.calls.timers.length, scheduledAfterPop,
      'a toast the operator opened deliberately waits for them, not a clock');
    // THE MUTATION THIS CATCHES: scheduling the fade timers unconditionally in
    // showToast — the notice the operator just asked to see vanishes under them.
  });

  it('a second click closes it again', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    ctx.dot().dispatch('click');
    ctx.dot().dispatch('click');
    assert.equal(ctx.toast(), null, 'the dot toggles');
    assert.ok(ctx.dot(), 'and closing the toast never clears the dot');
  });

  it('the ✕ closes the toast and leaves the dot', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    ctx.dot().dispatch('click');
    ctx.toast().querySelector('.beacon-toast-close').dispatch('click');

    assert.equal(ctx.toast(), null);
    assert.ok(ctx.dot(), 'dismissing the notice is not dismissing the update');
    // THE MUTATION THIS CATCHES: making ✕ clear the dot — which is the pill's
    // per-version dismiss coming back, and with it the invisibility (#931's
    // premise) that a dismissible update surface creates.
  });
});

describe('#931 the beacon speaks once per version, not once per poll', () => {
  it('re-rendering the same version does not re-pop', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    ctx.beacon.render(AVAILABLE);

    assert.equal(ctx.toast(), null, 'the 60s poll must not re-pop what it already said');
    assert.ok(ctx.dot(), 'the dot is the resting state');
    // THE MUTATION THIS CATCHES: dropping the seen-version guard. The dashboard
    // polls every 60 seconds, so the toast would re-pop every minute forever.
  });

  it('a NEW version pops again', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    ctx.beacon.render({ ...AVAILABLE, latestVersion: '5.2.0' });

    assert.ok(ctx.toast(), 'a release that did not exist last poll is news');
    assert.match(ctx.toast().text, /v5\.2\.0/);
    // THE MUTATION THIS CATCHES: latching "already popped" as a boolean rather
    // than per version — the second release would arrive in silence.
  });
});

describe('#931 the beacon distinguishes "no update" from "no answer" (#716)', () => {
  it('an older server\'s cached "no update" — no checkOk at all — leaves a live beacon alone (#1061)', () => {
    // A payload with no `checkOk` came from a server that predates the field:
    // its cache holds an answer of unknown quality. That is not a measured
    // "no update", so it must not take down a dot for an update that may well
    // still be there — the shared `tcUpdateAnswerState` calls it
    // `cached-unverified`, and every consumer reads that one ladder.
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    ctx.beacon.render({ updateAvailable: false, checkedAt: '2026-08-15T11:00:00.000Z' });

    assert.ok(ctx.dot(), 'an unverifiable cached answer is not a fact; the dot stays');
    const classified = ctx.tcUpdateAnswerState({ updateAvailable: false, checkedAt: '2026-08-15T11:00:00.000Z' });
    assert.equal(classified.state, 'cached-unverified');
    assert.equal(classified.cached, true);
  });

  it('a payload with no checkedAt leaves a live beacon alone', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    ctx.beacon.render({ updateAvailable: false, checkedAt: null });

    assert.ok(ctx.dot(), 'an unmeasured check is not an answer');
    // THE MUTATION THIS CATCHES: treating a null-checkedAt payload as "no
    // update". `startChecker` reports exactly that for the first 60 seconds
    // after a restart — which is precisely when the restart-triggered re-check
    // lands — so the dot for a genuinely available update would vanish.
  });

  it('a check that RAN and could not measure leaves the dot alone (Critic R-1)', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    // The exact payload `lib/update-checker.js#_buildStatus` returns when the
    // measurement fails: a real `checkedAt`, `updateAvailable: false`, and
    // `checkOk: false`. An offline box, a missing git, a 15s timeout.
    ctx.beacon.render({
      updateAvailable: false,
      currentVersion: '5.1.0',
      latestVersion: null,
      checkedAt: '2026-08-15T12:00:00.000Z',
      checkOk: false
    });

    assert.ok(ctx.dot(), 'a failed check is not "you are up to date"');
    // THE MUTATION THIS CATCHES: discriminating on `checkedAt` alone, which is
    // what shipped. The failure carries a timestamp, so it took the
    // measured-no-update branch and cleared the dot for an update that was
    // genuinely available — reachable from the periodic checker's cached failure
    // on every later GET, including the session page's one-shot read at load.
  });

  it('a null payload (the request failed) leaves it alone too', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    ctx.beacon.render(null);

    assert.ok(ctx.dot(), 'a server that did not answer has not said "you are current"');
  });

  it('a measured "no update" clears the dot', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    // `checkOk: true` because that is what the producer sends for a measured
    // "no update" — `lib/update-checker.js` stamps `checkOk` on every payload.
    ctx.beacon.render({ updateAvailable: false, checkOk: true, checkedAt: '2026-08-15T11:00:00.000Z' });

    assert.equal(ctx.dot(), null, 'the update was applied — stop announcing it');
    assert.equal(ctx.toast(), null);
    // THE MUTATION THIS CATCHES: returning early on any falsy `updateAvailable`
    // without clearing. The beacon would keep offering an update that is
    // already installed, which is the state this render most often re-runs into.
  });

  it('clicking a cleared dot is impossible, and reopen alone renders nothing', () => {
    const ctx = loadBeacon();
    ctx.beacon.render({ updateAvailable: false, checkedAt: '2026-08-15T11:00:00.000Z' });
    ctx.beacon.reopen();
    assert.equal(ctx.toast(), null, 'nothing to re-open when nothing is announced');
  });
});

describe('#931 "Update now" runs the guarded apply flow, through the real api chain', () => {
  it('confirms, then POSTs apply and restart in that order', async () => {
    const ctx = loadBeacon({
      fetchImpl: (n) => {
        if (n === 1) return jsonRes(200, { ok: true, toRef: 'v5.1.2' });
        if (n === 2) return jsonRes(200, { startedAt: 'old' });
        return jsonRes(200, { ok: true });
      }
    });
    ctx.beacon.render(AVAILABLE);
    await ctx.beacon.apply(AVAILABLE);

    assert.equal(ctx.calls.confirms.length, 1, 'a restart is never unconfirmed');
    assert.match(ctx.calls.confirms[0], /v5\.1\.2/, 'the confirm names the target version');
    assert.deepEqual(ctx.calls.fetches.map((f) => f.url),
      ['/api/update/apply', '/api/server-info', '/api/server/restart'],
      'apply, baseline, restart — the #229 sequence');
    // THE MUTATION THIS CATCHES: any reordering or omission in the moved flow —
    // most damagingly, restarting before capturing the startedAt baseline,
    // which is what makes the poll able to tell "back up" from "still dying".
  });

  it('declining the confirm touches nothing', async () => {
    const ctx = loadBeacon({ confirmAnswers: [false] });
    ctx.beacon.render(AVAILABLE);
    await ctx.beacon.apply(AVAILABLE);

    assert.equal(ctx.calls.fetches.length, 0, 'no request leaves the page');
    assert.equal(ctx.inFlight, false, 'and the latch is not left held');
  });

  it('the toast button is what starts it', async () => {
    const ctx = loadBeacon({
      confirmAnswers: [false],
      fetchImpl: () => jsonRes(200, { ok: true })
    });
    ctx.beacon.render(AVAILABLE);
    const fired = ctx.toast().querySelector('.beacon-toast-apply').dispatch('click');

    assert.ok(fired, 'the button has a handler');
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.calls.confirms.length, 1, 'clicking it reaches the apply flow');
    // THE MUTATION THIS CATCHES: rendering the button without wiring it — the
    // beacon would look complete and do nothing, which is the failure mode the
    // session badge's un-actionable subtlety already taught (#931's premise).
  });

  it('accepting the update stops the fade — the toast is now the progress surface', async () => {
    const ctx = loadBeacon({
      fetchImpl: (n) => (n === 1
        ? jsonRes(200, { ok: true, toRef: 'v5.1.2' })
        : jsonRes(500, { ok: false, error: 'no restart mechanism' }))
    });
    ctx.beacon.render(AVAILABLE);
    ctx.toast().querySelector('.beacon-toast-apply').dispatch('click');
    await new Promise((r) => setImmediate(r));

    ctx.runTimers();
    assert.ok(ctx.toast(), 'the toast must survive its own fade once an update is running');
    assert.equal(ctx.toast().querySelector('.beacon-toast-apply').textContent, 'Update now',
      'and still be the control that reports the outcome');
    // THE MUTATION THIS CATCHES: not cancelling the timers on the accepted
    // path. Three seconds into an update the operator would watch the thing
    // they just pressed vanish, with "Updating…" and every subsequent label
    // written to an element no longer on the page.
  });

  it('DECLINING leaves the fade alone — it has been seen and answered', async () => {
    const ctx = loadBeacon({ confirmAnswers: [false] });
    ctx.beacon.render(AVAILABLE);
    ctx.toast().querySelector('.beacon-toast-apply').dispatch('click');
    await new Promise((r) => setImmediate(r));

    ctx.runTimers();
    assert.equal(ctx.toast(), null, 'a declined notice still goes quiet on its own');
    assert.ok(ctx.dot(), 'and the dot still carries it');
    // THE MUTATION THIS CATCHES: cancelling the timers before the confirm
    // rather than after it — a declined update would pin its toast to the logo
    // for the life of the page.
  });

  it('an update in flight cannot be torn down or re-triggered from the dot (Critic R-15)', async () => {
    let release;
    const ctx = loadBeacon({
      fetchImpl: (n) => (n === 1
        // Hold the apply open so the assertions run mid-flight, which is the
        // only window this failure exists in.
        ? new Promise((r) => { release = () => r(jsonRes(200, { ok: true, toRef: 'v5.1.2' })); })
        : jsonRes(200, { startedAt: 'old' }))
    });
    ctx.beacon.render(AVAILABLE);
    ctx.toast().querySelector('.beacon-toast-apply').dispatch('click');
    await new Promise((r) => setImmediate(r));

    assert.equal(ctx.inFlight, true, 'precondition: the apply is running');
    ctx.dot().dispatch('click');
    assert.ok(ctx.toast(), 'the dot must not tear down the only progress surface');

    ctx.toast().remove();
    ctx.beacon.reopen();
    const btn = ctx.toast().querySelector('.beacon-toast-apply');
    assert.equal(btn.disabled, true, 'and a re-opened toast must not offer an enabled control');
    assert.equal(btn.textContent, 'Updating…', 'it reports the state instead');
    release();
    // THE MUTATION THIS CATCHES: rendering the apply button as a constant
    // 'Update now'/enabled, or letting reopen() hide a toast mid-apply. Both
    // let the operator reach a control whose handler returns silently on the
    // in-flight guard — no alert, no label change, nothing to distinguish a
    // running update from a dead one.
  });

  it('an in-flight restart refuses a second apply', async () => {
    const ctx = loadBeacon();
    ctx.inFlight = true;
    await ctx.beacon.apply(AVAILABLE);
    assert.equal(ctx.calls.confirms.length, 0, 'the shared latch still serializes');
    // THE MUTATION THIS CATCHES: owning a latch inside the beacon instead of
    // reading the page's. On the dashboard the #235 stale-server restart holds
    // that same flag, and an internal latch would let both fire at once.
  });

  it('a refused guard surfaces the server\'s own reason', async () => {
    const ctx = loadBeacon({
      fetchImpl: () => jsonRes(409, { ok: false, code: 'no-update', error: 'already at v5.1.2' })
    });
    await ctx.beacon.apply(AVAILABLE);

    assert.match(ctx.calls.alerts.join('\n'), /already at v5\.1\.2/,
      'the refusal is reported verbatim, not as "check the logs"');
    assert.equal(ctx.inFlight, false, 'and the latch is released');
  });

  it('an applied update whose restart has no mechanism says so honestly', async () => {
    const ctx = loadBeacon({
      fetchImpl: (n) => {
        if (n === 1) return jsonRes(200, { ok: true, toRef: 'v5.1.2' });
        if (n === 2) return jsonRes(200, { startedAt: 'old' });
        return jsonRes(500, { ok: false, error: 'no restart mechanism' });
      }
    });
    await ctx.beacon.apply(AVAILABLE);

    assert.match(ctx.calls.alerts.join('\n'), /on disk, but auto-restart didn't run/,
      'the code IS updated — saying "update failed" here would be a lie');
  });

  it('names the deploy assets it cannot provision, BEFORE the restart', async () => {
    const ctx = loadBeacon({
      fetchImpl: (n) => {
        if (n === 1) {
          return jsonRes(200, {
            ok: true,
            toRef: 'v5.1.2',
            provisioning: { action: 'manual', assetsChanged: ['deploy/install.sh'], manifestChanged: true }
          });
        }
        if (n === 2) return jsonRes(200, { startedAt: 'old' });
        return jsonRes(200, { ok: true });
      }
    });
    await ctx.beacon.apply(AVAILABLE);

    const notice = ctx.calls.alerts.join('\n');
    assert.match(notice, /deploy\/install\.sh/, 'the changed asset is named');
    assert.match(notice, /does not run npm for you/, 'and the manifest is reported, not executed');
    const restartIdx = ctx.calls.fetches.findIndex((f) => f.url === '/api/server/restart');
    assert.ok(restartIdx !== -1, 'the restart still happens');
    // THE MUTATION THIS CATCHES: moving the provisioning notice after the
    // restart — the page reloads, and nobody is watching to read it (#711).
  });
});

describe('#931 the dirty-tree escape survived the move (#711 / #928 R-1)', () => {
  const DIRTY_ALL_TC = {
    ok: false,
    code: 'dirty-tree',
    error: 'local changes present — all of them TangleClaw-written',
    dirty: { discardable: ['.tangleclaw/', '.claude/settings.json'], realWork: [] }
  };
  const DIRTY_MIXED = {
    ok: false,
    code: 'dirty-tree',
    error: 'local changes present — commit or stash before updating',
    dirty: { discardable: ['.tangleclaw/'], realWork: ['lib/projects.js'] }
  };

  it('an all-TC 409 offers the discard confirm and re-applies with the opt-in', async () => {
    const ctx = loadBeacon({
      fetchImpl: (n) => (n === 1
        ? jsonRes(409, DIRTY_ALL_TC)
        : jsonRes(409, { ok: false, code: 'no-update', error: 'raced' }))
    });
    await ctx.beacon.apply(AVAILABLE);

    assert.equal(ctx.calls.confirms.length, 2, 'the update confirm, then the discard confirm');
    assert.match(ctx.calls.confirms[1], /\.tangleclaw\//, 'the confirm NAMES the files');
    assert.deepEqual(ctx.calls.fetches[1].body, { discardDirty: true },
      'the re-apply carries the explicit opt-in and nothing else');
    // THE MUTATION THIS CATCHES: reading `applyResp.dirty` instead of
    // `api.lastBody`. `api()` returns null for a 409, so that branch is dead
    // code that a source-pin test cannot tell from a live one (#928 R-1).
  });

  it('a mixed 409 names the blocking files and never offers the discard', async () => {
    const ctx = loadBeacon({ fetchImpl: () => jsonRes(409, DIRTY_MIXED) });
    await ctx.beacon.apply(AVAILABLE);

    assert.equal(ctx.calls.confirms.length, 1, 'no discard offer when real work is in the way');
    assert.equal(ctx.calls.fetches.length, 1, 'and no second apply');
    const refusal = ctx.calls.alerts.join('\n');
    assert.match(refusal, /lib\/projects\.js/, 'the blocking file is named');
    assert.match(refusal, /\.tangleclaw\//, 'and the TC files waiting behind it are shown');
  });

  it('declining the discard applies nothing further and releases the latch', async () => {
    const ctx = loadBeacon({
      confirmAnswers: [true, false],
      fetchImpl: () => jsonRes(409, DIRTY_ALL_TC)
    });
    await ctx.beacon.apply(AVAILABLE);

    assert.equal(ctx.calls.fetches.length, 1, 'a declined confirm must not re-apply');
    assert.equal(ctx.inFlight, false, 'the flow releases the in-flight latch');
  });
});

describe('#931 the secondary action belongs to the re-opened toast only', () => {
  it('is absent from the first pop and present after a re-open', () => {
    const ctx = loadBeacon({ secondary: { label: 'Ask the agent' } });
    ctx.beacon.render(AVAILABLE);

    assert.equal(ctx.toast().querySelector('.beacon-toast-secondary'), null,
      'the pop stays single-action — the badge it replaces fired agent '
      + 'instructions on one mis-tappable chip (#730)');
    ctx.runTimers();
    ctx.dot().dispatch('click');
    assert.ok(ctx.toast().querySelector('.beacon-toast-secondary'),
      'a deliberately opened toast can offer the second path');
    // THE MUTATION THIS CATCHES: rendering the secondary unconditionally,
    // which puts an agent-instruction trigger under a toast that appears
    // unbidden and is gone in three seconds.
  });

  it('the secondary runs its own action, and does NOT start the update', async () => {
    const ctx = loadBeacon({ secondary: { label: 'Ask the agent' } });
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    ctx.dot().dispatch('click');
    ctx.toast().querySelector('.beacon-toast-secondary').dispatch('click');

    assert.equal(ctx.calls.secondaryRuns.length, 1, 'the secondary handler ran');
    assert.equal(ctx.calls.secondaryRuns[0].latestVersion, '5.1.2', 'with the payload');
    assert.equal(ctx.calls.confirms.length, 0, 'and did not open the update confirm');
    // THE MUTATION THIS CATCHES: swapping the two handlers — asking the agent
    // would restart the server, and "Update now" would type at a terminal.
  });

  it('a page that offers no secondary never renders one', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    ctx.runTimers();
    ctx.dot().dispatch('click');
    assert.equal(ctx.toast().querySelector('.beacon-toast-secondary'), null);
  });
});

describe('#931 the beacon is reachable and readable without a mouse', () => {
  it('the dot is a real button that names the version it stands for', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    const dot = ctx.dot();

    assert.equal(dot.tagName, 'BUTTON', 'once the toast fades, this is the only control left');
    assert.equal(dot.type, 'button', 'never a form submit');
    assert.match(dot.getAttribute('aria-label'), /5\.1\.2/,
      'a bare red dot announces nothing to a screen reader');
    // THE MUTATION THIS CATCHES: rendering the dot as a styled <span>, which is
    // exactly what made the badge it replaces unreachable by keyboard.
  });

  it('the toast is a polite live region, not an assertive one', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    assert.equal(ctx.toast().getAttribute('role'), 'status',
      'an available update is information; interrupting to say so is not warranted');
  });
});

describe('#931 the release link degrades rather than trusting the wire', () => {
  it('links the version when the server supplies an http(s) release URL (#149)', () => {
    const ctx = loadBeacon();
    ctx.beacon.render(AVAILABLE);
    const link = ctx.toast().querySelector('A');

    assert.ok(link, 'release notes stay one tap away');
    assert.equal(link.href, AVAILABLE.releaseUrl);
    assert.equal(link.rel, 'noopener noreferrer', 'a new tab never gets an opener handle');
  });

  it('falls back to plain text with no release URL (a non-GitHub remote)', () => {
    const ctx = loadBeacon();
    ctx.beacon.render({ ...AVAILABLE, releaseUrl: null });

    assert.equal(ctx.toast().querySelector('A'), null);
    assert.match(ctx.toast().text, /v5\.1\.2 or newer — update available/,
      'the notice itself must still be complete');
  });

  it('refuses a non-http scheme instead of rendering it as a link', () => {
    const ctx = loadBeacon();
    // eslint-disable-next-line no-script-url
    ctx.beacon.render({ ...AVAILABLE, releaseUrl: 'javascript:alert(1)' });

    assert.equal(ctx.toast().querySelector('A'), null,
      'the pill escaped this value as markup and then put it in an href anyway');
    assert.match(ctx.toast().text, /v5\.1\.2/, 'and the version still renders');
    // THE MUTATION THIS CATCHES: dropping the scheme test and linking whatever
    // arrives. Escaping constrains markup, not schemes.
  });
});

describe('#931 the beacon does not assume its anchor exists', () => {
  it('renders nothing, and throws nothing, when the page has no anchor', () => {
    const ctx = loadBeacon();
    vm.runInContext(`
      globalThis.orphan = tcCreateUpdateBeacon({
        doc: document, anchorId: 'noSuchAnchor',
        api, apiMutate: tcCreateApiMutate(api),
        restart: tcCreateRestartFlow({ api, apiMutate: tcCreateApiMutate(api), win: window }),
        getInFlight: () => false, setInFlight: () => {}
      });
    `, ctx);
    assert.doesNotThrow(() => { ctx.orphan.render(AVAILABLE); });
    assert.doesNotThrow(() => { ctx.orphan.reopen(); });
    // THE MUTATION THIS CATCHES: capturing the anchor at construction and
    // dereferencing it unguarded. Every page script here runs before its own
    // markup is guaranteed present, and a throw at this point takes the rest
    // of the page's wiring down with it.
  });

  it('refuses to be built without the page\'s restart latch', () => {
    const ctx = loadBeacon();
    for (const missing of ['getInFlight', 'setInFlight']) {
      assert.throws(() => vm.runInContext(`
        tcCreateUpdateBeacon({
          doc: document, anchorId: 'updateBeacon',
          api, apiMutate: tcCreateApiMutate(api),
          restart: tcCreateRestartFlow({ api, apiMutate: tcCreateApiMutate(api), win: window }),
          ${missing === 'getInFlight' ? '' : 'getInFlight: () => false,'}
          ${missing === 'setInFlight' ? '' : 'setInFlight: () => {},'}
        });
      `, ctx), /getInFlight and setInFlight are required/, `missing ${missing} must throw`);
    }
    // THE MUTATION THIS CATCHES: restoring the no-op defaults, or moving the
    // check out of the factory. Without it the failure lands at the first
    // render instead — the moment an update appears, which is the worst time
    // to discover a page wired its own latch away and the hardest to reproduce.
  });

  it('but it SAYS SO — once — instead of failing silently (Critic R-16)', () => {
    const ctx = loadBeacon();
    vm.runInContext(`
      globalThis.orphan2 = tcCreateUpdateBeacon({
        doc: document, anchorId: 'noSuchAnchor',
        api, apiMutate: tcCreateApiMutate(api),
        restart: tcCreateRestartFlow({ api, apiMutate: tcCreateApiMutate(api), win: window }),
        getInFlight: () => false, setInFlight: () => {}
      });
    `, ctx);
    ctx.orphan2.render(AVAILABLE);
    assert.equal(ctx.calls.warns.length, 1, 'a beacon with nowhere to render must say so');
    assert.match(ctx.calls.warns[0], /noSuchAnchor/, 'and name what it looked for');

    ctx.orphan2.render(AVAILABLE);
    ctx.orphan2.render({ ...AVAILABLE, latestVersion: '5.3.0' });
    assert.equal(ctx.calls.warns.length, 1,
      'once, not once per poll — render runs every five minutes on the dashboard');
    // THE MUTATION THIS CATCHES: dropping the warning (the failure mode is a
    // beacon that renders nothing forever with nothing in the console — the
    // invisible update surface #931 exists to remove, reached by a new door),
    // or dropping the latch that keeps it to one line.
  });
});

describe('#994 the beacon never promises a version the applier did not commit to', () => {
  // The applier resolves its target live (`git ls-remote`, newest tag wins),
  // so the polled `latestVersion` is a floor, not the number that will be
  // installed. Observed 2026-08-19: 5.9.0 offered, 5.10.0 published ten
  // minutes later, a click would have installed 5.10.0 under a 5.9.0 badge.
  it('toast, dot and confirm all say "or newer"', async () => {
    const ctx = loadBeacon({ confirmAnswers: [false] });
    ctx.beacon.render(AVAILABLE);

    assert.match(ctx.toast().text, /v5\.1\.2 or newer/, 'the toast offers a floor, not a promise');
    assert.match(ctx.dot().title, /v5\.1\.2 or newer available/);
    assert.match(ctx.dot().getAttribute('aria-label'), /v5\.1\.2 or newer/);
    await ctx.beacon.apply(AVAILABLE);
    assert.match(ctx.calls.confirms[0], /v5\.1\.2 or newer and restart\?/,
      'the confirm is the last word before the checkout moves; it must not name a bare version');
  });

  it('the after-the-fact message names what the applier checked out, not what was polled', async () => {
    const ctx = loadBeacon({
      fetchImpl: (n) => (n === 1
        ? jsonRes(200, { ok: true, toRef: 'v5.1.3' })
        : jsonRes(500, { ok: false, error: 'no restart mechanism' }))
    });
    ctx.beacon.render(AVAILABLE);
    await ctx.beacon.apply(AVAILABLE);

    const alerts = ctx.calls.alerts.join('\n');
    assert.match(alerts, /Updated to v5\.1\.3 on disk/, 'the real checkout, from the applier');
    assert.doesNotMatch(alerts, /v5\.1\.2/, 'the polled number is never reported as installed');
  });

  it('with no toRef from the applier it says "the newest release" rather than inventing a number', async () => {
    const ctx = loadBeacon({
      fetchImpl: (n) => (n === 1
        ? jsonRes(200, { ok: true })
        : jsonRes(500, { ok: false, error: 'no restart mechanism' }))
    });
    ctx.beacon.render(AVAILABLE);
    await ctx.beacon.apply(AVAILABLE);

    const alerts = ctx.calls.alerts.join('\n');
    assert.match(alerts, /Updated to the newest release on disk/);
    assert.doesNotMatch(alerts, /v5\.1\.2/);
  });

  it('no beacon copy renders the polled version as a bare install target', () => {
    // Every site that interpolates `latestVersion` into operator-facing copy
    // qualifies it — the family, not one call site. A new site that forgets
    // "or newer" reintroduces the promise.
    const lines = BEACON_SRC.split('\n');
    const sites = lines.map((l, i) => (l.includes('${data.latestVersion}') ? i : -1)).filter((i) => i >= 0);
    assert.ok(sites.length >= 4, `expected the toast, dot title, dot label and confirm; found ${sites.length}`);
    for (const i of sites) {
      // The toast composes the version (a link when there is a release URL,
      // text otherwise) and its qualifier as two spans, so the qualifier sits
      // up to a link-branch below the interpolation.
      const window = lines.slice(i, i + 12).join('\n');
      assert.match(window, /or newer/, `unqualified version in beacon copy: ${lines[i].trim()}`);
    }
  });
});
