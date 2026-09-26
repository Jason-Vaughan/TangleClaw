'use strict';

/*
 * #1768 — once a lease owner is marked "Not a project" (ownerKind external,
 * #1381), the ports panel says so and offers the way back. Before, the mark was
 * invisible on the dashboard and only a raw POST /api/ports/owner-kind undid it.
 *
 * Traced end to end against the real server: the panel is rendered from what
 * GET /api/ports returns, the undo button's argument is decoded off the rendered
 * HTML, and the shipped handler posts it.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const store = require('../lib/store');
const { setLevel } = require('../lib/logger');

setLevel('error');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const ui = read('ui.js');
const landing = read('landing.js');

/**
 * Slice a function declaration out of source text by brace-matching.
 *
 * @param {string} src - File source text.
 * @param {string} decl - Declaration head, e.g. `function foo(`.
 * @returns {string} The declaration through its balanced closing brace.
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

/**
 * Decode entities the way the HTML parser does to an attribute value.
 *
 * @param {string} s - Raw attribute text.
 * @returns {string} Decoded text.
 */
function decodeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

describe('ports panel: show and undo "Not a project" (#1768)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ownerkind-panel-'));
    store._setBasePath(tmpDir);
    store.init();
    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A JSON request against the real server, standing in for the page's api.
   *
   * @param {string} method - HTTP method.
   * @param {string} urlPath - Path.
   * @param {object} [body] - JSON body.
   * @returns {Promise<object|null>} Parsed body, or null on an error status.
   */
  function call(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
          resolve(res.statusCode < 400 ? data : null);
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Build the page slice under test from the shipped sources.
   *
   * @returns {{page: object, grid: object, state: object, refreshes: string[]}}
   */
  function makePage() {
    const grid = { innerHTML: '' };
    const count = { textContent: '' };
    const state = { ports: [], portGroupsOpen: {} };
    const refreshes = [];
    const src = [
      liftFunction(landing, 'function esc('),
      liftFunction(landing, 'function jsArg('),
      liftFunction(landing, 'async function loadPorts('),
      liftFunction(ui, 'function renderPorts('),
      liftFunction(ui, 'async function markLeaseOwnerProject(')
    ].join('\n');
    const page = new Function('state', 'document', 'api', 'apiMutate', 'checkPortImports', `
      ${src}
      return { loadPorts, markLeaseOwnerProject };
    `)(
      state,
      { getElementById: (id) => (id === 'portsGrid' ? grid : id === 'portsCount' ? count : null) },
      (url) => call('GET', url),
      (url, method, body) => call(method, url, body),
      () => refreshes.push('checkPortImports')
    );
    return { page, grid, state, refreshes };
  }

  /**
   * The port group in the rendered panel for one owner name.
   *
   * @param {string} html - Panel HTML.
   * @param {string} name - Owner name as rendered (escaped).
   * @returns {string} That group's markup.
   */
  function groupOf(html, name) {
    const groups = html.split('<div class="port-group">').slice(1);
    const g = groups.find((x) => x.includes(`<span class="port-group-name">${name}</span>`));
    assert.ok(g, `a group for ${name} must render`);
    return g;
  }

  beforeEach(() => {
    for (const l of store.portLeases.list()) {
      store.portLeases.release(l.port, l.host);
    }
  });

  it('badges an external owner, offers the undo, and leaves a project owner alone', async () => {
    store.portLeases.lease({ port: 5432, project: "O'Brien DB", service: 'postgresql@14', permanent: true });
    store.portLeases.lease({ port: 3290, project: 'SomeProject', service: 'dev', permanent: true });
    store.portLeases.setOwnerKind("O'Brien DB", 'external');

    const { page, grid } = makePage();
    await page.loadPorts();

    const external = groupOf(grid.innerHTML, 'O&#39;Brien DB');
    assert.match(external, /class="port-owner-kind"[^>]*>Not a project</);
    assert.match(external, /onclick="[^"]*markLeaseOwnerProject\(/);
    // Enter on the button must not also reach the row's keydown, which folds
    // the group and cancels the press.
    assert.match(external, /markLeaseOwnerProject\([^"]*"\s*onkeydown="event\.stopPropagation\(\)"/);

    const project = groupOf(grid.innerHTML, 'SomeProject');
    assert.doesNotMatch(project, /Not a project/);
    assert.doesNotMatch(project, /markLeaseOwnerProject/);
  });

  it('the rendered undo button sets the owner back to project on the server and redraws', async () => {
    store.portLeases.lease({ port: 5432, project: "O'Brien DB", service: 'postgresql@14', permanent: true });
    store.portLeases.lease({ port: 5433, project: "O'Brien DB", service: 'replica', permanent: true });
    store.portLeases.setOwnerKind("O'Brien DB", 'external');

    const { page, grid, refreshes } = makePage();
    await page.loadPorts();

    const onclick = decodeAttr(groupOf(grid.innerHTML, 'O&#39;Brien DB')
      .match(/onclick="([^"]*markLeaseOwnerProject\([^"]*)"/)[1]);
    // The toggle row owns the click; the undo must not also fold the group.
    assert.match(onclick, /^event\.stopPropagation\(\); markLeaseOwnerProject\(/);
    const argSrc = onclick.match(/markLeaseOwnerProject\((.*)\)$/)[1];
    await page.markLeaseOwnerProject(JSON.parse(argSrc));

    assert.equal(store.portLeases.get(5432).ownerKind, 'project', 'the server recorded it');
    assert.equal(store.portLeases.get(5433).ownerKind, 'project', 'for every lease under the name');
    assert.doesNotMatch(grid.innerHTML, /Not a project/, 'the panel redrew without the badge');
    assert.deepEqual(refreshes, ['checkPortImports'], 'the import banner is re-checked, since the owner is offered again');
  });

  it('leaves the badge in place when the server refuses', async () => {
    store.portLeases.lease({ port: 5432, project: 'Gone', service: 'x', permanent: true });
    store.portLeases.setOwnerKind('Gone', 'external');
    const { page, grid, refreshes } = makePage();
    await page.loadPorts();
    store.portLeases.release(5432);

    await page.markLeaseOwnerProject('Gone');
    assert.match(grid.innerHTML, /Not a project/, 'a failed undo must not pretend it worked');
    assert.deepEqual(refreshes, []);
  });
});
