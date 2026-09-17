'use strict';

/**
 * The launch sequence (Train 21): a session's context served over `tc start`
 * in four acknowledged steps instead of one unconfirmed push.
 *
 * This module owns three things:
 * - **The snapshot.** At launch the four steps are rendered once, paged, and
 *   frozen in the store with the session row (`buildSnapshot`). Every serve
 *   returns the stored bytes, so a digest the agent was shown always describes
 *   what it was served, across restarts and rule edits.
 * - **The identity handshake.** A pane carries `TANGLECLAW_LAUNCH_ID`, minted
 *   before tmux starts and bound in the transaction that creates the session
 *   row. The server never infers "the latest active session".
 * - **The ack protocol.** `next` serves pages and applies acknowledgements
 *   inside one transaction, by fixed rules evaluated in a fixed order.
 *
 * The launch id is attribution, not authentication. A local process that
 * forges one gains nothing beyond marking steps read.
 *
 * @module lib/launch-sequence
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const continuity = require('./continuity');
const { pageOverhead, ackCommand } = require('./launch-page');
const { createLogger } = require('./logger');

const log = createLogger('launch-sequence');

/** The envelope schema `next` answers with. */
const LAUNCH_SCHEMA = 'tc.launch/1';

/** The schema `status` answers with. */
const STATUS_SCHEMA = 'tc.launch-status/1';

/**
 * The tool-output limit assumed for an engine that declares none. Low on
 * purpose: an unmeasured engine gets more, smaller pages rather than a page it
 * may silently truncate.
 * @type {number}
 */
const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 8000;

/**
 * The smallest page budget a sequence is created with. A declared limit so
 * small that the footer leaves less than this is treated as a misdeclaration,
 * not honoured into one-line pages.
 * @type {number}
 */
const MIN_PAGE_BUDGET = 1000;

/** How long a caller should wait before asking about a launch id that is not bound yet. */
const NOT_BOUND_RETRY_MS = 500;

/** A launch id is 128 random bits, base64url: 22 characters. */
const LAUNCH_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * What a pull-mode preflight says until the handoff check exists. Stated as
 * "not evaluated" rather than as a clean verdict: nothing was checked.
 * @type {{verdict: string, reason: string}}
 */
const PREFLIGHT_NOT_EVALUATED = {
  verdict: 'not-evaluated',
  reason: 'this TangleClaw version does not yet check the previous session\'s handoff at launch'
};

/** The text served once every step is acknowledged. */
const ALL_ACKED_CONTENT = 'All four launch steps are acknowledged. Your session context is complete; '
  + 'continue with the task step\'s instructions.';

/**
 * Mint a launch id.
 * @returns {string}
 */
function mintLaunchId() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * A step's digest: the first 16 hex characters of the SHA-256 of its content.
 * @param {string} content - The frozen step content
 * @returns {string}
 */
