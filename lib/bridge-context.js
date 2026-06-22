'use strict';

/**
 * Resolve the ClawBridge sidecar connection for a webui/OpenClaw session.
 *
 * Shared by the two gateway consumers — `lib/wrap-steps/ai-content.js` (CC-7
 * B1 capture-back) and `lib/wrap-sentinel.js` (CC-7 Slice C typed-wrap monitor)
 * — so the `openclaw:<connId>` engine-id format and the sidecar contract
 * (`bridgePort`/`bridgeToken`) live in ONE place and can't drift between them.
 * Lazily requires the store so importing this never pulls the store into a
 * module's load graph.
 *
 * The bridge addresses sessions by project NAME (the same name
 * `launchWebuiSession` passes to `clawbridge.startSession`), so callers pass
 * the project name string, not the project record.
 *
 * @param {object} session - Live session record (carries `engineId`)
 * @param {string} projectName - The bridge's session key
 * @returns {{localPort: number, token: string|null, project: string}|null}
 *   Call essentials for the `clawbridge.*` methods, or `null` when the session
 *   isn't bridge-backed (not an openclaw engine, unknown connection, or no
 *   `bridgePort` sidecar).
 */
function resolveBridgeContext(session, projectName) {
  const engineId = session && session.engineId;
  if (!engineId || !engineId.startsWith('openclaw:')) return null;
  const connId = engineId.slice('openclaw:'.length);
  const conn = require('./store').openclawConnections.get(connId);
  if (!conn || !conn.bridgePort) return null;
  return { localPort: conn.bridgePort, token: conn.bridgeToken || null, project: projectName };
}

module.exports = { resolveBridgeContext };
