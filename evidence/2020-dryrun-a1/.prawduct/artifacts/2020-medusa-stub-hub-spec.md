# #2020 Chunk 3: Medusa stub hub spec

Research on 2026-09-30, read-only, against candidate aebd6960. Implement from this. Citations are to the TangleClaw tree.

## Contract TangleClaw needs from a hub

- **No auth.** A2A_SECRET is never read in lib/medusa*.js.
- **HTTP base** is `MEDUSA_BRIDGE_HTTP_URL`, default `http://localhost:3009` (lib/medusa.js:94-97), read once at server start. **The WebSocket** is the same host on port+1, default `ws://localhost:3010` (medusa.js:258-284); `MEDUSA_BRIDGE_WS_URL` overrides it. Both must be loopback, or TangleClaw falls back to the default (:179-183, :271).
- `localhost` may resolve to `::1`, so either bind both 127.0.0.1 and ::1, or point TangleClaw at 127.0.0.1 explicitly.

### HTTP routes

| Route | Response | Notes |
|---|---|---|
| `POST /messages/direct` `{to, from, message}` | `200 {success:true, status:"received", id}` | `id` must match `/^[A-Za-z0-9._:-]{1,128}$/` (medusa-exchanges.js:87); use randomUUID. Unknown `to`: `404 {success:false, error:"Workspace <to> not found"}` (TangleClaw re-resolves and retries once, :828-876). |
| `GET /workspaces` | `{workspaces:[{id,name}]}` | Only used on that retry. |
| `GET /health` | `{status:"hissing", version:"stub"}` | Health is read from the `status` field. |
| `GET /loops/:id` | omit | The soak never sends a loopId. |

### WebSocket (the client is Node 22's global WebSocket)

It sends no subprotocol and no auth, and offers permessage-deflate, which the hub must NOT accept.

- **register:** the client sends `{"type":"register","workspaceId":...}` (medusa-listener.js:623). The hub replies `{"type":"registered","workspaceId":...}` within 10s (:67, :824-853); the listener then reports `listening` (:675-683). Map workspaceId to the socket, replace any earlier socket with the same id, and remove the entry on close.
- **heartbeat:** `{"type":"listener_heartbeat","status":"active"}` every 20s. Optionally reply `{"type":"heartbeat_ack"}`; it is ignored.
- **push:** `{"type":"new_message","messageId":ID,"message":{id:ID,type:"direct",from,to,message,timestamp}}`. The SAME ID goes in the POST response, `messageId` and `message.id`. It must be unique: the listener drops a repeated messageId (:712-720).
- **ack:** `{"type":"ack","messageIds":[...]}` (:504). Reply `{"type":"ack_response","success":true,"messageIds":[...]}`.
- **error frames:** do NOT send `type:"error"`; it flags the listener.
- **Reconnect** backoff is 1s×2^n, capped at 30s (:863-878).

### What the soak's medusa-cycle checks (lib/soak/executors.js:374-431)

1. Both sessions `listening` within 60s.
2. `POST /medusa/send` returns a non-empty `body.id`.
3. B's `GET /medusa/messages` contains an entry with `m.id === id` within 60s. The inbox holds the inner `message` bodies (medusa-listener.js:288).
4. `POST /medusa/read {ids:[id]}` returns 200.

### RFC 6455 server (Node 22 has no WebSocket server; http.WebSocketServer is undefined)

- **Handshake:** on the `upgrade` event, compute `Sec-WebSocket-Accept` = base64(sha1(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')) and send the 101 response with no extensions.
- **Reading:** buffer partial chunks. Payload length is 7-bit, or 126 followed by 16 bits, or 127 followed by 64 bits. Client frames are always masked. Reject continuation frames.
- **Opcodes:** 0x1 text is JSON. 0x8 close: echo it, then end. 0x9 ping: reply 0xA pong. Ignore 0xA.
- **Sending:** unmasked frames, `0x81` plus the length in the same 7/16/64-bit form. Message bodies go up to 64 KiB, so the 16-bit form is needed.

### Scope

- **Required:** upgrade, register→registered, the id→socket map, POST /messages/direct (push, then 200 or 404), close and ping.
- **Cheap extras:** /health, /workspaces, heartbeat_ack, ack_response, and a per-workspace queue drained after register (`status:"queued"`).
- **Omit:** loops, broadcast, persistence, auth, name resolution, HTTP ack and the workspace-message routes.

## Placement decisions still open for the build

- **Where it lives:** deploy/soak/medusa-stub/ (a script plus tests in test/soak-medusa-stub.test.js).
- **How it runs:** guest-setup starts it as soakrun, bound to loopback, and the ports are leased in the guest's own TangleClaw PortHub. Either use a LaunchAgent in soakrun's GUI domain, so it restarts on crash and survives the server restart fault, or nohup.
- **Server env:** the TangleClaw server's launchd env needs MEDUSA_BRIDGE_HTTP_URL=http://127.0.0.1:3009, or the stub binds both loopbacks. Check how deploy/install.sh writes the server plist env. Prefer that the stub binds both loopbacks, so the candidate's install stays unchanged.
