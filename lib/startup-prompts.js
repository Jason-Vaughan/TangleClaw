'use strict';

/**
 * Startup prompts an engine declares, and whether one is the live screen.
 *
 * An engine can open on a dialog whose default answer has consequences: Codex's
 * update prompt highlights "Update now", and its folder-trust prompt highlights
 * "Trust and continue". A key sent without reading the pane answers whichever
 * is up (#2177). An engine profile therefore DECLARES the prompts it can open
 * on (`launch.startupPrompts`), and the launch asks this module what the pane
 * shows before it types. TangleClaw answers none of them: a declared prompt is
 * reported for the operator and left alone.
 *
 * This module only reads. It never sends a key.
 *
 * @module lib/startup-prompts
 */

const { createLogger } = require('./logger');

const log = createLogger('startup-prompts');

/** Strips ANSI control sequences, so a styled row matches like a plain one. */
const _ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * The startup prompts a profile declares, compiled.
 *
 * A malformed entry is dropped with a warning rather than thrown: a profile
 * that cannot be read must not fail a launch. Dropping one never makes a launch
 * type more, because an undeclared screen is still not a recognised composer.
 *
 * @param {object|null} engineProfile - The resolved engine profile.
 * @returns {{id: string, re: RegExp, humanAction: string}[]} Empty when none is declared.
 */
function declared(engineProfile) {
  const list = engineProfile && engineProfile.launch && engineProfile.launch.startupPrompts;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.match !== 'string' || !entry.match) {
      log.warn('Ignoring a startup prompt with no id or match', { engine: engineProfile.id || null });
      continue;
    }
    let re;
    try {
      re = new RegExp(entry.match);
    } catch (err) {
      log.warn('Ignoring a startup prompt whose match is not a valid pattern', { engine: engineProfile.id || null, prompt: entry.id, error: err.message });
      continue;
    }
    out.push({ id: entry.id, re, humanAction: typeof entry.humanAction === 'string' ? entry.humanAction : '' });
  }
  return out;
}

/**
 * What a captured pane is showing, for a launch deciding whether it may type.
 *
 * The live screen is what lies BELOW the last bare composer row. Codex keeps
 * its opening composer drawn above a startup dialog, and keeps an answered
 * dialog in scrollback above the composer that replaced it, so the same text
 * can be on screen in both states: only its position says which one is live.
 *
 * - `prompt`: a declared startup prompt is the live screen.
 * - `composer`: a bare composer row is, with no declared prompt below it.
 * - `unrecognised`: neither. Nothing here says the pane is safe to type into.
 *
 * @param {string[]} lines - Captured pane lines, top to bottom.
 * @param {{id: string, re: RegExp, humanAction: string}[]} prompts - From `declared`.
 * @param {RegExp|null} promptRe - The engine's bare-composer row pattern, or null when it has none.
 * @returns {{state: 'prompt', prompt: {id: string, humanAction: string}} | {state: 'composer'} | {state: 'unrecognised'}}
 */
function assess(lines, prompts, promptRe) {
  const rows = (lines || []).map((l) => String(l).replace(_ANSI_RE, ''));
  let composerAt = -1;
  if (promptRe) {
    rows.forEach((row, i) => { if (promptRe.test(row)) composerAt = i; });
  }
  const live = rows.slice(composerAt + 1).join('\n');
  for (const prompt of prompts || []) {
    if (prompt.re.test(live)) return { state: 'prompt', prompt: { id: prompt.id, humanAction: prompt.humanAction } };
  }
  return composerAt >= 0 ? { state: 'composer' } : { state: 'unrecognised' };
}

module.exports = { declared, assess };
