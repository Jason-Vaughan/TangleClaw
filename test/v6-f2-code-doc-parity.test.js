'use strict';

// v6.1 (#2998, V6-28 / F2, Car V61-W1-C): the code-to-doc parity generator
// and drift detector, against P22 §2.3's acceptance fixtures (fake routes in
// comments/strings/regex/templates, dynamic registration, defaults that
// keep false/null/array distinct, secret-free engine rows, marker faults,
// order independence, all-or-nothing extraction) plus one read-only pass
// over this repository's real sources.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const f2 = require('../lib/v6/f2-code-doc-parity');

const ROOT = path.join(__dirname, '..');

describe('tokenizeJs', () => {
  it('tells comments, strings, templates and regex literals apart from code', () => {
    const toks = f2.tokenizeJs([
      '// route("GET", "/comment")',
      '/* route("GET", "/block") */',
      'const s = "route(\'GET\', \'/string\')";',
      'const r = /route\\("GET"/g;',
      'const t = `a ${b + `inner ${c}`} d`;',
      'const q = x / y / z;'
    ].join('\n'));
    const types = toks.map((t) => t.type);
    assert.ok(!toks.some((t) => t.type === 'ident' && t.value === 'route'));
    assert.equal(types.filter((t) => t === 'regex').length, 1);
    assert.equal(toks.filter((t) => t.type === 'template' && t.dynamic).length, 2);
    assert.equal(toks.filter((t) => t.type === 'punct' && t.value === '/').length, 2, 'division stays division');
  });

  it('records the line each token starts on', () => {
    const toks = f2.tokenizeJs('a\n/* x\ny */\nb\n`t\nu`\nc');
    assert.deepEqual(toks.map((t) => `${t.value}@${t.line}`), ['a@1', 'b@4', 't\nu@5', 'c@7']);
  });

  it('fails closed on anything it cannot close', () => {
    for (const src of ['"abc', '\'a\nb\'', '/* open', '`open', '`a ${b`', 'x = /unterminated\n/']) {
      assert.throws(() => f2.tokenizeJs(src, 'f.js'), (err) => err instanceof f2.DocParityError && err.code === 'EXTRACTOR_FAILED', src);
    }
  });
});

describe('extractRoutes', () => {
  const file = (source, name = 'server.js') => ({ file: name, source });

  it('finds literal routes and ignores fakes in comments, strings, regex and templates', () => {
    const src = [
      "route('GET', '/api/real', h);",
      "route(\"POST\", `/api/static-template`, h);",
      "// route('GET', '/api/comment', h);",
      "const s = \"route('GET', '/api/string', h)\";",
      "const r = /route\\('GET', '\\/api\\/regex'/;",
      "const t = `route('GET', '/api/template', h)`;",
      'function route(method, pattern, handler) {}',
      "obj.route('GET', '/api/method-call', h);"
    ].join('\n');
    const out = f2.extractRoutes([file(src)]);
    assert.deepEqual(out.rows, [
      { method: 'GET', path: '/api/real', file: 'server.js' },
      { method: 'POST', path: '/api/static-template', file: 'server.js' }
    ]);
    assert.deepEqual(out.flags, []);
  });

  it('flags a computed registration, and accepts it once its routes are declared', () => {
    const src = "for (const e of R) {\n  route(e.method, e.path, h);\n}\nroute('GET', `${prefix}/x`, h);";
    const flagged = f2.extractRoutes([file(src)]);
    assert.deepEqual(flagged.flags.map((x) => `${x.code}@${x.line}`), ['DYNAMIC_ROUTE_REGISTRATION@2', 'DYNAMIC_ROUTE_REGISTRATION@4']);
    assert.ok(flagged.flags.every((x) => x.severity === 'blocking'));
    const declared = f2.extractRoutes([file(src)], {
      declared: { 'server.js:2': [{ method: 'get', path: '/api/bridge/a' }], 'server.js:4': [{ method: 'GET', path: '/api/p/x' }] }
    });
    assert.deepEqual(declared.flags, []);
    assert.deepEqual(declared.rows.map((r) => `${r.method} ${r.path}`), ['GET /api/bridge/a', 'GET /api/p/x']);
  });

  it('reports a declaration that matches nothing, so a stale one cannot linger', () => {
    const out = f2.extractRoutes([file("route('GET', '/a', h);")], { declared: { 'server.js:99': [] } });
    assert.deepEqual(out.flags.map((x) => x.code), ['DECLARATION_UNUSED']);
  });

  it('treats a declared helper as a registration', () => {
    const out = f2.extractRoutes([file("controlRoute('POST', '/api/control/hold', fn);")], { helpers: ['controlRoute'] });
    assert.deepEqual(out.rows, [{ method: 'POST', path: '/api/control/hold', file: 'server.js' }]);
  });

  it('flags duplicate and malformed routes', () => {
    const out = f2.extractRoutes([
      file("route('GET', '/a', h);\nroute('FETCH', '/b', h);\nroute('GET', 'c', h);"),
      file("route('get', '/a', h);", 'lib/routes/x.js')
    ]);
    assert.deepEqual(out.flags.map((x) => x.code).sort(), ['DUPLICATE_ROUTE', 'MALFORMED_ROUTE', 'MALFORMED_ROUTE']);
    assert.deepEqual(out.rows.map((r) => r.path), ['/a']);
  });

  it('keeps :params verbatim and sorts by path then method regardless of file order', () => {
    const a = file("route('POST', '/api/p/:id', h);\nroute('GET', '/api/p/:id', h);", 'a.js');
    const b = file("route('GET', '/api/a', h);", 'b.js');
    const one = f2.extractRoutes([a, b]);
    const two = f2.extractRoutes([b, a]);
    assert.deepEqual(one, two);
    assert.deepEqual(one.rows.map((r) => `${r.method} ${r.path}`), ['GET /api/a', 'GET /api/p/:id', 'POST /api/p/:id']);
  });
});

