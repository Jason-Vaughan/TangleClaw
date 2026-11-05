'use strict';

/**
 * The library/verb adapter surface for `#2887`, `#2878`, `#2883` and
 * `#2877` (Architect Ruling `A502-W1C-R2`, `Car 65-C`).
 *
 * Each of those four issues is a Slice 2 "wire the library into something
 * live" follow-on to an already-shipped, self-contained library module
 * (`lib/product-manual.js` + `lib/doc-router.js`, `lib/merge-inbox-gate.js`,
 * `lib/scorecard-producer.js`, `lib/roadmap-admission.js` +
 * `lib/roadmap-sync.js`). `A502-W1C-R2`'s amended envelope excludes
 * `server.js` and `bin/tc.js` from this car (top-level entrypoint mounting
 * is tracked for Milestone #54 / `v5.67.0`), so this module is where that
 * wiring actually happens for `v5.65.0`: it composes each library's pure
 * functions into the exact call shapes a `tc` verb or a future route needs,
 * and it is itself the one thing that changes once a real caller exists --
 * the libraries underneath stay untouched.
 *
 * Every function here is deliberately file/path-explicit (no guessed
 * default location for a hold store, a scorecard cache or a sync-state
 * file) and every side-effecting hook (`publishMergeGateStatusCheck`,
 * `refreshScorecardCache`, `scheduleScorecardRefresh`,
 * `publishScorecardToMetricsBranch`) is **opt-in / inert by default**: it
 * does nothing and returns `{..., reason: 'disabled'}` unless the caller
 * passes `enabled: true`, and every external call (GitHub, git) goes
 * through an injectable seam rather than a hardcoded `execFileSync`, so a
 * unit test exercises the whole sequence deterministically with no network
 * or git side effect (`A502-W1C-R2` point 2).
 *
 * @module lib/tc-docs-scorecard-merge-wiring
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileArgs, describeFailure } = require('./exec');
const productManual = require('./product-manual');
const docRouter = require('./doc-router');
const mergeGate = require('./merge-inbox-gate');
const scorecardProducer = require('./scorecard-producer');
const scorecardCache = require('./scorecard-cache');
const roadmapAdmission = require('./roadmap-admission');
const roadmapSync = require('./roadmap-sync');

/** Raised for a caller-input error this module itself catches, before delegating to a library. */
class WiringError extends Error {}

const EXEC_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** The GitHub status-check context `publishMergeGateStatusCheck` reports under by default. */
const DEFAULT_STATUS_CONTEXT = 'tangleclaw/merge-inbox-gate';

/** How often `scheduleScorecardRefresh` runs by default, once opted in. */
const DEFAULT_SCORECARD_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function defaultGhExec(args) {
  return execFileArgs('gh', args, { timeoutMs: EXEC_TIMEOUT_MS, maxBufferBytes: MAX_BUFFER_BYTES });
}

function defaultGitExec(args, options) {
  return execFileArgs('git', args, { cwd: options && options.cwd, timeoutMs: EXEC_TIMEOUT_MS, maxBufferBytes: MAX_BUFFER_BYTES });
}

// ---------------------------------------------------------------------------
// #2887 -- lib/product-manual.js + lib/doc-router.js, for `tc docs manual`
// and `tc docs router`.
// ---------------------------------------------------------------------------

/**
 * The human table of contents for a product manual manifest: read the
 * manifest from disk and list its pages, the `tc docs manual list` call shape.
 * @param {string} manifestFile - A validated manual manifest's path.
 * @returns {Array<{id:string, path:string, title:string, sections:Array}>}
 * @throws {module:lib/product-manual.ProductManualError}
 */
function docsManualList(manifestFile) {
  return productManual.listPages(productManual.readManualManifest(manifestFile));
}

