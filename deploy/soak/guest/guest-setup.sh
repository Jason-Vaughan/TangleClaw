#!/usr/bin/env bash
# Prepare and attest the inside of the soak guest (#2020).
#
#   guest-setup.sh --bootstrap-user   create (or confirm) the workload user only
#   guest-setup.sh                    set the guest up (admin, with sudo)
#   guest-setup.sh --verify-admin     attest the admin plane (admin, with sudo)
#   guest-setup.sh --verify-workload  attest the workload plane (as the workload user)
#   guest-setup.sh --verify-network --candidate <sha> --run-id <id>
#                  --manifest-digest <hex> --sample-seq <n>
#                                     attest one certification sample (admin only):
#                                     both planes, fresh, joined and bound to it
#
# The guest TangleClaw must run as the workload user, never as the admin: its
# sessions are the workload, and a session with sudo could switch pf off. So a
# fresh guest goes: --bootstrap-user, then start the pinned TangleClaw as that
# user on loopback (the runbook's step), then setup. Setup and the admin
# verifier refuse a TangleClaw listening as anyone else.
#
# The guest is attested from two planes, because neither can see everything:
#
# - The ADMIN verifier inspects pf itself. pf must be enabled, and the loaded
#   ruleset must equal pfctl's own parse of the profile with the same macros,
#   so no pfctl output format is assumed. It reports both rulesets' sha256 and
#   the verdict, the guest interface and address, the DHCP server and lease it
#   allowed, and that the SSH management path is listening.
# - The WORKLOAD verifier runs as the dedicated workload user and proves what
#   that user can and cannot do: it is not an admin, sudo and pfctl are refused
#   to it, loopback and the guest TangleClaw answer, and nothing outside does.
#   It never inspects pf, because the workload must not be able to.
#
# Each verifier prints exactly one JSON line on stdout (schema
# tc.soak-guest-attest/v1), with "ok" true or false, the boot identity and the
# sha256 of this script, the pf profile and guest.conf. The certification
# runner does not read those lines. It pins this script and calls
# --verify-network for every sample, which runs as the guest admin, takes one
# FRESH --verify-admin line and one FRESH --verify-workload line (the latter as
# the workload user), and prints exactly one {admin, workload} pair in the
# release-certification isolation schemas, with the sample's binding (candidate,
# run id, manifest digest, sample number) in both planes
# (lib/soak/attest-bridge.js). Nothing is cached or reused, and nothing is
# stamped with a binding it was not produced for. Any failure prints nothing on
# stdout and exits non-zero, which the runner records as unattested. A reboot
# changes the boot identity, which fails the run.
#
# Setup, in order, stopping at the first failure:
#   1. create (or confirm) the workload user: not an admin, no sudo;
#   2. load the default-deny pf profile, then run both verifiers;
#   3. install the stub engine on PATH and its profile for the workload user;
#   4. create the synthetic repos as the workload user (soak.js repos);
#   5. finish the guest TangleClaw's first-run setup (no login, the soak's
#      projects root), then attach each repo as a project through its own API;
#   6. lease the stub Medusa hub's ports and start it as a LaunchAgent in the
#      workload user's GUI session, then check it answers on loopback.
# Before step 2 it checks that the TangleClaw on SOAK_TC_PORT runs as the
# workload user.
# Every step is safe to repeat. The TangleClaw checkout lives in a dedicated
# root- or admin-owned 0755 hierarchy such as /opt/tangleclaw-soak: readable
# by the workload user, writable by nobody but its owner.
#
# Every mode refuses to run anywhere but a macOS VM with no live TangleClaw
# pane, and validates its inputs before pf sees them. Every admin-side mode
# first checks that the checkout it runs from can be trusted (see "Checkout
# trust" below).
#
# Exit codes: 0 done, 2 usage, 3 refused (a verifier's JSON line says why),
# any other non-zero: the failing setup step's own code.
set -euo pipefail

SCHEMA='tc.soak-guest-attest/v1'
mode='setup'
usage='usage: guest-setup.sh [--bootstrap-user | --verify-admin | --verify-workload | --verify-network --candidate <sha> --run-id <id> --manifest-digest <hex> --sample-seq <n>]'
case "${1:-}" in
  '') ;;
  --bootstrap-user) mode='bootstrap' ;;
  --verify-admin) mode='admin' ;;
  --verify-workload) mode='workload' ;;
  --verify-network) mode='network' ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
# --verify-network takes its sample's binding, each flag exactly once and each
# value in its exact form. Anything else is a usage error before anything
# runs: a binding that could be read two ways must never be attested.
net_candidate='' net_run_id='' net_digest='' net_seq=''
if [ "$mode" = 'network' ]; then
  shift
  seen=' '
  while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }
    case "$seen" in *" $1 "*) echo "duplicate $1" >&2; echo "$usage" >&2; exit 2 ;; esac
    seen="$seen$1 "
    case "$1" in
      --candidate) net_candidate="$2" ;;
      --run-id) net_run_id="$2" ;;
      --manifest-digest) net_digest="$2" ;;
      --sample-seq) net_seq="$2" ;;
      *) echo "$usage" >&2; exit 2 ;;
    esac
    shift 2
  done
  [[ "$net_candidate" =~ ^[0-9a-f]{40}$ ]] && [[ "$net_run_id" =~ ^[0-9a-f]{32}$ ]] \
    && [[ "$net_digest" =~ ^[0-9a-f]{64}$ ]] && [[ "$net_seq" =~ ^[1-9][0-9]{0,15}$ ]] \
    || { echo "--verify-network needs --candidate <40 hex>, --run-id <32 hex>, --manifest-digest <64 hex> and --sample-seq <positive integer>, each exactly once" >&2; echo "$usage" >&2; exit 2; }
else
  [ "$#" -le 1 ] || { echo "$usage" >&2; exit 2; }
fi

# Print one JSON line, built by a real encoder (node's JSON.stringify), from
# `path=type:value` arguments. Types: s string, n number, b boolean, z null.
# A dotted path nests; members appear in argument order.
emit_json() {
  node -e '
    const out = {};
    for (const arg of process.argv.slice(1)) {
      const eq = arg.indexOf("=");
      const key = arg.slice(0, eq);
      const type = arg[eq + 1];
      const raw = arg.slice(eq + 3);
      let value;
      if (type === "s") value = raw;
      else if (type === "n") { value = Number(raw); if (raw === "" || !Number.isFinite(value)) throw new Error("not a number: " + key); }
      else if (type === "b") value = raw === "true";
      else if (type === "z") value = null;
      else throw new Error("unknown type for " + key);
      const parts = key.split(".");
      let o = out;
      for (const p of parts.slice(0, -1)) o = (o[p] = o[p] || {});
      o[parts[parts.length - 1]] = value;
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  ' "$@"
}

# Extra members a failure carries, as emit_json arguments, set just before a
# refusal that has evidence worth keeping (such as both ruleset digests).
fail_extra=()
refuse() {
  echo "refused: $*" >&2
  if [ "$mode" = 'admin' ] || [ "$mode" = 'workload' ]; then
    if command -v node >/dev/null 2>&1; then
      emit_json "schema=s:$SCHEMA" "mode=s:$mode" "ok=b:false" "code=s:REFUSED" "reason=s:$*" ${fail_extra[@]+"${fail_extra[@]}"}
    else
      # No encoder: one fixed line per mode, with nothing interpolated at all.
      case "$mode" in
        admin) printf '%s\n' '{"schema":"tc.soak-guest-attest/v1","mode":"admin","ok":false,"code":"ENCODER_MISSING","reason":"node is missing, so no attestation can be encoded"}' ;;
        workload) printf '%s\n' '{"schema":"tc.soak-guest-attest/v1","mode":"workload","ok":false,"code":"ENCODER_MISSING","reason":"node is missing, so no attestation can be encoded"}' ;;
      esac
    fi
  fi
  exit 3
}

