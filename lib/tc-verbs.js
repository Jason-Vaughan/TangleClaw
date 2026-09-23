'use strict';


/**
 * The `tc` verb roster (ambient-awareness Chunk 03).
 *
 * Every verb the in-pane CLI speaks is a DECLARED ROSTER ENTRY here — the same
 * pattern as `lib/ecosystem-primer.js`'s ECOSYSTEM_ROSTER, extended rather than
 * duplicated in spirit: adding the next capability is one entry (id, usage,
 * summary, run), not dispatcher surgery. `bin/tc` stays the thin executable —
 * it validates the environment, builds the HTTP context, and dispatches
 * through this roster; everything renderable and decidable lives here where
 * in-process tests can reach it without spawning a child.
 *
 * Failure honesty is the roster's one law, inherited from the plan this
 * surface exists for: every verb fails loudly, no silent no-ops, no empty
 * success. An empty inbox says "empty"; a disabled switchboard says you CANNOT
 * message and why; a send to an unregistered peer surfaces the server's words.
 * A surface that only ever describes success teaches an agent to invent one.
 *
 * Exit-code contract (recorded in `.prawduct/artifacts/api-contract.md`):
 *   0 — the question was answered, honest emptiness/absence included
 *   1 — usage or environment (unknown verb, bad args, pane not under TC)
 *   2 — the server was unreachable, answered an error, or the action failed
 *
 * @module lib/tc-verbs
 */

const { renderPage } = require('./launch-page');

/**
 * The HTTP + environment context `bin/tc` hands every verb.
 * @typedef {object} TcContext
 * @property {string} api - The API origin (e.g. `http://localhost:3102`)
 * @property {object} env - Relevant environment (TANGLECLAW_PROJECT_ID, TANGLECLAW_WORKSPACE_ID)
 * @property {string[]} argv - Arguments after the verb name
 * @property {(path: string) => Promise<object>} getJson - GET a JSON API path; throws HttpError
 * @property {(path: string, body: object) => Promise<object>} postJson - POST JSON; throws HttpError
 */

/**
 * One verb's outcome — `bin/tc` writes the streams and exits with the code.
 * @typedef {object} TcResult
 * @property {number} code - Process exit code (0 usage above)
 * @property {string} [stdout] - Rendered answer
 * @property {string} [stderr] - Rendered failure/usage text
 */

/**
 * Build the identity query string from the pane environment.
 * @param {object} env - Environment vars
 * @returns {string} `?projectId=…&workspaceId=…`, or ''
 */
function identityQuery(env) {
  const params = new URLSearchParams();
  if (env.TANGLECLAW_PROJECT_ID) params.set('projectId', env.TANGLECLAW_PROJECT_ID);
  if (env.TANGLECLAW_WORKSPACE_ID) params.set('workspaceId', env.TANGLECLAW_WORKSPACE_ID);
  // The role rides the x-tangleclaw-role header bin/tc already sends on every
  // call — one channel per client. (The route also reads ?role= so a hand
  // curl can exercise the master answer without forging headers.)
  return params.size ? `?${params}` : '';
}

/**
 * Fetch this pane's identity (the whoami answer). Verbs that need the project
 * NAME use this — the switchboard routes address by name, the env carries only
 * the numeric id, and guessing the name is the #1121 trap in reverse.
 * @param {TcContext} ctx
 * @param {object} [opts]
 * @param {boolean} [opts.aux] - This fetch is a mid-verb side lookup, not the
 *   invocation itself: marked so the server does not record a second receipt
 * @returns {Promise<object>} The /api/tc/whoami response body
 */
function fetchIdentity(ctx, opts = {}) {
  return ctx.getJson(`/api/tc/whoami${identityQuery(ctx.env)}`, opts);
}

/**
 * Render the whoami response as plain text for the pane.
 * @param {object} d - The /api/tc/whoami response body
 * @returns {string}
 */
function renderWhoami(d) {
  const lines = [];
  if (d.role === 'master') {
    lines.push('You are the TangleClaw Project Master — the fleet-wide read surface, not a project session.');
  } else if (d.project) {
    lines.push(`You are a TangleClaw-managed session of project "${d.project.name}" (numeric project id ${d.project.id}).`);
  } else {
    lines.push('You are running under TangleClaw, but your identity did not resolve:');
    lines.push(`  ${d.unresolved}`);
  }
  if (d.sessionId) lines.push(`Session id: ${d.sessionId}`);
  lines.push(`TangleClaw API (for your own calls from this host): ${d.api.origin}`);
  // A null host is the honest "could not establish" answer, and the note already
  // says so in full — printing `Operator host: null` beside it just adds a
  // fabricated-looking value the agent may copy.
  lines.push(d.operator.host
    ? `Operator host: ${d.operator.host} — ${d.operator.note}`
    : `Operator host: unknown — ${d.operator.note}`);
  lines.push('');
  lines.push(renderCapabilities(d));
  return lines.join('\n');
}

