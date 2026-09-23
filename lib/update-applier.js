'use strict';

/**
 * UB (#228 / #229) — the self-update ACTION. Detect/notify already ship
 * (`lib/update-checker.js` → the update beacon); restart already ships
 * (`lib/server-info.js` → `POST /api/server/restart`). This module fills the
 * one gap between them: fetch the latest release tag and move the checkout to
 * it, with safety guards that fail closed. It deliberately does **not** restart
 * — the route chains the existing restart path on success, so the proven
 * flush-202-then-kill dance lives in exactly one place.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');
const { NO_PROMPT_ENV } = require('./exec');
const managedBlock = require('./managed-block');
const { redactRemoteOutput } = require('./remote-output');
const updateChecker = require('./update-checker');

const log = createLogger('update-applier');

const REPO_DIR = path.join(__dirname, '..');

/**
 * Options for every git call here. Prompts are disabled: `fetch` and
 * `ls-remote` reach origin, and a credential prompt nobody can answer would hold
 * the update for the whole timeout.
 * @returns {import('node:child_process').ExecFileSyncOptions}
 */
function _gitOptions() {
  return { cwd: REPO_DIR, timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...NO_PROMPT_ENV } };
}

/**
 * Injection seam (mirrors `server-info._internal`) so tests drive every guard
 * without a real repo. `git` runs argv-form (NOT a shell string) so a tag ref
 * from `origin` can never inject — the ref is an argv element, never parsed by
 * a shell.
 */
const _internal = {
  git: (args) => execFileSync('git', args, _gitOptions()),
  readFile: (abs) => fs.readFileSync(abs, 'utf8'),
  checkForUpdate: () => updateChecker.checkForUpdate()
};

/**
 * Run a git subcommand in the repo dir and return trimmed stdout.
 * @param {...string} args - git argv (e.g. 'rev-parse', 'HEAD')
 * @returns {string}
 */
function _git(...args) {
  return _internal.git(args).trim();
}

/**
 * Build a refused-guard result.
 * @param {string} code - Stable machine code (e.g. 'dirty-tree')
 * @param {string} error - Human-readable reason
 * @param {string|null} [fromSha] - Pre-update HEAD sha when known
 * @returns {{ok: false, code: string, error: string, fromSha: string|null, toRef: null, toSha: null}}
 */
function _fail(code, error, fromSha = null) {
  // Log every refusal — a safety-relevant git-mutation endpoint should leave a
  // server-side trail that an update was attempted and why it was declined.
  log.info('Update apply refused', { code, error });
  return { ok: false, code, error, fromSha, toRef: null, toSha: null };
}

/**
 * Decide whether HEAD is in an updatable state (Decision A). Allowed:
 * on `main`, or detached exactly at a release tag (a prior UB checkout).
 * Refused: a feature branch, or a detached HEAD not sitting on a release tag —
 * so an update can never silently move a dev's working branch.
 * @returns {{ updatable: boolean, ref: string|null }}
 */
function _headState() {
  const branch = _git('rev-parse', '--abbrev-ref', 'HEAD'); // 'main' or 'HEAD' (detached)
  if (branch === 'main') return { updatable: true, ref: 'main' };
  if (branch === 'HEAD') {
    try {
      const tag = _git('describe', '--exact-match', '--tags', 'HEAD');
      if (/^v?\d+\.\d+\.\d+/.test(tag)) return { updatable: true, ref: tag };
    } catch { /* not exactly at a tag — fall through to refused */ }
  }
  return { updatable: false, ref: branch };
}

/**
 * Files TangleClaw owns a delimited region inside, rather than the whole file.
 *
 * Kept as one entry rather than derived at runtime because the update path must
 * not depend on engine profiles loading, and because widening it is a ruling
 * (see `_classifyDirty`). `test/update-applier-managed-carrier.test.js` pins it
 * against `data/engines/claude.json#configFormat.filename`, so a rename there
 * fails instead of silently leaving this list pointing at nothing.
 */
const MANAGED_BLOCK_CARRIERS = ['CLAUDE.md'];