# A MEASURED breach: the verifier positively observed an unsafe isolation fact
# (pf reported disabled, a loaded ruleset that is not the profile, a
# privileged workload, sudo or pfctl or egress actually permitted). Its line
# carries code BREACH, a closed breach.fact, and the boot and artifact
# identity, so --verify-network can bind it to the sample. Anything the
# verifier could not measure (a missing tool, a timeout, unreadable output) is
# a refusal instead, which is never read as a breach. Outside the two verifier
# modes it is an ordinary refusal.
breach() {
  local fact="$1"; shift
  if [ "$mode" = 'admin' ] || [ "$mode" = 'workload' ]; then
    echo "breach ($fact): $*" >&2
    emit_json "schema=s:$SCHEMA" "mode=s:$mode" "ok=b:false" "code=s:BREACH" "breach.fact=s:$fact" "reason=s:$*" \
      ${common_json[@]+"${common_json[@]}"} ${fail_extra[@]+"${fail_extra[@]}"}
    exit 3
  fi
  refuse "$*"
}

# A pane launched by a live TangleClaw exports TANGLECLAW_API. This script
# rewrites the firewall, creates a user and registers projects, so it never
# runs there.
[ -z "${TANGLECLAW_API:-}" ] || refuse "TANGLECLAW_API is set: this is a live TangleClaw pane, not the soak guest"
[ "$(uname -s)" = "Darwin" ] || refuse "the soak guest is macOS; this is $(uname -s)"
[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null || echo 0)" = "1" ] || refuse "not a virtual machine (kern.hv_vmm_present != 1); guest-setup.sh runs only inside the soak guest"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"

# --- Checkout trust (the admin plane) ---
# The admin runs this script with sudo, sources guest.conf, loads the pf
# profile and installs the stub engine. If the workload, or anyone but root
# and this admin, could change any of those files or the directories above
# them, they could run code as the admin or rewrite the firewall. So before
# guest.conf is read, every input and every ancestor through / must be a plain
# file or directory (no symlink, no path that resolves elsewhere), owned by
# root or the admin, and writable by neither group nor others. There is no
# exception, so the checkout lives in a dedicated root- or admin-owned 0755
# hierarchy such as /opt/tangleclaw-soak, never under /Users/Shared.
#
# This runs in every mode, before guest.conf is read. On the admin side the
# admin is whoever runs this. On the workload side the admin is the checkout's
# owner, which must not be the workload itself: a checkout the workload owns
# is one it can change.
admin_name="$(id -un)"
if [ "$mode" = 'workload' ]; then
  admin_uid="$(stat -f %u "$repo" 2>/dev/null || true)"
  [[ "$admin_uid" =~ ^[0-9]+$ ]] || refuse "cannot read the owner of $repo: the checkout is not trusted"
  [ "$admin_uid" != "$(id -u)" ] || refuse "the checkout $repo is owned by the user running the workload verifier (uid $admin_uid): run it as the workload user, which must not own the checkout it could then change"
else
  admin_uid="$(id -u)"
