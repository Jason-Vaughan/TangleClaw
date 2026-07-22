'use strict';

/**
 * `features-toc` wrap step (#207, Chunk 3) — auto-appends stub entries
 * to `<projectPath>/FEATURES.md` for files touched in the session's
 * branch that are not already referenced anywhere in the index.
 *
 * **Contract (matches ADR 0002 step-kind philosophy — never blocks):**
 *
 *   - Skip when `projConfig.featureIndexEnabled !== true`.
 *   - **Self-heal when `FEATURES.md` is missing** (#425, parity with the
 *     project-map self-heal #423): the `featureIndexEnabled` toggle — not file
 *     deletion — is the off-switch, so a missing file under an enabled toggle is
 *     CREATED from `projects.FEATURE_INDEX_TEMPLATE` (then drift is appended onto
 *     the seed) rather than skipped forever. Covers a fresh clone where the file
 *     wasn't committed, a delete-to-regenerate, or a toggle path that didn't
 *     seed. The created seed is staged (`created:true`) so the commit-step flush
 *     writes it even when there is no drift to append.
 *   - Skip when the local working tree is not a git repo, when no session
 *     range resolves, or when the session diff is empty. The session range is
 *     `<lastWrapSha>..HEAD` — everything merged since the previous wrap,
 *     regardless of branch topology (#465), so drift is captured even when the
 *     session merged its PRs and wraps while checked out on `main` (where the old
 *     `<base>...HEAD` range was empty). Falls back to `<base>...HEAD` (`main`,
 *     then `master`) on the first wrap or when the recorded SHA no longer
 *     resolves. See {@link _resolveSessionRange}.
 *   - Skip when every touched-on-branch source file is already
 *     referenced somewhere in `FEATURES.md`.
 *   - Otherwise: append a `## TODO (auto-stubbed YYYY-MM-DD)` block
 *     containing one `- **TBD** — touched in this session: ` + backticked
 *     path entry per drifted file. The handler **stages** the new
 *     content under `staged['features-toc:append']` with the canonical
 *     `{primingPath, newContent, changed:true, addedCount, addedFiles,
 *     todoDate}` shape — `lib/wrap-steps/commit.js:_flushStagedWrites`
 *     duck-types on `{primingPath, newContent, changed}` so the file
 *     write lands during the commit step's single-transaction flush,
 *     never here. The commit body line is emitted from `_buildBodyLines`
 *     against `{addedCount, addedFiles}`.
 *
 * **Idempotence on re-run.** Drift is computed against the full
 * existing `FEATURES.md` content, including any prior auto-stub
 * sections. So running the wrap pipeline twice on the same branch
 * appends nothing the second time — the first append already covers
 * the drifted files. If the operator then edits the same files again
 * (post-stub), the file paths are already in the index and the second
 * wrap continues to skip them. Tightening the scan would require an
 * explicit "stub but un-resolved" marker — out of scope for Chunk 3;
 * the dogfood pass (Chunk 4) will surface whether finer-grained
 * tracking is worth the schema cost.
 *
 * **What counts as a "source file" worth indexing.** The handler
 * filters the git diff through an extension allowlist (`.js`, `.jsx`,
 * `.ts`, `.tsx`, `.json`, `.md`, `.html`, `.css`, `.yaml`, `.yml`,
 * `.sh`) and excludes vendored / build / hidden directories
 * (`node_modules/`, `dist/`, `coverage/`, `build/`, `.git/`,
 * `.tangleclaw/`, plus any path with a leading-dot segment), plus
 * project-level docs that change too often to be useful feature
 * pointers (`CHANGELOG.md`, `README.md`, `LICENSE`, the index itself
 * `FEATURES.md`). The set is intentionally moderate — narrower than
 * "every diff line", broader than "lib/ only" — and meant to be
 * tightened against dogfood feedback in Chunk 4 if it produces churn.
 *
 * **Only paths that still exist are stubbed.** A stub for a file the
 * session removed is a *dangling citation*: `FEATURES.md`'s citation
 * contract asserts every cited path exists on disk, so such a stub
 * fails the required test gate and blocks the wrap's own PR — stranding
 * that wrap's version bump on an unmerged branch while every step still
 * reports success.
 *
 * The guard is an existence check on the write path
 * ({@link _stillExists}), deliberately not a `--diff-filter` on the
 * range. Two distinct routes produce a doomed path, and only the
 * existence check closes both: a file deleted *within* the range, and a
 * file added earlier in the range then deleted in the *working tree* —
 * the latter still reports as added by any range diff, yet the wrap's
 * own `git add -A` commits its deletion moments later. Checking what is
 * on disk at write time asks the same question the citation contract
 * asks, so the two cannot disagree.
 *
 * **Aged dangling citations are healed, not ignored (#640).** The write-path
 * guard above only stops *new* dangling stubs. A citation whose target was
 * deleted in an *earlier* session still fails the contract test and strands the
 * wrap PR silently. On every run (except a fresh create — the seed has none),
 * the handler heals two ways: a dangling **auto-stub** it wrote itself (the
 * `- **TBD** …` line under a `## TODO (auto-stubbed …)` section) is PRUNED,
 * self-healing our own output; a dangling **hand-written** or already-described
 * citation is REPORTED as a named, non-blocking finding and left untouched,
 * because rewriting operator prose to make a required check pass is the wrong
 * default. See {@link _pruneDeadAutoStubs} and {@link _findDanglingCitations}.
 *
 * **Drift extraction.** Existing index entries are tokenized by a
 * single regex that scans for path tokens with the same extension
 * allowlist. The matcher is intentionally permissive (matches inside
 * backticks, free text, comments) so an entry written
 * `\`lib/foo.js:42\`` or `lib/foo.js (line 42)` both correctly
 * register the file. False positives (matching a substring inside a
 * comment about something else) bias toward over-skipping which
 * matches the never-blocks contract — a missed stub is recoverable,
 * a false-positive duplicate entry would be index pollution.
 *
 * @module lib/wrap-steps/features-toc
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { todayIsoLocal } = require('./_date');
const { createLogger } = require('../logger');
const store = require('../store');
const { makePathTokenRegex } = require('../path-tokens');
const gitRange = require('./_git-range');

const log = createLogger('wrap-step-features-toc');

const FEATURES_FILENAME = 'FEATURES.md';

// Extension allowlist — narrow to source-ish files. Future widening
// belongs in this constant only.
const INDEXABLE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx',
  '.json', '.md', '.html', '.css',
  '.yaml', '.yml', '.sh'
]);

// Paths whose names match an indexable extension but whose change
// rate makes them poor feature pointers. Matched against the
// basename of each diff entry.
// LICENSE has no extension so the allowlist check rejects it before we
// reach this set — basename matches here are only meaningful for paths
// that survived the extension check.
const EXCLUDED_BASENAMES = new Set([
  'CHANGELOG.md',
  'README.md',
  FEATURES_FILENAME
]);

// Prefix exclusions — applied to the full relative path. Anything
// rooted under one of these prefixes is dropped before drift
// detection.
const EXCLUDED_PREFIXES = [
  'node_modules/',
  'dist/',
  'coverage/',
  'build/',
  '.git/',
  '.tangleclaw/'
];

// #640 dangling-citation heal. An auto-stubbed TODO section heading and the
// literal stub-entry line this step writes (see `_appendTodoSection`), plus a
// generic markdown-heading matcher used to bound a section. Kept adjacent to the
// writer so the read (prune) and write (append) formats cannot drift apart.
const AUTOSTUB_HEADING_RE = /^##\s+TODO\s+\(auto-stubbed\s+\d{4}-\d{2}-\d{2}\)\s*$/;
const AUTOSTUB_ENTRY_RE = /^- \*\*TBD\*\* — touched in this session: `([^`]+)`/;
const MD_HEADING_RE = /^#{1,6}\s/;

// Path-like token matcher, shared with the continuity Map so their extension
// allowlists can't drift (CON-8H3Z — see lib/path-tokens). Anchor is
// intentionally loose (matches inside backticks, free text, link targets,
// comments); the trailing `(?:\b|:)` lets `:42` line refs register the path
// without the colon entering the captured group. Own module-scope instance so
// its `.lastIndex` stays isolated from the continuity consumer's.
const PATH_TOKEN_RE = makePathTokenRegex();

const GIT_EXEC_TIMEOUT_MS = 10 * 1000;

/**
 * Step handler. See module docstring for full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (`{name, path}`)
 * @param {object} context.step - Step spec from `wrap_pipeline.steps[]`
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:boolean, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project, staged } = context;
  if (!project || !project.path) {
    return _skipped('no project path');
  }

  // Toggle gate — same shape as Chunk 2's injection gate (#207
  // ADR 0001 symmetric gates). The wrap-step needs only the per-project
  // toggle; the engine-capability + silentPrime predicates are
  // injection-site concerns, not write-side concerns.
  let projConfig;
  try {
    projConfig = store.projectConfig.load(project.path);
  } catch (err) {
    return _skipped(`projectConfig.load threw: ${err.message}`);
  }
  if (!projConfig || projConfig.featureIndexEnabled !== true) {
    return _skipped('featureIndexEnabled is not true');
  }

  const featuresPath = path.join(project.path, FEATURES_FILENAME);

  // Self-heal parity with the Project Map (#425, mirrors project-map's #423):
  // the `featureIndexEnabled` toggle — not file deletion — is the off-switch,
  // so a missing FEATURES.md when the toggle is ON is an anomaly to recover
  // (fresh clone where the file wasn't committed, delete-to-regenerate, or a
  // toggle path that didn't seed) rather than a permanent skip. We base the
  // session's drift work on the seed *template* and flag `created:true`; the
  // staged write below creates the file at the commit-step flush even if no
  // drift is appended. The seed lives in `projects.FEATURE_INDEX_TEMPLATE`
  // (lazy-required to dodge the wrap-pipeline require cycle — see project-map's
  // module head) so the toggle-on seed and this self-heal share one source.
  let indexContent;
  let created = false;
  if (_internal.existsSync(featuresPath)) {
    try {
      indexContent = _internal.readFileSync(featuresPath, 'utf8');
    } catch (err) {
      return _skipped(`${FEATURES_FILENAME} unreadable: ${err.message}`);
    }
  } else {
    indexContent = require('../projects').FEATURE_INDEX_TEMPLATE;
    created = true;
  }

  // Heal dangling citations left by EARLIER sessions, independent of this
  // session's drift (#640). A cited path deleted in a prior session fails the
  // citation contract and strands the wrap PR while every step still reports
  // success. Prune the dead auto-stubs this step itself wrote (self-healing our
  // own output); report dead hand-written / already-described citations without
  // touching operator prose. Skipped on a fresh create — the seed has none.
  let workingContent = indexContent;
  let prunedPaths = [];
  let danglingHandwritten = [];
  if (!created) {
    const pruned = _pruneDeadAutoStubs(indexContent, project.path);
    workingContent = pruned.content;
    prunedPaths = pruned.prunedPaths;
    danglingHandwritten = _findDanglingCitations(workingContent, project.path);
  }

  // Compute this session's drift (new files to stub), tolerant of a missing
  // range or a diff failure — a prune above may still need flushing even when
  // there is nothing new to append. The `null` sentinels let `_finalize`
  // distinguish the skip causes when nothing changed and nothing is reported.
  let drifted = [];
  let todoDate = null;
  let touchedCount = null;
  let indexableCount = null;
  let candidateCount = null;
  let diffError = null;

  const sessionRange = _resolveSessionRange(project.path, projConfig.lastWrapSha);
  if (sessionRange) {
    let touchedFiles = null;
    try {
      touchedFiles = _diffNameOnly(project.path, sessionRange.range);
    } catch (err) {
      diffError = err.message;
    }
    if (touchedFiles) {
      touchedCount = touchedFiles.length;
      const indexable = touchedFiles.filter(_isIndexableCandidate);
      indexableCount = indexable.length;
      const candidates = indexable.filter((f) => _stillExists(project.path, f));
      candidateCount = candidates.length;
      const indexedSet = _extractIndexedPaths(workingContent);
      drifted = candidates.filter((f) => !indexedSet.has(f));
    }
  }

  if (drifted.length > 0) {
    todoDate = _internal.todayIso();
    workingContent = _appendTodoSection(workingContent, drifted, todoDate);
  }

  return _finalize({
    staged, featuresPath, indexContent, workingContent, created, drifted,
    todoDate, prunedPaths, danglingHandwritten, project, sessionRange,
    touchedCount, indexableCount, candidateCount, diffError
  });
}

/**
 * Build the step result: stage the working content when it changed, surface a
 * dangling-citation report when there is one, else fall through to the existing
 * skip taxonomy. Centralized (#640) so the create, prune-only, append, and
 * report outcomes share one staging + reporting path — and so a prune with no
 * drift still produces a staged write instead of a silent skip.
 *
 * @param {object} a - Collected run() state.
 * @returns {{ok:boolean, status:string, output:object, blockers:string[]}}
 */
