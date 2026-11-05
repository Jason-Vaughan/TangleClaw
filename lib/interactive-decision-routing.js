'use strict';

/**
 * Interactive decision routing, Slice 2 (#2828, `v5.66.0` `Car 66-B`,
 * Architect Ruling `A503-R1`, `#2037` follow-up).
 *
 * Composes `lib/decision-routing.js`'s durable decision-request store with
 * five pieces of logic the issue's own "Routing and resume" section asks
 * for: detecting a native structured prompt in a captured pane, transitioning
 * a session/workload to a waiting state and resuming it once answered,
 * fanning a pending decision out to Dashboard/Medusa/Discord, evaluating
 * timed SLA escalation, and the pure decision function behind
 * lease-bound autonomy.
 *
 * **File envelope (Ruling A503-R1): this file and its test only.** Nothing
 * here requires or edits `server.js`, `public/index.html`, `lib/store.js`,
 * or `lib/decision-routing.js` itself -- it only calls that module's already
 * -exported functions. Every real side effect (persisting a session's
 * workload state, resuming a paused pane, actually notifying Dashboard /
 * Medusa / Discord) is an injectable seam in `deps`, defaulting to an inert
 * no-op. Mounting this onto a live entrypoint is `Milestone #54` /
 * `v5.67.0`, per the ruling -- same deferred-wiring shape
 * `lib/resource-leases.js` (#2014/#2071) already uses for the identical
 * reason: this car must stay 100% file-disjoint from the rest of this wave.
 *
 * @module lib/interactive-decision-routing
 */

const decisionRouting = require('./decision-routing');

/**
 * Claude Code's own `AskUserQuestion` widget footer markers (#2826,
 * verified against `lib/startup-dialog.js#_hasAskUserQuestionFooter` and its
 * own test fixtures in `test/startup-dialog-mid-session.test.js`) --
 * duplicated here rather than imported, because `lib/startup-dialog.js` is
 * outside this car's file envelope (Ruling A503-R1) and exports neither the
 * constant nor the function. A future car should export it there instead of
 * carrying two copies.
 * @type {ReadonlyArray<string>}
 */
const ASK_USER_QUESTION_FOOTER_MARKERS = Object.freeze(['Enter to select', 'navigate', 'Esc to cancel']);

/**
 * A numbered or cursor-marked choice line. Real shapes, verified against
 * `test/startup-dialog.test.js`/`test/startup-dialog-mid-session.test.js`'s
 * own fixtures: ` ❯ 1. Yes`, `   2. No`, `> 1. Option A`, `1) choice`.
 * @type {RegExp}
 */
const NUMBERED_CHOICE_RE = /^\s*(?:[❯>]\s*)?(\d+)[.)]\s+(\S.*)$/;

/**
 * An inline binary confirmation hint with no numbered menu at all, e.g.
 * `Continue? (y/n)`. A best-effort fallback for engines/prompts that render
 * this way instead of a numbered menu -- unlike the two patterns above, not
 * verified against a real captured sample in this repo, so documented as a
 * weaker signal.
 * @type {RegExp}
 */
const INLINE_CONFIRM_RE = /\((?:y\/n|yes\/no)\)|\[(?:y\/n|Y\/n|yes\/no)\]/i;

/**
 * Every hint fragment a live menu's own footer line is actually built from
 * (verified against the real captures {@link ASK_USER_QUESTION_FOOTER_MARKERS}
 * and `test/startup-dialog*.test.js`'s own fixtures cite), each anchored so
 * it must account for a WHOLE token of the line, never merely a prefix
 * before unrelated text continues (I-Gate Round 2, #2905: `/esc to cancel/i`
 * matched as an unanchored substring, so `"Esc to cancel ignored;
 * deployment finished"` -- real output that only happens to start with the
 * phrase -- passed as benign).
 * @type {RegExp}
 */