fi
trusted_inputs=("$here/guest-setup.sh" "$here/guest.conf" "$here/pf/soak-deny.conf" "$repo/scripts/soak.js")
for f in "$repo"/lib/soak/*.js; do trusted_inputs+=("$f"); done
trusted_inputs+=("$repo/deploy/soak/stub-engine/soak-stub.js" "$repo/deploy/soak/stub-engine/soak-stub.json")
trusted_dirs=()   # every ancestor of a trusted input, through /
trust_path() {
  # (No local named "mode": bash scopes dynamically, so refuse would read it.)
  local meta uid perm type bits
  meta="$(stat -f '%u %Lp %HT' "$1" 2>/dev/null)" || refuse "cannot stat $1: the checkout is not trusted"
  read -r uid perm type <<< "$meta"
  [[ "$uid" =~ ^[0-9]+$ ]] && [[ "$perm" =~ ^[0-7]{3,4}$ ]] || refuse "cannot read the owner and mode of $1: the checkout is not trusted"
  case "$2:$type" in
    file:'Regular File'|dir:Directory) ;;
    *) refuse "$1 is a '$type', not a plain ${2}: the checkout is not trusted" ;;
  esac
  [ "$uid" = 0 ] || [ "$uid" = "$admin_uid" ] || refuse "$1 is owned by uid $uid, not root or the invoking admin ($admin_uid)"
  bits=$((8#$perm))
  [ $((bits & 8#022)) -eq 0 ] || refuse "$1 is writable by group or others (mode $perm): the checkout is not trusted"
}
check_checkout_trust() {
  local f dir phys d seen=' '
  for f in "${trusted_inputs[@]}"; do
    dir="$(dirname "$f")"
    phys="$(cd "$dir" 2>/dev/null && pwd -P)" || refuse "cannot resolve $dir"
    [ "$phys" = "$dir" ] || refuse "$f is reached through a symlink ($dir resolves to $phys): the path is ambiguous"
    trust_path "$f" file
    d="$dir"
    while :; do
      case "$seen" in *" $d "*) ;; *)
        seen="$seen$d "
        trust_path "$d" dir
        trusted_dirs+=("$d") ;;
      esac
      [ "$d" = / ] && break
      d="$(dirname "$d")"
    done
  done
}
# Once the workload identity is known: the workload must not be able to write
# any trusted file or closed ancestor. A positive control first, so a sudo -u
# that fails for another reason cannot pass as "cannot write".
check_workload_cannot_write() {
  local p
  sudo -n -u "$user" test -r "$here/guest-setup.sh" >/dev/null 2>&1 \
    || refuse "cannot run a check as $user (sudo -u failed its positive control), so its write access is not established"
  for p in "${trusted_inputs[@]}" "${trusted_dirs[@]}"; do
    if sudo -n -u "$user" test -w "$p" >/dev/null 2>&1; then
      refuse "$user can write $p: the checkout is not protected from the workload"
    fi
  done
}
check_checkout_trust

# shellcheck source=guest.conf
. "$here/guest.conf"

# The names go into URLs and JSON below; soak.js repos trims them too.
SOAK_PROJECTS="${SOAK_PROJECTS//[[:space:]]/}"
api="http://127.0.0.1:$SOAK_TC_PORT"
user="$SOAK_WORKLOAD_USER"
t="$SOAK_PROBE_TIMEOUT"

# --- Input validation: nothing ambiguous reaches pfctl, sudo or a URL ---
[[ "$t" =~ ^[1-9][0-9]{0,2}$ ]] || refuse "SOAK_PROBE_TIMEOUT must be 1-999 seconds: $t"
[[ "$SOAK_GUEST_IF" =~ ^[a-z]+[0-9]+$ ]] && [ "$SOAK_GUEST_IF" != 'lo0' ] || refuse "SOAK_GUEST_IF is not a plain interface name: $SOAK_GUEST_IF"
valid_ipv4() {
  local IFS=. o
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  for o in $1; do [ "$((10#$o))" -le 255 ] || return 1; done
}
valid_ipv4 "$SOAK_HOST_ADDR" || refuse "SOAK_HOST_ADDR is not an IPv4 address: $SOAK_HOST_ADDR"
[[ "$user" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] && [ "$user" != 'root' ] || refuse "SOAK_WORKLOAD_USER is not a safe user name: $user"
[[ "$SOAK_TC_PORT" =~ ^[0-9]{1,5}$ ]] || refuse "SOAK_TC_PORT is not a port: $SOAK_TC_PORT"
[[ "$SOAK_SAMPLE_INTERVAL" =~ ^[1-9][0-9]{0,4}$ ]] || refuse "SOAK_SAMPLE_INTERVAL must be 1-99999 seconds: $SOAK_SAMPLE_INTERVAL"
[[ "$SOAK_SAFETY_MARGIN" =~ ^[0-9]{1,5}$ ]] || refuse "SOAK_SAFETY_MARGIN must be 0-99999 seconds: $SOAK_SAFETY_MARGIN"
# The lease must outlast the next sample interval plus the declared margin.
attest_window=$((SOAK_SAMPLE_INTERVAL + SOAK_SAFETY_MARGIN))
[[ "$SOAK_PROJECTS" =~ ^soak-[a-z0-9-]+(,soak-[a-z0-9-]+)*$ ]] || refuse "SOAK_PROJECTS must be comma-separated soak-* names: $SOAK_PROJECTS"
# An egress probe proves denial only if the address would answer were egress
# open. A malformed address, or one that is loopback, private, link-local,
# CGNAT, documentation, benchmark, multicast or otherwise reserved, makes the
# probe fail for reasons that have nothing to do with pf, so it is refused.
# node's own parser (net.isIP) and block list judge it, not a pattern.
command -v node >/dev/null 2>&1 || refuse "node is missing"
public_ip() {
  node -e '
    const net = require("net");
    const [family, addr] = process.argv.slice(1);
    if (net.isIP(addr) !== Number(family)) process.exit(1);
    // One list per family: a BlockList matches an IPv4 address against an
    // IPv4-mapped IPv6 subnet, so ::ffff:0:0/96 in a shared list would block
    // every IPv4 address.
    const v4 = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
      ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
      ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]];
    // ::/8 is reserved, and holds loopback, IPv4-mapped and NAT64 addresses.
    const v6 = [["::", 8], ["100::", 64], ["2001::", 23],
      ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]];
    const type = family === "4" ? "ipv4" : "ipv6";
    const bl = new net.BlockList();
    for (const [a, p] of (family === "4" ? v4 : v6)) bl.addSubnet(a, p, type);
    process.exit(bl.check(addr, type) ? 1 : 0);
  ' "$1" "$2" 2>/dev/null
}
public_ip 4 "$SOAK_EGRESS_PROBE_ADDR" || refuse "SOAK_EGRESS_PROBE_ADDR must be a public IPv4 literal: $SOAK_EGRESS_PROBE_ADDR"
public_ip 4 "$SOAK_DNS_PROBE_ADDR" || refuse "SOAK_DNS_PROBE_ADDR must be a public IPv4 literal: $SOAK_DNS_PROBE_ADDR"
public_ip 6 "$SOAK_EGRESS_PROBE_ADDR6" || refuse "SOAK_EGRESS_PROBE_ADDR6 must be a public IPv6 literal: $SOAK_EGRESS_PROBE_ADDR6"

# Run a command, killing it after $t seconds. A probe that hangs returns 124,
# which every caller treats as a failure, never as an answer.
bounded() {
  "$@" &
  local pid=$! rc=0
  ( sleep "$t"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local watch=$!
  wait "$pid" || rc=$?
  pkill -P "$watch" 2>/dev/null || true
  kill "$watch" 2>/dev/null || true
  wait "$watch" 2>/dev/null || true
  [ "$rc" -eq 137 ] && return 124
  return "$rc"
}

# An outside probe must not answer. 0 means it did; 124 means it hung, which is
# not proof of denial either.
must_be_denied() {
  local what="$1"; shift
  local rc=0
  bounded "$@" >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || breach egress-permitted "$what answered: the guest is not isolated"
  [ "$rc" -ne 124 ] || refuse "$what hung past ${t}s: denial is not proven"
}

boot_session="$(sysctl -n kern.bootsessionuuid 2>/dev/null || true)"
# kern.boottime reads "{ sec = <epoch>, usec = <n> } <date>"; take sec, not usec.
boot_time="$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ sec = \([0-9][0-9]*\),.*/\1/p')"
[ -n "$boot_session" ] && [ -n "$boot_time" ] || refuse "cannot read the boot identity (kern.bootsessionuuid, kern.boottime)"
sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
script_sha="$(sha_of "$here/guest-setup.sh")"
conf_sha="$(sha_of "$here/guest.conf")"
profile_sha="$(sha_of "$here/pf/soak-deny.conf")"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# What every successful line carries after its schema, mode and verdict.
common_json=("time=s:$now" "boot.session=s:$boot_session" "boot.time=n:$boot_time" "artifact.scriptSha256=s:$script_sha" "artifact.profileSha256=s:$profile_sha" "artifact.guestConfSha256=s:$conf_sha")
if [ "$mode" = 'admin' ] || [ "$mode" = 'workload' ] || [ "$mode" = 'network' ]; then
  command -v node >/dev/null 2>&1 || refuse "node is missing, so no attestation can be encoded"
fi

