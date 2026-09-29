#!/usr/bin/env bash
# Prepare the inside of the soak guest (#2020). Run it in the guest, from a
# TangleClaw checkout of the pinned release candidate, after that TangleClaw
# is running on loopback at SOAK_TC_PORT.
#
# It refuses to run anywhere but a macOS VM with no live TangleClaw pane. Then,
# in order, stopping at the first failure:
#   1. load the default-deny pf profile and prove it holds: pf is enabled with
#      exactly this ruleset, loopback (IPv4, IPv6 and the guest API) still
#      works, and outside addresses are unreachable over TCP on IPv4 and IPv6
#      and over UDP DNS, all by literal address so no step depends on DNS;
#   2. install the stub engine on PATH and its profile in ~/.tangleclaw/engines;
#   3. create the synthetic repos and their local bare origins (soak.js repos);
#   4. attach each repo as a project through the guest TangleClaw's own API.
#
# Every step is safe to repeat. Needs sudo for pf and for SOAK_BIN_DIR.
#
# Exit codes: 0 done, 3 refused, any other non-zero: the failing step's own code.
set -euo pipefail

refuse() { echo "refused: $*" >&2; exit 3; }

# A pane launched by a live TangleClaw exports TANGLECLAW_API. This script
# rewrites the firewall and registers projects, so it never runs there.
[ -z "${TANGLECLAW_API:-}" ] || refuse "TANGLECLAW_API is set: this is a live TangleClaw pane, not the soak guest"
[ "$(uname -s)" = "Darwin" ] || refuse "the soak guest is macOS; this is $(uname -s)"
[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null || echo 0)" = "1" ] || refuse "not a virtual machine (kern.hv_vmm_present != 1); guest-setup.sh runs only inside the soak guest"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
# shellcheck source=guest.conf
. "$here/guest.conf"

echo "== 1/4 default-deny network"
api="http://127.0.0.1:$SOAK_TC_PORT"
sudo pfctl -D "host_addr=$SOAK_HOST_ADDR" -f "$here/pf/soak-deny.conf" -E

# The ruleset pf reports, not the file, is what is in force. Anything other
# than exactly the profile, in pfctl's normalized form, is refused.
sudo pfctl -s info 2>/dev/null | grep -q '^Status: Enabled' || refuse "pf is not enabled after loading the profile"
rules="$(sudo pfctl -s rules 2>/dev/null | sed '/^[[:space:]]*$/d')"
expected="block drop all
pass in quick inet proto tcp from $SOAK_HOST_ADDR to any port = 22 flags S/SA keep state"
[ "$rules" = "$expected" ] || refuse "pf's loaded rules are not exactly the soak profile:
$rules"
sudo pfctl -s Interfaces -v 2>/dev/null | grep -Eq '^lo0 .*\(skip\)' || refuse "pf is not skipping lo0"

# Loopback must still work, or the soak would fail for the wrong reason.
ping -c 1 -t 2 127.0.0.1 >/dev/null 2>&1 || refuse "IPv4 loopback is unreachable with pf loaded"
ping6 -c 1 ::1 >/dev/null 2>&1 || refuse "IPv6 loopback is unreachable with pf loaded"
curl -fsS --max-time 10 "$api/api/health" >/dev/null || refuse "no TangleClaw answering at $api; start the pinned release candidate first"

# Nothing outside may answer. Each probe uses a literal address.
command -v dig >/dev/null 2>&1 || refuse "dig is missing, so DNS egress cannot be checked"
if nc -z -G 3 "$SOAK_EGRESS_PROBE_ADDR" 443 >/dev/null 2>&1; then
  refuse "reached $SOAK_EGRESS_PROBE_ADDR:443 over IPv4 with pf loaded: the guest is not isolated"
fi
if nc -6 -z -G 3 "$SOAK_EGRESS_PROBE_ADDR6" 443 >/dev/null 2>&1; then
  refuse "reached [$SOAK_EGRESS_PROBE_ADDR6]:443 over IPv6 with pf loaded: the guest is not isolated"
fi
if dig "@$SOAK_DNS_PROBE_ADDR" +time=2 +tries=1 +short tangleclaw.invalid >/dev/null 2>&1; then
  refuse "a DNS query to $SOAK_DNS_PROBE_ADDR got an answer with pf loaded: the guest is not isolated"
fi
echo "pf enabled with the soak profile; loopback works; no egress over TCP (IPv4, IPv6) or UDP DNS"

echo "== 2/4 stub engine"
sudo install -m 0755 "$repo/deploy/soak/stub-engine/soak-stub.js" "$SOAK_BIN_DIR/soak-stub"
mkdir -p "$HOME/.tangleclaw/engines"
install -m 0644 "$repo/deploy/soak/stub-engine/soak-stub.json" "$HOME/.tangleclaw/engines/soak-stub.json"

echo "== 3/4 synthetic repos"
node "$repo/scripts/soak.js" repos --root "$SOAK_PROJECTS_ROOT" --origins "$SOAK_ORIGINS_ROOT" --projects "$SOAK_PROJECTS" \
  || refuse "soak.js repos failed (see above)"

echo "== 4/4 attach projects"
# With the guest's auth gate down, the dashboard client header is how the
# operator's own tools reach operator routes. With the gate up, attach through
# the dashboard instead.
IFS=',' read -r -a projects <<< "$SOAK_PROJECTS"
for name in "${projects[@]}"; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$api/api/projects/$name")"
  if [ "$status" = "200" ]; then echo "$name: already attached"; continue; fi
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
    -H 'content-type: application/json' -H 'x-tangleclaw-client: dashboard' \
    -d "{\"name\":\"$name\"}" "$api/api/projects/attach")"
  case "$status" in
    201|200) echo "$name: attached" ;;
    409) echo "$name: already attached" ;;
    401|403) refuse "attach $name answered $status: the guest's auth gate is up; attach the soak-* projects from the dashboard" ;;
    *) refuse "attach $name answered $status (is the guest's projectsDir $SOAK_PROJECTS_ROOT?)" ;;
  esac
done

echo "guest ready: default-deny network, stub engine, and projects $SOAK_PROJECTS"
