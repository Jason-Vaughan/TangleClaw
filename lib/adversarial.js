'use strict';

/**
 * Adversarial Agent primitive (#108) — a TC-level mechanism any methodology can call to
 * get structured, adversarial/red-team findings against a code surface.
 *
 * TC owns ONLY: building the adversarial prompt, invoking an INJECTED `spawnSubagent`
 * function with it, validating/parsing the returned JSON against the findings schema,
 * filtering by severity/cap, and recording disposition audit entries. TC never decides
 * WHEN to call this (that is the calling methodology's policy) and never calls an LLM API
 * itself — `spawnSubagent` is supplied by the caller (the engine's own Agent-tool
 * plumbing), exactly like `lib/actions/invoke-critic.js`'s injectable `_internal` seam.
 * This module imports no HTTP/LLM client; `test/adversarial.test.js` asserts that
 * structurally.
 */

/** Finding categories the schema accepts. */
const CATEGORIES = [
  'boundary',
  'malformed_input',
  'concurrency',
  'security',
  'encoding',
  'resource_exhaustion',
  'other'
];

/** Finding severities, most to least severe. */
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

/** Severity rank for sorting/thresholding (higher = more severe). */
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * Disposition values the methodology must record per finding. Silent ignoring is
 * forbidden — every finding presented to a human/agent must land in one of these.
 */
const DISPOSITIONS = ['regression_test', 'defensive_code', 'documented_non_issue', 'follow_up_issue'];

/** Default constitution TC ships; a methodology may override it per call. */
const DEFAULT_CONSTITUTION = `You are an expert adversarial tester. Your only job is to break the code. Be creative, mean, and thorough.

Given the function requirements and the current implementation, generate the most difficult, nasty edge cases you can think of. Think like a hacker trying to break this code.

Focus especially on:
- Extreme values and boundary conditions
- Unexpected data types and malformed inputs
- Race conditions and concurrency issues
- Security vulnerabilities
- Empty, null, or massive inputs
- Internationalization and encoding edge cases

For each test case, explain exactly why it might break the code. Do not be nice. Try to destroy it.

PRIORITIZATION — at the end, rank your top 5 findings by likelihood x impact.

DO NOT generate findings that aren't actually exploitable or reachable from the documented input surface — false positives are worse than false negatives here, they teach the developer to ignore you.

OUTPUT — strict JSON matching the findings schema (see lib/adversarial.js#runAdversarialPass docs).`;

/** Default adversarial personas; at least three are enforced per pass via the prompt. */
const DEFAULT_PERSONAS = [
  'A malicious user trying to extract data they shouldn’t have access to.',
  'A confused user pasting random shit into the wrong field.',
  'A non-English-speaker hitting Unicode + RTL + emoji + zero-width-joiner edge cases.',
  'A power user automating this at 1000 req/sec.',
  'A script kiddie with curl and Burp Suite.',
  'An honest user who fat-fingers a value 100x larger than expected.'
];

/**
 * Describe a surface ({ files, symbols, endpoints }) as prompt text. Any missing/wrong-type
 * field is treated as empty rather than thrown on, since this only feeds prompt text.
 *
 * @param {{files?: string[], symbols?: string[], endpoints?: string[]}} surface
 * @returns {string}
 */
function describeSurface(surface) {
  const files = Array.isArray(surface.files) ? surface.files : [];
  const symbols = Array.isArray(surface.symbols) ? surface.symbols : [];
  const endpoints = Array.isArray(surface.endpoints) ? surface.endpoints : [];

  const lines = [];
  if (files.length) lines.push(`Files: ${files.join(', ')}`);
  if (symbols.length) lines.push(`Symbols: ${symbols.join(', ')}`);
  if (endpoints.length) lines.push(`Endpoints: ${endpoints.join(', ')}`);
  return lines.length ? lines.join('\n') : '(no surface detail supplied)';
}

/**
 * Build the full adversarial prompt from a constitution, surface, and persona list.
 *
 * @param {{constitution: string, surface: object, personas: string[]}} parts
 * @returns {string}
 */
function buildAdversarialPrompt({ constitution, surface, personas }) {
  const effectivePersonas = Array.isArray(personas) && personas.length ? personas : DEFAULT_PERSONAS;
  return [
    constitution || DEFAULT_CONSTITUTION,
    '',
    'PERSPECTIVE-SHIFTING — adopt at least three of these adversarial personas:',
    effectivePersonas.map((p) => `- ${p}`).join('\n'),
    '',
    'SURFACE UNDER TEST:',
    describeSurface(surface || {})
  ].join('\n');
}

