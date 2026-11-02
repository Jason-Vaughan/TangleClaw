'use strict';

/**
 * UB (#228 / #229) — the self-update ACTION. Detect/notify already ship
 * (`lib/update-checker.js` → the update beacon); restart already ships
 * (`lib/server-info.js` → `POST /api/server/restart`). This module fills the
 * one gap between them: fetch the latest release tag and move the checkout to
 * it, with safety guards that fail closed. It deliberately does **not** restart
 * — the route chains the existing restart path on success, so the proven
 * flush-202-then-kill dance lives in exactly one place.
 *
 * **Stale-install response (#1710).** A second, much narrower path alongside
 * `applyUpdate`'s tag-based move: when the live checkout has merely drifted
 * from `origin/main` (not jumped to a new release tag), `evaluateStaleInstallResponse`
 * classifies the drift via `checkout-freshness.classifyUpstreamDelta` and
 * either fast-forwards unattended (`applyAutomaticRecordsOnlyFastForward`,
 * proven records-only delta only) or — for anything that could change what a
 * restart loads — returns a structured prompt instead of ever restarting
 * launchd itself. No carry, no reconcile, no sqlite backup: those exist for
 * `applyUpdate`'s tag move, which can touch operator-authored files; a proven
 * records-only delta by definition cannot.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('./logger');
const { NO_PROMPT_ENV } = require('./exec');
const managedBlock = require('./managed-block');
const { redactRemoteOutput } = require('./remote-output');
const updateChecker = require('./update-checker');
const wrapRunRegistry = require('./wrap-run-registry');

const log = createLogger('update-applier');

const REPO_DIR = path.join(__dirname, '..');

// A full, lowercase git commit SHA — the same shape this project checks a
// trusted SHA against elsewhere (e.g. `lib/merge-queue-store.js`).
const SHA_SHAPE = /^[0-9a-f]{40}$/;

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
  // Raw bytes, for the carry: "the exact original bytes" cannot survive a
  // utf8 round-trip when a file holds bytes that are not valid UTF-8.
  gitBytes: (args) => execFileSync('git', args, { ..._gitOptions(), encoding: 'buffer' }),
  readFile: (abs) => fs.readFileSync(abs, 'utf8'),
  checkForUpdate: () => updateChecker.checkForUpdate(),
  // The checkout every filesystem step of the carry reads and writes. Git's
  // own cwd is `_gitOptions`; tests that point `git` at a scratch repository
  // point this at the same one.
  repoDir: REPO_DIR,
  // Where pre-update copies of carried files are kept. Required when the
  // backup step runs, not at module load, for the same reason the engine layer
  // is: a failure to load the store must cost the backup (a refused update),
  // never the self-update module.
  backupDir: () => path.join(require('./store')._getBasePath(), 'backups'),
  // SQLite backup seams — required at call time so a store load failure costs
  // the backup step (a refused update), never the module itself.
  getDbPath: () => path.join(require('./store')._getBasePath(), 'tangleclaw.db'),
  vacuumDb: (srcPath, destPath) => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(srcPath, { readonly: true });
    try {
      db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  },
  integrityCheck: (dbPath) => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readonly: true });
    try {
      return db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
    } finally {
      db.close();
    }
  },
  // Read the finished backup file for digest computation. Separate seam so
  // tests can stub vacuumDb as a noop without triggering ENOENT here.
  readBackupFile: (filePath) => fs.readFileSync(filePath),
  // Set restrictive permissions on the backup file (consistent with _secureBackup).
  chmodBackupFile: (filePath, mode) => fs.chmodSync(filePath, mode),
  // The name of the project a wrap is running for, or null — the same signal
  // `POST /api/server/restart` already refuses on (#1710 Layer 2/3 precondition).
  anyRunning: () => wrapRunRegistry.anyRunning(),
  // The Layer 1 classification for #1710; a seam so tests can hand this module
  // a proven delta without faking a whole checkout-freshness/git-probe stack.
  // Lazy, like the `engines` require elsewhere in this file: `checkout-freshness`
  // pulls in `./store` at its own top level, and this module repairs a broken
  // install, so an import failure in the database layer must not take it down
  // with it (`test/update-applier-managed-carrier.test.js` pins this isolation).
  classifyUpstreamDelta: (project) => require('./checkout-freshness').classifyUpstreamDelta(project)
};

/**
 * Absolute path of a repo-relative file in the checkout being updated.
 * @param {string} relPath - Repo-relative path.
 * @returns {string}
 */
