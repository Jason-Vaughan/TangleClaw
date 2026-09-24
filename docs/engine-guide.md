# Engine Guide

Engines in TangleClaw represent AI coding agents. TangleClaw abstracts engine differences so you can switch between Claude Code, Codex, Aider, or any custom engine without reconfiguring your projects. When a project switches engines, the previous engine's TangleClaw-written config file is marked inactive (a dated notice naming the live engine and its file) rather than left on disk as live canon; hand-written and plugin-owned files are left alone, and switching back regenerates the file (#858).

## How Engines Work

Each engine is a JSON profile that tells TangleClaw:

- How to **detect** if the engine is installed
- How to **launch** the engine in a tmux session
- What **config file** format the engine expects (so TangleClaw can translate project rules)
- What **slash commands** the engine supports (shown as pills in the command bar)
- What **capabilities** the engine has (prime prompt support, co-author format, etc.)

Engine profiles live in `~/.tangleclaw/engines/`. TangleClaw ships with five built-in profiles, copied there on first run.

## Built-in Engines

### Claude Code

- **Command**: `claude`
- **Interaction model**: Session-based (spawns in tmux)
- **Config file**: `CLAUDE.md` (Markdown)
- **Slash commands**: `/compact` (compress context), `/clear` (clear conversation), `/review` (review changes)
- **Capabilities**: Slash commands, prime prompt, config file, co-author

### Codex

- **Command**: `codex`
- **Interaction model**: Session-based
- **Config file**: `.codex.yaml` (YAML)
- **Slash commands**: None
- **Launch modes**: Interactive (default), Full Auto (`--ask-for-approval never --sandbox workspace-write` — no approval prompts, sandbox retained), Bypass (`--dangerously-bypass-approvals-and-sandbox` — no approvals **and no sandbox**, containers/VMs only). Verified against codex-cli 0.145.0. Note this is the one Bypass mode across all engines that also removes the sandbox: Claude's and Antigravity's `--dangerously-skip-permissions` skip approvals only. A bypass posture confirmed on another engine and carried to Codex by an engine switch is therefore wider than the one that was confirmed
- **Capabilities**: Prime prompt, config file, co-author

### Aider

- **Command**: `aider`
- **Interaction model**: Session-based
- **Config file**: `.aider.conf.yml` (YAML)
- **Slash commands**: `/add` (add file to context), `/drop` (remove file), `/undo` (undo last change)
- **Capabilities**: Slash commands, prime prompt, config file, co-author

> **Retired engines:** *Gemini CLI* was removed in #457 — Google [sunset it for individual accounts on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/); Antigravity (below) is the successor. The *genesis* placeholder profile was removed in #458. Retired ids are tombstoned: any stale copy in `~/.tangleclaw/engines/` is deleted on boot.

### Antigravity

