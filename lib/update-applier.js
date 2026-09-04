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
const updateChecker = require('./update-checker');
const engines = require('./engines');

const log = createLogger('update-applier');

const REPO_DIR = path.join(__dirname, '..');

/**
 * Injection seam (mirrors `server-info._internal`) so tests drive every guard
 * without a real repo. `git` runs argv-form (NOT a shell string) so a tag ref
 * from `origin` can never inject — the ref is an argv element, never parsed by
 * a shell.
 */
const _internal = {
  git: (args) => execFileSync('git', args, {
    cwd: REPO_DIR, timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  }),
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
 * (see `_classifyDirty`). `test/update-applier.test.js` pins it against
 * `data/engines/claude.json#configFormat.filename`, so a rename there fails
 * here instead of silently leaving this list pointing at nothing.
 */
const MANAGED_BLOCK_CARRIERS = ['CLAUDE.md'];

/** The comment syntax those carriers use, for locating the markers. */
const MANAGED_BLOCK_SYNTAX = 'markdown';

/**
 * A file's content with TangleClaw's managed region removed.
 *
 * Comparing the two elisions is what makes "the operator changed nothing here"
 * a proof rather than a guess. Deliberately NOT implemented by re-splicing and
 * comparing whole files: that would depend on the generator's demote/trim
 * passes being exactly idempotent, and a subtle failure there would read as
 * "the operator edited it" — or worse, the reverse.
 *
 * @param {string} text - File content.
 * @param {{begin: string, end: string}} markers - Managed-block delimiters.
 * @returns {string|null} Content outside the block, or null when the markers
 *   are absent, duplicated, or inverted — none of which can be reasoned about.
 */
function _outsideManagedBlock(text, markers) {
  if (text.split(markers.begin).length - 1 !== 1) return null;
  if (text.split(markers.end).length - 1 !== 1) return null;
  const start = text.indexOf(markers.begin);
  const stop = text.indexOf(markers.end);
  if (stop < start) return null;
  return text.slice(0, start) + text.slice(stop + markers.end.length);
}

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
  try {
    const markers = engines._managedBlockMarkers(MANAGED_BLOCK_SYNTAX);
    if (!markers) return false;
    // Untrimmed on both sides: trailing-whitespace differences outside the
    // block are still the operator's edit, and `_git` would erase them.
    const head = _internal.git(['show', `HEAD:${relPath}`]);
    const work = _internal.readFile(path.join(REPO_DIR, relPath));
    const headOutside = _outsideManagedBlock(head, markers);
    const workOutside = _outsideManagedBlock(work, markers);
    if (headOutside === null || workOutside === null) return false;
    return headOutside === workOutside;
  } catch {
    // prawduct:allow prawduct/broad-except -- any failure to establish
    // containment must read as "not provably ours", which is the safe answer.
    return false;
  }
}

/**
 * Split `git status --porcelain` output into what TangleClaw provably wrote
 * and what might be someone's work (#711 chunk 03).
 *
 * THE LINE, exactly as the ratified plan draws it: `.tangleclaw/*` and
 * `.claude/settings.json` — the two places TC's own machinery writes into a
 * managed clone. Deliberately NOT a `.claude/` directory sweep
 * (`settings.local.json` and anything else there is the operator's), and
 * deliberately no content-marker heuristics: a `Generated by TangleClaw`
 * stamp proves TC generated a file once, not that the current dirty delta is
 * TC's — an operator's later edit to a generated file must never be discarded
 * under a claim that nothing of theirs is in the list. Widening this set is a
 * recorded ruling, never an inference.
 *
 * Everything else is real work, INCLUDING any status line this parser cannot
 * read (renames, quoted paths with escapes): an unclassifiable entry fails
 * closed into realWork, which keeps the hard refusal.
 *
 * **Managed-block carriers are the one addition to THE LINE, and they do not
 * widen it — they are decided per-delta rather than by path** (#1241). TC
 * splices a delimited region into `CLAUDE.md` on every launch, so a tracked
 * carrier goes dirty on any release that changes generated guide text, and
 * without this the update dies in the hard refusal with no way out. The
 * ratified rule stands unchanged: a hand edit is never discarded. It is
 * enforced rather than assumed — `regionOnly` answers whether the working
 * copy matches HEAD *everywhere outside the markers*, and only then is the
 * entry discardable. Content OUTSIDE the block makes it real work, exactly as
 * before. This is still not a content-marker heuristic: nothing here infers
 * ownership from a `Generated by TangleClaw` stamp; it proves the delta is
 * confined to a region whose boundaries TC wrote.
 *
 * `regionOnly` is injected and defaults to null, which classifies carriers as
 * real work. A caller that cannot answer the containment question therefore
 * gets the pre-#1241 refusal rather than a guess, and this function stays pure
 * over its string input for every path that does not need the test.
 *
 * @param {string} porcelain - Raw `git status --porcelain` output.
 * @param {((relPath: string) => boolean)|null} [regionOnly] - True when the
 *   file differs from HEAD only inside TangleClaw's managed block.
 * @returns {{discardable: Array<{path: string, tracked: boolean}>, realWork: string[]}}
 */
