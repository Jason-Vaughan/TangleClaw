'use strict';

/**
 * HTTP executors for the soak's `api` and `engine` load classes (#2020).
 *
 * Each executor performs one scheduled event against the server under test and
 * resolves to an outcome; it never throws. The `browser` and `fault` classes
 * are not here: they act on the machine the driver runs on, so they live in
 * `lib/soak/browser.js` and `lib/soak/faults.js`, behind the local-control
 * guard in `lib/soak/local.js`. The driver refuses a schedule containing a
 * kind with no executor, so a missing executor can never silently turn into
 * a skipped fault.
 *
 * @module lib/soak/executors
 */

/** Per-request budget. A soak measures stability, so a hung call is an error, not a wait. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

/** The engine profile id the soak's stub engine registers as (`deploy/soak/stub-engine/`). */
const STUB_ENGINE_ID = 'soak-stub';

/** The project name the soak's port leases are recorded under. */
const LEASE_PROJECT = 'soak-harness';

/**
 * The plan file every `soak-*` project carries in `.tangleclaw/plans/`. The
 * plans load asserts it is listed and served, so provisioning must create it.
 */
const PLAN_FILE = 'soak-plan.md';

/**
 * How long each wait may take before it is recorded as a failure. A soak
 * measures stability, so each wait is bounded, and a run that never reaches
 * its state is an outcome, not a hang.
 * - `listenMs`: both switchboard listeners reaching `listening` after launch.
 * - `deliveryMs`: a sent message appearing in the recipient's inbox.
 * - `wrapMs`: a wrap run with its AI-content steps skipped reaching its end.
 * - `intervalMs`: the gap between two reads of the same state.
 */
const POLL = Object.freeze({
  listenMs: 60 * 1000,
  deliveryMs: 60 * 1000,
  wrapMs: 10 * 60 * 1000,
  intervalMs: 1000
});

/**
 * The wrap options the soak sends. The session ends with the run, and every
 * step that would ask the engine to write content is skipped: the stub engine
 * writes none, so waiting on it could only time out.
 */
const WRAP_OPTIONS = Object.freeze({
  keepSessionRunning: false,
  skipAiContent: Object.freeze({ 'changelog-update': true, 'release-recommendation': true, 'learnings-capture': true, 'memory-update': true })
});

/** Closed set of outcome codes an executor reports on failure. */
const OUTCOME = Object.freeze({
  OK: 'OK',
  HTTP_STATUS: 'HTTP_STATUS',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  BAD_BODY: 'BAD_BODY',
  FOREIGN_SESSION: 'FOREIGN_SESSION',
  REDIRECT_REFUSED: 'REDIRECT_REFUSED',
  NOT_LISTED: 'NOT_LISTED',
  FOREIGN_LINK: 'FOREIGN_LINK',
  NOT_LISTENING: 'NOT_LISTENING',
  NOT_DELIVERED: 'NOT_DELIVERED',
  WRAP_IN_PROGRESS: 'WRAP_IN_PROGRESS',
  WRAP_STRANDED: 'WRAP_STRANDED',
  WRAP_STALE: 'WRAP_STALE',
  WRAP_BLOCKED: 'WRAP_BLOCKED',
  WRAP_TIMEOUT: 'WRAP_TIMEOUT',
  WRAP_NOT_ENDED: 'WRAP_NOT_ENDED',
  // A resumed switchboard event whose send the server already recorded under
  // this run's request id: not a failed send, and not delivered again.
  SEND_ALREADY_ATTEMPTED: 'SEND_ALREADY_ATTEMPTED'
});

/**
 * Send one request and read its body as text. Every failure before a body is
 * in hand becomes an outcome, and a 3xx is never followed.
 * @param {object} ctx - `{apiBase, token, fetch, timeoutMs}`
 * @param {string} method - HTTP method
 * @param {string} path - Path on the target
 * @param {object} [body] - JSON body
 * @param {string} accept - The `accept` header
 * @returns {Promise<{fail: object}|{status: number, text: string}>} A failure outcome, or the status and body text
 */
