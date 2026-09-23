# Project Map

<!--
A "where things live" map: the structural table-of-contents the agent consults
FIRST before grepping or filesystem search. The top-level-directory skeleton is
auto-generated (seeded on toggle-on, refreshed by the project-map wrap-step);
fill in the descriptions. Distinct from FEATURES.md (#207), which maps features
to file paths — this maps the layout itself.
-->

## Structure

- `bin/` — In-pane CLI shipped to launched sessions — `tc` (whoami + awareness receipts), put on each pane's PATH at launch.
- `data/` — Bundled seed assets — engine profiles, hooks, AI guide docs (PortHub / shared-docs / session-memory), global rules, orchestration profiles, certs.
- `deploy/` — Install + service plumbing — `install.sh`, launchd plists (server / ttyd / caddy), `tmux.conf`, `ttyd-attach.sh`, ingress + VRF runbooks.
- `docs/` — Operator/developer documentation — user, engine, and configuration guides plus `adr/` (architecture decision records).
- `hooks/` — Git hook templates (pre-commit / commit-msg / post-commit) TC installs into managed projects.
- `lib/` — All server-side modules — store (SQLite), sessions, engines, projects, wrap-pipeline steps, tmux, caddy, porthub, service-token, master, etc.
- `public/` — Browser UI served from disk — dashboard (`index.html`/`ui.js`), session page (`session.js`), styles, service worker (`sw.js`).
- `scripts/` — Operator CLI scripts — `ingress-cutover.js` (reversible caddy/direct switch), `reset-admin.js` (break-glass), `gate-fallback.js` + `drill-gate-fallback.js` (stand the login down behind Caddy's password when it breaks), capture spike.
- `test/` — The node test-runner suite (`node --test test/*.test.js`) — the project's test contract.
- `website/` — The public marketing site (Next.js, deployed to Vercel) — `src/app/` pages, `public/screenshots/` gallery. Separate npm project from the server; not part of the node test suite.

## Shared directories / doc groups

_This project belongs to 4 shared-doc groups. Membership is machine-local state, not project structure, so it is not published here — see the TangleClaw UI for this install's groups._
