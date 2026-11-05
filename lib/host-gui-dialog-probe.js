'use strict';

/**
 * Detect a blocking host-level GUI dialog (a macOS TCC permission prompt, a
 * Gatekeeper warning, a crash reporter) and correlate it with sessions that
 * look stalled, from no surface TangleClaw already has (#1112, Ruling
 * A503-R1).
 *
 * #1112's own incident: an eight-day-old orphaned session sat behind an
 * unanswered `"2.1.233" would like to access files in your Documents
 * folder.` TCC prompt. The prompt is a native window WindowServer draws,
 * owned by one of a small, fixed set of macOS system agents -- never the
 * session's own process -- so no pane capture or switchboard probe could
 * ever see it. This module answers one question honestly: is a host GUI
 * dialog agent currently running, and if so, are there sessions that look
 * stalled right now. It cannot prove which dialog caused which stall (the
 * dialog process carries no back-reference to the PID that triggered it,
 * and macOS exposes none cheaply) -- it reports both facts side by side and
 * lets the caller, who already knows what "stalled" means for a session,
 * draw the conclusion.
 *
 * Self-contained: no filesystem, no TangleClaw store, no real subprocess
 * call unless a caller supplies no `execFile` override. Safe/inert off
 * macOS (`blocked: false`, no process ever spawned) and when no dialog
 * agent is running (the overwhelmingly common case) -- an empty, honest
 * negative, not a special state.
 *
 * @module lib/host-gui-dialog-probe
 */

const { execFile } = require('node:child_process');

/**
 * The macOS system agents that own a blocking GUI modal (#1112's own
 * enumeration): TCC/Gatekeeper permission prompts (`SecurityAgent`,
 * `UserNotificationCenter`), legacy UI-server dialogs
 * (`CoreServicesUIAgent`), unreported crash dialogs (`CrashReporter`), and
 * `SystemUIServer`, which can itself host a modal alert.
 */
const DIALOG_PROCESS_NAMES = Object.freeze([
  'SecurityAgent', 'UserNotificationCenter', 'CoreServicesUIAgent', 'CrashReporter', 'SystemUIServer'
]);

const PS_TIMEOUT_MS = 5000;

/**
 * Run `ps -A -o pid=,comm=` and return each process as `{pid, comm}`. The
 * production seam: wraps `node:child_process`'s callback-style `execFile`
 * in a promise so callers (and the default export below) await it the same
 * way a caller-supplied seam would.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<{stdout: string}>}
 */
function _defaultExecFile(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: PS_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || '' });
    });
  });
}

/**
 * Parse `ps -A -o pid=,comm=,etime=` output into `{pid, comm, etimeSeconds}`
 * rows, skipping any line this format doesn't recognize rather than
 * throwing -- `ps`'s own column widths vary slightly across macOS versions.
 * @param {string} stdout
 * @returns {Array<{pid: number, comm: string, etimeSeconds: number}>}
 */
function _parsePs(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\S+)\s+(\S+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const etimeSeconds = _parseEtime(m[3]);
    if (!Number.isInteger(pid) || etimeSeconds === null) continue;
    // `comm=` prints the full path for some agents; the name this module
    // matches against is the final path segment.
    const comm = m[2].split('/').pop();
    rows.push({ pid, comm, etimeSeconds });
  }
  return rows;
}

/**
 * Parse `ps`'s `etime=` elapsed-time format (`[[dd-]hh:]mm:ss`) into whole
 * seconds, or `null` for a string this format doesn't recognize.
 * @param {string} etime
 * @returns {number|null}
 */
function _parseEtime(etime) {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Probe for a blocking host-level GUI dialog and correlate it with the
 * caller's own notion of which sessions currently look stalled.
 *
 * `blocked` is true only when BOTH a dialog agent is currently running AND
 * at least one stalled session was given -- a dialog agent alone (someone
 * actively approving a normal prompt) is not an incident, and a stalled
 * session with no dialog running points at a different cause entirely, one
 * this module has nothing useful to say about.
 *
 * @param {object} [input]
 * @param {string} [input.platform] - Overrides `process.platform`, for tests.
 * @param {(cmd: string, args: string[]) => Promise<{stdout: string}>} [input.execFile] -
 *   Injectable seam; default runs the real `ps -A -o pid=,comm=,etime=`.
 * @param {Array<{pid: number, elapsedSeconds?: number, label?: string}>} [input.stalledSessions] -
 *   Sessions the caller already judges as looking idle/stalled, by their OS pid.
 * @returns {Promise<{blocked: boolean, dialogs: Array<{pid: number, name: string, elapsedSeconds: number}>,
 *   stalledSessions: Array<{pid: number, elapsedSeconds: (number|undefined), label: (string|undefined)}>,
 *   summary: string}>}
 */
async function probeHostGuiDialogs(input) {
  const i = input || {};
  const platform = typeof i.platform === 'string' ? i.platform : process.platform;
  const stalledSessions = Array.isArray(i.stalledSessions) ? i.stalledSessions : [];

  if (platform !== 'darwin') {
    return {
      blocked: false, dialogs: [], stalledSessions: [],
      summary: `host GUI dialog detection is macOS-only; this host reports "${platform}"`
    };
  }

  const runExecFile = i.execFile || _defaultExecFile;
  const { stdout } = await runExecFile('ps', ['-A', '-o', 'pid=,comm=,etime=']);
  const rows = _parsePs(stdout);
  const dialogs = rows
    .filter((r) => DIALOG_PROCESS_NAMES.includes(r.comm))
    .map((r) => ({ pid: r.pid, name: r.comm, elapsedSeconds: r.etimeSeconds }));

  const blocked = dialogs.length > 0 && stalledSessions.length > 0;
  const summary = blocked
    ? `${dialogs.length} host GUI dialog process(es) running (${dialogs.map((d) => d.name).join(', ')}) while ${stalledSessions.length} session(s) look stalled -- a blocking prompt is the likely cause`
    : dialogs.length > 0
      ? `${dialogs.length} host GUI dialog process(es) running, but no stalled sessions reported`
      : 'no host GUI dialog process detected';

  return { blocked, dialogs, stalledSessions: blocked ? stalledSessions : [], summary };
}

module.exports = {
  DIALOG_PROCESS_NAMES,
  probeHostGuiDialogs,
  _internal: { defaultExecFile: _defaultExecFile, parsePs: _parsePs, parseEtime: _parseEtime }
};
