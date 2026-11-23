#!/bin/bash
#
# install-fda-anchor.sh (#3198, BUG-002, Ruling A901)
#
# macOS keys a Full Disk Access (FDA) grant to the RESOLVED Mach-O executable
# path, not to a symlink. `com.tangleclaw.server.plist` has always run
# whatever `which node` found at install time — on a Homebrew install that is
# `/opt/homebrew/bin/node`, a symlink into a VERSIONED Cellar directory
# (`/opt/homebrew/Cellar/node@22/<version>/bin/node`). The next
# `brew upgrade node@22` moves that symlink's target to a new, never-granted
# Cellar binary, and the very next `launchctl kickstart` starts an
# unauthorized process — no prompt, no error, just a read under
# `~/Documents/...` that never answers (`lib/tcc-folders.js`). This is the
# exact root cause BUG-002 names.
#
# The fix mirrors the proven `~/.tangleclaw/bin/ttyd` pattern
# (`lib/ttyd-runtime.js`, #1245 / ADR 0018): stage the CURRENT, VERIFIED node
# binary at a path that never moves, so an Operator's one-time FDA grant to
# THAT path survives every future Homebrew patch upgrade. Unlike ttyd, there
# is no build step here — node already ships as a verified, pre-built
# binary — so this script only ever copies and verifies, never compiles.
#
# Homebrew's node is NOT a single self-contained binary: it dynamically
# loads `@rpath/libnode.<N>.dylib` from a `../lib` directory relative to its
# own `bin/`, so copying the executable ALONE crashes on launch
# (`dyld: Library not loaded`, confirmed empirically — the Cellar directory's
# own `bin/node` + `lib/libnode.*.dylib` layout is load-bearing, not
# incidental). `stage()` therefore mirrors that same relative layout under
# the managed base directory (`<base>/bin/node` + `<base>/lib/*.dylib`),
# copying every `.dylib` sibling of the source binary's own `lib/`
# directory — never just the one load command's own literal name, which is
# itself version-suffixed and changes on every node upgrade.
#
# STRICT SECURITY BOUNDARY (Ruling A901) — this script, and everything it is
# ever called from, must NEVER:
#   - read or write macOS's TCC.db, or any other attempt to bypass SIP/TCC;
#   - self-mutate ~/Library/LaunchAgents/com.tangleclaw.server.plist, from
#     this script or from any HTTP request path. Pointing that plist's
#     ProgramArguments[0] at the staged binary is a SEPARATE, Operator-led
#     step this script only ever describes, never performs.
# The one real permission change this whole fix depends on — granting Full
# Disk Access to the staged binary — happens only in System Settings, by the
# Operator's own hand. This script's `--stage` prints that instruction; it
# never asks for or exercises System Settings access itself.
#
# Usage:
#   install-fda-anchor.sh [--stage|--status] [--base-dir DIR] [--json]
#
#   --stage      (default) Idempotently stage the active, verified node
#                binary into <base-dir>/bin/node, with node.manifest.json
#                beside it, and print the one-time Operator FDA-grant step.
#   --status     Report the staged binary's status against the CURRENT
#                process's/PATH's own node, and the server plist's
#                ProgramArguments[0] — never changes anything.
#   --base-dir   Override the base directory (default: ~/.tangleclaw, or
#                $TANGLECLAW_FDA_BASE_DIR when set).
#   --json       With --status, print machine-readable JSON instead of the
#                human report.
#
# Written for the bash 3.2 that macOS ships as /bin/bash (no associative
# arrays, no `declare -A`, no bash-4-only builtins) — every construct here is
# plain POSIX-ish bash: functions, `local`, indexed-free variables, `[ ]`
# tests, `case`, and `$(...)` substitution only.

set -euo pipefail

BASE_DIR="${TANGLECLAW_FDA_BASE_DIR:-$HOME/.tangleclaw}"
ACTION="stage"
JSON_OUTPUT="false"

usage() {
  cat <<'USAGE'
Usage: install-fda-anchor.sh [--stage|--status] [--base-dir DIR] [--json]

  --stage      (default) Stage the active, verified node binary into
               <base-dir>/bin/node and write its manifest. Idempotent.
  --status     Report the staged binary's status against the current
               process's own node and the server plist's ProgramArguments[0].
               Read-only; never changes anything.
  --base-dir   Override the base directory (default: ~/.tangleclaw).
  --json       With --status, print JSON instead of a human report.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --stage) ACTION="stage"; shift ;;
    --status) ACTION="status"; shift ;;
    --json) JSON_OUTPUT="true"; shift ;;
    --base-dir) BASE_DIR="$2"; shift 2 ;;
    --base-dir=*) BASE_DIR="${1#--base-dir=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install-fda-anchor.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

