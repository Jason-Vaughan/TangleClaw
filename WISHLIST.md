# TangleClaw Wishlist

Deferred features and ideas for future versions.

## TOP PRIORITY

### BUG: Android Session Wrapper Scroll (Pixel Fold 9)
- **Symptom**: On Android Chrome (Pixel Fold 9, folded and unfolded), the session wrapper banner is not locked. Scrolling up moves the banner with the content and stops after ~3 lines. Content appears attached to the banner.
- **Expected**: Banner stays fixed at top (like desktop), terminal content scrolls freely underneath.
- **Layout**: `body { height: 100dvh; flex column; overflow: hidden }` → `.banner { sticky }` → `.terminal-frame iframe { flex: 1 }`
- **Failed fixes**: `position: fixed` body + absolute positioning (tiny window), `touch-action: none` on iframe, `position: absolute` layout — all broke layout worse or had no effect.
- **NOT**: a tmux issue (history-limit 50K, mouse on), NOT a ttyd issue (scrollback 10K set), NOT an iOS issue (works on iPhone Safari)
- **Required approach**: Chrome DevTools remote debugging on the Pixel. No more blind CSS hacks.
- **Affects**: All terminal scrolling on Android — core mobile experience is broken on Android devices.

---

## Session Management
- **Context window %** — Show Claude's context usage per session (requires Claude Code API/output parsing)
- **Session recording** — Record and replay terminal sessions (asciinema-style)
- **Shared clipboard** — Copy/paste between iPhone and tmux sessions via the landing page

## Multi-Host
- **SSH tunneling** — Manage sessions on remote hosts via SSH
- **Multi-host dashboard** — Single landing page for multiple dev machines
- **Linux/Windows support** — Abstract macOS-specific system stats (`vm_stat`, `sysctl`) behind platform modules

## Notifications
- **ntfy.sh push notifications** — Send alerts when sessions go idle, finish tasks, or error out
- **Per-session notification rules** — Configurable triggers (idle > 5m, output contains "error", etc.)
- **iOS Shortcuts integration** — Trigger actions from Siri/Shortcuts

