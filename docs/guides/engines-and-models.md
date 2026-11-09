# Engines, models and reasoning effort

A project picks an **engine** (the CLI it launches). Some engines also let a
project pick an exact **model** and, independently, a **reasoning-effort
level** — both apply to the project's *next* launch, never to a session
already running (#2188).

## Model

`lib/engine-models.js` is the single owner of every model question: whether
an engine supports model selection at all, which models it offers, whether
the installed CLI actually confirms one, and the exact argv that selects it
at launch. An engine profile (`data/engines/*.json`) declares model support
with a `models` block:

```json
"models": {
  "flag": "--model",
  "offered": ["gpt-5.6-sol", "gpt-6-luna"],
  "roster": { "source": "codex-models-cache" }
}
```

A model is selectable only when it is **both** in `offered` (TangleClaw's
own allowlist — a CLI's roster can hold entries nobody chose to offer) and
listed by the installed CLI's own roster, read fresh every time a selection
is saved or a launch happens.

## Reasoning effort

Effort is a second, independent axis. It is declared in `lib/engines.js`'s
`ENGINE_EFFORT` map, **not** in the engine's profile JSON — a CLI flag and
its accepted values are a launch-argument concern this file and
`lib/engine-models.js` already own the shell-safety contract for, and
keeping it in code avoids a fourth hand-maintained JSON schema to keep in
sync by hand. `engines.resolveProfile(id)` attaches the matching block onto
whatever profile it returns, in memory only — never written back to the
loaded profile object or its source JSON.

Two shapes exist, picked per engine by how its CLI actually takes an effort
level (verified directly against each installed CLI, not assumed):

- **`mode: 'flag'`** — a bare CLI flag, e.g. Claude's `--effort <level>`.
  `offered` is a static list, the same for every model that engine runs.
- **`mode: 'config'`** — a `-c key=value` config override, for a CLI with no
  dedicated flag. Codex is the only example today: its own
  `~/.codex/config.toml` holds `model_reasoning_effort = "..."`, and there is
  no `--effort` flag at all. Codex is also declared `perModel: true` — its
  real levels differ by model (`codex debug models`, the same JSON
  `lib/engine-models.js` already reads from `~/.codex/models_cache.json` for
  the model axis, carries each model's own `supported_reasoning_levels`), so
  nothing here hardcodes one static list for it.

A `perModel` engine's effort levels can only be answered once a model is
known — `engineModels.offeredEffortsWithAvailability(profile, modelId, deps)`
returns an empty list until one is given, rather than guessing.

### Why Antigravity has no effort block

Antigravity's own live model catalog (`agy models`) lists effort pre-baked
into some model ids as separate entries — `claude-opus-5-5-low`,
`claude-opus-5-5-medium`, `claude-opus-5-5-high` — rather than exposing it as
an axis orthogonal to every model, even though `agy --help` also documents a
standalone `--effort` flag. Declaring a static or per-model block here
without knowing which of the two is actually true could silently
double-apply effort, or conflict with what the model id already states. No
effort selector is offered for this engine until that is resolved.

## Picker endpoints

Two read-only, side-effect-free endpoints back the Settings modal's
selectors — the raw `GET /api/engines/:id` introspection endpoint is
deliberately not one of them (its own comment says a browser caller must
not read it directly):

- `GET /api/engines/:id/models` — `engineModels.offeredWithAvailability`,
  live-judged against the installed CLI.
- `GET /api/engines/:id/effort?model=<id>` — `engineModels.offeredEffortsWithAvailability`.
  `model` is required to get anything back from a `perModel` engine, and
  ignored otherwise.

## Persistence and launch

A project's chosen model/effort are stored in `project.json` as `model` and
`effort` (`lib/projects.js`'s `PROJECT_UPDATE_VALIDATORS`, validated against
the *intended* post-update engine — and, for effort on a `perModel` engine,
the intended model too — before anything is written). Both carry
`divergence: 'next-launch'`: saving a selection never implies a running
session changed, and `lib/sessions.js#launchSession` reads them fresh at the
start of every launch, applying them via `engineModels.modelArgv` /
`effortArgv` in `_buildLaunchCommand`. An unconfirmed selection **refuses the
launch** rather than falling back silently.

`_buildLaunchCommand` also strips any effort argument an engine's own base
launch args already carry before appending the selected one, so a profile
with an effort value baked into its defaults doesn't fight the selection on
every launch.

### One-launch override

`launchSession(options)` also accepts `options.model` / `options.effort` as
a **one-launch override**, the same shape `options.launchMode` already
gives the Launch modal for launch mode: present, it is used for just that
launch, with nothing written back to `project.json`. **Not yet wired to any
UI** — the Launch modal (`public/landing.js`) and the request body it sends
(`lib/routes/sessions.js`) are both out of this feature's scope so far; the
capability is built and tested, ready for a follow-up to connect.

## Session Banner

`public/session.js` reads the project's *next-launch* `model`/`effort`
alongside what the *running* session was actually launched with
(`project.session.launchedModel` / `.launchedEffort`, read from
`profileReconciler.getDesiredProfile('session:<id>')` — the same per-session
record `tc model switch` uses for a live boundary switch). When they differ,
a note is appended to the engine pill's existing health-status detail (its
click popover), naming both values — never replacing the health text, since
either one can finish loading first.
