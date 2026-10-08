'use strict';

/**
 * Where the cursor sat, and the styled row it sat on, for each pane in
 * `_codex-startup-fixtures.js`. Read off the same live samples as those panes
 * (codex-cli 0.156.1, private tmux server, 2026-10-07), the way
 * `tmux.cursorInfo` reads them: column, row, and that one row with its escape
 * sequences kept. A dialog leaves the cursor on its footer row, not on the
 * composer drawn above it, which is what a pane witness relies on (#2186).
 *
 * @type {Readonly<Record<string, {x: number, y: number, line: string}>>}
 */
const CODEX_STARTUP_CURSORS = Object.freeze({
  trustPrompt: Object.freeze({ x: 27, y: 10, line: "  \u001b[1menter\u001b[0;2m continue · \u001b[0;1mesc\u001b[0;2m quit\u001b[0m" }),
  updatePrompt: Object.freeze({ x: 27, y: 8, line: "  \u001b[1menter\u001b[0;2m continue · \u001b[0;1mesc\u001b[0;2m skip\u001b[0m" }),
  openingScreen: Object.freeze({ x: 2, y: 8, line: "\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m" }),
  composerAfterUpdateSkipped: Object.freeze({ x: 2, y: 24, line: "\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m" }),
  composer: Object.freeze({ x: 2, y: 10, line: "\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m" })
});

module.exports = { CODEX_STARTUP_CURSORS };
