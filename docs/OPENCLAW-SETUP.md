# OpenClaw Connection Setup Guide

This guide walks through connecting an OpenClaw instance to TangleClaw. It covers the full setup: SSH tunnel, HTTPS, gateway authentication, device pairing, and the Web UI viewer.

## Prerequisites

- TangleClaw v3.10.0+ running on a host machine (the "TangleClaw host")
- An OpenClaw gateway running on a remote machine (the "OpenClaw host"), typically in Docker
- SSH access from the TangleClaw host to the OpenClaw host (key-based, no password prompt)
- The OpenClaw gateway token (found in the gateway config)

## Architecture Overview

```
Browser (any machine)
    |
    | HTTPS
    v
TangleClaw (cursatory / your server)
    |
    | SSH tunnel (auto-managed)
    v
OpenClaw Gateway (remote host, Docker)
```

TangleClaw acts as a reverse proxy. The browser never connects directly to the OpenClaw gateway. All traffic flows through TangleClaw via an SSH tunnel.

## Step 1: Enable HTTPS on TangleClaw

The OpenClaw Control UI requires a **secure context** (HTTPS or localhost) for device identity. If you access TangleClaw from a remote browser (not localhost), HTTPS is required.

### Install mkcert

```bash
brew install mkcert    # macOS
mkcert -install        # requires sudo — installs local CA
```

### Generate certificates

```bash
mkdir -p data/certs && cd data/certs
mkcert <hostname>.local localhost 127.0.0.1 <lan-ip>
```

Replace `<hostname>` with your TangleClaw host's hostname and `<lan-ip>` with its LAN IP address. Include every hostname/IP that browsers will use to access TangleClaw.

### Configure TangleClaw

```bash
curl -X PATCH http://localhost:3102/api/config \
  -H 'Content-Type: application/json' \
  -d '{
    "httpsEnabled": true,
    "httpsCertPath": "/full/path/to/data/certs/<certfile>.pem",
    "httpsKeyPath": "/full/path/to/data/certs/<keyfile>-key.pem"
  }'
```

Restart TangleClaw. Verify with:

```bash
curl -sk https://localhost:3102/api/version
```

### Remote browser trust (optional)

Browsers on other machines will show a certificate warning. To avoid this, copy the mkcert root CA to the remote machine and add it to the trust store:

```bash
# On the TangleClaw host — find the CA cert:
mkcert -CAROOT
# Copy rootCA.pem to the remote machine and install it
```

## Step 2: Get the Gateway Token

The OpenClaw gateway requires a bearer token for authentication. Find it in the gateway config on the OpenClaw host.

### If OpenClaw runs in Docker:

```bash
# SSH to the OpenClaw host
ssh <user>@<openclaw-host>

# Find the container name
docker ps --format '{{.Names}}'
# e.g., openclaw-openclaw-gateway-1

# Read the config
docker exec <container> cat /home/node/.openclaw/openclaw.json
```

Look for `gateway.auth.token` in the JSON output. Copy the token value.

### If OpenClaw runs natively:

```bash
cat ~/.openclaw/openclaw.json
```

Same path: `gateway.auth.token`.

## Step 3: Register the Connection in TangleClaw

1. Open TangleClaw in your browser
2. Click the **"OpenClaw"** pill in the top navigation bar
3. Click **"+ Add Connection"**
4. Fill in the form:

| Field | Value | Notes |
|---|---|---|
| **Name** | Display name (e.g., "MyOpenClaw") | Must be unique |
| **Host** | OpenClaw host IP or hostname | e.g., `192.168.20.10` |
| **SSH User** | SSH login user | e.g., `habitat-admin` |
| **SSH Key Path** | Path to SSH private key on TangleClaw host | e.g., `~/.ssh/id_rsa` |
| **Gateway Port** | OpenClaw gateway port (default `18789`) | Remote port |
| **Gateway Token** | The token from Step 2 | Required for remote access |
| **Local Port** | Local tunnel port (default `18789`) | Must not conflict with other tunnels |
| **Bridge Port** | ClawBridge port (default `3201`) | For sidecar process visibility |
| **Bridge Token** | ClawBridge authentication token | Required for sidecar polling |
| **Available as Engine** | Toggle on if you want to use it as a project engine | Optional |

5. Click **"Test Connection"** to verify SSH and gateway connectivity
6. Click **"Create"**

### Via API:

```bash
curl -sk -X POST https://localhost:3102/api/openclaw/connections \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "MyOpenClaw",
    "host": "192.168.20.10",
    "sshUser": "habitat-admin",
    "sshKeyPath": "~/.ssh/id_rsa",
    "gatewayToken": "<your-token-here>"
  }'
```

## Step 4: Open the Web UI

1. Expand the connection in the OpenClaw panel
2. Click the **"Web UI"** button
3. A new tab opens with TangleClaw's header and the OpenClaw Control UI in an iframe

### What happens behind the scenes:

