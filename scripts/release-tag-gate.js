#!/usr/bin/env node
'use strict';

/**
 * Decide whether a release tag on origin names exactly the commit being
 * released (#1551).
 *
 *   git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}" \
 *     | node scripts/release-tag-gate.js --tag "$TAG" --expect "$GITHUB_SHA" [--allow-absent]
 *
 * Pass BOTH patterns. `ls-remote` filters by pattern, so with only the first
 * an annotated tag's peeled `^{}` line is omitted and the gate sees the tag
 * object's SHA. That fails closed, as a mismatch, but it fails every
 * annotated release.
 *
 * The newest tag on origin is the update path for every install
 * (docs/release-process.md), so a tag that names any commit other than the
 * one this run tested would deliver code no gate has seen. Existence is not
 * enough: the tag has to DEREFERENCE to the expected commit.
 *
 * `ls-remote` prints an annotated tag twice, `refs/tags/T` (the tag object)
 * and `refs/tags/T^{}` (the commit it points at), and a lightweight tag once,
 * as `refs/tags/T` naming the commit directly. So the commit is the `^{}` line
 * when there is one, else the plain line.
 *
 * Fails closed: a line that is not `<40-hex>\t<ref>`, a repeated ref, or a
 * `^{}` line with no plain line is an error and never reads as "absent". Lines
 * for other refs are ignored, because `ls-remote` matches its pattern against
 * the tail of a ref name and can legitimately print them.
 *
 * Exit: 0 the tag dereferences to --expect, or it is absent and --allow-absent
 * was given · 1 refused (mismatch, or absent without --allow-absent) · 2 usage
 * error or output this tool cannot parse. A mismatch has no warn-only mode: a
 * tag that is already released from another commit is a refusal too, because
 * "already done" would otherwise bless a version reused on a different commit.
 */

const SHA_RE = /^[0-9a-f]{40}$/;
const LINE_RE = /^([0-9a-f]{40})\t(refs\/tags\/\S+)$/;
const TAG_RE = /^v[0-9A-Za-z.+-]+$/;

/**
 * Find the commit a tag dereferences to in `git ls-remote --tags` output.
 * @param {string} output - Raw `ls-remote` output.
 * @param {string} tag - Tag name, e.g. `v5.26.0`.
 * @returns {{ state: 'absent' } | { state: 'present', commit: string }}
 * @throws {Error} When the output is malformed or ambiguous for this tag.
 */
function resolveTagCommit(output, tag) {
  if (typeof output !== 'string') throw new Error('ls-remote output must be a string');
  if (!TAG_RE.test(tag)) throw new Error(`invalid tag name: ${JSON.stringify(tag)}`);
  const plainRef = `refs/tags/${tag}`;
  const derefRef = `${plainRef}^{}`;
  let plain = null;
  let deref = null;
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const m = LINE_RE.exec(line);
    if (!m) throw new Error(`unparseable ls-remote line: ${JSON.stringify(line)}`);
    const [, sha, ref] = m;
    if (ref === plainRef) {
      if (plain !== null) throw new Error(`${plainRef} listed more than once`);
      plain = sha;
    } else if (ref === derefRef) {
      if (deref !== null) throw new Error(`${derefRef} listed more than once`);
      deref = sha;
    }
  }
  if (plain === null && deref === null) return { state: 'absent' };
  if (plain === null) throw new Error(`${derefRef} listed without ${plainRef}`);
  return { state: 'present', commit: deref !== null ? deref : plain };
}

/**
 * Judge a tag against the commit being released.
 * @param {object} opts
 * @param {string} opts.output - Raw `ls-remote` output.
 * @param {string} opts.tag - Tag name.
 * @param {string} opts.expected - The 40-hex commit this run tested and releases.
 * @param {boolean} [opts.allowAbsent=false] - Whether an absent tag passes.
 * @returns {{ ok: boolean, state: 'absent'|'match'|'mismatch', commit?: string, message: string }}
 * @throws {Error} When `expected` is not a full SHA or the output is malformed.
 */
function checkTag({ output, tag, expected, allowAbsent = false }) {
  if (!SHA_RE.test(expected || '')) throw new Error(`expected commit is not a 40-hex SHA: ${JSON.stringify(expected)}`);
  const resolved = resolveTagCommit(output, tag);
  if (resolved.state === 'absent') {
    return allowAbsent
      ? { ok: true, state: 'absent', message: `${tag} is not on origin` }
      : { ok: false, state: 'absent', message: `${tag} is not on origin, so installs cannot see this release` };
  }
  if (resolved.commit === expected) {
    return { ok: true, state: 'match', commit: resolved.commit, message: `${tag} dereferences to ${expected}` };
  }
  return {
    ok: false,
    state: 'mismatch',
    commit: resolved.commit,
    message: `${tag} dereferences to ${resolved.commit}, not to ${expected}, the commit this run tested`,
  };
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{ tag: string, expected: string, allowAbsent: boolean }}
 * @throws {Error} On an unknown or incomplete argument.
 */
function parseArgs(argv) {
  const args = { tag: '', expected: '', allowAbsent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag' || a === '--expect') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === '--tag') args.tag = v; else args.expected = v;
    } else if (a === '--allow-absent') args.allowAbsent = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.tag || !args.expected) throw new Error('--tag and --expect are required');
  return args;
}

/**
 * Run the CLI against stdin text.
 * @param {string[]} argv - Arguments after the script name.
 * @param {string} input - `ls-remote` output.
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function main(argv, input) {
  let args;
  let verdict;
  try {
    args = parseArgs(argv);
    verdict = checkTag({ output: input, tag: args.tag, expected: args.expected, allowAbsent: args.allowAbsent });
  } catch (err) {
    return { code: 2, stdout: '', stderr: `::error::release tag gate: ${err.message}\n` };
  }
  if (verdict.ok) return { code: 0, stdout: `${verdict.message}\n`, stderr: '' };
  return { code: 1, stdout: '', stderr: `::error::${verdict.message}. Refusing to release.\n` };
}

if (require.main === module) {
  const input = require('node:fs').readFileSync(0, 'utf8');
  const { code, stdout, stderr } = main(process.argv.slice(2), input);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}

module.exports = { resolveTagCommit, checkTag, parseArgs, main };
