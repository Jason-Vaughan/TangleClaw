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

  it('flags an accessor without ever invoking it (PRR-A B2)', () => {
    const obj = { plain: 1 };
    Object.defineProperty(obj, 'computed', { enumerable: true, get() { throw new Error('getter must not run'); } });
    const out = f2.flattenDefaults(obj);
    assert.deepEqual(out.rows, [{ key: 'plain', value: '1' }]);
    assert.deepEqual(out.flags.map((x) => x.detail), ['computed is an accessor property']);
  });

  it('flags an array leaf or symbol key JSON would silently misstate (PRR-A B2)', () => {
    const out = f2.flattenDefaults({ list: ['a', () => 1], n: [NaN], [Symbol('s')]: 1 });
    assert.deepEqual(out.flags.map((x) => x.detail).sort(), [
      '(root) has a symbol key Symbol(s)', 'list is an array holding a value JSON cannot state', 'n is an array holding a value JSON cannot state'
    ]);
  });

  it('flags a value whose documented default cannot be stated', () => {
    const out = f2.flattenDefaults({ fn: () => 1, u: undefined, when: new Date(0) });
    assert.deepEqual(out.flags.map((x) => `${x.code}:${x.detail}`).sort(), [
      'DYNAMIC_DEFAULT:fn is a function', 'DYNAMIC_DEFAULT:u is a undefined', 'DYNAMIC_DEFAULT:when is not a plain object'
    ]);
  });
});