function _repoPath(relPath) {
  return path.join(_internal.repoDir, relPath);
}

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
 * Decide whether HEAD is in an updatable state (Decision A) for a *direct*
 * checkout. Allowed: on `main`, or detached exactly at a release tag (a prior
 * UB checkout). Refused: a feature branch, or a detached HEAD not sitting on
 * a release tag — so a plain checkout-based update can never silently move a
 * dev's working branch. A feature branch's own commits can still ride along
 * via `_tryRebaseOntoTag` (#2399); this function only decides whether the
 * *checkout* path below is safe.
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
    const work = _internal.readFile(_repoPath(relPath));
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
    const work = _internal.readFile(_repoPath(relPath));
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
 * TangleClaw's.
 *
 * An operator-authored tracked file (`OPERATOR_AUTHORED_TRACKED`) is never
 * discardable either. The caller takes it out of the porcelain before this
 * runs, and only when it is changed in the working tree alone, so that the
 * carry can handle it. Any other state of that file reaches this function and
 * is real work.
 *
 * Deliberately no content-marker heuristics: a `Generated by TangleClaw` stamp
 * proves TangleClaw generated a file once, not that the current delta is
 * TangleClaw's. `settings.local.json` and the rest of `.claude/` are the
 * operator's. An entry this parser cannot read with certainty (renames, quoted
 * paths with escapes) is real work. An untracked file is never discardable:
 * `git checkout --` has nothing to restore it from. Widening the set of proven
 * files is a recorded ruling, never an inference.
 *
 * A STAGED entry is also always real work, whatever `provenTc` answers
 * (#1246): `_managedRegionOnlyDiff` proves the WORKING TREE differs from HEAD
 * only inside the block, but says nothing about the INDEX — a carrier with a
 * staged edit confined to the block would still pass that proof, and
 * `_discardTcFiles` restores from HEAD, so a staged edit (an explicit `git
 * add`, the strongest signal of intentional authored work this parser can
 * see) must never be silently thrown away. `xy[0]` is porcelain's index
 * column; `' '` means the index matches HEAD and `'?'` means untracked
 * (no index entry to stage) — anything else means something is staged.
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
    const staged = status[0] !== ' ' && status[0] !== '?';
    const provable = tracked && !staged && PROOFS.has(rawPath);
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
 * Restores with an explicit `HEAD` source (#1246), not the bare two-argument
 * `git checkout -- <path>` form, which restores from the INDEX. Those agree
 * only when the index happens to match HEAD; naming `HEAD` makes the restore
 * target identical to the reference `_managedRegionOnlyDiff` / `_classifyDirty`
 * actually proved containment against, rather than relying on that agreement
 * holding by coincidence.
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
  if (tracked.length) _git('checkout', 'HEAD', '--', ...tracked);
}

/**
 * Tracked files an operator edits through TangleClaw itself, which an update
 * carries across instead of refusing or discarding (#1730).
 *
 * `data/global-rules.md` is the one canonical rules document (#240), and the
 * landing-page editor writes it in place, so an install that customised its
 * rules holds an edit to a file every release may also change. `editor` names
 * the dashboard surface that edits the file, because a refusal's `action` must
 * point there rather than at git (ADR 0010). Adding an entry widens what an
 * update rewrites, which needs the Architect's ruling.
 */
const OPERATOR_AUTHORED_TRACKED = Object.freeze([
  Object.freeze({ path: 'data/global-rules.md', editor: 'Global Rules' })
]);

const _CARRIED = new Map(OPERATOR_AUTHORED_TRACKED.map((e) => [e.path, e]));

/**
 * Take the carried files out of `git status --porcelain` output, but only when
 * they are changed in the working tree and nowhere else (status ` M`). A
 * staged, deleted or unmerged carried file stays in the porcelain and is
 * classified as real work: the carry restores from the index and compares
 * with HEAD, and neither is safe when the two differ.
 *
 * @param {string} porcelain - Raw `git status --porcelain` output.
 * @returns {{porcelain: string, carried: string[]}}
 */
function _splitCarried(porcelain) {
  const rest = [];
  const carried = [];
  for (const line of porcelain.split('\n')) {
    if (line.startsWith(' M ') && _CARRIED.has(line.slice(3))) carried.push(line.slice(3));
    else rest.push(line);
  }
  return { porcelain: rest.join('\n'), carried };
}

/**
 * One entry of a `reconcile-required` refusal. `action` is shown to the
 * operator as written, so it names dashboard steps and never a git command.
 *
 * @param {string} relPath - Repo-relative path.
 * @param {string} reason - `merge-conflict`, `skip-worktree`,
 *   `assume-unchanged`, `untracked-collision`, `checkout-collision` or
 *   `backup-failed`.
 * @param {string} [detail] - Extra context the action needs (a directory).
 * @returns {{path: string, reason: string, action: string}}
 */
function _reconcileItem(relPath, reason, detail) {
  const carried = _CARRIED.get(relPath);
  const editor = carried ? carried.editor : null;
  const nothing = 'Nothing was changed.';
  const actions = {
    // Only a carried file is ever merged, so `editor` is always known here.
    'merge-conflict': `Your edits to ${editor} change lines this release also changes, so they cannot `
      + `be carried over on their own. ${nothing} Open ${editor} on the dashboard, copy your `
      + 'additions somewhere safe, remove them, update, then add them back.',
    'skip-worktree': 'This file is marked so that local changes to it are hidden, and this release '
      + `changes it, so the update cannot tell whether your copy would be lost. ${nothing} Ask `
      + 'whoever set up this install to remove that mark and keep or undo the local change, then '
      + 'update again.',
    'assume-unchanged': 'This file is marked as unchanged, so any local change to it is hidden, and '
      + `this release changes it. ${nothing} Ask whoever set up this install to remove that mark `
      + 'and keep or undo the local change, then update again.',
    'untracked-collision': 'This release adds a file at this path, and a file that is not part of '
      + `the install is already there. ${nothing} Move it out of the install directory, then update `
      + 'again.',
    'checkout-collision': 'The update stopped because this file would have been overwritten. The '
      + 'install was put back exactly as it was. Move the file out of the install directory, then '
      + 'update again.',
    'backup-failed': `TangleClaw could not save a copy of your edits before updating, so nothing `
      + `was changed. Make sure ${detail || 'its backup directory'} is writable, then update again.`
  };
  return { path: relPath, reason, action: actions[reason] };
}

/**
 * Build the `reconcile-required` refusal: what the operator must sort out
 * before an update can move the checkout. Returned only while the starting
 * state is intact. The code is written literally so the prompt guard's scan of
 * `_fail('<code>'` calls finds it.
 * @param {Array<{path: string, reason: string, action: string}>} items
 * @param {string} fromSha - Pre-update HEAD sha.
 * @returns {object}
 */
function _reconcile(items, fromSha) {
  log.info('Update needs reconciling', { items: items.map((i) => `${i.path} (${i.reason})`) });
  return Object.assign(
    _fail('reconcile-required', 'the update needs these files reconciled first — nothing was changed', fromSha),
    { reconcile: items }
  );
}

/**
 * Index flags for every tracked path, from `git ls-files -v`. An uppercase
 * `S` or lowercase `s` is skip-worktree; any lowercase tag is assume-unchanged.
 * `-z` keeps paths unquoted, so a name with unusual characters still matches.
 *
 * @returns {Map<string, {skip: boolean, assume: boolean}>}
 */
function _indexFlags() {
  const flags = new Map();
  for (const entry of _internal.git(['ls-files', '-v', '-z']).split('\0')) {
    if (entry.length < 3) continue;
    const tag = entry[0];
    flags.set(entry.slice(2), { skip: tag === 'S' || tag === 's', assume: tag !== tag.toUpperCase() });
  }
  return flags;
}

/**
 * The paths a checkout of `tag` would change, with git's status letter for
 * each (`A`, `M`, `D`, `T`). Renames are split into a delete and an add, so
 * both sides are checked.
 *
 * @param {string} tag - Release tag.
 * @returns {Map<string, string>}
 */
function _changedByTag(tag) {
  const fields = _internal.git(['diff', '--name-status', '-z', '--no-renames', 'HEAD', tag])
    .split('\0').filter(Boolean);
  const changed = new Map();
  for (let i = 0; i + 1 < fields.length; i += 2) changed.set(fields[i + 1], fields[i]);
  return changed;
}

/**
 * The nearest thing on disk that a checkout writing `relPath` would have to
 * replace: the path itself, or a parent that exists as something other than a
 * directory (git would delete it to make the directory). Null when nothing
 * is in the way. Any failure to look, other than absence, reads as in the way.
 *
 * A tracked parent is not in the way: a release that turns a tracked file into
 * a directory deletes that file itself, and git replaces its own file.
 *
 * @param {string} relPath - Repo-relative path the release adds.
 * @param {Map<string, object>} tracked - Index entries, from `_indexFlags`.
 * @returns {string|null} The repo-relative path in the way.
 */
function _blockerOnDisk(relPath, tracked) {
  const parts = relPath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    // Git removes its own file and writes everything beneath that path.
    if (tracked.has(parent)) return null;
    try {
      if (!fs.lstatSync(_repoPath(parent)).isDirectory()) return parent;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      return parent;
    }
  }
  return _existsOnDisk(relPath) ? relPath : null;
}

