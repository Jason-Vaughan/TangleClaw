#!/usr/bin/env bash
# Prepare and attest the inside of the soak guest (#2020).
#
#   guest-setup.sh                    set the guest up (admin, with sudo)
#   guest-setup.sh --verify-admin     attest the admin plane (admin, with sudo)
#   guest-setup.sh --verify-workload  attest the workload plane (as the workload user)
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
# sha256 of this script and of the pf profile. The soak runner joins the two at admission, at every
# evidence sample and at finalization. A reboot changes the boot identity.
#
# Setup, in order, stopping at the first failure:
#   1. create (or confirm) the workload user: not an admin, no sudo;
#   2. load the default-deny pf profile, then run both verifiers;
#   3. install the stub engine on PATH and its profile for the workload user;
#   4. create the synthetic repos as the workload user (soak.js repos);
#   5. attach each repo as a project through the guest TangleClaw's own API.
# Every step is safe to repeat. The TangleClaw checkout must be readable by the
# workload user (for example under /Users/Shared).
#
# Every mode refuses to run anywhere but a macOS VM with no live TangleClaw
# pane, and validates its inputs before pf sees them.
#
# Exit codes: 0 done, 2 usage, 3 refused (a verifier's JSON line says why),
# any other non-zero: the failing setup step's own code.
set -euo pipefail

SCHEMA='tc.soak-guest-attest/v1'
mode='setup'
case "${1:-}" in
  '') ;;
  --verify-admin) mode='admin' ;;
  --verify-workload) mode='workload' ;;
  *) echo "usage: guest-setup.sh [--verify-admin | --verify-workload]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: guest-setup.sh [--verify-admin | --verify-workload]" >&2; exit 2; }

# A JSON string, escaped for the characters these values can carry.
jstr() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; printf '"%s"' "$s"; }

# Extra JSON members a failure carries, set just before a refusal that has
# evidence worth keeping (such as both ruleset digests).
fail_extra=''
refuse() {
  echo "refused: $*" >&2
  if [ "$mode" != 'setup' ]; then
    printf '{"schema":%s,"mode":%s,"ok":false,"reason":%s%s}\n' "$(jstr "$SCHEMA")" "$(jstr "$mode")" "$(jstr "$*")" "$fail_extra"
  fi
  exit 3
}

# A pane launched by a live TangleClaw exports TANGLECLAW_API. This script
# rewrites the firewall, creates a user and registers projects, so it never
# runs there.
[ -z "${TANGLECLAW_API:-}" ] || refuse "TANGLECLAW_API is set: this is a live TangleClaw pane, not the soak guest"
[ "$(uname -s)" = "Darwin" ] || refuse "the soak guest is macOS; this is $(uname -s)"
[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null || echo 0)" = "1" ] || refuse "not a virtual machine (kern.hv_vmm_present != 1); guest-setup.sh runs only inside the soak guest"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
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
[[ "$SOAK_PROJECTS" =~ ^soak-[a-z0-9-]+(,soak-[a-z0-9-]+)*$ ]] || refuse "SOAK_PROJECTS must be comma-separated soak-* names: $SOAK_PROJECTS"

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
  [ "$rc" -ne 0 ] || refuse "$what answered: the guest is not isolated"
  [ "$rc" -ne 124 ] || refuse "$what hung past ${t}s: denial is not proven"
}

boot_session="$(sysctl -n kern.bootsessionuuid 2>/dev/null || true)"
# kern.boottime reads "{ sec = <epoch>, usec = <n> } <date>"; take sec, not usec.
boot_time="$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ sec = \([0-9][0-9]*\),.*/\1/p')"
[ -n "$boot_session" ] && [ -n "$boot_time" ] || refuse "cannot read the boot identity (kern.bootsessionuuid, kern.boottime)"
sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
script_sha="$(sha_of "$here/guest-setup.sh")"
profile_sha="$(sha_of "$here/pf/soak-deny.conf")"
artifact_json="{\"scriptSha256\":$(jstr "$script_sha"),\"profileSha256\":$(jstr "$profile_sha")}"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# The DHCP server pf allows: configured, or the server identifier of the
# guest's current lease. Only the admin plane needs it.
lease=''
dhcp_server="$SOAK_DHCP_SERVER"
if [ "$mode" != 'workload' ]; then
  lease="$(bounded ipconfig getpacket "$SOAK_GUEST_IF" 2>/dev/null || true)"
  if [ -z "$dhcp_server" ]; then
    dhcp_server="$(sed -n 's/^server_identifier (ip): *\([0-9.]*\)$/\1/p' <<< "$lease" | head -n 1)"
  fi
  valid_ipv4 "$dhcp_server" || refuse "no valid DHCP server: set SOAK_DHCP_SERVER, or give $SOAK_GUEST_IF a DHCP lease first (got '$dhcp_server')"
