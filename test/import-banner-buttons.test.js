'use strict';

/*
 * #1383 — the port-lease import banner's Ignore button had never worked.
 *
 * `renderImportBanner` built ONE escaped value and fed it to both buttons,
 * but they take different argument shapes: `importLeaseProjects` JSON.parses
 * what it receives, `ignoreLeaseProject` takes the raw name. The shared
 * double-stringify handed Ignore the name wrapped in literal quotes, which
 * never matched the canonical form, so the banner returned forever.
 *
 * These assert the ROUND TRIP rather than the spelling of the source: each
 * onclick is decoded the way a browser would, and the argument the handler
 * would actually receive is compared against what that handler expects. A
 * test matching the source text would pass on any encoding that merely looked
 * different, which is the mistake that let this ship.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** Reverse `esc()` in public/landing.js — what the HTML parser does to an attribute value. */
function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Pull the single argument out of `fn(<arg>)` and evaluate it as the JS literal it is. */
function argumentOf(onclick) {
  const m = onclick.match(/^[A-Za-z_$][\w$]*\((.*)\)$/s);
  assert.ok(m, `not a single-call onclick: ${onclick}`);
  return JSON.parse(m[1]);
}

describe('port-lease import banner buttons (#1383)', () => {
  let render;

  before(() => {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    const start = ui.indexOf('const details = importable.map');
    const end = ui.indexOf(".join('');", start);
    assert.ok(start > -1 && end > start, 'the banner item template must still be findable');

    // Evaluate the real template from the shipped file against a local `esc`,
    // so the assertions below run over the bytes that reach the browser.
    const body = ui.slice(start, end + ".join('')".length) + '; return details;';
    render = new Function('importable', 'esc', `
      ${body.replace('const details =', 'const details =')}
    `);
  });

  const esc = (str) => typeof str !== 'string' ? '' : str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const onclicks = (name) => {
    const html = render([{ name, ports: [{ port: 5432, service: 'postgresql@14' }], conflicts: [] }], esc);
    return [...html.matchAll(/onclick="([^"]*)"/g)].map(m => unescapeHtml(m[1]));
  };

  it('Ignore receives the RAW project name, not a JSON-encoded one', () => {
    // The defect: it received `"Homebrew"` including the quote characters, so
    // the ignore set never matched the canonical name and the banner returned.
    const ignore = onclicks('Homebrew').find(o => o.startsWith('ignoreLeaseProject('));
    assert.ok(ignore, 'the Ignore button must exist');
    assert.equal(argumentOf(ignore), 'Homebrew');
  });

  it('Import still receives a JSON string, because it JSON.parses its argument', () => {
    // The other half of the contract, pinned so a fix to Ignore cannot be
    // applied to both call sites and silently break Import instead.
    const imp = onclicks('Homebrew').find(o => o.startsWith('importLeaseProjects('));
    assert.ok(imp, 'the Import button must exist');
    assert.deepEqual(JSON.parse(argumentOf(imp)), ['Homebrew']);
  });

  it('a name carrying quotes survives both round trips intact', () => {
    // `esc` turns a literal quote into &quot;, so a name containing one is the
    // case where an encoding error is invisible in the happy path.
    const name = 'Odd"Name';
    const [imp, ign] = ['importLeaseProjects(', 'ignoreLeaseProject(']
      .map(p => onclicks(name).find(o => o.startsWith(p)));
    assert.equal(argumentOf(ign), name);
    assert.deepEqual(JSON.parse(argumentOf(imp)), [name]);
  });
});
