#!/usr/bin/env node
'use strict';

/**
 * The live-Codex integration check for a coordinator context rotation (#2032,
 * Architect ruling A14). Unit tests run against a fake app-server; this runs
 * INSIDE a real Codex coordinator pane, against the real server, so it proves
 * what the fakes cannot: that Codex really exports `CODEX_THREAD_ID` into
 * tool shells, that it is the thread TangleClaw's control channel records,
 * and that after a managed clear the bound replacement is the thread the new
 * context actually runs in.
 *
 * It is run by an independent executor against the exact head under review,
 * in three phases, from a shell the Codex coordinator itself opens:
 *
 *   node scripts/rotation-live-check.js pre
 *     Before rotating: CODEX_THREAD_ID is set, and equals the thread the
 *     session's control channel records.
 *
 *   node scripts/rotation-live-check.js prepare <checkpoint.json>
 *     Starts a managed clear with the given checkpoint (the executor writes it
 *     from live facts). End the turn afterwards; TangleClaw clears the pane.
 *
 *   node scripts/rotation-live-check.js post
 *     In the replacement context, from the re-entry turn: CODEX_THREAD_ID is
 *     a DIFFERENT thread from before, equals the rotation's bound replacement
 *     and the channel's recorded thread, and the rotation is reconciling — or
 *     already active, since the re-entry turn itself tells the coordinator to
 *     resume, and it may have done so before this phase runs.
 *
 * Each phase prints PASS or FAIL lines and exits non-zero on any FAIL. The
 * resume itself is the coordinator's own `tc rotation resume`, as in real use.
 *
 * The API origin and launch binding come from the pane's own environment
 * (`TANGLECLAW_API`, `TANGLECLAW_PROJECT_ID`, `TANGLECLAW_LAUNCH_ID`); nothing
 * is typed or remembered.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * The private directory the pre phase leaves its evidence in for the post
 * phase: created 0700 for this user only, and refused if it already exists as
 * anything else (a symlink, another user's directory, a looser mode), so no
 * other local user can plant or read the state.
 * @returns {string} The directory.
 * @throws {Error} When the directory is not safe to use.
 */
function _stateDir() {
  const dir = path.join(os.tmpdir(), `tc-rotation-live-check-${process.getuid ? process.getuid() : 'user'}`);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} is owned by another user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} is readable or writable by others`);
  return dir;
}

/**
 * The state file for this launch, inside {@link _stateDir}.
 * @returns {string}
 */
function stateFile() {
  const launch = (process.env.TANGLECLAW_LAUNCH_ID || 'nolaunch').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(_stateDir(), `${launch}.json`);
}

/**
 * Write the state file without following a symlink planted at its path.
 * @param {string} file - Path.
 * @param {string} text - Contents.
 * @returns {void}
 */
function writeState(file, text) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

let failed = false;

/**
 * Print one check.
 * @param {boolean} ok - Passed.
 * @param {string} what - The claim.
 * @param {*} [detail] - Evidence.
 * @returns {void}
 */
function check(ok, what, detail) {
  if (!ok) failed = true;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail === undefined ? '' : `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}\n`);
}

/**
 * One API request with the pane's own binding and the forwarded thread.
 * @param {string} method - HTTP method.
 * @param {string} apiPath - Path.
 * @param {object} [body] - JSON body.
 * @returns {Promise<{status: number, body: object}>}
 */
async function api(method, apiPath, body) {
  // Named as tc names itself, so the workload write in `post` is accepted
  // exactly as the coordinator's own `tc workload set` would be.
  const headers = { 'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'rotation.live-check', 'content-type': 'application/json' };
  if (process.env.TANGLECLAW_PROJECT_ID) headers['x-tangleclaw-project-id'] = process.env.TANGLECLAW_PROJECT_ID;
  if (process.env.TANGLECLAW_LAUNCH_ID) headers['x-tangleclaw-launch-id'] = process.env.TANGLECLAW_LAUNCH_ID;
  if (process.env.CODEX_THREAD_ID) headers['x-tangleclaw-engine-thread'] = process.env.CODEX_THREAD_ID;
  const res = await fetch(`${process.env.TANGLECLAW_API}${apiPath}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* the status alone will have to do */ }
  return { status: res.status, body: parsed };
}