# The DHCP server pf allows. It must be configured (SOAK_DHCP_SERVER) and must
# match the one server identifier in the guest's current lease: a server taken
# from the lease alone stays refused until the dry run has shown it is the
# host-controlled service. Only the admin plane needs it. A lease field that
# appears twice or does not parse is refused, never guessed at.
lease=''
dhcp_server=''
lease_fields=()
# Refuse a field that appears more than once. Called directly, never inside
# $(...), so a refusal's line reaches stdout.
lease_unique() {
  local n
  n="$(grep -c "^$1 " <<< "$lease" || true)"
  [ "$n" -le 1 ] || refuse "the DHCP lease has $1 $n times"
}
lease_value() { sed -n "s/^$1 ([a-z0-9]*): *//p" <<< "$lease"; }
# Set variable $2 to lease field $1 in seconds, or to empty when the lease
# omits it. Called directly, so its refusals reach stdout.
lease_num() {
  local v
  lease_unique "$1"
  v="$(lease_value "$1")"
  if [ -n "$v" ]; then
    [[ "$v" =~ ^0x[0-9a-fA-F]{1,8}$ ]] || refuse "the DHCP lease's $1 is malformed: $v"
    v=$((16#${v#0x}))
  fi
  printf -v "$2" '%s' "$v"
}
# One of ipconfig's lease clock strings as "<epoch> <form> <utc offset in
# minutes>", or a non-zero exit when it is neither form or names no real time.
# `YYYY-MM-DD HH:MM:SS +ZZZZ` carries its zone. macOS 26 prints
# `MM/DD/YYYY HH:MM:SS` with none, in the calling process's zone, so ipconfig
# is called under TZ=UTC and that form is read as UTC.
lease_clock() {
  node -e '
    const raw = process.argv[1];
    let t = NaN, form = "", offset = NaN;
    let m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-])(\d\d)(\d\d)$/.exec(raw);
    if (m) {
      t = Date.parse(m[1] + "T" + m[2] + m[3] + m[4] + ":" + m[5]);
      form = "zoned";
      offset = (m[3] === "-" ? -1 : 1) * (Number(m[4]) * 60 + Number(m[5]));
    } else if ((m = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d)$/.exec(raw))) {
      const [mo, d, y, h, mi, s] = m.slice(1).map(Number);
      const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
      const same = utc.getUTCFullYear() === y && utc.getUTCMonth() === mo - 1 && utc.getUTCDate() === d
        && utc.getUTCHours() === h && utc.getUTCMinutes() === mi && utc.getUTCSeconds() === s;
      if (same) { t = utc.getTime(); form = "utc"; offset = 0; }
    }
    if (!Number.isFinite(t) || !Number.isFinite(offset)) process.exit(1);
    process.stdout.write(Math.floor(t / 1000) + " " + form + " " + offset);
  ' "$1"
}
if [ "$mode" = 'admin' ] || [ "$mode" = 'setup' ]; then
  command -v node >/dev/null 2>&1 || refuse "node is missing"
  lease="$(bounded ipconfig getpacket "$SOAK_GUEST_IF" 2>/dev/null || true)"
  [ -n "$lease" ] || refuse "$SOAK_GUEST_IF has no DHCP lease to attest (ipconfig getpacket)"
  lease_unique server_identifier
  lease_server="$(lease_value server_identifier)"
  valid_ipv4 "$lease_server" || refuse "the DHCP lease's server_identifier is missing or malformed: '$lease_server'"
  [ -n "$SOAK_DHCP_SERVER" ] || refuse "set SOAK_DHCP_SERVER to the host-controlled DHCP server proven in the dry run (this lease names $lease_server); a lease alone is not trusted"
  valid_ipv4 "$SOAK_DHCP_SERVER" || refuse "SOAK_DHCP_SERVER is not an IPv4 address: $SOAK_DHCP_SERVER"
  [ "$SOAK_DHCP_SERVER" = "$lease_server" ] || refuse "the lease's DHCP server is $lease_server, not the configured $SOAK_DHCP_SERVER"
  dhcp_server="$SOAK_DHCP_SERVER"

  # The lease's timing, normalized to epoch seconds. It must be present (the
  # timers may be derived, below), consistent and live, because a lease that
  # lapses mid-run takes the management path with it. Each is checked directly, never inside $(...),
  # so a refusal reaches stdout.
  lease_num lease_time lease_s
  lease_num renewal_t1_time_value renew_s
  lease_num rebinding_t2_time_value rebind_s
  # A lease that omits BOTH timers gets RFC 2131's defaults (4.4.5): renew at
  # half the lease, rebind at seven-eighths of it, rounded down: the timers a
  # conforming client uses when the server sends none. Tart's vmnet DHCP
  # server sends leases of that shape. A lease that carries only one timer does not match
  # either shape, so it is refused rather than half derived. The source is
  # attested, so evidence shows which timings the server actually sent.
  [ -n "$lease_s" ] || refuse "the DHCP lease must report lease_time"
  if [ -n "$renew_s" ] && [ -n "$rebind_s" ]; then
    timing_source='lease'
  elif [ -z "$renew_s" ] && [ -z "$rebind_s" ]; then
    renew_s=$((lease_s / 2))
    rebind_s=$((lease_s * 7 / 8))
    timing_source='derived-rfc2131'
  else
    refuse "the DHCP lease must report lease_time, renewal_t1_time_value and rebinding_t2_time_value, or omit both timers to have them derived; it reports only $([ -n "$renew_s" ] && echo renewal_t1_time_value || echo rebinding_t2_time_value)"
  fi
  # Strictly 0 < renewal < rebinding < lease, whether reported or derived;
  # equality fails.
  [ "$renew_s" -gt 0 ] && [ "$renew_s" -lt "$rebind_s" ] && [ "$rebind_s" -lt "$lease_s" ] \
    || refuse "the lease's timing is inconsistent: renewal $renew_s s, rebinding $rebind_s s, lease $lease_s s must satisfy 0 < renewal < rebinding < lease"

  # When the lease began, as the system reports it, parsed strictly. Anything
  # else, or the field reported twice, is refused. ipconfig prints one of two
  # forms: `YYYY-MM-DD HH:MM:SS +ZZZZ`, which carries its zone, or, on macOS
  # 26, `MM/DD/YYYY HH:MM:SS`, which does not. The zoneless form is printed in
  # the calling process's time zone, so ipconfig runs with TZ=UTC and that
  # form is read as UTC: nothing then depends on the admin's shell or the
  # guest's zone. It must name a real calendar day and time. The form and the
  # UTC offset used are attested, so the evidence shows the reading.
  summary="$(TZ=UTC bounded ipconfig getsummary "$SOAK_GUEST_IF" 2>/dev/null || true)"
  summary_field() { sed -n "s/^[[:space:]]*$1[[:space:]]*:[[:space:]]*//p" <<< "$summary"; }
  lease_start_raw="$(summary_field LeaseStartTime)"
  [ -n "$lease_start_raw" ] || refuse "ipconfig does not report when the lease started (LeaseStartTime), so its expiry cannot be attested"
  [ "$(grep -c . <<< "$lease_start_raw")" -eq 1 ] || refuse "ipconfig reports LeaseStartTime more than once"
  lease_start_parsed="$(lease_clock "$lease_start_raw")" \
    || refuse "LeaseStartTime is not in the expected form (YYYY-MM-DD HH:MM:SS +ZZZZ, or MM/DD/YYYY HH:MM:SS as printed under TZ=UTC): $lease_start_raw"
  read -r lease_start lease_start_form lease_start_offset <<< "$lease_start_parsed"
  now_epoch="$(date -u +%s)"
  # Not before 2000, and not ahead of this clock by more than a minute.
  [ "$lease_start" -ge 946684800 ] && [ "$lease_start" -le $((now_epoch + 60)) ] || refuse "the lease start $lease_start_raw is out of range"
  lease_expiry=$((lease_start + lease_s))
  # ipconfig's own expiry, where it reports one, must be the start plus the
  # lease time; a disagreement means one of the two readings is wrong.
  lease_expiry_raw="$(summary_field LeaseExpirationTime)"
  lease_expiry_field="dhcp.leaseExpiryRaw=z:"
  if [ -n "$lease_expiry_raw" ]; then
    [ "$(grep -c . <<< "$lease_expiry_raw")" -eq 1 ] || refuse "ipconfig reports LeaseExpirationTime more than once"
    lease_expiry_parsed="$(lease_clock "$lease_expiry_raw")" \
      || refuse "LeaseExpirationTime is not in the expected form (YYYY-MM-DD HH:MM:SS +ZZZZ, or MM/DD/YYYY HH:MM:SS as printed under TZ=UTC): $lease_expiry_raw"
    read -r reported_expiry _ <<< "$lease_expiry_parsed"
    [ "$reported_expiry" = "$lease_expiry" ] \
      || refuse "ipconfig's LeaseExpirationTime $lease_expiry_raw ($reported_expiry) disagrees with LeaseStartTime plus lease_time ($lease_expiry)"
    lease_expiry_field="dhcp.leaseExpiryRaw=s:$lease_expiry_raw"
  fi
  [ "$lease_expiry" -gt "$now_epoch" ] || refuse "the DHCP lease expired at $lease_expiry (now $now_epoch)"
  [ $((lease_expiry - now_epoch)) -ge "$attest_window" ] || refuse "the DHCP lease has $((lease_expiry - now_epoch)) s left, less than the next sample interval plus margin ($attest_window s)"
  lease_fields=("dhcp.server=s:$dhcp_server" "dhcp.leaseServer=s:$lease_server"
    "dhcp.leaseSeconds=n:$lease_s" "dhcp.leaseStartRaw=s:$lease_start_raw"
    "dhcp.leaseStartForm=s:$lease_start_form" "dhcp.leaseStartUtcOffsetMinutes=n:$lease_start_offset"
    "dhcp.leaseStartEpoch=n:$lease_start" "dhcp.leaseExpiryEpoch=n:$lease_expiry" "$lease_expiry_field"
    "dhcp.renewEpoch=n:$((lease_start + renew_s))" "dhcp.rebindEpoch=n:$((lease_start + rebind_s))"
    "dhcp.timingSource=s:$timing_source"
    "dhcp.observedEpoch=n:$now_epoch" "dhcp.remainingSeconds=n:$((lease_expiry - now_epoch))"
    "dhcp.requiredSeconds=n:$attest_window" "dhcp.sampleIntervalSeconds=n:$SOAK_SAMPLE_INTERVAL" "dhcp.safetyMarginSeconds=n:$SOAK_SAFETY_MARGIN")