function _finalize(a) {
  const {
    staged, featuresPath, indexContent, workingContent, created, drifted,
    todoDate, prunedPaths, danglingHandwritten, project, sessionRange,
    touchedCount, indexableCount, candidateCount, diffError
  } = a;

  const contentChanged = created || workingContent !== indexContent;
  const prunedCount = prunedPaths.length;
  const reportCount = danglingHandwritten.length;

  if (contentChanged) {
    staged['features-toc:append'] = {
      primingPath: featuresPath,
      newContent: workingContent,
      changed: true,
      featuresToc: true,
      created,
      addedCount: drifted.length,
      addedFiles: drifted,
      prunedCount,
      prunedFiles: prunedPaths,
      danglingHandwritten,
      todoDate
    };
    log.info('features-toc staged write', {
      project: project.name,
      created,
      addedCount: drifted.length,
      prunedCount,
      reportCount,
      range: sessionRange ? sessionRange.range : null
    });
    return {
      ok: true,
      status: 'done',
      output: {
        featuresPath,
        created,
        addedCount: drifted.length,
        addedFiles: drifted,
        prunedCount,
        prunedFiles: prunedPaths,
        danglingHandwritten,
        todoDate,
        detail: _buildDetail({ created, addedCount: drifted.length, prunedCount, reportCount, danglingHandwritten })
      },
      blockers: []
    };
  }

  // Nothing changed on disk. A dangling hand-written citation still reds this
  // wrap's PR (the contract test), so surface it as a visible, non-blocking
  // finding rather than skipping silently — the whole point of #640.
  if (reportCount > 0) {
    log.info('features-toc reporting dangling hand-written citations (no content change)', {
      project: project.name,
      reportCount
    });
    return {
      ok: true,
      status: 'done',
      output: {
        featuresPath,
        created: false,
        addedCount: 0,
        addedFiles: [],
        prunedCount: 0,
        prunedFiles: [],
        danglingHandwritten,
        detail: _buildDetail({ created: false, addedCount: 0, prunedCount: 0, reportCount, danglingHandwritten })
      },
      blockers: []
    };
  }

  // Existing skip taxonomy — reached only when nothing changed and nothing is
  // reported. Order and wording preserved from the pre-#640 handler.
  if (!sessionRange) {
    return _skipped('no session range resolves (no lastWrapSha and no main/master base branch)');
  }
  if (diffError !== null) {
    return _skipped(`git diff failed: ${diffError}`);
  }
  if (touchedCount === 0) {
    return _skipped(`no files touched in ${sessionRange.range}`);
  }
  if (candidateCount === 0) {
    // Distinguish the two empty-candidate causes rather than reporting the
    // generic filter skip — "every touched file was deleted" is a materially
    // different session from "nothing touched was indexable".
    return _skipped(indexableCount > 0
      ? 'no indexable candidates — every touched file was deleted'
      : 'no indexable candidates after filtering');
  }
  return _skipped('no drift — every touched file already in FEATURES.md');
}

