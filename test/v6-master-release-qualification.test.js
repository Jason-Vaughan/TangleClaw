'use strict';

// v6.2.1 (#3037, Car V621-W1-C): master release qualification for v6.0.0-v6.2.0.
// The INT Phase 7 prototype (v6-phase7-master-release-qualification-and-
// migration-harness.md) qualifies a reference pipeline; this suite qualifies
// what actually shipped, as properties that must hold across EVERY lib/v6
// module and the release record, so a module or route added later is
// covered without editing this file:
//
// - every module loads, exports only defined values, documents its exported
//   functions, is imported by at least one test, and sits in an owned area;
// - every module-owned table is v6_-prefixed, owned by exactly one module,
//   and created idempotently without moving the core schema version;
// - every /api/v6 route checks its caller before any response, body or
//   database access;
// - the release record (version, CHANGELOG sections, released-section lock,
//   release notes, README pins) agrees with itself, and no released v6
//   section ships a "not yet reachable" caveat (Kaizen KZ-V610-02);
// - the F2 parity extractor reads the whole repository without failing.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const { DatabaseSync } = require('node:sqlite');
const store = require('../lib/store');
const f2 = require('../lib/v6/f2-code-doc-parity');

const ROOT = path.join(__dirname, '..');
const V6_DIR = path.join(ROOT, 'lib', 'v6');
const MODULES = fs.readdirSync(V6_DIR).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');


