# Host check fixtures

Every fixture here is **synthetic**. None was captured from a live machine, and no Tailscale,
keychain or Caddy state was changed to make one.

| File | Label | What it stands for |
|---|---|---|
| `tailscale/status-*.json` | synthetic 2026-10-14 | `tailscale status --json`: `BackendState`, `Self.DNSName`, `CurrentTailnet.MagicDNSEnabled` ([ipnstate.Status](https://pkg.go.dev/tailscale.com/ipn/ipnstate#Status), [TailnetStatus](https://pkg.go.dev/tailscale.com/ipn/ipnstate#TailnetStatus)). Field names checked against `tailscale` 1.102.3's output, by key only |
| `tailscale/serve-*.json` | synthetic 2026-10-14 | `tailscale serve status --json`: `TCP`, `Web` → `Handlers` → `Proxy` ([ipn.ServeConfig](https://pkg.go.dev/tailscale.com/ipn#ServeConfig)) |
| `caddyfiles/*.caddyfile` | synthetic 2026-10-14 | Caddyfiles in the shapes `lib/caddy.js` generates, plus the `# tangleclaw-topology v1` marker from the A3/A4 r2 design. `/fixture/home` is replaced with a temporary home by the tests |
| `certs.json` | synthetic 2026-10-14 | Certificates only (PEM text), minted with openssl 3.6.2. Their signing keys were discarded. Kept as JSON because `.gitignore` excludes `*.pem` and `*.crt` |
| `spy-preload.js` | test harness | Preloaded into T-H0's real run to record writes, commands, sockets and database opens |

The names (`tailexample.ts.net`, `example.com`), the address `100.64.0.7` and the user
`fixtureuser` are placeholders.