fi

pf_macros=(-D "host_addr=$SOAK_HOST_ADDR" -D "dhcp_server=$dhcp_server" -D "guest_if=$SOAK_GUEST_IF")

# The TangleClaw listening on SOAK_TC_PORT must be one process, running as the
# workload user, executing node. Every fact comes from the kernel, through
# lsof and ps, never from anything the process says about itself. Seeing
# another user's process needs sudo, so this is the admin plane's check. Sets
# tc_uid, tc_pid and tc_exe.
tc_uid=''; tc_pid=''; tc_exe=''
# A path with every symlink resolved, by node's fs.realpathSync.
canonical() { node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$1" 2>/dev/null; }
check_tc_owner() {
  local want listen pids uids ps_uid
  want="$(id -u "$user" 2>/dev/null)" || refuse "no workload user $user; run guest-setup.sh --bootstrap-user first"
  # lsof exits non-zero when nothing listens; that is the empty answer below.
  listen="$( { bounded sudo -n lsof -nP -iTCP:"$SOAK_TC_PORT" -sTCP:LISTEN -Fpu 2>/dev/null || true; } )"
  pids="$(sed -n 's/^p//p' <<< "$listen" | sort -u)"
  uids="$(sed -n 's/^u//p' <<< "$listen" | sort -u)"
  [ -n "$pids" ] || refuse "nothing is listening on port $SOAK_TC_PORT: start the pinned TangleClaw as $user first"
  [ "$(grep -c . <<< "$pids")" -eq 1 ] || refuse "more than one process listens on port $SOAK_TC_PORT ($(tr '\n' ' ' <<< "$pids")): which one is TangleClaw is ambiguous"
  [ "$uids" = "$want" ] || refuse "the TangleClaw on port $SOAK_TC_PORT runs as uid $(tr '\n' ' ' <<< "$uids")not $user ($want): its sessions would not be the confined workload"
  ps_uid="$(bounded ps -o uid= -p "$pids" 2>/dev/null | tr -d '[:space:]' || true)"
  [ "$ps_uid" = "$want" ] || refuse "ps reports pid $pids as uid '$ps_uid', not $user ($want)"
  # The executable, from the kernel's view of the process's mapped text: lsof
  # lists the program and its libraries, and exactly one entry may be a node
  # binary. Not ps's comm, which on macOS is the process's own argv[0] (a bare
  # "node" when started from PATH) and so is the process's word, not the
  # kernel's.
  local txt node_txt
  txt="$( { bounded sudo -n lsof -nP -a -p "$pids" -d txt -Fn 2>/dev/null || true; } | sed -n 's/^n//p')"
  node_txt="$(grep -E '(^|/)node$' <<< "$txt" || true)"
  [ -n "$node_txt" ] && [ "$(grep -c . <<< "$node_txt")" -eq 1 ] || refuse "pid $pids on port $SOAK_TC_PORT maps $(grep -c . <<< "$node_txt") node executables: its executable is not established"
  tc_exe="$(canonical "$node_txt")" || refuse "cannot canonicalize the TangleClaw executable $node_txt"
  tc_uid="$want"; tc_pid="$pids"
}

# The workload account must be the one this script makes: a regular uid, its
# own home owned by it, in neither admin nor wheel, with no sudo rights. An
# existing account that differs is someone else's; it is refused, never
# adopted or changed. Setup and every admin attestation run this.
check_workload_identity() {
  local wl_uid wl_home g rc
  wl_uid="$(id -u "$user" 2>/dev/null || true)"
  [[ "$wl_uid" =~ ^[0-9]+$ ]] && [ "$wl_uid" -ge 501 ] || refuse "$user has uid '$wl_uid', a system or unknown uid: not a workload account this script made"
  wl_home="$(dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: *//p')"
  [ "$wl_home" = "/Users/$user" ] || refuse "$user's home is '$wl_home', not /Users/$user: not a workload account this script made"
  [ "$(stat -f %u "$wl_home" 2>/dev/null || true)" = "$wl_uid" ] || refuse "$wl_home is not owned by $user ($wl_uid)"
  # dseditgroup exits 0 for a member and 67 for a non-member; any other status
  # is an answer it could not give, so membership stays unknown and is refused.
  for g in admin wheel; do
    rc=0
    dseditgroup -o checkmember -m "$user" "$g" >/dev/null 2>&1 || rc=$?
    case "$rc" in
      0) breach privileged-workload "$user is a member of $g; the workload must not be an admin (fix it by hand, this script never demotes an account)" ;;
      67) ;;
      *) refuse "dseditgroup exited $rc checking whether $user is in $g: its membership is not established" ;;
    esac
  done
  # Judged by exit status, not by sudo's (localized) wording: `sudo -l -U
  # <user> <command>` exits 0 only when the policy permits that command. A
  # shell, pfctl and a no-op cover general, pf-specific and blanket grants.
  local c
  # Two positive controls first, or a "no" for the workload could be sudo
  # failing (expired credentials, a broken policy) rather than a refusal: the
  # admin can run a command with sudo right now, and the same policy query says
  # yes for the admin. Then only exit status 1 counts as the policy's "no";
  # anything else is unknown and refused.
  bounded sudo -n true >/dev/null 2>&1 \
    || refuse "sudo does not run for $admin_name right now, so no answer about $user's rights can be trusted"
  bounded sudo -n -l -U "$admin_name" /usr/bin/true >/dev/null 2>&1 \
    || refuse "sudo -l does not confirm $admin_name's own rights, so its answer for $user would prove nothing"
  for c in /bin/sh /sbin/pfctl /usr/bin/true; do
    rc=0
    bounded sudo -n -l -U "$user" "$c" >/dev/null 2>&1 || rc=$?
    case "$rc" in
      1) ;;
      0) breach sudo-permitted "$user has sudo rights ($c is permitted); the workload must have none" ;;
      124) refuse "sudo -l for $user hung: its rights are not established" ;;
      *) refuse "sudo -l for $user exited $rc for $c: its rights are not established" ;;
    esac
  done
}