1. TangleClaw starts an SSH tunnel from `localhost:<localPort>` to `<host>:<gatewayPort>`
2. The viewer page loads the Control UI through the reverse proxy at `/openclaw-direct/:connId/*`
3. The proxy injects the gateway token as a `Bearer` header on every request
4. The proxy rewrites `Origin` and `Referer` headers so the gateway accepts the requests
5. The proxy strips `X-Frame-Options` and `frame-ancestors` CSP headers so the iframe works

### First-time device pairing

The OpenClaw Control UI requires device pairing on first use from a new browser. TangleClaw handles this automatically:

1. The Control UI submits a pairing request to the gateway
2. TangleClaw's viewer page polls `POST /api/openclaw/connections/:id/approve-pending` every 3 seconds
3. TangleClaw detects the pending request and auto-approves it via SSH + docker exec
4. The iframe reloads and the Control UI connects

**No manual CLI intervention needed.** The auto-approve runs entirely server-side on the TangleClaw host using the SSH key and gateway token.

## Step 5: Use as a Project Engine (optional)

If you toggled "Available as Engine" when creating the connection:

1. Create or edit a project in TangleClaw
2. In the engine dropdown, select your connection under the **"OpenClaw"** group
3. Choose a mode:
   - **SSH** — tmux-based terminal session on the remote machine
   - **Web UI** — iframe-based OpenClaw Control UI (same as the standalone viewer)
4. Launch a session

## Sidecar: Background Process Visibility

When an OpenClaw connection has a **Bridge Port** and **Bridge Token** configured, TangleClaw polls the ClawBridge for background process status. This is displayed as **sidecar pills** in the OpenClaw viewer.

### What it shows

- **Running processes** — active Claude Code sessions, build chunks, background tasks
- **Completed processes** — recently finished with exit code and duration
- **Stalled/waiting processes** — processes that appear stuck or are waiting for input

### How it works

1. TangleClaw's SSH tunnel forwards both the gateway port (18789) and the bridge port (3201)
2. The sidecar polls `GET /api/processes` on the ClawBridge every 10 seconds
3. Status pills appear in the OpenClaw viewer banner — colored by status (running, completed, errored)
4. Click a pill to open the detail panel with timestamps, exit code, working directory, and last output

### Requirements

- ClawBridge must be running on the OpenClaw host (typically port 3201)
- The `BRIDGE_TOKEN` environment variable must be set on the ClawBridge
- The connection's Bridge Token must match the ClawBridge's `BRIDGE_TOKEN`

## Troubleshooting

### "Connection lost" or tunnel failures

- Verify SSH connectivity: `ssh -i <key> <user>@<host> "echo ok"`
- Check that the SSH key has no passphrase (TangleClaw uses `BatchMode=yes`)
- Ensure the gateway port (default 18789) is accessible on the OpenClaw host

### "Origin not allowed"

- The proxy rewrites Origin headers automatically. If you see this, the proxy may not be running the latest code. Restart TangleClaw.

### "Device identity requires secure context"

- You're accessing TangleClaw over HTTP from a non-localhost browser. Enable HTTPS (Step 1).

### "Pairing required" (manual fallback)

If auto-approve fails, you can approve manually:

```bash
# SSH to the OpenClaw host
ssh <user>@<openclaw-host>

# Approve the latest pending request
docker exec <container> openclaw devices approve --latest --token <gateway-token>
```

### "Gateway token missing"

- Edit the connection in TangleClaw and add the gateway token (Step 2).

### Blank iframe / black page

- Check that TangleClaw is stripping `X-Frame-Options` headers. Run:
  ```bash
  curl -sk -I https://localhost:3102/openclaw-direct/<connId>/chat
  ```
  There should be no `x-frame-options` header in the response.

### Certificate warnings on remote browsers

- Install the mkcert root CA on the remote machine (see Step 1).
- Or click through the browser warning — functionality is not affected.

### Port conflicts

- Each OpenClaw connection needs a unique `localPort`. If you have multiple connections, assign different local ports (e.g., 18789, 18790, etc.).
- Register ports through TangleClaw's port management to avoid conflicts.

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/openclaw/connections` | GET | List all connections |
| `/api/openclaw/connections` | POST | Create a connection |
| `/api/openclaw/connections/:id` | GET | Get connection details |
| `/api/openclaw/connections/:id` | PUT | Update a connection |
| `/api/openclaw/connections/:id` | DELETE | Delete a connection |
| `/api/openclaw/connections/:id/tunnel` | POST | Start SSH tunnel |
| `/api/openclaw/connections/:id/approve-pending` | POST | Auto-approve device pairing |
| `/api/openclaw/test` | POST | Test SSH + gateway connectivity |
| `/openclaw-direct/:connId/*` | * | Reverse proxy to gateway (standalone) |
| `/openclaw/:project/*` | * | Reverse proxy to gateway (project-based) |
| `/openclaw-view/:connId` | GET | Viewer page with TangleClaw header + iframe |
