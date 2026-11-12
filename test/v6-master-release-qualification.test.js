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

/** The only helpers a handler may call BEFORE its caller check: they only parse the request URL. Any other call first (a response, a body read, a database touch) fails the check. */
const PRE_GUARD_READS = new Set(['parseQuery', 'reqUrl']);

/** Keywords followed by `(` that are control flow, not calls. */
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new']);


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
  /**
   * The index just past the parenthesised group that opens at `open`.
   * @param {Array<object>} t
   * @param {number} open - Index of a `(` token.
   * @returns {number}
   */
  function pastParens(t, open) {
    let depth = 0;
    for (let j = open; j < t.length; j++) {
      if (t[j].type !== 'punct') continue;
      if (t[j].value === '(') depth++;
      else if (t[j].value === ')' && --depth === 0) return j + 1;
    }
    return t.length;
  }

  /** @returns {boolean} */
  const isP = (tok, v) => !!tok && tok.type === 'punct' && tok.value === v;
  /** @returns {boolean} */
  const isI = (tok, v) => !!tok && tok.type === 'ident' && (v === undefined || tok.value === v);

  /**
   * Whether the `…Caller(` call at index `k` is used fail-closed, in one of
   * the two shapes this codebase uses: `if (!xCaller(...)) return` or
   * `const c = xCaller(...); if (!c) return`. A call whose result is ignored,
   * or tested the wrong way round, is not a guard.
   * @param {Array<object>} t
   * @param {number} k
   * @returns {boolean}
   */
  function failClosed(t, k) {
    const after = pastParens(t, k + 1);
    if (isI(t[k - 3], 'if') && isP(t[k - 2], '(') && isP(t[k - 1], '!')) {
      return isP(t[after], ')') && isI(t[after + 1], 'return');
    }
    if (isP(t[k - 1], '=') && isI(t[k - 2]) && ['const', 'let'].includes(t[k - 3] && t[k - 3].value)) {
      const name = t[k - 2].value;
      let j = after;
      if (isP(t[j], ';')) j++;
      return isI(t[j], 'if') && isP(t[j + 1], '(') && isP(t[j + 2], '!') && isI(t[j + 3], name)
        && isP(t[j + 4], ')') && isI(t[j + 5], 'return');
    }
    return false;
  }

  /**
   * The /api/v6 routes in `source` that do not check their caller,
   * fail-closed and at the handler's top level, before their first response,
   * body read or database access. "Body read" means ANY reference to the
   * handler's `body` (a call such as `_v6Body(body)` or a property read such
   * as `body.x`); "response" and "database access" are any other call. Only
   * `parseQuery`/`reqUrl` may be called before the guard.
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
      let j = k + 5;
      while (j < t.length && !isP(t[j], '{')) j++;
      let depth = 0;
      let guarded = false;
      let ok = true;
      for (; j < t.length; j++) {
        const tok = t[j];
        if (isP(tok, '{')) depth++;
        else if (isP(tok, '}')) {
          if (--depth === 0) break;
        } else if (!guarded && isI(tok, 'body')) {
          // #3044 N1: a property read of the body before the guard is a body
          // read too, not only a call that takes it.
          ok = false;
        } else if (isI(tok) && !KEYWORDS.has(tok.value) && isP(t[j + 1], '(')) {
          if (/Caller$/.test(tok.value)) {
            // Only a fail-closed guard at the handler's top level counts: one
            // nested in a branch or a callback runs only sometimes, if at all.
            if (!failClosed(t, j) || depth !== 1) ok = false;
            guarded = guarded || (depth === 1 && failClosed(t, j));
            j = pastParens(t, j + 1) - 1;
          } else if (!guarded && !PRE_GUARD_READS.has(tok.value)) {
            ok = false;
          }
        }
      }
      if (!ok || !guarded) unguarded.push(`${t[k + 2].value} ${pathTok.value}`);
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
