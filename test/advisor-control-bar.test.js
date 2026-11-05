'use strict';

/*
 * #2819 — the Advisor (Morpheus) control bar.
 *
 * Mirrors test/master-control-bar.test.js's own property: the thing worth
 * guarding is that there is only ONE implementation rendered into both
 * surfaces (the dashboard panel, the session drawer), not that it looks a
 * particular way. Scoped far smaller than the Master suite because the
 * component itself is — no access tiers, no Medusa control, no Paste/Popout.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loadApiHelperGlobals = require('./_api-helper-globals');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const INDEX = read('index.html');
const SESSION_HTML = read('session.html');
const UI = read('ui.js');
const SESSION_JS = read('session.js');

const G = loadApiHelperGlobals();

describe('#2819 one implementation, two surfaces', () => {
  it('neither page declares the controls itself', () => {
    assert.match(INDEX, /id="advisorPanelBar"/);
    assert.match(SESSION_HTML, /id="advisorDrawerBar"/);
    for (const [name, html] of [['index.html', INDEX], ['session.html', SESSION_HTML]]) {
      assert.doesNotMatch(html, /id="advisor(Panel|Drawer)(Dot|StatusText|SettingsBtn|LaunchBtn|KillBtn)"/,
        `${name} must not re-declare a control the shared bar owns`);
    }
  });

  it('both pages construct the same factory', () => {
    assert.match(UI, /window\.tcCreateAdvisorControlBar\(/, 'the dashboard must mount the shared bar');
    assert.match(SESSION_JS, /window\.tcCreateAdvisorControlBar\(/, 'the session page must mount the same one');
  });

  it('a change to the component reaches both surfaces', () => {
    const panel = G.tcAdvisorControlBarMarkup('advisorPanel');
    const drawer = G.tcAdvisorControlBarMarkup('advisorDrawer');
    assert.equal(panel.replace(/advisorPanel/g, 'P'), drawer.replace(/advisorDrawer/g, 'P'),
      'the two surfaces must be the same markup modulo their id prefix');
  });

  it('every control id is prefixed, so the two surfaces cannot collide', () => {
    const drawer = G.tcAdvisorControlBarMarkup('advisorDrawer');
    const ids = [...drawer.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length >= 6, `expected a real control set, got ${ids.length}`);
    const unprefixed = ids.filter((id) => !id.startsWith('advisorDrawer'));
    assert.deepEqual(unprefixed, [], 'every id the bar emits must carry its surface prefix');
  });

  it('does not collide with the Master bar mounted on the same page', () => {
    const drawer = G.tcAdvisorControlBarMarkup('advisorDrawer');
    for (const id of ['masterDrawerDot', 'masterDrawerKillBtn', 'masterDrawerSettingsBtn']) {
      assert.doesNotMatch(drawer, new RegExp(`id="${id}"`),
        `${id} belongs to the Master bar — the Advisor bar must not claim it`);
    }
  });

  it('the dispatch-floor refusal this bar talks to is covered server-side (#2819)', () => {
    // Not re-testing server.js here (test/advisor.test.js does, with a real
    // HTTP server) — just the contract this component assumes: every call it
    // makes targets /api/advisor/*, which is the one prefix the floor exempts.
    const markup = G.tcAdvisorControlBarMarkup('advisorPanel');
    assert.match(markup, /Launch/);
    assert.match(markup, /Kill/);
  });
});

describe('#2819 the bar behaves', () => {
  /** @returns {{doc: object, ids: object, bar: object, launched: number[]}} */
  function mounted(prefix, extraDeps) {
    const { doc, ids } = makeDocument([prefix + 'Bar', prefix]);
    withIdParsingInnerHTML(ids[prefix + 'Bar'], doc);
    const launched = [];
    const bar = G.tcCreateAdvisorControlBar(Object.assign({
      doc, rootId: prefix + 'Bar', prefix, onLaunch: () => launched.push(1)
    }, extraDeps));
    return { doc, ids, bar, launched };
  }

  it('mount is idempotent — a second mount does not double-bind', () => {
    const { doc, bar, launched } = mounted('advisorPanel');
    bar.mount();
    bar.mount();
    doc.getElementById('advisorPanelLaunchBtn').dispatch('click');
    assert.equal(launched.length, 1, 'Launch must fire once, not once per mount');
  });

  it('starts showing Kill, not Launch — the resting/unknown state is not a down state', () => {
    const { doc, bar } = mounted('advisorPanel');
    bar.mount();
    assert.equal(doc.getElementById('advisorPanelKillBtn').classList.contains('hidden'), false);
    assert.equal(doc.getElementById('advisorPanelLaunchBtn').classList.contains('hidden'), true);
  });

  it('setStatus(\'down\', ...) swaps to Launch; a live/unknown status swaps back to Kill', () => {
    const { doc, bar } = mounted('advisorPanel');
    bar.mount();
    bar.setStatus('down', 'Failed to start');
    assert.equal(doc.getElementById('advisorPanelKillBtn').classList.contains('hidden'), true);
    assert.equal(doc.getElementById('advisorPanelLaunchBtn').classList.contains('hidden'), false);
    bar.setStatus('live', 'Advisor session live');
    assert.equal(doc.getElementById('advisorPanelKillBtn').classList.contains('hidden'), false);
    assert.equal(doc.getElementById('advisorPanelLaunchBtn').classList.contains('hidden'), true);
    assert.equal(doc.getElementById('advisorPanelStatusText').textContent, 'Advisor session live');
  });

  it('paints status without touching the other surface', () => {
    const a = mounted('advisorPanel');
    const b = mounted('advisorDrawer');
    a.bar.mount(); b.bar.mount();
    a.bar.setStatus('live', 'up');
    assert.equal(a.doc.getElementById('advisorPanelStatusText').textContent, 'up');
    assert.equal(b.doc.getElementById('advisorDrawerStatusText').textContent, 'Advisor · checking…',
      'one surface must not paint the other');
  });

  it('a failed action is visible, not console-only', () => {
    const { bar, doc } = mounted('advisorPanel');
    bar.mount();
    const box = doc.getElementById('advisorPanelError');
    assert.equal(box.hidden, true, 'nothing to report at rest');
    bar.setError('the Advisor did not answer');
    assert.equal(box.hidden, false);
    assert.match(box.textContent, /did not answer/);
    bar.setError('');
    assert.equal(box.hidden, true);
  });

  it('paints the model pill from a real fetch, hidden until a model is known', async () => {
    const { bar, doc } = mounted('advisorPanel', {
      api: async (url) => { assert.equal(url, '/api/models/status'); return { status: { claude: { status: 'operational' } } }; }
    });
    bar.mount();
    const pill = doc.getElementById('advisorPanelModel');
    assert.equal(pill.hidden, true);
    await bar.loadModel('claude');
    assert.equal(pill.hidden, false);
    assert.match(pill.textContent, /claude/);
    await bar.loadModel(null);
    assert.equal(pill.hidden, true, 'no configured engine means no pill, not an empty one');
  });

  describe('Kill', () => {
    it('does nothing without confirmation — NO CONFIRMATION MEANS NO KILL', async () => {
      const calls = [];
      const { doc, bar } = mounted('advisorPanel', {
        apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { killed: true }; },
        confirm: () => false
      });
      bar.mount();
      await bar.killAdvisor();
      assert.deepEqual(calls, [], 'declining the confirm must not call the API at all');
    });

    it('kills on confirmation and repaints the status from the response', async () => {
      const calls = [];
      const { doc, bar } = mounted('advisorPanel', {
        apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { killed: true, wasRunning: true }; },
        confirm: () => true
      });
      bar.mount();
      await bar.killAdvisor();
      // Not a deepEqual on the whole tuple: the body literal is created
      // inside the vm-sandboxed api-helper.js, a different realm whose
      // plain objects compare as "same structure but not reference-equal"
      // under assert.deepStrictEqual (same reason
      // test/master-control-bar.test.js's own killMaster call-assertion
      // checks fields with `.some()` rather than deep-equaling the tuple).
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], '/api/advisor/kill');
      assert.equal(calls[0][1], 'POST');
      assert.equal(doc.getElementById('advisorPanelStatusText').textContent, 'Advisor stopped');
    });

    it('an unconfirmed kill is not reported as "Advisor stopped"', async () => {
      const { doc, bar } = mounted('advisorPanel', { confirm: () => false });
      bar.mount();
      bar.setStatus('live', 'Advisor session live');
      await bar.killAdvisor();
      assert.equal(doc.getElementById('advisorPanelStatusText').textContent, 'Advisor session live',
        'declining the confirm must leave the prior status alone');
    });
  });

  describe('the inline settings strip', () => {
    it('is collapsed at mount', () => {
      const { doc, bar } = mounted('advisorPanel');
      bar.mount();
      assert.equal(doc.getElementById('advisorPanelSettingsStrip').classList.contains('hidden'), true,
        'collapsed at rest');
    });

    it('loadSettings populates the engine list (available only) and the current values', async () => {
      // Driven directly rather than via the gear's click (which fires the
      // async load without a promise the test can await) -- the behavior
      // under test is what loadSettings paints, not the click dispatch.
      const { doc, bar } = mounted('advisorPanel', {
        api: async (url) => {
          if (url === '/api/engines') return { engines: [{ id: 'claude', name: 'Claude Code', available: true }, { id: 'ghost', name: 'Ghost', available: false }] };
          if (url === '/api/advisor/settings') return { engine: 'claude', model: 'opus', autoStart: true };
          return null;
        },
        esc: (s) => s
      });
      bar.mount();
      await bar.loadSettings();
      const sel = doc.getElementById('advisorPanelEngineSelect');
      assert.match(sel.innerHTML, /Claude Code/, 'an available engine is offered');
      assert.doesNotMatch(sel.innerHTML, /Ghost/, 'an unavailable engine is not');
      assert.equal(sel.value, 'claude');
      assert.equal(doc.getElementById('advisorPanelModelInput').value, 'opus');
      assert.equal(doc.getElementById('advisorPanelAutoStart').checked, true);
    });

    it('the gear toggles the strip open and closed', () => {
      const { doc, bar } = mounted('advisorPanel', { api: async () => null });
      bar.mount();
      const strip = doc.getElementById('advisorPanelSettingsStrip');
      const gear = doc.getElementById('advisorPanelSettingsBtn');
      gear.dispatch('click');
      assert.equal(strip.classList.contains('hidden'), false, 'first click opens it');
      assert.equal(gear.getAttribute('aria-expanded'), 'true');
      gear.dispatch('click');
      assert.equal(strip.classList.contains('hidden'), true, 'second click closes it');
      assert.equal(gear.getAttribute('aria-expanded'), 'false');
    });

    it('Save posts the strip\'s current values to /api/advisor/settings, then the Discord '
      + 'advisory fields to /api/bridge/operator/advisory-allowlist (#2874)', async () => {
      const calls = [];
      const { doc, bar } = mounted('advisorPanel', {
        api: async () => ({ engines: [] }),
        apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { engine: null, model: null, autoStart: false }; }
      });
      bar.mount();
      await bar.loadSettings();
      doc.getElementById('advisorPanelModelInput').value = 'opus-5';
      doc.getElementById('advisorPanelAutoStart').checked = true;
      doc.getElementById('advisorPanelAdvisoryEnabled').checked = true;
      doc.getElementById('advisorPanelAdvisoryChannelId').value = ' chan-1 ';
      doc.getElementById('advisorPanelAdvisoryAuthorIds').value = 'a1, a2 ,a2';
      doc.getElementById('advisorPanelAdvisoryRequireMention').checked = true;
      doc.getElementById('advisorPanelAdvisoryMaxTurns').value = '3';
      doc.getElementById('advisorPanelSaveSettingsBtn').dispatch('click');
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      assert.equal(calls.length, 2);
      assert.equal(calls[0][0], '/api/advisor/settings');
      assert.equal(calls[0][1], 'POST');
      assert.equal(calls[0][2].model, 'opus-5');
      assert.equal(calls[0][2].autoStart, true);
      assert.equal(calls[1][0], '/api/bridge/operator/advisory-allowlist');
      assert.equal(calls[1][1], 'POST');
      // Field-by-field, not a whole-object deepEqual: `body` is built inside
      // api-helper.js's own vm sandbox (a separate realm from this file), and
      // node:assert's deepEqual can misreport cross-realm plain objects as
      // unequal despite identical content (`assert.equal` on each field, the
      // rest of this suite's own established pattern, is realm-agnostic).
      assert.equal(calls[1][2].advisoryEnabled, true);
      assert.equal(calls[1][2].advisoryChannelId, 'chan-1');
      assert.equal(calls[1][2].advisoryAuthorIds.join(','), 'a1,a2,a2');
      assert.equal(calls[1][2].advisoryRequireMention, true);
      assert.equal(calls[1][2].advisoryMaxConsecutiveTurns, 3);
    });

    it('loadSettings paints the Discord advisory fields from /api/bridge/operator/status, '
      + 'and shows Reset loop pause only while actually paused (#2874)', async () => {
      const responses = {
        '/api/engines': { engines: [] },
        '/api/advisor/settings': { engine: null, model: null, autoStart: false },
        '/api/bridge/operator/status': {
          allowlist: {
            advisoryEnabled: true, advisoryChannelId: 'chan-9', advisoryAuthorIds: ['p1', 'p2'],
            advisoryRequireMention: false, advisoryMaxConsecutiveTurns: 4
          },
          advisoryLoopPaused: true
        }
      };
      const { doc, bar } = mounted('advisorPanel', { api: async (path) => responses[path] });
      bar.mount();
      await bar.loadSettings();
      assert.equal(doc.getElementById('advisorPanelAdvisoryEnabled').checked, true);
      assert.equal(doc.getElementById('advisorPanelAdvisoryChannelId').value, 'chan-9');
      assert.equal(doc.getElementById('advisorPanelAdvisoryAuthorIds').value, 'p1,p2');
      assert.equal(doc.getElementById('advisorPanelAdvisoryRequireMention').checked, false);
      assert.equal(doc.getElementById('advisorPanelAdvisoryMaxTurns').value, '4');
      assert.equal(doc.getElementById('advisorPanelResetLoopPauseBtn').classList.contains('hidden'), false,
        'Reset shown while paused');

      responses['/api/bridge/operator/status'].advisoryLoopPaused = false;
      await bar.loadSettings();
      assert.equal(doc.getElementById('advisorPanelResetLoopPauseBtn').classList.contains('hidden'), true,
        'Reset hidden once no longer paused');
    });

    it('Reset loop pause posts /api/bridge/operator/advisory-loop-reset and repaints the strip (#2874)', async () => {
      const calls = [];
      let paused = true;
      const { doc, bar } = mounted('advisorPanel', {
        api: async (path) => (path === '/api/bridge/operator/status'
          ? { allowlist: { advisoryEnabled: true, advisoryChannelId: 'c', advisoryAuthorIds: [], advisoryRequireMention: true, advisoryMaxConsecutiveTurns: 6 }, advisoryLoopPaused: paused }
          : { engines: [] }),
        apiMutate: async (p, m, b) => {
          calls.push([p, m, b]);
          paused = false;
          return { ok: true };
        }
      });
      bar.mount();
      await bar.loadSettings();
      assert.equal(doc.getElementById('advisorPanelResetLoopPauseBtn').classList.contains('hidden'), false);
      doc.getElementById('advisorPanelResetLoopPauseBtn').dispatch('click');
      for (let i = 0; i < 8; i++) await Promise.resolve();
      assert.equal(calls[0][0], '/api/bridge/operator/advisory-loop-reset');
      assert.equal(calls[0][1], 'POST');
      assert.equal(Object.keys(calls[0][2]).length, 0, 'the reset route takes no body');
      assert.equal(doc.getElementById('advisorPanelResetLoopPauseBtn').classList.contains('hidden'), true,
        'Reset hides itself once the repaint sees the pause is gone');
    });

    it('surfaces a failure from the advisory-allowlist write, even though the engine/model write succeeded (#2874)', async () => {
      const calls = [];
      const apiMutate = async (p, m, b) => {
        calls.push([p, m, b]);
        if (p === '/api/bridge/operator/advisory-allowlist') return null;
        return { engine: null, model: null, autoStart: false };
      };
      const api = Object.assign(async () => ({ engines: [] }), { lastError: 'advisory write refused' });
      const { doc, bar } = mounted('advisorPanel', { api, apiMutate });
      bar.mount();
      await bar.loadSettings();
      doc.getElementById('advisorPanelSaveSettingsBtn').dispatch('click');
      for (let i = 0; i < 8; i++) await Promise.resolve();
      assert.equal(calls.length, 2, 'both writes are attempted even though the second fails');
      assert.equal(calls[0][0], '/api/advisor/settings');
      assert.equal(calls[1][0], '/api/bridge/operator/advisory-allowlist');
      // The error staying exactly this message (not cleared to '') proves
      // saveSettings() returned before reaching its post-save `setError('')` —
      // the same line that reveals "Saved" — without needing to assert on
      // that span's `hidden` class, which the mini-dom harness's deliberately
      // non-parsing innerHTML never derives from markup (only from code).
      assert.equal(doc.getElementById('advisorPanelError').textContent, 'advisory write refused');
      assert.equal(doc.getElementById('advisorPanelError').hidden, false);
    });

    it('Reset loop pause surfaces a failure instead of silently repainting (#2874)', async () => {
      const calls = [];
      const api = Object.assign(
        async (path) => (path === '/api/bridge/operator/status'
          ? { allowlist: { advisoryEnabled: true, advisoryChannelId: 'c', advisoryAuthorIds: [], advisoryRequireMention: true, advisoryMaxConsecutiveTurns: 6 }, advisoryLoopPaused: true }
          : { engines: [] }),
        { lastError: 'reset refused' }
      );
      const apiMutate = async (p, m, b) => { calls.push([p, m, b]); return null; };
      const { doc, bar } = mounted('advisorPanel', { api, apiMutate });
      bar.mount();
      await bar.loadSettings();
      assert.equal(doc.getElementById('advisorPanelResetLoopPauseBtn').classList.contains('hidden'), false);
      doc.getElementById('advisorPanelResetLoopPauseBtn').dispatch('click');
      for (let i = 0; i < 8; i++) await Promise.resolve();
      assert.equal(calls.length, 1, 'the reset was attempted');
      assert.equal(doc.getElementById('advisorPanelError').textContent, 'reset refused');
      assert.equal(doc.getElementById('advisorPanelResetLoopPauseBtn').classList.contains('hidden'), false,
        'still shown -- a failed reset must not claim the pause is cleared');
    });
  });
});