/**
 * Whether something is on disk at a repo-relative path. A path git would have
 * to write through (a missing parent, a file where a directory is expected)
 * reads as absent here; `_blockerOnDisk` is the check that covers those. Any
 * other failure to look reads as present, which refuses rather than risks a
 * file.
 *
 * @param {string} relPath - Repo-relative path.
 * @returns {boolean}
 */
function _existsOnDisk(relPath) {
  try {
    fs.lstatSync(_repoPath(relPath));
    return true;
  } catch (err) {
    return !(err.code === 'ENOENT' || err.code === 'ENOTDIR');
  }
}

/**
 * Three-way merge of a carried file with `git merge-file`, in a private
 * temporary directory that is always removed.
 *
 * `merge-file` exits 0 on a clean merge and with the number of conflicts
 * otherwise. A signal, or an exit above 127, is a failure to merge at all and
 * is thrown, never read as a conflict.
 *
 * @param {Buffer} ours - The operator's working copy.
 * @param {Buffer} base - The file at HEAD.
 * @param {Buffer} theirs - The file at the release tag.
 * @returns {{clean: boolean, bytes: Buffer|null}}
 */
function _mergeFile(ours, base, theirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-update-merge-'));
  try {
    const put = (name, bytes) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, bytes, { mode: 0o600 });
      return p;
    };
    const args = ['merge-file', '-p', put('ours', ours), put('base', base), put('theirs', theirs)];
    try {
      return { clean: true, bytes: _internal.gitBytes(args) };
    } catch (err) {
      if (!err.signal && Number.isInteger(err.status) && err.status > 0 && err.status < 128) {
        return { clean: false, bytes: null };
      }
      throw err;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Decide, before anything moves, what the checkout of `tag` would run into.
 *
 * Read-only. Every path the tag changes is checked for an index flag and for
 * an untracked file in its way, ignored or not: git refuses a plain untracked
 * file, but it overwrites an ignored one without a word, and an ignored file
 * can be someone's work (`.tangleclaw/memories/`). A carried file that differs
 * from HEAD is merged with the tag's copy here, so a conflict is known before
 * anything is touched. A carried file that matches HEAD needs no carry, even
 * with a flag set: git checks out an unchanged skip-worktree file normally.
 *
 * @param {string} tag - Release tag.
 * @returns {{reconcile: Array<object>, carries: Array<{path: string,
 *   original: Buffer, merged: Buffer, mode: number,
 *   flags: {skip: boolean, assume: boolean}}>}}
 */
function _preflight(tag) {
  const reconcile = [];
  const carries = [];
  const changed = _changedByTag(tag);
  if (changed.size === 0) return { reconcile, carries };
  const flags = _indexFlags();

  for (const [relPath, status] of changed) {
    const f = flags.get(relPath);
    if (_CARRIED.has(relPath) && f) {
      const abs = _repoPath(relPath);
      let original;
      try {
        original = fs.readFileSync(abs);
      } catch (err) {
        // Only a flag can hide a deleted carried file from porcelain; with no
        // file there is nothing to carry, so the flag is what to reconcile.
        if (err.code !== 'ENOENT' || !(f.skip || f.assume)) throw err;
        reconcile.push(_reconcileItem(relPath, f.skip ? 'skip-worktree' : 'assume-unchanged'));
        continue;
      }
      const base = _internal.gitBytes(['show', `HEAD:${relPath}`]);
      if (original.equals(base)) continue;
      if (status === 'D') {
        // The release removes a file the operator has edited: there is
        // nothing to carry the edits into.
        reconcile.push(_reconcileItem(relPath, 'merge-conflict'));
        continue;
      }
      const theirs = _internal.gitBytes(['show', `${tag}:${relPath}`]);
      const merge = _mergeFile(original, base, theirs);
      if (!merge.clean) {
        reconcile.push(_reconcileItem(relPath, 'merge-conflict'));
        continue;
      }
      carries.push({
        path: relPath, original, merged: merge.bytes,
        mode: fs.statSync(abs).mode & 0o777, flags: { skip: f.skip, assume: f.assume }
      });
      continue;
    }
    if (f && f.skip) reconcile.push(_reconcileItem(relPath, 'skip-worktree'));
    else if (f && f.assume) reconcile.push(_reconcileItem(relPath, 'assume-unchanged'));
    else if (!f && status !== 'D') {
      const blocker = _blockerOnDisk(relPath, flags);
      if (blocker && !reconcile.some((r) => r.path === blocker)) {
        reconcile.push(_reconcileItem(blocker, 'untracked-collision'));
      }
    }
  }
  return { reconcile, carries };
}

/**
 * Keep the exact original bytes of a carried file before anything changes.
 *
 * The copy is private (directory 0700, file 0600) and never replaces an
 * earlier one. It is written in full to a temporary name, flushed, and then
 * published with `link()`, which fails rather than overwriting. A file already
 * at the name with identical bytes is reused. A different one moves this copy
 * to a name carrying its digest, then to numbered attempts. Throws when no copy
 * can be secured, and the caller refuses the update.
 *
 * @param {string} relPath - Repo-relative path of the carried file.
 * @param {Buffer} bytes - The exact original bytes.
 * @param {string} fromSha - Pre-update HEAD sha.
 * @param {string} tag - Release tag being applied.
 * @returns {string} Absolute path of the backup.
 */
function _secureBackup(relPath, bytes, fromSha, tag) {
  const dir = _internal.backupDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = path.extname(relPath);
  const stem = path.basename(relPath, ext);
  // A tag comes from origin, so it is reduced to filename-safe characters.
  const stamp = `${stem}.${fromSha.slice(0, 7)}-${String(tag).replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const names = [`${stamp}${ext}`, `${stamp}.${digest}${ext}`];
  for (let n = 2; n <= 20; n++) names.push(`${stamp}.${digest}-${n}${ext}`);

  const tmp = path.join(dir, `.${stem}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  // Removed on every path, a failed write included: an unpublished partial copy
  // is not a backup, and it must not be left beside the real ones.
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (const name of names) {
      const dest = path.join(dir, name);
      try {
        fs.linkSync(tmp, dest);
        return dest;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (fs.readFileSync(dest).equals(bytes)) return dest;
      }
    }
    throw new Error(`no free backup name for ${stamp} in ${dir}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Create a consistent pre-update SQLite backup via `VACUUM INTO` and verify its
 * integrity. Returns the backup path and SHA-256 digest, or throws on failure.
 *
 * A pre-update backup gives the operator a verified rollback target before the
 * git checkout moves the codebase. Integrity is checked on the backup copy (not
 * the live DB), so a passing check proves both that the live DB was accessible
 * and that the backup itself is uncorrupted (#2577).
 *
 * @param {string} version - Target release version, used in the backup filename.
 * @param {string} fromSha - Pre-update HEAD sha, for log correlation.
 * @returns {{ path: string, sha256: string }}
 */
function _backupSqlite(version, fromSha) {
  const dbPath = _internal.getDbPath();
  const dir = _internal.backupDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // ISO timestamp with colons and decimal point removed for filesystem compatibility.
  // Milliseconds are kept (no stripping) to prevent filename collisions when two
  // backup calls land in the same second (e.g., rapid successive updates or tests).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safVer = String(version).replace(/[^A-Za-z0-9._-]/g, '_');
  const dest = path.join(dir, `tangleclaw-pre-update-${safVer}-${stamp}.db`);
  log.info('Creating pre-update SQLite backup', { from: dbPath, to: dest, fromSha });
  _internal.vacuumDb(dbPath, dest);
  _internal.chmodBackupFile(dest, 0o600);
  const rows = _internal.integrityCheck(dest);
  if (!rows || rows.length !== 1 || rows[0] !== 'ok') {
    log.warn('Pre-update SQLite integrity check failed', { rows, backup: dest });
    // prawduct:allow prawduct/broad-except -- best-effort cleanup of a corrupt
    // backup file; the failure is already logged above and the throw carries it.
    try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    throw new Error(`SQLite integrity check failed: ${rows ? rows.join(', ') : 'no result'}`);
  }
  const sha256 = crypto.createHash('sha256').update(_internal.readBackupFile(dest)).digest('hex');
  log.info('Pre-update SQLite backup verified', { path: dest, sha256, fromSha });
  return { path: dest, sha256 };
}
// Exposed on _internal (not top-level exports) so tests access it without
// triggering the dead-export ratchet (#2577 / A453 guardrail 2).
_internal.backupSqlite = _backupSqlite;

/**
 * Replace a file in the checkout in one step: write the whole content to a
 * temporary sibling, then rename it over the file, so a reader never sees half
 * of it. A seam (`_internal.writeRepoFile`) so tests can fail a single write.
 *
 * @param {string} relPath - Repo-relative path.
 * @param {Buffer} bytes - Full new content.
 * @param {number} mode - Permission bits to keep.
 */
function _writeRepoFile(relPath, bytes, mode) {
  const dest = _repoPath(relPath);
  const tmp = `${dest}.tc-update-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  // The temp file is removed on any failure, the write's own included: a
  // leftover would sit in the checkout as an untracked file nobody made, and
  // the next update would refuse because of it.
  try {
    fs.writeFileSync(tmp, bytes, { mode, flag: 'wx' });
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
_internal.writeRepoFile = _writeRepoFile;

/**
 * Set both index flags on a path to the given values.
 *
 * One flag per call. Given `--no-skip-worktree --no-assume-unchanged` together,
 * git 2.50 leaves skip-worktree set (probed), and the restore that follows
 * then fails because git no longer sees the file.
 *
 * @param {string} relPath - Repo-relative path.
 * @param {{skip: boolean, assume: boolean}} flags
 */
function _setFlags(relPath, flags) {
  _git('update-index', flags.skip ? '--skip-worktree' : '--no-skip-worktree', '--', relPath);
  _git('update-index', flags.assume ? '--assume-unchanged' : '--no-assume-unchanged', '--', relPath);
}

/**
 * The paths git named in a "would be overwritten by checkout" refusal, or null
 * when the failure is anything else. Only a diagnosed overwrite becomes
 * `checkout-collision`. Every other failure stays `git-error`.
 *
 * @param {Error} err - The failed checkout's error.
 * @returns {string[]|null}
 */
function _diagnoseCollision(err) {
  const text = `${err && err.stderr ? String(err.stderr) : ''}\n${err && err.message ? err.message : ''}`;
  if (!/would be overwritten by checkout:/.test(text)) return null;
  const paths = new Set();
  let inList = false;
  for (const line of text.split('\n')) {
    if (/would be overwritten by checkout:/.test(line)) { inList = true; continue; }
    if (inList && line.startsWith('\t')) paths.add(line.slice(1).trim());
    else inList = false;
  }
  return paths.size ? [...paths] : null;
}

/**
 * Put the checkout back exactly as the update found it, after a step failed
 * partway: the starting ref and commit, and each carried file's original bytes
 * and index flags.
 *
 * Each repair step runs even when an earlier one failed, and the outcome is
 * then measured rather than assumed: HEAD, the ref, the bytes and the flags
 * are read back and compared.
 *
 * @param {{sha: string, ref: string}} start - Where the update began.
 * @param {Array<object>} carries - From `_preflight`.
 * @returns {{restored: boolean, problems: string[]}}
 */
function _compensate(start, carries) {
  const problems = [];
  const attempt = (label, fn) => {
    try {
      fn();
    } catch (err) {
      // prawduct:allow prawduct/broad-except -- every repair step must run and
      // its failure must be reported, whatever threw; the read-back below is
      // what decides whether the checkout is intact.
      problems.push(`${label}: ${err && err.message}`);
    }
  };
  const none = { skip: false, assume: false };
  for (const c of carries) attempt(`clear flags on ${c.path}`, () => _setFlags(c.path, none));
  // Back to the committed copy first, so returning to the starting ref is not
  // itself blocked by the merged content.
  if (carries.length) attempt('restore carried files', () => _git('checkout', '--', ...carries.map((c) => c.path)));
  attempt('return to the starting ref', () => {
    if (_git('rev-parse', 'HEAD') === start.sha && _git('rev-parse', '--abbrev-ref', 'HEAD') === _refName(start)) return;
    if (start.ref === 'main') _git('checkout', 'main');
    else _git('checkout', '--detach', start.sha);
  });
  for (const c of carries) attempt(`write back ${c.path}`, () => _internal.writeRepoFile(c.path, c.original, c.mode));
  for (const c of carries) {
    if (c.flags.skip || c.flags.assume) attempt(`restore flags on ${c.path}`, () => _setFlags(c.path, c.flags));
  }

  const observed = _observe(carries);
  const restored = problems.length === 0
    && observed.headSha === start.sha
    && observed.ref === _refName(start)
    && (carries.length === 0 || (observed.fileMatchesOriginal === true && observed.flagsMatchOriginal === true));
  return { restored, problems, observed };
}

/**
 * Read back what the checkout holds after a compensation. Each fact is read on
 * its own and is null when it cannot be read, so a report never claims more
 * than was observed. The two file facts are null when nothing was carried.
 *
 * @param {Array<object>} carries - From `_preflight`.
 * @returns {{headSha: string|null, ref: string|null,
 *   fileMatchesOriginal: boolean|null, flagsMatchOriginal: boolean|null}}
 */
function _observe(carries) {
  const read = (fn) => {
    try {
      return fn();
    } catch {
      // prawduct:allow prawduct/broad-except -- an unreadable fact is
      // reported as null, which is the observation; nothing is swallowed.
      return null;
    }
  };
  const none = { skip: false, assume: false };
  return {
    headSha: read(() => _git('rev-parse', 'HEAD')),
    ref: read(() => _git('rev-parse', '--abbrev-ref', 'HEAD')),
    fileMatchesOriginal: carries.length
      ? read(() => carries.every((c) => fs.readFileSync(_repoPath(c.path)).equals(c.original)))
      : null,
    flagsMatchOriginal: carries.length
      ? read(() => {
        const flags = _indexFlags();
        return carries.every((c) => {
          const now = flags.get(c.path) || none;
          return now.skip === c.flags.skip && now.assume === c.flags.assume;
        });
      })
      : null
  };
}

/**
 * What `git rev-parse --abbrev-ref HEAD` prints at the starting point: the
 * branch name on `main`, and `HEAD` when detached at a release tag.
 * @param {{ref: string}} start
 * @returns {string}
 */
function _refName(start) {
  return start.ref === 'main' ? 'main' : 'HEAD';
}

/**
 * The steps of a move, in order. `recovery.failedStep` is always one of these,
 * so a consumer can branch on it; the error prose is never the contract.
 */
const MOVE_STEPS = Object.freeze(['clear-flags', 'restore', 'checkout', 'write-merged', 'restore-flags']);

/**
 * Move the checkout to `tag`, carrying each operator-authored file's edits.
 *
 * With no carries this is the plain `git checkout <tag>`. With carries, the
 * flags are cleared (a skip-worktree entry is skipped by `checkout --`), the
 * file is restored to its committed copy so the checkout is not blocked, the
 * tag is checked out, the merged bytes are written and the flags put back.
 * Any failure is compensated before a result is returned.
 *
 * @param {string} tag - Release tag.
 * @param {Array<object>} carries - From `_preflight`, each with `backup`.
 * @param {{sha: string, ref: string}} start - Where the update began.
 * @returns {{ok: true}|{ok: false, result: object}}
 */
function _moveToTag(tag, carries, start) {
  const none = { skip: false, assume: false };
  const [CLEAR, RESTORE, CHECKOUT, WRITE, REFLAG] = MOVE_STEPS;
  let step = CLEAR;
  try {
    for (const c of carries) if (c.flags.skip || c.flags.assume) _setFlags(c.path, none);
    step = RESTORE;
    if (carries.length) _git('checkout', '--', ...carries.map((c) => c.path));
    step = CHECKOUT;
    // Without the flag, git deletes an ignored file that stands where the
    // release needs a directory, silently. The preflight looks for that case;
    // this makes git refuse it too, and the refusal maps to checkout-collision.
    _git('checkout', '--no-overwrite-ignore', tag);
    step = WRITE;
    for (const c of carries) _internal.writeRepoFile(c.path, c.merged, c.mode);
    step = REFLAG;
    for (const c of carries) if (c.flags.skip || c.flags.assume) _setFlags(c.path, c.flags);
    return { ok: true };
  } catch (err) {
    const safe = redactRemoteOutput(err && err.message);
    log.warn('Update move failed; putting the checkout back', { step, error: safe, fromSha: start.sha });
    const back = _compensate(start, carries);
    if (!back.restored) {
      const backups = carries.map((c) => c.backup);
      // The repair's own error text stays in the log. The response carries
      // only the stable step, what was re-observed, and where the copies are.
      log.error('Update could not restore the starting checkout', {
        step, problems: back.problems.map((p) => redactRemoteOutput(p)), observed: back.observed, backups
      });
      return {
        ok: false,
        result: {
          ok: false,
          code: 'recovery-failed',
          error: `the update failed at "${step}" and the checkout could not be verified as put back — `
            + 'manual recovery is required; do not update or restart until it is done'
            + (backups.length ? `. Pre-update copies: ${backups.join(', ')}` : ''),
          fromSha: start.sha, toRef: null, toSha: null,
          recovery: {
            fromSha: start.sha, fromRef: start.ref, backup: backups, failedStep: step, observed: back.observed
          }
        }
      };
    }
    const collided = step === CHECKOUT ? _diagnoseCollision(err) : null;
    if (collided) {
      return { ok: false, result: _reconcile(collided.map((p) => _reconcileItem(p, 'checkout-collision')), start.sha) };
    }
    return { ok: false, result: { ok: false, code: 'git-error', error: safe, fromSha: start.sha, toRef: null, toSha: null } };
  }
}

/**
 * Fetch tags and resolve the latest release tag on origin — shared by the
 * plain-checkout path and the rebase path (#2399) so the two can never
 * resolve a different tag within the same `applyUpdate()` call.
 * @returns {string|null} The latest tag, or null when origin has none.
 */
function _resolveLatestTag() {
  _git('fetch', '--tags', 'origin');
  return updateChecker.findLatestVersion(
    updateChecker.parseTagsOutput(_git('ls-remote', '--tags', 'origin'))
  );
}

/**
 * Run the pre-update SQLite backup (#2577), or build the `reconcile-required`
 * refusal on failure — shared by the plain-checkout path and the rebase path
 * (#2399) so the two guards can never silently diverge.
 * @param {string} latestVersion - `status.latestVersion`, for the backup's filename.
 * @param {string} fromSha - Pre-update HEAD sha.
 * @returns {{dbBackup: object}|{refusal: object}}
 */
function _backupOrReconcile(latestVersion, fromSha) {
  try {
    return { dbBackup: _internal.backupSqlite(latestVersion, fromSha) };
  } catch (err) {
    log.warn('Pre-update SQLite backup failed; refusing update', { error: err && err.message });
    let where = null;
    try { where = _internal.backupDir(); } catch { /* best effort */ }
    return { refusal: _reconcile([_reconcileItem('tangleclaw.db', 'backup-failed', where)], fromSha) };
  }
}

/**
 * Attempt a rebase-style update for a local branch (#2399): when the branch's
 * fork point from `main` is reachable from the latest release tag, replay the
 * branch's own commits on top of that tag instead of refusing outright. This
 * is what lets an install carrying a few small local fixes on its own branch
 * keep using the update button.
 *
 * Returns `null` when the branch is not eligible — no local `main` or no
 * common history with it, or the fork point is not an ancestor of the latest
 * tag — so the caller falls through to the ordinary `wrong-ref` refusal; the
 * default behavior for every other branch shape is unchanged.
 *
 * Deliberately skips the checkout-only preflight/carry machinery
 * (`_preflight`, `_secureBackup`, `_moveToTag`): that machinery exists to
 * hand-replicate a three-way merge around a raw `git checkout`, which has no
 * merge of its own. A rebase already runs git's real three-way merge for
 * every tracked file, not just the carried ones, so there is nothing left for
 * the carry step to protect.
 *
 * @param {string} branchRef - The checked-out branch name (never `'HEAD'`).
 * @param {string} latestVersion - `status.latestVersion` from the caller's
 *   own `checkForUpdate()` call, reused here for the SQLite backup label.
 * @param {string} fromSha - Pre-update HEAD sha.
 * @returns {object|null} A full `applyUpdate` result, or `null` if not eligible.
 */
function _tryRebaseOntoTag(branchRef, latestVersion, fromSha) {
  let base;
  try {
    base = _git('merge-base', branchRef, 'main');
  } catch {
    return null; // no local `main`, or no common history with it
  }

  const latestTag = _resolveLatestTag();
  if (!latestTag) return null; // let the caller's own guards handle a missing tag

  try {
    _git('merge-base', '--is-ancestor', base, latestTag);
  } catch {
    return null; // fork point isn't reachable from the tag — not a safe linear replay
  }

  const backup = _backupOrReconcile(latestVersion, fromSha);
  if (backup.refusal) return backup.refusal;
  const { dbBackup } = backup;

  try {
    _git('rebase', latestTag);
  } catch {
    // Best-effort everywhere in this block: a throw from ANY of these must
    // never skip `git rebase --abort` itself — that is the one call that
    // actually puts the checkout back, and a diff or readback failure must
    // not cost it.
    const readBack = (fn) => { try { return fn(); } catch { return null; } };
    const conflicts = readBack(() => _git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)) || [];
    let abortOk = true;
    let abortErr = null;
    try {
      _git('rebase', '--abort');
    } catch (err) {
      abortOk = false;
      abortErr = err && err.message;
    }

    // "Nothing was changed" is a claim, not an assumption — a failed or
    // partial abort can leave a rebase in progress with a detached,
    // part-replayed HEAD and a dirty tree. Read back the three facts that
    // together prove the branch is exactly where it started before saying so.
    const restoredSha = readBack(() => _git('rev-parse', 'HEAD'));
    const restoredRef = readBack(() => _git('rev-parse', '--abbrev-ref', 'HEAD'));
    const restoredClean = readBack(() => _internal.git(['status', '--porcelain']));
    const restored = abortOk && restoredSha === fromSha && restoredRef === branchRef
      && restoredClean !== null && restoredClean.trim() === '';

    if (!restored) {
      log.error('Rebase abort did not provably restore the starting checkout', {
        branch: branchRef, tag: latestTag, abortOk, abortErr, restoredSha, restoredRef, fromSha
      });
      return {
        ok: false, code: 'recovery-failed',
        error: 'the rebase could not be completed and the checkout could not be verified as put back — '
          + 'manual recovery is required; do not update or restart until it is done',
        fromSha, toRef: null, toSha: null,
        recovery: {
          fromSha, fromRef: branchRef, backup: [], failedStep: 'rebase',
          observed: {
            headSha: restoredSha, ref: restoredRef,
            fileMatchesOriginal: null, flagsMatchOriginal: null
          }
        }
      };
    }

    log.warn('Rebase onto release tag conflicted; aborted and refused', { branch: branchRef, tag: latestTag, conflicts });
    return Object.assign(
      _fail('rebase-conflict',
        `local commits on "${branchRef}" could not be replayed onto ${latestTag} — resolve the conflicts below and retry`,
        fromSha),
      { conflicts }
    );
  }

  const toSha = _git('rev-parse', 'HEAD');
  const changed = _git('diff', '--name-only', fromSha, toSha).split('\n').filter(Boolean);
  const manifestChanged = changed.includes('package.json') || changed.includes('package-lock.json');
  const assetsChanged = changed.filter((f) => f.startsWith('deploy/'));
  const provisioning = {
    manifestChanged,
    assetsChanged,
    action: (manifestChanged || assetsChanged.length > 0) ? 'manual' : null
  };

  log.info(`Update applied (rebase): ${fromSha.slice(0, 7)} → ${latestTag} (${toSha.slice(0, 7)}) on "${branchRef}"; restart pending`, { provisioning });
  return {
    ok: true, code: null, error: null, fromSha, toRef: latestTag, toSha, provisioning,
    carried: [], dbBackup, rebased: true
  };
}

/**
 * Apply the latest available release: fetch tags, `git checkout <latest tag>`,
 * then provision what the checkout alone does not move (#711 chunk 01).
 * Each guard fails closed; never restarts (the caller chains the restart route).
 *
 * Provisioning, precisely — DETECT AND REPORT, never execute:
 * - Changed deploy assets (anything under `deploy/`: launchd plists,
 *   tmux.conf, install.sh) are reported, never auto-applied. The operator
 *   runs `./deploy/install.sh`, which handles both ingress modes; it reloads
 *   launchd services, and a node without Full Disk Access
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
 *   carried?: Array<{path: string, backup: string}>,
 *   dirty?: {discardable: string[], realWork: string[], carried: string[]},
 *   reconcile?: Array<{path: string, reason: string, action: string}>,
 *   conflicts?: string[],
 *   rebased?: boolean,
 *   recovery?: {fromSha: string, fromRef: string, backup: string[], failedStep: string,
 *     observed: {headSha: string|null, ref: string|null,
 *       fileMatchesOriginal: boolean|null, flagsMatchOriginal: boolean|null}}}}
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
    // An operator-authored file changed only in the working tree is taken out
    // first and reported as `dirty.carried`: it is carried at step 10, never
    // discarded and never a blocker.
    // Read-only: nothing is discarded until every check below has passed.
    const { porcelain, carried: carriedDirty } = _splitCarried(_internal.git(['status', '--porcelain']));
    let toDiscard = [];
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
          {
            dirty: {
              discardable: dirty.discardable.map((e) => e.path),
              realWork: dirty.realWork,
              // Operator-authored files that are detected and will be kept:
              // neither TangleClaw's to discard nor in the way.
              carried: carriedDirty
            }
          }
        );
      }
      toDiscard = dirty.discardable;
    }

    // 4. Guard — HEAD is on an updatable ref (main, or detached at a release tag).
    const head = _headState();
    if (!head.updatable) {
      // 4.1. A local branch's own commits can still ride along (#2399) when
      // its fork point from `main` is reachable from the latest tag — replay
      // them on top of the tag instead of refusing outright.
      if (head.ref !== 'HEAD') {
        const rebased = _tryRebaseOntoTag(head.ref, status.latestVersion, fromSha);
        if (rebased) return rebased;
      }
      return _fail('wrong-ref', `refusing to update from "${head.ref}" — checkout main (or a release tag) first`, fromSha);
    }

    // 4.5. Create a consistent pre-update SQLite backup and verify its integrity
    // (#2577). A failure is a hard refusal: proceeding without a verified backup
    // leaves no rollback target if the post-update state is unworkable.
    // Uses _reconcile (not a top-level _fail code) so public/session.js does not
    // need a new code entry and test/update-prompt-guards.test.js stays green
    // (A453 guardrail 1).
    const backup = _backupOrReconcile(status.latestVersion, fromSha);
    if (backup.refusal) return backup.refusal;
    const { dbBackup } = backup;

    // 5-6. Fetch the latest tags and resolve the latest release tag (Decision A).
    const latestTag = _resolveLatestTag();
    if (!latestTag) {
      return _fail('no-tag', 'no release tag found on origin', fromSha);
    }

    // 7. Preflight (#1730): everything the checkout would run into, found
    // while nothing has moved, and returned as one refusal.
    const pre = _preflight(latestTag);
    if (pre.reconcile.length) return _reconcile(pre.reconcile, fromSha);

    // 8. The exact original bytes of every carried file are kept first. No
    // copy, no update.
    for (const c of pre.carries) {
      try {
        c.backup = _secureBackup(c.path, c.original, fromSha, latestTag);
      } catch (err) {
        log.warn('Could not back up a carried file; refusing the update', { path: c.path, error: err && err.message });
        let where = null;
        try { where = _internal.backupDir(); } catch { /* the directory itself is what failed */ }
        return _reconcile([_reconcileItem(c.path, 'backup-failed', where)], fromSha);
      }
    }

    // 9. The operator-approved discard, now that nothing can refuse before
    // the move. These are TangleClaw's own proven changes, restored to the
    // committed copy at the operator's request, so a later failure does not
    // reinstate them.
    if (toDiscard.length) {
      _discardTcFiles(toDiscard);
      // The discard must PROVE it produced a clean tree before anything moves.
      if (_splitCarried(_internal.git(['status', '--porcelain'])).porcelain.trim()) {
        return _fail('dirty-tree',
          'restoring TangleClaw\'s changed files did not produce a clean tree — refusing', fromSha);
      }
    }

    // 10. Move to the tag, carrying the operator's edits (D3). Compensated on
    // any failure before a result is returned.
    const moved = _moveToTag(latestTag, pre.carries, { sha: fromSha, ref: head.ref });
    if (!moved.ok) return moved.result;
    const carried = pre.carries.map((c) => ({ path: c.path, backup: c.backup }));
    if (carried.length) log.info('Carried operator edits across the update', { carried });

    const toSha = _git('rev-parse', 'HEAD');

    // 11. Report what the checkout did not move (#711 chunk 01). Detect and
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
    return { ok: true, code: null, error: null, fromSha, toRef: latestTag, toSha, provisioning, carried, dbBackup };
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