describe('extractCli', () => {
  const entry = (id, over = {}) => ({ id, usage: `tc ${id}`, summary: 's', audience: 'pane', primed: true, subverbs: [{ id: 'b' }, { id: 'a' }, { id: null }], ...over });

  it('produces sorted rows with sorted named subverbs', () => {
    const out = f2.extractCli([entry('zeta'), entry('alpha')]);
    assert.deepEqual(out.rows.map((r) => r.id), ['alpha', 'zeta']);
    assert.equal(out.rows[0].subverbs, 'a, b');
  });

  it('fails extraction when the manifest shape changes or an id repeats', () => {
    const changed = (m) => assert.throws(() => f2.extractCli(m), (e) => e.code === 'CLI_MANIFEST_CHANGED');
    changed({});
    changed([{ ...entry('a'), extra: 1 }]);
    changed([entry('a'), entry('a')]);
  });
});

describe('flattenDefaults', () => {
  it('keeps false, null, 0, arrays and empty objects distinct and sorted', () => {
    const out = f2.flattenDefaults({ b: { z: false, y: null }, a: 0, c: ['x', 'y'], d: {} });
    assert.deepEqual(out.rows, [
      { key: 'a', value: '0' },
      { key: 'b.y', value: 'null' },
      { key: 'b.z', value: 'false' },
      { key: 'c', value: '["x","y"]' },
      { key: 'd', value: '{}' }
    ]);
    assert.deepEqual(out.flags, []);
  });

  it('flags a value whose documented default cannot be stated', () => {
    const out = f2.flattenDefaults({ fn: () => 1, u: undefined, when: new Date(0) });
    assert.deepEqual(out.flags.map((x) => `${x.code}:${x.detail}`).sort(), [
      'DYNAMIC_DEFAULT:fn is a function', 'DYNAMIC_DEFAULT:u is a undefined', 'DYNAMIC_DEFAULT:when is not a plain object'
    ]);
  });
});