BIN_DIR="$BASE_DIR/bin"
LIB_DIR="$BASE_DIR/lib"
MANAGED_NODE="$BIN_DIR/node"
MANIFEST="$BIN_DIR/node.manifest.json"
SERVER_PLIST="$HOME/Library/LaunchAgents/com.tangleclaw.server.plist"

# ---- helpers — plain functions, callable individually by a test harness ----

# The active node on PATH right now — what `which node` would find, i.e.
# the symlink the plist's ProgramArguments[0] has always pointed at.
find_source_node() {
  command -v node
}

# BSD readlink has no -f (and macOS ships BSD readlink); use node itself —
# already validated to run, by the time this is called — as a portable
# realpath, the same technique deploy/install.sh already uses for this exact
# symlink. Echoes the input path unresolved, never fails, if that node
# cannot run `-e` for any reason: an unresolved symlink degrades the
# reading, never the whole command.
resolve_realpath() {
  "$1" -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$1" 2>/dev/null || printf '%s' "$1"
}

node_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# The sibling `lib/` directory a Homebrew node binary's own `@rpath` load
# command resolves `../lib/libnode.*.dylib` against — the Cellar version
# directory's own `lib/`, one level up from the binary's `bin/`. Empty when
# there is none (a node build that genuinely needs no sibling dylib): never
# an error, since `stage_dylibs` below treats "nothing found" as nothing to
# copy, not a failure.
source_lib_dir() {
  local version_dir
  version_dir="$(dirname "$(dirname "$1")")"
  if [ -d "$version_dir/lib" ]; then
    printf '%s' "$version_dir/lib"
  fi
}

