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

execute=0
case "${1:-}" in
  '') ;;
  --execute) execute=1 ;;
  *) echo "usage: host-provision.sh [--execute]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then echo "usage: host-provision.sh [--execute]" >&2; exit 2; fi

refuse() { echo "refused: $*" >&2; exit 3; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The operator runs this with the power to create a VM, and it sources
# guest.conf as shell. So both files, and every directory above them through /,
# must be plain (no symlink, no path that resolves elsewhere), owned by root or
# this operator, and writable by neither group nor others, checked before
# guest.conf is read.
me="$(id -u)"
trust_path() {
  local meta uid perm type
  meta="$(stat -f '%u %Lp %HT' "$1" 2>/dev/null)" || refuse "cannot stat $1: this checkout is not trusted"
  read -r uid perm type <<< "$meta"
  [[ "$uid" =~ ^[0-9]+$ ]] && [[ "$perm" =~ ^[0-7]{3,4}$ ]] || refuse "cannot read the owner and mode of $1"
  case "$2:$type" in file:'Regular File'|dir:Directory) ;; *) refuse "$1 is a '$type', not a plain ${2}: this checkout is not trusted" ;; esac
  [ "$uid" = 0 ] || [ "$uid" = "$me" ] || refuse "$1 is owned by uid $uid, not root or you ($me)"
  [ $(( 8#$perm & 8#022 )) -eq 0 ] || refuse "$1 is writable by group or others (mode $perm)"
}
[ "$(cd "$here" && pwd -P)" = "$here" ] || refuse "$here is reached through a symlink: the path is ambiguous"
trust_path "$here/host-provision.sh" file
trust_path "$here/guest.conf" file
d="$here"
while :; do trust_path "$d" dir; [ "$d" = / ] && break; d="$(dirname "$d")"; done

# shellcheck source=guest.conf
. "$here/guest.conf"

# The share is the only host path the guest can see, read-write. Compare real
# paths, so `$HOME/..`, `$HOME/.`, a symlink, a parent such as /Users, or a
# directory inside $HOME cannot carry the operator's files (~/.ssh) into the
# guest.
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
# Inside $HOME is refused too: a path such as ~/.ssh or ~/Library would pass
# every other check and hand the guest the operator's own files.
case "$share/" in
  "$home_real"/*) refuse "SOAK_SHARE_DIR resolves to $share, inside \$HOME ($home_real); use a dedicated directory outside it, such as /Users/Shared/tc-soak-share" ;;
esac
[ "$share" != "/" ] || refuse "SOAK_SHARE_DIR must not be /"
# Dedicated: yours, and closed to group and others.
share_meta="$(stat -f '%u %Lp' "$share" 2>/dev/null)" || refuse "cannot stat $share"
read -r share_uid share_perm <<< "$share_meta"
[ "$share_uid" = "$me" ] || refuse "SOAK_SHARE_DIR $share is owned by uid $share_uid, not you ($me): use a directory you created for this"
[[ "$share_perm" =~ ^[0-7]{3,4}$ ]] && [ $(( 8#$share_perm & 8#022 )) -eq 0 ] || refuse "SOAK_SHARE_DIR $share is writable by group or others (mode $share_perm)"

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
# A new guest gets a new, empty share, so nothing already there is handed to it.
[ -z "$(ls -A "$share" 2>/dev/null)" ] || refuse "SOAK_SHARE_DIR $share is not empty: a new guest starts from an empty, dedicated share"
command -v tart >/dev/null 2>&1 || refuse "tart is not installed (installing it is an operator action)"
if tart list --quiet 2>/dev/null | grep -Fxq -- "$SOAK_VM_NAME"; then
  refuse "a VM named $SOAK_VM_NAME already exists; a soak starts from a pristine guest, so delete or rename it yourself first"
fi

tart clone "$SOAK_BASE_IMAGE" "$SOAK_VM_NAME"
tart set "$SOAK_VM_NAME" --cpu "$SOAK_CPU" --memory "$SOAK_MEMORY_MB" --disk-size "$SOAK_DISK_GB"
# Runs in the foreground until the guest shuts down.
exec tart run "$SOAK_VM_NAME" --no-graphics --dir="$SOAK_SHARE_TAG:$share"