const _FOOTER_TOKEN_RE = /(?:esc to cancel|enter to (?:select|confirm|set as default)|s to use this session only|(?:↑\/↓\s+to\s+)?navigate)/i;

/**
 * A footer line's FULL content (after trimming) must be one or more
 * {@link _FOOTER_TOKEN_RE} tokens joined only by `·`, `,` or whitespace --
 * nothing else survives. Built with `new RegExp` rather than a literal so
 * `_FOOTER_TOKEN_RE`'s own flags/source are not duplicated by hand.
 * @type {RegExp}
 */
const _FOOTER_LINE_RE = new RegExp(`^${_FOOTER_TOKEN_RE.source}(?:[\\s,·]+${_FOOTER_TOKEN_RE.source})*$`, 'i');

/**
 * Whether a line, if found between a candidate choice run (or confirm line)
 * and the end of the captured pane, is harmless chrome rather than evidence
 * the prompt has already been answered: blank, a decorative border made
 * entirely of non-word, non-prompt-glyph characters (`▔▔▔▔`, `────`), or a
 * footer line built entirely from {@link _FOOTER_LINE_RE}'s own tokens.
 * @param {string} line
 * @returns {boolean}
 */
function _isBenignTrailingLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (NUMBERED_CHOICE_RE.test(line)) return true;
  // Any line built ONLY from shell/REPL prompt glyphs ($, >, ❯) -- alone,
  // repeated ("$$$", ">>>", "❯❯❯"), or followed by a typed command -- is
  // exactly the signal that the session moved on to a live prompt of its
  // own. Checked BEFORE the border check below (I-Gate Round 2, #2905: a
  // repeated ">>>"/"❯❯❯" REPL prompt satisfied the old, looser "3+ non-word
  // characters" border test) and excluded from that regex's own character
  // class as a second line of defense.
  if (/^[$❯>]+\s*(\S.*)?$/.test(trimmed)) return false;
  if (/^[^\w$❯>]{3,}$/.test(trimmed)) return true;
  if (_FOOTER_LINE_RE.test(trimmed)) return true;
  return false;
}

/**
 * Whether every line strictly after `afterIndex` (through the end of
 * `lines`) is {@link _isBenignTrailingLine} -- i.e. nothing in the capture
 * shows the prompt at `afterIndex` has already been answered and the
 * session has moved on (I-Gate Round 1, #2905: `_findChoiceRun` picking the
 * longest run anywhere in the buffer let a resolved menu from pane
 * scrollback still read as a live decision, because nothing checked what
 * came after it).
 * @param {string[]} lines
 * @param {number} afterIndex
 * @returns {boolean}
 */
function _nothingAfterDisqualifies(lines, afterIndex) {
  for (let i = afterIndex + 1; i < lines.length; i++) {
    if (!_isBenignTrailingLine(lines[i])) return false;
  }
  return true;
}

/**
 * The longest run of consecutive choice-shaped lines anywhere in `lines`
 * that is still LIVE -- not only a trailing run (a real captured frame
 * often has a footer line (`Esc to cancel`) or a blank line after the
 * last choice), but never a run some later, disqualifying output shows was
 * already answered (see {@link _nothingAfterDisqualifies}): a run whose
 * own trailing content disqualifies it is skipped entirely in favor of a
 * shorter, more recent run, rather than falling back to it.
 * @param {string[]} lines
 * @returns {{start: number, length: number}|null}
 */
function _findChoiceRun(lines) {
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && NUMBERED_CHOICE_RE.test(lines[i])) {
      if (curLen === 0) curStart = i;
      curLen++;
      continue;
    }
    if (curLen > 0 && curLen > bestLen && _nothingAfterDisqualifies(lines, curStart + curLen - 1)) {
      bestLen = curLen;
      bestStart = curStart;
    }
    curLen = 0;
  }
  return bestLen > 0 ? { start: bestStart, length: bestLen } : null;
}