/**
 * Fast-forward this checkout directly onto a proven records-only upstream
 * delta (#1710 Layer 2) — no carry, no reconcile, no sqlite backup, because
 * a records-only delta by definition touches nothing executable or
 * operator-authored-and-tracked. Every precondition below must hold before
 * the merge runs; a failed one refuses the same way `applyUpdate` refuses,
 * via `_fail`, never discarding or stashing anything:
 *   (a) HEAD is on `main` — never a feature branch;
 *   (b) the working tree is completely clean (`dirty-tree`, never discarded);
 *   (c) no wrap is running anywhere on the host — `wrap-run-registry.anyRunning`,
 *       the same signal `POST /api/server/restart` already refuses a restart
 *       on, reused here rather than a second notion of "is the host busy";
 *   (d) the merge itself is `--ff-only`, so a history that cannot fast-forward
 *       refuses rather than merging or rebasing.
 *
 * Takes the Layer 1 classification as `opts.delta` rather than reclassifying
 * it: a caller that already proved the delta records-only (or didn't) is the
 * one source of truth, never this function's own second guess.
 *
 * @param {object} [opts]
 * @param {{delta: string}} [opts.delta] - The proven classification from
 *   {@link module:lib/checkout-freshness.classifyUpstreamDelta}. Anything
 *   other than `delta: 'records-only'` is refused outright.
 * @returns {{ok: boolean, code: string|null, error: string|null, fromSha: string|null, toRef: string|null, toSha: string|null}}
 */
