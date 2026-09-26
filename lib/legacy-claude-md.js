'use strict';

// A plugin-governed CLAUDE.md can carry TangleClaw's operational guide twice:
// the copy an earlier whole-file write left above the Prawduct anchor, and the
// managed block TangleClaw splices below it once the project is governed
// (#1911). This module finds the legacy sections that the managed block now
// duplicates and, only when an operator explicitly approves a previewed plan,
// removes them.
//
// A matching heading marks a candidate; it does not prove the operator never
// edited the section's body. So nothing here deletes on detection: analysis is
// pure, and the one writer requires the digest of the preview the operator
// saw, refuses if the file moved since, and replaces the file atomically. The
// rules tiers are never candidates — on a governed project they are the
// operator's hand-kept copy.
//
// No require of lib/engines.js: engines calls into this module, so the marker
// strings and the generated header are passed in by the caller.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { shellWord } = require('./shell-word');

const ANCHOR_TOKEN = 'PRAWDUCT:ANCHOR';
// Absolute, because the command is printed to agents working inside the
// governed project, which has no scripts/ directory of its own.
const REPAIR_SCRIPT = path.join(__dirname, '..', 'scripts', 'repair-governed-claude-md.js');
const NEUTRAL_HEADER = '# CLAUDE.md';

/**
 * The operator's preview command for a project, or its apply command when a
 * digest is given. Every surface that tells someone how to repair prints this.
 * @param {string} projectPath - Absolute project root.
 * @param {string} [digest] - The preview's digest, for the apply form.
 * @returns {string}
 */
function repairCommand(projectPath, digest) {
  // Every word single-quoted: a project path may legally hold `$`, a
  // backtick, a quote or a backslash, and double quotes stop none of them.
  const argv = ['node', REPAIR_SCRIPT, projectPath, ...(digest ? ['--apply', digest] : [])];
  return argv.map(shellWord).join(' ');
}

// The file writes the repair makes, replaceable in tests so a short, zero or
// failing write can be injected. Production always uses node:fs.
const _io = { writeSync: (fd, buf, offset, length) => fs.writeSync(fd, buf, offset, length) };

/**
 * Replace the repair's write primitive for a test.
 * @param {{writeSync?: Function}} overrides
 * @returns {Function} Restores the real primitive.
 */
function _setIoForTest(overrides) {
  const saved = { ..._io };
  Object.assign(_io, overrides);
  return () => Object.assign(_io, saved);
}

/**
 * Write every byte of a buffer, continuing after short writes. Throws on a
 * write that makes no progress or fails, so the caller can refuse.
 * @param {number} fd
 * @param {Buffer} buf
 * @returns {void}
 */
function _writeAll(fd, buf) {
  let offset = 0;
  while (offset < buf.length) {
    const n = _io.writeSync(fd, buf, offset, buf.length - offset);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`the write stopped after ${offset} of ${buf.length} bytes`);
    }
    offset += n;
  }
}

/**
 * Why a carrier path cannot be repaired in place, or null when it is a regular
 * file. A symlink is refused rather than followed or replaced: renaming over it
 * would swap the link for a file, and following it would write a target this
 * tool was never bound to.
 * @param {string} filePath
 * @returns {string|null}
 */
function _carrierRefusal(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    return `could not stat ${filePath}: ${err.message}`;
  }
  if (st.isSymbolicLink()) return `${filePath} is a symlink — repair refuses to follow or replace it`;
  if (!st.isFile()) return `${filePath} is not a regular file`;
  return null;
}

/**
 * sha256 of a string, hex.
 * @param {string} text
 * @returns {string}
 */
function _sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A line without the `\r` a CRLF file leaves on it, for comparisons only.
 * @param {string} line
 * @returns {string}
 */
