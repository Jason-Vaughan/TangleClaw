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

/**
 * A `checkCaddyDrift`-shaped result. Statuses are given per property, because
 * the notice is derived from THOSE and not from the flat findings list — the
 * distinction this helper exists to make testable.
 * @param {object} statuses - `{ gatedProxies, httpsProtocols, knownUpstreams, leaseReach }`.
 * @param {object} [findingsByKey] - Per-property findings.
 * @returns {object} A result object.
 */
function result(statuses, findingsByKey = {}) {
  const properties = {};
  for (const [key, status] of Object.entries(statuses)) {
    properties[key] = { status, findings: findingsByKey[key] || [] };
  }
  const findings = Object.values(properties)
    .filter((p) => p.status === drift.DIVERGED)
    .flatMap((p) => p.findings);
  return { measured: true, reason: null, properties, findings };
}

const ALL_HOLD = {
  gatedProxies: drift.HOLDS, httpsProtocols: drift.HOLDS,
  knownUpstreams: drift.HOLDS, leaseReach: drift.HOLDS
};

describe('#1394 describeDrift — silence is only ever earned', () => {
  it('says nothing when the check ran and EVERY property holds', () => {
    assert.equal(drift.describeDrift(result(ALL_HOLD)), null);
  });

  it('speaks when a property could not be measured, even with nothing diverged', () => {
    // The blocking defect this pins: the notice was derived from the flat
    // `findings` list, which carries DIVERGENCES only. An all-holds result and a
    // result with an unmeasurable property both present an empty list, so an
    // unrun property reached the operator as silence — and the boot log then
    // said the file holds every security property.
    const notice = drift.describeDrift(result(
      { ...ALL_HOLD, leaseReach: drift.NOT_MEASURED },
      { leaseReach: ['PortHub did not answer, so no lease could be cross-referenced'] }
    ));
    assert.ok(notice, 'an unmeasurable property is not a clean bill');
    assert.equal(notice.severity, 'unknown');
    assert.match(notice.message, /could not be checked/);
    assert.equal(notice.unmeasured.length, 1);
    assert.match(notice.unmeasured[0], /PortHub did not answer/);
    assert.match(notice.unmeasured[0], /narrower reach/, 'and names WHICH property');
  });

  it('speaks for an ungated config, which leaves P1 permanently unmeasurable', () => {
    // Reachable on an ordinary install, not a contrived one: a config with no
    // credential generates an ungated baseline, so there is no gate property to
    // diverge from and P1 is never measurable.
    const notice = drift.describeDrift(result(
      { ...ALL_HOLD, gatedProxies: drift.NOT_MEASURED },
      { gatedProxies: ['TangleClaw is configured to generate an UNGATED ingress'] }
    ));
    assert.ok(notice);
    assert.match(notice.unmeasured[0], /every proxying site has a gate/);
  });

  it('reports divergences and unmeasured properties together, never one instead of the other', () => {
    const notice = drift.describeDrift(result(
      { gatedProxies: drift.DIVERGED, httpsProtocols: drift.HOLDS,
        knownUpstreams: drift.DIVERGED, leaseReach: drift.NOT_MEASURED },
      { gatedProxies: ['no gate'], knownUpstreams: ['unknown upstream'], leaseReach: ['no lease'] }
    ));
    assert.equal(notice.severity, 'diverged');
    assert.deepEqual(notice.findings, ['no gate', 'unknown upstream']);
    assert.equal(notice.unmeasured.length, 1);
    assert.match(notice.message, /does not hold 2 of the 4/);
    assert.match(notice.message, /1 property could not be checked/);
  });

  it('counts PROPERTIES, not findings', () => {
    // Two ungated blocks break one property. Counting findings called that
    // "2 security properties".
    const notice = drift.describeDrift(result(
      { ...ALL_HOLD, gatedProxies: drift.DIVERGED },
      { gatedProxies: ['site A has no gate', 'site B has no gate'] }
    ));
    assert.match(notice.message, /does not hold 1 of the 4 security properties/);
    assert.equal(notice.findings.length, 2, 'both findings still reach the operator');
  });

  it('reports a check that could not run at all', () => {
    const notice = drift.describeDrift({
      measured: false, reason: 'caddy is not available: caddy not found on PATH', findings: []
    });
    assert.equal(notice.severity, 'unknown');
    assert.match(notice.message, /could not check/);
    assert.match(notice.message, /caddy not found/);
  });

  it('stays neutral — a hand-edit is usually deliberate', () => {
    const notice = drift.describeDrift(result(
      { ...ALL_HOLD, gatedProxies: drift.DIVERGED }, { gatedProxies: ['x'] }
    ));
    assert.ok(!/mistake|wrong|should have|you broke|error/i.test(notice.message), notice.message);
  });

  it('copies the findings rather than aliasing the result', () => {
    const r = result({ ...ALL_HOLD, gatedProxies: drift.DIVERGED }, { gatedProxies: ['one'] });
    const notice = drift.describeDrift(r);
    r.properties.gatedProxies.findings.push('two');
    assert.deepEqual(notice.findings, ['one'], 'the notice is a snapshot of what was measured');
  });

  it('tolerates a null result and a result with no properties', () => {
    assert.equal(drift.describeDrift(null), null);
    assert.equal(drift.describeDrift({ measured: true, reason: null, findings: [] }), null);
  });

  it('redacts a hash out of what it emits, without the test doing the redacting', () => {
    // Every string below is asserted as describeDrift RETURNED it. A guard that
    // calls redactHashes in its own body and asserts on its own output is a
    // tautology: the module can stop redacting and the assertion still passes.
    const hash = '$2a$14$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';

    const unrun = drift.describeDrift({
      measured: false, reason: `adapt failed on: basic_auth jason ${hash}`, findings: []
    });
    assert.ok(!unrun.message.includes(hash), unrun.message);

    const diverged = drift.describeDrift(result(
      { ...ALL_HOLD, gatedProxies: drift.DIVERGED, leaseReach: drift.NOT_MEASURED },
      { gatedProxies: [`site ${hash} has no gate`], leaseReach: [`lease ${hash} unreadable`] }
    ));
    assert.ok(!diverged.findings.join(' ').includes(hash), 'findings leaked the hash');
    assert.ok(!diverged.unmeasured.join(' ').includes(hash), 'unmeasured leaked the hash');
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

  it('renders unmeasured properties beside the divergences, never instead of them', () => {
    const out = render({
      message: 'The live Caddyfile does not hold 1 of the 4 security properties TangleClaw would generate. 1 property could not be checked at all.',
      severity: 'diverged',
      findings: ['the site on :3250 proxies to 127.0.0.1:3250 with no gate'],
      unmeasured: ['no site fronts a port leased for a narrower reach — PortHub did not answer']
    });
    assert.equal(out.hidden, false);
    assert.ok(out.html.includes('with no gate'), out.html);
    assert.ok(out.html.includes('PortHub did not answer'), 'the unmeasured property must be on screen');
    assert.match(out.html, /caddy-drift-unmeasured/, 'and marked as not-checked rather than found');
  });

  it('renders an unmeasured-only notice, which has no findings at all', () => {
    const out = render({
      message: '1 property could not be checked at all.', severity: 'unknown',
      findings: [], unmeasured: ['every proxying site has a gate — ungated config']
    });
    assert.equal(out.hidden, false, 'silence here is the defect this whole path exists to prevent');
    assert.ok(out.html.includes('ungated config'), out.html);
  });

  it('escapes an unmeasured reason too, not just a finding', () => {
    const out = render({
      message: 'ok', severity: 'unknown', findings: [],
      unmeasured: ['<img src=x onerror=alert(1)>']
    });
    assert.ok(!out.html.includes('<img'), out.html);
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
