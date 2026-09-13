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
 *   - each file removes and adds the same lines apart from the ref, so no step is
 *     added, dropped or re-indented;
 *   - exactly one new ref, and it is not one of the old refs.
 *
 * Exit: 0 bump-only · 1 not bump-only (reason on stderr) · 2 no diff on stdin.
 * Reads raw text only; never checks out or runs the PR's code.
 */

const USES_RE = /^([ \t]*(?:-[ \t]+)?)uses:[ \t]+([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)@([A-Za-z0-9._\/-]+)(?:[ \t]+#[ \t]*v?[0-9][0-9A-Za-z.+-]*)?[ \t]*$/;
const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * Split a unified diff (as `gh pr diff` / `git diff` print it) into per-file
 * records.
 * @param {string} text - The diff text.
 * @returns {Array<{a: string, b: string, meta: string[], removed: string[], added: string[]}>}
 */
function parseDiff(text) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of text.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      cur = { a: header[1], b: header[2], meta: [], removed: [], added: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) {
      if (!line.startsWith('index ') && !line.startsWith('--- ') && !line.startsWith('+++ ')) {
        cur.meta.push(line);
      }
      continue;
    }
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

/**
 * Check that a diff is a single-action `uses:` ref bump and nothing more.
 * @param {string} text - The unified diff.
 * @returns {{ ok: boolean, reason: string|null, action: string|null, from: string[], to: string|null }}
 */
function checkBumpDiff(text) {
  const fail = (reason) => ({ ok: false, reason, action: null, from: [], to: null });
  const files = parseDiff(text || '');
  if (files.length === 0) return fail('the diff changes no files');

  const actions = new Set();
  const oldRefs = new Set();
  const newRefs = new Set();
  for (const f of files) {
    if (f.a !== f.b) return fail(`${f.a} → ${f.b}: a rename is not a bump`);
    if (!WORKFLOW_RE.test(f.b)) return fail(`${f.b} is not a workflow file under .github/workflows/`);
    const meta = f.meta.filter((m) => m.trim() !== '');
    if (meta.length) return fail(`${f.b}: ${meta[0]} (only in-place text edits are a bump)`);
    if (f.added.length === 0 && f.removed.length === 0) return fail(`${f.b}: no changed lines`);

    const shape = (lines, refs) => {
      const out = [];
      for (const l of lines) {
        const m = USES_RE.exec(l);
        if (!m) return { bad: l };
        actions.add(m[2]);
        refs.add(m[3]);
        out.push(`${m[1]}uses: ${m[2]}`);
      }
      return { out: out.sort() };
    };
    const rem = shape(f.removed, oldRefs);
    if (rem.bad !== undefined) return fail(`${f.b}: removed line is not a uses: ref: ${JSON.stringify(rem.bad)}`);
    const add = shape(f.added, newRefs);
    if (add.bad !== undefined) return fail(`${f.b}: added line is not a uses: ref: ${JSON.stringify(add.bad)}`);
    if (rem.out.join('\n') !== add.out.join('\n')) {
      return fail(`${f.b}: removed and added uses: lines differ beyond the ref (a step was added, dropped or re-indented)`);
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
