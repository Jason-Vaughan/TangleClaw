'use strict';

/**
 * Whole pane captures of Codex's startup screens, for tests that decide
 * whether a launch may type (#2177).
 *
 * Every pane is a live capture of codex-cli 0.156.1 on a private tmux server
 * with a throwaway home, taken 2026-10-07 the way `tmux.capturePane` reads a
 * pane (the visible screen plus 15 lines of history). Nothing is trimmed: the
 * rows above a dialog are what make it hard to read, so a capture cut down to
 * the dialog would test a pane no launch ever sees. Trailing blank rows and
 * trailing spaces are the only things removed.
 *
 * @type {Readonly<Record<string, {command: string, lines: string[]}>>}
 */
const CODEX_STARTUP_PANES = Object.freeze({
  // The opening screen: `model: loading` and an empty composer, before any prompt.
  openingScreen: Object.freeze({
    command: "codex --no-daemon",
    lines: Object.freeze([
      "╭───────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.156.1)            │",
      "│                                       │",
      "│ model:     loading   /model to change │",
      "│ directory: /private/tmp/b4cs-gKx6QN   │",
      "╰───────────────────────────────────────╯",
      "",
      "",
      "› Ask Codex to do anything"
    ])
  }),
  // The folder-trust prompt, drawn below the opening composer row, which stays on screen.
  trustPrompt: Object.freeze({
    command: "codex --no-daemon",
    lines: Object.freeze([
      "╭───────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.156.1)            │",
      "│                                       │",
      "│ model:     loading   /model to change │",
      "│ directory: /private/tmp/b4cs-gKx6QN   │",
      "╰───────────────────────────────────────╯",
      "",
      "",
      "› Ask Codex to do anything",
      "",
      "",
      "",
      "  Folder access",
      "  /private/tmp/b4cs-gKx6QN",
      "",
      "  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a",
      "  model request. Continue only if you trust these files. Your trust decision will be saved.",
      "",
      "› 1. Trust and continue",
      "  2. Quit",
      "",
      "  enter continue · esc quit"
    ])
  }),
  // The update prompt, drawn below the opening composer row.
  updatePrompt: Object.freeze({
    command: "codex --no-daemon",
    lines: Object.freeze([
      "╭───────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.156.1)            │",
      "│                                       │",
      "│ model:     loading   /model to change │",
      "│ directory: /private/tmp/b4cs-dU5sq5   │",
      "╰───────────────────────────────────────╯",
      "",
      "",
      "› Ask Codex to do anything",
      "",
      "",
      "",
      "  Update available · 0.156.1 → 0.161.0",
      "  Release notes: https://github.com/openai/codex/releases/latest",
      "",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "",
      "  enter continue · esc skip"
    ])
  }),
  // A usable composer after the update prompt was skipped with Escape. The answered prompt stays in scrollback above it.
  composerAfterUpdateSkipped: Object.freeze({
    command: "codex --remote",
    lines: Object.freeze([
      "",
      "",
      "› Ask Codex to do anything",
      "",
      "",
      "",
      "  Update available · 0.156.1 → 0.161.0",
      "  Release notes: https://github.com/openai/codex/releases/latest",
      "",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "",
      "  enter continue · esc skip",
      "",
      "╭─────────────────────────────────────────────────╮",
      "│ ✨ Update available! 0.156.1 -> 0.161.0         │",
      "│ Run npm install -g @openai/codex to update.     │",
      "│                                                 │",
      "│ See full release notes:                         │",
      "│ https://github.com/openai/codex/releases/latest │",
      "╰─────────────────────────────────────────────────╯",
      "",
      "╭───────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.156.1)                │",
      "│                                           │",
      "│ model:     GPT-6-Astra   /model to change │",
      "│ directory: /private/tmp/b4cs-bBT6Y6       │",
      "╰───────────────────────────────────────────╯",
      "",
      "  To get started, describe a task or try one of these commands:",
      "",
      "  /init - create an AGENTS.md file with instructions for Codex",
      "  /status - show current session configuration",
      "  /permissions - choose what Codex is allowed to do",
      "  /model - choose what model and reasoning effort to use",
      "  /review - review any changes and find issues",
      "",
      "",
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /private/tmp/b4cs-bBT6Y6"
    ])
  }),
  // A usable composer in a trusted folder. The superseded `model: loading` header is still in the captured history.
  composer: Object.freeze({
    command: "codex --remote",
    lines: Object.freeze([
      "╭───────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.156.1)            │",
      "│                                       │",
      "│ model:     loading   /model to change │",
      "│ directory: /private/tmp/b4cs-8d6DW4   │",
      "╰───────────────────────────────────────╯",
      "",
      "",
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /private/tmp/b4cs-8d6DW4",
      "",
      "╭───────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.156.1)                │",
      "│                                           │",
      "│ model:     GPT-6-Astra   /model to change │",
      "│ directory: /private/tmp/b4cs-8d6DW4       │",
      "╰───────────────────────────────────────────╯",
      "",
      "  Tip: New Build faster with the Desktop app. Run 'codex app' or visit https://chatgpt.com/codex?app-landing-page=true",
      "",
      "",
      "› Ask Codex to do anything",
      "",
      "  GPT-6-Astra default · /private/tmp/b4cs-8d6DW4"
    ])
  })
});

module.exports = { CODEX_STARTUP_PANES };
