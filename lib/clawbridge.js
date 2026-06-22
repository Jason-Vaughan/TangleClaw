'use strict';

/**
 * Thin HTTP client for ClawBridge's `/v2/session/*` endpoints.
 *
 * `startSession` (#210 Phase 2) is used by `lib/sessions.js#launchWebuiSession`
 * to pre-create a session with the operator's chosen `permissionMode` BEFORE
 * the OpenClaw chat UI loads in the iframe. The chat UI then attaches to the
 * existing session (via `attachIfExists: true`, ClawBridge v1.7.0) instead of
 * creating its own session that wouldn't carry the mode choice.
 *
 * `send` / `getOutput` / `getStatus` (CC-7 Slice B, ClawBridge v1.7.1's full
 * PTY-broker contract) are the foundation for the transport-aware gateway wrap
 * channel — the gateway analogs of `tmux.sendKeys` / `capturePane` / liveness.
 * `getStatus` also gives TC the accurate remote-session liveness signal that
 * issue #364 needs. `getFile` (CC-7 Slice B1, ClawBridge #18 / v1.9.1) closes
 * the capture-back loop: the remote AI writes its structured wrap block to a
 * `captureFile` on its own filesystem and TC reads the raw bytes back over the
 * bridge — solving both blockers the Slice B spike surfaced (the remote
 * `captureFile` is on a different filesystem AND the PTY output renders `##`
 * away). `lib/wrap-steps/ai-content.js` is the consumer (its webui branch).
 *
 * All calls connect via the SSH-tunneled local port that `launchWebuiSession`
 * already established (`conn.bridgePort` forwarded through the same tunnel as
 * the gateway). No new tunnel required. Every call resolves (never rejects) to
 * a structured result so a bridge failure degrades the caller, never crashes it.
 *
 * Cross-references:
 *   - ClawBridge v1.6.0 — `permissionMode` field added (PR ClawBridge#3)
 *   - ClawBridge v1.7.0 — `attachIfExists` field added (PR ClawBridge#5)
 *   - ClawBridge v1.7.1 — full PTY-broker contract (`send`/`output`/`status`/`transcript`)
 *   - ClawBridge v1.9.1 — `GET /v2/session/file` capture-back endpoint (ClawBridge#18)
 *   - TC #210 Phase 1 (PR #249) — engine-profile scaffold
 *   - TC reference: `~/.claude/projects/.../memory/reference_clawbridge_architecture.md`
 */

const http = require('node:http');
const { createLogger } = require('./logger');

const log = createLogger('clawbridge');

/**
 * POST `/v2/session/start` to the bridge through the SSH tunnel.
 *
 * Behaviour notes:
 *   - `instruction` is intentionally omitted per ClawBridge v1.6.0's
 *     orchestrator pre-create pattern: when omitted, claude spawns as
 *     `claude --session-id <uuid> [--permission-mode <X>]` and enters
 *     interactive mode waiting for input. The chat UI then sends the
 *     first user message via `POST /v2/session/send`.
 *   - `attachIfExists: true` opts into v1.7.0's idempotent behaviour: a
 *     duplicate POST returns 200 + the existing sessionId instead of 409
 *     `SESSION_EXISTS`. Lets TC pre-create without worrying about whether
 *     the OpenClaw chat UI also calls /v2/session/start on attach.
 *   - Errors are non-fatal: callers should treat a failed pre-create as
 *     "fall through with no mode propagation" (the chat UI's own
 *     session/start still works as it did pre-#210). The iframe URL
 *     should always be returned to the user.
 *
 * @param {object} opts
 * @param {number} opts.localPort - The SSH-tunneled port pointing at the bridge.
 * @param {string|null} opts.token - Bridge auth token (`bridgeToken` on the OpenClaw connection record). Sent as `Authorization: Bearer <token>` when truthy.
 * @param {string} opts.project - Project name as the bridge knows it.
 * @param {string} opts.permissionMode - One of `default`, `acceptEdits`, `bypassPermissions`, `auto`, `plan`, `dontAsk`.
 * @param {number} [opts.timeoutMs=5000] - Request timeout.
 * @returns {Promise<{ok: boolean, sessionId: string|null, attached: boolean, status: number, error: string|null}>}
 */