/**
 * Compose the human-facing step detail from the outcome counts. Preserves the
 * pre-#640 append/create wording (tests pin the "N untracked file" and
 * "created (…)" phrasings), then adds a prune clause and a dangling-citation
 * report clause when each applies.
 *
 * @param {object} p
 * @param {boolean} p.created
 * @param {number} p.addedCount
 * @param {number} p.prunedCount
 * @param {number} p.reportCount
 * @param {string[]} p.danglingHandwritten
 * @returns {string}
 */
function _buildDetail({ created, addedCount, prunedCount, reportCount, danglingHandwritten }) {
  const parts = [];
  if (created) {
    parts.push(addedCount > 0
      ? `${FEATURES_FILENAME} created (${addedCount} stub(s) appended)`
      : `${FEATURES_FILENAME} created (seed only — no drift to stub)`);
  } else if (addedCount > 0) {
    parts.push(`${addedCount} untracked file(s) appended to ${FEATURES_FILENAME}`);
  }
  if (prunedCount > 0) {
    parts.push(`pruned ${prunedCount} dead auto-stub(s)`);
  }
  if (reportCount > 0) {
    const preview = danglingHandwritten.slice(0, 3).join(', ');
    const more = danglingHandwritten.length > 3
      ? `, +${danglingHandwritten.length - 3} more`
      : '';
    parts.push(`⚠ ${reportCount} dangling hand-written citation(s) — fix before this wrap's PR can merge: ${preview}${more}`);
  }
  // A content-changed result always yields at least one part (create/prune/
  // append); this guard only backstops an unexpected all-zero call.
  return parts.length > 0 ? parts.join('; ') : `${FEATURES_FILENAME} unchanged`;
}

