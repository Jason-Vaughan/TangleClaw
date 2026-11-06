'use strict';

/**
 * Startup announcement (#1732): once a session's launch sequence has
 * attested READY and it has an active Medusa presence, send one switchboard
 * message announcing it is online — "so coordinators like the
 * ProjectManager can know the fresh session is ready for its next plan
 * chunk without polling or manual operator notification" (the issue's own
 * words). Nothing here can tell which live session embodies which
 * coordinator role, so the audience is every OTHER live session on the
 * SAME project; whichever of them is a coordinator is free to act on it.
 *
 * Checked from two call sites, since either condition can land first:
 * `lib/launch-sequence.js#ready` (after READY commits) and
 * `lib/sessions.js#_maybeAutoStartMedusa` (when the listener starts).
 * Idempotent per launch sequence id (a process-local guard — this is a
 * best-effort notification, not a durable record, the same tier as
 * `lib/medusa.js#_captureCarriedMail`'s "never throws, never blocks"
 * contract), so calling from both sites is always safe.
 *
 * @module lib/medusa-startup-announce
 */

const store = require('./store');
const medusaRegistry = require('./medusa-registry');

/** Env var escape hatch: any install-wide opt-out, independent of the project toggle. */
const ANNOUNCE_ENV_VAR = 'TANGLECLAW_STARTUP_ANNOUNCE_DISABLED';

/** Sessions with this many or fewer other live peers on a project are rare; raised past the API's own default (20) so a busy project is never silently truncated. */
const MAX_PROJECT_SESSIONS = 100;

/** Launch sequence ids this process has already announced, exactly once each. */
const _announced = new Set();

/**
 * Whether this install has opted out of startup announcements — the env var
 * escape hatch, or the project's own config toggle.
 * @param {object} [projConfig] - As `store.projectConfig.load` returns it.
 * @param {{env?: object}} [deps] - Injectable `env`, defaulting to `process.env`.
 * @returns {boolean}
 */
function announceDisabled(projConfig, deps) {
  const env = (deps && deps.env) || process.env;
  if (env[ANNOUNCE_ENV_VAR] === 'true' || env[ANNOUNCE_ENV_VAR] === '1') return true;
  return !!(projConfig && projConfig.startupAnnounceDisabled === true);
}

/**
 * The announcement text, in the exact shape #1732 specifies.
 * @param {object} input
 * @param {string} input.sessionName
 * @param {string} input.role
 * @param {number} input.sessionId
 * @param {string} input.workspaceId
 * @returns {string}
 */
function buildStartupAnnouncement({ sessionName, role, sessionId, workspaceId }) {
  return `[Startup] ${sessionName} (${role}) online — session #${sessionId}, workspace ${workspaceId}, ready for switchboard work.`;
}

/**
 * Whether this launch sequence has already been announced in this process.
 * @param {number} sequenceId
 * @returns {boolean}
 */
function hasAnnounced(sequenceId) {
  return _announced.has(sequenceId);
}

/**
 * Record a launch sequence as announced. Idempotent.
 * @param {number} sequenceId
 * @returns {void}
 */
function markAnnounced(sequenceId) {
  _announced.add(sequenceId);
}

/** Test seam: clear the idempotency guard. @returns {void} */
function _resetAnnouncedForTesting() {
  _announced.clear();
}

/**
 * The announcement's real audience (I-Gate Round 1, #5798277310): CROSS-PROJECT,
 * not same-project. TangleClaw admits at most one active session per
 * `store.projects` row (`lib/sessions.js#launchSession`'s own guard), and
 * every fleet coordinator (`TC-Lane-PM`, `TC-Lane-Arc`) is its own project
 * row rather than a second session of the lane it coordinates — the exact
 * finding that drove #1713's own cross-project redesign a few commits
 * earlier in this same car applies here too, and this function's first
 * version missed it: a same-project-only query always excludes the only
 * session a project ever has (itself) and resolves `[]`.
 *
 * So the real audience is every OTHER project currently holding an active
 * `architect`/`project-manager` coordinator grant, each contributing its
 * own active session's Medusa workspace id — never the announcing
 * project's own (self-notification), and never a project with no active
 * session for its grant (there is nothing live to receive it).
 *
 * `MAX_PROJECT_SESSIONS` caps the RESOLVED recipient list, never the input
 * project list (I-Gate Round 2, #5798507488): slicing `listProjects()`
 * before filtering by active coordinator role would silently drop a real
 * coordinator sitting past the cap in project-id order, resolving
 * `no-recipients` for it even though it is live and opted in.
 * @param {number} projectId - The ANNOUNCING session's own project id (excluded).
 * @param {number} excludeSessionId - The announcing session itself (defensive; a
 *   project matching `projectId` is already excluded above it).
 * @param {{listProjects?: Function, getActiveRoleForProject?: Function,
 *   getActiveSessionForProject?: Function, getWorkspaceId?: Function}} [deps]
 * @returns {string[]}
 */