function stepDigest(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * The tool-output limit an engine declares, or the conservative default with
 * the reason it applies.
 * @param {object|null} engineProfile - Engine profile
 * @returns {{maxChars: number, measured: boolean, reason: string|null}}
 */
function resolveToolOutput(engineProfile) {
  const declared = engineProfile && engineProfile.capabilities && engineProfile.capabilities.toolOutput;
  const maxChars = declared && declared.maxChars;
  if (Number.isInteger(maxChars) && maxChars > 0) {
    return { maxChars, measured: true, reason: null };
  }
  if (declared) {
    log.warn('Engine declares an unusable toolOutput.maxChars — using the default', {
      engine: engineProfile.id, maxChars
    });
  }
  return {
    maxChars: DEFAULT_TOOL_OUTPUT_MAX_CHARS,
    measured: false,
    reason: `the engine declares no measured tool-output limit, so ${DEFAULT_TOOL_OUTPUT_MAX_CHARS} characters is assumed`
  };
}

/**
 * The page budget for a tool-output limit: what is left once the printed
 * footer is taken out.
 * @param {number} maxChars - The engine's tool-output limit
 * @returns {number}
 */
function pageBudgetFor(maxChars) {
  return Math.max(MIN_PAGE_BUDGET, maxChars - pageOverhead());
}

/**
 * Whether a launch gets a sequence, and why not when it does not.
 *
 * Decided from the engine's declared `launchSequence` capability, never from
 * its name. An engine that declares nothing is not assumed to run `tc`.
 * @param {object|null} engineProfile - Engine profile
 * @param {string|null} [launchReason] - A reason this launch opts out
 *   regardless of engine (for example, a launch with its prime disabled)
 * @returns {{applicable: boolean, reason: string|null}}
 */
function resolveApplicability(engineProfile, launchReason = null) {
  if (launchReason) return { applicable: false, reason: launchReason };
  const declared = engineProfile && engineProfile.capabilities && engineProfile.capabilities.launchSequence;
  if (declared && declared.supported === true) return { applicable: true, reason: null };
  if (declared && declared.supported === false) {
    return { applicable: false, reason: declared.reason || 'the engine declares no launch-sequence support' };
  }
  return { applicable: false, reason: `engine ${engineProfile ? engineProfile.id : '(unknown)'} does not declare launch-sequence support` };
}

/**
 * Split content into pages of at most `budget` characters.
 *
 * Pages end on a paragraph boundary where one fits. A paragraph larger than the
 * budget is split on a line boundary, and a line larger than the budget on a
 * character boundary (never inside a surrogate pair).
 * @param {string} content - The step content
 * @param {number} budget - Characters per page
 * @returns {Array<[number, number]>} Half-open `[start, end)` offsets; one
 *   empty page for empty content
 */
function paginate(content, budget) {
  if (content.length === 0) return [[0, 0]];
  const pages = [];
  let start = 0;
  while (start < content.length) {
    if (content.length - start <= budget) {
      pages.push([start, content.length]);
      break;
    }
    const window = content.slice(start, start + budget);
    let end;
    const paragraph = window.lastIndexOf('\n\n');
    const line = window.lastIndexOf('\n');
    if (paragraph > 0) end = start + paragraph + 2;
    else if (line > 0) end = start + line + 1;
    else {
      end = start + budget;
      const code = content.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    pages.push([start, end]);
    start = end;
  }
  return pages;
}

/**
 * Whether a page starts part-way through a paragraph.
 * @param {string} content - The step content
 * @param {number} start - The page's start offset
 * @returns {boolean}
 */
function pageIsContinued(content, start) {
  return start > 0 && content.slice(start - 2, start) !== '\n\n';
}

/**
 * SHA-256 of a file, or null when it cannot be read.
 * @param {string|null} file - Absolute path
 * @returns {string|null}
 */
function _fileHash(file) {
  if (!file) return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * What a snapshot was built from, so a later check can tell whether a rule or
 * a governing file changed underneath it.
 * @param {object} project - Project record
 * @param {object} engineProfile - Engine profile
 * @param {Array<{id: number, content: string}>} rules - The active startup rules the steps rendered
 * @returns {object}
 */
function buildSourceManifest(project, engineProfile, rules) {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const configFile = engineProfile && engineProfile.configFormat && engineProfile.configFormat.filename;
  let sharedDocs = [];
  try {
    sharedDocs = store.projectGroups.getByProject(project.id)
      .flatMap((group) => store.sharedDocs.list({ groupId: group.id }))
      .map((doc) => ({ id: doc.id, hash: _fileHash(doc.filePath) }));
  // prawduct:allow prawduct/broad-except -- a manifest read must not fail the launch; the gap is recorded as null
  } catch (err) {
    log.warn('Shared documents unreadable for the launch manifest', { project: project.name, error: err.message });
    sharedDocs = null;
  }
  return {
    rules: rules.map((rule) => {
      let revision = null;
      try {
        const versions = store.sessionRules.listVersions(rule.id);
        revision = versions.length > 0 ? versions[0].versionNo : null;
      } catch {
        revision = null;
      }
      return { id: rule.id, source: 'project', revision, contentHash: sha(rule.content.trim()) };
    }),
    globalRulesHash: sha(String(store.globalRules.load() || '')),
    engineConfig: configFile ? { file: configFile, hash: _fileHash(path.join(project.path, configFile)) } : null,
    sharedDocs,
    continuityIndexHash: _fileHash(continuity.indexPath(project.path)),
    handoffDigest: null
  };
}

/**
 * Build the sequence `store.sessions.start` binds to the new session.
 * @param {object} args
 * @param {string} args.launchId - From `mintLaunchId`
 * @param {object} args.project - Project record
 * @param {object} args.engineProfile - Engine profile
 * @param {{applicable: boolean, reason: string|null}} args.applicability - From `resolveApplicability`
 * @param {{identity: string, governance: string, state: string, task: string}|null} args.rendered -
 *   From `sessions.renderLaunchSteps`; null for a not-applicable launch
 * @param {Array<{id: number, content: string}>} args.rules - The startup rules the steps rendered
 * @param {{verdict: string, reason: string}} [args.preflight] - The verdict step 3 was rendered with
 * @returns {object} The `launchSequence` argument of `store.sessions.start`
 */
function buildSnapshot({ launchId, project, engineProfile, applicability, rendered, rules, preflight = PREFLIGHT_NOT_EVALUATED }) {
  const tool = resolveToolOutput(engineProfile);
  const pageBudget = pageBudgetFor(tool.maxChars);
  const base = {
    launchId,
    pageBudget,
    preflight,
    sourceManifest: buildSourceManifest(project, engineProfile, rules || [])
  };
  if (!applicability.applicable) {
    return { ...base, applicability: 'not-applicable', notApplicableReason: applicability.reason, steps: [] };
  }
  const steps = store.LAUNCH_STEP_IDS.map((id) => {
    const content = rendered[id];
    return { id, content, digest: stepDigest(content), pageOffsets: paginate(content, pageBudget) };
  });
  return { ...base, applicability: 'applicable', notApplicableReason: null, steps };
}

/**
 * A protocol refusal.
 * @param {number} status - HTTP status
 * @param {string} code - Stable machine code
 * @param {string} error - What happened and what to do
 * @param {object} [extra] - Fields a client branches on
 * @returns {{status: number, body: object}}
 */
function _refuse(status, code, error, extra = {}) {
  return { status, body: { ...extra, error, code } };
}

/**
 * Resolve the sequence a request is about, or the refusal that says why not.
 * @param {object} args
 * @param {string|null} args.launchId - The pane's launch id, if it sent one
 * @param {number|null} args.projectId - The pane's project id, if it sent one
 * @param {boolean} args.mutating - Whether the caller wants to change the sequence
 * @returns {{sequence: object}|{refusal: {status: number, body: object}}|{legacy: true}}
 */
function _resolve({ launchId, projectId, mutating }) {
  if (!launchId) {
    if (!mutating) return { legacy: true };
    return {
      refusal: _refuse(409, 'LAUNCH_ID_REQUIRED',
        'This pane carries no TANGLECLAW_LAUNCH_ID, so it predates phased launch and has no sequence to advance. '
        + 'Your context arrived in the pushed prime; carry on without `tc start next`.')
    };
  }
  if (!LAUNCH_ID_PATTERN.test(launchId)) {
    return { refusal: _refuse(400, 'BAD_LAUNCH_ID', 'The launch id is not one TangleClaw minted.') };
  }
  const sequence = store.launchSequences.getByLaunchId(launchId);
  if (!sequence) {
    return {
      refusal: _refuse(409, 'LAUNCH_NOT_BOUND',
        'This launch is not recorded yet. Retry shortly; if it never appears, the launch failed to record its session.',
        { retryAfterMs: NOT_BOUND_RETRY_MS })
    };
  }
  if (!Number.isInteger(projectId) || projectId !== sequence.projectId) {
    return {
      refusal: _refuse(409, 'SEQUENCE_SESSION_MISMATCH',
        'The launch id belongs to a different project than this pane claims. Nothing was served; tell the operator.')
    };
  }
  const session = store.sessions.get(sequence.sessionId);
  if (!session || session.status !== store.SESSION_STATUS.ACTIVE) {
    return {
      refusal: _refuse(409, 'SESSION_ENDED',
        `The session this launch belongs to is ${session ? session.status : 'gone'}; its sequence can no longer change.`)
    };
  }
  return { sequence };
}

/**
 * The status block every answer carries.
 * @param {object} sequence - The sequence
 * @returns {{cursor: number, ready: boolean, recovery: string, unready: boolean}}
 */
function _statusBlock(sequence) {
  return {
    cursor: sequence.cursor,
    ready: Boolean(sequence.readyAt),
    // Recovery arrives with the handoff preflight; until then nothing can require it.
    recovery: 'none',
    unready: Boolean(sequence.unreadyAt)
  };
}

/**
 * Serve a page of the cursor step and record it served.
 * @param {object} sequence - The sequence
 * @param {object[]} steps - Its steps at the current revision
 * @param {number|undefined} requestedPage - An explicit page, or undefined for the next unserved one
 * @returns {{status: number, body: object}}
 */
function _serve(sequence, steps, requestedPage) {
  const common = {
    schema: LAUNCH_SCHEMA,
    sessionId: sequence.sessionId,
    sequenceId: sequence.id,
    revision: sequence.revision
  };
  if (sequence.cursor >= steps.length) {
    return {
      status: 200,
      body: { ...common, step: null, page: null, content: ALL_ACKED_CONTENT, ack: null, status: _statusBlock(sequence), next: 'ready' }
    };
  }
  const step = steps[sequence.cursor];
  const pageCount = step.pageOffsets.length;
  let page;
  if (requestedPage !== undefined) {
    if (!Number.isInteger(requestedPage) || requestedPage < 0 || requestedPage >= pageCount) {
      return _refuse(400, 'PAGE_OUT_OF_RANGE',
        `Step ${step.id} has ${pageCount} page(s), numbered from 0; page ${requestedPage} does not exist.`,
        { step: step.id, pageCount });
    }
    page = requestedPage;
  } else {
    const served = new Set(step.pagesServed);
    page = step.pageOffsets.findIndex((_, i) => !served.has(i));
    // Every page already went out: repeat the last one, which carries the ack.
    if (page === -1) page = pageCount - 1;
  }
  store.launchSequences.markPageServed(sequence.id, sequence.revision, step.index, page);
  const [start, end] = step.pageOffsets[page];
  const last = page === pageCount - 1;
  return {
    status: 200,
    body: {
      ...common,
      step: { index: step.index, id: step.id, of: steps.length },
      page: { index: page, of: pageCount, continued: pageIsContinued(step.content, start) },
      content: step.content.slice(start, end),
      ack: last ? { digest: step.digest, command: ackCommand(step.id, sequence.revision, step.digest) } : null,
      status: _statusBlock(sequence),
      next: last ? 'step' : 'page'
    }
  };
}

/**
 * Apply an acknowledgement. The rules run in this order and the first match
 * decides: (e) wrong revision, (a) already acked with this digest, (b) wrong
 * digest, (d) not the cursor step, (f) pages unserved, (c) advance.
 * @param {object} sequence - The sequence
 * @param {object[]} steps - Its steps at the current revision
 * @param {object} ack - `{step, revision, digest}` from the request
 * @returns {{refusal: {status: number, body: object}}|{advanced: boolean}}
 */
function _applyAck(sequence, steps, ack) {
  if (!ack || typeof ack !== 'object' || typeof ack.digest !== 'string'
      || !Number.isInteger(ack.revision) || (typeof ack.step !== 'string' && !Number.isInteger(ack.step))) {
    return { refusal: _refuse(400, 'BAD_ACK', 'An ack needs {step, revision, digest}: run the command the step printed.') };
  }
  const where = { cursor: sequence.cursor };
  // (e) — first, so a replay from a superseded revision can never read as
  // an idempotent success against content it did not cover.
  if (ack.revision !== sequence.revision) {
    return {
      refusal: _refuse(409, 'SNAPSHOT_REVISED',
        `The sequence is now at revision ${sequence.revision}; that ack is for revision ${ack.revision}. Run \`tc start next\` to read the current step.`,
        { revision: sequence.revision, ...where })
    };
  }
  const target = steps.find((st) => st.id === ack.step || st.index === ack.step);
  if (!target) {
    return { refusal: _refuse(400, 'UNKNOWN_STEP', `There is no launch step "${ack.step}".`, where) };
  }
  // (a)
  if (target.ackedAt && ack.digest === target.digest) return { advanced: false };
  // (b) — the digest is never echoed back.
  if (ack.digest !== target.digest) {
    return {
      refusal: _refuse(409, 'ACK_DIGEST_MISMATCH',
        `That digest does not match step ${target.id}. Acknowledge with the exact command the step's last page printed.`,
        { step: target.id, ...where })
    };
  }
  // (d)
  if (target.index !== sequence.cursor) {
    return {
      refusal: _refuse(409, 'ACK_OUT_OF_ORDER',
        `Step ${target.id} is not the current step. Run \`tc start next\` and acknowledge steps in the order they are served.`,
        { step: target.id, ...where })
    };
  }
  // (f)
  const served = new Set(target.pagesServed);
  const missingPages = target.pageOffsets.map((_, i) => i).filter((i) => !served.has(i));
  if (missingPages.length > 0) {
    return {
      refusal: _refuse(409, 'PAGES_UNSERVED',
        `Step ${target.id} has page(s) you were not served: ${missingPages.join(', ')}. Fetch each with \`tc start next --page <n>\`, then acknowledge.`,
        { step: target.id, missingPages, ...where })
    };
  }
  // (c)
  const advanced = store.launchSequences.ackStep(sequence.id, sequence.revision, target.index);
  if (advanced) {
    store.activity.log({
      projectId: sequence.projectId,
      sessionId: sequence.sessionId,
      eventType: 'launch.step_acked',
      detail: { sequenceId: sequence.id, revision: sequence.revision, step: target.id }
    });
  }
  return { advanced };
}

/**
 * `POST /api/tc/start/next`: apply an optional ack, then serve a page.
 * The whole exchange runs in one immediate transaction.
 * @param {object} args
 * @param {string|null} args.launchId - The pane's launch id
 * @param {number|null} args.projectId - The pane's project id
 * @param {object} [args.ack] - `{step, revision, digest}`
 * @param {number} [args.page] - An explicit page to (re)serve
 * @returns {{status: number, body: object}}
 */
function next({ launchId, projectId, ack, page }) {
  return store.launchSequences.transaction(() => {
    const resolved = _resolve({ launchId, projectId, mutating: true });
    if (resolved.refusal) return resolved.refusal;
    let sequence = resolved.sequence;
    if (sequence.applicability !== 'applicable') {
      return _refuse(409, 'SEQUENCE_NOT_APPLICABLE',
        `This session has no launch steps to serve: ${sequence.notApplicableReason}.`,
        { reason: sequence.notApplicableReason });
    }
    let steps = store.launchSequences.listSteps(sequence.id, sequence.revision);
    let servePage = page;
    if (ack !== undefined && ack !== null) {
      const outcome = _applyAck(sequence, steps, ack);
      if (outcome.refusal) return outcome.refusal;
      if (outcome.advanced) {
        sequence = store.launchSequences.getByLaunchId(launchId);
        steps = store.launchSequences.listSteps(sequence.id, sequence.revision);
        // A page number was chosen for the step just acknowledged; against the
        // next step it means nothing, so the new step starts where it starts.
        servePage = undefined;
      }
    }
    return _serve(sequence, steps, servePage);
  });
}

/**
 * `GET /api/tc/start/status`: where the sequence stands. Read-only, and
 * answered for a pane that predates phased launch too.
 * @param {object} args
 * @param {string|null} args.launchId - The pane's launch id
 * @param {number|null} args.projectId - The pane's project id
 * @returns {{status: number, body: object}}
 */
function status({ launchId, projectId }) {
  const resolved = _resolve({ launchId, projectId, mutating: false });
  if (resolved.legacy) {
    return {
      status: 200,
      body: { schema: STATUS_SCHEMA, sequence: 'none', reason: 'this pane predates phased launch: it carries no TANGLECLAW_LAUNCH_ID' }
    };
  }
  if (resolved.refusal) return resolved.refusal;
  const sequence = resolved.sequence;
  const steps = store.launchSequences.listSteps(sequence.id, sequence.revision);
  return {
    status: 200,
    body: {
      schema: STATUS_SCHEMA,
      sequence: 'present',
      sessionId: sequence.sessionId,
      sequenceId: sequence.id,
      revision: sequence.revision,
      applicability: sequence.applicability,
      notApplicableReason: sequence.notApplicableReason,
      preflight: sequence.preflight,
      status: _statusBlock(sequence),
      steps: steps.map((st) => ({
        index: st.index,
        id: st.id,
        pageCount: st.pageCount,
        pagesServed: st.pagesServed,
        servedAt: st.servedAt,
        ackedAt: st.ackedAt
      }))
    }
  };
}

module.exports = {
  LAUNCH_SCHEMA,
  STATUS_SCHEMA,
  DEFAULT_TOOL_OUTPUT_MAX_CHARS,
  MIN_PAGE_BUDGET,
  NOT_BOUND_RETRY_MS,
  LAUNCH_ID_PATTERN,
  PREFLIGHT_NOT_EVALUATED,
  mintLaunchId,
  stepDigest,
  resolveToolOutput,
  resolveApplicability,
  pageBudgetFor,
  paginate,
  pageIsContinued,
  buildSourceManifest,
  buildSnapshot,
  next,
  status
};
