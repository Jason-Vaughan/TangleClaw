---
scope: proxy-forwarded-headers-1532
---

# OpenClaw proxy stops forwarding client-attribution headers (#1532)

**Issue:** #1532

Critic mode: final

## Problem

Under Caddy ingress every request carries `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`. Both
OpenClaw proxy header builders in `server.js` (`_openclawProxyHeaders` for HTTP, `_openclawWsRequestLines` for
the WebSocket handshake) forward them unchanged. OpenClaw 2026.9.4 refuses any request carrying them without a
`gateway.trustedProxies` entry (`403 proxy_attribution_required`), so TiLT Claw's Control UI cannot open. The
dashboard then says "This is a TangleClaw tunnel problem" for a gateway refusal through a healthy tunnel.

## Confidence check

1. **Problem:** the proxy hands the gateway client attribution from a hop the gateway does not trust, and the
   dashboard blames the tunnel for the gateway's answer.
2. **Success:** neither header builder emits `X-Forwarded-*`, `Forwarded` or `X-Real-IP`, whatever the incoming
   request carries (tests on both). Live: TiLT Claw's Control UI opens through TangleClaw. When the proxy passes
   through an upstream refusal that names its reason, the dashboard shows that reason and says the gateway
   refused, not that the tunnel failed.
3. **Out of scope:** #254's device-identity part (a different origin per access path); configuring
   `gateway.trustedProxies` on any gateway; the other proxy families (`/terminal/`, sidecar).

Requirements confidence: High.

## Decisions

- [DECISION: strip, don't rebuild.] TangleClaw is the trust boundary for these requests: it authenticated the
  operator, and the gateway's real peer is the SSH tunnel's loopback end. Rebuilding the headers would assert
  attribution the gateway still has no configured reason to trust, and it would fail the same check. One shared
  predicate names the header set, and both builders use it, so HTTP and WS cannot drift apart (#470 is the
  precedent for that mirroring).
- [DECISION: the header set is `forwarded`, `x-real-ip` and every `x-forwarded-*`], matched case-insensitively.
  A prefix rule rather than a list, so a proxy adding `X-Forwarded-Port` or `X-Forwarded-Prefix` is covered too.
- [DECISION: the dashboard tells a gateway refusal from a tunnel failure by the body's shape.] OpenClaw answers
  `{"error":{"message","type"}}`; TangleClaw's own errors are `{"error":"<string>","code"}`. A non-5xx status whose
  JSON body carries `error.message` is the gateway talking through a working tunnel. Everything else keeps
  today's tunnel wording. `probeProxy` stays non-throwing, and an unreadable body falls back to today's reason.
- Engine-agnostic: OpenClaw-specific proxy code only; no engine capability involved.

## Chunk 01 — strip attribution headers, name the gateway's refusal

Files: `server.js`, `public/openclaw-tunnel-state.js`, `public/openclaw-view.js`, `test/server.test.js`,
`test/openclaw-tunnel-state.test.js`, `CHANGELOG.md`, `.prawduct/change-log.md`.

Done when:
- HTTP and WS builders drop every attribution header, in any letter case, and still apply the existing host,
  origin, referer, cookie and authorization rules (tests).
- `probeProxy` returns the gateway's reason and marks the refusal as the gateway's for an upstream JSON error;
  `describeTunnelFailure` has a gateway-refusal wording that does not blame the tunnel; the view uses it (tests,
  including the source wiring check).
- Suite green; Critic final with zero blocking.
- Live after merge and restart: TiLT Claw's Control UI loads through TangleClaw.

## Status

- [x] Chunk 01 — strip attribution headers, name the gateway's refusal
