'use strict';

/*
 * `renderTailscaleModeSetting` is RUN here, not matched as source text
 * (#1037's standing rule for this file family: a regex cannot see an
 * undeclared identifier or a branch the real call never takes).
 *
 * It renders the Tailscale Advertisement toggle from the SERVER's resolved
 * `tailscaleStatus` (#1380) — never re-deriving whether the node is online or
 * MagicDNS is on, the same "server resolves, frontend renders" discipline the
 * Network Exposure section next to it already uses.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { liftDeclaration } = require('./helpers/lift');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

/**
 * Run `renderTailscaleModeSetting` against a config object.
 * @param {object} config - As `GET`/`PATCH /api/config` would return it.
 * @returns {string} The section's markup.
 */
function render(config) {
  const ctx = {
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  };
  vm.createContext(ctx);
  vm.runInContext(liftDeclaration(UI_SRC, 'function renderTailscaleModeSetting'), ctx);
  return ctx.renderTailscaleModeSetting(config);
}

describe('the settings modal Tailscale Advertisement section actually renders (#1380)', () => {
  it('renders the toggle unchecked and off by default', () => {
    // `tailscaleStatus` is always present in practice — `GET`/`PATCH
    // /api/config` compute it unconditionally (#1380) — so this is the real
    // shape the server sends for an install that never turned the mode on,
    // not an empty object (covered separately below, for a config the
    // server has not attached its resolution to at all).
    const html = render({ tailscaleStatus: { ok: false, reason: 'disabled', detail: 'Tailscale advertisement mode is not enabled' } });
    assert.match(html, /id="gsTailscaleMode"/);
    assert.doesNotMatch(html, /id="gsTailscaleMode" checked/);
    assert.match(html, /Off \(default\)/);
  });

  it('renders checked when tailscaleMode is on', () => {
    const html = render({ tailscaleMode: true, tailscaleStatus: { ok: false, reason: 'disabled', detail: 'x' } });
    assert.match(html, /id="gsTailscaleMode" checked/);
  });

  it('shows the resolved origin when the server reports ok', () => {
    const html = render({
      tailscaleMode: true,
      tailscaleStatus: { ok: true, origin: 'https://cursatory.tail123678.ts.net:8443', host: 'cursatory.tail123678.ts.net' }
    });
    assert.match(html, /https:\/\/cursatory\.tail123678\.ts\.net:8443/);
  });

  it('shows the honest failure detail when on but not usable, never a silent fallback claim', () => {
    const html = render({
      tailscaleMode: true,
      tailscaleStatus: { ok: false, reason: 'magicdns-off', detail: 'MagicDNS is off for this tailnet, so there is no stable hostname to advertise' }
    });
    assert.match(html, /not usable yet/);
    assert.match(html, /MagicDNS is off for this tailnet/);
  });

  it('escapes an untrusted detail string rather than injecting it raw', () => {
    const html = render({
      tailscaleMode: true,
      tailscaleStatus: { ok: false, reason: 'command-failed', detail: '<script>alert(1)</script>' }
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('falls back to a generic explanation when tailscaleStatus is entirely absent', () => {
    const html = render({ tailscaleMode: true });
    assert.match(html, /not usable yet/);
    assert.match(html, /the tailnet hostname could not be resolved/);
  });
});
