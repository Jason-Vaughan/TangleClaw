'use strict';

/*
 * AUTH-2K9D — dashboard warning for an auth config-vs-live mismatch.
 *
 * Backend (auth-identity.resolveAuthStatus) + wiring (/api/server-info) are
 * covered by test/auth-identity.test.js and test/api-auth-identity.test.js.
 * This file covers the frontend surface with source-level structural
 * assertions — same pattern as test/update-release-link.test.js and
 * test/orphan-hooks-banner.test.js (landing.js is a browser global script,
 * not a require()-able module).
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('AUTH-2K9D dashboard warning surface', () => {
  let landing;
  let indexHtml;
  let css;

  before(() => {
    const root = path.resolve(__dirname, '..');
    landing = fs.readFileSync(path.join(root, 'public/landing.js'), 'utf8');
    indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  });

  it('index.html carries the warning chip element with a live-region role', () => {
    assert.match(indexHtml, /id="authStatusWarning"/);
    assert.match(indexHtml, /id="authStatusWarning"[^>]*role="status"/);
    // Hidden by default — only shown when a mismatch is detected.
    assert.match(indexHtml, /id="authStatusWarning"[^>]*class="[^"]*hidden/);
  });

  it('loadServerInfo renders authStatus from the poll', () => {
    assert.match(landing, /renderAuthStatus\(data\.authStatus\)/);
  });

  it('defines renderAuthStatus + the pure _authStatusWarning mapper', () => {
    assert.match(landing, /function renderAuthStatus\(/);
    assert.match(landing, /function _authStatusWarning\(/);
  });

  it('warns on the three closed states that need the operator, and only those (#1420)', () => {
    const mapperBody = landing.slice(landing.indexOf('function _authStatusWarning('));
    const fnBody = mapperBody.slice(0, mapperBody.indexOf('\n}\n') + 2);
    for (const status of ['account-required', 'locked', 'unreadable']) {
      assert.match(fnBody, new RegExp(`authStatus === '${status}'`), status);
    }
    assert.equal((fnBody.match(/return '⚠/g) || []).length, 3);
    // The expected states stay silent.
    assert.doesNotMatch(fnBody, /authStatus === '(off|live)'/);
    // A locked install names the one recovery that works for it.
    assert.match(fnBody, /reset-admin\.js --store/);
    // The proxy-header diagnostics are gone: nothing reads that header any more.
    assert.doesNotMatch(landing, /configured-inert|configured-no-identity|configured-bypassed|header_up X-Auth-User/);
  });

  it('every status the server can send has a decided rendering', () => {
    // A value the mapper has never heard of renders nothing, which is right for
    // `off`/`live` and wrong for a closed state — so the enum and the mapper are
    // checked against each other.
    const { AUTH_STATUSES } = require('../lib/auth-identity');
    const mapperBody = landing.slice(landing.indexOf('function _authStatusWarning('));
    const fnBody = mapperBody.slice(0, mapperBody.indexOf('\n}\n') + 2);
    for (const status of AUTH_STATUSES) {
      const warns = fnBody.includes(`authStatus === '${status}'`);
      const silent = status === 'off' || status === 'live';
      assert.equal(warns, !silent, `${status}: ${silent ? 'silent' : 'warns'}`);
    }
  });

  it('is state-driven: shows on a message, hides (clears) otherwise — no dismiss/timer', () => {
    // The render clears + hides when there is no warning message (self-clearing).
    assert.match(landing, /classList\.add\('hidden'\)/);
    assert.match(landing, /classList\.remove\('hidden'\)/);
    // No timer-driven lifecycle on this chip (per the no-UI-timers rule): the
    // render body must not schedule its own dismissal.
    const renderBody = landing.slice(landing.indexOf('function renderAuthStatus('));
    const fnBody = renderBody.slice(0, renderBody.indexOf('\n}\n') + 2);
    assert.doesNotMatch(fnBody, /setTimeout|setInterval/);
  });

  it('style.css carries the amber warning chip rule', () => {
    assert.match(css, /\.dash-auth-warning/);
    assert.match(css, /\.dash-auth-warning\.hidden\s*\{\s*display:\s*none/);
  });
});
