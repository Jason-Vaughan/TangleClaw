#!/usr/bin/env bash
# TangleClaw — ttyd session attachment script
# Called by ttyd with --url-arg. The ?arg= query parameter from the iframe URL
# is passed as $1, containing the project/session name to attach to.

raw="${1:-tangleclaw}"
# Sanitize for tmux: replace spaces with hyphens, strip invalid chars
session=$(echo "$raw" | tr ' ' '-' | sed 's/[^a-zA-Z0-9_-]//g')

# Only attach to existing tmux sessions — never create new ones.
# The old `tmux new-session -A` pattern silently spawned a bare shell when the
# real engine session ended, leaving an orphan that confused TangleClaw's
# session state tracking and showed ulimit errors from .zshrc (fixes #47).
# The `=` prefix on every target forces an EXACT session-name match. tmux
# otherwise falls back to matching a unique PREFIX, so with no `TangleClaw`
# session running, `-t TangleClaw` resolves to `TangleClaw-Roadmap` — and this
# script would attach the browser terminal to a different project's live pane.
#
# The targets are NOT spelled the same way, and the difference is load-bearing.
# `has-session` and `attach-session` take a target-SESSION and accept `=name`.
# `capture-pane` takes a target-PANE and rejects `=name` outright ("can't find
# pane"); it needs the trailing `:`, which resolves the session exactly and then
# takes its current pane. Getting that wrong is silent here — the capture-pane
# line ends in `2>/dev/null || true`, so a rejected target would just skip the
# scrollback replay below with nothing to see. Measured against tmux 3.6a.
if tmux has-session -t "=$session" 2>/dev/null; then
  # Replay scrolled-off history into the fresh xterm.js buffer before attaching
  # (#322). ttyd pipes this script's stdout straight into the browser terminal,
  # so printing the pane history here restores scrollback that a reconnect or a
  # TC/ttyd restart would otherwise lose — the attach below only redraws the
  # current viewport, never the history (tmux itself retains it via
  # history-limit). Flags:
  #   -e        keep colors/escape sequences
  #   -p        print to stdout (into the terminal)
  #   -S -10000 start up to 10000 lines back (matches the xterm scrollback
  #             buffer set via the scrollback client-option in the plist)
  #   -E -1     stop one line ABOVE the visible screen, so the lines the attach
  #             is about to redraw aren't printed twice
  # Errors (e.g. a brand-new pane with no history) are swallowed — the replay is
  # best-effort and must never block the attach.
  #
  # This script stays the SESSION LEADER instead of exec'ing tmux (#1245). When
  # a tab closes, ttyd stops reading the pty and sends SIGHUP to this process
  # group. On macOS a session leader that exits with output still queued on its
  # terminal waits, with no timeout, for that output to drain, and nothing will
  # ever read it: the process sticks in the exiting state, holding its
  # /dev/ttys* slot until ttyd itself dies. That was the leak, and an exec'd
  # `tmux attach` was the leader that stuck. So on HUP this script ends its
  # children, discards whatever is queued (tcflush, which needs no root), and
  # only then exits, with nothing left to wait for.
  #
  # Both children run in the background under `wait`, because bash runs a trap
  # only after a FOREGROUND command returns, and a replay blocked writing to a
  # pty nobody reads never returns. `wait` is interrupted by the trapped signal
  # at once. The children are SIGKILLed: either may be blocked in that same
  # write, and the only thing that matters now is that they are gone.
  replay=
  client=
  drain_and_exit() {
    trap '' HUP TERM INT
    for p in $replay $client; do kill -KILL "$p" 2>/dev/null; done
    for p in $replay $client; do wait "$p" 2>/dev/null; done
    # Absolute path: ttyd runs under launchd with a minimal PATH.
    /usr/bin/perl -MPOSIX -e 'POSIX::tcflush(1, POSIX::TCOFLUSH)' 2>/dev/null
    exit 0
  }
  # Set before the replay, because a tab can close while it is still streaming.
  trap drain_and_exit HUP TERM INT
  tmux capture-pane -e -p -t "=$session:" -S -10000 -E -1 2>/dev/null &
  replay=$!
  wait "$replay"
  replay=
  # `0<&0` keeps the terminal as the client's stdin: without job control, bash
  # otherwise gives a background command /dev/null.
  tmux attach-session -t "=$session" 0<&0 &
  client=$!
  wait "$client"
  client=
  drain_and_exit
else
  echo "Session '${session}' is not running."
  echo "Return to TangleClaw to start a new session."
  # Sleep so the message stays visible in the ttyd terminal; ttyd closes
  # the connection when this process exits, which would flash the message
  # too briefly to read. The frontend redirects after ~10s anyway.
  #
  # `exec`, so ttyd has exactly one process to reap here. `sleep` writes
  # nothing, so as session leader it has no queued output to wait on when it
  # is hung up; the two short lines above are read before the tab can close
  # in any ordinary case (#1245).
  exec sleep 30
fi