function _bare(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Mark which lines sit inside fenced code blocks. The guides' code samples
 * hold shell comments that start with `# `, which are not headings.
 * @param {string[]} lines
 * @returns {{inFence: boolean[], unterminated: boolean}}
 */
function _fenceMap(lines) {
  const inFence = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const isFence = /^\s*(```|~~~)/.test(lines[i]);
    if (isFence) {
      inFence[i] = true;
      open = !open;
      continue;
    }
    inFence[i] = open;
  }
  return { inFence, unterminated: open };
}

/**
 * Indexes of top-level (`#` or `##`) headings outside fences.
 * @param {string[]} lines
 * @param {boolean[]} inFence
 * @returns {number[]}
 */
function _topHeadings(lines, inFence) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!inFence[i] && /^#{1,2} /.test(lines[i])) out.push(i);
  }
  return out;
}

/**
 * The `##` sections of a text, keyed by heading line, each running to the
 * next top-level heading or the end.
 * @param {string[]} lines
 * @returns {{sections: Map<string, string>, unterminated: boolean}}
 */
function _sectionsOf(lines) {
  const { inFence, unterminated } = _fenceMap(lines);
  const heads = _topHeadings(lines, inFence);
  const sections = new Map();
  heads.forEach((start, k) => {
    const heading = _bare(lines[start]);
    if (!heading.startsWith('## ')) return;
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    sections.set(heading, lines.slice(start, end).map(_bare).join('\n').trimEnd());
  });
  return { sections, unterminated };
}

/**
 * Count non-overlapping occurrences of a substring.
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
function _count(text, needle) {
  let n = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n++;
  return n;
}

/**
 * Analyze a governed carrier for legacy TangleClaw sections that its managed
 * block duplicates. Pure: no I/O, no mutation.
 *
 * Not eligible (nothing to do, not an error): the file was not written by
 * TangleClaw (no generated header in its first three lines), has no Prawduct
 * anchor, or has no managed block yet. Refused (ambiguous, nothing may be
 * removed): more than one anchor, malformed markers, the anchor inside or after
 * the block, an unterminated fence above the anchor, or a candidate heading
 * that occurs more than once above it.
 *
 * @param {string} text - The carrier's full contents.
 * @param {{markers: {begin: string, end: string}, headerMark: string, generatedHeader: string}} ctx
 *   `markers` are the managed-block marker lines, `headerMark` the text that
 *   identifies a TangleClaw-written file, `generatedHeader` the exact header
 *   line the whole-file generator wrote.
 * @returns {{eligible: boolean, reason: (string|null), refused: (string|null),
 *   header: {line: string, replaceable: boolean}|null,
 *   candidates: Array<{kind: 'bullet'|'section', heading: (string|null), startLine: number,
 *     endLine: number, bytes: number, matchesManagedCopy: boolean}>,
 *   fileSha256: string, digest: (string|null)}}
 *   Line numbers are 1-based and `endLine` is inclusive.
 */
function analyzeLegacyCarrier(text, ctx) {
  const fileSha256 = _sha256(text);
  const result = (fields) => ({
    eligible: false, reason: null, refused: null, header: null, candidates: [], fileSha256, digest: null, ...fields
  });
  const lines = text.split('\n');

  if (!lines.slice(0, 3).some((l) => l.includes(ctx.headerMark))) {
    return result({ reason: 'not written by TangleClaw (no generated header in the first three lines)' });
  }
  const anchors = _count(text, ANCHOR_TOKEN);
  if (anchors === 0) return result({ reason: `no ${ANCHOR_TOKEN} — not a plugin-governed layout` });
  if (anchors > 1) return result({ refused: `${anchors} ${ANCHOR_TOKEN} lines — cannot tell where the legacy region ends` });

  const begins = _count(text, ctx.markers.begin);
  const ends = _count(text, ctx.markers.end);
  if (begins === 0 && ends === 0) {
    return result({ reason: 'no managed block yet — nothing is duplicated' });
  }
  const beginAt = text.indexOf(ctx.markers.begin);
  if (begins !== 1 || ends !== 1 || text.indexOf(ctx.markers.end) < beginAt) {
    return result({ refused: `malformed managed-block markers (${begins} BEGIN, ${ends} END)` });
  }
  if (text.indexOf(ANCHOR_TOKEN) > beginAt) {
    return result({ refused: `${ANCHOR_TOKEN} sits inside or after the managed block` });
  }

  const anchorLine = lines.findIndex((l) => l.includes(ANCHOR_TOKEN));
  const legacy = lines.slice(0, anchorLine);
  const { inFence, unterminated } = _fenceMap(legacy);
  if (unterminated) return result({ refused: 'an unterminated code fence above the anchor — section bounds are ambiguous' });

  const blockText = text.slice(beginAt + ctx.markers.begin.length, text.indexOf(ctx.markers.end));
  const blockLines = blockText.split('\n');
  const block = _sectionsOf(blockLines);
  if (block.unterminated) return result({ refused: 'an unterminated code fence inside the managed block' });
  const blockLineSet = new Set(blockLines.map(_bare));

  const heads = _topHeadings(legacy, inFence);
  const candidates = [];
  const seen = new Map();
  for (const i of heads) {
    const h = _bare(legacy[i]);
    seen.set(h, (seen.get(h) || 0) + 1);
  }
  for (let k = 0; k < heads.length; k++) {
    const start = heads[k];
    const heading = _bare(legacy[start]);
    if (start === 0 || !heading.startsWith('## ') || !block.sections.has(heading)) continue;
    if (seen.get(heading) > 1) {
      return result({ refused: `"${heading}" occurs ${seen.get(heading)} times above the anchor — section bounds are ambiguous` });
    }
    const end = k + 1 < heads.length ? heads[k + 1] : anchorLine;
    const body = legacy.slice(start, end);
    candidates.push({
      kind: 'section', heading, startLine: start + 1, endLine: end,
      bytes: Buffer.byteLength(body.join('\n') + '\n', 'utf8'),
      matchesManagedCopy: body.map(_bare).join('\n').trimEnd() === block.sections.get(heading)
    });
  }

  // Bullets: only in the preamble the generator wrote between its header and
  // its first heading, and only a line the managed block carries verbatim.
  const firstHeading = heads.find((i) => i > 0);
  const preambleEnd = firstHeading === undefined ? anchorLine : firstHeading;
  for (let i = 1; i < preambleEnd; i++) {
    const line = _bare(legacy[i]);
    if (!line.startsWith('- ') || !blockLineSet.has(line)) continue;
    const end = i + 1 < preambleEnd && _bare(legacy[i + 1]) === '' ? i + 2 : i + 1;
    candidates.push({
      kind: 'bullet', heading: null, startLine: i + 1, endLine: end,
      bytes: Buffer.byteLength(legacy.slice(i, end).join('\n') + '\n', 'utf8'), matchesManagedCopy: true
    });
  }
  candidates.sort((a, b) => a.startLine - b.startLine);

  const header = { line: _bare(lines[0]), replaceable: _bare(lines[0]) === ctx.generatedHeader };
  const plan = { fileSha256, header: header.replaceable, remove: candidates.map((c) => [c.kind, c.startLine, c.endLine, c.heading]) };
  return result({ eligible: true, header, candidates, digest: _sha256(JSON.stringify(plan)) });
}

/**
 * Whether an analysis has anything for an approved repair to do.
 * @param {ReturnType<typeof analyzeLegacyCarrier>} analysis
 * @returns {boolean}
 */
function hasRepairWork(analysis) {
  return analysis.eligible && !analysis.refused
    && (analysis.candidates.length > 0 || (analysis.header && analysis.header.replaceable));
}

/**
 * The repaired text for an analysis: candidate line ranges removed and, when
 * byte-identical to the generated form, the header made neutral. Pure.
 * @param {string} text
 * @param {ReturnType<typeof analyzeLegacyCarrier>} analysis
 * @returns {string}
 */
function repairedText(text, analysis) {
  const lines = text.split('\n');
  const drop = new Set();
  for (const c of analysis.candidates) {
    for (let n = c.startLine; n <= c.endLine; n++) drop.add(n - 1);
  }
  const out = [];
  lines.forEach((line, i) => {
    if (drop.has(i)) return;
    if (i === 0 && analysis.header && analysis.header.replaceable) {
      out.push(line.endsWith('\r') ? `${NEUTRAL_HEADER}\r` : NEUTRAL_HEADER);
      return;
    }
    out.push(line);
  });
  return out.join('\n');
}

/**
 * Apply an operator-approved repair. Refuses, writing nothing, unless the file
 * still analyzes to exactly the plan whose digest the operator approved; the
 * target is re-hashed just before the rename (compare-and-swap) and replaced
 * atomically, keeping its mode. With nothing to repair it writes nothing.
 *
 * @param {string} filePath - Absolute path of the carrier.
 * @param {string} expectedDigest - The digest the preview printed.
 * @param {object} ctx - As for `analyzeLegacyCarrier`.
 * @returns {{status: 'applied'|'noop'|'refused', reason: (string|null), removedBytes: number, analysis: (object|null)}}
 */
function applyLegacyRepair(filePath, expectedDigest, ctx) {
  const refuse = (reason, analysis = null) => ({ status: 'refused', reason, removedBytes: 0, analysis });
  const notRegular = _carrierRefusal(filePath);
  if (notRegular) return refuse(notRegular);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return refuse(`could not read ${filePath}: ${err.message}`);
  }
  const analysis = analyzeLegacyCarrier(text, ctx);
  if (analysis.refused) return refuse(analysis.refused, analysis);
  if (!hasRepairWork(analysis)) {
    return { status: 'noop', reason: analysis.reason || 'nothing to repair', removedBytes: 0, analysis };
  }
  if (analysis.digest !== expectedDigest) {
    return refuse('the file or its repair plan changed since the preview — preview again and approve the new digest', analysis);
  }
  // A rename replaces a read-only file as readily as a writable one, so the
  // operator's read-only intent is checked here rather than lost (#1291).
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
  } catch { // prawduct:allow prawduct/broad-except -- any access failure means the file cannot be approved for writing
    return refuse(`${filePath} is read-only — make it writable to approve the repair`, analysis);
  }
  const next = repairedText(text, analysis);
  const mode = fs.statSync(filePath).mode & 0o7777;
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tc-repair-${process.pid}-${Date.now()}`);
  try {
    const bytes = Buffer.from(next, 'utf8');
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      _writeAll(fd, bytes);
      // The umask trims the mode openSync applies; set it outright.
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
      const written = fs.fstatSync(fd).size;
      if (written !== bytes.length) throw new Error(`the temp file holds ${written} of ${bytes.length} bytes`);
    } finally {
      fs.closeSync(fd);
    }
    const moved = _carrierRefusal(filePath);
    if (moved || _sha256(fs.readFileSync(filePath, 'utf8')) !== analysis.fileSha256) {
      fs.rmSync(tmp, { force: true });
      return refuse(moved || 'the file changed while the repair was being written — nothing was replaced', analysis);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return refuse(`could not write the repair: ${err.message}`, analysis);
  }
  return { status: 'applied', reason: null, removedBytes: Buffer.byteLength(text, 'utf8') - Buffer.byteLength(next, 'utf8'), analysis };
}

module.exports = {
  ANCHOR_TOKEN,
  REPAIR_SCRIPT,
  repairCommand,
  carrierRefusal: _carrierRefusal,
  _setIoForTest,
  NEUTRAL_HEADER,
  analyzeLegacyCarrier,
  hasRepairWork,
  repairedText,
  applyLegacyRepair
};