describe('extractEngines', () => {
  const profile = (over = {}) => ({
    id: 'alpha', name: 'Alpha', interactionModel: 'session', defaultLaunchMode: 'default',
    launchModes: { plan: {}, default: {} },
    capabilities: { b: true, a: { supported: false }, c: null, d: { mode: 'x' } },
    launch: { env: { SECRET_TOKEN: 'sk-should-never-appear' }, args: ['--danger'] },
    ...over
  });

  it('projects stable fields and never leaks launch env or argv', () => {
    const out = f2.extractEngines([{ file: 'data/engines/alpha.json', profile: profile() }]);
    assert.deepEqual(out.rows, [{
      id: 'alpha', name: 'Alpha', interactionModel: 'session', defaultLaunchMode: 'default',
      launchModes: 'default, plan', capabilities: 'a=no, b=yes, c=null, d=configured'
    }]);
    assert.ok(!JSON.stringify(out).includes('sk-should-never-appear'));
    assert.ok(!JSON.stringify(out).includes('--danger'));
  });

  it('flags a field neither projected nor listed as omitted, instead of silently dropping it', () => {
    const out = f2.extractEngines([{ file: 'data/engines/alpha.json', profile: profile({ brandNew: 1 }) }], { omittedFields: ['launch'] });
    assert.deepEqual(out.flags.map((x) => `${x.code}:${x.severity}:${x.detail}`),
      ['ENGINE_PROFILE_FIELD_REVIEW:info:profile field "brandNew" is neither projected nor listed as deliberately omitted']);
  });

  it('fails extraction on an id/filename mismatch or a missing field', () => {
    assert.throws(() => f2.extractEngines([{ file: 'data/engines/beta.json', profile: profile() }]), f2.DocParityError);
    assert.throws(() => f2.extractEngines([{ file: 'data/engines/alpha.json', profile: profile({ name: 1 }) }]), f2.DocParityError);
  });
});

