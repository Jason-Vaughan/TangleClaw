'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');
const { createServer } = require('../server');

// ── Helpers ──

function writeSettings(projectPath, hooks, extraKeys = {}) {
  const settingsDir = path.join(projectPath, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settings = { ...extraKeys };
  if (hooks !== null) settings.hooks = hooks;
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

function readSettings(projectPath) {
  return JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf8'));
}

function orphanStopEntry(scriptPath = 'tools/product-hook') {
  return {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `python3 "$CLAUDE_PROJECT_DIR/${scriptPath}" stop`,
      statusMessage: 'Checking governance gates...'
    }]
  };
}

function presentEntry(scriptPath) {
  return {
    matcher: 'startup',
    hooks: [{
      type: 'command',
      command: `bash "$CLAUDE_PROJECT_DIR/${scriptPath}"`,
      statusMessage: 'Loading...'
    }]
  };
}

describe('orphan hook helpers (#145, chunk 2)', () => {
  describe('_extractClaudeProjectDirPaths', () => {
    it('extracts $CLAUDE_PROJECT_DIR/<path> references', () => {
      const out = projects._extractClaudeProjectDirPaths('python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop');
      assert.deepStrictEqual(out, ['tools/product-hook']);
    });

    it('extracts ${CLAUDE_PROJECT_DIR}/<path> references', () => {
      const out = projects._extractClaudeProjectDirPaths('cat "${CLAUDE_PROJECT_DIR}/.tangleclaw/session-prime.md"');
      assert.deepStrictEqual(out, ['.tangleclaw/session-prime.md']);
    });

    it('returns empty array for commands with no env-var path refs', () => {
      assert.deepStrictEqual(projects._extractClaudeProjectDirPaths('echo hello'), []);
      assert.deepStrictEqual(projects._extractClaudeProjectDirPaths(''), []);
      assert.deepStrictEqual(projects._extractClaudeProjectDirPaths(null), []);
    });

    it('extracts multiple refs from one command', () => {
      const cmd = 'cp "$CLAUDE_PROJECT_DIR/a/x" "${CLAUDE_PROJECT_DIR}/b/y"';
      const out = projects._extractClaudeProjectDirPaths(cmd);
      assert.deepStrictEqual(out, ['a/x', 'b/y']);
    });

    it('strips trailing punctuation from captured paths', () => {
      const cmd = '$CLAUDE_PROJECT_DIR/tools/hook,$CLAUDE_PROJECT_DIR/tools/other;';
      const out = projects._extractClaudeProjectDirPaths(cmd);
      assert.deepStrictEqual(out, ['tools/hook', 'tools/other']);
    });
  });

  describe('_hookEntryOrphanMissing', () => {
    let projectDir;
    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-orphan-helper-'));
    });
    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it('returns empty when all $CLAUDE_PROJECT_DIR refs exist', () => {
      fs.mkdirSync(path.join(projectDir, 'tools'));
      fs.writeFileSync(path.join(projectDir, 'tools', 'hook'), '');
      const missing = projects._hookEntryOrphanMissing(presentEntry('tools/hook'), projectDir);
      assert.deepStrictEqual(missing, []);
    });

    it('returns the missing refs when the file is absent', () => {
      const missing = projects._hookEntryOrphanMissing(orphanStopEntry(), projectDir);
      assert.deepStrictEqual(missing, ['tools/product-hook']);
    });

    it('skips traversal and absolute refs (fails open, not orphan)', () => {
      // Even though "../etc/passwd" doesn't exist in the project, traversal
      // refs are intentionally not auto-stripped — they're user error, not
      // an injection bug; the repair pathway should leave them alone.
      const traversal = {
        matcher: '',
        hooks: [{ type: 'command', command: 'cat "$CLAUDE_PROJECT_DIR/../etc/passwd"' }]
      };
      assert.deepStrictEqual(projects._hookEntryOrphanMissing(traversal, projectDir), []);
    });

    it('handles entries with no `hooks` array gracefully', () => {
      assert.deepStrictEqual(projects._hookEntryOrphanMissing({}, projectDir), []);
      assert.deepStrictEqual(projects._hookEntryOrphanMissing(null, projectDir), []);
      assert.deepStrictEqual(projects._hookEntryOrphanMissing({ hooks: 'not-array' }, projectDir), []);
    });
  });
});

