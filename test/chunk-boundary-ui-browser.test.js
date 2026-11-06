'use strict';

/*
 * #2888 (#2070/#1889 Slice 3): public/chunk-boundary-ui.js, the browser-side
 * renderer + fetch helper over lib/chunk-boundary-ui.js's own view model
 * (already served as `statusSurface` by every /api/sessions/:project/
 * chunk-boundary* route). Same lift-and-run convention
 * test/governed-wrap-ui.test.js uses for its own pure render functions.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadEsc, liftDeclaration } = require('./helpers/lift');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

describe('public/chunk-boundary-ui.js', () => {
  let js;

  beforeEach(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'chunk-boundary-ui.js'), 'utf8');
  });

  describe('renderChunkBoundaryBadge', () => {
    /** The function depends on the module-level tone-class map; same
     * `});`-boundary lift test/governed-wrap-ui.test.js#liftInfoConst uses
     * for its own sibling constant, since `liftDeclaration` alone would cut
     * `const X = Object.freeze({…}` off before its closing `);`. */
    function liftToneClassConst() {
      const decl = 'const CHUNK_BOUNDARY_TONE_CLASS';
      const start = js.indexOf(decl);
      assert.notEqual(start, -1);
      const end = js.indexOf('});', start) + 3;
      return js.slice(start, end);
    }

    function loadFn() {
      const esc = loadEsc('landing.js');
      const src = `${liftToneClassConst()}\n${liftDeclaration(js, 'function renderChunkBoundaryBadge(')}\nreturn renderChunkBoundaryBadge;`;
      return new Function('esc', src)(esc);
    }

    it('renders nothing for a null status surface', () => {
      assert.equal(loadFn()(null), '');
    });

    it('renders the label and a chunk-number title', () => {
      const html = loadFn()({ status: 'ready_to_clear', label: 'Ready to clear', tone: 'info', chunkNumber: 3, superseded: false });
      assert.match(html, />Ready to clear</);
      assert.match(html, /title="Chunk 3"/);
    });

    it('maps each real receiptStatusSurface tone to an existing badge class, never an undefined one', () => {
      // lib/chunk-boundary-ui.js#STATE_DISPLAY's own real tones -- derived
      // from the library source, not re-typed here, so a tone it adds later
      // reddens this rather than silently falling through to "neutral".
      const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'chunk-boundary-ui.js'), 'utf8');
      const tones = [...new Set([...libSrc.matchAll(/tone:\s*'(\w+)'/g)].map((m) => m[1]))];
      assert.ok(tones.length > 0, 'the library must name at least one tone');
      const style = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
      for (const tone of tones) {
        const html = loadFn()({ status: 'x', label: 'x', tone, chunkNumber: null, superseded: false });
        const cls = html.match(/class="([^"]+)"/)[1];
        for (const name of cls.split(' ')) {
          assert.match(style, new RegExp(`\\.${name}\\b`), `tone "${tone}" maps to CSS class "${name}", which must exist in style.css`);
        }
      }
    });

    it('marks a superseded receipt distinctly', () => {
      const html = loadFn()({ status: 'superseded', label: 'Superseded', tone: 'hold', chunkNumber: 2, superseded: true });
      assert.match(html, /\(superseded\)/);
    });
  });

  describe('fetchChunkBoundaryStatus', () => {
    function loadFn(apiImpl) {
      return new Function('api', `${liftDeclaration(js, 'async function fetchChunkBoundaryStatus(')}\nreturn fetchChunkBoundaryStatus;`)(apiImpl);
    }

    it('calls the real route path with assignmentId and chunkNumber, URL-encoded', async () => {
      let seenUrl = null;
      const fakeApi = async (url) => { seenUrl = url; return { ok: true, receipt: null, statusSurface: { status: 'none', label: 'x', tone: 'none' } }; };
      const result = await loadFn(fakeApi)('my project', 'asg 1', 3);
      assert.equal(seenUrl, '/api/sessions/my%20project/chunk-boundary?assignmentId=asg%201&chunkNumber=3');
      assert.equal(result.status, 'none');
    });

    it('answers null, never throws, when the read fails', async () => {
      const fakeApi = async () => null;
      const result = await loadFn(fakeApi)('p', 'a', 1);
      assert.equal(result, null);
    });
  });
});

