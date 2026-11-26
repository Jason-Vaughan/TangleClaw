'use strict';

/*
 * Car V662-W1-C (#3260, V6-005): conversation readability for long text,
 * and breathing room around embedded link/media previews.
 *
 * The dispatch for this car described it as a "light-theme low-contrast
 * token audit & WCAG AA remediation" -- the real issue (checked before
 * building) is about typography and spacing, not color contrast. Built
 * against the real issue text.
 *
 * The issue's acceptance criteria also ask for heading hierarchy (h1-h4),
 * list indentation, and table/code-block formatting -- but `messageMarkup`
 * (public/v6-shell.js) renders a reply as plain escaped text lines joined
 * by a literal newline (`white-space: pre-wrap`), never as parsed Markdown
 * HTML with real heading/list/table elements. There is nothing for a CSS
 * rule like `.v6-conversation-content h2 {...}` to match, because no such
 * element is ever created. That requires markdown-to-HTML rendering in
 * messageMarkup, which belongs to a sibling car: this car's exclusive file
 * envelope is public/style.css only. What follows pins the two things a
 * CSS-only change can honestly deliver: looser line spacing for the dense
 * running text itself, and real separation around the embedded preview
 * elements that already exist as real markup (`.v6-chat-link-preview`,
 * `.v6-chat-unfurl`, `.v6-chat-local-ref`).
 *
 * This repo ships no jsdom/Playwright (see test/v6-b1-ui-shell.test.js's
 * own header), so this is the same source-level-regression pattern
 * test/v6-usage-popover-and-composer-layout.test.js already uses. The real
 * rendered result (both dark and light theme) was verified during
 * development against a static harness built from this exact CSS file and
 * the real markup shapes these classes produce, loaded in a real browser.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

/**
 * The body of the FIRST `{selector} { ... }` rule found in style.css.
 * @param {string} selector
 * @returns {string|null}
 */
function ruleBodyFor(selector) {
  const re = new RegExp(`${selector.replace(/[.#:]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = CSS.match(re);
  return match ? match[1] : null;
}

describe('#3260 (V6-005): looser line spacing for dense conversation text', () => {
  it('.v6-conversation-content sets a real line-height, not left at the browser default', () => {
    const body = ruleBodyFor('.v6-conversation-content');
    assert.ok(body, '.v6-conversation-content must exist');
    const match = body.match(/line-height:\s*([\d.]+)\s*;/);
    assert.ok(match, '.v6-conversation-content must set an explicit line-height');
    assert.ok(Number(match[1]) >= 1.4, `line-height ${match[1]} should give dense text real breathing room (>= 1.4)`);
  });

  it('still preserves copy-paste fidelity: white-space and overflow-wrap are untouched', () => {
    const body = ruleBodyFor('.v6-conversation-content');
    assert.match(body, /white-space:\s*pre-wrap;/, 'must still preserve the raw text\'s own line breaks');
    assert.match(body, /overflow-wrap:\s*anywhere;/);
  });
});

describe('#3260 (V6-005): embedded preview cards no longer crowd adjacent text', () => {
  for (const selector of ['.v6-chat-link-preview', '.v6-chat-unfurl', '.v6-chat-local-ref']) {
    it(`${selector} has a real vertical margin (>= 6px), not a near-zero one`, () => {
      const body = ruleBodyFor(selector);
      assert.ok(body, `${selector} must exist`);
      const match = body.match(/margin:\s*(\d+)px\s+0\s*;/);
      assert.ok(match, `${selector} must set an explicit vertical margin`);
      assert.ok(Number(match[1]) >= 6, `${selector}'s margin (${match[1]}px) should give it real separation from surrounding text (>= 6px)`);
    });
  }
});

describe('#3260 (V6-005): scope honesty -- this car does not claim to add markup it cannot create', () => {
  it('messageMarkup (public/v6-shell.js) still has no markdown-to-HTML rendering for headings/lists/tables', () => {
    const shellJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-shell.js'), 'utf8');
    const fnStart = shellJs.indexOf('function messageMarkup(');
    assert.ok(fnStart >= 0, 'messageMarkup must still exist as named here');
    const fnBody = shellJs.slice(fnStart, fnStart + 400);
    assert.doesNotMatch(fnBody, /<h[1-4]|<table|<ul|<ol|<pre/,
      'if messageMarkup starts emitting real heading/list/table/pre elements, this car\'s CSS-only '
      + 'scope note is stale and those elements need their own typography rules added here');
  });
});