# --- The admin plane ---
verify_admin() {
  bounded sudo -n true >/dev/null 2>&1 || refuse "the admin verifier needs non-interactive sudo"
  check_workload_identity
  check_workload_cannot_write
  local info rules expected addr
  info="$(bounded sudo -n pfctl -s info 2>/dev/null)" || refuse "cannot read pf status"
  if ! grep -q '^Status: Enabled' <<< "$info"; then
    grep -q '^Status: Disabled' <<< "$info" && breach pf-disabled "pf is not enabled (pfctl reports Disabled)"
    refuse "cannot tell from pfctl whether pf is enabled"
  fi
  # pfctl's own parse of the profile, so the comparison assumes no output format.
  expected="$(bounded sudo -n pfctl -n -v "${pf_macros[@]}" -f "$here/pf/soak-deny.conf" 2>/dev/null | grep -E '^(block|pass) ')" \
    || refuse "pfctl cannot parse the soak profile"
  [ "$(grep -c . <<< "$expected")" -eq "$(grep -cE '^(block|pass) ' "$here/pf/soak-deny.conf")" ] \
    || refuse "pfctl's parse of the profile has an unexpected number of rules"
  # pfctl warns that the kernel has no ALTQ support in two fixed lines. They go
  # to stderr, but they are never rules, so they are dropped here too.
  rules="$(bounded sudo -n pfctl -s rules 2>/dev/null | sed -e '/^[[:space:]]*$/d' -e '/^No ALTQ support in kernel$/d' -e '/^ALTQ related functions disabled$/d')" || refuse "cannot read pf's loaded rules"
  local expected_sha active_sha
  expected_sha="$(printf '%s\n' "$expected" | shasum -a 256 | cut -d' ' -f1)"
  active_sha="$(printf '%s\n' "$rules" | shasum -a 256 | cut -d' ' -f1)"
  if [ "$rules" != "$expected" ]; then
    fail_extra=("pf.expectedRulesSha256=s:$expected_sha" "pf.activeRulesSha256=s:$active_sha" "pf.rulesMatch=b:false")
    breach pf-rules-changed "pf's loaded rules are not exactly the soak profile:
$rules"
  fi
  bounded sudo -n pfctl -s Interfaces -v 2>/dev/null | grep -Eq '^lo0 .*\(skip\)' || refuse "pf is not skipping lo0"
  bounded ifconfig "$SOAK_GUEST_IF" >/dev/null 2>&1 || refuse "no interface $SOAK_GUEST_IF"
  addr="$(bounded ipconfig getifaddr "$SOAK_GUEST_IF" 2>/dev/null || true)"
  valid_ipv4 "$addr" || refuse "$SOAK_GUEST_IF has no IPv4 address"
  bounded netstat -an -p tcp 2>/dev/null | grep -Eq '[.:]22[[:space:]].*LISTEN' || refuse "nothing is listening on port 22: the SSH management path is down"
  check_tc_owner
  emit_json "schema=s:$SCHEMA" "mode=s:admin" "ok=b:true" "${common_json[@]}" \
    "pf.enabled=b:true" "pf.expectedRulesSha256=s:$expected_sha" "pf.activeRulesSha256=s:$active_sha" "pf.rulesMatch=b:true" "pf.rules=n:$(grep -c . <<< "$rules")" \
    "interface.name=s:$SOAK_GUEST_IF" "interface.address=s:$addr" "host=s:$SOAK_HOST_ADDR" \
    "${lease_fields[@]}" \
    "management.ssh=s:listening" "tangleclaw.port=n:$SOAK_TC_PORT" "tangleclaw.user=s:$user" "tangleclaw.uid=n:$tc_uid" "tangleclaw.pid=n:$tc_pid" "tangleclaw.executable=s:$tc_exe" \
    "trust.files=n:${#trusted_inputs[@]}" "trust.dirs=n:${#trusted_dirs[@]}" "trust.workloadCannotWrite=b:true"
}

# --- The workload plane ---
verify_workload() {
  local me uid groups g
  me="$(id -un)"
  [ "$me" = "$user" ] || refuse "the workload verifier must run as $user, not $me"
  uid="$(id -u)"
  [[ "$uid" =~ ^[0-9]+$ ]] || refuse "cannot read the workload uid: '$uid'"
  [ "$uid" != 0 ] || breach privileged-workload "workload uid 0 is a system or root uid (root)"
  [ "$uid" -ge 501 ] || refuse "workload uid $uid is a system or root uid"
  groups="$(id -Gn)"
  for g in $groups; do
    case "$g" in admin|wheel) breach privileged-workload "$user is in the $g group" ;; esac
  done
  # The numeric group ids too, so the certification record never has to infer
  # them from names. Admin (80) and wheel (0) are refused by number as well.
  gids="$(id -G)"
  [[ "$gids" =~ ^[0-9]+( [0-9]+)*$ ]] || refuse "cannot read $user's numeric group ids: '$gids'"
  for g in $gids; do
    case "$g" in 0|80) breach privileged-workload "$user is in group $g (wheel or admin)" ;; esac
  done
  # Each must be refused to the workload. A hang is not a refusal.
  local rc=0
  bounded sudo -n true >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || breach sudo-permitted "sudo works for $user"
  [ "$rc" -ne 124 ] || refuse "sudo hung for $user: refusal is not proven"
  rc=0
  bounded pfctl -s info >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || breach pfctl-permitted "pfctl works for $user"
  [ "$rc" -ne 124 ] || refuse "pfctl hung for $user: refusal is not proven"

  # Loopback must work, or the soak would fail for the wrong reason.
  bounded ping -c 1 127.0.0.1 >/dev/null 2>&1 || refuse "IPv4 loopback is unreachable"
  bounded ping6 -c 1 ::1 >/dev/null 2>&1 || refuse "IPv6 loopback is unreachable"
  bounded curl -fsS --max-time "$t" "$api/api/health" >/dev/null 2>&1 || refuse "no TangleClaw answering at $api"

  # Nothing outside may answer. Every probe uses a literal address, so none
  # depends on DNS.
  command -v nc >/dev/null 2>&1 || refuse "nc is missing, so TCP egress cannot be checked"
  command -v dig >/dev/null 2>&1 || refuse "dig is missing, so DNS egress cannot be checked"
  must_be_denied "TCP to $SOAK_EGRESS_PROBE_ADDR:443 (IPv4)" nc -z -G 3 "$SOAK_EGRESS_PROBE_ADDR" 443
  must_be_denied "TCP to [$SOAK_EGRESS_PROBE_ADDR6]:443 (IPv6)" nc -6 -z -G 3 "$SOAK_EGRESS_PROBE_ADDR6" 443
  must_be_denied "a DNS query to $SOAK_DNS_PROBE_ADDR over UDP" dig "@$SOAK_DNS_PROBE_ADDR" +time=2 +tries=1 +short tangleclaw.invalid

  emit_json "schema=s:$SCHEMA" "mode=s:workload" "ok=b:true" "${common_json[@]}" \
    "identity.user=s:$me" "identity.uid=n:$uid" "identity.groups=s:$groups" "identity.gids=s:$gids" \
    "refused.sudo=b:true" "refused.pfctl=b:true" \
    "loopback.ipv4=b:true" "loopback.ipv6=b:true" "loopback.api=b:true" \
    "egress.tcp4=s:denied" "egress.tcp6=s:denied" "egress.udpDns=s:denied" \
    "probes.tcp4=s:$SOAK_EGRESS_PROBE_ADDR" "probes.tcp6=s:$SOAK_EGRESS_PROBE_ADDR6" "probes.udpDns=s:$SOAK_DNS_PROBE_ADDR"
}

