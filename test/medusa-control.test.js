'use strict';

/**
 * MED-2K9P Chunk 02 — structural source probes for the banner Medusa control in
 * `public/session.js`. The visual is operator-verified (VRF), but two behaviors
 * are security-/correctness-relevant and cheap to pin against regression:
 *   1. Inbound cross-session text (`from`/`message`) is untrusted and MUST be
 *      escaped before it reaches innerHTML (XSS guard).
 *   2. The receive flow rides the existing session poll (no new UI timer) and
 *      does not announce a pre-existing backlog as "new" on first paint.
 * Mirrors the source-probe convention in `settings-modal-silentprime.test.js`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');

/**
 * Slice a named function's body out of the source for scoped assertions.
 * @param {string} name - Function name.
 * @returns {string} The body slice (name → next top-level `\nfunction `).
 */
function fnBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('public/session.js — Medusa control (MED-2K9P Chunk 02)', () => {
  it('escapes untrusted inbound message text in the read panel', () => {
    const body = fnBody('renderMedusaMessages');
    // Both the sender and the message body are escaped before interpolation.
    assert.match(body, /esc\(msg\.from/);
    assert.match(body, /esc\(msg\.message/);
    // And nothing raw-interpolates msg.from/msg.message without esc().
    assert.doesNotMatch(body, /\$\{msg\.from\}/);
    assert.doesNotMatch(body, /\$\{msg\.message\}/);
  });

  it('escapes untrusted sender names in the peers popover', () => {
    const body = fnBody('showMedusaPeers');
    assert.match(body, /esc\(f\)/);
    assert.doesNotMatch(body, /\$\{f\}/);
  });

  it('seeds prevUnread on first render so a pre-existing backlog is not announced as new', () => {
    const body = fnBody('renderMedusaControl');
    // The first-render guard reads the `shown` flag and seeds prevUnread.
    assert.match(body, /if\s*\(\s*!m\.shown\s*\)/);
    assert.match(body, /m\.prevUnread\s*=\s*m\.unread/);
    // The flow only fires when unread rose beyond the prior count.
    assert.match(body, /m\.unread\s*>\s*m\.prevUnread/);
  });

  it('rides the existing session poll — no new timer for Medusa', () => {
    // pollMedusa is invoked from pollStatus (the shared cadence), and the Medusa
    // code introduces no setInterval/setTimeout of its own.
    assert.match(fnBody('pollStatus'), /pollMedusa\(/);
    for (const name of ['pollMedusa', 'renderMedusaControl', 'flowMedusaInbound', 'toggleMedusa']) {
      const body = fnBody(name);
      assert.doesNotMatch(body, /setInterval\(|setTimeout\(/, `${name} must not start a timer`);
    }
  });

  it('announces arrivals on an aria-live region (non-color/-motion a11y cue)', () => {
    const body = fnBody('flowMedusaInbound');
    assert.match(body, /getElementById\(['"]medusaLive['"]\)/);
    assert.match(body, /new Medusa message/);
  });
});
