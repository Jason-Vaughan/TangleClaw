'use strict';

/**
 * Which models an engine may be launched with, and whether one of them can be
 * selected right now (#2188).
 *
 * An engine profile that supports model selection declares a `models` block:
 * the CLI flag, the allowlist TangleClaw offers (`offered`), and the name of a
 * reader for the roster the installed CLI reports (`roster.source`). A model is
 * selectable only when it is in BOTH. The allowlist is a deliberate decision,
 * because a CLI's roster holds entries nobody chose to offer (Codex's cache
 * lists hidden and internal models). The roster is the installed CLI's own
 * account of what it can run, read fresh each time and never cached here, so a
 * model the CLI has dropped stops being selectable without a TangleClaw
 * release.
 *
 * Every question about a model is answered here, so saving a selection,
 * launching with one and listing the choices for a UI ask one predicate. Three
 * call sites restating "is this model usable" is how they would come to
 * disagree, and a disagreement here is a model offered in a dropdown that the
 * launch then refuses, or one the launch accepts that nothing offered.
 *
 * Nothing in this module substitutes a model. A selection that cannot be
 * confirmed is refused with a code and a sentence the operator can act on.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('./logger');

const log = createLogger('engine-models');

/**
 * The shape of a model id TangleClaw will store or place in a launch command.
 * It starts with a letter or digit, so an id can never read as a CLI flag, and
 * holds only characters that mean nothing to a shell.
 * @type {RegExp}
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * How far ahead of this machine's clock a roster's fetch time may be and still
 * be believed. Clocks drift by seconds; a list stamped further into the future
 * than this was not fetched when it says, so its age is unknown.
 */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** The shape of a CLI flag a profile may name for passing the model. */
const MODEL_FLAG = /^--?[A-Za-z][A-Za-z0-9-]{0,39}$/;

/**
 * Whether a value is a model id TangleClaw accepts at all. Asked before any
 * other check, so nothing malformed reaches a roster comparison or a command.
 * @param {*} id - The candidate.
 * @returns {boolean}
 */
function isWellFormedModelId(id) {
  return typeof id === 'string' && MODEL_ID.test(id);
}

/**
 * Where the Codex CLI keeps its model cache.
 * @param {object} [deps] - Seams: `env`, `homedir`.
 * @returns {string}
 */
function _codexModelsCachePath(deps = {}) {
  const env = deps.env || process.env;
  const home = env.CODEX_HOME || path.join((deps.homedir || os.homedir)(), '.codex');
  return path.join(home, 'models_cache.json');
}

/**
 * Read the roster the Codex CLI cached for this account.
 *
 * The CLI rewrites `models_cache.json` when it starts, with the time it
 * fetched the list. A cache older than the profile's `maxAgeHours` is reported
 * unavailable: it describes what the CLI could run then, and "then" is not a
 * roster. So is one stamped in the future, whose age cannot be known. The
 * bound is provisional: long enough for a machine used weekly, and a judgment
 * until someone measures how often the CLI really refreshes the file.
 *
 * A fresh cache says the CLI lists the model for this account. It is not
 * evidence that a turn will be accepted; only a completed turn is.
 *
 * @param {object} rosterConfig - The profile's `models.roster` block.
 * @param {object} [deps] - Seams: `readFile`, `now`, `env`, `homedir`.
 * @returns {{models: Array<{id: string, label: string}>, readAt: string, source: string}|{unavailable: true, reason: string}}
 */
