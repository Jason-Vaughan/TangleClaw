'use strict';

/*
 * A read that failed is not a thing that is absent.
 *
 * Two readers used to answer "not there" for any failure at all: the scanner
 * child's directory probe, and the project-config loader. A project's stored
 * settings (its selected model, #2188) were then reported as not set when in
 * truth nobody had been able to look. This file pins the corrected answers at
 * both readers, and at every caller that acts on the loader's "could not read"
 * signal, so that widening what counts as a failed read is a decision each of
 * them is seen to take.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');
const projectConfig = require('../lib/project-config');
const scannerChild = require('../lib/dir-scanner-child');
const rotation = require('../lib/coordinator-rotation');
const sessions = require('../lib/sessions');
const commitStep = require('../lib/wrap-steps/commit');
const { createServer } = require('../server');
const { operatorHeaders } = require('./_shared-docs-callers');
const { setLevel } = require('../lib/logger');

setLevel('error');

/** Whether this process is root, for whom no permission bit refuses anything. */
const IS_ROOT = Boolean(process.getuid && process.getuid() === 0);

describe('a read that failed is not an absence', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-unknown-absent-'));
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

  /**
   * Create a project with a config that stores `settings`.
   * @param {string} name - Project name.
   * @param {object} [settings] - Keys to set in its config.
   * @returns {object} The project row.
   */
  function mkProject(name, settings = {}) {
    const projPath = path.join(projectsDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    store.projects.create({ name, path: projPath, engine: 'codex' });
    store.projectConfig.save(projPath, { ...store.projectConfig.load(projPath), engine: 'codex', ...settings });
    return store.projects.getByName(name);
  }

  /**
   * Run `fn` while every access check of `dir` fails with `code`.
   * @param {string} dir - The directory whose check fails.
   * @param {string} code - The error code to fail with.
   * @param {() => Promise<*>} fn - What to run meanwhile.
   * @returns {Promise<*>} What `fn` resolved to.
   */
  async function withAccessFailing(dir, code, fn) {
    const realAccess = fs.promises.access;
    fs.promises.access = async function failing(p, ...rest) {
      if (p === dir) {
        const err = new Error(`${code}: simulated failure, access '${p}'`);
        err.code = code;
        throw err;
      }
      return realAccess.call(this, p, ...rest);
    };
    try {
      return await fn();
    } finally {
      fs.promises.access = realAccess;
    }
  }

  /**
   * The child's answer as the server's reader hands it on: the child's `code`
   * becomes `unreadableCode`, exactly as `readProjectFacts` does.
   * @param {object} childFacts - What `HANDLERS.projectFacts` returned.
   * @returns {object}
   */
  function asParentFacts(childFacts) {
    const { code, ...rest } = childFacts;
    return { unreadable: null, unreadableHint: null, ...rest, unreadableCode: code || null };
  }

  describe('the scanner child\'s facts about a registered project', () => {
    for (const code of ['EIO', 'ESTALE', 'ELOOP', 'EMFILE', 'ENAMETOOLONG']) {
      it(`${code} on the directory check: unknown, with that code and its words, never "gone" and never "permission denied"`, async () => {
        const row = mkProject(`probe-${code.toLowerCase()}`, { model: 'gpt-6-luna' });
        const facts = await withAccessFailing(row.path, code,
          () => scannerChild.HANDLERS.projectFacts({ dir: row.path, engineId: 'codex' }));
        assert.equal(facts.code, code);
        assert.ok(facts.unreadable, 'a failed check must say it failed');
        assert.match(facts.unreadable, new RegExp(code));
        assert.doesNotMatch(facts.unreadable, /permission denied/i);
        assert.equal(facts.config, null);

        // And what a project payload makes of it: the stored model is unknown.
        const payload = await projects.enrichProject(row, asParentFacts(facts));
        assert.equal(payload.model, null);
        assert.ok(payload.modelCheck, 'a failed check must not read as "no model stored"');
        assert.equal(payload.modelCheck.code, 'PROJECT_CONFIG_UNREADABLE');
        assert.match(payload.modelCheck.reason, new RegExp(code));
        assert.equal(payload.unreadable, facts.unreadable);
      });
    }

    for (const code of ['ENOENT', 'ENOTDIR']) {
      it(`${code} on the directory check: absent, with nothing to report`, async () => {
        const row = mkProject(`probe-${code.toLowerCase()}`, { model: 'gpt-6-luna' });
        const facts = await withAccessFailing(row.path, code,
          () => scannerChild.HANDLERS.projectFacts({ dir: row.path, engineId: 'codex' }));
        assert.equal(facts.exists, false);
        assert.equal(facts.unreadable, undefined);
        assert.equal(facts.code, undefined);
        const payload = await projects.enrichProject(row, asParentFacts(facts));
        assert.equal(payload.model, null);
        assert.equal(payload.modelCheck, null, 'a directory that is not there holds no model');
      });
    }

    for (const code of ['EACCES', 'EPERM']) {
      it(`${code} on the directory check: there and refused, as before`, async () => {
        const row = mkProject(`probe-${code.toLowerCase()}`, { model: 'gpt-6-luna' });
        const facts = await withAccessFailing(row.path, code,
          () => scannerChild.HANDLERS.projectFacts({ dir: row.path, engineId: 'codex' }));
        assert.equal(facts.exists, true);
        assert.equal(facts.code, 'EACCES');
        assert.match(facts.unreadable, /permission denied/);
        const payload = await projects.enrichProject(row, asParentFacts(facts));
        assert.equal(payload.modelCheck.code, 'PROJECT_CONFIG_UNREADABLE');
      });
    }

    it('a directory that really is gone is absent', async () => {
      const row = mkProject('probe-really-gone');
      fs.rmSync(row.path, { recursive: true, force: true });
      const facts = await scannerChild.HANDLERS.projectFacts({ dir: row.path, engineId: 'codex' });
      assert.deepEqual(facts, { exists: false, governanceState: 'not-applicable', git: null, config: null, version: null });
    });

    it('an upload to a directory whose check failed is not told the project is missing', async () => {
      const row = mkProject('probe-upload');
      const answer = await withAccessFailing(row.path, 'EIO',
        () => scannerChild.HANDLERS.saveUpload({ projectPath: row.path, filename: 'a.txt', base64Data: 'aA==' }));
      assert.deepEqual(answer, { status: 'project-unknown', code: 'EIO' });
      const gone = await withAccessFailing(row.path, 'ENOENT',
        () => scannerChild.HANDLERS.saveUpload({ projectPath: row.path, filename: 'a.txt', base64Data: 'aA==' }));
      assert.deepEqual(gone, { status: 'project-missing' });
    });
  });

  // Each row damages a project's config in a way the loader used to read as
  // "no config" and now reports as a failed read. `restore` undoes it so the
  // temp directory can be removed.
  const NEWLY_REPORTED = [
    {
      what: 'a .tangleclaw directory that may not be searched',
      needsPermissions: true,
      damage: (projPath) => fs.chmodSync(path.join(projPath, '.tangleclaw'), 0o000),
      restore: (projPath) => fs.chmodSync(path.join(projPath, '.tangleclaw'), 0o700)
    },
    {
      what: 'a project.json holding JSON that is not an object',
      needsPermissions: false,
      damage: (projPath) => fs.writeFileSync(path.join(projPath, '.tangleclaw', 'project.json'), '[]'),
      restore: () => {}
    }
  ];

  describe('the config loader', () => {
    for (const condition of NEWLY_REPORTED) {
      it(`${condition.what}: defaults returned, the failure handed to onError, nothing thrown`, (t) => {
        if (condition.needsPermissions && IS_ROOT) return t.skip('root is refused nothing');
        const row = mkProject(`load-${NEWLY_REPORTED.indexOf(condition)}`, { model: 'gpt-6-luna', medusaEnabled: true });
        condition.damage(row.path);
        try {
          const seen = [];
          const cfg = projectConfig.load(row.path, { onError: (err) => seen.push(err) });
          assert.equal(seen.length, 1, 'a file that is there and cannot be used is reported once');
          assert.deepEqual(cfg, JSON.parse(JSON.stringify(projectConfig.DEFAULT_PROJECT_CONFIG)));
          assert.doesNotThrow(() => projectConfig.load(row.path), 'with no handler it still only returns defaults');
        } finally {
          condition.restore(row.path);
        }
      });
    }

    it('a config file that is not there, and a project directory that is not there, are absent: no onError', () => {
      const row = mkProject('load-absent');
      fs.rmSync(path.join(row.path, '.tangleclaw', 'project.json'));
      const seen = [];
      projectConfig.load(row.path, { onError: (err) => seen.push(err) });
      projectConfig.load(path.join(projectsDir, 'never-created'), { onError: (err) => seen.push(err) });
      // A regular file where the project directory should be: ENOTDIR.
      const notADir = path.join(projectsDir, 'a-file');
      fs.writeFileSync(notADir, 'x');
      projectConfig.load(notADir, { onError: (err) => seen.push(err) });
      assert.deepEqual(seen, []);
    });
  });

  describe('the three callers that act on a failed config read, under the newly reported conditions', () => {
    for (const condition of NEWLY_REPORTED) {
      const tag = NEWLY_REPORTED.indexOf(condition);

      it(`coordinator rotation, ${condition.what}: the project counts as switchboard-enabled`, (t) => {
        if (condition.needsPermissions && IS_ROOT) return t.skip('root is refused nothing');
        // Stored OFF, so only the failed read can produce the answer "enabled":
        // an unreadable config must never excuse a dead listener.
        const row = mkProject(`caller-rotation-${tag}`, { medusaEnabled: false });
        assert.equal(rotation._seams.medusaEnabled(row.path), false, 'readable and off reads as off');
        condition.damage(row.path);
        try {
          assert.equal(rotation._seams.medusaEnabled(row.path), true);
        } finally {
          condition.restore(row.path);
        }
      });

      it(`wrap intent, ${condition.what}: a wrap that does not say is refused; one that says is honoured`, (t) => {
        if (condition.needsPermissions && IS_ROOT) return t.skip('root is refused nothing');
        const row = mkProject(`caller-wrap-${tag}`, { wrapKeepSessionRunning: true });
        const active = { id: 987650 + tag };
        const readable = sessions._resolveWrapIntent(row, active, {});
        assert.equal(readable.ok, true);
        assert.equal(readable.options.keepSessionRunning, true, 'readable: the project\'s own setting is used');
        condition.damage(row.path);
        try {
          const unknown = sessions._resolveWrapIntent(row, active, {});
          assert.equal(unknown.ok, false,
            'whether this wrap ends the session is unknown, so it must not proceed on the default');
          assert.match(unknown.error, /could not be read/);
          const said = sessions._resolveWrapIntent(row, active, { keepSessionRunning: false });
          assert.equal(said.ok, true, 'an explicit choice needs no config');
          assert.equal(said.options.keepSessionRunning, false);
          assert.equal(said.options.keepSource, 'request');
        } finally {
          condition.restore(row.path);
        }
      });

      it(`release cut, ${condition.what}: releasePrepareCommand is reported as not run, with the reason`, (t) => {
        if (condition.needsPermissions && IS_ROOT) return t.skip('root is refused nothing');
        const row = mkProject(`caller-commit-${tag}`, { releasePrepareCommand: 'node scripts/prepare.js' });
        assert.deepEqual(commitStep._releasePrepareCommandOf(row), { command: 'node scripts/prepare.js', reason: null });
        condition.damage(row.path);
        try {
          const answer = commitStep._releasePrepareCommandOf(row);
          assert.equal(answer.command, null, 'a command that may be set in an unreadable file is not guessed at');
          assert.match(answer.reason, /could not be read/);
          assert.match(answer.reason, /releasePrepareCommand was not run/);
        } finally {
          condition.restore(row.path);
        }
      });
    }
  });

  describe('a settings save on a project whose config cannot be used', () => {
    let server;
    let port;
    let codexHome;
    let savedCodexHome;

    before(async () => {
      // The model check reads the Codex CLI's model list; this test owns it.
      codexHome = path.join(tmpDir, 'codex-home');
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
        fetched_at: new Date().toISOString(),
        models: store.engines.get('codex').models.offered.map((slug) => ({ slug, display_name: slug }))
      }));
      savedCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexHome;
      server = createServer();
      await new Promise((resolve) => server.listen(0, () => { port = server.address().port; resolve(); }));
    });

    after(async () => {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      await new Promise((resolve) => server.close(resolve));
    });

    /**
     * PATCH a project as the operator's dashboard.
     * @param {string} name - Project name.
     * @param {object} body - The request body.
     * @returns {Promise<{status: number, data: object}>}
     */
    function patch(name, body) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port, path: `/api/projects/${name}`, method: 'PATCH', agent: false,
          headers: { 'Content-Type': 'application/json', ...operatorHeaders(server) }
        }, (res) => {
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
        req.write(JSON.stringify(body));
        req.end();
      });
    }

    /**
     * Everything a refused save must leave exactly as it found it.
     * @param {object} row - The project row.
     * @returns {{file: (Buffer|null), engineId: string, tags: string, name: string, recovery: string, dir: boolean}}
     */
    function snapshot(row) {
      const file = path.join(row.path, '.tangleclaw', 'project.json');
      let bytes = null;
      try { bytes = fs.readFileSync(file); } catch { bytes = null; }
      const now = store.projects.get(row.id);
      return {
        file: bytes,
        engineId: now.engineId,
        tags: JSON.stringify(now.tags),
        name: now.name,
        recovery: JSON.stringify(store.projectRecoveryState.get(row.id) || null),
        dir: fs.existsSync(row.path)
      };
    }

    // A request that would touch everything a project update can: the config
    // file (model, launch mode, launch sequence), the project row (engine,
    // tags) and the recovery store (the operator's recovery-mode decision).
    const EVERYTHING = {
      engine: 'claude',
      model: null,
      tags: ['changed'],
      defaultLaunchMode: 'default',
      launchSequence: { recoveryMode: 'advisory' }
    };

    const UNUSABLE = [
      { what: 'malformed JSON', needsPermissions: false, damage: (file) => fs.writeFileSync(file, '{ "engine": "codex", "model": "gpt-6-luna", '), restore: () => {} },
      { what: 'a JSON number', needsPermissions: false, damage: (file) => fs.writeFileSync(file, '42'), restore: () => {} },
      { what: 'a JSON string', needsPermissions: false, damage: (file) => fs.writeFileSync(file, '"gpt-6-luna"'), restore: () => {} },
      { what: 'a JSON list', needsPermissions: false, damage: (file) => fs.writeFileSync(file, '[]'), restore: () => {} },
      { what: 'a file that may not be read', needsPermissions: true, damage: (file) => fs.chmodSync(file, 0o000), restore: (file) => fs.chmodSync(file, 0o600) },
      { what: 'a .tangleclaw directory that may not be searched', needsPermissions: true, damage: (file) => fs.chmodSync(path.dirname(file), 0o000), restore: (file) => fs.chmodSync(path.dirname(file), 0o700) }
    ];

    for (const condition of UNUSABLE) {
      it(`${condition.what}: the whole request is refused with 409 PROJECT_CONFIG_UNREADABLE and nothing changes`, async (t) => {
        if (condition.needsPermissions && IS_ROOT) return t.skip('root is refused nothing');
        const name = `save-${UNUSABLE.indexOf(condition)}`;
        const row = mkProject(name, { model: 'gpt-6-luna', defaultLaunchMode: 'fullAuto' });
        const file = path.join(row.path, '.tangleclaw', 'project.json');
        // The snapshot has to hold the DAMAGED file's bytes, since the claim is
        // that a refused save leaves the damaged file exactly as it was. A
        // file whose permissions were taken away cannot be read while damaged,
        // so it is damaged, made readable for the snapshot, and damaged again.
        // For the damage that rewrites the file, `restore` does nothing and
        // the second damage writes the same bytes.
        condition.damage(file);
        let before;
        try {
          condition.restore(file);
          before = snapshot(row);
          condition.damage(file);

          for (const body of [EVERYTHING, { model: 'gpt-5.6-sol' }, { tags: ['only-the-row'] }, { engine: 'claude' }]) {
            const res = await patch(name, body);
            assert.equal(res.status, 409, `${JSON.stringify(body)} -> ${JSON.stringify(res.data)}`);
            assert.equal(res.data.code, 'PROJECT_CONFIG_UNREADABLE');
            assert.match(res.data.error, /project\.json/);
            assert.match(res.data.error, /Nothing in this request was applied/);
            assert.match(res.data.error, /Fix the file, or remove it/, 'the refusal says what to do');
          }
        } finally {
          condition.restore(file);
        }
        assert.deepEqual(snapshot(row), before,
          'the file, the project row and the recovery store are exactly as they were: no partial write');
      });
    }

    it('a project with no config file is not refused: it starts from the defaults (control)', async () => {
      const row = mkProject('save-absent');
      fs.rmSync(path.join(row.path, '.tangleclaw', 'project.json'));
      const res = await patch('save-absent', { model: 'gpt-6-luna', tags: ['ok'] });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.model, 'gpt-6-luna');
      assert.equal(store.projectConfig.load(row.path).model, 'gpt-6-luna');
    });

    it('a usable config is not refused, and the same request that was refused succeeds once the file is fixed', async () => {
      const row = mkProject('save-fixed', { model: 'gpt-6-luna' });
      const file = path.join(row.path, '.tangleclaw', 'project.json');
      const good = fs.readFileSync(file);
      fs.writeFileSync(file, 'not json');
      assert.equal((await patch('save-fixed', EVERYTHING)).status, 409);
      fs.writeFileSync(file, good);
      const res = await patch('save-fixed', EVERYTHING);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.engine, 'claude');
      assert.equal(res.data.model, null);
    });

    it('a config that becomes unusable while the update is being applied is not overwritten', async () => {
      // Two fields that each reload the config and write it back. After the
      // first write lands, the file is damaged; the second reload must stop
      // the update instead of reading defaults and saving them over the file.
      const row = mkProject('save-midway', { model: 'gpt-6-luna' });
      const file = path.join(row.path, '.tangleclaw', 'project.json');
      const realSave = store.projectConfig.save;
      let saves = 0;
      store.projectConfig.save = function damaging(projectPath, cfg) {
        const out = realSave.call(this, projectPath, cfg);
        if (projectPath === row.path && ++saves === 1) fs.writeFileSync(file, '{ damaged');
        return out;
      };
      let res;
      try {
        res = await patch('save-midway', { quickCommands: [{ label: 'a', command: 'b' }], medusaWake: true });
      } finally {
        store.projectConfig.save = realSave;
      }
      assert.equal(saves, 1, 'no second write followed the damage');
      assert.equal(fs.readFileSync(file, 'utf8'), '{ damaged', 'the unusable file is left as it is, not replaced by defaults');
      assert.equal(res.status, 409, JSON.stringify(res.data));
      assert.equal(res.data.code, 'PROJECT_CONFIG_UNREADABLE');
      assert.match(res.data.error, /stopped part-way/);
    });

    it('when that happens after a recovery-mode decision was recorded, the answer says the decision stands', async () => {
      // The recovery decision lives in the server store and is written before
      // the config file. The two cannot be made one write, so a config that
      // fails afterwards must not be reported as "nothing happened": the
      // decision was saved, and the answer has to carry it.
      const row = mkProject('save-midway-recovery');
      const file = path.join(row.path, '.tangleclaw', 'project.json');
      const realSave = store.projectConfig.save;
      let saves = 0;
      store.projectConfig.save = function damaging(projectPath, cfg) {
        const out = realSave.call(this, projectPath, cfg);
        if (projectPath === row.path && ++saves === 1) fs.writeFileSync(file, '{ damaged');
        return out;
      };
      let res;
      try {
        res = await patch('save-midway-recovery', { medusaWake: true, launchSequence: { recoveryMode: 'advisory' } });
      } finally {
        store.projectConfig.save = realSave;
      }
      assert.equal(saves, 1);
      assert.equal(fs.readFileSync(file, 'utf8'), '{ damaged', 'the unusable file is not overwritten');
      assert.equal(res.status, 500, JSON.stringify(res.data));
      assert.equal(res.data.code, 'RECOVERY_DECISION_SAVED_UPDATE_FAILED');
      assert.equal(res.data.recoveryMode.mode, 'advisory', 'the saved decision is in the answer');
      assert.match(res.data.error, /project\.json/);
      assert.match(res.data.error, /recovery mode itself was saved as advisory/);
      const decided = store.projectRecoveryState.get(row.id);
      assert.ok(decided, 'and it really is in the store');
    });

    it('loadConfigForWrite returns a read config, returns defaults for none, and throws for one it cannot use', () => {
      const row = mkProject('save-loader', { model: 'gpt-6-luna' });
      assert.equal(projects.loadConfigForWrite(row.path).model, 'gpt-6-luna');
      assert.equal(projects.loadConfigForWrite(path.join(projectsDir, 'never-created-2')).model, null);
      fs.writeFileSync(path.join(row.path, '.tangleclaw', 'project.json'), '{');
      assert.throws(() => projects.loadConfigForWrite(row.path),
        (err) => err.code === 'PROJECT_CONFIG_UNREADABLE' && err.cause instanceof Error);
    });
  });
});
