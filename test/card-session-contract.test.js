'use strict';

/**
 * The project card's `session` object is a contract between two layers that no
 * single-layer test can hold (#1311).
 *
 * `lib/projects.js` projects it (`_liveSession`, `_unknownSession`) and the
 * landing-page scripts read it. A field one side has and the other does not is
 * invisible to a test that asserts on the payload alone or on the renderer
 * alone. Both directions have shipped: a `status` the projection emitted that no
 * renderer read (#1034), and a `sessionMode` the Kill modal read that the
 * projection never emitted, so every webui kill was described as terminating a
 * tmux session. This file therefore RUNS the renderer against the real
 * projection, and guards the whole read surface rather than one field.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const projects = require('../lib/projects');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUBLIC_DIR, 'ui.js'), 'utf8');

/**
 * The landing-page scripts that read a project card's `session` object. A new
 * script that reads it belongs on this list, or the guard below cannot see it.
 * `public/session.js` is deliberately absent: the session page reads
 * `GET /api/sessions/:project/status`, a different payload.
 */
const CARD_SESSION_READERS = ['ui.js', 'api-helper.js', 'landing.js'];

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 *
 * @param {string} src - File source text.
 * @param {string} decl - The declaration, e.g. `function openKill(name)`.
 * @returns {string} The body including its braces.
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(bodyStart, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * Lift a function out of `ui.js` and RUN it, with the browser globals it closes
 * over supplied as parameters. `public/ui.js` is a browser global script, not a
 * requireable module.
 *
 * @param {string} decl - The declaration.
 * @param {string} name - The function's name.
 * @param {object} scope - Free variables by name.
 * @returns {Function} The real function, callable.
 */
function lift(decl, name, scope) {
  const names = Object.keys(scope);
  const factory = new Function(...names, `${decl}${functionBody(UI_SRC, decl)}\nreturn ${name};`);
  return factory(...names.map((k) => scope[k]));
}

/**
 * The production `esc` from `public/landing.js`, including its non-string
 * rejection, so rendered text is what the browser would show.
 *
 * @param {*} str - Value to escape.
 * @returns {string}
 */
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The few elements `openKill` touches, as a stand-in `document`.
 *
 * @returns {{document: object, el: Record<string, object>}}
 */
function fakeKillModalDom() {
  const el = {};
  for (const id of ['killModal', 'killText', 'killError', 'killPassword', 'killPasswordGroup']) {
    const classes = new Set();
    el[id] = {
      innerHTML: '',
      value: 'stale',
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) }
    };
  }
  return { document: { getElementById: (id) => el[id] }, el };
}

/**
 * Remove `/* … *\/` blocks and `//` line comments. A `//` counts as a comment
 * only at the start of a line or after whitespace, so the `://` of a URL in a
 * string survives. Comments mention `session.js` and `session.html` by name,
 * which are not field reads.
 *
 * @param {string} src - Source text.
 * @returns {string}
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/**
 * Every `session.<field>` read in a script. The landing page binds the card's
 * object as `project.session` / `proj.session` or a local named `session`, and
 * all three end in `session.<field>`.
 *
 * @param {string} src - Source text.
 * @returns {Set<string>} Field names read.
 */
function sessionFieldReads(src) {
  const fields = new Set();
  for (const m of stripComments(src).matchAll(/\bsession\??\.([A-Za-z_$][\w$]*)/g)) fields.add(m[1]);
  return fields;
}

describe('the card session contract (#1311)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-card-session-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * The card object the browser receives for a project with one active session:
   * a real store row, projected by the real `_liveSession`, through JSON as the
   * wire carries it.
   *
   * @param {string} name - Project name.
   * @param {object} sessionData - Extra `store.sessions.start` fields.
   * @returns {object} `{ name, session }` as `GET /api/projects` serves it.
   */
  function cardFor(name, sessionData) {
    const dir = path.join(tmpDir, 'projects', name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    store.sessions.start({ projectId: project.id, engineId: 'claude', ...sessionData });
    const row = store.sessions.getActive(project.id);
    return JSON.parse(JSON.stringify({ name, session: projects._liveSession(row, false) }));
  }

  /**
   * Run the real `openKill` for one card and return the modal's text.
   *
   * @param {object} card - A card object from `cardFor`.
   * @returns {string}
   */
  function killModalText(card) {
    const { document, el } = fakeKillModalDom();
    const openKill = lift('function openKill(name)', 'openKill', {
      document, esc, state: { projects: [card], config: {} }, killTarget: null
    });
    openKill(card.name);
    assert.ok(el.killModal.classList.has('open'), 'the modal opened');
    return el.killText.innerHTML;
  }

  describe('the Kill modal describes the mechanism the kill will use', () => {
    it('says a webui kill tears down the SSH tunnel', () => {
      const card = cardFor('webui-card', { tmuxSession: null, sessionMode: 'webui' });
      assert.equal(card.session.sessionMode, 'webui', 'the projection carries the mode');
      const text = killModalText(card);
      assert.match(text, /tears down the SSH tunnel/);
      assert.doesNotMatch(text, /tmux/);
    });

    it('says a tmux kill terminates the tmux session', () => {
      const card = cardFor('tmux-card', { tmuxSession: 'tc-tmux-card' });
      assert.equal(card.session.sessionMode, 'tmux', 'the store default reaches the card');
      assert.match(killModalText(card), /terminates the tmux session/);
    });
  });

  describe('the unknown-liveness shape', () => {
    it('carries sessionMode too, so the two shapes stay mirror images', () => {
      const dir = path.join(tmpDir, 'projects', 'unknown-card');
      fs.mkdirSync(dir, { recursive: true });
      const project = store.projects.create({ name: 'unknown-card', path: dir, engine: 'claude' });
      store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'tc-unknown-card' });
      const unknown = projects._unknownSession(store.sessions.getActive(project.id), 'read-timed-out', false);
      assert.equal(unknown.sessionMode, 'tmux');
    });
  });

  describe('every field the landing page reads is one the projection emits', () => {
    it('finds no read of an unprojected card session field', () => {
      const emitted = new Set(Object.keys(projects._liveSession(
        { id: 1, status: 'active', startedAt: 'x', tmuxSession: 't', sessionMode: 'tmux' }, false
      )));
      const unprojected = [];
      for (const file of CARD_SESSION_READERS) {
        const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
        for (const field of sessionFieldReads(src)) {
          if (!emitted.has(field)) unprojected.push(`${file}: session.${field}`);
        }
      }
      assert.deepEqual(unprojected, [],
        'each of these is read by the landing page and never sent by lib/projects.js#_liveSession');
    });

    it('actually sees the reads it guards, so an empty result is not vacuous', () => {
      const ui = sessionFieldReads(fs.readFileSync(path.join(PUBLIC_DIR, 'ui.js'), 'utf8'));
      for (const field of ['active', 'sessionMode', 'lastEngineError']) {
        assert.ok(ui.has(field), `the scan must find ui.js reading session.${field}`);
      }
      assert.equal(sessionFieldReads('// see session.js\n/* session.html */').size, 0,
        'file names in comments are not field reads');
    });
  });
});
