'use strict';

/**
 * #3289 — `attachProject(name, options)` honoring `options.path`/
 * `options.engine`, which `server.js`'s route handler and
 * `public/v6-shell.js`'s V6 Standalone Project Wizard already send but
 * this function silently ignored (`projects.attachProject(body.name)`,
 * dropping `body.path`/`body.engine` entirely). The route handler and the
 * UI surfacing (an "Unregistered on Disk" picker) are OUT of this car's
 * scope — `server.js` and `public/v6-shell.js` are both claimed by other
 * cars this train; this file tests `attachProject` itself directly,
 * exactly as a route handler that DID forward `body.path`/`body.engine`
 * would call it. #3289 stays open for that wiring.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

let projects;
let tmpDir;
let projectsDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-attach-unregistered-'));
  store._setBasePath(tmpDir);
  store.init();
  projectsDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const config = store.config.load();
  config.projectsDir = projectsDir;
  store.config.save(config);
  projects = require('../lib/projects');
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A real directory under `projectsDir`, so a stat-based "does it exist" check finds it for real. */
function seedDir(dirName) {
  const full = path.join(projectsDir, dirName);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

describe('attachProject — options.path', () => {
  it('still attaches by bare name with no options, unchanged (back-compat)', async () => {
    seedDir('plain-dir');
    const { project, errors } = await projects.attachProject('plain-dir');
    assert.deepEqual(errors, []);
    assert.equal(project.name, 'plain-dir');
    assert.equal(project.path, path.join(projectsDir, 'plain-dir'));
  });

  it('attaches by options.path as a bare directory NAME, registered under a DIFFERENT project name', async () => {
    seedDir('BarCoach');
    const { project, errors } = await projects.attachProject('My Bar App', { path: 'BarCoach' });
    assert.deepEqual(errors, []);
    assert.equal(project.name, 'My Bar App');
    assert.equal(project.path, path.join(projectsDir, 'BarCoach'));
  });

  it('attaches by options.path as an ABSOLUTE path directly under projectsDir', async () => {
    const full = seedDir('Graphics Projects');
    const { project, errors } = await projects.attachProject('Graphics', { path: full });
    assert.deepEqual(errors, []);
    assert.equal(project.path, full);
  });

  it('refuses an absolute path that is NOT a direct child of projectsDir — never opens attach to an arbitrary filesystem location', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-attach-outside-'));
    try {
      const { project, errors } = await projects.attachProject('outside-proj', { path: outside });
      assert.equal(project, null);
      assert.match(errors[0], /must be a direct subdirectory of the Projects directory/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses an absolute path nested two levels under projectsDir, not just a sibling elsewhere', async () => {
    const nested = path.join(projectsDir, 'parent', 'child');
    fs.mkdirSync(nested, { recursive: true });
    const { project, errors } = await projects.attachProject('nested-proj', { path: nested });
    assert.equal(project, null);
    assert.match(errors[0], /must be a direct subdirectory of the Projects directory/);
  });

  it('"Directory not found" names the requested path, not the registered name, when they differ', async () => {
    const { project, errors } = await projects.attachProject('My App', { path: 'does-not-exist' });
    assert.equal(project, null);
    assert.match(errors[0], /"does-not-exist" not found/);
  });

  it('an empty/whitespace-only options.path falls back to the default name-based lookup, same as omitting it', async () => {
    seedDir('fallback-dir');
    // Registered name must equal the dir name here since no path was
    // genuinely supplied — this proves "" behaves like "omitted", not
    // like "look up a dir literally named ''".
    const { project, errors } = await projects.attachProject('fallback-dir', { path: '  ' });
    assert.deepEqual(errors, []);
    assert.equal(project.path, path.join(projectsDir, 'fallback-dir'));
  });
});

describe('attachProject — options.engine', () => {
  it('registers with the explicitly requested engine, overriding the configured default', async () => {
    seedDir('engine-override-dir');
    const { project, errors } = await projects.attachProject('engine-override-dir', { engine: 'codex' });
    assert.deepEqual(errors, []);
    assert.equal(project.engine.id, 'codex');
  });

  it('refuses with a clear error for an unknown engine id — never silently registered unchecked', async () => {
    seedDir('bad-engine-dir');
    const { project, errors } = await projects.attachProject('bad-engine-dir', { engine: 'not-a-real-engine' });
    assert.equal(project, null);
    assert.deepEqual(errors, ['Engine "not-a-real-engine" not found']);
  });

  it('overrides an engine already recorded in an existing project.json on disk', async () => {
    const full = seedDir('has-config-dir');
    fs.mkdirSync(path.join(full, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(full, '.tangleclaw', 'project.json'), JSON.stringify({ engine: 'claude' }));
    const { project, errors } = await projects.attachProject('has-config-dir', { engine: 'codex' });
    assert.deepEqual(errors, []);
    assert.equal(project.engine.id, 'codex');
  });

  it('with no options.engine, an existing project.json\'s engine still wins, unchanged', async () => {
    const full = seedDir('keeps-config-dir');
    fs.mkdirSync(path.join(full, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(full, '.tangleclaw', 'project.json'), JSON.stringify({ engine: 'codex' }));
    const { project, errors } = await projects.attachProject('keeps-config-dir');
    assert.deepEqual(errors, []);
    assert.equal(project.engine.id, 'codex');
  });
});

describe('attachProject — path + engine together', () => {
  it('both options apply at once: a renamed, re-pathed, engine-overridden attach', async () => {
    const full = seedDir('Dockerization');
    const { project, errors } = await projects.attachProject('Docker Tools', { path: full, engine: 'codex' });
    assert.deepEqual(errors, []);
    assert.equal(project.name, 'Docker Tools');
    assert.equal(project.path, full);
    assert.equal(project.engine.id, 'codex');
  });
});
