'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const engines = require('../lib/engines');

describe('OpenClaw engine integration', () => {
  let tempDir;
  let projectsDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-openclaw-engine-'));
    store._setBasePath(tempDir);
    store.init();

    projectsDir = path.join(tempDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('openclaw.json engine profile', () => {
    it('should be loaded as a bundled engine', () => {
      const profile = store.engines.get('openclaw');
      assert.ok(profile, 'openclaw profile should exist');
      assert.equal(profile.id, 'openclaw');
      assert.equal(profile.name, 'OpenClaw');
      assert.equal(profile.interactionModel, 'session');
      assert.equal(profile.remote, true);
    });

    it('should have correct capabilities', () => {
      const profile = store.engines.get('openclaw');
      assert.equal(profile.capabilities.supportsPrimePrompt, false);
      assert.equal(profile.capabilities.supportsConfigFile, false);
      assert.equal(profile.capabilities.supportsCoAuthor, false);
      assert.equal(profile.capabilities.supportsSlashCommands, false);
      assert.equal(profile.capabilities.supportsRemote, true);
      assert.deepEqual(profile.capabilities.supportsModes, ['ssh', 'webui']);
    });

    it('should have null configFormat fields', () => {
      const profile = store.engines.get('openclaw');
      assert.equal(profile.configFormat.filename, null);
      assert.equal(profile.configFormat.syntax, null);
      assert.equal(profile.configFormat.generator, null);
    });

    it('should have null statusPage', () => {
      const profile = store.engines.get('openclaw');
      assert.equal(profile.statusPage, null);
    });

    it('should detect via ssh', () => {
      const profile = store.engines.get('openclaw');
      assert.equal(profile.detection.strategy, 'which');
      assert.equal(profile.detection.target, 'ssh');
    });
  });

  describe('listWithAvailability — OpenClaw virtual engines', () => {
    let connId;

    before(() => {
      // Create an OpenClaw connection with availableAsEngine=true
      const conn = store.openclawConnections.create({
        name: 'TestClaw',
        host: '198.51.100.10',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/test_key',
        port: 18789,
        cliCommand: 'openclaw-cli',
        localPort: 18789,
        availableAsEngine: true
      });
      connId = conn.id;
    });

    it('should include OpenClaw connections as virtual engines', () => {
      const list = engines.listWithAvailability();
      const ocEngine = list.find(e => e.id === `openclaw:${connId}`);
      assert.ok(ocEngine, 'Should include openclaw virtual engine');
      assert.equal(ocEngine.name, 'TestClaw (OpenClaw)');
      assert.equal(ocEngine.category, 'OpenClaw');
      assert.equal(ocEngine.connectionId, connId);
      assert.equal(ocEngine.available, true);
    });

    it('should include capabilities from base openclaw profile', () => {
      const list = engines.listWithAvailability();
      const ocEngine = list.find(e => e.id === `openclaw:${connId}`);
      assert.equal(ocEngine.capabilities.supportsPrimePrompt, false);
      assert.equal(ocEngine.capabilities.supportsRemote, true);
    });

    it('should not include connections with availableAsEngine=false', () => {
      const conn2 = store.openclawConnections.create({
        name: 'HiddenClaw',
        host: '192.168.20.11',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/test_key2',
        availableAsEngine: false
      });

      const list = engines.listWithAvailability();
      const hidden = list.find(e => e.id === `openclaw:${conn2.id}`);
      assert.equal(hidden, undefined, 'Should not include non-engine connections');

      // Cleanup
      store.openclawConnections.delete(conn2.id);
    });

    it('should still list standard engines alongside OpenClaw', () => {
      const list = engines.listWithAvailability();
      const claude = list.find(e => e.id === 'claude');
      assert.ok(claude, 'Claude should still be in the list');
      const ocEngine = list.find(e => e.id === `openclaw:${connId}`);
      assert.ok(ocEngine, 'OpenClaw should also be in the list');
    });
  });

  describe('getWithAvailability — openclaw: IDs', () => {
    let connId;

    before(() => {
      const conn = store.openclawConnections.create({
        name: 'GetTestClaw',
        host: '10.0.0.1',
        sshUser: 'user',
        sshKeyPath: '~/.ssh/key',
        availableAsEngine: true
      });
      connId = conn.id;
    });

    it('should resolve openclaw:<connId> to virtual engine', () => {
      const result = engines.getWithAvailability(`openclaw:${connId}`);
      assert.ok(result, 'Should return a result');
      assert.equal(result.id, `openclaw:${connId}`);
      assert.equal(result.name, 'GetTestClaw (OpenClaw)');
      assert.equal(result.available, true);
      assert.equal(result.category, 'OpenClaw');
      assert.equal(result.connectionId, connId);
    });

    it('should return null for non-existent openclaw connection', () => {
      const result = engines.getWithAvailability('openclaw:nonexistent-id');
      assert.equal(result, null);
    });
  });

  describe('_buildLaunchCommand — OpenClaw SSH', () => {
    let sessions;
    let connId;

    before(() => {
      sessions = require('../lib/sessions');
      const conn = store.openclawConnections.create({
        name: 'LaunchClaw',
        host: '198.51.100.10',
        sshUser: 'testuser',
        sshKeyPath: '~/.ssh/test_key',
        cliCommand: 'openclaw-cli',
        availableAsEngine: true
      });
      connId = conn.id;
    });

    it('should build SSH command from connection config', () => {
      const engineProfile = store.engines.get('openclaw');
      const project = { engineId: `openclaw:${connId}` };
      const cmd = sessions._buildLaunchCommand(engineProfile, project);

      assert.ok(cmd.startsWith('ssh -t -i'));
      assert.ok(cmd.includes('testuser@198.51.100.10'));
      assert.ok(cmd.includes('"openclaw-cli"'));
      // Tilde should be expanded
      assert.ok(cmd.includes(process.env.HOME));
      assert.ok(!cmd.includes('~'));
    });

    it('should return undefined for missing connection', () => {
      const engineProfile = store.engines.get('openclaw');
      const project = { engineId: 'openclaw:nonexistent' };
      const cmd = sessions._buildLaunchCommand(engineProfile, project);
      assert.equal(cmd, undefined);
    });

    it('should use default cliCommand if not set', () => {
      const conn2 = store.openclawConnections.create({
        name: 'DefaultCliClaw',
        host: '10.0.0.5',
        sshUser: 'user',
        sshKeyPath: '~/.ssh/key'
      });
      const engineProfile = store.engines.get('openclaw');
      const project = { engineId: `openclaw:${conn2.id}` };
      const cmd = sessions._buildLaunchCommand(engineProfile, project);
      assert.ok(cmd.includes('"openclaw-cli"'));

      store.openclawConnections.delete(conn2.id);
    });

    it('should build normal launch command for non-openclaw engines', () => {
      const engineProfile = store.engines.get('claude');
      const project = { engineId: 'claude' };
      const cmd = sessions._buildLaunchCommand(engineProfile, project);
      assert.equal(cmd, 'claude');
    });
  });

  describe('enrichProject — OpenClaw engine resolution', () => {
    let projects;
    let connId;

    before(() => {
      projects = require('../lib/projects');

      const conn = store.openclawConnections.create({
        name: 'EnrichClaw',
        host: '198.51.100.10',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/key',
        availableAsEngine: true
      });
      connId = conn.id;

      // Create a project with openclaw engine
      const projDir = path.join(projectsDir, 'oc-enrich-test');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'oc-enrich-test',
        path: projDir,
        engine: `openclaw:${connId}`,
        methodology: 'none'
      });
    });

    it('should resolve OpenClaw engine name from connection', () => {
      const project = projects.getProject('oc-enrich-test');
      assert.ok(project, 'Project should exist');
      assert.ok(project.engine, 'Should have engine info');
      assert.equal(project.engine.id, `openclaw:${connId}`);
      assert.equal(project.engine.name, 'EnrichClaw (OpenClaw)');
      assert.equal(project.engine.available, true);
    });

    it('should include capabilities in enriched engine', () => {
      const project = projects.getProject('oc-enrich-test');
      assert.ok(project.engine.capabilities, 'Should have capabilities');
      assert.equal(project.engine.capabilities.supportsPrimePrompt, false);
    });
  });

  describe('generateConfig — OpenClaw returns null', () => {
    it('should return null for openclaw engine (no config file support)', () => {
      const result = engines.generateConfig('openclaw', {
        rules: { core: { changelogPerChange: true } }
      });
      assert.equal(result, null);
    });
  });

  describe('validateParity — OpenClaw excluded', () => {
    it('should not include openclaw in parity validation (no config file)', () => {
      const result = engines.validateParity();
      const ocResult = result.engines.find(e => e.id === 'openclaw');
      assert.equal(ocResult, undefined, 'OpenClaw should be excluded from parity checks');
    });
  });

  describe('validateStatusParity — OpenClaw included', () => {
    it('should pass status parity with null statusPage', () => {
      const result = engines.validateStatusParity();
      const ocResult = result.engines.find(e => e.id === 'openclaw');
      assert.ok(ocResult, 'OpenClaw should be in status parity');
      assert.equal(ocResult.valid, true);
    });
  });
});
