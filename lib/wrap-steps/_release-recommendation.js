'use strict';

/**
 * The AI release recommendation (#1492 L2): when the wrap asks for one, and how
 * the answer is read back.
 *
 * The readiness gate (`lib/release-readiness.js`) judges a release from files,
 * so it can't tell "wrap and cut a release" from "wrapping to save state". The
 * `release-recommendation` content step asks the session itself, whose engine
 * holds the conversation, and `version-bump` halts when the two disagree.
 *
 * Three functions, one owner each:
 *  - {@link releaseDecisionOpen} decides whether the prompt is worth sending. The
 *    content handler and the runner's prompt roster both ask it, so they agree
 *    on everything the roster can know before the first step runs.
 *  - {@link parseRecommendation} turns the captured fields into a value or an
 *    honest absence. It never guesses a value from text it can't read.
 *  - {@link recommendationFrom} finds this run's recommendation among the prior
 *    step results, for `version-bump`.
 *
 * @module lib/wrap-steps/_release-recommendation
 */

const path = require('node:path');
const fs = require('node:fs');
const store = require('../store');
const projectConfigModule = require('../project-config');
const { configRootOf } = require('./_config-root');
const { createLogger } = require('../logger');

const log = createLogger('wrap-release-recommendation');

/** The pipeline step id `version-bump` reads the recommendation from. */
const STEP_ID = 'release-recommendation';

/** The values a recommendation may take. */
const RECOMMENDATIONS = ['cut', 'hold', 'unsure'];

// Wrapping a model tends to put around a one-word answer: backticks, bold or
// italic markers, quotes, and a trailing full stop.
const DECORATION_RE = /[`*_"'.]/g;

/**
 * Whether this wrap's release decision is still open, so a recommendation could
 * change what `version-bump` does.
 *
 * It is closed when the project doesn't version through the wrap
 * (`releaseMode` off), when the operator has already decided (their decision
 * wins over any recommendation), and when there is nothing to release. It
 * doesn't replay version-bump's semver and drift guards, so a project that can
 * never be bumped still gets the prompt. Copying those guards here would give
 * them a second owner.
 *
 * While the prompt roster plans (`planning: true`) the CHANGELOG isn't read:
 * `changelog-update` runs first and may write the entries this looks for.
 *
 * @param {object} project - Scoped project record (`path` is the work tree)
 * @param {object} [options] - Runner options (reads `release`, `bumpLevel`)
 * @param {{planning?: boolean}} [phase] - `planning: true` from the prompt roster
 * @returns {{open: true}|{open: false, reason: string}}
 */
function releaseDecisionOpen(project, options, phase) {
  const opts = options || {};
  if (!project || !project.path) return { open: false, reason: 'no project path' };

  let projConfig = null;
  try {
    projConfig = _internal.loadConfig(configRootOf(project));
  } catch (err) { // prawduct:allow prawduct/broad-except -- an unreadable config must not stop the wrap; version-bump resolves the same null config the same way and logs it there
    log.warn('project config unreadable — resolving releaseMode from defaults', { project: project.name, error: err.message });
  }
  const mode = projectConfigModule.resolveReleaseMode(projConfig).mode;
  if (mode === 'off') {
    return { open: false, reason: 'no release recommendation needed: releaseMode is off' };
  }

  if (opts.release === 'cut' || opts.release === 'hold') {
    return { open: false, reason: `no release recommendation needed: you chose ${opts.release === 'cut' ? 'Cut' : 'Hold'}` };
  }
  if (opts.bumpLevel !== undefined && opts.bumpLevel !== null) {
    return { open: false, reason: `no release recommendation needed: you picked a ${opts.bumpLevel} release` };
  }

  if (phase && phase.planning === true) return { open: true };

  const changelogPath = path.join(project.path, 'CHANGELOG.md');
  let text;
  try {
    text = _internal.readFileSync(changelogPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { open: false, reason: 'no release recommendation needed: no CHANGELOG.md to release from' };
    }
    // Unreadable is not "nothing to release". version-bump reports the read
    // failure itself; asking for a recommendation costs one prompt and hides
    // nothing.
    return { open: true };
  }
  // Lazy: version-bump reads this module's parser, so a top-level require here
  // would be a cycle.
  const parsed = require('./version-bump')._parseUnreleased(text);
  if (!parsed.ok || !parsed.hasEntries) {
    return { open: false, reason: 'no release recommendation needed: [Unreleased] has no entries' };
  }
  return { open: true };
}

/**
 * Read a captured recommendation.
 *
 * The first word of the field's first non-empty line decides, once markdown
 * decoration is stripped: `cut`, `hold` or `unsure`. Anything else is an
 * absence that quotes what was written, because a value guessed from prose
 * could halt or release on a word the AI never meant as an answer.
 *
 * @param {Record<string, string>|null|undefined} parsedFields - The step's parsed capture
 * @returns {{state: 'given', value: 'cut'|'hold'|'unsure', operatorIntent: string, reason: string}
 *   |{state: 'absent', reason: string}}
 */
function parseRecommendation(parsedFields) {
  const fields = parsedFields && typeof parsedFields === 'object' ? parsedFields : {};
  const raw = typeof fields.releaseRecommendation === 'string' ? fields.releaseRecommendation : '';
  const firstLine = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  const word = (firstLine.replace(DECORATION_RE, ' ').trim().split(/\s+/)[0] || '').toLowerCase();
  if (!RECOMMENDATIONS.includes(word)) {
    const quoted = firstLine ? JSON.stringify(firstLine.slice(0, 80)) : 'nothing';
    return { state: 'absent', reason: `the recommendation couldn't be read: it said ${quoted}, not cut, hold or unsure` };
  }
  return {
    state: 'given',
    value: word,
    operatorIntent: _text(fields.operatorIntent) || 'none stated',
    reason: _text(fields.reason)
  };
}

/**
 * This run's recommendation, from the results of the steps before `version-bump`.
 *
 * Every way the step can have not produced one is named, because "the AI
 * didn't recommend" and "the wrap didn't ask" lead the operator to different
 * places.
 *
 * @param {Array<{stepId: string, status: string, output: any, blockers?: string[]}>} previousResults
 * @returns {{state: 'given', value: 'cut'|'hold'|'unsure', operatorIntent: string, reason: string}
 *   |{state: 'absent', reason: string}}
 */
function recommendationFrom(previousResults) {
  const result = (previousResults || []).find((r) => r && r.stepId === STEP_ID);
  if (!result) return { state: 'absent', reason: 'no release-recommendation step ran in this wrap' };
  const output = result.output && typeof result.output === 'object' ? result.output : {};
  if (result.status === 'done') return parseRecommendation(output.parsedFields);
  if (result.status === 'skipped') {
    return { state: 'absent', reason: _text(output.reason) || 'the release-recommendation step was skipped' };
  }
  const blocker = Array.isArray(result.blockers) && result.blockers[0] ? `: ${result.blockers[0]}` : '';
  return { state: 'absent', reason: `the release-recommendation step did not finish (${result.status})${blocker}` };
}

/**
 * Trim a captured field to one tidy string.
 *
 * @param {*} value
 * @returns {string}
 */
function _text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const _internal = {
  loadConfig: (configRoot) => store.projectConfig.load(configRoot),
  readFileSync: fs.readFileSync.bind(fs)
};

module.exports = {
  STEP_ID,
  RECOMMENDATIONS,
  releaseDecisionOpen,
  parseRecommendation,
  recommendationFrom,
  _internal
};
