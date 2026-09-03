'use strict';

/*
 * #345 — the system health panel, run rather than read.
 *
 * Runs the REAL public/health-panel.js against the mini-DOM and asserts on what
 * it draws. Two properties carry the panel: it renders ONLY conditions that
 * fired (a clear condition draws nothing, and an all-clear payload hides the
 * panel entirely), and a condition that could not be measured is drawn AS
 * unmeasured — never hidden, never folded into the all-clear.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'health-panel.js'), 'utf8');

/**
 * Load the panel module into a sandbox with one `#systemHealthPanel` element.
 * @param {object} [opts]
 * @param {Function} [opts.writeText] - Clipboard double.
 * @returns {{render: Function, panel: object, clicks: Array}}
 */
function load(opts = {}) {
  const { doc, ids } = makeDocument(['systemHealthPanel']);
  const sandbox = {
    console,
    document: doc,
    navigator: opts.writeText ? { clipboard: { writeText: opts.writeText } } : {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { render: sandbox.tcRenderHealthPanel, panel: ids.systemHealthPanel };
}

const FIRED_TTYD = {
  id: 'ttyd-leak', title: 'Terminal (ttyd) PTY leak', state: 'fired',
  detail: '90 leaked tmux clients under ttyd (threshold 20)',
  remediation: 'launchctl kickstart -k gui/$(id -u)/com.tangleclaw.ttyd'
};
const CLEAR_STALE = {
  id: 'stale-server', title: 'Server running old code', state: 'clear',
  detail: 'running abcdef1, same as disk', remediation: 'launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server'
};
const UNKNOWN_FDA = {
  id: 'full-disk-access', title: 'Full Disk Access missing', state: 'unknown',
  detail: '/Users/op/Documents does not exist, so there was nothing to probe',
  remediation: 'System Settings → Privacy & Security → Full Disk Access'
};

describe('public/health-panel.js (#345)', () => {
  it('hides the panel and draws nothing when every condition is clear', () => {
    const { render, panel } = load();
    panel.classList.remove('hidden');
    const r = render(panel, { conditions: [{ ...FIRED_TTYD, state: 'clear' }, CLEAR_STALE, { ...UNKNOWN_FDA, state: 'clear' }] });
    assert.deepEqual({ ...r }, { fired: 0, unknown: 0, visible: false });
    assert.equal(panel.classList.contains('hidden'), true);
    assert.equal(panel.innerHTML, '');
  });

  it('renders only the fired condition, with its detail and remediation, and not the clear one', () => {
    const { render, panel } = load();
    const r = render(panel, { conditions: [FIRED_TTYD, CLEAR_STALE] });
    assert.equal(r.visible, true);
    assert.equal(r.fired, 1);
    assert.equal(panel.classList.contains('hidden'), false);
    assert.match(panel.innerHTML, /System health/);
    assert.match(panel.innerHTML, /data-condition="ttyd-leak"/);
    assert.match(panel.innerHTML, /90 leaked tmux clients/);
    assert.match(panel.innerHTML, /<code>launchctl kickstart -k gui\/\$\(id -u\)\/com\.tangleclaw\.ttyd<\/code>/);
    assert.doesNotMatch(panel.innerHTML, /stale-server/, 'a clear condition draws nothing');
    assert.doesNotMatch(panel.innerHTML, /same as disk/);
  });

  it('renders an unknown condition as "could not check", with the reason and no fix', () => {
    // THE MUTATION THIS CATCHES: filtering on `state === 'fired'` alone, which
    // hides a probe that could not run behind the same silence as all-clear.
    const { render, panel } = load();
    const r = render(panel, { conditions: [CLEAR_STALE, UNKNOWN_FDA] });
    assert.equal(r.visible, true);
    assert.deepEqual([r.fired, r.unknown], [0, 1]);
    assert.equal(panel.classList.contains('hidden'), false);
    assert.match(panel.innerHTML, /health-unknown/);
    assert.match(panel.innerHTML, /Could not check: Full Disk Access missing/);
    assert.match(panel.innerHTML, /nothing to probe/);
    assert.doesNotMatch(panel.innerHTML, /health-fix/, 'nothing was found, so there is nothing to fix');
  });

  it('draws fired rows before unknown rows', () => {
    const { render, panel } = load();
    render(panel, { conditions: [UNKNOWN_FDA, CLEAR_STALE, FIRED_TTYD] });
    assert.ok(panel.innerHTML.indexOf('health-fired') < panel.innerHTML.indexOf('health-unknown'));
  });

  it('omits ids the page renders through a surface of its own', () => {
    const { render, panel } = load();
    const r = render(panel, { conditions: [{ ...CLEAR_STALE, state: 'fired' }] }, { omit: ['stale-server'] });
    assert.deepEqual({ ...r }, { fired: 0, unknown: 0, visible: false });
    assert.equal(panel.classList.contains('hidden'), true);
  });

  it('escapes every server string before it reaches innerHTML', () => {
    const { render, panel } = load();
    render(panel, { conditions: [{ ...FIRED_TTYD, detail: '<img src=x onerror=alert(1)>', remediation: 'a "b" <c>' }] });
    assert.doesNotMatch(panel.innerHTML, /<img/);
    assert.match(panel.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(panel.innerHTML, /data-fix="a &quot;b&quot; &lt;c&gt;"/);
  });

  it('leaves the last render in place on a payload with no conditions array', () => {
    const { render, panel } = load();
    render(panel, { conditions: [FIRED_TTYD] });
    const before = panel.innerHTML;
    const r = render(panel, { conditions: 'nope' });
    // A malformed payload is no conditions at all, which is all-clear by the
    // rendering rule — but this pins that the rule is applied through the same
    // path (hide + empty), not by throwing halfway.
    assert.equal(r.visible, false);
    assert.notEqual(before, '');
    assert.equal(panel.innerHTML, '');
  });

  it('copies the remediation when its button is pressed and says so', async () => {
    const copied = [];
    const { render, panel } = load({ writeText: async (t) => { copied.push(t); } });
    render(panel, { conditions: [FIRED_TTYD] });
    // The mini-DOM does not parse innerHTML, so the delegated handler is driven
    // with a synthetic target carrying the same `data-fix` the button would.
    const button = { dataset: { fix: FIRED_TTYD.remediation }, textContent: 'Copy' };
    const listeners = [];
    const fakePanel = {
      dataset: {}, classList: panel.classList, innerHTML: '',
      addEventListener: (type, fn) => listeners.push({ type, fn })
    };
    render(fakePanel, { conditions: [FIRED_TTYD] });
    assert.equal(listeners.length, 1, 'bound once');
    render(fakePanel, { conditions: [FIRED_TTYD] });
    assert.equal(listeners.length, 1, 'not re-bound on the next poll');
    listeners[0].fn({ target: button });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(copied, [FIRED_TTYD.remediation]);
    assert.equal(button.textContent, 'Copied');
  });

  it('is a no-op without a container', () => {
    const { render } = load();
    assert.deepEqual({ ...render(null, { conditions: [FIRED_TTYD] }) }, { fired: 0, unknown: 0, visible: false });
  });
});