/**
 * The shared hook settings file TangleClaw retires its own old entries from.
 *
 * TangleClaw writes it only to REMOVE hook entries an older version left there
 * (its hooks moved to `settings.local.json`); every other byte is the
 * operator's. So it is discardable only when the whole delta from HEAD is that
 * removal, never by path. Written out rather than read from the engine layer
 * for the same reason as the carrier list; `test/update-applier-managed-carrier.test.js`
 * pins it to `engines.SHARED_HOOK_SETTINGS_PATHS`.
 */
const HOOK_SETTINGS_FILE = '.claude/settings.json';

/**
 * The comment syntax those carriers use, for locating the markers.
 *
 * Mirrors the same profile's `configFormat.syntax`, and is pinned to it beside
 * the filename: a syntax change would make the markers unmatchable, containment
 * would answer false forever, and #1241 would be silently back with the
 * filename pin still green.
 */
const MANAGED_BLOCK_SYNTAX = 'markdown';

/**
 * A file's content with TangleClaw's managed region removed. The proof lives in
 * `managed-block.js` so the wrap's ownership check and this update path cannot
 * hold two ideas of what "changed only inside the block" means.
 */
const _outsideManagedBlock = managedBlock.outsideManagedBlock;

/**
 * Whether a managed-block carrier differs from HEAD ONLY inside that block.
 *
 * Fails closed on everything it cannot establish — the file missing from HEAD,
 * unreadable on disk, markers absent or duplicated on either side. A false
 * answer costs the operator the pre-#1241 refusal; a wrong true answer costs
 * them their uncommitted work, so the two are not symmetric.
 *
 * @param {string} relPath - Repo-relative path.
 * @returns {boolean}
 */
function _managedRegionOnlyDiff(relPath) {
  // Every exit is logged, positive and negative alike. A `false` here puts the
  // operator straight back into #1241's dead end — a 409 with no way forward —
  // and the five causes are indistinguishable from the outside, so a silent
  // return would reproduce the opacity this fix exists to remove. It matches
  // what the rest of this module already does: `_fail` records every refusal
  // and `_discardTcFiles` records what it is about to remove.
  const decline = (reason) => {
    log.info('Managed-block carrier is not provably TangleClaw-written', { path: relPath, reason });
    return false;
  };
  try {
    // Required HERE, not at module load. This is the self-update path: if it
    // cannot be imported, the operator has lost the way to repair the install.
    // `engines` pulls in the whole engine layer (and transitively the database),
    // so a load failure there must cost a declined containment check — handled
    // by the catch below — and never the module itself.
    const markers = require('./engines')._managedBlockMarkers(MANAGED_BLOCK_SYNTAX);
    if (!markers) return decline(`no managed-block comment form for '${MANAGED_BLOCK_SYNTAX}'`);
    // Untrimmed on both sides: trailing-whitespace differences outside the
    // block are still the operator's edit, and `_git` would erase them.
    const head = _internal.git(['show', `HEAD:${relPath}`]);
    const work = _internal.readFile(path.join(REPO_DIR, relPath));
    const proof = managedBlock.differsOnlyInsideManagedBlock(head, work, markers);
    if (!proof.onlyInside) return decline(proof.reason);
    log.info('Managed-block carrier differs only inside TangleClaw\'s region', { path: relPath });
    return true;
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- any failure to establish
    // containment must read as "not provably ours", which is the safe answer.
    // Reported, never swallowed: the likely causes are the file being absent
    // from HEAD or unreadable on disk, and both are worth a trail.
    return decline(`could not be read (${err && err.message})`);
  }
}

/**
 * Whether the shared hook settings file differs from HEAD ONLY by TangleClaw
 * removing its own hook entries.
 *
 * The proof is the wrap's (`judgeHookSettings`), so the update path and the
 * wrap cannot disagree about what "TangleClaw's change" means for this file.
 * Fails closed exactly like `_managedRegionOnlyDiff`: anything it cannot
 * establish (unparseable JSON, the file missing from HEAD, a load failure)
 * answers false, which keeps the file as real work.
 *
 * @param {string} relPath - Repo-relative path.
 * @returns {boolean}
 */