/**
 * Before rotating: the forwarded thread is the channel's thread.
 * @returns {Promise<void>}
 */
async function pre() {
  const thread = process.env.CODEX_THREAD_ID || null;
  check(!!thread, 'CODEX_THREAD_ID is exported into this tool shell', thread);
  const r = await api('GET', '/api/tc/rotation');
  check(r.status === 200, 'GET /api/tc/rotation answers for this launch', r.status);
  const b = r.body && r.body.binding;
  check(!!b && b.channelThread === thread, 'the forwarded thread is the one the control channel records', b);
  check(!(r.body && r.body.rotation), 'no rotation is open yet', r.body && r.body.rotation && r.body.rotation.state);
  writeState(stateFile(), JSON.stringify({ preThread: thread, at: new Date().toISOString() }));
}

/**
 * Start the managed clear.
 * @param {string} file - Checkpoint JSON.
 * @returns {Promise<void>}
 */
async function prepare(file) {
  const text = fs.readFileSync(file, 'utf8');
  const attemptKey = `live-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 40)}`;
  const r = await api('POST', '/api/tc/rotation/prepare', { attemptKey, checkpoint: JSON.parse(text) });
  check(r.status === 201 || r.status === 200, 'prepare accepted', r.body && (r.body.code || r.body.rotation && r.body.rotation.state));
  if (r.body && r.body.rotation) process.stdout.write(`rotation ${r.body.rotation.rotationId}, generation ${r.body.rotation.generation}. End this turn now.\n`);
}

/**
 * In the replacement context: a new thread, bound, reconciling.
 * @returns {Promise<void>}
 */
async function post() {
  const thread = process.env.CODEX_THREAD_ID || null;
  let preThread = null;
  const file = stateFile();
  try { preThread = JSON.parse(fs.readFileSync(file, 'utf8')).preThread; } catch { /* checked below */ }
  check(!!preThread, 'the pre phase recorded the old thread', file);
  check(!!thread && thread !== preThread, 'this context runs in a different thread from before the clear', { before: preThread, now: thread });
  const r = await api('GET', '/api/tc/rotation');
  const rot = r.body && (r.body.rotation || r.body.latest);
  check(!!rot && (rot.state === 'reconciling' || rot.state === 'active'), 'the rotation is reconciling, or already resumed by this context', rot && rot.state);
  check(!!rot && rot.replacementThreadId === thread, 'the rotation bound exactly this thread', rot && rot.replacementThreadId);
  check(!!r.body && !!r.body.binding && r.body.binding.matches, 'the control channel now records this thread', r.body && r.body.binding);
  check(!!rot && rot.priorThreadId === preThread, 'the rotation\'s prior thread is the old one', rot && rot.priorThreadId);
  const stale = await api('POST', '/api/tc/workload', { schema: 'tc.workload/1', state: 'working', clearance: 'do-not-clear', summary: 'live check' });
  check(stale.status === 201, 'the bound replacement may publish workload (201)', stale.status);
}

/**
 * Dispatch the phase.
 * @returns {Promise<void>}
 */
async function main() {
  const [phase, arg] = process.argv.slice(2);
  if (!process.env.TANGLECLAW_API) {
    process.stderr.write('TANGLECLAW_API is not set: run this from a TangleClaw-launched pane.\n');
    process.exit(2);
  }
  if (phase === 'pre') await pre();
  else if (phase === 'prepare' && arg) await prepare(arg);
  else if (phase === 'post') await post();
  else {
    process.stderr.write('usage: node scripts/rotation-live-check.js pre | prepare <checkpoint.json> | post\n');
    process.exit(2);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`rotation-live-check: ${err.message}\n`);
  process.exit(2);
});
