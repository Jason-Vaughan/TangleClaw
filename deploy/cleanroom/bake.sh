#!/bin/sh
# tc-cleanroom bake — the ONE egress batch for the tc-cleanroom acceptance-gate image.
# Run INSIDE an open rc-research-mode window, on habitat (ssh habitat 'sh -s' < this,
# or by RentalClaw verbatim if the TC session is not live when the window opens).
# Everything after this script completes needs ZERO egress: TC source arrives via
# scp + docker cp, and TC has no npm dependencies.
#
# ttyd is installed from the upstream static aarch64 binary because the `ttyd`
# apt package exists only in Debian sid — bookworm has none (RentalClaw verified
# against packages.debian.org, 2026-07-18). Release pinned for reproducibility;
# the trailing --version makes a bad fetch fail loudly INSIDE the window.
set -eux
# Non-interactive ssh gets the docker CLI but NOT Docker Desktop's credential
# helper (docker-credential-desktop lives in Docker.app's Resources/bin and is
# invoked even for anonymous Hub pulls) — without this export the first pull
# dies with "executable file not found in $PATH". Applies to EVERY ssh-driven
# docker command on habitat, not just this script. (RentalClaw, 2026-07-18.)
export PATH="/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"
DOCKER=/usr/local/bin/docker

# 1. Base pulls (linux/arm64 — habitat's Docker Desktop VM is aarch64)
$DOCKER pull node:22-bookworm
$DOCKER pull node:22-slim

# 2. Bake tc-cleanroom-base:latest
BUILDDIR=$(mktemp -d)
cat > "$BUILDDIR/Dockerfile" <<'DF'
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git curl ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.aarch64 \
 && chmod +x /usr/local/bin/ttyd \
 && ttyd --version
DF
$DOCKER build -t tc-cleanroom-base:latest "$BUILDDIR"
rm -rf "$BUILDDIR"

# 3. Self-verify — if this passes, the image is provably complete and we are
#    egress-free for the rest of Chunk 08.
$DOCKER run --rm tc-cleanroom-base:latest sh -c 'tmux -V && git --version && ttyd --version && node -v && curl --version | head -1'
echo "BAKE-OK"