describe('scanForOrphanHooks (#145, chunk 2)', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scan-'));
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
    // Wipe all registered projects between tests for isolation.
    for (const p of store.projects.list({ archived: true })) {
      store.projects.delete(p.id);
    }
  });

  function registerProject(name) {
    const projectPath = path.join(projectsDir, name);
    fs.mkdirSync(projectPath, { recursive: true });
    store.projects.create({
      name, path: projectPath, engine: 'claude', methodology: 'minimal', tags: [], ports: {}
    });
    return projectPath;
  }

  it('flags a project whose Stop hook references a missing path', () => {
    const p = registerProject('orphan-a');
    writeSettings(p, { Stop: [orphanStopEntry()] });

    const result = projects.scanForOrphanHooks();
    assert.equal(result.scanned, 1);
    assert.equal(result.projectsWithOrphans.length, 1);
    assert.equal(result.projectsWithOrphans[0].name, 'orphan-a');
    assert.deepStrictEqual(result.projectsWithOrphans[0].orphans[0].missing, ['tools/product-hook']);
  });

  it('does NOT flag a project whose hook references an existing path (Notse-shape)', () => {
    const p = registerProject('working');
    fs.mkdirSync(path.join(p, 'tools'));
    fs.writeFileSync(path.join(p, 'tools', 'product-hook'), '#!/bin/sh\n');
    writeSettings(p, { Stop: [orphanStopEntry()] });

    const result = projects.scanForOrphanHooks();
    assert.equal(result.scanned, 1);
    assert.deepStrictEqual(result.projectsWithOrphans, []);
  });

  it('TC-v3 incident shape: flags orphan prawduct entries but preserves the silentPrime absolute-path entry', () => {
    // The live incident: orphan $CLAUDE_PROJECT_DIR/tools/product-hook entries
    // alongside a legitimate silentPrime SessionStart hook using an absolute
    // path to data/hooks/sessionstart-prime.sh. Only the env-var entries should
    // be flagged; the absolute-path entry must not appear as orphan.
    const p = registerProject('tc-incident');
    writeSettings(p, {
      SessionStart: [
        {
          matcher: 'startup|clear|resume',
          hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
        },
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: `${p}/data/hooks/sessionstart-prime.sh` }]
        }
      ],
      Stop: [orphanStopEntry()]
    });

    const result = projects.scanForOrphanHooks();
    const inv = result.projectsWithOrphans[0];
    assert.ok(inv, 'should detect orphans');
    // Two orphan entries (one SessionStart "clear" + one Stop), zero from the absolute-path silentPrime entry
    assert.equal(inv.orphans.length, 2);
    assert.ok(inv.orphans.some((o) => o.event === 'SessionStart' && o.matcher === 'startup|clear|resume'));
    assert.ok(inv.orphans.some((o) => o.event === 'Stop'));
    assert.ok(!inv.orphans.some((o) => o.event === 'SessionStart' && o.matcher === 'startup'),
      'the silentPrime entry must not be flagged');
  });

  it('skips projects with no .claude/settings.json', () => {
    registerProject('bare');
    const result = projects.scanForOrphanHooks();
    assert.equal(result.scanned, 1);
    assert.deepStrictEqual(result.projectsWithOrphans, []);
  });

  it('records a parse error when settings.json is malformed', () => {
    const p = registerProject('malformed');
    fs.mkdirSync(path.join(p, '.claude'));
    fs.writeFileSync(path.join(p, '.claude', 'settings.json'), '{ this is not json');
    const result = projects.scanForOrphanHooks();
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].name, 'malformed');
    assert.match(result.errors[0].error, /parse/i);
  });

  it('skips archived projects', () => {
    const p = registerProject('archived');
    writeSettings(p, { Stop: [orphanStopEntry()] });
    const proj = store.projects.getByName('archived');
    store.projects.archive(proj.id);
    const result = projects.scanForOrphanHooks();
    assert.equal(result.scanned, 0);
    assert.deepStrictEqual(result.projectsWithOrphans, []);
  });

  it('reports inner-command details (matcher, missing, commands) for the dashboard banner', () => {
    const p = registerProject('detail');
    writeSettings(p, {
      Stop: [{
        matcher: 'foo',
        hooks: [
          { type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/missing-a" stop' },
          { type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/missing-b" stop' }
        ]
      }]
    });
    const inv = projects.scanForOrphanHooks().projectsWithOrphans[0];
    assert.equal(inv.orphans[0].event, 'Stop');
    assert.equal(inv.orphans[0].matcher, 'foo');
    assert.deepStrictEqual(inv.orphans[0].missing.sort(), ['tools/missing-a', 'tools/missing-b']);
    assert.equal(inv.orphans[0].commands.length, 2);
  });
});

