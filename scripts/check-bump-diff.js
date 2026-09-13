#!/usr/bin/env node
'use strict';

/**
 * Decide, mechanically, whether a pull request diff is a GitHub Actions version
 * bump and nothing else (#1361).
 *
 *   gh pr diff <N> | node scripts/check-bump-diff.js
 *
 * ADR 0014 exempts a Dependabot PR from the `.github/workflows/` rejection ONLY
 * when its diff changes nothing but `uses:` refs. The operator ruled that this
 * condition is checked by a command, never by eye: a one-line bump is exactly
 * the shape a reader waves through, so a smuggled `run:` step or a widened
 * `permissions:` beside it is the loophole a by-eye check leaves open.
 *
 * Passes only when ALL hold:
 *   - at least one file changed, and every file is a `.github/workflows/*.yml|yaml`
 *     modified in place (no rename, add, delete, mode change or binary);
 *   - every added or removed line is a `uses: owner/repo[/path]@ref` line, with at
 *     most a trailing version comment (`# v4.2.0`, as SHA-pinned refs carry);
 *   - every such line names the SAME action;
 *   - each removed `uses:` line is replaced IN PLACE by one added line differing
 *     only in its ref, so no step is added, dropped, moved or re-indented;
 *   - every diff line is one the parser recognises (a quoted path, stray header or
 *     any unknown shape fails closed rather than being skipped);
 *   - exactly one new ref, and it is not one of the old refs.
 *
 * Exit: 0 bump-only · 1 not bump-only (reason on stderr) · 2 no diff on stdin.
 * Reads raw text only; never checks out or runs the PR's code.
 */

const USES_RE = /^([ \t]*(?:-[ \t]+)?)uses:[ \t]+([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)@([A-Za-z0-9._\/-]+)(?:[ \t]+#[ \t]*v?[0-9][0-9A-Za-z.+-]*)?[ \t]*$/;
const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * Split a unified diff (as `gh pr diff` / `git diff` print it) into per-file
 * records, grouping each run of changed lines as git prints it: a block of
 * removed lines followed by its block of added lines. Strict by design — any
 * line the parser does not recognise is returned as `unparsed`, so a diff shape
 * this tool was not written for fails closed instead of being skipped.
 * @param {string} text - The diff text.
 * @returns {{ files: Array<{a: string, b: string, meta: string[], groups: Array<{removed: string[], added: string[]}>}>, unparsed: string|null }}
 */
function parseDiff(text) {
  const files = [];
  let cur = null;
  let inHunk = false;
  let group = null;
  const flush = () => {
    if (cur && group && (group.removed.length || group.added.length)) cur.groups.push(group);
    group = { removed: [], added: [] };
  };
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!header) return { files, unparsed: line };
      cur = { a: header[1], b: header[2], meta: [], groups: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) {
      if (line.trim() !== '') return { files, unparsed: line };
      continue;
    }
    if (line.startsWith('@@ ')) { flush(); inHunk = true; continue; }
    if (!inHunk) {
      if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
      cur.meta.push(line);
      continue;
    }
    if (line.startsWith('-')) {
      if (group.added.length) flush();
      group.removed.push(line.slice(1));
    } else if (line.startsWith('+')) {
      group.added.push(line.slice(1));
    } else if (line.startsWith(' ') || line === '') {
      flush();
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — describes the line before it.
    } else {
      return { files, unparsed: line };
    }
  }
  flush();
  return { files, unparsed: null };
}

/**
 * Check that a diff is a single-action `uses:` ref bump and nothing more.
 * @param {string} text - The unified diff.
 * @returns {{ ok: boolean, reason: string|null, action: string|null, from: string[], to: string|null }}
 */
function checkBumpDiff(text) {
  const fail = (reason) => ({ ok: false, reason, action: null, from: [], to: null });
  const { files, unparsed } = parseDiff(text || '');
  if (unparsed !== null) return fail(`unrecognised diff line: ${JSON.stringify(unparsed)}`);
  if (files.length === 0) return fail('the diff changes no files');

  const actions = new Set();
  const oldRefs = new Set();
  const newRefs = new Set();
  /**
   * Parse one changed line as a `uses:` ref, recording its action and ref.
   * @param {string} l
   * @param {Set<string>} refs
   * @returns {string|null} The line with its ref removed, or null if not a uses: line.
   */
  const shapeOf = (l, refs) => {
    const m = USES_RE.exec(l);
    if (!m) return null;
    actions.add(m[2]);
    refs.add(m[3]);
    return `${m[1]}uses: ${m[2]}`;
  };

  for (const f of files) {
    if (f.a !== f.b) return fail(`${f.a} → ${f.b}: a rename is not a bump`);
    if (!WORKFLOW_RE.test(f.b)) return fail(`${f.b} is not a workflow file under .github/workflows/`);
    const meta = f.meta.filter((m) => m.trim() !== '');
    if (meta.length) return fail(`${f.b}: ${meta[0]} (only in-place text edits are a bump)`);
    if (f.groups.length === 0) return fail(`${f.b}: no changed lines`);

    for (const g of f.groups) {
      // A bump rewrites each uses: line in place, so every removed line is
      // replaced at the same position by exactly one added line. A line removed
      // in one place and added in another is a moved step, not a bump.
      if (g.removed.length !== g.added.length) {
        return fail(`${f.b}: ${g.removed.length} removed vs ${g.added.length} added line(s) at one position (a step was added, dropped or moved)`);
      }
      for (let i = 0; i < g.removed.length; i++) {
        const before = shapeOf(g.removed[i], oldRefs);
        if (before === null) return fail(`${f.b}: removed line is not a uses: ref: ${JSON.stringify(g.removed[i])}`);
        const after = shapeOf(g.added[i], newRefs);
        if (after === null) return fail(`${f.b}: added line is not a uses: ref: ${JSON.stringify(g.added[i])}`);
        if (before !== after) return fail(`${f.b}: ${JSON.stringify(g.removed[i])} became ${JSON.stringify(g.added[i])} (more than the ref changed)`);
      }
    }
  }

  if (actions.size !== 1) return fail(`the diff names ${actions.size} actions (${[...actions].join(', ')}); a bump names one`);
  if (newRefs.size !== 1) return fail(`the diff moves to ${newRefs.size} refs (${[...newRefs].join(', ')}); a bump moves to one`);
  const to = [...newRefs][0];
  if (oldRefs.has(to)) return fail(`the new ref ${to} is also an old ref; the diff is not a pure bump`);
  return { ok: true, reason: null, action: [...actions][0], from: [...oldRefs], to };
}

/**
 * CLI entry: read the diff from stdin, print the verdict, set the exit code.
 * @returns {void}
 */
function main() {
  if (process.stdin.isTTY) {
    process.stderr.write('Usage: gh pr diff <N> | node scripts/check-bump-diff.js\n');
    process.exit(2);
  }
  const text = require('node:fs').readFileSync(0, 'utf8');
  if (!text.trim()) {
    process.stderr.write('ERROR: no diff on stdin.\n');
    process.exit(2);
  }
  const r = checkBumpDiff(text);
  if (r.ok) {
    process.stdout.write(`BUMP-ONLY: ${r.action} ${r.from.join(', ')} → ${r.to}\n`);
    return;
  }
  process.stderr.write(`NOT BUMP-ONLY: ${r.reason}\n`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { checkBumpDiff, parseDiff };