describe('public/session.js call sites for chunk-boundary-ui.js (v5.67.0 FEED-FORWARD 01)', () => {
  const SESSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
  const CHUNK_BOUNDARY_UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'chunk-boundary-ui.js'), 'utf8');

  /**
   * Find a descendant by id by walking `childNodes` — the mini-dom's `byId`
   * registry is populated only by `makeDocument`'s own initial ids and by
   * `withIdParsingInnerHTML`'s string-parsing (test/_mini-dom.js's
   * documented limits), never by a bare `createElement` + manual `.id =`
   * (how `_chunkBoundaryLookupContainer`'s own OUTER element is built — its
   * children, assigned via one `innerHTML =` string, are covered by the
   * upgraded `createElement` below instead).
   * @param {object} parent
   * @param {string} id
   * @returns {object|null}
   */
  function findChildById(parent, id) {
    for (const child of parent.childNodes) {
      if (child.id === id) return child;
      const deeper = findChildById(child, id);
      if (deeper) return deeper;
    }
    return null;
  }

  /**
   * Build a sandbox with the REAL chunk-boundary-ui.js loaded, and the REAL
   * `_chunkBoundaryLookupContainer` + `_checkChunkBoundaryLookup` lifted
   * from session.js's own source. `document.createElement` is upgraded so
   * every element it hands back parses its OWN later `innerHTML =` the same
   * way a real browser would — `_chunkBoundaryLookupContainer` builds its
   * whole control row that way in one shot, not through nested
   * `createElement` calls.
   * @param {object} [overrides] - `{api}`.
   * @returns {{doc: object, mount: Function}}
   */
  function loadLifted(overrides = {}) {
    const { doc, ids } = makeDocument(['wrapDrawerBody']);
    void ids;
    const realCreateElement = doc.createElement;
    doc.createElement = (tag) => {
      const el = withIdParsingInnerHTML(realCreateElement(tag), doc);
      // A real `document.getElementById` finds a created element once its
      // `.id` is set AND it is connected to the live tree; this mini-dom's
      // `byId` map is otherwise populated only by `makeDocument`'s initial
      // ids and by `withIdParsingInnerHTML`'s own string-parsing, never by
      // a plain `el.id = '...'` on a freshly created element — which is
      // exactly how `_chunkBoundaryLookupContainer`'s OWN outer element is
      // built. A real setter here is what makes `getElementById` (and so
      // this function's own idempotence check) see it on a later call.
      let _id = '';
      Object.defineProperty(el, 'id', {
        configurable: true,
        get() { return _id; },
        set(v) { _id = String(v); doc._register(el); }
      });
      return el;
    };
    const sandbox = {
      console,
      document: doc,
      projectName: 'proj-1',
      api: overrides.api || (async () => null),
      esc: loadEsc('landing.js')
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CHUNK_BOUNDARY_UI_SRC, sandbox);
    vm.runInContext(
      `${liftDeclaration(SESSION_SRC, 'function _chunkBoundaryLookupContainer(')}\n`
      + `${liftDeclaration(SESSION_SRC, 'async function _checkChunkBoundaryLookup(')}\n`
      + 'globalThis._chunkBoundaryLookupContainer = _chunkBoundaryLookupContainer;',
      sandbox
    );
    return { doc, mount: sandbox._chunkBoundaryLookupContainer };
  }

  it('builds the lookup form with both inputs, the button, and a result slot', () => {
    const { doc, mount } = loadLifted();
    mount();
    const container = findChildById(doc.body, 'wrapDrawerChunkBoundaryLookup');
    assert.ok(container, 'the container must be created');
    assert.ok(doc.getElementById('wrapDrawerCbAssignmentId'), 'assignment id input must be registered');
    assert.ok(doc.getElementById('wrapDrawerCbChunkNumber'), 'chunk number input must be registered');
    assert.ok(doc.getElementById('wrapDrawerCbCheckBtn'), 'the Check button must be registered');
    assert.ok(doc.getElementById('wrapDrawerCbResult'), 'the result slot must be registered');
  });

  it('is idempotent: mounting twice does not rebuild or double-bind the control', () => {
    const { doc, mount } = loadLifted();
    const first = mount();
    const second = mount();
    assert.equal(first, second, 'the same container comes back on a second mount');
  });

  it('clicking Check with both fields filled calls fetchChunkBoundaryStatus and renders the real badge', async () => {
    const seen = [];
    const { doc, mount } = loadLifted({
      api: async (url) => { seen.push(url); return { ok: true, receipt: null, statusSurface: { status: 'ready_to_clear', label: 'Ready to clear', tone: 'info', chunkNumber: 3, superseded: false } }; }
    });
    mount();
    doc.getElementById('wrapDrawerCbAssignmentId').value = 'asg-1';
    doc.getElementById('wrapDrawerCbChunkNumber').value = '3';
    doc.getElementById('wrapDrawerCbCheckBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(seen.length, 1);
    assert.equal(seen[0], '/api/sessions/proj-1/chunk-boundary?assignmentId=asg-1&chunkNumber=3');
    assert.match(doc.getElementById('wrapDrawerCbResult').innerHTML, />Ready to clear</);
    assert.match(doc.getElementById('wrapDrawerCbResult').innerHTML, /title="Chunk 3"/);
  });

  it('refuses to call the API with a blank assignment id or chunk number', async () => {
    const seen = [];
    const { doc, mount } = loadLifted({ api: async (url) => { seen.push(url); return null; } });
    mount();
    doc.getElementById('wrapDrawerCbAssignmentId').value = '';
    doc.getElementById('wrapDrawerCbChunkNumber').value = '3';
    doc.getElementById('wrapDrawerCbCheckBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(seen.length, 0, 'a blank assignment id must never reach the API');
    assert.match(doc.getElementById('wrapDrawerCbResult').textContent, /Enter an assignment id/);
  });

  it('reports "No receipt found" when the real lookup answers null', async () => {
    const { doc, mount } = loadLifted({ api: async () => ({ ok: true, receipt: null, statusSurface: null }) });
    mount();
    doc.getElementById('wrapDrawerCbAssignmentId').value = 'asg-1';
    doc.getElementById('wrapDrawerCbChunkNumber').value = '1';
    doc.getElementById('wrapDrawerCbCheckBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 0));

    assert.match(doc.getElementById('wrapDrawerCbResult').textContent, /No receipt found/);
  });
});