function _hookRetirementOnlyDiff(relPath) {
  const decline = (reason) => {
    log.info('Hook settings file is not provably TangleClaw-written', { path: relPath, reason });
    return false;
  };
  try {
    // Required HERE for the same reason as the engine layer above: a load
    // failure must cost this one proof, never the self-update module.
    const { judgeHookSettings } = require('./wrap-steps/_tc-owned-paths');
    const { isTangleClawHookEntry } = require('./engines');
    const head = _internal.git(['show', `HEAD:${relPath}`]);
    const work = _internal.readFile(path.join(REPO_DIR, relPath));
    const verdict = judgeHookSettings(head, work, isTangleClawHookEntry);
    if (!verdict.kind) return decline(verdict.reason);
    log.info('Hook settings file differs only by TangleClaw retiring its own hooks', { path: relPath });
    return true;
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- any failure to establish the
    // proof must read as "not provably ours", which is the safe answer.
    return decline(`could not be read (${err && err.message})`);
  }
}

/**
 * The only tracked files the updater may discard, each with the proof its
 * current delta must pass. One table, so the classifier's question ("is this a
 * provable file?") and the proof it runs cannot drift apart. Adding an entry
 * widens what an update may discard, which is a recorded ruling.
 *
 * @type {Map<string, (relPath: string) => boolean>}
 */
const PROOFS = new Map([
  ...MANAGED_BLOCK_CARRIERS.map((f) => [f, _managedRegionOnlyDiff]),
  [HOOK_SETTINGS_FILE, _hookRetirementOnlyDiff]
]);

/**
 * Route a tracked file to the proof that can show its current delta is
 * TangleClaw's. A path with no proof answers false.
 *
 * @param {string} relPath - Repo-relative path.
 * @returns {boolean}
 */
function _provenTcDelta(relPath) {
  const proof = PROOFS.get(relPath);
  return proof ? proof(relPath) : false;
}

/**
 * Split `git status --porcelain` output into what TangleClaw provably wrote
 * and what might be someone's work (#711 chunk 03, #1537).
 *
 * THE LINE: an entry is discardable only when its CURRENT DELTA is proven
 * TangleClaw's, never because of where it lives. Two tracked files qualify,
 * each through its own proof supplied by the caller:
 *
 * - a managed-block carrier (`CLAUDE.md`) whose working copy matches HEAD
 *   everywhere outside TangleClaw's markers (#1241);
 * - `.claude/settings.json` when the only change is TangleClaw removing its own
 *   retired hook entries.
 *
 * Everything else is real work, which keeps the hard refusal. That includes all
 * of `.tangleclaw/`. The plans, priming prompts and memories there are authored
 * content, and TangleClaw's own machine state beside them is gitignored in this
 * checkout, so a `.tangleclaw/` entry in porcelain is someone's work, not
 * TangleClaw's. The earlier line discarded the whole prefix and deleted an
 * uncommitted plan under a dialog that said nothing of the operator's was in
 * the list.
 *
 * Deliberately no content-marker heuristics: a `Generated by TangleClaw` stamp
 * proves TangleClaw generated a file once, not that the current delta is
 * TangleClaw's. `settings.local.json` and the rest of `.claude/` are the
 * operator's. An entry this parser cannot read with certainty (renames, quoted
 * paths with escapes) is real work. An untracked file is never discardable:
 * `git checkout --` has nothing to restore it from. Widening the set of proven
 * files is a recorded ruling, never an inference.
 *
 * `provenTc` is injected and defaults to null, which classifies every entry as
 * real work. A caller that cannot answer the proof question gets the refusal
 * rather than a guess, and this function stays pure over its string input.
 *
 * @param {string} porcelain - Raw `git status --porcelain` output.
 * @param {((relPath: string) => boolean)|null} [provenTc] - True only when the
 *   tracked file's delta from HEAD is proven TangleClaw's.
 * @returns {{discardable: Array<{path: string, tracked: boolean}>, realWork: string[]}}
 */