function applyAutomaticRecordsOnlyFastForward(opts = {}) {
  let fromSha = null;
  try {
    fromSha = _git('rev-parse', 'HEAD');
  } catch {
    return _fail('no-git', 'not a git checkout — cannot fast-forward');
  }
  const delta = opts.delta;
  if (!delta || delta.delta !== 'records-only') {
    return _fail('not-records-only',
      `refusing an unattended fast-forward — delta is "${delta && delta.delta}", not a proven records-only delta`, fromSha);
  }
  // The classification is a caller-supplied snapshot, not re-derived here —
  // require it to actually name real commits before trusting it for anything
  // (PRR-B Round 1 Blocker 1). This is a shape check only; whether it still
  // matches reality is re-verified immediately before the merge below.
  if (!SHA_SHAPE.test(delta.fromSha || '') || !SHA_SHAPE.test(delta.toSha || '')) {
    return _fail('unverified-delta',
      'refusing an unattended fast-forward — the classification carries no verifiable fromSha/toSha', fromSha);
  }
  const branch = _git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') {
    return _fail('wrong-ref', `refusing an unattended fast-forward from "${branch}" — only "main" auto-pulls`, fromSha);
  }
  if (_internal.git(['status', '--porcelain']).trim()) {
    return _fail('dirty-tree', 'working tree is not clean — refusing an unattended fast-forward', fromSha);
  }
  const wrapping = _internal.anyRunning();
  if (wrapping) {
    return _fail('wrap-running',
      `a session wrap is running for "${wrapping}" — refusing an unattended fast-forward while it runs`, fromSha);
  }
  // Re-verify immediately before mutating anything: the classification can
  // go stale between when it was computed and when this runs, and merging
  // whatever `origin/main` happens to point at BY THEN — the moving ref,
  // never re-checked against what was actually proven records-only — is
  // exactly the gap Blocker 1 closes. HEAD needs no fresh read: `fromSha`
  // above already IS that read.
  if (fromSha !== delta.fromSha) {
    return _fail('drift-detected',
      `refusing an unattended fast-forward — HEAD is ${fromSha.slice(0, 7)}, not the classified ${delta.fromSha.slice(0, 7)}`, fromSha);
  }
  let upstreamSha;
  try {
    upstreamSha = _git('rev-parse', 'origin/main');
  } catch {
    return _fail('no-git', 'could not read origin/main — cannot verify the fast-forward target', fromSha);
  }
  if (upstreamSha !== delta.toSha) {
    return _fail('drift-detected',
      `refusing an unattended fast-forward — origin/main is ${upstreamSha.slice(0, 7)}, not the classified ${delta.toSha.slice(0, 7)}`, fromSha);
  }
  try {
    // The verified SHA, never the moving ref — `origin/main` could have
    // advanced again between the read above and this call.
    _git('merge', '--ff-only', delta.toSha);
  } catch (err) {
    const safe = redactRemoteOutput(err.message);
    log.warn('Records-only fast-forward failed', { error: safe, fromSha });
    return { ok: false, code: 'git-error', error: safe, fromSha, toRef: null, toSha: null };
  }
  const toSha = _git('rev-parse', 'HEAD');
  log.info(`Records-only fast-forward applied: ${fromSha.slice(0, 7)} → ${toSha.slice(0, 7)}`);
  return { ok: true, code: null, error: null, fromSha, toRef: 'origin/main', toSha };
}

