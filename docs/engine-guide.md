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
- **Capabilities**: Slash commands, prime prompt, config file, co-author, private socket root (`privateTempRoot`)

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
| `models` | object | no | Which models the engine may be launched with — see [Model selection](#model-selection-models). Absent means the engine offers no model selection |

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
| `startupDialogs` | **read** | The screens this engine can draw before its prompt, which a launch must see, leave untyped, and name as the session's blocker — see below |
| `wake` | **read** | The live-probed pane signature that lets TangleClaw tell a busy pane from a resting one on this engine — see below |
| `startupControl` | **read** | The native channel TangleClaw can fire the startup prompt through, with a receipt. Active only when it names a registered adapter — see below |
| `privateTempRoot` | **read** | The variable, socket suffix and byte cap TangleClaw uses to hand the engine a private socket root instead of a shared `/tmp` — see below |
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
with a notice rather than cut.

**The cap covers everything the hook prints, not the prime alone (#1888).** Claude's prime hook also
prints the UI wrap advisory after the prime and, on a `clear` or `compact` fire, the re-entry
preamble before it. Each has its own separator. The prime is therefore fitted to the cap minus all
of that in its worst case, the `clear` fire, including any provenance line (ADR 0019).
`lib/prime-hook-output.js` owns the companion text and the framing, and computes the reserve.
`test/prime-hook-output.test.js` runs the real hook script against it, so the two cannot drift.

**Omit the field and the engine keeps the historical 16,000-character
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
`docs/configuration-reference.md`). In `operator` the task step is withheld
and only a person clears it, from the project's Launch readiness panel. In `advisory` the task step
is served behind a warning and the session clears its own recovery by attesting with a written
reconciliation, recorded as `agent-reconciled`. **Which one is the default depends on the install**
(ADR 0017 R3): a project nobody decided for runs `advisory` while TangleClaw's login is in force, where
a signed-in operator can read the reconciliation back, and `operator` everywhere else. A project's
first launch under the advisory default prints a one-time notice above its task step. An unrecognised value reads as `operator`, so a typo
can never be why a damaged handoff went unnoticed. While the task step is withheld, the step itself, the READY refusal,
the unready nudge and `tc start status` all carry one sentence saying why the launch is held and what
can be done about it, and stop pointing at `tc start next` and `tc start ready`, which would both
refuse (#1937). What can be done follows the login gate as it stands: a signed-in operator clears it
where the login is in force; on an install with no login the clear from the panel is recorded as
unverified; and where the login is stood down or otherwise unavailable the sentence says the launch
cannot be cleared until that is resolved. The mode is the operator's choice (ADR 0017 R3a): a
session that names it in `PATCH /api/projects/:name` is refused `403 OPERATOR_ONLY`. The operator's
decision is recorded in the server store with the proof it was taken on (`decidedBy`:
`operator-verified`, or `open-install-unverified` where the login identified nobody, #2244), and the
store outranks the project's `.tangleclaw/project.json`
(#1937): once the operator has pinned a project to `operator`, no edit to that file loosens it, and a
file that disagrees with the decision on record is reported in the server log at launch, on
`GET /api/launch-sequences` and in `tc start status`. A launch reads the decision once and freezes the
mode it resolves to. If the decision cannot be read, the launch takes `operator`. With no decision on
record the file's value decides.

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

#### `startupDialogs`

Optional. An engine that can draw a screen before its prompt, one a launch must not type into,
declares it:

```json
"startupDialogs": [
  {
    "code": "trust_required",
    "label": "folder trust dialog",
    "markers": ["Yes, I trust this folder", "No, exit"],
    "meaning": "What the operator should do, in a sentence or two.",
    "evidence": { "verifiedOn": "YYYY-MM-DD", "source": "…" }
  }
]
```

Claude Code asks whether to trust a folder the first time it opens a repository, and the option
under its cursor is "No, exit". A line ending in Enter typed into that screen ends the session
(#2128). So a launch on an engine that declares dialogs reads the pane before it types:

- **A declared dialog is up.** Nothing is typed: no pre-key, no prime, no kickoff. The session
  records a blocker under the entry's `code`, served as `launchBlocker` in session status and kept
  on the session after it ends, so a pane that dies at the dialog leaves a `crashed` session that
  says why. The launch keeps reading for 15 minutes; when the operator answers and the prompt
  appears, the blocker is cleared and the launch sends its first turn. In that wait a frame is
  judged as every later look judges it: a prompt that holds still **below** any dialog text is the
  answer, so an answered dialog whose text is still in the pane's history does not strand the
  launch. Before any dialog has been seen the watch is stricter, and takes any dialog text on a
  fresh pane as a dialog on its way.
- **The prompt is up, with no dialog.** The launch types as usual, without waiting out the fixed
  `startupDelay` as well.
- **Neither is recognised within 45 seconds.** The launch proceeds exactly as it did before this
  field existed, except that each send takes one last look at the pane and is withheld if a
  declared dialog is there. An unknown screen must never cost a healthy launch its first turn.

Every later text send TangleClaw makes into the pane is refused with the code while the dialog is
up. The refusal is in `tmux.sendKeys`, where text sends converge, so it covers the command bar, a
wake nudge, a coordinator's command, a wrap's content prompt and the Critic action. What it covers
depends on what the send names. A send that names the session's engine, which a test requires of
every caller in `lib/`, has the pane read against that engine's declared dialogs. A send that
names none cannot be read that way and is refused only while a blocker is already recorded for
the pane's session. A raw key (`tmux.sendRawKey`) is not checked there; the launch guards its own
before each pre-key.

The rule is that a send goes ahead only on positive evidence, or when nothing stands against it.
One function states it (`withholdFor` in `lib/startup-dialog.js`) and both the injection path and
the pane writer ask it. Four things withhold a send:

- a declared dialog on the pane;
- a blocker already recorded for the session that the read did not positively clear. The dialog
  behind it may still be up on a pane that could not be checked or read, came back empty, or shows
  neither the dialog nor the prompt, so every send stays withheld until the prompt is seen. The
  same holds if the engine's profile stops declaring the dialog, or no profile is found, while the
  blocker stands: nothing can then confirm the pane clear, and the blocker stays until the session
  ends or the declaration returns;
- a frame that still carries a declared marker with no composer at rest beneath it after one
  re-read. That may be the dialog half-drawn, or another screen that shares one of its option
  texts: Claude Code's Bypass Permissions confirmation shows "No, exit", so it is withheld from
  every sender with either option selected. That send is withheld; no blocker is recorded on a
  suspicion. If the re-read itself cannot see the pane, the first frame's marker goes on
  withholding. One case is let through for a later injection: marker text **above** a composer
  that is positively located and holds typed text (the cursor shown on that row, between the
  composer's two border rows). That is a transcript quoting the dialog above an operator's draft,
  and the injection keeps and clears the draft as usual. It is still not a clear reading, so it
  releases no recorded blocker and a launch's own sends are still withheld from it;
- for a **launch's own sends only** (pre-keys, the prime, the kickoff): a pane whose last row led
  by the prompt glyph is not the engine's composer at rest, with no blocker recorded and no
  live declared marker on screen. That row is the selected option of a menu no profile declares, or
  text already typed at the prompt; the two cannot be told apart by their text. The refusal is
  `pane_not_at_prompt` and names no dialog. A later injection is **not** refused on this reading
  alone: it keeps an operator's draft and then clears it, which is also how a stranded nudge is
  recovered. So a menu nobody declared that appears mid-session, with no blocker recorded, is
  still typed into by a later injection, as it was before this field existed (#2219).

A screen with no dialog text and no row led by the prompt glyph at all withholds nothing, for a
launch too: an unrecognised screen must not cost a healthy launch its first turn.

**What counts as positive evidence** is the engine's **composer at rest**, as the **last** row led
by the prompt glyph, **below** any dialog text on screen (or anywhere, when there is none). A row
led by the prompt glyph is not that by itself: a selector draws its selected option with the same
glyph, so `❯ 2. Yes, I accept` is not a prompt. Two readings of that last row count:

- **bare**: it matches the `wake` block's measured `promptPattern` (the glyph and at most its pad),
  and the row directly beneath it is not text (an option whose label wrapped below its glyph);
- **empty, showing the engine's suggestion**: a fresh Claude Code composer reads
  `❯ Try "how does <filepath> work?"`, which is not bare and cannot be told from typed text by
  what it says. It counts only when the terminal cursor is on that row, the cursor is **shown**
  (tmux's `cursor_flag`, read in the same query as its position), the cursor's own styled row reads
  as an empty composer (the cursor at the first input column, everything to its right in the
  `placeholderSgr` styling), **and** the row sits between two border rows, the composer's box.
  Without a cursor reading, without the flag, without the styling, or without the box, only the
  bare reading applies. One failed cursor read therefore costs a launch its first turn when the
  composer is showing a suggestion: the send is withheld as `pane_not_at_prompt` and not retried.

Only the last glyph-led row is judged, and all the evidence must be about that row. A composer
left on screen above a menu or a dialog drawn later is not evidence; a menu or a dialog left in
the history above a fresh composer is history. A composer holding typed text is never positive
evidence. While a launch watches a boot, two clear readings count as "held still" only if that
row, its neighbours and the cursor did not change between them.

Measured on Claude Code 2.1.283 (2026-10-07, an empty repository, no turn taken): the fresh
composer sits between two border rows with the cursor shown two columns after the glyph. On the
folder trust dialog, the `/model` selector, the first-run theme picker and the login-method
selector the cursor is hidden and parked on the selected row's glyph, no border adjoins the
selected row, and no option text is drawn faint. The Bypass
Permissions confirmation could not be captured on the measuring host, so it is not declared as a
dialog (#2205); it is withheld by the shared option text, under the trust dialog's name.

**The prompt signature is resolved for the program, like the dialog.** A profile's own measured
`wake` block is used when it has one. A profile without one takes the **whole** `wake` signature
(the composer pattern, the glyph, its pad and the suggestion styling) of the installed profile that
declares the dialogs for the same `command`, which is measured, with evidence. So an operator's
second Claude Code profile with no `wake` block is still watched through its boot and can be
positively cleared. A signature is never guessed, and a glyph with no measured composer pattern is
not one.

**With no measured signature for the profile or its command, nothing can be read as a prompt**, and
TangleClaw says so instead of typing:

- the launch's own sends are withheld (`prompt_unverified` in the delivery ledger and the log),
  because a finished boot cannot be told from a dialog. Start the session by typing in its pane, or
  add a measured `wake` declaration to the profile;
- a dialog is still seen by its markers and recorded as the blocker, but no pane read can clear it.
  Sends to that session stay refused until it ends, and the refusal says why and what to do:
  relaunch after approving the dialog, or add a measured `wake` declaration.

**If the blocker record itself cannot be read** (the store lookup throws), it is not assumed
absent. Only a positive prompt reading lets that send through; a dialog or part of one still
withholds under its own name; anything else is refused as `launch_blocker_unreadable`, which says
the record could not be read and claims no dialog. A lookup that succeeds and finds no session for
the pane is a different fact, and an ordinary send. So is a process with no store open at all.

A dialog whose options have been reworded so that no declared marker matches is not seen at all.
That is a limit of detection, not evidence of safety: the entry's evidence names the version it was
measured on, and the markers are updated when a new wording is captured.

The stored blocker is a claim about the pane that the operator can make untrue at any moment by
answering the dialog. So it is checked against the pane whenever the session's status is read and
before every send. It is cleared only on a positive reading: the engine's composer at rest, below
any dialog text (see "What counts as positive evidence" above). A menu's selected option does not
clear it. A pane that could not be read, a read that came back empty, or a screen showing neither
changes nothing, because "no dialog was matched" is not evidence that it was answered. A session
whose status is read after the operator answers therefore does not have a later, unrelated death
recorded as caused by the dialog. The project list checks a stored blocker against the pane the
same way whenever tmux has confirmed the pane, and a pane tmux could not answer for keeps the
record. While it stands, the project card shows a "needs you" badge and the session page a
banner.

**TangleClaw never answers the dialog.** Accepting a trust prompt lets the folder's own hooks, MCP
servers and permission rules run, which is the operator's decision. It also writes nothing to the
engine's own state files.

A dialog matches only when **every** marker is on screen and **no row led by the prompt glyph sits below its last marker**. One
marker alone can be another dialog's option. The second condition is what tells a dialog from a
session whose transcript is quoting one: the quoting session has its composer underneath. Markers
are matched on text with styling removed, because an engine may colour a dialog word by word.

`code` is lower_snake_case and becomes the blocker's name; `label` and `meaning` are shown to the
operator. An entry missing any of `code`, `label`, `meaning` or a non-empty `markers` list is
never repaired and never matched on, and it is **not** read as a shorter list either. **A
declaration that cannot be read fails closed**: while any entry is unreadable, or `startupDialogs`
is present and is not a list, a launch on that profile types nothing (no pre-key, no prime, no
kickoff), whatever its pane shows. The delivery ledger and the log say
`startup_dialogs_unreadable`, with the profile and the entry. The entry that was lost was written
for a dialog nothing can recognise now, so reading the list as shorter, or as empty, would launch
unwatched into exactly that dialog. This is the same policy as an unreadable `launch.guardedDialogs`
entry (#2177). A profile with no list of its own inherits the refusal with the declaration of its
`command`. **If the installed profiles cannot be read at all** (the store's profile list throws,
or comes back empty), a profile that inherits has lost its declaration: what its program declares
could not be found out, which is not the same as nothing, so its launch types nothing either, under
the same code. In that state **every later sender is refused as well**, not only the launch: the
command bar, a wake nudge, a coordinator's command, a wrap's prompt, the Critic action. No dialog
is known for the engine at all, so there is nothing to read the pane against and no send can be
shown safe; the pane is not read, and nothing is recorded as a blocker. The refusal says it is a
failure to read TangleClaw's installed profiles and not an error in the profile. Sends go through
again at the first send after the profiles read; if it keeps happening, a profile file is
unreadable and needs repair, and the server log names the error. A profile with a list of its own,
`[]` included, does not depend on the list.

**The same every-sender refusal applies whenever nothing of the declaration could be read**, not
only when the lookup failed:

- a profile's **own** `startupDialogs` with no sound entry at all: every entry unreadable, or a
  value that is not a list while its program's dialogs cannot be looked up either. Correct the
  declaration, or set `[]`; sends go through once the corrected profile is read;
- a profile that **inherits** a declaration whose every entry is unreadable. The refusal names the
  profile that holds the bad entry. Correcting that profile is not enough by itself: the
  declarations read for each program are kept for the life of the server, so **restart TangleClaw**
  after the fix;
- the session's **engine profile is not available as a profile**, for a send that names its
  engine: the read fails, nothing comes back, or the file parses to something that is not a
  profile (a number, a string, a list), or it is an object that does not carry the profile's own
  `id`. The refusal says it may be missing, unreadable or malformed, or may not carry its `id`,
  and does not claim which, because the store cannot tell a missing file from one holding `null`.
  Install or restore a valid profile, or repair the file; sends go through at the first send after
  it can be read as that profile.

  **A profile file must carry `"id"` equal to its own profile id** (its file name without
  `.json`; for an OpenClaw session, `openclaw`). **A launch checks this first**: before the
  engine is looked for, a pane is created or a pre-key is scheduled, a profile that is not an
  object or does not carry that `id` refuses the launch (`ENGINE_PROFILE_INVALID`, HTTP 409 on
  the launch route) and nothing is started. **The Project Master is held to the same test**: it
  does not start an engine from such a profile (no engine process, no pane; a Master that is
  already running is left as it is), and such an engine cannot be selected as `master.engine`
  in the settings (400, with the reason). **Nothing about the engine's profile is looked at
  unless a settings change names the engine**: a Master engine already stored whose profile is
  now missing, unreadable or without its `id` does not stop the Master's other settings from
  being saved, and is refused when the Master is next started. Naming such an engine in a
  change is refused. **Saving a lower access level and applying it are separate steps, and
  the second does not need the engine either**: if TangleClaw cannot work out which engine the
  Master runs (any installed profile file that does not parse causes that; so does resolution
  having no answer. The rule: a configured engine id that is not in TangleClaw's engine
  selection list is passed through as itself; otherwise, when no engine in that list is
  available, there is no answer. A profile hidden from selection is not in the list, so
  having a profile file is not the test), a change that lowers access still writes the level file and puts the Claude Code write guard back in the
  Master's home. That binds a Master running Claude Code from its next tool call. It does not
  rewrite the Master's instructions, and a Master on another engine has no write guard, so the
  request answers 500 (`MASTER_LEVEL_NOT_APPLIED`) and says which part holds. A change that
  raises access is not applied while the engine cannot be resolved. **The resolved engine is
  not trusted to say whether a guard is needed**: when the engine set for the Master is in
  the selection list but not detected, and another is, TangleClaw resolves the other one, so every change that lowers
  access writes the Claude Code write guard and reads it back whichever engine was resolved
  (two unused files in the home of a Master on another engine), and a change that raises
  access is refused. It goes through once the configured engine is detected again. Setting
  `master.engine` to the engine TangleClaw resolved also clears the refusal, and is right only
  if that is the engine the running Master actually uses: do not change it to get past the
  refusal. Two things this does not establish, because TangleClaw keeps no record of the
  engine a running Master was started on: when the configured engine is Claude Code, a Master started earlier on a substituted engine
  is reported as guarded once Claude Code is detected again, and when no engine is
  configured at all (neither `master.engine` nor `defaultEngine`) a change that raises access
  is applied on whichever available engine is picked. **A command into the
  Master's pane is refused when its engine cannot be resolved** (`MASTER_ENGINE_UNRESOLVED`):
  the Master has no session record, so without an engine there is nothing to check its pane
  against. That arises when no engine can be resolved for the Master, or in the moment after an
  installed profile file becomes unreadable and before the switchboard next leaves the Master
  out of its nudges. Every profile TangleClaw saves or validates has
  one, and so does every bundled profile. A file dropped into the engines directory by hand
  **without** an `id`, or with another profile's, launched and took sends before this check
  existed; it now cannot be launched, and a session already running on it has every send refused,
  until the `id` is added. On a case-insensitive filesystem the same applies to an engine id
  given in a different case from the profile's own (`Claude` finding `claude.json`): the file is
  found and says it is `claude`, which is not what was asked for. That cost is deliberate: an
  object that does not say which profile it is cannot be trusted to say what its engine shows
  (`{}` is a valid JSON object that declares nothing). **The check is identity only.** It does not
  validate the profile: a file with the right `id` and broken or missing fields is taken as the
  profile, and a declaration it has lost is simply not there. A connection-qualified engine id resolves to its base profile first
  (`openclaw:<connection>` reads the `openclaw` profile), so a healthy OpenClaw session is not
  affected; only a base profile that really cannot be read is refused;
- **the look itself fails**: anything thrown while TangleClaw is working out what the pane shows,
  for a send that names its engine. Nothing is typed on no reading at all. The next send makes the
  look afresh; if it keeps failing, the server log names the error. One installed profile that is
  not an object at all (a file holding `null`, say) is reported as a failed lookup, above, and not
  as a crash.

If a launch blocker is already recorded for the session, the refusal names it as recorded and not
cleared; it does not claim the dialog is on screen, because that is exactly what cannot be told.
A list with at least one sound entry is a different state: its sound entries still read the pane
for later sends, as described above. A send that names no engine, and a process with no store
open, are unchanged. One look, one watch and one
launch each read the declaration **once** (`startupDialog.resolve`), so a fault that comes or goes
in the middle cannot be pieced together into "nothing declared and nothing wrong". Only a literal `[]` declares none. Entries that could be read still protect later
sends. The watch tells a finished boot by the measured prompt signature in
the engine's `wake` block, or failing that in the `wake` block of the profile that declares the
dialogs for the same command. With neither, the boot is not watched and the launch types nothing
(see above).

**A dialog belongs to the program, not the profile.** A profile with no `startupDialogs` of its own
takes the dialogs declared by any installed profile that runs the same `command`. An operator's
second profile for Claude Code (pinned to another model, say) is a copy made before this field
existed, and the bundled-profile sync never touches it; without this it would launch into the same
dialog unprotected. A profile's own list wins when it has one, and an empty list (`[]`) is how a
profile says its program shows none.

**With no declaration for the profile or its command, the pane is not watched at launch**: the
launch behaves as it did before the field existed.

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

`headerPattern` and `startingPattern` (and their `evidence` entries) only if the engine draws an empty
composer BEFORE it can take input, under a header that says so (#2187). Codex 0.156.1 opens with a
header box whose model row reads `model: loading`, and already draws its composer below it. The wake's
pane gate reads the rows of the pane top to bottom, keeps the **newest** row `headerPattern` matches,
and refuses the pane as `pane-engine-starting` while `startingPattern` matches that row. Newest,
because an engine that draws on the terminal's main screen leaves the superseded header in the
history above the one that replaced it. A pane with no header row in the read is not refused: in an
established session the header has scrolled away. Both are regex sources, not substrings, because a
header pads its value to the width of its box (`model:     loading`), so the run of spaces between
label and value is not fixed. Each must need some text to match: a pattern that matches the empty
string is refused when the profile is read, as is one field declared without the other. Codex
declares them, and its adapter hands the two compiled patterns of the launch's own engine profile
(the profile the wake reads for that session, whatever its id) to the startup fire's pane
witness (`lib/pane-witness.js`), so the fire and the wake cannot disagree about what "still starting"
looks like. A Codex profile that declares neither leaves the witness with no header to ask about, so
the trust-free fire is held as `pane_not_ready`, naming the two fields, until they are restored.

`restRows` (and its `evidence` entry) only for an exact engine version measured to draw a **footer
row beneath its status row** at rest, and that footer **alone** on the screen it opens and resumes
with (#2059). It is a table keyed by exact version (`MAJOR.MINOR.PATCH`); each entry holds
`footerPattern`, the regex source of that one row, and its own `evidence` (`verifiedOn`, `source`).
Codex declares `0.161.0` and `0.162.0`, each from its own signed-in captures over the launch path
TangleClaw uses: both draw the status row and then exactly `  ? for shortcuts`, and both open, and
resume, with that footer alone under an empty composer that holds the cursor, with no header row
that names a model. Nothing is declared for 0.156.1, which draws one row. A footer pattern must take
one whole row: it is refused when the profile is read unless it starts with `^`, ends with `$`, holds
no `|`, and needs some text to match. An entry may also hold `turnEnd`, the rows that version draws
around a turn: `turnRowPattern`, a row that starts a turn's drawing (Codex: `^[›•] `, a submitted
message or an answer), `endRowPatterns`, a non-empty list of rows that say a turn ended (Codex:
`^  Worked for \d` and `^■ Conversation interrupted`), and its own `evidence`. Those patterns are
anchored at the row's start only, because the end-of-turn row carries the turn's duration and a
clock; each must start with `^`, hold no `|`, and need some text to match. An entry may hold nothing
but `footerPattern`, `turnEnd` and `evidence`. A version is never read by another version's entry.
Three readers:

- **The wake's pane gate** refuses the pane as `pane-engine-starting` when the footer is the first
  row drawn below the last bare composer row, **and only for the exact version the session's own
  channel proved** (the version its launch recorded and the one its app-server reports, equal). With
  no version named, or one with no entry, this rule refuses nothing.
- **The wake's pane gate, for `turnEnd`**, refuses the pane as `pane-turn-in-flight` when a turn
  row is above the last bare composer row and the last non-blank row above that composer is not an
  end row, again only for the exact version the channel proved. An older empty composer row above
  the live one is not a turn row. With no version named, or one whose entry declares no `turnEnd`,
  this rule refuses nothing. The startup adapter does not read `turnEnd`.
- **The startup fire's pane witness**, given the compiled pattern by the Codex adapter, accepts
  below the composer exactly one status row and then that footer, in that order (see *The pane
  witness* under the startup channel). The footer first, the status row alone, a third row, and the
  two in the other order are all refused.

Declaring a version here does **not** admit it: a launch gets a channel only on a version in
`capabilities.startupControl.verifiedVersions`, and neither 0.161.0 nor 0.162.0 is listed. Each was
run signed in through a whole launch and wake (2026-10-12, each in its own run). The frame a stopped
client leaves mid-answer is now refused by the version's own rows around a turn, but a stall deeper
than one visible screen is not, and admission is tracked under #2222: see *A streaming answer is
drawn like rest* under the wake's limits below.

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
| `headerPattern` | Optional, declared with `startingPattern` or not at all — a regex source matching the header row that `startingPattern` is read on, whatever that row says |
| `startingPattern` | Optional, declared with `headerPattern` or not at all — a regex source matching that header row while the engine is still starting |
| `restRows` | Optional — a table keyed by exact engine version; each entry is `{footerPattern, evidence}`, optionally with `turnEnd`: the whole-row regex source of the footer that version draws beneath its status row at rest, where it was measured, and the rows it draws around a turn (`{turnRowPattern, endRowPatterns, evidence}`) |

Every field except `pasteRejectedMarker`, `decorativePattern`, `headerPattern`, `startingPattern` and `restRows` is **required**, `null` included. An author who has not
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
  marker, the fleet block, a dialog, a header that says the engine is still starting, a draft in the
  composer and a transcript that is still moving all still hold, because the protocol cannot see the
  TUI's composer.
- **Two refusals come before anything in the pane gate can answer "at its prompt" (#2187)**, the
  cursor resting on an empty composer included, because both screens below hold a composer that
  really is empty:
  - *A row that starts with the prompt glyph below the last bare prompt row* holds as
    `pane-no-prompt`. Codex 0.156.1 draws on the terminal's main screen, so the composer row it
    opened with stays in the read above its folder-trust, update and command-approval dialogs, whose
    selected option is drawn with the same glyph (`› 1. Trust and continue`). The rule is anchored on
    the last bare row because rows that start with the glyph are ordinary *above* a live composer:
    Codex draws every submitted message as one. It applies to every engine with a wake block and
    names no dialog. A composer holding typed text below a stale bare row is refused by it too; when
    the cursor is on that text the hold keeps its own code, `pane-composer-has-input`. One composer
    is excused: the switchboard's own nudge left unsubmitted by a lost Enter, and only when the
    composer is seen whole to its lower border, holds exactly that nudge, and no row that starts
    with the glyph is drawn below the composer, whether or not an older bare prompt row is in the
    read (#2452). The same exception also excuses a missing at-rest marker (Antigravity hides
    `? for shortcuts` while its composer holds text), but only for that exact nudge seen whole, with
    nothing glyph-led below it and an empty hint slot in the status row; the busy marker and an
    agent fleet are never excused (#2358). A boxed composer, a border above the cursor and one
    below it, is anchored on its upper border, so a wrapped continuation row that starts with the
    glyph does not cut off its head; with no box in view, the nearest glyph-led row still decides
    (#2358). Codex's composer draws no border, so that recovery does not apply there, with or
    without this rule.
    **A known limit, kept on purpose:** a usable composer whose own row is not bare, because the
    engine has drawn a pending suggestion on it (Claude Code), is refused as `pane-no-prompt` when an
    older bare prompt row is still in the read above it. The cursor says that composer is empty, but
    it would say the same of a dialog's selected option drawn dim, so the cursor alone does not
    overrule the refusal. The cost is a nudge that waits until the suggestion is gone or the older
    row has left the read; nothing is typed. No such older row has been captured from Claude Code,
    which draws on the alternate screen. The exception is not widened beyond the exact own nudge
    without measured pane geometry.
  - *The engine's own header says it is still starting* (`headerPattern` and `startingPattern`,
    above) holds as `pane-engine-starting`. **A known limit:** Codex's header pattern is not tied
    to the header box, so a transcript row that itself reads `model: loading`, when it is the
    newest row in the read to match, holds the pane as starting until it scrolls out of the read.
    The startup fire's pane witness has always read the same two expressions the same way, over the
    visible pane only; the wake's read also reaches 15 rows of history, so it holds a little longer.
  - *The engine's screen shows the rows it opens with* (`restRows`, above) holds as the same
    `pane-engine-starting`, for a version that draws no such header: the declared footer is the
    first row below the composer, with no status row above it. It is asked only for the version the
    channel's idle answer named, and it holds whatever the thread reports: on a resume, Codex
    0.161.0's thread was read `idle` while the `Resuming session…` screen was still up.
  - **What this covers, by version.** On Codex 0.156.1: the opening screen (`pane-engine-starting`,
    by its header) and the dialogs drawn below it (`pane-no-prompt`). Codex 0.159.0, 0.161.0 and
    0.162.0 draw their dialogs on the alternate screen, where the dialog is the whole pane and no
    row is a bare prompt, so those were already held. On **0.161.0 and 0.162.0** the opening and
    the resuming screen are held as `pane-engine-starting` by `restRows`, once a channel names the
    version. **0.159.0's opening screen is not held by either rule:** it draws no `model:` header
    row and nothing is declared for it, so an idle answer from a channel over that screen would be
    typed into. No session of 0.159.0, 0.161.0 or 0.162.0 has a channel today, because none is in
    `verifiedVersions`, so no nudge reaches them; a refusal of a version's opening screen, proved on
    whole captures with the cursor, is a precondition of admitting it, and is not by itself what
    admits it.
  - **Two limits of the `restRows` refusal, both measured on 0.161.0 and 0.162.0.** With an
    **empty status line** (`tui.status_line = []`) the opening frame is still the footer alone and
    is held, but at rest those versions draw one row, the footer with `100% context left` at its
    right. That is not the declared footer, so this rule does not refuse it (it is a composer in
    use); the startup fire's witness does refuse it, having no status row to recognise. And **a
    turn whose answer is streaming draws no busy row** on those versions: the `Working (… esc to
    interrupt)` row is up for the first seconds only, after which the pane shows an empty composer
    with the cursor on it, the status row and the footer, as at rest. What holds a nudge then is
    the engine's own answer (`engine-thread-busy`, decided before any pane is read), the
    transcript still moving (`pane-writing`) and the version's own rows around a turn (below),
    not this rule or the busy marker.
  - **A streaming answer is drawn like rest; the frame it leaves is now refused, and neither
    0.161.0 nor 0.162.0 is listed.** Measured signed in, each version in its own run, with real
    mail waiting. While the turn ran, the wake held on `engine-thread-busy` at every tick,
    including over a pane held still in the middle of the answer. But the thread's answer comes
    from the app-server and the pane from the TUI client, which are separate processes. With the
    client stopped mid-answer and the turn then ending, the thread read idle while the pane still
    showed the answer cut off mid-line; the wake waited its settling interval, read that pane as
    `pane-at-prompt`, and typed the nudge into it, on both versions. Nothing was typed while a
    thread read active. The still pane was made by stopping the client process, not by a pause in
    the model, and how often a real session shows one is not known.
    Each version now declares its rows around a turn (`restRows.<version>.turnEnd`, above), and the
    pane gate holds that frame as `pane-turn-in-flight`: an answer still being drawn has a turn row
    above the composer and no `Worked for …` or interrupted row after it. Every frame of both
    versions' signed-in runs is replayed in the wake's fixture tests with the thread status recorded
    beside it: nothing is typed into a stopped frame or one still drawing a turn, and the stopped
    run is next nudged under the drawn end of the turn.
    **This does not make either version wakeable.** `startupControl.verifiedVersions` stays
    `["0.156.1"]`, so no session of 0.161.0 or 0.162.0 has a channel and the rule is dormant until
    one is admitted. Admission is tracked under #2222. **A known boundary: the rule reads only the
    visible pane.** These versions draw on the alternate screen, so the wake's read is the visible
    pane and no history. A plain-text answer has one opening `• ` row; an answer long enough to
    scroll that row off the visible pane, and then left still, shows only continuation rows above
    the composer, has no turn row to find, and **is not refused**. The recorded stops came about a
    dozen answer rows in, on an 80×24 pane, so this case was not measured. Neither version may be
    listed until a stall deeper than one screen is measured signed in for that version and
    refused, and a session at rest is still nudged as promptly as now; nothing here is inferred
    from the other version.
- The first `idle` a launch's thread reports holds as `engine-thread-settling` for one monitor
  interval (`ENGINE_SETTLING_MS`, five seconds), whatever the pane shows, and the pane is not read
  while it holds (#2059). An engine can answer idle a moment before it has finished drawing the screen
  it will rest on: Codex 0.156.1 was measured answering idle 10 ms before a pane sample that still
  showed its `model: loading` header. The hold is timed from the first idle answer for the session's
  channel and launch, so a relaunch, or a channel that closed and reopened, starts it again. It also
  starts again when a turn ends: an idle answer that follows a `busy` one on the same channel holds
  for one interval too, because a turn's end is the other moment the thread can read idle before the
  pane has caught up. An `unknown` answer in between does not restart it. On 0.156.1, the one version
  with a channel today, that delays the first nudge after an observed turn by one interval and never
  types sooner. Its limit: the thread is asked only while mail is waiting, so a turn that starts and
  ends with no mail waiting is never seen busy and does not restart the hold. The timestamp is in
  memory, so a server restart costs the first mail afterwards one interval. It is a rule of its own and does not depend on the idle streak
  (`IDLE_TICKS_REQUIRED`), which is counted from after it. The hold delays a nudge and refuses no
  screen: a startup screen or dialog still up when the interval has passed is judged by the pane gate
  alone.
- `busy` holds as `engine-thread-busy`, whatever the pane shows.
- **A folder Codex was told not to trust holds as `engine-folder-untrusted` (#2186).** When the
  thread reads idle, the observation asks `config/read` once more, on the connection it already has
  open, and answers `held` in place of `idle` if Codex's config holds an entry for the project
  directory that says anything but `trusted`. The rule, as the release's decider ruled it on
  2026-10-11 and the Architect cleared its design on 2026-10-12:

  | What `config/read` holds for the folder | The wake |
  |---|---|
  | an entry that says `trusted` | no hold |
  | an entry that says anything else | holds the nudge |
  | no entry, or `projects: null` | no hold |
  | the read fails, or its answer has no readable projects table | no hold, and a warning once per launch |

  It is the startup fire's own rule for an explicit entry (below, "A folder with no trust entry"),
  and it exists because the wake was otherwise a way round it: on Codex 0.156.1, signed in, a nudge
  was typed into a folder with `trust_level = "untrusted"` 11 to 16 seconds after the mail, in the
  same session whose startup fire had been refused as `trust_required`, and Codex started a turn on
  it. A folder with no entry is not held, because the operator's decision for the fire already lets
  a first turn go there and a nudge is typed into the same composer as their own typing would be.

  **A failed read establishes nothing about trust.** It is not a trusted verdict: the nudge may go
  if every other gate passes, because an unreadable config must not stop mail, and the server log
  says once per launch that trust could not be established. An operator who means a folder to be
  held should check that Codex's `config.toml` parses.

  The hold applies from the next look on. A nudge already typed is not recalled, and its `nudged`
  row in the ledger stays; for mail already nudged, the monitor records only that the session is
  not eligible now. The answer follows the config as it stands: setting the entry to `trusted`
  releases the nudge within a few monitor intervals, with no relaunch: one look to read the new
  answer, the settling hold if the launch had not yet reported idle, then the idle streak (an edit
  made while the app-server ran was read within 12 seconds on 0.156.1). The hold neither starts nor resets the settling hold,
  and it is not a stall, so it raises no stall alert. A busy or unknown thread is answered without
  the extra read. The sender is told the class `configuration` and the next action
  `review-folder-trust`: the recipient's operator may set the entry to trusted to resume automatic
  wakes, or leave it untrusted and read the mail by hand. Like every `configuration` hold, an aged
  message held this way is told to the operator.

  The rule reads only `config/read`, so it applies to every Codex version the channel's version gate
  admits; it adds no version to `remoteTrustPrompt.absentOn`. What Codex does with a nudge was
  measured on 0.156.1 only: it asked for approval before running anything, and what it does when
  that approval is given was not measured.
- With a channel present, anything unproven (not asked yet, stale, failed, `unknown`) holds as
  `engine-thread-unknown`. It never falls back to the pane.
- With **no** channel (a session launched before channels existed, or whose server did not start or
  has closed), the nudge holds as `engine-channel-absent`. Relaunching restores wakes.
- A Project Master on such an engine holds as `master-engine-unobserved`. The Master has no project
  launch and never gets a channel, so a relaunch does not change it.
- The adapter's own reason (`version-mismatch`, `thread-ambiguous`, …) is logged whenever it changes.
  The ledger and the peer route carry only the bounded wake code.
- A session held as `engine-thread-unknown`, with mail waiting, for 10 minutes (`WAKE_STALL_ALERT_MS`) is
  reported (#1978). One warning is logged per episode, and `/api/server-info` carries
  `medusaWakeStalls` (the count, plus the oldest session's project, age and adapter reason) as
  read-only evidence. No dashboard UI renders it. The alert is derived from the wake verdict, so it clears as soon as
  the engine answers, the mail is read or the session ends. It never types into the pane or sends a
  message.

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

**What `tc` checks about its own identity (#2233).** Two things, and they answer different
questions. `tc whoami` prints the server's verdict on the launch id the pane carries: `verified`,
`stale` with a reason, or `unbound`. And before any verb sends a request, `tc` compares
`TANGLECLAW_LAUNCH_ID`, `TANGLECLAW_PROJECT_ID`, `TANGLECLAW_ROLE` and `TANGLECLAW_WORKSPACE_ID` in
its own environment with the values tmux recorded for the pane it runs in (`tmux show-environment -t "$TMUX_PANE"`, bounded
at one second). A difference refuses the verb with `PANE_IDENTITY_MISMATCH`, exit 2, and nothing is
sent. The comparison needs `TMUX` and `TMUX_PANE` in the tool shell and a tmux it may talk to. An
engine whose tools run outside the pane (Codex on its native startup channel, where they run in the
per-launch app-server) or inside a sandbox that hides the tmux socket gets "Pane check: not made"
from `tc whoami`, and its verbs run. That is a statement that the check did not happen, not a pass.
The check also cannot see a shell that inherited its whole environment, `TMUX_PANE` included, from
another pane's process: it reads that other pane and finds agreement. Nothing in the pane can catch
that case, which is why a launch is kept off a shared engine process when it starts and why writes
are checked at the server.

**Every launch decides all four (#2268).** A launch gives some of those variables and not others: a
project session has no role, the Project Master has no project id, and a workspace id exists only
with the switchboard on. tmux starts every new session from its server's global environment, which
holds whatever the process that started that server held. A tmux server started from inside a
launched pane therefore holds that pane's identity, and a later launch would inherit each variable
it did not set itself: its tool shell would then carry a role or project id that its own pane never
recorded, and every `tc` verb in it would be refused. So the `tmux new-session` that creates a pane
(`lib/tmux.js#createSession`, the one place a pane is created) passes each of the four the launch
gives no value for as an empty entry, `-e KEY=`. `tmux show-environment -t <session>` lists all
four for a session launched this way, the ungiven ones empty, and a window or pane opened in that
session later reads the same empty value, not the global one. Empty and unset read alike to `tc`,
which sends an identity header only for a variable that holds a value. A value an engine profile's
`launch.env` sets for one of the four is a given value and is passed through. The per-launch
app-server gets the same treatment by another route: it runs in no pane and inherits TangleClaw's
own environment, so an identity variable the launch does not give is removed from the environment
it is started with (`lib/startup-control-codex.js`). The list of the four is
`lib/launch-identity.js#LAUNCH_IDENTITY_KEYS`, held equal to the list `tc` compares by a test.
This covers launches made by a server that has the change; a session already running keeps what it
started with until it is launched again. Nothing is removed from tmux's global environment, which
belongs to every user of that tmux server.

**What is left in tmux's global environment is reported, not removed (#2268).** When the server
starts it reads that environment once (`tmux show-environment -g`, which starts no tmux server and
changes nothing; `lib/tmux.js#readGlobalIdentityKeys`). `GET /api/server-info` then carries
`launchIdentityNotice`, and carries it whatever the read found:

| Field | What it holds |
|---|---|
| `state` | `none`, `found` or `could-not-check` |
| `variables` | The names found, in the list's order. Never a value. Empty unless `found` |
| `removeCommands` | One `tmux set-environment -g -u <NAME>` for each name |
| `observedAt` | When the read was made, as an ISO time; `null` only if no read was made |
| `message` | The outcome as one sentence for a person; empty for `none` |

The field is never absent and never `null`: a clean result told by a missing field would look the
same as an older server or a read that never ran. A reader that finds no such field should take it
for `could-not-check`, never for `none`.

- `none`: tmux answered and its global environment holds none of the four, or no tmux server is
  running, so there is no global environment. Nothing is logged.
- `found`: it holds at least one. The server logs one warning with the names and the commands.
- `could-not-check`: tmux did not answer within the read's timeout (the module's five seconds), or
  the read failed in any other way, or it was never made. The server logs one warning naming the
  read and, for a failure, tmux's exit status or the error code. The server starts regardless, and
  the read costs the start no more than its timeout.

A variable that is set and empty in the global environment is not reported: a pane that inherits an
empty value reads the same as one that inherits nothing, and since every launch sets each of the
four itself, no pane this server launches inherits it at all. Neither the log line nor the field ever
holds the value of a variable; a launch id is what the server accepts as a caller's binding. The
read is made once, so a variable removed afterwards keeps its notice until the server restarts, which
is why the notice carries its time. No pane this server launches inherits a variable the notice
names. Removing one is the operator's choice, with the command the notice gives.

`tc`'s `PANE_IDENTITY_MISMATCH` refusal names this cause in one case: every variable that differs is
one the shell holds and its pane recorded none for. That is what a pane launched by a TangleClaw
from before this change looks like while tmux's global environment holds a role or a project id. The
refusal then adds that launching again fixes it on a TangleClaw that sets every launch identity
variable at launch, and that on one that does not, the operator first runs the
`tmux set-environment -g -u <NAME>` it prints for each variable. Any other mismatch reads as before.

**Sessions that were already running (#2233).** The launch check applies to launches made after it
was installed. To see how the sessions running now were started, run `tc sessions isolation` from
any launched pane, or read `GET /api/launch/isolation`. It reads the command tmux recorded for each
pane when it was started (`#{pane_start_command}`), takes TangleClaw's own wrappers off it, and
gives each live session and the Project Master one verdict:

| Verdict | Meaning |
|---|---|
| `ISOLATED` | Codex was started from an exact executable path, either attached to the server TangleClaw started for that session (`native-app-server`) or with `--no-daemon` (`no-daemon`). |
| `NOT ISOLATED` | A Codex session whose command does not show that: most often the bare name `codex`, which is how Codex was started before the launch check existed. A session started under the operator's override also reads this, and its reason says so (see "The operator's override" below). |
| `NOT SHOWN ISOLATED` | The command could not be read or judged: tmux did not answer or failed, the pane records no start command, the command could not be read back exactly, or the session's tmux name could not be worked out. Treat it as not isolated. |
| `not applicable` | An engine with no shared background process, a session that runs on another machine, or a session tmux has no pane for. The last is read only from a tmux that listed its panes, or that said it has no server running. |

Cutover after an upgrade, or after installing a different Codex version:

1. Run `tc sessions isolation`. Note the session ids marked `NOT ISOLATED` or `NOT SHOWN ISOLATED`.
2. End each of those sessions and launch it again. The launch is checked as it starts and is
   refused if it cannot be isolated.
3. Run `tc sessions isolation --replaced <those ids>`. Each id should read `relaunched-isolated`.
   `still-running` means the old session was not ended; `ended-not-relaunched` means its project
   has no session now; `relaunched-not-isolated` and `relaunched-unknown` mean the new session
   needs the same attention. `relaunched-not-applicable` means the project now runs an engine with
   no shared background process, or its new session has no local pane. `unknown-session` means
   TangleClaw has no session with that id: check the number.

A session marked `NOT ISOLATED (operator's override)` is left out of step 1 (#2229). It was started
under the launch-isolation override, with that launch's own record read (see "The operator's
override" below), and `tc sessions isolation` counts it ("2 not isolated (1 of them under the
operator's override)"), lists it after the plain `NOT ISOLATED` rows, keeps its id out of the
`--replaced` ids it offers and names it in one closing sentence instead. A relaunch can isolate it
only on a Codex version TangleClaw has verified; on the same version it starts the same way while
the override stands, and is refused once the override is cleared. So after installing a verified
Codex version, end and relaunch these sessions too, and add their ids to step 3 yourself: `tc` does
not read the installed version and goes on leaving them out. A row whose reason says
TangleClaw holds no record that the launch was started under the override carries no such mark: it
is an ordinary `NOT ISOLATED` session and is in step 1.

The inventory ends and restarts nothing. It judges the command a pane was started with, not the
process running in the pane now. For a `--no-daemon` session, the Codex version was checked when it
was launched and is not checked again. It does not read each pane's environment, so it takes a
tmux session named for a project to be that project's current launch.

**What a session is told about its own launch (#2228).** The inventory above is the operator's and
the fleet's view. A session reads its own from `tc whoami` and `tc capabilities`, which print one
`Launch isolation:` row, and from `tc start next` and `tc start review`, which print the same row
in brackets above the state step. `tc` reads the command its pane was started with
(`tmux display-message -p -t "$TMUX_PANE" '#{pane_start_command}'`, bounded at one second), takes
TangleClaw's wrappers off it and judges it with the same rules as the inventory. Its own answer is
one of three, and never `ISOLATED`:

| Row | Meaning |
|---|---|
| `NOT ISOLATED` | The pane named by this shell's environment was started with a Codex command that plainly was not isolated: most often the bare name `codex`. The row gives the reason and says to ask the operator to end the session and launch it again. The Codex version reads `unknown`: `tc` does not read it. |
| `NOT SHOWN ISOLATED` | Everything else `tc` cannot call a negative. That includes a command that would read `ISOLATED` in the inventory, a command attached with `--remote` (whether that server is the session's own is recorded only by TangleClaw), a command that names Codex in a form `tc` could not judge, a pane with no readable start command, and a shell with no pane at all, which is every Codex session on its native startup channel. By itself the row shows nothing either way: take the server's line under it, or `tc sessions isolation`, as the record, and treat the session as not isolated unless that record reads isolated. |
| `not applicable` | The pane was started with a command that names no engine sharing a background process. |

There is no positive row because nothing a session holds proves which launch it is. `tc` finds its
pane through `TMUX_PANE`, which a shell can inherit from another pane's process, and a verified
launch binding is attribution, not authentication: a shared engine process can present another
launch's live binding. A wrong `NOT ISOLATED` costs a relaunch. A wrong positive would tell a
session on a shared process that its identity is its own.

When the row is not `not applicable` and the launch binding is verified, a second line gives the
server's record for the launch that binding names, from `GET /api/launch/isolation`, with the row
chosen by the session the server verified and never by an id the shell supplies. It is worded as
the server's fact ("recorded as isolated … That does not show this shell is that launch") and is
not a verdict about the shell. With a binding that is not verified the server is not asked and the
line says so. If the lookup fails the line reads `unavailable` and the verb still answers.

For a launch the server marks as started under the operator's override (#2229), that second line
says so before the row's reason: "recorded as not isolated, started under the operator's override
(a relaunch can isolate it only on a Codex version TangleClaw has verified; on the same version it
starts the same way while the override stands, and is refused once the override is cleared)". The
session's own row above it does not change. It is read from the pane alone, and a binding can be
another launch's, so the server's record never softens `tc`'s own advice to relaunch. A launch with
no override record gets the ordinary second line, with the server's reason whole.

Three limits. A session that never runs `tc` and never reads its launch steps is still not told.
The row describes the command the pane was started with, not the process running in it now. And
above the state step the notice is given only the room that page's own header and footer leave
within the engine's tool-output limit: on `tc start review`, whose banner is longer, it is cut
after the verdict and the advice and ends "… Run tc whoami for the rest." A session whose row
would be `not applicable` gets no notice above the state step.

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

#### `launch.guardedDialogs`

Some engines open on a dialog whose highlighted default has consequences. Codex's update prompt
highlights "Update now", which upgrades the global install, and its folder-trust prompt highlights
"Trust and continue". A key sent on a timer answers whichever is on screen (#2177), so a profile
**declares** the prompts its engine can open on, and the launch reads the pane before it types:

```json
"guardedDialogs": [
  { "id": "folder-trust", "match": "Trust this folder\\?", "humanAction": "Answer it in the pane…" }
]
```

- `match` is a regular expression tested against the pane's text. `humanAction` is the sentence the
  operator is shown.
- **TangleClaw answers none of them.** While a declared prompt is the live screen, the prime is not
  pasted and no `preKeys` are sent. The delivery ledger records the paste as `skipped` with a reason
  that names the prompt and carries `humanAction`, and the server log warns when the prompt is first
  seen. The operator answers the prompt in the pane.
- A prompt counts as live when it is drawn **below the last bare composer row**. Codex keeps its
  opening composer on screen above a dialog, and keeps an answered dialog in scrollback above the
  composer that replaced it, so the text alone does not say which state the pane is in.
- For an engine that declares guarded dialogs, the blind paste after a readiness timeout is also
  refused when the pane shows neither a bare composer nor a declared prompt, and when the pane cannot
  be read. Such an engine needs a `capabilities.wake.promptPattern`, or no composer is ever
  recognised. An engine that declares none keeps its paste exactly as before.
- An entry that cannot be read (no `id`, no `match`, a `match` that is not a valid pattern, or a
  `guardedDialogs` value that is not a list) makes
  the launch type nothing at all for that engine: the prompt it named can no longer be recognised.
  The server log names the entry.
- After a refused paste nothing retries it. Once the operator has answered the prompt, the session
  is started as any unprimed session is: by hand, or by the launch-unready nudge where its own gate
  lets it type.
- The Codex opening screen (`model: loading` over an empty composer) reads as a composer here. It is
  not told apart from a usable one by this check. The wake's pane gate and the startup fire's pane
  witness do tell it apart, by `capabilities.wake.startingPattern`.

`launch.guardedDialogs` has two readers, each with its own scope, both in `lib/launch-dialog-guard.js`'s
terms. The launch-time sends above (the prime paste and `preKeys`) read it to decide whether they may
type. The native startup fire's pane witness (`lib/pane-witness.js`, #2186) reads it to rule a declared
dialog out before it calls a pane an empty composer; it types nothing either way. It is not a general
declaration of an engine's dialogs, nothing else in TangleClaw reads it, and it is not interchangeable
with any other dialog declaration a profile may carry.

`launch.preKeys` still exists for an operator-written profile, and is still sent on a timer. It is
no longer sent without a look: each key first passes the startup-dialog check
(`capabilities.startupDialogs`, #2128), which also withholds it from a menu's selected option or
typed text, and then the guarded-dialog check above (#2177). A screen that neither declaration
names and that shows no row led by the prompt glyph still gets the key. **No bundled profile
declares any.** Do not declare one for a prompt
whose default changes anything outside the pane.

**A profile that declares both kinds of dialog has one known limit** (#2221). The guarded-dialog
check takes "composer" to mean a row matching the bare `promptPattern`. Claude Code's fresh composer
shows a faint suggestion and is not bare, so on such a profile, when the pane was never observed
ready, the prime is refused as an unrecognised screen. A pre-key is still sent in that case: the
startup-dialog check reads the pane as the empty composer, and the guarded-dialog check withholds a
key only from a declared prompt or an unreadable pane. No bundled profile declares both
(Claude Code: `startupDialogs`; Codex: `guardedDialogs`).

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
  "remoteTrustPrompt": { "absentOn": [] },
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
app-server cannot be started or whose native protocol version is unverified records why it used the
legacy path. On an explicitly verified Codex 0.156.1 or 0.157.1 binary that path appends
`--no-daemon`, preventing a new session from inheriting another session's shell snapshot or launch identity through Codex's
shared background daemon (#1895). The Project Master never opens a native channel, so its launch takes the
same hardening directly: its exact executable is probed and the same version bound applies.

**A Codex launch that cannot be shown isolated does not start (#2233).** Immediately before the pane is
created, for project sessions, relaunches and the Project Master, TangleClaw reads the engine command it is
about to run and allows exactly two forms: the probed executable attached with `--remote` to the socket of
the app-server this launch started from that same executable, on a server version the profile's
`verifiedVersions` lists, or the probed executable with `--no-daemon` on a version verified to accept it.
The flag must appear once and in its plain form: a repeated flag, both flags together, an `=` form, a
`--daemon` flag or a bare `--` is refused, and so is any argument that is not a plain word (letters, digits and `_ . , : = @ % + / -`, with `=` not first), because a shell may rewrite anything else and which flags Codex
would follow is not known. Both run the executable by its full path, so the pane's shell cannot
resolve a different Codex. Anything else is refused with `409 LAUNCH_ISOLATION_UNVERIFIED`, a `reasonCode`
(`executable_unresolved`, `executable_unverified`, `version_unknown`, `version_unverified`, `native_version_unverified`, `command_not_pinned`,
`command_unparseable`, `command_unisolated`, `judgment_failed`, `no_judge`) and recovery text. The recovery is specific to the reason: a version reason names the verified versions and
the command that installs one (`npm install -g @openai/codex@0.156.1`, which is also what the first-run
wizard offers); an unresolvable executable says where to install Codex; a command reason says to remove
custom launch arguments, since another Codex version would not help. No pane, session row or bridge credential is created, and a per-launch server that was already
started is stopped. Codex 0.154.0 rejects `--no-daemon` and is not verified for the native channel, so it
no longer launches; neither does any version not yet tested, unless the operator's override allows it (see "The operator's override" below). The check applies to a
launch whose engine id, profile (its id, launch command or detection target), resolved executable or
command names `codex`. Such a launch is also refused (`no_judge`) when no check could run for it at all:
the Codex adapter is not registered, lacks the check, or does not claim the launch. Every other engine
launches as before. It does not see an executable replaced after the probe, a wrapper or alias with another name,
Codex reached over SSH, or sessions already running, which must be ended and relaunched.

**A Codex that does not answer its version probe is asked once, then left alone for 60 seconds (#2231).**
The launch's version probe is synchronous: while `codex --version` runs, up to its 5-second limit, the
whole server waits. A launch reaches the probe from up to three places (the capability read, the
app-server start and the legacy command), so one launch now asks its executable once and hands that
answer on. When the executable fails, times out or prints something that is not a version, that is
remembered for 60 seconds, and a project launch, relaunch or Project Master start inside that time is
refused at once without running it. The refusal keeps its code, `version_unknown`, and its recovery
text; its message says the executable was asked less than a minute ago, was not asked again, and in
about how many seconds it will be. Launching again after that time asks it again. So does replacing the
file: the memory is of one file (its resolved path, modification time, size, inode and device), so a
reinstalled or repaired Codex is asked at the next launch. It is kept in the running server only and a
restart forgets it. An executable whose file cannot be read is never remembered and is asked every
time. A Codex that answers is never remembered either: its version is read afresh at every launch.
The server log has one warning for each launch that did not ask, naming the executable and the wait.

**Codex compatibility after this check (a security patch, #2233).**

| What | Versions |
|---|---|
| Launches attached to its own per-launch server (`--remote`) | 0.156.1 (`capabilities.startupControl.verifiedVersions` in `data/engines/codex.json`) |
| Launches with `--no-daemon` | 0.156.1, 0.157.1 (`NO_DAEMON_VERSIONS` in `lib/startup-control-codex.js`) |
| Refused | 0.154.0 and every other version, 0.161.0 included, and any install whose version cannot be read |
| Installed by the command TangleClaw offers | 0.156.1 (`npm install -g @openai/codex@0.156.1`), the only version on both lists |

The two lists are separate and neither vouches for the other. A refusal on the `--remote` path
(`native_version_unverified`) names only the first list, so it never suggests 0.157.1, which that path
would refuse again. Codex's own update prompt offers to replace a pinned install with the newest version;
the newest version does not launch, so skip it (Escape). Its default choice (Enter) runs
`npm install -g @openai/codex`. To stop Codex drawing that prompt, set
`check_for_update_on_startup = false` in Codex's `config.toml` (`~/.codex/config.toml` unless
`CODEX_HOME` is set). Measured on 0.156.1 and 0.157.1, as `codex` and as `codex --no-daemon`, with no
account: with the setting `true` and a home that knew of a newer version the prompt was the first
screen, and with `false` it was not drawn. Not measured: a session attached with `--remote`, anything
after sign-in, whether `false` also stops the check itself, and an update made with no prompt (none was
seen). TangleClaw does not edit that file. A version refusal's remedy carries the same advice wherever
every version it names was measured; the remedy that names no version does not.

- **Sessions already running.** The check runs when a pane is created. A Codex session started before
  the upgrade keeps running on whatever command started it, isolated or not, and nothing ends it.
- **Operator cutover.** After upgrading TangleClaw, run `tc sessions isolation` to see which running
  sessions were not started isolated, end and relaunch those, and check with `--replaced`: the steps
  are under "Sessions that were already running" above. Each relaunch either starts isolated or is
  refused with the reason. The launch check itself says nothing about a session until it is
  relaunched; the inventory is what reads the ones still running. If the inventory cannot be read,
  end and relaunch every Codex session, and the Project Master if it runs Codex.
- **A refused executable is never run.** Whether the resolved executable may be run as Codex at all (it
  is named `codex`, and its path can be placed in a command) is decided before the version probe and
  before the per-launch server, both of which execute that path. A wrapper or an unnameable path is
  therefore refused with nothing started. The other refusals come after the probe, and a per-launch
  server already started for one of them is stopped.
- **Not supported, and refused or unseen.** Refused: a launch a profile identifies as Codex whose
  executable is not named `codex` (a wrapper is not trusted to pass the isolation flags on, whatever
  version it reports); a Codex whose path holds a quote or control character; custom launch arguments that are not plain words or that touch the isolation flags.
  Unseen: a wrapper or alias not named `codex` that no profile field identifies, a different program
  that is itself named `codex` (the name and the version it prints are the whole identity tested), Codex reached over
  SSH, an executable replaced between the version check and the launch, and whether a `--remote`
  client can ever consult the shared process (allowed on the evidence recorded for 0.156.1 only).
- **The operator's override (#2229).** One thing lets a Codex launch that could not be shown isolated
  start anyway: the launch-isolation override, which only the operator can turn on, for the whole
  install or for one project (the routes are in `docs/configuration-reference.md`). No flag, profile
  field, `config.json` key or `project.json` key does it, and a session cannot grant itself one.
  - **What it covers.** Only the two refusals that are about the version: `version_unknown` (the
    version could not be read) and `version_unverified` (it is not a version TangleClaw has verified).
    Every other refusal stands with the override on: a wrapper or unnameable executable, launch
    arguments that cannot be read, a command that attaches to a server the launch did not start, launch
    arguments that themselves carry `--no-daemon` (the session would then be recorded as isolated), the
    native channel's own version refusal, and a fault in TangleClaw's own check. The overridden
    command is checked for those again, so a problem the version refusal was hiding still stops it.
  - **What starts.** The exact executable that was probed, with the launch's own arguments and
    without `--no-daemon`: nothing shows that version accepts the flag.
  - **What it risks.** The launch can use Codex's shared background process, so it may borrow
    another project's TangleClaw identity: its `tc` calls may fail, or act as that other launch. The
    project whose identity is borrowed did not opt in. The override does not make the launch isolated,
    and nothing softens what such a session may then be refused.
  - **Where it is turned on and off.** On the dashboard: **Global Settings →
    Launch isolation override** for the whole install, which says it covers every project and the
    Project Master, and a project's **Settings → Launch isolation override** for that project, which
    says when the install-wide one already covers it. Both carry the sentence under "What it risks".
    Turning one on needs a signed-in operator: where no login is in force the switch stays off and
    shows the refusal (`LOGIN_GATE_REQUIRED`: a login must be in force), and turning one off still
    works. A launch refused for `version_unknown` or `version_unverified` carries an **Open launch
    isolation settings** button that opens the project's Settings at its switch. The refusal stays
    visible until it is dismissed with Dismiss, or with Escape while one of its buttons has focus,
    or a newer message replaces it. Its
    settings button is removed when the refusal is dismissed or replaced, or when the button is
    used.
    The same switch is reached from the project's Settings at any time. A session's own page and the Project Master's settings offer neither
    switch.
  - **Where a running one shows.** The project's Settings, under **Launch readiness**, has a line
    for the project's running session when the isolation inventory marks it: "running under the
    operator's launch isolation override", with the version read and the refusal set aside, or
    "override unproved" when the pane runs that command and no record shows the launch was started
    under an override. It says nothing for any other session, never calls one isolated, and has no
    line for a launch that has ended.
  - **The Project Master** belongs to no project, so only the install-wide override starts it.
  - **Fail closed.** If the override cannot be read, the launch is refused as if none were set.
  - **What it leaves, each time.** A warning in the server log; a `launch.isolation_overridden`
    activity event; `isolationOverride` in the launch's answer; and a mark on that session's row of
    `tc sessions isolation` and `GET /api/launch/isolation`. Each names the project (or the Project
    Master), the version read and the refusal that was set aside. The row still reads
    `NOT ISOLATED`: the mark says how the launch was allowed to start, and is never a verdict.
    A relaunch isolates it only on a Codex version TangleClaw has verified; on the same version it
    starts the same way while the override stands, and is refused once the override is cleared.
  - **The mark is claimed only on the launch's own record, for the pane that launch started.** A row
    says its launch was overridden only when TangleClaw reads the activity event that launch wrote
    AND the event's one-way reference to the launch id matches the launch id the live tmux session
    holds (for a project session the event is also the one with its session id). Neither a pane's
    start command nor a session id is proof alone. The command an overridden launch runs (the exact
    executable, neither isolation flag) is also what a profile naming Codex by absolute path ran
    before launches were checked, and a tmux session can be replaced by hand under a project's name
    while its session row stays active. A row with that command and no matching record says so in
    words ("holds no record that this launch was started under it") and carries `overrideUnproved`;
    it is not called overridden. This is attribution, not a defence against the session itself: a
    session knows its own launch id and could copy it into a tmux session it rebuilds. Either way
    the row reads `NOT ISOLATED`.
  - **A limit of the mark.** The activity log keeps only its 500 newest events for the whole
    install. On a busy install an overridden session's event ages out while the session runs, and
    its row then reads unproved, not overridden. The log warning written at the launch does not age
    out with it.

The channel ends with the
session: kill, a wrap that ends the session, a
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
monitor stamps the window but sends no nudge. Instead, once the launch's readiness gate has passed,
the operator's **startup prompt** is fired once
through the channel by the same service the dashboard and the API use, under the internal `launch`
caller (`launch-automatic` clearance, attributed to the launch's own project) and the deterministic
key `launch-<sequence>-r<revision>`. The engine's receipt on that fire row is what says the prompt
arrived. If the adapter's own pre-send check blocks
(`trust_required`, `auth_required`, …), that is recorded the same way. There is no paste fallback and
no automatic retry: the launch panel names the reason and the operator may **Fire** once it clears.

**The launch's readiness gate (#2059).** Which gate a native launch waits on depends on its engine's
adapter, and on nothing else:

- **An adapter that implements `awaitLaunchReady`** (Codex) proves readiness itself, and its answer
  is the gate. For Codex that is both of these at once, looked for about every 1.5 seconds inside a
  90-second window: the launch's one thread is in the project directory and `idle`, and the pane the
  launch created positively shows an empty ordinary composer on the pane witness's two reads a
  second apart, with the thread read `idle` once more after them. **An idle thread alone is never
  ready**: the protocol cannot see a dialog, typed text or a pane still being drawn. Nothing reads
  Codex's status line for a word. That line is the operator's to configure and its default carries
  no at-rest item, so a launch gated on `· Ready ·` waited out the window on a pane that was ready
  (measured signed-in on 0.156.1, 2026-10-11).
- **An adapter without that method** keeps the pane's own gate: the engine's at-rest marker over a
  settled transcript (`_awaitPaneReady`).

The two are never mixed. `startupControl.awaitLaunchReady` answers `unsupported` only when the
adapter does not have the method. An adapter that has it and could not answer (its channel, the pane
or the thread unreadable, a throw, no answer within the window and 15 seconds) is `unknown`, which
is a launch whose readiness is not established: nothing is sent, and the marker gate is not consulted
to overrule it, whatever the pane shows.

A gate that does not pass still records the attempt, settled `blocked (pane_not_ready)` with nothing
sent. For an adapter-proved gate the sentence gives the last thing actually observed (the dialog on
the pane, by name; what the witness refused; the thread's state) and what the operator does. Where
the pane or the channel could not be read, it says **the proof was unavailable**. That is not a pane
seen unready and is never worded as one. A refusal that waiting cannot clear (the session's pane is
not the one the launch created, another tmux server answered, the channel is another launch's) is
answered at once and not at the window's end. A trust dialog the gate or the last look reads from
the pane is reported under this same code, by name; `trust_required` is what an operator's Fire
says of it.

**A passed gate is not permission to send.** It says the pane became ready, some time before the
send. The launch's automatic fire therefore reads the launch's pane once more, on one fresh read,
and its thread once more, immediately before `turn/start`, in a trusted folder as much as in one
with no trust entry. A pane or thread that changed in between, or a read that could not be made,
sends nothing and settles the same single row `blocked (pane_not_ready)`. The operator's own
**Fire** is their look at the pane and is not put to that read; its behaviour is what it was.
Every other launch keeps today's path (`legacy`) and records, through the same service, why it could
not go native — `unsupported` with the capability's reason (`engine_declares_none` for an engine that
declares no channel, `version_unverified`, …) or `blocked (channel_unavailable)` for a supported engine
whose server did not start. The app-server also inherits the pane's ambient environment (`tc` on PATH,
`TANGLECLAW_PROJECT_ID`, `TANGLECLAW_API`, `TANGLECLAW_WORKSPACE_ID`, `TANGLECLAW_LAUNCH_ID`), on the
understanding that with `--remote` the agent loop and its shell tools run in the server, so the
`tc start next` the fired prompt asks for is expected to resolve to the same identity the pane's
would. That is an assumption until the first live Codex launch after this shipped confirms it
(`VRF-1825-b3-native-bootstrap`); if it proves false, the pane still has the identity and the fix
belongs in how the server is started, not in the bootstrap. A profile's `preKeys` are withheld on a
native launch too: a preKey is a keystroke, and an Enter on a fresh trust dialog would accept its
default before readiness could refuse `trust_required`. Codex declares none on any path (#2177).

**Readiness is read from the protocol; the pane is consulted in one case only.** Before a send the
adapter needs all of: the app-server's `initialize` version equal to the installed and the recorded
one; `config/read` naming the project directory as trusted, or the trust exception below;
`account/read` naming an account; `account/rateLimits/read` explicitly allowing
usage or reporting a usable credit balance; exactly one loaded thread whose canonical cwd is the
project directory (the recorded one once seen); and that thread `idle`. On a version that declares
`capabilities.wake.restRows` the launch's thread is chosen by identity, described under
`observeActivity` below, and a fire, automatic or the operator's, is also refused
(`engine_not_ready`) while any other thread loaded for the folder is working, in a status the
protocol does not promise, or unreadable. An unknown answer fails
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

**A folder with no trust entry in Codex's config (#2186).** A new project, a renamed directory or a
fresh clone path has no entry in Codex's `config.toml`. `config/read` says so (`projects` without the
folder, or `projects: null` on a home that has never trusted one). Under `--remote`, Codex 0.156.1
was measured to draw **no** trust dialog for such a folder: the pane reaches its ordinary composer.
That is a measurement of one version, not a promise about Codex. So the blocker never claims a dialog. It says what was read and how to grant trust: add the folder
under `[projects]` in Codex's `config.toml` with `trust_level = "trusted"`, or run `codex` once in
the folder outside TangleClaw and accept its prompt, then Fire again.

The operator's decision is that such a fire may go, without a trust entry, when everything else is
in order. **That allowance is active on Codex 0.156.1 and on no other version**: it applies only to
versions listed in the profile's `startupControl.remoteTrustPrompt.absentOn`, and a version is listed
only after its own signed-in fire has been probed. 0.156.1 was probed on 2026-10-11 (#2186), by the
operator's **Fire** in two new folders with no trust entry: both fires were accepted and applied, the
pane drew no trust dialog, and Codex's config held no trust entry afterwards. In the folder that
carried its own `.codex/config.toml` and hooks, no hook ran and the folder's config was not applied:
Codex itself disables project-local config, hooks and exec policies until the project is trusted
(skills still load), and says so in a startup warning. So a fire sent this way reaches a session
running on the home's settings, not the folder's. The automatic launch fire goes through the same
rule, after the launch's readiness gate above, and was probed signed-in on 2026-10-12 (0.156.1,
Codex's default status line): applied with no hand Fire in a trusted folder and in a folder with no
trust entry. For a listed version the fire goes only if all of
this holds:

- every other check passes (version, account, usage, the launch's own thread loaded and `idle`);
- a **pane witness** pins the id of the session's one pane (a session with a second pane or window is
  refused: there is no saying which pane a launch meant), requires it to be the pane the launch itself
  created (the id is the one the `tmux new-session` that created the session printed, recorded on the
  launch's channel and never looked up from the session afterwards; a pane that replaced it at any
  point, or a launch with no pane on record, is refused) in the tmux server that created it (the
  server's process id and start time are recorded from the same print and checked in every read: a
  restarted tmux issues the same pane ids again, to other panes), then reads THAT pane and its cursor in one
  row-aligned read (one tmux invocation, both of its commands aimed at the pinned id and its answer
  checked for pane and session; the pane is not held still across it), twice, a second apart,
  and both reads show: no declared guarded dialog as the live screen; the cursor ON the last bare
  composer row, by its row number, with nothing typed (an earlier composer row that reads the same is
  a different row); nothing below that row but blank rows and at most one status row of the shape
  Codex draws (indented, items joined by ` · `, and naming none of the keys a dialog footer names:
  a row that says `enter`, `esc`, `tab`, `space` or an arrow is a footer. Codex's own
  `1 warning · f2 to view` item is part of a status row and passes); no header still reading `model: loading` as the
  newest one (a session that has scrolled its header away passes this); no busy marker; and an
  unchanged pane. A read that does not come back with exactly the pane's height in rows is refused.
  A Codex status line configured down to a single item has no ` · ` and is refused: that fails
  closed. **Which rows may follow the composer is chosen by the launch's exact proved version**
  (the version the launch recorded and the one its app-server reports, equal; never the installed
  binary's). A version with no `capabilities.wake.restRows` entry, which is 0.156.1, is read by the
  one-row rule just described, under which any screen that draws a footer is refused. A version
  with an entry (0.161.0, 0.162.0) must show exactly **one status row and then its declared footer
  row**, in that order: the footer with no status row above it is refused as a screen still opening
  or resuming, and so are the status row alone, two footers, the two rows in the other order and
  any third row; both rows are read for key names. On such a version one single-item status row is
  recognised: the launch thread's own **model**, as `thread/read` reports it, alone on the row and
  compared without case (`  GPT-6.1-Sol` for `gpt-6.1-sol`); the thread must report the same model
  again after the pane is read. No other single item is recognised, and an **empty status line**
  is refused (its one row is the footer with a context item beside it), so on those versions the
  operator's status line needs at least the model or two items, or the operator presses **Fire**.
  A launch whose version cannot be proved is refused outright and says which two versions were
  read; that does not clear by waiting. The pane alone does not show a streaming turn on those
  versions (no busy row is drawn once the answer streams), so the last step below is what refuses
  one;
- the same thread, read again after the witness and immediately before `turn/start`, is still in
  the project directory and still `idle`.

A trust dialog actually on the pane refuses the fire as `trust_required`, worded as read from the
pane. Any other dialog (the update prompt), and anything else short of a proven composer, refuses it
as `pane_not_ready`, naming what was seen. A folder whose entry in Codex's config says anything other
than trusted is not "no entry": it is `trust_required`, says so, and never gets the allowance. A
`config/read` answer that cannot be understood stays `readiness_unknown`. The automatic launch fire
and the operator's **Fire** go through the same rule. Nothing writes a trust entry and no
trust-acceptance key is typed: the prompt itself reaches the pane as an ordinary user turn. A fire that goes this way records a **dispatch note** on its row, kept through every later
outcome and shown in the Launch readiness panel: this pane showed an empty composer and no declared
trust prompt at fire time, the thread was idle, and TangleClaw did not grant trust.

`remoteTrustPrompt.absentOn` is a different claim from `verifiedVersions`. The second attests the
protocol on a version; the first records that the version was measured, with its own probe, to reach
a composer without a trust entry. Every entry must also be in `verifiedVersions`, and an entry never
permits a send without the witness.

**The adapter contract** (what `ADAPTERS` entries implement): `installedVersion()` (synchronous,
cached, never spawns); `probeVersionSync({enginePath})` (the launch path only), and optionally
`probeForLaunch({enginePath})`, the same probe returning `{version, enginePath}` so the launch can hand it
to the later steps as `probe` instead of asking again; `prepareLaunch({project,
engineProfile, launchCmd, enginePath, env, probe})` returning `{ok, handle, command}` or `{ok: false, reasonCode,
reason}` (`env` is the pane's environment, which the server must inherit); `attachLaunch(handle, {sessionId, sequenceId, engineId})`; `abandonLaunch(handle, reason)`;
`releaseSession(sessionId, reason)`; `reap()`; `recover()`; `start()`/`stop()`;
`fire({session, project, sequenceId, promptText, promptTextDigest, payloadDigest, onUpdate,
trustException, automatic, paneWitness})` returning `{accepted, settled}` promises (`trustException` is `{absentOn, witness}`,
supplied by the fire service for every fire; `automatic: true` and `paneWitness` are present only on the
launch's own automatic fire, set by the service from the caller it resolved and never inferred by an
adapter; an adapter with no use for any of them ignores it); and `reconcile({session, fire, onUpdate})`. Every
transition an adapter reports goes through the store's transition map, so no adapter can move a fire
backwards or out of a terminal outcome.

**Optionally, `awaitLaunchReady({session, project, sequenceId, witness, windowMs})`** (#2059): the
launch's readiness gate, described above. It resolves `{ready: true}`, or `{ready: false,
unavailable, observation, remedy}` at the end of its window (or at once, for a refusal waiting
cannot clear), where `observation` is the last thing it actually read and `unavailable` says the pane
or the channel could not be read at all. `witness` is the fire service's pane witness for the
session: it takes the adapter's own patterns, `single: true` for one read instead of two, and its
answer carries `unavailable: true` when the pane could not be pinned or read. Callers go through
`startupControl.awaitLaunchReady`, which adds the `unsupported` and `unknown` answers. An adapter
that implements it must also make its automatic fire look again before it sends: a gate's answer
ages.

**Optionally, `observeActivity(channel, project)`** (#1628): a read-only answer to "is this session's
engine working right now?", returning `{state: 'idle'|'busy'|'unknown'|'held', reasonCode}`. Callers never
reach an adapter directly. They go through `startupControl.observeActivity({session, project, channel,
sequence})`, which answers `{channel: 'absent'|'present', state, reasonCode}`. **Absent** means the
session has no open channel. **Present** covers everything else, and there `unknown` is returned for
any of these: a channel that is not this active session's, or not of its current launch, engine or
project; an unregistered adapter or one without the method; a throw; an out-of-vocabulary answer. In
all of those cases the adapter is either never asked or not believed. `startupControl.declaresObserver(engineId,
getProfile)` says whether an engine's profile names an adapter that can observe it, independent of the
version probe. It is an observation, never permission: it checks no account or quota, and `idle`
does not authorize a fire. `held` is an adapter's answer for a thread that is idle in a place its
engine's own configuration says not to type; the reason code names the rule, and the facade passes
it through as it does the other three states.

The Codex adapter reads it from the protocol alone and opens no turn. It speaks only for the launch's
own app-server process (command, socket and birth time) on the installed and recorded version, and for
the launch's recorded thread, which it identifies exactly (#1978). Other loaded threads whose canonical
cwd is the project directory (subagents, or a thread the operator opened) cannot make the recorded one
unknowable, but they can hold the answer:
- If any of them is `active`, the answer is busy. A thread started from the TUI leaves the recorded one
  idle while it works, and the pane shows that work. The reason code is `subagent-active` or
  `other-thread-active`, read from the protocol's subagent metadata (`parentThreadId`, or a `subAgent`
  `source`).
- If any of them has a status outside `idle`, `systemError` and `notLoaded`, the answer is `unknown`
  (`other-thread-status-unknown`).
- A resting extra thread holds nothing.

A channel whose thread was never recorded (its startup fire was blocked or never ran) has it
bound here, to the **sole** loaded project thread. The bind is TangleClaw's own metadata, written
compare-and-set (`startupControlChannels.updateAdapterStateIf`), so it never replaces a recorded
thread. The bind that lands first wins, and a lost race answers `unknown`. Because that bind was an
inference from "the only one", in that same observation "the only one" is established again from a
fresh read, and a second thread there answers `thread-ambiguous`. Given all that, the thread's `active` status is busy (an
approval wait included) and `idle` is idle. Before an `idle` is returned, the channel row is read
again: it must still be open, on the same launch, with the same thread.

**On Codex 0.161.0 and 0.162.0 "the sole thread" is the sole thread identified as the launch's
own** (#2059), because after a first turn those versions load a second thread in the same folder to
name the session, and it stays loaded. Read from `thread/read` and nothing else, and only once the
channel's version is proved to be one that declares `capabilities.wake.restRows`:

- the launch's kind is `threadSource: "user"`, `ephemeral: false`, a non-empty rollout `path` and no
  `parentThreadId`;
- the title helper is exactly `threadSource: "thread_title"`, `ephemeral: true`, `path: null`. It is
  never bound, even when it is the only thread loaded, and it never makes two. It is not treated as
  a subagent and is not ignored: while it is `active` the answer is busy (`other-thread-active`), and
  a fire is refused beside it;
- any other thread for the folder, including either shape with a field missing or changed, cannot
  be identified, and an unbound channel then answers `thread-ambiguous` and binds nothing. Two
  threads of the launch's kind are ambiguous as before, and a thread that cannot be read refuses.

A recorded thread stays the launch's and is never replaced by this filtering; a recorded thread that
is no longer loaded does not fall back to another. The compare-and-set and the fresh read after it
are unchanged, and now require the same sole thread of the launch's kind. On those versions the
launch gate, a fire and this observation bind by one procedure, and an inferred binding is **not a
record until it is proved**:

1. the first list names exactly one thread of the launch's kind, and none that cannot be read or
   identified;
2. a compare-and-set, on the launch's own open channel with no thread of either kind on it, writes
   the thread as **provisional**, in its own field (`adapterState.provisionalThreadId`), and leaves
   `adapterState.threadId` empty. A write that fails, or that this look did not itself make
   (`written: false`, even where the row then holds the same thread: another reader may still be
   mid-check, or may fail it), binds nothing here and nothing is sent;
3. the threads are listed and read **again** and must be the same threads with the same sole thread
   of the launch's kind. A second user thread, a title helper or an unreadable thread that appeared
   in between fails this; reading only the chosen thread again would not show them;
4. a second conditional write, on that same thread while it is still the provisional one, moves
   it to `threadId` and clears the provisional field. Only then is the thread recorded, and that
   write too must be this look's own.

A check that fails after step 2 withdraws the inference by a guarded write (only that thread, only
while it is still the provisional one) and the look refuses, whether or not the withdrawal lands.
Because the recorded field stays empty until step 4, every reader of the recorded thread, here and
elsewhere (a fire's reconcile, a managed rotation's prior and successor thread, its rebind), sees a
channel that is not yet bound while an inference is unproved. The next look proves a provisional
thread again from step 1 (skipping only the first write) or withdraws it, so a second idle user
thread cannot be stepped past on an id nobody validated. Before the gate or a fire answers for a thread, proved just
now or recorded earlier, the channel row is read once more: still open, the same launch, the same
thread, and no provisional thread beside it. And where the gate or a fire reads the pane, what
is read afterwards on those versions is this whole answer again for the recorded thread (every loaded
thread, the others' activity, the channel row), not that one thread alone: a thread that started
working, or stopped being readable, while the pane was being witnessed refuses the look. On those versions the
answer also carries `version`, the exact version proved, which the wake's pane gate reads the pane
by; an answer for 0.156.1 carries none, and its candidate rule is the one above, unchanged.

#### `privateTempRoot`

Claude Code has its own **native cross-session messaging**: each session listens on a Unix socket, by
default at `/tmp/cc-socks/<pid>.sock`. This is not the Medusa switchboard. Medusa is TangleClaw's
transport, with its own listener that TangleClaw runs, and it works whatever this section says.
Native messaging is Claude's, and Claude switches it off at startup ("Cross-session messaging is
off: its socket directory could not be set up") when any directory on the socket path is world- or
group-writable without the sticky bit, or owned by someone other than you or root. Claude is right to
refuse that directory, because another local user could replace the socket. The effect is that one
badly-moded `/tmp` (macOS `/private/tmp` at `0777` instead of `1777`) turns native messaging off in
every session (#1904).

A profile that declares `privateTempRoot` gets a private root for each launch instead:

```json
"privateTempRoot": {
  "env": "CLAUDE_CODE_TMPDIR",
  "socketSuffix": "cc-socks/4194304.sock",
  "maxSocketPathBytes": 103,
  "platformRootEnv": "XDG_RUNTIME_DIR",
  "defaultRoot": "/tmp"
}
```

At launch, `lib/engine-temp-root.js` creates `<TangleClaw base>/run/<engine>-tmp` (normally
`~/.tangleclaw/run/claude-tmp`) at mode `0700`, and checks it the way the engine will. The run
directory and the leaf must be real directories, not symlinks. The leaf must be yours, at `0700`.
Every ancestor of its real path must be owned by you or root, and none may be group- or
world-writable without the sticky bit. The real path plus `socketSuffix` (the widest possible pid)
must fit in `maxSocketPathBytes`. A root that passes is exported to the pane, and to the Project
Master's pane, as `env`. It sits above the ambient floor and below the profile's own `launch.env`.
Setting the variable yourself, in `launch.env` or in TangleClaw's own environment, means TangleClaw
provisions nothing.

**It fails closed, and it never repairs a system directory.** A root that does not pass is not
handed to the engine. The launch goes ahead, and the server log records the failing path and a
command for you to run by hand. It also records whether the engine's default location
(`platformRootEnv`, else `defaultRoot`) will work, and if not, which ancestor fails. The launch response (`POST /api/sessions/:project`) carries the same account as
`privateTempRoot`, or `null` for an engine that declares no root. TangleClaw never changes the mode of `/tmp`,
`/private/tmp` or any directory it does not own. The only `chmod` it performs is tightening its own
leaf back to `0700`.

`CLAUDE_CODE_TMPDIR` also moves Claude's other temporary files (its scratchpad included) under the
same private root. Unlike `/tmp`, which the OS clears periodically, nothing clears this root yet, so it
grows with use. To reclaim the space, stop every Claude session TangleClaw runs, then run
`rm -rf ~/.tangleclaw/run/claude-tmp/*`. TangleClaw recreates the root at the next launch. Do not
clear it while sessions are running: their live sockets and scratchpads are inside it. When `XDG_RUNTIME_DIR` is set, Claude still puts its sockets there, because that
variable ranks first. It is normally a safe per-user directory, and TangleClaw does not override it,
because every other program in the pane reads it too.

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

**This repository's own tracked block is held to the generator by a test (#1796).**
`test/claude-md-operational-block.test.js` renders the block with the production generator and
splice and compares it with the region between the markers of the tracked `CLAUDE.md`; it reads the
file and never writes it. So a change that moves the generator's output (a new `tc` verb in
`lib/tc-verbs.js#VERB_ROSTER`, an edited guide under `data/`, a reworded guidance line) carries the
tracked block in the same PR: run `node scripts/sync-claude-md-block.js --write`, which replaces
only the marked region, and commit the result. With no argument the script compares, writes nothing
and exits 1 on a difference. Because sections are omitted when their source is absent, the tracked
block stands for one named profile, pinned in that script: the switchboard on, the PortHub guide
on, the install's service-token gate off, and no shared document registered as injectable for the
project. A checkout launched with other settings still shows an uncommitted `CLAUDE.md`; that is
its settings, not drift, and it is not committed. The same happens when the installed server is
older or newer than the checkout: a launch rewrites the block with the installed server's generator,
while the test compares against the checkout's. So a branch that adds a `tc` verb and is relaunched
before the deploy has its `CLAUDE.md` rewritten back and the test fails locally on a non-defect;
`node scripts/sync-claude-md-block.js --write` restores the tracked bytes.

**A governed file TC once wrote whole can hold the guide twice (#1911).** The first governed write
appends the managed block and leaves everything outside it alone. So when a project was launched
in whole-file mode before the plugin was onboarded, TC's earlier guide stays above the
`PRAWDUCT:ANCHOR` and the block repeats it: the bootstrap bullets, and the PortHub, Shared
Documents, Session Memory and (where present) Medusa sections. TC **detects this and never repairs
it on its own** (Architect A7/A10). A launch or boot logs a warning, and the governed launch
context gains a note for the operator.

A matching heading does not prove the operator left the section's body alone, so removal is the
operator's explicit action:

```
node scripts/repair-governed-claude-md.js <project-path>                   # preview; changes nothing
node scripts/repair-governed-claude-md.js <project-path> --apply <digest>  # apply that exact preview
```

**What the preview lists.** It lists each removal with its line range and bytes, and says whether
each section's body is identical to the managed copy. It prints a digest that binds the file and
the plan together.

**What `--apply` checks.** It refuses if the file or its plan changed since the preview, and it
re-hashes the file just before replacing it. It writes atomically, keeps the file mode, and refuses
a read-only carrier. It also refuses a symlinked carrier, which it never follows or replaces. It writes every byte or refuses without replacing the file. It writes nothing on any refusal, and a second run finds nothing to do. Every command TangleClaw prints for this is shell-quoted word by word, so any legal project path survives it (Architect A22).

**What is never removed.** The Core, Extension and Global rules copies are never touched (A9):
they are the operator's hand-kept copy. Nor are any section the block lacks, and anything from the
anchor on. The `# CLAUDE.md — Generated by TangleClaw` header becomes `# CLAUDE.md` only when it is
byte-identical to the generated form (A8).

**What refuses.** Analysis refuses a duplicate candidate heading, an unterminated code fence, more
than one anchor, an anchor inside or after the block, and malformed markers. The logic is in
`lib/legacy-claude-md.js`.

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

One setting does not follow the project to the new engine: the **default launch mode** (#2189). A launch mode is a choice about one engine. Several engines name a mode `bypassPermissions`, and each means something different by it (Codex's removes the sandbox as well as the approvals), so a mode chosen for the old engine is not treated as chosen for the new one. Changing the engine resets the default launch mode to Interactive unless the same save chooses a mode for the new engine, and the save says when it did. Choosing Bypass for the new engine while the launch-mode picker is hidden asks for the confirmation again.

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

## Model selection (`models`)

An engine profile that can be launched with a chosen model declares which ones. A profile with no `models` block offers no model selection, and TangleClaw passes the engine no model argument.

```json
"models": {
  "flag": "--model",
  "offered": ["gpt-5.6-sol", "gpt-6-luna"],
  "roster": { "source": "codex-models-cache", "maxAgeHours": 168 }
}
```

| Field | Meaning |
|---|---|
| `flag` | The CLI flag that takes the model id |
| `offered` | The allowlist: the model ids TangleClaw will offer for this engine. Each is letters, digits, dots, hyphens and underscores, starting with a letter or digit |
| `roster.source` | The name of a roster reader in `lib/engine-models.js`. A profile names a reader; it cannot supply one |
| `roster.maxAgeHours` | Optional. A roster older than this is treated as unreadable. Codex declares 168 (seven days), a provisional bound: a judgment about how stale a list may be and still be called current, not a measured property of the CLI |

A model can be selected only when it is in `offered` **and** in the roster the installed CLI reports at that moment. The two lists do different jobs. The allowlist is a decision: a CLI's roster also holds entries nobody chose to offer (Codex's lists hidden and internal models). The roster is the CLI's own account of what it can run for this account, read fresh every time, so a model the CLI drops stops being selectable without a TangleClaw release.

`lib/engine-models.js` answers every model question, so saving, launching and listing choices cannot disagree:

- `selectionState(profile)` says where the engine stands: `none` (no `models` block), `invalid` (a block that cannot be used, with the reasons) or `ok`. It has three answers so that a broken profile is never mistaken for an engine that offers nothing.
- `offeredWithAvailability(profile)` returns that state with every offered model, each with `available` and, when it is not, a `reason`. An unavailable model is still returned, so a UI can show it as unavailable instead of dropping it.
- `checkSelection(profile, modelId)` returns `{ok: true}` or a refusal with a stable `code` and a `reason`: `MODEL_MALFORMED`, `MODELS_BLOCK_INVALID`, `ENGINE_HAS_NO_MODELS`, `MODEL_NOT_OFFERED` (which is also what another engine's model gets), `ROSTER_UNAVAILABLE`, `MODEL_UNAVAILABLE`.
- `modelArgv(profile, modelId)` returns the flag and the quoted id for the launch command.

Nothing here substitutes a model. A selection that cannot be confirmed is refused.

The roster says the CLI lists a model for this account. It does not prove the account can run it; only a completed turn on that model does.

A profile whose `models` block is present but invalid is a fault, not an engine without model selection: the validation errors are logged once, reported by `selectionState` and `offeredWithAvailability` as `invalid`, and any selection for that engine is refused with `MODELS_BLOCK_INVALID`.

**Readers.** `codex-models-cache` reads `models_cache.json` under `$CODEX_HOME` (default `~/.codex`), which the Codex CLI rewrites with a fetch time whenever it starts. The roster is unreadable (`ROSTER_UNAVAILABLE`, with what to do about it) when the file is missing or malformed, carries no fetch time, is older than `maxAgeHours`, or is dated more than five minutes into the future. Starting Codex once refreshes it. A fresh list is not proof the account can run a model.

**Which engines declare it.** Codex. Antigravity does not yet: no record has been measured that names the model of a completed turn and ties it to one launch, and offering a model TangleClaw could not confirm it launched would be worse than not offering one.

**Status.** The block and the module are in place. Nothing reads them at save or launch yet, so no project setting, API field or launch command has changed (#2188 is being built in steps).

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

**What the operator sees.** The engine-error monitor's per-tick read of every live tmux pane (every few seconds) is the capture; there is no second loop. A match records `lastEngineError = { type, status, message, timestamp }` on the session, which reaches `GET /api/sessions/:project/status` and the project's `session` object in `GET /api/projects`. The session page shows a banner above the terminal naming the status, the error type and the provider's message; the project card on the dashboard carries a red `⚠ HTTP <status>` badge with the same detail in its tooltip.

**When it clears — stated honestly.** TangleClaw cannot see an API call succeed; it sees the pane's captured tail. The error is reported for as long as a matching line is inside that tail, and clears the first time a capture no longer contains one — which is what the next successful prompt looks like from outside: the engine produced enough new output to push the error line off the captured rows. An error still on screen stays reported even after the operator has fixed the cause, until the terminal moves past it; a repeated error re-arms with a fresh timestamp once the previous one has scrolled away. A capture that came back empty — tmux failed or timed out — is no reading at all and changes nothing, so a flaky tmux cannot flash the card healthy for a tick and re-stamp the same error as new. Detection applies to tmux sessions; a Web UI (gateway) session has no pane to read.
