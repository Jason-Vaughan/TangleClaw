'use strict';

/*
 * #909 — the first-run wizard must not draw a working tree it could not read
 * as clean.
 *
 * The wizard's candidate list rendered `git.dirty` with a two-way branch
 * (`dirty ? ' (dirty)' : ''`), so the third value — null, the scanner's "this
 * was never established" — drew exactly like `false`. Absence of the suffix is
 * how a CLEAN repository is drawn, so an unestablished read was reported as its
 * opposite: the same defect #885 removed from the dashboard, on the one surface
 * that #885 recorded as deliberately out of scope.
 *
 * The entries come from `POST /api/setup/scan` → `lib/dir-scanner-child.js`
 * `scanEntries`, whose git records are produced by `lib/git.js` `getInfo`:
 * `{branch, dirty: boolean|null, …, incomplete: string[], cause}` — a field
 * named in `incomplete` has no value rather than a default. The degraded
 * fixture below is that documented shape with `cause: 'read-timed-out'`, the
 * cause `getInfo` reports when its budget expires.
 *
 * Same vm-plus-DOM-stub approach as setup-wizard-dir-error.test.js, but the
 * classifiers are NOT stubbed: the real `public/api-helper.js` runs in the
 * sandbox, and `esc` / `degradedTooltip` are lifted verbatim from
 * `public/landing.js` / `public/ui.js` — the wizard page loads all three, and
 * a stub here could pass while the real normaliser branches differently.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public');
const SETUP_JS_SRC = fs.readFileSync(path.join(PUB, 'setup.js'), 'utf8')
  .replace(/^const wizard = /m, 'var wizard = ') + '\n;globalThis.wizard = wizard;\n';
const API_HELPER_SRC = fs.readFileSync(path.join(PUB, 'api-helper.js'), 'utf8');
const LANDING_SRC = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');

/**
 * Slice out a top-level function by brace-matching from its declaration, so the
 * sandbox runs the REAL helper rather than a re-implementation that can drift.
 * Same lift as test/degraded-reads-frontend.test.js.
 *
 * @param {string} src - File source text.
 * @param {string} decl - The declaration to find, e.g. `function esc(str)`.
 * @returns {string} The declaration plus its body.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/** Minimal element stub covering what the detect-projects step touches. */
function makeElement(id) {
  const classSet = new Set(['hidden']);
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c)
    },
    focus() {},
    addEventListener() {},
    dispatchEvent() {}
  };
}

/**
 * Load setup.js plus the real classifiers, render the detect-projects step for
 * the given scanned entries, and return the produced HTML.
 *
 * @param {object[]} scannedProjects - Entries as `/api/setup/scan` shapes them.
 * @returns {string} `body.innerHTML` after `renderDetectProjects`.
 */
function renderList(scannedProjects) {
  const sandbox = {
    console, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    Promise, Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, Error,
    apiMutate: async () => null,
    api: Object.assign(async () => null, { lastError: null }),
    loadConfig: async () => {}, loadProjects: async () => {}, loadStats: async () => {},
    loadPorts: async () => {}, maybeShowFilter: () => {}, startPolling: () => {},
    state: { engines: [], config: { setupComplete: false, protectedRoots: [] } },
    fetch: async () => ({ ok: true })
  };
  const elements = new Map();
  sandbox.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    body: { classList: { add() {}, remove() {} } }
  };
  sandbox.window = sandbox;
  sandbox.location = { href: null };

  vm.createContext(sandbox);
  vm.runInContext(liftFunction(LANDING_SRC, 'function esc(str)'), sandbox);
  vm.runInContext(liftFunction(UI_SRC, 'function degradedTooltip(record)'), sandbox);
  vm.runInContext(API_HELPER_SRC, sandbox);
  vm.runInContext(SETUP_JS_SRC, sandbox);

  sandbox.wizard.projectsDir = '/tmp/projects';
  sandbox.wizard.scannedProjects = scannedProjects;
  sandbox.wizard.selectedProjects = new sandbox.Set();

  const body = makeElement('setupBody');
  sandbox.renderDetectProjects(body);
  return body.innerHTML;
}

/** The `<label>` block for one entry, so assertions don't cross entries. */
function entryBlock(html, name) {
  const at = html.indexOf(name);
  assert.notEqual(at, -1, `${name} must be listed`);
  const start = html.lastIndexOf('<label', at);
  const end = html.indexOf('</label>', at);
  return html.slice(start, end);
}

describe('Setup wizard — unestablished working tree renders as unknown (#909)', () => {
  // The three-valued shape `lib/git.js` getInfo documents: a field named in
  // `incomplete` has no value. `read-timed-out` is what a budget expiry reports.
  const entries = [
    {
      name: 'clean-repo', path: '/tmp/projects/clean-repo', detected: true,
      git: { branch: 'main', dirty: false, latestTag: null, incomplete: [] }
    },
    {
      name: 'dirty-repo', path: '/tmp/projects/dirty-repo', detected: true,
      git: { branch: 'main', dirty: true, latestTag: null, incomplete: [] }
    },
    {
      name: 'slow-repo', path: '/tmp/projects/slow-repo', detected: true,
      git: {
        branch: 'main', dirty: null, latestTag: null,
        incomplete: ['dirty'], cause: 'read-timed-out'
      }
    },
    {
      // Contract-violating shape: classifies unknown (dirty null) while
      // `incomplete` names nothing, so `tcGitRead` reports a healthy read.
      // The marker must still draw; the degraded tooltip must not.
      name: 'odd-repo', path: '/tmp/projects/odd-repo', detected: true,
      git: { branch: 'main', dirty: null, latestTag: null, incomplete: [] }
    },
    { name: 'plain-folder', path: '/tmp/projects/plain-folder', detected: false, git: null }
  ];

  it('renders the unestablished read as ?, never as clean', () => {
    const html = renderList(entries);
    const slow = entryBlock(html, 'slow-repo');
    const clean = entryBlock(html, 'clean-repo');

    assert.match(slow, /class="git-unknown"/,
      'the unknown marker must be drawn — absence of a marker means clean');
    assert.match(slow, /aria-hidden="true">\?</, 'the ? glyph must be visible');
    assert.match(slow, /title="[^"]*Could not establish/,
      'the tooltip must say WHY the state is unknown');

    // The defect: the unknown entry drew byte-identical to the clean one bar
    // the name. The meta span must differ, not merely the label text.
    assert.doesNotMatch(clean, /git-unknown/, 'a clean tree earns no ? marker');
    assert.doesNotMatch(clean, /title=/, 'a clean tree needs no degraded tooltip');
  });

  it('still renders dirty and clean as before', () => {
    const html = renderList(entries);
    assert.match(entryBlock(html, 'dirty-repo'), /main \(dirty\)/);
    const clean = entryBlock(html, 'clean-repo');
    assert.match(clean, /main/);
    assert.doesNotMatch(clean, /\(dirty\)/);
  });

  it('draws the marker without a tooltip when unknown carries no incomplete', () => {
    const odd = entryBlock(renderList(entries), 'odd-repo');
    assert.match(odd, /git-unknown/, 'unknown still earns the marker');
    assert.doesNotMatch(odd, /title=/,
      'a read tcGitRead calls healthy must not render an empty degraded tooltip');
  });

  it('renders a non-repository with an empty meta and no marker', () => {
    const block = entryBlock(renderList(entries), 'plain-folder');
    assert.match(block, /<span class="setup-project-meta"><\/span>/);
    assert.doesNotMatch(block, /git-unknown/);
  });
});
