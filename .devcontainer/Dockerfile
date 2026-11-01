# Testament's container executor (#2733): the pool builds this image and runs every
# tier's `node --test` batches inside it. `tar`, `sh` and `git` are what a Testament
# runner itself needs (unpacking its plugin, checking out the worktree); `tmux` and
# `sqlite3` are what the Large tier's own tests drive (test/tmux*.test.js,
# test/store*.test.js); `python3` and `ca-certificates` are what a handful of scripts
# and HTTPS-fetching tests need. `procps` (#2752) is what the Large tier's process-tree
# tests need — `node:22-bookworm-slim` has no `/bin/ps`, which surfaced as 14 Stage 5
# failures (bridge-handoff's real `ps -axo` walk, soak-guest's process-isolation
# assumptions) on the Testament container pool. `curl` (#2758) is what
# `data/hooks/sessionstart-rules-claude.sh` shells out to for its real receipt POST —
# test/rule-delivery-receipt.test.js's "posts exactly one receipt per launch" case needs
# it reachable, not just its own deliberate no-curl fixture, which builds a PATH without
# it on purpose. `less` (#2758) is test/tmux.test.js's own controlled alternate-screen
# app — the test deliberately drives a real pager to prove `capturePane` reports
# `alternateScreen: true`, and `node:22-bookworm-slim` has no pager at all. Must end with
# a non-root USER: Testament refuses an image whose final user is root
# (`env_build_failed`).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    less \
    procps \
    python3 \
    sqlite3 \
    tar \
    tmux \
  && rm -rf /var/lib/apt/lists/*

USER node