/**
 * The nearest non-blank line strictly above `beforeIndex`, or `null` when
 * every line above is blank (or `beforeIndex` is 0).
 * @param {string[]} lines
 * @param {number} beforeIndex
 * @returns {string|null}
 */
function _nearestNonBlankAbove(lines, beforeIndex) {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Structured prompt detection for an interactive session decision: Claude
 * Code's own `AskUserQuestion` widget, a generic numbered choice menu, or an
 * inline confirmation hint. Pure text-pattern matching over already-captured
 * pane lines -- no tmux, no I/O, nothing engine-specific beyond the patterns
 * themselves.
 *
 * Detection order: a numbered/cursor-marked choice run of at least
 * `opts.minChoices` lines (tagged `'ask-user-question'` when the captured
 * frame also carries Claude Code's own footer markers, else
 * `'numbered-choice'`), else a bare inline `(y/n)`-shaped hint
 * (`'confirmation'`), else `null`.
 * @param {string[]|string} paneLines - Captured pane rows, or one string split on `\n`
 * @param {object} [opts]
 * @param {number} [opts.minChoices] - Minimum consecutive choice lines to count as a menu (default 2 -- `lib/decision-routing.js#createDecisionRequest`'s own floor)
 * @param {number} [opts.maxLookback] - Only consider the last N lines (default: all of them)
 * @returns {{kind: 'ask-user-question'|'numbered-choice'|'confirmation', prompt: (string|null), choices: string[], recommendation: null}|null}
 */
function detectInteractiveDecisionPrompt(paneLines, opts = {}) {
  const allLines = Array.isArray(paneLines) ? paneLines : String(paneLines == null ? '' : paneLines).split('\n');
  const minChoices = Number.isFinite(opts.minChoices) ? opts.minChoices : 2;
  const lookback = Number.isFinite(opts.maxLookback) && opts.maxLookback > 0 ? opts.maxLookback : allLines.length;
  const lines = allLines.slice(Math.max(0, allLines.length - lookback));

  const run = _findChoiceRun(lines);
  if (run && run.length >= minChoices) {
    const choices = lines.slice(run.start, run.start + run.length)
      .map((line) => line.match(NUMBERED_CHOICE_RE)[2].trim());
    const hasAskUserQuestionFooter = ASK_USER_QUESTION_FOOTER_MARKERS.every((marker) => lines.join('\n').includes(marker));
    return {
      kind: hasAskUserQuestionFooter ? 'ask-user-question' : 'numbered-choice',
      prompt: _nearestNonBlankAbove(lines, run.start),
      choices,
      recommendation: null
    };
  }

  // Scans from the end backward, same unbounded-historical-search risk as
  // the numbered-choice path above: the nearest-to-end match is returned
  // only once nothing after it disqualifies it (I-Gate Round 1, #2905) --
  // an EARLIER confirm line with real output after it is stale, and no
  // shorter/older match is searched for once that happens.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (INLINE_CONFIRM_RE.test(lines[i])) {
      if (!_nothingAfterDisqualifies(lines, i)) return null;
      return { kind: 'confirmation', prompt: lines[i].trim(), choices: ['yes', 'no'], recommendation: null };
    }
  }

  return null;
}

/**
 * Default deps for the composition functions below: real where composing
 * `lib/decision-routing.js` is exactly this car's job (creating/answering the
 * durable record), inert no-ops everywhere this car's envelope stops short
 * of real wiring (session persistence, resume, routing fan-out) -- Milestone
 * #54 replaces each no-op with the real thing, by injecting a real `deps`,
 * never by editing this file.
 * @type {object}
 */
const _defaultDeps = Object.freeze({
  createDecisionRequest: decisionRouting.createDecisionRequest,
  answerDecisionRequest: decisionRouting.answerDecisionRequest,
  getDecisionRequest: decisionRouting.getDecisionRequest,
  resolveDecisionAuthorityPolicy: decisionRouting.resolveDecisionAuthorityPolicy,
  now: () => new Date().toISOString(),
  /** Called with the computed session/workload transition. No-op by default -- see module docstring. */
  onSessionTransition: () => {},
  /** Called to actually resume a paused session once its decision is answered. No-op by default. */
  resumeSession: () => ({ resumed: false, reason: 'NO_RESUME_HOOK_PROVIDED' })
});