describe('module inventory', () => {
  it('finds the v6 module tree', () => {
    assert.ok(MODULES.length >= 33, `found ${MODULES.length} lib/v6 modules`);
  });

  it('every module loads and exports only defined values', () => {
    for (const m of MODULES) {
      const mod = require(`../lib/v6/${m}`);
      const keys = Object.keys(mod);
      assert.ok(keys.length > 0, `${m} exports nothing`);
      for (const k of keys) assert.notEqual(mod[k], undefined, `${m}.${k} is exported as undefined`);
    }
  });

  it('every exported function declaration carries a JSDoc block', () => {
    const missing = [];
    for (const m of MODULES) {
      const src = read(`lib/v6/${m}.js`);
      const exported = new Set(Object.keys(require(`../lib/v6/${m}`)));
      const re = /^(?:async )?function\*? ?(\w+)\(/gm;
      let hit;
      while ((hit = re.exec(src))) {
        if (!exported.has(hit[1])) continue;
        if (!src.slice(0, hit.index).trimEnd().endsWith('*/')) missing.push(`${m}#${hit[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('every module is imported by at least one test', () => {
    const tests = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => read(`test/${f}`));
    const untested = MODULES.filter((m) => !tests.some((s) => s.includes(`lib/v6/${m}'`) || s.includes(`lib/v6/${m}.js'`)));
    assert.deepEqual(untested, []);
  });

  it('the v6 tree is owned in docs/areas.json', () => {
    const areas = JSON.parse(read('docs/areas.json'));
    const globs = JSON.stringify(areas);
    assert.ok(globs.includes('"lib/v6/**"'), 'lib/v6/** is not an owned area path');
  });
});

describe('module-owned schema', () => {
  let tmpDir;
  let db;
  const owners = MODULES.filter((m) => typeof require(`../lib/v6/${m}`).ensureSchema === 'function');

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-qual-'));
    store._setBasePath(tmpDir);
    store.init();
    db = store.getDb();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const tables = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const version = () => db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;

  /**
   * The tables a module's ensureSchema creates, discovered on its OWN fresh
   * database, so a module that also runs CREATE TABLE IF NOT EXISTS on
   * another module's table cannot hide behind whichever ran first.
   * @param {string} m
   * @returns {string[]}
   */
  function isolatedTables(m) {
    const iso = new DatabaseSync(':memory:');
    try {
      require(`../lib/v6/${m}`).ensureSchema(iso);
      return iso.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
    } finally {
      iso.close();
    }
  }

  it('each module, alone on a fresh database, creates only v6_-prefixed tables, and no two modules share one', () => {
    assert.ok(owners.length > 0);
    const sets = owners.map((m) => ({ m, tables: isolatedTables(m) }));
    for (const { m, tables: ts } of sets) {
      assert.ok(ts.length > 0, `${m}'s ensureSchema created no table`);
      for (const t of ts) assert.match(t, /^v6_/, `${m} created non-v6 table ${t}`);
    }
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const shared = sets[i].tables.filter((t) => sets[j].tables.includes(t));
        assert.deepEqual(shared, [], `${sets[i].m} and ${sets[j].m} both create ${shared.join(', ')}`);
      }
    }
  });

  it('detects shared ownership that sequential discovery would miss (regression)', () => {
    const a = new DatabaseSync(':memory:');
    const b = new DatabaseSync(':memory:');
    const ownA = (d) => d.exec('CREATE TABLE IF NOT EXISTS v6_x (id INTEGER)');
    const ownB = (d) => { d.exec('CREATE TABLE IF NOT EXISTS v6_x (id INTEGER)'); d.exec('CREATE TABLE IF NOT EXISTS v6_y (id INTEGER)'); };
    ownA(a);
    ownB(b);
    const names = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.deepEqual(names(a).filter((t) => names(b).includes(t)), ['v6_x'], 'isolated discovery sees the shared table');
    a.close();
    b.close();
  });

  it('ensureSchema is idempotent and never moves the core schema version', () => {
    const v = version();
    assert.equal(v, store.CURRENT_SCHEMA_VERSION);
    for (const m of owners) require(`../lib/v6/${m}`).ensureSchema(db);
    const snapshot = [...tables()].sort();
    for (let round = 0; round < 3; round++) for (const m of owners) require(`../lib/v6/${m}`).ensureSchema(db);
    assert.deepEqual([...tables()].sort(), snapshot);
    assert.equal(version(), v);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });
});

describe('route security', () => {
  /** @returns {boolean} */
  const isP = (tok, v) => !!tok && tok.type === 'punct' && tok.value === v;
  /** @returns {boolean} */
  const isI = (tok, v) => !!tok && tok.type === 'ident' && (v === undefined || tok.value === v);

  /**
   * Whether the tokens at `p` are exactly `const <name> = parseQuery(reqUrl(req).search);`,
   * the one statement a v6 handler may run before its guard: it only parses
   * the request URL.
   * @param {Array<object>} t
   * @param {number} p
   * @returns {boolean}
   */
  function isQueryRead(t, p) {
    return isI(t[p], 'const') && isI(t[p + 1]) && isP(t[p + 2], '=')
      && isI(t[p + 3], 'parseQuery') && isP(t[p + 4], '(')
      && isI(t[p + 5], 'reqUrl') && isP(t[p + 6], '(') && isI(t[p + 7], 'req') && isP(t[p + 8], ')')
      && isP(t[p + 9], '.') && isI(t[p + 10], 'search') && isP(t[p + 11], ')') && isP(t[p + 12], ';');
  }

  /**
   * Whether the tokens at `c` are exactly `<x>Caller(req, res, '<action>')`.
   * The arguments run before the check does, so nothing else may appear there.
   * @param {Array<object>} t
   * @param {number} c
   * @returns {boolean}
   */
  function isCallerCall(t, c) {
    return isI(t[c]) && /Caller$/.test(t[c].value)
      && isP(t[c + 1], '(') && isI(t[c + 2], 'req') && isP(t[c + 3], ',')
      && isI(t[c + 4], 'res') && isP(t[c + 5], ',')
      && !!t[c + 6] && t[c + 6].type === 'string' && isP(t[c + 7], ')');
  }

  /**
   * Whether a fail-closed caller check starts exactly at `g`, in one of the two
   * shapes this codebase uses: `if (!xCaller(req, res, '...')) return` or
   * `const c = xCaller(req, res, '...'); if (!c) return`. A call whose result
   * is ignored or tested the wrong way round is not a guard.
   * @param {Array<object>} t
   * @param {number} g
   * @returns {boolean}
   */
  function isFailClosedGuardAt(t, g) {
    if (isI(t[g], 'if') && isP(t[g + 1], '(') && isP(t[g + 2], '!') && isCallerCall(t, g + 3)) {
      return isP(t[g + 11], ')') && isI(t[g + 12], 'return');
    }
    if ((isI(t[g], 'const') || isI(t[g], 'let')) && isI(t[g + 1]) && isP(t[g + 2], '=') && isCallerCall(t, g + 3)) {
      const name = t[g + 1].value;
      let n = g + 11;
      if (isP(t[n], ';')) n++;
      return isI(t[n], 'if') && isP(t[n + 1], '(') && isP(t[n + 2], '!') && isI(t[n + 3], name)
        && isP(t[n + 4], ')') && isI(t[n + 5], 'return');
    }
    return false;
  }

  /**
   * The index of the first body token of a route's handler, when the tokens
   * from `c` are exactly `, [async] (<ident>, ...) => {`, the only handler
   * shape the v6 routes use; else -1. A closed header stops an expression
   * body or a function reference from borrowing the next route's `{`.
   * @param {Array<object>} t
   * @param {number} c - Index of the comma after the route path.
   * @returns {number}
   */
  function arrowBlockBodyStart(t, c) {
    if (!isP(t[c], ',')) return -1;
    let h = c + 1;
    if (isI(t[h], 'async')) h++;
    if (!isP(t[h], '(') || !isI(t[h + 1])) return -1;
    h += 2;
    while (isP(t[h], ',') && isI(t[h + 1])) h += 2;
    if (!isP(t[h], ')') || !isP(t[h + 1], '=>') || !isP(t[h + 2], '{')) return -1;
    return h + 3;
  }

  /**
   * The /api/v6 routes in `source` whose handler is not an inline arrow block
   * that STARTS with a fail-closed caller check. This is a closed-world grammar, not a search:
   * the guard must be the handler's first statement, or follow only the
   * exact URL-parse statement `isQueryRead` accepts. Nothing else can run
   * first: no body read, no call in any spelling, no property read (a getter
   * runs code), no branch, block or callback. Every v6 route matches it.
   * @param {string} source - server.js text.
   * @returns {{routes: number, unguarded: string[]}}
   */
  function unguardedV6Routes(source) {
    const t = f2.tokenizeJs(source, 'server.js');
    let routes = 0;
    const unguarded = [];
    for (let k = 0; k < t.length; k++) {
      if (!isI(t[k], 'route') || !isP(t[k + 1], '(')) continue;
      if (t[k - 1] && (t[k - 1].value === 'function' || t[k - 1].value === '.')) continue;
      const pathTok = t[k + 4];
      if (!pathTok || pathTok.type !== 'string' || !pathTok.value.startsWith('/api/v6')) continue;
      routes++;
      const start = arrowBlockBodyStart(t, k + 5);
      if (start < 0) {
        unguarded.push(`${t[k + 2].value} ${pathTok.value}`);
        continue;
      }
      const g = isQueryRead(t, start) ? start + 13 : start;
      if (!isFailClosedGuardAt(t, g)) unguarded.push(`${t[k + 2].value} ${pathTok.value}`);
    }
    return { routes, unguarded };
  }

  const server = read('server.js');
  const KB_GUARD = "  if (!operatorProjectCaller(req, res, 'search the knowledge base')) return;\n";

  it('finds the v6 routes', () => {
    assert.ok(unguardedV6Routes(server).routes >= 134, 'fewer /api/v6 routes than v6.2.0 shipped');
  });

  it('every /api/v6 route checks its caller, fail-closed, before responding, reading the body or touching the database', () => {
    assert.deepEqual(unguardedV6Routes(server).unguarded, []);
  });

  it('flags a route whose guard is removed, ignored, inverted, nested, or placed after the body read (mutation regression)', () => {
    assert.ok(server.includes(KB_GUARD), 'mutation anchor missing from server.js');
    const flagged = (src) => unguardedV6Routes(src).unguarded;
    assert.deepEqual(flagged(server.replace(KB_GUARD, '')), ['GET /api/v6/kb/search'], 'guard removed');
    assert.deepEqual(flagged(server.replace(KB_GUARD, "  operatorProjectCaller(req, res, 'search the knowledge base');\n")),
      ['GET /api/v6/kb/search'], 'result ignored');
    assert.deepEqual(flagged(server.replace(KB_GUARD, "  if (operatorProjectCaller(req, res, 'search the knowledge base')) return;\n")),
      ['GET /api/v6/kb/search'], 'test inverted');
    assert.deepEqual(flagged(server.replace(KB_GUARD,
      "  const ok = operatorProjectCaller(req, res, 'search the knowledge base');\n  if (ok) return;\n")),
    ['GET /api/v6/kb/search'], 'const form inverted');
    assert.deepEqual(flagged(server.replace(KB_GUARD,
      "  const ok = operatorProjectCaller(req, res, 'search the knowledge base');\n  if (!ok) return;\n")),
    [], 'the const fail-closed form is accepted');
    const create = "  if (!operatorProjectCaller(req, res, 'create a logical project')) return;\n  const b = _v6Body(body);\n";
    assert.ok(server.includes(create), 'mutation anchor missing from server.js');
    assert.deepEqual(flagged(server.replace(KB_GUARD,
      "  if (req) {\n  if (!operatorProjectCaller(req, res, 'search the knowledge base')) return;\n  }\n")),
    ['GET /api/v6/kb/search'], 'guard nested in a branch');
    assert.deepEqual(flagged(server.replace(KB_GUARD,
      "  [0].forEach(() => { if (!operatorProjectCaller(req, res, 'search the knowledge base')) return; });\n")),
    ['GET /api/v6/kb/search'], 'guard nested in a callback');
    assert.deepEqual(flagged(server.replace(KB_GUARD,
      "  if (req) if (!operatorProjectCaller(req, res, 'search the knowledge base')) return;\n")),
    ['GET /api/v6/kb/search'], 'guard in a brace-less branch');
    assert.deepEqual(flagged(server.replace(KB_GUARD,
      "  if (req) ; else if (!operatorProjectCaller(req, res, 'search the knowledge base')) return;\n")),
    ['GET /api/v6/kb/search'], 'guard in a brace-less else branch');
    assert.deepEqual(flagged(server.replace(KB_GUARD,
      "  if (!operatorProjectCaller(req, res, 'search the knowledge base', body && body.q)) return;\n")),
    ['GET /api/v6/kb/search'], 'a body read inside the guard call itself');
    assert.deepEqual(flagged(server.replace(KB_GUARD,
      "  if (!operatorProjectCaller(req, res, _v6Lookup(req))) return;\n")),
    ['GET /api/v6/kb/search'], 'another call inside the guard call itself');
    for (const [label, guard] of [
      ['a parenthesised callee inside the guard call', "  if (!operatorProjectCaller(req, res, (_v6Lookup)())) return;\n"],
      ['a non-literal action inside the guard call', "  if (!operatorProjectCaller(req, res, action)) return;\n"],
      ['a parenthesised callee before the guard', "  (_v6Lookup)();\n" + KB_GUARD],
      ['a computed callee before the guard', "  _v6[name]();\n" + KB_GUARD],
      ['an optional call before the guard', "  _v6Lookup?.();\n" + KB_GUARD],
      ['a construction without parentheses before the guard', "  const x = new _V6Thing;\n" + KB_GUARD],
      ['a tagged template before the guard', "  _v6Lookup`q`;\n" + KB_GUARD],
      ['a member call named like an approved read before the guard', "  untrusted.parseQuery();\n" + KB_GUARD],
      ['a property read (a possible getter) before the guard', "  req.x;\n" + KB_GUARD],
      ['an empty statement before the guard', "  ;\n" + KB_GUARD],
      ['a guard that does not return when the check fails', "  if (!operatorProjectCaller(req, res, 'search the knowledge base')) res.end();\n"]
    ]) {
      assert.deepEqual(flagged(server.replace(KB_GUARD, guard)), ['GET /api/v6/kb/search'], label);
    }
    // A handler that is not an inline arrow block must not borrow the next
    // route's opening brace and guard.
    const KB_ROUTE = "route('GET', '/api/v6/kb/search', (req, res, _params) => {";
    assert.ok(server.includes(KB_ROUTE), 'mutation anchor missing from server.js');
    for (const [label, extra, name] of [
      ['an expression-bodied handler', "route('GET', '/api/v6/zz-expr', (req, res) => jsonResponse(res, 200, null));\n", 'GET /api/v6/zz-expr'],
      ['a function-reference handler', "route('GET', '/api/v6/zz-ref', _zzHandler);\n", 'GET /api/v6/zz-ref']
    ]) {
      assert.deepEqual(flagged(server.replace(KB_ROUTE, extra + KB_ROUTE)), [name], label);
    }
    assert.deepEqual(flagged(server.replace(create,
      "  const b = _v6Body(body);\n  if (!operatorProjectCaller(req, res, 'create a logical project')) return;\n")),
    ['POST /api/v6/logical-projects'], 'guard after the body read');
    assert.deepEqual(flagged(server.replace(create,
      "  const peek = body && body.displayName;\n" + create)),
    ['POST /api/v6/logical-projects'], 'a body property read before the guard (#3044 N1)');
  });
});

describe('release record', () => {
  const version = JSON.parse(read('version.json')).version;
  const changelog = read('CHANGELOG.md');
  const lock = JSON.parse(read('test/fixtures/changelog-released-sections.lock.json'));

  /** @returns {string[]} The v6 versions CHANGELOG.md records as released. */
  const v6Released = () => [...changelog.matchAll(/^## \[(6\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/gm)].map((m) => m[1]);

  it('version.json names the newest released CHANGELOG section', () => {
    const top = /^## \[(\d+\.\d+\.\d+)\] - /m.exec(changelog.slice(changelog.indexOf('## [Unreleased]') + 1));
    assert.equal(top[1], version);
  });

  it('every released v6 section is locked, has release notes, and is indexed', () => {
    const released = v6Released();
    assert.ok(released.includes('6.0.0') && released.includes(version));
    const index = read('docs/releases/index.md');
    for (const v of released) {
      assert.ok(lock[v], `${v} is not in the released-section lock`);
      assert.ok(fs.existsSync(path.join(ROOT, `docs/releases/v${v}.md`)), `docs/releases/v${v}.md is missing`);
      assert.ok(index.includes(`(v${v}.md)`), `v${v} is not in docs/releases/index.md`);
    }
  });

  it('README clone pins and banner name the current version', () => {
    const readme = read('README.md');
    const pins = [...readme.matchAll(/--branch\s+v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(pins.length > 0);
    assert.ok(pins.every((p) => p === version), `README pins ${pins.join(', ')} vs ${version}`);
    assert.match(readme, new RegExp(`\\*\\*Latest release:\\*\\*\\s+\`v${version.replace(/\./g, '\\.')}\``));
  });

  it('no released v6 section ships a "not yet reachable" caveat (KZ-V610-02)', () => {
    const start = changelog.indexOf(`## [${version}]`);
    const end = changelog.indexOf('## [5.');
    const v6Text = changelog.slice(start, end === -1 ? undefined : end);
    assert.doesNotMatch(v6Text, /not yet reachable/i);
  });

  it('no changelog fragment is malformed', () => {
    const { readFragments } = require('../lib/changelog-fragments');
    const r = readFragments(ROOT);
    assert.deepEqual(r.refused, []);
  });
});

describe('repository parity extraction', () => {
  it('reads every reference-table source without an extractor failure', () => {
    const out = f2.checkParity(() => f2.extractRepository(ROOT), {});
    assert.notEqual(out.exitCode, 2, out.error && out.error.message);
    assert.ok(Object.keys(out.sourceDigests).length > 0);
  });
});