function _readCodexModelsCache(rosterConfig, deps = {}) {
  const file = _codexModelsCachePath(deps);
  const unavailable = (reason) => ({ unavailable: true, reason });
  let parsed;
  try {
    parsed = JSON.parse((deps.readFile || fs.readFileSync)(file, 'utf8'));
  } catch (err) {
    return unavailable(err && err.code === 'ENOENT'
      ? 'the Codex CLI has no model list on this machine yet (start Codex once to create it)'
      : `the Codex CLI's model list could not be read: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.models)) {
    return unavailable('the Codex CLI\'s model list is not in a form TangleClaw recognises');
  }
  const fetchedAt = Date.parse(parsed.fetched_at);
  if (!Number.isFinite(fetchedAt)) {
    return unavailable('the Codex CLI\'s model list does not say when it was fetched');
  }
  const maxAgeHours = rosterConfig && Number.isFinite(rosterConfig.maxAgeHours) ? rosterConfig.maxAgeHours : null;
  const now = (deps.now || Date.now)();
  if (fetchedAt - now > FUTURE_SKEW_MS) {
    return unavailable('the Codex CLI\'s model list is dated in the future, so its age cannot be known (check this machine\'s clock, then start Codex once)');
  }
  const ageHours = (now - fetchedAt) / 3600000;
  if (maxAgeHours !== null && ageHours > maxAgeHours) {
    return unavailable(`the Codex CLI's model list was last fetched ${Math.floor(ageHours / 24)} day(s) ago (start Codex once to refresh it)`);
  }
  const models = parsed.models
    .filter((m) => m && isWellFormedModelId(m.slug))
    .map((m) => ({ id: m.slug, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug }));
  return { models, readAt: new Date(fetchedAt).toISOString(), source: 'codex-models-cache' };
}

/**
 * The roster readers a profile may name. A profile selects a reader by name;
 * it never supplies one, so an operator-edited profile cannot make TangleClaw
 * read an arbitrary file or run an arbitrary command to build a roster.
 */
const ROSTER_READERS = {
  'codex-models-cache': _readCodexModelsCache
};

/**
 * Problems with a profile's optional `models` block. An absent block is not a
 * problem: that engine offers no model selection.
 * @param {*} models - The profile's `models` value.
 * @returns {string[]} One sentence per problem; empty when the block is usable or absent.
 */
function validateModelsBlock(models) {
  if (models === undefined || models === null) return [];
  if (typeof models !== 'object' || Array.isArray(models)) return ['models must be an object'];
  const errors = [];
  if (typeof models.flag !== 'string' || !MODEL_FLAG.test(models.flag)) {
    errors.push('models.flag must be a CLI flag such as "--model"');
  }
  if (!Array.isArray(models.offered) || models.offered.length === 0) {
    errors.push('models.offered must list at least one model id');
  } else {
    for (const id of models.offered) {
      if (!isWellFormedModelId(id)) errors.push(`models.offered holds "${String(id)}", which is not a valid model id`);
    }
    if (new Set(models.offered).size !== models.offered.length) errors.push('models.offered lists a model id twice');
  }
  const source = models.roster && models.roster.source;
  if (typeof source !== 'string' || !Object.prototype.hasOwnProperty.call(ROSTER_READERS, source)) {
    errors.push(`models.roster.source must name a roster reader (one of: ${Object.keys(ROSTER_READERS).join(', ')})`);
  }
  if (models.roster && models.roster.maxAgeHours !== undefined
    && !(Number.isFinite(models.roster.maxAgeHours) && models.roster.maxAgeHours > 0)) {
    errors.push('models.roster.maxAgeHours must be a positive number when present');
  }
  return errors;
}

/**
 * The profile's `models` block when it is one this module can act on.
 * @param {object|null} engineProfile - Engine profile.
 * @returns {object|null}
 */
function _usableBlock(engineProfile) {
  const block = engineProfile && engineProfile.models;
  return block && validateModelsBlock(block).length === 0 ? block : null;
}

/**
 * The problems with a `models` block that is present and cannot be used, or
 * null when the profile has no block or a usable one.
 *
 * A profile that declares a block meant to offer models. Reading a broken one
 * as "this engine offers none" would turn a typo into a silent loss of the
 * feature, and on a launch path into a model dropped without a word. So the
 * two states are kept apart: absent is a statement, broken is a fault, and a
 * fault is logged and refused.
 *
 * @param {object|null} engineProfile - Engine profile.
 * @returns {string[]|null}
 */
function _blockFault(engineProfile) {
  const block = engineProfile && engineProfile.models;
  if (block === undefined || block === null) return null;
  const errors = validateModelsBlock(block);
  if (errors.length === 0) return null;
  // Said once per distinct fault, not once per question: a settings page that
  // asks on every render would otherwise bury the one line that matters.
  const key = `${(engineProfile && engineProfile.id) || ''}\n${errors.join('\n')}`;
  if (!_reportedFaults.has(key)) {
    _reportedFaults.add(key);
    log.warn('Engine profile declares a models block that cannot be used — model selection is refused for this engine until it is fixed', {
      engine: (engineProfile && engineProfile.id) || null,
      errors
    });
  }
  return errors;
}

/** Faults already logged, so each is reported once per process. */
const _reportedFaults = new Set();

/**
 * Where an engine stands on model selection: `none` (its profile declares no
 * `models` block), `invalid` (it declares one that cannot be used, with the
 * reasons), or `ok`.
 *
 * Three answers on purpose. A caller deciding whether to show a selector, or
 * whether a stored model still means anything, must be able to tell "this
 * engine never offered models" from "this engine's settings are broken". A
 * boolean folds the second into the first, and then a typo in a profile hides
 * the selector and drops a stored model with nothing said to the operator.
 * Every caller branches on this; none asks a yes/no question of its own.
 *
 * @param {object|null} engineProfile - Engine profile.
 * @returns {{state: 'none'}|{state: 'invalid', errors: string[]}|{state: 'ok'}}
 */
function selectionState(engineProfile) {
  if (_usableBlock(engineProfile)) return { state: 'ok' };
  const errors = _blockFault(engineProfile);
  return errors ? { state: 'invalid', errors } : { state: 'none' };
}

/**
 * What the installed CLI reports it can run, read now.
 * @param {object|null} engineProfile - Engine profile.
 * @param {object} [deps] - Seams passed to the reader.
 * @returns {{models: Array<{id: string, label: string}>, readAt: string, source: string}|{unavailable: true, reason: string}}
 */
function roster(engineProfile, deps = {}) {
  const block = _usableBlock(engineProfile);
  if (!block) {
    return { unavailable: true, reason: _blockFault(engineProfile)
      ? 'this engine\'s model settings are invalid'
      : 'this engine offers no model selection' };
  }
  return ROSTER_READERS[block.roster.source](block.roster, deps);
}

/**
 * The models to show for an engine, each with whether it can be selected now.
 *
 * Every offered model is returned, including one that cannot be selected, so a
 * UI can show it as unavailable with the reason instead of leaving the
 * operator to wonder where it went. The engine's `state` comes back with the
 * list for the same reason: an empty list from an engine whose settings are
 * broken must not look like an empty list from one that offers nothing.
 *
 * @param {object|null} engineProfile - Engine profile.
 * @param {object} [deps] - Seams passed to the reader.
 * @returns {{state: 'none'|'invalid'|'ok', errors: string[], models: Array<{id: string, label: string, available: boolean, reason: (string|null)}>}}
 *   `models` is empty unless `state` is `ok`; `errors` is empty unless it is `invalid`.
 */
function offeredWithAvailability(engineProfile, deps = {}) {
  const standing = selectionState(engineProfile);
  if (standing.state !== 'ok') return { state: standing.state, errors: standing.errors || [], models: [] };
  const block = _usableBlock(engineProfile);
  const read = roster(engineProfile, deps);
  const listed = new Map(read.unavailable ? [] : read.models.map((m) => [m.id, m.label]));
  const models = block.offered.map((id) => {
    if (read.unavailable) return { id, label: id, available: false, reason: `Cannot be confirmed: ${read.reason}.` };
    if (!listed.has(id)) {
      return { id, label: id, available: false, reason: `The installed ${_engineName(engineProfile)} CLI does not list this model for this account.` };
    }
    return { id, label: listed.get(id), available: true, reason: null };
  });
  return { state: 'ok', errors: [], models };
}

/**
 * How an engine is named in a sentence here.
 * @param {object|null} engineProfile - Engine profile.
 * @returns {string}
 */
function _engineName(engineProfile) {
  return (engineProfile && typeof engineProfile.name === 'string' && engineProfile.name) || 'engine';
}

/**
 * Whether one model may be selected for one engine right now.
 *
 * The codes are stable and the order is the answer: the first failing check is
 * the one reported, from the cheapest and most certain (the id's shape) to the
 * one that depends on the machine (the roster).
 *
 * - `MODEL_MALFORMED` — not a model id at all.
 * - `MODELS_BLOCK_INVALID` — the engine's profile declares model settings
 *   that cannot be used. Logged with the validation errors. Never read as "no
 *   selection": a caller holding a selected model must stop here.
 * - `ENGINE_HAS_NO_MODELS` — this engine offers no model selection.
 * - `MODEL_NOT_OFFERED` — not on this engine's allowlist; this is also what a
 *   model belonging to a different engine gets.
 * - `ROSTER_UNAVAILABLE` — the CLI's roster could not be read, so nothing can
 *   be confirmed.
 * - `MODEL_UNAVAILABLE` — offered, and the installed CLI does not list it.
 *
 * @param {object|null} engineProfile - Engine profile.
 * @param {*} modelId - The model being selected.
 * @param {object} [deps] - Seams passed to the reader.
 * @returns {{ok: true}|{ok: false, code: string, reason: string}}
 */
function checkSelection(engineProfile, modelId, deps = {}) {
  const refuse = (code, reason) => ({ ok: false, code, reason });
  if (!isWellFormedModelId(modelId)) {
    return refuse('MODEL_MALFORMED', 'a model id is letters, digits, dots, hyphens and underscores, starting with a letter or digit');
  }
  const name = _engineName(engineProfile);
  const block = _usableBlock(engineProfile);
  if (!block) {
    const fault = _blockFault(engineProfile);
    return fault
      ? refuse('MODELS_BLOCK_INVALID', `${name}'s model settings are invalid, so no model can be selected for it: ${fault.join('; ')}`)
      : refuse('ENGINE_HAS_NO_MODELS', `${name} offers no model selection`);
  }
  if (!block.offered.includes(modelId)) {
    return refuse('MODEL_NOT_OFFERED', `"${modelId}" is not a model offered for ${name} (offered: ${block.offered.join(', ')})`);
  }
  const read = roster(engineProfile, deps);
  if (read.unavailable) {
    return refuse('ROSTER_UNAVAILABLE', `"${modelId}" cannot be confirmed for ${name}: ${read.reason}`);
  }
  if (!read.models.some((m) => m.id === modelId)) {
    return refuse('MODEL_UNAVAILABLE', `the installed ${name} CLI does not list "${modelId}" for this account`);
  }
  return { ok: true };
}

/**
 * The launch-command elements that select a model: the profile's flag, then
 * the id in single quotes.
 *
 * The launch command is a shell string, and the id is the one element of it
 * that began in a request body. The shape check already admits nothing a shell
 * reads specially; the quotes are there so that stays true if the shape is
 * ever widened without this function being revisited. A model that fails the
 * shape check, or an engine with no flag, throws: the caller must have asked
 * `checkSelection` first, and returning nothing here would let a launch go
 * ahead without the model it was asked for.
 *
 * @param {object|null} engineProfile - Engine profile.
 * @param {string} modelId - A model that passed `checkSelection`.
 * @returns {string[]} Two elements.
 */
function modelArgv(engineProfile, modelId) {
  const block = _usableBlock(engineProfile);
  if (!block) throw new Error('modelArgv: this engine has no model flag');
  if (!isWellFormedModelId(modelId)) throw new Error('modelArgv: not a valid model id');
  return [block.flag, `'${modelId}'`];
}

module.exports = {
  MODEL_ID,
  isWellFormedModelId,
  validateModelsBlock,
  selectionState,
  roster,
  offeredWithAvailability,
  checkSelection,
  modelArgv,
  _internals: { ROSTER_READERS, FUTURE_SKEW_MS, _codexModelsCachePath, _readCodexModelsCache }
};
