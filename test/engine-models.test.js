'use strict';

/*
 * #2188 — which models an engine may be launched with, and whether one can be
 * selected now (`lib/engine-models.js`).
 *
 * The module is the single owner of every model question, so these tests pin
 * the three properties the rest of the feature leans on: nothing malformed
 * gets as far as a roster or a command, a model is selectable only when it is
 * both offered and listed by the installed CLI, and an answer that cannot be
 * confirmed is a refusal with a code, never a pass.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const models = require('../lib/engine-models');
const engines = require('../lib/engines');
const { setLevel } = require('../lib/logger');

setLevel('error');

const ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');
const NOW = Date.parse('2026-10-07T22:00:00Z');

/**
 * A bundled engine profile, as shipped.
 * @param {string} id - Engine id
 * @returns {object}
 */
function bundled(id) {
  return JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, `${id}.json`), 'utf8'));
}

/**
 * A profile offering the given models through the Codex cache reader.
 * @param {string[]} offered - Allowlist
 * @param {object} [roster] - Extra roster config
 * @returns {object}
 */
function profileOffering(offered, roster = {}) {
  return { id: 'codex', name: 'Codex', models: { flag: '--model', offered, roster: { source: 'codex-models-cache', ...roster } } };
}

/**
 * Reader seams over a cache holding the given models.
 * @param {Array<object>|null} cached - `models` entries, or null for no file
 * @param {object} [over] - Overrides: `fetchedAt`, `raw`
 * @returns {object}
 */
function cache(cached, over = {}) {
  return {
    now: () => NOW,
    env: {},
    homedir: () => '/home/op',
    readFile: (file) => {
      assert.equal(file, '/home/op/.codex/models_cache.json');
      if (cached === null) { const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; }
      if (over.raw !== undefined) return over.raw;
      return JSON.stringify({ fetched_at: over.fetchedAt === undefined ? '2026-10-07T21:00:00Z' : over.fetchedAt, models: cached });
    }
  };
}

const LISTED = [
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list' },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' }
];

