#!/usr/bin/env bash
# Provision the soak guest VM on the host with tart (#2020).
#
#   host-provision.sh             print the tart commands; run nothing
#   host-provision.sh --execute   run them (operator only; see below)
#
# Creating and starting a VM is an operator-only host action, so running the
# commands needs two separate statements of intent: the --execute flag and
# SOAK_OPERATOR_APPROVED=1 in the environment. Without both, nothing runs.
#
# It refuses an existing VM of the same name rather than reuse it: a
# certification starts from a pristine guest, and deleting a VM is the
# operator's call, not this script's.
#
# Exit codes: 0 done (or printed), 2 usage, 3 refused.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=guest.conf
. "$here/guest.conf"

execute=0
case "${1:-}" in
  '') ;;
  --execute) execute=1 ;;
  *) echo "usage: host-provision.sh [--execute]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then echo "usage: host-provision.sh [--execute]" >&2; exit 2; fi

refuse() { echo "refused: $*" >&2; exit 3; }

# The share is the only host path the guest can see, read-write. Compare real
# paths, so `$HOME/..`, `$HOME/.`, a symlink or a parent such as /Users cannot
# carry the home directory (and ~/.ssh) into the guest.
case "$SOAK_SHARE_DIR" in
  /*) ;;
  *) refuse "SOAK_SHARE_DIR must be an absolute path: $SOAK_SHARE_DIR" ;;
esac
[ -d "$SOAK_SHARE_DIR" ] || refuse "SOAK_SHARE_DIR does not exist: create a dedicated, empty directory for it ($SOAK_SHARE_DIR)"
share="$(cd "$SOAK_SHARE_DIR" && pwd -P)"
home_real="$(cd "$HOME" && pwd -P)"
case "$home_real/" in
  "$share"/*) refuse "SOAK_SHARE_DIR resolves to $share, which is or contains \$HOME ($home_real); use a dedicated directory" ;;
esac
[ "$share" != "/" ] || refuse "SOAK_SHARE_DIR must not be /"

cmds=(
  "tart clone $(printf '%q' "$SOAK_BASE_IMAGE") $(printf '%q' "$SOAK_VM_NAME")"
  "tart set $(printf '%q' "$SOAK_VM_NAME") --cpu $(printf '%q' "$SOAK_CPU") --memory $(printf '%q' "$SOAK_MEMORY_MB") --disk-size $(printf '%q' "$SOAK_DISK_GB")"
  "tart run $(printf '%q' "$SOAK_VM_NAME") --no-graphics --dir=$(printf '%q' "$SOAK_SHARE_TAG:$share")"
)

if [ "$execute" -eq 0 ]; then
  echo "# dry run: nothing executed. Re-run with --execute and SOAK_OPERATOR_APPROVED=1 to run these."
  printf '%s\n' "${cmds[@]}"
  exit 0
fi

[ "${SOAK_OPERATOR_APPROVED:-}" = "1" ] || refuse "--execute needs SOAK_OPERATOR_APPROVED=1: creating a VM is an operator-only host action"
command -v tart >/dev/null 2>&1 || refuse "tart is not installed (installing it is an operator action)"
if tart list --quiet 2>/dev/null | grep -Fxq -- "$SOAK_VM_NAME"; then
  refuse "a VM named $SOAK_VM_NAME already exists; a soak starts from a pristine guest, so delete or rename it yourself first"
fi

tart clone "$SOAK_BASE_IMAGE" "$SOAK_VM_NAME"
tart set "$SOAK_VM_NAME" --cpu "$SOAK_CPU" --memory "$SOAK_MEMORY_MB" --disk-size "$SOAK_DISK_GB"
# Runs in the foreground until the guest shuts down.
exec tart run "$SOAK_VM_NAME" --no-graphics --dir="$SOAK_SHARE_TAG:$share"