describe('repairOrphanHooks (#145, chunk 2)', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-repair-'));
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
  });

  function registerProject(name) {
    const projectPath = path.join(projectsDir, name);
    fs.mkdirSync(projectPath, { recursive: true });
    store.projects.create({
      name, path: projectPath, engine: 'claude', methodology: 'minimal', tags: [], ports: {}
    });
    return projectPath;
  }

  it('strips orphan entries and preserves non-orphan entries in the same event', () => {
    const p = registerProject('mixed');
    fs.mkdirSync(path.join(p, 'data', 'hooks'), { recursive: true });
    const presentScript = `${p}/data/hooks/prime.sh`;
    fs.writeFileSync(presentScript, '');
    writeSettings(p, {
      SessionStart: [
        { matcher: 'startup|clear|resume', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }] },
        { matcher: 'startup', hooks: [{ type: 'command', command: presentScript }] }
      ]
    });

    const result = projects.repairOrphanHooks();
    assert.equal(result.repaired.length, 1);
    assert.equal(result.repaired[0].name, 'mixed');
    assert.equal(result.repaired[0].removed.length, 1);

    const after = readSettings(p);
    assert.equal(after.hooks.SessionStart.length, 1);
    assert.equal(after.hooks.SessionStart[0].matcher, 'startup');
  });

  it('preserves non-hook keys (companyAnnouncements, etc.)', () => {
    const p = registerProject('preserves');
    writeSettings(p, { Stop: [orphanStopEntry()] }, {
      companyAnnouncements: ['banner-line'],
      permissions: { allow: ['Bash'] }
    });

    projects.repairOrphanHooks();
    const after = readSettings(p);
    assert.deepStrictEqual(after.companyAnnouncements, ['banner-line']);
    assert.deepStrictEqual(after.permissions, { allow: ['Bash'] });
    assert.equal(after.hooks, undefined, 'hooks block should be removed entirely since Stop was the only entry');
  });

  it('removes the hooks block entirely when all entries are orphan', () => {
    const p = registerProject('all-orphan');
    writeSettings(p, {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/x" clear' }] }],
      Stop: [orphanStopEntry()]
    });

    projects.repairOrphanHooks();
    const after = readSettings(p);
    assert.equal(after.hooks, undefined);
  });

  it('is idempotent: second call is a no-op (skipped with reason)', () => {
    const p = registerProject('idem');
    writeSettings(p, { Stop: [orphanStopEntry()] });

    const first = projects.repairOrphanHooks();
    assert.equal(first.repaired.length, 1);

    const second = projects.repairOrphanHooks();
    assert.equal(second.repaired.length, 0);
    assert.ok(second.skipped.some((s) => s.name === 'idem'));
  });

  it('single-target repair via projectName', () => {
    const pa = registerProject('alpha');
    const pb = registerProject('beta');
    writeSettings(pa, { Stop: [orphanStopEntry()] });
    writeSettings(pb, { Stop: [orphanStopEntry()] });

    const result = projects.repairOrphanHooks('alpha');
    assert.equal(result.repaired.length, 1);
    assert.equal(result.repaired[0].name, 'alpha');

    // beta untouched
    const betaAfter = readSettings(pb);
    assert.ok(betaAfter.hooks.Stop, 'beta should still have its orphan block — single-target should not touch it');
  });

  it('returns a Project not found error when projectName does not exist', () => {
    const result = projects.repairOrphanHooks('does-not-exist');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].name, 'does-not-exist');
    assert.match(result.errors[0].error, /not found/i);
  });

  it('skips with reason when project has no .claude/settings.json', () => {
    registerProject('bare-repair');
    const result = projects.repairOrphanHooks();
    assert.ok(result.skipped.some((s) => s.name === 'bare-repair' && /settings\.json/.test(s.reason)));
  });

  it('does not rewrite the file when no orphans are found (mtime preserved)', () => {
    const p = registerProject('clean');
    fs.mkdirSync(path.join(p, 'data', 'hooks'), { recursive: true });
    const presentScript = `${p}/data/hooks/prime.sh`;
    fs.writeFileSync(presentScript, '');
    writeSettings(p, { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: presentScript }] }] });

    const settingsPath = path.join(p, '.claude', 'settings.json');
    const before = fs.statSync(settingsPath).mtimeMs;
    // Wait briefly so mtime can advance if a write occurs
    const waitUntil = Date.now() + 10;
    while (Date.now() < waitUntil) { /* spin */ }
    projects.repairOrphanHooks();
    const afterMtime = fs.statSync(settingsPath).mtimeMs;
    assert.equal(afterMtime, before, 'no-orphan project should not be rewritten');
  });
});