describe('#2188 engine-models', () => {
  describe('isWellFormedModelId', () => {
    it('accepts the ids the trial names', () => {
      for (const id of ['gpt-5.6-sol', 'gpt-6-luna', 'gemini-3.1-pro-high', 'claude-opus-5-5-high', 'a', 'A_1']) {
        assert.equal(models.isWellFormedModelId(id), true, id);
      }
    });

    it('refuses anything a shell or a CLI could read as something else', () => {
      const bad = ['', ' gpt-6-luna', 'gpt 6', 'gpt-6-luna;id', '$(id)', '`id`', "gpt'6", 'gpt"6', 'a|b', 'a&b', 'a>b',
        'a\nb', '-m', '--model', '.hidden', '_x', 'a/b', 'a\\b', 'a=b', 'a:b', 'é', 'x'.repeat(101)];
      for (const id of bad) assert.equal(models.isWellFormedModelId(id), false, JSON.stringify(id));
      for (const id of [null, undefined, 7, {}, ['gpt-6-luna'], true]) assert.equal(models.isWellFormedModelId(id), false);
    });

    it('accepts exactly one hundred characters and no more', () => {
      assert.equal(models.isWellFormedModelId('x'.repeat(100)), true);
      assert.equal(models.isWellFormedModelId('x'.repeat(101)), false);
    });
  });

  describe('validateModelsBlock', () => {
    it('finds nothing wrong with an absent block: that engine offers no selection', () => {
      assert.deepEqual(models.validateModelsBlock(undefined), []);
      assert.deepEqual(models.validateModelsBlock(null), []);
    });

    it('names each problem in a block', () => {
      assert.match(models.validateModelsBlock([]).join(' '), /must be an object/);
      const errors = models.validateModelsBlock({ flag: 'model; rm', offered: ['ok', 'not ok', 'ok'], roster: { source: 'shell', maxAgeHours: 0 } }).join(' | ');
      assert.match(errors, /models\.flag/);
      assert.match(errors, /"not ok", which is not a valid model id/);
      assert.match(errors, /lists a model id twice/);
      assert.match(errors, /must name a roster reader/);
      assert.match(errors, /maxAgeHours/);
      assert.match(models.validateModelsBlock({ flag: '--model', offered: [], roster: { source: 'codex-models-cache' } }).join(' '), /at least one model id/);
    });

    it('does not accept a reader name that only exists on Object.prototype', () => {
      for (const source of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        assert.match(models.validateModelsBlock({ flag: '--model', offered: ['a'], roster: { source } }).join(' '), /must name a roster reader/, source);
      }
    });
  });

  describe('the Codex roster reader', () => {
    it('lists what the cache lists, with the time the CLI fetched it', () => {
      const read = models.roster(profileOffering(['gpt-6-luna']), cache(LISTED));
      assert.deepEqual(read.models.map((m) => m.id), ['gpt-5.6-sol', 'gpt-6-luna', 'gpt-reserve']);
      assert.equal(read.readAt, '2026-10-07T21:00:00.000Z');
      assert.equal(read.source, 'codex-models-cache');
    });

    it('honours CODEX_HOME', () => {
      let asked = null;
      models.roster(profileOffering(['a']), { now: () => NOW, env: { CODEX_HOME: '/srv/codex' }, homedir: () => '/home/op',
        readFile: (file) => { asked = file; return JSON.stringify({ fetched_at: '2026-10-07T21:00:00Z', models: [] }); } });
      assert.equal(asked, '/srv/codex/models_cache.json');
    });

    it('is unavailable, with a reason, for every way the cache can fail to be a roster', () => {
      const p = profileOffering(['gpt-6-luna'], { maxAgeHours: 168 });
      const cases = [
        [cache(null), /no model list on this machine yet/],
        [cache(LISTED, { raw: '{not json' }), /could not be read/],
        [cache(LISTED, { raw: JSON.stringify({ fetched_at: '2026-10-07T21:00:00Z' }) }), /not in a form TangleClaw recognises/],
        [cache(LISTED, { raw: JSON.stringify({ fetched_at: '2026-10-07T21:00:00Z', models: {} }) }), /not in a form TangleClaw recognises/],
        [cache(LISTED, { fetchedAt: null }), /does not say when it was fetched/],
        [cache(LISTED, { fetchedAt: 'last tuesday' }), /does not say when it was fetched/],
        [cache(LISTED, { fetchedAt: '2026-09-20T00:00:00Z' }), /last fetched 17 day\(s\) ago/]
      ];
      for (const [deps, reason] of cases) {
        const read = models.roster(p, deps);
        assert.equal(read.unavailable, true);
        assert.match(read.reason, reason);
        assert.equal(read.models, undefined, 'an unavailable roster carries no list to be mistaken for one');
      }
    });

    it('accepts a cache exactly at the age limit and refuses one past it', () => {
      const p = profileOffering(['gpt-6-luna'], { maxAgeHours: 1 });
      assert.equal(models.roster(p, cache(LISTED, { fetchedAt: '2026-10-07T21:00:00Z' })).unavailable, undefined);
      assert.equal(models.roster(p, cache(LISTED, { fetchedAt: '2026-10-07T20:59:59Z' })).unavailable, true);
    });

    it('refuses a cache dated in the future, and allows for a few minutes of clock drift', () => {
      const p = profileOffering(['gpt-6-luna'], { maxAgeHours: 168 });
      const future = models.roster(p, cache(LISTED, { fetchedAt: '2026-10-08T22:00:00Z' }));
      assert.equal(future.unavailable, true);
      assert.match(future.reason, /dated in the future/);
      // 22:04 against a clock reading 22:00 is drift; 22:06 is not.
      assert.equal(models.roster(p, cache(LISTED, { fetchedAt: '2026-10-07T22:04:00Z' })).unavailable, undefined);
      assert.equal(models.roster(p, cache(LISTED, { fetchedAt: '2026-10-07T22:06:00Z' })).unavailable, true);
      // A future date is refused whether or not the profile sets an age bound.
      assert.equal(models.roster(profileOffering(['gpt-6-luna']), cache(LISTED, { fetchedAt: '2027-01-01T00:00:00Z' })).unavailable, true);
    });

    it('a stale or future-dated cache refuses the selection itself, with ROSTER_UNAVAILABLE', () => {
      const p = profileOffering(['gpt-6-luna'], { maxAgeHours: 168 });
      for (const fetchedAt of ['2026-09-20T00:00:00Z', '2026-10-08T22:00:00Z', null]) {
        const res = models.checkSelection(p, 'gpt-6-luna', cache(LISTED, { fetchedAt }));
        assert.equal(res.code, 'ROSTER_UNAVAILABLE', String(fetchedAt));
      }
    });

    it('drops cache entries whose slug is not a model id instead of passing them on', () => {
      const read = models.roster(profileOffering(['gpt-6-luna']), cache([...LISTED, { slug: 'bad id; rm' }, { display_name: 'no slug' }, null]));
      assert.deepEqual(read.models.map((m) => m.id), ['gpt-5.6-sol', 'gpt-6-luna', 'gpt-reserve']);
    });
  });

  describe('offeredWithAvailability', () => {
    it('offers only the allowlist, never a model that is merely in the roster', () => {
      const offered = models.offeredWithAvailability(profileOffering(['gpt-5.6-sol', 'gpt-6-luna']), cache(LISTED)).models;
      assert.deepEqual(offered.map((m) => m.id), ['gpt-5.6-sol', 'gpt-6-luna']);
      assert.ok(offered.every((m) => m.available && m.reason === null));
      assert.deepEqual(offered.map((m) => m.label), ['GPT-5.6-Sol', 'GPT-6-Luna']);
    });

    it('keeps an offered model the CLI does not list, as unavailable with the reason', () => {
      const offered = models.offeredWithAvailability(profileOffering(['gpt-6-luna', 'gpt-7-nova']), cache(LISTED)).models;
      assert.deepEqual(offered[1], { id: 'gpt-7-nova', label: 'gpt-7-nova', available: false,
        reason: 'The installed Codex CLI does not list this model for this account.' });
      assert.equal(offered[0].available, true);
    });

    it('marks every offered model unavailable when the roster cannot be read', () => {
      const offered = models.offeredWithAvailability(profileOffering(['gpt-5.6-sol', 'gpt-6-luna']), cache(null)).models;
      assert.equal(offered.length, 2);
      for (const m of offered) {
        assert.equal(m.available, false);
        assert.match(m.reason, /^Cannot be confirmed: the Codex CLI has no model list/);
      }
    });

    it('tells an engine that offers nothing from one whose settings are broken', () => {
      // Both have no models to list. Only one of them is a fault, and a caller
      // that could not tell would hide the selector on a profile typo.
      assert.deepEqual(models.offeredWithAvailability({ id: 'x', name: 'X' }, cache(LISTED)), { state: 'none', errors: [], models: [] });
      assert.deepEqual(models.offeredWithAvailability(null, cache(LISTED)), { state: 'none', errors: [], models: [] });
      const broken = models.offeredWithAvailability({ id: 'x', models: { flag: '--model', offered: ['a'], roster: { source: 'nope' } } }, cache(LISTED));
      assert.equal(broken.state, 'invalid');
      assert.deepEqual(broken.models, []);
      assert.match(broken.errors.join(' '), /must name a roster reader/);
      assert.equal(models.offeredWithAvailability(profileOffering(['gpt-6-luna']), cache(LISTED)).state, 'ok');
    });
  });

  describe('selectionState', () => {
    it('has three answers, and never folds a broken block into "none"', () => {
      assert.deepEqual(models.selectionState({ id: 'aider', name: 'Aider' }), { state: 'none' });
      assert.deepEqual(models.selectionState(null), { state: 'none' });
      assert.deepEqual(models.selectionState({ id: 'x', models: null }), { state: 'none' });
      assert.deepEqual(models.selectionState(profileOffering(['gpt-6-luna'])), { state: 'ok' });
      for (const block of [[], 'codex', { flag: '--model' }, { flag: '--model', offered: ['a'], roster: { source: 'constructor' } }]) {
        const standing = models.selectionState({ id: 'x', name: 'X', models: block });
        assert.equal(standing.state, 'invalid', JSON.stringify(block));
        assert.ok(standing.errors.length > 0);
      }
    });
  });

  describe('checkSelection', () => {
    const p = profileOffering(['gpt-5.6-sol', 'gpt-6-luna', 'gpt-7-nova']);

    it('passes a model that is offered and listed', () => {
      assert.deepEqual(models.checkSelection(p, 'gpt-6-luna', cache(LISTED)), { ok: true });
    });

    it('refuses with one code per reason', () => {
      const code = (profile, id, deps) => models.checkSelection(profile, id, deps).code;
      assert.equal(code(p, 'gpt 6', cache(LISTED)), 'MODEL_MALFORMED');
      assert.equal(code({ id: 'aider', name: 'Aider' }, 'gpt-6-luna', cache(LISTED)), 'ENGINE_HAS_NO_MODELS');
      assert.equal(code({ id: 'x', name: 'X', models: [] }, 'gpt-6-luna', cache(LISTED)), 'MODELS_BLOCK_INVALID');
      assert.equal(code(p, 'gemini-3.1-pro-high', cache(LISTED)), 'MODEL_NOT_OFFERED', 'another engine\'s model');
      assert.equal(code(p, 'gpt-reserve', cache(LISTED)), 'MODEL_NOT_OFFERED', 'in the roster, not on the allowlist');
      assert.equal(code(p, 'gpt-6-luna', cache(null)), 'ROSTER_UNAVAILABLE');
      assert.equal(code(p, 'gpt-7-nova', cache(LISTED)), 'MODEL_UNAVAILABLE');
    });

    it('gives every refusal a sentence that names the model or the rule', () => {
      for (const [id, deps] of [['gpt 6', cache(LISTED)], ['gemini-3.1-pro-high', cache(LISTED)], ['gpt-6-luna', cache(null)], ['gpt-7-nova', cache(LISTED)]]) {
        const res = models.checkSelection(p, id, deps);
        assert.equal(res.ok, false);
        assert.ok(typeof res.reason === 'string' && res.reason.length > 20, `${res.code} needs a reason`);
      }
      assert.match(models.checkSelection(p, 'gemini-3.1-pro-high', cache(LISTED)).reason, /offered: gpt-5\.6-sol, gpt-6-luna, gpt-7-nova/);
    });

    it('refuses by name when the profile declares a models block that is invalid, and never as "no selection"', () => {
      const broken = { id: 'codex', name: 'Codex', models: { flag: '--model', offered: ['gpt-6-luna'], roster: { source: 'no-such-reader' } } };
      const res = models.checkSelection(broken, 'gpt-6-luna', cache(LISTED));
      assert.equal(res.code, 'MODELS_BLOCK_INVALID');
      assert.match(res.reason, /Codex's model settings are invalid/);
      assert.match(res.reason, /must name a roster reader/, 'the reason carries what is wrong with the block');
      // The absent case keeps its own code: that is a statement, not a fault.
      assert.equal(models.checkSelection({ id: 'aider', name: 'Aider' }, 'gpt-6-luna', cache(LISTED)).code, 'ENGINE_HAS_NO_MODELS');
      // And nothing downstream can launch with it.
      assert.equal(models.selectionState(broken).state, 'invalid');
      assert.equal(models.offeredWithAvailability(broken, cache(LISTED)).state, 'invalid');
      assert.equal(models.roster(broken, cache(LISTED)).unavailable, true);
      assert.throws(() => models.modelArgv(broken, 'gpt-6-luna'), /no model flag/);
    });

    it('never reads the roster for an id it has already refused', () => {
      const untouched = { readFile: () => assert.fail('the roster must not be read for this refusal'), now: () => NOW, env: {}, homedir: () => '/h' };
      assert.equal(models.checkSelection(p, '$(id)', untouched).code, 'MODEL_MALFORMED');
      assert.equal(models.checkSelection(p, 'gemini-3.1-pro-high', untouched).code, 'MODEL_NOT_OFFERED');
    });
  });

  describe('modelArgv', () => {
    it('is the flag and the quoted id, as two elements', () => {
      assert.deepEqual(models.modelArgv(profileOffering(['gpt-6-luna']), 'gpt-6-luna'), ['--model', "'gpt-6-luna'"]);
    });

    it('throws instead of returning a command without the model', () => {
      assert.throws(() => models.modelArgv(profileOffering(['a']), "a'; rm -rf ~; '"), /not a valid model id/);
      assert.throws(() => models.modelArgv({ id: 'aider' }, 'gpt-6-luna'), /no model flag/);
    });
  });

  describe('the bundled profiles', () => {
    const ids = fs.readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));

    it('the models check adds no validation error to any of them', () => {
      // Compared with the same profile minus its block, not with an empty list:
      // the OpenClaw profile is a connection-backed template that fails
      // `validateProfile` on `main` for reasons that have nothing to do with
      // models, and this test must not start vouching for that.
      for (const id of ids) {
        const profile = bundled(id);
        const without = { ...profile };
        delete without.models;
        assert.deepEqual(engines.validateProfile(profile).errors, engines.validateProfile(without).errors, id);
      }
      assert.deepEqual(engines.validateProfile(bundled('codex')).errors, []);
    });

    it('Codex offers the two trial models and nothing else', () => {
      const codex = bundled('codex');
      assert.deepEqual(models.selectionState(codex), { state: 'ok' });
      assert.deepEqual(codex.models.offered, ['gpt-5.6-sol', 'gpt-6-luna']);
      assert.equal(codex.models.flag, '--model');
    });

    it('Antigravity offers no model selection until its running model can be observed', () => {
      // No source has been measured that names the model of a completed turn
      // and ties it to one launch. Until one is, offering a model here would be
      // offering something TangleClaw cannot confirm it launched.
      assert.deepEqual(models.selectionState(bundled('antigravity')), { state: 'none' });
      assert.equal(models.checkSelection(bundled('antigravity'), 'gemini-3.1-pro-high', cache(LISTED)).code, 'ENGINE_HAS_NO_MODELS');
    });

    it('every other engine offers none either', () => {
      for (const id of ids.filter((i) => i !== 'codex')) assert.deepEqual(models.selectionState(bundled(id)), { state: 'none' }, id);
    });

    it('a profile with a bad models block fails validation', () => {
      const broken = bundled('codex');
      broken.models.offered.push('gpt 6; rm');
      assert.match(engines.validateProfile(broken).errors.join(' '), /not a valid model id/);
    });

    it('declaring models changes no launch command: nothing reads the block at launch yet', () => {
      const sessions = require('../lib/sessions');
      const codex = bundled('codex');
      const without = { ...codex };
      delete without.models;
      for (const mode of [undefined, 'default', 'fullAuto', 'bypassPermissions']) {
        assert.equal(sessions._buildLaunchCommand(codex, null, mode), sessions._buildLaunchCommand(without, null, mode), String(mode));
      }
    });
  });
});
