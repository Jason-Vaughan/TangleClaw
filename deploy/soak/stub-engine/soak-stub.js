#!/usr/bin/env node
'use strict';

/**
 * The soak's stub engine (#2020): a deterministic stand-in for an AI engine
 * CLI, so the 72-hour soak can keep TangleClaw's session, PTY and
 * command-injection paths under continuous load inside a guest with no egress
 * and no vendor credentials.
 *
 * What it proves is limited on purpose. It exercises TangleClaw's side of a
 * session (launch, tmux, ttyd, command injection, switchboard, kill), never a
 * real vendor's engine. Real-engine behaviour is outside the soak.
 *
 * Protocol: print a ready line, then a prompt. For each input line, answer
 * `ack <n> <first 12 hex chars of sha256(line)>` and prompt again. `/exit` or
 * end of input exits 0. The same input always gives the same output.
 *
 * One family of lines is handled differently: `/soak-medusa send …` and
 * `/soak-medusa read …` (#2240). A switchboard call speaks for the session
 * that makes it, and only a session's own pane holds its launch binding, so
 * the soak driver types these lines into the pane and this program makes the
 * call itself, with this pane's `TANGLECLAW_LAUNCH_ID` and
 * `TANGLECLAW_PROJECT_ID`. It then prints exactly one result line the driver
 * reads back through the pane:
 *
 *   soak-medusa <nonce> <verb> ok id=<messageId>
 *   soak-medusa <nonce> <verb> refused status=<n> code=<CODE>
 *   soak-medusa <nonce> <verb> failed reason=<REASON>
 *
 * The result line never carries a launch id, a project id or a message body,
 * and stays short enough that an 80-column pane does not wrap it.
 *
 * Installed in the guest as `soak-stub` on PATH, with `soak-stub.json` in
 * `~/.tangleclaw/engines/`.
 *
 * @module deploy/soak/stub-engine/soak-stub
 */

const crypto = require('node:crypto');
const readline = require('node:readline');

const PROMPT = 'stub> ';

/** The command word the driver types to ask this pane for a switchboard call. */
const MEDUSA_COMMAND = '/soak-medusa';

/** The first word of every result line, which the driver searches the pane for. */
const RESULT_PREFIX = 'soak-medusa';

/** Per-request budget, as the soak's own executors use. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * How long a `read` waits for the tagged message to reach this session's
 * inbox. Shorter than the driver's own wait for the result line, so the
 * driver always sees this program's verdict rather than its own timeout.
 */
const READ_WAIT_MS = 45 * 1000;

/** The gap between two reads of the inbox. */
const READ_INTERVAL_MS = 1000;

/**
 * Why a call was not made or not finished, as printed after `reason=`. The
 * driver maps each to its outcome code (`lib/soak/executors.js`).
 */
const REASON = Object.freeze({
  NO_API: 'NO_API',
  NO_BINDING: 'NO_BINDING',
  BINDING_UNVERIFIED: 'BINDING_UNVERIFIED',
  WRONG_PROJECT: 'WRONG_PROJECT',
  WHOAMI_FAILED: 'WHOAMI_FAILED',
  BAD_COMMAND: 'BAD_COMMAND',
  REDIRECT_REFUSED: 'REDIRECT_REFUSED',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  BAD_BODY: 'BAD_BODY',
  NOT_DELIVERED: 'NOT_DELIVERED'
});

/** A nonce, a tag and a request id are short tokens with no spaces. */
const NONCE_RE = /^[0-9a-f]{8,16}$/;
const TOKEN_RE = /^[A-Za-z0-9._:-]{1,96}$/;
/** What may be echoed back from the server: a message id and an error code. */
const ID_RE = /^[A-Za-z0-9._:-]{1,40}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/;

/**
 * The answer to one input line.
 * @param {number} n - 1-based line number
 * @param {string} line - The line, without its newline
 * @returns {string} The answer
 */
function answer(n, line) {
  return `ack ${n} ${crypto.createHash('sha256').update(line).digest('hex').slice(0, 12)}`;
}