function resolveProjectRecipients(projectId, excludeSessionId, deps) {
  const d = deps || {};
  const listProjects = typeof d.listProjects === 'function' ? d.listProjects : () => store.projects.list();
  const getActiveRoleForProject = typeof d.getActiveRoleForProject === 'function'
    ? d.getActiveRoleForProject : (pid) => store.coordinatorRoles.getActiveForProject(pid);
  const getActiveSessionForProject = typeof d.getActiveSessionForProject === 'function'
    ? d.getActiveSessionForProject : (pid) => store.sessions.getActive(pid);
  const getWorkspaceId = typeof d.getWorkspaceId === 'function' ? d.getWorkspaceId : medusaRegistry.getWorkspaceId;

  const projects = listProjects() || [];
  const out = [];
  for (const project of projects) {
    if (!project || project.id === projectId) continue;
    const role = getActiveRoleForProject(project.id);
    if (!role) continue;
    const session = getActiveSessionForProject(project.id);
    if (!session || session.id === excludeSessionId) continue;
    const workspaceId = getWorkspaceId(project.path, session.id);
    if (workspaceId) out.push(workspaceId);
  }
  return out.slice(0, MAX_PROJECT_SESSIONS);
}

/**
 * Attempt the startup announcement for one session, exactly once per launch
 * sequence, once both `isReady` and `isListening` hold. Never throws: a
 * recipient-resolution or send failure degrades to `{sent: false}` rather
 * than disrupting whichever call site (READY attestation, listener start)
 * triggered it.
 * @param {object} input
 * @param {number} input.sequenceId - For the idempotency guard.
 * @param {number} input.sessionId
 * @param {string} input.sessionName
 * @param {string} input.role
 * @param {string} input.workspaceId
 * @param {boolean} input.isReady
 * @param {boolean} input.isListening
 * @param {object} [input.projConfig]
 * @param {object} [deps]
 * @param {{env?: object}} [deps.env]
 * @param {() => string[]} deps.resolveRecipients - Required; see {@link resolveProjectRecipients}.
 * @param {(args: {to: string, message: string}) => Promise<*>} deps.sendSystemMessage - Required.
 * @returns {Promise<{sent: boolean, reason: (string|null), recipients?: string[], message?: string}>}
 */
async function maybeAnnounceStartup(input, deps) {
  const d = deps || {};
  try {
    const { sequenceId, sessionId, sessionName, role, workspaceId, isReady, isListening, projConfig } = input || {};
    if (!Number.isInteger(sequenceId)) return { sent: false, reason: 'no-sequence-id' };
    if (hasAnnounced(sequenceId)) return { sent: false, reason: 'already-announced' };
    if (announceDisabled(projConfig, d)) return { sent: false, reason: 'disabled' };
    if (!isReady || !isListening) return { sent: false, reason: 'not-both-conditions' };

    const recipients = typeof d.resolveRecipients === 'function' ? d.resolveRecipients() : [];
    if (recipients.length === 0) {
      markAnnounced(sequenceId); // nothing to tell; don't re-check forever
      return { sent: false, reason: 'no-recipients' };
    }
    const message = buildStartupAnnouncement({ sessionName, role, sessionId, workspaceId });
    // Marked BEFORE sending: a send failure must not spam retries from every
    // later call to a function this module itself documents as best-effort.
    markAnnounced(sequenceId);
    const send = typeof d.sendSystemMessage === 'function' ? d.sendSystemMessage : async () => {};
    let sentCount = 0;
    for (const to of recipients) {
      try {
        await send({ to, message });
        sentCount += 1;
      } catch (_err) {
        // Best-effort per recipient; one failure must not stop the rest.
      }
    }
    return { sent: sentCount > 0, reason: sentCount > 0 ? null : 'send-failed', recipients, message };
  } catch (_err) {
    return { sent: false, reason: 'error' };
  }
}

module.exports = {
  ANNOUNCE_ENV_VAR,
  announceDisabled,
  buildStartupAnnouncement,
  hasAnnounced,
  markAnnounced,
  _resetAnnouncedForTesting,
  resolveProjectRecipients,
  maybeAnnounceStartup
};
