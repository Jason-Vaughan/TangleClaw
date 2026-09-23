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
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
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
  backupDir: () => path.join(require('./store')._getBasePath(), 'backups')
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
    'merge-conflict': editor
      ? `Your edits to ${editor} change lines this release also changes, so they cannot be carried `
        + `over on their own. ${nothing} Open ${editor} on the dashboard, copy your additions `
        + 'somewhere safe, remove them, update, then add them back.'
      : `Your local copy of this file conflicts with this release. ${nothing} Move your changes out `
        + 'of the file, update, then add them back.',
    'skip-worktree': 'This file is marked so that git ignores local changes to it, and this release '
      + `changes it, so the update cannot tell whether your copy would be lost. ${nothing} Ask `
      + 'whoever set up this install to remove that mark and keep or undo the local change, then '
      + 'update again.',
    'assume-unchanged': 'This file is marked as unchanged, so git hides any local change to it, and '
      + `this release changes it. ${nothing} Ask whoever set up this install to remove that mark `
      + 'and keep or undo the local change, then update again.',
    'untracked-collision': 'This release adds a file at this path, and a file that is not part of '
      + `the install is already there. ${nothing} Move it out of the install directory, then update `
      + 'again.',
    'checkout-collision': 'The update stopped because this file would have been overwritten. The '
      + 'checkout was put back exactly as it was. Move the file out of the install directory, or '
      + 'commit it, then update again.',
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
 * Whether something is on disk at a repo-relative path. A path git would have
 * to write through (a missing parent, a file where a directory is expected)
 * reads as absent: the checkout's own collision check covers those. Any other
 * failure to look reads as present, which refuses rather than risks a file.
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
    else if (!f && _existsOnDisk(relPath)) reconcile.push(_reconcileItem(relPath, 'untracked-collision'));
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
  fs.writeFileSync(tmp, bytes, { mode, flag: 'wx' });
  try {
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
  let step = 'clear-flags';
  try {
    for (const c of carries) if (c.flags.skip || c.flags.assume) _setFlags(c.path, none);
    step = 'restore';
    if (carries.length) _git('checkout', '--', ...carries.map((c) => c.path));
    step = 'checkout';
    _git('checkout', tag);
    step = 'write-merged';
    for (const c of carries) _internal.writeRepoFile(c.path, c.merged, c.mode);
    step = 'restore-flags';
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
    const collided = step === 'checkout' ? _diagnoseCollision(err) : null;
    if (collided) {
      return { ok: false, result: _reconcile(collided.map((p) => _reconcileItem(p, 'checkout-collision')), start.sha) };
    }
    return { ok: false, result: { ok: false, code: 'git-error', error: safe, fromSha: start.sha, toRef: null, toSha: null } };
  }
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
      return _fail('wrong-ref', `refusing to update from "${head.ref}" — checkout main (or a release tag) first`, fromSha);
    }

    // 5. Fetch the latest tags.
    _git('fetch', '--tags', 'origin');

    // 6. Resolve the latest release tag (Decision A).
    const latestTag = updateChecker.findLatestVersion(
      updateChecker.parseTagsOutput(_git('ls-remote', '--tags', 'origin'))
    );
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
    return { ok: true, code: null, error: null, fromSha, toRef: latestTag, toSha, provisioning, carried };
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
  MANAGED_BLOCK_CARRIERS, MANAGED_BLOCK_SYNTAX, HOOK_SETTINGS_FILE, PROOFS,
  OPERATOR_AUTHORED_TRACKED, MOVE_STEPS, _splitCarried, _preflight, _secureBackup, _diagnoseCollision
};