describe('scanDefaultsLiteral (PRR-A B2)', () => {
  it('accepts a literal built only from literal keys and values', () => {
    const src = "const D = {\n  a: 'x', 'b': -1, c: true, d: null, e: `t`,\n  f: { g: [1, { h: false }] },\n  i: [],\n};\nconst other = process.env.X;";
    assert.deepEqual(f2.scanDefaultsLiteral(src, 'D', 'f.js').flags, []);
  });

  it('flags every dynamic shape with its line', () => {
    const src = [
      'const D = {',
      '  ...base,',
      '  [key]: 1,',
      '  short,',
      '  get g() { return 1; },',
      '  m() { return 2; },',
      '  env: process.env.HOME,',
      '  call: compute(),',
      '  fn: () => 1,',
      '  tpl: `${x}`,',
      '  nested: { deep: other },',
      '  list: [1, ...more]',
      '};'
    ].join('\n');
    const flags = f2.scanDefaultsLiteral(src, 'D', 'f.js').flags;
    assert.ok(flags.every((x) => x.code === 'DYNAMIC_DEFAULT' && x.severity === 'blocking' && x.source === 'f.js'));
    assert.deepEqual(flags.map((x) => `${x.line}:${x.detail}`), [
      '2:D spreads another object',
      '3:D has a computed key',
      '4:short is a shorthand property',
      '5:g is a getter',
      '6:m is a method',
      '7:env is not a literal value',
      '8:call is not a literal value',
      '9:fn is not a literal value',
      '10:tpl is not a literal value',
      '11:nested.deep is not a literal value',
      '12:list spreads into an array'
    ]);
  });

  it('fails extraction when the declaration is absent or unclosed', () => {
    assert.throws(() => f2.scanDefaultsLiteral('const E = {};', 'D', 'f.js'), (e) => e.code === 'EXTRACTOR_FAILED');
    assert.throws(() => f2.scanDefaultsLiteral('const D = { a: 1', 'D', 'f.js'), (e) => e.code === 'EXTRACTOR_FAILED');
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
  const SHA = 'a'.repeat(64);
  const families = () => ({
    CLI: { rows: [{ id: 'whoami', usage: 'tc whoami', audience: 'pane', subverbs: '' }], flags: [], sources: ['lib/tc-verbs.js'], sourceDigests: { 'lib/tc-verbs.js': SHA } },
    ROUTES: { rows: [{ method: 'GET', path: '/a', file: 'server.js' }], flags: [], sources: ['server.js'], sourceDigests: { 'server.js': SHA } },
    'PROJECT-CONFIG': { rows: [{ key: 'engine', value: 'null' }], flags: [], sources: ['lib/project-config.js'] },
    ENGINES: { rows: [], flags: [{ code: 'ENGINE_PROFILE_FIELD_REVIEW', severity: 'info', source: 'x.json', line: null, detail: 'd' }], sources: [] }
  });
  /** Docs holding exactly the block each family generates. */
  const matchingDocs = (fam) => Object.fromEntries(f2.FAMILIES.map((name) => [
    { CLI: 'docs/tc-cli-reference.md', ROUTES: 'docs/api-reference.md', 'PROJECT-CONFIG': 'docs/configuration-reference.md', ENGINES: 'docs/engine-guide.md' }[name],
    `prose\n${f2.renderBlock(name, fam[name].rows, fam[name].sources)}\n`
  ]));

  it('exits 0 when every block matches, still reporting informational flags and the source digests', () => {
    const out = f2.checkParity(families, matchingDocs(families()));
    assert.equal(out.exitCode, 0);
    assert.equal(out.ok, true);
    assert.equal(out.schema, f2.REVIEW_SCHEMA);
    assert.deepEqual(out.flags.map((x) => x.code), ['ENGINE_PROFILE_FIELD_REVIEW']);
    assert.deepEqual(out.sourceDigests, { 'lib/tc-verbs.js': SHA, 'server.js': SHA });
  });

  it('exits 1 on drift, a missing marker, or a missing target, never writing a doc', () => {
    const docs = matchingDocs(families());
    docs['docs/api-reference.md'] = 'no markers here';
    delete docs['docs/engine-guide.md'];
    docs['docs/tc-cli-reference.md'] = docs['docs/tc-cli-reference.md'].replace('| whoami |', '| whoami-renamed |');
    const frozen = JSON.stringify(docs);
    const out = f2.checkParity(families, docs);
    assert.equal(out.exitCode, 1);
    assert.deepEqual(out.flags.map((x) => x.code), ['BLOCK_DRIFT', 'ENGINE_PROFILE_FIELD_REVIEW', 'MISSING_MARKER', 'TARGET_MISSING']);
    assert.equal(JSON.stringify(docs), frozen);
    assert.ok(out.blocks.ROUTES, 'the proposed block is still returned for review');
  });

  it('fails closed with exit 2 and no blocks when a family is missing or malformed (PRR-A B1)', () => {
    const cases = {
      'only CLI': () => ({ CLI: families().CLI }),
      'nothing at all': () => null,
      'rows not an array': () => ({ ...families(), ROUTES: { ...families().ROUTES, rows: 'x' } }),
      'flag without a code': () => ({ ...families(), ENGINES: { ...families().ENGINES, flags: [{ severity: 'info' }] } }),
      'sources missing': () => ({ ...families(), CLI: { rows: [], flags: [] } }),
      'malformed digest': () => ({ ...families(), ROUTES: { ...families().ROUTES, sourceDigests: { 'server.js': 'nope' } } })
    };
    for (const [label, extract] of Object.entries(cases)) {
      const out = f2.checkParity(extract, matchingDocs(families()));
      assert.equal(out.exitCode, 2, label);
      assert.equal(out.ok, false, label);
      assert.deepEqual(out.blocks, {}, label);
      assert.equal(out.error.code, 'FAMILY_INVALID', label);
    }
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

  it('digests every source file it read, and the real DEFAULT_PROJECT_CONFIG scans clean', () => {
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const fam = f2.extractRepository(ROOT);
    for (const name of f2.FAMILIES) {
      assert.deepEqual(Object.keys(fam[name].sourceDigests).sort(), [...fam[name].sources].sort(), name);
      for (const [rel, sha] of Object.entries(fam[name].sourceDigests)) {
        assert.equal(sha, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel), 'utf8')).digest('hex'), rel);
      }
    }
    const out = f2.checkParity(() => fam, {});
    assert.equal(Object.keys(out.sourceDigests).length, f2.FAMILIES.reduce((n, k) => n + fam[k].sources.length, 0));
    assert.ok(!out.flags.some((x) => x.code === 'DYNAMIC_DEFAULT'));
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
