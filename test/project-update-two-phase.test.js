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

/**
 * `_applyProjectUpdates`'s source, sliced at both ends.
 *
 * Shared because two checks read it: the roster of fields the write phase acts
 * on, and the guard that no verdict survives in it. Two copies of the slice is
 * two chances for one of them to silently read a truncated prefix and measure a
 * smaller function than it names; the end anchor is asserted once, below.
 *
 * @returns {string} The function's source, from its declaration to its closing brace.
 */
function applyPhaseSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'projects.js'), 'utf8');
  const start = src.indexOf('async function _applyProjectUpdates(');
  if (start < 0) throw new Error('_applyProjectUpdates not found in lib/projects.js');
  const end = src.indexOf('\n}\n', start);
  if (end < start) throw new Error('_applyProjectUpdates has no findable closing brace');
  return src.slice(start, end);
}

/**
 * Give a project the plan file `VALID_SETTINGS_PATCH.activePlan` names.
 *
 * `activePlan` is validated against the plans directory the wrap step resolves,
 * so a fixture without the file exercises the REJECTION path and never the
 * write — which would quietly make the batch one field smaller than it looks.
 *
 * @param {string} name - Project name.
 */
function seedPlan(name) {
  const dir = path.join(store.projects.getByName(name).path, '.tangleclaw', 'plans');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, VALID_SETTINGS_PATCH.activePlan), '# a plan\n');
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

  it('a throw after the rename still leaves the row naming a directory that exists', async () => {
    // The write phase's own half of the same defect. Validation is all-or-
    // nothing, but a rename is two writes to two stores, and everything after
    // it can throw: `store.projectConfig.save` is a bare `mkdirSync`/
    // `writeFileSync`. With the row flushed at the END of the function, an
    // EACCES/ENOSPC anywhere in between propagated out with the directory moved
    // and the row naming the old path — #1033's unopenable project, reached by
    // an exception instead of a verdict. Nothing can make two stores atomic;
    // what is pinned is that the row moves WITH the directory rather than
    // fifteen writes later.
    projects.createProject({ name: 'two-phase-throw' });
    const saved = store.projectConfig.save;
    store.projectConfig.save = () => { throw new Error('EACCES: permission denied'); };
    try {
      await assert.rejects(
        () => projects.updateProject('two-phase-throw', {
          name: 'two-phase-thrown', medusaEnabled: true
        }),
        /EACCES/);
    } finally {
      store.projectConfig.save = saved;
    }

    const row = store.projects.getByName('two-phase-thrown');
    assert.ok(row, 'the row must have moved with the directory');
    assert.equal(fs.existsSync(row.path), true,
      'the row must not name a path the rename left behind');
    assert.equal(store.projects.getByName('two-phase-throw'), null,
      'and the old name must not still resolve');
  });

  it('a full settings save with one bad field writes none of the good ones', async () => {
    // The fields come from what the settings modal actually PATCHes (see the
    // producer-derived roster below), so this grows with the modal rather than
    // with a list someone remembered to update. Every field here wants to write
    // something — project.json keys, a seeded FEATURES.md, a directory rename —
    // and none of it may survive one rejected field.
    projects.createProject({ name: 'two-phase-batch', engine: 'claude' });
    seedPlan('two-phase-batch');
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
    seedPlan('two-phase-control');
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
  activePlan: 'a-plan.md',
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
  // The session page is the OTHER producer: its engine picker and its wrap-drawer
  // plan picker each PATCH this endpoint with a body the modal never sends. Both
  // are single-key today, which is exactly why reading only the modal looked
  // sufficient — a second key added to either would have been invisible.
  const sessionJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');

  /** @returns {string[]} Every field the browser puts in a projects PATCH body. */
  function modalFields() {
    const keys = new Set();
    // The two ways a field gets into the settings body: the initial object
    // literal, and `body.x =`.
    const literal = body.slice(body.indexOf('const body = {'), body.indexOf('};'));
    for (const m of literal.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)) keys.add(m[1]);
    for (const m of body.matchAll(/\bbody\.([A-Za-z][A-Za-z0-9]*)\s*=/g)) keys.add(m[1]);
    // session.js writes its bodies inline at the `apiMutate` call, so the keys
    // are read from the object literal that follows each projects PATCH.
    for (const m of sessionJs.matchAll(
      /apiMutate\(\s*`\/api\/projects\/[^`]*`,\s*\n?\s*'PATCH',\s*\n?\s*\{([^}]*)\}/g)) {
      for (const k of m[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\s*[:,}]/g)) keys.add(k[1]);
    }
    return [...keys];
  }

  /**
   * Every field the WRITE phase acts on — the widest roster there is, because a
   * field can only be persisted by being read here. The modal's roster cannot
   * see a field no browser sends (`quickCommands`, `rules`), which is how one
   * reached `project.json` with no verdict and nothing red.
   *
   * @returns {string[]} Field names read from `updates` in `_applyProjectUpdates`.
   */
  function writtenFields() {
    return [...new Set([...applyPhaseSource().matchAll(/\bupdates\.([A-Za-z][A-Za-z0-9]*)/g)]
      .map((m) => m[1]))];
  }

  it('finds both rosters at all', () => {
    // Guards every assertion below from passing on an empty set — each slice is
    // anchored on a name, and any of them moving would otherwise make this whole
    // describe vacuously green.
    const fields = modalFields();
    assert.ok(fields.length >= 10, `only found ${fields.length}: ${fields.join(', ')}`);
    assert.ok(fields.includes('engine') && fields.includes('tags'));
    assert.ok(fields.includes('activePlan'),
      'the session page\'s plan picker is a PATCH producer too');
    const written = writtenFields();
    assert.ok(written.length >= 15, `only found ${written.length}: ${written.join(', ')}`);
    assert.ok(written.includes('quickCommands') && written.includes('rules'),
      'the write phase acts on fields no browser sends');
  });

  it('every field the modal sends has a valid value in the fixture', () => {
    for (const field of modalFields()) {
      assert.ok(Object.prototype.hasOwnProperty.call(VALID_SETTINGS_PATCH, field),
        `the settings modal sends "${field}" — add a valid value for it to `
        + 'VALID_SETTINGS_PATCH so the partial-update tests exercise it');
    }
  });

  it('every field that reaches the write phase is known to the validator table', () => {
    // Both rosters, because neither contains the other: the browser can send a
    // field the write phase ignores, and the write phase acts on fields
    // (`rules`, `quickCommands`) no browser sends.
    //
    // The two exceptions are declared, not overlooked. Nothing validates `tags`
    // or `quickCommands` today, so a non-array is stringified into storage and
    // read back as a string where every reader expects an array (#1287, which
    // empties this set). A field that is validated nowhere and declared nowhere
    // fails here — which is how `quickCommands` was found.
    const unvalidated = new Set(['tags', 'quickCommands']);
    const known = new Set(projects._PROJECT_UPDATE_VALIDATORS
      .flatMap((v) => [...v.keys, ...(v.reads || [])]));
    for (const field of [...modalFields(), ...writtenFields()]) {
      assert.ok(known.has(field) || unvalidated.has(field),
        `"${field}" reaches updateProject and no validator names it — `
        + 'give it a table entry, or add it to the declared-unvalidated set');
    }
  });
});

describe('the apply phase cannot refuse a field', () => {
  // The structural half. Every verdict on the input belongs to the validators;
  // if a later field's rejection can be written into the write phase again, so
  // can #1033. A source read, so it sees a `return`, not a `throw` — the limit
  // is named rather than papered over.
  const apply = applyPhaseSource();

  it('the slice actually covers the apply phase, end included', () => {
    // A length floor alone is satisfied by any long enough PREFIX, so the slice
    // is pinned at both ends: it must reach the function's terminal statement.
    // Everything below counts occurrences, and a count over a truncated region
    // is green for the wrong reason.
    assert.match(apply, /^async function _applyProjectUpdates\(/,
      'the slice must start at the function');
    assert.match(apply, /return \{ project: updated, errors, warnings \};\s*$/,
      'the slice must end at the function\'s own last statement');
  });

  it('returns a null project for exactly one reason, and it is not a verdict', () => {
    // Matched by SHAPE, not by one spelling: `return { errors: [...], project:
    // null }` refuses a field just as well as `return { project: null, ... }`,
    // and pinning the literal would let the second form reintroduce #1033 with
    // the count still reading 1.
    const nulls = [...apply.matchAll(/return \{[^;]*\bproject: null/g)].length;
    assert.equal(nulls, 1,
      'a second null-project return in the write phase is a field being refused '
      + 'after earlier fields were written — put its verdict in PROJECT_UPDATE_VALIDATORS');
    assert.match(apply, /return \{[^;]*\bproject: null[^;]*Failed to rename directory/,
      'and the one that remains is the rename failing as I/O, not as a judgement');
  });
});