/**
 * Read a `/soak-medusa` line.
 *
 *   /soak-medusa send <nonce> <fromProject> <toWorkspaceId> <tag> [<requestId>]
 *   /soak-medusa read <nonce> <toProject> <tag>
 *
 * Project names are URI-encoded by the driver, since a name may hold a space.
 * @param {string} line - The input line
 * @returns {{verb: string, nonce: string, project?: string, to?: string, tag?: string, requestId?: string|null, error?: string}|null}
 *   The parsed command; `error` set when it is malformed; null when the line is not one
 */
function parseMedusaLine(line) {
  const words = line.trim().split(/\s+/);
  if (words[0] !== MEDUSA_COMMAND) return null;
  const [, verb, nonce, ...rest] = words;
  const head = { verb: verb === 'send' || verb === 'read' ? verb : '?', nonce: NONCE_RE.test(nonce || '') ? nonce : '?' };
  if (head.verb === '?' || head.nonce === '?') return { ...head, error: REASON.BAD_COMMAND };
  let project;
  try {
    project = decodeURIComponent(rest[0] || '');
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
    return { ...head, error: REASON.BAD_COMMAND };
  }
  if (!project) return { ...head, error: REASON.BAD_COMMAND };
  if (verb === 'send') {
    const [, to, tag, requestId] = rest;
    if (rest.length < 3 || rest.length > 4 || ![to, tag].every((t) => TOKEN_RE.test(t || ''))) return { ...head, error: REASON.BAD_COMMAND };
    if (requestId !== undefined && !TOKEN_RE.test(requestId)) return { ...head, error: REASON.BAD_COMMAND };
    return { ...head, project, to, tag, requestId: requestId === undefined ? null : requestId };
  }
  const [, tag] = rest;
  if (rest.length !== 2 || !TOKEN_RE.test(tag || '')) return { ...head, error: REASON.BAD_COMMAND };
  return { ...head, project, tag };
}

/**
 * This pane's identity, read from its environment at the moment of the call.
 * @param {object} env - The environment
 * @returns {{ok: true, origin: string, launchId: string, projectId: string, workspaceId: string}|{ok: false, reason: string}}
 */
function paneIdentity(env) {
  let origin = null;
  try {
    const api = new URL(env.TANGLECLAW_API || '');
    if (api.protocol === 'http:' || api.protocol === 'https:') origin = api.origin;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
  }
  if (!origin) return { ok: false, reason: REASON.NO_API };
  const launchId = env.TANGLECLAW_LAUNCH_ID;
  const projectId = env.TANGLECLAW_PROJECT_ID;
  const workspaceId = env.TANGLECLAW_WORKSPACE_ID;
  if (![launchId, projectId, workspaceId].every((v) => typeof v === 'string' && v.length > 0)) return { ok: false, reason: REASON.NO_BINDING };
  return { ok: true, origin, launchId, projectId, workspaceId };
}

/**
 * One request to this pane's own TangleClaw, carrying only its launch binding.
 * No cookie, CSRF token or bearer token is ever sent, the URL must stay on
 * `TANGLECLAW_API`'s origin, and a redirect is never followed, so no other
 * server can receive the binding.
 * @param {object} io - `{fetch}`
 * @param {object} id - From `paneIdentity`
 * @param {string} method - HTTP method
 * @param {string} path - Path and query on the origin
 * @param {object} [body] - JSON body
 * @param {object} [extra] - Extra headers
 * @returns {Promise<{status: number, body: *}|{reason: string}>} The status and parsed body, or why there is none
 */