/**
 * Resolve a stable `"<pageId>"` or `"<pageId>#<anchor>"` reference against a
 * manual manifest read from disk -- the `tc docs manual show <ref>` call shape.
 * @param {string} manifestFile
 * @param {string} ref
 * @returns {{found: true, page: object, section?: object} | {found: false, reason: string}}
 * @throws {module:lib/product-manual.ProductManualError}
 */
function docsManualResolve(manifestFile, ref) {
  return productManual.resolveAnchor(productManual.readManualManifest(manifestFile), ref);
}

/**
 * Resolve an AI-doc-router topic, role or command against a manifest read
 * from disk -- the `tc docs router` call shape. Exactly one of `topicId`,
 * `role` or `command` must be given.
 * @param {string} manifestFile
 * @param {object} query - `{topicId?, role?, command?, version?}`.
 * @returns {{found: true, entry: object, usedFallback: boolean} | {found: false, reason: string}
 *   | {found: true, entries: object[]}}
 * @throws {module:lib/doc-router.DocRouterError}
 * @throws {WiringError} When `query` names none of `topicId`, `role` or `command`.
 */
function docsRouterResolve(manifestFile, query) {
  const q = query || {};
  const manifest = docRouter.readAiDocManifest(manifestFile);
  if (q.topicId) return docRouter.resolveTopic(manifest, q.topicId, { version: q.version });
  if (q.role) return { found: true, entries: docRouter.resolveByRole(manifest, q.role) };
  if (q.command) return { found: true, entries: docRouter.resolveByCommand(manifest, q.command) };
  throw new WiringError('docsRouterResolve needs one of query.topicId, query.role or query.command');
}

// ---------------------------------------------------------------------------
// #2878 -- lib/merge-inbox-gate.js, for `tc merge-gate` and a GitHub required
// status check publisher.
// ---------------------------------------------------------------------------

/**
 * Issue a merge hold. Thin pass-through to {@link module:lib/merge-inbox-gate.issueHold}
 * -- this adapter's stable call shape for a `tc merge-gate hold` verb or a
 * future route, insulated from the underlying library's exact export name.
 * @param {string} file
 * @param {object} input
 * @returns {{ok: true, hold: object}|{ok: false, code: string, message: string}}
 */
function mergeGateIssueHold(file, input) {
  return mergeGate.issueHold(file, input);
}

/** @see module:lib/merge-inbox-gate.acknowledgeHold */
function mergeGateAcknowledgeHold(file, holdId, input) {
  return mergeGate.acknowledgeHold(file, holdId, input);
}

/** @see module:lib/merge-inbox-gate.overrideHold */
function mergeGateOverrideHold(file, holdId, input) {
  return mergeGate.overrideHold(file, holdId, input);
}

/** @see module:lib/merge-inbox-gate.listHolds */
function mergeGateListHolds(file, options) {
  return mergeGate.listHolds(file, options);
}

/**
 * The merge-execution gate check a merge-queue/route caller runs before
 * acting -- {@link module:lib/merge-inbox-gate.evaluateMergeGate}, named
 * for this call site's own vocabulary (an action identity, not a bare file).
 * @param {object} input - `{file, identity, autoMerge?}`.
 * @returns {object}
 */
function mergeGateEvaluate(input) {
  return mergeGate.evaluateMergeGate(input);
}

/**
 * Publish the merge-inbox-gate's status-check projection for one commit as a
 * GitHub commit status (`POST /repos/{repo}/statuses/{sha}`) -- the
 * "required status check cannot fire while a hold is active" half of
 * `#2878`. **Opt-in / inert by default**: a no-op returning
 * `{published: false, reason: 'disabled'}` unless `input.enabled === true`,
 * and talks to GitHub only through the injectable `input.exec` seam
 * (default: `gh api`), never a hardcoded call -- so a test exercises the
 * whole sequence with no real network call.
 * @param {object} input - `{file, identity, sha, enabled, exec?, context?}`.
 *   `identity.repo` ("owner/name") names the status target.
 * @returns {Promise<{published: true, state: 'success'|'failure'}
 *   | {published: false, reason: string, detail?: string}
 *   | {ok: false, code: string, message: string}>}
 */