async function _send(ctx, method, path, body, accept) {
  const headers = { accept };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;
  let res;
  try {
    res = await ctx.fetch(new URL(path, ctx.apiBase), {
      method,
      // Never follow a redirect. A target that passed every guard could
      // answer 307 and have fetch replay this request, method and body
      // included, to any host it names, the live install among them.
      redirect: 'manual',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.timeoutMs || REQUEST_TIMEOUT_MS)
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: every fetch failure becomes a recorded outcome, never a crash of the soak
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { fail: { ok: false, status: null, code: timedOut ? OUTCOME.TIMEOUT : OUTCOME.NETWORK, body: null } };
  }
  if (res.status >= 300 && res.status <= 399) {
    const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    return { fail: { ok: false, status: res.status, code: OUTCOME.REDIRECT_REFUSED, body: null, location } };
  }
  try {
    return { status: res.status, text: await res.text() };
  } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: a body cut off mid-read is a recorded outcome
    return { fail: { ok: false, status: res.status, code: OUTCOME.NETWORK, body: null } };
  }
}

/**
 * One HTTP call, reduced to an outcome. Only the status and a parsed JSON
 * body are kept; a soak log is evidence, so it must not grow by whatever a
 * route happens to return.
 * @param {object} ctx - `{apiBase, token, fetch, timeoutMs}`
 * @param {string} method - HTTP method
 * @param {string} path - Path beginning with `/api/`
 * @param {object} [body] - JSON body
 * @returns {Promise<{ok: boolean, status: number|null, code: string, body: *}>} Outcome
 */
async function call(ctx, method, path, body) {
  const sent = await _send(ctx, method, path, body, 'application/json');
  if (sent.fail) return sent.fail;
  const { status, text } = sent;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, status, code: OUTCOME.BAD_BODY, body: null };
  }
  if (status < 200 || status > 299) return { ok: false, status, code: OUTCOME.HTTP_STATUS, body: parsed };
  return { ok: true, status, code: OUTCOME.OK, body: parsed };
}

/**
 * Run a sequence of calls and stop at the first failure, which names the step
 * that failed. A later step never runs on a failed earlier one: releasing a
 * port that was never leased, or killing a session that never started, would
 * record a second error for the same fault.
 * @param {object} ctx - Call context
 * @param {Array<[string, string, object?]>} steps - `[method, path, body]` triples
 * @returns {Promise<{ok: boolean, code: string, status: number|null, step: number|null, steps: number}>} Outcome
 */
async function _sequence(ctx, steps) {
  for (let i = 0; i < steps.length; i++) {
    const r = await call(ctx, ...steps[i]);
    if (!r.ok) return { ok: false, code: r.code, status: r.status, step: i, steps: steps.length, ...(r.location !== undefined ? { location: r.location } : {}) };
  }
  return { ok: true, code: OUTCOME.OK, status: null, step: null, steps: steps.length };
}

/**
 * A single GET, as an executor.
 * @param {string} path - Route
 * @returns {(ctx: object) => Promise<object>} Executor
 */
function _get(path) {
  return async (ctx) => {
    const r = await call(ctx, 'GET', path);
    return { ok: r.ok, code: r.code, status: r.status, step: r.ok ? null : 0, steps: 1, ...(r.location !== undefined ? { location: r.location } : {}) };
  };
}

/**
 * A GET of a page that is not JSON, keeping only its status and byte length.
 * The page's content is not evidence of anything the soak judges, and the log
 * must not grow by it.
 * @param {object} ctx - Call context
 * @param {string} path - Path on the target
 * @returns {Promise<{ok: boolean, status: number|null, code: string, bytes: number|null}>} Outcome
 */
async function _readRaw(ctx, path) {
  const sent = await _send(ctx, 'GET', path, undefined, 'text/html');
  if (sent.fail) return { ok: sent.fail.ok, status: sent.fail.status, code: sent.fail.code, bytes: null, ...(sent.fail.location !== undefined ? { location: sent.fail.location } : {}) };
  const bytes = Buffer.byteLength(sent.text);
  if (sent.status !== 200) return { ok: false, status: sent.status, code: OUTCOME.HTTP_STATUS, bytes };
  return { ok: true, status: sent.status, code: OUTCOME.OK, bytes };
}

