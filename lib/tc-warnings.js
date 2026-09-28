'use strict';

/**
 * Keep one known-benign Node warning out of `tc`'s stderr (#1836).
 *
 * Under Codex's loopback network profile the engine routes the pane's HTTP
 * through its own proxy and sets `NODE_USE_ENV_PROXY=1`, and Node then warns
 * on every `tc` call that its environment proxy agent is experimental. An
 * agent reads `tc`'s output to decide what happened, and a warning line it
 * did not ask about is noise it may act on. Only that warning's code is
 * dropped; every other warning still prints, so a new one is never hidden.
 *
 * Node raises this warning while it bootstraps, before any of `tc` runs, so
 * wrapping `process.emitWarning` is too late. What is not too late is the
 * printing: a warning reaches its listeners on a later tick, and the line on
 * stderr is written by the listener Node installed at startup. Wrapping the
 * listeners present at `tc`'s first line catches it.
 */

/** Node's code for "EnvHttpProxyAgent is experimental". */
const SUPPRESSED_CODES = Object.freeze(['UNDICI-EHPA']);

/**
 * Replace every `warning` listener on `proc` with one that skips the
 * suppressed codes and hands everything else to the original listener.
 * Idempotent: a listener already wrapped here is left alone.
 * @param {NodeJS.EventEmitter} [proc=process] - The process to install on (a test seam).
 * @returns {void}
 */
function suppressBenignWarnings(proc = process) {
  for (const listener of proc.listeners('warning')) {
    if (listener.tcFiltered) continue;
    const filtered = (warning) => {
      if (warning && SUPPRESSED_CODES.includes(warning.code)) return;
      listener(warning);
    };
    filtered.tcFiltered = true;
    proc.removeListener('warning', listener);
    proc.on('warning', filtered);
  }
}

module.exports = { SUPPRESSED_CODES, suppressBenignWarnings };
