#!/usr/bin/env bash
# TangleClaw — ttyd launch wrapper (#397 bug 2).
#
# ttyd is the launchd plist's ProgramArguments; KeepAlive and reboot re-run it
# directly. In caddy ingress mode ttyd binds a Unix domain socket, and a stale
# socket inode left behind by a crash, kill, or reboot makes the rebind fail —
# every terminal then comes up dead until someone manually `rm`s the socket and
# kickstarts the job. This wrapper unlinks the socket (when one is configured)
# before exec'ing ttyd, so every restart path self-heals.
#
# TTYD_SOCKET is set (to the socket path) only in caddy mode; in direct mode ttyd
# binds a TCP port and TTYD_SOCKET is empty, so the unlink is a no-op. All ttyd
# args are passed straight through via "$@".
set -euo pipefail

sock="${TTYD_SOCKET:-}"
[ -n "$sock" ] && rm -f "$sock"

exec "$@"