/**
 * Ask `probe` until it is done or the budget runs out, sleeping between
 * asks. Time is read from `ctx.now` and waited out with `ctx.sleep` when
 * given, so a test can run a whole budget without waiting for it.
 * @param {object} ctx - Call context, optionally with `now` and `sleep`
 * @param {number} budgetMs - How long the state may take to arrive
 * @param {() => Promise<{done: boolean}>} probe - One read; `done` ends the wait
 * @returns {Promise<{done: boolean, timedOut?: boolean}>} The last probe result, with `timedOut` when the budget ran out
 */
async function _poll(ctx, budgetMs, probe) {
  const now = typeof ctx.now === 'function' ? ctx.now : Date.now;
  const sleep = typeof ctx.sleep === 'function' ? ctx.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = now() + budgetMs;
  for (;;) {
    const r = await probe();
    if (r.done) return r;
    const left = deadline - now();
    if (left <= 0) return { ...r, timedOut: true };
    await sleep(Math.min(POLL.intervalMs, left));
  }
}

/**
 * The executors by event kind. Each takes `(ctx, params)`.
 * @type {Object<string, (ctx: object, params: object) => Promise<object>>}
 */
const EXECUTORS = Object.freeze({
  'api.health': _get('/api/health'),
  'api.server-info': _get('/api/server-info'),
  'api.projects.list': _get('/api/projects'),
  'api.ports.list': _get('/api/ports'),
  'api.ports.lease-release': (ctx, params) => _sequence(ctx, [
    ['POST', '/api/ports/lease', { port: params.port, host: 'localhost', project: LEASE_PROJECT, service: 'soak-load', permanent: false, ttl: 5 * 60 * 1000 }],
    ['POST', '/api/ports/release', { port: params.port, host: 'localhost', project: LEASE_PROJECT }]
  ]),
  'api.plans.read': plansRead,
  'api.medusa.reads': (ctx) => _sequence(ctx, [
    ['GET', '/api/medusa/deliveries'],
    ['GET', '/api/medusa/escalations']
  ]),
  'engine.session.cycle': engineSessionCycle,
  'engine.session.medusa-cycle': engineMedusaCycle,
  'engine.session.wrap-cycle': engineWrapCycle
});

/**
 * The session route for a project.
 * @param {string} project - Project name
 * @returns {string} `/api/sessions/<project>`, encoded
 */
function _sessionBase(project) {
  return `/api/sessions/${encodeURIComponent(project)}`;
}

/**
 * Make a project ready for a harness launch, touching only the harness's own
 * sessions.
 *
 * Every engine cycle asks for the project's session status first, because a
 * cycle that was in flight when the driver crashed runs again on resume, and
 * its session may still be up. What happens next depends on the answer:
 * - No active session: ready.
 * - An active session on the soak's own stub engine: that is a leftover from
 *   this harness, so it is killed (`preKilled: true`) and the project is ready.
 * - An active session on ANY other engine: it is not the harness's, so it is
 *   never touched. The guard fails with `FOREIGN_SESSION`.
 * - Status unreadable: the guard fails at that step and kills nothing, since
 *   it cannot tell whose session it would be killing.
 * @param {object} ctx - Call context
 * @param {string} project - Project name
 * @returns {Promise<{ok: true, preKilled: boolean}|{ok: false, code: string, status: number|null, step: string, foreignEngine?: string|null}>} Ready, or the failure
 */
async function _clearLeftover(ctx, project) {
  const base = _sessionBase(project);
  const status = await call(ctx, 'GET', `${base}/status`);
  if (!status.ok) return { ok: false, code: status.code, status: status.status, step: 'status' };
  if (!status.body || status.body.active !== true) return { ok: true, preKilled: false };
  if (status.body.engine !== STUB_ENGINE_ID) {
    return { ok: false, code: OUTCOME.FOREIGN_SESSION, status: null, step: 'status', foreignEngine: status.body.engine === undefined ? null : status.body.engine };
  }
  const pre = await call(ctx, 'DELETE', base, { reason: 'soak cycle: clear a leftover soak-stub session' });
  if (!pre.ok && pre.status !== 404) return { ok: false, code: pre.code, status: pre.status, step: 'pre-kill' };
  return { ok: true, preKilled: pre.ok };
}