/**
 * Transition a session's workload to `WAITING_DECISION` for one freshly
 * detected prompt, and durably record the decision request behind it.
 *
 * Does not itself persist anything onto the `sessions` table: `status` there
 * has exactly one non-terminal value today (`active` --
 * `lib/store/sessions.js#getActive`'s own doc), so writing a second one
 * would silently break `getActive`/`_isLaunchCurrent` for this very session
 * -- the opposite of this car's job. The session/workload transition is
 * computed and handed to `deps.onSessionTransition` (a future car wires the
 * real mechanism, e.g. `tc workload set`, in Milestone #54); the decision
 * itself is the durable, queryable fact (`lib/decision-routing.js`'s own
 * `WAITING_DECISION` state).
 * @param {{id: number, projectId: number, launchId: string}} session
 * @param {object} promptDescriptor - From {@link detectInteractiveDecisionPrompt}, or caller-supplied in the same shape, plus whatever of the optional fields below it wants to set
 * @param {string} promptDescriptor.prompt
 * @param {string[]} promptDescriptor.choices
 * @param {string} [promptDescriptor.kind] - Defaults `gate` when `gate` is omitted
 * @param {string} [promptDescriptor.recommendation]
 * @param {string} [promptDescriptor.idemKey] - Defaults to a digest of the prompt + choices, stable across retries of the same detected prompt
 * @param {string} [promptDescriptor.requiredAuthority] - One of `lib/decision-routing.js#AUTHORITY_CLASSES`; defaults to the project's configured policy via `deps.resolveDecisionAuthorityPolicy`
 * @param {string} [promptDescriptor.gate] - Defaults to `promptDescriptor.kind`
 * @param {boolean} [promptDescriptor.reversible]
 * @param {number} [promptDescriptor.ttlMs] - Defaults to 30 minutes
 * @param {object} [promptDescriptor.projectConfig] - Passed through to `deps.resolveDecisionAuthorityPolicy` when `requiredAuthority` is omitted
 * @param {string} [promptDescriptor.headSha]
 * @param {object} [deps] - See {@link _defaultDeps}
 * @returns {{ok: true, decision: object, transition: object, replay?: true}|{ok: false, code: string, message: string}}
 */
function transitionToWaitingDecision(session, promptDescriptor, deps = {}) {
  const d = { ..._defaultDeps, ...deps };
  if (!session || !Number.isFinite(session.id) || !Number.isFinite(session.projectId) || !session.launchId) {
    return { ok: false, code: 'SESSION_INVALID', message: 'session must carry {id, projectId, launchId}.' };
  }
  if (!promptDescriptor || typeof promptDescriptor.prompt !== 'string' || !Array.isArray(promptDescriptor.choices)) {
    return { ok: false, code: 'PROMPT_DESCRIPTOR_INVALID', message: 'promptDescriptor must carry {prompt, choices}.' };
  }
  const gate = promptDescriptor.gate || promptDescriptor.kind || 'interactive-decision';
  const idemKey = promptDescriptor.idemKey
    || `${promptDescriptor.kind || 'prompt'}:${promptDescriptor.prompt}:${promptDescriptor.choices.join('|')}`.slice(0, 128);
  const requiredAuthority = promptDescriptor.requiredAuthority
    || d.resolveDecisionAuthorityPolicy(promptDescriptor.projectConfig || {});

  const created = d.createDecisionRequest({
    idemKey,
    projectId: session.projectId,
    sessionId: session.id,
    launchId: session.launchId,
    headSha: promptDescriptor.headSha,
    prompt: promptDescriptor.prompt,
    choices: promptDescriptor.choices,
    recommendation: promptDescriptor.recommendation,
    requiredAuthority,
    gate,
    reversible: Boolean(promptDescriptor.reversible),
    ttlMs: Number.isFinite(promptDescriptor.ttlMs) ? promptDescriptor.ttlMs : 30 * 60 * 1000
  });
  if (!created.ok) return created;

  const transition = {
    sessionId: session.id,
    projectId: session.projectId,
    workload: 'blocked',
    reason: 'waiting_decision',
    decisionId: created.request.decisionId
  };
  d.onSessionTransition(transition);
  return { ok: true, decision: created.request, transition, replay: created.replay };
}