## UI/UX
- **Themes** — Light mode, high contrast, custom color schemes
- **Project groups/tags** — Organize projects into categories (work, personal, experiments)
- **Template library** — Community/user-contributed project templates with git clone support
- **Drag-to-reorder** — Custom project sort order
- **Search/filter** — Filter projects by name, status, or git branch
- **Peek drawer/modal** — Replace `alert()` for peek output with a proper slide-up drawer or modal (currently uses browser alert)
- **Context window usage** — Show AI engine's context consumption per session (parsing output or API if available)
- **Engine command helper dropdown** — Context-aware dropdown in the session wrapper (next to Cmd bar) that shows available shortcuts/modes for the active AI engine. Examples:
  - Claude Code: `/plan`, `/review`, `/compact`, model switches (`/opus`, `/sonnet`, `/haiku`), etc.
  - Codex: equivalent mode triggers
  - Aider: `/ask`, `/architect`, `/map`, etc.
  - Populated from engine adapter config — each engine declares its available commands, descriptions, and categories (modes, tools, navigation)
  - One-tap to inject the command into the terminal via sendKeys
  - Could group by category: "Modes", "Model", "Tools", "Info"
  - Updates dynamically if engine adapters are added or engines gain new features
  - Should include mode toggles like "Full Auto" (e.g., Claude Code's `--dangerously-skip-permissions`), troubleshooting mode, plan mode — not just slash commands but stateful mode switches
  - **Toggleable** — the helper itself can be shown/hidden per user preference (settings toggle). Power users can dismiss it, newcomers or multi-engine users keep it visible. Persisted per-project in localStorage.

## Extensibility & Personalization
TangleClaw should be easily wrangle-able — every user works differently, uses different AI models, and has different workflows. The system should make it simple to add, configure, and swap components without needing terminal access.

### AI Model / Engine Management (UI-driven)
- **Add new AI engines from the UI** — Settings panel to register new AI models/engines beyond the defaults. Provide: name, launch command, slash commands, capabilities, config file format.
- **Engine profiles** — Each engine entry defines: display name, command to launch, available modes/commands (for the helper dropdown), config file conventions (CLAUDE.md vs .codex.yaml vs .aider.conf.yml), co-author format (for suppression feature).
- **Per-project engine selection** — Already exists in config (`projectEngines`) but needs a UI dropdown on project cards or in settings. "This project uses Codex" — one tap.
- **Default engine** — Set globally, override per-project. Currently in config.json, needs UI.
- **Engine discovery** — Auto-detect installed engines (check PATH for `claude`, `codex`, `aider`, etc.) and offer to register them.

### Template Management (UI-driven)
- **Add templates from the UI** — Upload a template folder (zip or tar), or provide a git URL to clone into `templates/`. Currently requires dropping files via terminal.
- **Template browser** — UI to view installed templates, see their `template.json` manifest, preview files, edit settings.
- **Remove/disable templates** — Toggle templates on/off without deleting them.
- **Template import from git** — `git clone <url>` directly into `templates/` from the UI. Supports community/shared templates.
- **Template editor** — In-browser editing of `template.json` and template files for power users who want to customize without SSH.

### User Workflow Customization
- **Custom quick commands** — Already exists in config, but needs UI to add/remove/reorder without editing JSON.
- **Per-project settings** — Override global defaults at the project level (engine, mode, terms, quick commands) from the project card or session wrapper.
- **Import/export config** — Export your full TangleClaw setup (engines, templates, quick commands, terms) as a shareable config bundle. Import on another machine to replicate your workflow.
- **Onboarding flow** — First-run wizard: "Which AI engines do you use? What's your projects directory? Any templates to import?" Gets new users productive without reading docs.


- **Formalize template spec for methodologies** — Expand `template.json` beyond file scaffolding to support full workflow methodologies (like Prawduct). Two template types: `"scaffold"` (files only) and `"methodology"` (workflow + conventions + AI instructions).
- **Generic status contract** — Replace hardcoded `getPrawductPhase()` with a generic `status` command in `template.json` that returns `{ badge, color, detail }`. TangleClaw renders whatever the methodology returns without interpreting it.
- **Methodology detection** — `detect` field in `template.json` (e.g., `".prawduct/project-state.yaml"`) so TangleClaw can identify which methodology an existing project uses.
- **Custom actions** — Methodologies declare actions (e.g., "Next Phase", "Run Retrospective") that show as buttons on project cards or session wrapper. Just `{ label, command }` pairs.
- **Engine-aware methodologies** — Templates declare a `defaults` block and optional `engines` overrides per AI engine (Claude, Codex, Aider). Each engine may need different AI instruction files, hooks, or init commands.
- **Engine adapter layer (Option B)** — TangleClaw abstracts engine differences so methodology authors write once. Methodology declares *what* it wants (instructions, hooks, phases), TangleClaw knows *how* to deliver to each engine (CLAUDE.md vs .codex.yaml vs .aider.conf.yml).
- **Community template library** — Standardized format enables a public repo of downloadable methodology templates. Install by dropping a folder into `templates/` or via a fetch/clone command.

## Session Modes (Methodology-Level)
Modes define *how* the AI assistant works within a session — distinct from project templates which define *what* you're building.

### Troubleshooting Mode
A structured, step-by-step debugging methodology with mandatory evidence collection:
- **Logging setup first** — Before any fix attempts, enable relevant logging (app logs, network, console, etc.)
- **One step at a time** — Make a single change, test, capture evidence (logs, screenshots, terminal output), then report back before proceeding
- **Evidence capture** — Each step produces artifacts: log snippets, screenshots, peek output, diff of changes. Stored per-session for review.
- **Mandatory unit test per fix** — Every bug fix MUST include a regression test before moving on. No fix is complete without a test that would catch the regression if it returns.
- **Regression prevention** — Motivated by 130K+ line codebases where the same bug gets re-introduced multiple times. The test is the contract that says "this is fixed, forever."
- **Step report** — After each step, AI reports: what was changed, what was observed, whether it worked, what's next

### Fully Automated Testing Mode
AI-driven end-to-end validation without human intervention:
- **Browser automation** — AI uses a browser (headless or instrumented) to test web apps interactively — click, navigate, fill forms, verify UI state
- **Automated parameter testing** — Systematically test features across different inputs, screen sizes, configurations
- **Interactive step-by-step** — Similar to scenario/critic testing but executed automatically, with the AI walking through each step and validating outcomes
- **Auto-generate unit tests** — Each validated behavior gets a corresponding unit test written automatically
- **Report generation** — Produces a structured report of what was tested, what passed, what failed, with evidence

#### Mode System Design (Future)
- Modes could be declared in `template.json` or selected per-session in the settings modal
- A session can have one active mode at a time (or "normal" for no special mode)
- Modes inject rules/constraints into the AI's working context (via CLAUDE.md, prime prompt, or engine-specific config)
- Modes are engine-agnostic — the rules apply regardless of whether you're using Claude, Codex, Aider, etc.

## Agent Terms & Acknowledgment (OpenClaw Genesis)
A preflight contract system where AI agents must explicitly acknowledge project rules before working.

- **Project-level terms** — Each project defines a `terms.md` or `terms` block in `template.json` with rules of engagement (testing requirements, git policies, destructive action limits, style conventions, etc.)
- **Mandatory acknowledgment gate** — Before an AI agent starts work, it must read the terms, parse them, and produce a structured acknowledgment confirming understanding of each rule
- **Signed receipt / audit log** — Each acknowledgment is logged: agent identity, engine name + version, terms version hash, timestamp, summary of what was agreed to
- **Enforcement** — TangleClaw can refuse to inject the prime prompt or start a session until terms are acknowledged. Violations of signed terms are flagged in the audit log.
- **Layered terms** — Base project terms + mode-specific addenda (e.g., troubleshooting mode adds "must write regression test per fix"). Terms stack, they don't replace.
- **Multi-agent awareness** — When multiple engines/agents touch the same project, each signs independently. Audit trail shows who agreed to what and when.
- **Terms versioning** — Terms have a version. If terms change, agents must re-acknowledge before continuing work.
- **Part of OpenClaw Genesis** — This system is a component of the larger OpenClaw Genesis project framework, which will entangle deeply with TangleClaw's methodology and session management.

## Git & Attribution
- **Suppress AI co-author credits** — Settings toggle to strip AI-generated co-author lines (e.g., "Co-Authored-By: Claude...") from git commits and other outputs. Should be engine-agnostic — works across Claude Code, Codex, Aider, or any future engine.
- **Custom commit signature** — Settings option to inject a custom stamp/signature into git commits and updates. User-defined branding instead of (or alongside) the AI credits.

## Developer Experience
- **Plugin system** — Custom widgets on cards (e.g., test status, CI badge)
- **Webhook integrations** — POST to external services on session events
- **REST API auth** — Optional API key for non-VPN deployments
- **Config UI** — Edit `~/.tangleclaw/config.json` from the browser