/**
 * Launch a stub-engine session, inject commands, and kill it.
 *
 * The project is first made ready by `_clearLeftover`, which never touches a
 * session on another engine and launches nothing when it cannot tell whose
 * session is up.
 *
 * Once its own launch has succeeded, the final kill is always attempted, even
 * after a failed command, so one failure cannot leak a session into the rest
 * of the soak.
 * @param {object} ctx - Call context
 * @param {{project: string, commands: number}} params - Event params
 * @returns {Promise<object>} Outcome
 */
async function engineSessionCycle(ctx, params) {
  const base = _sessionBase(params.project);
  const commands = [];
  for (let i = 1; i <= params.commands; i++) commands.push(['POST', `${base}/command`, { command: `soak ping ${i}` }]);
  const total = commands.length + 2;

  const guard = await _clearLeftover(ctx, params.project);
  if (!guard.ok) return { ...guard, steps: total };
  const preNote = guard.preKilled ? { preKilled: true } : {};

  const launch = await call(ctx, 'POST', base, { engineOverride: STUB_ENGINE_ID, primePrompt: false });
  if (!launch.ok) return { ok: false, code: launch.code, status: launch.status, step: 0, steps: total, ...preNote };
  const middle = await _sequence(ctx, commands);
  const kill = await call(ctx, 'DELETE', base, { reason: 'soak cycle' });
  if (!middle.ok) {
    return { ok: false, code: middle.code, status: middle.status, step: middle.step + 1, steps: total, cleanupFailed: !kill.ok, ...preNote };
  }
  if (!kill.ok) return { ok: false, code: kill.code, status: kill.status, step: total - 1, steps: total, ...preNote };
  return { ok: true, code: OUTCOME.OK, status: null, step: null, steps: total, ...preNote };
}

/**
 * Read a project's plan listing, then fetch the soak plan's page.
 *
 * The listing must name `PLAN_FILE`, or the plans surface is not serving what
 * provisioning put there (`NOT_LISTED`). The page is then fetched by the
 * listing's own `urlPath`, which is HTML, so only its status and length are
 * kept. That path must resolve on the soak target itself: a listing that
 * pointed elsewhere would send the soak's token to another server, so such a
 * link is refused (`FOREIGN_LINK`) and never requested.
 * @param {object} ctx - Call context
 * @param {{project: string}} params - Event params
 * @returns {Promise<object>} Outcome, with the page's `bytes` when it was read
 */
async function plansRead(ctx, params) {
  const list = await call(ctx, 'GET', `/api/projects/${encodeURIComponent(params.project)}/plans`);
  if (!list.ok) return { ok: false, code: list.code, status: list.status, step: 0, steps: 2, ...(list.location !== undefined ? { location: list.location } : {}) };
  if (!list.body || !Array.isArray(list.body.plans)) return { ok: false, code: OUTCOME.BAD_BODY, status: list.status, step: 0, steps: 2 };
  const plan = list.body.plans.find((p) => p && p.file === PLAN_FILE);
  if (!plan) return { ok: false, code: OUTCOME.NOT_LISTED, status: list.status, step: 0, steps: 2 };
  let target;
  try {
    target = typeof plan.urlPath === 'string' ? new URL(plan.urlPath, ctx.apiBase) : null;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    target = null;
  }
  if (!target || target.origin !== new URL(ctx.apiBase).origin) {
    return { ok: false, code: OUTCOME.FOREIGN_LINK, status: null, step: 1, steps: 2 };
  }
  const page = await _readRaw(ctx, `${target.pathname}${target.search}`);
  const { ok, code, status, bytes } = page;
  return { ok, code, status, step: ok ? null : 1, steps: 2, bytes, ...(page.location !== undefined ? { location: page.location } : {}) };
}