# --- One certification sample: both planes, fresh, joined and bound ---
# Runs as the trusted guest admin only. Each call takes a new --verify-admin
# line and a new --verify-workload line (as the workload user, with exactly
# the SOAK_ settings), and hands both, with the binding, to the bridge, which
# refuses anything it cannot convert without guessing. Nothing is read from a
# file or reused from an earlier sample, so no attestation is ever stamped
# with a binding it was not produced for. Any failure prints nothing on stdout.
verify_network() {
  [ "$admin_name" != "$user" ] || refuse "--verify-network runs as the guest admin, not as the workload user $user"
  bounded sudo -n true >/dev/null 2>&1 || refuse "--verify-network needs the admin's non-interactive sudo"
  local net_env=() v admin_line workload_line pair
  while IFS= read -r v; do net_env+=("$v=${!v}"); done < <(compgen -v SOAK_)
  # Each child's line and exit status go to the bridge, which alone decides:
  # both ok is a pair; a MEASURED breach from either (exit 3, code BREACH) is
  # a bound breach envelope; anything else yields nothing.
  local admin_rc=0 workload_rc=0
  admin_line="$(bash "$here/guest-setup.sh" --verify-admin)" || admin_rc=$?
  workload_line="$(sudo -n -u "$user" -H env "${net_env[@]}" bash "$here/guest-setup.sh" --verify-workload)" || workload_rc=$?
  pair="$(node -e 'process.exitCode = require(process.argv[1]).main(process.argv.slice(2), process)' \
    "$repo/lib/soak/attest-bridge.js" "$admin_line" "$admin_rc" "$workload_line" "$workload_rc" "$net_candidate" "$net_run_id" "$net_digest" "$net_seq")" \
    || refuse "the two attestations could not be joined into one bound result"
  [ -n "$pair" ] && [ "$(grep -c . <<< "$pair")" -eq 1 ] || refuse "the bridge did not produce exactly one line"
  printf '%s\n' "$pair"
}

if [ "$mode" = 'admin' ]; then verify_admin; exit 0; fi
if [ "$mode" = 'workload' ]; then verify_workload; exit 0; fi
if [ "$mode" = 'network' ]; then verify_network; exit 0; fi

# --- Setup (admin, with sudo) ---
# `sudo true`, not `sudo -v`: on macOS 26 `-v` asks for a password even under a
# NOPASSWD rule unless verifypw allows it. Either way this caches credentials
# for the `sudo -n` calls that follow.
sudo true || refuse "setup needs sudo for $admin_name"
# The workload user's commands get exactly these settings, since sudo resets
# the environment.
soak_env=()
while IFS= read -r v; do soak_env+=("$v=${!v}"); done < <(compgen -v SOAK_)
as_user() { sudo -n -u "$user" -H env "${soak_env[@]}" "$@"; }

echo "== 1/6 workload user $user"
if id "$user" >/dev/null 2>&1; then
  echo "$user exists"
else
  # A random password nobody keeps: the account cannot be logged into, and the
  # admin reaches it only through sudo -u.
  sudo -n sysadminctl -addUser "$user" -fullName "TangleClaw soak workload" -home "/Users/$user" \
    -password "$(openssl rand -hex 32)" >/dev/null 2>&1 || refuse "could not create $user"
  # sysadminctl run over SSH records the home but does not create it.
  [ -d "/Users/$user" ] || sudo -n createhomedir -c -u "$user" >/dev/null 2>&1 \
    || refuse "could not create $user's home directory"
  echo "$user created"
fi
check_workload_identity
check_workload_cannot_write
if [ "$mode" = 'bootstrap' ]; then
  echo "workload user $user is ready. Next: start the pinned TangleClaw as $user on 127.0.0.1:$SOAK_TC_PORT, then run guest-setup.sh"
  exit 0
fi
as_user test -r "$here/guest-setup.sh" && as_user test -r "$repo/scripts/soak.js" \
  || refuse "the checkout at $repo is not readable by $user; give it mode 0755 in a dedicated hierarchy such as /opt/tangleclaw-soak"

check_tc_owner
echo "TangleClaw on port $SOAK_TC_PORT runs as $user"

echo "== 2/6 default-deny network"
sudo -n pfctl "${pf_macros[@]}" -f "$here/pf/soak-deny.conf" -E
# The admin verifier runs as its own --verify-admin process, so a failure's
# ok:false line is printed rather than lost inside a command substitution.
admin_json="$(bash "$here/guest-setup.sh" --verify-admin)" || { echo "$admin_json"; refuse "the admin verifier failed"; }
echo "$admin_json"
workload_json="$(as_user bash "$here/guest-setup.sh" --verify-workload)" || { echo "$workload_json"; refuse "the workload verifier failed"; }
echo "$workload_json"

echo "== 3/6 stub engine"
# A macOS 26 base image has no /usr/local/bin, the default install target.
sudo -n install -d -o root -g wheel -m 0755 "$SOAK_BIN_DIR"
sudo -n install -m 0755 "$repo/deploy/soak/stub-engine/soak-stub.js" "$SOAK_BIN_DIR/soak-stub"
as_user mkdir -p "/Users/$user/.tangleclaw/engines"
as_user install -m 0644 "$repo/deploy/soak/stub-engine/soak-stub.json" "/Users/$user/.tangleclaw/engines/soak-stub.json"

echo "== 4/6 synthetic repos"
as_user node "$repo/scripts/soak.js" repos --root "$SOAK_PROJECTS_ROOT" --origins "$SOAK_ORIGINS_ROOT" --projects "$SOAK_PROJECTS" \
  || refuse "soak.js repos failed (see above)"

echo "== 5/6 finish setup, attach projects"
# With the guest's auth gate down, the dashboard client header is how the
# operator's own tools reach operator routes. With the gate up, attach through
# the dashboard instead.
#
# A fresh install opens on its first-run wizard, which covers the dashboard
# until setup finishes, and keeps the default projects directory under
# ~/Documents, which macOS privacy protection stops a launchd server reading
# without a prompt nobody can answer. So setup is finished here, once, the way
# the wizard's last step finishes it: with the choice of no login (the server
# binds loopback only and pf admits nothing but SSH from the host) and the
# soak's projects root. A later run finds it finished and only checks it.
setup_body="$(node -e 'process.stdout.write(JSON.stringify({ noLogin: true, projectsDir: process.argv[1] }))' "$SOAK_PROJECTS_ROOT")"
# The reply body is kept: a refusal names its cause (ENGINE_REQUIRED,
# OPT_OUT_REFUSED, ...) only there, and the server does not log it.
setup_out="$(mktemp)"
status="$(curl -sS -o "$setup_out" -w '%{http_code}' --max-time "$t" -X POST \
  -H 'content-type: application/json' -H 'x-tangleclaw-client: dashboard' \
  -d "$setup_body" "$api/api/setup/complete" || true)"
