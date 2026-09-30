'use strict';

/**
 * Shared fixtures for the release-certification suites: one healthy run's
 * manifest, observations and samples.
 *
 * Every suite used to carry its own copy, and the copies drifted (a field the
 * probes emit was missing from some). A new field is added here once. Values
 * a suite's assertions depend on, such as the worktree path a privacy test
 * looks for, are passed explicitly rather than assumed.
 *
 * @module test/_release-certification-fixtures
 */

const sm = require('../lib/release-certification/state-machine');
const isolation = require('../lib/release-certification/isolation');

const SHA = 'a'.repeat(40);
const WTID = 'c'.repeat(64);
const GEN = '4242@Sun Sep 27 09:00:00 2026';
const MIN = 60 * 1000;
const T0 = 1_000_000;
/** A host-minted run id for the fixture run. */
const RUN_ID = 'b'.repeat(32);

/**
 * A manifest for the candidate, from `sm.buildManifest`.
 * @param {object} [over] - Fields to set or replace, e.g. `{createdAt, worktreePath, host, thresholds}`
 * @returns {object} Manifest
 */
function manifest(over = {}) {
  return sm.buildManifest({
    candidateSha: SHA,
    version: '5.30.0',
    repository: 'o/r',
    requiredChecks: ['test'],
    requiredChecksSource: 'branch-protection',
    createdAt: T0,
    worktreePath: '/tmp/wt',
    worktreeId: WTID,
    ttydGeneration: GEN,
    host: 'h',
    runId: RUN_ID,
    ...over
  });
}

/** The guest's boot identity and packet-filter ruleset digest in the fixture run. */
const BOOT_ID = 'boot-4f1c';
const RULESET = 'd'.repeat(64);

/**
 * A manifest for a run in a guest: host-attested checks, a local metrics
 * repository, and attested network isolation.
 * @param {object} [over] - Fields to set or replace
 * @returns {object} Manifest
 */
function guestManifest(over = {}) {
  return manifest({ checksSource: 'host-attested', checksExchange: '/x', publishRemote: '/x/metrics.git', isolationProducer: '/x/guest-setup.sh', ...over });
}

/**
 * The two isolation attestations a healthy guest produces for one sample.
 * @param {object} binding - `{candidateSha, runId, manifestDigest, sampleSeq}`
 * @param {object} [over] - `{admin, workload}` field overrides
 * @returns {{admin: object, workload: object}} The pair
 */
function isolationPair(binding, over = {}) {
  const b = { candidateSha: binding.candidateSha, runId: binding.runId, manifestDigest: binding.manifestDigest, sampleSeq: binding.sampleSeq };
  return {
    admin: { schema: isolation.ADMIN_SCHEMA, ...b, bootId: BOOT_ID, pfEnabled: true, rulesetSha256: RULESET, interfaces: ['lo0=127.0.0.1'], managementPath: 'host-only', observedAt: T0, ...over.admin },
    workload: { schema: isolation.WORKLOAD_SCHEMA, ...b, bootId: BOOT_ID, uid: 501, groups: [20], sudoRefused: true, pfctlRefused: true, loopbackApi: true, egressDenied: { ipv4: true, ipv6: true, dns: true }, observedAt: T0, ...over.workload }
  };
}

/** An attested, healthy isolation observation, as the probe reports it. */
const ISOLATED = Object.freeze({ state: 'ok', bootId: BOOT_ID, rulesetSha256: RULESET, adminDigest: 'a'.repeat(64), workloadDigest: 'b'.repeat(64) });

/**
 * Observations of a healthy candidate, with every field the probes emit.
 * Each key of `over` is merged into that probe's observation; `null` makes
 * the probe unavailable.
 * @param {object} [over] - Per-probe overrides
 * @param {object} [base] - Per-probe values replacing the defaults before `over` applies (a suite's own pool size or process ids)
 * @returns {object} Observations
 */
function observations(over = {}, base = {}) {
  const b = {
    worktree: { headSha: SHA, detached: true, dirty: false },
    server: { checkoutId: WTID, currentDiskSha: SHA, isStale: false, startupSha: SHA, shaBaselineSource: 'startup', runningVersion: '5.30.0', startedAt: 500 },
    ttyd: { applicable: true, managed: true, generation: GEN, leakState: 'clear', wedgedCount: 0, orphanGate: false, poolUsed: 1 },
    github: { state: 'ok', checks: { test: 'success' } },
    pty: { instance: 's1', attaches: 0, detaches: 0, lastAt: null }
  };
  for (const [k, v] of Object.entries(base)) b[k] = { ...b[k], ...v };
  for (const [k, v] of Object.entries(over)) b[k] = v === null ? null : { ...b[k], ...v };
  return b;
}

/**
 * One sample taken `t` ms after `T0`.
 * @param {number} t - Offset in ms (also the monotonic reading)
 * @param {object} [obs] - Observations
 * @param {object} [extra] - Fields to set on the sample, e.g. `{runnerInstance, monoAt, diagnostics}`
 * @returns {object} Sample
 */
function sample(t, obs = observations(), extra = {}) {
  return { wallAt: T0 + t, monoAt: t, runnerInstance: 'r1', observations: obs, ...extra };
}

module.exports = { SHA, WTID, GEN, MIN, T0, RUN_ID, BOOT_ID, RULESET, ISOLATED, manifest, guestManifest, isolationPair, observations, sample };
