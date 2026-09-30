'use strict';

/**
 * A trusted, server-side reader of the GitHub facts a coordinator's rotation
 * checkpoint enumerates (#2032, Architect ruling A4/A10): each issue or pull
 * request is read by TangleClaw itself, through `gh` on this host, at prepare
 * and again at resume. A model's claim that it "checked GitHub" is never
 * evidence; what this module observes is.
 *
 * Every read is bounded. A fact that could not be read is unavailable, never
 * assumed unchanged, and never cached: a rotation's resume must see GitHub as
 * it is now.
 *
 * @module lib/github-facts
 */

const crypto = require('node:crypto');
const { execFileArgs, describeFailure } = require('./exec');

/** One gh call's time and output budget. */
const EXEC_TIMEOUT_MS = 10000;

/** Most facts one checkpoint may enumerate. */
const MAX_FACTS = 100;

/** How many facts are read at once. */
const CONCURRENCY = 4;

/** The whole observation's time budget; facts not read inside it are unavailable. */
const DEADLINE_MS = 60000;

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Seams for tests. */
const _internal = {
  exec: (args, timeoutMs = EXEC_TIMEOUT_MS) => execFileArgs('gh', args, { timeoutMs, maxBufferBytes: 256 * 1024 }),
  deadlineMs: DEADLINE_MS
};

/**
 * Validate a checkpoint's `github` list.
 * @param {*} list - Candidate.
 * @returns {{ok: true}|{ok: false, message: string}}
 */
function validateFacts(list) {
  if (!Array.isArray(list)) return { ok: false, message: 'github must be a list of facts ([] when there are none)' };
  if (list.length > MAX_FACTS) return { ok: false, message: `github may list at most ${MAX_FACTS} facts` };
  const seen = new Set();
  for (const f of list) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { ok: false, message: 'each github fact must be an object' };
    if (typeof f.repo !== 'string' || !REPO_RE.test(f.repo) || f.repo.split('/').some((seg) => /^\.+$/.test(seg))) {
      return { ok: false, message: 'each github fact needs repo as owner/name (no segment of only dots)' };
    }
    if (f.kind !== 'issue' && f.kind !== 'pr') return { ok: false, message: 'each github fact needs kind issue or pr' };
    if (!Number.isSafeInteger(f.number) || f.number < 1) return { ok: false, message: 'each github fact needs a positive number' };
    if (f.state !== 'open' && f.state !== 'closed') return { ok: false, message: 'each github fact needs state open or closed' };
    if (f.kind === 'pr' && f.headSha !== undefined && !/^[0-9a-f]{40}$/.test(f.headSha)) return { ok: false, message: 'a pr fact\'s headSha must be a full sha' };
    if (f.kind === 'pr' && f.merged !== undefined && typeof f.merged !== 'boolean') return { ok: false, message: 'a pr fact\'s merged must be true or false' };
    const key = factKey(f);
    if (seen.has(key)) return { ok: false, message: `github lists ${key} twice` };
    seen.add(key);
  }
  return { ok: true };
}

/**
 * The stable key a fact is tracked under.
 * @param {{repo: string, kind: string, number: number}} f - A fact.
 * @returns {string}
 */
function factKey(f) {
  return `github:${f.repo}#${f.kind}${f.number}`;
}

/**
 * SHA-256 of an observation's canonical JSON.
 * @param {object} observed - An observation.
 * @returns {string}
 */
function digest(observed) {
  const keys = Object.keys(observed).sort();
  return crypto.createHash('sha256').update(JSON.stringify(observed, keys)).digest('hex');
}

/**
 * Read one fact from GitHub.
 * @param {{repo: string, kind: string, number: number}} f - The fact.
 * @param {number} [timeoutMs] - This read's budget.
 * @returns {Promise<{observed: object}|{unavailable: string}>}
 */
async function observeOne(f, timeoutMs = EXEC_TIMEOUT_MS) {
  const path = f.kind === 'pr' ? `repos/${f.repo}/pulls/${f.number}` : `repos/${f.repo}/issues/${f.number}`;
  const jq = f.kind === 'pr' ? '{state: .state, merged: .merged, headSha: .head.sha}' : '{state: .state}';
  const r = await _internal.exec(['api', path, '--jq', jq], timeoutMs);
  if (r.exitCode !== 0) return { unavailable: `${factKey(f)}: ${describeFailure(r, 'gh api')}` };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { unavailable: `${factKey(f)}: gh answered with something that is not JSON` };
  }
  if (!parsed || (parsed.state !== 'open' && parsed.state !== 'closed')) return { unavailable: `${factKey(f)}: gh answered with an unknown state` };
  const observed = f.kind === 'pr'
    ? { state: parsed.state, merged: parsed.merged === true, headSha: typeof parsed.headSha === 'string' ? parsed.headSha : null }
    : { state: parsed.state };
  return { observed };
}

/**
 * Observe every fact, {@link CONCURRENCY} at a time, inside one total
 * deadline. A fact not read in time is unavailable, like one that failed, and
 * one unavailable read makes the whole observation incomplete.
 * @param {object[]} facts - Validated facts.
 * @returns {Promise<{observations: Array<{key: string, fact: object, observed: object, digest: string}>, unavailable: string[]}>}
 */
async function observeAll(facts) {
  const deadline = Date.now() + _internal.deadlineMs;
  const results = new Array(facts.length);
  let next = 0;
  const worker = async () => {
    while (next < facts.length) {
      const i = next++;
      const left = deadline - Date.now();
      results[i] = left <= 0
        ? { unavailable: `${factKey(facts[i])}: not read before the deadline` }
        : await observeOne(facts[i], Math.min(EXEC_TIMEOUT_MS, left));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, facts.length) }, worker));
  const observations = [];
  const unavailable = [];
  facts.forEach((f, i) => {
    const r = results[i];
    if (r.unavailable) unavailable.push(r.unavailable);
    else observations.push({ key: factKey(f), fact: { repo: f.repo, kind: f.kind, number: f.number }, observed: r.observed, digest: digest(r.observed) });
  });
  return { observations, unavailable };
}

/**
 * Whether what the checkpoint declared disagrees with what was observed at
 * prepare — a stale declaration — as a list of keys.
 * @param {object[]} facts - The checkpoint's facts.
 * @param {object[]} observations - From {@link observeAll}.
 * @returns {string[]}
 */
function staleDeclarations(facts, observations) {
  const byKey = new Map(observations.map((o) => [o.key, o.observed]));
  const out = [];
  for (const f of facts) {
    const o = byKey.get(factKey(f));
    if (!o) continue;
    if (o.state !== f.state || (f.headSha !== undefined && o.headSha !== f.headSha) || (f.merged !== undefined && o.merged !== f.merged)) {
      out.push(factKey(f));
    }
  }
  return out;
}

/**
 * The observations that changed between prepare and resume, each a trusted
 * drift item with a stable key and before/after digests.
 * @param {object[]} before - Observations at prepare.
 * @param {object[]} after - Observations at resume.
 * @returns {Array<{class: 'github', key: string, before: string, after: string, beforeObserved: object, afterObserved: object}>}
 */
function drift(before, after) {
  const now = new Map(after.map((o) => [o.key, o]));
  const out = [];
  for (const b of before) {
    const a = now.get(b.key);
    if (a && a.digest !== b.digest) {
      out.push({ class: 'github', key: b.key, before: b.digest, after: a.digest, beforeObserved: b.observed, afterObserved: a.observed });
    }
  }
  return out;
}

module.exports = { validateFacts, factKey, observeAll, staleDeclarations, drift, MAX_FACTS, CONCURRENCY, DEADLINE_MS, _internal };