/**
 * Answer a decision request and, when that succeeds, compute and attempt
 * the session resume that follows. The answer itself goes through
 * `lib/decision-routing.js#answerDecisionRequest` unchanged (Operator-only,
 * per that module's own standing ruling -- this function enforces nothing
 * additional and relaxes nothing). The resume step is `deps.resumeSession`,
 * an injectable seam with no real default: this car's envelope does not
 * include whatever actually types into or releases a paused pane (that is
 * `lib/lifecycle-handoff.js`'s domain for session REPLACEMENT, a different
 * mechanism from resuming the SAME session after a decision, and neither
 * exists for this purpose yet -- Milestone #54).
 * @param {string} decisionId
 * @param {{answer: string, answeredByActor: string, expectedPromptDigest: string, auditRationale?: string}} resolution
 * @param {object} [deps] - See {@link _defaultDeps}
 * @returns {{ok: true, decision: object, resume: object, replay?: true}|{ok: false, code: string, message: string, request?: object}}
 */
function resolveDecisionAndResume(decisionId, resolution, deps = {}) {
  const d = { ..._defaultDeps, ...deps };
  const answered = d.answerDecisionRequest(decisionId, {
    answer: resolution && resolution.answer,
    answeredBySurface: 'operator',
    answeredByActor: (resolution && resolution.answeredByActor) || 'operator',
    expectedPromptDigest: resolution && resolution.expectedPromptDigest,
    auditRationale: resolution && resolution.auditRationale
  });
  if (!answered.ok) return answered;

  const resume = d.resumeSession(
    { id: answered.request.sessionId, projectId: answered.request.projectId, launchId: answered.request.launchId },
    answered.request
  );
  return { ok: true, decision: answered.request, resume: resume || { resumed: false, reason: 'RESUME_HOOK_RETURNED_NOTHING' }, replay: answered.replay };
}

/**
 * Every routing target this module knows the name of. `routeDecisionRequest`
 * refuses an unknown target rather than silently skipping it, so a typo in
 * `targets` surfaces immediately instead of just never notifying anyone.
 * @type {ReadonlyArray<string>}
 */
const ROUTING_TARGETS = Object.freeze(['dashboard', 'medusa', 'discord']);

/**
 * Fan a pending decision out across Dashboard, Medusa, and Discord adapter
 * callbacks. Each target is an injectable `deps[target](decision)` function;
 * with none supplied, every target is "skipped, no adapter" -- calling this
 * with no `deps` is always safe and does nothing (the opt-in-by-default
 * framing the ruling asks for). A target's own callback throwing is caught
 * and reported as a per-target failure rather than aborting the other
 * targets' delivery.
 * @param {object} decision - A decision record, as {@link decisionRouting.getDecisionRequest} returns
 * @param {string[]} targets - A subset of {@link ROUTING_TARGETS}
 * @param {object} [deps] - `{dashboard?, medusa?, discord?}`, each `(decision) => *`
 * @returns {{routed: Array<{target: string, ok: boolean, result?: *, error?: string}>, skipped: Array<{target: string, reason: string}>}}
 */
