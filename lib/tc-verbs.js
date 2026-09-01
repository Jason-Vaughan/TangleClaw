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
  lines.push(`Operator host: ${d.operator.host} — ${d.operator.note}`);
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
    return 'No ports are currently leased in PortHub. Register before binding: POST /api/ports/lease {"port","project","service"}.\n';
  }
  const lines = [`${leases.length} port lease(s):`];
  for (const l of leases) {
    const host = l.host && l.host !== 'localhost' ? `${l.host}:` : '';
    lines.push(`  ${host}${l.port} — ${l.project} (${l.service})${l.permanent ? ' [permanent]' : ''}`);
  }
  lines.push('');
  lines.push('Claiming a port another project holds returns 409 — pick another in the same range.');
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
    return 'No shared documents are registered — there is nothing hidden behind this answer.\n';
  }
  const lines = [`${docs.length} shared document(s):`];
  for (const doc of docs) {
    lines.push(`  ${doc.name} (id ${doc.id}, group ${doc.groupId}) — ${doc.filePath}`);
  }
  lines.push('');
  lines.push('Lock before editing (POST /api/shared-docs/<id>/lock), unlock after.');
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
 * The `tc message` verb family: send | read | ack.
 * @param {TcContext} ctx
 * @returns {Promise<TcResult>}
 */
async function runMessage(ctx) {
  const sub = ctx.argv[0];
  const usage = 'usage: tc message send <workspace-id> <text…> | tc message read | tc message ack <id> [<id>…]\n';
  if (!sub || !['send', 'read', 'ack'].includes(sub)) {
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
    usage: 'tc message send <workspace-id> <text…> | read | ack <id…>',
    summary: 'switchboard messaging: send to a peer, read your inbox, mark handled',
    run: runMessage
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
    summary: 'shared documents registered across project groups',
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
 * The receipt-header verb label for an invocation — `message send` records as
 * `message.send` so the awareness ledger distinguishes subverbs.
 * @param {string} verb - The roster verb id
 * @param {string[]} argv - Arguments after the verb
 * @returns {string}
 */
function receiptVerbLabel(verb, argv) {
  if (verb === 'message' && argv[0] && ['send', 'read', 'ack'].includes(argv[0])) {
    return `message.${argv[0]}`;
  }
  return verb;
}

module.exports = {
  VERB_ROSTER,
  renderUsage,
  receiptVerbLabel,
  // Renderers exported for in-process tests — behavior contracts, not helpers
  // to reuse elsewhere.
  renderWhoami,
  renderCapabilities,
  renderSessions,
  renderPorts,
  renderDocs,
  renderRules,
  renderLearnings,
  renderInbox
};