/**
 * The top-level stale-install decision (#1710): classify the upstream delta
 * (Layer 1), auto-pull when it is proven records-only (Layer 2), report a
 * pending diagnosis for an unmeasured delta ('unknown'/'pending' — nothing
 * to restart over, since nothing is proven about what changed), or — for a
 * delta that could change what a restart loads ('executable' or 'mixed') —
 * surface one structured restart-readiness payload rather than ever
 * restarting launchd unilaterally (Layer 3, Mode (b) "ask, but only when it
 * matters"; Mode (a) standing consent is opt-in only).
 *
 * **`fleetQuiet` is honest about what it can prove.** The one fleet-wide
 * signal this host has today is "no wrap running anywhere"
 * (`wrap-run-registry.anyRunning`); nothing in `lib/checkout-freshness.js` or
 * this module composes a cross-project "is any session mid-turn" read (that
 * lives, if anywhere, in `lib/workload-compose.js`'s availability
 * composition, which nothing outside itself calls yet). Rather than guess at
 * that signal, a caller that can answer it passes `opts.sessionsMidTurn`
 * explicitly; omitting it never claims quiet on its own strength.
 *
 * @param {object} project - Store row (`id`, `name`, `path`) for the
 *   checkout being evaluated — normally the running install's own project row.
 * @param {object} [opts]
 * @param {boolean} [opts.standingConsent] - Mode (a): when explicitly `true`
 *   and the fleet is quiet, an executable/mixed delta is marked authorized
 *   rather than held for an operator prompt. Defaults to Mode (b).
 * @param {boolean} [opts.sessionsMidTurn] - Whether any session elsewhere is
 *   mid-turn, when the caller can answer it; omitted/`null` is treated as
 *   "not proven quiet", never as "proven quiet".
 * @returns {object} One of:
 *   `{action: 'none', delta}` — already up to date;
 *   `{action: 'auto-pulled'|'auto-pull-refused', delta, result}` — a
 *   records-only delta, with Layer 2's outcome;
 *   `{action: 'pending-diagnosis', delta}` — 'unknown'/'pending': nothing is
 *   proven about what changed, so there is nothing concrete to restart over;
 *   `{action: 'restart-authorized-by-standing-consent', delta, fleetQuiet}` —
 *   Mode (a), opted in, fleet quiet;
 *   `{action: 'await_operator_restart_confirmation', delta, fleetQuiet, prompt,
 *   requiresOperatorAuthorization: true}` — Mode (b), the default.
 */