# Copy every `.dylib` from the source's own lib dir into `$LIB_DIR`, each
# through a `.tmp` name and an atomic rename — never an in-place overwrite
# of a dylib a running process may still have mapped. A no-op, not a
# failure, when the source has no lib dir at all (nothing to copy).
stage_dylibs() {
  local src_lib="$1" f base tmp
  [ -z "$src_lib" ] && return 0
  mkdir -p "$LIB_DIR"
  for f in "$src_lib"/*.dylib; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    tmp="$LIB_DIR/$base.tmp"
    rm -f "$tmp"
    cp "$f" "$tmp"
    chmod 0755 "$tmp"
    mv -f "$tmp" "$LIB_DIR/$base"
  done
}

# A manifest.binary.sha256 or empty string — grep+sed rather than a JSON
# parser, since this script owns no dependency beyond coreutils/node.
manifest_field() {
  # $1 = manifest file, $2 = field name
  if [ ! -f "$1" ]; then
    printf ''
    return 0
  fi
  grep -o "\"$2\": *\"[^\"]*\"" "$1" | head -1 | sed -E "s/.*\"([^\"]*)\"\$/\1/" || printf ''
}

# The server plist's ProgramArguments[0] — read-only, via PlistBuddy (ships
# with macOS). Empty when the plist or PlistBuddy is absent (a fresh
# install, or a non-macOS dev checkout): never an error, just "nothing to
# report yet".
plist_node_path() {
  if [ -f "$SERVER_PLIST" ] && command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$SERVER_PLIST" 2>/dev/null || printf ''
  else
    printf ''
  fi
}

write_manifest() {
  # $1=path $2=sourcePath $3=sourceRealpath $4=version $5=sha256 $6=stagedAt $7=outfile
  cat > "$7" <<MANIFEST_JSON
{
  "schema": 1,
  "binary": {
    "path": "$1",
    "sourcePath": "$2",
    "sourceRealpath": "$3",
    "version": "$4",
    "sha256": "$5"
  },
  "stagedAt": "$6"
}
MANIFEST_JSON
}

# ---- actions ----

stage() {
  mkdir -p "$BIN_DIR"

  local source_path source_realpath source_lib version sha staged_sha tmp manifest_tmp staged_at

  source_path="$(find_source_node)"
  if [ -z "$source_path" ]; then
    echo "install-fda-anchor.sh: no node found on PATH; nothing to stage" >&2
    exit 1
  fi
  source_realpath="$(resolve_realpath "$source_path")"

  # Verify the SOURCE runs before copying anything at all — a dead symlink
  # or a node that cannot execute --version is never worth staging.
  if ! version="$("$source_realpath" --version 2>/dev/null)"; then
    echo "install-fda-anchor.sh: $source_realpath does not run; nothing was staged" >&2
    exit 1
  fi
  sha="$(node_sha256 "$source_realpath")"

  # Idempotent: already staged from this exact binary AND it still actually
  # runs right now (not just a matching sha256 — its lib/ sibling could have
  # been removed independently of this script) — nothing to copy, just
  # confirm it and print the Operator step again.
  staged_sha="$(manifest_field "$MANIFEST" sha256)"
  if [ -x "$MANAGED_NODE" ] && [ "$staged_sha" = "$sha" ] && "$MANAGED_NODE" --version >/dev/null 2>&1; then
    echo "Already staged at $MANAGED_NODE (node $version, sha256 $sha) — nothing to do."
    print_operator_step
    return 0
  fi

  # The dylib(s) the binary's own @rpath load command needs at a sibling
  # `lib/` directory — staged BEFORE the binary's own run-verification
  # below, since the copied binary cannot start without them (see the file
  # header's own dyld finding).
  source_lib="$(source_lib_dir "$source_realpath")"
  stage_dylibs "$source_lib"

  tmp="$BIN_DIR/node.tmp"
  rm -f "$tmp"
  cp "$source_realpath" "$tmp"
  chmod 0755 "$tmp"

  # Verify the STAGED COPY runs too, before it is ever promoted — a copy
  # that does not run (a truncated write, a corrupted filesystem, or a
  # dylib that failed to stage above) must never become the binary other
  # things point at.
  if ! "$tmp" --version >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "install-fda-anchor.sh: the staged copy does not run; nothing was changed" >&2
    exit 1
  fi

  staged_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  manifest_tmp="$MANIFEST.tmp"
  write_manifest "$MANAGED_NODE" "$source_path" "$source_realpath" "$version" "$sha" "$staged_at" "$manifest_tmp"

  # Manifest first, binary last — mirrors lib/ttyd-runtime.js#_promote.
  # Both renames are atomic replacements of the whole inode, never an
  # in-place edit of a binary that is (or could be) code-signed. Interrupted
  # between the two, a reader sees a manifest that does not yet match
  # whatever binary is still at MANAGED_NODE (the old one, not a mismatched
  # new one) — never a silently-wrong pair.
  mv -f "$manifest_tmp" "$MANIFEST"
  mv -f "$tmp" "$MANAGED_NODE"

  echo "Staged $MANAGED_NODE (node $version, sha256 $sha) from $source_realpath"
  print_operator_step
}

print_operator_step() {
  echo
  echo "ONE-TIME OPERATOR STEP (this script never does it for you):"
  echo "  Grant Full Disk Access to:"
  echo "    $MANAGED_NODE"
  echo "  in System Settings -> Privacy & Security -> Full Disk Access."
  echo "  This path never changes across a 'brew upgrade node@22' patch bump,"
  echo "  so the grant you make today keeps working after every future upgrade"
  echo "  — unlike a grant made for the Homebrew symlink, which that upgrade breaks."
}

status() {
  local current_node current_realpath current_version
  local staged_exists staged_version staged_sha
  local plist_node using_managed

  current_node="$(find_source_node 2>/dev/null || printf '')"
  current_realpath=""
  current_version=""
  if [ -n "$current_node" ]; then
    current_realpath="$(resolve_realpath "$current_node")"
    current_version="$("$current_node" --version 2>/dev/null || printf '')"
  fi

  staged_exists="false"
  staged_version=""
  if [ -x "$MANAGED_NODE" ]; then
    staged_exists="true"
    staged_version="$("$MANAGED_NODE" --version 2>/dev/null || printf '')"
  fi
  staged_sha="$(manifest_field "$MANIFEST" sha256)"

  plist_node="$(plist_node_path)"
  using_managed="false"
  if [ -n "$plist_node" ] && [ "$plist_node" = "$MANAGED_NODE" ]; then
    using_managed="true"
  fi

  if [ "$JSON_OUTPUT" = "true" ]; then
    cat <<STATUS_JSON
{
  "managedNodePath": "$MANAGED_NODE",
  "staged": $staged_exists,
  "stagedVersion": "$staged_version",
  "stagedSha256": "$staged_sha",
  "currentProcessNode": "$current_node",
  "currentProcessRealpath": "$current_realpath",
  "currentProcessVersion": "$current_version",
  "plistProgramArgument0": "$plist_node",
  "plistUsingManagedNode": $using_managed
}
STATUS_JSON
    return 0
  fi

  echo "Managed node path:    $MANAGED_NODE"
  echo "Staged:                $staged_exists"
  if [ "$staged_exists" = "true" ]; then
    echo "  version:             $staged_version"
    echo "  sha256:              $staged_sha"
  fi
  echo "Current PATH node:     $current_node"
  echo "  resolved:             $current_realpath"
  echo "  version:              $current_version"
  if [ -n "$plist_node" ]; then
    echo "Server plist runs:     $plist_node"
    echo "  using managed node:  $using_managed"
  else
    echo "Server plist:          not found (or PlistBuddy unavailable) — nothing to report"
  fi
}

case "$ACTION" in
  stage) stage ;;
  status) status ;;
esac