/**
 * Remove auto-stub entries whose cited path no longer exists on disk, healing
 * the dangling citations this step itself created in an earlier session (#640).
 * Only the literal `- **TBD** — touched in this session: \`path\`` format under a
 * `## TODO (auto-stubbed …)` section is touched — once a stub is described or
 * graduated into curated prose it is no longer ours to delete and is reported
 * (not pruned). A TODO section left with no surviving stub AND no other
 * non-blank content has its heading removed too, along with the blank separator
 * line that preceded it. Sections still holding a live stub or any operator
 * prose are preserved verbatim.
 *
 * @param {string} content - Current FEATURES.md content.
 * @param {string} projectPath - Absolute project root, for the on-disk check.
 * @returns {{content:string, prunedPaths:string[]}}
 */
function _pruneDeadAutoStubs(content, projectPath) {
  if (!content || typeof content !== 'string') return { content, prunedPaths: [] };
  const lines = content.split('\n');
  const out = [];
  const prunedPaths = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!AUTOSTUB_HEADING_RE.test(line)) {
      out.push(line);
      i += 1;
      continue;
    }
    // Gather the section body up to the next markdown heading (any level) or EOF.
    const body = [];
    let j = i + 1;
    while (j < lines.length && !MD_HEADING_RE.test(lines[j])) {
      body.push(lines[j]);
      j += 1;
    }
    const keptBody = [];
    let survivingStubs = 0;
    for (const bodyLine of body) {
      const m = AUTOSTUB_ENTRY_RE.exec(bodyLine);
      if (m) {
        const cited = m[1].split('#')[0];
        if (!_internal.existsSync(path.join(projectPath, cited))) {
          prunedPaths.push(cited);
          continue; // drop the dead stub line
        }
        survivingStubs += 1;
      }
      keptBody.push(bodyLine);
    }
    const hasOtherContent = keptBody.some((l) => l.trim() !== '');
    if (survivingStubs > 0 || hasOtherContent) {
      out.push(line);
      out.push(...keptBody);
    } else if (out.length > 0 && out[out.length - 1] === '') {
      // Whole section died — also swallow the blank separator before its heading.
      out.pop();
    }
    i = j;
  }
  let result = out.join('\n');
  // A dropped trailing section can strip the file's final newline; restore it so
  // pruning never churns the trailing-newline byte on its own.
  if (content.endsWith('\n') && !result.endsWith('\n')) result += '\n';
  return { content: result, prunedPaths };
}