describe('renderBlock / compareBlock', () => {
  const rows = [{ method: 'GET', path: '/a|b`c\\d\ne', file: 'server.js' }];

  it('escapes cells and renders byte-identically for the same rows', () => {
    const block = f2.renderBlock('ROUTES', rows, ['server.js']);
    assert.equal(block, f2.renderBlock('ROUTES', rows, ['server.js']));
    assert.match(block, /\| GET \| \/a\\\|b\\`c\\\\d e \| server\.js \|/);
    assert.ok(block.startsWith(f2.markers('ROUTES').begin));
    assert.ok(block.endsWith(f2.markers('ROUTES').end));
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(block), 'no timestamps');
  });

  it('matches only between markers, ignoring prose and CRLF outside', () => {
    const block = f2.renderBlock('ROUTES', rows, ['server.js']);
    const doc = `# API\r\nHuman prose.\r\n\r\n${block.replace(/\n/g, '\r\n')}\r\nMore prose.`;
    assert.equal(f2.compareBlock(doc, 'ROUTES', block).status, 'match');
  });

  it('reports drift with a line diff, and marker faults by name', () => {
    const block = f2.renderBlock('ROUTES', rows, ['server.js']);
    const changed = f2.renderBlock('ROUTES', [...rows, { method: 'POST', path: '/z', file: 'server.js' }], ['server.js']);
    const drift = f2.compareBlock(`x\n${block}\ny`, 'ROUTES', changed);
    assert.equal(drift.status, 'drift');
    assert.ok(drift.diff.includes('+ | POST | /z | server.js |'));
    assert.equal(f2.compareBlock('no markers', 'ROUTES', block).status, 'missing-marker');
    const { begin, end } = f2.markers('ROUTES');
    assert.equal(f2.compareBlock(`${end}\n${begin}`, 'ROUTES', block).status, 'missing-marker');
    assert.equal(f2.compareBlock(`${block}\n${block}`, 'ROUTES', block).status, 'duplicate-marker');
  });
});

describe('checkParity', () => {
  const families = () => ({
    ROUTES: { rows: [{ method: 'GET', path: '/a', file: 'server.js' }], flags: [], sources: ['server.js'] },
    ENGINES: { rows: [], flags: [{ code: 'ENGINE_PROFILE_FIELD_REVIEW', severity: 'info', source: 'x.json', line: null, detail: 'd' }], sources: [] }
  });

  it('exits 0 when every block matches, still reporting informational flags', () => {
    const fam = families();
    const docs = {
      'docs/api-reference.md': `prose\n${f2.renderBlock('ROUTES', fam.ROUTES.rows, fam.ROUTES.sources)}\n`,
      'docs/engine-guide.md': f2.renderBlock('ENGINES', [], [])
    };
    const out = f2.checkParity(families, docs);
    assert.equal(out.exitCode, 0);
    assert.equal(out.ok, true);
    assert.equal(out.schema, f2.REVIEW_SCHEMA);
    assert.deepEqual(out.flags.map((x) => x.code), ['ENGINE_PROFILE_FIELD_REVIEW']);
  });

  it('exits 1 on drift, a missing marker, or a missing target, never writing a doc', () => {
    const docs = { 'docs/api-reference.md': 'no markers here' };
    const frozen = JSON.stringify(docs);
    const out = f2.checkParity(families, docs);
    assert.equal(out.exitCode, 1);
    assert.deepEqual(out.flags.map((x) => x.code), ['ENGINE_PROFILE_FIELD_REVIEW', 'MISSING_MARKER', 'TARGET_MISSING']);
    assert.equal(JSON.stringify(docs), frozen);
    assert.ok(out.blocks.ROUTES, 'the proposed block is still returned for review');
  });

  it('exits 2 with no blocks at all when any extractor fails', () => {
    const out = f2.checkParity(() => { f2.tokenizeJs('"open', 'server.js'); }, {});
    assert.equal(out.exitCode, 2);
    assert.deepEqual(out.blocks, {});
    assert.equal(out.error.code, 'EXTRACTOR_FAILED');
  });

  it('lets a non-parity error propagate as the bug it is', () => {
    assert.throws(() => f2.checkParity(() => { throw new RangeError('bug'); }, {}), RangeError);
  });
});

describe('extractRepository (this repo, read-only)', () => {
  it('extracts all four families from the real sources', () => {
    const fam = f2.extractRepository(ROOT);
    assert.deepEqual(Object.keys(fam).sort(), [...f2.FAMILIES].sort());
    assert.ok(fam.CLI.rows.some((r) => r.id === 'whoami'));
    assert.ok(fam.ROUTES.rows.some((r) => r.method === 'GET' && r.path === '/api/health'));
    assert.ok(fam['PROJECT-CONFIG'].rows.some((r) => r.key === 'engine'));
    assert.deepEqual(fam.ENGINES.rows.map((r) => r.id), ['aider', 'antigravity', 'claude', 'codex', 'openclaw']);
    assert.ok(fam.ENGINES.flags.length > 0 && fam.ENGINES.flags.every((x) => x.code === 'ENGINE_PROFILE_FIELD_REVIEW' && x.severity === 'info'),
      'with no omission list, every unprojected profile field is surfaced for review, never silently dropped');
    assert.deepEqual(fam['PROJECT-CONFIG'].flags, []);
  });

  it('clears the engine review flags once the reviewed omission list names every unprojected field', () => {
    const omitted = ['command', 'configFormat', 'coAuthorFormat', 'commands', 'install', 'detection', 'launch',
      'persistent', 'statusPage', 'silentPrimeScript', 'silentRulesScript', 'models', 'effort',
      'errorPatterns', 'pickerHidden', 'remote'];
    const fam = f2.extractRepository(ROOT, { engineOmittedFields: omitted });
    assert.deepEqual(fam.ENGINES.flags, []);
    assert.ok(!JSON.stringify(fam.ENGINES.rows).includes('CLAUDE_CODE_ARTIFACT_AUTO_OPEN'), 'launch env never reaches a row');
  });

  it('surfaces computed route registrations instead of claiming a complete table', () => {
    const fam = f2.extractRepository(ROOT);
    assert.ok(fam.ROUTES.flags.some((x) => x.code === 'DYNAMIC_ROUTE_REGISTRATION' && x.source === 'server.js'));
  });

  it('turns an unreadable source into extractor failure, not a partial result', () => {
    const out = f2.checkParity(() => f2.extractRepository(ROOT, {
      readdir: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }
    }), {});
    assert.equal(out.exitCode, 2);
    assert.deepEqual(out.blocks, {});
  });
});
