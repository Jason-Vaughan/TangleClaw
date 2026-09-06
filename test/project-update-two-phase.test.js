'use strict';

// #1033 — `updateProject` validates EVERY field before it writes ANY.
//
// The shape this replaced validated most fields up front by convention and left
// three checks inside the blocks that write, so a PATCH could be refused after
// it had already changed the machine. These pin the property from the outside:
// a rejected PATCH must leave the projects row and the project's own directory
// exactly as it found them.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const projects = require('../lib/projects');

/**
 * Everything about a project that a rejected PATCH must not change: its row, and
 * the bytes of its directory. Compared as a whole rather than field by field —
 * an assertion listing today's fields is the enumeration this issue is about.
 *
 * @param {string} name - Project name.
 * @returns {object} A comparable snapshot.
 */
function snapshot(name) {
  const row = store.projects.getByName(name);
  if (!row) return { missing: true };
  /**
   * @param {string} dir - Directory to walk.
   * @param {string} prefix - Path prefix for the returned keys.
   * @returns {object} Relative path → file contents.
   */
  const walk = (dir, prefix) => {
    const out = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) Object.assign(out, walk(path.join(dir, entry.name), rel));
      else out[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    }
    return out;
  };
  return {
    row: { name: row.name, path: row.path, engineId: row.engineId, tags: row.tags },
    pathExists: fs.existsSync(row.path),
    files: fs.existsSync(row.path) ? walk(row.path, '') : null
  };
}

describe('updateProject validates every field before writing any (#1033)', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-two-phase-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a rename paired with an unknown engine renames nothing', async () => {
    // The reproduction. `fs.renameSync` ran, then `Engine "…" not found` was
    // returned — and because the row is written in one batch at the end, the
    // projects table was left pointing at a path that no longer existed. The
    // project was not merely half-updated; it was unopenable.
    projects.createProject({ name: 'two-phase-rename' });
    const before = snapshot('two-phase-rename');

    const result = await projects.updateProject('two-phase-rename', {
      name: 'two-phase-renamed', engine: 'no-such-engine'
    });

    assert.equal(result.project, null);
    assert.equal(result.errors[0], 'Engine "no-such-engine" not found');
    assert.deepEqual(snapshot('two-phase-rename'), before,
      'a refused PATCH must leave the row and the directory untouched');
    assert.equal(fs.existsSync(path.join(projectsDir, 'two-phase-renamed')), false,
      'and must not leave the renamed directory behind');
  });

  it('an engine switch paired with a disabled core rule switches nothing', async () => {
    // The second straggler, and the deeper one: `Core rules cannot be disabled`
    // was returned after the whole engine switch had run — config rewritten on
    // disk, the previous engine's config retired, both hook sets re-synced.
    projects.createProject({ name: 'two-phase-rules', engine: 'claude' });
    const before = snapshot('two-phase-rules');

    const result = await projects.updateProject('two-phase-rules', {
      engine: 'codex', rules: { core: { 'update-changelog': false } }
    });

    assert.equal(result.project, null);
    assert.equal(result.errors[0], 'Core rules cannot be disabled');
    assert.deepEqual(snapshot('two-phase-rules'), before,
      'the engine switch must not have written anything before the rules refusal');
  });

  it('a full settings save with one bad field writes none of the good ones', async () => {
    // The fields come from what the settings modal actually PATCHes (see the
    // producer-derived roster below), so this grows with the modal rather than
    // with a list someone remembered to update. Every field here wants to write
    // something — project.json keys, a seeded FEATURES.md, a directory rename —
    // and none of it may survive one rejected field.
    projects.createProject({ name: 'two-phase-batch', engine: 'claude' });
    const before = snapshot('two-phase-batch');

    const result = await projects.updateProject('two-phase-batch', {
      ...VALID_SETTINGS_PATCH,
      featureIndexEnabled: 'not-a-boolean'
    });

    assert.equal(result.project, null);
    assert.equal(result.errors[0], 'featureIndexEnabled must be a boolean');
    assert.deepEqual(snapshot('two-phase-batch'), before,
      'one bad field must leave every other field unwritten');
    assert.equal(fs.existsSync(path.join(projectsDir, VALID_SETTINGS_PATCH.name)), false);
  });

  it('the same save without the bad field does write (the control)', async () => {
    // Without this the test above passes on a PATCH that was never going to
    // write anything — the fixture would be measuring its own inertness.
    projects.createProject({ name: 'two-phase-control', engine: 'claude' });
    const before = snapshot('two-phase-control');

    const result = await projects.updateProject('two-phase-control', VALID_SETTINGS_PATCH);

    assert.ok(result.project, `the control save must succeed: ${result.errors.join('; ')}`);
    const after = snapshot(VALID_SETTINGS_PATCH.name);
    assert.notDeepEqual(after, before, 'the control save must actually change something');
    assert.equal(after.row.name, VALID_SETTINGS_PATCH.name, 'including the rename');
  });
});