fi

pf_macros=(-D "host_addr=$SOAK_HOST_ADDR" -D "dhcp_server=$dhcp_server" -D "guest_if=$SOAK_GUEST_IF")

# --- The admin plane ---
verify_admin() {
  bounded sudo -n true >/dev/null 2>&1 || refuse "the admin verifier needs non-interactive sudo"
  local info rules expected addr lease_hex lease_seconds
  info="$(bounded sudo -n pfctl -s info 2>/dev/null)" || refuse "cannot read pf status"
  grep -q '^Status: Enabled' <<< "$info" || refuse "pf is not enabled"
  # pfctl's own parse of the profile, so the comparison assumes no output format.
  expected="$(bounded sudo -n pfctl -n -v "${pf_macros[@]}" -f "$here/pf/soak-deny.conf" 2>/dev/null | grep -E '^(block|pass) ')" \
    || refuse "pfctl cannot parse the soak profile"
  [ "$(grep -c . <<< "$expected")" -eq "$(grep -cE '^(block|pass) ' "$here/pf/soak-deny.conf")" ] \
    || refuse "pfctl's parse of the profile has an unexpected number of rules"
  rules="$(bounded sudo -n pfctl -s rules 2>/dev/null | sed '/^[[:space:]]*$/d')" || refuse "cannot read pf's loaded rules"
  local expected_sha active_sha
  expected_sha="$(printf '%s\n' "$expected" | shasum -a 256 | cut -d' ' -f1)"
  active_sha="$(printf '%s\n' "$rules" | shasum -a 256 | cut -d' ' -f1)"
  if [ "$rules" != "$expected" ]; then
    fail_extra=",\"pf\":{\"expectedRulesSha256\":$(jstr "$expected_sha"),\"activeRulesSha256\":$(jstr "$active_sha"),\"rulesMatch\":false}"
    refuse "pf's loaded rules are not exactly the soak profile:
$rules"
  fi
  bounded sudo -n pfctl -s Interfaces -v 2>/dev/null | grep -Eq '^lo0 .*\(skip\)' || refuse "pf is not skipping lo0"
  bounded ifconfig "$SOAK_GUEST_IF" >/dev/null 2>&1 || refuse "no interface $SOAK_GUEST_IF"
  addr="$(bounded ipconfig getifaddr "$SOAK_GUEST_IF" 2>/dev/null || true)"
  valid_ipv4 "$addr" || refuse "$SOAK_GUEST_IF has no IPv4 address"
  bounded netstat -an -p tcp 2>/dev/null | grep -Eq '[.:]22[[:space:]].*LISTEN' || refuse "nothing is listening on port 22: the SSH management path is down"
  # The lease pf is keeping alive: its duration, when the guest has one.
  lease_hex="$(sed -n 's/^lease_time (uint32): *0x\([0-9a-fA-F]*\)$/\1/p' <<< "$lease" | head -n 1)"
  lease_seconds='null'
  [ -z "$lease_hex" ] || lease_seconds="$((16#$lease_hex))"
  printf '{"schema":%s,"mode":"admin","ok":true,"time":%s,"boot":{"session":%s,"time":%s},"artifact":%s,"pf":{"enabled":true,"expectedRulesSha256":%s,"activeRulesSha256":%s,"rulesMatch":true,"rules":%s},"interface":{"name":%s,"address":%s},"host":%s,"dhcp":{"server":%s,"source":%s,"leaseSeconds":%s},"management":{"ssh":"listening"}}\n' \
    "$(jstr "$SCHEMA")" "$(jstr "$now")" "$(jstr "$boot_session")" "$boot_time" "$artifact_json" "$(jstr "$expected_sha")" "$(jstr "$active_sha")" "$(grep -c . <<< "$rules")" \
    "$(jstr "$SOAK_GUEST_IF")" "$(jstr "$addr")" "$(jstr "$SOAK_HOST_ADDR")" "$(jstr "$dhcp_server")" "$(jstr "$([ -n "$SOAK_DHCP_SERVER" ] && echo config || echo lease)")" "$lease_seconds"
}

