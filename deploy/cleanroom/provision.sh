#!/usr/bin/env bash
set -euo pipefail

# tc-cleanroom provisioner — stands up (or tears down) the TangleClaw
# first-run acceptance-gate container on the habitat Docker host.
#
# Run FROM the TangleClaw repo on cursatory:
#   ./deploy/cleanroom/provision.sh          # bundle repo, ship, compose up, clone inside
#   ./deploy/cleanroom/provision.sh --down   # compose down tc-cleanroom ONLY
#
# Safety rails (habitat runs production stacks — openclaw-*, tiltclaw-*, uci-*):
#   - Every docker/compose invocation is pinned to project `tc-cleanroom` via
#     an explicit -f/-p; nothing here can list, stop, or remove anything else.
#   - The image is pre-baked on habitat (pull_policy: never in compose.yaml);
#     this script performs no pulls, honoring the no-egress lockdown.
#   - The repo travels as a git bundle over scp — the container needs no
#     network to "clone" it, preserving the internal-only network.
#
# The PATH export below is mandatory for ssh-driven docker on habitat: the
# non-interactive PATH lacks /usr/local/bin, and credential helpers live in
# the Docker.app bundle.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly HABITAT="habitat"
readonly REMOTE_DIR="tc-cleanroom"
readonly DOCKER_PATH_EXPORT='export PATH="/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"'
readonly COMPOSE="${DOCKER_PATH_EXPORT}; docker compose -f ~/${REMOTE_DIR}/compose.yaml -p tc-cleanroom"

if [ "${1:-}" = "--down" ]; then
  # shellcheck disable=SC2029
  ssh "$HABITAT" "${COMPOSE} down"
  echo "tc-cleanroom is down (image and ~/${REMOTE_DIR} left in place)."
  exit 0
fi

echo "==> Bundling repo (HEAD of current branch)"
BUNDLE="$(mktemp -d)/tc.bundle"
git -C "$REPO_DIR" bundle create "$BUNDLE" HEAD --quiet

echo "==> Shipping compose.yaml + bundle to ${HABITAT}:~/${REMOTE_DIR}/"
ssh "$HABITAT" "mkdir -p ~/${REMOTE_DIR}/bundle"
scp -q "${SCRIPT_DIR}/compose.yaml" "${HABITAT}:${REMOTE_DIR}/compose.yaml"
scp -q "$BUNDLE" "${HABITAT}:${REMOTE_DIR}/bundle/tc.bundle"
rm -rf "$(dirname "$BUNDLE")"

echo "==> compose up (project tc-cleanroom, pre-baked image, no pulls)"
# shellcheck disable=SC2029
ssh "$HABITAT" "${COMPOSE} up -d"

echo "==> Fresh clone inside the container (simulates git clone, zero egress)"
# shellcheck disable=SC2029
ssh "$HABITAT" "${DOCKER_PATH_EXPORT}; docker exec tc-cleanroom-tc sh -c 'rm -rf /root/TangleClaw && git clone -q /bundle/tc.bundle /root/TangleClaw && cd /root/TangleClaw && git log --oneline -1'"

echo "==> Ready. Drive the walkthrough with:"
echo "    ssh ${HABITAT} '${DOCKER_PATH_EXPORT}; docker exec -w /root/TangleClaw tc-cleanroom-tc <cmd>'"