function _classifyDirty(porcelain, provenTc = null) {
  const discardable = [];
  const realWork = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const rawPath = line.slice(3);
    // Fail closed on anything exotic: renames carry two paths, quoted paths
    // carry escapes — discarding must never guess.
    if (line.length < 4 || rawPath.includes(' -> ') || rawPath.startsWith('"')) {
      realWork.push(line.trim());
      continue;
    }
    const tracked = !status.includes('?');
    const provable = tracked && PROOFS.has(rawPath);
    if (provable && typeof provenTc === 'function' && provenTc(rawPath) === true) {
      discardable.push({ path: rawPath, tracked });
    } else {
      realWork.push(rawPath);
    }
  }
  return { discardable, realWork };
}

/**
 * Discard the provably-TC entries by restoring each from HEAD. Argv-form git
 * throughout; `--` terminates option parsing so a path can never be read as a
 * flag. Throws on any git failure (the caller's git-error path reports it with
 * `fromSha`).
 *
 * Restore only, never delete: every proof `_classifyDirty` accepts compares a
 * tracked file with HEAD, so an untracked entry here means a caller broke that
 * contract, and this refuses rather than removing a file nothing proved.
 *
 * @param {Array<{path: string, tracked: boolean}>} entries - From `_classifyDirty`.
 */
function _discardTcFiles(entries) {
  const untracked = entries.filter((e) => !e.tracked).map((e) => e.path);
  if (untracked.length) {
    throw new Error(`refusing to delete untracked files no proof covers: ${untracked.join(', ')}`);
  }
  const tracked = entries.map((e) => e.path);
  // Logged BEFORE the operation: a discard that dies midway must still have
  // left a record of what it set out to restore.
  log.info('Restoring TangleClaw-written files blocking an update', { tracked });
  if (tracked.length) _git('checkout', '--', ...tracked);
}

/**
 * Apply the latest available release: fetch tags, `git checkout <latest tag>`,
 * then provision what the checkout alone does not move (#711 chunk 01).
 * Each guard fails closed; never restarts (the caller chains the restart route).
 *
 * Provisioning, precisely — DETECT AND REPORT, never execute:
 * - Changed deploy assets (anything under `deploy/`: launchd plists,
 *   tmux.conf, install.sh) are reported, never auto-applied: re-running
 *   install.sh reloads launchd services, and a node without Full Disk Access
 *   on a repo under ~/Documents hangs the server silently (#324). The
 *   response names what changed so the operator can act; silence was the
 *   defect.
 * - A dependency manifest appearing or changing (`package.json` /
 *   `package-lock.json`) is reported the same way. TangleClaw is zero-npm-dep
 *   by ratified norm (`dependency-manifest.md`), so today this cannot trigger
 *   — the branch is the forward guard for a release that reverses that norm
 *   upstream: an already-installed copy applying such a release must be TOLD
 *   its runtime now needs an install step, and the updater must not become an
 *   npm executor to say so (the operator's git-over-packaged ruling cited npm
 *   supply-chain exposure as a reason to keep npm out of this path).
 *
 * @param {object} [opts] - Options.
 * @param {boolean} [opts.discardDirty] - Discard dirty paths and proceed —
 *   honored ONLY when every dirty path is provably TangleClaw-written
 *   (`_classifyDirty`); any real-work path keeps the hard refusal.
 * @returns {{ok: boolean, code: string|null, error: string|null,
 *   fromSha: string|null, toRef: string|null, toSha: string|null,
 *   provisioning?: {manifestChanged: boolean, assetsChanged: string[],
 *   action: 'manual'|null},
 *   dirty?: {discardable: string[], realWork: string[]}}}
 */