async function publishMergeGateStatusCheck(input) {
  const i = input || {};
  if (i.enabled !== true) return { published: false, reason: 'disabled' };
  if (!i.sha) throw new WiringError('publishMergeGateStatusCheck needs input.sha');
  const payload = mergeGate.buildStatusCheckPayload({ file: i.file, identity: i.identity });
  if (payload.ok === false) return payload;
  const exec = i.exec || defaultGhExec;
  const context = i.context || DEFAULT_STATUS_CONTEXT;
  const description = payload.description.length > 140 ? `${payload.description.slice(0, 137)}...` : payload.description;
  const args = [
    'api', `repos/${i.identity.repo}/statuses/${i.sha}`,
    '-f', `state=${payload.state}`, '-f', `description=${description}`, '-f', `context=${context}`
  ];
  const r = await exec(args);
  if (r.exitCode !== 0) return { published: false, reason: 'gh-api-failed', detail: describeFailure(r, 'gh api') };
  return { published: true, state: payload.state };
}

// ---------------------------------------------------------------------------
// #2883 -- lib/scorecard-producer.js, for a scheduled cache refresh and an
// optional origin/metrics branch publication hook.
// ---------------------------------------------------------------------------

/**
 * Produce the scorecard document and write it to the local cache --
 * {@link module:scripts/scorecard-produce}'s own composition, as a library
 * call rather than a CLI, so a scheduler hook and a route can both reuse it.
 * **Opt-in / inert by default**: a no-op unless `input.enabled === true`.
 * @param {object} input - `{repoDir, baseDir, enabled, now?, windowDays?,
 *   freshForMs?, produce?, write?}`. `produce`/`write` are test seams
 *   (default {@link module:lib/scorecard-producer.produceScorecardDocument} /
 *   {@link module:lib/scorecard-cache.writeScorecardCache}).
 * @returns {Promise<{refreshed: true, file: string, generatedAt: number, freshUntil: number}
 *   | {refreshed: false, reason: string, detail?: string}>}
 */
async function refreshScorecardCache(input) {
  const i = input || {};
  if (i.enabled !== true) return { refreshed: false, reason: 'disabled' };
  const produce = i.produce || scorecardProducer.produceScorecardDocument;
  const write = i.write || scorecardCache.writeScorecardCache;
  const now = typeof i.now === 'number' ? i.now : Date.now();
  const result = await produce(i.repoDir, { now, windowDays: i.windowDays, freshForMs: i.freshForMs });
  if (!result.available) return { refreshed: false, reason: result.reason };
  const file = scorecardCache.cachePath(i.baseDir);
  try {
    write(file, result.document);
  } catch (e) {
    return { refreshed: false, reason: 'write-refused', detail: e.message };
  }
  return { refreshed: true, file, generatedAt: result.document.generatedAt, freshUntil: result.document.freshUntil };
}

/**
 * Arm a recurring scorecard-cache refresh -- the "scheduled server refresh"
 * half of `#2883`. **Opt-in / inert by default**: returns
 * `{scheduled: false, reason: 'disabled'}` and starts no timer unless
 * `input.enabled === true`. The timer function is injectable
 * (`input.setIntervalFn`, default the real `setInterval`) so a test can run
 * this without a real background timer ever existing.
 * @param {object} input - Everything {@link refreshScorecardCache} takes,
 *   plus `intervalMs?`, `setIntervalFn?`, `onError?` (default: swallow).
 * @returns {{scheduled: true, timer: *, intervalMs: number} | {scheduled: false, reason: string}}
 */
function scheduleScorecardRefresh(input) {
  const i = input || {};
  if (i.enabled !== true) return { scheduled: false, reason: 'disabled' };
  const schedule = i.setIntervalFn || setInterval;
  const intervalMs = typeof i.intervalMs === 'number' ? i.intervalMs : DEFAULT_SCORECARD_REFRESH_INTERVAL_MS;
  const onError = i.onError || (() => {});
  const timer = schedule(() => refreshScorecardCache(i).catch(onError), intervalMs);
  return { scheduled: true, timer, intervalMs };
}

