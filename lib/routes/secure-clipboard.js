'use strict';

/**
 * The `/api/sessions/:project/secure-clipboard*` route family (#1032):
 * cross-machine secure clipboard sync and file/secret uploader.
 *
 * This is an OPERATOR action from the dashboard — the person's own browser,
 * on the device holding the secret, sending it into a project's session
 * workspace or pane — never a project-session API client, so every route
 * here is gated through `./_callers`'s `_requireOperatorWrite` (PRR-B R-Gate
 * finding 1, round 1: `_requireOperatorRead` has NO success branch for the
 * `open` gate state at all — correct for the fleet-wide reads it was written
 * for, but it would make this project-scoped metadata read permanently
 * unusable on a no-login install, the same install this feature's own write
 * side must work on. Reusing `_requireOperatorWrite`'s proof for the GET too
 * is a direct, scoped fix rather than adding a new always-refuses-on-open
 * helper to `lib/routes/_callers.js`, which is both outside this car's file
 * envelope and a fix to a shared primitive many other routes rely on as-is).
 * `register()` takes no `deps`, the same no-deps convention
 * `lib/routes/engine-health-routes.js`/`engines-canary.js` use.
 *
 * `POST`/`DELETE` both match the gate-relevant `/api/sessions/:project(/|$)`
 * family `test/api-coordinator-rotation.test.js` sweeps, so both declare
 * `gatedAction: 'session-command'` and call `coordinatorGateRefused` first —
 * the same bucket `lib/routes/sessions.js`'s `/command` route and
 * `lib/routes/engine-health-routes.js`'s `/engine-health/suppress` route use
 * for "ordinary work typed/written into a project's own session".
 *
 * Mode `'paste'` (PRR-B R-Gate finding 2, round 1): the raw secret is NEVER
 * injected into the pane. It is written through `lib/secure-clipboard.js`
 * the same as mode `'file'`, and only a content-free POINTER (a sentence
 * naming the saved path and byte count — no secret bytes in it) is
 * injected via `lib/sessions.js#injectCommand` (reused whole — project/session
 * resolution, control-gate, startup-dialog and wrap checks, the
 * `tmux.sendKeys` call itself — the same reuse
 * `lib/routes/engine-health-routes.js` makes of `sessions.js`'s kill/launch),
 * `enter: false` always. The original design injected the secret text
 * itself with no Enter, reasoning that an unsent composer line was safe;
 * it was not — whatever sits at a tmux pane's prompt is, for a Claude Code
 * (or similar) session, the engine's own chat composer, and a LATER Enter
 * (the operator's, or the agent's) submits it as a permanent chat-history
 * entry, exactly what #1032 says never to do. Writing the file first and
 * pointing at it instead means an accidental Enter sends a harmless
 * filename reference, never the value.
 *
 * @module lib/routes/secure-clipboard
 */

const store = require('../store');
const sessions = require('../sessions');
const secureClipboard = require('../secure-clipboard');
const { createLogger } = require('../logger');
const { route, jsonResponse, errorResponse } = require('./_kernel');
const { _requireOperatorWrite, coordinatorGateRefused } = require('./_callers');

const log = createLogger('secure-clipboard-routes');

// A base64-encoded file/secret inflates by ~4/3; this bounds the REQUEST body,
// well above `lib/secure-clipboard.js#MAX_FILE_BYTES`'s own decoded-size cap
// so that cap, not this one, is what a legitimately-sized upload ever hits.
const MAX_BODY_SIZE = 8 * 1024 * 1024; // 8 MB

/**
 * Map `sessions.injectCommand`'s result to an HTTP response, mirroring
 * `lib/routes/sessions.js`'s `/command` route's own mapping exactly so the
 * two surfaces answer the same failure the same way.
 * @param {object} res - The response.
 * @param {{ok: boolean, error: (string|null), controlRefusal?: object, startupDialog?: object, wrapRunning?: object}} result
 * @returns {void}
 */
function _respondToInjectResult(res, result) {
  if (!result.ok && result.controlRefusal) {
    const r = result.controlRefusal;
    return errorResponse(res, r.status, r.message, r.code, r.details);
  }
  if (!result.ok && result.startupDialog) {
    return errorResponse(res, 409, result.error, 'STARTUP_DIALOG', { startupDialog: result.startupDialog });
  }
  if (!result.ok && result.wrapRunning) {
    return errorResponse(res, 409, result.error, 'WRAP_RUNNING', { wrapRunning: result.wrapRunning });
  }
  if (!result.ok) {
    if (result.error.includes('not found') || result.error.includes('No active')) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
  }
  return null; // ok — caller sends its own 200 body
}

/**
 * Register this family's routes.
 * @returns {void}
 */
