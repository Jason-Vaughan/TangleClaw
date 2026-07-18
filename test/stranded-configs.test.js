'use strict';

/**
 * Tests for the stranded-ancestor-config guard (#592).
 *
 * The incident shape: a project's registration moved deeper into its own
 * directory tree (old root archived/deleted, new project created at a
 * subdirectory — TiLT v2), stranding the old root's generated CLAUDE.md and
 * `.claude/settings.json`. Claude Code loads every ancestor CLAUDE.md, so
 * the stale file re-injected retired V1 governance into every session of
 * the nested project. The guard detects and surfaces; it never deletes.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');
const { createServer } = require('../server');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('_findStrandedAncestorConfigs (#592)', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stranded-helper-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function mkdirs(rel) {
    const p = path.join(root, rel);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  it('flags an unregistered ancestor dir holding CLAUDE.md (the TiLT v2 shape)', () => {
    const inner = mkdirs('TiLT v2/tilt-v2');
    fs.writeFileSync(path.join(root, 'TiLT v2', 'CLAUDE.md'), '# stale V1 playbook\n');

    const out = projects._findStrandedAncestorConfigs(inner, new Set([inner]), root);
    assert.equal(out.length, 1);
    assert.equal(out[0].dir, path.join(root, 'TiLT v2'));
    assert.deepStrictEqual(out[0].files, ['CLAUDE.md']);
  });

  it('flags a stranded .claude/settings.json (hook-injection hazard)', () => {
    const inner = mkdirs('nest/repo');
    mkdirs('nest/.claude');
    fs.writeFileSync(path.join(root, 'nest', '.claude', 'settings.json'), '{}');

    const out = projects._findStrandedAncestorConfigs(inner, new Set([inner]), root);
    assert.equal(out.length, 1);
    assert.deepStrictEqual(out[0].files, [path.join('.claude', 'settings.json')]);
  });

  it('reports both files when an ancestor holds CLAUDE.md and settings.json', () => {
    const inner = mkdirs('both/repo');
    mkdirs('both/.claude');
    fs.writeFileSync(path.join(root, 'both', 'CLAUDE.md'), 'x');
    fs.writeFileSync(path.join(root, 'both', '.claude', 'settings.json'), '{}');

    const out = projects._findStrandedAncestorConfigs(inner, new Set([inner]), root);
    assert.equal(out.length, 1);
    assert.equal(out[0].files.length, 2);
  });

  it('does NOT flag an ancestor that is a registered project root', () => {
    const parent = mkdirs('parent');
    const inner = mkdirs('parent/child');
    fs.writeFileSync(path.join(parent, 'CLAUDE.md'), '# parent project config\n');

    const out = projects._findStrandedAncestorConfigs(inner, new Set([inner, parent]), root);
    assert.deepStrictEqual(out, []);
  });

  it('does NOT scan the projects root itself or above it', () => {
    const inner = mkdirs('direct-child');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# operator-wide, presumed intentional\n');

    const out = projects._findStrandedAncestorConfigs(inner, new Set([inner]), root);
    assert.deepStrictEqual(out, []);
  });

  it('walks multiple intermediate levels, nearest first', () => {
    const inner = mkdirs('a/b/repo');
    fs.writeFileSync(path.join(root, 'a', 'CLAUDE.md'), 'x');
    fs.writeFileSync(path.join(root, 'a', 'b', 'CLAUDE.md'), 'y');

    const out = projects._findStrandedAncestorConfigs(inner, new Set([inner]), root);
    assert.deepStrictEqual(out.map((f) => f.dir), [
      path.join(root, 'a', 'b'),
      path.join(root, 'a')
    ]);
  });

  it('returns empty for a project outside the projects root (never walks foreign trees)', () => {
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-foreign-'));
    try {
      const p = path.join(foreign, 'deep', 'repo');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(foreign, 'deep', 'CLAUDE.md'), 'x');
      assert.deepStrictEqual(projects._findStrandedAncestorConfigs(p, new Set(), root), []);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('handles null/empty inputs gracefully', () => {
    assert.deepStrictEqual(projects._findStrandedAncestorConfigs(null, new Set(), root), []);
    assert.deepStrictEqual(projects._findStrandedAncestorConfigs('/x', new Set(), null), []);
  });
});

describe('scanForStrandedConfigs (#592)', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stranded-scan-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const p of store.projects.list({ archived: true })) {
      store.projects.delete(p.id);
    }
    for (const entry of fs.readdirSync(projectsDir)) {
      fs.rmSync(path.join(projectsDir, entry), { recursive: true, force: true });
    }
  });

  function registerProject(rel, { archived = false } = {}) {
    const projectPath = path.join(projectsDir, rel);
    fs.mkdirSync(projectPath, { recursive: true });
    const name = rel.replace(/[/\\]/g, '-');
    store.projects.create({
      name, path: projectPath, engine: 'claude', methodology: 'minimal', tags: [], ports: {}
    });
    if (archived) {
      store.projects.archive(store.projects.getByName(name).id);
    }
    return { name, path: projectPath };
  }

  it('regression — the TiLT v2 incident: stranded parent CLAUDE.md above a registered nested repo is reported', () => {
    const inner = registerProject('TiLT v2/tilt-v2');
    fs.writeFileSync(path.join(projectsDir, 'TiLT v2', 'CLAUDE.md'), '## Session Playbook: Prawduct\n');

    const result = projects.scanForStrandedConfigs();
    assert.equal(result.scanned, 1);
    assert.equal(result.stranded.length, 1);
    assert.equal(result.stranded[0].dir, path.join(projectsDir, 'TiLT v2'));
    assert.deepStrictEqual(result.stranded[0].files, ['CLAUDE.md']);
    assert.deepStrictEqual(result.stranded[0].affectedProjects, [inner.name]);
    assert.deepStrictEqual(result.errors, []);
  });

  it('does NOT report a parent that is a registered (even archived) project', () => {
    registerProject('mono', { archived: true });
    registerProject('mono/app');
    fs.writeFileSync(path.join(projectsDir, 'mono', 'CLAUDE.md'), '# archived parent config\n');

    const result = projects.scanForStrandedConfigs();
    assert.deepStrictEqual(result.stranded, []);
  });

  it('deduplicates a stranded dir shared by multiple nested projects', () => {
    const a = registerProject('shared/app-a');
    const b = registerProject('shared/app-b');
    fs.writeFileSync(path.join(projectsDir, 'shared', 'CLAUDE.md'), 'x');

    const result = projects.scanForStrandedConfigs();
    assert.equal(result.stranded.length, 1);
    assert.deepStrictEqual(
      result.stranded[0].affectedProjects.sort(),
      [a.name, b.name].sort()
    );
  });

  it('returns empty on a clean fleet', () => {
    registerProject('clean-a');
    registerProject('nested/clean-b');

    const result = projects.scanForStrandedConfigs();
    assert.equal(result.scanned, 2);
    assert.deepStrictEqual(result.stranded, []);
  });

  it('captures a config-load failure as a "(config)" error instead of throwing', () => {
    registerProject('any');
    const configFile = path.join(tmpDir, 'tangleclaw', 'config.json');
    const original = fs.readFileSync(configFile, 'utf8');
    try {
      fs.writeFileSync(configFile, '{ not json');
      const result = projects.scanForStrandedConfigs();
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].name, '(config)');
      assert.match(result.errors[0].error, /projectsDir resolve failed/);
      assert.deepStrictEqual(result.stranded, []);
      assert.equal(result.scanned, 0);
    } finally {
      fs.writeFileSync(configFile, original);
    }
  });
});

describe('stranded-configs API (#592)', () => {
  let server;
  let port;
  let tmpDir;
  let projectsDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stranded-api-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function get(urlPath) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        });
      }).on('error', reject);
    });
  }

  it('GET /api/projects/stranded-configs-scan returns the read-only inventory', async () => {
    const inner = path.join(projectsDir, 'outer', 'inner-repo');
    fs.mkdirSync(inner, { recursive: true });
    store.projects.create({
      name: 'inner-repo', path: inner, engine: 'claude', methodology: 'minimal', tags: [], ports: {}
    });
    fs.writeFileSync(path.join(projectsDir, 'outer', 'CLAUDE.md'), 'stale\n');

    const res = await get('/api/projects/stranded-configs-scan');
    assert.equal(res.status, 200);
    assert.equal(res.data.stranded.length, 1);
    assert.equal(res.data.stranded[0].dir, path.join(projectsDir, 'outer'));
    // Read-only contract: the stranded file must still exist after the scan.
    assert.ok(fs.existsSync(path.join(projectsDir, 'outer', 'CLAUDE.md')));
  });

  it('does not shadow GET /api/projects/:name (literal route registered first)', async () => {
    const res = await get('/api/projects/inner-repo');
    assert.equal(res.status, 200);
    assert.equal(res.data.name ?? res.data.project?.name, 'inner-repo');
  });
});
