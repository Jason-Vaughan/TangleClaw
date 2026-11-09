'use strict';

/**
 * The `/api/sessions/:project/secure-clipboard*` route family (#1032):
 * cross-machine secure clipboard sync and file/secret uploader.
 *
 * This is an OPERATOR action from the dashboard — the person's own browser,
 * on the device holding the secret, sending it into a project's session
 * workspace or pane — never a project-session API client, so every route
 * here is gated through `./_callers`'s `_requireOperatorWrite`/
 * `_requireOperatorRead`, the same proof `lib/routes/engine-health-routes.js`
 * and `lib/routes/engines-canary.js` use. `register()` therefore takes no
 * `deps`, the same no-deps convention those two families use.
 *
 * `POST`/`DELETE` both match the gate-relevant `/api/sessions/:project(/|$)`
 * family `test/api-coordinator-rotation.test.js` sweeps, so both declare
 * `gatedAction: 'session-command'` and call `coordinatorGateRefused` first —
 * the same bucket `lib/routes/sessions.js`'s `/command` route and
 * `lib/routes/engine-health-routes.js`'s `/engine-health/suppress` route use
 * for "ordinary work typed/written into a project's own session".
 *
 * Mode `'paste'` reuses `lib/sessions.js#injectCommand` whole (project/
 * session resolution, control-gate, startup-dialog and wrap checks, the
 * `tmux.sendKeys` call itself) rather than re-deriving any of it — the same
 * reuse `lib/routes/engine-health-routes.js` makes of `sessions.js`'s
 * kill/launch — with `enter: false` always, so a pasted secret is never
 * auto-submitted as a command. Mode `'file'` writes through
 * `lib/secure-clipboard.js`, which owns the `.tangleclaw/secrets/` store.
 *
 * @module lib/routes/secure-clipboard
 */

const store = require('../store');
const sessions = require('../sessions');
const secureClipboard = require('../secure-clipboard');
const { createLogger } = require('../logger');
const { route, jsonResponse, errorResponse } = require('./_kernel');
const { _requireOperatorRead, _requireOperatorWrite, coordinatorGateRefused } = require('./_callers');

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

    if (mode === 'paste') {
      const audit = secureClipboard.scanForAudit(body.text);
      const result = sessions.injectCommand(params.project, body.text, { enter: false });
      log.info('Secure clipboard paste attempted', {
        project: params.project, bytes: audit.bytes, secretTypesDetected: audit.secretTypesDetected, ok: result.ok
      });
      const refused = _respondToInjectResult(res, result);
      if (refused !== null) return;
      return jsonResponse(res, 200, { ok: true, mode: 'paste', bytes: audit.bytes, secretTypesDetected: audit.secretTypesDetected });
    }

    // mode === 'file'
    if (typeof body.filename !== 'string' || body.filename.length === 0) {
      return errorResponse(res, 400, 'file mode requires a non-empty `filename`.', 'BAD_REQUEST');
    }
    const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';
    let written;
    try {
      written = secureClipboard.writeSecretFile(project, { filename: body.filename, content: body.text, encoding });
    } catch (err) {
      return errorResponse(res, 400, err.message, 'SECURE_CLIPBOARD_WRITE_FAILED');
    }
    jsonResponse(res, 200, { ok: true, mode: 'file', ...written });
  }, { gatedAction: 'session-command', maxBodySize: MAX_BODY_SIZE });

  // GET /api/sessions/:project/secure-clipboard — pending secret files (metadata only).
  route('GET', '/api/sessions/:project/secure-clipboard', (req, res, params) => {
    const project = store.projects.getByName(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');

    const reader = _requireOperatorRead(req, res, {
      logEvent: 'Refused a secure clipboard list read',
      fallbackAction: 'list a project\'s pending secret files',
      noLogin: 'This install has no login, so pending secret files cannot be listed here: nothing would establish '
        + 'that the reader is the operator. Turn the login on and sign in.',
      unauthenticated: 'Sign in to list pending secret files: this install requires a login.',
      gateUnsupported: (gateState) => `Pending secret files cannot be listed while the login gate is "${gateState}". Resolve the gate first.`
    });
    if (!reader) return;

    jsonResponse(res, 200, { gateState: reader.gateState, project: params.project, files: secureClipboard.listSecretFiles(project) });
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
