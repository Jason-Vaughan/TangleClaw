'use strict';

/**
 * v6.1 (#2992, V6-21 / A3, Car V61-W1-A): project operating profiles
 * (`Full` / `Lean` / `Minimal`) and the workload-matched benchmark that
 * measures what each one actually costs.
 *
 * Ported from PRR-A's canonical Phase 4 prototype (P04,
 * `v6-phase4-a1-ledger-a3-profiles-d1-d2-scheduler-impl.md`,
 * `lib/operating-profiles.js`) from ESM to this repo's CommonJS, per PM
 * Ruling on Car V61-W1-A (the dispatch's "unattended / standard / cautious +
 * Safe-Mode Latch" wording appears in no requirement source; the issue, P04
 * and the ADR 0008 reconciliation register all name Full / Lean / Minimal).
 *
 * A profile only ever changes orchestration and documentation ceremony and
 * telemetry cadence. The safety floor is identical in every profile and
 * cannot be disabled by an override: ADR 0008 Domain 2 resolution 4 names
 * authentication, launch-binding verification, `control-gate` holds, secret
 * scanning and the `~/.tangleclaw/bin/tmux` guard as never configurable,
 * on top of P04's own floor (authorization, workspace isolation, audit,
 * lifecycle receipts, recovery boundary).
 *
 * The benchmark side never infers a saving from a profile's name. It only
 * aggregates samples a caller actually measured — with the production prompt
 * builder, the production tokenizer and a monotonic clock, through
 * {@link measureProfileRun} — and reports totals plus p50/p95 per
 * profile × seat-count cell, and each cell's delta against `Full` at the
 * same seat count. There is deliberately no fallback tokenizer: a character
 * count must never be reported as model tokens.
 *
 * Persisting which profile a project runs is NOT this module's job: ADR 0008
 * Domain 2 resolution 1 puts `operatingProfile` in the operator-writable
 * `project_authority_policies` table (`lib/v6/authority-service.js`), and
 * mounting the selector is Wave 2 (`Car V61-W2-ROUTES`). This module answers
 * "what does profile X with these overrides turn on", nothing else.
 *
 * @module lib/v6/a3-operating-profiles
 */

/** The three profiles, from most to least ceremony. */
const PROFILES = Object.freeze(['Full', 'Lean', 'Minimal']);

/** Services every profile always runs; no override can remove one. */
const SAFETY_FLOOR = Object.freeze([
  'authentication', 'authorization', 'launchBindingVerification', 'workspaceIsolation',
  'controlGateHolds', 'secretScanning', 'tmuxSafetyGuard', 'audit', 'lifecycleReceipts', 'recoveryBoundary'
]);

/**
 * The optional services each profile turns on. P04's set, plus the three
 * ceremony services ADR 0008 Domain 2 resolution 4 names as profile-governed
 * (multi-step wrap AI prompts, feature-index stubs, observer reports).
 */
const OPTIONAL_SERVICES = Object.freeze({
  Full: Object.freeze(['richPrompt', 'continuousDiscovery', 'diagnostics', 'historyIndex', 'medusaAssist', 'wrapAiPrompts', 'featureIndexStubs', 'observerReports']),
  Lean: Object.freeze(['diagnostics', 'medusaAssist', 'wrapAiPrompts']),
  Minimal: Object.freeze([])
});

/**
 * Telemetry cadence per profile, in milliseconds. Illustrative policy
 * constants (P04 says the same of its own scores): they are the knob the
 * benchmark exists to calibrate, not a measured optimum.
 */
const TELEMETRY_CADENCE_MS = Object.freeze({ Full: 60_000, Lean: 300_000, Minimal: 900_000 });

/** Seat counts the benchmark matrix measures (P04). */
const BENCHMARK_SEATS = Object.freeze([1, 4, 10]);

const KNOWN_SERVICES = new Set([...SAFETY_FLOOR, ...OPTIONAL_SERVICES.Full]);

/**
 * Resolve a profile, with optional per-project enable/disable overrides, to
 * the exact set of services it runs.
 * @param {string} name - One of {@link PROFILES}.
 * @param {{enable?: string[], disable?: string[]}} [overrides]
 * @returns {{ok: true, name: string, services: string[], safetyFloor: string[], telemetryCadenceMs: number}
 *   | {ok: false, code: string, unsafe?: string[], unknown?: string[]}}
 */
function resolveProfile(name, overrides) {
  const opts = overrides || {};
  const enable = Array.isArray(opts.enable) ? opts.enable : [];
  const disable = Array.isArray(opts.disable) ? opts.disable : [];
  if (!PROFILES.includes(name)) return { ok: false, code: 'UNKNOWN_PROFILE' };
  const unsafe = disable.filter((x) => SAFETY_FLOOR.includes(x));
  if (unsafe.length) return { ok: false, code: 'SAFETY_FLOOR_IMMUTABLE', unsafe };
  const unknown = [...enable, ...disable].filter((x) => !KNOWN_SERVICES.has(x));
  if (unknown.length) return { ok: false, code: 'UNKNOWN_SERVICE', unknown };
  const services = new Set([...SAFETY_FLOOR, ...OPTIONAL_SERVICES[name], ...enable]);
  for (const x of disable) services.delete(x);
  return { ok: true, name, services: [...services].sort(), safetyFloor: [...SAFETY_FLOOR], telemetryCadenceMs: TELEMETRY_CADENCE_MS[name] };
}