/**
 * Scan content for backticked citation tokens whose committed-repo path no
 * longer exists on disk — the hand-written / already-described citations #640
 * REPORTS rather than prunes. Mirrors the DOC-3K7Q contract test's token shape
 * (backticked, no glob/placeholder, split on `#`, must contain `/`). In place of
 * that test's TC-specific committed-root allowlist — which the generic wrap step
 * cannot hardcode — it accepts a token with ANY file extension (not just the
 * indexable set: a dangling `data/schema.sql` or `docs/x.png` reds the same
 * required check, so it must be reported too) or a `#symbol` anchor, while
 * dropping URLs (`://`), the vendored/build prefixes, and extensionless
 * anchorless tokens so stray prose like `and/or` is not misread as a file.
 *
 * Known residual: a dangling **extensionless, anchorless** committed-root path
 * (e.g. `docs/adr-0001`) reds the contract test but is not reported here — it is
 * indistinguishable from prose without the committed-root allowlist. Rare as a
 * citation; the extension/anchor forms cover the common cases.
 *
 * Returns each dangling token once, in first-seen order.
 *
 * @param {string} content
 * @param {string} projectPath - Absolute project root.
 * @returns {string[]}
 */
function _findDanglingCitations(content, projectPath) {
  const out = [];
  if (!content || typeof content !== 'string') return out;
  const seen = new Set();
  const re = /`([^`\s]+)`/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const token = m[1];
    if (/[*<{]/.test(token)) continue;                 // globs / placeholders — out of contract
    if (token.includes('://')) continue;               // a URL, not a repo path
    const filePath = token.split('#')[0];
    if (!filePath.includes('/')) continue;             // not a repo path
    if (EXCLUDED_PREFIXES.some((p) => filePath.startsWith(p))) continue;
    const hasSymbol = token.includes('#');
    const hasExt = path.extname(filePath) !== '';
    if (!hasSymbol && !hasExt) continue;               // extensionless + anchorless → treat as prose
    if (seen.has(token)) continue;
    if (!_internal.existsSync(path.join(projectPath, filePath))) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

// A plausible git object name — full or abbreviated hex. Validated before a
// recorded `lastWrapSha` is interpolated into a shell command (defensive: the
// value comes from persisted project config, not user input, but a range like
// `<sha>..HEAD` must never carry shell metacharacters).
const SHA_RE = gitRange.SHA_RE;

/**
 * Resolve the git range whose diff represents THIS SESSION's touched files.
 *
 * Prefers `<lastWrapSha>..HEAD` (two-dot): every commit that has landed since the
 * previous wrap, regardless of branch topology. This is what makes drift
 * detection survive TC's own canonical workflow — feature branch → squash-merge
 * to main → wrap while checked out on main — where the pre-#465 `<base>...HEAD`
 * range is empty because HEAD *is* the base, so the step skipped on every wrap and
 * the Feature Index never accrued entries (#465).
 *
 * Falls back to `<baseBranch>...HEAD` (three-dot — the pre-#465 behavior) when no
 * `lastWrapSha` is recorded yet (the project's first wrap) or the recorded SHA is
 * no longer a resolvable commit (history rewritten by a rebase, or a fresh clone
 * that lacks that object). Returns null when neither a session SHA nor a base
 * branch resolves — the caller then self-heals or skips exactly as before.
 *
 * @param {string} cwd
 * @param {string|null} [lastWrapSha] - `projConfig.lastWrapSha`, or null/undefined.
 * @returns {{range:string, kind:'session'|'branch', baseBranch:(string|null)}|null}
 */
function _resolveSessionRange(cwd, lastWrapSha) {
  // Three-dot: this range feeds `git diff`, where it means "since the merge base".
  // `changelog-coverage` asks the same resolver for the two-dot form because it
  // feeds `git log`, where three-dot would mean the symmetric difference instead.
  return gitRange.resolveSessionRange(cwd, lastWrapSha, {
    dots: 'three',
    exec: _internal.execSync
  });
}

/**
 * Whether `ref` resolves to a commit in the local repo.
 *
 * @param {string} cwd
 * @param {string} ref
 * @returns {boolean}
 */
function _isResolvableCommit(cwd, ref) {
  return gitRange.isResolvableCommit(cwd, ref, _internal.execSync);
}

/**
 * Resolve the base branch this PR diverged from. Tries `main` first, then
 * `master`. Returns null if neither resolves as a verifiable ref.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function _resolveBaseBranch(cwd) {
  return gitRange.resolveBaseBranch(cwd, _internal.execSync);
}

/**
 * Run `git diff --name-only <range>` and split into an array of relative paths.
 * `range` is the full revision range resolved by {@link _resolveSessionRange} —
 * `<lastWrapSha>..HEAD` (this session's merged commits) or `<baseBranch>...HEAD`
 * (the current branch's divergence, the first-wrap fallback).
 *
 * Deletions are NOT filtered here. The range says what changed between two
 * commits, which is the wrong question for "does this path still exist" — the
 * wrap commits the working tree with `git add -A`, so a path's fate is decided
 * after this diff is taken. Existence is checked once, on the write path, by
 * {@link _stillExists}.
 *
 * @param {string} cwd
 * @param {string} range - A git revision range (e.g. `abc123..HEAD`, `main...HEAD`).
 * @returns {string[]}
 */
function _diffNameOnly(cwd, range) {
  const stdout = _internal.execSync(`git diff --name-only ${range}`, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_EXEC_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Decide whether a relative path is worth indexing. Applies the
 * extension allowlist, prefix exclusions, basename exclusions, and a
 * leading-dot-segment exclusion (top-level dotfiles + any path with
 * a hidden directory in its chain).
 *
 * @param {string} relativePath
 * @returns {boolean}
 */
function _isIndexableCandidate(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return false;
  for (const prefix of EXCLUDED_PREFIXES) {
    if (relativePath.startsWith(prefix)) return false;
  }
  // Any leading-dot segment in the path (e.g. `foo/.cache/bar.js`)
  // signals hidden content — exclude defensively.
  for (const segment of relativePath.split('/')) {
    if (segment.startsWith('.') && segment.length > 1) return false;
  }
  const ext = path.extname(relativePath).toLowerCase();
  if (!INDEXABLE_EXTENSIONS.has(ext)) return false;
  const base = path.basename(relativePath);
  if (EXCLUDED_BASENAMES.has(base)) return false;
  return true;
}

/**
 * Whether a diffed path still exists in the working tree — i.e. whether it will
 * survive into the commit this wrap is about to make.
 *
 * This is the guard against dangling citations. `FEATURES.md`'s citation
 * contract asserts that every cited path exists on disk; asking exactly that
 * question here means a stub can never contradict it. A range diff cannot
 * answer it — the wrap commits the working tree with `git add -A` after the
 * diff is taken, so a path reported as "added" may be deleted on disk and
 * about to be committed as such.
 *
 * @param {string} projectPath - Absolute project root.
 * @param {string} relativePath - Repo-relative path from the diff.
 * @returns {boolean}
 */
function _stillExists(projectPath, relativePath) {
  return _internal.existsSync(path.join(projectPath, relativePath));
}

/**
 * Tokenize the existing FEATURES.md content and return a Set of every
 * path-like token already mentioned. The match is intentionally
 * permissive — backticks, free text, link targets, comments all
 * register. Bias is toward over-skipping (a missed stub is
 * recoverable; a false-positive duplicate would pollute the index).
 *
 * @param {string} indexContent
 * @returns {Set<string>}
 */
function _extractIndexedPaths(indexContent) {
  const out = new Set();
  if (!indexContent || typeof indexContent !== 'string') return out;
  // Reset lastIndex so consecutive scans on the same regex instance
  // (legitimate inside the same `_extractIndexedPaths` call but also
  // across calls) start cleanly. PATH_TOKEN_RE is module-scope so this
  // matters.
  PATH_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = PATH_TOKEN_RE.exec(indexContent)) !== null) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Build the new FEATURES.md content by appending a fresh
 * `## TODO (auto-stubbed YYYY-MM-DD)` section listing every drifted
 * file. Idempotence note: the caller already filtered out any path
 * already in the index, so this function can append unconditionally.
 *
 * @param {string} indexContent
 * @param {string[]} driftedFiles
 * @param {string} todoDate - YYYY-MM-DD
 * @returns {string}
 */
