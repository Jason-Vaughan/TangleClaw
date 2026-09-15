'use strict';

// The AI release recommendation's helpers (#1492 L2): when the wrap asks for one,
// how a captured answer is read, and how version-bump finds it among the prior
// step results.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const rec = require('../lib/wrap-steps/_release-recommendation');

describe('release recommendation helpers', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-rec-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A project with a CHANGELOG and, optionally, a project config.
   *
   * @param {object} opts
   * @param {object} [opts.config] - `.tangleclaw/project.json`; omitted = no file
   * @param {string|null} [opts.changelog] - CHANGELOG.md text; `null` = no file
   * @returns {{name: string, path: string}}
   */
  function makeProject({ config, changelog } = {}) {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'p-'));
    const text = changelog === undefined
      ? '# Changelog\n\n## [Unreleased]\n\n### Added\n- a feature\n\n## [1.2.3] - 2026-09-01\n'
      : changelog;
    if (text !== null) fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), text);
    if (config) {
      fs.mkdirSync(path.join(dir, '.tangleclaw'));
      fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), JSON.stringify(config));
    }
    return { name: path.basename(dir), path: dir };
  }

  describe('releaseDecisionOpen', () => {
    it('is open for an auto or ask project with entries to release', () => {
      assert.deepEqual(rec.releaseDecisionOpen(makeProject({ config: { releaseMode: 'auto' } }), {}), { open: true });
      assert.deepEqual(rec.releaseDecisionOpen(makeProject({ config: { releaseMode: 'ask' } }), {}), { open: true });
      assert.deepEqual(rec.releaseDecisionOpen(makeProject(), {}), { open: true }, 'no config resolves to auto');
    });

    it('is closed when releaseMode is off, including the legacy flag', () => {
      for (const config of [{ releaseMode: 'off' }, { versionBumpEnabled: false }]) {
        const out = rec.releaseDecisionOpen(makeProject({ config }), {});
        assert.equal(out.open, false);
        assert.match(out.reason, /releaseMode is off/);
      }
    });

    it('is closed once the operator has decided', () => {
      const project = makeProject({ config: { releaseMode: 'auto' } });
      assert.match(rec.releaseDecisionOpen(project, { release: 'cut' }).reason, /you chose Cut/);
      assert.match(rec.releaseDecisionOpen(project, { release: 'hold' }).reason, /you chose Hold/);
      assert.match(rec.releaseDecisionOpen(project, { bumpLevel: 'patch' }).reason, /picked a patch release/);
    });

    it('stays open for an unrecognised release value, which version-bump refuses by name', () => {
      assert.deepEqual(rec.releaseDecisionOpen(makeProject(), { release: 'maybe' }), { open: true });
    });

    it('is closed when there is nothing to release', () => {
      assert.match(rec.releaseDecisionOpen(makeProject({ changelog: null }), {}).reason, /no CHANGELOG\.md/);
      assert.match(rec.releaseDecisionOpen(makeProject({ changelog: '# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n' }), {}).reason,
        /\[Unreleased\] has no entries/);
      assert.match(rec.releaseDecisionOpen(makeProject({ changelog: '# Changelog\n\n## [1.0.0]\n- x\n' }), {}).reason,
        /\[Unreleased\] has no entries/);
    });

    it('stays open when the CHANGELOG exists but cannot be read', () => {
      const project = makeProject();
      const original = rec._internal.readFileSync;
      rec._internal.readFileSync = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
      try {
        assert.deepEqual(rec.releaseDecisionOpen(project, {}), { open: true });
      } finally {
        rec._internal.readFileSync = original;
      }
    });

    it('resolves releaseMode from defaults when the config cannot be loaded', () => {
      const project = makeProject({ config: { releaseMode: 'off' } });
      const original = rec._internal.loadConfig;
      rec._internal.loadConfig = () => { throw new Error('bad json'); };
      try {
        assert.deepEqual(rec.releaseDecisionOpen(project, {}), { open: true });
      } finally {
        rec._internal.loadConfig = original;
      }
    });
  });

  describe('parseRecommendation', () => {
    it('reads each value, with the operator intent and reason', () => {
      for (const value of ['cut', 'hold', 'unsure']) {
        assert.deepEqual(
          rec.parseRecommendation({ releaseRecommendation: value, operatorIntent: '"just saving state"', reason: 'mid-feature' }),
          { state: 'given', value, operatorIntent: '"just saving state"', reason: 'mid-feature' }
        );
      }
    });

    it('tolerates markdown decoration, case and trailing prose on the first line', () => {
      for (const raw of ['**Hold**', '`cut`', 'Hold.', '"unsure"', '\n\n  HOLD — the operator is saving state\nmore']) {
        const out = rec.parseRecommendation({ releaseRecommendation: raw });
        assert.equal(out.state, 'given', `read ${JSON.stringify(raw)}`);
      }
      assert.equal(rec.parseRecommendation({ releaseRecommendation: '**Hold**' }).value, 'hold');
    });

    it('defaults an absent intent to none stated', () => {
      assert.equal(rec.parseRecommendation({ releaseRecommendation: 'cut' }).operatorIntent, 'none stated');
    });

    it('reads anything else as an absence that quotes what was written', () => {
      const out = rec.parseRecommendation({ releaseRecommendation: 'I would probably cut' });
      assert.equal(out.state, 'absent');
      assert.match(out.reason, /"I would probably cut"/);
      assert.equal(rec.parseRecommendation({}).state, 'absent');
      assert.match(rec.parseRecommendation(null).reason, /said nothing/);
      assert.equal(rec.parseRecommendation({ releaseRecommendation: 'cutting' }).state, 'absent',
        'a word that merely starts with a value is not that value');
    });
  });

  describe('recommendationFrom', () => {
    it('parses a done step', () => {
      const out = rec.recommendationFrom([
        { stepId: 'changelog-update', status: 'done', output: {} },
        { stepId: 'release-recommendation', status: 'done', output: { parsedFields: { releaseRecommendation: 'hold' } } }
      ]);
      assert.equal(out.state, 'given');
      assert.equal(out.value, 'hold');
    });

    it('names why there is no recommendation', () => {
      assert.match(rec.recommendationFrom([]).reason, /no release-recommendation step ran/);
      assert.match(rec.recommendationFrom(undefined).reason, /no release-recommendation step ran/);
      assert.match(rec.recommendationFrom([{ stepId: 'release-recommendation', status: 'skipped', output: { reason: 'disabled for this project' } }]).reason,
        /disabled for this project/);
      assert.match(rec.recommendationFrom([{ stepId: 'release-recommendation', status: 'skipped', output: null }]).reason,
        /was skipped/);
      const blocked = rec.recommendationFrom([{ stepId: 'release-recommendation', status: 'blocked', output: null, blockers: ['AI did not finish'] }]);
      assert.equal(blocked.state, 'absent');
      assert.match(blocked.reason, /did not finish \(blocked\): AI did not finish/);
    });
  });
});
