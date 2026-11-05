# Produce the local project scorecard

An operator or a scheduled job runs this. It writes `<base>/scorecard/v1.json`, the file the
plan pages' **Project Health** and **Recent Progress** cards read (#1949, #2144).

## When to use this

The scorecard cache is missing, stale, or you changed something that should be reflected in it
(a figure looked wrong, the window length changed). Running it replaces the whole file
atomically — the cards show either the old figures or the new ones, never a partial write.

**Not this runbook:** you want to verify the published `metrics` branch history, not the local
development-figures cache. Run `node scripts/scorecard-verify.js` instead; it is unrelated to
this file.

## Before you start

- **Needs `gh`, authenticated, in a checkout of this repository.** The script resolves the
  repository's `owner/name` from `gh repo view` and reads issues, pull requests and milestones
  through the GitHub Search and REST APIs. A `gh` that cannot run, or isn't logged in, makes the
  whole run refuse rather than write a partial or guessed document.
- **Day boundaries are UTC, not Pacific, by a few hours.** The scorecard's day-by-day figures
  are defined in `America/Los_Angeles` calendar days, but GitHub's Search API `created:`/
  `closed:`/`merged:` date qualifiers bucket by UTC day. A few hours around midnight Pacific can
  land in the adjacent day's bucket. This is a known, accepted limitation of reading from Search
  rather than a bug — there is no sub-day-precision search qualifier to correct it with.
- **`carsCompleted` is always `0`.** A "car" is a `LANE_QUEUE.md` lane-assignment grouping, never
  a first-class GitHub object, so there is no query that answers it. #2144 left this open; until
  a real source is decided and wired up (a new car, not this one), every scorecard this script
  produces reports zero cars completed, every day, both windows. `trainsCompleted` IS real — it
  reads closed GitHub Milestones, this repo's existing release-train convention.
- **No schedule is decided.** #2144 also left "who runs this and how often" open. Run it by hand
  whenever you need fresh figures, or wire a periodic job (a `launchd` plist on this host,
  analogous to the existing `com.tangleclaw.roadmap-sync` job) — that wiring is a follow-up, not
  part of this script.
- **The optional `certification` section is never populated here.** This script only ever writes
  the `development` section. Wiring a real release-certification summary
  (`lib/release-certification/scorecard.js#certificationSummary`) into the cache is a separate,
  not-yet-scoped follow-on.

## Steps

From a checkout of this repository, with `gh` authenticated:

1. Dry-run against a throwaway directory first, to see the figures before touching a real
   install's cache:
   `node scripts/scorecard-produce.js --base /tmp/scorecard-check`
   → Expected: one JSON line, `{"file":"/tmp/scorecard-check/scorecard/v1.json","generatedAt":...,"freshUntil":...}`.
   → If it refuses: `could not gather scorecard figures: <reason>` means a `gh` call failed —
     check `gh auth status` and that the checkout's remote is this repository.
     `scorecard refused: <reason>` means the computed document itself failed validation — file
     this as a bug in `lib/scorecard-producer.js`, not something to work around by hand.

2. Read back what it wrote, to see the actual figures:
   `cat /tmp/scorecard-check/scorecard/v1.json`
   → Expected: a `tc.scorecard/v1` document with a populated `development` section and no
     `certification` key.

3. Once satisfied, run it against the real TangleClaw base directory (`$TANGLECLAW_HOME`, or
   wherever this host's install actually reads `scorecard/v1.json` from):
   `node scripts/scorecard-produce.js --base "$TANGLECLAW_HOME"`
   → Expected: the same one JSON line, now naming the real cache path.

4. Confirm the plan pages pick it up: reload a plan page and check the Project Health and Recent
   Progress cards show figures instead of "no scorecard has been published."
   → If they still say that: re-check the path in step 3 — the cards read exactly
     `lib/scorecard-cache.js#cachePath(baseDir)`, i.e. `<baseDir>/scorecard/v1.json`.

## Options

- `--window-days N` — the comparison window length (default 7, matching "Last 7 days" /
  "Preceding 7 days"). The baseline window is always the same length, ending the day before the
  current window starts.
- `--fresh-hours N` — how long the written document stays fresh before cards show it under a
  Stale warning (default 6, matching the shipped fixture). Pick this to agree with however often
  you actually run the script — a job that runs every 2 hours wants a longer `--fresh-hours` than
  its own interval, or every gap between runs shows stale figures.
- `--repo <dir>` — the checkout `gh` resolves the repository and credentials from, if different
  from where you're running the script (default: the current directory).
