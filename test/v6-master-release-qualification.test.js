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

const store = require('../lib/store');
const f2 = require('../lib/v6/f2-code-doc-parity');

const ROOT = path.join(__dirname, '..');
const V6_DIR = path.join(ROOT, 'lib', 'v6');
const MODULES = fs.readdirSync(V6_DIR).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Helpers a handler may call BEFORE its caller check, because they only read the request. */
const PRE_GUARD_READS = new Set(['parseQuery', 'reqUrl']);

/** Keywords followed by `(` that are control flow, not calls. */
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new']);

/** Calls that mean a handler has started acting: responding, reading the body, or touching the database. */
const ACTIONS = new Set(['jsonResponse', 'errorResponse', '_v6Respond', '_v6RespondThrown', '_v6Body', 'v6Db', 'getDb']);

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

  it('each module creates only v6_-prefixed tables, owned by exactly one module', () => {
    assert.ok(owners.length > 0);
    const ownerOf = new Map();
    for (const m of owners) {
      const before = tables();
      require(`../lib/v6/${m}`).ensureSchema(db);
      const created = [...tables()].filter((t) => !before.has(t));
      for (const t of created) {
        assert.match(t, /^v6_/, `${m} created non-v6 table ${t}`);
        assert.ok(!ownerOf.has(t), `${t} created by both ${ownerOf.get(t)} and ${m}`);
        ownerOf.set(t, m);
      }
    }
  });

  it('ensureSchema is idempotent and never moves the core schema version', () => {
    const v = version();
    assert.equal(v, store.CURRENT_SCHEMA_VERSION);
    const snapshot = [...tables()].sort();
    for (let round = 0; round < 3; round++) for (const m of owners) require(`../lib/v6/${m}`).ensureSchema(db);
    assert.deepEqual([...tables()].sort(), snapshot);
    assert.equal(version(), v);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });
});

describe('route security', () => {
  /**
   * Every /api/v6 route registration in server.js with the identifiers its
   * handler calls, in order, up to the handler's closing brace.
   * @returns {Array<{route: string, calls: string[]}>}
   */
  function v6Routes() {
    const t = f2.tokenizeJs(read('server.js'), 'server.js');
    const out = [];
    for (let k = 0; k < t.length; k++) {
      const x = t[k];
      if (x.type !== 'ident' || x.value !== 'route' || !t[k + 1] || t[k + 1].value !== '(') continue;
      if (t[k - 1] && (t[k - 1].value === 'function' || t[k - 1].value === '.')) continue;
      const method = t[k + 2];
      const pathTok = t[k + 4];
      if (!pathTok || pathTok.type !== 'string' || !pathTok.value.startsWith('/api/v6')) continue;
      let j = k + 5;
      while (j < t.length && !(t[j].type === 'punct' && t[j].value === '{')) j++;
      let depth = 0;
      const calls = [];
      for (; j < t.length; j++) {
        const tok = t[j];
        if (tok.type === 'punct' && tok.value === '{') depth++;
        else if (tok.type === 'punct' && tok.value === '}') {
          depth--;
          if (depth === 0) break;
        } else if (tok.type === 'ident' && !KEYWORDS.has(tok.value) && t[j + 1] && t[j + 1].value === '(') calls.push(tok.value);
      }
      out.push({ route: `${method.value} ${pathTok.value}`, calls });
    }
    return out;
  }

  it('finds the v6 routes', () => {
    assert.ok(v6Routes().length >= 134, 'fewer /api/v6 routes than v6.2.0 shipped');
  });

  it('every /api/v6 route checks its caller before responding, reading the body or touching the database', () => {
    const unguarded = [];
    for (const { route, calls } of v6Routes()) {
      const guard = calls.findIndex((c) => /Caller$/.test(c));
      const firstAction = calls.findIndex((c) => ACTIONS.has(c));
      const before = guard === -1 ? calls : calls.slice(0, guard);
      const ok = guard !== -1 && (firstAction === -1 || guard < firstAction) && before.every((c) => PRE_GUARD_READS.has(c));
      if (!ok) unguarded.push(route);
    }
    assert.deepEqual(unguarded, []);
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

  it('no changelog fragment is left pending after the cut', () => {
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