function startSession(opts) {
  return new Promise((resolve) => {
    const { localPort, token, project, permissionMode, timeoutMs = 5000 } = opts;

    const body = JSON.stringify({
      project,
      permissionMode,
      attachIfExists: true
    });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const req = http.request({
      host: '127.0.0.1',
      port: localPort,
      path: '/v2/session/start',
      method: 'POST',
      headers,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* non-JSON response */ }

        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          // ClawBridge v1.7.0 returns the existing sessionId on attach with
          // `attached: true`. v1.6.0 (no attach support) would 409 here
          // and we'd never enter this 2xx branch.
          const sessionId = parsed && (parsed.sessionId || parsed.id) || null;
          const attached = !!(parsed && parsed.attached);
          resolve({ ok: true, sessionId, attached, status, error: null });
          return;
        }

        const message = (parsed && (parsed.error || parsed.message)) || `bridge returned status ${status}`;
        resolve({ ok: false, sessionId: null, attached: false, status, error: message });
      });
    });

    req.on('error', (err) => {
      resolve({ ok: false, sessionId: null, attached: false, status: 0, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, sessionId: null, attached: false, status: 0, error: `bridge request timed out after ${timeoutMs}ms` });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Shared thin HTTP+JSON request to the bridge through the SSH tunnel.
 * Resolves (never rejects) to `{ok2xx, status, parsed, error}` so a bridge
 * failure degrades the caller (e.g. a wrap falls back to mechanical-only),
 * never crashes it — the same resolve-never-reject posture as `startSession`.
 * `startSession` predates this helper and keeps its own bespoke attach-aware
 * response shaping, so it is intentionally NOT refactored onto this.
 *
 * @param {object} opts
 * @param {number} opts.localPort - SSH-tunneled port pointing at the bridge.
 * @param {string|null} opts.token - Bridge auth token (Bearer) when truthy.
 * @param {string} opts.method - HTTP method.
 * @param {string} opts.path - Request path (incl. any query string).
 * @param {object} [opts.body] - JSON request body (omitted for GET).
 * @param {number} [opts.timeoutMs=5000] - Request timeout.
 * @returns {Promise<{ok2xx: boolean, status: number, parsed: object|null, error: string|null}>}
 */
function _requestJson(opts) {
  const { localPort, token, method, path, body, timeoutMs = 5000 } = opts;
  return new Promise((resolve) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;

    const headers = {};
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers.authorization = `Bearer ${token}`;

    const req = http.request({
      host: '127.0.0.1',
      port: localPort,
      path,
      method,
      headers,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* non-JSON response */ }
        const status = res.statusCode || 0;
        resolve({ ok2xx: status >= 200 && status < 300, status, parsed, error: null });
      });
    });

    req.on('error', (err) => {
      resolve({ ok2xx: false, status: 0, parsed: null, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok2xx: false, status: 0, parsed: null, error: `bridge request timed out after ${timeoutMs}ms` });
    });

    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * Build a query string from a params object, URL-encoding keys + values and
 * skipping only `undefined`/`null` (so a legitimate `cursor=0` is kept).
 * @param {Record<string, string|number|undefined|null>} params
 * @returns {string} Query string without the leading `?`
 */
function _queryString(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

/**
 * Resolve the bridge's parsed error message, preferring the network error,
 * then the body's `error`/`message`, then a synthesized status string.
 * @param {{error: string|null, parsed: object|null, status: number}} r
 * @returns {string}
 */
function _bridgeError(r) {
  return r.error || (r.parsed && (r.parsed.error || r.parsed.message)) || `bridge returned status ${r.status}`;
}

/**
 * POST `/v2/session/send` — push an instruction into the running bridge
 * session for `project` (the bridge addresses sessions by project, not by
 * TangleClaw's session id). Does NOT auto-start a session.
 *
 * CC-7 Slice B foundation (the gateway analog of `tmux.sendKeys`); consumed by
 * `lib/wrap-steps/ai-content.js`'s webui branch (CC-7 Slice B1) to push the
 * wrap prompt before reading the captureFile back via `getFile`.
 *
 * @param {object} opts
 * @param {number} opts.localPort - SSH-tunneled bridge port.
 * @param {string|null} opts.token - Bridge auth token (Bearer) when truthy.
 * @param {string} opts.project - Project name as the bridge knows it.
 * @param {string} opts.message - The instruction text to send.
 * @param {number} [opts.timeoutMs=5000] - Request timeout.
 * @returns {Promise<{ok: boolean, accepted: boolean, cursor: number|null, sessionId: string|null, state: string|null, status: number, error: string|null}>}
 *   Bridge errors: 404 no session · 409 not writable (e.g. waiting on a
 *   permission) · 410 session ended — each surfaces as `ok:false` + `error`.
 */
async function send(opts) {
  const { localPort, token, project, message, timeoutMs } = opts;
  const r = await _requestJson({
    localPort, token, method: 'POST', path: '/v2/session/send',
    body: { project, message }, timeoutMs
  });
  const p = r.parsed || {};
  if (r.ok2xx) {
    return {
      ok: true,
      accepted: !!p.accepted,
      cursor: typeof p.cursor === 'number' ? p.cursor : null,
      sessionId: p.sessionId || p.id || null,
      state: p.state || null,
      status: r.status,
      error: null
    };
  }
  return { ok: false, accepted: false, cursor: null, sessionId: null, state: null, status: r.status, error: _bridgeError(r) };
}

/**
 * GET `/v2/session/output` — cursor-based incremental output + structured
 * events for `project`. Append-only event log; poll from the last `cursorEnd`.
 * Supports long-poll via `waitMs` — when set and `timeoutMs` is omitted, the
 * HTTP timeout is auto-extended past `waitMs` so the long-poll isn't cut short.
 *
 * CC-7 Slice B foundation (the gateway analog of `tmux.capturePane`).
 *
 * @param {object} opts
 * @param {number} opts.localPort - SSH-tunneled bridge port.
 * @param {string|null} opts.token - Bridge auth token (Bearer) when truthy.
 * @param {string} opts.project - Project name as the bridge knows it.
 * @param {number} opts.cursor - 0-based event offset to read from.
 * @param {number} [opts.waitMs] - Long-poll max wait (server-side).
 * @param {number} [opts.maxEvents] - Cap on events returned.
 * @param {number} [opts.timeoutMs] - Request timeout (defaults to `waitMs+5000`, else 5000).
 * @returns {Promise<{ok: boolean, events: Array, cursorStart: number|null, cursorEnd: number|null, hasMore: boolean, state: string|null, pendingPermission: object|null, status: number, error: string|null}>}
 */
async function getOutput(opts) {
  const { localPort, token, project, cursor, waitMs, maxEvents, timeoutMs } = opts;
  const effectiveTimeout = timeoutMs != null ? timeoutMs : (waitMs != null ? waitMs + 5000 : 5000);
  const qs = _queryString({ project, cursor, waitMs, maxEvents });
  const r = await _requestJson({
    localPort, token, method: 'GET', path: `/v2/session/output?${qs}`, timeoutMs: effectiveTimeout
  });
  const p = r.parsed || {};
  if (r.ok2xx) {
    return {
      ok: true,
      events: Array.isArray(p.events) ? p.events : [],
      cursorStart: typeof p.cursorStart === 'number' ? p.cursorStart : null,
      cursorEnd: typeof p.cursorEnd === 'number' ? p.cursorEnd : null,
      hasMore: !!p.hasMore,
      state: p.state || null,
      pendingPermission: p.pendingPermission || null,
      status: r.status,
      error: null
    };
  }
  return { ok: false, events: [], cursorStart: null, cursorEnd: null, hasMore: false, state: null, pendingPermission: null, status: r.status, error: _bridgeError(r) };
}

/**
 * GET `/v2/session/status` — current session metadata for `project`. The
 * bridge returns 200 with `active:false` when no session exists (not a 404),
 * so `ok:true, active:false` is the honest "no live session" signal — the
 * accurate remote-liveness check TC issue #364 needs.
 *
 * @param {object} opts
 * @param {number} opts.localPort - SSH-tunneled bridge port.
 * @param {string|null} opts.token - Bridge auth token (Bearer) when truthy.
 * @param {string} opts.project - Project name as the bridge knows it.
 * @param {number} [opts.timeoutMs=5000] - Request timeout.
 * @returns {Promise<{ok: boolean, active: boolean, inputReady: boolean, sessionId: string|null, state: string|null, cursor: number|null, pendingPermissionId: string|null, status: number, error: string|null}>}
 */
async function getStatus(opts) {
  const { localPort, token, project, timeoutMs } = opts;
  const r = await _requestJson({
    localPort, token, method: 'GET',
    path: `/v2/session/status?${_queryString({ project })}`, timeoutMs
  });
  const p = r.parsed || {};
  if (r.ok2xx) {
    return {
      ok: true,
      active: !!p.active,
      inputReady: !!p.inputReady,
      sessionId: p.sessionId || null,
      state: p.state || null,
      cursor: typeof p.cursor === 'number' ? p.cursor : null,
      pendingPermissionId: p.pendingPermissionId || null,
      status: r.status,
      error: null
    };
  }
  return { ok: false, active: false, inputReady: false, sessionId: null, state: null, cursor: null, pendingPermissionId: null, status: r.status, error: _bridgeError(r) };
}

/**
 * GET `/v2/session/file` — read a session-relative file's raw bytes over the
 * bridge (ClawBridge #18, shipped v1.9.1). The bridge resolves `path` against
 * the session cwd (`<projectsDir>/<project>`), so it is the SAME
 * project-relative `captureFile` the local/tmux `ai-content` contract already
 * uses — no path translation needed. The body's `content` is raw UTF-8,
 * unmodified: `## Heading` and newlines survive verbatim, which is exactly why
 * capture-back goes through the file (not the PTY paint stream that mangles
 * markdown + collapses line structure — see CC-7 Slice B1 spike).
 *
 * With `consume:true` the bridge unlinks the file after a successful read
 * (consume-once), mirroring the local path's `removeCaptureFile` so a later
 * wrap can't pick up a stale capture. As-built #18 contract: `consume` is
 * honoured only on the literal string `"true"`; `consumed:true` is returned
 * only when the read AND the unlink both succeeded (content is never lost on
 * an unlink failure). Errors: 400 (missing/invalid param, lexical traversal,
 * symlink-escape, not-a-file) · 404 (project/file not found) · 500 (read
 * throws) — each surfaces as `ok:false` + `error`.
 *
 * This is the capture-BACK half of the gateway wrap channel (CC-7 Slice B1):
 * the AI writes its structured judgment block to `path` as raw markdown, and
 * TC reads it here and parses it with the existing `_parseFields` `## Heading`
 * parser — zero render involved.
 *
 * @param {object} opts
 * @param {number} opts.localPort - SSH-tunneled bridge port.
 * @param {string|null} opts.token - Bridge auth token (Bearer) when truthy.
 * @param {string} opts.project - Project name as the bridge knows it.
 * @param {string} opts.path - Session-relative file path (the step's `captureFile`).
 * @param {boolean} [opts.consume=false] - Unlink the file after a successful read.
 * @param {number} [opts.timeoutMs=5000] - Request timeout.
 * @returns {Promise<{ok: boolean, content: string|null, bytes: number|null, consumed: boolean, path: string|null, status: number, error: string|null}>}
 */
async function getFile(opts) {
  const { localPort, token, project, path: filePath, consume, timeoutMs } = opts;
  // `consume` is sent only as the literal string "true" (the bridge's
  // truthiness check); anything else is omitted so the file is preserved.
  const qs = _queryString({ project, path: filePath, consume: consume ? 'true' : undefined });
  const r = await _requestJson({
    localPort, token, method: 'GET', path: `/v2/session/file?${qs}`, timeoutMs
  });
  const p = r.parsed || {};
  if (r.ok2xx) {
    return {
      ok: true,
      // Preserve an empty-string body literally (typeof check keeps `""` →
      // `""`, which `_parseFields` then treats as "no fields written").
      content: typeof p.content === 'string' ? p.content : null,
      bytes: typeof p.bytes === 'number' ? p.bytes : null,
      consumed: !!p.consumed,
      path: p.path || null,
      status: r.status,
      error: null
    };
  }
  return { ok: false, content: null, bytes: null, consumed: false, path: null, status: r.status, error: _bridgeError(r) };
}

module.exports = { startSession, send, getOutput, getStatus, getFile, _requestJson, _queryString };
