'use strict';

/**
 * Ecosystem birth-awareness primer (#1122).
 *
 * Every session TangleClaw launches should wake up knowing the ecosystem it
 * lives in: that TangleClaw manages it, where TC's API is and which numeric
 * project id addresses it (the #1121 trap — the name is what every
 * /api/sessions/:project route accepts, so it is the natural wrong guess),
 * that operator-facing links never use localhost, that the `tc` CLI is the
 * in-pane discovery surface (the bootstrap line every carrier ships — see
 * `tcBootstrapLines`), that a Project Rules store
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

const { VERB_ROSTER } = require('./tc-verbs');
const sessionOwnership = require('./session-ownership');

/**
 * Rendering context every roster item receives.
 * @typedef {object} PrimerContext
 * @property {number} projectId - The project's numeric store id
 * @property {string} projectName - The project's display name
 * @property {string} apiOrigin - TC's API origin for this instance (e.g. `http://localhost:3102`)
 * @property {string|null} operatorHost - The host operator-facing links must use, measured from the
 *   operator's own request where knowable; `null` when none could be established (render the unknown, never a guess)
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
    id: 'tc-cli',
    render: () => tcBootstrapLines('md').join('\n')
  },
  {
    id: 'operator-links',
    // The host is whatever the operator's OWN request arrived on where that is
    // knowable — a reverse proxy means this machine's name is not the name they
    // are typing. Deliberately NOT a Tailscale fact: most installs have no
    // MagicDNS name, and the operator may reach this box by LAN IP, an mDNS
    // `.local` name or their own domain. A MagicDNS name is one possible value
    // of this fact, reached only by the last-resort probe, never the rule.
    // When no host can be established the item says so: an invented host reads
    // as a fact and sends the operator to a URL that does not answer, which is
    // worse than being told to ask.
    render: (ctx) =>
      '- **Never hand the operator a `localhost` link** — they are almost never on this machine; '
      + sessionOwnership.operatorLinkDirective(ctx.operatorHost)
      + '. `localhost` is correct only for your own API calls from this host.'
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
    id: 'medusa',
    render: () =>
      '- **Medusa switchboard:** TangleClaw runs session-to-session agent messaging. A '
      + '`## Medusa Switchboard` section elsewhere in this prime means you participate — it carries '
      + 'your workspace id and endpoints (use those; never register your own listener). No such '
      + 'section: not opted in; the operator can enable it in settings.'
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
  return `_(Ecosystem primer omitted for budget. TC API ${ctx.apiOrigin}; numeric project id is ${ctx.projectId}; `
    + 'run `tc capabilities` for the live capability roster before assuming anything is missing.)_\n';
}

/**
 * The `tc` bootstrap line — the one instruction every carrier ships.
 *
 * The 2026-09-01 live probe proved PATH presence alone creates zero discovery
 * intent: an unprompted agent given a task `tc` would have served produced no
 * invocations at all. Discovery therefore arrives only through the channels an
 * engine actually reads, and each of those channels ships this line. It is an
 * instruction with a stated consequence, not a footnote — a line the agent
 * skims is a vacuum too — and it is honest about the one case where the CLI is
 * legitimately absent (a pane TangleClaw did not launch), because a surface
 * that only ever describes success teaches an agent to invent one.
 *
 * One source for every carrier: the prime roster renders it via the `tc-cli`
 * roster entry, and every engine-config generator in `lib/engines.js` embeds
 * it, so the wording cannot drift per channel.
 *
 * The verb list is derived from `lib/tc-verbs.js#VERB_ROSTER` — the declared
 * single source — so a ninth verb reaches every carrier by existing rather
 * than leaving them advertising eight. (`tc-verbs` is dependency-free, so the
 * require introduces no cycle.)
 *
 * @param {('md'|'comment')} [format] - `md` for markdown carriers, `comment`
 *   for carriers that can only hold `#`-prefixed plain text (YAML configs)
 * @returns {string[]} Lines ready to splice into the carrier
 */
function tcBootstrapLines(format = 'md') {
  const verbIds = VERB_ROSTER.map((v) => v.id);
  if (format === 'comment') {
    const text = 'Run `tc capabilities` BEFORE concluding a TangleClaw capability is missing — never '
      + `improvise one. The tc CLI is on PATH in every TangleClaw-launched pane (verbs: ${verbIds.join(', ')}) `
      + 'and reports absence honestly. A capability assumed instead of checked is how sessions fabricate '
      + 'outcomes. If tc is not found, this pane was not launched by TangleClaw — say so rather than guessing. '
      + 'A failed localhost tc or curl is not proof of outage: a managed sandbox can block loopback while '
      + 'the host service is healthy — ask the operator or Project Master for a host-context check before '
      + 'reporting the server down.';
    return _wrapAsCommentLines(text);
  }
  return [
    '- **Run `tc capabilities` BEFORE concluding a TangleClaw capability is missing — never improvise '
    + `one.** The \`tc\` CLI is on PATH in every TangleClaw-launched pane (verbs: ${verbIds.map((v) => `\`${v}\``).join(', ')}) `
    + 'and reports absence honestly. A capability assumed instead of checked is how sessions fabricate '
    + 'outcomes. If `tc` is not found, this pane was not launched by TangleClaw — say so rather than guessing. '
    + 'A failed localhost `tc`/`curl` is **not proof of outage** — sandboxes block loopback; get a host-context '
    + 'check before reporting the server down.'
  ];
}

/**
 * Wrap plain text into `#`-prefixed comment lines at a readable width, so a
 * derived (variable-length) verb list cannot overflow a hand-fixed wrap.
 *
 * @param {string} text - The sentence(s) to wrap
 * @param {number} [width] - Maximum content width per line, prefix included
 * @returns {string[]} `#`-prefixed lines, broken at word boundaries
 */
function _wrapAsCommentLines(text, width = 100) {
  const lines = [];
  let current = '#';
  for (const word of text.split(/\s+/)) {
    if (current.length + 1 + word.length > width && current !== '#') {
      lines.push(current);
      current = '#';
    }
    current += ` ${word}`;
  }
  if (current !== '#') lines.push(current);
  return lines;
}

module.exports = {
  buildEcosystemPrimerSection,
  ecosystemPrimerPointer,
  tcBootstrapLines,
  ECOSYSTEM_ROSTER
};