/**
 * Kill the harness's sessions at the end of a cycle, one per project. Each
 * kill is attempted whatever the others did, so one failure cannot leak the
 * other session into the rest of the soak.
 * @param {object} ctx - Call context
 * @param {string[]} projects - Projects whose session to kill
 * @param {string} reason - Recorded kill reason
 * @param {string[]} [unlaunched] - Projects whose launch did not succeed; their session may never have existed, so a 404 there is clean
 * @returns {Promise<{ok: boolean, failed: {project: string, code: string, status: number|null}[]}>} Whether every kill succeeded
 */
async function _killAll(ctx, projects, reason, unlaunched = []) {
  const failed = [];
  for (const project of projects) {
    const k = await call(ctx, 'DELETE', _sessionBase(project), { reason });
    if (!k.ok && !(k.status === 404 && unlaunched.includes(project))) failed.push({ project, code: k.code, status: k.status });
  }
  return { ok: failed.length === 0, failed };
}

/**
 * The switchboard steps of a medusa cycle, once both sessions are up: wait
 * for both listeners, send from one to the other, wait for delivery, and mark
 * the message handled.
 * @param {object} ctx - Call context
 * @param {{from: string, to: string}} params - Event params
 * @returns {Promise<{ok: true, messageId: string}|{ok: false, code: string, status: number|null, step: string, project?: string, notListening?: string[]}>} Outcome of the middle steps
 */
async function _medusaExchange(ctx, params) {
  const { from, to } = params;
  const listening = new Map();
  let failure = null;
  const heard = await _poll(ctx, POLL.listenMs, async () => {
    for (const project of [from, to]) {
      if (listening.has(project)) continue;
      const s = await call(ctx, 'GET', `${_sessionBase(project)}/medusa/status`);
      if (!s.ok) {
        failure = { ok: false, code: s.code, status: s.status, step: 'listen', project };
        return { done: true };
      }
      if (s.body && s.body.state === 'listening') listening.set(project, s.body);
    }
    return { done: listening.size === 2 };
  });
  if (failure) return failure;
  if (heard.timedOut) {
    return { ok: false, code: OUTCOME.NOT_LISTENING, status: null, step: 'listen', notListening: [from, to].filter((p) => !listening.has(p)) };
  }
  const workspaceId = listening.get(to).workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return { ok: false, code: OUTCOME.BAD_BODY, status: null, step: 'listen', project: to };

  // The text and request id name the run and the event, so the hub's copy can
  // be traced back to the schedule. Request ids are unique across the whole
  // server, so the id is scoped to this run: another run against the same
  // target can never collide with it. A resumed event re-sends under its
  // earlier id, which the server refuses as already attempted rather than
  // sending twice; that is its own outcome, not a failed send.
  const tag = Number.isInteger(ctx.eventIndex) ? `event ${ctx.eventIndex}` : 'event';
  const message = { to: workspaceId, message: `soak medusa-cycle ${tag}: ${from} -> ${to}` };
  if (Number.isInteger(ctx.eventIndex) && typeof ctx.runKey === 'string' && /^[0-9a-f]{16}-[0-9]{1,16}$/.test(ctx.runKey)) {
    message.requestId = `soak-medusa-${ctx.runKey}-${ctx.eventIndex}`;
  }
  const sent = await call(ctx, 'POST', `${_sessionBase(from)}/medusa/send`, message);
  if (!sent.ok && sent.status === 409 && sent.body && sent.body.code === 'SEND_ALREADY_ATTEMPTED') {
    return { ok: false, code: OUTCOME.SEND_ALREADY_ATTEMPTED, status: sent.status, step: 'send', project: from };
  }
  if (!sent.ok) return { ok: false, code: sent.code, status: sent.status, step: 'send', project: from };
  const id = sent.body && sent.body.id;
  if (typeof id !== 'string' || id.length === 0) return { ok: false, code: OUTCOME.BAD_BODY, status: sent.status, step: 'send', project: from };

  const delivered = await _poll(ctx, POLL.deliveryMs, async () => {
    const inbox = await call(ctx, 'GET', `${_sessionBase(to)}/medusa/messages`);
    if (!inbox.ok) {
      failure = { ok: false, code: inbox.code, status: inbox.status, step: 'deliver', project: to };
      return { done: true };
    }
    const messages = inbox.body && Array.isArray(inbox.body.messages) ? inbox.body.messages : [];
    return { done: messages.some((m) => m && m.id === id) };
  });
  if (failure) return failure;
  if (delivered.timedOut) return { ok: false, code: OUTCOME.NOT_DELIVERED, status: null, step: 'deliver', project: to };

  const read = await call(ctx, 'POST', `${_sessionBase(to)}/medusa/read`, { ids: [id] });
  if (!read.ok) return { ok: false, code: read.code, status: read.status, step: 'read', project: to };
  return { ok: true, messageId: id };
}

