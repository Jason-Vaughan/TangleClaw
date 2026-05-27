'use strict';

/**
 * Thin HTTP client for ClawBridge's `POST /v2/session/start` endpoint.
 *
 * Used by `lib/sessions.js#launchWebuiSession` to pre-create a session with
 * the operator's chosen `permissionMode` BEFORE the OpenClaw chat UI loads
 * in the iframe. The chat UI then attaches to the existing session (via
 * `attachIfExists: true`, shipped in ClawBridge v1.7.0) instead of
 * creating its own session that wouldn't carry the mode choice.
 *
 * Connects via the SSH-tunneled local port that `launchWebuiSession`
 * already established (`conn.bridgePort` forwarded through the same
 * tunnel as the gateway). No new tunnel required.
 *
 * Cross-references:
 *   - ClawBridge v1.6.0 — `permissionMode` field added (PR ClawBridge#3)
 *   - ClawBridge v1.7.0 — `attachIfExists` field added (PR ClawBridge#5)
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

module.exports = { startSession };