function applyUpdate(opts = {}) {
  let fromSha = null;

  // 1. Guard — is a git checkout at all.
  try {
    fromSha = _git('rev-parse', 'HEAD');
  } catch {
    return _fail('no-git', 'not a git checkout — cannot self-update');
  }

  try {
    // 2. Guard — an update is actually available (no silent no-op).
    const status = _internal.checkForUpdate();
    if (!status || !status.updateAvailable || !status.latestVersion) {
      return _fail('no-update', 'already up to date — no newer release available', fromSha);
    }

    // 3. Guard — clean working tree (never clobber local changes). The
    // structured `dirty` payload turns the refusal from a dead end into a
    // diagnosis (#711 chunk 03): the operator sees WHAT is dirty, split into
    // what TC provably wrote and what might be theirs. The discard path opens
    // ONLY when the caller asked for it AND every dirty path is provably
    // TC's — one real-work path anywhere keeps the hard refusal.
    // RAW, not through _git: the trim there eats the first line's leading
    // status column (` M path` → `M path`), which shifts every downstream
    // path slice by one. Classification needs the bytes git printed.
    const porcelain = _internal.git(['status', '--porcelain']);
    if (porcelain.trim()) {
      const dirty = _classifyDirty(porcelain, _provenTcDelta);
      const canDiscard = dirty.realWork.length === 0 && dirty.discardable.length > 0;
      if (!(opts.discardDirty === true && canDiscard)) {
        const summary = dirty.realWork.length > 0
          ? 'local changes present — commit or stash before updating'
          : 'local changes present — each proven to be TangleClaw\'s own change; retry with '
            + 'the discard option to restore the committed copies and update';
        return Object.assign(
          _fail('dirty-tree', summary, fromSha),
          { dirty: { discardable: dirty.discardable.map((e) => e.path), realWork: dirty.realWork } }
        );
      }
      _discardTcFiles(dirty.discardable);
      // The discard must PROVE it produced a clean tree before anything moves.
      if (_git('status', '--porcelain')) {
        return _fail('dirty-tree',
          'restoring TangleClaw\'s changed files did not produce a clean tree — refusing', fromSha);
      }
    }

    // 4. Guard — HEAD is on an updatable ref (main, or detached at a release tag).
    const head = _headState();
    if (!head.updatable) {
      return _fail('wrong-ref', `refusing to update from "${head.ref}" — checkout main (or a release tag) first`, fromSha);
    }

    // 5. Fetch the latest tags.
    _git('fetch', '--tags', 'origin');

    // 6. Resolve + checkout the latest release tag (Decision A).
    const latestTag = updateChecker.findLatestVersion(
      updateChecker.parseTagsOutput(_git('ls-remote', '--tags', 'origin'))
    );
    if (!latestTag) {
      return _fail('no-tag', 'no release tag found on origin', fromSha);
    }
    _git('checkout', latestTag);

    const toSha = _git('rev-parse', 'HEAD');

    // 7. Report what the checkout did not move (#711 chunk 01). Detect and
    // report ONLY — the updater executes nothing here, by design (see JSDoc).
    const changed = _git('diff', '--name-only', fromSha, toSha).split('\n').filter(Boolean);
    const manifestChanged = changed.includes('package.json')
      || changed.includes('package-lock.json');
    const assetsChanged = changed.filter((f) => f.startsWith('deploy/'));
    const provisioning = {
      manifestChanged,
      assetsChanged,
      action: (manifestChanged || assetsChanged.length > 0) ? 'manual' : null
    };

    log.info(`Update applied: ${fromSha.slice(0, 7)} → ${latestTag} (${toSha.slice(0, 7)}); restart pending`, { provisioning });
    return { ok: true, code: null, error: null, fromSha, toRef: latestTag, toSha, provisioning };
  } catch (err) {
    // A git failure mid-flow (fetch/checkout) — report with the pre-update sha
    // so recovery is a one-line `git checkout <fromSha>`.
    // The flow fetches and checks out from a remote, so a mid-flow git error
    // can echo the remote URL — into the log file and into the API response.
    const safe = redactRemoteOutput(err.message);
    log.warn('Update apply failed', { error: safe, fromSha });
    return { ok: false, code: 'git-error', error: safe, fromSha, toRef: null, toSha: null };
  }
}

module.exports = {
  applyUpdate, _internal, _gitOptions, _headState, _classifyDirty, _discardTcFiles,
  _managedRegionOnlyDiff, _hookRetirementOnlyDiff, _provenTcDelta, _outsideManagedBlock,
  MANAGED_BLOCK_CARRIERS, MANAGED_BLOCK_SYNTAX, HOOK_SETTINGS_FILE, PROOFS
};