# --- The workload plane ---
verify_workload() {
  local me uid groups g
  me="$(id -un)"
  [ "$me" = "$user" ] || refuse "the workload verifier must run as $user, not $me"
  uid="$(id -u)"
  [[ "$uid" =~ ^[0-9]+$ ]] && [ "$uid" -ge 500 ] || refuse "workload uid $uid is a system or root uid"
  groups="$(id -Gn)"
  for g in $groups; do
    case "$g" in admin|wheel) refuse "$user is in the $g group" ;; esac
  done
  # Each must be refused to the workload. A hang is not a refusal.
  local rc=0
  bounded sudo -n true >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || refuse "sudo works for $user"
  [ "$rc" -ne 124 ] || refuse "sudo hung for $user: refusal is not proven"
  rc=0
  bounded pfctl -s info >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || refuse "pfctl works for $user"
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

  printf '{"schema":%s,"mode":"workload","ok":true,"time":%s,"boot":{"session":%s,"time":%s},"artifact":%s,"identity":{"user":%s,"uid":%s,"groups":%s},"refused":["sudo","pfctl"],"loopback":{"ipv4":true,"ipv6":true,"api":true},"egress":{"tcp4":"denied","tcp6":"denied","udpDns":"denied"}}\n' \
    "$(jstr "$SCHEMA")" "$(jstr "$now")" "$(jstr "$boot_session")" "$boot_time" "$artifact_json" "$(jstr "$me")" "$uid" "$(jstr "$groups")"
}

if [ "$mode" = 'admin' ]; then verify_admin; exit 0; fi
if [ "$mode" = 'workload' ]; then verify_workload; exit 0; fi

# --- Setup (admin, with sudo) ---
sudo -v
# The workload user's commands get exactly these settings, since sudo resets
# the environment.
soak_env=()
while IFS= read -r v; do soak_env+=("$v=${!v}"); done < <(compgen -v SOAK_)
as_user() { sudo -n -u "$user" -H env "${soak_env[@]}" "$@"; }

echo "== 1/5 workload user $user"
if id "$user" >/dev/null 2>&1; then
  echo "$user exists"
else
  # A random password nobody keeps: the account cannot be logged into, and the
  # admin reaches it only through sudo -u.
  sudo -n sysadminctl -addUser "$user" -fullName "TangleClaw soak workload" -home "/Users/$user" \
    -password "$(openssl rand -hex 32)" >/dev/null 2>&1 || refuse "could not create $user"
  echo "$user created"
fi
for g in admin wheel; do
  if dseditgroup -o checkmember -m "$user" "$g" >/dev/null 2>&1; then
    refuse "$user is a member of $g; the workload must not be an admin (fix it by hand, this script never demotes an account)"
  fi
done
sudo -n -l -U "$user" 2>/dev/null | grep -q 'not allowed to run sudo' || refuse "$user has sudo rights; the workload must have none"
as_user test -r "$here/guest-setup.sh" && as_user test -r "$repo/scripts/soak.js" \
  || refuse "the checkout at $repo is not readable by $user; put it where the workload can read it, such as /Users/Shared"

echo "== 2/5 default-deny network"
sudo -n pfctl "${pf_macros[@]}" -f "$here/pf/soak-deny.conf" -E
admin_json="$(verify_admin)"
echo "$admin_json"
workload_json="$(as_user bash "$here/guest-setup.sh" --verify-workload)" || { echo "$workload_json"; refuse "the workload verifier failed"; }
echo "$workload_json"

echo "== 3/5 stub engine"
sudo -n install -m 0755 "$repo/deploy/soak/stub-engine/soak-stub.js" "$SOAK_BIN_DIR/soak-stub"
as_user mkdir -p "/Users/$user/.tangleclaw/engines"
as_user install -m 0644 "$repo/deploy/soak/stub-engine/soak-stub.json" "/Users/$user/.tangleclaw/engines/soak-stub.json"

echo "== 4/5 synthetic repos"
as_user node "$repo/scripts/soak.js" repos --root "$SOAK_PROJECTS_ROOT" --origins "$SOAK_ORIGINS_ROOT" --projects "$SOAK_PROJECTS" \
  || refuse "soak.js repos failed (see above)"

echo "== 5/5 attach projects"
# With the guest's auth gate down, the dashboard client header is how the
# operator's own tools reach operator routes. With the gate up, attach through
# the dashboard instead.
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

echo "guest ready: workload user $user, default-deny network attested on both planes, stub engine, projects $SOAK_PROJECTS"
