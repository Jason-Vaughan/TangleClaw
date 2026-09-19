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
const engines = require('./engines');
const continuity = require('./continuity');
const { pageOverhead, ackCommand, REVISION_REASONS } = require('./launch-page');
const ruleDriftOf = require('./launch-rule-drift');
const { createLogger } = require('./logger');

const log = createLogger('launch-sequence');

/** The envelope schema `next` answers with. */
const LAUNCH_SCHEMA = 'tc.launch/1';

/** The schema `status` answers with. */
const STATUS_SCHEMA = 'tc.launch-status/1';

/** The attestation schema `ready` accepts. */
const READY_SCHEMA = 'tc.ready/1';

/**
 * The shortest reconciliation the server accepts where one is required.
 *
 * A structural check, never a quality judgment: the server cannot tell a good
 * reconciliation from a bad one, and pretending otherwise would put it in the
 * business of grading prose. What it can tell is that a field holding four
 * words is not an account of anything.
 * @type {number}
 */
const MIN_RECONCILIATION_CHARS = 40;

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
 * What a launch records when the preflight could not be run at all.
 *
 * No longer "until the handoff check exists" — it exists (#1586). This is the
 * degraded answer for a launch whose context could not be gathered, and it is
 * stated as "not evaluated" rather than as a clean verdict because nothing was
 * checked. Neither predicate is claimed: nothing is owed on the strength of a
 * decision nobody reached.
 * @type {{verdict: string, reason: string, requiresRecovery: boolean, requiresReconciliation: boolean, worktreeDirty: null}}
 */
const PREFLIGHT_NOT_EVALUATED = {
  verdict: 'not-evaluated',
  reason: 'the previous session\'s handoff could not be checked at this launch',
  requiresRecovery: false,
  requiresReconciliation: false,
  worktreeDirty: null
};

/**
 * The parts of the protocol no version has filled in yet. Named in every status
 * answer so a reader can tell "not built yet" from "checked, and false" — the
 * same honesty the preflight verdict keeps.
 *
 * Empty since #1587: the recovery gate was the last stage this protocol was
 * serving without, and it now gates step 4 and READY. The field stays, and stays
 * a list, because the answer "nothing is pending" is worth being able to READ —
 * a reader who finds no field cannot tell it from a reader whose version never
 * had one.
 * @type {{stages: string[], reason: string}}
 */
const PENDING_STAGES = {
  stages: [],
  reason: 'every stage of this launch protocol ships in this version: the steps are served, acknowledged and attested, the handoff preflight states a verdict, and the recovery gate acts on it'
};

/** The text served once every step is acknowledged. */
const ALL_ACKED_CONTENT = 'All four launch steps are acknowledged. Your session context is complete.\n\n'
  + 'Attest it, so the operator can see the context arrived and was read:\n'
  + '  tc start ready --verdict <the preflight verdict step 3 stated> --first-action "<the first action you propose>"\n\n'
  + 'READY records initialization, not authorization: it does not approve the action you propose, '
  + 'and every confirmation rule in your context still applies. Then continue with the task step\'s '
  + 'instructions.';

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
 * The identity of a rule set: one entry per rule, hashed over its content.
 *
 * One derivation, because two readers compare it — the manifest a snapshot is
 * built with, and the live check that asks whether the rules changed under it.
 * A second copy of this shape would eventually hash a different thing and
 * report a rule change on every request, or none ever.
 * The `source` is a parameter rather than a literal because car 21.10 fingerprints
 * three kinds of governing text with one helper. It stays `project` by default so
 * every existing caller keeps producing exactly the rows it produced before.
 * @param {Array<{id: number, content: string}>} rules - Active startup rules, as rendered
 * @param {string} [source] - Which governing source these rows came from
 * @returns {Array<{id: number, source: string, revision: number|null, contentHash: string}>}
 */
function ruleFingerprints(rules, source = 'project') {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  return (rules || []).map((rule) => {
    let revision = null;
    try {
      const versions = store.sessionRules.listVersions(rule.id);
      revision = versions.length > 0 ? versions[0].versionNo : null;
    } catch {
      revision = null;
    }
    return { id: rule.id, source, revision, contentHash: sha(rule.content.trim()) };
  });
}

/**
 * The full governing-text manifest: project rules, the global rule set, and
 * every shared document this project can reach.
 *
 * This is what a wrap freezes into its handoff and what a launch compares
 * against it (car 21.10). It is deliberately NOT what `buildSourceManifest`
 * stores under `rules`: that array is the input to §2.2's revision check, whose
 * ratified trigger is a change to the PROJECT rules served in step 2. Widening
 * it would make a global-rules edit re-render four steps and move the cursor
 * back, which is a change to Chunk 02's approved protocol and not this car's to
 * make.
 *
 * `manifestSources` is what makes the diff honest: it records which sources
 * were actually looked at, so a reader can tell a project with no shared
 * documents from a wrap that never examined any.
 *
 * **It reads every source itself, and takes no rules from its caller.** An
 * earlier cut let the launch pass the rules it had already rendered, to save a
 * query. That made the two manifests the diff compares come from different
 * populations: the launch's bundle is filtered to rules with usable content,
 * the wrap's read is not, so a project holding one empty rule reported it as
 * removed on every launch and blocked READY forever for a deletion that never
 * happened. Worse, a caller whose own rules query THREW handed in `[]`, which
 * is indistinguishable from "this project has no rules" and rendered as every
 * rule removed. One reader, one failure mode, both sides identical.
 *
 * @param {object} project - Project record
 * @returns {{rules: object[], manifestSources: string[]}} The manifest
 */
function manifestFingerprints(project) {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const rules = [];
  const sources = [];

  try {
    const rows = store.sessionRules.listActiveForProject(project.id)
      // The same usability filter the prime applies, applied HERE so both
      // manifests inherit it from one place rather than from whichever caller
      // happened to have filtered first.
      .filter((r) => r && r.content && String(r.content).trim());
    rules.push(...ruleFingerprints(rows, 'project'));
    sources.push('project');
  // prawduct:allow prawduct/broad-except -- a source that cannot be read is left UNDECLARED, so
  // the diff reports it as unreadable rather than as an empty set that reads like "none exist"
  } catch (err) {
    log.warn('Project rules unreadable for the governing manifest', {
      project: project.name, error: err.message
    });
  }

  try {
    const text = String(store.globalRules.load() || '');
    // One row, because the global rules are one document on this install — there
    // is no per-rule identity to diff below the set. Trimmed, and `globalRulesHash`
    // on the handoff document is NOT: that field predates this car and is read by
    // 21.8's preflight, so it keeps its own rule. This row is the one the drift
    // diff reads; see the handoff document's own note.
    rules.push({ id: 'global', source: 'global', revision: null, contentHash: sha(text.trim()), label: 'the global rules' });
    sources.push('global');
  // prawduct:allow prawduct/broad-except -- see above: undeclared beats a fabricated empty set
  } catch (err) {
    log.warn('Global rules unreadable for the governing manifest', {
      project: project.name, error: err.message
    });
  }

  try {
    const unreadable = [];
    for (const doc of store.sharedDocs.listForProject(project.id)) {
      const hash = _fileHash(doc.filePath);
      // `_fileHash` answers null for a file it could not read, and null is not
      // a hash. Left as one, a document unreadable at BOTH the wrap and this
      // launch compares equal to itself and is reported as unchanged — a
      // measurement nobody took, on the one source this car adds, with nothing
      // anywhere saying the read failed.
      if (hash === null) unreadable.push({ id: doc.id, path: doc.filePath });
      rules.push({
        id: doc.id,
        source: 'shared',
        revision: null,
        contentHash: hash,
        measured: hash !== null,
        label: `shared document ${doc.name}`
      });
    }
    if (unreadable.length > 0) {
      log.warn('Shared documents could not be hashed for the governing manifest — drift cannot speak for them', {
        project: project.name, documents: unreadable
      });
    }
    sources.push('shared');
  // prawduct:allow prawduct/broad-except -- see above
  } catch (err) {
    log.warn('Shared documents unreadable for the governing manifest', {
      project: project.name, error: err.message
    });
  }

  return { rules, manifestSources: sources };
}

/**
 * What a snapshot was built from, so a later check can tell whether a rule or
 * a governing file changed underneath it.
 * @param {object} project - Project record
 * @param {object} engineProfile - Engine profile
 * @param {Array<{id: number, content: string}>} rules - The active startup rules the steps rendered
 * @param {{maxChars: number, measured: boolean, reason: string|null}} toolOutput - The limit the
 *   pages were sized against, and whether it was measured or assumed
 * @param {object|null} [renderContext] - The launch-time inputs the steps were rendered with, kept
 *   so a later revision can re-render the same content rather than a degraded version of it
 * @returns {object}
 */
function buildSourceManifest(project, engineProfile, rules, toolOutput, renderContext = null) {
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const configFile = engines.configFilenameOf(engineProfile);
  let sharedDocs = [];
  try {
    // The same traversal the governance step renders from (`store.sharedDocs
    // .listForProject`): the manifest answers "did a source change under this
    // snapshot", which it cannot do if it hashes a different set than the step
    // served.
    sharedDocs = store.sharedDocs.listForProject(project.id)
      .map((doc) => ({ id: doc.id, hash: _fileHash(doc.filePath) }));
  // prawduct:allow prawduct/broad-except -- a manifest read must not fail the launch; the gap is recorded as null
  } catch (err) {
    log.warn('Shared documents unreadable for the launch manifest', { project: project.name, error: err.message });
    sharedDocs = null;
  }
  return {
    // Recorded, not only used: an assumed limit is a fact about this snapshot
    // that `tc start status` has to be able to tell its reader (#1580).
    toolOutput,
    // The inputs only the launch has. Steps 2-4 are re-rendered when the rules
    // change under a snapshot, and the collector that renders them takes facts
    // no later request can recompute (the launch heal's report, the operator
    // host, the workspace id). Recorded here rather than in a column of their
    // own: the manifest's question is "what was this built from", and these are
    // part of the answer. A sequence that carries none (one created before they
    // were recorded) re-renders from what is knowable then, and says so.
    renderContext,
    rules: ruleFingerprints(rules),
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
 * @param {'operator'|'advisory'} [args.recoveryMode] - The project's recovery mode, frozen with the launch
 * @param {object|null} [args.renderContext] - The launch-time render inputs, for a later revision
 * @param {object|null} [args.ruleDrift] - What changed in the governing text since the handoff,
 *   frozen so step 3 and the READY gate cannot disagree about it
 * @returns {object} The `launchSequence` argument of `store.sessions.start`
 */
function buildSnapshot({ launchId, project, engineProfile, applicability, rendered, rules, preflight = PREFLIGHT_NOT_EVALUATED, recoveryMode = 'operator', renderContext = null, ruleDrift = null }) {
  const tool = resolveToolOutput(engineProfile);
  const pageBudget = pageBudgetFor(tool.maxChars);
  const base = {
    launchId,
    pageBudget,
    preflight,
    // Read from the predicate the preflight decided, never re-derived from the
    // verdict word: `requiresRecovery` is not a function of the verdict for
    // `workspace-unavailable`, so a recomputation would answer `false` for the
    // one case nobody measured (`lib/sessions.js#_storedPreflight`).
    recovery: preflight && preflight.requiresRecovery === true ? 'required' : 'none',
    // Frozen with the launch, like the rules and the verdict. A project whose
    // setting is edited while a pane is mid-launch keeps playing by the rules it
    // was told at step 1 — the alternative is a session that is withheld step 4
    // and then, one edit later, allowed to attest without anyone clearing it.
    recoveryMode,
    sourceManifest: {
      ...buildSourceManifest(project, engineProfile, rules || [], tool, renderContext),
      // Rides the manifest rather than taking a column: it is a fact about what
      // this snapshot was built against, which is exactly what the manifest
      // answers, and a revision recomputes nothing about it (a revision is
      // about THIS launch's rules changing, not about the previous session's).
      ruleDrift
    }
  };
  if (!applicability.applicable) {
    // A launch with no steps has nothing to withhold and can never attest —
    // `_serve` and `ready` both refuse it with SEQUENCE_NOT_APPLICABLE first —
    // so `required` here would be a demand nothing enforces and no surface
    // shows. The verdict itself is still recorded in `preflight`, which is
    // where a reader asking "was this project's handoff sound" should look.
    return {
      ...base,
      recovery: 'none',
      applicability: 'not-applicable',
      notApplicableReason: applicability.reason,
      steps: []
    };
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
  // Logged here rather than at each site: a session that received no sequence
  // and one that received all four looked identical from outside, because every
  // refusal is built through this one helper and none of them narrated.
  // LAUNCH_NOT_BOUND is the expected race while a launch finishes recording,
  // and `tc` retries it: at info it would be the loudest line in a healthy
  // launch. Everything else is a refusal somebody has to be able to find.
  log[code === 'LAUNCH_NOT_BOUND' ? 'debug' : 'info']('Launch-sequence request refused', { code, status, ...extra });
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
    recovery: sequence.recovery || 'none',
    // Beside `recovery` rather than derived from it by the reader: `required`
    // means two different things to a pane depending on the mode — withheld in
    // `operator`, served behind a warning in `advisory` — and a client that had
    // to look the mode up elsewhere would guess for the window in between.
    recoveryMode: sequence.recoveryMode || 'operator',
    recoveryRevision: sequence.recoveryRevision === undefined ? null : sequence.recoveryRevision,
    unready: Boolean(sequence.unreadyAt)
  };
}

/**
 * The index of the task step, which is the one the recovery gate guards.
 *
 * Derived from the step roster rather than written as 3: the roster is what
 * decides how many steps there are, and a number copied from it here would
 * survive a change to it and guard the wrong step in silence.
 * @type {number}
 */
const TASK_STEP_INDEX = store.LAUNCH_STEP_IDS.indexOf('task');

/**
 * Whether serving this sequence's cursor step is blocked by an uncleared
 * recovery, and what the caller should do about it.
 *
 * Reads `recovery` and the frozen mode, and NOTHING else. `unready_at` is
 * deliberately not an input (§2.3): the unready window is an observation, so a
 * launch that sat too long must not become a launch that may skip its gate.
 * @param {object} sequence - The sequence
 * @returns {{gate: 'open'}|{gate: 'withheld'}|{gate: 'warn'}}
 */
function _recoveryGate(sequence) {
  if (sequence.recovery !== 'required') return { gate: 'open' };
  if (sequence.cursor !== TASK_STEP_INDEX) return { gate: 'open' };
  return { gate: sequence.recoveryMode === 'advisory' ? 'warn' : 'withheld' };
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
    // An attested sequence is told so rather than asked again: a second
    // `tc start ready` with a different artifact is a conflict, so inviting one
    // would be inviting a refusal.
    const content = sequence.readyAt
      ? `All four launch steps are acknowledged and this launch attested READY at ${sequence.readyAt}. `
        + 'There is nothing left to pull; continue with the task step\'s instructions.'
      : ALL_ACKED_CONTENT;
    return {
      status: 200,
      body: {
        ...common,
        step: null,
        page: null,
        content,
        ack: null,
        status: _statusBlock(sequence),
        next: sequence.readyAt ? 'done' : 'ready'
      }
    };
  }
  const gate = _recoveryGate(sequence);
  if (gate.gate === 'withheld') {
    // Withheld, not refused: the request was well formed and the sequence is
    // healthy — what is missing is an operator's decision. Nothing is marked
    // served, so the ack rules never see a page that did not go out, and the
    // step is served whole once the recovery is cleared.
    const verdict = (sequence.preflight && sequence.preflight.verdict) || 'unknown';
    return {
      status: 200,
      body: {
        ...common,
        step: null,
        page: null,
        withheld: true,
        content: `The task step is withheld: the launch preflight returned \`${verdict}\`, so this project's `
          + 'handoff state needs recovering before a session builds on it, and this project clears recovery in '
          + 'OPERATOR mode. Tell the operator, and ask them to clear the recovery from this project\'s Launch '
          + 'readiness panel. Nothing else you can run opens this step, and `tc start ready` will refuse until '
          + 'it is cleared.',
        reason: (sequence.preflight && sequence.preflight.reason) || null,
        verdict,
        recoveryRevision: sequence.recoveryRevision,
        ack: null,
        status: _statusBlock(sequence),
        next: 'recovery-clear'
      }
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
      // The advisory warning rides in its own field, never prepended to
      // `content`: the content is the frozen snapshot the digest covers, and
      // text mixed into it would either change what the digest describes or
      // make the digest describe something other than what was served. The
      // renderer prints it above the page, and `pageOverhead` budgets for it.
      ...(gate.gate === 'warn'
        ? { recovery: { verdict: (sequence.preflight && sequence.preflight.verdict) || 'unknown', recoveryRevision: sequence.recoveryRevision } }
        : {}),
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
 * The engine profile and project a sequence was built against.
 *
 * `openclaw:<connId>` resolves to the base profile, the same reduction the
 * launch path makes — a revision that rendered against a different profile
 * than the launch did would produce content the engine's own limits never sized.
 * @param {object} sequence - The sequence
 * @returns {{project: object|null, engineProfile: object|null}}
 */
function _sequenceContext(sequence) {
  const project = store.projects.get(sequence.projectId) || null;
  const baseEngineId = sequence.engineId && sequence.engineId.startsWith('openclaw:')
    ? 'openclaw'
    : sequence.engineId;
  return { project, engineProfile: baseEngineId ? (store.engines.get(baseEngineId) || null) : null };
}

/**
 * Re-render a sequence's snapshot at a new revision when the rules it was built
 * from have changed, and answer whether anything moved.
 *
 * The rule set is read through the same bundle the renderer uses, so "the rules
 * changed" means the rules the next render would use differ from the ones this
 * snapshot's steps were rendered with — not that some other query disagrees.
 *
 * Step 1 carries its acknowledgement over ONLY when the global rules hash and
 * its re-rendered bytes are both unchanged (§2.2). That is the whole condition:
 * an ack is evidence about content, so carrying one onto different content
 * would make the evidence a lie about what was read.
 * @param {object} sequence - The sequence, as resolved
 * @param {object[]} steps - Its steps at the current revision
 * @returns {{sequence: object, steps: object[], revised: boolean, reason: string|null}}
 */
function _reviseIfRulesChanged(sequence, steps) {
  const unchanged = { sequence, steps, revised: false, reason: null };
  // An attested sequence is never revised, whichever entry point asks (§2.2:
  // "after READY a rule change does not invalidate readiness"). The guard lives
  // here rather than in one caller because both `next` and `ready` reach this
  // one function, and a launch revised after attesting would carry `ready: true`
  // beside a cursor back at step 1 — a state the protocol cannot otherwise
  // produce, with the stored attestation bound to step rows that no longer exist
  // at the current revision. Delivering a later rule change is the rules
  // channel's job; the sequence records initialization, not compliance.
  if (sequence.readyAt) return unchanged;
  const manifest = sequence.sourceManifest;
  if (!manifest || !Array.isArray(manifest.rules)) return unchanged;
  const { project, engineProfile } = _sequenceContext(sequence);
  if (!project || !engineProfile) return unchanged;

  let bundle;
  try {
    bundle = _internal.buildStartupRules(project.id);
  // prawduct:allow prawduct/broad-except -- a rules read that fails must not refuse a step the
  // snapshot can still serve; the stored snapshot stands and the next request checks again
  } catch (err) {
    log.warn('Live rules unreadable — serving the stored snapshot unrevised', {
      sequence: sequence.id, error: err.message
    });
    return unchanged;
  }
  const live = ruleFingerprints(bundle.rules || []);
  if (JSON.stringify(live) === JSON.stringify(manifest.rules)) return unchanged;

  const renderContext = manifest.renderContext || null;
  let rendered;
  try {
    rendered = _internal.renderLaunchSteps(project, engineProfile, {
      ...(renderContext || {}),
      startupRules: bundle,
      preflight: sequence.preflight,
      // Re-served with the same drift it was first rendered with. Leaving it
      // out would re-render step 3 without the drift section while the READY
      // gate still demanded a reconciliation for it — a requirement whose
      // stated reason had vanished from the text the agent is handed.
      ruleDrift: manifest.ruleDrift ?? null
    });
  // prawduct:allow prawduct/broad-except -- a render failure leaves the previous revision in
  // place, which is content the agent can still read; losing the sequence would be worse
  } catch (err) {
    log.warn('Launch steps could not be re-rendered for a rule change — the snapshot stands', {
      sequence: sequence.id, error: err.message
    });
    return unchanged;
  }

  const revision = sequence.revision + 1;
  const previous = new Map(steps.map((st) => [st.id, st]));
  // The drift is carried, never recomputed. It answers "what changed since the
  // PREVIOUS session's handoff", and a revision is this launch's own rules
  // moving — which says nothing about that comparison. Rebuilding the manifest
  // without carrying it would silently drop the reconciliation trigger the
  // agent was already shown in step 3.
  const nextManifest = {
    ...buildSourceManifest(project, engineProfile, bundle.rules || [], manifest.toolOutput, renderContext),
    ruleDrift: manifest.ruleDrift ?? null
  };
  const identityId = store.LAUNCH_STEP_IDS[0];
  const newSteps = store.LAUNCH_STEP_IDS.map((id, index) => {
    const content = rendered[id];
    const old = previous.get(id);
    const carries = id === identityId
      && old
      && nextManifest.globalRulesHash === manifest.globalRulesHash
      && old.content === content;
    if (carries) {
      return {
        index,
        id,
        content: old.content,
        digest: old.digest,
        pageOffsets: old.pageOffsets,
        carriedFromRevision: sequence.revision,
        pagesServed: old.pagesServed,
        servedAt: old.servedAt,
        ackedAt: old.ackedAt
      };
    }
    return {
      index,
      id,
      content,
      digest: stepDigest(content),
      pageOffsets: paginate(content, sequence.pageBudget),
      carriedFromRevision: null,
      pagesServed: [],
      servedAt: null,
      ackedAt: null
    };
  });
  // The first step this revision has no acknowledgement for. A carried step 1
  // keeps its own, so the cursor lands on step 2 rather than re-asking for
  // content the agent has already read and acknowledged unchanged.
  const cursor = newSteps.findIndex((st) => !st.ackedAt);
  const revisedSequence = store.launchSequences.revise(sequence.id, {
    revision,
    cursor: cursor === -1 ? newSteps.length : cursor,
    sourceManifest: nextManifest,
    steps: newSteps
  });
  store.activity.log({
    projectId: sequence.projectId,
    sessionId: sequence.sessionId,
    eventType: 'launch.snapshot_revised',
    detail: { sequenceId: sequence.id, revision, reason: REVISION_REASONS.RULES_CHANGED, carriedStep1: Boolean(newSteps[0].carriedFromRevision) }
  });
  log.info('Launch snapshot revised because the project rules changed', {
    sequence: sequence.id, revision, cursor: revisedSequence.cursor
  });
  return {
    sequence: revisedSequence,
    steps: store.launchSequences.listSteps(sequence.id, revision),
    revised: true,
    reason: REVISION_REASONS.RULES_CHANGED
  };
}

/**
 * The canonical form of a READY artifact, and its digest.
 *
 * Canonical means the fields the server accepted, in a fixed order, with
 * nothing else: a duplicate must be recognised as the same attestation however
 * the caller spelled its JSON, and a field the server ignored must not be able
 * to turn a duplicate into a conflict.
 * @param {object} artifact - The validated artifact
 * @param {object} sequence - The sequence it was accepted against
 * @returns {{canonical: object, digest: string}}
 */
function _canonicalReady(artifact, sequence) {
  const canonical = {
    schema: READY_SCHEMA,
    sequenceId: sequence.id,
    revision: sequence.revision,
    preflightVerdict: artifact.preflightVerdict,
    reconciliation: artifact.reconciliation ? String(artifact.reconciliation).trim() : null,
    proposedFirstAction: String(artifact.proposedFirstAction).trim()
  };
  return {
    canonical,
    digest: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  };
}

/**
 * Does this sequence's state require the agent to reconcile in writing before
 * it may attest?
 *
 * FOUR triggers, and the order below is the answer: the FIRST match supplies
 * the wording, because an agent handed a list cannot tell which gate it is
 * actually standing at.
 *
 * 1. An uncleared recovery in `advisory` mode — the only mode where a
 *    reconciliation can substitute for an operator's clear. In `operator` mode
 *    an uncleared recovery is not a reconciliation requirement at all: it is a
 *    refusal (`RECOVERY_UNCLEARED`), and reporting it here would tell an agent
 *    to write its way past a gate only a person can open.
 * 2. A snapshot revised under the agent, so part of what it acknowledged has
 *    been replaced.
 * 3. A preflight verdict that declares it. The verdict declares it as a field
 *    rather than being matched against a list of verdict names here, so the
 *    preflight owns which of its verdicts demand reconciliation.
 * 4. Governing rules that drifted since the previous session's handoff.
 *
 * Drift is last deliberately: each trigger above names a stronger condition,
 * and drift is the one an agent can most readily act on from step 3's own text.
 * @param {object} sequence - The sequence
 * @returns {string|null} Why one is required, or null
 */
function _reconciliationRequired(sequence) {
  if (sequence.recovery === 'required' && sequence.recoveryMode === 'advisory') {
    const verdict = (sequence.preflight && sequence.preflight.verdict) || 'unknown';
    return `this launch's preflight returned \`${verdict}\`, so its handoff state needs recovering, and this `
      + 'project clears recovery by reconciliation';
  }
  // ANY revision demands one — the plan's acceptance condition, unnarrowed.
  // What the earlier-revision read decides is the WORDING, not the requirement:
  // telling an agent that "part of what you acknowledged has been replaced"
  // when it had been served nothing states a proxy as a fact, which is the only
  // thing wrong with the strict rule.
  if (sequence.revision > 1) {
    return store.launchSequences.anyStepReadBefore(sequence.id, sequence.revision)
      ? `this launch's snapshot was revised to revision ${sequence.revision} after you had already been served part of it, so some of what you read has been replaced`
      : `this launch's snapshot was revised to revision ${sequence.revision} before you were served any of it, so the steps you read are not the ones this launch first rendered`;
  }
  const preflight = sequence.preflight;
  if (preflight && preflight.requiresReconciliation === true) {
    return `the launch preflight verdict \`${preflight.verdict}\` requires it: ${preflight.reason || 'no reason was recorded'}`;
  }
  // Rule drift (car 21.10). Last of the four, because each trigger above names a
  // stronger condition — an uncleared recovery, replaced content, a verdict that
  // demanded one — and the FIRST match supplies the wording. Drift added to one
  // of those would bury the reason that matters behind a list.
  //
  // Read from the frozen snapshot, never recomputed: the requirement has to be
  // the one step 3 stated. Only a source both manifests recorded can reach
  // `hasDrift`, so an unrecorded source never gates an attestation.
  const drift = sequence.sourceManifest && sequence.sourceManifest.ruleDrift;
  if (drift && drift.hasDrift) {
    return `the governing rules changed since the previous session's handoff — ${ruleDriftOf.driftSummary(drift)}`;
  }
  return null;
}

/**
 * Is this even a `tc.ready/1` artifact? The checks that need no sequence.
 *
 * Separated from the rest because they answer before the record does: whether
 * an artifact is well formed does not depend on whether this launch has already
 * attested, and routing a malformed one through the duplicate check would call
 * it a conflict with the stored artifact.
 * @param {object} artifact - The artifact as sent
 * @returns {{status: number, body: object}|null} A refusal, or null when the shape is fine
 */
function _readyShapeRefusal(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return _refuse(400, 'BAD_READY', `A READY attestation is a ${READY_SCHEMA} object; none was sent.`);
  }
  if (artifact.schema !== READY_SCHEMA) {
    return _refuse(400, 'BAD_READY', `A READY attestation carries "schema": "${READY_SCHEMA}".`);
  }
  if (typeof artifact.proposedFirstAction !== 'string' || artifact.proposedFirstAction.trim().length === 0) {
    return _refuse(400, 'BAD_READY',
      'A READY attestation states the first action you PROPOSE to take. It is a proposal, not an '
      + 'authorization: the operator\'s confirmation rules are unchanged.');
  }
  return null;
}

/**
 * Validate a `tc.ready/1` artifact against the sequence, or say why not.
 * @param {object} sequence - The sequence
 * @param {object[]} steps - Its steps at the current revision
 * @param {object} artifact - The artifact as sent
 * @returns {{refusal: {status: number, body: object}}|{ok: true}}
 */
function _validateReady(sequence, steps, artifact) {
  const shape = _readyShapeRefusal(artifact);
  if (shape) return { refusal: shape };
  if (Number.isInteger(artifact.revision) && artifact.revision !== sequence.revision) {
    return {
      refusal: _refuse(409, 'SNAPSHOT_REVISED',
        `The sequence is now at revision ${sequence.revision}; that attestation is for revision ${artifact.revision}. Run \`tc start next\` to read the current step.`,
        { revision: sequence.revision, cursor: sequence.cursor })
    };
  }
  const storedVerdict = (sequence.preflight && sequence.preflight.verdict) || null;
  if (artifact.preflightVerdict !== storedVerdict) {
    // The server's verdict is never echoed back in the refusal: the point of
    // the field is that the agent read step 3, and handing it the answer here
    // would let a retry pass without ever having read it.
    return {
      refusal: _refuse(409, 'READY_VERDICT_MISMATCH',
        'The preflight verdict in your attestation is not the one this launch recorded. Read step 3 again (`tc start next --page 0`) and attest with the verdict it states.',
        { cursor: sequence.cursor })
    };
  }
  // BEFORE the unacked-steps check, not after. In `operator` mode the task step
  // is withheld, so the cursor CANNOT reach the end while recovery stands —
  // answering `STEPS_UNACKED` would send the agent back to acknowledge a step
  // nothing will ever serve it, and it would loop there. The recovery refusal
  // is the actionable truth, and it names the person who can act.
  //
  // It also precedes the reconciliation check below, because in `operator` mode
  // no text satisfies this: the clear is a person's, and an attestation that
  // reconciled its way through would record consent nobody gave.
  if (sequence.recovery === 'required' && sequence.recoveryMode !== 'advisory') {
    return {
      refusal: _refuse(409, 'RECOVERY_UNCLEARED',
        `This launch's preflight returned \`${(sequence.preflight && sequence.preflight.verdict) || 'unknown'}\`, `
        + 'so its handoff state needs recovering, and this project clears recovery in OPERATOR mode. Ask the '
        + "operator to clear it from this project's Launch readiness panel; a reconciliation cannot stand in "
        + 'for that clear.',
        { recovery: sequence.recovery, recoveryMode: sequence.recoveryMode, recoveryRevision: sequence.recoveryRevision })
    };
  }
  if (sequence.cursor < steps.length) {
    return {
      refusal: _refuse(409, 'STEPS_UNACKED',
        `${steps.length - sequence.cursor} launch step(s) are not acknowledged yet. Run \`tc start next\` until every step is acknowledged, then attest.`,
        { cursor: sequence.cursor, of: steps.length })
    };
  }
  const needsReconciliation = _reconciliationRequired(sequence);
  if (needsReconciliation) {
    const text = typeof artifact.reconciliation === 'string' ? artifact.reconciliation.trim() : '';
    if (text.length < MIN_RECONCILIATION_CHARS) {
      return {
        refusal: _refuse(409, 'RECONCILIATION_REQUIRED',
          `This attestation needs a reconciliation of at least ${MIN_RECONCILIATION_CHARS} characters, because ${needsReconciliation}. Say what changed and what you are carrying forward.`,
          { reason: needsReconciliation, minChars: MIN_RECONCILIATION_CHARS })
      };
    }
  }
  return { ok: true };
}

/**
 * `POST /api/tc/start/ready`: record the agent's attestation that it read and
 * acknowledged its whole launch sequence.
 *
 * READY is **initialization, not task authorization**. It says the context
 * arrived and was read; it grants nothing, and the operator's resume and
 * confirmation rules are untouched by it. It is also an attestation by a local
 * process, so it carries no authentication meaning (§2.5).
 *
 * The recovery condition of §2.3 is evaluated here. An `operator`-mode launch
 * with an uncleared recovery is refused outright; an `advisory` one is accepted
 * only with a reconciliation, and the acceptance and the clearing land in ONE
 * transaction — a launch that is attested but still `required` would be a
 * session already running against a gate that never opened.
 * @param {object} args
 * @param {string|null} args.launchId - The pane's launch id
 * @param {number|null} args.projectId - The pane's project id
 * @param {object} args.artifact - The `tc.ready/1` artifact
 * @returns {{status: number, body: object}}
 */
function ready({ launchId, projectId, artifact }) {
  return store.launchSequences.transaction(() => {
    const resolved = _resolve({ launchId, projectId, mutating: true });
    if (resolved.refusal) return resolved.refusal;
    let sequence = resolved.sequence;
    if (sequence.applicability !== 'applicable') {
      return _refuse(409, 'SEQUENCE_NOT_APPLICABLE',
        `This session has no launch sequence to attest: ${sequence.notApplicableReason}.`,
        { reason: sequence.notApplicableReason });
    }
    let steps = store.launchSequences.listSteps(sequence.id, sequence.revision);
    // Shape first, before the record answers. A malformed artifact is malformed
    // whether or not this launch has attested, and answering it with
    // READY_CONFLICT would tell the caller its artifact differed from the stored
    // one when the truth is that it is not an artifact.
    const shape = _readyShapeRefusal(artifact);
    if (shape) return shape;
    // An accepted attestation answers from the record: a replay is idempotent
    // and a different artifact is a conflict. (The revision check below cannot
    // move an attested sequence either — `_reviseIfRulesChanged` refuses that
    // for every caller — so this is about the answer, not about the guard.)
    if (sequence.readyAt) {
      const { canonical, digest } = _canonicalReady(
        { ...artifact, revision: sequence.revision }, sequence
      );
      if (digest === sequence.readyDigest) {
        return { status: 200, body: { schema: READY_SCHEMA, accepted: true, duplicate: true, readyAt: sequence.readyAt, artifact: sequence.readyArtifact, status: _statusBlock(sequence) } };
      }
      return _refuse(409, 'READY_CONFLICT',
        'This launch has already attested READY with a different artifact. The attestation on record stands; nothing was changed.',
        { readyAt: sequence.readyAt, sent: canonical.schema });
    }

    const revision = _reviseIfRulesChanged(sequence, steps);
    sequence = revision.sequence;
    steps = revision.steps;
    if (revision.revised) {
      return _refuse(409, 'SNAPSHOT_REVISED',
        `The project rules changed while this launch was initializing, so steps were re-rendered at revision ${sequence.revision}. Run \`tc start next\` to read them, then attest with a reconciliation.`,
        { revision: sequence.revision, cursor: sequence.cursor, reason: revision.reason });
    }

    const validated = _validateReady(sequence, steps, artifact);
    if (validated.refusal) return validated.refusal;

    const { canonical, digest } = _canonicalReady(artifact, sequence);
    const recorded = store.launchSequences.markReady(sequence.id, sequence.revision, canonical, digest);
    if (recorded && sequence.recovery === 'required') {
      // Only `advisory` reaches here — `_validateReady` refused the other mode
      // above. `clearedBy` stays null: no operator was involved, and the
      // clearance word is what says who did.
      const cleared = store.launchSequences.clearRecovery(sequence.id, {
        sessionId: sequence.sessionId,
        recoveryRevision: sequence.recoveryRevision,
        clearance: 'agent-reconciled'
      });
      if (!cleared) {
        // Inside the same transaction as the attestation, so this throw rolls
        // BOTH back. An accepted READY beside a recovery still marked
        // `required` is the one state this car exists to make impossible, and a
        // half-written pair is worse than a refusal the agent can retry.
        throw new Error(
          `Launch sequence ${sequence.id} attested READY but its recovery could not be cleared at revision `
          + `${sequence.recoveryRevision}; neither was recorded.`
        );
      }
    }
    if (!recorded) {
      // Another request won the race inside this transaction's window. Whether
      // that is the same attestation or a different one is the stored digest's
      // answer, not a guess: re-read and route it through the same two outcomes.
      const current = store.launchSequences.getByLaunchId(launchId);
      if (current && current.readyDigest === digest) {
        return { status: 200, body: { schema: READY_SCHEMA, accepted: true, duplicate: true, readyAt: current.readyAt, artifact: current.readyArtifact, status: _statusBlock(current) } };
      }
      return _refuse(409, 'READY_CONFLICT',
        'This launch attested READY with a different artifact while this one was being validated. The attestation on record stands.',
        { readyAt: current ? current.readyAt : null });
    }
    const accepted = store.launchSequences.getByLaunchId(launchId);
    store.activity.log({
      projectId: sequence.projectId,
      sessionId: sequence.sessionId,
      eventType: 'launch.ready',
      detail: { sequenceId: sequence.id, revision: sequence.revision, reconciled: Boolean(canonical.reconciliation) }
    });
    if (sequence.recovery === 'required') {
      // The same event type the route's operator clear writes. One word names
      // clearances, so it has to cover all three of them: an operator reading
      // the activity log for `launch.recovery-cleared` would otherwise see a
      // history missing every clear an advisory session gave itself.
      store.activity.log({
        projectId: sequence.projectId,
        sessionId: sequence.sessionId,
        eventType: 'launch.recovery-cleared',
        detail: {
          sequenceId: sequence.id,
          clearance: 'agent-reconciled',
          clearedBy: null,
          recoveryRevision: sequence.recoveryRevision
        }
      });
    }
    log.info('Session attested its launch sequence READY', {
      sequence: sequence.id, session: sequence.sessionId, revision: sequence.revision
    });
    return {
      status: 200,
      body: {
        schema: READY_SCHEMA,
        accepted: true,
        duplicate: false,
        readyAt: accepted.readyAt,
        artifact: canonical,
        status: _statusBlock(accepted)
      }
    };
  });
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
    // Checked on every `next`, per §2.2: a snapshot is frozen against the rules
    // it was built from, so a rule edit mid-launch produces a NEW revision
    // rather than changing what an advertised digest covers. An ack for the old
    // revision then meets rule (e) below and is refused, never read as agreement
    // to content it never saw.
    const revision = _reviseIfRulesChanged(sequence, steps);
    sequence = revision.sequence;
    steps = revision.steps;
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
    const served = _serve(sequence, steps, servePage);
    if (revision.revised && served.status === 200) {
      // Never silently: an agent holding digests from the previous revision has
      // to learn they are dead, or it will ack content that no longer exists.
      served.body.revised = {
        code: 'SNAPSHOT_REVISED',
        reason: revision.reason,
        revision: sequence.revision
      };
    }
    return served;
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
      pageBudget: sequence.pageBudget,
      // The limit the pages were frozen against. `measured: false` means no
      // engine measurement exists and the conservative default was assumed —
      // the reader is told which, rather than shown a number of unstated origin.
      toolOutput: (sequence.sourceManifest && sequence.sourceManifest.toolOutput) || null,
      // Said plainly rather than published as a state the reader could take for
      // "checked and false" (the preflight's own shape).
      pending: PENDING_STAGES,
      // The attestation and the window, as recorded. `nudgeCount` counts nudges
      // SENT, so a session can see it was reminded — and the dashboard can see
      // it too, which is the point of keeping it on the row rather than in the
      // pruned activity log.
      // Whether this snapshot can be re-rendered faithfully if the rules change
      // under it. A sequence created before render contexts were recorded
      // re-renders from what is knowable then, and the gap is stated here
      // rather than left for a reader to infer from a thinner step 3.
      renderContext: sequence.sourceManifest && sequence.sourceManifest.renderContext ? 'recorded' : 'absent',
      readiness: {
        readyAt: sequence.readyAt,
        unreadyAt: sequence.unreadyAt,
        nudgeCount: sequence.nudgeCount,
        lastNudgedAt: sequence.lastNudgedAt,
        reconciliationRequired: _reconciliationRequired(sequence)
      },
      status: _statusBlock(sequence),
      steps: steps.map((st) => ({
        index: st.index,
        id: st.id,
        pageCount: st.pageCount,
        pagesServed: st.pagesServed,
        servedAt: st.servedAt,
        ackedAt: st.ackedAt,
        // Which revision this step's acknowledgement was made against. Set
        // only on a carry-over, and a carry-over happens only on byte-equal
        // content, so it reads as "acknowledged earlier, unchanged since".
        carriedFromRevision: st.carriedFromRevision
      }))
    }
  };
}

/**
 * Seams for the two renderers this module calls.
 *
 * Required lazily through here because `lib/sessions.js` requires this module
 * at load: the launch path builds a snapshot, and a revision re-renders one, so
 * the dependency genuinely runs both ways. A test replaces these to drive a
 * revision without a project on disk.
 * @type {{buildStartupRules: (projectId: number) => object,
 *   renderLaunchSteps: (project: object, engineProfile: object, options: object) => object}}
 */
const _internal = {
  buildStartupRules: (projectId) => require('./sessions').buildStartupRulesSection(projectId),
  renderLaunchSteps: (project, engineProfile, options) => require('./sessions').renderLaunchSteps(project, engineProfile, options)
};

module.exports = {
  // The module's contract: the launch path builds a snapshot, the routes serve,
  // advance and attest it. Everything below `ready` is reached only by tests,
  // which pin the pieces (pagination, budgets, applicability, rule identity)
  // that no single caller exercises on its own.
  LAUNCH_SCHEMA,
  READY_SCHEMA,
  MIN_RECONCILIATION_CHARS,
  DEFAULT_TOOL_OUTPUT_MAX_CHARS,
  MIN_PAGE_BUDGET,
  NOT_BOUND_RETRY_MS,
  LAUNCH_ID_PATTERN,
  PREFLIGHT_NOT_EVALUATED,
  mintLaunchId,
  resolveToolOutput,
  resolveApplicability,
  pageBudgetFor,
  paginate,
  pageIsContinued,
  buildSnapshot,
  ruleFingerprints,
  manifestFingerprints,
  next,
  ready,
  status,
  _reconciliationRequired,
  _internal
};
