'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('sessions', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sessions-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a projects directory
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    // Set the projectsDir in config
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Since sessions.js depends on tmux (shell commands), we test the logic
  // that doesn't require actual tmux sessions

  describe('generatePrimePrompt', () => {
    let sessions;
    let projectId;

    before(() => {
      sessions = require('../lib/sessions');

      // Create a project in the store
      const projDir = path.join(projectsDir, 'prime-test');
      fs.mkdirSync(projDir, { recursive: true });

      const project = store.projects.create({
        name: 'prime-test',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
      projectId = project.id;
    });

    it('generates a prime prompt with project name', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');
      const prompt = sessions.generatePrimePrompt(project, engine);

      assert.ok(prompt.includes('prime-test'));
      assert.ok(prompt.includes('Session Start'));
    });

    it('does not inject methodology heading or description (#102 — already in CLAUDE.md + pill)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.projects.update(project.id, { methodology: 'minimal' });
      const updatedProject = store.projects.getByName('prime-test');

      const prompt = sessions.generatePrimePrompt(updatedProject, engine);
      assert.equal(prompt.includes('## Methodology:'), false, 'prime should not carry methodology heading');
      assert.equal(prompt.includes('## Current Phase:'), false, 'prime should not carry current phase heading');
    });

    it('includes active learnings', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.learnings.create({
        projectId: project.id,
        content: 'Always validate inputs',
        tier: 'active'
      });

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.ok(prompt.includes('Always validate inputs'));
      assert.ok(prompt.includes('Active Learnings'));
    });

    it('does not inject Shared Infrastructure pointer for single group (#102 — docs already in CLAUDE.md)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const group = store.projectGroups.create({ name: 'habitat infra', description: 'shared habitat' });
      store.projectGroups.addMember(group.id, project.id);
      store.sharedDocs.create({
        groupId: group.id,
        name: 'NETWORK',
        filePath: '/tmp/NETWORK.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('Shared Infrastructure'), false, 'prime should not surface Shared Infrastructure heading');
      assert.equal(prompt.includes('1 shared doc linked'), false, 'prime should not surface shared-doc counts');

      store.projectGroups.delete(group.id);
    });

    it('does not inject sharedDir path (#102)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const group = store.projectGroups.create({ name: 'frontend libs', sharedDir: '/tmp/shared-frontend' });
      store.projectGroups.addMember(group.id, project.id);
      store.sharedDocs.create({
        groupId: group.id,
        name: 'STYLES',
        filePath: '/tmp/shared-frontend/STYLES.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('/tmp/shared-frontend'), false, 'prime should not echo sharedDir paths');

      store.projectGroups.delete(group.id);
    });

    it('does not list multiple groups in bulleted format (#102)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const g1 = store.projectGroups.create({ name: 'group-alpha' });
      const g2 = store.projectGroups.create({ name: 'group-beta' });
      store.projectGroups.addMember(g1.id, project.id);
      store.projectGroups.addMember(g2.id, project.id);
      store.sharedDocs.create({ groupId: g1.id, name: 'DOC1', filePath: '/tmp/d1.md', injectIntoConfig: true, injectMode: 'reference' });
      store.sharedDocs.create({ groupId: g2.id, name: 'DOC2', filePath: '/tmp/d2.md', injectIntoConfig: true, injectMode: 'reference' });
      store.sharedDocs.create({ groupId: g2.id, name: 'DOC3', filePath: '/tmp/d3.md', injectIntoConfig: true, injectMode: 'reference' });

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('Shared Infrastructure'), false);
      assert.equal(prompt.includes('group-alpha'), false);
      assert.equal(prompt.includes('group-beta'), false);

      store.projectGroups.delete(g1.id);
      store.projectGroups.delete(g2.id);
    });

    it('omits shared infrastructure when project has no groups with docs', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.ok(!prompt.includes('Shared Infrastructure'));
    });

    it('includes last session summary', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      // Create and wrap a session in the store
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'prime-wrap-test'
      });
      store.sessions.wrap(session.id, 'Completed chunk 4 with 108 tests');

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.ok(prompt.includes('Last Session Summary'));
      assert.ok(prompt.includes('Completed chunk 4'));
    });

    it('omits playbook AND methodology heading (#102 — both belong in CLAUDE.md, not prime)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.projects.update(project.id, { methodology: 'prawduct' });
      const updated = store.projects.getByName('prime-test');

      const prompt = sessions.generatePrimePrompt(updated, engine);
      assert.ok(!prompt.includes('Session Playbook'), 'playbook should not be in prime prompt');
      assert.ok(!prompt.includes('Janitor Pass'), 'playbook details should not be in prime prompt');
      assert.equal(prompt.includes('Methodology: Prawduct'), false, 'methodology heading should not be in prime (#102)');

      store.projects.update(project.id, { methodology: 'minimal' });
    });

    it('does not inject Active Extension Rules with definitions (#102 — already in CLAUDE.md)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.projects.update(project.id, { methodology: 'prawduct' });
      const updated = store.projects.getByName('prime-test');
      const projConfig = store.projectConfig.load(updated.path);
      projConfig.rules = projConfig.rules || { extensions: {} };
      projConfig.rules.extensions.independentCritic = true;
      projConfig.rules.extensions.docsParity = true;
      store.projectConfig.save(updated.path, projConfig);

      const prompt = sessions.generatePrimePrompt(updated, engine);
      assert.equal(prompt.includes('## Active Extension Rules'), false, 'no Active Extension Rules heading');
      assert.equal(prompt.includes('**independentCritic**:'), false, 'no rule definitions');
      assert.equal(prompt.includes('**docsParity**:'), false, 'no rule definitions');

      store.projects.update(project.id, { methodology: 'minimal' });
    });

    it('does not list plain rule names either (#102 — extension rules block fully removed)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const projConfig = store.projectConfig.load(project.path);
      projConfig.rules = projConfig.rules || { extensions: {} };
      projConfig.rules.extensions.customRule = true;
      store.projectConfig.save(project.path, projConfig);

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('## Active Extension Rules'), false, 'no Active Extension Rules heading');
      assert.equal(prompt.includes('- customRule'), false, 'no rule list');

      delete projConfig.rules.extensions.customRule;
      store.projectConfig.save(project.path, projConfig);
    });

    it('does not inject Previous Methodology Archives (#102 — AI can find filesystem itself)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const projConfig = store.projectConfig.load(project.path);
      projConfig.methodologyArchives = [
        { archivePath: '.tangleclaw/project.json.archived/2025-12-01', methodology: 'minimal' }
      ];
      store.projectConfig.save(project.path, projConfig);

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('## Previous Methodology Archives'), false);
      assert.equal(prompt.includes('archived'), false, 'no archive pointer text');

      delete projConfig.methodologyArchives;
      store.projectConfig.save(project.path, projConfig);
    });

    it('prime carries header + branding flourish on a clean project (no learnings, no last session, no audit mode)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');
      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.match(prompt, /^# Session Start — prime-test/m, 'header present');
      assert.match(prompt, /\*TangleClaw'd into existence\.\*/, 'branding flourish present');
    });

    it('does not inject Project Version Recording protocol (#101 — TC owns the writer)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');
      const prompt = sessions.generatePrimePrompt(project, engine);

      assert.equal(prompt.includes('## Project Version Recording'), false, 'prime should not include version-recording heading');
      assert.equal(prompt.includes('.tangleclaw/project-version.txt'), false, 'prime should not reference cache file path');
      assert.equal(prompt.includes('git describe'), false, 'prime should not mention git tags as a fallback');
      assert.equal(prompt.includes('recorded_at:'), false, 'prime should not show cache file format');
    });

    it('omits version recording for all methodologies (#101)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.projects.update(project.id, { methodology: 'prawduct' });
      const prawductPrompt = sessions.generatePrimePrompt(store.projects.getByName('prime-test'), engine);
      assert.equal(prawductPrompt.includes('## Project Version Recording'), false, 'prawduct prime should not include version recording');

      store.projects.update(project.id, { methodology: 'minimal' });
      const minimalPrompt = sessions.generatePrimePrompt(store.projects.getByName('prime-test'), engine);
      assert.equal(minimalPrompt.includes('## Project Version Recording'), false, 'minimal prime should not include version recording');
    });

    describe('Feature Index injection (#207, chunk 2)', () => {
      // Use a dedicated project to keep config + FEATURES.md state isolated
      // from the other generatePrimePrompt tests above.
      let fiProject;
      let fiProjectPath;
      let featuresPath;

      before(() => {
        fiProjectPath = path.join(projectsDir, 'fi-prime-test');
        fs.mkdirSync(fiProjectPath, { recursive: true });
        store.projects.create({
          name: 'fi-prime-test',
          path: fiProjectPath,
          engine: 'claude',
          methodology: 'minimal'
        });
        fiProject = store.projects.getByName('fi-prime-test');
        featuresPath = path.join(fiProjectPath, 'FEATURES.md');
      });

      beforeEach(() => {
        // Reset project config + filesystem between cases so each test starts
        // from a known state. Default: both gates off, no FEATURES.md.
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          methodology: 'minimal',
          silentPrime: false,
          featureIndexEnabled: false
        });
        try { fs.rmSync(featuresPath, { force: true }); } catch {}
      });

      it('injects FEATURES.md contents under "## Feature Index" when all three gates are true', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          methodology: 'minimal',
          silentPrime: true,
          featureIndexEnabled: true
        });
        fs.writeFileSync(featuresPath, '# Feature Index\n\n## UI / Web\n- **Pill** — lib/pill.js:42\n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.ok(prompt.includes('## Feature Index'), 'prime should contain Feature Index heading');
        assert.ok(prompt.includes('**Pill**'), 'prime should contain authored entry');
        assert.ok(prompt.includes('lib/pill.js:42'), 'prime should contain the file pointer');
      });

      it('is skipped when featureIndexEnabled is false (even with silentPrime + capability)', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          methodology: 'minimal',
          silentPrime: true,
          featureIndexEnabled: false
        });
        fs.writeFileSync(featuresPath, '# Feature Index\n\n- entry\n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.equal(prompt.includes('## Feature Index'), false);
      });

      it('is skipped when silentPrime is false (symmetric gate — #125 ADR 0001)', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          methodology: 'minimal',
          silentPrime: false,
          featureIndexEnabled: true
        });
        fs.writeFileSync(featuresPath, '# Feature Index\n\n- entry\n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.equal(prompt.includes('## Feature Index'), false,
          'silentPrime=false must short-circuit even when the project toggle is on');
      });

      it('is skipped when the engine lacks supportsSilentPrime capability', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          methodology: 'minimal',
          silentPrime: true,
          featureIndexEnabled: true
        });
        fs.writeFileSync(featuresPath, '# Feature Index\n\n- entry\n');

        // Synthesize an engine profile that declares no silent-prime support.
        const engineWithoutCapability = {
          id: 'no-silent',
          capabilities: { supportsSilentPrime: false }
        };

        const prompt = sessions.generatePrimePrompt(fiProject, engineWithoutCapability);
        assert.equal(prompt.includes('## Feature Index'), false,
          'engine capability gate must short-circuit injection');
      });

      it('is skipped when engineProfile.capabilities is missing entirely (defensive gate)', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          methodology: 'minimal',
          silentPrime: true,
          featureIndexEnabled: true
        });
        fs.writeFileSync(featuresPath, '# Feature Index\n\n- entry\n');

        const prompt = sessions.generatePrimePrompt(fiProject, { id: 'no-caps' });
        assert.equal(prompt.includes('## Feature Index'), false);
      });

      it('is skipped gracefully when FEATURES.md is missing (no throw, no section)', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          methodology: 'minimal',
          silentPrime: true,
          featureIndexEnabled: true
        });
        // FEATURES.md intentionally absent (beforeEach removed it).
        assert.equal(fs.existsSync(featuresPath), false, 'precondition: file absent');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.equal(prompt.includes('## Feature Index'), false,
          'missing FEATURES.md must skip silently — not throw and not insert an empty section');
      });

      it('is skipped when FEATURES.md is whitespace-only (no empty section in prime)', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          methodology: 'minimal',
          silentPrime: true,
          featureIndexEnabled: true
        });
        fs.writeFileSync(featuresPath, '   \n\n\t  \n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.equal(prompt.includes('## Feature Index'), false,
          'whitespace-only FEATURES.md should not produce an empty section');
      });

      it('respects template.prime.maxTokens truncation when FEATURES.md pushes prompt over budget', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          methodology: 'minimal',
          silentPrime: true,
          featureIndexEnabled: true
        });

        // Build a FEATURES.md large enough to exceed any reasonable maxTokens.
        // The minimal template's prime.maxTokens is small; the existing
        // truncation at lines 408-413 (maxChars = maxTokens * 4) should kick in.
        const huge = '# Feature Index\n\n' + ('- entry padding word '.repeat(2000)) + '\n';
        fs.writeFileSync(featuresPath, huge);

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        const template = store.templates.get('minimal');
        // Hard precondition: if the template schema ever renames or drops
        // prime.maxTokens this test must fail loudly, not pass silently.
        assert.ok(template, 'precondition: minimal template loadable');
        assert.ok(template.prime, 'precondition: minimal template has prime config');
        assert.ok(template.prime.maxTokens, 'precondition: minimal template has prime.maxTokens');

        const maxChars = template.prime.maxTokens * 4;
        assert.ok(prompt.length <= maxChars + 30,
          `prompt length ${prompt.length} should respect maxChars budget ${maxChars} (+truncation marker)`);
      });

      after(() => {
        // Clean up the dedicated FI project so it does not leak into sibling
        // describe blocks that iterate all projects.
        try { fs.rmSync(featuresPath, { force: true }); } catch {}
        try { fs.rmSync(path.join(fiProjectPath, '.tangleclaw'), { recursive: true, force: true }); } catch {}
      });
    });
  });

  describe('_buildLaunchCommand', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('builds command from engine profile', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'claude', args: ['--verbose'], env: {} }
      });
      assert.equal(cmd, 'claude --verbose');
    });

    it('handles no args', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'codex', args: [], env: {} }
      });
      assert.equal(cmd, 'codex');
    });

    it('returns undefined when no launch config', () => {
      const cmd = sessions._buildLaunchCommand({});
      assert.equal(cmd, undefined);
    });

    it('appends launch mode args when mode is specified', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'claude', args: [], env: {} },
        launchModes: {
          auto: { label: 'Auto', args: ['--permission-mode', 'auto', '--enable-auto-mode'] }
        }
      }, null, 'auto');
      assert.equal(cmd, 'claude --permission-mode auto --enable-auto-mode');
    });

    it('ignores launch mode when mode key does not exist', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'claude', args: ['--verbose'], env: {} },
        launchModes: {
          auto: { label: 'Auto', args: ['--permission-mode', 'auto'] }
        }
      }, null, 'nonexistent');
      assert.equal(cmd, 'claude --verbose');
    });

    it('ignores launch mode when engine has no launchModes', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'codex', args: [], env: {} }
      }, null, 'auto');
      assert.equal(cmd, 'codex');
    });

    it('appends mode args after static args', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'claude', args: ['--verbose'], env: {} },
        launchModes: {
          plan: { label: 'Plan', args: ['--permission-mode', 'plan'] }
        }
      }, null, 'plan');
      assert.equal(cmd, 'claude --verbose --permission-mode plan');
    });
  });

  describe('_resolvePreKeys', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns mode-level preKeys when mode defines them', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [] },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: ['--dangerously-skip-permissions'], preKeys: ['2'], preKeyDelay: 2000 }
        }
      }, 'bypassPermissions');
      assert.deepEqual(result.preKeys, ['2']);
      assert.equal(result.preKeyDelay, 2000);
    });

    it('falls back to engine-level preKeys when mode has none', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'codex', args: [], preKeys: ['Enter', 'Enter'], preKeyDelay: 3000 },
        launchModes: {
          default: { label: 'Interactive', args: [] }
        }
      }, 'default');
      assert.deepEqual(result.preKeys, ['Enter', 'Enter']);
      assert.equal(result.preKeyDelay, 3000);
    });

    it('falls back to engine-level preKeys when launchMode is null', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'codex', args: [], preKeys: ['Enter'], preKeyDelay: 2500 }
      }, null);
      assert.deepEqual(result.preKeys, ['Enter']);
      assert.equal(result.preKeyDelay, 2500);
    });

    it('returns null preKeys when neither mode nor engine define them', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [] },
        launchModes: {
          default: { label: 'Interactive', args: [] }
        }
      }, 'default');
      assert.equal(result.preKeys, null);
      assert.equal(result.preKeyDelay, 0);
    });

    it('returns null preKeys for engine with no launch config', () => {
      const result = sessions._resolvePreKeys({}, null);
      assert.equal(result.preKeys, null);
      assert.equal(result.preKeyDelay, 0);
    });

    it('uses mode preKeyDelay over engine preKeyDelay', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [], preKeyDelay: 1000 },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: [], preKeys: ['2'], preKeyDelay: 3000 }
        }
      }, 'bypassPermissions');
      assert.equal(result.preKeyDelay, 3000);
    });

    it('falls back to engine preKeyDelay when mode omits it', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [], preKeyDelay: 1500 },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: [], preKeys: ['2'] }
        }
      }, 'bypassPermissions');
      assert.equal(result.preKeyDelay, 1500);
    });

    it('defaults preKeyDelay to 2000 when neither mode nor engine specify it', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [] },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: [], preKeys: ['2'] }
        }
      }, 'bypassPermissions');
      assert.equal(result.preKeyDelay, 2000);
    });

    it('ignores mode preKeys for nonexistent mode key', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [], preKeys: ['Enter'] },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: [], preKeys: ['2'] }
        }
      }, 'nonexistent');
      assert.deepEqual(result.preKeys, ['Enter']);
    });

    it('skips empty preKeys arrays', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [], preKeys: ['Enter'] },
        launchModes: {
          default: { label: 'Interactive', args: [], preKeys: [] }
        }
      }, 'default');
      // Empty mode preKeys should fall through to engine-level
      assert.deepEqual(result.preKeys, ['Enter']);
    });
  });

  describe('detectIdle', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns not idle when no cached output', () => {
      sessions.clearIdleCache('nonexistent-session');
      const result = sessions.detectIdle('nonexistent-session');
      // tmux.capturePane will fail for nonexistent session, returning idle: false
      assert.equal(result.idle, false);
    });
  });

  describe('getSessionStatus (no active session)', () => {
    let sessions;
    const tmux = require('../lib/tmux');

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns null for unknown project', () => {
      const status = sessions.getSessionStatus('nonexistent-project');
      assert.equal(status, null);
    });

    it('returns inactive status with last session', () => {
      const status = sessions.getSessionStatus('prime-test');
      assert.ok(status);
      assert.equal(status.active, false);
      assert.equal(status.project, 'prime-test');
      assert.ok(status.lastSession);
      assert.equal(status.lastSession.status, 'wrapped');
    });

    it('returns active+untracked when tmux session exists but DB has no active record', () => {
      // Mock tmux.hasSession to return true for prime-test
      const originalHasSession = tmux.hasSession;
      tmux.hasSession = (name) => name === 'prime-test';
      try {
        // prime-test has a wrapped (not active) DB session, but tmux says it exists
        const status = sessions.getSessionStatus('prime-test');
        assert.ok(status);
        assert.equal(status.active, true);
        assert.equal(status.untracked, true);
        assert.equal(status.tmuxSession, 'prime-test');
        assert.equal(status.engine, null);
      } finally {
        tmux.hasSession = originalHasSession;
      }
    });
  });

  describe('injectCommand', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.injectCommand('nonexistent', 'ls');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error when no active session', () => {
      const result = sessions.injectCommand('prime-test', 'ls');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('No active session'));
    });

    it('rejects commands exceeding 4096 characters', () => {
      const longCommand = 'x'.repeat(4097);
      const result = sessions.injectCommand('prime-test', longCommand);
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('maximum length'));
    });
  });

  describe('peek', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.peek('nonexistent');
      assert.equal(result.lines, null);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error when no active session', () => {
      const result = sessions.peek('prime-test');
      assert.equal(result.lines, null);
      assert.ok(result.error.includes('No active session'));
    });

    it('accepts options object with lines param', () => {
      const result = sessions.peek('nonexistent', { lines: 50 });
      assert.equal(result.lines, null);
      assert.ok(result.error.includes('not found'));
    });

    it('accepts options object with full param', () => {
      const result = sessions.peek('nonexistent', { full: true });
      assert.equal(result.lines, null);
      assert.ok(result.error.includes('not found'));
    });
  });

  describe('triggerWrap', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', async () => {
      const result = await sessions.triggerWrap('nonexistent');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error when no active session', async () => {
      const result = await sessions.triggerWrap('prime-test');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('No active session'));
    });
  });

  describe('killSession', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.killSession('nonexistent');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error when no active session', () => {
      const result = sessions.killSession('prime-test');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('No active session'));
    });

    it('releases document locks on kill', () => {
      const project = store.projects.getByName('prime-test');

      // Create a group, doc, and lock
      const group = store.projectGroups.create({ name: 'KillLockGroup' });
      store.projectGroups.addMember(group.id, project.id);
      const doc = store.sharedDocs.create({
        groupId: group.id,
        name: 'KillLockDoc',
        filePath: '/tmp/kill-lock.md',
        injectIntoConfig: true
      });

      // Start a session
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-lock-test'
      });

      // Acquire lock
      store.documentLocks.acquire(doc.id, session.id, 'prime-test');
      assert.ok(store.documentLocks.check(doc.id), 'Lock should be acquired');

      // Kill the session
      sessions.killSession('prime-test');

      // Lock should be released
      assert.equal(store.documentLocks.check(doc.id), null, 'Lock should be released after kill');

      // Clean up
      store.sharedDocs.delete(doc.id);
      store.projectGroups.delete(group.id);
    });
  });

  describe('killSession recovers wrapping + orphan tmux (#105)', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    let originalHasSession;
    let originalKillSession;
    let killedTmux;

    before(() => {
      sessions = require('../lib/sessions');
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalKillSession = tmux.killSession;
      killedTmux = [];
      tmux.killSession = (name) => { killedTmux.push(name); };
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      tmux.killSession = originalKillSession;
      // Cleanup any leftover wrapping/active rows so tests are independent
      const project = store.projects.getByName('prime-test');
      if (project) {
        const wrapping = store.sessions.getWrapping(project.id);
        if (wrapping) store.sessions.kill(wrapping.id, 'test cleanup');
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    it('kills wrapping session when tmux is alive', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-wrapping-alive'
      });
      store.sessions.setWrapping(session.id);
      tmux.hasSession = (name) => name === 'kill-wrapping-alive';

      const result = sessions.killSession('prime-test', 'user kill while wrapping');

      assert.equal(result.error, null);
      assert.ok(result.session, 'should return killed session');
      assert.equal(result.session.status, 'killed');
      assert.deepEqual(killedTmux, ['kill-wrapping-alive'], 'tmux session should be killed');
    });

    it('kills wrapping session when tmux is already dead — reconciles DB only', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-wrapping-dead'
      });
      store.sessions.setWrapping(session.id);
      tmux.hasSession = () => false;

      const result = sessions.killSession('prime-test');

      assert.equal(result.error, null);
      assert.ok(result.session);
      assert.equal(result.session.status, 'killed');
      assert.deepEqual(killedTmux, [], 'should not call tmux.killSession when session is dead');
    });

    it('reconciles orphan tmux when no DB row exists', () => {
      // No active and no wrapping row — but tmux still has a session.
      tmux.hasSession = (name) => name === 'prime-test';

      const result = sessions.killSession('prime-test', 'cleanup orphan');

      assert.equal(result.error, null);
      assert.equal(result.session, null);
      assert.equal(result.reconciled, true);
      assert.deepEqual(killedTmux, ['prime-test'], 'orphan tmux should be killed under the project name');
    });

    it('returns NOT_FOUND-style error when no DB row and no orphan tmux', () => {
      tmux.hasSession = () => false;

      const result = sessions.killSession('prime-test');

      assert.equal(result.session, null);
      assert.ok(result.error.includes('No active session'));
      assert.ok(!result.reconciled);
      assert.deepEqual(killedTmux, []);
    });

    it('clears wrap pane cache when killing wrapping session', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-wrapping-cache'
      });
      store.sessions.setWrapping(session.id);
      sessions._wrapPaneCache.set(session.id, 'cached pane output');
      tmux.hasSession = () => true;

      sessions.killSession('prime-test');

      assert.equal(sessions._wrapPaneCache.has(session.id), false, 'cache entry should be cleared');
    });

    it('prefers active over wrapping when both somehow exist', () => {
      // Defensive: there shouldn't normally be both, but if a future bug allows
      // it the kill button must target the active row first.
      const project = store.projects.getByName('prime-test');
      const wrappingSession = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-priority-wrap'
      });
      store.sessions.setWrapping(wrappingSession.id);
      const activeSession = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-priority-active'
      });
      tmux.hasSession = () => true;

      const result = sessions.killSession('prime-test');

      assert.equal(result.session.id, activeSession.id, 'should target the active row');
      assert.deepEqual(killedTmux, ['kill-priority-active']);

      // Cleanup the still-wrapping row
      store.sessions.kill(wrappingSession.id, 'test cleanup');
    });
  });

  describe('completeWrap', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.completeWrap('nonexistent', 'summary');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('not found'));
    });

    it('releases document locks on wrap', () => {
      const project = store.projects.getByName('prime-test');

      // Create a group, doc, and lock
      const group = store.projectGroups.create({ name: 'WrapLockGroup' });
      store.projectGroups.addMember(group.id, project.id);
      const doc = store.sharedDocs.create({
        groupId: group.id,
        name: 'WrapLockDoc',
        filePath: '/tmp/wrap-lock.md',
        injectIntoConfig: true
      });

      // Start a session
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'wrap-lock-test'
      });

      // Acquire lock
      store.documentLocks.acquire(doc.id, session.id, 'prime-test');
      assert.ok(store.documentLocks.check(doc.id), 'Lock should be acquired');

      // Mark as wrapping and complete
      store.sessions.setWrapping(session.id);
      sessions.completeWrap('prime-test', 'test wrap');

      // Lock should be released
      assert.equal(store.documentLocks.check(doc.id), null, 'Lock should be released after wrap');

      // Clean up
      store.sharedDocs.delete(doc.id);
      store.projectGroups.delete(group.id);
    });
  });

  describe('parseWrapSummary', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('extracts structured fields from markdown headings', () => {
      const rawOutput = [
        'Some preamble',
        '## summary',
        'We completed chunk 5',
        'All tests pass',
        '## nextSteps',
        'Start chunk 6',
        '## learnings',
        'Wrap parsing is tricky'
      ].join('\n');

      const result = sessions.parseWrapSummary(rawOutput, ['summary', 'nextSteps', 'learnings']);
      assert.ok(result.includes('## summary'));
      assert.ok(result.includes('We completed chunk 5'));
      assert.ok(result.includes('## nextSteps'));
      assert.ok(result.includes('Start chunk 6'));
      assert.ok(result.includes('## learnings'));
    });

    it('falls back to last 50 lines when no fields match', () => {
      const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
      const rawOutput = lines.join('\n');

      const result = sessions.parseWrapSummary(rawOutput, ['nonexistent']);
      assert.ok(result.includes('line 59'));
      assert.ok(result.includes('line 10'));
      assert.ok(!result.includes('line 9'));
    });

    it('returns empty string for empty input', () => {
      const result = sessions.parseWrapSummary('', ['summary']);
      assert.equal(result, '');
    });

    it('falls back to raw output when no captureFields provided', () => {
      const result = sessions.parseWrapSummary('some output', []);
      assert.equal(result, 'some output');
    });
  });

  describe('autoCompleteWrap', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('wraps session with cached pane output', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'auto-wrap-test'
      });
      store.sessions.setWrapping(session.id);

      // Simulate cached pane output
      sessions._wrapPaneCache.set(session.id, '## summary\nDone with chunk\n## nextSteps\nNext chunk');

      const result = sessions.autoCompleteWrap(project, session);
      assert.ok(result);
      assert.equal(result.status, 'wrapped');
      assert.ok(result.wrapSummary.includes('Done with chunk'));
    });

    it('handles missing cache gracefully', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'auto-wrap-empty-test'
      });
      store.sessions.setWrapping(session.id);

      const result = sessions.autoCompleteWrap(project, session);
      assert.ok(result);
      assert.equal(result.status, 'wrapped');
      // Empty cache → empty string → store converts to null
      assert.equal(result.wrapSummary, null);
    });
  });

  describe('triggerWrap (methodology-driven)', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    let originalSendKeys;
    let originalHasSession;
    let sentCommand;

    // Shared empty-pipeline-result stub used by V2-routing tests that
    // don't care about the pipeline body (only the routing contract).
    // Frozen so a test can't accidentally mutate the shared instance.
    const EMPTY_V2_RESULT = Object.freeze({
      ok: true, blockedAt: null, results: [], commitSha: null, summary: null, error: null
    });

    before(() => {
      sessions = require('../lib/sessions');
    });

    beforeEach(() => {
      originalSendKeys = tmux.sendKeys;
      originalHasSession = tmux.hasSession;
      sentCommand = null;
      tmux.sendKeys = (name, cmd, opts) => { sentCommand = cmd; };
      tmux.hasSession = () => true;
      // #139 Chunk 11c — the default flipped to `wrapV2: true`. Tests
      // in this block assert legacy NL-prompt behavior; the V2-routing
      // tests below override this back to `true` per-test. Setting the
      // baseline `false` here keeps the legacy tests focused on what
      // they're actually asserting (the legacy path's behavior),
      // without each test having to repeat the projConfig write.
      const project = store.projects.getByName('prime-test');
      if (project) {
        store.projectConfig.save(project.path, {
          ...store.projectConfig.load(project.path),
          wrapV2: false
        });
      }
    });

    afterEach(() => {
      tmux.sendKeys = originalSendKeys;
      tmux.hasSession = originalHasSession;
      // Cleanup active/wrapping sessions and restore methodology
      const project = store.projects.getByName('prime-test');
      if (project) {
        store.projects.update(project.id, { methodology: 'minimal' });
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
        const wrapping = store.sessions.getWrapping(project.id);
        if (wrapping) store.sessions.wrap(wrapping.id, 'test cleanup');
      }
    });

    it('sets session to wrapping status', async () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-test'
      });

      const result = await sessions.triggerWrap('prime-test');
      assert.ok(result.ok);
      assert.equal(result.sessionId, session.id);

      // Session should now be wrapping
      const wrapping = store.sessions.getWrapping(project.id);
      assert.ok(wrapping);
      assert.equal(wrapping.id, session.id);
    });

    it('returns wrapSteps and captureFields', async () => {
      const project = store.projects.getByName('prime-test');
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-fields-test'
      });

      const result = await sessions.triggerWrap('prime-test');
      assert.ok(result.ok);
      assert.ok(Array.isArray(result.wrapSteps));
      assert.ok(Array.isArray(result.captureFields));
    });

    // #139 Chunk 2 — pin the actual NL prompt triggerWrap sends to tmux.
    // The build plan's Acceptance line called for a byte-equal snapshot of
    // the pre-migration wrap command after the schema swap. The shape-pin
    // tests in skills.test.js cover this transitively, but if a future
    // refactor reshapes triggerWrap's join (e.g. wraps fields differently
    // or reorders), the shape pin won't catch it — this snapshot will.
    //
    // #139 Chunk 11c updated the expected steps list to reflect prawduct's
    // wired-in `open-pr-check` + `critic-check` steps. The byte-equal
    // contract still applies — any drift in `triggerWrap`'s join structure
    // (separator, capture-field-suffix, command-prefix) will fail this pin.
    it('sends byte-equal NL wrap prompt for prawduct (legacy path, post-Chunk-11c step list)', async () => {
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-byteq-test'
      });

      await sessions.triggerWrap('prime-test');
      const expected =
        'Perform a session wrap. Commit all uncommitted work, then output a wrap summary.\n' +
        'Wrap steps: open-pr-check, critic-check, version-bump, changelog-update, learnings-capture, next-session-prime, memory-update, commit\n' +
        'Output these fields as ## markdown headings: summary, nextSteps, learnings';
      assert.equal(sentCommand, expected,
        'wrap NL prompt must include the post-Chunk-11c step list; any drift in join structure means triggerWrap behavior changed');
    });

    it('does NOT inject version-recording instruction in wrap command (#101 — TC owns the writer)', async () => {
      const project = store.projects.getByName('prime-test');
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-version-test'
      });

      await sessions.triggerWrap('prime-test');
      assert.ok(sentCommand, 'should have sent a command');
      assert.equal(sentCommand.includes('project-version.txt'), false, 'wrap command should not reference version cache file');
      assert.equal(sentCommand.includes('re-check the project version'), false, 'wrap command should not include re-record instruction');
    });

    it('writes project-version.txt directly during wrap (#101)', async () => {
      const project = store.projects.getByName('prime-test');
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-tc-writer-test'
      });

      const cachePath = path.join(project.path, '.tangleclaw', 'project-version.txt');
      // Remove any prior recording so we can detect this wrap's write.
      try { fs.rmSync(cachePath, { force: true }); } catch {}

      await sessions.triggerWrap('prime-test');
      assert.ok(fs.existsSync(cachePath), 'wrap should produce the version cache file');
      const body = fs.readFileSync(cachePath, 'utf8');
      assert.match(body, /^version:\s*\S+/m, 'cache file should contain a version: line');
      assert.match(body, /^source:\s*\S+/m, 'cache file should contain a source: line');
      assert.match(body, /^recorded_at:\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m, 'recorded_at should be ISO-8601 UTC');
    });

    it('preserves custom wrap command without injecting any version protocol (#101)', async () => {
      const skills = require('../lib/skills');
      const originalGetWrapSkill = skills.getWrapSkill;
      skills.getWrapSkill = () => ({
        command: '/custom-wrap --fast',
        steps: ['commit'],
        captureFields: ['summary']
      });

      try {
        const project = store.projects.getByName('prime-test');
        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'trigger-wrap-custom-cmd-test'
        });

        await sessions.triggerWrap('prime-test');
        assert.ok(sentCommand, 'should have sent a command');
        assert.ok(sentCommand.includes('/custom-wrap --fast'), 'should start with custom command');
        assert.equal(sentCommand.includes('project-version.txt'), false, 'custom-command wrap should not include version protocol');
        assert.equal(sentCommand.includes('re-check the project version'), false, 'custom-command wrap should not include re-record instruction');
      } finally {
        skills.getWrapSkill = originalGetWrapSkill;
      }
    });

    // #139 Chunk 3 — `projConfig.wrapV2` opt-in routes to the new
    // server-side pipeline runner. Default `false` keeps every legacy
    // assertion above byte-equal (already pinned by the existing tests
    // in this block, which run with the default config). These two
    // tests pin the opt-in branch behavior.
    it('wrapV2:true routes through the wrap pipeline runner and does NOT send tmux command (#139 Chunk 3)', async () => {
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-v2-test'
      });
      // Toggle wrapV2 in the on-disk project config.
      store.projectConfig.save(project.path, {
        ...store.projectConfig.load(project.path),
        wrapV2: true
      });

      // Chunk 9 made the `commit` step a real handler — it would
      // shell out to `git status` on the test project's path, which
      // isn't a git repo. Stub it back to a no-op for this routing-
      // contract test; real commit-step behavior is covered in
      // `test/wrap-pipeline.test.js`. Also stub the other real Chunk
      // 4–8 handlers that hit live OS state (lint/test/ai-content/
      // priming-roll/critic-check/pr-check) so the routing assertion
      // doesn't accidentally trip on a missing tmux session.
      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const realKinds = ['lint', 'test', 'ai-content', 'priming-roll', 'critic-check', 'pr-check', 'commit'];
      const dispatchOrig = {};
      const noopRun = async () => ({ ok: true, status: 'done', output: null, blockers: [] });
      for (const kind of realKinds) {
        dispatchOrig[kind] = wrapPipelineMod.STEP_DISPATCH[kind];
        wrapPipelineMod.STEP_DISPATCH[kind] = { run: noopRun };
      }

      try {
        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, true, 'V2 pipeline of no-op stubs returns ok:true');
        assert.equal(sentCommand, null, 'V2 path must not send any tmux command');
        assert.ok(result.pipelineResult, 'V2 result carries the structured pipeline output');
        // #139 Chunk 11c added `open-pr-check` + `critic-check` to
        // prawduct's pipeline (8 steps total, up from 6).
        assert.equal(result.pipelineResult.results.length, 8,
          'prawduct pipeline runs all eight steps');
        assert.equal(result.wrapCommand, null, 'V2 reports no legacy wrapCommand');
      } finally {
        // Restore default
        const cfg = store.projectConfig.load(project.path);
        store.projectConfig.save(project.path, { ...cfg, wrapV2: false });
        for (const kind of realKinds) {
          wrapPipelineMod.STEP_DISPATCH[kind] = dispatchOrig[kind];
        }
      }
    });

    it('wrapV2:true forwards triggerWrap options to runWrapPipeline (#139 Chunk 10)', async () => {
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-v2-options-test'
      });
      store.projectConfig.save(project.path, {
        ...store.projectConfig.load(project.path),
        wrapV2: true
      });

      // Capture the options the runner receives by patching the module
      // export. The runner's full execution is exercised in
      // wrap-pipeline tests; here we only pin the options-threading
      // contract introduced in Chunk 10.
      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const realRun = wrapPipelineMod.runWrapPipeline;
      let receivedOptions;
      wrapPipelineMod.runWrapPipeline = async (projectName, options) => {
        receivedOptions = options;
        return {
          ok: true,
          blockedAt: null,
          results: [],
          commitSha: null,
          summary: null,
          error: null
        };
      };

      try {
        const opts = {
          skipTests: true,
          criticSkipRationale: 'rationale text',
          prHandling: { '42': 'merge' }
        };
        await sessions.triggerWrap('prime-test', opts);
        assert.deepEqual(receivedOptions, opts,
          'options object must reach runWrapPipeline unchanged');

        // Undefined options on the entry call surfaces as undefined at
        // the runner (NOT silently coerced to {}) so the runner's own
        // default-param can govern.
        receivedOptions = 'sentinel-not-set';
        await sessions.triggerWrap('prime-test');
        assert.equal(receivedOptions, undefined,
          'omitted options must reach the runner as undefined');
      } finally {
        wrapPipelineMod.runWrapPipeline = realRun;
        const cfg = store.projectConfig.load(project.path);
        store.projectConfig.save(project.path, { ...cfg, wrapV2: false });
      }
    });

    it('wrapV2 absent from projConfig (older on-disk state) routes to V2 path (post-#139 Chunk 11c default flip)', async () => {
      // Older project.json files written before #139 don't carry a
      // `wrapV2` field. `store.projectConfig.load` deep-merges with
      // DEFAULT_PROJECT_CONFIG; post-Chunk-11c the default is `true`,
      // so absence-of-flag means V2 path. Inverted from the
      // pre-#139-Chunk-11c assertion (which required absent → legacy)
      // — see the CHANGELOG entry for Chunk 11c for the migration note.
      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const originalRun = wrapPipelineMod.runWrapPipeline;
      wrapPipelineMod.runWrapPipeline = async () => EMPTY_V2_RESULT;

      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      const cfgPath = path.join(project.path, '.tangleclaw', 'project.json');
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      // Persist a config that explicitly OMITS wrapV2.
      const cfgNoFlag = JSON.parse(JSON.stringify(store.projectConfig.load(project.path)));
      delete cfgNoFlag.wrapV2;
      fs.writeFileSync(cfgPath, JSON.stringify(cfgNoFlag, null, 2));

      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-v2-absent-test'
      });

      try {
        const result = await sessions.triggerWrap('prime-test');
        // V2 path ran → no tmux command sent; pipelineResult present.
        assert.equal(sentCommand, null, 'V2 path must not send any tmux command');
        assert.ok(result.pipelineResult, 'absent wrapV2 must default to V2 path post-Chunk-11c');
      } finally {
        wrapPipelineMod.runWrapPipeline = originalRun;
        // Restore an explicit wrapV2:false so other tests in this block
        // (beforeEach baseline) get a deterministic legacy default.
        store.projectConfig.save(project.path, {
          ...store.projectConfig.load(project.path),
          wrapV2: false
        });
      }
    });

    // #139 Chunk 11a — V2 session-lifecycle transition. A successful V2
    // wrap that produced a commit ends the session record (status
    // 'wrapped'), kills tmux, releases doc locks, and clears caches —
    // symmetric with the legacy `completeWrap` teardown minus
    // `_autoCommitIfDirty` (V2's commit step already flushed). Halted /
    // thrown / clean-session (ok + null SHA) runs leave the session
    // active.
    describe('V2 lifecycle transition (#139 Chunk 11a)', () => {
      let wrapPipelineMod;
      let originalRun;
      let originalKill;
      let originalReleaseBySession;
      let killCalls;
      let releaseCalls;

      beforeEach(() => {
        wrapPipelineMod = require('../lib/wrap-pipeline');
        originalRun = wrapPipelineMod.runWrapPipeline;
        originalKill = tmux.killSession;
        originalReleaseBySession = store.documentLocks.releaseBySession;
        killCalls = [];
        releaseCalls = [];
        tmux.killSession = (name) => { killCalls.push(name); };
        store.documentLocks.releaseBySession = (sid) => { releaseCalls.push(sid); return 0; };

        const project = store.projects.getByName('prime-test');
        store.projects.update(project.id, { methodology: 'prawduct' });
        store.projectConfig.save(project.path, {
          ...store.projectConfig.load(project.path),
          wrapV2: true
        });
      });

      afterEach(() => {
        wrapPipelineMod.runWrapPipeline = originalRun;
        tmux.killSession = originalKill;
        store.documentLocks.releaseBySession = originalReleaseBySession;
        const project = store.projects.getByName('prime-test');
        if (project) {
          store.projectConfig.save(project.path, {
            ...store.projectConfig.load(project.path),
            wrapV2: false
          });
        }
      });

      /**
       * Stub runWrapPipeline to return a fixed result so the test can
       * pin the lifecycle behavior without exercising real step handlers.
       */
      function stubPipeline(result) {
        wrapPipelineMod.runWrapPipeline = async () => result;
      }

      it('ok + commitSha → wraps the session and runs full teardown', async () => {
        const project = store.projects.getByName('prime-test');
        const session = store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-ok'
        });

        stubPipeline({
          ok: true,
          blockedAt: null,
          results: [
            { stepId: 'memory-update', kind: 'ai-content', status: 'done',
              output: { parsedFields: { summary: 'wrapped via V2' } }, blockers: [] }
          ],
          commitSha: 'abc123',
          summary: null,
          error: null
        });

        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, true);

        const active = store.sessions.getActive(project.id);
        assert.equal(active, null, 'session must no longer be active');

        // getLatest orders by started_at DESC; sessions created in the
        // same second tie. Find this test's wrapped record by id.
        const wrappeds = store.sessions.list(project.id, { status: 'wrapped', limit: 100 });
        const wrapped = wrappeds.find((s) => s.id === session.id);
        assert.ok(wrapped, 'wrapped session record must exist');
        assert.equal(wrapped.status, 'wrapped');
        assert.equal(wrapped.wrapSummary, 'wrapped via V2');
        assert.deepEqual(killCalls, ['wrap-v2-lifecycle-ok'], 'tmux session killed');
        assert.deepEqual(releaseCalls, [session.id], 'doc locks released for this session');
      });

      it('ok + null commitSha (clean session) → session stays active', async () => {
        const project = store.projects.getByName('prime-test');
        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-clean'
        });

        stubPipeline({
          ok: true,
          blockedAt: null,
          results: [],
          commitSha: null,
          summary: null,
          error: null
        });

        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, true);
        const active = store.sessions.getActive(project.id);
        assert.ok(active, 'session must remain active on clean-session wrap');
        assert.deepEqual(killCalls, [], 'tmux not killed on clean-session wrap');
        assert.deepEqual(releaseCalls, [], 'doc locks not released on clean-session wrap');
      });

      it('halted (!ok) → session stays active', async () => {
        const project = store.projects.getByName('prime-test');
        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-halted'
        });

        stubPipeline({
          ok: false,
          blockedAt: 'commit',
          results: [
            { stepId: 'commit', kind: 'commit', status: 'blocked', output: null, blockers: ['pre-commit hook rejected'] }
          ],
          // Commit step that blocked never set its own output.commitSha
          // but the runner could theoretically have surfaced one from a
          // prior step. Pin: a halt always preserves the session.
          commitSha: 'abc123',
          summary: null,
          error: null
        });

        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, false);
        const active = store.sessions.getActive(project.id);
        assert.ok(active, 'session must remain active on halted wrap');
        assert.deepEqual(killCalls, [], 'tmux not killed on halted wrap');
      });

      it('runner thrown → session stays active', async () => {
        const project = store.projects.getByName('prime-test');
        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-thrown'
        });

        wrapPipelineMod.runWrapPipeline = async () => { throw new Error('boom'); };

        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, false);
        assert.ok(result.error.includes('boom'));
        const active = store.sessions.getActive(project.id);
        assert.ok(active, 'session must remain active when the runner throws');
        assert.deepEqual(killCalls, [], 'tmux not killed when the runner throws');
      });

      /**
       * Find this test's just-wrapped session record by id. `getLatest`
       * ties on `started_at` when sessions are created in the same
       * second, so we list by status and pick by id.
       */
      function findWrappedById(projectId, sessionId) {
        const wrappeds = store.sessions.list(projectId, { status: 'wrapped', limit: 200 });
        return wrappeds.find((s) => s.id === sessionId);
      }

      it('summary: parsedFields.summary wins over capturedText', async () => {
        const project = store.projects.getByName('prime-test');
        const session = store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-summary-parsed'
        });

        stubPipeline({
          ok: true,
          blockedAt: null,
          results: [
            // First result has capturedText only — would be a fallback hit.
            { stepId: 'changelog-update', kind: 'ai-content', status: 'done',
              output: { capturedText: 'raw text' }, blockers: [] },
            // Second result has parsedFields.summary — should win.
            { stepId: 'memory-update', kind: 'ai-content', status: 'done',
              output: { parsedFields: { summary: 'parsed summary text' } }, blockers: [] }
          ],
          commitSha: 'abc123',
          summary: null,
          error: null
        });

        await sessions.triggerWrap('prime-test');
        const wrapped = findWrappedById(project.id, session.id);
        assert.ok(wrapped, 'wrapped session record must exist');
        assert.equal(wrapped.wrapSummary, 'parsed summary text');
      });

      it('summary: capturedText is fallback when no parsedFields.summary', async () => {
        const project = store.projects.getByName('prime-test');
        const session = store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-summary-captured'
        });

        stubPipeline({
          ok: true,
          blockedAt: null,
          results: [
            { stepId: 'changelog-update', kind: 'ai-content', status: 'done',
              output: { capturedText: 'just captured text' }, blockers: [] }
          ],
          commitSha: 'def456',
          summary: null,
          error: null
        });

        await sessions.triggerWrap('prime-test');
        const wrapped = findWrappedById(project.id, session.id);
        assert.ok(wrapped, 'wrapped session record must exist');
        assert.equal(wrapped.wrapSummary, 'just captured text');
      });

      it('summary: null when no step output carries summary signal', async () => {
        const project = store.projects.getByName('prime-test');
        const session = store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-summary-null'
        });

        stubPipeline({
          ok: true,
          blockedAt: null,
          results: [
            { stepId: 'commit', kind: 'commit', status: 'done', output: { commitSha: 'abc' }, blockers: [] }
          ],
          commitSha: 'abc',
          summary: null,
          error: null
        });

        await sessions.triggerWrap('prime-test');
        const wrapped = findWrappedById(project.id, session.id);
        assert.ok(wrapped, 'wrapped session record must exist');
        assert.equal(wrapped.wrapSummary, null);
      });

      it('tmux.killSession failure is non-fatal — session still wraps', async () => {
        const project = store.projects.getByName('prime-test');
        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-tmux-throws'
        });

        tmux.killSession = () => { throw new Error('tmux gone'); };

        stubPipeline({
          ok: true,
          blockedAt: null,
          results: [],
          commitSha: 'abc',
          summary: null,
          error: null
        });

        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, true);
        const active = store.sessions.getActive(project.id);
        assert.equal(active, null, 'session must still be wrapped despite tmux.killSession throwing');
        assert.deepEqual(releaseCalls.length, 1, 'doc-lock release still attempted after tmux failure');
      });

      it('store.sessions.wrap failure is non-fatal — teardown still runs', async () => {
        const project = store.projects.getByName('prime-test');
        const session = store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-wrap-throws'
        });

        // Stub store.sessions.wrap to throw — verifies the helper's
        // try/catch isolates the wrap call from the rest of teardown.
        const originalWrap = store.sessions.wrap;
        store.sessions.wrap = () => { throw new Error('wrap update boom'); };

        stubPipeline({
          ok: true,
          blockedAt: null,
          results: [],
          commitSha: 'abc',
          summary: null,
          error: null
        });

        try {
          const result = await sessions.triggerWrap('prime-test');
          // The runner returned ok:true so _triggerWrapV2 also returns
          // ok:true — the wrap-update throw is swallowed inside the
          // teardown helper and surfaces only via log.warn.
          assert.equal(result.ok, true);
          assert.deepEqual(killCalls.length, 1, 'tmux kill still attempted after wrap-update failure');
          assert.deepEqual(releaseCalls.length, 1, 'doc-lock release still attempted after wrap-update failure');
        } finally {
          store.sessions.wrap = originalWrap;
          // Drain the still-active row so afterEach's cleanup doesn't trip.
          const active = store.sessions.getActive(project.id);
          if (active) originalWrap(active.id, 'test cleanup');
          else originalWrap(session.id, 'test cleanup');
        }
      });

      it('second triggerWrap after a successful V2 wrap returns "No active session"', async () => {
        const project = store.projects.getByName('prime-test');
        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-idempotent'
        });

        stubPipeline({
          ok: true,
          blockedAt: null,
          results: [],
          commitSha: 'first-sha',
          summary: null,
          error: null
        });

        const first = await sessions.triggerWrap('prime-test');
        assert.equal(first.ok, true, 'first wrap succeeds');

        // Second invocation: session is no longer active, so the
        // entry-point pre-check rejects before reaching the runner.
        // Pins the idempotency contract at the call-site level.
        const callCountBefore = killCalls.length;
        const second = await sessions.triggerWrap('prime-test');
        assert.equal(second.ok, false);
        assert.ok(second.error && second.error.includes('No active session'),
          'second wrap returns no-active-session error');
        assert.equal(killCalls.length, callCountBefore,
          'tmux kill must not run a second time');
      });

      it('releaseBySession failure is non-fatal — session still wraps', async () => {
        const project = store.projects.getByName('prime-test');
        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-lifecycle-locks-throw'
        });

        store.documentLocks.releaseBySession = () => { throw new Error('lock release boom'); };

        stubPipeline({
          ok: true,
          blockedAt: null,
          results: [],
          commitSha: 'abc',
          summary: null,
          error: null
        });

        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, true);
        const active = store.sessions.getActive(project.id);
        assert.equal(active, null, 'session must still be wrapped despite releaseBySession throwing');
        assert.deepEqual(killCalls.length, 1, 'tmux kill still attempted after lock-release failure');
      });
    });

    // #139 Chunk 11c — default-flip contract pins.
    describe('wrapV2 default flip (#139 Chunk 11c)', () => {
      it('DEFAULT_PROJECT_CONFIG.wrapV2 is true', () => {
        assert.equal(store.DEFAULT_PROJECT_CONFIG.wrapV2, true);
      });

      it('a fresh project (no on-disk config) routes to the V2 path', async () => {
        const wrapPipelineMod = require('../lib/wrap-pipeline');
        const originalRun = wrapPipelineMod.runWrapPipeline;
        wrapPipelineMod.runWrapPipeline = async () => EMPTY_V2_RESULT;

        const project = store.projects.getByName('prime-test');
        store.projects.update(project.id, { methodology: 'prawduct' });

        // Wipe any prior project.json so this test asserts the
        // "fresh-project" default path. (beforeEach above persists a
        // wrapV2:false baseline — we explicitly remove it here.)
        const cfgPath = path.join(project.path, '.tangleclaw', 'project.json');
        if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);

        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-default-fresh-test'
        });

        try {
          const result = await sessions.triggerWrap('prime-test');
          assert.equal(sentCommand, null, 'V2 path must not send any tmux command');
          assert.ok(result.pipelineResult, 'fresh project must route to V2 by default');
        } finally {
          wrapPipelineMod.runWrapPipeline = originalRun;
          // The outer describe's `beforeEach` re-establishes the
          // `wrapV2: false` baseline before each test, so no explicit
          // restore is needed here — only the runWrapPipeline stub
          // needs unwinding.
        }
      });
    });

    it('wrapV2:false (explicit opt-out) uses the legacy NL-prompt path with the post-Chunk-11c step list', async () => {
      // #139 Chunk 11c — the default is now `true`. Projects opting back
      // to the legacy NL-prompt-via-tmux flow set `wrapV2: false` in
      // their `.tangleclaw/project.json`. The prompt structure is
      // byte-equal to the pre-Chunk-11c legacy path; the only change is
      // the comma-joined step list inside `Wrap steps:` (now reflects
      // prawduct's wired-in `open-pr-check` + `critic-check`), which is
      // a function of the methodology template, not the legacy path's
      // own behavior. Identical to the Chunk-2 byte-equal pin in
      // structure — any drift in prompt prefix, separator, or
      // capture-fields suffix means triggerWrap's legacy branch
      // changed.
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      // Explicitly persist wrapV2:false so this test is self-contained.
      store.projectConfig.save(project.path, {
        ...store.projectConfig.load(project.path),
        wrapV2: false
      });
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-v2-false-test'
      });

      await sessions.triggerWrap('prime-test');
      const expected =
        'Perform a session wrap. Commit all uncommitted work, then output a wrap summary.\n' +
        'Wrap steps: open-pr-check, critic-check, version-bump, changelog-update, learnings-capture, next-session-prime, memory-update, commit\n' +
        'Output these fields as ## markdown headings: summary, nextSteps, learnings';
      assert.equal(sentCommand, expected,
        'explicit wrapV2:false opt-out must produce the legacy NL prompt with the post-Chunk-11c step list');
    });

    // #139 Chunk 11c — verify the minimal-methodology opt-out path is
    // intact too. Minimal's pipeline (`learnings-capture`, `memory-update`,
    // `commit`) is a different step set from prawduct, so the legacy NL
    // prompt should reflect minimal's steps.
    it('wrapV2:false (explicit opt-out) on a minimal-methodology project produces the minimal step list', async () => {
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'minimal' });
      store.projectConfig.save(project.path, {
        ...store.projectConfig.load(project.path),
        wrapV2: false
      });
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-minimal-optout-test'
      });

      await sessions.triggerWrap('prime-test');
      const expected =
        'Perform a session wrap. Commit all uncommitted work, then output a wrap summary.\n' +
        'Wrap steps: learnings-capture, memory-update, commit\n' +
        'Output these fields as ## markdown headings: summary';
      assert.equal(sentCommand, expected,
        'minimal-methodology + wrapV2:false must produce the legacy NL prompt with minimal\'s step list');
    });
  });

  describe('wrap state persistence (#91)', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    let originalHasSession, originalCapturePane, originalKillSession;

    before(() => {
      sessions = require('../lib/sessions');
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalCapturePane = tmux.capturePane;
      originalKillSession = tmux.killSession;
      tmux.hasSession = () => true;
      tmux.capturePane = () => ['line1', 'line2', 'line3'];
      tmux.killSession = () => {};
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      tmux.capturePane = originalCapturePane;
      tmux.killSession = originalKillSession;
      // Cleanup wrapping sessions
      const project = store.projects.getByName('prime-test');
      if (project) {
        const wrapping = store.sessions.getWrapping(project.id);
        if (wrapping) store.sessions.wrap(wrapping.id, 'test cleanup');
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    it('getSessionStatus stays wrapping while tmux is alive', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'wrap-stays-active-test'
      });
      store.sessions.setWrapping(session.id);

      const status = sessions.getSessionStatus('prime-test');
      assert.equal(status.wrapping, true);
      assert.equal(status.active, false);
    });

    it('does not export WRAP_TIMEOUT_MS or _wrapStartTimes — server-side timeout removed', () => {
      assert.equal(sessions.WRAP_TIMEOUT_MS, undefined);
      assert.equal(sessions._wrapStartTimes, undefined);
    });
  });

  describe('getSessionHistory', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.getSessionHistory('nonexistent');
      assert.deepEqual(result.sessions, []);
      assert.ok(result.error.includes('not found'));
    });

    it('returns session history for known project', () => {
      const result = sessions.getSessionHistory('prime-test');
      assert.ok(result.sessions.length > 0);
      assert.ok(result.total > 0);
      assert.equal(result.error, null);
    });

    it('respects limit option', () => {
      const result = sessions.getSessionHistory('prime-test', { limit: 1 });
      assert.equal(result.sessions.length, 1);
    });

    it('history entries have expected fields', () => {
      const result = sessions.getSessionHistory('prime-test');
      const entry = result.sessions[0];
      assert.ok('id' in entry);
      assert.ok('engine' in entry);
      assert.ok('startedAt' in entry);
      assert.ok('status' in entry);
    });
  });

  describe('launchSession validation', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.launchSession('nonexistent');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error for archived project', () => {
      const projDir = path.join(projectsDir, 'archived-proj');
      fs.mkdirSync(projDir, { recursive: true });
      const proj = store.projects.create({
        name: 'archived-proj',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
      store.projects.archive(proj.id);

      const result = sessions.launchSession('archived-proj');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('archived'));
    });

    it('returns error for unavailable engine', () => {
      // Create a project with an unavailable engine
      const projDir = path.join(projectsDir, 'bad-engine');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'bad-engine',
        path: projDir,
        engine: 'genesis',
        methodology: 'minimal'
      });

      const result = sessions.launchSession('bad-engine');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('not available'));
    });
  });

  describe('launchSession adopts orphaned tmux session', () => {
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let sessions;
    let originalHasSession;
    let originalDetectEngine;

    before(() => {
      sessions = require('../lib/sessions');

      // Create a project with the claude engine
      const projDir = path.join(projectsDir, 'orphan-test');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'orphan-test',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalDetectEngine = enginesModule.detectEngine;
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      enginesModule.detectEngine = originalDetectEngine;
      // Clean up any active sessions so tests are independent
      const project = store.projects.getByName('orphan-test');
      if (project) {
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    it('adopts orphaned tmux session instead of failing', () => {
      // Mock: tmux session exists, engine is available
      tmux.hasSession = (name) => name === 'orphan-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const result = sessions.launchSession('orphan-test');

      assert.equal(result.error, null);
      assert.ok(result.session, 'should return a session');
      assert.equal(result.session.tmuxSession, 'orphan-test');
      assert.equal(result.session.engineId, 'claude');
    });

    it('writes project-version.txt during launch (#101 — TC owns the writer)', () => {
      tmux.hasSession = (name) => name === 'orphan-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('orphan-test');
      const cachePath = path.join(project.path, '.tangleclaw', 'project-version.txt');
      const seededPkgPath = path.join(project.path, 'package.json');
      try { fs.rmSync(cachePath, { force: true }); } catch {}
      try {
        // Seed a version source so detection has something to write.
        fs.writeFileSync(seededPkgPath, '{"version": "0.1.0"}\n');

        const result = sessions.launchSession('orphan-test');
        assert.equal(result.error, null);
        assert.ok(fs.existsSync(cachePath), 'project-version.txt should exist after launch');
        const body = fs.readFileSync(cachePath, 'utf8');
        assert.match(body, /^version: 0\.1\.0$/m);
        assert.match(body, /^source: package\.json$/m);
        assert.match(body, /^recorded_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
      } finally {
        // Test isolation (Critic MINOR): leaving the seeded package.json behind
        // would let the next test in this suite hit a different detection layer.
        try { fs.rmSync(seededPkgPath, { force: true }); } catch {}
        try { fs.rmSync(cachePath, { force: true }); } catch {}
        try { fs.rmSync(path.dirname(cachePath), { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe('launchSession stale wrapping recovery (#105)', () => {
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let sessions;
    let originalHasSession;
    let originalDetectEngine;
    let originalKillSession;
    let originalCreateSession;
    let killedTmux;

    before(() => {
      sessions = require('../lib/sessions');
      // Project for launch-guard tests
      const projDir = path.join(projectsDir, 'stale-wrap');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'stale-wrap',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalDetectEngine = enginesModule.detectEngine;
      originalKillSession = tmux.killSession;
      originalCreateSession = tmux.createSession;
      killedTmux = [];
      tmux.killSession = (name) => { killedTmux.push(name); };
      tmux.createSession = () => true;
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      tmux.killSession = originalKillSession;
      tmux.createSession = originalCreateSession;
      enginesModule.detectEngine = originalDetectEngine;
      const project = store.projects.getByName('stale-wrap');
      if (project) {
        const wrapping = store.sessions.getWrapping(project.id);
        if (wrapping) store.sessions.kill(wrapping.id, 'test cleanup');
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    /**
     * Force a session row's wrap_started_at to a past timestamp (simulating a
     * wrap that has been stuck for `hoursAgo` hours). Uses store.getDb()
     * directly since there is no public mutator for this column — appropriate
     * here because the field is otherwise managed exclusively by setWrapping.
     */
    function _backdateWrapStart(sessionId, hoursAgo) {
      const db = store.getDb();
      db.prepare(`UPDATE sessions SET wrap_started_at = datetime('now', ?) WHERE id = ?`)
        .run(`-${hoursAgo} hours`, sessionId);
    }

    function _backdateStartedAt(sessionId, hoursAgo) {
      const db = store.getDb();
      db.prepare(`UPDATE sessions SET started_at = datetime('now', ?) WHERE id = ?`)
        .run(`-${hoursAgo} hours`, sessionId);
    }

    function _clearWrapStart(sessionId) {
      const db = store.getDb();
      db.prepare('UPDATE sessions SET wrap_started_at = NULL WHERE id = ?').run(sessionId);
    }

    it('recovers stale wrapping row (>1h) and proceeds with fresh launch', () => {
      const project = store.projects.getByName('stale-wrap');
      // Distinct tmux name on the wrapping row so the recovery-kill is
      // distinguishable from the pre-launch orphan-kill that fires later in
      // launchSession against the project's canonical tmux name (Critic MINOR).
      const stale = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'stale-wrap-OLD'
      });
      store.sessions.setWrapping(stale.id);
      _backdateWrapStart(stale.id, 2); // wrap began 2h ago — well past threshold
      tmux.hasSession = (name) => name === 'stale-wrap-OLD' || name === 'stale-wrap';

      const result = sessions.launchSession('stale-wrap');

      assert.equal(result.error, null, 'launch should proceed');
      assert.ok(result.session, 'fresh session should be created');
      assert.notEqual(result.session.id, stale.id, 'should be a new session row');
      assert.ok(killedTmux.includes('stale-wrap-OLD'),
        'stale wrapping tmux name should have been killed during recovery branch');

      // Original wrapping row should now be marked killed
      const recovered = store.sessions.list(project.id, { status: 'killed', limit: 5 })
        .find((s) => s.id === stale.id);
      assert.ok(recovered, 'stale row should be marked killed');
      assert.equal(recovered.status, 'killed');
    });

    it('falls back to recovery (not block) when timestamps are unparseable', () => {
      // Defense for MINOR 5: a wrapping row with corrupt timestamps must not
      // brick the project. Fail-safe direction is "recover" since that's the
      // entire bug class #105 was filed for.
      const project = store.projects.getByName('stale-wrap');
      const corrupt = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'corrupt-wrap'
      });
      store.sessions.setWrapping(corrupt.id);
      const db = store.getDb();
      db.prepare("UPDATE sessions SET wrap_started_at = '<not a date>', started_at = '<not a date>' WHERE id = ?")
        .run(corrupt.id);
      tmux.hasSession = () => true;

      const result = sessions.launchSession('stale-wrap');
      assert.equal(result.error, null, 'corrupt timestamps must not block launch');
      assert.ok(result.session);
    });

    it('blocks launch when wrapping row is recent (<1h) and tmux is alive', () => {
      const project = store.projects.getByName('stale-wrap');
      const recent = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'recent-wrap'
      });
      store.sessions.setWrapping(recent.id);
      // wrap_started_at defaults to now (just set by setWrapping) — well within threshold
      tmux.hasSession = (name) => name === 'recent-wrap';

      const result = sessions.launchSession('stale-wrap');

      assert.equal(result.session, null);
      assert.ok(result.error.includes('currently wrapping'));
      assert.deepEqual(killedTmux, [], 'recent wrap should not be killed');
    });

    it('falls back to started_at for legacy rows with NULL wrap_started_at', () => {
      // Legacy row predates schema v14 — wrap_started_at is NULL but the row
      // is in wrapping status with an old started_at. Should still recover.
      const project = store.projects.getByName('stale-wrap');
      const legacy = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'legacy-wrap-OLD'
      });
      store.sessions.setWrapping(legacy.id);
      _clearWrapStart(legacy.id);
      _backdateStartedAt(legacy.id, 3); // started 3h ago
      tmux.hasSession = (name) => name === 'legacy-wrap-OLD' || name === 'stale-wrap';

      const result = sessions.launchSession('stale-wrap');

      assert.equal(result.error, null, 'legacy stale row should be recovered too');
      assert.ok(result.session);
      assert.notEqual(result.session.id, legacy.id);
      assert.ok(killedTmux.includes('legacy-wrap-OLD'),
        'legacy stale tmux name should have been killed during recovery');
    });

    it('STALE_WRAPPING_THRESHOLD_MS is 1 hour', () => {
      assert.equal(sessions.STALE_WRAPPING_THRESHOLD_MS, 60 * 60 * 1000);
    });

    it('setWrapping populates wrap_started_at on transition (schema v14)', () => {
      const project = store.projects.getByName('stale-wrap');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'set-wrapping-timestamp'
      });
      const wrapped = store.sessions.setWrapping(session.id);
      assert.ok(wrapped, 'setWrapping should return updated row');
      assert.equal(wrapped.status, 'wrapping');
      assert.ok(wrapped.wrapStartedAt, 'wrap_started_at should be populated');
      // Should be within the last few seconds. Parse as UTC since SQLite emits
      // a TZ-less string and the test machine may not be in UTC.
      const ageMs = Date.now() - sessions._parseSqliteUtcMs(wrapped.wrapStartedAt);
      assert.ok(ageMs < 5000, `wrap_started_at should be very recent (got ageMs=${ageMs})`);
      assert.ok(ageMs >= 0, `wrap_started_at should not be in the future (got ageMs=${ageMs})`);
    });

    it('_parseSqliteUtcMs interprets TZ-less SQLite timestamps as UTC', () => {
      // SQLite emits 'YYYY-MM-DD HH:MM:SS' without timezone — should parse as UTC.
      const tzLess = '2026-04-29 05:00:00';
      const withZ = '2026-04-29T05:00:00Z';
      assert.equal(sessions._parseSqliteUtcMs(tzLess), Date.parse(withZ));
      // Also handle inputs that already have Z or offset
      assert.equal(sessions._parseSqliteUtcMs(withZ), Date.parse(withZ));
      assert.ok(Number.isNaN(sessions._parseSqliteUtcMs(null)));
      assert.ok(Number.isNaN(sessions._parseSqliteUtcMs('')));
    });
  });

  describe('silent prime delivery (#103)', () => {
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let sessions;
    let originalHasSession;
    let originalDetectEngine;

    before(() => {
      sessions = require('../lib/sessions');
      const projDir = path.join(projectsDir, 'silent-prime-test');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'silent-prime-test',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalDetectEngine = enginesModule.detectEngine;
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      enginesModule.detectEngine = originalDetectEngine;
      const project = store.projects.getByName('silent-prime-test');
      if (project) {
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
        // Clean up prime file + project config so each test starts fresh
        try { fs.rmSync(path.join(project.path, '.tangleclaw'), { recursive: true, force: true }); } catch {}
      }
      // Real tmux session may have been spawned by launchSession — clean it up
      // so the next test starts without leftover state.
      try { require('node:child_process').execSync('tmux kill-session -t silent-prime-test 2>/dev/null', { stdio: 'ignore' }); } catch {}
    });

    it('_writePrimeFile creates .tangleclaw/session-prime.md and returns its path', () => {
      const project = store.projects.getByName('silent-prime-test');
      const out = sessions._writePrimeFile(project.path, '# prime\nbody line\n');
      const expected = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(out, expected);
      assert.equal(fs.readFileSync(expected, 'utf8'), '# prime\nbody line\n');
    });

    it('_writePrimeFile creates .tangleclaw/ directory when missing', () => {
      const project = store.projects.getByName('silent-prime-test');
      const tcDir = path.join(project.path, '.tangleclaw');
      try { fs.rmSync(tcDir, { recursive: true, force: true }); } catch {}
      assert.equal(fs.existsSync(tcDir), false, 'precondition: .tangleclaw missing');

      sessions._writePrimeFile(project.path, 'body');

      assert.equal(fs.existsSync(tcDir), true);
      assert.equal(fs.existsSync(path.join(tcDir, 'session-prime.md')), true);
    });

    it('_writePrimeFile returns null when the path is unwritable (non-throwing)', () => {
      // Pass a path that cannot be created (parent is a file, not a dir).
      const fakeProject = path.join(projectsDir, 'silent-prime-not-a-dir');
      try { fs.rmSync(fakeProject, { force: true, recursive: true }); } catch {}
      fs.writeFileSync(fakeProject, 'i am a file, not a project');
      try {
        const out = sessions._writePrimeFile(fakeProject, 'body');
        assert.equal(out, null);
      } finally {
        fs.rmSync(fakeProject, { force: true });
      }
    });

    it('launchSession writes prime file when projConfig.silentPrime is true', () => {
      // Mirror the orphan-adoption pattern from the launchSession tests above:
      // pretend a tmux session exists so launchSession kills+recreates rather
      // than failing on whatever stale tmux state may exist on the test host.
      tmux.hasSession = (name) => name === 'silent-prime-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('silent-prime-test');
      // Enable silentPrime via project config
      store.projectConfig.save(project.path, {
        engine: 'claude',
        methodology: 'minimal',
        silentPrime: true
      });

      const result = sessions.launchSession('silent-prime-test');
      assert.equal(result.error, null);

      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), true, 'prime file should be written');
      assert.ok(fs.readFileSync(primeFile, 'utf8').length > 0, 'prime file should be non-empty');
    });

    it('launchSession does NOT write prime file when silentPrime is explicitly false', () => {
      // Mirror the orphan-adoption pattern from the launchSession tests above:
      // pretend a tmux session exists so launchSession kills+recreates rather
      // than failing on whatever stale tmux state may exist on the test host.
      tmux.hasSession = (name) => name === 'silent-prime-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('silent-prime-test');
      // Explicit silentPrime=false — post-#129 the default is true, so the
      // test now has to be explicit about the silent-off state it's testing.
      store.projectConfig.save(project.path, {
        engine: 'claude',
        methodology: 'minimal',
        silentPrime: false
      });
      const result = sessions.launchSession('silent-prime-test');
      assert.equal(result.error, null);

      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), false, 'prime file should not be written when silent is off');
    });

    it('launchSession does NOT write prime file when engine lacks supportsSilentPrime capability', () => {
      // Stub the claude engine profile to drop the supportsSilentPrime capability,
      // then assert silentPrime=true in projConfig is ignored gracefully.
      // Mirror the orphan-adoption pattern from the launchSession tests above:
      // pretend a tmux session exists so launchSession kills+recreates rather
      // than failing on whatever stale tmux state may exist on the test host.
      tmux.hasSession = (name) => name === 'silent-prime-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('silent-prime-test');
      store.projectConfig.save(project.path, {
        engine: 'claude',
        methodology: 'minimal',
        silentPrime: true
      });

      // launchSession reads the engine profile via store.engines.get (not the
      // availability-enriched variant) — patch there so silentPrime resolves to false.
      const origGet = store.engines.get;
      store.engines.get = (id) => {
        const real = origGet(id);
        if (real && real.capabilities) {
          return { ...real, capabilities: { ...real.capabilities, supportsSilentPrime: false } };
        }
        return real;
      };
      try {
        const result = sessions.launchSession('silent-prime-test');
        assert.equal(result.error, null);
        const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
        assert.equal(fs.existsSync(primeFile), false,
          'engines without supportsSilentPrime should fall back to typed prime even if user opted in');
      } finally {
        store.engines.get = origGet;
      }
    });

    it('DEFAULT_PROJECT_CONFIG.silentPrime is true (#129 — soak satisfied)', () => {
      // Pre-#129 this was false (opt-in until proven stable). After ~2 weeks of
      // soak with no regressions, the default flipped to true. Projects that
      // explicitly persisted `silentPrime: false` continue to honor that; the
      // capability gate (`engineProfile.capabilities.supportsSilentPrime`)
      // protects non-Claude engines regardless of the default.
      const projDir = path.join(projectsDir, 'silentprime-default-check');
      fs.mkdirSync(projDir, { recursive: true });
      try {
        const cfg = store.projectConfig.load(projDir);
        assert.equal(cfg.silentPrime, true);
      } finally {
        fs.rmSync(projDir, { recursive: true, force: true });
      }
    });

    // ── Chunk 3: prime-file cleanup on silent→typed transition ──

    it('_removePrimeFile removes session-prime.md and returns true', () => {
      const project = store.projects.getByName('silent-prime-test');
      sessions._writePrimeFile(project.path, 'stale prime body');
      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), true, 'precondition: prime file written');

      const result = sessions._removePrimeFile(project.path);
      assert.equal(result, true);
      assert.equal(fs.existsSync(primeFile), false, 'prime file should be gone');
    });

    it('_removePrimeFile returns false when prime file is absent (no-op)', () => {
      const project = store.projects.getByName('silent-prime-test');
      // Ensure the file does NOT exist
      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      try { fs.unlinkSync(primeFile); } catch {}

      const result = sessions._removePrimeFile(project.path);
      assert.equal(result, false);
    });

    it('_removePrimeFile is non-throwing when unlink itself fails (exercises catch arm)', () => {
      // Pre-fix Mn2 from final Critic: the original test passed a missing path
      // and exited via the `existsSync === false` branch, never reaching the
      // catch. Stub fs.unlinkSync to throw so we genuinely test the catch path.
      const project = store.projects.getByName('silent-prime-test');
      sessions._writePrimeFile(project.path, 'will be unlinked');
      const fs2 = require('node:fs');
      const original = fs2.unlinkSync;
      fs2.unlinkSync = () => { throw new Error('simulated EACCES'); };
      try {
        const result = sessions._removePrimeFile(project.path);
        assert.equal(result, false, 'returns false when unlink throws');
      } finally {
        fs2.unlinkSync = original;
        // Real cleanup so we don't leak the prime file into other tests.
        try { fs2.unlinkSync(path.join(project.path, '.tangleclaw', 'session-prime.md')); } catch {}
      }
    });

    it('launchSession removes stale prime file when silentPrime flips to false', () => {
      // The transition path: silentPrime was on (file exists), user toggles off,
      // next session launch should clean up the stale file so the SessionStart
      // hook (still installed) doesn't replay yesterday's prime.
      tmux.hasSession = (name) => name === 'silent-prime-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('silent-prime-test');
      // Pre-seed a stale prime file (from a prior silent session)
      sessions._writePrimeFile(project.path, '# stale prime from yesterday\n');
      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), true, 'precondition: stale file present');

      // silentPrime now false (the off-by-default config)
      store.projectConfig.save(project.path, {
        engine: 'claude',
        methodology: 'minimal',
        silentPrime: false
      });

      const result = sessions.launchSession('silent-prime-test');
      assert.equal(result.error, null);

      assert.equal(fs.existsSync(primeFile), false,
        'stale prime file should be removed when silentPrime is off');
    });
  });
});
