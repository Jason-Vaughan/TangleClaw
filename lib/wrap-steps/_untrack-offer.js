'use strict';

/**
 * The one-time offer to stop tracking TangleClaw state files (#1512).
 *
 * A state file a project once committed stays tracked: an ignore rule cannot
 * hide it, so every TangleClaw write shows in `git status` and in diffs. Taking
 * it out of tracking is a commit, which TangleClaw never makes on its own, so
 * the wrap asks once — naming the exact paths — and carries an approval as a
 * `git rm --cached` in the wrap commit. The files stay on disk.
 *
 * A decline is remembered per checkout (`wrap-state`), so the same paths are not
 * offered again; a state path that becomes tracked later is.
 *
 * `session-files` asks; `commit` acts. Both call {@link resolve} on the same
 * inputs so they cannot disagree about which paths an approval covers.
 */

const tcOwned = require('./_tc-owned-paths');

/** The two answers the drawer can send as `options.untrackState`. */
const ANSWERS = Object.freeze({ APPROVE: 'approve', DECLINE: 'decline' });

/**
 * Keep only a well-formed answer from an options bag that arrived over HTTP.
 *
 * @param {*} raw - `options.untrackState` as received.
 * @returns {('approve'|'decline'|null)}
 */
function sanitizeAnswer(raw) {
  return raw === ANSWERS.APPROVE || raw === ANSWERS.DECLINE ? raw : null;
}

/**
 * Tracked paths in the work tree that are TangleClaw state.
 *
 * @param {(file: string, args: string[], opts: object) => Promise<{exitCode:number, stdout:string, stderr:string}>} exec
 * @param {string} toplevel - The work tree's repository root.
 * @returns {Promise<{paths:string[], error:(string|null)}>}
 */
async function listTrackedState(exec, toplevel) {
  const res = await exec('git', ['ls-files', '-z', '--', '.tangleclaw'], { cwd: toplevel });
  if (res.exitCode !== 0) {
    return { paths: [], error: `git ls-files failed (exit ${res.exitCode})${res.stderr ? `: ${String(res.stderr).trim().split('\n')[0]}` : ''}` };
  }
  return { paths: String(res.stdout).split('\0').filter((p) => p && tcOwned.isStatePath(p)).sort(), error: null };
}

/**
 * What the offer means for this wrap.
 *
 * @param {object} input
 * @param {string[]} input.tracked - Tracked state paths.
 * @param {string[]} input.declined - Paths an earlier decline covers.
 * @param {('approve'|'decline'|null)} input.answer - This wrap's answer.
 * @returns {{pending:string[], ask:boolean, untrack:string[], recordDecline:boolean}}
 *   `pending` is what the offer lists; `ask` means the operator must answer
 *   before the wrap goes on; `untrack` is what the commit removes from tracking.
 */
function resolve({ tracked, declined, answer }) {
  const kept = new Set(declined || []);
  const pending = (tracked || []).filter((p) => !kept.has(p));
  if (pending.length === 0) return { pending, ask: false, untrack: [], recordDecline: false };
  if (answer === ANSWERS.APPROVE) return { pending, ask: false, untrack: pending, recordDecline: false };
  if (answer === ANSWERS.DECLINE) return { pending, ask: false, untrack: [], recordDecline: true };
  return { pending, ask: true, untrack: [], recordDecline: false };
}

/**
 * The blocker line while the offer waits on the operator.
 *
 * @param {string[]} pending
 * @returns {string}
 */
function blockerLine(pending) {
  const n = pending.length;
  return `${n} TangleClaw state file${n === 1 ? ' is' : 's are'} tracked by git — choose Stop tracking or Keep tracking before the wrap goes on`;
}

/**
 * The remediation text naming every path.
 *
 * @param {string[]} pending
 * @returns {string}
 */
function remediation(pending) {
  return 'These files are TangleClaw machine state, rewritten as TangleClaw runs, and git tracks them in this project, so they show as changed in every session:\n'
    + `${pending.map((p) => `  - ${p}`).join('\n')}\n`
    + 'Stop tracking removes exactly these paths from git in this wrap\'s commit (`git rm --cached`); the files stay on disk and TangleClaw keeps using them. '
    + 'Keep tracking leaves them as they are, and the wrap will not ask about these paths again. Then Retry.';
}

module.exports = { ANSWERS, sanitizeAnswer, listTrackedState, resolve, blockerLine, remediation };