/**
 * A valid value for every field the settings modal sends.
 *
 * Checked against the modal itself below, so a field the modal gains and this
 * map has not is a failing test rather than a field the partial-update tests
 * quietly stop exercising.
 */
const VALID_SETTINGS_PATCH = {
  name: 'two-phase-saved',
  engine: 'claude',
  tags: ['alpha'],
  silentPrime: true,
  evalAuditMode: { enabled: false },
  featureIndexEnabled: true,
  projectMapEnabled: true,
  versionBumpEnabled: false,
  versionFilePath: 'VERSION.json',
  medusaEnabled: true,
  medusaWake: true,
  wrapSections: null,
  defaultLaunchMode: 'default',
  showLaunchModePicker: true,
  confirmBypassHidden: true
};

describe('the fixture tracks the settings modal, not a remembered list', () => {
  // Cross-realm: the browser builds the PATCH body and the server validates it,
  // and a fixture written from the server's own table would agree with the
  // server about a field the modal sends and the table forgot. So the roster is
  // read from the producer — `doSaveSettings` in public/ui.js — which is the
  // only place that knows what a save really carries.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  const start = ui.indexOf('async function doSaveSettings()');
  const body = ui.slice(start, ui.indexOf('\nasync function _submitSettings', start));

  /** @returns {string[]} Every field `doSaveSettings` puts in the PATCH body. */
  function modalFields() {
    const keys = new Set();
    // The two ways a field gets in: the initial object literal, and `body.x =`.
    const literal = body.slice(body.indexOf('const body = {'), body.indexOf('};'));
    for (const m of literal.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)) keys.add(m[1]);
    for (const m of body.matchAll(/\bbody\.([A-Za-z][A-Za-z0-9]*)\s*=/g)) keys.add(m[1]);
    return [...keys];
  }

  it('finds the modal\'s fields at all', () => {
    // Guards every assertion below from passing on an empty set — the slice is
    // anchored on two function names, and either one moving would otherwise
    // make this whole describe vacuously green.
    const fields = modalFields();
    assert.ok(fields.length >= 10, `only found ${fields.length}: ${fields.join(', ')}`);
    assert.ok(fields.includes('engine') && fields.includes('tags'));
  });

  it('every field the modal sends has a valid value in the fixture', () => {
    for (const field of modalFields()) {
      assert.ok(Object.prototype.hasOwnProperty.call(VALID_SETTINGS_PATCH, field),
        `the settings modal sends "${field}" — add a valid value for it to `
        + 'VALID_SETTINGS_PATCH so the partial-update tests exercise it');
    }
  });

  it('every field the modal sends is known to the validator table', () => {
    // `tags` is the one exception and it is declared, not overlooked: nothing
    // validates it today (any value is written to the row as-is). A field that
    // is validated nowhere and declared nowhere fails here.
    const unvalidated = new Set(['tags']);
    const known = new Set(projects._PROJECT_UPDATE_VALIDATORS
      .flatMap((v) => [...v.keys, ...(v.reads || [])]));
    for (const field of modalFields()) {
      assert.ok(known.has(field) || unvalidated.has(field),
        `the settings modal sends "${field}" and no validator names it — `
        + 'give it a table entry, or add it to the declared-unvalidated set');
    }
  });
});

describe('the apply phase cannot refuse a field', () => {
  // The structural half. Every verdict on the input belongs to the validators;
  // if a later field's rejection can be written into the write phase again, so
  // can #1033. A source read, so it sees a `return`, not a `throw` — the limit
  // is named rather than papered over.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'projects.js'), 'utf8');
  const start = src.indexOf('async function _applyProjectUpdates(');
  const apply = src.slice(start, src.indexOf('\n}\n', start));

  it('the slice actually covers the apply phase', () => {
    assert.ok(start > -1, '_applyProjectUpdates must exist');
    assert.ok(apply.length > 2000, `slice looks wrong (${apply.length} chars)`);
  });

  it('returns a null project for exactly one reason, and it is not a verdict', () => {
    const nulls = [...apply.matchAll(/return \{ project: null/g)].length;
    assert.equal(nulls, 1,
      'a second null-project return in the write phase is a field being refused '
      + 'after earlier fields were written — put its verdict in PROJECT_UPDATE_VALIDATORS');
    assert.match(apply, /return \{ project: null, errors: \[`Failed to rename directory/,
      'and the one that remains is the rename failing as I/O, not as a judgement');
  });
});
