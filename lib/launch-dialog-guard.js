'use strict';

/**
 * Guarded dialogs an engine declares, and whether one is the live screen.
 *
 * An engine can open on a dialog whose default answer has consequences: Codex's
 * update prompt highlights "Update now", and its folder-trust prompt highlights
 * "Trust and continue". A key sent without reading the pane answers whichever
 * is up (#2177). An engine profile therefore DECLARES the prompts it can open
 * on (`launch.guardedDialogs`), and the launch asks this module what the pane
 * shows before it types. TangleClaw answers none of them: a declared prompt is
 * reported for the operator and left alone.
 *
 * This module only reads. It never sends a key.
 *
 * `read`, `declared` and `assess` are now a pure delegation to
 * `lib/startup-dialog.js` (#2221, A483-W1A-RULING): that module is the one
 * place `launch.guardedDialogs` is parsed, validated and classified,
 * converged with Claude's `capabilities.startupDialogs` onto one schema and
 * one classifier, so the two declaration shapes have one reader and one
 * pane-reading algorithm instead of two that could drift. This module keeps
 * none of that logic itself anymore — it exists only so every existing
 * caller of `read`/`declared`/`assess` keeps working unchanged.
 *
 * `assess`'s algorithm (now `startupDialog.assessGuarded`) is itself
 * unchanged by this move — it has no measured evidence or test coverage for
 * anything but Codex's own composer/dialog positioning, and rewriting it
 * without that evidence is exactly the kind of guess this module exists to
 * avoid.
 *
 * @module lib/launch-dialog-guard
 */

/**
 * The guarded dialogs a profile declares, compiled, and how many entries could
 * not be read.
 *
 * A malformed entry is dropped with a warning rather than thrown: a profile
 * that cannot be read must not fail a launch. It is COUNTED, though, because a
 * dropped entry names a prompt the reader can no longer recognise: a caller
 * about to type must treat `unreadable > 0` as a reason not to, or the prompt
 * the profile meant to protect is the one that gets the key.
 *
 * A `guardedDialogs` value that is present but not a list counts as one
 * unreadable entry, for the same reason.
 *
 * @param {object|null} engineProfile - The resolved engine profile.
 * @returns {{prompts: {id: string, re: RegExp, humanAction: string}[], unreadable: number}}
 */
function read(engineProfile) {
  return require('./startup-dialog').guardedDialogs(engineProfile);
}

/**
 * The guarded dialogs a profile declares that could be compiled. For a caller
 * that only reports what it sees; one that is about to type uses `read`, which
 * also says whether any entry was lost.
 *
 * @param {object|null} engineProfile - The resolved engine profile.
 * @returns {{id: string, re: RegExp, humanAction: string}[]} Empty when none is declared or readable.
 */
function declared(engineProfile) {
  return read(engineProfile).prompts;
}

/**
 * What a captured pane is showing, for a launch deciding whether it may type.
 *
 * The live screen is what lies BELOW the last bare composer row. Codex keeps
 * its opening composer drawn above a startup dialog, and keeps an answered
 * dialog in scrollback above the composer that replaced it, so the same text
 * can be on screen in both states: only its position says which one is live.
 *
 * - `prompt`: a declared guarded dialog is the live screen.
 * - `composer`: a bare composer row is, with no declared prompt below it.
 * - `unrecognised`: neither. Nothing here says the pane is safe to type into.
 *
 * @param {string[]} lines - Captured pane lines, top to bottom.
 * @param {{id: string, re: RegExp, humanAction: string}[]} prompts - From `declared`.
 * @param {RegExp|null} promptRe - The engine's bare-composer row pattern, or null when it has none.
 * @returns {{state: 'prompt', prompt: {id: string, humanAction: string}} | {state: 'composer'} | {state: 'unrecognised'}}
 */
function assess(lines, prompts, promptRe) {
  return require('./startup-dialog').assessGuarded(lines, prompts, promptRe);
}

module.exports = { read, declared, assess };