/**
 * Render just the capability roster from a whoami response — enabled and
 * disabled alike, each disabled row carrying its reason (Direction §3:
 * absence is reported, never omitted).
 * @param {object} d - The /api/tc/whoami response body
 * @returns {string}
 */
function renderCapabilities(d) {
  const lines = ['Capabilities:'];
  for (const cap of d.capabilities || []) {
    lines.push(`  [${cap.enabled ? 'ok' : '--'}] ${cap.id}: ${cap.detail}`);
  }
  if ((d.capabilities || []).length === 0) {
    lines.push('  (the server reported NO capabilities — that is its answer, not a rendering gap)');
  }
  return lines.join('\n') + '\n';
}

/**
 * Render the fleet's checkouts (`GET /api/checkouts`): the scope, then each
 * live project's summary sentences. `scope: 'none'` is an answer, with the
 * reason the caller sees no rows; an empty fleet says so rather than printing
 * nothing. A refused binding never reaches here: the API answers an error, and
 * `bin/tc` reports it and exits nonzero.
 * @param {{scope: string, reason: (string|null), observedAt: string, rows: object[]}} d
 * @returns {string}
 */
function renderFreshness(d) {
  const lines = [];
  if (d.scope === 'none') {
    lines.push(`No checkouts visible: ${d.reason || 'the server gave no reason'}`);
    return lines.join('\n') + '\n';
  }
  lines.push(d.scope === 'fleet'
    ? `Checkouts of every live session (read ${d.observedAt}):`
    : `Checkouts of your project and its project groups' live sessions (read ${d.observedAt}):`);
  const rows = d.rows || [];
  if (rows.length === 0) {
    lines.push('  (no live session is visible to you — that is the answer, not a rendering gap)');
  }
  for (const row of rows) {
    lines.push(`- ${row.project.name} (session ${row.sessionId}):`);
    const summary = row.checkout && Array.isArray(row.checkout.summary) ? row.checkout.summary : ['Checkout: unknown — not read.'];
    for (const sentence of summary) lines.push(`    ${sentence}`);
  }
  lines.push('Informational only: nothing here authorizes a pull, a checkout or a restart.');
  return lines.join('\n') + '\n';
}

/**
 * Render the fleet session list.
 * @param {object} d - The /api/tc/sessions response body
 * @param {object} env - Pane environment (to mark the caller's own project)
 * @returns {string}
 */
function renderSessions(d, env) {
  const sessions = d.sessions || [];
  if (sessions.length === 0) {
    return 'No live TangleClaw sessions right now — the fleet is idle, not unreachable.\n';
  }
  const ownProjectId = env.TANGLECLAW_PROJECT_ID ? Number(env.TANGLECLAW_PROJECT_ID) : null;
  const lines = [`${sessions.length} live TangleClaw session(s):`];
  for (const s of sessions) {
    const own = ownProjectId !== null && s.projectId === ownProjectId ? '  ← your project' : '';
    lines.push(`  #${s.id} ${s.projectName || '(unknown project)'} — engine ${s.engineId || '?'}, ${s.status}, started ${s.startedAt}${own}`);
  }
  lines.push('');
  lines.push('Messaging a session goes through the switchboard: `tc message send <workspace-id> <text>` (see `tc capabilities` for whether yours is enabled).');
  return lines.join('\n') + '\n';
}

/**
 * Render the port lease registry.
 * @param {object} d - The /api/ports response body
 * @returns {string}
 */
function renderPorts(d) {
  const leases = d.leases || [];
  if (leases.length === 0) {
    return 'No ports are currently leased in PortHub. Register before binding: POST /api/ports/lease {"port","project","service","reach"}.\n';
  }
  const lines = [`${leases.length} port lease(s):`];
  for (const l of leases) {
    const host = l.host && l.host !== 'localhost' ? `${l.host}:` : '';
    // `reach` is shown for every lease, including the default. An agent reading
    // this is the party that DECLARES it, and a field only visible once it is
    // non-default is a field nobody learns exists.
    const reach = ` reach:${l.reach || 'loopback'}`;
    lines.push(`  ${host}${l.port} — ${l.project} (${l.service})${reach}${l.permanent ? ' [permanent]' : ''}`);
  }
  lines.push('');
  lines.push('Claiming a port another project holds returns 409 — pick another in the same range.');
  // The vocabulary is spelled literally here, and that is a decision rather
  // than an oversight. Deriving it from `store.LEASE_REACHES` would be the
  // obvious single-owner move, but this module is deliberately dependency-free
  // and `bin/tc` is its only executable: `lib/store.js` requires `node:sqlite`
  // at module scope, which prints an ExperimentalWarning to stderr on load, so
  // the import would put a Node warning in front of an agent on every `tc`
  // verb — in the one surface whose stated law is honest, uncluttered output.
  // A third prose copy of three words costs less than that. If the set ever
  // widens, this line and `data/porthub-guide.md` are the two to update.
  lines.push('reach declares how far a service is MEANT to be reachable (loopback|tailnet|lan, '
    + 'default loopback). Omitting it means loopback on EVERY write, renewals included.');
  return lines.join('\n') + '\n';
}