describe('orphan-hooks API (#145, chunk 2)', () => {
  let server;
  let port;
  let tmpDir;
  let projectsDir;

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1', port, path: urlPath, method,
        headers: { 'Content-Type': 'application/json' }
      };
      const bodyStr = body ? JSON.stringify(body) : null;
      if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-orphan-api-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    cfg.deletePassword = null;
    store.config.save(cfg);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const p of store.projects.list({ archived: true })) {
      store.projects.delete(p.id);
    }
  });

  function registerProject(name) {
    const projectPath = path.join(projectsDir, name);
    fs.mkdirSync(projectPath, { recursive: true });
    store.projects.create({
      name, path: projectPath, engine: 'claude', methodology: 'minimal', tags: [], ports: {}
    });
    return projectPath;
  }

  it('GET /api/projects/orphan-hooks-scan returns 200 + inventory', async () => {
    const p = registerProject('api-orphan');
    writeSettings(p, { Stop: [orphanStopEntry()] });
    const { status, data } = await request('GET', '/api/projects/orphan-hooks-scan');
    assert.equal(status, 200);
    assert.equal(data.scanned, 1);
    assert.equal(data.projectsWithOrphans.length, 1);
    assert.equal(data.projectsWithOrphans[0].name, 'api-orphan');
  });

  it('GET /api/projects/orphan-hooks-scan does NOT collide with GET /api/projects/:name', async () => {
    // Regression: ensure literal /orphan-hooks-scan route is registered before
    // the parameterized :name route. Without that ordering, a GET would land
    // on getProject('orphan-hooks-scan') and 404.
    const { status, data } = await request('GET', '/api/projects/orphan-hooks-scan');
    assert.equal(status, 200);
    assert.ok(typeof data.scanned === 'number', 'inventory shape, not project shape');
  });

  it('POST /api/projects/repair-orphan-hooks (no body) repairs all', async () => {
    const p = registerProject('api-repair-all');
    writeSettings(p, { Stop: [orphanStopEntry()] });
    const { status, data } = await request('POST', '/api/projects/repair-orphan-hooks', {});
    assert.equal(status, 200);
    assert.equal(data.repaired.length, 1);
    assert.equal(data.repaired[0].name, 'api-repair-all');
    const after = readSettings(p);
    assert.equal(after.hooks, undefined);
  });

  it('POST with { project: <name> } repairs a single project', async () => {
    const pa = registerProject('api-single-a');
    const pb = registerProject('api-single-b');
    writeSettings(pa, { Stop: [orphanStopEntry()] });
    writeSettings(pb, { Stop: [orphanStopEntry()] });
    const { status, data } = await request('POST', '/api/projects/repair-orphan-hooks', { project: 'api-single-a' });
    assert.equal(status, 200);
    assert.equal(data.repaired.length, 1);
    assert.equal(data.repaired[0].name, 'api-single-a');
    // b untouched
    const bAfter = readSettings(pb);
    assert.ok(bAfter.hooks);
  });

  it('POST with non-string `project` returns 400 BAD_REQUEST', async () => {
    const { status, data } = await request('POST', '/api/projects/repair-orphan-hooks', { project: 42 });
    assert.equal(status, 400);
    assert.equal(data.code, 'BAD_REQUEST');
  });

  it('POST with non-existent `project` returns 404 NOT_FOUND', async () => {
    const { status, data } = await request('POST', '/api/projects/repair-orphan-hooks', { project: 'nope' });
    assert.equal(status, 404);
    assert.equal(data.code, 'NOT_FOUND');
  });
});