/**
 * Publish a scorecard document to the `origin/metrics` branch without
 * touching the caller's working tree or index: hashes the document as a
 * loose blob, builds a new tree from `origin/<branch>`'s current tree (or an
 * empty one, for a branch that does not exist yet) via a throwaway
 * `GIT_INDEX_FILE`, commits it, and pushes the result directly to
 * `refs/heads/<branch>` -- the "optional `origin/metrics` branch
 * publication" half of `#2883`. **Opt-in / inert by default**: a no-op
 * unless `input.enabled === true`, and every git call goes through the
 * injectable `input.exec` seam (default: `git`), so a test exercises the
 * whole sequence with no real repository or network side effect.
 * @param {object} input - `{repoDir, document, enabled, branch?, path?, message?, exec?}`.
 * @returns {Promise<{published: true, branch: string, commit: string}
 *   | {published: false, reason: string, detail?: string}>}
 */
async function publishScorecardToMetricsBranch(input) {
  const i = input || {};
  if (i.enabled !== true) return { published: false, reason: 'disabled' };
  const exec = i.exec || defaultGitExec;
  const cwd = i.repoDir;
  const branch = i.branch || 'metrics';
  const filePath = i.path || 'scorecard/v1.json';
  const message = i.message || `chore(metrics): update ${filePath}`;
  const content = `${JSON.stringify(i.document, null, 2)}\n`;

  const tmpContentFile = path.join(os.tmpdir(), `tc-scorecard-metrics-${crypto.randomBytes(8).toString('hex')}.json`);
  const tmpIndexFile = path.join(os.tmpdir(), `tc-scorecard-metrics-index-${crypto.randomBytes(8).toString('hex')}`);
  fs.writeFileSync(tmpContentFile, content);
  try {
    const blob = await exec(['hash-object', '-w', tmpContentFile], { cwd });
    if (blob.exitCode !== 0) return { published: false, reason: 'hash-object-failed', detail: describeFailure(blob, 'git hash-object') };
    const blobSha = blob.stdout.trim();

    const fetched = await exec(['fetch', 'origin', branch], { cwd });
    const baseRef = fetched.exitCode === 0 ? `origin/${branch}` : null;

    const indexEnv = { ...(i.env || process.env), GIT_INDEX_FILE: tmpIndexFile };
    const execIndexed = (args) => exec(args, { cwd, env: indexEnv });

    if (baseRef) {
      const readTree = await execIndexed(['read-tree', baseRef]);
      if (readTree.exitCode !== 0) return { published: false, reason: 'read-tree-failed', detail: describeFailure(readTree, 'git read-tree') };
    }
    const update = await execIndexed(['update-index', '--add', '--cacheinfo', `100644,${blobSha},${filePath}`]);
    if (update.exitCode !== 0) return { published: false, reason: 'update-index-failed', detail: describeFailure(update, 'git update-index') };
    const writeTree = await execIndexed(['write-tree']);
    if (writeTree.exitCode !== 0) return { published: false, reason: 'write-tree-failed', detail: describeFailure(writeTree, 'git write-tree') };
    const treeSha = writeTree.stdout.trim();

    const commitArgs = ['commit-tree', treeSha, '-m', message];
    if (baseRef) commitArgs.push('-p', baseRef);
    const commit = await exec(commitArgs, { cwd });
    if (commit.exitCode !== 0) return { published: false, reason: 'commit-tree-failed', detail: describeFailure(commit, 'git commit-tree') };
    const commitSha = commit.stdout.trim();

    const push = await exec(['push', 'origin', `${commitSha}:refs/heads/${branch}`], { cwd });
    if (push.exitCode !== 0) return { published: false, reason: 'push-failed', detail: describeFailure(push, 'git push') };

    return { published: true, branch, commit: commitSha };
  } finally {
    try { fs.unlinkSync(tmpContentFile); } catch { /* best-effort scratch cleanup */ }
    try { fs.unlinkSync(tmpIndexFile); } catch { /* never created, or already gone */ }
  }
}

