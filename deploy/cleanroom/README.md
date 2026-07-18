# tc-cleanroom — first-run acceptance gate

A disposable, fully isolated Docker environment for exercising TangleClaw's
first-time-install experience the way a stranger would: fresh clone, follow the
README, and record every broken or dishonest moment as a GitHub issue. Run it
before declaring any install-affecting campaign done.

## Where it runs

On the `habitat` Docker host, driven over SSH from the dev machine. The
container uses the pre-baked `tc-cleanroom-base` image (tmux, git, ttyd, node —
TangleClaw's runtime deps) on an `internal: true` network: zero egress, no
published ports, no reach to the host or the production stacks that share the
box. Everything is driven through `docker exec`. See the header comments in
`compose.yaml` and `provision.sh` for the binding constraints and their
rationale.

The image is baked from `bake.sh` (tracked here) during an operator-opened
network window; re-baking needs another window — the provisioner itself never
pulls.

## Run the gate

```bash
./deploy/cleanroom/provision.sh     # bundle HEAD, ship, compose up, clone inside
# drive the walkthrough:
ssh habitat 'export PATH="/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"; \
  docker exec -w /root/TangleClaw tc-cleanroom-tc <cmd>'
./deploy/cleanroom/provision.sh --down   # teardown (image + staging dir remain)
```

Walkthrough spine (add anything the README's Quick Start promises):

1. `./deploy/install.sh` — observe how it fails or succeeds; error text must be honest.
2. `node server.js` — first boot: config/DB creation, the *effective* listen URL vs what the logs and README claim.
3. Setup wizard flow via API: `GET /api/config` (`setupComplete`), `GET /api/setup/https-check`, `POST /api/setup/scan {"directory": …}`, `POST /api/setup/complete`.
4. `POST /api/projects/attach {"name": …}` against a seeded git repo in the projects dir.
5. `POST /api/sessions/<name>` with no engine binary installed — the failure must name the real problem.

Every gap between what docs/logs claim and what actually happens becomes a
filed issue (`[bug] …`, labeled). The gate passes when a run produces zero new
issues. Port 3310 is PortHub-reserved for this environment should a
127.0.0.1-only publish ever be needed (requires moving off the internal-only
network — a deliberate, operator-ratified change, not a default).

Findings from the 2026-07-18 run: #614, #615, #616, #617 (plus #613 found in
the surrounding session).
