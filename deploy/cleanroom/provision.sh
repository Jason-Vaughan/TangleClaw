#!/usr/bin/env bash
set -euo pipefail

# tc-cleanroom provisioner — stands up (or tears down) the TangleClaw
# first-run acceptance-gate container on a remote Docker host.
#
# Run FROM the TangleClaw repo on your TangleClaw host machine:
#   export TC_CLEANROOM_HOST=<ssh-host>      # your Docker host (an ssh alias or user@host)
#   ./deploy/cleanroom/provision.sh          # bundle repo, ship, compose up, clone inside
#   ./deploy/cleanroom/provision.sh --down   # compose down tc-cleanroom ONLY
#
# The host is a REQUIRED environment variable with no default, deliberately: a
# hardcoded fallback would either leak whichever machine the maintainer happens
# to use, or silently point your teardown at the wrong box. Unset fails loudly.
#
# Safety rails (assume the Docker host also runs stacks you care about):
#   - Every docker/compose invocation is pinned to project `tc-cleanroom` via
#     an explicit -f/-p; nothing here can list, stop, or remove anything else.
#   - The image is pre-baked on the host (pull_policy: never in compose.yaml);
#     this script performs no pulls, honoring the no-egress lockdown.
#   - The repo travels as a git bundle over scp — the container needs no
#     network to "clone" it, preserving the internal-only network.
#
# The PATH export below is mandatory for ssh-driven docker on a macOS Docker
# Desktop host: the non-interactive PATH lacks /usr/local/bin, and credential
# helpers live in the Docker.app bundle.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REMOTE_DIR="tc-cleanroom"
readonly DOCKER_PATH_EXPORT='export PATH="/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"'
readonly COMPOSE="${DOCKER_PATH_EXPORT}; docker compose -f ~/${REMOTE_DIR}/compose.yaml -p tc-cleanroom"

# Strict argument gate: the Docker host may run stacks you care about, so a typoed teardown
# flag must fail loudly here — never fall through to a surprise provision.
#
# This runs BEFORE the host is resolved, deliberately. Argument validation needs
# no remote host, and an unrecognized argument must report *itself* — if the host
# lookup came first, a typoed flag on a machine with TC_CLEANROOM_HOST unset would
# complain about the environment and never mention the bad argument.
case "${1:-}" in
  --down|'') ;;   # recognized: teardown, or no args → provision
  *)
    echo "usage: $0 [--down]   (unrecognized argument: $1)" >&2
    exit 2
    ;;
esac

# Host is required with no default: a hardcoded fallback would either leak
# whichever machine the maintainer happens to use, or silently point a teardown
# at the wrong box.
readonly CLEANROOM_HOST="${TC_CLEANROOM_HOST:?set TC_CLEANROOM_HOST to your Docker host (ssh alias or user@host), e.g. export TC_CLEANROOM_HOST=my-docker-box}"

if [ "${1:-}" = "--down" ]; then
  # shellcheck disable=SC2029
  ssh "$CLEANROOM_HOST" "${COMPOSE} down"
  echo "tc-cleanroom is down (image and ~/${REMOTE_DIR} left in place)."
  exit 0
fi

echo "==> Bundling repo (HEAD of current branch)"
BUNDLE="$(mktemp -d)/tc.bundle"
git -C "$REPO_DIR" bundle create "$BUNDLE" HEAD --quiet

echo "==> Shipping compose.yaml + bundle to ${CLEANROOM_HOST}:~/${REMOTE_DIR}/"
ssh "$CLEANROOM_HOST" "mkdir -p ~/${REMOTE_DIR}/bundle"
scp -q "${SCRIPT_DIR}/compose.yaml" "${CLEANROOM_HOST}:${REMOTE_DIR}/compose.yaml"
scp -q "$BUNDLE" "${CLEANROOM_HOST}:${REMOTE_DIR}/bundle/tc.bundle"
rm -rf "$(dirname "$BUNDLE")"

echo "==> compose up (project tc-cleanroom, pre-baked image, no pulls)"
# shellcheck disable=SC2029
ssh "$CLEANROOM_HOST" "${COMPOSE} up -d"

echo "==> Fresh clone inside the container (simulates git clone, zero egress)"
# shellcheck disable=SC2029
ssh "$CLEANROOM_HOST" "${DOCKER_PATH_EXPORT}; docker exec tc-cleanroom-tc sh -c 'rm -rf /root/TangleClaw && git clone -q /bundle/tc.bundle /root/TangleClaw && cd /root/TangleClaw && git log --oneline -1'"

echo "==> Ready. Drive the walkthrough with:"
echo "    ssh ${CLEANROOM_HOST} '${DOCKER_PATH_EXPORT}; docker exec -w /root/TangleClaw tc-cleanroom-tc <cmd>'"