/**
 * Render the shared-documents listing.
 * @param {object} d - The /api/shared-docs response body
 * @returns {string}
 */
function renderDocs(d) {
  const docs = d.docs || [];
  if (docs.length === 0) {
    // The server answers a project pane with its own groups only, so an empty
    // list says nothing about other groups on the install.
    return 'No shared documents in the groups this pane may read. A project pane sees only the groups '
      + 'its project belongs to, so other groups may hold documents this answer does not show.\n';
  }
  const lines = [`${docs.length} shared document(s):`];
  for (const doc of docs) {
    lines.push(`  ${doc.name} (id ${doc.id}, group ${doc.groupId}) — ${doc.filePath}`);
  }
  lines.push('');
  lines.push('Lock before editing a document\'s contents (POST /api/shared-docs/<id>/lock), unlock after.');
  return lines.join('\n') + '\n';
}

/**
 * Render the project's session rules, review state included — a proposed rule
 * is visible but explicitly not in force, because an agent that cannot see the
 * approval gate will conclude its proposal vanished.
 * @param {object} d - The /api/session-rules response body
 * @returns {string}
 */
function renderRules(d) {
  const rules = d.rules || [];
  if (rules.length === 0) {
    return 'This project has NO session rules — no hidden governance is being withheld from you. Propose one: POST /api/session-rules (AI proposals await operator approval).\n';
  }
  const lines = [`${rules.length} session rule(s) for this project:`];
  for (const r of rules) {
    const state = r.status === 'active' ? (r.enabled ? 'active' : 'active but DISABLED') : r.status.toUpperCase();
    lines.push(`  [#${r.id} ${r.kind} — ${state}] ${r.content}`);
  }
  lines.push('');
  lines.push("Only enabled rules with status 'active' are in force; PROPOSED rows await operator approval.");
  return lines.join('\n') + '\n';
}

/**
 * Render the project's recorded learnings.
 * @param {object} d - The /api/learnings response body
 * @returns {string}
 */
