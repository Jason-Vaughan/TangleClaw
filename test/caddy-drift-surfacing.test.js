'use strict';

/*
 * #1394 — how the Caddyfile divergence check reaches the operator.
 *
 * The check is worthless if its result stops at a log line: the operator is
 * almost never sitting at this machine. So the surface is tested by RUNNING it,
 * following the pattern `test/bind-notice-render.test.js` established after a
 * source-grep twice failed to notice that an exposure chip never rendered. A
 * grep can confirm a string exists; only execution confirms an operator with a
 * diverged Caddyfile actually sees the findings.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');

setLevel('error');

const drift = require('../lib/caddy-drift');
const serverInfo = require('../lib/server-info');

const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/**
 * Slice a top-level function out of landing.js by brace matching.
 * @param {string} name - Function name.
 * @returns {string} Its source.
 */
function extract(name) {
  const start = LANDING_SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} should exist in landing.js`);
  let depth = 0;
  for (let i = LANDING_SRC.indexOf('{', start); i < LANDING_SRC.length; i += 1) {
    if (LANDING_SRC[i] === '{') depth += 1;
    else if (LANDING_SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return LANDING_SRC.slice(start, i + 1);
    }
  }
  throw new Error(`could not brace-match ${name}`);
}

/**
 * Run `renderCaddyDriftBanner` against a DOM stub.
 * @param {object|null} notice - The notice to render.
 * @returns {{ hidden: boolean, html: string, text: string }} What the banner became.
 */
function render(notice) {
  const state = {
    banner: { _hidden: true, classList: {
      add(c) { if (c === 'hidden') state.banner._hidden = true; },
      remove(c) { if (c === 'hidden') state.banner._hidden = false; }
    } },
    text: { innerHTML: '', textContent: '' }
  };
  const ctx = vm.createContext({
    document: {
      getElementById: (id) => {
        if (id === 'caddyDriftBanner') return state.banner;
        if (id === 'caddyDriftBannerText') return state.text;
        return null;
      }
    }
  });
  vm.runInContext(
    `${extract('esc')}\n${extract('renderCaddyDriftBanner')}\n`
    + `renderCaddyDriftBanner(${JSON.stringify(notice)});`,
    ctx
  );
  return { hidden: state.banner._hidden, html: state.text.innerHTML, text: state.text.textContent };
}

describe('#1394 describeDrift — the wording, without a caddy binary', () => {
  it('says nothing when the check ran and every property holds', () => {
    assert.equal(drift.describeDrift({ measured: true, reason: null, findings: [] }), null);
  });

  it('reports a check that could not run, rather than staying silent', () => {
    // "TangleClaw did not look" and "TangleClaw looked and found nothing" are
    // different facts. Collapsing them is the failure the not-measured verdict
    // exists to prevent, so it must survive all the way to the surface.
    const notice = drift.describeDrift({
      measured: false, reason: 'caddy is not available: caddy not found on PATH', findings: []
    });
    assert.ok(notice, 'an unrun check still has something to say');
    assert.equal(notice.severity, 'unknown');
    assert.match(notice.message, /could not check/);
    assert.match(notice.message, /caddy not found/);
  });

  it('counts the properties and carries every finding', () => {
    const findings = ['a proxies with no gate', 'b fronts an unknown upstream'];
    const notice = drift.describeDrift({ measured: true, reason: null, findings });
    assert.equal(notice.severity, 'diverged');
    assert.match(notice.message, /2 security properties/);
    assert.deepEqual(notice.findings, findings);
  });

  it('says property, not properties, for one', () => {
    const notice = drift.describeDrift({ measured: true, reason: null, findings: ['just one'] });
    assert.match(notice.message, /1 security property\b/);
  });

  it('stays neutral — a hand-edit is usually deliberate', () => {
    const notice = drift.describeDrift({ measured: true, reason: null, findings: ['x'] });
    assert.ok(!/mistake|wrong|should have|you broke|error/i.test(notice.message), notice.message);
  });

  it('copies the findings rather than aliasing the result', () => {
    const result = { measured: true, reason: null, findings: ['one'] };
    const notice = drift.describeDrift(result);
    result.findings.push('two');
    assert.deepEqual(notice.findings, ['one'], 'the notice is a snapshot of what was measured');
  });

  it('tolerates a null result', () => {
    assert.equal(drift.describeDrift(null), null);
  });
});

describe('#1394 server-info carries the notice', () => {
  beforeEach(() => serverInfo.__unsafeResetForTest());

  it('starts null and reports what was set', () => {
    assert.equal(serverInfo.getServerInfo().caddyDriftNotice, null);
    const notice = { setting: 'Caddyfile', severity: 'diverged', message: 'm', findings: ['f'] };
    serverInfo.setCaddyDriftNotice(notice);
    assert.deepEqual(serverInfo.getServerInfo().caddyDriftNotice, notice);
  });

  it('clears on the test reset, like every other boot-time fact', () => {
    serverInfo.setCaddyDriftNotice({ message: 'm' });
    serverInfo.__unsafeResetForTest();
    assert.equal(serverInfo.getServerInfo().caddyDriftNotice, null);
  });

  it('treats an absent notice as null rather than undefined', () => {
    serverInfo.setCaddyDriftNotice(undefined);
    assert.equal(serverInfo.getServerInfo().caddyDriftNotice, null);
  });
});

describe('#1394 the dashboard banner, executed', () => {
  it('stays hidden when there is no notice', () => {
    for (const nothing of [null, undefined, {}]) {
      assert.equal(render(nothing).hidden, true, JSON.stringify(nothing));
    }
  });

  it('shows every finding on screen, not behind a hover', () => {
    // The dash-bar chip this deliberately is NOT truncates at 42ch and puts the
    // rest in a title attribute. The operator reads this on a phone, where
    // there is no hover, and the findings are the entire deliverable.
    const findings = [
      'the site on :3250 for box.example.ts.net proxies to 127.0.0.1:3250 with no gate',
      'the live Caddyfile fronts 127.0.0.1:3250, which TangleClaw does not generate'
    ];
    const out = render({ message: 'The live Caddyfile does not hold 2 security properties TangleClaw would generate.', severity: 'diverged', findings });
    assert.equal(out.hidden, false);
    for (const finding of findings) {
      assert.ok(out.html.includes(finding), `missing: ${finding}`);
    }
    assert.match(out.html, /<ul class="caddy-drift-findings">/);
    assert.ok(!/title=/.test(out.html), 'the findings must not be hidden in a tooltip');
  });

  it('renders the could-not-check state too', () => {
    const out = render({ message: 'TangleClaw could not check the live Caddyfile for drift: caddy is not available', severity: 'unknown', findings: [] });
    assert.equal(out.hidden, false);
    assert.match(out.html, /could not check/);
    assert.ok(!out.html.includes('<ul'), 'no list when there is nothing to list');
  });

  it('escapes a hostname out of the live Caddyfile', () => {
    // Findings quote the live file, which is operator-authored text arriving at
    // innerHTML. Nothing upstream vouches for its shape.
    const out = render({
      message: 'ok', severity: 'diverged',
      findings: ['the site on :80 for <img src=x onerror=alert(1)> proxies with no gate']
    });
    assert.ok(!out.html.includes('<img'), out.html);
    assert.ok(out.html.includes('&lt;img'), out.html);
  });

  it('escapes the message as well as the findings', () => {
    const out = render({ message: '<script>x</script>', severity: 'diverged', findings: [] });
    assert.ok(!out.html.includes('<script>'), out.html);
  });

  it('is wired into the server-info poll', () => {
    assert.match(LANDING_SRC, /renderCaddyDriftBanner\(data\.caddyDriftNotice\)/);
  });

  it('has its anchor and its wrapping style', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(html, /id="caddyDriftBanner"/);
    assert.match(html, /id="caddyDriftBannerText"/);
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(css, /\.caddy-drift-findings/);
    // The base chip truncates; this list must not, or a port number falls off
    // the end of a phone screen.
    assert.match(css, /\.caddy-drift-findings\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

describe('#1394 the boot wiring', () => {
  it('runs only in caddy ingress mode', () => {
    // Direct mode is not behind a Caddyfile TangleClaw owns, so there is
    // nothing of its own to have drifted.
    assert.match(SERVER_SRC, /if \(config\.ingressMode === 'caddy'\) \{\s*\n\s*setImmediate/);
  });

  it('defers past listen rather than delaying the socket on two subprocesses', () => {
    const idx = SERVER_SRC.indexOf('caddyDrift.checkCaddyDrift(');
    assert.ok(idx > -1, 'the boot path calls the check');
    const deferStart = SERVER_SRC.lastIndexOf('setImmediate', idx);
    assert.ok(deferStart > -1 && idx - deferStart < 2000, 'the call is inside a setImmediate');
  });

  it('passes null, not an empty array, when PortHub cannot be read', () => {
    // An empty list reads as "no lease declares a narrow reach" and turns an
    // unanswered PortHub into a clean bill of health.
    assert.match(SERVER_SRC, /Could not read port leases for the Caddyfile drift check[\s\S]{0,200}return null;/);
  });

  it('reports a failure of the check itself instead of implying a clean file', () => {
    const idx = SERVER_SRC.indexOf('Caddyfile drift check failed to run');
    assert.ok(idx > -1, 'the failure is logged');
    const after = SERVER_SRC.slice(idx, idx + 400);
    assert.match(after, /setCaddyDriftNotice/, 'and it still reaches the dashboard');
    assert.match(after, /measured: false/);
  });
});
