#!/usr/bin/env bash
# Provision the soak guest VM on the host with tart (#2020).
#
#   host-provision.sh                       print the tart commands; run nothing
#   host-provision.sh --execute             run them (operator only; see below)
#   host-provision.sh --closure [--execute] stop the named guest and run it again
#                                           under softnet, closed to everything but
#                                           inbound connections from the host
#
# The closure is the host-side layer of the guest's isolation (Architect ruling
# A7): softnet blocks every destination (--net-softnet-block=0.0.0.0/0) and
# admits only connections the host opens (--net-softnet-allow="in @host"), so
# SSH from the host keeps working while nothing leaves the guest. It restarts
# the guest, and pf does not survive a restart: run guest-setup.sh again after
# it, before any soak time counts.
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

usage() { echo "usage: host-provision.sh [--closure] [--execute]" >&2; exit 2; }
execute=0
closure=0
for arg in "$@"; do
  case "$arg" in
    --execute) [ "$execute" -eq 0 ] || usage; execute=1 ;;
    --closure) [ "$closure" -eq 0 ] || usage; closure=1 ;;
    *) usage ;;
  esac
done

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

case "$SOAK_TART_DISPLAY" in
  no-graphics|vnc) display="--$SOAK_TART_DISPLAY" ;;
  *) refuse "SOAK_TART_DISPLAY must be no-graphics or vnc, not $SOAK_TART_DISPLAY" ;;
esac
softnet=(--net-softnet --net-softnet-block=0.0.0.0/0 '--net-softnet-allow=in @host')
run_flags=("$display")
[ "$closure" -eq 0 ] || run_flags+=("${softnet[@]}")
run_flags+=("--dir=$SOAK_SHARE_TAG:$share")

run_cmd="tart run $(printf '%q' "$SOAK_VM_NAME")$(printf ' %q' "${run_flags[@]}")"
if [ "$closure" -eq 1 ]; then
  cmds=("tart stop $(printf '%q' "$SOAK_VM_NAME")" "$run_cmd")
else
  cmds=(
    "tart clone $(printf '%q' "$SOAK_BASE_IMAGE") $(printf '%q' "$SOAK_VM_NAME")"
    "tart set $(printf '%q' "$SOAK_VM_NAME") --cpu $(printf '%q' "$SOAK_CPU") --memory $(printf '%q' "$SOAK_MEMORY_MB") --disk-size $(printf '%q' "$SOAK_DISK_GB")"
    "$run_cmd"
  )
fi

if [ "$execute" -eq 0 ]; then
  echo "# dry run: nothing executed. Re-run with --execute and SOAK_OPERATOR_APPROVED=1 to run these."
  printf '%s\n' "${cmds[@]}"
  exit 0
fi

[ "${SOAK_OPERATOR_APPROVED:-}" = "1" ] || refuse "--execute needs SOAK_OPERATOR_APPROVED=1: creating or restarting a VM is an operator-only host action"
command -v tart >/dev/null 2>&1 || refuse "tart is not installed (installing it is an operator action)"

if [ "$closure" -eq 1 ]; then
  # The closure restarts the guest this soak created, with its share and the
  # evidence already in it; it never creates one.
  tart list --quiet 2>/dev/null | grep -Fxq -- "$SOAK_VM_NAME" \
    || refuse "no VM named $SOAK_VM_NAME exists: the closure restarts the guest provisioned for this soak, it does not create one"
  # A guest that is already stopped makes tart stop fail; the run below is what matters.
  tart stop "$SOAK_VM_NAME" || true
  # Runs in the foreground until the guest shuts down.
  exec tart run "$SOAK_VM_NAME" "${run_flags[@]}"
fi

# A new guest gets a new, empty share, so nothing already there is handed to it.
[ -z "$(ls -A "$share" 2>/dev/null)" ] || refuse "SOAK_SHARE_DIR $share is not empty: a new guest starts from an empty, dedicated share"
if tart list --quiet 2>/dev/null | grep -Fxq -- "$SOAK_VM_NAME"; then
  refuse "a VM named $SOAK_VM_NAME already exists; a soak starts from a pristine guest, so delete or rename it yourself first"
fi

tart clone "$SOAK_BASE_IMAGE" "$SOAK_VM_NAME"
tart set "$SOAK_VM_NAME" --cpu "$SOAK_CPU" --memory "$SOAK_MEMORY_MB" --disk-size "$SOAK_DISK_GB"
# Runs in the foreground until the guest shuts down.
exec tart run "$SOAK_VM_NAME" "${run_flags[@]}"
