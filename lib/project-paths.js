'use strict';

/**
 * Containment rules for operator-supplied paths that are interpreted relative
 * to a project root.
 *
 * A settings field that names a file the server later reads or writes is an
 * arbitrary-file primitive unless something constrains it. The constraint has
 * to hold at every site independently — the API validator can't be the only
 * guard, because a hand-edited `.tangleclaw/project.json` never passes through
 * it — so the rule lives here once rather than being re-derived per caller.
 *
 * Deliberately a leaf module: no requires, so any consumer (including
 * `lib/wrap-steps/*`, which sits inside the
 * `projects → sessions → wrap-pipeline → wrap-steps` require cycle) can pull it
 * in at module top without risking a partially-initialized import.
 *
 * @module lib/project-paths
 */

const path = require('node:path');

/**
 * Resolve a project-relative path, refusing anything that escapes the project
 * or names the root itself.
 *
 * Resolution-based rather than a lexical `..` scan, and every caller must use
 * the same predicate: a lexical check disagrees with this one in both
 * directions — it rejects `a/../b.json` (which resolves safely inside) and
 * accepts `.` (which resolves to the root, a directory nothing can write as a
 * file). A validator that accepts what the write site later refuses produces a
 * setting that saves cleanly and then silently does nothing.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string} relativePath - Operator-supplied path, relative to the root
 * @returns {{ok:true, path:string}|{ok:false, reason:string}} `path` is absolute.
 *   `reason` is a sentence FRAGMENT ("resolves outside the project root") so
 *   callers can compose it after the field name they are validating — the
 *   operator reads "versionFilePath resolves outside the project root", not
 *   "versionFilePath path resolves outside…".
 */
function resolveWithinProject(projectRoot, relativePath) {
  const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
  if (raw === '') {
    return { ok: false, reason: 'is empty' };
  }
  if (path.isAbsolute(raw)) {
    return { ok: false, reason: 'must be relative to the project root, not absolute' };
  }

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, raw);
  const rel = path.relative(root, resolved);

  if (rel === '') {
    return { ok: false, reason: 'resolves to the project root itself, not a file inside it' };
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'resolves outside the project root' };
  }
  return { ok: true, path: resolved };
}

module.exports = { resolveWithinProject };