function _classifyDirty(porcelain, regionOnly = null) {
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
    // An untracked carrier is not a carrier: `git checkout --` has nothing to
    // restore it from, and TC has never written a block into it.
    const carrier = tracked && MANAGED_BLOCK_CARRIERS.includes(rawPath);
    const tcWritten = rawPath.startsWith('.tangleclaw/') || rawPath === '.tangleclaw'
      || rawPath === '.tangleclaw/' || rawPath === '.claude/settings.json'
      || (carrier && typeof regionOnly === 'function' && regionOnly(rawPath) === true);
    if (tcWritten) {
      discardable.push({ path: rawPath, tracked });
    } else {
      realWork.push(rawPath);
    }
  }
  return { discardable, realWork };
}

/**
 * Discard the provably-TC entries: restore tracked files from HEAD, delete
 * untracked ones. Argv-form git throughout; `--` terminates option parsing so
 * a path can never be read as a flag. Throws on any git failure (the caller's
 * git-error path reports it with `fromSha`).
 *
 * @param {Array<{path: string, tracked: boolean}>} entries - From `_classifyDirty`.
 */
function _discardTcFiles(entries) {
  const tracked = entries.filter((e) => e.tracked).map((e) => e.path);
  const untracked = entries.filter((e) => !e.tracked).map((e) => e.path);
  // Logged BEFORE the operations: a discard that dies midway must still have
  // left a record of what it set out to remove.
  log.info('Discarding TangleClaw-written files blocking an update', { tracked, untracked });
  if (tracked.length) _git('checkout', '--', ...tracked);
  if (untracked.length) _git('clean', '-fd', '--', ...untracked);
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
      const dirty = _classifyDirty(porcelain, _managedRegionOnlyDiff);
      const canDiscard = dirty.realWork.length === 0 && dirty.discardable.length > 0;
      if (!(opts.discardDirty === true && canDiscard)) {
        const summary = dirty.realWork.length > 0
          ? 'local changes present — commit or stash before updating'
          : 'local changes present — all of them TangleClaw-written; retry with the '
            + 'discard option to remove them and update';
        return Object.assign(
          _fail('dirty-tree', summary, fromSha),
          { dirty: { discardable: dirty.discardable.map((e) => e.path), realWork: dirty.realWork } }
        );
      }
      _discardTcFiles(dirty.discardable);
      // The discard must PROVE it produced a clean tree before anything moves.
      if (_git('status', '--porcelain')) {
        return _fail('dirty-tree',
          'discarding TangleClaw-written files did not produce a clean tree — refusing', fromSha);
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
    log.warn('Update apply failed', { error: err.message, fromSha });
    return { ok: false, code: 'git-error', error: err.message, fromSha, toRef: null, toSha: null };
  }
}

module.exports = {
  applyUpdate, _internal, _headState, _classifyDirty,
  _managedRegionOnlyDiff, _outsideManagedBlock, MANAGED_BLOCK_CARRIERS
};