function _appendTodoSection(indexContent, driftedFiles, todoDate) {
  const trimmed = indexContent.replace(/\s+$/, '');
  const heading = `## TODO (auto-stubbed ${todoDate})`;
  const entries = driftedFiles.map(
    (f) => `- **TBD** — touched in this session: \`${f}\`. <!-- describe -->`
  );
  return `${trimmed}\n\n${heading}\n\n${entries.join('\n')}\n`;
}

function _skipped(reason) {
  // Canonical skip signal is `status: 'skipped'` (#204); `output.skipped` is
  // no longer set — the drawer derives skip detail from status + reason/detail.
  return {
    ok: true,
    status: 'skipped',
    output: { reason, detail: reason },
    blockers: []
  };
}

// `_todayIsoLocal` previously lived inline here as the post-#215
// parity application of #216's UTC-date fix; extracted to
// `lib/wrap-steps/_date.js` so both call sites share one source of
// truth. Re-exporting under the prior public name preserves the
// wiring-pin test without forcing the test to learn about the new
// util module.
const _todayIsoLocal = todayIsoLocal;

const _internal = {
  readFileSync: fs.readFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  execSync,
  todayIso: _todayIsoLocal
};

module.exports = {
  run,
  _resolveSessionRange,
  _isResolvableCommit,
  _resolveBaseBranch,
  _diffNameOnly,
  _isIndexableCandidate,
  _stillExists,
  _extractIndexedPaths,
  _appendTodoSection,
  _pruneDeadAutoStubs,
  _findDanglingCitations,
  _finalize,
  _buildDetail,
  _todayIsoLocal,
  _internal,
  FEATURES_FILENAME,
  INDEXABLE_EXTENSIONS,
  EXCLUDED_BASENAMES,
  EXCLUDED_PREFIXES
};
