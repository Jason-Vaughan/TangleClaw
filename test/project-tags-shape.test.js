'use strict';

/*
 * #1375 — a project row whose `tags` column holds a JSON string (written before
 * POST /api/projects validated the shape) must not take the dashboard down.
 *
 * Two layers are under test:
 *   1. The store hands every consumer a string[] whatever the row holds, so the
 *      card, the settings modal, the tag filter and the API all see one shape.
 *   2. The card's tag formatter checks the shape itself, so a malformed value
 *      reaching it by any other path renders "None" instead of throwing.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');

const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 *
 * @param {string} src - File source text.
 * @param {string} decl - The declaration to find.
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

// The production `esc`, lifted from `public/landing.js` rather than copied, so
// the formatter is tested against the escape that ships.
const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
const esc = new Function(`function esc(str)${functionBody(landing, 'function esc(str)')}\nreturn esc;`)();

const decl = 'function formatTagList(tags)';
const formatTagList = new Function('esc', `${decl}${functionBody(ui, decl)}\nreturn formatTagList;`)(esc);

describe('project tags shape (#1375)', () => {
  let tmpDir;
  let db;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tags-shape-'));
    store._setBasePath(tmpDir);
    store.init();
    db = store.getDb();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a project, then overwrite its tags column with raw text, the way a
   * pre-validation write left it.
   *
   * @param {string} name - Project name.
   * @param {string|null} raw - The raw column value.
   * @returns {object} The project as the store now reads it.
   */
  function withRawTags(name, raw) {
    const created = store.projects.create({ name, path: `/tmp/${name}` });
    db.prepare('UPDATE projects SET tags = ? WHERE id = ?').run(raw, created.id);
    return store.projects.get(created.id);
  }

  describe('the store normalizes on read', () => {
    it('turns a legacy JSON string into a one-tag array', () => {
      assert.deepEqual(withRawTags('legacy-one', JSON.stringify('not-an-array')).tags, ['not-an-array']);
    });

    it('splits a legacy comma string the way the create form does', () => {
      assert.deepEqual(withRawTags('legacy-csv', JSON.stringify('web, prod ,,api')).tags, ['web', 'prod', 'api']);
    });

    it('keeps only the string members of an array', () => {
      assert.deepEqual(withRawTags('legacy-mixed', JSON.stringify(['ok', 7, null, 'fine'])).tags, ['ok', 'fine']);
    });

    it('reads an object, a number, unparseable text or NULL as no tags', () => {
      assert.deepEqual(withRawTags('legacy-obj', JSON.stringify({ a: 1 })).tags, []);
      assert.deepEqual(withRawTags('legacy-num', '42').tags, []);
      assert.deepEqual(withRawTags('legacy-junk', '{not json').tags, []);
      assert.deepEqual(withRawTags('legacy-null', null).tags, []);
    });

    it('leaves a well-formed array untouched', () => {
      const created = store.projects.create({ name: 'clean-tags', path: '/tmp/clean-tags', tags: ['a', 'b'] });
      assert.deepEqual(store.projects.get(created.id).tags, ['a', 'b']);
    });

    it('filters by tag membership, not substring, on a legacy string row', () => {
      withRawTags('legacy-filter', JSON.stringify('production'));
      const names = store.projects.list({ tag: 'prod' }).map((p) => p.name);
      assert.ok(!names.includes('legacy-filter'), 'a "prod" filter must not match a "production" tag');
      assert.ok(store.projects.list({ tag: 'production' }).some((p) => p.name === 'legacy-filter'));
    });

    it('lets a save repair the stored row', () => {
      const project = withRawTags('legacy-repair', JSON.stringify('x'));
      store.projects.update(project.id, { tags: project.tags });
      const raw = db.prepare('SELECT tags FROM projects WHERE id = ?').get(project.id).tags;
      assert.deepEqual(JSON.parse(raw), ['x']);
    });
  });

  describe('the card formatter checks the shape itself', () => {
    it('renders a string as None instead of throwing', () => {
      assert.equal(formatTagList('not-an-array'), 'None');
    });

    it('renders undefined, null and an empty array as None', () => {
      assert.equal(formatTagList(undefined), 'None');
      assert.equal(formatTagList(null), 'None');
      assert.equal(formatTagList([]), 'None');
    });

    it('escapes and joins an array of tags', () => {
      assert.equal(formatTagList(['a<b', 'c']), 'a&lt;b, c');
    });
  });
});
