---
scope: control-ui-base-path-1534
---

# OpenClaw 2026.9 Control UI starts through the TangleClaw proxy (#1534)

**Issue:** #1534

Critic mode: final

## Problem

OpenClaw 2026.9.4 serves its Control UI index with root-absolute references (`src="/assets/index-….js"`, 8
modulepreloads, favicon, manifest) and `data-openclaw-control-ui-base-path=""`. Loaded at
`/openclaw-direct/<connId>/`, the browser asks TangleClaw's root for `/assets/…`, gets 404, and the UI hits its
12 s mount timeout. Builds up to 2026.6.11 used relative `./assets/…` and work.

## Confidence check

1. **Problem:** a 2026.9+ gateway's Control UI never starts through either OpenClaw proxy prefix.
2. **Success:** for an HTML response from a gateway, the proxy rewrites root-absolute `src`/`href` to sit under the
   request's proxy prefix and fills an empty or absent `data-openclaw-control-ui-base-path` with that prefix.
   Live: TiLT Claw's Control UI loads and connects through TangleClaw, and RentalClaw still does.
3. **Out of scope:** URLs inside inline scripts (the captured page has none), the manifest's own contents,
   non-HTML responses, and the WebSocket path (the bundle builds it from the base path).

Requirements confidence: Medium. The claim that the bundle derives its config and WebSocket URLs from the base
path is inferred from minified code; the live check settles it.

## Decisions

- [DECISION: rewrite in TangleClaw, in a pure module `lib/openclaw-html.js`], not on each gateway. Setting
  `gateway.controlUi.basePath` would tie OpenClaw's config to a TangleClaw connection id, and routing root
  `/assets/*` by Referer collides with TangleClaw's own paths.
- [DECISION: only root-absolute `src=`/`href=` attributes are rewritten] (`"/x"`, not `"//host"`, not
  `"https://…"`, not relative), in double or single quotes. The base-path attribute is set only when empty or
  absent, so a gateway that declares its own base path keeps it.
- [DECISION: HTML is buffered and decoded before rewriting.] The gateway sends `Content-Encoding: br`. The body
  is decoded (br, gzip, deflate, identity) and re-sent uncompressed, with `Content-Length` recomputed and
  `Content-Encoding` and `ETag` removed, since the bytes changed. An unknown encoding, or a decode failure,
  passes the original bytes through untouched rather than breaking the page. The buffer is capped (2 MB); past
  that, the response streams through unmodified.
- [ASSUMPTION: every OpenClaw HTML page served through the proxy is fine to rewrite this way.] Only
  root-absolute references change, and those can never have worked through the prefix.
- Engine-agnostic: OpenClaw proxy code only.

## Chunk 01 — rewrite gateway HTML under the proxy prefix

Files: `lib/openclaw-html.js`, `server.js`, `test/openclaw-html.test.js`,
`test/fixtures/openclaw-control-ui-2026.9.4.html`, `test/fixtures/openclaw-control-ui-2026.6.11.html`,
`CHANGELOG.md`, `FEATURES.md`, `docs/openclaw-setup.md`, `.prawduct/change-log.md`.

Done when:
- Pure rewrite: the 2026.9.4 fixture has every root-absolute reference prefixed and the base path set; the
  2026.6.11 fixture is byte-identical; protocol-relative, absolute and relative URLs are untouched; a declared
  base path is kept; the prefix is escaped for an attribute value.
- Response handling: br, gzip, deflate and identity bodies are rewritten, with headers corrected; an unknown
  encoding, a corrupt body or a non-HTML response passes through; an oversized body streams unmodified.
- Both proxy prefixes (`/openclaw-direct/<connId>/` and `/openclaw/<project>/`) use it.
- Suite green; Critic final with zero blocking.
- Live after merge and restart: TiLT Claw's Control UI loads and connects; RentalClaw still does.

## Status

- [ ] Chunk 01 — rewrite gateway HTML under the proxy prefix