setup_reply="$(cat "$setup_out" 2>/dev/null || true)"
rm -f "$setup_out"
setup_why="$(node -e '
  try { const r = JSON.parse(process.argv[1]); if (r && r.code) process.stdout.write(`: ${r.code}: ${r.error || ""}`); } catch {}
' "$setup_reply")"
case "$status" in
  200) echo "setup finished: no login, projects in $SOAK_PROJECTS_ROOT" ;;
  409) echo "setup already finished" ;;
  401|403) refuse "finishing setup answered $status: the guest's auth gate is up; finish setup and attach the soak-* projects from the dashboard" ;;
  *) refuse "finishing the guest's first-run setup answered $status$setup_why" ;;
esac
config_json="$(curl -sS --max-time "$t" -H 'x-tangleclaw-client: dashboard' "$api/api/config" || true)"
node -e '
  const path = require("path");
  let c;
  try { c = JSON.parse(process.argv[1]); } catch { console.error("the guest config did not parse"); process.exit(1); }
  if (c.setupComplete !== true) { console.error("setup is not complete"); process.exit(1); }
  if (typeof c.projectsDir !== "string" || path.resolve(c.projectsDir) !== path.resolve(process.argv[2])) {
    console.error(`projectsDir is ${JSON.stringify(c.projectsDir)}, not ${process.argv[2]}`);
    process.exit(1);
  }
' "$config_json" "$SOAK_PROJECTS_ROOT" || refuse "the guest's TangleClaw is not set up for the soak (see above)"

IFS=',' read -r -a projects <<< "$SOAK_PROJECTS"
for name in "${projects[@]}"; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$t" "$api/api/projects/$name" || true)"
  if [ "$status" = "200" ]; then echo "$name: already attached"; continue; fi
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$t" -X POST \
    -H 'content-type: application/json' -H 'x-tangleclaw-client: dashboard' \
    -d "{\"name\":\"$name\"}" "$api/api/projects/attach" || true)"
  case "$status" in
    201|200) echo "$name: attached" ;;
    409) echo "$name: already attached" ;;
    401|403) refuse "attach $name answered $status: the guest's auth gate is up; attach the soak-* projects from the dashboard" ;;
    *) refuse "attach $name answered $status (is the guest's projectsDir $SOAK_PROJECTS_ROOT?)" ;;
  esac
done

echo "== 6/6 switchboard stub hub"
# The guest is offline, so no real Medusa hub can run in it, and without one no
# session's switchboard listener ever reaches listening. The stub hub speaks the
# part of the protocol the candidate uses, on loopback only. It runs as a
# LaunchAgent in the workload user's GUI session, so launchd restarts it if it
# dies during a run and loads it again at login after a restart. Its ports are
# leased in the guest TangleClaw's registry before it binds them.
hub_label='com.tangleclaw.soak-medusa-stub'
# The candidate's own defaults: it looks for its hub at MEDUSA_BRIDGE_HTTP_URL,
# http://localhost:3009 unless its environment says otherwise, and derives the
# WebSocket as the next port. The install sets neither, so the hub takes exactly
# these. They are not settings: a hub anywhere else would be one the candidate
# never finds. If another service holds them, setup refuses.
hub_http_port=3009
hub_ws_port=3010
hub_home="/Users/$user"
hub_plist="$hub_home/Library/LaunchAgents/$hub_label.plist"
hub_node="$(as_user /bin/sh -c 'command -v node')" || refuse "node is not on $user's PATH"
case "$hub_node$repo" in *[\<\>\&\"\']*) refuse "the node path or checkout path holds a character the LaunchAgent cannot carry" ;; esac
for spec in "$hub_http_port:http" "$hub_ws_port:websocket"; do
  port="${spec%%:*}"
  lease_body="$(node -e 'process.stdout.write(JSON.stringify({ port: Number(process.argv[1]), host: "localhost", project: "soak-medusa-stub", service: `medusa-stub-${process.argv[2]}`, permanent: true, reach: "loopback", ownerKind: "external" }))' "$port" "${spec#*:}")"
  # The reply names why a lease failed (who holds the port, or what was wrong
  # with the request), so it is kept rather than discarded.
  lease_out="$(mktemp)"
  status="$(curl -sS -o "$lease_out" -w '%{http_code}' --max-time "$t" -X POST \
    -H 'content-type: application/json' -H 'x-tangleclaw-client: dashboard' \
    -d "$lease_body" "$api/api/ports/lease" || true)"
  lease_reply="$(cat "$lease_out" 2>/dev/null || true)"
  rm -f "$lease_out"
  lease_why="$(node -e '
    try { const r = JSON.parse(process.argv[1]); if (r && r.code) process.stdout.write(`: ${r.code}: ${r.error || ""}`); } catch {}
  ' "$lease_reply")"
  [ "$status" = "201" ] || [ "$status" = "200" ] || refuse "leasing port $port for the stub hub answered $status$lease_why"
done
as_user mkdir -p "$hub_home/Library/LaunchAgents" "$hub_home/Library/Logs"
hub_tmp="$(mktemp)"
cat > "$hub_tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$hub_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$hub_node</string>
    <string>$repo/deploy/soak/medusa-stub/medusa-stub.js</string>
    <string>--http-port</string><string>$hub_http_port</string>
    <string>--ws-port</string><string>$hub_ws_port</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$hub_home/Library/Logs/soak-medusa-stub.log</string>
  <key>StandardErrorPath</key><string>$hub_home/Library/Logs/soak-medusa-stub.log</string>
</dict>
</plist>
PLIST
chmod 0644 "$hub_tmp"
as_user install -m 0644 "$hub_tmp" "$hub_plist"
rm -f "$hub_tmp"
wl_uid="$(id -u "$user")"
# Replace a hub an earlier run loaded, so this run's checkout is the one serving.
sudo -n launchctl bootout "gui/$wl_uid/$hub_label" >/dev/null 2>&1 || true
sudo -n launchctl bootstrap "gui/$wl_uid" "$hub_plist" \
  || refuse "launchd would not load the stub hub in $user's GUI session (is $user logged in? see install step 8)"
hub_up=''
for _ in $(seq 1 "$t"); do
  if curl -sS --max-time "$t" "http://127.0.0.1:$hub_http_port/health" 2>/dev/null | grep -q '"status":"hissing"'; then hub_up=1; break; fi
  sleep 1
done
[ -n "$hub_up" ] || refuse "the stub hub did not answer on 127.0.0.1:$hub_http_port within $t s (see $hub_home/Library/Logs/soak-medusa-stub.log)"

echo "guest ready: workload user $user, default-deny network attested on both planes, stub engine, projects $SOAK_PROJECTS, stub hub on $hub_http_port/$hub_ws_port"