function routeDecisionRequest(decision, targets, deps = {}) {
  const routed = [];
  const skipped = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!ROUTING_TARGETS.includes(target)) {
      skipped.push({ target, reason: 'UNKNOWN_TARGET' });
      continue;
    }
    const adapter = deps[target];
    if (typeof adapter !== 'function') {
      skipped.push({ target, reason: 'NO_ADAPTER_PROVIDED' });
      continue;
    }
    try {
      routed.push({ target, ok: true, result: adapter(decision) });
    } catch (err) {
      routed.push({ target, ok: false, error: err.message });
    }
  }
  return { routed, skipped };
}

/**
 * Deterministic timed SLA escalation: which `WAITING_DECISION` requests, out
 * of `decisions`, have waited past their class's SLA window as of `nowMs`.
 * Pure function of its own three arguments -- no clock read inside it, so a
 * caller supplies `nowMs` once and gets the exact same answer forever after
 * (the same discipline that avoided the `AbortSignal.timeout()` real-timer
 * race elsewhere in this codebase: a test fixes `nowMs`, never a live clock).
 * Payload shape mirrors `lib/model-switch.js#checkDeciderOutageEscalation`'s
 * existing `{kind: 'operator-action-required', text, receipts}` convention.
 * @param {object[]} decisions - Decision records, as {@link decisionRouting.listDecisionRequestsForProject} returns
 * @param {number} nowMs - Epoch ms to evaluate against
 * @param {{defaultSlaMs?: number, slaMsByAuthority?: Record<string, number>}} [slaOpts]
 * @returns {{escalations: Array<{decisionId: string, ageMs: number, slaMs: number, payload: {kind: string, text: string, receipts: []}}>}}
 */
function evaluateDecisionSlaEscalation(decisions, nowMs, slaOpts = {}) {
  const defaultSlaMs = Number.isFinite(slaOpts.defaultSlaMs) ? slaOpts.defaultSlaMs : 30 * 60 * 1000;
  const slaMsByAuthority = slaOpts.slaMsByAuthority || {};
  const escalations = [];
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!decision || decision.state !== decisionRouting.STATES.WAITING_DECISION) continue;
    const slaMs = Number.isFinite(slaMsByAuthority[decision.requiredAuthority])
      ? slaMsByAuthority[decision.requiredAuthority]
      : defaultSlaMs;
    const createdMs = Date.parse(decision.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = nowMs - createdMs;
    if (ageMs < slaMs) continue;
    escalations.push({
      decisionId: decision.decisionId,
      ageMs,
      slaMs,
      payload: {
        kind: 'operator-action-required',
        text: `Decision "${decision.gate}" (${decision.requiredAuthority}) has waited `
          + `${Math.round(ageMs / 60000)}m past its ${Math.round(slaMs / 60000)}m SLA: ${decision.prompt}`,
        receipts: []
      }
    });
  }
  return { escalations };
}

