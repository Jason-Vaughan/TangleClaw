'use strict';

/**
 * Ecosystem birth-awareness primer (#1122).
 *
 * Every session TangleClaw launches should wake up knowing the ecosystem it
 * lives in: that TangleClaw manages it, where TC's API is and which numeric
 * project id addresses it (the #1121 trap — the name is what every
 * /api/sessions/:project route accepts, so it is the natural wrong guess),
 * that operator-facing links never use localhost, that a Project Rules store
 * exists and how a session proposes changes to it, that the learnings file
 * feeds the rule-promotion loop, and that ports go through PortHub. Before
 * this section a brand-new session needed a cross-session tutorial for what
 * should be birth knowledge (the 2026-08-31 CasaJirafa exchange).
 *
 * The section renders from a DECLARED ROSTER rather than prose in
 * `generatePrimePrompt` — adding the next ecosystem fact is one roster entry,
 * not prompt surgery. Engine-agnostic by construction: plain prompt text and
 * HTTP endpoints, no engine-specific filename or capability anywhere.
 *
 * Prime-budget conscious (#568): each item renders one short paragraph; the
 * whole section stays around a kilobyte, and the caller wraps it in the
 * prime's yieldable machinery with a fallback pointer that preserves the two
 * identifiers a session cannot rediscover cheaply (API origin + numeric id).
 *
 * @module lib/ecosystem-primer
 */

/**
 * Rendering context every roster item receives.
 * @typedef {object} PrimerContext
 * @property {number} projectId - The project's numeric store id
 * @property {string} projectName - The project's display name
 * @property {string} apiOrigin - TC's API origin for this instance (e.g. `http://localhost:3102`)
 * @property {string} operatorHost - The host operator-facing links must use (MagicDNS name, or hostname fallback)
 */

/**
 * The declared roster. Order is render order. Each item owns one ecosystem
 * fact and renders it as a single markdown bullet (possibly multi-sentence);
 * an item must never assume another item rendered before it.
 *
 * @type {Array<{id: string, render: (ctx: PrimerContext) => string}>}
 */
const ECOSYSTEM_ROSTER = [
  {
    id: 'tangleclaw-api',
    render: (ctx) =>
      `- **TangleClaw manages this session.** Its HTTP API for this instance is ${ctx.apiOrigin}. `
      + `This project's **numeric project id is ${ctx.projectId}** — project-scoped APIs like `
      + '`/api/session-rules` key on that id, NOT the project name (only the `/api/sessions/:project` '
      + 'family addresses by name).'
  },
  {
    id: 'magic-dns',
    render: (ctx) =>
      '- **Never hand the operator a `localhost` link** — they are almost never on this machine. '
      + `Operator-facing URLs use \`http://${ctx.operatorHost}:<port>\`; \`localhost\` stays correct `
      + 'only for your own API calls from this host.'
  },
  {
    id: 'project-rules',
    render: (ctx) =>
      '- **Durable Project Rules govern your sessions** and live in TangleClaw (Settings modal → '
      + `Project Rules), not in this repo. Read yours: \`GET /api/session-rules?projectId=${ctx.projectId}\`. `
      + 'Propose one (kind `startup` injects at launch, `wrap` into wrap prompts): '
      + `\`POST /api/session-rules {"content","projectId":${ctx.projectId},"kind","createdBy":"ai"}\`. `
      + "AI-authored rules land as `status='proposed'` and inject nothing until the operator approves — "
      + 'that gate is by design; tell the operator a proposal is waiting rather than fighting it.'
  },
  {
    id: 'learnings-loop',
    render: () =>
      '- **Self-improvement loop:** at session wrap, record genuinely recurring project facts or '
      + 'self-corrections as dated `## YYYY-MM-DD — <title>` entries in '
      + '`.tangleclaw/memories/learnings.md`. TangleClaw mirrors them into its learnings store; one '
      + 'seen on two different days is injected into future primes and auto-proposed as a rule for '
      + 'the operator to approve.'
  },
  {
    id: 'porthub',
    render: (ctx) =>
      '- **Ports go through PortHub.** Never pick a listen port ad hoc — request or look up '
      + `assignments via the TangleClaw API (${ctx.apiOrigin}) so projects cannot collide.`
  }
];

/**
 * Render the `## TangleClaw Ecosystem` prime section from the roster.
 *
 * @param {PrimerContext} ctx - Interpolation context (see typedef)
 * @returns {string[]} Markdown lines, ending with a blank spacer
 */
function buildEcosystemPrimerSection(ctx) {
  const lines = [
    '## TangleClaw Ecosystem',
    'Operating basics for any session in this ecosystem — standing context, not a task list:'
  ];
  for (const item of ECOSYSTEM_ROSTER) {
    lines.push(item.render(ctx));
  }
  lines.push('');
  return lines;
}

/**
 * The one-line fallback used when the prime budget forces this section to
 * yield: it preserves the two identifiers a session cannot cheaply
 * rediscover — the API origin and the numeric project id.
 *
 * @param {PrimerContext} ctx - Interpolation context
 * @returns {string}
 */
function ecosystemPrimerPointer(ctx) {
  return `_(Ecosystem primer omitted for budget. TC API ${ctx.apiOrigin}; numeric project id is ${ctx.projectId}.)_\n`;
}

module.exports = {
  buildEcosystemPrimerSection,
  ecosystemPrimerPointer,
  ECOSYSTEM_ROSTER
};