/**
 * Launch two stub-engine sessions, send a switchboard message from one to the
 * other, see it delivered and handled, then kill both.
 *
 * Both projects pass `_clearLeftover` before anything launches. Once a launch
 * has succeeded, both sessions are killed at the end whatever failed between,
 * and a failed kill is reported (`cleanupFailed`). Killing the recipient
 * retires the exchange, so the message needs no reply and no close.
 * @param {object} ctx - Call context, optionally with `eventIndex`, `now` and `sleep`
 * @param {{from: string, to: string}} params - Event params
 * @returns {Promise<object>} Outcome
 */
async function engineMedusaCycle(ctx, params) {
  const steps = 7;
  const projects = [params.from, params.to];
  const preKilled = [];
  for (const project of projects) {
    const guard = await _clearLeftover(ctx, project);
    if (!guard.ok) return { ...guard, steps, project, ...(preKilled.length ? { preKilled } : {}) };
    if (guard.preKilled) preKilled.push(project);
  }
  const preNote = preKilled.length ? { preKilled } : {};

  let middle = null;
  let launched = 0;
  for (const project of projects) {
    const launch = await call(ctx, 'POST', _sessionBase(project), { engineOverride: STUB_ENGINE_ID, primePrompt: false });
    if (!launch.ok) {
      middle = { ok: false, code: launch.code, status: launch.status, step: 'launch', project };
      break;
    }
    launched++;
  }
  if (launched === 0) return { ...middle, steps, ...preNote };
  if (!middle) middle = await _medusaExchange(ctx, params);

  // A launch that failed may still have started its session, so both are
  // killed; only the one that never launched may already be gone.
  const kill = await _killAll(ctx, projects, 'soak medusa cycle', projects.slice(launched));
  if (!middle.ok) return { ...middle, steps, cleanupFailed: !kill.ok, ...preNote };
  if (!kill.ok) return { ok: false, code: kill.failed[0].code, status: kill.failed[0].status, step: 'kill', steps, project: kill.failed[0].project, messageId: middle.messageId, ...preNote };
  return { ok: true, code: OUTCOME.OK, status: null, step: null, steps, messageId: middle.messageId, ...preNote };
}

/**
 * Wait for the wrap run `runId` to finish, and judge what it did.
 * @param {object} ctx - Call context
 * @param {string} base - The project's session route
 * @param {string} runId - The run the 202 named
 * @returns {Promise<{ok: boolean, code: string, status: number|null, step: string, ended: boolean, blockedAt?: string}>} Outcome, with whether the run ended the session
 */
async function _awaitWrap(ctx, base, runId) {
  let failure = null;
  let last = null;
  const settled = await _poll(ctx, POLL.wrapMs, async () => {
    const s = await call(ctx, 'GET', `${base}/wrap/status`);
    if (!s.ok) {
      failure = { ok: false, code: s.code, status: s.status, step: 'wrap-status', ended: false };
      return { done: true };
    }
    // A status naming another run says nothing about this one, whatever it reports.
    if (!s.body || s.body.runId !== runId) return { done: false };
    last = s.body;
    return { done: s.body.stale === true || (s.body.finishedAt !== null && s.body.finishedAt !== undefined) };
  });
  if (failure) return failure;
  if (settled.timedOut) return { ok: false, code: OUTCOME.WRAP_TIMEOUT, status: null, step: 'wrap-status', ended: false };
  if (last.stale === true) return { ok: false, code: OUTCOME.WRAP_STALE, status: null, step: 'wrap-status', ended: false };
  const result = last.result && typeof last.result === 'object' ? last.result : {};
  const ended = result.sessionOutcome === 'ended';
  // `result.status` reads 'wrapping' on success, so success is read from the
  // run's own verdict and its pipeline's.
  if (!(result.ok === true && result.pipelineResult && result.pipelineResult.ok === true)) {
    const blockedAt = result.pipelineResult && result.pipelineResult.blockedAt;
    return { ok: false, code: OUTCOME.WRAP_BLOCKED, status: null, step: 'wrap-status', ended, ...(blockedAt ? { blockedAt } : {}) };
  }
  if (!ended) return { ok: false, code: OUTCOME.WRAP_NOT_ENDED, status: null, step: 'wrap-status', ended };
  return { ok: true, code: OUTCOME.OK, status: null, step: null, ended };
}