/**
 * The pure decision function behind `autonomous-within-lease`: whether a
 * SERVER-VERIFIED `lease` already covers this decision for this caller.
 *
 * **This function grants nothing by itself and is called by nothing in this
 * car.** `lib/decision-routing.js`'s own docstring records that PRR-B
 * rejected self-answering `autonomous-within-lease` twice on #2037 -- once
 * for trusting a caller's own project-config allowlist, once more for
 * trusting a caller-supplied `gate`/`reversible` label with no server-side
 * verification behind it -- and concluded real lease-bound autonomy needs
 * "a server-verified scoped action/lease the `gate` name resolves to...
 * which is new infrastructure, not a fix to what is here." That
 * infrastructure does not exist yet (checked: `lib/resource-leases.js`
 * (#2014/#2071) is a different domain -- Resource Module leases, not
 * decision-authority leases). This function is that future infrastructure's
 * eventual decision layer, built now as a pure, fully testable evaluator:
 * it trusts `lease`'s OWN fields as already server-verified (never derives
 * or re-resolves them from `decision.gate`/`decision.reversible`, which
 * remain exactly the unverified descriptive metadata #2037 documented them
 * as), and makes no claim about where a real `lease` object would come
 * from. `lib/decision-routing.js#answerDecisionRequest` remains
 * Operator-only regardless of what this function returns, today and until
 * a future car wires real lease issuance/verification and an Architect
 * ruling explicitly authorizes using this function's output to relax that.
 *
 * **`verification.serverVerifiedGate`, not `decision.gate`, is what the
 * lease's `scopeGate` is checked against (I-Gate Round 1, #2905).**
 * `decision.gate` repeats the exact scope-laundering gap #2037's own Round
 * 2 finding closed: it is session-supplied at decision-creation time
 * (`lib/decision-routing.js`'s create route forwards `body.gate` directly
 * and documents it as descriptive metadata, never a verified action
 * identity), so a session can label an unrelated, dangerous prompt with
 * whatever gate name it knows a lease already covers. At this function's
 * own boundary that forgery is indistinguishable from a legitimate match
 * UNLESS the caller supplies an independent binding it resolved itself,
 * never derived from `decision.gate` -- `verification.serverVerifiedGate`
 * is exactly that, required and checked in `decision.gate`'s place; its
 * absence fails closed rather than silently falling back to the
 * unverified field.
 * @param {{decisionId: string, requiredAuthority: string, gate: string, projectId: number, state: string}} decision
 * @param {{state: string, expiresAtMs: number, scopeGate: string, projectId: number, grantedToRole: string}} lease - Presumed already server-verified; this function does not and cannot verify it itself
 * @param {{role: string}} caller
 * @param {{serverVerifiedGate: string}} verification - The caller's OWN
 *   independently-resolved binding of this decision to a real action/gate
 *   identity -- never read from `decision.gate`. Required; its absence or
 *   any non-string value fails closed.
 * @returns {{allowed: boolean, reason: (string|null)}}
 */
function evaluateAutonomousWithinLease(decision, lease, caller, verification) {
  if (!decision || decision.requiredAuthority !== 'autonomous-within-lease') {
    return { allowed: false, reason: 'DECISION_NOT_LEASE_SCOPED' };
  }
  if (decision.state !== decisionRouting.STATES.WAITING_DECISION) {
    return { allowed: false, reason: 'DECISION_NOT_WAITING' };
  }
  if (!lease || typeof lease !== 'object') {
    return { allowed: false, reason: 'LEASE_MISSING' };
  }
  if (lease.state !== 'active') {
    return { allowed: false, reason: 'LEASE_NOT_ACTIVE' };
  }
  if (!Number.isFinite(lease.expiresAtMs) || lease.expiresAtMs <= Date.now()) {
    return { allowed: false, reason: 'LEASE_EXPIRED' };
  }
  if (lease.projectId !== decision.projectId) {
    return { allowed: false, reason: 'LEASE_PROJECT_MISMATCH' };
  }
  if (!verification || typeof verification.serverVerifiedGate !== 'string' || !verification.serverVerifiedGate) {
    return { allowed: false, reason: 'SERVER_VERIFIED_GATE_MISSING' };
  }
  if (lease.scopeGate !== verification.serverVerifiedGate) {
    return { allowed: false, reason: 'LEASE_SCOPE_MISMATCH' };
  }
  if (!caller || !['architect', 'pm'].includes(caller.role)) {
    return { allowed: false, reason: 'CALLER_NOT_AUTHORIZED_CLASS' };
  }
  if (lease.grantedToRole !== caller.role) {
    return { allowed: false, reason: 'LEASE_ROLE_MISMATCH' };
  }
  return { allowed: true, reason: null };
}

module.exports = {
  ASK_USER_QUESTION_FOOTER_MARKERS,
  detectInteractiveDecisionPrompt,
  transitionToWaitingDecision,
  resolveDecisionAndResume,
  ROUTING_TARGETS,
  routeDecisionRequest,
  evaluateDecisionSlaEscalation,
  evaluateAutonomousWithinLease,
  _defaultDeps,
  _findChoiceRun,
  _nearestNonBlankAbove
};
