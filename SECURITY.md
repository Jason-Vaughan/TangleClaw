# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in TangleClaw, please report it responsibly:

**Email:** Open a private issue on GitHub or contact the maintainer directly.

Do **not** open a public issue for security vulnerabilities.

## What's in Scope

- Authentication and authorization bypass
- Command injection via API endpoints
- Path traversal in file upload or config handling
- Cross-site scripting (XSS) in the web UI
- SSH tunnel or proxy misconfiguration that leaks data
- Token or credential exposure

## Security Model

TangleClaw is designed to run on a **trusted local network** — it is not an internet-facing service. The security model reflects this:

### No User Authentication

TangleClaw does not authenticate users. Anyone who can reach the server port can view projects and open terminal sessions. This is by design for local/VPN use. The `deletePassword` config option protects destructive operations (project deletion, session kill/wrap) but does not gate read access.

**Recommendation:** Run on a private network or behind a VPN (Tailscale, WireGuard). Do not expose to the public internet.

### HTTPS Support

TangleClaw supports TLS via `httpsEnabled`, `httpsCertPath`, and `httpsKeyPath` in config. HTTPS is required for OpenClaw Web UI device pairing from non-localhost browsers (secure context requirement).

### Password Storage

The `deletePassword` is hashed with scrypt before storage. Plaintext passwords from older versions are auto-upgraded on first verification.

### Gateway and Bridge Tokens

OpenClaw gateway tokens and ClawBridge tokens are stored in the SQLite database as plaintext. These tokens authenticate TangleClaw to remote services, not users to TangleClaw. Treat the database file (`~/.tangleclaw/tangleclaw.db`) as sensitive.

### SSH Key References

TangleClaw stores SSH key file paths (not key contents) in the database for OpenClaw connections. The keys themselves remain on disk and are used by the SSH tunnel manager.

### File Uploads

Uploads are restricted by:
- File extension allowlist (images, docs, configs only)
- 15 MB size limit
- Timestamped filenames (no path traversal)

### Eval Audit Mode

When enabled, `ANTHROPIC_API_KEY` must be set as an environment variable. This key is used for Tier 2/3 judge scoring calls and is never stored in the database or logged.

## Supported Versions

Security fixes are applied to the latest release only.