/**
 * Launch a stub-engine session and wrap it, with every AI-content step
 * skipped, so the wrap pipeline itself runs under load.
 *
 * The project first passes `_clearLeftover`. The run must be the one the 202
 * named, must succeed, and must end the session. The session is killed
 * afterwards only when the run did not end it. A `WRAP_IN_PROGRESS` refusal
 * means another run owns the session, so the cycle leaves it alone.
 * @param {object} ctx - Call context, optionally with `now` and `sleep`
 * @param {{project: string}} params - Event params
 * @returns {Promise<object>} Outcome
 */
async function engineWrapCycle(ctx, params) {
  const steps = 4;
  const base = _sessionBase(params.project);
  const guard = await _clearLeftover(ctx, params.project);
  if (!guard.ok) return { ...guard, steps };
  const preNote = guard.preKilled ? { preKilled: true } : {};

  const launch = await call(ctx, 'POST', base, { engineOverride: STUB_ENGINE_ID, primePrompt: false });
  if (!launch.ok) return { ok: false, code: launch.code, status: launch.status, step: 'launch', steps, ...preNote };

  const wrap = await call(ctx, 'POST', `${base}/wrap`, { options: WRAP_OPTIONS });
  const refusal = wrap.status === 409 && wrap.body ? wrap.body.code : null;
  if (refusal === 'WRAP_IN_PROGRESS') {
    return { ok: false, code: OUTCOME.WRAP_IN_PROGRESS, status: 409, step: 'wrap', steps, ...(typeof wrap.body.runId === 'string' ? { runId: wrap.body.runId } : {}), ...preNote };
  }
  let outcome;
  let runId = null;
  if (!wrap.ok) {
    outcome = { ok: false, code: refusal === 'STRANDED_WRAPS' ? OUTCOME.WRAP_STRANDED : wrap.code, status: wrap.status, step: 'wrap', ended: false };
  } else if (wrap.status !== 202 || !wrap.body || typeof wrap.body.runId !== 'string') {
    outcome = { ok: false, code: wrap.status !== 202 ? OUTCOME.HTTP_STATUS : OUTCOME.BAD_BODY, status: wrap.status, step: 'wrap', ended: false };
  } else {
    runId = wrap.body.runId;
    outcome = await _awaitWrap(ctx, base, runId);
  }

  const { ended, ...result } = outcome;
  const ids = runId ? { runId } : {};
  if (ended) return { ...result, steps, ...ids, ...preNote };
  // A run that did not end the session never succeeded, so `result` is a
  // failure here, and the kill only adds whether the cleanup held.
  const kill = await _killAll(ctx, [params.project], 'soak wrap cycle');
  return { ...result, steps, ...ids, cleanupFailed: !kill.ok, ...preNote };
}

// The session helpers are shared with the fault and browser executors
// (`lib/soak/faults.js`, `lib/soak/browser.js`), so every cycle that launches
// a session clears leftovers and polls the same way.
module.exports = { EXECUTORS, OUTCOME, STUB_ENGINE_ID, LEASE_PROJECT, PLAN_FILE, POLL, WRAP_OPTIONS, REQUEST_TIMEOUT_MS, call, sessionBase: _sessionBase, clearLeftover: _clearLeftover, poll: _poll };
