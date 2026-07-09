# Project Map

<!--
A "where things live" map: the structural table-of-contents the agent consults
FIRST before grepping or filesystem search. The top-level-directory skeleton is
auto-generated (seeded on toggle-on, refreshed by the project-map wrap-step);
fill in the descriptions. Distinct from FEATURES.md (#207), which maps features
to file paths — this maps the layout itself.
-->

## Structure

- `data/` — Bundled seed assets — engine profiles, methodology templates + hooks, AI guide docs (PortHub / shared-docs / session-memory), global rules, orchestration profiles, certs.
- `deploy/` — Install + service plumbing — `install.sh`, launchd plists (server / ttyd / caddy), `tmux.conf`, `ttyd-attach.sh`, ingress + VRF runbooks.
- `docs/` — Operator/developer documentation — user, engine, methodology, and configuration guides plus `adr/` (architecture decision records).
- `hooks/` — Git hook templates (pre-commit / commit-msg / post-commit) TC installs into managed projects.
- `lib/` — All server-side modules — store (SQLite), sessions, engines, projects, wrap-pipeline steps, tmux, caddy, porthub, service-token, master, etc.
- `public/` — Browser UI served from disk — dashboard (`index.html`/`ui.js`), session page (`session.js`), styles, service worker (`sw.js`).
- `scripts/` — Operator CLI scripts — `ingress-cutover.js` (reversible caddy/direct switch), `reset-admin.js` (break-glass), capture spike.
- `test/` — The node test-runner suite (`node --test test/*.test.js`, ~3.6k tests) — the project's test contract.

## Shared directories / doc groups

- **AI Inference** → _(no shared directory)_
  - `LITELLM`
  - `TANGLEBRAIN`
  - `TANGLEBRAIN-C1-REPORT`
  - `TANGLEBRAIN-PLAN`
- **Claw Code - X** → `/Users/jasonvaughan/Documents/Projects/clawcode-x`
  - `CHANGELOG`
  - `CLAUDE`
  - `CLAW_CODE_SETUP`
