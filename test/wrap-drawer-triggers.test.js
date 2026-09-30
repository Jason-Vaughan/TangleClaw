'use strict';

/*
 * #2027: the wrap drawer opens only from an explicit operator action.
 *
 * TangleClaw used to open it when a session printed a fixed marker, which made
 * pane text a request channel: anything that could print into a pane (the
 * engine quoting documentation, a tool's output, a relayed Medusa message, a
 * launch payload echoed back) could open a wrap. That trigger is removed. These
 * tests pin the removal from both ends:
 *
 * - the dashboard opens the drawer from exactly two call sites, both explicit
 *   Wrap actions, and reads no server-side "wrap requested" signal;
 * - no tracked file carries the marker: server code, the dashboard, the docs,
 *   hooks, engine data, the text TangleClaw writes into an engine's config, and
 *   the unreleased notes. (Released CHANGELOG sections are hash-locked history
 *   and are exempt.) So no server path can match it in pane text, message
 *   bodies or payloads, and no prime or document can tell an engine to print it.
 *
 * The status route and the retired acknowledge route are covered behaviourally
 * in `test/api-sessions.test.js`; pane text in `test/engine-error-monitor.test.js`;
 * the prime in `test/sessions.test.js`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** The retired marker, assembled so this file never carries it whole. */
const LEGACY_MARKER = ['TANGLECLAW', 'WRAP'].join('_');

/**
 * Every file under a directory, recursively, skipping dependency folders.
 * @param {string} dir - Absolute directory
 * @returns {string[]} Absolute file paths
 */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/**
 * The function body that contains a source position: from the nearest
 * preceding `function ` declaration to the next one.
 * @param {string} src - Source text
 * @param {number} at - Index inside the body
 * @returns {string} The enclosing function's name
 */
function enclosingFunction(src, at) {
  const before = src.lastIndexOf('\nfunction ', at);
  const match = /^\nfunction ([A-Za-z0-9_$]+)\(/.exec(src.slice(before));
  return match ? match[1] : null;
}

/**
 * Where a function is called (not declared) in a source file.
 * @param {string} src - Source text
 * @param {string} name - Function name
 * @returns {number[]} Call positions
 */
function callSites(src, name) {
  const sites = [];
  const re = new RegExp(`(?<!function )\\b${name}\\(`, 'g');
  let m;
  while ((m = re.exec(src))) sites.push(m.index);
  return sites;
}

describe('the wrap drawer opens only from an explicit Wrap action (#2027)', () => {
  it('the session page opens it only from the Wrap button handler', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'session.js'), 'utf8');
    const callers = callSites(src, 'openWrapModal').map((at) => enclosingFunction(src, at));
    assert.deepEqual(callers, ['onWrapButtonClick']);
  });

  it('the landing page opens it only from the per-project Wrap action', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'landing.js'), 'utf8');
    const callers = callSites(src, 'openWrapModal').map((at) => enclosingFunction(src, at));
    assert.deepEqual(callers, ['wrapProject']);
  });

  it('no dashboard script reads a server-side wrap request', () => {
    for (const file of walk(path.join(ROOT, 'public')).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(file, 'utf8');
      assert.equal(/wrapRequested|wrap-sentinel/.test(src), false, path.relative(ROOT, file));
    }
  });
});

describe('no tracked file carries the retired marker (#2027)', () => {
  // Every file git tracks: server code, the dashboard, docs, hooks, engine data,
  // generated fixtures, and release history, which an engine may be asked to read.
  const { execFileSync } = require('node:child_process');
  const sources = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((rel) => path.join(ROOT, rel))
    .filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());

  it('scans a real corpus', () => {
    assert.ok(sources.length > 500, `expected the tracked tree, found ${sources.length} files`);
  });

  /**
   * The text of a tracked file that the sweep holds to the rule. Released
   * CHANGELOG sections are the one exemption: they are hash-locked because each
   * one's GitHub Release page carries the same text, so they are immutable
   * history, and nothing reads them for the marker. Everything from the top of
   * the file through `[Unreleased]` stays covered.
   * @param {string} file - Absolute path
   * @returns {string}
   */
  function swept(file) {
    const text = fs.readFileSync(file, 'latin1');
    if (path.relative(ROOT, file) !== 'CHANGELOG.md') return text;
    const unreleased = text.indexOf('## [Unreleased]');
    const firstRelease = unreleased === -1 ? -1 : text.indexOf('\n## [', unreleased + 1);
    return firstRelease === -1 ? text : text.slice(0, firstRelease);
  }

  it('no tracked file contains it (released CHANGELOG history excepted)', () => {
    const hits = sources.filter((file) => swept(file).includes(LEGACY_MARKER));
    assert.deepEqual(hits.map((f) => path.relative(ROOT, f)), []);
  });

  it('the exemption reaches only released CHANGELOG history, not the unreleased notes', () => {
    const file = path.join(ROOT, 'CHANGELOG.md');
    const full = fs.readFileSync(file, 'latin1');
    const kept = swept(file);
    assert.ok(kept.includes('## [Unreleased]'), 'the unreleased notes are swept');
    assert.equal(/\n## \[\d/.test(kept), false, 'no released section is in the swept text');
    assert.ok(kept.length < full.length, 'released history exists and is excluded');
  });
});