function renderLearnings(d) {
  const learnings = d.learnings || [];
  if (learnings.length === 0) {
    return 'No learnings are recorded for this project yet. Record recurring facts as dated entries in `.tangleclaw/memories/learnings.md`; TangleClaw mirrors them here.\n';
  }
  const lines = [`${learnings.length} recorded learning(s):`];
  for (const l of learnings) {
    lines.push(`  [tier ${l.tier}, seen ${l.confirmedCount}×] ${l.content}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Render the received inbox. Pure read — nothing is marked handled by looking.
 * The empty-inbox claim is only honest because the caller (runMessage 'read')
 * verifies the listener is actually running before rendering emptiness — a
 * stopped listener and an empty inbox answer identically at the producer.
 * @param {object} d - The medusa /messages response body
 * @returns {string}
 */
function renderInbox(d) {
  const messages = d.messages || [];
  if (messages.length === 0) {
    return 'Your switchboard inbox is empty — genuinely empty, not unreachable.\n';
  }
  const lines = [`${messages.length} message(s) in your inbox:`];
  for (const m of messages) {
    lines.push(`  [${m.id}] from ${m.from}: ${m.message ?? m.text ?? ''}`);
  }
  lines.push('');
  lines.push('Reading does NOT mark these handled. After acting on one: `tc message ack <id> [<id>…]` — the sender stays blocked until you reply and ack.');
  return lines.join('\n') + '\n';
}

/**
 * Render a peer's reachability answer. A peer this host cannot see is said to
 * be unseeable — never described as reachable or unreachable.
 *
 * The meaning printed beside the code is the server's `meaning` field, which
 * `lib/medusa-wake.js#PEER_REASON_MEANINGS` declares next to the code that
 * produces it. It is read off the response rather than required from that
 * module, for two reasons: this module is deliberately dependency-free (see
 * `renderPorts`), and an agent that follows its prime to the raw route and
 * one that runs `tc message status` must read the same words — a copy here is
 * how they drifted apart. A code the server gives no meaning for is relayed
 * exactly as given.
 * @param {object} d - The medusa /peers/:workspaceId response body
 * @returns {string}
 */
function renderPeerStatus(d) {
  if (!d.local) {
    return `${d.workspaceId} is not a TangleClaw session on this host, so its pane is not visible from here `
      + 'and there is no verdict to give. Your send result (received or queued) is all that is known.\n';
  }
  const meaning = typeof d.meaning === 'string' && d.meaning
    ? d.meaning
    : 'no description for this code — the server\'s answer stands as given';
  const lines = [`${d.workspaceId} (a TangleClaw session on this host): ${d.reason} — ${meaning}.`];
  if (d.observedAt) lines.push(`Observed ${d.observedAt}; this has been the verdict since ${d.since}.`);
  if (!d.monitorRunning) {
    lines.push('The wake monitor is not running, so this verdict is not being refreshed — treat it as stale.');
  }
  return lines.join('\n') + '\n';
}

/**
 * A verb that needs the project's registered name resolves it via whoami and
 * fails LOUDLY when identity does not resolve — improvising a project name is
 * exactly the guessing this CLI exists to end.
 * @param {TcContext} ctx
 * @returns {Promise<{name: string}|{error: TcResult}>}
 */
async function requireProjectName(ctx) {
  const identity = await fetchIdentity(ctx, { aux: true });
  if (!identity.project) {
    return {
      error: {
        code: 2,
        stderr: 'tc: this pane\'s identity did not resolve to a registered project '
          + `(${identity.unresolved}) — switchboard verbs need one. `
          + 'Do not guess a project name; tell the operator identity resolution failed.\n'
      }
    };
  }
  return { name: identity.project.name };
}

/**
 * The `tc message` verb family: send | read | ack | status.
 * @param {TcContext} ctx
 * @returns {Promise<TcResult>}
 */
async function runMessage(ctx) {
  const sub = ctx.argv[0];
  const usage = 'usage: tc message send <workspace-id> <text…> | tc message read | tc message ack <id> [<id>…] | tc message status <workspace-id>\n';
  if (!sub || !MESSAGE_SUBVERBS.includes(sub)) {
    return { code: 1, stderr: `tc: message needs a subverb.\n${usage}` };
  }
  // Argument validation runs BEFORE the identity fetch: a usage error is the
  // caller's to fix locally and must not cost (or depend on) a network call.
  const to = ctx.argv[1];
  const text = ctx.argv.slice(2).join(' ');
  if (sub === 'send' && (!to || !text)) {
    return { code: 1, stderr: `tc: send needs a recipient and a message.\n${usage}` };
  }
  const ids = ctx.argv.slice(1);
  if (sub === 'ack' && ids.length === 0) {
    return { code: 1, stderr: `tc: ack needs at least one message id.\n${usage}` };
  }
  if (sub === 'status' && !to) {
    return { code: 1, stderr: `tc: status needs the workspace id of the peer to check.\n${usage}` };
  }

  const resolved = await requireProjectName(ctx);
  if (resolved.error) return resolved.error;
  const base = `/api/sessions/${encodeURIComponent(resolved.name)}/medusa`;

  if (sub === 'send') {
    const result = await ctx.postJson(`${base}/send`, { to, message: text });
    // The server's answer is already honest — `received` (delivered live) or
    // `queued` (recipient offline) — relay it rather than flattening to "sent".
    // A retargeted send (#1023) refreshed a stale workspace handle server-side;
    // relay the new handle too, or the agent keeps addressing the dead one.
    const retarget = result.retargetedFrom
      ? ` Your handle ${result.retargetedFrom} was stale — the message went to ${result.to}; use that id from now on.`
      : '';
    return {
      code: 0,
      stdout: `Message to ${result.to || to}: ${result.status || JSON.stringify(result)}.${retarget} `
        + 'You initiated this exchange — you close it: ack the reply when it lands.\n'
    };
  }
  if (sub === 'status') {
    const data = await ctx.getJson(`${base}/peers/${encodeURIComponent(to)}`);
    return { code: 0, stdout: renderPeerStatus(data) };
  }
  if (sub === 'read') {
    const data = await ctx.getJson(`${base}/messages`);
    // An empty list is ambiguous at the producer: a truly empty inbox and a
    // stopped listener answer identically. Consult the listener state before
    // claiming emptiness — reporting "no mail" over a severed channel is the
    // invented success this surface exists to end.
    if ((data.messages || []).length === 0) {
      const status = await ctx.getJson(`${base}/status`, { aux: true });
      // Anything short of 'listening' leaves Hub-side mail invisible from
      // here — an `error` or `connecting` window renders emptiness exactly as
      // a stopped listener does, so only a LIVE listener proves an empty
      // inbox is empty.
      if (status.state !== 'listening') {
        return {
          code: 2,
          stderr: (status.state === 'off'
            ? 'tc: your switchboard listener is not running, so your mail (if any) is not visible from here'
            : `tc: your switchboard listener is not listening (state: ${status.state}), so your mail (if any) is not visible from here`)
            + ' — an empty view proves nothing. Report the listener state rather than an empty inbox.\n'
        };
      }
    }
    return { code: 0, stdout: renderInbox(data) };
  }
  // ack (ids validated above). The route is a silent no-op with no live
  // listener and ignores unknown ids, so the success claim is limited to what
  // the response proves: the listener state it returns. Only 'listening'
  // proves the handled-report reached the Hub — with no listener nothing was
  // marked at all, and through an error/connecting listener the local inbox
  // may drop the mail while the Hub keeps its durable copy.
  const ackStatus = await ctx.postJson(`${base}/read`, { ids });
  if (ackStatus && ackStatus.state !== 'listening') {
    return {
      code: 2,
      stderr: ackStatus.state === 'off'
        ? 'tc: no switchboard listener is running for this project — NOTHING was marked handled. '
          + 'Say so rather than reporting an ack.\n'
        : `tc: your switchboard listener is not listening (state: ${ackStatus.state}) — the handled-report `
          + 'cannot be confirmed to have reached the Hub, so treat these messages as still unhandled. '
          + 'Report the listener state rather than an ack.\n'
    };
  }
  return { code: 0, stdout: `Reported ${ids.length} message id(s) handled — they leave your inbox (ids it does not contain are ignored).\n` };
}

/**
 * Require the pane's numeric project id, or fail loudly.
 * @param {TcContext} ctx
 * @returns {{projectId: string}|{error: TcResult}}
 */
function requireProjectId(ctx) {
  const projectId = ctx.env.TANGLECLAW_PROJECT_ID;
  if (!projectId) {
    return {
      error: {
        code: 1,
        stderr: 'tc: TANGLECLAW_PROJECT_ID is not set — this verb is project-scoped and the pane '
          + 'carries no project identity. Say so rather than guessing an id.\n'
      }
    };
  }
  return { projectId };
}

/** The `tc message` subverbs, in help order. */
const MESSAGE_SUBVERBS = ['send', 'read', 'ack', 'status'];

/** The `tc start` subverbs, in help order (Train 21). */
const START_SUBVERBS = ['next', 'ready', 'status'];

/**
 * How long `tc start` keeps retrying a launch id the server has not bound yet,
 * and how long it waits when the server does not say.
 *
 * The pane can reach the server before the launch has finished recording its
 * session row. Ten seconds is far longer than that gap and short enough that a
 * launch which never recorded fails visibly instead of hanging.
 */
const LAUNCH_BIND_WAIT_MS = 10000;
const LAUNCH_BIND_RETRY_MS = 500;

/**
 * Sleep, as a promise. Replaceable through the context so a test does not wait
 * out a real retry window.
 * @param {TcContext} ctx
 * @param {number} ms - Milliseconds
 * @returns {Promise<void>}
 */
function _sleep(ctx, ms) {
  if (typeof ctx.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the server, retrying only `LAUNCH_NOT_BOUND` — the one refusal that is
 * expected to resolve by itself. Every other failure is the server's answer and
 * is relayed as it stands.
 *
 * The deadline is measured on a clock, not counted in attempts: the server
 * chooses each wait, so only elapsed time bounds the retrying. `ctx.now` is the
 * seam that lets a test drive that clock instead of waiting out the window.
 * @param {TcContext} ctx
 * @param {() => Promise<object>} attempt - One request
 * @returns {Promise<object>} The response body
 */
async function _awaitBinding(ctx, attempt) {
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const deadline = now() + LAUNCH_BIND_WAIT_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const body = err.body || {};
      if (body.code !== 'LAUNCH_NOT_BOUND') throw err;
      const wait = Number.isInteger(body.retryAfterMs) ? body.retryAfterMs : LAUNCH_BIND_RETRY_MS;
      if (now() + wait > deadline) {
        const unknown = new Error(
          `this pane's launch is still not recorded after ${Math.round(LAUNCH_BIND_WAIT_MS / 1000)}s. `
          + 'Its session was never written, so there is no launch sequence to read. '
          + 'Say so rather than improvising the context you did not receive'
        );
        unknown.code = 'LAUNCH_UNKNOWN';
        throw unknown;
      }
      await _sleep(ctx, wait);
    }
  }
}

/**
 * Render what `tc start status` answered.
 * @param {object} d - The /api/tc/start/status response body
 * @returns {string}
 */
function renderStartStatus(d) {
  if (d.sequence === 'none') {
    return `No launch sequence: ${d.reason}.\nYour context arrived in this session's prime; there is nothing to pull.\n`;
  }
  if (d.applicability === 'not-applicable') {
    return `No launch sequence for this session: ${d.notApplicableReason}.\n`;
  }
  const lines = [
    `Launch sequence ${d.sequenceId} (session ${d.sessionId}, revision ${d.revision}): `
      + `${d.status.cursor} of ${d.steps.length} step(s) acknowledged.`,
    `Preflight: ${d.preflight ? d.preflight.verdict : 'unknown'}.`
  ];
  // Whether the page size rests on a measurement or on the conservative
  // default. An assumed limit is the case a reader has to know about: pages
  // sized against a guess can still be truncated by the engine.
  if (d.toolOutput) {
    lines.push(d.toolOutput.measured
      ? `Pages are sized to ${d.pageBudget} characters, against this engine's measured ${d.toolOutput.maxChars}-character tool-output limit.`
      : `Pages are sized to ${d.pageBudget} characters, against an ASSUMED ${d.toolOutput.maxChars}-character tool-output limit — ${d.toolOutput.reason}. If a page arrives cut short, say so rather than guessing what was in it.`);
  }
  // The reason alone once the list is empty. "Not in this version: " with
  // nothing after it reads as a truncated sentence, and the whole point of the
  // field is to say plainly which of the two a reader is looking at — a stage
  // that has not shipped, or none left.
  if (d.pending && d.pending.stages && d.pending.stages.length > 0) {
    lines.push(`Not in this version: ${d.pending.stages.join(', ')} — ${d.pending.reason}.`);
  } else if (d.pending) {
    lines.push(`Nothing is pending: ${d.pending.reason}.`);
  }
  // The recovery state, whenever it is not `none`. A session in operator-mode
  // recovery is the reader most in need of this: `tc start next` has told it the
  // task step is withheld, and `status` is where it looks to find out whether
  // anything has changed since. Saying nothing here left it reading a status
  // that mentioned no obstacle at all.
  if (d.status && d.status.recovery && d.status.recovery !== 'none') {
    const verdict = d.preflight ? d.preflight.verdict : 'unknown';
    if (d.status.recovery === 'required' && d.status.recoveryMode === 'advisory') {
      lines.push(`Recovery required (${verdict}), advisory: the task step is served with a warning, and READY `
        + 'needs a written reconciliation — pass --reconciliation.');
    } else if (d.status.recovery === 'required') {
      lines.push(`Recovery required (${verdict}), operator-cleared: the task step is withheld and READY is refused `
        + `until the operator clears it from Settings → Project Rules → Launch readiness (recovery revision `
        + `${d.status.recoveryRevision}). Tell them; nothing you can run opens it.`);
    } else {
      lines.push(`Recovery: cleared.`);
    }
  }
  // Said only when it is missing. A snapshot with no recorded render context
  // re-renders from what is knowable at the time if the rules change under it,
  // which can be thinner than what was first served — the reader is told rather
  // than left to notice.
  if (d.renderContext === 'absent') {
    lines.push('This launch recorded no render context, so if the project rules change under it the '
      + 're-rendered steps may omit launch-time facts (the launch heal report, the operator host). '
      + 'Say so if a step changes shape mid-session.');
  }
  if (d.readiness) {
    lines.push(d.readiness.readyAt
      ? `READY attested ${d.readiness.readyAt}.`
      : 'READY: not attested yet.');
    // Said even when it is nothing: an agent that was nudged and an agent that
    // was not are otherwise indistinguishable from inside the session.
    if (d.readiness.unreadyAt) {
      lines.push(`The unready window passed at ${d.readiness.unreadyAt}`
        + (d.readiness.nudgeCount ? `; nudged ${d.readiness.nudgeCount} time(s), last ${d.readiness.lastNudgedAt}.` : '; not nudged.'));
    }
    if (d.readiness.reconciliationRequired) {
      lines.push(`Your attestation will need a reconciliation: ${d.readiness.reconciliationRequired}.`);
    }
  }
  for (const step of d.steps) {
    const state = step.ackedAt ? `acknowledged ${step.ackedAt}`
      : (step.servedAt ? `served ${step.pagesServed.length}/${step.pageCount} page(s), not acknowledged` : 'not served');
    lines.push(`  ${step.index + 1}. ${step.id} — ${state}`);
  }
  if (d.status.cursor < d.steps.length) lines.push('Run `tc start next` to continue.');
  return lines.join('\n') + '\n';
}

/**
 * Render what `tc start ready` answered.
 * @param {object} d - The /api/tc/start/ready response body
 * @returns {string}
 */
function renderStartReady(d) {
  const when = d.readyAt || 'now';
  const head = d.duplicate
    ? `This launch was already attested READY at ${when}; the attestation on record is unchanged.`
    : `Launch sequence attested READY at ${when}.`;
  return `${head}\n`
    + 'This records that your context arrived and was read. It authorizes nothing: '
    + 'the action you proposed still needs whatever confirmation your context requires.\n';
}

/**
 * `tc start ready`: attest the sequence.
 *
 * The verdict is REQUIRED and is not read from `status` on the agent's behalf.
 * Its whole purpose is to evidence that step 3 was read, and a CLI that fetched
 * it would satisfy the check without the agent ever having looked.
 *
 * No `revision` is sent, deliberately. `tc` does not track one, and inventing a
 * number to fill the field would turn a check into a formality. The artifact's
 * optional `revision` is for a client that DOES track it; the guard that always
 * fires is server-side — the cursor must stand at the end of the CURRENT
 * revision, and a revision that replaced content the session read demands a
 * written reconciliation.
 * @param {TcContext} ctx
 * @param {string} usage - The verb family's usage text
 * @returns {Promise<TcResult>}
 */
async function runStartReady(ctx, usage) {
  const flags = { '--verdict': 'preflightVerdict', '--first-action': 'proposedFirstAction', '--reconciliation': 'reconciliation' };
  const artifact = { schema: 'tc.ready/1' };
  const rest = ctx.argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const field = flags[rest[i]];
    if (!field) {
      return { code: 1, stderr: `tc: unknown argument '${rest[i]}'.\n${usage}` };
    }
    const value = rest[++i];
    if (value === undefined || value === '') {
      return { code: 1, stderr: `tc: ${rest[i - 1]} needs a value.\n${usage}` };
    }
    artifact[field] = value;
  }
  if (!artifact.preflightVerdict) {
    return {
      code: 1,
      stderr: 'tc: --verdict is required — pass the preflight verdict step 3 stated, which is how the '
        + `attestation shows you read it. \`tc start status\` shows the launch's own state.\n${usage}`
    };
  }
  if (!artifact.proposedFirstAction) {
    return { code: 1, stderr: `tc: --first-action is required: say what you propose to do first.\n${usage}` };
  }
  const data = await _awaitBinding(ctx, () => ctx.postJson('/api/tc/start/ready', artifact));
  return { code: 0, stdout: renderStartReady(data) };
}

/**
 * The `tc start` verb family: next | ready | status (Train 21).
 * @param {TcContext} ctx
 * @returns {Promise<TcResult>}
 */
async function runStart(ctx) {
  const sub = ctx.argv[0];
  const usage = 'usage: tc start next [--ack <step>:<revision>:<digest>] [--page <n>]\n'
    + '     | tc start ready --verdict <preflight verdict> --first-action <text> [--reconciliation <text>]\n'
    + '     | tc start status\n';
  if (!sub || !START_SUBVERBS.includes(sub)) {
    return { code: 1, stderr: `tc: start needs a subverb.\n${usage}` };
  }
  if (sub === 'status') {
    const data = await _awaitBinding(ctx, () => ctx.getJson('/api/tc/start/status'));
    return { code: 0, stdout: renderStartStatus(data) };
  }
  if (sub === 'ready') return runStartReady(ctx, usage);

  const body = {};
  const rest = ctx.argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--ack') {
      const parts = String(rest[++i] || '').split(':');
      if (parts.length !== 3 || !parts[0] || !parts[2]) {
        return { code: 1, stderr: `tc: --ack takes <step>:<revision>:<digest>, exactly as the step printed it.\n${usage}` };
      }
      const revision = Number(parts[1]);
      if (!Number.isInteger(revision)) {
        return { code: 1, stderr: `tc: the revision in --ack must be a whole number.\n${usage}` };
      }
      body.ack = { step: parts[0], revision, digest: parts[2] };
    } else if (rest[i] === '--page') {
      const page = Number(rest[++i]);
      if (!Number.isInteger(page) || page < 0) {
        return { code: 1, stderr: `tc: --page takes a page number, counted from 0.\n${usage}` };
      }
      body.page = page;
    } else {
      return { code: 1, stderr: `tc: unknown argument '${rest[i]}'.\n${usage}` };
    }
  }
  const data = await _awaitBinding(ctx, () => ctx.postJson('/api/tc/start/next', body));
  return { code: 0, stdout: renderPage(data) };
}