/**
 * Validate and normalize a subagent's raw adversarial output against the findings schema.
 * Declines rather than throws on anything malformed — a validator that crashed the caller
 * on bad subagent output would be worse than one that reports why it declined.
 *
 * @param {*} raw - The subagent's raw output: a JSON string, or an already-parsed object.
 * @returns {{valid: true, errors: [], output: {findings: object[], top_5_prioritized: string[]}}
 *          |{valid: false, errors: string[], output: null}}
 */
function validateAdversarialOutput(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { valid: false, errors: [`output is not valid JSON: ${err.message}`], output: null };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, errors: ['output must be a JSON object'], output: null };
  }
  if (!Array.isArray(parsed.findings)) {
    return { valid: false, errors: ['output.findings must be an array'], output: null };
  }

  const errors = [];
  const seenIds = new Set();
  const findings = [];

  parsed.findings.forEach((f, i) => {
    const prefix = `findings[${i}]`;
    if (!f || typeof f !== 'object') {
      errors.push(`${prefix} must be an object`);
      return;
    }

    const id = typeof f.id === 'string' && f.id.trim() ? f.id : `finding_${i + 1}`;
    if (seenIds.has(id)) {
      errors.push(`${prefix} duplicate id "${id}"`);
      return;
    }
    if (!CATEGORIES.includes(f.category)) {
      errors.push(`${prefix}.category "${f.category}" must be one of ${CATEGORIES.join('|')}`);
      return;
    }
    if (!SEVERITIES.includes(f.severity)) {
      errors.push(`${prefix}.severity "${f.severity}" must be one of ${SEVERITIES.join('|')}`);
      return;
    }
    if (typeof f.scenario !== 'string' || !f.scenario.trim()) {
      errors.push(`${prefix}.scenario must be a non-empty string`);
      return;
    }
    if (typeof f.why_it_breaks !== 'string' || !f.why_it_breaks.trim()) {
      errors.push(`${prefix}.why_it_breaks must be a non-empty string`);
      return;
    }
    if (typeof f.suggested_test !== 'string' || !f.suggested_test.trim()) {
      errors.push(`${prefix}.suggested_test must be a non-empty string`);
      return;
    }

    seenIds.add(id);
    findings.push({
      id,
      category: f.category,
      severity: f.severity,
      scenario: f.scenario,
      why_it_breaks: f.why_it_breaks,
      suggested_test: f.suggested_test
    });
  });

  if (errors.length) return { valid: false, errors, output: null };

  const top5 = Array.isArray(parsed.top_5_prioritized)
    ? parsed.top_5_prioritized.filter((id) => typeof id === 'string')
    : [];

  return { valid: true, errors: [], output: { findings, top_5_prioritized: top5 } };
}

/**
 * Filter validated findings by a minimum severity threshold, cap the result at
 * `maxFindings` (highest severity first), and trim the subagent's own prioritized-id
 * list down to ids that survived filtering.
 *
 * @param {{findings: object[], top_5_prioritized?: string[]}} output - A validated output
 *   (the `output` field of a `validateAdversarialOutput` result with `valid: true`).
 * @param {{severityThreshold?: string, maxFindings?: number}} [options]
 * @returns {{findings: object[], top5: string[]}}
 */
function filterAndPrioritizeFindings(output, options = {}) {
  const { severityThreshold = 'low', maxFindings } = options;
  const thresholdRank = SEVERITY_RANK[severityThreshold];
  if (!thresholdRank) return { findings: [], top5: [] };

  const findings = Array.isArray(output && output.findings) ? output.findings : [];
  const top5Input = Array.isArray(output && output.top_5_prioritized) ? output.top_5_prioritized : [];

  let kept = findings.filter((f) => (SEVERITY_RANK[f.severity] || 0) >= thresholdRank);
  kept = kept
    .slice()
    .sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

  if (Number.isInteger(maxFindings) && maxFindings >= 0) {
    kept = kept.slice(0, maxFindings);
  }

  const keptIds = new Set(kept.map((f) => f.id));
  const top5 = top5Input.filter((id) => keptIds.has(id)).slice(0, 5);

  return { findings: kept, top5 };
}

/**
 * Run one adversarial pass: build the prompt, invoke the caller-supplied `spawnSubagent`,
 * validate its output, and filter/prioritize the result. TC makes no LLM call of its own —
 * `spawnSubagent` is the methodology's own Agent-tool plumbing (or a test double).
 *
 * Never throws: every failure mode (missing surface, missing spawnSubagent, a thrown
 * spawnSubagent, malformed subagent output) returns `{ ok: false, output: null, error }`.
 *
 * @param {object} options
 * @param {string} [options.constitution] - Overrides {@link DEFAULT_CONSTITUTION}.
 * @param {{files?: string[], symbols?: string[], endpoints?: string[]}} options.surface - Required.
 * @param {string} [options.severityThreshold='low'] - One of {@link SEVERITIES}.
 * @param {string[]} [options.personas] - Overrides {@link DEFAULT_PERSONAS}.
 * @param {number} [options.maxFindings] - Caps returned findings (highest severity first).
 * @param {(prompt: string) => (string|object|Promise<string|object>)} options.spawnSubagent -
 *   Required. The caller's own subagent-spawn mechanism; receives the built prompt and
 *   returns the subagent's raw JSON output (string or already-parsed object).
 * @returns {Promise<{ok: true, output: {findings: object[], top5PrioritizedIds: string[]}, error: null}
 *          |{ok: false, output: null, error: string}>}
 */