function register() {
  // POST /api/sessions/:project/secure-clipboard — send a secret.
  // Body: { text: string, mode: 'file'|'paste', filename?: string, encoding?: 'utf8'|'base64' }
  route('POST', '/api/sessions/:project/secure-clipboard', (req, res, params, body) => {
    const project = store.projects.getByName(params.project);
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;

    const proof = _requireOperatorWrite(req, res, {
      logEvent: 'Refused a secure clipboard send',
      logContext: { project: params.project },
      fallbackAction: 'send a secret into a project session',
      sameOriginWhat: 'A secure clipboard send',
      unauthenticated: 'Sign in to send a secret into a project session: this install requires a login.',
      machineClient: 'Sending a secret into a project session is an operator\'s decision, and a local process is not one.',
      openToken: 'This install has no login, so a secure clipboard send must carry the anti-forgery token its '
        + 'dashboard was issued. Reload the dashboard and try again.',
      gateUnsupported: (gateState) => `A secret cannot be sent while the login gate is "${gateState}". Resolve the gate first.`
    });
    if (!proof) return;

    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    if (!body || typeof body !== 'object' || typeof body.text !== 'string' || body.text.length === 0) {
      return errorResponse(res, 400, 'The request body must carry a non-empty `text`.', 'BAD_REQUEST');
    }
    const mode = body.mode === 'file' || body.mode === 'paste' ? body.mode : null;
    if (!mode) return errorResponse(res, 400, '`mode` must be "file" or "paste".', 'BAD_REQUEST');
    if (typeof body.filename !== 'string' || body.filename.length === 0) {
      return errorResponse(res, 400, '`filename` is required for both modes.', 'BAD_REQUEST');
    }
    const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';

    let written;
    try {
      written = secureClipboard.writeSecretFile(project, { filename: body.filename, content: body.text, encoding });
    } catch (err) {
      return errorResponse(res, 400, err.message, 'SECURE_CLIPBOARD_WRITE_FAILED');
    }

    if (mode === 'file') {
      return jsonResponse(res, 200, { ok: true, mode: 'file', ...written });
    }

    // mode === 'paste' — the pane gets only a content-free pointer, never `body.text` itself.
    const notice = `Secure clipboard: a secret was saved to ${written.relPath} (${written.bytes} bytes).`;
    const result = sessions.injectCommand(params.project, notice, { enter: false });
    log.info('Secure clipboard paste-notify attempted', {
      project: params.project, filename: body.filename, bytes: written.bytes,
      secretTypesDetected: written.secretTypesDetected, ok: result.ok
    });
    const refused = _respondToInjectResult(res, result);
    if (refused !== null) return;
    jsonResponse(res, 200, { ok: true, mode: 'paste', notified: true, ...written });
  }, { gatedAction: 'session-command', maxBodySize: MAX_BODY_SIZE });

  // GET /api/sessions/:project/secure-clipboard — pending secret files (metadata only).
  // Uses _requireOperatorWrite's proof for this read too — see the module docblock.
  route('GET', '/api/sessions/:project/secure-clipboard', (req, res, params) => {
    const project = store.projects.getByName(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');

    const reader = _requireOperatorWrite(req, res, {
      logEvent: 'Refused a secure clipboard list read',
      logContext: { project: params.project },
      fallbackAction: 'list a project\'s pending secret files',
      sameOriginWhat: 'A secure clipboard list read',
      unauthenticated: 'Sign in to list pending secret files: this install requires a login.',
      machineClient: 'Listing a project\'s pending secret files is an operator\'s decision, and a local process is not one.',
      openToken: 'This install has no login, so listing pending secret files must carry the anti-forgery token its '
        + 'dashboard was issued. Reload the dashboard and try again.',
      gateUnsupported: (gateState) => `Pending secret files cannot be listed while the login gate is "${gateState}". Resolve the gate first.`
    });
    if (!reader) return;

    jsonResponse(res, 200, { gateState: reader.clearance, project: params.project, files: secureClipboard.listSecretFiles(project) });
  });

  // DELETE /api/sessions/:project/secure-clipboard/:filename
  route('DELETE', '/api/sessions/:project/secure-clipboard/:filename', (req, res, params) => {
    const project = store.projects.getByName(params.project);
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;

    const proof = _requireOperatorWrite(req, res, {
      logEvent: 'Refused a secure clipboard file delete',
      logContext: { project: params.project },
      fallbackAction: 'delete a pending secret file',
      sameOriginWhat: 'A secure clipboard file delete',
      unauthenticated: 'Sign in to delete a pending secret file: this install requires a login.',
      machineClient: 'Deleting a pending secret file is an operator\'s decision, and a local process is not one.',
      openToken: 'This install has no login, so a secret file delete must carry the anti-forgery token its '
        + 'dashboard was issued. Reload the dashboard and try again.',
      gateUnsupported: (gateState) => `A secret file cannot be deleted while the login gate is "${gateState}". Resolve the gate first.`
    });
    if (!proof) return;

    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    let result;
    try {
      result = secureClipboard.deleteSecretFile(project, params.filename);
    } catch (err) {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    if (!result.deleted) return errorResponse(res, 404, `No pending secret file named "${params.filename}"`, 'NOT_FOUND');
    jsonResponse(res, 200, { ok: true, filename: params.filename, deleted: true });
  }, { gatedAction: 'session-command' });
}

module.exports = { register };