/**
 * The declared verb roster. Order is help order. Each entry owns one verb:
 * `id` is the word after `tc`, `usage`/`summary` render in help, `run`
 * produces the answer. An entry must never assume another ran before it.
 *
 * @type {Array<{id: string, usage: string, summary: string, run: (ctx: TcContext) => Promise<TcResult>}>}
 */
const VERB_ROSTER = [
  {
    id: 'whoami',
    usage: 'tc whoami',
    summary: 'who am I, where is TangleClaw, and what can I do through it',
    run: async (ctx) => ({ code: 0, stdout: renderWhoami(await fetchIdentity(ctx)) })
  },
  {
    id: 'capabilities',
    usage: 'tc capabilities',
    summary: 'the capability roster alone — enabled and disabled, each with its reason',
    run: async (ctx) => ({ code: 0, stdout: renderCapabilities(await fetchIdentity(ctx)) })
  },
  {
    id: 'sessions',
    usage: 'tc sessions',
    summary: 'every live TangleClaw session across all projects',
    run: async (ctx) => ({ code: 0, stdout: renderSessions(await ctx.getJson('/api/tc/sessions'), ctx.env) })
  },
  {
    id: 'message',
    usage: 'tc message send <workspace-id> <text…> | read | ack <id…> | status <workspace-id>',
    summary: 'switchboard messaging: send to a peer, read your inbox, mark handled, see why a peer has not picked up',
    run: runMessage
  },
  {
    id: 'start',
    usage: 'tc start next [--ack <step>:<revision>:<digest>] [--page <n>] | tc start ready --verdict <v> --first-action <text> | tc start status',
    summary: "this session's launch sequence: pull each step of your context, acknowledge it, and attest it READY",
    run: runStart
  },
  {
    id: 'freshness',
    usage: 'tc freshness',
    summary: 'which commit each live session you may see is on, and how it stands against origin/main',
    run: async (ctx) => ({ code: 0, stdout: renderFreshness(await ctx.getJson('/api/checkouts')) })
  },
  {
    id: 'ports',
    usage: 'tc ports',
    summary: 'the PortHub lease registry — check before binding any port',
    run: async (ctx) => ({ code: 0, stdout: renderPorts(await ctx.getJson('/api/ports')) })
  },
  {
    id: 'docs',
    usage: 'tc docs',
    summary: 'shared documents in the groups this pane may read',
    run: async (ctx) => ({ code: 0, stdout: renderDocs(await ctx.getJson('/api/shared-docs')) })
  },
  {
    id: 'rules',
    usage: 'tc rules',
    summary: "this project's durable session rules, review state included",
    run: async (ctx) => {
      const r = requireProjectId(ctx);
      if (r.error) return r.error;
      return { code: 0, stdout: renderRules(await ctx.getJson(`/api/session-rules?projectId=${encodeURIComponent(r.projectId)}`)) };
    }
  },
  {
    id: 'learnings',
    usage: 'tc learnings',
    summary: "this project's recorded learnings from past sessions",
    run: async (ctx) => {
      const r = requireProjectId(ctx);
      if (r.error) return r.error;
      return { code: 0, stdout: renderLearnings(await ctx.getJson(`/api/learnings?projectId=${encodeURIComponent(r.projectId)}`)) };
    }
  }
];

