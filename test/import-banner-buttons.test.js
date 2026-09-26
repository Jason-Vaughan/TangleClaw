'use strict';

/*
 * #1383 — the port-lease import banner's Ignore button had never worked.
 *
 * `renderImportBanner` built ONE escaped value and fed it to both buttons,
 * but they took different argument shapes. The shared double-stringify handed
 * Ignore the name wrapped in literal quotes, which never matched the canonical
 * form, so the banner returned forever. Every button now receives a real JS
 * value through `jsArg` (#1384): Import the array of names, Ignore and Not a
 * project the raw name.
 *
 * These assert the ROUND TRIP rather than the spelling of the source: each
 * onclick is decoded the way a browser would, and the argument the handler
 * would actually receive is compared against what that handler expects. A
 * test matching the source text would pass on any encoding that merely looked
 * different, which is the mistake that let this ship.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Slice a function declaration out of source text by brace-matching.
 * Same construction as `liftFunction` in test/landing-unreachable-state.test.js —
 * the point is to execute the SHIPPED code rather than a copy of it, so a change
 * to the page cannot leave this suite passing against a stale duplicate.
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
    render = new Function('importable', 'esc', 'jsArg', `
      ${body}
    `);
  });

  const esc = (str) => typeof str !== 'string' ? '' : str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // The shipped `jsArg`, lifted from landing.js and bound to the `esc` above.
  const landingSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
  const jsArg = new Function('esc', `${liftFunction(landingSrc, 'function jsArg(')}\nreturn jsArg;`)(esc);

  const onclicks = (name) => {
    const html = render([{ name, ports: [{ port: 5432, service: 'postgresql@14' }], conflicts: [] }], esc, jsArg);
    return [...html.matchAll(/onclick="([^"]*)"/g)].map(m => unescapeHtml(m[1]));
  };

  it('Ignore receives the RAW project name, not a JSON-encoded one', () => {
    // The defect: it received `"Homebrew"` including the quote characters, so
    // the ignore set never matched the canonical name and the banner returned.
    const ignore = onclicks('Homebrew').find(o => o.startsWith('ignoreLeaseProject('));
    assert.ok(ignore, 'the Ignore button must exist');
    assert.equal(argumentOf(ignore), 'Homebrew');
  });

  it('Import receives the array of names it posts (#1384)', () => {
    // The other half of the contract, pinned so Import and Ignore cannot drift
    // apart again: Import takes an ARRAY, Ignore a single raw name.
    const imp = onclicks('Homebrew').find(o => o.startsWith('importLeaseProjects('));
    assert.ok(imp, 'the Import button must exist');
    assert.deepEqual(argumentOf(imp), ['Homebrew']);
  });

  it('Import All carries the same contract as Import (#1383 R-1)', () => {
    // Import All lives outside the per-item template, so the first two tests do
    // not reach it. Without this, the wrong follow-up the change-log anticipates
    // — "make the encodings consistent" — could be applied there and ship green
    // while Import All silently no-ops.
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    const m = ui.match(/onclick="importLeaseProjects\((\$\{[^}]*\}[^"]*?)\)">Import All/);
    assert.ok(m, 'the Import All button must still be findable');

    const allNames = ['Homebrew', "Odd\"Name"];
    const attr = new Function('esc', 'jsArg', 'allNames', 'return `' + m[1] + '`;')(esc, jsArg, allNames);
    // `attr` is the raw attribute text; decode it as the parser would, then read
    // the argument the handler receives.
    assert.deepEqual(argumentOf('importLeaseProjects(' + unescapeHtml(attr) + ')'), allNames);
  });

  it('the CONSUMER side accepts what the button sends, end to end (#1383 R-13)', () => {
    // The producer tests above pin what the button emits. This one executes the
    // SHIPPED consumer — ignoreLeaseProject, getIgnoredLeaseProjects,
    // _canonicalProjectName and checkPortImports lifted out of landing.js — so
    // the two halves are asserted against each other rather than against a
    // literal I typed. Without it, the same encoding error reintroduced on the
    // consumer side reopens #1383 with this suite still green.
    const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
    const src = [
      liftFunction(landing, 'function _canonicalProjectName('),
      liftFunction(landing, 'function getIgnoredLeaseProjects('),
      liftFunction(landing, 'function ignoreLeaseProject('),
      liftFunction(landing, 'function checkPortImports(')
    ].join('\n');

    const make = () => {
      const store = new Map();
      const rendered = [];
      const scope = new Function('localStorage', 'document', 'state', 'renderImportBanner', `
        ${src}
        return { ignoreLeaseProject, checkPortImports, getIgnoredLeaseProjects };
      `);
      const api = scope(
        { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
        { getElementById: () => null },
        {
          ports: [{ port: 5432, project: 'Homebrew', service: 'postgresql@14' }],
          projects: [{ name: 'TangleClaw-Builder' }],
          openclawConnections: []
        },
        (importable) => rendered.push(importable)
      );
      return { api, rendered };
    };

    // The name the FIXED button actually sends suppresses the banner — and that
    // name is DECODED OFF THE RENDERED BUTTON, not typed here. Typing it would
    // assert the consumer against my expectation of the producer rather than
    // against the producer itself, which is the loop this test exists to close.
    const sent = argumentOf(
      onclicks('Homebrew').find(o => o.startsWith('ignoreLeaseProject('))
    );
    const good = make();
    good.api.ignoreLeaseProject(sent);
    good.rendered.length = 0;
    good.api.checkPortImports();
    assert.equal(good.rendered.length, 0, 'ignoring the raw name must suppress the banner');

    // The value the BROKEN producer emitted does not match — the defect, pinned.
    // Built by applying the old double pass, so it tracks the real bug shape
    // rather than a hand-written approximation of it.
    const bad = make();
    bad.api.ignoreLeaseProject(JSON.stringify(sent));
    bad.rendered.length = 0;
    bad.api.checkPortImports();
    assert.equal(bad.rendered.length, 1, 'a quote-wrapped name must NOT match — that was the bug');
  });

  it('a name carrying quotes survives both round trips intact', () => {
    // `esc` turns a literal quote into &quot;, so a name containing one is the
    // case where an encoding error is invisible in the happy path.
    const name = 'Odd"Name';
    const [imp, ign] = ['importLeaseProjects(', 'ignoreLeaseProject(']
      .map(p => onclicks(name).find(o => o.startsWith(p)));
    assert.equal(argumentOf(ign), name);
    assert.deepEqual(argumentOf(imp), [name]);
  });
  it('the Import button\'s argument reaches the import route as the names array (#1384)', async () => {
    // Producer and consumer asserted against each other: the argument decoded
    // off the rendered button is handed to the SHIPPED importLeaseProjects, and
    // the body it posts must carry exactly those names.
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    const posts = [];
    const importLeaseProjects = new Function(
      'apiMutate', 'document', 'dismissImportBanner', 'loadProjects', 'checkPortImports',
      `${liftFunction(ui, 'async function importLeaseProjects(')}\nreturn importLeaseProjects;`
    )(
      async (url, method, body) => { posts.push({ url, method, body }); return {}; },
      { getElementById: () => null },
      () => {}, async () => {}, () => {}
    );
    const name = "O'Brien \"&\" Co";
    const sent = argumentOf(onclicks(name).find(o => o.startsWith('importLeaseProjects(')));
    await importLeaseProjects(sent);
    assert.deepEqual(posts, [{ url: '/api/projects/import', method: 'POST', body: { names: [name] } }]);
  });

  it('Not a project receives the RAW name, like Ignore (#1381)', () => {
    const mark = onclicks('Odd"Name').find(o => o.startsWith('markLeaseOwnerExternal('));
    assert.ok(mark, 'the Not a project button must exist');
    assert.equal(argumentOf(mark), 'Odd"Name');
  });
});

describe('Not a project, traced widget → collector → POST → server (#1381)', () => {
  const http = require('node:http');
  const os = require('node:os');
  const store = require('../lib/store');
  const { setLevel } = require('../lib/logger');
  setLevel('error');
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-notaproject-'));
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

  /** A JSON request against the real server, standing in for the page's `api`. */
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

  it('the button the banner renders marks the lease external on the server and drops it from the banner', async () => {
    store.portLeases.lease({ port: 5432, project: 'Homebrew', service: 'postgresql@14', permanent: true });

    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
    const src = [
      liftFunction(landing, 'function _canonicalProjectName('),
      liftFunction(landing, 'function getIgnoredLeaseProjects('),
      liftFunction(landing, 'function checkPortImports('),
      liftFunction(ui, 'async function markLeaseOwnerExternal(')
    ].join('\n');

    const state = { ports: [], projects: [{ name: 'SomeProject' }], openclawConnections: [] };
    const rendered = [];
    const loadPorts = async () => { state.ports = (await call('GET', '/api/ports')).leases; };
    const page = new Function('localStorage', 'document', 'state', 'renderImportBanner', 'apiMutate',
      'dismissImportBanner', 'loadPorts', `
        ${src}
        return { checkPortImports, markLeaseOwnerExternal };
      `)(
      { getItem: () => null, setItem: () => {} },
      { getElementById: () => null },
      state,
      (importable) => rendered.push(importable),
      (url, method, body) => call(method, url, body),
      () => {},
      loadPorts
    );

    await loadPorts();
    page.checkPortImports();
    assert.equal(rendered.length, 1, 'precondition: the unregistered owner is offered for import');
    assert.equal(rendered[0][0].name, 'Homebrew');

    // The argument comes off the rendered button, not typed here.
    const html = (() => {
      const start = ui.indexOf('const details = importable.map');
      const end = ui.indexOf(".join('');", start);
      const esc = (str) => typeof str !== 'string' ? '' : str
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const landingSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
      const jsArg = new Function('esc', `${liftFunction(landingSrc, 'function jsArg(')}\nreturn jsArg;`)(esc);
      return new Function('importable', 'esc', 'jsArg', ui.slice(start, end + ".join('')".length) + '; return details;')(rendered[0], esc, jsArg);
    })();
    const onclick = [...html.matchAll(/onclick="([^"]*)"/g)].map(m => unescapeHtml(m[1]))
      .find(o => o.startsWith('markLeaseOwnerExternal('));
    rendered.length = 0;
    await page.markLeaseOwnerExternal(argumentOf(onclick));

    assert.equal(store.portLeases.get(5432).ownerKind, 'external', 'the server recorded it');
    assert.ok(store.portLeases.get(5432), 'and kept the lease');
    assert.equal(rendered.length, 0, 'the refreshed banner no longer lists it');
  });
});