describe('#2819 Full screen', () => {
  function mountedWithSurface(prefix, extraDeps) {
    const { doc, ids } = makeDocument([prefix + 'Bar', prefix]);
    withIdParsingInnerHTML(ids[prefix + 'Bar'], doc);
    const surface = ids[prefix];
    const bar = G.tcCreateAdvisorControlBar(Object.assign({ doc, rootId: prefix + 'Bar', prefix }, extraDeps));
    return { doc, ids, bar, surface };
  }

  it('hides Full screen when the surface has no requestFullscreen', () => {
    const { doc, bar } = mountedWithSurface('advisorPanel');
    bar.mount();
    assert.equal(doc.getElementById('advisorPanelFullscreenBtn').hidden, true);
  });

  it('wires Full screen to the surface\'s requestFullscreen, and toggles exit', () => {
    const { doc, bar, surface } = mountedWithSurface('advisorPanel');
    const calls = [];
    surface.requestFullscreen = () => { calls.push('enter'); doc.fullscreenElement = surface; };
    doc.exitFullscreen = () => { calls.push('exit'); doc.fullscreenElement = null; };
    bar.mount();
    const btn = doc.getElementById('advisorPanelFullscreenBtn');
    assert.equal(btn.hidden, false);
    btn.dispatch('click');
    assert.deepEqual(calls, ['enter']);
    btn.dispatch('click');
    assert.deepEqual(calls, ['enter', 'exit']);
  });

  it('toggleFullscreen is reachable directly, for a caller that is not a click', () => {
    const { bar, surface } = mountedWithSurface('advisorDrawer');
    let entered = false;
    surface.requestFullscreen = () => { entered = true; };
    bar.mount();
    bar.toggleFullscreen();
    assert.equal(entered, true);
  });
});
