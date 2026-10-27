### Fixed
- A Medusa session listener's still-unhandled inbox is no longer lost when a wrap ends the
  session: `forgetSession` now captures it before the workspace id is retired, and the
  project's next listener is seeded with it, oldest first, so mail that arrived while a wrap
  was running (and so was never nudged into the pane) survives into the successor session
  instead of being stranded against an identity nobody will ever reconnect as (#1806).
- `injectCommand` now refuses to type into a pane whose project has a wrap running in
  `wrap-run-registry`, the same way it already refuses a pane showing an engine startup
  dialog. `medusa-wake` and `workload-nudge` already checked the registry themselves before
  calling in; this closes the gap for every other caller of the command route — a
  coordinator clearing a Builder, an Observer's restart prompt — which previously had no
  such check (#2269).