/**
 * Throw unless `x` is one real measured sample.
 * @param {*} x
 * @returns {void}
 */
function _assertSample(x) {
  if (!x || !PROFILES.includes(x.profile) || !BENCHMARK_SEATS.includes(x.seats)
    || !Number.isFinite(x.promptTokens) || !Number.isFinite(x.serviceMs)
    || x.promptTokens < 0 || x.serviceMs < 0 || typeof x.runId !== 'string' || !x.runId) {
    throw new TypeError('Invalid measured sample');
  }
}

/**
 * Nearest-rank percentile of an already-sorted ascending array.
 * @param {number[]} sorted
 * @param {number} p - 0..100.
 * @returns {number}
 */
function _percentile(sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Aggregate measured samples into one row per profile × seat-count cell.
 * Throws on any invalid sample rather than skipping it, so a malformed
 * measurement file can never quietly shrink a cell.
 * @param {Array<{runId: string, profile: string, seats: number, promptTokens: number, serviceMs: number}>} samples
 * @returns {Array<object>} Sorted by seats, then profile order.
 */
function profileOverhead(samples) {
  if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
  const groups = new Map();
  for (const x of samples) {
    _assertSample(x);
    const key = `${x.profile}:${x.seats}`;
    const row = groups.get(key) || { profile: x.profile, seats: x.seats, runs: new Set(), tokens: [], ms: [] };
    row.runs.add(x.runId);
    row.tokens.push(x.promptTokens);
    row.ms.push(x.serviceMs);
    groups.set(key, row);
  }
  return [...groups.values()].map((x) => {
    const tokens = [...x.tokens].sort((a, b) => a - b);
    const ms = [...x.ms].sort((a, b) => a - b);
    const promptTokensTotal = tokens.reduce((a, b) => a + b, 0);
    const serviceMsTotal = ms.reduce((a, b) => a + b, 0);
    return {
      profile: x.profile, seats: x.seats, runs: x.runs.size, samples: tokens.length,
      promptTokensTotal, promptTokensPerSample: promptTokensTotal / tokens.length,
      promptTokensP50: _percentile(tokens, 50), promptTokensP95: _percentile(tokens, 95),
      serviceMsTotal, serviceMsPerSample: serviceMsTotal / ms.length, serviceMsPerSeat: serviceMsTotal / x.seats,
      serviceMsP50: _percentile(ms, 50), serviceMsP95: _percentile(ms, 95)
    };
  }).sort((a, b) => a.seats - b.seats || PROFILES.indexOf(a.profile) - PROFILES.indexOf(b.profile));
}

/**
 * Compare every cell against `Full` at the same seat count. A cell whose
 * `Full` baseline was not measured gets `baseline: null` and no delta —
 * never a delta against some other seat count.
 * @param {Array<object>} rows - {@link profileOverhead}'s output.
 * @returns {Array<{profile: string, seats: number, baseline: (string|null),
 *   promptTokensP50Delta: (number|null), serviceMsP50Delta: (number|null)}>}
 */
function compareToFull(rows) {
  return rows.map((row) => {
    const full = rows.find((r) => r.profile === 'Full' && r.seats === row.seats);
    if (!full) return { profile: row.profile, seats: row.seats, baseline: null, promptTokensP50Delta: null, serviceMsP50Delta: null };
    return {
      profile: row.profile, seats: row.seats, baseline: 'Full',
      promptTokensP50Delta: row.promptTokensP50 - full.promptTokensP50,
      serviceMsP50Delta: row.serviceMsP50 - full.serviceMsP50
    };
  });
}

/**
 * Measure one real launch: build the prompt with the production builder,
 * count it with the production tokenizer, and time service startup on a
 * monotonic clock. Every hook is required; there is no fallback.
 * @param {{profile: string, seats: number, runId: string, buildPrompt: Function,
 *   countTokens: Function, startServices: Function, clock?: Function}} args
 * @returns {Promise<{profile: string, seats: number, runId: string, promptTokens: number, serviceMs: number}>}
 */
async function measureProfileRun({ profile, seats, runId, buildPrompt, countTokens, startServices, clock = () => performance.now() }) {
  if (typeof buildPrompt !== 'function' || typeof countTokens !== 'function' || typeof startServices !== 'function') {
    throw new TypeError('Measurement hooks required');
  }
  const prompt = await buildPrompt(profile, seats);
  const promptTokens = await countTokens(prompt);
  const start = clock();
  await startServices(profile, seats);
  const serviceMs = clock() - start;
  const sample = { profile, seats, runId, promptTokens, serviceMs };
  _assertSample(sample);
  return sample;
}

/**
 * Parse a JSONL file's text (one measured sample per line) and aggregate it.
 * @param {string} text
 * @returns {Array<object>} {@link profileOverhead}'s output.
 */
function overheadFromJsonl(text) {
  const rows = String(text).split(/\r?\n/).filter((line) => line.trim()).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new TypeError(`line ${i + 1} is not JSON`);
    }
  });
  return profileOverhead(rows);
}

module.exports = {
  PROFILES,
  SAFETY_FLOOR,
  OPTIONAL_SERVICES,
  TELEMETRY_CADENCE_MS,
  BENCHMARK_SEATS,
  resolveProfile,
  profileOverhead,
  compareToFull,
  measureProfileRun,
  overheadFromJsonl
};
