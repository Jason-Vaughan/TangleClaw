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
const { loadEsc, liftDeclaration } = require('./helpers/lift');

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
