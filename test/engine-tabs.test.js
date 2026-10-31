'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const engineTabs = require('../lib/engine-tabs');
const store = require('../lib/store');
const { createServer } = require('../server');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('lib/engine-tabs (#764)', () => {
  describe('extensionInventory', () => {
    it('is probed:false for an engine with no known local-extension convention', () => {
      const result = engineTabs.extensionInventory({ id: 'aider' }, {});
      assert.equal(result.probed, false);
      assert.deepEqual(result.plugins, []);
      assert.deepEqual(result.skills, []);
      assert.deepEqual(result.mcpServers, []);
      assert.match(result.reason, /no known local-extension convention/);
    });

    for (const adversarialId of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      it(`is probed:false, not a crash or inherited member, for engine id "${adversarialId}"`, () => {
        const result = engineTabs.extensionInventory({ id: adversarialId }, {});
        assert.equal(result.probed, false);
        assert.deepEqual(result.plugins, []);
        assert.deepEqual(result.skills, []);
        assert.deepEqual(result.mcpServers, []);
        assert.match(result.reason, /no known local-extension convention/);
      });
    }

    it('reads plugins, skills and MCP servers for claude through the injected home/fs seam', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-tabs-'));
      try {
        fs.mkdirSync(path.join(tmp, '.claude', 'plugins'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
          JSON.stringify({ plugins: { 'prawduct@prawduct': {} } })
        );
        fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'deploy'), { recursive: true });
        fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'review'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, '.claude.json'),
          JSON.stringify({ mcpServers: { github: {}, filesystem: {} } })
        );
        const result = engineTabs.extensionInventory({ id: 'claude' }, { homedir: () => tmp });
        assert.equal(result.probed, true);
        assert.deepEqual(result.plugins, ['prawduct@prawduct']);
        assert.deepEqual(result.skills.sort(), ['deploy', 'review']);
        assert.deepEqual(result.mcpServers.sort(), ['filesystem', 'github']);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('degrades to empty arrays, not an error, when claude\'s files are absent', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-tabs-empty-'));
      try {
        const result = engineTabs.extensionInventory({ id: 'claude' }, { homedir: () => tmp });
        assert.equal(result.probed, true);
        assert.deepEqual(result.plugins, []);
        assert.deepEqual(result.skills, []);
        assert.deepEqual(result.mcpServers, []);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('degrades to empty arrays, not a throw, when installed_plugins.json is malformed', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-tabs-bad-'));
      try {
        fs.mkdirSync(path.join(tmp, '.claude', 'plugins'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'), '{not json');
        assert.doesNotThrow(() => engineTabs.extensionInventory({ id: 'claude' }, { homedir: () => tmp }));
        const result = engineTabs.extensionInventory({ id: 'claude' }, { homedir: () => tmp });
        assert.deepEqual(result.plugins, []);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('capabilityDispositions', () => {
    it('reads the two surfaced flags as strict booleans', () => {
      assert.deepEqual(
        engineTabs.capabilityDispositions({ capabilities: { supportsPrimePrompt: true, supportsSilentPrime: false } }),
        { supportsPrimePrompt: true, silentPrimeSupported: false }
      );
    });

    it('is false for both on a profile with no capabilities block', () => {
      assert.deepEqual(
        engineTabs.capabilityDispositions({}),
        { supportsPrimePrompt: false, silentPrimeSupported: false }
      );
    });

    it('does not read a truthy non-boolean as true (a malformed profile)', () => {
      assert.deepEqual(
        engineTabs.capabilityDispositions({ capabilities: { supportsPrimePrompt: 'yes' } }),
        { supportsPrimePrompt: false, silentPrimeSupported: false }
      );
    });
  });

  describe('generatedConfigSummary', () => {
    it('summarizes a real carrier', () => {
      assert.deepEqual(
        engineTabs.generatedConfigSummary({ configFormat: { filename: 'CLAUDE.md', syntax: 'markdown', generator: 'claude-md' } }),
        { filename: 'CLAUDE.md', syntax: 'markdown', generator: 'claude-md', absentReason: null }
      );
    });

    it('carries absentReason for an engine with no carrier', () => {
      const profile = { configFormat: { filename: null, syntax: null, generator: null, absentReason: 'remote host owns its own context files' } };
      assert.deepEqual(
        engineTabs.generatedConfigSummary(profile),
        { filename: null, syntax: null, generator: null, absentReason: 'remote host owns its own context files' }
      );
    });

    it('is all-null for a profile with no configFormat at all', () => {
      assert.deepEqual(
        engineTabs.generatedConfigSummary({}),
        { filename: null, syntax: null, generator: null, absentReason: null }
      );
    });
  });

  describe('engineInventoryRow', () => {
    it('assembles identity, carrier, status page, error patterns, capabilities and extensions', () => {
      const profile = {
        id: 'claude',
        name: 'Claude Code',
        pickerHidden: undefined,
        configFormat: { filename: 'CLAUDE.md', syntax: 'markdown', generator: 'claude-md' },
        statusPage: { adapter: 'atlassian', url: 'https://status.claude.com' },
        errorPatterns: null,
        capabilities: { supportsPrimePrompt: true, supportsSilentPrime: true }
      };
      const row = engineTabs.engineInventoryRow(profile, { homedir: () => os.tmpdir() });
      assert.equal(row.id, 'claude');
      assert.equal(row.name, 'Claude Code');
      assert.equal(row.pickerHidden, false);
      assert.deepEqual(row.configFormat, { filename: 'CLAUDE.md', syntax: 'markdown', generator: 'claude-md', absentReason: null });
      assert.deepEqual(row.statusPage, profile.statusPage);
      assert.equal(row.errorPatterns, null);
      assert.deepEqual(row.capabilities, { supportsPrimePrompt: true, silentPrimeSupported: true });
      assert.equal(row.extensions.probed, true);
    });

    it('reports pickerHidden:true for a connection-backed profile', () => {
      const row = engineTabs.engineInventoryRow({ id: 'openclaw', name: 'OpenClaw', pickerHidden: true }, {});
      assert.equal(row.pickerHidden, true);
    });

    it('does not crash the whole row on a stored profile whose own id is an inherited Object.prototype member', () => {
      // Nothing upstream (a hand-edited or synced engine profile file) refuses
      // an id of "constructor" -- this is the shape GET /api/engines/inventory
      // hits when it maps `engineInventoryRow` over every stored profile.
      const row = engineTabs.engineInventoryRow({ id: 'constructor', name: 'Adversarial' }, {});
      assert.equal(row.extensions.probed, false);
    });
  });
});

describe('GET /api/engines/inventory, GET /api/engines/:id/inventory (#764)', () => {
  let server;
  let port;
  let tmpDir;

  function get(urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
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
      req.end();
    });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-tabs-http-'));
    store._setBasePath(tmpDir);
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/engines/inventory covers every bundled profile, including pickerHidden ones', async () => {
    const { status, data } = await get('/api/engines/inventory');
    assert.equal(status, 200);
    const ids = data.engines.map((e) => e.id);
    assert.ok(ids.includes('claude'), 'claude must be present');
    assert.ok(ids.includes('openclaw'), 'openclaw (pickerHidden) must be present — this is an inventory, not the picker');
    const openclaw = data.engines.find((e) => e.id === 'openclaw');
    assert.equal(openclaw.pickerHidden, true);
  });

  it('GET /api/engines/:id/inventory returns one row for a known engine', async () => {
    const { status, data } = await get('/api/engines/claude/inventory');
    assert.equal(status, 200);
    assert.equal(data.id, 'claude');
    assert.ok(data.configFormat);
    assert.ok('extensions' in data);
  });

  it('GET /api/engines/:id/inventory 404s for an unknown engine id', async () => {
    const { status, data } = await get('/api/engines/not-a-real-engine/inventory');
    assert.equal(status, 404);
    assert.equal(data.code, 'NOT_FOUND');
  });

  it('refuses a percent-encoded slash in :id rather than letting it reach store.engines.get() as a real path separator', async () => {
    // matchRoute's `[^/]+` matches the still-encoded segment, then
    // decodeURIComponent turns %2F into a literal `/` before the handler
    // ever sees it -- `_isValidEngineId` must catch that AFTER decoding.
    const traversal = await get('/api/engines/..%2F..%2Fetc%2Fpasswd/inventory');
    assert.equal(traversal.status, 400);
    assert.equal(traversal.data.code, 'BAD_REQUEST');
  });

  it('the pre-existing GET /api/engines/:id route rejects the same percent-encoded-slash id', async () => {
    const traversal = await get('/api/engines/..%2F..%2Fetc%2Fpasswd');
    assert.equal(traversal.status, 400);
    assert.equal(traversal.data.code, 'BAD_REQUEST');
  });

  it('the literal path "inventory" is not swallowed by the :id route (registration-order regression)', async () => {
    const { status, data } = await get('/api/engines/inventory');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.engines), 'must be the collection route, not a 404 for engine id "inventory"');
  });
});