/**
 * Render the usage text from the roster — the roster is the single source, so
 * a new verb appears in help by existing.
 * @returns {string}
 */
function renderUsage() {
  const lines = ['usage: tc <verb>', 'verbs:'];
  for (const v of VERB_ROSTER) {
    lines.push(`  ${v.usage}`);
    lines.push(`      ${v.summary}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Bytes as kilobytes for a person to read: whole numbers stay whole, anything
 * else rounds UP to one decimal, so a body one byte over a 64 KB limit reads
 * "64.1 KB" rather than an impossible "64 KB, limit is 64 KB".
 * @param {number} bytes - A byte count.
 * @returns {string} e.g. "64 KB", "70.3 KB".
 */
function formatKB(bytes) {
  const tenths = Math.ceil((bytes / 1024) * 10);
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)} KB`;
}

/**
 * The sentence for a 413 BODY_TOO_LARGE refusal — "message is X KB, limit is
 * 64 KB" — from the numbers the server put in the refusal, so tc never carries
 * its own copy of the limit. A size the server could only bound from below says
 * "more than". Null when the body is not that refusal, or lacks the numbers.
 * @param {object|null} body - The parsed error response body.
 * @returns {string|null}
 */
function renderBodyTooLarge(body) {
  if (!body || body.code !== 'BODY_TOO_LARGE') return null;
  if (!Number.isFinite(body.limitBytes) || !Number.isFinite(body.receivedBytes)) return null;
  const size = `${body.receivedBytesIsLowerBound ? 'more than ' : ''}${formatKB(body.receivedBytes)}`;
  return `message is ${size}, limit is ${formatKB(body.limitBytes)}`;
}

/**
 * The receipt-header verb label for an invocation — `message send` records as
 * `message.send` so the awareness ledger distinguishes subverbs.
 * @param {string} verb - The roster verb id
 * @param {string[]} argv - Arguments after the verb
 * @returns {string}
 */
function receiptVerbLabel(verb, argv) {
  if (verb === 'message' && argv[0] && MESSAGE_SUBVERBS.includes(argv[0])) {
    return `message.${argv[0]}`;
  }
  if (verb === 'start' && argv[0] && START_SUBVERBS.includes(argv[0])) {
    return `start.${argv[0]}`;
  }
  return verb;
}

module.exports = {
  VERB_ROSTER,
  START_SUBVERBS,
  LAUNCH_BIND_WAIT_MS,
  renderUsage,
  receiptVerbLabel,
  renderBodyTooLarge,
  // Renderers exported for in-process tests — behavior contracts, not helpers
  // to reuse elsewhere.
  renderWhoami,
  renderCapabilities,
  renderSessions,
  renderFreshness,
  renderPorts,
  renderDocs,
  renderRules,
  renderLearnings,
  renderInbox,
  renderPeerStatus,
  renderStartStatus
};