// ---------------------------------------------------------------------------
// #2877 -- lib/roadmap-admission.js + lib/roadmap-sync.js, for the roadmap
// board generator and PM train dispatch workflow.
// ---------------------------------------------------------------------------

/**
 * The pre-dispatch train admission check `#1894` asks for: classify a train
 * candidate, build (or reuse) its durable admission manifest, and validate
 * the actual dispatch against fresh facts in one call -- the sequence a
 * roadmap-board generator or PM dispatch workflow runs before committing a
 * train to a lane, composed here so every caller runs it identically.
 * @param {object} input - `{candidate, facts, receipt?, currentFacts?, manifest?, opts?}`.
 *   `manifest`, when given, is reused instead of rebuilt (the caller's own
 *   durable record); `currentFacts` defaults to `facts` when omitted (the
 *   common case: classify and dispatch against the same fact snapshot).
 * @returns {{classification: string, reasons: string[], manifest: object, admission: object}}
 * @throws {module:lib/roadmap-admission.RoadmapAdmissionError}
 */
function roadmapCheckTrainAdmission(input) {
  const i = input || {};
  const manifest = i.manifest || roadmapAdmission.buildTrainAdmissionManifest(i.candidate, i.facts, i.opts);
  const admission = roadmapAdmission.validateTrainDispatchAdmission(
    manifest, i.candidate, i.receipt, i.currentFacts || i.facts, i.opts
  );
  return { classification: manifest.classification, reasons: manifest.reasons, manifest, admission };
}

/**
 * One incremental roadmap-sync cycle `#2259` asks for: load the prior sync
 * state, decide which issues actually changed, let the caller render the
 * roadmap from exactly that diff (`input.renderRoadmap`, so this function
 * stays ignorant of how the roadmap HTML itself is built or how issues are
 * re-read from GitHub), decide whether the result is worth publishing, and
 * persist the new sync state -- but only once rendering itself has
 * succeeded, so a failed render never commits a sync state the caller never
 * actually used.
 * @param {object} input - `{file, liveSummaries, renderRoadmap, now?}`.
 *   `renderRoadmap(prevState, changed, now)` returns
 *   `Promise<{prevHtml, nextHtml, nextState}>` or the same object directly.
 * @returns {Promise<{published: boolean, changed: object, state: object}>}
 */
async function roadmapRunSyncCycle(input) {
  const i = input || {};
  const prevState = roadmapSync.loadSyncState(i.file);
  const changed = roadmapSync.computeChangedSince(prevState, i.liveSummaries);
  const now = typeof i.now === 'number' ? i.now : Date.now();
  const { prevHtml, nextHtml, nextState } = await i.renderRoadmap(prevState, changed, now);
  const published = roadmapSync.shouldPublishRoadmap(prevHtml, nextHtml, prevState, nextState);
  roadmapSync.saveSyncState(i.file, nextState);
  return { published, changed, state: nextState };
}

module.exports = {
  WiringError,
  DEFAULT_STATUS_CONTEXT,
  DEFAULT_SCORECARD_REFRESH_INTERVAL_MS,
  docsManualList,
  docsManualResolve,
  docsRouterResolve,
  mergeGateIssueHold,
  mergeGateAcknowledgeHold,
  mergeGateOverrideHold,
  mergeGateListHolds,
  mergeGateEvaluate,
  publishMergeGateStatusCheck,
  refreshScorecardCache,
  scheduleScorecardRefresh,
  publishScorecardToMetricsBranch,
  roadmapCheckTrainAdmission,
  roadmapRunSyncCycle,
  _internal: { defaultGhExec, defaultGitExec }
};