function evaluateStaleInstallResponse(project, opts = {}) {
  const delta = _internal.classifyUpstreamDelta(project);
  if (delta.delta === 'none') return { action: 'none', delta };
  if (delta.delta === 'records-only') {
    const result = applyAutomaticRecordsOnlyFastForward({ delta });
    return { action: result.ok ? 'auto-pulled' : 'auto-pull-refused', delta, result };
  }
  // 'unknown' | 'pending' — a measurement gap, not a decision point: nothing
  // here says what a restart would actually change, so framing it as
  // "restart now?" would offer a choice there is nothing concrete behind
  // (PRR-B Round 1 Warning). Reported separately, before `fleetQuiet` is
  // even computed — it answers a question this delta doesn't raise.
  if (delta.delta === 'unknown' || delta.delta === 'pending') {
    return { action: 'pending-diagnosis', delta };
  }
  // 'executable' | 'mixed' — never restart launchd unilaterally; see the
  // fleetQuiet note above for what this can and cannot prove.
  const wrapping = _internal.anyRunning();
  // Explicit `false` only (PRR-B Round 1 Blocker 2): the prior `=== true`
  // spelling treated an OMITTED or `null` `sessionsMidTurn` as "not
  // mid-turn", which made an unanswered signal prove quiet on its own —
  // exactly backwards from this function's own doc comment above. A caller
  // that cannot answer the question must not be read as having answered it
  // favorably.
  const fleetQuiet = !wrapping && opts.sessionsMidTurn === false;
  if (opts.standingConsent === true && fleetQuiet) {
    return { action: 'restart-authorized-by-standing-consent', delta, fleetQuiet };
  }
  const changedPaths = [...(delta.executablePaths || []), ...(delta.recordsPaths || [])];
  const summary = changedPaths.length
    ? changedPaths.slice(0, 5).join(', ') + (changedPaths.length > 5 ? `, +${changedPaths.length - 5} more` : '')
    : 'an unclassified change';
  return {
    action: 'await_operator_restart_confirmation',
    delta,
    fleetQuiet,
    prompt: `${summary} changed upstream (${delta.delta}); fleet is ${fleetQuiet ? 'quiet' : 'busy'} — restart now?`,
    requiresOperatorAuthorization: true
  };
}

module.exports = {
  applyUpdate, _internal, _gitOptions, _headState, _classifyDirty, _discardTcFiles,
  _managedRegionOnlyDiff, _hookRetirementOnlyDiff, _provenTcDelta, _outsideManagedBlock,
  MANAGED_BLOCK_CARRIERS, MANAGED_BLOCK_SYNTAX, HOOK_SETTINGS_FILE, PROOFS,
  OPERATOR_AUTHORED_TRACKED, MOVE_STEPS, _splitCarried, _preflight, _secureBackup, _diagnoseCollision,
  _reconcileItem, _writeRepoFile,
  applyAutomaticRecordsOnlyFastForward, evaluateStaleInstallResponse
};
