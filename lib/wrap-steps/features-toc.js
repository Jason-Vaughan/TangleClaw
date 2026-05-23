'use strict';

/**
 * `features-toc` wrap step (#207, Chunk 3) — auto-appends stub entries
 * to `<projectPath>/FEATURES.md` for files touched in the session's
 * branch that are not already referenced anywhere in the index.
 *
 * **Contract (matches ADR 0002 step-kind philosophy — never blocks):**
 *
 *   - Skip when `projConfig.featureIndexEnabled !== true`.
 *   - Skip when `FEATURES.md` is missing at the project root (Chunk 1's
 *     toggle-on path seeds the file; if it's absent the operator either
 *     never enabled the toggle or deleted the file deliberately).
 *   - Skip when the local working tree is not a git repo, when no base
 *     branch (`main`, then `master`) resolves, or when the
 *     `git diff --name-only <base>...HEAD` range is empty.
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
const { createLogger } = require('../logger');
const store = require('../store');

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

// Regex that pulls path-like tokens out of arbitrary markdown. Anchor
// is intentionally loose — matches inside backticks, free text, link
// targets, comments. The trailing `(?:\b|:)` lets `:42` line refs
// register the path without the colon being included in the
// captured group.
const PATH_TOKEN_RE = /([A-Za-z0-9_./-]+\.(?:js|jsx|ts|tsx|json|md|html|css|yaml|yml|sh))(?:\b|:)/gi;

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
  if (!_internal.existsSync(featuresPath)) {
    return _skipped(`${FEATURES_FILENAME} not found at project root`);
  }

  let indexContent;
  try {
    indexContent = _internal.readFileSync(featuresPath, 'utf8');
  } catch (err) {
    return _skipped(`${FEATURES_FILENAME} unreadable: ${err.message}`);
  }

  const baseBranch = _resolveBaseBranch(project.path);
  if (!baseBranch) {
    return _skipped('no base branch (main/master) resolves locally');
  }

  let touchedFiles;
  try {
    touchedFiles = _diffNameOnly(project.path, baseBranch);
  } catch (err) {
    return _skipped(`git diff failed: ${err.message}`);
  }
  if (touchedFiles.length === 0) {
    return _skipped(`no files touched against ${baseBranch}`);
  }

  const candidates = touchedFiles.filter(_isIndexableCandidate);
  if (candidates.length === 0) {
    return _skipped('no indexable candidates after filtering');
  }

  const indexedSet = _extractIndexedPaths(indexContent);
  const drifted = candidates.filter((f) => !indexedSet.has(f));
  if (drifted.length === 0) {
    return _skipped('no drift — every touched file already in FEATURES.md');
  }

  const todoDate = _internal.todayIso();
  const newContent = _appendTodoSection(indexContent, drifted, todoDate);

  staged['features-toc:append'] = {
    primingPath: featuresPath,
    newContent,
    changed: true,
    addedCount: drifted.length,
    addedFiles: drifted,
    todoDate
  };

  log.info('features-toc staged stub append', {
    project: project.name,
    baseBranch,
    addedCount: drifted.length
  });

  return {
    ok: true,
    status: 'done',
    output: {
      featuresPath,
      addedCount: drifted.length,
      addedFiles: drifted,
      todoDate,
      detail: `${drifted.length} untracked file(s) appended to ${FEATURES_FILENAME}`
    },
    blockers: []
  };
}

/**
 * Resolve the base branch this PR diverged from. Tries `main` first,
 * then `master`. Returns null if neither resolves as a verifiable ref.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function _resolveBaseBranch(cwd) {
  for (const candidate of ['main', 'master']) {
    try {
      _internal.execSync(`git rev-parse --verify --quiet ${candidate}`, {
        cwd,
        timeout: GIT_EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return candidate;
    } catch {
      // Ref does not exist locally — try the next candidate.
    }
  }
  return null;
}

/**
 * Run `git diff --name-only <baseBranch>...HEAD` and split into an
 * array of relative paths. Three-dot syntax: returns only the files
 * the current branch added/changed since branching from `baseBranch`,
 * ignoring mainline changes that landed after the branch point.
 *
 * @param {string} cwd
 * @param {string} baseBranch
 * @returns {string[]}
 */
function _diffNameOnly(cwd, baseBranch) {
  const stdout = _internal.execSync(`git diff --name-only ${baseBranch}...HEAD`, {
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
  return {
    ok: true,
    status: 'skipped',
    output: { skipped: true, reason, detail: reason },
    blockers: []
  };
}

const _internal = {
  readFileSync: fs.readFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  execSync,
  todayIso: () => new Date().toISOString().slice(0, 10)
};

module.exports = {
  run,
  _resolveBaseBranch,
  _diffNameOnly,
  _isIndexableCandidate,
  _extractIndexedPaths,
  _appendTodoSection,
  _internal,
  INDEXABLE_EXTENSIONS,
  EXCLUDED_BASENAMES,
  EXCLUDED_PREFIXES
};