[Antigravity CLI](https://antigravity.google/) (`agy`) is Google's successor to Gemini CLI.

- **Command**: `agy`
- **Interaction model**: Session-based (spawns in tmux)
- **Config file**: `AGENTS.md` (Markdown, project root), written as a **managed block** rather than owned outright. Antigravity discovers `GEMINI.md` / `AGENTS.md` only, walking up from the working directory to the repo root — verified 2026-08-31 against `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/rules.md`. `AGENTS.md` is a multi-vendor convention that operators and other tools (`next dev`) also write, so TangleClaw splices only the region between its `BEGIN:tangleclaw` / `END:tangleclaw` markers and leaves the rest untouched.
- **Slash commands**: None
- **Launch modes**: Interactive (default), Sandbox (`--sandbox`), Bypass (`--dangerously-skip-permissions`, containers/VMs only). Antigravity has no Auto-Edit/Plan-Only approval modes (verified against agy v1.0.10)
- **Capabilities**: Prime prompt, config file
- **Status monitoring**: reuses the `google-incidents` adapter with `productName: "Gemini"` — agy fronts Gemini models, and model-serving incidents on the Google status page carry that name

### OpenClaw

[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw) is a self-hosted AI agent platform running in Docker on remote machines. Unlike other engines, OpenClaw connections are registered independently of projects in TangleClaw's connection registry.

- **Command**: `ssh` (SSH mode) or none (Web UI mode)
- **Interaction model**: Session-based (SSH) or iframe-based (Web UI)
- **Config file**: None (OpenClaw manages its own configuration)
- **Slash commands**: None
- **Capabilities**: Remote sessions, two connection modes (SSH terminal, Web UI iframe), automatic SSH tunnel management, sidecar process visibility via ClawBridge

OpenClaw does **not** appear in the project engine dropdown (#459) — assigning a connection as a project's engine never gave a local project an LLM (the agent works in the remote workspace), so it was removed as a picker choice. Registered instances are reached through the dedicated OpenClaw panel in the top bar. The internal engine ID form `openclaw:<connection-id>` still resolves for launch plumbing. See the [OpenClaw Setup Guide](openclaw-setup.md) for connection configuration.

**Connection modes:**
- **SSH mode** — TangleClaw spawns an SSH session in tmux, connecting to the OpenClaw CLI on the remote host. Works like any other tmux-based engine session.
- **Web UI mode** — TangleClaw establishes an SSH tunnel, then loads the OpenClaw Control UI in an iframe via a reverse proxy. No tmux involved — the browser talks directly to the OpenClaw gateway through the tunnel.

## Engine Detection

TangleClaw checks if each engine is available by running `command -v <command>` on the PATH your
login shell reports, not the narrower one the background service inherits. The landing page shows an
availability badge on each engine option:

- **Available** — the binary was found in PATH
- **Not found** — the binary is not in PATH

Detection happens when engines are listed via the API, not at startup.

## Creating a Custom Engine Profile

Create a JSON file at `~/.tangleclaw/engines/<engine-id>.json`:

```json
{
  "id": "my-engine",
  "name": "My Engine",
  "command": "my-engine-cli",
  "interactionModel": "session",
  "configFormat": {
    "filename": null,
    "syntax": null,
    "generator": null
  },
  "coAuthorFormat": "Co-Authored-By: {name} <{email}>",
  "commands": [
    {
      "label": "Help",
      "input": "/help",
      "description": "Show help"
    }
  ],
  "detection": {
    "strategy": "which",
    "target": "my-engine-cli"
  },
  "launch": {
    "shellCommand": "my-engine-cli",
    "args": ["--some-flag"],
    "env": {
      "MY_ENGINE_MODE": "interactive"
    }
  },
  "persistent": null,
  "capabilities": {
    "supportsSlashCommands": true,
    "supportsPrimePrompt": true,
    "supportsConfigFile": true,
    "supportsCoAuthor": true
  }
}
```

The `configFormat` above is set to `null` because config file generation requires a built-in generator. The available generators are `claude-md`, `codex-yaml`, `aider-conf`, `gemini-md` (generic markdown; kept for custom profiles after the Gemini engine's retirement), and `antigravity-md`. If your engine doesn't use a TangleClaw-generated config file, set `filename`, `syntax` and `generator` to `null`. To add a new generator, you'd need to add a handler in `lib/engines.js`.

**A carrier-less engine owes one more field: `configFormat.absentReason`.** With no config file, the project's rule settings and TangleClaw's PortHub, shared-docs and session-memory guides reach no session on that engine — and ADR 0013 (`docs/adr/0013-settings-take-effect-or-say-why-not.md`) requires the surface offering a setting to say when it will not take effect. TangleClaw supplies the first half of that sentence itself ("*Foo* has no config file, so the project rule settings and TangleClaw guides it would carry never reach a session here."); `absentReason` is the engine's own second half, saying *why* there is no carrier. It is rendered verbatim in the settings modal under the Engine dropdown, so write it as one plain sentence addressed to an operator — see `openclaw.json` for the shipped example. Omit it and the notice still appears, just without the explanation; there is no code to change either way.

It is deliberately a separate field from `capabilities.awareness.reason`, which reads similarly and is the obvious candidate to reuse. That one records, for a developer, why an engine has no *awareness* path at all — prime included — while this one is operator-facing and scoped to the *config carrier*. They can also diverge: an engine could gain a context channel while still having no config file. Rendering the awareness note in the settings modal would put a developer's gap record in front of an operator and would tie two facts that are free to move apart.

### Engine Profile Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier |
| `name` | string | yes | Display name |
| `command` | string\|null | yes | CLI command to launch (null for persistent engines) |
| `interactionModel` | string | yes | `"session"` or `"persistent"` |
| `configFormat` | object | yes | Engine-specific config file details: `filename`, `syntax`, `generator`, plus `absentReason` where all three are `null` (see above) |
| `coAuthorFormat` | string\|null | yes | Git co-author pattern (null if unsupported) |
| `commands` | array | yes | Slash commands (shown as pills in command bar) |
| `detection` | object | yes | How to detect if installed |
| `launch` | object\|null | yes | Launch parameters (null for persistent engines) |
| `persistent` | object\|null | yes | Persistent engine config (null for session engines) |
| `capabilities` | object | yes | Feature flags |
| `errorPatterns` | array | no | How to recognise the engine's own API errors in its terminal output — see [Engine API error detection](#engine-api-error-detection-errorpatterns) |

### Config Format

| Field | Description |
|-------|-------------|
| `filename` | Config file name written to project root (e.g., `CLAUDE.md`) |
| `syntax` | File syntax: `"markdown"`, `"yaml"`, `"toml"`, or `null` |
| `generator` | Config generator to use: `"claude-md"`, `"codex-yaml"`, `"aider-conf"`, `"gemini-md"`, `"antigravity-md"`, or `null` |
| `mergeStrategy` | `"whole-file"` (default) — TangleClaw owns the entire file — or `"managed-block"`, where it splices only the region between `BEGIN:tangleclaw` / `END:tangleclaw` and leaves the rest byte-identical. The marker **counts** decide what may be edited, since a marker literal is not proof the marker is TangleClaw's — an operator documenting the mechanism in the file writes both literals in their own prose. Exactly one of each is our region: spliced in place when they are in order, **repaired** into one well-formed block when they are not (the text between them kept below it, stable on every later run, and logged because it moves bytes outside the region). None of either appends a fresh block. Any other count is refused and the file is left byte-identical, including for the engine-switch retire path (`lib/managed-block.js`, shared with the wrap pipeline's priming roll). **Required** for a shared-convention carrier (`AGENTS.md`, `GEMINI.md`, `CONVENTIONS.md`): those are files operators commit and other tools also write, so a whole-file write destroys their content and is **refused at the write**, not merely warned about |
| `discovery` | Evidence for the `filename` claim: `verifiedOn` (ISO date) and `source` (the upstream doc consulted), plus an optional `note`. Required wherever a wrong filename is destructive — a shared-convention carrier or a spliced block. A filename is an **upstream** fact about the engine, and an assertion whose both sides live in this repo cannot detect it drifting |

### Detection Strategies

| Strategy | Target | Description |
|----------|--------|-------------|
| `"which"` | binary name | Run `command -v <target>` to check PATH |
| `"path"` | absolute file path | Check whether that exact path exists |
| `"custom"` | null | No auto-detection (persistent engines) |

Results are cached for 60 seconds and shared by every caller asking about the
same target, so a fleet of projects on one engine costs a single probe rather
than one each. Two outcomes are never cached, because neither is an answer: a
probe killed by its own 2-second cap, and a probe that could not be started at
all (the machine was out of process slots). "Check again" in the setup wizard
drops everything cached, and the paths that *gate* a launch — starting a session,
starting the Project Master — probe fresh every time rather than reading the
cache, so an engine you have just installed is never refused.

### Capabilities

| Flag | Read? | Description |
|------|-------|-------------|
| `supportsSlashCommands` | declared only | Engine has slash command input |
| `supportsPrimePrompt` | **read** | Engine accepts injected prime prompts |
| `supportsConfigFile` | **read** | Engine reads a config file from the project root |
| `supportsCoAuthor` | declared only | Engine supports git co-author attribution (with its `coAuthorFormat` payload) |
| `supportsSilentPrime` | **read** | Engine can receive the prime as hidden context at startup, rather than as typed input |
| `supportsRemote` | declared only | Engine drives a machine other than this one |
| `supportsModes` | declared only | The connection modes an engine offers |
| `startupInjection.maxChars` | **read** | How many characters this engine's startup channel can carry before *it* truncates — see below |
| `toolOutput.maxChars` | **read** | How many characters of a tool result reach this engine's model intact, which is what a launch sequence pages `tc start` output against — see below |
| `launchSequence` | **read** | Whether a session on this engine is served its context as an acknowledged `tc start` sequence — see below |
| `readOnlyModeMarker` | **read** | How this engine's TUI says the session is in a read-only mode, so a wrap refuses instead of timing out — see below |
| `wake` | **read** | The live-probed pane signature that lets TangleClaw tell a busy pane from a resting one on this engine — see below |
| `startupControl` | **read** | The native channel TangleClaw can fire the startup prompt through, with a receipt. Active only when it names a registered adapter — see below |
| `awareness` | declared only | OpenClaw only. Its own `reason` text records why no context carrier can be placed on the remote side — a documented gap rather than an oversight |

**"Declared only" means the flag describes the engine accurately and TangleClaw does nothing with
it.** The distinction is not decoration: a surface that renders declared flags renders promises the
product does not keep, and by looking at the data there is no way to tell the two apart. The read
set is `READ_CAPABILITIES` in `lib/engines.js`, and `test/engine-capability-reads.test.js` holds it
to the code both ways — a listed flag with no reader fails, and a flag that gains one without being
listed fails too. The same guard parses this column and fails when it disagrees with the list, so
wiring a flag makes the suite red until both are updated. Wiring one is a feature decision per
flag, not a cleanup.

#### A capability that gates a per-project setting owes a disposition

When a capability decides whether a setting TangleClaw *offers* has any effect, declaring the flag
is only half the work. ADR 0013 binds: the surface that offers the setting must say — in words, at
the moment it is offered — that it does not apply here and why. Hiding the control is not
compliance, and neither is a log line.

Add a row to `ENGINE_CONDITIONAL_SETTINGS` in `lib/engines.js` giving the gate, the sentence the
operator reads, and the profile fact behind it; `engines.settingDisposition` then answers for every
call site, and derives the log level from whether the stored value was a real choice rather than
leaving each site to pick one. Restate the row in `tcSettingDisposition`
(`public/api-helper.js`) — `public/` runs in a browser and cannot require `lib/` —
and `test/setting-disposition.test.js` will hold the two to the same answer, reason text included.

**A setting with two halves declares a `caveat` instead of an `applies` gate.** Some settings do
part of their job on every engine and the rest only where a capability allows it — the Feature
Index and Project Map toggles maintain their file everywhere, then point a session at it through
the hidden prime. `applies: false` would report a running setting as dead and `applies: true` in
silence is the gap ADR 0013 closes, so the disposition has a third answer: it applies, and here is
the half that does not run. One or the other — a row declaring neither does not belong in the
table, and a row declaring both is not representable in the browser mirror until that table carries
per-row caveat functions. The guard fails either at the table rather than at the operator.

#### `startupInjection.maxChars`

An object, not a boolean: `"startupInjection": { "maxChars": 10000 }`.

This is a fact about the **engine's own harness**, not a TangleClaw preference. Claude Code caps
hook output at 10,000 characters and replaces anything longer with a short preview plus a file path
— which means a prime that exceeds it is not shortened, it is *replaced*, and the session never sees
the directives it carried.

TangleClaw assembles the prime against whatever an engine declares here: bulk sections yield first,
each replaced by a pointer naming what was dropped, and anything still over budget is shipped whole
with a notice rather than cut. **Omit the field and the engine keeps the historical 16,000-character
fallback**, so declaring it for one engine never changes another's behavior.

The limit applies to the startup-hook channel only. When a project runs with `silentPrime` off the
prime is pasted into the terminal instead, and the fallback is used.

**The startup hooks re-fire after `/clear` and compaction (#1761).** On Claude, TangleClaw registers
the prime and rules hooks on `startup|clear|compact`, never `resume` or `fork`, which keep the
transcript. On `clear` or `compact` the prime hook puts a short re-entry preamble ahead of the prime
(`.tangleclaw/session-reentry.md`, written and removed with the prime), so the session reads that
this is not a new launch before the prime's launch instructions. Matching hooks run in parallel, so
the preamble never refers to the rules by position. The rules hook re-emits its shards but posts its
delivery receipt on `startup` only. An engine with no SessionStart source gets the pull path instead:
its generated config tells it to run `tc start review`, provided it can run `tc`.

**Verify the number against the engine's own documentation before declaring it, and record where
and when in a sibling `evidence` block** — `"startupInjection": { "maxChars": 10000, "evidence":
{ "verifiedOn": "YYYY-MM-DD", "source": "…" } }`. The profile guard suite fails any declared
`maxChars` with no evidence: the number is an *upstream* fact, and an assertion with both sides in
this repo stays green forever after the upstream changes. Re-verify if directives start going
missing — a value copied from another engine, or left stale after the harness changes, fails
silently and in the one place nothing else is watching.

#### `toolOutput.maxChars`

An object, not a boolean: `"toolOutput": { "maxChars": 20000 }`.

The startup channel's cap (`startupInjection.maxChars`) and this one are different channels. A
launch sequence is not pushed at startup; it is pulled with `tc start next`, so its pages arrive as
a **tool result**, and what bounds them is how much tool output the engine passes to its model
intact. TangleClaw freezes a sequence's page boundaries against this number at launch, so a page
already served keeps its boundaries even if the declaration later changes.

**Omit the field and the engine gets a conservative 8,000 characters**, and `tc start status` says
so in those words — it prints the page size with either "against this engine's measured N-character
tool-output limit" or "against an ASSUMED N-character tool-output limit", and the sequence's stored
`sourceManifest.toolOutput` carries the same fact for anything reading the record later. That is the honest default for an engine nobody has
measured: more, smaller pages cost an extra round trip, while a page over the real cap can be
silently truncated.

Same evidence rule as `startupInjection.maxChars`, and the same guard enforces it: declare the
number only with a sibling `evidence` block naming where and when it was measured. Measure it by
emitting output of a known size in a live session on that engine and checking what arrives.

#### `launchSequence`

`"launchSequence": { "supported": true }`, or `{ "supported": false, "reason": "…" }`.

Whether TangleClaw serves this engine's sessions their context in acknowledged steps over
`tc start`. **`supported: true` is a declaration of intent and capability, not evidence** — it says
TangleClaw should build a sequence for this engine's sessions, and it commits TangleClaw to serving
one. It does not assert that the context reaches the model.

**`tc` on PATH is necessary and not sufficient.** Whether a served step is actually consumed depends
on the engine's interaction path: the integration has to run `tc` and get its output into the
model's context. An engine that gates command execution behind a confirmation, imports output only
on request, or renders it somewhere the model does not read, can be `supported: true` and still
leave a session stalled mid-sequence. Aider is the worked example — ADR 0017 records it, and
automatic Aider parity is **#1645**. The failure is visible as a sequence that stops advancing, not
as an error.

**An engine that declares nothing is treated as unsupported**, and the reason says so. A launch
without a sequence still gets the pushed prime; `tc start next` in such a pane answers with why
there is nothing to serve, rather than an empty success.

#### What a launch sequence asks of the session (not of the engine)

Declaring `launchSequence.supported` is the whole of the engine's obligation. Everything below is
what the **session running in the pane** does, and it matters to an engine implementer for one
reason: if the model driving your engine cannot follow it, sessions on your engine will stall at a
refusal rather than fail loudly. The full architectural rationale is ADR 0017.

Four subverbs, and the product ships no others (`lib/tc-verbs.js#START_SUBVERBS`):

| Subverb | What it does | Notable refusals |
|---|---|---|
| `tc start next` | Serves the next unacknowledged step, or a named page of it (`--page <n>`). Acknowledge with `--ack <step>:<revision>:<digest>`, from the footer of the last page | `PAGES_UNSERVED` (a page of this step was never served), `ACK_OUT_OF_ORDER`, `ACK_DIGEST_MISMATCH`, `SNAPSHOT_REVISED` |
| `tc start ready` | Attests that the whole sequence was read. Requires `--verdict` and `--first-action`; `--reconciliation` when the launch demands one | see the two stages below |
| `tc start status` | Reports the launch's own state — steps acknowledged, recovery, page size and whether the size is measured or assumed, and which handoff publication (id and digest) the launch's Resume was drawn from, to set beside the one the previous wrap's result named (#1675). Read-only | **Launch resolution refuses `status` too** — `BAD_LAUNCH_ID`, `LAUNCH_NOT_BOUND`, `SEQUENCE_SESSION_MISMATCH`, `SESSION_ENDED`. What it does *not* refuse is a **missing** launch id: a pane predating this mechanism is answered as legacy rather than refused, which is the read-only exemption `next` and `ready` do not get |
| `tc start review` | Re-reads a page of the launch this session already attested READY (#1761), for when `/clear` or a compaction dropped it mid-session. `--step <n\|id>` (a number from 1 or a step id; the first step when omitted) and `--page <n>` (from 0). It serves the **frozen** attested snapshot, never live rules, under a banner saying this is not a new launch, and each page's footer names the next one. Read-only: nothing is marked served or acknowledged, and the cursor, revision and READY are unchanged. It covers a session that has an applicable, bound launch sequence and can run `tc`, not every engine | `NOT_READY` (not attested yet: `tc start next` still serves it), `UNKNOWN_STEP`, `PAGE_OUT_OF_RANGE`, and a **missing** launch id is refused `LAUNCH_ID_REQUIRED`, as `next` refuses it |

**"Notable refusals" is not the whole list.** Every row is reachable by the launch-resolution
refusals in stage 1 below, so the column names what is characteristic of each subverb rather than
what is exhaustive for it.

**`--verdict` is the point of the attestation, not a formality.** It must equal the preflight verdict
the session's own state step stated. The refusal (`READY_VERDICT_MISMATCH`) deliberately does **not**
echo the correct verdict back, because handing it over would let a retry pass without the session
ever having read the step.

**How READY refuses, in the order it actually runs.** Two stages, and the distinction matters when
you are debugging a stuck pane: the outer stage decides whether there is an attestable sequence and
artifact at all, and only then does the inner ladder judge *this* attestation.

*Outer — resolution and record (`ready()`), before any of the content is judged:*

1. **Launch resolution**, in this order: `LAUNCH_ID_REQUIRED` in a pane with no
   `TANGLECLAW_LAUNCH_ID` (a read-only `status` is answered as legacy instead); then
   `BAD_LAUNCH_ID` (400) when the id is not one TangleClaw minted, which is a malformed input rather
   than a timing problem and so is checked before any lookup; then `LAUNCH_NOT_BOUND` while the bind
   transaction has not landed, retried automatically for 10 s; then `SEQUENCE_SESSION_MISMATCH` and
   `SESSION_ENDED` when the bound session is not the active one asking.
2. `SEQUENCE_NOT_APPLICABLE` — this session has no sequence to attest, and the reason says why.
3. `BAD_READY` (400, not 409) — the artifact is not a `tc.ready/1` object. Checked *before* the
   already-attested answer, because a malformed artifact is malformed either way and answering it
   with a conflict would claim it merely differed from the stored one.
4. **Already attested** — an identical artifact replays idempotently (a lost response is safe to
   re-run); a *different* one is `READY_CONFLICT` and the attestation on record stands unchanged.
5. `SNAPSHOT_REVISED` — the project's rules changed while this launch was initializing, so steps
   were re-rendered; re-read them and attest with a reconciliation.

*Inner — validating this attestation (`_validateReady`), once an un-attested applicable sequence and
a well-formed artifact exist:*

6. `SNAPSHOT_REVISED` — the artifact names a revision this sequence has moved past.
7. `READY_VERDICT_MISMATCH` — as above.
8. `RECOVERY_UNCLEARED` — the project's handoff state needs recovering and this project clears in
   `operator` mode. **This precedes the unacknowledged-steps check on purpose**: in `operator` mode
   the task step is withheld, so the cursor can never reach the end, and answering "steps unacked"
   would send the session back to acknowledge a step nothing will ever serve it. It also precedes the
   reconciliation check, because no text can stand in for a person's clear.
9. `STEPS_UNACKED` — steps remain.
10. `RECONCILIATION_REQUIRED` — this launch needs a written reconciliation of at least 40 characters
    (a snapshot revision, or drift between the handoff's rules and the live ones).

**Recovery has two modes, per project** (`launchSequence.recoveryMode`, and see
`docs/configuration-reference.md`). In `operator` — the shipped default — the task step is withheld
and only a person clears it, from the project's Launch readiness panel. In `advisory` the task step
is served behind a warning and the session clears its own recovery by attesting with a written
reconciliation, recorded as `agent-reconciled`. An unrecognised value reads as `operator`, so a typo
can never be why a damaged handoff went unnoticed.

**The handoff preflight is what produces that verdict.** At launch TangleClaw reads the handoff the
previous session published and returns an ordered verdict — `ok` only for a current, eligible
publication from the newest session, and otherwise a *named* problem (`crash-recovery`,
`handoff-behind`, `legacy-unclean`, `workspace-unavailable`, `unclassified`, and the rest). A
preflight that could not run returns `PREFLIGHT_NOT_EVALUATED` and requires recovery; it never reads
as permission to proceed (#1650). An engine does nothing here — this is listed so that an
implementer seeing `RECOVERY_UNCLEARED` in a fresh pane knows it is about the *project's* prior
state, not about their engine.

**Nothing here blocks a pane.** A launch with no sequence — an unsupported engine, a pane that
predates the mechanism, a sequence that could not be created — still starts and still gets the pushed
prime. `tc start next` in such a pane says why there is nothing to serve rather than returning an
empty success, and mutating subverbs answer `LAUNCH_ID_REQUIRED` where `TANGLECLAW_LAUNCH_ID` is
absent.

**READY authorizes nothing.** It records that the context arrived and was read. It is an attestation
by a local process in a local pane, so it carries no authentication meaning, and it leaves every
operator confirmation rule exactly where it was.

#### `readOnlyModeMarker`

Optional. An engine whose TUI has a read-only mode — Claude Code's plan mode — declares how to
recognise it:

```json
"readOnlyModeMarker": {
  "modeLine": "(shift+tab to cycle)",
  "marker": "plan mode on (shift+tab to cycle)",
  "label": "plan mode",
  "exit": "shift+tab",
  "evidence": { "verifiedOn": "YYYY-MM-DD", "source": "…" }
}
```

A wrap's content steps have to **edit files**. In a read-only mode the engine answers with a plan
and waits on an approval that never comes, so before `ai-content` sends anything it samples the
pane: a present marker fails the step in under a second with `status: 'needs-operator'` and the
exit instruction, instead of polling for five minutes and reporting `blocked` (#429).

The two string fields answer two different questions and both are required:

- **`modeLine`** *locates* the line. It must match the pane in **every** mode, not just the
  read-only one — otherwise a writable session and an unreadable pane are indistinguishable.
- **`marker`** *decides*. It is the mode line plus the words that make it read-only. A marker
  equal to `modeLine` would refuse every wrap.

Locating by signature rather than by position is load-bearing: subagent rows render *below* the
mode line, so it is not the last line of the pane and a fixed slice off the bottom loses it as
soon as enough agents are running — which is exactly when a plan-mode session is doing work.

`label` names the mode in operator-facing copy; `exit` says how to leave it (both optional, with
neutral fallbacks). **Declare `evidence` with the date and how it was measured** — this is a claim
about another product's UI, and the same reasoning as `startupInjection.maxChars` applies: an
assertion with both sides in this repo stays green forever after upstream changes its footer. The
shipped Claude value was probed on a live pane, not recalled.

**Omit the field entirely and nothing is measured** — the step proceeds exactly as it did before
the check existed, and the step record says which engine declared no marker rather than implying a
clean pane. A field that is present but missing `marker` or `modeLine` is a profile defect: it is
treated as absent and logged at warn.

#### `wake`

Optional, and the gate on everything TangleClaw does by *reading* an engine's pane: the idle-gated
Medusa wake nudge, the session chime, the prime-paste readiness gate, and the launch kickoff that
asks a silently primed session to read its own context (#1635). An engine that has been captured
live declares its signature:

```json
"wake": {
  "busyMarker": "esc to interrupt",
  "promptPattern": "^\\s*❯[\\u00a0 ]?$",
  "promptGlyph": "❯",
  "promptPad": "\u00a0",
  "placeholderSgr": [2],
  "idleMarker": null,
  "evidence": {
    "busyMarker": { "verifiedOn": "YYYY-MM-DD", "source": "…" },
    "promptPattern": { "verifiedOn": "YYYY-MM-DD", "source": "…" },
    "promptGlyph": { "verifiedOn": "YYYY-MM-DD", "source": "…" },
    "promptPad": { "verifiedOn": "YYYY-MM-DD", "source": "…" },
    "placeholderSgr": { "verifiedOn": "YYYY-MM-DD", "source": "…" },
    "idleMarker": { "verifiedOn": "YYYY-MM-DD", "source": "…" }
  }
}
```

Copy that block as it stands: its `evidence` map covers exactly the fields it declares, which is
what the read guard requires, and `promptPad` is the JSON escape for the NBSP a real profile
carries — one character, not the six characters a pasted `\u00a0` would give you. Add
`pasteRejectedMarker` (and its `evidence` entry) only if you have measured this engine discarding
a submission.

`decorativePattern` (and its `evidence` entry) only if the engine draws something that MOVES while the
session is at rest. codex paints an animated braille shimmer across and above its composer, which made the
pane digest change on every tick — the monitor read it as still writing and never nudged it, permanently.
Both idle gates test the pattern against ONE cell at a time: the transcript digest blanks each matching cell
to a single space (never deletes it or collapses a run, either of which would shorten the line and
reintroduce the instability), and the composer scan skips matching cells. It is refused unless it matches
decoration ONLY: a pattern matching the empty string, any printable ASCII character, or any of a sample of
common non-ASCII letters (accented Latin, Greek, Cyrillic, CJK, kana, Hangul, Arabic, Hebrew, Devanagari) is
rejected, because that is what an operator types. The check tests the pattern against those characters
rather than reading its source, so `\S` and `[a-z]` are caught as surely as `.`. The non-ASCII sample is
not all of Unicode: a range covering a script outside it would pass, so keep the range to the decoration. Getting this wrong would silently disable both idle gates and let a nudge land on the operator's
own half-written text, so the engine stays unprofiled instead.
Anything it matches stops counting as operator input for that engine, so declare the narrowest range that
covers the decoration and nothing else.

| Field | What it is |
|-------|------------|
| `busyMarker` | Substring present iff a turn is in flight; its presence blocks a nudge |
| `promptPattern` | Regex **source** for a BARE prompt line — compiled once when the profile is read |
| `promptGlyph` | The composer's glyph, used to *locate* the composer line |
| `promptPad` | The separator the prompt itself draws before the first input column, or `null` when it has never been measured |
| `placeholderSgr` | SGR attributes this engine renders text the operator did **not** type in |
| `idleMarker` | A POSITIVE at-rest signal, or `null` when nothing was found that is present at rest and absent mid-turn |
| `pasteRejectedMarker` | Optional — see below |
| `decorativePattern` | Optional — a regex source matching cells the engine ANIMATES at rest (decoration the operator did not type). Declare it only where you have watched an idle pane and seen it move |

Every field except `pasteRejectedMarker` and `decorativePattern` is **required**, `null` included. An author who has not
measured a value writes `null` and says so in `evidence`, which is a recorded gap; an omitted field
would be the same gap with nobody able to tell it from an oversight.

**`evidence` is keyed by field, and must cover the declared fields in both directions.** Provenance
per key rather than per block is what keeps antigravity's measured `busyMarker` and its
deliberately-unmeasured `promptPad` from flattening into one claim. A per-field wrapper
(`"busyMarker": { "value": "…", "evidence": {…} }`) would make omission structurally impossible,
and was rejected for it: every value would stop being plain, so every reader in `lib/sessions.js`
and every test would be rewritten to unwrap one — and it would diverge from the `evidence` sibling
`startupInjection` and `readOnlyModeMarker` already use. The both-directions check buys the same
guarantee at the cost of a guard rather than a schema. A field with no entry, or an
entry for a field that no longer exists, is a profile defect. `verifiedOn` is an ISO date, or `null`
for a value nobody has measured — which is a different thing from a value measured and found absent
(Claude's `idleMarker` carries a date, because the absence itself was measured).

**Omit the whole block and the engine is never typed into by any of them** — skipped and logged
once per consumer, never woken or kicked off against a guessed idle signature. For the launch
kickoff that means a silently primed session on an unprofiled engine falls back to exactly the
behavior it had before #1635: nothing types into its pane until the unready monitor's window
elapses. Degraded and recorded (`unprofiled-engine`), never guessed at. A block that is present but malformed is
**the same answer**: refused at the read, logged, and the engine stays unprofiled rather than
half-loaded into the gate that decides whether to type into a live pane. Declaring badly and
declaring nothing deliberately agree, so the settings control below can never offer a switch the
monitor will refuse. The refusal happens at the read and not only in this repo's tests because an
operator profile in `~/.tangleclaw/engines/` never passes through them.

**A hand-added `wake` block takes effect at the next restart.** Most of a profile is re-read on
every request, but the wake table is built once per process and memoised — it compiles a regex per
engine and is consulted on every monitor tick and every dashboard poll. So a profile you drop in
while TangleClaw is running shows up in the engine list immediately and is not nudged until you
restart. The bundled profiles are unaffected: `store.init()` syncs them before anything reads the
table.

The settings modal's **Auto-wake on inbound messages** control is gated on this block (ADR 0013):
an engine that declares none renders the control inert with the reason, rather than offering a
switch that does nothing.

#### The wake nudge and the engine's own channel

For Codex, the wake nudge asks the engine, not the pane (#1628). The pane's at-rest marker is a
rendering. Codex draws `Ready` in a status row whose segments, order and width are the operator's own
configuration, so a layout that clipped or omitted it held mail for hours. And because the pane gate
matches the whole tail, a transcript that merely *quotes* `· Ready ·` read as at rest. The wake
therefore asks the engine's own protocol, through the startupControl facade, for every engine whose
profile names an adapter that can observe it (`declaresObserver`; today, Codex):

- It asks only for a live, opted-in session with unread mail, with at most one read in flight per
  session, channel and launch. The answer used is one an earlier tick fetched. It is keyed to that exact
  session, channel and launch, and used only while it is younger than two monitor intervals. A late
  answer after the channel was replaced or the session left the scan is discarded, and nothing is
  ever typed from the read's callback.
- `idle` goes on to the pane gate, where it excuses the at-rest marker and nothing else. The busy
  marker, the fleet block, a dialog, a draft in the composer and a transcript that is still moving all
  still hold, because the protocol cannot see the TUI's composer.
- `busy` holds as `engine-thread-busy`, whatever the pane shows.
- With a channel present, anything unproven (not asked yet, stale, failed, `unknown`) holds as
  `engine-thread-unknown`. It never falls back to the pane.
- With **no** channel (a session launched before channels existed, or whose server did not start or
  has closed), the nudge holds as `engine-channel-absent`. Relaunching restores wakes.
- A Project Master on such an engine holds as `master-engine-unobserved`. The Master has no project
  launch and never gets a channel, so a relaunch does not change it.
- The adapter's own reason (`version-mismatch`, `thread-ambiguous`, …) is logged whenever it changes.
  The ledger and the peer route carry only the bounded wake code.

Every other engine skips all of this and never has a channel looked up, so its pane gate is exactly as before. The launch-time readiness gate is unchanged.
It must not create a thread or spend a turn to obtain wake evidence.

#### The ambient-awareness floor (`tc` on PATH)

Independent of any config file or prime, every tmux session TangleClaw launches gets the `tc` CLI
on its `PATH` plus `TANGLECLAW_API` / `TANGLECLAW_PROJECT_ID`, `TANGLECLAW_LAUNCH_ID` (which
launch this pane is: `tc start` finds its sequence by it, and shared-docs requests send it as the
caller's binding), and `TANGLECLAW_WORKSPACE_ID` when the switchboard minted one, in the pane
environment. The Project Master's pane carries `TANGLECLAW_ROLE=master` instead of a project id,
and a launch id that serves only as its shared-docs binding: it has no launch sequence, so its
`tc start` says so. The verbs come from a declared roster — read the list from
`lib/tc-verbs.js#VERB_ROSTER`, or run `tc` with no arguments, rather than from a copy here that
ages every time a verb is added. Each answers honestly (an empty inbox or idle fleet says so in
words; a disabled capability states its reason), and the server records each invocation as a
verb-labeled **awareness receipt**, so a session that never discovered the floor is a detectable
state. This is engine-neutral by construction: a new engine needs no adapter for `tc` to be
*present*. Whether its model actually reaches the floor is the same distinction the
`launchSequence` section draws — the engine still has to run `tc` and get the output into model
context, and an engine that gates or defers that can have the whole floor and never use it.
Engine-profile `launch.env` overrides any of these keys on collision.

#### Prime paste readiness

When a project runs with `silentPrime` off (or the engine has no silent channel), the prime is
pasted into the TUI. That paste is **readiness-gated** for engines whose `capabilities.wake` block
declares a positive at-rest `idleMarker` (antigravity: `? for shortcuts`): the paste waits until
the marker renders over a transcript that has stopped moving, instead of firing on a fixed timer —
a fixed delay racing an engine boot is how a 41-second antigravity boot swallowed the prime for 12
days with a clean ledger.

Engines without a positive marker cannot be gated and **must declare an explicit
`launch.startupDelay`** (the guard suite fails a paste-path profile with neither), and their blind
paste is recorded in the delivery ledger as `unverified`, never `delivered` — `delivered` is
reserved for a paste whose pane was observed ready.

#### `wake.pasteRejectedMarker`

Optional, and since #1134 the pane being observed ready is **no longer the last word**. An engine
that has been measured *discarding* a submission declares the text it prints when it does, inside
its `wake` block:

```json
"pasteRejectedMarker": "Please try again shortly"
```

Antigravity 1.1.22 renders the complete at-rest UI — bare `>` and `? for shortcuts` — while it is
still verifying an account, and drops whatever is submitted. Both readiness signals pass, so the
gate alone cannot tell that state from a ready one. After a paste, the pane is watched for this
marker; when it appears the delivery row is `unverified` with that reason **even though the gate
was satisfied**, and the prime is re-pasted once (bounded, and only after checking the pane is not
mid-turn).

It only ever **downgrades**. A watch that saw no rejection, or could not read the pane, leaves the
pre-existing verdict exactly as it was — so a swallow the engine does not announce is still missed,
and nothing here can invent a delivery or a retry. That asymmetry is deliberate: a false retry
pastes a whole prime into a session that already has one.

**Do not infer this marker from another engine, and date what you measured.** Watching for the
prime to *arrive* instead was tried and abandoned: a generated prime runs to hundreds of lines, so
once it echoes it is not in a pane tail at all, and the check fires on every healthy launch.
Omit the field and the engine is not watched, which is the honest default.

#### `startupControl`

Declares that TangleClaw can hand this engine its **startup prompt** through the engine's own
native, persistent, interactive channel, and get back a receipt that the engine accepted and
applied it (#1825). Pasting bytes into a terminal pane is not such a channel.

```json
"startupControl": {
  "adapter": "<registered adapter name>",
  "channel": "what the native channel is",
  "readiness": "the channel's own ready signal",
  "receipt": "what the engine reports on accept and on apply",
  "blockers": "how auth, quota, approval and trust prompts are reported",
  "verifiedVersions": ["<engine CLI version>"],
  "evidence": {
    "adapter": { "verifiedOn": "YYYY-MM-DD", "source": "where this was verified" }
  }
}
```

Every declared field needs an `evidence` entry, and `evidence` may name no other field, the same
rule as `wake`. An unknown field, or a malformed block, resolves to **unsupported**.

**A profile names an adapter, and never supplies one.** The adapter is code, registered in
`ADAPTERS` in `lib/startup-control.js`. A profile whose `adapter` is not registered resolves to
unsupported, so editing a profile can describe a channel but cannot grant one.

**Supported also needs a verified version.** Right after a TangleClaw boot, until the adapter's
asynchronous version probe answers, a fire resolves `unsupported (version_unverified)` and spends its
idempotency key on that answer; a launch refreshes the probe synchronously first, so a session
launched after the boot never sees this. The adapter reports the installed engine version
through `installedVersion()`, which answers synchronously from a value it probed and cached
earlier. Capability resolution never spawns a process. A version not listed in
`verifiedVersions`, or no version at all, resolves to unsupported (`version_unverified`), never
guessed at. `tc capabilities` and the fire path read this one decision, so they cannot disagree.
An engine profile that cannot be read resolves to unsupported (`engine_profile_unreadable`),
instead of failing the request that asked.

**The Codex adapter** (`lib/startup-control-codex.js`, verified on codex-cli 0.156.1) is the one
registered adapter. Every other engine resolves to unsupported, `tc capabilities` says so as
`startup-control`, and firing the startup prompt at one returns a typed `STARTUP_CONTROL_UNSUPPORTED`
refusal. There is no fallback, and nothing is typed into a pane. The prompt itself, and who may read,
edit and fire it, are covered in the [User guide](user-guide.md) under "Startup Prompt".

**What a Codex launch does differently.** When the Codex profile resolves as supported for the exact
executable the launch will run, TangleClaw starts one `codex app-server` per launch on a local unix
socket under its own state directory, detached in its own process group so a TangleClaw restart does
not sever it, and launches the pane's TUI with `--remote unix://<socket>` ahead of the already
validated launch-mode arguments (the TUI applies `--ask-for-approval` and `--sandbox` in remote mode).
The channel is recorded in `startup_control_channels`: a generic header (session, launch, engine,
adapter, lifecycle) plus a bounded `adapterState` only the Codex adapter reads. A launch whose
app-server cannot be started or probed launches today's command unchanged and records
`channel_unavailable`. The channel ends with the session: kill, a wrap that ends the session, a
detected crash, or a relaunch over a dead pane; a keep-running wrap keeps it. At boot TangleClaw
revalidates every open channel of a live session, recovers in-flight fires without resending, and
closes channels whose session has ended. Before signalling a process it checks the command line,
the socket and the recorded birth time, so a reused pid is never killed; the teardown's result is
recorded on the row.

**What a supported launch does at boot (#1825 B3).** When the channel started AND the launch has a
`tc start` sequence to read, the launch selects the **native** startup path and records it on its
sequence row (`launch_sequences.startup_delivery = 'native'`, frozen in the transaction that binds the
sequence, so a restart cannot turn it back into a keystroke path). On that path TangleClaw types
nothing into the pane, ever: the prime paste and the kickoff line are withheld, and the unready
monitor stamps the window but sends no nudge. Instead, once the pane's own readiness gate has seen the
engine's at-rest marker over a settled transcript, the operator's **startup prompt** is fired once
through the channel by the same service the dashboard and the API use, under the internal `launch`
caller (`launch-automatic` clearance, attributed to the launch's own project) and the deterministic
key `launch-<sequence>-r<revision>`. The engine's receipt on that fire row is what says the prompt
arrived. If the pane never renders ready within the launch window, the attempt is still recorded and
settled `blocked (pane_not_ready)` without the adapter ever being asked — a fact about the pane as
TangleClaw observed it, not a claim about the engine. If the adapter's own pre-send check blocks
(`trust_required`, `auth_required`, …), that is recorded the same way. There is no paste fallback and
no automatic retry: the launch panel names the reason and the operator may **Fire** once it clears.
Every other launch keeps today's path (`legacy`) and records, through the same service, why it could
not go native — `unsupported` with the capability's reason (`engine_declares_none` for an engine that
declares no channel, `version_unverified`, …) or `blocked (channel_unavailable)` for a supported engine
whose server did not start. The app-server also inherits the pane's ambient environment (`tc` on PATH,
`TANGLECLAW_PROJECT_ID`, `TANGLECLAW_API`, `TANGLECLAW_WORKSPACE_ID`, `TANGLECLAW_LAUNCH_ID`), on the
understanding that with `--remote` the agent loop and its shell tools run in the server, so the
`tc start next` the fired prompt asks for is expected to resolve to the same identity the pane's
would. That is an assumption until the first live Codex launch after this shipped confirms it
(`VRF-1825-b3-native-bootstrap`); if it proves false, the pane still has the identity and the fix
belongs in how the server is started, not in the bootstrap. Codex's engine-level `preKeys` are
withheld on a native launch too: a preKey is a keystroke, and two Enters on a fresh trust dialog
would accept its default before readiness could refuse `trust_required`.

**Readiness is read from the protocol, never from the pane.** Before a send the adapter needs all of:
the app-server's `initialize` version equal to the installed and the recorded one; `config/read`
naming the project directory as trusted (Codex shows its folder-trust dialog otherwise, and it is
never typed through); `account/read` naming an account; `account/rateLimits/read` explicitly allowing
usage or reporting a usable credit balance; exactly one loaded thread whose canonical cwd is the
project directory (the recorded one once seen); and that thread `idle`. An unknown answer fails
closed as `readiness_unknown`; a blocker is `trust_required`, `auth_required`, `quota_exhausted`,
`version_mismatch` or `engine_not_ready`, with nothing sent and the launch's fire slot released.

**The receipt.** The fire is `turn/start` carrying the launch-start payload digest as
`clientUserMessageId`. On codex-cli 0.156.1 a fresh thread cannot be subscribed to or listed before
its first user message, so the send materializes the thread and TangleClaw then subscribes
(`thread/resume`, which that version can still refuse) and reads the turn back (`thread/turns/list`),
re-reading the record every few seconds while the turn runs so its end is never missed. The fire is
**accepted** when the
engine's record of that turn carries a user message whose `clientId` is the digest AND whose text
hashes to the prompt's text digest (from the notification or the read-back). It is **applied** on
`turn/completed {completed}` for that turn, only after accepted evidence; `failed` and
`interrupted` follow the turn. `waitingOnApproval` and `waitingOnUserInput` keep the fire accepted
under `approval_pending` and `user_input_pending`; TangleClaw never answers either. A socket lost
before the answer is `indeterminate (send_unconfirmed)` and is never resent; one lost after
acceptance is reconnected and settled from the engine's record, or left `indeterminate
(channel_lost)`. An indeterminate fire is settled by a reconcile that reads every page of the exact
thread on the reachable channel: a turn carrying the digest settles it to that turn's state; the
payload absent on every page while the thread stays idle across a pause settles it to `failed`;
anything less leaves it indeterminate.

**The adapter contract** (what `ADAPTERS` entries implement): `installedVersion()` (synchronous,
cached, never spawns); `probeVersionSync({enginePath})` (the launch path only); `prepareLaunch({project,
engineProfile, launchCmd, enginePath, env})` returning `{ok, handle, command}` or `{ok: false, reasonCode,
reason}` (`env` is the pane's environment, which the server must inherit); `attachLaunch(handle, {sessionId, sequenceId, engineId})`; `abandonLaunch(handle, reason)`;
`releaseSession(sessionId, reason)`; `reap()`; `recover()`; `start()`/`stop()`;
`fire({session, project, sequenceId, promptText, promptTextDigest, payloadDigest, onUpdate})`
returning `{accepted, settled}` promises; and `reconcile({session, fire, onUpdate})`. Every
transition an adapter reports goes through the store's transition map, so no adapter can move a fire
backwards or out of a terminal outcome.

**Optionally, `observeActivity(channel, project)`** (#1628): a read-only answer to "is this session's
engine working right now?", returning `{state: 'idle'|'busy'|'unknown', reasonCode}`. Callers never
reach an adapter directly. They go through `startupControl.observeActivity({session, project, channel,
sequence})`, which answers `{channel: 'absent'|'present', state, reasonCode}`. **Absent** means the
session has no open channel. **Present** covers everything else, and there `unknown` is returned for
any of these: a channel that is not this active session's, or not of its current launch, engine or
project; an unregistered adapter or one without the method; a throw; an out-of-vocabulary answer. In
all of those cases the adapter is either never asked or not believed. `startupControl.declaresObserver(engineId,
getProfile)` says whether an engine's profile names an adapter that can observe it, independent of the
version probe. It is an observation, never permission: it checks no trust, account or quota, and `idle`
does not authorize a fire.

The Codex adapter reads it from the protocol alone and opens no turn. It speaks only for the launch's
own app-server process (command, socket and birth time) on the installed and recorded version, and only
for exactly one thread. Any second loaded thread whose canonical cwd is the project directory makes it
`unknown`, because a thread started from the TUI would leave the recorded one idle while the other
works. A channel whose thread was never recorded (its startup fire was blocked or never ran) has it
bound here, to the **sole** loaded project thread. The bind is TangleClaw's own metadata, written
compare-and-set (`startupControlChannels.updateAdapterStateIf`), so it never replaces a recorded
thread. The bind that lands first wins, and a lost race answers `unknown`. After a bind, "the only
one" is established again from a fresh read. Given all that, the thread's `active` status is busy (an
approval wait included) and `idle` is idle. Before an `idle` is returned, the channel row is read
again: it must still be open, on the same launch, with the same thread.

## Config File Generation

When a session launches, TangleClaw generates the engine-specific config file in the project root. This file is built from:

- Core rules (CHANGELOG updates, JSDoc, testing, session wrap protocol, PortHub registration)
- Extension rules (identity sentry, docs parity, decision framework, etc.)
- PortHub guide (port management API reference, when PortHub registration is enabled)

All engines with `supportsConfigFile: true` receive the same rule content, translated into each engine's native format:

| Engine | Config File | How Rules Are Included |
|--------|------------|----------------------|
| Claude Code | `CLAUDE.md` | Markdown sections with bullet-point rules, full PortHub guide |
| Codex | `.codex.yaml` | `instructions:` multiline YAML field containing markdown-formatted rules and PortHub guide |
| Aider | `.aider.conf.yml` | YAML comments with rules and PortHub reference, plus functional config settings |
| Antigravity | `AGENTS.md` | Markdown sections (same format as CLAUDE.md), spliced into the project root file as a **managed block** — TangleClaw owns only the region between its `BEGIN:tangleclaw` / `END:tangleclaw` markers |

This translation is automatic — rules are written once, and TangleClaw handles the format conversion. A parity test suite verifies that all engines receive core rules and PortHub references.

**Plugin-governed projects get an operational block, not the full file.** When a project's dev-time
governance is owned by the Prawduct V2 plugin (`isPluginGoverned`), the plugin owns `CLAUDE.md`'s
governance content, so TangleClaw does not regenerate the file — it splices a **managed block**
(same `BEGIN:tangleclaw` / `END:tangleclaw` mechanism as `AGENTS.md`) carrying only operational
content: where to read the API base URL, the service-token *pointer* (never the inline token — a
governed `CLAUDE.md` is a committed file), the Medusa switchboard section, and the PortHub /
shared-docs / session-memory guides. Since #1619 none of that content is checkout-specific: the
block names no project and no origin, and the session resolves both at run time from
`TANGLECLAW_API` and `tc whoami`, so every checkout of a repository generates the same bytes — from
the point each one regenerates. A carrier committed before the fix keeps whatever it was given until
then; this repo's own was migrated on the #1619 branch, and the wrap's ownership judge now refuses to
stage a block that still carries identity rather than committing it unasked. Sections whose source is absent (no shared-docs group, no PortHub registration) are omitted
entirely rather than emitted empty, so "the same bytes" means for checkouts with the same
configuration. The
same rule now covers the whole-file `CLAUDE.md` path and the shared-convention carriers, because
those are committed too — `.gitignore:85` is explicit that `CLAUDE.md` is tracked. Rules tiers (core, extension, global) stay out of the block: governance is
the plugin's side of the line, and per-project session rules ride the prime (#595). Governed
projects on a non-`claude-md` carrier keep the full skip — writing a file TC has never owned on
those projects is a separate decision.

## Parity Checklist for New Engines

Every engine with `supportsConfigFile: true` **must** pass parity validation. Use `engines.validateParity()` programmatically or run the parity test suite (`node --test test/engines.test.js`).

When adding a new engine, verify that its generated config includes all of the following:

- [ ] **`tc` bootstrap line** — the unconditional instruction naming the `tc` CLI (single source: `lib/ecosystem-primer.js#tcBootstrapLines`, `md` or `comment` form). The family test in `test/engines.test.js` ("tc bootstrap line rides every carrier") fails any config-supporting engine that omits it — PATH presence alone creates no discovery intent, so every channel the engine reads must carry the line
- [ ] **Core rules** — all five default rules: CHANGELOG updates, JSDoc comments, unit tests, session wrap protocol, PortHub registration
- [ ] **Extension rules** — active extension rules (identitySentry, docsParity, decisionFramework, etc.) translated into the engine's format
- [ ] **PortHub guide or reference** — full Port Management guide (for markdown-based engines) or API reference comment (for YAML-based engines)
- [ ] **Global rules** — content from `data/global-rules.md` (the git-tracked canonical source, #240) injected into the config
- [ ] **Generator switch case** — a `case` entry in `generateConfig()` for the new generator name
- [ ] **Profile `configFormat.generator`** — must exactly match the switch case string
- [ ] **`_getRulesContent()` used** — the generator function must call `_getRulesContent()` to get the canonical rule set (do not duplicate rule logic)
- [ ] **Status page config** — set `statusPage` in the engine profile JSON to the upstream status API config (adapter, url, component info), or `null` if the engine has no known status page

### How to add a new engine generator

1. Create the engine profile JSON in `data/engines/<id>.json` with `supportsConfigFile: true` and a unique `configFormat.generator` value
2. Add a generator function `_generate<Format>()` in `lib/engines.js` that calls `_getRulesContent()` and translates rules into the engine's native format
3. Add the corresponding `case` in the `generateConfig()` switch statement
4. Run `engines.validateParity()` — it must return `{ valid: true }`
5. Run `engines.validateStatusParity()` — it must return `{ valid: true }` (ensures `statusPage` field is present)
6. Add engine-specific tests in `test/engines.test.js`

## Switching Engines

You can change a project's engine at any time from the project settings on the landing page or the session settings modal. The change takes effect on the next session launch — TangleClaw regenerates the config file in the new engine's format.

No data is lost when switching engines. Session history and learnings are engine-independent.

The previous engine's config file does not stay behind as live canon (#858): if TangleClaw wrote it — a managed block between the `tangleclaw` markers, or a whole file carrying the generated header — it is marked with a dated inactive notice naming the live engine and its file. A hand-written file, and a plugin-owned `CLAUDE.md`, are left alone and the reason is logged. Switching back regenerates the file.

## Model Status Monitoring

TangleClaw monitors the upstream service status for engines with known status pages. The engine badge on project cards reflects real-time operational status:

- **Green left border** — Operational
- **Amber left border** — Degraded performance
- **Orange left border** — Partial outage
- **Red left border** — Major outage
- **Muted left border** — Unknown (no status page or fetch failed)

Status is polled every 2 minutes from official status pages. Hover over the engine badge for details.

### Supported status sources

| Engine | Status Page | Adapter |
|--------|------------|---------|
| Claude Code | status.claude.com | Atlassian Statuspage |
| Codex | status.openai.com | Atlassian Statuspage |
| Antigravity | status.cloud.google.com | Google Incidents |
| Aider | None (upstream-dependent) | — |

### Engine profile `statusPage` field

Each engine profile includes a `statusPage` field (object or `null`):

```json
"statusPage": {
  "adapter": "atlassian",
  "url": "https://status.example.com/api/v2/summary.json",
  "componentId": "abc123",
  "componentName": "My Service"
}
```

- **`adapter`** — Parser type: `"atlassian"` (Atlassian Statuspage) or `"google-incidents"` (Google Cloud)
- **`url`** — JSON API endpoint to poll
- **`componentId`** / **`componentName`** — For Atlassian: identifies the specific component to monitor
- **`productName`** — For Google: product name to filter incidents by

Set to `null` for engines without a known upstream status page.

## Engine API error detection (`errorPatterns`)

A status page says whether the provider is up. It does not say that *this session's* calls are failing — Codex under the wrong auth mode answers every prompt with `{"type":"error","status":400,"error":{"type":"invalid_request_error",…}}` as gray terminal text while the status page stays green and the project card looks healthy. `errorPatterns` closes that gap: an engine profile declares how its API errors look in its own output, and TangleClaw watches for them.

```json
"errorPatterns": [
  { "regex": "\\{\"type\":\"error\"", "parser": "codex-json" }
]
```

- **`regex`** — a JavaScript regular expression, as a string, that selects a pane line worth parsing. Prefer an unanchored shape: a TUI gutter, indent or wrap prefix ahead of the JSON would otherwise defeat an anchored one silently. It must compile, and it may not nest a quantifier inside a quantified group (`(a+)+`, `(a*)*`, …) — the pattern runs against every captured row of every live session on the server's event loop, so `validateProfile` rejects the catastrophic-backtracking shape with the reason. Rows are capped at 2000 characters before any pattern sees them.
- **`parser`** — the **name** of a parsing strategy TangleClaw ships (`lib/engine-errors.js#PARSERS`), never code. A name the module does not know is rejected. Parsers today: `codex-json` — the structured `{"type":"error","status":<4xx|5xx>,"error":{"type","code","message"}}` object Codex echoes for a failed API call; a long line tmux wrapped across several rows is reassembled before parsing.

The field is optional. Bundled: Codex declares the pattern above; the other engines declare none until a shape is known for them.

**What the operator sees.** The wrap sentinel's existing per-tick read of every live pane (every few seconds) is the capture; there is no second loop. A match records `lastEngineError = { type, status, message, timestamp }` on the session, which reaches `GET /api/sessions/:project/status` and the project's `session` object in `GET /api/projects`. The session page shows a banner above the terminal naming the status, the error type and the provider's message; the project card on the dashboard carries a red `⚠ HTTP <status>` badge with the same detail in its tooltip.

**When it clears — stated honestly.** TangleClaw cannot see an API call succeed; it sees the pane's captured tail. The error is reported for as long as a matching line is inside that tail, and clears the first time a capture no longer contains one — which is what the next successful prompt looks like from outside: the engine produced enough new output to push the error line off the captured rows. An error still on screen stays reported even after the operator has fixed the cause, until the terminal moves past it; a repeated error re-arms with a fresh timestamp once the previous one has scrolled away. A capture that came back empty — tmux failed or timed out — is no reading at all and changes nothing, so a flaky tmux cannot flash the card healthy for a tick and re-stamp the same error as new. Detection applies to tmux sessions; a Web UI (gateway) session has no pane to read.
