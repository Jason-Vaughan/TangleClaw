'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
// The config READER moved out of `store` into its own dependency-free module
// (#884) so the killable scanner child can use it. Stubs must follow the code:
// stubbing `projectConfigModule.load` no longer reaches the callers below.
const projectConfigModule = require('../lib/project-config');
const projects = require('../lib/projects');
const engines = require('../lib/engines');

describe('projects', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-projects-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();

    // Set projectsDir in config
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Enriching a registered project used to read that project's own directory on
  // this process's event loop — `fs.existsSync` plus `engines.governanceState`
  // beneath it — on the route the dashboard polls every ten seconds. #883 moved
  // the walk for UNREGISTERED folders into a killable child and left this half
  // standing, so a single TCC-protected project directory still wedged every
  // route. These pin the delegation and the degradation; whether the scanner
  // really kills a hung child is `test/dir-scanner.test.js`'s job, and the
  // handler's own answers are in `test/dir-scanner-child.test.js`.
  describe('enrichment reads a project directory in the scanner child (#884)', () => {
    const dirScanner = require('../lib/dir-scanner');

    /**
     * The rejection the scanner produces when a path never answered.
     * @returns {Error}
     */
    function timedOut() {
      return Object.assign(new Error('timed out after 2000ms reading /nowhere'),
        { tcTimedOut: true });
    }

    /**
     * Run `fn` with BOTH scanner entry points replaced, then restore them.
     *
     * Both, deliberately. `lib/dir-scanner.js` runs two scanners — a polled one
     * that opts into the per-path failure backoff and an interactive one that
     * does not — and which of them a read travels on is the thing most likely to
     * regress silently here, because using the wrong one still returns a correct
     * answer on a healthy machine. Stubbing only the polled entry point would let
     * an operator-path read fall through to a real child and pass.
     *
     * @param {Function} fake - Stand-in, called as (kind, op, payload, opts).
     * @param {Function} fn - Test body.
     * @returns {Promise<any>}
     */
    async function withScanner(fake, fn) {
      const realReq = dirScanner.request;
      const realInteractive = dirScanner.interactiveRequest;
      dirScanner.request = (op, payload, opts) => fake('polled', op, payload, opts);
      dirScanner.interactiveRequest = (op, payload, opts) => fake('interactive', op, payload, opts);
      try {
        return await fn();
      } finally {
        dirScanner.request = realReq;
        dirScanner.interactiveRequest = realInteractive;
      }
    }

    it('asks the scanner for every registered project, keyed by its own path', async () => {
      projects.createProject({ name: 'facts-delegation' });
      const seen = [];
      await withScanner(
        (kind, op, payload, opts) => {
          seen.push({ kind, op, payload, opts });
          return Promise.resolve({ exists: true, governanceState: 'ungoverned' });
        },
        () => projects.listProjects()
      );

      assert.ok(seen.length > 0, 'the fixture must have registered projects to enrich');
      const mine = seen.find((r) => r.payload.dir.endsWith('facts-delegation'));
      assert.ok(mine, 'the project under test must have reached the scanner');
      assert.equal(mine.op, 'projectFacts');
      // THE MUTATION THIS CATCHES: dropping `pathKey` on the poll. Without it the
      // supervisor's backoff cannot fire, so an unreadable directory costs a
      // killed child on every ten-second poll forever — and a child blocked in
      // the kernel may never leave the process table.
      assert.equal(mine.kind, 'polled', 'the dashboard poll reads on the polled scanner');
      assert.equal(mine.opts.pathKey, mine.payload.dir,
        'the poll must opt into the per-path backoff, since nobody asked for this read');
    });

    it('an operator-pressed read never rides the poll\'s backoff or its child', async () => {
      // THE REGRESSION THIS EXISTS FOR. `enrichProject` gathers its own facts for
      // eight callers, every one of them operator-pressed — attach, PATCH, launch
      // a session, migrate, the continuity routes. Sending those through the
      // polled scanner means someone who grants Full Disk Access and presses the
      // button again is answered from a remembered refusal for up to five
      // minutes, and their click can be killed as collateral for a hung poll.
      // Both halves were recorded decisions before this code existed
      // (architecture.md Decision 8, and lib/dir-scanner.js's own export block),
      // and shipping the second half is a defect this project has already had
      // once, in #883 chunk 2.
      projects.createProject({ name: 'facts-operator' });
      const row = store.projects.getByName('facts-operator');

      const seen = [];
      await withScanner(
        (kind, op, payload, opts) => {
          seen.push({ kind, opts });
          return Promise.resolve({ exists: true, governanceState: 'ungoverned' });
        },
        () => projects.enrichProject(row)
      );

      assert.equal(seen.length, 1, 'exactly one read for a single project');
      assert.equal(seen[0].kind, 'interactive',
        'an operator-pressed read must not share a child with the dashboard poll');
      assert.equal(seen[0].opts.pathKey, undefined,
        'and must not be answered from the poll\'s failure backoff');
    });

    it('one unreadable project does not cost the others their governance state', async () => {
      // The acceptance criterion. Before this, one protected directory did not
      // degrade one card — it stopped the process answering anything at all.
      projects.createProject({ name: 'facts-healthy' });
      projects.createProject({ name: 'facts-stuck' });

      const list = await withScanner(
        (kind, op, payload) => (payload.dir.endsWith('facts-stuck')
          ? Promise.reject(timedOut())
          : Promise.resolve({ exists: true, governanceState: 'governed-plugin' })),
        () => projects.listProjects()
      );

      const stuck = list.find((p) => p.name === 'facts-stuck');
      const healthy = list.find((p) => p.name === 'facts-healthy');
      assert.ok(stuck && healthy, 'both projects must still be listed');
      assert.equal(healthy.governanceState, 'governed-plugin',
        'a healthy project keeps its real answer while a sibling is stuck');
      assert.equal(stuck.governanceState, 'not-applicable');
      assert.match(stuck.unreadable, /timed out/,
        'and the one that failed says so, rather than being indistinguishable from a missing folder');
      assert.equal(healthy.unreadable, null,
        'the healthy project carries no failure reason');
      // A directory that did not answer is the ONE case the Full Disk Access
      // advice fits, and it is the reason the flag exists — dropping the remedy
      // leaves an operator with a broken card and no next step.
      assert.match(stuck.unreadableHint, /Full Disk Access/,
        'a path that did not answer must carry the remedy for the reason it usually did not');
      assert.equal(healthy.unreadableHint, null,
        'and a healthy project must not be told to change its permissions');
    });

    it('enrichProject runs no git subprocess when the facts already carry git', async () => {
      // THE MUTATION THIS CATCHES: `facts.exists ? git.getInfo(project.path) : null`
      // in place of `facts.git`. That reads identically — same branch, same values,
      // every other assertion green — while putting `execSync` back on the event
      // loop, which is the entire defect. Nothing about the RESULT distinguishes
      // the two, so the test has to observe the call rather than the value.
      const git = require('../lib/git');
      projects.createProject({ name: 'facts-nogitcall' });
      const row = store.projects.getByName('facts-nogitcall');

      const realGetInfo = git.getInfo;
      let called = 0;
      git.getInfo = (...args) => { called++; return realGetInfo(...args); };
      try {
        const enriched = await projects.enrichProject(row, {
          exists: true,
          governanceState: 'ungoverned',
          git: { branch: 'from-the-child', dirty: false },
          config: null,
          unreadable: null,
          unreadableHint: null
        });
        assert.equal(enriched.git.branch, 'from-the-child',
          'the git info must be the one the child supplied');
      } finally {
        git.getInfo = realGetInfo;
      }

      assert.equal(called, 0,
        'enrichProject must not shell out to git when the scanner already answered');
    });

    it('enrichProject reads no version from disk — it reports what the child detected', async () => {
      // THE MUTATION THIS CATCHES: restoring `_detectProjectVersion(project.path)`
      // here. The fixture is what makes that observable: the project's directory
      // carries version.json at 1.0.0, while the facts say 9.9.9. Reading disk
      // returns 1.0.0 and every other assertion in this file stays green, because
      // the value is still a plausible version from a real file — which is exactly
      // how the last synchronous read in this function would come back unnoticed.
      projects.createProject({ name: 'facts-noversionread' });
      const row = store.projects.getByName('facts-noversionread');
      fs.writeFileSync(path.join(row.path, 'version.json'), JSON.stringify({ version: '1.0.0' }));

      const enriched = await projects.enrichProject(row, {
        exists: true,
        governanceState: 'ungoverned',
        git: null,
        config: null,
        version: '9.9.9',
        unreadable: null,
        unreadableHint: null
      });

      assert.equal(enriched.version, '9.9.9',
        'the version must be the child\'s answer, not one re-read here');
    });

    it('a project whose directory would not answer carries no version at all', async () => {
      // The honest degrade. A directory that never replied has no known version,
      // and the alternative — the detection chain's `0.0.0-dev` fallback — would
      // render on the card as a fact the server never established.
      projects.createProject({ name: 'facts-versionless' });
      const row = store.projects.getByName('facts-versionless');

      const enriched = await withScanner(
        () => Promise.reject(timedOut()),
        () => projects.enrichProject(row)
      );

      assert.equal(enriched.version, null);
      assert.match(enriched.unreadableHint, /Full Disk Access/,
        'and it still says why, so the null is attributable');
    });

    it('issues one scanner request at a time, so a deadline never times the queue', async () => {
      // THE MUTATION THIS CATCHES: `Promise.all(projects.map(readProjectFacts))`.
      // The child is single-threaded and each request now runs ~six execSync git
      // spawns, but `dir-scanner.js` starts a request's timer when it is ISSUED,
      // not when the child picks it up — so firing N at once put N deadlines on a
      // serial queue. The tail spent its deadline waiting its turn, and expiring
      // killed the SHARED child: healthy siblings came back aborted, one earned
      // the Full Disk Access hint this module exists to prevent, and they entered
      // the 30s→5min backoff. It scaled with project count, and no test here used
      // more than two projects.
      for (const n of ['seq-a', 'seq-b', 'seq-c', 'seq-d']) projects.createProject({ name: n });

      let inFlight = 0;
      let maxInFlight = 0;
      await withScanner(
        () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // Resolve on a later turn, so an overlapping issue is observable at all.
          return new Promise((resolve) => setImmediate(() => {
            inFlight--;
            resolve({ exists: true, governanceState: 'ungoverned' });
          }));
        },
        () => projects.listProjects()
      );

      assert.ok(maxInFlight > 0, 'the fixture must actually have reached the scanner');
      assert.equal(maxInFlight, 1,
        'the poll must not have two directory reads outstanding against a serial child');
    });

    it('translates every failure shape into the code #885 branches on', async () => {
      // THE MUTATION THIS CATCHES: deleting any of the three lines that produce
      // `unreadableCode`. It shipped as a documented contract field — the one
      // `api-contract.md` tells consumers to branch on instead of parsing prose —
      // with no assertion anywhere, which is the third time in this issue that a
      // fix for a review finding arrived without a guard. The child-side check
      // asserts the raw `code`, which never crosses `readProjectFacts`, so the
      // translation itself was the untested part.
      projects.createProject({ name: 'facts-codes' });
      const row = store.projects.getByName('facts-codes');

      /**
       * Enrich this one project with a scanner that answers `answer`.
       * @param {Function} answer - Stand-in reply or rejection.
       * @returns {Promise<object>} The enriched record.
       */
      const enrichWith = (answer) => withScanner(answer, () => projects.enrichProject(row));

      const timedOut = await enrichWith(() => Promise.reject(
        Object.assign(new Error('timed out after 5000ms'), { tcTimedOut: true })));
      assert.equal(timedOut.unreadableCode, 'SCAN_TIMEOUT');
      assert.match(timedOut.unreadableHint, /Full Disk Access/);

      const cached = await enrichWith(() => Promise.reject(
        Object.assign(new Error('not answering'), { tcTimedOut: true, tcCached: true })));
      assert.equal(cached.unreadableCode, 'SCAN_CACHED',
        'a remembered refusal is distinguishable from a fresh one');

      const aborted = await enrichWith(() => Promise.reject(
        Object.assign(new Error('killed for another path'), { tcAborted: true })));
      assert.equal(aborted.unreadableCode, 'SCAN_ABORTED');
      assert.equal(aborted.unreadableHint, null,
        'collateral earns no remedy — its own directory may be fine');

      const failed = await enrichWith(() => Promise.reject(
        Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })));
      assert.equal(failed.unreadableCode, 'SCAN_FAILED');

      // The child's own refusal: it answers rather than rejecting, and its raw
      // `code` must be TRANSLATED onto the caller's field rather than forwarded
      // as a second vocabulary.
      const refused = await enrichWith(() => Promise.resolve({
        exists: true, governanceState: 'not-applicable', git: null, config: null,
        unreadable: 'the directory is there but this server may not read it (permission denied)',
        code: 'EACCES'
      }));
      assert.equal(refused.unreadableCode, 'EACCES');
      assert.match(refused.unreadable, /permission denied/);

      const healthy = await enrichWith(() => Promise.resolve(
        { exists: true, governanceState: 'ungoverned', git: null, config: null }));
      assert.equal(healthy.unreadableCode, null, 'and a healthy project carries no code');
    });

    it('getProjectRow answers from the database without touching the scanner', async () => {
      // R-11 from Chunk 01's review. Eight routes — the four continuity readers,
      // both upload routes, delete and session launch — use a project lookup only
      // as a 404 guard plus `path`. Enriching them meant a cross-process round
      // trip to answer a question they never ask.
      projects.createProject({ name: 'facts-rowonly' });

      let reached = false;
      const row = await withScanner(
        () => { reached = true; return Promise.resolve({ exists: true, governanceState: 'ungoverned' }); },
        () => projects.getProjectRow('facts-rowonly')
      );

      assert.ok(row, 'the row must still be returned');
      assert.equal(row.name, 'facts-rowonly');
      assert.ok(row.path, 'and must carry the path those callers need');
      // THE MUTATION THIS CATCHES: routing getProjectRow back through
      // enrichProject "for consistency". That is a whole process spawned to
      // answer a question with a database row.
      assert.equal(reached, false, 'and no scanner request may be made for it');
      assert.equal(row.governanceState, undefined,
        'a row is deliberately not an enriched record — a caller needing that wants getProject');
    });

    it('returns null for a project that does not exist, like getProject', async () => {
      assert.equal(projects.getProjectRow('no-such-project-anywhere'), null);
    });

    it('a read cancelled for a SIBLING\'s hang is not blamed on its own directory', async () => {
      // THE MUTATION THIS CATCHES: collapsing the catch back to one branch, so
      // every failure earns the Full Disk Access remedy. `tcAborted` means this
      // request died because the supervisor killed the child to reclaim a thread
      // some OTHER path blocked — this directory may be perfectly healthy, and
      // telling the operator to change permissions because of it is precisely
      // the misdiagnosis the whole scanner exists to remove. R-16 of #884's first
      // review shipped exactly this collapse, because nothing tested the branch.
      projects.createProject({ name: 'facts-collateral' });

      const list = await withScanner(
        (kind, op, payload) => (payload.dir.endsWith('facts-collateral')
          ? Promise.reject(Object.assign(
            new Error('the scanner process was killed after another request stopped responding'),
            { tcAborted: true }))
          : Promise.resolve({ exists: true, governanceState: 'ungoverned' })),
        () => projects.listProjects()
      );

      const collateral = list.find((p) => p.name === 'facts-collateral');
      assert.ok(collateral, 'the project must still be listed');
      assert.ok(collateral.unreadable, 'and must say it could not be read');
      assert.equal(collateral.unreadableHint, null,
        'but must NOT be given the Full Disk Access remedy — its own path may be fine');
      // Asserted on the REASON, not just the absent hint: the hint is already
      // null for a collateral abort whichever branch runs, because it is gated on
      // tcTimedOut/tcCached. So an assertion about the hint alone passes with the
      // branch deleted, which is a guard that guards nothing. What actually
      // differs is what this says happened.
      assert.match(collateral.unreadable, /cancelled/,
        'a collateral abort must read as cancelled, not as a directory that would not answer');
      assert.doesNotMatch(collateral.unreadable, /did not answer/,
        'because its own directory was never asked and may be perfectly healthy');
    });

    it('does not WARN about a healthy directory that was only collateral', async () => {
      // The other half, and the operator-visible one. A collateral abort logging
      // at WARN puts "Could not read a project directory" in the log naming a
      // path that is fine — the same misdiagnosis in the log that the tcTimedOut
      // hint avoids in the UI. The kill that caused it is already logged once, by
      // the supervisor, naming the path that actually hung.
      const logger = require('../lib/logger');
      projects.createProject({ name: 'facts-quiet' });

      const chunks = [];
      const prevLevel = logger.getLevel();
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (c) => { chunks.push(String(c)); return true; } });
      try {
        await withScanner(
          (kind, op, payload) => (payload.dir.endsWith('facts-quiet')
            ? Promise.reject(Object.assign(new Error('killed'), { tcAborted: true }))
            : Promise.resolve({ exists: true, governanceState: 'ungoverned' })),
          () => projects.listProjects()
        );
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel(prevLevel);
      }

      assert.doesNotMatch(chunks.join(''), /facts-quiet/,
        'a directory that was never actually read must not be named in a warning');
    });

    it('enrichProject reads the facts itself when a caller does not supply them', async () => {
      // THE MUTATION THIS CATCHES: defaulting the `facts` parameter to a
      // plausible-looking literal. An earlier draft defaulted it to the shape a
      // missing directory produces; the eight call sites that pass nothing then
      // reported every project as having no governance, and nothing failed. An
      // omitted argument must make this function do the read — slower, never
      // silently wrong.
      projects.createProject({ name: 'facts-unsupplied' });
      const row = store.projects.getByName('facts-unsupplied');

      let asked = false;
      const enriched = await withScanner(
        (kind, op, payload) => {
          if (payload.dir === row.path) asked = true;
          return Promise.resolve({ exists: true, governanceState: 'governed-vendored' });
        },
        () => projects.enrichProject(row)
      );

      assert.ok(asked, 'enrichProject must gather facts when none were passed in');
      assert.equal(enriched.governanceState, 'governed-vendored');
    });
  });

  describe('validateName', () => {
    it('accepts valid names', async () => {
      assert.ok(projects.validateName('my-project').valid);
      assert.ok(projects.validateName('Project_1').valid);
      assert.ok(projects.validateName('test123').valid);
    });

    it('rejects empty names', async () => {
      assert.equal(projects.validateName('').valid, false);
      assert.equal(projects.validateName(null).valid, false);
      assert.equal(projects.validateName(undefined).valid, false);
    });

    it('accepts names with spaces', async () => {
      assert.equal(projects.validateName('my project').valid, true);
      assert.equal(projects.validateName('TiLT v2').valid, true);
    });

    it('rejects names with special characters', async () => {
      assert.equal(projects.validateName('my/project').valid, false);
      assert.equal(projects.validateName('my.project').valid, false);
      assert.equal(projects.validateName('project!').valid, false);
    });

    it('rejects names over 64 characters', async () => {
      assert.equal(projects.validateName('a'.repeat(65)).valid, false);
    });

    it('accepts names exactly 64 characters', async () => {
      assert.ok(projects.validateName('a'.repeat(64)).valid);
    });
  });

  describe('password hashing', () => {
    it('hashPassword produces salt:hash format', async () => {
      const hashed = projects.hashPassword('test123');
      assert.ok(hashed.includes(':'));
      const [salt, hash] = hashed.split(':');
      assert.equal(salt.length, 32); // 16 bytes hex
      assert.equal(hash.length, 128); // 64 bytes hex
    });

    it('verifyPassword returns true for matching password', async () => {
      const hashed = projects.hashPassword('mysecret');
      assert.ok(projects.verifyPassword('mysecret', hashed));
    });

    it('verifyPassword returns false for wrong password', async () => {
      const hashed = projects.hashPassword('mysecret');
      assert.equal(projects.verifyPassword('wrong', hashed), false);
    });

    it('verifyPassword returns false for null inputs', async () => {
      assert.equal(projects.verifyPassword(null, null), false);
      assert.equal(projects.verifyPassword('test', null), false);
      assert.equal(projects.verifyPassword(null, 'hash'), false);
    });

    it('verifyPassword returns false for invalid hash format', async () => {
      assert.equal(projects.verifyPassword('test', 'nocolon'), false);
    });
  });

  describe('checkDeletePassword', () => {
    it('allows when no password configured', async () => {
      const config = store.config.load();
      config.deletePassword = null;
      store.config.save(config);

      const result = projects.checkDeletePassword(undefined);
      assert.ok(result.allowed);
    });

    it('requires password when configured', async () => {
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('secret');
      store.config.save(config);

      const result = projects.checkDeletePassword(undefined);
      assert.equal(result.allowed, false);
      assert.ok(result.error.includes('required'));
    });

    it('allows correct password', async () => {
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('correct');
      store.config.save(config);

      const result = projects.checkDeletePassword('correct');
      assert.ok(result.allowed);
    });

    it('rejects incorrect password', async () => {
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('correct');
      store.config.save(config);

      const result = projects.checkDeletePassword('wrong');
      assert.equal(result.allowed, false);
      assert.ok(result.error.includes('Incorrect'));
    });

    it('upgrades plaintext password to hash', async () => {
      const config = store.config.load();
      config.deletePassword = 'plaintext';
      store.config.save(config);

      const result = projects.checkDeletePassword('plaintext');
      assert.ok(result.allowed);

      // Verify it was upgraded
      const updatedConfig = store.config.load();
      assert.ok(updatedConfig.deletePassword.includes(':'));
    });
  });

  describe('createProject', () => {
    it('creates a project with directory and config', async () => {
      const result = projects.createProject({
        name: 'new-project'
      });

      assert.ok(result.project);
      assert.equal(result.project.name, 'new-project');
      assert.ok(fs.existsSync(path.join(projectsDir, 'new-project')));
      assert.ok(fs.existsSync(path.join(projectsDir, 'new-project', '.tangleclaw', 'project.json')));
    });

  
    it('does not seed wrap overrides for a prawduct project', async () => {
      const result = projects.createProject({
        name: 'no-seed-prawduct'
      });
      assert.ok(result.project);
      const cfg = JSON.parse(fs.readFileSync(
        path.join(projectsDir, 'no-seed-prawduct', '.tangleclaw', 'project.json'), 'utf8'));
      assert.equal(cfg.wrapOverridesSeeded, undefined);
      assert.deepEqual(cfg.wrapStepOverrides, {});
    });

    it('creates session memory directory and seed file', async () => {
      const result = projects.createProject({
        name: 'memory-project'
      });
      assert.ok(result.project);
      const memoriesDir = path.join(projectsDir, 'memory-project', '.tangleclaw', 'memories');
      assert.ok(fs.existsSync(memoriesDir), 'memories directory should exist');
      const memoryFile = path.join(memoriesDir, 'MEMORY.md');
      assert.ok(fs.existsSync(memoryFile), 'MEMORY.md should exist');
      const content = fs.readFileSync(memoryFile, 'utf8');
      assert.ok(content.includes('Session Memory'));
    });

    it('rejects invalid names', async () => {
      const result = projects.createProject({ name: 'bad name!' });
      assert.equal(result.project, null);
      assert.ok(result.errors.length > 0);
    });

    it('rejects duplicate projects', async () => {
      projects.createProject({ name: 'dupe-proj' });
      const result = projects.createProject({ name: 'dupe-proj' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('already exists'));
    });

    it('rejects when directory exists', async () => {
      fs.mkdirSync(path.join(projectsDir, 'existing-dir'), { recursive: true });
      const result = projects.createProject({ name: 'existing-dir' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('already exists'));
    });

    it('rejects unknown engine', async () => {
      const result = projects.createProject({ name: 'bad-engine', engine: 'nonexistent' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

  
    it('applies methodology default rules', async () => {
      const result = projects.createProject({
        name: 'rules-project'
      });

      assert.ok(result.project);
      const projConfig = projectConfigModule.load(result.project.path);
      // Core rules should always be true
      assert.equal(projConfig.rules.core.changelogPerChange, true);
      assert.equal(projConfig.rules.core.jsdocAllFunctions, true);
    });

    it('passes tags to project', async () => {
      const result = projects.createProject({
        name: 'tagged-project',
        tags: ['node', 'active']
      });

      assert.ok(result.project);
      assert.deepEqual(result.project.tags, ['node', 'active']);
    });

    it('skips git init when gitInit is false', async () => {
      const result = projects.createProject({
        name: 'no-git',
        gitInit: false
      });

      assert.ok(result.project);
      assert.ok(!fs.existsSync(path.join(projectsDir, 'no-git', '.git')));
    });

    describe('case-insensitive duplicate rejection (#221, sibling to #188)', () => {
      it('rejects creating "Foo-Case" when "foo-case" already exists (lowercase first)', async () => {
        const first = projects.createProject({ name: 'foo-case' });
        assert.ok(first.project, 'lowercase precondition project created');

        const dup = projects.createProject({ name: 'Foo-Case' });
        assert.equal(dup.project, null, 'mixed-case dup must be rejected');
        assert.equal(dup.errors.length, 1);
        // Error message reflects the existing project's actual casing so
        // the operator can find it in the projects list.
        assert.match(dup.errors[0], /foo-case/);
        assert.match(dup.errors[0], /case-insensitive/i,
          'error must call out the case-collision so the operator understands the rejection reason');
      });

      it('rejects creating "case-second" when "Case-Second" already exists (mixed-case first)', async () => {
        const first = projects.createProject({ name: 'Case-Second' });
        assert.ok(first.project);

        const dup = projects.createProject({ name: 'case-second' });
        assert.equal(dup.project, null);
        assert.match(dup.errors[0], /Case-Second/, 'error names the existing project');
      });

      it('preserves the original-casing error format when names match exactly (back-compat)', async () => {
        const first = projects.createProject({ name: 'exact-match' });
        assert.ok(first.project);

        const dup = projects.createProject({ name: 'exact-match' });
        assert.equal(dup.project, null);
        // When the case matches exactly, the legacy error format is preserved
        // — no spurious "case-insensitive match" suffix that would suggest
        // a casing difference where none exists.
        assert.equal(dup.errors[0], 'Project "exact-match" already exists');
      });

      it('attachProject also rejects case-collision (#221 symmetric gate audit)', async () => {
        // Create a project, then create a sibling directory with case-only
        // difference, then try to attach that directory. The attach path
        // must reject for the same reason createProject does — otherwise
        // attach is the case-collision back door.
        projects.createProject({ name: 'attach-case' });
        const otherDir = path.join(projectsDir, 'Attach-Case');
        // Skip the test if the OS already collapsed the directory name
        // (case-insensitive filesystem) — the attach path would hit the
        // generic "already exists" fs error before reaching the case-collision
        // guard. The guard still gets exercised on case-sensitive filesystems
        // and via the store-level test below.
        try { fs.mkdirSync(otherDir); } catch { return; }
        try {
          const result = await projects.attachProject('Attach-Case');
          assert.equal(result.project, null, 'attach must reject case-collision');
          assert.match(result.errors[0], /already registered/);
          assert.match(result.errors[0], /case-insensitive|attach-case/i,
            'error must cite the existing project or call out the case-collision');
        } finally {
          fs.rmSync(otherDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe('getProject / listProjects', () => {
    it('getProject returns enriched project', async () => {
      const project = await projects.getProject('new-project');
      assert.ok(project);
      assert.equal(project.name, 'new-project');
      assert.ok(project.hasOwnProperty('engine'));
      assert.ok(project.hasOwnProperty('actions'));
      assert.ok(project.hasOwnProperty('session'));
      assert.ok(project.hasOwnProperty('git'));
      assert.ok(project.hasOwnProperty('governanceState'));
    });

    it('getProject returns null for unknown', async () => {
      assert.equal(await projects.getProject('nonexistent'), null);
    });

    it('listProjects returns array of enriched projects', async () => {
      const list = await projects.listProjects();
      assert.ok(Array.isArray(list));
      assert.ok(list.length > 0);
      assert.ok(list[0].hasOwnProperty('engine'));
    });

    it('listProjects filters by tag', async () => {
      const list = await projects.listProjects({ tag: 'node' });
      for (const p of list) {
        assert.ok(p.tags.includes('node'));
      }
    });
  });

  // Session liveness used to cost one `tmux has-session` per project, run with
  // `execSync` on the event loop with a 5s cap EACH, on the route the dashboard
  // polls every ten seconds — so a fleet's worst case scaled with its size for an
  // answer identical for every project asking (#890). These pin the count, which
  // is the claim; wall-clock would pass with the defect intact, because a healthy
  // `tmux has-session` costs a few milliseconds and the defect is that it happens
  // N times.
  describe('session liveness costs one tmux invocation per list (#890)', () => {
    const tmuxModule = require('../lib/tmux');
    const dirScanner = require('../lib/dir-scanner');

    /**
     * Run `fn` with tmux's snapshot factory counted and its exec stubbed, and
     * with the scanner answering healthily so no real child is forked.
     *
     * The REAL factory is wrapped rather than replaced, so laziness and
     * single-flight are exercised as shipped — a hand-written stand-in would
     * assert the test author's model of the snapshot instead of the snapshot.
     *
     * @param {string} stdout - What `tmux list-sessions` replies with.
     * @param {Function} fn - Test body, called with the counters.
     * @returns {Promise<any>}
     */
    async function withCountedTmux(stdout, fn) {
      const realFactory = tmuxModule.createSessionNameSnapshot;
      const realReq = dirScanner.request;
      const realInteractive = dirScanner.interactiveRequest;
      const counts = { snapshots: 0, invocations: 0 };
      tmuxModule.createSessionNameSnapshot = (options = {}) => {
        counts.snapshots++;
        return realFactory({
          ...options,
          execFn: (_file, _args, _opts, cb) => {
            counts.invocations++;
            setImmediate(() => cb(null, stdout));
          }
        });
      };
      const healthy = () => Promise.resolve({ exists: true, governanceState: 'ungoverned' });
      dirScanner.request = healthy;
      dirScanner.interactiveRequest = healthy;
      try {
        return await fn(counts);
      } finally {
        tmuxModule.createSessionNameSnapshot = realFactory;
        dirScanner.request = realReq;
        dirScanner.interactiveRequest = realInteractive;
      }
    }

    /**
     * Register a project with a live session, and return both.
     * @param {string} name - Project name.
     * @returns {{ project: object, session: object }}
     */
    function projectWithSession(name) {
      projects.createProject({ name });
      const project = store.projects.getByName(name);
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: `tc-${name}`,
        primePrompt: ''
      });
      return { project, session };
    }

    it('asks tmux ONCE for a fleet where every project has a session', async () => {
      const made = ['spawn-count-a', 'spawn-count-b', 'spawn-count-c'].map(projectWithSession);
      // Three, not two: the count has to distinguish "one for the list" from
      // "one per project", and with two projects a stray off-by-one reads the same.
      const stdout = `${made.map((m) => m.session.tmuxSession).join('\n')}\n`;
      try {
        const { counts, list } = await withCountedTmux(stdout, async (counts) => {
          const list = await projects.listProjects();
          return { counts, list };
        });

        // THE MUTATION THIS CATCHES: reverting to `tmux.hasSession` per project,
        // or building the snapshot inside `enrichProject` rather than once in
        // `listProjects`. Both still answer correctly — and both restore the
        // per-project multiplication this exists to remove.
        assert.equal(counts.invocations, 1,
          'one tmux invocation must answer the whole list');
        assert.equal(counts.snapshots, 1,
          'and one snapshot must be built for the list, not one per project');

        for (const { project } of made) {
          const enriched = list.find((p) => p.id === project.id);
          assert.ok(enriched.session && enriched.session.active === true,
            `${project.name} must still be reported as having a live session`);
        }
      } finally {
        for (const { session } of made) store.sessions.kill(session.id, 'test cleanup');
      }
    });

    it('asks tmux NOTHING for a project with no session at all', async () => {
      projects.createProject({ name: 'spawn-count-idle' });
      const project = store.projects.getByName('spawn-count-idle');
      // THE MUTATION THIS CATCHES: resolving the snapshot eagerly, in
      // `listProjects` or at the top of `enrichProject`. A fleet with nothing
      // running would then pay a tmux invocation per poll to learn nothing —
      // strictly worse than the per-project calls being replaced.
      const counts = await withCountedTmux('', async (counts) => {
        const enriched = await projects.enrichProject(store.projects.get(project.id));
        assert.equal(enriched.session, null);
        return counts;
      });

      assert.equal(counts.invocations, 0,
        'nothing may be spawned to answer a question nobody asked');
    });

    it('enrichProject with no caller-supplied snapshot answers from its own', async () => {
      // The `facts` precedent: an omitted argument makes this function do the
      // work itself, so a call site that forgets is slower and never wrong. Eight
      // single-project call sites rely on it.
      const { project, session } = projectWithSession('spawn-count-solo');
      try {
        const { counts, enriched } = await withCountedTmux(`${session.tmuxSession}\n`,
          async (counts) => ({
            counts,
            enriched: await projects.enrichProject(store.projects.get(project.id))
          }));

        assert.ok(enriched.session && enriched.session.active === true);
        assert.equal(counts.invocations, 1, 'exactly one, the same as the call it replaced');
      } finally {
        store.sessions.kill(session.id, 'test cleanup');
      }
    });

    it('resolves engine availability without taking the blocking path', async () => {
      // The synchronous `detectEngine` is booby-trapped: if enrichment still
      // reaches it, the enrich fails loudly instead of passing while quietly
      // blocking the event loop once per project per poll.
      //
      // THE MUTATION THIS CATCHES: reverting the call site to
      // `engines.detectEngine(engineProfile)`. Correct output, identical
      // payload, and the defect back — which is exactly why the guard has to be
      // "which path did it take", not "was the answer right".
      projects.createProject({ name: 'spawn-count-engine' });
      const row = store.projects.getByName('spawn-count-engine');
      const realSync = engines.detectEngine;
      engines.detectEngine = () => {
        throw new Error('enrichProject must not probe engines synchronously');
      };
      try {
        const enriched = await withCountedTmux('',
          () => projects.enrichProject(row));
        assert.ok(enriched.engine, 'the engine block must still be populated');
        assert.equal(typeof enriched.engine.available, 'boolean');
      } finally {
        engines.detectEngine = realSync;
      }
    });

    it('matches the session name exactly — a longer live name is not a match', async () => {
      const { project, session } = projectWithSession('spawn-count-exact');
      try {
        // tmux reports a DIFFERENT, longer session. `hasSession` promised exact
        // matching and its callers depend on it; the snapshot must not soften it.
        //
        // THE MUTATION THIS CATCHES: answering with a `startsWith`/`includes`
        // scan over the names instead of `Set.has`, which would report this
        // project's dead session as live and hide a session that had crashed.
        const enriched = await withCountedTmux(`${session.tmuxSession}-extra\n`,
          () => projects.enrichProject(store.projects.get(project.id)));

        assert.equal(enriched.session, null,
          'a session that is not in the live set is not live, near-miss or not');
      } finally {
        store.sessions.kill(session.id, 'test cleanup');
      }
    });
  });

  // A tmux server that will not answer establishes NOTHING. Reporting its
  // silence as "no session" is the defect: every running session disappears
  // from the fleet view and the operator is told nothing is up on a machine
  // where everything is (#900).
  describe('a liveness read that could not be established is unknown, not absent (#900)', () => {
    const tmuxModule = require('../lib/tmux');
    const dirScanner = require('../lib/dir-scanner');

    /**
     * Run `fn` with tmux answering `stdout` from a stub, and the scanner healthy.
     *
     * The counting sibling of this lives with the #890 guards; this one only
     * needs the healthy answer, to show an unknown clearing once tmux replies.
     *
     * @param {string} stdout - What `tmux list-sessions` replies with.
     * @param {Function} fn - Test body.
     * @returns {Promise<any>}
     */
    async function withAnsweringTmux(stdout, fn) {
      const realFactory = tmuxModule.createSessionNameSnapshot;
      const realReq = dirScanner.request;
      const realInteractive = dirScanner.interactiveRequest;
      tmuxModule.createSessionNameSnapshot = (options = {}) => realFactory({
        ...options,
        execFn: (_file, _args, _opts, cb) => setImmediate(() => cb(null, stdout))
      });
      const healthy = () => Promise.resolve({ exists: true, governanceState: 'ungoverned' });
      dirScanner.request = healthy;
      dirScanner.interactiveRequest = healthy;
      try {
        return await fn();
      } finally {
        tmuxModule.createSessionNameSnapshot = realFactory;
        dirScanner.request = realReq;
        dirScanner.interactiveRequest = realInteractive;
      }
    }

    /**
     * Run `fn` against a REAL `tmux` on PATH that never answers, killed by the
     * snapshot's own timeout.
     *
     * Deliberately not a stubbed callback error. The behaviour under test begins
     * with recognising a killed process, and this repo has shipped three
     * hand-written models of that error shape that were all wrong (#891/#894) —
     * a stub would assert the model, not the mechanism. Only the timeout is
     * injected, by wrapping the real factory.
     *
     * @param {Function} fn - Test body.
     * @param {{onSpawn?: Function}} [opts] - `onSpawn` is called for each tmux
     *   invocation, so a caller can assert on the COUNT rather than on elapsed
     *   time. The real runner still does the work; the hook only observes.
     * @returns {Promise<any>}
     */
    async function withStalledTmux(fn, opts = {}) {
      const realFactory = tmuxModule.createSessionNameSnapshot;
      const realReq = dirScanner.request;
      const realInteractive = dirScanner.interactiveRequest;
      const realExecFile = require('node:child_process').execFile;
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stalled-tmux-'));
      fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
      const realPath = process.env.PATH;
      process.env.PATH = `${binDir}:${realPath}`;
      tmuxModule.createSessionNameSnapshot = (options = {}) => realFactory({
        ...options,
        timeout: 300,
        execFn: (...args) => {
          if (opts.onSpawn) opts.onSpawn();
          return realExecFile(...args);
        }
      });
      const healthy = () => Promise.resolve({ exists: true, governanceState: 'ungoverned' });
      dirScanner.request = healthy;
      dirScanner.interactiveRequest = healthy;
      try {
        return await fn();
      } finally {
        process.env.PATH = realPath;
        fs.rmSync(binDir, { recursive: true, force: true });
        tmuxModule.createSessionNameSnapshot = realFactory;
        dirScanner.request = realReq;
        dirScanner.interactiveRequest = realInteractive;
      }
    }

    it('reports an active session as unknown rather than dropping it', async () => {
      projects.createProject({ name: 'wedged-tmux-active' });
      const project = store.projects.getByName('wedged-tmux-active');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'tc-wedged-tmux-active',
        primePrompt: ''
      });
      try {
        // THE MUTATION THIS CATCHES: dropping the unanswered branch, so an
        // unreadable liveness falls through to `session: null` — which is what
        // shipped before #900, and is indistinguishable on the dashboard from a
        // session that really has died.
        const enriched = await withStalledTmux(
          () => projects.enrichProject(store.projects.get(project.id)));

        assert.ok(enriched.session, 'the session must not vanish because tmux went quiet');
        assert.equal(enriched.session.active, null,
          'null, not false: nothing was established, so there is no negative to report');
        assert.deepEqual(enriched.session.incomplete, ['active']);
        assert.equal(enriched.session.cause, 'read-timed-out');
        assert.equal(enriched.session.tmuxSession, 'tc-wedged-tmux-active');
      } finally {
        store.sessions.kill(session.id, 'test cleanup');
      }
    });

    it('reports a wrapping session as unknown too', async () => {
      projects.createProject({ name: 'wedged-tmux-wrapping' });
      const project = store.projects.getByName('wedged-tmux-wrapping');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'tc-wedged-tmux-wrapping',
        primePrompt: ''
      });
      store.sessions.setWrapping(session.id);
      try {
        // The wrapping branch is asymmetric with the active one — a wrapping
        // session with no tmux handle is NOT live — so it can lose the unknown
        // state independently. This is the second half of the same guard.
        const enriched = await withStalledTmux(
          () => projects.enrichProject(store.projects.get(project.id)));

        assert.ok(enriched.session, 'a wrapping session must not vanish either');
        assert.equal(enriched.session.active, null);
        assert.equal(enriched.session.status, 'wrapping');
        assert.equal(enriched.session.cause, 'read-timed-out');
      } finally {
        store.sessions.kill(session.id, 'test cleanup');
      }
    });

    it('still drops a wrapping session tmux positively said is gone', async () => {
      // The wrapping branch's honest negative, which nothing else pins: widening
      // its unknown test from `!verdict.answered` to `verdict` passes the whole
      // suite otherwise, and a wrapping session tmux confirmed is dead would
      // then publish `active: null` — an unknown invented out of a fact.
      projects.createProject({ name: 'answered-dead-wrapping' });
      const project = store.projects.getByName('answered-dead-wrapping');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'tc-answered-dead-wrapping',
        primePrompt: ''
      });
      store.sessions.setWrapping(session.id);
      try {
        // tmux answers, and names a different session: this pane is gone.
        const enriched = await withAnsweringTmux('some-other-session\n',
          () => projects.enrichProject(store.projects.get(project.id)));

        assert.equal(enriched.session, null,
          'tmux answered — that is a fact, and it must not be softened to unknown');
      } finally {
        store.sessions.kill(session.id, 'test cleanup');
      }
    });

    it('leaves a project with no session row alone, and asks the wedged tmux nothing', async () => {
      // The unknown state must not leak onto projects that never had a session:
      // a machine with a wedged tmux and one running project must show one
      // unknown, not a fleet of them. This also re-pins #890's laziness against
      // the branch rewrite — an eager `get()` would now cost a 300ms stall per
      // sessionless project, which is worse than the spawn it replaced.
      projects.createProject({ name: 'wedged-tmux-idle' });
      const row = store.projects.getByName('wedged-tmux-idle');
      // Counted, not timed. A wall-clock assertion against the 300ms stall is a
      // race with the machine: it goes red for an eager read AND for a busy CI
      // box, and the second reads as the first. The claim is "nothing was
      // spawned", so count spawns.
      let spawns = 0;
      const enriched = await withStalledTmux(() => projects.enrichProject(row), {
        onSpawn: () => { spawns++; }
      });

      assert.equal(enriched.session, null);
      assert.equal(spawns, 0,
        'nothing may be spawned — let alone waited on — for a question nobody asked');
    });

    it('still reports a live session as live once tmux answers again', async () => {
      // The recovery half. An unknown that sticks after the server comes back is
      // the same lie in the other direction, and nothing else in this file
      // exercises the transition.
      const { project, session } = (() => {
        projects.createProject({ name: 'wedged-tmux-recovers' });
        const p = store.projects.getByName('wedged-tmux-recovers');
        return {
          project: p,
          session: store.sessions.start({
            projectId: p.id,
            engineId: 'claude',
            tmuxSession: 'tc-wedged-tmux-recovers',
            primePrompt: ''
          })
        };
      })();
      try {
        const stalled = await withStalledTmux(
          () => projects.enrichProject(store.projects.get(project.id)));
        assert.equal(stalled.session.active, null);

        const recovered = await withAnsweringTmux(`${session.tmuxSession}\n`,
          () => projects.enrichProject(store.projects.get(project.id)));
        assert.equal(recovered.session.active, true);
        assert.deepEqual(recovered.session.incomplete, [],
          'the healthy payload carries the fields too, empty — a field that appears '
          + 'only on failure makes every consumer probe for it');
        assert.equal(recovered.session.cause, null);
      } finally {
        store.sessions.kill(session.id, 'test cleanup');
      }
    });
  });

  describe('enrichProject — governanceState (#353)', () => {
    let govDir;

    before(() => {
      govDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-proj-gov-'));
    });

    after(() => {
      fs.rmSync(govDir, { recursive: true, force: true });
    });

    function makeProject(name, { engine = 'claude', methodology = 'prawduct', settings, vendored } = {}) {
      const projPath = path.join(govDir, name);
      fs.mkdirSync(projPath, { recursive: true });
      if (settings) {
        fs.mkdirSync(path.join(projPath, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(projPath, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
      }
      if (vendored) {
        fs.mkdirSync(path.join(projPath, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(projPath, 'tools', 'product-hook'), '#!/usr/bin/env python3\n');
      }
      store.projects.create({ name, path: projPath, engine, methodology });
      return projPath;
    }

    it('surfaces ungoverned for a Claude project with no governance installed', async () => {
      makeProject('gov-drift');
      assert.equal((await projects.getProject('gov-drift')).governanceState, 'ungoverned');
    });

    it('surfaces governed-plugin once the V2 plugin ref is present', async () => {
      makeProject('gov-plugin', { settings: { enabledPlugins: { 'prawduct@prawduct': true } } });
      assert.equal((await projects.getProject('gov-plugin')).governanceState, 'governed-plugin');
    });

    it('surfaces not-applicable for a non-Claude project', async () => {
      makeProject('gov-na', { engine: 'gemini' });
      assert.equal((await projects.getProject('gov-na')).governanceState, 'not-applicable');
    });

    it('every listProjects entry carries a governanceState field', async () => {
      const list = await projects.listProjects();
      assert.ok(list.length > 0);
      for (const p of list) {
        assert.ok(p.hasOwnProperty('governanceState'),
          `project ${p.name} missing governanceState`);
      }
    });
  });

  describe('syncAllProjects', () => {
    it('regenerates engine config for registered project', async () => {
      // new-project was created earlier in the test suite
      const projPath = path.join(projectsDir, 'new-project');
      const claudeMd = path.join(projPath, 'CLAUDE.md');

      // Delete existing config to confirm it gets regenerated
      if (fs.existsSync(claudeMd)) fs.unlinkSync(claudeMd);
      assert.ok(!fs.existsSync(claudeMd));

      const result = projects.syncAllProjects();
      assert.ok(result.synced > 0);
      assert.ok(fs.existsSync(claudeMd), 'CLAUDE.md should be regenerated');
      const content = fs.readFileSync(claudeMd, 'utf8');
      assert.ok(content.includes('Session Memory'), 'Should include session memory guide');
    });

    it('creates memories directory for project missing it', async () => {
      const projPath = path.join(projectsDir, 'new-project');
      const memoriesDir = path.join(projPath, '.tangleclaw', 'memories');
      const memoryFile = path.join(memoriesDir, 'MEMORY.md');

      // Remove memories dir if it exists
      if (fs.existsSync(memoriesDir)) fs.rmSync(memoriesDir, { recursive: true, force: true });
      assert.ok(!fs.existsSync(memoriesDir));

      const result = projects.syncAllProjects();
      assert.ok(result.synced > 0);
      assert.ok(fs.existsSync(memoriesDir), 'memories directory should be created');
      assert.ok(fs.existsSync(memoryFile), 'MEMORY.md should be seeded');
    });

    it('skips projects with missing paths without crashing', async () => {
      // Create a project pointing to a non-existent path
      store.projects.create({ name: 'ghost-project', path: '/tmp/nonexistent-tc-path-12345', engine: 'claude' });
      const result = projects.syncAllProjects();
      assert.ok(Array.isArray(result.errors));
      // Should not throw, ghost project is silently skipped
      assert.ok(result.synced >= 0);
    });

    it('regenerates from the DB engine, not projConfig, when project.json lacks an engine key', async () => {
      // Live-fleet bug found during the tilt retirement: codextest's DB said
      // `codex`, but its project.json had no `engine` key — boot-sync fell
      // back to claude (`project.engine` was also a dead field; store rows
      // expose `engineId`), regenerated a CLAUDE.md, and left the operative
      // .codex.yaml stale for weeks. DB is the single source of truth for the
      // engine, matching the methodology rule (#320) and the session-launch
      // path.
      const { project: proj } = projects.createProject({ name: 'db-engine-wins', engine: 'codex' });
      assert.equal(proj.engineId, 'codex');

      const projPath = path.join(projectsDir, 'db-engine-wins');
      const projConfig = projectConfigModule.load(projPath);
      delete projConfig.engine; // legacy project.json with no engine key
      store.projectConfig.save(projPath, projConfig);

      const codexYaml = path.join(projPath, '.codex.yaml');
      const claudeMd = path.join(projPath, 'CLAUDE.md');
      if (fs.existsSync(codexYaml)) fs.unlinkSync(codexYaml);
      if (fs.existsSync(claudeMd)) fs.unlinkSync(claudeMd);

      const result = projects.syncAllProjects();
      assert.ok(result.synced > 0);

      assert.ok(fs.existsSync(codexYaml),
        '.codex.yaml must be regenerated from the DB engine (codex)');
      assert.ok(!fs.existsSync(claudeMd),
        'no CLAUDE.md may be written for a codex project missing projConfig.engine');
    });

    it('defers to the Prawduct V2 plugin at boot: preserves the anchor AND strips the governance hook (#330)', async () => {
      // A project later onboarded to the V2 plugin: it carries the install
      // reference plus a leftover TC governance `.hooks` block and a plugin-owned
      // thin CLAUDE.md anchor. Boot-sync must NOT regenerate CLAUDE.md and MUST
      // strip the stale governance hooks (the gap the Critic flagged — boot-sync
      // previously called writeEngineConfig but not syncEngineHooks). silentPrime
      // is pinned off so this stays focused on governance-hook removal; the
      // L1-prime-preserved-on-a-governed-project case is covered in engines.test.js.
      projects.createProject({ name: 'plugin-governed-boot' });
      const projPath = path.join(projectsDir, 'plugin-governed-boot');
      fs.writeFileSync(path.join(projPath, '.tangleclaw', 'project.json'), JSON.stringify({
        engine: 'claude', methodology: 'prawduct', silentPrime: false
      }, null, 2) + '\n');
      const claudeDir = path.join(projPath, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        enabledPlugins: { 'prawduct@prawduct': true },
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }] }] }
      }, null, 2) + '\n');
      const claudeMd = path.join(projPath, 'CLAUDE.md');
      const anchor = '# CLAUDE.md\n\n<!-- PRAWDUCT:ANCHOR -->\nGoverned by the Prawduct V2 plugin.\n';
      fs.writeFileSync(claudeMd, anchor);

      const result = projects.syncAllProjects();
      assert.ok(result.synced > 0);

      assert.equal(fs.readFileSync(claudeMd, 'utf8'), anchor, 'plugin-owned CLAUDE.md must not be regenerated at boot');
      const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
      assert.equal(settings.hooks, undefined, 'stale governance hooks block must be stripped at boot (silentPrime off → no L1 to keep)');
      assert.equal(settings.enabledPlugins['prawduct@prawduct'], true, 'plugin install reference must be preserved');
    });
  });

  describe('updateProject', () => {
    it('updates tags', async () => {
      const result = await projects.updateProject('new-project', { tags: ['updated'] });
      assert.ok(result.project);
      assert.deepEqual(result.project.tags, ['updated']);
    });

    it('rejects core rule disabling', async () => {
      const result = await projects.updateProject('new-project', {
        rules: { core: { changelogPerChange: false } }
      });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('Core rules'));
    });

    it('updates extension rules', async () => {
      const result = await projects.updateProject('new-project', {
        rules: { extensions: { identitySentry: true } }
      });
      assert.ok(result.project);
      const projConfig = projectConfigModule.load(result.project.path);
      assert.equal(projConfig.rules.extensions.identitySentry, true);
    });

    it('returns error for unknown project', async () => {
      const result = await projects.updateProject('nonexistent', { tags: [] });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('updates quick commands', async () => {
      const cmds = [{ label: 'test', command: 'echo test' }];
      const result = await projects.updateProject('new-project', { quickCommands: cmds });
      assert.ok(result.project);
      const projConfig = projectConfigModule.load(result.project.path);
      assert.deepEqual(projConfig.quickCommands, cmds);
    });

    // CC-6 (#381): per-project wrap-section selection.
    it('persists a valid wrapSections selection + enriches it', async () => {
      const result = await projects.updateProject('new-project', { wrapSections: ['Where we are', 'Next action', 'Freshness'] });
      assert.ok(result.project);
      assert.deepEqual(result.project.wrapSections, ['Where we are', 'Next action', 'Freshness']);
      const projConfig = projectConfigModule.load(result.project.path);
      assert.deepEqual(projConfig.wrapSections, ['Where we are', 'Next action', 'Freshness']);
    });

    it('clears the wrapSections override when set to null (deep default)', async () => {
      await projects.updateProject('new-project', { wrapSections: ['Freshness'] });
      const result = await projects.updateProject('new-project', { wrapSections: null });
      assert.ok(result.project);
      assert.equal(result.project.wrapSections, null);
      const projConfig = projectConfigModule.load(result.project.path);
      assert.equal(projConfig.wrapSections, null);
    });

    it('rejects wrapSections that is not an array or contains unknown names', async () => {
      const notArray = await projects.updateProject('new-project', { wrapSections: 'Freshness' });
      assert.equal(notArray.project, null);
      assert.ok(notArray.errors[0].includes('wrapSections'));

      const bogus = await projects.updateProject('new-project', { wrapSections: ['Where we are', 'Bogus'] });
      assert.equal(bogus.project, null);
      assert.ok(bogus.errors[0].includes('wrapSections'));
    });

    // MED-2K9P Chunk 02: per-project Medusa session-comms auto-enable.
    it('defaults medusaEnabled to false on enrich', async () => {
      const result = await projects.updateProject('new-project', { tags: ['x'] });
      assert.ok(result.project);
      assert.equal(result.project.medusaEnabled, false);
    });

    it('persists medusaEnabled and round-trips it through enrich', async () => {
      const on = await projects.updateProject('new-project', { medusaEnabled: true });
      assert.ok(on.project);
      assert.equal(on.project.medusaEnabled, true);
      assert.equal(projectConfigModule.load(on.project.path).medusaEnabled, true);

      const off = await projects.updateProject('new-project', { medusaEnabled: false });
      assert.equal(off.project.medusaEnabled, false);
      assert.equal(projectConfigModule.load(off.project.path).medusaEnabled, false);
    });

    it('rejects a non-boolean medusaEnabled without mutating state', async () => {
      await projects.updateProject('new-project', { medusaEnabled: true });
      const bad = await projects.updateProject('new-project', { medusaEnabled: 'yes' });
      assert.equal(bad.project, null);
      assert.ok(bad.errors[0].includes('medusaEnabled'));
      // Prior true value is untouched by the rejected update.
      assert.equal(projectConfigModule.load(store.projects.getByName('new-project').path).medusaEnabled, true);
    });

    // MED-2K9P v2 T2: per-project idle-gated wake opt-in (same shape as medusaEnabled).
    it('defaults medusaWake to false on enrich', async () => {
      const result = await projects.updateProject('new-project', { tags: ['x'] });
      assert.ok(result.project);
      assert.equal(result.project.medusaWake, false);
    });

    it('persists medusaWake and round-trips it through enrich', async () => {
      const on = await projects.updateProject('new-project', { medusaWake: true });
      assert.ok(on.project);
      assert.equal(on.project.medusaWake, true);
      assert.equal(projectConfigModule.load(on.project.path).medusaWake, true);

      const off = await projects.updateProject('new-project', { medusaWake: false });
      assert.equal(off.project.medusaWake, false);
      assert.equal(projectConfigModule.load(off.project.path).medusaWake, false);
    });

    it('rejects a non-boolean medusaWake without mutating state', async () => {
      await projects.updateProject('new-project', { medusaWake: true });
      const bad = await projects.updateProject('new-project', { medusaWake: 'yes' });
      assert.equal(bad.project, null);
      assert.ok(bad.errors[0].includes('medusaWake'));
      // Prior true value is untouched by the rejected update.
      assert.equal(projectConfigModule.load(store.projects.getByName('new-project').path).medusaWake, true);
    });

    // #428: per-project active-plan pick (the drawer plan-picker → activePlan).
    describe('activePlan (#428)', () => {
      let planDir;
      before(() => {
        planDir = path.join(projectsDir, 'new-project', '.claude', 'plans');
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(path.join(planDir, 'chosen.md'), '### Chunk 1: A\n');
      });

      it('persists a valid activePlan filename to project.json', async () => {
        const result = await projects.updateProject('new-project', { activePlan: 'chosen.md' });
        assert.ok(result.project);
        const cfg = projectConfigModule.load(result.project.path);
        assert.equal(cfg.activePlan, 'chosen.md');
      });

      it('round-trips: priming-roll._readActivePlan reads back the persisted pick', async () => {
        const primingRoll = require('../lib/wrap-steps/priming-roll');
        await projects.updateProject('new-project', { activePlan: 'chosen.md' });
        const projPath = path.join(projectsDir, 'new-project');
        assert.equal(primingRoll._readActivePlan(projPath), 'chosen.md');
      });

      it('clears activePlan when set to null', async () => {
        await projects.updateProject('new-project', { activePlan: 'chosen.md' });
        const result = await projects.updateProject('new-project', { activePlan: null });
        assert.ok(result.project);
        const cfg = projectConfigModule.load(result.project.path);
        assert.equal(cfg.activePlan, undefined, 'null must delete the key, not store null');
      });

      // #612: the validator must check the SAME directory the wrap step
      // resolves. Pinned to the legacy path it made the operator escape hatch
      // unsettable for any project following the current layout — the drawer
      // would offer plan candidates whose save was guaranteed to fail.
      it('accepts a plan in the TangleClaw-owned plans directory', async () => {
        const tcPlans = path.join(projectsDir, 'new-project', '.tangleclaw', 'plans');
        fs.mkdirSync(tcPlans, { recursive: true });
        fs.writeFileSync(path.join(tcPlans, 'current.md'), '### Chunk 1: A\n');
        try {
          const result = await projects.updateProject('new-project', { activePlan: 'current.md' });
          assert.ok(result.project, `expected accept, got: ${JSON.stringify(result.errors)}`);
          const cfg = projectConfigModule.load(result.project.path);
          assert.equal(cfg.activePlan, 'current.md');
          await projects.updateProject('new-project', { activePlan: null });
        } finally {
          fs.rmSync(tcPlans, { recursive: true, force: true });
        }
      });

      it('rejects a filename that does not exist under the resolved plans directory', async () => {
        const result = await projects.updateProject('new-project', { activePlan: 'ghost.md' });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /activePlan .* not found/);
      });

      it('rejects a non-.md filename even if the file exists', async () => {
        fs.writeFileSync(path.join(planDir, 'notes.txt'), 'x');
        const result = await projects.updateProject('new-project', { activePlan: 'notes.txt' });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /not found/);
      });

      it('rejects a path-bearing activePlan (traversal-safe)', async () => {
        const result = await projects.updateProject('new-project', { activePlan: '../../etc/passwd' });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /bare plan filename/);
      });

      it('rejects a non-string activePlan', async () => {
        const result = await projects.updateProject('new-project', { activePlan: 42 });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /activePlan must be a string/);
      });
    });

    describe('rename — case-insensitive collision handling (#221, sibling to #188)', async () => {
      it('allows a case-only self-rename at the DB-validator level (foo-1 → Foo-1)', async (t) => {
        // Set up a discrete project so other tests' state doesn't interfere.
        projects.createProject({ name: 'self-rename-src' });

        // Case-only directory rename only works on case-sensitive filesystems.
        // On macOS APFS-CI (the common dev environment) `fs.existsSync` collapses
        // case, so the rename block's "directory already exists" guard at
        // `lib/projects.js:1294` blocks the rename. This is a separate FS-layer
        // concern from the DB-level validator gate we're testing here. Probe
        // case-sensitivity by checking whether the project's own directory
        // can be observed under its uppercased name.
        const srcProject = store.projects.getByName('self-rename-src');
        const upperPath = srcProject.path.replace(/self-rename-src$/, 'Self-Rename-Src');
        if (fs.existsSync(upperPath)) {
          t.skip('case-insensitive filesystem — DB-level self-rename gate is exercised in the cross-rename tests below');
          return;
        }

        const result = await projects.updateProject('self-rename-src', { name: 'Self-Rename-Src' });
        assert.ok(result.project, 'case-only self-rename must be allowed by the validator');
        assert.equal(result.errors.length, 0);
        assert.equal(result.project.name, 'Self-Rename-Src',
          'the new name takes effect; existing project keeps its id (same row, new casing)');
      });

      it('rejects renaming to a name that case-collides with a DIFFERENT existing project', async () => {
        projects.createProject({ name: 'collision-dest' });
        projects.createProject({ name: 'rename-src' });

        const result = await projects.updateProject('rename-src', { name: 'Collision-Dest' });
        assert.equal(result.project, null, 'cross-rename to a case-collision must be rejected');
        assert.ok(result.errors.length > 0);
        assert.match(result.errors[0], /collision-dest/, 'error cites the OTHER project');
        assert.match(result.errors[0], /case-insensitive/i,
          'error message calls out the case-collision so the operator understands the rejection');
      });

      it('preserves exact-case error format when rename target matches an existing name exactly', async () => {
        projects.createProject({ name: 'exact-rename-target' });
        projects.createProject({ name: 'rename-source-2' });

        const result = await projects.updateProject('rename-source-2', { name: 'exact-rename-target' });
        assert.equal(result.project, null);
        assert.equal(result.errors[0], 'Project "exact-rename-target" already exists',
          'exact-case collision keeps the legacy error format — no spurious case-insensitive suffix');
      });
    });
  });

  describe('deleteProject', () => {
    it('deletes project (archive only)', async () => {
      projects.createProject({ name: 'to-delete', methodology: 'minimal', gitInit: false });
      const result = projects.deleteProject('to-delete');
      assert.ok(result.success);
      assert.equal(result.filesDeleted, false);
      assert.equal(store.projects.getByName('to-delete'), null);
      // Directory should still exist
      assert.ok(fs.existsSync(path.join(projectsDir, 'to-delete')));
    });

    it('deletes project with files', async () => {
      projects.createProject({ name: 'to-delete-files', methodology: 'minimal', gitInit: false });
      const result = projects.deleteProject('to-delete-files', { deleteFiles: true });
      assert.ok(result.success);
      assert.equal(result.filesDeleted, true);
      assert.ok(!fs.existsSync(path.join(projectsDir, 'to-delete-files')));
    });

    it('returns error for unknown project', async () => {
      const result = projects.deleteProject('nonexistent');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('cascade-deletes the consolidated continuity store with files (CC-4)', async () => {
      projects.createProject({ name: 'store-cascade', methodology: 'minimal', gitInit: false });
      const store_ = path.join(projectsDir, 'store-cascade', '.tangleclaw', 'continuity', 'sessions', '1', 'uploads');
      fs.mkdirSync(store_, { recursive: true });
      fs.writeFileSync(path.join(store_, 'shot.png'), 'x');

      projects.deleteProject('store-cascade', { deleteFiles: true });
      // The store lives under project.path, so removing the project dir wipes it.
      assert.ok(!fs.existsSync(path.join(projectsDir, 'store-cascade', '.tangleclaw')));
    });

    it('preserves the continuity store when files are kept (CC-4)', async () => {
      projects.createProject({ name: 'store-keep', methodology: 'minimal', gitInit: false });
      const store_ = path.join(projectsDir, 'store-keep', '.tangleclaw', 'continuity');
      fs.mkdirSync(store_, { recursive: true });
      fs.writeFileSync(path.join(store_, 'index.md'), '# keep');

      projects.deleteProject('store-keep'); // deleteFiles defaults false
      // Deliberate: keeping the files keeps the gitignored local store too.
      assert.ok(fs.existsSync(path.join(store_, 'index.md')));
    });
  });

  describe('detectExistingProjects', () => {
    it('detects projects with .tangleclaw config', async () => {
      const detectDir = path.join(projectsDir, 'detectable');
      fs.mkdirSync(path.join(detectDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(detectDir, '.tangleclaw', 'project.json'), '{}');

      const result = projects.detectExistingProjects();
      assert.ok(result.detected.some((d) => d.name === 'detectable'));
    });

    it('skips already registered projects', async () => {
      const result = projects.detectExistingProjects();
      // new-project is already registered, should not appear
      assert.ok(!result.detected.some((d) => d.name === 'new-project'));
    });

    it('skips hidden directories', async () => {
      fs.mkdirSync(path.join(projectsDir, '.hidden-dir'), { recursive: true });
      const result = projects.detectExistingProjects();
      assert.ok(!result.detected.some((d) => d.name === '.hidden-dir'));
    });
  });

  // #859 — the projects scan ran synchronously on the event loop, and the shipped
  // default projectsDir (~/Documents/Projects) is TCC-protected on macOS. A
  // launchd node without Full Disk Access does not get EPERM there: the open()
  // NEVER RETURNS. So one GET /api/projects took down every route — /api/health
  // answered 200 seconds earlier and then nothing, no error, no log, no recovery,
  // launchd still reporting the process alive. The dashboard loads this route, so
  // it was the first thing a new operator hit.
  describe('listAllProjects — a directory that never answers must not take the server down (#859)', () => {
    const dirScanner = require('../lib/dir-scanner');

    /**
     * Run `fn` with the scanner replaced, then restore it.
     *
     * The hang used to be injected by stubbing `fsp.readdir` in this process.
     * Since #883 the walk happens in a child process, where a stub in this one
     * cannot reach it — so the seam moved to the scanner call itself. What is
     * being pinned here is unchanged: how `listAllProjects` DEGRADES when the
     * scan does not come back. Whether the scanner really kills a hung child is
     * `test/dir-scanner.test.js`'s job, and it is asserted against a genuinely
     * blocked syscall there rather than a stub.
     *
     * @param {Function} fakeRequest - Stand-in for dirScanner.request.
     * @param {Function} fn - Test body.
     * @returns {Promise<any>}
     */
    async function withScanner(fakeRequest, fn) {
      const real = dirScanner.request;
      dirScanner.request = fakeRequest;
      try {
        return await fn();
      } finally {
        dirScanner.request = real;
      }
    }

    /**
     * The rejection a scan produces when the path never answered.
     * @returns {Error}
     */
    function timedOut() {
      return Object.assign(new Error('timed out after 5000ms reading /nowhere'),
        { tcTimedOut: true });
    }

    it('returns the registered projects instead of failing the request', async () => {
      const { projects: list } = await withScanner(
        () => Promise.reject(timedOut()),
        () => projects.listAllProjects()
      );
      assert.ok(Array.isArray(list), 'must still answer with a list');
      // Registered projects come from the database and are unaffected by a
      // stuck filesystem; only discovery of unregistered folders is lost.
      assert.ok(list.length > 0, 'the fixture must actually have registered projects to degrade to');
      for (const p of list) {
        assert.equal(p.registered, true, 'a degraded scan may only return registered projects');
      }
    });

    it('says the list is short, and why, instead of degrading silently (#885)', async () => {
      // THE MUTATION THIS CATCHES: returning the healthy `scan` on the failure
      // path — which is what a bare array amounted to. The browser got a 200 and
      // a well-formed list, and nothing distinguished "these are all your
      // projects" from "these are the ones we could still see".
      const { scan } = await withScanner(
        () => Promise.reject(timedOut()),
        () => projects.listAllProjects()
      );

      assert.equal(scan.complete, false);
      assert.equal(scan.code, 'SCAN_TIMEOUT', 'consumers branch on the code, never on the prose');
      assert.equal(scan.dir, projects.resolveProjectsDir(store.config.load().projectsDir));
      assert.ok(scan.reason, 'and a human gets a sentence');
      assert.match(scan.hint, /Full Disk Access/,
        'a path that did not answer is the failure the remedy fits');
    });

    it('carries the healthy scan when nothing went wrong', async () => {
      // The other half of the same guard: `complete: true` has to be reachable,
      // or a renderer would warn on every poll of a perfectly healthy machine.
      const { scan } = await withScanner(
        () => Promise.resolve({ unregistered: [], truncated: false }),
        () => projects.listAllProjects()
      );

      assert.equal(scan.complete, true);
      assert.equal(scan.code, null);
      assert.equal(scan.reason, null);
      assert.equal(scan.hint, null);
      assert.equal(scan.listed, null);
    });

    it('says a collateral abort is not this directory refusing', async () => {
      // The scan never ran: a sibling request in the same child stopped
      // responding and the child had to be killed. It says NOTHING about this
      // directory, so it must not be coded as a refusal and must not carry the
      // permission remedy — telling someone to grant Full Disk Access for a
      // folder that was never read is the misdiagnosis the whole scanner exists
      // to remove. Retrying is genuinely likely to work: the next request forks
      // a fresh child.
      const aborted = Object.assign(
        new Error('directory scan abandoned: the scanner was restarted for another path'),
        { tcAborted: true }
      );
      const { scan } = await withScanner(
        () => Promise.reject(aborted),
        () => projects.listAllProjects()
      );

      assert.equal(scan.complete, false);
      assert.equal(scan.code, 'SCAN_ABORTED');
      assert.equal(scan.hint, null);
    });

    it('reports a projects directory that is not there at all', async () => {
      // Its own early return, and the one shape most easily left behind: a
      // missing directory is not a failure to read, so the code returns before
      // the failure path entirely. THE MUTATION THIS CATCHES: keeping that
      // return's bare list, which would show an operator whose configured
      // directory does not exist a permanently short list with no explanation —
      // and the remedy is creating or re-pointing it, not granting a permission.
      const { scan } = await withScanner(
        () => Promise.reject(Object.assign(new Error('no such directory'), { code: 'ENOENT' })),
        () => projects.listAllProjects()
      );

      assert.equal(scan.complete, false);
      assert.equal(scan.code, 'DIR_MISSING');
      assert.match(scan.reason, /does not exist/);
      assert.equal(scan.hint, null);
    });

    it('names a remembered refusal as one, and still offers the remedy', async () => {
      // The fixture carries BOTH flags because that is what the real producer
      // sets: `dir-scanner.js` `_notAnswering` adds `tcCached` on top of
      // `tcTimedOut`, and says why — the CONDITION is unchanged (the directory
      // still is not responding, so the operator still needs the remedy) while
      // the COST is not (no child, no five-second wait), which is what callers
      // log differently. A fixture with `tcCached` alone would let this assert
      // whatever the author expected instead of what a real backoff produces.
      const cached = Object.assign(
        new Error('/x did not answer the last 3 time(s) it was read; not trying again for 42s'),
        { tcTimedOut: true, tcCached: true }
      );
      const { scan } = await withScanner(
        () => Promise.reject(cached),
        () => projects.listAllProjects()
      );

      assert.equal(scan.complete, false);
      // The CODE is what separates this from a live timeout — a consumer that
      // wants to say "not being retried right now" reads it here, not from the
      // presence of a hint.
      assert.equal(scan.code, 'SCAN_CACHED',
        'ordering matters: a cached refusal carries tcTimedOut too, so a check that '
        + 'tested tcTimedOut first would report every backoff as a fresh timeout');
      assert.match(scan.hint, /Full Disk Access/,
        'the directory is still not answering, so the remedy still applies — '
        + '`lib/project-facts.js` gives the same answer for the same condition');
    });

    it('gives the scan a deadline SHORTER than the walk it asks for', async () => {
      // The two bounds are not redundant and their order is the whole point: the
      // child stops itself first and hands back what it found, leaving the
      // supervisor's kill as the backstop for a walk that never returns at all.
      // Equal values let the kill win the tie, which throws away a partial answer
      // and reports a responsive directory as unresponsive.
      let seen;
      await withScanner(
        (op, payload, opts) => { seen = { payload, opts }; return Promise.reject(timedOut()); },
        () => projects.listAllProjects()
      );
      assert.ok(seen, 'the fixture must actually reach the scanner');
      assert.ok(seen.payload.budgetMs < seen.opts.timeoutMs,
        `the walk budget (${seen.payload.budgetMs}ms) must be under the request deadline `
        + `(${seen.opts.timeoutMs}ms)`);
    });

    it('opts the POLLED route into the failure backoff', async () => {
      // This route is polled every ten seconds for as long as a dashboard tab is
      // open. Without opting in, an unreadable projects directory costs a killed
      // child on every tick forever — and a child blocked in the kernel may never
      // leave the process table. Drop the pathKey and that returns silently:
      // everything still works, it just costs a process every ten seconds.
      let seen;
      await withScanner(
        (op, payload, opts) => { seen = opts; return Promise.reject(timedOut()); },
        () => projects.listAllProjects()
      );
      assert.ok(seen, 'the fixture must actually reach the scanner');
      assert.equal(seen.pathKey, projects.resolveProjectsDir(store.config.load().projectsDir),
        'the backoff must be keyed on the directory actually read');
    });

    it('logs a remembered refusal quietly, so one bad directory is not a log flood', async () => {
      // Same condition, same degradation — but the scanner already warned when it
      // really failed, and warns again on each escalation. Repeating that per poll
      // would bury those lines behind six identical ones a minute.
      const logger = require('../lib/logger');
      const chunks = [];
      const prevLevel = logger.getLevel();
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (c) => { chunks.push(String(c)); return true; } });
      try {
        const cached = Object.assign(new Error('remembered'),
          { tcTimedOut: true, tcCached: true });
        await withScanner(() => Promise.reject(cached), () => projects.listAllProjects());
        assert.equal(chunks.join(''), '', 'a remembered refusal must not warn again');

        // ...but a NEW failure still must, or a stuck directory goes unreported.
        await withScanner(() => Promise.reject(timedOut()), () => projects.listAllProjects());
        assert.match(chunks.join(''), /Full Disk Access/);
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel(prevLevel);
      }
    });

    it('names Full Disk Access and the safe directories when the path never answered', () => {
      // This string is the entire operator-facing value of degrading instead of
      // hanging: without it the dashboard just shows fewer projects and nobody
      // learns why. Inline it had NO coverage — deleting it left every test
      // green — which is the failure this pins.
      const timedOut = Object.assign(new Error('timed out'), { tcTimedOut: true });
      const hint = projects._scanFailureHint(timedOut);
      assert.match(hint, /Full Disk Access/, 'must name the actual macOS remedy');
      assert.match(hint, /~\/Documents/, 'must name the protected directories to avoid');
      assert.match(hint, /did not respond/, 'must say what was observed, not just what to do');
    });

    it('says it without the acronym', () => {
      // The three assertions above all pass against the older wording too, which
      // said "a TCC-protected path": they pin the FACTS the message must carry,
      // and nothing pinned the register. This is the one message a stranded
      // non-expert reads, and it is the worst moment to meet a new term — the
      // other two surfaces naming this condition already say "protected folder"
      // and "a directory node cannot read". Without this line, reverting to the
      // acronym leaves every test green.
      const timedOut = Object.assign(new Error('timed out'), { tcTimedOut: true });
      assert.doesNotMatch(projects._scanFailureHint(timedOut), /TCC/,
        'operator-facing text must not carry the acronym; the comments may');
    });

    it('actually PUTS the hint in the log when a scan times out', () => {
      // _scanFailureHint is pinned above, but pinning a helper says nothing
      // about whether anyone calls it: delete `hint: _scanFailureHint(err)` from
      // the log payload and the helper's own tests stay green while the operator
      // sees nothing. This asserts the wiring, through the logger's real sink.
      const logger = require('../lib/logger');
      const chunks = [];
      const prevLevel = logger.getLevel();
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (c) => { chunks.push(String(c)); return true; } });
      const real = dirScanner.request;
      dirScanner.request = () => Promise.reject(
        Object.assign(new Error('timed out'), { tcTimedOut: true })
      );
      return projects.listAllProjects().then(() => {
        const out = chunks.join('');
        assert.match(out, /Full Disk Access/,
          'the remedy must reach the log, not just exist in a helper');
      }).finally(() => {
        dirScanner.request = real;
        logger.setConsoleStream(null);
        logger.setLevel(prevLevel);
      });
    });

    it('adds no hint for an ordinary filesystem error', () => {
      // EACCES already explains itself. The hint exists for the failure that
      // looks like nothing at all, and attaching it everywhere would make the
      // one case it matters for invisible.
      assert.equal(projects._scanFailureHint(Object.assign(new Error('x'), { code: 'EACCES' })), undefined);
      assert.equal(projects._scanFailureHint(null), undefined);
    });

    // `_withTimeout`'s own two unit tests (the deadline fires and carries
    // `tcTimedOut`; it resolves when the work wins) are gone with the helper.
    // #883 moved every operator-path read into the scanner child, leaving the
    // helper with no production caller, and keeping dead code alive to be a
    // fixture misrepresents the module. Both contracts are asserted against the
    // code that now owns them, in test/dir-scanner.test.js — and against a real
    // blocked syscall rather than a never-settling stub.

    it('still answers when the directory read fails outright', async () => {
      const { projects: list, scan } = await withScanner(
        () => Promise.reject(Object.assign(new Error('boom'), { code: 'EACCES' })),
        () => projects.listAllProjects()
      );
      assert.ok(Array.isArray(list));
      assert.equal(scan.complete, false);
      assert.equal(scan.code, 'SCAN_FAILED');
      assert.equal(scan.hint, null,
        'a failure that is not a path refusing to answer gets no permission remedy');
    });

    it('keeps the directories it found when the walk runs out of time', async () => {
      // Bringing the per-entry loop under the deadline introduced an
      // all-or-nothing failure the old shape did not have: throw mid-loop and
      // the caller degrades to the registered projects, discarding everything
      // already discovered. This route backs the dashboard, and per-entry cost
      // is dominated by a synchronous git.getInfo (several execSync
      // calls per directory, cached two minutes) — so a cold-cache load over a few
      // dozen unregistered folders would show NONE of them, with a log line as
      // the only trace. A discovery walk that ran out of budget still
      // discovered what it got to.
      //
      // The walk now truncates inside the scanner child, so THAT half is pinned
      // in test/dir-scanner-child.test.js. What remains this file's job — and it
      // is the half that regressed before — is that `listAllProjects` RENDERS a
      // truncated result instead of treating it as a failure. Mutation: make the
      // truncated branch degrade to the registered list and `found` goes to zero.
      const partial = [
        { id: null, name: 'walked-1', path: '/x/walked-1', registered: false, git: null },
        { id: null, name: 'walked-2', path: '/x/walked-2', registered: false, git: null }
      ];
      const { projects: all, scan } = await withScanner(
        () => Promise.resolve({ unregistered: partial, truncated: true }),
        () => projects.listAllProjects()
      );
      const found = all.filter(p => p.registered === false);
      assert.deepEqual(found.map(p => p.name).sort(), ['walked-1', 'walked-2'],
        'the directories walked before the deadline must survive, not be discarded');

      // A truncated walk is the OPPOSITE failure and must not be described as the
      // same one: the directory answered fine, there is just more of it than one
      // scan can check. THE MUTATION THIS CATCHES: routing truncation through
      // `_scanFailureHint`, which would tell an operator to grant Full Disk
      // Access for a folder that has no permission problem at all.
      assert.equal(scan.complete, false, 'short is not complete, even when nothing is broken');
      assert.equal(scan.code, 'SCAN_TRUNCATED');
      assert.equal(scan.hint, null, 'nothing to remedy — there is no fault here');
      assert.equal(scan.listed, 2, 'and it says how much it did get through');
    });

    it('says the list is SHORT rather than letting a truncated walk look complete', async () => {
      // A silently-short list reads as "those directories are not there". The
      // log line is the only place that distinction exists, so it is wiring
      // worth pinning: delete the `truncated` branch and this goes red while
      // the test above still passes.
      const logger = require('../lib/logger');
      const chunks = [];
      const prevLevel = logger.getLevel();
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (c) => { chunks.push(String(c)); return true; } });
      try {
        await withScanner(
          () => Promise.resolve({ unregistered: [], truncated: true }),
          () => projects.listAllProjects()
        );
        assert.match(chunks.join(''), /SHORT, not empty/);
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel(prevLevel);
      }
    });

    it('reports an unregistered directory\'s TangleClaw config, end to end', async () => {
      // Pins the ANSWER, because the answer is what two successive rewrites of
      // the mechanism underneath it must not change: this field was a synchronous
      // `fs.existsSync`, then an awaited `fsp.access`, and is now an `access` in
      // the scanner child, and nothing else asserts it for this function.
      //
      // Deliberately end-to-end against real directories through the real
      // scanner — no stub anywhere — so it also proves the walk's result actually
      // survives the process hop with this field intact.
      fs.mkdirSync(path.join(projectsDir, 'has-tc-config', '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'has-tc-config', '.tangleclaw', 'project.json'), '{}');
      fs.mkdirSync(path.join(projectsDir, 'no-tc-config'), { recursive: true });

      const all = (await projects.listAllProjects()).projects;
      const withConfig = all.find(p => p.name === 'has-tc-config');
      const without = all.find(p => p.name === 'no-tc-config');
      assert.ok(withConfig && without, 'both unregistered directories must be listed');
      assert.equal(withConfig.hasTangleclawConfig, true);
      assert.equal(without.hasTangleclawConfig, false);
    });
  });

  // The same wedge, the OTHER call site. The projects list was fixed; the
  // first-run wizard's directory scan kept reading the operator's directory
  // synchronously, so a fresh macOS install on the pre-filled default
  // (~/Documents/Projects) still lost the whole server at wizard step 2 —
  // before the operator had any working install to go back to. Reproduced on a
  // clean macOS guest: an ordinary directory scanned 200 and left the server
  // healthy; ~/Documents/Projects never answered and the process needed a
  // launchctl kickstart.
  // `~/Documents/Projects` is the shipped default and the value the wizard
  // pre-fills — and a stock macOS install does not have it. macOS creates
  // Documents; nothing creates Projects, and nothing in TangleClaw did either.
  // So the first action of a brand-new install answered "Directory does not
  // exist" and offered nothing to do about it.
  describe('createProjectsDir — the offer that ends the dead end', () => {
    let home;
    let savedHome;

    beforeEach(() => {
      savedHome = process.env.HOME;
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-home-'));
      process.env.HOME = home;
    });

    afterEach(() => {
      process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('creates the folder the operator was pointed at', async () => {
      const target = path.join(home, 'Projects');
      const result = await projects.createProjectsDir(target);
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      assert.ok(fs.statSync(target).isDirectory());
    });

    it('expands ~ the same way the scan does', async () => {
      // The wizard sends back exactly what it displayed, and what it displays is
      // `~/Documents/Projects`. Handled anywhere but here and the button would
      // create a folder literally named "~".
      fs.mkdirSync(path.join(home, 'Documents'));
      const result = await projects.createProjectsDir('~/Documents/Projects');
      assert.equal(result.ok, true);
      assert.ok(fs.statSync(path.join(home, 'Documents', 'Projects')).isDirectory());
      assert.equal(fs.existsSync(path.join(process.cwd(), '~')), false,
        'a literal ~ directory must never appear');
    });

    it('is happy when it is already there', async () => {
      // Two clicks, or a folder made in Finder while this screen was open.
      const target = path.join(home, 'Projects');
      fs.mkdirSync(target);
      const result = await projects.createProjectsDir(target);
      assert.equal(result.ok, true);
      assert.equal(result.created, false, 'it reports that it made nothing');
    });

    it('refuses to create anything outside the home directory', async () => {
      // This route runs during first-run setup, BEFORE any credential exists,
      // so it cannot be protected by one — the constraint is the boundary. It
      // must never become a general-purpose mkdir.
      const result = await projects.createProjectsDir('/tmp/tc-should-never-exist');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
      assert.equal(fs.existsSync('/tmp/tc-should-never-exist'), false);
    });

    it('refuses a traversal that climbs back out of home', async () => {
      // `path.resolve` collapses `..` before the check, so this is normalised
      // away rather than pattern-matched — which is why a path that LOOKS like
      // it is under home cannot smuggle its way out.
      const result = await projects.createProjectsDir(path.join(home, '..', '..', 'tc-escape'));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
      assert.match(result.error, /home directory/);
    });

    it('refuses to create the home directory itself', async () => {
      const result = await projects.createProjectsDir(home);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
    });

    it('creates one level, not a tree nobody asked for', async () => {
      // "You pointed at ~/Documents/Projects and it wasn't there" is one level.
      // Five is building something at a path nobody checked.
      const result = await projects.createProjectsDir(path.join(home, 'a', 'b', 'c'));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
      assert.match(result.error, /folder above it/);
      assert.equal(fs.existsSync(path.join(home, 'a')), false);
    });

    it('reports an interrupted create as interrupted, never as a bad directory', async () => {
      // The SECOND of the two doors this fix opened, and it shipped without this
      // test while the scan side had one. Collateral means a concurrent request
      // in the same scanner stopped responding and the process had to be killed —
      // this create never ran, so it says nothing about the folder. Handing the
      // operator the Full Disk Access hint for a path that was never touched is
      // the misdiagnosis #883 exists to remove. Delete the tcAborted branch in
      // createProjectsDir and this goes red; without it, the suite stayed green.
      const dirScanner = require('../lib/dir-scanner');
      const real = dirScanner.interactiveRequest;
      dirScanner.interactiveRequest = () => Promise.reject(Object.assign(
        new Error('directory scan abandoned: the scanner process was killed'),
        { tcAborted: true }
      ));
      try {
        const result = await projects.createProjectsDir(path.join(home, 'Projects'));
        assert.equal(result.ok, false);
        assert.equal(result.code, 'CREATE_INTERRUPTED', 'its own code, not CREATE_FAILED');
        assert.doesNotMatch(result.error, /Full Disk Access/,
          'a folder that was never touched must not be blamed');
        assert.match(result.error, /Nothing was created/,
          'and the operator must be told the retry is safe');
        assert.match(result.error, /try again/);
      } finally {
        dirScanner.interactiveRequest = real;
      }
    });

    it('runs on the scanner the background poll cannot kill underneath it', async () => {
      // Same separation the scan route has. Patching only the background entry
      // point proves it: if create still used it, the stub would be reached and
      // the folder would not appear.
      const dirScanner = require('../lib/dir-scanner');
      const realBackground = dirScanner.request;
      dirScanner.request = () => Promise.reject(new Error('the poll must not be consulted here'));
      try {
        const result = await projects.createProjectsDir(path.join(home, 'Projects'));
        assert.equal(result.ok, true, 'create must be independent of the polled route');
        assert.equal(result.created, true);
      } finally {
        dirScanner.request = realBackground;
      }
    });
  });

  describe('scanDirectoryForProjects — the wizard scan must answer, not hang', () => {
    const dirScanner = require('../lib/dir-scanner');

    /**
     * Run `fn` with the scanner replaced, then restore it.
     *
     * Same seam, and same reason, as the `listAllProjects` block above: since
     * #883 the read happens in a child process, so a `fsp` stub in this one
     * cannot reach it. These tests pin how the WIZARD reports a scan that did
     * not come back; that the scanner really kills a hung child is asserted
     * against a genuinely blocked syscall in test/dir-scanner.test.js.
     *
     * @param {Function} fakeRequest - Stand-in for dirScanner.request.
     * @param {Function} fn - Test body.
     * @returns {Promise<any>}
     */
    async function withScanner(fakeRequest, fn) {
      // `interactiveRequest`, not `request`: this route runs on the scanner
      // reserved for work an operator pressed a button for, so that a hung
      // background poll cannot kill the child out from under it.
      const real = dirScanner.interactiveRequest;
      dirScanner.interactiveRequest = fakeRequest;
      try {
        return await fn();
      } finally {
        dirScanner.interactiveRequest = real;
      }
    }

    it('reports the failure instead of pretending the directory was empty', async () => {
      // The dangerous wrong answer here is not an error, it is `ok: true` with
      // an empty list — the operator ticks nothing, imports nothing, and
      // concludes they have no projects.
      const result = await withScanner(
        () => Promise.reject(Object.assign(new Error('timed out after 5000ms'),
          { tcTimedOut: true })),
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SCAN_FAILED');
    });

    it('names Full Disk Access in the error the operator will read', async () => {
      // The wizard renders this string verbatim. Without the remedy in it, the
      // operator sees a directory they can open in Finder being refused for no
      // stated reason — the state this whole change exists to prevent.
      const result = await withScanner(
        () => Promise.reject(Object.assign(new Error('timed out after 5000ms'),
          { tcTimedOut: true })),
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.equal(result.code, 'SCAN_FAILED');
      assert.match(result.error, /Full Disk Access/);
      assert.match(result.error, /~\/Documents/);
    });

    it('words a TRUNCATED walk differently, and does not blame Full Disk Access', async () => {
      // A walk that ran out of budget is the one failure a perfectly healthy
      // machine produces — a very large directory, a slow disk. Offering Full
      // Disk Access as the remedy sends the operator to change a setting that
      // was never the problem. The flag has to survive the process hop for this
      // sentence to be reachable at all.
      const result = await withScanner(
        () => Promise.reject(Object.assign(
          new Error('checked 12 of 200 subdirectories in 4750ms and gave up'),
          { tcTruncated: true }
        )),
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.equal(result.code, 'SCAN_FAILED');
      assert.match(result.error, /checked 12 of 200 subdirectories/,
        'must say how far it got, so the operator can tell slow from blocked');
      assert.doesNotMatch(result.error, /Full Disk Access — grant it/,
        'a slow directory must not be diagnosed as a protected one');
    });

    it('gives the scan a deadline SHORTER than the walk it asks for', async () => {
      let seen;
      await withScanner(
        (op, payload, opts) => { seen = { payload, opts }; return Promise.resolve({ projects: [] }); },
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.ok(seen, 'the fixture must actually reach the scanner');
      assert.ok(seen.payload.budgetMs < seen.opts.timeoutMs,
        'the child must give up before the supervisor kills it, so a slow walk can report');
    });

    it('uses a scanner the background poll cannot kill underneath it', async () => {
      // One shared child made every caller collateral for every other: a hung
      // ten-second poll of the projects directory times out, the supervisor kills
      // the child to reclaim its thread, and an operator's scan of a completely
      // HEALTHY folder dies alongside it. Patching only the background entry
      // point proves the separation — if this route still used it, the stub would
      // be reached and the scan would fail.
      const realBackground = dirScanner.request;
      dirScanner.request = () => Promise.reject(new Error('the poll must not be consulted here'));
      try {
        const result = await projects.scanDirectoryForProjects(projectsDir);
        assert.equal(result.ok, true, 'the wizard scan must be independent of the polled route');
      } finally {
        dirScanner.request = realBackground;
      }
    });

    it('reports an interrupted scan as interrupted, never as a bad directory', async () => {
      // Collateral says NOTHING about the folder the operator chose. Reporting it
      // through the Full Disk Access hint would tell someone to change a system
      // permission because an unrelated directory hung — the misdiagnosis this
      // whole issue exists to remove, arriving by another door.
      const result = await withScanner(
        () => Promise.reject(Object.assign(
          new Error('directory scan abandoned: the scanner process was killed'),
          { tcAborted: true }
        )),
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SCAN_INTERRUPTED', 'its own code, not SCAN_FAILED');
      assert.doesNotMatch(result.error, /Full Disk Access/,
        'a folder that was never read must not be blamed');
      assert.match(result.error, /try again/, 'and the operator must be told what to do');
    });

    it('does NOT opt an operator-pressed button into the failure backoff', async () => {
      // The polled route opts in; this one must not. Someone who has just granted
      // Full Disk Access and pressed Scan again is entitled to a real answer — a
      // remembered refusal would tell them their fix did not work, which is a
      // worse version of the misdiagnosis this whole issue is about. The cost of
      // leaving it out is bounded by how fast a person can click.
      let seen;
      await withScanner(
        (op, payload, opts) => { seen = opts; return Promise.resolve({ projects: [] }); },
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.ok(seen, 'the fixture must actually reach the scanner');
      assert.equal(seen.pathKey, undefined);
    });

    it('reports a missing directory under its OWN code, not a generic bad request', async () => {
      // The browser offers to CREATE this one, and it used to decide which
      // failure it was by regex-matching the message — so rewording a sentence
      // silently removed the button. The condition travels as a value now.
      const result = await projects.scanDirectoryForProjects(path.join(tmpDir, 'no-such-dir'));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'DIR_MISSING');
      assert.match(result.error, /does not exist/);
    });

    it('reports a file path as a bad request', async () => {
      const filePath = path.join(tmpDir, 'not-a-dir.txt');
      fs.writeFileSync(filePath, 'x');
      const result = await projects.scanDirectoryForProjects(filePath);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
      assert.match(result.error, /not a directory/);
    });

    it('classifies real directories end to end, through the real scanner', async () => {
      // The classification RULES are pinned in test/dir-scanner-child.test.js,
      // where `fs` can be stubbed. This is the same question asked with no stub
      // anywhere — real directories, real child process — so the two together
      // catch both a wrong rule and a correct rule whose answer does not survive
      // the hop. Deliberate duplication at two levels, not an oversight.
      const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scan-'));
      fs.mkdirSync(path.join(scanRoot, 'with-marker'));
      fs.writeFileSync(path.join(scanRoot, 'with-marker', 'go.mod'), 'module example.com/x\n');
      fs.mkdirSync(path.join(scanRoot, 'bare'));
      fs.mkdirSync(path.join(scanRoot, '.hidden'));
      fs.writeFileSync(path.join(scanRoot, 'loose-file.txt'), 'x');
      try {
        const result = await projects.scanDirectoryForProjects(scanRoot);
        assert.equal(result.ok, true);
        const names = result.projects.map(p => p.name).sort();
        assert.deepEqual(names, ['bare', 'with-marker'],
          'hidden directories and loose files are not candidate projects');
        assert.equal(result.projects.find(p => p.name === 'with-marker').detected, true);
        assert.equal(result.projects.find(p => p.name === 'bare').detected, false);
      } finally {
        fs.rmSync(scanRoot, { recursive: true, force: true });
      }
    });
  });

  describe('listAllProjects', () => {
    it('includes both registered and unregistered projects', async () => {
      // Create an unregistered directory
      fs.mkdirSync(path.join(projectsDir, 'unregistered-proj'), { recursive: true });

      const all = (await projects.listAllProjects()).projects;
      const registered = all.filter(p => p.registered === true);
      const unregistered = all.filter(p => p.registered === false);

      assert.ok(registered.length > 0, 'Should have registered projects');
      assert.ok(unregistered.some(p => p.name === 'unregistered-proj'), 'Should include unregistered dir');
    });

    it('unregistered projects have expected shape', async () => {
      const all = (await projects.listAllProjects()).projects;
      const unreg = all.find(p => p.name === 'unregistered-proj');
      assert.ok(unreg);
      assert.equal(unreg.registered, false);
      assert.equal(unreg.engine, null);
      assert.equal(unreg.session, null);
      assert.deepEqual(unreg.tags, []);
      assert.ok('path' in unreg);
    });

    it('results are sorted by name', async () => {
      const all = (await projects.listAllProjects()).projects;
      for (let i = 1; i < all.length; i++) {
        assert.ok(all[i - 1].name.toLowerCase() <= all[i].name.toLowerCase(),
          `${all[i - 1].name} should be before ${all[i].name}`);
      }
    });

    it('does not include hidden directories', async () => {
      const all = (await projects.listAllProjects()).projects;
      assert.ok(!all.some(p => p.name.startsWith('.')));
    });
  });

  describe('attachProject', () => {
    it('attaches an existing unregistered directory', async () => {
      const attachDir = path.join(projectsDir, 'attachable');
      fs.mkdirSync(attachDir, { recursive: true });

      const result = await projects.attachProject('attachable');
      assert.ok(result.project);
      assert.equal(result.project.name, 'attachable');

      // Should now be in store
      assert.ok(store.projects.getByName('attachable'));

      // Should have per-project config
      assert.ok(fs.existsSync(path.join(attachDir, '.tangleclaw', 'project.json')));
    });

  
    it('reads existing .tangleclaw/project.json', async () => {
      const attachDir = path.join(projectsDir, 'has-config');
      fs.mkdirSync(path.join(attachDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(attachDir, '.tangleclaw', 'project.json'),
        JSON.stringify({ engine: 'codex' }));

      const result = await projects.attachProject('has-config');
      assert.ok(result.project);
      // Should use engine from existing config
      const dbProject = store.projects.getByName('has-config');
      assert.equal(dbProject.engineId, 'codex');
    });

    it('rejects already registered project', async () => {
      const result = await projects.attachProject('new-project');
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('already registered'));
    });

    it('rejects non-existent directory', async () => {
      const result = await projects.attachProject('does-not-exist-xyz');
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('rejects invalid name', async () => {
      const result = await projects.attachProject('bad name!');
      assert.equal(result.project, null);
      assert.ok(result.errors.length > 0);
    });
  });

  describe('archiveProject', () => {
    it('archives a registered project', async () => {
      const result = projects.archiveProject('attachable');
      assert.ok(result.success);
      // Should not appear in default list
      const list = await projects.listProjects();
      assert.ok(!list.some(p => p.name === 'attachable'));
    });

    it('rejects archiving an already-archived project', async () => {
      const result = projects.archiveProject('attachable');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('already archived'));
    });

    it('rejects archiving a non-existent project', async () => {
      const result = projects.archiveProject('nonexistent-xyz');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('archived projects excluded from syncAllProjects', async () => {
      // syncAllProjects uses store.projects.list() which excludes archived
      const syncResult = projects.syncAllProjects();
      // attachable is archived, should not be counted
      const allActive = store.projects.list();
      assert.ok(!allActive.some(p => p.name === 'attachable'));
    });

    it('archived projects excluded from listAllProjects unregistered scan', async () => {
      const all = (await projects.listAllProjects()).projects;
      // attachable is archived — should not appear as unregistered
      const asUnreg = all.find(p => p.name === 'attachable' && p.registered === false);
      assert.equal(asUnreg, undefined);
    });
  });

  describe('unarchiveProject', () => {
    it('restores an archived project', async () => {
      const result = projects.unarchiveProject('attachable');
      assert.ok(result.success);
      // Should appear in default list again
      const list = await projects.listProjects();
      assert.ok(list.some(p => p.name === 'attachable'));
    });

    it('rejects unarchiving a non-archived project', async () => {
      const result = projects.unarchiveProject('attachable');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not archived'));
    });

    it('rejects unarchiving a non-existent project', async () => {
      const result = projects.unarchiveProject('nonexistent-xyz');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });
  });

  describe('resolveProjectsDir', () => {
    it('expands tilde to home directory', async () => {
      const result = projects.resolveProjectsDir('~/Documents');
      assert.ok(result.startsWith(process.env.HOME));
      assert.ok(result.endsWith('/Documents'));
    });

    it('returns absolute paths unchanged', async () => {
      const result = projects.resolveProjectsDir('/absolute/path');
      assert.equal(result, '/absolute/path');
    });
  });

  describe('enrichProject - version', () => {
    let versionDir;

    before(() => {
      versionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-version-'));
    });

    after(() => {
      fs.rmSync(versionDir, { recursive: true, force: true });
    });

    it('should include version from project package.json', async () => {
      const projPath = path.join(versionDir, 'with-version');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '2.5.0' }));

      const registered = store.projects.create({ name: 'ver-test-1', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '2.5.0');
    });

    it('should return null version when project has no package.json', async () => {
      const projPath = path.join(versionDir, 'no-pkg');
      fs.mkdirSync(projPath, { recursive: true });

      const registered = store.projects.create({ name: 'ver-test-2', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    it('should return null version when package.json has no version field', async () => {
      const projPath = path.join(versionDir, 'no-ver-field');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ name: 'test' }));

      const registered = store.projects.create({ name: 'ver-test-3', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    it('should return null version when package.json is malformed', async () => {
      const projPath = path.join(versionDir, 'bad-json');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), 'not json{{{');

      const registered = store.projects.create({ name: 'ver-test-4', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    // ── #55: Universal version detection chain ──

    it('layer 1: should read version from .tangleclaw/project-version.txt cache file', async () => {
      const projPath = path.join(versionDir, 'cache-only');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'version: 9.9.9-rc1\nrecorded_at: 2026-04-10T20:00:00Z\nsource: CHANGELOG.md\n'
      );

      const registered = store.projects.create({ name: 'ver-cache-1', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '9.9.9-rc1');
    });

    it('layer 1: live source overrides stale cache and self-heals (#165 — semantic inversion of pre-#165 cache-wins)', async () => {
      // Pre-#165: cache was the highest-priority source and a divergent on-disk
      // CHANGELOG/version.json/package.json never reached the dashboard label
      // until the next session launch/wrap.
      // Post-#165: live sources win on every enrichment, and the cache is
      // rewritten so the next reader (and the test of cache contents) sees
      // the corrected state. See `_detectProjectVersion self-heal (#165)`
      // describe block below for the full contract.
      const projPath = path.join(versionDir, 'cache-precedence');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'version: 1.0.0-from-cache\nsource: manual\n'
      );
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '# Changelog\n\n## [2.0.0-from-changelog] - 2026-04-01\n');
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.0.0-from-versionjson' }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.0.0-from-packagejson' }));

      const registered = store.projects.create({ name: 'ver-cache-2', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '2.0.0-from-changelog');
    });

    it('layer 1: malformed cache file falls through to next layer', async () => {
      const projPath = path.join(versionDir, 'cache-malformed');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      // No "version:" line at all
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'recorded_at: 2026-04-10\nsource: nothing\n'
      );
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '5.5.5' }));

      const registered = store.projects.create({ name: 'ver-cache-3', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '5.5.5');
    });

    it('layer 2: should read first released version from CHANGELOG.md', async () => {
      const projPath = path.join(versionDir, 'changelog-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n### Added\n- thing\n\n## [3.12.7] - 2026-04-05\n\n## [3.12.6] - 2026-04-04\n'
      );

      const registered = store.projects.create({ name: 'ver-cl-1', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '3.12.7');
    });

    it('layer 2: CHANGELOG with only [Unreleased] falls through to next layer', async () => {
      const projPath = path.join(versionDir, 'changelog-unreleased-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n- not yet released\n');
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '0.1.0' }));

      const registered = store.projects.create({ name: 'ver-cl-2', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '0.1.0');
    });

    it('layer 2: CHANGELOG should win over version.json and package.json when present', async () => {
      const projPath = path.join(versionDir, 'changelog-precedence');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [2.0.0] - 2026-04-01\n');
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.0.0' }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.0.0' }));

      const registered = store.projects.create({ name: 'ver-cl-3', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '2.0.0');
    });

    it('layer 3: should read version from version.json (TangleClaw convention)', async () => {
      const projPath = path.join(versionDir, 'versionjson-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.12.7' }));

      const registered = store.projects.create({ name: 'ver-vj-1', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '3.12.7');
    });

    it('layer 3: version.json should win over package.json when no cache or CHANGELOG', async () => {
      const projPath = path.join(versionDir, 'versionjson-precedence');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.0.0' }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.0.0' }));

      const registered = store.projects.create({ name: 'ver-vj-2', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '3.0.0');
    });

    it('chain: all sources missing returns null', async () => {
      const projPath = path.join(versionDir, 'nothing');
      fs.mkdirSync(projPath, { recursive: true });

      const registered = store.projects.create({ name: 'ver-none', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    it('chain: project path that does not exist returns null without throwing', async () => {
      // Simulate a registered project whose directory was deleted
      const result = projects._detectProjectVersion('/nonexistent/path/that/should/not/exist/anywhere');
      assert.equal(result, null);
    });

    it('helpers: _readChangelogVersion handles version with build metadata (e.g. 0.6.9-beta)', async () => {
      const projPath = path.join(versionDir, 'changelog-prerelease');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [0.6.9-beta] - 2026-04-01\n');
      assert.equal(projects._readChangelogVersion(projPath), '0.6.9-beta');
    });

    it('helpers: _readChangelogVersion rejects date-style headers (not a version)', async () => {
      const projPath = path.join(versionDir, 'changelog-date-header');
      fs.mkdirSync(projPath, { recursive: true });
      // Some projects use date headers like ## [2026-03-31] — these are NOT versions
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [2026-03-31] — Some Release\n\n## [2026-03-30] — Earlier Release\n'
      );
      assert.equal(projects._readChangelogVersion(projPath), null);
    });

    it('helpers: _readChangelogVersion skips date headers and finds first valid version', async () => {
      const projPath = path.join(versionDir, 'changelog-mixed-headers');
      fs.mkdirSync(projPath, { recursive: true });
      // Mixed: a date header AND a valid version — should skip the date and pick the version
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [2026-03-31] — Date Entry\n\n## [1.2.3] - 2026-03-01\n'
      );
      assert.equal(projects._readChangelogVersion(projPath), '1.2.3');
    });

    it('helpers: _readChangelogVersion accepts v-prefixed versions (e.g. v1.0.0)', async () => {
      const projPath = path.join(versionDir, 'changelog-v-prefix');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [v1.0.0] - 2026-04-01\n');
      assert.equal(projects._readChangelogVersion(projPath), 'v1.0.0');
    });

    // ── Critic follow-ups (#55 chunk 1 hardening) ──

    it('BOM: _readChangelogVersion handles UTF-8 BOM-prefixed file', async () => {
      const projPath = path.join(versionDir, 'changelog-bom');
      fs.mkdirSync(projPath, { recursive: true });
      // Write a BOM-prefixed CHANGELOG — common from Windows editors
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '\uFEFF# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-04-01\n'
      );
      assert.equal(projects._readChangelogVersion(projPath), '1.2.3');
    });

    it('BOM: _readVersionJsonVersion handles UTF-8 BOM-prefixed file', async () => {
      const projPath = path.join(versionDir, 'versionjson-bom');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'version.json'),
        '\uFEFF' + JSON.stringify({ version: '7.7.7' })
      );
      assert.equal(projects._readVersionJsonVersion(projPath), '7.7.7');
    });

    it('BOM: _readPackageJsonVersion handles UTF-8 BOM-prefixed file', async () => {
      const projPath = path.join(versionDir, 'packagejson-bom');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'package.json'),
        '\uFEFF' + JSON.stringify({ version: '8.8.8' })
      );
      assert.equal(projects._readPackageJsonVersion(projPath), '8.8.8');
    });

    it('BOM: _readVersionCacheFile handles UTF-8 BOM-prefixed file', async () => {
      const projPath = path.join(versionDir, 'cache-bom');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        '\uFEFFversion: 9.9.9\nsource: manual\n'
      );
      assert.equal(projects._readVersionCacheFile(projPath), '9.9.9');
    });

    it('version.json: rejects non-string version (number)', async () => {
      const projPath = path.join(versionDir, 'vj-number');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: 123 }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));

      const registered = store.projects.create({ name: 'ver-vj-num', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      // Should fall through to package.json since version.json had non-string
      assert.equal(enriched.version, '1.0.0');
    });

    it('version.json: rejects non-string version (object)', async () => {
      const projPath = path.join(versionDir, 'vj-object');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'version.json'),
        JSON.stringify({ version: { major: 1, minor: 2 } })
      );
      assert.equal(projects._readVersionJsonVersion(projPath), null);
    });

    it('version.json: rejects missing version field', async () => {
      const projPath = path.join(versionDir, 'vj-missing');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ name: 'only-name' }));
      assert.equal(projects._readVersionJsonVersion(projPath), null);
    });

    it('version.json: rejects malformed JSON', async () => {
      const projPath = path.join(versionDir, 'vj-bad');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), 'not json{{{');
      assert.equal(projects._readVersionJsonVersion(projPath), null);
    });

    it('cache file: rejects whitespace-only version value', async () => {
      const projPath = path.join(versionDir, 'cache-whitespace');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      // Version line with only spaces after the colon — should NOT be accepted
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'version:    \nsource: nothing\n'
      );
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '2.2.2' }));

      const registered = store.projects.create({ name: 'ver-cache-ws', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      // Cache file should be rejected as empty → fall through to package.json
      assert.equal(enriched.version, '2.2.2');
    });

    it('cache file: handles CRLF line endings', async () => {
      const projPath = path.join(versionDir, 'cache-crlf');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'version: 5.5.5\r\nrecorded_at: 2026-04-10\r\nsource: manual\r\n'
      );
      assert.equal(projects._readVersionCacheFile(projPath), '5.5.5');
    });

    it('layer 4 symmetry: package.json used when no cache/CHANGELOG/version.json', async () => {
      // Dedicated layer-4 test for symmetry with layers 1-3 precedence tests
      const projPath = path.join(versionDir, 'layer4-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.4.4' }));

      const registered = store.projects.create({ name: 'ver-layer4', path: projPath, engineId: 'claude-code' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.version, '4.4.4');
    });
  });

  // ── #165: Read-time self-heal of stale project-version cache ──
  describe('_detectProjectVersion self-heal (#165)', () => {
    let healDir;

    before(() => {
      healDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cache-heal-'));
    });

    after(() => {
      fs.rmSync(healDir, { recursive: true, force: true });
    });

    it('rewrites cache when on-disk version.json is newer than cached value', async () => {
      const projPath = path.join(healDir, 'stale-vs-versionjson');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      fs.writeFileSync(
        cachePath,
        'version: 3.14.0\nrecorded_at: 2026-05-05T18:30:36Z\nsource: CHANGELOG.md\n'
      );
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.16.1' }));

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '3.16.1');

      // Cache file should have been rewritten with live value + correct source label
      const rewritten = fs.readFileSync(cachePath, 'utf8');
      assert.match(rewritten, /^version: 3\.16\.1$/m);
      assert.match(rewritten, /^source: version\.json$/m);
      // recorded_at should be present and in ISO-without-ms format (Z suffix, no `.NNN` block)
      assert.match(rewritten, /^recorded_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    });

    it('rewrites cache when CHANGELOG.md is newer than cached value (priority: CHANGELOG over version.json)', async () => {
      const projPath = path.join(healDir, 'stale-vs-changelog');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      fs.writeFileSync(cachePath, 'version: 0.0.0-old\nsource: package.json\n');
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [5.0.0] - 2026-05-13\n'
      );
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '4.0.0' }));

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '5.0.0');

      const rewritten = fs.readFileSync(cachePath, 'utf8');
      assert.match(rewritten, /^version: 5\.0\.0$/m);
      assert.match(rewritten, /^source: CHANGELOG\.md$/m);
    });

    it('does not rewrite cache when cached value matches live value (steady state)', async () => {
      const projPath = path.join(healDir, 'steady-state');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      const originalBody = 'version: 2.5.0\nrecorded_at: 2026-04-01T12:00:00Z\nsource: version.json\n';
      fs.writeFileSync(cachePath, originalBody);
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '2.5.0' }));

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '2.5.0');

      // Byte-equal preservation — no recorded_at bump, no source rewrite. Filesystem-agnostic
      // (avoids mtime brittleness on coarse-resolution filesystems).
      const afterBytes = fs.readFileSync(cachePath, 'utf8');
      assert.equal(afterBytes, originalBody);
    });

    it('preserves cache when no on-disk live source exists (git-tag-derived cache survives)', async () => {
      const projPath = path.join(healDir, 'git-tag-only-cache');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      // Simulates `lib/project-version.js:recordVersion` having recorded a git-tag-derived
      // value — `lib/projects.js`'s live chain (CHANGELOG/version.json/package.json) cannot
      // reproduce this and must NOT clobber it.
      const originalBody = 'version: 1.2.3\nrecorded_at: 2026-04-01T12:00:00Z\nsource: git tag\n';
      fs.writeFileSync(cachePath, originalBody);
      // No CHANGELOG.md, no version.json, no package.json in projPath.

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '1.2.3');

      const afterBytes = fs.readFileSync(cachePath, 'utf8');
      assert.equal(afterBytes, originalBody);
    });

    it('returns live value without crashing when cache write fails (fail-open contract)', async () => {
      const projPath = path.join(healDir, 'write-failure');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '9.9.9' }));

      // Force the write path to fail by stubbing fs.writeFileSync to throw.
      // This is the only reliable cross-platform way to exercise the catch
      // block: chmod-based approaches can succeed silently on macOS when the
      // target file already exists in a r-o directory (POSIX semantics), and
      // would no-op when running as root. The stub closes both gaps and lets
      // us positively assert the fail-open path.
      const realWrite = fs.writeFileSync;
      let writeAttempts = 0;
      fs.writeFileSync = function stubWrite(...args) {
        writeAttempts += 1;
        const err = new Error('EACCES: simulated write failure');
        err.code = 'EACCES';
        throw err;
      };
      try {
        const result = projects._detectProjectVersion(projPath);
        // Must return the live value even though the cache rewrite failed.
        assert.equal(result, '9.9.9');
        // Positive proof the failure path was exercised — the stub recorded an attempt.
        assert.equal(writeAttempts, 1, 'fs.writeFileSync should have been invoked once');
        // Cache file should NOT exist (the write threw before any bytes hit disk).
        const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
        assert.equal(
          fs.existsSync(cachePath),
          false,
          'cache file should not have been created when the write threw'
        );
      } finally {
        fs.writeFileSync = realWrite;
      }
    });

    it('creates .tangleclaw/ if missing when self-healing a project that never had a cache', async () => {
      const projPath = path.join(healDir, 'no-tc-dir-yet');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '7.7.7' }));
      // Deliberately no .tangleclaw/ directory.

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '7.7.7');

      // The self-heal write should have created the directory and the cache file.
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      assert.ok(fs.existsSync(cachePath), '.tangleclaw/project-version.txt should be created');
      const body = fs.readFileSync(cachePath, 'utf8');
      assert.match(body, /^version: 7\.7\.7$/m);
      assert.match(body, /^source: version\.json$/m);
    });

    it('returns null for non-existent project path without throwing', async () => {
      const result = projects._detectProjectVersion('/nonexistent/path/for-165-test');
      assert.equal(result, null);
    });

    it('_detectLiveVersion returns null when no on-disk live source exists', async () => {
      const projPath = path.join(healDir, 'no-live-sources');
      fs.mkdirSync(projPath, { recursive: true });
      assert.equal(projects._detectLiveVersion(projPath), null);
    });

    it('_detectLiveVersion reports source label matching the reader that hit', async () => {
      const projPath = path.join(healDir, 'live-source-labels');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      assert.deepEqual(projects._detectLiveVersion(projPath), { version: '1.0.0', source: 'package.json' });

      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '2.0.0' }));
      assert.deepEqual(projects._detectLiveVersion(projPath), { version: '2.0.0', source: 'version.json' });

      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [3.0.0] - 2026-05-13\n');
      assert.deepEqual(projects._detectLiveVersion(projPath), { version: '3.0.0', source: 'CHANGELOG.md' });
    });

    // This ladder is separate from `lib/project-version.js`'s and feeds the
    // #165 self-heal, which WRITES `.tangleclaw/project-version.txt` with the
    // returned `source`. It originally had no configured-path rung, so a
    // project with `versionFilePath` set and no released CHANGELOG heading had
    // its cache overwritten with a false `source: package.json`.
    it('_detectLiveVersion honors a configured versionFilePath', async () => {
      const projPath = path.join(healDir, 'live-configured-path');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '2.0.0' }));
      fs.writeFileSync(path.join(projPath, 'VERSION.json'), JSON.stringify({ version: '9.9.9' }));

      const savedLoad = projectConfigModule.load;
      try {
        projectConfigModule.load = () => ({ versionFilePath: 'VERSION.json' });

        // Outranks both probe rungs, and labels itself with the real file.
        assert.deepEqual(projects._detectLiveVersion(projPath),
          { version: '9.9.9', source: 'VERSION.json' });

        // But CHANGELOG.md still outranks it — detection is deliberately
        // changelog-first, and the docs say so.
        fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [3.0.0] - 2026-05-13\n');
        assert.deepEqual(projects._detectLiveVersion(projPath),
          { version: '3.0.0', source: 'CHANGELOG.md' });
      } finally {
        projectConfigModule.load = savedLoad;
      }
    });

    it('_detectLiveVersion falls through to the probe when the configured file is unusable', async () => {
      const projPath = path.join(healDir, 'live-configured-bad');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '2.0.0' }));

      const savedLoad = projectConfigModule.load;
      try {
        // Points at a file that does not exist — detection degrades (the wrap
        // step refuses instead; that asymmetry is deliberate and documented).
        projectConfigModule.load = () => ({ versionFilePath: 'nope.json' });
        assert.deepEqual(projects._detectLiveVersion(projPath),
          { version: '2.0.0', source: 'version.json' });

        // And an escaping path is ignored rather than read.
        projectConfigModule.load = () => ({ versionFilePath: '../../etc/passwd.json' });
        assert.deepEqual(projects._detectLiveVersion(projPath),
          { version: '2.0.0', source: 'version.json' });
      } finally {
        projectConfigModule.load = savedLoad;
      }
    });
  });

  // ── #103 chunk 2: silentPrime UI toggle (enrichment + updateProject) ──
  describe('silentPrime (#103)', () => {
    let primeDir;

    before(() => {
      primeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-silent-prime-'));
    });

    after(() => {
      fs.rmSync(primeDir, { recursive: true, force: true });
    });

    it('enrichProject exposes silentPrime: true by default (#129)', async () => {
      // Pre-#129 the default was false (opt-in). Soak satisfied; silent prime
      // is now the default. See lib/store.js:DEFAULT_PROJECT_CONFIG.
      const projPath = path.join(primeDir, 'sp-default');
      fs.mkdirSync(projPath, { recursive: true });
      const registered = store.projects.create({ name: 'sp-default', path: projPath, engineId: 'claude' });
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.silentPrime, true);
    });

    it('enrichProject reflects silentPrime: true once set in projectConfig', async () => {
      const projPath = path.join(primeDir, 'sp-on');
      fs.mkdirSync(projPath, { recursive: true });
      const registered = store.projects.create({ name: 'sp-on', path: projPath, engineId: 'claude' });
      const projConfig = projectConfigModule.load(projPath);
      projConfig.silentPrime = true;
      store.projectConfig.save(projPath, projConfig);
      const enriched = await projects.enrichProject(registered);
      assert.equal(enriched.silentPrime, true);
    });

    it('updateProject persists silentPrime=true when engine supports it', async () => {
      const projPath = path.join(primeDir, 'sp-update-on');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-update-on', path: projPath, engineId: 'claude' });
      const result = await projects.updateProject('sp-update-on', { silentPrime: true });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, true);
      const persisted = projectConfigModule.load(projPath);
      assert.equal(persisted.silentPrime, true);
    });

    it('updateProject persists silentPrime=false (clearing the flag)', async () => {
      const projPath = path.join(primeDir, 'sp-update-off');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-update-off', path: projPath, engineId: 'claude' });
      // Pre-seed to true so we can confirm the false update reaches disk
      const seed = projectConfigModule.load(projPath);
      seed.silentPrime = true;
      store.projectConfig.save(projPath, seed);

      const result = await projects.updateProject('sp-update-off', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, false);
      assert.equal(projectConfigModule.load(projPath).silentPrime, false);
    });

    it('updateProject rejects silentPrime=true when engine lacks the capability', async () => {
      const projPath = path.join(primeDir, 'sp-update-bad');
      fs.mkdirSync(projPath, { recursive: true });
      // 'codex' / 'gemini' / 'aider' do not advertise supportsSilentPrime; using a definitely-missing id
      // is even safer for this assertion.
      store.projects.create({ name: 'sp-update-bad', path: projPath, engine: 'no-such-engine' });
      const result = await projects.updateProject('sp-update-bad', { silentPrime: true });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].toLowerCase().includes('silentprime'));
      // No project.json was written by the rejected PATCH. (Pre-#129, this
      // asserted `silentPrime === false` via the load default, but post-#129
      // the default is true — so the intent-preserving check is "the file
      // doesn't exist," not "the load returns false.")
      const projConfigFile = path.join(projPath, '.tangleclaw', 'project.json');
      assert.equal(fs.existsSync(projConfigFile), false, 'project.json should not be created on rejected PATCH');
    });

    it('updateProject rejects non-boolean silentPrime', async () => {
      const projPath = path.join(primeDir, 'sp-update-nonbool');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-update-nonbool', path: projPath, engineId: 'claude' });
      const result = await projects.updateProject('sp-update-nonbool', { silentPrime: 'yes' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].toLowerCase().includes('boolean'));
    });

    it('updateProject silentPrime=false is accepted even on unsupported engines (always allowed to clear)', async () => {
      const projPath = path.join(primeDir, 'sp-clear-bad-engine');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-clear-bad-engine', path: projPath, engine: 'no-such-engine' });
      const result = await projects.updateProject('sp-clear-bad-engine', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, false);
    });

    // Critic chunk-2 M1 regression: a same-PATCH engine change + silentPrime=true
    // must NOT partially mutate disk state when the new engine lacks the capability.
    // Pre-fix, the engine block wrote projConfig.engine and the engine config file
    // before the silentPrime gate rejected, leaving DB and disk inconsistent.
    it('updateProject rejects engine+silentPrime PATCH atomically when new engine lacks capability', async () => {
      const projPath = path.join(primeDir, 'sp-engine-race');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-engine-race', path: projPath, engine: 'claude' });

      // Snapshot pre-PATCH disk state
      const beforeProjConfig = projectConfigModule.load(projPath);
      assert.equal(beforeProjConfig.engine || null, null, 'baseline: engine field empty (lazy-set on first session)');
      const beforeRow = store.projects.getByName('sp-engine-race');

      // Attempt the bad PATCH: switch to an engine without the capability AND enable silentPrime.
      const result = await projects.updateProject('sp-engine-race', {
        engine: 'no-such-engine',
        silentPrime: true
      });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].toLowerCase().includes('silentprime'));

      // Verify NO disk-state drift: no project.json was written by the
      // rejected PATCH. (Post-#129, asserting `silentPrime === false` from
      // load() would assert the default, not the file's absence.)
      const projConfigFile = path.join(projPath, '.tangleclaw', 'project.json');
      assert.equal(fs.existsSync(projConfigFile), false, 'project.json should not be created on rejected PATCH');

      // Verify NO DB drift: engine_id still points to the original engine.
      const afterRow = store.projects.getByName('sp-engine-race');
      assert.equal(afterRow.engineId, beforeRow.engineId);
    });

    // ── #137: PATCH must sync .claude/settings.json + prime file immediately ──
    it('updateProject syncs SessionStart hook to .claude/settings.json on silentPrime=true (#137)', async () => {
      const projPath = path.join(primeDir, 'sp-sync-on');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-sync-on', path: projPath, engineId: 'claude' });

      const settingsFile = path.join(projPath, '.claude', 'settings.json');
      assert.equal(fs.existsSync(settingsFile), false, 'baseline: no settings.json yet');

      const result = await projects.updateProject('sp-sync-on', { silentPrime: true });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, true);

      assert.equal(fs.existsSync(settingsFile), true, 'settings.json should be written by syncEngineHooks');
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(settings.hooks, 'hooks block should exist');
      assert.ok(settings.hooks.SessionStart, 'SessionStart entry should exist');
      assert.equal(settings.hooks.SessionStart.length, 1);
      assert.equal(settings.hooks.SessionStart[0].matcher, 'startup');
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;
      assert.match(cmd, /"[^"]*\/data\/hooks\/sessionstart-prime\.sh"$/,
        'the command must be a QUOTED absolute path — an unquoted one breaks the moment the install path contains a space (#759)')
      assert.equal(cmd.includes('{{TANGLECLAW_DIR}}'), false, 'placeholder should be resolved');
    });

    it('updateProject removes SessionStart hook from .claude/settings.json on silentPrime=false (#137)', async () => {
      const projPath = path.join(primeDir, 'sp-sync-off');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-sync-off', path: projPath, engineId: 'claude' });

      // Seed silentPrime=true via PATCH so the baseline matches the on-disk shape PATCH would produce.
      await projects.updateProject('sp-sync-off', { silentPrime: true });
      const settingsFile = path.join(projPath, '.claude', 'settings.json');
      const seeded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(seeded.hooks && seeded.hooks.SessionStart, 'baseline: hook should be present after silentPrime=true');

      const result = await projects.updateProject('sp-sync-off', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, false);

      const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      // The SessionStart entry must be gone. The surrounding hooks block may or may
      // not be present depending on what other baseline hooks exist (#103 may grow
      // siblings) — we only care that the silentPrime entry specifically is cleared.
      const sessionStart = after.hooks && after.hooks.SessionStart;
      assert.equal(sessionStart, undefined, 'SessionStart entry should be cleared when silentPrime=false');
    });

    it('updateProject removes stale .tangleclaw/session-prime.md on silentPrime=false (#137)', async () => {
      const projPath = path.join(primeDir, 'sp-prime-cleanup');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-prime-cleanup', path: projPath, engineId: 'claude' });

      // Pre-seed silentPrime=true and write a stale prime file directly.
      const seed = projectConfigModule.load(projPath);
      seed.silentPrime = true;
      store.projectConfig.save(projPath, seed);
      const tcDir = path.join(projPath, '.tangleclaw');
      fs.mkdirSync(tcDir, { recursive: true });
      const primeFile = path.join(tcDir, 'session-prime.md');
      fs.writeFileSync(primeFile, '# stale prime from a previous session\n');
      assert.equal(fs.existsSync(primeFile), true, 'baseline: stale prime file is on disk');

      const result = await projects.updateProject('sp-prime-cleanup', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(fs.existsSync(primeFile), false, 'stale prime file should be removed by PATCH');
    });

    // ── #140: engine PATCH must clear orphan .claude/settings.json hooks ──
    it('updateProject clears orphan SessionStart hook when engine flips claude → non-claude (#140)', async () => {
      const projPath = path.join(primeDir, 'sp-engine-flip-orphan');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-engine-flip-orphan', path: projPath, engineId: 'claude' });

      // Seed silentPrime=true via PATCH so the SessionStart hook is materialized
      // as the canonical pre-flip state — same shape an existing install would
      // have on disk before the engine change.
      await projects.updateProject('sp-engine-flip-orphan', { silentPrime: true });
      const settingsFile = path.join(projPath, '.claude', 'settings.json');
      const seeded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(seeded.hooks && seeded.hooks.SessionStart, 'baseline: SessionStart hook present after silentPrime=true');

      // Inject a non-hook key so the test asserts the cleanup pass deletes ONLY
      // hooks and preserves the rest of the settings file (Critic m1).
      seeded.permissions = { allow: ['Read', 'Edit'] };
      fs.writeFileSync(settingsFile, JSON.stringify(seeded, null, 2) + '\n');

      // Flip engine away from claude WITHOUT touching silentPrime — exactly the
      // scenario from #140's repro. (antigravity here; the original gemini
      // fixture engine was retired in #457.)
      const result = await projects.updateProject('sp-engine-flip-orphan', { engine: 'antigravity' });
      assert.deepEqual(result.errors, []);
      assert.equal(store.projects.getByName('sp-engine-flip-orphan').engineId, 'antigravity');

      const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.equal(
        after.hooks && after.hooks.SessionStart,
        undefined,
        'orphan SessionStart hook must be cleared on engine flip away from claude'
      );
      assert.deepEqual(
        after.permissions,
        { allow: ['Read', 'Edit'] },
        'non-hook keys must be preserved across the cleanup pass'
      );
    });

    it('updateProject materializes SessionStart hook when engine flips non-claude → claude with silentPrime=true (#140)', async () => {
      const projPath = path.join(primeDir, 'sp-engine-flip-onto-claude');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-engine-flip-onto-claude', path: projPath, engine: 'gemini' });

      // Pre-seed silentPrime=true directly in projConfig — gemini lacks the
      // capability so a PATCH would reject, but real projects can land in this
      // state via a prior claude → gemini flip that left silentPrime=true on
      // projConfig (the second half of the #140 repro).
      const seed = projectConfigModule.load(projPath);
      seed.engine = 'gemini';
      seed.silentPrime = true;
      store.projectConfig.save(projPath, seed);

      const settingsFile = path.join(projPath, '.claude', 'settings.json');
      assert.equal(fs.existsSync(settingsFile), false, 'baseline: no .claude/settings.json yet');

      // Flip onto claude. CHANGELOG claims the hook is materialized immediately
      // rather than waiting for the next launchSession.
      const result = await projects.updateProject('sp-engine-flip-onto-claude', { engine: 'claude' });
      assert.deepEqual(result.errors, []);

      assert.equal(fs.existsSync(settingsFile), true, '.claude/settings.json should be written by syncEngineHooks');
      const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(after.hooks && after.hooks.SessionStart, 'SessionStart hook should be materialized on flip onto claude');
      assert.equal(after.hooks.SessionStart[0].matcher, 'startup');
    });

    it('updateProject silentPrime=false is a no-op for prime cleanup when file is absent (#137)', async () => {
      const projPath = path.join(primeDir, 'sp-prime-absent');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-prime-absent', path: projPath, engineId: 'claude' });

      const primeFile = path.join(projPath, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), false, 'baseline: no prime file');

      const result = await projects.updateProject('sp-prime-absent', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, false);
      assert.equal(fs.existsSync(primeFile), false, 'still absent — _removePrimeFile is non-throwing on missing');
    });
  });

  });