async function _request(io, id, method, path, body, extra = {}) {
  const url = new URL(path, id.origin);
  if (url.origin !== id.origin) return { reason: REASON.NO_API };
  const headers = { accept: 'application/json', 'x-tangleclaw-launch-id': id.launchId, 'x-tangleclaw-project-id': id.projectId, ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await io.fetch(url, {
      method,
      redirect: 'manual',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: a call that cannot reach the server is a printed outcome, never a crash of the pane
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { reason: timedOut ? REASON.TIMEOUT : REASON.NETWORK };
  }
  if (res.status >= 300 && res.status <= 399) return { reason: REASON.REDIRECT_REFUSED };
  try {
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: a cut-off or non-JSON body is a printed outcome
    return { reason: REASON.BAD_BODY };
  }
}

/**
 * Whether this pane may act on `project`'s switchboard route. The server
 * accepts a live binding on another project's route, so the check is made
 * here: whoami must call this pane's binding verified, name this pane's
 * project as the one in the route, and echo this pane's workspace.
 * @param {object} io - `{fetch}`
 * @param {object} id - From `paneIdentity`
 * @param {string} project - The project named in the route
 * @returns {Promise<{ok: true}|{ok: false, reason: string, state?: string}>} Whether to proceed
 */
async function _checkOwnRoute(io, id, project) {
  const q = `projectId=${encodeURIComponent(id.projectId)}&workspaceId=${encodeURIComponent(id.workspaceId)}`;
  // A side lookup, so the server records no awareness receipt for it.
  const r = await _request(io, id, 'GET', `/api/tc/whoami?${q}`, undefined, { 'x-tangleclaw-aux': '1' });
  if (r.reason || r.status < 200 || r.status > 299 || !r.body || typeof r.body !== 'object') return { ok: false, reason: REASON.WHOAMI_FAILED };
  const { binding, project: who, workspaceId } = r.body;
  if (!binding || typeof binding !== 'object' || typeof binding.state !== 'string') return { ok: false, reason: REASON.WHOAMI_FAILED };
  if (binding.state !== 'verified') {
    return { ok: false, reason: REASON.BINDING_UNVERIFIED, state: /^[a-z-]{1,20}$/.test(binding.state) ? binding.state : '?' };
  }
  if (String(binding.projectId) !== id.projectId) return { ok: false, reason: REASON.WRONG_PROJECT };
  if (!who || typeof who !== 'object' || String(who.id) !== id.projectId || who.name !== project) return { ok: false, reason: REASON.WRONG_PROJECT };
  if (workspaceId !== id.workspaceId) return { ok: false, reason: REASON.WRONG_PROJECT };
  return { ok: true };
}

/**
 * A refusal line's tail for a non-2xx answer: its status and the server's own
 * code, unchanged, so a binding refusal reaches the soak log by name.
 * @param {{status: number, body: *}} r - The answer
 * @returns {string} `refused status=<n> code=<CODE>`
 */
function _refused(r) {
  const code = r.body && typeof r.body.code === 'string' && CODE_RE.test(r.body.code) ? r.body.code : 'HTTP_STATUS';
  return `refused status=${r.status} code=${code}`;
}

/**
 * Send the tagged message from this pane's session.
 * @param {object} io - `{fetch}`
 * @param {object} id - From `paneIdentity`
 * @param {object} cmd - From `parseMedusaLine`
 * @returns {Promise<string>} The result line's tail
 */
async function _send(io, id, cmd) {
  const body = { to: cmd.to, message: `soak medusa-cycle ${cmd.tag}` };
  if (cmd.requestId) body.requestId = cmd.requestId;
  const r = await _request(io, id, 'POST', `/api/sessions/${encodeURIComponent(cmd.project)}/medusa/send`, body);
  if (r.reason) return `failed reason=${r.reason}`;
  if (r.status < 200 || r.status > 299) return _refused(r);
  const msgId = r.body && r.body.id;
  if (typeof msgId !== 'string' || !ID_RE.test(msgId)) return `failed reason=${REASON.BAD_BODY}`;
  return `ok id=${msgId}`;
}

/**
 * Wait for the tagged message in this pane's session's own inbox, then mark
 * that one message handled. Both calls are recorded against this session.
 * @param {object} io - `{fetch, now, sleep}`
 * @param {object} id - From `paneIdentity`
 * @param {object} cmd - From `parseMedusaLine`
 * @returns {Promise<string>} The result line's tail
 */
async function _read(io, id, cmd) {
  const base = `/api/sessions/${encodeURIComponent(cmd.project)}/medusa`;
  const deadline = io.now() + READ_WAIT_MS;
  for (;;) {
    const inbox = await _request(io, id, 'GET', `${base}/messages`);
    if (inbox.reason) return `failed reason=${inbox.reason}`;
    if (inbox.status < 200 || inbox.status > 299) return _refused(inbox);
    const messages = inbox.body && Array.isArray(inbox.body.messages) ? inbox.body.messages : null;
    if (!messages) return `failed reason=${REASON.BAD_BODY}`;
    const found = messages.find((m) => m && typeof m.message === 'string' && m.message.split(/\s+/).includes(cmd.tag));
    if (found) {
      if (typeof found.id !== 'string' || !ID_RE.test(found.id)) return `failed reason=${REASON.BAD_BODY}`;
      const handled = await _request(io, id, 'POST', `${base}/read`, { ids: [found.id] });
      if (handled.reason) return `failed reason=${handled.reason}`;
      if (handled.status < 200 || handled.status > 299) return _refused(handled);
      return `ok id=${found.id}`;
    }
    const left = deadline - io.now();
    if (left <= 0) return `failed reason=${REASON.NOT_DELIVERED}`;
    await io.sleep(Math.min(READ_INTERVAL_MS, left));
  }
}

/**
 * Carry out one `/soak-medusa` command and return its single result line.
 * Nothing reaches the switchboard unless this pane has an API origin and a
 * launch binding, and whoami confirms the route is this pane's own.
 * @param {object} cmd - From `parseMedusaLine`
 * @param {object} env - The environment to read the identity from
 * @param {{fetch: Function, now?: Function, sleep?: Function}} io - Network and clock
 * @returns {Promise<string>} The result line
 */
async function handleMedusa(cmd, env, io) {
  const clock = {
    fetch: io.fetch,
    now: typeof io.now === 'function' ? io.now : Date.now,
    sleep: typeof io.sleep === 'function' ? io.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
  const head = `${RESULT_PREFIX} ${cmd.nonce} ${cmd.verb}`;
  if (cmd.error) return `${head} failed reason=${cmd.error}`;
  const id = paneIdentity(env);
  if (!id.ok) return `${head} failed reason=${id.reason}`;
  const own = await _checkOwnRoute(clock, id, cmd.project);
  if (!own.ok) return `${head} failed reason=${own.reason}${own.state ? ` state=${own.state}` : ''}`;
  const tail = cmd.verb === 'send' ? await _send(clock, id, cmd) : await _read(clock, id, cmd);
  return `${head} ${tail}`;
}

/**
 * Run the stub against a pair of streams.
 * @param {NodeJS.ReadableStream} input - Where commands arrive
 * @param {NodeJS.WritableStream} output - Where answers go
 * @param {{env?: object, fetch?: Function, now?: Function, sleep?: Function}} [io] - Where a `/soak-medusa` call reads its identity and sends; defaults to this process
 * @returns {Promise<void>} Resolves when input ends or `/exit` arrives, and every switchboard call has printed its line
 */
function run(input, output, io = {}) {
  const env = io.env || process.env;
  const net = { fetch: io.fetch || globalThis.fetch, now: io.now, sleep: io.sleep };
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, terminal: false });
    const pending = new Set();
    let n = 0;
    let exited = false;
    output.write(`soak-stub ready\n${PROMPT}`);
    rl.on('line', (line) => {
      // readline still delivers lines it had already buffered after close(),
      // so without this flag input sent after /exit would be answered.
      if (exited) return;
      if (line.trim() === '/exit') {
        exited = true;
        rl.close();
        return;
      }
      const cmd = parseMedusaLine(line);
      if (cmd) {
        const p = handleMedusa(cmd, env, net).then((result) => output.write(`${result}\n${PROMPT}`));
        pending.add(p);
        p.finally(() => pending.delete(p));
        return;
      }
      n++;
      output.write(`${answer(n, line)}\n${PROMPT}`);
    });
    rl.on('close', () => Promise.all([...pending]).then(() => resolve()));
  });
}

if (require.main === module) {
  run(process.stdin, process.stdout).then(() => process.exit(0));
}

module.exports = { answer, run, parseMedusaLine, paneIdentity, handleMedusa, PROMPT, MEDUSA_COMMAND, RESULT_PREFIX, REASON, READ_WAIT_MS, REQUEST_TIMEOUT_MS };
