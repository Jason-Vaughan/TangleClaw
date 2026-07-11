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

  // Regression — inbox modal could not be dismissed once opened: opening it marks
  // read → unread 0 → the badge (the toggle) self-hides, leaving no close control
  // and no Escape handler (mobile trap). Fix: explicit ✕ in the panel header, a
  // delegated close handler, Escape-to-close, and a dedicated closeMedusaInbox().
  describe('inbox panel is dismissable (regression: self-hiding badge left it stuck)', () => {
    it('renders an explicit close button in both the empty and populated panel', () => {
      const body = fnBody('renderMedusaMessages');
      // The shared header holds the ✕ close control...
      assert.match(body, /medusa-panel-close/);
      assert.match(body, /aria-label="Close inbox"/);
      // ...and it is used in both branches (header const, no lone title left behind).
      assert.doesNotMatch(body, /'<div class="group-popover-title">Medusa inbox<\/div>'/);
    });

    it('exposes a dedicated close path separate from the open toggle', () => {
      const body = fnBody('closeMedusaInbox');
      assert.match(body, /panel\.hidden\s*=\s*true/);
    });

    it('wires the close button (delegated) and Escape to close the panel', () => {
      // Delegated because the panel innerHTML is re-rendered on each open.
      assert.match(src, /\.medusa-panel-close'\)\)\s*closeMedusaInbox\(\)/);
      // Escape closes the open panel.
      assert.match(src, /e\.key !== 'Escape'/);
      assert.match(src, /!panel\.hidden.*closeMedusaInbox\(\)/s);
    });
  });

  // MED-2K9P art upgrade (approach B): real gold WebP art — two facing heads
  // flanking the MEDUSA emblem, per-head <img> so the inbound/outbound heads glow
  // independently; status carried by state (dim off / amber-glow error), not recolor.
  describe('banner mark uses the real art with per-head elements', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');
    const mark = (html.match(/<span class="medusa-mark"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '';
    it('renders separate inbound/outbound head images', () => {
      assert.match(html, /class="medusa-head medusa-head--in"[^>]*src="\/medusa-head-left\.webp"/);
      assert.match(html, /class="medusa-head medusa-head--out"[^>]*src="\/medusa-head-right\.webp"/);
      // The crude placeholder SVG paths are gone.
      assert.doesNotMatch(html, /class="golden"/);
    });
    it('places the MEDUSA emblem between the two heads (no bridge)', () => {
      // Order within the mark: inbound head → emblem → outbound head.
      assert.match(mark, /medusa-head--in[\s\S]*medusa-emblem[\s\S]*medusa-head--out/);
      assert.match(html, /class="medusa-emblem"[^>]*src="\/medusa-wordmark\.webp"/);
      // The bridge element and its asset reference are gone.
      assert.doesNotMatch(html, /medusa-bridge/);
    });
    it('ships the referenced WebP assets — and no longer the bridge', () => {
      for (const f of ['medusa-head-left.webp', 'medusa-head-right.webp', 'medusa-wordmark.webp']) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', f)), `${f} missing`);
      }
      assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'medusa-bridge.webp')),
        'medusa-bridge.webp should be removed');
    });
  });

  // Hover help — the control's `title` explains what Medusa is + what it's doing,
  // distinct from the concise aria-label (which stays the accessible name).
  describe('control has descriptive hover help', () => {
    it('medusaHelpText explains the switchboard and the live state', () => {
      const body = fnBody('medusaHelpText');
      assert.match(body, /switchboard|session-to-session/);
      assert.match(body, /listening/);   // the "on" state describes what it's doing
    });
    it('wires the tooltip to the help text, not the terse aria-label', () => {
      assert.match(src, /heads\.title\s*=\s*medusaHelpText\(m\)/);
      // aria-label stays the concise state label (accessible name hygiene).
      assert.match(src, /heads\.setAttribute\('aria-label', label\)/);
    });
  });

  // MED-2K9P Chunk 03 — compose (outbound). The visual is operator-verified, but
  // the honest-result contract, XSS guard on roster names, no-new-timer rule, and
  // off-state gating are correctness-relevant and cheap to pin against regression.
  describe('compose / outbound send (MED-2K9P Chunk 03)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');

    it('renders the compose button + panel elements in the control', () => {
      assert.match(html, /id="medusaCompose"[^>]*aria-haspopup="dialog"/);
      assert.match(html, /id="medusaComposePanel"[^>]*role="dialog"/);
    });

    it('escapes untrusted roster names/ids in the target picker (XSS guard)', () => {
      const body = fnBody('renderMedusaCompose');
      assert.match(body, /esc\(w\.id\)/);
      assert.match(body, /esc\(w\.name/);
      // Nothing raw-interpolates a roster field into the option markup.
      assert.doesNotMatch(body, /\$\{w\.id\}/);
      assert.doesNotMatch(body, /\$\{w\.name\}/);
    });

    it('surfaces the honest send result — queued is distinct from received, and failure never claims "sent"', () => {
      const body = fnBody('sendMedusaMessage');
      // Branches on the real status; queued is called out separately from delivered.
      assert.match(body, /result\.status\s*===\s*'queued'/);
      assert.match(body, /Queued/);
      assert.match(body, /Delivered/);
      // The failure path reports it couldn't send — no blanket success.
      assert.match(body, /Couldn't send/);
      // It never asserts a bare "Sent"/"Message sent" success (which would hide queued/failed).
      assert.doesNotMatch(body, /Message sent|['"`]Sent/);
    });

    it('validates a target + non-empty message client-side before POSTing', () => {
      const body = fnBody('sendMedusaMessage');
      assert.match(body, /Pick a session/);
      assert.match(body, /Type a message/);
      // Uses the shared apiMutate JSON path to the send endpoint.
      assert.match(body, /apiMutate\([\s\S]*?medusa\/send/);
    });

    it('distinguishes a failed roster fetch from an empty roster (never a false "nobody home")', () => {
      // renderMedusaCompose has a dedicated error branch...
      const render = fnBody('renderMedusaCompose');
      assert.match(render, /errorMsg/);
      assert.match(render, /Couldn't load sessions/);
      // ...and openMedusaCompose routes a null (failed) fetch into it with the real error.
      const open = fnBody('openMedusaCompose');
      assert.match(open, /data === null/);
      assert.match(open, /api\.lastError/);
    });

    it('gates the compose control on listener state — hidden + closed when off', () => {
      const body = fnBody('renderMedusaControl');
      assert.match(body, /m\.state\s*!==\s*'off'/);
      assert.match(body, /closeMedusaCompose\(\)/);
    });

    it('lights the outbound head and announces the send on the aria-live region', () => {
      const body = fnBody('flowMedusaOutbound');
      assert.match(body, /flow-out/);
      assert.match(body, /getElementById\(['"]medusaLive['"]\)/);
      assert.match(body, /delivered|queued/i);
    });

    it('adds no new UI timer — compose rides existing plumbing (no-timer rule #98/#268)', () => {
      for (const name of ['openMedusaCompose', 'renderMedusaCompose', 'sendMedusaMessage', 'flowMedusaOutbound', 'closeMedusaCompose']) {
        assert.doesNotMatch(fnBody(name), /setInterval\(|setTimeout\(/, `${name} must not start a timer`);
      }
    });

    it('wires the compose button, delegated Send, and Escape/✕ to close', () => {
      assert.match(src, /medusaCompose'?\)?\.addEventListener\('click', openMedusaCompose\)/);
      assert.match(src, /\.medusa-compose-send'\)\)\s*sendMedusaMessage\(\)/);
      // Escape closes the open compose panel too.
      assert.match(src, /composePanel && !composePanel\.hidden\)\s*closeMedusaCompose\(\)/);
    });
  });
});