async function runAdversarialPass(options = {}) {
  const {
    constitution,
    surface,
    severityThreshold = 'low',
    personas,
    maxFindings,
    spawnSubagent
  } = options;

  if (!surface || typeof surface !== 'object') {
    return { ok: false, output: null, error: 'runAdversarialPass requires options.surface ({ files, symbols, endpoints })' };
  }
  if (typeof spawnSubagent !== 'function') {
    return {
      ok: false,
      output: null,
      error: 'runAdversarialPass requires options.spawnSubagent(prompt) — the caller supplies the mechanism; this module never calls an LLM API itself'
    };
  }
  if (!SEVERITIES.includes(severityThreshold)) {
    return { ok: false, output: null, error: `severityThreshold must be one of ${SEVERITIES.join(', ')}` };
  }

  const prompt = buildAdversarialPrompt({ constitution, surface, personas });

  let rawOutput;
  try {
    rawOutput = await spawnSubagent(prompt);
  } catch (err) {
    return { ok: false, output: null, error: `spawnSubagent threw: ${err && err.message ? err.message : String(err)}` };
  }

  const validated = validateAdversarialOutput(rawOutput);
  if (!validated.valid) {
    return { ok: false, output: null, error: `malformed adversarial subagent output: ${validated.errors.join('; ')}` };
  }

  const { findings, top5 } = filterAndPrioritizeFindings(validated.output, { severityThreshold, maxFindings });

  return { ok: true, output: { findings, top5PrioritizedIds: top5 }, error: null };
}

/**
 * Record a disposition for each adversarial finding presented to a human/agent. Forbids
 * silent ignoring: every entry must name a finding id, one of {@link DISPOSITIONS}, and a
 * non-empty rationale. Writes to an injectable `store` function (preferred for tests) or
 * appends JSON lines to `auditLogPath`; never throws on malformed input.
 *
 * @param {Array<{findingId: string, disposition: string, rationale: string, ref?: string}>} dispositions
 * @param {{store?: (records: object[]) => void, auditLogPath?: string}} [options] - Exactly
 *   one of `store`/`auditLogPath` is required.
 * @returns {{ok: true, recorded: object[], error: null}|{ok: false, recorded: [], error: string}}
 */
function recordAdversarialDispositions(dispositions, options = {}) {
  const { store, auditLogPath } = options;

  if (!Array.isArray(dispositions) || dispositions.length === 0) {
    return { ok: false, recorded: [], error: 'recordAdversarialDispositions requires a non-empty dispositions array' };
  }
  if (typeof store !== 'function' && !auditLogPath) {
    return { ok: false, recorded: [], error: 'recordAdversarialDispositions requires options.store or options.auditLogPath' };
  }

  const errors = [];
  const recorded = [];
  const timestamp = new Date().toISOString();

  dispositions.forEach((d, i) => {
    const prefix = `dispositions[${i}]`;
    if (!d || typeof d !== 'object') {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (typeof d.findingId !== 'string' || !d.findingId.trim()) {
      errors.push(`${prefix}.findingId must be a non-empty string`);
      return;
    }
    if (!DISPOSITIONS.includes(d.disposition)) {
      errors.push(`${prefix}.disposition "${d.disposition}" must be one of ${DISPOSITIONS.join('|')}`);
      return;
    }
    if (typeof d.rationale !== 'string' || !d.rationale.trim()) {
      errors.push(`${prefix}.rationale must be a non-empty string — silent ignoring is forbidden`);
      return;
    }

    recorded.push({
      findingId: d.findingId,
      disposition: d.disposition,
      rationale: d.rationale,
      ref: typeof d.ref === 'string' ? d.ref : null,
      recordedAt: timestamp
    });
  });

  if (errors.length) return { ok: false, recorded: [], error: errors.join('; ') };

  if (typeof store === 'function') {
    store(recorded);
  } else {
    const fs = require('fs');
    const lines = recorded.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(auditLogPath, lines, 'utf8');
  }

  return { ok: true, recorded, error: null };
}

module.exports = {
  CATEGORIES,
  SEVERITIES,
  DISPOSITIONS,
  DEFAULT_CONSTITUTION,
  DEFAULT_PERSONAS,
  runAdversarialPass,
  validateAdversarialOutput,
  filterAndPrioritizeFindings,
  recordAdversarialDispositions
};
